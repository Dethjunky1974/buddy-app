import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('optional, local, and GitHub-backed vault modes keep records in the right place', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-public-test-'));
  const configFile = path.join(temp, 'settings.json');
  const dataDir = path.join(temp, 'data');
  process.env.BUDDY_CONFIG_PATH = configFile;
  process.env.BUDDY_DATA_PATH = dataDir;
  const vault = await import(`../server/vault.js?fixture=${Date.now()}`);
  const payload = { project: 'Demo', engine: 'codex', prompt: 'Check the layout', output: 'Looks good', commands: ['$impeccable polish'] };

  assert.equal(vault.vaultSettings().mode, 'none');
  const localOnly = vault.saveRecord(payload);
  assert.equal(localOnly.saved, true);
  assert.equal(localOnly.location, 'local');
  assert.match(fs.readFileSync(localOnly.file, 'utf8'), /Check the layout/);

  const folder = path.join(temp, 'My Vault');
  assert.equal(vault.configureVault({ mode: 'local', name: 'Studio Notes', path: folder }).name, 'Studio Notes');
  fs.mkdirSync(path.join(folder, 'Projects/Demo'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Projects/Demo/hot.md'), '# Fresh context\n');
  assert.deepEqual(vault.projects().projects, ['Demo']);
  assert.match(vault.projectContext('Demo').context, /Fresh context/);
  const localVault = vault.saveRecord(payload);
  assert.equal(localVault.location, 'vault');
  assert.equal(localVault.saved, true);

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const remote = path.join(temp, 'remote.git');
  git(temp, 'init', '--bare', remote);
  git(folder, 'init', '-b', 'main');
  git(folder, 'config', 'user.name', 'Test User');
  git(folder, 'config', 'user.email', 'test@example.com');
  git(folder, 'add', '.'); git(folder, 'commit', '-m', 'Start vault');
  git(folder, 'remote', 'add', 'origin', remote); git(folder, 'push', '-u', 'origin', 'main');
  fs.writeFileSync(configFile, JSON.stringify({ mode: 'github', name: 'Studio Notes', path: folder, remote: '' }));
  const shared = vault.saveRecord(payload);
  assert.equal(shared.published, true, shared.error);
  assert.equal(git(folder, 'rev-parse', 'HEAD'), git(folder, 'rev-parse', 'origin/main'));
  assert.equal(git(folder, 'log', '-1', '--format=%(trailers:key=Sync-Actor,valueonly)'), 'buddy');

  const rejectPush = path.join(remote, 'hooks/pre-receive');
  fs.writeFileSync(rejectPush, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(rejectPush, 0o755);
  const unpublished = vault.saveRecord(payload);
  assert.equal(unpublished.saved, true);
  assert.equal(unpublished.published, false);
  fs.unlinkSync(rejectPush);
  const recovered = vault.syncVault();
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.status, 'published_pending');
  assert.equal(git(folder, 'rev-parse', 'HEAD'), git(folder, 'rev-parse', 'origin/main'));

  fs.writeFileSync(path.join(folder, 'unpublished.md'), 'Work in progress');
  const queued = vault.saveRecord(payload);
  assert.equal(queued.queued, true);
  assert.equal(vault.pendingCount(), 1);
  fs.unlinkSync(path.join(folder, 'unpublished.md'));
  assert.equal(vault.retryQueuedRecords().remaining, 0);
  assert.equal(git(folder, 'status', '--porcelain'), '');
  fs.rmSync(temp, { recursive: true, force: true });
});
