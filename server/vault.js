import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = os.homedir();
const dataDir = process.env.BUDDY_DATA_PATH || path.join(home, 'Library/Application Support/Buddy/data');
const configFile = process.env.BUDDY_CONFIG_PATH || path.join(home, 'Library/Application Support/Buddy/settings.json');
const pendingFile = path.join(dataDir, 'pending-records.jsonl');
const machine = os.hostname().replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (['none', 'local', 'github'].includes(value.mode)) return value;
  } catch {}
  return { mode: 'none', name: '', path: '', remote: '' };
}
export const vaultSettings = () => readConfig();
const run = (file, args, cwd, timeout = 30000) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => run('git', args, cwd);
const errorText = error => String(error.stderr || error.message).trim().slice(-1000);
const expandPath = value => path.resolve(String(value || '').replace(/^~(?=\/|$)/, home));

function publishOwnPending(vaultPath, branch, remote) {
  const commits = git(vaultPath, 'log', `${remote}..HEAD`, '--format=%B%x00').split('\0').map(text => text.trim()).filter(Boolean);
  const files = git(vaultPath, 'diff', '--name-only', `${remote}..HEAD`).trim().split('\n').filter(Boolean);
  if (!commits.length || !commits.every(text => /^Sync-Actor: buddy$/m.test(text))) return false;
  if (!files.length || !files.every(file => file.startsWith('Tooling/Buddy/'))) return false;
  git(vaultPath, 'push', 'origin', `HEAD:${branch}`);
  return true;
}

export function configureVault(input) {
  const mode = String(input.mode || 'none');
  if (!['none', 'local', 'github'].includes(mode)) throw new Error('Choose no vault, local, or GitHub.');
  if (mode === 'none') {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ mode, name: '', path: '', remote: '' }, null, 2));
    return vaultSettings();
  }
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('Give your vault a name of up to 80 characters.');
  if (!String(input.path || '').trim()) throw new Error('Choose a local folder for the vault.');
  const vaultPath = expandPath(input.path);
  const remote = String(input.remote || '').trim();
  if (mode === 'github') {
    if (remote && !/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?)$/.test(remote))
      throw new Error('Use a GitHub repository URL without an embedded password or token.');
    if (!fs.existsSync(vaultPath)) {
      if (!remote) throw new Error('Paste a GitHub repository URL to clone into the new folder.');
      fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
      run('git', ['clone', remote, vaultPath], home, 120000);
    }
    if (!fs.statSync(vaultPath).isDirectory()) throw new Error('Vault path must be a folder.');
    if (git(vaultPath, 'rev-parse', '--show-toplevel') !== fs.realpathSync(vaultPath)) throw new Error('Use the root folder of the Git checkout.');
    const actual = git(vaultPath, 'remote', 'get-url', 'origin');
    if (!actual.includes('github.com')) throw new Error('The origin remote must be on GitHub.');
    if (remote && actual.replace(/\.git$/, '') !== remote.replace(/\.git$/, '')) throw new Error('The selected checkout has a different origin remote.');
    if (!git(vaultPath, 'branch', '--show-current')) throw new Error('Check out a branch before connecting this vault.');
  } else {
    fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ mode, name, path: fs.realpathSync(vaultPath), remote: mode === 'github' ? remote : '' }, null, 2));
  return vaultSettings();
}

export function syncVault() {
  const settings = vaultSettings();
  if (settings.mode === 'none') return { ok: true, status: 'local_only' };
  if (!fs.existsSync(settings.path)) return { ok: false, status: 'missing_folder', error: 'Vault folder is missing.' };
  if (settings.mode === 'local') return { ok: true, status: 'local_vault' };
  try {
    const branch = git(settings.path, 'branch', '--show-current');
    if (!branch) return { ok: false, status: 'detached_head', error: 'Check out a Git branch.' };
    git(settings.path, 'fetch', 'origin', branch);
    const head = git(settings.path, 'rev-parse', 'HEAD');
    const remote = git(settings.path, 'rev-parse', `origin/${branch}`);
    if (git(settings.path, 'status', '--porcelain')) return { ok: false, status: 'local_changes_pending', error: 'Vault has unpublished local changes. Commit or sync them before Buddy writes.' };
    if (head === remote) return { ok: true, status: 'up_to_date', head };
    const common = git(settings.path, 'merge-base', head, remote);
    if (common === remote) {
      if (!publishOwnPending(settings.path, branch, remote)) return { ok: false, status: 'local_commits_pending', error: 'Vault has local commits that need review before Buddy writes.' };
      return { ok: true, status: 'published_pending', head };
    }
    if (common !== head) return { ok: false, status: 'diverged', error: 'Vault history diverged. Reconcile the Git checkout before Buddy writes.' };
    git(settings.path, 'merge', '--ff-only', remote);
    return { ok: true, status: 'pulled', head: remote };
  } catch (error) {
    return { ok: false, status: 'sync_failed', error: errorText(error) };
  }
}

export function projects() {
  const settings = vaultSettings();
  const sync = syncVault();
  if (!sync.ok || settings.mode === 'none') return { sync, projects: [] };
  const root = path.join(settings.path, 'Projects');
  const list = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort((a, b) => a.localeCompare(b)) : [];
  return { sync, projects: list };
}

function safeProject(settings, name) {
  if (settings.mode === 'none' || !name || name === '..' || name.includes('/') || name.includes('\\')) return null;
  const root = path.join(settings.path, 'Projects', name);
  return fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : null;
}

export function projectContext(name) {
  const settings = vaultSettings();
  const sync = syncVault();
  if (!sync.ok) return { sync, context: '', paths: [] };
  const root = safeProject(settings, name);
  if (!root) return { sync, context: '', paths: [] };
  const paths = ['hot.md', 'index.md'].filter(filename => fs.existsSync(path.join(root, filename)));
  const context = paths.map(filename => `## ${name}/${filename}\n${fs.readFileSync(path.join(root, filename), 'utf8').slice(0, 9000)}`).join('\n\n').slice(0, 14000);
  return { sync, context, paths };
}

function queueRecord(record) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(pendingFile, JSON.stringify(record) + '\n');
}
export function pendingCount() {
  try { return fs.readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

export function saveRecord({ project, engine, prompt, output, commands }) {
  const settings = vaultSettings();
  const data = { project, engine, prompt, output, commands };
  const sync = syncVault();
  if (!sync.ok) {
    queueRecord(data);
    return { saved: false, queued: true, error: sync.error, sync };
  }
  const inVault = settings.mode !== 'none';
  const base = inVault ? path.join(settings.path, 'Tooling/Buddy') : dataDir;
  const record = path.join(base, inVault ? `sessions-${machine}.md` : `local-sessions-${machine}.md`);
  const index = path.join(base, 'index.md');
  const now = new Date().toISOString();
  const clean = value => String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').trim();
  try {
    fs.mkdirSync(base, { recursive: true });
    if (!fs.existsSync(record)) fs.writeFileSync(record, `# Buddy sessions — ${machine}\n\n`);
    if (inVault && !fs.existsSync(index)) fs.writeFileSync(index, `# Buddy sessions\n\n`);
    if (inVault && !fs.readFileSync(index, 'utf8').includes(`[[sessions-${machine}]]`)) fs.appendFileSync(index, `- [[sessions-${machine}]]\n`);
    const entry = `## ${now} · ${project || 'No project'} · ${engine}\n\n**Commands:** ${commands?.length ? commands.join(', ') : 'none'}\n\n### Prompt\n\n${clean(prompt).slice(0, 12000)}\n\n### Terminal excerpt\n\n\`\`\`text\n${clean(output).slice(-6000).replace(/\`\`\`/g, '\`\` \`')}\n\`\`\`\n\n`;
    fs.appendFileSync(record, entry);
    if (settings.mode !== 'github') return { saved: true, location: inVault ? 'vault' : 'local', file: record };
    git(settings.path, 'add', '--', path.relative(settings.path, record), path.relative(settings.path, index));
    git(settings.path, 'commit', '-m', `Buddy: save session on ${machine}`, '-m', `Sync-Actor: buddy\nSync-Machine: ${machine}`);
    const branch = git(settings.path, 'branch', '--show-current');
    git(settings.path, 'fetch', 'origin', branch);
    const remote = git(settings.path, 'rev-parse', `origin/${branch}`);
    const parent = git(settings.path, 'rev-parse', 'HEAD^');
    if (remote !== parent) return { saved: true, published: false, location: 'vault', file: record, error: 'GitHub advanced during save. Your local commit is preserved for manual reconciliation.' };
    git(settings.path, 'push', 'origin', `HEAD:${branch}`);
    return { saved: true, published: true, location: 'vault', file: record };
  } catch (error) {
    return { saved: fs.existsSync(record), published: false, location: inVault ? 'vault' : 'local', file: record, error: errorText(error) };
  }
}

export function retryQueuedRecords() {
  if (!pendingCount()) return { published: 0, remaining: 0 };
  const queued = fs.readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  fs.writeFileSync(pendingFile, '');
  let published = 0;
  for (let i = 0; i < queued.length; i++) {
    const result = saveRecord(queued[i]);
    if (result.saved && !result.error) { published++; continue; }
    if (!result.queued) queueRecord(queued[i]);
    for (const remaining of queued.slice(i + 1)) queueRecord(remaining);
    return { published, remaining: pendingCount(), error: result.error };
  }
  return { published, remaining: 0 };
}
