// A separate, time-limited process keeps unreachable shares from hanging MCP.
import fs from 'node:fs/promises';
import { safePath } from './common.mjs';
import { checkMountedTarget } from './mount-check.mjs';
try {
  for (const root of process.argv.slice(2)) {
    await checkMountedTarget(root);
    await safePath(root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('NOT_DIRECTORY');
    await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);
  }
  process.stdout.write(JSON.stringify({ available: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ available: false, reason: error.code || error.message }));
}
