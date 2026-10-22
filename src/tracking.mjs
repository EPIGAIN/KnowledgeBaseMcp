import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, sha } from './common.mjs';
export const trackKey = source => sha(process.platform === 'win32' ? path.resolve(source).toLowerCase() : path.resolve(source));
export async function rememberFile(c, source, digest, epoch) {
  const record = { source, sha256: digest, epoch, registration: randomUUID(), registeredAt: new Date().toISOString() };
  await atomicJson(path.join(c.stateDir, 'tracked', trackKey(source) + '.json'), record);
}
export async function trackedFiles(c) {
  const directory = path.join(c.stateDir, 'tracked');
  const names = await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return Promise.all(names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => readJson(path.join(directory, n))));
}
