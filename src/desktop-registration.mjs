import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataRoot } from './markdown-config.mjs';

export const doubaoRegistrationPath = home => path.join(defaultDataRoot(home), 'doubao-stdio.json');
export function doubaoRegistration(configPath) {
  return { mcpServers: { 'company-knowledge': {
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/kb.mjs', import.meta.url)), 'serve', '--client', 'doubao', '--config', configPath]
  } } };
}
