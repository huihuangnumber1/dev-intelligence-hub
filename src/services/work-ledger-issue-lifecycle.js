import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import { createWorkGraphDeliveryRecord } from "./work-ledger-graph.js";

const LIFECYCLE_EVENTS = new Set([
  "issue.completed",
  "issue.left_scope",
]);
const SETTLEABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
  "retry_wait",
  "blocked",
]);
export const ISSUE_ASSIGNMENT_SUPERSEDED_REASON =
  "issue_assignment_superseded";
export const ISSUE_OUTSIDE_ACTIVE_WINDOW_REASON =
  "issue_outside_active_window";
const SETTLED_ISSUE_REASONS = new Set([
  "issue_source_completed",
  "issue_source_left_scope",
  ISSUE_ASSIGNMENT_SUPERSEDED_REASON,
  ISSUE_OUTSIDE_ACTIVE_WINDOW_REASON,
]);

function lifecycleReason(eventType) {
  return eventType === "issue.completed"
    ? "issue_source_completed"
    : "issue_source_left_scope";
}

function issueSubjectKey(event) {
  return event?.source?.provider === "github" &&
      typeof event.source.scopeId === "string" &&
      typeof event.subject?.id === "string" &&
      typeof event.subject?.repository === "string" &&
      Number.isSafeInteger(event.subject?.number)
    ? JSON.stringify([
        event.source.provider,
        event.source.scopeId,
        event.subject.id,
        event.subject.repository,
        event.subject.number,
      ])
    : null;
}

export function issueSubjectIdentityKey(event) {
  return issueSubjectKey(event);
}

export function issueAssignmentTargetKey(event, target) {
  const subjectKey = issueSubjectKey(event);
  return subjectKey !== null &&
      (target?.type === "role" || target?.type === "person") &&
      typeof target.id === "string"
    ? JSON.stringify([subjectKey, target.type, target.id])
    : null;
}

export function isSameIssueSubject(left, right) {
  const leftKey = issueSubjectKey(left);
  return leftKey !== null && leftKey === issueSubjectKey(right);
}

export function isSettledIssueReason(reason) {
  return SETTLED_ISSUE_REASONS.has(reason);
}

function workItemEvent(item) {
  try {
    return currentWorkItemEvent(item);
  } catch {
    return null;
  }
}

function failActiveIntent(outbox, event, reason, now) {
  return {
    ...outbox,
    status: "failed",
    revision: outbox.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: {
      status: "failed",
      details: {
        reason,
        lifecycleEventId: event.eventId,
      },
    },
    updatedAt: now,
  };
}

export function createIssueSettlementIndex(itemsById) {
  const itemsBySubject = new Map();
  const childrenByParent = new Map();
  const index = { itemsBySubject, childrenByParent };
  for (const item of itemsById.values()) indexIssueSettlementItem(index, item);
  return index;
}

export function indexIssueSettlementItem(index, item) {
  const key = issueSubjectKey(workItemEvent(item));
  if (key !== null) {
    const subjectItems = index.itemsBySubject.get(key) ?? [];
    subjectItems.push(item);
    index.itemsBySubject.set(key, subjectItems);
  }
  const parentItemId = item.graph?.parentItemId;
  if (typeof parentItemId === "string") {
    const children = index.childrenByParent.get(parentItemId) ?? [];
    children.push(item.itemId);
    index.childrenByParent.set(parentItemId, children);
  }
}

function issueWorkTree(
  index,
  event,
  sourceSequence,
  { exclusive = false, target = null } = {},
) {
  const subjectItems = index.itemsBySubject.get(issueSubjectKey(event)) ?? [];
  const selected = new Set(
    subjectItems
      .filter((item) =>
        item.graph?.parentItemId === null &&
        (exclusive
          ? item.sourceSequence < sourceSequence
          : item.sourceSequence <= sourceSequence) &&
        (target === null ||
          (item.currentTarget?.type === target.type &&
            item.currentTarget?.id === target.id))
      )
      .map(({ itemId }) => itemId),
  );
  const pending = [...selected];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const childId of index.childrenByParent.get(pending[cursor]) ?? []) {
      if (selected.has(childId)) continue;
      selected.add(childId);
      pending.push(childId);
    }
  }
  return selected;
}

function issueDescendantTree(index, rootItemIds) {
  const selected = new Set(rootItemIds);
  const pending = [...selected];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const childId of index.childrenByParent.get(pending[cursor]) ?? []) {
      if (selected.has(childId)) continue;
      selected.add(childId);
      pending.push(childId);
    }
  }
  return selected;
}

function settleIssueWorkItems({
  itemIds,
  event,
  reason,
  itemsById,
  outboxById,
  now,
  timelineEvents,
}) {
  const settled = [];
  for (const itemId of itemIds) {
    const item = itemsById.get(itemId);
    if (!SETTLEABLE_STATUSES.has(item.status)) continue;
    const outbox = item.activeIntentId === null
      ? null
      : outboxById.get(item.activeIntentId) ?? null;
    if (outbox?.status === "pending" || outbox?.status === "dispatching") {
      outboxById.set(
        outbox.intentId,
        failActiveIntent(outbox, event, reason, now),
      );
    }
    const updated = moveWorkItem(item, {
      status: "cancelled",
      now,
      reason,
    });
    const pending = item.graph?.deliveries.at(-1);
    if (pending?.status === "submitted") {
      const rejected = createWorkGraphDeliveryRecord({
        deliverableId: pending.deliverableId, revision: pending.revision + 1,
        contractRevision: pending.contractRevision, status: "rejected",
        summary: reason, evidence: pending.evidence,
      }, now);
      updated.graph = { ...item.graph, deliveries: [...item.graph.deliveries, rejected] };
      timelineEvents.push({ itemId, type: "graph_delivery_rejected", at: now, actorId: "work-ledger-system",
        details: { contractRevision: rejected.contractRevision, deliverableId: rejected.deliverableId,
          deliveryRevision: rejected.revision, submittedDeliveryRevision: pending.revision,
          reason, taskStatus: "cancelled" } });
    }
    itemsById.set(itemId, updated);
    settled.push(itemId);
    timelineEvents.push({
      itemId,
      type: "cancelled",
      at: now,
      actorId: "work-ledger-system",
      details: {
        lifecycleEventId: event.eventId,
        lifecycleEventType: event.eventType,
        subjectId: event.subject.id,
      },
    });
  }
  return settled;
}

export function isIssueScopeLifecycleEvent(event) {
  return LIFECYCLE_EVENTS.has(event?.eventType);
}

export function settleIssueScope({
  event,
  sourceSequence,
  itemsById,
  outboxById,
  now,
  timelineEvents,
  issueIndex = createIssueSettlementIndex(itemsById),
}) {
  if (!isIssueScopeLifecycleEvent(event)) return [];
  return settleIssueWorkItems({
    itemIds: issueWorkTree(issueIndex, event, sourceSequence),
    event,
    reason: lifecycleReason(event.eventType),
    itemsById,
    outboxById,
    now,
    timelineEvents,
  });
}

export function settleSupersededIssueAssignments({
  event,
  sourceSequence,
  target,
  itemsById,
  outboxById,
  now,
  timelineEvents,
  issueIndex = createIssueSettlementIndex(itemsById),
}) {
  if (!event?.eventType?.startsWith("issue.")) return [];
  return settleIssueWorkItems({
    itemIds: issueWorkTree(
      issueIndex,
      event,
      sourceSequence,
      { exclusive: true, target },
    ),
    event,
    reason: ISSUE_ASSIGNMENT_SUPERSEDED_REASON,
    itemsById,
    outboxById,
    now,
    timelineEvents,
  });
}

export function retireInactiveIssueCandidates({
  candidateItemIds,
  updatedBefore,
  itemsById,
  outboxById,
  now,
  timelineEvents,
  issueIndex = null,
  exact = false,
}) {
  const cutoff = Date.parse(updatedBefore);
  const candidatesBySubject = new Map();
  for (const itemId of candidateItemIds) {
    const item = itemsById.get(itemId);
    if (item === undefined) continue;
    const event = workItemEvent(item);
    const updatedAt = Date.parse(event?.payload?.updatedAt);
    if (
      !event?.eventType?.startsWith("issue.") ||
      isIssueScopeLifecycleEvent(event) ||
      !Number.isFinite(updatedAt) ||
      updatedAt >= cutoff
    ) {
      continue;
    }
    const key = exact ? item.itemId : issueSubjectKey(event);
    const current = candidatesBySubject.get(key);
    if (current === undefined || current.item.sourceSequence < item.sourceSequence) {
      candidatesBySubject.set(key, { item, event });
    }
  }
  const retiredItemIds = new Set();
  for (const { item, event } of candidatesBySubject.values()) {
    for (const itemId of settleIssueWorkItems({
      itemIds: exact
        ? [item.itemId]
        : issueWorkTree(issueIndex, event, item.sourceSequence),
      event,
      reason: ISSUE_OUTSIDE_ACTIVE_WINDOW_REASON,
      itemsById,
      outboxById,
      now,
      timelineEvents,
    })) {
      retiredItemIds.add(itemId);
    }
  }
  return [...retiredItemIds];
}

export function planInactiveIssueRetirement({ state, input, clock }) {
  const updatedBefore = input.updatedBefore;
  const now = clock();
  const itemsById = new Map(state.items.map((item) => [item.itemId, item]));
  const exact = Array.isArray(input.itemIds);
  const issueIndex = exact ? null : createIssueSettlementIndex(itemsById);
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const timelineEvents = [];
  const retiredItemIds = retireInactiveIssueCandidates({
    candidateItemIds: exact ? input.itemIds : itemsById.keys(),
    updatedBefore,
    itemsById,
    outboxById,
    now,
    timelineEvents,
    issueIndex,
    exact,
  });
  return retiredItemIds.length === 0
    ? {
        write: false,
        result: { retired: 0, itemIds: [] },
      }
    : {
        write: true,
        patch: {
          items: [...itemsById.values()],
          outbox: [...outboxById.values()],
        },
        timelineEvents,
        result: {
          retired: retiredItemIds.length,
          itemIds: retiredItemIds,
        },
      };
}

export function planRecoveredIssueScopeSettlement(state, now) {
  const issueItems = state.items
    .map((item) => ({ item, event: workItemEvent(item) }))
    .filter(({ item, event }) =>
      item.graph?.parentItemId === null &&
      event?.eventType?.startsWith("issue.")
    )
    .sort((left, right) => left.item.sourceSequence - right.item.sourceSequence);
  if (issueItems.length === 0) return null;
  const itemsById = new Map(state.items.map((item) => [item.itemId, item]));
  const issueIndex = createIssueSettlementIndex(itemsById);
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const timelineEvents = [];
  const latestLifecycleBySubject = new Map();
  const assignmentsByTarget = new Map();
  for (const entry of issueItems) {
    const subjectKey = issueSubjectKey(entry.event);
    if (subjectKey === null) continue;
    if (isIssueScopeLifecycleEvent(entry.event)) {
      latestLifecycleBySubject.set(subjectKey, entry);
      continue;
    }
    const target = entry.item.currentTarget;
    const targetKey = JSON.stringify([subjectKey, target?.type, target?.id]);
    const assignments = assignmentsByTarget.get(targetKey) ?? [];
    assignments.push(entry);
    assignmentsByTarget.set(targetKey, assignments);
  }
  for (const { item, event } of latestLifecycleBySubject.values()) {
    settleIssueScope({
      event,
      sourceSequence: item.sourceSequence,
      itemsById,
      outboxById,
      now,
      timelineEvents,
      issueIndex,
    });
  }
  for (const assignments of assignmentsByTarget.values()) {
    if (assignments.length < 2) continue;
    const latest = assignments.at(-1);
    const supersededRoots = assignments
      .slice(0, -1)
      .map(({ item }) => item.itemId);
    settleIssueWorkItems({
      itemIds: issueDescendantTree(issueIndex, supersededRoots),
      event: latest.event,
      reason: ISSUE_ASSIGNMENT_SUPERSEDED_REASON,
      itemsById,
      outboxById,
      now,
      timelineEvents,
    });
  }
  return timelineEvents.length === 0
    ? null
    : {
        items: [...itemsById.values()],
        outbox: [...outboxById.values()],
        timelineEvents,
      };
}
