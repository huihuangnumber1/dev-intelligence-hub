import {
  createWorkGraphSnapshot,
  normalizeWorkGraphAcceptanceContract,
  normalizeWorkGraphDelivery,
  validateWorkGraphTransition,
} from "../domain/work-graph-contract.js";
import {
  boundedLedgerString,
  cloneLedgerValue,
  ledgerDataEntries,
  ledgerDigest,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";
import { currentWorkItemInputBinding } from "./work-ledger-pr-source.js";
import { isRecoveredRepairEvidence } from "./work-ledger-inspection-continuation.js";
import { unstartedConflictDispatchFailure } from "./work-ledger-conflict-failure.js";
import { unstartedDeliveryContractFailure, unstartedCodePolicyBindingFailure, recordedDeliveryFailure } from "./work-ledger-delivery-failure.js";
import { indexRecordedDecisionFailures } from './work-ledger-decision-failure.js';
import { indexRecordedProposalFailures } from './work-ledger-proposal-failure.js';
import { indexParentCoordinationReturns } from './work-ledger-graph-responsibility.js';
import { currentCoordinationReturnReport } from './work-ledger-role-handoff-evidence.js';

export const WORK_LEDGER_GRAPH_ID = "work-ledger";

// Only queued work is graph-ready. Retry deadlines and recoverable blocks stay
// non-terminal so the ledger can safely requeue them later.
const GRAPH_STATUS_BY_LEDGER_STATUS = new Map([
  ["queued", "pending"],
  ["paused", "paused"],
  ["working", "in_progress"],
  ["dispatch_pending", "in_progress"],
  ["waiting_user", "in_progress"],
  ["waiting_condition", "in_progress"],
  ["waiting_external", "in_progress"],
  ["retry_wait", "in_progress"],
  ["completed", "completed"],
  ["superseded", "superseded"],
  ["blocked", "in_progress"],
  ["cancelled", "cancelled"],
]);

const DEFAULT_ACCEPTANCE_CONTRACT = Object.freeze({
  revision: 1,
  acceptanceCriteria: Object.freeze([]),
  expectedDeliverables: Object.freeze([]),
});

const ACCEPTANCE_RECORD_KEYS = [
  "revision",
  "acceptanceCriteria",
  "expectedDeliverables",
  "recordedAt",
];
const DELIVERY_RECORD_KEYS = [
  "deliverableId",
  "revision",
  "contractRevision",
  "status",
  "summary",
  "evidence",
  "recordedAt",
];

const GRAPH_METADATA_KEYS = [
  "parentItemId",
  "dependsOnItemIds",
  "acceptanceContracts",
  "deliveries",
];

function projectionError(message) {
  return workLedgerError(
    "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    message,
  );
}

function graphRecord(value, expectedKeys, label) {
  const entries = ledgerDataEntries(value);
  const keys = entries && new Set(entries.map(([key]) => key));
  if (
    !entries ||
    entries.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.has(key))
  ) {
    throw projectionError(`${label}字段无效`);
  }
  const fields = new Map(entries);
  const recordedAt = fields.get("recordedAt");
  if (
    typeof recordedAt !== "string" ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    new Date(Date.parse(recordedAt)).toISOString() !== recordedAt
  ) {
    throw projectionError(`${label}记录时间无效`);
  }
  return {
    content: Object.fromEntries(
      expectedKeys
        .filter((key) => key !== "recordedAt")
        .map((key) => [key, fields.get(key)]),
    ),
    recordedAt,
  };
}

export function createWorkGraphAcceptanceRecord(value, recordedAt) {
  return {
    ...normalizeWorkGraphAcceptanceContract(value),
    recordedAt: normalizeLedgerTimestamp(recordedAt, "contract.recordedAt"),
  };
}

export function createWorkGraphDeliveryRecord(value, recordedAt) {
  return {
    ...normalizeWorkGraphDelivery(value),
    recordedAt: normalizeLedgerTimestamp(recordedAt, "delivery.recordedAt"),
  };
}

export function createDefaultWorkGraphMetadata(recordedAt) {
  return {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [
      createWorkGraphAcceptanceRecord(DEFAULT_ACCEPTANCE_CONTRACT, recordedAt),
    ],
    deliveries: [],
  };
}

export function workLedgerStatusToGraphStatus(status) {
  const graphStatus = GRAPH_STATUS_BY_LEDGER_STATUS.get(status);
  if (graphStatus === undefined) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项状态无法投影到工作图",
    );
  }
  return graphStatus;
}

function isSatisfiedGraphTaskStatus(status) {
  return status === "completed" || status === "superseded";
}

function isSettledGraphChildStatus(status) {
  return isSatisfiedGraphTaskStatus(status) || status === "cancelled";
}

function exactGraphMetadata(fields) {
  const graphEntries = ledgerDataEntries(fields.get("graph"));
  const graphKeys = graphEntries && new Set(graphEntries.map(([key]) => key));
  if (
    !graphEntries ||
    graphEntries.length !== GRAPH_METADATA_KEYS.length ||
    GRAPH_METADATA_KEYS.some((key) => !graphKeys.has(key))
  ) {
    throw projectionError("工作项的工作图元数据字段无效");
  }
  return new Map(graphEntries);
}

function normalizeStoredGraphHistory(fields, graph) {
  const contracts = denseProjectionArray(graph.get("acceptanceContracts"))
    .map((entry) => graphRecord(entry, ACCEPTANCE_RECORD_KEYS, "验收契约"));
  const deliveries = denseProjectionArray(graph.get("deliveries"))
    .map((entry) => graphRecord(entry, DELIVERY_RECORD_KEYS, "交付"));
  const createdAt = fields.get("createdAt");
  const updatedAt = fields.get("updatedAt");
  if (
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw projectionError("工作项时间无效");
  }
  const createdTime = Date.parse(createdAt);
  const updatedTime = Date.parse(updatedAt);
  let previousContractTime = createdTime;
  for (const contract of contracts) {
    const recordedTime = Date.parse(contract.recordedAt);
    if (recordedTime < previousContractTime || recordedTime > updatedTime) {
      throw projectionError("验收契约记录时间顺序无效");
    }
    previousContractTime = recordedTime;
  }
  let previousDeliveryTime = createdTime;
  const contractByRevision = new Map(
    contracts.map((entry) => [entry.content.revision, entry]),
  );
  for (const delivery of deliveries) {
    const recordedTime = Date.parse(delivery.recordedAt);
    const contract = contractByRevision.get(delivery.content.contractRevision);
    if (
      recordedTime < previousDeliveryTime ||
      recordedTime > updatedTime ||
      !contract ||
      recordedTime < Date.parse(contract.recordedAt)
    ) {
      throw projectionError("交付记录时间顺序无效");
    }
    previousDeliveryTime = recordedTime;
  }
  for (const contract of contracts) {
    const earlierDeliveries = deliveries.filter(
      (delivery) =>
        delivery.content.contractRevision < contract.content.revision,
    );
    if (
      earlierDeliveries.some(
        (delivery) =>
          Date.parse(delivery.recordedAt) > Date.parse(contract.recordedAt),
      )
    ) {
      throw projectionError("验收契约早于已有交付记录");
    }
  }
  return { contracts, deliveries };
}

function graphTaskFromItem(item) {
  const itemEntries = ledgerDataEntries(item);
  if (!itemEntries) {
    throw projectionError("工作项不是安全的数据对象");
  }
  const fields = new Map(itemEntries);
  const graph = exactGraphMetadata(fields);
  const history = normalizeStoredGraphHistory(fields, graph);
  return {
    taskId: fields.get("itemId"),
    revision: fields.get("revision"),
    parentTaskId: graph.get("parentItemId"),
    status: workLedgerStatusToGraphStatus(fields.get("status")),
    responsibility: fields.get("currentTarget"),
    acceptanceContracts: history.contracts.map(({ content }) => content),
    deliveries: history.deliveries.map(({ content }) => content),
    dependsOn: graph.get("dependsOnItemIds"),
  };
}

function metadataFromTask(task, item) {
  const fields = new Map(ledgerDataEntries(item));
  const graph = exactGraphMetadata(fields);
  const history = normalizeStoredGraphHistory(fields, graph);
  const contractTimes = new Map(
    history.contracts.map(({ content, recordedAt }) => [
      content.revision,
      recordedAt,
    ]),
  );
  const deliveryTimes = new Map(
    history.deliveries.map(({ content, recordedAt }) => [
      content.revision,
      recordedAt,
    ]),
  );
  return cloneLedgerValue({
    parentItemId: task.parentTaskId,
    dependsOnItemIds: task.dependsOn,
    acceptanceContracts: task.acceptanceContracts.map((contract) => ({
      ...contract,
      recordedAt: contractTimes.get(contract.revision),
    })),
    deliveries: task.deliveries.map((delivery) => ({
      ...delivery,
      recordedAt: deliveryTimes.get(delivery.revision),
    })),
  });
}

function denseProjectionArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项集合必须是连续的纯数据数组",
    );
  }
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
        "工作项集合不能包含访问器",
      );
    }
    items.push(descriptor.value);
  }
  return items;
}

function freezeProjection(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) freezeProjection(child);
  return Object.freeze(value);
}

function projectedSourceRootPayload(item) {
  const source = new Map(ledgerDataEntries(item.get("source")) ?? []);
  const current = new Map(ledgerDataEntries(source.get("current")) ?? []);
  const event = new Map(ledgerDataEntries(current.get("event")) ?? []);
  const payloadEntries = ledgerDataEntries(event.get("payload"));
  if (payloadEntries === null) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "PR 来源根缺少当前工作说明",
    );
  }
  return new Map(payloadEntries);
}

function projectedItemWork(item) {
  const assignmentEntries = ledgerDataEntries(item.get("assignment"));
  const eventEntries = ledgerDataEntries(item.get("event"));
  if (!assignmentEntries || !eventEntries) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作项说明不是安全的数据对象",
    );
  }
  const assignment = new Map(assignmentEntries);
  const event = new Map(eventEntries);
  const source = item.get("kind") === "graph_task"
    ? assignment.get("work")
    : item.get("kind") === "source_root"
      ? projectedSourceRootPayload(item)
      : new Map(ledgerDataEntries(event.get("payload")) ?? []);
  const entries = source instanceof Map ? source : new Map(
    ledgerDataEntries(source) ?? [],
  );
  const title = entries.get("title");
  const description = entries.get("description");
  if (
    item.get("kind") === "graph_task" &&
    (typeof title !== "string" || typeof description !== "string")
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "图任务缺少工作说明",
    );
  }
  return {
    title: typeof title === "string" ? title : null,
    description: typeof description === "string" ? description : null,
  };
}

export function projectWorkLedgerGraphSnapshot(state, options) {
  const stateEntries = ledgerDataEntries(state);
  if (!stateEntries) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作台账不是安全的数据对象",
    );
  }
  const fields = new Map(stateEntries);
  const stateRevision = fields.get("revision");
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
      "工作台账修订无效",
    );
  }
  const items = denseProjectionArray(fields.get("items"));
  return createWorkGraphSnapshot(
    {
      graphId: WORK_LEDGER_GRAPH_ID,
      revision: stateRevision,
      tasks: items.map(graphTaskFromItem),
    },
    options,
  );
}

export function projectWorkLedgerGraphView(state, options) {
  const graph = projectWorkLedgerGraphSnapshot(state, options);
  const stateEntries = ledgerDataEntries(state);
  const fields = new Map(stateEntries);
  const latestTimelineByItem = new Map();
  const deliveryFailureIds = new Set();
  const outboxesByItemId = new Map();
  for (const outbox of fields.get("outbox") ?? []) {
    const siblings = outboxesByItemId.get(outbox.itemId) ?? [];
    siblings.push(outbox);
    outboxesByItemId.set(outbox.itemId, siblings);
  }
  const itemsById = new Map(
    denseProjectionArray(fields.get("items")).map((item) => {
      const entries = ledgerDataEntries(item);
      if (!entries) {
        throw workLedgerError(
          "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
          "工作项运行状态不是安全的数据对象",
        );
      }
      const itemFields = new Map(entries);
      if (itemFields.get("status") === "blocked" && itemFields.get("statusReason") === "delivery_attempts_exhausted") {
        deliveryFailureIds.add(itemFields.get("itemId"));
      }
      return [itemFields.get("itemId"), itemFields];
    }),
  );
  const timeline = fields.get("timeline") ?? [];
  const coordinationReturns = indexParentCoordinationReturns(state);
  const coordinationTimelineByItem = new Map(), timelineBySequence = new Map();
  if (coordinationReturns.size > 0) for (const entry of timeline) {
    // Preserve global find-first adjacency and original record identity while
    // restricting each report's history searches to its own task.
    if (!timelineBySequence.has(entry.sequence)) timelineBySequence.set(entry.sequence, entry);
    if (!coordinationReturns.has(entry.itemId)) continue;
    const history = coordinationTimelineByItem.get(entry.itemId) ?? [];
    history.push(entry);
    coordinationTimelineByItem.set(entry.itemId, history);
  }
  for (let index = timeline.length - 1; index >= 0 && latestTimelineByItem.size < deliveryFailureIds.size; index--) {
    const entry = timeline[index];
    if (deliveryFailureIds.has(entry.itemId) && !latestTimelineByItem.has(entry.itemId)) {
      latestTimelineByItem.set(entry.itemId, entry);
    }
  }
  const decisionFailures = indexRecordedDecisionFailures(state);
  const proposalFailures = indexRecordedProposalFailures(state);
  const taskStates = graph.tasks.map((task) => {
    const item = itemsById.get(task.taskId);
    if (!item || item.get("revision") !== task.revision) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
        "工作图与台账运行状态修订不一致",
      );
    }
    workLedgerStatusToGraphStatus(item.get("status"));
    let dispatchFailure = null;
    const deliveryFailure = deliveryFailureIds.has(task.taskId)
      ? recordedDeliveryFailure(Object.fromEntries(item), latestTimelineByItem.get(task.taskId)) : null;
    if (item.get("statusReason") === "intent_failed") {
      const failedItem = Object.fromEntries(item), outboxes = outboxesByItemId.get(task.taskId) ?? [];
      dispatchFailure = unstartedConflictDispatchFailure(failedItem, outboxes) ?? unstartedDeliveryContractFailure(failedItem, outboxes) ??
        unstartedCodePolicyBindingFailure(failedItem, outboxes);
    }
    const coordinationRootTaskId = coordinationReturns.get(task.taskId);
    const coordinationReturn = coordinationRootTaskId === undefined ? null : {
      kind: 'parent_coordination', rootTaskId: coordinationRootTaskId,
      handoff: currentCoordinationReturnReport(state, Object.fromEntries(item), {
        outboxes: outboxesByItemId.get(task.taskId) ?? [], timeline: coordinationTimelineByItem.get(task.taskId) ?? [], timelineBySequence,
      }),
    };
    return {
      taskId: task.taskId,
      taskRevision: task.revision,
      ledgerStatus: item.get("status"),
      ownerId: item.get("ownerId"),
      leaseUntil: item.get("leaseUntil"),
      availableAt: item.get("availableAt"),
      statusReason: item.get("statusReason"),
      ...(dispatchFailure === null ? {} : { dispatchFailure }),
      ...(deliveryFailure === null ? {} : { deliveryFailure }),
      ...(decisionFailures.has(task.taskId) ? { decisionFailure: decisionFailures.get(task.taskId) } : {}),
      ...(proposalFailures.has(task.taskId) ? { proposalFailure: proposalFailures.get(task.taskId) } : {}),
      ...(coordinationReturn === null ? {} : { coordinationReturn }),
      updatedAt: item.get("updatedAt"),
      work: projectedItemWork(item),
    };
  });
  return freezeProjection({
    schemaVersion: 1,
    graph,
    taskStates,
  });
}

function isReplacedPullRequestRootCutover(previous, next) {
  if (
    previous.kind !== "source_root" ||
    previous.source?.kind !== "pull_request" ||
    previous.status !== "superseded" ||
    previous.statusReason !== "pr_source_cross_root_cutover_replaced" ||
    next?.kind !== "source_root" ||
    next.source?.kind !== "pull_request" ||
    next.revision !== previous.revision + 1 ||
    next.ownerId !== null ||
    next.leaseId !== null ||
    next.leaseUntil !== null ||
    next.activeIntentId !== null ||
    next.availableAt !== null
  ) {
    return false;
  }
  const activated =
    next.status === "queued" &&
    ["pr_source_revised", "pr_source_cutover_activated"].includes(
      next.statusReason,
    ) &&
    next.source.pendingRevision === null &&
    next.source.activeRevision > previous.source.activeRevision;
  const deferred =
    next.status === "blocked" &&
    next.statusReason?.startsWith(
      "pr_source_cross_root_cutover_pending:",
    ) &&
    next.source.activeRevision === previous.source.activeRevision &&
    next.source.pendingRevision > previous.source.activeRevision;
  if (!activated && !deferred) return false;
  const previousSequence = previous.source.current.sourceSequence;
  const nextSequence = (next.source.pending ?? next.source.current)
    .sourceSequence;
  return Number.isSafeInteger(previousSequence) &&
    Number.isSafeInteger(nextSequence) &&
    nextSequence > previousSequence;
}

function isCompletedPullRequestRootScopeExit(previous, next) {
  const rejectedScopeRevocation =
    next?.source?.revisions?.at(-1)?.scopeRevocationApplied === true &&
    next.source.authorityEpoch === previous.source.authorityEpoch &&
    next.source.activeRevision === previous.source.activeRevision;
  const acceptedScopeRevocation =
    next?.source?.authorityEpoch > previous.source.authorityEpoch &&
    next.source.activeRevision > previous.source.activeRevision;
  return (
    previous.kind === "source_root" &&
    previous.source?.kind === "pull_request" &&
    previous.source.scope.kind === "automatic" &&
    previous.source.scope.active === true &&
    previous.status === "completed" &&
    next?.kind === "source_root" &&
    next.source?.kind === "pull_request" &&
    next.source.scope.kind === "automatic" &&
    next.source.scope.active === false &&
    next.revision === previous.revision + 1 &&
    next.status === "blocked" &&
    next.statusReason === "pr_source_left_scope" &&
    next.ownerId === null &&
    next.leaseId === null &&
    next.leaseUntil === null &&
    next.activeIntentId === null &&
    next.availableAt === null &&
    next.source.inputRevision > previous.source.inputRevision &&
    (acceptedScopeRevocation || rejectedScopeRevocation)
  );
}

function isCompletedPullRequestRootRetiredAfterAdvance(previous, next, nextItems) {
  if (
    previous.kind !== "source_root" || previous.source?.kind !== "pull_request" ||
    previous.status !== "completed" ||
    next?.kind !== "source_root" || next.source?.kind !== "pull_request" ||
    next.status !== "blocked" ||
    next.statusReason !== "pr_source_cross_root_cutover_retired" ||
    next.revision !== previous.revision + 1 ||
    next.ownerId !== null || next.leaseId !== null || next.leaseUntil !== null ||
    next.activeIntentId !== null || next.decisionContext !== null || next.availableAt !== null ||
    next.source.activeRevision <= previous.source.activeRevision ||
    next.source.current.sourceSequence <= previous.source.current.sourceSequence ||
    ledgerDigest(next.source.identity) !== ledgerDigest(previous.source.identity)
  ) return false;

  // Intake can advance a completed root, then retire it behind a later source
  // in the same transaction. Require both observations; this only revokes work.
  const identity = next.source.identity;
  for (const successor of nextItems.values()) {
    if (
      successor.kind === "source_root" && successor.source?.kind === "pull_request" &&
      successor.source.workKey !== next.source.workKey &&
      successor.source.identity.subjectId === identity.subjectId &&
      successor.source.identity.repository === identity.repository &&
      successor.source.identity.pullRequestNumber === identity.pullRequestNumber &&
      Number.isSafeInteger(successor.source.current.sourceSequence) &&
      successor.source.current.sourceSequence > next.source.current.sourceSequence
    ) return true;
  }
  return false;
}

function isCompletedInactivePullRequestRootAdvanced(previous, next) {
  // Fresh facts can advance an inactive source after its sealed action settles.
  // Retire the old completion without reopening work or changing its deliveries.
  return previous.kind === "source_root" && previous.source?.kind === "pull_request" &&
    previous.status === "completed" && previous.source.scope.kind === "automatic" &&
    previous.source.scope.active === false && next?.kind === "source_root" &&
    next.source?.kind === "pull_request" &&
    next.status === "blocked" && next.statusReason === "pr_source_left_scope" &&
    next.revision === previous.revision + 1 && next.ownerId === null &&
    next.leaseId === null && next.leaseUntil === null && next.activeIntentId === null &&
    next.decisionContext === null && next.availableAt === null &&
    next.source.pendingRevision === null &&
    next.source.activeRevision > previous.source.activeRevision &&
    next.source.authorityEpoch >= previous.source.authorityEpoch &&
    next.source.current.sourceSequence > previous.source.current.sourceSequence &&
    ledgerDigest(next.source.scope) === ledgerDigest(previous.source.scope) &&
    ledgerDigest(next.source.identity) === ledgerDigest(previous.source.identity) &&
    ledgerDigest(next.graph) === ledgerDigest(previous.graph);
}

function isCompletedPullRequestRootPendingCutover(previous, next, previousItems, nextItems) {
  const prefix = "pr_source_cross_root_cutover_pending:";
  if (
    previous.kind !== "source_root" || previous.source?.kind !== "pull_request" ||
    previous.status !== "completed" ||
    next?.kind !== "source_root" || next.source?.kind !== "pull_request" ||
    next.status !== "blocked" || !next.statusReason?.startsWith(prefix) ||
    next.revision !== previous.revision + 1 ||
    next.ownerId !== null || next.leaseId !== null || next.leaseUntil !== null ||
    next.activeIntentId !== null || next.decisionContext !== null || next.availableAt !== null ||
    next.source.activeRevision !== previous.source.activeRevision ||
    next.source.pendingRevision !== next.source.inputRevision ||
    next.source.pendingRevision <= previous.source.inputRevision ||
    ledgerDigest(next.source.current) !== ledgerDigest(previous.source.current) ||
    ledgerDigest(next.source.identity) !== ledgerDigest(previous.source.identity)
  ) return false;

  // This is a deferred provenance transfer, not permission to revive arbitrary
  // terminal work. The old active binding remains fenced until its real
  // predecessor (or one of that predecessor's children) has settled.
  const predecessorId = next.statusReason.slice(prefix.length);
  const predecessor = previousItems.get(predecessorId);
  const nextPredecessor = nextItems.get(predecessorId);
  const identity = next.source.identity;
  if (
    predecessorId === next.itemId || predecessor?.source?.kind !== "pull_request" ||
    nextPredecessor?.source?.kind !== "pull_request" ||
    predecessor.source.workKey === next.source.workKey ||
    predecessor.source.identity.subjectId !== identity.subjectId ||
    predecessor.source.identity.repository !== identity.repository ||
    predecessor.source.identity.pullRequestNumber !== identity.pullRequestNumber ||
    !Number.isSafeInteger(next.source.pending?.sourceSequence) ||
    next.source.pending.sourceSequence <= previous.source.current.sourceSequence ||
    next.source.pending.sourceSequence <=
      (predecessor.source.pending ?? predecessor.source.current).sourceSequence
  ) return false;

  const scopeExitStillAwaitingSettlement =
    nextPredecessor.statusReason === "pr_source_left_scope_pending_settlement" &&
    nextPredecessor.source.scope.active === false &&
    nextPredecessor.source.scope.revision > predecessor.source.scope.revision &&
    nextPredecessor.source.current.sourceSequence > next.source.pending.sourceSequence &&
    predecessor.activeIntentId !== null &&
    nextPredecessor.activeIntentId === predecessor.activeIntentId &&
    nextPredecessor.status === predecessor.status;
  // A later trusted scope-exit in this same batch can replace the blocker
  // marker. It must still retain the predecessor's unsettled action.
  return scopeExitStillAwaitingSettlement || [...nextItems.values()].some((item) =>
    item.statusReason === `pr_source_cross_root_cutover_blocker:${next.itemId}` &&
    (item.itemId === predecessorId ||
      currentWorkItemInputBinding(item)?.rootItemId === predecessorId)
  );
}

export function validateWorkLedgerGraphTransition(previousState, nextState) {
  const previous = projectWorkLedgerGraphSnapshot(previousState);
  const next = projectWorkLedgerGraphSnapshot(nextState);
  const previousItems = denseProjectionArray(previousState.items);
  const previousItemsById = new Map(
    previousItems.map((item) => [item.itemId, item]),
  );
  const nextItemsById = new Map(
    denseProjectionArray(nextState.items).map((item) => [item.itemId, item]),
  );
  const supersededReactivationTaskIds = previousItems
    .filter((item) =>
      isReplacedPullRequestRootCutover(item, nextItemsById.get(item.itemId))
    )
    .map(({ itemId }) => itemId);
  const terminalReactivationTaskIds = previousItems
    .filter((item) => {
      const nextItem = nextItemsById.get(item.itemId);
      return (
        item.kind === "source_root" &&
        item.source?.kind === "pull_request" &&
        item.status === "completed" &&
        nextItem?.kind === "source_root" &&
        nextItem.source?.kind === "pull_request" &&
        (
          (nextItem.status === "queued" &&
            nextItem.source.activeRevision > item.source.activeRevision) ||
          isRecoveredRepairEvidence(previousState, item, nextItem) ||
          isCompletedPullRequestRootScopeExit(item, nextItem) ||
          isCompletedInactivePullRequestRootAdvanced(item, nextItem) ||
          isCompletedPullRequestRootRetiredAfterAdvance(item, nextItem, nextItemsById) ||
          isCompletedPullRequestRootPendingCutover(
            item, nextItem, previousItemsById, nextItemsById,
          )
        )
      );
    })
    .map(({ itemId }) => itemId);
  const terminalSupersessionTaskIds = previousItems
    .filter((item) => {
      const nextItem = nextItemsById.get(item.itemId);
      const binding = currentWorkItemInputBinding(item);
      if (
        item.kind !== "graph_task" ||
        !["completed", "cancelled"].includes(item.status) ||
        nextItem?.status !== "superseded" ||
        binding === null
      ) {
        return false;
      }
      const previousRoot = previousItemsById.get(binding.rootItemId);
      const nextRoot = nextItemsById.get(binding.rootItemId);
      const previousRootBinding = currentWorkItemInputBinding(previousRoot);
      const nextRootBinding = currentWorkItemInputBinding(nextRoot);
      return (
        previousRootBinding?.headRevision === binding.headRevision &&
        previousRootBinding.headRefOid === binding.headRefOid &&
        nextRootBinding?.headRevision > binding.headRevision
      );
    })
    .map(({ itemId }) => itemId);
  validateWorkGraphTransition(previous, next, {
    supersededReactivationTaskIds,
    terminalReactivationTaskIds,
    terminalSupersessionTaskIds,
  });
  assertStoredHistoryPrefixes(previousState, nextState);
  return next;
}

function storedHistoryByItemId(state) {
  return new Map(
    denseProjectionArray(state.items).map((item) => {
      const fields = new Map(ledgerDataEntries(item));
      const history = normalizeStoredGraphHistory(
        fields,
        exactGraphMetadata(fields),
      );
      return [fields.get("itemId"), history];
    }),
  );
}

function assertHistoryPrefix(previous, next, name) {
  if (
    next.length < previous.length ||
    previous.some(
      (entry, index) =>
        JSON.stringify(entry) !== JSON.stringify(next[index]),
    )
  ) {
    throw projectionError(`${name}历史记录不能改写`);
  }
}

function assertStoredHistoryPrefixes(previousState, nextState) {
  const previousById = storedHistoryByItemId(previousState);
  const nextById = storedHistoryByItemId(nextState);
  for (const [itemId, previous] of previousById) {
    const next = nextById.get(itemId);
    if (!next) throw projectionError("工作图任务不能丢失");
    assertHistoryPrefix(previous.contracts, next.contracts, "验收契约");
    assertHistoryPrefix(previous.deliveries, next.deliveries, "交付");
  }
}

function workLedgerGraphTaskContext(state, itemId) {
  const normalizedItemId = boundedLedgerString(itemId, "itemId", 192);
  const snapshot = projectWorkLedgerGraphSnapshot(state);
  const task = snapshot.tasks.find(({ taskId }) => taskId === normalizedItemId);
  if (!task) {
    throw workLedgerError(
      "WORK_LEDGER_ITEM_NOT_FOUND",
      "工作项不存在",
      404,
    );
  }
  const byId = new Map(snapshot.tasks.map((entry) => [entry.taskId, entry]));
  const children = snapshot.tasks.filter(
    ({ parentTaskId }) => parentTaskId === normalizedItemId,
  );
  return { task, byId, children };
}

export function assertWorkLedgerGraphClaimable(state, itemId) {
  const { task, byId, children } = workLedgerGraphTaskContext(state, itemId);
  const blockedByDependency = task.dependsOn.some(
    (dependencyId) =>
      !isSatisfiedGraphTaskStatus(byId.get(dependencyId).status),
  );
  const blockedByChild = children.some(
    ({ status }) => !isSettledGraphChildStatus(status),
  );
  if (blockedByChild || blockedByDependency) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_BLOCKED",
      "工作项仍有子任务或未完成依赖，当前不可领取",
      409,
    );
  }
}

function missingRequiredDeliverables(task) {
  const currentContract = task.acceptanceContracts.at(-1);
  const latestByDeliverable = new Map();
  for (const delivery of task.deliveries) {
    if (delivery.contractRevision === currentContract.revision) {
      latestByDeliverable.set(delivery.deliverableId, delivery);
    }
  }
  return currentContract.expectedDeliverables
    .filter(({ required }) => required)
    .filter(
      ({ deliverableId }) =>
        latestByDeliverable.get(deliverableId)?.status !== "accepted",
    );
}

export function assertWorkLedgerGraphCompletable(state, itemId) {
  const { task, byId, children } = workLedgerGraphTaskContext(state, itemId);
  const hasIncompleteDependency = task.dependsOn.some(
    (dependencyId) =>
      !isSatisfiedGraphTaskStatus(byId.get(dependencyId).status),
  );
  const hasIncompleteChild = children.some(
    ({ status }) => !isSettledGraphChildStatus(status),
  );
  if (
    hasIncompleteDependency ||
    hasIncompleteChild ||
    missingRequiredDeliverables(task).length > 0
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_BLOCKED",
      "工作项仍有未完成依赖、子任务或必需交付物",
      409,
    );
  }
}

export function normalizeWorkLedgerGraphItems(items, stateRevision) {
  const safeItems = denseProjectionArray(items);
  const snapshot = projectWorkLedgerGraphSnapshot({
    revision: stateRevision,
    items: safeItems,
  });
  const tasksById = new Map(
    snapshot.tasks.map((task) => [task.taskId, task]),
  );
  return safeItems.map((item) => ({
    ...item,
    graph: metadataFromTask(tasksById.get(item.itemId), item),
  }));
}
