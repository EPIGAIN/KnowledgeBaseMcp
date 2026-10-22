import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fail, sha, safePath } from './common.mjs';

const begin = '<!-- company-knowledge-config:v1 -->';
const end = '<!-- /company-knowledge-config -->';
export function parseMarkdownConfig(text) {
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw fail('INVALID_MD_CONFIG', '配置 MD 不能超过 256 KiB。');
  if (text.split(begin).length !== 2 || text.split(end).length !== 2) throw fail('INVALID_MD_CONFIG', '需要且只能有一个 company-knowledge-config:v1 配置表格。');
  const start = text.indexOf(begin), finish = text.indexOf(end);
  if (finish <= start) throw fail('INVALID_MD_CONFIG', '配置标记顺序错误。');
  const result = { workRoots: [] };
  for (const line of text.slice(start + begin.length, finish).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.trim().split('|');
    if (cells.length !== 4 || cells[0].trim() || cells[3].trim()) throw fail('INVALID_MD_CONFIG', '配置区仅接受两列表格。路径中不能包含竖线。');
    const [key, raw] = cells.slice(1, 3).map(s => s.trim());
    if (key === '项目' && raw === '路径' || /^:?-+:?$/.test(key) && /^:?-+:?$/.test(raw)) continue;
    if (!['MdRoot', 'FilesRoot', 'WorkRoot'].includes(key)) throw fail('INVALID_MD_CONFIG', `未知配置项：${key}`);
    const value = raw.startsWith('`') && raw.endsWith('`') ? raw.slice(1, -1) : raw;
    if (!value || /[<>\r\n`]/.test(value) || !path.isAbsolute(value)) throw fail('INVALID_MD_CONFIG', `${key} 需要真实绝对路径，不能保留占位符。`);
    const normalized = path.resolve(value);
    if (key === 'WorkRoot') result.workRoots.push(normalized);
    else {
      const field = key === 'MdRoot' ? 'mdRoot' : 'filesRoot';
      if (result[field]) throw fail('INVALID_MD_CONFIG', `${key} 不能重复。`);
      result[field] = normalized;
    }
  }
  result.workRoots = [...new Set(result.workRoots)];
  if (!result.mdRoot || !result.filesRoot || !result.workRoots.length) throw fail('INVALID_MD_CONFIG', '必须设置 MdRoot、FilesRoot 和至少一个 WorkRoot。');
  return result;
}
export const settingsHash = settings => sha(JSON.stringify(settings));
export async function readMarkdownConfig(file) {
  const resolved = path.resolve(file);
  await safePath(path.dirname(resolved), path.basename(resolved));
  if ((await fs.stat(resolved)).size > 256 * 1024) throw fail('INVALID_MD_CONFIG', '配置 MD 过大。');
  const settings = parseMarkdownConfig(await fs.readFile(resolved, 'utf8'));
  return { path: resolved, settings, hash: settingsHash(settings) };
}
export function defaultDataRoot(homeOverride) {
  if (homeOverride) return path.join(homeOverride, '.company-knowledge');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CompanyKnowledgeMcp');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CompanyKnowledgeMcp');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'company-knowledge-mcp');
}
