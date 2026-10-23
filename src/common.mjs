import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const fail = (code, message) => Object.assign(new Error(message), { code });
export const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
export const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
export const slug = text => String(text).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || '未命名';
export async function readJson(p, fallback) {
  try { return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function atomicJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  try { await fs.rename(tmp, p); } finally { await fs.rm(tmp, { force: true }); }
}
// Reject junction/symlink traversal, including existing ancestors of a new path.
export async function safePath(root, relative = '', createParents = false) {
  if (path.isAbsolute(relative) || /^[a-z]:|^[/\\]/i.test(relative) || relative.includes(':')) throw fail('PATH_OUT_OF_SCOPE', '只接受员工目录内的相对路径。');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw fail('PATH_OUT_OF_SCOPE', '路径超出了员工目录。');
  let cursor = path.parse(target).root;
  for (const part of path.relative(cursor, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw fail('PATH_OUT_OF_SCOPE', '不允许通过符号链接或目录联接访问。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (createParents) await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

export async function withStateLock(c, name, fn) {
  await fs.mkdir(c.stateDir, { recursive: true });
  const file = path.join(c.stateDir, `${name}.lock`);
  let transientFailures = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (error) {
      // On Windows an exclusively created lock can briefly be delete-pending
      // after its owner releases it. Retry briefly; persistent ACL failures
      // still surface unchanged, and no operation runs without acquiring it.
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code) && transientFailures++ < 8) {
        await new Promise(resolve => setTimeout(resolve, 25)); continue;
      }
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8').catch(() => '0'));
      if (pid) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') await fs.rm(file, { force: true }); }
      }
      await new Promise(resolve => setTimeout(resolve, 25)); continue;
    }
    try { await handle.writeFile(String(process.pid)); await handle.close(); return await fn(); }
    finally { await fs.rm(file, { force: true }); }
  }
  throw fail('STATE_BUSY', '工作状态正在更新，请稍后重试。');
}
