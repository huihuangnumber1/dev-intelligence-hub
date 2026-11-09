import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  normalizePullRequestExecutionBinding,
  pullRequestExecutionBindingMatchesEvent,
  samePullRequestExecutionBinding,
} from "./pull-request-execution-binding.js";
import { normalizeStoredWorkflowEvent } from "./workflow-events.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";

export function pullRequestReviewFeedbackDigest(value) {
  try {
    const facts = normalizePullRequestReadFacts(value);
    if (["comments", "reviews", "reviewThreads", "byteBudget"].some(key => facts.truncation[key]) ||
        facts.comments.some(comment => comment.bodyTruncated) || facts.reviews.some(review => review.bodyTruncated) ||
        facts.reviewThreads.some(thread => thread.commentsTruncated || thread.comments.some(comment => comment.bodyTruncated))) return null;
    return canonicalJsonDigest({ domain: "review-publication-feedback/v1", identity: facts.identity,
      reviewDecision: facts.reviewDecision, comments: facts.comments, reviews: facts.reviews, reviewThreads: facts.reviewThreads });
  } catch { return null; }
}

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

const IDENTITY_KEYS = Object.freeze([
  "schemaVersion",
  "executionBinding",
  "source",
  "identityDigest",
]);
const SOURCE_KEYS = Object.freeze(["provider", "scopeId"]);
const FACT_KEYS = Object.freeze([
  "schemaVersion",
  "identity",
  "observedAt",
  "reviewDecision",
  "comments",
  "reviews",
  "reviewThreads",
  "checks",
  "truncation",
  "contentDigest",
]);
const COMMENT_KEYS = Object.freeze([
  "id",
  "author",
  "body",
  "bodyTruncated",
  "createdAt",
  "updatedAt",
  "url",
]);
const REVIEW_KEYS = Object.freeze([
  "id",
  "author",
  "state",
  "submittedAt",
  "commitOid",
  "body",
  "bodyTruncated",
  "url",
]);
const THREAD_KEYS = Object.freeze([
  "id",
  "path",
  "line",
  "originalLine",
  "resolved",
  "outdated",
  "comments",
  "commentsTruncated",
]);
const THREAD_COMMENT_KEYS = Object.freeze([
  ...COMMENT_KEYS,
  "reviewId",
  "reviewState",
  "reviewSubmittedAt",
  "reviewCommitOid",
]);
const CHECK_KEYS = Object.freeze([
  "kind",
  "name",
  "status",
  "conclusion",
  "url",
  "startedAt",
  "completedAt",
  "requirement",
]);
const TRUNCATION_KEYS = Object.freeze([
  "comments",
  "reviews",
  "reviewThreads",
  "checks",
  "byteBudget",
]);

const REVIEW_DECISIONS = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
  "NONE",
  "UNKNOWN",
]);
const REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
  "UNKNOWN",
]);
const CHECK_KINDS = new Set(["check_run", "status_context"]);
const CHECK_STATUSES = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "COMPLETED",
  "PENDING",
  "EXPECTED",
  "REQUESTED",
  "WAITING",
  "UNKNOWN",
]);
const CHECK_CONCLUSIONS = new Set([
  "SUCCESS",
  "FAILURE",
  "NEUTRAL",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
  "NONE",
  "UNKNOWN",
]);
const CHECK_REQUIREMENTS = new Set(["required", "optional", "unknown"]);
const MAX_COLLECTION_ENTRIES = 100;
export const PULL_REQUEST_READ_BODY_BYTES = 64 * 1024;
const MAX_THREAD_COMMENTS = 20;
const MAX_FACT_BYTES = 512 * 1024;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_CONTEXT_COMMENTS = 4;
const MAX_CONTEXT_REVIEWS = 4;
const MAX_CONTEXT_THREADS = 8;
const MAX_CONTEXT_CHECKS = 20;
const CONTEXT_PROFILES = Object.freeze([
  Object.freeze({
    comments: MAX_CONTEXT_COMMENTS,
    reviews: MAX_CONTEXT_REVIEWS,
    threads: MAX_CONTEXT_THREADS,
    checks: MAX_CONTEXT_CHECKS,
    summaryChecks: MAX_CONTEXT_CHECKS,
    bodyBytes: 2 * 1024,
    pathBytes: 512,
    nameBytes: 512,
  }),
  Object.freeze({ comments: 4, reviews: 4, threads: 8, checks: 20,
    summaryChecks: 20, bodyBytes: 1024, pathBytes: 384, nameBytes: 384 }),
  Object.freeze({ comments: 3, reviews: 3, threads: 6, checks: 16,
    summaryChecks: 16, bodyBytes: 768, pathBytes: 256, nameBytes: 256 }),
  Object.freeze({ comments: 2, reviews: 2, threads: 4, checks: 12,
    summaryChecks: 12, bodyBytes: 512, pathBytes: 192, nameBytes: 192 }),
  Object.freeze({ comments: 1, reviews: 1, threads: 2, checks: 8,
    summaryChecks: 8, bodyBytes: 256, pathBytes: 128, nameBytes: 128 }),
  Object.freeze({ comments: 0, reviews: 0, threads: 1, checks: 4,
    summaryChecks: 4, bodyBytes: 128, pathBytes: 96, nameBytes: 96 }),
  Object.freeze({ comments: 0, reviews: 0, threads: 0, checks: 2,
    summaryChecks: 2, bodyBytes: 0, pathBytes: 0, nameBytes: 64 }),
  Object.freeze({ comments: 0, reviews: 0, threads: 0, checks: 0,
    summaryChecks: 0, bodyBytes: 0, pathBytes: 0, nameBytes: 0 }),
]);
const MAX_PASSIVE_DATA_DEPTH = 16;
const MAX_PASSIVE_DATA_ENTRIES = 2_000;

export class PullRequestReadFactsError extends Error {
  constructor(message = "pull request read facts are invalid") {
    super(message);
    this.name = "PullRequestReadFactsError";
    this.code = "INVALID_PULL_REQUEST_READ_FACTS";
    this.statusCode = 400;
  }
}

function invalid(message) {
  return new PullRequestReadFactsError(message);
}

function dataMap(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} is invalid`);
  }
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} is invalid`);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactDataMap(value, keys, name) {
  const fields = dataMap(value, name);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return fields;
}

function assertPassiveData(value, context, name) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw invalid(`${name} is invalid`);
  }
  if (context.depth >= MAX_PASSIVE_DATA_DEPTH || context.ancestors.has(value)) {
    throw invalid(`${name} is invalid`);
  }
  const isArray = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (isArray ? Array.prototype : Object.prototype)
  ) {
    throw invalid(`${name} is invalid`);
  }
  context.ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      context.budget.entries += 1;
      if (
        context.budget.entries > MAX_PASSIVE_DATA_ENTRIES ||
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw invalid(`${name} is invalid`);
      }
      assertPassiveData(
        descriptor.value,
        {
          depth: context.depth + 1,
          budget: context.budget,
          ancestors: context.ancestors,
        },
        `${name}.${key}`,
      );
    }
  } finally {
    context.ancestors.delete(value);
  }
}

function passiveData(value, name) {
  assertPassiveData(
    value,
    { depth: 0, budget: { entries: 0 }, ancestors: new Set() },
    name,
  );
  return value;
}

function plainArray(value, name, maximumEntries) {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumEntries
  ) {
    throw invalid(`${name} is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_, index) =>
    String(index),
  );
  if (
    keys.length !== expected.length + 1 ||
    !keys.includes("length") ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return expected.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} is invalid`);
    }
    return descriptor.value;
  });
}

function text(value, name, maximumBytes, { empty = false, pattern = null } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    UNSAFE_TEXT.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const normalized = text(value, name, 24, { pattern: ISO_TIMESTAMP });
  const milliseconds = Date.parse(normalized);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== normalized
  ) {
    throw invalid(`${name} is invalid`);
  }
  return normalized;
}

function displayText(value, name, maximumBytes, { empty = false } = {}) {
  const normalized = text(value, name, maximumBytes, { empty });
  if (
    UNSAFE_DISPLAY_TEXT.test(normalized) ||
    (normalized !== "" && !normalized.trim())
  ) {
    throw invalid(`${name} is invalid`);
  }
  return normalized;
}

function nullableLine(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function nullableBoolean(value, name) {
  if (value === null || typeof value === "boolean") return value;
  throw invalid(`${name} is invalid`);
}

function httpsUrl(value, name, { allowHttp = false } = {}) {
  if (value === "") return "";
  const normalized = text(value, name, 2_048);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw invalid(`${name} is invalid`);
  }
  if (
    (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === 'http:')) ||
    parsed.username ||
    parsed.password
  ) {
    throw invalid(`${name} is invalid`);
  }
  return parsed.href;
}

function sha256(value, name) {
  return text(value, name, 64, { pattern: SHA256 });
}

function enumValue(value, values, name) {
  if (typeof value !== "string" || !values.has(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function booleanValue(value, name) {
  if (typeof value !== "boolean") throw invalid(`${name} is invalid`);
  return value;
}

function optionalOid(value, name) {
  return text(value, name, 64, {
    empty: true,
    pattern: value === "" ? null : GIT_OID,
  });
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

function normalizeSource(value) {
  const fields = exactDataMap(value, SOURCE_KEYS, "identity.source");
  return {
    provider: text(fields.get("provider"), "identity.source.provider", 128, {
      pattern: SAFE_TOKEN,
    }),
    scopeId: text(fields.get("scopeId"), "identity.source.scopeId", 256),
  };
}

export function normalizePullRequestReadIdentity(value) {
  const fields = exactDataMap(value, IDENTITY_KEYS, "identity");
  if (fields.get("schemaVersion") !== 1) {
    throw invalid("identity.schemaVersion is invalid");
  }
  let executionBinding;
  try {
    executionBinding = normalizePullRequestExecutionBinding(
      passiveData(fields.get("executionBinding"), "identity.executionBinding"),
    );
  } catch {
    throw invalid("identity.executionBinding is invalid");
  }
  if (executionBinding.schemaVersion !== 2) {
    throw invalid("identity requires an atomic Git target");
  }
  const content = {
    schemaVersion: 1,
    executionBinding: structuredClone(executionBinding),
    source: normalizeSource(fields.get("source")),
  };
  const identityDigest = sha256(
    fields.get("identityDigest"),
    "identity.identityDigest",
  );
  if (identityDigest !== digest(content)) {
    throw invalid("identity digest does not match its content");
  }
  return deepFreeze({ ...content, identityDigest });
}

export function createPullRequestReadIdentity(value) {
  const fields = exactDataMap(
    value,
    ["executionBinding", "event"],
    "read identity input",
  );
  let binding;
  let event;
  try {
    binding = normalizePullRequestExecutionBinding(
      passiveData(fields.get("executionBinding"), "executionBinding"),
    );
    event = normalizeStoredWorkflowEvent(passiveData(fields.get("event"), "event"));
  } catch {
    throw invalid("read identity input is invalid");
  }
  if (
    binding.schemaVersion !== 2 ||
    !pullRequestExecutionBindingMatchesEvent(binding, event)
  ) {
    throw invalid("read identity is not bound to the supplied PR event");
  }
  const source = event.source.provider === "github"
    ? event.source
    : ((event.source.provider === "local-owner" && event.eventType === "pull_request.owner_requested") ||
        (event.source.provider === "internal-review-repair" && event.eventType === "pull_request.internal_review_requested")) &&
        binding.gitTarget.provider === "github"
      ? {
          provider: "github",
          scopeId: `github-account:${binding.gitTarget.sourceAccountId}`,
        }
      : null;
  if (source === null) {
    throw invalid("read identity is not bound to a GitHub fact source");
  }
  const content = {
    schemaVersion: 1,
    executionBinding: structuredClone(binding),
    source: structuredClone(source),
  };
  return normalizePullRequestReadIdentity({
    ...content,
    identityDigest: digest(content),
  });
}

export function samePullRequestReadIdentity(left, right) {
  let normalizedLeft;
  let normalizedRight;
  try {
    normalizedLeft = normalizePullRequestReadIdentity(left);
    normalizedRight = normalizePullRequestReadIdentity(right);
  } catch {
    return false;
  }
  return (
    normalizedLeft.identityDigest === normalizedRight.identityDigest &&
    normalizedLeft.source.provider === normalizedRight.source.provider &&
    normalizedLeft.source.scopeId === normalizedRight.source.scopeId &&
    samePullRequestExecutionBinding(
      normalizedLeft.executionBinding,
      normalizedRight.executionBinding,
    )
  );
}

function normalizeComment(value, name, keys = COMMENT_KEYS) {
  const fields = exactDataMap(value, keys, name);
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    author: displayText(fields.get("author"), `${name}.author`, 64, {
      empty: true,
    }),
    body: text(fields.get("body"), `${name}.body`, PULL_REQUEST_READ_BODY_BYTES, { empty: true }),
    bodyTruncated: booleanValue(
      fields.get("bodyTruncated"),
      `${name}.bodyTruncated`,
    ),
    createdAt: timestamp(fields.get("createdAt"), `${name}.createdAt`),
    updatedAt: timestamp(fields.get("updatedAt"), `${name}.updatedAt`),
    url: httpsUrl(fields.get("url"), `${name}.url`),
  };
}

function normalizeReview(value, name) {
  const fields = exactDataMap(value, REVIEW_KEYS, name);
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    author: displayText(fields.get("author"), `${name}.author`, 64, {
      empty: true,
    }),
    state: enumValue(fields.get("state"), REVIEW_STATES, `${name}.state`),
    submittedAt: timestamp(fields.get("submittedAt"), `${name}.submittedAt`, {
      nullable: true,
    }),
    commitOid: optionalOid(fields.get("commitOid"), `${name}.commitOid`),
    body: text(fields.get("body"), `${name}.body`, PULL_REQUEST_READ_BODY_BYTES, { empty: true }),
    bodyTruncated: booleanValue(
      fields.get("bodyTruncated"),
      `${name}.bodyTruncated`,
    ),
    url: httpsUrl(fields.get("url"), `${name}.url`),
  };
}

function normalizeThreadComment(value, name) {
  const fields = exactDataMap(value, THREAD_COMMENT_KEYS, name);
  return {
    ...normalizeComment(
      Object.fromEntries(COMMENT_KEYS.map((key) => [key, fields.get(key)])),
      name,
    ),
    reviewId: displayText(fields.get("reviewId"), `${name}.reviewId`, 256, {
      empty: true,
    }),
    reviewState: enumValue(
      fields.get("reviewState"),
      REVIEW_STATES,
      `${name}.reviewState`,
    ),
    reviewSubmittedAt: timestamp(
      fields.get("reviewSubmittedAt"),
      `${name}.reviewSubmittedAt`,
      { nullable: true },
    ),
    reviewCommitOid: optionalOid(
      fields.get("reviewCommitOid"),
      `${name}.reviewCommitOid`,
    ),
  };
}

function normalizeThread(value, name) {
  const fields = exactDataMap(value, THREAD_KEYS, name);
  const comments = plainArray(
    fields.get("comments"),
    `${name}.comments`,
    MAX_THREAD_COMMENTS,
  ).map((entry, index) =>
    normalizeThreadComment(entry, `${name}.comments[${index}]`),
  );
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    path: displayText(fields.get("path"), `${name}.path`, 4_096),
    line: nullableLine(fields.get("line"), `${name}.line`),
    originalLine: nullableLine(
      fields.get("originalLine"),
      `${name}.originalLine`,
    ),
    resolved: nullableBoolean(fields.get("resolved"), `${name}.resolved`),
    outdated: nullableBoolean(fields.get("outdated"), `${name}.outdated`),
    comments,
    commentsTruncated: booleanValue(
      fields.get("commentsTruncated"),
      `${name}.commentsTruncated`,
    ),
  };
}

function normalizeCheck(value, name) {
  const fields = exactDataMap(value, CHECK_KEYS, name);
  return {
    kind: enumValue(fields.get("kind"), CHECK_KINDS, `${name}.kind`),
    name: displayText(fields.get("name"), `${name}.name`, 512),
    status: enumValue(fields.get("status"), CHECK_STATUSES, `${name}.status`),
    conclusion: enumValue(
      fields.get("conclusion"),
      CHECK_CONCLUSIONS,
      `${name}.conclusion`,
    ),
    url: httpsUrl(fields.get("url"), `${name}.url`, { allowHttp: true }),
    startedAt: timestamp(fields.get("startedAt"), `${name}.startedAt`, {
      nullable: true,
    }),
    completedAt: timestamp(fields.get("completedAt"), `${name}.completedAt`, {
      nullable: true,
    }),
    requirement: enumValue(
      fields.get("requirement"),
      CHECK_REQUIREMENTS,
      `${name}.requirement`,
    ),
  };
}

function normalizeCollection(value, name, normalizeEntry) {
  return plainArray(value, name, MAX_COLLECTION_ENTRIES).map(
    (entry, index) => normalizeEntry(entry, `${name}[${index}]`),
  );
}

function normalizeTruncation(value) {
  const fields = exactDataMap(value, TRUNCATION_KEYS, "truncation");
  const normalized = {};
  for (const key of TRUNCATION_KEYS) {
    if (typeof fields.get(key) !== "boolean") {
      throw invalid(`truncation.${key} is invalid`);
    }
    normalized[key] = fields.get(key);
  }
  return normalized;
}

function normalizedFactContent(fields) {
  return {
    schemaVersion: 1,
    identity: normalizePullRequestReadIdentity(fields.get("identity")),
    observedAt: timestamp(fields.get("observedAt"), "observedAt"),
    reviewDecision: enumValue(
      fields.get("reviewDecision"),
      REVIEW_DECISIONS,
      "reviewDecision",
    ),
    comments: normalizeCollection(
      fields.get("comments"),
      "comments",
      normalizeComment,
    ),
    reviews: normalizeCollection(
      fields.get("reviews"),
      "reviews",
      normalizeReview,
    ),
    reviewThreads: normalizeCollection(
      fields.get("reviewThreads"),
      "reviewThreads",
      normalizeThread,
    ),
    checks: normalizeCollection(fields.get("checks"), "checks", normalizeCheck),
    truncation: normalizeTruncation(fields.get("truncation")),
  };
}

function assertFactByteLimit(content) {
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_FACT_BYTES) {
    throw invalid("read facts exceed the persistence byte limit");
  }
}

export function normalizePullRequestReadFacts(value) {
  const fields = exactDataMap(value, FACT_KEYS, "read facts");
  if (fields.get("schemaVersion") !== 1) {
    throw invalid("read facts schemaVersion is invalid");
  }
  const content = normalizedFactContent(fields);
  assertFactByteLimit(content);
  const contentDigest = sha256(fields.get("contentDigest"), "contentDigest");
  if (contentDigest !== digest(content)) {
    throw invalid("read facts digest does not match its content");
  }
  return deepFreeze({ ...structuredClone(content), contentDigest });
}

export function createPullRequestReadFacts(value) {
  const fields = exactDataMap(
    value,
    FACT_KEYS.filter((key) => key !== "schemaVersion" && key !== "contentDigest"),
    "read facts input",
  );
  const normalizedContent = normalizedFactContent(fields);
  assertFactByteLimit(normalizedContent);
  return normalizePullRequestReadFacts({
    ...normalizedContent,
    contentDigest: digest(normalizedContent),
  });
}

export function pullRequestReadFactsMatch(value, identityInput) {
  let facts;
  let identity;
  try {
    facts = normalizePullRequestReadFacts(value);
    identity = normalizePullRequestReadIdentity(identityInput);
  } catch {
    return false;
  }
  return samePullRequestReadIdentity(facts.identity, identity);
}

export function pullRequestReadFactsMatchExecution(value, executionInput) {
  let identity;
  try {
    identity = createPullRequestReadIdentity(executionInput);
  } catch {
    return false;
  }
  return pullRequestReadFactsMatch(value, identity);
}

function uniqueSortedCheckNames(checks, predicate) {
  const names = [...new Set(checks.filter(predicate).map(({ name }) => name))]
    .sort((left, right) => left.localeCompare(right, "en"));
  return { names: names.slice(0, 20), truncated: names.length > 20 };
}

export function projectPullRequestReadFactsSummary(value) {
  const facts = normalizePullRequestReadFacts(value);
  const failingConclusions = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "ERROR",
  ]);
  const pendingStatuses = new Set([
    "QUEUED",
    "IN_PROGRESS",
    "PENDING",
    "EXPECTED",
    "REQUESTED",
    "WAITING",
  ]);
  const failingChecks = uniqueSortedCheckNames(
    facts.checks,
    ({ conclusion }) => failingConclusions.has(conclusion),
  );
  const pendingChecks = uniqueSortedCheckNames(
    facts.checks,
    ({ status }) => pendingStatuses.has(status),
  );
  const unknownChecks = uniqueSortedCheckNames(
    facts.checks,
    ({ status, conclusion }) =>
      status === "UNKNOWN" || conclusion === "UNKNOWN",
  );
  return deepFreeze({
    schemaVersion: 1,
    identityDigest: facts.identity.identityDigest,
    contentDigest: facts.contentDigest,
    reviewDecision: facts.reviewDecision,
    unresolvedThreadCount: facts.reviewThreads.filter(
      ({ resolved }) => resolved === false,
    ).length,
    currentUnresolvedThreadCount: facts.reviewThreads.filter(
      ({ resolved, outdated }) => resolved === false && outdated === false,
    ).length,
    failingChecks: failingChecks.names,
    pendingChecks: pendingChecks.names,
    unknownChecks: unknownChecks.names,
    truncated:
      Object.values(facts.truncation).some((entry) => entry) ||
      facts.reviewThreads.some(({ commentsTruncated }) => commentsTruncated) ||
      failingChecks.truncated ||
      pendingChecks.truncated ||
      unknownChecks.truncated,
  });
}

function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { value, truncated: false };
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return { value: result, truncated: true };
}

function projectedBody(entry, maximumBytes = 2 * 1024) {
  const body = truncateUtf8(entry.body, maximumBytes);
  return {
    body: body.value,
    bodyTruncated: entry.bodyTruncated || body.truncated,
  };
}

function projectedComment(entry, bodyBytes) {
  return {
    id: entry.id,
    author: entry.author,
    ...projectedBody(entry, bodyBytes),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function projectedReview(entry, bodyBytes) {
  return {
    id: entry.id,
    author: entry.author,
    state: entry.state,
    submittedAt: entry.submittedAt,
    commitOid: entry.commitOid,
    ...projectedBody(entry, bodyBytes),
  };
}

function threadPriority(thread) {
  if (thread.resolved === false && thread.outdated === false) return 0;
  if (thread.resolved === false) return 1;
  if (thread.resolved === null || thread.outdated === null) return 2;
  return 3;
}

function latestThreadTimestamp(thread) {
  return thread.comments.at(-1)?.updatedAt ?? "";
}

function projectedThread(thread, { bodyBytes, pathBytes }) {
  const latest = thread.comments.at(-1) ?? null;
  const path = truncateUtf8(thread.path, pathBytes);
  return {
    id: thread.id,
    path: path.value,
    pathTruncated: path.truncated,
    line: thread.line,
    originalLine: thread.originalLine,
    resolved: thread.resolved,
    outdated: thread.outdated,
    latestComment:
      latest === null
        ? null
        : {
            ...projectedComment(latest, bodyBytes),
            reviewId: latest.reviewId,
            reviewState: latest.reviewState,
            reviewSubmittedAt: latest.reviewSubmittedAt,
            reviewCommitOid: latest.reviewCommitOid,
          },
    commentsTruncated: thread.commentsTruncated || thread.comments.length > 1,
  };
}

function checkPriority(check) {
  const failing = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "ERROR",
  ]).has(check.conclusion);
  const pending = new Set([
    "QUEUED",
    "IN_PROGRESS",
    "PENDING",
    "EXPECTED",
    "REQUESTED",
    "WAITING",
  ]).has(check.status);
  if (check.requirement === "required" && failing) return 0;
  if (check.requirement === "required" && pending) return 1;
  if (failing) return 2;
  if (pending) return 3;
  if (check.status === "UNKNOWN" || check.conclusion === "UNKNOWN") return 4;
  return 5;
}

function projectedCheck(check, nameBytes) {
  const name = truncateUtf8(check.name, nameBytes);
  return {
    kind: check.kind,
    name: name.value,
    url: check.url,
    status: check.status,
    conclusion: check.conclusion,
    requirement: check.requirement,
    startedAt: check.startedAt,
    completedAt: check.completedAt,
  };
}

function projectedContextSummary(facts, profile) {
  const summary = projectPullRequestReadFactsSummary(facts);
  let projectionTruncated = false;
  const projectNames = (names) => names
    .slice(0, profile.summaryChecks)
    .map((name) => {
      const projected = truncateUtf8(name, profile.nameBytes);
      projectionTruncated ||= projected.truncated;
      return projected.value;
    });
  const failingChecks = projectNames(summary.failingChecks);
  const pendingChecks = projectNames(summary.pendingChecks);
  const unknownChecks = projectNames(summary.unknownChecks);
  projectionTruncated ||=
    failingChecks.length < summary.failingChecks.length ||
    pendingChecks.length < summary.pendingChecks.length ||
    unknownChecks.length < summary.unknownChecks.length;
  return {
    ...summary,
    failingChecks,
    pendingChecks,
    unknownChecks,
    truncated: summary.truncated || projectionTruncated,
  };
}

function projectedContext(facts, selected, profile) {
  const comments = (profile.comments === 0
    ? []
    : facts.comments.slice(-profile.comments))
    .map((entry) => projectedComment(entry, profile.bodyBytes));
  const reviews = (profile.reviews === 0
    ? []
    : facts.reviews.slice(-profile.reviews))
    .map((entry) => projectedReview(entry, profile.bodyBytes));
  const reviewThreads = selected.reviewThreads
    .slice(0, profile.threads)
    .map((entry) => projectedThread(entry, profile));
  const selectedChecks = selected.checks.slice(0, profile.checks);
  const checks = selectedChecks.map((entry) =>
    projectedCheck(entry, profile.nameBytes));
  const checkNamesTruncated = checks.some(
    (entry, index) => entry.name !== selectedChecks[index].name,
  );
  const summary = projectedContextSummary(facts, profile);
  return {
    schemaVersion: 1,
    identityDigest: facts.identity.identityDigest,
    contentDigest: facts.contentDigest,
    observedAt: facts.observedAt,
    summary,
    comments,
    reviews,
    reviewThreads,
    checks,
    contextTruncated:
      summary.truncated ||
      facts.comments.length > comments.length ||
      facts.reviews.length > reviews.length ||
      facts.reviewThreads.length > reviewThreads.length ||
      facts.checks.length > checks.length ||
      comments.some(({ bodyTruncated }) => bodyTruncated) ||
      reviews.some(({ bodyTruncated }) => bodyTruncated) ||
      reviewThreads.some(
        ({ pathTruncated, commentsTruncated, latestComment }) =>
          pathTruncated ||
          commentsTruncated ||
          latestComment?.bodyTruncated === true,
      ) ||
      checkNamesTruncated,
  };
}

export function projectPullRequestReadFactsContext(value) {
  const facts = normalizePullRequestReadFacts(value);
  // Observation receipts keep their historical digest. Only complete source
  // material can prove that a later observation contains the same PR inputs.
  const complete = !Object.values(facts.truncation).some(Boolean) &&
    !facts.comments.some(({ bodyTruncated }) => bodyTruncated) &&
    !facts.reviews.some(({ bodyTruncated }) => bodyTruncated) &&
    !facts.reviewThreads.some(({ commentsTruncated, comments }) =>
      commentsTruncated || comments.some(({ bodyTruncated }) => bodyTruncated));
  const { observedAt, contentDigest, ...material } = facts;
  const materialDigest = complete
    ? digest({ domain: "mydashboard-pull-request-read-material/v1", material })
    : null;
  const reviewThreads = [...facts.reviewThreads]
    .sort((left, right) => {
      const priority = threadPriority(left) - threadPriority(right);
      if (priority !== 0) return priority;
      const timestamp = latestThreadTimestamp(right).localeCompare(
        latestThreadTimestamp(left),
        "en",
      );
      return timestamp || left.id.localeCompare(right.id, "en");
    })
    .slice(0, MAX_CONTEXT_THREADS);
  const checks = [...facts.checks]
    .sort((left, right) => {
      const priority = checkPriority(left) - checkPriority(right);
      return priority || left.name.localeCompare(right.name, "en");
    })
    .slice(0, MAX_CONTEXT_CHECKS);
  const selected = { reviewThreads, checks };
  for (const profile of CONTEXT_PROFILES) {
    const context = {
      ...projectedContext(facts, selected, profile),
      ...(materialDigest === null ? {} : { materialDigest }),
    };
    if (Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_CONTEXT_BYTES) {
      return deepFreeze(context);
    }
  }
  throw invalid("projected read facts fixed identity exceeds the role context limit");
}
