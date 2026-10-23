import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installUser } from '../src/install-user.mjs';
import { loadConfig, jobs, getProfile, setup } from '../src/storage.mjs';
import { createWatcher } from '../src/watcher.mjs';
import { createDesktopContexts } from '../src/desktop-context.mjs';
const connections = new WeakMap();

async function fixture(t) {
  connections.set(t, []);
  const root = path.resolve('.test-output', 'doubao-' + randomUUID());
  const home = path.join(root, 'isolated clients');
  const work = path.join(root, 'work');
  const a = path.join(work, 'project a'), b = path.join(work, 'project b');
  const settings = { mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), workRoots: [work] };
  for (const dir of [a, b, settings.mdRoot, settings.filesRoot]) await fs.mkdir(dir, { recursive: true });
  const file = path.join(root, 'settings.local.md');
  const write = async () => fs.writeFile(file, '<!-- company-knowledge-config:v1 -->\n| 项目 | 路径 |\n| --- | --- |\n' + [['MdRoot', settings.mdRoot], ['FilesRoot', settings.filesRoot], ...settings.workRoots.map(p => ['WorkRoot', p])].map(([key, value]) => `| ${key} | \`${value}\` |`).join('\n') + '\n<!-- /company-knowledge-config -->\n');
  await write();
  const apply = async (client = 'doubao', extra = {}) => {
    const result = await installUser({ client, 'config-md': file, ...extra }, { home });
    return { installed: result, c: await loadConfig(result.configPath) };
  };
  t.after(async () => {
    for (const client of connections.get(t).reverse()) await client.close();
    assert.equal(path.dirname(root), path.resolve('.test-output'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { root, home, work, a, b, settings, file, write, apply };
}
async function connect(t, installed, cwd, desktop = true) {
  const client = new Client({ name: desktop ? 'desktop-protocol-test' : 'cli-protocol-test', version: '1' });
  const spec = desktop ? installed.doubao : { command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', installed.configPath] };
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, cwd }));
  connections.get(t).push(client);
  return {
    client,
    async call(name, args = {}, errorCode) {
      const result = await client.callTool({ name, arguments: args });
      const body = JSON.parse(result.content[0].text);
      if (errorCode) { assert.equal(result.isError, true); assert.equal(body.error, errorCode, JSON.stringify(body)); }
      else assert.notEqual(result.isError, true, JSON.stringify(body));
      return body;
    }
  };
}

test('Doubao-only preparation exports STDIO without creating or editing other client registrations', async t => {
  const f = await fixture(t); const { installed, c } = await f.apply();
  const exported = JSON.parse(await fs.readFile(installed.doubao.registrationFile, 'utf8'));
  assert.equal(exported.mcpServers['company-knowledge'].command, process.execPath);
  assert.deepEqual(exported.mcpServers['company-knowledge'].args, installed.doubao.args);
  assert.equal(installed.doubao.clientConfigurationApplied, false);
  assert.equal(installed.doubao.clientHooks, false);
  for (const name of ['.claude.json', '.claude', '.codex']) await assert.rejects(fs.access(path.join(f.home, name)), { code: 'ENOENT' });
  assert.equal(await getProfile(c), null);
  assert.deepEqual(await fs.readdir(c.mdRoot), []);
  assert.equal((await f.apply()).installed.configPath, installed.configPath);
  await setup(c, 'Fixture Employee');
  const before = await getProfile(c);
  const cli = await f.apply('both');
  assert.equal(cli.installed.configPath, installed.configPath);
  assert.equal((await getProfile(cli.c)).id, before.id);
  const claudeBefore = await fs.readFile(cli.installed.globalPaths.claudeHooks, 'utf8');
  const codexBefore = await fs.readFile(cli.installed.globalPaths.codexMcp, 'utf8');
  await f.apply('doubao');
  assert.equal(await fs.readFile(cli.installed.globalPaths.claudeHooks, 'utf8'), claudeBefore);
  assert.equal(await fs.readFile(cli.installed.globalPaths.codexMcp, 'utf8'), codexBefore);
});

test('desktop MCP requires explicit work context, shares identity/dedupe and watches only registered files', async t => {
  const f = await fixture(t);
  const history = path.join(f.a, 'history.md'); await fs.writeFile(history, 'never handled');
  const { installed, c } = await f.apply();
  const desktop = await connect(t, installed, f.root);
  const profile = await desktop.call('kb_profile');
  assert.equal(profile.gate.status, 'work_context_required');
  assert.equal(profile.onboarding.nextAction, 'choose_work_directory');
  assert.equal(profile.clientHooks, false);
  await desktop.call('kb_setup', { name: 'Fixture Employee' }, 'WORK_CONTEXT_REQUIRED');
  await desktop.call('kb_begin_work', { work_directory: f.root }, 'PATH_OUT_OF_SCOPE');
  await desktop.call('kb_begin_work', { work_directory: '../private' }, 'PATH_OUT_OF_SCOPE');
  const begin = await desktop.call('kb_begin_work', { work_directory: f.a });
  assert.equal(begin.onboarding.nextAction, 'ask_user_name');
  const scope = { work_session: begin.work_session };
  const employee = await desktop.call('kb_setup', { ...scope, name: 'Fixture Employee' });
  const file = path.join(f.a, 'fresh.md'), csv = path.join(f.a, 'fresh.csv');
  await fs.writeFile(file, 'one'); await fs.writeFile(csv, 'a,b\n1,2');
  const before = await fs.stat(file);
  await desktop.call('kb_read_work_file', { local_path: file }, 'WORK_CONTEXT_REQUIRED');
  const first = await desktop.call('kb_read_work_file', { ...scope, local_path: file });
  assert.equal(first.archive.status, 'stored'); assert.equal(first.text, 'one');
  const repeated = await desktop.call('kb_read_work_file', { ...scope, local_path: file });
  assert.equal(repeated.archive.id, first.archive.id);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  const other = path.join(f.b, 'private-to-this-session.md'); await fs.writeFile(other, 'different project');
  await desktop.call('kb_read_work_file', { ...scope, local_path: other }, 'PATH_OUT_OF_SCOPE');
  assert.equal((await desktop.call('kb_status')).gate.status, 'work_context_required');
  const cli = await connect(t, installed, f.a, false);
  assert.equal((await cli.call('kb_profile')).employee.id, employee.id);
  assert.equal((await cli.call('kb_read_work_file', { local_path: file })).archive.id, first.archive.id);
  const binary = await desktop.call('kb_upload_file', { ...scope, local_path: csv });
  assert.equal(binary.bucket, 'files'); assert.equal(binary.status, 'stored');
  const note = await desktop.call('kb_save_knowledge', { ...scope, title: 'Fixture solution', problem: 'Fixture problem', solution: 'Fixture steps', verification: '待验证' });
  assert.equal(note.bucket, 'md'); assert.equal(note.status, 'stored');
  assert.equal((await jobs(c)).length, 3);
  assert.equal((await desktop.call('kb_read_file', { ...scope, bucket: 'md', path: (await jobs(c)).find(j => j.id === first.archive.id).relative })).text, 'one');
  await desktop.call('kb_search', { ...scope, bucket: 'md', query: 'fresh', mode: 'filename' });
  await desktop.call('kb_list_files', { ...scope, bucket: 'files' });
  const watcher = createWatcher({ ...c, settleMs: 0 }); await watcher.tick();
  await fs.writeFile(file, 'two'); await fs.writeFile(history, 'history modified outside Agent');
  await watcher.tick(); await watcher.tick();
  const all = await jobs(c); assert.equal(all.length, 4);
  assert.ok(!all.some(j => j.metadata.source === history || j.metadata.source === other));
  await desktop.call('kb_end_work', scope);
  await desktop.call('kb_read_work_file', { ...scope, local_path: file }, 'WORK_CONTEXT_EXPIRED');
});

test('desktop work contexts stay per-call and per-process, and respect pause, offline and MD migration', async t => {
  const f = await fixture(t); const { installed, c } = await f.apply();
  const desktop = await connect(t, installed, f.a); // Even a cwd inside work does not activate desktop.
  assert.equal((await desktop.call('kb_profile')).gate.status, 'work_context_required');
  const a = await desktop.call('kb_begin_work', { work_directory: f.a });
  const b = await desktop.call('kb_begin_work', { work_directory: f.b });
  const sa = { work_session: a.work_session }, sb = { work_session: b.work_session };
  await desktop.call('kb_setup', { ...sa, name: 'Fixture Employee' });
  assert.equal((await desktop.call('kb_profile', sb)).workDirectory, f.b);
  assert.equal((await desktop.call('kb_profile', sa)).workDirectory, f.a);
  assert.equal((await desktop.call('kb_profile')).workDirectory, null);
  const otherConnection = await connect(t, installed, f.root);
  await otherConnection.call('kb_profile', sa, 'WORK_CONTEXT_EXPIRED');
  const file = path.join(f.a, 'new.md'); await fs.writeFile(file, 'one');
  await desktop.call('kb_work_switch', { enabled: false });
  await desktop.call('kb_upload_file', { ...sa, local_path: file }, 'WORK_PAUSED');
  await desktop.call('kb_work_switch', { enabled: true }, 'WORK_CONTEXT_REQUIRED');
  await desktop.call('kb_work_switch', { ...sa, enabled: true });
  await fs.rename(c.filesRoot, c.filesRoot + '-offline');
  await desktop.call('kb_upload_file', { ...sa, local_path: file }, 'WORK_PAUSED');
  await fs.rename(c.filesRoot + '-offline', c.filesRoot);
  assert.equal((await jobs(c)).length, 0);
  f.settings.workRoots = [f.b]; await f.write();
  await desktop.call('kb_upload_file', { ...sa, local_path: file }, 'WORK_PAUSED');
  const migrated = await f.apply();
  assert.equal(migrated.installed.configPath, installed.configPath);
  await desktop.call('kb_profile', sa, 'WORK_CONTEXT_EXPIRED');
  await desktop.call('kb_profile', sb, 'WORK_CONTEXT_EXPIRED');
  await desktop.call('kb_begin_work', { work_directory: f.a }, 'PATH_OUT_OF_SCOPE');
  assert.equal((await desktop.call('kb_begin_work', { work_directory: f.b })).onboarding.nextAction, 'continue_work');
});

test('desktop context tokens expire and symlinked work directories are refused', async t => {
  const f = await fixture(t); const { c } = await f.apply();
  let clock = 1000; const contexts = createDesktopContexts({ now: () => clock, ttlMs: 1000 });
  const session = await contexts.begin(c, f.a);
  assert.equal(await contexts.resolve(c, session.work_session), f.a);
  clock += 1001;
  await assert.rejects(contexts.resolve(c, session.work_session), { code: 'WORK_CONTEXT_EXPIRED' });
  const link = path.join(f.work, 'link');
  await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(contexts.begin(c, link), { code: 'PATH_OUT_OF_SCOPE' });
});

test('all-client installation reuses an existing CLI identity and refuses conflicting desktop exports', async t => {
  const f = await fixture(t); const cli = await f.apply('both');
  const profile = await setup(cli.c, 'Fixture Employee');
  const all = await f.apply('all');
  assert.equal(all.installed.configPath, cli.installed.configPath);
  assert.equal((await getProfile(all.c)).id, profile.id);
  for (const file of [all.installed.globalPaths.claudeHooks, all.installed.globalPaths.codexHooks]) {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const groups of Object.values(data.hooks)) assert.equal(groups.length, 1);
  }
  const configBefore = await fs.readFile(all.installed.configPath, 'utf8');
  const exportFile = all.installed.doubao.registrationFile;
  const exported = JSON.parse(await fs.readFile(exportFile, 'utf8'));
  const args = exported.mcpServers['company-knowledge'].args;
  args[args.indexOf('--config') + 1] = path.join(f.root, 'different-identity.json');
  await fs.writeFile(exportFile, JSON.stringify(exported));
  await assert.rejects(f.apply('doubao'), { code: 'CONFIG_CONFLICT' });
  assert.equal(await fs.readFile(all.installed.configPath, 'utf8'), configBefore);
});

test('Doubao STDIO arguments preserve spaces and quotes without generating shell hooks', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, "employee's home");
  const installed = await installUser({ client: 'doubao', 'config-md': f.file }, { home });
  const desktop = await connect(t, installed, f.root);
  assert.equal((await desktop.call('kb_profile')).gate.status, 'work_context_required');
  assert.ok(installed.doubao.args.includes(installed.configPath));
  await assert.rejects(fs.access(path.join(home, '.claude')), { code: 'ENOENT' });
});
