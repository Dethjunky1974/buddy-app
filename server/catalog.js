import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { claudeConfigDir } from './claude-config.js';

const home = os.homedir();
const dir = p => p && fs.existsSync(p) && fs.statSync(p).isDirectory();
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function directories(root, depth = 2) {
  if (!dir(root) || depth < 0) return [];
  const found = [root];
  if (!depth) return found;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      found.push(...directories(path.join(root, e.name), depth - 1));
  }
  return found;
}

function metadata(source) {
  const front = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const yaml = front?.[1] || '';
  const get = key => {
    const match = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    if (!match) return '';
    let value = match[1].trim();
    if (value === '>' || value === '>-' || value === '|') {
      const lines = yaml.slice(match.index + match[0].length).split('\n').slice(1);
      const folded = [];
      for (const line of lines) {
        if (/^\S/.test(line)) break;
        if (line.trim()) folded.push(line.trim());
      }
      value = folded.join(' ');
    }
    return value.replace(/^['"]|['"]$/g, '').trim();
  };
  return { name: get('name'), description: get('description') };
}

function embeddedCommands(source) {
  const start = source.search(/^## Commands\s*$/m);
  if (start < 0) return [];
  const tail = source.slice(start).replace(/^## Commands\s*\n/, '');
  const next = tail.search(/^## /m);
  const section = next < 0 ? tail : tail.slice(0, next);
  const commands = [];
  let inTable = false;
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) { if (inTable) break; else continue; }
    inTable = true;
    const cells = line.split('|').map(s => s.trim());
    const raw = (cells[1] || '').replace(/^`|`$/g, '');
    const label = raw.split(/\s|\[/)[0];
    if (!label || /^(command|[-:]+)$/i.test(label) || !/^[\w-]+$/.test(label)) continue;
    commands.push({ name: label, description: cells[3] || cells[2] || '', kind: 'subcommand' });
  }
  return commands;
}

function scanSkills(roots, engine) {
  const items = new Map();
  for (const input of roots) {
    const root = typeof input === 'string' ? input : input.path;
    const namespace = typeof input === 'string' ? '' : input.namespace;
    for (const folder of directories(root, 3)) {
      const file = path.join(folder, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const source = read(file);
      const meta = metadata(source);
      const baseName = meta.name || path.basename(folder);
      const name = namespace ? `${namespace}:${baseName}` : baseName;
      const id = `${engine}:${name}`;
      if (items.has(id)) continue;
      const subs = embeddedCommands(source);
      items.set(id, {
        id, name, description: meta.description, source: file, kind: 'skill',
        commands: (subs.length ? subs : [{ name, description: meta.description, kind: 'skill' }]).map(c => ({
          ...c, invocation: engine === 'codex' ? `$${name}${c.kind === 'subcommand' ? ` ${c.name}` : ''}` : `/${name}${c.kind === 'subcommand' ? ` ${c.name}` : ''}`
        }))
      });
    }
  }
  return [...items.values()];
}

function scanCommands(roots) {
  const items = [];
  const seen = new Set();
  for (const input of roots) {
    const root = typeof input === 'string' ? input : input.path;
    const namespace = typeof input === 'string' ? '' : input.namespace;
    for (const folder of directories(root, 2)) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const file = path.join(folder, entry.name);
        const relative = `${namespace ? `${namespace}:` : ''}${path.relative(root, file).replace(/\.md$/, '').split(path.sep).join(':')}`;
        if (seen.has(relative)) continue;
        seen.add(relative);
        const meta = metadata(read(file));
        items.push({ id: `claude:command:${relative}`, name: relative, description: meta.description,
          source: file, kind: 'command', commands: [{ name: relative, description: meta.description, invocation: `/${relative}`, kind: 'command' }] });
      }
    }
  }
  return items;
}

export function catalog(workspace) {
  const claudeHome = claudeConfigDir();
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  let codexPlugins = [];
  try {
    const installed = JSON.parse(execFileSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 12000 })).installed || [];
    codexPlugins = installed.filter(p => p.enabled && p.source?.path).map(p => ({ path: path.join(p.source.path, 'skills'), namespace: p.name }));
  } catch {}
  let claudePlugins = [];
  try {
    const installed = JSON.parse(read(path.join(claudeHome, 'plugins/installed_plugins.json'))).plugins || {};
    claudePlugins = Object.entries(installed).flatMap(([id, entries]) => entries.map(p => ({ path: p.installPath, namespace: id.split('@')[0] })));
  } catch {}
  const codex = scanSkills([
    path.join(codexHome, 'skills'), path.join(codexHome, 'skills/.system'), path.join(home, '.agents/skills'),
    path.join(workspace, '.agents/skills'), path.join(workspace, '.codex/skills'),
    ...codexPlugins
  ], 'codex');
  const claude = scanSkills([
    path.join(claudeHome, 'skills'), path.join(home, '.claude/skills'),
    path.join(workspace, '.claude/skills'),
    ...claudePlugins.map(p => ({ path: path.join(p.path, 'skills'), namespace: p.namespace }))
  ], 'claude');
  claude.push(...scanCommands([
    path.join(claudeHome, 'commands'), path.join(home, '.claude/commands'), path.join(workspace, '.claude/commands'),
    ...claudePlugins.map(p => ({ path: path.join(p.path, 'commands'), namespace: p.namespace }))
  ]));
  return { codex: codex.sort(byName), claude: claude.sort(byName) };
}

function byName(a, b) { return a.name.localeCompare(b.name); }
