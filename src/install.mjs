import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, exists, readJson, loadConfig } from './storage.mjs';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const begin = '# BEGIN company-knowledge (managed by knowledge-mcp)';
const end = '# END company-knowledge (managed by knowledge-mcp)';

export function mergeHooks(settings, command, legacyCommand) {
  const owned = new Set([command, ...[legacyCommand].flat()]);
  settings.hooks ||= {};
  for (const event of command.endsWith('--client claude') ? [...events, 'PostToolUseFailure'] : events) {
    settings.hooks[event] ||= [];
    // Replace only this installation's previous hook; retain all unrelated hooks.
    settings.hooks[event] = settings.hooks[event].map(group => ({
      ...group, hooks: (group.hooks || []).filter(h => !owned.has(h.command))
    })).filter(group => group.hooks.length);
    settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 30 }] });
  }
  return settings;
}

export async function install(options) {
  if (options.scope === 'user') {
    const { installUser } = await import('./install-user.mjs');
    return installUser(options);
  }
  if (options.scope && options.scope !== 'project') throw new Error('--scope 必须是 user 或 project。');
  const client = options.client || 'both';
  if (!['claude', 'codex', 'both'].includes(client)) throw new Error('--client 必须是 claude、codex 或 both。');
  if (!options.workspace) throw new Error('缺少 --workspace。');
  const workspace = path.resolve(options.workspace);
  const bin = fileURLToPath(new URL('../bin/kb.mjs', import.meta.url));
  const mcpPath = path.join(workspace, '.mcp.json');
  const existingMcp = await readJson(mcpPath, {});
  const oldArgs = existingMcp.mcpServers?.['company-knowledge']?.args || [];
  const configArg = oldArgs.indexOf('--config');
  const claudeConfig = configArg >= 0 && oldArgs[configArg + 1] ? path.resolve(oldArgs[configArg + 1]) : null;
  const existingCodex = await fs.readFile(path.join(workspace, '.codex/config.toml'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  let codexConfig;
  if (existingCodex.includes(begin)) {
    const managed = existingCodex.slice(existingCodex.indexOf(begin), existingCodex.indexOf(end));
    const argsLine = managed.match(/^args = (.+)$/m);
    if (!argsLine) throw new Error('现有 Codex 归档配置不完整。');
    const args = JSON.parse(argsLine[1]);
    const index = args.indexOf('--config');
    if (index < 0 || !args[index + 1]) throw new Error('现有 Codex 配置缺少共享配置路径。');
    codexConfig = path.resolve(args[index + 1]);
  }
  if (claudeConfig && codexConfig && path.relative(claudeConfig, codexConfig) !== '') throw new Error('Claude 与 Codex 指向不同员工配置，请先解决冲突。');
  const detectedConfig = claudeConfig || codexConfig;
  const configPath = path.resolve(options.config || (options.state ? path.join(options.state, 'config.json') : detectedConfig || path.join(workspace, '.kb-local/config.json')));
  if (detectedConfig && path.relative(detectedConfig, configPath) !== '') throw new Error('不能为另一个客户端创建不同员工资料，请复用已有配置。');
  if ([bin, configPath].some(p => /['\r\n]/.test(p))) throw new Error('安装路径暂不支持单引号或换行。');
  await fs.mkdir(workspace, { recursive: true });
  let config;
  if (await exists(configPath)) {
    config = await loadConfig(configPath);
    if (!config.workRoots.some(root => path.relative(root, workspace) === '')) throw new Error('现有配置未包含此工作目录，请选用对应配置。');
    for (const [option, field] of [['md-root', 'mdRoot'], ['files-root', 'filesRoot'], ['state', 'stateDir']]) {
      if (options[option] && path.relative(config[field], path.resolve(options[option])) !== '') throw new Error('现有配置不同，拒绝改动员工的存储位置。');
    }
  } else {
    if (options.config) throw new Error('--config 必须指向已存在的配置，防止意外创建第二个员工身份。');
    for (const key of ['md-root', 'files-root']) if (!options[key]) throw new Error('首次安装缺少 --' + key);
    config = { version: 1, mdRoot: path.resolve(options['md-root']), filesRoot: path.resolve(options['files-root']), stateDir: path.dirname(configPath), workRoots: [workspace], maxBytes: 104857600 };
    for (const root of [config.mdRoot, config.filesRoot]) if (!(await fs.stat(root)).isDirectory()) throw new Error('存储根目录不存在：' + root);
    await atomicJson(configPath, config);
    await loadConfig(configPath);
  }
  const normalizedBin = bin.replaceAll('\\', '/');
  const normalizedConfig = configPath.replaceAll('\\', '/');
  const legacyCommand = "node '" + normalizedBin + "' hook --config '" + normalizedConfig + "'";
  const spec = { command: process.execPath, args: [bin, 'serve', '--config', configPath] };
  const writes = [];
  const result = { client, workspace, configPath, sharedState: config.stateDir };
  if (client === 'claude' || client === 'both') {
    if (existingMcp.mcpServers?.['company-knowledge'] && JSON.stringify(existingMcp.mcpServers['company-knowledge']) !== JSON.stringify(spec)) throw new Error('已有同名 MCP 配置，拒绝覆盖。');
    const settingsPath = path.join(workspace, '.claude/settings.local.json');
    const settings = mergeHooks(await readJson(settingsPath, {}), legacyCommand + ' --client claude', legacyCommand);
    writes.push([mcpPath, JSON.stringify({ ...existingMcp, mcpServers: { ...existingMcp.mcpServers, 'company-knowledge': spec } }, null, 2)]);
    writes.push([settingsPath, JSON.stringify(settings, null, 2)]);
    Object.assign(result, { mcpPath, settingsPath });
  }
  if (client === 'codex' || client === 'both') {
    const codexConfigPath = path.join(workspace, '.codex/config.toml');
    const codexHooksPath = path.join(workspace, '.codex/hooks.json');
    let original = await fs.readFile(codexConfigPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (original.includes(begin)) {
      const start = original.indexOf(begin);
      const finish = original.indexOf(end, start);
      if (finish < 0) throw new Error('Codex 配置中的归档区块不完整，拒绝修改。');
      original = original.slice(0, start) + original.slice(finish + end.length);
    }
    if (original.includes('company-knowledge')) throw new Error('Codex 已有同名配置，拒绝覆盖。');
    // JSON string syntax here is also valid TOML basic-string syntax. This is not shell text.
    const block = [begin, '[mcp_servers.company-knowledge]', 'command = ' + JSON.stringify(spec.command), 'args = ' + JSON.stringify(spec.args), 'startup_timeout_sec = 30', 'tool_timeout_sec = 120', end].join('\n');
    const hooks = mergeHooks(await readJson(codexHooksPath, {}), legacyCommand + ' --client codex', legacyCommand);
    writes.push([codexConfigPath, original.trimEnd() + '\n\n' + block + '\n']);
    writes.push([codexHooksPath, JSON.stringify(hooks, null, 2)]);
    Object.assign(result, { codexConfigPath, codexHooksPath });
  }
  for (const [location, data] of writes) {
    if (await exists(location)) {
      if (await fs.readFile(location, 'utf8') === data) continue;
      await fs.copyFile(location, location + '.' + Date.now() + '.backup');
    }
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(location, data, 'utf8');
  }
  return { ...result, next: '在该目录启动客户端。两个客户端复用同一员工资料；Codex 首次需按 /hooks 的正常流程信任已安装的 Hook。' };
}
