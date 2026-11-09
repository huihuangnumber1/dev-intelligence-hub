import {
  cloneConfirmationValue,
  ConfirmationQueueError,
  defaultConfirmationState,
  normalizeConfirmationInvalidation,
  normalizeConfirmationPlan,
  normalizeConfirmationReceipt,
  normalizeConfirmationRequest,
  normalizeConfirmationState,
} from "../domain/confirmation-contract.js";
import {
  normalizeChangePackageApplicationEnvelope,
} from "../domain/change-package-application-confirmation.js";
import {
  isGitHubCredentialRecoveryActivationPlan,
} from "../domain/configuration-activation-confirmation.js";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  normalizeExternalDeferredOptions,
} from "../domain/attention-deferred-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { createReviewHandoff, normalizeReviewHandoff, reviewHandoffWorkRequest } from "../domain/review-handoff.js";
import { isAutomaticReviewExecution, automaticReviewAssignmentSupersedes } from "../domain/automatic-review-policy.js";

export const CONFIRMATION_QUEUE_STATE_KEY = "confirmation-queue";
const STATE_KEY = CONFIRMATION_QUEUE_STATE_KEY;
const MAX_ITEMS = 1_000;
const APPLICATION_RESULT_KIND = "local.change-package-apply";
const CONFIGURATION_ACTIVATION_KIND = "local.configuration-activate";
const APPLICATION_SNAPSHOT_REQUEST_ID = "application-snapshot-read";
const CONFIRMATION_MEMORY_PAGE_LIMIT = 100;
const PULL_REQUEST_MEMORY_KINDS = new Set([
  "github.pull-request-comment",
  "github.pull-request-review",
  "github.work-proposal-review",
  "github.pull-request-update-branch",
  "github.pull-request-push",
  "github.pull-request-merge",
]);
const ACTION_SELECTOR = /^[a-z][a-z0-9._-]{0,127}$/;
const HISTORY_ROLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const HISTORY_CURSOR = /^[A-Za-z0-9_-]{16,512}$/;
const HISTORY_ITEM_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const HISTORY_CURSOR_DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_HISTORY_LIMIT = 25;
export const CONFIRMATION_HISTORY_MAX_LIMIT = 50;
export const CONFIRMATION_HISTORY_MAX_ROLE_FACETS = 64;
export const CONFIRMATION_HISTORY_STATUSES = Object.freeze([
  "completed",
  "failed",
  "stale",
  "rejected",
]);
export const CONFIRMATION_HISTORY_KINDS = Object.freeze([
  "github.pull-request-review",
  "github.work-proposal-review",
  "github.pull-request-comment",
  "github.pull-request-update-branch",
  "github.pull-request-push",
  "github.pull-request-merge",
  "local.code-job-create",
  "local.change-package-apply",
  "local.configuration-activate",
]);
const HISTORY_STATUS_SET = new Set(CONFIRMATION_HISTORY_STATUSES);
const HISTORY_KIND_SET = new Set(CONFIRMATION_HISTORY_KINDS);

export class ConfirmationExecutionError extends Error {
  constructor(code, outcome, { cause } = {}) {
    super(
      outcome === "absent"
        ? "外部动作已确认未发生"
        : "外部动作结果无法确认",
      cause === undefined ? undefined : { cause },
    );
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
      throw new TypeError("Confirmation execution error code is invalid");
    }
    if (!new Set(["absent", "unknown"]).has(outcome)) {
      throw new TypeError("Confirmation execution outcome is invalid");
    }
    this.name = "ConfirmationExecutionError";
    this.code = code;
    this.outcome = outcome;
  }
}

function queueError(code, message, statusCode) {
  return new ConfirmationQueueError(code, message, statusCode);
}

function clone(value) {
  return cloneConfirmationValue(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReceipt(value) {
  try {
    return normalizeConfirmationReceipt(value);
  } catch (error) {
    throw new ConfirmationExecutionError(
      "EXTERNAL_PROTOCOL_ERROR",
      "unknown",
      { cause: error },
    );
  }
}

function normalizeExecutorResult(value) {
  if (!isObject(value) || typeof value.status !== "string") {
    return { status: "unknown", code: "EXTERNAL_PROTOCOL_ERROR" };
  }
  if (value.status === "applied" || value.status === "already") {
    try {
      return {
        status: value.status,
        receipt: normalizeReceipt(value.receipt),
      };
    } catch (error) {
      return { status: "unknown", code: error.code };
    }
  }
  if (value.status === "stale") return { status: "stale" };
  if (value.status === "absent") {
    return {
      status: "absent",
      code:
        typeof value.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)
          ? value.code
          : "EXTERNAL_ACTION_ABSENT",
    };
  }
  if (value.status === "error") {
    const outcome = value.error?.trust === "absent" ? "absent" : "unknown";
    const code =
      typeof value.error?.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(value.error.code)
        ? value.error.code
        : "EXTERNAL_OUTCOME_UNKNOWN";
    return { status: outcome, code };
  }
  return { status: "unknown", code: "EXTERNAL_PROTOCOL_ERROR" };
}

function errorOutcome(error) {
  if (error instanceof ConfirmationExecutionError) {
    return { status: error.outcome, code: error.code };
  }
  return { status: "unknown", code: "EXTERNAL_OUTCOME_UNKNOWN" };
}

function byCreation(left, right) {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function byNewestCreation(left, right) {
  return byCreation(right, left);
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isProjectableHistoryItem(item) {
  return HISTORY_STATUS_SET.has(item.status) && HISTORY_KIND_SET.has(item.kind);
}

function requiresRecovery(item) {
  return item.status === "executing" ||
    (item.status === "failed" && item.failure?.outcome === "unknown");
}

function blocksAutomaticReview(previous, item, assignmentProof) {
  if (previous.id === item.id || previous.action.type !== "pull_request_review" ||
      previous.actor.accountId.toLowerCase() !== item.actor.accountId.toLowerCase() ||
      previous.target.resourceId.toLowerCase() !== item.target.resourceId.toLowerCase() ||
      previous.target.version !== item.target.version) return false;
  return previous.failure?.outcome === "unknown" || previous.status === "executing" ||
    (previous.status === "completed" && !automaticReviewAssignmentSupersedes(previous, item, assignmentProof) && (isAutomaticReviewExecution(previous) ||
      ["APPROVE", "REQUEST_CHANGES"].includes(previous.action.reviewEvent)));
}

function permitsGitHubCredentialRecoveryActivation(item, items) {
  const unresolved = items.filter(
    (candidate) => candidate.id !== item.id && requiresRecovery(candidate),
  );
  return unresolved.length > 0 &&
    unresolved.every((candidate) =>
      PULL_REQUEST_MEMORY_KINDS.has(candidate.kind)) &&
    isGitHubCredentialRecoveryActivationPlan(item);
}

function historyRoleIdFacets(items) {
  return [...new Set(items.map((item) => item.requestedBy.roleId))]
    .sort(compareAscii)
    .slice(0, CONFIRMATION_HISTORY_MAX_ROLE_FACETS);
}

function normalizeActionSelector(kind, actionType) {
  if (
    typeof kind !== "string" ||
    typeof actionType !== "string" ||
    !ACTION_SELECTOR.test(kind) ||
    !ACTION_SELECTOR.test(actionType)
  ) {
    throw queueError(
      "INVALID_CONFIRMATION_ACTION_QUERY",
      "确认动作筛选条件无效",
      400,
    );
  }
  return { kind, actionType };
}

function exactDataFields(value, expected, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw error;
  }
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    fields.set(key, descriptor.value);
  }
  return fields;
}

function optionalDataFields(value, allowed, error) {
  if (value === undefined) return new Map();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    )
  ) {
    throw error;
  }
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    fields.set(key, descriptor.value);
  }
  return fields;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function historyFilterDigest(filters) {
  return digestValue({
    status: filters.status ?? null,
    kind: filters.kind ?? null,
    roleId: filters.roleId ?? null,
    ...(filters.automatic === true ? { automatic: true } : {}),
  });
}

function historyCursorError() {
  return queueError(
    "INVALID_CONFIRMATION_HISTORY_CURSOR",
    "确认历史游标无效",
    400,
  );
}

function encodeHistoryCursor(item, filters) {
  return Buffer.from(
    [item.createdAt, item.id, historyFilterDigest(filters)].join("\u0000"),
    "utf8",
  ).toString("base64url");
}

function decodeHistoryCursor(value, filters) {
  if (typeof value !== "string" || !HISTORY_CURSOR.test(value)) {
    throw historyCursorError();
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw historyCursorError();
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
    throw historyCursorError();
  }
  const parts = decoded.split("\u0000");
  if (
    parts.length !== 3 ||
    !canonicalTimestamp(parts[0]) ||
    !HISTORY_ITEM_ID.test(parts[1]) ||
    !HISTORY_CURSOR_DIGEST.test(parts[2]) ||
    parts[2] !== historyFilterDigest(filters)
  ) {
    throw historyCursorError();
  }
  return { createdAt: parts[0], id: parts[1] };
}

function normalizeHistoryQuery(value) {
  const error = queueError(
    "INVALID_CONFIRMATION_HISTORY_QUERY",
    "确认历史筛选条件无效",
    400,
  );
  const fields = optionalDataFields(
    value,
    ["status", "kind", "roleId", "limit", "cursor", "automatic"],
    error,
  );
  const filters = {};
  if (fields.has("automatic")) {
    if (fields.get("automatic") !== true) throw error;
    filters.automatic = true;
  }
  if (fields.has("status")) {
    const status = fields.get("status");
    if (!HISTORY_STATUS_SET.has(status)) throw error;
    filters.status = status;
  }
  if (fields.has("kind")) {
    const kind = fields.get("kind");
    if (!HISTORY_KIND_SET.has(kind)) throw error;
    filters.kind = kind;
  }
  if (fields.has("roleId")) {
    const roleId = fields.get("roleId");
    if (typeof roleId !== "string" || !HISTORY_ROLE_ID.test(roleId)) {
      throw error;
    }
    filters.roleId = roleId;
  }
  const limit = fields.has("limit")
    ? fields.get("limit")
    : DEFAULT_HISTORY_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONFIRMATION_HISTORY_MAX_LIMIT
  ) {
    throw error;
  }
  const cursor = fields.has("cursor")
    ? decodeHistoryCursor(fields.get("cursor"), filters)
    : null;
  return { filters, limit, cursor };
}

function projectHistoryItem(item) {
  const ownerDecision = projectOwnerDecision(item);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    requestedBy: {
      roleId: item.requestedBy.roleId,
      workItemId: item.requestedBy.workItemId,
    },
    title: item.display.title,
    summary: item.display.summary,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    retryable: Boolean(item.failure?.retryable),
    ...(isAutomaticReviewExecution(item) ? { automaticReview: {
      event: item.action.reviewEvent, headRefOid: item.target.version,
      resourceId: item.target.resourceId, publishedUrl: item.receipt?.url || null,
    } } : {}),
    ...(/^auto-own-pr-repair-v1-[a-f0-9]{48}$/.test(item.execution?.requestId || "")
      ? { automaticOwnPrRepair: { stage: item.kind === "github.pull-request-push" ? "push" : "code_task" } } : {}),
    ...(item.reviewHandoff ? { reviewHandoff: clone(item.reviewHandoff) } : {}),
    ...(item.failure ? { diagnosticCode: item.failure.code } : {}),
    ...(ownerDecision === null ? {} : { ownerDecision }),
  };
}

function projectOwnerDecision(item) {
  if (
    item.status !== "rejected" ||
    item.execution?.outcome !== "unknown" ||
    item.failure?.outcome !== "unknown"
  ) {
    return null;
  }
  return {
    type: "seal_unknown_and_forbid_replay",
    at: item.rejection.at,
  };
}

function normalizeSnapshotRequest(value) {
  const error = queueError(
    "INVALID_APPLICATION_RESULT_SNAPSHOT_REQUEST",
    "变更包应用结果快照请求无效",
    400,
  );
  const fields = exactDataFields(value, ["afterRevision"], error);
  const afterRevision = fields.get("afterRevision");
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw error;
  return { afterRevision };
}

function normalizeMemoryPageRequest(value) {
  const error = queueError(
    "INVALID_CONFIRMATION_MEMORY_QUERY",
    "确认记忆投影查询无效",
    400,
  );
  const fields = exactDataFields(
    value,
    ["cursor", "limit", "highWatermark"],
    error,
  );
  const cursor = fields.get("cursor");
  const limit = fields.get("limit");
  const highWatermark = fields.get("highWatermark");
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CONFIRMATION_MEMORY_PAGE_LIMIT ||
    !(
      highWatermark === null ||
      (Number.isSafeInteger(highWatermark) && highWatermark >= 0)
    )
  ) {
    throw error;
  }
  return { cursor, limit, highWatermark };
}

function memoryAction(action) {
  const result = {
    type: action.type,
    inputBinding: clone(action.inputBinding),
  };
  if (["pull_request_comment", "pull_request_review"].includes(action.type)) {
    result.bodyDigest = digestValue(action.body);
    result.bodyBytes = Buffer.byteLength(action.body, "utf8");
  }
  if (action.type === "pull_request_review") {
    result.reviewEvent = action.reviewEvent;
  } else if (action.type === "pull_request_update_branch") {
    result.expectedHeadOid = action.expectedHeadOid;
    result.expectedBaseOid = action.expectedBaseOid;
  } else if (action.type === "pull_request_push") {
    const controlled = action.controlledCommitEvidence;
    result.expectedOldOid = action.expectedOldOid;
    result.remote = clone(action.remote);
    result.controlledCommit = {
      evidenceId: controlled.evidenceId,
      evidenceDigest: controlled.evidenceDigest,
      commit: {
        oid: controlled.commit.oid,
        treeOid: controlled.commit.treeOid,
        parents: [...controlled.commit.parents],
      },
    };
  } else if (action.type === "pull_request_merge") {
    result.method = action.method;
    result.expectedHeadOid = action.expectedHeadOid;
  }
  return result;
}

function projectConfirmationMemoryItem(item) {
  const result = {
    confirmationId: item.id,
    itemRevision: item.itemRevision,
    statusDigest: digestValue({
      confirmationId: item.id,
      itemRevision: item.itemRevision,
      status: item.status,
      approvalBindingDigest: item.approvalBindingDigest,
      updatedAt: item.updatedAt,
    }),
    kind: item.kind,
    status: item.status,
    requestedBy: clone(item.requestedBy),
    actor: clone(item.actor),
    target: clone(item.target),
    action: memoryAction(item.action),
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    execution: item.execution === null
      ? null
      : {
          attempt: item.execution.attempt,
          startedAt: item.execution.startedAt,
          outcome: item.execution.outcome,
        },
    receipt: item.receipt === null ? null : { id: item.receipt.id },
    failure: item.failure === null ? null : clone(item.failure),
    rejectedAt: item.rejection?.at ?? null,
    ownerDecision: projectOwnerDecision(item),
    invalidation: item.invalidation === null
      ? null
      : { reason: item.invalidation.reason, at: item.invalidation.at },
  };
  return result;
}

function isProjectablePullRequestMemoryItem(item) {
  return PULL_REQUEST_MEMORY_KINDS.has(item.kind) &&
    item.action?.inputBinding?.schemaVersion === 2;
}

export function projectConfirmationMemoryState(value) {
  return projectNormalizedConfirmationMemoryState(normalizeConfirmationState(value));
}

function projectNormalizedConfirmationMemoryState(state) {
  return structuredClone({
    highWatermark: state.revision,
    items: state.items
      .filter(isProjectablePullRequestMemoryItem)
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map(projectConfirmationMemoryItem),
  });
}

function applicationResultSourceCorrupted() {
  return queueError(
    "APPLICATION_RESULT_SOURCE_CORRUPTED",
    "变更包应用结果来源无效",
    500,
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function applicationEnvelope(item) {
  const execution = item.execution
    ? {
        requestId: item.execution.requestId,
        attempt: item.execution.attempt,
        startedAt: item.execution.startedAt,
      }
    : {
        requestId: APPLICATION_SNAPSHOT_REQUEST_ID,
        attempt: 1,
        startedAt: item.createdAt,
      };
  try {
    return normalizeChangePackageApplicationEnvelope({
      schemaVersion: 1,
      id: item.id,
      idempotencyKey: `confirmation-${item.approvalBindingDigest}`,
      kind: item.kind,
      requestedBy: item.requestedBy,
      actor: item.actor,
      target: item.target,
      action: item.action,
      displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest,
      execution,
    });
  } catch {
    throw applicationResultSourceCorrupted();
  }
}

function applicationReceipt(item, envelope) {
  if (item.receipt === null) return null;
  const error = applicationResultSourceCorrupted();
  const fields = exactDataFields(item.receipt, ["id", "createdAt"], error);
  const expectedId = `change-package-application-${digestValue({
    confirmationId: envelope.id,
    approvalBindingDigest: envelope.approvalBindingDigest,
  })}`;
  if (
    fields.get("id") !== expectedId ||
    typeof fields.get("createdAt") !== "string"
  ) {
    throw error;
  }
  return { id: expectedId, createdAt: fields.get("createdAt") };
}

function projectApplicationResult(item) {
  const envelope = applicationEnvelope(item);
  return {
    confirmationId: envelope.id,
    approvalBindingDigest: envelope.approvalBindingDigest,
    requestedBy: { ...envelope.requestedBy },
    job: { ...envelope.action.job },
    packageId: envelope.action.packageId,
    packageDigest: envelope.action.packageDigest,
    workspaceId: envelope.action.workspace.id,
    itemRevision: item.itemRevision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    queueStatus: item.status,
    executionOutcome: item.execution?.outcome ?? null,
    receipt: applicationReceipt(item, envelope),
    failure: item.failure ? { ...item.failure } : null,
    rejectedAt: item.rejection?.at ?? null,
  };
}

function byConfirmationId(left, right) {
  return left.confirmationId.localeCompare(right.confirmationId);
}

export class ConfirmationQueue {
  constructor({
    store,
    executor,
    operationQueue = new OperationQueue(),
    exclusiveLease,
    clock = () => new Date(),
    reviewHandoffPolicy = {},
  }) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
      throw new TypeError("store must provide read and write");
    }
    if (
      !executor ||
      typeof executor.execute !== "function" ||
      typeof executor.reconcile !== "function"
    ) {
      throw new TypeError("executor must provide execute and reconcile");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("operationQueue must provide enqueue");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("exclusiveLease must provide run");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.store = store;
    this.executor = executor;
    this.operationQueue = operationQueue;
    this.exclusiveLease = exclusiveLease;
    this.clock = clock;
    this.reviewHandoffPolicy = structuredClone(reviewHandoffPolicy);
    this.state = defaultConfirmationState();
    this.ready = false;
    this.recoveryPromise = null;
    this.liveRequests = new Map();
    this.producerVetoes = new Map();
  }

  async recover() {
    if (this.ready) return this.next();
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.operationQueue.enqueue(() =>
        this.exclusiveLease.run(async () => {
          this.ready = false;
          await this.#reload();
          const recoverableIds = this.state.items
            .filter(requiresRecovery)
            .map((item) => item.id);
          for (const id of recoverableIds) await this.#recoverItem(id);
          this.ready = true;
          return this.#projectNext();
        }),
      );
    }
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async enqueue(input) {
    this.#assertReady();
    const plan = normalizeConfirmationPlan(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        await this.#reload();
        const existing = this.#find(plan.id);
        if (existing) {
          if (existing.approvalBindingDigest !== plan.approvalBindingDigest) {
            throw queueError(
              "CONFIRMATION_ID_CONFLICT",
              "同一确认 ID 已绑定其他动作",
              409,
            );
          }
          if (this.#isProducerVetoed(existing)) {
            return this.#invalidate(
              existing.id,
              this.producerVetoes.get(existing.id),
            );
          }
          return this.#projectItem(existing);
        }
        if (this.state.items.length >= MAX_ITEMS) {
          throw queueError(
            "CONFIRMATION_QUEUE_CAPACITY",
            "确认队列已达到容量上限",
            507,
          );
        }
        const timestamp = this.#now();
        let item = {
          ...plan,
          status: "pending",
          itemRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          execution: null,
          receipt: null,
          failure: null,
          rejection: null,
          invalidation: null,
        };
        const veto = this.producerVetoes.get(item.id);
        if (this.#isProducerVetoed(item)) {
          item = {
            ...item,
            status: "stale",
            invalidation: { ...clone(veto), at: timestamp },
          };
        }
        await this.#persist({
          ...this.state,
          revision: this.state.revision + 1,
          items: [...this.state.items, item],
        });
        return this.#projectItem(this.#find(plan.id));
      }),
    );
  }

  async next(options) {
    this.#assertReady();
    const { deferred } = normalizeExternalDeferredOptions(options);
    return this.#projectNext(deferred);
  }

  async nextForHuman(options) {
    this.#assertReady();
    const { deferred } = normalizeExternalDeferredOptions(options);
    return this.#projectNext(deferred, null, true);
  }

  async nextForAction(kind, actionType, options) {
    this.#assertReady();
    const selector = normalizeActionSelector(kind, actionType);
    const { deferred } = normalizeExternalDeferredOptions(options);
    return this.#projectNext(deferred, selector);
  }

  async get(id) {
    this.#assertReady();
    const item = this.#requireItem(id);
    return this.#projectItem(item);
  }

  // Internal proof reader: the user projection intentionally omits execution.
  async readSettlement(input) {
    this.#assertReady();
    const invalid = queueError("INVALID_CONFIRMATION_REQUEST", "确认 ID 无效", 400);
    exactDataFields(input, ["confirmationId"], invalid);
    if (typeof input.confirmationId !== "string" ||
        !HISTORY_ITEM_ID.test(input.confirmationId)) throw invalid;
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      await this.#reload();
      const item = this.#find(input.confirmationId);
      return item === null ? null : deepFreeze({
        queueRevision: this.state.revision,
        item: clone(item),
      });
    }));
  }

  async readSettlements(input) {
    this.#assertReady();
    const invalid = queueError("INVALID_CONFIRMATION_REQUEST", "确认 ID 无效", 400);
    exactDataFields(input, ["confirmationIds"], invalid);
    if (!Array.isArray(input.confirmationIds) || input.confirmationIds.length > MAX_ITEMS) throw invalid;
    const ids = Array.from(input.confirmationIds);
    if (
        ids.some(id => typeof id !== "string" || !HISTORY_ITEM_ID.test(id)) || new Set(ids).size !== ids.length) throw invalid;
    const requested = new Set(ids);
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      await this.#reload();
      return deepFreeze({ queueRevision: this.state.revision,
        items: this.state.items.filter(item => requested.has(item.id)).map(item => clone(item)) });
    }));
  }

  async list(options) {
    this.#assertReady();
    const query = normalizeHistoryQuery(options);
    const state = normalizeConfirmationState(
      await this.store.read(STATE_KEY, defaultConfirmationState()),
    );
    return this.#projectHistory(state, query);
  }

  async readRecoveryStatus() {
    this.#assertReady();
    let state;
    try {
      state = normalizeConfirmationState(
        await this.store.read(STATE_KEY, defaultConfirmationState()),
      );
    } catch {
      throw queueError(
        "CONFIRMATION_RECOVERY_STATUS_UNAVAILABLE",
        "确认恢复状态暂不可用",
        503,
      );
    }
    const kinds = [...new Set(
      state.items
        .filter(requiresRecovery)
        .map(({ kind }) => kind),
    )].sort((left, right) => left.localeCompare(right, "en"));
    return deepFreeze({ kinds });
  }

  async readSnapshot(input) {
    this.#assertReady();
    const { afterRevision } = normalizeSnapshotRequest(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        let state;
        try {
          await this.#reload();
          state = normalizeConfirmationState(this.state);
        } catch {
          throw applicationResultSourceCorrupted();
        }
        const sourceRevision = state.revision;
        if (afterRevision > sourceRevision) {
          throw queueError(
            "APPLICATION_RESULT_SOURCE_REVISION_CONFLICT",
            "变更包应用结果来源修订落后于读取位置",
            409,
          );
        }
        const items = state.items
          .filter(({ kind }) => kind === APPLICATION_RESULT_KIND)
          .map(projectApplicationResult)
          .sort(byConfirmationId);
        const snapshotDigest = digestValue({ sourceRevision, items });
        const unchanged = afterRevision === sourceRevision;
        return deepFreeze({
          sourceRevision,
          unchanged,
          snapshotDigest,
          items: unchanged ? [] : items,
        });
      }),
    );
  }

  async readMemoryPage(input) {
    this.#assertReady();
    const query = normalizeMemoryPageRequest(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        const state = await this.#reload({ detachSnapshot: true });
        if (
          query.highWatermark !== null &&
          query.highWatermark !== state.revision
        ) {
          throw queueError(
            "CONFIRMATION_MEMORY_SOURCE_CHANGED",
            "确认记忆投影期间来源已变化",
            409,
          );
        }
        const items = projectNormalizedConfirmationMemoryState(state).items;
        if (query.cursor > items.length) {
          throw queueError(
            "INVALID_CONFIRMATION_MEMORY_QUERY",
            "确认记忆投影游标无效",
            400,
          );
        }
        const page = items.slice(query.cursor, query.cursor + query.limit);
        const nextCursor = query.cursor + page.length;
        return deepFreeze({
          highWatermark: state.revision,
          cursor: query.cursor,
          items: structuredClone(page),
          nextCursor: nextCursor < items.length ? nextCursor : null,
        });
      }),
    );
  }

  async readMemoryStatus() {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        await this.#reload();
        const state = normalizeConfirmationState(this.state);
        return deepFreeze({ highWatermark: state.revision });
      }),
    );
  }

  async approve(id, input, assignmentProof = null) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input);
    return this.#runIdempotent("approve", id, request, () =>
      this.#approve(id, request, assignmentProof),
    );
  }

  async readReviewHandoffs({ afterId = null } = {}) {
    this.#assertReady();
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      await this.#reload();
      const pending = this.state.items.filter((item) => item.status === "completed" && item.reviewHandoff && ["pending", "retrying"].includes(item.reviewHandoff.status))
        .sort((a, b) => a.reviewHandoff.attempts - b.reviewHandoff.attempts);
      const start = pending.findIndex((item) => item.id === afterId) + 1;
      return [...pending.slice(start), ...pending.slice(0, start)].slice(0, 25)
        .map((item) => ({
          id: item.id,
          actorAccountId: item.actor.accountId,
          request: reviewHandoffWorkRequest(item),
          ...(isAutomaticReviewExecution(item) ? { automaticReview: { reviewEvent: item.action.reviewEvent, headRefOid: item.target.version } } : {}),
        }));
    }));
  }

  async recordReviewHandoff(id, requestId, outcome) {
    this.#assertReady();
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      await this.#reload();
      const item = this.#requireItem(id);
      if (item.status !== "completed" || item.reviewHandoff?.requestId !== requestId) throw queueError("CONFIRMATION_HANDOFF_CONFLICT", "交接绑定已变化", 409);
      if (["completed", "stale"].includes(item.reviewHandoff.status)) return this.#projectItem(item);
      const reviewHandoff = normalizeReviewHandoff({ ...item.reviewHandoff, ...outcome, attempts: item.reviewHandoff.attempts + 1 }, item);
      await this.#replaceItem(id, { ...item, reviewHandoff, itemRevision: item.itemRevision + 1, updatedAt: this.#now() });
      return this.#projectItem(this.#requireItem(id));
    }));
  }

  #assertHandoffBinding(item, request) {
    if (item.execution !== null && request.reviewHandoff !== undefined &&
        digestValue(request.reviewHandoff) !== digestValue(item.reviewHandoff?.selection ?? null)) {
      throw queueError("CONFIRMATION_HANDOFF_CONFLICT", "已接受的 Review 交接不能更换", 409);
    }
  }

  async retry(id, input) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input);
    return this.#runIdempotent("retry", id, request, () =>
      this.#retry(id, request),
    );
  }

  async reject(id, input) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input, { allowReason: true });
    return this.#runIdempotent("reject", id, request, () =>
      this.#reject(id, request),
    );
  }

  async invalidate(id, input) {
    this.#assertReady();
    const invalidation = normalizeConfirmationInvalidation(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        const previousVeto = this.producerVetoes.get(id);
        this.#setProducerVeto(id, invalidation);
        try {
          await this.#reload();
          return await this.#invalidate(id, invalidation);
        } catch (error) {
          if (previousVeto) {
            this.producerVetoes.set(id, previousVeto);
          } else if (
            [
              "CONFIRMATION_PRODUCER_MISMATCH",
              "CONFIRMATION_NOT_INVALIDATABLE",
            ].includes(error?.code)
          ) {
            this.producerVetoes.delete(id);
          }
          throw error;
        }
      }),
    );
  }

  #runIdempotent(operation, id, request, task) {
    const key = [
      operation,
      id,
      request.requestId,
      request.displayedPayloadDigest,
      request.approvalBindingDigest,
      digestValue(request.reviewHandoff ?? null),
    ].join("\u0000");
    const active = this.liveRequests.get(key);
    if (active) return active;
    const promise = this.operationQueue
      .enqueue(() =>
        this.exclusiveLease.run(async () => {
          await this.#reload();
          return task();
        }),
      )
      .finally(() => {
        if (this.liveRequests.get(key) === promise) this.liveRequests.delete(key);
      });
    this.liveRequests.set(key, promise);
    return promise;
  }

  async #approve(id, request, assignmentProof) {
    const item = this.#requireItem(id);
    this.#assertBinding(item, request, { revisions: item.status === "pending" });
    this.#assertHandoffBinding(item, request);
    if (["completed", "stale"].includes(item.status)) {
      return this.#projectItem(item);
    }
    this.#assertNotProducerVetoed(item);
    if (item.status !== "pending") {
      throw queueError(
        "CONFIRMATION_NOT_PENDING",
        "该动作已不在待确认状态",
        409,
      );
    }
    return this.#execute(item, request, assignmentProof);
  }

  async #retry(id, request) {
    let item = this.#requireItem(id);
    this.#assertBinding(item, request, { revisions: true });
    this.#assertHandoffBinding(item, request);
    this.#assertNotProducerVetoed(item);
    if (item.status !== "failed" || !item.failure?.retryable) {
      throw queueError(
        "CONFIRMATION_NOT_RETRYABLE",
        "该动作不能安全重试",
        409,
      );
    }

    const reconciled = await this.#invokeReconcile(item);
    if (reconciled.status !== "absent") {
      await this.#finalize(item, reconciled);
      return this.#projectItem(this.#requireItem(id));
    }
    item = this.#requireItem(id);
    return this.#execute(item, request);
  }

  async #reject(id, request) {
    const item = this.#requireItem(id);
    this.#assertBinding(item, request, {
      revisions: item.status === "pending" || item.status === "failed",
    });
    if (item.status === "rejected" && item.rejection?.requestId === request.requestId) {
      return this.#projectItem(item);
    }
    this.#assertNotProducerVetoed(item);
    if (!new Set(["pending", "failed"]).has(item.status)) {
      throw queueError(
        "CONFIRMATION_NOT_REJECTABLE",
        "该动作不能再拒绝",
        409,
      );
    }
    const timestamp = this.#now();
    const preserveUnknownOutcome =
      item.status === "failed" &&
      item.execution?.outcome === "unknown" &&
      item.failure?.outcome === "unknown";
    await this.#replaceItem(item.id, {
      ...item,
      status: "rejected",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      execution: preserveUnknownOutcome ? item.execution : null,
      receipt: null,
      failure: preserveUnknownOutcome ? item.failure : null,
      rejection: {
        requestId: request.requestId,
        reason: request.reason || "",
        at: timestamp,
      },
      invalidation: null,
    });
    return this.#projectItem(this.#requireItem(id));
  }

  async #invalidate(id, invalidation) {
    const item = this.#requireItem(id);
    if (
      item.approvalBindingDigest !== invalidation.approvalBindingDigest ||
      item.requestedBy.roleId !== invalidation.requestedBy.roleId ||
      item.requestedBy.workItemId !== invalidation.requestedBy.workItemId
    ) {
      throw queueError(
        "CONFIRMATION_PRODUCER_MISMATCH",
        "只有原岗位可以使该确认项失效",
        409,
      );
    }
    if (item.status === "stale") return this.#projectItem(item);
    const provenAbsent =
      item.status === "failed" && item.failure?.outcome === "absent";
    if (item.status !== "pending" && !provenAbsent) {
      throw queueError(
        "CONFIRMATION_NOT_INVALIDATABLE",
        "该动作已不能安全失效",
        409,
      );
    }

    this.#setProducerVeto(item.id, invalidation);
    const timestamp = this.#now();
    await this.#replaceItem(item.id, {
      ...item,
      status: "stale",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      receipt: null,
      failure: null,
      rejection: null,
      invalidation: { ...invalidation, at: timestamp },
    });
    return this.#projectItem(this.#requireItem(id));
  }

  async #execute(item, request, assignmentProof = null) {
    if (isAutomaticReviewExecution({ ...item, execution: { requestId: request.requestId } }) &&
        this.state.items.some((other) => blocksAutomaticReview(other, item, assignmentProof))) {
      return this.#invalidate(item.id, { requestedBy: item.requestedBy, approvalBindingDigest: item.approvalBindingDigest, reason: "authorization_changed" });
    }
    if (
      item.kind === CONFIGURATION_ACTIVATION_KIND &&
      this.state.items.some(
        (candidate) => candidate.id !== item.id && requiresRecovery(candidate),
      ) &&
      !permitsGitHubCredentialRecoveryActivation(item, this.state.items)
    ) {
      throw queueError(
        "CONFIRMATION_RECOVERY_REQUIRED",
        "仍有结果未知的动作需要恢复，暂不能切换运行配置",
        409,
      );
    }
    const timestamp = this.#now();
    const executing = {
      ...item,
      ...(item.execution === null && request.reviewHandoff !== undefined
        ? { reviewHandoff: createReviewHandoff(item, request, this.reviewHandoffPolicy) }
        : {}),
      status: "executing",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      execution: {
        requestId: request.requestId,
        attempt: (item.execution?.attempt || 0) + 1,
        startedAt: timestamp,
        outcome: "unknown",
      },
      receipt: null,
      failure: null,
      rejection: null,
      invalidation: null,
    };
    await this.#replaceItem(item.id, executing);
    const outcome = await this.#invokeExecute(executing);
    await this.#finalize(executing, outcome);
    return this.#projectItem(this.#requireItem(item.id));
  }

  async #recoverItem(id) {
    const item = this.#requireItem(id);
    let outcome = await this.#invokeReconcile(item);
    if (outcome.status === "absent") {
      // A later absence cannot prove the originally admitted write never ran.
      // Keep the outcome fenced while retaining the current safe diagnostic.
      outcome = {
        status: "unknown",
        code: outcome.code,
      };
    }
    if (
      item.status === "failed" &&
      item.failure?.outcome === "unknown" &&
      outcome.status === "unknown" &&
      item.failure.code === outcome.code
    ) {
      return;
    }
    await this.#finalize(item, outcome);
  }

  async #invokeExecute(item) {
    try {
      return normalizeExecutorResult(
        await this.executor.execute(this.#privateEnvelope(item)),
      );
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async #invokeReconcile(item) {
    try {
      return normalizeExecutorResult(
        await this.executor.reconcile(this.#privateEnvelope(item)),
      );
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async #finalize(item, outcome) {
    const current = this.#requireItem(item.id);
    const timestamp = this.#now();
    const execution = {
      ...(current.execution || item.execution),
      outcome: outcome.status,
    };
    let finalized;
    if (outcome.status === "applied" || outcome.status === "already") {
      finalized = {
        ...current,
        status: "completed",
        execution,
        receipt: outcome.receipt,
        failure: null,
        invalidation: null,
      };
    } else if (outcome.status === "stale") {
      finalized = {
        ...current,
        status: "stale",
        execution,
        receipt: null,
        failure: null,
        invalidation: null,
      };
    } else {
      const failureOutcome = outcome.status === "absent" ? "absent" : "unknown";
      finalized = {
        ...current,
        status: "failed",
        execution: { ...execution, outcome: failureOutcome },
        receipt: null,
        invalidation: null,
        failure: {
          code: outcome.code || "EXTERNAL_OUTCOME_UNKNOWN",
          outcome: failureOutcome,
          retryable: failureOutcome === "absent",
          at: timestamp,
        },
      };
    }
    await this.#replaceItem(item.id, {
      ...finalized,
      itemRevision: current.itemRevision + 1,
      updatedAt: timestamp,
    });
  }

  #privateEnvelope(item) {
    return clone({
      schemaVersion: 1,
      id: item.id,
      idempotencyKey: `confirmation-${item.approvalBindingDigest}`,
      kind: item.kind,
      requestedBy: item.requestedBy,
      actor: item.actor,
      target: item.target,
      action: item.action,
      displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest,
      execution: {
        requestId: item.execution.requestId,
        attempt: item.execution.attempt,
        startedAt: item.execution.startedAt,
      },
    });
  }

  #assertBinding(item, request, { revisions }) {
    if (
      request.displayedPayloadDigest !== item.displayedPayloadDigest ||
      request.approvalBindingDigest !== item.approvalBindingDigest
    ) {
      throw queueError(
        "CONFIRMATION_BINDING_MISMATCH",
        "确认内容已变化，请重新查看",
        409,
      );
    }
    if (
      revisions &&
      (request.expectedQueueRevision !== this.state.revision ||
        request.expectedItemRevision !== item.itemRevision)
    ) {
      throw queueError(
        "CONFIRMATION_REVISION_CONFLICT",
        "确认队列已变化，请重新查看",
        409,
      );
    }
  }

  #setProducerVeto(id, invalidation) {
    this.producerVetoes.set(id, clone(invalidation));
  }

  #isProducerVetoed(item) {
    const veto = this.producerVetoes.get(item.id);
    return Boolean(
      veto &&
        veto.approvalBindingDigest === item.approvalBindingDigest &&
        veto.requestedBy.roleId === item.requestedBy.roleId &&
        veto.requestedBy.workItemId === item.requestedBy.workItemId,
    );
  }

  #assertNotProducerVetoed(item) {
    if (this.#isProducerVetoed(item)) {
      throw queueError(
        "CONFIRMATION_INVALIDATION_PENDING",
        "该动作正在失效，不能再由用户执行",
        409,
      );
    }
  }

  #projectNext(deferred = [], selector = null, automaticReviewEnabled = false) {
    const deferredBindings = new Set(
      deferred.map(
        (entry) => `${entry.id}\u0000${entry.approvalBindingDigest}`,
      ),
    );
    const isVisible = (item) =>
      !deferredBindings.has(`${item.id}\u0000${item.approvalBindingDigest}`) &&
      (selector === null ||
        (item.kind === selector.kind && item.action.type === selector.actionType));
    const pending = this.state.items
      .filter(
        (item) =>
          item.status === "pending" &&
          !this.#isProducerVetoed(item) &&
          isVisible(item),
      )
      .sort(byCreation);
    const retryable = this.state.items
      .filter(
        (item) =>
          item.status === "failed" &&
          item.failure?.retryable &&
          !this.#isProducerVetoed(item) &&
          isVisible(item),
      )
      .sort(byCreation);
    const unresolved = this.state.items
      .filter(
        (item) =>
          item.status === "failed" &&
          item.failure?.outcome === "unknown" &&
          !this.#isProducerVetoed(item) &&
          isVisible(item),
      )
      .sort(byCreation);
    const systemManaged = automaticReviewEnabled ? pending.filter(item =>
      item.kind === "github.work-proposal-review" && item.action.type === "pull_request_review") : [];
    const managedIds = new Set(systemManaged.map(item => item.id));
    const actionable = [...pending.filter(item => !managedIds.has(item.id)), ...retryable, ...unresolved];
    return {
      queueRevision: this.state.revision,
      pendingCount: actionable.length,
      item: actionable.length ? this.#projectItem(actionable[0]) : null,
      ...(automaticReviewEnabled ? { automaticReviewEnabled: true, systemManagedCount: systemManaged.length } : {}),
    };
  }

  #projectItem(item) {
    const ownerDecision = projectOwnerDecision(item);
    return clone({
      id: item.id,
      kind: item.kind,
      status: item.status,
      queueRevision: this.state.revision,
      itemRevision: item.itemRevision,
      requestedBy: item.requestedBy,
      actor: item.actor,
      target: item.target,
      display: item.display,
      displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest,
      retryable: Boolean(item.failure?.retryable),
      ...(item.reviewHandoff ? { reviewHandoff: item.reviewHandoff } : {}),
      ...(item.status === "failed" && item.failure?.outcome === "unknown"
        ? { resolutionRequired: true }
        : {}),
      ...(item.receipt ? { receipt: item.receipt } : {}),
      ...(item.failure ? { failure: item.failure } : {}),
      ...(item.rejection && ownerDecision === null
        ? { rejection: item.rejection }
        : {}),
      ...(ownerDecision === null ? {} : { ownerDecision }),
      ...(item.invalidation ? { invalidation: item.invalidation } : {}),
    });
  }

  #projectHistory(state, { filters, limit, cursor }) {
    const projectable = state.items.filter(isProjectableHistoryItem);
    const matches = projectable
      .filter(
        (item) =>
          (!filters.status || item.status === filters.status) &&
          (!filters.kind || item.kind === filters.kind) &&
          (!filters.automatic || isAutomaticReviewExecution(item)) &&
          (!filters.roleId || item.requestedBy.roleId === filters.roleId),
      )
      .sort(byNewestCreation);
    const afterCursor = cursor
      ? matches.filter((item) => byNewestCreation(item, cursor) > 0)
      : matches;
    const page = afterCursor.slice(0, limit);
    return deepFreeze({
      queueRevision: state.revision,
      filters: { ...filters },
      limit,
      roleIdFacets: historyRoleIdFacets(projectable),
      items: page.map(projectHistoryItem),
      nextCursor:
        afterCursor.length > limit
          ? encodeHistoryCursor(page.at(-1), filters)
          : null,
    });
  }

  async #replaceItem(id, replacement) {
    const index = this.state.items.findIndex((item) => item.id === id);
    if (index < 0) throw queueError("CONFIRMATION_NOT_FOUND", "找不到确认项", 404);
    const items = [...this.state.items];
    items[index] = replacement;
    await this.#persist({
      ...this.state,
      revision: this.state.revision + 1,
      items,
    });
  }

  async #persist(state) {
    const normalized = normalizeConfirmationState(state);
    await this.store.write(STATE_KEY, normalized);
    this.state = normalized;
  }

  async #reload({ detachSnapshot = false } = {}) {
    const state = normalizeConfirmationState(
      await this.store.read(STATE_KEY, defaultConfirmationState()),
    );
    // A detached result stays private across the caller's await.
    this.state = detachSnapshot ? structuredClone(state) : state;
    return state;
  }

  #find(id) {
    return this.state.items.find((item) => item.id === id) || null;
  }

  #requireItem(id) {
    if (typeof id !== "string" || !id) {
      throw queueError("INVALID_CONFIRMATION_REQUEST", "确认 ID 无效", 400);
    }
    const item = this.#find(id);
    if (!item) throw queueError("CONFIRMATION_NOT_FOUND", "找不到确认项", 404);
    return item;
  }

  #assertReady() {
    if (!this.ready) {
      throw queueError(
        "CONFIRMATION_QUEUE_NOT_READY",
        "确认队列尚未完成恢复",
        503,
      );
    }
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("clock must return a valid Date");
    }
    return value.toISOString();
  }
}
