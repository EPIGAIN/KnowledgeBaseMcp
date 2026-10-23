import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workContext } from './gate.mjs';
import { fail } from './common.mjs';

// Tokens belong to this MCP process, not to a globally selected folder.
// Every data call must supply its own token: desktop clients may share one
// connection between several conversations. No token or chat text is persisted.
export function createDesktopContexts({ now = Date.now, ttlMs = 4 * 60 * 60 * 1000 } = {}) {
  const sessions = new Map();
  const revision = c => JSON.stringify([c.revision, c.enabledAt, c.workRoots]);
  const prune = () => { for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id); };
  return {
    async begin(c, directory) {
      prune();
      if (!path.isAbsolute(directory) || !await workContext(c, directory)) throw fail('PATH_OUT_OF_SCOPE', '请选择配置白名单内的工作目录。');
      const root = path.resolve(directory);
      if (!(await fs.stat(root)).isDirectory()) throw fail('NOT_A_DIRECTORY', '工作范围必须为已存在的目录。');
      if (sessions.size >= 32) throw fail('TOO_MANY_WORK_CONTEXTS', '工作会话过多，请先结束不再使用的工作会话。');
      const id = randomUUID(), expiresAt = now() + ttlMs;
      sessions.set(id, { root, expiresAt, revision: revision(c) });
      return { work_session: id, workDirectory: root, expiresAt: new Date(expiresAt).toISOString() };
    },
    async resolve(c, id) {
      prune();
      const item = sessions.get(id);
      if (!item || item.revision !== revision(c) || !await workContext(c, item.root)) {
        sessions.delete(id);
        throw fail('WORK_CONTEXT_EXPIRED', '工作会话已结束、过期或配置已变化，请重新调用 kb_begin_work。');
      }
      if (!(await fs.stat(item.root)).isDirectory()) throw fail('WORK_CONTEXT_EXPIRED', '工作目录已不可用。');
      return item.root;
    },
    end(id) { return sessions.delete(id); }
  };
}
