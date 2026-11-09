import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { terminateProcessTree } from "./managed-process.js";
import { materializeVerifiedCliDescriptor } from "./known-cli-locator.js";
import { normalizeAbortSignal } from "./structured-provider-request.js";
import { codeExecutionWatchdogSignal } from './code-execution-watchdog.js';

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// Codex JSON traces include tool reads; the structured final response has its
// own smaller bound in the provider. Keep stderr at the diagnostic bound.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_ENVIRONMENT_FIELDS = 256;
const MAX_WRAPPER_PACKET_BYTES = 3 * 1024 * 1024;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_EXECUTABLE_DIGEST = /^[a-f0-9]{64}$/;
const INVALID_PROCESS_TEXT = /[\u0000\r\n]/;
const WINDOWS_WRAPPER_PATH = fileURLToPath(
  new URL("./windows-process-tree-wrapper.ps1", import.meta.url),
);
const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const REAPED_FAILURE_OUTPUT = new WeakMap();
const PROCESS_NOT_STARTED = new WeakSet();
const PRODUCTION_RUNNERS = new WeakSet();

export function isProductionSupervisedProcessRunner(value) {
  return PRODUCTION_RUNNERS.has(value) && value.run === SupervisedProcessRunner.prototype.run;
}

// Only the runner can certify that execution failed before a spawn attempt.
// Error codes and caller-created error objects cannot carry this authority.
export function didSupervisedProcessNotStart(error) {
  return PROCESS_NOT_STARTED.has(error);
}

// Failure output remains process-private instead of becoming loggable Error data.
export function readReapedProcessFailureOutput(error) {
  const stdoutBytes = REAPED_FAILURE_OUTPUT.get(error);
  return stdoutBytes === undefined
    ? null
    : Object.freeze({ stdoutBytes: Buffer.from(stdoutBytes) });
}

export class SupervisedProcessError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "SupervisedProcessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function processError(code, message, statusCode) {
  return new SupervisedProcessError(code, message, statusCode);
}

function unavailableError() {
  return processError(
    "STRUCTURED_PROVIDER_UNAVAILABLE",
    "Structured CLI provider is unavailable",
    503,
  );
}

function cancelledError() {
  return processError(
    "STRUCTURED_PROVIDER_CANCELLED",
    "Structured CLI provider request was cancelled",
    499,
  );
}

function timeoutError() {
  return processError(
    "STRUCTURED_PROVIDER_TIMEOUT",
    "Structured CLI provider request timed out",
    504,
  );
}

function outputLimitError() {
  return processError(
    "STRUCTURED_PROVIDER_OUTPUT_LIMIT",
    "Structured CLI provider output exceeded its limit",
    502,
  );
}

function failedError() {
  return processError(
    "STRUCTURED_PROVIDER_PROCESS_FAILED",
    "Structured CLI provider process failed",
    502,
  );
}

function exitedError() {
  return processError(
    "STRUCTURED_PROVIDER_PROCESS_EXITED",
    "Structured CLI provider process exited unsuccessfully",
    502,
  );
}

function reapFailedError() {
  return processError(
    "STRUCTURED_PROVIDER_REAP_FAILED",
    "Structured CLI provider process could not be reaped safely",
    500,
  );
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is outside the supported range`);
  }
  return value;
}

function processCommand(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    INVALID_PROCESS_TEXT.test(value)
  ) {
    throw new TypeError("command must be an absolute executable path");
  }
  return value;
}

function processArguments(value) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ARGUMENTS
  ) {
    throw new TypeError("args are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError("args are invalid");
  }
  let totalBytes = 0;
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    const argument = descriptor?.value;
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof argument !== "string" ||
      argument.includes("\u0000")
    ) {
      throw new TypeError("args are invalid");
    }
    totalBytes += Buffer.byteLength(argument, "utf8");
    if (totalBytes > MAX_ARGUMENT_BYTES) {
      throw new TypeError("args exceed their limit");
    }
    result.push(argument);
  }
  return result;
}

function processWorkingDirectory(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    INVALID_PROCESS_TEXT.test(value)
  ) {
    throw new TypeError("cwd must be an absolute path");
  }
  return value;
}

function processEnvironment(value, platform) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("env must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_ENVIRONMENT_FIELDS) {
    throw new TypeError("env exceeds its limit");
  }
  const seenNames = new Set();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const comparisonName = platform === "win32" && typeof key === "string"
      ? key.toLowerCase()
      : key;
    if (
      typeof key !== "string" ||
      !SAFE_ENVIRONMENT_NAME.test(key) ||
      seenNames.has(comparisonName) ||
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\u0000") ||
      Buffer.byteLength(descriptor.value, "utf8") > 32 * 1024
    ) {
      throw new TypeError("env is invalid");
    }
    seenNames.add(comparisonName);
    result[key] = descriptor.value;
  }
  return result;
}

function processInput(value) {
  if (
    typeof value !== "string" &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  ) {
    throw new TypeError("input must be text or bytes");
  }
  const result = Buffer.from(value);
  if (result.byteLength > MAX_INPUT_BYTES) {
    throw new TypeError("input exceeds its limit");
  }
  return result;
}

function processDescriptor(value, requireDigest) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw unavailableError();
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = requireDigest
    ? ["command", "prefixArgs", "sha256"]
    : ["command", "prefixArgs"];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw unavailableError();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw unavailableError();
    }
  }
  if (requireDigest && !SAFE_EXECUTABLE_DIGEST.test(value.sha256)) {
    throw unavailableError();
  }
  return {
    command: processCommand(value.command),
    prefixArgs: processArguments(value.prefixArgs),
    sha256: requireDigest ? value.sha256 : null,
  };
}

function appendOutput(state, chunk, maximum) {
  if (state.error) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += bytes.byteLength;
  if (state.bytes > maximum) {
    state.error = outputLimitError();
    return;
  }
  state.chunks.push(bytes);
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw new TypeError("Windows system root is unavailable");
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsWrapperEnvironment() {
  const result = {
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    NO_COLOR: "1",
  };
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "PSModulePath",
    "ComSpec",
  ]) {
    const value = process.env[name];
    if (typeof value === "string" && !value.includes("\u0000")) {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

function windowsContainedInvocation(
  invocation,
  powerShell,
  wrapperPath,
  reapTimeoutMs,
  interactive = false,
) {
  const packet = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    environment: invocation.env,
    inputBase64: invocation.input.toString("base64"),
    expectedSha256: invocation.executableSha256,
    reapTimeoutMs,
  }), "utf8");
  if (packet.byteLength > MAX_WRAPPER_PACKET_BYTES) {
    throw new TypeError("process invocation exceeds its internal limit");
  }
  return {
    command: powerShell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapperPath,
      ...(interactive ? ["-Interactive"] : []),
    ],
    cwd: invocation.cwd,
    env: windowsWrapperEnvironment(),
    input: interactive ? Buffer.concat([packet, Buffer.from("\n")]) : packet,
    detached: false,
  };
}

async function withinDeadline(operation, timeoutMs) {
  let timer;
  const outcome = Promise.resolve()
    .then(operation)
    .then(
      () => ({ status: "completed" }),
      () => ({ status: "failed" }),
    );
  try {
    return await Promise.race([
      outcome,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingRequestTime(startedAt, timeoutMs) {
  return timeoutMs - (performance.now() - startedAt);
}

function materializeBeforeDeadline(operation, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let terminalError = null;
    let timer;
    const controller = new AbortController();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const cancel = (error) => {
      if (settled || terminalError) return;
      terminalError = error;
      controller.abort(error);
      if (!started) settle(reject, error);
    };
    const onAbort = () => cancel(cancelledError());

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => cancel(timeoutError()),
      Math.max(1, Math.ceil(timeoutMs)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(async () => {
        if (settled || terminalError || signal?.aborted) return;
        started = true;
        try {
          const value = await operation(controller.signal);
          if (terminalError) settle(reject, terminalError);
          else settle(resolve, value);
        } catch (error) {
          settle(reject, terminalError ?? error);
        }
      })
      .then(
        () => {},
        (error) => settle(reject, terminalError ?? error),
      );
  });
}

export class SupervisedProcessRunner {
  #spawnImpl;
  #treeTerminator;
  #descriptorMaterializer;
  #requireDescriptorDigest;
  #platform;
  #terminationTimeoutMs;
  #windowsPowerShell;
  #windowsWrapperPath;

  constructor(constructionToken, testDependencies) {
    if (arguments.length > 0 && constructionToken !== TEST_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        "Production process supervision does not accept replacement dependencies",
      );
    }
    const dependencies = constructionToken === TEST_CONSTRUCTION_TOKEN
      ? testDependencies
      : {};
    const {
      spawnImpl = spawn,
      treeTerminator = terminateProcessTree,
      descriptorMaterializer = materializeVerifiedCliDescriptor,
      platform = process.platform,
      terminationTimeoutMs = 5_000,
      windowsPowerShell = null,
      windowsWrapperPath = WINDOWS_WRAPPER_PATH,
    } = dependencies;
    if (typeof spawnImpl !== "function" || typeof treeTerminator !== "function") {
      throw new TypeError("process supervision dependencies are invalid");
    }
    if (typeof descriptorMaterializer !== "function") {
      throw new TypeError("process descriptor materializer is invalid");
    }
    if (!new Set(["win32", "linux", "darwin"]).has(platform)) {
      throw new TypeError("process platform is invalid");
    }
    this.#spawnImpl = spawnImpl;
    this.#treeTerminator = treeTerminator;
    this.#descriptorMaterializer = descriptorMaterializer;
    this.#requireDescriptorDigest = constructionToken !== TEST_CONSTRUCTION_TOKEN;
    this.#platform = platform;
    this.#terminationTimeoutMs = boundedInteger(
      terminationTimeoutMs,
      "terminationTimeoutMs",
      60_000,
    );
    this.#windowsPowerShell = platform === "win32"
      ? processCommand(windowsPowerShell ?? windowsPowerShellPath())
      : null;
    this.#windowsWrapperPath = platform === "win32"
      ? processCommand(windowsWrapperPath)
      : null;
    if (constructionToken !== TEST_CONSTRUCTION_TOKEN) PRODUCTION_RUNNERS.add(this);
    Object.freeze(this);
  }

  async run(options) {
    let spawnAttempted = false;
    try {
      return await this.#run(options, () => { spawnAttempted = true; });
    } catch (error) {
      if (!spawnAttempted && error !== null &&
          (typeof error === "object" || typeof error === "function")) {
        PROCESS_NOT_STARTED.add(error);
      }
      throw error;
    }
  }

  async #run({
    executable,
    args = [],
    cwd,
    env = {},
    input = Buffer.alloc(0),
    signal = null,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    duplex = null,
    codeExecutionWatchdog = null,
  }, onSpawnAttempt) {
    const platform = this.#platform;
    const spawnImpl = this.#spawnImpl;
    const treeTerminator = this.#treeTerminator;
    const descriptorMaterializer = this.#descriptorMaterializer;
    const requireDescriptorDigest = this.#requireDescriptorDigest;
    const terminationTimeoutMs = this.#terminationTimeoutMs;
    const requestTimeoutMs = boundedInteger(
      timeoutMs,
      "timeoutMs",
      MAX_TIMEOUT_MS,
    );
    const startedAt = performance.now();
    const watchdogSignal = codeExecutionWatchdog === null ? null : codeExecutionWatchdogSignal(codeExecutionWatchdog);
    const callerSignal = normalizeAbortSignal(signal);
    const externalSignal = watchdogSignal ? (callerSignal ? AbortSignal.any([callerSignal, watchdogSignal]) : watchdogSignal) : callerSignal;
    if (externalSignal?.aborted) throw cancelledError();
    if (requireDescriptorDigest && platform !== "win32") {
      throw unavailableError();
    }
    const invocationArgs = processArguments(args);
    if (duplex !== null && (typeof duplex !== "object" ||
        typeof duplex.onReady !== "function" || typeof duplex.onOutput !== "function")) {
      throw new TypeError("duplex callbacks are invalid");
    }
    const normalizedInvocation = {
      cwd: processWorkingDirectory(cwd),
      env: processEnvironment(env, platform),
      input: processInput(input),
      maxStdoutBytes: boundedInteger(
        maxStdoutBytes,
        "maxStdoutBytes",
        MAX_STDOUT_BYTES,
      ),
      maxStderrBytes: boundedInteger(
        maxStderrBytes,
        "maxStderrBytes",
        MAX_OUTPUT_BYTES,
      ),
    };
    if (duplex && normalizedInvocation.input.length !== 0) throw new TypeError("duplex input starts empty");
    if (watchdogSignal && !duplex) throw new TypeError('Code execution watchdog requires contained duplex execution');
    let remainingMs = remainingRequestTime(startedAt, requestTimeoutMs);
    if (remainingMs <= 0) throw timeoutError();
    let descriptor;
    try {
      descriptor = processDescriptor(
        await materializeBeforeDeadline(
          (materializationSignal) => descriptorMaterializer(executable, {
            signal: materializationSignal,
          }),
          externalSignal,
          remainingMs,
        ),
        requireDescriptorDigest,
      );
    } catch (error) {
      if (
        error instanceof SupervisedProcessError &&
        [
          "STRUCTURED_PROVIDER_CANCELLED",
          "STRUCTURED_PROVIDER_TIMEOUT",
        ].includes(error.code)
      ) {
        throw error;
      }
      throw unavailableError();
    }
    if (externalSignal?.aborted) throw cancelledError();
    remainingMs = remainingRequestTime(startedAt, requestTimeoutMs);
    if (remainingMs <= 0) throw timeoutError();
    const invocation = {
      command: descriptor.command,
      executableSha256: descriptor.sha256,
      args: processArguments([...descriptor.prefixArgs, ...invocationArgs]),
      cwd: normalizedInvocation.cwd,
      env: normalizedInvocation.env,
      input: normalizedInvocation.input,
      signal: externalSignal,
      timeoutMs: Math.max(1, Math.ceil(remainingMs)),
      maxStdoutBytes: normalizedInvocation.maxStdoutBytes,
      maxStderrBytes: normalizedInvocation.maxStderrBytes,
    };
    const spawnedInvocation = platform === "win32"
      ? windowsContainedInvocation(
          invocation,
          this.#windowsPowerShell,
          this.#windowsWrapperPath,
          terminationTimeoutMs,
          Boolean(duplex),
        )
      : {
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          env: invocation.env,
          input: invocation.input,
          detached: true,
        };
    if (externalSignal?.aborted) throw cancelledError();
    remainingMs = remainingRequestTime(startedAt, requestTimeoutMs);
    if (remainingMs <= 0) throw timeoutError();
    invocation.timeoutMs = Math.max(1, Math.ceil(remainingMs));

    return new Promise((resolve, reject) => {
      let child;
      try {
        onSpawnAttempt();
        child = spawnImpl(spawnedInvocation.command, spawnedInvocation.args, {
          cwd: spawnedInvocation.cwd,
          env: spawnedInvocation.env,
          shell: false,
          windowsHide: true,
          detached: spawnedInvocation.detached,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(unavailableError());
        return;
      }

      const stdout = { bytes: 0, chunks: [], error: null };
      const stderr = { bytes: 0, chunks: [], error: null };
      let terminalError = null;
      let spawnError = null;
      let closeResult = null;
      let closed = false;
      let settled = false;
      let terminationPromise = null;
      let timer = null;
      let resolveClosed;
      const closedPromise = new Promise((resolveClose) => {
        resolveClosed = resolveClose;
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        invocation.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (operation, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (
          operation === reject && closed &&
          value?.code !== "STRUCTURED_PROVIDER_REAP_FAILED"
        ) {
          REAPED_FAILURE_OUTPUT.set(value, Buffer.concat(stdout.chunks));
        }
        operation(value);
      };
      const waitForClose = async () => {
        if (closed) return true;
        let closeTimer;
        try {
          return await Promise.race([
            closedPromise.then(() => true),
            new Promise((resolveWait) => {
              closeTimer = setTimeout(
                () => resolveWait(false),
                terminationTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (closeTimer) clearTimeout(closeTimer);
        }
      };
      const killDirectly = () => {
        try {
          return child.kill?.("SIGKILL") !== false;
        } catch {
          return false;
        }
      };
      const terminateTree = () => withinDeadline(
        () => treeTerminator(child.pid, {
          force: true,
          platform,
          timeoutMs: terminationTimeoutMs,
        }),
        terminationTimeoutMs,
      );
      const hasProcessIdentity = () =>
        Number.isSafeInteger(child.pid) && child.pid > 0;
      const terminate = (error) => {
        if (settled) return Promise.resolve();
        terminalError ||= error;
        if (terminationPromise) return terminationPromise;
        terminationPromise = (async () => {
          try {
            child.stdin?.destroy();
          } catch {
            // Tree containment below remains authoritative.
          }

          if (!hasProcessIdentity()) {
            await waitForClose();
            settle(reject, spawnError ? unavailableError() : reapFailedError());
            return;
          }

          let treeOutcome = { status: "completed" };
          if (!closed || platform !== "win32") {
            treeOutcome = await terminateTree();
          }
          if (!closed) await waitForClose();
          if (!closed) {
            killDirectly();
            await waitForClose();
          }

          const containmentClosed = closed;
          const treeContained = platform === "win32"
            ? containmentClosed
            : treeOutcome.status === "completed";
          if (!containmentClosed || !treeContained) {
            settle(reject, reapFailedError());
            return;
          }
          settle(reject, terminalError);
        })().catch(() => {
          settle(reject, reapFailedError());
        });
        return terminationPromise;
      };
      const onAbort = () => {
        void terminate(watchdogSignal?.aborted ? watchdogSignal.reason : cancelledError());
      };
      const acceptOutput = (state, chunk, maximum, stream) => {
        if (settled || terminalError) return;
        appendOutput(state, chunk, maximum);
        if (state.error) void terminate(state.error);
        else if (duplex) {
          try { duplex.onOutput({ stream, chunk: Buffer.from(chunk) }); }
          catch { void terminate(failedError()); }
        }
      };
      const handleStreamError = () => {
        void terminate(failedError());
      };
      const finishClosedProcess = async () => {
        if (settled || terminalError) return;
        if (spawnError) {
          settle(
            reject,
            hasProcessIdentity() ? failedError() : unavailableError(),
          );
          return;
        }
        if (platform !== "win32" && hasProcessIdentity()) {
          const outcome = await terminateTree();
          if (outcome.status !== "completed") {
            settle(reject, reapFailedError());
            return;
          }
        }
        if (settled || terminalError) return;
        if (
          platform === "win32" &&
          [124, 125].includes(closeResult.exitCode)
        ) {
          settle(reject, failedError());
          return;
        }
        if (closeResult.signal !== null) {
          settle(reject, failedError());
          return;
        }
        if (closeResult.exitCode !== 0) {
          settle(reject, exitedError());
          return;
        }
        const stdoutBytes = Buffer.concat(stdout.chunks);
        const stderrBytes = Buffer.concat(stderr.chunks);
        settle(resolve, {
          exitCode: closeResult.exitCode,
          signal: closeResult.signal,
          stdout: stdoutBytes.toString("utf8"),
          stderr: stderrBytes.toString("utf8"),
          stdoutBytes,
          stderrBytes,
        });
      };

      child.stdout?.on("data", (chunk) =>
        acceptOutput(stdout, chunk, invocation.maxStdoutBytes, "stdout"),
      );
      child.stderr?.on("data", (chunk) =>
        acceptOutput(stderr, chunk, invocation.maxStderrBytes, "stderr"),
      );
      child.stdout?.on("error", handleStreamError);
      child.stderr?.on("error", handleStreamError);
      child.once("error", (error) => {
        spawnError ||= error;
        void terminate(
          hasProcessIdentity() ? failedError() : unavailableError(),
        );
      });
      child.stdin?.on("error", (error) => {
        if (error?.code !== "EPIPE") void terminate(failedError());
      });
      child.once("close", (exitCode, signalCode) => {
        closed = true;
        closeResult = {
          exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1,
          signal: signalCode ?? null,
        };
        resolveClosed(closeResult);
        void finishClosedProcess();
      });

      invocation.signal?.addEventListener("abort", onAbort, { once: true });
      const processRemainingMs = remainingRequestTime(
        startedAt,
        requestTimeoutMs,
      );
      if (invocation.signal?.aborted) {
        onAbort();
      } else if (processRemainingMs <= 0) {
        void terminate(timeoutError());
      } else if (!watchdogSignal) {
        timer = setTimeout(
          () => void terminate(timeoutError()),
          Math.max(1, Math.ceil(processRemainingMs)),
        );
      }
      if (!terminalError) {
        try {
          if (duplex) {
            if (spawnedInvocation.input.length) child.stdin.write(spawnedInvocation.input);
            let inputBytes = 0;
            let ended = false;
            duplex.onReady(Object.freeze({
              write(value) {
                if (settled || closed || terminalError || ended) throw failedError();
                const bytes = processInput(value);
                inputBytes += bytes.length;
                if (inputBytes > 8 * MAX_INPUT_BYTES) throw outputLimitError();
                child.stdin.write(bytes);
              },
              end() {
                if (ended) return;
                ended = true;
                child.stdin.end();
              },
            }));
          } else child.stdin?.end(spawnedInvocation.input);
        } catch {
          void terminate(failedError());
        }
      }
    });
  }
}

export function createTestSupervisedProcessRunner(dependencies = {}) {
  return new SupervisedProcessRunner(TEST_CONSTRUCTION_TOKEN, dependencies);
}
