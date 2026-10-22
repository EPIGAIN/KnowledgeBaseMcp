import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules/.package-lock.json'), 'utf8'));
  for (const [location, expected] of Object.entries(lock.packages)) {
    if (!location || expected.optional) continue;
    if (installed.packages[location]?.version !== expected.version) throw new Error('Dependency lock mismatch');
  }
  await import('@modelcontextprotocol/sdk/server/mcp.js');
  await import('zod');
  process.exitCode = 0;
} catch { process.exitCode = 1; }
