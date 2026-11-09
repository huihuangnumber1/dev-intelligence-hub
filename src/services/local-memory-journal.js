import { authorityLifecycleMemoryRecord } from "../domain/memory-authority-lifecycle.js";
import { createHash } from "node:crypto";
import { scheduler } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import {
  normalizeMemoryRecord,
  projectMemoryRecord,
} from "../domain/memory-record.js";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  normalizePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import {
  normalizeWorkGraphMemoryEvent,
  normalizeWorkGraphSourceAuthority,
  workGraphMemoryRecordReceipt,
} from "../domain/work-graph-memory-event.js";

export const MEMORY_JOURNAL_KEY = "unified-memory-records";
export const MEMORY_INDEX_KEY = "unified-memory-index";
const MAX_BATCH = 160;
const MAX_WORK_ITEM_BATCH = 20_000;
const MAX_READ_RECORDS = 20;
const DEFAULT_MAX_RECORDS = 20_000;
const DEFAULT_MAX_STATE_BYTES = 64 * 1024 * 1024;
const CAPACITY_WARNING_RATIO = 0.8;
const DEFAULT_POST_COMMIT_YIELD = () => scheduler.yield();
const MAX_INDEX_ASSOCIATIONS = 250_000;
const MAX_RECORD_INDEX_TOKENS = 4_096;
const MAX_AUTHORITY_PROJECTION_ENTRIES = 100_000;
const SHA256 = /^[a-f0-9]{64}$/;
const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/;
const WORK_ITEM_REVISION = /^(.*):revision:([1-9][0-9]*)$/u;
const WORK_ITEM_REVISION_SUPERSESSION =
  "supersedes-work-item-revisions:";
const WORK_GRAPH_SOURCE_SUPERSESSION =
  "supersedes-work-graph-source:";
const WORK_AUTHORITY_BINDING_SUPERSESSION =
  "supersedes-work-authority-binding:";
const RESERVED_WORK_SOURCES = new Set([
  "work-item",
  "work-contract",
  "work-delivery",
  "work-obsolescence",
  "work-authority-lifecycle",
  "work-timeline",
  "legacy-pr-memory",
  "work-decision",
  "consultation-request",
  "consultation-result",
  "confirmation",
  "external-result",
]);
const AUTHORITY_BOUND_PROJECTION_SOURCES = new Set([
  "work-decision",
  "consultation-request",
  "consultation-result",
  "confirmation",
  "external-result",
]);
const NON_CITABLE_HISTORY_SOURCES = new Set([
  "work-timeline",
  "legacy-pr-memory",
]);
const MECHANICAL_TIMELINE_DETAIL_KEYS = new Map([
  [
    "assignment_intaken",
    ["assignmentId", "inputDigest", "kind", "sourceSequence"],
  ],
  ["claimed", ["attempt", "inputDigest", "leaseId", "leaseUntil"]],
  [
    "intake_completed",
    [
      "afterSequence",
      "deduplicated",
      "highWatermark",
      "nextSequence",
      "received",
    ],
  ],
  [
    "intent_bound",
    ["bindingDigest", "dispatchLeaseId", "intentId"],
  ],
  [
    "intent_claimed",
    [
      "attempt",
      "deliverySemantics",
      "dispatchLeaseId",
      "dispatchLeaseUntil",
      "intentId",
    ],
  ],
  [
    "intent_lease_expired",
    [
      "intentId",
      "previousDispatchLeaseId",
      "previousDispatchLeaseUntil",
      "previousDispatcherId",
    ],
  ],
  [
    "lease_expired",
    ["previousLeaseId", "previousLeaseUntil", "previousOwnerId"],
  ],
]);
const SAFE_SOURCE_KIND = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const INVALID_RECEIPT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MEMORY_RECORD_REFERENCE = /memory-[a-f0-9]{64}/gu;
const RECEIPT_KEYS = ["recordId", "contentDigest", "source"];
const RECEIPT_SOURCE_KEYS = ["kind", "id"];
const QUERY_KEYS = [
  "q",
  "roleId",
  "repository",
  "eventType",
  "from",
  "to",
  "limit",
  "cursor",
];

function memoryError(code, message, statusCode = 400, cause) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, statusCode },
  );
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, allowed, name) {
  const entries = dataEntries(value, name);
  if (entries.some(([key]) => !allowed.includes(key))) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 字段无效`);
  }
  return Object.fromEntries(entries);
}

function receiptUnverified() {
  return memoryError(
    "MEMORY_RECEIPT_UNVERIFIED",
    "无法验证持久记忆凭据",
    409,
  );
}

function receiptReference(value) {
  const error = receiptUnverified();
  try {
    const entries = new Map(dataEntries(value, "memory receipt"));
    const sourceEntries = new Map(
      dataEntries(entries.get("source"), "memory receipt source"),
    );
    if (
      entries.size !== RECEIPT_KEYS.length ||
      RECEIPT_KEYS.some((key) => !entries.has(key)) ||
      sourceEntries.size !== RECEIPT_SOURCE_KEYS.length ||
      RECEIPT_SOURCE_KEYS.some((key) => !sourceEntries.has(key))
    ) {
      throw error;
    }
    const recordId = entries.get("recordId");
    const contentDigest = entries.get("contentDigest");
    const kind = sourceEntries.get("kind");
    const id = sourceEntries.get("id");
    if (
      typeof contentDigest !== "string" ||
      !SHA256.test(contentDigest) ||
      recordId !== `memory-${contentDigest}` ||
      typeof kind !== "string" ||
      !SAFE_SOURCE_KIND.test(kind) ||
      typeof id !== "string" ||
      id.trim().length === 0 ||
      Buffer.byteLength(id, "utf8") > 512 ||
      INVALID_RECEIPT_CONTROL.test(id)
    ) {
      throw error;
    }
    return { recordId, contentDigest, source: { kind, id } };
  } catch {
    throw error;
  }
}

function strictArray(value, maximum, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw memoryError("MEMORY_INPUT_INVALID", `${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} 无效`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw memoryError("MEMORY_JOURNAL_CORRUPTED", `${name} 无效`, 503);
  }
  return value;
}

function optionalDigest(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw memoryError("MEMORY_JOURNAL_CORRUPTED", `${name} 无效`, 503);
  }
  return value;
}

function emptyLifecycleAuthority() {
  return {
    schemaVersion: 2,
    baseCursor: 0,
    baseCheckpointDigest: null,
    graphCursor: 0,
    graphCheckpointDigest: null,
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    workLedgerRevision: 0,
    graphReceipts: [],
    workItemAttestations: [],
    authorityProjection: {
      schemaVersion: 4,
      revision: 0,
      workLedgerRevision: 0,
      authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
      confirmationHighWatermark: 0,
      entries: [],
    },
  };
}

function legacyWorkItemAttestations(records) {
  return records.flatMap((record) => {
    if (record.source.kind !== "work-item") return [];
    const match = record.source.id.match(WORK_ITEM_REVISION);
    if (match === null) return [];
    let sourceAuthority = null;
    try {
      sourceAuthority = normalizeWorkGraphSourceAuthority(
        JSON.parse(record.content)?.sourceAuthority,
      );
    } catch {
      sourceAuthority = null;
    }
    let legacyPrWorkItem = record.sourceUrl?.includes("/pull/") === true;
    try {
      legacyPrWorkItem ||= String(JSON.parse(record.content)?.eventType || "")
        .startsWith("pull_request.");
    } catch {}
    return [{
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      itemId: match[1],
      revision: Number(match[2]),
      trusted: false,
      bindingDigest: sourceAuthority?.bindingDigest ?? null,
      citable: sourceAuthority?.citable ?? !legacyPrWorkItem,
    }];
  });
}

function normalizeWorkItemAttestation(value, recordsById) {
  const includesTrusted =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "trusted");
  const fields = exact(value, [
    "recordId",
    "contentDigest",
    "itemId",
    "revision",
    ...(includesTrusted ? ["trusted"] : []),
    "bindingDigest",
    "citable",
  ], "work item lifecycle attestation");
  const record = recordsById.get(fields.recordId);
  const match = record?.source?.kind === "work-item"
    ? record.source.id.match(WORK_ITEM_REVISION)
    : null;
  if (
    record === undefined ||
    record.contentDigest !== fields.contentDigest ||
    match === null ||
    match[1] !== fields.itemId ||
    Number(match[2]) !== fields.revision ||
    (includesTrusted && typeof fields.trusted !== "boolean") ||
    typeof fields.citable !== "boolean"
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "work item lifecycle attestation 无效",
      503,
    );
  }
  let trusted = includesTrusted ? fields.trusted : false;
  if (!includesTrusted) {
    try {
      normalizeWorkGraphSourceAuthority(
        JSON.parse(record.content)?.sourceAuthority,
      );
      trusted =
        record.evidence.length === 1 &&
        record.evidence[0] ===
          `${WORK_ITEM_REVISION_SUPERSESSION}${match[1]}`;
    } catch {
      trusted = false;
    }
  }
  return {
    recordId: fields.recordId,
    contentDigest: fields.contentDigest,
    itemId: fields.itemId,
    revision: fields.revision,
    trusted,
    bindingDigest: optionalDigest(
      fields.bindingDigest,
      "work item bindingDigest",
    ),
    citable: fields.citable,
  };
}

function normalizeGraphReceipt(value, recordsById) {
  const fields = exact(value, [
    "schemaVersion",
    "eventSchemaVersion",
    "sequence",
    "eventId",
    "eventDigest",
    "previousDigest",
    "ledgerRevision",
    "taskId",
    "taskRevision",
    "kind",
    "recordRevision",
    "sourceRecordDigest",
    "occurredAt",
    "memoryRecordId",
    "memoryRecordDigest",
    "sourceAuthority",
    "bindingDigest",
    "citable",
    "invalidatedBindingDigest",
    "authorityStateDigest",
  ], "graph lifecycle receipt");
  const record = recordsById.get(fields.memoryRecordId);
  if (
    fields.schemaVersion !== 2 ||
    ![1, 2].includes(fields.eventSchemaVersion) ||
    !Number.isSafeInteger(fields.sequence) ||
    fields.sequence < 1 ||
    typeof fields.eventId !== "string" ||
    fields.eventId !== `work-graph-memory-event-${fields.eventDigest}` ||
    typeof fields.eventDigest !== "string" ||
    !SHA256.test(fields.eventDigest) ||
    !(fields.previousDigest === null || SHA256.test(fields.previousDigest)) ||
    !Number.isSafeInteger(fields.ledgerRevision) ||
    fields.ledgerRevision < 1 ||
    typeof fields.taskId !== "string" ||
    fields.taskId.length === 0 ||
    !Number.isSafeInteger(fields.taskRevision) ||
    fields.taskRevision < 1 ||
    typeof fields.kind !== "string" ||
    !Number.isSafeInteger(fields.recordRevision) ||
    fields.recordRevision < 1 ||
    typeof fields.sourceRecordDigest !== "string" ||
    !SHA256.test(fields.sourceRecordDigest) ||
    typeof fields.occurredAt !== "string" ||
    record?.contentDigest !== fields.memoryRecordDigest ||
    record.recordId !== fields.memoryRecordId ||
    typeof fields.citable !== "boolean"
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "graph lifecycle receipt 无效",
      503,
    );
  }
  const bindingDigest = optionalDigest(
    fields.bindingDigest,
    "graph bindingDigest",
  );
  const invalidatedBindingDigest = optionalDigest(
    fields.invalidatedBindingDigest,
    "graph invalidatedBindingDigest",
  );
  const receiptAuthorityStateDigest = optionalDigest(
    fields.authorityStateDigest,
    "graph receipt authorityStateDigest",
  );
  if (
    (fields.eventSchemaVersion === 1) !==
      (fields.sourceAuthority === null && receiptAuthorityStateDigest === null) ||
    (fields.kind === "authority_invalidated") !==
      (invalidatedBindingDigest !== null) ||
    (fields.kind === "authority_invalidated" && fields.citable)
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "graph lifecycle authority 无效",
      503,
    );
  }
  const { recordId: _recordId, contentDigest: _contentDigest, ...memoryRecord } =
    record;
  let event;
  try {
    event = normalizeWorkGraphMemoryEvent({
      schemaVersion: fields.eventSchemaVersion,
      sequence: fields.sequence,
      eventId: fields.eventId,
      eventDigest: fields.eventDigest,
      previousDigest: fields.previousDigest,
      ledgerRevision: fields.ledgerRevision,
      taskId: fields.taskId,
      taskRevision: fields.taskRevision,
      recordRevision: fields.recordRevision,
      sourceRecordDigest: fields.sourceRecordDigest,
      kind: fields.kind,
      occurredAt: fields.occurredAt,
      ...(fields.eventSchemaVersion === 2
        ? {
            sourceAuthority: fields.sourceAuthority,
            authorityStateDigest: receiptAuthorityStateDigest,
          }
        : {}),
      memoryRecord,
    });
  } catch (cause) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "graph lifecycle event 摘要无效",
      503,
      cause,
    );
  }
  const expectedReceipt = workGraphMemoryRecordReceipt(event);
  if (
    expectedReceipt.memoryRecordId !== fields.memoryRecordId ||
    expectedReceipt.memoryRecordDigest !== fields.memoryRecordDigest ||
    (event.schemaVersion === 2 &&
      (event.sourceAuthority.bindingDigest !== bindingDigest ||
        event.sourceAuthority.citable !== fields.citable)) ||
    (event.schemaVersion === 1 && (bindingDigest !== null || fields.citable))
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "graph lifecycle event 与记录不一致",
      503,
    );
  }
  return {
    schemaVersion: 2,
    eventSchemaVersion: event.schemaVersion,
    sequence: fields.sequence,
    eventId: fields.eventId,
    eventDigest: fields.eventDigest,
    previousDigest: fields.previousDigest,
    ledgerRevision: fields.ledgerRevision,
    taskId: fields.taskId,
    taskRevision: fields.taskRevision,
    kind: fields.kind,
    recordRevision: fields.recordRevision,
    sourceRecordDigest: fields.sourceRecordDigest,
    occurredAt: fields.occurredAt,
    memoryRecordId: fields.memoryRecordId,
    memoryRecordDigest: fields.memoryRecordDigest,
    sourceAuthority: event.schemaVersion === 2
      ? structuredClone(event.sourceAuthority)
      : null,
    bindingDigest,
    citable: fields.citable,
    invalidatedBindingDigest,
    authorityStateDigest: receiptAuthorityStateDigest,
  };
}

function authorityProjectionFields(value, expected, name) {
  let entries;
  try {
    entries = dataEntries(value, name);
  } catch (cause) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      `${name} 无效`,
      503,
      cause,
    );
  }
  if (
    entries.length !== expected.length ||
    expected.some((key) => !entries.some(([entryKey]) => entryKey === key))
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      `${name} 字段无效`,
      503,
    );
  }
  return Object.fromEntries(entries);
}

function normalizeAuthorityProjection(value, recordsById) {
  let rawFields;
  try {
    rawFields = dataEntries(value, "memory authority projection");
  } catch (cause) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection 无效",
      503,
      cause,
    );
  }
  const schemaVersion = rawFields.find(
    ([key]) => key === "schemaVersion",
  )?.[1];
  if (![3, 4].includes(schemaVersion)) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection 版本无效",
      503,
    );
  }
  const expectedFields = [
    "schemaVersion",
    "revision",
    ...(schemaVersion === 4
      ? ["workLedgerRevision", "authorityStateDigest"]
      : []),
    "confirmationHighWatermark",
    "entries",
  ];
  if (
    rawFields.length !== expectedFields.length ||
    expectedFields.some(
      (key) => !rawFields.some(([entryKey]) => entryKey === key),
    )
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection 字段无效",
      503,
    );
  }
  const fields = Object.fromEntries(rawFields);
  const revision = nonNegativeInteger(
    fields.revision,
    "authorityProjection.revision",
  );
  const workLedgerRevision = schemaVersion === 4
    ? nonNegativeInteger(
        fields.workLedgerRevision,
        "authorityProjection.workLedgerRevision",
      )
    : 0;
  const authorityStateDigest = schemaVersion === 4
    ? optionalDigest(
        fields.authorityStateDigest,
        "authorityProjection.authorityStateDigest",
      )
    : EMPTY_AUTHORITY_STATE_DIGEST;
  if (authorityStateDigest === null) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection authority digest 无效",
      503,
    );
  }
  const confirmationHighWatermark = nonNegativeInteger(
    fields.confirmationHighWatermark,
    "authorityProjection.confirmationHighWatermark",
  );
  let rawEntries;
  try {
    rawEntries = strictArray(
      fields.entries,
      MAX_AUTHORITY_PROJECTION_ENTRIES,
      "authorityProjection.entries",
    );
  } catch (cause) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection entries 无效",
      503,
      cause,
    );
  }
  const entries = rawEntries.map((valueEntry) => {
    const entry = authorityProjectionFields(valueEntry, [
      "key",
      "fingerprint",
      "recordId",
      "sourceKind",
      "binding",
      "current",
      "occurredAt",
    ], "memory authority projection entry");
    if (
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      Buffer.byteLength(entry.key, "utf8") > 512 ||
      typeof entry.fingerprint !== "string" ||
      !SHA256.test(entry.fingerprint) ||
      typeof entry.recordId !== "string" ||
      !MEMORY_RECORD_ID.test(entry.recordId) ||
      !AUTHORITY_BOUND_PROJECTION_SOURCES.has(entry.sourceKind) ||
      typeof entry.current !== "boolean" ||
      typeof entry.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(entry.occurredAt)) ||
      new Date(Date.parse(entry.occurredAt)).toISOString() !== entry.occurredAt
    ) {
      throw memoryError(
        "MEMORY_JOURNAL_CORRUPTED",
        "memory authority projection entry 值无效",
        503,
      );
    }
    let binding = null;
    if (entry.binding !== null) {
      try {
        binding = normalizePullRequestExecutionBinding(entry.binding);
      } catch (cause) {
        throw memoryError(
          "MEMORY_JOURNAL_CORRUPTED",
          "memory authority projection binding 无效",
          503,
          cause,
        );
      }
      if (!isDeepStrictEqual(binding, entry.binding)) {
        throw memoryError(
          "MEMORY_JOURNAL_CORRUPTED",
          "memory authority projection binding 非规范",
          503,
        );
      }
    }
    const record = recordsById.get(entry.recordId);
    let content;
    try {
      content = JSON.parse(record?.content);
    } catch {
      content = null;
    }
    const authority = content?.authority;
    const bindingMatches = authority?.applies === true
      ? binding !== null && isDeepStrictEqual(binding, authority.inputBinding)
      : binding === null && authority?.applies === false;
    const kindBindingMatches = entry.sourceKind === "confirmation"
      ? authority?.applies === true &&
        isDeepStrictEqual(content?.action?.inputBinding, authority.inputBinding)
      : entry.sourceKind === "external-result"
        ? authority?.applies === true &&
          isDeepStrictEqual(content?.inputBinding, authority.inputBinding)
        : true;
    if (
      record?.source.kind !== entry.sourceKind ||
      record.occurredAt !== entry.occurredAt ||
      authority?.current !== entry.current ||
      !bindingMatches ||
      !kindBindingMatches
    ) {
      throw memoryError(
        "MEMORY_JOURNAL_CORRUPTED",
        "memory authority projection record 引用无效",
        503,
      );
    }
    return {
      key: entry.key,
      fingerprint: entry.fingerprint,
      recordId: entry.recordId,
      sourceKind: entry.sourceKind,
      binding,
      current: entry.current,
      occurredAt: entry.occurredAt,
    };
  });
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection key 重复",
      503,
    );
  }
  if (new Set(entries.map(({ recordId }) => recordId)).size !== entries.length) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory authority projection record 重复引用",
      503,
    );
  }
  return {
    schemaVersion: 4,
    revision,
    workLedgerRevision,
    authorityStateDigest,
    confirmationHighWatermark,
    entries,
  };
}

function normalizeLifecycleAuthority(value, records) {
  const schemaVersion = value?.schemaVersion;
  const fields = exact(value, [
    "schemaVersion",
    "baseCursor",
    "baseCheckpointDigest",
    "graphCursor",
    "graphCheckpointDigest",
    "authorityStateDigest",
    "workLedgerRevision",
    "graphReceipts",
    "workItemAttestations",
    ...(schemaVersion === 2 ? ["authorityProjection"] : []),
  ], "memory lifecycle authority");
  if (![1, 2].includes(fields.schemaVersion)) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory lifecycle authority 无效",
      503,
    );
  }
  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const baseCursor = nonNegativeInteger(fields.baseCursor, "baseCursor");
  const graphCursor = nonNegativeInteger(fields.graphCursor, "graphCursor");
  const baseCheckpointDigest = optionalDigest(
    fields.baseCheckpointDigest,
    "baseCheckpointDigest",
  );
  const graphCheckpointDigest = optionalDigest(
    fields.graphCheckpointDigest,
    "graphCheckpointDigest",
  );
  const authorityStateDigest = optionalDigest(
    fields.authorityStateDigest,
    "authorityStateDigest",
  );
  const workLedgerRevision = nonNegativeInteger(
    fields.workLedgerRevision,
    "workLedgerRevision",
  );
  const graphReceipts = strictArray(
    fields.graphReceipts,
    records.length,
    "graphReceipts",
  ).map((receipt) => normalizeGraphReceipt(receipt, recordsById));
  const workItemAttestations = strictArray(
    fields.workItemAttestations,
    records.length,
    "workItemAttestations",
  ).map((attestation) => normalizeWorkItemAttestation(attestation, recordsById));
  const authorityProjection = fields.schemaVersion === 1
    ? emptyLifecycleAuthority().authorityProjection
    : normalizeAuthorityProjection(fields.authorityProjection, recordsById);
  const activeAuthorityRecordIds = new Set(
    authorityProjection.entries.map(({ recordId }) => recordId),
  );
  const supersededAuthorityRecordIds = new Set();
  for (const record of records) {
    if (!AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind)) continue;
    for (const evidence of record.evidence) {
      if (!evidence.startsWith("supersedes:")) continue;
      const supersededId = evidence.slice("supersedes:".length);
      const superseded = recordsById.get(supersededId);
      if (
        superseded?.source.kind !== record.source.kind ||
        supersededId === record.recordId
      ) {
        throw memoryError(
          "MEMORY_JOURNAL_CORRUPTED",
          "memory authority projection supersession 无效",
          503,
        );
      }
      supersededAuthorityRecordIds.add(supersededId);
    }
  }
  const currentProjectionSchema =
    fields.schemaVersion === 2 && fields.authorityProjection.schemaVersion === 4;
  if (
    currentProjectionSchema &&
    records.some((record) => {
      if (!AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind)) {
        return false;
      }
      let current = false;
      try {
        current = JSON.parse(record.content).authority.current === true;
      } catch {}
      return current &&
        !activeAuthorityRecordIds.has(record.recordId) &&
        !supersededAuthorityRecordIds.has(record.recordId);
    })
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "current authority memory 缺少投影 checkpoint",
      503,
    );
  }
  if (
    baseCursor > graphCursor ||
    authorityStateDigest === null ||
    (baseCursor === 0) !== (baseCheckpointDigest === null) ||
    (graphCursor === 0) !== (graphCheckpointDigest === null) ||
    graphReceipts.length !== graphCursor - baseCursor ||
    new Set(graphReceipts.map(({ memoryRecordId }) => memoryRecordId)).size !==
      graphReceipts.length ||
    new Set(workItemAttestations.map(({ recordId }) => recordId)).size !==
      workItemAttestations.length
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory lifecycle checkpoint 无效",
      503,
    );
  }
  let previousDigest = baseCheckpointDigest;
  for (let index = 0; index < graphReceipts.length; index += 1) {
    const receipt = graphReceipts[index];
    if (
      receipt.sequence !== baseCursor + index + 1 ||
      receipt.previousDigest !== previousDigest
    ) {
      throw memoryError(
        "MEMORY_JOURNAL_CORRUPTED",
        "memory lifecycle receipt chain 无效",
        503,
      );
    }
    previousDigest = receipt.eventDigest;
  }
  if (previousDigest !== graphCheckpointDigest) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "memory lifecycle digest checkpoint 无效",
      503,
    );
  }
  return {
    schemaVersion: 2,
    baseCursor,
    baseCheckpointDigest,
    graphCursor,
    graphCheckpointDigest,
    authorityStateDigest,
    workLedgerRevision,
    graphReceipts,
    workItemAttestations,
    authorityProjection,
  };
}

function emptyJournal() {
  return {
    schemaVersion: 2,
    revision: 0,
    records: [],
    lifecycleAuthority: emptyLifecycleAuthority(),
  };
}

function journalDigest(records) {
  return createHash("sha256")
    .update(records.map(({ recordId }) => recordId).join("\n"), "utf8")
    .digest("hex");
}

function storedRecord(value) {
  const entries = new Map(dataEntries(value, "stored memory record"));
  const recordId = entries.get("recordId");
  const contentDigest = entries.get("contentDigest");
  entries.delete("recordId");
  entries.delete("contentDigest");
  const normalized = normalizeMemoryRecord(Object.fromEntries(entries));
  if (
    normalized.recordId !== recordId ||
    normalized.contentDigest !== contentDigest
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录摘要不一致",
      503,
    );
  }
  return normalized;
}

function retireOrphanedUnboundConsultations(value) {
  // Older window eviction dropped unbound consultation checkpoints without
  // retiring their records. Preserve history and validate the full repaired state.
  if (value?.schemaVersion !== 2 || value.lifecycleAuthority?.authorityProjection?.schemaVersion !== 4 ||
      !Array.isArray(value.records)) return null;
  const records = value.records.map(storedRecord).map(record =>
    AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind) ? projectionRecord(record) : record);
  const active = new Set(value.lifecycleAuthority.authorityProjection.entries.map(entry => entry.recordId));
  const superseded = new Set(records.flatMap(record => record.evidence
    .filter(evidence => evidence.startsWith("supersedes:")).map(evidence => evidence.slice("supersedes:".length))));
  const obsolete = [];
  for (const record of records) {
    if (record.source.kind !== "consultation-request" || active.has(record.recordId) || superseded.has(record.recordId)) continue;
    const content = JSON.parse(record.content);
    if (!isDeepStrictEqual(content.authority, { applies: false, current: true, bindingDigest: null, inputBinding: null })) continue;
    obsolete.push(projectionRecord(normalizeMemoryRecord(authorityLifecycleMemoryRecord({
      key: record.source.id, sourceKind: record.source.kind, recordId: record.recordId,
      binding: null, occurredAt: record.occurredAt,
    }))));
  }
  return obsolete.length === 0 ? null : { ...value, revision: value.revision + 1,
    records: [...value.records, ...obsolete] };
}

function assertAuthorityProjectionRetirements(previous, next, records) {
  const retained = new Set(next.entries.map(entry => entry.recordId));
  const retired = new Set(records.flatMap(record => record.evidence
    .filter(evidence => evidence.startsWith("supersedes:")).map(evidence => evidence.slice("supersedes:".length))));
  if (previous.entries.some(entry => entry.current !== false && !retained.has(entry.recordId) && !retired.has(entry.recordId))) {
    throw memoryError("MEMORY_LIFECYCLE_AUTHORITY_INVALID", "移除当前记忆投影必须记录失效凭证", 409);
  }
}

function normalizeJournal(value, limits) {
  if (value === null) return emptyJournal();
  const schemaVersion = value?.schemaVersion;
  const state = exact(
    value,
    [
      "schemaVersion",
      "revision",
      "records",
      ...(schemaVersion === 2 ? ["lifecycleAuthority"] : []),
    ],
    "memory journal",
  );
  if (
    ![1, 2].includes(state.schemaVersion) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆状态无效",
      503,
    );
  }
  let rawRecords;
  try {
    rawRecords = strictArray(state.records, limits.maximumRecords, "records");
  } catch (error) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录集合无效",
      503,
      error,
    );
  }
  const records = rawRecords.map((value) => {
    const record = storedRecord(value);
    return AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind)
      ? projectionRecord(record)
      : record;
  });
  if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆记录重复",
      503,
    );
  }
  const lifecycleAuthority = state.schemaVersion === 1
    ? {
        ...emptyLifecycleAuthority(),
        workItemAttestations: legacyWorkItemAttestations(records),
      }
    : normalizeLifecycleAuthority(state.lifecycleAuthority, records);
  const normalized = {
    schemaVersion: 2,
    revision: state.revision,
    records,
    lifecycleAuthority,
  };
  if (serializedBytes(normalized) > limits.maximumStateBytes) {
    throw memoryError(
      "MEMORY_JOURNAL_CORRUPTED",
      "统一记忆状态超过容量限制",
      503,
    );
  }
  return normalized;
}

function normalizeJournalLimits({
  maximumRecords = DEFAULT_MAX_RECORDS,
  maximumStateBytes = DEFAULT_MAX_STATE_BYTES,
} = {}) {
  return Object.freeze({
    maximumRecords: positiveInteger(
      maximumRecords,
      "maximumRecords",
      100_000,
    ),
    maximumStateBytes: positiveInteger(
      maximumStateBytes,
      "maximumStateBytes",
      256 * 1024 * 1024,
    ),
  });
}

export function normalizeMemoryJournalState(value, options = {}) {
  return normalizeJournal(value, normalizeJournalLimits(options));
}

export function normalizeMemoryAuthorityProjectionReferences(value, records) {
  const normalizedRecords = strictArray(
    records,
    100_000,
    "memory authority projection records",
  ).map(storedRecord).map((record) =>
    AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind)
      ? projectionRecord(record)
      : record
  );
  const recordsById = new Map(
    normalizedRecords.map((record) => [record.recordId, record]),
  );
  return structuredClone(normalizeAuthorityProjection(value, recordsById));
}

export function normalizeMemoryAuthorityProjectionState(
  value,
  journal,
  options = {},
) {
  const normalizedJournal = normalizeJournal(
    journal,
    normalizeJournalLimits(options),
  );
  const recordsById = new Map(
    normalizedJournal.records.map((record) => [record.recordId, record]),
  );
  return structuredClone(normalizeAuthorityProjection(value, recordsById));
}

function serializedBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizedSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en");
}

function lexicalTerms(value) {
  return normalizedSearchText(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function indexTokens(value, maximum = Number.POSITIVE_INFINITY) {
  const tokens = new Set();
  let complete = true;
  const add = (token) => {
    if (tokens.has(token)) return true;
    if (tokens.size >= maximum) {
      complete = false;
      return false;
    }
    tokens.add(token);
    return true;
  };
  terms:
  for (const term of lexicalTerms(value)) {
    if (!/\p{Script=Han}/u.test(term)) {
      if (Buffer.byteLength(term, "utf8") <= 256 && !add(term)) break;
      continue;
    }
    const characters = [...term];
    for (const character of characters) {
      if (!add(character)) break terms;
    }
    for (const width of [2, 3]) {
      for (let index = 0; index + width <= characters.length; index += 1) {
        if (!add(characters.slice(index, index + width).join(""))) {
          break terms;
        }
      }
    }
  }
  return { tokens, complete };
}

function recordText(record) {
  return normalizedSearchText(
    [
      record.title,
      record.summary,
      record.content,
      ...record.evidence,
      ...record.tags,
      record.roleId,
      record.repository,
      record.eventType,
      record.source.kind,
      record.source.id,
    ].join("\n"),
  );
}

function buildIndex(records, revision) {
  const tokenMap = new Map();
  let associations = 0;
  let complete = true;
  records:
  for (const record of records) {
    const generated = indexTokens(recordText(record), MAX_RECORD_INDEX_TOKENS);
    if (!generated.complete) complete = false;
    for (const token of generated.tokens) {
      if (associations >= MAX_INDEX_ASSOCIATIONS) {
        complete = false;
        break records;
      }
      const ids = tokenMap.get(token) || [];
      ids.push(record.recordId);
      tokenMap.set(token, ids);
      associations += 1;
    }
  }
  const entries = Object.fromEntries(
    [...tokenMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([token, ids]) => [token, ids]),
  );
  return {
    persisted: {
      schemaVersion: 1,
      journalRevision: revision,
      journalDigest: journalDigest(records),
      complete,
      entries,
    },
    tokenMap,
    complete,
  };
}

function indexMatches(value, expected) {
  try {
    const index = exact(
      value,
      [
        "schemaVersion",
        "journalRevision",
        "journalDigest",
        "complete",
        "entries",
      ],
      "memory index",
    );
    return (
      index.schemaVersion === 1 &&
      index.journalRevision === expected.journalRevision &&
      index.journalDigest === expected.journalDigest &&
      index.complete === expected.complete &&
      index.entries !== null &&
      typeof index.entries === "object" &&
      !Array.isArray(index.entries)
    );
  } catch {
    return false;
  }
}

export function buildMemoryJournalIndexState(journal, options = {}) {
  const normalized = normalizeMemoryJournalState(journal, options);
  return structuredClone(
    buildIndex(normalized.records, normalized.revision).persisted,
  );
}

export function isMemoryJournalIndexStateCurrent(
  value,
  journal,
  options = {},
) {
  try {
    return isDeepStrictEqual(
      value,
      buildMemoryJournalIndexState(journal, options),
    );
  } catch {
    return false;
  }
}

function isoFilter(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw memoryError("MEMORY_QUERY_INVALID", `${name} 无效`);
  }
  return value;
}

function optionalFilter(value, name, maximum = 256) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw memoryError("MEMORY_QUERY_INVALID", `${name} 无效`);
  }
  return value;
}

function encodeCursor(record) {
  return Buffer.from(
    JSON.stringify([record.occurredAt, record.recordId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1_024) {
    throw memoryError("MEMORY_QUERY_INVALID", "cursor 无效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      typeof parsed[1] !== "string" ||
      !/^memory-[a-f0-9]{64}$/.test(parsed[1])
    ) {
      throw new Error("invalid cursor");
    }
    return { occurredAt: parsed[0], recordId: parsed[1] };
  } catch {
    throw memoryError("MEMORY_QUERY_INVALID", "cursor 无效");
  }
}

function queryOptions(value) {
  const input = exact(value, QUERY_KEYS, "memory query");
  const limitValue = input.limit === undefined ? 30 : Number(input.limit);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    throw memoryError("MEMORY_QUERY_INVALID", "limit 无效");
  }
  const q = optionalFilter(input.q, "q", 1_024) || "";
  const from = isoFilter(input.from, "from");
  const to = isoFilter(input.to, "to");
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw memoryError("MEMORY_QUERY_INVALID", "时间范围无效");
  }
  return {
    q,
    roleId: optionalFilter(input.roleId, "roleId", 128),
    repository: optionalFilter(input.repository, "repository"),
    eventType: optionalFilter(input.eventType, "eventType", 128),
    from,
    to,
    limit: limitValue,
    cursor: decodeCursor(input.cursor),
  };
}

function readRecordIds(value) {
  const input = exact(value, ["recordIds"], "memory record query");
  if (!Object.hasOwn(input, "recordIds")) {
    throw memoryError("MEMORY_INPUT_INVALID", "recordIds 不能为空");
  }
  const recordIds = strictArray(
    input.recordIds,
    MAX_READ_RECORDS,
    "recordIds",
  );
  if (
    recordIds.length === 0 ||
    recordIds.some(
      (recordId) =>
        typeof recordId !== "string" || !MEMORY_RECORD_ID.test(recordId),
    ) ||
    new Set(recordIds).size !== recordIds.length
  ) {
    throw memoryError("MEMORY_INPUT_INVALID", "recordIds 无效");
  }
  return recordIds;
}

function currentGraphRecordIds(records, graphReceipts) {
  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const byTask = new Map();
  for (const receipt of graphReceipts) {
    if (!["acceptance_contract", "delivery_submitted", "delivery_accepted", "delivery_rejected"].includes(receipt.kind)) {
      continue;
    }
    const descriptors = byTask.get(receipt.taskId) ?? [];
    descriptors.push({ receipt, record: recordsById.get(receipt.memoryRecordId) });
    byTask.set(receipt.taskId, descriptors);
  }
  const current = new Set();
  for (const descriptors of byTask.values()) {
    const contracts = descriptors
      .filter(({ receipt }) => receipt.kind === "acceptance_contract")
      .sort((left, right) => left.receipt.recordRevision - right.receipt.recordRevision);
    const latestContract = contracts.at(-1);
    if (latestContract === undefined) continue;
    current.add(latestContract.record.recordId);
    const deliveries = descriptors.flatMap((descriptor) => {
      if (!descriptor.receipt.kind.startsWith("delivery_")) return [];
      try {
        const content = JSON.parse(descriptor.record.content);
        return [{ ...descriptor, content }];
      } catch {
        return [];
      }
    }).filter(({ content }) =>
      content.contractRevision === latestContract.receipt.recordRevision
    );
    const latestByDeliverable = new Map();
    for (const delivery of deliveries) {
      const previous = latestByDeliverable.get(delivery.content.deliverableId);
      if (
        previous === undefined ||
        previous.content.deliveryRevision < delivery.content.deliveryRevision
      ) {
        latestByDeliverable.set(delivery.content.deliverableId, delivery);
      }
    }
    for (const latest of latestByDeliverable.values()) {
      current.add(latest.record.recordId);
      if (!["accepted", "rejected"].includes(latest.content.status)) continue;
      const submission = deliveries.find(({ content }) =>
        content.status === "submitted" &&
        content.deliverableId === latest.content.deliverableId &&
        content.deliveryRevision + 1 === latest.content.deliveryRevision &&
        isDeepStrictEqual(content.evidence, latest.content.evidence)
      );
      if (submission !== undefined) current.add(submission.record.recordId);
    }
  }
  return current;
}

function supersededRecordIds(records, lifecycleAuthority) {
  const result = new Set();
  const activeAuthorityRecordIds = new Set(
    lifecycleAuthority.authorityProjection.entries.map(
      ({ recordId }) => recordId,
    ),
  );
  const workItemRecords = new Map();
  const workAttestationById = new Map(
    lifecycleAuthority.workItemAttestations.map((entry) => [entry.recordId, entry]),
  );
  const graphReceiptById = new Map(
    lifecycleAuthority.graphReceipts.map((entry) => [entry.memoryRecordId, entry]),
  );
  const invalidatedBindings = new Set(
    lifecycleAuthority.graphReceipts
      .map(({ invalidatedBindingDigest }) => invalidatedBindingDigest)
      .filter(Boolean),
  );
  const latestWorkAttestationByItem = new Map();
  for (const attestation of lifecycleAuthority.workItemAttestations) {
    const previous = latestWorkAttestationByItem.get(attestation.itemId);
    if (
      previous === undefined ||
      previous.revision < attestation.revision ||
      (previous.revision === attestation.revision &&
        !previous.trusted && attestation.trusted)
    ) {
      latestWorkAttestationByItem.set(attestation.itemId, attestation);
    }
  }
  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const supersededTasks = new Set();
  for (const [itemId, attestation] of latestWorkAttestationByItem) {
    if (!attestation.trusted) continue;
    try {
      if (JSON.parse(recordsById.get(attestation.recordId).content)?.status === "superseded") {
        supersededTasks.add(itemId);
      }
    } catch {
      result.add(attestation.recordId);
    }
  }
  const currentGraph = currentGraphRecordIds(
    records,
    lifecycleAuthority.graphReceipts,
  );
  for (const record of records) {
    if (
      AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind) &&
      !activeAuthorityRecordIds.has(record.recordId)
    ) {
      result.add(record.recordId);
    }
    for (const item of record.evidence) {
      if (item.startsWith("supersedes:")) {
        const recordId = item.slice("supersedes:".length);
        if (MEMORY_RECORD_ID.test(recordId)) result.add(recordId);
      }
    }
    if (record.source.kind === "work-item") {
      const attestation = workAttestationById.get(record.recordId);
      if (attestation === undefined) {
        result.add(record.recordId);
        continue;
      }
      const found = workItemRecords.get(attestation.itemId) ?? [];
      found.push(attestation);
      workItemRecords.set(attestation.itemId, found);
      if (
        !attestation.citable ||
        (attestation.bindingDigest !== null &&
          invalidatedBindings.has(attestation.bindingDigest))
      ) {
        result.add(record.recordId);
      }
      continue;
    }
    if (["work-contract", "work-delivery"].includes(record.source.kind)) {
      const receipt = graphReceiptById.get(record.recordId);
      if (
        receipt === undefined ||
        !receipt.citable ||
        supersededTasks.has(receipt.taskId) ||
        !currentGraph.has(record.recordId) ||
        (receipt.bindingDigest !== null &&
          invalidatedBindings.has(receipt.bindingDigest))
      ) {
        result.add(record.recordId);
      }
      continue;
    }
    if (["work-obsolescence", "work-authority-lifecycle"].includes(record.source.kind)) {
      result.add(record.recordId);
    }
  }
  for (const candidates of workItemRecords.values()) {
    const latestObservedRevision = candidates.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.revision),
      0,
    );
    for (const candidate of candidates) {
      const trustedAtLatestRevision = candidates.some(
        (entry) => entry.revision === latestObservedRevision && entry.trusted,
      );
      if (
        candidate.revision < latestObservedRevision ||
        (candidate.revision === latestObservedRevision &&
          trustedAtLatestRevision && !candidate.trusted)
      ) {
        result.add(candidate.recordId);
      }
    }
  }
  return result;
}

function hasPullRequestMetadata(record) {
  if (
    record.eventType.startsWith("pull_request.") ||
    record.sourceUrl?.includes("/pull/") === true
  ) {
    return true;
  }
  try {
    return String(JSON.parse(record.content)?.eventType || "")
      .startsWith("pull_request.");
  } catch {
    return false;
  }
}

function recordLabels(record, supersededIds) {
  return {
    authority: record.tags.includes("derived") ? "derived" : "raw",
    lifecycle:
      record.source.kind === "legacy-pr-memory" ||
      (!RESERVED_WORK_SOURCES.has(record.source.kind) &&
        hasPullRequestMetadata(record)) ||
      record.tags.includes("obsolete") ||
      supersededIds.has(record.recordId)
        ? "obsolete"
        : "current",
  };
}

function lifecycleProtectedRecordIds(lifecycleAuthority) {
  return new Set([
    ...lifecycleAuthority.graphReceipts.map(
      ({ memoryRecordId }) => memoryRecordId,
    ),
    ...lifecycleAuthority.workItemAttestations.map(({ recordId }) => recordId),
    ...lifecycleAuthority.authorityProjection.entries.map(
      ({ recordId }) => recordId,
    ),
  ]);
}

function isNonCitableHistoryRecord(record) {
  if (
    !NON_CITABLE_HISTORY_SOURCES.has(record.source.kind) ||
    !record.tags.includes("derived") ||
    !record.tags.includes("obsolete")
  ) {
    return false;
  }
  try {
    projectionRecord(record);
    return true;
  } catch {
    return false;
  }
}

function nonCitableHistoryRecordIds(records, lifecycleAuthority) {
  const protectedIds = lifecycleProtectedRecordIds(lifecycleAuthority);
  return new Set(records.flatMap((record) => {
    if (
      !isNonCitableHistoryRecord(record) ||
      protectedIds.has(record.recordId)
    ) {
      return [];
    }
    return [record.recordId];
  }));
}

function sortedKeys(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  return Object.keys(value).sort((left, right) =>
    left.localeCompare(right, "en")
  );
}

function mechanicalTimelineType(record) {
  if (
    record.source.kind !== "work-timeline" ||
    record.evidence.length !== 0
  ) {
    return null;
  }
  const type = record.eventType.startsWith("timeline.")
    ? record.eventType.slice("timeline.".length)
    : "";
  const expectedKeys = MECHANICAL_TIMELINE_DETAIL_KEYS.get(type);
  if (
    expectedKeys === undefined ||
    !isDeepStrictEqual(record.tags, ["timeline", type])
  ) {
    return null;
  }
  return type;
}

function mechanicalTimelineProjection(record, type) {
  const expectedKeys = MECHANICAL_TIMELINE_DETAIL_KEYS.get(type);
  let content;
  try {
    content = JSON.parse(record.content);
  } catch {
    return null;
  }
  const contentKeys = sortedKeys(content);
  const canonical = isDeepStrictEqual(contentKeys, ["details"]);
  const details = canonical ? content.details : content;
  if (!isDeepStrictEqual(sortedKeys(details), [...expectedKeys].sort())) {
    return null;
  }
  const identity = {
    source: record.source,
    occurredAt: record.occurredAt,
    roleId: record.roleId,
    repository: record.repository,
    eventType: record.eventType,
    title: record.title,
    summary: record.summary,
    details,
    evidence: record.evidence,
    tags: record.tags,
    sourceUrl: record.sourceUrl,
    subjectNumber: record.subjectNumber,
  };
  return { canonical, identity, identityDigest: digestValue(identity) };
}

function referencedCandidateIds(records, lifecycleAuthority, candidateIds) {
  const referenced = new Set(
    [...lifecycleProtectedRecordIds(lifecycleAuthority)].filter((recordId) =>
      candidateIds.has(recordId)
    ),
  );
  for (const record of records) {
    const serialized = JSON.stringify(record);
    for (const match of serialized.matchAll(MEMORY_RECORD_REFERENCE)) {
      const recordId = match[0];
      if (
        recordId !== record.recordId &&
        candidateIds.has(recordId)
      ) {
        referenced.add(recordId);
      }
    }
  }
  return referenced;
}

function duplicateMechanicalTimelineRecordIds(records, lifecycleAuthority) {
  const projectionsBySource = new Map();
  for (const record of records) {
    const type = mechanicalTimelineType(record);
    if (type === null) continue;
    const sourceKey = `${type}\u0000${record.source.id}`;
    const projections = projectionsBySource.get(sourceKey) ?? [];
    projections.push({ record, type });
    projectionsBySource.set(sourceKey, projections);
  }
  const groupsByDigest = new Map();
  for (const sourceProjections of projectionsBySource.values()) {
    if (sourceProjections.length < 2) continue;
    for (const { record, type } of sourceProjections) {
      const projection = mechanicalTimelineProjection(record, type);
      if (projection === null) continue;
      const digestGroups = groupsByDigest.get(projection.identityDigest) ?? [];
      let group = digestGroups.find(({ identity }) =>
        isDeepStrictEqual(identity, projection.identity)
      );
      if (group === undefined) {
        group = { identity: projection.identity, projections: [] };
        digestGroups.push(group);
        groupsByDigest.set(projection.identityDigest, digestGroups);
      }
      group.projections.push({ record, canonical: projection.canonical });
    }
  }
  const duplicateGroups = [...groupsByDigest.values()]
    .flat()
    .filter(({ projections }) => projections.length > 1);
  if (duplicateGroups.length === 0) return new Set();
  const candidateIds = new Set(duplicateGroups.flatMap(({ projections }) =>
    projections.map(({ record }) => record.recordId)
  ));
  const referenced = referencedCandidateIds(
    records,
    lifecycleAuthority,
    candidateIds,
  );
  const result = new Set();
  for (const { projections } of duplicateGroups) {
    projections.sort((left, right) =>
      Number(right.canonical) - Number(left.canonical) ||
      right.record.recordId.localeCompare(left.record.recordId, "en")
    );
    for (const { record } of projections.slice(1)) {
      if (!referenced.has(record.recordId)) result.add(record.recordId);
    }
  }
  return result;
}

function projectionNoiseRecordIds(records, lifecycleAuthority) {
  const result = nonCitableHistoryRecordIds(records, lifecycleAuthority);
  for (const recordId of duplicateMechanicalTimelineRecordIds(
    records,
    lifecycleAuthority,
  )) {
    result.add(recordId);
  }
  return result;
}

function overJournalCapacity(journal, stateBytes, limits) {
  return journal.records.length > limits.maximumRecords ||
    stateBytes > limits.maximumStateBytes;
}

function prepareJournalCandidate(
  candidate,
  limits,
  { compactProjectionNoise = false } = {},
) {
  let records = candidate.records;
  const initialCompactionIds = compactProjectionNoise
    ? projectionNoiseRecordIds(records, candidate.lifecycleAuthority)
    : new Set();
  if (initialCompactionIds.size > 0) {
    records = records.filter(
      ({ recordId }) => !initialCompactionIds.has(recordId),
    );
  }
  let journal = { ...candidate, records };
  let stateBytes = journal.records.length > limits.maximumRecords
    ? Number.POSITIVE_INFINITY
    : serializedBytes(journal);
  if (overJournalCapacity(journal, stateBytes, limits)) {
    const compactableIds = projectionNoiseRecordIds(
      journal.records,
      journal.lifecycleAuthority,
    );
    if (compactableIds.size > 0) {
      journal = {
        ...journal,
        records: journal.records.filter(
          ({ recordId }) => !compactableIds.has(recordId),
        ),
      };
      stateBytes = serializedBytes(journal);
    }
  }
  return { journal, stateBytes };
}

function capacityRatio(used, maximum) {
  return Math.round((used / maximum) * 10_000) / 10_000;
}

function newestFirst(left, right) {
  return (
    right.occurredAt.localeCompare(left.occurredAt, "en") ||
    right.recordId.localeCompare(left.recordId, "en")
  );
}

function candidateIds(index, q, indexComplete) {
  if (!indexComplete) return null;
  const tokens = [...indexTokens(q).tokens];
  if (!tokens.length) return null;
  let candidates = null;
  for (const token of tokens) {
    const ids = new Set(index.get(token) || []);
    candidates = candidates === null
      ? ids
      : new Set([...candidates].filter((id) => ids.has(id)));
    if (!candidates.size) break;
  }
  return candidates;
}

function hasReservedLifecycleAuthority(record) {
  return (
    RESERVED_WORK_SOURCES.has(record.source.kind) ||
    record.evidence.some((entry) =>
      entry.startsWith("supersedes:") ||
      entry.startsWith(WORK_ITEM_REVISION_SUPERSESSION) ||
      entry.startsWith(WORK_GRAPH_SOURCE_SUPERSESSION) ||
      entry.startsWith(WORK_AUTHORITY_BINDING_SUPERSESSION)
    )
  );
}

function requiresLiveLedgerAuthority(record) {
  if (RESERVED_WORK_SOURCES.has(record.source.kind)) {
    return true;
  }
  if (
    record.evidence.some((entry) =>
      entry.startsWith(WORK_ITEM_REVISION_SUPERSESSION) ||
      entry.startsWith(WORK_GRAPH_SOURCE_SUPERSESSION) ||
      entry.startsWith(WORK_AUTHORITY_BINDING_SUPERSESSION)
    )
  ) {
    return true;
  }
  return false;
}

function projectionRecord(record) {
  const invalid = () => memoryError(
    "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
    "可信工作历史投影无效",
    409,
  );
  if (AUTHORITY_BOUND_PROJECTION_SOURCES.has(record.source.kind)) {
    let content;
    try {
      content = JSON.parse(record.content);
    } catch {
      throw invalid();
    }
    let authority;
    try {
      authority = exact(
        content?.authority,
        ["applies", "current", "bindingDigest", "inputBinding"],
        "memory projection authority",
      );
    } catch {
      throw invalid();
    }
    const obsolete = record.tags.includes("obsolete");
    const eventPrefix = `${record.source.kind.replaceAll("-", "_")}.`;
    const forbidden = new Set([
      "credential",
      "credentials",
      "header",
      "headers",
      "body",
      "localPath",
      "absolutePath",
    ]);
    const safeTree = (value, depth = 0) => {
      if (depth > 24) return false;
      if (Array.isArray(value)) {
        return value.every((entry) => safeTree(entry, depth + 1));
      }
      if (value === null || typeof value !== "object") return true;
      return Object.keys(value).every(
        (key) => !forbidden.has(key) && safeTree(value[key], depth + 1),
      );
    };
    const supersessions = record.evidence.filter((entry) =>
      entry.startsWith("supersedes:")
    );
    if (
      content === null ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      content.memoryType !== record.source.kind ||
      typeof authority.applies !== "boolean" ||
      typeof authority.current !== "boolean" ||
      obsolete === authority.current ||
      record.tags[0] !== record.source.kind ||
      record.tags.includes("derived") ||
      !record.eventType.startsWith(eventPrefix) ||
      record.sourceUrl !== null ||
      supersessions.length > 1 ||
      supersessions.some((entry) =>
        !MEMORY_RECORD_ID.test(entry.slice("supersedes:".length))
      ) ||
      !safeTree(content)
    ) {
      throw invalid();
    }
    if (authority.applies) {
      let inputBinding;
      try {
        inputBinding = normalizePullRequestExecutionBinding(
          authority.inputBinding,
        );
      } catch {
        throw invalid();
      }
      if (
        !isDeepStrictEqual(authority.inputBinding, inputBinding) ||
        typeof authority.bindingDigest !== "string" ||
        !SHA256.test(authority.bindingDigest) ||
        authority.bindingDigest !== digestValue(inputBinding)
      ) {
        throw invalid();
      }
    } else if (
      authority.inputBinding !== null ||
      authority.bindingDigest !== null ||
      ["confirmation", "external-result"].includes(record.source.kind)
    ) {
      throw invalid();
    }
    return record;
  }
  if (record.source.kind === "legacy-pr-memory") {
    if (
      record.roleId !== "pr-reviewer" ||
      !isDeepStrictEqual(
        record.tags,
        ["legacy", "pr-reviewer", "derived", "obsolete"],
      ) ||
      record.evidence.some((entry) =>
        entry.startsWith("supersedes:") ||
        entry.startsWith(WORK_ITEM_REVISION_SUPERSESSION) ||
        entry.startsWith(WORK_GRAPH_SOURCE_SUPERSESSION) ||
        entry.startsWith(WORK_AUTHORITY_BINDING_SUPERSESSION)
      )
    ) {
      throw invalid();
    }
    return record;
  }
  if (record.source.kind !== "work-timeline") throw invalid();
  const type = record.eventType.startsWith("timeline.")
    ? record.eventType.slice("timeline.".length)
    : "";
  let content;
  try {
    content = JSON.parse(record.content);
  } catch {
    throw invalid();
  }
  if (
    !type ||
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    record.evidence.length !== 0
  ) {
    throw invalid();
  }
  const historicalTags = ["timeline", type, "derived", "obsolete"];
  const currentTags = ["timeline", type];
  const pullRequestHistory = record.sourceUrl?.includes("/pull/") === true;
  if (pullRequestHistory) {
    if (
      !isDeepStrictEqual(record.tags, historicalTags) ||
      content.historicalOnly !== true ||
      content.citableConclusion !== false
    ) {
      throw invalid();
    }
  } else if (
    !isDeepStrictEqual(record.tags, currentTags) ||
    Object.hasOwn(content, "historicalOnly") ||
    Object.hasOwn(content, "citableConclusion")
  ) {
    throw invalid();
  }
  return record;
}

function workItemAttestation(record) {
  const match = record.source.kind === "work-item"
    ? record.source.id.match(WORK_ITEM_REVISION)
    : null;
  let sourceAuthority;
  try {
    sourceAuthority = normalizeWorkGraphSourceAuthority(
      JSON.parse(record.content)?.sourceAuthority,
    );
  } catch {
    throw memoryError(
      "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
      "work item 记忆缺少可信来源绑定",
      409,
    );
  }
  if (
    match === null ||
    record.evidence.length !== 1 ||
    record.evidence[0] !== `${WORK_ITEM_REVISION_SUPERSESSION}${match[1]}`
  ) {
    throw memoryError(
      "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
      "work item lifecycle marker 无效",
      409,
    );
  }
  return {
    recordId: record.recordId,
    contentDigest: record.contentDigest,
    itemId: match[1],
    revision: Number(match[2]),
    trusted: true,
    bindingDigest: sourceAuthority.bindingDigest,
    citable: sourceAuthority.citable,
  };
}

function graphReceiptForEvent(value) {
  const event = normalizeWorkGraphMemoryEvent(value);
  const receipt = workGraphMemoryRecordReceipt(event);
  return {
    event,
    record: normalizeMemoryRecord(event.memoryRecord),
    receipt: {
      schemaVersion: 2,
      eventSchemaVersion: event.schemaVersion,
      sequence: event.sequence,
      eventId: event.eventId,
      eventDigest: event.eventDigest,
      previousDigest: event.previousDigest,
      ledgerRevision: event.ledgerRevision,
      taskId: event.taskId,
      taskRevision: event.taskRevision,
      kind: event.kind,
      recordRevision: event.recordRevision,
      sourceRecordDigest: event.sourceRecordDigest,
      occurredAt: event.occurredAt,
      memoryRecordId: receipt.memoryRecordId,
      memoryRecordDigest: receipt.memoryRecordDigest,
      sourceAuthority: event.schemaVersion === 2
        ? structuredClone(event.sourceAuthority)
        : null,
      bindingDigest: event.schemaVersion === 2
        ? event.sourceAuthority.bindingDigest
        : null,
      citable: event.schemaVersion === 2
        ? event.sourceAuthority.citable
        : false,
      invalidatedBindingDigest: event.kind === "authority_invalidated"
        ? event.sourceAuthority.bindingDigest
        : null,
      authorityStateDigest: event.schemaVersion === 2
        ? event.authorityStateDigest
        : null,
    },
  };
}

function prepareAuthorityProjectionCommit(
  journal,
  value,
  adoptedPreviousEntries = [],
) {
  const input = exact(
    value,
    ["records", "projectionState"],
    "authority projection append",
  );
  if (
    !Object.hasOwn(input, "records") ||
    !Object.hasOwn(input, "projectionState")
  ) {
    throw memoryError(
      "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
      "权威记忆投影提交无效",
      409,
    );
  }
  const supplied = strictArray(
    input.records,
    journal.records.length + MAX_AUTHORITY_PROJECTION_ENTRIES,
    "records",
  );
  const records = supplied.map(normalizeMemoryRecord).map(projectionRecord);
  const recordsById = new Map(
    journal.records.map((record) => [record.recordId, record]),
  );
  for (const record of records) recordsById.set(record.recordId, record);
  let projectionState;
  try {
    projectionState = normalizeAuthorityProjection(
      input.projectionState,
      recordsById,
    );
  } catch (cause) {
    throw memoryError(
      "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
      "权威记忆投影 checkpoint 无效",
      409,
      cause,
    );
  }
  const previous = journal.lifecycleAuthority.authorityProjection;
  const nextEntryByRecordId = new Map(
    projectionState.entries.map((entry) => [entry.recordId, entry]),
  );
  const previousEntryByRecordId = new Map(
    [...previous.entries, ...adoptedPreviousEntries].map(
      (entry) => [entry.recordId, entry],
    ),
  );
  for (const record of records) {
    if (nextEntryByRecordId.has(record.recordId)) continue;
    let content;
    try {
      content = JSON.parse(record.content);
    } catch {
      content = null;
    }
    const supersessions = record.evidence.filter((entry) =>
      entry.startsWith("supersedes:")
    );
    const priorRecordId = supersessions.length === 1
      ? supersessions[0].slice("supersedes:".length)
      : null;
    if (
      content?.lifecycleOnly !== true ||
      content?.authority?.current !== false ||
      priorRecordId === null ||
      !previousEntryByRecordId.has(priorRecordId)
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "权威记忆记录未绑定投影 checkpoint",
        409,
      );
    }
  }
  const replay = projectionState.revision === previous.revision;
  if (
    (replay && !isDeepStrictEqual(projectionState, previous)) ||
    (!replay && projectionState.revision !== previous.revision + 1) ||
    projectionState.workLedgerRevision < previous.workLedgerRevision ||
    (projectionState.workLedgerRevision === previous.workLedgerRevision &&
      projectionState.authorityStateDigest !== previous.authorityStateDigest) ||
    projectionState.confirmationHighWatermark <
      previous.confirmationHighWatermark
  ) {
    throw memoryError(
      "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
      "权威记忆投影 checkpoint 不连续",
      409,
    );
  }
  assertAuthorityProjectionRetirements(previous, projectionState, records);
  return { records, projectionState };
}

function applyMemoryAuthorityProjectionCandidateCore(
  journal,
  value,
  options,
  adoptedProjectionState,
) {
  const limits = normalizeJournalLimits(options);
  const normalizedJournal = normalizeJournal(journal, limits);
  const adoptedPreviousEntries = adoptedProjectionState === null
    ? []
    : normalizeAuthorityProjection(
        adoptedProjectionState,
        new Map(
          normalizedJournal.records.map((record) => [record.recordId, record]),
        ),
      ).entries;
  const { records, projectionState } = prepareAuthorityProjectionCommit(
    normalizedJournal,
    value,
    adoptedPreviousEntries,
  );
  const recordsById = new Map(
    normalizedJournal.records.map((record) => [record.recordId, record]),
  );
  let added = 0;
  for (const record of records) {
    const existing = recordsById.get(record.recordId);
    if (existing !== undefined) {
      if (existing.contentDigest !== record.contentDigest) {
        throw memoryError("MEMORY_ID_CONFLICT", "统一记忆 ID 冲突", 409);
      }
      continue;
    }
    recordsById.set(record.recordId, record);
    added += 1;
  }
  const lifecycleAuthority = {
    ...normalizedJournal.lifecycleAuthority,
    authorityProjection: projectionState,
  };
  const authorityChanged = !isDeepStrictEqual(
    lifecycleAuthority,
    normalizedJournal.lifecycleAuthority,
  );
  if (!added && !authorityChanged) return normalizedJournal;
  const candidate = {
    schemaVersion: 2,
    revision: normalizedJournal.revision + 1,
    records: [...recordsById.values()],
    lifecycleAuthority,
  };
  const prepared = prepareJournalCandidate(candidate, limits);
  if (overJournalCapacity(prepared.journal, prepared.stateBytes, limits)) {
    throw memoryError(
      "MEMORY_CAPACITY_EXCEEDED",
      "统一记忆已达到本地容量上限",
      507,
    );
  }
  return normalizeJournal(prepared.journal, limits);
}

export function applyMemoryAuthorityProjectionCandidate(
  journal,
  value,
  options = {},
) {
  return applyMemoryAuthorityProjectionCandidateCore(
    journal,
    value,
    options,
    null,
  );
}

export function applyMemoryAuthorityProjectionAdoptionCandidate(
  journal,
  value,
  adoptedProjectionState,
  options = {},
) {
  return applyMemoryAuthorityProjectionCandidateCore(
    journal,
    value,
    options,
    adoptedProjectionState,
  );
}

export class LocalMemoryJournal {
  #store;
  #exclusiveLease;
  #operationQueue;
  #limits;
  #journal = emptyJournal();
  #recordsById = new Map();
  #supersededIds = new Set();
  #index = new Map();
  #indexComplete = true;
  #ready = false;
  #recovering = null;
  #lastIndexError = "";
  #stateBytes = serializedBytes(emptyJournal());
  #reclaimableRecordCount = 0;
  #postCommitYield;

  constructor({
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    maximumRecords = DEFAULT_MAX_RECORDS,
    maximumStateBytes = DEFAULT_MAX_STATE_BYTES,
    postCommitYield = DEFAULT_POST_COMMIT_YIELD,
  } = {}) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
      throw new TypeError("LocalMemoryJournal requires a durable store");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("LocalMemoryJournal requires an exclusive lease");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("operationQueue is invalid");
    }
    if (typeof postCommitYield !== "function") {
      throw new TypeError("postCommitYield must be a function");
    }
    this.#store = store;
    this.#exclusiveLease = exclusiveLease;
    this.#operationQueue = operationQueue;
    this.#postCommitYield = postCommitYield;
    this.#limits = Object.freeze({
      maximumRecords: positiveInteger(
        maximumRecords,
        "maximumRecords",
        100_000,
      ),
      maximumStateBytes: positiveInteger(
        maximumStateBytes,
        "maximumStateBytes",
        256 * 1024 * 1024,
      ),
    });
  }

  recover() {
    if (this.#ready) return Promise.resolve(this.getHealth());
    this.#recovering ||= this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        const stored = await this.#store.read(MEMORY_JOURNAL_KEY, null);
        let journal;
        try { journal = normalizeJournal(stored, this.#limits); }
        catch (error) {
          if (error?.code !== "MEMORY_JOURNAL_CORRUPTED") throw error;
          try {
            const recovered = retireOrphanedUnboundConsultations(stored);
            if (recovered === null) throw error;
            journal = normalizeJournal(recovered, this.#limits);
          } catch { throw error; }
          await this.#store.write(MEMORY_JOURNAL_KEY, journal);
        }
        const built = buildIndex(journal.records, journal.revision);
        const storedIndex = await this.#store.read(MEMORY_INDEX_KEY, null);
        this.#journal = journal;
        this.#recordsById = new Map(
          journal.records.map((record) => [record.recordId, record]),
        );
        this.#supersededIds = supersededRecordIds(
          journal.records,
          journal.lifecycleAuthority,
        );
        this.#stateBytes = serializedBytes(journal);
        this.#reclaimableRecordCount = projectionNoiseRecordIds(
          journal.records,
          journal.lifecycleAuthority,
        ).size;
        this.#index = built.tokenMap;
        this.#indexComplete = built.complete;
        this.#lastIndexError = "";
        if (!indexMatches(storedIndex, built.persisted)) {
          await this.#persistIndex(built.persisted);
        }
        this.#ready = true;
        return this.getHealth();
      }),
    );
    return this.#recovering.finally(() => {
      this.#recovering = null;
    });
  }

  append(value) {
    return this.appendBatch({ records: [value] }).then(({ items }) => items[0]);
  }

  appendBatch(value) {
    const input = exact(value, ["records"], "append batch");
    if (!Object.hasOwn(input, "records")) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const supplied = strictArray(input.records, MAX_BATCH, "records");
    if (!supplied.length) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const normalized = supplied.map(normalizeMemoryRecord);
    if (normalized.some(hasReservedLifecycleAuthority)) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
        "保留的工作记忆来源只能由可信台账投影写入",
        403,
      );
    }
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => this.#append(normalized)),
    );
  }

  appendWorkItems(value) {
    const includesGraphCheckpoint =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "graphCursor");
    const input = exact(
      value,
      [
        "records",
        "ledgerRevision",
        "authorityStateDigest",
        ...(includesGraphCheckpoint
          ? ["graphCursor", "graphCheckpointDigest"]
          : []),
      ],
      "work item append batch",
    );
    const ledgerRevision = nonNegativeInteger(
      input.ledgerRevision,
      "ledgerRevision",
    );
    const authorityStateDigest = optionalDigest(
      input.authorityStateDigest,
      "authorityStateDigest",
    );
    if (authorityStateDigest === null) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "authorityStateDigest 不能为空",
        409,
      );
    }
    const supplied = strictArray(
      input.records,
      MAX_WORK_ITEM_BATCH,
      "records",
    );
    const records = supplied.map(normalizeMemoryRecord);
    const attestations = records.map(workItemAttestation);
    const graphCursor = includesGraphCheckpoint
      ? nonNegativeInteger(input.graphCursor, "graphCursor")
      : null;
    const graphCheckpointDigest = includesGraphCheckpoint
      ? optionalDigest(input.graphCheckpointDigest, "graphCheckpointDigest")
      : null;
    if (
      includesGraphCheckpoint &&
      (graphCursor === 0) !== (graphCheckpointDigest === null)
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "graph checkpoint 无效",
        409,
      );
    }
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => {
        let authority = this.#journal.lifecycleAuthority;
        if (includesGraphCheckpoint) {
          if (
            authority.graphCursor === 0 &&
            authority.graphReceipts.length === 0
          ) {
            authority = {
              ...authority,
              baseCursor: graphCursor,
              baseCheckpointDigest: graphCheckpointDigest,
              graphCursor,
              graphCheckpointDigest,
            };
          } else if (
            authority.graphCursor !== graphCursor ||
            authority.graphCheckpointDigest !== graphCheckpointDigest
          ) {
            throw memoryError(
              "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
              "work item snapshot 与 graph checkpoint 不一致",
              409,
            );
          }
        }
        const byId = new Map(
          authority.workItemAttestations.map(
            (entry) => [entry.recordId, entry],
          ),
        );
        for (const attestation of attestations) {
          const existing = byId.get(attestation.recordId);
          if (existing !== undefined && !isDeepStrictEqual(existing, attestation)) {
            throw memoryError(
              "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
              "work item lifecycle attestation 冲突",
              409,
            );
          }
          byId.set(attestation.recordId, attestation);
        }
        return this.#append(records, {
          ...authority,
          authorityStateDigest,
          workLedgerRevision: ledgerRevision,
          workItemAttestations: [...byId.values()],
        });
      }),
    );
  }

  appendGraphEvents(value) {
    const input = exact(
      value,
      [
        "events",
        "ledgerRevision",
        "highWatermark",
        "authorityStateDigest",
      ],
      "graph event append batch",
    );
    const ledgerRevision = nonNegativeInteger(
      input.ledgerRevision,
      "ledgerRevision",
    );
    const authorityStateDigest = optionalDigest(
      input.authorityStateDigest,
      "authorityStateDigest",
    );
    const highWatermark = nonNegativeInteger(
      input.highWatermark,
      "highWatermark",
    );
    if (authorityStateDigest === null) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "authorityStateDigest 不能为空",
        409,
      );
    }
    const supplied = strictArray(input.events, MAX_BATCH, "events");
    if (supplied.length === 0) {
      throw memoryError("MEMORY_INPUT_INVALID", "events 不能为空");
    }
    const descriptors = supplied.map(graphReceiptForEvent);
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => this.#appendGraphEvents(
        descriptors,
        ledgerRevision,
        highWatermark,
        authorityStateDigest,
      )),
    );
  }

  appendProjectionRecords(value) {
    const input = exact(value, ["records"], "projection record append batch");
    const supplied = strictArray(input.records, MAX_BATCH, "records");
    if (supplied.length === 0) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const records = supplied.map(normalizeMemoryRecord);
    if (records.some(({ source }) =>
      AUTHORITY_BOUND_PROJECTION_SOURCES.has(source.kind)
    )) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
        "权威记忆必须与投影 checkpoint 原子提交",
        409,
      );
    }
    records.forEach(projectionRecord);
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        const discardedIds = new Set(
          records.filter(isNonCitableHistoryRecord).map(
            ({ recordId }) => recordId,
          ),
        );
        const retained = records.filter(
          ({ recordId }) => !discardedIds.has(recordId),
        );
        const result = await this.#append(
          retained,
          this.#journal.lifecycleAuthority,
          {
            compactProjectionNoise:
              this.#reclaimableRecordCount > 0,
          },
        );
        const receiptsById = new Map();
        for (const receipt of result.items) {
          const receipts = receiptsById.get(receipt.recordId) ?? [];
          receipts.push(receipt);
          receiptsById.set(receipt.recordId, receipts);
        }
        return {
          ...result,
          items: records.map((record) => {
            if (discardedIds.has(record.recordId)) {
              return { recordId: record.recordId, created: false };
            }
            return receiptsById.get(record.recordId).shift();
          }),
        };
      }),
    );
  }

  appendAuthorityProjection(value) {
    const input = exact(
      value,
      ["records", "projectionState"],
      "authority projection append",
    );
    if (
      !Object.hasOwn(input, "records") ||
      !Object.hasOwn(input, "projectionState")
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "权威记忆投影提交无效",
        409,
      );
    }
    const supplied = strictArray(
      input.records,
      this.#limits.maximumRecords,
      "records",
    );
    const records = supplied.map(normalizeMemoryRecord).map(projectionRecord);
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => {
        const recordsById = new Map(this.#recordsById);
        for (const record of records) recordsById.set(record.recordId, record);
        let projectionState;
        try {
          projectionState = normalizeAuthorityProjection(
            input.projectionState,
            recordsById,
          );
        } catch (cause) {
          throw memoryError(
            "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
            "权威记忆投影 checkpoint 无效",
            409,
            cause,
          );
        }
        const previous = this.#journal.lifecycleAuthority.authorityProjection;
        const nextEntryByRecordId = new Map(
          projectionState.entries.map((entry) => [entry.recordId, entry]),
        );
        const previousEntryByRecordId = new Map(
          previous.entries.map((entry) => [entry.recordId, entry]),
        );
        for (const record of records) {
          if (nextEntryByRecordId.has(record.recordId)) continue;
          let content;
          try {
            content = JSON.parse(record.content);
          } catch {
            content = null;
          }
          const supersessions = record.evidence.filter((entry) =>
            entry.startsWith("supersedes:")
          );
          const priorRecordId = supersessions.length === 1
            ? supersessions[0].slice("supersedes:".length)
            : null;
          if (
            content?.lifecycleOnly !== true ||
            content?.authority?.current !== false ||
            priorRecordId === null ||
            !previousEntryByRecordId.has(priorRecordId)
          ) {
            throw memoryError(
              "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
              "权威记忆记录未绑定投影 checkpoint",
              409,
            );
          }
        }
        const replay = projectionState.revision === previous.revision;
        if (
          (replay && !isDeepStrictEqual(projectionState, previous)) ||
          (!replay && projectionState.revision !== previous.revision + 1) ||
          projectionState.workLedgerRevision < previous.workLedgerRevision ||
          (projectionState.workLedgerRevision === previous.workLedgerRevision &&
            projectionState.authorityStateDigest !==
              previous.authorityStateDigest) ||
          projectionState.confirmationHighWatermark <
            previous.confirmationHighWatermark
        ) {
          throw memoryError(
            "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
            "权威记忆投影 checkpoint 不连续",
            409,
          );
        }
        assertAuthorityProjectionRetirements(previous, projectionState, records);
        return this.#append(records, {
          ...this.#journal.lifecycleAuthority,
          authorityProjection: projectionState,
        });
      }),
    );
  }

  appendCorrections(value) {
    const input = exact(value, ["records"], "correction append batch");
    const supplied = strictArray(input.records, MAX_BATCH, "records");
    if (supplied.length === 0) {
      throw memoryError("MEMORY_INPUT_INVALID", "records 不能为空");
    }
    const records = supplied.map(normalizeMemoryRecord);
    if (
      records.some((record) =>
        RESERVED_WORK_SOURCES.has(record.source.kind) ||
        !record.evidence.some((entry) => {
          if (!entry.startsWith("supersedes:")) return false;
          return MEMORY_RECORD_ID.test(entry.slice("supersedes:".length));
        })
      )
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "可信纠错记录无效",
        409,
      );
    }
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => this.#append(records)),
    );
  }

  adoptGraphCheckpoint(value) {
    const input = exact(
      value,
      [
        "cursor",
        "checkpointDigest",
        "ledgerRevision",
        "authorityStateDigest",
      ],
      "graph checkpoint adoption",
    );
    const cursor = nonNegativeInteger(input.cursor, "cursor");
    const checkpointDigest = optionalDigest(
      input.checkpointDigest,
      "checkpointDigest",
    );
    const ledgerRevision = nonNegativeInteger(
      input.ledgerRevision,
      "ledgerRevision",
    );
    const authorityStateDigest = optionalDigest(
      input.authorityStateDigest,
      "authorityStateDigest",
    );
    if (
      (cursor === 0) !== (checkpointDigest === null) ||
      authorityStateDigest === null
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
        "graph checkpoint adoption 无效",
        409,
      );
    }
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(() => {
        const authority = this.#journal.lifecycleAuthority;
        if (authority.graphCursor !== 0 || authority.graphReceipts.length > 0) {
          if (
            authority.graphCursor === cursor &&
            authority.graphCheckpointDigest === checkpointDigest
          ) {
            return this.getAuthorityState();
          }
          throw memoryError(
            "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
            "graph checkpoint 已由其他事件链占用",
            409,
          );
        }
        return this.#persistAuthority({
          ...authority,
          baseCursor: cursor,
          baseCheckpointDigest: checkpointDigest,
          graphCursor: cursor,
          graphCheckpointDigest: checkpointDigest,
          authorityStateDigest,
          workLedgerRevision: ledgerRevision,
        }).then(() => this.getAuthorityState());
      }),
    );
  }

  getAuthorityState() {
    this.#assertReady();
    const authority = this.#journal.lifecycleAuthority;
    return Object.freeze({
      cursor: authority.graphCursor,
      checkpointDigest: authority.graphCheckpointDigest,
      authorityStateDigest: authority.authorityStateDigest,
      workLedgerRevision: authority.workLedgerRevision,
    });
  }

  getAuthorityProjectionState() {
    this.#assertReady();
    return structuredClone(this.#journal.lifecycleAuthority.authorityProjection);
  }

  requiresLiveAuthority() {
    this.#assertReady();
    const authority = this.#journal.lifecycleAuthority;
    return (
      authority.graphReceipts.length > 0 ||
      authority.workItemAttestations.length > 0 ||
      this.#journal.records.some(requiresLiveLedgerAuthority)
    );
  }

  requiresAuthorityProjectionCheckpoint() {
    this.#assertReady();
    const projection = this.#journal.lifecycleAuthority.authorityProjection;
    return projection.entries.length > 0 || this.#journal.records.some(
      ({ source }) => AUTHORITY_BOUND_PROJECTION_SOURCES.has(source.kind),
    );
  }

  getHealth() {
    this.#assertReady();
    const recordCapacityRatio = capacityRatio(
      this.#journal.records.length,
      this.#limits.maximumRecords,
    );
    const stateCapacityRatio = capacityRatio(
      this.#stateBytes,
      this.#limits.maximumStateBytes,
    );
    return Object.freeze({
      ready: true,
      revision: this.#journal.revision,
      recordCount: this.#journal.records.length,
      maximumRecords: this.#limits.maximumRecords,
      stateBytes: this.#stateBytes,
      maximumStateBytes: this.#limits.maximumStateBytes,
      recordCapacityRatio,
      stateCapacityRatio,
      capacityWarning:
        recordCapacityRatio >= CAPACITY_WARNING_RATIO ||
        stateCapacityRatio >= CAPACITY_WARNING_RATIO,
      reclaimableRecordCount: this.#reclaimableRecordCount,
      indexHealthy: !this.#lastIndexError,
      lastIndexError: this.#lastIndexError,
    });
  }

  search(value = {}) {
    this.#assertReady();
    const options = queryOptions(value);
    const candidates = candidateIds(
      this.#index,
      options.q,
      this.#indexComplete,
    );
    const queryTerms = lexicalTerms(options.q);
    const cursor = options.cursor;
    const matched = this.#journal.records
      .filter((record) => !candidates || candidates.has(record.recordId))
      .filter((record) => !options.roleId || record.roleId === options.roleId)
      .filter(
        (record) => !options.repository || record.repository === options.repository,
      )
      .filter(
        (record) => !options.eventType || record.eventType === options.eventType,
      )
      .filter(
        (record) => !options.from || record.occurredAt >= options.from,
      )
      .filter((record) => !options.to || record.occurredAt <= options.to)
      .filter((record) => {
        const haystack = recordText(record);
        return queryTerms.every((term) => haystack.includes(term));
      })
      .sort(newestFirst);
    const available = matched.filter(
      (record) => !cursor || newestFirst(record, cursor) > 0,
    );
    const selected = available.slice(0, options.limit);
    return {
      items: selected.map(projectMemoryRecord),
      nextCursor:
        available.length > selected.length && selected.length
          ? encodeCursor(selected.at(-1))
          : null,
      totalMatched: matched.length,
      indexHealthy: !this.#lastIndexError,
    };
  }

  readRecords(value) {
    this.#assertReady();
    const recordIds = readRecordIds(value);
    if (recordIds.some((recordId) => !this.#recordsById.has(recordId))) {
      throw memoryError(
        "MEMORY_RECORD_NOT_FOUND",
        "指定的统一记忆记录不存在",
        404,
      );
    }
    return structuredClone({
      journalRevision: this.#journal.revision,
      items: recordIds.map((recordId) => {
        const record = this.#recordsById.get(recordId);
        return {
          record,
          labels: recordLabels(record, this.#supersededIds),
        };
      }),
    });
  }

  verifyReceipt(value) {
    this.#assertReady();
    const expected = receiptReference(value);
    const record = this.#recordsById.get(expected.recordId);
    if (
      record?.contentDigest !== expected.contentDigest ||
      record.source.kind !== expected.source.kind ||
      record.source.id !== expected.source.id
    ) {
      throw receiptUnverified();
    }
    return structuredClone({ ...expected, persisted: true });
  }

  rebuildIndex() {
    this.#assertReady();
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        const built = buildIndex(
          this.#journal.records,
          this.#journal.revision,
        );
        await this.#store.write(MEMORY_INDEX_KEY, built.persisted);
        this.#index = built.tokenMap;
        this.#indexComplete = built.complete;
        this.#lastIndexError = "";
        return this.getHealth();
      }),
    );
  }

  async #appendGraphEvents(
    descriptors,
    ledgerRevision,
    highWatermark,
    authorityStateDigest,
  ) {
    this.#assertReady();
    const authority = this.#journal.lifecycleAuthority;
    const receiptsBySequence = new Map(
      authority.graphReceipts.map((receipt) => [receipt.sequence, receipt]),
    );
    const graphReceipts = [...authority.graphReceipts];
    const receiptRecordIds = new Set(
      graphReceipts.map(({ memoryRecordId }) => memoryRecordId),
    );
    let cursor = authority.graphCursor;
    let checkpointDigest = authority.graphCheckpointDigest;
    for (const { receipt } of descriptors) {
      if (receipt.sequence <= cursor) {
        if (!isDeepStrictEqual(receiptsBySequence.get(receipt.sequence), receipt)) {
          throw memoryError(
            "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
            "graph event replay 与持久摘要链不一致",
            409,
          );
        }
        continue;
      }
      if (
        receipt.sequence !== cursor + 1 ||
        receipt.previousDigest !== checkpointDigest ||
        receiptRecordIds.has(receipt.memoryRecordId)
      ) {
        throw memoryError(
          "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
          "graph event sequence 或 digest 链不连续",
          409,
        );
      }
      graphReceipts.push(receipt);
      receiptRecordIds.add(receipt.memoryRecordId);
      receiptsBySequence.set(receipt.sequence, receipt);
      cursor = receipt.sequence;
      checkpointDigest = receipt.eventDigest;
    }
    const highWatermarkReceipt = graphReceipts.at(-1) ?? null;
    if (
      cursor > highWatermark ||
      (cursor === highWatermark &&
        highWatermarkReceipt?.authorityStateDigest !== authorityStateDigest &&
        !(
          highWatermarkReceipt?.authorityStateDigest === null &&
          authorityStateDigest === emptyLifecycleAuthority().authorityStateDigest
        ))
    ) {
      throw memoryError(
        "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
        "graph high-watermark authority digest 不一致",
        409,
      );
    }
    return this.#append(
      descriptors.map(({ record }) => record),
      {
        ...authority,
        graphCursor: cursor,
        graphCheckpointDigest: checkpointDigest,
        authorityStateDigest,
        workLedgerRevision: ledgerRevision,
        graphReceipts,
      },
    );
  }

  async #persistAuthority(lifecycleAuthority) {
    await this.#append([], lifecycleAuthority);
  }

  async #append(
    records,
    lifecycleAuthority = this.#journal.lifecycleAuthority,
    { compactProjectionNoise = false } = {},
  ) {
    this.#assertReady();
    const initialById = this.#recordsById;
    const byId = new Map(this.#recordsById);
    const requestedCreations = [];
    for (const record of records) {
      const existing = byId.get(record.recordId);
      if (existing) {
        if (existing.contentDigest !== record.contentDigest) {
          throw memoryError("MEMORY_ID_CONFLICT", "统一记忆 ID 冲突", 409);
        }
        requestedCreations.push(false);
        continue;
      }
      byId.set(record.recordId, record);
      requestedCreations.push(true);
    }
    const authorityChanged = !isDeepStrictEqual(
      lifecycleAuthority,
      this.#journal.lifecycleAuthority,
    );
    if (
      !requestedCreations.some(Boolean) &&
      !authorityChanged &&
      !compactProjectionNoise
    ) {
      const receipts = records.map(({ recordId }) => ({
        recordId,
        created: false,
      }));
      return { added: 0, items: structuredClone(receipts), health: this.getHealth() };
    }
    const prepared = prepareJournalCandidate({
      schemaVersion: 2,
      revision: this.#journal.revision + 1,
      records: [...byId.values()],
      lifecycleAuthority,
    }, this.#limits, { compactProjectionNoise });
    if (overJournalCapacity(
      prepared.journal,
      prepared.stateBytes,
      this.#limits,
    )) {
      throw memoryError(
        "MEMORY_CAPACITY_EXCEEDED",
        "统一记忆已达到本地容量上限",
        507,
      );
    }
    const persistedById = new Map(
      prepared.journal.records.map((record) => [record.recordId, record]),
    );
    const receipts = records.map((record, index) => ({
      recordId: record.recordId,
      created:
        requestedCreations[index] && persistedById.has(record.recordId),
    }));
    const added = receipts.filter(({ created }) => created).length;
    const recordsChanged = persistedById.size !== initialById.size ||
      [...persistedById.keys()].some((recordId) => !initialById.has(recordId));
    if (!recordsChanged && !authorityChanged) {
      return { added, items: structuredClone(receipts), health: this.getHealth() };
    }
    await this.#store.write(MEMORY_JOURNAL_KEY, prepared.journal);
    this.#journal = prepared.journal;
    this.#recordsById = persistedById;
    this.#stateBytes = prepared.stateBytes;
    this.#supersededIds = supersededRecordIds(
      prepared.journal.records,
      prepared.journal.lifecycleAuthority,
    );
    this.#reclaimableRecordCount = projectionNoiseRecordIds(
      prepared.journal.records,
      prepared.journal.lifecycleAuthority,
    ).size;
    const built = buildIndex(
      prepared.journal.records,
      prepared.journal.revision,
    );
    this.#index = built.tokenMap;
    this.#indexComplete = built.complete;
    this.#lastIndexError = "";
    await this.#persistIndex(built.persisted);
    await this.#yieldAfterCommit();
    return {
      added,
      items: structuredClone(receipts),
      health: this.getHealth(),
    };
  }

  async #persistIndex(value) {
    try {
      await this.#store.write(MEMORY_INDEX_KEY, value);
    } catch (error) {
      this.#lastIndexError = String(error?.message || error).slice(0, 1_024);
    }
  }

  #assertReady() {
    if (!this.#ready) {
      throw memoryError(
        "MEMORY_NOT_READY",
        "统一记忆尚未恢复",
        503,
      );
    }
  }

  async #yieldAfterCommit() {
    try {
      await this.#postCommitYield();
    } catch {
      // Fair scheduling is non-authoritative and cannot invalidate a committed write.
    }
  }
}
