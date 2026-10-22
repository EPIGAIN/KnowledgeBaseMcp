import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { sha, fail, exists, inside, slug, readJson, atomicJson, safePath } from './common.mjs';
export { sha, fail, exists, inside, slug, readJson, atomicJson, safePath } from './common.mjs';
import { assertGate } from './gate.mjs';
import { rememberFile } from './tracking.mjs';
import { withOperation } from './operations.mjs';
const excluded = /^(node_modules|\.git|\.claude|\.codex|\.ssh|\.aws|\.azure|\.gnupg|\.kb-local|\.kb-terminal|\.demo|dist|build|__pycache__|\.env(?:\..*)?|\.mcp\.json(?:\..*)?|\.claude\.json(?:\..*)?|\.npmrc|\.netrc|auth\.json(?:\..*)?|id_rsa|id_ed25519|~\$.*|.*\.(?:pem|key|tmp|temp|partial)|credentials(?:\..*)?)$/i;
const privateDirectory = /^(\.claude|\.codex|\.ssh|\.aws|\.azure|\.gnupg|AppData)$/i;
export const excludedPathPattern = excluded.source;

export async function loadConfig(configPath) {
  const c = await readJson(configPath);
  return validateConfig({ ...c, configFile: path.resolve(configPath) });
}
export function validateConfig(c) {
  for (const key of ['mdRoot', 'filesRoot', 'stateDir']) if (!path.isAbsolute(c[key] ?? '')) throw fail('INVALID_CONFIG', `${key} 必须为绝对路径。`);
  if (!Array.isArray(c.workRoots) || !c.workRoots.length || c.workRoots.some(p => !path.isAbsolute(p))) throw fail('INVALID_CONFIG', '请配置工作目录。');
  if (inside(c.mdRoot, c.filesRoot) || inside(c.filesRoot, c.mdRoot)) throw fail('INVALID_CONFIG', 'MD 盘和其他文件盘须使用互不包含的目录。');
  if ([c.mdRoot, c.filesRoot].some(root => [c.stateDir, c.stateRoot, ...(c.privateRoots || [])].filter(Boolean).some(state => inside(root, state) || inside(state, root)))) throw fail('INVALID_CONFIG', '本机状态目录与存储目标必须分开。');
  if (c.workRoots.some(root => [c.mdRoot, c.filesRoot, c.stateDir, ...(c.privateRoots || [])].some(base => inside(base, root)))) throw fail('INVALID_CONFIG', '工作目录不能位于归档目标或状态目录中。');
  if (c.workRoots.some(root => path.parse(root).root === path.resolve(root))) throw fail('INVALID_CONFIG', '请指定工作文件夹，不能将整个磁盘设为工作范围。');
  c.maxBytes ??= 100 * 1024 * 1024;
  return c;
}
export async function getProfile(c) { return readJson(path.join(c.stateDir, 'profile.json'), null); }
export async function requireProfile(c) {
  const p = await getProfile(c);
  if (!p) throw fail('SETUP_REQUIRED', '请先询问员工姓名，再调用 kb_setup。');
  return p;
}
export async function setup(c, ...args) { return withOperation(c, () => setupImpl(c, ...args)); }
async function setupImpl(c, name) {
  await assertGate(c, { onboarding: true });
  const clean = String(name).normalize('NFC').trim();
  if (!clean || clean.length > 60 || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || clean === '.' || clean === '..') throw fail('INVALID_NAME', '请输入 1–60 字的姓名，不包含路径符号。');
  let p = await getProfile(c);
  if (p && p.name !== clean) throw fail('PROFILE_EXISTS', '当前安装已绑定员工，不能通过 Agent 改成其他员工。');
  if (!p) {
    await fs.mkdir(c.stateDir, { recursive: true });
    const id = randomUUID();
    const proposed = { name: clean, id, folder: `${slug(clean)}-${id.slice(0, 8)}`, createdAt: new Date().toISOString() };
    const tmp = path.join(c.stateDir, `profile-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(proposed, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.link(tmp, path.join(c.stateDir, 'profile.json')); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    finally { await fs.rm(tmp, { force: true }); }
    p = await getProfile(c);
    if (p.name !== clean) throw fail('PROFILE_EXISTS', '另一个初始化已绑定不同员工。');
  }
  for (const base of [c.mdRoot, c.filesRoot]) {
    // A disconnected share must fail, rather than silently becoming a local directory.
    if (!(await fs.stat(base)).isDirectory()) throw fail('INVALID_ROOT', '存储盘不是目录。');
    await safePath(base, p.folder);
    await fs.mkdir(path.join(base, p.folder), { recursive: true });
  }
  return { ...p, mdDirectory: path.join(c.mdRoot, p.folder), filesDirectory: path.join(c.filesRoot, p.folder) };
}
export async function sourceInfo(c, input) {
  const activeRoot = c.activeRoot || process.cwd();
  const full = path.resolve(c.scope === 'user' ? activeRoot : process.cwd(), input);
  const roots = c.workRoots;
  const root = [...roots].sort((a, b) => b.length - a.length).find(r => inside(r, full));
  if (!root || [c.stateDir, c.mdRoot, c.filesRoot, ...(c.privateRoots || [])].some(r => inside(r, full))) throw fail('PATH_OUT_OF_SCOPE', '文件不在允许的工作目录中。');
  if (c.sourceMd && path.relative(c.sourceMd.path, full) === '') throw fail('EXCLUDED_FILE', '配置 MD 不作为工作资料上传。');
  const rel = path.relative(root, full);
  if (c.scope === 'user' && full.split(path.sep).some(p => privateDirectory.test(p))) throw fail('EXCLUDED_FILE', '不采集用户配置或凭据目录。');
  if (rel.split(path.sep).some(p => excluded.test(p))) throw fail('EXCLUDED_FILE', '该文件已被归档排除规则排除。');
  await safePath(root, rel);
  const canonical = c.scope === 'user' ? await fs.realpath(full) : full;
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw fail('NOT_A_FILE', '只归档普通文件。');
  if (stat.size > c.maxBytes) throw fail('FILE_TOO_LARGE', '超过上传大小上限。');
  return { full: canonical, root, rel: path.relative(root, canonical), stat };
}
export async function enqueue(c, ...args) { return withOperation(c, () => enqueueImpl(c, ...args)); }
async function enqueueImpl(c, bytes, bucket, relative, metadata = {}) {
  await assertGate(c);
  const p = await requireProfile(c);
  if (bytes.length > c.maxBytes) throw fail('FILE_TOO_LARGE', '超过上传大小上限。');
  const digest = sha(bytes);
  const id = sha(JSON.stringify([p.id, bucket, relative, digest]));
  const dir = path.join(c.stateDir, 'jobs');
  await fs.mkdir(dir, { recursive: true });
  const jobPath = path.join(dir, `${id}.json`);
  if (await exists(jobPath)) return readJson(jobPath);
  const blob = path.join(dir, `${id}.blob`);
  // An immutable, complete blob is published before its job can become visible.
  const temp = `${blob}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.link(temp, blob); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { await fs.rm(temp, { force: true }); }
  const job = { id, employeeId: p.id, employeeFolder: p.folder, bucket, relative, sha256: digest, size: bytes.length, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), metadata };
  const jobTemp = `${jobPath}.${randomUUID()}.tmp`;
  await fs.writeFile(jobTemp, JSON.stringify(job, null, 2), { flag: 'wx', mode: 0o600 });
  try { await fs.link(jobTemp, jobPath); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { await fs.rm(jobTemp, { force: true }); }
  return readJson(jobPath);
}
export async function archiveFile(c, ...args) { return withOperation(c, () => archiveFileImpl(c, ...args)); }
async function archiveFileImpl(c, input, metadata = {}) {
  const gate = await assertGate(c);
  const info = await sourceInfo(c, input);
  const bytes = await fs.readFile(info.full);
  const after = await fs.stat(info.full);
  if (info.stat.size !== after.size || info.stat.mtimeMs !== after.mtimeMs) throw fail('FILE_BUSY', '文件正在修改，稍后重试。');
  if (metadata.expectedSha256 && sha(bytes) !== metadata.expectedSha256) throw fail('SOURCE_CHANGED_AFTER_TRACE', '文件已不匹配本次命令的写入证据，未采集后续未知改动。');
  await assertGate(c, { epoch: gate.epoch });
  const extension = path.extname(info.full);
  const bucket = extension.toLowerCase() === '.md' ? 'md' : 'files';
  if (c.scope === 'user') {
    const digest = sha(bytes);
    // Reuse receipts created by the old project-scoped installation as well.
    const existing = (await jobs(c)).find(job => job.sha256 === digest && job.metadata.source && path.relative(job.metadata.source, info.full) === '');
    if (existing) {
      if (existing.status === 'scope_paused') {
        existing.status = 'pending'; delete existing.nextAttempt; delete existing.error;
        await atomicJson(path.join(c.stateDir, 'jobs', existing.id + '.json'), existing);
      }
      if (metadata.tool !== 'background_watch') await rememberFile(c, info.full, digest, gate.epoch);
      return existing;
    }
    const canonicalSource = process.platform === 'win32' ? info.full.toLowerCase() : info.full;
    const folder = path.dirname(canonicalSource);
    const name = `${slug(path.basename(info.full, extension))}__${sha(canonicalSource).slice(0, 12)}_${digest.slice(0, 16)}${extension.toLowerCase()}`;
    const relative = path.join('工作文件', `${slug(path.basename(folder))}-${sha(folder).slice(0, 8)}`, name);
    const job = await enqueue(c, bytes, bucket, relative, { ...metadata, source: info.full, workDirectory: info.root });
    if (metadata.tool !== 'background_watch') await rememberFile(c, info.full, digest, gate.epoch);
    return job;
  }
  const name = `${slug(path.basename(info.full, extension))}__${sha(info.rel).slice(0, 8)}_${sha(bytes).slice(0, 16)}${extension}`;
  const relative = path.join('工作文件', `${slug(path.basename(info.root))}-${sha(info.root).slice(0, 8)}`, path.dirname(info.rel), name);
  const job = await enqueue(c, bytes, bucket, relative, { ...metadata, source: info.full });
  if (metadata.tool !== 'background_watch') await rememberFile(c, info.full, sha(bytes), gate.epoch);
  return job;
}
export async function archiveKnowledge(c, ...args) { return withOperation(c, () => archiveKnowledgeImpl(c, ...args)); }
async function archiveKnowledgeImpl(c, data) {
  await assertGate(c, { cwd: c.activeRoot || process.cwd() });
  const p = await requireProfile(c);
  const date = new Date().toISOString();
  const body = `# ${data.title}\n\n- 员工：${p.name}\n- 验证状态：${data.verification || '待验证'}\n- 来源：${data.source || 'Agent 整理'}\n\n## 问题背景\n\n${data.problem}\n\n## 原因分析\n\n${data.cause || '尚未确认'}\n\n## 解决方法\n\n${data.solution}\n\n## 验证结果\n\n${data.evidence || '未提供验证结果'}\n`;
  const bytes = Buffer.from(body, 'utf8');
  const rel = path.join('问题解决', date.slice(0, 7), `${slug(data.title)}__${sha(bytes).slice(0, 16)}.md`);
  return enqueue(c, bytes, 'md', rel, { kind: 'knowledge', source: data.source });
}
async function lock(p) {
  try { const f = await fs.open(p, 'wx'); await f.writeFile(String(process.pid)); await f.close(); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await fs.readFile(p, 'utf8').catch(() => '0'));
    if (!pid) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
    await fs.rm(p, { force: true });
    return lock(p);
  }
}
export async function flush(c, ...args) { return withOperation(c, () => flushImpl(c, ...args)); }
async function flushImpl(c, { force = false } = {}) {
  await assertGate(c);
  const profile = await requireProfile(c);
  const dir = path.join(c.stateDir, 'jobs');
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    const jp = path.join(dir, name);
    if (!await lock(`${jp}.lock`)) continue;
    try {
      const j = await readJson(jp);
      if (j.status === 'stored' || j.status === 'scope_paused' || (!force && j.nextAttempt && Date.parse(j.nextAttempt) > Date.now())) continue;
      if (j.employeeId !== profile.id || j.employeeFolder !== profile.folder || !['md', 'files'].includes(j.bucket)) throw fail('INVALID_JOB', '队列员工或目标不匹配。');
      let temp;
      try {
        await assertGate(c);
        const base = j.bucket === 'md' ? c.mdRoot : c.filesRoot;
        await fs.stat(base);
        const employeeRoot = await safePath(base, profile.folder);
        const target = await safePath(employeeRoot, j.relative, true);
        const bytes = await fs.readFile(path.join(dir, `${j.id}.blob`));
        if (sha(bytes) !== j.sha256) throw fail('CHECKSUM_MISMATCH', '待上传快照损坏。');
        temp = `${target}.${randomUUID()}.partial`;
        await fs.writeFile(temp, bytes, { flag: 'wx' });
        if (sha(await fs.readFile(temp)) !== j.sha256) throw fail('CHECKSUM_MISMATCH', '目标文件校验失败。');
        try { await fs.link(temp, target); }
        catch (e) {
          if (e.code !== 'EEXIST') throw fail('ATOMIC_COMMIT_UNSUPPORTED', `目标存储无法无覆盖提交：${e.code}。请验证 NAS 的硬链接支持。`);
          if (sha(await fs.readFile(target)) !== j.sha256) throw fail('FILE_EXISTS', '同名文件内容不同，已保留原文件。');
        }
        j.status = 'stored'; j.destination = target; j.storedAt = new Date().toISOString(); delete j.error; delete j.nextAttempt;
      } catch (e) {
        j.status = 'retry_pending'; j.attempts++; j.error = { code: e.code ?? 'IO_ERROR', message: e.message };
        j.nextAttempt = new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(j.attempts, 7))).toISOString();
      } finally { if (temp) await fs.rm(temp, { force: true }).catch(() => {}); }
      await atomicJson(jp, j); results.push(j);
    } finally { await fs.rm(`${jp}.lock`, { force: true }); }
  }
  return results;
}
export async function jobs(c) {
  const dir = path.join(c.stateDir, 'jobs');
  if (!await exists(dir)) return [];
  return Promise.all((await fs.readdir(dir)).filter(p => p.endsWith('.json')).map(p => readJson(path.join(dir, p))));
}
export async function employeeRoot(c, bucket) {
  await assertGate(c);
  const p = await requireProfile(c);
  if (!['md', 'files'].includes(bucket)) throw fail('INVALID_BUCKET', '请选择 md 或 files。');
  return safePath(bucket === 'md' ? c.mdRoot : c.filesRoot, p.folder);
}
export async function listFiles(c, bucket, relative = '') {
  const root = await employeeRoot(c, bucket);
  const dir = await safePath(root, relative);
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.endsWith('.partial') || entry.isSymbolicLink()) continue;
    const p = path.join(relative, entry.name);
    const s = await fs.stat(await safePath(root, p));
    result.push({ path: p, directory: s.isDirectory(), size: s.size, modifiedAt: s.mtime.toISOString() });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function readText(c, bucket, relative, offset = 0, limit = 32000) {
  const p = await safePath(await employeeRoot(c, bucket), relative);
  const stat = await fs.stat(p);
  if (!stat.isFile()) throw fail('NOT_A_FILE', '请选择文件。');
  if (!/\.(md|txt|json|csv|log)$/i.test(p)) return { content_available: false, size: stat.size, path: relative };
  if (stat.size > 2 * 1024 * 1024) throw fail('FILE_TOO_LARGE', '文本读取上限为 2 MiB。');
  const bytes = await fs.readFile(p);
  const chars = Array.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const end = Math.min(chars.length, offset + limit);
  return { content_available: true, text: chars.slice(offset, end).join(''), version: sha(bytes), next_offset: end < chars.length ? end : null, path: relative };
}
export async function searchFiles(c, bucket, query, mode = 'filename') {
  const matches = []; let scanned = 0; let partial = false; let skipped = 0;
  const needle = query.toLocaleLowerCase();
  async function walk(relative, depth) {
    if (depth > 20 || scanned >= 500 || matches.length >= 100) { partial = true; return; }
    for (const entry of await listFiles(c, bucket, relative)) {
      if (scanned >= 500 || matches.length >= 100) { partial = true; return; }
      if (entry.directory) { await walk(entry.path, depth + 1); continue; }
      scanned++;
      if (mode === 'filename') {
        if (entry.path.toLocaleLowerCase().includes(needle)) matches.push({ path: entry.path });
      } else {
        if (!/\.(md|txt|csv|json|log)$/i.test(entry.path) || entry.size > 2 * 1024 * 1024) { skipped++; continue; }
        try {
          const p = await safePath(await employeeRoot(c, bucket), entry.path);
          const lines = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(p)).split(/\r?\n/);
          const line = lines.findIndex(s => s.toLocaleLowerCase().includes(needle));
          if (line >= 0) matches.push({ path: entry.path, line: line + 1, snippet: lines[line].slice(0, 500) });
        } catch { skipped++; }
      }
    }
  }
  await walk('', 0);
  return { matches, scanned, skipped, partial: partial || skipped > 0, mode };
}
