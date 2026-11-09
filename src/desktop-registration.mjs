import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataRoot } from './markdown-config.mjs';
import { shellQuote } from './runtime-command.mjs';

export const doubaoRegistrationPath = home => path.join(defaultDataRoot(home), 'doubao-stdio.json');

// The DouBao connector reads its "command" box as a command line instead of a
// literal executable path. A Node installation such as
// "C:\Program Files\nodejs\node.exe" or the DouBao sandbox runtime under
// "...\Doubao\User Data\..." is therefore cut at the first space and the client
// reports CONNECTOR_STDIO_EXECUTABLE_NOT_FOUND: COMMAND_NOT_FOUND. The
// structured JSON export must stay unquoted, so the installer also prints the
// quoted forms below for the interface fields.
export function quoteWindowsArgument(value) {
  if (!/[\s"]/.test(value)) return value;
  let out = '"', backslashes = 0;
  for (const char of value) {
    if (char === '\\') { backslashes += 1; continue; }
    // Before a double quote the parser consumes pairs of backslashes, so a
    // literal backslash and the quote itself need an odd number of them.
    if (char === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + char; backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

const needsQuoting = (value, platform) => (platform === 'win32' ? /[\s"]/ : /[\s'"]/).test(value);

export function quoteCommandValue(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('豆包接入路径不支持换行或空字符。');
  return platform === 'win32' ? quoteWindowsArgument(value) : shellQuote(value);
}

// Quote one command or argument only when the client would otherwise split it.
export function quoteCommandPart(value, options = {}) {
  return needsQuoting(value, options.platform ?? process.platform) ? quoteCommandValue(value, options) : value;
}

// Value for the DouBao "command" box: unchanged when the path has no spaces,
// quoted when the client would split it.
export function commandFieldValue(command, options = {}) {
  return quoteCommandPart(command, options);
}

// Whole line for a DouBao interface that has a single command input.
export function commandLineValue(spec, options = {}) {
  return [spec.command, ...spec.args].map(value => quoteCommandPart(value, options)).join(' ');
}

export function doubaoClientHints(spec, options = {}) {
  const platform = options.platform ?? process.platform;
  return {
    commandField: commandFieldValue(spec.command, { platform }),
    commandLine: commandLineValue(spec, { platform }),
    requiresQuoting: needsQuoting(spec.command, platform)
  };
}

export function doubaoRegistration(configPath) {
  return { mcpServers: { 'company-knowledge': {
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/kb.mjs', import.meta.url)), 'serve', '--client', 'doubao', '--config', configPath]
  } } };
}
