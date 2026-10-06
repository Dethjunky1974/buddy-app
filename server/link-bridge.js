import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'peer-mcp.js');
const MAX_MESSAGE = 6000;
const MAX_QUEUE = 32;
const REPLY_TIMEOUT = 120000;
const other = role => role === 'codex' ? 'claude' : 'codex';

export class LinkBridge {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-link-'));
    this.socketPath = path.join(this.directory, 'peer.sock');
    this.pairs = new Map();
    this.sockets = new Set();
    this.server = net.createServer(socket => this.connect(socket));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  pair(client) {
    if (!this.pairs.has(client)) this.pairs.set(client, {
      token: randomUUID(), linked: false, roles: { codex: null, claude: null },
      queues: { codex: [], claude: [] }, waiters: { codex: [], claude: [] }, pending: new Map()
    });
    return this.pairs.get(client);
  }

  codexArgs(client) {
    const pair = this.pair(client);
    return [
      '-c', `mcp_servers.buddy_peer.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.buddy_peer.args=${JSON.stringify([helper, this.socketPath, client, 'codex', pair.token])}`,
      '-c', 'mcp_servers.buddy_peer.default_tools_approval_mode="approve"'
    ];
  }

  claudeArgs(client) {
    const pair = this.pair(client);
    const config = path.join(this.directory, `claude-${client}.json`);
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { buddy_peer: {
      command: process.execPath, args: [helper, this.socketPath, client, 'claude', pair.token]
    } } }), { mode: 0o600 });
    return ['--mcp-config', config, '--allowedTools', 'mcp__buddy_peer__send,mcp__buddy_peer__receive'];
  }

  linked(client) { return this.pair(client).linked; }

  setLinked(client, linked) {
    const pair = this.pair(client);
    pair.linked = linked;
    if (!linked) {
      pair.queues.codex.length = 0;
      pair.queues.claude.length = 0;
      for (const role of ['codex', 'claude']) {
        for (const waiter of pair.waiters[role]) {
          clearTimeout(waiter.timer);
          this.reply(waiter.socket, waiter.id, { error: 'Buddy link is off' });
        }
        pair.waiters[role].length = 0;
      }
      for (const item of pair.pending.values()) clearTimeout(item.timer);
      pair.pending.clear();
    }
    this.onEvent({ type: 'link', client, linked });
    return linked;
  }

  reply(socket, id, value) {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...value })}\n`);
  }

  deliver(pair, role) {
    const queue = pair.queues[role];
    const waiting = pair.waiters[role];
    let delivered = false;
    while (queue.length && waiting.length) {
      const waiter = waiting.shift();
      clearTimeout(waiter.timer);
      if (waiter.socket.destroyed) continue;
      this.reply(waiter.socket, waiter.id, { result: queue.shift() });
      delivered = true;
    }
    return delivered;
  }

  connect(socket) {
    this.sockets.add(socket);
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', line => {
      try { this.handle(socket, JSON.parse(line)); }
      catch (error) { this.reply(socket, null, { error: error.message }); }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (!socket.client || !socket.role) return;
      const pair = this.pairs.get(socket.client);
      if (!pair) return;
      if (pair.roles[socket.role] === socket) pair.roles[socket.role] = null;
      const waiting = pair.waiters[socket.role];
      for (const waiter of waiting) if (waiter.socket === socket) clearTimeout(waiter.timer);
      pair.waiters[socket.role] = waiting.filter(waiter => waiter.socket !== socket);
      setTimeout(() => {
        if (pair.roles[socket.role] || !pair.linked) return;
        for (const item of pair.pending.values()) {
          if (item.to !== socket.role) continue;
          clearTimeout(item.timer);
          pair.pending.delete(item.id);
          this.onEvent({ type: 'timeout', client: socket.client, from: item.from,
            to: item.to, id: item.id, reason: 'peer disconnected' });
        }
      }, 5000).unref();
    });
  }

  handle(socket, request) {
    const { id, method } = request;
    if (method === 'hello') {
      const { client, role, token } = request;
      const pair = this.pairs.get(client);
      if (!pair || pair.token !== token || !['codex', 'claude'].includes(role))
        return this.reply(socket, id, { error: 'Unauthorized Buddy peer' });
      if (pair.roles[role] && pair.roles[role] !== socket) pair.roles[role].destroy();
      socket.client = client;
      socket.role = role;
      pair.roles[role] = socket;
      return this.reply(socket, id, { result: { role } });
    }
    if (!socket.client || !socket.role) return this.reply(socket, id, { error: 'Register first' });
    const pair = this.pairs.get(socket.client);
    if (!pair?.linked) return this.reply(socket, id, { error: 'Buddy link is off' });
    const role = socket.role;
    const peer = other(role);
    if (method === 'send') {
      const text = request.message;
      let replyTo = request.replyTo || null;
      if (typeof text !== 'string' || !text.trim()) return this.reply(socket, id, { error: 'Message is empty' });
      if (text.length > MAX_MESSAGE) return this.reply(socket, id, { error: 'Message exceeds 6,000 characters' });
      if (!pair.roles[peer]) return this.reply(socket, id, { error: `${peer} is offline` });
      if (pair.queues[peer].length >= MAX_QUEUE) return this.reply(socket, id, { error: 'Peer queue is full' });
      // One outstanding question has an unambiguous recipient. Match its
      // answer even if a model omits or mistypes the reply ID.
      const awaiting = [...pair.pending.values()].filter(item => item.to === role && item.from === peer);
      if (awaiting.length === 1 && (!replyTo || !pair.pending.has(replyTo))) replyTo = awaiting[0].id;
      if (replyTo) {
        const original = pair.pending.get(replyTo);
        if (!original || original.to !== role || original.from !== peer)
          return this.reply(socket, id, { error: 'Unknown message to reply to' });
        clearTimeout(original.timer);
        pair.pending.delete(replyTo);
      }
      const item = { id: randomUUID(), from: role, to: peer, text, replyTo, createdAt: Date.now() };
      if (!replyTo) {
        item.timer = setTimeout(() => {
          pair.pending.delete(item.id);
          this.onEvent({ type: 'timeout', client: socket.client, from: role, to: peer, id: item.id });
        }, REPLY_TIMEOUT);
        pair.pending.set(item.id, item);
      }
      pair.queues[peer].push({ id: item.id, from: role, text, replyTo, createdAt: item.createdAt });
      this.reply(socket, id, { result: { status: 'queued', id: item.id } });
      const deliveredDirectly = this.deliver(pair, peer);
      this.onEvent({ type: 'message', client: socket.client, from: role, to: peer,
        id: item.id, replyTo, deliveredDirectly });
      return;
    }
    if (method === 'receive') {
      if (pair.queues[role].length) return this.reply(socket, id, { result: pair.queues[role].shift() });
      const waiter = { socket, id, timer: null };
      waiter.timer = setTimeout(() => {
        pair.waiters[role] = pair.waiters[role].filter(item => item !== waiter);
        this.reply(socket, id, { result: null });
      }, 20000);
      pair.waiters[role].push(waiter);
      return;
    }
    this.reply(socket, id, { error: 'Unknown Buddy peer method' });
  }

  close() {
    for (const pair of this.pairs.values()) {
      pair.linked = false;
      for (const item of pair.pending.values()) clearTimeout(item.timer);
      pair.pending.clear();
    }
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
