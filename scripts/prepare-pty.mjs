import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

if (os.platform() === 'darwin') {
  const helper = path.resolve('node_modules/node-pty/prebuilds', `darwin-${os.arch()}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
}
