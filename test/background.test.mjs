import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { archiveFile, setup, readJson } from '../src/storage.mjs';
import { background } from '../src/background.mjs';

async function fixture(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'knowledge-background-'));
  const c = { mdRoot: path.join(root, 'md'), filesRoot: path.join(root, 'files'), stateDir: path.join(root, 'state'), workRoots: [path.join(root, 'work')], maxBytes: 1024 * 1024 };
  for (const p of [c.mdRoot, c.filesRoot, ...c.workRoots]) await fs.mkdir(p);
  t.after(async () => { assert.equal(path.dirname(root), tempRoot); assert.ok(path.basename(root).startsWith('knowledge-background-')); await fs.rm(root, { recursive: true, force: true }); });
  return c;
}
test('background task before onboarding records awaiting_name without creating employee folders', async t => {
  const c = await fixture(t); const { report, exitCode } = await background(c);
  assert.equal(report.status, 'awaiting_name'); assert.equal(exitCode, 0);
  assert.deepEqual(await fs.readdir(c.mdRoot), []);
  assert.equal((await readJson(path.join(c.stateDir, 'last-background-run.json'))).status, 'awaiting_name');
});
test('background task completes a durable upload and reports failures honestly', async t => {
  const c = await fixture(t); await setup(c, '员工A');
  const p = path.join(c.workRoots[0], '文件.txt'); await fs.writeFile(p, 'queued'); await archiveFile(c, p);
  const disconnected = c.filesRoot + '-offline'; await fs.rename(c.filesRoot, disconnected);
  const failed = await background(c); assert.equal(failed.exitCode, 0); assert.equal(failed.report.status, 'offline');
  await fs.rename(disconnected, c.filesRoot);
  // Both pre-disconnection snapshots and newly touched versions can flush online.
  await fs.writeFile(p, 'new version'); await archiveFile(c, p);
  const next = await background(c); assert.equal(next.report.counts.stored, 2); assert.equal(next.report.counts.retry_pending, undefined);
  assert.equal(next.report.status, 'ok');
});
