import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values: args } = parseArgs({ options: {
    'config-file': { type: 'string' }, 'state-dir': { type: 'string' }, clients: { type: 'string', default: 'auto' },
    'client-home': { type: 'string' }, 'skip-service': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  } });
  if (args.help) {
    console.log('bash scripts/install-macos.sh --config-file "<配置MD路径>" [--state-dir "<本机状态目录>"] [--clients auto|claude|codex|both]\n隔离测试：--client-home "<测试用户目录>" --skip-service');
  } else {
    if (process.platform !== 'darwin') throw new Error('此安装器适用于 macOS；Windows 请使用 Install-OneClick.ps1。');
    if (process.getuid() === 0) throw new Error('请以当前员工用户运行，不要使用 sudo。');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本。');
    if (!args['config-file']) throw new Error('请提供 --config-file，指向已填写的 MD 配置文件。');
    if (args['client-home'] && !args['skip-service']) throw new Error('隔离客户端测试必须同时使用 --skip-service；不会向真实用户注册测试后台服务。');
    const configMd = path.resolve(args['config-file']);
    if (!(await fs.stat(configMd)).isFile()) throw new Error('配置 MD 不存在。');
    for (const key of ['state-dir', 'client-home']) if (args[key] && !path.isAbsolute(args[key])) throw new Error(`--${key} 必须是绝对路径。`);
    const available = async name => {
      for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        try { await fs.access(path.join(dir, name), fs.constants.X_OK); return true; } catch { /* next PATH entry */ }
      }
      return false;
    };
    const clients = [];
    for (const name of ['claude', 'codex']) if (await available(name)) clients.push(name);
    const client = args.clients === 'auto' ? (clients.length === 2 ? 'both' : clients[0]) : args.clients;
    if (!['claude', 'codex', 'both'].includes(client)) throw new Error('请先安装 Claude Code 或 Codex；--clients 可选 auto、claude、codex、both。');
    if ((client === 'both' ? ['claude', 'codex'] : [client]).some(name => !clients.includes(name))) throw new Error('指定客户端未安装或不在 PATH 中。');
    console.log('[1/3] 检查依赖...');
    const checked = spawnSync(process.execPath, [path.join(root, 'scripts/check-dependencies.mjs')], { cwd: root, stdio: 'ignore' });
    if (checked.status !== 0) {
      const npm = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
      if (npm.error || npm.status !== 0) throw new Error('依赖安装失败，请确认 npm 可用。');
    }
    console.log('[2/3] 校验 MD，配置客户端并迁移已有归档...');
    const { installUser } = await import('../src/install-user.mjs');
    const installed = await installUser({ 'config-md': configMd, client, ...(args['state-dir'] ? { state: args['state-dir'] } : {}), ...(args['client-home'] ? { 'client-home': args['client-home'] } : {}) });
    let service = null;
    if (!args['skip-service']) {
      console.log('[3/3] 注册并启动当前用户的 launchd 后台监听...');
      const { macosService } = await import('../src/macos-service.mjs');
      service = await macosService(installed.configPath);
    } else console.log('[3/3] 已按参数跳过后台服务。');
    const { atomicJson } = await import('../src/common.mjs');
    await atomicJson(path.join(installed.sharedState, 'installation.json'), { ...installed, service, installedAt: new Date().toISOString() });
    console.log('配置完成。重启客户端，从已配置的工作目录打开新对话，按正常流程信任 Hook。');
    console.log('两个目标可访问后，Agent 主动询问姓名；回答后才开始采集。');
    console.log('日常维护：' + configMd);
    console.log('配置入口：' + installed.configPath);
    console.log('自动管理状态：' + installed.stateRoot);
  }
} catch (error) {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
