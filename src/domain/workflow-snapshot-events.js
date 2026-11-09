import { createHash } from "node:crypto";

import { normalizeWorkflowEvent } from "./workflow-events.js";
import { normalizePullRequestGitTarget } from "./git-tool-contract.js";
import { DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS } from "./prioritizer.js";

const DAY_MS = 86_400_000;

const SOURCE_DEFINITIONS = Object.freeze([
  {
    kind: "pull_request",
    sourceStatus: "githubPullRequests",
  },
  {
    kind: "issue",
    sourceStatus: "githubIssues",
  },
]);

const COMMON_FACT_FIELDS = Object.freeze([
  "title",
  "author",
  "createdAt",
  "updatedAt",
  "labels",
  "assignees",
  "milestone",
  "relation",
  "assignmentSource",
  "gitTarget",
  "gitTargetAvailable",
  "actionState",
  "nextActor",
  "nextAction",
  "requiresConfirmation",
  "state",
  "reviewDecision",
  "ciStatus",
  "mergeStateStatus",
  "isDraft",
  "headRefOid",
  "myReviewState",
  "myLatestPublishedReviewAt",
  "myReviewCommitOid",
  "reviewFactsAvailable",
  "reviewFeedbackAvailable",
  "reviewFeedbackDigest",
  "reviewFeedbackCount",
  "reviewFeedbackAt",
  "inactiveDays",
  "incomingReviewFactsAvailable",
  "reviewRecipient",
  "reviewReceivedAt",
  "reviewReceivedFrom",
  "reviewReceivedVia",
  "reviewRequestEventId",
]);
const ISSUE_FACT_FIELDS = Object.freeze([
  "commentsCount",
  "evidenceDigest",
]);
const LATEST_COMMENT_FIELDS = Object.freeze([
  "author",
  "body",
  "createdAt",
  "updatedAt",
  "url",
]);

const CLASSIFICATION_FIELDS = new Set([
  "labels",
  "relation",
  "assignmentSource",
  "actionState",
  "nextActor",
  "nextAction",
  "requiresConfirmation",
]);

const STATUS_FIELDS = new Set([
  "state",
  "reviewDecision",
  "ciStatus",
  "mergeStateStatus",
  "isDraft",
  "myReviewState",
]);

const COMPLETED_STATES = new Set([
  "closed",
  "merged",
  "completed",
  "done",
  "resolved",
]);

const EVENT_ORDER = new Map(
  [
    "observed",
    "created",
    "updated",
    "classified",
    "status",
    "completed",
    "left_scope",
  ].map((name, index) => [name, index]),
);

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireSnapshot(value, name) {
  if (!plainObject(value) || !Array.isArray(value.items)) {
    throw new TypeError(`${name} must be a snapshot with an items array`);
  }
  return value;
}

function requireTimestamp(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError("snapshot.refreshedAt must be an ISO timestamp");
  }
  return value;
}

function requireSourceScopeId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError("sourceScopeId must be a non-empty identifier");
  }
  return value;
}

function requireIssueActiveWindowDays(value) {
  const days = value ?? DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new TypeError("issueActiveWindowDays must be a positive integer");
  }
  return days;
}

function issueIsWithinActiveWindow(item, cutoff) {
  if (item.kind !== "issue") return true;
  const updatedAt = Date.parse(item.updatedAt || item.createdAt || "");
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt > cutoff;
}

function sourceIsHealthy(snapshot, statusName) {
  const status = snapshot.sourceStatus?.[statusName];
  return status?.ok === true && status.stale !== true;
}

function normalizedLatestComment(value) {
  if (value === null) return null;
  if (
    !plainObject(value) ||
    Object.keys(value).length !== LATEST_COMMENT_FIELDS.length ||
    LATEST_COMMENT_FIELDS.some(
      (name) => !Object.hasOwn(value, name) || typeof value[name] !== "string",
    )
  ) {
    throw new TypeError("latestComment must be a complete GitHub comment");
  }
  return Object.fromEntries(
    LATEST_COMMENT_FIELDS.map((name) => [name, value[name]]),
  );
}

function issueEvidenceDigest(item) {
  if (Object.hasOwn(item, "description") || Object.hasOwn(item, "latestComment")) {
    const evidence = {};
    if (item.description !== undefined) {
      if (typeof item.description !== "string") {
        throw new TypeError("description must be a string");
      }
      evidence.description = item.description;
    }
    if (item.latestComment !== undefined) {
      evidence.latestComment = normalizedLatestComment(item.latestComment);
    }
    return createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex");
  }
  if (item.evidenceDigest === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(item.evidenceDigest)) {
    throw new TypeError("evidenceDigest must be a SHA-256 digest");
  }
  return item.evidenceDigest;
}

function normalizedFactValue(value, field) {
  if (field === "gitTarget") {
    try {
      return structuredClone(normalizePullRequestGitTarget(value));
    } catch {
      throw new TypeError("gitTarget must be a valid PR Git target");
    }
  }
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== "string")) {
      throw new TypeError(`${field} must contain only strings`);
    }
    return [...new Set(value)].sort(compareStrings);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return Object.is(value, -0) ? 0 : value;
  }
  throw new TypeError(`${field} must be a JSON fact`);
}

function factFieldsFor(item) {
  return item.kind === "issue"
    ? [...COMMON_FACT_FIELDS, ...ISSUE_FACT_FIELDS]
    : COMMON_FACT_FIELDS;
}

function factsFor(item) {
  const facts = {};
  for (const field of factFieldsFor(item)) {
    const value = field === "evidenceDigest"
      ? issueEvidenceDigest(item)
      : item[field];
    if (value === undefined) continue;
    facts[field] = normalizedFactValue(value, field);
  }
  return facts;
}

function changedFacts(before, after) {
  const previousFacts = factsFor(before);
  const currentFacts = factsFor(after);
  const fields = factFieldsFor(after).filter(
    (field) =>
      JSON.stringify(previousFacts[field]) !== JSON.stringify(currentFacts[field]),
  );
  return { fields, currentFacts };
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareItems(left, right) {
  const leftKind = left.kind === "pull_request" ? 0 : 1;
  const rightKind = right.kind === "pull_request" ? 0 : 1;
  return (
    leftKind - rightKind ||
    compareStrings(left.repo, right.repo) ||
    left.number - right.number ||
    compareStrings(left.id, right.id)
  );
}

function projectItem(item) {
  if (
    !plainObject(item) ||
    !SOURCE_DEFINITIONS.some(({ kind }) => kind === item.kind) ||
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.repo !== "string" ||
    !item.repo ||
    !Number.isSafeInteger(item.number) ||
    item.number < 1
  ) {
    throw new TypeError("workflow snapshot item is invalid");
  }
  return {
    id: item.id,
    kind: item.kind,
    repo: item.repo,
    number: item.number,
    ...factsFor(item),
  };
}

function projectedSourceStatus(snapshot, statusName) {
  const status = snapshot.sourceStatus?.[statusName];
  const ok = plainObject(status) && status.ok === true;
  return {
    ok,
    stale: plainObject(status) && typeof status.stale === "boolean"
      ? status.stale
      : !ok,
  };
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

export function projectWorkflowSnapshot(
  snapshot,
  { issueActiveWindowDays } = {},
) {
  const source = requireSnapshot(snapshot, "snapshot");
  const refreshedAt = requireTimestamp(source.refreshedAt);
  const activeWindowDays = requireIssueActiveWindowDays(issueActiveWindowDays);
  const issueCutoff = Date.parse(refreshedAt) - activeWindowDays * DAY_MS;
  const items = source.items
    .filter(
      (item) =>
        plainObject(item) &&
        SOURCE_DEFINITIONS.some(({ kind }) => kind === item.kind) &&
        !(item.kind === "pull_request" && item.actionState === "historical") &&
        issueIsWithinActiveWindow(item, issueCutoff),
    )
    .map(projectItem)
    .sort(compareItems);
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new TypeError(`duplicate snapshot item: ${item.id}`);
    }
    ids.add(item.id);
  }
  return deepFreeze({
    refreshedAt,
    sourceStatus: {
      githubPullRequests: projectedSourceStatus(
        source,
        "githubPullRequests",
      ),
      githubIssues: projectedSourceStatus(source, "githubIssues"),
    },
    items,
  });
}

function indexItems(snapshot, kind) {
  const items = snapshot.items
    .filter((item) => plainObject(item) && item.kind === kind)
    .sort(compareItems);
  const indexed = new Map();
  for (const item of items) {
    if (indexed.has(item.id)) {
      throw new TypeError(`duplicate snapshot item: ${item.id}`);
    }
    indexed.set(item.id, item);
  }
  return indexed;
}

function isCompletedState(value) {
  return (
    typeof value === "string" && COMPLETED_STATES.has(value.toLowerCase())
  );
}

function eventBase({ eventName, item, occurredAt, sourceScopeId, payload }) {
  return {
    schemaVersion: 1,
    eventType: `${item.kind}.${eventName}`,
    occurredAt,
    source: { provider: "github", scopeId: sourceScopeId },
    subject: {
      id: item.id,
      repository: item.repo,
      number: item.number,
    },
    payload,
  };
}

function normalizedEvent(context) {
  return normalizeWorkflowEvent(eventBase(context));
}

function changeEvents(before, after, context) {
  const { fields, currentFacts: facts } = changedFacts(before, after);
  if (!fields.length) return [];

  const previousHeadRefOid = fields.includes("headRefOid")
    ? before.headRefOid
    : undefined;
  const events = [
    normalizedEvent({
      ...context,
      eventName: "updated",
      item: after,
      payload: {
        ...facts,
        changedFields: fields,
        ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
      },
    }),
  ];
  const classificationChanges = fields.filter((field) =>
    CLASSIFICATION_FIELDS.has(field),
  );
  if (classificationChanges.length) {
    events.push(
      normalizedEvent({
        ...context,
        eventName: "classified",
        item: after,
        payload: { ...facts, changedFields: classificationChanges },
      }),
    );
  }
  const statusChanges = fields.filter((field) => STATUS_FIELDS.has(field));
  if (statusChanges.length) {
    events.push(
      normalizedEvent({
        ...context,
        eventName: "status",
        item: after,
        payload: { ...facts, changedFields: statusChanges },
      }),
    );
  }
  if (!isCompletedState(before.state) && isCompletedState(after.state)) {
    events.push(
      normalizedEvent({
        ...context,
        eventName: "completed",
        item: after,
        payload: { ...facts, previousState: before.state ?? "" },
      }),
    );
  }
  return events;
}

function eventName(event) {
  return event.eventType.slice(event.eventType.indexOf(".") + 1);
}

function compareEvents(left, right) {
  const leftKind = left.eventType.startsWith("pull_request.") ? 0 : 1;
  const rightKind = right.eventType.startsWith("pull_request.") ? 0 : 1;
  return (
    leftKind - rightKind ||
    compareStrings(left.subject.repository, right.subject.repository) ||
    left.subject.number - right.subject.number ||
    compareStrings(left.subject.id, right.subject.id) ||
    EVENT_ORDER.get(eventName(left)) - EVENT_ORDER.get(eventName(right))
  );
}

function eventsForSource({
  definition,
  previousSnapshot,
  currentSnapshot,
  occurredAt,
  sourceScopeId,
}) {
  if (!sourceIsHealthy(currentSnapshot, definition.sourceStatus)) return [];

  const current = indexItems(currentSnapshot, definition.kind);
  const context = { occurredAt, sourceScopeId };
  if (
    previousSnapshot === null ||
    !sourceIsHealthy(previousSnapshot, definition.sourceStatus)
  ) {
    return [...current.values()].map((item) =>
      normalizedEvent({
        ...context,
        eventName: "observed",
        item,
        payload: factsFor(item),
      }),
    );
  }

  const previous = indexItems(previousSnapshot, definition.kind);
  const events = [];
  for (const item of current.values()) {
    const before = previous.get(item.id);
    if (!before) {
      events.push(
        normalizedEvent({
          ...context,
          eventName: "created",
          item,
          payload: factsFor(item),
        }),
      );
      continue;
    }
    events.push(...changeEvents(before, item, context));
  }
  for (const item of previous.values()) {
    if (current.has(item.id)) continue;
    events.push(
      normalizedEvent({
        ...context,
        eventName: "left_scope",
        item,
        payload: factsFor(item),
      }),
    );
  }
  return events;
}

export function workflowEventsFromSnapshots(
  previousSnapshot,
  currentSnapshot,
  {
    sourceScopeId = "github-dashboard",
    issueActiveWindowDays,
  } = {},
) {
  const projectionOptions = { issueActiveWindowDays };
  const current = projectWorkflowSnapshot(currentSnapshot, projectionOptions);
  const previous =
    previousSnapshot === null || previousSnapshot === undefined
      ? null
      : projectWorkflowSnapshot(previousSnapshot, projectionOptions);
  const occurredAt = current.refreshedAt;
  const scopeId = requireSourceScopeId(sourceScopeId);

  return Object.freeze(
    SOURCE_DEFINITIONS.flatMap((definition) =>
      eventsForSource({
        definition,
        previousSnapshot: previous,
        currentSnapshot: current,
        occurredAt,
        sourceScopeId: scopeId,
      }),
    ).sort(compareEvents),
  );
}
