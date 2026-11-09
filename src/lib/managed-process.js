import { execFile, spawn } from "node:child_process";
import { LineBuffer } from "./line-buffer.js";

function execFilePromise(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class ManagedProcessError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedProcessError";
    this.code = code;
    if (details) this.details = details;
  }
}

export async function terminateProcessTree(
  pid,
  {
    force = true,
    platform = process.platform,
    timeoutMs = 5_000,
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError("pid must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  if (platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    await execFilePromise("taskkill.exe", args, {
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export class ManagedProcess {
  constructor({
    spawnImpl = spawn,
    treeTerminator = terminateProcessTree,
    maxLineBytes = 256 * 1024,
    maxOutputBytes = 1024 * 1024,
    terminationTimeoutMs = 5_000,
  } = {}) {
    if (
      !Number.isSafeInteger(terminationTimeoutMs) ||
      terminationTimeoutMs < 1 ||
      terminationTimeoutMs > 60_000
    ) {
      throw new TypeError("terminationTimeoutMs is outside the supported range");
    }
    this.spawnImpl = spawnImpl;
    this.treeTerminator = treeTerminator;
    this.maxLineBytes = maxLineBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.terminationTimeoutMs = terminationTimeoutMs;
    this.child = null;
    this.exited = false;
    this.limited = false;
    this.stopPromise = null;
    this.outputBytes = 0;
    this.sequence = 0;
    this.done = Promise.resolve({ code: null, signal: null });
  }

  start({
    command,
    args = [],
    cwd,
    env = {},
    input,
    keepStdinOpen = false,
    onLine = () => {},
    onExit = () => {},
    onError = () => {},
    onLimit = () => {},
  }) {
    if (this.child) throw new Error("ManagedProcess can only be started once");
    if (typeof command !== "string" || !command) {
      throw new TypeError("command is required");
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new TypeError("args must contain only strings");
    }
    const child = this.spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const buffers = {
      stdout: new LineBuffer({ maxLineBytes: this.maxLineBytes }),
      stderr: new LineBuffer({ maxLineBytes: this.maxLineBytes }),
    };
    let resolveDone;
    this.done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const emitLines = (stream, lines) => {
      for (const line of lines) {
        this.sequence += 1;
        onLine({ sequence: this.sequence, stream, line });
      }
    };
    const acceptChunk = (stream, chunk) => {
      if (this.exited || this.limited) return;
      this.outputBytes += Buffer.byteLength(chunk);
      if (this.outputBytes > this.maxOutputBytes) {
        this.limited = true;
        onLimit({ code: "PROCESS_OUTPUT_LIMIT" });
        void this.stop({ gracefulMs: 0 }).catch(onError);
        return;
      }
      try {
        emitLines(stream, buffers[stream].push(chunk));
      } catch (error) {
        this.limited = true;
        onLimit({ code: error.code || "PROCESS_OUTPUT_LIMIT" });
        void this.stop({ gracefulMs: 0 }).catch(onError);
      }
    };
    child.stdout?.on("data", (chunk) => acceptChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => acceptChunk("stderr", chunk));
    child.once("error", onError);
    child.stdin?.once("error", onError);
    child.once("close", async (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      try {
        if (!this.limited) {
          emitLines("stdout", buffers.stdout.end());
          emitLines("stderr", buffers.stderr.end());
        }
        await onExit({ code, signal });
      } catch (error) {
        onError(error);
      } finally {
        resolveDone({ code, signal });
      }
    });
    if (keepStdinOpen) { if (input !== undefined) child.stdin?.write(input); }
    else child.stdin?.end(input);
    return { pid: child.pid };
  }

  write(input) {
    if (!this.child?.stdin?.writable || this.exited) throw new ManagedProcessError('PROCESS_NOT_WRITABLE','Process input is closed');
    this.child.stdin.write(input);
  }

  async stop({ gracefulMs = 0 } = {}) {
    if (!Number.isSafeInteger(gracefulMs) || gracefulMs < 0) {
      throw new TypeError("gracefulMs must be a non-negative integer");
    }
    if (!this.child || this.exited) return;
    this.stopPromise ||= this.stopOnce(gracefulMs);
    return this.stopPromise;
  }

  async stopOnce(gracefulMs) {
    if (!this.child.stdin?.destroyed && !this.child.stdin?.ended) {
      this.child.stdin?.end();
    }
    if (gracefulMs > 0) {
      await Promise.race([
        this.done,
        new Promise((resolve) => setTimeout(resolve, gracefulMs)),
      ]);
    }
    if (this.exited) return;
    try {
      await this.terminateTreeWithinLimit();
    } catch (error) {
      this.killDirectly();
      await this.waitForExit();
      if (error instanceof ManagedProcessError) throw error;
      throw new ManagedProcessError(
        "PROCESS_STOP_FAILED",
        "Process tree could not be terminated",
        { cause: error },
      );
    }
    if (!(await this.waitForExit())) {
      this.killDirectly();
      await this.waitForExit();
      throw new ManagedProcessError(
        "PROCESS_STOP_FAILED",
        "Process did not exit after tree termination",
      );
    }
  }

  async terminateTreeWithinLimit() {
    let timer;
    const termination = Promise.resolve()
      .then(() =>
        this.treeTerminator(this.child.pid, {
          force: true,
          timeoutMs: this.terminationTimeoutMs,
        }),
      )
      .then(
        () => ({ status: "completed" }),
        (error) => ({ status: "failed", error }),
      );
    try {
      const outcome = await Promise.race([
        termination,
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "timed-out" }),
            this.terminationTimeoutMs,
          );
        }),
      ]);
      if (outcome.status === "failed") throw outcome.error;
      if (outcome.status === "timed-out") {
        throw new ManagedProcessError(
          "PROCESS_STOP_FAILED",
          "Process tree termination timed out",
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  killDirectly() {
    try {
      this.child?.kill?.("SIGKILL");
    } catch {
      // The caller still receives PROCESS_STOP_FAILED and can run outer cleanup.
    }
  }

  async waitForExit() {
    let timer;
    try {
      return await Promise.race([
        this.done.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.terminationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class ManagedProcessRunner {
  constructor({
    managedProcessFactory = () => new ManagedProcess(),
    clock = () => performance.now(),
  } = {}) {
    this.managedProcessFactory = managedProcessFactory;
    this.clock = clock;
  }

  async run({
    command,
    args = [],
    cwd,
    env = {},
    input,
    timeoutMs = 60_000,
    signal = null,
  }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new ManagedProcessError(
        "INVALID_PROCESS_TIMEOUT",
        "Process timeout is outside the supported range",
      );
    }
    if (signal?.aborted) {
      throw new ManagedProcessError("PROCESS_ABORTED", "Process was aborted");
    }
    if (
      input !== undefined &&
      typeof input !== "string" &&
      !Buffer.isBuffer(input) &&
      !(input instanceof Uint8Array)
    ) {
      throw new ManagedProcessError(
        "INVALID_PROCESS_INPUT",
        "Process input must be text or bytes",
      );
    }
    if (input !== undefined && Buffer.byteLength(input) > 1024 * 1024) {
      throw new ManagedProcessError(
        "INVALID_PROCESS_INPUT",
        "Process input exceeds its limit",
      );
    }
    const processHandle = this.managedProcessFactory();
    const output = { stdout: [], stderr: [] };
    let processError = null;
    let stopError = null;
    let limitCode = null;
    let timedOut = false;
    let aborted = false;
    let stopPromise = null;
    let failureSignaled = false;
    let signalFailure;
    const failure = new Promise((resolve) => {
      signalFailure = () => {
        if (failureSignaled) return;
        failureSignaled = true;
        resolve({ kind: "failure" });
      };
    });
    const stop = () => {
      stopPromise ||= Promise.resolve(
        processHandle.stop({ gracefulMs: 0 }),
      ).catch((error) => {
        stopError ||= error;
        signalFailure();
      });
      return stopPromise;
    };
    const onAbort = () => {
      aborted = true;
      void stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const startedAt = this.clock();
    const snapshot = (exit = null, { truncated = false } = {}) => ({
      exitCode: Number.isSafeInteger(exit?.code) ? exit.code : null,
      signal: exit?.signal ?? null,
      stdout: output.stdout.join("\n"),
      stderr: output.stderr.join("\n"),
      durationMs: Math.max(0, Math.round(this.clock() - startedAt)),
      truncated,
    });
    let timer;
    try {
      try {
        processHandle.start({
          command,
          args,
          cwd,
          env,
          input,
          onLine({ stream, line }) {
            if (stream === "stdout" || stream === "stderr") {
              output[stream].push(line);
            }
          },
          onError(error) {
            processError ||= error;
            signalFailure();
            void stop();
          },
          onLimit(details) {
            limitCode ||= details?.code || "PROCESS_OUTPUT_LIMIT";
            void stop();
          },
        });
      } catch (error) {
        throw new ManagedProcessError(
          "PROCESS_START_FAILED",
          "Process could not be started",
          { cause: error, details: snapshot() },
        );
      }
      timer = setTimeout(() => {
        timedOut = true;
        void stop();
      }, timeoutMs);
      const outcome = await Promise.race([
        processHandle.done.then((exit) => ({ kind: "exit", exit })),
        failure,
      ]);
      if (stopPromise) await stopPromise;
      const exit = outcome.exit;
      const details = snapshot(exit, { truncated: Boolean(limitCode) });
      if (stopError) {
        throw new ManagedProcessError(
          "PROCESS_STOP_FAILED",
          "Process could not be stopped safely",
          { cause: stopError, details },
        );
      }
      if (limitCode) {
        throw new ManagedProcessError(
          "PROCESS_OUTPUT_LIMIT",
          "Process output exceeded its limit",
          { details },
        );
      }
      if (timedOut) {
        throw new ManagedProcessError("PROCESS_TIMEOUT", "Process timed out", {
          details,
        });
      }
      if (aborted) {
        throw new ManagedProcessError("PROCESS_ABORTED", "Process was aborted", {
          details,
        });
      }
      if (processError) {
        throw new ManagedProcessError(
          "PROCESS_FAILED",
          "Process failed unexpectedly",
          { cause: processError, details },
        );
      }
      return {
        ...details,
        exitCode: details.exitCode ?? -1,
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
