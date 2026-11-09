import { createHash } from "node:crypto";
import { validBrainRecoveryStamp } from "./brain-recovery-intent.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import {
  LEGACY_UNKNOWN_WORK_INTENT_BINDING,
  normalizeBoundWorkIntent,
  normalizeWorkIntentDispatchBinding,
} from "../domain/work-intent-dispatch-binding.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from
  "../domain/pull-request-execution-binding.js";
import {
  boundedLedgerString,
  boundedLedgerText,
  canonicalLedgerValue,
  cloneLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTarget,
  normalizeLedgerTimestamp,
  normalizeOptionalLedgerReason,
  prettySerializedLedgerBytes,
  SHA256_PATTERN,
  validatePositiveLimit,
  workLedgerError,
  WORK_LEDGER_OUTBOX_STATUSES,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";
import {
  createDefaultWorkGraphMetadata,
  normalizeWorkLedgerGraphItems,
} from "./work-ledger-graph.js";
import {
  MAX_WORK_GRAPH_MEMORY_EVENTS,
  MAX_WORK_GRAPH_MEMORY_EVENT_BYTES,
  emptyWorkGraphMemoryProjection,
  migrateLegacyWorkGraphMemoryProjection,
  migrateWorkGraphMemoryProjection,
  normalizeWorkGraphMemoryProjection,
  migrateSchema11WorkGraphMemoryAuthority,
  migrateSchema12WorkGraphMemoryAuthority,
  reconcileMigratedWorkGraphMemoryAuthority,
} from "./work-ledger-graph-memory.js";
import {
  graphChildAssignmentId,
  graphChildDefinitionDigest,
  createPullRequestSourceRootWorkItem,
} from "./work-ledger-records.js";
import {
  normalizeWorkResultAttestation,
} from "./work-ledger-result-attestation.js";
import {
  appendPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
  normalizePullRequestInputBinding,
  normalizePullRequestWorkSource,
  pullRequestWorkDescriptor,
} from "./work-ledger-pr-source.js";

export const WORK_LEDGER_STATE_KEY = "work-ledger-state";
export const WORK_LEDGER_STATE_SCHEMA_VERSION = 13;
const GRAPH_MEMORY_STATE_SCHEMA_VERSION = 7;
const DISPATCH_BINDING_STATE_SCHEMA_VERSION = 8;
const PR_INPUT_BINDING_STATE_SCHEMA_VERSION = 9;
const RESULT_ATTESTATION_STATE_SCHEMA_VERSION = 10;
const LEGACY_PR_SOURCE_UNSTARTED_INTENT_REASON =
  "pr_source_legacy_cutover_before_dispatch";
const LEGACY_PR_SOURCE_IDLE_STATUSES = new Set([
  "queued",
  "paused",
  "retry_wait",
  "blocked",
]);
export const MAX_WORK_LEDGER_ITEMS = 5_000;
export const MAX_WORK_LEDGER_SOURCE_ROOTS = 5_000;
export const MAX_WORK_LEDGER_TIMELINE = 20_000;
export const MAX_WORK_LEDGER_OUTBOX = 5_000;
export const MAX_WORK_LEDGER_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_WORK_LEDGER_ITEM_BYTES = 512 * 1024;
export const MAX_WORK_LEDGER_SOURCE_ROOT_BYTES = 64 * 1024 * 1024;
export const MAX_WORK_LEDGER_SOURCE_STATE_BYTES = 128 * 1024 * 1024;
export const MAX_WORK_LEDGER_TIMELINE_BYTES = 64 * 1024;
export const MAX_WORK_LEDGER_INTENT_BYTES = 64 * 1024;
export const MAX_WORK_GRAPH_MEMORY_STATE_BYTES = 32 * 1024 * 1024;

export const WORK_LEDGER_TIMELINE_TYPES = new Set([
  "assignment_intaken",
  "intake_completed",
  "intake_gap",
  "intake_rejected",
  "claimed",
  "lease_expired",
  "transitioned",
  "retry_scheduled",
  "handed_off",
  "completed",
  "intent_staged",
  "intent_claimed",
  "intent_bound",
  "intent_lease_expired",
  "intent_acknowledged",
  "intent_superseded",
  "superseded",
  "legacy_result_discarded",
  "stale_result_discarded",
  "attention_answer_applied",
  "attention_rejection_applied",
  "proposal_result_applied",
  "condition_satisfied",
  "cancelled",
  "graph_child_created",
  "graph_parent_revised",
  "graph_acceptance_revised",
  "graph_delivery_submitted",
  "graph_delivery_accepted",
  "graph_delivery_rejected",
  "pr_source_created",
  "pr_source_revised",
  "pr_source_ignored",
  "pr_source_activated",
]);

const ITEM_KEYS = [
  "itemId",
  "kind",
  "assignmentId",
  "sourceSequence",
  "inputDigest",
  "assignment",
  "event",
  "source",
  "sourceQuarantine",
  "graph",
  "currentTarget",
  "activeIntentId",
  "decisionContext",
  "status",
  "revision",
  "ownerId",
  "leaseId",
  "leaseUntil",
  "attempt",
  "availableAt",
  "statusReason",
  "createdAt",
  "updatedAt",
];
const LEGACY_ITEM_KEYS = ITEM_KEYS.filter(
  (key) => !["source", "sourceQuarantine"].includes(key),
);
const GRAPH_CHILD_KEY =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const LEGACY_ACCEPTANCE_CONTRACT_KEYS = [
  "revision",
  "acceptanceCriteria",
  "expectedDeliverables",
];
const LEGACY_DELIVERY_KEYS = [
  "deliverableId",
  "revision",
  "contractRevision",
  "status",
  "summary",
  "evidence",
];
const TIMELINE_KEYS = [
  "timelineId",
  "contentDigest",
  "sequence",
  "itemId",
  "type",
  "at",
  "actorId",
  "details",
];
const OUTBOX_KEYS = [
  "intentId",
  "intentDigest",
  "itemId",
  "inputDigest",
  "requestedBy",
  "intent",
  "sourceBinding",
  "dispatchBinding",
  "status",
  "revision",
  "attempt",
  "dispatcherId",
  "dispatchLeaseId",
  "dispatchLeaseUntil",
  "outcome",
  "createdAt",
  "updatedAt",
];
const SCHEMA8_OUTBOX_KEYS = OUTBOX_KEYS.filter(
  (key) => key !== "sourceBinding",
);
const LEGACY_OUTBOX_KEYS = SCHEMA8_OUTBOX_KEYS.filter(
  (key) => key !== "dispatchBinding",
);

export function normalizeWorkLedgerLimits(overrides = {}) {
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    Array.isArray(overrides)
  ) {
    throw new TypeError("limits must be an object");
  }
  const known = new Set([
    "itemLimit",
    "sourceRootLimit",
    "timelineLimit",
    "outboxLimit",
    "graphMemoryOutboxLimit",
    "stateByteBudget",
    "itemByteBudget",
    "sourceRootByteBudget",
    "sourceStateByteBudget",
    "timelineByteBudget",
    "intentByteBudget",
    "graphMemoryEventByteBudget",
    "graphMemoryStateByteBudget",
  ]);
  if (Object.keys(overrides).some((key) => !known.has(key))) {
    throw new TypeError("limits contains an unknown field");
  }
  return Object.freeze({
    itemLimit: validatePositiveLimit(
      overrides.itemLimit ?? MAX_WORK_LEDGER_ITEMS,
      MAX_WORK_LEDGER_ITEMS,
      "itemLimit",
    ),
    sourceRootLimit: validatePositiveLimit(
      overrides.sourceRootLimit ?? MAX_WORK_LEDGER_SOURCE_ROOTS,
      MAX_WORK_LEDGER_SOURCE_ROOTS,
      "sourceRootLimit",
    ),
    timelineLimit: validatePositiveLimit(
      overrides.timelineLimit ?? MAX_WORK_LEDGER_TIMELINE,
      MAX_WORK_LEDGER_TIMELINE,
      "timelineLimit",
    ),
    outboxLimit: validatePositiveLimit(
      overrides.outboxLimit ?? MAX_WORK_LEDGER_OUTBOX,
      MAX_WORK_LEDGER_OUTBOX,
      "outboxLimit",
    ),
    graphMemoryOutboxLimit: validatePositiveLimit(
      overrides.graphMemoryOutboxLimit ?? MAX_WORK_GRAPH_MEMORY_EVENTS,
      MAX_WORK_GRAPH_MEMORY_EVENTS,
      "graphMemoryOutboxLimit",
    ),
    stateByteBudget: validatePositiveLimit(
      overrides.stateByteBudget ?? MAX_WORK_LEDGER_STATE_BYTES,
      MAX_WORK_LEDGER_STATE_BYTES,
      "stateByteBudget",
    ),
    itemByteBudget: validatePositiveLimit(
      overrides.itemByteBudget ?? MAX_WORK_LEDGER_ITEM_BYTES,
      MAX_WORK_LEDGER_ITEM_BYTES,
      "itemByteBudget",
    ),
    sourceRootByteBudget: validatePositiveLimit(
      overrides.sourceRootByteBudget ?? MAX_WORK_LEDGER_SOURCE_ROOT_BYTES,
      MAX_WORK_LEDGER_SOURCE_ROOT_BYTES,
      "sourceRootByteBudget",
    ),
    sourceStateByteBudget: validatePositiveLimit(
      overrides.sourceStateByteBudget ?? MAX_WORK_LEDGER_SOURCE_STATE_BYTES,
      MAX_WORK_LEDGER_SOURCE_STATE_BYTES,
      "sourceStateByteBudget",
    ),
    timelineByteBudget: validatePositiveLimit(
      overrides.timelineByteBudget ?? MAX_WORK_LEDGER_TIMELINE_BYTES,
      MAX_WORK_LEDGER_TIMELINE_BYTES,
      "timelineByteBudget",
    ),
    intentByteBudget: validatePositiveLimit(
      overrides.intentByteBudget ?? MAX_WORK_LEDGER_INTENT_BYTES,
      MAX_WORK_LEDGER_INTENT_BYTES,
      "intentByteBudget",
    ),
    graphMemoryEventByteBudget: validatePositiveLimit(
      overrides.graphMemoryEventByteBudget ?? MAX_WORK_GRAPH_MEMORY_EVENT_BYTES,
      MAX_WORK_GRAPH_MEMORY_EVENT_BYTES,
      "graphMemoryEventByteBudget",
    ),
    graphMemoryStateByteBudget: validatePositiveLimit(
      overrides.graphMemoryStateByteBudget ?? MAX_WORK_GRAPH_MEMORY_STATE_BYTES,
      MAX_WORK_GRAPH_MEMORY_STATE_BYTES,
      "graphMemoryStateByteBudget",
    ),
  });
}

export function emptyWorkLedgerState() {
  return {
    schemaVersion: WORK_LEDGER_STATE_SCHEMA_VERSION,
    revision: 0,
    intakeCursor: 0,
    sourceHighWatermark: 0,
    attentionCursor: 0,
    attentionHighWatermark: 0,
    proposalCursor: 0,
    proposalHighWatermark: 0,
    timelineStartSequence: 1,
    nextTimelineSequence: 1,
    items: [],
    timeline: [],
    outbox: [],
    graphMemoryProjection: emptyWorkGraphMemoryProjection(),
  };
}

const DECISION_CONTEXT_SOURCES = new Set([
  "attention",
  "condition",
  "proposal",
]);
const DECISION_CONTEXT_OUTCOMES = new Set([
  "answered",
  "rejected",
  "satisfied",
  "succeeded",
  "stale",
  "failed",
  "unknown",
]);

export function createWorkDecisionContext({
  source,
  referenceId,
  outcome,
  value,
  observedAt,
}) {
  if (!DECISION_CONTEXT_SOURCES.has(source)) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文来源无效",
    );
  }
  if (
    !DECISION_CONTEXT_OUTCOMES.has(outcome) ||
    (source === "attention" && !new Set(["answered", "rejected"]).has(outcome)) ||
    (source === "condition" && outcome !== "satisfied") ||
    (source === "proposal" &&
      !new Set([
        "succeeded",
        "rejected",
        "stale",
        "failed",
        "unknown",
      ]).has(outcome))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文结果无效",
    );
  }
  const normalizedValue = canonicalLedgerValue(value, {
    maximumEntries: 500,
    maximumDepth: 12,
    maximumStringBytes: 4 * 1024,
    errorCode: "WORK_LEDGER_DECISION_CONTEXT_INVALID",
  });
  const core = {
    source,
    referenceId: boundedLedgerString(referenceId, "referenceId", 192),
    outcome,
    value: normalizedValue,
    observedAt: normalizeLedgerTimestamp(observedAt, "observedAt"),
  };
  const context = { ...core, contentDigest: ledgerDigest(core) };
  if (prettySerializedLedgerBytes(context) > 8 * 1024) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文超过容量限制",
    );
  }
  return context;
}

function normalizeDecisionContext(value) {
  if (value === null) return null;
  if (
    !hasExactLedgerKeys(value, [
      "source",
      "referenceId",
      "outcome",
      "value",
      "observedAt",
      "contentDigest",
    ])
  ) {
    throw corrupted("员工工作项决策上下文字段损坏");
  }
  let normalized;
  try {
    normalized = createWorkDecisionContext(value);
  } catch {
    throw corrupted("员工工作项决策上下文损坏");
  }
  if (normalized.contentDigest !== value.contentDigest) {
    throw corrupted("员工工作项决策上下文摘要损坏");
  }
  return normalized;
}

function corrupted(message) {
  return workLedgerError("WORK_LEDGER_STATE_CORRUPTED", message, 503);
}

function canonicalStoredValue(value, message) {
  try {
    return canonicalLedgerValue(value, {
      maximumEntries: 30_000,
      errorCode: "WORK_LEDGER_STATE_CORRUPTED",
    });
  } catch {
    throw corrupted(message);
  }
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw corrupted(`${name} 损坏`);
  }
}

function safeString(value, name, maximumBytes = 256) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw corrupted(`${name} 损坏`);
  }
}

function optionalString(value, name, maximumBytes = 256) {
  return value === null ? null : safeString(value, name, maximumBytes);
}

function normalizeSourceQuarantine(value) {
  if (value === null) return null;
  if (
    !hasExactLedgerKeys(value, [
      "kind",
      "rootItemId",
      "workKey",
      "reason",
    ])
  ) {
    throw corrupted("PR 来源隔离信息损坏");
  }
  const quarantine = {
    kind: safeString(value.kind, "sourceQuarantine.kind", 64),
    rootItemId: safeString(
      value.rootItemId,
      "sourceQuarantine.rootItemId",
      192,
    ),
    workKey: safeString(value.workKey, "sourceQuarantine.workKey", 128),
    reason: safeString(value.reason, "sourceQuarantine.reason", 128),
  };
  if (
    quarantine.kind !== LEGACY_PR_SOURCE_QUARANTINE_KIND ||
    quarantine.reason !== LEGACY_PR_SOURCE_CUTOVER_REASON
  ) {
    throw corrupted("PR 来源隔离类型损坏");
  }
  return quarantine;
}

function denseLedgerArrayValues(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return null;
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    entries.push(descriptor.value);
  }
  return entries;
}

function workItemCapacityView(item) {
  const baseItem = { ...item };
  delete baseItem.graph;
  if (baseItem.source === null) delete baseItem.source;
  if (baseItem.sourceQuarantine === null) delete baseItem.sourceQuarantine;
  return baseItem;
}

function workLedgerCapacityView(state) {
  // Preserve the legacy ledger budget while the graph contract enforces its
  // own independent task, structure, delivery, and total-byte hard limits.
  const { graphMemoryProjection: _graphMemoryProjection, ...ledger } = state;
  return {
    ...ledger,
    // Schema growth is migration metadata, not user capacity. Keep its
    // serialized width stable so a version bump cannot strand an exact-limit
    // legacy state before it has a chance to compact or advance.
    schemaVersion: 1,
    items: state.items
      .filter(({ kind }) => kind !== "source_root")
      .map(workItemCapacityView),
  };
}

function sourceRootCapacityView(state) {
  return state.items
    .filter(({ kind }) => kind === "source_root")
    .map(workItemCapacityView);
}

export function retainWorkLedgerTimelineForCapacity(previousState, candidate, limits) {
  const currentBytes = prettySerializedLedgerBytes(workLedgerCapacityView(candidate));
  if (currentBytes <= limits.stateByteBudget) return candidate;

  const previousBySequence = new Map(previousState.timeline.map(entry => [entry.sequence, entry]));
  let removed = 0;
  let releasedBytes = 0;
  const targetBytes = Math.floor(limits.stateByteBudget * 0.9);
  for (const entry of candidate.timeline) {
    if (currentBytes - releasedBytes <= targetBytes) break;
    // Only rotate genuine existing history. Never discard this transaction's
    // receipts or hide altered history before the normal validation runs.
    const previous = previousBySequence.get(entry.sequence);
    if (entry.sequence >= previousState.nextTimelineSequence || previous === undefined ||
        JSON.stringify(entry) !== JSON.stringify(previous)) break;
    const serialized = JSON.stringify(entry, null, 2);
    const lines = 1 + (serialized.match(/\n/g)?.length ?? 0);
    releasedBytes += Buffer.byteLength(serialized, 'utf8') + lines * 4 + 2;
    removed += 1;
  }
  if (removed === 0) return candidate;
  const timeline = candidate.timeline.slice(removed);
  return { ...candidate, timeline,
    timelineStartSequence: timeline[0]?.sequence ?? candidate.nextTimelineSequence };
}

function assertGraphDeliveryHistory(items) {
  for (const item of items) {
    let pending = null;
    const acceptedDeliverables = new Set();
    for (const delivery of item.graph.deliveries) {
      if (delivery.status === "submitted") {
        if (pending !== null) {
          throw corrupted("任务存在多个未裁决交付物");
        }
        const deliveryKey = `${delivery.contractRevision}:${delivery.deliverableId}`;
        if (acceptedDeliverables.has(deliveryKey)) {
          throw corrupted("已验收交付物不能在同一契约下重新提交");
        }
        pending = delivery;
        continue;
      }
      if (
        pending === null ||
        delivery.revision !== pending.revision + 1 ||
        delivery.deliverableId !== pending.deliverableId ||
        delivery.contractRevision !== pending.contractRevision ||
        JSON.stringify(delivery.evidence) !== JSON.stringify(pending.evidence)
      ) {
        throw corrupted("交付审核没有绑定紧邻的提交记录");
      }
      if (delivery.status === "accepted") {
        acceptedDeliverables.add(
          `${delivery.contractRevision}:${delivery.deliverableId}`,
        );
      }
      pending = null;
    }
    if (
      pending !== null &&
      pending.contractRevision !== item.graph.acceptanceContracts.at(-1).revision
    ) {
      throw corrupted("待审核交付物绑定了过期验收契约");
    }
    if (
      (pending !== null) !==
        (item.status === "waiting_external" &&
          item.statusReason === "delivery_submitted")
    ) {
      throw corrupted("待审核交付物与任务等待状态不一致");
    }
  }
}

function assertGraphTaskProvenance(
  kind,
  assignmentId,
  assignment,
  event,
  graph,
) {
  if (kind !== "graph_task") return;
  if (
    assignment.reason !== "graph_child_created" ||
    !hasExactLedgerKeys(assignment.graphTask, [
      "parentTaskId",
      "childKey",
      "initialDependsOnTaskIds",
      "definitionDigest",
      "sourceBinding",
    ]) ||
    !hasExactLedgerKeys(assignment.work, ["title", "description"])
  ) {
    throw corrupted("图任务来源字段损坏");
  }
  const parentTaskId = safeString(
    assignment.graphTask.parentTaskId,
    "graphTask.parentTaskId",
    192,
  );
  const childKey = safeString(
    assignment.graphTask.childKey,
    "graphTask.childKey",
    128,
  );
  const title = safeString(assignment.work.title, "graphTask.work.title", 256);
  let description;
  try { description = boundedLedgerText(assignment.work.description, "graphTask.work.description", 16 * 1024); }
  catch { throw corrupted("graphTask.work.description 损坏"); }
  let sourceBinding = null;
  if (assignment.graphTask.sourceBinding !== null) {
    try {
      sourceBinding = normalizePullRequestInputBinding(
        assignment.graphTask.sourceBinding,
      );
    } catch {
      throw corrupted("图任务 PR 来源绑定损坏");
    }
  }
  assignment.graphTask.sourceBinding = sourceBinding;
  const initialDependsOnTaskIds = denseLedgerArrayValues(
    assignment.graphTask.initialDependsOnTaskIds,
  );
  const currentDependsOnTaskIds = denseLedgerArrayValues(
    graph.dependsOnItemIds,
  );
  const acceptanceContracts = denseLedgerArrayValues(graph.acceptanceContracts);
  if (
    !GRAPH_CHILD_KEY.test(childKey) ||
    !SHA256_PATTERN.test(assignment.graphTask.definitionDigest) ||
    graph.parentItemId !== parentTaskId ||
    assignmentId !== graphChildAssignmentId(
      parentTaskId,
      childKey,
      sourceBinding,
    ) ||
    initialDependsOnTaskIds === null ||
    initialDependsOnTaskIds.length > 128 ||
    currentDependsOnTaskIds === null ||
    acceptanceContracts === null ||
    acceptanceContracts.length < 1
  ) {
    throw corrupted("图任务来源绑定损坏");
  }
  const normalizedInitialDependencies = initialDependsOnTaskIds.map(
    (taskId) => safeString(taskId, "graphTask.initialDependsOnTaskIds", 192),
  );
  const sortedInitialDependencies = [...normalizedInitialDependencies].sort();
  if (
    new Set(normalizedInitialDependencies).size !==
      normalizedInitialDependencies.length ||
    normalizedInitialDependencies.some(
      (taskId, index) => taskId !== sortedInitialDependencies[index],
    ) ||
    currentDependsOnTaskIds.length !== normalizedInitialDependencies.length ||
    currentDependsOnTaskIds.some(
      (taskId, index) => taskId !== normalizedInitialDependencies[index],
    )
  ) {
    throw corrupted("图任务初始依赖损坏");
  }
  let expectedDefinitionDigest;
  try {
    const initialContract = acceptanceContracts[0];
    expectedDefinitionDigest = graphChildDefinitionDigest({
      parentItemId: parentTaskId,
      childKey,
      work: { title, description },
      target: assignment.target,
      dependsOnItemIds: normalizedInitialDependencies,
      acceptanceContract: {
        revision: initialContract.revision,
        acceptanceCriteria: initialContract.acceptanceCriteria,
        expectedDeliverables: initialContract.expectedDeliverables,
      },
      sourceBinding,
    });
  } catch {
    throw corrupted("图任务定义摘要损坏");
  }
  if (assignment.graphTask.definitionDigest !== expectedDefinitionDigest) {
    throw corrupted("图任务定义摘要损坏");
  }
  try {
    const normalizedEvent = normalizeStoredWorkflowEvent(event);
    if (
      assignment.eventId !== normalizedEvent.eventId ||
      (sourceBinding !== null &&
        (sourceBinding.eventId !== normalizedEvent.eventId ||
          sourceBinding.eventDigest !== normalizedEvent.contentDigest ||
          sourceBinding.headRefOid !== normalizedEvent.payload.headRefOid))
    ) {
      throw new Error("event binding mismatch");
    }
  } catch {
    throw corrupted("图任务来源事件损坏");
  }
}

function normalizeItem(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, ITEM_KEYS)) {
    throw corrupted("员工工作项字段损坏");
  }
  const assignment = canonicalStoredValue(value.assignment, "分派内容损坏");
  const event = canonicalStoredValue(value.event, "分派事件损坏");
  let source = null;
  if (value.source !== null) {
    try {
      source = normalizePullRequestWorkSource(value.source);
    } catch {
      throw corrupted("PR 来源历史损坏");
    }
  }
  const sourceQuarantine = normalizeSourceQuarantine(value.sourceQuarantine);
  const graph = canonicalStoredValue(value.graph, "工作图元数据损坏");
  const assignmentId = safeString(value.assignmentId, "assignmentId", 192);
  const sourceRoot = value.kind === "source_root";
  if (
    assignment.assignmentId !== assignmentId ||
    !assignment.target ||
    (!sourceRoot &&
      assignment.eventId !== undefined &&
      event.eventId !== undefined &&
      assignment.eventId !== event.eventId)
  ) {
    throw corrupted("员工工作项输入引用不一致");
  }
  let originalTarget;
  let currentTarget;
  try {
    originalTarget = normalizeLedgerTarget(assignment.target);
    currentTarget = normalizeLedgerTarget(value.currentTarget);
  } catch {
    throw corrupted("员工工作项目标损坏");
  }
  assignment.target = originalTarget;
  const legacyInputDigest = ledgerDigest({ assignment, event }, {
    maximumEntries: 30_000,
    errorCode: "WORK_LEDGER_STATE_CORRUPTED",
  });
  const inputDigest = sourceRoot
    ? source?.current.inputDigest
    : legacyInputDigest;
  const expectedItemId = sourceRoot
    ? `work-item-${ledgerDigest({
        kind: "source_root",
        workKey: source?.workKey,
      })}`
    : `work-item-${ledgerDigest({
        assignmentId,
        inputDigest,
      })}`;
  if (sourceRoot) {
    let origin;
    try {
      origin = normalizeStoredWorkflowEvent(event);
    } catch {
      throw corrupted("PR 来源根初始事件损坏");
    }
    const firstRevision = source?.revisions[0];
    const expectedAssignmentId = source
      ? `pr-source-assignment-${ledgerDigest(source.identity)}`
      : null;
    if (
      source === null ||
      !hasExactLedgerKeys(assignment, [
        "assignmentId",
        "target",
        "reason",
      ]) ||
      assignmentId !== expectedAssignmentId ||
      assignment.reason !== "stable_pr_source_root" ||
      originalTarget.type !== "role" ||
      originalTarget.id !== source.identity.targetRoleId ||
      origin.eventId !== firstRevision?.eventId ||
      origin.contentDigest !== firstRevision?.eventDigest
    ) {
      throw corrupted("PR 来源根身份绑定损坏");
    }
  } else if (source !== null) {
    throw corrupted("普通工作项不能携带 PR 来源流");
  }
  if (
    value.inputDigest !== inputDigest ||
    value.itemId !== expectedItemId ||
    !["assignment", "system_alert", "graph_task", "source_root"].includes(
      value.kind,
    ) ||
    !Number.isSafeInteger(value.sourceSequence) ||
    value.sourceSequence < 0 ||
    (value.kind === "assignment"
      ? value.sourceSequence < 1
      : value.sourceSequence !== 0) ||
    !WORK_LEDGER_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > stateRevision ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw corrupted("员工工作项状态损坏");
  }
  if (source?.decisionBudget && source.decisionBudget.attemptOffset > value.attempt) {
    throw corrupted("PR decision budget 超过累计领取计数");
  }
  assertGraphTaskProvenance(
    value.kind,
    assignmentId,
    assignment,
    event,
    graph,
  );
  const ownerId = optionalString(value.ownerId, "ownerId", 128);
  const leaseId = optionalString(value.leaseId, "leaseId", 128);
  const leaseUntil = value.leaseUntil === null
    ? null
    : timestamp(value.leaseUntil, "leaseUntil");
  const availableAt = value.availableAt === null
    ? null
    : timestamp(value.availableAt, "availableAt");
  const activeIntentId = optionalString(
    value.activeIntentId,
    "activeIntentId",
    192,
  );
  const working = value.status === "working";
  if (
    working !== (ownerId !== null && leaseId !== null && leaseUntil !== null) ||
    (value.status === "retry_wait") !== (availableAt !== null) ||
    (value.kind === "system_alert" &&
      !["blocked", "cancelled"].includes(value.status))
  ) {
    throw corrupted("员工工作项租约或等待状态损坏");
  }
  let statusReason;
  try {
    statusReason = normalizeOptionalLedgerReason(value.statusReason, "statusReason");
  } catch {
    throw corrupted("员工工作项原因损坏");
  }
  const item = {
    itemId: value.itemId,
    kind: value.kind,
    assignmentId,
    sourceSequence: value.sourceSequence,
    inputDigest,
    assignment,
    event,
    source,
    sourceQuarantine,
    graph,
    currentTarget,
    activeIntentId,
    decisionContext: normalizeDecisionContext(value.decisionContext),
    status: value.status,
    revision: value.revision,
    ownerId,
    leaseId,
    leaseUntil,
    attempt: value.attempt,
    availableAt,
    statusReason,
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
  };
  if (
    Date.parse(item.updatedAt) < Date.parse(item.createdAt) ||
    prettySerializedLedgerBytes(workItemCapacityView(item)) >
      (item.kind === "source_root"
        ? limits.sourceRootByteBudget
        : limits.itemByteBudget)
  ) {
    throw corrupted("员工工作项超过容量或时间顺序损坏");
  }
  return item;
}

function normalizeTimelineEntry(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, TIMELINE_KEYS)) {
    throw corrupted("员工工作时间线字段损坏");
  }
  const { timelineId, contentDigest, ...content } = value;
  const normalizedContent = canonicalStoredValue(content, "员工工作时间线损坏");
  const expectedDigest = ledgerDigest(normalizedContent);
  if (
    timelineId !== `work-timeline-${expectedDigest}` ||
    contentDigest !== expectedDigest ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !WORK_LEDGER_TIMELINE_TYPES.has(value.type) ||
    (value.itemId !== null && typeof value.itemId !== "string") ||
    value.sequence > stateRevision * 100_000 + 100_000
  ) {
    throw corrupted("员工工作时间线摘要或类型损坏");
  }
  const details = canonicalStoredValue(value.details, "时间线详情损坏");
  if (Object.hasOwn(details, "inputBinding")) {
    if (
      !Number.isSafeInteger(details.workItemRevision) ||
      details.workItemRevision < 1 ||
      typeof details.inputDigest !== "string" ||
      !SHA256_PATTERN.test(details.inputDigest)
    ) {
      throw corrupted("员工工作时间线权威描述损坏");
    }
    if (details.inputBinding !== null) {
      try {
        details.inputBinding = normalizePullRequestExecutionBinding(
          details.inputBinding,
        );
      } catch {
        throw corrupted("员工工作时间线 PR 输入绑定损坏");
      }
    }
  }
  const entry = {
    timelineId,
    contentDigest,
    sequence: value.sequence,
    itemId: value.itemId === null ? null : safeString(value.itemId, "itemId", 192),
    type: value.type,
    at: timestamp(value.at, "timeline.at"),
    actorId: optionalString(value.actorId, "actorId", 128),
    details,
  };
  if (prettySerializedLedgerBytes(entry) > limits.timelineByteBudget) {
    throw corrupted("员工工作时间线超过容量");
  }
  return entry;
}

function validateTimelineInputAuthorities(state) {
  const itemById = new Map(state.items.map((item) => [item.itemId, item]));
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const outboxByDownstreamRef = new Map();
  for (const outbox of state.outbox) {
    const downstreamRef = outbox.outcome?.details?.downstreamRef;
    if (typeof downstreamRef !== "string") continue;
    outboxByDownstreamRef.set(
      downstreamRef,
      outboxByDownstreamRef.has(downstreamRef) ? null : outbox,
    );
  }
  const fields = [
    "workKey",
    "inputRevision",
    "headRevision",
    "headRefOid",
    "eventId",
    "eventDigest",
    "inputDigest",
  ];
  for (const entry of state.timeline) {
    if (!Object.hasOwn(entry.details, "inputBinding")) continue;
    const item = itemById.get(entry.itemId);
    if (item === undefined) {
      throw corrupted("员工工作时间线找不到绑定工作项");
    }
    let outbox = typeof entry.details.intentId === "string"
      ? outboxById.get(entry.details.intentId)
      : undefined;
    if (entry.type === "proposal_result_applied" && outbox === undefined) {
      outbox = outboxByDownstreamRef.get(entry.details.proposalId);
    }
    if (entry.type === "intent_staged") {
      validateIntentStagedTimeline(entry, outbox);
    }
    validateResultTimelineAttestation(entry, item, outbox);
    const binding = entry.details.inputBinding;
    if (binding === null) {
      if (currentWorkItemInputBinding(item) !== null) {
        throw corrupted("员工工作时间线缺少 PR 输入绑定");
      }
      continue;
    }
    const root = itemById.get(binding.rootItemId);
    if (
      root?.source?.kind !== "pull_request" ||
      root.source.identity.repository !== binding.repository ||
      root.source.identity.pullRequestNumber !== binding.pullRequestNumber ||
      root.source.workKey !== binding.workKey
    ) {
      throw corrupted("员工工作时间线 PR 来源绑定不一致");
    }
    const revision = root.source.revisions[binding.inputRevision - 1];
    if (
      revision === undefined ||
      revision.headRevision !== binding.headRevision ||
      revision.headRefOid !== binding.headRefOid ||
      revision.eventId !== binding.eventId ||
      revision.eventDigest !== binding.eventDigest ||
      revision.inputDigest !== binding.inputDigest ||
      Date.parse(entry.at) < Date.parse(revision.occurredAt)
    ) {
      throw corrupted("员工工作时间线 PR 修订绑定不一致");
    }
    if (item.itemId !== root.itemId) {
      const inherited = currentWorkItemInputBinding(item);
      if (
        inherited === null ||
        fields.some((field) => inherited[field] !== binding[field]) ||
        inherited.rootItemId !== binding.rootItemId
      ) {
        throw corrupted("员工工作时间线 PR 工作项绑定不一致");
      }
    }
    const timelineInputDigest = item.itemId === root.itemId
      ? binding.inputDigest
      : item.inputDigest;
    if (entry.details.inputDigest !== timelineInputDigest) {
      throw corrupted("员工工作时间线 PR 工作修订绑定不一致");
    }
    if (
      outbox === undefined ||
      outbox === null ||
      outbox.itemId !== item.itemId ||
      outbox.inputDigest !== timelineInputDigest ||
      !samePullRequestBinding(outbox.sourceBinding, binding) ||
      Date.parse(entry.at) < Date.parse(outbox.createdAt)
    ) {
      throw corrupted("员工工作时间线 PR 意图绑定不一致");
    }
    const dispatchInputBinding =
      outbox.dispatchBinding?.boundIntent?.binding?.inputBinding;
    if (dispatchInputBinding !== undefined) {
      let normalizedDispatchBinding;
      try {
        normalizedDispatchBinding = normalizePullRequestExecutionBinding(
          dispatchInputBinding,
        );
      } catch {
        throw corrupted("员工工作时间线 PR 策略绑定损坏");
      }
      if (!samePullRequestExecutionBinding(normalizedDispatchBinding, binding)) {
        throw corrupted("员工工作时间线 PR 策略绑定不一致");
      }
    }
  }
}

function normalizeIntent(value) {
  try {
    return normalizeWorkIntent(value);
  } catch {
    throw corrupted("员工工作意图类型损坏");
  }
}

function normalizeRequestedBy(value) {
  if (!hasExactLedgerKeys(value, ["roleId", "workerId"])) {
    throw corrupted("员工工作意图请求身份损坏");
  }
  return {
    roleId: safeString(value.roleId, "requestedBy.roleId", 128),
    workerId: safeString(value.workerId, "requestedBy.workerId", 128),
  };
}

function normalizeOutboxEntry(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, OUTBOX_KEYS) && !hasExactLedgerKeys(value, [...OUTBOX_KEYS, "brainRecovery"])) {
    throw corrupted("员工工作 outbox 字段损坏");
  }
  const intent = normalizeIntent(value.intent);
  const requestedBy = normalizeRequestedBy(value.requestedBy);
  let sourceBinding = null;
  if (value.sourceBinding !== null) {
    try {
      sourceBinding = normalizePullRequestInputBinding(value.sourceBinding);
    } catch {
      throw corrupted("员工工作意图 PR 来源绑定损坏");
    }
  }
  let dispatchBinding = null;
  if (value.dispatchBinding !== null) {
    if (
      hasExactLedgerKeys(value.dispatchBinding, ["status"]) &&
      value.dispatchBinding.status === LEGACY_UNKNOWN_WORK_INTENT_BINDING
    ) {
      if (value.status !== "dispatching") {
        throw corrupted("历史员工工作意图策略绑定状态损坏");
      }
      dispatchBinding = { status: "legacy_unknown" };
    } else {
      try {
        dispatchBinding = normalizeWorkIntentDispatchBinding(
          value.dispatchBinding,
        );
      } catch {
        throw corrupted("员工工作意图策略绑定损坏");
      }
    }
  }
  const itemId = safeString(value.itemId, "outbox.itemId", 192);
  const inputDigest = value.inputDigest;
  const intentDigest = ledgerDigest({ itemId, inputDigest, requestedBy, intent });
  if (
    value.intentDigest !== intentDigest ||
    value.intentId !== `work-intent-${intentDigest}` ||
    !SHA256_PATTERN.test(inputDigest) ||
    !WORK_LEDGER_OUTBOX_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > stateRevision ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw corrupted("员工工作 outbox 摘要或状态损坏");
  }
  const dispatcherId = optionalString(value.dispatcherId, "dispatcherId", 128);
  const dispatchLeaseId = optionalString(
    value.dispatchLeaseId,
    "dispatchLeaseId",
    128,
  );
  const dispatchLeaseUntil = value.dispatchLeaseUntil === null
    ? null
    : timestamp(value.dispatchLeaseUntil, "dispatchLeaseUntil");
  const dispatching = value.status === "dispatching";
  if (
    dispatching !==
    (dispatcherId !== null &&
      dispatchLeaseId !== null &&
      dispatchLeaseUntil !== null) ||
    (["pending", "dispatching"].includes(value.status) !==
      (value.outcome === null))
  ) {
    throw corrupted("员工工作 outbox 租约或结果损坏");
  }
  const entry = {
    intentId: value.intentId,
    intentDigest,
    itemId,
    inputDigest,
    requestedBy,
    intent,
    ...(Object.hasOwn(value, "brainRecovery") ? { brainRecovery: value.brainRecovery } : {}),
    sourceBinding,
    dispatchBinding,
    status: value.status,
    revision: value.revision,
    attempt: value.attempt,
    dispatcherId,
    dispatchLeaseId,
    dispatchLeaseUntil,
    outcome: value.outcome === null
      ? null
      : canonicalStoredValue(value.outcome, "outbox 结果损坏"),
    createdAt: timestamp(value.createdAt, "outbox.createdAt"),
    updatedAt: timestamp(value.updatedAt, "outbox.updatedAt"),
  };
  if (Object.hasOwn(entry, "brainRecovery") && !validBrainRecoveryStamp(entry)) {
    throw corrupted("员工工作意图恢复来源绑定损坏");
  }
  if (prettySerializedLedgerBytes(entry.intent) > limits.intentByteBudget) {
    throw corrupted("员工工作意图超过容量");
  }
  if (
    dispatchBinding !== null &&
    Object.hasOwn(dispatchBinding, "boundIntent") &&
    prettySerializedLedgerBytes(dispatchBinding.boundIntent) >
      limits.intentByteBudget
  ) {
    throw corrupted("员工工作意图策略绑定超过容量");
  }
  return entry;
}

function assertUnique(records, field, message) {
  const values = records.map((record) => record[field]);
  if (new Set(values).size !== values.length) throw corrupted(message);
}

function pullRequestRevisionForBinding(binding, itemIndex) {
  if (binding === null) return null;
  const root = itemIndex.get(binding.rootItemId);
  const revision = root?.source?.kind === "pull_request"
    ? root.source.revisions[binding.inputRevision - 1]
    : null;
  return (
      revision?.disposition === "accepted" &&
      binding.workKey === root.source.workKey &&
      binding.headRevision === revision.headRevision &&
      binding.headRefOid === revision.headRefOid &&
      binding.eventId === revision.eventId &&
      binding.eventDigest === revision.eventDigest &&
      binding.inputDigest === revision.inputDigest
    )
    ? { root, revision }
    : null;
}

function samePullRequestBinding(left, right) {
  return left !== null && right !== null &&
    left.kind === right.kind &&
    left.rootItemId === right.rootItemId &&
    left.workKey === right.workKey &&
    left.inputRevision === right.inputRevision &&
    left.headRevision === right.headRevision &&
    left.headRefOid === right.headRefOid &&
    left.eventId === right.eventId &&
    left.eventDigest === right.eventDigest &&
    left.inputDigest === right.inputDigest;
}

const PROPOSAL_RESULT_INTENT_TYPES = new Map([
  ["github_review_proposal", "propose_github_review"],
  [
    "github_pull_request_action_proposal",
    "propose_github_pull_request_action",
  ],
  ["code_action_proposal", "propose_code_action"],
  ["configuration_change_proposal", "propose_configuration_change"],
]);

const RESULT_TIMELINE_TYPES = new Set([
  "proposal_result_applied",
  "attention_answer_applied",
  "attention_rejection_applied",
]);

function sameLedgerValue(left, right) {
  try {
    return ledgerDigest(left) === ledgerDigest(right);
  } catch {
    return false;
  }
}

function expectedProposalDecision(result) {
  return createWorkDecisionContext({
    source: "proposal",
    referenceId: result.proposalId,
    outcome: result.outcome,
    value: {
      kind: result.kind,
      resultId: result.resultId,
      resultDigest: result.contentDigest,
      summary: result.summary,
      downstreamRef: result.downstreamRef,
      evidence: result.evidence,
    },
    observedAt: result.at,
  });
}

function expectedAttentionDecision(payload) {
  return createWorkDecisionContext({
    source: "attention",
    referenceId: payload.requestId,
    outcome: payload.result.kind,
    value: {
      answer: payload.result.answer,
      requestContentDigest: payload.requestContentDigest,
      resultId: payload.result.resultId,
      resultDigest: payload.result.contentDigest,
    },
    observedAt: payload.result.at,
  });
}

function validateIntentStagedTimeline(entry, outbox) {
  if (
    outbox === undefined ||
    outbox === null ||
    entry.details.intentId !== outbox.intentId ||
    entry.details.intentDigest !== outbox.intentDigest ||
    entry.details.intentType !== outbox.intent.type ||
    entry.details.inputDigest !== outbox.inputDigest ||
    !sameLedgerValue(entry.details.requestedBy, outbox.requestedBy)
  ) {
    throw corrupted("员工工作意图时间线与 outbox 身份不一致");
  }
  if (outbox.intent.type !== "ask_user") return;
  const consultationRequest = {
    summary: outbox.intent.summary,
    reason: outbox.intent.reason,
    question: outbox.intent.question,
    choices: outbox.intent.choices,
  };
  if (!sameLedgerValue(entry.details.consultationRequest, consultationRequest)) {
    throw corrupted("员工请示时间线与 outbox 请求不一致");
  }
}

function validateProposalResultTimeline(entry, item, outbox, attestation) {
  const result = attestation.payload;
  const decision = expectedProposalDecision(result);
  const outcome = outbox.outcome;
  if (
    attestation.kind !== "proposal_result" ||
    attestation.intentId !== outbox.intentId ||
    entry.details.intentId !== outbox.intentId ||
    attestation.decisionContentDigest !== decision.contentDigest ||
    result.requestedBy.workItemId !== item.itemId ||
    result.requestedBy.roleId !== outbox.requestedBy.roleId ||
    PROPOSAL_RESULT_INTENT_TYPES.get(result.kind) !== outbox.intent.type ||
    outcome?.status !== "delivered" ||
    outcome.details?.downstreamRef !== result.proposalId ||
    outcome.details?.proposalDigest !== result.proposalContentDigest ||
    entry.details.proposalId !== result.proposalId ||
    entry.details.resultRef !== result.resultId ||
    entry.details.outcome !== result.outcome ||
    entry.details.downstreamRef !== result.downstreamRef ||
    !sameLedgerValue(entry.details.evidenceRefs, result.evidence) ||
    !sameLedgerValue(entry.details.decision, decision)
  ) {
    throw corrupted("员工工作提案结果凭据不一致");
  }
}

function validateAttentionResultTimeline(entry, item, outbox, attestation) {
  const payload = attestation.payload;
  const decision = expectedAttentionDecision(payload);
  const expectedType = payload.result.kind === "rejected"
    ? "attention_rejection_applied"
    : "attention_answer_applied";
  if (
    attestation.kind !== "attention_result" ||
    attestation.intentId !== outbox.intentId ||
    payload.requestKey !== outbox.intentId ||
    entry.details.intentId !== outbox.intentId ||
    attestation.decisionContentDigest !== decision.contentDigest ||
    payload.producer.workItemId !== item.itemId ||
    payload.producer.roleId !== outbox.requestedBy.roleId ||
    outbox.intent.type !== "ask_user" ||
    outbox.outcome?.status !== "delivered" ||
    outbox.outcome.details?.questionRef !== payload.requestId ||
    entry.type !== expectedType ||
    entry.details.questionRef !== payload.requestId ||
    entry.details.resultRef !== payload.result.resultId ||
    entry.details.outcome !== payload.result.kind ||
    entry.details.requestContentDigest !== payload.requestContentDigest ||
    entry.details.resultDigest !== payload.result.contentDigest ||
    !sameLedgerValue(entry.details.answer, payload.result.answer)
  ) {
    throw corrupted("员工请示结果凭据不一致");
  }
}

function validateResultTimelineAttestation(entry, item, outbox) {
  if (!RESULT_TIMELINE_TYPES.has(entry.type)) return;
  const marker = entry.details.resultAttestationDigest;
  const stored = outbox?.outcome?.details?.resultAttestation;
  if (
    typeof marker !== "string" ||
    !SHA256_PATTERN.test(marker) ||
    stored === undefined
  ) {
    throw corrupted("员工工作结果凭据缺失");
  }
  let attestation;
  try {
    attestation = normalizeWorkResultAttestation(stored);
  } catch {
    throw corrupted("员工工作结果凭据损坏");
  }
  if (marker !== attestation.attestationDigest || outbox === undefined) {
    throw corrupted("员工工作结果凭据摘要不一致");
  }
  if (entry.type === "proposal_result_applied") {
    validateProposalResultTimeline(entry, item, outbox, attestation);
    return;
  }
  validateAttentionResultTimeline(entry, item, outbox, attestation);
}

export function assertWorkLedgerCapacity(state, limits) {
  const sourceRootCount = state.items.filter(
    ({ kind }) => kind === "source_root",
  ).length;
  const operationalItemCount = state.items.length - sourceRootCount;
  const graphMigrationAllowance = Math.max(
    1,
    state.items.filter(
      (item) => currentWorkItemInputBinding(item) !== null,
    ).length,
  );
  const graphPending = state.graphMemoryProjection.pending;
  const policyObservationAllowance = graphPending.at(-1)?.schemaVersion === 2 &&
    graphPending.at(-1)?.kind === "authority_observed" ? 1 : 0;
  const graphPendingWithinCapacity =
    graphPending.length <= MAX_WORK_GRAPH_MEMORY_EVENTS && (
      graphPending.length <= limits.graphMemoryOutboxLimit ||
      (graphPending.length <=
          limits.graphMemoryOutboxLimit + graphMigrationAllowance + policyObservationAllowance &&
        graphPending.slice(limits.graphMemoryOutboxLimit).every(
          (event) =>
            event.schemaVersion === 2 &&
            ["authority_invalidated", "authority_observed"].includes(event.kind),
        )));
  if (
    operationalItemCount > limits.itemLimit ||
    sourceRootCount > limits.sourceRootLimit ||
    state.timeline.length > limits.timelineLimit ||
    state.outbox.length > limits.outboxLimit ||
    !graphPendingWithinCapacity ||
    state.items.some(
      (item) =>
        prettySerializedLedgerBytes(workItemCapacityView(item)) >
        (item.kind === "source_root"
          ? limits.sourceRootByteBudget
          : limits.itemByteBudget),
    ) ||
    state.timeline.some(
      (entry) => prettySerializedLedgerBytes(entry) > limits.timelineByteBudget,
    ) ||
    state.outbox.some(
      (entry) =>
        prettySerializedLedgerBytes(entry.intent) > limits.intentByteBudget ||
        (entry.dispatchBinding !== null &&
          Object.hasOwn(entry.dispatchBinding, "boundIntent") &&
          prettySerializedLedgerBytes(entry.dispatchBinding.boundIntent) >
            limits.intentByteBudget),
    ) ||
    state.graphMemoryProjection.pending.some(
      (event) =>
        prettySerializedLedgerBytes(event) >
        limits.graphMemoryEventByteBudget,
    ) ||
    prettySerializedLedgerBytes(state.graphMemoryProjection) >
      limits.graphMemoryStateByteBudget ||
    prettySerializedLedgerBytes(workLedgerCapacityView(state)) >
      limits.stateByteBudget ||
    prettySerializedLedgerBytes(sourceRootCapacityView(state)) >
      limits.sourceStateByteBudget
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CAPACITY_EXCEEDED",
      "员工工作台账达到安全容量上限，未推进读取游标",
      409,
    );
  }
}

function migrateLegacyGraphRecords(value, expectedKeys, recordedAt, label) {
  const records = denseLedgerArrayValues(value);
  if (records === null) throw corrupted(`${label}历史损坏`);
  return records.map((record) => {
    if (!hasExactLedgerKeys(record, expectedKeys)) {
      throw corrupted(`${label}历史损坏`);
    }
    return {
      ...canonicalStoredValue(record, `${label}历史损坏`),
      recordedAt,
    };
  });
}

function migrateLegacyGraphHistory(item) {
  if (!hasExactLedgerKeys(item, LEGACY_ITEM_KEYS)) {
    throw corrupted("旧版员工工作项字段损坏");
  }
  if (
    !hasExactLedgerKeys(item.graph, [
      "parentItemId",
      "dependsOnItemIds",
      "acceptanceContracts",
      "deliveries",
    ])
  ) {
    throw corrupted("旧版工作图元数据损坏");
  }
  const recordedAt = timestamp(item.createdAt, "item.createdAt");
  return {
    ...item,
    graph: {
      parentItemId: item.graph.parentItemId,
      dependsOnItemIds: item.graph.dependsOnItemIds,
      acceptanceContracts: migrateLegacyGraphRecords(
        item.graph.acceptanceContracts,
        LEGACY_ACCEPTANCE_CONTRACT_KEYS,
        recordedAt,
        "验收契约",
      ),
      deliveries: migrateLegacyGraphRecords(
        item.graph.deliveries,
        LEGACY_DELIVERY_KEYS,
        recordedAt,
        "交付",
      ),
    },
  };
}

function safeLegacyPrSourceItem(item, referencedItemIds, outboxItemIds) {
  const graph = item.graph;
  const contract = Array.isArray(graph?.acceptanceContracts)
    ? graph.acceptanceContracts[0]
    : null;
  return (
    item.kind === "assignment" &&
    item.status === "queued" &&
    item.activeIntentId === null &&
    item.decisionContext === null &&
    item.ownerId === null &&
    item.leaseId === null &&
    item.leaseUntil === null &&
    item.availableAt === null &&
    graph?.parentItemId === null &&
    Array.isArray(graph.dependsOnItemIds) &&
    graph.dependsOnItemIds.length === 0 &&
    Array.isArray(graph.deliveries) &&
    graph.deliveries.length === 0 &&
    Array.isArray(graph.acceptanceContracts) &&
    graph.acceptanceContracts.length === 1 &&
    contract?.revision === 1 &&
    Array.isArray(contract.acceptanceCriteria) &&
    contract.acceptanceCriteria.length === 0 &&
    Array.isArray(contract.expectedDeliverables) &&
    contract.expectedDeliverables.length === 0 &&
    !referencedItemIds.has(item.itemId) &&
    !outboxItemIds.has(item.itemId)
  );
}

function unstartedLegacyCutoverIntentIds(items, outbox, legacyCutoverIds) {
  const outboxById = new Map(outbox.map((entry) => [entry.intentId, entry]));
  const intentIds = new Set();
  for (const item of items) {
    if (!legacyCutoverIds.has(item.itemId) || item.activeIntentId === null) {
      continue;
    }
    const active = outboxById.get(item.activeIntentId);
    if (
      active?.status === "pending" ||
      (active?.status === "dispatching" && active.dispatchBinding === null)
    ) {
      intentIds.add(active.intentId);
    }
  }
  return intentIds;
}

function failUnstartedLegacyCutoverIntent(entry) {
  return {
    ...entry,
    status: "failed",
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: {
      status: "failed",
      details: { reason: LEGACY_PR_SOURCE_UNSTARTED_INTENT_REASON },
    },
  };
}

function shouldBlockLegacyCutoverItem(item, unstartedIntentIds) {
  return item.activeIntentId === null
    ? LEGACY_PR_SOURCE_IDLE_STATUSES.has(item.status)
    : unstartedIntentIds.has(item.activeIntentId);
}

function compareLegacySourceQuarantines(left, right) {
  if (left.workKey !== right.workKey) return left.workKey < right.workKey ? -1 : 1;
  if (left.rootItemId !== right.rootItemId) {
    return left.rootItemId < right.rootItemId ? -1 : 1;
  }
  return 0;
}

function inheritedLegacySourceQuarantine(item, quarantineByItemId) {
  const prerequisiteIds = [
    ...(typeof item.graph?.parentItemId === "string"
      ? [item.graph.parentItemId]
      : []),
    ...(item.graph?.dependsOnItemIds ?? []),
  ];
  return prerequisiteIds
    .map((itemId) => quarantineByItemId.get(itemId))
    .filter((quarantine) => quarantine !== undefined)
    .sort(compareLegacySourceQuarantines)[0] ?? null;
}

function migrateDispatchBindingState(value, limits) {
  const legacyItems = denseLedgerArrayValues(value.items);
  const outbox = denseLedgerArrayValues(value.outbox);
  if (
    legacyItems === null ||
    outbox === null ||
    legacyItems.some((item) => !hasExactLedgerKeys(item, LEGACY_ITEM_KEYS)) ||
    outbox.some((entry) => !hasExactLedgerKeys(entry, SCHEMA8_OUTBOX_KEYS))
  ) {
    throw corrupted("旧版员工工作项字段损坏");
  }
  const items = legacyItems.map((item) => ({
    ...item,
    assignment: item.kind === "graph_task"
      ? {
          ...item.assignment,
          graphTask: {
            ...item.assignment.graphTask,
            sourceBinding: item.assignment.graphTask.sourceBinding ?? null,
          },
        }
      : item.assignment,
    source: null,
    sourceQuarantine: null,
  }));
  const referencedItemIds = new Set();
  for (const item of items) {
    if (typeof item.graph?.parentItemId === "string") {
      referencedItemIds.add(item.graph.parentItemId);
    }
    for (const dependencyId of item.graph?.dependsOnItemIds ?? []) {
      referencedItemIds.add(dependencyId);
    }
  }
  const outboxItemIds = new Set(outbox.map(({ itemId }) => itemId));
  const groups = new Map();
  for (const item of items) {
    if (item.kind !== "assignment" || item.sourceSequence < 1) continue;
    let descriptor;
    try {
      descriptor = pullRequestWorkDescriptor({
        sequence: item.sourceSequence,
        assignment: item.assignment,
        event: item.event,
      });
    } catch {
      throw corrupted("旧版 PR 员工来源无法验证");
    }
    if (descriptor === null) continue;
    const group = groups.get(descriptor.workKey) ?? [];
    group.push({ item, descriptor });
    groups.set(descriptor.workKey, group);
  }

  const cancelledIds = new Set();
  const legacyCutoverIds = new Set();
  const legacyCutoverByItemId = new Map();
  const roots = [];
  for (const group of groups.values()) {
    group.sort((left, right) =>
      left.item.sourceSequence - right.item.sourceSequence,
    );
    const heads = new Set(group.map(({ descriptor }) => descriptor.headRefOid));
    const safeGroup =
      heads.size !== 1 ||
      group.some(({ item }) =>
        !safeLegacyPrSourceItem(item, referencedItemIds, outboxItemIds),
      )
        ? false
        : true;
    const seed = safeGroup ? group[0].item : group.at(-1).item;
    const root = createPullRequestSourceRootWorkItem(
      {
        sequence: seed.sourceSequence,
        assignment: seed.assignment,
        event: seed.event,
      },
      seed.createdAt,
    );
    if (safeGroup) {
      for (const { item } of group.slice(1)) {
        const appended = appendPullRequestWorkSource(root.source, {
          sequence: item.sourceSequence,
          assignment: item.assignment,
          event: item.event,
        });
        root.source = appended.source;
        root.inputDigest = root.source.current.inputDigest;
      }
    } else {
      const quarantine = {
        kind: LEGACY_PR_SOURCE_QUARANTINE_KIND,
        rootItemId: root.itemId,
        workKey: root.source.workKey,
        reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
      };
      root.status = "blocked";
      root.statusReason = LEGACY_PR_SOURCE_CUTOVER_REASON;
      root.sourceQuarantine = quarantine;
      for (const { item } of group) {
        legacyCutoverIds.add(item.itemId);
        legacyCutoverByItemId.set(item.itemId, quarantine);
      }
    }
    root.updatedAt = group.reduce(
      (latest, { item }) =>
        Date.parse(item.updatedAt) > Date.parse(latest)
          ? item.updatedAt
          : latest,
      root.updatedAt,
    );
    roots.push(root);
    for (const { item } of group) {
      if (safeGroup) {
        cancelledIds.add(item.itemId);
      }
    }
  }

  const directLegacyCutoverIds = new Set(legacyCutoverIds);
  let quarantineChanged = true;
  while (quarantineChanged) {
    quarantineChanged = false;
    for (const item of items) {
      if (directLegacyCutoverIds.has(item.itemId)) continue;
      const inherited = inheritedLegacySourceQuarantine(
        item,
        legacyCutoverByItemId,
      );
      const previous = legacyCutoverByItemId.get(item.itemId) ?? null;
      if (
        inherited !== null &&
        (previous === null ||
          compareLegacySourceQuarantines(inherited, previous) < 0)
      ) {
        legacyCutoverIds.add(item.itemId);
        legacyCutoverByItemId.set(item.itemId, inherited);
        quarantineChanged = true;
      }
    }
  }

  const unstartedIntentIds = unstartedLegacyCutoverIntentIds(
    items,
    outbox,
    legacyCutoverIds,
  );

  const migratedItems = [
    ...items.map((item) =>
      cancelledIds.has(item.itemId)
        ? {
            ...item,
            status: "cancelled",
            statusReason: "consolidated_pr_source_root",
          }
        : legacyCutoverIds.has(item.itemId)
          ? {
              ...item,
              sourceQuarantine: legacyCutoverByItemId.get(item.itemId),
              ...(shouldBlockLegacyCutoverItem(item, unstartedIntentIds)
                ? {
                    status: "blocked",
                    availableAt: null,
                    activeIntentId: null,
                  }
                : {}),
              statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
            }
        : item,
    ),
    ...roots,
  ];
  let migrated = {
    ...value,
    schemaVersion: RESULT_ATTESTATION_STATE_SCHEMA_VERSION,
    items: migratedItems,
    outbox: outbox.map((entry) => ({
      ...(unstartedIntentIds.has(entry.intentId)
        ? failUnstartedLegacyCutoverIntent(entry)
        : entry),
      sourceBinding: null,
    })),
  };
  if (roots.length > 0) {
    try {
      migrated = {
        ...migrated,
        graphMemoryProjection: reconcileMigratedWorkGraphMemoryAuthority(
          migrated.graphMemoryProjection,
          migrated,
          limits,
        ),
      };
    } catch {
      throw corrupted("无法迁移 PR 来源根的任务图记忆");
    }
  }
  return migrated;
}

function quarantineLegacyProposalBinding(entry) {
  if (
    entry.status !== "dispatching" ||
    entry.dispatchBinding === null ||
    (hasExactLedgerKeys(entry.dispatchBinding, ["status"]) &&
      entry.dispatchBinding.status === LEGACY_UNKNOWN_WORK_INTENT_BINDING)
  ) {
    return entry;
  }
  let dispatchBinding;
  try {
    dispatchBinding = normalizeWorkIntentDispatchBinding(entry.dispatchBinding);
  } catch {
    return entry;
  }
  const bound = dispatchBinding.boundIntent;
  if (
    ![
      "github_review_proposal",
      "github_pull_request_action_proposal",
      "code_action_proposal",
    ].includes(bound.kind) ||
    Object.hasOwn(bound.binding, "inputBinding")
  ) {
    return entry;
  }
  return {
    ...entry,
    dispatchBinding: { status: LEGACY_UNKNOWN_WORK_INTENT_BINDING },
  };
}

function migrateUnattestedResultTimeline(entry) {
  if (!RESULT_TIMELINE_TYPES.has(entry.type)) return entry;
  const content = {
    sequence: entry.sequence,
    itemId: entry.itemId,
    type: "legacy_result_discarded",
    at: entry.at,
    actorId: entry.actorId,
    details: {
      source: entry.type === "proposal_result_applied"
        ? "proposal"
        : "attention",
      intentId: typeof entry.details.intentId === "string"
        ? entry.details.intentId
        : null,
      resultRef: typeof entry.details.resultRef === "string"
        ? entry.details.resultRef
        : null,
      originalTimelineId: entry.timelineId,
      originalType: entry.type,
      originalContentDigest: entry.contentDigest,
      reason: "unsealed_result_attestation_migration",
    },
  };
  const contentDigest = ledgerDigest(content);
  return {
    timelineId: `work-timeline-${contentDigest}`,
    contentDigest,
    ...content,
  };
}

function migrateResultAttestationState(value, limits) {
  const timeline = denseLedgerArrayValues(value.timeline);
  if (timeline === null) throw corrupted("旧版员工工作时间线损坏");
  const normalized = timeline.map((entry) =>
    normalizeTimelineEntry(entry, value.revision, limits)
  );
  return {
    ...value,
    // Keep the historical intermediate fixed so every older state also
    // receives the schema 11 authority-policy compatibility validation.
    schemaVersion: 11,
    timeline: normalized.map(migrateUnattestedResultTimeline),
  };
}

export function normalizeWorkLedgerPersistedState(value, limitsInput) {
  const limits = normalizeWorkLedgerLimits(limitsInput);
  if (
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    value.schemaVersion === 1
  ) {
    value = {
      ...value,
      schemaVersion: 2,
      proposalCursor: 0,
      proposalHighWatermark: 0,
    };
  }
  const schema2Items =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    value.schemaVersion === 2
      ? denseLedgerArrayValues(value.items)
      : null;
  if (
    schema2Items !== null &&
    schema2Items.every((item) => {
      const legacyKeys = LEGACY_ITEM_KEYS.filter((key) => key !== "graph");
      return hasExactLedgerKeys(item, legacyKeys);
    })
  ) {
    value = {
      ...value,
      schemaVersion: 5,
      items: schema2Items.map((item) => ({
        ...item,
        graph: createDefaultWorkGraphMetadata(item.createdAt),
      })),
    };
  }
  const legacyGraphItems =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    [3, 4].includes(value.schemaVersion)
      ? denseLedgerArrayValues(value.items)
      : null;
  if (legacyGraphItems !== null) {
    value = {
      ...value,
      schemaVersion: 5,
      items: legacyGraphItems.map(migrateLegacyGraphHistory),
    };
  }
  const schema5Items =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    value.schemaVersion === 5
      ? denseLedgerArrayValues(value.items)
      : null;
  if (schema5Items !== null) {
    let graphMemoryProjection;
    try {
      graphMemoryProjection = migrateWorkGraphMemoryProjection(
        schema5Items,
        value.revision,
        limits,
      );
    } catch {
      throw corrupted("无法迁移任务图记忆投影");
    }
    value = {
      ...value,
      schemaVersion: GRAPH_MEMORY_STATE_SCHEMA_VERSION,
      graphMemoryProjection,
    };
  }
  const schema6Items =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
      "graphMemoryProjection",
    ]) && value.schemaVersion === 6
      ? denseLedgerArrayValues(value.items)
      : null;
  if (schema6Items !== null) {
    let graphMemoryProjection;
    try {
      graphMemoryProjection = migrateLegacyWorkGraphMemoryProjection(
        value.graphMemoryProjection,
        schema6Items,
      );
    } catch {
      throw corrupted("无法迁移任务图记忆完整性摘要");
    }
    value = {
      ...value,
      schemaVersion: GRAPH_MEMORY_STATE_SCHEMA_VERSION,
      graphMemoryProjection,
    };
  }
  const schema7Outbox =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
      "graphMemoryProjection",
    ]) && value.schemaVersion === GRAPH_MEMORY_STATE_SCHEMA_VERSION
      ? denseLedgerArrayValues(value.outbox)
      : null;
  if (
    schema7Outbox !== null &&
    schema7Outbox.every((entry) => hasExactLedgerKeys(entry, LEGACY_OUTBOX_KEYS))
  ) {
    value = {
      ...value,
      schemaVersion: DISPATCH_BINDING_STATE_SCHEMA_VERSION,
      outbox: schema7Outbox.map((entry) => ({
        ...entry,
        dispatchBinding: entry.status === "dispatching"
          ? { status: LEGACY_UNKNOWN_WORK_INTENT_BINDING }
          : null,
      })),
    };
  }
  if (
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
      "graphMemoryProjection",
    ]) &&
    value.schemaVersion === DISPATCH_BINDING_STATE_SCHEMA_VERSION
  ) {
    value = migrateDispatchBindingState(value, limits);
  }
  const schema9Outbox =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
      "graphMemoryProjection",
    ]) && value.schemaVersion === PR_INPUT_BINDING_STATE_SCHEMA_VERSION
      ? denseLedgerArrayValues(value.outbox)
      : null;
  if (schema9Outbox !== null) {
    if (
      schema9Outbox.some((entry) => !hasExactLedgerKeys(entry, OUTBOX_KEYS))
    ) {
      throw corrupted("旧版员工工作 outbox 字段损坏");
    }
    value = {
      ...value,
      schemaVersion: RESULT_ATTESTATION_STATE_SCHEMA_VERSION,
      outbox: schema9Outbox.map(quarantineLegacyProposalBinding),
    };
  }
  if (
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
      "graphMemoryProjection",
    ]) && value.schemaVersion === RESULT_ATTESTATION_STATE_SCHEMA_VERSION
  ) {
    value = migrateResultAttestationState(value, limits);
  }
  const hasCurrentStateFields = hasExactLedgerKeys(value, [
    "schemaVersion",
    "revision",
    "intakeCursor",
    "sourceHighWatermark",
    "attentionCursor",
    "attentionHighWatermark",
    "proposalCursor",
    "proposalHighWatermark",
    "timelineStartSequence",
    "nextTimelineSequence",
    "items",
    "timeline",
    "outbox",
    "graphMemoryProjection",
  ]);
  const itemValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.items)
    : null;
  const timelineValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.timeline)
    : null;
  const outboxValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.outbox)
    : null;
  if (
    !hasCurrentStateFields ||
    ![11, 12, WORK_LEDGER_STATE_SCHEMA_VERSION].includes(value.schemaVersion) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.intakeCursor) ||
    value.intakeCursor < 0 ||
    !Number.isSafeInteger(value.sourceHighWatermark) ||
    value.sourceHighWatermark < value.intakeCursor ||
    !Number.isSafeInteger(value.attentionCursor) ||
    value.attentionCursor < 0 ||
    !Number.isSafeInteger(value.attentionHighWatermark) ||
    value.attentionHighWatermark < value.attentionCursor ||
    !Number.isSafeInteger(value.proposalCursor) ||
    value.proposalCursor < 0 ||
    !Number.isSafeInteger(value.proposalHighWatermark) ||
    value.proposalHighWatermark < value.proposalCursor ||
    !Number.isSafeInteger(value.timelineStartSequence) ||
    value.timelineStartSequence < 1 ||
    !Number.isSafeInteger(value.nextTimelineSequence) ||
    value.nextTimelineSequence < value.timelineStartSequence ||
    itemValues === null ||
    timelineValues === null ||
    outboxValues === null ||
    itemValues.length > limits.itemLimit + limits.sourceRootLimit ||
    timelineValues.length > limits.timelineLimit ||
    outboxValues.length > limits.outboxLimit
  ) {
    throw corrupted("员工工作台账状态损坏");
  }
  let state = {
    schemaVersion: WORK_LEDGER_STATE_SCHEMA_VERSION,
    revision: value.revision,
    intakeCursor: value.intakeCursor,
    sourceHighWatermark: value.sourceHighWatermark,
    attentionCursor: value.attentionCursor,
    attentionHighWatermark: value.attentionHighWatermark,
    proposalCursor: value.proposalCursor,
    proposalHighWatermark: value.proposalHighWatermark,
    timelineStartSequence: value.timelineStartSequence,
    nextTimelineSequence: value.nextTimelineSequence,
    items: itemValues.map((item) => normalizeItem(item, value.revision, limits)),
    timeline: timelineValues.map((entry) =>
      normalizeTimelineEntry(entry, value.revision, limits),
    ),
    outbox: outboxValues.map((entry) =>
      normalizeOutboxEntry(entry, value.revision, limits),
    ),
  };
  try {
    state = {
      ...state,
      items: normalizeWorkLedgerGraphItems(state.items, state.revision),
    };
  } catch {
    throw corrupted("员工工作图结构损坏");
  }
  validateTimelineInputAuthorities(state);
  try {
    const legacyAuthorityEpochMigrated = itemValues.some(
      (item) =>
        item?.source?.kind === "pull_request" &&
        Array.isArray(item.source.revisions) &&
        item.source.revisions.some(
          (revision) =>
            !Object.hasOwn(revision, "causalHeadRefOid") ||
            !Object.hasOwn(revision, "authorityEpochChanged") ||
            !Object.hasOwn(revision, "authorityEpochCutover"),
        ),
    );
    const graphMemoryProjection = legacyAuthorityEpochMigrated
      ? reconcileMigratedWorkGraphMemoryAuthority(
          value.graphMemoryProjection,
          state,
          limits,
        )
      : value.graphMemoryProjection;
    state = {
      ...state,
      graphMemoryProjection: value.schemaVersion === 11
        ? migrateSchema11WorkGraphMemoryAuthority(graphMemoryProjection, state, limits)
        : value.schemaVersion === 12
          ? migrateSchema12WorkGraphMemoryAuthority(graphMemoryProjection, state, limits)
        : normalizeWorkGraphMemoryProjection(
            graphMemoryProjection,
            state.revision,
            state.items,
            limits,
          ),
    };
  } catch {
    throw corrupted("任务图记忆投影状态损坏");
  }
  assertGraphDeliveryHistory(state.items);
  assertUnique(state.items, "itemId", "员工工作项 ID 重复");
  assertUnique(state.items, "assignmentId", "员工分派 ID 重复");
  const prWorkKeys = state.items
    .filter(({ source }) => source?.kind === "pull_request")
    .map(({ source }) => source.workKey);
  if (new Set(prWorkKeys).size !== prWorkKeys.length) {
    throw corrupted("PR 来源工作键重复");
  }
  assertUnique(
    state.items.filter(({ kind }) => kind === "assignment"),
    "sourceSequence",
    "员工分派序号重复",
  );
  assertUnique(state.timeline, "timelineId", "员工工作时间线 ID 重复");
  assertUnique(state.outbox, "intentId", "员工工作意图 ID 重复");

  const itemIndex = new Map(state.items.map((item) => [item.itemId, item]));
  for (const item of state.items) {
    const quarantine = item.sourceQuarantine;
    if (quarantine === null) continue;
    const root = itemIndex.get(quarantine.rootItemId);
    if (
      root?.kind !== "source_root" ||
      root.source?.kind !== "pull_request" ||
      root.source.workKey !== quarantine.workKey ||
      root.sourceQuarantine?.rootItemId !== quarantine.rootItemId ||
      root.sourceQuarantine?.workKey !== quarantine.workKey
    ) {
      throw corrupted("PR 来源隔离根引用不存在或已损坏");
    }
  }
  for (const item of state.items) {
    const binding = item.kind === "graph_task"
      ? item.assignment.graphTask.sourceBinding
      : null;
    if (binding === null) continue;
    const reference = pullRequestRevisionForBinding(binding, itemIndex);
    if (
      reference === null ||
      item.graph.parentItemId === null ||
      binding.rootItemId === item.itemId
    ) {
      throw corrupted("图任务引用的 PR 来源不存在或已损坏");
    }
  }
  for (const entry of state.timeline) {
    if (entry.itemId !== null && !itemIndex.has(entry.itemId)) {
      throw corrupted("员工工作时间线引用不存在的工作项");
    }
  }
  for (const entry of state.outbox) {
    const item = itemIndex.get(entry.itemId);
    const sourceReference = pullRequestRevisionForBinding(
      entry.sourceBinding,
      itemIndex,
    );
    const itemSourceBinding = item?.kind === "graph_task"
      ? item.assignment.graphTask.sourceBinding
      : null;
    const validSourceBinding =
      entry.sourceBinding !== null &&
      sourceReference !== null &&
      ((item?.source?.kind === "pull_request" &&
        item.itemId === entry.sourceBinding.rootItemId &&
        entry.inputDigest === sourceReference.revision.inputDigest) ||
        (item?.kind === "graph_task" &&
          samePullRequestBinding(itemSourceBinding, entry.sourceBinding) &&
          entry.inputDigest === item.inputDigest));
    const validOrdinaryBinding =
      item?.source === null &&
      itemSourceBinding === null &&
      entry.sourceBinding === null &&
      item?.inputDigest === entry.inputDigest;
    if (!item || (!validSourceBinding && !validOrdinaryBinding)) {
      throw corrupted("员工工作 outbox 引用不存在或已变化的工作项");
    }
    if (entry.status === "pending" && entry.dispatchBinding !== null) {
      throw corrupted("待分发工作意图不能复用旧策略绑定");
    }
    if (
      entry.dispatchBinding !== null &&
      Object.hasOwn(entry.dispatchBinding, "boundIntent")
    ) {
      if (entry.attempt < 1) {
        throw corrupted("未领取工作意图不能包含策略绑定");
      }
      try {
        normalizeBoundWorkIntent(entry.dispatchBinding.boundIntent, {
          intentType: entry.intent.type,
          roleId: entry.requestedBy.roleId,
          workItemId: item.itemId,
          assignmentId: item.assignmentId,
          eventId: entry.sourceBinding?.eventId ??
            currentWorkItemEvent(item).eventId,
        });
      } catch {
        throw corrupted("员工工作意图策略绑定与工作项不一致");
      }
    }
  }
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activeIntentsByItem = new Map();
  for (const entry of state.outbox) {
    if (!["pending", "dispatching"].includes(entry.status)) continue;
    const item = itemIndex.get(entry.itemId);
    if (item.status !== "dispatch_pending") {
      throw corrupted("活动 outbox 与工作项状态不一致");
    }
    activeIntentsByItem.set(
      item.itemId,
      (activeIntentsByItem.get(item.itemId) || 0) + 1,
    );
  }
  if (
    state.items.some(
      (item) =>
        item.status === "dispatch_pending" &&
        activeIntentsByItem.get(item.itemId) !== 1,
    ) ||
    [...activeIntentsByItem.values()].some((count) => count !== 1)
  ) {
    throw corrupted("工作项必须恰好关联一个活动 outbox 意图");
  }
  for (const item of state.items) {
    const active = item.activeIntentId === null
      ? null
      : outboxById.get(item.activeIntentId);
    if (item.status === "dispatch_pending") {
      if (!active || !["pending", "dispatching"].includes(active.status)) {
        throw corrupted("等待分发工作项没有绑定活动意图");
      }
      continue;
    }
    if (
      new Set(["waiting_user", "waiting_condition", "waiting_external"]).has(
        item.status,
      )
    ) {
      if (item.activeIntentId === null) continue;
      if (!active || active.status !== "delivered") {
        throw corrupted("等待工作项没有绑定已交付意图");
      }
      const expectedType = item.status === "waiting_user"
        ? "ask_user"
        : item.status === "waiting_condition"
          ? "wait_condition"
          : null;
      if (expectedType && active.intent.type !== expectedType) {
        throw corrupted("等待工作项与意图类型不一致");
      }
      continue;
    }
    if (item.activeIntentId !== null) {
      throw corrupted("非等待工作项不能保留活动意图绑定");
    }
  }
  for (let index = 0; index < state.timeline.length; index += 1) {
    if (state.timeline[index].sequence !== state.timelineStartSequence + index) {
      throw corrupted("员工工作时间线序号不连续");
    }
  }
  if (
    state.nextTimelineSequence !==
    state.timelineStartSequence + state.timeline.length
  ) {
    throw corrupted("员工工作时间线检查点不一致");
  }
  try {
    assertWorkLedgerCapacity(state, limits);
  } catch {
    throw corrupted("员工工作台账超过安全容量");
  }
  return state;
}

export function workLedgerPersistedStateDigest(state) {
  return createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

export function cloneWorkLedgerState(state) {
  return cloneLedgerValue(state);
}
