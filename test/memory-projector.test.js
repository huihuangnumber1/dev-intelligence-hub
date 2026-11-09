import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { createPullRequestExecutionBinding } from
  "../src/domain/pull-request-execution-binding.js";
import {
  createWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
import {
  LocalMemoryJournal,
  MEMORY_JOURNAL_KEY,
} from "../src/services/local-memory-journal.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";
import { MemoryProjector, planAuthorityBoundProjectionCandidate } from "../src/services/memory-projector.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import {
  externalActionControlledCommit,
  pullRequestExternalActionBinding,
  pullRequestExternalActionPlan,
  pullRequestExternalActionQueuePlan,
} from "./support/pull-request-external-action-fixture.js";

function workItem(id, status, revision = 1) {
  return {
    itemId: `work-${id}`,
    assignmentId: `assignment-${id}`,
    revision,
    status,
    statusReason: "",
    attempt: 0,
    currentTarget: { type: "role", id: "requirements-analyst" },
    event: {
      eventType: "issue.observed",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: { id: `github:issue:acme/repo#${id}`, repository: "acme/repo", number: id },
      payload: { title: `Issue ${id}` },
    },
    decisionContext: null,
    createdAt: "2026-08-02T01:00:00.000Z",
    updatedAt: `2026-08-02T01:00:0${id}.000Z`,
  };
}

const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");

function graphProjectionSource(events = []) {
  let cursor = 0;
  return {
    acknowledgements: [],
    async readBatch({ limit }) {
      return structuredClone({
        cursor,
        highWatermark: events.length,
        checkpointDigest: events[cursor - 1]?.eventDigest ?? null,
        highWatermarkDigest: events.at(-1)?.eventDigest ?? null,
        authorityStateDigest:
          events.at(-1)?.authorityStateDigest ?? EMPTY_AUTHORITY_STATE_DIGEST,
        items: events.slice(cursor, cursor + limit),
      });
    },
    async ackBatch({ receipts }) {
      assert.ok(Array.isArray(receipts));
      assert.ok(receipts.length > 0);
      for (let index = 0; index < receipts.length; index += 1) {
        assert.deepEqual(
          receipts[index],
          workGraphMemoryRecordReceipt(events[cursor + index]),
        );
      }
      this.acknowledgements.push(structuredClone(receipts));
      cursor += receipts.length;
      return {
        status: "applied",
        cursor,
        highWatermark: events.length,
      };
    },
  };
}

function memoryAuthoritySource(items, timeline, graphSource, revision = null) {
  return {
    async readSnapshot({ limit }) {
      return structuredClone({
        ledgerRevision: revision ?? Math.max(
          1,
          ...items.map((item) => item.revision),
        ),
        items,
        timeline,
        graph: await graphSource.readBatch({ limit }),
      });
    },
  };
}

function memoryLifecycleProducer(memoryProducer) {
  return {
    appendAuthorityProjection({ records, projectionState }) {
      return typeof memoryProducer.appendAuthorityProjection === "function"
        ? memoryProducer.appendAuthorityProjection({ records, projectionState })
        : memoryProducer.appendBatch({ records });
    },
    appendProjectionRecords({ records }) {
      return typeof memoryProducer.appendProjectionRecords === "function"
        ? memoryProducer.appendProjectionRecords({ records })
        : memoryProducer.appendBatch({ records });
    },
    appendWorkItems({ records }) {
      return records.length === 0
        ? Promise.resolve({ added: 0, items: [] })
        : memoryProducer.appendBatch({ records });
    },
    appendGraphEvents({ events }) {
      return memoryProducer.appendBatch({
        records: events.map(({ memoryRecord }) => memoryRecord),
      });
    },
    async adoptGraphCheckpoint() {
      return {};
    },
  };
}

function emptyMemoryAuthorityReader() {
  return {
    async getAuthorityState() {
      return {
        cursor: 0,
        checkpointDigest: null,
        authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        workLedgerRevision: 0,
      };
    },
    async getAuthorityProjectionState() {
      return {
        schemaVersion: 4,
        revision: 0,
        workLedgerRevision: 0,
        authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        confirmationHighWatermark: 0,
        entries: [],
      };
    },
  };
}

function graphEventsForItem(item) {
  let previousDigest = null;
  return [
    ...item.graph.acceptanceContracts.map((record) => ({
      kind: "acceptance_contract",
      record,
    })),
    ...item.graph.deliveries.map((record) => ({
      kind: `delivery_${record.status}`,
      record,
    })),
  ].map(({ kind, record }, index) => {
    const event = createWorkGraphMemoryEvent({
      sequence: index + 1,
      previousDigest,
      ledgerRevision: item.revision,
      taskRevision: item.revision,
      item,
      kind,
      record,
    });
    previousDigest = event.eventDigest;
    return event;
  });
}

function localMemoryJournal() {
  return localMemoryFixture().then(({ journal }) => journal);
}

async function localMemoryFixture() {
  const values = new Map();
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();
  return { journal, store, values };
}

function pullRequestWorkItem(binding, {
  revision = 4,
  status = "completed",
  updatedAt = "2026-08-08T07:00:00.000Z",
} = {}) {
  const item = workItem(42, status, revision);
  item.itemId = binding.rootItemId;
  item.assignmentId = `assignment-${binding.eventId}`;
  item.kind = "graph_task";
  item.currentTarget = { type: "role", id: "pr-engineer" };
  item.assignment = {
    graphTask: {
      sourceBinding: {
        kind: binding.kind,
        rootItemId: binding.rootItemId,
        workKey: binding.workKey,
        inputRevision: binding.inputRevision,
        headRevision: binding.headRevision,
        headRefOid: binding.headRefOid,
        eventId: binding.eventId,
        eventDigest: binding.eventDigest,
        inputDigest: binding.inputDigest,
      },
    },
  };
  item.event = {
    schemaVersion: 1,
    eventId: binding.eventId,
    contentDigest: binding.eventDigest,
    eventType: "pull_request.status",
    occurredAt: updatedAt,
    source: { provider: "github", scopeId: "github-account:runtime-user" },
    subject: {
      id: `github:pr:${binding.repository}#${binding.pullRequestNumber}`,
      repository: binding.repository,
      number: binding.pullRequestNumber,
    },
    payload: {
      title: "Resolve mirrored PR conflict",
      headRefOid: binding.headRefOid,
      gitTargetAvailable: true,
      gitTarget: structuredClone(binding.gitTarget),
    },
  };
  item.updatedAt = updatedAt;
  return item;
}

function completedConfirmationMemoryItem(
  binding,
  {
    type = "comment",
    body = "Safe review summary",
    revision = 2,
    updatedAt = "2026-08-08T07:01:00.000Z",
    receiptId = "github-comment-receipt-42",
  } = {},
) {
  const plan = pullRequestExternalActionPlan(
    type === "review"
      ? { type, verdict: "approve", body }
      : { type, body },
    { binding },
  );
  return {
    confirmationId: plan.id,
    itemRevision: revision,
    statusDigest: digestValue({
      confirmationId: plan.id,
      itemRevision: revision,
      status: "completed",
      approvalBindingDigest: plan.approvalBindingDigest,
      updatedAt,
    }),
    kind: plan.kind,
    status: "completed",
    requestedBy: structuredClone(plan.requestedBy),
    actor: structuredClone(plan.actor),
    target: structuredClone(plan.target),
    action: {
      type: plan.action.type,
      inputBinding: structuredClone(plan.action.inputBinding),
      bodyDigest: digestValue(body),
      bodyBytes: Buffer.byteLength(body, "utf8"),
      ...(type === "review" ? { reviewEvent: plan.action.reviewEvent } : {}),
    },
    displayedPayloadDigest: plan.displayedPayloadDigest,
    approvalBindingDigest: plan.approvalBindingDigest,
    createdAt: "2026-08-08T07:00:30.000Z",
    updatedAt,
    execution: {
      attempt: 1,
      startedAt: "2026-08-08T07:00:40.000Z",
      outcome: "applied",
    },
    receipt: { id: receiptId },
    failure: null,
    rejectedAt: null,
    ownerDecision: null,
    invalidation: null,
  };
}

for (const { reviewRepair, sealedUnknown, invalidParents, invalidCase } of [
  { reviewRepair: false, sealedUnknown: false },
  { reviewRepair: true, sealedUnknown: false },
  { reviewRepair: true, sealedUnknown: true },
  { reviewRepair: true, invalidCase: "no parent", invalidParents: [] },
  { reviewRepair: true, invalidCase: "wrong Head", invalidParents: ["e".repeat(40)] },
  { reviewRepair: false, invalidCase: "wrong Base", invalidParents: ["2".repeat(40), "e".repeat(40)] },
  { reviewRepair: false, invalidCase: "extra parent", invalidParents: ["2".repeat(40), "1".repeat(40), "e".repeat(40)] },
]) {
  test(`${invalidCase ? `rejects ${invalidCase} in` : "projects"} the real confirmation queue's ${reviewRepair ? "single-parent review repair" : "conflict merge"} ${sealedUnknown ? "sealed unknown" : "completed"} push${invalidCase ? "" : " idempotently"}`, async () => {
    const binding = pullRequestExternalActionBinding();
    const evidence = externalActionControlledCommit(binding, { reviewRepair });
    const { journal, store, values } = await localMemoryFixture();
    const queue = new ConfirmationQueue({
      store,
      exclusiveLease: { run: (operation) => operation() },
      executor: {
        async execute() {
          return sealedUnknown ? { status: "unknown", code: "TEST_UNKNOWN" }
            : { status: "applied", receipt: { id: evidence.commit.oid } };
        },
        async reconcile() { return { status: "already", receipt: { id: evidence.commit.oid } }; },
      },
      clock: () => new Date("2026-08-08T07:01:00.000Z"),
    });
    await queue.recover();
    const pending = await queue.enqueue(pullRequestExternalActionQueuePlan({
      type: "push", controlledCommitEvidence: evidence,
    }, { binding }));
    const approved = await queue.approve(pending.id, {
      requestId: "publish-review-repair-projection",
      expectedQueueRevision: pending.queueRevision,
      expectedItemRevision: pending.itemRevision,
      displayedPayloadDigest: pending.displayedPayloadDigest,
      approvalBindingDigest: pending.approvalBindingDigest,
    });
    if (sealedUnknown) {
      await queue.reject(approved.id, {
        requestId: "seal-unknown-push-projection",
        expectedQueueRevision: approved.queueRevision,
        expectedItemRevision: approved.itemRevision,
        displayedPayloadDigest: approved.displayedPayloadDigest,
        approvalBindingDigest: approved.approvalBindingDigest,
        reason: "Preserve unknown publication and forbid replay",
      });
    }
    const graphSource = graphProjectionSource();
    const projector = new MemoryProjector({
      memoryLifecycleProducer: journal,
      memoryAuthorityReader: journal,
      memoryAuthoritySource: memoryAuthoritySource([pullRequestWorkItem(binding)], [], graphSource),
      graphProjectionSource: graphSource,
      confirmationProjectionSource: {
        async readMemoryPage(input) {
          const page = structuredClone(await queue.readMemoryPage(input));
          if (invalidParents !== undefined) {
            page.items[0].action.controlledCommit.commit.parents = invalidParents;
          }
          return page;
        },
      },
      inputAuthorityVerifier: { async verify(value) { return structuredClone(value); } },
      store,
    });
    if (invalidParents !== undefined) {
      await assert.rejects(projector.runCycle(), /confirmation memory projection item is invalid/u);
      assert.equal(values.has("unified-memory-records"), false, "invalid projection must not write memory");
      return;
    }
    await projector.runCycle();
    assert.equal((await projector.runCycle()).added, 0);
    const records = values.get("unified-memory-records").records;
    const confirmation = records.find((record) => record.source.kind === "confirmation");
    const externalResult = records.find((record) => record.source.kind === "external-result");
    assert.deepEqual(JSON.parse(confirmation.content).action.controlledCommit.commit.parents, evidence.commit.parents);
    const result = JSON.parse(externalResult.content);
    if (sealedUnknown) {
      assert.equal(result.failure.outcome, "unknown");
      assert.equal(result.ownerDecision.type, "seal_unknown_and_forbid_replay");
    } else {
      assert.equal(result.receipt.id, evidence.commit.oid);
    }
  });
}

function sealedUnknownConfirmationMemoryItem(binding, options = {}) {
  const item = completedConfirmationMemoryItem(binding, options);
  item.status = "rejected";
  item.statusDigest = digestValue({
    confirmationId: item.confirmationId,
    itemRevision: item.itemRevision,
    status: item.status,
    approvalBindingDigest: item.approvalBindingDigest,
    updatedAt: item.updatedAt,
  });
  item.execution.outcome = "unknown";
  item.receipt = null;
  item.failure = {
    code: "GITHUB_MARKER_ABSENT",
    outcome: "unknown",
    retryable: false,
    at: item.updatedAt,
  };
  item.rejectedAt = item.updatedAt;
  item.ownerDecision = {
    type: "seal_unknown_and_forbid_replay",
    at: item.updatedAt,
  };
  return item;
}

function proposalDecisionTimeline(item, suffix = "old") {
  const value = {
    kind: "github_pull_request_action_proposal",
    resultId: `proposal-result-${suffix}`,
    resultDigest: suffix === "old" ? "a".repeat(64) : "b".repeat(64),
    summary: `Push decision ${suffix}`,
    downstreamRef: `confirmation-${suffix}`,
    evidence: [
      `confirmation:confirmation-${suffix}`,
      `controlled-commit:controlled-${suffix}`,
    ],
  };
  const core = {
    source: "proposal",
    referenceId: `proposal-${suffix}`,
    outcome: "succeeded",
    value,
    observedAt: item.updatedAt,
  };
  const decision = { ...core, contentDigest: digestValue(core) };
  return {
    timelineId: `work-timeline-decision-${suffix}`,
    sequence: suffix === "old" ? 1 : 4,
    itemId: item.itemId,
    type: "proposal_result_applied",
    at: item.updatedAt,
    actorId: "work-proposal-result-reconciler",
    details: {
      inputBinding: createPullRequestExecutionBinding({
        sourceBinding: item.assignment.graphTask.sourceBinding,
        event: item.event,
      }),
      workItemRevision: item.revision,
      resultAttestationDigest: digestValue({
        kind: "proposal_result",
        suffix,
      }),
      decision,
      proposalId: decision.referenceId,
      resultRef: value.resultId,
      outcome: decision.outcome,
      downstreamRef: value.downstreamRef,
      evidenceRefs: [...value.evidence],
    },
  };
}

test("memory projector imports work items, timeline, and legacy PR memory idempotently", async () => {
  const items = [workItem(1, "waiting_user"), workItem(2, "queued")];
  const timeline = [{
    timelineId: "work-timeline-1",
    sequence: 1,
    itemId: "work-1",
    type: "assignment_intaken",
    at: "2026-08-02T01:00:01.000Z",
    actorId: "work-ledger-system",
    details: { sourceSequence: 1 },
  }];
  const legacy = [{
    id: "pr-work-1:analysis_ready",
    event: "analysis_ready",
    roleId: "pr-reviewer",
    sourceId: "github:pr:acme/repo#9",
    sourceUrl: "https://github.com/acme/repo/pull/9",
    repository: "acme/repo",
    number: 9,
    title: "Review checkout",
    summary: "需要补充失败路径",
    evidence: ["missing test"],
    steps: ["add test"],
    reviewBody: "Please add a test.",
    decision: "",
    brain: { provider: "ollama", model: "local" },
    createdAt: "2026-08-02T00:30:00.000Z",
  }];
  const records = new Map();
  const batches = [];
  const graphSource = graphProjectionSource();
  const trustedSink = {
    async appendBatch({ records: supplied }) {
      batches.push(structuredClone(supplied));
      let added = 0;
      for (const record of supplied) {
        const key = `${record.source.kind}:${record.source.id}`;
        if (!records.has(key)) added += 1;
        records.set(key, structuredClone(record));
      }
      return { added };
    },
  };
  const memoryProducer = {
    async appendBatch() {
      throw new Error("projector must not use the ordinary memory producer");
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(trustedSink),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource(items, timeline, graphSource),
    graphProjectionSource: graphSource,
    store: {
      async read(name) {
        assert.equal(name, "pr-employee-memory");
        return structuredClone(legacy);
      },
    },
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();

  assert.deepEqual(first, {
    observed: 4,
    added: 4,
    workItems: 2,
    timeline: 1,
    legacy: 1,
    graph: {
      observed: 0,
      added: 0,
      acknowledged: 0,
      cursor: 0,
      highWatermark: 0,
      pending: 0,
    },
  });
  assert.equal(second.added, 0);
  assert.equal(records.size, 4);
  assert.equal(records.get("work-item:work-1:revision:1").eventType, "work.waiting_user");
  assert.equal(records.get("work-timeline:work-timeline-1").eventType, "timeline.assignment_intaken");
  assert.equal(records.get("legacy-pr-memory:pr-work-1:analysis_ready").eventType, "analysis_ready");
  assert.equal(records.get("legacy-pr-memory:pr-work-1:analysis_ready").roleId, "pr-reviewer");
  assert.deepEqual(records.get("legacy-pr-memory:pr-work-1:analysis_ready").tags, [
    "legacy",
    "pr-reviewer",
    "derived",
    "obsolete",
  ]);
});

test("current work memory carries a bounded PR and CI observation", async () => {
  const item = workItem(9, "completed", 4);
  const headRefOid = "2".repeat(40);
  item.kind = "graph_task";
  item.assignment = {
    graphTask: {
      sourceBinding: {
        kind: "pull_request",
        rootItemId: "work-root-9",
        workKey: "pr:acme/repo#9",
        inputRevision: 2,
        headRevision: 2,
        headRefOid,
        eventId: "github-event-pr-9-head-2",
        eventDigest: "3".repeat(64),
        inputDigest: "4".repeat(64),
      },
    },
  };
  item.event = {
    schemaVersion: 1,
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:00:08.000Z",
    source: { provider: "github", scopeId: "github-account:runtime-user" },
    subject: {
      id: "github:pr:acme/repo#9",
      repository: "acme/repo",
      number: 9,
    },
    payload: {
      title: "Resolve the current PR conflict",
      headRefOid,
      ciStatus: "SUCCESS",
      mergeStateStatus: "CLEAN",
      changedFields: ["ciStatus", "mergeStateStatus"],
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "1".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/conflict",
        headRefOid,
      },
    },
  };
  const graphSource = graphProjectionSource();
  const journal = await localMemoryJournal();
  let workItemAppendCalls = 0;
  let projectionAppendCalls = 0;
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: {
      async appendWorkItems(value) {
        workItemAppendCalls += 1;
        return journal.appendWorkItems(value);
      },
      async appendProjectionRecords(value) {
        projectionAppendCalls += 1;
        return journal.appendProjectionRecords(value);
      },
      appendGraphEvents: (value) => journal.appendGraphEvents(value),
      appendAuthorityProjection: (value) =>
        journal.appendAuthorityProjection(value),
      adoptGraphCheckpoint: (value) => journal.adoptGraphCheckpoint(value),
    },
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  await projector.runCycle();
  const callsAfterFirst = {
    workItemAppendCalls,
    projectionAppendCalls,
  };
  const repeated = await projector.runCycle();

  assert.equal(repeated.added, 0);
  assert.deepEqual(
    { workItemAppendCalls, projectionAppendCalls },
    callsAfterFirst,
  );

  const match = journal.search({ eventType: "work.completed" }).items[0];
  const content = JSON.parse(
    journal.readRecords({ recordIds: [match.id] }).items[0].record.content,
  );
  assert.deepEqual(content.pullRequestObservation, {
    eventId: "github-event-pr-9-head-2",
    occurredAt: "2026-08-02T01:00:08.000Z",
    headRefOid,
    ciStatus: "SUCCESS",
    mergeStateStatus: "CLEAN",
    changedFields: ["ciStatus", "mergeStateStatus"],
  });
});

test("authority-bound PR memory is independent, sanitized, memoized, and invalidated after timeline trim", async () => {
  const oldBinding = pullRequestExternalActionBinding();
  const newHead = "7".repeat(40);
  const newBinding = pullRequestExternalActionBinding({
    inputRevision: 4,
    headRevision: 6,
    headRefOid: newHead,
    eventId: "github-event-42-head-6",
    eventDigest: "8".repeat(64),
    inputDigest: "9".repeat(64),
    gitTarget: { headRefOid: newHead },
  });
  const oldItem = pullRequestWorkItem(oldBinding);
  const newItem = pullRequestWorkItem(newBinding, {
    revision: 8,
    updatedAt: "2026-08-08T08:00:00.000Z",
  });
  const consultationTimeline = (item, suffix, sequence) => [{
    timelineId: `work-timeline-consultation-request-${suffix}`,
    sequence,
    itemId: item.itemId,
    type: "intent_staged",
    at: item.updatedAt,
    actorId: "pr-engineer",
    details: {
      inputBinding: createPullRequestExecutionBinding({
        sourceBinding: item.assignment.graphTask.sourceBinding,
        event: item.event,
      }),
      workItemRevision: item.revision,
      inputDigest: item.event.contentDigest,
      intentType: "ask_user",
      consultationRequest: {
        summary: `Need owner decision ${suffix}`,
        reason: "Two safe resolutions remain",
        question: "Which compatible behavior should be preserved?",
        choices: [
          { id: "preserve", label: "Preserve compatibility" },
          { id: "strict", label: "Use strict behavior" },
        ],
      },
    },
  }, {
    timelineId: `work-timeline-consultation-result-${suffix}`,
    sequence: sequence + 1,
    itemId: item.itemId,
    type: "attention_answer_applied",
    at: item.updatedAt,
    actorId: "dashboard-owner",
    details: {
      inputBinding: createPullRequestExecutionBinding({
        sourceBinding: item.assignment.graphTask.sourceBinding,
        event: item.event,
      }),
      workItemRevision: item.revision,
      inputDigest: item.event.contentDigest,
      resultAttestationDigest: digestValue({
        kind: "attention_result",
        suffix,
      }),
      answer: { choiceId: "preserve", note: `owner answer ${suffix}` },
      requestContentDigest: suffix === "old" ? "c".repeat(64) : "d".repeat(64),
      resultDigest: suffix === "old" ? "e".repeat(64) : "f".repeat(64),
    },
  }];

  let items = [oldItem];
  let timeline = [
    proposalDecisionTimeline(oldItem, "old"),
    ...consultationTimeline(oldItem, "old", 2),
  ];
  let confirmationRevision = 1;
  const secretBody = "do not persist this raw review body";
  const oldConfirmation = completedConfirmationMemoryItem(oldBinding, {
    body: secretBody,
    receiptId: "opaque-old-receipt",
  });
  const newConfirmation = sealedUnknownConfirmationMemoryItem(newBinding, {
    type: "review",
    body: "new head review body",
    revision: 3,
    updatedAt: "2026-08-08T08:01:00.000Z",
    receiptId: "opaque-new-receipt",
  });
  let confirmations = [oldConfirmation];
  const graphSource = graphProjectionSource();
  const { journal, store, values } = await localMemoryFixture();
  const confirmationProjectionSource = {
    async readMemoryPage({ cursor, limit, highWatermark }) {
      if (
        highWatermark !== null &&
        highWatermark !== confirmationRevision
      ) {
        throw new Error("confirmation source changed");
      }
      const page = confirmations.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length;
      return structuredClone({
        highWatermark: confirmationRevision,
        cursor,
        items: page,
        nextCursor: nextCursor < confirmations.length ? nextCursor : null,
      });
    },
  };
  let currentHead = oldBinding.headRefOid;
  const verificationCalls = new Map();
  let individualVerificationCalls = 0;
  const inputAuthorityVerifier = {
    async verify(binding) {
      individualVerificationCalls += 1;
      throw new Error(
        `unexpected individual verification for ${binding.headRefOid}`,
      );
    },
  };
  const inputAuthorityBatchVerifier = {
    async verify({ ledgerRevision, bindings }) {
      assert.equal(ledgerRevision, items[0].revision);
      const current = bindings.map((binding) => {
        const count = verificationCalls.get(binding.headRefOid) ?? 0;
        verificationCalls.set(binding.headRefOid, count + 1);
        return binding.headRefOid === currentHead;
      });
      return { ledgerRevision, current };
    },
  };
  const memoryAuthoritySource = {
    async readSnapshot({ limit }) {
      return structuredClone({
        ledgerRevision: items[0].revision,
        items,
        timeline,
        graph: await graphSource.readBatch({ limit }),
      });
    },
  };
  const createProjector = () => new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource,
    graphProjectionSource: graphSource,
    confirmationProjectionSource,
    inputAuthorityVerifier,
    inputAuthorityBatchVerifier,
    store,
  });
  const recordsFor = (kind) =>
    values.get("unified-memory-records").records.filter(
      (record) => record.source.kind === kind,
    );

  const first = await createProjector().runCycle();
  assert.equal(first.authorityBound.added, 5);
  assert.equal(individualVerificationCalls, 0);
  assert.equal(verificationCalls.get(oldBinding.headRefOid), 1);
  const verificationCallsAfterFirst = new Map(verificationCalls);
  const repeated = await createProjector().runCycle();
  assert.equal(repeated.added, 0);
  assert.deepEqual(verificationCalls, verificationCallsAfterFirst);
  assert.equal(
    journal.getAuthorityProjectionState().confirmationHighWatermark,
    1,
  );
  const initialByKind = Object.fromEntries([
    "work-decision",
    "consultation-request",
    "consultation-result",
    "confirmation",
    "external-result",
  ].map((kind) => [kind, recordsFor(kind)[0]]));
  assert.ok(Object.values(initialByKind).every(Boolean));
  const initialEntries = journal.readRecords({
    recordIds: Object.values(initialByKind).map(({ recordId }) => recordId),
  }).items;
  assert.deepEqual(
    initialEntries.map(({ labels }) => labels),
    Array.from({ length: 5 }, () => ({
      authority: "raw",
      lifecycle: "current",
    })),
  );
  const decisionContent = JSON.parse(initialByKind["work-decision"].content);
  assert.equal(decisionContent.workItemId, oldItem.itemId);
  assert.equal(decisionContent.workItemRevision, oldItem.revision);
  assert.equal(decisionContent.decision.outcome, "succeeded");
  assert.deepEqual(decisionContent.decision.value.evidence, [
    "confirmation:confirmation-old",
    "controlled-commit:controlled-old",
  ]);
  const confirmationContent = JSON.parse(initialByKind.confirmation.content);
  const externalContent = JSON.parse(initialByKind["external-result"].content);
  assert.equal(confirmationContent.action.bodyDigest, digestValue(secretBody));
  assert.equal(confirmationContent.action.bodyBytes, Buffer.byteLength(secretBody));
  assert.equal(Object.hasOwn(confirmationContent.action, "body"), false);
  assert.deepEqual(externalContent.receipt, { id: "opaque-old-receipt" });
  assert.deepEqual(externalContent.actor, oldConfirmation.actor);
  assert.deepEqual(externalContent.target, oldConfirmation.target);
  assert.equal(initialByKind.confirmation.content.includes(secretBody), false);
  assert.equal(initialByKind["external-result"].content.includes(secretBody), false);

  const malformedSealedUnknown = sealedUnknownConfirmationMemoryItem(
    oldBinding,
    {
      body: "malformed sealed unknown",
      revision: 2,
      updatedAt: "2026-08-08T07:02:00.000Z",
    },
  );
  malformedSealedUnknown.rejectedAt = null;
  malformedSealedUnknown.ownerDecision = null;
  confirmations = [malformedSealedUnknown];
  confirmationRevision = 2;
  const recordsBeforeMalformedProjection =
    values.get("unified-memory-records").records.length;
  await assert.rejects(
    createProjector().runCycle(),
    /confirmation memory projection item is invalid/u,
  );
  assert.equal(
    values.get("unified-memory-records").records.length,
    recordsBeforeMalformedProjection,
  );
  assert.equal(
    journal.getAuthorityProjectionState().confirmationHighWatermark,
    1,
  );

  currentHead = newBinding.headRefOid;
  items = [newItem];
  timeline = [
    proposalDecisionTimeline(newItem, "new"),
    ...consultationTimeline(newItem, "new", 5),
  ];
  confirmations = [oldConfirmation, newConfirmation];
  confirmationRevision = 2;
  const callsBeforeHeadChange = new Map(verificationCalls);
  const second = await createProjector().runCycle();
  assert.equal(individualVerificationCalls, 0);
  assert.equal(second.authorityBound.lifecycleInvalidations, 3);
  assert.equal(
    journal.getAuthorityProjectionState().confirmationHighWatermark,
    2,
  );
  assert.equal(
    verificationCalls.get(oldBinding.headRefOid) -
      callsBeforeHeadChange.get(oldBinding.headRefOid),
    1,
  );
  assert.equal(
    verificationCalls.get(newBinding.headRefOid) -
      (callsBeforeHeadChange.get(newBinding.headRefOid) ?? 0),
    1,
  );

  const oldEntries = journal.readRecords({
    recordIds: Object.values(initialByKind).map(({ recordId }) => recordId),
  }).items;
  assert.ok(oldEntries.every(({ labels }) => labels.lifecycle === "obsolete"));
  const currentRecords = [
    "work-decision",
    "consultation-request",
    "consultation-result",
    "confirmation",
    "external-result",
  ].map((kind) => recordsFor(kind).find((record) => {
    const content = JSON.parse(record.content);
    return content.authority.current === true &&
      content.authority.inputBinding?.headRefOid === newBinding.headRefOid;
  }));
  assert.ok(currentRecords.every(Boolean));
  assert.ok(journal.readRecords({
    recordIds: currentRecords.map(({ recordId }) => recordId),
  }).items.every(({ labels }) =>
    labels.authority === "raw" && labels.lifecycle === "current"
  ));
  const currentConfirmationContent = JSON.parse(currentRecords[3].content);
  const currentExternalResultContent = JSON.parse(currentRecords[4].content);
  assert.deepEqual(
    currentConfirmationContent.ownerDecision,
    newConfirmation.ownerDecision,
  );
  assert.deepEqual(
    currentExternalResultContent.ownerDecision,
    newConfirmation.ownerDecision,
  );

  const beforeRestartCount = values.get("unified-memory-records").records.length;
  const restarted = await createProjector().runCycle();
  assert.equal(restarted.added, 0);
  assert.equal(values.get("unified-memory-records").records.length, beforeRestartCount);
});

test("memory projector captures confirmation authority after earlier projection work", async () => {
  const binding = pullRequestExternalActionBinding();
  const item = pullRequestWorkItem(binding);
  const confirmation = completedConfirmationMemoryItem(binding);
  const graphSource = graphProjectionSource();
  const { journal, store } = await localMemoryFixture();
  let confirmationRevision = 1;
  let releaseWorkProjection;
  let reportWorkProjectionStarted;
  const workProjectionStarted = new Promise((resolve) => {
    reportWorkProjectionStarted = resolve;
  });
  const workProjectionRelease = new Promise((resolve) => {
    releaseWorkProjection = resolve;
  });
  const lifecycle = {
    appendAuthorityProjection: (value) =>
      journal.appendAuthorityProjection(value),
    appendProjectionRecords: (value) =>
      journal.appendProjectionRecords(value),
    async appendWorkItems(value) {
      reportWorkProjectionStarted();
      await workProjectionRelease;
      return journal.appendWorkItems(value);
    },
    appendGraphEvents: (value) => journal.appendGraphEvents(value),
    adoptGraphCheckpoint: (value) => journal.adoptGraphCheckpoint(value),
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: lifecycle,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
    confirmationProjectionSource: {
      async readMemoryPage({ cursor, limit, highWatermark }) {
        if (
          highWatermark !== null &&
          highWatermark !== confirmationRevision
        ) {
          throw new Error("confirmation source changed");
        }
        const items = [confirmation].slice(cursor, cursor + limit);
        return structuredClone({
          highWatermark: confirmationRevision,
          cursor,
          items,
          nextCursor: null,
        });
      },
    },
    inputAuthorityVerifier: {
      async verify(value) {
        return structuredClone(value);
      },
    },
    store,
  });

  const cycle = projector.runCycle();
  await workProjectionStarted;
  confirmationRevision = 2;
  releaseWorkProjection();
  const result = await cycle;

  assert.equal(result.authorityBound.highWatermark, 2);
  assert.equal(
    journal.getAuthorityProjectionState().confirmationHighWatermark,
    2,
  );
});

test("projection without an authority verifier still advances an empty authority checkpoint", async () => {
  const { journal, store } = await localMemoryFixture();
  const graphSource = graphProjectionSource();
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([], [], graphSource, 7),
    graphProjectionSource: graphSource,
    store,
  });
  await projector.runCycle();
  assert.equal(journal.getAuthorityProjectionState().workLedgerRevision, 7);
  assert.deepEqual(journal.getAuthorityProjectionState().entries, []);
});

for (const mode of ["once", "persistent", "unknown", "aborted"]) {
  test(`authority snapshot contention is bounded without replaying historical projection (${mode})`, async () => {
    const binding = pullRequestExternalActionBinding();
    const item = pullRequestWorkItem(binding);
    const graphSource = graphProjectionSource();
    const { journal, store, values } = await localMemoryFixture();
    let revision = 1, historyWrites = 0, workWrites = 0, authorityWrites = 0;
    const verified = [];
    const controller = new AbortController();
    const failure = Object.assign(new Error("snapshot changed"), {
      code: mode === "unknown" ? "MEMORY_STORAGE_FAILED" : "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE",
    });
    const projector = new MemoryProjector({
      memoryLifecycleProducer: {
        appendGraphEvents: input => journal.appendGraphEvents(input),
        adoptGraphCheckpoint: input => journal.adoptGraphCheckpoint(input),
        appendProjectionRecords: input => { historyWrites++; return journal.appendProjectionRecords(input); },
        appendWorkItems: input => { workWrites++; return journal.appendWorkItems(input); },
        appendAuthorityProjection: input => { authorityWrites++; return journal.appendAuthorityProjection(input); },
      },
      memoryAuthorityReader: journal,
      memoryAuthoritySource: { async readSnapshot({ limit }) {
        return { ledgerRevision: revision, items: [item], timeline: [proposalDecisionTimeline(item, "contention")],
          graph: await graphSource.readBatch({ limit }) };
      } },
      graphProjectionSource: graphSource,
      inputAuthorityVerifier: { async verify() { assert.fail("batch verification is required"); } },
      inputAuthorityBatchVerifier: { async verify({ ledgerRevision, bindings }) {
        verified.push(ledgerRevision);
        if (mode !== "once" || verified.length === 1) {
          revision++;
          if (mode === "aborted") controller.abort(failure);
          throw failure;
        }
        assert.equal(ledgerRevision, revision, "retry must capture a new ledger snapshot");
        return { ledgerRevision, current: bindings.map(() => false) };
      } }, store,
    });
    const cycle = projector.runCycle({ signal: controller.signal });
    if (["unknown", "aborted"].includes(mode)) {
      await assert.rejects(cycle, error => error === failure);
      assert.equal(verified.length, 1);
    } else {
      const result = await cycle;
      assert.deepEqual(verified, [1, 2]);
      if (mode === "persistent") {
        assert.equal(result.authorityBound.status, "deferred");
        assert.equal(result.authorityBound.code, failure.code);
        assert.equal(result.authorityBound.attempts, 2);
      } else {
        assert.equal(journal.getAuthorityProjectionState().workLedgerRevision, 2);
        const records = values.get("unified-memory-records").records.filter(record => record.source.kind === "work-decision");
        assert.ok(records.length > 0);
        assert.ok(records.every(record => JSON.parse(record.content).authority.current === false));
      }
    }
    assert.equal(historyWrites, 1);
    assert.equal(workWrites, 1);
    assert.equal(authorityWrites, mode === "once" ? 1 : 0);
  });
}

test("authority verification runs once per distinct binding for a large projection cycle", async () => {
  const bindingFor = (number, marker) => pullRequestExternalActionBinding({
    repository: `acme/repo-${number}`,
    pullRequestNumber: number,
    rootItemId: `github:pr:acme/repo-${number}#${number}`,
    workKey: `pr:acme/repo-${number}#${number}`,
    eventId: `github-event-${number}`,
    eventDigest: marker.repeat(64),
    inputDigest: String((Number(marker) + 1) % 10).repeat(64),
    headRefOid: marker.repeat(40),
    gitTarget: {
      baseRepository: `acme/repo-${number}`,
      headRepository: `contributor/repo-${number}`,
      headRefOid: marker.repeat(40),
    },
  });
  const bindings = [
    bindingFor(51, "5"),
    bindingFor(61, "6"),
    bindingFor(71, "7"),
  ];
  const items = bindings.map((binding, index) => pullRequestWorkItem(binding, {
    revision: index + 2,
    updatedAt: `2026-08-08T09:0${index}:00.000Z`,
  }));
  const timeline = items.flatMap((item, itemIndex) =>
    Array.from({ length: 75 }, (_, index) => {
      const entry = proposalDecisionTimeline(
        item,
        `bulk-${itemIndex}-${index}`,
      );
      entry.sequence = itemIndex * 75 + index + 1;
      return entry;
    })
  );
  const graphSource = graphProjectionSource();
  const { journal, store } = await localMemoryFixture();
  const calls = new Map();
  const validHeads = new Set(bindings.slice(0, 2).map(({ headRefOid }) => headRefOid));
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource(
      items,
      timeline,
      graphSource,
      10,
    ),
    graphProjectionSource: graphSource,
    inputAuthorityVerifier: {
      async verify(binding) {
        calls.set(binding.headRefOid, (calls.get(binding.headRefOid) ?? 0) + 1);
        if (!validHeads.has(binding.headRefOid)) {
          throw new Error("not authoritative");
        }
        return structuredClone(binding);
      },
    },
    store,
  });

  const result = await projector.runCycle();

  assert.equal(result.authorityBound.decisions, 225);
  assert.deepEqual([...calls.values()], [1, 1, 1]);
  const matches = journal.search({
    q: "Push decision bulk-2",
    repository: bindings[2].repository,
    limit: 20,
  }).items;
  assert.ok(matches.length > 0);
  const decisionMatches = matches.filter(
    ({ source }) => source.kind === "work-decision",
  );
  assert.ok(decisionMatches.length > 0);
  assert.ok(journal.readRecords({
    recordIds: decisionMatches.map(({ id }) => id),
  }).items.every(({ labels }) => labels.lifecycle === "obsolete"));
});

test("an interrupted authority projection cannot orphan current records across a Head change", async () => {
  const oldBinding = pullRequestExternalActionBinding();
  const newHead = "7".repeat(40);
  const newBinding = pullRequestExternalActionBinding({
    inputRevision: 2,
    headRevision: 2,
    headRefOid: newHead,
    eventId: "github-event-42-head-2",
    eventDigest: "8".repeat(64),
    inputDigest: "9".repeat(64),
    gitTarget: { headRefOid: newHead },
  });
  const oldItem = pullRequestWorkItem(oldBinding);
  const newItem = pullRequestWorkItem(newBinding, {
    revision: 8,
    updatedAt: "2026-08-08T10:00:00.000Z",
  });
  let items = [oldItem];
  let timeline = Array.from({ length: 125 }, (_, index) => {
    const entry = proposalDecisionTimeline(oldItem, `interrupted-${index}`);
    entry.sequence = index + 1;
    return entry;
  });
  let currentHead = oldBinding.headRefOid;
  let failAuthorityCommit = true;
  const values = new Map();
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      if (
        key === MEMORY_JOURNAL_KEY &&
        value.lifecycleAuthority?.authorityProjection?.revision > 0 &&
        failAuthorityCommit
      ) {
        failAuthorityCommit = false;
        throw new Error("injected atomic authority commit failure");
      }
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();
  const graphSource = graphProjectionSource();
  const source = {
    async readSnapshot({ limit }) {
      return structuredClone({
        ledgerRevision: items[0].revision,
        items,
        timeline,
        graph: await graphSource.readBatch({ limit }),
      });
    },
  };
  const createProjector = () => new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: source,
    graphProjectionSource: graphSource,
    inputAuthorityVerifier: {
      async verify(binding) {
        if (binding.headRefOid !== currentHead) throw new Error("stale Head");
        return structuredClone(binding);
      },
    },
    store,
  });

  await assert.rejects(
    createProjector().runCycle(),
    /injected atomic authority commit failure/,
  );
  assert.equal(
    values.get(MEMORY_JOURNAL_KEY).records.some(
      ({ source }) => source.kind === "work-decision",
    ),
    false,
  );

  currentHead = newBinding.headRefOid;
  items = [newItem];
  timeline = [proposalDecisionTimeline(newItem, "after-restart")];
  await createProjector().runCycle();

  const decisions = values.get(MEMORY_JOURNAL_KEY).records.filter(
    ({ source }) => source.kind === "work-decision",
  );
  assert.equal(decisions.length, 1);
  assert.equal(
    JSON.parse(decisions[0].content).authority.inputBinding.headRefOid,
    newBinding.headRefOid,
  );
  assert.equal(
    journal.getAuthorityProjectionState().confirmationHighWatermark,
    0,
  );
});

test("a failed Head-change authority commit fences old memory immediately and after restart", async () => {
  const oldBinding = pullRequestExternalActionBinding();
  const newHead = "4".repeat(40);
  const newBinding = pullRequestExternalActionBinding({
    inputRevision: 2,
    headRevision: 2,
    headRefOid: newHead,
    eventId: "github-event-42-head-2-fenced",
    eventDigest: "5".repeat(64),
    inputDigest: "6".repeat(64),
    gitTarget: { headRefOid: newHead },
  });
  const oldItem = pullRequestWorkItem(oldBinding);
  const newItem = pullRequestWorkItem(newBinding, {
    revision: oldItem.revision + 1,
    updatedAt: "2026-08-08T10:01:00.000Z",
  });
  let items = [oldItem];
  let timeline = [proposalDecisionTimeline(oldItem, "old-current")];
  let currentHead = oldBinding.headRefOid;
  let failAuthorityCommit = false;
  const values = new Map();
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      if (
        failAuthorityCommit &&
        key === MEMORY_JOURNAL_KEY &&
        value.lifecycleAuthority?.authorityProjection?.revision > 1
      ) {
        throw new Error("injected changed-Head authority commit failure");
      }
      values.set(key, structuredClone(value));
    },
  };
  const graphSource = graphProjectionSource();
  const authoritySource = {
    async readStatus() {
      return {
        ledgerRevision: items[0].revision,
        graph: {
          cursor: 0,
          highWatermark: 0,
          checkpointDigest: null,
          highWatermarkDigest: null,
          authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        },
      };
    },
  };
  const createRuntime = () => createMemoryRuntime({
    store,
    authoritySource,
    createGuard: () => ({
      async acquire() {},
      async run(operation) { return operation(); },
      async close() {},
    }),
  });
  let runtime = await createRuntime();
  const snapshotSource = {
    async readSnapshot({ limit }) {
      return structuredClone({
        ledgerRevision: items[0].revision,
        items,
        timeline,
        graph: await graphSource.readBatch({ limit }),
      });
    },
  };
  const createProjector = () => new MemoryProjector({
    memoryLifecycleProducer: runtime.lifecycleProducer,
    memoryAuthorityReader: runtime.authorityReader,
    memoryAuthoritySource: snapshotSource,
    graphProjectionSource: graphSource,
    inputAuthorityVerifier: {
      async verify(binding) {
        if (binding.headRefOid !== currentHead) throw new Error("stale Head");
        return structuredClone(binding);
      },
    },
    store,
  });

  await createProjector().runCycle();
  assert.equal(
    runtime.authorityReader.getAuthorityProjectionState().workLedgerRevision,
    oldItem.revision,
  );
  assert.ok((await runtime.search.search({ q: "old-current" })).items.length > 0);

  currentHead = newBinding.headRefOid;
  items = [newItem];
  timeline = [proposalDecisionTimeline(newItem, "new-current")];
  failAuthorityCommit = true;
  await assert.rejects(
    createProjector().runCycle(),
    /injected changed-Head authority commit failure/,
  );
  assert.equal(
    runtime.authorityReader.getAuthorityState().workLedgerRevision,
    newItem.revision,
  );
  assert.equal(
    runtime.authorityReader.getAuthorityProjectionState().workLedgerRevision,
    oldItem.revision,
  );
  await assert.rejects(
    runtime.search.search({ q: "old-current" }),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );

  await runtime.close();
  runtime = await createRuntime();
  await assert.rejects(
    runtime.search.search({ q: "old-current" }),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  await runtime.close();
});

test("legacy PR decisions and consultations without immutable timeline bindings stay non-authoritative", async () => {
  const binding = pullRequestExternalActionBinding();
  const item = pullRequestWorkItem(binding);
  const decision = proposalDecisionTimeline(item, "legacy");
  delete decision.details.inputBinding;
  const timeline = [
    decision,
    {
      timelineId: "work-timeline-legacy-consultation-request",
      sequence: 2,
      itemId: item.itemId,
      type: "intent_staged",
      at: item.updatedAt,
      actorId: "pr-engineer",
      details: {
        intentType: "ask_user",
        consultationRequest: {
          summary: "Legacy request",
          reason: "Unsealed history",
          question: "Should this old request be trusted?",
          choices: [],
        },
      },
    },
    {
      timelineId: "work-timeline-legacy-consultation-result",
      sequence: 3,
      itemId: item.itemId,
      type: "attention_answer_applied",
      at: item.updatedAt,
      actorId: "attention-result-reconciler",
      details: {
        answer: { choiceId: "yes" },
        requestContentDigest: "a".repeat(64),
        resultDigest: "b".repeat(64),
      },
    },
  ];
  const graphSource = graphProjectionSource();
  const { journal, store } = await localMemoryFixture();
  let verificationCalls = 0;
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource(
      [item],
      timeline,
      graphSource,
    ),
    graphProjectionSource: graphSource,
    inputAuthorityVerifier: {
      async verify(value) {
        verificationCalls += 1;
        return value;
      },
    },
    store,
  });

  const result = await projector.runCycle();

  assert.equal(result.authorityBound.decisions, 0);
  assert.equal(result.authorityBound.consultations, 0);
  assert.equal(verificationCalls, 0);
  for (const kind of [
    "work-decision",
    "consultation-request",
    "consultation-result",
  ]) {
    assert.equal(journal.search({ q: kind }).items.some(
      ({ source }) => source.kind === kind,
    ), false);
  }
});

test("confirmation projection page capacity fails before any memory or state write", async () => {
  const binding = pullRequestExternalActionBinding();
  const template = completedConfirmationMemoryItem(binding);
  const confirmations = Array.from({ length: 1_000 }, (_, index) => {
    const confirmationId = `confirmation-capacity-${String(index).padStart(4, "0")}`;
    return {
      ...structuredClone(template),
      confirmationId,
      statusDigest: digestValue({
        confirmationId,
        itemRevision: template.itemRevision,
        status: template.status,
        approvalBindingDigest: template.approvalBindingDigest,
        updatedAt: template.updatedAt,
      }),
    };
  });
  const graphSource = graphProjectionSource();
  let memoryWrites = 0;
  let stateWrites = 0;
  let verificationCalls = 0;
  const rejectWrite = async () => {
    memoryWrites += 1;
    throw new Error("must fail before memory write");
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: {
      appendAuthorityProjection: rejectWrite,
      appendWorkItems: rejectWrite,
      appendGraphEvents: rejectWrite,
      appendProjectionRecords: rejectWrite,
      adoptGraphCheckpoint: rejectWrite,
    },
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], graphSource),
    graphProjectionSource: graphSource,
    confirmationProjectionSource: {
      async readMemoryPage({ cursor, limit }) {
        return {
          highWatermark: 1,
          cursor,
          items: confirmations.slice(cursor, cursor + limit),
          nextCursor: cursor + limit,
        };
      },
    },
    inputAuthorityVerifier: {
      async verify(value) {
        verificationCalls += 1;
        return value;
      },
    },
    store: {
      async read(_key, fallback = null) { return fallback; },
      async write() { stateWrites += 1; },
    },
  });

  await assert.rejects(
    projector.runCycle(),
    /confirmation memory projection exceeds page capacity/,
  );
  assert.equal(memoryWrites, 0);
  assert.equal(stateWrites, 0);
  assert.equal(verificationCalls, 0);
});

test("graph contracts and deliveries remain searchable without retained timeline events", async () => {
  const item = workItem(3, "completed", 4);
  item.graph = {
    parentItemId: "work-1",
    dependsOnItemIds: ["work-2"],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: "2026-08-02T01:00:00.000Z",
      },
      {
        revision: 2,
        acceptanceCriteria: [
          {
            criterionId: "tests-pass",
            description: "All regression tests pass",
          },
        ],
        expectedDeliverables: [
          {
            deliverableId: "test-report",
            kind: "test-report",
            description: "Regression test evidence",
            required: true,
          },
        ],
        recordedAt: "2026-08-04T02:00:00.000Z",
      },
    ],
    deliveries: [
      {
        deliverableId: "test-report",
        revision: 1,
        contractRevision: 2,
        status: "submitted",
        summary: "Submitted 1218 regression results",
        evidence: [
          {
            kind: "test-report",
            referenceId: "artifact-test-report",
            contentDigest: "a".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T03:00:00.000Z",
      },
      {
        deliverableId: "test-report",
        revision: 2,
        contractRevision: 2,
        status: "accepted",
        summary: "Regression evidence accepted",
        evidence: [
          {
            kind: "test-report",
            referenceId: "artifact-test-report",
            contentDigest: "a".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:00:00.000Z",
      },
    ],
  };
  const events = graphEventsForItem(item);
  const graphSource = graphProjectionSource(events);
  const journal = await localMemoryJournal();
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  const first = await projector.runCycle();
  item.revision = 5;
  item.updatedAt = "2026-08-02T01:00:05.000Z";
  item.currentTarget = { type: "role", id: "tester" };
  item.graph.dependsOnItemIds = ["work-1"];
  const second = await projector.runCycle();
  const third = await projector.runCycle();

  assert.equal(first.observed, 5);
  assert.equal(first.added, 5);
  assert.equal(second.added, 1);
  assert.equal(third.added, 0);
  const [oldContractId, contractId, submittedId, acceptedId] = events.map(
    (event) => workGraphMemoryRecordReceipt(event).memoryRecordId,
  );
  const graphRecords = journal.readRecords({
    recordIds: [oldContractId, contractId, submittedId, acceptedId],
  }).items;
  const [oldContractEntry, contractEntry, submittedEntry, acceptedEntry] =
    graphRecords;
  const contract = contractEntry.record;
  const submitted = submittedEntry.record;
  const accepted = acceptedEntry.record;
  assert.equal(contract.roleId, null);
  assert.equal(submitted.roleId, null);
  assert.match(contract.content, /All regression tests pass/);
  assert.match(contract.content, /Regression test evidence/);
  assert.doesNotMatch(contract.content, /dependsOnItemIds/);
  assert.equal(contract.occurredAt, "2026-08-04T02:00:00.000Z");
  assert.equal(submitted.eventType, "work.delivery_submitted");
  assert.equal(submitted.occurredAt, "2026-08-05T03:00:00.000Z");
  assert.match(submitted.summary, /1218 regression results/);
  assert.match(submitted.content, /artifact-test-report/);
  assert.match(submitted.content, new RegExp("a{64}"));
  assert.equal(accepted.eventType, "work.delivery_accepted");
  assert.equal(accepted.occurredAt, "2026-08-05T04:00:00.000Z");
  assert.deepEqual(accepted.evidence, [
    `test-report:artifact-test-report:${"a".repeat(64)}`,
  ]);
  assert.deepEqual(
    graphRecords.map(({ labels }) => labels.lifecycle),
    ["obsolete", "current", "current", "current"],
  );
  assert.equal(oldContractEntry.record.source.kind, "work-contract");
  assert.equal(
    journal.search({ eventType: "work.graph_record_obsoleted" }).items.length,
    0,
  );
});

test("schema 1 memory adopts a non-zero graph checkpoint before pending events", async () => {
  const values = new Map([
    ["unified-memory-records", {
      schemaVersion: 1,
      revision: 1,
      records: [],
    }],
  ]);
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();

  const item = workItem(11, "completed", 4);
  item.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-04T02:00:00.000Z",
    }],
    deliveries: [],
  };
  const checkpointDigest = "a".repeat(64);
  const event = createWorkGraphMemoryEvent({
    sequence: 8,
    previousDigest: checkpointDigest,
    ledgerRevision: 8,
    taskRevision: item.revision,
    item,
    kind: "acceptance_contract",
    record: item.graph.acceptanceContracts[0],
  });
  const authorityStateDigest = event.authorityStateDigest ?? EMPTY_AUTHORITY_STATE_DIGEST;
  let cursor = 7;
  const acknowledgements = [];
  const graphSource = {
    async readBatch({ limit }) {
      return structuredClone({
        cursor,
        highWatermark: event.sequence,
        checkpointDigest: cursor === 7 ? checkpointDigest : event.eventDigest,
        highWatermarkDigest: event.eventDigest,
        authorityStateDigest,
        items: cursor === 7 ? [event].slice(0, limit) : [],
      });
    },
    async ackBatch({ receipts }) {
      assert.deepEqual(receipts, [workGraphMemoryRecordReceipt(event)]);
      acknowledgements.push(structuredClone(receipts));
      cursor = event.sequence;
      return {
        status: "applied",
        cursor,
        highWatermark: event.sequence,
      };
    },
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource, 8),
    graphProjectionSource: graphSource,
    store,
  });

  const result = await projector.runCycle();

  assert.equal(result.graph.added, 1);
  assert.equal(result.graph.cursor, 8);
  assert.equal(acknowledgements.length, 1);
  const persisted = values.get("unified-memory-records");
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.lifecycleAuthority.baseCursor, 7);
  assert.equal(persisted.lifecycleAuthority.graphCursor, 8);
  const recovered = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await recovered.recover();
  assert.equal(recovered.getAuthorityState().cursor, 8);
  assert.equal(recovered.getAuthorityState().checkpointDigest, event.eventDigest);
});

test("schema 1 recovery adopts its checkpoint without retaining non-citable PR timelines", async () => {
  const values = new Map([
    ["unified-memory-records", {
      schemaVersion: 1,
      revision: 1,
      records: [],
    }],
  ]);
  const store = {
    async read(key, fallback = null) {
      return structuredClone(values.has(key) ? values.get(key) : fallback);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
  });
  await journal.recover();

  const item = workItem(12, "cancelled", 2);
  item.kind = "assignment";
  item.source = null;
  item.event.eventType = "pull_request.observed";
  item.event.subject.id = "github:pr:acme/repo#12";
  const timeline = [{
    timelineId: "legacy-pr-timeline-12",
    sequence: 1,
    itemId: item.itemId,
    type: "assignment_intaken",
    at: "2026-08-02T01:00:01.000Z",
    actorId: "work-ledger-system",
    details: { sourceSequence: 12 },
  }];
  const checkpointDigest = "b".repeat(64);
  const graphSource = {
    async readBatch() {
      return {
        cursor: 7,
        highWatermark: 7,
        checkpointDigest,
        highWatermarkDigest: checkpointDigest,
        authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
        items: [],
      };
    },
    async ackBatch() {
      throw new Error("checkpoint-only recovery must not acknowledge events");
    },
  };
  const projector = new MemoryProjector({
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource(
      [item],
      timeline,
      graphSource,
      8,
    ),
    graphProjectionSource: graphSource,
    store,
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(journal.getAuthorityState().cursor, 7);
  assert.equal(journal.getAuthorityState().workLedgerRevision, 8);
  assert.deepEqual(journal.search({
    eventType: "timeline.assignment_intaken",
  }).items, []);
});

test("superseded work invalidates prior work revisions and every graph delivery without deleting history", async () => {
  const item = workItem(9, "completed", 3);
  item.updatedAt = "2026-08-05T05:00:00.000Z";
  item.graph = {
    parentItemId: "work-1",
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: "2026-08-05T03:00:00.000Z",
      },
    ],
    deliveries: [
      {
        deliverableId: "conflict-fix",
        revision: 1,
        contractRevision: 1,
        status: "submitted",
        summary: "Old provenance conflict fix",
        evidence: [
          {
            kind: "test-report",
            referenceId: "old-conflict-test",
            contentDigest: "b".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:00:00.000Z",
      },
      {
        deliverableId: "conflict-fix",
        revision: 2,
        contractRevision: 1,
        status: "accepted",
        summary: "Old provenance evidence accepted",
        evidence: [
          {
            kind: "test-report",
            referenceId: "old-conflict-test",
            contentDigest: "b".repeat(64),
          },
        ],
        recordedAt: "2026-08-05T04:30:00.000Z",
      },
    ],
  };
  const events = graphEventsForItem(item);
  const contractId = workGraphMemoryRecordReceipt(events[0]).memoryRecordId;
  const submittedId = workGraphMemoryRecordReceipt(events[1]).memoryRecordId;
  const acceptedId = workGraphMemoryRecordReceipt(events[2]).memoryRecordId;
  const journal = await localMemoryJournal();
  const graphSource = graphProjectionSource(events);
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: memoryAuthoritySource([item], [], graphSource),
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  await projector.runCycle();
  const completedWorkId = journal.search({
    eventType: "work.completed",
  }).items[0].id;
  assert.deepEqual(
    journal.readRecords({ recordIds: [submittedId, acceptedId] })
      .items.map(({ labels }) => labels.lifecycle),
    ["current", "current"],
  );

  item.status = "superseded";
  item.statusReason = "pr_head_superseded";
  item.revision = 4;
  item.updatedAt = "2026-08-05T06:00:00.000Z";
  item.event.payload.title = "Renamed after a new PR Head";
  item.decisionContext = { conclusion: "stale old-Head conclusion" };
  const result = await projector.runCycle();

  assert.equal(result.graph.observed, 0);
  assert.equal(result.added, 1);
  assert.deepEqual(
    journal.readRecords({
      recordIds: [completedWorkId, contractId, submittedId, acceptedId],
    })
      .items.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete", "obsolete", "obsolete"],
  );
  assert.equal(
    journal.search({ eventType: "work.graph_record_obsoleted" }).items.length,
    0,
  );
  const supersededWork = journal.search({
    eventType: "work.superseded",
  }).items[0];
  assert.equal(
    JSON.parse(journal.readRecords({ recordIds: [supersededWork.id] })
      .items[0].record.content).decisionContext,
    null,
  );

  const packet = await new MemoryContextRetriever({
    memorySearch: { search: (value) => journal.search(value) },
    contextReader: {
      readRecords: (value) => journal.readRecords(value),
    },
  }).retrieve({
    question: "旧冲突修复现在是否仍有效？",
    retrieval: {
      kind: "query",
      filters: {
        query: "Old provenance conflict fix",
        repository: "acme/repo",
      },
    },
  });
  const deliveryRecords = packet.records.filter(({ recordId }) =>
    [submittedId, acceptedId].includes(recordId)
  );
  assert.deepEqual(
    new Set(deliveryRecords.map(({ recordId }) => recordId)),
    new Set([submittedId, acceptedId]),
  );
  assert.deepEqual(
    deliveryRecords.map(({ labels }) => labels.lifecycle),
    ["obsolete", "obsolete"],
  );
  assert.equal(packet.citableRecordIds.includes(submittedId), false);
  assert.equal(packet.citableRecordIds.includes(acceptedId), false);
});

test("memory projector coalesces concurrent runs", async () => {
  let release;
  let calls = 0;
  const items = [workItem(1, "queued")];
  const graphSource = graphProjectionSource();
  const memoryProducer = { async appendBatch() { return { added: 0 }; } };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: {
      ...memoryLifecycleProducer(memoryProducer),
      async appendWorkItems() {
        await new Promise((resolve) => { release = resolve; });
        return { added: 1 };
      },
    },
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: {
      async readSnapshot({ limit }) {
        calls += 1;
        return {
          ledgerRevision: 1,
          items,
          timeline: [],
          graph: await graphSource.readBatch({ limit }),
        };
      },
    },
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });

  const admitted = new AbortController();
  const joining = new AbortController();
  const first = projector.runCycle({ signal: admitted.signal });
  const second = projector.runCycle({ signal: joining.signal });
  assert.strictEqual(first, second);
  joining.abort(new Error("a joiner cannot cancel the admitted cycle"));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(calls, 2);
});

test("memory projector stops after the admitted write when shutdown is requested", async () => {
  let releaseWrite;
  let markWriteStarted;
  let authorityReads = 0;
  let settled = false;
  const writeStarted = new Promise((resolve) => {
    markWriteStarted = resolve;
  });
  const writeReleased = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const graphSource = graphProjectionSource();
  const memoryProducer = { async appendBatch() { return { added: 0 }; } };
  const lifecycle = {
    ...memoryLifecycleProducer(memoryProducer),
    async appendWorkItems() {
      markWriteStarted();
      await writeReleased;
      return { added: 0 };
    },
  };
  const authorityReader = {
    ...emptyMemoryAuthorityReader(),
    async getAuthorityProjectionState() {
      authorityReads += 1;
      return emptyMemoryAuthorityReader().getAuthorityProjectionState();
    },
    async requiresAuthorityProjectionCheckpoint() {
      throw new Error("must not continue after shutdown");
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: lifecycle,
    memoryAuthorityReader: authorityReader,
    memoryAuthoritySource: memoryAuthoritySource([], [], graphSource),
    graphProjectionSource: graphSource,
    store: { async read() { return []; } },
  });
  const controller = new AbortController();
  const shutdown = new Error("shutdown requested");

  const cycle = projector.runCycle({ signal: controller.signal });
  cycle.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await writeStarted;
  controller.abort(shutdown);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the admitted write must not be abandoned");

  releaseWrite();
  await assert.rejects(cycle, (error) => error === shutdown);
  assert.equal(authorityReads, 0, "no later projection port may be entered");
});

test("memory projector rejects malformed atomic authority snapshots before writes", async () => {
  const producer = { async appendBatch() { throw new Error("must not write"); } };
  const store = { async read() { return []; } };
  const graphSource = graphProjectionSource();
  const malformed = new MemoryProjector({
    memoryProducer: producer,
    memoryLifecycleProducer: memoryLifecycleProducer(producer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: {
      async readSnapshot() {
        return { ledgerRevision: 1, items: null, timeline: [], graph: null };
      },
    },
    graphProjectionSource: graphSource,
    store,
  });
  await assert.rejects(malformed.runCycle(), /authority snapshot is invalid/);
});

test("task graph projection is bounded to 100 events per cycle", async () => {
  const task = workItem(9, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  let previousDigest = null;
  const events = Array.from({ length: 101 }, (_, index) => {
    const event = createWorkGraphMemoryEvent({
      sequence: index + 1,
      previousDigest,
      ledgerRevision: 1,
      taskRevision: 1,
      item: task,
      kind: "acceptance_contract",
      record: task.graph.acceptanceContracts[0],
    });
    previousDigest = event.eventDigest;
    return event;
  });
  const records = new Set();
  const source = graphProjectionSource(events);
  const memoryProducer = {
    async appendBatch({ records: supplied }) {
      const items = supplied.map((candidate) => {
        const record = normalizeMemoryRecord(candidate);
        const created = !records.has(record.recordId);
        records.add(record.recordId);
        return { recordId: record.recordId, created };
      });
      return {
        added: items.filter(({ created }) => created).length,
        items,
      };
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  const first = await projector.runCycle();
  const second = await projector.runCycle();
  assert.equal(first.graph.observed, 100);
  assert.equal(first.graph.acknowledged, 100);
  assert.equal(first.graph.pending, 1);
  assert.equal(second.graph.observed, 1);
  assert.equal(second.graph.pending, 0);
  assert.deepEqual(source.acknowledgements.map(({ length }) => length), [100, 1]);
});

test("a lost graph acknowledgement response resumes from the durable cursor", async () => {
  const task = workItem(8, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  const event = graphEventsForItem(task)[0];
  const source = graphProjectionSource([event]);
  const originalAckBatch = source.ackBatch;
  let failAck = true;
  source.ackBatch = async function (request) {
    const result = await originalAckBatch.call(this, request);
    if (failAck) {
      failAck = false;
      throw new Error("ack response lost");
    }
    return result;
  };
  const records = new Set();
  let appendCalls = 0;
  const memoryProducer = {
    async appendBatch({ records: supplied }) {
      appendCalls += 1;
      const items = supplied.map((candidate) => {
        const record = normalizeMemoryRecord(candidate);
        const created = !records.has(record.recordId);
        records.add(record.recordId);
        return { recordId: record.recordId, created };
      });
      return {
        added: items.filter(({ created }) => created).length,
        items,
      };
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  await assert.rejects(projector.runCycle(), /ack response lost/);
  const retried = await projector.runCycle();
  assert.equal(retried.graph.added, 0);
  assert.equal(retried.graph.cursor, 1);
  assert.equal(records.size, 1);
  assert.equal(appendCalls, 1);
});

test("a lost graph append response replays idempotently before batch acknowledgement", async () => {
  const task = workItem(10, "queued", 1);
  task.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
      recordedAt: "2026-08-02T01:00:00.000Z",
    }],
    deliveries: [],
  };
  const source = graphProjectionSource(graphEventsForItem(task));
  const records = new Set();
  let appendCalls = 0;
  let loseResponse = true;
  const memoryProducer = {
    async appendBatch({ records: supplied }) {
      appendCalls += 1;
      const items = supplied.map((candidate) => {
        const record = normalizeMemoryRecord(candidate);
        const created = !records.has(record.recordId);
        records.add(record.recordId);
        return { recordId: record.recordId, created };
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("append response lost");
      }
      return {
        added: items.filter(({ created }) => created).length,
        items,
      };
    },
  };
  const projector = new MemoryProjector({
    memoryProducer,
    memoryLifecycleProducer: memoryLifecycleProducer(memoryProducer),
    memoryAuthorityReader: emptyMemoryAuthorityReader(),
    memoryAuthoritySource: memoryAuthoritySource([], [], source),
    graphProjectionSource: source,
    store: { async read() { return []; } },
  });

  await assert.rejects(projector.runCycle(), /append response lost/);
  assert.equal(source.acknowledgements.length, 0);
  const retried = await projector.runCycle();
  assert.equal(retried.graph.added, 0);
  assert.equal(retried.graph.cursor, 1);
  assert.equal(records.size, 1);
  assert.equal(appendCalls, 2);
  assert.deepEqual(source.acknowledgements.map(({ length }) => length), [1]);
});


test("an unbound consultation leaving the projection window is explicitly retired and survives restart", async () => {
  const values = new Map();
  const store = { read: async (key, fallback = null) => structuredClone(values.get(key) ?? fallback),
    write: async (key, value) => { values.set(key, structuredClone(value)); } };
  const journal = new LocalMemoryJournal({ store, exclusiveLease: { run: operation => operation() } });
  await journal.recover();
  const candidate = { schemaVersion: 1, source: { kind: "consultation-request", id: "window-consultation" },
    occurredAt: "2026-08-02T01:00:00.000Z", roleId: null, repository: null,
    eventType: "consultation_request.fixture", title: "Historical consultation", summary: "Read-only history",
    content: JSON.stringify({ memoryType: "consultation-request", authority: {
      applies: false, current: true, bindingDigest: null, inputBinding: null,
    } }), evidence: [], tags: ["consultation-request"], sourceUrl: null, subjectNumber: null };
  const record = normalizeMemoryRecord(candidate);
  await journal.appendAuthorityProjection({ records: [candidate], projectionState: {
    schemaVersion: 4, revision: 1, workLedgerRevision: 0, authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST,
    confirmationHighWatermark: 0, entries: [{ key: "consultation-request:window", fingerprint: "a".repeat(64),
      recordId: record.recordId, sourceKind: "consultation-request", binding: null, current: true, occurredAt: candidate.occurredAt }],
  } });
  const planned = await planAuthorityBoundProjectionCandidate({ stored: journal.getAuthorityProjectionState(),
    snapshot: { ledgerRevision: 0, items: [], timeline: [], graph: { cursor: 0, highWatermark: 0,
      checkpointDigest: null, highWatermarkDigest: null, authorityStateDigest: EMPTY_AUTHORITY_STATE_DIGEST, items: [] } },
    confirmationSnapshot: { highWatermark: 0, items: [] }, verifyInputAuthority: async () => assert.fail("no PR binding"),
    requiresJournalAdoption: false, strictBindings: true });
  assert.equal(planned.lifecycleInvalidations, 1);
  assert.deepEqual(planned.records[0].evidence, [`supersedes:${record.recordId}`]);
  assert.deepEqual(planned.projectionState.entries, []);
  await journal.appendAuthorityProjection({ records: planned.records, projectionState: planned.projectionState });
  const restarted = new LocalMemoryJournal({ store, exclusiveLease: { run: operation => operation() } });
  await restarted.recover();
  assert.equal(restarted.readRecords({ recordIds: [record.recordId] }).items[0].labels.lifecycle, "obsolete");
});
