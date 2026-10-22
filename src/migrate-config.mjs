import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, exists, readJson, sha, safePath, inside, fail, withStateLock } from './common.mjs';
import { loadConfig, validateConfig } from './storage.mjs';
import { readMarkdownConfig, defaultDataRoot } from './markdown-config.mjs';
import { migrationFile, migrationActive, freezeOperations } from './operations.mjs';
import { probeTargets } from './gate.mjs';
import { installUser } from './install-user.mjs';
import { isNodeCommand } from './runtime-command.mjs';

const samePath = (a, b) => Boolean(a && b && path.relative(a, b) === '');
const rootFor = (c, bucket) => bucket === 'md' ? c.mdRoot : c.filesRoot;
const semantics = c => ({ mdRoot: c.mdRoot, filesRoot: c.filesRoot, workRoots: c.workRoots, stateRoot: c.stateRoot || c.stateDir, sourceMd: c.sourceMd });
const digest = c => sha(JSON.stringify(semantics(c)));
const run = promisify(execFile);

async function stopLegacyProcesses(c) {
  if (!c || c.sourceMd) return 0;
  if (process.platform !== 'win32') throw fail('LEGACY_UPGRADE_REQUIRED', '旧 JSON 安装的自动升级目前支持 Windows；请先停止旧服务并迁移到 MD 配置。');
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  const bin = fileURLToPath(new URL('../bin/kb.mjs', import.meta.url)).replaceAll('\\', '/');
  const command = `$ErrorActionPreference='Stop'\n$target=${quote(c.configFile.replaceAll('\\', '/'))}\n$binary=${quote(bin)}\n$owned=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('\\','/').Contains($target) -and $_.CommandLine.Replace('\\','/').Contains($binary) -and $_.CommandLine -match 'kb\\.mjs[" ]+\\s*(serve|watch|background|hook)\\s+--config' })\nforeach($worker in $owned) { Stop-Process -Id $worker.ProcessId -Force -ErrorAction Stop }\n$owned.Count`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
  return Number(result.stdout.trim()) || 0;
}

async function locateAnchor(options, locations) {
  const home = locations?.home || os.homedir();
  const bin = fileURLToPath(new URL('../bin/kb.mjs', import.meta.url));
  const candidates = [];
  const claude = await readJson(locations?.claudeState || path.join(home, '.claude.json'), {});
  const add = spec => {
    if (!spec) return;
    if (!isNodeCommand(spec.command) || !samePath(spec.args?.[0], bin)) throw fail('CONFIG_CONFLICT', '已注册的知识库 MCP 来自另一份程序，请先明确迁移程序位置。');
    const i = spec.args.indexOf('--config');
    if (i < 0 || !path.isAbsolute(spec.args[i + 1] || '')) throw fail('CONFIG_CONFLICT', '已有 MCP 配置缺少有效入口。');
    candidates.push(path.resolve(spec.args[i + 1]));
  };
  add(claude.mcpServers?.['company-knowledge']);
  const codexDir = locations?.codexDir || (locations ? path.join(home, '.codex') : process.env.CODEX_HOME || path.join(home, '.codex'));
  const text = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const block = text.match(/# BEGIN company-knowledge \(managed by knowledge-mcp\)([\s\S]*?)# END company-knowledge \(managed by knowledge-mcp\)/)?.[1];
  if (block) add({ command: JSON.parse(block.match(/^command = (.+)$/m)?.[1] || 'null'), args: JSON.parse(block.match(/^args = (.+)$/m)?.[1] || 'null') });
  if (candidates.some(p => !samePath(p, candidates[0]))) throw fail('CONFIG_CONFLICT', '两个客户端的员工配置不同，不能自动合并。');
  if (options.config) {
    if (!path.isAbsolute(options.config) || candidates.some(p => !samePath(p, options.config))) throw fail('CONFIG_CONFLICT', '指定入口与现有注册不一致。');
    return path.resolve(options.config);
  }
  return candidates[0] || path.join(defaultDataRoot(locations?.home), 'config.json');
}

async function immutableCopy(source, target, expected) {
  await safePath(path.dirname(source), path.basename(source));
  if (sha(await fs.readFile(source)) !== expected) throw fail('CHECKSUM_MISMATCH', '旧快照缺失或校验失败，迁移未切换配置。');
  await safePath(path.dirname(target), path.basename(target), true);
  try { await fs.link(source, target); }
  catch (error) {
    if (error.code === 'EXDEV' || error.code === 'ENOTSUP' || error.code === 'EPERM') await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e; });
    else if (error.code !== 'EEXIST') throw error;
  }
  if (sha(await fs.readFile(target)) !== expected) throw fail('CHECKSUM_MISMATCH', '新状态快照校验失败。');
}

async function publishSnapshot(c, profile, job, blob) {
  const base = rootFor(c, job.bucket);
  if (!(await fs.stat(base)).isDirectory()) throw fail('INVALID_ROOT', '新存储根目录不存在。');
  const employeeRoot = await safePath(base, profile.folder);
  const target = await safePath(employeeRoot, job.relative, true);
  if (await exists(target)) {
    if (sha(await fs.readFile(target)) !== job.sha256) throw fail('FILE_EXISTS', '新目标存在同名不同内容的文件，已保留该文件。');
    return { target, reused: true };
  }
  const temporary = target + '.' + randomUUID() + '.partial';
  try {
    await fs.copyFile(blob, temporary, fs.constants.COPYFILE_EXCL);
    if (sha(await fs.readFile(temporary)) !== job.sha256) throw fail('CHECKSUM_MISMATCH', '新目标读回校验失败。');
    try { await fs.link(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw fail('ATOMIC_COMMIT_UNSUPPORTED', '新目标不支持无覆盖提交。');
      if (sha(await fs.readFile(target)) !== job.sha256) throw fail('FILE_EXISTS', '并发出现同名不同内容的文件。');
      return { target, reused: true };
    }
    return { target, reused: false };
  } finally { await fs.rm(temporary, { force: true }); }
}

async function copyRegisteredState(old, next, journal) {
  const report = { jobs: 0, copiedArchives: 0, reusedArchives: 0, scopePaused: 0 };
  if (!old) return report;
  await safePath(old.stateDir);
  const profile = await readJson(await safePath(old.stateDir, 'profile.json'), null);
  const control = await readJson(await safePath(old.stateDir, 'control.json'), null);
  if (profile) await atomicJson(path.join(next.stateDir, 'profile.json'), profile);
  if (control) await atomicJson(path.join(next.stateDir, 'control.json'), control);
  const targetsChanged = !samePath(old.mdRoot, next.mdRoot) || !samePath(old.filesRoot, next.filesRoot);
  if (profile && targetsChanged && !(await probeTargets(next)).available) throw fail('MIGRATION_TARGET_OFFLINE', '新目标不可访问，保持旧配置并暂停采集；恢复后重跑安装命令。');
  const directory = await safePath(old.stateDir, 'jobs');
  for (const name of await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const job = await readJson(await safePath(directory, name));
    if (!profile || job.employeeId !== profile.id || job.employeeFolder !== profile.folder || job.id + '.json' !== name || !/^[a-f0-9]{64}$/.test(job.sha256) || !['md', 'files'].includes(job.bucket) || !['pending', 'retry_pending', 'stored', 'scope_paused'].includes(job.status) || job.id !== sha(JSON.stringify([profile.id, job.bucket, job.relative, job.sha256]))) throw fail('INVALID_JOB', '旧队列身份或内容记录不完整。');
    // Only queued snapshots are migrated. No original work file or directory is read.
    const oldBlob = await safePath(directory, job.id + '.blob');
    if ((await fs.stat(oldBlob)).size !== job.size) throw fail('CHECKSUM_MISMATCH', '旧快照大小与登记记录不一致。');
    const newBlob = await safePath(next.stateDir, path.join('jobs', job.id + '.blob'), true);
    await immutableCopy(oldBlob, newBlob, job.sha256);
    const source = job.metadata?.kind ? null : job.metadata?.source;
    const outside = source && !next.workRoots.some(root => inside(root, source));
    if (job.status !== 'stored' && outside) { job.status = 'scope_paused'; report.scopePaused++; }
    const changedBucket = !samePath(rootFor(old, job.bucket), rootFor(next, job.bucket));
    if (changedBucket && job.status !== 'scope_paused') {
      const published = await publishSnapshot(next, profile, job, newBlob);
      job.destination = published.target; job.status = 'stored'; job.storedAt = new Date().toISOString(); delete job.error; delete job.nextAttempt;
      report[published.reused ? 'reusedArchives' : 'copiedArchives']++;
    }
    await atomicJson(path.join(next.stateDir, 'jobs', name), job); report.jobs++;
  }
  const tracked = await safePath(old.stateDir, 'tracked');
  for (const name of await fs.readdir(tracked).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const item = await readJson(await safePath(tracked, name));
    if (typeof item.source === 'string' && next.workRoots.some(root => inside(root, item.source))) await atomicJson(path.join(next.stateDir, 'tracked', name), { ...item, epoch: 'migration-rebaseline', registration: randomUUID() });
  }
  await atomicJson(path.join(next.stateDir, 'migration-ready.json'), { migration: journal.id, report });
  return report;
}

export async function installFromMarkdown(options, locations) {
  if (options['client-home'] && !path.isAbsolute(options['client-home'])) throw fail('INVALID_CONFIG', 'ClientHome 必须是绝对路径。');
  if (options['client-home']) locations = { home: path.resolve(options['client-home']) };
  const md = await readMarkdownConfig(options['config-md']);
  for (const root of md.settings.workRoots) {
    await safePath(root);
    try {
      if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
      await fs.access(root, fs.constants.R_OK);
    } catch { throw fail('WORK_ROOT_UNAVAILABLE', '工作目录必须是已存在且可访问的文件夹，请核对 MD 表格。'); }
  }
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  if (inside(repoRoot, md.path) && !md.path.endsWith('.local.md') && !['.local-private', '.kb-local', '.test-output'].some(name => inside(path.join(repoRoot, name), md.path))) throw fail('PRIVATE_CONFIG_REQUIRED', '实际配置 MD 请放在仓库之外、私有目录中，或命名为 *.local.md，避免提交真实路径。');
  const configPath = await locateAnchor(options, locations);
  await safePath(path.dirname(configPath), path.basename(configPath));
  const coordinator = { stateDir: path.dirname(configPath), configFile: configPath };
  return withStateLock(coordinator, 'migration-owner', async () => {
    const current = await exists(configPath) ? await loadConfig(configPath) : null;
    const stateRoot = options.state ? path.resolve(options.state) : current?.stateRoot || current?.stateDir || path.join(defaultDataRoot(locations?.home), 'state');
    if (options.state && !path.isAbsolute(options.state) || /^\\\\/.test(stateRoot) || process.platform === 'darwin' && /^\/Volumes(?:\/|$)/.test(stateRoot)) throw fail('INVALID_CONFIG', 'StateDir 必须为本机绝对路径，不能放在共享盘或 /Volumes 挂载卷。');
    const oldRoot = current?.stateRoot || current?.stateDir;
    if (oldRoot && !samePath(oldRoot, stateRoot) && (inside(oldRoot, stateRoot) || inside(stateRoot, oldRoot))) throw fail('INVALID_CONFIG', '新旧状态位置不能互相包含。');
    const desired = { ...md.settings, stateRoot, sourceMd: { path: md.path, hash: md.hash } };
    const desiredHash = digest({ ...desired, stateDir: stateRoot });
    let journal = await readJson(migrationFile(coordinator), null);
    const installOptions = { config: configPath, client: options.client || 'both' };
    if (migrationActive(journal) && journal.desiredHash !== desiredHash) throw fail('MIGRATION_PENDING', '有尚未完成的迁移。请恢复对应 MD 后重试，或先执行 cancel-migration。');
    if (current && (!migrationActive(journal)) && digest(current) === desiredHash) {
      const result = await installUser(installOptions, locations);
      return { ...result, settingsFile: md.path, stateRoot, migration: { changed: false } };
    }
    if (!migrationActive(journal)) {
      const id = randomUUID();
      const next = validateConfig({ ...current, ...desired, version: 3, scope: 'user', captureMode: 'new-events-only', configFile: configPath,
        stateDir: path.join(stateRoot, 'generations', id), revision: id, enabledAt: new Date().toISOString(), terminalCapture: { enabled: true, version: 2 },
        privateRoots: [...new Set([...(current?.privateRoots || []), path.dirname(configPath), stateRoot, ...(oldRoot ? [oldRoot] : [])])], maxBytes: current?.maxBytes || 104857600 });
      // Client conflicts and local state placement are checked before any copy.
      await installUser({ ...installOptions, _candidateConfig: next, _planOnly: true }, locations);
      await safePath(stateRoot, path.relative(stateRoot, next.stateDir));
      await safePath(next.mdRoot); await safePath(next.filesRoot);
      journal = { id, phase: 'preparing', desiredHash, oldConfig: current, nextConfig: next, createdAt: new Date().toISOString() };
    }
    const old = journal.oldConfig, next = journal.nextConfig;
    if (current && current.revision !== old?.revision && current.revision !== next.revision) throw fail('CONFIG_CONFLICT', '运行配置在迁移期间被修改。');
    try {
      if (current?.revision !== next.revision) {
        await freezeOperations(old || next, { ...journal, phase: 'copying' });
        const stoppedLegacyServices = await stopLegacyProcesses(old);
        await safePath(stateRoot, path.relative(stateRoot, next.stateDir), true);
        await fs.mkdir(next.stateDir, { recursive: true });
        const report = { ...await copyRegisteredState(old, next, journal), stoppedLegacyServices, restartClientsRequired: Boolean(old && !old.sourceMd) };
        if ((await readMarkdownConfig(md.path)).hash !== md.hash) throw fail('CONFIG_CHANGED_DURING_MIGRATION', 'MD 在迁移期间又被修改，未切换配置。');
        if (old) await atomicJson(path.join(path.dirname(configPath), 'config-history', journal.id + '.json'), old);
        await atomicJson(configPath, next);
        journal = { ...journal, phase: 'committed', report };
        await atomicJson(migrationFile(coordinator), journal);
      }
      if (!journal.report) journal.report = (await readJson(path.join(next.stateDir, 'migration-ready.json'), null))?.report;
      const installed = await installUser(installOptions, locations);
      await atomicJson(migrationFile(coordinator), { ...journal, phase: 'complete', completedAt: new Date().toISOString() });
      return { ...installed, settingsFile: md.path, stateRoot, migration: { changed: true, ...(journal.report || {}), retainedPreviousState: old?.stateDir || null } };
    } catch (error) {
      await atomicJson(migrationFile(coordinator), { ...journal, phase: 'failed', error: { code: error.code || 'MIGRATION_FAILED', message: error.message } });
      throw error;
    }
  });
}

export async function cancelMigration(configPath) {
  const coordinator = { stateDir: path.dirname(configPath), configFile: configPath };
  return withStateLock(coordinator, 'migration-owner', async () => {
    const journal = await readJson(migrationFile(coordinator), null);
    if (!migrationActive(journal)) return { cancelled: false, reason: 'no_pending_migration' };
    const current = await readJson(configPath, null);
    if (current?.revision === journal.nextConfig.revision) throw fail('MIGRATION_COMMITTED', '配置已提交，请重跑原安装命令完成收尾，不能取消。');
    await atomicJson(migrationFile(coordinator), { ...journal, phase: 'cancelled', cancelledAt: new Date().toISOString() });
    return { cancelled: true, message: '旧配置保留。请把 MD 表格恢复为旧设置后再启用；新位置已复制的文件不会自动删除。' };
  });
}
