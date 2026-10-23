#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, flush, jobs } from '../src/storage.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, 'config-md': { type: 'string' }, client: { type: 'string' }, scope: { type: 'string' }, workspace: { type: 'string' }, 'work-root': { type: 'string', multiple: true }, state: { type: 'string' }, 'md-root': { type: 'string' }, 'files-root': { type: 'string' }, 'client-home': { type: 'string' }, force: { type: 'boolean', default: false }, once: { type: 'boolean', default: false }
} });
try {
  const command = positionals[0];
  if (command === 'install') {
    const { install } = await import('../src/install.mjs');
    console.log(JSON.stringify(await install({ ...values, scope: values.scope || 'user' }), null, 2));
  } else {
    if (!values.config) throw new Error('请提供 --config 配置文件路径。');
    if (command === 'service-install-macos' || command === 'service-remove-macos') {
      const { macosService } = await import('../src/macos-service.mjs');
      console.log(JSON.stringify(await macosService(values.config, { remove: command === 'service-remove-macos' }), null, 2));
      process.exit(0);
    }
    if (command === 'cancel-migration') {
      const { cancelMigration } = await import('../src/migrate-config.mjs');
      console.log(JSON.stringify(await cancelMigration(values.config), null, 2));
      process.exit(0);
    }
    const config = await loadConfig(values.config);
    if (command === 'serve') { const { serve } = await import('../src/server.mjs'); await serve(config, { client: values.client || 'standard' }); }
    else if (command === 'hook') {
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Hook 输入过大。'); }
      const { handleHook } = await import('../src/hooks.mjs');
      const client = values.client || 'claude';
      if (!['claude', 'codex'].includes(client)) throw new Error('Hook client 必须为 claude 或 codex。');
      console.log(JSON.stringify(await handleHook(config, { ...JSON.parse(input), client })));
    } else if (command === 'flush') {
      const { retryObserved } = await import('../src/hooks.mjs');
      await retryObserved(config);
      if (config.terminalCapture?.enabled) { const { collectTerminal } = await import('../src/terminal.mjs'); await collectTerminal(config); }
      console.log(JSON.stringify(await flush(config, { force: values.force }), null, 2));
    }
    else if (command === 'status') console.log(JSON.stringify(await jobs(config), null, 2));
    else if (command === 'pause' || command === 'resume') {
      const { setWorkEnabled, evaluateGate } = await import('../src/gate.mjs');
      await setWorkEnabled(config, command === 'resume');
      console.log(JSON.stringify(await evaluateGate(config, { onboarding: true }), null, 2));
    }
    else if (command === 'watch') {
      const { watch } = await import('../src/watcher.mjs');
      await watch(config, { once: values.once });
    }
    else if (command === 'background') {
      const { background } = await import('../src/background.mjs');
      const result = await background(config);
      // Task Scheduler can provide a hidden console whose stdout never drains.
      // The report has already been durably written; no console output is
      // required for this one-shot command.
      process.exit(result.exitCode);
    }
    else throw new Error('命令：install / serve / hook / flush / status / background / watch / pause / resume');
  }
} catch (e) {
  console.error(`${e.code || 'ERROR'}: ${e.message}`);
  process.exitCode = 1;
}
