import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value === null ? null : structuredClone(value);
    this.writes = 0;
  }

  async read(_name, fallback = null) {
    return this.value === null ? structuredClone(fallback) : structuredClone(this.value);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
    this.writes += 1;
  }
}

class PausableMemoryStore extends MemoryStore {
  constructor() {
    super();
    this.nextWriteGate = null;
  }

  pauseNextWrite() {
    let release;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    this.nextWriteGate = { markStarted, released };
    return Object.freeze({ started, release });
  }

  async write(name, value) {
    const gate = this.nextWriteGate;
    if (gate) {
      this.nextWriteGate = null;
      gate.markStarted();
      await gate.released;
    }
    return super.write(name, value);
  }
}

class FakeGuard {
  constructor(events) {
    this.events = events;
    this.tail = Promise.resolve();
    this.closePromise = null;
  }

  async acquire() {
    this.events.push("acquire");
  }

  run(operation) {
    this.events.push("run");
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    this.closePromise ||= Promise.resolve().then(() => {
      this.events.push("close");
    });
    return this.closePromise;
  }
}

function guardFactory(events) {
  return (options) => {
    assert.deepEqual(options, { name: "mydashboard-work-ledger-v1" });
    return new FakeGuard(events);
  };
}

function emptySource(events = []) {
  return {
    async readAssignmentBatch(request) {
      events.push({ type: "source-read", request: structuredClone(request) });
      return {
        items: [],
        nextSequence: request.afterSequence,
        highWatermark: request.afterSequence,
        oldestAvailableSequence: 1,
      };
    },
  };
}

function oneAssignmentSource() {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-02T02:00:00.000Z",
    source: { provider: "github", scopeId: "test-dashboard" },
    subject: {
      id: "issue-runtime-1",
      repository: "acme/dashboard",
      number: 1,
    },
    payload: { number: 1, title: "Runtime graph integration" },
  });
  const record = {
    sequence: 1,
    assignment: {
      assignmentId: "assignment-runtime-1",
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "test",
    },
    event,
  };
  return {
    async readAssignmentBatch({ afterSequence }) {
      const items = afterSequence < 1 ? [record] : [];
      return structuredClone({
        items,
        nextSequence: items.length ? 1 : afterSequence,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
    },
  };
}

function graphChildCommand(parent, graphRevision) {
  return {
    parentTaskId: parent.itemId,
    childKey: "runtime-child",
    work: {
      title: "运行时子任务",
      description: "验证共享图端口和关闭排空语义。",
    },
    target: { type: "role", id: "developer" },
    dependsOnTaskIds: [],
    acceptanceContract: {
      revision: 1,
      acceptanceCriteria: [
        { criterionId: "verified", description: "运行时验证通过" },
      ],
      expectedDeliverables: [
        {
          deliverableId: "test-report",
          kind: "test-report",
          description: "测试结果",
          required: true,
        },
      ],
    },
    leaseId: null,
    expectedGraphRevision: graphRevision,
    expectedTaskRevisions: [
      { taskId: parent.itemId, revision: parent.revision },
    ],
  };
}

test("runtime graph reads preserve context cancellation through both graph facades", async () => {
  const runtime = await createWorkLedgerRuntime({ store: new MemoryStore(), assignmentSource: emptySource(),
    createGuard: guardFactory([]) });
  const controller = new AbortController();
  const reason = new Error("role context expired");
  controller.abort(reason);
  try {
    await assert.rejects(runtime.graphReader.getSnapshot({ signal: controller.signal }), error => error === reason);
    assert.ok((await runtime.graphReader.getSnapshot()).graph);
  } finally { await runtime.close(); }
});

test("runtime owns one named process guard and exposes least-authority graph ports", async () => {
  const events = [];
  const runtime = await createWorkLedgerRuntime({
    store: new MemoryStore(),
    assignmentSource: emptySource(events),
    clock: () => "2026-08-02T02:00:00.000Z",
    idFactory: () => "lease-runtime-1",
    createGuard: guardFactory(events),
  });

  assert.equal(Object.isFrozen(runtime), true);
  for (const method of [
    "getSummary",
    "getRoleWorkloads",
    "listItems",
    "readItemProgress",
    "readRepairDecisionBudget",
    "listClaimCandidates",
    "listPendingPullRequestSources",
    "listTimeline",
    "listOutbox",
    "readItemForReconciliation",
    "canRecoverUnstartedReviewProposal",
    "readAutomaticRoleHandoffCandidates",
    "canReconnectOwnPullRequest",
    "verifyPullRequestExecutionBindings",
    "reconcilePullRequestSourceBatch",
    "intake",
    "reconcilePullRequestSource",
    "claim",
    "transition",
    "scheduleRetry",
    "handoff",
    "complete",
    "cancelGraphTask",
    "stageIntent",
    "claimIntent",
    "bindIntent",
    "ackIntent",
    "close",
  ]) {
    assert.equal(typeof runtime[method], "function", method);
  }
  assert.equal(Object.isFrozen(runtime.graphReader), true);
  assert.deepEqual(await runtime.readAutomaticRoleHandoffCandidates({ events: [] }), []);
  const beforeReviewPreflight = await runtime.getSummary();
  assert.equal(await runtime.readRepairDecisionBudget({ itemId: "unused", expectedRevision: 1 }), null);
  assert.equal(await runtime.canRecoverUnstartedReviewProposal({ itemId: "unused", expectedRevision: 1 }), false);
  assert.deepEqual(await runtime.getSummary(), beforeReviewPreflight);
  assert.equal(Object.isFrozen(runtime.graphBrowserReader), true);
  assert.equal(Object.isFrozen(runtime.graphPlanner), true);
  assert.equal(Object.isFrozen(runtime.scopedGraphPlannerFactory), true);
  assert.equal(Object.isFrozen(runtime.graphDelivererFactory), true);
  assert.equal(Object.isFrozen(runtime.graphMemoryProjectionSource), true);
  assert.equal(Object.isFrozen(runtime.memoryAuthoritySource), true);
  assert.deepEqual(Object.keys(runtime.graphReader), ["getSnapshot"]);
  assert.deepEqual(Object.keys(runtime.graphBrowserReader), ["getSnapshot"]);
  assert.deepEqual(Object.keys(runtime.graphPlanner), [
    "createChild",
    "reviseAcceptanceContract",
    "decideDelivery",
    "resumeTask",
  ]);
  assert.deepEqual(Object.keys(runtime.scopedGraphPlannerFactory), ["forRoot"]);
  assert.deepEqual(Object.keys(runtime.graphDelivererFactory), ["forClaim"]);
  assert.deepEqual(
    Object.keys(runtime.graphMemoryProjectionSource),
    ["readBatch", "ack", "ackBatch"],
  );
  assert.deepEqual(Object.keys(runtime.memoryAuthoritySource), [
    "readSnapshot",
    "readStatus",
  ]);
  assert.equal(runtime.getGraphSnapshot, undefined);
  assert.equal(runtime.createGraphChild, undefined);
  assert.equal(runtime.graphStore, undefined);
  assert.equal(runtime.graphDeliverer, undefined);
  assert.equal(runtime.deliverer, undefined);
  assert.deepEqual(events.slice(0, 2), ["acquire", "run"]);

  const graphSnapshot = await runtime.graphReader.getSnapshot();
  assert.equal(graphSnapshot.graph.revision, 0);
  assert.equal(
    (await runtime.graphBrowserReader.getSnapshot()).graph.revision,
    graphSnapshot.graph.revision,
  );
  assert.deepEqual(
    await runtime.graphMemoryProjectionSource.readBatch({ limit: 1 }),
    {
      cursor: 0,
      highWatermark: 0,
      checkpointDigest: null,
      highWatermarkDigest: null,
      authorityStateDigest:
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      items: [],
    },
  );
  const authoritySnapshot = await runtime.memoryAuthoritySource.readSnapshot({
    limit: 1,
  });
  assert.equal(authoritySnapshot.ledgerRevision, 0);
  assert.deepEqual(authoritySnapshot.items, []);
  assert.deepEqual(authoritySnapshot.timeline, []);
  assert.deepEqual(authoritySnapshot.graph.items, []);

  const intake = await runtime.intake();
  assert.equal(intake.cursor, 0);
  assert.deepEqual(events.at(-1), {
    type: "source-read",
    request: { afterSequence: 0, limit: 100 },
  });

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(events.filter((event) => event === "close").length, 1);
  await assert.rejects(
    runtime.getSummary(),
    (error) =>
      error.code === "WORK_LEDGER_RUNTIME_CLOSED" && error.statusCode === 503,
  );
  await assert.rejects(
    runtime.graphMemoryProjectionSource.ackBatch({ receipts: [] }),
    (error) =>
      error.code === "WORK_LEDGER_RUNTIME_CLOSED" && error.statusCode === 503,
  );
  await assert.rejects(
    runtime.graphReader.getSnapshot(),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.graphPlanner.createChild({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.graphPlanner.reviseAcceptanceContract({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.graphPlanner.decideDelivery({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    runtime.graphPlanner.resumeTask({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
});

test("runtime factories bind scoped orchestrator and exact claim authority", async () => {
  const runtime = await createWorkLedgerRuntime({
    store: new MemoryStore(),
    assignmentSource: oneAssignmentSource(),
    clock: () => "2026-08-02T02:00:00.000Z",
    idFactory: (() => {
      let nextId = 1;
      return () => `lease-runtime-factory-${nextId++}`;
    })(),
    createGuard: guardFactory([]),
  });
  await runtime.intake();
  const parent = (await runtime.listItems()).items[0];

  assert.throws(
    () => runtime.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: null }),
    TypeError,
  );
  const planner = runtime.scopedGraphPlannerFactory.forRoot({
    scopeRootTaskId: parent.itemId,
  });
  assert.equal(Object.isFrozen(planner), true);
  assert.deepEqual(Object.keys(planner), [
    "createChild",
    "reviseAcceptanceContract",
    "decideDelivery",
    "reassignTask",
    "pauseTask",
    "resumeTask",
    "cancelTask",
    "stageEscalation",
  ]);

  const graph = await runtime.graphReader.getSnapshot();
  const created = await planner.createChild(
    graphChildCommand(parent, graph.graph.revision),
  );
  let child = (await runtime.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await runtime.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const deliverer = runtime.graphDelivererFactory.forClaim({
    scopeRootTaskId: parent.itemId,
    taskId: child.itemId,
    workerId: "employee-developer",
    leaseId: child.leaseId,
  });
  assert.equal(Object.isFrozen(deliverer), true);
  assert.deepEqual(Object.keys(deliverer), ["submitDelivery"]);

  const graphBeforeDelivery = await runtime.graphReader.getSnapshot();
  const submitted = await deliverer.submitDelivery({
    deliveryRevision: 1,
    contractRevision: 1,
    deliverableId: "test-report",
    summary: "运行时工厂绑定的交付",
    evidence: [
      {
        kind: "test-report",
        referenceId: "runtime-factory-report",
        contentDigest: "a".repeat(64),
      },
    ],
    expectedGraphRevision: graphBeforeDelivery.graph.revision,
    expectedTaskRevision: child.revision,
  });
  assert.equal(submitted.taskStatus, "waiting_external");

  const closing = runtime.close();
  await closing;
  await assert.rejects(
    planner.pauseTask({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  await assert.rejects(
    deliverer.submitDelivery({}),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
  assert.throws(
    () =>
      runtime.scopedGraphPlannerFactory.forRoot({
        scopeRootTaskId: parent.itemId,
      }),
    (error) => error.code === "WORK_LEDGER_RUNTIME_CLOSED",
  );
});

test("graph child descriptions preserve multiline prose through creation and restart", async () => {
  const store = new MemoryStore();
  const options = { store, assignmentSource: oneAssignmentSource(),
    clock: () => "2026-08-02T02:00:00.000Z", createGuard: guardFactory([]) };
  let runtime = await createWorkLedgerRuntime(options);
  await runtime.intake();
  const parent = (await runtime.listItems()).items[0];
  const planner = runtime.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: parent.itemId });
  const command = graphChildCommand(parent, (await runtime.graphReader.getSnapshot()).graph.revision);
  for (const description of ["   ", "a\u0000b", "a\u0007b", "中".repeat(6000)]) {
    await assert.rejects(planner.createChild({ ...command, work: { ...command.work, description } }));
  }
  await assert.rejects(planner.createChild({ ...command, work: { ...command.work, title: "unsafe\ntitle" } }));
  const description = "核验当前 Head。\n原始要求：\r\n\t逐项检查并保留证据。\n完成后自动复审。";
  const created = await planner.createChild({ ...command, work: { ...command.work, description } });
  const readChild = async () => (await runtime.listItems()).items.find(item => item.itemId === created.taskId);
  assert.equal((await readChild()).assignment.work.description, description);
  await runtime.close();
  runtime = await createWorkLedgerRuntime(options);
  assert.equal((await readChild()).assignment.work.description, description);
  await runtime.close();
});

test("runtime drains an accepted graph write before closing its sole guard", async () => {
  const events = [];
  const store = new PausableMemoryStore();
  const runtime = await createWorkLedgerRuntime({
    store,
    assignmentSource: oneAssignmentSource(),
    clock: () => "2026-08-02T02:00:00.000Z",
    idFactory: () => "lease-runtime-graph-1",
    createGuard: guardFactory(events),
  });
  await runtime.intake();
  const parent = (await runtime.listItems()).items[0];
  const graph = await runtime.graphReader.getSnapshot();
  const gate = store.pauseNextWrite();

  const creation = runtime.graphPlanner.createChild(
    graphChildCommand(parent, graph.graph.revision),
  );
  await gate.started;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(events.includes("close"), false);

  gate.release();
  const result = await creation;
  await closing;

  assert.equal(result.applied, true);
  assert.equal(events.at(-1), "close");
  assert.equal(events.filter((event) => event === "close").length, 1);
});

test("runtime never tries to acquire a lock exposed by the assignment source", async () => {
  const source = emptySource();
  source.acquire = () => {
    throw new Error("ledger must not acquire the workflow guard");
  };
  const runtime = await createWorkLedgerRuntime({
    store: new MemoryStore(),
    assignmentSource: source,
    createGuard: guardFactory([]),
  });

  await runtime.intake();
  await runtime.close();
});

test("runtime closes its guard when acquisition or recovery fails", async (t) => {
  await t.test("acquisition", async () => {
    let closes = 0;
    const acquisitionError = new Error("guard held");
    await assert.rejects(
      createWorkLedgerRuntime({
        store: new MemoryStore(),
        assignmentSource: emptySource(),
        createGuard: () => ({
          async acquire() {
            throw acquisitionError;
          },
          async run(operation) {
            return operation();
          },
          async close() {
            closes += 1;
          },
        }),
      }),
      (error) => error === acquisitionError,
    );
    assert.equal(closes, 1);
  });

  await t.test("recovery", async () => {
    let closes = 0;
    await assert.rejects(
      createWorkLedgerRuntime({
        store: new MemoryStore({ corrupt: true }),
        assignmentSource: emptySource(),
        createGuard: () => ({
          async acquire() {},
          async run(operation) {
            return operation();
          },
          async close() {
            closes += 1;
          },
        }),
      }),
      (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
    );
    assert.equal(closes, 1);
  });
});
