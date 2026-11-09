import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { createWorkGraphMemoryEvent } from "../src/domain/work-graph-memory-event.js";
import {
  LocalMemoryJournal,
  MEMORY_INDEX_KEY,
  MEMORY_JOURNAL_KEY,
} from "../src/services/local-memory-journal.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function record(index, overrides = {}) {
  return {
    schemaVersion: 1,
    source: { kind: "work-ledger", id: `work-${index}:event` },
    occurredAt: `2026-08-02T01:02:${String(index).padStart(2, "0")}.000Z`,
    roleId: index % 2 ? "requirements-analyst" : "developer",
    repository: index === 3 ? "other/repo" : "acme/repo",
    eventType: index % 2 ? "requirements.clarified" : "work.completed",
    title: index === 1 ? "梳理结算失败路径" : `工作记录 ${index}`,
    summary: index === 2 ? "修复失败路径并完成验证" : "本地员工工作结论",
    content: "所有原始记录和索引均保存在本机。",
    evidence: [`evidence-${index}`],
    tags: [index % 2 ? "requirements" : "development"],
    sourceUrl: null,
    subjectNumber: null,
    ...overrides,
  };
}

function batchRecords(count) {
  return Array.from({ length: count }, (_, index) =>
    record(index + 1, {
      source: { kind: "local-session", id: `session:chunk:${index + 1}` },
      occurredAt: "2026-08-02T01:02:00.000Z",
      title: `会话分片 ${index + 1}`,
    })
  );
}

function memoryStore({ failIndexWrites = false } = {}) {
  const values = new Map();
  const reads = [];
  const writes = [];
  return {
    values,
    reads,
    writes,
    async read(key, fallback = null) {
      reads.push(key);
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      if (failIndexWrites && key === MEMORY_INDEX_KEY) {
        throw new Error("index disk unavailable");
      }
      writes.push(key);
      values.set(key, structuredClone(value));
    },
  };
}

const lease = { async run(operation) { return operation(); } };
const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");
const NON_PR_SOURCE_AUTHORITY = Object.freeze({
  applies: false,
  citable: true,
  bindingDigest: null,
  executionBinding: null,
  provenance: null,
});

function pullRequestExecutionBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: 42,
    rootItemId: "work-item-pr-42",
    workKey: "pr:acme/repo#42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "a".repeat(40),
    eventId: "github:pull-request:acme/repo#42:head-1",
    eventDigest: "b".repeat(64),
    inputDigest: "c".repeat(64),
  };
}

function authorityProjectionRecord(kind, authority) {
  const authorityBinding = authority.inputBinding ?? null;
  return record(1, {
    source: { kind, id: `${kind}:fixture` },
    eventType: `${kind.replaceAll("-", "_")}.fixture`,
    content: JSON.stringify({
      memoryType: kind,
      ...(kind === "confirmation"
        ? { action: { inputBinding: authorityBinding } }
        : {}),
      ...(kind === "external-result"
        ? { inputBinding: authorityBinding }
        : {}),
      authority,
    }),
    evidence: [],
    tags: [kind, "fixture", ...(authority.current ? [] : ["obsolete"])],
    sourceUrl: null,
    subjectNumber: 42,
  });
}

function authorityProjectionCommit(records, {
  revision = 1,
  confirmationHighWatermark = 0,
} = {}) {
  const normalized = records.map(normalizeMemoryRecord);
  return {
    records,
    projectionState: {
      schemaVersion: 4,
      revision,
      workLedgerRevision: 0,
      authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
      confirmationHighWatermark,
      entries: normalized.map((record, index) => {
        const authority = JSON.parse(record.content).authority;
        return {
          key: `${record.source.kind}:fixture:${index + 1}`,
          fingerprint: digestValue({ recordId: record.recordId }),
          recordId: record.recordId,
          sourceKind: record.source.kind,
          binding: authority.inputBinding,
          current: authority.current,
          occurredAt: record.occurredAt,
        };
      }),
    },
  };
}

function trustedWorkRecord(index, { revision = index, status = "queued", ...overrides } = {}) {
  const itemId = overrides.itemId ?? "work-item-local";
  delete overrides.itemId;
  return record(index, {
    source: { kind: "work-item", id: `${itemId}:revision:${revision}` },
    eventType: `work.${status}`,
    content: JSON.stringify({ status, sourceAuthority: NON_PR_SOURCE_AUTHORITY }),
    evidence: [`supersedes-work-item-revisions:${itemId}`],
    tags: ["work", status],
    ...overrides,
  });
}

async function appendTrustedWork(journal, records, ledgerRevision = 1) {
  return journal.appendWorkItems({
    records,
    ledgerRevision,
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
  });
}

function graphFixtureItem() {
  return {
    itemId: "work-item-graph-receipt",
    revision: 1,
    event: {
      eventType: "issue.observed",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: {
        id: "github:issue:acme/repo#42",
        repository: "acme/repo",
        number: 42,
      },
      payload: { title: "Graph receipt fixture" },
    },
    graph: {
      acceptanceContracts: [{
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: "2026-08-02T01:00:00.000Z",
      }],
      deliveries: [],
    },
  };
}

async function fixture(options = {}) {
  const store = options.store || memoryStore();
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: lease,
    ...(options.maximumRecords ? { maximumRecords: options.maximumRecords } : {}),
    ...(options.postCommitYield ? { postCommitYield: options.postCommitYield } : {}),
  });
  await journal.recover();
  return { store, journal };
}

test("journal append is durable, content-idempotent, and persists a separate index", async () => {
  const { store, journal } = await fixture();
  const first = await journal.append(record(1));
  const duplicate = await journal.append(record(1));
  const batch = await journal.appendBatch({ records: [record(2), record(3)] });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(batch.added, 2);
  assert.equal(journal.getHealth().recordCount, 3);
  assert.equal(store.values.get(MEMORY_JOURNAL_KEY).records.length, 3);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).journalRevision, 2);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).complete, true);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).entries["失败"].length, 2);
});

test("a committed memory append yields after publishing journal and index state", async () => {
  const yieldStarted = deferred();
  const releaseYield = deferred();
  const { store, journal } = await fixture({
    postCommitYield: async () => {
      yieldStarted.resolve();
      await releaseYield.promise;
    },
  });

  const append = journal.append(record(1));
  await yieldStarted.promise;
  let appendSettled = false;
  append.finally(() => {
    appendSettled = true;
  });
  await Promise.resolve();

  assert.equal(store.values.get(MEMORY_JOURNAL_KEY).records.length, 1);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).journalRevision, 1);
  assert.equal(journal.getHealth().recordCount, 1);
  assert.equal(appendSettled, false);

  releaseYield.resolve();
  await append;
});

test("local search supports Chinese keywords, filters, newest order, and stable cursors", async () => {
  const { journal } = await fixture();
  await journal.appendBatch({ records: [record(1), record(2), record(3)] });

  const chinese = journal.search({ q: "失败路径", repository: "acme/repo" });
  assert.deepEqual(chinese.items.map(({ title }) => title), [
    "工作记录 2",
    "梳理结算失败路径",
  ]);
  const filtered = journal.search({
    roleId: "requirements-analyst",
    eventType: "requirements.clarified",
  });
  assert.deepEqual(filtered.items.map(({ title }) => title), [
    "工作记录 3",
    "梳理结算失败路径",
  ]);
  const firstPage = journal.search({ limit: 2 });
  const secondPage = journal.search({ limit: 2, cursor: firstPage.nextCursor });
  assert.deepEqual(firstPage.items.map(({ title }) => title), [
    "工作记录 3",
    "工作记录 2",
  ]);
  assert.deepEqual(secondPage.items.map(({ title }) => title), [
    "梳理结算失败路径",
  ]);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(firstPage.totalMatched, 3);
  assert.equal(secondPage.totalMatched, 3);
});

test("authoritative context reads preserve order and derive trusted labels without writes", async () => {
  const { store, journal } = await fixture();
  const raw = await journal.append(record(1, {
    content: "raw record that merely mentions derived",
    evidence: ["derived"],
    tags: ["requirements"],
  }));
  const derived = (await journal.appendCorrections({ records: [record(2, {
    content: "derived conclusion",
    evidence: [`supersedes:${raw.recordId}`],
    tags: ["derived"],
  })] })).items[0];
  const explicitlyObsolete = await journal.append(record(3, {
    evidence: [`note:supersedes:${derived.recordId}`],
    tags: ["obsolete"],
  }));
  const readsBefore = store.reads.length;
  const writesBefore = store.writes.length;

  const result = journal.readRecords({
    recordIds: [derived.recordId, raw.recordId, explicitlyObsolete.recordId],
  });

  assert.equal(result.journalRevision, 3);
  assert.deepEqual(
    result.items.map(({ record: value }) => value.recordId),
    [derived.recordId, raw.recordId, explicitlyObsolete.recordId],
  );
  assert.deepEqual(result.items.map(({ labels }) => labels), [
    { authority: "derived", lifecycle: "current" },
    { authority: "raw", lifecycle: "obsolete" },
    { authority: "raw", lifecycle: "obsolete" },
  ]);
  assert.equal(result.items[0].record.content, "derived conclusion");
  assert.equal(
    result.items[0].record.contentDigest,
    derived.recordId.slice("memory-".length),
  );
  assert.equal(store.reads.length, readsBefore);
  assert.equal(store.writes.length, writesBefore);

  result.items[0].record.content = "changed by caller";
  result.items[0].record.source.id = "changed-source";
  result.items[0].labels.lifecycle = "obsolete";
  const repeated = journal.readRecords({ recordIds: [derived.recordId] });
  assert.equal(repeated.items[0].record.content, "derived conclusion");
  assert.equal(repeated.items[0].record.source.id, record(2).source.id);
  assert.deepEqual(repeated.items[0].labels, {
    authority: "derived",
    lifecycle: "current",
  });
});

test("a corrected raw fact supersedes a derived summary without deleting history", async () => {
  const { journal } = await fixture();
  const derived = await journal.append(record(1, {
    summary: "模型推断测试已经通过",
    tags: ["derived"],
  }));
  const correction = (await journal.appendCorrections({ records: [record(2, {
    summary: "原始测试记录显示失败",
    evidence: [`supersedes:${derived.recordId}`, "test:failed"],
    tags: ["testing"],
  })] })).items[0];

  const result = journal.readRecords({
    recordIds: [derived.recordId, correction.recordId],
  });

  assert.equal(journal.getHealth().recordCount, 2);
  assert.deepEqual(result.items.map(({ labels }) => labels), [
    { authority: "derived", lifecycle: "obsolete" },
    { authority: "raw", lifecycle: "current" },
  ]);
  assert.equal(result.items[0].record.summary, "模型推断测试已经通过");
  assert.equal(result.items[1].record.summary, "原始测试记录显示失败");
});

test("new work-item revisions obsolete every older persisted revision across replay and restart", async () => {
  const store = memoryStore();
  const first = await fixture({ store });
  const workRevision = (revision) => trustedWorkRecord(revision, {
    itemId: "work-item-pr-42",
    revision,
    occurredAt: `2026-08-02T02:00:0${revision}.000Z`,
  });
  const revision1 = (await appendTrustedWork(first.journal, [workRevision(1)], 1)).items[0];
  const revision3 = (await appendTrustedWork(first.journal, [workRevision(3)], 3)).items[0];
  const revision2 = (await appendTrustedWork(first.journal, [workRevision(2)], 3)).items[0];

  assert.deepEqual(
    first.journal.readRecords({
      recordIds: [revision1.recordId, revision2.recordId, revision3.recordId],
    }).items.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete", "current"],
  );

  const recovered = await fixture({ store });
  assert.deepEqual(
    recovered.journal.readRecords({
      recordIds: [revision1.recordId, revision2.recordId, revision3.recordId],
    }).items.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete", "current"],
  );
});

test("one trusted commit atomically adopts a graph checkpoint and more than 160 work items", async () => {
  const store = memoryStore();
  const { journal } = await fixture({ store });
  const records = Array.from({ length: 161 }, (_, index) =>
    trustedWorkRecord(index + 1, {
      itemId: `bulk-work-${index + 1}`,
      revision: 1,
      occurredAt: "2026-08-02T02:00:00.000Z",
    })
  );
  const result = await journal.appendWorkItems({
    records,
    ledgerRevision: 9,
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    graphCursor: 7,
    graphCheckpointDigest: "a".repeat(64),
  });
  assert.equal(result.added, 161);
  assert.deepEqual(journal.getAuthorityState(), {
    cursor: 7,
    checkpointDigest: "a".repeat(64),
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    workLedgerRevision: 9,
  });
  const persisted = store.values.get(MEMORY_JOURNAL_KEY);
  assert.equal(persisted.records.length, 161);
  assert.equal(persisted.lifecycleAuthority.workItemAttestations.length, 161);
  assert.equal(persisted.lifecycleAuthority.baseCursor, 7);
  const recovered = await fixture({ store });
  assert.equal(recovered.journal.getAuthorityState().cursor, 7);
  assert.equal(
    recovered.journal.readRecords({
      recordIds: persisted.records.slice(0, 20).map(({ recordId }) => recordId),
    }).items.every(({ labels }) => labels.lifecycle === "current"),
    true,
  );
});

test("the upgraded work-item projection retires the markerless record at the same revision", async () => {
  const store = memoryStore();
  const source = {
    kind: "work-item",
    id: "work-item-pr-upgrade:revision:7",
  };
  const legacyRecord = normalizeMemoryRecord(record(1, {
    source,
    occurredAt: "2026-08-02T02:00:07.000Z",
    eventType: "work.completed",
    summary: "legacy projection without a lifecycle marker",
    evidence: [],
    tags: ["work", "completed"],
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [legacyRecord],
  });
  const first = await fixture({ store });
  const upgraded = (await appendTrustedWork(first.journal, [trustedWorkRecord(2, {
    itemId: "work-item-pr-upgrade",
    revision: 7,
    status: "completed",
    occurredAt: "2026-08-02T02:00:07.000Z",
    summary: "schema-upgraded authoritative projection",
  })], 7)).items[0];

  for (const journal of [first.journal, (await fixture({ store })).journal]) {
    assert.deepEqual(
      journal.readRecords({
        recordIds: [legacyRecord.recordId, upgraded.recordId],
      }).items.map(({ labels }) => labels.lifecycle),
      ["obsolete", "current"],
    );
  }
});

test("schema v1 recovery keeps only the latest markerless non-PR work revision current", async () => {
  const store = memoryStore();
  const records = [1, 2, 3].map((revision) =>
    normalizeMemoryRecord(record(revision, {
      source: {
        kind: "work-item",
        id: `work-item-pr-pre-upgrade:revision:${revision}`,
      },
      occurredAt: `2026-08-02T02:00:0${revision}.000Z`,
      eventType: "work.queued",
      evidence: [],
      tags: ["work", "queued"],
    }))
  );
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 3,
    records,
  });

  const recovered = await fixture({ store });
  assert.deepEqual(
    recovered.journal.readRecords({
      recordIds: records.map(({ recordId }) => recordId),
    }).items.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete", "current"],
  );
});

test("schema v1 PR work items without a valid authority binding recover fail-closed", async () => {
  const store = memoryStore();
  const legacyPr = normalizeMemoryRecord(record(1, {
    source: { kind: "work-item", id: "work-item-pr-legacy:revision:1" },
    eventType: "work.queued",
    content: JSON.stringify({ eventType: "pull_request.observed" }),
    evidence: [],
    tags: ["work", "queued"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [legacyPr],
  });

  const { journal } = await fixture({ store });
  assert.equal(
    journal.readRecords({ recordIds: [legacyPr.recordId] })
      .items[0].labels.lifecycle,
    "obsolete",
  );
});

test("ordinary producers cannot forge lifecycle sources or supersession markers", async () => {
  const { journal } = await fixture();
  const forged = [
    record(1, {
      source: { kind: "work-contract", id: "work-task-a:contract:1" },
    }),
    record(2, {
      source: { kind: "work-obsolescence", id: "forged-tombstone" },
    }),
    record(3, { evidence: [`supersedes:memory-${"a".repeat(64)}`] }),
    record(4, {
      evidence: ["supersedes-work-authority-binding:" + "b".repeat(64)],
    }),
  ];
  for (const candidate of forged) {
    assert.throws(
      () => journal.append(candidate),
      (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
    );
  }
  assert.equal(journal.getHealth().recordCount, 0);
});

test("projector-only history keeps citable timeline records and drops non-citable PR noise", async () => {
  const { store, journal } = await fixture();
  const timeline = record(1, {
    source: { kind: "work-timeline", id: "timeline-pr-42" },
    eventType: "timeline.assignment_intaken",
    content: JSON.stringify({
      details: { sourceSequence: 1 },
      historicalOnly: true,
      citableConclusion: false,
    }),
    evidence: [],
    tags: ["timeline", "assignment_intaken", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  });
  const legacy = record(2, {
    source: { kind: "legacy-pr-memory", id: "pr-42:analysis-ready" },
    roleId: "pr-reviewer",
    eventType: "analysis_ready",
    evidence: [],
    tags: ["legacy", "pr-reviewer", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  });
  const currentTimeline = record(3, {
    source: { kind: "work-timeline", id: "timeline-issue-7" },
    eventType: "timeline.assignment_intaken",
    content: JSON.stringify({ details: { sourceSequence: 3 } }),
    evidence: [],
    tags: ["timeline", "assignment_intaken"],
    sourceUrl: "https://github.com/acme/repo/issues/7",
    subjectNumber: 7,
  });
  const writesBefore = store.writes.length;
  for (const candidate of [timeline, legacy, currentTimeline]) {
    await assert.rejects(
      Promise.resolve().then(() => journal.append(candidate)),
      (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
    );
  }
  const emptyHealth = journal.getHealth();
  assert.deepEqual({
    ready: emptyHealth.ready,
    revision: emptyHealth.revision,
    recordCount: emptyHealth.recordCount,
    maximumRecords: emptyHealth.maximumRecords,
    recordCapacityRatio: emptyHealth.recordCapacityRatio,
    capacityWarning: emptyHealth.capacityWarning,
    reclaimableRecordCount: emptyHealth.reclaimableRecordCount,
    indexHealthy: emptyHealth.indexHealthy,
    lastIndexError: emptyHealth.lastIndexError,
  }, {
    ready: true,
    revision: 0,
    recordCount: 0,
    maximumRecords: 20_000,
    recordCapacityRatio: 0,
    capacityWarning: false,
    reclaimableRecordCount: 0,
    indexHealthy: true,
    lastIndexError: "",
  });
  assert.ok(emptyHealth.stateBytes > 0);
  assert.equal(emptyHealth.maximumStateBytes, 64 * 1024 * 1024);
  assert.equal(emptyHealth.stateCapacityRatio, 0);
  assert.equal(store.writes.length, writesBefore);

  const appended = await journal.appendProjectionRecords({
    records: [timeline, legacy, currentTimeline],
  });
  assert.equal(appended.added, 1);
  assert.deepEqual(appended.items.map(({ created }) => created), [
    false,
    false,
    true,
  ]);
  const writesAfterFirstProjection = store.writes.length;
  assert.equal((await journal.appendProjectionRecords({
    records: [timeline, legacy, currentTimeline],
  })).added, 0);
  assert.equal(store.writes.length, writesAfterFirstProjection);
  assert.equal(journal.getHealth().recordCount, 1);
  assert.throws(
    () => journal.readRecords({
      recordIds: [normalizeMemoryRecord(timeline).recordId],
    }),
    (error) => error.code === "MEMORY_RECORD_NOT_FOUND",
  );
  assert.throws(
    () => journal.readRecords({
      recordIds: [normalizeMemoryRecord(legacy).recordId],
    }),
    (error) => error.code === "MEMORY_RECORD_NOT_FOUND",
  );
  assert.deepEqual(
    journal.readRecords({
      recordIds: [normalizeMemoryRecord(currentTimeline).recordId],
    }).items.map(({ labels }) => labels),
    [{ authority: "raw", lifecycle: "current" }],
  );
});

test("recovered projection noise is compacted once without repeated batch writes", async () => {
  const store = memoryStore();
  const timeline = normalizeMemoryRecord(record(1, {
    source: { kind: "work-timeline", id: "historical-pr-timeline" },
    eventType: "timeline.assignment_intaken",
    content: JSON.stringify({
      details: { sourceSequence: 1 },
      historicalOnly: true,
      citableConclusion: false,
    }),
    evidence: [],
    tags: ["timeline", "assignment_intaken", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  }));
  const legacy = normalizeMemoryRecord(record(2, {
    source: { kind: "legacy-pr-memory", id: "legacy-pr-review" },
    roleId: "pr-reviewer",
    eventType: "analysis_ready",
    evidence: [],
    tags: ["legacy", "pr-reviewer", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 2,
    records: [timeline, legacy],
  });
  const { journal } = await fixture({ store });
  assert.equal(journal.getHealth().reclaimableRecordCount, 2);
  const projectionInputs = [timeline, legacy].map((stored) => {
    const input = structuredClone(stored);
    delete input.recordId;
    delete input.contentDigest;
    return input;
  });

  const first = await journal.appendProjectionRecords({
    records: projectionInputs,
  });
  const writesAfterFirst = store.writes.length;
  const second = await journal.appendProjectionRecords({
    records: projectionInputs,
  });

  assert.equal(first.added, 0);
  assert.deepEqual(first.items.map(({ created }) => created), [false, false]);
  assert.equal(journal.getHealth().recordCount, 0);
  assert.equal(journal.getHealth().reclaimableRecordCount, 0);
  assert.equal(second.added, 0);
  assert.deepEqual(second.items.map(({ created }) => created), [false, false]);
  assert.equal(store.writes.length, writesAfterFirst);
});

test("mechanical timeline compaction removes only unreferenced duplicate projections", async () => {
  const store = memoryStore();
  const occurredAt = "2026-08-02T01:02:01.000Z";
  const mechanicalDetails = {
    assignmentId: "workflow-assignment-duplicate",
    inputDigest: "a".repeat(64),
    kind: "assignment",
    sourceSequence: 7,
  };
  const mechanicalLegacy = normalizeMemoryRecord(record(1, {
    source: { kind: "work-timeline", id: "timeline-assignment-duplicate" },
    occurredAt,
    roleId: "work-ledger-system",
    eventType: "timeline.assignment_intaken",
    title: "工作时间线：assignment_intaken",
    summary: "work-item-duplicate",
    content: JSON.stringify(mechanicalDetails),
    evidence: [],
    tags: ["timeline", "assignment_intaken"],
    sourceUrl: "https://github.com/acme/repo/issues/7",
    subjectNumber: 7,
  }));
  const mechanicalCanonical = normalizeMemoryRecord(record(1, {
    source: { kind: "work-timeline", id: "timeline-assignment-duplicate" },
    occurredAt,
    roleId: "work-ledger-system",
    eventType: "timeline.assignment_intaken",
    title: "工作时间线：assignment_intaken",
    summary: "work-item-duplicate",
    content: JSON.stringify({ details: mechanicalDetails }),
    evidence: [],
    tags: ["timeline", "assignment_intaken"],
    sourceUrl: "https://github.com/acme/repo/issues/7",
    subjectNumber: 7,
  }));
  const answerDetails = { answer: { type: "text", text: "保留用户答复" } };
  const answerLegacy = normalizeMemoryRecord(record(2, {
    source: { kind: "work-timeline", id: "timeline-answer-duplicate" },
    occurredAt,
    roleId: "owner",
    eventType: "timeline.attention_answer_applied",
    title: "工作时间线：attention_answer_applied",
    summary: "work-item-answer",
    content: JSON.stringify(answerDetails),
    evidence: [],
    tags: ["timeline", "attention_answer_applied"],
    sourceUrl: "https://github.com/acme/repo/issues/8",
    subjectNumber: 8,
  }));
  const answerCanonical = normalizeMemoryRecord(record(2, {
    source: { kind: "work-timeline", id: "timeline-answer-duplicate" },
    occurredAt,
    roleId: "owner",
    eventType: "timeline.attention_answer_applied",
    title: "工作时间线：attention_answer_applied",
    summary: "work-item-answer",
    content: JSON.stringify({ details: answerDetails }),
    evidence: [],
    tags: ["timeline", "attention_answer_applied"],
    sourceUrl: "https://github.com/acme/repo/issues/8",
    subjectNumber: 8,
  }));
  const claimedDetails = {
    attempt: 1,
    inputDigest: "b".repeat(64),
    leaseId: "lease-referenced",
    leaseUntil: "2026-08-02T01:05:00.000Z",
  };
  const referencedLegacy = normalizeMemoryRecord(record(3, {
    source: { kind: "work-timeline", id: "timeline-claim-referenced" },
    occurredAt,
    roleId: "configured-developer",
    eventType: "timeline.claimed",
    title: "工作时间线：claimed",
    summary: "work-item-referenced",
    content: JSON.stringify(claimedDetails),
    evidence: [],
    tags: ["timeline", "claimed"],
    sourceUrl: "https://github.com/acme/repo/issues/9",
    subjectNumber: 9,
  }));
  const referencedCanonical = normalizeMemoryRecord(record(3, {
    source: { kind: "work-timeline", id: "timeline-claim-referenced" },
    occurredAt,
    roleId: "configured-developer",
    eventType: "timeline.claimed",
    title: "工作时间线：claimed",
    summary: "work-item-referenced",
    content: JSON.stringify({ details: claimedDetails }),
    evidence: [],
    tags: ["timeline", "claimed"],
    sourceUrl: "https://github.com/acme/repo/issues/9",
    subjectNumber: 9,
  }));
  const reference = normalizeMemoryRecord(record(4, {
    source: { kind: "local-session", id: "mechanical-reference" },
    evidence: [`depends-on:${referencedLegacy.recordId}`],
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 7,
    records: [
      mechanicalLegacy,
      mechanicalCanonical,
      answerLegacy,
      answerCanonical,
      referencedLegacy,
      referencedCanonical,
      reference,
    ],
  });
  const { journal } = await fixture({ store });
  assert.equal(journal.getHealth().reclaimableRecordCount, 1);

  const projectionInputs = [
    mechanicalLegacy,
    mechanicalCanonical,
    answerLegacy,
    answerCanonical,
    referencedLegacy,
    referencedCanonical,
  ].map((stored) => {
    const input = structuredClone(stored);
    delete input.recordId;
    delete input.contentDigest;
    return input;
  });
  await journal.appendProjectionRecords({ records: projectionInputs });

  assert.equal(journal.getHealth().recordCount, 6);
  assert.equal(journal.getHealth().reclaimableRecordCount, 0);
  assert.throws(
    () => journal.readRecords({ recordIds: [mechanicalLegacy.recordId] }),
    (error) => error.code === "MEMORY_RECORD_NOT_FOUND",
  );
  assert.deepEqual(
    journal.readRecords({
      recordIds: [
        mechanicalCanonical.recordId,
        answerLegacy.recordId,
        answerCanonical.recordId,
        referencedLegacy.recordId,
        referencedCanonical.recordId,
      ],
    }).items.map(({ record: value }) => value.recordId),
    [
      mechanicalCanonical.recordId,
      answerLegacy.recordId,
      answerCanonical.recordId,
      referencedLegacy.recordId,
      referencedCanonical.recordId,
    ],
  );

  const recovered = await fixture({ store });
  assert.equal(recovered.journal.getHealth().recordCount, 6);
  assert.equal(recovered.journal.getHealth().reclaimableRecordCount, 0);
});

test("trusted projector records reject citable PR history without writing", async () => {
  const { store, journal } = await fixture();
  const forged = [
    record(1, {
      source: { kind: "work-timeline", id: "timeline-pr-current" },
      eventType: "timeline.assignment_intaken",
      content: JSON.stringify({ details: { sourceSequence: 1 } }),
      evidence: [],
      tags: ["timeline", "assignment_intaken"],
      sourceUrl: "https://github.com/acme/repo/pull/42",
      subjectNumber: 42,
    }),
    record(2, {
      source: { kind: "legacy-pr-memory", id: "pr-42:current" },
      roleId: "pr-reviewer",
      eventType: "analysis_ready",
      evidence: [],
      tags: ["legacy", "pr-reviewer"],
      sourceUrl: "https://github.com/acme/repo/pull/42",
      subjectNumber: 42,
    }),
  ];
  const writesBefore = store.writes.length;
  for (const candidate of forged) {
    await assert.rejects(
      Promise.resolve().then(() => journal.appendProjectionRecords({
        records: [candidate],
      })),
      (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
    );
  }
  assert.equal(journal.getHealth().recordCount, 0);
  assert.equal(store.writes.length, writesBefore);
});

test("authority-bound projections require an exact canonical PR authority", async () => {
  const { store, journal } = await fixture();
  const binding = pullRequestExecutionBinding();
  const validAuthority = {
    applies: true,
    current: true,
    bindingDigest: digestValue(binding),
    inputBinding: binding,
  };
  const kinds = [
    "work-decision",
    "consultation-request",
    "consultation-result",
    "confirmation",
    "external-result",
  ];

  const validRecords = kinds.map(
    (kind) => authorityProjectionRecord(kind, validAuthority),
  );
  const accepted = await journal.appendAuthorityProjection(
    authorityProjectionCommit(validRecords),
  );
  assert.equal(accepted.added, kinds.length);

  const forgeries = [
    {
      ...validAuthority,
      inputBinding: {},
    },
    {
      ...validAuthority,
      bindingDigest: "not-a-digest",
    },
    {
      ...validAuthority,
      injectedAuthority: true,
    },
  ];
  const writesBefore = store.writes.length;
  for (const [index, authority] of forgeries.entries()) {
    const forgedRecord = authorityProjectionRecord("work-decision", {
      ...authority,
      current: index % 2 === 0,
    });
    await assert.rejects(
      Promise.resolve().then(() => journal.appendAuthorityProjection(
        authorityProjectionCommit([forgedRecord], { revision: 2 }),
      )),
      (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
    );
  }
  assert.equal(journal.getHealth().recordCount, kinds.length);
  assert.equal(store.writes.length, writesBefore);
});

test("ordinary projector append cannot bypass the authority checkpoint", async () => {
  const { store, journal } = await fixture();
  const binding = pullRequestExecutionBinding();
  const candidate = authorityProjectionRecord("external-result", {
    applies: true,
    current: true,
    bindingDigest: digestValue(binding),
    inputBinding: binding,
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    Promise.resolve().then(() => journal.appendProjectionRecords({
      records: [candidate],
    })),
    (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_REQUIRED",
  );
  assert.equal(journal.getHealth().recordCount, 0);
  assert.equal(store.writes.length, writesBefore);
});

test("confirmation authority cannot claim current without a PR binding", async () => {
  const { store, journal } = await fixture();
  const candidate = authorityProjectionRecord("confirmation", {
    applies: false,
    current: true,
    bindingDigest: null,
    inputBinding: null,
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    Promise.resolve().then(() => journal.appendAuthorityProjection(
      authorityProjectionCommit([candidate]),
    )),
    (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
  );
  assert.equal(journal.getHealth().recordCount, 0);
  assert.equal(store.writes.length, writesBefore);
});

test("recovery rejects a current authority record missing from its checkpoint", async () => {
  const store = memoryStore();
  const { journal } = await fixture({ store });
  const binding = pullRequestExecutionBinding();
  const candidate = authorityProjectionRecord("external-result", {
    applies: true,
    current: true,
    bindingDigest: digestValue(binding),
    inputBinding: binding,
  });
  await journal.appendAuthorityProjection(
    authorityProjectionCommit([candidate]),
  );
  const tampered = store.values.get(MEMORY_JOURNAL_KEY);
  tampered.lifecycleAuthority.authorityProjection.entries = [];
  store.values.set(MEMORY_JOURNAL_KEY, tampered);

  const recovered = new LocalMemoryJournal({ store, exclusiveLease: lease });
  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "MEMORY_JOURNAL_CORRUPTED",
  );
});

test("legacy authority records omitted from the old checkpoint recover obsolete", async () => {
  const store = memoryStore();
  const { journal } = await fixture({ store });
  const binding = pullRequestExecutionBinding();
  const candidate = authorityProjectionRecord("external-result", {
    applies: true,
    current: true,
    bindingDigest: digestValue(binding),
    inputBinding: binding,
  });
  const normalized = normalizeMemoryRecord(candidate);
  await journal.appendAuthorityProjection(
    authorityProjectionCommit([candidate]),
  );
  const legacy = store.values.get(MEMORY_JOURNAL_KEY);
  const projection = legacy.lifecycleAuthority.authorityProjection;
  legacy.lifecycleAuthority.authorityProjection = {
    schemaVersion: 3,
    revision: projection.revision,
    confirmationHighWatermark: projection.confirmationHighWatermark,
    entries: [],
  };
  store.values.set(MEMORY_JOURNAL_KEY, legacy);

  const recovered = await fixture({ store });
  assert.deepEqual(
    recovered.journal.readRecords({ recordIds: [normalized.recordId] })
      .items[0].labels,
    { authority: "raw", lifecycle: "obsolete" },
  );
});

test("recovery rejects a rehashed reserved projection with forged authority", async () => {
  const store = memoryStore();
  const binding = pullRequestExecutionBinding();
  const forged = normalizeMemoryRecord(authorityProjectionRecord(
    "external-result",
    {
      applies: true,
      current: true,
      bindingDigest: digestValue(binding),
      inputBinding: {},
    },
  ));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [forged],
  });
  const recovered = new LocalMemoryJournal({ store, exclusiveLease: lease });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_INVALID",
  );
  assert.throws(
    () => recovered.getHealth(),
    (error) => error.code === "MEMORY_NOT_READY",
  );
});

test("graph receipts reject duplicate memory references before persistence", async () => {
  const { store, journal } = await fixture();
  const item = graphFixtureItem();
  const first = createWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: 1,
    taskRevision: 1,
    item,
    kind: "acceptance_contract",
    record: item.graph.acceptanceContracts[0],
  });
  const duplicate = createWorkGraphMemoryEvent({
    sequence: 2,
    previousDigest: first.eventDigest,
    ledgerRevision: 2,
    taskRevision: 1,
    item,
    kind: "acceptance_contract",
    record: item.graph.acceptanceContracts[0],
  });
  const writesBefore = store.writes.length;
  await assert.rejects(
    journal.appendGraphEvents({
      events: [first, duplicate],
      ledgerRevision: 2,
      highWatermark: 2,
      authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    }),
    (error) => error.code === "MEMORY_LIFECYCLE_AUTHORITY_CONFLICT",
  );
  assert.equal(journal.getHealth().recordCount, 0);
  assert.equal(store.writes.length, writesBefore);
});

test("restart recomputes persisted graph event digests from the sealed record", async () => {
  const store = memoryStore();
  const first = await fixture({ store });
  const item = graphFixtureItem();
  const event = createWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: 1,
    taskRevision: 1,
    item,
    kind: "acceptance_contract",
    record: item.graph.acceptanceContracts[0],
  });
  await first.journal.appendGraphEvents({
    events: [event],
    ledgerRevision: 1,
    highWatermark: 1,
    authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
  });
  const recovered = await fixture({ store });
  assert.equal(recovered.journal.getAuthorityState().cursor, 1);

  const tampered = store.values.get(MEMORY_JOURNAL_KEY);
  tampered.lifecycleAuthority.graphReceipts[0].taskRevision += 1;
  store.values.set(MEMORY_JOURNAL_KEY, tampered);
  await assert.rejects(
    fixture({ store }),
    (error) => error.code === "MEMORY_JOURNAL_CORRUPTED",
  );
});

test("retired legacy PR memory is obsolete even when persisted before lifecycle tags", async () => {
  const store = memoryStore();
  const legacy = normalizeMemoryRecord(record(1, {
    source: { kind: "legacy-pr-memory", id: "pr-work-old:analysis_ready" },
    roleId: "pr-reviewer",
    eventType: "analysis_ready",
    tags: ["legacy", "pr-reviewer", "derived"],
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [legacy],
  });
  const { journal } = await fixture({ store });

  assert.deepEqual(
    journal.readRecords({ recordIds: [legacy.recordId] }).items[0].labels,
    { authority: "derived", lifecycle: "obsolete" },
  );
});

test("authoritative context reads reject malformed, missing, and accessor-backed ids", async () => {
  const { store, journal } = await fixture();
  const persisted = await journal.append(record(1, {
    content: "private authoritative memory",
  }));
  const writesBefore = store.writes.length;
  const missingId = `memory-${"0".repeat(64)}`;

  for (const input of [
    {},
    { recordIds: [] },
    { recordIds: [persisted.recordId, persisted.recordId] },
    { recordIds: ["memory-invalid"] },
    { recordIds: new Array(1) },
    { recordIds: Array.from({ length: 21 }, (_, index) =>
      `memory-${index.toString(16).padStart(64, "0")}`) },
    { recordIds: [persisted.recordId], debug: true },
  ]) {
    assert.throws(
      () => journal.readRecords(input),
      (error) =>
        error.code === "MEMORY_INPUT_INVALID" &&
        !error.message.includes("private authoritative memory"),
    );
  }

  let objectGetterCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "recordIds", {
    enumerable: true,
    get() {
      objectGetterCalls += 1;
      return [persisted.recordId];
    },
  });
  assert.throws(() => journal.readRecords(accessorInput), /memory record query/i);
  assert.equal(objectGetterCalls, 0);

  let arrayGetterCalls = 0;
  const accessorIds = [persisted.recordId];
  Object.defineProperty(accessorIds, "0", {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return persisted.recordId;
    },
  });
  assert.throws(
    () => journal.readRecords({ recordIds: accessorIds }),
    /recordIds/i,
  );
  assert.equal(arrayGetterCalls, 0);

  assert.throws(
    () => journal.readRecords({ recordIds: [missingId] }),
    (error) =>
      error.code === "MEMORY_RECORD_NOT_FOUND" &&
      error.statusCode === 404 &&
      !error.message.includes(missingId) &&
      !error.message.includes("private authoritative memory"),
  );
  assert.equal(store.writes.length, writesBefore);
});

test("receipt verification is exact, read-only, and never exposes memory content", async () => {
  const { store, journal } = await fixture();
  await journal.append(record(1, { content: "private-memory-content" }));
  const stored = store.values.get(MEMORY_JOURNAL_KEY).records[0];
  const request = {
    recordId: stored.recordId,
    contentDigest: stored.contentDigest,
    source: structuredClone(stored.source),
  };
  const readsBefore = store.reads.length;
  const writesBefore = store.writes.length;

  const verified = journal.verifyReceipt(request);

  assert.deepEqual(verified, { ...request, persisted: true });
  assert.deepEqual(Object.keys(verified), [
    "recordId",
    "contentDigest",
    "source",
    "persisted",
  ]);
  assert.equal("content" in verified, false);
  assert.equal("title" in verified, false);
  assert.notStrictEqual(verified.source, stored.source);
  assert.equal(store.reads.length, readsBefore);
  assert.equal(store.writes.length, writesBefore);

  verified.source.id = "changed-by-caller";
  assert.deepEqual(journal.verifyReceipt(request), { ...request, persisted: true });
});

test("receipt verification fails uniformly for malformed, missing, or mismatched bindings", async () => {
  const { journal } = await fixture();
  await journal.append(record(1, { content: "private-memory-content" }));
  const [stored] = journal.search({}).items;
  const persisted = record(1).source;
  const valid = {
    recordId: stored.id,
    contentDigest: stored.id.slice("memory-".length),
    source: persisted,
  };
  const failures = [
    { ...valid, recordId: `memory-${"0".repeat(64)}`, contentDigest: "0".repeat(64) },
    { ...valid, contentDigest: "0".repeat(64) },
    { ...valid, source: { ...valid.source, id: "another-source" } },
    { ...valid, debug: true },
    { recordId: valid.recordId, contentDigest: valid.contentDigest },
    { ...valid, source: { ...valid.source, debug: true } },
  ];
  const fingerprints = failures.map((candidate) => {
    let error;
    try {
      journal.verifyReceipt(candidate);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes("private-memory-content"), false);
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };
  });

  assert.deepEqual(
    fingerprints,
    failures.map(() => ({
      code: "MEMORY_RECEIPT_UNVERIFIED",
      message: "无法验证持久记忆凭据",
      statusCode: 409,
    })),
  );
});

test("an index write outage never rolls back raw memory and search stays local", async () => {
  const store = memoryStore({ failIndexWrites: true });
  const { journal } = await fixture({ store });
  const receipt = await journal.append(record(1));

  assert.equal(receipt.created, true);
  assert.equal(journal.getHealth().indexHealthy, false);
  assert.equal(store.values.get(MEMORY_JOURNAL_KEY).records.length, 1);
  assert.equal(journal.search({ q: "失败路径" }).items.length, 1);

  const recoveredStore = memoryStore();
  recoveredStore.values.set(
    MEMORY_JOURNAL_KEY,
    structuredClone(store.values.get(MEMORY_JOURNAL_KEY)),
  );
  const recovered = new LocalMemoryJournal({
    store: recoveredStore,
    exclusiveLease: lease,
  });
  await recovered.recover();
  assert.equal(recovered.getHealth().indexHealthy, true);
  assert.equal(recovered.search({ q: "失败路径" }).items.length, 1);
  assert.ok(recoveredStore.values.has(MEMORY_INDEX_KEY));
});

test("a missing or stale index is rebuilt without changing raw records", async () => {
  const { store, journal } = await fixture();
  await journal.append(record(1));
  const rawBefore = structuredClone(store.values.get(MEMORY_JOURNAL_KEY));
  store.values.set(MEMORY_INDEX_KEY, {
    schemaVersion: 1,
    journalRevision: 0,
    journalDigest: "0".repeat(64),
    complete: true,
    entries: {},
  });
  const recovered = new LocalMemoryJournal({ store, exclusiveLease: lease });
  await recovered.recover();

  assert.deepEqual(store.values.get(MEMORY_JOURNAL_KEY), rawBefore);
  assert.equal(store.values.get(MEMORY_INDEX_KEY).journalRevision, 1);
  assert.equal(recovered.search({ q: "结算" }).items.length, 1);
});

test("an intentionally bounded index falls back to a complete local scan", async () => {
  const { store, journal } = await fixture();
  const terms = Array.from({ length: 4_200 }, (_, index) => `t${index}`).join(" ");
  await journal.append(record(1, { content: terms }));

  assert.equal(store.values.get(MEMORY_INDEX_KEY).complete, false);
  assert.equal(journal.search({ q: "t4199" }).items.length, 1);
});

test("capacity is fail-closed and malformed journal state refuses recovery", async () => {
  const { journal } = await fixture({ maximumRecords: 1 });
  await journal.append(record(1));
  await assert.rejects(
    journal.append(record(2)),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED" && error.statusCode === 507,
  );

  const store = memoryStore();
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 1,
    records: [{ ...record(1), recordId: "memory-wrong", contentDigest: "0".repeat(64) }],
  });
  const corrupted = new LocalMemoryJournal({ store, exclusiveLease: lease });
  await assert.rejects(corrupted.recover(), /摘要不一致/);
});

test("capacity pressure compacts only non-citable projected history and survives restart", async () => {
  const store = memoryStore();
  const historicalTimeline = normalizeMemoryRecord(record(1, {
    source: { kind: "work-timeline", id: "historical-pr-timeline" },
    eventType: "timeline.assignment_intaken",
    content: JSON.stringify({
      details: { sourceSequence: 1 },
      historicalOnly: true,
      citableConclusion: false,
    }),
    evidence: [],
    tags: ["timeline", "assignment_intaken", "derived", "obsolete"],
    sourceUrl: "https://github.com/acme/repo/pull/42",
    subjectNumber: 42,
  }));
  const superseded = normalizeMemoryRecord(record(2, {
    source: { kind: "local-session", id: "derived-old" },
    tags: ["derived"],
  }));
  const correction = normalizeMemoryRecord(record(3, {
    source: { kind: "local-session", id: "derived-correction" },
    evidence: [`supersedes:${superseded.recordId}`],
    tags: ["testing"],
  }));
  const rawObsolete = normalizeMemoryRecord(record(4, {
    source: { kind: "local-session", id: "raw-obsolete" },
    tags: ["obsolete"],
  }));
  store.values.set(MEMORY_JOURNAL_KEY, {
    schemaVersion: 1,
    revision: 4,
    records: [
      historicalTimeline,
      superseded,
      correction,
      rawObsolete,
    ],
  });
  const { journal } = await fixture({ store, maximumRecords: 4 });

  const latest = await journal.append(record(5, {
    source: { kind: "local-session", id: "latest" },
  }));

  assert.equal(latest.created, true);
  assert.equal(journal.getHealth().recordCount, 4);
  assert.throws(
    () => journal.readRecords({ recordIds: [historicalTimeline.recordId] }),
    (error) => error.code === "MEMORY_RECORD_NOT_FOUND",
  );
  assert.deepEqual(
    journal.readRecords({
      recordIds: [
        superseded.recordId,
        correction.recordId,
        rawObsolete.recordId,
        latest.recordId,
      ],
    }).items.map(({ record: value }) => value.recordId),
    [
      superseded.recordId,
      correction.recordId,
      rawObsolete.recordId,
      latest.recordId,
    ],
  );
  assert.ok(
    journal.readRecords({ recordIds: [correction.recordId] })
      .items[0].record.evidence.includes(`supersedes:${superseded.recordId}`),
  );

  const recovered = await fixture({ store, maximumRecords: 4 });
  assert.equal(recovered.journal.getHealth().recordCount, 4);
  assert.deepEqual(
    recovered.journal.readRecords({ recordIds: [latest.recordId] })
      .items[0].labels,
    { authority: "raw", lifecycle: "current" },
  );
});

test("one atomic journal append accepts 160 records and rejects larger or over-capacity batches", async () => {
  const { store, journal } = await fixture({ maximumRecords: 200 });
  const writesBefore = store.writes.filter((key) => key === MEMORY_JOURNAL_KEY).length;

  const appended = await journal.appendBatch({ records: batchRecords(160) });

  assert.equal(appended.added, 160);
  const health = journal.getHealth();
  assert.deepEqual({
    ready: health.ready,
    revision: health.revision,
    recordCount: health.recordCount,
    maximumRecords: health.maximumRecords,
    recordCapacityRatio: health.recordCapacityRatio,
    capacityWarning: health.capacityWarning,
    reclaimableRecordCount: health.reclaimableRecordCount,
    indexHealthy: health.indexHealthy,
    lastIndexError: health.lastIndexError,
  }, {
    ready: true,
    revision: 1,
    recordCount: 160,
    maximumRecords: 200,
    recordCapacityRatio: 0.8,
    capacityWarning: true,
    reclaimableRecordCount: 0,
    indexHealthy: true,
    lastIndexError: "",
  });
  assert.ok(health.stateBytes > 0);
  assert.equal(health.maximumStateBytes, 64 * 1024 * 1024);
  assert.ok(health.stateCapacityRatio >= 0);
  assert.equal(
    store.writes.filter((key) => key === MEMORY_JOURNAL_KEY).length,
    writesBefore + 1,
  );
  assert.throws(
    () => journal.appendBatch({ records: batchRecords(161) }),
    /records 无效/,
  );
  assert.equal(journal.getHealth().revision, 1);

  const constrained = await fixture({ maximumRecords: 159 });
  const constrainedRawBefore = structuredClone(
    constrained.store.values.get(MEMORY_JOURNAL_KEY) ?? null,
  );
  await assert.rejects(
    constrained.journal.appendBatch({ records: batchRecords(160) }),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED",
  );
  assert.equal(constrained.journal.getHealth().revision, 0);
  assert.equal(constrained.journal.getHealth().recordCount, 0);
  assert.deepEqual(
    constrained.store.values.get(MEMORY_JOURNAL_KEY) ?? null,
    constrainedRawBefore,
  );
});

test("query and batch boundaries reject unknown fields and sparse arrays", async () => {
  const { journal } = await fixture();
  assert.throws(() => journal.search({ debug: true }), /字段无效/);
  const records = new Array(1);
  assert.throws(() => journal.appendBatch({ records }), /records 无效/);
  assert.throws(() => journal.search({ cursor: "not-a-cursor" }), /cursor 无效/);
});


test("recovery retires orphaned unbound consultation history once without altering checkpoint or old records", async () => {
  const store = memoryStore();
  const { journal } = await fixture({ store });
  const candidate = authorityProjectionRecord("consultation-request", {
    applies: false, current: true, bindingDigest: null, inputBinding: null,
  });
  await journal.appendAuthorityProjection(authorityProjectionCommit([candidate]));
  await journal.append(record(2));
  const damaged = store.values.get(MEMORY_JOURNAL_KEY);
  damaged.lifecycleAuthority.authorityProjection.entries = [];
  const before = structuredClone(damaged);
  store.values.set(MEMORY_JOURNAL_KEY, damaged);
  const recovered = await fixture({ store });
  const fixed = store.values.get(MEMORY_JOURNAL_KEY);
  assert.deepEqual(fixed.records.slice(0, before.records.length), before.records);
  assert.deepEqual(fixed.lifecycleAuthority, before.lifecycleAuthority);
  assert.equal(fixed.records.length, before.records.length + 1);
  assert.equal(fixed.revision, before.revision + 1);
  assert.deepEqual(fixed.records.at(-1).evidence, [`supersedes:${before.records[0].recordId}`]);
  assert.equal(JSON.parse(fixed.records.at(-1).content).authority.current, false);
  assert.equal(recovered.journal.readRecords({ recordIds: [before.records[0].recordId] }).items[0].labels.lifecycle, "obsolete");
  await fixture({ store });
  assert.deepEqual(store.values.get(MEMORY_JOURNAL_KEY), fixed);
  const corrupt = structuredClone(before);
  corrupt.records[0].contentDigest = "f".repeat(64);
  store.values.set(MEMORY_JOURNAL_KEY, corrupt);
  const writes = store.writes.length;
  await assert.rejects(fixture({ store }));
  assert.equal(store.writes.length, writes);
});

test("authority projection cannot remove a current unbound consultation without an obsolete supersession", async () => {
  const { store, journal } = await fixture();
  const candidate = authorityProjectionRecord("consultation-request", {
    applies: false, current: true, bindingDigest: null, inputBinding: null,
  });
  await journal.appendAuthorityProjection(authorityProjectionCommit([candidate]));
  const writes = store.writes.length;
  await assert.rejects(journal.appendAuthorityProjection(authorityProjectionCommit([], { revision: 2 })),
    error => error.code === "MEMORY_LIFECYCLE_AUTHORITY_INVALID");
  assert.equal(store.writes.length, writes);
});
