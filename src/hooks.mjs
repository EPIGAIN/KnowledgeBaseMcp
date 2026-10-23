import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveFile, archiveKnowledge, atomicJson, exists, flush, getProfile, inside, jobs, readJson, sha, sourceInfo } from './storage.mjs';
import { prepareTerminal, finishTerminal, collectTerminal } from './terminal.mjs';
import { nameQuestion, profileGuidance } from './onboarding.mjs';
import { evaluateGate, gateMessage } from './gate.mjs';

const sessionKey = e => sha(`${e.client || 'claude'}:${e.session_id || 'unknown'}`).slice(0, 32);
const sessionFile = (c, e) => path.join(c.stateDir, 'sessions', `${sessionKey(e)}.json`);
const readyGuidance = p => `知识归档已启用，员工：${p.name}。只归档工作范围内新经手的文件，不扫历史。正常处理任务即可，无需为归档改变工具或写法；归档结果可用 kb_status 查询。`;

async function guidanceFor(c, e, gate, profile) {
  if (!['SessionStart', 'UserPromptSubmit'].includes(e.hook_event_name) || gate.status === 'outside_work') return {};
  const file = path.join(c.stateDir, 'notices', `${sessionKey(e)}.json`);
  const signature = JSON.stringify([c.enabledAt, gate.status, gate.epoch, profile?.id]);
  const previous = await readJson(file, null);
  // Keep onboarding explicit, but do not repeat ready/offline instructions each turn.
  if (e.hook_event_name !== 'SessionStart' && (profile || !gate.active) && previous?.signature === signature) return {};
  await atomicJson(file, { signature });
  const context = !gate.active ? gateMessage(gate) : profile ? readyGuidance(profile) : profileGuidance(null);
  return { ...(!profile && gate.active && e.hook_event_name === 'SessionStart' ? { systemMessage: nameQuestion } : {}), hookSpecificOutput: { hookEventName: e.hook_event_name, additionalContext: context } };
}

async function logEvent(c, data) {
  await atomicJson(path.join(c.stateDir, 'events', `${Date.now()}-${randomUUID()}.json`), data);
}
async function capture(c, e, files) {
  const result = [];
  for (const file of new Set(files)) {
    const absoluteSource = path.resolve(e.cwd || c.workRoots[0], file);
    try {
      const j = await archiveFile(c, absoluteSource, { client: e.client || 'claude', session: sessionKey(e), tool: e.tool_name });
      result.push({ source: absoluteSource, jobId: j.id, status: j.status });
    } catch (error) {
      const skipped = ['EXCLUDED_FILE', 'PATH_OUT_OF_SCOPE', 'WORK_PAUSED'].includes(error.code);
      result.push({ ...(skipped ? {} : { source: absoluteSource }), status: skipped ? 'skipped' : 'needs_attention', error: error.code || error.message });
    }
  }
  return result;
}
// Failed source observations require a fresh Agent touch, never a historical recapture.
export async function retryObserved() { return []; }
export async function captureIssues(c) {
  const dir = path.join(c.stateDir, 'events');
  if (!await exists(dir)) return [];
  const out = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const event = await readJson(path.join(dir, name));
    if (event.warning) out.push({ warning: event.warning, message: event.message });
    out.push(...(event.results || []).filter(x => x.status === 'needs_attention'));
  }
  return out;
}
export async function handleHook(c, e) {
  if (!e.cwd || !path.isAbsolute(e.cwd)) return {};
  c = { ...c, activeRoot: path.resolve(e.cwd) };
  const gate = await evaluateGate(c, { cwd: c.activeRoot, onboarding: true });
  if (!gate.active) return guidanceFor(c, e, gate, null);
  const profile = await getProfile(c);
  const event = e.hook_event_name;
  if (event === 'SessionStart') return guidanceFor(c, e, gate, profile);
  if (event === 'UserPromptSubmit') {
    const current = { prompt: profile ? String(e.prompt || '').slice(0, 50000) : '', time: new Date().toISOString(), turnId: e.turn_id || randomUUID(), activation: c.enabledAt, epoch: gate.epoch };
    await atomicJson(sessionFile(c, e), current);
    return guidanceFor(c, e, gate, profile);
  }
  if (!profile) return {};
  const turn = await readJson(sessionFile(c, e), { turnId: sessionKey(e), prompt: '', baseline: { files: {} } });
  // Global activation never replays an old turn, even if its Stop arrives late.
  if (turn.activation !== c.enabledAt || turn.epoch !== gate.epoch) return {};
  if (c.terminalCapture?.enabled && event === 'PreToolUse') return await prepareTerminal(c, e, turn) || {};
  if (c.terminalCapture?.enabled && ['PostToolUse', 'PostToolUseFailure'].includes(event)) {
    const traced = await finishTerminal(c, e);
    if (traced) {
      const stored = await flush(c);
      const needsAttention = traced.status === 'needs_attention' || traced.status === 'failed' && traced.observedWrites > 0 || stored.some(j => j.status !== 'stored');
      return needsAttention && event === 'PostToolUse' ? { hookSpecificOutput: { hookEventName: event, additionalContext: '本次归档有未完成或无法确认的产物，可用 kb_status 查看；无需改变原任务的实现方式。' } } : {};
    }
  }
  if (event === 'PostToolUse') {
    if (e.tool_response?.isError === true || e.tool_response?.is_error === true || e.tool_response?.success === false) return {};
    const tool = e.tool_name || '';
    if (tool.includes('company-knowledge') || tool.includes('company_knowledge')) {
      if (tool.includes('kb_save_knowledge') && e.tool_response?.isError !== true) {
        await atomicJson(path.join(c.stateDir, 'reviews', `${sha(turn.turnId)}.json`), { storedByTool: true });
      }
      return {};
    }
    const candidates = [];
    // Hook data differs by client; only tools with known file-path semantics are used.
    if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
      const input = e.tool_input || {};
      if (typeof input.file_path === 'string') candidates.push(input.file_path);
      if (typeof input.notebook_path === 'string') candidates.push(input.notebook_path);
    }
    if (tool === 'apply_patch') {
      for (const match of String(e.tool_input?.command || e.tool_input?.input || '').matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) candidates.push(match[1].trim());
    }
    if (c.scope === 'user' && /^(Bash|exec_command)$/.test(tool)) {
      return {};
    }
    const results = await capture(c, e, candidates);
    if (results.length) {
      await logEvent(c, { event, client: e.client || 'claude', session: sessionKey(e), tool, results });
      const stored = await flush(c);
      const unresolved = results.filter(r => r.status === 'needs_attention').length + stored.filter(j => j.status !== 'stored').length;
      return unresolved ? { hookSpecificOutput: { hookEventName: event, additionalContext: `知识归档存在 ${unresolved} 项待处理。可调用 kb_status 查看，不能报告全部上传成功。` } } : {};
    }
    return {};
  }
  if (event === 'Stop') {
    if (c.terminalCapture?.enabled) await collectTerminal(c);
    const reviewPath = path.join(c.stateDir, 'reviews', `${sha(turn.turnId)}.json`);
    const previous = await readJson(reviewPath, null);
    const text = String(e.last_assistant_message || '');
    // Deterministic fallback: preserve the visible solution, explicitly unreviewed.
    const valuable = /原因|根因|排查|故障|root cause|debug/i.test(text) && /解决|修复|步骤|方法|solution|fix/i.test(text);
    if (!previous && valuable && text.length >= 100) {
      const title = text.split('\n').find(s => s.trim())?.replace(/^#+\s*/, '').slice(0, 60) || '问题解决记录';
      const job = await archiveKnowledge(c, {
        title, problem: turn.prompt || '本轮工作问题（用户原文未取得）', cause: '见下方原始回答；此记录由规则自动提取，尚未人工复核。',
        solution: text, verification: '自动提取，待复核', evidence: '保留本轮助手可见回答；不据此宣称方案已经验证。',
        source: `${e.client === 'codex' ? 'Codex' : 'Claude Code'} Stop / session ${e.session_id} / turn ${turn.turnId}`
      });
      await atomicJson(reviewPath, { jobId: job.id, extracted: true });
      await logEvent(c, { event, client: e.client || 'claude', session: sessionKey(e), insightJobId: job.id });
    }
    await flush(c);
    return {};
  }
  return {};
}
