import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { macosService, servicePlan, renderPlist } from '../src/macos-service.mjs';
import { hookCommand, shellQuote } from '../src/runtime-command.mjs';
import { mergeHooks } from '../src/install.mjs';
import { checkMountedTarget } from '../src/mount-check.mjs';
import { atomicJson } from '../src/common.mjs';

async function fixture(t) {
  const root = path.resolve('.test-output', 'macos-' + randomUUID());
  const configFile = path.join(root, 'settings', 'config.json');
  const c = { version: 3, stateDir: path.join(root, 'state'), mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), workRoots: [path.join(root, 'work')], maxBytes: 100000 };
  await atomicJson(configFile, c);
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('.test-output')); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = { platform: 'darwin', uid: 501, home: path.join(root, 'home & space'), sleep: async () => {}, alive: () => false };
  const p = servicePlan(configFile, runtime);
  const calls = []; let loaded = false, bootFail = false, foreign = false;
  runtime.run = async (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith('plutil')) {
      if (args[0] === '-lint') { assert.match(await fs.readFile(args[1], 'utf8'), /<plist/); return { stdout: '' }; }
      return { stdout: JSON.stringify({ Label: p.label, ProgramArguments: foreign ? ['foreign'] : p.args }) };
    }
    assert.equal(command, '/bin/launchctl');
    if (args[0] === 'print') {
      if (!loaded) throw Object.assign(new Error('not found'), { code: 113 });
      return { stdout: `\tpath = ${p.file}\n\tpid = 12345\n` };
    }
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') {
      if (bootFail) throw Object.assign(new Error('bootstrap failed'), { code: 5 });
      loaded = true;
      await atomicJson(path.join(c.stateDir, 'watcher-status.json'), { pid: 12345, checkedAt: new Date().toISOString(), status: 'awaiting_name' });
    }
    return { stdout: '' };
  };
  return { root, c, configFile, runtime, p, calls, setBootFail: () => { bootFail = true; }, setForeign: () => { foreign = true; } };
}

test('POSIX hooks quote the absolute Node path and replace only exact owned commands', () => {
  const node = "/opt/runtime's & space/node", bin = "/opt/repo's/bin/kb.mjs", config = '/data/config.json';
  const command = hookCommand(bin, config, { platform: 'darwin', node });
  assert.ok(command.startsWith(shellQuote(node) + ' '));
  assert.ok(command.includes("'\"'\"'"));
  const old = hookCommand(bin, config, { platform: 'darwin', node: '/old/node' });
  const settings = { hooks: { Stop: [{ hooks: [{ command: old + ' --client claude' }, { command: 'unrelated-hook' }] }] } };
  mergeHooks(settings, command + ' --client claude', [old, old + ' --client claude']);
  mergeHooks(settings, command + ' --client claude', [old, old + ' --client claude']);
  assert.deepEqual(settings.hooks.Stop.flatMap(g => g.hooks.map(h => h.command)), ['unrelated-hook', command + ' --client claude']);
});

test('macOS volume checks reject unmounted leftover directories and permit mounted/local targets', async () => {
  const stat = async p => ({ dev: p === '/Volumes' ? 1 : 2, isDirectory: () => true });
  await checkMountedTarget('/Volumes/Team Share/md', { platform: 'darwin', stat });
  await assert.rejects(checkMountedTarget('/Volumes/Team Share/md', { platform: 'darwin', stat: async () => ({ dev: 1, isDirectory: () => true }) }), { code: 'VOLUME_NOT_MOUNTED' });
  await assert.rejects(checkMountedTarget('/Volumes', { platform: 'darwin', stat }), { code: 'VOLUME_NOT_MOUNTED' });
  await checkMountedTarget('/local/md', { platform: 'darwin', stat: () => { throw new Error('must not inspect mount'); } });
  await assert.rejects(checkMountedTarget('/Volumes/gone/md', { platform: 'darwin', stat: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), { code: 'ENOENT' });
});

test('LaunchAgent adapter installs, repeats without duplicate label, validates status and removes only its job', async t => {
  const f = await fixture(t);
  const first = await macosService(f.configFile, {}, f.runtime);
  assert.equal(first.status, 'awaiting_name');
  const content = await fs.readFile(f.p.file, 'utf8');
  assert.equal(content, renderPlist(f.p));
  assert.match(content, /<key>KeepAlive<\/key><true\/>/);
  const second = await macosService(f.configFile, {}, f.runtime);
  assert.equal(first.label, second.label);
  assert.equal(f.calls.filter(c => c[1] === 'bootout').length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(f.p.file)), [path.basename(f.p.file)]);
  await macosService(f.configFile, { remove: true }, f.runtime);
  await assert.rejects(fs.access(f.p.file), { code: 'ENOENT' });
  await fs.access(f.configFile); // service removal retains identity/config/data
});

test('LaunchAgent refuses foreign plist and restores the prior plist on bootstrap failure', async t => {
  const f = await fixture(t); await macosService(f.configFile, {}, f.runtime);
  const before = await fs.readFile(f.p.file, 'utf8');
  f.setBootFail();
  await assert.rejects(macosService(f.configFile, {}, f.runtime), /bootstrap failed/);
  assert.equal(await fs.readFile(f.p.file, 'utf8'), before);
  const stopped = f.calls.filter(c => c[1] === 'bootout').length;
  f.setForeign();
  await assert.rejects(macosService(f.configFile, { remove: true }, f.runtime), /不属于此配置/);
  assert.equal(f.calls.filter(c => c[1] === 'bootout').length, stopped);
});

test('macOS service CLI adapter refuses other platforms and root execution', async () => {
  await assert.rejects(macosService(path.resolve('config.json'), {}, { platform: 'win32' }), /macOS/);
  await assert.rejects(macosService(path.resolve('config.json'), {}, { platform: 'darwin', uid: 0 }), /sudo/);
});

test('LaunchAgent registration alone is not reported as a healthy worker', async t => {
  const f = await fixture(t), run = f.runtime.run;
  f.runtime.run = async (command, args) => {
    const result = await run(command, args);
    if (args[0] === 'bootstrap') await atomicJson(path.join(f.c.stateDir, 'watcher-status.json'), { pid: 12345, checkedAt: '2000-01-01T00:00:00Z', status: 'active' });
    return result;
  };
  await assert.rejects(macosService(f.configFile, {}, f.runtime), /未收到监听进程的新状态/);
  await fs.access(f.p.file); // keep installed service/config available for diagnosis
});
