import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, setup, jobs, getProfile } from '../src/storage.mjs';
import { macosService } from '../src/macos-service.mjs';
const run = promisify(execFile);

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: true, reason: '需要 macOS 真机；此结果不代表验证通过。' }));
} else {
  const root = path.resolve('.test-output', 'macos-installation-' + randomUUID());
  const home = path.join(root, "isolated employee's home");
  const work = path.join(root, 'work 中文 space'), md = path.join(root, 'md'), files = path.join(root, 'files');
  const config = path.join(home, '.company-knowledge', 'config.json');
  const settings = path.join(root, 'settings.local.md');
  const fixtureBin = path.join(root, 'client-stubs');
  const service = process.env.KB_TEST_SCHEDULE === '1';
  let serviceAttempted = false;
  for (const dir of [work, md, files, fixtureBin]) await fs.mkdir(dir, { recursive: true });
  // Only exercise CLI detection/registration; no real model account is needed.
  for (const name of ['claude', 'codex']) await fs.writeFile(path.join(fixtureBin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { ...process.env, PATH: fixtureBin + path.delimiter + process.env.PATH };
  const command = [path.resolve('scripts/install-macos.sh'), '--config-file', settings, '--client-home', home, '--skip-service'];
  const makeMd = mdRoot => '<!-- company-knowledge-config:v1 -->\n| 项目 | 路径 |\n| --- | --- |\n' + [['MdRoot', mdRoot], ['FilesRoot', files], ['WorkRoot', work]].map(([key, value]) => `| ${key} | \`${value}\` |`).join('\n') + '\n<!-- /company-knowledge-config -->\n';
  const hooks = async client => JSON.parse(await fs.readFile(path.join(home, client === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'), 'utf8')).hooks;
  const hook = async (client, event) => {
    const cmd = (await hooks(client))[event.hook_event_name][0].hooks[0].command;
    return JSON.parse(execFileSync('/bin/bash', ['-c', cmd], { input: JSON.stringify({ ...event, cwd: work }), cwd: work, encoding: 'utf8', timeout: 30000, env: { ...env, PATH: '/usr/bin:/bin' } }));
  };
  try {
    await fs.writeFile(settings, makeMd(md));
    await fs.writeFile(path.join(work, 'history.md'), 'do not upload');
    for (let n = 0; n < 2; n++) await run('/bin/bash', command, { env, timeout: 60000 });
    let c = await loadConfig(config);
    assert.equal(await getProfile(c), null);
    assert.deepEqual(await fs.readdir(md), []);
    for (const client of ['claude', 'codex']) {
      for (const group of Object.values(await hooks(client))) assert.equal(group.length, 1);
      assert.match((await hook(client, { hook_event_name: 'SessionStart', session_id: client })).systemMessage, /姓名/);
    }
    const p = await setup(c, 'Fixture Employee');
    const source = path.join(work, 'fresh.md'); await fs.writeFile(source, 'version one');
    for (const client of ['claude', 'codex']) {
      await hook(client, { hook_event_name: 'UserPromptSubmit', session_id: client, prompt: 'Read the new work file.' });
      await hook(client, { hook_event_name: 'PostToolUse', session_id: client, tool_name: 'Read', tool_input: { file_path: source } });
    }
    assert.equal((await jobs(c)).length, 1); assert.equal((await jobs(c))[0].status, 'stored');
    const newMd = path.join(root, 'new-md'), state = path.join(root, 'custom-state'); await fs.mkdir(newMd);
    await fs.writeFile(settings, makeMd(newMd));
    await run('/bin/bash', [...command, '--state-dir', state], { env, timeout: 60000 });
    c = await loadConfig(config);
    assert.equal((await getProfile(c)).id, p.id); assert.equal(c.stateRoot, state);
    assert.equal((await jobs(c)).length, 1); assert.ok((await jobs(c))[0].destination.startsWith(newMd));
    const beforeDesktop = await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8');
    await run('/bin/bash', [...command, '--clients', 'doubao'], { env, timeout: 60000 });
    const desktop = JSON.parse(await fs.readFile(path.join(home, '.company-knowledge/doubao-stdio.json'), 'utf8'));
    assert.ok(desktop.mcpServers['company-knowledge'].args.includes(config));
    assert.ok(desktop.mcpServers['company-knowledge'].args.includes('doubao'));
    assert.equal(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8'), beforeDesktop);
    if (service) {
      serviceAttempted = true;
      await macosService(config); await macosService(config);
      await fs.writeFile(source, 'version two');
      const deadline = Date.now() + 15000;
      while ((await jobs(c)).length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal((await jobs(c)).length, 2);
    }
    console.log(JSON.stringify({ passed: true, nativeMacInstaller: true, isolatedClientRegistration: true, realHookProcesses: true, restrictedPathHooks: true, sharedIdentity: true, deduplicated: true, historicalFilesIgnored: true, markdownMigration: true, doubaoStdioExport: true, launchAgent: service, realModelConversation: false, realNas: false }));
  } finally {
    // Do not remove files beneath a still-running service if cleanup fails.
    if (serviceAttempted) await macosService(config, { remove: true });
    assert.equal(path.dirname(root), path.resolve('.test-output'));
    assert.ok(path.basename(root).startsWith('macos-installation-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}
