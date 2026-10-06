import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { LinkBridge } from '../server/link-bridge.js';

test('linked messages reach the other agent and replies return to their sender', async () => {
  const events = [];
  const bridge = new LinkBridge(event => events.push(event));
  await bridge.start();
  let nextId = 1;
  const sockets = [];
  async function connect(client, role) {
    const socket = net.createConnection(bridge.socketPath);
    sockets.push(socket);
    const pending = new Map();
    createInterface({ input: socket }).on('line', line => {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    });
    await new Promise(resolve => socket.once('connect', resolve));
    const call = (method, data = {}) => new Promise(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.write(`${JSON.stringify({ id, method, ...data })}\n`);
    });
    const hello = await call('hello', { client, role, token: bridge.pair(client).token });
    assert.equal(hello.result.role, role);
    return call;
  }
  try {
    const codex = await connect('first', 'codex');
    const claude = await connect('first', 'claude');
    const secondCodex = await connect('second', 'codex');
    const secondClaude = await connect('second', 'claude');
    assert.equal((await codex('send', { message: 'off' })).error, 'Buddy link is off');
    bridge.setLinked('first', true);
    const sent = await codex('send', { message: 'Question from Codex' });
    assert.ok(sent.result?.id, JSON.stringify(sent));
    assert.equal((await claude('receive')).result.text, 'Question from Codex');
    assert.equal(bridge.pair('first').pending.size, 1);
    const replied = await claude('send', { message: 'Answer from Claude', replyTo: 'mistyped-id' });
    assert.ok(replied.result.id);
    const answer = await codex('receive');
    assert.equal(answer.result.text, 'Answer from Claude');
    assert.equal(answer.result.replyTo, sent.result.id);
    assert.equal(bridge.pair('first').pending.size, 0);
    assert.equal(events.at(-1).replyTo, sent.result.id);
    assert.equal((await secondCodex('send', { message: 'isolated' })).error, 'Buddy link is off');
    await codex('send', { message: 'Do not replay this after unlinking' });
    bridge.setLinked('first', false);
    assert.equal(bridge.pair('first').queues.claude.length, 0);
    assert.equal(bridge.pair('first').pending.size, 0);
    bridge.setLinked('first', true);
    await codex('send', { message: 'Fresh after relinking' });
    assert.equal((await claude('receive')).result.text, 'Fresh after relinking');
    bridge.setLinked('first', false);
    assert.equal((await secondClaude('receive')).error, 'Buddy link is off');
  } finally {
    for (const socket of sockets) socket.destroy();
    bridge.close();
  }
});
