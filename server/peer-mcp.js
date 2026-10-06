import net from 'node:net';
import { createInterface } from 'node:readline';

const [, , socketPath, client, role, token] = process.argv;
const peer = role === 'codex' ? 'Claude Code' : 'Codex';
const socket = net.createConnection(socketPath);
const pending = new Map();
let nextId = 1;
let failed = null;
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
ready.catch(() => {});
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const content = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function broker(method, data = {}) {
  return new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, method, ...data })}\n`);
  });
}

function fail(error) {
  if (failed) return;
  failed = error;
  readyReject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

socket.on('connect', () => broker('hello', { client, role, token }).then(readyResolve, readyReject));
socket.on('error', fail);
socket.on('close', () => fail(Error('Buddy link disconnected')));
createInterface({ input: socket, crlfDelay: Infinity }).on('line', line => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(Error(message.error)) : request.resolve(message.result);
  } catch (error) { process.stderr.write(`Buddy peer response error: ${error.message}\n`); }
});

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'buddy-peer', version: '1.0.0' }
  } };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [
    { name: 'send', description: `Send a message directly to ${peer} in this linked Buddy workspace. Buddy wakes the peer automatically. If one peer message awaits your response, Buddy matches your answer automatically. A queued message is not a reply until the peer sends one back.`, inputSchema: {
      type: 'object', properties: { message: { type: 'string' }, reply_to: { type: 'string' } }, required: ['message']
    } },
    { name: 'receive', description: `Receive the next message from ${peer}. Waits up to 20 seconds. Each message includes an ID; answer it with send and reply_to set to that ID.`, inputSchema: {
      type: 'object', properties: {}
    } }
  ] } };
  if (method === 'tools/call') {
    try {
      await ready;
      if (params.name === 'send') {
        const result = await broker('send', { message: params.arguments?.message, replyTo: params.arguments?.reply_to });
        return { jsonrpc: '2.0', id, result: content(`Message ${result.id} queued for ${peer}. Buddy will wake the peer. Await its reply with receive; report a timeout if it does not answer.`) };
      }
      if (params.name === 'receive') {
        const result = await broker('receive');
        const text = result ? `Message ID: ${result.id}\nFrom: ${result.from}\nReply to: ${result.replyTo || '(new message)'}\nMessage:\n${result.text}\n\nTo answer, call buddy_peer.send. Buddy matches your response automatically when only one peer message awaits it.`
          : 'No peer message arrived in 20 seconds. You may try receive again or tell the user the peer has not replied yet.';
        return { jsonrpc: '2.0', id, result: content(text) };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } };
    } catch (error) { return { jsonrpc: '2.0', id, result: content(error.message, true) }; }
  }
  if (id === undefined) return;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } };
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try { Promise.resolve(handle(JSON.parse(line))).then(response => { if (response) write(response); })
    .catch(error => process.stderr.write(`Buddy peer request error: ${error.message}\n`)); }
  catch (error) { process.stderr.write(`Buddy peer input error: ${error.message}\n`); }
});
