import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { WorkConditionWaker } from "../src/services/work-condition-waker.js";
import { AUTO_RESUME_ON_CHILD_DELIVERY } from "../src/services/work-graph-wait-marker.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

function clone(value) {
  return structuredClone(value);
}

function waitingPair(condition, index = 1) {
  const itemId = `work-item-${index}`;
  const intentId = `work-intent-${index}`;
  return {
    item: {
      itemId,
      status: "waiting_condition",
      revision: 4,
      activeIntentId: intentId,
      decisionContext: null,
      ownerId: null,
      leaseId: null,
      leaseUntil: null,
    },
    outbox: {
      intentId,
      itemId,
      status: "delivered",
      intent: {
        schemaVersion: 1,
        type: "wait_condition",
        summary: "等待事实",
        reason: "满足后重试",
        condition: clone(condition),
        checkAfterSeconds: 60,
      },
    },
  };
}

class FakeLedger {
  constructor(pairs) {
    this.items = pairs.map(({ item }) => clone(item));
    this.outbox = pairs.map(({ outbox }) => clone(outbox));
    this.wakeCalls = [];
  }

  async listItems(options) {
    return {
      items: this.items.filter(({ status }) => status === options.status).map(clone),
      nextCursor: null,
    };
  }

  async listOutbox(options) {
    return {
      items: this.outbox.filter(({ status }) => status === options.status).map(clone),
      nextCursor: null,
    };
  }

  async wakeCondition(input) {
    this.wakeCalls.push(clone(input));
    const item = this.items.find(({ itemId }) => itemId === input.itemId);
    item.status = "queued";
    item.revision += 1;
    item.activeIntentId = null;
    return clone(item);
  }
}

test("round-robin condition scan reaches due work beyond a full waiting prefix", async () => {
  const ledger = new FakeLedger(Array.from({ length: 51 }, (_, index) => waitingPair({
    kind: "time", notBefore: index === 50 ? "2026-08-01T00:00:00.000Z" : "2027-08-01T00:00:00.000Z",
  }, index + 1)));
  const waker = new WorkConditionWaker({ ledger, clock: () => "2026-08-02T00:00:00.000Z" });
  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 1);
  assert.equal(ledger.wakeCalls[0].itemId, "work-item-51");
});

test("round-robin advances past invalid bindings and wraps without dropping work", async () => {
  const ledger = new FakeLedger([1, 2, 3].map((index) => waitingPair({ kind: "time", notBefore: "2027-08-01T00:00:00.000Z" }, index)));
  ledger.outbox = ledger.outbox.filter(({ itemId }) => itemId !== "work-item-1");
  const waker = new WorkConditionWaker({ ledger, clock: () => "2026-08-02T00:00:00.000Z" });
  const visited = [];
  for (let cycle = 0; cycle < 4; cycle++) visited.push((await waker.runCycle({ limit: 1 })).outcomes[0].itemId);
  assert.deepEqual(visited, ["work-item-1", "work-item-2", "work-item-3", "work-item-1"]);
  ledger.items = ledger.items.filter(({ itemId }) => itemId !== "work-item-1");
  assert.equal((await waker.runCycle({ limit: 1 })).outcomes[0].itemId, "work-item-2");
  assert.equal((await waker.runCycle({ limit: 1 })).outcomes[0].itemId, "work-item-3");
  ledger.items = [];
  assert.equal((await waker.runCycle()).scanned, 0);
});

test("submitted child delivery wakes only a parent explicitly marked as waiting for children", async () => {
  const ledger = new FakeLedger([]);
  const parent = {
    taskId: "work-item-root",
    revision: 4,
    parentTaskId: null,
    status: "paused",
    responsibility: { type: "role", id: "orchestrator" },
    deliveries: [],
  };
  const child = {
    taskId: "work-item-child",
    revision: 3,
    parentTaskId: parent.taskId,
    status: "waiting_external",
    responsibility: { type: "role", id: "developer" },
    deliveries: [{ status: "submitted" }],
  };
  ledger.items.push({ itemId: parent.taskId, revision: parent.revision, status: "paused", statusReason: AUTO_RESUME_ON_CHILD_DELIVERY });
  const resumeCalls = [];
  const waker = new WorkConditionWaker({
    ledger,
    graphReader: {
      async getSnapshot() {
        return { graph: { revision: 9, tasks: [parent, child] } };
      },
    },
    graphPlanner: {
      async resumeTask(command) {
        resumeCalls.push(clone(command));
        parent.status = "queued";
        parent.revision += 1;
      },
    },
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  await waker.runCycle();
  await waker.runCycle();

  assert.deepEqual(resumeCalls, [{
    taskId: parent.taskId,
    reason: "直属子任务已提交交付，恢复主脑验收",
    expectedGraphRevision: 9,
    expectedTaskRevision: 4,
  }]);
});

for (const variant of ["decision", "proposal", "unmarked", "missing-state", "stale-state", "bad-proof", "owner-paused", "parent-revision-changed", "failure-before-wait", "unknown-parent-time", "wrong-ledger-status"]) {
  test(`recorded child failure wakes only its current automatic parent wait (${variant})`, async () => {
    const ledger = new FakeLedger([]);
    const parent = { taskId: "failure-parent", revision: 4, parentTaskId: null, status: "paused",
      responsibility: { type: "role", id: "orchestrator" }, deliveries: [] };
    const child = { taskId: "failed-child", revision: 7, parentTaskId: parent.taskId, status: "in_progress",
      responsibility: { type: "role", id: "developer" }, deliveries: [] };
    const digest = "a".repeat(64);
    const failure = { code: "ROLE_DECISION_PR_REVIEW_REQUIRED", stage: "decision", taskRevision: child.revision,
      timelineId: `work-timeline-${digest}`, timelineDigest: digest, recordedAt: "2026-08-02T02:00:00.000Z" };
    const state = { taskId: child.taskId, taskRevision: child.revision, ledgerStatus: "blocked", decisionFailure: failure };
    if (variant === "proposal") { delete state.decisionFailure; state.proposalFailure = { ...failure, stage: "proposal", code: "CODE_ACTION_PROPOSAL_FAILED" }; }
    if (variant === "unmarked") delete state.decisionFailure;
    if (variant === "stale-state") state.taskRevision--;
    if (variant === "bad-proof") failure.timelineId = "unproven";
    if (variant === "wrong-ledger-status") state.ledgerStatus = "working";
    ledger.items.push({ itemId: parent.taskId, revision: parent.revision, status: "paused",
      statusReason: variant === "owner-paused" ? "owner-paused" : AUTO_RESUME_ON_CHILD_DELIVERY,
      updatedAt: variant === "failure-before-wait" ? "2026-08-02T02:00:01.000Z" : "2026-08-02T01:59:00.000Z" });
    if (variant === "unknown-parent-time") delete ledger.items[0].updatedAt;
    if (variant === "parent-revision-changed") ledger.items[0].revision++;
    const before = clone(child), calls = [];
    const waker = new WorkConditionWaker({ ledger,
      graphReader: { async getSnapshot() { return { graph: { revision: 9, tasks: [parent, child] },
        taskStates: variant === "missing-state" ? [] : [state] }; } },
      graphPlanner: { async resumeTask(command) { calls.push(clone(command)); parent.status = "queued"; parent.revision++; } },
    });
    await waker.runCycle(); await waker.runCycle();
    assert.deepEqual(calls, ["decision", "proposal"].includes(variant) ? [{ taskId: parent.taskId,
      reason: "直属子任务发生已记录失败，恢复主脑协调", expectedGraphRevision: 9, expectedTaskRevision: 4 }] : []);
    assert.deepEqual(child, before, "waking coordination never retries or completes the failed child");
    if (["decision", "proposal"].includes(variant)) {
      parent.status = "paused";
      Object.assign(ledger.items[0], { revision: parent.revision, updatedAt: "2026-08-02T02:01:00.000Z" });
      await waker.runCycle();
      assert.equal(calls.length, 1, "an already observed failure must not keep waking a newer parent wait");
    }
  });
}

test("submitted child delivery does not undo an intentional orchestrator pause", async () => {
  const ledger = new FakeLedger([]);
  const parent = {
    taskId: "work-item-root",
    revision: 4,
    parentTaskId: null,
    status: "paused",
    responsibility: { type: "role", id: "orchestrator" },
    deliveries: [],
  };
  const child = {
    taskId: "work-item-child",
    revision: 3,
    parentTaskId: parent.taskId,
    status: "waiting_external",
    responsibility: { type: "role", id: "developer" },
    deliveries: [{ status: "submitted" }],
  };
  ledger.items.push({ itemId: parent.taskId, revision: parent.revision, status: "paused", statusReason: "owner-paused" });
  const calls = [];
  const waker = new WorkConditionWaker({
    ledger,
    graphReader: { async getSnapshot() { return { graph: { revision: 9, tasks: [parent, child] } }; } },
    graphPlanner: { async resumeTask(command) { calls.push(command); } },
  });

  await waker.runCycle();
  assert.deepEqual(calls, []);
  ledger.items[0].statusReason = "waiting_for_children";
  await waker.runCycle();
  assert.deepEqual(calls, []);
  assert.equal(parent.status, "paused");
});

test("an intentional pause cannot hide another parent marked waiting for children", async () => {
  const ledger = new FakeLedger([]);
  const parents = ["owner-paused", AUTO_RESUME_ON_CHILD_DELIVERY].map((statusReason, index) => ({
    taskId: `root-${index}`,
    revision: 4,
    parentTaskId: null,
    status: "paused",
    responsibility: { type: "role", id: "orchestrator" },
    deliveries: [],
    statusReason,
  }));
  const children = parents.map((parent, index) => ({
    taskId: `child-${index}`,
    revision: 3,
    parentTaskId: parent.taskId,
    status: "waiting_external",
    responsibility: { type: "role", id: "developer" },
    deliveries: [{ status: "submitted" }],
  }));
  ledger.items.push(...parents.map(({ taskId, revision, statusReason }) => ({
    itemId: taskId,
    revision,
    status: "paused",
    statusReason,
  })));
  const resumed = [];
  const waker = new WorkConditionWaker({
    ledger,
    graphReader: { async getSnapshot() { return { graph: { revision: 9, tasks: [...parents, ...children] } }; } },
    graphPlanner: { async resumeTask({ taskId }) { resumed.push(taskId); } },
  });

  await waker.runCycle();
  assert.deepEqual(resumed, ["root-1"]);
});

test("time conditions wake only at the exact durable notBefore boundary", async () => {
  let now = Date.parse("2026-08-02T01:59:59.999Z");
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  const ledger = new FakeLedger([pair]);
  const waker = new WorkConditionWaker({
    ledger,
    clock: () => new Date(now).toISOString(),
  });

  const early = await waker.runCycle();
  assert.equal(early.woken, 0);
  assert.equal(ledger.wakeCalls.length, 0);

  now += 1;
  const due = await waker.runCycle();
  assert.equal(due.woken, 1);
  assert.deepEqual(ledger.wakeCalls[0].observation, {
    kind: "time",
    observedAt: "2026-08-02T02:00:00.000Z",
  });
});

test("workflow facts require healthy, fresh, and oneOf while exposing no lease token", async () => {
  const pair = waitingPair({
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const ledger = new FakeLedger([pair]);
  const responses = [
    { healthy: false, fresh: true, value: "success", observedAt: null },
    {
      healthy: true,
      fresh: false,
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
    {
      healthy: true,
      fresh: true,
      value: "failure",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
    {
      healthy: true,
      fresh: true,
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
  ];
  const factCalls = [];
  const factSource = {
    async read(input) {
      factCalls.push(input);
      return responses.shift();
    },
  };
  const waker = new WorkConditionWaker({
    ledger,
    factSource,
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 0);
  assert.equal((await waker.runCycle()).woken, 1);

  assert.equal(factCalls.every(({ fact }) => fact === "ci-status"), true);
  assert.equal(
    factCalls.every(({ item }) =>
      !Object.hasOwn(item, "ownerId") &&
      !Object.hasOwn(item, "leaseId") &&
      !Object.hasOwn(item, "leaseUntil")),
    true,
  );
  assert.deepEqual(ledger.wakeCalls[0].observation, {
    kind: "workflow_fact",
    fact: "ci-status",
    value: "success",
    observedAt: "2026-08-02T02:00:00.000Z",
  });
});

test("invalid fact observations and missing fact sources keep work waiting", async () => {
  const pair = waitingPair({
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const ledger = new FakeLedger([pair]);
  const invalid = {};
  Object.defineProperty(invalid, "healthy", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const waker = new WorkConditionWaker({
    ledger,
    factSource: { read: async () => invalid },
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  assert.equal((await waker.runCycle()).waiting, 1);
  assert.equal(ledger.wakeCalls.length, 0);

  const withoutSource = new WorkConditionWaker({
    ledger,
    clock: () => "2026-08-02T02:00:00.000Z",
  });
  assert.equal((await withoutSource.runCycle()).waiting, 1);
  assert.equal(ledger.wakeCalls.length, 0);
});

test("configuration-first admission leaves a due condition waiting", async () => {
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  const ledger = new FakeLedger([pair]);
  const gate = readyActionAdmissionGate();
  await activateNextConfiguration(gate);
  const waker = new WorkConditionWaker({
    ledger,
    actionAdmissionGate: gate,
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  await assert.rejects(
    waker.runCycle(),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(ledger.wakeCalls.length, 0);
  assert.equal(ledger.items[0].status, "waiting_condition");
});

test("wake-first admission releases cutover before durable storage settles", async () => {
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  const ledger = new FakeLedger([pair]);
  const wakeCondition = ledger.wakeCondition.bind(ledger);
  const wakeEntered = deferred();
  const releaseWake = deferred();
  ledger.wakeCondition = async (input) => {
    wakeEntered.resolve();
    await releaseWake.promise;
    return wakeCondition(input);
  };
  const gate = readyActionAdmissionGate();
  const waker = new WorkConditionWaker({
    ledger,
    actionAdmissionGate: gate,
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  const cycle = waker.runCycle();
  await wakeEntered.promise;
  const cutover = activateNextConfiguration(gate);
  const cutoverFinishedFirst = await Promise.race([
    cutover.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  releaseWake.resolve();
  await cutover;
  const result = await cycle;

  assert.equal(cutoverFinishedFirst, true);
  assert.equal(result.woken, 1);
  assert.equal(ledger.wakeCalls.length, 1);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("a synchronous wake failure retains direct-mode uncertain semantics", async () => {
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  const ledger = new FakeLedger([pair]);
  ledger.wakeCondition = () => {
    throw new Error("synchronous storage failure");
  };
  const waker = new WorkConditionWaker({
    ledger,
    clock: () => "2026-08-02T02:00:00.000Z",
  });

  const result = await waker.runCycle();

  assert.equal(result.uncertain, 1);
  assert.equal(result.outcomes[0].status, "wake_uncertain");
  assert.equal(ledger.items[0].status, "waiting_condition");
});

test("rejects an explicit invalid action admission gate", () => {
  const pair = waitingPair({
    kind: "time",
    notBefore: "2026-08-02T02:00:00.000Z",
  });
  assert.throws(
    () => new WorkConditionWaker({
      ledger: new FakeLedger([pair]),
      actionAdmissionGate: null,
    }),
    /actionAdmissionGate is invalid/,
  );
});

test("requires graph wake ports as a complete pair", () => {
  assert.throws(
    () => new WorkConditionWaker({
      ledger: new FakeLedger([]),
      graphReader: { getSnapshot: async () => ({}) },
    }),
    /graph wake ports must be configured together/,
  );
});
