import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { freemem } from 'node:os';

export const HELPER_DIAGNOSTIC_LIMITS = Object.freeze({ helpers: 8, bytes: 8192 });

// Test-worker observation only. The original executable, arguments, callback,
// signal and return value pass through unchanged. Never record their contents.
export function observePrivateDirectoryHelpers(t, { sink = value => t.diagnostic(value) } = {}) {
  const started = performance.now(), cpu = process.cpuUsage();
  const records = [], detach = [], closes = [];
  let omittedHelpers = 0, failed = false, finished = false, sinkFailed = false;
  const now = () => Math.round((performance.now() - started) * 1000) / 1000;
  const load = () => ({ cpuMicros: process.cpuUsage(cpu), rssBytes: process.memoryUsage.rss(), hostFreeBytes: freemem() });
  const initialLoad = load();
  const original = childProcess.execFile;
  const wrapped = function (...args) {
    let phase = null;
    if (Array.isArray(args[1]) && args[1].includes('-EncodedCommand')) {
      const script = Buffer.from(args[1].at(-1), 'base64').toString('utf16le');
      if (script.includes('MYDASHBOARD_PRIVATE_PATH')) {
        if (script.includes('$acl = Get-Acl -LiteralPath')) phase = 'acl-read';
        else if (script.includes('MyDashboardPrivateDirectory')) phase = 'native-create';
      }
    }
    if (phase === null) return Reflect.apply(original, this, args);
    if (records.length === HELPER_DIAGNOSTIC_LIMITS.helpers) {
      omittedHelpers += 1;
      return Reflect.apply(original, this, args);
    }
    const record = { phase, pid: null, launchMs: now(), spawnMs: null, abortMs: null,
      errorMs: null, exitMs: null, closeMs: null, abortKind: null, childError: null,
      exitCode: null, signal: null, launchLoad: load(), closeLoad: null };
    records.push(record);
    const child = Reflect.apply(original, this, args);
    const signal = args[2]?.signal;
    const onSpawn = () => { record.spawnMs = now(); record.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null; };
    const onAbort = () => {
      record.abortMs = now();
      record.abortKind = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
    };
    const onError = error => {
      record.errorMs = now();
      record.childError = ['ABORT_ERR', 'ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'other';
    };
    const onExit = (code, value) => {
      record.exitMs = now(); record.exitCode = Number.isSafeInteger(code) ? code : null;
      record.signal = ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(value) ? value : null;
    };
    let resolveClose;
    closes.push(new Promise(resolve => { resolveClose = resolve; }));
    const remove = () => {
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('spawn', onSpawn); child.removeListener('error', onError);
      child.removeListener('exit', onExit); child.removeListener('close', onClose);
    };
    const onClose = () => { record.closeMs = now(); record.closeLoad = load(); remove(); resolveClose(); };
    child.once('spawn', onSpawn); child.once('error', onError);
    child.once('exit', onExit); child.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    detach.push(remove);
    return child;
  };
  childProcess.execFile = wrapped;
  syncBuiltinESMExports();
  const snapshot = () => {
    const helpers = records.map(record => ({ ...record, missingEvents: ['spawn', 'exit', 'close'].filter(event => record[`${event}Ms`] === null) }));
    const value = { kind: 'private-directory-helper-diagnostic', workerPid: process.pid, parentPid: process.ppid, elapsedMs: now(), failed,
      omittedHelpers, initialLoad, finalLoad: load(), helpers };
    while (Buffer.byteLength(JSON.stringify(value)) > HELPER_DIAGNOSTIC_LIMITS.bytes && value.helpers.length) {
      value.helpers.pop(); value.omittedHelpers += 1;
    }
    return value;
  };
  const finish = () => {
    if (!finished) {
      finished = true;
      for (const remove of detach) remove();
      if (childProcess.execFile === wrapped) childProcess.execFile = original;
      syncBuiltinESMExports();
      t.signal.removeEventListener('abort', onTestAbort);
      if (failed) { try { sink(JSON.stringify(snapshot())); } catch { sinkFailed = true; } }
    }
    return { ...snapshot(), sinkFailed };
  };
  const onTestAbort = () => { failed = true; finish(); };
  t.signal.addEventListener('abort', onTestAbort, { once: true });
  t.after(finish);
  return Object.freeze({
    async run(operation) { try { return await operation(); } catch (error) { failed = true; throw error; } },
    snapshot, finish,
    // Only diagnostic validation fixtures wait; original ACL tests never do.
    settled: () => Promise.all(closes),
  });
}
