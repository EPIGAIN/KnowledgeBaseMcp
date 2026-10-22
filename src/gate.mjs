import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, inside, safePath, fail, withStateLock } from './common.mjs';
import { configurationPause, withOperation } from './operations.mjs';
import { readMarkdownConfig } from './markdown-config.mjs';
const run = promisify(execFile);
const probe = fileURLToPath(new URL('./availability-probe.mjs', import.meta.url));

export function workRoot(c, file) {
  if (!path.isAbsolute(file || '')) return null;
  if ([c.stateDir, c.mdRoot, c.filesRoot, ...(c.privateRoots || [])].some(root => root && inside(root, file))) return null;
  return [...(c.workRoots || [])].sort((a, b) => b.length - a.length).find(root => inside(root, file)) || null;
}
export async function workContext(c, cwd) {
  const root = workRoot(c, cwd);
  if (!root) return false;
  try { await safePath(root, path.relative(root, cwd)); return true; } catch { return false; }
}

export { withStateLock } from './common.mjs';

export async function setWorkEnabled(c, enabled) {
  return withOperation(c, () => withStateLock(c, 'work-gate', async () => {
    const control = { enabled, revision: randomUUID(), changedAt: new Date().toISOString() };
    await atomicJson(path.join(c.stateDir, 'control.json'), control);
    // Invalidate even a quick pause/resume that happens between watcher ticks.
    await atomicJson(path.join(c.stateDir, 'gate.json'), { available: false, status: enabled ? 'checking' : 'manual_pause', epoch: randomUUID(), controlRevision: control.revision, checkedAt: 0 });
    return control;
  }));
}

export async function probeTargets(c) {
  try {
    const env = { ...process.env }; delete env.KB_TRACE_CONFIG; delete env.NODE_OPTIONS;
    const result = await run(process.execPath, [probe, c.mdRoot, c.filesRoot], { timeout: c.availabilityTimeoutMs || 2000, windowsHide: true, maxBuffer: 8192, env });
    return JSON.parse(result.stdout);
  } catch { return { available: false, reason: 'TARGET_CHECK_FAILED_OR_TIMED_OUT' }; }
}

export async function evaluateGate(c, { cwd, onboarding = false } = {}) {
  if (!c.workRoots?.length || !c.mdRoot || !c.filesRoot || !c.stateDir) return { active: false, status: 'unconfigured' };
  const configPause = await configurationPause(c);
  if (configPause) return { active: false, status: configPause };
  if (cwd !== undefined && !await workContext(c, cwd)) return { active: false, status: 'outside_work' };
  const state = await withStateLock(c, 'work-gate', async () => {
    const control = await readJson(path.join(c.stateDir, 'control.json'), { enabled: true, revision: 'initial' });
    let available = false; let reason;
    let settingsState;
    if (c.sourceMd) {
      try {
        const md = await readMarkdownConfig(c.sourceMd.path);
        if (md.hash !== c.sourceMd.hash) settingsState = 'config_pending';
      } catch { settingsState = 'config_invalid'; }
    }
    if (control.enabled && !settingsState) {
      const check = await probeTargets(c); available = check.available; reason = check.reason;
    }
    const previous = await readJson(path.join(c.stateDir, 'gate.json'), null);
    const changed = !previous || previous.available !== available || previous.controlRevision !== control.revision || previous.activation !== c.enabledAt;
    const next = { available, status: settingsState || (!control.enabled ? 'manual_pause' : available ? 'available' : 'offline'), reason, epoch: changed ? randomUUID() : previous.epoch, controlRevision: control.revision, activation: c.enabledAt, checkedAt: Date.now(), leaseUntil: Date.now() + (c.traceLeaseMs || 6000) };
    await atomicJson(path.join(c.stateDir, 'gate.json'), next);
    return next;
  });
  if (!state.available) return { ...state, active: false };
  const profile = await readJson(path.join(c.stateDir, 'profile.json'), null);
  return { ...state, active: Boolean(profile) || onboarding, status: profile ? 'active' : 'awaiting_name' };
}

export async function assertGate(c, options = {}) {
  const gate = await evaluateGate(c, options);
  if (!gate.active || (options.epoch && options.epoch !== gate.epoch)) throw fail('WORK_PAUSED', `工作归档已暂停：${gate.status}。不会采集或补采暂停期间的内容。`);
  return gate;
}

export function gateMessage(gate) {
  if (['config_pending', 'config_invalid'].includes(gate.status)) return '工作归档暂停：配置 MD 已改变、无法读取或不合法。请修正后重新执行同一条安装命令，校验并应用迁移；不会继续向旧位置上传。';
  if (gate.status === 'migrating') return '工作归档暂停：正在应用配置迁移，或迁移尚未完成。请等待完成；失败时修正原因后重跑同一条安装命令。';
  return `工作归档暂停（${gate.status}）：不读取工作文件、不采集对话、不监听、不上传。仅当两个目标可访问、工作开关开启且会话位于配置的工作目录时恢复。`;
}
