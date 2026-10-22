import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { install } from '../src/install.mjs';
import { handleHook } from '../src/hooks.mjs';
import { atomicJson, getProfile, jobs, loadConfig, setup } from '../src/storage.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'knowledge-codex-'));
  const workspace = path.join(root, 'work');
  const state = path.join(root, 'shared-state');
  for (const part of ['work', 'md', 'files']) await fs.mkdir(path.join(root, part));
  const installed = await install({ client: 'claude', workspace, state, 'md-root': path.join(root, 'md'), 'files-root': path.join(root, 'files') });
  const c = await loadConfig(installed.configPath);
  t.after(async () => { assert.ok(path.dirname(root) === tempRoot && path.basename(root).startsWith('knowledge-codex-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, installed, c };
}

test('adding Codex discovers Claude configuration and preserves the employee and unrelated settings', async t => {
  const { workspace, c } = await fixture(t);
  const employee = await setup(c, '同一员工');
  await fs.mkdir(path.join(workspace, '.codex'));
  await fs.writeFile(path.join(workspace, '.codex/config.toml'), '# existing\nmodel_reasoning_effort = "medium"\n');
  const added = await install({ client: 'codex', workspace });
  assert.equal(added.sharedState, c.stateDir);
  assert.equal((await getProfile(c)).id, employee.id);
  const config = await fs.readFile(added.codexConfigPath, 'utf8');
  assert.match(config, /model_reasoning_effort = "medium"/);
  assert.ok(config.includes(JSON.stringify(added.configPath)));
  await install({ client: 'codex', workspace });
  assert.equal((await fs.readFile(added.codexConfigPath, 'utf8')).match(/\[mcp_servers.company-knowledge\]/g).length, 1);
  const hooks = JSON.parse(await fs.readFile(added.codexHooksPath, 'utf8'));
  assert.equal(hooks.hooks.PostToolUse.length, 1);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /--client codex$/);
});

test('Claude and Codex hook processes sharing a file create only one archive job', async t => {
  const { c, workspace, installed } = await fixture(t); await setup(c, '同一员工');
  const file = path.join(workspace, '共同资料.md'); await fs.writeFile(file, '# 共用资料');
  const run = (client, payload) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('bin/kb.mjs'), 'hook', '--config', installed.configPath, '--client', client], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => stderr += x); child.stdout.resume(); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(payload));
  });
  await Promise.all(['claude','codex'].map(client => run(client, { hook_event_name: 'UserPromptSubmit', session_id: client+'-session', cwd: workspace, prompt: 'work' })));
  await Promise.all([
    run('claude', { hook_event_name: 'PostToolUse', session_id: 'claude-session', cwd: workspace, tool_name: 'Read', tool_input: { file_path: file } }),
    run('codex', { hook_event_name: 'PostToolUse', session_id: 'codex-session', cwd: workspace, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` } })
  ]);
  const all = await jobs(c); assert.equal(all.length, 1); assert.equal(all[0].status, 'stored');
});
test('Codex-first installation is also discovered by Claude and conflicting identities are refused', async t => {
  const { workspace, root, c } = await fixture(t);
  await install({ client: 'codex', workspace });
  // Removing only the generated MCP registration simulates a Codex-only workspace.
  await fs.rm(path.join(workspace, '.mcp.json'));
  const added = await install({ client: 'claude', workspace });
  assert.equal(added.sharedState, c.stateDir);
  await assert.rejects(install({ client: 'codex', workspace, state: path.join(root, 'different-state') }), /复用已有配置/);
});

test('Codex Stop uses its own source label and does not mix another client turn', async t => {
  const { c, workspace } = await fixture(t); await setup(c, '同一员工');
  const common = { session_id: 'same-id', cwd: workspace };
  await handleHook(c, { ...common, client: 'claude', hook_event_name: 'UserPromptSubmit', prompt: 'Claude 独立问题' });
  await handleHook(c, { ...common, client: 'codex', hook_event_name: 'UserPromptSubmit', turn_id: 'codex-turn', prompt: 'Codex 文件编码问题' });
  await handleHook(c, { ...common, client: 'codex', hook_event_name: 'Stop', last_assistant_message: '# 文件乱码排查\n根因：文本编码与解码方式不匹配。解决步骤：先检查文件实际编码，在数据边界统一使用 UTF-8，并用严格解码器识别非法字节；不要直接覆盖原始文件。验证办法：准备中文及表情符号样例，分别测试写入和读回是否一致，同时检查字节数量和异常行为。尚未执行实际验证。' });
  const [record] = await jobs(c); const text = await fs.readFile(record.destination, 'utf8');
  assert.match(text, /来源：Codex Stop/); assert.match(text, /Codex 文件编码问题/); assert.doesNotMatch(text, /Claude 独立问题/);
});

test('two MCP clients read the same snapshot without duplicating uploads; modifications create a new version', async t => {
  const { c, installed, workspace } = await fixture(t); await setup(c, '同一员工');
  const file = path.join(workspace, '文件.md'); await fs.writeFile(file, '# 第一版');
  const connect = async name => {
    const client = new Client({ name, version: '1.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', installed.configPath], cwd: workspace }));
    return client;
  };
  const a = await connect('claude-test'); const b = await connect('codex-test');
  try {
  const read = async client => {
    const output = await client.callTool({ name: 'kb_read_work_file', arguments: { local_path: file } });
    assert.notEqual(output.isError, true); return JSON.parse(output.content[0].text);
  };
  const first = await read(a); const second = await read(b);
  assert.equal(first.archive.id, second.archive.id); assert.equal(second.text, '# 第一版'); assert.equal((await jobs(c)).length, 1);
  await fs.writeFile(file, '# 第二版'); const third = await read(b);
  assert.notEqual(third.archive.id, first.archive.id); assert.equal((await jobs(c)).length, 2);
  } finally { await Promise.all([a.close(), b.close()]); }
});
