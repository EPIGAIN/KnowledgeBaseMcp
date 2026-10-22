import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, fail, withStateLock } from './common.mjs';
export const coordinationRoot = c => c.configFile ? path.dirname(c.configFile) : c.stateDir;
export const migrationFile = c => path.join(coordinationRoot(c), 'migration.json');
export const migrationActive = record => record && !['complete', 'cancelled'].includes(record.phase);

export async function configurationPause(c) {
  if (migrationActive(await readJson(migrationFile(c), null))) return 'migrating';
  if (c.configFile) {
    const latest = await readJson(c.configFile, null);
    if (!latest || latest.revision !== c.revision) return 'reload_required';
  }
  return null;
}

export async function withOperation(c, fn) {
  const coordinator = { stateDir: coordinationRoot(c) };
  const lease = path.join(coordinator.stateDir, 'operations', `${process.pid}-${randomUUID()}.json`);
  await withStateLock(coordinator, 'operation-start', async () => {
    const paused = await configurationPause(c);
    if (paused) throw fail('WORK_PAUSED', `工作配置正在更新：${paused}`);
    await atomicJson(lease, { pid: process.pid, startedAt: new Date().toISOString() });
  });
  try { return await fn(); } finally { await fs.rm(lease, { force: true }); }
}

export async function freezeOperations(c, journal, timeoutMs = 30000) {
  const coordinator = { stateDir: coordinationRoot(c) };
  await withStateLock(coordinator, 'operation-start', () => atomicJson(migrationFile(c), journal));
  // Invalidate terminal observers without changing the employee's pause setting.
  await withStateLock(c, 'work-gate', () => atomicJson(path.join(c.stateDir, 'gate.json'), { available: false, status: 'migrating', epoch: randomUUID(), leaseUntil: 0, checkedAt: Date.now() }));
  const directory = path.join(coordinator.stateDir, 'operations');
  const deadline = Date.now() + timeoutMs;
  do {
    let active = 0;
    for (const name of await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name); const lease = await readJson(file, null);
      if (!lease) continue;
      try { process.kill(lease.pid, 0); active++; }
      catch (error) { if (error.code === 'ESRCH') await fs.rm(file, { force: true }); else active++; }
    }
    if (!active) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw fail('MIGRATION_BUSY', '仍有操作进行中，已暂停新采集；稍后重跑安装命令。');
}
