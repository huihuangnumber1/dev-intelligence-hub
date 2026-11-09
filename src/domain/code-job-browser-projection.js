import { CODE_JOB_STATUSES } from "./code-job-vocabulary.js";
import { projectTestSummary } from "./test-result-summary.js";
import { isCodeJobVerificationOutcome } from "./code-job-verification-outcome.js";
import {
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import { normalizeWorkspacePath } from "./code-execution-policy.js";
import { codeJobTerminalLifecycleAt } from "./code-job-terminal-time.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/;
const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CLONE_ENTRIES = 5_000;
const MAX_CLONE_DEPTH = 16;
const MAX_CLONE_STRING_BYTES = 32 * 1024;
const CODE_ACTION_TYPES = new Set([
  "list_files",
  "read_text",
  "search_text",
  "write_text",
  "run_profile",
  "complete",
]);
const CODE_OBSERVATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);

const CODE_JOB_STATUS_SET = new Set(CODE_JOB_STATUSES);
const ACTIVE_CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
  "cancelling",
]);
const TERMINAL_CODE_JOB_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);

const PROJECTION_KEYS_WITHOUT_UNCERTAINTY = Object.freeze([
  "jobId",
  "status",
  "revision",
  "proposalId",
  "proposalContentDigest",
  "grantDigest",
  "requestedBy",
  "subject",
  "repository",
  "workspaceId",
  "operation",
  "objective",
  "acceptanceCriteria",
  "evidence",
  "summary",
  "reason",
  "allowedActions",
  "writablePaths",
  "requiredProfiles",
  "turn",
  "pendingActionType",
  "observationCount",
  "latestObservation",
  "terminalResult",
  "memoryProjection",
  "pause",
  "createdAt",
  "updatedAt",
]);
const PROJECTION_KEYS = Object.freeze([
  ...PROJECTION_KEYS_WITHOUT_UNCERTAINTY,
  "uncertainty",
]);
const BOUND_PROJECTION_KEYS_WITHOUT_UNCERTAINTY = Object.freeze([
  ...PROJECTION_KEYS_WITHOUT_UNCERTAINTY,
  "inputBinding",
]);
const BOUND_PROJECTION_KEYS = Object.freeze([
  ...PROJECTION_KEYS,
  "inputBinding",
]);
const CONFLICT_PROJECTION_KEYS_WITHOUT_UNCERTAINTY = Object.freeze([
  ...BOUND_PROJECTION_KEYS_WITHOUT_UNCERTAINTY,
  "executionSource",
]);
const CONFLICT_PROJECTION_KEYS = Object.freeze([
  ...BOUND_PROJECTION_KEYS,
  "executionSource",
]);
const PROGRESS_KEYS = new Set([
  "turn",
  "pendingActionType",
  "observationCount",
  "latestObservation",
  "terminalResult",
  "memoryProjection",
  "pause",
  "uncertainty",
]);
const LEGACY_PROJECTION_KEYS = Object.freeze(
  PROJECTION_KEYS_WITHOUT_UNCERTAINTY.filter(
    (key) => !PROGRESS_KEYS.has(key),
  ),
);

function invalidProjection() {
  return new TypeError("Code job browser projection is invalid");
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function assertExactKeys(value, expected, error) {
  const keys = dataEntries(value, error).map(([key]) => key);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function arrayValues(value, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function cloneProjectionValue(
  value,
  error,
  context = { depth: 0, entries: { count: 0 }, ancestors: new Set() },
) {
  context.entries.count += 1;
  if (
    context.entries.count > MAX_CLONE_ENTRIES ||
    context.depth > MAX_CLONE_DEPTH
  ) {
    throw error;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (
      INVALID_TEXT_CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_CLONE_STRING_BYTES
    ) {
      throw error;
    }
    return value;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    context.ancestors.has(value)
  ) {
    throw error;
  }
  context.ancestors.add(value);
  const child = {
    depth: context.depth + 1,
    entries: context.entries,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      return arrayValues(value, error).map((entry) =>
        cloneProjectionValue(entry, error, child),
      );
    }
    const result = {};
    for (const [key, entry] of dataEntries(value, error)) {
      if (Buffer.byteLength(key, "utf8") > 128) throw error;
      result[key] = cloneProjectionValue(entry, error, child);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

function safeWorkspacePath(value) {
  try {
    return normalizeWorkspacePath(value);
  } catch {
    return null;
  }
}

function projectedError(value) {
  return value &&
      typeof value === "object" &&
      typeof value.code === "string" &&
      FAILURE_CODE.test(value.code)
    ? {
        code: value.code,
        ...(typeof value.message === "string"
          ? { message: value.message }
          : {}),
      }
    : null;
}

function projectedExecutor(value) {
  if (!value || typeof value !== "object") return null;
  return {
    sessionStatus: typeof value.sessionStatus === "string"
      ? value.sessionStatus
      : null,
    sessionAttemptNumber: Number.isSafeInteger(value.sessionAttemptNumber)
      ? value.sessionAttemptNumber
      : null,
    actionStatus: typeof value.actionStatus === "string"
      ? value.actionStatus
      : null,
    actionAttemptNumber: Number.isSafeInteger(value.actionAttemptNumber)
      ? value.actionAttemptNumber
      : null,
  };
}

function projectedPathEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = typeof entry === "string" ? { path: entry } : entry;
    const path = safeWorkspacePath(source?.path);
    if (path === null) return [];
    const projected = { path };
    for (const key of ["sha256", "beforeSha256", "afterSha256"]) {
      if (typeof source[key] === "string" && SHA256.test(source[key])) {
        projected[key] = source[key];
      }
    }
    if (Number.isSafeInteger(source.bytes) && source.bytes >= 0) {
      projected.bytes = source.bytes;
    }
    if (
      source.blob &&
      typeof source.blob === "object" &&
      typeof source.blob.sha256 === "string" &&
      SHA256.test(source.blob.sha256) &&
      Number.isSafeInteger(source.blob.bytes) &&
      source.blob.bytes >= 0
    ) {
      projected.blob = {
        sha256: source.blob.sha256,
        bytes: source.blob.bytes,
      };
    }
    return [projected];
  });
}

function projectedObservationResult(observation) {
  const source = observation.detail?.result ?? observation.detail ?? {};
  const error = projectedError(source.error);
  if (observation.actionType === "list_files") {
    return {
      files: projectedPathEntries(source.files).map(({ path }) => path),
      truncated: source.truncated === true,
      error,
    };
  }
  if (["read_text", "write_text"].includes(observation.actionType)) {
    return {
      path: safeWorkspacePath(observation.action.path),
      sha256: typeof source.sha256 === "string" && SHA256.test(source.sha256)
        ? source.sha256
        : null,
      bytes: Number.isSafeInteger(source.bytes) && source.bytes >= 0
        ? source.bytes
        : 0,
      ...(observation.actionType === "read_text"
        ? { truncated: source.truncated === true }
        : {}),
      error,
    };
  }
  if (observation.actionType === "search_text") {
    return {
      matches: Array.isArray(source.matches)
        ? source.matches.flatMap((entry) => {
            const path = safeWorkspacePath(entry?.path);
            return path === null
              ? []
              : [{
                  path,
                  line: Number.isSafeInteger(entry.line) ? entry.line : 0,
                  column: Number.isSafeInteger(entry.column) ? entry.column : 0,
                }];
          })
        : [],
      truncated: source.truncated === true,
      error,
    };
  }
  if (observation.actionType === "run_profile") {
    return {
      exitCode: Number.isSafeInteger(source.exitCode) ? source.exitCode : null,
      signal: typeof source.signal === "string" ? source.signal : null,
      durationMs: Number.isFinite(source.durationMs) ? source.durationMs : 0,
      timedOut: source.timedOut === true,
      ...projectTestSummary(source.testSummary),
      error,
    };
  }
  return {
    created: projectedPathEntries(source.created),
    modified: projectedPathEntries(source.modified),
    deleted: projectedPathEntries(source.deleted),
    truncated: source.truncated === true,
    error,
  };
}

function projectedTerminalDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return {};
  }
  const result = {};
  for (const key of [
    "schemaVersion",
    "outcome",
    "summary",
    "code",
    "message",
    "reason",
    "completedActionId",
  ]) {
    if (["string", "number"].includes(typeof detail[key])) {
      result[key] = detail[key];
    }
  }
  if (
    typeof detail.workspaceRevision === "string" &&
    SHA256.test(detail.workspaceRevision)
  ) {
    result.workspaceRevision = detail.workspaceRevision;
  }
  for (const key of ["evidence", "checks"]) {
    if (Array.isArray(detail[key])) {
      result[key] = detail[key].filter((entry) => typeof entry === "string");
    }
  }
  if (detail.completionReport && typeof detail.completionReport === "object") {
    const report = detail.completionReport;
    result.completionReport = Object.fromEntries(
      ["actionId", "actionDigest", "workspaceRevision", "outcome"]
        .filter(key => typeof report[key] === "string").map(key => [key, report[key]]),
    );
    result.completionReport.evidence = Array.isArray(report.evidence)
      ? report.evidence.filter(entry => typeof entry === "string") : [];
  }
  if (detail.manifest && typeof detail.manifest === "object") {
    result.manifest = {
      created: projectedPathEntries(detail.manifest.created),
      modified: projectedPathEntries(detail.manifest.modified),
      deleted: projectedPathEntries(detail.manifest.deleted),
      ...(detail.manifest.truncated === true ? { truncated: true } : {}),
    };
  }
  return result;
}

export function projectCodeJobObservationForBrowser(observation) {
  return structuredClone({
    turn: observation.turn,
    actionId: observation.actionId,
    actionType: observation.actionType,
    actionDigest: observation.actionDigest,
    status: observation.status,
    workspaceRevision: observation.workspaceRevision,
    detailDigest: observation.detailDigest,
    detail: {
      schemaVersion: observation.detail?.schemaVersion ?? 1,
      ...(observation.actionType === "write_text" && observation.status === "failed" &&
          observation.detail?.origin === "host_pre_execution_rejection" && observation.detail.notExecuted === true
        ? { origin: "host_pre_execution_rejection", notExecuted: true } : {}),
      executor: projectedExecutor(observation.detail?.executor),
      result: projectedObservationResult(observation),
    },
    recordedAt: observation.recordedAt,
  });
}

export function projectCodeJobTerminalDetailForBrowser(job) {
  return !TERMINAL_CODE_JOB_STATUSES.has(job.status) ||
    job.execution.result === null
    ? null
    : structuredClone(projectedTerminalDetail(job.execution.result.detail));
}

function boundedText(
  value,
  error,
  { minimumBytes = 1, maximumBytes = 256 } = {},
) {
  const bytes = typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : -1;
  if (
    typeof value !== "string" ||
    INVALID_TEXT_CONTROL.test(value) ||
    bytes < minimumBytes ||
    bytes > maximumBytes
  ) {
    throw error;
  }
  return value;
}

function safeInteger(value, minimum, maximum, error) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw error;
  }
  return value;
}

function normalizeTimestamp(value, error) {
  let timestamp;
  try {
    timestamp = value instanceof Date ? value.toISOString() : value;
  } catch {
    throw error;
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw error;
  }
  return timestamp;
}

function hasExactKeys(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

function normalizeOptionalRecord(value, keys, error) {
  if (value === null) return null;
  assertExactKeys(value, keys, error);
  return cloneProjectionValue(value, error);
}

function projectionShape(suppliedKeys) {
  if (hasExactKeys(suppliedKeys, LEGACY_PROJECTION_KEYS)) return "legacy";
  if (
    hasExactKeys(
      suppliedKeys,
      CONFLICT_PROJECTION_KEYS_WITHOUT_UNCERTAINTY,
    )
  ) {
    return "conflictWithoutUncertainty";
  }
  if (hasExactKeys(suppliedKeys, CONFLICT_PROJECTION_KEYS)) {
    return "conflictCurrent";
  }
  if (hasExactKeys(suppliedKeys, BOUND_PROJECTION_KEYS_WITHOUT_UNCERTAINTY)) {
    return "boundWithoutUncertainty";
  }
  if (hasExactKeys(suppliedKeys, BOUND_PROJECTION_KEYS)) {
    return "boundCurrent";
  }
  if (hasExactKeys(suppliedKeys, PROJECTION_KEYS_WITHOUT_UNCERTAINTY)) {
    return "withoutUncertainty";
  }
  return "current";
}

function expectedProjectionKeys(shape) {
  if (shape === "legacy") return LEGACY_PROJECTION_KEYS;
  if (shape === "withoutUncertainty") {
    return PROJECTION_KEYS_WITHOUT_UNCERTAINTY;
  }
  if (shape === "boundWithoutUncertainty") {
    return BOUND_PROJECTION_KEYS_WITHOUT_UNCERTAINTY;
  }
  if (shape === "boundCurrent") return BOUND_PROJECTION_KEYS;
  if (shape === "conflictWithoutUncertainty") {
    return CONFLICT_PROJECTION_KEYS_WITHOUT_UNCERTAINTY;
  }
  if (shape === "conflictCurrent") return CONFLICT_PROJECTION_KEYS;
  return PROJECTION_KEYS;
}

function withLegacyProgress(value, shape, error) {
  if (shape === "legacy") {
    return {
      ...cloneProjectionValue(value, error),
      turn: 0,
      pendingActionType: null,
      observationCount: 0,
      latestObservation: null,
      terminalResult: null,
      memoryProjection: null,
      pause: null,
      uncertainty: null,
    };
  }
  if (["withoutUncertainty", "boundWithoutUncertainty"].includes(shape)) {
    return {
      ...cloneProjectionValue(value, error),
      uncertainty: value.status === "unknown"
        ? {
            from: "pausing",
            code: "LEGACY_ACTION_RESULT_UNKNOWN",
            message:
              value.pause?.reason ??
              "Legacy unknown action requires reconciliation",
            at: value.pause?.at ?? value.updatedAt,
          }
        : null,
    };
  }
  return cloneProjectionValue(value, error);
}

function normalizeProgress(projection, error) {
  const createdAt = normalizeTimestamp(projection.createdAt, error);
  const updatedAt = normalizeTimestamp(projection.updatedAt, error);
  const turn = safeInteger(projection.turn, 0, 128, error);
  const observationCount = safeInteger(
    projection.observationCount,
    0,
    128,
    error,
  );
  const pendingActionType = projection.pendingActionType;
  if (
    pendingActionType !== null &&
    !CODE_ACTION_TYPES.has(pendingActionType)
  ) {
    throw error;
  }

  const latestObservation = normalizeOptionalRecord(
    projection.latestObservation,
    ["actionType", "status", "recordedAt"],
    error,
  );
  if (
    latestObservation !== null &&
    (!CODE_ACTION_TYPES.has(latestObservation.actionType) ||
      !CODE_OBSERVATION_STATUSES.has(latestObservation.status))
  ) {
    throw error;
  }
  const latestRecordedAt = latestObservation === null
    ? null
    : normalizeTimestamp(latestObservation.recordedAt, error);

  const terminalResult = normalizeOptionalRecord(
    projection.terminalResult,
    ["kind", "recordedAt"],
    error,
  );
  const terminalRecordedAt = terminalResult === null
    ? null
    : normalizeTimestamp(terminalResult.recordedAt, error);

  const memoryProjection = normalizeOptionalRecord(
    projection.memoryProjection,
    ["recordId", "projectedAt"],
    error,
  );
  const memoryProjectedAt = memoryProjection === null
    ? null
    : normalizeTimestamp(memoryProjection.projectedAt, error);
  if (
    memoryProjection !== null &&
    (typeof memoryProjection.recordId !== "string" ||
      !MEMORY_RECORD_ID.test(memoryProjection.recordId))
  ) {
    throw error;
  }

  const pause = normalizeOptionalRecord(
    projection.pause,
    ["reason", "at"],
    error,
  );
  const pausedAt = pause === null
    ? null
    : normalizeTimestamp(pause.at, error);
  if (
    pause !== null &&
    (typeof pause.reason !== "string" ||
      Buffer.byteLength(pause.reason, "utf8") > 2_048)
  ) {
    throw error;
  }

  const uncertainty = normalizeOptionalRecord(
    projection.uncertainty,
    ["from", "code", "message", "at"],
    error,
  );
  const uncertaintyAt = uncertainty === null
    ? null
    : normalizeTimestamp(uncertainty.at, error);
  if (
    uncertainty !== null &&
    (!["active", "pausing"].includes(uncertainty.from) ||
      typeof uncertainty.code !== "string" ||
      !FAILURE_CODE.test(uncertainty.code))
  ) {
    throw error;
  }
  if (uncertainty !== null) {
    boundedText(uncertainty.message, error, {
      maximumBytes: 2_048,
    });
  }

  return {
    createdAt,
    updatedAt,
    turn,
    observationCount,
    pendingActionType,
    latestObservation,
    latestRecordedAt,
    terminalResult,
    terminalRecordedAt,
    memoryProjection,
    memoryProjectedAt,
    pause,
    pausedAt,
    uncertainty,
    uncertaintyAt,
  };
}

function assertProjectionLifecycle(projection, progress, error) {
  const {
    createdAt,
    updatedAt,
    turn,
    observationCount,
    pendingActionType,
    latestObservation,
    latestRecordedAt,
    terminalResult,
    terminalRecordedAt,
    memoryProjection,
    memoryProjectedAt,
    pause,
    pausedAt,
    uncertainty,
    uncertaintyAt,
  } = progress;
  if (
    !CODE_JOB_STATUS_SET.has(projection.status) ||
    (Object.hasOwn(projection, "verificationOutcome") &&
      (projection.status !== "failed" || projection.operation !== "verify" ||
        !isCodeJobVerificationOutcome(projection.verificationOutcome))) ||
    !Number.isSafeInteger(projection.revision) ||
    projection.revision < 1 ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    observationCount !== turn ||
    (latestObservation === null) !== (observationCount === 0) ||
    (latestRecordedAt !== null &&
      (Date.parse(latestRecordedAt) < Date.parse(createdAt) ||
        Date.parse(latestRecordedAt) > Date.parse(updatedAt))) ||
    (projection.status === "queued" &&
      (turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (projection.status === "starting" &&
      (turn !== 0 ||
        pendingActionType !== null ||
        terminalResult !== null ||
        pause !== null ||
        memoryProjection !== null)) ||
    (["active", "pausing", "unknown", "paused", "cancelling"].includes(
      projection.status,
    ) && (terminalResult !== null || memoryProjection !== null)) ||
    (!["pausing", "unknown", "paused", "cancelling"].includes(
      projection.status,
    ) &&
      pause !== null) ||
    (["pausing", "paused"].includes(projection.status) && pause === null) ||
    (projection.status === "unknown" && uncertainty === null) ||
    (uncertainty !== null &&
      !["unknown", "cancelling"].includes(projection.status)) ||
    (uncertainty?.from === "active" && pause !== null) ||
    (uncertainty?.from === "pausing" && pause === null) ||
    (projection.status === "unknown" && pendingActionType === null) ||
    (pausedAt !== null &&
      (Date.parse(pausedAt) < Date.parse(createdAt) ||
        Date.parse(pausedAt) > Date.parse(updatedAt))) ||
    (uncertaintyAt !== null &&
      (Date.parse(uncertaintyAt) < Date.parse(createdAt) ||
        Date.parse(uncertaintyAt) > Date.parse(updatedAt))) ||
    (TERMINAL_CODE_JOB_STATUSES.has(projection.status) &&
      (terminalResult?.kind !== projection.status ||
        pendingActionType !== null ||
        pause !== null)) ||
    (ACTIVE_CODE_JOB_STATUSES.has(projection.status) &&
      terminalResult !== null) ||
    (terminalRecordedAt !== null &&
      (Date.parse(terminalRecordedAt) < Date.parse(createdAt) ||
        Date.parse(terminalRecordedAt) > Date.parse(updatedAt))) ||
    (memoryProjectedAt !== null &&
      (Date.parse(memoryProjectedAt) < Date.parse(createdAt) ||
        Date.parse(memoryProjectedAt) > Date.parse(updatedAt)))
  ) {
    throw error;
  }
}

export function normalizeCodeJobBrowserProjection(
  value,
  error = invalidProjection(),
) {
  const suppliedKeys = dataEntries(value, error).map(([key]) => key);
  const hasVerificationOutcome = suppliedKeys.includes("verificationOutcome");
  const shape = projectionShape(suppliedKeys.filter((key) => key !== "verificationOutcome"));
  assertExactKeys(value, [
    ...expectedProjectionKeys(shape),
    ...(hasVerificationOutcome ? ["verificationOutcome"] : []),
  ], error);
  const projection = withLegacyProgress(value, shape, error);
  if (shape.startsWith("bound") && projection.inputBinding !== null) {
    let inputBinding;
    try {
      inputBinding = normalizePullRequestExecutionBinding(
        projection.inputBinding,
        error,
      );
    } catch {
      throw error;
    }
    if (
      inputBinding.repository !== projection.repository ||
      inputBinding.pullRequestNumber !== projection.subject?.number
    ) {
      throw error;
    }
  }
  if (shape.startsWith("conflict")) {
    let executionSource;
    let inputBinding;
    try {
      executionSource = normalizeCodeExecutionSource(
        projection.executionSource,
        error,
      );
      inputBinding = normalizePullRequestExecutionBinding(
        projection.inputBinding,
        error,
      );
    } catch {
      throw error;
    }
    if (
      !sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding,
      }) ||
      inputBinding.repository !== projection.repository ||
      inputBinding.pullRequestNumber !== projection.subject?.number
    ) {
      throw error;
    }
  }
  const progress = normalizeProgress(projection, error);
  assertProjectionLifecycle(projection, progress, error);
  return projection;
}

export function isActiveCodeJobBrowserStatus(value) {
  return ACTIVE_CODE_JOB_STATUSES.has(value);
}

function projectBrowserFields(source, progress) {
  const grant = source.grant;
  return {
    jobId: source.jobId,
    status: source.status,
    revision: source.revision,
    proposalId: source.proposal.proposalId,
    proposalContentDigest: source.proposal.contentDigest,
    grantDigest: grant.grantDigest,
    requestedBy: grant.requestedBy,
    subject: grant.subject,
    repository: grant.repository,
    workspaceId: grant.workspaceId,
    ...(Object.hasOwn(grant, "inputBinding")
      ? { inputBinding: grant.inputBinding }
      : {}),
    ...(Object.hasOwn(grant, "executionSource")
      ? { executionSource: grant.executionSource }
      : {}),
    operation: grant.operation,
    objective: grant.objective,
    acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence,
    summary: grant.summary,
    reason: grant.reason,
    allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths,
    requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
    ...progress,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function validateProjectedCodeJob(projection) {
  normalizeCodeJobBrowserProjection(projection);
  return structuredClone(projection);
}

export function projectNormalizedCodeJobForBrowser(job) {
  const execution = job.execution;
  const verificationOutcome = job.status === "failed" && job.grant.operation === "verify"
    ? execution.result?.detail?.code
    : null;
  return validateProjectedCodeJob(
    projectBrowserFields(job, {
      ...(isCodeJobVerificationOutcome(verificationOutcome) ? { verificationOutcome } : {}),
      turn: execution.turn,
      pendingActionType: execution.pendingAction?.action.type ?? null,
      observationCount: execution.observations.length,
      latestObservation: execution.observations.length === 0
        ? null
        : {
            actionType: execution.observations.at(-1).actionType,
            status: execution.observations.at(-1).status,
            recordedAt: execution.observations.at(-1).recordedAt,
          },
      terminalResult: !TERMINAL_CODE_JOB_STATUSES.has(job.status) ||
        execution.result === null
        ? null
        : {
            kind: execution.result.kind,
            recordedAt: codeJobTerminalLifecycleAt(job),
          },
      memoryProjection: execution.memoryProjection === null
        ? null
        : {
            recordId: execution.memoryProjection.memoryRecordId,
            projectedAt: execution.memoryProjection.projectedAt,
          },
      pause: execution.pause === null
        ? null
        : {
            reason: execution.pause.reason,
            at: execution.pause.at,
          },
      uncertainty: execution.uncertainty === null
        ? null
        : {
            from: execution.uncertainty.from,
            code: execution.uncertainty.code,
            message: execution.uncertainty.message,
            at: execution.uncertainty.at,
          },
    }),
  );
}

export function projectArchivedCodeJobForBrowser(tombstone) {
  return validateProjectedCodeJob(
    projectBrowserFields(tombstone, {
      ...(tombstone.outcome.verificationOutcome != null
        ? { verificationOutcome: tombstone.outcome.verificationOutcome }
        : {}),
      turn: tombstone.outcome.turn,
      pendingActionType: null,
      observationCount: tombstone.outcome.observationCount,
      latestObservation: tombstone.outcome.latestObservation,
      terminalResult: {
        ...tombstone.outcome.terminalResult,
        recordedAt: tombstone.outcome.memoryProjection.sourceUpdatedAt,
      },
      memoryProjection: {
        recordId: tombstone.outcome.memoryProjection.memoryRecordId,
        projectedAt: tombstone.outcome.memoryProjection.projectedAt,
      },
      pause: null,
      uncertainty: null,
    }),
  );
}
