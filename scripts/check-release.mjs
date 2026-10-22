import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const folders = ['bin', 'src', 'tracers', 'scripts', 'test', 'docs'];
const top = ['README.md', 'README.en.md', '手动安装说明.md', 'company-knowledge.example.md', '一键安装.cmd', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.npmignore'];
const privatePath = /(?:^|\/)(?:node_modules|workspace|\.local-private|\.test-output|\.kb-local|\.kb-terminal|\.nas-validation|\.claude|\.codex|__pycache__|config-backups|\.demo[^/]*)(?:\/|$)|(?:^|\/)(?:\.DS_Store|Thumbs\.db|Desktop\.ini)$|(?:^|\/)\.env(?:\.|$)|\.local\.md$|\.(?:pyc|log|tgz|backup)$|\.knowledge-backup-|(?:^|\/)\.mcp\.json/;
const runtimePath = /(?:^|\/)(?:profile|installation|global-installation|schedule|watcher-status|cleanup-result|control|gate|macos-service|watcher-instance)\.json$/;
const publicPath = name => !privatePath.test(name) && !runtimePath.test(name) && (top.includes(name) || folders.some(dir => name.startsWith(dir + '/')) && /\.(?:mjs|cjs|ps1|sh|py|md)$/.test(name));
const patterns = [
  ['private network address', /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['personal Windows path', /[A-Za-z]:[\\/]+Users[\\/]+[^<>"'\s]+/i],
  ['personal Unix path', /\/(?:Users|home)\/[^<>"'\s/]+/],
  ['literal network share', /\\\\[A-Za-z0-9_-][A-Za-z0-9_.-]*\\[^<>"'\s\\]+/],
  ['secret-like token', /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential assignment', /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][A-Za-z0-9_+/.=-]{16,}["']/i],
  ['bearer credential', /Bearer\s+[A-Za-z0-9._-]{20,}/i]
];

export async function checkRelease(root = defaultRoot, { extraTerms = (process.env.REDACT_TERMS || '').split('|').filter(Boolean) } = {}) {
  root = path.resolve(root);
  const files = [], issues = [], seenIssues = new Set();
  const issue = (file, category, source = 'worktree') => {
    const value = { file, issue: category, source }, key = JSON.stringify(value);
    if (!seenIssues.has(key)) { seenIssues.add(key); issues.push(value); }
  };
  const localPaths = [root, os.homedir()].flatMap(p => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')]).filter(p => p.length > 3);
  const checkContent = (name, data, source) => {
    if (data.length > 2 * 1024 * 1024) { issue(name, 'file exceeds text audit limit', source); return; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { issue(name, 'non-UTF8 file needs review', source); return; }
    if (text.includes('\0')) { issue(name, 'binary file needs review', source); return; }
    for (const [category, regex] of patterns) if (regex.test(text)) issue(name, category, source);
    if (localPaths.some(p => text.toLowerCase().includes(p.toLowerCase()))) issue(name, 'current machine path', source);
    if (extraTerms.some(term => text.includes(term))) issue(name, 'environment-specific term', source);
  };
  async function walk(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      const name = path.posix.join(dir, entry.name);
      if (privatePath.test(name)) continue;
      if (entry.isSymbolicLink()) { issue(name, 'symlink requires review'); continue; }
      if (entry.isDirectory()) await walk(name);
      else if (publicPath(name)) files.push(name);
      else issue(name, 'file outside public allowlist');
    }
  }
  for (const dir of folders) {
    const info = await fs.lstat(path.join(root, dir)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (info?.isSymbolicLink()) issue(dir, 'symlink requires review');
    else if (info) await walk(dir);
  }
  for (const name of top) {
    const info = await fs.lstat(path.join(root, name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (info?.isSymbolicLink()) issue(name, 'symlink requires review');
    else if (info?.isFile()) files.push(name);
  }
  for (const name of files) checkContent(name, await fs.readFile(path.join(root, name)), 'worktree');

  let gitRepositoryPresent = false, gitHistoryPresent = false, eligibleFiles = 0, indexedBlobs = 0, historicalCommits = 0;
  let temporary, gitArgs = [], gitPhase = 'startup';
  const gitNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNull, GIT_CEILING_DIRECTORIES: path.dirname(root) };
  // Audit this root only; isolated fixtures must not inherit an ancestor's repo.
  // Ignore caller-specific Git directory/index overrides, while retaining PATH.
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
  const git = (args, options = {}) => {
    gitPhase = args[0];
    return execFileSync('git', ['-c', `core.excludesFile=${gitNull}`, ...gitArgs, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...options });
  };
  try {
    git(['--version']);
    let gitRoot;
    try { gitRoot = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch { /* no existing repository */ }
    if (gitRoot && path.relative(root, gitRoot) !== '') throw new Error('unexpected Git worktree root');
    gitRepositoryPresent = Boolean(gitRoot);
    if (!gitRepositoryPresent) {
      const tempRoot = await fs.realpath(os.tmpdir());
      temporary = await fs.mkdtemp(path.join(tempRoot, 'knowledge-release-git-'));
      await fs.mkdir(path.join(temporary, 'empty-template'));
      git(['init', '--bare', '--quiet', '--template=' + path.join(temporary, 'empty-template'), path.join(temporary, 'metadata')]);
      gitArgs = ['--git-dir=' + path.join(temporary, 'metadata'), '--work-tree=' + root];
    }
    const eligible = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    eligibleFiles = new Set(eligible).size;
    for (const name of eligible) if (!publicPath(name)) issue(name, 'Git-add candidate outside public allowlist', 'git');
    const probes = ['.local-private/employee-install.txt', 'company-knowledge.local.md', 'docs/private.local.md', 'workspace/sample.txt', '.test-output/sample.txt', '.kb-local/profile.json', '.kb-terminal/sample.json', '.claude/settings.json', '.codex/config.toml', '.mcp.json', '.env', 'tracers/python/__pycache__/sample.pyc', 'scripts/sample.backup', 'node_modules/sample.js'];
    let ignored = [];
    try { ignored = git(['check-ignore', '--no-index', '--stdin', '-z'], { input: probes.join('\0') + '\0', encoding: 'utf8' }).split('\0').filter(Boolean); }
    catch (error) { if (error.status !== 1) throw error; }
    for (const name of probes) if (!ignored.includes(name)) issue(name, 'private pattern is not ignored', 'git');

    const inspected = new Set();
    const inspectBlob = (oid, name, source) => {
      const key = `${oid}:${source}`;
      if (inspected.has(key)) return;
      inspected.add(key);
      if (Number(git(['cat-file', '-s', oid], { encoding: 'utf8' })) > 2 * 1024 * 1024) issue(name, 'blob exceeds text audit limit', source);
      else checkContent(name, git(['cat-file', 'blob', oid]), source);
    };
    for (const line of git(['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
      const [metadata, name] = line.split('\t'), [mode, oid, stage] = metadata.split(' ');
      if (stage !== '0') issue(name, 'unmerged index entry', 'index');
      if (!publicPath(name) || !['100644', '100755'].includes(mode)) issue(name, 'index entry outside public allowlist', 'index');
      else { inspectBlob(oid, name, 'index'); indexedBlobs++; }
    }
    if (gitRepositoryPresent) {
      const commits = git(['rev-list', '--all'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      historicalCommits = commits.length; gitHistoryPresent = commits.length > 0;
      for (const commit of commits) {
        checkContent('<commit-message>', git(['show', '-s', '--format=%B', commit]), 'history');
        for (const line of git(['ls-tree', '-r', '-z', commit], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
          const [metadata, name] = line.split('\t'), [mode, kind, oid] = metadata.split(' ');
          if (!publicPath(name) || kind !== 'blob' || !['100644', '100755'].includes(mode)) issue(name, 'historical entry outside public allowlist', 'history');
          else inspectBlob(oid, name, 'history');
        }
      }
    }
  } catch {
    // Never print command stderr: a failing Git command can expose local values.
    issue('<git>', 'Git audit could not complete during ' + gitPhase, 'git');
  } finally {
    if (temporary) {
      const resolved = path.resolve(temporary), tempRoot = await fs.realpath(os.tmpdir());
      if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('knowledge-release-git-')) throw new Error('Unexpected temporary audit path');
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
  return { passed: issues.length === 0, checkedPublicFiles: files.length, gitRepositoryPresent, gitHistoryPresent, eligibleFiles, indexedBlobs, historicalCommits, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkRelease();
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('Release audit failed before completion; no sensitive content was printed.');
    process.exitCode = 1;
  }
}
