import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { install } from '../src/install.mjs';
import { installUser } from '../src/install-user.mjs';
import { archiveFile, atomicJson, flush, getProfile, jobs, loadConfig, readJson, setup } from '../src/storage.mjs';
import { handleHook } from '../src/hooks.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const root = path.resolve('.test-output', `global-${randomUUID()}`);
  const c = { mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), stateDir: path.join(root, 'state'), workRoots: [path.join(root, 'original')], maxBytes: 1048576 };
  for (const p of [c.mdRoot, c.filesRoot, c.stateDir, ...c.workRoots, path.join(root, 'new-project')]) await fs.mkdir(p, { recursive: true });
  await atomicJson(path.join(c.stateDir, 'config.json'), c);
  await setup(c, '共用员工');
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('.test-output')); assert.ok(path.basename(root).startsWith('global-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, c, global: { ...c, scope: 'user', captureMode: 'new-events-only', enabledAt: new Date().toISOString() }, other: path.join(root, 'new-project') };
}

test('user installation preserves unrelated global settings, employee identity and removes owned project hooks', async t => {
  const { root, c } = await fixture(t); const home = path.join(root, 'home');
  await atomicJson(path.join(home, '.claude.json'), { otherPreference: true, mcpServers: { unrelated: { command: 'unchanged' } } });
  await atomicJson(path.join(home, '.claude/settings.json'), { env: { EXISTING_SETTING: 'keep' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/config.toml'), 'model_reasoning_effort = "medium"\n');
  const before = await getProfile(c);
  const options = { workspace: c.workRoots[0], config: path.join(c.stateDir, 'config.json') };
  await install({ ...options, client: 'both' });
  const originalCodexHome = process.env.CODEX_HOME;
  const foreignHome = path.join(root, 'must-not-touch');
  process.env.CODEX_HOME = foreignHome;
  let result;
  try { result = await installUser(options, { home }); }
  finally { if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome; }
  await assert.rejects(fs.access(foreignHome), { code: 'ENOENT' });
  assert.equal((await getProfile(c)).id, before.id);
  assert.equal((await loadConfig(result.configPath)).scope, 'user');
  assert.equal((await readJson(result.globalPaths.claudeMcp)).mcpServers.unrelated.command, 'unchanged');
  const settings = await readJson(result.globalPaths.claudeHooks);
  assert.equal(settings.env.EXISTING_SETTING, 'keep'); assert.equal(settings.hooks.Stop.length, 2);
  assert.match(await fs.readFile(result.globalPaths.codexMcp, 'utf8'), /model_reasoning_effort = "medium"/);
  assert.equal((await readJson(path.join(c.workRoots[0], '.claude/settings.local.json'))).hooks, undefined);
  assert.equal((await readJson(path.join(c.workRoots[0], '.mcp.json'))).mcpServers['company-knowledge'], undefined);
  const again = await installUser(options, { home });
  assert.equal(again.enabledAt, result.enabledAt);
  assert.equal((await readJson(result.globalPaths.codexHooks)).hooks.Stop.length, 1);
});

test('global hooks do not scan history or replay a late Stop; only a new explicitly touched file is captured', async t => {
  const { c, global: g, other } = await fixture(t);
  g.workRoots = [...c.workRoots, other];
  const touched = path.join(other, 'old-but-read-now.md'); const untouched = path.join(other, 'never-touched.md');
  await fs.writeFile(touched, '# old content'); await fs.writeFile(untouched, '# leave alone');
  const e = { client: 'claude', session_id: 'history-test', cwd: other };
  await handleHook(c, { ...e, hook_event_name: 'UserPromptSubmit', prompt: '旧会话问题' });
  await handleHook(g, { ...e, hook_event_name: 'SessionStart' });
  await handleHook(g, { ...e, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: touched } });
  await handleHook(g, { ...e, hook_event_name: 'Stop', last_assistant_message: '根因与解决方法。'.repeat(30) });
  assert.equal((await jobs(g)).length, 0);
  await handleHook(g, { ...e, hook_event_name: 'UserPromptSubmit', prompt: '新的处理请求' });
  await fs.writeFile(path.join(other, 'unrelated-external-change.md'), '# no agent touch');
  await handleHook(g, { ...e, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  await handleHook(g, { ...e, hook_event_name: 'Stop', last_assistant_message: '完成' });
  assert.equal((await jobs(g)).length, 0);
  await handleHook(g, { ...e, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: touched } });
  const all = await jobs(g); assert.equal(all.length, 1); assert.equal(all[0].metadata.source, touched); assert.equal(all[0].status, 'stored');
});

test('global mode reuses old receipts and deduplicates across different working roots', async t => {
  const { c, global: g, other, root } = await fixture(t);
  const legacy = path.join(c.workRoots[0], 'legacy.md'); await fs.writeFile(legacy, 'legacy');
  const before = await archiveFile(c, legacy); await flush(c);
  assert.equal((await archiveFile({ ...g, activeRoot: c.workRoots[0] }, legacy)).id, before.id);
  g.workRoots = [...c.workRoots, other];
  const fresh = path.join(other, 'fresh.md'); await fs.writeFile(fresh, 'same bytes');
  const [a, b] = await Promise.all([archiveFile({ ...g, activeRoot: other }, fresh), archiveFile({ ...g, activeRoot: root }, fresh)]);
  assert.equal(a.id, b.id); assert.equal((await jobs(g)).length, 2);
});

test('global MCP server launched outside work roots refuses access even when targets are online', async t => {
  const { c, global: g, other } = await fixture(t);
  const cp = path.join(c.stateDir, 'config.json'); await atomicJson(cp, g);
  await fs.writeFile(path.join(other, 'request.md'), '# requested');
  await fs.writeFile(path.join(other, 'untouched.md'), '# untouched');
  const client = new Client({ name: 'global-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', cp], cwd: other }));
  try {
    const result = await client.callTool({ name: 'kb_read_work_file', arguments: { local_path: 'request.md' } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'WORK_PAUSED');
    assert.equal((await jobs(g)).length, 0);
  } finally { await client.close(); }
});
