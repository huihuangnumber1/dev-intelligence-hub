import { StringDecoder } from 'node:string_decoder';
import { SupervisedProcessRunner, didSupervisedProcessNotStart } from './supervised-process-runner.js';
import { codeExecutionWatchdogSignal } from './code-execution-watchdog.js';

// Duplex protocol framing over the same Windows Job Object supervisor used by
// one-shot CLI calls. A child exit alone never certifies process-tree cleanup.
export class ContainedStdioProcess {
  constructor(runner = new SupervisedProcessRunner()) {
    this.runner = runner;
    this.exited = false;
    this.notStarted = false;
  }

  async start({ executable, args, cwd, env, timeoutMs, signal=null, codeExecutionWatchdog=null, maxStdoutBytes, maxStderrBytes,
    onLine, onError, onLimit, onExit }) {
    if (codeExecutionWatchdog !== null) codeExecutionWatchdogSignal(codeExecutionWatchdog);
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let ready, rejectReady;
    const initialized = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    const streams = new Map(['stdout', 'stderr'].map(name => [name, { decoder: new StringDecoder('utf8'), text: '' }]));
    const receive = ({ stream, chunk }) => {
      const state = streams.get(stream);
      state.text += state.decoder.write(chunk);
      let end;
      while ((end = state.text.indexOf('\n')) !== -1) {
        const line = state.text.slice(0, end).replace(/\r$/u, '');
        state.text = state.text.slice(end + 1);
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) { onLimit(); return; }
        onLine({ stream, line });
      }
      if (Buffer.byteLength(state.text) > 16 * 1024 * 1024) onLimit();
    };
    this.done = Promise.resolve().then(() => this.runner.run({ executable, args, cwd, env, timeoutMs,
      ...(codeExecutionWatchdog ? { codeExecutionWatchdog } : {}),
      maxStdoutBytes, maxStderrBytes, signal: controller.signal,
      duplex: { onReady: control => { this.control = control; ready(); }, onOutput: receive },
    })).then(result => {
      this.exited = true;
      onExit(result);
      return { result };
    }, error => {
      this.notStarted = didSupervisedProcessNotStart(error);
      this.exited = error?.code !== 'STRUCTURED_PROVIDER_REAP_FAILED';
      rejectReady(error);
      onError(error);
      return { error };
    }).finally(() => signal?.removeEventListener('abort', abort));
    await initialized;
  }

  write(line) { this.control.write(line); }

  async stop({ gracefulMs = 1_000 } = {}) {
    if (!this.done) return;
    let timer;
    if (!this.exited) {
      this.control?.end();
      timer = setTimeout(() => { this.stopping = true; this.controller.abort(); }, gracefulMs);
    }
    let outcome;
    try { outcome = await this.done; } finally { clearTimeout(timer); }
    if (outcome.error && !(this.stopping && this.exited && outcome.error.code === 'STRUCTURED_PROVIDER_CANCELLED')) {
      throw outcome.error;
    }
  }
}
