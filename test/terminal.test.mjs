import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archiveFile, flush, jobs, setup } from '../src/storage.mjs';
import { collectTerminal, finishTerminal, prepareTerminal } from '../src/terminal.mjs';
import { shellQuote } from '../src/runtime-command.mjs';

const run = promisify(execFile);
const psQuote = s => "'" + s.replaceAll("'", "''") + "'";
const windows = process.platform === 'win32';
const invoke = s => windows ? `& ${psQuote(s)}` : shellQuote(s);
const shell = command => windows ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['/bin/bash', ['-c', command]];
const python = process.env.KB_TEST_PYTHON || (windows ? 'python' : 'python3');
async function fixture(t) {
  const root = path.resolve(`.demo-terminal-unit-${randomUUID()} 中文`);
  const c = { scope: 'user', captureMode: 'new-events-only', enabledAt: new Date().toISOString(), terminalCapture: { enabled: true }, stateDir: path.join(root, 'state'), mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), workRoots: [path.join(root, 'work')], maxBytes: 1048576 };
  for (const p of [c.mdRoot, c.filesRoot, ...c.workRoots]) await fs.mkdir(p, { recursive: true });
  await setup(c, '终端测试员');
  t.after(async () => { assert.equal(path.dirname(root), process.cwd()); assert.ok(path.basename(root).startsWith('.demo-terminal-unit-')); await fs.rm(root, { recursive: true, force: true }); });
  const cwd = c.workRoots[0];
  const e = { client: 'codex', cwd, session_id: randomUUID(), tool_use_id: randomUUID(), tool_name: 'Bash', hook_event_name: 'PreToolUse' };
  return { root, c, cwd, e };
}
async function execute(c, e, command, during) {
  e = { ...e, tool_input: { command, timeout: 20000 } };
  const pre = await prepareTerminal(c, e, { turnId: 'test-turn' });
  assert.equal(pre.hookSpecificOutput.permissionDecision, e.client === 'codex' ? 'allow' : undefined);
  assert.ok(pre.hookSpecificOutput.updatedInput.command.endsWith(command));
  assert.equal(pre.hookSpecificOutput.updatedInput.timeout, 20000);
  const running = run(...shell(pre.hookSpecificOutput.updatedInput.command), { cwd: e.cwd, timeout: 20000, windowsHide: true });
  if (during) await during();
  let result;
  try { result = await running; } catch (error) { result = { ...error, exitCode: error.code }; }
  return { e, result, finish: () => finishTerminal(c, { ...e, hook_event_name: 'PostToolUse', tool_response: { exit_code: result.exitCode || 0 } }) };
}
test('Node writes, child processes, promises and atomic rename are captured; unrelated activity and history are excluded', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'existing.md'), 'before');
  await fs.writeFile(path.join(cwd, 'unrelated.md'), 'untouched');
  await fs.writeFile(path.join(cwd, 'generate.cjs'), `const fs=require('node:fs'); const {spawnSync}=require('node:child_process');
fs.readFileSync('unrelated.md'); fs.writeFileSync('existing.md','after');
fs.writeFileSync('draft.tmp','final'); fs.renameSync('draft.tmp','final.md');
spawnSync(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('child.csv','a,b');fs.writeFileSync('existing.md','after')"],{stdio:'inherit'});
setTimeout(async()=>{await fs.promises.writeFile('async.json','{}')},300);`);
  const execution = await execute(c, e, `${invoke(process.execPath)} generate.cjs`, async () => { await new Promise(r => setTimeout(r, 150)); await fs.writeFile(path.join(cwd, 'unrelated.md'), 'external writer'); });
  assert.equal(execution.result.exitCode, undefined, execution.result.stderr);
  const result = await execution.finish(); assert.equal(result.status, 'captured', JSON.stringify(result));
  await flush(c);
  const all = await jobs(c);
  assert.deepEqual(all.map(j => path.basename(j.metadata.source)).sort(), ['async.json', 'child.csv', 'existing.md', 'final.md']);
  assert.ok(all.every(j => j.status === 'stored'));
});
test('Python pathlib, binary writes and os.replace are observed without scanning old files', async t => {
  await run(python, ['--version'], { windowsHide: true });
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'history.md'), 'never upload');
  await fs.writeFile(path.join(cwd, 'generate.py'), `from pathlib import Path\nimport os, zipfile\nPath('note.md').write_text('中文内容',encoding='utf-8')\nwith open('data.csv','w',encoding='utf-8') as f:\n    f.write('name,value\\na,1')\nwith open('binary.tmp','wb') as f:\n    f.write(b'bytes')\nos.replace('binary.tmp','binary.bin')\nwith zipfile.ZipFile('bundle.zip', 'w') as z:\n    z.writestr('data.txt', 'payload')\n`);
  const execution = await execute(c, e, `${invoke(python)} generate.py`);
  assert.equal(execution.result.exitCode, undefined, execution.result.stderr);
  const result = await execution.finish(); assert.equal(result.status, 'captured', JSON.stringify(result));
  const all = await jobs(c);
  assert.deepEqual(all.map(j => path.basename(j.metadata.source)).sort(), ['binary.bin', 'bundle.zip', 'data.csv', 'note.md']);
});
test('PowerShell variable paths, pipelines and Export-Csv automatically identify only actual output files', { skip: !windows }, async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'history.md'), 'unchanged');
  const execution = await execute(c, e, "$out = 'result.md'\nSet-Content -LiteralPath $out -Value 'report' -Encoding UTF8\n[pscustomobject]@{name='a';value=1} | Export-Csv -LiteralPath 'table.csv' -NoTypeInformation\n'log' | Out-File -LiteralPath 'message.txt'");
  assert.equal(execution.result.exitCode, undefined, execution.result.stderr);
  const result = await execution.finish(); assert.equal(result.status, 'captured', JSON.stringify(result));
  assert.deepEqual((await jobs(c)).map(j => path.basename(j.metadata.source)).sort(), ['message.txt', 'result.md', 'table.csv']);
});
test('readonly execution uploads nothing and unchanged rewrites are not duplicated', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'same.md'), 'same');
  await fs.writeFile(path.join(cwd, 'read.cjs'), "const fs=require('node:fs');fs.readFileSync('same.md');fs.writeFileSync('same.md','same');");
  const execution = await execute(c, e, `${invoke(process.execPath)} read.cjs`);
  const result = await execution.finish(); assert.equal(result.status, 'no_observed_changes'); assert.equal((await jobs(c)).length, 0);
});
test('failure and post-command external replacement are not published as valid terminal artifacts', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'fail.cjs'), "require('node:fs').writeFileSync('partial.md','partial'); process.exit(2);");
  const failed = await execute(c, e, `${invoke(process.execPath)} fail.cjs`);
  assert.equal((await failed.finish()).status, 'failed'); assert.equal((await jobs(c)).length, 0);
  await fs.writeFile(path.join(cwd, 'ok.cjs'), "require('node:fs').writeFileSync('result.md','producer content');");
  const successful = await execute(c, { ...e, tool_use_id: randomUUID() }, `${invoke(process.execPath)} ok.cjs`);
  await fs.writeFile(path.join(cwd, 'result.md'), 'unrelated later content');
  const result = await successful.finish(); assert.equal(result.status, 'needs_attention');
  assert.equal(result.files[0].error, 'SOURCE_CHANGED_AFTER_TRACE');
  await collectTerminal(c); assert.equal((await jobs(c)).length, 0);
});
test('terminal snapshots survive an unavailable target and deletion of the generated source', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'generate.cjs'), "require('node:fs').writeFileSync('offline.csv','name,value');");
  const execution = await execute(c, e, `${invoke(process.execPath)} generate.cjs`);
  assert.equal((await execution.finish()).status, 'captured');
  await fs.rename(c.filesRoot, c.filesRoot + '-offline');
  await assert.rejects(flush(c), { code: 'WORK_PAUSED' });
  await fs.rm(path.join(cwd, 'offline.csv'));
  await fs.rename(c.filesRoot + '-offline', c.filesRoot);
  const uploaded = (await flush(c, { force: true }))[0];
  assert.equal(uploaded.status, 'stored'); assert.equal(await fs.readFile(uploaded.destination, 'utf8'), 'name,value');
});
test('unsupported native writes do not trigger a directory-diff fallback', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'history.md'), 'history');
  const execution = await execute(c, e, windows ? "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'native.md'), 'unobserved native API')" : "printf '%s' 'unobserved native API' > native.md");
  const result = await execution.finish();
  assert.equal(result.status, 'no_observed_changes'); assert.equal((await jobs(c)).length, 0);
  assert.equal(await fs.readFile(path.join(cwd, 'native.md'), 'utf8'), 'unobserved native API');
});
test('plan mode and explicit escalation requests keep the original permission flow', async t => {
  const { c, e } = await fixture(t);
  for (const extra of [{ permission_mode: 'plan', tool_input: { command: 'node generate.cjs' } }, { tool_input: { command: 'node generate.cjs', sandbox_permissions: 'require_escalated' } }]) {
    const result = await prepareTerminal(c, { ...e, ...extra }, { turnId: 'test' });
    assert.equal(result.hookSpecificOutput.updatedInput, undefined);
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
  }
});
test('a different writer changing the same file while the script is still alive is not adopted', async t => {
  const { c, cwd, e } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'node-delay.cjs'), "require('node:fs').writeFileSync('node-target.md','producer');setTimeout(()=>{},700);");
  await fs.writeFile(path.join(cwd, 'python-delay.py'), "import time\nwith open('python-target.md','w') as f:\n    f.write('producer')\ntime.sleep(0.7)\n");
  for (const [name, command] of [
    ['node-target.md', `${invoke(process.execPath)} node-delay.cjs`],
    ['python-target.md', `${invoke(python)} python-delay.py`],
    ...(windows ? [['ps-target.md', "Set-Content -LiteralPath ps-target.md -Value 'producer' -NoNewline; Start-Sleep -Milliseconds 700"]] : [])
  ]) {
    const target = path.join(cwd, name);
    const executed = await execute(c, { ...e, tool_use_id: randomUUID() }, command, async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await fs.readFile(target, 'utf8').catch(() => '')) === 'producer') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await new Promise(resolve => setTimeout(resolve, 80));
      await fs.writeFile(target, 'external content');
    });
    const result = await executed.finish();
    assert.equal(result.status, 'needs_attention', name + ': ' + JSON.stringify(result));
    assert.equal(result.files[0].error, 'SOURCE_CHANGED_AFTER_TRACE');
  }
  assert.equal((await jobs(c)).length, 0);
});
test('an early terminal response waits for the PowerShell process before taking its final output', { skip: !windows }, async t => {
  const { c, cwd, e } = await fixture(t);
  const command = "Set-Content -LiteralPath delayed.md -Value 'partial' -NoNewline; Start-Sleep -Milliseconds 700; Set-Content -LiteralPath delayed.md -Value 'final' -NoNewline";
  const pre = await prepareTerminal(c, { ...e, tool_input: { command } }, { turnId: 'early-response' });
  const running = run('powershell.exe', ['-NoProfile', '-Command', pre.hookSpecificOutput.updatedInput.command], { cwd, windowsHide: true });
  const file = path.join(cwd, 'delayed.md'); const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !await fs.access(file).then(() => true, () => false)) await new Promise(r => setTimeout(r, 20));
  const early = await finishTerminal(c, { ...e, hook_event_name: 'PostToolUse', tool_response: {} });
  assert.equal(early.status, 'waiting_for_runtime'); assert.equal((await jobs(c)).length, 0);
  await running;
  await collectTerminal(c); await flush(c);
  const [job] = await jobs(c); assert.equal(job.status, 'stored');
  assert.equal(await fs.readFile(job.destination, 'utf8'), 'final');
});
