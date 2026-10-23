import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeHooks } from './install.mjs';
import { atomicJson, exists, loadConfig, validateConfig, inside } from './storage.mjs';
import { hookCommand, isNodeCommand } from './runtime-command.mjs';
import { doubaoRegistration, doubaoRegistrationPath } from './desktop-registration.mjs';
const begin = '# BEGIN company-knowledge (managed by knowledge-mcp)';
const end = '# END company-knowledge (managed by knowledge-mcp)';
function block(text) {
  const start = text.indexOf(begin), finish = text.indexOf(end, start);
  if (start < 0) return { rest: text, managed: '' };
  if (finish < 0) throw new Error('知识库托管配置区块不完整。');
  return { rest: text.slice(0, start) + text.slice(finish + end.length), managed: text.slice(start, finish + end.length) };
}
const json = text => text ? JSON.parse(text.replace(/^\uFEFF/, '')) : {};
const serialize = data => JSON.stringify(data, null, 2);
const absolute = (value, label) => { if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须显式指定绝对路径。`); return path.resolve(value); };

export async function installUser(options, locations) {
  if (options['config-md']) {
    const { installFromMarkdown } = await import('./migrate-config.mjs');
    return installFromMarkdown(options, locations);
  }
  const client = options.client || 'both';
  if (!['claude', 'codex', 'both', 'doubao', 'all'].includes(client)) throw new Error('--client 必须是 claude、codex、both、doubao 或 all。');
  const wantsClaude = ['claude', 'both', 'all'].includes(client);
  const wantsCodex = ['codex', 'both', 'all'].includes(client);
  const wantsDoubao = ['doubao', 'all'].includes(client);
  if (options['client-home']) locations = { home: absolute(options['client-home'], '--client-home') };
  if (wantsClaude && process.env.CLAUDE_CONFIG_DIR && !locations) throw new Error('自定义 CLAUDE_CONFIG_DIR 请通过明确的客户端配置位置安装。');
  const configPath = options.config ? absolute(options.config, '--config') : path.join(absolute(options.state, '--state'), 'config.json');
  const bin = fileURLToPath(new URL('../bin/kb.mjs', import.meta.url));
  const base = wantsClaude || wantsCodex ? hookCommand(bin, configPath) : null;
  const old = options._candidateConfig || (await exists(configPath) ? await loadConfig(configPath) : null);
  if (options.config && !old) throw new Error('--config 必须指向已有配置。');
  if (old?.sourceMd && ['state', 'md-root', 'files-root', 'work-root', 'workspace'].some(key => options[key] !== undefined)) throw new Error('此安装由 MD 管理，请修改配置 MD 并使用 --config-md 应用迁移。');
  const requestedRoots = options['work-root'] || (options.workspace ? [options.workspace] : null);
  const workRoots = requestedRoots ? [...new Set(requestedRoots.map(p => absolute(p, '--work-root')))] : old?.workRoots;
  if (!workRoots?.length) throw new Error('必须通过 --work-root 指定至少一个工作目录。');
  let config = old || { version: 2, mdRoot: absolute(options['md-root'], '--md-root'), filesRoot: absolute(options['files-root'], '--files-root'), stateDir: absolute(options.state, '--state'), maxBytes: 100 * 1024 * 1024 };
  for (const [arg, field] of [['state', 'stateDir'], ['md-root', 'mdRoot'], ['files-root', 'filesRoot']]) {
    if (old && options[arg] && path.resolve(options[arg]) !== path.resolve(old[field])) throw new Error('现有员工配置的存储位置不同，拒绝隐式迁移。');
  }
  if (/^\\\\/.test(config.stateDir) || process.platform === 'darwin' && /^\/Volumes(?:\/|$)/.test(config.stateDir)) throw new Error('状态目录必须在本机，不能使用共享盘或 /Volumes 挂载卷。');
  const repoRoot = path.dirname(path.dirname(bin));
  if (inside(repoRoot, config.stateDir) && !['.kb-local', '.local-private', '.test-output'].some(name => inside(path.join(repoRoot, name), config.stateDir))) throw new Error('仓库内的状态目录必须位于已忽略的私有目录；建议放到仓库之外。');
  const changedScope = old && JSON.stringify(old.workRoots) !== JSON.stringify(workRoots);
  config = validateConfig({ ...config, version: config.sourceMd ? 3 : 2, workRoots, scope: 'user', captureMode: 'new-events-only', enabledAt: !changedScope && old?.enabledAt || new Date().toISOString(), terminalCapture: { enabled: true, version: 2 }, pollMs: 2000, settleMs: 2000,
    ...(wantsDoubao ? { privateRoots: [...new Set([...(config.privateRoots || []), path.dirname(doubaoRegistrationPath(locations?.home))])] } : {}) });
  const home = locations?.home || os.homedir();
  const claudeDir = locations?.claudeDir || path.join(home, '.claude');
  const claudeState = locations?.claudeState || path.join(home, '.claude.json');
  const codexDir = locations?.codexDir || (locations ? path.join(home, '.codex') : process.env.CODEX_HOME || path.join(home, '.codex'));
  const globalPaths = { claudeMcp: claudeState, claudeHooks: path.join(claudeDir, 'settings.json'), codexMcp: path.join(codexDir, 'config.toml'), codexHooks: path.join(codexDir, 'hooks.json'), doubaoMcp: doubaoRegistrationPath(locations?.home) };
  const spec = { command: process.execPath, args: [bin, 'serve', '--config', configPath] };
  const read = file => fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const same = value => isNodeCommand(value?.command) && JSON.stringify(value.args) === JSON.stringify(spec.args);
  const previousNodes = new Set([process.execPath]);
  const claudeData = json(await read(globalPaths.claudeMcp));
  if (claudeData.mcpServers?.['company-knowledge'] && !same(claudeData.mcpServers['company-knowledge'])) throw new Error('Claude 已指向另一份员工配置，拒绝创建两套身份。');
  if (claudeData.mcpServers?.['company-knowledge']) previousNodes.add(claudeData.mcpServers['company-knowledge'].command);
  const codex = block(await read(globalPaths.codexMcp) || '');
  if (codex.rest.includes('company-knowledge')) throw new Error('Codex 存在未托管同名配置。');
  if (codex.managed) {
    const args = JSON.parse(codex.managed.match(/^args = (.+)$/m)?.[1] || 'null');
    const command = JSON.parse(codex.managed.match(/^command = (.+)$/m)?.[1] || 'null');
    if (!same({ args, command })) throw new Error('Codex 已指向另一份员工配置，拒绝创建两套身份。');
    previousNodes.add(command);
  }
  const desktopSpec = doubaoRegistration(configPath);
  const previousDesktop = json(await read(globalPaths.doubaoMcp));
  if (previousDesktop.mcpServers?.['company-knowledge']) {
    const previous = previousDesktop.mcpServers['company-knowledge'];
    if (!isNodeCommand(previous.command) || JSON.stringify(previous.args) !== JSON.stringify(desktopSpec.mcpServers['company-knowledge'].args)) throw new Error('豆包接入文件指向另一份员工配置，拒绝创建两套身份。');
  }
  const bases = base ? [...previousNodes].map(node => hookCommand(bin, configPath, { node })) : [];
  // Retire the previous bare-node registration as well; compare exact commands only.
  if (![bin, configPath].some(p => p.includes("'"))) bases.push(`node '${bin.replaceAll('\\', '/')}' hook --config '${configPath.replaceAll('\\', '/')}'`);
  const ownedHooks = [...new Set(bases.flatMap(b => [b, `${b} --client claude`, `${b} --client codex`]))];
  const mutations = [];
  const plan = async (file, transform) => { const original = await read(file); const next = transform(original); if (next !== original) mutations.push({ file, original, next }); };
  if (wantsClaude) {
    await plan(globalPaths.claudeMcp, text => { const d = json(text); d.mcpServers = { ...d.mcpServers, 'company-knowledge': { type: 'stdio', ...spec } }; return serialize(d); });
    await plan(globalPaths.claudeHooks, text => serialize(mergeHooks(json(text), `${base} --client claude`, ownedHooks)));
  }
  if (wantsCodex) {
    await plan(globalPaths.codexMcp, () => codex.rest.trimEnd() + '\n\n' + [begin, '[mcp_servers.company-knowledge]', `command = ${JSON.stringify(spec.command)}`, `args = ${JSON.stringify(spec.args)}`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 120', end].join('\n') + '\n');
    await plan(globalPaths.codexHooks, text => serialize(mergeHooks(json(text), `${base} --client codex`, ownedHooks)));
  }
  if (wantsDoubao) await plan(globalPaths.doubaoMcp, text => {
    const d = json(text); d.mcpServers = { ...d.mcpServers, ...desktopSpec.mcpServers }; return serialize(d);
  });
  // Remove only this registration's old project entries; never create them.
  for (const workspace of wantsClaude || wantsCodex ? workRoots : []) {
    const mcpPath = path.join(workspace, '.mcp.json');
    if (wantsClaude && await exists(mcpPath)) await plan(mcpPath, text => { const d = json(text); if (same(d.mcpServers?.['company-knowledge'])) delete d.mcpServers['company-knowledge']; return serialize(d); });
    for (const file of [...(wantsClaude ? ['.claude/settings.local.json'] : []), ...(wantsCodex ? ['.codex/hooks.json'] : [])]) {
      const target = path.join(workspace, file);
      if (await exists(target)) await plan(target, text => {
        const d = json(text);
        for (const event of Object.keys(d.hooks || {})) {
          d.hooks[event] = d.hooks[event].map(group => ({ ...group, hooks: group.hooks.filter(h => !ownedHooks.includes(h.command)) })).filter(group => group.hooks.length);
          if (!d.hooks[event].length) delete d.hooks[event];
        }
        if (d.hooks && !Object.keys(d.hooks).length) delete d.hooks;
        return serialize(d);
      });
    }
    const target = path.join(workspace, '.codex/config.toml');
    if (wantsCodex && await exists(target)) await plan(target, text => { const parsed = block(text || ''); return parsed.managed.includes(JSON.stringify(configPath)) ? parsed.rest.trimEnd() + '\n' : text; });
  }
  if (options._planOnly) return { configPath, config, globalPaths, changedFiles: mutations.map(m => m.file) };
  const backups = []; const applied = [];
  try {
    for (const change of mutations) {
      if (await read(change.file) !== change.original) throw new Error('配置被并发修改，请重试。');
      await fs.mkdir(path.dirname(change.file), { recursive: true });
      if (change.original !== null) {
        const backup = path.join(config.stateDir, 'config-backups', `${Date.now()}-${randomUUID()}-${path.basename(change.file)}`);
        await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.copyFile(change.file, backup); backups.push(backup);
      }
      const temp = change.file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temp, change.next, { flag: 'wx', mode: 0o600 });
      try { await fs.rename(temp, change.file); } finally { await fs.rm(temp, { force: true }); }
      applied.push(change);
    }
    await atomicJson(configPath, config);
  } catch (error) {
    for (const change of applied.reverse()) if (await read(change.file) === change.next) {
      if (change.original === null) await fs.rm(change.file, { force: true }); else await fs.writeFile(change.file, change.original);
    }
    throw error;
  }
  const result = { client, scope: 'user', configPath, sharedState: config.stateDir, workRoots, globalPaths, enabledAt: config.enabledAt, changedFiles: mutations.map(m => m.file), backups,
    ...(wantsDoubao ? { doubao: { registrationFile: globalPaths.doubaoMcp, transport: 'stdio', ...desktopSpec.mcpServers['company-knowledge'], clientConfigurationApplied: false, clientHooks: false } } : {}),
    next: wantsDoubao ? '豆包 STDIO 接入文件已生成，请将 command 和 args 填入豆包自定义连接器；尚未修改豆包内部设置。工作请求先 kb_begin_work，再按提示询问姓名。其他客户端需重启并信任 Hook。' : '重启客户端并信任 Hook；从配置的工作目录打开新会话。目标可访问后 Agent 主动询问姓名。' };
  await atomicJson(path.join(config.stateDir, 'global-installation.json'), result);
  return result;
}
