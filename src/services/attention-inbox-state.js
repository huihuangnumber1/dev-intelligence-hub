import { maintenanceAttentionCode } from "../domain/maintenance-attention.js";
import {
  assertAttentionExactKeys,
  attentionArrayValues,
  attentionDataEntries,
  attentionDigest,
  attentionError,
  boundedAttentionText,
  cloneAttentionValue,
  normalizeAttentionAnswer,
  normalizeAttentionDigest,
  normalizeAttentionId,
  normalizeAttentionRequest,
  normalizeAttentionTimestamp,
  safeAttentionInteger,
} from "../domain/attention-contract.js";

export const ATTENTION_INBOX_STATE_KEY = "attention-inbox";
const MAX_ITEMS = 1_000;
const MAX_OUTBOX_ITEMS = 1_000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const EVENT_ID = /^attention-event-[a-f0-9]{64}$/;
const RESULT_ID = /^attention-result-[a-f0-9]{64}$/;
const OUTBOX_ID = /^attention-outbox-[a-f0-9]{64}$/;
const ITEM_STATUSES = new Set(["pending", "answered", "rejected", "archived"]);
const EVENT_TYPES = new Set(["created", "answered", "rejected", "archived"]);
const RETIRED_WORK_STATUSES = new Set(["cancelled", "completed", "superseded"]);

function stateError(message = "内部请示队列持久化状态损坏", cause) {
  return attentionError(
    "ATTENTION_STATE_CORRUPTED",
    message,
    500,
    cause === undefined ? undefined : { cause },
  );
}

function invalidState(message = "内部请示状态无效") {
  return attentionError("ATTENTION_STATE_INVALID", message, 500);
}

function safeStateInteger(value, name, minimum = 0) {
  return safeAttentionInteger(value, name, {
    minimum,
    error: invalidState(),
  });
}

function safeInternalId(value, name, pattern) {
  return boundedAttentionText(value, name, {
    maximumBytes: 96,
    pattern,
    error: invalidState(),
  });
}

function normalizeStateTimestamp(value) {
  if (typeof value !== "string") throw invalidState();
  return normalizeAttentionTimestamp(value, invalidState());
}

function normalizeProducerBinding(value) {
  const normalized = normalizeAttentionRequest({
    requestKey: "binding-check",
    type: "ask_user",
    producer: value,
    question: "binding-check",
  });
  return normalized.producer;
}

function eventCore({ type, requestId, revision, at, contentDigest }) {
  return { type, requestId, revision, at, contentDigest };
}

function createTimelineEvent({ type, requestId, revision, at, contentDigest }) {
  const core = eventCore({ type, requestId, revision, at, contentDigest });
  const eventDigest = attentionDigest(core);
  return {
    eventId: `attention-event-${eventDigest}`,
    eventDigest,
    ...core,
  };
}

function normalizeTimelineEvent(value) {
  assertAttentionExactKeys(
    value,
    ["eventId", "eventDigest", "type", "requestId", "revision", "at", "contentDigest"],
    invalidState(),
  );
  if (!EVENT_TYPES.has(value.type)) throw invalidState();
  const event = createTimelineEvent({
    type: value.type,
    requestId: normalizeAttentionId(value.requestId),
    revision: safeStateInteger(value.revision, "event.revision", 1),
    at: normalizeStateTimestamp(value.at),
    contentDigest: normalizeAttentionDigest(value.contentDigest),
  });
  if (value.eventId !== event.eventId || value.eventDigest !== event.eventDigest) {
    throw invalidState("内部请示时间线摘要不一致");
  }
  return event;
}

function resultCore({
  requestId,
  requestContentDigest,
  producerBindingDigest,
  kind,
  answer,
  requestRevision,
  revision,
  at,
}) {
  return {
    requestId,
    requestContentDigest,
    producerBindingDigest,
    kind,
    answer,
    requestRevision,
    revision,
    at,
  };
}

export function createAttentionResult(item, answer, revision, at) {
  const kind = answer.type === "reject" ? "rejected" : "answered";
  const core = resultCore({
    requestId: item.requestId,
    requestContentDigest: item.contentDigest,
    producerBindingDigest: item.producerBindingDigest,
    kind,
    answer: cloneAttentionValue(answer),
    requestRevision: item.timeline[0].revision,
    revision,
    at,
  });
  const contentDigest = attentionDigest(core);
  return {
    resultId: `attention-result-${contentDigest}`,
    contentDigest,
    ...core,
  };
}

function normalizeResult(value) {
  assertAttentionExactKeys(
    value,
    [
      "resultId",
      "contentDigest",
      "requestId",
      "requestContentDigest",
      "producerBindingDigest",
      "kind",
      "answer",
      "requestRevision",
      "revision",
      "at",
    ],
    invalidState(),
  );
  const answer = normalizeAttentionAnswer(value.answer);
  if (
    !new Set(["answered", "rejected"]).has(value.kind) ||
    (value.kind === "rejected") !== (answer.type === "reject") ||
    answer.type === "later"
  ) {
    throw invalidState();
  }
  const core = resultCore({
    requestId: normalizeAttentionId(value.requestId),
    requestContentDigest: normalizeAttentionDigest(value.requestContentDigest),
    producerBindingDigest: normalizeAttentionDigest(value.producerBindingDigest),
    kind: value.kind,
    answer,
    requestRevision: safeStateInteger(value.requestRevision, "result.requestRevision", 1),
    revision: safeStateInteger(value.revision, "result.revision", 1),
    at: normalizeStateTimestamp(value.at),
  });
  const contentDigest = attentionDigest(core);
  if (
    value.contentDigest !== contentDigest ||
    value.resultId !== `attention-result-${contentDigest}`
  ) {
    throw invalidState("内部请示结果摘要不一致");
  }
  safeInternalId(value.resultId, "result.resultId", RESULT_ID);
  return { resultId: value.resultId, contentDigest, ...core };
}

function requestFromItem(value) {
  return normalizeAttentionRequest({
    requestKey: value.requestKey,
    type: value.type,
    producer: value.producer,
    question: value.question,
    context: value.context,
    choices: value.choices,
    ...(Object.hasOwn(value, "recoveryCode") ? { recoveryCode: value.recoveryCode } : {}),
  });
}

function normalizeRetirement(value) {
  assertAttentionExactKeys(value, ["status", "workItemRevision", "reason"], invalidState());
  if (!RETIRED_WORK_STATUSES.has(value.status) &&
      !(value.status === "retry_wait" && ["system_maintenance_auto_retry", "host_context_facts_recovered", "ci_materials_recovered"].includes(value.reason)) &&
      !(value.status === "queued" && ["ci_materials_recovered", "host_context_facts_recovered"].includes(value.reason))) throw invalidState();
  return {
    status: value.status,
    workItemRevision: safeStateInteger(value.workItemRevision, "archive.workItemRevision", 1),
    reason: boundedAttentionText(value.reason, "archive.reason", {
      maximumBytes: 512, error: invalidState(),
    }),
  };
}

function archiveDigest(item, retirement) {
  return attentionDigest({
    requestId: item.requestId,
    requestContentDigest: item.contentDigest,
    retirement,
  });
}

export function createAttentionItem(request, revision, at) {
  const contentDigest = attentionDigest(request);
  const requestId = `attention-${contentDigest}`;
  const producerBindingDigest = attentionDigest({
    requestKey: request.requestKey,
    producer: request.producer,
  });
  return {
    requestId,
    contentDigest,
    producerBindingDigest,
    ...cloneAttentionValue(request),
    status: "pending",
    revision,
    createdAt: at,
    updatedAt: at,
    result: null,
    archive: null,
    timeline: [
      createTimelineEvent({
        type: "created",
        requestId,
        revision,
        at,
        contentDigest,
      }),
    ],
  };
}

function normalizeItem(value, { legacy = false } = {}) {
  assertAttentionExactKeys(
    value,
    [
      "requestId",
      "contentDigest",
      "producerBindingDigest",
      "requestKey",
      "type",
      "producer",
      "question",
      "context",
      "choices",
      "status",
      "revision",
      "createdAt",
      "updatedAt",
      "result",
      "timeline",
      ...(legacy ? [] : ["archive"]),
      ...(Object.hasOwn(value, "recoveryCode") ? ["recoveryCode"] : []),
    ],
    invalidState(),
  );
  if (!ITEM_STATUSES.has(value.status)) throw invalidState();
  const request = requestFromItem(value);
  const contentDigest = attentionDigest(request);
  const requestId = `attention-${contentDigest}`;
  const producerBindingDigest = attentionDigest({
    requestKey: request.requestKey,
    producer: request.producer,
  });
  if (
    value.requestId !== requestId ||
    value.contentDigest !== contentDigest ||
    value.producerBindingDigest !== producerBindingDigest
  ) {
    throw invalidState("内部请示请求绑定摘要不一致");
  }
  const timeline = attentionArrayValues(value.timeline, 2, invalidState()).map(
    normalizeTimelineEvent,
  );
  const result = value.result === null ? null : normalizeResult(value.result);
  const archive = legacy || value.archive === null ? null : normalizeRetirement(value.archive);
  const item = {
    requestId,
    contentDigest,
    producerBindingDigest,
    ...request,
    status: value.status,
    revision: safeStateInteger(value.revision, "item.revision", 1),
    createdAt: normalizeStateTimestamp(value.createdAt),
    updatedAt: normalizeStateTimestamp(value.updatedAt),
    result,
    archive,
    timeline,
  };
  const created = timeline[0];
  const terminal = timeline[1];
  if (
    !created ||
    created.type !== "created" ||
    created.requestId !== requestId ||
    created.contentDigest !== contentDigest ||
    created.at !== item.createdAt ||
    item.revision !== timeline.at(-1)?.revision ||
    item.updatedAt !== timeline.at(-1)?.at ||
    Date.parse(item.createdAt) > Date.parse(item.updatedAt)
  ) {
    throw invalidState("内部请示时间线与请求不一致");
  }
  if (
    timeline.some(
      (event, index) =>
        index > 0 && event.revision <= timeline[index - 1].revision,
    )
  ) {
    throw invalidState("内部请示时间线版本必须严格递增");
  }
  if (item.status === "pending") {
    if (timeline.length !== 1 || result !== null || archive !== null) throw invalidState();
  } else if (item.status === "archived") {
    if (
      timeline.length !== 2 || result !== null || archive === null ||
      terminal.type !== "archived" || terminal.requestId !== requestId ||
      terminal.contentDigest !== archiveDigest(item, archive)
    ) throw invalidState("内部请示归档与时间线不一致");
  } else if (
    timeline.length !== 2 ||
    archive !== null ||
    result === null ||
    terminal.type !== item.status ||
    terminal.requestId !== requestId ||
    terminal.contentDigest !== result.contentDigest ||
    terminal.revision !== result.revision ||
    terminal.at !== result.at ||
    result.kind !== item.status ||
    result.requestId !== requestId ||
    result.requestContentDigest !== contentDigest ||
    result.producerBindingDigest !== producerBindingDigest ||
    result.requestRevision !== created.revision ||
    result.revision !== item.revision ||
    result.requestRevision >= result.revision
  ) {
    throw invalidState("内部请示结果与时间线不一致");
  }
  return item;
}

function outboxCore({
  sequence,
  requestId,
  requestContentDigest,
  producer,
  producerBindingDigest,
  requestKey,
  result,
}) {
  return {
    sequence,
    requestId,
    requestContentDigest,
    producer,
    producerBindingDigest,
    requestKey,
    result,
  };
}

export function createAttentionOutboxEntry(item, sequence) {
  const core = outboxCore({
    sequence,
    requestId: item.requestId,
    requestContentDigest: item.contentDigest,
    producer: cloneAttentionValue(item.producer),
    producerBindingDigest: item.producerBindingDigest,
    requestKey: item.requestKey,
    result: cloneAttentionValue(item.result),
  });
  const contentDigest = attentionDigest(core);
  return {
    outboxId: `attention-outbox-${contentDigest}`,
    contentDigest,
    ...core,
  };
}

function normalizeOutboxEntry(value) {
  assertAttentionExactKeys(
    value,
    [
      "outboxId",
      "contentDigest",
      "sequence",
      "requestId",
      "requestContentDigest",
      "producer",
      "producerBindingDigest",
      "requestKey",
      "result",
    ],
    invalidState(),
  );
  const core = outboxCore({
    sequence: safeStateInteger(value.sequence, "outbox.sequence", 1),
    requestId: normalizeAttentionId(value.requestId),
    requestContentDigest: normalizeAttentionDigest(value.requestContentDigest),
    producer: normalizeProducerBinding(value.producer),
    producerBindingDigest: normalizeAttentionDigest(value.producerBindingDigest),
    requestKey: boundedAttentionText(value.requestKey, "outbox.requestKey", {
      maximumBytes: 128,
      error: invalidState(),
    }),
    result: normalizeResult(value.result),
  });
  const contentDigest = attentionDigest(core);
  if (
    value.contentDigest !== contentDigest ||
    value.outboxId !== `attention-outbox-${contentDigest}`
  ) {
    throw invalidState("内部请示 outbox 摘要不一致");
  }
  safeInternalId(value.outboxId, "outbox.outboxId", OUTBOX_ID);
  return { outboxId: value.outboxId, contentDigest, ...core };
}

export function defaultAttentionState() {
  return {
    schemaVersion: 2,
    revision: 0,
    nextOutboxSequence: 1,
    items: [],
    outbox: [],
  };
}

function validateCrossRecords(state) {
  const requestIds = new Set();
  const producerBindings = new Set();
  const timelineByRevision = new Map();
  const itemByRequestId = new Map();
  for (const item of state.items) {
    if (
      requestIds.has(item.requestId) ||
      producerBindings.has(item.producerBindingDigest)
    ) {
      throw invalidState("内部请示请求重复");
    }
    requestIds.add(item.requestId);
    producerBindings.add(item.producerBindingDigest);
    itemByRequestId.set(item.requestId, item);
    for (const event of item.timeline) {
      if (timelineByRevision.has(event.revision)) {
        throw invalidState("内部请示时间线版本重复");
      }
      timelineByRevision.set(event.revision, event);
    }
  }
  if (timelineByRevision.size !== state.revision) {
    throw invalidState("内部请示版本存在缺口");
  }
  let previousAt = null;
  const lifecycleByRequestId = new Map();
  for (let revision = 1; revision <= state.revision; revision += 1) {
    const event = timelineByRevision.get(revision);
    if (!event || (previousAt && Date.parse(event.at) < Date.parse(previousAt))) {
      throw invalidState("内部请示时间线不是单调序列");
    }
    if (event.type === "created") {
      if (lifecycleByRequestId.has(event.requestId)) {
        throw invalidState("内部请示被重复创建");
      }
      lifecycleByRequestId.set(event.requestId, "pending");
    } else {
      if (lifecycleByRequestId.get(event.requestId) !== "pending") {
        throw invalidState("内部请示终态发生在创建之前");
      }
      lifecycleByRequestId.set(event.requestId, event.type);
    }
    previousAt = event.at;
  }
  for (const item of state.items) {
    if (lifecycleByRequestId.get(item.requestId) !== item.status) {
      throw invalidState("内部请示全局时间线与当前状态不一致");
    }
  }
  for (let index = 0; index < state.outbox.length; index += 1) {
    const entry = state.outbox[index];
    const item = itemByRequestId.get(entry.requestId);
    if (
      entry.sequence !== index + 1 ||
      !item?.result ||
      entry.requestContentDigest !== item.contentDigest ||
      entry.producerBindingDigest !== item.producerBindingDigest ||
      entry.requestKey !== item.requestKey ||
      attentionDigest(entry.producer) !== attentionDigest(item.producer) ||
      entry.result.resultId !== item.result.resultId ||
      entry.result.contentDigest !== item.result.contentDigest
    ) {
      throw invalidState("内部请示 outbox 与请求结果不一致");
    }
  }
  const terminalCount = state.items.filter((item) => item.result !== null).length;
  if (
    state.outbox.length !== terminalCount ||
    state.nextOutboxSequence !== state.outbox.length + 1
  ) {
    throw invalidState("内部请示 outbox 序列不完整");
  }
}

export function normalizeAttentionState(value) {
  try {
    assertAttentionExactKeys(
      value,
      ["schemaVersion", "revision", "nextOutboxSequence", "items", "outbox"],
      invalidState(),
    );
    if (![1, 2].includes(value.schemaVersion)) throw invalidState();
    const state = {
      schemaVersion: 2,
      revision: safeStateInteger(value.revision, "revision"),
      nextOutboxSequence: safeStateInteger(
        value.nextOutboxSequence,
        "nextOutboxSequence",
        1,
      ),
      items: attentionArrayValues(value.items, MAX_ITEMS, invalidState()).map(
        (item) => normalizeItem(item, { legacy: value.schemaVersion === 1 }),
      ),
      outbox: attentionArrayValues(
        value.outbox,
        MAX_OUTBOX_ITEMS,
        invalidState(),
      ).map(normalizeOutboxEntry),
    };
    validateCrossRecords(state);
    if (
      Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`, "utf8") >
      MAX_STATE_BYTES
    ) {
      throw invalidState("内部请示状态超过容量限制");
    }
    return state;
  } catch (error) {
    if (error?.code === "ATTENTION_STATE_CORRUPTED") throw error;
    throw stateError(undefined, error);
  }
}

export function resolveAttentionItem(item, answer, revision, at, sequence) {
  const result = createAttentionResult(item, answer, revision, at);
  const resolved = {
    ...cloneAttentionValue(item),
    status: result.kind,
    revision,
    updatedAt: at,
    result,
    timeline: [
      ...cloneAttentionValue(item.timeline),
      createTimelineEvent({
        type: result.kind,
        requestId: item.requestId,
        revision,
        at,
        contentDigest: result.contentDigest,
      }),
    ],
  };
  return {
    item: resolved,
    outbox: createAttentionOutboxEntry(resolved, sequence),
  };
}

export function archiveAttentionItem(item, retirement, revision, at) {
  const archive = normalizeRetirement(retirement);
  return {
    ...cloneAttentionValue(item),
    status: "archived",
    revision,
    updatedAt: at,
    archive,
    timeline: [
      ...cloneAttentionValue(item.timeline),
      createTimelineEvent({
        type: "archived", requestId: item.requestId, revision, at,
        contentDigest: archiveDigest(item, archive),
      }),
    ],
  };
}

export function projectAttentionRequest(item) {
  return cloneAttentionValue({
    requestId: item.requestId,
    type: item.type,
    producer: item.producer,
    question: item.question,
    context: item.context,
    choices: item.choices,
    maintenanceCode: maintenanceAttentionCode(item),
    revision: item.revision,
    contentDigest: item.contentDigest,
    createdAt: item.createdAt,
  });
}

export function projectAttentionReceipt(item, { includeProducerBinding = false } = {}) {
  return cloneAttentionValue({
    requestId: item.requestId,
    contentDigest: item.contentDigest,
    ...(includeProducerBinding
      ? { producerBindingDigest: item.producerBindingDigest }
      : {}),
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.result ? { resultId: item.result.resultId } : {}),
  });
}

export function attentionStateBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export const ATTENTION_STATE_LIMITS = Object.freeze({
  maximumItems: MAX_ITEMS,
  maximumOutboxItems: MAX_OUTBOX_ITEMS,
  maximumStateBytes: MAX_STATE_BYTES,
});
