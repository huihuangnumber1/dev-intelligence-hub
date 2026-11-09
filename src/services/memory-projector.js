import { authorityLifecycleMemoryRecord } from "../domain/memory-authority-lifecycle.js";
import { createHash } from "node:crypto";
import {
  createWorkGraphSourceAuthority,
  memoryRecordForWorkGraphMemoryEvent,
  normalizeWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../domain/work-graph-memory-event.js";
import { normalizeMemoryRecord } from "../domain/memory-record.js";
import {
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  pullRequestHeadAdmission,
} from "./work-ledger-pr-source.js";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  createPullRequestExecutionBinding,
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";

const WRITE_BATCH = 100;
const SAFE_ROLE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GRAPH_BATCH_LIMIT = 100;
const AUTHORITY_SNAPSHOT_ATTEMPTS = 2;
const CONFIRMATION_PAGE_LIMIT = 100;
const CONFIRMATION_MAXIMUM_ITEMS = 1_000;
const AUTHORITY_VERIFICATION_MAXIMUM_BINDINGS = 100_000;
export const LEGACY_AUTHORITY_PROJECTION_STATE_KEY =
  "authority-bound-memory-projection";
const AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION = 4;
const AUTHORITY_PROJECTION_MAXIMUM_ENTRIES = 100_000;
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const ACTION_BY_CONFIRMATION_KIND = Object.freeze({
  "github.pull-request-comment": "pull_request_comment",
  "github.pull-request-review": "pull_request_review",
  "github.work-proposal-review": "pull_request_review",
  "github.pull-request-update-branch": "pull_request_update_branch",
  "github.pull-request-push": "pull_request_push",
  "github.pull-request-merge": "pull_request_merge",
});
const AUTHORITY_MEMORY_KINDS = new Set([
  "work-decision",
  "consultation-request",
  "consultation-result",
  "confirmation",
  "external-result",
]);

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function plainData(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safeText(value, maximum = 8_192) {
  if (typeof value !== "string") return "";
  let result = "";
  let bytes = 0;
  for (const character of value.replace(INVALID_CONTROL, " ")) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximum) break;
    bytes += size;
    result += character;
  }
  return result;
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function safeTimestamp(...values) {
  return values.find(validTimestamp) || null;
}

function safeRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value) ? value : null;
}

function safeRole(value) {
  return typeof value === "string" && SAFE_ROLE.test(value) ? value : null;
}

function safeToken(value, fallback) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function stringList(value, maximum = 20) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return [];
  }
  const result = [];
  for (let index = 0; index < Math.min(value.length, maximum); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) return [];
    const entry = safeText(descriptor.value, 2_048);
    if (entry.trim()) result.push(entry);
  }
  return result;
}

function dataList(value, maximum, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return null;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function safeJson(value, maximum = 32 * 1024) {
  try {
    return safeText(JSON.stringify(value), maximum);
  } catch {
    return "";
  }
}

function githubUrl(repository, number, eventType) {
  if (!repository || !number) return null;
  const kind = eventType?.startsWith("pull_request.") ? "pull" : "issues";
  return `https://github.com/${repository}/${kind}/${number}`;
}

function projectedSourceAuthority(state, item) {
  const sourceBinding = currentWorkItemInputBinding(item);
  if (sourceBinding === null) return createWorkGraphSourceAuthority();
  const event = currentWorkItemEvent(item);
  let executionBinding;
  try {
    executionBinding = createPullRequestExecutionBinding({ sourceBinding, event });
  } catch {
    executionBinding = {
      schemaVersion: 1,
      kind: "pull_request",
      repository: event.subject.repository,
      pullRequestNumber: event.subject.number,
      ...sourceBinding,
    };
  }
  const admission = pullRequestHeadAdmission(state, item);
  return createWorkGraphSourceAuthority({
    executionBinding,
    provenance: {
      provider: event.source.provider,
      scopeId: event.source.scopeId,
    },
    citable:
      executionBinding.schemaVersion === 2 &&
      admission.current === true &&
      admission.pending === false,
  });
}

function pullRequestObservation(item, event, payload) {
  if (!event?.eventType?.startsWith("pull_request.")) return null;
  let sourceBinding = null;
  try {
    sourceBinding = currentWorkItemInputBinding(item);
  } catch {
    // Keep the observable event bounded even when an optional binding is absent.
  }
  const eventId = safeText(sourceBinding?.eventId || event?.eventId, 256);
  const headCandidate = payload?.headRefOid ||
    plainData(payload?.gitTarget)?.headRefOid || sourceBinding?.headRefOid;
  const headRefOid = typeof headCandidate === "string" && GIT_OID.test(headCandidate)
    ? headCandidate
    : null;
  const ciStatus = safeText(payload?.ciStatus, 64);
  const mergeStateStatus = safeText(payload?.mergeStateStatus, 64);
  const changedFields = stringList(payload?.changedFields, 20)
    .map((entry) => safeText(entry, 128));
  return {
    eventId: eventId || null,
    occurredAt: safeTimestamp(event?.occurredAt),
    headRefOid,
    ciStatus: ciStatus || null,
    mergeStateStatus: mergeStateStatus || null,
    changedFields,
  };
}

function workItemRecord(raw, state) {
  const item = plainData(raw);
  const event = plainData(currentWorkItemEvent(item));
  const subject = plainData(event?.subject);
  const target = plainData(item?.currentTarget);
  const payload = plainData(event?.payload);
  const occurredAt = safeTimestamp(item?.updatedAt, item?.createdAt, event?.occurredAt);
  const itemId = safeText(item?.itemId, 256);
  if (!itemId || !occurredAt) return null;
  const repository = safeRepository(subject?.repository);
  const number = safeNumber(subject?.number);
  const status = safeToken(item.status, "unknown");
  const sourceAuthority = projectedSourceAuthority(state, item);
  const prObservation = pullRequestObservation(item, event, payload);
  const targetRole = target?.type === "role" ? safeRole(target.id) : null;
  return {
    schemaVersion: 1,
    source: {
      kind: "work-item",
      id: `${itemId}:revision:${Number.isSafeInteger(item.revision) ? item.revision : 0}`,
    },
    occurredAt,
    roleId: targetRole,
    repository,
    eventType: `work.${status}`,
    title: safeText(payload?.title || subject?.id || itemId, 1_024),
    summary: safeText(
      `${status} · ${target?.type || "target"}:${target?.id || "unknown"}${item.statusReason ? ` · ${item.statusReason}` : ""}`,
      8_192,
    ),
    content: safeJson({
      assignmentId: item.assignmentId,
      eventType: event?.eventType,
      target,
      status,
      attempt: item.attempt,
      sourceAuthority,
      decisionContext: status === "superseded" ? null : item.decisionContext,
      ...(prObservation === null
        ? {}
        : { pullRequestObservation: prObservation }),
    }),
    evidence: [`supersedes-work-item-revisions:${itemId}`],
    tags: ["work", status, ...(targetRole ? [targetRole] : [])],
    sourceUrl: githubUrl(repository, number, event?.eventType),
    subjectNumber: number,
  };
}

function timelineRecord(raw, itemById) {
  const entry = plainData(raw);
  const timelineId = safeText(entry?.timelineId, 256);
  const occurredAt = safeTimestamp(entry?.at);
  if (!timelineId || !occurredAt) return null;
  const item = itemById.get(entry.itemId);
  const event = plainData(currentWorkItemEvent(item));
  const subject = plainData(event?.subject);
  const repository = safeRepository(subject?.repository);
  const number = safeNumber(subject?.number);
  const sourceUrl = githubUrl(repository, number, event?.eventType);
  const historicalPrTimeline = sourceUrl?.includes("/pull/") === true;
  const type = safeToken(entry.type, "unknown");
  return {
    schemaVersion: 1,
    source: { kind: "work-timeline", id: timelineId },
    occurredAt,
    roleId: safeRole(entry.actorId),
    repository,
    eventType: `timeline.${type}`,
    title: `工作时间线：${type}`,
    summary: safeText(entry.itemId || "全局工作事件", 8_192),
    content: safeJson({
      details: entry.details,
      ...(historicalPrTimeline
        ? { historicalOnly: true, citableConclusion: false }
        : {}),
    }),
    evidence: [],
    tags: [
      "timeline",
      type,
      ...(historicalPrTimeline ? ["derived", "obsolete"] : []),
    ],
    sourceUrl,
    subjectNumber: number,
  };
}

function legacyRecord(raw) {
  const memory = plainData(raw);
  const id = safeText(memory?.id, 512);
  const occurredAt = safeTimestamp(memory?.createdAt);
  if (!id || !occurredAt) return null;
  const repository = safeRepository(memory.repository);
  const number = safeNumber(memory.number);
  const eventType = safeToken(memory.event, "observation");
  let sourceUrl = null;
  try {
    if (typeof memory.sourceUrl === "string") {
      const url = new URL(memory.sourceUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        sourceUrl = url.toString();
      }
    }
  } catch {
    sourceUrl = null;
  }
  return {
    schemaVersion: 1,
    source: { kind: "legacy-pr-memory", id },
    occurredAt,
    roleId: safeRole(memory.roleId) || "pr-reviewer",
    repository,
    eventType,
    title: safeText(memory.title || id, 1_024),
    summary: safeText(memory.summary, 8_192),
    content: safeJson({
      fingerprint: safeText(memory.fingerprint, 1_024),
      headRefOid: safeText(memory.headRefOid, 128),
      steps: stringList(memory.steps, 20),
      reviewBody: safeText(memory.reviewBody, 8_192),
      decision: safeText(memory.decision, 1_024),
      sourceId: safeText(memory.sourceId, 512),
      brain: plainData(memory.brain),
    }),
    evidence: stringList(memory.evidence, 20),
    tags: ["legacy", "pr-reviewer", "derived", "obsolete"],
    sourceUrl,
    subjectNumber: number,
  };
}

function exactProjectionObject(value, keys, message) {
  const data = plainData(value);
  if (
    data === null ||
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) {
    throw new TypeError(message);
  }
  return data;
}

function normalizeCycleOptions(value) {
  if (value === undefined) return { signal: null };
  const message = "memory projection cycle options are invalid";
  const options = plainData(value);
  if (
    options === null ||
    Object.keys(options).some((key) => key !== "signal")
  ) {
    throw new TypeError(message);
  }
  try {
    return { signal: normalizeAbortSignal(options.signal ?? null) };
  } catch {
    throw new TypeError(message);
  }
}

function throwIfProjectionAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("Memory projection cycle was cancelled");
  error.code = "MEMORY_PROJECTION_CANCELLED";
  throw error;
}

async function runProjectionPort(signal, operation) {
  throwIfProjectionAborted(signal);
  const result = await operation();
  throwIfProjectionAborted(signal);
  return result;
}

function nonNegativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(message);
  return value;
}

function strictProjectionList(value, maximum, message) {
  const result = dataList(value, maximum);
  if (result === null) throw new TypeError(message);
  return result;
}

function projectionTimestamp(value, message) {
  if (!validTimestamp(value)) throw new TypeError(message);
  return value;
}

function projectionText(value, maximum, message) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    safeText(value, maximum) !== value
  ) {
    throw new TypeError(message);
  }
  return value;
}

function normalizeMemoryAction(value, kind, message) {
  const expectedType = ACTION_BY_CONFIRMATION_KIND[kind];
  const action = plainData(value);
  if (action === null || action.type !== expectedType) {
    throw new TypeError(message);
  }
  let inputBinding;
  try {
    inputBinding = normalizePullRequestExecutionBinding(action.inputBinding);
  } catch {
    throw new TypeError(message);
  }
  if (inputBinding.schemaVersion !== 2) throw new TypeError(message);
  const common = { type: expectedType, inputBinding };
  if (expectedType === "pull_request_comment") {
    exactProjectionObject(
      action,
      ["type", "inputBinding", "bodyDigest", "bodyBytes"],
      message,
    );
    if (!SHA256.test(action.bodyDigest)) throw new TypeError(message);
    return {
      ...common,
      bodyDigest: action.bodyDigest,
      bodyBytes: nonNegativeInteger(action.bodyBytes, message),
    };
  }
  if (expectedType === "pull_request_review") {
    exactProjectionObject(
      action,
      ["type", "inputBinding", "bodyDigest", "bodyBytes", "reviewEvent"],
      message,
    );
    if (
      !SHA256.test(action.bodyDigest) ||
      !["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(action.reviewEvent)
    ) {
      throw new TypeError(message);
    }
    return {
      ...common,
      bodyDigest: action.bodyDigest,
      bodyBytes: nonNegativeInteger(action.bodyBytes, message),
      reviewEvent: action.reviewEvent,
    };
  }
  if (expectedType === "pull_request_update_branch") {
    exactProjectionObject(
      action,
      ["type", "inputBinding", "expectedHeadOid", "expectedBaseOid"],
      message,
    );
    if (
      action.expectedHeadOid !== inputBinding.gitTarget.headRefOid ||
      action.expectedBaseOid !== inputBinding.gitTarget.baseRefOid
    ) {
      throw new TypeError(message);
    }
    return {
      ...common,
      expectedHeadOid: action.expectedHeadOid,
      expectedBaseOid: action.expectedBaseOid,
    };
  }
  if (expectedType === "pull_request_push") {
    exactProjectionObject(
      action,
      [
        "type",
        "inputBinding",
        "expectedOldOid",
        "remote",
        "controlledCommit",
      ],
      message,
    );
    const remote = exactProjectionObject(
      action.remote,
      ["repository", "refName"],
      message,
    );
    const controlled = exactProjectionObject(
      action.controlledCommit,
      ["evidenceId", "evidenceDigest", "commit"],
      message,
    );
    const commit = exactProjectionObject(
      controlled.commit,
      ["oid", "treeOid", "parents"],
      message,
    );
    const parents = strictProjectionList(commit.parents, 2, message);
    if (
      ![1, 2].includes(parents.length) ||
      !SHA256.test(controlled.evidenceDigest) ||
      controlled.evidenceId !==
        `controlled-git-commit-${controlled.evidenceDigest}` ||
      action.expectedOldOid !== inputBinding.gitTarget.headRefOid ||
      remote.repository !== inputBinding.gitTarget.headRepository ||
      remote.refName !== inputBinding.gitTarget.headRefName ||
      parents[0] !== inputBinding.gitTarget.headRefOid ||
      (parents.length === 2 && parents[1] !== inputBinding.gitTarget.baseRefOid) ||
      !GIT_OID.test(commit.oid) ||
      !GIT_OID.test(commit.treeOid)
    ) {
      throw new TypeError(message);
    }
    return {
      ...common,
      expectedOldOid: action.expectedOldOid,
      remote: { ...remote },
      controlledCommit: {
        evidenceId: controlled.evidenceId,
        evidenceDigest: controlled.evidenceDigest,
        commit: { oid: commit.oid, treeOid: commit.treeOid, parents: [...parents] },
      },
    };
  }
  exactProjectionObject(
    action,
    ["type", "inputBinding", "method", "expectedHeadOid"],
    message,
  );
  if (
    !["merge", "squash", "rebase"].includes(action.method) ||
    action.expectedHeadOid !== inputBinding.gitTarget.headRefOid
  ) {
    throw new TypeError(message);
  }
  return {
    ...common,
    method: action.method,
    expectedHeadOid: action.expectedHeadOid,
  };
}

function normalizeConfirmationMemoryItem(value) {
  const message = "confirmation memory projection item is invalid";
  const item = exactProjectionObject(
    value,
    [
      "confirmationId",
      "itemRevision",
      "statusDigest",
      "kind",
      "status",
      "requestedBy",
      "actor",
      "target",
      "action",
      "displayedPayloadDigest",
      "approvalBindingDigest",
      "createdAt",
      "updatedAt",
      "execution",
      "receipt",
      "failure",
      "rejectedAt",
      "ownerDecision",
      "invalidation",
    ],
    message,
  );
  if (
    !Object.hasOwn(ACTION_BY_CONFIRMATION_KIND, item.kind) ||
    !CONFIRMATION_STATUSES.has(item.status) ||
    !SHA256.test(item.displayedPayloadDigest) ||
    !SHA256.test(item.approvalBindingDigest)
  ) {
    throw new TypeError(message);
  }
  const confirmationId = projectionText(item.confirmationId, 256, message);
  const itemRevision = nonNegativeInteger(item.itemRevision, message);
  if (itemRevision < 1) throw new TypeError(message);
  const requestedBy = exactProjectionObject(
    item.requestedBy,
    ["roleId", "workItemId"],
    message,
  );
  const actor = exactProjectionObject(
    item.actor,
    ["provider", "accountId"],
    message,
  );
  const target = exactProjectionObject(
    item.target,
    ["provider", "resourceId", "version"],
    message,
  );
  const action = normalizeMemoryAction(item.action, item.kind, message);
  if (
    projectionText(requestedBy.roleId, 128, message) === "" ||
    projectionText(requestedBy.workItemId, 256, message) === "" ||
    actor.provider !== "github" ||
    projectionText(actor.accountId, 64, message).toLowerCase() !==
      action.inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
    target.provider !== "github" ||
    target.resourceId !==
      `${action.inputBinding.repository}#${action.inputBinding.pullRequestNumber}` ||
    target.version !== action.inputBinding.headRefOid
  ) {
    throw new TypeError(message);
  }
  const execution = item.execution === null
    ? null
    : exactProjectionObject(
        item.execution,
        ["attempt", "startedAt", "outcome"],
        message,
      );
  if (execution !== null) {
    if (
      nonNegativeInteger(execution.attempt, message) < 1 ||
      !validTimestamp(execution.startedAt) ||
      safeText(execution.outcome, 64) !== execution.outcome
    ) {
      throw new TypeError(message);
    }
  }
  const receipt = item.receipt === null
    ? null
    : exactProjectionObject(item.receipt, ["id"], message);
  if (receipt !== null) projectionText(receipt.id, 256, message);
  const failure = item.failure === null
    ? null
    : exactProjectionObject(
        item.failure,
        ["code", "outcome", "retryable", "at"],
        message,
      );
  if (
    failure !== null &&
    (
      safeText(failure.code, 128) !== failure.code ||
      !["absent", "unknown"].includes(failure.outcome) ||
      typeof failure.retryable !== "boolean" ||
      !validTimestamp(failure.at)
    )
  ) {
    throw new TypeError(message);
  }
  if (!(item.rejectedAt === null || validTimestamp(item.rejectedAt))) {
    throw new TypeError(message);
  }
  const ownerDecision = item.ownerDecision === null
    ? null
    : exactProjectionObject(
        item.ownerDecision,
        ["type", "at"],
        message,
      );
  if (
    ownerDecision !== null &&
    (
      ownerDecision.type !== "seal_unknown_and_forbid_replay" ||
      !validTimestamp(ownerDecision.at)
    )
  ) {
    throw new TypeError(message);
  }
  const rejected = item.status === "rejected";
  if (rejected !== (item.rejectedAt !== null)) {
    throw new TypeError(message);
  }
  const sealedUnknown =
    rejected &&
    execution?.outcome === "unknown" &&
    failure?.outcome === "unknown";
  if (
    (ownerDecision !== null) !== sealedUnknown ||
    (ownerDecision !== null && ownerDecision.at !== item.rejectedAt)
  ) {
    throw new TypeError(message);
  }
  const invalidation = item.invalidation === null
    ? null
    : exactProjectionObject(item.invalidation, ["reason", "at"], message);
  if (
    invalidation !== null &&
    (
      safeText(invalidation.reason, 1_024) !== invalidation.reason ||
      !validTimestamp(invalidation.at)
    )
  ) {
    throw new TypeError(message);
  }
  const normalized = {
    confirmationId,
    itemRevision,
    statusDigest: item.statusDigest,
    kind: item.kind,
    status: item.status,
    requestedBy: { ...requestedBy },
    actor: { ...actor },
    target: { ...target },
    action,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
    createdAt: projectionTimestamp(item.createdAt, message),
    updatedAt: projectionTimestamp(item.updatedAt, message),
    execution: execution === null ? null : { ...execution },
    receipt: receipt === null ? null : { ...receipt },
    failure: failure === null ? null : { ...failure },
    rejectedAt: item.rejectedAt,
    ownerDecision: ownerDecision === null ? null : { ...ownerDecision },
    invalidation: invalidation === null ? null : { ...invalidation },
  };
  const expectedStatusDigest = digestValue({
    confirmationId,
    itemRevision,
    status: item.status,
    approvalBindingDigest: item.approvalBindingDigest,
    updatedAt: item.updatedAt,
  });
  if (item.statusDigest !== expectedStatusDigest) throw new TypeError(message);
  return normalized;
}

function normalizeConfirmationMemoryPage(value, expected) {
  const message = "confirmation memory projection page is invalid";
  const page = exactProjectionObject(
    value,
    ["highWatermark", "cursor", "items", "nextCursor"],
    message,
  );
  const highWatermark = nonNegativeInteger(page.highWatermark, message);
  const cursor = nonNegativeInteger(page.cursor, message);
  if (
    cursor !== expected.cursor ||
    (expected.highWatermark !== null &&
      highWatermark !== expected.highWatermark)
  ) {
    throw new TypeError(message);
  }
  const items = strictProjectionList(
    page.items,
    CONFIRMATION_PAGE_LIMIT,
    message,
  ).map(normalizeConfirmationMemoryItem);
  const nextCursor = page.nextCursor;
  if (
    !(
      nextCursor === null ||
      (Number.isSafeInteger(nextCursor) &&
        nextCursor === cursor + items.length &&
        nextCursor > cursor)
    )
  ) {
    throw new TypeError(message);
  }
  return { highWatermark, cursor, items, nextCursor };
}

async function readConfirmationMemorySnapshot(readPage, signal = null) {
  if (readPage === null) return { highWatermark: 0, items: [] };
  const items = [];
  let cursor = 0;
  let highWatermark = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = normalizeConfirmationMemoryPage(
      await runProjectionPort(signal, () =>
        readPage({
          cursor,
          limit: CONFIRMATION_PAGE_LIMIT,
          highWatermark,
        })
      ),
      { cursor, highWatermark },
    );
    highWatermark = page.highWatermark;
    items.push(...page.items);
    if (items.length > CONFIRMATION_MAXIMUM_ITEMS) {
      throw new TypeError("confirmation memory projection exceeds capacity");
    }
    if (page.nextCursor === null) {
      if (new Set(items.map(({ confirmationId }) => confirmationId)).size !== items.length) {
        throw new TypeError("confirmation memory projection contains duplicates");
      }
      return { highWatermark, items };
    }
    cursor = page.nextCursor;
  }
  throw new TypeError("confirmation memory projection exceeds page capacity");
}

function normalizeConfirmationMemorySnapshot(value) {
  const message = "confirmation memory projection snapshot is invalid";
  const snapshot = exactProjectionObject(
    value,
    ["highWatermark", "items"],
    message,
  );
  const highWatermark = nonNegativeInteger(snapshot.highWatermark, message);
  const items = strictProjectionList(
    snapshot.items,
    CONFIRMATION_MAXIMUM_ITEMS,
    message,
  ).map(normalizeConfirmationMemoryItem);
  if (
    new Set(items.map(({ confirmationId }) => confirmationId)).size !==
      items.length
  ) {
    throw new TypeError(message);
  }
  return { highWatermark, items };
}

export function normalizeLegacyAuthorityProjectionState(value) {
  if (value === null) {
    return {
      schemaVersion: AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION,
      revision: 0,
      workLedgerRevision: 0,
      authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
      confirmationHighWatermark: 0,
      entries: [],
    };
  }
  const message = "authority-bound memory projection state is invalid";
  const hasConfirmationHighWatermark = Object.hasOwn(
    value,
    "confirmationHighWatermark",
  );
  const hasLedgerAuthority = Object.hasOwn(value, "workLedgerRevision") ||
    Object.hasOwn(value, "authorityStateDigest");
  const state = exactProjectionObject(
    value,
    [
      "schemaVersion",
      "revision",
      ...(hasLedgerAuthority
        ? ["workLedgerRevision", "authorityStateDigest"]
        : []),
      ...(hasConfirmationHighWatermark
        ? ["confirmationHighWatermark"]
        : []),
      "entries",
    ],
    message,
  );
  if (![1, 2, 3, AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION].includes(
    state.schemaVersion,
  ) || hasConfirmationHighWatermark !== (state.schemaVersion >= 3) ||
      hasLedgerAuthority !==
        (state.schemaVersion === AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION)) {
    throw new TypeError(message);
  }
  const revision = nonNegativeInteger(state.revision, message);
  const workLedgerRevision = hasLedgerAuthority
    ? nonNegativeInteger(state.workLedgerRevision, message)
    : 0;
  const authorityStateDigest = hasLedgerAuthority
    ? state.authorityStateDigest
    : EMPTY_AUTHORITY_STATE_DIGEST;
  if (typeof authorityStateDigest !== "string" || !SHA256.test(
    authorityStateDigest,
  )) {
    throw new TypeError(message);
  }
  const confirmationHighWatermark = hasConfirmationHighWatermark
    ? nonNegativeInteger(state.confirmationHighWatermark, message)
    : 0;
  const entries = strictProjectionList(
    state.entries,
    AUTHORITY_PROJECTION_MAXIMUM_ENTRIES,
    message,
  ).map(
    (valueEntry) => {
      const legacy = state.schemaVersion === 1;
      const entry = exactProjectionObject(valueEntry, legacy
        ? ["key", "fingerprint", "recordId"]
        : [
            "key",
            "fingerprint",
            "recordId",
            "sourceKind",
            "binding",
            "current",
            "occurredAt",
          ], message);
      const sourceKind = legacy
        ? entry.key.slice(0, entry.key.indexOf(":"))
        : entry.sourceKind;
      if (
        typeof entry.key !== "string" ||
        entry.key.length === 0 ||
        Buffer.byteLength(entry.key, "utf8") > 512 ||
        !SHA256.test(entry.fingerprint) ||
        !MEMORY_RECORD_ID.test(entry.recordId) ||
        !AUTHORITY_MEMORY_KINDS.has(sourceKind)
      ) {
        throw new TypeError(message);
      }
      if (legacy) {
        return {
          ...entry,
          sourceKind,
          binding: null,
          current: null,
          occurredAt: "1970-01-01T00:00:00.000Z",
        };
      }
      let binding = null;
      if (entry.binding !== null) {
        try {
          binding = normalizePullRequestExecutionBinding(entry.binding);
        } catch {
          throw new TypeError(message);
        }
      }
      if (
        ![true, false].includes(entry.current) ||
        !validTimestamp(entry.occurredAt)
      ) {
        throw new TypeError(message);
      }
      return { ...entry, sourceKind, binding };
    },
  );
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
    throw new TypeError(message);
  }
  return {
    schemaVersion: AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION,
    revision,
    workLedgerRevision,
    authorityStateDigest,
    confirmationHighWatermark,
    entries,
  };
}

function normalizeProjectionPlannerState(value) {
  try {
    return normalizeLegacyAuthorityProjectionState(value);
  } catch (error) {
    const message = "authority-bound memory projection state is invalid";
    const state = exactProjectionObject(
      value,
      [
        "schemaVersion",
        "revision",
        "workLedgerRevision",
        "authorityStateDigest",
        "confirmationHighWatermark",
        "entries",
      ],
      message,
    );
    if (state.schemaVersion !== AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION) {
      throw error;
    }
    const metadata = normalizeLegacyAuthorityProjectionState({
      ...state,
      entries: [],
    });
    const rawEntries = strictProjectionList(
      state.entries,
      AUTHORITY_PROJECTION_MAXIMUM_ENTRIES,
      message,
    ).map((entry) => {
      const fields = exactProjectionObject(
        entry,
        [
          "key",
          "fingerprint",
          "recordId",
          "sourceKind",
          "binding",
          "current",
          "occurredAt",
        ],
        message,
      );
      if (
        fields.binding !== null ||
        fields.current !== null ||
        fields.occurredAt !== "1970-01-01T00:00:00.000Z"
      ) {
        throw error;
      }
      return {
        key: fields.key,
        fingerprint: fields.fingerprint,
        recordId: fields.recordId,
      };
    });
    const legacy = normalizeLegacyAuthorityProjectionState({
      schemaVersion: 1,
      revision: metadata.revision,
      entries: rawEntries,
    });
    if (digestValue(legacy.entries) !== digestValue(state.entries)) {
      throw error;
    }
    return {
      ...legacy,
      workLedgerRevision: metadata.workLedgerRevision,
      authorityStateDigest: metadata.authorityStateDigest,
      confirmationHighWatermark: metadata.confirmationHighWatermark,
    };
  }
}

function memoryRepository(binding) {
  return binding.repository;
}

function memoryNumber(binding) {
  return binding.pullRequestNumber;
}

function boundedRecord({
  sourceKind,
  sourceKey,
  occurredAt,
  roleId,
  binding,
  eventType,
  title,
  summary,
  content,
  evidence,
  tags,
}) {
  const fingerprint = digestValue({ sourceKind, sourceKey, content, tags });
  return {
    schemaVersion: 1,
    source: { kind: sourceKind, id: `${sourceKey}:${fingerprint}` },
    occurredAt,
    roleId,
    repository: memoryRepository(binding),
    eventType,
    title,
    summary,
    content: JSON.stringify(content),
    evidence,
    tags,
    sourceUrl: null,
    subjectNumber: memoryNumber(binding),
  };
}

function authorityBindingDigest(binding) {
  return digestValue(normalizePullRequestExecutionBinding(binding));
}

function memoizedBindingAuthority(verify, { strict = false } = {}) {
  const results = new Map();
  return async (binding, { stale = false } = {}) => {
    if (stale && !strict) return false;
    const normalized = normalizePullRequestExecutionBinding(binding);
    const key = authorityBindingDigest(normalized);
    if (!results.has(key)) {
      results.set(key, Promise.resolve().then(async () => {
        try {
          const verified = await verify(structuredClone(normalized));
          if (!samePullRequestExecutionBinding(verified, normalized)) {
            if (strict) {
              throw new TypeError("input authority verification mismatch");
            }
            return false;
          }
          return true;
        } catch (error) {
          if (strict) throw error;
          return false;
        }
      }));
    }
    const current = await results.get(key);
    return stale ? false : current;
  };
}

function authorityProjectionBindings(stored, snapshot, confirmationSnapshot) {
  const bindings = new Map();
  const add = (binding) => {
    const normalized = normalizePullRequestExecutionBinding(binding);
    bindings.set(authorityBindingDigest(normalized), normalized);
  };
  for (const item of confirmationSnapshot.items) {
    if (item.status !== "stale") add(item.action.inputBinding);
  }
  const itemById = new Map(snapshot.items.map((item) => [item.itemId, item]));
  for (const entry of snapshot.timeline) {
    if (timelineProjectionKind(entry) === null) continue;
    const item = itemById.get(entry.itemId);
    if (item === undefined || item.status === "superseded") continue;
    const binding = timelineBinding(entry, item);
    if (binding !== null && binding !== undefined) add(binding);
  }
  for (const entry of stored.entries) {
    if (entry.current === true && entry.binding !== null) add(entry.binding);
  }
  if (bindings.size > AUTHORITY_VERIFICATION_MAXIMUM_BINDINGS) {
    throw new TypeError("authority-bound memory projection exceeds capacity");
  }
  return [...bindings.values()];
}

function normalizeAuthorityVerificationBatch(value, expectedRevision, bindings) {
  const message = "input authority batch verification result is invalid";
  const result = exactProjectionObject(
    value,
    ["ledgerRevision", "current"],
    message,
  );
  if (
    result.ledgerRevision !== expectedRevision ||
    !Array.isArray(result.current) ||
    result.current.length !== bindings.length ||
    result.current.some((current) => typeof current !== "boolean")
  ) {
    throw new TypeError(message);
  }
  return new Map(bindings.map((binding, index) => [
    authorityBindingDigest(binding),
    result.current[index],
  ]));
}

function verifiedBindingReader(currentByDigest) {
  return async (binding) => {
    const normalized = normalizePullRequestExecutionBinding(binding);
    if (currentByDigest.get(authorityBindingDigest(normalized)) !== true) {
      throw new Error("input authority is stale");
    }
    return structuredClone(normalized);
  };
}

function authorityContent(binding, current) {
  return {
    applies: true,
    current,
    bindingDigest: authorityBindingDigest(binding),
    inputBinding: binding,
  };
}

function projectionTags(kind, status, actionType, current) {
  return [kind, status, actionType, ...(current ? [] : ["obsolete"])];
}

function confirmationMemoryRecord(item, current, previousRecordId) {
  const binding = item.action.inputBinding;
  const content = {
    memoryType: "confirmation",
    confirmationId: item.confirmationId,
    itemRevision: item.itemRevision,
    statusDigest: item.statusDigest,
    kind: item.kind,
    status: item.status,
    requestedBy: item.requestedBy,
    actor: item.actor,
    target: item.target,
    action: item.action,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ownerDecision: item.ownerDecision,
    authority: authorityContent(binding, current),
  };
  return boundedRecord({
    sourceKind: "confirmation",
    sourceKey:
      `${item.confirmationId}:revision:${item.itemRevision}:${item.statusDigest}`,
    occurredAt: item.updatedAt,
    roleId: item.requestedBy.roleId,
    binding,
    eventType: `confirmation.${item.status}`,
    title: `确认 ${item.action.type}：${binding.repository}#${binding.pullRequestNumber}`,
    summary: `${item.status} · ${item.actor.accountId} · ${item.target.resourceId}`,
    content,
    evidence: previousRecordId === null
      ? []
      : [`supersedes:${previousRecordId}`],
    tags: projectionTags(
      "confirmation",
      item.status,
      item.action.type,
      current,
    ),
  });
}

function hasExternalResult(item) {
  return item.execution !== null ||
    ["completed", "failed"].includes(item.status);
}

function externalResultMemoryRecord(
  item,
  current,
  confirmationRecordId,
  previousRecordId,
) {
  const binding = item.action.inputBinding;
  const content = {
    memoryType: "external-result",
    confirmationId: item.confirmationId,
    itemRevision: item.itemRevision,
    statusDigest: item.statusDigest,
    kind: item.kind,
    status: item.status,
    actionType: item.action.type,
    actor: item.actor,
    target: item.target,
    inputBinding: binding,
    execution: item.execution,
    receipt: item.receipt,
    failure: item.failure,
    rejectedAt: item.rejectedAt,
    ownerDecision: item.ownerDecision,
    invalidation: item.invalidation,
    updatedAt: item.updatedAt,
    authority: authorityContent(binding, current),
  };
  const evidence = [
    `confirmation-record:${confirmationRecordId}`,
    ...(item.receipt === null ? [] : [`receipt:${item.receipt.id}`]),
    ...(previousRecordId === null ? [] : [`supersedes:${previousRecordId}`]),
  ];
  return boundedRecord({
    sourceKind: "external-result",
    sourceKey:
      `${item.confirmationId}:revision:${item.itemRevision}:${item.statusDigest}`,
    occurredAt: item.updatedAt,
    roleId: item.requestedBy.roleId,
    binding,
    eventType: `external_result.${item.status}`,
    title: `外部结果 ${item.action.type}：${binding.repository}#${binding.pullRequestNumber}`,
    summary: item.receipt === null
      ? `${item.status} · ${item.actor.accountId}`
      : `${item.status} · receipt ${item.receipt.id}`,
    content,
    evidence,
    tags: projectionTags(
      "external-result",
      item.status,
      item.action.type,
      current,
    ),
  });
}

function timelineProjectionKind(entry) {
  if (
    entry.type === "proposal_result_applied" &&
    SHA256.test(entry.details?.resultAttestationDigest) &&
    workDecisionFromTimeline(entry) !== null
  ) {
    return "work-decision";
  }
  if (
    entry.type === "intent_staged" &&
    entry.details?.intentType === "ask_user" &&
    entry.details?.consultationRequest
  ) {
    return "consultation-request";
  }
  if (["attention_answer_applied", "attention_rejection_applied"].includes(
    entry.type,
  ) && SHA256.test(entry.details?.resultAttestationDigest)) {
    return "consultation-result";
  }
  return null;
}

function workDecisionFromTimeline(entry) {
  const details = plainData(entry?.details);
  const decision = plainData(details?.decision);
  const value = plainData(decision?.value);
  if (
    details === null ||
    decision === null ||
    value === null ||
    !Number.isSafeInteger(details.workItemRevision) ||
    details.workItemRevision < 1 ||
    decision.source !== "proposal" ||
    decision.referenceId !== details.proposalId ||
    decision.outcome !== details.outcome ||
    value.resultId !== details.resultRef ||
    !SHA256.test(details.resultAttestationDigest) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(details.evidenceRefs) ||
    !validTimestamp(decision.observedAt) ||
    !SHA256.test(decision.contentDigest)
  ) {
    return null;
  }
  let expectedDigest;
  try {
    expectedDigest = digestValue({
      source: decision.source,
      referenceId: decision.referenceId,
      outcome: decision.outcome,
      value: decision.value,
      observedAt: decision.observedAt,
    });
    if (digestValue(value.evidence) !== digestValue(details.evidenceRefs)) {
      return null;
    }
  } catch {
    return null;
  }
  if (decision.contentDigest !== expectedDigest) {
    return null;
  }
  return {
    workItemRevision: details.workItemRevision,
    decision: structuredClone(decision),
  };
}

function timelineBinding(entry, item) {
  if (Object.hasOwn(entry.details ?? {}, "inputBinding")) {
    if (entry.details.inputBinding === null) {
      return currentWorkItemInputBinding(item) === null ? null : undefined;
    }
    try {
      return normalizePullRequestExecutionBinding(entry.details.inputBinding);
    } catch {
      return undefined;
    }
  }
  const sourceBinding = currentWorkItemInputBinding(item);
  if (sourceBinding !== null) {
    // Legacy PR timelines did not seal their historical execution binding.
    // Never reinterpret them using a newer current Head.
    return undefined;
  }
  return null;
}

function timelineAuthorityContent(binding, current) {
  return binding === null
    ? {
        applies: false,
        current: true,
        bindingDigest: null,
        inputBinding: null,
      }
    : authorityContent(binding, current);
}

function timelineMemoryRecord(
  entry,
  item,
  kind,
  binding,
  current,
  previousRecordId,
) {
  const event = currentWorkItemEvent(item);
  const repository = event?.subject?.repository ?? null;
  const number = event?.subject?.number ?? null;
  const sourceKey = `${entry.timelineId}:${digestValue({
    type: entry.type,
    details: entry.details,
    authority: timelineAuthorityContent(binding, current),
  })}`;
  const workDecision = kind === "work-decision"
    ? workDecisionFromTimeline(entry)
    : null;
  const content = {
    memoryType: kind,
    timelineId: entry.timelineId,
    workItemId: entry.itemId,
    ...(workDecision === null ? {} : workDecision),
    decisionType: entry.type,
    actorId: entry.actorId,
    details: entry.details,
    occurredAt: entry.at,
    authority: timelineAuthorityContent(binding, current),
  };
  const fingerprint = digestValue({ kind, sourceKey, content });
  return {
    schemaVersion: 1,
    source: { kind, id: `${sourceKey}:${fingerprint}` },
    occurredAt: entry.at,
    roleId: safeRole(item?.currentTarget?.id) || safeRole(entry.actorId),
    repository: safeRepository(repository),
    eventType: `${kind.replaceAll("-", "_")}.${entry.type}`,
    title: `${kind}：${safeText(event?.payload?.title || entry.itemId, 1_024)}`,
    summary: `${entry.type} · ${entry.itemId}`,
    content: JSON.stringify(content),
    evidence: previousRecordId === null
      ? []
      : [`supersedes:${previousRecordId}`],
    tags: [kind, entry.type, ...(current ? [] : ["obsolete"])],
    sourceUrl: null,
    subjectNumber: safeNumber(number),
  };
}

function authorityProjectionEntry({
  key,
  fingerprint,
  recordId,
  sourceKind,
  binding,
  current,
  occurredAt,
}) {
  return {
    key,
    fingerprint,
    recordId,
    sourceKind,
    binding: binding === null
      ? null
      : normalizePullRequestExecutionBinding(binding),
    current,
    occurredAt,
  };
}


function normalizeGraphProjectionBatch(value) {
  const message = "task graph memory projection source batch is invalid";
  const batch = exactProjectionObject(
    value,
    [
      "cursor",
      "highWatermark",
      "checkpointDigest",
      "highWatermarkDigest",
      "authorityStateDigest",
      "items",
    ],
    message,
  );
  const cursor = nonNegativeInteger(batch.cursor, message);
  const highWatermark = nonNegativeInteger(batch.highWatermark, message);
  const checkpointDigest = batch.checkpointDigest;
  const highWatermarkDigest = batch.highWatermarkDigest;
  const authorityStateDigest = batch.authorityStateDigest;
  const digestOrNull = (candidate) =>
    candidate === null || /^[a-f0-9]{64}$/.test(candidate);
  if (
    !digestOrNull(checkpointDigest) ||
    !digestOrNull(highWatermarkDigest) ||
    typeof authorityStateDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(authorityStateDigest) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    (highWatermark === 0) !== (highWatermarkDigest === null)
  ) {
    throw new TypeError(message);
  }
  if (highWatermark < cursor) throw new TypeError(message);
  let items;
  try {
    items = strictProjectionList(batch.items, GRAPH_BATCH_LIMIT, message)
      .map((event) => normalizeWorkGraphMemoryEvent(event));
  } catch {
    throw new TypeError(message);
  }
  if (items.length === 0) {
    if (cursor !== highWatermark) throw new TypeError(message);
    return {
      cursor,
      highWatermark,
      checkpointDigest,
      highWatermarkDigest,
      authorityStateDigest,
      items,
    };
  }
  for (let index = 0; index < items.length; index += 1) {
    const event = items[index];
    if (event.sequence !== cursor + index + 1) throw new TypeError(message);
    if (index > 0 && event.previousDigest !== items[index - 1].eventDigest) {
      throw new TypeError(message);
    }
  }
  if (items.at(-1).sequence > highWatermark) throw new TypeError(message);
  return {
    cursor,
    highWatermark,
    checkpointDigest,
    highWatermarkDigest,
    authorityStateDigest,
    items,
  };
}

function normalizeMemoryAuthoritySnapshot(value) {
  const message = "memory authority snapshot is invalid";
  const snapshot = exactProjectionObject(
    value,
    ["ledgerRevision", "items", "timeline", "graph"],
    message,
  );
  const ledgerRevision = nonNegativeInteger(snapshot.ledgerRevision, message);
  const items = dataList(snapshot.items, 20_000);
  const timeline = dataList(snapshot.timeline, 50_000);
  if (items === null || timeline === null) throw new TypeError(message);
  return {
    ledgerRevision,
    items,
    timeline,
    graph: normalizeGraphProjectionBatch(snapshot.graph),
  };
}

function normalizeLocalMemoryAuthorityState(value) {
  const message = "local memory authority state is invalid";
  const state = exactProjectionObject(
    value,
    [
      "cursor",
      "checkpointDigest",
      "authorityStateDigest",
      "workLedgerRevision",
    ],
    message,
  );
  const cursor = nonNegativeInteger(state.cursor, message);
  const workLedgerRevision = nonNegativeInteger(
    state.workLedgerRevision,
    message,
  );
  const checkpointDigest = state.checkpointDigest;
  if (
    !(
      checkpointDigest === null ||
      (typeof checkpointDigest === "string" && /^[a-f0-9]{64}$/.test(checkpointDigest))
    ) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    typeof state.authorityStateDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.authorityStateDigest)
  ) {
    throw new TypeError(message);
  }
  return {
    cursor,
    checkpointDigest,
    authorityStateDigest: state.authorityStateDigest,
    workLedgerRevision,
  };
}

function memorySnapshotIsProjected(snapshot, localAuthority) {
  const graph = snapshot.graph;
  return (
    graph.items.length === 0 &&
    graph.cursor === graph.highWatermark &&
    localAuthority.cursor === graph.cursor &&
    localAuthority.checkpointDigest === graph.checkpointDigest &&
    localAuthority.workLedgerRevision === snapshot.ledgerRevision &&
    localAuthority.authorityStateDigest === graph.authorityStateDigest
  );
}

function authorityProjectionObservationCounts(snapshot, confirmationSnapshot) {
  let externalResults = 0;
  for (const item of confirmationSnapshot.items) {
    if (hasExternalResult(item)) externalResults += 1;
  }
  const itemById = new Map(snapshot.items.map((item) => [item.itemId, item]));
  let decisions = 0;
  let consultations = 0;
  for (const entry of snapshot.timeline) {
    const kind = timelineProjectionKind(entry);
    const item = itemById.get(entry.itemId);
    if (
      kind === null ||
      item === undefined ||
      timelineBinding(entry, item) === undefined
    ) {
      continue;
    }
    if (kind === "work-decision") decisions += 1;
    else consultations += 1;
  }
  return {
    observed:
      confirmationSnapshot.items.length +
      externalResults +
      decisions +
      consultations,
    confirmations: confirmationSnapshot.items.length,
    externalResults,
    decisions,
    consultations,
  };
}

function normalizeGraphAppendResult(value, expectedRecords) {
  const message = "task graph memory append receipt is invalid";
  const result = plainData(value);
  if (
    result === null ||
    Object.keys(result).some((key) => !["added", "items", "health"].includes(key)) ||
    !Object.hasOwn(result, "added") ||
    !Object.hasOwn(result, "items")
  ) {
    throw new TypeError(message);
  }
  const added = nonNegativeInteger(result.added, message);
  const receipts = strictProjectionList(
    result.items,
    expectedRecords.length,
    message,
  );
  if (receipts.length !== expectedRecords.length || added > receipts.length) {
    throw new TypeError(message);
  }
  let created = 0;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = exactProjectionObject(
      receipts[index],
      ["recordId", "created"],
      message,
    );
    if (
      receipt.recordId !== expectedRecords[index].recordId ||
      typeof receipt.created !== "boolean"
    ) {
      throw new TypeError(message);
    }
    if (receipt.created) created += 1;
  }
  if (created !== added) throw new TypeError(message);
  return { added };
}

function normalizeGraphAckResult(value, event, minimumHighWatermark) {
  const message = "task graph memory acknowledgement is invalid";
  const result = exactProjectionObject(
    value,
    ["status", "cursor", "highWatermark"],
    message,
  );
  const cursor = nonNegativeInteger(result.cursor, message);
  const highWatermark = nonNegativeInteger(result.highWatermark, message);
  if (
    !["applied", "already"].includes(result.status) ||
    cursor !== event.sequence ||
    highWatermark < minimumHighWatermark ||
    highWatermark < cursor
  ) {
    throw new TypeError(message);
  }
  return { cursor, highWatermark };
}

export async function planAuthorityBoundProjectionCandidate(value) {
  const message = "authority-bound memory projection plan is invalid";
  const request = exactProjectionObject(
    value,
    [
      "stored",
      "snapshot",
      "confirmationSnapshot",
      "verifyInputAuthority",
      "requiresJournalAdoption",
      "strictBindings",
    ],
    message,
  );
  if (
    typeof request.verifyInputAuthority !== "function" ||
    typeof request.requiresJournalAdoption !== "boolean" ||
    typeof request.strictBindings !== "boolean"
  ) {
    throw new TypeError(message);
  }
  const stored = normalizeProjectionPlannerState(request.stored);
  const snapshot = normalizeMemoryAuthoritySnapshot(request.snapshot);
  const confirmationSnapshot = normalizeConfirmationMemorySnapshot(
    request.confirmationSnapshot,
  );
  const readBindingAuthority = memoizedBindingAuthority(
    request.verifyInputAuthority,
    { strict: request.strictBindings },
  );
  const entries = new Map(stored.entries.map((entry) => [entry.key, entry]));
  const observedKeys = new Set();
  const records = [];
  const project = (descriptor, factory) => {
    const { key, fingerprint } = descriptor;
    observedKeys.add(key);
    const previous = entries.get(key) ?? null;
    if (previous?.fingerprint === fingerprint) {
      entries.set(key, authorityProjectionEntry({
        ...descriptor,
        recordId: previous.recordId,
      }));
      return previous.recordId;
    }
    const record = factory(previous?.recordId ?? null);
    const normalizedRecord = normalizeMemoryRecord(record);
    records.push(record);
    entries.set(key, authorityProjectionEntry({
      ...descriptor,
      recordId: normalizedRecord.recordId,
    }));
    return normalizedRecord.recordId;
  };

  let externalResults = 0;
  for (const item of confirmationSnapshot.items) {
    const current = await readBindingAuthority(
      item.action.inputBinding,
      { stale: item.status === "stale" },
    );
    const confirmationKey = `confirmation:${item.confirmationId}`;
    const confirmationFingerprint = digestValue({
      memoryType: "confirmation",
      item,
      current,
    });
    const confirmationRecordId = project(
      {
        key: confirmationKey,
        fingerprint: confirmationFingerprint,
        sourceKind: "confirmation",
        binding: item.action.inputBinding,
        current,
        occurredAt: item.updatedAt,
      },
      (previousRecordId) =>
        confirmationMemoryRecord(item, current, previousRecordId),
    );
    if (!hasExternalResult(item)) continue;
    externalResults += 1;
    const externalKey = `external-result:${item.confirmationId}`;
    const externalFingerprint = digestValue({
      memoryType: "external-result",
      item,
      current,
      confirmationRecordId,
    });
    project(
      {
        key: externalKey,
        fingerprint: externalFingerprint,
        sourceKind: "external-result",
        binding: item.action.inputBinding,
        current,
        occurredAt: item.updatedAt,
      },
      (previousRecordId) =>
        externalResultMemoryRecord(
          item,
          current,
          confirmationRecordId,
          previousRecordId,
        ),
    );
  }

  const itemById = new Map(snapshot.items.map((item) => [item.itemId, item]));
  let decisions = 0;
  let consultations = 0;
  for (const entry of snapshot.timeline) {
    const kind = timelineProjectionKind(entry);
    if (kind === null) continue;
    const item = itemById.get(entry.itemId);
    if (item === undefined) continue;
    const binding = timelineBinding(entry, item);
    if (binding === undefined) continue;
    const current = binding === null
      ? true
      : await readBindingAuthority(binding, {
          stale: item.status === "superseded",
        });
    const key = `${kind}:${entry.timelineId}`;
    const fingerprint = digestValue({
      memoryType: kind,
      entry,
      binding,
      current,
    });
    project(
      {
        key,
        fingerprint,
        sourceKind: kind,
        binding,
        current,
        occurredAt: entry.at,
      },
      (previousRecordId) =>
        timelineMemoryRecord(
          entry,
          item,
          kind,
          binding,
          current,
          previousRecordId,
        ),
    );
    if (kind === "work-decision") decisions += 1;
    else consultations += 1;
  }

  let lifecycleInvalidations = 0;
  for (const [key, entry] of entries) {
    if (observedKeys.has(key)) continue;
    if (entry.current !== true || entry.binding === null) {
      if (entry.current !== false) {
        records.push(authorityLifecycleMemoryRecord(entry));
        lifecycleInvalidations += 1;
      }
      entries.delete(key);
      continue;
    }
    if (await readBindingAuthority(entry.binding)) continue;
    records.push(authorityLifecycleMemoryRecord(entry));
    lifecycleInvalidations += 1;
    entries.delete(key);
  }

  if (entries.size > AUTHORITY_PROJECTION_MAXIMUM_ENTRIES) {
    throw new TypeError("authority-bound memory projection exceeds capacity");
  }
  const nextEntries = [...entries.values()].sort((left, right) =>
    left.key.localeCompare(right.key, "en")
  );
  const projectionStateChanged =
    digestValue(nextEntries) !== digestValue(stored.entries);
  const changed =
    records.length > 0 ||
    projectionStateChanged ||
    request.requiresJournalAdoption ||
    stored.workLedgerRevision !== snapshot.ledgerRevision ||
    stored.authorityStateDigest !== snapshot.graph.authorityStateDigest ||
    stored.confirmationHighWatermark !== confirmationSnapshot.highWatermark;
  const projectionState = changed
    ? normalizeLegacyAuthorityProjectionState({
        schemaVersion: AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION,
        revision: stored.revision + 1,
        workLedgerRevision: snapshot.ledgerRevision,
        authorityStateDigest: snapshot.graph.authorityStateDigest,
        confirmationHighWatermark: confirmationSnapshot.highWatermark,
        entries: nextEntries,
      })
    : null;
  return {
    records: structuredClone(records),
    projectionState,
    observed:
      confirmationSnapshot.items.length +
      externalResults +
      decisions +
      consultations,
    confirmations: confirmationSnapshot.items.length,
    externalResults,
    decisions,
    consultations,
    lifecycleInvalidations,
    highWatermark: confirmationSnapshot.highWatermark,
  };
}

export class MemoryProjector {
  #adoptGraphCheckpoint;
  #appendGraphEvents;
  #appendProjectionRecords;
  #appendAuthorityProjection;
  #appendWorkItems;
  #getAuthorityState;
  #getAuthorityProjectionState;
  #requiresAuthorityProjectionCheckpoint;
  #graphAckBatch;
  #readConfirmationPage;
  #readSnapshot;
  #store;
  #verifyInputAuthority;
  #verifyInputAuthorityBatch;
  #inFlight = null;

  constructor({
    memoryLifecycleProducer,
    memoryAuthorityReader,
    memoryAuthoritySource,
    graphProjectionSource,
    confirmationProjectionSource,
    inputAuthorityVerifier,
    inputAuthorityBatchVerifier,
    store,
  } = {}) {
    const lifecycle = requirePort(
      memoryLifecycleProducer,
      [
        "appendWorkItems",
        "appendGraphEvents",
        "appendProjectionRecords",
        "adoptGraphCheckpoint",
      ],
      "memoryLifecycleProducer",
    );
    this.#appendWorkItems = lifecycle.appendWorkItems;
    this.#appendGraphEvents = lifecycle.appendGraphEvents;
    this.#appendProjectionRecords = lifecycle.appendProjectionRecords;
    this.#appendAuthorityProjection = null;
    this.#adoptGraphCheckpoint = lifecycle.adoptGraphCheckpoint;
    this.#getAuthorityState = requirePort(
      memoryAuthorityReader,
      ["getAuthorityState"],
      "memoryAuthorityReader",
    ).getAuthorityState;
    this.#getAuthorityProjectionState = null;
    this.#requiresAuthorityProjectionCheckpoint = null;
    this.#readSnapshot = requirePort(
      memoryAuthoritySource,
      ["readSnapshot"],
      "memoryAuthoritySource",
    ).readSnapshot;
    const graphSource = requirePort(
      graphProjectionSource,
      ["ackBatch"],
      "graphProjectionSource",
    );
    this.#graphAckBatch = graphSource.ackBatch;
    if (!store || typeof store.read !== "function") {
      throw new TypeError("MemoryProjector requires a store");
    }
    this.#verifyInputAuthority = inputAuthorityVerifier === undefined
      ? null
      : requirePort(
          inputAuthorityVerifier,
          ["verify"],
          "inputAuthorityVerifier",
        ).verify;
    this.#verifyInputAuthorityBatch = inputAuthorityBatchVerifier === undefined
      ? null
      : requirePort(
          inputAuthorityBatchVerifier,
          ["verify"],
          "inputAuthorityBatchVerifier",
        ).verify;
    this.#readConfirmationPage = confirmationProjectionSource === undefined
      ? null
      : requirePort(
          confirmationProjectionSource,
          ["readMemoryPage"],
          "confirmationProjectionSource",
        ).readMemoryPage;
    if (
      this.#readConfirmationPage !== null &&
      this.#verifyInputAuthority === null
    ) {
      throw new TypeError(
        "confirmationProjectionSource requires inputAuthorityVerifier",
      );
    }
    if (
      this.#verifyInputAuthority !== null &&
      typeof store.write !== "function"
    ) {
      throw new TypeError(
        "authority-bound memory projection requires a writable store",
      );
    }
    const canCheckpointAuthority =
      typeof memoryLifecycleProducer?.appendAuthorityProjection === "function" &&
      typeof memoryAuthorityReader?.getAuthorityProjectionState === "function";
    if (canCheckpointAuthority) {
      this.#appendAuthorityProjection = requirePort(
        memoryLifecycleProducer,
        ["appendAuthorityProjection"],
        "memoryLifecycleProducer",
      ).appendAuthorityProjection;
      this.#getAuthorityProjectionState = requirePort(
        memoryAuthorityReader,
        ["getAuthorityProjectionState"],
        "memoryAuthorityReader",
      ).getAuthorityProjectionState;
      if (
        typeof memoryAuthorityReader?.requiresAuthorityProjectionCheckpoint ===
          "function"
      ) {
        this.#requiresAuthorityProjectionCheckpoint =
          memoryAuthorityReader.requiresAuthorityProjectionCheckpoint.bind(
            memoryAuthorityReader,
          );
      }
    } else if (this.#verifyInputAuthority !== null) {
      throw new TypeError(
        "authority-bound memory projection requires checkpoint ports",
      );
    }
    this.#store = store;
  }

  runCycle(value) {
    const { signal } = normalizeCycleOptions(value);
    // One projection cycle is one admitted write sequence. Joiners observe the
    // same completion, while only the caller that admitted it owns cancellation.
    if (this.#inFlight) return this.#inFlight;
    const execution = Promise.resolve().then(() => this.#run(signal));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run(signal) {
    const initial = normalizeMemoryAuthoritySnapshot(
      await runProjectionPort(signal, () =>
        this.#readSnapshot({ limit: GRAPH_BATCH_LIMIT })
      ),
    );
    const confirmationPreflight = this.#verifyInputAuthority === null
      ? null
      : await readConfirmationMemorySnapshot(this.#readConfirmationPage, signal);
    const graph = initial.graph;
    const localAuthority = normalizeLocalMemoryAuthorityState(
      await runProjectionPort(signal, () => this.#getAuthorityState()),
    );
    const workSnapshotAlreadyProjected = memorySnapshotIsProjected(
      initial,
      localAuthority,
    );
    if (localAuthority.cursor === 0 && graph.cursor > 0) {
      await runProjectionPort(signal, () =>
        this.#adoptGraphCheckpoint({
          cursor: graph.cursor,
          checkpointDigest: graph.checkpointDigest,
          ledgerRevision: initial.ledgerRevision,
          authorityStateDigest: graph.authorityStateDigest,
        })
      );
    }
    let graphAdded = 0;
    let graphCursor = graph.cursor;
    let graphHighWatermark = graph.highWatermark;
    if (graph.items.length > 0) {
      const records = graph.items.map(memoryRecordForWorkGraphMemoryEvent);
      const expectedRecords = records.map((record) => normalizeMemoryRecord(record));
      graphAdded = normalizeGraphAppendResult(
        await runProjectionPort(signal, () =>
          this.#appendGraphEvents({
            events: graph.items,
            ledgerRevision: initial.ledgerRevision,
            highWatermark: graph.highWatermark,
            authorityStateDigest: graph.authorityStateDigest,
          })
        ),
        expectedRecords,
      ).added;
      const acknowledgement = normalizeGraphAckResult(
        await runProjectionPort(signal, () =>
          this.#graphAckBatch({
            receipts: graph.items.map(workGraphMemoryRecordReceipt),
          })
        ),
        graph.items.at(-1),
        graphHighWatermark,
      );
      graphCursor = acknowledgement.cursor;
      graphHighWatermark = acknowledgement.highWatermark;
    }
    const finalSnapshot = workSnapshotAlreadyProjected
      ? initial
      : normalizeMemoryAuthoritySnapshot(
          await runProjectionPort(signal, () =>
            this.#readSnapshot({ limit: GRAPH_BATCH_LIMIT })
          ),
        );
    const { items, timeline } = finalSnapshot;
    const legacy = await runProjectionPort(signal, () =>
      this.#store.read("pr-employee-memory", [])
    );
    const state = { items };
    const workRecords = workSnapshotAlreadyProjected
      ? []
      : items.map((item) => workItemRecord(item, state)).filter(Boolean);
    const itemById = new Map(items.map((item) => [item.itemId, item]));
    const historyRecords = [
      ...(workSnapshotAlreadyProjected
        ? []
        : timeline.map((entry) => timelineRecord(entry, itemById))),
      ...(Array.isArray(legacy) ? legacy.map(legacyRecord) : []),
    ].filter(Boolean);
    let added = 0;
    for (let index = 0; index < historyRecords.length; index += WRITE_BATCH) {
      const result = await runProjectionPort(signal, () =>
        this.#appendProjectionRecords({
          records: historyRecords.slice(index, index + WRITE_BATCH),
        })
      );
      added += Number(result?.added) || 0;
    }
    const workResult = workSnapshotAlreadyProjected
      ? { added: 0 }
      : await runProjectionPort(signal, () =>
          this.#appendWorkItems({
            records: workRecords,
            ledgerRevision: finalSnapshot.ledgerRevision,
            authorityStateDigest: finalSnapshot.graph.authorityStateDigest,
            graphCursor: finalSnapshot.graph.cursor,
            graphCheckpointDigest: finalSnapshot.graph.checkpointDigest,
          })
        );
    added += Number(workResult?.added) || 0;
    let authorityBound = null;
    if (this.#verifyInputAuthority === null) {
      authorityBound = await this.#projectAuthorityBoundRecords(finalSnapshot, null, signal);
    } else {
      for (let attempt = 1; attempt <= AUTHORITY_SNAPSHOT_ATTEMPTS; attempt++) {
        const confirmationSnapshot = confirmationPreflight === null ? null
          : await readConfirmationMemorySnapshot(this.#readConfirmationPage, signal);
        // History/work projection may be long. Capture authority immediately
        // before verification; a retry must rebuild bindings from a new read.
        const authoritySnapshot = normalizeMemoryAuthoritySnapshot(
          await runProjectionPort(signal, () => this.#readSnapshot({ limit: GRAPH_BATCH_LIMIT })),
        );
        try {
          authorityBound = await this.#projectAuthorityBoundRecords(authoritySnapshot, confirmationSnapshot, signal);
          break;
        } catch (error) {
          throwIfProjectionAborted(signal);
          if (error?.code !== "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE") throw error;
          if (attempt === AUTHORITY_SNAPSHOT_ATTEMPTS) authorityBound = {
            status: "deferred", code: error.code, attempts: attempt, observed: 0, added: 0,
          };
        }
      }
    }
    throwIfProjectionAborted(signal);
    added += authorityBound?.added ?? 0;
    return {
      observed:
        historyRecords.length +
        workRecords.length +
        graph.items.length +
        (authorityBound?.observed ?? 0),
      added: added + graphAdded,
      workItems: items.length,
      timeline: timeline.length,
      legacy: Array.isArray(legacy) ? legacy.length : 0,
      graph: {
        observed: graph.items.length,
        added: graphAdded,
        acknowledged: graphCursor - graph.cursor,
        cursor: graphCursor,
        highWatermark: graphHighWatermark,
        pending: graphHighWatermark - graphCursor,
      },
      ...(authorityBound === null ? {} : { authorityBound }),
    };
  }

  async #projectAuthorityBoundRecords(snapshot, confirmationSnapshot, signal) {
    if (this.#verifyInputAuthority === null) {
      if (
        this.#appendAuthorityProjection === null ||
        this.#getAuthorityProjectionState === null ||
        this.#requiresAuthorityProjectionCheckpoint === null
      ) {
        return null;
      }
      const stored = normalizeLegacyAuthorityProjectionState(
        await runProjectionPort(signal, () =>
          this.#getAuthorityProjectionState()
        ),
      );
      const authorityMemoryExists =
        stored.entries.length > 0 ||
        await runProjectionPort(signal, () =>
          this.#requiresAuthorityProjectionCheckpoint()
        );
      if (authorityMemoryExists) return null;
      if (
        stored.workLedgerRevision !== snapshot.ledgerRevision ||
        stored.authorityStateDigest !== snapshot.graph.authorityStateDigest
      ) {
        const nextState = {
          schemaVersion: AUTHORITY_PROJECTION_STATE_SCHEMA_VERSION,
          revision: stored.revision + 1,
          workLedgerRevision: snapshot.ledgerRevision,
          authorityStateDigest: snapshot.graph.authorityStateDigest,
          confirmationHighWatermark: stored.confirmationHighWatermark,
          entries: [],
        };
        normalizeLegacyAuthorityProjectionState(nextState);
        await runProjectionPort(signal, () =>
          this.#appendAuthorityProjection({
            records: [],
            projectionState: nextState,
          })
        );
      }
      return {
        observed: 0,
        added: 0,
        confirmations: 0,
        externalResults: 0,
        decisions: 0,
        consultations: 0,
        lifecycleInvalidations: 0,
      };
    }
    const journalState = normalizeLegacyAuthorityProjectionState(
      await runProjectionPort(signal, () =>
        this.#getAuthorityProjectionState()
      ),
    );
    const legacyState =
      journalState.revision === 0 &&
        journalState.workLedgerRevision === 0 &&
        journalState.authorityStateDigest === EMPTY_AUTHORITY_STATE_DIGEST &&
        journalState.confirmationHighWatermark === 0 &&
        journalState.entries.length === 0
        ? normalizeLegacyAuthorityProjectionState(
            await runProjectionPort(signal, () =>
              this.#store.read(
                LEGACY_AUTHORITY_PROJECTION_STATE_KEY,
                null,
              )
            ),
          )
        : null;
    const stored = legacyState === null ||
        (legacyState.revision === 0 && legacyState.entries.length === 0)
      ? journalState
      : {
          ...legacyState,
          revision: journalState.revision,
          workLedgerRevision: journalState.workLedgerRevision,
          authorityStateDigest: journalState.authorityStateDigest,
          confirmationHighWatermark:
            journalState.confirmationHighWatermark,
        };
    const requiresJournalAdoption = legacyState !== null &&
      (legacyState.revision > 0 || legacyState.entries.length > 0);
    if (
      !requiresJournalAdoption &&
      stored.workLedgerRevision === snapshot.ledgerRevision &&
      stored.authorityStateDigest === snapshot.graph.authorityStateDigest &&
      stored.confirmationHighWatermark === confirmationSnapshot.highWatermark
    ) {
      return {
        ...authorityProjectionObservationCounts(
          snapshot,
          confirmationSnapshot,
        ),
        added: 0,
        lifecycleInvalidations: 0,
        highWatermark: confirmationSnapshot.highWatermark,
      };
    }
    let verifyInputAuthority;
    if (this.#verifyInputAuthorityBatch === null) {
      verifyInputAuthority = (...args) =>
        runProjectionPort(signal, () => this.#verifyInputAuthority(...args));
    } else {
      const bindings = authorityProjectionBindings(
        stored,
        snapshot,
        confirmationSnapshot,
      );
      const currentByDigest = bindings.length === 0
        ? new Map()
        : normalizeAuthorityVerificationBatch(
            await runProjectionPort(signal, () =>
              this.#verifyInputAuthorityBatch({
                ledgerRevision: snapshot.ledgerRevision,
                bindings: structuredClone(bindings),
              })
            ),
            snapshot.ledgerRevision,
            bindings,
          );
      verifyInputAuthority = verifiedBindingReader(currentByDigest);
    }
    const plan = await planAuthorityBoundProjectionCandidate({
      stored,
      snapshot,
      confirmationSnapshot,
      verifyInputAuthority,
      requiresJournalAdoption,
      strictBindings: false,
    });
    throwIfProjectionAborted(signal);
    let added = 0;
    if (plan.projectionState !== null) {
      const expected = plan.records.map((record) =>
        normalizeMemoryRecord(record)
      );
      added = normalizeGraphAppendResult(
        await runProjectionPort(signal, () =>
          this.#appendAuthorityProjection({
            records: plan.records,
            projectionState: plan.projectionState,
          })
        ),
        expected,
      ).added;
    }
    return {
      observed: plan.observed,
      added,
      confirmations: plan.confirmations,
      externalResults: plan.externalResults,
      decisions: plan.decisions,
      consultations: plan.consultations,
      lifecycleInvalidations: plan.lifecycleInvalidations,
      highWatermark: plan.highWatermark,
    };
  }

}
