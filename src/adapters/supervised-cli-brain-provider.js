import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";

import { canonicalJsonStringify } from "../lib/canonical-json-digest.js";
import { CodexCliSessionStore } from "./codex-cli-session-store.js";
import { projectRoot } from "../lib/config.js";
import { KnownCliLocator } from "../lib/known-cli-locator.js";
import { ProductionCliCompositionGrant } from "../composition-root.js";
import {
  prepareCleanupTreesByIdentity,
  PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
  productionSupervisedCliPlatformSupported,
} from "../lib/private-directory-manager.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";
import {
  normalizeStructuredBrainRequest,
  readStructuredBrainGenerateInput,
} from "../lib/structured-brain-request.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import {
  readReapedProcessFailureOutput,
  SupervisedProcessRunner,
} from "../lib/supervised-process-runner.js";

const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const CLI_KINDS = new Set(["codex-cli", "claude-cli"]);
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const API_KEY = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const INVALID_PATH_TEXT = /[\u0000\r\n]/;
const INVOCATION_MARKER = ".mydashboard-invocation.json";
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_SCAVENGE_ENTRIES = 128;
const MAX_MARKER_BYTES = 4 * 1024;
const MAX_RESULT_DEPTH = 64;
const MAX_RESULT_NODES = 20_000;
const MAX_RESULT_KEYS = 20_000;
const MAX_CLEANUP_ENTRIES = 256;
const MAX_CLEANUP_DEPTH = 16;
// A normal Codex turn can retain a rollout plus SQLite state above 16 MiB.
const MAX_CLEANUP_REGULAR_BYTES = 64n * 1024n * 1024n;
const MAX_RECOVERY_MS = 30_000;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SHARED_ROOT_STATES = new Map();
const SHARED_SESSION_STORES = new Map();
const SESSION_STORE_BOUNDARIES = new WeakMap();
const SESSION_TURNS_BY_STORE = new WeakMap();
const PRODUCTION_CLEANUP_FILE_SYSTEM = Object.freeze({
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
  prepareCleanupTrees: prepareCleanupTreesByIdentity,
});
const TEST_CLEANUP_FILE_SYSTEM = Object.freeze({
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
});
const INSTRUCTION =
  "Return exactly one JSON object that matches the supplied schema. " +
  "Do not call tools or perform actions. The object has no action authority.";
const CODEX_INSTRUCTION =
  "Return exactly one output envelope with a result string. " +
  "The result string must contain exactly one JSON object that matches the " +
  "supplied business schema. Do not call tools or perform actions. " +
  "The object has no action authority.";
const CODEX_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["result"]),
  properties: Object.freeze({
    result: Object.freeze({ type: "string" }),
  }),
});
const OPTION_KEYS = Object.freeze([
  "id",
  "cliKind",
  "credentialMode",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
]);
const CLAUDE_REQUIRED_KEYS = Object.freeze([
  "type",
  "subtype",
  "is_error",
  "duration_ms",
  "duration_api_ms",
  "num_turns",
  "result",
  "session_id",
  "total_cost_usd",
]);
const CLAUDE_OPTIONAL_KEYS = new Set([
  "usage",
  "modelUsage",
  "permission_denials",
  "uuid",
]);
const FAILURE_DEFINITIONS = Object.freeze({
  STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE: Object.freeze({
    message: "Structured CLI provider credential is unavailable",
    statusCode: 503,
  }),
  STRUCTURED_PROVIDER_UNAVAILABLE: Object.freeze({
    message: "Structured CLI provider is unavailable",
    statusCode: 503,
  }),
  STRUCTURED_PROVIDER_CANCELLED: Object.freeze({
    message: "Structured CLI provider request was cancelled",
    statusCode: 499,
  }),
  STRUCTURED_PROVIDER_TIMEOUT: Object.freeze({
    message: "Structured CLI provider request timed out",
    statusCode: 504,
  }),
  STRUCTURED_PROVIDER_OUTPUT_LIMIT: Object.freeze({
    message: "Structured CLI provider output exceeded its limit",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_PROCESS_FAILED: Object.freeze({
    message: "Structured CLI provider process failed",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_REAP_FAILED: Object.freeze({
    message: "Structured CLI provider process could not be reaped safely",
    statusCode: 500,
  }),
  STRUCTURED_PROVIDER_REQUEST_TOO_LARGE: Object.freeze({
    message: "Structured provider request exceeds the configured limit",
    statusCode: 413,
  }),
  STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE: Object.freeze({
    message: "Structured CLI provider response exceeds the configured limit",
    statusCode: 413,
  }),
  STRUCTURED_PROVIDER_RESPONSE_INVALID: Object.freeze({
    message: "Structured CLI provider response is invalid",
    statusCode: 502,
  }),
  STRUCTURED_PROVIDER_CLEANUP_FAILED: Object.freeze({
    message: "Structured CLI provider cleanup failed",
    statusCode: 500,
  }),
  STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED: Object.freeze({
    message: "Structured CLI session progress could not be saved; isolated history was retained for recovery",
    statusCode: 500,
  }),
});
const FAILURE_PRECEDES_DEADLINE = new Set([
  "STRUCTURED_PROVIDER_REAP_FAILED",
  "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
]);

export class SupervisedCliBrainProviderError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "SupervisedCliBrainProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerError(code) {
  const definition = FAILURE_DEFINITIONS[code];
  if (!definition) {
    return new SupervisedCliBrainProviderError(
      "STRUCTURED_PROVIDER_UNAVAILABLE",
      FAILURE_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE.message,
      FAILURE_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE.statusCode,
    );
  }
  return new SupervisedCliBrainProviderError(
    code,
    definition.message,
    definition.statusCode,
  );
}

function sanitizeInputFailure(error) {
  if (error instanceof TypeError) return error;
  const code = typeof error?.code === "string" ? error.code : null;
  return providerError(
    Object.hasOwn(FAILURE_DEFINITIONS, code)
      ? code
      : "STRUCTURED_PROVIDER_UNAVAILABLE",
  );
}

function sanitizeRuntimeFailure(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const publicCode = code === "STRUCTURED_PROVIDER_PROCESS_EXITED"
    ? "STRUCTURED_PROVIDER_PROCESS_FAILED"
    : code;
  return providerError(
    Object.hasOwn(FAILURE_DEFINITIONS, publicCode)
      ? publicCode
      : "STRUCTURED_PROVIDER_UNAVAILABLE",
  );
}

function createRequestDeadline({
  signal,
  timeoutMs,
  monotonicClock,
  startedAt,
}) {
  const controller = new AbortController();
  let failure = null;
  let timer = null;
  let resolveTerminal;
  const terminal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const finish = (code) => {
    if (failure) return;
    failure = providerError(code);
    resolveTerminal(Object.freeze({ status: "terminal" }));
    controller.abort(failure);
  };
  const onAbort = () => finish("STRUCTURED_PROVIDER_CANCELLED");
  const remainingMs = () => {
    if (failure) throw failure;
    const elapsed = monotonicClock() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs) {
      finish("STRUCTURED_PROVIDER_TIMEOUT");
      throw failure;
    }
    return Math.max(1, Math.ceil(timeoutMs - elapsed));
  };
  const run = async (operation) => {
    remainingMs();
    const operationResult = Promise.resolve()
      .then(() => operation(Object.freeze({
        signal: controller.signal,
        timeoutMs: remainingMs(),
      })))
      .then(
        (value) => Object.freeze({ status: "fulfilled", value }),
        (error) => Object.freeze({ status: "rejected", error }),
      );
    const outcome = await Promise.race([operationResult, terminal]);
    if (
      outcome.status === "rejected" &&
      FAILURE_PRECEDES_DEADLINE.has(outcome.error?.code)
    ) {
      throw outcome.error;
    }
    if (failure) throw failure;
    remainingMs();
    if (outcome.status === "rejected") throw outcome.error;
    return outcome.value;
  };
  const throwIfExpired = () => {
    remainingMs();
  };
  const dispose = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (!failure) {
    let initialRemaining = 0;
    try {
      initialRemaining = remainingMs();
    } catch {
      // The terminal failure is read through the normal request path so its
      // listener and timer lifecycle still reaches dispose().
    }
    if (!failure) {
      timer = setTimeout(
        () => finish("STRUCTURED_PROVIDER_TIMEOUT"),
        initialRemaining,
      );
    }
  }
  return Object.freeze({
    signal: controller.signal,
    remainingMs,
    run,
    throwIfExpired,
    dispose,
  });
}

function exactDataObject(value, allowedKeys, requiredKeys, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(message);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(message);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(message);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported range`);
  }
  return value;
}

function providerOptions(rawOptions) {
  const options = exactDataObject(
    rawOptions,
    OPTION_KEYS,
    ["id", "cliKind"],
    "Supervised CLI provider options are invalid",
  );
  if (typeof options.id !== "string" || !SAFE_ID.test(options.id)) {
    throw new TypeError("provider id is invalid");
  }
  if (!CLI_KINDS.has(options.cliKind)) {
    throw new TypeError("cliKind is invalid");
  }
  const credentialMode = options.credentialMode ?? "api-key";
  if (!["api-key", "codex-login"].includes(credentialMode)) {
    throw new TypeError("credentialMode is invalid");
  }
  if (options.cliKind === "claude-cli" && credentialMode !== "api-key") {
    throw new TypeError("Claude CLI credentialMode is invalid");
  }
  return Object.freeze({
    id: options.id,
    cliKind: options.cliKind,
    credentialMode,
    timeoutMs: boundedInteger(
      options.timeoutMs ?? 300_000,
      "timeoutMs",
      1_000,
      3_600_000,
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? 128 * 1024,
      "maxResponseBytes",
      1_024,
      1024 * 1024,
    ),
    maxRequestBytes: boundedInteger(
      options.maxRequestBytes ?? 256 * 1024,
      "maxRequestBytes",
      1_024,
      1024 * 1024,
    ),
  });
}

function temporaryRootPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    INVALID_PATH_TEXT.test(value)
  ) {
    throw new TypeError("temporaryRoot is invalid");
  }
  return path.resolve(value);
}

function protectedRootPaths(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError("protectedRoots are invalid");
  }
  const roots = value.map((entry) => temporaryRootPath(entry));
  return Object.freeze([...new Set(roots.map(canonicalPath))]);
}

function cleanupFileSystem(value) {
  const methods = [
    "lstat",
    "open",
    "opendir",
    "realpath",
    "rename",
    "rmdir",
    "unlink",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    methods.some((name) => typeof value[name] !== "function")
  ) {
    throw new TypeError("cleanupFileSystem is invalid");
  }
  return Object.freeze({
    ...Object.fromEntries(methods.map((name) => [name, value[name].bind(value)])),
    ...(typeof value.deleteInventory === "function"
      ? { deleteInventory: value.deleteInventory.bind(value) }
      : {}),
    ...(typeof value.prepareCleanupTrees === "function"
      ? { prepareCleanupTrees: value.prepareCleanupTrees.bind(value) }
      : {}),
  });
}

function rootDirectoryManager(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    typeof value.prepare !== "function"
  ) {
    throw new TypeError("rootDirectoryManager is invalid");
  }
  return Object.freeze({ prepare: value.prepare.bind(value) });
}

function testRootDirectoryManager() {
  return Object.freeze({
    async prepare({ directory, signal, validateLocation }) {
      await validateLocation();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      throwIfRequestAborted(signal);
      if (process.platform !== "win32") await chmod(directory, 0o700);
      return validatedIsolationRoot(directory, [], signal);
    },
  });
}

function defaultProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function productionDependencies(runtimeFacts = []) {
  const additionalProtectedRoots = Array.isArray(runtimeFacts)
    ? runtimeFacts
    : runtimeFacts.protectedRoots;
  const codexLoginCredentialBroker = Array.isArray(runtimeFacts)
    ? null
    : runtimeFacts.codexLoginCredentialBroker;
  const supervisedCliTemporaryRoot = Array.isArray(runtimeFacts)
    ? null
    : runtimeFacts.supervisedCliTemporaryRoot;
  const temporaryRoot = supervisedCliTemporaryRoot ??
    path.join(homedir(), ".mydashboard-supervised-cli-v1");
  const sessionRoot = `${temporaryRoot}-sessions`;
  const sessionStoreKey = JSON.stringify([
    canonicalPath(sessionRoot),
    ...additionalProtectedRoots.map(canonicalPath).sort(),
  ]);
  let codexSessionStore = SHARED_SESSION_STORES.get(sessionStoreKey);
  if (codexSessionStore === undefined) {
    codexSessionStore = new CodexCliSessionStore({
      root: sessionRoot,
      protectedRoots: [temporaryRoot, ...additionalProtectedRoots],
      directoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
    });
    SHARED_SESSION_STORES.set(sessionStoreKey, codexSessionStore);
  }
  return Object.freeze({
    processRunner: new SupervisedProcessRunner(),
    commandLocator: new KnownCliLocator(),
    environment: process.env,
    temporaryRoot,
    protectedRoots: protectedRootPaths([projectRoot, ...additionalProtectedRoots]),
    cleanupFileSystem: PRODUCTION_CLEANUP_FILE_SYSTEM,
    rootDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
    productionPlatformSupported: productionSupervisedCliPlatformSupported(),
    clock: Date.now,
    monotonicClock: () => performance.now(),
    processId: process.pid,
    isProcessAlive: defaultProcessAlive,
    staleInvocationScavenger: scavengeStaleInvocations,
    codexResultReader: readCodexResult,
    codexLoginCredentialBroker,
    codexSessionStore,
  });
}

function sessionStore(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    typeof value.stage !== "function" ||
    typeof value.capture !== "function"
  ) {
    throw new TypeError("Codex session store is invalid");
  }
  const existing = SESSION_STORE_BOUNDARIES.get(value);
  if (existing !== undefined) return existing;
  const boundary = Object.freeze({
    stage: value.stage.bind(value),
    capture: value.capture.bind(value),
  });
  SESSION_STORE_BOUNDARIES.set(value, boundary);
  return boundary;
}

function providerDependencies(constructionToken, rawDependencies) {
  if (ProductionCliCompositionGrant.is(constructionToken)) {
    return constructionToken.consume(productionDependencies);
  }
  if (constructionToken !== TEST_CONSTRUCTION_TOKEN) {
    throw new TypeError(
      "Production supervised CLI providers require a lexical composition grant",
    );
  }
  const dependencies = exactDataObject(
    rawDependencies,
    [
      "processRunner",
      "commandLocator",
      "environment",
      "temporaryRoot",
      "clock",
      "monotonicClock",
      "processId",
      "isProcessAlive",
      "staleInvocationScavenger",
      "codexResultReader",
      "protectedRoots",
      "cleanupFileSystem",
      "rootDirectoryManager",
      "codexLoginCredentialBroker",
      "codexSessionStore",
    ],
    ["processRunner", "commandLocator", "environment", "temporaryRoot"],
    "Supervised CLI provider test dependencies are invalid",
  );
  return Object.freeze({
    ...dependencies,
    protectedRoots: protectedRootPaths(dependencies.protectedRoots ?? []),
    cleanupFileSystem: cleanupFileSystem(
      dependencies.cleanupFileSystem ?? TEST_CLEANUP_FILE_SYSTEM,
    ),
    rootDirectoryManager: rootDirectoryManager(
      dependencies.rootDirectoryManager ?? testRootDirectoryManager(),
    ),
    productionPlatformSupported: true,
    clock: dependencies.clock ?? Date.now,
    monotonicClock: dependencies.monotonicClock ?? (() => performance.now()),
    processId: dependencies.processId ?? process.pid,
    isProcessAlive: dependencies.isProcessAlive ?? defaultProcessAlive,
    staleInvocationScavenger:
      dependencies.staleInvocationScavenger ?? scavengeStaleInvocations,
    codexResultReader: dependencies.codexResultReader ?? readCodexResult,
    codexLoginCredentialBroker:
      dependencies.codexLoginCredentialBroker ?? null,
    codexSessionStore: dependencies.codexSessionStore === undefined
      ? null
      : sessionStore(dependencies.codexSessionStore),
  });
}

function credentialBroker(value) {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    typeof value.acquire !== "function" ||
    typeof value.readStatus !== "function"
  ) {
    throw new TypeError("Codex login credential broker is invalid");
  }
  const checkAvailability = value.checkAvailability;
  if (
    checkAvailability !== undefined &&
    typeof checkAvailability !== "function"
  ) {
    throw new TypeError("Codex login credential broker is invalid");
  }
  return Object.freeze({
    acquire: value.acquire.bind(value),
    readStatus: value.readStatus.bind(value),
    ...(checkAvailability === undefined
      ? {}
      : { checkAvailability: checkAvailability.bind(value) }),
  });
}

function assertCodexLoginAvailable(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    value.schemaVersion !== 1 ||
    typeof value.state !== "string" ||
    typeof value.cliAvailable !== "boolean" ||
    typeof value.fileLoginAvailable !== "boolean" ||
    Reflect.ownKeys(value).length !== 4
  ) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  if (
    value.state === "available" &&
    value.cliAvailable === true &&
    value.fileLoginAvailable === true
  ) {
    return;
  }
  if (value.state === "broker_blocked") {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  if (
    (value.state === "file_login_unavailable" ||
      value.state === "unsafe_source") &&
    value.cliAvailable === true &&
    value.fileLoginAvailable === false
  ) {
    throw providerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
}

function validateDependencies(dependencies) {
  if (
    typeof dependencies.processRunner?.run !== "function" ||
    typeof dependencies.commandLocator?.resolve !== "function" ||
    dependencies.environment === null ||
    typeof dependencies.environment !== "object" ||
    utilTypes.isProxy(dependencies.environment) ||
    typeof dependencies.clock !== "function" ||
    typeof dependencies.monotonicClock !== "function" ||
    typeof dependencies.isProcessAlive !== "function" ||
    typeof dependencies.staleInvocationScavenger !== "function" ||
    typeof dependencies.codexResultReader !== "function" ||
    !Array.isArray(dependencies.protectedRoots) ||
    typeof dependencies.cleanupFileSystem?.unlink !== "function" ||
    typeof dependencies.rootDirectoryManager?.prepare !== "function" ||
    typeof dependencies.productionPlatformSupported !== "boolean" ||
    !Number.isSafeInteger(dependencies.processId) ||
    dependencies.processId < 1
  ) {
    throw new TypeError("Supervised CLI provider dependencies are invalid");
  }
}

function credential(environment, cliKind) {
  const name = cliKind === "codex-cli"
    ? "OPENAI_API_KEY"
    : "ANTHROPIC_API_KEY";
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !API_KEY.test(descriptor.value)
  ) {
    throw providerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  return Object.freeze({ name, value: descriptor.value });
}

function canonicalPath(value) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function throwIfRequestAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof SupervisedCliBrainProviderError
    ? signal.reason
    : providerError("STRUCTURED_PROVIDER_CANCELLED");
}

async function waitForSessionTurn(turn, signal) {
  throwIfRequestAborted(signal);
  if (!signal) {
    await turn;
    return;
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(
      signal.reason instanceof SupervisedCliBrainProviderError
        ? signal.reason
        : providerError("STRUCTURED_PROVIDER_CANCELLED"),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([turn, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return canonicalPath(left) === canonicalPath(right) ||
    inside(left, right) ||
    inside(right, left);
}

async function trustedDirectory(
  directory,
  expectedRoot = null,
  signal = null,
) {
  throwIfRequestAborted(signal);
  const details = await lstat(directory, { bigint: true });
  throwIfRequestAborted(signal);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink()
  ) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  const resolved = await realpath(directory);
  throwIfRequestAborted(signal);
  if (canonicalPath(resolved) !== canonicalPath(directory)) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  if (expectedRoot && !inside(expectedRoot, resolved)) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  const finalDetails = await lstat(resolved, { bigint: true });
  throwIfRequestAborted(signal);
  if (!sameDirectoryIdentity({
    device: details.dev.toString(),
    inode: details.ino.toString(),
  }, finalDetails)) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  return Object.freeze({
    path: resolved,
    device: finalDetails.dev.toString(),
    inode: finalDetails.ino.toString(),
  });
}

async function canonicalProtectedPath(value, signal) {
  const unresolved = [];
  let candidate = path.resolve(value);
  for (;;) {
    throwIfRequestAborted(signal);
    try {
      const resolved = await realpath(candidate);
      throwIfRequestAborted(signal);
      return canonicalPath(path.join(resolved, ...unresolved.reverse()));
    } catch (error) {
      throwIfRequestAborted(signal);
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return canonicalPath(value);
      unresolved.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function assertNoGitAncestor(directory, signal) {
  let current = directory;
  for (;;) {
    throwIfRequestAborted(signal);
    try {
      await lstat(path.join(current, ".git"), { bigint: true });
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    } catch (error) {
      if (error instanceof SupervisedCliBrainProviderError) throw error;
      if (error?.code !== "ENOENT") {
        throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
      }
    }
    throwIfRequestAborted(signal);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertIsolationRootLocation(directory, protectedRoots, signal) {
  let canonicalDirectory;
  try {
    canonicalDirectory = await canonicalProtectedPath(directory, signal);
  } catch {
    throwIfRequestAborted(signal);
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  for (const protectedRoot of protectedRoots) {
    let canonical;
    try {
      canonical = await canonicalProtectedPath(protectedRoot, signal);
    } catch {
      throwIfRequestAborted(signal);
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    if (pathsOverlap(canonicalDirectory, canonical)) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
  }
  await assertNoGitAncestor(canonicalDirectory, signal);
}

async function validatedIsolationRoot(directory, protectedRoots, signal) {
  await assertIsolationRootLocation(directory, protectedRoots, signal);
  const initial = await trustedDirectory(directory, null, signal);
  const final = await trustedDirectory(directory, null, signal);
  if (
    initial.device !== final.device ||
    initial.inode !== final.inode
  ) {
    throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }
  return final;
}

function sharedRootState(identity) {
  const key = canonicalPath(identity.path);
  const existing = SHARED_ROOT_STATES.get(key);
  if (existing) {
    if (
      existing.identity.device !== identity.device ||
      existing.identity.inode !== identity.inode
    ) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    return existing;
  }
  const state = {
    identity,
    blocked: false,
    unprovable: false,
    pending: new Set(),
    blockingPending: new Set(),
    residues: new Map(),
    leaseTail: Promise.resolve(),
  };
  SHARED_ROOT_STATES.set(key, state);
  return state;
}

async function writeNewFile(file, bytes, signal = null, assertSafe = null) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    assertSafe?.();
    handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    throwIfRequestAborted(signal);
    assertSafe?.();
    await handle.writeFile(bytes);
    throwIfRequestAborted(signal);
    assertSafe?.();
    await handle.sync();
    throwIfRequestAborted(signal);
    assertSafe?.();
  } finally {
    await handle?.close();
  }
  assertSafe?.();
  if (process.platform !== "win32") {
    await chmod(file, 0o600);
    assertSafe?.();
  }
  throwIfRequestAborted(signal);
  const details = await lstat(file, { bigint: true });
  assertSafe?.();
  return details;
}

function sameDirectoryIdentity(invocation, details) {
  return (
    details.isDirectory() &&
    !details.isSymbolicLink() &&
    details.dev.toString() === invocation.device &&
    details.ino.toString() === invocation.inode
  );
}

function residueIdentity(invocation, filePath) {
  return Object.freeze({
    path: filePath,
    device: invocation.device,
    inode: invocation.inode,
  });
}

function recordResidue(rootState, invocation) {
  rootState.blocked = true;
  rootState.residues.set(canonicalPath(invocation.path), invocation);
}

function releaseRootIfClean(rootState) {
  if (
    !rootState.unprovable &&
    rootState.blockingPending.size === 0 &&
    rootState.residues.size === 0
  ) {
    rootState.blocked = false;
  }
}

function assertRootAdmissionSafe(rootState) {
  if (
    !rootState ||
    rootState.blocked ||
    rootState.unprovable ||
    rootState.residues.size > 0
  ) {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
}

async function cleanupStep(signal, operation) {
  throwIfRequestAborted(signal);
  const value = await operation();
  throwIfRequestAborted(signal);
  return value;
}

function cleanupNode(details, nodePath, depth, parent = null) {
  return Object.freeze({
    path: nodePath,
    depth,
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: details.size,
    links: details.nlink,
    directory: details.isDirectory(),
    file: details.isFile(),
    parent: parent === null
      ? null
      : Object.freeze({
          path: parent.path,
          device: parent.device,
          inode: parent.inode,
        }),
  });
}

async function validateCleanupParent(node, signal, fileSystem) {
  if (node.parent === null) return;
  const details = await cleanupStep(
    signal,
    () => fileSystem.lstat(node.parent.path, { bigint: true }),
  );
  if (!sameDirectoryIdentity(node.parent, details)) {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
}

function sameCleanupNode(node, details) {
  if (
    details.isSymbolicLink() ||
    details.dev.toString() !== node.device ||
    details.ino.toString() !== node.inode ||
    details.isDirectory() !== node.directory ||
    details.isFile() !== node.file
  ) {
    return false;
  }
  return node.directory ||
    (details.nlink === node.links && details.size === node.size);
}

async function closeCleanupHandle(handle, rootState = null) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    if (rootState) {
      rootState.blocked = true;
      rootState.unprovable = true;
    }
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
}

async function boundedCleanupInventory(
  target,
  parentIdentity,
  signal,
  fileSystem,
  rootState,
) {
  const rootDetails = await cleanupStep(
    signal,
    () => fileSystem.lstat(target.path, { bigint: true }),
  );
  if (!sameDirectoryIdentity(target, rootDetails)) {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  const rootResolved = await cleanupStep(
    signal,
    () => fileSystem.realpath(target.path),
  );
  if (canonicalPath(rootResolved) !== canonicalPath(target.path)) {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  const rootNode = cleanupNode(rootDetails, target.path, 0, parentIdentity);
  const nodes = [rootNode];
  const pendingDirectories = [rootNode];
  let totalBytes = 0n;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    const beforeOpen = await cleanupStep(
      signal,
      () => fileSystem.lstat(directory.path, { bigint: true }),
    );
    if (!sameCleanupNode(directory, beforeOpen)) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const handle = await cleanupStep(
      signal,
      () => fileSystem.opendir(directory.path),
    );
    try {
      const afterOpen = await cleanupStep(
        signal,
        () => fileSystem.lstat(directory.path, { bigint: true }),
      );
      if (!sameCleanupNode(directory, afterOpen)) {
        throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      const openedResolved = await cleanupStep(
        signal,
        () => fileSystem.realpath(directory.path),
      );
      if (canonicalPath(openedResolved) !== canonicalPath(directory.path)) {
        throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      for (;;) {
        const entry = await cleanupStep(signal, () => handle.read());
        if (entry === null) break;
        const depth = directory.depth + 1;
        if (depth > MAX_CLEANUP_DEPTH || nodes.length >= MAX_CLEANUP_ENTRIES) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        const entryPath = path.join(directory.path, entry.name);
        if (!inside(target.path, entryPath)) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        const details = await cleanupStep(
          signal,
          () => fileSystem.lstat(entryPath, { bigint: true }),
        );
        if (
          details.isSymbolicLink() ||
          details.dev !== rootDetails.dev
        ) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        const node = cleanupNode(details, entryPath, depth, directory);
        if (node.file) {
          if (node.links !== 1n) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          totalBytes += node.size;
          if (totalBytes > MAX_CLEANUP_REGULAR_BYTES) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
        } else if (node.directory) {
          const resolved = await cleanupStep(
            signal,
            () => fileSystem.realpath(entryPath),
          );
          if (
            canonicalPath(resolved) !== canonicalPath(entryPath) ||
            !inside(target.path, resolved)
          ) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          pendingDirectories.push(node);
        } else {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        nodes.push(node);
      }
    } finally {
      await closeCleanupHandle(handle, rootState);
    }
  }
  return nodes;
}

async function deleteCleanupInventory(nodes, signal, fileSystem) {
  const descending = [...nodes].sort((left, right) =>
    right.depth - left.depth || right.path.localeCompare(left.path));
  const deletionPlan = [
    ...descending.filter((entry) => entry.file),
    ...descending.filter((entry) => entry.directory),
  ];
  if (typeof fileSystem.deleteInventory === "function") {
    await cleanupStep(
      signal,
      () => fileSystem.deleteInventory(deletionPlan, signal),
    );
    return;
  }
  for (const node of deletionPlan.filter((entry) => entry.file)) {
    const details = await cleanupStep(
      signal,
      () => fileSystem.lstat(node.path, { bigint: true }),
    );
    if (!sameCleanupNode(node, details)) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    await validateCleanupParent(node, signal, fileSystem);
    await cleanupStep(signal, () => fileSystem.unlink(node.path));
  }
  for (const node of deletionPlan.filter((entry) => entry.directory)) {
    const details = await cleanupStep(
      signal,
      () => fileSystem.lstat(node.path, { bigint: true }),
    );
    if (!sameCleanupNode(node, details)) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    await validateCleanupParent(node, signal, fileSystem);
    await cleanupStep(signal, () => fileSystem.rmdir(node.path));
  }
}

async function removeVerifiedInvocation(
  invocation,
  root,
  signal,
  fileSystem,
  rootState,
) {
  let target = invocation;
  const alreadyQuarantined = path.basename(invocation.path).startsWith(
    ".cleanup-",
  );
  if (!alreadyQuarantined) {
    const quarantine = path.join(root, `.cleanup-${randomUUID()}`);
    const quarantined = residueIdentity(invocation, quarantine);
    recordResidue(rootState, quarantined);
    await cleanupStep(
      signal,
      () => fileSystem.rename(invocation.path, quarantine),
    );
    rootState.residues.delete(canonicalPath(invocation.path));
    target = quarantined;
  }
  const inventory = await boundedCleanupInventory(
    target,
    rootState.identity,
    signal,
    fileSystem,
    rootState,
  );
  await deleteCleanupInventory(inventory, signal, fileSystem);
  rootState.residues.delete(canonicalPath(target.path));
}

async function removeVerifiedInvocations(
  invocations,
  root,
  signal,
  fileSystem,
  rootState,
) {
  if (invocations.length === 0) return;
  if (typeof fileSystem.prepareCleanupTrees === "function") {
    for (const invocation of invocations) recordResidue(rootState, invocation);
    throwIfRequestAborted(signal);
    const session = await fileSystem.prepareCleanupTrees(invocations, {
        maximumEntries: MAX_CLEANUP_ENTRIES,
        maximumDepth: MAX_CLEANUP_DEPTH,
        maximumBytes: Number(MAX_CLEANUP_REGULAR_BYTES),
        signal,
      });
    if (
      typeof session?.commit !== "function" ||
      typeof session?.close !== "function"
    ) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    let committed = false;
    try {
      throwIfRequestAborted(signal);
      await session.commit();
      committed = true;
      throwIfRequestAborted(signal);
    } finally {
      if (!committed) await session.close();
    }
    for (const invocation of invocations) {
      rootState.residues.delete(canonicalPath(invocation.path));
    }
    return;
  }
  for (const invocation of invocations) {
    recordResidue(rootState, invocation);
    await removeVerifiedInvocation(
      invocation,
      root,
      signal,
      fileSystem,
      rootState,
    );
  }
}

function markerValue(value, cliKind) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const keys = ["schemaVersion", "kind", "ownerPid", "createdAt"];
  if (value.schemaVersion === 2) keys.push("sessionRecoveryRequired");
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  const createdAt = Date.parse(value.createdAt);
  if (
    ![1, 2].includes(value.schemaVersion) ||
    (value.schemaVersion === 2 && value.sessionRecoveryRequired !== true) ||
    value.kind !== cliKind ||
    !Number.isSafeInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }
  return Object.freeze({ ...value, createdAtMs: createdAt });
}

async function readSmallRegularFile(
  file,
  maximumBytes,
  signal = null,
  fileSystem = PRODUCTION_CLEANUP_FILE_SYSTEM,
  rootState = null,
) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    handle = await fileSystem.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    throwIfRequestAborted(signal);
    const details = await handle.stat({ bigint: true });
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.nlink !== 1n ||
      details.size > BigInt(maximumBytes)
    ) {
      return null;
    }
    const bytes = await handle.readFile();
    throwIfRequestAborted(signal);
    if (bytes.byteLength > maximumBytes) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await closeCleanupHandle(handle, rootState);
  }
}

function fatalUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
}

function invocationPrefix(cliKind) {
  return `invocation-${cliKind}-`;
}

async function scavengeStaleInvocations({
  root,
  cliKind,
  clock,
  isProcessAlive,
  signal = null,
  cleanupFileSystem: fileSystem = PRODUCTION_CLEANUP_FILE_SYSTEM,
  rootState = null,
}) {
  throwIfRequestAborted(signal);
  const prefix = invocationPrefix(cliKind);
  const directoryHandle = await cleanupStep(
    signal,
    () => fileSystem.opendir(root),
  );
  const staleInvocations = [];
  try {
    const entries = [];
    let rootExhausted = false;
    for (
      let inspected = 0;
      inspected < MAX_SCAVENGE_ENTRIES;
      inspected += 1
    ) {
      throwIfRequestAborted(signal);
      const entry = await directoryHandle.read();
      throwIfRequestAborted(signal);
      if (entry === null) {
        rootExhausted = true;
        break;
      }
      entries.push(entry);
    }
    if (!rootExhausted) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    for (const entry of entries) {
      const invocationEntry = entry.name.startsWith(prefix);
      const cleanupEntry = entry.name.startsWith(".cleanup-");
      if (
        (!invocationEntry && !cleanupEntry) ||
        !/^[a-z0-9._-]+$/i.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        if (cleanupEntry) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        continue;
      }
      const directory = path.join(root, entry.name);
      try {
        const identity = await trustedDirectory(directory, root, signal);
        const markerBytes = await readSmallRegularFile(
          path.join(directory, INVOCATION_MARKER),
          MAX_MARKER_BYTES,
          signal,
          fileSystem,
          rootState,
        );
        throwIfRequestAborted(signal);
        if (!markerBytes) {
          if (cleanupEntry) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          continue;
        }
        let parsed;
        try {
          parsed = parseJsonWithUniqueKeys(fatalUtf8(markerBytes));
        } catch {
          if (cleanupEntry) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          continue;
        }
        const marker = markerValue(parsed, cliKind);
        if (!marker) {
          if (cleanupEntry) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          continue;
        }
        let alive = true;
        try {
          alive = Boolean(isProcessAlive(marker.ownerPid));
        } catch {
          alive = true;
        }
        if (alive) {
          if (cleanupEntry) {
            throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
          continue;
        }
        // This invocation may contain the only copy of an interrupted task's
        // history. Age and a dead PID cannot prove that session capture succeeded.
        if (marker.sessionRecoveryRequired ||
            (cliKind === "codex-cli" && await containsSessionRollout(path.join(directory, "codex-home", "sessions"), signal))) {
          throw providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
        }
        if (clock() - marker.createdAtMs < STALE_AFTER_MS) {
          if (cleanupEntry) throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          continue;
        }
        throwIfRequestAborted(signal);
        if (!rootState) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        staleInvocations.push(identity);
      } catch (error) {
        throwIfRequestAborted(signal);
        if (error?.code === "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED") throw error;
        if (cleanupEntry || error?.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED") {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        // Unknown, live, raced, or untrusted entries are deliberately retained.
      }
    }
  } finally {
    await closeCleanupHandle(directoryHandle, rootState);
  }
  await removeVerifiedInvocations(
    staleInvocations,
    root,
    signal,
    fileSystem,
    rootState,
  );
  releaseRootIfClean(rootState);
}

async function createInvocation({
  root,
  cliKind,
  processId,
  clock,
  signal,
  cleanupFileSystem: fileSystem,
  rootState,
  sessionRecoveryRequired = false,
}) {
  throwIfRequestAborted(signal);
  const directory = await mkdtemp(path.join(root, invocationPrefix(cliKind)));
  let identity = null;
  try {
    throwIfRequestAborted(signal);
    assertRootAdmissionSafe(rootState);
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
      assertRootAdmissionSafe(rootState);
    }
    throwIfRequestAborted(signal);
    identity = await trustedDirectory(directory, root, signal);
    assertRootAdmissionSafe(rootState);
    const marker = {
      schemaVersion: sessionRecoveryRequired ? 2 : 1,
      kind: cliKind,
      ownerPid: processId,
      createdAt: new Date(clock()).toISOString(),
      ...(sessionRecoveryRequired ? { sessionRecoveryRequired: true } : {}),
    };
    await writeNewFile(
      path.join(directory, INVOCATION_MARKER),
      Buffer.from(JSON.stringify(marker), "utf8"),
      signal,
      () => assertRootAdmissionSafe(rootState),
    );
    const profiles = {
      home: path.join(directory, "profile", "home"),
      appData: path.join(directory, "profile", "appdata"),
      localAppData: path.join(directory, "profile", "local-appdata"),
      xdgConfig: path.join(directory, "profile", "xdg-config"),
      xdgCache: path.join(directory, "profile", "xdg-cache"),
      xdgData: path.join(directory, "profile", "xdg-data"),
      temporary: path.join(directory, "temporary"),
    };
    for (const profile of Object.values(profiles)) {
      throwIfRequestAborted(signal);
      assertRootAdmissionSafe(rootState);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      throwIfRequestAborted(signal);
      assertRootAdmissionSafe(rootState);
      if (process.platform !== "win32") {
        await chmod(profile, 0o700);
        assertRootAdmissionSafe(rootState);
      }
    }
    throwIfRequestAborted(signal);
    return Object.freeze({ ...identity, profiles: Object.freeze(profiles) });
  } catch (failure) {
    rootState.blocked = true;
    let cleanupAttempt = null;
    try {
      cleanupAttempt = (async () => {
        const cleanupIdentity = identity ??
          await trustedDirectory(directory, root, signal);
        await removeVerifiedInvocations(
          [cleanupIdentity],
          root,
          signal,
          fileSystem,
          rootState,
        );
      })();
      rootState.pending.add(cleanupAttempt);
      rootState.blockingPending.add(cleanupAttempt);
      await cleanupAttempt;
    } catch {
      if (identity === null) rootState.unprovable = true;
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    } finally {
      if (cleanupAttempt) rootState.pending.delete(cleanupAttempt);
      if (cleanupAttempt) rootState.blockingPending.delete(cleanupAttempt);
      releaseRootIfClean(rootState);
    }
    throw failure;
  }
}

function childEnvironment(invocation, configuredCredential, codexHome = null) {
  const { profiles } = invocation;
  return {
    HOME: profiles.home,
    USERPROFILE: profiles.home,
    APPDATA: profiles.appData,
    LOCALAPPDATA: profiles.localAppData,
    XDG_CONFIG_HOME: profiles.xdgConfig,
    XDG_CACHE_HOME: profiles.xdgCache,
    XDG_DATA_HOME: profiles.xdgData,
    TEMP: profiles.temporary,
    TMP: profiles.temporary,
    TMPDIR: profiles.temporary,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(configuredCredential === null
      ? {}
      : { [configuredCredential.name]: configuredCredential.value }),
    ...(codexHome === null ? {} : { CODEX_HOME: codexHome }),
  };
}

function credentialInvocationIdentity(invocation) {
  return Object.freeze({
    path: invocation.path,
    device: invocation.device,
    inode: invocation.inode,
  });
}

function requestPayload(request, maximumBytes, cliKind) {
  const text = canonicalJsonStringify({
    schemaVersion: 1,
    instruction: cliKind === "codex-cli" ? CODEX_INSTRUCTION : INSTRUCTION,
    messages: request.messages,
    schema: request.schema,
  });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > maximumBytes) {
    throw providerError("STRUCTURED_PROVIDER_REQUEST_TOO_LARGE");
  }
  return bytes;
}

function assertSafeCliModel(model) {
  if (!SAFE_CLI_MODEL.test(model)) {
    throw new TypeError("CLI model is invalid");
  }
}

function codexArguments({
  request,
  invocation,
  schemaFile,
  resultFile,
  sessionId = null,
}) {
  const persistentSession = request.sessionKey !== undefined;
  return [
    "exec",
    ...(persistentSession ? [] : ["--ephemeral"]),
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--strict-config",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    "--disable",
    "multi_agent",
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "plugin_sharing",
    "--disable",
    "skill_search",
    "--disable",
    "goals",
    "--color",
    "never",
    ...(persistentSession ? ["--json"] : []),
    "--output-schema",
    schemaFile,
    "--output-last-message",
    resultFile,
    "--model",
    request.model,
    ...(request.reasoningEffort
      ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`]
      : []),
    "-C",
    invocation.path,
    ...(sessionId === null ? [] : ["resume", sessionId]),
    "-",
  ];
}

function codexThreadId(result, maximumBytes, previousSessionId, { allowMissing = false } = {}) {
  const bytes = processBytes(result, maximumBytes);
  const text = allowMissing ? bytes.toString("utf8") : fatalUtf8(bytes);
  let found = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = parseJsonWithUniqueKeys(line);
    } catch {
      // A failed process may leave its final event incomplete. Only complete,
      // validated thread.started events establish a recoverable first thread.
      if (allowMissing) continue;
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    if (
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      event.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      SAFE_SESSION_ID.test(event.thread_id)
    ) {
      found ??= event.thread_id;
      if (found !== event.thread_id) {
        throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
      }
    }
  }
  const sessionId = found ?? previousSessionId;
  if (allowMissing && sessionId === null) return null;
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return sessionId;
}

async function containsSessionRollout(directory, signal, budget = { entries: 0 }, depth = 0) {
  throwIfRequestAborted(signal);
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (++budget.entries > MAX_CLEANUP_ENTRIES || depth > MAX_CLEANUP_DEPTH || details.isSymbolicLink()) {
    throw providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  }
  if (details.isFile()) return path.extname(directory).toLowerCase() === ".jsonl";
  if (!details.isDirectory()) {
    throw providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  }
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (await containsSessionRollout(path.join(directory, entry.name), signal, budget, depth + 1)) return true;
  }
  return false;
}

function claudeArguments(request) {
  return [
    "--print",
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--safe-mode",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--no-chrome",
    "--no-session-persistence",
    "--model",
    request.model,
  ];
}

function resultBudget() {
  return { nodes: MAX_RESULT_NODES, keys: MAX_RESULT_KEYS };
}

function cloneResultJson(value, depth = 0, budget = resultBudget()) {
  if (depth > MAX_RESULT_DEPTH || budget.nodes-- <= 0) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    budget.keys -= value.length;
    if (budget.keys < 0) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    return value.map((entry) => cloneResultJson(entry, depth + 1, budget));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const keys = Reflect.ownKeys(value);
  budget.keys -= keys.length;
  if (
    budget.keys < 0 ||
    keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key))
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return Object.fromEntries(
    keys.map((key) => [key, cloneResultJson(value[key], depth + 1, budget)]),
  );
}

function structuredResult(text) {
  let parsed;
  try {
    parsed = parseJsonWithUniqueKeys(text);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return canonicalJsonStringify(cloneResultJson(parsed));
}

function codexResult(text) {
  let envelope;
  try {
    envelope = parseJsonWithUniqueKeys(text);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.getPrototypeOf(envelope) !== Object.prototype ||
    Reflect.ownKeys(envelope).length !== 1 ||
    typeof envelope.result !== "string"
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  return structuredResult(envelope.result);
}

function plainMetadataObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  cloneResultJson(value);
}

function claudeResult(bytes) {
  let envelope;
  try {
    envelope = parseJsonWithUniqueKeys(fatalUtf8(bytes));
  } catch (error) {
    if (error instanceof SupervisedCliBrainProviderError) throw error;
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.getPrototypeOf(envelope) !== Object.prototype
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const keys = Reflect.ownKeys(envelope);
  const allowed = new Set([...CLAUDE_REQUIRED_KEYS, ...CLAUDE_OPTIONAL_KEYS]);
  if (
    CLAUDE_REQUIRED_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    envelope.type !== "result" ||
    envelope.subtype !== "success" ||
    envelope.is_error !== false ||
    envelope.num_turns !== 1 ||
    !Number.isSafeInteger(envelope.duration_ms) ||
    envelope.duration_ms < 0 ||
    !Number.isSafeInteger(envelope.duration_api_ms) ||
    envelope.duration_api_ms < 0 ||
    typeof envelope.result !== "string" ||
    typeof envelope.session_id !== "string" ||
    !envelope.session_id ||
    !Number.isFinite(envelope.total_cost_usd) ||
    envelope.total_cost_usd < 0
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  if (Object.hasOwn(envelope, "permission_denials")) {
    if (
      !Array.isArray(envelope.permission_denials) ||
      Object.getPrototypeOf(envelope.permission_denials) !== Array.prototype ||
      envelope.permission_denials.length !== 0
    ) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
  }
  if (Object.hasOwn(envelope, "uuid") && typeof envelope.uuid !== "string") {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  for (const name of ["usage", "modelUsage"]) {
    if (Object.hasOwn(envelope, name)) plainMetadataObject(envelope[name]);
  }
  return structuredResult(envelope.result);
}

function processBytes(result, maximumBytes) {
  if (
    !Buffer.isBuffer(result?.stdoutBytes) &&
    !(result?.stdoutBytes instanceof Uint8Array)
  ) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  }
  const bytes = Buffer.from(result.stdoutBytes);
  if (bytes.byteLength > maximumBytes) {
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
  }
  return bytes;
}

async function readCodexResult(
  file,
  identity,
  maximumBytes,
  { signal = null } = {},
) {
  let handle;
  try {
    throwIfRequestAborted(signal);
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    throwIfRequestAborted(signal);
    const before = await handle.stat({ bigint: true });
    throwIfRequestAborted(signal);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.dev !== identity.dev ||
      before.ino !== identity.ino
    ) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    }
    if (before.size > BigInt(maximumBytes)) {
      throw providerError("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
    }
    const bytes = await handle.readFile(
      signal === null ? undefined : { signal },
    );
    throwIfRequestAborted(signal);
    const after = await handle.stat({ bigint: true });
    throwIfRequestAborted(signal);
    if (
      bytes.byteLength > maximumBytes ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1n ||
      after.size !== BigInt(bytes.byteLength)
    ) {
      throw providerError(
        bytes.byteLength > maximumBytes
          ? "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE"
          : "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      );
    }
    return codexResult(fatalUtf8(bytes));
  } catch (error) {
    if (error instanceof SupervisedCliBrainProviderError) throw error;
    throw providerError("STRUCTURED_PROVIDER_RESPONSE_INVALID");
  } finally {
    await handle?.close();
  }
}

async function runDeadlineCleanup(rootState, deadline, operation) {
  rootState.blocked = true;
  try {
    await runRootOperation(rootState, deadline, operation, { blocking: true });
    releaseRootIfClean(rootState);
  } catch {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
}

async function runRootOperation(
  rootState,
  deadline,
  operation,
  { blocking = false, requireSafe = false } = {},
) {
  return deadline.run(({ signal }) => {
    const attempt = rootState.leaseTail.then(async () => {
      throwIfRequestAborted(signal);
      if (requireSafe) assertRootAdmissionSafe(rootState);
      return operation(signal);
    });
    rootState.leaseTail = attempt.catch(() => {});
    rootState.pending.add(attempt);
    if (blocking) rootState.blockingPending.add(attempt);
    const settled = () => {
      rootState.pending.delete(attempt);
      rootState.blockingPending.delete(attempt);
      releaseRootIfClean(rootState);
    };
    void attempt.then(settled, settled);
    return attempt;
  });
}

async function runConcurrentRootActivity(
  rootState,
  deadline,
  operation,
  { blocking = false, requireSafe = false, recoveryDeadline } = {},
) {
  let attempt = null;
  try {
    return await deadline.run(({ signal }) => {
      attempt = Promise.resolve().then(async () => {
        throwIfRequestAborted(signal);
        if (requireSafe) assertRootAdmissionSafe(rootState);
        return operation(signal);
      });
      rootState.pending.add(attempt);
      if (blocking) rootState.blockingPending.add(attempt);
      const settled = () => {
        rootState.pending.delete(attempt);
        rootState.blockingPending.delete(attempt);
        releaseRootIfClean(rootState);
      };
      void attempt.then(settled, settled);
      return attempt;
    });
  } catch (error) {
    if (attempt !== null && rootState.pending.has(attempt)) {
      rootState.blocked = true;
    }
    if (attempt !== null && recoveryDeadline !== undefined) {
      let settlement;
      try {
        settlement = await recoveryDeadline().run(() => attempt.then(
          (value) => ({ value }),
          (failure) => ({ failure }),
        ));
      } catch {
        rootState.unprovable = true;
        throw providerError("STRUCTURED_PROVIDER_REAP_FAILED");
      }
      if (Object.hasOwn(settlement, "failure")) throw settlement.failure;
      return settlement.value;
    }
    throw error;
  }
}

async function verifiedResidue(
  residue,
  root,
  signal,
  fileSystem,
  rootState,
) {
  let details;
  try {
    details = await cleanupStep(
      signal,
      () => fileSystem.lstat(residue.path, { bigint: true }),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    rootState.residues.delete(canonicalPath(residue.path));
    return null;
  }
  if (!sameDirectoryIdentity(residue, details)) {
    throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return residue;
}

export class SupervisedCliBrainProvider {
  #credentialMode;
  #credentialBroker;
  #codexSessionStore;
  #timeoutMs;
  #maxResponseBytes;
  #maxRequestBytes;
  #processRunner;
  #commandLocator;
  #environment;
  #temporaryRoot;
  #clock;
  #monotonicClock;
  #processId;
  #isProcessAlive;
  #staleInvocationScavenger;
  #codexResultReader;
  #protectedRoots;
  #cleanupFileSystem;
  #rootDirectoryManager;
  #productionPlatformSupported;
  #rootIdentity = null;
  #rootState = null;
  #descriptorValue = null;
  #closed = false;
  #activeGenerations = 0;
  #closeAttempt = null;
  #closeResult = null;
  #sessionTurns;

  constructor(rawOptions, constructionToken, rawDependencies) {
    if (
      constructionToken !== TEST_CONSTRUCTION_TOKEN &&
      !ProductionCliCompositionGrant.is(constructionToken)
    ) {
      throw new TypeError(
        "Production supervised CLI providers require a lexical composition grant",
      );
    }
    const options = providerOptions(rawOptions);
    const dependencies = providerDependencies(constructionToken, rawDependencies);
    validateDependencies(dependencies);
    this.id = options.id;
    this.kind = options.cliKind;
    this.remote = true;
    this.singleAttempt = true;
    this.supportsEntitySessions = this.kind === "codex-cli";
    this.#credentialMode = options.credentialMode;
    this.#credentialBroker = credentialBroker(
      dependencies.codexLoginCredentialBroker,
    );
    this.#codexSessionStore = dependencies.codexSessionStore;
    if (this.#codexSessionStore === null) {
      this.#sessionTurns = new Map();
    } else {
      let turns = SESSION_TURNS_BY_STORE.get(this.#codexSessionStore);
      if (turns === undefined) {
        turns = new Map();
        SESSION_TURNS_BY_STORE.set(this.#codexSessionStore, turns);
      }
      this.#sessionTurns = turns;
    }
    if (
      this.#credentialMode === "codex-login" &&
      this.#credentialBroker === null
    ) {
      throw new TypeError("codex-login requires a credential broker");
    }
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#maxRequestBytes = options.maxRequestBytes;
    this.#processRunner = dependencies.processRunner;
    this.#commandLocator = dependencies.commandLocator;
    this.#environment = dependencies.environment;
    this.#temporaryRoot = temporaryRootPath(dependencies.temporaryRoot);
    this.#clock = dependencies.clock;
    this.#monotonicClock = dependencies.monotonicClock;
    this.#processId = dependencies.processId;
    this.#isProcessAlive = dependencies.isProcessAlive;
    this.#staleInvocationScavenger =
      dependencies.staleInvocationScavenger;
    this.#codexResultReader = dependencies.codexResultReader;
    this.#protectedRoots = dependencies.protectedRoots;
    this.#cleanupFileSystem = dependencies.cleanupFileSystem;
    this.#rootDirectoryManager = dependencies.rootDirectoryManager;
    this.#productionPlatformSupported = dependencies.productionPlatformSupported;
    Object.freeze(this);
  }

  async #root(signal) {
    throwIfRequestAborted(signal);
    const identity = await this.#rootDirectoryManager.prepare({
      directory: this.#temporaryRoot,
      signal,
      validateLocation: () => assertIsolationRootLocation(
        this.#temporaryRoot,
        this.#protectedRoots,
        signal,
      ),
    });
    if (
      this.#rootIdentity !== null &&
      (
        this.#rootIdentity.device !== identity.device ||
        this.#rootIdentity.inode !== identity.inode
      )
    ) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    this.#rootIdentity ??= identity;
    this.#rootState ??= sharedRootState(identity);
    return identity;
  }

  async #scavenge(root, deadline) {
    const state = this.#rootState;
    await runRootOperation(state, deadline, (signal) =>
      this.#staleInvocationScavenger({
        root: root.path,
        cliKind: this.kind,
        clock: this.#clock,
        isProcessAlive: this.#isProcessAlive,
        signal,
        cleanupFileSystem: this.#cleanupFileSystem,
        rootState: state,
      }));
    if (this.#rootState.blocked) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  async #recover(root, deadline) {
    const state = this.#rootState;
    if (state.blocked && state.blockingPending.size > 0) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    if (!state.blocked && state.residues.size === 0) return;
    if (state.unprovable) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    await runDeadlineCleanup(state, deadline, async (signal) => {
      const verified = [];
      for (const residue of [...state.residues.values()]) {
        const current = await verifiedResidue(
          residue,
          root.path,
          signal,
          this.#cleanupFileSystem,
          state,
        );
        if (current) verified.push(current);
      }
      await removeVerifiedInvocations(
        verified,
        root.path,
        signal,
        this.#cleanupFileSystem,
        state,
      );
    });
    releaseRootIfClean(state);
    if (state.blocked) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  async #cleanup(invocation, expectedRoot, deadline) {
    const state = this.#rootState;
    recordResidue(state, invocation);
    await runDeadlineCleanup(state, deadline, async (signal) => {
      const currentRoot = await this.#root(signal);
      if (
        currentRoot.device !== expectedRoot.device ||
        currentRoot.inode !== expectedRoot.inode
      ) {
        throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      await removeVerifiedInvocations(
        [invocation],
        currentRoot.path,
        signal,
        this.#cleanupFileSystem,
        state,
      );
    });
  }

  async #descriptor(deadline) {
    this.#assertRunnable();
    if (this.#descriptorValue) return this.#descriptorValue;
    const descriptor = await deadline.run(({ signal }) => {
      this.#assertRunnable();
      return this.#commandLocator.resolve(this.kind, { signal });
    });
    deadline.throwIfExpired();
    this.#assertRunnable();
    this.#descriptorValue ??= descriptor;
    return this.#descriptorValue;
  }

  async #acquireSessionTurn(sessionKey, deadline) {
    if (sessionKey === undefined) return null;
    const hasPrevious = this.#sessionTurns.has(sessionKey);
    const previous = this.#sessionTurns.get(sessionKey) ?? Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    this.#sessionTurns.set(sessionKey, gate);
    try {
      await deadline.run(({ signal }) => waitForSessionTurn(previous, signal));
    } catch (error) {
      const releaseAbandonedGate = () => {
        releaseGate();
        if (this.#sessionTurns.get(sessionKey) === gate) {
          this.#sessionTurns.delete(sessionKey);
        }
      };
      if (hasPrevious) {
        void previous.then(releaseAbandonedGate, releaseAbandonedGate);
      } else {
        releaseAbandonedGate();
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.#sessionTurns.get(sessionKey) === gate) {
        this.#sessionTurns.delete(sessionKey);
      }
    };
  }

  async #runProcess(invocation, deadline, recoveryDeadline, options) {
    return runConcurrentRootActivity(
      this.#rootState,
      deadline,
      (signal) => {
        this.#assertRunnable();
        return Promise.resolve(this.#processRunner.run({
          ...options,
          signal,
          timeoutMs: deadline.remainingMs(),
        })).catch((error) => {
          if (error?.code === "STRUCTURED_PROVIDER_REAP_FAILED") {
            recordResidue(this.#rootState, invocation);
            this.#rootState.unprovable = true;
          }
          throw error;
        });
      },
      { blocking: true, requireSafe: true, recoveryDeadline },
    );
  }

  async #invoke({
    request,
    wireInput,
    deadline,
    configuredCredential,
    credentialLease,
    onCredentialStageStarted,
    onCredentialSettled,
    expectedRoot,
  }) {
    const root = await deadline.run(({ signal }) => this.#root(signal));
    this.#assertOpen();
    if (
      root.device !== expectedRoot.device ||
      root.inode !== expectedRoot.inode
    ) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    await this.#recover(root, deadline);
    this.#assertRunnable();
    await runRootOperation(
      this.#rootState,
      deadline,
      () => undefined,
      { requireSafe: true },
    );
    this.#assertRunnable();
    const descriptor = await this.#descriptor(deadline);
    this.#assertRunnable();
    let invocation = null;
    let result;
    let failure = null;
    let credentialStaged = false;
    let processReaped = credentialLease === null;
    let credentialCaptured = credentialLease === null;
    let cleanupCompleted = false;
    let recovery = null;
    const recoveryDeadline = () => recovery ??= createRequestDeadline({
      signal: null,
      timeoutMs: Math.min(MAX_RECOVERY_MS, this.#timeoutMs),
      monotonicClock: this.#monotonicClock,
      startedAt: this.#monotonicClock(),
    });
    let retainSession = false;
    try {
      invocation = await runRootOperation(
        this.#rootState,
        deadline,
        (signal) => createInvocation({
          root: root.path,
          cliKind: this.kind,
          processId: this.#processId,
          clock: this.#clock,
          signal,
          cleanupFileSystem: this.#cleanupFileSystem,
          rootState: this.#rootState,
          sessionRecoveryRequired: this.kind === "codex-cli" && Boolean(request.sessionKey),
        }),
        { blocking: true, requireSafe: true },
      );
      this.#assertRunnable();
      let codexHome = null;
      if (credentialLease !== null) {
        onCredentialStageStarted();
        const staged = await deadline.run(({ signal }) =>
          credentialLease.stage({
            invocation: credentialInvocationIdentity(invocation),
            signal,
          }));
        if (
          staged === null ||
          typeof staged !== "object" ||
          staged.codexHome !== path.join(invocation.path, "codex-home")
        ) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        codexHome = staged.codexHome;
        credentialStaged = true;
      }
      let sessionId = null;
      if (request.sessionKey !== undefined) {
        if (this.kind !== "codex-cli" || this.#codexSessionStore === null) {
          throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
        }
        codexHome ??= path.join(invocation.path, "codex-home");
        await deadline.run(async ({ signal }) => {
          await mkdir(codexHome, { recursive: true, mode: 0o700 });
          const stagedSession = await this.#codexSessionStore.stage({
            sessionKey: request.sessionKey,
            codexHome,
            signal,
          });
          sessionId = stagedSession?.sessionId ?? null;
        });
      }
      const environment = childEnvironment(
        invocation,
        configuredCredential,
        codexHome,
      );
      if (this.kind === "codex-cli") {
        const schemaFile = path.join(invocation.path, "output-schema.json");
        const resultFile = path.join(invocation.path, "last-message.json");
        await deadline.run(({ signal }) => writeNewFile(
            schemaFile,
            Buffer.from(canonicalJsonStringify(CODEX_OUTPUT_SCHEMA), "utf8"),
            signal,
            () => this.#assertRunnable(),
          ));
        this.#assertRunnable();
        const resultIdentity = await deadline.run(({ signal }) =>
          writeNewFile(
            resultFile,
            Buffer.alloc(0),
            signal,
            () => this.#assertRunnable(),
          ));
        this.#assertRunnable();
        let processFailure = null;
        let processResult = null;
        try {
          processResult = await this.#runProcess(invocation, deadline, recoveryDeadline, {
            executable: descriptor,
            args: codexArguments({
              request,
              invocation,
              schemaFile,
              resultFile,
              sessionId,
            }),
            cwd: invocation.path,
            env: environment,
            input: wireInput,
            maxStdoutBytes: this.#maxResponseBytes,
            maxStderrBytes: this.#maxResponseBytes,
          });
          processReaped = true;
        } catch (error) {
          processFailure = error;
          processReaped = error?.code !== "STRUCTURED_PROVIDER_REAP_FAILED";
        }
        if (processReaped && request.sessionKey !== undefined) {
          try {
            const output = processResult ?? readReapedProcessFailureOutput(processFailure);
            let capturedSessionId = sessionId;
            if (output !== null && (processResult !== null || sessionId === null)) {
              capturedSessionId = codexThreadId(output, this.#maxResponseBytes, sessionId, {
                allowMissing: processFailure !== null,
              });
            }
            if (capturedSessionId !== null) {
              await recoveryDeadline().run(({ signal }) => this.#codexSessionStore.capture({
                sessionKey: request.sessionKey,
                sessionId: capturedSessionId,
                codexHome,
                signal,
              }));
            } else if (await recoveryDeadline().run(({ signal }) =>
              containsSessionRollout(path.join(codexHome, "sessions"), signal))) {
              throw providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
            }
          } catch {
            retainSession = true;
            processFailure = providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
          }
        }
        if (credentialLease !== null && processReaped) {
          await recoveryDeadline().run(({ signal }) =>
            credentialLease.capture({ signal }));
          credentialCaptured = true;
        }
        if (processFailure !== null) throw processFailure;
        deadline.throwIfExpired();
        result = await deadline.run(
          ({ signal }) => this.#codexResultReader(
            resultFile,
            resultIdentity,
            this.#maxResponseBytes,
            { signal },
          ),
        );
      } else {
        const processResult = await this.#runProcess(invocation, deadline, recoveryDeadline, {
          executable: descriptor,
          args: claudeArguments(request),
          cwd: invocation.path,
          env: environment,
          input: wireInput,
          maxStdoutBytes: this.#maxResponseBytes,
          maxStderrBytes: this.#maxResponseBytes,
        });
        deadline.throwIfExpired();
        result = claudeResult(
          processBytes(processResult, this.#maxResponseBytes),
        );
      }
    } catch (error) {
      failure = error;
    }

    if (invocation === null) {
      recovery?.dispose();
      if (failure) throw failure;
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    if (failure?.code === "STRUCTURED_PROVIDER_REAP_FAILED" || retainSession) {
      recordResidue(this.#rootState, invocation);
      this.#rootState.unprovable = true;
      // A later credential-capture deadline must not hide the retained history
      // or send the owner down an ordinary timeout/cleanup recovery path.
      if (retainSession) failure = providerError("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
    } else {
      try {
        await this.#cleanup(invocation, root, recoveryDeadline());
        cleanupCompleted = true;
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
    if (
      credentialLease !== null &&
      credentialStaged &&
      processReaped &&
      credentialCaptured &&
      cleanupCompleted
    ) {
      onCredentialSettled();
    }
    recovery?.dispose();
    if (failure) throw failure;
    return result;
  }

  async generate(rawRequest = {}) {
    this.#assertOpen();
    if (!this.#productionPlatformSupported) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    const startedAt = this.#monotonicClock();
    let admitted;
    try {
      const input = readStructuredBrainGenerateInput(rawRequest);
      const signal = normalizeAbortSignal(input.signal);
      if (signal?.aborted) {
        throw providerError("STRUCTURED_PROVIDER_CANCELLED");
      }
      const request = normalizeStructuredBrainRequest(
        {
          model: input.model,
          ...(input.reasoningEffort
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
          messages: input.messages,
          schema: input.schema,
          ...(input.sessionKey === null ? {} : { sessionKey: input.sessionKey }),
        },
        { maxRequestBytes: this.#maxRequestBytes },
      );
      assertSafeCliModel(request.model);
      admitted = Object.freeze({
        request,
        signal,
        wireInput: requestPayload(request, this.#maxRequestBytes, this.kind),
      });
    } catch (error) {
      throw sanitizeInputFailure(error);
    }
    const deadline = createRequestDeadline({
      signal: admitted.signal,
      timeoutMs: this.#timeoutMs,
      monotonicClock: this.#monotonicClock,
      startedAt,
    });
    this.#activeGenerations += 1;
    let credentialLease = null;
    let releaseSessionTurn = null;
    let credentialLifecycleSafe = true;
    try {
      releaseSessionTurn = await this.#acquireSessionTurn(
        admitted.request.sessionKey,
        deadline,
      );
      if (this.#credentialMode === "codex-login") {
        credentialLease = await deadline.run(({ signal }) =>
          this.#credentialBroker.acquire({ signal }));
        if (
          credentialLease === null ||
          typeof credentialLease !== "object" ||
          typeof credentialLease.stage !== "function" ||
          typeof credentialLease.capture !== "function" ||
          typeof credentialLease.release !== "function"
        ) {
          throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      const configuredCredential = this.#credentialMode === "api-key"
        ? credential(this.#environment, this.kind)
        : null;
      const root = await deadline.run(({ signal }) => this.#root(signal));
      this.#assertOpen();
      await this.#recover(root, deadline);
      this.#assertRunnable();
      await this.#scavenge(root, deadline);
      this.#assertRunnable();
      const result = await this.#invoke({
        request: admitted.request,
        wireInput: admitted.wireInput,
        deadline,
        configuredCredential,
        credentialLease,
        onCredentialStageStarted() {
          credentialLifecycleSafe = false;
        },
        onCredentialSettled() {
          credentialLifecycleSafe = true;
        },
        expectedRoot: root,
      });
      deadline.throwIfExpired();
      return result;
    } catch (error) {
      if (FAILURE_PRECEDES_DEADLINE.has(error?.code)) {
        throw sanitizeRuntimeFailure(error);
      }
      try {
        deadline.throwIfExpired();
      } catch (deadlineError) {
        throw sanitizeRuntimeFailure(deadlineError);
      }
      throw sanitizeRuntimeFailure(error);
    } finally {
      this.#activeGenerations -= 1;
      deadline.dispose();
      try {
        if (credentialLease !== null) {
          credentialLease.release({ safe: credentialLifecycleSafe });
        }
      } catch (error) {
        throw sanitizeRuntimeFailure(error);
      } finally {
        releaseSessionTurn?.();
      }
    }
  }

  async checkAvailability(rawRequest = {}) {
    this.#assertOpen();
    if (!this.#productionPlatformSupported) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
    let signal;
    try {
      const request = exactDataObject(
        rawRequest,
        ["signal"],
        [],
        "Supervised CLI availability request is invalid",
      );
      signal = normalizeAbortSignal(request.signal ?? null);
      if (signal?.aborted) {
        throw providerError("STRUCTURED_PROVIDER_CANCELLED");
      }
    } catch (error) {
      throw sanitizeInputFailure(error);
    }
    // A generation or another availability probe already admitted by this
    // provider is stronger evidence than a second login-status probe. The
    // Codex login broker serializes credential access, so probing here would
    // wait behind the active model call and can misclassify ordinary provider
    // contention as unavailability at the caller's shorter resolution bound.
    // The queued generation still performs the authoritative credential and
    // process checks before any result is accepted.
    if (this.#activeGenerations > 0) return;
    const startedAt = this.#monotonicClock();
    const deadline = createRequestDeadline({
      signal,
      timeoutMs: this.#timeoutMs,
      monotonicClock: this.#monotonicClock,
      startedAt,
    });
    this.#activeGenerations += 1;
    try {
      if (this.#credentialMode === "codex-login") {
        if (this.#credentialBroker.checkAvailability) {
          await deadline.run(({ signal: operationSignal }) =>
            this.#credentialBroker.checkAvailability({
              signal: operationSignal,
            }));
        } else {
          const status = await deadline.run(({ signal: operationSignal }) =>
            this.#credentialBroker.readStatus({ signal: operationSignal }));
          assertCodexLoginAvailable(status);
        }
      } else {
        credential(this.#environment, this.kind);
        await deadline.run(({ signal: operationSignal }) =>
          this.#commandLocator.resolve(this.kind, { signal: operationSignal }));
      }
      deadline.throwIfExpired();
    } catch (error) {
      if (FAILURE_PRECEDES_DEADLINE.has(error?.code)) {
        throw sanitizeRuntimeFailure(error);
      }
      try {
        deadline.throwIfExpired();
      } catch (deadlineError) {
        throw sanitizeRuntimeFailure(deadlineError);
      }
      throw sanitizeRuntimeFailure(error);
    } finally {
      this.#activeGenerations -= 1;
      deadline.dispose();
    }
  }

  close() {
    if (this.#closeAttempt) return this.#closeAttempt;
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    const attempt = this.#closeProvider();
    this.#closeAttempt = attempt;
    void attempt.then(
      () => {
        if (this.#closeAttempt !== attempt) return;
        this.#closeResult = attempt;
        this.#closeAttempt = null;
      },
      () => {
        if (this.#closeAttempt === attempt) this.#closeAttempt = null;
      },
    );
    return attempt;
  }

  async #closeProvider() {
    if (this.#activeGenerations > 0) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const state = this.#rootState;
    if (state === null) return;
    if (state.pending.size > 0) {
      state.blocked = true;
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    releaseRootIfClean(state);
    if (state.blocked || state.unprovable || state.residues.size > 0) {
      throw providerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  #assertOpen() {
    if (this.#closed) {
      throw providerError("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
  }

  #assertRunnable() {
    this.#assertOpen();
    assertRootAdmissionSafe(this.#rootState);
  }
}

export function createProductionSupervisedCliBrainProvider(options, grant) {
  return new SupervisedCliBrainProvider(options, grant);
}

export function createTestSupervisedCliBrainProvider(options, dependencies) {
  return new SupervisedCliBrainProvider(
    options,
    TEST_CONSTRUCTION_TOKEN,
    dependencies,
  );
}
