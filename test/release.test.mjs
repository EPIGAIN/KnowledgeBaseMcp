import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkRelease } from '../scripts/check-release.mjs';

async function fixture(t) {
  const root = path.resolve('.test-output', 'release-test-' + randomUUID());
  await fs.mkdir(root, { recursive: true });
  await fs.copyFile('.gitignore', path.join(root, '.gitignore'));
  await fs.writeFile(path.join(root, 'README.md'), '# Public documentation\n');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve('.test-output'));
    assert.ok(path.basename(root).startsWith('release-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const empty = path.join(root, '.test-output', 'empty-hooks'); await fs.mkdir(empty, { recursive: true });
  const git = args => execFileSync('git', ['-c', 'user.name=Audit Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + empty, ...args], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
  });
  const audit = () => checkRelease(root, { extraTerms: [] });
  return { root, git, audit };
}

test('release audit validates first-add candidates without creating a repository or exposing ignored private content', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '.local-private'));
  await fs.writeFile(path.join(f.root, '.local-private', 'employee-install.txt'), f.root);
  await fs.writeFile(path.join(f.root, 'employee.local.md'), 'sk-' + 'a'.repeat(30));
  const result = await f.audit();
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.gitRepositoryPresent, false); assert.equal(result.eligibleFiles, 2);
  await assert.rejects(fs.access(path.join(f.root, '.git')), { code: 'ENOENT' });
});

test('release audit rejects accidentally addable files and missing private ignore rules', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'employee-install.txt'), 'private command');
  let result = await f.audit();
  assert.ok(result.issues.some(i => i.file === 'employee-install.txt' && i.source === 'git'));
  await fs.writeFile(path.join(f.root, '.gitignore'), 'node_modules/\n');
  result = await f.audit();
  assert.ok(result.issues.some(i => i.file === '.local-private/employee-install.txt' && i.issue === 'private pattern is not ignored'));
});

test('release audit checks staged bytes and historical blobs even after the working copy is sanitized', async t => {
  const f = await fixture(t); f.git(['init', '--quiet']);
  const token = 'sk-' + 'b'.repeat(30);
  await fs.writeFile(path.join(f.root, 'README.md'), token);
  f.git(['add', 'README.md', '.gitignore']);
  await fs.writeFile(path.join(f.root, 'README.md'), '# Sanitized\n');
  let result = await f.audit();
  assert.ok(result.issues.some(i => i.source === 'index' && i.issue === 'secret-like token'));
  assert.ok(!JSON.stringify(result).includes(token));
  f.git(['commit', '--quiet', '-m', 'Fixture initial revision']);
  f.git(['add', 'README.md']); f.git(['commit', '--quiet', '-m', 'Fixture clean revision']);
  result = await f.audit();
  assert.equal(result.historicalCommits, 2);
  assert.ok(result.issues.some(i => i.source === 'history' && i.issue === 'secret-like token'));
  assert.ok(!result.issues.some(i => i.source === 'worktree' || i.source === 'index'));
  assert.ok(!JSON.stringify(result).includes(token));
});

test('release audit detects machine paths and force-added private files without echoing their content', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'README.md'), f.root);
  let result = await f.audit();
  assert.ok(result.issues.some(i => i.issue === 'current machine path'));
  assert.ok(!JSON.stringify(result).includes(f.root));
  await fs.writeFile(path.join(f.root, 'README.md'), '# Public\n');
  f.git(['init', '--quiet']);
  await fs.mkdir(path.join(f.root, '.local-private'));
  const name = '.local-private/employee-install.txt';
  await fs.writeFile(path.join(f.root, name), 'private fixture'); f.git(['add', '-f', name]);
  result = await f.audit();
  assert.ok(result.issues.some(i => i.file === name && i.source === 'index'));
  f.git(['commit', '--quiet', '-m', 'Fixture private revision']);
  await fs.rm(path.join(f.root, name)); f.git(['add', '-u']); f.git(['commit', '--quiet', '-m', 'Fixture removal']);
  result = await f.audit();
  assert.ok(result.issues.some(i => i.file === name && i.source === 'history'));
});
