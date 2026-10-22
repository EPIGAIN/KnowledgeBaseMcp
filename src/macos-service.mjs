import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, sha, safePath, withStateLock } from './common.mjs';
import { loadConfig } from './storage.mjs';
import { isNodeCommand } from './runtime-command.mjs';

const exec = promisify(execFile);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const binary = fileURLToPath(new URL('../bin/kb.mjs', import.meta.url));

export function servicePlan(configFile, { home = os.homedir(), node = process.execPath, bin = binary } = {}) {
  if (![configFile, home, node, bin].every(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p))) throw new Error('服务路径必须为不含控制字符的绝对路径。');
  const config = path.resolve(configFile);
  const label = 'com.companyknowledge.mcp.' + sha(config).slice(0, 12);
  return {
    label, file: path.join(home, 'Library', 'LaunchAgents', label + '.plist'),
    config, args: [node, bin, 'watch', '--config', config],
    cwd: path.dirname(path.dirname(bin)),
    errorLog: path.join(path.dirname(config), 'logs', 'watcher.stderr.log')
  };
}

export function renderPlist(p) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(p.label)}</string>
<key>ProgramArguments</key><array>${p.args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(p.cwd)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>${xml(p.errorLog)}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>
`;
}

function owned(data, p) {
  return data.Label === p.label && Array.isArray(data.ProgramArguments) &&
    isNodeCommand(data.ProgramArguments[0]) && JSON.stringify(data.ProgramArguments.slice(1)) === JSON.stringify(p.args.slice(1));
}

// Runtime injection is only for portable tests; the public CLI has no OS override.
export async function macosService(configFile, { remove = false } = {}, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform !== 'darwin') throw new Error('此服务命令只适用于 macOS。');
  const uid = runtime.uid ?? process.getuid();
  if (uid === 0) throw new Error('请以员工当前登录用户运行，不要使用 sudo。');
  const p = servicePlan(configFile, runtime);
  const run = runtime.run || ((file, args) => exec(file, args, { timeout: 15000, maxBuffer: 512 * 1024 }));
  const sleep = runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const alive = runtime.alive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
  const domain = `gui/${uid}`, target = `${domain}/${p.label}`;
  await loadConfig(p.config);
  await safePath(p.file); await safePath(p.errorLog);
  return withStateLock({ stateDir: path.dirname(p.config) }, 'macos-service', async () => {
    const previous = await fs.readFile(p.file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (previous !== null) {
      const parsed = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p.file]);
      if (!owned(JSON.parse(parsed.stdout), p)) throw new Error('同名 LaunchAgent 不属于此配置，拒绝覆盖或移除。');
    }
    const printed = await run('/bin/launchctl', ['print', target]).catch(e => {
      // Only a normal nonzero exit means absent; timeouts/spawn failures must surface.
      if (typeof e.code !== 'number' || e.killed) throw e;
      return null;
    });
    if (printed) {
      const registered = printed.stdout.match(/^\s*path = (.+)$/m)?.[1];
      if (!previous || registered !== p.file) throw new Error('同名运行服务来源不明，拒绝停止。');
    }
    const stop = async () => {
      if (!printed) return;
      const pid = Number(printed.stdout.match(/^\s*pid = (\d+)$/m)?.[1]);
      await run('/bin/launchctl', ['bootout', target]);
      if (!(pid > 0)) return;
      for (let n = 0; n < 60 && alive(pid); n++) await sleep(250);
      if (alive(pid)) throw new Error('旧监听进程尚未退出，已保留配置；稍后重试。');
    };
    if (remove) {
      await stop();
      if (previous !== null) await fs.rm(p.file);
      return { removed: true, label: p.label, file: p.file };
    }
    await fs.mkdir(path.dirname(p.file), { recursive: true });
    await fs.mkdir(path.dirname(p.errorLog), { recursive: true, mode: 0o700 });
    const temp = p.file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, renderPlist(p), { flag: 'wx', mode: 0o600 });
    let replaced = false;
    const started = Date.now();
    try {
      await run('/usr/bin/plutil', ['-lint', temp]);
      await stop();
      await fs.rename(temp, p.file); replaced = true;
      await run('/bin/launchctl', ['enable', target]);
      await run('/bin/launchctl', ['bootstrap', domain, p.file]);
    } catch (error) {
      if (replaced) {
        if (previous === null) await fs.rm(p.file, { force: true });
        else await fs.writeFile(p.file, previous, { mode: 0o600 });
      }
      if (printed) await run('/bin/launchctl', ['bootstrap', domain, p.file]).catch(() => {});
      throw error;
    } finally { await fs.rm(temp, { force: true }); }
    // A fresh status and matching launchd PID confirm the worker, not merely its plist.
    let status;
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(500);
      const config = await loadConfig(p.config);
      status = await readJson(path.join(config.stateDir, 'watcher-status.json'), null);
      if (!status || !(Date.parse(status.checkedAt) >= started)) continue;
      const running = await run('/bin/launchctl', ['print', target]);
      if (Number(running.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) !== status.pid) continue;
      if (status.status === 'error') throw new Error('监听进程报告错误，请检查 watcher-status.json。');
      const result = { installed: true, label: p.label, file: p.file, configPath: p.config, status: status.status };
      await atomicJson(path.join(path.dirname(p.config), 'macos-service.json'), result);
      return result;
    }
    throw new Error('LaunchAgent 已注册，但未收到监听进程的新状态；请检查系统后台项目权限和 watcher.stderr.log，修正后重跑安装。');
  });
}
