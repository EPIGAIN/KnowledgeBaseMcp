import fs from 'node:fs/promises';
import path from 'node:path';
import { archiveFile, flush, sourceInfo, sha, atomicJson, inside, loadConfig } from './storage.mjs';
import { assertGate, evaluateGate, withStateLock } from './gate.mjs';
import { trackedFiles, trackKey } from './tracking.mjs';
import { collectTerminal, terminalWatchState } from './terminal.mjs';
import { coordinationRoot, withOperation } from './operations.mjs';

const mark = stat => `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
export function createWatcher(c) {
  const startedAt = Date.now(); let epoch; const baselines = new Map();
  return {
    async tick() {
      const gate = await evaluateGate(c);
      if (!gate.active) { epoch = undefined; baselines.clear(); return { status: gate.status, tracked: 0, captured: 0 }; }
      return withOperation(c, async () => {
      if (epoch !== gate.epoch) { baselines.clear(); epoch = gate.epoch; }
      await collectTerminal(c);
      const terminals = await terminalWatchState(c, epoch);
      const records = await trackedFiles(c); let captured = 0; const issues = [];
      let healthCheckedAt = gate.checkedAt;
      for (const record of records) {
        const key = trackKey(record.source);
        try {
          if (terminals.activeDirectories.some(root => inside(root, record.source))) continue;
          if (Date.now() - healthCheckedAt >= (c.pollMs || 2000)) healthCheckedAt = (await assertGate(c, { epoch })).checkedAt;
          const info = await sourceInfo(c, record.source);
          let baseline = baselines.get(key);
          const changedRegistration = baseline?.registration !== record.registration;
          if (changedRegistration) baseline = undefined;
          const canonical = process.platform === 'win32' ? path.resolve(record.source).toLowerCase() : path.resolve(record.source);
          const failureToken = terminals.suppressed.get(canonical);
          const forceBaseline = failureToken && failureToken !== baseline?.failureToken;
          if (forceBaseline) baseline = undefined;
          const signature = mark(info.stat);
          if (baseline && signature === baseline.mark && !baseline.pending && Date.now() - baseline.checkedAt < 60000) continue;
          await assertGate(c, { epoch });
          const digest = sha(await fs.readFile(info.full));
          if (signature !== mark(await fs.stat(info.full))) continue;
          await assertGate(c, { epoch });
          if (!baseline) {
            // A registration observed during this run has known Agent evidence.
            // Old registrations after downtime/resume establish a fresh baseline.
            const fresh = !forceBaseline && record.epoch === epoch && Date.parse(record.registeredAt) >= startedAt;
            baseline = { hash: fresh ? record.sha256 : digest, registration: record.registration, failureToken };
            baselines.set(key, baseline);
          }
          baseline.mark = signature; baseline.checkedAt = Date.now();
          if (digest === baseline.hash) { baseline.pending = null; continue; }
          if (baseline.pending?.hash !== digest) { baseline.pending = { hash: digest, since: Date.now() }; continue; }
          if (Date.now() - baseline.pending.since < (c.settleMs ?? 2000)) continue;
          await archiveFile(c, info.full, { tool: 'background_watch', expectedSha256: digest });
          baseline.hash = digest; baseline.pending = null; captured++;
        } catch (error) {
          if (error.code === 'WORK_PAUSED') { epoch = undefined; baselines.clear(); return { status: 'paused_during_tick', tracked: records.length, captured }; }
          if (error.code === 'ENOENT') baselines.delete(key);
          else issues.push({ code: error.code || 'WATCH_ERROR', source: record.source });
        }
      }
      const liveKeys = new Set(records.map(r => trackKey(r.source)));
      for (const key of baselines.keys()) if (!liveKeys.has(key)) baselines.delete(key);
      const uploaded = await flush(c);
      return { status: 'active', tracked: records.length, captured, activeTerminalCommands: terminals.activeDirectories.length, processed: uploaded.length, pending: uploaded.filter(j => j.status !== 'stored').length, issues };
      });
    }
  };
}

export async function watch(c, { signal, once = false } = {}) {
  const coordinator = { stateDir: coordinationRoot(c) };
  return withStateLock(coordinator, 'watcher', async () => {
    let watcher = createWatcher(c);
    await atomicJson(path.join(coordinator.stateDir, 'watcher-instance.json'), { pid: process.pid, configPath: c.configFile });
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      do {
        let report;
        try {
          if (c.configFile) {
            const latest = await loadConfig(c.configFile);
            if (latest.revision !== c.revision || latest.stateDir !== c.stateDir) { c = latest; watcher = createWatcher(c); }
          }
          report = await watcher.tick();
        }
        catch (error) { report = { status: 'error', error: { code: error.code || 'WATCH_ERROR', message: error.message } }; }
        await atomicJson(path.join(c.stateDir, 'watcher-status.json'), { ...report, pid: process.pid, checkedAt: new Date().toISOString() });
        if (once || stopped || signal?.aborted) return report;
        await new Promise(resolve => setTimeout(resolve, c.pollMs || 2000));
      } while (!stopped && !signal?.aborted);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
}
