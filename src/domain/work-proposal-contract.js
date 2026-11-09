import { createHash } from "node:crypto";

import { normalizeDeliveryEvidenceTarget } from "./delivery-evidence-contract.js";

export const MAX_WORK_PROPOSAL_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESULT_ID = /^work-proposal-result-[a-f0-9]{64}$/;
const DISPATCH_INTENT_ID = /^work-dispatch-intent-[a-f0-9]{64}$/;
const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
const MAX_CANONICAL_ENTRIES = 5_000;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_STRING_BYTES = 32 * 1024;

export const WORK_PROPOSAL_KINDS = Object.freeze([
  "github_review_proposal",
  "github_pull_request_action_proposal",
  "code_action_proposal",
  "configuration_change_proposal",
]);

export const WORK_PROPOSAL_STATUSES = Object.freeze([
  "pending_delivery",
  "waiting_confirmation",
  "running",
  "waiting_retry",
  "succeeded",
  "rejected",
  "stale",
  "failed",
  "unknown",
]);

export const WORK_PROPOSAL_TERMINAL_STATUSES = Object.freeze([
  "succeeded",
  "rejected",
  "stale",
  "failed",
  "unknown",
]);

const PROPOSAL_KINDS = new Set(WORK_PROPOSAL_KINDS);
const TERMINAL_STATUSES = new Set(WORK_PROPOSAL_TERMINAL_STATUSES);
const RUNNER_NEXT_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter((status) => status !== "pending_delivery"),
);
const DEFAULT_WORK_PROPOSAL_ERROR = Symbol("defaultWorkProposalError");

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class WorkProposalError extends Error {
  constructor(code, message, statusCode = 400, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkProposalError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function workProposalError(code, message, statusCode = 400, options) {
  return new WorkProposalError(code, message, statusCode, options);
}

function invalid(message = "工作提案无效") {
  return workProposalError("INVALID_WORK_PROPOSAL", message);
}

function resolvedWorkProposalError(error) {
  return error === DEFAULT_WORK_PROPOSAL_ERROR ? invalid() : error;
}

function invalidRunnerRequest(message = "工作提案 runner 请求无效") {
  return workProposalError("INVALID_WORK_PROPOSAL_RUNNER_REQUEST", message);
}

function invalidResult(message = "工作提案结果无效") {
  return workProposalError("INVALID_WORK_PROPOSAL_RESULT", message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function workProposalDataEntries(
  value,
  error = DEFAULT_WORK_PROPOSAL_ERROR,
) {
  if (!isPlainObject(value)) throw resolvedWorkProposalError(error);
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw resolvedWorkProposalError(error);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function assertWorkProposalExactKeys(
  value,
  expected,
  error = DEFAULT_WORK_PROPOSAL_ERROR,
) {
  const keys = workProposalDataEntries(value, error).map(([key]) => key);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw resolvedWorkProposalError(error);
  }
  return value;
}

function assertAllowedKeys(value, allowed, error) {
  const keys = workProposalDataEntries(value, error).map(([key]) => key);
  if (keys.some((key) => !allowed.includes(key))) throw error;
  return value;
}

export function workProposalArrayValues(
  value,
  maximumLength,
  error = DEFAULT_WORK_PROPOSAL_ERROR,
) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw resolvedWorkProposalError(error);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw resolvedWorkProposalError(error);
    }
    result.push(descriptor.value);
  }
  return result;
}

export function boundedWorkProposalText(
  value,
  name,
  {
    minimumBytes = 1,
    maximumBytes = 256,
    pattern = null,
    error = DEFAULT_WORK_PROPOSAL_ERROR,
  } = {},
) {
  if (typeof value !== "string" || INVALID_TEXT_CONTROL.test(value)) {
    throw resolvedWorkProposalError(error);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw resolvedWorkProposalError(error);
  }
  return value;
}

export function safeWorkProposalInteger(
  value,
  name,
  {
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
    error = DEFAULT_WORK_PROPOSAL_ERROR,
  } = {},
) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw resolvedWorkProposalError(error);
  }
  return value;
}

function canonicalize(
  value,
  context = { depth: 0, entries: { count: 0 }, ancestors: new Set() },
) {
  context.entries.count += 1;
  if (
    context.entries.count > MAX_CANONICAL_ENTRIES ||
    context.depth > MAX_CANONICAL_DEPTH
  ) {
    throw invalid("工作提案内容过大或嵌套过深");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return boundedWorkProposalText(value, "JSON string", {
      minimumBytes: 0,
      maximumBytes: MAX_CANONICAL_STRING_BYTES,
    });
  }
  if (value === null || typeof value !== "object" || context.ancestors.has(value)) {
    throw invalid("工作提案内容必须是无环纯 JSON");
  }
  context.ancestors.add(value);
  const child = {
    depth: context.depth + 1,
    entries: context.entries,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      return workProposalArrayValues(value, MAX_CANONICAL_ENTRIES).map((entry) =>
        canonicalize(entry, child),
      );
    }
    const result = {};
    for (const [key, entry] of workProposalDataEntries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      if (Buffer.byteLength(key, "utf8") > 128) {
        throw invalid("工作提案字段名过长");
      }
      result[key] = canonicalize(entry, child);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

export function cloneWorkProposalValue(value) {
  return canonicalize(value);
}

export function workProposalDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function normalizeWorkProposalDigest(
  value,
  error = DEFAULT_WORK_PROPOSAL_ERROR,
) {
  return boundedWorkProposalText(value, "contentDigest", {
    maximumBytes: 64,
    pattern: SHA256,
    error,
  });
}

export function assertWorkProposalAuthorityBinding(
  proposal,
  binding,
  error = invalid("工作提案权威绑定无效"),
) {
  const requestedBy = normalizeRequestedBy(proposal?.requestedBy, error);
  workProposalDataEntries(binding, error);
  if (Object.hasOwn(binding, "dispatchIntentId")) {
    boundedWorkProposalText(
      binding.dispatchIntentId,
      "binding.dispatchIntentId",
      {
        maximumBytes: 128,
        pattern: DISPATCH_INTENT_ID,
        error,
      },
    );
  }
  if (!Object.hasOwn(binding, "evidenceTarget")) return null;

  let target;
  try {
    target = normalizeDeliveryEvidenceTarget(binding.evidenceTarget);
  } catch {
    throw error;
  }
  if (
    target.taskId !== requestedBy.workItemId ||
    target.roleId !== requestedBy.roleId
  ) {
    throw error;
  }
  return target;
}

export function normalizeWorkProposalTimestamp(
  value,
  error = DEFAULT_WORK_PROPOSAL_ERROR,
) {
  let timestamp;
  try {
    timestamp = value instanceof Date ? value.toISOString() : value;
  } catch {
    throw resolvedWorkProposalError(error);
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw resolvedWorkProposalError(error);
  }
  return timestamp;
}

export function normalizeWorkProposalReference(
  value,
  name,
  { maximumBytes = 192, error = DEFAULT_WORK_PROPOSAL_ERROR } = {},
) {
  return boundedWorkProposalText(value, name, {
    maximumBytes,
    pattern: SAFE_REFERENCE,
    error,
  });
}

function normalizeRequestedBy(value, error = DEFAULT_WORK_PROPOSAL_ERROR) {
  assertWorkProposalExactKeys(value, ["roleId", "workItemId"], error);
  return {
    roleId: boundedWorkProposalText(value.roleId, "requestedBy.roleId", {
      maximumBytes: 128,
      pattern: SAFE_ROLE_ID,
      error,
    }),
    workItemId: boundedWorkProposalText(
      value.workItemId,
      "requestedBy.workItemId",
      { maximumBytes: 256, error },
    ),
  };
}

function normalizeSource(value, error = DEFAULT_WORK_PROPOSAL_ERROR) {
  assertWorkProposalExactKeys(value, ["assignmentId", "eventId"], error);
  return {
    assignmentId: boundedWorkProposalText(value.assignmentId, "source.assignmentId", {
      maximumBytes: 256,
      error,
    }),
    eventId: boundedWorkProposalText(value.eventId, "source.eventId", {
      maximumBytes: 256,
      error,
    }),
  };
}

export function normalizeBoundWorkProposal(value) {
  const error = invalid();
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    error,
  );
  const proposalId = normalizeWorkProposalReference(
    value.proposalId,
    "proposalId",
    { error },
  );
  const policyVersion = safeWorkProposalInteger(
    value.policyVersion,
    "policyVersion",
    { minimum: 1, error },
  );
  if (!PROPOSAL_KINDS.has(value.kind)) throw error;
  if (!isPlainObject(value.binding) || !isPlainObject(value.payload)) throw error;
  const content = {
    policyVersion,
    kind: value.kind,
    requestedBy: normalizeRequestedBy(value.requestedBy, error),
    source: normalizeSource(value.source, error),
    binding: cloneWorkProposalValue(value.binding),
    payload: cloneWorkProposalValue(value.payload),
  };
  const normalized = {
    proposalId,
    contentDigest: workProposalDigest(content),
    ...content,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PROPOSAL_BYTES) {
    throw invalid("工作提案超过容量限制");
  }
  return normalized;
}

export function normalizeWorkProposalClaimRequest(value) {
  const error = invalidRunnerRequest();
  const fields = new Map(workProposalDataEntries(value, error));
  if (
    fields.size < 2 ||
    fields.size > 3 ||
    !fields.has("runnerId") ||
    !fields.has("leaseDurationMs") ||
    [...fields.keys()].some((key) =>
      !["runnerId", "leaseDurationMs", "excludeProposalIds"].includes(key)
    )
  ) {
    throw error;
  }
  const excludeProposalIds = fields.has("excludeProposalIds")
    ? workProposalArrayValues(fields.get("excludeProposalIds"), 100, error)
      .map((proposalId) =>
        normalizeWorkProposalReference(proposalId, "excludeProposalIds", {
          maximumBytes: 192,
          error,
        })
      )
    : [];
  if (new Set(excludeProposalIds).size !== excludeProposalIds.length) {
    throw error;
  }
  return {
    runnerId: normalizeWorkProposalReference(fields.get("runnerId"), "runnerId", {
      maximumBytes: 128,
      error,
    }),
    leaseDurationMs: safeWorkProposalInteger(
      fields.get("leaseDurationMs"),
      "leaseDurationMs",
      { minimum: 1_000, maximum: MAX_WORK_PROPOSAL_LEASE_DURATION_MS, error },
    ),
    excludeProposalIds,
  };
}

export function normalizeWorkProposalRunnerScope(value) {
  const error = invalidRunnerRequest();
  assertWorkProposalExactKeys(
    value,
    ["runnerId", "allowedKinds", "allowedRoleIds"],
    error,
  );
  const runnerId = normalizeWorkProposalReference(value.runnerId, "runnerId", {
    maximumBytes: 128,
    error,
  });
  const allowedKinds = workProposalArrayValues(
    value.allowedKinds,
    WORK_PROPOSAL_KINDS.length,
    error,
  ).map((kind) => {
    if (!PROPOSAL_KINDS.has(kind)) throw error;
    return kind;
  });
  const allowedRoleIds = workProposalArrayValues(
    value.allowedRoleIds,
    32,
    error,
  ).map((roleId) =>
    boundedWorkProposalText(roleId, "allowedRoleIds", {
      maximumBytes: 128,
      pattern: SAFE_ROLE_ID,
      error,
    }),
  );
  if (
    allowedKinds.length === 0 ||
    allowedRoleIds.length === 0 ||
    new Set(allowedKinds).size !== allowedKinds.length ||
    new Set(allowedRoleIds).size !== allowedRoleIds.length
  ) {
    throw error;
  }
  return {
    runnerId,
    allowedKinds: [...allowedKinds].sort(compareCodeUnits),
    allowedRoleIds: [...allowedRoleIds].sort(compareCodeUnits),
  };
}

function normalizeEvidence(value, error) {
  return workProposalArrayValues(value, 20, error).map((entry) =>
    boundedWorkProposalText(entry, "evidence", {
      maximumBytes: 2_048,
      error,
    }),
  );
}

function normalizeTransition(value, error) {
  const status = isPlainObject(value) ? value.status : null;
  if (!RUNNER_NEXT_STATUSES.has(status)) throw error;
  if (status === "waiting_confirmation" || status === "running") {
    assertWorkProposalExactKeys(
      value,
      ["status", "downstreamRef", "nextAttemptAt"],
      error,
    );
    return {
      status,
      downstreamRef: boundedWorkProposalText(
        value.downstreamRef,
        "transition.downstreamRef",
        { maximumBytes: 256, error },
      ),
      nextAttemptAt: normalizeWorkProposalTimestamp(value.nextAttemptAt, error),
    };
  }
  if (status === "waiting_retry") {
    assertWorkProposalExactKeys(
      value,
      ["status", "reason", "nextAttemptAt"],
      error,
    );
    return {
      status,
      reason: boundedWorkProposalText(value.reason, "transition.reason", {
        maximumBytes: 2_048,
        error,
      }),
      nextAttemptAt: normalizeWorkProposalTimestamp(value.nextAttemptAt, error),
    };
  }
  assertWorkProposalExactKeys(value, ["status", "summary", "evidence"], error);
  return {
    status,
    summary: boundedWorkProposalText(value.summary, "transition.summary", {
      maximumBytes: 4_096,
      error,
    }),
    evidence: normalizeEvidence(value.evidence, error),
  };
}

export function normalizeWorkProposalAdvanceRequest(value) {
  const error = invalidRunnerRequest();
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "expectedRevision",
      "runnerId",
      "leaseId",
      "transition",
    ],
    error,
  );
  return {
    proposalId: normalizeWorkProposalReference(value.proposalId, "proposalId", {
      error,
    }),
    contentDigest: normalizeWorkProposalDigest(value.contentDigest, error),
    expectedRevision: safeWorkProposalInteger(
      value.expectedRevision,
      "expectedRevision",
      { minimum: 1, error },
    ),
    runnerId: normalizeWorkProposalReference(value.runnerId, "runnerId", {
      maximumBytes: 128,
      error,
    }),
    leaseId: normalizeWorkProposalReference(value.leaseId, "leaseId", {
      maximumBytes: 192,
      error,
    }),
    transition: normalizeTransition(value.transition, error),
  };
}

export function normalizeWorkProposalResultCursor(value = {}) {
  const error = workProposalError(
    "INVALID_WORK_PROPOSAL_RESULT_CURSOR",
    "工作提案结果游标无效",
  );
  assertAllowedKeys(value, ["afterSequence", "limit"], error);
  return {
    afterSequence: safeWorkProposalInteger(
      Object.hasOwn(value, "afterSequence") ? value.afterSequence : 0,
      "afterSequence",
      { error },
    ),
    limit: safeWorkProposalInteger(
      Object.hasOwn(value, "limit") ? value.limit : 50,
      "limit",
      { minimum: 1, maximum: 100, error },
    ),
  };
}

function resultCore({ proposal, sequence, transition, downstreamRef, at }) {
  return {
    sequence,
    proposalId: proposal.proposalId,
    proposalContentDigest: proposal.contentDigest,
    kind: proposal.kind,
    requestedBy: cloneWorkProposalValue(proposal.requestedBy),
    outcome: transition.status,
    summary: transition.summary,
    evidence: cloneWorkProposalValue(transition.evidence),
    downstreamRef,
    at,
  };
}

export function createWorkProposalResult({
  proposal,
  sequence,
  transition,
  downstreamRef,
  at,
}) {
  if (!TERMINAL_STATUSES.has(transition?.status)) throw invalidResult();
  const core = resultCore({
    proposal,
    sequence: safeWorkProposalInteger(sequence, "result.sequence", {
      minimum: 1,
      error: invalidResult(),
    }),
    transition,
    downstreamRef:
      downstreamRef === null
        ? null
        : boundedWorkProposalText(downstreamRef, "result.downstreamRef", {
            maximumBytes: 256,
            error: invalidResult(),
          }),
    at: normalizeWorkProposalTimestamp(at, invalidResult()),
  });
  const contentDigest = workProposalDigest(core);
  return {
    resultId: `work-proposal-result-${contentDigest}`,
    contentDigest,
    ...core,
  };
}

export function normalizeWorkProposalResult(value) {
  const error = invalidResult();
  assertWorkProposalExactKeys(
    value,
    [
      "resultId",
      "contentDigest",
      "sequence",
      "proposalId",
      "proposalContentDigest",
      "kind",
      "requestedBy",
      "outcome",
      "summary",
      "evidence",
      "downstreamRef",
      "at",
    ],
    error,
  );
  if (!PROPOSAL_KINDS.has(value.kind) || !TERMINAL_STATUSES.has(value.outcome)) {
    throw error;
  }
  const core = {
    sequence: safeWorkProposalInteger(value.sequence, "result.sequence", {
      minimum: 1,
      error,
    }),
    proposalId: normalizeWorkProposalReference(value.proposalId, "result.proposalId", {
      error,
    }),
    proposalContentDigest: normalizeWorkProposalDigest(
      value.proposalContentDigest,
      error,
    ),
    kind: value.kind,
    requestedBy: normalizeRequestedBy(value.requestedBy, error),
    outcome: value.outcome,
    summary: boundedWorkProposalText(value.summary, "result.summary", {
      maximumBytes: 4_096,
      error,
    }),
    evidence: normalizeEvidence(value.evidence, error),
    downstreamRef:
      value.downstreamRef === null
        ? null
        : boundedWorkProposalText(value.downstreamRef, "result.downstreamRef", {
            maximumBytes: 256,
            error,
          }),
    at: normalizeWorkProposalTimestamp(value.at, error),
  };
  const contentDigest = workProposalDigest(core);
  if (
    value.contentDigest !== contentDigest ||
    value.resultId !== `work-proposal-result-${contentDigest}` ||
    !RESULT_ID.test(value.resultId) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESULT_BYTES
  ) {
    throw error;
  }
  return { resultId: value.resultId, contentDigest, ...core };
}

export function isTerminalWorkProposalStatus(value) {
  return TERMINAL_STATUSES.has(value);
}
