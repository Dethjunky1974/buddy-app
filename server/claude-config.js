import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let cached;

export function claudeConfigDir() {
  if (cached) return cached;
  if (process.env.CLAUDE_CONFIG_DIR) return cached = process.env.CLAUDE_CONFIG_DIR;

  // Dock-launched apps do not inherit variables set in the user's interactive shell.
  try {
    const output = execFileSync(process.env.SHELL || '/bin/zsh', [
      '-ic', 'printf "\\n__BUDDY_CLAUDE_CONFIG_DIR__%s\\n" "$CLAUDE_CONFIG_DIR"'
    ], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = output.match(/__BUDDY_CLAUDE_CONFIG_DIR__([^\r\n]*)/g)?.at(-1);
    const candidate = match?.slice('__BUDDY_CLAUDE_CONFIG_DIR__'.length);
    if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) return cached = candidate;
  } catch {}

  return cached = path.join(os.homedir(), '.claude');
}
