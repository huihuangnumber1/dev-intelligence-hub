import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-dpapi-helper.ps1', import.meta.url));
const failure = () => Object.assign(new Error('Windows credential protection is unavailable'), { code: 'DPAPI_OPERATION_FAILED' });

// Never use the supervised CLI runner here: its Windows stdin spool is a file.
// This fixed, child-free helper receives secrets only through an anonymous pipe.
export class WindowsDpapi {
  async #operate(operation, data, entropy, { signal } = {}) {
    if (process.platform !== 'win32' || !Buffer.isBuffer(data) || data.length < 1 || data.length > 65536 ||
        !Buffer.isBuffer(entropy) || entropy.length < 1 || entropy.length > 1024) throw failure();
    signal?.throwIfAborted();
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      const child = spawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks = []; let bytes = 0, invalid = false;
      const abort = () => { invalid = true; child.kill(); };
      const timer = setTimeout(abort, 15000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 131072) abort(); else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => { invalid = true; });
      child.on('error', () => { invalid = true; });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        try {
          signal?.throwIfAborted();
          if (invalid || code !== 0) throw failure();
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const result = Buffer.from(response.data ?? '', 'base64');
          if (response.ok !== true || result.length < 1 || result.length > 65536 || result.toString('base64') !== response.data) throw failure();
          resolve(result);
        } catch { reject(signal?.aborted ? signal.reason : failure()); }
        finally { for (const chunk of chunks) chunk.fill(0); }
      });
      child.stdin.end(JSON.stringify({ operation, data: data.toString('base64'), entropy: entropy.toString('base64') }));
      if (signal?.aborted) abort();
    });
  }

  protect(data, entropy, options) { return this.#operate('protect', data, entropy, options); }
  unprotect(data, entropy, options) { return this.#operate('unprotect', data, entropy, options); }
}
