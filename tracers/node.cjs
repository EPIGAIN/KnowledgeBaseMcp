// Loaded only for an instrumented terminal command through NODE_OPTIONS.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const original = Object.fromEntries(['readFileSync', 'appendFileSync', 'statSync', 'existsSync', 'realpathSync', 'writeFileSync', 'openSync', 'closeSync', 'writeSync', 'writevSync', 'ftruncateSync'].map(k => [k, fs[k]]));
let config;
try { config = JSON.parse(original.readFileSync(process.env.KB_TRACE_CONFIG, 'utf8')); } catch { return; }
const runtime = `${process.pid}-${crypto.randomUUID()}`;
const logFile = path.join(path.dirname(process.env.KB_TRACE_CONFIG), `${runtime}.jsonl`);
const excluded = new RegExp(config.excludedPattern || '^$', 'i');
const changed = new Map(); const descriptors = new Map();
let guard = false; let operationDepth = 0;
let hashReads = 0; let hashedBytes = 0;
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function fileMark(file) { return signature(original.statSync(file, { bigint: true })); }
let paused = false;
function traceAllowed() {
  if (paused) return false;
  try {
    const gate = JSON.parse(original.readFileSync(config.gateFile, 'utf8'));
    const control = original.existsSync(config.controlFile) ? JSON.parse(original.readFileSync(config.controlFile, 'utf8')) : { enabled: true, revision: 'initial' };
    if (gate.available && gate.epoch === config.epoch && gate.leaseUntil >= Date.now() && control.enabled && control.revision === config.controlRevision) return true;
  } catch {}
  paused = true; emit({ kind: 'paused' }); return false;
}
const within = (root, file) => { const r = path.relative(root, file); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
function eligible(value) {
  try {
    if (!traceAllowed()) return null;
    if (value instanceof URL) value = fileURLToPath(value);
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return null;
    const file = path.resolve(String(value));
    if (!within(config.root, file) || config.excludeRoots.some(root => within(root, file))) return null;
    if (path.relative(config.root, file).split(path.sep).some(part => excluded.test(part))) return null;
    let parent = file;
    while (!original.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    if (!within(original.realpathSync(config.root), original.realpathSync(parent))) return null;
    return file;
  } catch { return null; }
}
function fingerprint(file, expected) {
  if (!traceAllowed()) return null;
  const prior = guard; guard = true;
  try {
    const stat = original.statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    if (expected && signature(stat) !== expected) return null;
    if (stat.size > BigInt(config.maxBytes)) return { sha256: 'oversize', size: Number(stat.size) };
    const bytes = original.readFileSync(file); hashReads++; hashedBytes += bytes.length;
    if (fileMark(file) !== signature(stat)) return null;
    return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: Number(stat.size) };
  } catch { return null; }
  finally { guard = prior; }
}
function emit(data) {
  if (data.kind === 'write' && !traceAllowed()) return;
  try { original.appendFileSync(logFile, JSON.stringify({ runtime, pid: process.pid, time: Date.now(), ...data }) + '\n'); } catch { /* Never change the user's program outcome. */ }
}
function before(value) {
  try {
    const file = !guard && !operationDepth && eligible(value);
    if (!file) return null;
    const previous = changed.get(file);
    // Keep the first baseline; do not hash a growing file before every append.
    return { file, before: previous ? previous.before : fingerprint(file) };
  } catch { return null; }
}
function mark(item) {
  if (!item) return;
  try {
    if (!traceAllowed()) return;
    const previous = changed.get(item.file);
    // Capture metadata at the successful operation. At exit we may hash only
    // this exact version; an intervening writer invalidates the observation.
    changed.set(item.file, { ...item, before: previous ? previous.before : item.before, expected: fileMark(item.file), time: Date.now() });
  } catch { /* Observation failures must not change the program's result. */ }
}
function sync(name, argument) {
  const fn = fs[name];
  fs[name] = function (...args) {
    const item = before(args[argument]); let result;
    operationDepth++;
    try { result = fn.apply(this, args); } finally { operationDepth--; }
    mark(item); return result;
  };
}
function callback(name, argument) {
  const fn = fs[name];
  fs[name] = function (...args) {
    const item = before(args[argument]); const last = args.length - 1; const cb = args[last];
    if (typeof cb !== 'function') return fn.apply(this, args);
    args[last] = function (error, ...result) { if (!error) mark(item); return cb.call(this, error, ...result); };
    return fn.apply(this, args);
  };
}
for (const name of ['writeFile', 'appendFile']) { sync(name + 'Sync', 0); callback(name, 0); }
for (const name of ['copyFile', 'rename']) { sync(name + 'Sync', 1); callback(name, 1); }
const stream = fs.createWriteStream;
fs.createWriteStream = function (...args) { const item = before(args[0]); const result = stream.apply(this, args); result.once('finish', () => mark(item)); return result; };
fs.openSync = function (...args) {
  const item = before(args[0]); const fd = original.openSync.apply(this, args);
  if (item) {
    descriptors.set(fd, item);
    const flags = args[1];
    if (typeof flags === 'string' ? /[wx]/.test(flags) : Boolean(flags & fs.constants.O_TRUNC) || (!item.before && Boolean(flags & fs.constants.O_CREAT))) mark(item);
  }
  return fd;
};
for (const name of ['writeSync', 'writevSync', 'ftruncateSync']) {
  fs[name] = function (...args) { const result = original[name].apply(this, args); mark(descriptors.get(args[0])); return result; };
}
fs.closeSync = function (fd) { try { return original.closeSync(fd); } finally { descriptors.delete(fd); } };
const promises = fs.promises;
for (const [name, index] of [['writeFile', 0], ['appendFile', 0], ['copyFile', 1], ['rename', 1]]) {
  const fn = promises[name].bind(promises);
  promises[name] = async (...args) => { const item = before(args[index]); const result = await fn(...args); mark(item); return result; };
}
const open = promises.open.bind(promises);
promises.open = async (...args) => {
  const item = before(args[0]); const handle = await open(...args);
  if (item) {
    if (/[wx]/.test(String(args[1]))) mark(item);
    for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate']) {
      const fn = handle[name].bind(handle);
      handle[name] = async (...values) => { const result = await fn(...values); mark(item); return result; };
    }
  }
  return handle;
};
require('node:module').syncBuiltinESMExports();
emit({ kind: 'start', language: 'node' });
process.once('exit', code => {
  guard = true;
  for (const item of changed.values()) {
    const after = fingerprint(item.file, item.expected);
    if (after && after.sha256 !== 'oversize') emit({ kind: 'write', time: item.time, path: item.file, before: item.before?.sha256 ?? null, sha256: after.sha256, size: after.size });
    else if (!after && traceAllowed()) emit({ kind: 'conflict', time: item.time, path: item.file });
  }
  emit({ kind: 'end', exitCode: code, hashReads, hashedBytes });
});
