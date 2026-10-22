import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = path.resolve('.test-output', 'installation-' + randomUUID());
const work = path.join(root, 'work 中文 space');
const state = path.join(root, 'state');
const home = path.join(root, 'isolated-clients');
const md = path.join(root, 'md'), files = path.join(root, 'files');
const config = path.join(home, '.company-knowledge', 'config.json');
const settingsFile = path.join(root, 'company-knowledge.local.md');
const makeMd = mdRoot => '# Local settings\n<!-- company-knowledge-config:v1 -->\n| 项目 | 路径 |\n| --- | --- |\n' + [['MdRoot', mdRoot], ['FilesRoot', files], ['WorkRoot', work]].map(([key,value]) => '| '+key+' | `'+value+'` |').join('\n') + '\n<!-- /company-knowledge-config -->\n';
const schedule = process.env.KB_TEST_SCHEDULE === '1';
const q = s => "'" + s.replaceAll("'", "''") + "'";
const read = async file => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
for (const directory of [work, md, files]) await fs.mkdir(directory, { recursive: true });
try {
  await fs.writeFile(settingsFile, makeMd(md));
  const command = [path.resolve('scripts/Install-OneClick.ps1'), '-ConfigFile', settingsFile, '-Clients', 'both', '-ClientHome', home, ...(!schedule ? ['-SkipTask'] : [])];
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ...command], { timeout: 60000, windowsHide: true });
  const first = await read(config);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ...command], { timeout: 60000, windowsHide: true });
  assert.equal((await read(config)).enabledAt, first.enabledAt);
  assert.equal(first.mdRoot, md); assert.equal(first.filesRoot, files); assert.deepEqual(first.workRoots, [work]);
  await assert.rejects(fs.access(path.join(first.stateDir, 'profile.json')), { code: 'ENOENT' });
  for (const client of ['claude', 'codex']) {
    const file = client === 'claude' ? path.join(home, '.claude/settings.json') : path.join(home, '.codex/hooks.json');
    const hooks = (await read(file)).hooks;
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) assert.equal(hooks[event].length, 1);
  }
  assert.deepEqual(await fs.readdir(md), []); assert.deepEqual(await fs.readdir(files), []);
  const newMd = path.join(root, 'new-md'); await fs.mkdir(newMd);
  await fs.writeFile(settingsFile, makeMd(newMd));
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ...command, '-StateDir', state], { timeout: 60000, windowsHide: true });
  const migrated = await read(config);
  assert.equal(migrated.stateRoot, state); assert.equal(migrated.mdRoot, newMd);
  assert.notEqual(migrated.revision, first.revision);
  await assert.rejects(fs.access(path.join(migrated.stateDir, 'profile.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(newMd), []);
  if (schedule) {
    const status = await read(path.join(migrated.stateDir, 'watcher-status.json'));
    assert.equal(status.status, 'awaiting_name');
    const info = await read(path.join(migrated.stateDir, 'schedule.json'));
    const task = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `(Get-ScheduledTask -TaskName ${q(info.TaskName)}).State`], { windowsHide: true });
    assert.match(task.stdout, /Running/);
  }
  console.log(JSON.stringify({ passed: true, repeatedInstall: true, isolatedClientConfig: true, employeeNotPrefilled: true, markdownMigration: true, optionalStateDir: true, scheduledWatcher: schedule, targetArtifacts: 0 }));
} finally {
  if (schedule && await fs.access(config).then(()=>true,()=>false)) {
    await run('powershell.exe', ['-NoProfile','-NonInteractive','-File',path.resolve('scripts/Register-ArchiveTask.ps1'),'-ConfigPath',config,'-Remove'], { windowsHide: true }).catch(()=>{});
    // Windows can keep the child alive after stopping its scheduled wrapper.
    const match = config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match ${q(match)} -and $_.CommandLine -match ' watch --config ' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
  }
  assert.equal(path.dirname(root), path.resolve('.test-output'));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
