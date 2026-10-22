import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveFile, archiveKnowledge, atomicJson, exists, flush, getProfile, inside, jobs, readJson, sha, sourceInfo } from './storage.mjs';
import { prepareTerminal, finishTerminal, collectTerminal } from './terminal.mjs';
import { archiveGuidance, nameQuestion, profileGuidance } from './onboarding.mjs';
import { evaluateGate, gateMessage } from './gate.mjs';

const sessionKey = e => sha(`${e.client || 'claude'}:${e.session_id || 'unknown'}`).slice(0, 32);
const sessionFile = (c, e) => path.join(c.stateDir, 'sessions', `${sessionKey(e)}.json`);
const intro = p => profileGuidance(p) + (p ? ' ' + archiveGuidance : '');

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
  if (!gate.active) return ['SessionStart', 'UserPromptSubmit'].includes(e.hook_event_name)
    ? { hookSpecificOutput: { hookEventName: e.hook_event_name, additionalContext: gateMessage(gate) } } : {};
  const profile = await getProfile(c);
  const event = e.hook_event_name;
  const guidance = intro(profile) + (c.scope === 'user' ? ' 当前为用户级全局采集：只归档启用后新经手的文件与本轮知识，不扫描或补传历史。' : '') + (c.terminalCapture?.enabled ? ' 终端已启用按命令写入追踪。输出文件优先使用 Python open/pathlib、Node fs.writeFile、PowerShell Set-Content/Out-File/Export-Csv 等支持接口，产物会自动归档，无需再调用上传工具。不能根据目录差异补传未触及文件。' : ' 终端未启用写入追踪时，只对明确的本轮产物调用 kb_upload_file。');
  if (event === 'SessionStart') return { ...(!profile ? { systemMessage: nameQuestion } : {}), hookSpecificOutput: { hookEventName: event, additionalContext: guidance } };
  if (event === 'UserPromptSubmit') {
    const current = { prompt: profile ? String(e.prompt || '').slice(0, 50000) : '', time: new Date().toISOString(), turnId: e.turn_id || randomUUID(), activation: c.enabledAt, epoch: gate.epoch };
    await atomicJson(sessionFile(c, e), current);
    return { hookSpecificOutput: { hookEventName: event, additionalContext: guidance } };
  }
  if (!profile) return {};
  const turn = await readJson(sessionFile(c, e), { turnId: sessionKey(e), prompt: '', baseline: { files: {} } });
  // Global activation never replays an old turn, even if its Stop arrives late.
  if (turn.activation !== c.enabledAt || turn.epoch !== gate.epoch) return {};
  if (c.terminalCapture?.enabled && event === 'PreToolUse') return await prepareTerminal(c, e, turn) || {};
  if (c.terminalCapture?.enabled && ['PostToolUse', 'PostToolUseFailure'].includes(event)) {
    const traced = await finishTerminal(c, e);
    if (traced) {
      await flush(c);
      const count = (traced.files || []).filter(f => f.jobId).length;
      const message = traced.status === 'captured' ? `终端写入追踪已自动登记 ${count} 个明确产物，可用 kb_status 查看最终上传状态。不要重复手动上传。` : `本次终端追踪状态：${traced.status}。未发现写入证据时不会扫描目录或猜测产物。`;
      return event === 'PostToolUse' ? { hookSpecificOutput: { hookEventName: event, additionalContext: message } } : {};
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
      return { hookSpecificOutput: { hookEventName: event, additionalContext: '全局归档不会扫描目录。若本次终端操作生成或修改了工作文件，请仅对明确的本轮产物调用 kb_upload_file；未处理文件则无需操作，不能补传未触及的历史文件。' } };
    }
    const results = await capture(c, e, candidates);
    if (results.length) {
      await logEvent(c, { event, client: e.client || 'claude', session: sessionKey(e), tool, results });
      const stored = await flush(c);
      const unresolved = results.filter(r => r.status === 'needs_attention').length + stored.filter(j => j.status !== 'stored').length;
      return { hookSpecificOutput: { hookEventName: event, additionalContext: unresolved ? `知识归档存在 ${unresolved} 项待处理。可调用 kb_status 查看，不能报告全部上传成功。` : `知识归档已处理 ${results.length} 个文件候选，可用 kb_status 查询保存路径。` } };
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
