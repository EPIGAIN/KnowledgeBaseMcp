import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveFile, atomicJson, exists, readJson, safePath, sha, excludedPathPattern } from './storage.mjs';
import { evaluateGate } from './gate.mjs';

const tracerRoot = fileURLToPath(new URL('../tracers/', import.meta.url));
const isTerminal = event => /^(Bash|exec_command|PowerShell)$/.test(event.tool_name || '');
const keyFor = event => event.tool_use_id ? sha(`${event.client || 'claude'}:${event.session_id}:${event.tool_use_id}`) : null;
const location = (c, key) => path.join(c.stateDir, 'terminal', `${key}.json`);
const psQuote = text => "'" + text.replaceAll("'", "''") + "'";
const bashQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

function dialect(event) {
  const shell = String(event.tool_input?.shell || '').toLowerCase();
  if (/powershell|pwsh/.test(shell) || event.tool_name === 'PowerShell') return 'powershell';
  if (/bash|\/sh$|zsh/.test(shell)) return 'bash';
  if (shell) return null;
  return event.client === 'codex' && process.platform === 'win32' ? 'powershell' : 'bash';
}
export async function prepareTerminal(c, event, turn) {
  if (!isTerminal(event)) return null;
  const key = keyFor(event); const input = event.tool_input || {};
  if (event.permission_mode === 'plan' || input.sandbox_permissions === 'require_escalated') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '本次计划模式或权限升级调用保留原始审批流程，不改写命令、不推测终端产物。' } };
  }
  const commandKey = typeof input.command === 'string' ? 'command' : typeof input.cmd === 'string' ? 'cmd' : null;
  const shell = dialect(event);
  if (!key || !commandKey || !shell) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '终端写入追踪无法确认调用标识或 Shell 类型，本次不会猜测产物或扫描目录。' } };
  if (input[commandKey].includes('# company-knowledge-terminal:')) return {};
  const cwd = path.resolve(event.cwd, input.workdir || input.cwd || '.');
  const gate = await evaluateGate(c, { cwd });
  if (!gate.active) return {};
  const configFile = await safePath(cwd, path.join('.kb-terminal', key, 'config.json'), true);
  const journalDir = path.dirname(configFile);
  await fs.writeFile(path.join(cwd, '.kb-terminal', '.gitignore'), '*\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await atomicJson(configFile, { version: 2, root: cwd, maxBytes: c.maxBytes, gateFile: path.join(c.stateDir, 'gate.json'), controlFile: path.join(c.stateDir, 'control.json'), epoch: gate.epoch, controlRevision: gate.controlRevision, excludedPattern: excludedPathPattern, excludeRoots: [c.stateDir, c.mdRoot, c.filesRoot, ...(c.privateRoots || []), ...(c.sourceMd ? [c.sourceMd.path] : []), path.join(cwd, '.kb-terminal')] });
  const record = { key, client: event.client || 'claude', session: event.session_id, toolUseId: event.tool_use_id, turnId: turn.turnId, activation: c.enabledAt, epoch: gate.epoch, cwd, shell, journalDir, commandHash: sha(input[commandKey]), status: 'prepared', createdAt: new Date().toISOString() };
  await atomicJson(location(c, key), record);
  const python = path.join(tracerRoot, 'python').replaceAll('\\', '/');
  const node = path.join(tracerRoot, 'node.cjs').replaceAll('\\', '/');
  const config = configFile.replaceAll('\\', '/');
  let prefix;
  if (shell === 'powershell') {
    prefix = [
      `# company-knowledge-terminal:${key}`,
      `$env:KB_TRACE_CONFIG=${psQuote(config)}`,
      `$env:PYTHONPATH=${psQuote(python)} + [IO.Path]::PathSeparator + $env:PYTHONPATH`,
      `$env:NODE_OPTIONS=${psQuote(`--require "${node}" `)} + $env:NODE_OPTIONS`,
      `. ${psQuote(path.join(tracerRoot, 'powershell.ps1').replaceAll('\\', '/'))}`
    ].join('\n');
  } else {
    const delimiter = process.platform === 'win32' ? ';' : ':';
    prefix = [
      `# company-knowledge-terminal:${key}`,
      `export KB_TRACE_CONFIG=${bashQuote(config)}`,
      `export PYTHONPATH=${bashQuote(python)}"\${PYTHONPATH:+${delimiter}\${PYTHONPATH}}"`,
      `export NODE_OPTIONS=${bashQuote(`--require "${node}"`)}"\${NODE_OPTIONS:+ \${NODE_OPTIONS}}"`
    ].join('\n');
  }
  // Codex's documented rewrite envelope requires PreToolUse "allow". This is
  // not a PermissionRequest handler; sandbox/approval flags remain unchanged.
  // Claude accepts a rewrite without an allow decision, so none is sent there.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(event.client === 'codex' ? { permissionDecision: 'allow' } : {}), updatedInput: { ...input, [commandKey]: prefix + '\n' + input[commandKey] } } };
}
function outcome(event) {
  const response = event.tool_response || {};
  if (event.hook_event_name === 'PostToolUseFailure' || response.isError || response.is_error || response.success === false || response.interrupted) return 'failed';
  const exitCode = response.exit_code ?? response.exitCode ?? response.metadata?.exit_code;
  if (typeof exitCode === 'number' && exitCode !== 0) return 'failed';
  if (response.background_task_id || response.backgroundTaskId || response.task_id || response.status === 'running') return 'running';
  return 'completed';
}
export async function finishTerminal(c, event) {
  if (!isTerminal(event)) return null;
  const key = keyFor(event);
  if (!key || !await exists(location(c, key))) return { observed: false, status: 'not_prepared', files: [] };
  const record = await readJson(location(c, key));
  if (record.activation !== c.enabledAt || record.client !== (event.client || 'claude') || record.session !== event.session_id) return { observed: false, status: 'stale', files: [] };
  record.completion = outcome(event); record.completedAt = new Date().toISOString();
  await atomicJson(location(c, key), record);
  return collectOne(c, record);
}
async function collectOne(c, record) {
  if (['captured', 'discarded', 'no_changes', 'no_observed_changes', 'unobserved', 'failed', 'needs_attention'].includes(record.status)) return record;
  const gate = await evaluateGate(c, { cwd: record.cwd });
  if (!gate.active || record.epoch !== gate.epoch) {
    record.status = 'discarded'; record.files = []; record.warning = '工作开关已暂停或切换，本次未完成采集不再补采。';
    await atomicJson(location(c, record.key), record); return record;
  }
  if (!record.completion) return record;
  if (record.completion === 'running') return { ...record, status: 'waiting_for_completion' };
  const runtimes = new Map(); const observations = [];
  const files = await fs.readdir(record.journalDir).catch(() => []);
  let malformed = false; let aborted = false;
  for (const name of files) {
    if (!/^[0-9]+-[a-f0-9-]+\.jsonl$/.test(name)) continue;
    const file = await safePath(record.cwd, path.relative(record.cwd, path.join(record.journalDir, name)));
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) { malformed = true; continue; }
    for (const line of (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)) {
      try {
        const item = JSON.parse(line);
        if (!item.runtime || typeof item.pid !== 'number') throw new Error('Invalid event');
        const runtime = runtimes.get(item.runtime) || {};
        if (item.kind === 'start') Object.assign(runtime, { language: item.language, pid: item.pid });
        if (item.kind === 'end') runtime.exitCode = item.exitCode;
        if (item.kind === 'paused') aborted = true;
        runtimes.set(item.runtime, runtime);
        if (item.kind === 'write') {
          if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid write event');
          observations.push(item);
        }
      } catch { malformed = true; }
    }
  }
  record.observedRuntimes = [...runtimes.values()].map(({ language, exitCode }) => ({ language, exitCode }));
  record.observedWrites = observations.length;
  record.touchedPaths = [...new Set(observations.map(item => item.path))];
  record.files = [];
  if (aborted) {
    record.status = 'discarded'; record.warning = '运行中工作开关暂停或健康检查过期，未采集终端产物。';
  } else if (record.completion === 'failed' || [...runtimes.values()].some(r => typeof r.exitCode === 'number' && r.exitCode !== 0)) {
    record.status = 'failed'; record.warning = '命令或被追踪运行时失败，产物未自动发布。';
  } else if (malformed) {
    record.status = 'needs_attention'; record.warning = '写入证据不完整，未自动发布。';
  } else if ([...runtimes.values()].some(r => r.language === 'powershell' ? alive(r.pid) : r.exitCode === undefined)) {
    record.status = 'waiting_for_runtime'; record.warning = '等待运行时完整结束记录；不会据时间戳猜测产物。';
  } else {
    const latest = new Map();
    observations.sort((a, b) => a.time - b.time);
    for (const item of observations) {
      const canonical = process.platform === 'win32' ? path.resolve(item.path).toLowerCase() : path.resolve(item.path);
      const previous = latest.get(canonical);
      latest.set(canonical, { ...item, beforeHashes: [...(previous?.beforeHashes || []), item.before] });
    }
    for (const item of latest.values()) {
      if (item.beforeHashes.every(hash => hash === item.sha256)) { record.files.push({ path: item.path, status: 'unchanged' }); continue; }
      try {
        const job = await archiveFile({ ...c, activeRoot: record.cwd }, item.path, { client: record.client, tool: 'terminal_trace', trace: record.key, expectedSha256: item.sha256 });
        record.files.push({ path: item.path, status: 'queued', jobId: job.id });
      } catch (error) {
        const skipped = ['EXCLUDED_FILE', 'PATH_OUT_OF_SCOPE', 'ENOENT'].includes(error.code);
        record.files.push({ path: item.path, status: skipped ? 'skipped' : 'needs_attention', error: error.code || error.message });
      }
    }
    record.status = record.files.some(f => f.status === 'needs_attention') ? 'needs_attention' : record.files.some(f => f.jobId) ? 'captured' : runtimes.size ? 'no_observed_changes' : 'unobserved';
  }
  record.collectedAt = new Date().toISOString();
  await atomicJson(location(c, record.key), record);
  return record;
}
export async function collectTerminal(c) {
  const directory = path.join(c.stateDir, 'terminal');
  if (!await exists(directory)) return [];
  const results = [];
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = await readJson(path.join(directory, name));
    if (record.activation === c.enabledAt) results.push(await collectOne(c, record));
  }
  return results;
}
export async function terminalStatus(c) {
  const directory = path.join(c.stateDir, 'terminal');
  if (!await exists(directory)) return { counts: {}, issues: [] };
  const counts = {}; const issues = [];
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const item = await readJson(path.join(directory, name));
    counts[item.status] = (counts[item.status] || 0) + 1;
    if (item.status === 'needs_attention' || (item.status === 'failed' && item.observedWrites > 0)) issues.push({ trace: item.key, status: item.status, warning: item.warning, files: item.files });
  }
  return { counts, issues };
}

export async function terminalWatchState(c, epoch) {
  const activeDirectories = []; const suppressed = new Map();
  const directory = path.join(c.stateDir, 'terminal');
  for (const name of await fs.readdir(directory).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const item = await readJson(path.join(directory, name));
    if (item.epoch !== epoch) continue;
    if (['prepared', 'waiting_for_runtime', 'waiting_for_completion'].includes(item.status)) activeDirectories.push(item.cwd);
    if (['failed', 'needs_attention', 'discarded'].includes(item.status)) for (const source of item.touchedPaths || []) {
      const key = process.platform === 'win32' ? path.resolve(source).toLowerCase() : path.resolve(source);
      const token = `${item.collectedAt || item.createdAt}:${item.key}`;
      if (!suppressed.has(key) || suppressed.get(key) < token) suppressed.set(key, token);
    }
  }
  return { activeDirectories, suppressed };
}
