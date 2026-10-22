import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './common.mjs';

// Finder leaves ordinary directories behind in some disconnect scenarios.
// A /Volumes target must still belong to a mounted filesystem, not that stub.
export async function checkMountedTarget(root, { platform = process.platform, stat = fs.stat } = {}) {
  if (platform !== 'darwin') return;
  const normalized = path.posix.normalize(root);
  if (normalized !== '/Volumes' && !normalized.startsWith('/Volumes/')) return;
  const volume = normalized.split('/')[2];
  if (!volume) throw fail('VOLUME_NOT_MOUNTED', '请选择已挂载卷内的目标目录。');
  const parent = await stat('/Volumes');
  const mount = await stat('/Volumes/' + volume);
  if (!mount.isDirectory() || mount.dev === parent.dev) throw fail('VOLUME_NOT_MOUNTED', '目标卷未挂载，工作归档已暂停。');
}
