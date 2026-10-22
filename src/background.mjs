import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicJson, getProfile, jobs } from './storage.mjs';
import { captureIssues, retryObserved } from './hooks.mjs';
import { flush } from './storage.mjs';
import { collectTerminal, terminalStatus } from './terminal.mjs';
import { evaluateGate } from './gate.mjs';

export async function background(c) {
  const startedAt = new Date().toISOString();
  let report;
  try {
    const gate = await evaluateGate(c, { onboarding: true });
    if (!gate.active) {
      report = { status: gate.status, processed: 0, counts: {}, message: '工作归档暂停，不补采暂停期间的文件。' };
    } else if (!await getProfile(c)) {
      report = { status: 'awaiting_name', message: '等待员工首次填写姓名；未创建员工目录或上传文件。', processed: 0, counts: {} };
    } else {
      await retryObserved(c);
      if (c.terminalCapture?.enabled) await collectTerminal(c);
      const processed = await flush(c);
      const all = await jobs(c);
      const counts = all.reduce((acc, job) => ({ ...acc, [job.status]: (acc[job.status] || 0) + 1 }), {});
      const issues = await captureIssues(c);
      const terminal = c.terminalCapture?.enabled ? await terminalStatus(c) : { counts: {}, issues: [] };
      issues.push(...terminal.issues);
      const terminalPending = (terminal.counts.prepared || 0) + (terminal.counts.waiting_for_runtime || 0) + (terminal.counts.waiting_for_completion || 0);
      const status = counts.retry_pending || issues.length ? 'attention_required' : counts.pending || terminalPending ? 'pending' : 'ok';
      report = { status, processed: processed.length, counts, terminal: terminal.counts, issues: issues.length, failures: all.filter(j => j.status === 'retry_pending').map(j => ({ id: j.id, error: j.error, nextAttempt: j.nextAttempt })) };
    }
  } catch (error) {
    report = { status: 'error', error: { code: error.code || 'ERROR', message: error.message } };
  }
  report = { ...report, startedAt, finishedAt: new Date().toISOString(), pid: process.pid };
  await atomicJson(path.join(c.stateDir, 'last-background-run.json'), report);
  await fs.writeFile(path.join(c.stateDir, 'last-background-run.txt'), JSON.stringify(report, null, 2), 'utf8');
  return { report, exitCode: report.status === 'error' ? 1 : report.status === 'attention_required' ? 2 : 0 };
}
