import path from 'node:path';

export const isNodeCommand = value => typeof value === 'string' && /^(node|node\.exe)$/i.test(path.basename(value));
export const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function hookCommand(bin, config, { platform = process.platform, node = process.execPath } = {}) {
  if ([bin, config, node].some(value => /[\r\n\0]/.test(value))) throw new Error('安装路径不支持换行或空字符。');
  if (platform === 'win32') {
    if ([bin, config].some(value => value.includes("'"))) throw new Error('Windows Hook 安装路径不支持单引号。');
    return `node '${bin.replaceAll('\\', '/')}' hook --config '${config.replaceAll('\\', '/')}'`;
  }
  return `${shellQuote(node)} ${shellQuote(bin)} hook --config ${shellQuote(config)}`;
}
