import { execFile } from 'node:child_process';
import { uptime } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseJsonWithUniqueKeys } from './strict-json.js';

const execute = promisify(execFile);
let identity = null;
let pending = null;
let retryAfter = 0;

export function normalizeWindowsBootIdentity(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'machineDigest,recordId,schemaVersion,startedAt,uptimeMs' ||
      value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.machineDigest ?? '') ||
      typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
      new Date(value.startedAt).toISOString() !== value.startedAt || Date.parse(value.startedAt) > now ||
      !Number.isSafeInteger(value.recordId) || value.recordId < 1 ||
      !Number.isSafeInteger(value.uptimeMs) || value.uptimeMs < 0) return null;
  return { ...value };
}

// A process cannot survive a full kernel boot. Cache its boot identity, but read
// the live uptime counter on every use; Windows libuv uptime uses GetTickCount64.
export async function readWindowsBootIdentity() {
  if (process.platform !== 'win32') return null;
  if (!identity) {
    if (Date.now() < retryAfter) return null;
    pending ??= (async () => {
      try {
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const executable = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const script = path.resolve(import.meta.dirname, '../../scripts/read-windows-boot-identity.ps1');
        const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
          windowsHide: true, timeout: 30000, maxBuffer: 4096,
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
        });
        const value = normalizeWindowsBootIdentity({ ...parseJsonWithUniqueKeys(stdout.trim()), uptimeMs: Math.floor(uptime() * 1000) });
        if (!value) throw new Error('Invalid boot identity');
        identity = value;
      } catch { retryAfter = Date.now() + 60000; }
      finally { pending = null; }
    })();
    await pending;
  }
  return identity ? { ...identity, uptimeMs: Math.floor(uptime() * 1000) } : null;
}
