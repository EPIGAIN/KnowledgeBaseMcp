import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { captureIssues, retryObserved } from './hooks.mjs';
import { collectTerminal, terminalStatus } from './terminal.mjs';
import { archiveGuidance, onboarding, profileGuidance } from './onboarding.mjs';
import { assertGate, evaluateGate, gateMessage, setWorkEnabled } from './gate.mjs';
import { withOperation } from './operations.mjs';
import { loadConfig, archiveFile, archiveKnowledge, enqueue, flush, getProfile, jobs, listFiles, readText, searchFiles, setup, sha, slug } from './storage.mjs';

export async function serve(c) {
  c = { ...c, activeRoot: process.cwd() };
  const startupGate = await evaluateGate(c, { cwd: c.activeRoot, onboarding: true });
  const server = new McpServer({ name: 'company-knowledge', version: '0.1.0' }, {
    instructions: '公司知识归档。首次工作对话先 kb_profile 获取最新工作开关和员工状态，两端共用资料。只有配置的工作目录属于工作范围。以下为连接时状态，以 kb_profile 最新结果为准。' + (startupGate.active ? profileGuidance(await getProfile(c)) + ' ' + archiveGuidance : gateMessage(startupGate))
  });
  let requests = Promise.resolve();
  const serialize = fn => args => { const next = requests.then(() => fn(args)); requests = next.catch(() => {}); return next; };
  const register = (name, description, schema, fn, readOnly = false) => server.registerTool(name, {
    description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false }
  }, serialize(async args => {
    try {
      if (c.configFile) c = { ...await loadConfig(c.configFile), activeRoot: process.cwd() };
      if (!['kb_profile', 'kb_status', 'kb_work_switch'].includes(name)) await assertGate(c, { cwd: c.activeRoot, onboarding: name === 'kb_setup' });
      const result = ['kb_profile', 'kb_status', 'kb_work_switch'].includes(name) ? await fn(args) : await withOperation(c, () => fn(args)); return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.code || 'ERROR', message: e.message }) }] }; }
  }));
  const bucket = z.enum(['md', 'files']);
  const saved = async job => { await flush(c); return (await jobs(c)).find(j => j.id === job.id); };
  register('kb_profile', '首次工作对话主动检查员工资料；onboarding.nextAction 为 ask_user_name 时，向用户提出 onboarding.question 并等待姓名，不要求用户主动发起初始化。已登记则不重复询问。', {}, async () => {
    const employee = await getProfile(c);
    const gate = await evaluateGate(c, { cwd: c.activeRoot, onboarding: true });
    return { initialized: Boolean(employee), employee, gate, onboarding: gate.active ? onboarding(employee) : { status: 'paused', nextAction: 'none', question: null }, mdRoot: c.mdRoot, filesRoot: c.filesRoot, workRoots: c.workRoots, workDirectory: c.activeRoot, captureMode: 'new-events-only' };
  }, true);
  register('kb_work_switch', '用户要求暂停或恢复工作归档时使用。MCP、Hook 和后台监听共用此开关；恢复不会补采暂停期间的修改。', { enabled: z.boolean() }, async a => ({ control: await setWorkEnabled(c, a.enabled), gate: await evaluateGate(c, { cwd: c.activeRoot, onboarding: true }) }));
  register('kb_setup', '用户明确告知姓名后调用一次。自动建立两个盘上的员工目录；已绑定后不能切换员工。', { name: z.string().min(1).max(60) }, async a => setup(c, a.name));
  register('kb_upload_file', '将允许的工作目录内文件归档到当前员工目录；.md 进 MD 盘，其他格式进文件盘。', { local_path: z.string().min(1) }, async a => saved(await archiveFile(c, a.local_path)));
  register('kb_read_work_file', '读取工作目录中的文件并按内容版本自动归档。Claude Code/Codex 共用记录，同一文件版本不重复上传。文本最多 2 MiB，其他格式返回信息。', { local_path: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32000).default(32000) }, async a => {
    const job = await archiveFile(c, a.local_path, { tool: 'kb_read_work_file' });
    const result = await saved(job);
    const base = { archive: { id: result.id, status: result.status, destination: result.destination, error: result.error }, source: result.metadata.source, version: result.sha256, size: result.size };
    if (!/\.(md|txt|json|csv|log|mjs|js|ts|py)$/i.test(a.local_path) || result.size > 2 * 1024 * 1024) return { ...base, content_available: false };
    // Read the very snapshot that was archived, not a potentially changed live file.
    await assertGate(c, { cwd: c.activeRoot });
    const bytes = await fs.readFile(path.join(c.stateDir, 'jobs', `${job.id}.blob`));
    try {
      const chars = Array.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const end = Math.min(chars.length, a.offset + a.limit);
      return { ...base, content_available: true, text: chars.slice(a.offset, end).join(''), next_offset: end < chars.length ? end : null };
    } catch { return { ...base, content_available: false, encoding_error: 'UNSUPPORTED_ENCODING' }; }
  });
  register('kb_write_markdown', '保存整理后的 Markdown 到员工 MD 盘，按内容版本去重。', { title: z.string().min(1).max(100), content: z.string().max(2000000) }, async a => {
    const bytes = Buffer.from(a.content, 'utf8');
    return saved(await enqueue(c, bytes, 'md', path.join('工作文档', `${slug(a.title)}__${sha(bytes).slice(0, 16)}.md`), { kind: 'generated' }));
  });
  register('kb_save_knowledge', '保存值得复用的难点解决、排障经验或操作方法。写明实际证据；未验证不得标成已验证。', {
    title: z.string().min(1).max(100), problem: z.string().min(1).max(50000), cause: z.string().max(50000).optional(), solution: z.string().min(1).max(200000),
    verification: z.enum(['已验证', '待验证', '部分验证']).default('待验证'), evidence: z.string().max(50000).optional(), source: z.string().max(1000).optional()
  }, async a => saved(await archiveKnowledge(c, a)));
  register('kb_list_files', '浏览当前员工的 MD 或其他文件目录。', { bucket, path: z.string().default(''), offset: z.number().int().min(0).default(0) }, async a => {
    const all = await listFiles(c, a.bucket, a.path); return { items: all.slice(a.offset, a.offset + 100), next_offset: all.length > a.offset + 100 ? a.offset + 100 : null };
  }, true);
  register('kb_read_file', '分段读取自己目录中的 UTF-8 文本；Office/PDF 返回文件信息。', { bucket, path: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32000).default(32000) }, a => readText(c, a.bucket, a.path, a.offset, a.limit), true);
  register('kb_search', '搜索员工目录中的文件名或 UTF-8 文本内容，返回来源。达到扫描限制时 partial=true。', { bucket, query: z.string().min(1).max(200), mode: z.enum(['filename', 'text']).default('filename') }, a => searchFiles(c, a.bucket, a.query, a.mode), true);
  register('kb_status', '查看上传结果、待重试项与实际保存路径。', {}, async () => {
    const gate = await evaluateGate(c, { cwd: c.activeRoot, onboarding: true });
    if (!gate.active) return { gate, message: gateMessage(gate) };
    const all = await jobs(c); return { totals: all.reduce((s, j) => ({ ...s, [j.status]: (s[j.status] || 0) + 1 }), {}), captureIssues: await captureIssues(c), terminal: await terminalStatus(c), recent: all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(({ id, status, destination, relative, error }) => ({ id, status, destination, relative, error })) };
  }, true);
  register('kb_retry', '网络恢复后重试待上传内容。', {}, async () => { await retryObserved(c); if (c.terminalCapture?.enabled) await collectTerminal(c); return flush(c, { force: true }); });
  await server.connect(new StdioServerTransport());
}
