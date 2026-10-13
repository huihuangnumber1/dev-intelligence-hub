import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { ProductionCliCompositionGrant } from "../composition-root.js";
import {
  createProductionCodexLoginCredentialStore,
  productionCodexLoginLocations,
} from "../lib/codex-login-credential-store.js";
import { KnownCliLocator } from "../lib/known-cli-locator.js";
import {
  prepareCleanupTreesByIdentity,
  PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
} from "../lib/private-directory-manager.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";
import { SupervisedProcessRunner } from "../lib/supervised-process-runner.js";

const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const STATUS_TEXT = "Logged in using ChatGPT";
const STATUS_TIMEOUT_MS = 90_000;
const STATUS_OUTPUT_LIMIT = 4_096;
const CLEANUP_TIMEOUT_MS = 30_000;
const STATUS_PREPARATION_TIMEOUT_MS = 30_000;
const MAX_STATUS_TIMEOUT_MS = 120_000;
const MAX_STATUS_OPERATION_TIMEOUT_MS = 180_000;
const CLEANUP_MAXIMUM_ENTRIES = 128;
const CLEANUP_MAXIMUM_DEPTH = 16;
const CLEANUP_MAXIMUM_BYTES = 16 * 1024 * 1024;
const INVOCATION_MARKER = ".mydashboard-invocation.json";
const PROBE_KIND = "codex-login-probe";
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const STATUS_OPERATION_TIMEOUT_MS =
  STATUS_PREPARATION_TIMEOUT_MS + STATUS_TIMEOUT_MS + (2 * CLEANUP_TIMEOUT_MS);
const MAX_SCAVENGE_ENTRIES = 1_024;
const MAX_MARKER_BYTES = 4 * 1024;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_PROBE_NAME = /^probe-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const OWNED_PROBE_NAME = /^probe-([1-9][0-9]{0,15})-([0-9]{1,16})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const OPERATION_SIGNALS = new WeakMap();
const STATUS_STATES = new Set([
  "available",
  "file_login_unavailable",
  "unsafe_source",
  "broker_blocked",
  "cli_unavailable",
]);
const ERROR_DEFINITIONS = Object.freeze({
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
  STRUCTURED_PROVIDER_CLEANUP_FAILED: Object.freeze({
    message: "Structured CLI provider cleanup failed",
    statusCode: 500,
  }),
});

export class CodexLoginCredentialBrokerError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code] ??
      ERROR_DEFINITIONS.STRUCTURED_PROVIDER_UNAVAILABLE;
    super(definition.message);
    this.name = "CodexLoginCredentialBrokerError";
    this.code = ERROR_DEFINITIONS[code] === undefined
      ? "STRUCTURED_PROVIDER_UNAVAILABLE"
      : code;
    this.statusCode = definition.statusCode;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function brokerError(code) {
  return new CodexLoginCredentialBrokerError(code);
}

function reportProbeFailure(stage) {
  process.emitWarning(`Codex login probe ${stage}`, {
    code: "MYDASHBOARD_CODEX_PROBE_FAILURE",
  });
}

function failureCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function boundedTimeout(value, fallback, name, maximum) {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return timeout;
}

function createOperationSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let source = null;
  const abort = (nextSource) => {
    if (source !== null) return;
    source = nextSource;
    controller.abort();
  };
  const onCallerAbort = () => abort("caller");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  const timer = setTimeout(() => abort("deadline"), timeoutMs);
  timer.unref?.();
  OPERATION_SIGNALS.set(controller.signal, {
    readSource: () => source,
  });
  return Object.freeze({
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  });
}

function abortSource(signal) {
  const tracked = signal && OPERATION_SIGNALS.get(signal);
  if (tracked) return tracked.readSource();
  return signal?.aborted ? "caller" : null;
}

function operationAbortFailure(signal) {
  switch (abortSource(signal)) {
    case "deadline":
      return brokerError("STRUCTURED_PROVIDER_TIMEOUT");
    case "caller":
      return brokerError("STRUCTURED_PROVIDER_CANCELLED");
    default:
      return null;
  }
}

function cleanupFailureOwnsResult(error) {
  return failureCode(error) === "STRUCTURED_PROVIDER_CLEANUP_FAILED";
}

function plainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function operationPort(value) {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    !utilTypes.isProxy(value);
}

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!plainRecord(value)) throw new TypeError("Codex login broker input is invalid");
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("Codex login broker input is invalid");
  }
  if (Object.getOwnPropertySymbols(descriptors).length !== 0) {
    throw new TypeError("Codex login broker input is invalid");
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(descriptors);
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.some((key) =>
      !Object.hasOwn(descriptors[key], "value") ||
      descriptors[key].enumerable !== true)
  ) {
    throw new TypeError("Codex login broker input is invalid");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function normalizeSignal(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    !(value instanceof AbortSignal)
  ) {
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return value;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw brokerError("STRUCTURED_PROVIDER_CANCELLED");
}

function normalizeAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError("Codex login broker path is invalid");
  }
  return path.resolve(value);
}

function normalizeProtectedRoots(value) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    value.length < 1 ||
    value.length > 64
  ) {
    throw new TypeError("Codex login broker protected roots are invalid");
  }
  return Object.freeze([...new Set(value.map(normalizeAbsolutePath))]);
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertIsolatedProbeRoot(probeRoot, protectedRoots) {
  for (const protectedRoot of protectedRoots) {
    if (
      pathContains(protectedRoot, probeRoot) ||
      pathContains(probeRoot, protectedRoot)
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }
}

function exactDirectoryIdentity(value) {
  const identity = exactRecord(value, ["path", "device", "inode"]);
  if (
    !Object.isFrozen(value) ||
    normalizeAbsolutePath(identity.path) !== identity.path ||
    typeof identity.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.inode)
  ) {
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return value;
}

async function verifyDirectoryIdentity(identity) {
  const expected = exactDirectoryIdentity(identity);
  try {
    const resolved = await realpath(expected.path);
    const details = await lstat(resolved, { bigint: true });
    if (
      resolved !== expected.path ||
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.dev.toString() !== expected.device ||
      details.ino.toString() !== expected.inode
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  } catch (error) {
    if (error instanceof CodexLoginCredentialBrokerError) throw error;
    throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  return expected;
}

function mapTaskFailure(error, signal) {
  const code = failureCode(error);
  if (
    code === "CODEX_LOGIN_BROKER_BLOCKED" ||
    code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" ||
    code === "STRUCTURED_PROVIDER_REAP_FAILED"
  ) {
    return brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
  }
  const source = abortSource(signal);
  if (source === "deadline") {
    return brokerError("STRUCTURED_PROVIDER_TIMEOUT");
  }
  if (source === "caller" || code === "ABORT_ERR") {
    return brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  if (
    code === "CODEX_LOGIN_FILE_UNAVAILABLE" ||
    code === "CODEX_LOGIN_SOURCE_UNSAFE" ||
    code === "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" ||
    code === "STRUCTURED_PROVIDER_PROCESS_EXITED"
  ) {
    return brokerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  if (code === "STRUCTURED_PROVIDER_TIMEOUT") {
    return brokerError("STRUCTURED_PROVIDER_TIMEOUT");
  }
  if (code === "STRUCTURED_PROVIDER_CANCELLED") {
    return brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  return brokerError("STRUCTURED_PROVIDER_UNAVAILABLE");
}

function statusProjection(state) {
  if (!STATUS_STATES.has(state)) state = "broker_blocked";
  return Object.freeze({
    schemaVersion: 1,
    state,
    cliAvailable: state !== "cli_unavailable",
    fileLoginAvailable: state === "available",
  });
}

function statusStateFor(error, signal) {
  if (
    failureCode(error) === "CODEX_LOGIN_BROKER_BLOCKED" ||
    failureCode(error) === "STRUCTURED_PROVIDER_CLEANUP_FAILED" ||
    failureCode(error) === "STRUCTURED_PROVIDER_REAP_FAILED"
  ) {
    return "broker_blocked";
  }
  const source = abortSource(signal);
  if (source === "deadline") return "cli_unavailable";
  if (source === "caller" || failureCode(error) === "ABORT_ERR") {
    throw brokerError("STRUCTURED_PROVIDER_CANCELLED");
  }
  switch (failureCode(error)) {
    case "CODEX_LOGIN_FILE_UNAVAILABLE":
    case "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE":
    case "STRUCTURED_PROVIDER_PROCESS_EXITED":
      return "file_login_unavailable";
    case "CODEX_LOGIN_SOURCE_UNSAFE":
      return "unsafe_source";
    case "STRUCTURED_PROVIDER_UNAVAILABLE":
    case "STRUCTURED_PROVIDER_TIMEOUT":
    case "STRUCTURED_PROVIDER_PROCESS_FAILED":
      return "cli_unavailable";
    default:
      return "broker_blocked";
  }
}

function brokerOptions(rawOptions) {
  const options = exactRecord(rawOptions, ["probeRoot", "protectedRoots"]);
  const probeRoot = normalizeAbsolutePath(options.probeRoot);
  const protectedRoots = normalizeProtectedRoots(options.protectedRoots);
  assertIsolatedProbeRoot(probeRoot, protectedRoots);
  return Object.freeze({ probeRoot, protectedRoots });
}

function brokerDependencies(rawDependencies) {
  const dependencies = exactRecord(rawDependencies, [
    "store",
    "commandLocator",
    "processRunner",
    "privateDirectoryManager",
    "prepareCleanupTrees",
    "randomUUID",
  ], [
    "clock",
    "processId",
    "isProcessAlive",
    "statusTimeoutMs",
    "operationTimeoutMs",
  ]);
  const clock = dependencies.clock ?? (() => Date.now());
  const processId = dependencies.processId ?? process.pid;
  const isProcessAlive = dependencies.isProcessAlive ?? defaultProcessAlive;
  const statusTimeoutMs = boundedTimeout(
    dependencies.statusTimeoutMs,
    STATUS_TIMEOUT_MS,
    "statusTimeoutMs",
    MAX_STATUS_TIMEOUT_MS,
  );
  const operationTimeoutMs = boundedTimeout(
    dependencies.operationTimeoutMs,
    STATUS_OPERATION_TIMEOUT_MS,
    "operationTimeoutMs",
    MAX_STATUS_OPERATION_TIMEOUT_MS,
  );
  const requiredOperations = [
    [dependencies.store, ["beginTask", "stageTask", "captureTask", "stageProbe"]],
    [dependencies.commandLocator, ["resolve"]],
    [dependencies.processRunner, ["run"]],
    [dependencies.privateDirectoryManager, ["prepare"]],
  ];
  if (
    requiredOperations.some(([port, operations]) =>
      !operationPort(port) || operations.some((name) => typeof port[name] !== "function")) ||
    typeof dependencies.prepareCleanupTrees !== "function" ||
    typeof dependencies.randomUUID !== "function" ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(processId) ||
    processId < 1 ||
    typeof isProcessAlive !== "function" ||
    operationTimeoutMs <= statusTimeoutMs
  ) {
    throw new TypeError("Codex login broker test dependencies are invalid");
  }
  return Object.freeze({
    ...dependencies,
    clock,
    processId,
    isProcessAlive,
    statusTimeoutMs,
    operationTimeoutMs,
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

function productionBrokerDependencies(runtimeFacts) {
  const { protectedRoots } = runtimeFacts;
  const locations = productionCodexLoginLocations();
  return Object.freeze({
    options: Object.freeze({
      probeRoot: locations.probeRoot,
      protectedRoots,
    }),
    dependencies: Object.freeze({
      store: createProductionCodexLoginCredentialStore({ protectedRoots }),
      commandLocator: new KnownCliLocator(),
      processRunner: new SupervisedProcessRunner(),
      privateDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
      prepareCleanupTrees: prepareCleanupTreesByIdentity,
      randomUUID,
      clock: () => Date.now(),
      processId: process.pid,
      isProcessAlive: defaultProcessAlive,
    }),
  });
}

function createAdmissionQueue() {
  let active = null;
  let blocked = false;
  let closed = false;
  const waiters = [];
  const idleWaiters = new Set();

  function admissionFailure() {
    return blocked
      ? brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED")
      : brokerError("STRUCTURED_PROVIDER_UNAVAILABLE");
  }

  function notifyIdle() {
    if (active !== null) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function rejectWaiters(errorFactory) {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(errorFactory());
    }
  }

  function drain() {
    if (active !== null) return;
    if (blocked || closed) {
      notifyIdle();
      return;
    }
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(brokerError("STRUCTURED_PROVIDER_CANCELLED"));
        continue;
      }
      const token = Object.freeze({});
      active = token;
      waiter.resolve(token);
      return;
    }
    notifyIdle();
  }

  function enter(signal) {
    throwIfCancelled(signal);
    if (blocked || closed) return Promise.reject(admissionFailure());
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        onAbort: null,
      };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        reject(brokerError("STRUCTURED_PROVIDER_CANCELLED"));
        if (active === null) drain();
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
      drain();
    });
  }

  function leave(token, { safe }) {
    if (token !== active) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    active = null;
    if (!safe) {
      blocked = true;
      rejectWaiters(() => brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED"));
      notifyIdle();
      return;
    }
    drain();
  }

  function closeAdmission() {
    if (!closed) {
      closed = true;
      rejectWaiters(() => brokerError("STRUCTURED_PROVIDER_UNAVAILABLE"));
      notifyIdle();
    }
  }

  async function waitUntilIdle(signal) {
    if (active === null) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        idleWaiters.delete(complete);
        resolve();
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        idleWaiters.delete(complete);
        reject(brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED"));
      };
      idleWaiters.add(complete);
      signal?.addEventListener("abort", cancel, { once: true });
      if (active === null) complete();
    });
  }

  function isBusy() {
    return active !== null;
  }

  return Object.freeze({
    enter,
    leave,
    closeAdmission,
    waitUntilIdle,
    isBusy,
  });
}

function profileEnvironment(invocation, codexHome) {
  const profiles = {
    home: path.join(invocation.path, "home"),
    appData: path.join(invocation.path, "app-data"),
    localAppData: path.join(invocation.path, "local-app-data"),
    xdgConfig: path.join(invocation.path, "xdg-config"),
    xdgCache: path.join(invocation.path, "xdg-cache"),
    xdgData: path.join(invocation.path, "xdg-data"),
    temporary: path.join(invocation.path, "temporary"),
  };
  return Object.freeze({
    CODEX_HOME: codexHome,
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
  });
}

function createBroker(rawOptions, rawDependencies) {
  const options = brokerOptions(rawOptions);
  const dependencies = brokerDependencies(rawDependencies);
  const queue = createAdmissionQueue();
  let statusFlight = null;
  let stagedTaskToken = null;
  let closing = false;

  async function prepareProbeRoot(signal) {
    assertIsolatedProbeRoot(options.probeRoot, options.protectedRoots);
    return dependencies.privateDirectoryManager.prepare({
      directory: options.probeRoot,
      signal,
      validateLocation() {
        assertIsolatedProbeRoot(options.probeRoot, options.protectedRoots);
      },
    });
  }

  function probeOwner() {
    const createdAtMs = dependencies.clock();
    if (
      !Number.isSafeInteger(createdAtMs) ||
      createdAtMs < 0
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const createdAt = new Date(createdAtMs).toISOString();
    return Object.freeze({
      ownerPid: dependencies.processId,
      createdAtMs,
      createdAt,
    });
  }

  function probeMarker(owner) {
    return Object.freeze({
      schemaVersion: 1,
      kind: PROBE_KIND,
      ownerPid: owner.ownerPid,
      createdAt: owner.createdAt,
    });
  }

  async function writeProbeMarker(invocation, owner, signal) {
    await verifyDirectoryIdentity(invocation);
    throwIfCancelled(signal);
    const markerPath = path.join(invocation.path, INVOCATION_MARKER);
    const bytes = Buffer.from(JSON.stringify(probeMarker(owner)), "utf8");
    if (bytes.length > MAX_MARKER_BYTES) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    let handle = null;
    try {
      handle = await open(
        markerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      throwIfCancelled(signal);
      await handle.writeFile(bytes);
      await handle.sync();
      throwIfCancelled(signal);
    } catch (error) {
      if (error instanceof CodexLoginCredentialBrokerError) throw error;
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    } finally {
      try {
        await handle?.close();
      } catch {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
    }
    const details = await lstat(markerPath, { bigint: true });
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.nlink !== 1n ||
      details.size !== BigInt(bytes.length)
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    await verifyDirectoryIdentity(invocation);
  }

  async function probeIdentity(directory, probeRoot) {
    await verifyDirectoryIdentity(probeRoot);
    if (path.dirname(directory) !== probeRoot.path) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const resolved = await realpath(directory);
    const details = await lstat(resolved, { bigint: true });
    await verifyDirectoryIdentity(probeRoot);
    if (
      resolved !== directory ||
      !details.isDirectory() ||
      details.isSymbolicLink()
    ) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    return Object.freeze({
      path: resolved,
      device: details.dev.toString(),
      inode: details.ino.toString(),
    });
  }

  async function readProbeMarker(invocation, signal) {
    const markerPath = path.join(invocation.path, INVOCATION_MARKER);
    let handle = null;
    try {
      throwIfCancelled(signal);
      handle = await open(
        markerPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const details = await handle.stat({ bigint: true });
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.nlink !== 1n ||
        details.size < 1n ||
        details.size > BigInt(MAX_MARKER_BYTES)
      ) {
        return null;
      }
      const bytes = await handle.readFile();
      throwIfCancelled(signal);
      if (bytes.length > MAX_MARKER_BYTES) return null;
      let marker;
      try {
        marker = exactRecord(
          parseJsonWithUniqueKeys(bytes.toString("utf8")),
          ["schemaVersion", "kind", "ownerPid", "createdAt"],
        );
      } catch {
        return null;
      }
      const createdAtMs = Date.parse(marker.createdAt);
      if (
        marker.schemaVersion !== 1 ||
        marker.kind !== PROBE_KIND ||
        !Number.isSafeInteger(marker.ownerPid) ||
        marker.ownerPid < 1 ||
        typeof marker.createdAt !== "string" ||
        !Number.isFinite(createdAtMs) ||
        new Date(createdAtMs).toISOString() !== marker.createdAt
      ) {
        return null;
      }
      return Object.freeze({
        ownerPid: marker.ownerPid,
        createdAtMs,
      });
    } catch (error) {
      if (failureCode(error) === "ENOENT") return null;
      if (error instanceof CodexLoginCredentialBrokerError) throw error;
      return null;
    } finally {
      try {
        await handle?.close();
      } catch {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
    }
  }

  function probeNameMetadata(name) {
    const owned = OWNED_PROBE_NAME.exec(name);
    if (owned) {
      const ownerPid = Number(owned[1]);
      const createdAtMs = Number(owned[2]);
      if (
        !Number.isSafeInteger(ownerPid) ||
        ownerPid < 1 ||
        !Number.isSafeInteger(createdAtMs) ||
        createdAtMs < 0 ||
        !SAFE_UUID.test(owned[3])
      ) {
        return null;
      }
      return Object.freeze({
        owner: Object.freeze({ ownerPid, createdAtMs }),
      });
    }
    const legacy = LEGACY_PROBE_NAME.exec(name);
    if (!legacy || !SAFE_UUID.test(legacy[1])) return null;
    return Object.freeze({ owner: null });
  }

  async function cleanupProbes(invocations) {
    if (invocations.length === 0) return;
    const cleanupSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    let session = null;
    try {
      session = await dependencies.prepareCleanupTrees(invocations, {
        maximumEntries: CLEANUP_MAXIMUM_ENTRIES * invocations.length,
        maximumEntriesPerRoot: CLEANUP_MAXIMUM_ENTRIES,
        maximumDepth: CLEANUP_MAXIMUM_DEPTH,
        maximumBytes: CLEANUP_MAXIMUM_BYTES,
        signal: cleanupSignal,
      });
      if (
        session === null ||
        typeof session !== "object" ||
        typeof session.commit !== "function" ||
        typeof session.close !== "function"
      ) {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      await session.commit();
    } catch {
      reportProbeFailure(cleanupSignal.aborted
        ? "cleanup timed out"
        : session === null
          ? "cleanup preparation failed"
          : "cleanup commit failed");
      try {
        await session?.close?.();
      } catch {
        // The stable cleanup failure below owns the public result.
      }
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  async function scavengeStaleProbes(probeRoot, signal) {
    throwIfCancelled(signal);
    await verifyDirectoryIdentity(probeRoot);
    let directoryHandle = null;
    const entries = [];
    try {
      directoryHandle = await opendir(probeRoot.path);
      while (true) {
        throwIfCancelled(signal);
        const entry = await directoryHandle.read();
        if (entry === null) {
          break;
        }
        if (entries.length >= MAX_SCAVENGE_ENTRIES) {
          throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof CodexLoginCredentialBrokerError) throw error;
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    } finally {
      try {
        await directoryHandle?.close();
      } catch {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
    }
    const stale = [];
    const now = dependencies.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    for (const entry of entries) {
      throwIfCancelled(signal);
      const metadata = probeNameMetadata(entry.name);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        metadata === null
      ) {
        continue;
      }
      try {
        const invocation = await probeIdentity(
          path.join(probeRoot.path, entry.name),
          probeRoot,
        );
        const marker = await readProbeMarker(invocation, signal);
        if (
          marker !== null &&
          metadata.owner !== null &&
          (
            marker.ownerPid !== metadata.owner.ownerPid ||
            marker.createdAtMs !== metadata.owner.createdAtMs
          )
        ) {
          continue;
        }
        const owner = marker ?? metadata.owner;
        if (
          owner === null ||
          now - owner.createdAtMs < STALE_AFTER_MS
        ) {
          continue;
        }
        let alive = true;
        try {
          alive = Boolean(dependencies.isProcessAlive(owner.ownerPid));
        } catch {
          alive = true;
        }
        if (!alive) {
          stale.push(invocation);
          if (stale.length === CLEANUP_MAXIMUM_ENTRIES) {
            await cleanupProbes(stale.splice(0));
          }
        }
      } catch (error) {
        if (error instanceof CodexLoginCredentialBrokerError) throw error;
        // Unknown, raced, or untrusted entries are retained.
      }
    }
    throwIfCancelled(signal);
    await cleanupProbes(stale);
    throwIfCancelled(signal);
  }

  async function prepareProbeInvocation(signal) {
    const probeRoot = await prepareProbeRoot(signal);
    await verifyDirectoryIdentity(probeRoot);
    await scavengeStaleProbes(probeRoot, signal);
    const uuid = dependencies.randomUUID();
    if (typeof uuid !== "string" || !SAFE_UUID.test(uuid)) {
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
    const owner = probeOwner();
    const directory = path.join(
      probeRoot.path,
      `probe-${owner.ownerPid}-${owner.createdAtMs}-${uuid}`,
    );
    let invocation = null;
    try {
      invocation = await dependencies.privateDirectoryManager.prepare({
        directory,
        signal,
        async validateLocation() {
          await verifyDirectoryIdentity(probeRoot);
          if (path.dirname(directory) !== probeRoot.path) {
            throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
        },
      });
      await verifyDirectoryIdentity(probeRoot);
      invocation = await verifyDirectoryIdentity(invocation);
      await writeProbeMarker(invocation, owner, signal);
      return invocation;
    } catch (error) {
      try {
        invocation ??= await probeIdentity(directory, probeRoot);
      } catch (identityError) {
        if (failureCode(identityError) !== "ENOENT") {
          throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      if (invocation !== null) await cleanupProbes([invocation]);
      throw error;
    }
  }

  async function prepareCodexHome(invocation, signal) {
    const verifiedInvocation = await verifyDirectoryIdentity(invocation);
    const directory = path.join(verifiedInvocation.path, "codex-home");
    const codexHome = await dependencies.privateDirectoryManager.prepare({
      directory,
      signal,
      async validateLocation() {
        await verifyDirectoryIdentity(verifiedInvocation);
        if (path.dirname(directory) !== verifiedInvocation.path) {
          throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      },
    });
    await verifyDirectoryIdentity(verifiedInvocation);
    return verifyDirectoryIdentity(codexHome);
  }

  async function cleanupProbe(invocation) {
    await cleanupProbes([invocation]);
  }

  async function runStatus(invocation, codexHomePath, signal) {
    throwIfCancelled(signal);
    let descriptor;
    try {
      descriptor = await dependencies.commandLocator.resolve("codex-cli", { signal });
    } catch (error) {
      return Object.freeze({
        processAttempted: false,
        reapConfirmed: true,
        failure: mapTaskFailure(error, signal),
      });
    }
    let result;
    try {
      result = await dependencies.processRunner.run({
        executable: descriptor,
        args: ["login", "status"],
        cwd: invocation.path,
        env: profileEnvironment(invocation, codexHomePath),
        input: Buffer.alloc(0),
        signal,
        timeoutMs: dependencies.statusTimeoutMs,
        maxStdoutBytes: STATUS_OUTPUT_LIMIT,
        maxStderrBytes: STATUS_OUTPUT_LIMIT,
      });
    } catch (error) {
      return Object.freeze({
        processAttempted: true,
        reapConfirmed: failureCode(error) !== "STRUCTURED_PROVIDER_REAP_FAILED",
        failure: mapTaskFailure(error, signal),
      });
    }
    const stdout = typeof result?.stdout === "string"
      ? result.stdout.replace(/\r\n?/gu, "\n").trim()
      : "";
    const stderr = typeof result?.stderr === "string"
      ? result.stderr.replace(/\r\n?/gu, "\n").trim()
      : "";
    const exactStatus =
      (stdout === STATUS_TEXT && stderr === "") ||
      (stderr === STATUS_TEXT && stdout === "");
    if (result?.exitCode !== 0 || result?.signal !== null || !exactStatus) {
      return Object.freeze({
        processAttempted: true,
        reapConfirmed: true,
        failure: brokerError("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE"),
      });
    }
    return Object.freeze({
      processAttempted: true,
      reapConfirmed: true,
      failure: null,
    });
  }

  function createLease(token, snapshot) {
    let released = false;
    let stageStarted = false;
    let captureStarted = false;
    let codexHome = null;

    function assertActive() {
      if (released) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }

    async function stage(rawRequest) {
      assertActive();
      if (stageStarted) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      stageStarted = true;
      let signal = null;
      try {
        const request = exactRecord(rawRequest, ["invocation", "signal"]);
        signal = normalizeSignal(request.signal);
        const invocation = exactDirectoryIdentity(request.invocation);
        throwIfCancelled(signal);
        codexHome = await prepareCodexHome(invocation, signal);
        await dependencies.store.stageTask({ snapshot, codexHome, signal });
        if (!released && !closing) {
          stagedTaskToken = token;
          settleQueuedStatusAsAvailable();
        }
        return Object.freeze({ codexHome: codexHome.path });
      } catch (error) {
        throw mapTaskFailure(error, signal);
      }
    }

    async function capture(rawRequest) {
      assertActive();
      if (!stageStarted || codexHome === null || captureStarted) {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      captureStarted = true;
      let signal = null;
      try {
        const request = exactRecord(rawRequest, ["signal"]);
        signal = normalizeSignal(request.signal);
        throwIfCancelled(signal);
        await dependencies.store.captureTask({ snapshot, codexHome, signal });
      } catch (error) {
        throw mapTaskFailure(error, signal);
      }
    }

    function release(rawRequest) {
      assertActive();
      let request;
      try {
        request = exactRecord(rawRequest, ["safe"]);
      } catch {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      if (typeof request.safe !== "boolean") {
        throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      }
      released = true;
      if (stagedTaskToken === token) stagedTaskToken = null;
      queue.leave(token, { safe: request.safe });
    }

    return Object.freeze({ stage, capture, release });
  }

  async function acquire(rawRequest) {
    let signal = null;
    let token = null;
    try {
      const request = exactRecord(rawRequest, ["signal"]);
      signal = normalizeSignal(request.signal);
      token = await queue.enter(signal);
      const snapshot = await dependencies.store.beginTask({ signal });
      return createLease(token, snapshot);
    } catch (error) {
      const failure = mapTaskFailure(error, signal);
      if (token !== null) {
        queue.leave(token, {
          safe: failure.code !== "STRUCTURED_PROVIDER_CLEANUP_FAILED",
        });
      }
      throw failure;
    }
  }

  async function executeStatusProbe(callerSignal) {
    let operation = null;
    let signal = null;
    let token = null;
    let invocation = null;
    let state = "broker_blocked";
    let failure = null;
    let lifecycleSafe = true;
    let cleanupAllowed = true;
    try {
      operation = createOperationSignal(
        callerSignal,
        dependencies.operationTimeoutMs,
      );
      signal = operation.signal;
      token = await queue.enter(signal);
      invocation = await prepareProbeInvocation(signal);
      const codexHome = await prepareCodexHome(invocation, signal);
      await dependencies.store.stageProbe({ codexHome, signal });
      const outcome = await runStatus(invocation, codexHome.path, signal);
      if (!outcome.reapConfirmed) {
        reportProbeFailure("process exit could not be confirmed");
        lifecycleSafe = false;
        cleanupAllowed = false;
        failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      } else if (outcome.failure !== null) {
        throw outcome.failure;
      } else {
        state = "available";
      }
    } catch (error) {
      if (failure === null) {
        try {
          state = statusStateFor(error, signal);
          if (state === "broker_blocked") lifecycleSafe = false;
        } catch (statusFailure) {
          failure = statusFailure;
        }
      }
    } finally {
      if (invocation !== null && cleanupAllowed) {
        try {
          await cleanupProbe(invocation);
        } catch {
          state = "broker_blocked";
          lifecycleSafe = false;
          failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      if (token !== null) queue.leave(token, { safe: lifecycleSafe });
      const abortFailure = operationAbortFailure(signal);
      if (abortFailure && !cleanupFailureOwnsResult(failure)) {
        if (abortFailure.code === "STRUCTURED_PROVIDER_TIMEOUT") {
          state = "cli_unavailable";
          failure = null;
        } else {
          failure = abortFailure;
        }
      }
      operation?.close();
    }
    if (failure !== null) throw failure;
    return statusProjection(state);
  }

  function beginStatusFlight() {
    const controller = new AbortController();
    let resolveAvailable;
    const available = new Promise((resolve) => {
      resolveAvailable = resolve;
    });
    let settledAsAvailable = false;
    const flight = {
      controller,
      subscribers: 0,
      promise: null,
      settleAsAvailable() {
        if (settledAsAvailable) return;
        settledAsAvailable = true;
        resolveAvailable(statusProjection("available"));
        controller.abort();
      },
    };
    flight.promise = Promise.race([
      executeStatusProbe(controller.signal),
      available,
    ]);
    statusFlight = flight;
    void flight.promise.then(
      () => settleStatusFlight(flight),
      () => settleStatusFlight(flight),
    );
    return flight;
  }

  function settleQueuedStatusAsAvailable() {
    statusFlight?.settleAsAvailable();
  }

  function settleStatusFlight(flight) {
    if (statusFlight === flight) statusFlight = null;
  }

  function subscribeToStatusFlight(flight, callerSignal) {
    flight.subscribers += 1;
    return new Promise((resolve, reject) => {
      let cancelled = false;
      let detached = false;
      let settled = false;

      const detach = () => {
        if (detached) return;
        detached = true;
        flight.subscribers -= 1;
        callerSignal?.removeEventListener("abort", cancel);
      };
      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        detach();
        operation(value);
      };
      const cancel = () => {
        if (settled || cancelled) return;
        cancelled = true;
        detach();
        if (flight.subscribers > 0) {
          finish(reject, brokerError("STRUCTURED_PROVIDER_CANCELLED"));
          return;
        }
        if (statusFlight === flight) statusFlight = null;
        flight.controller.abort();
      };

      callerSignal?.addEventListener("abort", cancel, { once: true });
      flight.promise.then(
        (value) => {
          if (cancelled) {
            finish(reject, brokerError("STRUCTURED_PROVIDER_CANCELLED"));
          } else {
            finish(resolve, value);
          }
        },
        (error) => {
          if (
            cancelled &&
            failureCode(error) !== "STRUCTURED_PROVIDER_CLEANUP_FAILED"
          ) {
            finish(reject, brokerError("STRUCTURED_PROVIDER_CANCELLED"));
          } else {
            finish(reject, error);
          }
        },
      );
      if (callerSignal?.aborted) cancel();
    });
  }

  async function readStatus(rawRequest = {}) {
    let callerSignal = null;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      callerSignal = normalizeSignal(request.signal, { optional: true });
      throwIfCancelled(callerSignal);
    } catch (error) {
      return statusProjection(statusStateFor(error, callerSignal));
    }
    const flight = statusFlight;
    if (flight !== null) return subscribeToStatusFlight(flight, callerSignal);
    // A generation with a successfully staged credential lease already holds
    // a validated credential snapshot. Waiting for its entire model call just
    // to perform a second diagnostic probe makes the status endpoint block on
    // normal work and provides no stronger readiness signal. Mere queue
    // ownership is not enough: beginTask and stage may still fail.
    if (!closing && stagedTaskToken !== null) {
      return statusProjection("available");
    }
    const nextFlight = beginStatusFlight();
    return subscribeToStatusFlight(nextFlight, callerSignal);
  }

  async function checkAvailability(rawRequest = {}) {
    let operation = null;
    let signal = null;
    let lease = null;
    let invocation = null;
    let failure = null;
    let cleanupSafe = true;
    let cleanupAllowed = true;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      const callerSignal = normalizeSignal(request.signal, { optional: true });
      throwIfCancelled(callerSignal);
      // Credential access is serialized. An admitted task already owns the
      // same broker gate, so waiting behind it to run a redundant login probe
      // turns normal contention into a false availability timeout. The model
      // generation that follows still acquires a fresh credential snapshot
      // and performs every authoritative CLI check.
      if (queue.isBusy()) return;
      operation = createOperationSignal(
        callerSignal,
        dependencies.operationTimeoutMs,
      );
      signal = operation.signal;
      lease = await acquire({ signal });
      invocation = await prepareProbeInvocation(signal);
      const staged = await lease.stage({ invocation, signal });
      const outcome = await runStatus(invocation, staged.codexHome, signal);
      if (!outcome.reapConfirmed) {
        reportProbeFailure("process exit could not be confirmed");
        cleanupSafe = false;
        cleanupAllowed = false;
        failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      } else {
        if (outcome.processAttempted) {
          try {
            await lease.capture({
              signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
            });
          } catch {
            cleanupSafe = false;
            failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
          }
        }
        if (failure === null && outcome.failure !== null) {
          failure = outcome.failure;
        }
      }
    } catch (error) {
      if (failure === null) {
        failure = mapTaskFailure(error, signal);
        if (failure.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED") {
          cleanupSafe = false;
        }
      }
    } finally {
      if (invocation !== null && cleanupAllowed) {
        try {
          await cleanupProbe(invocation);
        } catch {
          cleanupSafe = false;
          failure = brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        }
      }
      if (lease !== null) {
        try {
          lease.release({ safe: cleanupSafe });
        } catch (error) {
          const releaseFailure = mapTaskFailure(error, signal);
          if (
            !cleanupFailureOwnsResult(failure) ||
            cleanupFailureOwnsResult(releaseFailure)
          ) {
            failure = releaseFailure;
          }
        }
      }
      const abortFailure = operationAbortFailure(signal);
      if (abortFailure && !cleanupFailureOwnsResult(failure)) {
        failure = abortFailure;
      }
      operation?.close();
    }
    if (failure !== null) throw failure;
  }

  async function close(rawRequest = {}) {
    let signal = null;
    try {
      const request = exactRecord(rawRequest, [], ["signal"]);
      signal = normalizeSignal(request.signal, { optional: true });
      closing = true;
      queue.closeAdmission();
      stagedTaskToken = null;
      if (signal?.aborted) throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      await queue.waitUntilIdle(signal);
    } catch (error) {
      if (error instanceof CodexLoginCredentialBrokerError) throw error;
      throw brokerError("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    }
  }

  return Object.freeze({ acquire, checkAvailability, readStatus, close });
}

export function createTestCodexLoginCredentialBroker(options, dependencies) {
  try {
    return createBroker(options, dependencies);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError("Codex login broker test dependencies are invalid");
    }
    throw error;
  }
}

export function createProductionCodexLoginCredentialBroker(grant) {
  if (!ProductionCliCompositionGrant.is(grant)) {
    throw new TypeError(
      "Production Codex login brokers require a lexical composition grant",
    );
  }
  const { options, dependencies } = grant.consume(productionBrokerDependencies);
  return createBroker(options, dependencies);
}
