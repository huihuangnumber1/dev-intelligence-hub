import { normalizeWorkIntent } from "../domain/work-intent.js";
import { sameBrainRecoveryOrigin } from "./brain-recovery-intent.js";
import {
  boundedLedgerString,
  canonicalLedgerValue,
  contentAddressedLedgerRecord,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTarget,
  prettySerializedLedgerBytes,
  workLedgerError,
} from "./work-ledger-values.js";
import {
  createDefaultWorkGraphMetadata,
  createWorkGraphAcceptanceRecord,
} from "./work-ledger-graph.js";
import {
  createPullRequestWorkSource,
  currentWorkItemInputBinding,
} from "./work-ledger-pr-source.js";

export const MAX_WORK_LEDGER_INTAKE_BATCH = 100;
export const MAX_WORK_LEDGER_QUERY_PAGE = 100;
export const WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS =
  "at-least-once-idempotent";

function sourceInvalid(message) {
  return workLedgerError("WORK_LEDGER_SOURCE_INVALID", message, 502);
}

function safeSourceString(value, name, maximumBytes = 256) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw sourceInvalid(`${name} 无效`);
  }
}

function canonicalSourceValue(value, name) {
  try {
    return canonicalLedgerValue(value, {
      maximumEntries: 30_000,
      errorCode: "WORK_LEDGER_SOURCE_INVALID",
    });
  } catch (error) {
    if (error?.code === "WORK_LEDGER_SOURCE_INVALID") throw error;
    throw sourceInvalid(`${name} 无法安全读取`);
  }
}

function normalizeAssignmentEnvelope(value, itemByteBudget) {
  let exact;
  try {
    exact = hasExactLedgerKeys(value, ["sequence", "assignment", "event"]);
  } catch {
    throw sourceInvalid("分派批次包含不可读取的记录");
  }
  if (!exact || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw sourceInvalid("分派序号无效");
  }
  const assignment = canonicalSourceValue(value.assignment, "assignment");
  const event = canonicalSourceValue(value.event, "event");
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
    throw sourceInvalid("assignment 必须是对象");
  }
  const assignmentId = safeSourceString(
    assignment.assignmentId,
    "assignment.assignmentId",
    192,
  );
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw sourceInvalid("event 必须是对象");
  }
  let target;
  try {
    target = normalizeLedgerTarget(assignment.target);
  } catch {
    throw sourceInvalid("assignment.target 无效");
  }
  if (
    assignment.eventId !== undefined &&
    event.eventId !== undefined &&
    assignment.eventId !== event.eventId
  ) {
    throw sourceInvalid("assignment 与 event 引用不一致");
  }
  assignment.assignmentId = assignmentId;
  assignment.target = target;
  if (
    prettySerializedLedgerBytes({ assignment, event }) > itemByteBudget
  ) {
    throw sourceInvalid("单个分派超过安全字节上限");
  }
  return { sequence: value.sequence, assignment, event };
}

export function normalizeAssignmentBatch(
  value,
  { afterSequence, requestedLimit, itemByteBudget },
) {
  let exact;
  try {
    exact = hasExactLedgerKeys(value, [
      "items",
      "nextSequence",
      "highWatermark",
      "oldestAvailableSequence",
    ]);
  } catch {
    throw sourceInvalid("分派源返回了不可读取的批次");
  }
  if (
    !exact ||
    !Array.isArray(value.items) ||
    value.items.length > requestedLimit ||
    !Number.isSafeInteger(value.nextSequence) ||
    !Number.isSafeInteger(value.highWatermark) ||
    !Number.isSafeInteger(value.oldestAvailableSequence) ||
    value.nextSequence < 0 ||
    value.highWatermark < 0 ||
    value.oldestAvailableSequence < 1 ||
    value.highWatermark < afterSequence ||
    value.nextSequence < afterSequence ||
    value.nextSequence > value.highWatermark
  ) {
    throw sourceInvalid("分派源游标契约无效");
  }
  let items;
  try {
    items = value.items.map((entry) =>
      normalizeAssignmentEnvelope(entry, itemByteBudget),
    );
  } catch (error) {
    if (error?.code === "WORK_LEDGER_SOURCE_INVALID") throw error;
    throw sourceInvalid("分派源记录无法安全读取");
  }
  if (
    items.some(
      (item, index) =>
        item.sequence <= afterSequence ||
        item.sequence > value.highWatermark ||
        (index > 0 && item.sequence <= items[index - 1].sequence),
    ) ||
    value.nextSequence !== (items.at(-1)?.sequence ?? afterSequence)
  ) {
    throw sourceInvalid("分派源序号没有严格递增");
  }
  return {
    items,
    nextSequence: value.nextSequence,
    highWatermark: value.highWatermark,
    oldestAvailableSequence: value.oldestAvailableSequence,
  };
}

export function findAssignmentBatchGap(batch, afterSequence) {
  const expectedFirst = afterSequence + 1;
  if (batch.oldestAvailableSequence > expectedFirst) {
    return {
      expectedSequence: expectedFirst,
      actualSequence: batch.oldestAvailableSequence,
      highWatermark: batch.highWatermark,
      reason: "source_retention",
    };
  }
  let expected = expectedFirst;
  for (const item of batch.items) {
    if (item.sequence !== expected) {
      return {
        expectedSequence: expected,
        actualSequence: item.sequence,
        highWatermark: batch.highWatermark,
        reason: "source_sequence",
      };
    }
    expected += 1;
  }
  if (!batch.items.length && batch.highWatermark > afterSequence) {
    return {
      expectedSequence: expectedFirst,
      actualSequence: Math.max(batch.oldestAvailableSequence, batch.highWatermark),
      highWatermark: batch.highWatermark,
      reason: "source_sequence",
    };
  }
  return null;
}

export function normalizeReportedAssignmentGap(error, afterSequence) {
  let code;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    code = descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return null;
  }
  if (code !== "WORKFLOW_ASSIGNMENT_GAP") return null;
  let details;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "details");
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("invalid gap details property");
    }
    details = descriptor.value;
    if (
      !hasExactLedgerKeys(details, [
        "afterSequence",
        "expectedSequence",
        "oldestAvailableSequence",
        "highWatermark",
      ]) ||
      details.afterSequence !== afterSequence ||
      details.expectedSequence !== afterSequence + 1 ||
      !Number.isSafeInteger(details.oldestAvailableSequence) ||
      !Number.isSafeInteger(details.highWatermark) ||
      details.oldestAvailableSequence <= details.expectedSequence ||
      details.highWatermark < details.oldestAvailableSequence
    ) {
      throw new Error("invalid gap details");
    }
  } catch {
    throw sourceInvalid("分派源 gap 详情无效");
  }
  return {
    expectedSequence: details.expectedSequence,
    actualSequence: details.oldestAvailableSequence,
    highWatermark: details.highWatermark,
    reason: "source_retention",
  };
}

export function createAssignmentWorkItem(envelope, createdAt) {
  return createWorkItem({
    kind: "assignment",
    sourceSequence: envelope.sequence,
    assignment: envelope.assignment,
    event: envelope.event,
    status: "queued",
    statusReason: null,
    createdAt,
  });
}

export function createPullRequestSourceRootWorkItem(envelope, createdAt) {
  const created = createPullRequestWorkSource(envelope);
  if (created === null) return null;
  const { descriptor, source } = created;
  const assignmentId = `pr-source-assignment-${ledgerDigest(source.identity)}`;
  const assignment = {
    assignmentId,
    target: { type: "role", id: source.identity.targetRoleId },
    reason: "stable_pr_source_root",
  };
  return {
    itemId: `work-item-${ledgerDigest({
      kind: "source_root",
      workKey: source.workKey,
    })}`,
    kind: "source_root",
    assignmentId,
    sourceSequence: 0,
    inputDigest: source.current.inputDigest,
    assignment,
    event: structuredClone(descriptor.event),
    source,
    sourceQuarantine: null,
    graph: createDefaultWorkGraphMetadata(createdAt),
    currentTarget: assignment.target,
    activeIntentId: null,
    decisionContext: null,
    status: "queued",
    revision: 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 0,
    availableAt: null,
    statusReason: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function graphChildAssignmentId(
  parentItemId,
  childKey,
  sourceBinding = null,
) {
  const identity = sourceBinding === null
    ? { parentItemId, childKey }
    : {
        parentItemId,
        childKey,
        sourceRootItemId: sourceBinding.rootItemId,
        sourceWorkKey: sourceBinding.workKey,
        sourceHeadRevision: sourceBinding.headRevision,
      };
  return `graph-assignment-${ledgerDigest(identity)}`;
}

export function graphChildDefinitionDigest(definition) {
  const content = {
    parentItemId: definition.parentItemId,
    childKey: definition.childKey,
    work: definition.work,
    target: definition.target,
    dependsOnItemIds: definition.dependsOnItemIds,
    acceptanceContract: definition.acceptanceContract,
  };
  return ledgerDigest(
    definition.sourceBinding === null || definition.sourceBinding === undefined
      ? content
      : { ...content, sourceBinding: definition.sourceBinding },
  );
}

export function createGraphChildWorkItem(definition, createdAt) {
  const initialDependsOnTaskIds = [...definition.dependsOnItemIds];
  const sourceBinding = definition.sourceBinding ?? null;
  const definitionDigest = graphChildDefinitionDigest({
    parentItemId: definition.parentItemId,
    childKey: definition.childKey,
    work: definition.work,
    target: definition.target,
    dependsOnItemIds: initialDependsOnTaskIds,
    acceptanceContract: definition.acceptanceContract,
    sourceBinding,
  });
  const assignmentId = graphChildAssignmentId(
    definition.parentItemId,
    definition.childKey,
    sourceBinding,
  );
  const item = createWorkItem({
    kind: "graph_task",
    sourceSequence: 0,
    assignment: {
      assignmentId,
      eventId: definition.parentEvent.eventId,
      target: definition.target,
      reason: "graph_child_created",
      graphTask: {
        parentTaskId: definition.parentItemId,
        childKey: definition.childKey,
        initialDependsOnTaskIds,
        definitionDigest,
        sourceBinding: sourceBinding === null
          ? null
          : structuredClone(sourceBinding),
      },
      work: {
        title: definition.work.title,
        description: definition.work.description,
      },
    },
    event: structuredClone(definition.parentEvent),
    status: "queued",
    statusReason: null,
    createdAt,
  });
  item.graph = {
    parentItemId: definition.parentItemId,
    dependsOnItemIds: [...initialDependsOnTaskIds],
    acceptanceContracts: [
      createWorkGraphAcceptanceRecord(definition.acceptanceContract, createdAt),
    ],
    deliveries: [],
  };
  return item;
}

export function createGapAlertWorkItem(gap, createdAt) {
  const gapKey = {
    expectedSequence: gap.expectedSequence,
    reason: gap.reason,
  };
  const digest = ledgerDigest(gapKey);
  return createWorkItem({
    kind: "system_alert",
    sourceSequence: 0,
    assignment: {
      assignmentId: `system-assignment-gap-${digest}`,
      target: { type: "node", id: "work-ledger-system" },
      reason: "assignment_feed_gap",
    },
    event: {
      eventId: `system-event-gap-${digest}`,
      eventType: "system.assignment_feed_gap",
      subject: gapKey,
      payload: gapKey,
    },
    status: "blocked",
    statusReason: "assignment_feed_gap",
    createdAt,
  });
}

function createWorkItem({
  kind,
  sourceSequence,
  assignment,
  event,
  status,
  statusReason,
  createdAt,
}) {
  const inputDigest = ledgerDigest({ assignment, event }, {
    maximumEntries: 30_000,
  });
  const assignmentId = assignment.assignmentId;
  const itemId = `work-item-${ledgerDigest({ assignmentId, inputDigest })}`;
  return {
    itemId,
    kind,
    assignmentId,
    sourceSequence,
    inputDigest,
    assignment,
    event,
    source: null,
    sourceQuarantine: null,
    graph: createDefaultWorkGraphMetadata(createdAt),
    currentTarget: assignment.target,
    activeIntentId: null,
    decisionContext: null,
    status,
    revision: 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 0,
    availableAt: null,
    statusReason,
    createdAt,
    updatedAt: createdAt,
  };
}

export function appendWorkLedgerTimeline(
  state,
  entries,
  timelineLimit,
) {
  let nextSequence = state.nextTimelineSequence;
  const appended = entries.map((entry) => {
    const record = contentAddressedLedgerRecord(
      "timelineId",
      "work-timeline",
      {
        sequence: nextSequence,
        itemId: entry.itemId ?? null,
        type: entry.type,
        at: entry.at,
        actorId: entry.actorId ?? null,
        details: entry.details ?? {},
      },
    );
    nextSequence += 1;
    return record;
  });
  const timeline = [...state.timeline, ...appended].slice(-timelineLimit);
  return {
    timeline,
    timelineStartSequence: timeline[0]?.sequence ?? nextSequence,
    nextTimelineSequence: nextSequence,
    appended,
  };
}

export function normalizeLedgerWorkIntent(value) {
  return normalizeWorkIntent(value);
}

export function createWorkIntentRecord(item, intent, requestedBy, createdAt) {
  const intentDigest = ledgerDigest({
    itemId: item.itemId,
    inputDigest: item.inputDigest,
    requestedBy,
    intent,
  });
  return {
    intentId: `work-intent-${intentDigest}`,
    intentDigest,
    itemId: item.itemId,
    inputDigest: item.inputDigest,
    requestedBy,
    intent,
    brainRecovery: null,
    sourceBinding: currentWorkItemInputBinding(item),
    dispatchBinding: null,
    status: "pending",
    revision: 1,
    attempt: 0,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function pendingWorkIntentRecord(existing, candidate, now) {
  if (!existing) return candidate;
  if (!sameBrainRecoveryOrigin(existing, candidate)) {
    throw workLedgerError("WORK_LEDGER_INTENT_CONFLICT", "相同意图的恢复来源不一致", 409);
  }
  if (existing.status !== "failed") {
    throw workLedgerError("WORK_LEDGER_INTENT_CONFLICT", "相同工作意图已经进入 outbox", 409);
  }
  return {
    ...existing,
    status: "pending",
    revision: existing.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    dispatchBinding: null,
    outcome: null,
    updatedAt: now,
  };
}
