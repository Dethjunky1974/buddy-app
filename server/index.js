import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { catalog } from './catalog.js';
import { vaultSettings, configureVault, projects, projectContext, saveRecord, pendingCount, retryQueuedRecords } from './vault.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const port = Number(process.env.PORT || 4317);
const sessions = new Map();
const pending = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', d => { chunks += d; if (chunks.length > 100000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function workspace(value) {
  const candidate = path.resolve(value || os.homedir());
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error('Workspace folder does not exist');
  return fs.realpathSync(candidate);
}
function serve(res, url) {
  const vendor = {
    '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
    '/vendor/fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
    '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css'
  };
  const file = vendor[url] ? path.join(root, vendor[url]) : path.join(publicRoot, url === '/' ? 'index.html' : url);
  if (!vendor[url] && !file.startsWith(publicRoot + path.sep)) return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function terminal(engine, cwd, model, effort) {
  const old = sessions.get(engine);
  if (old?.cwd === cwd && old.model === model && old.effort === effort && old.proc) return old;
  if (old) {
    flushPending(engine);
    old.proc?.kill();
    sessions.delete(engine);
  }
  const command = engine === 'codex' ? 'codex' : 'claude';
  const args = engine === 'codex'
    ? [...(model ? ['--model', model] : []), ...(effort ? ['--config', `model_reasoning_effort="${effort}"`] : [])]
    : [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  const proc = pty.spawn(command, args, { name: 'xterm-256color', cols: 90, rows: 28, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
  const state = { proc, cwd, model, effort, buffer: '', clients: new Set(), engine };
  proc.onData(data => {
    state.buffer = (state.buffer + data).slice(-120000);
    for (const client of state.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'data', data }));
    const item = pending.get(engine);
    if (item && sessions.get(engine) === state) {
      item.output = (item.output + data).slice(-12000);
      clearTimeout(item.timer);
      item.timer = setTimeout(() => {
        flushPending(engine);
      }, 12000);
    }
  });
  proc.onExit(({ exitCode }) => { for (const client of state.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: 'exit', exitCode })); state.proc = null; });
  sessions.set(engine, state);
  return state;
}
function broadcast(engine, message) {
  for (const client of sessions.get(engine)?.clients || []) if (client.readyState === 1) client.send(JSON.stringify(message));
}
function flushPending(engine) {
  const item = pending.get(engine);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(engine);
  const result = saveRecord({ project: item.project, engine, prompt: item.prompt, output: item.output, commands: item.commands });
  broadcast(engine, { type: 'save', result });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/api/status') return json(res, 200, { vault: vaultSettings(), pendingCount: pendingCount(), defaultWorkspace: process.env.BUDDY_WORKSPACE_PATH || root, engines: { codex: !!process.env.PATH?.split(':').some(p => fs.existsSync(path.join(p, 'codex'))), claude: !!process.env.PATH?.split(':').some(p => fs.existsSync(path.join(p, 'claude'))) } });
    if (url.pathname === '/api/vault/config' && req.method === 'POST') return json(res, 200, configureVault(await body(req)));
    if (url.pathname === '/api/projects') return json(res, 200, projects());
    if (url.pathname === '/api/context') return json(res, 200, projectContext(url.searchParams.get('project')));
    if (url.pathname === '/api/catalog') return json(res, 200, catalog(workspace(url.searchParams.get('workspace'))));
    if (url.pathname === '/api/retry-saves' && req.method === 'POST') return json(res, 200, retryQueuedRecords());
    if (url.pathname === '/api/improve' && req.method === 'POST') {
      const input = await body(req);
      const selection = String(input.selection || '').trim();
      if (!selection || selection.length > 6000) return json(res, 400, { error: 'Select up to 6,000 characters.' });
      const engine = input.engine === 'claude' ? 'claude' : 'codex';
      const prompt = `Improve the following user prompt for an AI coding assistant. Preserve the user's intent and tone. Add useful concrete detail only where it follows from the user's request. Do not invent requirements, facts, files, or decisions. Return only the improved prompt, with no introduction or markdown fence.\n\n${selection}`;
      const args = engine === 'codex' ? ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-'] : ['--print', '--no-session-persistence', prompt];
      const child = execFile(engine === 'codex' ? 'codex' : 'claude', args, { cwd: workspace(input.workspace), timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) json(res, 500, { error: String(stderr || error.message).slice(-1000) });
        else json(res, 200, { improved: stdout.trim() });
      });
      if (engine === 'codex') child.stdin.end(prompt);
      return;
    }
    return serve(res, url.pathname);
  } catch (error) { return json(res, 400, { error: error.message }); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return socket.destroy();
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname !== '/terminal') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, url));
});
wss.on('connection', (ws, req, url) => {
  const engine = url.searchParams.get('engine');
  if (!['codex', 'claude'].includes(engine)) return ws.close(1008, 'Unknown engine');
  const model = url.searchParams.get('model') || '';
  const effort = url.searchParams.get('effort') || '';
  if (model && (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(model))) return ws.close(1008, 'Invalid model');
  const allowedEffort = engine === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max'];
  if (effort && !allowedEffort.includes(effort)) return ws.close(1008, 'Invalid effort');
  let state;
  try { state = terminal(engine, workspace(url.searchParams.get('workspace')), model, effort); }
  catch (error) { ws.send(JSON.stringify({ type: 'error', error: error.message })); return ws.close(); }
  state.clients.add(ws);
  ws.send(JSON.stringify({ type: 'data', data: state.buffer }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'input' && typeof msg.data === 'string') state.proc?.write(msg.data.slice(0, 20000));
      if (msg.type === 'resize') state.proc?.resize(Math.max(20, Math.min(300, Number(msg.cols) || 90)), Math.max(8, Math.min(100, Number(msg.rows) || 28)));
      if (msg.type === 'prompt' && typeof msg.text === 'string') {
        const selected = String(msg.text).slice(0, 30000);
        const prior = pending.get(engine);
        if (prior) flushPending(engine);
        const item = { prompt: selected, project: msg.project, commands: msg.commands || [], output: '', timer: null };
        item.timer = setTimeout(() => {
          if (pending.get(engine) !== item) return;
          flushPending(engine);
        }, 30000);
        pending.set(engine, item);
        state.proc?.write(`\x1b[200~${selected}\x1b[201~\r`);
      }
    } catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid terminal message' })); }
  });
  ws.on('close', () => state.clients.delete(ws));
});

server.listen(port, '127.0.0.1', () => console.log(`Buddy workspace: http://127.0.0.1:${port}`));
process.on('SIGINT', () => { for (const engine of pending.keys()) flushPending(engine); for (const s of sessions.values()) s.proc?.kill(); process.exit(0); });
