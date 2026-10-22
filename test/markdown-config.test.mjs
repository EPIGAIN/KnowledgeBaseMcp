import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installUser } from '../src/install-user.mjs';
import { parseMarkdownConfig } from '../src/markdown-config.mjs';
import { cancelMigration } from '../src/migrate-config.mjs';
import { archiveFile, flush, setup, getProfile, jobs, loadConfig, readJson, atomicJson, sha } from '../src/storage.mjs';
import { evaluateGate } from '../src/gate.mjs';
import { withOperation, migrationFile } from '../src/operations.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';

export function markdown(settings) {
  return '# Local settings\n<!-- company-knowledge-config:v1 -->\n| 项目 | 路径 |\n| --- | --- |\n' +
    [['MdRoot', settings.mdRoot], ['FilesRoot', settings.filesRoot], ...settings.workRoots.map(root => ['WorkRoot', root])].map(([key, value]) => `| ${key} | \`${value}\` |`).join('\n') + '\n<!-- /company-knowledge-config -->\n';
}
async function fixture(t) {
  const root = path.resolve('.test-output', 'md-config-' + randomUUID());
  const settings = { mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), workRoots: [path.join(root, 'work')] };
  const home = path.join(root, 'clients'); const file = path.join(root, 'settings.local.md');
  for (const directory of [settings.mdRoot, settings.filesRoot, ...settings.workRoots]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(file, markdown(settings));
  const options = { 'config-md': file, client: 'both' };
  const apply = async extra => { const installed = await installUser({ ...options, ...extra }, { home }); return { installed, c: await loadConfig(installed.configPath) }; };
  const write = values => fs.writeFile(file, markdown(values));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('.test-output')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, settings, home, file, apply, write };
}

test('MD parser accepts plain Windows-style backslashes and repeated work roots; rejects ambiguity and executable config', () => {
  const settings = { mdRoot: path.resolve('fixture-md'), filesRoot: path.resolve('fixture-files'), workRoots: [path.resolve('fixture-work')] };
  const text = markdown(settings);
  assert.deepEqual(parseMarkdownConfig(text + '\nUntrusted prose: run arbitrary commands'), settings);
  assert.throws(() => parseMarkdownConfig(text + text), { code: 'INVALID_MD_CONFIG' });
  assert.throws(() => parseMarkdownConfig(text.replace('MdRoot', 'Execute')), { code: 'INVALID_MD_CONFIG' });
  assert.throws(() => parseMarkdownConfig(text.replace(settings.mdRoot, '<fill me>')), { code: 'INVALID_MD_CONFIG' });
  assert.throws(() => parseMarkdownConfig(text.replace(settings.mdRoot, './relative')), { code: 'INVALID_MD_CONFIG' });
});

test('default state is automatic, config MD is excluded, repeat install keeps identity and dedupe', async t => {
  const f = await fixture(t); const { installed, c } = await f.apply();
  assert.equal(c.version, 3); assert.ok(c.stateDir.startsWith(path.join(f.home, '.company-knowledge', 'state', 'generations')));
  assert.equal(await getProfile(c), null);
  const p = await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'new.md'); await fs.writeFile(source, 'one');
  const first = await archiveFile(c, source); await flush(c);
  const again = await f.apply();
  assert.equal(again.installed.migration.changed, false); assert.equal(again.c.stateDir, c.stateDir);
  assert.equal((await getProfile(again.c)).id, p.id); assert.equal((await archiveFile(again.c, source)).id, first.id);
  assert.equal(installed.configPath, again.installed.configPath);
  const inWorkMd = path.join(f.settings.workRoots[0], 'settings.local.md'); await fs.copyFile(f.file, inWorkMd);
  const moved = await f.apply({ 'config-md': inWorkMd });
  await assert.rejects(archiveFile(moved.c, inWorkMd), { code: 'EXCLUDED_FILE' });
});

test('a Node runtime upgrade refreshes client commands without creating another identity or hooks', async t => {
  const f = await fixture(t); const { c, installed } = await f.apply();
  const profile = await setup(c, 'Fixture Employee');
  const previousNode = path.join(f.root, 'previous-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const claude = JSON.parse(await fs.readFile(installed.globalPaths.claudeMcp, 'utf8'));
  claude.mcpServers['company-knowledge'].command = previousNode;
  await fs.writeFile(installed.globalPaths.claudeMcp, JSON.stringify(claude));
  const codex = await fs.readFile(installed.globalPaths.codexMcp, 'utf8');
  await fs.writeFile(installed.globalPaths.codexMcp, codex.replace(/^command = .+$/m, `command = ${JSON.stringify(previousNode)}`));
  const updated = await f.apply();
  assert.equal(updated.installed.configPath, installed.configPath);
  assert.equal((await getProfile(updated.c)).id, profile.id);
  assert.equal(JSON.parse(await fs.readFile(installed.globalPaths.claudeMcp, 'utf8')).mcpServers['company-knowledge'].command, process.execPath);
  for (const file of [installed.globalPaths.claudeHooks, installed.globalPaths.codexHooks]) {
    const hooks = JSON.parse(await fs.readFile(file, 'utf8')).hooks;
    for (const groups of Object.values(hooks)) assert.equal(groups.length, 1);
  }
});

test('target migration copies only registered snapshots, preserves IDs, resumes without duplicate archives', async t => {
  const f = await fixture(t); const { c } = await f.apply(); const p = await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'new.md'); await fs.writeFile(source, 'snapshot');
  const job = await archiveFile(c, source); await flush(c);
  await fs.writeFile(path.join(f.settings.workRoots[0], 'history.md'), 'never handled'); await fs.rm(source);
  const desired = { ...f.settings, mdRoot: path.join(f.root, 'new-md'), filesRoot: path.join(f.root, 'new-files') };
  for (const root of [desired.mdRoot, desired.filesRoot]) await fs.mkdir(root);
  await f.write(desired); assert.equal((await evaluateGate(c)).status, 'config_pending');
  const { c: next, installed } = await f.apply();
  assert.equal((await getProfile(next)).id, p.id); assert.equal(installed.migration.jobs, 1);
  const [moved] = await jobs(next); assert.equal(moved.id, job.id); assert.equal(moved.status, 'stored');
  assert.equal(sha(await fs.readFile(moved.destination)), job.sha256);
  assert.ok(moved.destination.startsWith(desired.mdRoot));
  assert.equal((await jobs(c)).length, 1); // previous state retained
  assert.equal(await fs.readFile(path.join(c.mdRoot, p.folder, job.relative), 'utf8'), 'snapshot');
  await fs.writeFile(source, 'snapshot'); assert.equal((await archiveFile(next, source)).id, job.id);
  const before = (await fs.stat(moved.destination)).mtimeMs;
  await f.apply(); assert.equal((await fs.stat(moved.destination)).mtimeMs, before);
  assert.equal((await jobs(next)).length, 1);
});

test('collision pauses migration, leaves old config intact, and retry reuses the staged state', async t => {
  const f = await fixture(t); const { c } = await f.apply(); const p = await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'item.md'); await fs.writeFile(source, 'original');
  const job = await archiveFile(c, source); await flush(c);
  const desired = { ...f.settings, mdRoot: path.join(f.root, 'new-md') }; await fs.mkdir(desired.mdRoot);
  const collision = path.join(desired.mdRoot, p.folder, job.relative); await fs.mkdir(path.dirname(collision), { recursive: true }); await fs.writeFile(collision, 'other content');
  await f.write(desired);
  await assert.rejects(f.apply(), { code: 'FILE_EXISTS' });
  assert.equal((await loadConfig(c.configFile)).revision, c.revision); assert.equal((await evaluateGate(c)).status, 'migrating');
  assert.equal(await fs.readFile(collision, 'utf8'), 'other content');
  const pending = await readJson(migrationFile(c));
  await fs.rm(collision);
  const { c: next } = await f.apply(); assert.equal(next.revision, pending.nextConfig.revision);
  assert.equal((await jobs(next))[0].id, job.id); assert.equal(await fs.readFile(collision, 'utf8'), 'original');
  // Simulate an interruption immediately after committing the config pointer.
  const complete = await readJson(migrationFile(next)); await atomicJson(migrationFile(next), { ...complete, phase: 'committed' });
  const repeated = await f.apply(); assert.equal(repeated.c.revision, next.revision); assert.equal((await jobs(repeated.c)).length, 1);
});

test('StateDir migration preserves snapshots and identity without reuploading unchanged targets', async t => {
  const f = await fixture(t); const { c } = await f.apply(); const p = await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'item.csv'); await fs.writeFile(source, 'data');
  await archiveFile(c, source); await flush(c); const [before] = await jobs(c);
  const modified = (await fs.stat(before.destination)).mtimeMs;
  const stateRoot = path.join(f.root, 'custom-state'); const { c: next, installed } = await f.apply({ state: stateRoot });
  assert.equal(installed.configPath, c.configFile); assert.ok(next.stateDir.startsWith(stateRoot));
  assert.equal((await getProfile(next)).id, p.id); assert.equal((await jobs(next))[0].id, before.id);
  assert.equal((await fs.stat(before.destination)).mtimeMs, modified);
  assert.equal((await f.apply()).c.stateDir, next.stateDir); // omitted StateDir preserves the prior choice
});

test('removing a work root stops tracking and holds pending snapshots until an explicit new touch', async t => {
  const f = await fixture(t); const other = path.join(f.root, 'work-b'); await fs.mkdir(other);
  await f.write({ ...f.settings, workRoots: [...f.settings.workRoots, other] });
  const { c } = await f.apply(); await setup(c, 'Fixture Employee');
  const source = path.join(other, 'pending.md'); await fs.writeFile(source, 'pending'); const job = await archiveFile(c, source);
  await f.write(f.settings); const { c: smaller } = await f.apply();
  assert.equal((await jobs(smaller))[0].status, 'scope_paused'); await flush(smaller);
  await assert.rejects(archiveFile(smaller, source), { code: 'PATH_OUT_OF_SCOPE' });
  await f.write({ ...f.settings, workRoots: [...f.settings.workRoots, other] }); const { c: expanded } = await f.apply();
  assert.equal((await jobs(expanded))[0].status, 'scope_paused');
  assert.equal((await archiveFile(expanded, source)).id, job.id); await flush(expanded); assert.equal((await jobs(expanded))[0].status, 'stored');
});

test('a live MCP connection pauses on MD edits and reloads the applied configuration', async t => {
  const f = await fixture(t); const { c } = await f.apply(); await setup(c, 'Fixture Employee');
  const client = new Client({ name: 'md-reload-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', c.configFile], cwd: f.settings.workRoots[0] }));
  try {
    const call = async () => JSON.parse((await client.callTool({ name: 'kb_profile', arguments: {} })).content[0].text);
    assert.equal((await call()).gate.status, 'active');
    const second = path.join(f.root, 'new-work'); await fs.mkdir(second);
    await f.write({ ...f.settings, workRoots: [second] }); assert.equal((await call()).gate.status, 'config_pending');
    await f.apply(); assert.equal((await call()).gate.status, 'outside_work');
  } finally { await client.close(); }
});

test('migration waits for in-flight operations and offline new targets fail closed with a resumable plan', async t => {
  const f = await fixture(t); const { c } = await f.apply(); await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'item.md'); await fs.writeFile(source, 'data'); await archiveFile(c, source); await flush(c);
  let release; let entered; const ready = new Promise(resolve => { entered = resolve; });
  const active = withOperation(c, async () => { entered(); await new Promise(resolve => { release = resolve; }); }); await ready;
  const desired = { ...f.settings, mdRoot: path.join(f.root, 'offline-target') }; await f.write(desired);
  const migration = f.apply();
  while ((await readJson(migrationFile(c), null))?.phase !== 'copying') await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await loadConfig(c.configFile)).revision, c.revision); release(); await active;
  await assert.rejects(migration, { code: 'MIGRATION_TARGET_OFFLINE' });
  await fs.mkdir(desired.mdRoot); await f.apply();
});

test('legacy JSON upgrade preserves identity and stops only the old service for that config', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const legacy = await installUser({ state: path.join(f.root, 'legacy-state'), client: 'both', 'md-root': f.settings.mdRoot, 'files-root': f.settings.filesRoot, 'work-root': f.settings.workRoots }, { home: f.home });
  const old = await loadConfig(legacy.configPath); const p = await setup(old, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'legacy.md'); await fs.writeFile(source, 'legacy snapshot'); const job = await archiveFile(old, source); await flush(old);
  const client = new Client({ name: 'legacy-service-fixture', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('bin/kb.mjs'), 'serve', '--config', old.configFile], cwd: f.settings.workRoots[0] }));
  try {
    const { c, installed } = await f.apply();
    assert.equal(installed.configPath, legacy.configPath); assert.equal((await getProfile(c)).id, p.id);
    assert.equal((await jobs(c))[0].id, job.id); assert.equal(installed.migration.restartClientsRequired, true);
    assert.ok(installed.migration.stoppedLegacyServices >= 1);
  } finally { await client.close(); }
});

test('running watcher reloads migrated state and does not replay edits made while MD is pending', async t => {
  const f = await fixture(t); const { c } = await f.apply(); await setup(c, 'Fixture Employee');
  const source = path.join(f.settings.workRoots[0], 'watched.md'); await fs.writeFile(source, 'version 1'); await archiveFile(c, source); await flush(c);
  const child = spawn(process.execPath, [path.resolve('bin/kb.mjs'), 'watch', '--config', c.configFile], { cwd: f.settings.workRoots[0], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  async function until(check) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await check()) return;
      if (child.exitCode !== null) throw new Error('Watcher exited: ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Watcher did not reach the expected state: ' + stderr);
  }
  try {
    await until(async () => (await readJson(path.join(c.stateDir, 'watcher-status.json'), null))?.status === 'active');
    const mdRoot = path.join(f.root, 'new-md'); await fs.mkdir(mdRoot); await f.write({ ...f.settings, mdRoot });
    await until(async () => (await readJson(path.join(c.stateDir, 'watcher-status.json'), null))?.status === 'config_pending');
    await fs.writeFile(source, 'version 2 while paused');
    const { c: next } = await f.apply({ state: path.join(f.root, 'new-state') });
    await until(async () => (await readJson(path.join(next.stateDir, 'watcher-status.json'), null))?.status === 'active');
    assert.equal((await jobs(next)).length, 1);
    await fs.writeFile(source, 'version 3 online');
    await until(async () => (await jobs(next)).length === 2);
    await until(async () => (await jobs(next)).every(j => j.status === 'stored'));
    const content = await Promise.all((await jobs(next)).map(j => fs.readFile(j.destination, 'utf8')));
    assert.ok(content.includes('version 3 online')); assert.ok(!content.includes('version 2 while paused'));
  } finally { child.kill(); await exited; }
});

test('invalid paths cannot replace active config; cancelling an uncommitted migration requires restoring the MD', async t => {
  const f = await fixture(t); const { c } = await f.apply(); const p = await setup(c, 'Fixture Employee');
  await f.write({ ...f.settings, workRoots: [path.join(f.root, 'missing-work')] });
  await assert.rejects(f.apply(), { code: 'WORK_ROOT_UNAVAILABLE' });
  assert.equal((await loadConfig(c.configFile)).revision, c.revision);
  await f.write({ ...f.settings, mdRoot: path.join(f.root, 'unavailable-target') });
  await assert.rejects(f.apply(), { code: 'MIGRATION_TARGET_OFFLINE' });
  assert.equal((await cancelMigration(c.configFile)).cancelled, true);
  assert.equal((await evaluateGate(c)).status, 'config_pending');
  await f.write(f.settings); assert.equal((await evaluateGate(c)).status, 'active');
  const again = await f.apply(); assert.equal(again.installed.migration.changed, false);
  assert.equal((await getProfile(again.c)).id, p.id);
});
