import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { getReadyWorkGraphTaskIds } from "../src/domain/work-graph-contract.js";
import { WorkGraphStore } from "../src/services/work-graph-store.js";
import { WorkConditionWaker } from "../src/services/work-condition-waker.js";
import { AUTO_RESUME_ON_CHILD_DELIVERY } from "../src/services/work-graph-wait-marker.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { WORK_LEDGER_STATE_SCHEMA_VERSION } from "../src/services/work-ledger-state.js";
import { ledgerDigest } from "../src/services/work-ledger-values.js";
import { createOwnerWorkRequestEvent, createOwnerIssueEvent, createOwnerPullRequestEvent } from "../src/domain/owner-work-request.js";
import { createTaskRunSettler } from "../src/services/work-ledger-run-control.js";

const STATE_KEY = "work-ledger-state";

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copied = structuredClone(value);
    this.values.set(name, copied);
    this.writes.push({ name, value: copied });
  }

  failNextWrite(error = new Error("durable write failed")) {
    this.nextWriteError = error;
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

class AssignmentSource {
  constructor(records) {
    this.records = records;
  }

  async readAssignmentBatch({ afterSequence, limit }) {
    const items = this.records
      .filter(({ sequence }) => sequence > afterSequence)
      .slice(0, limit);
    return structuredClone({
      items,
      nextSequence: items.at(-1)?.sequence ?? afterSequence,
      highWatermark: this.records.at(-1)?.sequence ?? 0,
      oldestAvailableSequence: this.records[0]?.sequence ?? 1,
    });
  }
}

function assignment(sequence) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-03T00:00:00.000Z",
    source: { provider: "github", scopeId: "test-dashboard" },
    subject: {
      id: `issue-${sequence}`,
      repository: "acme/dashboard",
      number: sequence,
    },
    payload: { number: sequence, title: `Issue ${sequence}` },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `assignment-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "test",
    },
    event,
  };
}

async function fixture(count = 1, { records } = {}) {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new AssignmentSource(
    records ?? Array.from(
      { length: count },
      (_, index) => assignment(index + 1),
    ),
  );
  let nextId = 1;
  const service = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:00.000Z",
    idFactory: () => `lease-${nextId++}`,
  });
  await service.recover();
  await service.intake();
  return { store, lease, source, service };
}

function acceptanceContract() {
  return {
    revision: 1,
    acceptanceCriteria: [
      { criterionId: "implemented", description: "实现约定的行为" },
      { criterionId: "tested", description: "通过自动化验证" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "可验证的实现结果",
        required: true,
      },
      {
        deliverableId: "test-report",
        kind: "test-report",
        description: "自动化验证结果",
        required: true,
      },
    ],
  };
}

function createCommand({
  parent,
  graphRevision,
  childKey = "implementation",
  dependencies = [],
  leaseId = null,
  contract = acceptanceContract(),
} = {}) {
  return {
    parentTaskId: parent.itemId,
    childKey,
    work: {
      title: "实现共享工作图",
      description: "建立单一事实源上的子任务。",
    },
    target: { type: "role", id: "developer" },
    dependsOnTaskIds: dependencies.map(({ itemId }) => itemId),
    acceptanceContract: contract,
    leaseId,
    expectedGraphRevision: graphRevision,
    expectedTaskRevisions: [...new Map(
      [parent, ...dependencies].map((item) => [item.itemId, item]),
    ).values()].map((item) => ({
      taskId: item.itemId,
      revision: item.revision,
    })),
  };
}

function scopedTaskCommand(item, graphRevision, overrides = {}) {
  return {
    taskId: item.itemId,
    reason: "orchestrator-coordination",
    expectedGraphRevision: graphRevision,
    expectedTaskRevision: item.revision,
    ...overrides,
  };
}

function ownerGoalRecord(kind = "work") {
  const request = { schemaVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111", workType: "general", priority: "high",
    title: "Continue the requested repair", description: "Keep the business goal while revising its child plan.",
    acceptanceCriteria: ["Deliver the verified repair"],
  };
  const at = "2026-08-03T00:00:00.000Z";
  const target = { repository: "acme/dashboard", number: 42 };
  const event = kind === "work" ? createOwnerWorkRequestEvent(request, at) : kind === "issue"
    ? createOwnerIssueEvent({ ...request, schemaVersion: 6, issue: target }, at)
    : createOwnerPullRequestEvent({ ...request, schemaVersion: 5, pullRequest: target,
      predecessorRequestId: "22222222-2222-4222-8222-222222222222",
      triage: { nextAction: "continue_draft", suggestedCapability: "development", expectedHeadRefOid: "a".repeat(40) } },
    { ...target, title: request.title, state: "open", gitTarget: { schemaVersion: 1, provider: "github",
      sourceAccountId: "owner", baseRepository: target.repository, headRepository: target.repository,
      baseRefName: "main", headRefName: "repair", baseRefOid: "b".repeat(40), headRefOid: "a".repeat(40) } }, at);
  const record = assignment(1);
  record.event = event;
  record.assignment.eventId = event.eventId;
  return record;
}

for (const kind of ["work", "issue", "pr"]) test(`a delegated coordinator cannot cancel an owner goal and its child tree: ${kind}`, async () => {
  const { service, store } = await fixture(1, { records: [ownerGoalRecord(kind)] });
  let [root] = (await service.listItems()).items;
  const { planner } = graphPorts(service, "employee-orchestrator", root.itemId);
  await planner.createChild(createCommand({ parent: root, graphRevision: (await service.getSummary()).revision }));
  root = await service.readItemForReconciliation({ itemId: root.itemId });
  const before = await store.read(STATE_KEY);
  await assert.rejects(planner.cancelTask(scopedTaskCommand(root, before.revision)),
    error => error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED");
  assert.deepEqual(await store.read(STATE_KEY), before, "root refusal cannot change any child, revision, timeline or outbox");
  const spoofedOwner = graphPorts(service, "owner-task-control", root.itemId).planner;
  await assert.rejects(spoofedOwner.cancelTask(scopedTaskCommand(root, before.revision)),
    error => error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED");
  assert.deepEqual(await store.read(STATE_KEY), before, "an actor name cannot change the delegated channel's ownership");
});

test("a failed child can be cancelled and replaced under the live owner root, then the owner can cancel normally", async () => {
  const { service } = await fixture(1, { records: [ownerGoalRecord("pr")] });
  let [root] = (await service.listItems()).items;
  const { planner } = graphPorts(service, "employee-orchestrator", root.itemId);
  await planner.createChild(createCommand({ parent: root, graphRevision: (await service.getSummary()).revision }));
  let child = (await service.listItems()).items.find(item => item.graph.parentItemId === root.itemId);
  child = await service.transition({ itemId: child.itemId, expectedRevision: child.revision, leaseId: null,
    actorId: "work-ledger-system", toStatus: "blocked", reason: "plan_failed" });
  root = await service.readItemForReconciliation({ itemId: root.itemId });
  const preservedRoot = structuredClone(root);
  await planner.cancelTask(scopedTaskCommand(child, (await service.getSummary()).revision));
  assert.deepEqual(await service.readItemForReconciliation({ itemId: root.itemId }), preservedRoot);
  await planner.createChild(createCommand({ parent: root, childKey: "replacement",
    graphRevision: (await service.getSummary()).revision }));
  root = await service.readItemForReconciliation({ itemId: root.itemId });
  const replacement = (await service.listItems()).items.find(item => item.graph.parentItemId === root.itemId && item.itemId !== child.itemId);
  assert.equal(root.status, "queued");
  assert.equal(replacement.status, "queued");
  assert.deepEqual(replacement.assignment.graphTask.sourceBinding, child.assignment.graphTask.sourceBinding);
  assert.deepEqual(replacement.graph.acceptanceContracts, child.graph.acceptanceContracts);
  await createTaskRunSettler({ ledger: service })({ task: { kind: "work-item", taskId: root.itemId,
    revision: root.revision, leaseId: null }, command: "cancel" });
  const cancelled = await service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await service.readItemForReconciliation({ itemId: replacement.itemId })).status, "cancelled");
  const noop = await planner.cancelTask(scopedTaskCommand(cancelled, (await service.getSummary()).revision));
  assert.deepEqual(noop.cancelledItemIds, [], "already-cancelled scoped controls retain their idempotent no-op");
});

function escalationCommand(item, graphRevision, overrides = {}) {
  return scopedTaskCommand(item, graphRevision, {
    summary: "需要所有者确认任务边界",
    question: "应采用哪个兼容性边界？",
    choices: [
      {
        id: "keep-current",
        label: "保持当前",
        description: "不扩大当前任务范围",
      },
      {
        id: "revise-scope",
        label: "修订范围",
        description: "由所有者确认新的任务边界",
      },
    ],
    ...overrides,
  });
}

function graphPorts(service, principalId, scopeRootTaskId) {
  const graph = new WorkGraphStore({ ledger: service });
  return {
    graph,
    reader: graph.reader(),
    planner: graph.planner({ principalId, scopeRootTaskId }),
  };
}

function resignTimelineEntry(entry) {
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    entry;
  const contentDigest = ledgerDigest(content);
  return {
    timelineId: `work-timeline-${contentDigest}`,
    contentDigest,
    ...content,
  };
}

function resignGraphTaskGenericIdentity(state, item, previousIdentity) {
  item.inputDigest = ledgerDigest({
    assignment: item.assignment,
    event: item.event,
  }, {
    maximumEntries: 30_000,
  });
  item.itemId = `work-item-${ledgerDigest({
    assignmentId: item.assignmentId,
    inputDigest: item.inputDigest,
  })}`;
  state.timeline = state.timeline.map((entry) => {
    const rewritten = structuredClone(entry);
    if (rewritten.itemId === previousIdentity.itemId) {
      rewritten.itemId = item.itemId;
    }
    if (rewritten.details.childTaskId === previousIdentity.itemId) {
      rewritten.details.childTaskId = item.itemId;
    }
    if (rewritten.details.inputDigest === previousIdentity.inputDigest) {
      rewritten.details.inputDigest = item.inputDigest;
    }
    return resignTimelineEntry(rewritten);
  });
}

test("reader projects one immutable graph with authoritative ledger statuses", async () => {
  const { service } = await fixture(1);
  const { graph, reader, planner } = graphPorts(
    service,
    "employee-orchestrator",
    null,
  );

  const snapshot = await reader.getSnapshot();

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.graph.revision, 1);
  assert.equal(snapshot.graph.tasks.length, 1);
  assert.deepEqual(snapshot.taskStates.map((state) => state.ledgerStatus), [
    "queued",
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.graph), true);
  assert.equal(Object.isFrozen(snapshot.taskStates), true);
  assert.deepEqual(Object.keys(reader), ["getSnapshot"]);
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
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(reader), true);
  assert.equal(Object.isFrozen(planner), true);
});

test("legacy graph adapters keep old ports while unavailable orchestration fails closed", async () => {
  const calls = [];
  const graph = new WorkGraphStore({
    ledger: {
      async getGraphSnapshot() {
        return { kind: "legacy-snapshot" };
      },
      async createGraphChild(input) {
        calls.push(["create", input]);
        return { kind: "legacy-create" };
      },
      async reviseGraphAcceptance(input) {
        calls.push(["revise", input]);
        return { kind: "legacy-revise" };
      },
      async submitGraphDelivery(input) {
        calls.push(["submit", input]);
        return { kind: "legacy-submit" };
      },
      async decideGraphDelivery(input) {
        calls.push(["decide", input]);
        return { kind: "legacy-decide" };
      },
    },
  });
  const planner = graph.planner({
    principalId: "employee-orchestrator",
    scopeRootTaskId: "legacy-root",
  });

  assert.deepEqual(await graph.reader().getSnapshot(), {
    kind: "legacy-snapshot",
  });
  assert.deepEqual(await planner.createChild({ legacy: true }), {
    kind: "legacy-create",
  });
  await assert.rejects(
    planner.pauseTask({ legacy: true }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_PORT_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(calls.length, 1);
});

test("scoped planner reassigns, pauses, resumes, and safely cancels without crossing roots", async () => {
  const { service, store } = await fixture(2);
  let [inside, outside] = (await service.listItems()).items;
  const { reader, planner } = graphPorts(
    service,
    "employee-orchestrator",
    inside.itemId,
  );
  const writesBeforeDenied = store.writes.length;
  const deniedCommands = [
    ["reassignTask", scopedTaskCommand(outside, 1, {
      target: { type: "role", id: "testing" },
    })],
    ["pauseTask", scopedTaskCommand(outside, 1)],
    ["resumeTask", scopedTaskCommand(outside, 1)],
    ["cancelTask", scopedTaskCommand(outside, 1)],
    ["stageEscalation", escalationCommand(outside, 1)],
  ];
  for (const [method, command] of deniedCommands) {
    await assert.rejects(
      planner[method](command),
      (error) =>
        error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED" &&
        error.statusCode === 403,
      method,
    );
  }
  assert.equal(store.writes.length, writesBeforeDenied);

  let graphRevision = (await reader.getSnapshot()).graph.revision;
  const reassigned = await planner.reassignTask(
    scopedTaskCommand(inside, graphRevision, {
      target: { type: "role", id: "testing" },
    }),
  );
  assert.equal(reassigned.status, "queued");
  assert.deepEqual(reassigned.currentTarget, { type: "role", id: "testing" });
  inside = reassigned;
  graphRevision += 1;

  const writesBeforeStale = store.writes.length;
  await assert.rejects(
    planner.pauseTask(scopedTaskCommand(inside, graphRevision - 1)),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  assert.equal(store.writes.length, writesBeforeStale);

  inside = await planner.pauseTask(scopedTaskCommand(inside, graphRevision));
  graphRevision += 1;
  assert.equal(inside.status, "paused");
  assert.equal(inside.ownerId, null);
  assert.equal(inside.leaseId, null);
  assert.equal(inside.activeIntentId, null);
  let snapshot = await reader.getSnapshot();
  assert.equal(
    snapshot.graph.tasks.find(({ taskId }) => taskId === inside.itemId).status,
    "paused",
  );
  assert.deepEqual(getReadyWorkGraphTaskIds(snapshot.graph), [outside.itemId]);

  const writesBeforeUnsafe = store.writes.length;
  await assert.rejects(
    planner.reassignTask(scopedTaskCommand(inside, graphRevision, {
      target: { type: "role", id: "developer" },
    })),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  assert.equal(store.writes.length, writesBeforeUnsafe);

  inside = await planner.resumeTask(scopedTaskCommand(inside, graphRevision));
  graphRevision += 1;
  assert.equal(inside.status, "queued");
  inside = await planner.pauseTask(scopedTaskCommand(inside, graphRevision));
  graphRevision += 1;
  const cancelled = await planner.cancelTask(
    scopedTaskCommand(inside, graphRevision),
  );
  assert.equal(cancelled.root.status, "cancelled");
  assert.deepEqual(cancelled.cancelledItemIds, [inside.itemId]);

  snapshot = await reader.getSnapshot();
  assert.equal(
    snapshot.graph.tasks.find(({ taskId }) => taskId === inside.itemId).status,
    "cancelled",
  );
  assert.equal(
    snapshot.graph.tasks.find(({ taskId }) => taskId === outside.itemId).status,
    "pending",
  );
});

test("scoped planner rejects active-task reassign and pause with zero writes", async () => {
  const { service, store } = await fixture(1);
  let item = (await service.listItems()).items[0];
  item = await service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const graphRevision = (await service.getGraphSnapshot()).graph.revision;
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    item.itemId,
  );
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.reassignTask(scopedTaskCommand(item, graphRevision, {
      target: { type: "role", id: "testing" },
    })),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  await assert.rejects(
    planner.pauseTask(scopedTaskCommand(item, graphRevision)),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  assert.equal(store.writes.length, writesBefore);
});

test("scoped pause preserves a future retry backoff without making it ready", async () => {
  const { service, store } = await fixture(1);
  let item = (await service.listItems()).items[0];
  item = await service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  item = await service.scheduleRetry({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-developer",
    availableAt: "2026-08-03T01:05:00.000Z",
    reason: "retry-backoff",
  });
  const graphRevision = (await service.getGraphSnapshot()).graph.revision;
  const { reader, planner } = graphPorts(
    service,
    "employee-orchestrator",
    item.itemId,
  );
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.pauseTask(scopedTaskCommand(item, graphRevision)),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );

  const current = (await service.listItems()).items[0];
  assert.equal(store.writes.length, writesBefore);
  assert.equal(current.status, "retry_wait");
  assert.equal(current.availableAt, item.availableAt);
  assert.deepEqual(
    getReadyWorkGraphTaskIds((await reader.getSnapshot()).graph),
    [],
  );
});

test("legacy handoff cannot implicitly resume a paused task", async () => {
  const { service, store } = await fixture(1);
  let item = (await service.listItems()).items[0];
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    item.itemId,
  );
  item = await planner.pauseTask(scopedTaskCommand(item, 1));
  const writesBefore = store.writes.length;

  await assert.rejects(
    service.handoff({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: null,
      actorId: "employee-orchestrator",
      target: { type: "role", id: "testing" },
      reason: "must-use-explicit-resume",
    }),
    (error) => error.code === "WORK_LEDGER_TRANSITION_INVALID",
  );

  const current = (await service.listItems()).items[0];
  assert.equal(store.writes.length, writesBefore);
  assert.equal(current.status, "paused");
  assert.deepEqual(current.currentTarget, item.currentTarget);
});

test("scoped cancellation cannot mutate a system alert", async () => {
  const { service, store } = await fixture(0, {
    records: [assignment(2)],
  });
  const alert = (await service.listItems()).items[0];
  const graphRevision = (await service.getGraphSnapshot()).graph.revision;
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    alert.itemId,
  );
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.cancelTask(scopedTaskCommand(alert, graphRevision)),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );

  const current = (await service.listItems()).items[0];
  assert.equal(store.writes.length, writesBefore);
  assert.equal(current.kind, "system_alert");
  assert.equal(current.status, "blocked");
});

test("staging an escalation atomically reuses the standard ask-user outbox", async () => {
  const { service, store } = await fixture(1);
  const item = (await service.listItems()).items[0];
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    item.itemId,
  );
  const command = escalationCommand(item, 1);

  const staged = await planner.stageEscalation(command);
  assert.equal(staged.applied, true);
  assert.equal(staged.item.status, "dispatch_pending");
  assert.equal(staged.item.activeIntentId, staged.outbox.intentId);
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "orchestrator",
    workerId: "employee-orchestrator",
  });
  assert.deepEqual(staged.outbox.intent, {
    schemaVersion: 1,
    type: "ask_user",
    summary: command.summary,
    reason: command.reason,
    question: command.question,
    choices: command.choices,
  });
  assert.equal(staged.outbox.status, "pending");
  const writesAfterStage = store.writes.length;

  const replay = await planner.stageEscalation(command);
  assert.equal(replay.applied, false);
  assert.equal(replay.outbox.intentId, staged.outbox.intentId);
  assert.equal(replay.item.revision, staged.item.revision);
  assert.equal(store.writes.length, writesAfterStage);

  await assert.rejects(
    planner.stageEscalation({ ...command, question: "另一个问题？" }),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterStage);

  const currentGraphRevision = (await service.getGraphSnapshot()).graph.revision;
  await assert.rejects(
    planner.stageEscalation(escalationCommand(staged.item, currentGraphRevision, {
      question: "另一个问题？",
    })),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterStage);

  const claimed = await service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "attention-dispatcher",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "dispatching");
  await service.ackIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    dispatchLeaseId: claimed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "completed",
    actorId: "attention-dispatcher",
    details: { downstreamRef: "historical-escalation" },
  });
  const writesAfterTerminal = store.writes.length;
  await assert.rejects(
    planner.stageEscalation(command),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterTerminal);
  assert.equal(
    (await service.listTimeline({ limit: 50 })).items.filter(
      ({ type, itemId }) => type === "intent_staged" && itemId === item.itemId,
    ).length,
    1,
  );
});

test("a PR source root supports scoped escalation without duplicate publication", async () => {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1, eventType: "pull_request.updated",
    occurredAt: "2026-08-03T00:00:00.000Z",
    source: { provider: "github", scopeId: "test-dashboard" },
    subject: { id: "github:pr:acme/dashboard#42", repository: "acme/dashboard", number: 42 },
    payload: { title: "PR 42", headRefOid: "a".repeat(40) },
  });
  const record = assignment(1);
  record.assignment.target = { type: "role", id: "pr-engineer" };
  record.event = event;
  record.assignment.eventId = event.eventId;
  const { service } = await fixture(0, { records: [record] });
  const item = (await service.listItems()).items[0];
  assert.equal(item.kind, "source_root");
  const { planner } = graphPorts(service, "employee-orchestrator", item.itemId);
  const command = escalationCommand(item, 1);
  const staged = await planner.stageEscalation(command);
  assert.equal(staged.item.status, "dispatch_pending");
  const replay = await planner.stageEscalation(command);
  assert.equal(replay.applied, false);
  assert.equal(replay.outbox.intentId, staged.outbox.intentId);
});

test("automatic orchestration cannot overwrite a pending PR source cutover", async () => {
  const prRecord = (sequence, scopeId) => {
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated",
      occurredAt: `2026-08-03T00:00:0${sequence}.000Z`, source: { provider: "github", scopeId },
      subject: { id: "github:pr:acme/dashboard#42", repository: "acme/dashboard", number: 42 },
      payload: { title: "PR 42", headRefOid: "a".repeat(40) } });
    const record = assignment(sequence);
    record.event = event;
    record.assignment.eventId = event.eventId;
    record.assignment.target = { type: "role", id: "pr-engineer" };
    return record;
  };
  const { service, store, source } = await fixture(0, { records: [prRecord(1, "github-primary")] });
  const old = (await service.listItems()).items[0];
  const staged = await graphPorts(service, "employee-orchestrator", old.itemId).planner.stageEscalation(escalationCommand(old, 1));
  const dispatch = await service.claimIntent({ intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision, dispatcherId: "attention-dispatcher", leaseDurationMs: 30_000 });
  await service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    outcome: "delivered", nextStatus: "waiting_user", actorId: "attention-dispatcher",
    details: { questionRef: `attention-${"d".repeat(64)}` } });
  source.records.push(prRecord(2, "github-secondary"));
  await service.intake();
  const pending = (await service.listItems()).items.find(item => item.itemId !== old.itemId);
  assert.match(pending.statusReason, /^pr_source_cross_root_cutover_pending:/);
  const revision = (await service.getGraphSnapshot()).graph.revision;
  const { planner } = graphPorts(service, "employee-orchestrator", pending.itemId);
  const writes = store.writes.length;
  await assert.rejects(planner.pauseTask(scopedTaskCommand(pending, revision)),
    error => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING");
  await assert.rejects(planner.stageEscalation(escalationCommand(pending, revision)),
    error => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING");
  assert.equal(store.writes.length, writes);
  assert.equal((await service.listItems()).items.find(item => item.itemId === pending.itemId).statusReason, pending.statusReason);
});

test("a failed sealed escalation clears its policy binding before restaging", async () => {
  const { service } = await fixture(1);
  const item = (await service.listItems()).items[0];
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    item.itemId,
  );
  const staged = await planner.stageEscalation(escalationCommand(item, 1));
  const claimed = await service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "attention-dispatcher",
    leaseDurationMs: 30_000,
  });
  const boundIntent = createWorkIntentPolicy().bind({
    context: {
      assignmentId: staged.item.assignmentId,
      workItemId: staged.item.itemId,
      roleId: "orchestrator",
      event: staged.item.event,
    },
    intent: claimed.intent,
  });
  const sealed = await service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "attention-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent,
  });
  const failed = await service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "blocked",
    actorId: "attention-dispatcher",
    details: { code: "downstream-rejected" },
  });
  const graphRevision = (await service.getGraphSnapshot()).graph.revision;

  const restaged = await planner.stageEscalation(
    escalationCommand(failed.item, graphRevision),
  );

  assert.equal(restaged.applied, true);
  assert.equal(restaged.outbox.intentId, staged.outbox.intentId);
  assert.equal(restaged.outbox.status, "pending");
  assert.equal(restaged.outbox.dispatchBinding, null);
  assert.equal(
    (await service.listOutbox()).items[0].dispatchBinding,
    null,
  );
});

test("reader does not hide retry state behind the coarse graph status", async () => {
  const { service } = await fixture(1);
  let item = (await service.listItems()).items[0];
  item = await service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  await service.scheduleRetry({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-orchestrator",
    availableAt: "2026-08-03T01:01:00.000Z",
    reason: "waiting-for-input",
  });

  const snapshot = await new WorkGraphStore({ ledger: service })
    .reader()
    .getSnapshot();

  assert.equal(snapshot.graph.tasks[0].status, "in_progress");
  assert.equal(snapshot.taskStates[0].ledgerStatus, "retry_wait");
  assert.equal(
    snapshot.taskStates[0].availableAt,
    "2026-08-03T01:01:00.000Z",
  );
});

test("planner atomically creates a child and advances its direct parent", async () => {
  const { service, store } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { reader, planner } = graphPorts(
    service,
    "employee-orchestrator",
    parent.itemId,
  );
  const command = createCommand({ parent, graphRevision: 1 });

  const result = await planner.createChild(command);

  assert.equal(result.applied, true);
  assert.equal(result.graphRevision, 2);
  assert.equal(result.parentTaskRevision, 2);
  assert.equal(result.taskRevision, 1);
  const snapshot = await reader.getSnapshot();
  assert.equal(snapshot.graph.revision, 2);
  assert.equal(snapshot.graph.tasks.length, 2);
  const child = snapshot.graph.tasks.find(
    ({ taskId }) => taskId === result.taskId,
  );
  assert.equal(child.parentTaskId, parent.itemId);
  assert.equal(child.responsibility.id, "developer");
  assert.equal(child.acceptanceContracts[0].expectedDeliverables.length, 2);
  const items = (await service.listItems()).items;
  const childItem = items.find(({ itemId }) => itemId === result.taskId);
  const childState = snapshot.taskStates.find(
    ({ taskId }) => taskId === result.taskId,
  );
  assert.equal(childItem.kind, "graph_task");
  assert.equal(childItem.sourceSequence, 0);
  assert.equal(childItem.assignment.work.title, "实现共享工作图");
  assert.equal(childState.work.title, "实现共享工作图");
  assert.equal(childItem.event.eventId, parent.event.eventId);
  assert.equal(childItem.assignment.work.acceptanceContract, undefined);
  const boundIntent = createWorkIntentPolicy().bind({
    context: {
      assignmentId: childItem.assignmentId,
      workItemId: childItem.itemId,
      roleId: "developer",
      event: childItem.event,
    },
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary: "子任务已完成",
      reason: "实现与验证均已完成",
      outcome: "done",
      evidence: [],
    },
  });
  assert.equal(boundIntent.source.assignmentId, childItem.assignmentId);
  assert.equal(boundIntent.source.eventId, parent.event.eventId);
  assert.equal(
    (await service.listTimeline({ limit: 20 })).items.filter(
      ({ type }) => type === "graph_child_created",
    ).length,
    1,
  );
  assert.equal(
    (await service.listTimeline({ limit: 20 })).items.filter(
      ({ type, itemId }) =>
        type === "graph_parent_revised" && itemId === parent.itemId,
    ).length,
    1,
  );
  assert.equal(store.writes.at(-1).value.revision, 2);
  await assert.rejects(
    service.claim({
      itemId: parent.itemId,
      expectedRevision: 2,
      workerId: "employee-orchestrator",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("same child command converges without a write while changed content conflicts", async () => {
  const { service, store } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    parent.itemId,
  );
  const command = createCommand({ parent, graphRevision: 1 });
  const first = await planner.createChild(command);
  const writesAfterCreate = store.writes.length;

  const replay = await planner.createChild({
    ...command,
    acceptanceContract: {
      ...command.acceptanceContract,
      acceptanceCriteria: [
        ...command.acceptanceContract.acceptanceCriteria,
      ].reverse(),
      expectedDeliverables: [
        ...command.acceptanceContract.expectedDeliverables,
      ].reverse(),
    },
  });

  assert.equal(replay.applied, false);
  assert.equal(replay.taskId, first.taskId);
  assert.equal(replay.graphRevision, 2);
  assert.equal(store.writes.length, writesAfterCreate);
  await assert.rejects(
    planner.createChild({
      ...command,
      work: { ...command.work, title: "不同的工作" },
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_CHILD_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterCreate);
});

test("new children require current graph and exact referenced task revisions", async () => {
  const { service, store } = await fixture(2);
  const [parent, dependency] = (await service.listItems()).items;
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const writesBefore = store.writes.length;
  const command = createCommand({
    parent,
    graphRevision: 1,
    dependencies: [dependency],
  });

  await assert.rejects(
    planner.createChild({
      ...command,
      expectedTaskRevisions: command.expectedTaskRevisions.slice(0, 1),
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  );
  await assert.rejects(
    planner.createChild({
      ...command,
      childKey: "another-child",
      expectedGraphRevision: 0,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  assert.equal(store.writes.length, writesBefore);
});

test("planner scope covers the parent and every referenced dependency", async () => {
  const { service, store } = await fixture(2);
  const [inside, outside] = (await service.listItems()).items;
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    inside.itemId,
  );
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.createChild(createCommand({
      parent: inside,
      graphRevision: 1,
      dependencies: [outside],
    })),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED" &&
      error.statusCode === 403,
  );
  assert.equal(store.writes.length, writesBefore);
});

test("an active parent can only be decomposed by its exact lease owner", async () => {
  const { service, store } = await fixture(1);
  let parent = (await service.listItems()).items[0];
  parent = await service.claim({
    itemId: parent.itemId,
    expectedRevision: parent.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const snapshot = await service.getGraphSnapshot();
  const { planner } = graphPorts(
    service,
    "employee-orchestrator",
    parent.itemId,
  );
  const command = createCommand({
    parent,
    graphRevision: snapshot.graph.revision,
    leaseId: parent.leaseId,
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.createChild({ ...command, leaseId: "wrong-lease" }),
    (error) => error.code === "WORK_LEDGER_LEASE_CONFLICT",
  );
  assert.equal(store.writes.length, writesBefore);
  const result = await planner.createChild(command);
  const currentParent = (await service.listItems()).items.find(
    ({ itemId }) => itemId === parent.itemId,
  );
  assert.equal(result.applied, true);
  assert.equal(currentParent.status, "queued");
  assert.equal(currentParent.leaseId, null);
  assert.equal(currentParent.statusReason, "waiting_for_children");
});

test("blocked and retry-wait parents require an explicit recovery command before decomposition", async (t) => {
  for (const status of ["blocked", "retry_wait"]) {
    await t.test(status, async () => {
      const { service, store } = await fixture(1);
      let parent = (await service.listItems()).items[0];
      parent = await service.claim({
        itemId: parent.itemId,
        expectedRevision: parent.revision,
        workerId: "employee-orchestrator",
        leaseDurationMs: 30_000,
      });
      parent = status === "blocked"
        ? await service.transition({
            itemId: parent.itemId,
            expectedRevision: parent.revision,
            leaseId: parent.leaseId,
            actorId: "employee-orchestrator",
            toStatus: "blocked",
            reason: "owner-policy-block",
            details: { code: "OWNER_POLICY_BLOCK" },
          })
        : await service.scheduleRetry({
            itemId: parent.itemId,
            expectedRevision: parent.revision,
            leaseId: parent.leaseId,
            actorId: "employee-orchestrator",
            availableAt: "2026-08-03T01:01:00.000Z",
            reason: "retry-backoff",
          });
      const revision = (await service.getGraphSnapshot()).graph.revision;
      const writesBefore = store.writes.length;
      const { planner } = graphPorts(
        service,
        "employee-orchestrator",
        null,
      );

      await assert.rejects(
        planner.createChild(createCommand({
          parent,
          graphRevision: revision,
        })),
        (error) => error.code === "WORK_LEDGER_GRAPH_PARENT_CONFLICT",
      );
      assert.equal(store.writes.length, writesBefore);
    });
  }
});

test("a parent becomes claimable after every direct child completes", async () => {
  const { service } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(createCommand({
    parent,
    graphRevision: 1,
    contract: {
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [],
    },
  }));
  let child = (await service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  await service.complete({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  let currentParent = (await service.listItems()).items.find(
    ({ itemId }) => itemId === parent.itemId,
  );

  currentParent = await service.claim({
    itemId: currentParent.itemId,
    expectedRevision: currentParent.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const completedParent = await service.complete({
    itemId: currentParent.itemId,
    expectedRevision: currentParent.revision,
    leaseId: currentParent.leaseId,
    actorId: "employee-orchestrator",
    result: { outcome: "all-children-complete" },
  });
  assert.equal(completedParent.status, "completed");
});

test("a parent explicitly waiting for child delivery resumes after a real child completion", async () => {
  const { store, lease, source, service } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { reader, planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(createCommand({
    parent,
    graphRevision: 1,
    contract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [] },
  }));
  const waiting = (await service.listItems()).items.find(({ itemId }) => itemId === parent.itemId);
  const pauseRevision = (await reader.getSnapshot()).graph.revision;
  const paused = await planner.pauseTask(scopedTaskCommand(waiting, pauseRevision, {
    reason: "等待直属子任务交付",
    waitForChildren: true,
  }));
  assert.equal(paused.status, "paused");

  let child = (await service.listItems()).items.find(({ itemId }) => itemId === created.taskId);
  child = await service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  await service.complete({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:00.000Z",
    idFactory: () => "recovered-lease",
  });
  await recovered.recover();
  const recoveredGraph = graphPorts(recovered, "employee-orchestrator", null);
  const waker = new WorkConditionWaker({
    ledger: recovered,
    graphReader: recoveredGraph.reader,
    graphPlanner: recoveredGraph.planner,
  });
  await waker.runCycle();
  const resumed = (await recovered.listItems()).items.find(({ itemId }) => itemId === parent.itemId);
  assert.equal(resumed.status, "queued");
});

test("an intentionally paused parent stays paused after a real child completion until explicit resume", async () => {
  const { service } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { reader, planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(createCommand({
    parent,
    graphRevision: 1,
    contract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [] },
  }));
  const waiting = (await service.listItems()).items.find(({ itemId }) => itemId === parent.itemId);
  const pauseRevision = (await reader.getSnapshot()).graph.revision;
  await planner.pauseTask(scopedTaskCommand(waiting, pauseRevision, { reason: "主动暂停，等待人工恢复" }));
  let child = (await service.listItems()).items.find(({ itemId }) => itemId === created.taskId);
  child = await service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  await service.complete({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  const waker = new WorkConditionWaker({ ledger: service, graphReader: reader, graphPlanner: planner });
  await waker.runCycle();
  let current = (await service.listItems()).items.find(({ itemId }) => itemId === parent.itemId);
  assert.equal(current.status, "paused");
  current = await planner.resumeTask(scopedTaskCommand(current, (await reader.getSnapshot()).graph.revision));
  assert.equal(current.status, "queued");
});

test("child-wait pauses require a decomposed parent and reserve the durable marker", async () => {
  const { service, store } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const writes = store.writes.length;
  await assert.rejects(
    planner.pauseTask(scopedTaskCommand(parent, 1, { waitForChildren: true })),
    (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
  );
  await assert.rejects(
    planner.pauseTask(scopedTaskCommand(parent, 1, { reason: AUTO_RESUME_ON_CHILD_DELIVERY })),
    (error) => error.code === "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  );
  assert.equal(store.writes.length, writes);
});

test("combined parent and dependency cycles fail atomically", async () => {
  const { service, store } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.createChild(createCommand({
      parent,
      graphRevision: 1,
      dependencies: [parent],
    })),
    (error) => error.code === "WORK_LEDGER_GRAPH_TRANSITION_INVALID",
  );
  assert.equal(store.writes.length, writesBefore);
  assert.equal((await service.getGraphSnapshot()).graph.tasks.length, 1);
});

test("facade and command DTO accessors are rejected without invocation", async () => {
  let portAccessorInvoked = false;
  const hostileLedger = {};
  Object.defineProperty(hostileLedger, "getGraphSnapshot", {
    get() {
      portAccessorInvoked = true;
      return () => null;
    },
  });
  hostileLedger.createGraphChild = () => null;
  assert.throws(
    () => new WorkGraphStore({ ledger: hostileLedger }),
    TypeError,
  );
  assert.equal(portAccessorInvoked, false);

  const { service } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  let commandAccessorInvoked = false;
  const command = createCommand({ parent, graphRevision: 1 });
  Object.defineProperty(command, "work", {
    enumerable: true,
    get() {
      commandAccessorInvoked = true;
      return { title: "hidden", description: "hidden" };
    },
  });

  await assert.rejects(
    planner.createChild(command),
    (error) => error.code === "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  );
  assert.equal(commandAccessorInvoked, false);
});

test("planner snapshots a command before it enters the ledger queue", async () => {
  const { service } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const command = createCommand({ parent, graphRevision: 1 });

  const pending = planner.createChild(command);
  command.work.title = "调用后篡改";
  command.acceptanceContract.acceptanceCriteria[0].description = "调用后篡改";
  const result = await pending;

  const item = (await service.listItems()).items.find(
    ({ itemId }) => itemId === result.taskId,
  );
  assert.equal(item.assignment.work.title, "实现共享工作图");
  assert.equal(
    item.graph.acceptanceContracts[0].acceptanceCriteria[0].description,
    "实现约定的行为",
  );
});

test("a created child recovers through the same ledger authority", async () => {
  const { service, store, lease, source } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(
    createCommand({ parent, graphRevision: 1 }),
  );
  assert.equal(
    store.values.get(STATE_KEY).schemaVersion,
    WORK_LEDGER_STATE_SCHEMA_VERSION,
  );
  const restarted = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:01.000Z",
    idFactory: () => "restart-lease",
  });

  await restarted.recover();

  const snapshot = await restarted.getGraphSnapshot();
  assert.equal(snapshot.graph.revision, 2);
  assert.equal(
    snapshot.graph.tasks.find(({ taskId }) => taskId === created.taskId)
      .parentTaskId,
    parent.itemId,
  );
});

test("Review replacement persists cancellation and creation together and survives failed writes and restart", async () => {
  const { service, store, lease, source } = await fixture(1);
  let parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", parent.itemId);
  const contract = { revision: 1, acceptanceCriteria: [{ criterionId: "reviewed", description: "Verified Review evidence" }],
    expectedDeliverables: [{ deliverableId: "review", kind: "review-report", description: "Current Review", required: true }] };
  const initial = createCommand({ parent, graphRevision: 1, childKey: "original-review", contract });
  initial.target.id = "pr-engineer";
  const created = await planner.createChild(initial);
  let old = (await service.listItems()).items.find(item => item.itemId === created.taskId);
  old = await service.transition({ itemId: old.itemId, expectedRevision: old.revision, leaseId: null,
    actorId: "work-ledger-system", toStatus: "blocked", reason: "decision_attempts_exhausted", details: {} });
  parent = (await service.listItems()).items.find(item => item.itemId === parent.itemId);
  const revision = (await service.getGraphSnapshot()).graph.revision;
  const command = createCommand({ parent, graphRevision: revision, childKey: "review-reuse-stable", contract });
  command.target.id = "pr-engineer";
  command.reviewReplacement = { taskId: old.itemId, expectedTaskRevision: old.revision, reason: "Host verified current candidate" };
  const before = structuredClone(store.values.get(STATE_KEY)), writes = store.writes.length;
  store.failNextWrite();
  await assert.rejects(planner.createChild(command), error => error.code === "WORK_LEDGER_STATE_WRITE_FAILED" && error.cause?.message === "durable write failed");
  assert.deepEqual(store.values.get(STATE_KEY), before);
  assert.equal(store.writes.length, writes);
  const result = await planner.createChild(command);
  assert.equal(store.writes.length, writes + 1);
  const durable = store.values.get(STATE_KEY);
  assert.equal(durable.revision, revision + 1);
  assert.equal(durable.items.find(item => item.itemId === old.itemId).status, "cancelled");
  assert.equal(durable.items.find(item => item.itemId === result.taskId).status, "queued");
  assert.deepEqual(durable.timeline.slice(-3).map(event => event.type), ["cancelled", "graph_child_created", "graph_parent_revised"]);
  const restarted = new WorkLedgerService({ store, assignmentSource: source, exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:01.000Z", idFactory: () => "restart-lease" });
  await restarted.recover();
  const resumed = graphPorts(restarted, "employee-orchestrator", parent.itemId).planner;
  const replay = await resumed.createChild(command);
  assert.equal(replay.applied, false);
  assert.equal(replay.taskId, result.taskId);
  assert.equal(store.writes.length, writes + 1);
});

test("recovery rejects a forged graph assignment identity after generic bindings are resigned", async () => {
  const { service, store, lease, source } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(
    createCommand({ parent, graphRevision: 1 }),
  );
  const state = structuredClone(store.values.get(STATE_KEY));
  const child = state.items.find(({ itemId }) => itemId === created.taskId);
  const previousIdentity = {
    itemId: child.itemId,
    inputDigest: child.inputDigest,
  };
  const forgedAssignmentId = `graph-assignment-${"f".repeat(64)}`;
  child.assignment.assignmentId = forgedAssignmentId;
  child.assignmentId = forgedAssignmentId;
  resignGraphTaskGenericIdentity(state, child, previousIdentity);
  store.values.set(STATE_KEY, state);
  const restarted = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:01.000Z",
    idFactory: () => "restart-lease",
  });

  await assert.rejects(
    restarted.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery rejects a definition digest detached from the initial graph semantics", async () => {
  const { service, store, lease, source } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const created = await planner.createChild(
    createCommand({ parent, graphRevision: 1 }),
  );
  const state = structuredClone(store.values.get(STATE_KEY));
  const child = state.items.find(({ itemId }) => itemId === created.taskId);
  const previousIdentity = {
    itemId: child.itemId,
    inputDigest: child.inputDigest,
  };
  child.assignment.graphTask.definitionDigest = "0".repeat(64);
  resignGraphTaskGenericIdentity(state, child, previousIdentity);
  store.values.set(STATE_KEY, state);
  const restarted = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:01.000Z",
    idFactory: () => "restart-lease",
  });

  await assert.rejects(
    restarted.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a valid legacy source event without stored identity can still be decomposed", async () => {
  const legacy = structuredClone(assignment(1));
  delete legacy.assignment.eventId;
  delete legacy.event.eventId;
  delete legacy.event.contentDigest;
  const { service } = await fixture(1, { records: [legacy] });
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);

  const result = await planner.createChild(
    createCommand({ parent, graphRevision: 1 }),
  );

  const child = (await service.listItems()).items.find(
    ({ itemId }) => itemId === result.taskId,
  );
  assert.match(child.event.eventId, /^workflow-event-[a-f0-9]{64}$/);
  assert.equal(child.assignment.eventId, child.event.eventId);
});

test("a non-workflow legacy parent stays readable but cannot produce executable children", async () => {
  const legacy = {
    sequence: 1,
    assignment: {
      assignmentId: "legacy-assignment-1",
      eventId: "legacy-event-1",
      target: { type: "role", id: "orchestrator" },
      reason: "legacy-import",
    },
    event: {
      eventId: "legacy-event-1",
      eventType: "legacy.manual_work",
      subject: { id: "legacy-work-1" },
      payload: { title: "仍可查看的历史任务" },
    },
  };
  const { service, store } = await fixture(1, { records: [legacy] });
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const writesBefore = store.writes.length;

  assert.equal(parent.assignmentId, "legacy-assignment-1");
  assert.equal(parent.event.payload.title, "仍可查看的历史任务");
  await assert.rejects(
    planner.createChild(createCommand({ parent, graphRevision: 1 })),
    (error) => error.code === "WORK_LEDGER_GRAPH_SOURCE_INVALID",
  );
  assert.equal(store.writes.length, writesBefore);
  assert.equal((await service.listItems()).items[0].itemId, parent.itemId);
});

test("a failed child write leaves both graph tasks and parent revision retryable", async () => {
  const { service, store } = await fixture(1);
  const parent = (await service.listItems()).items[0];
  const { planner } = graphPorts(service, "employee-orchestrator", null);
  const command = createCommand({ parent, graphRevision: 1 });
  store.failNextWrite();

  await assert.rejects(
    planner.createChild(command),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  let snapshot = await service.getGraphSnapshot();
  assert.equal(snapshot.graph.revision, 1);
  assert.equal(snapshot.graph.tasks.length, 1);
  assert.equal(snapshot.graph.tasks[0].revision, 1);
  const result = await planner.createChild(command);
  assert.equal(result.applied, true);
  snapshot = await service.getGraphSnapshot();
  assert.equal(snapshot.graph.revision, 2);
  assert.equal(snapshot.graph.tasks.length, 2);
});

test("two services racing one graph revision allow exactly one child write", async () => {
  const { service, store, lease, source } = await fixture(1);
  const competitor = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:01.000Z",
    idFactory: () => "competitor-lease",
  });
  await competitor.recover();
  const parent = (await service.listItems()).items[0];
  const first = graphPorts(service, "employee-orchestrator", null).planner;
  const second = graphPorts(
    competitor,
    "employee-orchestrator",
    null,
  ).planner;

  const settled = await Promise.allSettled([
    first.createChild(createCommand({
      parent,
      graphRevision: 1,
      childKey: "first-child",
    })),
    second.createChild(createCommand({
      parent,
      graphRevision: 1,
      childKey: "second-child",
    })),
  ]);

  assert.equal(
    settled.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = settled.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "WORK_LEDGER_STATE_REVISION_CONFLICT");
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: () => "2026-08-03T01:00:02.000Z",
    idFactory: () => "reader-lease",
  });
  await recovered.recover();
  assert.equal((await recovered.getGraphSnapshot()).graph.tasks.length, 2);
});
