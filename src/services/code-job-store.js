import {
  CODE_JOB_STATUSES,
  CODE_JOB_MAXIMUM_ACTION_BYTES,
  cloneCodeJobValue,
  codeJobError,
  codeJobIdForGrant,
  createCodeJobDetail,
  createQueuedCodeJob,
  isRetentionEligibleCodeJob,
  isTerminalCodeJobStatus,
  normalizeApprovedCodeJobRequest,
  normalizeCodeJob,
  normalizeCodeJobCompletionReport,
  normalizeCodeJobTimestamp,
  normalizeCodeJobTimeoutContinuation,
  codeJobTimeoutContinuationDelayMs,
  projectCodeJobForBrowser,
  updateCodeJobLifecycle,
} from "../domain/code-job-contract.js";
import {
  projectCodeJobObservationForBrowser,
  projectCodeJobTerminalDetailForBrowser,
  projectArchivedCodeJobForBrowser,
} from "../domain/code-job-browser-projection.js";
import { codeJobTerminalLifecycleAt } from "../domain/code-job-terminal-time.js";
import { isCodeJobVerificationOutcome } from "../domain/code-job-verification-outcome.js";
import {
  digestValue,
  normalizeActionRequest,
} from "../domain/code-executor-contract.js";
import {
  classifyCodeJobMemoryEvent,
  createCodeJobMemoryEvent,
  memoryRecordForCodeJobEvent,
  normalizeCodeJobMemoryEvent,
} from "../domain/code-job-memory-event.js";
import {
  createCodeJobChangePackageEvent,
  normalizeCodeJobChangePackageEvent,
  reconstructCodeJobChangePackageEventForRecovery,
} from "../domain/code-job-change-package-event.js";
import { sameCodeExecutionSource, isHeadRepairExecutionSource } from "../domain/code-execution-source.js";
import {
  normalizeChangePackageManifest,
  hasChangePackageChanges,
} from "../domain/change-package-contract.js";
import { normalizeChangePackageControlledCommitReceipt } from "../domain/change-package-controlled-commit.js";
import { normalizeMemoryRecord } from "../domain/memory-record.js";

export const CODE_JOB_STATE_KEY = "code-job-state";
const CODE_JOB_TOMBSTONE_PREFIX = "code-job-tombstone";

const MAX_JOBS = 1_000;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVED_JOBS = 10_000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_MEMORY_EVENTS = 256_000;
const MAX_CHANGE_PACKAGE_DELIVERIES = MAX_JOBS + MAX_ARCHIVED_JOBS;
const ACTION_COMMIT_HEADROOM_BYTES = 320 * 1024;
const TERMINAL_HEADROOM_BYTES = 160 * 1024;
const MEMORY_RECEIPT_HEADROOM_BYTES = 16 * 1024;
const JOB_ID = /^code-job-[a-f0-9]{55}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHANGE_PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const CHANGE_PACKAGE_EVENT_ID =
  /^code-job-change-package-event-[a-f0-9]{64}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STATUS_SET = new Set(CODE_JOB_STATUSES);
const RUNNABLE_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "cancelling",
]);
const RECONCILABLE_STATUSES = new Set(["unknown"]);
const RESUMED_STATUSES = new Set(["queued", "starting", "active"]);
const CANCELLABLE_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
]);
const OBSERVATION_STATUSES = new Set(["succeeded", "failed", "interrupted"]);
const TERMINAL_MEMORY_EVENT_KINDS = new Set([
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);

function storeError(code, message, statusCode = 400, options) {
  return codeJobError(code, message, statusCode, options);
}

function invalidState(message = "代码任务持久化状态无效") {
  return storeError("CODE_JOB_STATE_INVALID", message, 500);
}

function corruptedState(cause) {
  return storeError("CODE_JOB_STATE_CORRUPTED", "代码任务持久化状态损坏", 500, {
    cause,
  });
}

function bindingConflict() {
  return storeError(
    "CODE_JOB_BINDING_CONFLICT",
    "代码任务已绑定不同的批准、提案或授权内容",
    409,
  );
}

function capacityExceeded() {
  return storeError("CODE_JOB_CAPACITY_EXCEEDED", "代码任务本地容量已满", 507);
}

function retentionBlocked() {
  return storeError(
    "CODE_JOB_RETENTION_BLOCKED",
    "代码任务归档被未完成的前缀任务、记忆投影或变更包投递阻塞",
    409,
  );
}

function revisionConflict() {
  return storeError(
    "CODE_JOB_REVISION_CONFLICT",
    "代码任务版本已变化，请基于最新状态重试",
    409,
  );
}

function transitionConflict(message = "代码任务当前状态不允许该迁移") {
  return storeError("CODE_JOB_TRANSITION_CONFLICT", message, 409);
}

function memoryBindingConflict() {
  return storeError(
    "CODE_JOB_MEMORY_BINDING_CONFLICT",
    "代码任务已绑定不同的记忆投影凭据",
    409,
  );
}

function memoryReceiptUnverified(cause) {
  return storeError(
    "CODE_JOB_MEMORY_RECEIPT_UNVERIFIED",
    "无法验证代码任务的持久记忆投影",
    409,
    cause === undefined ? undefined : { cause },
  );
}

function memoryOrderConflict() {
  return storeError(
    "CODE_JOB_MEMORY_ORDER_CONFLICT",
    "代码任务记忆投影确认顺序无效",
    409,
  );
}

function changePackageBindingConflict() {
  return storeError(
    "CODE_JOB_CHANGE_PACKAGE_BINDING_CONFLICT",
    "代码任务 change package 投递绑定不匹配",
    409,
  );
}

function changePackageOrderConflict() {
  return storeError(
    "CODE_JOB_CHANGE_PACKAGE_ORDER_CONFLICT",
    "代码任务 change package 投递确认顺序无效",
    409,
  );
}

function changePackageReceiptUnverified(cause) {
  return storeError(
    "CODE_JOB_CHANGE_PACKAGE_RECEIPT_UNVERIFIED",
    "无法验证代码任务的持久 change package",
    409,
    cause === undefined ? undefined : { cause },
  );
}

function corruptedArchive(cause) {
  return storeError(
    "CODE_JOB_ARCHIVE_CORRUPTED",
    "代码任务归档索引或墓碑损坏",
    500,
    { cause },
  );
}

function jobNotFound() {
  return storeError("CODE_JOB_NOT_FOUND", "代码任务不存在", 404);
}

function uncertainState(writeError, recoveryError) {
  return storeError(
    "CODE_JOB_STATE_UNCERTAIN",
    "代码任务持久化结果无法确认",
    500,
    { cause: new AggregateError([writeError, recoveryError]) },
  );
}

function validateDependency(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
}

function plainDataKeys(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
  }
  return keys;
}

function assertExactKeys(value, expected, error) {
  const keys = plainDataKeys(value, error);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function isContentVersion(value) {
  return value !== null && typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0 && Object.isFrozen(value);
}

function normalizeVersionedRead(result, expectedVersion) {
  const error = corruptedState();
  assertExactKeys(result, result?.changed === true
    ? ["changed", "version", "value"] : ["changed", "version"], error);
  if (!isContentVersion(result.version) ||
      (result.changed !== true && result.changed !== false) ||
      (result.changed === false && result.version !== expectedVersion)) throw error;
  return result;
}

class CodeJobStateValidationCache {
  // Only locally normalized, deeply frozen identities are certified. A caller's
  // frozen object or matching digest never admits unvalidated persisted input.
  #jobs = new WeakSet();
  #deliveries = new WeakSet();
  #deliveryBindings = new WeakMap();
  #frozen = new WeakSet();

  freeze(value) {
    if (value === null || typeof value !== "object" || this.#frozen.has(value)) return value;
    for (const child of Object.values(value)) this.freeze(child);
    Object.freeze(value);
    this.#frozen.add(value);
    return value;
  }

  normalizeJob(value) {
    if (this.#jobs.has(value)) return value;
    const normalized = this.freeze(normalizeCodeJob(value));
    this.#jobs.add(normalized);
    return normalized;
  }

  normalizeDelivery(value, error) {
    if (this.#deliveries.has(value)) return value;
    const normalized = this.freeze(normalizeDeliveredChangePackage(value, error));
    this.#deliveries.add(normalized);
    return normalized;
  }

  matchesDelivery(entry, job) {
    if (this.#deliveryBindings.get(entry)?.has(job)) return true;
    if (!deliveredChangePackageMatchesJob(entry, job)) return false;
    let jobs = this.#deliveryBindings.get(entry);
    if (!jobs) this.#deliveryBindings.set(entry, jobs = new WeakSet());
    jobs.add(job);
    return true;
  }

  isRetentionEligible(job) {
    return this.#jobs.has(job)
      ? isTerminalCodeJobStatus(job.status) && job.execution.memoryProjection !== null
      : isRetentionEligibleCodeJob(job);
  }
}

function denseArray(value, maximumLength, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
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

function normalizeLimits(value = {}) {
  const error = new TypeError("limits is invalid");
  const allowed = [
    "maximumJobs",
    "maximumStateBytes",
    "maximumArchivedJobs",
    "maximumArchiveBytes",
  ];
  const keys = plainDataKeys(value, error);
  if (keys.some((key) => !allowed.includes(key))) throw error;
  const positive = (candidate, fallback, maximum) => {
    const resolved = candidate ?? fallback;
    if (
      !Number.isSafeInteger(resolved) ||
      resolved < 1 ||
      resolved > maximum
    ) {
      throw error;
    }
    return resolved;
  };
  return Object.freeze({
    maximumJobs: positive(value.maximumJobs, MAX_JOBS, MAX_JOBS),
    maximumStateBytes: positive(
      value.maximumStateBytes,
      MAX_STATE_BYTES,
      MAX_STATE_BYTES,
    ),
    maximumArchivedJobs: positive(
      value.maximumArchivedJobs,
      MAX_ARCHIVED_JOBS,
      MAX_ARCHIVED_JOBS,
    ),
    maximumArchiveBytes: positive(
      value.maximumArchiveBytes,
      MAX_ARCHIVE_BYTES,
      MAX_ARCHIVE_BYTES,
    ),
  });
}

function sealArchive(value) {
  const content = {
    throughSequence: value.throughSequence,
    jobCount: value.jobCount,
    revision: value.revision,
    digest: value.digest,
    lastCreatedAt: value.lastCreatedAt,
    lastUpdatedAt: value.lastUpdatedAt,
    storageBytes: value.storageBytes,
    lastManifestDigest: value.lastManifestDigest,
  };
  return { ...content, checkpointDigest: digestValue(content) };
}

function emptyChangePackageDelivery() {
  return {
    revision: 0,
    nextSequence: 1,
    cursor: 0,
    checkpointDigest: null,
    pending: [],
    delivered: [],
  };
}

function defaultState() {
  return {
    schemaVersion: 8,
    revision: 0,
    nextJobSequence: 1,
    archive: sealArchive({
      throughSequence: 0,
      jobCount: 0,
      revision: 0,
      digest: null,
      lastCreatedAt: null,
      lastUpdatedAt: null,
      storageBytes: 0,
      lastManifestDigest: null,
    }),
    archiveIndex: [],
    lastCompaction: null,
    memoryProjection: {
      revision: 0,
      nextSequence: 1,
      cursor: 0,
      checkpointDigest: null,
      lastAcknowledgement: null,
      pending: [],
    },
    changePackageDelivery: emptyChangePackageDelivery(),
    jobs: [],
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyArchive() {
  return defaultState().archive;
}

function normalizeArchive(value, error) {
  const legacyKeys = [
    "throughSequence",
    "jobCount",
    "revision",
    "digest",
    "lastCreatedAt",
    "lastUpdatedAt",
    "checkpointDigest",
  ];
  const currentKeys = [
    ...legacyKeys.slice(0, -1),
    "storageBytes",
    "lastManifestDigest",
    "checkpointDigest",
  ];
  const keys = plainDataKeys(value, error);
  const legacy =
    keys.length === legacyKeys.length &&
    legacyKeys.every((key) => keys.includes(key));
  assertExactKeys(value, legacy ? legacyKeys : currentKeys, error);
  const throughSequence = safeInteger(
    value.throughSequence,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const jobCount = safeInteger(
    value.jobCount,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const digest = value.digest === null
    ? null
    : normalizeSha256(value.digest, error);
  const lastCreatedAt = value.lastCreatedAt === null
    ? null
    : normalizeCodeJobTimestamp(value.lastCreatedAt, error);
  const lastUpdatedAt = value.lastUpdatedAt === null
    ? null
    : normalizeCodeJobTimestamp(value.lastUpdatedAt, error);
  const storageBytes = legacy
    ? 0
    : safeInteger(
      value.storageBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      error,
    );
  const lastManifestDigest = legacy || value.lastManifestDigest === null
    ? null
    : normalizeSha256(value.lastManifestDigest, error);
  const checkpointDigest = normalizeSha256(value.checkpointDigest, error);
  const content = {
    throughSequence,
    jobCount,
    revision,
    digest,
    lastCreatedAt,
    lastUpdatedAt,
    storageBytes,
    lastManifestDigest,
  };
  const suppliedCheckpointContent = legacy
    ? Object.fromEntries(
      legacyKeys
        .filter((key) => key !== "checkpointDigest")
        .map((key) => [key, value[key]]),
    )
    : content;
  if (
    jobCount !== throughSequence ||
    (throughSequence === 0) !== (revision === 0) ||
    (throughSequence === 0) !== (digest === null) ||
    (throughSequence === 0) !== (lastCreatedAt === null) ||
    (throughSequence === 0) !== (lastUpdatedAt === null) ||
    (throughSequence === 0) !== (lastManifestDigest === null) ||
    (throughSequence === 0) !== (storageBytes === 0) ||
    (lastCreatedAt !== null &&
      Date.parse(lastUpdatedAt) < Date.parse(lastCreatedAt)) ||
    checkpointDigest !== digestValue(suppliedCheckpointContent) ||
    (legacy && throughSequence !== 0)
  ) {
    throw error;
  }
  return legacy ? sealArchive(content) : { ...content, checkpointDigest };
}

function normalizeJobs(value, limits, error, validationCache = null) {
  return denseArray(value, limits.maximumJobs + limits.maximumArchivedJobs, error).map((entry) => {
    try {
      return validationCache === null ? normalizeCodeJob(entry) : validationCache.normalizeJob(entry);
    } catch {
      throw error;
    }
  });
}

function validateUniqueJobs(jobs, error) {
  const unique = (selector) =>
    new Set(jobs.map(selector)).size === jobs.length;
  if (
    !unique((job) => job.sequence) ||
    !unique((job) => job.revision) ||
    !unique((job) => job.jobId) ||
    !unique((job) => job.proposal.proposalId) ||
    !unique((job) => job.approval.confirmationId) ||
    !unique((job) => job.approval.approvalBindingDigest)
  ) {
    throw error;
  }
}

function normalizeMemoryEventId(value, error) {
  if (
    typeof value !== "string" ||
    value.length > 192 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw error;
  }
  return value;
}

function normalizeMemoryAcknowledgement(value, error) {
  assertExactKeys(
    value,
    [
      "sequence",
      "eventId",
      "eventDigest",
      "jobId",
      "sourceRecordDigest",
      "memoryRecordId",
      "memoryRecordDigest",
    ],
    error,
  );
  const memoryRecordDigest = normalizeSha256(
    value.memoryRecordDigest,
    error,
  );
  const eventDigest = normalizeSha256(value.eventDigest, error);
  const eventId = normalizeMemoryEventId(value.eventId, error);
  if (eventId !== `code-job-memory-event-${eventDigest}`) throw error;
  return {
    sequence: safeInteger(
      value.sequence,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    eventId,
    eventDigest,
    jobId: normalizeJobId(value.jobId, error),
    sourceRecordDigest: normalizeSha256(value.sourceRecordDigest, error),
    memoryRecordId: normalizeMemoryRecordId(
      value.memoryRecordId,
      memoryRecordDigest,
      error,
    ),
    memoryRecordDigest,
  };
}

function normalizeLastMemoryAcknowledgement(value, error) {
  assertExactKeys(value, ["event", "receipt"], error);
  let event;
  try {
    event = normalizeCodeJobMemoryEvent(value.event);
  } catch {
    throw error;
  }
  const receipt = normalizeMemoryAcknowledgement(value.receipt, error);
  if (!sameValue(receipt, acknowledgementForMemoryEvent(event))) throw error;
  return { event, receipt };
}

function emptyMemoryProjection() {
  return defaultState().memoryProjection;
}

function normalizeMemoryProjection(value, stateRevision, error) {
  assertExactKeys(
    value,
    [
      "revision",
      "nextSequence",
      "cursor",
      "checkpointDigest",
      "lastAcknowledgement",
      "pending",
    ],
    error,
  );
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const nextSequence = safeInteger(
    value.nextSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const cursor = safeInteger(
    value.cursor,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const checkpointDigest = value.checkpointDigest === null
    ? null
    : normalizeSha256(value.checkpointDigest, error);
  const lastAcknowledgement = value.lastAcknowledgement === null
    ? null
    : normalizeLastMemoryAcknowledgement(value.lastAcknowledgement, error);
  const pending = denseArray(
    value.pending,
    MAX_PENDING_MEMORY_EVENTS,
    error,
  ).map((entry) => {
    try {
      return normalizeCodeJobMemoryEvent(entry);
    } catch {
      throw error;
    }
  });
  if (
    revision > stateRevision ||
    cursor > Number.MAX_SAFE_INTEGER - pending.length - 1 ||
    nextSequence !== cursor + pending.length + 1 ||
    (nextSequence === 1) !== (revision === 0) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    (cursor === 0) !== (lastAcknowledgement === null) ||
    (lastAcknowledgement !== null &&
      (lastAcknowledgement.event.sequence !== cursor ||
        lastAcknowledgement.event.eventDigest !== checkpointDigest))
  ) {
    throw error;
  }
  let previousDigest = checkpointDigest;
  for (let index = 0; index < pending.length; index += 1) {
    const event = pending[index];
    if (
      event.sequence !== cursor + index + 1 ||
      event.previousDigest !== previousDigest
    ) {
      throw error;
    }
    previousDigest = event.eventDigest;
  }
  return {
    revision,
    nextSequence,
    cursor,
    checkpointDigest,
    lastAcknowledgement,
    pending,
  };
}

function appendMemoryEvent(memoryProjection, job, kind, revision) {
  if (kind === null) return memoryProjection;
  assertMemoryEventCapacity(memoryProjection);
  const previousDigest = memoryProjection.pending.at(-1)?.eventDigest ??
    memoryProjection.checkpointDigest;
  const event = createCodeJobMemoryEvent({
    sequence: memoryProjection.nextSequence,
    previousDigest,
    job,
    kind,
  });
  return {
    ...memoryProjection,
    revision,
    nextSequence: memoryProjection.nextSequence + 1,
    pending: [...memoryProjection.pending, event],
  };
}

function assertMemoryEventCapacity(memoryProjection) {
  if (
    memoryProjection.nextSequence >= Number.MAX_SAFE_INTEGER ||
    memoryProjection.pending.length >= MAX_PENDING_MEMORY_EVENTS
  ) {
    throw capacityExceeded();
  }
}

function migrateMemoryProjection(jobs, revision) {
  let projection = emptyMemoryProjection();
  for (const job of [...jobs].sort(
    (left, right) => left.revision - right.revision || left.sequence - right.sequence,
  )) {
    const kind = classifyCodeJobMemoryEvent(null, job);
    projection = appendMemoryEvent(projection, job, kind, revision);
  }
  return projection;
}

function assertMemoryProjectionExtension(current, durable) {
  const forked = () => storeError(
    "CODE_JOB_MEMORY_FORKED",
    "代码任务记忆投影链发生回退或分叉",
    500,
  );
  if (
    durable.cursor < current.cursor ||
    durable.nextSequence < current.nextSequence ||
    (durable.cursor === current.cursor &&
      durable.checkpointDigest !== current.checkpointDigest)
  ) {
    throw forked();
  }
  const currentBySequence = new Map(
    current.pending.map((event) => [event.sequence, event]),
  );
  if (durable.cursor > current.cursor) {
    const acknowledged = currentBySequence.get(durable.cursor);
    if (
      acknowledged !== undefined &&
      acknowledged.eventDigest !== durable.checkpointDigest
    ) {
      throw forked();
    }
  }
  for (const event of durable.pending) {
    const existing = currentBySequence.get(event.sequence);
    if (
      existing !== undefined &&
      existing.eventDigest !== event.eventDigest
    ) {
      throw forked();
    }
  }
}

function normalizeChangePackageAcknowledgement(value, error, {
  delivered = false,
} = {}) {
  const hasControlledCommit = value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    Object.hasOwn(value, "controlledCommit");
  const hasNoChanges = value !== null &&
    (typeof value === "object" || typeof value === "function") && Object.hasOwn(value, "noChanges");
  const keys = [
    "sequence",
    "eventId",
    "eventDigest",
    "jobId",
    "sourceRecordDigest",
    "packageId",
    "packageDigest",
    ...(hasControlledCommit ? ["controlledCommit"] : []),
    ...(hasNoChanges ? ["noChanges"] : []),
    ...(delivered ? ["deliveredAt"] : []),
  ];
  assertExactKeys(value, keys, error);
  if (hasNoChanges && (value.noChanges !== true || hasControlledCommit)) throw error;
  const eventDigest = normalizeSha256(value.eventDigest, error);
  const packageDigest = normalizeSha256(value.packageDigest, error);
  if (
    typeof value.eventId !== "string" ||
    !CHANGE_PACKAGE_EVENT_ID.test(value.eventId) ||
    value.eventId !== `code-job-change-package-event-${eventDigest}` ||
    typeof value.packageId !== "string" ||
    !CHANGE_PACKAGE_ID.test(value.packageId) ||
    value.packageId !== `change-package-${packageDigest}`
  ) {
    throw error;
  }
  return {
    sequence: safeInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER, error),
    eventId: value.eventId,
    eventDigest,
    jobId: normalizeJobId(value.jobId, error),
    sourceRecordDigest: normalizeSha256(value.sourceRecordDigest, error),
    packageId: value.packageId,
    packageDigest,
    ...(hasNoChanges ? { noChanges: true } : {}),
    ...(hasControlledCommit
      ? {
          controlledCommit: (() => {
            try {
              return normalizeChangePackageControlledCommitReceipt(
                value.controlledCommit,
              );
            } catch {
              throw error;
            }
          })(),
        }
      : {}),
    ...(delivered
      ? { deliveredAt: normalizeCodeJobTimestamp(value.deliveredAt, error) }
      : {}),
  };
}

function normalizeDeliveredChangePackage(value, error) {
  assertExactKeys(value, ["previousDigest", "receipt"], error);
  const receipt = normalizeChangePackageAcknowledgement(
    value.receipt,
    error,
    { delivered: true },
  );
  const previousDigest = value.previousDigest === null
    ? null
    : normalizeSha256(value.previousDigest, error);
  if (
    (receipt.sequence === 1) !== (previousDigest === null)
  ) {
    throw error;
  }
  return { previousDigest, receipt };
}

function normalizeChangePackageDelivery(value, stateRevision, error, validationCache = null) {
  assertExactKeys(
    value,
    [
      "revision",
      "nextSequence",
      "cursor",
      "checkpointDigest",
      "pending",
      "delivered",
    ],
    error,
  );
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const nextSequence = safeInteger(
    value.nextSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const cursor = safeInteger(
    value.cursor,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const checkpointDigest = value.checkpointDigest === null
    ? null
    : normalizeSha256(value.checkpointDigest, error);
  const delivered = denseArray(
    value.delivered,
    MAX_CHANGE_PACKAGE_DELIVERIES,
    error,
  ).map((entry) => validationCache === null
    ? normalizeDeliveredChangePackage(entry, error) : validationCache.normalizeDelivery(entry, error));
  const pending = denseArray(
    value.pending,
    MAX_CHANGE_PACKAGE_DELIVERIES,
    error,
  ).map((entry) => {
    try {
      return normalizeCodeJobChangePackageEvent(entry);
    } catch {
      throw error;
    }
  });
  if (
    revision > stateRevision ||
    cursor !== delivered.length ||
    nextSequence !== cursor + pending.length + 1 ||
    (nextSequence === 1) !== (revision === 0) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    new Set(
      [
        ...delivered.map(({ receipt }) => receipt.jobId),
        ...pending.map(({ job }) => job.id),
      ],
    ).size !== delivered.length + pending.length
  ) {
    throw error;
  }
  let previousDigest = null;
  for (let index = 0; index < delivered.length; index += 1) {
    const entry = delivered[index];
    if (
      entry.receipt.sequence !== index + 1 ||
      entry.previousDigest !== previousDigest
    ) {
      throw error;
    }
    previousDigest = entry.receipt.eventDigest;
  }
  if (previousDigest !== checkpointDigest) throw error;
  for (let index = 0; index < pending.length; index += 1) {
    const event = pending[index];
    if (
      event.sequence !== cursor + index + 1 ||
      event.previousDigest !== previousDigest
    ) {
      throw error;
    }
    previousDigest = event.eventDigest;
  }
  return {
    revision,
    nextSequence,
    cursor,
    checkpointDigest,
    pending,
    delivered,
  };
}

function appendChangePackageDelivery(delivery, job, revision) {
  if (
    delivery.nextSequence >= Number.MAX_SAFE_INTEGER ||
    delivery.pending.length + delivery.delivered.length >=
      MAX_CHANGE_PACKAGE_DELIVERIES
  ) {
    throw capacityExceeded();
  }
  const previousDigest = delivery.pending.at(-1)?.eventDigest ??
    delivery.checkpointDigest;
  const event = createCodeJobChangePackageEvent({
    sequence: delivery.nextSequence,
    previousDigest,
    job,
  });
  return {
    ...delivery,
    revision,
    nextSequence: delivery.nextSequence + 1,
    pending: [...delivery.pending, event],
  };
}

function hasChangePackageDelivery(state, jobId) {
  return (
    state.changePackageDelivery.pending.some(
      (event) => event.job.id === jobId,
    ) ||
    state.changePackageDelivery.delivered.some(
      ({ receipt }) => receipt.jobId === jobId,
    )
  );
}

function changePackageEventMatchesJob(event, job) {
  const memory = job.execution.memoryProjection;
  const sourceMatches =
    (job.revision === event.job.revision &&
      job.recordDigest === event.job.recordDigest) ||
    (memory !== null &&
      memory.sourceRevision === event.job.revision &&
      memory.sourceRecordDigest === event.job.recordDigest);
  const completion = job.execution.observations.at(-1);
  const conflictSourceMatches = job.grant.schemaVersion === 3
    ? [2, 3].includes(event.schemaVersion) &&
      Object.hasOwn(event, "executionSource") &&
      sameCodeExecutionSource(
        event.executionSource,
        job.grant.executionSource,
      ) &&
      (event.schemaVersion !== 3 ||
        event.recordedAt === completion?.recordedAt)
    : event.schemaVersion === 1 &&
      !Object.hasOwn(event, "executionSource");
  return (
    job.status === "completed" &&
    sourceMatches &&
    conflictSourceMatches &&
    event.job.id === job.jobId &&
    event.proposal.id === job.proposal.proposalId &&
    event.proposal.contentDigest === job.proposal.contentDigest &&
    event.grant.digest === job.grant.grantDigest &&
    event.exportRequest.sessionId === job.execution.sessionId &&
    event.exportRequest.completedActionId === completion?.actionId &&
    event.exportRequest.expectedWorkspaceRevision ===
      job.execution.workspaceRevision
  );
}

function deliveredChangePackageMatchesJob(entry, job) {
  try {
    const event = reconstructCodeJobChangePackageEventForRecovery({
      sequence: entry.receipt.sequence,
      previousDigest: entry.previousDigest,
      job,
    }, { expectedEventDigest: entry.receipt.eventDigest });
    return (
      changePackageEventMatchesJob(event, job) &&
      pendingChangePackageAcknowledgement(
        event,
        deliveredAcknowledgement(entry.receipt),
        { allowLegacy: true },
      )
    );
  } catch {
    return false;
  }
}

function assertChangePackageDeliveryExtension(current, durable) {
  const forked = () => storeError(
    "CODE_JOB_CHANGE_PACKAGE_FORKED",
    "代码任务 change package 投递链发生回退或分叉",
    500,
  );
  if (
    durable.cursor < current.cursor ||
    durable.nextSequence < current.nextSequence ||
    (durable.cursor === current.cursor &&
      durable.checkpointDigest !== current.checkpointDigest)
  ) {
    throw forked();
  }
  for (let index = 0; index < current.delivered.length; index += 1) {
    if (!sameValue(current.delivered[index], durable.delivered[index])) {
      throw forked();
    }
  }
  const currentBySequence = new Map(
    current.pending.map((event) => [event.sequence, event]),
  );
  for (const entry of durable.delivered.slice(current.delivered.length)) {
    const existing = currentBySequence.get(entry.receipt.sequence);
    if (
      existing !== undefined &&
      existing.eventDigest !== entry.receipt.eventDigest
    ) {
      throw forked();
    }
  }
  for (const event of durable.pending) {
    const existing = currentBySequence.get(event.sequence);
    if (existing !== undefined && existing.eventDigest !== event.eventDigest) {
      throw forked();
    }
  }
}

function normalizeLegacyState(value, limits, error) {
  assertExactKeys(
    value,
    ["schemaVersion", "revision", "nextJobSequence", "jobs"],
    error,
  );
  if (value.schemaVersion !== 1) throw error;
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const jobs = normalizeJobs(value.jobs, limits, error);
  const nextJobSequence = safeInteger(
    value.nextJobSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const maximumRevision = jobs.reduce(
    (maximum, job) => Math.max(maximum, job.revision),
    0,
  );
  if (
    revision < jobs.length ||
    maximumRevision !== revision ||
    nextJobSequence !== jobs.length + 1 ||
    jobs.some(({ status }) => status !== "queued")
  ) {
    throw error;
  }
  validateUniqueJobs(jobs, error);
  const created = [...jobs].sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < created.length; index += 1) {
    if (
      created[index].sequence !== index + 1 ||
      (index > 0 &&
        Date.parse(created[index].createdAt) <
          Date.parse(created[index - 1].createdAt))
    ) {
      throw error;
    }
  }
  const state = {
    schemaVersion: 8,
    revision,
    nextJobSequence,
    archive: emptyArchive(),
    archiveIndex: [],
    lastCompaction: null,
    memoryProjection: migrateMemoryProjection(jobs, revision),
    changePackageDelivery: emptyChangePackageDelivery(),
    jobs,
  };
  if (stateExceedsLimits(state, limits) && !retainedHistoryBudgetAllows(state, limits)) {
    throw error;
  }
  return state;
}

function normalizeStateValue(value, limits, validationCache) {
  const error = invalidState();
  if (value?.schemaVersion === 1) {
    return normalizeLegacyState(value, limits, error);
  }
  if (![2, 3, 4, 5, 6, 7, 8].includes(value.schemaVersion)) throw error;
  const legacyVersion = value.schemaVersion === 2;
  const manifestVersion = value.schemaVersion === 3;
  const memoryOutboxVersion = value.schemaVersion >= 7;
  const changePackageVersion = value.schemaVersion >= 8;
  assertExactKeys(
    value,
    legacyVersion
      ? ["schemaVersion", "revision", "nextJobSequence", "archive", "jobs"]
      : manifestVersion
        ? [
          "schemaVersion",
          "revision",
          "nextJobSequence",
          "archive",
          "archiveIndex",
          "jobs",
        ]
        : [
        "schemaVersion",
        "revision",
        "nextJobSequence",
        "archive",
        "archiveIndex",
        "lastCompaction",
        ...(memoryOutboxVersion ? ["memoryProjection"] : []),
        ...(changePackageVersion ? ["changePackageDelivery"] : []),
        "jobs",
      ],
    error,
  );
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const nextJobSequence = safeInteger(
    value.nextJobSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const archive = normalizeArchive(value.archive, error);
  if (legacyVersion && archive.throughSequence !== 0) throw error;
  const archiveIndex = legacyVersion
    ? []
    : normalizeArchiveManifestList(value.archiveIndex, archive, limits, error);
  const lastCompaction = value.schemaVersion >= 4
    ? normalizeLastCompaction(value.lastCompaction, archive, archiveIndex, error)
    : null;
  const jobs = normalizeJobs(value.jobs, limits, error, validationCache);
  validateUniqueJobs(jobs, error);
  const memoryProjection = memoryOutboxVersion
    ? normalizeMemoryProjection(value.memoryProjection, revision, error)
    : migrateMemoryProjection(jobs, revision);
  const changePackageDelivery = changePackageVersion
    ? normalizeChangePackageDelivery(
        value.changePackageDelivery,
        revision,
        error,
        validationCache,
      )
    : emptyChangePackageDelivery();
  const knownJobIds = new Set([
    ...jobs.map(({ jobId }) => jobId),
    ...archiveIndex.map(({ jobId }) => jobId),
  ]);
  const acknowledgedEvent =
    memoryProjection.lastAcknowledgement?.event ?? null;
  const liveJobsById = new Map(jobs.map((job) => [job.jobId, job]));
  const archivedJobsById = new Map(
    archiveIndex.map((entry) => [entry.jobId, entry]),
  );
  const pendingPackageInvalid = changePackageDelivery.pending.some((event) => {
    const job = liveJobsById.get(event.job.id);
    return !job || !changePackageEventMatchesJob(event, job);
  });
  const deliveredPackageInvalid = changePackageDelivery.delivered.some(
    (entry) => {
      const live = liveJobsById.get(entry.receipt.jobId);
      if (live) {
        return !(validationCache === null
          ? deliveredChangePackageMatchesJob(entry, live) : validationCache.matchesDelivery(entry, live));
      }
      const archived = archivedJobsById.get(entry.receipt.jobId);
      return (
        !archived ||
        archived.status !== "completed"
      );
    },
  );
  if (
    nextJobSequence !== archive.throughSequence + jobs.length + 1 ||
    archive.jobCount !== archiveIndex.length ||
    archive.jobCount > limits.maximumArchivedJobs ||
    archive.storageBytes > limits.maximumArchiveBytes ||
    memoryProjection.pending.some(
      ({ jobId, jobRevision }) =>
        !knownJobIds.has(jobId) || jobRevision > revision,
    ) ||
    (acknowledgedEvent !== null &&
      (!knownJobIds.has(acknowledgedEvent.jobId) ||
        acknowledgedEvent.jobRevision > revision)) ||
    pendingPackageInvalid ||
    deliveredPackageInvalid ||
    jobs.some(({ revision: jobRevision }) => jobRevision > revision) ||
    Math.max(
      archive.revision,
      memoryProjection.revision,
      changePackageDelivery.revision,
      jobs.reduce(
        (maximum, job) => Math.max(maximum, job.revision),
        0,
      ),
    ) !== revision ||
    (revision === 0 &&
      (nextJobSequence !== 1 ||
        archive.throughSequence !== 0 ||
        jobs.length !== 0)) ||
    (revision > 0 && nextJobSequence === 1)
  ) {
    throw error;
  }
  const ordered = [...jobs].sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < ordered.length; index += 1) {
    const previousCreatedAt = index === 0
      ? archive.lastCreatedAt
      : ordered[index - 1].createdAt;
    if (
      ordered[index].sequence !== archive.throughSequence + index + 1 ||
      (previousCreatedAt !== null &&
        Date.parse(ordered[index].createdAt) < Date.parse(previousCreatedAt))
    ) {
      throw error;
    }
  }
  const state = {
    schemaVersion: 8,
    revision,
    nextJobSequence,
    archive,
    archiveIndex,
    lastCompaction,
    memoryProjection,
    changePackageDelivery,
    jobs: ordered,
  };
  if (stateExceedsLimits(state, limits) && !retainedHistoryBudgetAllows(state, limits, 0, validationCache)) {
    throw error;
  }
  return state;
}

function normalizeState(value, limits, validationCache = null) {
  try {
    return normalizeStateValue(value, limits, validationCache);
  } catch (error) {
    if (error?.code === "CODE_JOB_STATE_CORRUPTED") throw error;
    throw corruptedState(error);
  }
}

export function normalizeCodeJobStoreState(value, limits = {}) {
  return normalizeState(value, normalizeLimits(limits));
}

function normalizeJobId(
  value,
  error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效"),
) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw error;
  }
  return value;
}

function normalizeSha256(value, error) {
  if (typeof value !== "string" || !SHA256.test(value)) throw error;
  return value;
}

function normalizeSafeId(value, error) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw error;
  }
  return value;
}

function compactionCommand(value) {
  return {
    compactionId: value.compactionId,
    expectedRevision: value.expectedRevision,
    targetThroughSequence: value.targetThroughSequence,
    preArchiveDigest: value.preArchiveDigest,
  };
}

function normalizeLastCompaction(value, archive, archiveIndex, error) {
  if (value === null) return null;
  assertExactKeys(
    value,
    [
      "compactionId",
      "expectedRevision",
      "targetThroughSequence",
      "preArchiveDigest",
      "postArchiveDigest",
      "archived",
      "appliedRevision",
      "commandDigest",
    ],
    error,
  );
  const content = {
    compactionId: normalizeSafeId(value.compactionId, error),
    expectedRevision: safeInteger(
      value.expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    targetThroughSequence: safeInteger(
      value.targetThroughSequence,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    preArchiveDigest: value.preArchiveDigest === null
      ? null
      : normalizeSha256(value.preArchiveDigest, error),
    postArchiveDigest: normalizeSha256(value.postArchiveDigest, error),
    archived: safeInteger(
      value.archived,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    appliedRevision: safeInteger(
      value.appliedRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
  };
  const commandDigest = normalizeSha256(value.commandDigest, error);
  const previousThroughSequence =
    content.targetThroughSequence - content.archived;
  const previousManifest = previousThroughSequence === 0
    ? null
    : archiveIndex[previousThroughSequence - 1];
  const targetManifest = archiveIndex[content.targetThroughSequence - 1];
  if (
    previousThroughSequence < 0 ||
    content.appliedRevision !== content.expectedRevision + 1 ||
    content.appliedRevision > archive.revision ||
    content.targetThroughSequence > archive.throughSequence ||
    (previousManifest?.archiveDigest ?? null) !== content.preArchiveDigest ||
    targetManifest?.archiveDigest !== content.postArchiveDigest ||
    commandDigest !== digestValue(compactionCommand(content))
  ) {
    throw error;
  }
  return { ...content, commandDigest };
}

function normalizeMemoryRecordId(value, digest, error) {
  if (
    typeof value !== "string" ||
    value !== `memory-${digest}`
  ) {
    throw error;
  }
  return value;
}

export function codeJobMemorySourceId(jobId, sourceRecordDigest) {
  const error = storeError(
    "INVALID_CODE_JOB_MUTATION",
    "代码任务记忆来源绑定无效",
  );
  return `code-job:${normalizeJobId(jobId)}:${normalizeSha256(
    sourceRecordDigest,
    error,
  )}`;
}

function normalizeVerifiedMemoryReceipt(value, expected) {
  const error = memoryReceiptUnverified();
  assertExactKeys(
    value,
    ["recordId", "contentDigest", "source", "persisted"],
    error,
  );
  assertExactKeys(value.source, ["kind", "id"], error);
  if (
    value.recordId !== expected.recordId ||
    value.contentDigest !== expected.contentDigest ||
    value.source.kind !== expected.source.kind ||
    value.source.id !== expected.source.id ||
    value.persisted !== true
  ) {
    throw error;
  }
  return cloneCodeJobValue(value);
}

function normalizeListOptions(value = {}) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  const keys = plainDataKeys(value, error);
  if (
    keys.some(
      (key) => !["limit", "cursor", "status", "order"].includes(key),
    )
  ) {
    throw error;
  }
  const rawLimit = Object.hasOwn(value, "limit") ? value.limit : 50;
  const parsedLimit =
    typeof rawLimit === "string" && /^[1-9][0-9]{0,2}$/.test(rawLimit)
      ? Number(rawLimit)
      : rawLimit;
  const order = value.order ?? "newest";
  const status = value.status ?? null;
  if (order !== "newest" || (status !== null && !STATUS_SET.has(status))) {
    throw error;
  }
  return {
    limit: safeInteger(parsedLimit, 1, 100, error),
    cursor:
      value.cursor === undefined ? null : normalizeJobId(value.cursor),
    status,
  };
}

function optionalAbortSignal(value, error) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function" ||
    typeof value.throwIfAborted !== "function"
  ) {
    throw error;
  }
  return value;
}

function normalizeDeliveryEvidenceReadOptions(value) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务证据查询无效");
  assertExactKeys(
    value,
    Object.hasOwn(value ?? {}, "signal")
      ? ["jobId", "signal"]
      : ["jobId"],
    error,
  );
  return {
    jobId: normalizeJobId(value.jobId, error),
    signal: optionalAbortSignal(value.signal, error),
  };
}

function checkAbort(signal) {
  signal?.throwIfAborted();
}

function abortReason(signal) {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

function abortableRead(operation, signal) {
  if (signal === null) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      handler(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

function readStoreValue(store, key, fallback, signal) {
  checkAbort(signal);
  let operation;
  try {
    operation = store.read(
      key,
      fallback,
      signal === null ? undefined : { signal },
    );
  } catch (error) {
    operation = Promise.reject(error);
  }
  return abortableRead(operation, signal);
}

function detailCursorStale() {
  return storeError(
    "CODE_JOB_DETAIL_CURSOR_STALE",
    "代码任务详情分页游标已失效",
    409,
  );
}

function createDetailCursor(jobId, revision, offset) {
  const content = { schemaVersion: 1, jobId, revision, offset };
  return Buffer.from(JSON.stringify({
    ...content,
    digest: digestValue(content),
  }), "utf8").toString("base64url");
}

function normalizeDetailCursor(value, error) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw error;
  }
  let decoded;
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) throw error;
    decoded = JSON.parse(json);
  } catch {
    throw error;
  }
  assertExactKeys(
    decoded,
    ["schemaVersion", "jobId", "revision", "offset", "digest"],
    error,
  );
  const content = {
    schemaVersion: decoded.schemaVersion,
    jobId: normalizeJobId(decoded.jobId, error),
    revision: safeInteger(
      decoded.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    offset: safeInteger(decoded.offset, 1, 128, error),
  };
  if (
    content.schemaVersion !== 1 ||
    normalizeSha256(decoded.digest, error) !== digestValue(content)
  ) {
    throw error;
  }
  return content;
}

function normalizeDetailOptions(value) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  const keys = plainDataKeys(value, error);
  if (
    !keys.includes("jobId") ||
    keys.some((key) => !["jobId", "limit", "cursor"].includes(key))
  ) {
    throw error;
  }
  const rawLimit = value.limit ?? 20;
  const limit = typeof rawLimit === "string" && /^[1-9][0-9]?$/.test(rawLimit)
    ? Number(rawLimit)
    : rawLimit;
  return {
    jobId: normalizeJobId(value.jobId, error),
    limit: safeInteger(limit, 1, 20, error),
    cursor: value.cursor === undefined || value.cursor === null
      ? null
      : normalizeDetailCursor(value.cursor, error),
  };
}

function deliveryReceiptForBrowser(entry) {
  return entry === null || entry === undefined
    ? null
    : {
        packageId: entry.receipt.packageId,
        packageDigest: entry.receipt.packageDigest,
        deliveredAt: entry.receipt.deliveredAt,
        ...(entry.receipt.noChanges === true ? { noChanges: true } : {}),
        ...(entry.receipt.controlledCommit === undefined
          ? {}
          : {
              controlledCommit: {
                receiptId: entry.receipt.controlledCommit.receiptId,
                receiptDigest: entry.receipt.controlledCommit.receiptDigest,
                evidenceId: entry.receipt.controlledCommit.evidenceId,
                evidenceDigest: entry.receipt.controlledCommit.evidenceDigest,
                commitOid: entry.receipt.controlledCommit.commitOid,
              },
            }),
      };
}

function liveChangePackageProjection(state, jobId) {
  if (
    state.changePackageDelivery.pending.some(({ job }) => job.id === jobId)
  ) {
    return { status: "pending", receipt: null };
  }
  const delivered = state.changePackageDelivery.delivered.find(
    ({ receipt }) => receipt.jobId === jobId,
  );
  const receipt = deliveryReceiptForBrowser(delivered);
  return receipt === null
    ? { status: "none", receipt: null }
    : { status: "ready", receipt };
}

function archivedChangePackageProjection(tombstone) {
  const receipt = deliveryReceiptForBrowser(
    tombstone.outcome.changePackageDelivery,
  );
  return receipt === null
    ? { status: "none", receipt: null }
    : { status: "ready", receipt };
}

function normalizeMemoryBatchOptions(value = {}) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  assertExactKeys(
    value,
    Object.hasOwn(value, "limit") ? ["limit"] : [],
    error,
  );
  return {
    limit: safeInteger(value.limit ?? 50, 1, 100, error),
  };
}

function acknowledgementForMemoryEvent(value) {
  const event = normalizeCodeJobMemoryEvent(value);
  const record = normalizeMemoryRecord(memoryRecordForCodeJobEvent(event));
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    jobId: event.jobId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: record.recordId,
    memoryRecordDigest: record.contentDigest,
  };
}

function memoryAcknowledgementResult(status, memoryProjection) {
  return cloneCodeJobValue({
    status,
    cursor: memoryProjection.cursor,
    highWatermark: memoryProjection.nextSequence - 1,
  });
}

function changePackageAcknowledgementResult(status, delivery) {
  return cloneCodeJobValue({
    status,
    cursor: delivery.cursor,
    highWatermark: delivery.nextSequence - 1,
  });
}

function pendingChangePackageAcknowledgement(
  event,
  request,
  { allowLegacy = false } = {},
) {
  const baseMatches =
    request.sequence === event.sequence &&
    request.eventId === event.eventId &&
    request.eventDigest === event.eventDigest &&
    request.jobId === event.job.id &&
    request.sourceRecordDigest === event.job.recordDigest;
  if (!baseMatches) return false;
  if (request.noChanges === true) {
    return event.schemaVersion === 3 && isHeadRepairExecutionSource(event.executionSource) && request.controlledCommit === undefined;
  }
  if (event.schemaVersion === 2) {
    return allowLegacy && request.controlledCommit === undefined;
  }
  if (event.schemaVersion === 1) {
    return request.controlledCommit === undefined;
  }
  const receipt = request.controlledCommit;
  return receipt !== undefined &&
    receipt.eventId === event.eventId &&
    receipt.eventDigest === event.eventDigest &&
    receipt.packageId === request.packageId &&
    receipt.packageDigest === request.packageDigest &&
    receipt.executionSourceDigest === digestValue(event.executionSource) &&
    receipt.recordedAt === event.recordedAt;
}

function deliveredAcknowledgement(receipt) {
  const { deliveredAt: _deliveredAt, ...request } = receipt;
  return request;
}

function sameAuthorization(job, request) {
  return (
    job.jobId === codeJobIdForGrant(request.grant) &&
    job.approval.confirmationId === request.confirmationId &&
    job.approval.displayedPayloadDigest === request.displayedPayloadDigest &&
    job.approval.approvalBindingDigest === request.approvalBindingDigest &&
    job.proposal.proposalId === request.grant.proposalId &&
    job.proposal.contentDigest === request.grant.contentDigest &&
    sameValue(job.grant, request.grant)
  );
}

function creationResult(status, job) {
  return cloneCodeJobValue({
    status,
    receipt: { id: job.jobId, createdAt: job.createdAt },
    job: projectCodeJobForBrowser(job),
  });
}

function findBoundJob(state, request) {
  const jobId = codeJobIdForGrant(request.grant);
  return state.jobs.find(
    (job) =>
      job.jobId === jobId ||
      job.proposal.proposalId === request.grant.proposalId ||
      job.approval.confirmationId === request.confirmationId ||
      job.approval.approvalBindingDigest === request.approvalBindingDigest,
  ) || null;
}

function normalizeMutationBase(value, extraKeys = []) {
  const error = storeError("INVALID_CODE_JOB_MUTATION", "代码任务迁移请求无效");
  assertExactKeys(value, ["jobId", "expectedRevision", ...extraKeys], error);
  return {
    error,
    jobId: normalizeJobId(value.jobId),
    expectedRevision: safeInteger(
      value.expectedRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
  };
}

function normalizeFinishRequest(value, terminalStatus) {
  if (terminalStatus !== "completed") {
    return {
      request: normalizeMutationBase(value, ["result"]),
      changePackageDelivery: false,
    };
  }
  const error = storeError(
    "INVALID_CODE_JOB_MUTATION",
    "代码任务迁移请求无效",
  );
  const keys = plainDataKeys(value, error);
  const hasDelivery = keys.includes("changePackageDelivery");
  const request = normalizeMutationBase(
    value,
    ["result", ...(hasDelivery ? ["changePackageDelivery"] : [])],
  );
  if (
    hasDelivery &&
    typeof value.changePackageDelivery !== "boolean"
  ) {
    throw error;
  }
  return {
    request,
    changePackageDelivery: hasDelivery
      ? value.changePackageDelivery
      : false,
  };
}

function normalizeReason(value, error) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw error;
  }
  return value;
}

function cancellationIntent(reason, requestedFrom, recordedAt) {
  const detail = createCodeJobDetail({
    schemaVersion: 1,
    outcome: "cancelled",
    code: "CODE_JOB_CANCELLED",
    message: "代码任务已按用户请求取消",
    reason,
    requestedFrom,
  });
  return {
    kind: "cancelled",
    detail,
    detailDigest: digestValue(detail),
    recordedAt,
  };
}

function cancellationSettlementReceipt(proof) {
  return {
    kind: proof.kind,
    sessionId: proof.sessionId,
    cancellationDigest: proof.cancellationDigest,
    workspaceRevision: proof.trustedWorkspaceRevision,
    proofDigest: proof.proofDigest,
    settledAt: proof.settledAt,
  };
}

function cancelledExecution(
  execution,
  workspaceRevision = undefined,
  cancellationSettlement = undefined,
) {
  return {
    ...execution,
    ...(workspaceRevision === undefined ? {} : { workspaceRevision }),
    ...(cancellationSettlement === undefined
      ? {}
      : { cancellationSettlement }),
    pendingAction: null,
    actionAdmission: null,
    pause: null,
    uncertainty: null,
  };
}

function normalizeNullableSha256(value, error) {
  return value === null ? null : normalizeSha256(value, error);
}

function normalizeCancellationActionResolution(value, error) {
  if (value === null) return null;
  assertExactKeys(
    value,
    [
      "actionId",
      "actionDigest",
      "disposition",
      "workspaceRevisionBefore",
      "workspaceRevisionAfter",
    ],
    error,
  );
  if (
    ![
      "absent",
      "audited_succeeded",
      "audited_failed",
      "discarded_unknown",
    ].includes(value.disposition)
  ) {
    throw error;
  }
  return {
    actionId: normalizeSafeId(value.actionId, error),
    actionDigest: normalizeSha256(value.actionDigest, error),
    disposition: value.disposition,
    workspaceRevisionBefore: normalizeSha256(
      value.workspaceRevisionBefore,
      error,
    ),
    workspaceRevisionAfter: normalizeNullableSha256(
      value.workspaceRevisionAfter,
      error,
    ),
  };
}

function normalizeCancellationSettlement(value, error) {
  const proofKeys = [
    "schemaVersion",
    "kind",
    "sessionId",
    "cancellationDigest",
    "sourceRevision",
    "trustedWorkspaceRevision",
    "actionResolution",
    "sandboxCleanupConfirmed",
    "discardedAttempts",
    "settledAt",
    "proofDigest",
  ];
  assertExactKeys(value, proofKeys, error);
  const discardedAttempts = denseArray(
    value.discardedAttempts,
    1_000,
    error,
  ).map((attempt) => {
    assertExactKeys(
      attempt,
      ["attemptNumber", "executionId", "disposition"],
      error,
    );
    if (attempt.disposition !== "discarded") throw error;
    return {
      attemptNumber: safeInteger(
        attempt.attemptNumber,
        1,
        1_000,
        error,
      ),
      executionId: normalizeSafeId(attempt.executionId, error),
      disposition: "discarded",
    };
  });
  if (
    value.schemaVersion !== 1 ||
    ![
      "controlled_execution_absent",
      "controlled_execution_cancelled",
    ].includes(value.kind) ||
    value.sandboxCleanupConfirmed !== true ||
    (value.kind === "controlled_execution_absent"
      ? discardedAttempts.length !== 0
      : discardedAttempts.length < 1) ||
    discardedAttempts.some(
      ({ attemptNumber }, index) => attemptNumber !== index + 1,
    ) ||
    new Set(discardedAttempts.map(({ executionId }) => executionId)).size !==
      discardedAttempts.length
  ) {
    throw error;
  }
  const proof = {
    schemaVersion: 1,
    kind: value.kind,
    sessionId: normalizeJobId(value.sessionId, error),
    cancellationDigest: normalizeSha256(value.cancellationDigest, error),
    sourceRevision: normalizeNullableSha256(value.sourceRevision, error),
    trustedWorkspaceRevision: normalizeNullableSha256(
      value.trustedWorkspaceRevision,
      error,
    ),
    actionResolution: normalizeCancellationActionResolution(
      value.actionResolution,
      error,
    ),
    sandboxCleanupConfirmed: true,
    discardedAttempts,
    settledAt: normalizeCodeJobTimestamp(value.settledAt, error),
  };
  const proofDigest = normalizeSha256(value.proofDigest, error);
  if (digestValue(proof) !== proofDigest) throw error;
  return { ...proof, proofDigest };
}

function normalizeFailureCode(value, error) {
  if (
    typeof value !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)
  ) {
    throw error;
  }
  return value;
}

function normalizeActionBinding(value, error, { includeEpoch = false } = {}) {
  const actionId = normalizeSafeId(value.actionId, error);
  const actionDigest = normalizeSha256(value.actionDigest, error);
  return {
    actionId,
    actionDigest,
    ...(includeEpoch
      ? {
          epoch: safeInteger(
            value.epoch,
            1,
            Number.MAX_SAFE_INTEGER,
            error,
          ),
        }
      : {}),
  };
}

function workerMutationResult(status, job) {
  return cloneCodeJobValue({ status, job });
}

function compactionResult(status, receipt) {
  return cloneCodeJobValue({ status, receipt });
}

const ARCHIVE_BINDING_KINDS = Object.freeze([
  "job",
  "proposal",
  "confirmation",
  "approval",
]);
const ARCHIVE_BINDING_KIND_SET = new Set(ARCHIVE_BINDING_KINDS);

function archiveBindingValuesFromJob(job) {
  return {
    job: job.jobId,
    proposal: job.proposal.proposalId,
    confirmation: job.approval.confirmationId,
    approval: job.approval.approvalBindingDigest,
  };
}

function archiveBindingValuesFromTombstone(tombstone) {
  return {
    job: tombstone.jobId,
    proposal: tombstone.proposal.proposalId,
    confirmation: tombstone.approval.confirmationId,
    approval: tombstone.approval.approvalBindingDigest,
  };
}

function archiveBindingValuesFromRequest(request) {
  return {
    job: codeJobIdForGrant(request.grant),
    proposal: request.grant.proposalId,
    confirmation: request.confirmationId,
    approval: request.approvalBindingDigest,
  };
}

function archiveBindingDigest(kind, value) {
  return digestValue({ schemaVersion: 1, kind, value });
}

function archiveIndexKey(kind, value) {
  return `${CODE_JOB_TOMBSTONE_PREFIX}-index-${archiveBindingDigest(kind, value)}`;
}

function archiveRecordKey(jobId) {
  return `${CODE_JOB_TOMBSTONE_PREFIX}-record-${jobId}`;
}

function archiveLinkDigest(previousDigest, job) {
  return digestValue({
    schemaVersion: 1,
    previousDigest,
    sequence: job.sequence,
    jobId: job.jobId,
    status: job.status,
    recordDigest: job.recordDigest,
  });
}

function createArchiveTombstone(entry) {
  const job = normalizeCodeJob(entry.job);
  if (!isRetentionEligibleCodeJob(job)) {
    throw invalidState("代码任务尚未获得记忆投影凭据");
  }
  const latestObservation = job.execution.observations.length === 0
    ? null
    : {
      actionType: job.execution.observations.at(-1).actionType,
      status: job.execution.observations.at(-1).status,
      recordedAt: job.execution.observations.at(-1).recordedAt,
  };
  const resultCode = job.execution.result.detail?.code;
  const verificationOutcome = job.status === "failed" &&
    job.grant.operation === "verify" && isCodeJobVerificationOutcome(resultCode)
    ? resultCode
    : null;
  const content = {
    schemaVersion: 3,
    previousArchiveDigest: entry.previousArchiveDigest,
    archiveDigest: entry.archiveDigest,
    sequence: job.sequence,
    jobId: job.jobId,
    status: job.status,
    revision: job.revision,
    approval: job.approval,
    proposal: job.proposal,
    grant: job.grant,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    recordDigest: job.recordDigest,
    outcome: {
      turn: job.execution.turn,
      observationCount: job.execution.observations.length,
      latestObservation,
      terminalResult: {
        kind: job.execution.result.kind,
        recordedAt: codeJobTerminalLifecycleAt(job),
      },
      memoryProjection: job.execution.memoryProjection,
      changePackageDelivery: entry.changePackageDelivery,
      verificationOutcome,
      ...(job.execution.result.detail.completionReport === undefined ? {} : {
        completionReport: job.execution.result.detail.completionReport,
      }),
    },
  };
  if (
    (content.previousArchiveDigest !== null &&
      (typeof content.previousArchiveDigest !== "string" ||
        !SHA256.test(content.previousArchiveDigest))) ||
    typeof content.archiveDigest !== "string" ||
    !SHA256.test(content.archiveDigest) ||
    archiveLinkDigest(content.previousArchiveDigest, content) !==
      content.archiveDigest
  ) {
    throw invalidState("代码任务归档墓碑无效");
  }
  return { ...content, tombstoneDigest: digestValue(content) };
}

function normalizeArchiveTombstone(value) {
  const error = corruptedArchive();
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "previousArchiveDigest",
      "archiveDigest",
      "sequence",
      "jobId",
      "status",
      "revision",
      "approval",
      "proposal",
      "grant",
      "createdAt",
      "updatedAt",
      "recordDigest",
      "outcome",
      "tombstoneDigest",
    ],
    error,
  );
  if (![1, 2, 3].includes(value.schemaVersion)) throw error;
  const previousArchiveDigest = value.previousArchiveDigest === null
    ? null
    : normalizeSha256(value.previousArchiveDigest, error);
  const archiveDigest = normalizeSha256(value.archiveDigest, error);
  let request;
  try {
    request = normalizeApprovedCodeJobRequest({
      confirmationId: value.approval?.confirmationId,
      requestId: value.approval?.requestId,
      displayedPayloadDigest: value.approval?.displayedPayloadDigest,
      approvalBindingDigest: value.approval?.approvalBindingDigest,
      grant: value.grant,
    });
  } catch (cause) {
    throw corruptedArchive(cause);
  }
  assertExactKeys(value.proposal, ["proposalId", "contentDigest"], error);
  const createdAt = normalizeCodeJobTimestamp(value.createdAt, error);
  const updatedAt = normalizeCodeJobTimestamp(value.updatedAt, error);
  const outcome = normalizeArchivedOutcome(
    value.outcome,
    {
      schemaVersion: value.schemaVersion,
      status: value.status,
      operation: request.grant.operation,
      updatedAt,
    },
    error,
  );
  const content = {
    schemaVersion: value.schemaVersion,
    previousArchiveDigest,
    archiveDigest,
    sequence: safeInteger(
      value.sequence,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    jobId: normalizeJobId(value.jobId),
    status: value.status,
    revision: safeInteger(
      value.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    approval: {
      confirmationId: request.confirmationId,
      requestId: request.requestId,
      displayedPayloadDigest: request.displayedPayloadDigest,
      approvalBindingDigest: request.approvalBindingDigest,
    },
    proposal: {
      proposalId: value.proposal.proposalId,
      contentDigest: normalizeSha256(value.proposal.contentDigest, error),
    },
    grant: request.grant,
    createdAt,
    updatedAt,
    recordDigest: normalizeSha256(value.recordDigest, error),
    outcome,
  };
  const tombstoneDigest = normalizeSha256(value.tombstoneDigest, error);
  if (
    !isTerminalCodeJobStatus(content.status) ||
    content.jobId !== codeJobIdForGrant(content.grant) ||
    content.proposal.proposalId !== content.grant.proposalId ||
    content.proposal.contentDigest !== content.grant.contentDigest ||
    Date.parse(content.updatedAt) < Date.parse(content.createdAt) ||
    outcome.terminalResult.kind !== content.status ||
    outcome.memoryProjection.jobId !== content.jobId ||
    outcome.memoryProjection.sourceRevision >= content.revision ||
    outcome.memoryProjection.projectedAt !== content.updatedAt ||
    (outcome.changePackageDelivery != null &&
      (content.status !== "completed" ||
        outcome.changePackageDelivery.receipt.jobId !== content.jobId ||
        outcome.changePackageDelivery.receipt.sourceRecordDigest !==
          outcome.memoryProjection.sourceRecordDigest)) ||
    archiveLinkDigest(previousArchiveDigest, content) !== archiveDigest ||
    tombstoneDigest !== digestValue(content)
  ) {
    throw error;
  }
  return { ...content, tombstoneDigest };
}

function normalizeArchivedOutcome(value, tombstone, error) {
  const packageVersion = tombstone.schemaVersion >= 2;
  const verificationVersion = tombstone.schemaVersion >= 3;
  assertExactKeys(
    value,
    [
      "turn",
      "observationCount",
      "latestObservation",
      "terminalResult",
      "memoryProjection",
      ...(packageVersion ? ["changePackageDelivery"] : []),
      ...(verificationVersion ? ["verificationOutcome"] : []),
      ...(Object.hasOwn(value ?? {}, "completionReport") ? ["completionReport"] : []),
    ],
    error,
  );
  const turn = safeInteger(value.turn, 0, 128, error);
  const observationCount = safeInteger(value.observationCount, 0, 128, error);
  let latestObservation = null;
  if (value.latestObservation !== null) {
    assertExactKeys(
      value.latestObservation,
      ["actionType", "status", "recordedAt"],
      error,
    );
    if (
      typeof value.latestObservation.actionType !== "string" ||
      !/^[a-z](?:[a-z_]{0,62}[a-z])?$/.test(
        value.latestObservation.actionType,
      ) ||
      !OBSERVATION_STATUSES.has(value.latestObservation.status)
    ) {
      throw error;
    }
    latestObservation = {
      actionType: value.latestObservation.actionType,
      status: value.latestObservation.status,
      recordedAt: normalizeCodeJobTimestamp(
        value.latestObservation.recordedAt,
        error,
      ),
    };
  }
  assertExactKeys(value.terminalResult, ["kind", "recordedAt"], error);
  const terminalResult = {
    kind: value.terminalResult.kind,
    recordedAt: normalizeCodeJobTimestamp(
      value.terminalResult.recordedAt,
      error,
    ),
  };
  const memory = value.memoryProjection;
  assertExactKeys(
    memory,
    [
      "jobId",
      "sourceRecordDigest",
      "sourceRevision",
      "sourceUpdatedAt",
      "memoryRecordId",
      "memoryRecordDigest",
      "projectedAt",
    ],
    error,
  );
  const memoryRecordDigest = normalizeSha256(memory.memoryRecordDigest, error);
  const memoryProjection = {
    jobId: normalizeJobId(memory.jobId),
    sourceRecordDigest: normalizeSha256(memory.sourceRecordDigest, error),
    sourceRevision: safeInteger(
      memory.sourceRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    sourceUpdatedAt: normalizeCodeJobTimestamp(memory.sourceUpdatedAt, error),
    memoryRecordId: normalizeMemoryRecordId(
      memory.memoryRecordId,
      memoryRecordDigest,
      error,
    ),
    memoryRecordDigest,
    projectedAt: normalizeCodeJobTimestamp(memory.projectedAt, error),
  };
  if (
    turn !== observationCount ||
    (turn === 0) !== (latestObservation === null) ||
    Date.parse(terminalResult.recordedAt) > Date.parse(tombstone.updatedAt) ||
    Date.parse(memoryProjection.sourceUpdatedAt) >
      Date.parse(memoryProjection.projectedAt)
  ) {
    throw error;
  }
  const changePackageDelivery = !packageVersion ||
    value.changePackageDelivery === null
    ? null
    : normalizeDeliveredChangePackage(value.changePackageDelivery, error);
  const verificationOutcome = verificationVersion
    ? value.verificationOutcome
    : null;
  let completionReport;
  if (Object.hasOwn(value, "completionReport")) {
    if (tombstone.status !== "completed" || latestObservation?.actionType !== "complete" ||
        latestObservation.status !== "succeeded") throw error;
    const report = value.completionReport;
    completionReport = normalizeCodeJobCompletionReport(report, { type: "complete",
      actionId: report?.actionId, expectedWorkspaceRevision: report?.workspaceRevision }, error);
  }
  if (
    verificationOutcome !== null &&
    (tombstone.status !== "failed" || tombstone.operation !== "verify" ||
      !isCodeJobVerificationOutcome(verificationOutcome))
  ) {
    throw error;
  }
  return {
    turn,
    observationCount,
    latestObservation,
    terminalResult,
    memoryProjection,
    ...(packageVersion ? { changePackageDelivery } : {}),
    ...(verificationVersion ? { verificationOutcome } : {}),
    ...(completionReport === undefined ? {} : { completionReport }),
  };
}

function sameArchivedAuthorization(tombstone, request) {
  return (
    tombstone.jobId === codeJobIdForGrant(request.grant) &&
    tombstone.approval.confirmationId === request.confirmationId &&
    tombstone.approval.displayedPayloadDigest ===
      request.displayedPayloadDigest &&
    tombstone.approval.approvalBindingDigest ===
      request.approvalBindingDigest &&
    tombstone.proposal.proposalId === request.grant.proposalId &&
    tombstone.proposal.contentDigest === request.grant.contentDigest &&
    sameValue(tombstone.grant, request.grant)
  );
}

function archivedCreationResult(status, tombstone) {
  return cloneCodeJobValue({
    status,
    receipt: { id: tombstone.jobId, createdAt: tombstone.createdAt },
    job: projectArchivedCodeJobForBrowser(tombstone),
  });
}

function createArchiveIndex(kind, value, tombstone) {
  if (!ARCHIVE_BINDING_KIND_SET.has(kind)) throw invalidState();
  const content = {
    schemaVersion: 1,
    kind,
    bindingDigest: archiveBindingDigest(kind, value),
    jobId: tombstone.jobId,
    tombstoneDigest: tombstone.tombstoneDigest,
  };
  return { ...content, indexDigest: digestValue(content) };
}

function normalizeArchiveIndex(value, kind, bindingValue) {
  const error = corruptedArchive();
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "bindingDigest",
      "jobId",
      "tombstoneDigest",
      "indexDigest",
    ],
    error,
  );
  const content = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    bindingDigest: normalizeSha256(value.bindingDigest, error),
    jobId: normalizeJobId(value.jobId),
    tombstoneDigest: normalizeSha256(value.tombstoneDigest, error),
  };
  if (
    content.schemaVersion !== 1 ||
    content.kind !== kind ||
    content.bindingDigest !== archiveBindingDigest(kind, bindingValue) ||
    normalizeSha256(value.indexDigest, error) !== digestValue(content)
  ) {
    throw error;
  }
  return { ...content, indexDigest: value.indexDigest };
}

function serializedArchiveBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createArchiveManifest(
  tombstone,
  indexes,
  storageBytes,
  previousManifestDigest,
) {
  const bindings = Object.fromEntries(
    ARCHIVE_BINDING_KINDS.map((kind) => [kind, indexes[kind].bindingDigest]),
  );
  const content = {
    sequence: tombstone.sequence,
    jobId: tombstone.jobId,
    status: tombstone.status,
    recordDigest: tombstone.recordDigest,
    previousArchiveDigest: tombstone.previousArchiveDigest,
    archiveDigest: tombstone.archiveDigest,
    tombstoneDigest: tombstone.tombstoneDigest,
    previousManifestDigest,
    bindings,
    storageBytes,
  };
  return { ...content, manifestDigest: digestValue(content) };
}

function normalizeArchiveManifest(value, error) {
  assertExactKeys(
    value,
    [
      "sequence",
      "jobId",
      "status",
      "recordDigest",
      "previousArchiveDigest",
      "archiveDigest",
      "tombstoneDigest",
      "previousManifestDigest",
      "bindings",
      "storageBytes",
      "manifestDigest",
    ],
    error,
  );
  assertExactKeys(value.bindings, ARCHIVE_BINDING_KINDS, error);
  const content = {
    sequence: safeInteger(
      value.sequence,
      1,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
    jobId: normalizeJobId(value.jobId),
    status: value.status,
    recordDigest: normalizeSha256(value.recordDigest, error),
    previousArchiveDigest: value.previousArchiveDigest === null
      ? null
      : normalizeSha256(value.previousArchiveDigest, error),
    archiveDigest: normalizeSha256(value.archiveDigest, error),
    tombstoneDigest: normalizeSha256(value.tombstoneDigest, error),
    previousManifestDigest: value.previousManifestDigest === null
      ? null
      : normalizeSha256(value.previousManifestDigest, error),
    bindings: Object.fromEntries(
      ARCHIVE_BINDING_KINDS.map((kind) => [
        kind,
        normalizeSha256(value.bindings[kind], error),
      ]),
    ),
    storageBytes: safeInteger(
      value.storageBytes,
      1,
      MAX_ARCHIVE_BYTES,
      error,
    ),
  };
  const manifestDigest = normalizeSha256(value.manifestDigest, error);
  if (
    !isTerminalCodeJobStatus(content.status) ||
    archiveLinkDigest(content.previousArchiveDigest, content) !==
      content.archiveDigest ||
    manifestDigest !== digestValue(content)
  ) {
    throw error;
  }
  return { ...content, manifestDigest };
}

function normalizeArchiveManifestList(value, archive, limits, error) {
  const manifests = denseArray(
    value,
    limits.maximumArchivedJobs,
    error,
  ).map((entry) => normalizeArchiveManifest(entry, error));
  let previousArchiveDigest = null;
  let previousManifestDigest = null;
  let storageBytes = 0;
  const unique = Object.fromEntries(
    ARCHIVE_BINDING_KINDS.map((kind) => [kind, new Set()]),
  );
  const jobIds = new Set();
  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index];
    if (
      manifest.sequence !== index + 1 ||
      manifest.previousArchiveDigest !== previousArchiveDigest ||
      manifest.previousManifestDigest !== previousManifestDigest ||
      jobIds.has(manifest.jobId)
    ) {
      throw error;
    }
    jobIds.add(manifest.jobId);
    for (const kind of ARCHIVE_BINDING_KINDS) {
      if (unique[kind].has(manifest.bindings[kind])) throw error;
      unique[kind].add(manifest.bindings[kind]);
    }
    previousArchiveDigest = manifest.archiveDigest;
    previousManifestDigest = manifest.manifestDigest;
    storageBytes += manifest.storageBytes;
  }
  if (
    manifests.length !== archive.jobCount ||
    storageBytes !== archive.storageBytes ||
    (manifests.at(-1)?.archiveDigest ?? null) !== archive.digest ||
    (manifests.at(-1)?.manifestDigest ?? null) !==
      archive.lastManifestDigest
  ) {
    throw error;
  }
  return manifests;
}

function createArchiveManifestLookup(state) {
  const lookup = Object.fromEntries(
    ARCHIVE_BINDING_KINDS.map((kind) => [kind, new Map()]),
  );
  for (const manifest of state.archiveIndex) {
    for (const kind of ARCHIVE_BINDING_KINDS) {
      lookup[kind].set(manifest.bindings[kind], manifest);
    }
  }
  return lookup;
}

function assertTombstoneMatchesManifest(tombstone, manifest) {
  const bindings = archiveBindingValuesFromTombstone(tombstone);
  if (
    tombstone.jobId !== manifest.jobId ||
    tombstone.sequence !== manifest.sequence ||
    tombstone.status !== manifest.status ||
    tombstone.recordDigest !== manifest.recordDigest ||
    tombstone.previousArchiveDigest !== manifest.previousArchiveDigest ||
    tombstone.archiveDigest !== manifest.archiveDigest ||
    tombstone.tombstoneDigest !== manifest.tombstoneDigest ||
    ARCHIVE_BINDING_KINDS.some(
      (kind) =>
        archiveBindingDigest(kind, bindings[kind]) !== manifest.bindings[kind],
    )
  ) {
    throw corruptedArchive();
  }
  return bindings;
}

export function normalizeCodeJobArchiveTombstoneRecord(value, options) {
  const error = corruptedArchive();
  try {
    assertExactKeys(options, ["storageKey", "manifest"], error);
    const tombstone = normalizeArchiveTombstone(value);
    if (options.storageKey !== archiveRecordKey(tombstone.jobId)) throw error;
    const manifest = normalizeArchiveManifest(options.manifest, error);
    const bindings = assertTombstoneMatchesManifest(tombstone, manifest);
    return Object.freeze({
      tombstone,
      bindings: Object.freeze(bindings),
    });
  } catch (cause) {
    if (cause?.code === "CODE_JOB_ARCHIVE_CORRUPTED") throw cause;
    throw corruptedArchive(cause);
  }
}

export function normalizeCodeJobArchiveIndexRecord(value, options) {
  const error = corruptedArchive();
  try {
    assertExactKeys(options, ["storageKey", "tombstone"], error);
    const tombstone = normalizeArchiveTombstone(options.tombstone);
    const bindings = archiveBindingValuesFromTombstone(tombstone);
    const kinds = ARCHIVE_BINDING_KINDS.filter(
      (kind) => archiveIndexKey(kind, bindings[kind]) === options.storageKey,
    );
    if (kinds.length !== 1) throw error;
    const kind = kinds[0];
    const index = normalizeArchiveIndex(value, kind, bindings[kind]);
    if (
      index.jobId !== tombstone.jobId ||
      index.tombstoneDigest !== tombstone.tombstoneDigest
    ) {
      throw error;
    }
    return Object.freeze({ kind, index });
  } catch (cause) {
    if (cause?.code === "CODE_JOB_ARCHIVE_CORRUPTED") throw cause;
    throw corruptedArchive(cause);
  }
}

function prepareArchiveEntry(state, archive, job, revision, limits) {
  if (
    job.sequence !== archive.throughSequence + 1 ||
    !isRetentionEligibleCodeJob(job)
  ) {
    throw invalidState("代码任务归档前缀不连续");
  }
  const previousArchiveDigest = archive.digest;
  const archiveDigest = archiveLinkDigest(previousArchiveDigest, job);
  const changePackageDelivery =
    state.changePackageDelivery.delivered.find(
      ({ receipt }) => receipt.jobId === job.jobId,
    ) ?? null;
  const tombstone = createArchiveTombstone({
    job,
    previousArchiveDigest,
    archiveDigest,
    changePackageDelivery,
  });
  const bindings = archiveBindingValuesFromTombstone(tombstone);
  const indexes = Object.fromEntries(
    ARCHIVE_BINDING_KINDS.map((kind) => [
      kind,
      createArchiveIndex(kind, bindings[kind], tombstone),
    ]),
  );
  const storageBytes = serializedArchiveBytes(tombstone) +
    Object.values(indexes).reduce(
      (total, index) => total + serializedArchiveBytes(index),
      0,
    );
  const manifest = createArchiveManifest(
    tombstone,
    indexes,
    storageBytes,
    archive.lastManifestDigest,
  );
  if (
    archive.jobCount + 1 > limits.maximumArchivedJobs ||
    archive.storageBytes + storageBytes > limits.maximumArchiveBytes
  ) {
    throw capacityExceeded();
  }
  const nextArchive = sealArchive({
    throughSequence: job.sequence,
    jobCount: archive.jobCount + 1,
    revision,
    digest: archiveDigest,
    lastCreatedAt: job.createdAt,
    lastUpdatedAt:
      archive.lastUpdatedAt === null ||
      Date.parse(job.updatedAt) > Date.parse(archive.lastUpdatedAt)
        ? job.updatedAt
        : archive.lastUpdatedAt,
    storageBytes: archive.storageBytes + storageBytes,
    lastManifestDigest: manifest.manifestDigest,
  });
  return { archive: nextArchive, tombstone, indexes, manifest };
}

function isStateRetentionEligible(state, job, pendingJobIds = null, validationCache = null) {
  return (
    (validationCache === null ? isRetentionEligibleCodeJob(job) : validationCache.isRetentionEligible(job)) &&
    !(pendingJobIds === null
      ? state.changePackageDelivery.pending.some(event => event.job.id === job.jobId)
      : pendingJobIds.has(job.jobId))
  );
}

function archiveTerminalPrefix(
  state,
  {
    protectedSequences = new Set(),
    all = false,
    targetThroughSequence = Number.MAX_SAFE_INTEGER,
    limits,
  } = {},
) {
  let archive = state.archive;
  let archiveIndex = state.archiveIndex;
  let jobs = state.jobs;
  let archived = 0;
  const archivedEntries = [];
  while (
    jobs.length > 0 &&
    jobs[0].sequence <= targetThroughSequence &&
    isStateRetentionEligible(state, jobs[0]) &&
    !protectedSequences.has(jobs[0].sequence)
  ) {
    if (!all && archived > 0) break;
    const job = jobs[0];
    const prepared = prepareArchiveEntry(
      state,
      archive,
      job,
      state.revision,
      limits,
    );
    archive = prepared.archive;
    archiveIndex = [...archiveIndex, prepared.manifest];
    archivedEntries.push(prepared);
    jobs = jobs.slice(1);
    archived += 1;
  }
  return {
    state: archived === 0
      ? state
      : { ...state, archive, archiveIndex, jobs },
    archived,
    archivedEntries,
  };
}

function stateExceedsLimits(state, limits, requiredHeadroomBytes = 0) {
  return (
    state.jobs.length > limits.maximumJobs ||
    Buffer.byteLength(JSON.stringify(state), "utf8") >
      limits.maximumStateBytes - requiredHeadroomBytes
  );
}

// Prefix compaction remains preferred. If an owner-held or unfinished job pins
// that prefix, already-projectable terminal history may use the historical
// budget without consuming the space reserved for live action receipts.
function retainedHistoryBudgetAllows(state, limits, requiredHeadroomBytes = 0, validationCache = null) {
  let liveBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  let liveJobs = state.jobs.length;
  let historyBytes = state.archive.storageBytes;
  let historyJobs = state.archive.jobCount;
  const pendingJobIds = new Set(state.changePackageDelivery.pending.map(event => event.job.id));
  for (const job of state.jobs) {
    if (!isStateRetentionEligible(state, job, pendingJobIds, validationCache)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(job), 'utf8');
    liveBytes -= bytes;
    liveJobs--;
    historyBytes += bytes;
    historyJobs++;
  }
  return liveJobs <= limits.maximumJobs && liveBytes + requiredHeadroomBytes <= limits.maximumStateBytes &&
    historyJobs <= limits.maximumArchivedJobs && historyBytes <= limits.maximumArchiveBytes;
}

function normalizeRunnableOptions(value = {}) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  const keys = plainDataKeys(value, error);
  if (keys.some((key) => !["limit", "roleId", "afterSequence"].includes(key))) {
    throw error;
  }
  const roleId = value.roleId ?? null;
  if (
    roleId !== null &&
    (typeof roleId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(roleId))
  ) {
    throw error;
  }
  return {
    limit: safeInteger(value.limit ?? 50, 1, 100, error),
    roleId,
    afterSequence: safeInteger(
      value.afterSequence ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
      error,
    ),
  };
}

function rotateWorkerCandidates(items, afterSequence, limit) {
  if (items.length === 0) return [];
  const nextIndex = items.findIndex(({ sequence }) => sequence > afterSequence);
  const start = nextIndex < 0 ? 0 : nextIndex;
  return [...items.slice(start), ...items.slice(0, start)].slice(0, limit);
}

export class CodeJobStore {
  #validationCache = new CodeJobStateValidationCache();
  #durableSnapshot = null;

  constructor({
    store,
    exclusiveLease,
    operationQueue,
    clock = () => new Date(),
    limits = {},
    memoryReceiptVerifier = null,
    changePackageReader = null,
  } = {}) {
    validateDependency(store, ["read", "write"], "store");
    validateDependency(exclusiveLease, ["run"], "exclusiveLease");
    validateDependency(operationQueue, ["enqueue"], "operationQueue");
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    if (
      memoryReceiptVerifier !== null &&
      typeof memoryReceiptVerifier?.verify !== "function"
    ) {
      throw new TypeError("memoryReceiptVerifier is invalid");
    }
    if (
      changePackageReader !== null &&
      typeof changePackageReader?.get !== "function"
    ) {
      throw new TypeError("changePackageReader is invalid");
    }
    this.store = store;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue;
    this.clock = clock;
    this.limits = normalizeLimits(limits);
    this.memoryReceiptVerifier = memoryReceiptVerifier;
    this.changePackageReader = changePackageReader;
    this.state = defaultState();
    this.archiveManifestLookup = createArchiveManifestLookup(this.state);
    this.ready = false;
  }

  recover() {
    return this.operationQueue.enqueue(async () => {
      this.ready = false;
      return this.exclusiveLease.run(async () => {
        const recovered = await this.#readDurableState({ recovering: true });
        this.ready = true;
        return {
          revision: recovered.revision,
          count: recovered.jobs.length,
          archive: cloneCodeJobValue(recovered.archive),
        };
      });
    });
  }

  createApprovedJob(value) {
    const request = normalizeApprovedCodeJobRequest(value);
    return this.#mutate(async (state) => {
      const existing = findBoundJob(state, request);
      if (existing) {
        if (!sameAuthorization(existing, request)) throw bindingConflict();
        return {
          state,
          value: creationResult("already", existing),
          write: false,
        };
      }
      const archived = await this.#findArchivedBinding(state, request);
      if (archived !== null) {
        if (!sameArchivedAuthorization(archived, request)) {
          throw bindingConflict();
        }
        return {
          state,
          value: archivedCreationResult("already", archived),
          write: false,
        };
      }
      const revision = state.revision + 1;
      const created = createQueuedCodeJob(request, {
        sequence: state.nextJobSequence,
        revision,
        createdAt: this.#now(state),
      });
      return {
        state: {
          ...state,
          revision,
          nextJobSequence: state.nextJobSequence + 1,
          jobs: [...state.jobs, created],
        },
        value: creationResult("applied", created),
        write: true,
        protectedSequences: new Set([created.sequence]),
      };
    });
  }

  reconcileApprovedJob(value) {
    const request = normalizeApprovedCodeJobRequest(value);
    return this.#query(async () => {
      const existing = findBoundJob(this.state, request);
      if (existing) {
        if (!sameAuthorization(existing, request)) throw bindingConflict();
        return creationResult("already", existing);
      }
      const archived = await this.#findArchivedBinding(this.state, request);
      if (archived === null) return { status: "absent" };
      if (!sameArchivedAuthorization(archived, request)) {
        throw bindingConflict();
      }
      return archivedCreationResult("already", archived);
    });
  }

  claimStarting(value) {
    const request = normalizeMutationBase(value);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (job.execution.sessionId === job.jobId) {
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "queued") throw transitionConflict();
      const changed = this.#updateJob(
        state,
        index,
        "starting",
        () => ({ ...job.execution, sessionId: job.jobId }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  activate(value) {
    const request = normalizeMutationBase(value, ["workspaceRevision"]);
    const workspaceRevision = normalizeSha256(
      value.workspaceRevision,
      request.error,
    );
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (job.execution.workspaceRevision !== null) {
        if (job.execution.workspaceRevision !== workspaceRevision) {
          throw transitionConflict("代码任务已绑定不同的工作区版本");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "starting") throw transitionConflict();
      const changed = this.#updateJob(
        state,
        index,
        "active",
        () => ({ ...job.execution, workspaceRevision }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  acknowledgeAbsentSession(value) {
    const request = normalizeMutationBase(value);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      this.#assertJobRevision(job, request.expectedRevision);
      if (
        job.status !== "pausing" ||
        job.execution.pause?.from !== "starting" ||
        job.execution.workspaceRevision !== null
      ) {
        throw transitionConflict();
      }
      const changed = this.#updateJob(
        state,
        index,
        "paused",
        () => ({ ...job.execution }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  acknowledgeStartedSession(value) {
    const request = normalizeMutationBase(value, ["workspaceRevision"]);
    const workspaceRevision = normalizeSha256(
      value.workspaceRevision,
      request.error,
    );
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (
        job.status === "paused" &&
        job.execution.pause?.from === "active" &&
        job.execution.workspaceRevision === workspaceRevision
      ) {
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (
        job.status !== "pausing" ||
        job.execution.pause?.from !== "starting" ||
        job.execution.workspaceRevision !== null
      ) {
        throw transitionConflict();
      }
      const changed = this.#updateJob(
        state,
        index,
        "paused",
        () => ({
          ...job.execution,
          workspaceRevision,
          pause: { ...job.execution.pause, from: "active" },
        }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  prepareAction(value) {
    const hasReport = Object.hasOwn(value ?? {}, "completionReport");
    const request = normalizeMutationBase(value, ["action", ...(hasReport ? ["completionReport"] : [])]);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      let action;
      try {
        action = normalizeActionRequest({
          sessionId: job.jobId,
          action: value.action,
        }).action;
      } catch (cause) {
        throw storeError(
          "INVALID_CODE_JOB_MUTATION",
          "代码任务可信动作无效",
          400,
          { cause },
        );
      }
      if (!job.grant.allowedActions.includes(action.type)) {
        throw transitionConflict("可信动作超出代码任务授权范围");
      }
      if (Buffer.byteLength(JSON.stringify(action), "utf8") > CODE_JOB_MAXIMUM_ACTION_BYTES) {
        throw storeError("CODE_JOB_ACTION_TOO_LARGE", "可信动作超过持久化大小上限", 413);
      }
      if (
        action.type === "run_profile" &&
        !job.grant.requiredProfiles.some(({ id }) => id === action.profileId)
      ) {
        throw transitionConflict("测试配置不在代码任务授权范围内");
      }
      const actionDigest = digestValue(action);
      const completionReport = hasReport
        ? normalizeCodeJobCompletionReport(value.completionReport, action, request.error) : undefined;
      const pending = job.execution.pendingAction;
      const observed = job.execution.observations.find(
        (entry) => entry.actionId === action.actionId,
      );
      if (
        (pending !== null &&
          pending.actionId === action.actionId &&
          pending.actionDigest === actionDigest) ||
        (observed !== undefined && observed.actionDigest === actionDigest)
      ) {
        const saved = pending?.actionId === action.actionId ? pending : observed;
        if (digestValue(saved.completionReport ?? null) !== digestValue(completionReport ?? null)) {
          throw transitionConflict("actionId 已绑定不同的完成报告");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      if (pending !== null || observed !== undefined) {
        throw transitionConflict("actionId 已绑定不同的可信动作");
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "active") throw transitionConflict();
      if (job.execution.turn >= 128) {
        throw storeError("CODE_JOB_TURN_LIMIT", "代码任务已达到最大动作轮数", 409);
      }
      const changed = this.#updateJob(
        state,
        index,
        "active",
        (at) => ({
          ...job.execution,
          pendingAction: {
            turn: job.execution.turn + 1,
            actionId: action.actionId,
            actionDigest,
            action,
            ...(completionReport === undefined ? {} : { completionReport }),
            preparedAt: at,
          },
          actionAdmission: null,
        }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  admitAction(value) {
    const request = normalizeMutationBase(value, ["actionId", "actionDigest"]);
    const binding = normalizeActionBinding(value, request.error);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      const pending = job.execution.pendingAction;
      if (
        pending === null ||
        pending.actionId !== binding.actionId ||
        pending.actionDigest !== binding.actionDigest
      ) {
        throw transitionConflict("动作入场请求与待执行动作不匹配");
      }
      const existing = job.execution.actionAdmission;
      if (existing !== null) {
        if (
          existing.actionId !== binding.actionId ||
          existing.actionDigest !== binding.actionDigest
        ) {
          throw transitionConflict("待执行动作已绑定不同的入场凭据");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "active") throw transitionConflict();
      assertMemoryEventCapacity(state.memoryProjection);
      const epoch = state.revision + 1;
      const changed = this.#updateJob(
        state,
        index,
        "active",
        (at) => ({
          ...job.execution,
          actionAdmission: {
            actionId: binding.actionId,
            actionDigest: binding.actionDigest,
            epoch,
            admittedAt: at,
          },
        }),
      );
      return this.#appliedLifecycleChange(
        changed,
        ACTION_COMMIT_HEADROOM_BYTES,
      );
    });
  }

  acknowledgeAbsentAction(value) {
    const request = normalizeMutationBase(value, [
      "actionId",
      "actionDigest",
      "epoch",
    ]);
    const binding = normalizeActionBinding(value, request.error, {
      includeEpoch: true,
    });
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      const pending = job.execution.pendingAction;
      const admission = job.execution.actionAdmission;
      if (
        pending === null ||
        admission === null ||
        pending.actionId !== binding.actionId ||
        pending.actionDigest !== binding.actionDigest ||
        admission.actionId !== binding.actionId ||
        admission.actionDigest !== binding.actionDigest ||
        admission.epoch !== binding.epoch
      ) {
        throw transitionConflict("动作撤回请求与入场凭据不匹配");
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (
        !RECONCILABLE_STATUSES.has(job.status) &&
        job.status !== "pausing"
      ) {
        throw transitionConflict();
      }
      const recoveryStatus =
        job.status === "unknown" &&
        job.execution.uncertainty?.from === "active"
          ? "active"
          : "paused";
      const changed = this.#updateJob(
        state,
        index,
        recoveryStatus,
        () => ({
          ...job.execution,
          actionAdmission: null,
          uncertainty: null,
        }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  markActionUnknown(value) {
    const request = normalizeMutationBase(value, [
      "actionId",
      "actionDigest",
      "epoch",
      "code",
      "message",
    ]);
    const binding = normalizeActionBinding(value, request.error, {
      includeEpoch: true,
    });
    const code = normalizeFailureCode(value.code, request.error);
    const message = normalizeReason(value.message, request.error);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      const pending = job.execution.pendingAction;
      const admission = job.execution.actionAdmission;
      if (
        pending === null ||
        admission === null ||
        pending.actionId !== binding.actionId ||
        pending.actionDigest !== binding.actionDigest ||
        admission.actionId !== binding.actionId ||
        admission.actionDigest !== binding.actionDigest ||
        admission.epoch !== binding.epoch
      ) {
        throw transitionConflict("未知动作请求与入场凭据不匹配");
      }
      if (job.status === "unknown") {
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (!["active", "pausing"].includes(job.status)) {
        throw transitionConflict();
      }
      const changed = this.#updateJob(
        state,
        index,
        "unknown",
        (at) => ({
          ...job.execution,
          uncertainty: {
            from: job.status === "pausing" ? "pausing" : "active",
            code,
            message,
            at,
          },
        }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  recordObservation(value) {
    const hasActionDigest = Object.hasOwn(value, "actionDigest");
    const hasEpoch = Object.hasOwn(value, "epoch");
    if (hasActionDigest !== hasEpoch) {
      throw storeError("INVALID_CODE_JOB_MUTATION", "代码任务迁移请求无效");
    }
    const request = normalizeMutationBase(value, [
      "actionId",
      "status",
      "workspaceRevision",
      "detail",
      ...(hasActionDigest ? ["actionDigest", "epoch"] : []),
    ]);
    const actionId = normalizeSafeId(value.actionId, request.error);
    const reconciliationBinding = hasActionDigest
      ? normalizeActionBinding(value, request.error, { includeEpoch: true })
      : null;
    const status = value.status;
    if (!OBSERVATION_STATUSES.has(status)) throw request.error;
    const workspaceRevision = normalizeSha256(
      value.workspaceRevision,
      request.error,
    );
    const detail = createCodeJobDetail(value.detail);
    const detailDigest = digestValue(detail);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      const pending = job.execution.pendingAction;
      if (pending === null) {
        const observed = job.execution.observations.find(
          (entry) => entry.actionId === actionId,
        );
        if (
          observed !== undefined &&
          observed.status === status &&
          observed.workspaceRevision === workspaceRevision &&
          observed.detailDigest === detailDigest
        ) {
          return {
            state,
            value: workerMutationResult("already", job),
            write: false,
          };
        }
        throw transitionConflict("代码任务没有匹配的待执行动作");
      }
      if (pending.actionId !== actionId) {
        throw transitionConflict("动作结果与待执行动作不匹配");
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (!["active", "pausing", "unknown"].includes(job.status)) {
        throw transitionConflict();
      }
      if (job.execution.uncertainty !== null) {
        const admission = job.execution.actionAdmission;
        if (
          reconciliationBinding === null ||
          admission === null ||
          pending.actionDigest !== reconciliationBinding.actionDigest ||
          admission.actionId !== reconciliationBinding.actionId ||
          admission.actionDigest !== reconciliationBinding.actionDigest ||
          admission.epoch !== reconciliationBinding.epoch
        ) {
          throw transitionConflict("对账结果与未知动作入场凭据不匹配");
        }
      } else if (reconciliationBinding !== null) {
        throw transitionConflict("普通动作结果不能携带未知动作凭据");
      }
      const nextStatus =
        job.status === "active" ||
        (job.status === "unknown" &&
          job.execution.uncertainty?.from === "active")
          ? "active"
          : "paused";
      const changed = this.#updateJob(
        state,
        index,
        nextStatus,
        (at) => {
          const observedExecution = {
            ...job.execution,
            workspaceRevision,
            turn: pending.turn,
            pendingAction: null,
            actionAdmission: null,
            uncertainty: null,
            observations: [
              ...job.execution.observations,
              {
                turn: pending.turn,
                actionId,
                actionType: pending.action.type,
                actionDigest: pending.actionDigest,
                action: pending.action,
                ...(pending.completionReport === undefined ? {} : { completionReport: pending.completionReport }),
                status,
                workspaceRevision,
                detail,
                detailDigest,
                recordedAt: at,
              },
            ],
          };
          return observedExecution;
        },
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  recordTimeoutContinuation(value) {
    const request = normalizeMutationBase(value, ["failedRunId", "errorCode", "failedAt",
      "progressFingerprint", "baselineProgressFingerprint"]);
    const failedRunId = normalizeSafeId(value.failedRunId, request.error);
    const failedAt = normalizeCodeJobTimestamp(value.failedAt, request.error);
    const progressFingerprint = normalizeSha256(value.progressFingerprint, request.error);
    const baselineProgressFingerprint = normalizeSha256(value.baselineProgressFingerprint, request.error);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "active" || job.execution.pendingAction !== null ||
          job.execution.actionAdmission !== null || job.execution.uncertainty !== null ||
          job.execution.pause !== null || job.execution.sessionId !== job.jobId ||
          job.execution.workspaceRevision === null) throw transitionConflict();
      const previous = job.execution.timeoutContinuation;
      if (previous?.failedRunId === failedRunId) {
        if (previous.errorCode !== value.errorCode || previous.failedAt !== failedAt ||
            previous.progressFingerprint !== progressFingerprint) throw transitionConflict();
        return { state, value: workerMutationResult("already", job), write: false };
      }
      const madeProgress = progressFingerprint !== (previous?.progressFingerprint ?? baselineProgressFingerprint);
      const consecutiveNoProgress = madeProgress ? 0 : Math.min(3, (previous?.consecutiveNoProgress ?? 0) + 1);
      const exhausted = consecutiveNoProgress === 3;
      const changed = this.#updateJob(state, index, exhausted ? "paused" : "active", (at) => ({
        ...job.execution,
        timeoutContinuation: normalizeCodeJobTimeoutContinuation({ schemaVersion: 1, failedRunId,
          errorCode: value.errorCode, failedAt, recordedAt: at,
          retryAfter: new Date(Date.parse(at) + codeJobTimeoutContinuationDelayMs(consecutiveNoProgress)).toISOString(),
          progressFingerprint, consecutiveNoProgress }, request.error),
        ...(exhausted ? { pause: { from: "active", at,
          reason: `连续 ${consecutiveNoProgress} 次原生执行超时未获得新的源码、工作区变更或验证证据，已保留断点并暂停（${value.errorCode}）` } } : {}),
      }));
      return this.#appliedLifecycleChange(changed);
    });
  }

  pause(value) {
    const request = normalizeMutationBase(value, ["reason"]);
    const reason = normalizeReason(value.reason, request.error);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (["pausing", "unknown", "paused"].includes(job.status)) {
        if (job.status === "unknown") {
          if (job.execution.uncertainty?.from === "pausing") {
            if (job.execution.pause?.reason !== reason) {
              throw transitionConflict();
            }
            return {
              state,
              value: workerMutationResult("already", job),
              write: false,
            };
          }
          this.#assertJobRevision(job, request.expectedRevision);
          const changed = this.#updateJob(
            state,
            index,
            "unknown",
            (at) => ({
              ...job.execution,
              pause: { from: "active", reason, at },
              uncertainty: {
                ...job.execution.uncertainty,
                from: "pausing",
              },
            }),
          );
          return this.#appliedLifecycleChange(changed);
        }
        if (job.execution.pause.reason !== reason) throw transitionConflict();
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (!RESUMED_STATUSES.has(job.status)) throw transitionConflict();
      const nextStatus =
        job.status === "starting" ||
        (job.status === "active" && job.execution.actionAdmission !== null)
          ? "pausing"
          : "paused";
      const changed = this.#updateJob(
        state,
        index,
        nextStatus,
        (at) => ({
          ...job.execution,
          pause: { from: job.status, reason, at },
        }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  resume(value) {
    const request = normalizeMutationBase(value);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (
        RESUMED_STATUSES.has(job.status) &&
        job.revision > request.expectedRevision
      ) {
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status !== "paused") throw transitionConflict();
      const target = job.execution.pause.from;
      const changed = this.#updateJob(
        state,
        index,
        target,
        () => ({ ...job.execution, pause: null }),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  cancel(value) {
    const request = normalizeMutationBase(value, ["reason"]);
    const reason = normalizeReason(value.reason, request.error);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (["cancelling", "cancelled"].includes(job.status)) {
        if (job.execution.result?.detail?.reason !== reason) {
          throw transitionConflict("代码任务已绑定不同的取消原因");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      if (isTerminalCodeJobStatus(job.status)) {
        throw transitionConflict("代码任务已以不同结果结束");
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (!CANCELLABLE_STATUSES.has(job.status)) throw transitionConflict();
      const mustReconcile =
        job.execution.sessionId !== null;
      const changed = this.#updateJob(
        state,
        index,
        mustReconcile ? "cancelling" : "cancelled",
        (at) => {
          const execution = {
            ...job.execution,
            result: cancellationIntent(reason, job.status, at),
          };
          return mustReconcile ? execution : cancelledExecution(execution);
        },
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  finalizeCancellation(value) {
    const request = normalizeMutationBase(value, ["settlement"]);
    const settlement = normalizeCancellationSettlement(
      value.settlement,
      request.error,
    );
    const receipt = cancellationSettlementReceipt(settlement);
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      if (job.status === "cancelled") {
        if (
          job.execution.cancellationSettlement === null ||
          digestValue(job.execution.cancellationSettlement) !==
            digestValue(receipt)
        ) {
          throw transitionConflict("代码任务已绑定不同的取消结算证明");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (
        job.status !== "cancelling" ||
        settlement.sessionId !== job.jobId ||
        settlement.cancellationDigest !==
          job.execution.result?.detailDigest ||
        Date.parse(settlement.settledAt) <
          Date.parse(job.execution.result.recordedAt) ||
        ((settlement.sourceRevision === null) !==
          (settlement.trustedWorkspaceRevision === null))
      ) {
        throw transitionConflict();
      }
      const pending = job.execution.pendingAction;
      const admission = job.execution.actionAdmission;
      const resolution = settlement.actionResolution;
      if (
        settlement.kind === "controlled_execution_absent" &&
        (job.execution.workspaceRevision !== null ||
          pending !== null ||
          admission !== null ||
          settlement.sourceRevision !== null ||
          settlement.trustedWorkspaceRevision !== null ||
          resolution !== null)
      ) {
        throw transitionConflict("会话缺失证明与代码任务状态不匹配");
      }
      if (
        (pending === null) !== (resolution === null) ||
        (pending !== null &&
          (resolution.actionId !== pending.actionId ||
            resolution.actionDigest !== pending.actionDigest ||
            resolution.workspaceRevisionBefore !==
              pending.action.expectedWorkspaceRevision)) ||
        (admission === null &&
          resolution !== null &&
          resolution.disposition !== "absent") ||
        (admission !== null &&
          (pending === null ||
            admission.actionId !== pending.actionId ||
            admission.actionDigest !== pending.actionDigest))
      ) {
        throw transitionConflict("取消结算证明与待执行动作不匹配");
      }
      const currentRevision = job.execution.workspaceRevision;
      const resolvedRevision = resolution?.workspaceRevisionAfter ??
        resolution?.workspaceRevisionBefore ?? currentRevision;
      if (
        (currentRevision !== null &&
          resolution !== null &&
          resolution.workspaceRevisionBefore !== currentRevision) ||
        (currentRevision !== null &&
          settlement.trustedWorkspaceRevision !== resolvedRevision)
      ) {
        throw transitionConflict("取消结算证明与可信工作区版本不匹配");
      }
      const changed = this.#updateJob(
        state,
        index,
        "cancelled",
        () => cancelledExecution(
          job.execution,
          settlement.trustedWorkspaceRevision,
          receipt,
        ),
      );
      return this.#appliedLifecycleChange(changed);
    });
  }

  complete(value) {
    return this.#finish(value, "completed");
  }

  fail(value) {
    return this.#finish(value, "failed");
  }

  fence(value) {
    return this.#finish(value, "fenced");
  }

  readMemoryProjectionBatch(value = {}) {
    const { limit } = normalizeMemoryBatchOptions(value);
    return this.#query(() => cloneCodeJobValue({
      cursor: this.state.memoryProjection.cursor,
      highWatermark: this.state.memoryProjection.nextSequence - 1,
      items: this.state.memoryProjection.pending.slice(0, limit),
    }));
  }

  acknowledgeMemoryProjection(value) {
    const error = storeError(
      "INVALID_CODE_JOB_MUTATION",
      "代码任务记忆投影确认无效",
    );
    const request = normalizeMemoryAcknowledgement(value, error);
    return this.#mutate(async (state) => {
      const projection = state.memoryProjection;
      if (request.sequence <= projection.cursor) {
        if (
          request.sequence === projection.cursor &&
          sameValue(request, projection.lastAcknowledgement.receipt)
        ) {
          return {
            state,
            value: memoryAcknowledgementResult("already", projection),
            write: false,
          };
        }
        throw memoryOrderConflict();
      }
      if (request.sequence !== projection.cursor + 1) {
        throw memoryOrderConflict();
      }
      const event = projection.pending[0];
      if (event === undefined) throw memoryOrderConflict();
      const expected = acknowledgementForMemoryEvent(event);
      if (!sameValue(request, expected)) throw memoryBindingConflict();
      const record = normalizeMemoryRecord(memoryRecordForCodeJobEvent(event));
      await this.#verifyMemoryReceipt(record);
      const revision = state.revision + 1;
      const receiptState = await this.#bindTerminalMemoryReceipt(
        state,
        event,
        record,
        revision,
      );
      const nextProjection = {
        ...projection,
        revision,
        cursor: request.sequence,
        checkpointDigest: event.eventDigest,
        lastAcknowledgement: { event, receipt: request },
        pending: projection.pending.slice(1),
      };
      const nextState = {
        ...receiptState,
        revision,
        memoryProjection: nextProjection,
      };
      return {
        state: nextState,
        value: memoryAcknowledgementResult("applied", nextProjection),
        write: true,
        protectedSequences: new Set(),
        requiredHeadroomBytes: 0,
      };
    });
  }

  readChangePackageDeliveryBatch(value = {}) {
    const { limit } = normalizeMemoryBatchOptions(value);
    return this.#query(() => cloneCodeJobValue({
      cursor: this.state.changePackageDelivery.cursor,
      highWatermark: this.state.changePackageDelivery.nextSequence - 1,
      items: this.state.changePackageDelivery.pending.slice(0, limit),
    }));
  }

  acknowledgeChangePackageDelivery(value) {
    const error = storeError(
      "INVALID_CODE_JOB_MUTATION",
      "代码任务 change package 投递确认无效",
    );
    const request = normalizeChangePackageAcknowledgement(value, error);
    return this.#mutate(async (state) => {
      const delivery = state.changePackageDelivery;
      if (request.sequence <= delivery.cursor) {
        const previous = delivery.delivered[request.sequence - 1];
        if (
          previous &&
          sameValue(request, deliveredAcknowledgement(previous.receipt))
        ) {
          return {
            state,
            value: changePackageAcknowledgementResult("already", delivery),
            write: false,
          };
        }
        throw changePackageOrderConflict();
      }
      if (request.sequence !== delivery.cursor + 1) {
        throw changePackageOrderConflict();
      }
      const event = delivery.pending[0];
      if (!event) throw changePackageOrderConflict();
      if (!pendingChangePackageAcknowledgement(event, request)) {
        throw changePackageBindingConflict();
      }
      const job = state.jobs.find(({ jobId }) => jobId === event.job.id);
      if (!job || !changePackageEventMatchesJob(event, job)) {
        throw changePackageBindingConflict();
      }
      await this.#verifyChangePackageReceipt(event, request, job);
      const revision = state.revision + 1;
      const receipt = {
        ...request,
        deliveredAt: this.#now(state),
      };
      const nextDelivery = {
        ...delivery,
        revision,
        cursor: request.sequence,
        checkpointDigest: event.eventDigest,
        pending: delivery.pending.slice(1),
        delivered: [
          ...delivery.delivered,
          { previousDigest: event.previousDigest, receipt },
        ],
      };
      return {
        state: {
          ...state,
          revision,
          changePackageDelivery: nextDelivery,
        },
        value: changePackageAcknowledgementResult("applied", nextDelivery),
        write: true,
        protectedSequences: new Set(),
        requiredHeadroomBytes: 0,
      };
    });
  }

  markMemoryProjected(value) {
    const request = normalizeMutationBase(value, [
      "sourceRecordDigest",
      "memoryRecordId",
      "memoryRecordDigest",
    ]);
    const sourceRecordDigest = normalizeSha256(
      value.sourceRecordDigest,
      request.error,
    );
    const memoryRecordDigest = normalizeSha256(
      value.memoryRecordDigest,
      request.error,
    );
    const memoryRecordId = normalizeMemoryRecordId(
      value.memoryRecordId,
      memoryRecordDigest,
      request.error,
    );
    const verificationRequest = Object.freeze({
      recordId: memoryRecordId,
      contentDigest: memoryRecordDigest,
      source: Object.freeze({
        kind: "code_job",
        id: codeJobMemorySourceId(request.jobId, sourceRecordDigest),
      }),
    });
    const assertSameProjection = (existing) => {
      if (
        existing.sourceRecordDigest !== sourceRecordDigest ||
        existing.memoryRecordId !== memoryRecordId ||
        existing.memoryRecordDigest !== memoryRecordDigest
      ) {
        throw memoryBindingConflict();
      }
    };
    return this.#mutate(async (state) => {
      const index = state.jobs.findIndex(
        (candidate) => candidate.jobId === request.jobId,
      );
      if (index < 0) {
        const archived = await this.#readArchivedByJobId(state, request.jobId);
        if (archived === null) throw jobNotFound();
        assertSameProjection(archived.outcome.memoryProjection);
        return {
          state,
          value: cloneCodeJobValue({
            status: "already",
            archived: true,
            job: projectArchivedCodeJobForBrowser(archived),
          }),
          write: false,
        };
      }
      const job = state.jobs[index];
      const existing = job.execution.memoryProjection;
      if (existing !== null) {
        assertSameProjection(existing);
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (!isTerminalCodeJobStatus(job.status)) throw transitionConflict();
      if (job.recordDigest !== sourceRecordDigest) {
        throw memoryBindingConflict();
      }
      if (this.memoryReceiptVerifier === null) {
        throw memoryReceiptUnverified();
      }
      try {
        const verified = await this.memoryReceiptVerifier.verify(
          cloneCodeJobValue(verificationRequest),
        );
        normalizeVerifiedMemoryReceipt(verified, verificationRequest);
      } catch (error) {
        if (error?.code === "CODE_JOB_MEMORY_RECEIPT_UNVERIFIED") throw error;
        throw memoryReceiptUnverified(error);
      }
      const changed = this.#updateJob(
        state,
        index,
        job.status,
        (at) => ({
          ...job.execution,
          memoryProjection: {
            jobId: job.jobId,
            sourceRecordDigest,
            sourceRevision: job.revision,
            sourceUpdatedAt: job.updatedAt,
            memoryRecordId,
            memoryRecordDigest,
            projectedAt: at,
          },
        }),
      );
      return {
        ...this.#appliedLifecycleChange(changed, 0),
        protectedSequences: new Set(),
      };
    });
  }

  async readDeliveryEvidence(value) {
    const { jobId, signal } = normalizeDeliveryEvidenceReadOptions(value);
    this.#assertReady();
    checkAbort(signal);
    const state = this.state;
    const archiveManifestLookup = this.archiveManifestLookup;
    const live = state.jobs.find((candidate) => candidate.jobId === jobId);
    if (live !== undefined) {
      const projection = cloneCodeJobValue({
        job: projectCodeJobForBrowser(live),
        archived: false,
        changePackage: liveChangePackageProjection(state, jobId),
      });
      checkAbort(signal);
      return projection;
    }
    const archived = await this.#readArchivedByJobId(state, jobId, {
      signal,
      archiveManifestLookup,
    });
    checkAbort(signal);
    return archived === null
      ? null
      : cloneCodeJobValue({
          job: projectArchivedCodeJobForBrowser(archived),
          archived: true,
          changePackage: archivedChangePackageProjection(archived),
        });
  }

  get(value) {
    const jobId = normalizeJobId(value);
    return this.#query(async () => {
      const job = this.state.jobs.find((candidate) => candidate.jobId === jobId);
      if (job) return projectCodeJobForBrowser(job);
      const archived = await this.#readArchivedByJobId(this.state, jobId);
      return archived ? projectArchivedCodeJobForBrowser(archived) : null;
    });
  }

  getDetail(value) {
    const options = normalizeDetailOptions(value);
    return this.#query(async () => {
      const job = this.state.jobs.find(
        (candidate) => candidate.jobId === options.jobId,
      );
      if (job) {
        const offset = options.cursor?.offset ?? 0;
        if (
          options.cursor !== null &&
          (options.cursor.jobId !== job.jobId ||
            options.cursor.revision !== job.revision ||
            offset >= job.execution.observations.length)
        ) {
          throw detailCursorStale();
        }
        const end = Math.min(
          offset + options.limit,
          job.execution.observations.length,
        );
        return cloneCodeJobValue({
          job: projectCodeJobForBrowser(job),
          archived: false,
          historyAvailable: true,
          observations: job.execution.observations
            .slice(offset, end)
            .map(projectCodeJobObservationForBrowser),
          nextCursor: end < job.execution.observations.length
            ? createDetailCursor(job.jobId, job.revision, end)
            : null,
          terminalDetail: projectCodeJobTerminalDetailForBrowser(job),
          changePackage: liveChangePackageProjection(this.state, job.jobId),
        });
      }
      const archived = await this.#readArchivedByJobId(
        this.state,
        options.jobId,
      );
      if (archived === null) return null;
      if (options.cursor !== null) throw detailCursorStale();
      return cloneCodeJobValue({
        job: projectArchivedCodeJobForBrowser(archived),
        archived: true,
        historyAvailable: false,
        observations: [],
        nextCursor: null,
        terminalDetail: archived.outcome.completionReport === undefined ? null : projectCodeJobTerminalDetailForBrowser({
          status: archived.status, execution: { result: { detail: {
            schemaVersion: 1, outcome: archived.outcome.completionReport.outcome,
            completedActionId: archived.outcome.completionReport.actionId,
            workspaceRevision: archived.outcome.completionReport.workspaceRevision,
            evidence: archived.grant.evidence, completionReport: archived.outcome.completionReport,
          } } },
        }),
        changePackage: archivedChangePackageProjection(archived),
      });
    });
  }

  getForWorker(value) {
    const jobId = normalizeJobId(value);
    return this.#query(async () => {
      const job = this.state.jobs.find((candidate) => candidate.jobId === jobId);
      if (job) return cloneCodeJobValue(job);
      return null;
    });
  }

  listRunnable(value = {}) {
    const { limit, roleId, afterSequence } = normalizeRunnableOptions(value);
    return this.#query(() => {
      let continuationNow;
      return {
      revision: this.state.revision,
      items: rotateWorkerCandidates(
        this.state.jobs
          .filter(
            ({ status, grant, execution }) =>
              RUNNABLE_STATUSES.has(status) &&
              (status !== "active" || execution.timeoutContinuation === undefined ||
                Date.parse(execution.timeoutContinuation.retryAfter) <= (continuationNow ??= Date.parse(this.#now(this.state)))) &&
              (roleId === null || grant.requestedBy.roleId === roleId),
          )
          .sort((left, right) => left.sequence - right.sequence),
        afterSequence,
        limit,
      ).map(cloneCodeJobValue),
      };
    });
  }

  listPaused(value = {}) {
    const { limit, roleId, afterSequence } = normalizeRunnableOptions(value);
    return this.#query(() => ({
      revision: this.state.revision,
      items: rotateWorkerCandidates(
        this.state.jobs.filter(({ status, grant }) => status === "paused" &&
          (roleId === null || grant.requestedBy.roleId === roleId))
          .sort((left, right) => left.sequence - right.sequence), afterSequence, limit,
      ).map(cloneCodeJobValue),
    }));
  }

  listReconcilable(value = {}) {
    const { limit, roleId, afterSequence } = normalizeRunnableOptions(value);
    return this.#query(() => ({
      revision: this.state.revision,
      items: rotateWorkerCandidates(
        this.state.jobs
          .filter(
            ({ status, grant }) =>
              RECONCILABLE_STATUSES.has(status) &&
              (roleId === null || grant.requestedBy.roleId === roleId),
          )
          .sort((left, right) => left.sequence - right.sequence),
        afterSequence,
        limit,
      ).map(cloneCodeJobValue),
    }));
  }

  list(value = {}) {
    const { limit, cursor, status } = normalizeListOptions(value);
    return this.#query(() => {
      const ordered = this.state.jobs
        .filter((job) => status === null || job.status === status)
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            right.sequence - left.sequence,
        );
      const cursorIndex = cursor === null
        ? -1
        : ordered.findIndex((job) => job.jobId === cursor);
      if (cursor !== null && cursorIndex < 0) {
        throw storeError("INVALID_CODE_JOB_QUERY", "代码任务查询游标无效");
      }
      const start = cursorIndex + 1;
      const page = ordered.slice(start, start + limit);
      return {
        revision: this.state.revision,
        archive: {
          throughSequence: this.state.archive.throughSequence,
          jobCount: this.state.archive.jobCount,
          lastUpdatedAt: this.state.archive.lastUpdatedAt,
        },
        total: ordered.length,
        items: page.map(projectCodeJobForBrowser),
        nextCursor:
          start + page.length < ordered.length ? page.at(-1).jobId : null,
      };
    });
  }

  listNewest(value = {}) {
    return this.list(value);
  }

  compactTerminalPrefix(value) {
    const error = storeError(
      "INVALID_CODE_JOB_MUTATION",
      "代码任务归档请求无效",
    );
    assertExactKeys(
      value,
      [
        "compactionId",
        "expectedRevision",
        "targetThroughSequence",
        "preArchiveDigest",
      ],
      error,
    );
    const command = {
      compactionId: normalizeSafeId(value.compactionId, error),
      expectedRevision: safeInteger(
        value.expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        error,
      ),
      targetThroughSequence: safeInteger(
        value.targetThroughSequence,
        0,
        Number.MAX_SAFE_INTEGER,
        error,
      ),
      preArchiveDigest: value.preArchiveDigest === null
        ? null
        : normalizeSha256(value.preArchiveDigest, error),
    };
    const commandDigest = digestValue(command);
    return this.#mutate((state) => {
      if (state.lastCompaction?.commandDigest === commandDigest) {
        return {
          state,
          value: compactionResult("already", state.lastCompaction),
          write: false,
        };
      }
      if (state.revision !== command.expectedRevision) throw revisionConflict();
      if (state.archive.digest !== command.preArchiveDigest) {
        throw transitionConflict("代码任务归档前置摘要已变化");
      }
      if (command.targetThroughSequence < state.archive.throughSequence) {
        throw transitionConflict("代码任务归档目标已被越过");
      }
      if (command.targetThroughSequence === state.archive.throughSequence) {
        return {
          state,
          value: compactionResult("already", {
            ...command,
            postArchiveDigest: state.archive.digest,
            archived: 0,
            appliedRevision: state.revision,
            commandDigest,
          }),
          write: false,
        };
      }
      const compacted = archiveTerminalPrefix(
        { ...state, revision: state.revision + 1 },
        {
          all: true,
          targetThroughSequence: command.targetThroughSequence,
          limits: this.limits,
        },
      );
      if (
        compacted.archived === 0 ||
        compacted.state.archive.throughSequence !==
          command.targetThroughSequence
      ) {
        throw retentionBlocked();
      }
      const receipt = {
        ...command,
        postArchiveDigest: compacted.state.archive.digest,
        archived: compacted.archived,
        appliedRevision: compacted.state.revision,
        commandDigest,
      };
      const next = { ...compacted.state, lastCompaction: receipt };
      return {
        state: next,
        value: compactionResult("applied", receipt),
        write: true,
        requiredHeadroomBytes: 0,
        archivedEntries: compacted.archivedEntries,
      };
    });
  }

  #finish(value, terminalStatus) {
    const normalized = normalizeFinishRequest(value, terminalStatus);
    const { request, changePackageDelivery } = normalized;
    return this.#mutate((state) => {
      const { job, index } = this.#requireJob(state, request.jobId);
      const detail = createCodeJobDetail(value.result, terminalStatus === "completed" ? { completionGrant: job.grant } : undefined);
      const detailDigest = digestValue(detail);
      if (isTerminalCodeJobStatus(job.status)) {
        if (
          job.status !== terminalStatus ||
          job.execution.result.detailDigest !== detailDigest ||
          (terminalStatus === "completed" &&
            hasChangePackageDelivery(state, job.jobId) !==
              changePackageDelivery)
        ) {
          throw transitionConflict("代码任务已以不同结果结束");
        }
        return {
          state,
          value: workerMutationResult("already", job),
          write: false,
        };
      }
      this.#assertJobRevision(job, request.expectedRevision);
      if (job.status === "cancelling") {
        throw transitionConflict("正在取消的代码任务不能改写为其他终态");
      }
      if (job.execution.actionAdmission !== null) {
        throw transitionConflict("已入场动作完成对账前不能结束代码任务");
      }
      if (
        terminalStatus === "completed" &&
        (!["active", "paused"].includes(job.status) ||
          job.execution.pendingAction !== null ||
          job.execution.observations.at(-1)?.actionType !== "complete" ||
          job.execution.observations.at(-1)?.status !== "succeeded")
      ) {
        throw transitionConflict("代码任务尚未完成全部可信动作");
      }
      const changed = this.#updateJob(
        state,
        index,
        terminalStatus,
        (at) => ({
          ...job.execution,
          pendingAction: null,
          pause: null,
          uncertainty: null,
          result: {
            kind: terminalStatus,
            detail,
            detailDigest,
            recordedAt: at,
          },
        }),
      );
      const finalState = changePackageDelivery
        ? {
            ...changed.state,
            changePackageDelivery: appendChangePackageDelivery(
              changed.state.changePackageDelivery,
              changed.job,
              changed.state.revision,
            ),
          }
        : changed.state;
      return this.#appliedLifecycleChange({ ...changed, state: finalState });
    });
  }

  async #verifyMemoryReceipt(record) {
    if (this.memoryReceiptVerifier === null) {
      throw memoryReceiptUnverified();
    }
    const verificationRequest = Object.freeze({
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      source: Object.freeze(cloneCodeJobValue(record.source)),
    });
    try {
      const verified = await this.memoryReceiptVerifier.verify(
        cloneCodeJobValue(verificationRequest),
      );
      normalizeVerifiedMemoryReceipt(verified, verificationRequest);
    } catch (cause) {
      if (cause?.code === "CODE_JOB_MEMORY_RECEIPT_UNVERIFIED") throw cause;
      throw memoryReceiptUnverified(cause);
    }
  }

  async #verifyChangePackageReceipt(event, request, job) {
    if (this.changePackageReader === null) {
      throw changePackageReceiptUnverified();
    }
    let manifest;
    try {
      manifest = normalizeChangePackageManifest(
        await this.changePackageReader.get(request.packageId),
      );
    } catch (cause) {
      throw changePackageReceiptUnverified(cause);
    }
    const profileBindings = manifest.passedProfiles.map(
      ({ id, configDigest }) => ({ id, configDigest }),
    );
    if (
      manifest.packageId !== request.packageId ||
      manifest.packageDigest !== request.packageDigest ||
      !sameValue(manifest.job, event.job) ||
      !sameValue(manifest.proposal, event.proposal) ||
      !sameValue(manifest.grant, event.grant) ||
      manifest.workspace.id !== job.grant.workspaceId ||
      manifest.workspace.workspaceRevision !==
        event.exportRequest.expectedWorkspaceRevision ||
      !sameValue(profileBindings, job.grant.requiredProfiles) ||
      (request.noChanges === true && (hasChangePackageChanges(manifest) ||
        manifest.workspace.sourceRevision !== manifest.workspace.workspaceRevision || !isHeadRepairExecutionSource(event.executionSource)))
    ) {
      throw changePackageBindingConflict();
    }
  }

  async #bindTerminalMemoryReceipt(state, event, record, revision) {
    if (!TERMINAL_MEMORY_EVENT_KINDS.has(event.kind)) {
      return { ...state, revision };
    }
    const index = state.jobs.findIndex(({ jobId }) => jobId === event.jobId);
    if (index < 0) {
      const archived = await this.#readArchivedByJobId(state, event.jobId);
      if (
        archived === null ||
        archived.status !== event.kind ||
        archived.outcome.memoryProjection.sourceRecordDigest !==
          event.sourceRecordDigest
      ) {
        throw memoryBindingConflict();
      }
      return { ...state, revision };
    }
    const job = state.jobs[index];
    if (job.status !== event.kind) throw memoryBindingConflict();
    const existing = job.execution.memoryProjection;
    if (existing !== null) {
      if (existing.sourceRecordDigest !== event.sourceRecordDigest) {
        throw memoryBindingConflict();
      }
      return { ...state, revision };
    }
    if (
      job.revision !== event.jobRevision ||
      job.updatedAt !== event.occurredAt ||
      job.recordDigest !== event.sourceRecordDigest
    ) {
      throw memoryBindingConflict();
    }
    return this.#updateJob(
      state,
      index,
      job.status,
      (projectedAt) => ({
        ...job.execution,
        memoryProjection: {
          jobId: job.jobId,
          sourceRecordDigest: event.sourceRecordDigest,
          sourceRevision: event.jobRevision,
          sourceUpdatedAt: event.occurredAt,
          memoryRecordId: record.recordId,
          memoryRecordDigest: record.contentDigest,
          projectedAt,
        },
      }),
    ).state;
  }

  #requireJob(state, jobId) {
    const index = state.jobs.findIndex((candidate) => candidate.jobId === jobId);
    if (index < 0) throw jobNotFound();
    return { job: state.jobs[index], index };
  }

  #assertJobRevision(job, expectedRevision) {
    if (job.revision !== expectedRevision) throw revisionConflict();
  }

  #updateJob(state, index, status, executionFactory) {
    const revision = state.revision + 1;
    const updatedAt = this.#now(state);
    const current = state.jobs[index];
    const job = updateCodeJobLifecycle(current, {
      status,
      revision,
      updatedAt,
      execution: executionFactory(updatedAt),
    });
    const jobs = [...state.jobs];
    jobs[index] = job;
    const kind = classifyCodeJobMemoryEvent(current, job);
    return {
      state: {
        ...state,
        revision,
        memoryProjection: appendMemoryEvent(
          state.memoryProjection,
          job,
          kind,
          revision,
        ),
        jobs,
      },
      job,
    };
  }

  #appliedLifecycleChange(
    { state, job },
    requiredHeadroomBytes = TERMINAL_HEADROOM_BYTES,
  ) {
    return {
      state,
      value: workerMutationResult("applied", job),
      write: true,
      protectedSequences: isStateRetentionEligible(state, job)
        ? new Set()
        : new Set([job.sequence]),
      requiredHeadroomBytes,
    };
  }

  async #findArchivedBinding(state, request) {
    const bindings = archiveBindingValuesFromRequest(request);
    let found = null;
    for (const kind of ARCHIVE_BINDING_KINDS) {
      const tombstone = await this.#readArchivedIndex(
        state,
        kind,
        bindings[kind],
      );
      if (tombstone === null) continue;
      if (found !== null && found.jobId !== tombstone.jobId) {
        throw bindingConflict();
      }
      found = tombstone;
    }
    return found;
  }

  async #readArchivedByJobId(state, jobId, options = {}) {
    return this.#readArchivedIndex(state, "job", jobId, options);
  }

  async #validateArchiveArtifacts(state) {
    const tombstonesByJobId = new Map();
    const deliveredByJobId = new Map(
      state.changePackageDelivery.delivered.map((entry) => [
        entry.receipt.jobId,
        entry,
      ]),
    );
    for (const manifest of state.archiveIndex) {
      const rawTombstone = await this.store.read(
        archiveRecordKey(manifest.jobId),
        null,
      );
      if (rawTombstone === null) throw corruptedArchive();
      const tombstone = normalizeArchiveTombstone(rawTombstone);
      tombstonesByJobId.set(tombstone.jobId, tombstone);
      if (tombstone.schemaVersion >= 2) {
        const archivedDelivery = tombstone.outcome.changePackageDelivery;
        const delivered = deliveredByJobId.get(tombstone.jobId) ?? null;
        if (!sameValue(archivedDelivery, delivered)) {
          throw corruptedArchive();
        }
      }
      const bindings = assertTombstoneMatchesManifest(tombstone, manifest);
      for (const kind of ARCHIVE_BINDING_KINDS) {
        const rawIndex = await this.store.read(
          archiveIndexKey(kind, bindings[kind]),
          null,
        );
        if (rawIndex === null) throw corruptedArchive();
        const index = normalizeArchiveIndex(rawIndex, kind, bindings[kind]);
        if (
          index.jobId !== tombstone.jobId ||
          index.tombstoneDigest !== tombstone.tombstoneDigest
        ) {
          throw corruptedArchive();
        }
      }
    }
    const liveJobIds = new Set(state.jobs.map(({ jobId }) => jobId));
    for (const entry of state.changePackageDelivery.delivered) {
      if (liveJobIds.has(entry.receipt.jobId)) continue;
      const tombstone = tombstonesByJobId.get(entry.receipt.jobId);
      if (
        tombstone === undefined ||
        !sameValue(entry, tombstone.outcome.changePackageDelivery)
      ) {
        throw corruptedArchive();
      }
    }
  }

  async #readArchivedIndex(
    state,
    kind,
    bindingValue,
    { signal = null, archiveManifestLookup = this.archiveManifestLookup } = {},
  ) {
    try {
      checkAbort(signal);
      const bindingDigest = archiveBindingDigest(kind, bindingValue);
      const manifest = archiveManifestLookup[kind].get(bindingDigest);
      if (manifest === undefined) return null;
      const rawIndex = await readStoreValue(
        this.store,
        archiveIndexKey(kind, bindingValue),
        null,
        signal,
      );
      if (rawIndex === null) throw corruptedArchive();
      const index = normalizeArchiveIndex(rawIndex, kind, bindingValue);
      const rawTombstone = await readStoreValue(
        this.store,
        archiveRecordKey(index.jobId),
        null,
        signal,
      );
      if (rawTombstone === null) throw corruptedArchive();
      const tombstone = normalizeArchiveTombstone(rawTombstone);
      const actualBindings = assertTombstoneMatchesManifest(
        tombstone,
        manifest,
      );
      if (
        tombstone.tombstoneDigest !== index.tombstoneDigest ||
        tombstone.jobId !== index.jobId ||
        actualBindings[kind] !== bindingValue
      ) {
        throw corruptedArchive();
      }
      checkAbort(signal);
      return tombstone;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === "CODE_JOB_ARCHIVE_CORRUPTED") {
        this.ready = false;
        throw error;
      }
      const wrapped = corruptedArchive(error);
      this.ready = false;
      throw wrapped;
    }
  }

  async #persistArchiveEntries(entries) {
    for (const entry of entries) {
      const { tombstone, indexes } = entry;
      await this.#writeImmutableArchive(
        archiveRecordKey(tombstone.jobId),
        tombstone,
      );
      const bindings = archiveBindingValuesFromTombstone(tombstone);
      for (const kind of ARCHIVE_BINDING_KINDS) {
        await this.#writeImmutableArchive(
          archiveIndexKey(kind, bindings[kind]),
          indexes[kind],
        );
      }
    }
  }

  async #writeImmutableArchive(key, value) {
    const existing = await this.store.read(key, null);
    if (existing !== null) {
      try {
        if (digestValue(existing) === digestValue(value)) return;
      } catch (cause) {
        throw corruptedArchive(cause);
      }
      throw corruptedArchive();
    }
    await this.store.write(key, value);
  }

  #query(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return operation();
    });
  }

  #mutate(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return this.exclusiveLease.run(async () => {
        const durable = await this.#readDurableState();
        const change = await operation(durable);
        if (!change.write) return change.value;
        const fitted = this.#fitState(
          change.state,
          change.protectedSequences ?? new Set(),
          change.requiredHeadroomBytes ?? TERMINAL_HEADROOM_BYTES,
        );
        const candidate = normalizeState(fitted.state, this.limits, this.#validationCache);
        const archivedEntries = [
          ...(change.archivedEntries ?? []),
          ...fitted.archivedEntries,
        ];
        let writtenVersion;
        try {
          await this.#persistArchiveEntries(archivedEntries);
          writtenVersion = await this.store.write(CODE_JOB_STATE_KEY, candidate);
        } catch (writeError) {
          this.#durableSnapshot = null;
          await this.#reconcileFailedWrite(writeError);
          throw writeError;
        }
        this.#acceptDurableState(candidate);
        this.#durableSnapshot = typeof this.store.readVersioned === "function" && isContentVersion(writtenVersion)
          ? { version: writtenVersion, state: candidate } : null;
        return change.value;
      });
    });
  }

  async #readDurableState({ recovering = false } = {}) {
    try {
      let stored, version;
      if (typeof this.store.readVersioned === "function") {
        // StateStore versions bind exact committed bytes, including existence.
        // Replacing the public state reference also invalidates this pairing.
        const snapshot = this.#durableSnapshot?.state === this.state ? this.#durableSnapshot : null;
        const result = normalizeVersionedRead(await this.store.readVersioned(CODE_JOB_STATE_KEY, defaultState(), {
          ifVersion: snapshot?.version,
        }), snapshot?.version);
        if (!result.changed) {
          if (recovering) await this.#validateArchiveArtifacts(snapshot.state);
          return snapshot.state;
        }
        stored = result.value;
        version = result.version;
      } else stored = await this.store.read(CODE_JOB_STATE_KEY, defaultState());
      const durable = normalizeState(
        stored, this.limits, this.#validationCache,
      );
      if (recovering) await this.#validateArchiveArtifacts(durable);
      this.#acceptDurableState(durable);
      this.#durableSnapshot = version === undefined ? null : { version, state: durable };
      return durable;
    } catch (error) {
      this.#durableSnapshot = null;
      this.ready = false;
      throw error;
    }
  }

  async #reconcileFailedWrite(writeError) {
    try {
      await this.#readDurableState();
    } catch (recoveryError) {
      this.ready = false;
      throw uncertainState(writeError, recoveryError);
    }
  }

  #acceptDurableState(durable) {
    if (durable.revision < this.state.revision) {
      throw storeError(
        "CODE_JOB_STATE_ROLLBACK",
        "代码任务持久化状态发生回退",
        500,
      );
    }
    if (durable.revision === this.state.revision && !sameValue(durable, this.state)) {
      throw storeError(
        "CODE_JOB_STATE_FORKED",
        "代码任务持久化状态发生分叉",
        500,
      );
    }
    if (
      durable.archive.throughSequence < this.state.archive.throughSequence ||
      durable.nextJobSequence < this.state.nextJobSequence ||
      (durable.archive.throughSequence === this.state.archive.throughSequence &&
        durable.archive.digest !== this.state.archive.digest)
    ) {
      throw storeError(
        "CODE_JOB_ARCHIVE_FORKED",
        "代码任务归档链发生回退或分叉",
        500,
      );
    }
    assertMemoryProjectionExtension(
      this.state.memoryProjection,
      durable.memoryProjection,
    );
    assertChangePackageDeliveryExtension(
      this.state.changePackageDelivery,
      durable.changePackageDelivery,
    );
    for (let index = 0; index < this.state.archiveIndex.length; index += 1) {
      if (!sameValue(this.state.archiveIndex[index], durable.archiveIndex[index])) {
        throw storeError(
          "CODE_JOB_ARCHIVE_FORKED",
          "代码任务归档清单发生分叉",
          500,
        );
      }
    }
    for (const manifest of durable.archiveIndex.slice(
      this.state.archiveIndex.length,
    )) {
      if (manifest.sequence >= this.state.nextJobSequence) break;
      const current = this.state.jobs.find(
        (job) => job.sequence === manifest.sequence,
      );
      if (current === undefined || current.recordDigest !== manifest.recordDigest) {
        throw storeError(
          "CODE_JOB_ARCHIVE_FORKED",
          "代码任务归档记录无法衔接",
          500,
        );
      }
    }
    this.state = this.#validationCache.freeze(durable);
    this.archiveManifestLookup = createArchiveManifestLookup(durable);
  }

  #fitState(state, protectedSequences, requiredHeadroomBytes) {
    let candidate = state;
    const archivedEntries = [];
    while (
      stateExceedsLimits(candidate, this.limits, requiredHeadroomBytes)
    ) {
      const compacted = archiveTerminalPrefix(candidate, {
        protectedSequences,
        limits: this.limits,
      });
      if (compacted.archived === 0) {
        if (retainedHistoryBudgetAllows(candidate, this.limits, requiredHeadroomBytes, this.#validationCache)) break;
        if (stateExceedsLimits(candidate, this.limits, 0)) {
          throw capacityExceeded();
        }
        throw retentionBlocked();
      }
      candidate = compacted.state;
      archivedEntries.push(...compacted.archivedEntries);
    }
    return { state: candidate, archivedEntries };
  }

  #assertReady() {
    if (!this.ready) {
      throw storeError(
        "CODE_JOB_STORE_NOT_READY",
        "代码任务存储尚未完成恢复",
        503,
      );
    }
  }

  #now(state) {
    const error = storeError("CODE_JOB_CLOCK_INVALID", "代码任务时钟无效", 500);
    const now = normalizeCodeJobTimestamp(this.clock(), error);
    const latest = state.jobs.reduce(
      (maximum, job) =>
        Date.parse(job.updatedAt) > Date.parse(maximum) ? job.updatedAt : maximum,
      state.archive.lastUpdatedAt ?? "1970-01-01T00:00:00.000Z",
    );
    if (Date.parse(now) < Date.parse(latest)) throw error;
    return now;
  }
}
