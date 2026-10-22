import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveFile, setup, jobs, flush, atomicJson, getProfile, readJson } from '../src/storage.mjs';
import { evaluateGate, setWorkEnabled } from '../src/gate.mjs';
import { createWatcher } from '../src/watcher.mjs';
import { handleHook } from '../src/hooks.mjs';
import { prepareTerminal, finishTerminal, collectTerminal } from '../src/terminal.mjs';
import { installUser } from '../src/install-user.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const run = promisify(execFile);

async function fixture(t) {
  const root = path.resolve('.test-output', randomUUID());
  const c = { version: 2, scope: 'user', enabledAt: new Date().toISOString(), workRoots: [path.join(root, 'work')], stateDir: path.join(root, 'state'), mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), maxBytes: 1048576, settleMs: 0, terminalCapture: { enabled: true } };
  c.activeRoot = c.workRoots[0];
  for (const p of [...c.workRoots, c.mdRoot, c.filesRoot, path.join(root, 'private')]) await fs.mkdir(p, { recursive: true });
  await atomicJson(path.join(c.stateDir, 'config.json'), c);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('.test-output')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, c, work: c.workRoots[0], privateDir: path.join(root, 'private') };
}

test('shared gate: offline and private sessions do not ask for a name, read sources, or collect prompts', async t => {
  const { c, work, privateDir } = await fixture(t);
  const privateStart = await handleHook(c, { hook_event_name: 'SessionStart', cwd: privateDir });
  assert.match(privateStart.hookSpecificOutput.additionalContext, /outside_work/); assert.equal(privateStart.systemMessage, undefined);
  await fs.rename(c.filesRoot, c.filesRoot + '-offline');
  const start = await handleHook(c, { hook_event_name: 'UserPromptSubmit', cwd: work, prompt: 'private conversation' });
  assert.match(start.hookSpecificOutput.additionalContext, /offline/);
  await assert.rejects(setup(c, 'Fixture Employee'), { code: 'WORK_PAUSED' });
  assert.equal(await getProfile(c), null);
  await assert.rejects(fs.access(path.join(c.stateDir, 'sessions')), { code: 'ENOENT' });
  await fs.rename(c.filesRoot + '-offline', c.filesRoot);
  const online = await handleHook(c, { hook_event_name: 'SessionStart', cwd: work });
  assert.match(online.systemMessage, /姓名/);
});

test('watcher uploads stable manual edits only for newly registered work files and deduplicates', async t => {
  const { c, work, privateDir } = await fixture(t); await setup(c, 'Fixture Employee');
  const watcher = createWatcher(c); await watcher.tick();
  const known = path.join(work, 'known.md'), history = path.join(work, 'history.md'), personal = path.join(privateDir, 'personal.md');
  await fs.writeFile(history, 'history'); await fs.writeFile(personal, 'personal');
  await fs.writeFile(known, 'version 1'); await archiveFile(c, known); await flush(c); await watcher.tick();
  await fs.writeFile(known, 'version 2'); await fs.writeFile(history, 'edited by other process'); await fs.writeFile(personal, 'private edit');
  await watcher.tick(); await watcher.tick();
  let all = await jobs(c); assert.equal(all.length, 2); assert.ok(all.every(j => j.status === 'stored' && j.metadata.source === known));
  assert.equal(all.filter(j => j.metadata.tool === 'background_watch').length, 1);
  await archiveFile(c, known, { client: 'other-client' }); await watcher.tick();
  assert.equal((await jobs(c)).length, 2);
  await assert.rejects(archiveFile(c, personal), { code: 'PATH_OUT_OF_SCOPE' });
});

test('pause, reconnect and process restart rebaseline without replaying paused edits; pre-existing snapshots survive', async t => {
  const { c, work } = await fixture(t); await setup(c, 'Fixture Employee');
  const file = path.join(work, 'registered.md'); await fs.writeFile(file, 'one'); await archiveFile(c, file);
  const watcher = createWatcher(c); await watcher.tick();
  await setWorkEnabled(c, false); await fs.writeFile(file, 'paused edit');
  assert.equal((await watcher.tick()).status, 'manual_pause');
  await assert.rejects(archiveFile(c, file), { code: 'WORK_PAUSED' });
  await setWorkEnabled(c, true); await watcher.tick(); await watcher.tick(); assert.equal((await jobs(c)).length, 1);
  await fs.writeFile(file, 'online edit'); await watcher.tick(); await watcher.tick(); assert.equal((await jobs(c)).length, 2);
  await fs.rename(c.mdRoot, c.mdRoot + '-offline'); await watcher.tick(); await fs.writeFile(file, 'offline edit');
  await fs.rename(c.mdRoot + '-offline', c.mdRoot); await watcher.tick(); await watcher.tick(); assert.equal((await jobs(c)).length, 2);
  await fs.writeFile(file, 'while worker stopped'); const restarted = createWatcher(c); await restarted.tick(); await restarted.tick(); assert.equal((await jobs(c)).length, 2);
  await archiveFile(c, file); assert.equal((await jobs(c)).length, 3); // explicit new Agent touch
  await fs.rename(c.filesRoot, c.filesRoot + '-offline'); await assert.rejects(flush(c), { code: 'WORK_PAUSED' });
  await fs.rm(file); await fs.rename(c.filesRoot + '-offline', c.filesRoot); await flush(c);
  assert.ok((await jobs(c)).every(j => j.status === 'stored'));
});

test('MCP pause control immediately gates both MCP data calls and hooks', async t => {
  const { c, work } = await fixture(t); await setup(c, 'Fixture Employee');
  const client = new Client({ name: 'gate-fixture', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', path.join(c.stateDir, 'config.json')], cwd: work }));
  try {
  const call = (name, args) => client.callTool({ name, arguments: args });
  const file = path.join(work, 'manual.txt'); await fs.writeFile(file, 'work');
  assert.notEqual((await call('kb_work_switch', { enabled: false })).isError, true);
  const denied = await call('kb_read_work_file', { local_path: file }); assert.equal(denied.isError, true); assert.match(denied.content[0].text, /WORK_PAUSED/);
  const hook = await handleHook(c, { hook_event_name: 'SessionStart', cwd: work }); assert.match(hook.hookSpecificOutput.additionalContext, /manual_pause/);
  assert.equal((await jobs(c)).length, 0);
  await call('kb_work_switch', { enabled: true });
  assert.notEqual((await call('kb_read_work_file', { local_path: file })).isError, true); assert.equal((await jobs(c)).length, 1);
  } finally { await client.close(); }
});

test('terminal workdir cannot escape the allowlist and a pause discards incomplete capture permanently', async t => {
  const { c, work, privateDir } = await fixture(t); await setup(c, 'Fixture Employee');
  const e = { client: 'codex', cwd: work, session_id: 'fixture', tool_use_id: randomUUID(), tool_name: 'exec_command', tool_input: { cmd: 'echo test', workdir: privateDir } };
  assert.deepEqual(await prepareTerminal(c, e, { turnId: 'fixture' }), {});
  await assert.rejects(fs.access(path.join(privateDir, '.kb-terminal')), { code: 'ENOENT' });
  const next = { ...e, tool_use_id: randomUUID(), tool_input: { cmd: 'echo test', workdir: work } };
  await prepareTerminal(c, next, { turnId: 'fixture' });
  await setWorkEnabled(c, false);
  assert.equal((await finishTerminal(c, { ...next, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } })).status, 'discarded');
  await setWorkEnabled(c, true); await collectTerminal(c); assert.equal((await jobs(c)).length, 0);
});

test('offline installer accepts only explicit paths and keeps one identity across single-client additions', async t => {
  const { c, root } = await fixture(t); const home = path.join(root, 'client-home');
  await fs.rename(c.mdRoot, c.mdRoot + '-offline');
  const opts = { client: 'claude', state: path.join(root, 'new-state'), 'md-root': c.mdRoot, 'files-root': c.filesRoot, 'work-root': c.workRoots };
  const first = await installUser(opts, { home });
  assert.equal((await evaluateGate(await readJson(first.configPath))).status, 'offline');
  await assert.rejects(fs.access(path.join(home, '.codex/config.toml')), { code: 'ENOENT' });
  await assert.rejects(fs.access(c.mdRoot), { code: 'ENOENT' }); // installer never creates targets
  const second = await installUser({ ...opts, client: 'codex' }, { home }); assert.equal(second.configPath, first.configPath);
  await assert.rejects(installUser({ client: 'both', 'md-root': c.mdRoot, 'files-root': c.filesRoot }, { home }), /--state/);
  await assert.rejects(installUser({ ...opts, state: path.join(root, 'other-state') }, { home }), /另一份员工配置/);
  await assert.rejects(installUser({ ...opts, state: path.resolve('public-state-must-not-exist') }, { home }), /已忽略的私有目录/);
});

test('watcher defers active terminal writes and does not publish a failed command version', async t => {
  const { c, work } = await fixture(t); await setup(c, 'Fixture Employee');
  const watcher = createWatcher(c); await watcher.tick();
  const source = path.join(work, 'registered.txt'); await fs.writeFile(source, 'good'); await archiveFile(c, source); await watcher.tick();
  const gate = await evaluateGate(c); const key = 'a'.repeat(64);
  const trace = { key, epoch: gate.epoch, activation: c.enabledAt, cwd: work, status: 'prepared', createdAt: new Date().toISOString() };
  const file = path.join(c.stateDir, 'terminal', key + '.json'); await atomicJson(file, trace);
  await fs.writeFile(source, 'partial terminal output'); await watcher.tick(); await watcher.tick();
  assert.equal((await jobs(c)).length, 1);
  await atomicJson(file, { ...trace, status: 'failed', touchedPaths: [source], collectedAt: new Date().toISOString() });
  await watcher.tick(); await watcher.tick(); assert.equal((await jobs(c)).length, 1);
  await fs.writeFile(source, 'later manual correction'); await watcher.tick(); await watcher.tick();
  assert.equal((await jobs(c)).length, 2);
});

test('real terminal observer stops recording writes when the shared control is paused', async t => {
  const { c, work } = await fixture(t); await setup(c, 'Fixture Employee');
  const e = { client: 'codex', cwd: work, session_id: 'paused-fixture', tool_use_id: randomUUID(), tool_name: 'exec_command', tool_input: { cmd: 'node producer.cjs', workdir: work } };
  await prepareTerminal(c, e, { turnId: 'fixture' });
  const [name] = await fs.readdir(path.join(c.stateDir, 'terminal'));
  const trace = await readJson(path.join(c.stateDir, 'terminal', name));
  await setWorkEnabled(c, false);
  await run(process.execPath, ['-e', "require('node:fs').writeFileSync('while-paused.md','never collect')"], {
    cwd: work, windowsHide: true,
    env: { ...process.env, KB_TRACE_CONFIG: path.join(trace.journalDir, 'config.json'), NODE_OPTIONS: `--require "${path.resolve('tracers/node.cjs').replaceAll('\\', '/')}"` }
  });
  const events = [];
  for (const file of await fs.readdir(trace.journalDir)) if (file.endsWith('.jsonl')) events.push(...(await fs.readFile(path.join(trace.journalDir, file), 'utf8')).trim().split('\n').map(JSON.parse));
  assert.ok(events.some(event => event.kind === 'paused'));
  assert.ok(!events.some(event => event.kind === 'write'));
  await setWorkEnabled(c, true);
  assert.equal((await finishTerminal(c, { ...e, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } })).status, 'discarded');
  assert.equal((await jobs(c)).length, 0);
});
