import { isDeepStrictEqual } from "node:util";
import {
  createWorkGraphAuthorityInvalidationEvent,
  createWorkGraphAuthorityObservationEvent,
  createLegacyWorkGraphMemoryEvent,
  createWorkGraphMemoryEvent,
  createWorkGraphSourceAuthority,
  normalizeWorkGraphMemoryEvent,
  workGraphMemorySourceRecordDigest,
  workGraphMemoryRecordReceipt,
} from "../domain/work-graph-memory-event.js";
import {
  createPullRequestExecutionBinding,
  normalizePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import {
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  pullRequestHeadAdmission,
  pullRequestHeadAdmissions,
  pullRequestHeadAdmissionForSchema11Migration,
  pullRequestHeadAdmissionForSchema12Migration,
} from "./work-ledger-pr-source.js";
import {
  cloneLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  prettySerializedLedgerBytes,
  SHA256_PATTERN,
  workLedgerError,
} from "./work-ledger-values.js";

export const MAX_WORK_GRAPH_MEMORY_EVENTS = 50_000;
export const MAX_WORK_GRAPH_MEMORY_EVENT_BYTES = 96 * 1024;
export const MAX_WORK_GRAPH_MEMORY_BATCH = 100;

const PROJECTION_KEYS = [
  "revision",
  "nextSequence",
  "cursor",
  "checkpointDigest",
  "sourceHistoryDigest",
  "authorityStateDigest",
  "lastAcknowledgement",
  "pending",
];
const PRE_AUTHORITY_PROJECTION_KEYS = PROJECTION_KEYS.filter(
  (key) => key !== "authorityStateDigest",
);
const PRE_SOURCE_HISTORY_PROJECTION_KEYS = PROJECTION_KEYS.filter(
  (key) => key !== "sourceHistoryDigest",
);
const LEGACY_PROJECTION_KEYS = PRE_AUTHORITY_PROJECTION_KEYS.filter(
  (key) => key !== "sourceHistoryDigest",
);
const ACKNOWLEDGEMENT_KEYS = [
  "sequence",
  "eventId",
  "eventDigest",
  "taskId",
  "sourceRecordDigest",
  "memoryRecordId",
  "memoryRecordDigest",
];

function projectionError(code, message, statusCode = 409) {
  return workLedgerError(code, message, statusCode);
}

function corrupted(message = "任务图记忆投影状态损坏") {
  return projectionError("WORK_LEDGER_GRAPH_MEMORY_CORRUPTED", message, 503);
}

function capacityExceeded() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED",
    "任务图记忆待投影事件达到安全容量，拒绝提交图变更",
  );
}

function orderConflict() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_ORDER_CONFLICT",
    "任务图记忆确认顺序已变化",
  );
}

function bindingConflict() {
  return projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_BINDING_CONFLICT",
    "任务图记忆确认与待投影事件不一致",
  );
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right);
}

function denseArray(value, maximum, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function safeInteger(value, minimum, error) {
  if (!Number.isSafeInteger(value) || value < minimum) throw error;
  return value;
}

function safeDigest(value, error) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw error;
  return value;
}

function safeText(value, maximumBytes, error) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw error;
  }
  return value;
}

function sourceAuthorityFor(state, item, {
  forceNonCitable = false,
  headAdmission = pullRequestHeadAdmission,
} = {}) {
  const sourceBinding = currentWorkItemInputBinding(item);
  if (sourceBinding === null) return createWorkGraphSourceAuthority();
  const event = currentWorkItemEvent(item);
  let executionBinding;
  try {
    executionBinding = createPullRequestExecutionBinding({
      sourceBinding,
      event,
    });
  } catch {
    executionBinding = normalizePullRequestExecutionBinding({
      schemaVersion: 1,
      kind: "pull_request",
      repository: event.subject.repository,
      pullRequestNumber: event.subject.number,
      ...sourceBinding,
    });
  }
  const admission = headAdmission(state, item);
  return createWorkGraphSourceAuthority({
    executionBinding,
    provenance: {
      provider: event.source.provider,
      scopeId: event.source.scopeId,
    },
    citable:
      !forceNonCitable &&
      executionBinding.schemaVersion === 2 &&
      admission.current === true &&
      admission.pending === false,
  });
}

export function workGraphMemoryAuthorityStateDigest(state) {
  return authorityStateDigestForAdmission(state, pullRequestHeadAdmission);
}

function authorityStateDigestForAdmission(state, headAdmission) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const admissions = pullRequestHeadAdmissions(state, items, {
    preserveInactiveHistory: headAdmission !== pullRequestHeadAdmissionForSchema11Migration,
    preserveInternalReview: headAdmission === pullRequestHeadAdmission,
  });
  const admissionByItem = new Map(items.map((item, index) => [item, admissions[index]]));
  return ledgerDigest(
    items.flatMap((item) => {
      const authority = sourceAuthorityFor(state, item, { headAdmission: (_state, candidate) => admissionByItem.get(candidate) });
      return authority.applies
        ? [{
            taskId: item.itemId,
            bindingDigest: authority.bindingDigest,
            citable: authority.citable,
          }]
        : [];
    }).sort((left, right) => left.taskId.localeCompare(right.taskId, "en")),
  );
}

function latestLedgerTimestamp(state, fallbackItem) {
  const candidate = state.timeline.at(-1)?.at ?? fallbackItem.updatedAt ??
    fallbackItem.createdAt;
  if (
    typeof candidate !== "string" ||
    !Number.isFinite(Date.parse(candidate)) ||
    new Date(Date.parse(candidate)).toISOString() !== candidate
  ) {
    throw corrupted("任务图记忆权威事件时间无效");
  }
  return candidate;
}

function eventForRecord({
  projection,
  state,
  item,
  kind,
  record,
  ledgerRevision,
  limits,
}) {
  if (
    projection.nextSequence >= Number.MAX_SAFE_INTEGER ||
    projection.pending.length >= limits.graphMemoryOutboxLimit
  ) {
    throw capacityExceeded();
  }
  const previousDigest = projection.pending.at(-1)?.eventDigest ??
    projection.checkpointDigest;
  const event = createWorkGraphMemoryEvent({
    sequence: projection.nextSequence,
    previousDigest,
    ledgerRevision,
    taskRevision: item.revision,
    item,
    kind,
    record,
    sourceAuthority: sourceAuthorityFor(state, item),
    authorityStateDigest: workGraphMemoryAuthorityStateDigest(state),
  });
  if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
    throw capacityExceeded();
  }
  return {
    ...projection,
    revision: ledgerRevision,
    nextSequence: projection.nextSequence + 1,
    pending: [...projection.pending, event],
  };
}

function eventForAuthorityInvalidation({
  projection,
  state,
  item,
  sourceAuthority,
  reason,
  ledgerRevision,
  limits,
}) {
  if (
    projection.nextSequence >= Number.MAX_SAFE_INTEGER ||
    projection.pending.length >= limits.graphMemoryOutboxLimit
  ) {
    throw capacityExceeded();
  }
  const previousDigest = projection.pending.at(-1)?.eventDigest ??
    projection.checkpointDigest;
  const event = createWorkGraphAuthorityInvalidationEvent({
    sequence: projection.nextSequence,
    previousDigest,
    ledgerRevision,
    taskRevision: item.revision,
    item,
    occurredAt: latestLedgerTimestamp(state, item),
    reason,
    sourceAuthority,
    authorityStateDigest: workGraphMemoryAuthorityStateDigest(state),
  });
  if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
    throw capacityExceeded();
  }
  return {
    ...projection,
    revision: ledgerRevision,
    nextSequence: projection.nextSequence + 1,
    pending: [...projection.pending, event],
  };
}

function eventForAuthorityObservation({
  projection,
  state,
  item,
  ledgerRevision,
  limits,
}) {
  if (
    projection.nextSequence >= Number.MAX_SAFE_INTEGER ||
    projection.pending.length >= limits.graphMemoryOutboxLimit
  ) {
    throw capacityExceeded();
  }
  const previousDigest = projection.pending.at(-1)?.eventDigest ??
    projection.checkpointDigest;
  const event = createWorkGraphAuthorityObservationEvent({
    sequence: projection.nextSequence,
    previousDigest,
    ledgerRevision,
    taskRevision: item.revision,
    item,
    occurredAt: latestLedgerTimestamp(state, item),
    sourceAuthority: sourceAuthorityFor(state, item),
    authorityStateDigest: workGraphMemoryAuthorityStateDigest(state),
  });
  if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
    throw capacityExceeded();
  }
  return {
    ...projection,
    revision: ledgerRevision,
    nextSequence: projection.nextSequence + 1,
    pending: [...projection.pending, event],
  };
}

export function workGraphMemorySourceHistoryDigest(items) {
  return ledgerDigest(
    items
      .flatMap((item) => recordEventsForItem(item))
      .sort(compareRecordEvents)
      .map(({ item, kind, record }) => ({
        taskId: item.itemId,
        kind,
        recordRevision: record.revision,
        sourceRecordDigest: workGraphMemorySourceRecordDigest({
          taskId: item.itemId,
          kind,
          record,
        }),
      })),
  );
}

function isSyntheticSourceRootContract(item, kind, record) {
  return (
    item.kind === "source_root" &&
    kind === "acceptance_contract" &&
    record.revision === 1 &&
    record.recordedAt === item.createdAt &&
    record.acceptanceCriteria.length === 0 &&
    record.expectedDeliverables.length === 0
  );
}

function recordEventsForItem(item, contractStart = 0, deliveryStart = 0) {
  return [
    ...item.graph.acceptanceContracts.slice(contractStart).map((record) => ({
      item,
      kind: "acceptance_contract",
      record,
    })),
    ...item.graph.deliveries.slice(deliveryStart).map((record) => ({
      item,
      kind: `delivery_${record.status}`,
      record,
    })),
  ].filter(({ kind, record }) =>
    !isSyntheticSourceRootContract(item, kind, record)
  );
}

function compareRecordEvents(left, right) {
  return left.record.recordedAt.localeCompare(right.record.recordedAt, "en") ||
    left.item.itemId.localeCompare(right.item.itemId, "en") ||
    Number(left.kind !== "acceptance_contract") -
      Number(right.kind !== "acceptance_contract") ||
    left.record.revision - right.record.revision;
}

function appendEvents(projection, state, events, ledgerRevision, limits) {
  let result = projection;
  for (const event of [...events].sort(compareRecordEvents)) {
    result = eventForRecord({
      projection: result,
      state,
      ...event,
      ledgerRevision,
      limits,
    });
  }
  return result;
}

function sourceRecordForEvent(item, event) {
  return recordEventsForItem(item).find(
    ({ kind, record }) =>
      kind === event.kind && record.revision === event.recordRevision,
  )?.record ?? null;
}

function assertEventMatchesLedger(event, itemById, stateRevision, error) {
  const item = itemById.get(event.taskId);
  const lifecycleEvent = ["authority_invalidated", "authority_observed"]
    .includes(event.kind);
  const record = item && !lifecycleEvent
    ? sourceRecordForEvent(item, event)
    : null;
  if (
    !item ||
    (!lifecycleEvent && !record) ||
    event.taskRevision > item.revision ||
    event.ledgerRevision > stateRevision
  ) {
    throw error;
  }
  if (event.schemaVersion === 2) {
    if (
      record !== null &&
      event.sourceRecordDigest !== workGraphMemorySourceRecordDigest({
        taskId: item.itemId,
        kind: event.kind,
        record,
      })
    ) {
      throw error;
    }
    const binding = event.sourceAuthority.executionBinding;
    if (binding !== null) {
      const root = itemById.get(binding.rootItemId);
      const revision = root?.source?.kind === "pull_request"
        ? root.source.revisions[binding.inputRevision - 1]
        : null;
      const migratedEpochMatches =
        revision?.authorityEpochCutover === true &&
        revision.headRevision === binding.headRevision + 1;
      if (
        root?.source?.workKey !== binding.workKey ||
        root.source.identity.repository !== binding.repository ||
        root.source.identity.pullRequestNumber !== binding.pullRequestNumber ||
        revision?.eventId !== binding.eventId ||
        revision?.eventDigest !== binding.eventDigest ||
        revision?.inputDigest !== binding.inputDigest ||
        (revision?.headRevision !== binding.headRevision &&
          !migratedEpochMatches) ||
        revision?.headRefOid !== binding.headRefOid
      ) {
        throw error;
      }
    }
    return;
  }
  let expected;
  try {
    expected = createLegacyWorkGraphMemoryEvent({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      ledgerRevision: event.ledgerRevision,
      taskRevision: event.taskRevision,
      item,
      kind: event.kind,
      record,
    });
  } catch {
    throw error;
  }
  if (!sameValue(event, expected)) throw error;
}

function normalizeAcknowledgement(value, error) {
  if (!hasExactLedgerKeys(value, ACKNOWLEDGEMENT_KEYS)) throw error;
  const memoryRecordDigest = safeDigest(value.memoryRecordDigest, error);
  const eventDigest = safeDigest(value.eventDigest, error);
  const eventId = safeText(value.eventId, 128, error);
  const memoryRecordId = safeText(value.memoryRecordId, 80, error);
  if (
    eventId !== `work-graph-memory-event-${eventDigest}` ||
    memoryRecordId !== `memory-${memoryRecordDigest}`
  ) {
    throw error;
  }
  return {
    sequence: safeInteger(value.sequence, 1, error),
    eventId,
    eventDigest,
    taskId: safeText(value.taskId, 192, error),
    sourceRecordDigest: safeDigest(value.sourceRecordDigest, error),
    memoryRecordId,
    memoryRecordDigest,
  };
}

function normalizeLastAcknowledgement(value, error) {
  if (!hasExactLedgerKeys(value, ["event", "receipt"])) throw error;
  let event;
  try {
    event = normalizeWorkGraphMemoryEvent(value.event);
  } catch {
    throw error;
  }
  const receipt = normalizeAcknowledgement(value.receipt, error);
  if (!sameValue(receipt, workGraphMemoryRecordReceipt(event))) throw error;
  return { event, receipt };
}

export function emptyWorkGraphMemoryProjection() {
  return {
    revision: 0,
    nextSequence: 1,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: ledgerDigest([]),
    authorityStateDigest: ledgerDigest([]),
    lastAcknowledgement: null,
    pending: [],
  };
}

export function migrateLegacyWorkGraphMemoryProjection(value, items) {
  if (
    !hasExactLedgerKeys(value, LEGACY_PROJECTION_KEYS) &&
    !hasExactLedgerKeys(value, PRE_AUTHORITY_PROJECTION_KEYS) &&
    !hasExactLedgerKeys(value, PRE_SOURCE_HISTORY_PROJECTION_KEYS)
  ) {
    throw corrupted();
  }
  return {
    ...cloneLedgerValue(value),
    ...(Object.hasOwn(value, "sourceHistoryDigest")
      ? {}
      : { sourceHistoryDigest: workGraphMemorySourceHistoryDigest(items) }),
    ...(Object.hasOwn(value, "authorityStateDigest")
      ? { authorityStateDigest: value.authorityStateDigest }
      : {}),
  };
}

export function migrateWorkGraphMemoryProjection(items, ledgerRevision, limits) {
  const events = items
    .flatMap((item) => recordEventsForItem(item))
    .sort(compareRecordEvents);
  if (events.length > limits.graphMemoryOutboxLimit) throw capacityExceeded();
  const pending = [];
  let nextSequence = 1;
  let previousDigest = null;
  for (const descriptor of events) {
    if (nextSequence >= Number.MAX_SAFE_INTEGER) throw capacityExceeded();
    const event = createWorkGraphMemoryEvent({
      sequence: nextSequence,
      previousDigest,
      ledgerRevision,
      taskRevision: descriptor.item.revision,
      item: descriptor.item,
      kind: descriptor.kind,
      record: descriptor.record,
      sourceAuthority: sourceAuthorityFor(
        { items, timeline: [] },
        descriptor.item,
        { forceNonCitable: currentWorkItemInputBinding(descriptor.item) !== null },
      ),
      authorityStateDigest: workGraphMemoryAuthorityStateDigest({ items }),
    });
    if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
      throw capacityExceeded();
    }
    pending.push(event);
    nextSequence += 1;
    previousDigest = event.eventDigest;
  }
  return {
    revision: events.length > 0 ? ledgerRevision : 0,
    nextSequence,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: workGraphMemorySourceHistoryDigest(items),
    authorityStateDigest: workGraphMemoryAuthorityStateDigest({ items }),
    lastAcknowledgement: null,
    pending,
  };
}

function batchedSourceAuthorityReader(state) {
  const admissions = pullRequestHeadAdmissions(state, state.items);
  const admissionByItem = new Map(state.items.map((item, index) => [item, admissions[index]]));
  return item => sourceAuthorityFor(state, item, {
    headAdmission: (_state, candidate) => admissionByItem.get(candidate),
  });
}

function authorityInvalidations(previousState, candidateState) {
  const previousAuthorityFor = batchedSourceAuthorityReader(previousState);
  const candidateAuthorityFor = batchedSourceAuthorityReader(candidateState);
  const candidateById = new Map(
    candidateState.items.map((item) => [item.itemId, item]),
  );
  const result = [];
  for (const item of previousState.items) {
    const previousAuthority = previousAuthorityFor(item);
    if (!previousAuthority.applies) continue;
    const candidate = candidateById.get(item.itemId);
    const nextAuthority = candidate === undefined
      ? null
      : candidateAuthorityFor(candidate);
    const bindingChanged =
      nextAuthority === null ||
      nextAuthority.bindingDigest !== previousAuthority.bindingDigest;
    const becameNonCitable =
      previousAuthority.citable && nextAuthority?.citable !== true;
    if (!bindingChanged && !becameNonCitable) continue;
    result.push({
      item,
      sourceAuthority: previousAuthority,
      reason: bindingChanged
        ? "pr_source_binding_changed"
        : "pr_source_authority_pending_or_fenced",
    });
  }
  return result;
}

export function appendWorkGraphMemoryEvents(
  previousState,
  candidateState,
  limits,
) {
  if (
    !sameValue(
      candidateState.graphMemoryProjection,
      previousState.graphMemoryProjection,
    )
  ) {
    throw projectionError(
      "WORK_LEDGER_GRAPH_MEMORY_TRANSITION_INVALID",
      "业务命令不能直接修改任务图记忆投影状态",
    );
  }
  const previousById = new Map(
    previousState.items.map((item) => [item.itemId, item]),
  );
  const additions = [];
  for (const item of candidateState.items) {
    const previous = previousById.get(item.itemId);
    const contractStart = previous?.graph.acceptanceContracts.length ?? 0;
    const deliveryStart = previous?.graph.deliveries.length ?? 0;
    if (
      item.graph.acceptanceContracts.length < contractStart ||
      item.graph.deliveries.length < deliveryStart
    ) {
      throw projectionError(
        "WORK_LEDGER_GRAPH_MEMORY_TRANSITION_INVALID",
        "任务图历史不能在记忆投影前被删除",
      );
    }
    additions.push(...recordEventsForItem(item, contractStart, deliveryStart));
  }
  let graphMemoryProjection = appendEvents(
    previousState.graphMemoryProjection,
    candidateState,
    additions,
    candidateState.revision,
    limits,
  );
  const invalidations = authorityInvalidations(previousState, candidateState);
  for (const invalidation of invalidations) {
    graphMemoryProjection = eventForAuthorityInvalidation({
      projection: graphMemoryProjection,
      state: candidateState,
      ...invalidation,
      ledgerRevision: candidateState.revision,
      limits,
    });
  }
  const authorityStateDigest = workGraphMemoryAuthorityStateDigest(
    candidateState,
  );
  if (
    authorityStateDigest !==
      previousState.graphMemoryProjection.authorityStateDigest &&
    graphMemoryProjection.pending.at(-1)?.authorityStateDigest !==
      authorityStateDigest
  ) {
    const authorityItem = candidateState.items.findLast(
      (item) => sourceAuthorityFor(candidateState, item).applies,
    );
    if (authorityItem === undefined) {
      throw projectionError(
        "WORK_LEDGER_GRAPH_MEMORY_TRANSITION_INVALID",
        "PR 权威状态变化缺少可封存来源",
      );
    }
    graphMemoryProjection = eventForAuthorityObservation({
      projection: graphMemoryProjection,
      state: candidateState,
      item: authorityItem,
      ledgerRevision: candidateState.revision,
      limits,
    });
  }
  graphMemoryProjection = {
    ...graphMemoryProjection,
    authorityStateDigest,
  };
  if (additions.length > 0) {
    graphMemoryProjection = {
      ...graphMemoryProjection,
      sourceHistoryDigest: workGraphMemorySourceHistoryDigest(
        candidateState.items,
      ),
    };
  }
  return {
    ...candidateState,
    graphMemoryProjection,
  };
}

export function reconcileMigratedWorkGraphMemoryAuthority(
  projection,
  state,
  limits,
) {
  const authorityStateDigest = workGraphMemoryAuthorityStateDigest(state);
  if (projection.authorityStateDigest === authorityStateDigest) {
    return cloneLedgerValue(projection);
  }
  const itemById = new Map(state.items.map((item) => [item.itemId, item]));
  const currentAuthorityByTask = new Map(
    state.items.flatMap((item) => {
      const authority = sourceAuthorityFor(state, item);
      return authority.applies ? [[item.itemId, authority]] : [];
    }),
  );
  const observedAuthorities = new Map();
  const historicalEvents = [
    ...(projection.lastAcknowledgement === null
      ? []
      : [projection.lastAcknowledgement.event]),
    ...projection.pending,
  ];
  for (const event of historicalEvents) {
    if (
      event.schemaVersion !== 2 ||
      event.sourceAuthority?.applies !== true ||
      event.sourceAuthority.citable !== true
    ) {
      continue;
    }
    const current = currentAuthorityByTask.get(event.taskId);
    if (current?.bindingDigest !== event.sourceAuthority.bindingDigest) {
      const previous = observedAuthorities.get(event.taskId);
      if (
        previous !== undefined &&
        previous.authority.bindingDigest !== event.sourceAuthority.bindingDigest
      ) {
        throw corrupted("单个 PR 工作项存在多个未失效的旧来源绑定");
      }
      observedAuthorities.set(event.taskId, {
        item: itemById.get(event.taskId),
        authority: event.sourceAuthority,
      });
    }
  }
  const migrationAllowance = Math.max(1, currentAuthorityByTask.size);
  const migrationLimits = {
    ...limits,
    graphMemoryOutboxLimit: Math.min(
      MAX_WORK_GRAPH_MEMORY_EVENTS,
      limits.graphMemoryOutboxLimit + migrationAllowance,
    ),
  };
  let result = cloneLedgerValue(projection);
  for (const { item, authority } of observedAuthorities.values()) {
    if (item === undefined) throw corrupted("PR 记忆迁移缺少来源工作项");
    result = eventForAuthorityInvalidation({
      projection: result,
      state,
      item,
      sourceAuthority: authority,
      reason: "legacy_pr_authority_epoch_cutover",
      ledgerRevision: state.revision,
      limits: migrationLimits,
    });
  }
  if (
    result.pending.at(-1)?.authorityStateDigest !== authorityStateDigest
  ) {
    const authorityItem = state.items.findLast(
      (item) => sourceAuthorityFor(state, item).applies,
    );
    if (authorityItem === undefined) {
      throw corrupted("PR 记忆迁移缺少权威基线");
    }
    result = eventForAuthorityObservation({
      projection: result,
      state,
      item: authorityItem,
      ledgerRevision: state.revision,
      limits: migrationLimits,
    });
  }
  return {
    ...result,
    authorityStateDigest,
  };
}

function normalizeProjection(
  suppliedValue,
  stateRevision,
  items,
  limits,
  headAdmission,
) {
  const error = corrupted();
  const expectedAuthorityStateDigest = authorityStateDigestForAdmission({ items }, headAdmission);
  const migratingAuthority = hasExactLedgerKeys(
    suppliedValue,
    PRE_AUTHORITY_PROJECTION_KEYS,
  );
  let value = migratingAuthority
    ? {
        ...cloneLedgerValue(suppliedValue),
        authorityStateDigest: expectedAuthorityStateDigest,
      }
    : suppliedValue;
  const prAuthorityItem = items.find(
    (item) => currentWorkItemInputBinding(item) !== null,
  );
  if (migratingAuthority && prAuthorityItem !== undefined) {
    const migrationAllowance = Math.max(
      1,
      items.filter((item) => currentWorkItemInputBinding(item) !== null).length,
    );
    value = eventForAuthorityObservation({
      projection: value,
      state: { items, timeline: [] },
      item: prAuthorityItem,
      ledgerRevision: stateRevision,
      limits: {
        ...limits,
        graphMemoryOutboxLimit: Math.min(
          MAX_WORK_GRAPH_MEMORY_EVENTS,
          limits.graphMemoryOutboxLimit + migrationAllowance,
        ),
      },
    });
    value = {
      ...value,
      authorityStateDigest: expectedAuthorityStateDigest,
    };
  }
  if (!hasExactLedgerKeys(value, PROJECTION_KEYS)) throw error;
  const revision = safeInteger(value.revision, 0, error);
  const nextSequence = safeInteger(value.nextSequence, 1, error);
  const cursor = safeInteger(value.cursor, 0, error);
  const checkpointDigest = value.checkpointDigest === null
    ? null
    : safeDigest(value.checkpointDigest, error);
  const sourceHistoryDigest = safeDigest(value.sourceHistoryDigest, error);
  const authorityStateDigest = safeDigest(value.authorityStateDigest, error);
  const lastAcknowledgement = value.lastAcknowledgement === null
    ? null
    : normalizeLastAcknowledgement(value.lastAcknowledgement, error);
  const pending = denseArray(
    value.pending,
    MAX_WORK_GRAPH_MEMORY_EVENTS,
    error,
  ).map((entry) => {
    let event;
    try {
      event = normalizeWorkGraphMemoryEvent(entry);
    } catch {
      throw error;
    }
    if (prettySerializedLedgerBytes(event) > limits.graphMemoryEventByteBudget) {
      throw error;
    }
    return event;
  });
  if (
    revision > stateRevision ||
    cursor > Number.MAX_SAFE_INTEGER - pending.length - 1 ||
    nextSequence !== cursor + pending.length + 1 ||
    (nextSequence === 1) !== (revision === 0) ||
    (cursor === 0) !== (checkpointDigest === null) ||
    (cursor === 0) !== (lastAcknowledgement === null) ||
    sourceHistoryDigest !== workGraphMemorySourceHistoryDigest(items) ||
    authorityStateDigest !== expectedAuthorityStateDigest ||
    (lastAcknowledgement !== null &&
      (lastAcknowledgement.event.sequence !== cursor ||
        lastAcknowledgement.event.eventDigest !== checkpointDigest))
  ) {
    throw error;
  }
  if (
    pending.length > limits.graphMemoryOutboxLimit &&
    pending.slice(limits.graphMemoryOutboxLimit).some(
      (event) =>
        event.schemaVersion !== 2 ||
        !["authority_invalidated", "authority_observed"].includes(event.kind),
    )
  ) {
    throw error;
  }
  let previousDigest = checkpointDigest;
  for (let index = 0; index < pending.length; index += 1) {
    const event = pending[index];
    if (
      event.sequence !== cursor + index + 1 ||
      event.previousDigest !== previousDigest
    ) {
      throw error;
    }
    previousDigest = event.eventDigest;
  }
  const highWatermarkEvent = pending.at(-1) ?? lastAcknowledgement?.event ?? null;
  if (
    highWatermarkEvent?.schemaVersion === 2 &&
    highWatermarkEvent.authorityStateDigest !== authorityStateDigest
  ) {
    throw error;
  }
  if (
    prAuthorityItem !== undefined &&
    highWatermarkEvent?.schemaVersion !== 2
  ) {
    throw error;
  }
  const itemById = new Map(items.map((item) => [item.itemId, item]));
  const migrationAllowance = Math.max(
    1,
    items.filter((item) => currentWorkItemInputBinding(item) !== null).length,
  );
  const policyObservationAllowance = headAdmission === pullRequestHeadAdmission &&
    pending.at(-1)?.kind === "authority_observed" ? 1 : 0;
  if (
    pending.length > limits.graphMemoryOutboxLimit + migrationAllowance + policyObservationAllowance
  ) {
    throw error;
  }
  if (lastAcknowledgement !== null) {
    assertEventMatchesLedger(
      lastAcknowledgement.event,
      itemById,
      stateRevision,
      error,
    );
  }
  for (const event of pending) {
    assertEventMatchesLedger(event, itemById, stateRevision, error);
  }
  return {
    revision,
    nextSequence,
    cursor,
    checkpointDigest,
    sourceHistoryDigest,
    authorityStateDigest,
    lastAcknowledgement,
    pending,
  };
}

export function normalizeWorkGraphMemoryProjection(value, stateRevision, items, limits) {
  return normalizeProjection(value, stateRevision, items, limits, pullRequestHeadAdmission);
}

export function migrateSchema11WorkGraphMemoryAuthority(value, state, limits) {
  return migratePreviousWorkGraphMemoryAuthority(value, state, limits, pullRequestHeadAdmissionForSchema11Migration);
}

export function migrateSchema12WorkGraphMemoryAuthority(value, state, limits) {
  return migratePreviousWorkGraphMemoryAuthority(value, state, limits, pullRequestHeadAdmissionForSchema12Migration);
}

function migratePreviousWorkGraphMemoryAuthority(value, state, limits, previousAdmission) {
  try {
    return normalizeWorkGraphMemoryProjection(value, state.revision, state.items, limits);
  } catch {
    // A policy change is eligible only after every old projection invariant,
    // including its sealed high watermark and event chain, has been verified.
    const previous = normalizeProjection(value, state.revision, state.items, limits,
      previousAdmission);
    return normalizeWorkGraphMemoryProjection(
      reconcileMigratedWorkGraphMemoryAuthority(previous, state, {
        ...limits,
        // A previous authority-migration tail can already occupy its complete
        // allowance. Reserve one additional sealed policy-baseline observation.
        graphMemoryOutboxLimit: Math.min(MAX_WORK_GRAPH_MEMORY_EVENTS,
          limits.graphMemoryOutboxLimit + 1),
      }),
      state.revision, state.items, limits,
    );
  }
}

export function normalizeWorkGraphMemoryBatchOptions(value = {}) {
  const error = new TypeError("task graph memory batch options are invalid");
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactLedgerKeys(value, Object.hasOwn(value, "limit") ? ["limit"] : [])
  ) {
    throw error;
  }
  const limit = Object.hasOwn(value, "limit") ? value.limit : 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_WORK_GRAPH_MEMORY_BATCH
  ) {
    throw error;
  }
  return { limit };
}

export function readWorkGraphMemoryProjectionBatch(projection, value = {}) {
  const { limit } = normalizeWorkGraphMemoryBatchOptions(value);
  return cloneLedgerValue({
    cursor: projection.cursor,
    highWatermark: projection.nextSequence - 1,
    checkpointDigest: projection.checkpointDigest,
    highWatermarkDigest:
      projection.pending.at(-1)?.eventDigest ?? projection.checkpointDigest,
    authorityStateDigest: projection.authorityStateDigest,
    items: projection.pending.slice(0, limit),
  });
}

export function acknowledgeWorkGraphMemoryProjection(
  projection,
  value,
  stateRevision,
) {
  return acknowledgeWorkGraphMemoryProjectionBatch(
    projection,
    { receipts: [value] },
    stateRevision,
  );
}

export function acknowledgeWorkGraphMemoryProjectionBatch(
  projection,
  value,
  stateRevision,
) {
  const error = projectionError(
    "WORK_LEDGER_GRAPH_MEMORY_ACK_INVALID",
    "任务图记忆确认格式无效",
    400,
  );
  if (!hasExactLedgerKeys(value, ["receipts"])) throw error;
  const requests = denseArray(
    value.receipts,
    MAX_WORK_GRAPH_MEMORY_BATCH,
    error,
  ).map((receipt) => normalizeAcknowledgement(receipt, error));
  if (requests.length === 0) throw error;
  const first = requests[0];
  if (first.sequence <= projection.cursor) {
    if (
      requests.length === 1 &&
      first.sequence === projection.cursor &&
      projection.lastAcknowledgement !== null &&
      sameValue(first, projection.lastAcknowledgement.receipt)
    ) {
      return {
        write: false,
        projection,
        result: {
          status: "already",
          cursor: projection.cursor,
          highWatermark: projection.nextSequence - 1,
        },
      };
    }
    throw orderConflict();
  }
  if (
    first.sequence !== projection.cursor + 1 ||
    requests.length > projection.pending.length
  ) {
    throw orderConflict();
  }
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const event = projection.pending[index];
    if (request.sequence !== projection.cursor + index + 1) {
      throw orderConflict();
    }
    if (!sameValue(request, workGraphMemoryRecordReceipt(event))) {
      throw bindingConflict();
    }
  }
  const lastIndex = requests.length - 1;
  const request = requests[lastIndex];
  const event = projection.pending[lastIndex];
  const nextProjection = {
    ...projection,
    revision: stateRevision,
    cursor: request.sequence,
    checkpointDigest: event.eventDigest,
    lastAcknowledgement: { event, receipt: request },
    pending: projection.pending.slice(requests.length),
  };
  return {
    write: true,
    projection: nextProjection,
    result: {
      status: "applied",
      cursor: nextProjection.cursor,
      highWatermark: nextProjection.nextSequence - 1,
    },
  };
}
