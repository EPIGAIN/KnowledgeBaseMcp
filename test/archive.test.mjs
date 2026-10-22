import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { archiveFile, atomicJson, flush, getProfile, jobs, listFiles, readText, searchFiles, setup } from '../src/storage.mjs';
import { handleHook } from '../src/hooks.mjs';
import { install } from '../src/install.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'knowledge-test-'));
  const c = { version: 1, mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), stateDir: path.join(root, 'state'), workRoots: [path.join(root, 'work')], maxBytes: 104857600 };
  for (const p of [c.mdRoot, c.filesRoot, c.stateDir, ...c.workRoots]) await fs.mkdir(p);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { c, root };
}
test('onboarding asks for name; one identity owns both folders; cannot switch identity', async t => {
  const { c } = await fixture(t);
  const message = await handleHook(c, { hook_event_name: 'SessionStart', cwd: c.workRoots[0] });
  assert.match(message.hookSpecificOutput.additionalContext, /姓名/);
  assert.match(message.systemMessage, /请问你的姓名是什么/);
  await assert.rejects(setup(c, '../别人'), { code: 'INVALID_NAME' });
  const p = await setup(c, '员工A');
  assert.equal(path.basename(p.mdDirectory), path.basename(p.filesDirectory));
  assert.ok((await fs.stat(p.mdDirectory)).isDirectory());
  assert.equal((await setup(c, '员工A')).id, p.id);
  await assert.rejects(setup(c, '员工B'), { code: 'PROFILE_EXISTS' });
});

test('onboarding is proactive for both global clients, captures nothing before a name, and stops asking after shared setup', async t => {
  const { c } = await fixture(t);
  const global = { ...c, scope: 'user', enabledAt: new Date().toISOString(), terminalCapture: { enabled: true } };
  for (const client of ['claude', 'codex']) {
    const base = { client, cwd: c.workRoots[0], session_id: client };
    const start = await handleHook(global, { ...base, hook_event_name: 'SessionStart' });
    assert.match(start.systemMessage, /请问你的姓名是什么/);
    const first = await handleHook(global, { ...base, hook_event_name: 'UserPromptSubmit', prompt: '你好' });
    assert.match(first.hookSpecificOutput.additionalContext, /主动询问/);
    assert.match(first.hookSpecificOutput.additionalContext, /不要等用户提出初始化请求/);
    await handleHook(global, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'not-a-real-file.md' } });
  }
  assert.equal(await getProfile(c), null);
  assert.equal((await jobs(c)).length, 0);
  assert.deepEqual(await fs.readdir(c.mdRoot), []);
  assert.deepEqual(await fs.readdir(c.filesRoot), []);
  await setup(c, '测试姓名');
  for (const client of ['claude', 'codex']) {
    const start = await handleHook(global, { client, cwd: c.workRoots[0], hook_event_name: 'SessionStart' });
    assert.equal(start.systemMessage, undefined);
    assert.match(start.hookSpecificOutput.additionalContext, /员工：测试姓名/);
    assert.doesNotMatch(start.hookSpecificOutput.additionalContext, /请问你的姓名是什么/);
  }
});
test('post-tool hooks route MD and other files, preserve hashes and deduplicate', async t => {
  const { c } = await fixture(t); const p = await setup(c, '员工A');
  await handleHook(c, { hook_event_name: 'UserPromptSubmit', session_id: 'test', cwd: c.workRoots[0], prompt: 'work' });
  for (const [name, data] of [['报告.md', '# 项目总结\n内容'], ['预算.csv', '项目,金额\nA,100']]) {
    const file = path.join(c.workRoots[0], name); await fs.writeFile(file, data);
    await handleHook(c, { hook_event_name: 'PostToolUse', session_id: 'test', cwd: c.workRoots[0], tool_name: 'Read', tool_input: { file_path: file } });
    await handleHook(c, { hook_event_name: 'PostToolUse', session_id: 'test', cwd: c.workRoots[0], tool_name: 'Read', tool_input: { file_path: file } });
  }
  const all = await jobs(c); assert.equal(all.length, 2);
  for (const j of all) {
    assert.equal(j.status, 'stored');
    assert.ok(j.destination.startsWith(path.join(j.bucket === 'md' ? c.mdRoot : c.filesRoot, p.folder)));
    assert.equal(await fs.readFile(j.destination, 'utf8'), await fs.readFile(j.metadata.source, 'utf8'));
  }
});
test('out-of-scope paths and links cannot cross employee or work boundaries', async t => {
  const { c, root } = await fixture(t); await setup(c, '员工A');
  const outside = path.join(root, 'private.txt'); await fs.writeFile(outside, 'private');
  await assert.rejects(archiveFile(c, outside), { code: 'PATH_OUT_OF_SCOPE' });
  await assert.rejects(listFiles(c, 'md', '..'), { code: 'PATH_OUT_OF_SCOPE' });
  const secret = path.join(c.workRoots[0], '.env'); await fs.writeFile(secret, 'secret');
  await assert.rejects(archiveFile(c, secret), { code: 'EXCLUDED_FILE' });
  const junction = path.join(c.workRoots[0], 'link');
  await fs.symlink(root, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(archiveFile(c, path.join(junction, 'private.txt')), { code: 'PATH_OUT_OF_SCOPE' });
});
test('offline storage leaves durable snapshot; retry succeeds after original source deleted', async t => {
  const { c } = await fixture(t); await setup(c, '员工A');
  const file = path.join(c.workRoots[0], 'offline.txt'); await fs.writeFile(file, 'must survive');
  await archiveFile(c, file);
  const offline = `${c.filesRoot}-offline`; await fs.rename(c.filesRoot, offline);
  await assert.rejects(flush(c), { code: 'WORK_PAUSED' });
  await fs.rm(file); await fs.rename(offline, c.filesRoot);
  const retried = (await flush(c, { force: true }))[0];
  assert.equal(retried.status, 'stored'); assert.equal(await fs.readFile(retried.destination, 'utf8'), 'must survive');
});
test('existing different destination is never overwritten', async t => {
  const { c } = await fixture(t); const p = await setup(c, '员工A');
  const file = path.join(c.workRoots[0], 'data.txt'); await fs.writeFile(file, 'new');
  const j = await archiveFile(c, file); const target = path.join(c.filesRoot, p.folder, j.relative);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'existing');
  const result = (await flush(c))[0];
  assert.equal(result.error.code, 'FILE_EXISTS'); assert.equal(await fs.readFile(target, 'utf8'), 'existing');
});
test('search finds archived text with source lines and reports unsupported formats', async t => {
  const { c } = await fixture(t); await setup(c, '员工A');
  const text = path.join(c.workRoots[0], '说明.md'); await fs.writeFile(text, '# 说明\n根因：令牌失效');
  await archiveFile(c, text); await flush(c);
  const found = await searchFiles(c, 'md', '令牌', 'text');
  assert.equal(found.matches[0].line, 2); assert.equal(found.partial, false);
  const binary = path.join(c.workRoots[0], '附件.pdf'); await fs.writeFile(binary, 'mock binary');
  await archiveFile(c, binary); await flush(c);
  const skipped = await searchFiles(c, 'files', 'nothing', 'text');
  assert.equal(skipped.skipped, 1); assert.equal(skipped.partial, true);
});
test('concurrent duplicate captures and flushes create one document', async t => {
  const { c } = await fixture(t); await setup(c, '员工A');
  const file = path.join(c.workRoots[0], 'same.md'); await fs.writeFile(file, 'same');
  await Promise.all(Array.from({ length: 6 }, () => archiveFile(c, file)));
  await Promise.all([flush(c), flush(c), flush(c)]);
  assert.equal((await jobs(c)).length, 1); assert.equal((await jobs(c))[0].status, 'stored');
});
test('Stop preserves problem solving method but skips ordinary greeting', async t => {
  const { c } = await fixture(t); await setup(c, '员工A');
  const e = { session_id: 's1', cwd: c.workRoots[0] };
  await handleHook(c, { ...e, hook_event_name: 'UserPromptSubmit', prompt: '接口返回 401 如何排查？' });
  const answer = '# 接口 401 排查\n\n根因：访问令牌已经过期。\n\n解决方法：先确认服务端返回的错误码与认证日志，然后检查令牌到期时间；通过正式登录流程重新获取访问令牌并重试请求，禁止在日志中输出令牌。\n\n验证：比较刷新前后的 HTTP 状态码，确认从 401 恢复为 200。没有实际执行验证，因此需要标注待验证。';
  await handleHook(c, { ...e, hook_event_name: 'Stop', last_assistant_message: answer });
  await handleHook(c, { ...e, hook_event_name: 'Stop', last_assistant_message: answer, stop_hook_active: true });
  assert.equal((await jobs(c)).length, 1);
  const j = (await jobs(c))[0]; assert.equal(j.bucket, 'md');
  const text = await fs.readFile(j.destination, 'utf8'); assert.match(text, /接口返回 401/); assert.match(text, /待复核/); assert.match(text, /正式登录流程/);
  await handleHook(c, { ...e, hook_event_name: 'UserPromptSubmit', prompt: '谢谢' });
  await handleHook(c, { ...e, hook_event_name: 'Stop', last_assistant_message: '不客气。' });
  assert.equal((await jobs(c)).length, 1);
});
test('installer merges existing configuration and does not duplicate hooks', async t => {
  const { c } = await fixture(t); const workspace = c.workRoots[0];
  await atomicJson(path.join(workspace, '.mcp.json'), { mcpServers: { existing: { command: 'existing' } } });
  const opts = { workspace, state: c.stateDir, 'md-root': c.mdRoot, 'files-root': c.filesRoot };
  await install(opts); await install(opts);
  const mcp = JSON.parse(await fs.readFile(path.join(workspace, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.existing.command, 'existing');
  const settings = JSON.parse(await fs.readFile(path.join(workspace, '.claude/settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.Stop.length, 1);
});
test('real MCP stdio handshake, onboarding and write/read roundtrip', async t => {
  const { c } = await fixture(t); const cp = path.join(c.stateDir, 'config.json'); await atomicJson(cp, c);
  const client = new Client({ name: 'integration-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', cp], cwd: c.workRoots[0] });
  await client.connect(transport);
  try {
  assert.ok((await client.listTools()).tools.some(x => x.name === 'kb_setup'));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.notEqual(r.isError, true); return JSON.parse(r.content[0].text); };
  assert.match(client.getInstructions(), /首次可回复.*主动询问/);
  const before = await call('kb_profile', {});
  assert.equal(before.initialized, false);
  assert.equal(before.onboarding.nextAction, 'ask_user_name');
  assert.match(before.onboarding.question, /请问你的姓名是什么/);
  await call('kb_setup', { name: '测试员工' });
  const after = await call('kb_profile', {});
  assert.equal(after.onboarding.nextAction, 'continue_work');
  assert.equal(after.onboarding.question, null);
  const saved = await call('kb_write_markdown', { title: '验证', content: '# 成功\n你好🌏' }); assert.equal(saved.status, 'stored');
  const read = await call('kb_read_file', { bucket: 'md', path: saved.relative }); assert.equal(read.text, '# 成功\n你好🌏');
  } finally { await client.close(); }
});
