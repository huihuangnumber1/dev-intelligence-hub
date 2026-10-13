import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createApplication,
  createApplicationRuntimeLifecycle,
} from "./composition-root.js";
import {
  normalizeUnifiedDeferredOptions,
} from "./domain/attention-deferred-contract.js";
import { canonicalJsonDigest } from "./lib/canonical-json-digest.js";
import { createApplicationWriterLease } from "./lib/application-writer-lease.js";
import { projectRoot } from "./lib/config.js";
import {
  CONFIGURATION_CONTROL_PLANE_LIMITS,
} from "./services/configuration-store.js";
import {
  CONFIRMATION_HISTORY_KINDS,
  CONFIRMATION_HISTORY_MAX_LIMIT,
  CONFIRMATION_HISTORY_STATUSES,
} from "./services/confirmation-queue.js";
import { EmployeeRegistry } from "./services/employee-registry.js";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
function drainParticipant(id) {
  return Object.freeze({ id });
}

export const DRAIN_PARTICIPANTS = Object.freeze({
  refresh: drainParticipant("refresh"),
  workflowRouting: drainParticipant("workflowRouting.ingestSnapshot"),
  workCoordinationIntake: drainParticipant("workCoordination.intake"),
  prConfirmationRecovery: drainParticipant(
    "prReviewer.recoverConfirmations",
  ),
  workCoordinationCycle: drainParticipant("workCoordination.runCycle"),
  reviewHandoffRecovery: drainParticipant("reviewHandoffReconciler.runCycle"),
  employeeExecution: drainParticipant(
    "employeeRegistry.runSelected/runAll/run",
  ),
  memoryProjection: drainParticipant("memoryProjector.runCycle"),
  confirmationOperation: drainParticipant("confirmationOperation"),
});
const registeredDrainParticipants = new Set(
  Object.values(DRAIN_PARTICIPANTS),
);

function createDrainParticipantRunner(observeDrainParticipant) {
  const active = new Map();

  function release(participant) {
    const count = active.get(participant.id) ?? 0;
    if (count <= 1) active.delete(participant.id);
    else active.set(participant.id, count - 1);
  }

  function runDrainParticipant(participant, operation) {
    if (!registeredDrainParticipants.has(participant)) {
      throw new TypeError("background participant is not registered for drain");
    }
    observeDrainParticipant(participant);
    active.set(participant.id, (active.get(participant.id) ?? 0) + 1);
    let result;
    try {
      result = operation();
    } catch (error) {
      release(participant);
      throw error;
    }
    return Promise.resolve(result).finally(() => release(participant));
  }

  runDrainParticipant.readActive = () =>
    [...active.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, count]) => Object.freeze({ id, count }));
  return runDrainParticipant;
}
const browserSecurityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const internalServerErrorMessage = "服务器内部错误";
const ownerIntakeBlockedCodes = new Set([
  "OWNER_WORK_REQUEST_LEDGER_REJECTED",
  "OWNER_WORK_REQUEST_LEDGER_STALLED",
  "OWNER_WORK_REQUEST_LEDGER_MISSING",
]);
const configurationRequestMaximumBytes = 2 * 1024 * 1024 + 64 * 1024;
const configurationInitializationKind = "local.configuration-activate";
const configurationInitializationAction = "initialize_from_draft";
const configurationRuntimeModes = new Set([
  "unbound",
  "boot_safe",
  "ready",
  "cutover",
  "restart_required",
  "unknown",
]);
const brainProviderStatusCapabilities = new Map([
  ["available", Object.freeze({ cliAvailable: true, fileLoginAvailable: true })],
  ["file_login_unavailable", Object.freeze({ cliAvailable: true, fileLoginAvailable: false })],
  ["unsafe_source", Object.freeze({ cliAvailable: true, fileLoginAvailable: false })],
  ["broker_blocked", Object.freeze({ cliAvailable: true, fileLoginAvailable: false })],
  ["cli_unavailable", Object.freeze({ cliAvailable: false, fileLoginAvailable: false })],
]);
const safeConfigurationResourceId =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const confirmationHistoryStatuses = new Set(CONFIRMATION_HISTORY_STATUSES);
const confirmationHistoryKinds = new Set(CONFIRMATION_HISTORY_KINDS);
const confirmationHistoryRoleId =
  /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const confirmationHistoryCursor = /^[A-Za-z0-9_-]{16,512}$/;
const defaultConfirmationHistoryLimit = 25;
const ownerWorkRequestId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ownerWorkRequestMaximumBytes = 72 * 1024;
const managedEnvironmentKeys = Object.freeze([
  "MYDASHBOARD_MANAGED_TOKEN",
  "MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY",
  "MYDASHBOARD_MANAGED_PROJECT_DIGEST",
  "MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS",
  "MYDASHBOARD_MANAGED_LOG_DIRECTORY",
  "MYDASHBOARD_MANAGED_INSTANCE_ID",
  "MYDASHBOARD_MANAGED_START_IDENTITY",
]);
const managedInstanceId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const managedStartIdentity = /^[a-f0-9]{64}$/u;
const managedProjectDigest = /^[a-f0-9]{64}$/u;
const sourceObjectIdentity = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const managedLogMaximumBytes = 5 * 1024 * 1024;
const managedLogArchiveCount = 4;
const managedLogMaximumRecordBytes = 64 * 1024;

function runtimeSourceIdentity(value) {
  if (value === null) return null;
  const fields = Object.keys(value ?? {}).sort();
  if (
    fields.join("\0") !== [
      "clean",
      "headOid",
      "runtimeByteCount",
      "runtimeDigest",
      "runtimeFileCount",
      "schemaVersion",
      "treeOid",
    ].sort().join("\0") ||
    value.schemaVersion !== 1 ||
    !sourceObjectIdentity.test(value.headOid) ||
    !sourceObjectIdentity.test(value.treeOid) ||
    value.clean !== true ||
    !managedProjectDigest.test(value.runtimeDigest) ||
    !Number.isSafeInteger(value.runtimeFileCount) ||
    value.runtimeFileCount <= 0 ||
    !Number.isSafeInteger(value.runtimeByteCount) ||
    value.runtimeByteCount <= 0
  ) {
    throw new TypeError("runtimeSourceIdentity is invalid");
  }
  return Object.freeze(structuredClone(value));
}
const defaultShutdownDrainTimeoutMs = 90_000;

function decodeManagedToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(token)) {
    throw new Error("managed process token is invalid");
  }
  const bytes = Buffer.from(token, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== token) {
    throw new Error("managed process token is not a canonical 256-bit value");
  }
  return bytes;
}

export function readManagedProcessEnvironment(environment = process.env) {
  const values = Object.fromEntries(
    managedEnvironmentKeys.map((name) => [name, environment[name]]),
  );
  const supplied = Object.values(values).filter((value) => value !== undefined);
  if (supplied.length === 0) return null;
  try {
    if (supplied.length !== managedEnvironmentKeys.length) {
      throw new Error("managed process environment is incomplete");
    }
    const tokenBytes = decodeManagedToken(values.MYDASHBOARD_MANAGED_TOKEN);
    const runtimeDirectory = path.resolve(
      values.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY,
    );
    const logDirectory = path.resolve(
      values.MYDASHBOARD_MANAGED_LOG_DIRECTORY,
    );
    const claimTimeoutMilliseconds = Number(
      values.MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS,
    );
    if (
      !path.isAbsolute(values.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY) ||
      !path.isAbsolute(values.MYDASHBOARD_MANAGED_LOG_DIRECTORY) ||
      path.dirname(logDirectory) !== runtimeDirectory ||
      path.basename(logDirectory) !== "logs" ||
      !managedProjectDigest.test(
        values.MYDASHBOARD_MANAGED_PROJECT_DIGEST,
      ) ||
      !managedInstanceId.test(values.MYDASHBOARD_MANAGED_INSTANCE_ID) ||
      !managedStartIdentity.test(
        values.MYDASHBOARD_MANAGED_START_IDENTITY,
      ) ||
      !Number.isInteger(claimTimeoutMilliseconds) ||
      claimTimeoutMilliseconds < 4_000 ||
      claimTimeoutMilliseconds > 120_000
    ) {
      throw new Error("managed process environment contains invalid identity");
    }
    return Object.freeze({
      token: values.MYDASHBOARD_MANAGED_TOKEN,
      tokenBytes,
      runtimeDirectory,
      logDirectory,
      projectDigest: values.MYDASHBOARD_MANAGED_PROJECT_DIGEST,
      instanceId: values.MYDASHBOARD_MANAGED_INSTANCE_ID,
      startIdentity: values.MYDASHBOARD_MANAGED_START_IDENTITY,
      claimTimeoutMilliseconds,
    });
  } finally {
    for (const name of managedEnvironmentKeys) delete environment[name];
  }
}

function boundedLogRecord(level, value) {
  const raw = value instanceof Error
    ? value.stack || `${value.name}: ${value.message}`
    : String(value);
  const prefix = `${new Date().toISOString()} ${level} `;
  const maximumMessageBytes = managedLogMaximumRecordBytes -
    Buffer.byteLength(prefix, "utf8") - 1;
  let message = raw;
  while (Buffer.byteLength(message, "utf8") > maximumMessageBytes) {
    message = message.slice(0, Math.max(0, Math.floor(message.length * 0.9)));
  }
  return `${prefix}${message}\n`;
}

export function createManagedFileDiagnostics(
  logDirectory,
  {
    maximumBytes = managedLogMaximumBytes,
    archiveCount = managedLogArchiveCount,
  } = {},
) {
  if (
    !path.isAbsolute(logDirectory) ||
    !Number.isInteger(maximumBytes) ||
    maximumBytes < managedLogMaximumRecordBytes ||
    !Number.isInteger(archiveCount) ||
    archiveCount < 1 ||
    archiveCount > managedLogArchiveCount
  ) {
    throw new TypeError("managed diagnostics configuration is invalid");
  }
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDirectory, "server.log");
  function write(level, value) {
    const record = boundedLogRecord(level, value);
    const recordBytes = Buffer.byteLength(record, "utf8");
    const currentBytes = existsSync(logPath) ? statSync(logPath).size : 0;
    if (currentBytes + recordBytes > maximumBytes) {
      const configuredOldest = `${logPath}.${archiveCount}`;
      rmSync(configuredOldest, { force: true });
      for (let index = archiveCount - 1; index >= 1; index -= 1) {
        const source = `${logPath}.${index}`;
        if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
      }
      if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
    }
    appendFileSync(logPath, record, { encoding: "utf8", mode: 0o600 });
  }
  return Object.freeze({
    log: (value) => write("INFO", value),
    reportError: (value) => write("ERROR", value),
    logPath,
    maximumBytes,
    archiveCount,
  });
}

function hmacBase64(tokenBytes, payload) {
  return createHmac("sha256", tokenBytes)
    .update(payload, "utf8")
    .digest("base64");
}

function safeTokenEquals(expectedBytes, supplied) {
  try {
    const suppliedBytes = decodeManagedToken(supplied);
    return timingSafeEqual(expectedBytes, suppliedBytes);
  } catch {
    return false;
  }
}

function fsyncParentDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurableJsonExclusive(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const text = `${JSON.stringify(value)}\n`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    linkSync(temporaryPath, filePath);
    rmSync(temporaryPath);
    fsyncParentDirectory(directory);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function receiptPayload(receipt) {
  return [
    "receipt-v1",
    receipt.phase,
    receipt.status,
    String(receipt.processId),
    receipt.instanceId,
    receipt.startIdentity,
    receipt.atUnixMilliseconds,
    receipt.errorCode || "",
  ].join("\n");
}

function createManagedProcessController(managedProcess) {
  if (!managedProcess) return null;
  let lifecycleState = "pending_claim";
  let claimPromise = null;
  let claimTimer = null;
  let requestedReceipt = null;
  let terminalReceipt = null;

  function receiptPath(phase) {
    return path.join(
      managedProcess.runtimeDirectory,
      `mydashboard-shutdown-${managedProcess.instanceId}-${phase}.json`,
    );
  }

  function createReceipt(phase, status, errorCode = null) {
    const receipt = {
      schemaVersion: 1,
      phase,
      status,
      processId: process.pid,
      instanceId: managedProcess.instanceId,
      startIdentity: managedProcess.startIdentity,
      atUnixMilliseconds: String(Date.now()),
      errorCode,
      hmac: "",
    };
    receipt.hmac = hmacBase64(
      managedProcess.tokenBytes,
      receiptPayload(receipt),
    );
    return receipt;
  }

  function assertAuthorized(request) {
    if (
      !safeTokenEquals(
        managedProcess.tokenBytes,
        request.headers["x-mydashboard-control-token"],
      ) ||
      request.headers["x-mydashboard-process-id"] !== String(process.pid) ||
      request.headers["x-mydashboard-instance-id"] !==
        managedProcess.instanceId ||
      request.headers["x-mydashboard-start-identity"] !==
        managedProcess.startIdentity
    ) {
      throw httpError(403, "进程控制身份验证失败");
    }
  }

  async function claim(request, activate) {
    assertAuthorized(request);
    if (lifecycleState === "running") return;
    if (lifecycleState !== "pending_claim") {
      throw httpError(409, "进程已进入关闭阶段");
    }
    claimPromise ||= Promise.resolve()
      .then(activate)
      .then(() => {
        if (lifecycleState !== "pending_claim") {
          throw httpError(409, "进程认领已被关闭阶段中止");
        }
        lifecycleState = "running";
        if (claimTimer) clearTimeout(claimTimer);
        claimTimer = null;
      });
    await claimPromise;
  }

  function prepareShutdown(request) {
    assertAuthorized(request);
    if (requestedReceipt) return requestedReceipt;
    const receipt = createReceipt("requested", "unknown");
    writeDurableJsonExclusive(receiptPath("requested"), receipt);
    requestedReceipt = receipt;
    lifecycleState = "stopping";
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = null;
    return receipt;
  }

  function completeShutdown(error) {
    if (terminalReceipt) return terminalReceipt;
    const receipt = createReceipt(
      "terminal",
      error ? "failure" : "success",
      error ? "LIFECYCLE_FAILURE" : null,
    );
    writeDurableJsonExclusive(receiptPath("terminal"), receipt);
    terminalReceipt = receipt;
    return receipt;
  }

  function armClaimWatchdog(
    shutdown,
    closeActiveConnections,
    reportError,
    setProcessExitCode,
  ) {
    if (lifecycleState !== "pending_claim" || claimTimer) return;
    claimTimer = setTimeout(async () => {
      if (lifecycleState !== "pending_claim") return;
      lifecycleState = "stopping";
      try {
        const shutdownPromise = shutdown();
        closeActiveConnections();
        await shutdownPromise;
      } catch (error) {
        try {
          setProcessExitCode(1);
        } catch {
          // The watchdog still reports the original lifecycle failure.
        }
        try {
          reportError(error);
        } catch {
          // Diagnostics cannot make a timed-out child safe to keep running.
        }
      }
    }, managedProcess.claimTimeoutMilliseconds);
    claimTimer.unref?.();
  }

  return Object.freeze({
    managedProcess,
    liveIdentity: () => ({
      managed: true,
      instanceId: managedProcess.instanceId,
      startIdentity: managedProcess.startIdentity,
      lifecycleState,
    }),
    isPending: () => lifecycleState === "pending_claim",
    claim,
    prepareShutdown,
    completeShutdown,
    armClaimWatchdog,
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function assertTrustedHost(request, expectedOrigin) {
  const expectedHost = new URL(expectedOrigin).host.toLowerCase();
  const requestHost = request.headers.host?.toLowerCase();
  if (requestHost !== expectedHost) {
    throw httpError(421, "请求 Host 不属于本地指挥中枢");
  }
}

function assertTrustedMutation(request, expectedOrigin, { json = false } = {}) {
  if (
    request.headers.origin !== expectedOrigin ||
    request.headers["x-mydashboard-action"] !== "1"
  ) {
    throw httpError(403, "拒绝非同源操作请求");
  }
  if (
    json &&
    request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) {
    throw httpError(415, "请求体必须使用 application/json");
  }
}

async function readJsonBody(request, maxBytes = 8 * 1024) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw httpError(413, `请求体不能超过 ${maxBytes} 字节`);
  }

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) {
      request.resume();
      throw httpError(413, `请求体不能超过 ${maxBytes} 字节`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    throw httpError(400, "请求体不能为空");
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求体不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
  return value;
}

async function withClientAbortSignal(request, response, operation) {
  const controller = new AbortController();
  const abortIncompleteRequest = () => {
    if (!request.complete) controller.abort();
  };
  const abortIncompleteResponse = () => {
    if (!response.writableFinished) controller.abort();
  };
  request.once("aborted", abortIncompleteRequest);
  request.once("close", abortIncompleteRequest);
  response.once("close", abortIncompleteResponse);
  if (
    (request.destroyed && !request.complete) ||
    (response.destroyed && !response.writableFinished)
  ) {
    controller.abort();
  }
  try {
    return await operation(controller.signal);
  } finally {
    request.off("aborted", abortIncompleteRequest);
    request.off("close", abortIncompleteRequest);
    response.off("close", abortIncompleteResponse);
  }
}

function serveStatic(response, requestPath) {
  const publicDirectory = path.join(projectRoot, "public");
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const target = path.resolve(publicDirectory, relativePath);
  const relativeTarget = path.relative(publicDirectory, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    response.writeHead(403);
    response.end();
    return;
  }
  const stream = createReadStream(target);
  stream.once("open", () => {
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(target)] || "application/octet-stream",
      "cache-control": "no-cache",
      ...browserSecurityHeaders,
    });
    stream.pipe(response);
  });
  stream.once("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const notFound = ["ENOENT", "EISDIR"].includes(error.code);
    response.writeHead(notFound ? 404 : 500);
    response.end(notFound ? "Not found" : "Server error");
  });
}

async function readDashboard(application, employeeRegistry, fallback = null) {
  const dashboard = fallback || (await application.store.read("dashboard"));
  if (!dashboard) return null;
  const prEmployee = employeeRegistry.get("pr-reviewer")
    ? await employeeRegistry.view("pr-reviewer")
    : null;
  return {
    ...dashboard,
    ...(prEmployee ? { employee: prEmployee } : {}),
  };
}

function resolveEmployeeRegistry(application) {
  if (application.employeeRegistry) return application.employeeRegistry;
  return new EmployeeRegistry(
    application.prEmployee ? [application.prEmployee] : [],
  );
}

function requirePrEmployee(employeeRegistry) {
  const employee = employeeRegistry.get("pr-reviewer");
  if (
    !employee ||
    typeof employee.decide !== "function" ||
    typeof employee.searchMemory !== "function"
  ) {
    throw httpError(503, "PR 推进员工未配置");
  }
  return employee;
}

function requireConfirmationQueue(application) {
  const queue = application.confirmationQueue;
  if (
    !queue ||
    !["next", "approve", "retry", "reject"].every(
      (method) => typeof queue[method] === "function",
    )
  ) {
    throw httpError(503, "外部动作确认队列未启用");
  }
  return queue;
}

function requireConfirmationHistoryReader(application) {
  const reader = application.confirmationQueue?.historyReader;
  if (!reader || typeof reader.list !== "function") {
    throw httpError(503, "确认历史读取端口未启用");
  }
  return reader;
}

function isConfigurationSafeMode(application) {
  return application.configuration?.status?.safeMode === true;
}

function isInitializationConfirmation(item) {
  return (
    item?.kind === configurationInitializationKind &&
    item?.display?.payload?.action?.type === configurationInitializationAction
  );
}

function initializationConfirmationNotFound() {
  return httpError(404, "找不到可在安全模式处理的配置初始化确认项");
}

function requireSafeModeConfirmationQueue(application) {
  const queue = application.confirmationQueue;
  if (
    !queue ||
    !["nextForAction", "get", "approve", "retry", "reject"].every(
      (method) => typeof queue[method] === "function",
    )
  ) {
    throw httpError(503, "配置初始化确认队列未启用");
  }

  const operate = async (operation, id, input) => {
    const item = await queue.get(id);
    if (!isInitializationConfirmation(item)) {
      throw initializationConfirmationNotFound();
    }
    return queue[operation](id, input);
  };
  return Object.freeze({
    next(options) {
      return queue.nextForAction(
        configurationInitializationKind,
        configurationInitializationAction,
        options,
      );
    },
    approve(id, input) {
      return operate("approve", id, input);
    },
    retry(id, input) {
      return operate("retry", id, input);
    },
    reject(id, input) {
      return operate("reject", id, input);
    },
  });
}

function confirmationQueueForHttp(application) {
  return isConfigurationSafeMode(application)
    ? requireSafeModeConfirmationQueue(application)
    : requireConfirmationQueue(application);
}

function requireWorkflowRouting(application) {
  const routing = application.workflowRouting;
  if (
    !routing ||
    ![
      "getConfig",
      "dryRun",
      "listAssignments",
      "listAudit",
    ].every((method) => typeof routing[method] === "function")
  ) {
    throw httpError(503, "工作流路由尚未配置");
  }
  return routing;
}

function requireWorkLedgerView(application) {
  const view = application.workLedgerView;
  if (
    !view ||
    !["getSummary", "listItems", "listTimeline"].every(
      (method) => typeof view[method] === "function",
    )
  ) {
    throw httpError(503, "员工工作台账尚未启用");
  }
  return view;
}

function requireDailyWorkLedgerView(application) {
  const view = application.dailyWorkLedgerView;
  if (
    !view ||
    !["getSummary", "listItems"].every(
      (method) => typeof view[method] === "function",
    )
  ) {
    throw httpError(503, "日常员工任务视图尚未启用");
  }
  return view;
}

function requireWorkGraphView(application) {
  const view = application.workGraphView;
  if (!view || typeof view.getSnapshot !== "function") {
    throw httpError(503, "员工工作图尚未启用");
  }
  return view;
}

function requireOwnerWorkRequests(application) {
  return requireApplicationPort(
    application,
    "ownerWorkRequests",
    ["submit", "get", "list"],
    "所有者工作请求入口尚未启用",
  );
}

function ownerWorkRequestQueryOptions(url) {
  const allowed = new Set(["limit", "cursor"]);
  const keys = [...url.searchParams.keys()];
  if (
    keys.some(
      (key) =>
        !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw httpError(400, "所有者工作请求查询参数无效");
  }
  return {
    ...(url.searchParams.has("limit")
      ? { limit: url.searchParams.get("limit") }
      : {}),
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor") }
      : {}),
  };
}

function projectGraphContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      description: criterion.description,
    })),
    expectedDeliverables: contract.expectedDeliverables.map((deliverable) => ({
      deliverableId: deliverable.deliverableId,
      kind: deliverable.kind,
      description: deliverable.description,
      required: deliverable.required,
    })),
  };
}

function projectGraphDelivery(delivery) {
  return {
    deliverableId: delivery.deliverableId,
    revision: delivery.revision,
    contractRevision: delivery.contractRevision,
    status: delivery.status,
    summary: delivery.summary,
    evidence: delivery.evidence.map((entry) => ({
      kind: entry.kind,
      referenceId: entry.referenceId,
      contentDigest: entry.contentDigest,
    })),
  };
}

const MAX_WORK_GRAPH_HTTP_TASKS = 300;

function compareGraphTaskRecency(left, right, stateById) {
  const leftTime = Date.parse(stateById.get(left.taskId)?.updatedAt || "");
  const rightTime = Date.parse(stateById.get(right.taskId)?.updatedAt || "");
  const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const safeRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  return safeRight - safeLeft || left.taskId.localeCompare(right.taskId, "en");
}

function graphTaskClosure(taskId, taskById, selected) {
  const pending = new Set();
  const stack = [taskId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (selected.has(currentId) || pending.has(currentId)) continue;
    const task = taskById.get(currentId);
    if (!task) continue;
    pending.add(currentId);
    if (task.parentTaskId !== null) stack.push(task.parentTaskId);
    stack.push(...task.dependsOn);
  }
  return pending;
}

function selectWorkGraphHttpWindow(snapshot) {
  const taskById = new Map(
    snapshot.graph.tasks.map((task) => [task.taskId, task]),
  );
  const stateById = new Map(
    snapshot.taskStates.map((state) => [state.taskId, state]),
  );
  const selected = new Set();
  const candidates = [...snapshot.graph.tasks].sort((left, right) =>
    compareGraphTaskRecency(left, right, stateById)
  );
  for (const candidate of candidates) {
    const closure = graphTaskClosure(candidate.taskId, taskById, selected);
    if (selected.size + closure.size > MAX_WORK_GRAPH_HTTP_TASKS) continue;
    for (const taskId of closure) selected.add(taskId);
    if (selected.size === MAX_WORK_GRAPH_HTTP_TASKS) break;
  }
  return {
    totalTaskCount: snapshot.graph.tasks.length,
    tasks: snapshot.graph.tasks.filter(({ taskId }) => selected.has(taskId)),
    taskStates: snapshot.taskStates.filter(({ taskId }) => selected.has(taskId)),
  };
}

function projectCurrentGraphTask(task) {
  const acceptanceContract = task.acceptanceContracts.at(-1);
  const latestByDeliverable = new Map();
  for (const delivery of task.deliveries) {
    if (delivery.contractRevision === acceptanceContract.revision) {
      latestByDeliverable.set(delivery.deliverableId, delivery);
    }
  }
  return {
    taskId: task.taskId,
    revision: task.revision,
    parentTaskId: task.parentTaskId,
    responsibility: {
      type: task.responsibility.type,
      id: task.responsibility.id,
    },
    acceptanceContract: projectGraphContract(acceptanceContract),
    latestDeliveries: acceptanceContract.expectedDeliverables
      .map(({ deliverableId }) => latestByDeliverable.get(deliverableId))
      .filter(Boolean)
      .map(projectGraphDelivery),
    history: {
      acceptanceContractCount: task.acceptanceContracts.length,
      deliveryCount: task.deliveries.length,
    },
    dependsOn: [...task.dependsOn],
  };
}

function projectWorkGraphHttpSnapshot(snapshot) {
  const window = selectWorkGraphHttpWindow(snapshot);
  return {
    schemaVersion: 2,
    totalTaskCount: window.totalTaskCount,
    graph: {
      schemaVersion: snapshot.graph.schemaVersion,
      graphId: snapshot.graph.graphId,
      revision: snapshot.graph.revision,
      tasks: window.tasks.map(projectCurrentGraphTask),
    },
    taskStates: window.taskStates.map((state) => ({
      taskId: state.taskId,
      taskRevision: state.taskRevision,
      ledgerStatus: state.ledgerStatus,
      ownerId: state.ownerId,
      statusReason: state.statusReason,
      updatedAt: state.updatedAt,
      work: {
        title: state.work.title,
        description: state.work.description,
      },
    })),
  };
}

function requireAttentionBrowser(application) {
  const browser = application.attentionBrowser;
  if (
    !browser ||
    !["answer", "reject", "later"].every(
      (method) => typeof browser[method] === "function",
    )
  ) {
    throw httpError(503, "内部请示队列尚未启用");
  }
  return browser;
}

function requireMemorySearch(application) {
  const search = application.memorySearch;
  if (
    !search ||
    !["search", "getHealth"].every(
      (method) => typeof search[method] === "function",
    )
  ) {
    throw httpError(503, "统一记忆尚未启用");
  }
  return search;
}

async function readMemoryHealth(application) {
  if (!application.memorySearch) return null;
  try {
    return await requireMemorySearch(application).getHealth();
  } catch (error) {
    if (
      error?.code === "MEMORY_AUTHORITY_NOT_CURRENT" &&
      error?.statusCode === 503
    ) {
      return Object.freeze({
        ready: false,
        authorityCurrent: false,
      });
    }
    throw error;
  }
}

function requireMemoryAnswer(application) {
  const service = application.memoryAnswer;
  if (!service || typeof service.answer !== "function") {
    throw httpError(503, "记忆问答尚未启用");
  }
  return service;
}

function requireMemoryImport(application, kind) {
  const imports = application.memoryImports;
  const service = imports?.[kind];
  const method = kind === "session" ? "importSession" : "importCommits";
  if (!service || typeof service[method] !== "function") {
    throw httpError(503, "该记忆导入能力尚未启用");
  }
  return service[method].bind(service);
}

function memoryQueryOptions(url) {
  const allowed = new Set([
    "q",
    "roleId",
    "repository",
    "eventType",
    "from",
    "to",
    "limit",
    "cursor",
  ]);
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw httpError(400, "记忆查询参数无效");
  }
  return Object.fromEntries(
    [...allowed]
      .filter((key) => url.searchParams.has(key))
      .map((key) => [key, url.searchParams.get(key)]),
  );
}

function confirmationHistoryQueryOptions(url) {
  const allowed = new Set(["status", "kind", "roleId", "limit", "cursor"]);
  const keys = [...url.searchParams.keys()];
  if (
    keys.some(
      (key) =>
        !allowed.has(key) || url.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw httpError(400, "确认历史查询参数无效");
  }

  const options = {};
  if (url.searchParams.has("status")) {
    const status = url.searchParams.get("status");
    if (!confirmationHistoryStatuses.has(status)) {
      throw httpError(400, "确认历史 status 筛选无效");
    }
    options.status = status;
  }
  if (url.searchParams.has("kind")) {
    const kind = url.searchParams.get("kind");
    if (!confirmationHistoryKinds.has(kind)) {
      throw httpError(400, "确认历史 kind 筛选无效");
    }
    options.kind = kind;
  }
  if (url.searchParams.has("roleId")) {
    const roleId = url.searchParams.get("roleId");
    if (!confirmationHistoryRoleId.test(roleId || "")) {
      throw httpError(400, "确认历史 roleId 筛选无效");
    }
    options.roleId = roleId;
  }
  if (url.searchParams.has("limit")) {
    const limit = url.searchParams.get("limit");
    if (!/^[1-9][0-9]*$/.test(limit || "")) {
      throw httpError(400, "确认历史 limit 无效");
    }
    const parsed = Number(limit);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed > CONFIRMATION_HISTORY_MAX_LIMIT
    ) {
      throw httpError(400, "确认历史 limit 无效");
    }
    options.limit = parsed;
  }
  if (url.searchParams.has("cursor")) {
    const cursor = url.searchParams.get("cursor");
    if (!confirmationHistoryCursor.test(cursor || "")) {
      throw httpError(400, "确认历史 cursor 无效");
    }
    options.cursor = cursor;
  }
  return options;
}

function confirmationHistoryFilters(options) {
  return {
    ...(options.status ? { status: options.status } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
  };
}

function unifiedAttentionOptions(url) {
  if ([...url.searchParams.keys()].some((key) => key !== "deferred")) {
    throw httpError(400, "统一确认队列查询参数无效");
  }
  const values = url.searchParams.getAll("deferred");
  if (!values.length) return undefined;
  const deferred = { external: [], internal: [] };
  for (const value of values) {
    const parts = value.split(":");
    if (parts.length !== 3) {
      throw httpError(400, "稍后处理绑定格式无效");
    }
    const [source, id, digest] = parts;
    if (source === "external") {
      deferred.external.push({ id, approvalBindingDigest: digest });
    } else if (source === "internal") {
      deferred.internal.push({ requestId: id, contentDigest: digest });
    } else {
      throw httpError(400, "稍后处理来源无效");
    }
  }
  return normalizeUnifiedDeferredOptions(deferred);
}

async function readUnifiedAttention(application, options) {
  if (
    !isConfigurationSafeMode(application) &&
    typeof application.attentionCoordinator?.next === "function"
  ) {
    return options === undefined
      ? application.attentionCoordinator.next()
      : application.attentionCoordinator.next(options);
  }
  if (application.confirmationQueue) {
    const queue = confirmationQueueForHttp(application);
    const external = options === undefined
      ? await queue.next()
      : await queue.next({ deferred: options.external });
    return {
      available: Boolean(external.item),
      source: external.item ? "external_confirmation" : null,
      pendingCount: Number.isSafeInteger(external.pendingCount)
        ? external.pendingCount
        : 0,
      externalEnabled: true,
      externalQueueRevision: Number.isSafeInteger(external.queueRevision)
        ? external.queueRevision
        : 0,
      item: external.item || null,
    };
  }
  return {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled: false,
    externalQueueRevision: 0,
    item: null,
  };
}

function queryOptions(url, { status = false, order = false, roleId = false } = {}) {
  return {
    ...(url.searchParams.has("limit")
      ? { limit: url.searchParams.get("limit") }
      : {}),
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor") }
      : {}),
    ...(status && url.searchParams.has("status")
      ? { status: url.searchParams.get("status") }
      : {}),
    ...(order && url.searchParams.has("order")
      ? { order: url.searchParams.get("order") }
      : {}),
    ...(roleId && url.searchParams.has("roleId")
      ? { roleId: url.searchParams.get("roleId") }
      : {}),
  };
}

const codeJobPauseReason = "用户从本地指挥中枢暂停代码任务";
const codeJobCancelReason = "用户从本地指挥中枢取消代码任务";
const sha256Pattern = /^[a-f0-9]{64}$/;
const changePackageApplicationConflictCodes = new Set([
  "CHANGE_PACKAGE_APPLICATION_STALE",
  "CHANGE_PACKAGE_TARGET_DIRTY",
  "CHANGE_PACKAGE_TARGET_STALE",
  "CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT",
  "CHANGE_PACKAGE_APPLICATION_SOURCE_CHANGED",
]);
const changePackageApplicationProjectionStatuses = new Set([
  "not_requested",
  "pending",
  "applying",
  "rejected",
  "stale",
  "failed",
  "applied",
  "already",
]);
const safeChangePackageApplicationId =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const safeChangePackageApplicationCode = /^[A-Z][A-Z0-9_]{2,63}$/;

function codeJobDetailQueryOptions(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => !["limit", "cursor"].includes(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw httpError(400, "代码任务详情查询参数无效");
  }
  return queryOptions(url);
}

function codeJobEvidenceQueryOptions(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    !keys.includes("packageDigest") ||
    !keys.includes("sha256") ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    throw httpError(400, "测试证据查询绑定无效");
  }
  const packageDigest = url.searchParams.get("packageDigest");
  const expectedSha256 = url.searchParams.get("sha256");
  if (
    !sha256Pattern.test(packageDigest || "") ||
    !sha256Pattern.test(expectedSha256 || "")
  ) {
    throw httpError(400, "测试证据查询绑定无效");
  }
  return { packageDigest, expectedSha256 };
}

function requireApplicationPort(application, property, methods, message) {
  const port = application?.[property];
  if (
    !port ||
    !methods.every((method) => typeof port[method] === "function")
  ) {
    throw httpError(503, message);
  }
  return port;
}

function brainProviderStatusProjection(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw httpError(500, "Codex CLI 能力状态无效");
  }
  const fields = [
    "schemaVersion",
    "state",
    "cliAvailable",
    "fileLoginAvailable",
  ];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    fields.some(
      (field) =>
        !descriptors[field]?.enumerable ||
        !("value" in descriptors[field]),
    )
  ) {
    throw httpError(500, "Codex CLI 能力状态无效");
  }
  const status = Object.fromEntries(
    fields.map((field) => [field, descriptors[field].value]),
  );
  const capabilities = brainProviderStatusCapabilities.get(status.state);
  if (
    status.schemaVersion !== 1 ||
    !capabilities ||
    status.cliAvailable !== capabilities.cliAvailable ||
    status.fileLoginAvailable !== capabilities.fileLoginAvailable
  ) {
    throw httpError(500, "Codex CLI 能力状态无效");
  }
  return Object.freeze(status);
}

function resolveOperationalAdmission(application) {
  if (application?.operations === undefined) {
    return Object.freeze({
      run: (operation) => operation(),
      assertOpen: () => undefined,
    });
  }
  const admission = application.operations?.admission;
  if (!admission || typeof admission.run !== "function") {
    throw new TypeError(
      "application.operations.admission.run must be a function",
    );
  }
  return Object.freeze({
    run: admission.run.bind(admission),
    assertOpen: () => admission.run(() => undefined),
  });
}

function requireOperationsBrowser(application, methods) {
  const browser = application?.operations?.browser;
  if (
    !browser ||
    !methods.every((method) => typeof browser[method] === "function")
  ) {
    throw httpError(503, "系统运维端口未启用");
  }
  return browser;
}

function requiresOperationalAdmission(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function requireExactJsonFields(value, fields, message) {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    !expected.every((field, index) => keys[index] === field)
  ) {
    throw httpError(400, message);
  }
  return value;
}

function requireNoQuery(url, message) {
  if ([...url.searchParams.keys()].length > 0) {
    throw httpError(400, message);
  }
}

function requireNonNegativeRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(400, `${name} 无效`);
  }
  return value;
}

function requirePositiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw httpError(400, `${name} 无效`);
  }
  return value;
}

function ownerRetryItemId(value) {
  let itemId;
  try {
    itemId = decodeURIComponent(value);
  } catch {
    throw httpError(400, "itemId 无效");
  }
  if (
    !itemId.trim() ||
    /[\u0000-\u001f\u007f]/.test(itemId) ||
    Buffer.byteLength(itemId, "utf8") > 192
  ) {
    throw httpError(400, "itemId 无效");
  }
  return itemId;
}

function projectOwnerRetryResult(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.itemId !== expected.itemId ||
    value.inputDigest !== expected.expectedInputDigest ||
    value.status !== "queued" ||
    value.revision !== expected.expectedRevision + 1 ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw httpError(500, "所有者决策重试结果无效");
  }
  return {
    itemId: value.itemId,
    inputDigest: value.inputDigest,
    status: value.status,
    revision: value.revision,
    attempt: value.attempt,
  };
}

function configurationRevisionQuery(url) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 1 ||
    keys[0] !== "revision" ||
    url.searchParams.getAll("revision").length !== 1
  ) {
    throw httpError(400, "配置草稿查询必须绑定唯一 revision");
  }
  const value = url.searchParams.get("revision");
  if (!/^[1-9][0-9]*$/.test(value || "")) {
    throw httpError(400, "revision 无效");
  }
  return requirePositiveRevision(Number(value), "revision");
}

function configurationResourceId(rawValue) {
  let value;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    throw httpError(400, "配置资源 ID 无效");
  }
  if (!safeConfigurationResourceId.test(value)) {
    throw httpError(400, "配置资源 ID 无效");
  }
  return value;
}

function projectConfigurationDraft(draft, { configuration = false } = {}) {
  return {
    draftId: draft.draftId,
    revision: draft.revision,
    baseVersion: draft.baseVersion,
    configurationDigest: draft.configurationDigest,
    createdAt: draft.createdAt,
    ...(configuration ? { configuration: draft.configuration } : {}),
  };
}

function projectConfigurationVersion(version, { configuration = false } = {}) {
  if (!version) return null;
  return {
    version: version.version,
    configurationDigest: version.configurationDigest,
    source: version.source,
    previousVersion: version.previousVersion,
    draftRevisionId: version.draftRevisionId,
    rollbackOf: version.rollbackOf,
    activatedAt: version.activatedAt,
    impactDigest: version.impactDigest,
    ...(configuration ? { configuration: version.configuration } : {}),
  };
}

function projectConfigurationAudit(entry) {
  return {
    sequence: entry.sequence,
    stateRevision: entry.stateRevision,
    kind: entry.kind,
    actor: entry.actor,
    occurredAt: entry.occurredAt,
    draftId: entry.draftId,
    configurationVersion: entry.configurationVersion,
    targetVersion: entry.targetVersion,
    impactDigest: entry.impactDigest,
  };
}

function normalizeConfigurationRuntimeBinding(value) {
  if (value === null) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2
  ) {
    throw httpError(503, "配置运行时绑定无效");
  }
  const version = Object.getOwnPropertyDescriptor(value, "version");
  const configurationDigest = Object.getOwnPropertyDescriptor(
    value,
    "configurationDigest",
  );
  if (
    !version?.enumerable ||
    !("value" in version) ||
    !Number.isSafeInteger(version.value) ||
    version.value < 1 ||
    !configurationDigest?.enumerable ||
    !("value" in configurationDigest) ||
    typeof configurationDigest.value !== "string" ||
    !sha256Pattern.test(configurationDigest.value)
  ) {
    throw httpError(503, "配置运行时绑定无效");
  }
  return {
    version: version.value,
    configurationDigest: configurationDigest.value,
  };
}

function sameConfigurationRuntimeBinding(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.version === right.version &&
      left.configurationDigest === right.configurationDigest)
  );
}

async function readConfigurationRuntimeStatus(application) {
  if (!application.configuration?.runtimeStatus) return null;
  const reader = requireApplicationPort(
    application.configuration,
    "runtimeStatus",
    ["readStatus"],
    "配置运行时状态端口未启用",
  );
  const status = await reader.readStatus();
  if (
    status === null ||
    typeof status !== "object" ||
    Array.isArray(status) ||
    Object.getPrototypeOf(status) !== Object.prototype ||
    Reflect.ownKeys(status).length !== 3
  ) {
    throw httpError(503, "配置运行时状态无效");
  }
  const mode = Object.getOwnPropertyDescriptor(status, "mode");
  const storedActive = Object.getOwnPropertyDescriptor(status, "storedActive");
  const runtimeEffective = Object.getOwnPropertyDescriptor(
    status,
    "runtimeEffective",
  );
  if (
    !mode?.enumerable ||
    !("value" in mode) ||
    !configurationRuntimeModes.has(mode.value) ||
    !storedActive?.enumerable ||
    !("value" in storedActive) ||
    !runtimeEffective?.enumerable ||
    !("value" in runtimeEffective)
  ) {
    throw httpError(503, "配置运行时状态无效");
  }
  return {
    mode: mode.value,
    storedActive: normalizeConfigurationRuntimeBinding(storedActive.value),
    runtimeEffective: normalizeConfigurationRuntimeBinding(
      runtimeEffective.value,
    ),
  };
}

function inferredConfigurationRuntimeMode(storedActive, runtimeEffective) {
  if (sameConfigurationRuntimeBinding(storedActive, runtimeEffective)) {
    return storedActive === null ? "boot_safe" : "ready";
  }
  return "restart_required";
}

function effectiveConfigurationRuntimeMode(
  reported,
  storedActive,
  runtimeEffective,
) {
  const inferred = inferredConfigurationRuntimeMode(
    storedActive,
    runtimeEffective,
  );
  if (reported === null) return inferred;
  if (["cutover", "unknown", "unbound"].includes(reported.mode)) {
    return reported.mode;
  }
  return (
    sameConfigurationRuntimeBinding(reported.storedActive, storedActive) &&
    sameConfigurationRuntimeBinding(reported.runtimeEffective, runtimeEffective) &&
    reported.mode === inferred
  )
    ? reported.mode
    : "unknown";
}

async function readConfigurationHttpState(application) {
  const reader = requireApplicationPort(
    application.configuration,
    "reader",
    ["readControlPlaneSnapshot"],
    "配置控制台读取端口未启用",
  );
  const snapshot = await reader.readControlPlaneSnapshot({
    versionLimit: CONFIGURATION_CONTROL_PLANE_LIMITS.versions,
    auditLimit: CONFIGURATION_CONTROL_PLANE_LIMITS.auditEntries,
  });
  const headDrafts = snapshot.draftRevisions.toReversed();
  const storedActive = snapshot.activeVersion === null
    ? null
    : snapshot.versions.find(
        (version) => version.version === snapshot.activeVersion,
      );
  if (snapshot.activeVersion !== null && !storedActive) {
    throw httpError(503, "活动配置版本状态不完整");
  }
  const editableDraft = headDrafts.find(
    (draft) => draft.baseVersion === (snapshot.activeVersion ?? 0),
  );
  const editableConfiguration = snapshot.editableConfiguration ??
    editableDraft?.configuration ??
    storedActive?.configuration ??
    application.config;
  const runtimeActiveVersion = application.configuration.status.activeVersion ?? null;
  const runtimeConfigurationDigest = canonicalJsonDigest(application.config);
  const storedBinding = storedActive === null
    ? null
    : {
        version: storedActive.version,
        configurationDigest: storedActive.configurationDigest,
      };
  const runtimeBinding = runtimeActiveVersion === null
    ? null
    : {
        version: runtimeActiveVersion,
        configurationDigest: runtimeConfigurationDigest,
      };
  const storedRuntimeMismatch = !sameConfigurationRuntimeBinding(
    storedBinding,
    runtimeBinding,
  );
  const reportedRuntimeStatus = await readConfigurationRuntimeStatus(application);
  const runtimeMode = effectiveConfigurationRuntimeMode(
    reportedRuntimeStatus,
    storedBinding,
    runtimeBinding,
  );
  const pendingRestart =
    storedRuntimeMismatch ||
    ["unbound", "restart_required", "unknown"].includes(runtimeMode);
  return {
    status: {
      safeMode: isConfigurationSafeMode(application),
      migrationError: application.configuration.status.migrationError ?? null,
      runtimeMode,
      stateRevision: snapshot.revision,
    },
    storedActive: projectConfigurationVersion(storedActive),
    runtimeEffective: {
      activeVersion: runtimeActiveVersion,
      configurationDigest: runtimeConfigurationDigest,
      configuration: application.config,
    },
    pendingRestart,
    drafts: headDrafts.map((draft) => projectConfigurationDraft(draft)),
    versions: snapshot.versions
      .toReversed()
      .map((version) => projectConfigurationVersion(version)),
    audit: snapshot.audit
      .toReversed()
      .map((entry) => projectConfigurationAudit(entry)),
    history: snapshot.history,
    editableConfiguration,
  };
}

function assertInitializationMutationAllowed(application, snapshot) {
  if (!isConfigurationSafeMode(application)) {
    throw httpError(409, "配置初始化接口仅在安全模式可用");
  }
  if (snapshot.activeVersion !== null) {
    throw httpError(409, "配置已经初始化，请重启服务以载入活动版本");
  }
}

function assertDraftBaseVersion(snapshot, draftId, baseVersion, message) {
  const head = snapshot.draftHeads.find((draft) => draft.draftId === draftId);
  if (!head) return;
  const draft = snapshot.draftRevisions.find(
    (candidate) => candidate.draftRevisionId === head.draftRevisionId,
  );
  if (!draft || draft.baseVersion !== baseVersion) {
    throw httpError(409, message);
  }
}

function assertInitializationDraft(snapshot, draftId) {
  assertDraftBaseVersion(
    snapshot,
    draftId,
    0,
    "该草稿不是安全模式初始化草稿",
  );
}

async function assertActiveMutationAllowed(
  application,
  snapshot,
  expectedActiveVersion,
) {
  if (isConfigurationSafeMode(application)) {
    throw httpError(409, "活动配置接口在安全初始化模式不可用");
  }
  const activeVersion = requirePositiveRevision(
    expectedActiveVersion,
    "expectedActiveVersion",
  );
  if (snapshot.activeVersion !== activeVersion) {
    throw httpError(409, "活动配置版本已经变化");
  }
  if (application.configuration.status.activeVersion !== activeVersion) {
    throw httpError(409, "活动配置尚未载入当前进程，请先重启服务");
  }
  const storedActive = snapshot.versions.find(
    (version) => version.version === activeVersion,
  );
  if (!storedActive) {
    throw httpError(503, "活动配置版本状态不完整");
  }
  const storedBinding = {
    version: activeVersion,
    configurationDigest: storedActive.configurationDigest,
  };
  const runtimeBinding = {
    version: activeVersion,
    configurationDigest: canonicalJsonDigest(application.config),
  };
  const reportedRuntimeStatus = await readConfigurationRuntimeStatus(application);
  const runtimeMode = effectiveConfigurationRuntimeMode(
    reportedRuntimeStatus,
    storedBinding,
    runtimeBinding,
  );
  if (runtimeMode !== "ready") {
    throw httpError(409, "配置运行时尚未就绪，不能创建新的配置动作");
  }
  return activeVersion;
}

function assertActiveDraft(snapshot, draftId, activeVersion) {
  assertDraftBaseVersion(
    snapshot,
    draftId,
    activeVersion,
    "该草稿基于旧活动配置，请创建新草稿",
  );
}

function requireExpectedRevision(value) {
  return requirePositiveRevision(value, "expectedRevision");
}

function dataFieldMap(value, required, message, maximumFields = 32) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw httpError(500, message);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > maximumFields ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    ) ||
    required.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    throw httpError(500, message);
  }
  return new Map(keys.map((key) => [key, descriptors[key].value]));
}

function canonicalApplicationTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function normalizedApplicationReceipt(value, message) {
  if (value === null) return null;
  const fields = dataFieldMap(value, ["id", "createdAt"], message, 2);
  if (
    fields.size !== 2 ||
    !/^change-package-application-[a-f0-9]{64}$/.test(fields.get("id") || "") ||
    !canonicalApplicationTimestamp(fields.get("createdAt"))
  ) {
    throw httpError(500, message);
  }
  return { id: fields.get("id"), createdAt: fields.get("createdAt") };
}

function normalizedApplicationFailure(value, message) {
  if (value === null) return null;
  const fields = dataFieldMap(
    value,
    ["code", "outcome", "retryable", "at"],
    message,
    4,
  );
  if (
    fields.size !== 4 ||
    !safeChangePackageApplicationCode.test(fields.get("code") || "") ||
    !["absent", "unknown"].includes(fields.get("outcome")) ||
    typeof fields.get("retryable") !== "boolean" ||
    !canonicalApplicationTimestamp(fields.get("at"))
  ) {
    throw httpError(500, message);
  }
  return {
    code: fields.get("code"),
    outcome: fields.get("outcome"),
    retryable: fields.get("retryable"),
    at: fields.get("at"),
  };
}

function normalizedChangePackageApplicationProjection(
  value,
  { jobId, receipt, packageReady },
) {
  const message = "change package 应用状态绑定无效";
  const fields = dataFieldMap(value, ["status"], message);
  const status = fields.get("status");
  if (!changePackageApplicationProjectionStatuses.has(status)) {
    throw httpError(500, message);
  }
  if (status === "not_requested") {
    if (fields.size !== 1) throw httpError(500, message);
    return Object.freeze({ status, canRequest: packageReady });
  }

  for (const field of [
    "confirmationId",
    "job",
    "packageId",
    "packageDigest",
    "itemRevision",
    "createdAt",
    "updatedAt",
  ]) {
    if (!fields.has(field)) throw httpError(500, message);
  }
  const job = dataFieldMap(
    fields.get("job"),
    ["id", "revision", "recordDigest"],
    message,
    3,
  );
  if (
    job.size !== 3 ||
    job.get("id") !== jobId ||
    !Number.isSafeInteger(job.get("revision")) ||
    job.get("revision") < 1 ||
    !sha256Pattern.test(job.get("recordDigest") || "") ||
    !sha256Pattern.test(fields.get("packageDigest") || "") ||
    fields.get("packageId") !==
      `change-package-${fields.get("packageDigest")}` ||
    fields.get("packageId") !== receipt?.packageId ||
    fields.get("packageDigest") !== receipt?.packageDigest ||
    !safeChangePackageApplicationId.test(fields.get("confirmationId") || "") ||
    !Number.isSafeInteger(fields.get("itemRevision")) ||
    fields.get("itemRevision") < 1 ||
    !canonicalApplicationTimestamp(fields.get("createdAt")) ||
    !canonicalApplicationTimestamp(fields.get("updatedAt")) ||
    Date.parse(fields.get("updatedAt")) < Date.parse(fields.get("createdAt"))
  ) {
    throw httpError(500, message);
  }
  const projectedReceipt = normalizedApplicationReceipt(
    fields.has("receipt") ? fields.get("receipt") : null,
    message,
  );
  const failure = normalizedApplicationFailure(
    fields.has("failure") ? fields.get("failure") : null,
    message,
  );
  const rejectedAt = fields.has("rejectedAt")
    ? fields.get("rejectedAt")
    : null;
  if (rejectedAt !== null && !canonicalApplicationTimestamp(rejectedAt)) {
    throw httpError(500, message);
  }
  if (
    (["applied", "already"].includes(status) !== (projectedReceipt !== null)) ||
    ((status === "failed") !== (failure !== null)) ||
    ((status === "rejected") !== (rejectedAt !== null))
  ) {
    throw httpError(500, message);
  }
  return Object.freeze({
    status,
    canRequest: false,
    confirmationId: fields.get("confirmationId"),
    updatedAt: fields.get("updatedAt"),
    retryable: failure?.retryable ?? false,
    receipt: projectedReceipt,
    failure,
    rejectedAt,
  });
}

async function attachChangePackageApplicationProjection(
  application,
  detail,
  jobId,
) {
  if (!application.changePackageApplicationStatusReader) return detail;
  const reader = requireApplicationPort(
    application,
    "changePackageApplicationStatusReader",
    ["getForJob"],
    "change package 应用状态读取端口无效",
  );
  let projection;
  try {
    projection = await reader.getForJob(jobId);
  } catch (error) {
    if (error?.code === "CHANGE_PACKAGE_APPLICATION_PROJECTION_NOT_READY") {
      throw httpError(503, "change package 应用状态尚未就绪");
    }
    throw error;
  }
  const changePackage = detail.changePackage;
  const receipt = changePackage?.receipt ?? null;
  const packageReady = changePackage?.status === "ready" && receipt !== null;
  const normalized = normalizedChangePackageApplicationProjection(projection, {
    jobId,
    receipt,
    packageReady,
  });
  return {
    ...detail,
    changePackage: {
      ...changePackage,
      application: normalized,
    },
  };
}

async function readCodeJobDetail(application, jobId, options = {}) {
  const reader = requireApplicationPort(
    application,
    "codeJobReader",
    ["getDetail"],
    "本地代码任务详情读取端口无效",
  );
  const detail = await reader.getDetail({ jobId, ...options });
  if (detail === null) throw httpError(404, "代码任务不存在");
  if (
    !detail ||
    typeof detail !== "object" ||
    Array.isArray(detail) ||
    !detail.job ||
    typeof detail.job !== "object" ||
    detail.job.jobId !== jobId
  ) {
    throw httpError(409, "代码任务详情绑定无效");
  }
  return attachChangePackageApplicationProjection(application, detail, jobId);
}

function readyChangePackageReceipt(detail) {
  const receipt = detail.changePackage?.receipt;
  if (
    detail.changePackage?.status !== "ready" ||
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    typeof receipt.packageDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.packageDigest) ||
    receipt.packageId !== `change-package-${receipt.packageDigest}`
  ) {
    throw httpError(409, "代码任务 change package 尚未就绪");
  }
  return receipt;
}

function requireBoundChangePackageManifest(manifest, receipt, jobId) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.packageId !== receipt.packageId ||
    manifest.packageDigest !== receipt.packageDigest ||
    manifest.job?.id !== jobId
  ) {
    throw httpError(409, "change package 与代码任务绑定不一致");
  }
  return manifest;
}

async function readChangePackageManifest(reader, packageId) {
  try {
    return await reader.get(packageId);
  } catch (error) {
    if (error?.code === "CHANGE_PACKAGE_NOT_FOUND") {
      throw httpError(404, "change package 不存在");
    }
    if (error?.code === "CHANGE_PACKAGE_STORE_NOT_READY") {
      throw httpError(503, "change package 存储尚未就绪");
    }
    throw error;
  }
}

async function requestChangePackageApplication(requester, input) {
  try {
    return await requester.request(input);
  } catch (error) {
    if (changePackageApplicationConflictCodes.has(error?.code)) {
      throw httpError(409, error.message);
    }
    if (error?.code === "INVALID_CHANGE_PACKAGE_APPLICATION") {
      throw httpError(400, error.message);
    }
    if (error?.code === "CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE") {
      throw httpError(503, "change package 暂时无法验证");
    }
    throw error;
  }
}

async function readCodeJobEvidence(reader, input) {
  try {
    return await reader.read(input);
  } catch (error) {
    const statusByCode = {
      INVALID_CODE_JOB_EVIDENCE_REQUEST: 400,
      CODE_JOB_EVIDENCE_NOT_FOUND: 404,
      CODE_JOB_EVIDENCE_STALE: 409,
      CODE_JOB_EVIDENCE_CORRUPTED: 500,
      CODE_JOB_EVIDENCE_UNAVAILABLE: 503,
    };
    const status = statusByCode[error?.code];
    if (status) {
      throw httpError(
        status,
        status >= 500 ? "测试证据暂时无法读取" : error.message,
      );
    }
    throw error;
  }
}

function verifiedCodeJobEvidence(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const fields = [
    "jobId",
    "packageId",
    "packageDigest",
    "profileId",
    "kind",
    "sha256",
    "bytes",
    "content",
  ];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    fields.some(
      (field) =>
        !descriptors[field]?.enumerable ||
        !("value" in descriptors[field]),
    )
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const result = Object.fromEntries(
    fields.map((field) => [field, descriptors[field].value]),
  );
  for (const field of [
    "jobId",
    "packageId",
    "packageDigest",
    "profileId",
    "kind",
  ]) {
    if (result[field] !== expected[field]) {
      throw httpError(500, "测试证据读取结果绑定无效");
    }
  }
  if (
    result.sha256 !== expected.expectedSha256 ||
    !sha256Pattern.test(result.sha256 || "") ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 1 ||
    !(Buffer.isBuffer(result.content) || result.content instanceof Uint8Array)
  ) {
    throw httpError(500, "测试证据读取结果绑定无效");
  }
  const content = Buffer.from(result.content);
  if (
    content.length !== result.bytes ||
    createHash("sha256").update(content).digest("hex") !== result.sha256
  ) {
    throw httpError(500, "测试证据完整性校验失败");
  }
  return { ...result, content };
}

function sendCodeJobEvidence(response, evidence) {
  const digestBase64 = Buffer.from(evidence.sha256, "hex").toString("base64");
  const filename = [
    evidence.profileId,
    evidence.kind,
    evidence.sha256.slice(0, 12),
  ].join("-");
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}.json"`,
    "content-length": evidence.bytes,
    "content-digest": `sha-256=:${digestBase64}:`,
    "x-content-sha256": evidence.sha256,
    etag: `"${evidence.sha256}"`,
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  });
  response.end(evidence.content);
}

async function syncConfirmationOutcome(employeeRegistry, item) {
  const employee = employeeRegistry.get(item?.requestedBy?.roleId);
  if (!employee || typeof employee.recordConfirmationOutcome !== "function") {
    return false;
  }
  await employee.recordConfirmationOutcome(item);
  return true;
}

function syncConfirmationOutcomeBeforeResponse(
  employeeRegistry,
  item,
  reportError,
) {
  const sync = Promise.resolve()
    .then(() => syncConfirmationOutcome(employeeRegistry, item))
    .then(
      () => false,
      (error) => {
        try {
          reportError(error);
        } catch {
          // A diagnostic failure must not change the durable owner decision.
        }
        return true;
      },
    );
  return Promise.race([
    sync,
    new Promise((resolve) => setImmediate(() => resolve(true))),
  ]);
}

function confirmationUnavailable() {
  return Object.assign(new Error("外部动作正在核对最新事实，请稍后重试"), {
    statusCode: 503,
    code: "CONFIRMATION_FACTS_NOT_READY",
  });
}

function employeeFactsUnavailable() {
  return Object.assign(new Error("岗位正在等待最新事实，请稍后重试"), {
    statusCode: 503,
    code: "EMPLOYEE_FACTS_NOT_READY",
  });
}

function createConfirmationAccessGate(enabled) {
  let ready = !enabled;
  let activeOperations = 0;
  const drainWaiters = new Set();

  function releaseDrainers() {
    if (activeOperations !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  return Object.freeze({
    isReady() {
      return ready;
    },
    activeCount() {
      return activeOperations;
    },
    async closeAndDrain() {
      if (!enabled) return;
      ready = false;
      if (activeOperations === 0) return;
      await new Promise((resolve) => drainWaiters.add(resolve));
    },
    open() {
      if (enabled) ready = true;
    },
    async run(operation) {
      if (!enabled) return operation();
      if (!ready) throw confirmationUnavailable();
      activeOperations += 1;
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
        releaseDrainers();
      }
    },
  });
}

function runConfirmationAccess(backgroundWork, method, operation) {
  if (typeof backgroundWork?.[method] !== "function") {
    return operation();
  }
  return backgroundWork[method](operation);
}

function runConfirmationOperation(backgroundWork, operation) {
  return runConfirmationAccess(
    backgroundWork,
    "runConfirmationOperation",
    operation,
  );
}

function runConfirmationRead(backgroundWork, operation) {
  return runConfirmationAccess(backgroundWork, "runConfirmationRead", operation);
}

function signalBackgroundAgency(backgroundWork, options, reportError) {
  if (typeof backgroundWork?.signalAgency !== "function") return;
  Promise.resolve()
    .then(() => backgroundWork.signalAgency(options))
    .catch((error) => {
      try {
        reportError(error);
      } catch {
        // Background diagnostics must never change the saved user answer.
      }
    });
}

function signalBackgroundEmployee(
  backgroundWork,
  id,
  options,
  reportError,
) {
  if (typeof backgroundWork?.runEmployee !== "function") return;
  Promise.resolve()
    .then(() => backgroundWork.runEmployee(id, options))
    .catch((error) => {
      try {
        reportError(error);
      } catch {
        // Background diagnostics must never change the persisted recovery action.
      }
    });
}

function closeHttpServer(closeServer) {
  return new Promise((resolve, reject) => {
    closeServer((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function runLifecycleStep(step) {
  try {
    return Promise.resolve(step());
  } catch (error) {
    return Promise.reject(error);
  }
}

function lifecycleFailure(results) {
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return null;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "服务器关闭时发生多个错误");
}

function shutdownTimeoutMilliseconds(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new TypeError("shutdownDrainTimeoutMs must be an integer from 1 to 120000");
  }
  return value;
}

function normalizeLifecycleDrainStatus(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.activeParticipants) ||
    value.activeParticipants.length > registeredDrainParticipants.size ||
    !Number.isSafeInteger(value.activeTaskCount) ||
    value.activeTaskCount < 0 ||
    !Number.isSafeInteger(value.confirmationOperationCount) ||
    value.confirmationOperationCount < 0 ||
    !Number.isSafeInteger(value.queuedOperationCount) ||
    value.queuedOperationCount < 0 ||
    typeof value.backgroundOperationActive !== "boolean"
  ) {
    return null;
  }
  const registeredIds = new Set(
    [...registeredDrainParticipants].map(({ id }) => id),
  );
  const seen = new Set();
  const activeParticipants = [];
  for (const participant of value.activeParticipants) {
    if (
      participant === null ||
      typeof participant !== "object" ||
      Array.isArray(participant) ||
      !registeredIds.has(participant.id) ||
      seen.has(participant.id) ||
      !Number.isSafeInteger(participant.count) ||
      participant.count < 1
    ) {
      return null;
    }
    seen.add(participant.id);
    activeParticipants.push(Object.freeze({
      id: participant.id,
      count: participant.count,
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    activeParticipants: Object.freeze(activeParticipants),
    activeTaskCount: value.activeTaskCount,
    backgroundOperationActive: value.backgroundOperationActive,
    confirmationOperationCount: value.confirmationOperationCount,
    queuedOperationCount: value.queuedOperationCount,
  });
}

function lifecycleDrainTimeout(phase, suppliedDrainStatus = null) {
  const drainStatus = normalizeLifecycleDrainStatus(suppliedDrainStatus);
  const participantIds = drainStatus?.activeParticipants.map(({ id }) => id) ?? [];
  const diagnostic = drainStatus === null
    ? ""
    : `; pending participants: ${participantIds.join(", ") || "none"}` +
      `; active tasks: ${drainStatus.activeTaskCount}` +
      `; confirmation operations: ${drainStatus.confirmationOperationCount}` +
      `; queued operations: ${drainStatus.queuedOperationCount}`;
  const error = Object.assign(new Error(
    `Lifecycle drain timed out during ${phase}${diagnostic}`,
  ), {
    code: "LIFECYCLE_DRAIN_TIMEOUT",
  });
  if (drainStatus !== null) {
    Object.defineProperty(error, "drainStatus", {
      configurable: false,
      enumerable: false,
      value: drainStatus,
      writable: false,
    });
  }
  return error;
}

function readDrainStatus(readStatus) {
  if (typeof readStatus !== "function") return null;
  try {
    return readStatus();
  } catch {
    return null;
  }
}

async function settleBeforeDeadline(
  promises,
  deadline,
  phase,
  controller,
  readStatus = null,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = lifecycleDrainTimeout(phase, readDrainStatus(readStatus));
    controller.abort(error);
    throw error;
  }
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled(promises),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = lifecycleDrainTimeout(
            phase,
            readDrainStatus(readStatus),
          );
          controller.abort(error);
          reject(error);
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function attachServerLifecycle(
  server,
  application,
  backgroundWork,
  reportError = console.error,
  writerLease = null,
  shutdownDrainTimeoutMs = defaultShutdownDrainTimeoutMs,
) {
  const closeServer = server.close.bind(server);
  let shutdownPromise = null;

  async function performShutdown() {
    const deadline = Date.now() + shutdownDrainTimeoutMs;
    const controller = new AbortController();
    const stoppingBackground = backgroundWork?.stop
      ? runLifecycleStep(() => backgroundWork.stop({ signal: controller.signal }))
      : Promise.resolve();
    const closingHttp = closeHttpServer(closeServer);
    const serviceResults = await settleBeforeDeadline(
      [stoppingBackground, closingHttp],
      deadline,
      "background services",
      controller,
      () => backgroundWork?.drainStatus?.(),
    );
    const serviceFailure = lifecycleFailure(serviceResults);
    if (serviceFailure) throw serviceFailure;
    const applicationResults = await settleBeforeDeadline([
      typeof application.close === "function"
        ? runLifecycleStep(() => application.close({ signal: controller.signal }))
        : Promise.resolve(),
    ], deadline, "application runtime", controller);
    const runtimeFailure = lifecycleFailure(applicationResults);
    if (runtimeFailure) throw runtimeFailure;
    const leaseResults = await settleBeforeDeadline([
      writerLease?.close
        ? runLifecycleStep(() => writerLease.close())
        : Promise.resolve(),
    ], deadline, "writer lease", controller);
    const failure = lifecycleFailure(leaseResults);
    if (failure) throw failure;
  }

  function shutdown() {
    if (!shutdownPromise) shutdownPromise = performShutdown();
    return shutdownPromise;
  }

  Object.defineProperty(server, "shutdown", {
    configurable: false,
    enumerable: false,
    value: shutdown,
    writable: false,
  });
  server.close = (callback) => {
    shutdown().then(
      () => callback?.(),
      (error) => {
        if (callback) callback(error);
        else reportError(error);
      },
    );
    return server;
  };
  return server;
}

export function createDashboardServer(
  application,
  {
    backgroundWork,
    reportError = console.error,
    managedProcess = null,
    onManagedClaim = null,
    writerLease = null,
    shutdownDrainTimeoutMs = defaultShutdownDrainTimeoutMs,
    allowUnmanagedShutdown = true,
    runtimeSourceIdentity: runtimeSourceIdentityInput = null,
    setProcessExitCode = (code) => {
      process.exitCode = code;
    },
    terminateManagedProcess = null,
  } = {},
) {
  if (typeof reportError !== "function") {
    throw new TypeError("reportError must be a function");
  }
  if (typeof setProcessExitCode !== "function") {
    throw new TypeError("setProcessExitCode must be a function");
  }
  if (
    terminateManagedProcess !== null &&
    typeof terminateManagedProcess !== "function"
  ) {
    throw new TypeError("terminateManagedProcess must be a function or null");
  }
  if (onManagedClaim !== null && typeof onManagedClaim !== "function") {
    throw new TypeError("onManagedClaim must be a function or null");
  }
  if (
    writerLease !== null &&
    (typeof writerLease?.acquire !== "function" ||
      typeof writerLease?.close !== "function")
  ) {
    throw new TypeError("writerLease must implement acquire and close");
  }
  if (typeof allowUnmanagedShutdown !== "boolean") {
    throw new TypeError("allowUnmanagedShutdown must be a boolean");
  }
  const runtimeSource = runtimeSourceIdentity(runtimeSourceIdentityInput);
  shutdownDrainTimeoutMs = shutdownTimeoutMilliseconds(shutdownDrainTimeoutMs);
  const processController = createManagedProcessController(managedProcess);
  const expectedOrigin = `http://127.0.0.1:${application.config.port}`;
  const employeeRegistry = resolveEmployeeRegistry(application);
  const operationalAdmission = resolveOperationalAdmission(application);
  const handleRequest = async (
    request,
    response,
    operationallyAdmitted = false,
  ) => {
    let isOwnerWorkSubmission = false;
    try {
      assertTrustedHost(request, expectedOrigin);
      const url = new URL(request.url, expectedOrigin);
      if (request.method === "GET" && url.pathname === "/api/live") {
        sendJson(response, 200, {
          schemaVersion: 1,
          live: true,
          service: "mydashboard",
          processId: process.pid,
          ...(processController
            ? processController.liveIdentity()
            : { managed: false, lifecycleState: "running" }),
          ...(runtimeSource ? { runtimeSource } : {}),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/system/claim") {
        requireNoQuery(url, "进程认领请求参数无效");
        assertTrustedMutation(request, expectedOrigin);
        if (!processController || !onManagedClaim) {
          throw httpError(404, "进程认领端点不可用");
        }
        await processController.claim(request, onManagedClaim);
        sendJson(response, 200, { claimed: true, state: "running" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/system/shutdown") {
        requireNoQuery(url, "关闭服务请求参数无效");
        assertTrustedMutation(request, expectedOrigin);
        if (processController) {
          processController.prepareShutdown(request);
        } else if (!allowUnmanagedShutdown) {
          throw httpError(403, "未托管进程不接受远程关闭");
        }
        response.once("finish", () => {
          setImmediate(() => {
            server.shutdown().then(
              () => {
                try {
                  processController?.completeShutdown(null);
                  terminateManagedProcess?.(0);
                } catch (error) {
                  try {
                    setProcessExitCode(1);
                  } catch {
                    // The missing receipt remains authoritative.
                  }
                  try {
                    reportError(error);
                  } catch {
                    // Diagnostics cannot make an unknown outcome successful.
                  }
                }
              },
              (error) => {
                try {
                  processController?.completeShutdown(error);
                } catch (receiptError) {
                  error = new AggregateError(
                    [error, receiptError],
                    "shutdown and receipt publication both failed",
                  );
                }
                try {
                  setProcessExitCode(1);
                } catch {
                  // The shutdown failure remains authoritative.
                }
                try {
                  reportError(error);
                } catch {
                  // The shutdown was already requested; diagnostics cannot reopen it.
                }
              },
            );
          });
        });
        sendJson(response, 202, { accepted: true, state: "stopping" });
        return;
      }
      if (processController?.isPending()) {
        throw httpError(503, "进程尚未被管理器认领");
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/brain-providers/status"
      ) {
        requireNoQuery(url, "Codex CLI 能力查询参数无效");
        const providerStatus = requireApplicationPort(
          application,
          "brainProviderStatus",
          ["readStatus"],
          "Codex CLI 能力状态端口未启用",
        );
        await withClientAbortSignal(request, response, async (signal) => {
          const result = brainProviderStatusProjection(
            await providerStatus.readStatus({ signal }),
          );
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, 200, result);
          }
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/system/status") {
        requireNoQuery(url, "系统状态查询参数无效");
        const operations = requireOperationsBrowser(
          application,
          ["readStatus"],
        );
        sendJson(response, 200, await operations.readStatus());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/system/backups") {
        requireNoQuery(url, "备份请求查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        requireExactJsonFields(
          await readJsonBody(request),
          [],
          "备份请求字段无效",
        );
        const operations = requireOperationsBrowser(
          application,
          ["createBackup"],
        );
        sendJson(response, 201, await operations.createBackup());
        return;
      }
      if (
        !operationallyAdmitted &&
        requiresOperationalAdmission(request.method)
      ) {
        await operationalAdmission.run(() =>
          handleRequest(request, response, true),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const employees = await employeeRegistry.listRoles();
        const employee =
          employees.find((role) => role.id === "pr-reviewer") || null;
        const memory = await readMemoryHealth(application);
        sendJson(response, 200, {
          ok: true,
          service: "mydashboard",
          processId: process.pid,
          refreshing: Boolean(application.refreshService.running),
          employee,
          employees,
          ...(runtimeSource ? { runtimeSource } : {}),
          ...(memory ? { memory } : {}),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const dashboard = await readDashboard(application, employeeRegistry);
        sendJson(
          response,
          dashboard ? 200 : 404,
          dashboard || { error: "no_snapshot" },
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/configuration") {
        requireNoQuery(url, "配置状态查询参数无效");
        sendJson(response, 200, await readConfigurationHttpState(application));
        return;
      }
      const configurationDraftRead = url.pathname.match(
        /^\/api\/configuration\/drafts\/([^/]+)$/,
      );
      if (request.method === "GET" && configurationDraftRead) {
        const draftId = configurationResourceId(configurationDraftRead[1]);
        const revision = configurationRevisionQuery(url);
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readDraft"],
          "版本化配置读取端口未启用",
        );
        const draft = await reader.readDraft({ draftId, revision });
        sendJson(response, 200, {
          draft: projectConfigurationDraft(draft, { configuration: true }),
        });
        return;
      }
      const configurationVersionRead = url.pathname.match(
        /^\/api\/configuration\/versions\/([^/]+)$/,
      );
      if (request.method === "GET" && configurationVersionRead) {
        requireNoQuery(url, "配置版本查询参数无效");
        const rawVersion = configurationVersionRead[1];
        if (!/^[1-9][0-9]*$/.test(rawVersion)) {
          throw httpError(400, "version 无效");
        }
        const version = requirePositiveRevision(Number(rawVersion), "version");
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readVersion"],
          "版本化配置读取端口未启用",
        );
        const stored = await reader.readVersion({ version });
        sendJson(response, 200, {
          version: projectConfigurationVersion(stored, { configuration: true }),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/configuration/drafts"
      ) {
        requireNoQuery(url, "配置草稿创建查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const safeMode = isConfigurationSafeMode(application);
        const input = requireExactJsonFields(
          await readJsonBody(request, configurationRequestMaximumBytes),
          safeMode
            ? ["expectedStateRevision", "configuration"]
            : [
                "expectedStateRevision",
                "expectedActiveVersion",
                "configuration",
              ],
          "配置草稿创建请求字段无效",
        );
        const expectedStateRevision = requireNonNegativeRevision(
          input.expectedStateRevision,
          "expectedStateRevision",
        );
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readAuthoritySnapshot"],
          "配置权限读取端口未启用",
        );
        const snapshot = await reader.readAuthoritySnapshot();
        let activeVersion = null;
        if (safeMode) {
          assertInitializationMutationAllowed(application, snapshot);
        } else {
          activeVersion = await assertActiveMutationAllowed(
            application,
            snapshot,
            input.expectedActiveVersion,
          );
        }
        const createMethod = safeMode
          ? "createInitializationDraft"
          : "createDraft";
        const draftManager = requireApplicationPort(
          application.configuration,
          "draftManager",
          [createMethod],
          "配置草稿写入端口未启用",
        );
        const draft = await draftManager[createMethod]({
          configuration: input.configuration,
          expectedStateRevision,
          proposedBy: "owner:local",
        });
        if (!safeMode && draft.baseVersion !== activeVersion) {
          throw httpError(503, "配置草稿活动版本绑定无效");
        }
        sendJson(response, 201, {
          draft: projectConfigurationDraft(draft),
        });
        return;
      }
      const configurationDraftMutation = url.pathname.match(
        /^\/api\/configuration\/drafts\/([^/]+)$/,
      );
      if (request.method === "PUT" && configurationDraftMutation) {
        requireNoQuery(url, "配置草稿修订查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const safeMode = isConfigurationSafeMode(application);
        const input = requireExactJsonFields(
          await readJsonBody(request, configurationRequestMaximumBytes),
          safeMode
            ? [
                "expectedDraftRevision",
                "expectedStateRevision",
                "configuration",
              ]
            : [
                "expectedDraftRevision",
                "expectedStateRevision",
                "expectedActiveVersion",
                "configuration",
              ],
          "配置草稿修订请求字段无效",
        );
        const draftId = configurationResourceId(configurationDraftMutation[1]);
        const expectedDraftRevision = requirePositiveRevision(
          input.expectedDraftRevision,
          "expectedDraftRevision",
        );
        const expectedStateRevision = requireNonNegativeRevision(
          input.expectedStateRevision,
          "expectedStateRevision",
        );
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readAuthoritySnapshot"],
          "配置权限读取端口未启用",
        );
        const snapshot = await reader.readAuthoritySnapshot();
        if (safeMode) {
          assertInitializationMutationAllowed(application, snapshot);
          assertInitializationDraft(snapshot, draftId);
        } else {
          const activeVersion = await assertActiveMutationAllowed(
            application,
            snapshot,
            input.expectedActiveVersion,
          );
          assertActiveDraft(snapshot, draftId, activeVersion);
        }
        const draftManager = requireApplicationPort(
          application.configuration,
          "draftManager",
          ["reviseDraft"],
          "配置草稿写入端口未启用",
        );
        const draft = await draftManager.reviseDraft({
          draftId,
          expectedDraftRevision,
          expectedStateRevision,
          configuration: input.configuration,
          proposedBy: "owner:local",
        });
        sendJson(response, 200, {
          draft: projectConfigurationDraft(draft),
        });
        return;
      }
      const configurationDraftActionRoute = url.pathname.match(
        /^\/api\/configuration\/drafts\/([^/]+)\/(preview|request-confirmation)$/,
      );
      if (request.method === "POST" && configurationDraftActionRoute) {
        requireNoQuery(url, "配置草稿请求查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const safeMode = isConfigurationSafeMode(application);
        const input = requireExactJsonFields(
          await readJsonBody(request),
          safeMode
            ? ["draftRevision", "expectedStateRevision"]
            : [
                "draftRevision",
                "expectedStateRevision",
                "expectedActiveVersion",
              ],
          "配置草稿请求字段无效",
        );
        const draftId = configurationResourceId(
          configurationDraftActionRoute[1],
        );
        const draftRevision = requirePositiveRevision(
          input.draftRevision,
          "draftRevision",
        );
        const expectedStateRevision = requireNonNegativeRevision(
          input.expectedStateRevision,
          "expectedStateRevision",
        );
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readAuthoritySnapshot"],
          "配置权限读取端口未启用",
        );
        const snapshot = await reader.readAuthoritySnapshot();
        let expectedActiveVersion = null;
        if (safeMode) {
          assertInitializationMutationAllowed(application, snapshot);
          assertInitializationDraft(snapshot, draftId);
        } else {
          expectedActiveVersion = await assertActiveMutationAllowed(
            application,
            snapshot,
            input.expectedActiveVersion,
          );
          assertActiveDraft(snapshot, draftId, expectedActiveVersion);
        }
        const requestBinding = {
          draftId,
          draftRevision,
          expectedStateRevision,
          ...(safeMode ? {} : { expectedActiveVersion }),
        };
        const previewMethod = safeMode
          ? "prepareInitialization"
          : "prepareDraftActivation";
        const requestMethod = safeMode
          ? "requestInitialization"
          : "requestDraftActivation";
        if (configurationDraftActionRoute[2] === "preview") {
          const simulator = requireApplicationPort(
            application.configuration,
            "simulator",
            [previewMethod],
            "配置影响预览端口未启用",
          );
          sendJson(
            response,
            200,
            await simulator[previewMethod](requestBinding),
          );
        } else {
          const requester = requireApplicationPort(
            application.configuration,
            "confirmationRequester",
            [requestMethod],
            "配置确认请求端口未启用",
          );
          sendJson(response, 200, {
            request: await requester[requestMethod](requestBinding),
          });
        }
        return;
      }
      const configurationRollbackRoute = url.pathname.match(
        /^\/api\/configuration\/versions\/([^/]+)\/rollback\/(preview|request-confirmation)$/,
      );
      if (request.method === "POST" && configurationRollbackRoute) {
        requireNoQuery(url, "配置回滚请求查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const rawTargetVersion = configurationRollbackRoute[1];
        if (!/^[1-9][0-9]*$/.test(rawTargetVersion)) {
          throw httpError(400, "targetVersion 无效");
        }
        const targetVersion = requirePositiveRevision(
          Number(rawTargetVersion),
          "targetVersion",
        );
        const input = requireExactJsonFields(
          await readJsonBody(request),
          ["expectedStateRevision", "expectedActiveVersion"],
          "配置回滚请求字段无效",
        );
        const expectedStateRevision = requireNonNegativeRevision(
          input.expectedStateRevision,
          "expectedStateRevision",
        );
        const reader = requireApplicationPort(
          application.configuration,
          "reader",
          ["readAuthoritySnapshot"],
          "配置权限读取端口未启用",
        );
        const snapshot = await reader.readAuthoritySnapshot();
        const expectedActiveVersion = await assertActiveMutationAllowed(
          application,
          snapshot,
          input.expectedActiveVersion,
        );
        const requestBinding = {
          targetVersion,
          expectedStateRevision,
          expectedActiveVersion,
        };
        if (configurationRollbackRoute[2] === "preview") {
          const simulator = requireApplicationPort(
            application.configuration,
            "simulator",
            ["prepareRollback"],
            "配置回滚预览端口未启用",
          );
          sendJson(response, 200, await simulator.prepareRollback(requestBinding));
        } else {
          const requester = requireApplicationPort(
            application.configuration,
            "confirmationRequester",
            ["requestRollback"],
            "配置回滚确认请求端口未启用",
          );
          sendJson(response, 200, {
            request: await requester.requestRollback(requestBinding),
          });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        assertTrustedMutation(request, expectedOrigin);
        const refresh = backgroundWork?.refresh ||
          ((options) => application.refreshService.refresh(options));
        const result = await refresh({
          notify: url.searchParams.get("notify") === "1",
        });
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry, result.dashboard),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/employees") {
        const employeeWorkView = application.dailyWorkLedgerView ??
          application.workLedgerView;
        const workloadPromise =
          typeof employeeWorkView?.getRoleWorkloads === "function"
            ? employeeWorkView.getRoleWorkloads()
              .then((result) => Array.isArray(result?.items)
                ? { available: true, items: result.items }
                : { available: false, items: [] })
              .catch((error) => {
                reportError(error);
                return { available: false, items: [] };
              })
            : Promise.resolve({ available: false, items: [] });
        const [roles, workloadResult] = await Promise.all([
          employeeRegistry.listRoles(),
          workloadPromise,
        ]);
        const workloadsAvailable = workloadResult.available;
        const workloads = new Map(
          (Array.isArray(workloadResult?.items) ? workloadResult.items : [])
            .map((workload) => [workload.roleId, workload]),
        );
        const emptyWorkload = Object.freeze({
          available: workloadsAvailable,
          counts: Object.freeze({ queued: 0, working: 0, waiting: 0, blocked: 0 }),
          tasks: Object.freeze([]),
        });
        sendJson(response, 200, {
          items: roles.map((role) => ({
            ...role,
            workload: workloads.has(role.id)
              ? { available: true, ...workloads.get(role.id) }
              : emptyWorkload,
          })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/work/requests") {
        requireNoQuery(url, "所有者工作请求参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const ownerRequestBody = await readJsonBody(
          request,
          ownerWorkRequestMaximumBytes,
        );
        const input = requireExactJsonFields(
          ownerRequestBody,
          [2, 3, 4, 6].includes(ownerRequestBody?.schemaVersion)
            ? [
                "schemaVersion",
                "requestId",
                "workType",
                "priority",
                "title",
                "description",
                "acceptanceCriteria",
                ownerRequestBody.schemaVersion === 6 ? "issue" : "pullRequest",
                ...([3, 4].includes(ownerRequestBody?.schemaVersion)
                  ? ["responsiblePerson"]
                  : []),
              ]
            : [
                "schemaVersion",
                "requestId",
                "workType",
                "priority",
                "title",
                "description",
                "acceptanceCriteria",
              ],
          "所有者工作请求字段无效",
        );
        isOwnerWorkSubmission = true;
        const result = await requireOwnerWorkRequests(application).submit(input);
        sendJson(response, result.deduplicated ? 200 : 201, result);
        if (!result.deduplicated) {
          signalBackgroundAgency(
            backgroundWork,
            { trigger: "owner_request_created" },
            reportError,
          );
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/work/requests") {
        sendJson(
          response,
          200,
          await requireOwnerWorkRequests(application).list(
            ownerWorkRequestQueryOptions(url),
          ),
        );
        return;
      }
      const ownerWorkRequestRead = url.pathname.match(
        /^\/api\/work\/requests\/([^/]+)$/,
      );
      if (request.method === "GET" && ownerWorkRequestRead) {
        requireNoQuery(url, "所有者工作请求参数无效");
        if (!ownerWorkRequestId.test(ownerWorkRequestRead[1])) {
          throw httpError(400, "requestId 无效");
        }
        const result = await requireOwnerWorkRequests(application).get(
          ownerWorkRequestRead[1],
        );
        sendJson(
          response,
          result ? 200 : 404,
          result || { error: "owner_work_request_not_found" },
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/work/summary"
      ) {
        const summary = await requireWorkLedgerView(application).getSummary();
        const prRole = employeeRegistry.get("pr-reviewer")
          ? await employeeRegistry.get("pr-reviewer").roleView()
          : null;
        sendJson(response, 200, {
          ...summary,
          safeguards: {
            prEmployeePaused: prRole ? Boolean(prRole.paused) : true,
            externalActionsEnabled:
              application.config.githubActions?.enabled === true,
          },
        });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/work/daily/summary"
      ) {
        const summary = await requireDailyWorkLedgerView(application).getSummary();
        const prRole = employeeRegistry.get("pr-reviewer")
          ? await employeeRegistry.get("pr-reviewer").roleView()
          : null;
        sendJson(response, 200, {
          ...summary,
          safeguards: {
            prEmployeePaused: prRole ? Boolean(prRole.paused) : true,
            externalActionsEnabled:
              application.config.githubActions?.enabled === true,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/work/graph") {
        const snapshot = await requireWorkGraphView(application).getSnapshot();
        sendJson(
          response,
          200,
          projectWorkGraphHttpSnapshot(snapshot),
        );
        return;
      }
      const ownerDecisionRetry = url.pathname.match(
        /^\/api\/work\/items\/([^/]+)\/retry-decision-exhaustion$/,
      );
      if (request.method === "POST" && ownerDecisionRetry) {
        requireNoQuery(url, "所有者决策重试查询参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const itemId = ownerRetryItemId(ownerDecisionRetry[1]);
        const body = requireExactJsonFields(
          await readJsonBody(request),
          ["expectedRevision", "expectedInputDigest"],
          "所有者决策重试字段无效",
        );
        const input = {
          itemId,
          expectedRevision: requirePositiveRevision(
            body.expectedRevision,
            "expectedRevision",
          ),
          expectedInputDigest: body.expectedInputDigest,
        };
        if (!sha256Pattern.test(input.expectedInputDigest || "")) {
          throw httpError(400, "expectedInputDigest 无效");
        }
        const retry = requireApplicationPort(
          application,
          "ownerWorkRetry",
          ["retryDecisionExhaustion"],
          "所有者决策重试端口未启用",
        );
        const result = projectOwnerRetryResult(
          await retry.retryDecisionExhaustion(input),
          input,
        );
        sendJson(response, 200, result);
        signalBackgroundAgency(
          backgroundWork,
          { trigger: "owner_retry_decision_exhaustion" },
          reportError,
        );
        return;
      }
      if (
        request.method === "GET" &&
        ["/api/work/items", "/api/work/timeline"].includes(url.pathname)
      ) {
        const view = requireWorkLedgerView(application);
        const result = url.pathname.endsWith("/items")
          ? await view.listItems(queryOptions(url, {
            status: true,
            order: true,
            roleId: true,
          }))
          : await view.listTimeline(queryOptions(url, { order: true }));
        sendJson(response, 200, result);
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/work/daily/items"
      ) {
        const result = await requireDailyWorkLedgerView(application).listItems(
          queryOptions(url, {
            status: true,
            order: true,
            roleId: true,
          }),
        );
        sendJson(response, 200, result);
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/code/jobs"
      ) {
        if (!application.codeJobReader) {
          sendJson(response, 200, {
            enabled: false,
            items: [],
            nextCursor: null,
          });
          return;
        }
        if (typeof application.codeJobReader.list !== "function") {
          throw httpError(503, "本地代码任务读取端口无效");
        }
        sendJson(response, 200, {
          enabled: true,
          ...(await application.codeJobReader.list(
            queryOptions(url, { status: true, order: true }),
          )),
        });
        return;
      }
      const codeJobControlAction = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/control$/,
      );
      if (request.method === "POST" && codeJobControlAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = requireExactJsonFields(
          await readJsonBody(request),
          ["command", "expectedRevision"],
          "代码任务控制请求字段无效",
        );
        if (!["pause", "resume", "cancel"].includes(input.command)) {
          throw httpError(400, "command 只能是 pause、resume 或 cancel");
        }
        const expectedRevision = requireExpectedRevision(input.expectedRevision);
        const control = requireApplicationPort(
          application,
          "codeJobControl",
          ["pause", "resume", "cancel"],
          "本地代码任务控制端口无效",
        );
        const jobId = codeJobControlAction[1];
        let result;
        if (input.command === "pause") {
          result = await control.pause({
            jobId,
            expectedRevision,
            reason: codeJobPauseReason,
          });
        } else if (input.command === "resume") {
          result = await control.resume({ jobId, expectedRevision });
        } else {
          result = await control.cancel({
            jobId,
            expectedRevision,
            reason: codeJobCancelReason,
          });
          signalBackgroundAgency(
            backgroundWork,
            { trigger: "code_job_cancel_requested" },
            reportError,
          );
        }
        sendJson(response, 200, result);
        return;
      }
      const codeJobChangePackageApplication = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/change-package\/apply$/,
      );
      if (request.method === "POST" && codeJobChangePackageApplication) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = requireExactJsonFields(
          await readJsonBody(request),
          ["expectedRevision"],
          "change package 应用请求字段无效",
        );
        const expectedRevision = requireExpectedRevision(input.expectedRevision);
        const jobId = codeJobChangePackageApplication[1];
        requireApplicationPort(
          application,
          "changePackageApplicationStatusReader",
          ["getForJob"],
          "change package 应用状态读取端口无效",
        );
        const detail = await readCodeJobDetail(application, jobId);
        if (detail.job.revision !== expectedRevision) {
          throw httpError(409, "代码任务版本已变化，请基于最新状态重试");
        }
        const receipt = readyChangePackageReceipt(detail);
        if (detail.changePackage.application?.canRequest !== true) {
          throw httpError(409, "该 change package 已经进入应用流程");
        }
        const requester = requireApplicationPort(
          application,
          "changePackageApplicationRequester",
          ["request"],
          "change package 应用请求端口无效",
        );
        const queued = await requestChangePackageApplication(requester, {
          packageId: receipt.packageId,
          requestedBy: detail.job.requestedBy,
        });
        sendJson(response, 200, { request: queued });
        signalBackgroundAgency(
          backgroundWork,
          { trigger: "change_package_application_requested" },
          reportError,
        );
        return;
      }
      const codeJobEvidence = url.pathname.match(
        /^\/api\/code\/jobs\/(code-job-[a-f0-9]{55})\/change-package\/(change-package-[a-f0-9]{64})\/evidence\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/(output|stdout|stderr)$/,
      );
      if (request.method === "GET" && codeJobEvidence) {
        const [, jobId, packageId, profileId, kind] = codeJobEvidence;
        const binding = Object.freeze({
          jobId,
          packageId,
          profileId,
          kind,
          ...codeJobEvidenceQueryOptions(url),
        });
        const readerRequest = Object.freeze({ ...binding });
        const reader = requireApplicationPort(
          application,
          "codeJobEvidenceReader",
          ["read"],
          "代码任务测试证据读取端口无效",
        );
        const evidence = verifiedCodeJobEvidence(
          await readCodeJobEvidence(reader, readerRequest),
          binding,
        );
        sendCodeJobEvidence(response, evidence);
        return;
      }
      const codeJobChangePackage = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)\/change-package$/,
      );
      if (request.method === "GET" && codeJobChangePackage) {
        const jobId = codeJobChangePackage[1];
        const detail = await readCodeJobDetail(application, jobId);
        const receipt = readyChangePackageReceipt(detail);
        const reader = requireApplicationPort(
          application,
          "changePackageReader",
          ["get"],
          "change package 读取端口无效",
        );
        const manifest = requireBoundChangePackageManifest(
          await readChangePackageManifest(reader, receipt.packageId),
          receipt,
          jobId,
        );
        sendJson(response, 200, { manifest });
        return;
      }
      const codeJobDetail = url.pathname.match(
        /^\/api\/code\/jobs\/([^/]+)$/,
      );
      if (request.method === "GET" && codeJobDetail) {
        const detail = await readCodeJobDetail(
          application,
          codeJobDetail[1],
          codeJobDetailQueryOptions(url),
        );
        sendJson(response, 200, { enabled: true, detail });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/workflow/routing"
      ) {
        sendJson(
          response,
          200,
          await requireWorkflowRouting(application).getConfig(),
        );
        return;
      }
      if (
        request.method === "GET" &&
        ["/api/workflow/assignments", "/api/workflow/audit"].includes(
          url.pathname,
        )
      ) {
        const routing = requireWorkflowRouting(application);
        const options = {
          ...(url.searchParams.has("limit")
            ? { limit: url.searchParams.get("limit") }
            : {}),
          ...(url.searchParams.has("cursor")
            ? { cursor: url.searchParams.get("cursor") }
            : {}),
        };
        const result = url.pathname.endsWith("/assignments")
          ? await routing.listAssignments(options)
          : await routing.listAudit(options);
        sendJson(response, 200, result);
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/workflow/dry-run"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { event, definition } = await readJsonBody(
          request,
          128 * 1024,
        );
        const input = {
          event,
          ...(definition === undefined ? {} : { definition }),
        };
        sendJson(
          response,
          200,
          await requireWorkflowRouting(application).dryRun(input),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/attention/next"
      ) {
        const options = unifiedAttentionOptions(url);
        const next = await runConfirmationRead(backgroundWork, () =>
          readUnifiedAttention(application, options),
        );
        sendJson(response, 200, next);
        return;
      }
      const internalAttentionAction = url.pathname.match(
        /^\/api\/attention\/internal\/(attention-[a-f0-9]{64})\/(answer|reject|later)$/,
      );
      if (request.method === "POST" && internalAttentionAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const input = await readJsonBody(request, 16 * 1024);
        if (Object.hasOwn(input, "requestId")) {
          throw httpError(400, "requestId 只能来自请求路径");
        }
        const operation = internalAttentionAction[2];
        const item = await runConfirmationOperation(backgroundWork, () =>
          requireAttentionBrowser(application)[operation]({
            ...input,
            requestId: internalAttentionAction[1],
          }),
        );
        if (operation !== "later") {
          signalBackgroundAgency(
            backgroundWork,
            { trigger: "user_answered" },
            reportError,
          );
        }
        sendJson(response, 200, { item });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/confirmations/history"
      ) {
        const options = confirmationHistoryQueryOptions(url);
        if (!application.confirmationQueue) {
          sendJson(response, 200, {
            available: false,
            queueRevision: 0,
            filters: confirmationHistoryFilters(options),
            limit: options.limit || defaultConfirmationHistoryLimit,
            roleIdFacets: [],
            items: [],
            nextCursor: null,
          });
          return;
        }
        const history = await runConfirmationRead(backgroundWork, () =>
          requireConfirmationHistoryReader(application).list(options),
        );
        sendJson(response, 200, { available: true, ...history });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/confirmations/next"
      ) {
        if (!application.confirmationQueue) {
          sendJson(response, 200, {
            available: false,
            queueRevision: 0,
            pendingCount: 0,
            item: null,
          });
          return;
        }
        const next = await runConfirmationRead(backgroundWork, () =>
          confirmationQueueForHttp(application).next(),
        );
        sendJson(response, 200, { available: true, ...next });
        return;
      }
      const confirmationRead = url.pathname.match(
        /^\/api\/confirmations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/,
      );
      if (request.method === "GET" && confirmationRead) {
        requireNoQuery(url, "确认项读取查询参数无效");
        if (!application.confirmationQueue) {
          sendJson(response, 200, { available: false, item: null });
          return;
        }
        const item = await runConfirmationRead(backgroundWork, () =>
          confirmationQueueForHttp(application).get(confirmationRead[1]),
        );
        sendJson(response, 200, { available: true, item });
        return;
      }
      const confirmationAction = url.pathname.match(
        /^\/api\/confirmations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(approve|retry|reject)$/,
      );
      if (request.method === "POST" && confirmationAction) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        await runConfirmationOperation(backgroundWork, async () => {
          const input = await readJsonBody(request);
          const queue = confirmationQueueForHttp(application);
          const item = await queue[confirmationAction[2]](
            confirmationAction[1],
            input,
          );
          const employeeSyncPending = await syncConfirmationOutcomeBeforeResponse(
            employeeRegistry,
            item,
            reportError,
          );
          sendJson(response, 200, {
            item,
            next: await queue.next(),
            employeeSyncPending,
          });
        });
        signalBackgroundAgency(
          backgroundWork,
          { trigger: "confirmation_answered" },
          reportError,
        );
        return;
      }
      const employeeAction = url.pathname.match(
        /^\/api\/employees\/([a-z0-9-]+)\/(control|run)$/,
      );
      if (
        request.method === "POST" &&
        employeeAction?.[2] === "control"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { command, expectedRevision } = await readJsonBody(request);
        await employeeRegistry.control(
          employeeAction[1],
          command,
          expectedRevision,
        );
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "POST" &&
        employeeAction?.[2] === "run"
      ) {
        assertTrustedMutation(request, expectedOrigin);
        if (typeof backgroundWork?.runEmployee === "function") {
          const result = await backgroundWork.runEmployee(employeeAction[1], {
            trigger: "manual",
          });
          if (result?.skipped) throw employeeFactsUnavailable();
        } else {
          await employeeRegistry.run(employeeAction[1], {
            trigger: "manual",
          });
        }
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-review-jobs/resolve"
      ) {
        requireNoQuery(url, "PR 失败作业恢复参数无效");
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, action, headRefOid, expectedRevision } =
          requireExactJsonFields(
            await readJsonBody(request),
            ["id", "action", "headRefOid", "expectedRevision"],
            "PR 失败作业恢复字段无效",
          );
        await requirePrEmployee(employeeRegistry).resolveBlockedJob(
          id,
          action,
          { headRefOid, expectedRevision },
        );
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        if (action === "retry") {
          signalBackgroundEmployee(
            backgroundWork,
            "pr-reviewer",
            { trigger: "blocked_job_retry" },
            reportError,
          );
        }
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-review-jobs/decide"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, decision, headRefOid, expectedRevision } =
          await readJsonBody(request);
        await requirePrEmployee(employeeRegistry).decide(id, decision, {
          headRefOid,
          expectedRevision,
        });
        sendJson(
          response,
          200,
          await readDashboard(application, employeeRegistry),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/memory/answer"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        await withClientAbortSignal(request, response, async (signal) => {
          const result = await requireMemoryAnswer(application).answer(
            await readJsonBody(request, 12 * 1024),
            { signal },
          );
          if (!signal.aborted && !response.destroyed) {
            sendJson(response, 200, result);
          }
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/memory/import/session"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        sendJson(
          response,
          200,
          await requireMemoryImport(application, "session")(
            await readJsonBody(request, 5 * 1024 * 1024),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/memory/import/git"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        sendJson(
          response,
          200,
          await requireMemoryImport(application, "git")(
            await readJsonBody(request, 3 * 1024 * 1024),
          ),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/memory/search"
      ) {
        const rawLimit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : Number.NaN;
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 100))
          : 30;
        const query = url.searchParams.get("q") || "";
        const items = application.memorySearch
          ? (
              await requireMemorySearch(application).search({
                q: query,
                limit,
              })
            ).items
          : await requirePrEmployee(employeeRegistry).searchMemory(query, limit);
        sendJson(response, 200, { query, items });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/memory/query"
      ) {
        sendJson(
          response,
          200,
          await requireMemorySearch(application).search(
            memoryQueryOptions(url),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/pr-responsibility/confirm"
      ) {
        assertTrustedMutation(request, expectedOrigin, { json: true });
        const { id, actionState, headRefOid } = await readJsonBody(request);
        const mutation = () =>
          application.refreshService.confirmPullRequestResponsibility(
            id,
            actionState,
            headRefOid,
          );
        const dashboard = backgroundWork?.mutateFacts
          ? await backgroundWork.mutateFacts(mutation)
          : await mutation();
        sendJson(response, 200, dashboard);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const status = Number.isInteger(error.statusCode)
        ? error.statusCode
        : 500;
      if (status >= 500 && status !== 503) {
        try {
          reportError(error);
        } catch {
          // Diagnostics must never replace the safe HTTP response.
        }
      }
      const ownerIntakeBlocked = status === 503 && isOwnerWorkSubmission &&
        ownerIntakeBlockedCodes.has(error.code);
      sendJson(response, status, {
        error: ownerIntakeBlocked
          ? "请求已保存并路由，但尚未进入工作台账。请重试原请求，不要重复创建。"
          : status >= 500 ? internalServerErrorMessage : error.message,
        ...(ownerIntakeBlocked ? { code: error.code } : {}),
      });
    }
  };
  const server = http.createServer(handleRequest);
  const managedServer = attachServerLifecycle(
    server,
    application,
    backgroundWork,
    reportError,
    writerLease,
    shutdownDrainTimeoutMs,
  );
  Object.defineProperty(managedServer, "armManagedClaimWatchdog", {
    configurable: false,
    enumerable: false,
    value: () => processController?.armClaimWatchdog(
      () => managedServer.shutdown(),
      () => managedServer.closeAllConnections?.(),
      reportError,
      setProcessExitCode,
    ),
    writable: false,
  });
  return managedServer;
}

function shutdownAbort() {
  return Object.assign(new Error("Lifecycle shutdown requested"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
}

function backgroundOperationOptions(input, signal) {
  const options = { ...input };
  Object.defineProperty(options, "signal", {
    configurable: false,
    enumerable: false,
    value: signal,
    writable: false,
  });
  return options;
}

function backgroundRefreshOptions(notify, signal) {
  return backgroundOperationOptions({ notify }, signal);
}

async function drainBackgroundWork(operation, drainTimeoutMs) {
  const results = await settleBeforeDeadline(
    [runLifecycleStep(operation)],
    Date.now() + drainTimeoutMs,
    "background work",
    new AbortController(),
  );
  const failure = lifecycleFailure(results);
  if (failure) throw failure;
}

function backgroundDrainStatus({
  runDrainParticipant,
  activeTaskCount,
  backgroundOperationActive,
  confirmationOperationCount,
  queuedOperationCount,
}) {
  return Object.freeze({
    schemaVersion: 1,
    activeParticipants: Object.freeze(
      runDrainParticipant.readActive(),
    ),
    activeTaskCount,
    backgroundOperationActive,
    confirmationOperationCount,
    queuedOperationCount,
  });
}

function configurationSafeModeBackgroundWork(
  application,
  operationalAdmission,
  drainTimeoutMs,
  runDrainParticipant,
) {
  const skipped = Object.freeze({ skipped: "configuration_safe_mode" });
  const skip = () => Promise.resolve(skipped);
  const confirmationEnabled = Boolean(application.confirmationQueue);
  const confirmationAccess = createConfirmationAccessGate(confirmationEnabled);
  const confirmationReadAccess = createConfirmationAccessGate(confirmationEnabled);
  confirmationAccess.open();
  confirmationReadAccess.open();
  const workController = new AbortController();
  let stopPromise = null;
  return Object.freeze({
    initialRefresh: Promise.resolve(skipped),
    timers: Object.freeze([]),
    stop() {
      if (!stopPromise) {
        workController.abort(shutdownAbort());
        stopPromise = drainBackgroundWork(() => Promise.all([
          confirmationAccess.closeAndDrain(),
          confirmationReadAccess.closeAndDrain(),
        ]), drainTimeoutMs);
      }
      return stopPromise;
    },
    refresh: skip,
    mutateFacts: skip,
    signalAgency: skip,
    runEmployee: skip,
    runConfirmationRead(operation) {
      return operationalAdmission.run(() => confirmationReadAccess.run(
        () => runDrainParticipant(
          DRAIN_PARTICIPANTS.confirmationOperation,
          () => operation(workController.signal),
        ),
      ));
    },
    runConfirmationOperation(operation) {
      return operationalAdmission.run(() => confirmationAccess.run(
        () => runDrainParticipant(
          DRAIN_PARTICIPANTS.confirmationOperation,
          () => operation(workController.signal),
        ),
      ));
    },
    confirmationReady: () =>
      confirmationEnabled && confirmationAccess.isReady(),
    drainStatus: () => backgroundDrainStatus({
      runDrainParticipant,
      activeTaskCount: 0,
      backgroundOperationActive: false,
      confirmationOperationCount:
        confirmationAccess.activeCount() + confirmationReadAccess.activeCount(),
      queuedOperationCount: 0,
    }),
  });
}

export function startApplicationBackgroundWork(
  application,
  {
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    reportError = console.error,
    drainTimeoutMs = defaultShutdownDrainTimeoutMs,
    observeDrainParticipant = () => {},
  } = {},
) {
  drainTimeoutMs = shutdownTimeoutMilliseconds(drainTimeoutMs);
  const operationalAdmission = resolveOperationalAdmission(application);
  const runDrainParticipant = createDrainParticipantRunner(
    observeDrainParticipant,
  );
  if (application.configuration?.status?.safeMode === true) {
    return configurationSafeModeBackgroundWork(
      application,
      operationalAdmission,
      drainTimeoutMs,
      runDrainParticipant,
    );
  }
  const employeeRegistry = resolveEmployeeRegistry(application);
  const timers = [];
  const activeTasks = new Set();
  const confirmationAccess = createConfirmationAccessGate(
    Boolean(application.confirmationQueue),
  );
  const confirmationReadAccess = createConfirmationAccessGate(
    Boolean(application.confirmationQueue),
  );
  const workController = new AbortController();
  let stopped = false;
  let stopPromise = null;
  const backgroundPriority = Object.freeze({
    factOrExplicit: "fact_or_explicit",
    scheduled: "scheduled",
  });
  const backgroundQueues = new Map(
    Object.values(backgroundPriority).map((priority) => [priority, []]),
  );
  let backgroundOperationActive = false;
  let factsReady = false;
  let confirmationReadReady = false;
  let pendingFactCycles = 0;
  let factCycleSequence = 0;
  const coalescedAgencyCycles = new Map();
  const coalescedRefreshCycles = new Map();

  function reportBackgroundError(error) {
    try {
      reportError(error);
    } catch {
      // A diagnostics failure must not alter lifecycle safety.
    }
  }

  function runNextBackgroundOperation() {
    if (backgroundOperationActive) return;
    const priority = Object.values(backgroundPriority)
      .find((candidate) => backgroundQueues.get(candidate).length > 0);
    const next = priority ? backgroundQueues.get(priority).shift() : null;
    if (!next) return;
    backgroundOperationActive = true;
    Promise.resolve()
      .then(next.operation)
      .then(next.resolve, next.reject)
      .finally(() => {
        backgroundOperationActive = false;
        runNextBackgroundOperation();
      });
  }

  function enqueueBackgroundOperation(priority, operation) {
    return new Promise((resolve, reject) => {
      backgroundQueues.get(priority).push({ operation, resolve, reject });
      runNextBackgroundOperation();
    });
  }

  function runTracked(
    operation,
    { rethrow = false, admitOnDequeue = false } = {},
  ) {
    if (stopped) return Promise.resolve();
    let task;
    const runOperation = async () => {
      if (stopped) return undefined;
      return operation(workController.signal);
    };
    task = Promise.resolve()
      .then(() => admitOnDequeue
        ? runOperation()
        : operationalAdmission.run(runOperation))
      .catch((error) => {
        if (!(stopped && workController.signal.aborted && error === workController.signal.reason)) {
          reportBackgroundError(error);
        }
        if (rethrow) throw error;
        return undefined;
      })
      .finally(() => activeTasks.delete(task));
    activeTasks.add(task);
    return task;
  }

  async function hasFreshPullRequestFacts() {
    if (!application.confirmationQueue) return true;
    const snapshot = await application.store?.read?.("snapshot", null);
    return snapshot?.sourceStatus?.githubPullRequests?.ok === true;
  }

  async function reconcileExternalConfirmations() {
    if (!application.confirmationQueue) return;
    const employee = employeeRegistry.get("pr-reviewer");
    if (typeof employee?.recoverConfirmations === "function") {
      await runDrainParticipant(
        DRAIN_PARTICIPANTS.prConfirmationRecovery,
        () => employee.recoverConfirmations(),
      );
    }
  }

  async function recoverReviewHandoffs(signal = workController.signal) {
    if (typeof application.reviewHandoffReconciler?.runCycle !== "function") return;
    await runDrainParticipant(
      DRAIN_PARTICIPANTS.reviewHandoffRecovery,
      () => application.reviewHandoffReconciler.runCycle({
        signal,
        // A bounded cycle may return before uncooperative I/O settles. Keep the
        // actual operation admitted and visible to backup/shutdown drain.
        runOperation: (operation) => runTracked(
          () => runDrainParticipant(DRAIN_PARTICIPANTS.reviewHandoffRecovery, operation),
          { rethrow: true },
        ),
      }),
    );
  }

  async function routeWorkflowSnapshot() {
    if (typeof application.workflowRouting?.ingestSnapshot !== "function") {
      return;
    }
    const snapshot = await application.store?.read?.("snapshot", null);
    if (snapshot) {
      await runDrainParticipant(
        DRAIN_PARTICIPANTS.workflowRouting,
        () => application.workflowRouting.ingestSnapshot({ snapshot }),
      );
    }
  }

  async function intakeWorkflowAssignments(signal) {
    signal.throwIfAborted();
    if (typeof application.workCoordination?.intake === "function") {
      await runDrainParticipant(
        DRAIN_PARTICIPANTS.workCoordinationIntake,
        () => application.workCoordination.intake(
          backgroundOperationOptions({}, signal),
        ),
      );
    }
    signal.throwIfAborted();
  }

  function agencyCycleFailure(stage, error) {
    return { stage, error };
  }

  function agencyCycleFailureCode(error) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      const code = descriptor.value;
      if (typeof code !== "string") return null;
      const match = /^[A-Z][A-Z0-9_]{0,127}$/.exec(code);
      return match?.[0] === code ? code : null;
    } catch {
      return null;
    }
  }

  function agencyCycleFailureSummary({ stage, error }) {
    const code = agencyCycleFailureCode(error);
    return `${stage}${code ? ` [${code}]` : ""}`;
  }

  function throwAgencyCycleFailures(failures, signal) {
    const reportableFailures = signal.aborted
      ? failures.filter(({ error }) => error !== signal.reason)
      : failures;
    if (reportableFailures.length === 1) throw reportableFailures[0].error;
    if (reportableFailures.length > 1) {
      throw new AggregateError(
        reportableFailures.map(({ error }) => error),
        `员工主动循环、旧岗位巡查或记忆投影失败: ${
          reportableFailures.map(agencyCycleFailureSummary).join(", ")
        }`,
      );
    }
    signal.throwIfAborted();
  }

  async function projectMemory(failures, signal, stage) {
    if (typeof application.memoryProjector?.runCycle !== "function" || stopped) {
      return;
    }
    try {
      await runDrainParticipant(
        DRAIN_PARTICIPANTS.memoryProjection,
        () => application.memoryProjector.runCycle({ signal }),
      );
    } catch (error) {
      failures.push(agencyCycleFailure(stage, error));
    }
  }

  async function performAgencyCycle({
    trigger,
    includeLegacyEmployees = false,
    employeeIds = [],
    discardWhenFactsPending = false,
    factCycleSequenceAtRequest = factCycleSequence,
    signal = workController.signal,
  }) {
    signal.throwIfAborted();
    if (stopped) return { skipped: "stopped" };
    // Completed Review receipts can settle local handoffs even if a refresh is
    // unavailable. The owner request resolver still checks current PR facts.
    try { await recoverReviewHandoffs(signal); } catch (error) { reportBackgroundError(error); }
    if (!factsReady) return { skipped: "facts_not_ready" };
    if (
      discardWhenFactsPending &&
      (
        pendingFactCycles > 0 ||
        factCycleSequenceAtRequest < factCycleSequence
      )
    ) {
      return { skipped: "newer_facts_pending" };
    }
    const failures = [];
    if (typeof application.workCoordination?.runCycle === "function") {
      try {
        await runDrainParticipant(
          DRAIN_PARTICIPANTS.workCoordinationCycle,
          () => application.workCoordination.runCycle(
            backgroundOperationOptions(
              { trigger, includeWork: false },
              signal,
            ),
          ),
        );
      } catch (error) {
        failures.push(agencyCycleFailure("coordination", error));
      }
    }
    if (signal.aborted) throwAgencyCycleFailures(failures, signal);
    const selectedEmployeeIds = [
      ...(includeLegacyEmployees ? ["pr-reviewer"] : []),
      ...employeeIds,
    ].filter((id, index, ids) => ids.indexOf(id) === index);
    if (selectedEmployeeIds.length > 0) {
      await projectMemory(failures, signal, "memory_before_employee");
    }
    if (signal.aborted) throwAgencyCycleFailures(failures, signal);
    if (selectedEmployeeIds.length > 0 && !stopped) {
      try {
        const runOptions = backgroundOperationOptions({ trigger }, signal);
        await runDrainParticipant(
          DRAIN_PARTICIPANTS.employeeExecution,
          async () => {
            if (typeof employeeRegistry.runSelected === "function") {
              await employeeRegistry.runSelected(selectedEmployeeIds, runOptions);
            } else if (
              includeLegacyEmployees &&
              typeof employeeRegistry.runAll === "function"
            ) {
              await employeeRegistry.runAll(runOptions);
            } else if (
              selectedEmployeeIds.length === 1 &&
              typeof employeeRegistry.run === "function"
            ) {
              await employeeRegistry.run(selectedEmployeeIds[0], runOptions);
            } else {
              await employeeRegistry.runAll(runOptions);
            }
          },
        );
      } catch (error) {
        failures.push(agencyCycleFailure("employee", error));
      }
    }
    if (signal.aborted) throwAgencyCycleFailures(failures, signal);
    await projectMemory(failures, signal, "memory_after_employee");
    throwAgencyCycleFailures(failures, signal);
    return { skipped: null };
  }

  function enqueueAgencyCycle(
    options,
    priority,
    { admitOnDequeue = false } = {},
  ) {
    const operation = () => admitOnDequeue
      ? operationalAdmission.run(() => performAgencyCycle(options))
      : performAgencyCycle(options);
    return enqueueBackgroundOperation(priority, operation);
  }

  function coalesceCycle(cycles, key, createCycle) {
    const existing = cycles.get(key);
    if (existing) return existing;
    let tracked;
    tracked = createCycle().finally(() => {
      if (cycles.get(key) === tracked) cycles.delete(key);
    });
    tracked.catch(() => {});
    cycles.set(key, tracked);
    return tracked;
  }

  function runCoalescedTracked(
    cycles,
    key,
    operation,
    { rethrow = false, admitOnDequeue = false } = {},
  ) {
    const existing = cycles.get(key);
    if (existing) {
      let admissionCheck;
      try {
        admissionCheck = Promise.resolve(operationalAdmission.assertOpen());
      } catch (error) {
        admissionCheck = Promise.reject(error);
      }
      const admitted = admissionCheck
        .catch((error) => {
          reportBackgroundError(error);
          throw error;
        })
        .then(() => existing);
      return rethrow ? admitted : admitted.catch(() => undefined);
    }
    const tracked = coalesceCycle(cycles, key, () =>
      runTracked(operation, { rethrow: true, admitOnDequeue }),
    );
    return rethrow ? tracked : tracked.catch(() => undefined);
  }

  function runCoalescedAgencyCycle(
    key,
    options,
    priority,
    runOptions = {},
  ) {
    return runCoalescedTracked(
      coalescedAgencyCycles,
      key,
      (signal) => enqueueAgencyCycle(
        {
          ...options,
          factCycleSequenceAtRequest: factCycleSequence,
          signal,
        },
        priority,
        runOptions,
      ),
      runOptions,
    );
  }

  function enqueueFactCycle(factOperation, signal = workController.signal) {
    factCycleSequence += 1;
    pendingFactCycles += 1;
    const operation = async () => {
      try {
        signal.throwIfAborted();
        if (stopped) return undefined;
        factsReady = false;
        await confirmationAccess.closeAndDrain();
        if (stopped) return undefined;
        const result = await factOperation(signal);
        signal.throwIfAborted();
        if (stopped) return result;
        await routeWorkflowSnapshot();
        signal.throwIfAborted();
        if (stopped) return result;
        await intakeWorkflowAssignments(signal);
        if (stopped) return result;
        if (!(await hasFreshPullRequestFacts())) return result;
        signal.throwIfAborted();
        await reconcileExternalConfirmations();
        signal.throwIfAborted();
        if (stopped) return result;
        factsReady = true;
        confirmationReadReady = true;
        confirmationReadAccess.open();
        if (pendingFactCycles === 1) {
          confirmationAccess.open();
          try {
            await performAgencyCycle({
              trigger: "refresh_completed",
              includeLegacyEmployees: true,
              signal,
            });
          } catch (error) {
            if (signal.aborted) throw error;
            reportBackgroundError(error);
          }
        }
        return result;
      } finally {
        pendingFactCycles -= 1;
        if (stopped) factsReady = false;
      }
    };
    return enqueueBackgroundOperation(
      backgroundPriority.factOrExplicit,
      operation,
    );
  }

  function runCoalescedRefresh({ notify = false } = {}, runOptions = {}) {
    const key = notify ? "notify" : "silent";
    return runCoalescedTracked(
      coalescedRefreshCycles,
      key,
      (signal) =>
        enqueueFactCycle(
          () => runDrainParticipant(
            DRAIN_PARTICIPANTS.refresh,
            () => application.refreshService.refresh(
              backgroundRefreshOptions(notify, signal),
            ),
          ),
          signal,
        ),
      runOptions,
    );
  }

  if (application.reviewHandoffReconciler) runTracked(() => recoverReviewHandoffs());
  const initialRefresh = runCoalescedRefresh(
    { notify: false },
    { rethrow: true },
  );

  timers.push(
    setIntervalFn(
      () => runCoalescedRefresh({ notify: false }),
      application.config.refreshMinutes * 60_000,
    ),
  );
  const agencyTickSeconds = Number(
    application.config.workCoordination?.tickSeconds,
  );
  if (
    typeof application.workCoordination?.runCycle === "function" &&
    Number.isFinite(agencyTickSeconds) &&
    agencyTickSeconds > 0
  ) {
    timers.push(
      setIntervalFn(
        () => runCoalescedAgencyCycle("coordination", {
          trigger: "scheduled",
          includeLegacyEmployees: false,
          discardWhenFactsPending: true,
        }, backgroundPriority.scheduled, { admitOnDequeue: true }),
        agencyTickSeconds * 1_000,
      ),
    );
  }
  for (const schedule of employeeRegistry.schedules()) {
    timers.push(
      setIntervalFn(
        () => runCoalescedAgencyCycle(`employee:${schedule.id}`, {
          trigger: "scheduled",
          employeeIds: [schedule.id],
          discardWhenFactsPending: true,
        }, backgroundPriority.scheduled, { admitOnDequeue: true }),
        schedule.intervalMinutes * 60_000,
      ),
    );
  }
  for (const timer of timers) timer.unref?.();

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    factsReady = false;
    confirmationReadReady = false;
    workController.abort(shutdownAbort());
    for (const timer of timers) clearIntervalFn(timer);
    const tasksToDrain = [...activeTasks];
    stopPromise = drainBackgroundWork(async () => {
      await Promise.all([
        confirmationAccess.closeAndDrain(),
        confirmationReadAccess.closeAndDrain(),
      ]);
      const results = await Promise.allSettled(tasksToDrain);
      const failures = results
        .filter((result) =>
          result.status === "rejected" &&
          result.reason !== workController.signal.reason
        )
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "后台任务排空时发生多个错误",
        );
      }
    }, drainTimeoutMs);
    return stopPromise;
  }

  function readBackgroundDrainStatus() {
    return backgroundDrainStatus({
      runDrainParticipant,
      activeTaskCount: activeTasks.size,
      backgroundOperationActive,
      confirmationOperationCount:
        confirmationAccess.activeCount() + confirmationReadAccess.activeCount(),
      queuedOperationCount: [...backgroundQueues.values()]
        .reduce((total, queue) => total + queue.length, 0),
    });
  }

  return {
    initialRefresh,
    timers,
    stop,
    refresh: (options) => runCoalescedRefresh(options, { rethrow: true }),
    mutateFacts: (operation) =>
      runTracked((signal) => enqueueFactCycle(operation, signal), { rethrow: true }),
    signalAgency: ({ trigger = "signal" } = {}) =>
      runCoalescedAgencyCycle(
        "signal",
        {
          trigger,
          includeLegacyEmployees: false,
        },
        backgroundPriority.factOrExplicit,
        { rethrow: true },
      ),
    runEmployee: (id, { trigger = "manual" } = {}) =>
      runCoalescedAgencyCycle(
        `manual-employee:${id}`,
        { trigger, employeeIds: [id] },
        backgroundPriority.factOrExplicit,
        { rethrow: true },
      ),
    runConfirmationRead: (operation) =>
      operationalAdmission.run(() => {
        if (!confirmationReadReady) throw confirmationUnavailable();
        return confirmationReadAccess.run(() => runDrainParticipant(
          DRAIN_PARTICIPANTS.confirmationOperation,
          () => operation(workController.signal),
        ));
      }),
    runConfirmationOperation: (operation) =>
      operationalAdmission.run(() => confirmationAccess.run(
        () => runDrainParticipant(
          DRAIN_PARTICIPANTS.confirmationOperation,
          () => operation(workController.signal),
        ),
      )),
    confirmationReady: () => confirmationAccess.isReady(),
    drainStatus: readBackgroundDrainStatus,
  };
}

function listenForLocalConnections(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function createDeferredBackgroundWork(
  application,
  startBackgroundWorkFn,
  reportError,
  drainTimeoutMs,
) {
  let delegate = null;
  let startPromise = null;
  let stopPromise = null;
  let stopped = false;

  function requireDelegate() {
    if (!delegate) {
      throw new Error("managed background work has not been claimed");
    }
    return delegate;
  }

  async function start() {
    if (stopped) throw new Error("managed background work is already stopped");
    startPromise ||= Promise.resolve().then(() => {
      const started = startBackgroundWorkFn(application, {
        reportError,
        drainTimeoutMs,
      });
      if (!started || typeof started !== "object") {
        throw new TypeError("startBackgroundWorkFn must return background work");
      }
      delegate = started;
      Promise.resolve(delegate.initialRefresh).catch((error) => {
        try {
          reportError(error);
        } catch {
          // A managed server remains controllable when refresh diagnostics fail.
        }
      });
      return delegate;
    });
    await startPromise;
  }

  function stop() {
    stopped = true;
    stopPromise ||= Promise.resolve(startPromise)
      .catch(() => null)
      .then(() => delegate?.stop?.());
    return stopPromise;
  }

  return Object.freeze({
    get initialRefresh() {
      return delegate?.initialRefresh || Promise.resolve({ skipped: "pending_claim" });
    },
    start,
    stop,
    refresh: (...arguments_) => requireDelegate().refresh(...arguments_),
    mutateFacts: (...arguments_) => requireDelegate().mutateFacts(...arguments_),
    signalAgency: (...arguments_) => requireDelegate().signalAgency(...arguments_),
    runEmployee: (...arguments_) => requireDelegate().runEmployee(...arguments_),
    runConfirmationRead: (...arguments_) =>
      requireDelegate().runConfirmationRead(...arguments_),
    runConfirmationOperation: (...arguments_) =>
      requireDelegate().runConfirmationOperation(...arguments_),
    confirmationReady: () => delegate?.confirmationReady?.() === true,
    drainStatus: () => delegate?.drainStatus?.() ?? null,
  });
}

export async function startDashboardServer(
  {
    createApplicationFn = createApplication,
    startBackgroundWorkFn = startApplicationBackgroundWork,
    log = console.log,
    reportError = console.error,
    managedProcess = null,
    writerLease = null,
    shutdownDrainTimeoutMs = defaultShutdownDrainTimeoutMs,
    runtimeSourceIdentity: runtimeSourceIdentityInput = null,
    verifyRuntimeSourceFn = null,
    terminateManagedProcess = null,
  } = {},
) {
  shutdownDrainTimeoutMs = shutdownTimeoutMilliseconds(shutdownDrainTimeoutMs);
  if (verifyRuntimeSourceFn !== null && typeof verifyRuntimeSourceFn !== "function") {
    throw new TypeError("verifyRuntimeSourceFn must be a function");
  }
  let application = null;
  let backgroundWork = null;
  let server = null;
  const runtimeLifecycle = createApplicationRuntimeLifecycle();
  try {
    if (writerLease !== null) await writerLease.acquire();
    application = await createApplicationFn({
      runtimeLifecycle,
      privateRuntimeDirectory: managedProcess?.runtimeDirectory ?? null,
    });
    if (managedProcess) {
      backgroundWork = createDeferredBackgroundWork(
        application,
        startBackgroundWorkFn,
        reportError,
        shutdownDrainTimeoutMs,
      );
    } else {
      backgroundWork = startBackgroundWorkFn(application, {
        reportError,
        drainTimeoutMs: shutdownDrainTimeoutMs,
      });
    }
    server = createDashboardServer(application, {
      backgroundWork,
      reportError,
      managedProcess,
      writerLease,
      onManagedClaim: managedProcess ? () => backgroundWork.start() : null,
      allowUnmanagedShutdown: false,
      runtimeSourceIdentity: runtimeSourceIdentityInput,
      shutdownDrainTimeoutMs,
      terminateManagedProcess,
    });
    if (verifyRuntimeSourceFn !== null) await verifyRuntimeSourceFn();
    await listenForLocalConnections(server, application.config.port);
    if (managedProcess) {
      server.armManagedClaimWatchdog();
    } else {
      await backgroundWork.initialRefresh;
    }
  } catch (error) {
    let shutdownError;
    if (server) {
      shutdownError = lifecycleFailure(await Promise.allSettled([
        server.shutdown(),
      ]));
    } else {
      const deadline = Date.now() + shutdownDrainTimeoutMs;
      const controller = new AbortController();
      try {
        const serviceCleanup = await settleBeforeDeadline([
          backgroundWork?.stop
            ? runLifecycleStep(() => backgroundWork.stop({ signal: controller.signal }))
            : Promise.resolve(),
        ], deadline, "startup background services", controller);
        shutdownError = lifecycleFailure(serviceCleanup);
        if (!shutdownError) {
          const applicationCleanup = await settleBeforeDeadline([
            application?.close
              ? runLifecycleStep(() => application.close({ signal: controller.signal }))
              : runLifecycleStep(() => runtimeLifecycle.close()),
          ], deadline, "startup application runtime", controller);
          shutdownError = lifecycleFailure(applicationCleanup);
        }
        if (!shutdownError) {
          const leaseCleanup = await settleBeforeDeadline([
            writerLease?.close
              ? runLifecycleStep(() => writerLease.close())
              : Promise.resolve(),
          ], deadline, "startup writer lease", controller);
          shutdownError = lifecycleFailure(leaseCleanup);
        }
      } catch (cleanupError) {
        shutdownError = cleanupError;
      }
    }
    if (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "服务器启动失败且资源释放不完整",
      );
    }
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address
    ? address.port
    : application.config.port;
  log(`Development Intelligence Hub: http://127.0.0.1:${port}`);
  return server;
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
async function runDashboardProcess(
  managedProcess,
  runtimeSourceIdentityInput,
  verifyRuntimeSourceFn,
) {
  const diagnostics = managedProcess
    ? createManagedFileDiagnostics(managedProcess.logDirectory)
    : { log: console.log, reportError: console.error };
  try {
    const verifiedRuntimeSourceIdentity = runtimeSourceIdentity(
      runtimeSourceIdentityInput,
    );
    if (verifiedRuntimeSourceIdentity === null) {
      throw new Error("dashboard process requires a verified startup identity");
    }
    if (typeof verifyRuntimeSourceFn !== "function") {
      throw new Error("dashboard process requires a final runtime source verifier");
    }
    const writerLease = createApplicationWriterLease({
      projectRoot,
      projectDigest: managedProcess?.projectDigest ?? null,
    });
    await startDashboardServer({
      managedProcess,
      writerLease,
      log: diagnostics.log,
      reportError: diagnostics.reportError,
      runtimeSourceIdentity: verifiedRuntimeSourceIdentity,
      verifyRuntimeSourceFn,
      terminateManagedProcess: managedProcess
        ? (code) => setImmediate(() => process.exit(code))
        : null,
    });
  } catch (error) {
    diagnostics.reportError(error);
    process.exitCode = 1;
  }
}

export async function startManagedDashboardFromCapturedEnvironment(
  environment,
  runtimeSourceIdentityInput,
  verifyRuntimeSourceFn,
) {
  const managedProcess = readManagedProcessEnvironment(environment);
  if (!managedProcess) {
    throw new Error("managed dashboard entry requires a complete environment");
  }
  await runDashboardProcess(
    managedProcess,
    runtimeSourceIdentityInput,
    verifyRuntimeSourceFn,
  );
}

export async function startDashboardFromVerifiedRuntime(
  runtimeSourceIdentityInput,
  verifyRuntimeSourceFn,
) {
  await runDashboardProcess(
    null,
    runtimeSourceIdentityInput,
    verifyRuntimeSourceFn,
  );
}

if (import.meta.url === invokedModule) {
  console.error(
    "Development Intelligence Hub must be started through scripts/run-dashboard.mjs or the managed launcher.",
  );
  process.exitCode = 1;
}
