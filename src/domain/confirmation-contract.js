import { digestValue } from "./code-executor-contract.js";
import { normalizeReviewHandoff, normalizeReviewHandoffSelection } from "./review-handoff.js";

const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const EXECUTION_OUTCOMES = new Set([
  "unknown",
  "applied",
  "already",
  "absent",
  "stale",
]);
const INVALIDATION_REASONS = new Set([
  "work_item_superseded",
  "authorization_changed",
]);
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_JSON_ENTRIES = 1_000;
const MAX_JSON_DEPTH = 16;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_STATE_ITEMS = 1_000;
const DEFAULT_CONFIRMATION_ERROR = Symbol("defaultConfirmationError");

export class ConfirmationQueueError extends Error {
  constructor(code, message, statusCode = 400, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfirmationQueueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalidRequest(message = "确认请求无效") {
  return new ConfirmationQueueError(
    "INVALID_CONFIRMATION_REQUEST",
    message,
    400,
  );
}

function resolvedConfirmationError(error) {
  return error === DEFAULT_CONFIRMATION_ERROR ? invalidRequest() : error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataKeys(value, error = DEFAULT_CONFIRMATION_ERROR) {
  if (!isPlainObject(value)) throw resolvedConfirmationError(error);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) throw resolvedConfirmationError(error);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw resolvedConfirmationError(error);
  }
  return keys;
}

function assertExactKeys(value, expected, error = DEFAULT_CONFIRMATION_ERROR) {
  const keys = ownDataKeys(value, error);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw resolvedConfirmationError(error);
  }
  return value;
}

function assertAllowedKeys(value, allowed, required, error = DEFAULT_CONFIRMATION_ERROR) {
  const keys = ownDataKeys(value, error);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw resolvedConfirmationError(error);
  }
  return value;
}

function boundedString(
  value,
  { name, minBytes = 1, maxBytes = 512, pattern = null } = {},
) {
  if (typeof value !== "string" || INVALID_TEXT_CONTROL.test(value)) {
    throw invalidRequest(`${name} 无效`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minBytes || bytes > maxBytes || (pattern && !pattern.test(value))) {
    throw invalidRequest(`${name} 无效`);
  }
  return value;
}

function safeToken(value, name) {
  return boundedString(value, {
    name,
    maxBytes: 128,
    pattern: SAFE_TOKEN,
  });
}

function safeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidRequest(`${name} 无效`);
  }
  return value;
}

function assertPlainArray(value, maximumLength = 200) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  ) {
    throw invalidRequest();
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  if (
    ownKeys.length !== expected.length + 1 ||
    !ownKeys.includes("length") ||
    expected.some((key) => !ownKeys.includes(key))
  ) {
    throw invalidRequest();
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidRequest();
    }
  }
  return value;
}

function cloneJson(
  value,
  context = { depth: 0, budget: { entries: 0 }, ancestors: new Set() },
) {
  context.budget.entries += 1;
  if (context.budget.entries > MAX_JSON_ENTRIES) {
    throw invalidRequest("确认内容过大");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return boundedString(value, {
      name: "JSON 字符串",
      minBytes: 0,
      maxBytes: MAX_STRING_BYTES,
    });
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidRequest();
    return value;
  }
  if (context.depth >= MAX_JSON_DEPTH || context.ancestors.has(value)) {
    throw invalidRequest("确认内容嵌套过深或包含循环引用");
  }
  context.ancestors.add(value);
  const childContext = {
    depth: context.depth + 1,
    budget: context.budget,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      assertPlainArray(value);
      return value.map((entry) => cloneJson(entry, childContext));
    }
    const keys = ownDataKeys(value);
    const result = {};
    for (const key of keys.sort()) {
      if (Buffer.byteLength(key, "utf8") > 128) throw invalidRequest();
      result[key] = cloneJson(value[key], childContext);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

function normalizeRequestedBy(value) {
  assertExactKeys(value, ["roleId", "workItemId"]);
  return {
    roleId: safeToken(value.roleId, "roleId"),
    workItemId: boundedString(value.workItemId, {
      name: "workItemId",
      maxBytes: 256,
    }),
  };
}

function normalizeActor(value) {
  assertExactKeys(value, ["provider", "accountId"]);
  return {
    provider: safeToken(value.provider, "actor.provider"),
    accountId: boundedString(value.accountId, {
      name: "actor.accountId",
      maxBytes: 128,
    }),
  };
}

function normalizeTarget(value) {
  assertExactKeys(value, ["provider", "resourceId", "version"]);
  return {
    provider: safeToken(value.provider, "target.provider"),
    resourceId: boundedString(value.resourceId, {
      name: "target.resourceId",
      maxBytes: 512,
    }),
    version: boundedString(value.version, {
      name: "target.version",
      maxBytes: 256,
    }),
  };
}

function normalizeDisplay(value) {
  assertExactKeys(value, [
    "title",
    "summary",
    "actionLabel",
    "evidence",
    "payload",
  ]);
  assertPlainArray(value.evidence, 50);
  if (value.evidence.some((entry) => typeof entry !== "string")) {
    throw invalidRequest("display.evidence 无效");
  }
  return {
    title: boundedString(value.title, { name: "display.title", maxBytes: 512 }),
    summary: boundedString(value.summary, {
      name: "display.summary",
      minBytes: 0,
      maxBytes: 2_048,
    }),
    actionLabel: boundedString(value.actionLabel, {
      name: "display.actionLabel",
      maxBytes: 256,
    }),
    evidence: value.evidence.map((entry) =>
      boundedString(entry, {
        name: "display.evidence",
        minBytes: 0,
        maxBytes: 2_048,
      }),
    ),
    payload: cloneJson(value.payload),
  };
}

export function normalizeConfirmationPlan(value) {
  assertExactKeys(value, [
    "id",
    "kind",
    "requestedBy",
    "actor",
    "target",
    "action",
    "display",
  ]);
  const action = cloneJson(value.action);
  if (!isPlainObject(action) || Object.keys(action).length === 0) {
    throw invalidRequest("action 无效");
  }
  const plan = {
    id: safeToken(value.id, "id"),
    kind: safeToken(value.kind, "kind"),
    requestedBy: normalizeRequestedBy(value.requestedBy),
    actor: normalizeActor(value.actor),
    target: normalizeTarget(value.target),
    action,
    display: normalizeDisplay(value.display),
  };
  if (plan.actor.provider !== plan.target.provider) {
    throw invalidRequest("actor 与 target provider 不一致");
  }
  const displayedBinding = plan.display.payload;
  if (
    !isPlainObject(displayedBinding) ||
    !Object.hasOwn(displayedBinding, "actor") ||
    !Object.hasOwn(displayedBinding, "target") ||
    !Object.hasOwn(displayedBinding, "action") ||
    digestValue(displayedBinding.actor) !== digestValue(plan.actor) ||
    digestValue(displayedBinding.target) !== digestValue(plan.target) ||
    digestValue(displayedBinding.action) !== digestValue(plan.action)
  ) {
    throw invalidRequest("展示内容没有精确包含执行身份、目标和动作");
  }
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > MAX_PLAN_BYTES) {
    throw invalidRequest("确认计划过大");
  }
  const displayedPayloadDigest = digestValue(plan.display);
  const approvalBindingDigest = digestValue({
    id: plan.id,
    kind: plan.kind,
    requestedBy: plan.requestedBy,
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
    displayedPayloadDigest,
  });
  return { ...plan, displayedPayloadDigest, approvalBindingDigest };
}

export function normalizeConfirmationRequest(value, { allowReason = false } = {}) {
  const required = [
    "requestId",
    "expectedQueueRevision",
    "expectedItemRevision",
    "displayedPayloadDigest",
    "approvalBindingDigest",
  ];
  const allowed = allowReason ? [...required, "reason"] : [...required, "reviewHandoff"];
  assertAllowedKeys(value, allowed, required);
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw invalidRequest("reason 无效");
  }
  return {
    ...(value.reviewHandoff === undefined ? {} : { reviewHandoff: normalizeReviewHandoffSelection(value.reviewHandoff) }),
    requestId: boundedString(value.requestId, {
      name: "requestId",
      maxBytes: 128,
      pattern: REQUEST_ID,
    }),
    expectedQueueRevision: safeInteger(
      value.expectedQueueRevision,
      "expectedQueueRevision",
    ),
    expectedItemRevision: safeInteger(
      value.expectedItemRevision,
      "expectedItemRevision",
      { minimum: 1 },
    ),
    displayedPayloadDigest: boundedString(value.displayedPayloadDigest, {
      name: "displayedPayloadDigest",
      maxBytes: 64,
      pattern: SHA256,
    }),
    approvalBindingDigest: boundedString(value.approvalBindingDigest, {
      name: "approvalBindingDigest",
      maxBytes: 64,
      pattern: SHA256,
    }),
    ...(allowReason && value.reason !== undefined
      ? {
          reason: boundedString(value.reason, {
            name: "reason",
            minBytes: 0,
            maxBytes: 1_024,
          }),
        }
      : {}),
  };
}

export function normalizeConfirmationInvalidation(value) {
  assertExactKeys(value, [
    "requestedBy",
    "approvalBindingDigest",
    "reason",
  ]);
  if (!INVALIDATION_REASONS.has(value.reason)) {
    throw invalidRequest("失效原因无效");
  }
  return {
    requestedBy: normalizeRequestedBy(value.requestedBy),
    approvalBindingDigest: boundedString(value.approvalBindingDigest, {
      name: "approvalBindingDigest",
      maxBytes: 64,
      pattern: SHA256,
    }),
    reason: value.reason,
  };
}

function validIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function normalizeConfirmationReceipt(value) {
  assertAllowedKeys(
    value,
    ["id", "url", "createdAt"],
    ["id"],
  );
  const receipt = {
    id: boundedString(value.id, {
      name: "receipt.id",
      maxBytes: 256,
    }),
  };
  if (value.url !== undefined) {
    const url = boundedString(value.url, {
      name: "receipt.url",
      maxBytes: 2_048,
    });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRequest("receipt.url 无效");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      (parsed.hash && !(parsed.hostname === "github.com" && /^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(parsed.pathname) && /^#pullrequestreview-[1-9]\d*$/.test(parsed.hash))) ||
      parsed.href !== url
    ) {
      throw invalidRequest("receipt.url 无效");
    }
    receipt.url = url;
  }
  if (value.createdAt !== undefined) {
    if (!validIsoTimestamp(value.createdAt)) {
      throw invalidRequest("receipt.createdAt 无效");
    }
    receipt.createdAt = value.createdAt;
  }
  return receipt;
}

function normalizeExecution(value) {
  if (value === null) return null;
  assertExactKeys(value, ["requestId", "attempt", "startedAt", "outcome"]);
  if (!validIsoTimestamp(value.startedAt) || !EXECUTION_OUTCOMES.has(value.outcome)) {
    throw invalidRequest();
  }
  return {
    requestId: boundedString(value.requestId, {
      name: "execution.requestId",
      maxBytes: 128,
      pattern: REQUEST_ID,
    }),
    attempt: safeInteger(value.attempt, "execution.attempt", { minimum: 1 }),
    startedAt: value.startedAt,
    outcome: value.outcome,
  };
}

function normalizeFailure(value) {
  if (value === null) return null;
  assertExactKeys(value, ["code", "outcome", "retryable", "at"]);
  if (
    !["absent", "unknown"].includes(value.outcome) ||
    typeof value.retryable !== "boolean" ||
    !validIsoTimestamp(value.at)
  ) {
    throw invalidRequest();
  }
  return {
    code: safeToken(value.code, "failure.code"),
    outcome: value.outcome,
    retryable: value.retryable,
    at: value.at,
  };
}

function normalizeRejection(value) {
  if (value === null) return null;
  assertExactKeys(value, ["requestId", "reason", "at"]);
  if (!validIsoTimestamp(value.at)) throw invalidRequest();
  return {
    requestId: boundedString(value.requestId, {
      name: "rejection.requestId",
      maxBytes: 128,
      pattern: REQUEST_ID,
    }),
    reason: boundedString(value.reason, {
      name: "rejection.reason",
      minBytes: 0,
      maxBytes: 1_024,
    }),
    at: value.at,
  };
}

function normalizeInvalidation(value) {
  if (value === null) return null;
  assertExactKeys(value, [
    "requestedBy",
    "approvalBindingDigest",
    "reason",
    "at",
  ]);
  if (!validIsoTimestamp(value.at)) throw invalidRequest();
  return {
    ...normalizeConfirmationInvalidation({
      requestedBy: value.requestedBy,
      approvalBindingDigest: value.approvalBindingDigest,
      reason: value.reason,
    }),
    at: value.at,
  };
}

function normalizePersistedItem(value) {
  const requiredKeys = [
    "id",
    "kind",
    "status",
    "itemRevision",
    "createdAt",
    "updatedAt",
    "requestedBy",
    "actor",
    "target",
    "action",
    "display",
    "displayedPayloadDigest",
    "approvalBindingDigest",
    "execution",
    "receipt",
    "failure",
    "rejection",
  ];
  assertAllowedKeys(value, [...requiredKeys, "invalidation", "reviewHandoff"], requiredKeys);
  if (!STATUSES.has(value.status)) throw invalidRequest();
  if (!validIsoTimestamp(value.createdAt) || !validIsoTimestamp(value.updatedAt)) {
    throw invalidRequest();
  }
  const normalizedPlan = normalizeConfirmationPlan({
    id: value.id,
    kind: value.kind,
    requestedBy: value.requestedBy,
    actor: value.actor,
    target: value.target,
    action: value.action,
    display: value.display,
  });
  if (
    value.displayedPayloadDigest !== normalizedPlan.displayedPayloadDigest ||
    value.approvalBindingDigest !== normalizedPlan.approvalBindingDigest
  ) {
    throw invalidRequest();
  }
  const item = {
    ...normalizedPlan,
    ...(value.reviewHandoff === undefined ? {} : { reviewHandoff: normalizeReviewHandoff(value.reviewHandoff, normalizedPlan) }),
    status: value.status,
    itemRevision: safeInteger(value.itemRevision, "itemRevision", { minimum: 1 }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    execution: normalizeExecution(value.execution),
    receipt:
      value.receipt === null
        ? null
        : normalizeConfirmationReceipt(value.receipt),
    failure: normalizeFailure(value.failure),
    rejection: normalizeRejection(value.rejection),
    invalidation: normalizeInvalidation(value.invalidation ?? null),
  };
  const validShape = {
    pending:
      item.execution === null && item.receipt === null && item.failure === null && item.rejection === null && item.invalidation === null,
    executing: item.execution !== null && item.receipt === null && item.rejection === null && item.invalidation === null,
    completed: item.execution !== null && item.receipt !== null && item.failure === null && item.rejection === null && item.invalidation === null,
    failed: item.execution !== null && item.receipt === null && item.failure !== null && item.rejection === null && item.invalidation === null,
    stale:
      item.receipt === null &&
      item.failure === null &&
      item.rejection === null &&
      (item.invalidation !== null || item.execution !== null),
    rejected:
      item.receipt === null &&
      item.rejection !== null &&
      item.invalidation === null &&
      (
        (item.execution === null && item.failure === null) ||
        (
          item.execution?.outcome === "unknown" &&
          item.failure?.outcome === "unknown"
        )
      ),
  }[item.status];
  if (item.reviewHandoff && (item.status === "pending" ||
      (item.reviewHandoff.status === "completed" && item.status !== "completed"))) throw invalidRequest();
  if (!validShape) throw invalidRequest();
  const validOutcome = {
    pending: true,
    executing: item.execution?.outcome === "unknown",
    completed: new Set(["applied", "already"]).has(item.execution?.outcome),
    failed: item.execution?.outcome === item.failure?.outcome,
    stale: item.invalidation
      ? item.execution === null || item.execution?.outcome === "absent"
      : item.execution?.outcome === "stale",
    rejected: true,
  }[item.status];
  if (!validOutcome || Date.parse(item.createdAt) > Date.parse(item.updatedAt)) {
    throw invalidRequest();
  }
  if (
    item.failure &&
    item.failure.retryable !== (item.failure.outcome === "absent")
  ) {
    throw invalidRequest();
  }
  return item;
}

export function defaultConfirmationState() {
  return { schemaVersion: 1, revision: 0, items: [] };
}

export function normalizeConfirmationState(value) {
  try {
    assertExactKeys(value, ["schemaVersion", "revision", "items"]);
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.items) ||
      value.items.length > MAX_STATE_ITEMS
    ) {
      throw invalidRequest();
    }
    const revision = safeInteger(value.revision, "revision");
    const items = value.items.map(normalizePersistedItem);
    if (
      revision < items.length ||
      items.some((item) => item.itemRevision > revision) ||
      new Set(items.map((item) => item.id)).size !== items.length
    ) {
      throw invalidRequest();
    }
    return { schemaVersion: 1, revision, items };
  } catch (error) {
    throw new ConfirmationQueueError(
      "CONFIRMATION_STATE_CORRUPTED",
      "确认队列持久化状态损坏",
      500,
      { cause: error },
    );
  }
}

export function cloneConfirmationValue(value) {
  return cloneJson(value);
}
