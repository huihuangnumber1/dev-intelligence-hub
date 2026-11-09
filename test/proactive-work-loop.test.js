import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { readGitHubReviewFeedbackSnapshot } from "../src/adapters/github-review-feedback-snapshot.js";
import { GitHubReviewReader } from "../src/adapters/github-review-reader.js";
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { continuationFingerprint } from '../src/services/work-continuation-state.js';
import { createTaskRunSettler, planWorkItemRunControl } from '../src/services/work-ledger-run-control.js';
import { createNativeModelAdmission, retainUnknownNativeInvocations, withNativeAdmission } from '../src/lib/native-model-admission.js';

test('busy model admission leaves work unclaimed without consuming decision attempts', async () => {
  const time = controlledClock(), ledger = new FakeLedger({source:[workItem(1)],time});
  const candidate = worker(); let admissionCalls = 0;
  candidate.withDecisionAdmission = async (_input, _operation) => {
    admissionCalls++;
    throw Object.assign(new Error('capacity occupied'), {code:'STRUCTURED_PROVIDER_BUSY'});
  };
  const cycle = await createLoop({ledger,directory:new FakeRoleDirectory({'pr-reviewer':candidate}),time}).runCycle();
  assert.equal(admissionCalls,1);
  assert.equal(ledger.calls.claim.length,0);
  assert.equal(ledger.calls.scheduleRetry.length,0);
  assert.equal(cycle.workAttempts,0);
  assert.equal(cycle.claimed,0);
  assert.equal(cycle.outcomes[0].status,'waiting_model');
});

test('a model queue timeout leaves its task unclaimed and permits another candidate', async () => {
  const time = controlledClock(), first = workItem(1), second = workItem(2);
  const ledger = new FakeLedger({source:[first,second],time});
  const candidate = worker();
  candidate.withDecisionAdmission = async ({item}, operation) => {
    if (item.itemId === first.itemId) throw Object.assign(new Error('queue deadline reached'), {code:'STRUCTURED_PROVIDER_QUEUE_TIMEOUT'});
    return operation();
  };
  const cycle = await createLoop({ledger,directory:new FakeRoleDirectory({'pr-reviewer':candidate}),time}).runCycle();
  assert.equal(cycle.outcomes[0].status,'waiting_model');
  assert.equal(cycle.outcomes[0].code,'STRUCTURED_PROVIDER_QUEUE_TIMEOUT');
  assert.deepEqual(ledger.calls.claim.map(call=>call.itemId),[second.itemId]);
  assert.equal(ledger.items.find(item=>item.itemId===first.itemId).attempt,0);
  assert.equal(cycle.workAttempts,1);
});

test('unknown PR isolation cannot hold a role cycle ahead of unrelated work', async () => {
  const time=controlledClock(),first=workItem(1),second=workItem(2);
  const ledger=new FakeLedger({source:[first,second],time}),state=createNativeModelAdmission(2),candidate=worker();
  retainUnknownNativeInvocations(state,[{file:'/owned/old-marker',entity:first.itemId}]);
  candidate.withDecisionAdmission=({item,signal},operation)=>withNativeAdmission(state,item.itemId,signal,operation,{waitForCapacity:true});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('role cycle stayed behind an unknown invocation')),100);
  try {
    const cycle=await createLoop({ledger,directory:new FakeRoleDirectory({'pr-reviewer':candidate}),time})
      .runCycle({workLimit:1,signal:controller.signal});
    assert.equal(cycle.outcomes[0].status,'waiting_model');
    assert.equal(cycle.outcomes[0].code,'STRUCTURED_PROVIDER_BUSY');
    assert.deepEqual(ledger.calls.claim.map(call=>call.itemId),[second.itemId]);
    assert.equal(ledger.items.find(item=>item.itemId===first.itemId).attempt,0);
    assert.equal(state.active.size,1);
    assert.equal(state.unknownInvocations.size,1);
  } finally {clearTimeout(timer);controller.abort();}
});

for (const command of ['pause', 'cancel']) {
  test(`accepted ${command} survives a decision deadline until process stop is confirmed`, { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const time = controlledClock();
    const ledger = new FakeLedger({ source: [workItem(1)], time });
    ledger.readItemForReconciliation = async ({ itemId }) => clone(ledger.items.find((item) => item.itemId === itemId));
    ledger.controlModelRun = async (input) => {
      const plan = planWorkItemRunControl({ state: { items: ledger.items }, input, clock: time.clock });
      ledger.items = plan.patch.items;
      return clone(plan.result);
    };
    ledger.getSummary = async () => ({ revision: 1 });
    ledger.cancelGraphTask = async (input) => {
      const item = ledger.items.find((item) => item.itemId === input.itemId);
      assert.equal(input.expectedRevision, item.revision);
      assert.equal(item.status, 'paused');
      Object.assign(item, { status: 'cancelled', revision: item.revision + 1 });
    };
    let state = null;
    let stopped = false;
    const registry = new TaskRunRegistry({
      store: { read: async (_key, fallback) => state ?? fallback, write: async (_key, value) => { state = clone(value); } },
      settleControl: createTaskRunSettler({ ledger }),
      verifyStopped: async () => stopped,
    });
    const entered = deferred();
    const directory = new FakeRoleDirectory({ 'pr-reviewer': worker({ decide: async ({ signal }) => {
      entered.resolve();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('process stop unconfirmed'), {
          code: 'STRUCTURED_PROVIDER_REAP_FAILED',
        })), { once: true });
      });
    } }) });
    const cycle = createLoop({ ledger, directory, time, taskRuns: registry, decideTimeoutMs: 100 }).runCycle();
    await entered.promise;
    const view = (await registry.list()).items[0];
    const claim = clone(ledger.items[0]);
    await registry.control(view.kind, view.taskId, { runId: view.runId, expectedRevision: view.revision, command });
    t.mock.timers.tick(100);
    const result = await cycle;
    assert.equal(result.outcomes[0].status, 'control_pending');
    assert.equal(ledger.calls.scheduleRetry.length, 0);
    assert.equal(ledger.calls.stageIntent.length, 0);
    assert.deepEqual(ledger.items[0], claim, 'an unconfirmed stop must retain the original claim');
    await registry.reconcile();
    assert.equal((await registry.get(view.kind, view.taskId)).pendingCommand, command);
    stopped = true;
    await registry.reconcile();
    const settled = await registry.get(view.kind, view.taskId);
    assert.equal(settled.pendingCommand, null);
    assert.equal(settled.phase, command === 'pause' ? 'paused' : 'cancelled');
    assert.equal(ledger.items[0].status, settled.phase);
  });
}

test('accepted pause followed by model failure cannot stage intent or schedule ordinary retry',async()=>{
  const time=controlledClock();const ledger=new FakeLedger({source:[workItem(1)],time});
  const entered=deferred(),finish=deferred();let state=null;
  const registry=new TaskRunRegistry({store:{read:async(_k,f)=>state??f,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async()=>{}});
  const directory=new FakeRoleDirectory({'pr-reviewer':worker({decide:async()=>{entered.resolve();await finish.promise;throw new Error('provider failed');}})});
  const cycle=createLoop({ledger,directory,time,taskRuns:registry}).runCycle();
  await entered.promise;const view=(await registry.list()).items[0];
  await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
  finish.resolve();const result=await cycle;
  assert.equal(result.outcomes[0].status,'paused');assert.equal(ledger.calls.scheduleRetry.length,0);assert.equal(ledger.calls.stageIntent.length,0);
});

test('owner adjustment discards the old real role decision before staging', async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({source:[workItem(1)],time});
  let state = null;
  const registry = new TaskRunRegistry({store:{read:async(_k,f)=>state??f,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async()=>{}});
  const entered = deferred(); const gate = deferred(); const inputs=[];
  const directory = new FakeRoleDirectory({'pr-reviewer':worker({decide:async(input)=>{
    inputs.push(input); if(inputs.length===1){entered.resolve();await gate.promise;}
    return completeDecision(inputs.length===1?'old':'new');
  }})});
  const cycle = createLoop({ledger,directory,time,taskRuns:registry}).runCycle();
  await Promise.race([entered.promise,new Promise((_,r)=>setTimeout(()=>r(new Error('did not start')),1000))]);
  const view=(await registry.list()).items[0];
  if (!view) { gate.resolve(); await cycle; }
  assert.ok(view,'real decision must appear in the running list');
  await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'instruct',instruction:'check thread safety'});
  gate.resolve(); await cycle;
  assert.equal(inputs.length,2);
  assert.deepEqual(inputs[1].instructions,['check thread safety']);
  assert.equal(ledger.calls.stageIntent.length,1);
  assert.equal(ledger.calls.stageIntent[0].intent.summary,'new');
});
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { currentWorkItemExecutionBinding } from "../src/services/work-ledger-pr-source.js";
import { RoleContextAssembler, RoleContextAssemblerError } from "../src/services/role-context-assembler.js";
import { PrEngineerServiceError } from "../src/services/pr-engineer-service.js";
import { OrchestratorServiceError } from "../src/services/orchestrator-service.js";
import { assertExpectedWorkGraphRevision } from "../src/services/work-ledger-graph-command-support.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  });
}

function controlledClock() {
  let milliseconds = Date.parse("2026-08-02T08:00:00.000Z");
  return {
    clock: () => new Date(milliseconds).toISOString(),
    advance(value) {
      milliseconds += value;
    },
  };
}

function workItem(number, target = { type: "role", id: "pr-reviewer" }) {
  const timestamp = new Date(
    Date.parse("2026-08-02T07:00:00.000Z") + number * 1_000,
  ).toISOString();
  return {
    itemId: `work-item-${number}`,
    kind: "assignment",
    assignmentId: `workflow-assignment-${number}`,
    sourceSequence: number,
    inputDigest: `digest-${number}`,
    assignment: {
      assignmentId: `workflow-assignment-${number}`,
      target: clone(target),
    },
    event: {
      eventId: `workflow-event-${number}`,
      eventType: "pull_request.created",
      subject: { id: `github:pr:acme/repo#${number}` },
      payload: { number },
    },
    graph: {
      parentItemId: null,
      dependsOnItemIds: [],
      acceptanceContracts: [],
      deliveries: [],
    },
    currentTarget: clone(target),
    activeIntentId: null,
    decisionContext: null,
    status: "queued",
    revision: 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 0,
    availableAt: null,
    statusReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function issueWorkItem(number, updatedAt, labels = []) {
  const item = workItem(number);
  item.event = {
    eventId: `workflow-event-${number}`,
    eventType: "issue.observed",
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: `github:issue:acme/repo#${number}`,
      repository: "acme/repo",
      number,
    },
    payload: { updatedAt, labels },
  };
  return item;
}

function completeDecision(summary = "无需进一步操作") {
  return {
    schemaVersion: 1,
    confidence: 90,
    summary,
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary,
      reason: "已完成岗位判断",
      outcome: "no-action",
      evidence: [],
    },
  };
}

class FakeLedger {
  constructor({ source = [], time = controlledClock() } = {}) {
    this.source = source.map(clone);
    this.items = [];
    this.outbox = [];
    this.time = time;
    this.calls = {
      intake: [],
      retireInactiveIssues: [],
      listItems: [],
      claim: [],
      stageIntent: [],
      scheduleRetry: [],
      transition: [],
    };
    this.stageFailure = null;
    this.claimFailure = null;
    this.nextLease = 1;
  }

  async intake(input) {
    this.calls.intake.push(clone(input));
    const known = new Set(this.items.map(({ itemId }) => itemId));
    const created = this.source
      .filter(({ itemId }) => !known.has(itemId))
      .slice(0, input.limit);
    this.items.push(...created.map(clone));
    return {
      received: created.length,
      deduplicated: 0,
      cursor: this.items.length,
      highWatermark: this.source.length,
      gap: null,
      itemIds: created.map(({ itemId }) => itemId),
      alertItemId: null,
    };
  }

  async retireInactiveIssues(input) {
    this.calls.retireInactiveIssues.push(clone(input));
    let retired = 0;
    const selected = input.itemIds === undefined
      ? null
      : new Set(input.itemIds);
    for (const item of this.items) {
      const updatedAt = Date.parse(item.event?.payload?.updatedAt);
      if (
        (selected === null || selected.has(item.itemId)) &&
        item.status === "queued" &&
        item.event?.eventType?.startsWith("issue.") &&
        Number.isFinite(updatedAt) &&
        updatedAt < Date.parse(input.updatedBefore)
      ) {
        item.status = "cancelled";
        item.statusReason = "issue_outside_active_window";
        retired += 1;
      }
    }
    return { retired, itemIds: [] };
  }

  async listItems(options = {}) {
    this.calls.listItems.push(clone(options));
    const start = options.cursor
      ? this.items.findIndex(({ itemId }) => itemId === options.cursor) + 1
      : 0;
    const limit = options.limit || 50;
    const items = this.items.slice(start, start + limit).map(clone);
    return {
      items,
      nextCursor:
        start + items.length < this.items.length && items.length
          ? items.at(-1).itemId
          : null,
    };
  }

  async claim(input) {
    this.calls.claim.push(clone(input));
    if (this.claimFailure === "before_write") {
      this.claimFailure = null;
      throw new Error("claim write unavailable");
    }
    const item = this.#item(input.itemId);
    assert.equal(input.expectedRevision, item.revision);
    assert.equal(
      item.status === "queued" ||
        (item.status === "retry_wait" &&
          Date.parse(item.availableAt) <= Date.parse(this.time.clock())) ||
        (item.status === "working" &&
          Date.parse(item.leaseUntil) <= Date.parse(this.time.clock())),
      true,
    );
    item.status = "working";
    item.revision += 1;
    item.ownerId = input.workerId;
    item.leaseId = `lease-${this.nextLease++}`;
    item.leaseUntil = new Date(
      Date.parse(this.time.clock()) + input.leaseDurationMs,
    ).toISOString();
    item.attempt += 1;
    item.availableAt = null;
    item.statusReason = null;
    item.updatedAt = this.time.clock();
    if (this.claimFailure === "after_write") {
      this.claimFailure = null;
      throw new Error("claim acknowledgement lost");
    }
    return clone(item);
  }

  async stageIntent(input) {
    this.calls.stageIntent.push(clone(input));
    if (this.stageFailure === "before_write") {
      this.stageFailure = null;
      throw Object.assign(new Error("write failed"), {
        code: "WORK_LEDGER_STATE_WRITE_FAILED",
      });
    }
    const item = this.#leasedItem(input);
    item.status = "dispatch_pending";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.statusReason = "intent_staged";
    item.updatedAt = this.time.clock();
    this.outbox.push({
      intentId: `intent-${item.itemId}`,
      itemId: item.itemId,
      intent: clone(input.intent),
      status: "pending",
    });
    const result = {
      item: clone(item),
      outbox: clone(this.outbox.at(-1)),
    };
    if (this.stageFailure === "after_write") {
      this.stageFailure = null;
      throw Object.assign(new Error("acknowledgement lost"), {
        code: "WORK_LEDGER_STATE_WRITE_FAILED",
      });
    }
    return result;
  }

  async scheduleRetry(input) {
    this.calls.scheduleRetry.push(clone(input));
    const item = this.#leasedItem(input);
    if (input.consumeAttempt === false) item.attempt -= 1;
    item.status = "retry_wait";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.availableAt = input.availableAt;
    item.statusReason = input.reason;
    item.updatedAt = this.time.clock();
    return clone(item);
  }

  async transition(input) {
    this.calls.transition.push(clone(input));
    const item = this.#leasedItem(input);
    assert.equal(input.toStatus, "blocked");
    item.status = "blocked";
    item.revision += 1;
    item.ownerId = null;
    item.leaseId = null;
    item.leaseUntil = null;
    item.statusReason = input.reason;
    item.updatedAt = this.time.clock();
    return clone(item);
  }

  #item(itemId) {
    const item = this.items.find((candidate) => candidate.itemId === itemId);
    assert.ok(item, `missing fake item ${itemId}`);
    return item;
  }

  #leasedItem(input) {
    const item = this.#item(input.itemId);
    assert.equal(input.expectedRevision, item.revision);
    assert.equal(input.leaseId, item.leaseId);
    assert.equal(item.status, "working");
    return item;
  }
}

class FakeRoleDirectory {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.calls = [];
  }

  async resolve(target) {
    this.calls.push(clone(target));
    if (this.failure) throw this.failure;
    return this.entries.get(target.id) ?? null;
  }
}

function worker({
  roleId = "pr-reviewer",
  workerId = `employee-${roleId}`,
  paused = false,
  enabled = true,
  checkAvailability,
  decide = async () => completeDecision(),
} = {}) {
  return {
    roleId,
    workerId,
    paused,
    enabled,
    ...(checkAvailability ? { checkAvailability } : {}),
    decide,
  };
}

function createLoop({ ledger, directory, time, ...options }) {
  return new ProactiveWorkLoop({
    ledger,
    roleDirectory: directory,
    clock: time.clock,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    ...options,
  });
}

test("one deferred PR preparation does not abort other eligible work or spend its decision budget", async () => {
  for (const code of ["OWN_PR_REPAIR_OBJECT_FETCH_FAILED", "WORK_LEDGER_PR_EXECUTION_BINDING_STALE", "CONTROLLED_GIT_UNSUPPORTED_TREE", "CONTROLLED_GIT_TIMEOUT"]) {
    const time = controlledClock();
    const first = workItem(1, { type: "role", id: "developer" });
    const second = workItem(2, { type: "role", id: "developer" });
    const ledger = new FakeLedger({ source: [first, second], time });
    const loop = createLoop({ ledger, time,
      directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer" }) }),
      automaticOwnPrRepair: { async shouldRun(item) {
        if (item.itemId === first.itemId) throw Object.assign(new Error("private preparation diagnostic"), { code });
        return true;
      } },
    });
    const result = await loop.runCycle({ roleId: "developer" });
    assert.equal(result.claimed, 1);
    assert.ok(result.outcomes.some(outcome => outcome.itemId === first.itemId && outcome.status === "conflict_material_deferred" && outcome.code === code));
    assert.equal(ledger.items.find(item => item.itemId === first.itemId).attempt, 0);
    assert.deepEqual(ledger.calls.claim.map(call => call.itemId), [second.itemId]);
    assert.equal(JSON.stringify(result).includes("private preparation diagnostic"), false);
  }
});

test("PR preparation deferrals respect the scan budget and role scope", async () => {
  const time = controlledClock();
  const otherRole = workItem(1, { type: "role", id: "tester" });
  const developers = Array.from({ length: 8 }, (_, index) => workItem(index + 2, { type: "role", id: "developer" }));
  const healthy = workItem(10, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [otherRole, ...developers, healthy], time });
  const prepared = [];
  const loop = createLoop({ ledger, time, directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer" }) }),
    automaticOwnPrRepair: { async shouldRun(item) {
      prepared.push(item.itemId);
      if (item.itemId === healthy.itemId) return true;
      throw Object.assign(new Error("fetch unavailable"), { code: "OWN_PR_REPAIR_OBJECT_FETCH_FAILED" });
    } },
  });
  const result = await loop.runCycle({ roleId: "developer", workLimit: 1 });
  assert.equal(prepared.length, 4);
  assert.equal(prepared.includes(otherRole.itemId), false);
  assert.equal(result.claimed, 0);
  assert.ok(ledger.items.every(item => item.attempt === 0));
  assert.equal((await loop.runCycle({ roleId: "developer", workLimit: 1 })).claimed, 0);
  assert.equal(new Set(prepared).size, 8, "the next cycle visits the next failing candidates");
  assert.equal((await loop.runCycle({ roleId: "developer", workLimit: 1 })).claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(call => call.itemId), [healthy.itemId]);
});

test("a targeted continuation retries recovered PR preparation without waiting for a full sweep", async () => {
  const time = controlledClock();
  const items = Array.from({ length: 5 }, (_, index) => workItem(index + 1, { type: "role", id: "developer" }));
  const ledger = new FakeLedger({ source: items, time });
  let recovered = false;
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer" }) }),
    automaticOwnPrRepair: { async shouldRun() {
      if (!recovered) throw Object.assign(new Error("temporary fetch failure"), { code: "OWN_PR_REPAIR_OBJECT_FETCH_FAILED" });
      return true;
    } },
  });
  const first = await loop.runCycle({ roleId: "developer", workLimit: 1 });
  assert.equal(first.claimed, 0);
  assert.equal(first.outcomes.filter(x => x.status === "conflict_material_deferred").length, 4);
  recovered = true;
  const target = ledger.items[0];
  const retried = await loop.runCycle({ roleId: "developer", workLimit: 1,
    continuationTarget: { itemId: target.itemId, fingerprint: continuationFingerprint(target) } });
  assert.equal(retried.claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(x => x.itemId), [target.itemId]);
});

test("orchestrator scans do not prepare work owned by another available role", async () => {
  const time = controlledClock();
  const developer = workItem(1, { type: "role", id: "developer" });
  const root = workItem(2, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [developer, root], time });
  const prepared = [];
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer" }),
      orchestrator: worker({ roleId: "orchestrator" }) }),
    automaticOwnPrRepair: { async shouldRun(item) {
      prepared.push(item.itemId);
      if (item.itemId === developer.itemId) throw new Error("another role's preparation must not occupy the orchestrator");
      return true;
    } },
  });
  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(result.claimed, 1);
  assert.deepEqual(prepared, [root.itemId]);
  assert.deepEqual(ledger.calls.claim.map(call => call.itemId), [root.itemId]);
  assert.equal(ledger.items.find(item => item.itemId === developer.itemId).attempt, 0);
});

test("orchestrator fallback retains PR suppression for a missing role", async () => {
  const time = controlledClock();
  const item = workItem(1, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [item], time });
  const prepared = [];
  const loop = createLoop({ ledger, time, directory: new FakeRoleDirectory(),
    automaticOwnPrRepair: { async shouldRun(candidate) { prepared.push(candidate.itemId); return false; } },
  });
  const result = await loop.runCycle({ roleId: "orchestrator" });
  assert.deepEqual(prepared, [item.itemId]);
  assert.equal(result.claimed, 0);
  assert.equal(ledger.calls.claim.length, 0);
});

test("PR preparation still propagates unknown failures, runtime fences and cancellation", async () => {
  for (const code of ["UNEXPECTED_FAILURE", "RUNTIME_RESTART_REQUIRED", "aborted"]) {
    const time = controlledClock(), controller = new AbortController();
    const ledger = new FakeLedger({ source: [workItem(1)], time });
    const failure = Object.assign(new Error("preparation stopped"), { code });
    const loop = createLoop({ ledger, time, directory: new FakeRoleDirectory(),
      automaticOwnPrRepair: { async shouldRun() {
        if (code === "aborted") controller.abort(failure);
        throw code === "aborted" ? Object.assign(new Error("fetch failed"), { code: "OWN_PR_REPAIR_OBJECT_FETCH_FAILED" }) : failure;
      } },
    });
    await assert.rejects(loop.runCycle({ signal: controller.signal }), error => error === failure);
    assert.equal(ledger.calls.claim.length, 0);
  }
});

test("a conflict decision blocked without materials receives one bounded retry only after exact materials recover", async () => {
  for (const variant of ["current", "trimmed", "already-recovered", "changed-target", "wrong-failure", "preparation-failure"]) {
    const time = controlledClock();
    const item = workItem(42, { type: "role", id: "developer" });
    const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "runtime-user",
      baseRepository: "acme/repo", headRepository: "acme/repo", baseRefName: "main", headRefName: "feature",
      baseRefOid: "1".repeat(40), headRefOid: "2".repeat(40) };
    item.event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: item.createdAt,
      source: { provider: "github", scopeId: "test" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
      payload: { title: "Conflict repair", relation: "authored", nextAction: "resolve_conflict", headRefOid: gitTarget.headRefOid,
        mergeStateStatus: "DIRTY", gitTargetAvailable: true, gitTarget } });
    Object.assign(item, { kind: "graph_task", sourceQuarantine: null, revision: 20, attempt: 6,
      status: "blocked", statusReason: "decision_attempts_exhausted",
      decisionContext: { source: "proposal", referenceId: "inspect-proposal", outcome: "succeeded", value: { kind: "code_action_proposal" } } });
    item.assignment.graphTask = { sourceBinding: { kind: "pull_request", rootItemId: "pr-root", workKey: "pr-key",
      inputRevision: 1, headRevision: 1, headRefOid: gitTarget.headRefOid, eventId: item.event.eventId,
      eventDigest: item.event.contentDigest, inputDigest: "a".repeat(64) } };
    const binding = currentWorkItemExecutionBinding(item);
    assert.ok(binding);
    const timeline = [
      { sequence: 1, type: "graph_child_created", at: item.createdAt, details: { childTaskId: item.itemId, inputDigest: item.inputDigest } },
      { sequence: 2, type: "proposal_result_applied", details: { proposalId: "inspect-proposal", outcome: "succeeded" } },
      { sequence: 3, type: "transitioned", at: item.updatedAt, details: { reason: "decision_attempts_exhausted",
        context: { code: variant === "wrong-failure" ? "OTHER_FAILURE" : "ROLE_DECISION_PR_REVIEW_REQUIRED" } } },
    ];
    if (variant === "trimmed") timeline.shift();
    if (variant === "already-recovered") timeline.splice(1, 0, { sequence: 1.5, type: "transitioned", details: { reason: "conflict_inspection_material_recovered" } });
    const ledger = new FakeLedger({ source: [item], time });
    ledger.listTimeline = async () => ({ items: clone(timeline).reverse(), nextCursor: null });
    ledger.verifyPullRequestExecutionBinding = async value => value;
    const originalTransition = ledger.transition.bind(ledger);
    ledger.transition = async input => {
      if (input.toStatus !== "queued") return originalTransition(input);
      const current = ledger.items[0];
      assert.equal(input.expectedRevision, current.revision);
      Object.assign(current, { status: "queued", statusReason: input.reason, revision: current.revision + 1 });
      timeline.push({ sequence: 4, type: "transitioned", at: current.updatedAt, details: { reason: input.reason } });
      return clone(current);
    };
    let preparations = 0;
    const loop = createLoop({ ledger, time,
      automaticOwnPrRepair: { shouldRun: async () => true, conflictRepair: { prepareInspection: async () => {
        preparations += 1;
        if (variant === "preparation-failure") throw Object.assign(new Error("private diagnostic details"), { code: "OWN_PR_REPAIR_OBJECT_TIMEOUT" });
      } } },
      directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer",
      decide: async () => { throw Object.assign(new Error("subsequent model failure"), { code: "ROLE_DECISION_PR_REVIEW_REQUIRED" }); } }) }),
      roleContextAssembler: { async assemble({ item: current }) { assert.ok(preparations > 0); return { ...contextPacket(current, "developer"), context: { code: { conflictInspection: {
        inputBinding: variant === "changed-target" ? { ...binding, headRefOid: "9".repeat(40) } : binding,
        preparationBinding: { gitTarget, preparationId: "b".repeat(64) }, conflicts: [{ path: "src/app.js" }],
      } } } }; } }, orchestratorService: { async execute() {} } });
    const first = await loop.runCycle({ roleId: "developer" });
    assert.equal(first.claimed, variant === "current" ? 1 : 0, variant);
    assert.equal(preparations, ["current", "changed-target", "preparation-failure"].includes(variant) ? 1 : 0, variant);
    if (variant === "preparation-failure") {
      assert.ok(first.outcomes.some(outcome => outcome.status === "conflict_material_deferred" &&
        outcome.code === "OWN_PR_REPAIR_OBJECT_TIMEOUT"));
      assert.equal(JSON.stringify(first).includes("private diagnostic details"), false);
      assert.equal(ledger.calls.transition.length, 0);
    }
    assert.equal(ledger.items[0].attempt, variant === "current" ? 7 : 6, variant);
    if (variant === "current") {
      assert.equal((await loop.runCycle({ roleId: "developer" })).claimed, 0);
      assert.equal(timeline.filter(entry => entry.details.reason === "conflict_inspection_material_recovered").length, 1);
    }
  }
});

test("automatic graph decisions get one fresh format retry only for the exact completed native turn", async () => {
  for (const variant of ["current", "paged", "manual", "owner-paused", "active", "unknown-stop", "running-turn", "old-receipt", "wrong-lease", "wrong-failure", "trimmed", "already-retried", "paged-already-retried", "repeated-cursor", "stale-binding"]) {
    const time = controlledClock();
    const item = workItem(42, { type: "role", id: "developer" });
    const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "runtime-user",
      baseRepository: "acme/repo", headRepository: "acme/repo", baseRefName: "main", headRefName: "feature",
      baseRefOid: "1".repeat(40), headRefOid: "2".repeat(40) };
    item.event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: item.createdAt,
      source: { provider: "github", scopeId: "test" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
      payload: { title: "Repair feedback", relation: "authored", nextAction: "address_review", headRefOid: gitTarget.headRefOid,
        gitTargetAvailable: true, gitTarget } });
    Object.assign(item, { kind: "graph_task", sourceQuarantine: null, revision: 20, attempt: 4,
      status: "blocked", statusReason: "decision_attempts_exhausted",
      decisionContext: { source: "proposal", referenceId: "inspect-proposal", outcome: "succeeded", value: { kind: "code_action_proposal" } } });
    item.assignment.graphTask = { sourceBinding: { kind: "pull_request", rootItemId: "pr-root", workKey: "pr-key",
      inputRevision: 1, headRevision: 1, headRefOid: gitTarget.headRefOid, eventId: item.event.eventId,
      eventDigest: item.event.contentDigest, inputDigest: "a".repeat(64) } };
    const timeline = [
      { sequence: 1, type: "graph_child_created", at: item.createdAt, details: { childTaskId: item.itemId, inputDigest: item.inputDigest } },
      { sequence: 2, type: "proposal_result_applied", details: { proposalId: "inspect-proposal", outcome: "succeeded" } },
      { sequence: 3, type: "claimed", at: item.updatedAt, details: { leaseId: "failed-lease", attempt: item.attempt, inputDigest: item.inputDigest } },
      { sequence: 4, type: "transitioned", at: item.updatedAt, details: { fromStatus: "working", toStatus: "blocked", reason: "decision_attempts_exhausted",
        context: { code: variant === "wrong-failure" ? "OTHER_FAILURE" : "STRUCTURED_PROVIDER_RESPONSE_INVALID" } } },
    ];
    if (variant === "trimmed") timeline.shift();
    if (["already-retried", "paged-already-retried"].includes(variant)) timeline.splice(1, 0, { sequence: 1.5, type: "transitioned", details: { reason: "native_result_string_format_retried" } });
    const ledger = new FakeLedger({ source: [item], time });
    ledger.listTimeline = async ({ cursor }) => {
      const newest = clone(timeline).reverse();
      if (["paged", "paged-already-retried", "repeated-cursor"].includes(variant)) {
        return cursor === undefined || variant === "repeated-cursor"
          ? { items: newest.slice(0, 2), nextCursor: "older-history" }
          : { items: newest.slice(2), nextCursor: null };
      }
      return { items: newest, nextCursor: null };
    };
    ledger.verifyPullRequestExecutionBinding = async binding => {
      if (variant === "stale-binding") throw Object.assign(new Error("changed target"), { code: "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" });
      return binding;
    };
    const transition = ledger.transition.bind(ledger);
    ledger.transition = async input => {
      if (input.toStatus !== "queued") return transition(input);
      assert.equal(input.expectedRevision, ledger.items[0].revision);
      Object.assign(ledger.items[0], { status: "queued", statusReason: input.reason, revision: item.revision + 1 });
      timeline.push({ sequence: 5, type: "transitioned", at: item.updatedAt, details: { reason: input.reason } });
      return clone(ledger.items[0]);
    };
    const loop = createLoop({ ledger, time,
      ...(variant === "manual" ? {} : { automaticOwnPrRepair: { shouldRun: async () => true } }),
      taskRuns: {
        order: async items => items,
        run: async (_task, operation) => operation(),
        get: async () => ({ active: variant === "active", mode: variant === "owner-paused" ? "paused" : "active",
          phase: "failed", pendingCommand: null, stopUnconfirmed: variant === "unknown-stop", receipt: {
            runId: "failed-native-run", kind: "work-item", taskId: item.itemId, roleId: "developer", phase: "failed",
            taskRevision: variant === "old-receipt" ? 18 : 19, leaseId: variant === "wrong-lease" ? "other" : "failed-lease",
            registeredAt: item.updatedAt, modelStartedAt: item.updatedAt, finishedAt: item.updatedAt,
            outcomeCode: "STRUCTURED_PROVIDER_RESPONSE_INVALID", session: { transport: "app-server", status: variant === "running-turn" ? "running" : "completed" },
          } }),
      },
      directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async () => {
        throw Object.assign(new Error("model failed again"), { code: "STRUCTURED_PROVIDER_RESPONSE_INVALID" });
      } }) }),
    });
    const eligible = ["current", "paged"].includes(variant);
    assert.equal((await loop.runCycle({ roleId: "developer" })).claimed, eligible ? 1 : 0, variant);
    assert.equal(ledger.items[0].attempt, eligible ? 5 : 4, variant);
    if (eligible) {
      assert.equal((await loop.runCycle({ roleId: "developer" })).claimed, 0);
      assert.equal(timeline.filter(entry => entry.details.reason === "native_result_string_format_retried").length, 1);
    }
  }
});

test("a cycle reliably intakes, claims, decides, and only stages an intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let decisionInput;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async (input) => {
        decisionInput = input;
        return completeDecision("PR 当前无需动作");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ trigger: "manual" });

  assert.equal(result.intake.received, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.equal(ledger.items[0].status, "dispatch_pending");
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "complete");
  assert.equal(decisionInput.trigger, "manual");
  assert.equal(decisionInput.item.status, "working");
  assert.equal(Object.hasOwn(decisionInput.item, "ownerId"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "leaseId"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "leaseUntil"), false);
  assert.equal(Object.hasOwn(decisionInput.item, "decisionContext"), true);
  assert.deepEqual(ledger.calls.claim[0], {
    itemId: "work-item-1",
    expectedRevision: 1,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 120_000,
  });
  assert.equal(ledger.calls.stageIntent[0].expectedRevision, 2);
  assert.equal(ledger.calls.stageIntent[0].leaseId, "lease-1");
  assert.equal(ledger.calls.stageIntent[0].roleId, "pr-reviewer");
});

test("a deferred intake is observable without preventing existing tasks from running", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  await ledger.intake({ limit: 100 });
  ledger.intake = async () => ({
    received: 0, deduplicated: 0, cursor: 1, highWatermark: 2,
    gap: null, itemIds: [], alertItemId: null,
    error: { code: "WORK_LEDGER_GRAPH_TRANSITION_INVALID", afterSequence: 1, nextSequence: 2 },
  });
  const loop = createLoop({
    ledger, time, directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
  });
  const result = await loop.runCycle();
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.ok(result.outcomes.some(({ status, code }) =>
    status === "intake_deferred" && code === "WORK_LEDGER_GRAPH_TRANSITION_INVALID"));
});

test("unsafe intake storage errors still stop the role cycle", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  await ledger.intake({ limit: 100 });
  ledger.intake = async () => {
    throw Object.assign(new Error("write failed"), { code: "WORK_LEDGER_STATE_WRITE_FAILED" });
  };
  const loop = createLoop({
    ledger, time, directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
  });
  await assert.rejects(loop.runCycle(), { code: "WORK_LEDGER_STATE_WRITE_FAILED" });
  assert.equal(ledger.calls.claim.length, 0);
});

test("a role cycle scans only current claim candidates instead of durable history", async () => {
  const time = controlledClock();
  const current = workItem(1);
  const history = Array.from({ length: 60 }, (_, index) => {
    const item = workItem(index + 2);
    item.status = "completed";
    return item;
  });
  const ledger = new FakeLedger({ source: [current, ...history], time });
  const candidateCalls = [];
  ledger.listClaimCandidates = async (options) => {
    candidateCalls.push(clone(options));
    return {
      items: [clone(current)],
      nextCursor: null,
      facts: [{
        itemId: current.itemId,
        graphBlocked: false,
        submittedChildren: 0,
        satisfiedChildren: 0,
      }],
      activeQuestionTargets: [],
    };
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const result = await loop.runCycle({
    trigger: "scheduled",
    roleId: "pr-reviewer",
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(candidateCalls, [{
    at: time.clock(),
    limit: 100,
    roleId: "pr-reviewer",
  }]);
  assert.equal(ledger.calls.listItems.length, 0);
});

test("candidate scanning refreshes its fixed time after intake", async () => {
  const time = controlledClock();
  const candidate = workItem(1);
  candidate.status = "retry_wait";
  candidate.availableAt = "2026-08-02T08:00:01.000Z";
  const ledger = new FakeLedger({ source: [candidate], time });
  const intake = ledger.intake.bind(ledger);
  ledger.intake = async (input) => {
    const result = await intake(input);
    time.advance(1_000);
    return result;
  };
  const candidateCalls = [];
  ledger.listClaimCandidates = async (options) => {
    candidateCalls.push(clone(options));
    const items = ledger.items.filter((item) =>
      item.status === "retry_wait" &&
      Date.parse(item.availableAt) <= Date.parse(options.at)
    ).map(clone);
    return {
      items,
      nextCursor: null,
      facts: items.map(({ itemId }) => ({
        itemId,
        graphBlocked: false,
        submittedChildren: 0,
        satisfiedChildren: 0,
      })),
      activeQuestionTargets: [],
    };
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const result = await loop.runCycle({
    trigger: "scheduled",
    roleId: "pr-reviewer",
  });

  assert.equal(result.claimed, 1);
  assert.equal(candidateCalls.length, 1);
  assert.equal(candidateCalls[0].at, "2026-08-02T08:00:01.000Z");
});

test("automatic work skips issues outside the configurable active window", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      issueWorkItem(1, "2026-06-01T08:00:00.000Z", ["p0"]),
      issueWorkItem(2, "2026-08-01T08:00:00.000Z"),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    issueActiveWindowDays: 14,
  });

  const result = await loop.runCycle({ trigger: "scheduled" });

  assert.equal(result.claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), ["work-item-2"]);
  assert.deepEqual(ledger.calls.retireInactiveIssues, [{
    updatedBefore: "2026-07-19T08:00:00.000Z",
  }]);
  assert.equal(ledger.items[0].status, "cancelled");
});

test("same-day Issue intake retires new stale work with a targeted sweep", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
    issueActiveWindowDays: 14,
  });

  await loop.runCycle({ trigger: "scheduled" });
  ledger.source.push(issueWorkItem(1, "2026-06-01T08:00:00.000Z"));
  await loop.runCycle({ trigger: "scheduled" });

  assert.equal(ledger.calls.retireInactiveIssues.length, 2);
  assert.deepEqual(ledger.calls.retireInactiveIssues[1], {
    updatedBefore: "2026-07-19T08:00:00.000Z",
    itemIds: ["work-item-1"],
  });
  assert.equal(ledger.items[0].status, "cancelled");
});

test("concurrent role cycles share one daily inactive-Issue sweep", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [], time });
  const sweepStarted = deferred();
  const releaseSweep = deferred();
  const retireInactiveIssues = ledger.retireInactiveIssues.bind(ledger);
  ledger.retireInactiveIssues = async (input) => {
    sweepStarted.resolve();
    await releaseSweep.promise;
    return retireInactiveIssues(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({ roleId: "developer" }),
      tester: worker({ roleId: "tester" }),
    }),
    time,
  });

  const developer = loop.runCycle({ roleId: "developer" });
  await sweepStarted.promise;
  const tester = loop.runCycle({ roleId: "tester" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseSweep.resolve();
  await Promise.all([developer, tester]);

  assert.deepEqual(ledger.calls.retireInactiveIssues, [{
    updatedBefore: "2026-07-19T08:00:00.000Z",
  }]);
});

test("automatic work chooses a high-priority recent issue before an ordinary one", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      issueWorkItem(1, "2026-08-01T08:00:00.000Z"),
      issueWorkItem(2, "2026-08-01T07:00:00.000Z", ["priority: high"]),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    issueActiveWindowDays: 14,
  });

  await loop.runCycle({ trigger: "scheduled", workLimit: 1 });

  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), ["work-item-2"]);
});

test("a paused PR role leaves every PR queued without asking or deciding", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2), workItem(3)],
    time,
  });
  let decisions = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      paused: true,
      decide: async () => {
        decisions += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimed, 0);
  assert.equal(decisions, 0);
  assert.equal(directory.calls.length, 1);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    "queued",
    "queued",
    "queued",
  ]);
});

test("provider credential degradation leaves the selected task unclaimed without fallback", async () => {
  const time = controlledClock();
  const source = workItem(4, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const availabilityItems = [];
  let fallbackCalls = 0;
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability({ item, signal }) {
        availabilityItems.push(item);
        assert.equal(signal instanceof AbortSignal, true);
        throw Object.assign(new Error("private credential detail"), {
          code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
        });
      },
      async decide() {
        fallbackCalls += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.equal(result.claimed, 0);
  assert.equal(result.claimAttempts, 0);
  assert.deepEqual(result.outcomes, [{
    itemId: source.itemId,
    status: "degraded",
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  }]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(fallbackCalls, 0);
  assert.equal(availabilityItems.length, 1);
  assert.equal(availabilityItems[0].event.eventType, "pull_request.created");
  assert.equal(Object.hasOwn(availabilityItems[0], "ownerId"), false);
});

test("availability remains item-specific while target resolution is cached", async () => {
  const time = controlledClock();
  const first = workItem(5, { type: "role", id: "developer" });
  const second = workItem(6, { type: "role", id: "developer" });
  first.event.eventType = "issue.updated";
  const ledger = new FakeLedger({ source: [first, second], time });
  const checkedEventTypes = [];
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability({ item }) {
        checkedEventTypes.push(item.event.eventType);
        throw Object.assign(new Error("provider unavailable"), {
          code: "STRUCTURED_PROVIDER_UNAVAILABLE",
        });
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer", workLimit: 2 });

  assert.equal(directory.calls.length, 1);
  assert.deepEqual(checkedEventTypes, ["issue.updated", "pull_request.created"]);
  assert.deepEqual(
    result.outcomes.map(({ status, code }) => ({ status, code })),
    [
      { status: "degraded", code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
      { status: "degraded", code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
    ],
  );
  assert.equal(ledger.calls.claim.length, 0);
});

test("one unavailable task cannot consume the work budget and starve a ready task", async () => {
  const time = controlledClock();
  const unavailable = workItem(106, { type: "role", id: "orchestrator" });
  const ready = workItem(107, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [unavailable, ready], time });
  const checked = [];
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      async checkAvailability({ item }) {
        checked.push(item.itemId);
        if (item.itemId === unavailable.itemId) {
          throw Object.assign(new Error("task brain missing"), {
            code: "ROLE_TASK_BRAIN_NOT_CONFIGURED",
          });
        }
      },
      async decide() {
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });

  assert.deepEqual(checked, [unavailable.itemId, ready.itemId]);
  assert.equal(result.availabilityChecks, 2);
  assert.equal(result.workAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(result.outcomes.map(({ status }) => status), [
    "degraded",
    "staged",
  ]);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[1].status, "dispatch_pending");
});

test("unexpected availability errors remain resolution failures before claim", async () => {
  const time = controlledClock();
  const source = workItem(7, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability() {
        throw new TypeError("programming error");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.deepEqual(result.outcomes, [{
    itemId: source.itemId,
    status: "resolution_failed",
    code: "ROLE_DECISION_FAILED",
  }]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.items[0].status, "queued");
});

test("availability failures preserve their safe cause without claiming the task", async () => {
  const time = controlledClock();
  const source = workItem(7, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      async checkAvailability() {
        throw Object.assign(new Error("private diagnostic must not be exposed"), {
          code: "ROLE_TASK_BINDING_INVALID",
        });
      },
    }),
  });
  const result = await createLoop({ ledger, directory, time }).runCycle({ roleId: "developer" });
  assert.deepEqual(result.outcomes, [{
    itemId: source.itemId,
    status: "resolution_failed",
    code: "ROLE_TASK_BINDING_INVALID",
  }]);
  assert.equal(ledger.calls.claim.length, 0);
});

test("ten assignments for one missing role create only one durable question", async () => {
  const time = controlledClock();
  const target = { type: "role", id: "missing-role" };
  const ledger = new FakeLedger({
    source: Array.from({ length: 10 }, (_, index) =>
      workItem(index + 1, target),
    ),
    time,
  });
  const directory = new FakeRoleDirectory();
  const loop = createLoop({ ledger, directory, time });

  const first = await loop.runCycle({ workLimit: 10 });
  const second = await loop.runCycle({ workLimit: 10 });

  assert.equal(first.claimed, 1);
  assert.equal(second.claimed, 0);
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(directory.calls.length, 2);
  assert.equal(
    ledger.items.filter(({ status }) => status === "dispatch_pending").length,
    1,
  );
  assert.equal(
    ledger.items.filter(({ status }) => status === "queued").length,
    9,
  );
});

test("person and node targets are preserved through separate orchestrator questions", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "person", id: "owner" }),
      workItem(2, { type: "node", id: "manual-gate" }),
    ],
    time,
  });
  const directory = new FakeRoleDirectory();
  const loop = createLoop({ ledger, directory, time });

  await loop.runCycle({ workLimit: 2 });

  assert.equal(directory.calls.length, 0);
  assert.equal(ledger.outbox.length, 2);
  assert.deepEqual(
    ledger.outbox.map(({ intent }) => intent.type),
    ["ask_user", "ask_user"],
  );
  assert.match(ledger.outbox[0].intent.question, /person:owner/);
  assert.match(ledger.outbox[1].intent.question, /node:manual-gate/);
});

test("decision failures use bounded retry and block at maxAttempts", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let decisions = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        decisions += 1;
        throw new Error("model unavailable");
      },
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
  });

  const first = await loop.runCycle();
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.items[0].availableAt, "2026-08-02T08:00:01.000Z");
  time.advance(1_000);

  const second = await loop.runCycle();
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].attempt, 2);
  assert.equal(decisions, 2);
  assert.equal(ledger.calls.scheduleRetry[0].expectedRevision, 2);
  assert.deepEqual(ledger.calls.scheduleRetry[0].details, {
    code: "ROLE_DECISION_FAILED",
  });
  assert.equal(ledger.calls.transition[0].expectedRevision, 4);
});

for (const code of ["PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE", "STRUCTURED_PROVIDER_UNAVAILABLE"])
test(`real native provider ${code} follows the existing decision retry budget`, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "work-loop-native-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  let materialReads = 0, modelStarts = 0;
  const materialFailure = code === "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE";
  const provider = createNativeCodexBrainProvider({ id: "native-budget-test", cliKind: "codex-cli", credentialMode: "codex-native-login" }, {
    environment: { CODEX_HOME: home, DIH_CODEX_NATIVE_TRANSPORT: "exec" },
    temporaryRoot: path.join(root, "runtime"),
    commandLocator: { async resolve() {
      if (!materialFailure) throw Object.assign(new Error("CLI unavailable"), { code });
      return { command: process.execPath, prefixArgs: [] };
    } },
    rootDirectoryManager: { async prepare({ directory, validateLocation, signal }) {
      signal?.throwIfAborted(); await validateLocation(); await mkdir(directory, { recursive: true });
      const stat = await lstat(directory, { bigint: true });
      return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) };
    } },
    processRunner: { async run() { modelStarts += 1; assert.fail("preparation failed before model start"); } },
    reviewReaderFactory: async () => {
      materialReads += 1;
      throw Object.assign(new Error("private material response"), { code });
    },
  });
  t.after(() => provider.close());
  const time = controlledClock(), ledger = new FakeLedger({ source: [workItem(1)], time });
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "owner", baseRepository: "owner/repo", headRepository: "owner/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
  const directory = new FakeRoleDirectory({ "pr-reviewer": worker({ decide: () => provider.generate({
    model: "gpt-6.1-sol", reasoningEffort: "high", messages: [{ role: "user", content: "Review required materials" }],
    schema: { type: "object" }, reviewTarget: { gitTarget, pullRequestNumber: 42 },
  }) }) });
  const loop = createLoop({ ledger, directory, time, maxAttempts: 2 });
  const first = await loop.runCycle();
  assert.equal(first.retried, 1);
  assert.equal(first.outcomes[0].code, code);
  assert.equal(ledger.items[0].attempt, materialFailure ? 1 : 0);
  assert.equal(ledger.calls.scheduleRetry[0].reason, materialFailure ? "decision_failed" : "system_maintenance_auto_retry");
  assert.equal(ledger.calls.scheduleRetry[0].consumeAttempt, materialFailure ? undefined : false);
  time.advance(60_000);
  const second = await loop.runCycle();
  assert.equal(second.outcomes[0].code, code);
  assert.equal(second.blocked, materialFailure ? 1 : 0);
  assert.equal(ledger.items[0].attempt, materialFailure ? 2 : 0);
  assert.equal(ledger.items[0].status, materialFailure ? "blocked" : "retry_wait");
  if (materialFailure) {
    assert.equal(ledger.calls.transition[0].reason, "decision_attempts_exhausted");
    assert.deepEqual(ledger.calls.transition[0].details, { code });
    time.advance(60_000);
    assert.equal((await loop.runCycle()).claimed, 0);
  } else {
    time.advance(60_000);
    assert.equal((await loop.runCycle()).retried, 1);
    assert.equal(ledger.items[0].attempt, 0);
    assert.ok(ledger.calls.scheduleRetry.every(call => call.consumeAttempt === false));
    assert.equal(ledger.calls.transition.length, 0);
  }
  assert.equal(materialReads, materialFailure ? 2 : 0);
  assert.equal(modelStarts, 0);
  assert.equal(ledger.outbox.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

for (const source of ["missing-feedback", "forged-raw-io", "unknown-factory", "forged-factory"])
test(`reader-owned ${source} failure crosses the native provider and exhausts the finite work budget`, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "work-loop-feedback-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  let modelStarts = 0;
  const sourceCode = source === "missing-feedback" ? "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE"
    : source === "forged-raw-io" ? "PR_REVIEW_READ_UNAVAILABLE" : "STRUCTURED_PROVIDER_REQUEST_FAILED";
  const reader = new GitHubReviewReader({ async run() {
    throw { code: "STRUCTURED_PROVIDER_UNAVAILABLE", domain: "infrastructure", retryable: true, infrastructure: true, message: "private source body" };
  } });
  const provider = createNativeCodexBrainProvider({ id: "native-feedback-budget-test", cliKind: "codex-cli", credentialMode: "codex-native-login" }, {
    environment: { CODEX_HOME: home, DIH_CODEX_NATIVE_TRANSPORT: "exec" }, temporaryRoot: path.join(root, "runtime"),
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: [] }; } },
    rootDirectoryManager: { async prepare({ directory, validateLocation, signal }) {
      signal?.throwIfAborted(); await validateLocation(); await mkdir(directory, { recursive: true });
      const stat = await lstat(directory, { bigint: true });
      return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) };
    } },
    processRunner: { async run() { modelStarts++; assert.fail("missing required feedback must prevent model startup"); } },
    reviewReaderFactory: (target, options) => {
      if (source === "unknown-factory") throw new Error("private unclassified reader failure");
      if (source === "forged-factory") throw { code: "PR_REVIEW_READ_UNKNOWN", domain: "infrastructure", retryable: true, infrastructure: true };
      return source === "missing-feedback" ? readGitHubReviewFeedbackSnapshot({ target, options }) : reader.open(target, options);
    },
  });
  t.after(() => provider.close());
  const time = controlledClock(), ledger = new FakeLedger({ source: [workItem(1)], time });
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "owner", baseRepository: "owner/repo", headRepository: "owner/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
  const directory = new FakeRoleDirectory({ "pr-reviewer": worker({ decide: () => provider.generate({
    model: "gpt-6.1-sol", reasoningEffort: "high", messages: [{ role: "user", content: "Read required feedback" }], schema: { type: "object" },
    reviewTarget: { gitTarget, pullRequestNumber: 42, feedbackSnapshot: { taskId: "review-child", materialDigest: "c".repeat(64) } },
  }) }) });
  const loop = createLoop({ ledger, directory, time, maxAttempts: 2 });
  const first = await loop.runCycle();
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].attempt, 1);
  assert.equal(first.outcomes[0].code, sourceCode);
  assert.equal(ledger.calls.scheduleRetry[0].reason, "decision_failed");
  time.advance(60_000);
  const second = await loop.runCycle();
  assert.equal(second.outcomes[0].code, sourceCode);
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].attempt, 2);
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.calls.transition[0].reason, "decision_attempts_exhausted");
  time.advance(60_000);
  assert.equal((await loop.runCycle()).claimed, 0);
  assert.equal(modelStarts, 0);
  assert.equal(ledger.outbox.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("a lost stage acknowledgement is observed as one durable intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.stageFailure = "after_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.recoveredStages, 1);
  assert.equal(ledger.items[0].status, "dispatch_pending");
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.intake.length, 2);
});

test("a stage failure before persistence safely schedules the leased item", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.stageFailure = "before_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.retried, 1);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.outbox.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 1);
  assert.equal(ledger.calls.scheduleRetry[0].expectedRevision, 2);
  assert.equal(ledger.calls.scheduleRetry[0].leaseId, "lease-1");
});

test("concurrent runCycle calls share one in-flight decision", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  let release;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const decision = new Promise((resolve) => {
    release = resolve;
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        startedResolve();
        return decision;
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const first = loop.runCycle({ trigger: "scheduled" });
  await started;
  const second = loop.runCycle({ trigger: "manual" });
  assert.strictEqual(second, first);
  release(completeDecision());
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.trigger, "scheduled");
  assert.equal(ledger.calls.intake.length, 1);
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a role-scoped cycle only decides work resolved to that role", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "role", id: "requirements-analyst" }),
      workItem(2, { type: "role", id: "developer" }),
    ],
    time,
  });
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({ roleId: "requirements-analyst" }),
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({
    trigger: "employee:requirements-analyst",
    roleId: "requirements-analyst",
  });

  assert.equal(result.roleId, "requirements-analyst");
  assert.deepEqual(directory.calls, [
    { type: "role", id: "requirements-analyst" },
  ]);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1"],
  );
  assert.deepEqual(
    ledger.items.map(({ status }) => status),
    ["dispatch_pending", "queued"],
  );
});

test("same role signals coalesce while different role cycles remain isolated", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(1, { type: "role", id: "requirements-analyst" }),
      workItem(2, { type: "role", id: "developer" }),
    ],
    time,
  });
  const requirementsStarted = deferred();
  const releaseRequirements = deferred();
  let developerStarted = false;
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({
      roleId: "requirements-analyst",
      decide: async () => {
        requirementsStarted.resolve();
        await releaseRequirements.promise;
        return completeDecision("需求已梳理");
      },
    }),
    developer: worker({
      roleId: "developer",
      decide: async () => {
        developerStarted = true;
        return completeDecision("开发已判断");
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const requirements = loop.runCycle({
    trigger: "employee:requirements-analyst",
    roleId: "requirements-analyst",
  });
  await requirementsStarted.promise;
  const duplicateRequirements = loop.runCycle({
    trigger: "manual",
    roleId: "requirements-analyst",
  });
  const developer = loop.runCycle({
    trigger: "employee:developer",
    roleId: "developer",
  });

  assert.strictEqual(duplicateRequirements, requirements);
  assert.notStrictEqual(developer, requirements);
  assert.equal(developerStarted, false);

  releaseRequirements.resolve();
  const [requirementsResult, duplicateResult, developerResult] =
    await Promise.all([requirements, duplicateRequirements, developer]);

  assert.deepEqual(duplicateResult, requirementsResult);
  assert.equal(developerResult.roleId, "developer");
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1", "work-item-2"],
  );
});

test("workLimit processes the oldest available items first", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2), workItem(3)],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const first = await loop.runCycle({ workLimit: 2 });

  assert.equal(first.claimed, 2);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    ["work-item-1", "work-item-2"],
  );
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    "dispatch_pending",
    "dispatch_pending",
    "queued",
  ]);

  await loop.runCycle({ workLimit: 2 });
  assert.equal(ledger.items[2].status, "dispatch_pending");
});

test("explicit local owner requests take priority without reordering peers", async () => {
  const time = controlledClock();
  const oldest = workItem(1);
  const high = workItem(2);
  const urgent = workItem(3);
  const laterHigh = workItem(4);
  for (const [item, priority] of [
    [high, "high"],
    [urgent, "urgent"],
    [laterHigh, "high"],
  ]) {
    item.event.eventType = "pull_request.owner_requested";
    item.event.source = {
      provider: "local-owner",
      scopeId: `owner-request:${item.itemId}`,
    };
    item.event.payload.priority = priority;
  }
  const ledger = new FakeLedger({
    source: [oldest, high, urgent, laterHigh],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  await loop.runCycle({ workLimit: 3 });

  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    [urgent.itemId, high.itemId, laterHigh.itemId],
  );
  assert.equal(ledger.items[0].status, "queued");
});

test("configured roots with more settled child work close before peer roots", async () => {
  const time = controlledClock();
  const firstRoot = workItem(31, { type: "role", id: "orchestrator" });
  const laterRoot = workItem(32, { type: "role", id: "orchestrator" });
  const children = [
    [workItem(33, { type: "role", id: "developer" }), firstRoot],
    [workItem(34, { type: "role", id: "developer" }), laterRoot],
    [workItem(35, { type: "role", id: "tester" }), laterRoot],
  ];
  for (const [child, parent] of children) {
    child.graph = { parentItemId: parent.itemId, dependsOnItemIds: [], deliveries: [] };
    child.status = "completed";
  }
  const ledger = new FakeLedger({
    source: [firstRoot, children[0][0], laterRoot, children[1][0], children[2][0]],
    time,
  });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision("完成根任务"),
    }),
    developer: worker({ roleId: "developer" }),
    tester: worker({ roleId: "tester" }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });

  assert.equal(ledger.calls.claim[0].itemId, laterRoot.itemId);
  assert.equal(ledger.calls.stageIntent[0].itemId, laterRoot.itemId);
});

function rootProgressPriorityLoop({ blockedBy = "child", useCandidateFacts = false, priority = "high", delivery = null, settledChild = false, orchestrateWaiting = false }) {
  const time = controlledClock();
  const waitingRoot = workItem(51, { type: "role", id: "orchestrator" });
  const healthyRoot = workItem(52, { type: "role", id: "orchestrator" });
  for (const root of [waitingRoot, healthyRoot]) {
    root.event.eventType = "pull_request.owner_requested";
    root.event.source = { provider: "local-owner", scopeId: `owner-request:${root.itemId}` };
    root.event.payload.priority = root === waitingRoot ? priority : "high";
  }
  waitingRoot.statusReason = "waiting_for_children";
  const blocker = workItem(53, { type: "role", id: "developer" });
  blocker.status = "blocked";
  if (blockedBy === "child") blocker.graph.parentItemId = waitingRoot.itemId;
  else waitingRoot.graph.dependsOnItemIds = [blocker.itemId];
  if (delivery !== null) blocker.graph.deliveries = [{ status: delivery }];
  const cancelled = workItem(24723, { type: "role", id: "orchestrator" });
  Object.assign(cancelled, { status: "cancelled", revision: 11 });
  const settled = workItem(54, { type: "role", id: "tester" });
  settled.status = "completed";
  settled.graph.parentItemId = waitingRoot.itemId;
  const ledger = new FakeLedger({
    source: [waitingRoot, healthyRoot, blocker, cancelled, ...(settledChild ? [settled] : [])], time,
  });
  if (useCandidateFacts) {
    ledger.listClaimCandidates = async () => ({
      items: [clone(waitingRoot), clone(healthyRoot)], nextCursor: null,
      activeQuestionTargets: [],
      facts: [waitingRoot, healthyRoot].map((root) => ({
        itemId: root.itemId, graphBlocked: root === waitingRoot,
        submittedChildren: root === waitingRoot && delivery === "submitted" ? 1 : 0,
        satisfiedChildren: root === waitingRoot && settledChild ? 1 : 0,
      })),
    });
  }
  const decisions = [];
  const executions = [];
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({
      orchestrator: worker({ roleId: "orchestrator", workerId: "employee-orchestrator",
        async decide({ item }) {
          decisions.push(item.itemId);
          return item.itemId === waitingRoot.itemId && orchestrateWaiting
            ? orchestrationDecision(item) : completeDecision();
        } }),
      developer: worker({ roleId: "developer" }),
    }),
    roleContextAssembler: { async assemble({ roleId, item }) { return contextPacket(item, roleId); } },
    orchestratorService: { async execute({ item }) {
      executions.push(item.itemId); return { applied: true };
    } },
  });
  return { loop, ledger, waitingRoot, healthyRoot, cancelled, decisions, executions };
}

test("ready roots precede equally urgent parents waiting without child results", async (t) => {
  for (const blockedBy of ["child", "dependency"]) {
    for (const useCandidateFacts of [false, true]) {
      await t.test(`${blockedBy}, candidate facts: ${useCandidateFacts}`, async () => {
        const { loop, ledger, healthyRoot, cancelled, decisions } = rootProgressPriorityLoop({ blockedBy, useCandidateFacts });
        await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
        assert.deepEqual(decisions, [healthyRoot.itemId]);
        assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), [healthyRoot.itemId]);
        assert.deepEqual(ledger.items.find(({ itemId }) => itemId === cancelled.itemId), cancelled);
      });
    }
  }
});

test("higher owner priority retains waiting-root orchestration ahead of ready peers", async () => {
  const { loop, ledger, waitingRoot, decisions, executions } = rootProgressPriorityLoop({ priority: "urgent", orchestrateWaiting: true });
  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(result.orchestrated, 1);
  assert.deepEqual(decisions, [waitingRoot.itemId]);
  assert.deepEqual(executions, [waitingRoot.itemId]);
  assert.equal(ledger.calls.claim.length, 0);
});

test("a targeted continuation coordinates its current lower-ranked root without an ordinary claim", async () => {
  const { loop, ledger, waitingRoot, decisions, executions } = rootProgressPriorityLoop({
    useCandidateFacts: true, orchestrateWaiting: true });
  const result = await loop.runCycle({ roleId: 'orchestrator', workLimit: 1,
    continuationTarget: { itemId: waitingRoot.itemId, fingerprint: continuationFingerprint(waitingRoot) } });
  assert.equal(result.orchestrated, 1);
  assert.deepEqual(decisions, [waitingRoot.itemId]);
  assert.deepEqual(executions, [waitingRoot.itemId]);
  assert.equal(ledger.calls.claim.length, 0);
});

test("a stale, paused or missing continuation target never falls back to a ready peer", async (t) => {
  for (const state of ['stale', 'paused', 'missing', 'role-changed']) await t.test(state, async () => {
    const { loop, ledger, waitingRoot, decisions, executions } = rootProgressPriorityLoop({ orchestrateWaiting: true });
    const continuationTarget = { itemId: waitingRoot.itemId, fingerprint: continuationFingerprint(waitingRoot) };
    const item = ledger.source.find(x => x.itemId === waitingRoot.itemId);
    if (state === 'stale') item.revision += 1;
    if (state === 'paused') item.status = 'paused';
    if (state === 'missing') continuationTarget.itemId = 'work-missing';
    if (state === 'role-changed') item.currentTarget.id = 'tester';
    await loop.runCycle({ roleId: 'orchestrator', workLimit: 1, continuationTarget });
    assert.deepEqual(decisions, []);
    assert.deepEqual(executions, []);
    assert.equal(ledger.calls.claim.length, 0);
  });
});

test("urgent issue roots retain priority while waiting for blocked child work", async () => {
  const { loop, ledger, waitingRoot, healthyRoot, decisions } = rootProgressPriorityLoop({});
  for (const root of ledger.source.filter(({ itemId }) =>
    itemId === waitingRoot.itemId || itemId === healthyRoot.itemId)) {
    root.event = issueWorkItem(root.event.payload.number, "2026-08-02T07:30:00.000Z",
      root.itemId === waitingRoot.itemId ? ["P0"] : []).event;
  }
  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.deepEqual(decisions, [waitingRoot.itemId]);
  assert.equal(result.outcomes[0].status, "graph_blocked");
  assert.equal(ledger.calls.claim.length, 0);
});

test("submitted child results retain waiting-root priority ahead of ready peers", async (t) => {
  for (const useCandidateFacts of [false, true]) {
    await t.test(`candidate facts: ${useCandidateFacts}`, async () => {
      const { loop, waitingRoot, decisions } = rootProgressPriorityLoop({ delivery: "submitted", useCandidateFacts, orchestrateWaiting: true });
      const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      assert.equal(result.orchestrated, 1);
      assert.deepEqual(decisions, [waitingRoot.itemId]);
    });
  }
});

test("settled child results retain priority even while another child is blocked", async (t) => {
  for (const useCandidateFacts of [false, true]) {
    await t.test(`candidate facts: ${useCandidateFacts}`, async () => {
      const { loop, waitingRoot, decisions } = rootProgressPriorityLoop({ settledChild: true, useCandidateFacts, orchestrateWaiting: true });
      const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      assert.equal(result.orchestrated, 1);
      assert.deepEqual(decisions, [waitingRoot.itemId]);
    });
  }
});

test("graph-blocked parents do not consume the claim budget before ready children", async () => {
  const time = controlledClock();
  const parent = workItem(1);
  const child = workItem(2);
  parent.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [],
    deliveries: [],
  };
  child.graph = {
    parentItemId: parent.itemId,
    dependsOnItemIds: [],
    acceptanceContracts: [],
    deliveries: [],
  };
  const ledger = new FakeLedger({ source: [parent, child], time });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId),
    [child.itemId],
  );
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[1].status, "dispatch_pending");
});

test("workLimit bounds claim attempts even when a claim is not acquired", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2)],
    time,
  });
  ledger.claimFailure = "before_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 0);
  assert.equal(ledger.calls.claim.length, 1);
  assert.deepEqual(ledger.items.map(({ status }) => status), ["queued", "queued"]);
});

test("a fenced PR claim does not starve the next claimable task", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 5 }, (_, index) => workItem(index + 1));
  const ready = workItem(6);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.workAttempts, 1);
  assert.equal(result.availabilityChecks, 6);
  assert.equal(result.claimAttempts, 6);
  assert.equal(result.claimed, 1);
  assert.deepEqual(
    result.outcomes.map(({ status, code }) => ({ status, code })),
    [
      ...fenced.map(() => ({
      status: "claim_not_acquired",
      code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      })),
      { status: "staged", code: undefined },
    ],
  );
  assert.deepEqual(ledger.items.map(({ status }) => status), [
    ...fenced.map(() => "queued"),
    "dispatch_pending",
  ]);
});

test("fenced PR claim scanning stops at its independent safety cap", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  ledger.claim = async (input) => {
    ledger.calls.claim.push(clone(input));
    throw Object.assign(new Error("PR source authority is fenced"), {
      code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
    });
  };
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 1 });

  assert.equal(result.workAttempts, 0);
  assert.equal(result.availabilityChecks, 32);
  assert.equal(result.claimAttempts, 32);
  assert.equal(result.claimed, 0);
  assert.equal(ledger.calls.claim.length, 32);
  assert.equal(ledger.items.at(-1).itemId, ready.itemId);
  assert.equal(ledger.items.at(-1).status, "queued");
});

test("later work is claimed on the next cycle after fenced claim safety cap", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });

  const first = await loop.runCycle({ workLimit: 1 });
  const second = await loop.runCycle({ workLimit: 1 });

  assert.equal(first.claimAttempts, 32);
  assert.equal(first.claimed, 0);
  assert.equal(second.claimAttempts, 1);
  assert.equal(second.claimed, 1);
  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), [
    ...fenced.map(({ itemId }) => itemId),
    ready.itemId,
  ]);
  assert.equal(ledger.items.at(-1).status, "dispatch_pending");
});

test("fenced deferrals never bypass a newly arrived urgent owner request", async () => {
  const time = controlledClock();
  const fenced = Array.from({ length: 32 }, (_, index) => workItem(index + 1));
  const ready = workItem(33);
  const ledger = new FakeLedger({ source: [...fenced, ready], time });
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    if (fenced.some(({ itemId }) => itemId === input.itemId)) {
      ledger.calls.claim.push(clone(input));
      throw Object.assign(new Error("PR source authority is fenced"), {
        code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      });
    }
    return claim(input);
  };
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker() }),
    time,
  });
  await loop.runCycle({ workLimit: 1 });

  const urgent = workItem(34);
  urgent.event.eventType = "pull_request.owner_requested";
  urgent.event.source = {
    provider: "local-owner",
    scopeId: `owner-request:${urgent.itemId}`,
  };
  urgent.event.payload.priority = "urgent";
  ledger.items.push(urgent);
  const second = await loop.runCycle({ workLimit: 1 });

  assert.equal(second.claimed, 1);
  assert.equal(ledger.calls.claim.at(-1).itemId, urgent.itemId);
  assert.equal(
    ledger.items.find(({ itemId }) => itemId === ready.itemId).status,
    "queued",
  );
});

test("a lost claim acknowledgement is recovered before one decision is staged", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claimFailure = "after_write";
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker(),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimAttempts, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.staged, 1);
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.outbox.length, 1);
});

test("configuration-first claim rejection stops the cycle with its gate error", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claim = async (input) => {
    ledger.calls.claim.push(clone(input));
    throw Object.assign(new Error("configuration changed"), {
      code: "RUNTIME_RESTART_REQUIRED",
    });
  };
  let decisionCalls = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async () => {
        decisionCalls += 1;
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  await assert.rejects(
    loop.runCycle(),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("an admitted lost claim ACK reconciles after cutover without reaching the brain", async () => {
  const time = controlledClock();
  const gate = readyActionAdmissionGate();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  ledger.claimFailure = "after_write";
  const claim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    const admitted = await gate.run(() => ({ operation: claim(input) }));
    try {
      return await admitted.operation;
    } catch (error) {
      await activateNextConfiguration(gate);
      throw error;
    }
  };
  let reconciliationReads = 0;
  ledger.readItemForReconciliation = async ({ itemId }) => {
    reconciliationReads += 1;
    return clone(
      ledger.items.find((candidate) => candidate.itemId === itemId) ?? null,
    );
  };
  let providerCalls = 0;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: (input) => gate.run(() => {
        providerCalls += 1;
        return completeDecision(input.item.itemId);
      }),
    }),
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle();

  assert.equal(result.claimed, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
  assert.equal(reconciliationReads, 1);
  assert.equal(providerCalls, 0);
  assert.equal(ledger.calls.intake.length, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("one failed target resolution is cached for the whole cycle", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(1), workItem(2)],
    time,
  });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": { roleId: "wrong-role" },
  });
  const loop = createLoop({ ledger, directory, time });

  const result = await loop.runCycle({ workLimit: 2 });

  assert.equal(directory.calls.length, 1);
  assert.deepEqual(
    result.outcomes.map(({ status }) => status),
    ["resolution_failed", "resolution_failed"],
  );
  assert.equal(ledger.calls.claim.length, 0);
});

test("unchanged work backs off after role resolution fails and retries when due", async () => {
  const time = controlledClock();
  const source = workItem(1);
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory();
  directory.failure = Object.assign(new Error("role state read timed out"), { code: "ROLE_RESOLUTION_TIMEOUT" });
  const loop = createLoop({ ledger, directory, time });

  const first = await loop.runCycle({ roleId: "pr-reviewer" });
  assert.equal(first.outcomes[0].status, "resolution_failed");
  const second = await loop.runCycle({ roleId: "pr-reviewer" });
  assert.deepEqual(second.outcomes[0], {
    itemId: source.itemId,
    status: "resolution_deferred",
    code: "ROLE_RESOLUTION_TIMEOUT",
  });
  assert.equal(directory.calls.length, 1);
  assert.equal(ledger.calls.claim.length, 0);

  time.advance(1_000);
  directory.failure = null;
  directory.entries.set("pr-reviewer", worker());
  const retried = await loop.runCycle({ roleId: "pr-reviewer" });
  assert.equal(directory.calls.length, 2);
  assert.equal(retried.claimed, 1, JSON.stringify(retried.outcomes));
  assert.equal(retried.staged, 1, JSON.stringify(retried.outcomes));
});

test("changed work bypasses a pending role resolution backoff", async () => {
  const time = controlledClock();
  const source = workItem(1);
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory();
  directory.failure = Object.assign(new Error("role state read timed out"), { code: "ROLE_RESOLUTION_TIMEOUT" });
  const loop = createLoop({ ledger, directory, time });

  await loop.runCycle({ roleId: "pr-reviewer" });
  ledger.items[0].revision += 1;
  ledger.items[0].inputDigest = "changed-input";
  directory.failure = null;
  directory.entries.set("pr-reviewer", worker());
  const retried = await loop.runCycle({ roleId: "pr-reviewer" });

  assert.equal(directory.calls.length, 2);
  assert.equal(retried.claimed, 1, JSON.stringify(retried.outcomes));
  assert.equal(retried.staged, 1, JSON.stringify(retried.outcomes));
});

test("a bounded decision timeout schedules a safe retry before the lease expires", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(1)], time });
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async ({ signal }) => new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    leaseDurationMs: 1_000,
    resolveTimeoutMs: 20,
    decideTimeoutMs: 10,
  });

  const result = await loop.runCycle();

  assert.equal(result.retried, 1);
  assert.equal(ledger.calls.scheduleRetry[0].reason, "decision_failed");
  assert.equal(
    ledger.calls.scheduleRetry[0].actorId,
    "employee-pr-reviewer",
  );
  assert.equal(ledger.items[0].status, "retry_wait");
});

test("shutdown abort reaches an active role decision and stages no later intent", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(70)], time });
  const started = deferred();
  let providerSignal = null;
  const directory = new FakeRoleDirectory({
    "pr-reviewer": worker({
      decide: async ({ signal }) => {
        providerSignal = signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
    }),
  });
  const loop = createLoop({ ledger, directory, time });
  const controller = new AbortController();
  const running = loop.runCycle({
    trigger: "scheduled",
    signal: controller.signal,
  });
  await Promise.race([
    started.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("role provider did not start")),
      100,
    )),
  ]);
  const reason = Object.assign(new Error("shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.equal(providerSignal instanceof AbortSignal, true);
  assert.equal(providerSignal.aborted, true);
  assert.strictEqual(providerSignal.reason, reason);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
});

test("host PR fact preparation failures retry without spending a model decision", async () => {
  const time = controlledClock();
  const sourceItem = workItem(468, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [sourceItem], time });
  let assemblies = 0, decisions = 0;
  const loop = createLoop({ ledger, time, maxAttempts: 1,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async () => {
      decisions++; return completeDecision();
    } }) }),
    roleContextAssembler: { async assemble({ item, roleId }) {
      if (++assemblies === 1) throw new RoleContextAssemblerError(
        "ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "temporary PR fact failure", 503);
      return contextPacket(item, roleId);
    } },
    orchestratorService: { async execute() {} },
  });
  const first = await loop.runCycle({ roleId: "developer" });
  assert.equal(first.retried, 1);
  assert.equal(decisions, 0);
  assert.equal(ledger.items[0].attempt, 0);
  assert.equal(ledger.calls.scheduleRetry.at(-1).consumeAttempt, false);
  assert.equal(ledger.calls.scheduleRetry.at(-1).reason, "system_maintenance_auto_retry");
  time.advance(60_000);
  assert.equal((await loop.runCycle({ roleId: "developer" })).staged, 1);
  assert.equal(decisions, 1);
  assert.equal(ledger.items[0].attempt, 1);
});

test("a fenced session parks only its task and leaves healthy work a decision slot across restart", async () => {
  for (const roleId of ["developer", "orchestrator"]) {
    const time = controlledClock();
    const sources = [workItem(490, { type: "role", id: roleId }), workItem(491, { type: "role", id: roleId })];
    const ledger = new FakeLedger({ source: sources, time });
    const decisions = [];
    const options = { ledger, time, directory: new FakeRoleDirectory({ [roleId]: worker({ roleId,
      async decide({ item }) {
        decisions.push(item.itemId);
        if (item.itemId === sources[0].itemId) throw structuredBrainFailure("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
        return roleId === "orchestrator" ? orchestrationDecision(item) : completeDecision();
      },
    }) }), roleContextAssembler: { async assemble({ item, roleId }) { return contextPacket(item, roleId); } },
    orchestratorService: { async execute() { return { applied: true }; } } };
    const first = await createLoop(options).runCycle({ roleId, workLimit: 1 });
    assert.equal(first.outcomes[0].status, "maintenance_required");
    assert.deepEqual(decisions, sources.map(item => item.itemId));
    assert.equal(ledger.items[0].status, "dispatch_pending");
    assert.equal(ledger.calls.scheduleRetry.length, 0);
    assert.equal(ledger.outbox[0].intent.type, "ask_user");
    assert.equal(ledger.outbox[0].intent.choices[0].id, "configured-retry");
    assert.match(ledger.outbox[0].intent.question, /会话历史.*不要删除/);
    assert.equal(JSON.stringify(ledger.outbox[0]).includes("sk-owner-secret"), false);
    time.advance(3_600_000);
    await createLoop(options).runCycle({ roleId });
    assert.equal(decisions.filter(id => id === sources[0].itemId).length, 1);
  }
});

test("transient infrastructure backoff survives loop recreation without spending decision attempts", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(492)], time });
  ledger.listTimeline = async () => ({ items: [...ledger.calls.scheduleRetry].reverse().map(call => ({
    type: "retry_scheduled", details: { ...call.details, reason: call.reason },
  })) });
  const options = { ledger, time, retryMaxMs: 240_000,
    directory: new FakeRoleDirectory({ "pr-reviewer": worker({ async decide() {
      throw structuredBrainFailure("STRUCTURED_PROVIDER_MODEL_CAPACITY");
    } }) }),
  };
  for (const expectedDelay of [60_000, 120_000, 240_000, 240_000]) {
    const before = Date.parse(time.clock());
    assert.equal((await createLoop(options).runCycle()).retried, 1);
    assert.equal(Date.parse(ledger.items[0].availableAt) - before, expectedDelay);
    assert.equal(ledger.items[0].attempt, 0);
    time.advance(expectedDelay);
  }
});

test("host fact preparation failure leaves the next healthy specialist a work slot", async () => {
  const time = controlledClock();
  const sources = [workItem(468, { type: "role", id: "developer" }), workItem(469, { type: "role", id: "developer" })];
  const ledger = new FakeLedger({ source: sources, time });
  const decisions = [];
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async ({ item }) => {
      decisions.push(item.itemId); return completeDecision();
    } }) }),
    roleContextAssembler: { async assemble({ item, roleId }) {
      if (item.itemId === sources[0].itemId) throw new RoleContextAssemblerError("ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "facts are unavailable", 503);
      return contextPacket(item, roleId);
    } }, orchestratorService: { async execute() {} },
  });
  const result = await loop.runCycle({ roleId: "developer", workLimit: 1 });
  assert.equal(result.retried, 1);
  assert.equal(result.staged, 1);
  assert.equal(result.workAttempts, 1);
  assert.deepEqual(decisions, [sources[1].itemId]);
  assert.equal(ledger.items[0].attempt, 0);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.calls.claim.length, 2);
});

test("context-only retries retain a bounded scan while later healthy work remains reachable", async () => {
  const time = controlledClock();
  const sources = Array.from({ length: 8 }, (_, index) => workItem(480 + index, { type: "role", id: "developer" }));
  const ledger = new FakeLedger({ source: sources, time });
  const decisions = [];
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async ({ item }) => {
      decisions.push(item.itemId); return completeDecision();
    } }) }),
    roleContextAssembler: { async assemble({ item, roleId }) {
      if (item.itemId !== sources[7].itemId) throw new RoleContextAssemblerError("ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "facts are unavailable", 503);
      return contextPacket(item, roleId);
    } }, orchestratorService: { async execute() {} },
  });
  const first = await loop.runCycle({ roleId: "developer", workLimit: 1 });
  assert.equal(first.claimed, 4);
  assert.equal(first.retried, 4);
  assert.equal(first.workAttempts, 0);
  assert.deepEqual(decisions, []);
  const second = await loop.runCycle({ roleId: "developer", workLimit: 1 });
  assert.equal(second.claimed, 4);
  assert.equal(second.staged, 1);
  assert.equal(second.workAttempts, 1);
  assert.deepEqual(decisions, [sources[7].itemId]);
  assert.ok(ledger.items.slice(0, 7).every(item => item.status === "retry_wait" && item.attempt === 0));
});

test("model and untyped context errors retain the work slot even when another task is ready", async () => {
  for (const fromModel of [false, true]) {
    const time = controlledClock();
    const sources = [workItem(490, { type: "role", id: "developer" }), workItem(491, { type: "role", id: "developer" })];
    const ledger = new FakeLedger({ source: sources, time });
    let decisions = 0;
    const loop = createLoop({ ledger, time, maxAttempts: 1,
      directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async () => {
        decisions += 1;
        throw new RoleContextAssemblerError("ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "model error", 503);
      } }) }),
      roleContextAssembler: { async assemble({ item, roleId }) {
        if (!fromModel) throw Object.assign(new Error("untyped error"), { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE", statusCode: 503 });
        return contextPacket(item, roleId);
      } }, orchestratorService: { async execute() {} },
    });
    const result = await loop.runCycle({ roleId: "developer", workLimit: 1 });
    assert.equal(result.workAttempts, 1);
    assert.equal(result.claimed, 1);
    assert.equal(result.blocked, 1);
    assert.equal(decisions, fromModel ? 1 : 0);
    assert.equal(ledger.items[1].attempt, 0);
  }
});

test("PR fact error codes cannot refund a failed model decision or an untyped preparation failure", async (t) => {
  for (const fromModel of [false, true]) await t.test(`from model: ${fromModel}`, async () => {
    const time = controlledClock(), ledger = new FakeLedger({ source: [workItem(469, { type: "role", id: "developer" })], time });
    const failure = fromModel ? new RoleContextAssemblerError("ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "model failed", 503) :
      Object.assign(new Error("untyped failure"), { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE", statusCode: 503 });
    const loop = createLoop({ ledger, time, maxAttempts: 1,
      directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", decide: async () => { throw failure; } }) }),
      roleContextAssembler: { async assemble({ item, roleId }) {
        if (!fromModel) throw failure;
        return contextPacket(item, roleId);
      } },
      orchestratorService: { async execute() {} },
    });
    assert.equal((await loop.runCycle({ roleId: "developer" })).blocked, 1);
    assert.equal(ledger.items[0].attempt, 1);
    assert.equal(ledger.calls.scheduleRetry.length, 0);
  });
});

test("a bounded context timeout aborts a hanging graph read before retrying", async () => {
  const time = controlledClock();
  const sourceItem = workItem(69, { type: "role", id: "developer" });
  sourceItem.inputDigest = "a".repeat(64);
  const ledger = new FakeLedger({
    source: [sourceItem],
    time,
  });
  let graphSignal;
  const directory = new FakeRoleDirectory({
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    leaseDurationMs: 13_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    maxAttempts: 1,
    roleContextAssembler: new RoleContextAssembler({
      graphReader: {
        async getSnapshot({ signal } = {}) {
          graphSignal = signal;
          return new Promise((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      },
    }),
    orchestratorService: { async execute() {} },
  });

  const result = await loop.runCycle({ roleId: "developer" });

  assert.equal(result.retried, 1);
  assert.equal(graphSignal instanceof AbortSignal, true);
  assert.equal(graphSignal.aborted, true);
  assert.equal(graphSignal.reason.code, "ROLE_CONTEXT_TIMEOUT");
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.calls.scheduleRetry.at(-1).consumeAttempt, false);
  assert.equal(ledger.items[0].attempt, 0, "context preparation did not make a model decision");
  assert.equal(ledger.items[0].availableAt, "2026-08-02T08:01:00.000Z");
});

test("a context-like error after a model decision still consumes the decision budget", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(69, { type: "role", id: "developer" })], time });
  let decisions = 0;
  const loop = createLoop({ ledger, time, maxAttempts: 1,
    directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", async decide() {
      decisions += 1; throw Object.assign(new Error('failure after model started'), { code: 'ROLE_CONTEXT_TIMEOUT' });
    } }) }),
    roleContextAssembler: { async assemble({ item, roleId }) { return contextPacket(item, roleId); } },
    orchestratorService: { async execute() {} },
  });
  const result = await loop.runCycle({ roleId: 'developer' });
  assert.equal(decisions, 1); assert.equal(result.blocked, 1);
  assert.equal(ledger.items[0].attempt, 1); assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test("role timeouts must be strictly shorter than the work lease", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      leaseDurationMs: 1_000,
      resolveTimeoutMs: 1_000,
      decideTimeoutMs: 10,
    }),
    /shorter than leaseDurationMs/,
  );
});

function contextPacket(item, roleId) {
  return {
    schemaVersion: 1,
    binding: { taskId: item.itemId, roleId },
    context: { requirements: { taskId: item.itemId } },
    acceptedInputs: [],
    contextDigest: "a".repeat(64),
  };
}

test("historical Review settlement fences direct decisions and rechecks proof before normal completion", async t => {
  for (const scenario of ["complete", "ask-user", "pause", "complete-early", "proof-withdrawn", "owner-paused"]) await t.test(scenario, async () => {
    const time = controlledClock();
    const source = workItem(81, { type: "role", id: "orchestrator" });
    const ledger = new FakeLedger({ source: [source], time });
    let reads = 0;
    const assembler = { async assemble({ item, roleId }) {
      reads++;
      const packet = contextPacket(item, roleId);
      packet.context.requirements.currentTask = { taskId: item.itemId };
      packet.context.requirements.trigger = "scheduled";
      if (scenario !== "proof-withdrawn" || reads === 1) packet.context.code = { reviewPublicationSettlement: {
        schemaVersion: 1, scope: "historical_publication_only", inputBinding: { rootItemId: item.itemId },
        allAccepted: scenario !== "complete-early", entries: [{ taskId: "review-child", taskRevision: 7,
          submittedDeliveryRevision: 1, state: scenario === "complete-early" ? "submitted" : "accepted", completed: scenario !== "complete-early" }],
      } };
      return packet;
    } };
    const directory = new FakeRoleDirectory({ orchestrator: worker({ roleId: "orchestrator", paused: scenario === "owner-paused",
      decide: async ({ item }) => {
        if (scenario === "pause") return orchestrationDecision(item, "pause");
        if (scenario === "ask-user") return { schemaVersion: 1, confidence: 90, summary: "Ask again", intent: {
          schemaVersion: 1, type: "ask_user", summary: "Ask again", reason: "Renew authority", question: "Continue?",
          choices: [{ id: "continue", label: "Continue", description: "Confirm again" }],
        } };
        return completeDecision();
      } }) });
    const loop = createLoop({ ledger, directory, time, roleContextAssembler: assembler,
      orchestratorService: { async execute() { assert.fail("Historical closeout cannot run this graph action"); } } });
    const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    if (scenario === "complete") {
      assert.equal(reads, 2, "completion verifies publication authority again after the model");
      assert.equal(result.staged, 1);
      assert.equal(ledger.calls.stageIntent[0].intent.type, "complete");
    } else {
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(ledger.items[0].status, "queued");
      assert.ok(result.outcomes.some(entry => entry.status === (scenario === "owner-paused" ? "paused" : "decision_deferred")));
    }
  });
});

function deliveryDecision(item) {
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "交付当前岗位成果",
    intent: {
      schemaVersion: 1,
      type: "submit_delivery",
      taskId: item.itemId,
      expectedTaskRevision: item.revision,
      expectedGraphRevision: 7,
      contractRevision: 1,
      deliverableId: "implementation",
      summary: "实现和验证均已完成",
      reason: "满足当前交付契约",
      evidence: [],
      artifact: null,
    },
  };
}

function orchestrationDecision(item, actionType = "pause") {
  const reason = "根据共享任务图推进";
  return {
    schemaVersion: 1,
    confidence: 92,
    summary: "协调直属任务",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "协调直属任务",
      reason,
      action: {
        schemaVersion: 1,
        type: actionType,
        sourceTaskId: item.itemId,
        sourceTaskRevision: item.revision,
        expectedGraphRevision: 7,
        reason,
      },
    },
  };
}

function memoryQueryDecision() {
  return {
    schemaVersion: 1,
    confidence: 88,
    summary: "需要查询可引用的历史证据",
    intent: {
      schemaVersion: 1,
      type: "query_memory",
      summary: "查询旧回归证据",
      reason: "当前判断缺少可复现的历史记录",
      question: "上次同类回归是如何修复的？",
      searchQuery: "同类 回归 修复",
      mode: "local",
    },
  };
}

test("trusted specialist claims, assembles, decides, and submits without staging", async () => {
  const time = controlledClock();
  const source = workItem(31, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const order = [];
  const originalClaim = ledger.claim.bind(ledger);
  ledger.claim = async (input) => {
    order.push("claim");
    return originalClaim(input);
  };
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item, context }) => {
        order.push("decide");
        assert.deepEqual(context, { requirements: { taskId: item.itemId } });
        return deliveryDecision(item);
      },
    }),
  });
  const assembler = {
    async assemble({ roleId, item }) {
      order.push("assemble");
      return contextPacket(item, roleId);
    },
  };
  const executions = [];
  const service = {
    async execute(input) {
      order.push("execute");
      executions.push(clone(input));
      return { applied: true, deliveryRevision: 1 };
    },
  };
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: assembler,
    orchestratorService: service,
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.deepEqual(order, ["claim", "assemble", "decide", "execute"]);
  assert.equal(cycle.submittedDeliveries, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(executions[0].item.ownerId, "employee-developer");
  assert.equal(executions[0].contextPacket.binding.roleId, "developer");
  assert.equal(executions[0].intent.type, "submit_delivery");
});

test("a specialist can query cited memory once and re-enter the same work decision", async () => {
  const time = controlledClock();
  const source = workItem(32, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  const contexts = [];
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ context }) => {
        contexts.push(clone(context));
        return context.memory ? completeDecision("已结合引用继续判断") : memoryQueryDecision();
      },
    }),
  });
  let assembleCalls = 0;
  const assembler = {
    async assemble({ roleId, item }) {
      assembleCalls += 1;
      const packet = contextPacket(item, roleId);
      if (memoryReady) {
        packet.context.memory = {
          agentQuery: {
            queryId: `agent-memory-query-${"a".repeat(64)}`,
            claims: [{
              statement: "旧回归通过恢复空值分支保护修复。",
              citationIds: [`memory-${"b".repeat(64)}`],
            }],
          },
        };
      }
      return packet;
    },
  };
  const queryCalls = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: assembler,
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute(input) {
        queryCalls.push(clone({ ...input, signal: undefined }));
        assert.equal(input.signal instanceof AbortSignal, true);
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context, signal }) {
        assert.equal(signal instanceof AbortSignal, true);
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.staged, 1);
  assert.equal(assembleCalls, 2);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].memory, undefined);
  assert.match(contexts[1].memory.agentQuery.claims[0].statement, /空值分支/);
  assert.equal(queryCalls.length, 1);
  assert.equal(queryCalls[0].roleId, "developer");
  assert.equal(queryCalls[0].workerId, "employee-developer");
  assert.equal(queryCalls[0].intent.type, "query_memory");
  assert.equal(ledger.outbox[0].intent.type, "complete");
});

test("a second memory query in one work iteration is rejected without another primitive call", async () => {
  const time = controlledClock();
  const source = workItem(33, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let queryCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => memoryQueryDecision(),
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute() {
        queryCalls += 1;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context }) {
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(queryCalls, 1);
  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED");
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("the complete memory-assisted decision phase shares one lease-safe deadline", async () => {
  const time = controlledClock();
  const source = workItem(34, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let decisions = 0;
  let queryAborted = false;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          decisions += 1;
          return memoryQueryDecision();
        },
      }),
    }),
    time,
    leaseDurationMs: 13_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute({ signal }) {
        await new Promise((_resolve, reject) => {
          const onAbort = () => {
            queryAborted = true;
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      async verifyContext({ context }) {
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(queryAborted, true);
  assert.equal(decisions, 1);
  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "ROLE_DECISION_TIMEOUT");
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("healthy memory decision stages use separate deadlines inside one hard total budget", async () => {
  const time = controlledClock();
  const source = workItem(35, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  let decisions = 0;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 600));
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async ({ context, signal }) => {
          assert.equal(signal instanceof AbortSignal, true);
          await delay();
          signal.throwIfAborted();
          decisions += 1;
          return context.memory
            ? completeDecision("记忆阶段完成后继续")
            : memoryQueryDecision();
        },
      }),
    }),
    time,
    leaseDurationMs: 15_000,
    resolveTimeoutMs: 1_000,
    decideTimeoutMs: 1_000,
    roleContextAssembler: {
      async assemble({ roleId, item, signal }) {
        signal?.throwIfAborted();
        const packet = contextPacket(item, roleId);
        if (memoryReady) {
          packet.context.memory = {
            agentQuery: {
              queryId: `agent-memory-query-${"a".repeat(64)}`,
              claims: [{
                statement: "引用仍然有效。",
                citationIds: [`memory-${"b".repeat(64)}`],
              }],
            },
          };
        }
        return packet;
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute({ signal }) {
        await delay();
        signal.throwIfAborted();
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context, signal }) {
        signal.throwIfAborted();
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.staged, 1);
  assert.equal(decisions, 2);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.outbox[0].intent.type, "complete");
});

test("citation invalidation after the provider returns stages no decision", async () => {
  const time = controlledClock();
  const source = workItem(36, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  let memoryReady = false;
  let citationCurrent = true;
  let verificationCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async ({ context }) => {
          if (!context.memory) return memoryQueryDecision();
          citationCurrent = false;
          return completeDecision("不得采用已过期引用");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        const packet = contextPacket(item, roleId);
        if (memoryReady) {
          packet.context.memory = {
            agentQuery: {
              queryId: `agent-memory-query-${"a".repeat(64)}`,
              claims: [{
                statement: "即将失效的结论。",
                citationIds: [`memory-${"b".repeat(64)}`],
              }],
            },
          };
        }
        return packet;
      },
    },
    orchestratorService: { async execute() {} },
    memoryQueryService: {
      async execute() {
        memoryReady = true;
        return { recovered: false, context: { queryId: "persisted" } };
      },
      async verifyContext({ context }) {
        verificationCalls += 1;
        if (!citationCurrent) {
          throw Object.assign(new Error("citation is obsolete"), {
            code: "AGENT_MEMORY_QUERY_CITATION_STALE",
          });
        }
        return clone(context);
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.retried, 1);
  assert.equal(cycle.outcomes[0].code, "AGENT_MEMORY_QUERY_CITATION_STALE");
  assert.equal(verificationCalls, 1);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
});

test("authoritative task changes after the provider returns stage no decision", async () => {
  const time = controlledClock();
  const source = workItem(37, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          const authoritative = ledger.items[0];
          authoritative.revision += 1;
          authoritative.inputDigest = "superseding-input-digest";
          return completeDecision("不得采用旧任务输入的判断");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.outcomes[0].status, "failure_state_unchanged");
  assert.equal(cycle.outcomes[0].code, "ROLE_DECISION_INPUT_STALE");
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.outbox.length, 0);
});

test("runtime cutover is never recorded as a specialist failure", async (t) => {
  for (const failurePoint of ["brain", "final-mutation"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const source = workItem(
        failurePoint === "brain" ? 61 : 62,
        { type: "role", id: "developer" },
      );
      const ledger = new FakeLedger({ source: [source], time });
      const admissionError = Object.assign(new Error("configuration changed"), {
        code: "RUNTIME_RESTART_REQUIRED",
      });
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async ({ item }) => {
            if (failurePoint === "brain") throw admissionError;
            return deliveryDecision(item);
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            throw admissionError;
          },
        },
      });

      await assert.rejects(
        loop.runCycle({ roleId: "developer" }),
        (error) => error === admissionError,
      );

      assert.equal(ledger.items[0].status, "working");
      assert.equal(ledger.items[0].ownerId, "employee-developer");
      assert.equal(ledger.items[0].leaseId, "lease-1");
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(serviceCalls, failurePoint === "brain" ? 0 : 1);
    });
  }
});

test("trusted specialist retries assembler and delivery-service failures", async (t) => {
  for (const failurePoint of ["assembler", "service"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const source = workItem(
        failurePoint === "assembler" ? 70 : 71,
        { type: "role", id: "developer" },
      );
      const ledger = new FakeLedger({ source: [source], time });
      let assembleCalls = 0;
      let decisionCalls = 0;
      let serviceCalls = 0;
      let successfulSubmissions = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async ({ item }) => {
            decisionCalls += 1;
            return deliveryDecision(item);
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assembleCalls += 1;
            if (failurePoint === "assembler" && assembleCalls === 1) {
              throw new Error("context temporarily unavailable");
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            if (failurePoint === "service" && serviceCalls === 1) {
              throw new Error("delivery service temporarily unavailable");
            }
            successfulSubmissions += 1;
            return { applied: true, deliveryRevision: 1 };
          },
        },
      });

      const first = await loop.runCycle({ roleId: "developer" });

      assert.equal(first.retried, 1);
      assert.equal(first.submittedDeliveries, 0);
      assert.equal(ledger.items[0].status, "retry_wait");
      assert.equal(ledger.calls.scheduleRetry.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 0);

      time.advance(1_000);
      const second = await loop.runCycle({ roleId: "developer" });

      assert.equal(second.submittedDeliveries, 1);
      assert.equal(successfulSubmissions, 1);
      assert.equal(ledger.calls.claim.length, 2);
      assert.equal(ledger.calls.scheduleRetry.length, 1);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(assembleCalls, 2);
      assert.equal(
        decisionCalls,
        failurePoint === "assembler" ? 1 : 2,
      );
      assert.equal(serviceCalls, failurePoint === "assembler" ? 1 : 2);
    });
  }
});

test("specialist delivery exhaustion remains distinct from decision exhaustion", async () => {
  const time = controlledClock();
  const source = workItem(72, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item }) => deliveryDecision(item),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw new Error("delivery outcome remains unproven");
      },
    },
  });

  const first = await loop.runCycle({ roleId: "developer" });
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_failed");
  time.advance(1_000);

  const second = await loop.runCycle({ roleId: "developer" });
  assert.equal(second.blocked, 1);
  assert.equal(ledger.items[0].statusReason, "delivery_attempts_exhausted");
  assert.equal(ledger.calls.scheduleRetry[0].reason, "delivery_failed");
  assert.equal(
    ledger.calls.transition[0].reason,
    "delivery_attempts_exhausted",
  );
});

test("delivery capacity failures wait automatically without exhausting delivery attempts", async () => {
  const time = controlledClock();
  const source = workItem(73, { type: "role", id: "developer" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    developer: worker({
      roleId: "developer",
      decide: async ({ item }) => deliveryDecision(item),
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    maxAttempts: 2,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw Object.assign(new Error("delivery cleanup state is unknown"), {
          code: "STRUCTURED_PROVIDER_MODEL_CAPACITY",
        });
      },
    },
  });

  ledger.stageFailure = "before_write";
  const first = await loop.runCycle({ roleId: "developer" });
  assert.equal(first.retried, 1);
  assert.equal(ledger.items[0].statusReason, "system_maintenance_auto_retry");
  time.advance(60_000);

  ledger.stageFailure = "before_write";
  const second = await loop.runCycle({ roleId: "developer" });
  assert.equal(second.retried, 1);
  assert.equal(ledger.items[0].statusReason, "system_maintenance_auto_retry");
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry[0].consumeAttempt, false);
  assert.equal(ledger.calls.transition.length, 0);
});

test("trusted specialist generic decisions retain the durable stage path", async () => {
  const time = controlledClock();
  const source = workItem(32, { type: "role", id: "tester" });
  const ledger = new FakeLedger({ source: [source], time });
  const directory = new FakeRoleDirectory({
    tester: worker({ roleId: "tester", decide: async () => completeDecision() }),
  });
  let serviceCalls = 0;
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        serviceCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "tester" });

  assert.equal(cycle.staged, 1);
  assert.equal(serviceCalls, 0);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("task-brain configuration failures retry automatically without fallback or owner questions", async (t) => {
  for (const code of [
    "ROLE_TASK_BRAIN_NOT_CONFIGURED",
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    "REMOTE_DATA_NOT_AUTHORIZED",
  ]) {
    await t.test(code, async () => {
      const time = controlledClock();
      const source = workItem(80, { type: "role", id: "developer" });
      const ledger = new FakeLedger({ source: [source], time });
      let decisions = 0;
      const directory = new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async () => {
            decisions += 1;
            throw Object.assign(new Error(code), { code });
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: { async execute() {} },
      });

      const cycle = await loop.runCycle({ roleId: "developer" });

      assert.equal(cycle.retried, 1);
      assert.equal(decisions, 1);
      assert.equal(ledger.calls.scheduleRetry.length, 1);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.outbox.length, 0);
      assert.equal(ledger.calls.scheduleRetry[0].consumeAttempt, false);
      assert.equal(ledger.calls.scheduleRetry[0].details.code, code);
    });
  }
});

const STRUCTURED_BRAIN_ATTENTION_CASES = Object.freeze([
  Object.freeze({
    code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    failurePoint: "brain",
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
    failurePoint: "context",
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    failurePoint: "brain",
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    failurePoint: "context",
  }),
  Object.freeze({
    code: "STRUCTURED_PROVIDER_REAP_FAILED",
    failurePoint: "brain",
  }),
]);

function structuredBrainFailure(code) {
  return Object.assign(
    new Error(`raw stderr sk-owner-secret from C:\\private\\codex.exe (${code})`),
    {
      code,
      stderr: "provider stderr sk-owner-secret",
      executablePath: "C:\\private\\codex.exe",
      credential: "sk-owner-secret",
    },
  );
}

test("own PR repair decisions receive complete feedback before choosing an action", async () => {
  for (const changedDuringDecision of [false, true]) {
    const time = controlledClock();
    const source = workItem(42, { type: "role", id: "developer" });
    const event = {
      schemaVersion: 1, eventId: "review-event-42", contentDigest: "3".repeat(64),
      eventType: "pull_request.updated", occurredAt: time.clock(),
      source: { provider: "github", scopeId: "github-dashboard" },
      subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
      payload: { relation: "authored", nextAction: "address_review", headRefOid: "2".repeat(40) },
    };
    source.event = event;
    source.source = { kind: "pull_request", workKey: "pr:acme/repo#42", activeRevision: 1,
      revisions: [{ headRevision: 1 }],
      current: { event, eventId: event.eventId, eventDigest: event.contentDigest,
        headRefOid: event.payload.headRefOid, inputDigest: "4".repeat(64) } };
    const feedback = { schemaVersion: 1, headRefOid: event.payload.headRefOid,
      reviewFeedbackDigest: "5".repeat(64), feedback: { changeRequests: [],
        threads: Array.from({ length: 12 }, (_, id) => ({ id: `thread-${id}`, comments: [{ body: "review detail ".repeat(500) }] })) } };
    let reads = 0;
    let received;
    const ledger = new FakeLedger({ source: [source], time });
    const directory = new FakeRoleDirectory({ developer: worker({ roleId: "developer",
      async decide(input) { received = input; return completeDecision(); } }) });
    const loop = createLoop({ ledger, directory, time,
      reviewRepairContextReader: { async readBinding({ inputBinding }) {
        assert.equal(inputBinding.headRefOid, event.payload.headRefOid);
        reads += 1;
        return { ...clone(feedback), reviewFeedbackDigest: changedDuringDecision && reads > 1 ? "6".repeat(64) : feedback.reviewFeedbackDigest };
      } },
    });
    await loop.runCycle({ trigger: "manual" });
    assert.deepEqual(received.reviewRepairFeedback, feedback);
    assert.equal(reads, 2);
    assert.equal(ledger.outbox.length, changedDuringDecision ? 0 : 1);
  }
});

test("automatic Review admits failed checks but skips old incoming work and a disabled switch", async () => {
  for (const enabled of [true, false]) {
    const time = controlledClock();
    const source = [1, 2].map((number) => {
      const item = workItem(number, { type: "role", id: "pr-engineer" });
      item.event.source = { provider: "github", scopeId: "github-dashboard" };
      item.event.payload = { relation: "review_requested", state: "open", isDraft: false, author: "dev", headRefOid: "a".repeat(40), ciStatus: "FAILURE",
        incomingReviewFactsAvailable: true, reviewRecipient: "me", reviewReceivedFrom: "dev", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_1",
        reviewReceivedAt: number === 1 ? "2026-07-01T00:00:00Z" : "2026-08-02T07:00:00Z" };
      return item;
    });
    const ledger = new FakeLedger({ source, time });
    const directory = new FakeRoleDirectory({ "pr-engineer": worker({ roleId: "pr-engineer" }) });
    const loop = createLoop({ ledger, directory, time, automaticReviewPolicy: { enabled, account: "me" } });
    const result = await loop.runCycle();
    assert.equal(result.claimed, enabled ? 1 : 0);
    assert.deepEqual(ledger.calls.claim.map((call) => call.itemId), enabled ? ["work-item-2"] : []);
  }
});

test("an already admitted automatic failed-CI Review is still claimed after its Assign window expires", async () => {
  const time = controlledClock();
  const item = workItem(1, { type: "role", id: "pr-engineer" });
  item.createdAt = "2026-07-31T07:05:00Z";
  item.event.source = { provider: "github", scopeId: "github-dashboard" };
  item.event.payload = { kind: "pull_request", relation: "review_requested", state: "open", isDraft: false, author: "dev",
    headRefOid: "a".repeat(40), ciStatus: "FAILURE", incomingReviewFactsAvailable: true, reviewRecipient: "me",
    reviewReceivedFrom: "dev", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_1", reviewReceivedAt: "2026-07-31T07:00:00Z" };
  item.sourceQuarantine = null;
  item.source = { kind: "pull_request", identity: item.event.source, scope: { active: true, kind: "automatic" },
    current: { event: clone(item.event) }, revisions: [], activeRevision: 1 };
  const ledger = new FakeLedger({ source: [item], time });
  const loop = createLoop({ ledger, time, directory: new FakeRoleDirectory({ "pr-engineer": worker({ roleId: "pr-engineer" }) }),
    automaticReviewPolicy: { enabled: true, account: "me" } });
  assert.equal((await loop.runCycle()).claimed, 1);
});

test('one orchestrator context deadline does not abort later work or consume its decision attempt', async () => {
  const time = controlledClock(), first = workItem(401, { type: 'role', id: 'orchestrator' }),
    second = workItem(402, { type: 'role', id: 'orchestrator' });
  const ledger = new FakeLedger({ source: [first, second], time });
  let firstSignal; const decisions = [], executions = [];
  const loop = createLoop({ ledger, time, resolveTimeoutMs: 1_000, decideTimeoutMs: 1_000, leaseDurationMs: 13_000,
    directory: new FakeRoleDirectory({ orchestrator: worker({ roleId: 'orchestrator',
      decide: async ({ item }) => { decisions.push(item.itemId); return orchestrationDecision(item); } }) }),
    roleContextAssembler: { async assemble({ item, roleId, signal }) {
      if (item.itemId === first.itemId) {
        firstSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return contextPacket(item, roleId);
    } },
    orchestratorService: { async execute({ item }) { executions.push(item.itemId); return { applied: true }; } },
  });
  const result = await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(result.outcomes.map(({ status }) => status), ['decision_deferred', 'orchestrated']);
  assert.equal(result.outcomes[0].code, 'ROLE_CONTEXT_TIMEOUT');
  assert.deepEqual(decisions, [second.itemId]);
  assert.deepEqual(executions, [second.itemId]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.items.find(item => item.itemId === first.itemId).attempt, first.attempt);
});

test("root context contention defers one item and continues the cycle", async (t) => {
  for (const failurePoint of ["assemble", "execute"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const ledger = new FakeLedger({
        source: [
          workItem(401, { type: "role", id: "orchestrator" }),
          workItem(402, { type: "role", id: "orchestrator" }),
        ],
        time,
      });
      let assemblies = 0;
      let executions = 0;
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async ({ item }) => orchestrationDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assemblies += 1;
            if (failurePoint === "assemble" && assemblies === 1) {
              throw Object.assign(new Error("context changed"), { code: "ROLE_CONTEXT_STALE" });
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            executions += 1;
            if (failurePoint === "execute" && executions === 1) {
              throw new OrchestratorServiceError("ORCHESTRATOR_CONTEXT_STALE", "changed", 409);
            }
            return { applied: true };
          },
        },
      });
      const cycle = await loop.runCycle({ roleId: "orchestrator" });
      assert.equal(executions, failurePoint === "execute" ? 2 : 1);
      assert.deepEqual(cycle.outcomes.map(({ status }) => status), ["decision_deferred", "orchestrated"]);
      assert.equal(ledger.calls.claim.length, 0);
    });
  }
});

test("specialist context contention never exhausts the business attempt budget", async (t) => {
  for (const priorFailures of [0, 2]) {
    await t.test(`prior failures: ${priorFailures}`, async () => {
      const time = controlledClock();
      const source = workItem(403, { type: "role", id: "developer" });
      source.attempt = priorFailures;
      const ledger = new FakeLedger({ source: [source], time });
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          developer: worker({
            roleId: "developer",
            decide: async ({ item }) => deliveryDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) { return contextPacket(item, roleId); },
        },
        orchestratorService: {
          async execute() {
            if (priorFailures === 2) assertExpectedWorkGraphRevision(1, { revision: 2 });
            throw new OrchestratorServiceError("ORCHESTRATOR_CONTEXT_STALE", "changed", 409);
          },
        },
      });
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const result = await loop.runCycle({ roleId: "developer" });
        assert.equal(result.retried, 1);
        assert.equal(ledger.items[0].attempt, priorFailures);
        assert.equal(ledger.items[0].status, "retry_wait");
        time.advance(1_000);
      }
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.scheduleRetry.every(({ consumeAttempt }) => consumeAttempt === false), true);
    });
  }
});

test("changed review materials retry as context contention without spending business attempts", async () => {
  const time = controlledClock();
  const source = workItem(403, { type: "role", id: "pr-engineer" });
  source.attempt = 2;
  const ledger = new FakeLedger({ source: [source], time });
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ "pr-engineer": worker({ roleId: "pr-engineer", decide: async () => {
      throw Object.assign(new Error("review materials changed"), { code: "PR_REVIEW_READ_MATERIAL_CHANGED" });
    } }) }),
  });
  const cycle = await loop.runCycle({ roleId: "pr-engineer" });
  assert.equal(cycle.retried, 1);
  assert.equal(ledger.items[0].attempt, 2);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.calls.scheduleRetry.at(-1).consumeAttempt, false);
  assert.equal(ledger.calls.scheduleRetry.at(-1).reason, "context_changed");
  assert.equal(ledger.calls.transition.length, 0);
});

test("only authentic pre-write graph conflicts defer root decisions", async (t) => {
  for (const authentic of [true, false]) {
    await t.test(`authentic: ${authentic}`, async () => {
      const time = controlledClock();
      const ledger = new FakeLedger({
        source: [workItem(404, { type: "role", id: "orchestrator" })],
        time,
      });
      let conflict = Object.assign(new Error("durable state fork or untrusted error"), {
        code: "WORK_LEDGER_STATE_REVISION_CONFLICT", contextContention: true,
      });
      if (authentic) {
        try {
          assertExpectedWorkGraphRevision(1, { revision: 2 });
        } catch (error) {
          conflict = error;
        }
      }
      const loop = createLoop({
        ledger,
        time,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator", workerId: "employee-orchestrator",
            decide: async ({ item }) => orchestrationDecision(item),
          }),
        }),
        roleContextAssembler: {
          async assemble({ roleId, item }) { return contextPacket(item, roleId); },
        },
        orchestratorService: { async execute() { throw conflict; } },
      });
      if (authentic) {
        assert.equal((await loop.runCycle({ roleId: "orchestrator" })).outcomes[0].status, "decision_deferred");
      } else {
        await assert.rejects(loop.runCycle({ roleId: "orchestrator" }), (error) => error === conflict);
      }
      assert.equal(ledger.calls.scheduleRetry.length, 0);
    });
  }
});

function terminalPullRequestFailure(state = "MERGED") {
  const terminal = Object.assign(new Error(`PR is ${state}`), {
    code: "PR_FACTS_TERMINAL",
    terminalState: state,
  });
  const refresh = Object.assign(
    new Error("Unable to refresh PR facts", { cause: terminal }),
    { code: "PR_FACT_REFRESH_FAILED" },
  );
  return Object.assign(
    new Error("Unable to assemble PR role context", { cause: refresh }),
    { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" },
  );
}

function stalePullRequestFactsFailure() {
  const stale = Object.assign(new Error("PR execution identity changed"), {
    name: "GitHubReadError", code: "PR_FACTS_STALE", statusCode: 409,
  });
  const refresh = new PrEngineerServiceError(
    "PR_FACT_REFRESH_FAILED", "Unable to refresh bounded PR facts", 503,
    { cause: stale },
  );
  return new RoleContextAssemblerError(
    "ROLE_CONTEXT_PR_FACT_UNAVAILABLE", "Unable to read bounded PR task facts", 503,
    { cause: refresh },
  );
}

function deferredContextRootLoop({ failures, time = controlledClock(), signal = null }) {
  const sources = Array.from({ length: failures.length + 1 }, (_, index) =>
    workItem(901 + index, { type: "role", id: "orchestrator" }));
  const cancelled = workItem(24723, { type: "role", id: "orchestrator" });
  Object.assign(cancelled, { status: "cancelled", revision: 11 });
  const ledger = new FakeLedger({ source: [...sources, cancelled], time });
  const assemblies = [];
  const executions = [];
  const loop = createLoop({
    ledger, time,
    directory: new FakeRoleDirectory({
      orchestrator: worker({ roleId: "orchestrator", workerId: "employee-orchestrator",
        decide: async ({ item }) => orchestrationDecision(item) }),
    }),
    roleContextAssembler: { async assemble({ roleId, item }) {
      assemblies.push(item.itemId);
      const failure = failures[item.event.payload.number - 901];
      if (failure) {
        if (signal) signal.abort(new Error("owner cancelled cycle"));
        throw failure;
      }
      return contextPacket(item, roleId);
    } },
    orchestratorService: { async execute({ item }) {
      executions.push(item.itemId);
      return { applied: true };
    } },
  });
  return { loop, ledger, sources, cancelled, assemblies, executions };
}

test("stale PR facts defer only their root before claim and preserve the healthy work budget", async () => {
  const { loop, ledger, sources, cancelled, executions } = deferredContextRootLoop({
    failures: [stalePullRequestFactsFailure(), stalePullRequestFactsFailure()],
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    assert.equal(result.orchestrated, 1);
    assert.equal(result.workAttempts, 1);
    assert.equal(result.claimed, 0);
    assert.ok(result.outcomes.every(({ status, code }) =>
      status === "orchestrated" || (status === "decision_deferred" && code === "PR_FACTS_STALE")));
  }
  assert.deepEqual(executions, Array(3).fill(sources[2].itemId));
  assert.deepEqual(ledger.items, [...sources, cancelled]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test('obsolete ledger execution bindings defer their root and leave healthy roots runnable', async () => {
  const failure = new RoleContextAssemblerError('ROLE_CONTEXT_PR_FACT_UNAVAILABLE', 'old binding', 503,
    { cause: Object.assign(new Error('old Head'), { code: 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE', statusCode: 409 }) });
  const { loop, ledger, sources, executions } = deferredContextRootLoop({ failures: [failure] });
  const result = await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.equal(result.workAttempts, 1);
  assert.deepEqual(executions, [sources[1].itemId]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test("stale PR facts respect each cycle read budget and eventually reach a healthy root beyond two windows", async () => {
  const failures = Array.from({ length: 13 }, () => stalePullRequestFactsFailure());
  const { loop, ledger, sources, cancelled, assemblies, executions } = deferredContextRootLoop({ failures });
  let cycles = 0;
  while (executions.length === 0 && cycles < 5) {
    const priorReads = assemblies.length;
    const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    cycles += 1;
    assert.ok(assemblies.length - priorReads <= 4, "workLimit 1 permits at most four availability/context reads");
    assert.equal(result.claimed, 0);
    assert.ok(result.workAttempts <= 1);
  }
  assert.equal(cycles, 4);
  assert.deepEqual(executions, [sources[13].itemId]);
  assert.equal(new Set(assemblies).size, 14);
  assert.equal(assemblies.length, 14, "a partial sweep must not re-read unchanged stale roots");
  assert.deepEqual(ledger.items, [...sources, cancelled]);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test("a revised root is eligible immediately during a partial stale-fact sweep", async () => {
  const failures = Array.from({ length: 5 }, () => stalePullRequestFactsFailure());
  const { loop, ledger, sources, assemblies, executions } = deferredContextRootLoop({ failures });
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(assemblies.length, 4);
  ledger.items[0].revision += 1;
  failures[0] = null;
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.deepEqual(executions, [sources[0].itemId]);
  assert.equal(assemblies[4], sources[0].itemId);
});

test("root context deadlines respect the read budget and cannot starve later healthy work", async () => {
  const failures = Array.from({ length: 13 }, () => Object.assign(new Error("host context deadline"), { code: "ROLE_CONTEXT_TIMEOUT" }));
  const { loop, ledger, sources, cancelled, assemblies, executions } = deferredContextRootLoop({ failures });
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const reads = assemblies.length;
    const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    assert.ok(assemblies.length - reads <= 4);
    assert.equal(result.claimed, 0);
    assert.equal(result.workAttempts, cycle === 3 ? 1 : 0);
  }
  assert.deepEqual(executions, [sources[13].itemId]);
  assert.equal(assemblies.length, 14);
  assert.equal(new Set(assemblies).size, 14);
  assert.deepEqual(ledger.items, [...sources, cancelled]);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test("a revised root interrupts a partial context-deadline sweep", async () => {
  const failures = Array.from({ length: 5 }, () => Object.assign(new Error("host context deadline"), { code: "ROLE_CONTEXT_TIMEOUT" }));
  const { loop, ledger, sources, assemblies, executions } = deferredContextRootLoop({ failures });
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(assemblies.length, 4);
  ledger.items[0].revision += 1;
  failures[0] = null;
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(assemblies[4], sources[0].itemId);
  assert.deepEqual(executions, [sources[0].itemId]);
});

test("a targeted continuation retries recovered root context at the same item revision", async () => {
  const failures = Array.from({ length: 5 }, () => Object.assign(new Error("host context deadline"), { code: "ROLE_CONTEXT_TIMEOUT" }));
  const { loop, ledger, sources, assemblies, executions } = deferredContextRootLoop({ failures });
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(assemblies.length, 4);
  failures[0] = null;
  const target = ledger.items[0];
  const retried = await loop.runCycle({ roleId: "orchestrator", workLimit: 1,
    continuationTarget: { itemId: target.itemId, fingerprint: continuationFingerprint(target) } });
  assert.equal(retried.orchestrated, 1);
  assert.deepEqual(executions, [sources[0].itemId]);
  assert.equal(assemblies[4], target.itemId);
});

test("new urgent owner work precedes a partial context-deadline sweep", async () => {
  const failures = Array.from({ length: 13 }, () => Object.assign(new Error("host context deadline"), { code: "ROLE_CONTEXT_TIMEOUT" }));
  const { loop, ledger, executions } = deferredContextRootLoop({ failures });
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  const urgent = workItem(9999, { type: "role", id: "orchestrator" });
  urgent.event = normalizeWorkflowEvent({
    schemaVersion: 1, eventType: "owner_request.created", occurredAt: "2026-08-02T08:00:00.000Z",
    source: { provider: "local-owner", scopeId: "owner-command-center" },
    subject: { id: "owner-request:95abc353-8a86-46ba-b710-c01fb58d4a21", requestId: "95abc353-8a86-46ba-b710-c01fb58d4a21" },
    payload: { title: "Urgent follow-up", description: "Handle the new incident", priority: "urgent", workType: "general", acceptanceCriteria: [] },
  });
  ledger.items.push(urgent);
  await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.deepEqual(executions, [urgent.itemId]);
});

test("terminal PR retirement and stale PR deferral both permit the following healthy root", async () => {
  const { loop, ledger, sources, executions } = deferredContextRootLoop({
    failures: [terminalPullRequestFailure(), stalePullRequestFactsFailure()],
  });
  const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 2 });
  assert.deepEqual(result.outcomes.map(({ status }) => status),
    ["blocked", "decision_deferred", "orchestrated"]);
  assert.deepEqual(executions, [sources[2].itemId]);
  assert.equal(ledger.items[0].statusReason, "pr_source_terminal");
  assert.deepEqual(ledger.calls.claim.map(({ itemId }) => itemId), [sources[0].itemId]);
  assert.equal(ledger.items[1].attempt, 0);
});

test("untrusted or unrelated nested root failures still stop the work cycle", async (t) => {
  const variants = [
    ["plain outer error", () => {
      const original = stalePullRequestFactsFailure();
      return Object.assign(new Error(original.message, { cause: original.cause }),
        { code: original.code, statusCode: original.statusCode });
    }],
    ["wrong refresh wrapper", () => {
      const failure = stalePullRequestFactsFailure();
      failure.cause.code = "PR_REVIEW_CONTEXT_REFRESH_FAILED";
      return failure;
    }],
    ["unknown nested failure", () => {
      const failure = stalePullRequestFactsFailure();
      failure.cause.cause.code = "WORK_LEDGER_STATE_WRITE_FAILED";
      return failure;
    }],
    ["wrong leaf type", () => {
      const failure = stalePullRequestFactsFailure();
      failure.cause.cause.name = "Error";
      return failure;
    }],
    ["wrong leaf status", () => {
      const failure = stalePullRequestFactsFailure();
      failure.cause.cause.statusCode = 503;
      return failure;
    }],
    ["nested admission failure", () => {
      const failure = stalePullRequestFactsFailure();
      failure.cause.cause = Object.assign(new Error("restart required"), { code: "RUNTIME_RESTART_REQUIRED" });
      return failure;
    }],
  ];
  for (const [name, createFailure] of variants) {
    await t.test(name, async () => {
      const failure = createFailure();
      const { loop, ledger, executions } = deferredContextRootLoop({ failures: [failure] });
      await assert.rejects(loop.runCycle({ roleId: "orchestrator" }), (error) => error === failure);
      assert.deepEqual(executions, []);
      assert.equal(ledger.calls.claim.length, 0);
    });
  }
});

test("cycle cancellation takes precedence over a wrapped stale PR fact", async () => {
  const controller = new AbortController();
  const { loop, ledger, executions } = deferredContextRootLoop({
    failures: [stalePullRequestFactsFailure()], signal: controller,
  });
  await assert.rejects(loop.runCycle({ roleId: "orchestrator", signal: controller.signal }),
    (error) => error === controller.signal.reason);
  assert.deepEqual(executions, []);
  assert.equal(ledger.calls.claim.length, 0);
});

test("a configured root closes a terminal PR task instead of retrying it", async () => {
  const time = controlledClock();
  const root = workItem(801, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble() {
        throw terminalPullRequestFailure("MERGED");
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.blocked, 1);
  assert.equal(cycle.outcomes[0].code, "PR_FACTS_TERMINAL");
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].statusReason, "pr_source_terminal");
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.deepEqual(ledger.calls.transition[0].details, {
    code: "PR_FACTS_TERMINAL",
    outcome: "MERGED",
  });
});

test("a specialist closes a terminal PR task without consuming retry attempts", async () => {
  const time = controlledClock();
  const source = workItem(802, { type: "role", id: "pr-engineer" });
  const ledger = new FakeLedger({ source: [source], time });
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      "pr-engineer": worker({ roleId: "pr-engineer" }),
    }),
    time,
    roleContextAssembler: {
      async assemble() {
        throw terminalPullRequestFailure("CLOSED");
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "pr-engineer" });

  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.blocked, 1);
  assert.equal(cycle.retried, 0);
  assert.equal(ledger.items[0].status, "blocked");
  assert.equal(ledger.items[0].statusReason, "pr_source_terminal");
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.deepEqual(ledger.calls.transition[0].details, {
    code: "PR_FACTS_TERMINAL",
    outcome: "CLOSED",
  });
});

test("infrastructure failures separate maintenance from transient retries", async (t) => {
  for (const roleId of ["developer", "orchestrator"]) {
    for (const { code, failurePoint } of [...STRUCTURED_BRAIN_ATTENTION_CASES,
      { code: 'STRUCTURED_PROVIDER_PROCESS_FAILED', failurePoint: 'brain' },
      { code: 'STRUCTURED_PROVIDER_PROCESS_EXITED', failurePoint: 'brain' },
      { code: 'STRUCTURED_PROVIDER_MODEL_CAPACITY', failurePoint: 'brain' }]) {
      await t.test(`${roleId}:${code}`, async () => {
        const time = controlledClock();
        const source = workItem(81, { type: "role", id: roleId });
        const ledger = new FakeLedger({ source: [source], time });
        const loop = createLoop({ ledger, time, maxAttempts: 2,
          directory: new FakeRoleDirectory({ [roleId]: worker({ roleId,
            workerId: `employee-${roleId}`, async decide() {
              if (failurePoint === "brain") throw structuredBrainFailure(code);
              return completeDecision();
            } }) }),
          roleContextAssembler: { async assemble({ roleId, item }) {
            if (failurePoint === "context") throw structuredBrainFailure(code);
            return contextPacket(item, roleId);
          } }, orchestratorService: { async execute() { assert.fail("No execution after provider failure"); } },
        });
        if (["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_REAP_FAILED"].includes(code)) {
          const cycle = await loop.runCycle({ roleId });
          assert.equal(cycle.outcomes[0].status, "maintenance_required");
          assert.equal(cycle.retried, 0);
          assert.equal(ledger.outbox.length, 1);
          const intent = ledger.outbox[0].intent;
          assert.equal(intent.reason, `真实任务不得回退到例行大脑；系统已安全停止（${code}）`);
          assert.match(intent.question, /修复|清理/);
          assert.equal(intent.choices.length, 1);
          assert.equal(intent.choices[0].id, "configured-retry");
          assert.equal(intent.choices[0].description, "修复环境后重新排队；保留原任务权限与输入绑定。");
          assert.equal(JSON.stringify(intent).includes("sk-owner-secret"), false);
          time.advance(60_000);
          assert.equal((await loop.runCycle({ roleId })).claimed, 0);
          assert.equal(ledger.calls.scheduleRetry.length, 0);
          return;
        }
        for (let turn = 0; turn < 5; turn += 1) {
          const cycle = await loop.runCycle({ roleId });
          assert.equal(cycle.retried, 1);
          assert.equal(cycle.outcomes[0].code, code);
          assert.equal(ledger.items[0].status, 'retry_wait');
          assert.equal(ledger.items[0].attempt, 0);
          assert.equal(ledger.calls.scheduleRetry.at(-1).consumeAttempt, false);
          assert.equal(Date.parse(ledger.items[0].availableAt) > Date.parse(time.clock()), true);
          assert.equal((await loop.runCycle({ roleId })).claimed, 0);
          time.advance(60_000);
        }
        assert.equal(ledger.outbox.length, 0);
        assert.equal(ledger.calls.stageIntent.length, 0);
        assert.equal(ledger.calls.transition.length, 0);
        assert.equal(JSON.stringify(ledger.calls.scheduleRetry).includes("sk-owner-secret"), false);
      });
    }
  }
});

test("unknown recovery metadata cannot exempt a work item from its decision budget", async (t) => {
  for (const code of ["UNKNOWN_RECOVERY_FAILURE", "STRUCTURED_PROVIDER_FUTURE_FAILURE"]) {
    await t.test(code, async () => {
      const time = controlledClock();
      const ledger = new FakeLedger({ source: [workItem(83, { type: "role", id: "developer" })], time });
      let decisions = 0;
      const loop = createLoop({ ledger, time, maxAttempts: 2,
        directory: new FakeRoleDirectory({ developer: worker({ roleId: "developer", async decide() {
          decisions += 1;
          throw Object.assign(new Error("display or recovery claims are not authority"), {
            code, infrastructureFailure: true, modelFailure: false,
            recovery: { kind: "infrastructure", consumeAttempt: false },
          });
        } }) }),
      });
      assert.equal((await loop.runCycle({ roleId: "developer" })).retried, 1);
      assert.equal(ledger.items[0].attempt, 1);
      assert.equal(ledger.calls.scheduleRetry[0].reason, "decision_failed");
      assert.equal(ledger.calls.scheduleRetry[0].consumeAttempt, undefined);
      time.advance(60_000);
      assert.equal((await loop.runCycle({ roleId: "developer" })).blocked, 1);
      assert.equal(ledger.items[0].attempt, 2);
      time.advance(60_000);
      assert.equal((await loop.runCycle({ roleId: "developer" })).claimed, 0);
      assert.equal(decisions, 2);
      assert.equal(ledger.outbox.length, 0);
    });
  }
});

test("automatic root recovery tolerates a lost claim acknowledgement", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ source: [workItem(83, { type: "role", id: "orchestrator" })], time });
  ledger.claimFailure = "after_write";
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ orchestrator: worker({ roleId: "orchestrator", workerId: "employee-orchestrator",
      async decide() { throw structuredBrainFailure("STRUCTURED_PROVIDER_UNAVAILABLE"); } }) }),
    roleContextAssembler: { async assemble({ roleId, item }) { return contextPacket(item, roleId); } },
    orchestratorService: { async execute() {} },
  });
  assert.equal((await loop.runCycle({ roleId: "orchestrator" })).retried, 1);
  assert.equal(ledger.items[0].status, "retry_wait");
  assert.equal(ledger.calls.claim.length, 1);
  assert.equal(ledger.outbox.length, 0);
});

test("structured failures preserve specialist retries and root preclaim deferral", async (t) => {
  await t.test("specialist retries a provider timeout", async () => {
    const time = controlledClock();
    const source = workItem(87, { type: "role", id: "developer" });
    const ledger = new FakeLedger({ source: [source], time });
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        developer: worker({
          roleId: "developer",
          decide: async () => {
            throw structuredBrainFailure("STRUCTURED_PROVIDER_TIMEOUT");
          },
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble({ roleId, item }) {
          return contextPacket(item, roleId);
        },
      },
      orchestratorService: { async execute() {} },
    });

    const cycle = await loop.runCycle({ roleId: "developer" });

    assert.equal(cycle.retried, 1);
    assert.equal(cycle.outcomes[0].code, "STRUCTURED_PROVIDER_TIMEOUT");
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.calls.stageIntent.length, 0);
    assert.equal(ledger.outbox.length, 0);
  });

  for (const code of [
    "STRUCTURED_BRAIN_RESPONSE_INVALID",
    "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION",
  ]) {
    await t.test(`root defers ${code} without failing the employee`, async () => {
      const time = controlledClock();
      const root = workItem(88, { type: "role", id: "orchestrator" });
      const ledger = new FakeLedger({ source: [root], time });
      const loop = createLoop({
        ledger,
        directory: new FakeRoleDirectory({
          orchestrator: worker({
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
            decide: async () => {
              throw structuredBrainFailure(code);
            },
          }),
        }),
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: { async execute() {} },
      });

      const cycle = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(cycle.outcomes[0].status, "decision_deferred");
      assert.equal(cycle.outcomes[0].code, code);
      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(ledger.outbox.length, 0);
    });
  }
});

test("an unchanged root malformed response backs off without consuming work", async () => {
  const time = controlledClock();
  const root = workItem(889, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  let decisions = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
        async decide() {
          decisions += 1;
          throw structuredBrainFailure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const first = await loop.runCycle({ roleId: "orchestrator" });
  assert.equal(first.outcomes[0].status, "decision_deferred");
  assert.equal(first.workAttempts, 0);
  const repeated = await loop.runCycle({ roleId: "orchestrator" });
  assert.equal(repeated.outcomes[0].status, "decision_deferred");
  assert.equal(repeated.outcomes[0].code, "STRUCTURED_PROVIDER_RESPONSE_INVALID");
  assert.equal(repeated.workAttempts, 0);
  assert.equal(decisions, 1);

  time.advance(1_000);
  await loop.runCycle({ roleId: "orchestrator" });
  assert.equal(decisions, 2);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[0].revision, root.revision);
  assert.equal(ledger.items[0].attempt, 0);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
});

test("cycle-signal cancellation wins over configured-root owner attention", async () => {
  const time = controlledClock();
  const root = workItem(86, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const started = deferred();
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
        decide: async ({ signal }) => {
          started.resolve();
          return new Promise((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });
  const controller = new AbortController();
  const running = loop.runCycle({
    roleId: "orchestrator",
    signal: controller.signal,
  });
  await started.promise;
  const cancellation = Object.assign(new Error("cycle stopped"), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  controller.abort(cancellation);

  await assert.rejects(running, (error) => error === cancellation);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
  assert.equal(ledger.outbox.length, 0);
});

test("a child-blocked configured root orchestrates without obtaining a lease", async () => {
  const time = controlledClock();
  const root = workItem(40, { type: "role", id: "orchestrator" });
  const child = workItem(41, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async ({ item }) => orchestrationDecision(item),
    }),
    developer: worker({ roleId: "developer" }),
  });
  const executions = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute(input) {
        executions.push(clone(input));
        return { applied: true };
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.orchestrated, 1);
  assert.equal(cycle.claimed, 0);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(executions[0].item.status, "queued");
});

test("an expired configured root orchestrates without reclaiming its lease", async () => {
  const time = controlledClock();
  const root = workItem(70, { type: "role", id: "orchestrator" });
  root.status = "working";
  root.ownerId = "previous-orchestrator";
  root.leaseId = "expired-root-lease";
  root.leaseUntil = new Date(
    Date.parse(time.clock()) - 1_000,
  ).toISOString();
  root.attempt = 1;
  const ledger = new FakeLedger({ source: [root], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async ({ item }) => orchestrationDecision(item),
    }),
  });
  const executions = [];
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute(input) {
        executions.push(clone(input));
        return { applied: true };
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.orchestrated, 1);
  assert.equal(cycle.claimed, 0);
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].item.status, "working");
  assert.equal(executions[0].item.leaseId, "expired-root-lease");
});

test("runtime cutover leaves configured root orchestration queued", async (t) => {
  for (const failurePoint of ["brain", "orchestration"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const root = workItem(
        failurePoint === "brain" ? 63 : 64,
        { type: "role", id: "orchestrator" },
      );
      const ledger = new FakeLedger({ source: [root], time });
      const admissionError = Object.assign(new Error("configuration changed"), {
        code: "RUNTIME_RESTART_REQUIRED",
      });
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => {
            if (failurePoint === "brain") throw admissionError;
            return orchestrationDecision(item);
          },
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            throw admissionError;
          },
        },
      });

      await assert.rejects(
        loop.runCycle({ roleId: "orchestrator" }),
        (error) => error === admissionError,
      );

      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);
      assert.equal(ledger.calls.stageIntent.length, 0);
      assert.equal(serviceCalls, failurePoint === "orchestration" ? 1 : 0);
    });
  }
});

test("a child-blocked root generic decision stays unclaimed", async () => {
  const time = controlledClock();
  const root = workItem(42, { type: "role", id: "orchestrator" });
  const child = workItem(43, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
  });
  let serviceCalls = 0;
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        serviceCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.outcomes[0].status, "graph_blocked");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
  assert.equal(serviceCalls, 0);
});

test("healthy pending external Review children leave root model capacity for the next PR", async (t) => {
  for (const variant of ["healthy", "blocked", "paused", "waiting_condition", "submitted", "accepted", "truncated", "wrong-role", "head-changed", "other-dependency"]) {
    await t.test(variant, async () => {
      const time = controlledClock();
      const root = workItem(42, { type: "role", id: "orchestrator" });
      root.event = { ...root.event, eventType: "pull_request.owner_requested", source: { provider: "local-owner" }, payload: {
        workType: "general", priority: "urgent", nextAction: "rereview", suggestedCapability: "pr-review",
        expectedHeadRefOid: "a".repeat(40), headRefOid: variant === "head-changed" ? "b".repeat(40) : "a".repeat(40),
      } };
      const child = workItem(43, { type: "role", id: "pr-engineer" });
      child.graph.parentItemId = root.itemId;
      const tail = workItem(44, { type: "role", id: "orchestrator" });
      const ledger = new FakeLedger({ source: [root, child, tail], time });
      const decisions = [];
      const loop = createLoop({ ledger, time, workLimit: 1,
        directory: new FakeRoleDirectory({ orchestrator: worker({ roleId: "orchestrator", workerId: "employee-orchestrator",
          decide: async ({ item }) => { decisions.push(item.itemId); return completeDecision(); } }),
          "pr-engineer": worker({ roleId: "pr-engineer" }) }),
        roleContextAssembler: { async assemble({ roleId, item }) {
          const packet = contextPacket(item, roleId);
          if (item.itemId === root.itemId) packet.context.requirements.coordination = {
            deliveryWindow: { pendingCount: 0, hasMore: false },
            directChildren: [{ responsibility: { type: "role", id: variant === "wrong-role" ? "developer" : "pr-engineer" },
              ledgerStatus: ["blocked", "paused", "waiting_condition"].includes(variant) ? variant : "queued",
              hasMoreDeliverables: variant === "truncated", deliverableCount: 1, hasAcceptedRequiredReview: false,
              hasOtherDependencies: variant === "other-dependency", directDependencyTaskIds: [],
              deliverables: [{ kind: "github-review", required: true, state: ["submitted", "accepted"].includes(variant) ? variant : "none" }],
            }],
          };
          return packet;
        } }, orchestratorService: { async execute() { assert.fail("No orchestration command is needed"); } },
      });
      const result = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      if (variant === "healthy") {
        assert.deepEqual(decisions, [tail.itemId], JSON.stringify(result));
        assert.equal(result.outcomes[0].status, "graph_blocked");
        assert.equal(ledger.calls.claim.some(call => call.itemId === root.itemId), false);
      } else assert.equal(decisions.includes(root.itemId), true, "actionable or incomplete child facts must still reach the model");
    });
  }
});

async function blockedRootSweepLoop({ listReadinessItems, rootPriority = null, includeTail = false, rootCount = 3, pullRequestRoots = false } = {}) {
  const time = controlledClock();
  const values = new Map();
  const store = {
    async read(key, fallback) { return clone(values.get(key) ?? fallback); },
    async write(key, value) { values.set(key, clone(value)); },
  };
  const records = Array.from({ length: rootCount + (includeTail ? 2 : 1) }, (_, index) => {
    const item = workItem(501 + index, {
      type: "role", id: index === rootCount ? "pr-reviewer" : "orchestrator",
    });
    const event = normalizeWorkflowEvent(index < rootCount && pullRequestRoots ? {
      schemaVersion: 1, eventType: "pull_request.owner_requested", occurredAt: item.createdAt,
      source: { provider: "local-owner", scopeId: `owner-request:00000000-0000-4000-8000-${String(501 + index).padStart(12, '0')}` },
      subject: { id: `github:pr:acme/repo#${501 + index}`, repository: "acme/repo", number: 501 + index },
      payload: { workType: 'pull_request', title: 'Review current PR', description: 'Review current code', priority: 'normal',
        acceptanceCriteria: [], headRefOid: "b".repeat(40), gitTargetAvailable: true,
        gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo",
          headRepository: "acme/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) } },
    } : index < rootCount && rootPriority !== null ? {
      schemaVersion: 1, eventType: "owner_request.created", occurredAt: item.createdAt,
      source: { provider: "local-owner", scopeId: "owner-command-center" },
      subject: { id: `owner-request:00000000-0000-4000-8000-00000000050${index}`,
        requestId: `00000000-0000-4000-8000-00000000050${index}` },
      payload: { title: `Scheduled work ${index + 1}`, description: "Complete the owner assignment",
        workType: "general", priority: rootPriority, acceptanceCriteria: [] },
    } : {
      schemaVersion: 1, eventType: "issue.created", occurredAt: item.createdAt,
      source: { provider: "github", scopeId: "github-dashboard" },
      subject: { id: `github:issue:acme/repo#${501 + index}`, repository: "acme/repo", number: 501 + index },
      payload: { title: `Scheduled work ${index + 1}` },
    });
    return {
      sequence: index + 1,
      assignment: {
        ...item.assignment, eventId: event.eventId,
        reason: "scheduled-work", createdAt: item.createdAt,
      },
      event,
    };
  });
  let nextId = 0;
  const ledger = new WorkLedgerService({
    store, clock: time.clock, idFactory: () => `sweep-lease-${++nextId}`,
    exclusiveLease: { async run(operation) { return operation(); } },
    assignmentSource: { async readAssignmentBatch({ afterSequence, limit }) {
      const items = records.filter(({ sequence }) => sequence > afterSequence).slice(0, limit);
      return clone({ items, nextSequence: items.at(-1)?.sequence ?? afterSequence,
        highWatermark: records.length, oldestAvailableSequence: 1 });
    } },
  });
  await ledger.recover();
  await ledger.intake({ limit: 100 });
  const initialItems = (await ledger.listItems({ limit: 100 })).items;
  const roots = initialItems.slice(0, rootCount);
  const tail = includeTail ? initialItems.at(-1) : null;
  const children = [];
  for (const root of roots) {
    const created = await ledger.createGraphChild({
      authority: { actorId: "employee-orchestrator", scopeRootTaskId: root.itemId },
      command: {
        parentTaskId: root.itemId, childKey: "implementation",
        work: { title: "Implement assigned work", description: "Prepare a result for root acceptance." },
        target: { type: "role", id: "developer" }, dependsOnTaskIds: [],
        acceptanceContract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [] },
        leaseId: null, expectedGraphRevision: (await ledger.getSummary()).revision,
        expectedTaskRevisions: [{ taskId: root.itemId, revision: root.revision }],
      },
    });
    children.push(await ledger.readItemForReconciliation({ itemId: created.taskId }));
  }
  const decisions = [];
  let decideRoot = () => completeDecision();
  if (listReadinessItems) {
    const listItems = ledger.listItems.bind(ledger);
    ledger.listItems = (options) => options.status === undefined
      ? listReadinessItems(options, listItems) : listItems(options);
  }
  const loop = createLoop({
    ledger, time, taskRuns: new TaskRunRegistry({ store, clock: time.clock,
      settleControl: createTaskRunSettler({ ledger }) }),
    directory: new FakeRoleDirectory({
      orchestrator: worker({ roleId: "orchestrator", async decide({ item }) {
        decisions.push(item.itemId);
        return decideRoot(item);
      } }),
      developer: worker({ roleId: "developer" }),
      "pr-reviewer": worker(),
    }),
    roleContextAssembler: new RoleContextAssembler({
      graphReader: { getSnapshot: () => ledger.getGraphSnapshot() },
    }),
    orchestratorService: { async execute() { return { applied: true }; } },
  });
  return { loop, ledger, roots, tail, children, decisions, records,
    setRootDecision(decide) { decideRoot = decide; } };
}

for (const terminalCount of [1, 70]) test(`graph-rejected terminal claims preserve bounded fair progress past ${terminalCount} roots`, async t => {
  const { loop, ledger, roots, children, decisions, setRootDecision } = await blockedRootSweepLoop({ rootCount: terminalCount + 1, pullRequestRoots: true });
  setRootDecision(item => orchestrationDecision(item));
  const healthy = roots.at(-1);
  assert.ok(roots.every(root => root.kind === 'source_root' && root.source.scope.kind === 'owner_requested' &&
    currentWorkItemExecutionBinding(root)?.gitTarget.headRefOid === 'b'.repeat(40)), 'real owner source authority and Head/Base bindings are retained');
  const assemble = loop.roleContextAssembler.assemble;
  const failed = new Set(roots.slice(0, -1).map(item => item.itemId));
  loop.roleContextAssembler = { async assemble(input) {
    if (failed.has(input.item.itemId)) throw terminalPullRequestFailure();
    return assemble(input);
  } };
  loop.orchestratorService = { async execute() { return { applied: true }; } };
  const before = await ledger.listItems({ limit: 200 });
  const cycles = [];
  for (let n = 0; n < 4 && !decisions.includes(healthy.itemId); n++) {
    const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    cycles.push(cycle);
    assert.ok(cycle.claimAttempts <= 32, "claim scanning remains bounded per cycle");
    assert.ok(cycle.workAttempts <= 1);
  }
  assert.deepEqual(decisions, [healthy.itemId], "guarded old claims cannot starve later valid root coordination");
  assert.equal(cycles.at(-1).orchestrated, 1);
  assert.equal(cycles.reduce((total, cycle) => total + cycle.claimAttempts, 0), terminalCount,
    "each unchanged blocked root is scanned once across the sweep");
  assert.ok(cycles.flatMap(cycle => cycle.outcomes).filter(row => failed.has(row.itemId))
    .every(row => row.status === "claim_not_acquired" && row.code === "WORK_LEDGER_GRAPH_BLOCKED"));
  assert.deepEqual(await ledger.listItems({ limit: 200 }), before, "no guarded root or child is claimed or retired");
  if (terminalCount === 1) {
    const root = await ledger.readItemForReconciliation({ itemId: roots[0].itemId });
    await ledger.reviseGraphAcceptance({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: root.itemId },
      command: { taskId: root.itemId, expectedTaskRevision: root.revision,
        expectedGraphRevision: (await ledger.getSummary()).revision, reason: 'New owner acceptance input',
        acceptanceContract: { revision: 2, acceptanceCriteria: [{ criterionId: 'updated', description: 'New acceptance input' }], expectedDeliverables: [] } } });
    const revised = await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
    assert.equal(revised.claimAttempts, 1, 'changed root input immediately invalidates its prior sweep entry');
    assert.equal(revised.claimed, 0, 'the graph guard still refuses the revised root with unsettled children');
    const child = await ledger.readItemForReconciliation({ itemId: children[0].itemId });
    const claimed = await ledger.claim({ itemId: child.itemId, expectedRevision: child.revision,
      workerId: 'employee-developer', leaseDurationMs: 120_000 });
    await ledger.complete({ itemId: claimed.itemId, expectedRevision: claimed.revision, leaseId: claimed.leaseId,
      actorId: 'employee-developer', result: { outcome: 'done' } });
    const next = await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
    assert.equal(next.blocked, 1, 'changed child progress immediately permits normal terminal settlement');
    assert.equal((await ledger.readItemForReconciliation({ itemId: roots[0].itemId })).statusReason, 'pr_source_terminal');
  }
});

test("unchanged blocked roots complete a fair sweep across role cycles without extra decisions or claims", async () => {
  const { loop, ledger, roots, decisions } = await blockedRootSweepLoop();
  const before = await ledger.listItems();
  for (let index = 0; index < roots.length; index += 1) {
    const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    assert.equal(cycle.workAttempts, 1);
    assert.equal(cycle.availabilityChecks, 1);
    assert.equal(cycle.claimAttempts, 0);
    assert.equal(cycle.claimed, 0);
    assert.deepEqual(cycle.outcomes.map(({ itemId, status }) => [itemId, status]),
      [[roots[index].itemId, "graph_blocked"]]);
    if (index === 0) {
      const otherRole = await loop.runCycle({ roleId: "pr-reviewer", workLimit: 1 });
      assert.equal(otherRole.workAttempts, 1);
      assert.equal(otherRole.claimed, 1);
    }
  }
  assert.deepEqual(decisions, roots.map(({ itemId }) => itemId));
  const after = await ledger.listItems();
  assert.deepEqual(after.items.filter((item) => item.currentTarget.id !== "pr-reviewer"),
    before.items.filter((item) => item.currentTarget.id !== "pr-reviewer"));
  const retry = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(retry.workAttempts, 1, "a completed sweep starts its next round on the next role cycle");
  assert.equal(retry.claimAttempts, 0);
  assert.equal(decisions.at(-1), roots[0].itemId);
});

test("targeted coordination preserves an ordinary partial sweep across other blocked roots", async () => {
  const { loop, ledger, roots, decisions } = await blockedRootSweepLoop();
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  const target = await ledger.readItemForReconciliation({ itemId: roots[2].itemId });
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1,
    continuationTarget: { itemId: target.itemId, fingerprint: continuationFingerprint(target) } });
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.deepEqual(decisions, [roots[0].itemId, roots[2].itemId, roots[1].itemId]);
});

test("a blocked-root sweep reaches lower-priority ready work before retrying earlier roots", async () => {
  const { loop, roots, tail, decisions } = await blockedRootSweepLoop({ rootPriority: "high", includeTail: true });
  for (let index = 0; index < 4; index += 1) {
    const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    assert.equal(cycle.workAttempts, 1);
    assert.deepEqual(cycle.outcomes.map(({ itemId, status }) => [itemId, status]),
      [[index === 3 ? tail.itemId : roots[index].itemId, index === 3 ? "staged" : "graph_blocked"]]);
    assert.equal(cycle.claimAttempts, index === 3 ? 1 : 0);
  }
  assert.deepEqual(decisions, [...roots, tail].map(({ itemId }) => itemId));
});

test("changed root or hidden child revisions interrupt a partial blocked-root sweep immediately", async (t) => {
  for (const changed of ["root", "hidden child", "child completion"]) {
    await t.test(changed, async () => {
      const { loop, ledger, roots, children, decisions } = await blockedRootSweepLoop();
      if (changed === "hidden child") {
        await ledger.pauseGraphTask({
          authority: { actorId: "employee-orchestrator", scopeRootTaskId: roots[0].itemId },
          command: { taskId: children[0].itemId, expectedTaskRevision: children[0].revision,
            expectedGraphRevision: (await ledger.getSummary()).revision, reason: "Await required input" },
        });
      }
      await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      const rootBefore = await ledger.readItemForReconciliation({ itemId: roots[0].itemId });
      const factsBefore = (await ledger.listClaimCandidates({ at: "2026-08-02T08:00:00.000Z" })).facts
        .find(({ itemId }) => itemId === roots[0].itemId);
      let changedItem = await ledger.readItemForReconciliation({
        itemId: changed === "root" ? roots[0].itemId : children[0].itemId,
      });
      if (changed === "child completion") {
        const claim = await ledger.claim({ itemId: changedItem.itemId, expectedRevision: changedItem.revision,
          workerId: "employee-developer", leaseDurationMs: 120_000 });
        await ledger.complete({ itemId: claim.itemId, expectedRevision: claim.revision,
          leaseId: claim.leaseId, actorId: "employee-developer", result: { outcome: "done" } });
      } else {
        if (changed === "hidden child") {
          await ledger.resumeGraphTask({
            authority: { actorId: "employee-orchestrator", scopeRootTaskId: roots[0].itemId },
            command: { taskId: changedItem.itemId, expectedTaskRevision: changedItem.revision,
              expectedGraphRevision: (await ledger.getSummary()).revision, reason: "Revise required input" },
          });
          changedItem = await ledger.readItemForReconciliation({ itemId: changedItem.itemId });
        }
        await ledger.reviseGraphAcceptance({
          authority: { actorId: "employee-orchestrator", scopeRootTaskId: roots[0].itemId },
          command: { taskId: changedItem.itemId, expectedTaskRevision: changedItem.revision,
            expectedGraphRevision: (await ledger.getSummary()).revision, reason: "Updated acceptance input",
            acceptanceContract: { revision: 2, expectedDeliverables: [],
              acceptanceCriteria: [{ criterionId: "updated", description: "Account for new requirements" }] } },
        });
        if (changed === "hidden child") {
          changedItem = await ledger.readItemForReconciliation({ itemId: changedItem.itemId });
          await ledger.pauseGraphTask({
            authority: { actorId: "employee-orchestrator", scopeRootTaskId: roots[0].itemId },
            command: { taskId: changedItem.itemId, expectedTaskRevision: changedItem.revision,
              expectedGraphRevision: (await ledger.getSummary()).revision, reason: "Await revised input" },
          });
        }
      }
      if (changed !== "root") {
        assert.deepEqual(await ledger.readItemForReconciliation({ itemId: roots[0].itemId }), rootBefore);
      }
      if (changed === "hidden child") {
        const candidates = await ledger.listClaimCandidates({ at: "2026-08-02T08:00:00.000Z" });
        assert.ok(candidates.items.every(({ itemId }) => itemId !== changedItem.itemId));
        const { graphProgressDigest: beforeDigest, ...beforeCounts } = factsBefore;
        const { graphProgressDigest: afterDigest, ...afterCounts } = candidates.facts
          .find(({ itemId }) => itemId === roots[0].itemId);
        assert.notEqual(afterDigest, beforeDigest, "hidden child revisions change the scheduling observation");
        assert.deepEqual(afterCounts, beforeCounts,
          "same-count readiness changes must not depend on aggregate candidate facts");
      }
      const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      assert.deepEqual(decisions, [roots[0].itemId, roots[0].itemId]);
      assert.equal(cycle.workAttempts, 1);
      assert.equal(cycle.claimAttempts, changed === "child completion" ? 1 : 0);
      assert.equal(cycle.outcomes[0].status, changed === "child completion" ? "staged" : "graph_blocked");
    });
  }
});

test('a second nested coordination return interrupts its partial blocked-root sweep without unrelated wakeups', async () => {
  const { loop, ledger, roots, children, decisions } = await blockedRootSweepLoop();
  const nested = [];
  for (let index = 0; index < 2; index++) {
    const parent = await ledger.readItemForReconciliation({ itemId: children[0].itemId });
    const created = await ledger.createGraphChild({
      authority: { actorId: 'employee-orchestrator', scopeRootTaskId: roots[0].itemId },
      command: { parentTaskId: parent.itemId, childKey: `nested-return-${index}`,
        work: { title: 'Nested specialist work', description: 'Retain its specialist contract' },
        target: { type: 'role', id: 'developer' }, dependsOnTaskIds: [],
        acceptanceContract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [] }, leaseId: null,
        expectedGraphRevision: (await ledger.getSummary()).revision,
        expectedTaskRevisions: [{ taskId: parent.itemId, revision: parent.revision }] },
    });
    nested.push(created.taskId);
  }
  const handback = async itemId => {
    const item = await ledger.readItemForReconciliation({ itemId });
    const claim = await ledger.claim({ itemId, expectedRevision: item.revision, workerId: 'employee-developer', leaseDurationMs: 30000 });
    await ledger.handoff({ itemId, expectedRevision: claim.revision, leaseId: claim.leaseId, actorId: 'employee-developer',
      target: { type: 'role', id: 'orchestrator' }, reason: 'Nested handback' });
  };
  await handback(nested[0]);
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  const before = (await ledger.readItemProgress([roots[0].itemId]))[0].graphProgressDigest;
  const normal = await ledger.readItemForReconciliation({ itemId: nested[1] });
  await ledger.reviseGraphAcceptance({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: roots[0].itemId },
    command: { taskId: normal.itemId, expectedTaskRevision: normal.revision, expectedGraphRevision: (await ledger.getSummary()).revision,
      reason: 'Ordinary nested specialist progress', acceptanceContract: { revision: 2, expectedDeliverables: [],
        acceptanceCriteria: [{ criterionId: 'normal', description: 'Normal specialist revision' }] } } });
  assert.equal((await ledger.readItemProgress([roots[0].itemId]))[0].graphProgressDigest, before,
    'ordinary nested work is outside the new coordination-return observation');
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.deepEqual(decisions, [roots[0].itemId, roots[1].itemId]);
  await handback(nested[1]);
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.deepEqual(decisions, [roots[0].itemId, roots[1].itemId, roots[0].itemId],
    'related nested handback invalidates the cached root observation');
});

test("fresh urgent owner work and productive orchestration remain eligible during blocked-root sweeps", async (t) => {
  await t.test("new urgent request", async () => {
    const { loop, ledger, roots, records, decisions } = await blockedRootSweepLoop();
    await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    const requestId = "95abc353-8a86-46ba-b710-c01fb58d4a21";
    const event = normalizeWorkflowEvent({
      schemaVersion: 1, eventType: "owner_request.created", occurredAt: "2026-08-02T08:00:00.000Z",
      source: { provider: "local-owner", scopeId: "owner-command-center" },
      subject: { id: `owner-request:${requestId}`, requestId },
      payload: { title: "Urgent owner follow-up", description: "Investigate the new incident", priority: "urgent",
        workType: "general", acceptanceCriteria: [] },
    });
    records.push({ sequence: 5, event, assignment: { assignmentId: "urgent-sweep-assignment", eventId: event.eventId,
      target: { type: "role", id: "orchestrator" }, reason: "owner-request", createdAt: event.occurredAt } });
    const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
    assert.equal(cycle.staged, 1);
    assert.equal(cycle.workAttempts, 1);
    assert.equal(cycle.claimAttempts, 1);
    assert.equal(decisions[0], roots[0].itemId);
    assert.equal(decisions[1], cycle.outcomes[0].itemId);
    assert.ok(roots.every(({ itemId }) => itemId !== decisions[1]));
  });
  await t.test("productive orchestration", async () => {
    const { loop, roots, decisions, setRootDecision } = await blockedRootSweepLoop();
    setRootDecision((item) => orchestrationDecision(item));
    for (let index = 0; index < 3; index += 1) {
      const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      assert.equal(cycle.orchestrated, 1);
      assert.equal(cycle.workAttempts, 1);
      assert.equal(cycle.claimAttempts, 0);
    }
    assert.deepEqual(decisions, Array(3).fill(roots[0].itemId));
  });
});

test("unavailable or inconsistent blocked-root sweep evidence keeps the ordinary decision eligible", async (t) => {
  for (const failure of ["unavailable", "inconsistent"]) {
    await t.test(failure, async () => {
      let failReadiness = false;
      const { loop, roots, decisions } = await blockedRootSweepLoop({
        async listReadinessItems(options, listItems) {
          if (failReadiness && failure === "unavailable") throw new Error("Readiness read unavailable");
          const page = await listItems(options);
          if (failReadiness) page.items[0].revision += 1;
          return page;
        },
      });
      await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      failReadiness = true;
      const cycle = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
      assert.deepEqual(decisions, [roots[0].itemId, roots[0].itemId]);
      assert.equal(cycle.outcomes[0].status, "graph_blocked");
      assert.equal(cycle.workAttempts, 1);
      assert.equal(cycle.claimAttempts, 0);
    });
  }
});

test("a superseded child is terminal and does not block root completion", async () => {
  const time = controlledClock();
  const root = workItem(142, { type: "role", id: "orchestrator" });
  const child = workItem(143, { type: "role", id: "developer" });
  child.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  child.status = "superseded";
  const ledger = new FakeLedger({ source: [root, child], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a cancelled child is settled and lets the root judge replacement work", async () => {
  const time = controlledClock();
  const root = workItem(144, { type: "role", id: "orchestrator" });
  const cancelled = workItem(145, { type: "role", id: "developer" });
  const replacement = workItem(146, { type: "role", id: "developer" });
  cancelled.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  replacement.graph = { parentItemId: root.itemId, dependsOnItemIds: [] };
  cancelled.status = "cancelled";
  replacement.status = "completed";
  const ledger = new FakeLedger({ source: [root, cancelled, replacement], time });
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => completeDecision(),
    }),
    developer: worker({ roleId: "developer" }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
  assert.equal(ledger.calls.stageIntent.length, 1);
});

test("a cancelled dependency remains unsatisfied", async () => {
  const time = controlledClock();
  const dependency = workItem(147, { type: "role", id: "developer" });
  const dependent = workItem(148, { type: "role", id: "developer" });
  dependency.status = "cancelled";
  dependent.graph = {
    parentItemId: null,
    dependsOnItemIds: [dependency.itemId],
  };
  const ledger = new FakeLedger({ source: [dependency, dependent], time });
  let decisions = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      developer: worker({
        roleId: "developer",
        decide: async () => {
          decisions += 1;
          return completeDecision();
        },
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "developer" });

  assert.equal(cycle.claimed, 0);
  assert.equal(decisions, 0);
  assert.equal(ledger.calls.stageIntent.length, 0);
});

test("a ready root decides before claiming and staging a generic intent", async () => {
  const time = controlledClock();
  const root = workItem(44, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const order = [];
  const originalClaim = ledger.claim.bind(ledger);
  const originalStage = ledger.stageIntent.bind(ledger);
  ledger.claim = async (input) => {
    order.push("claim");
    return originalClaim(input);
  };
  ledger.stageIntent = async (input) => {
    order.push("stage");
    return originalStage(input);
  };
  const directory = new FakeRoleDirectory({
    orchestrator: worker({
      roleId: "orchestrator",
      workerId: "employee-orchestrator",
      decide: async () => {
        order.push("decide");
        return completeDecision();
      },
    }),
  });
  const loop = createLoop({
    ledger,
    directory,
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        order.push("assemble");
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.deepEqual(order, ["assemble", "decide", "claim", "stage"]);
  assert.equal(cycle.staged, 1);
  assert.equal(cycle.claimed, 1);
});

test("missing-target fallback never exposes work to trusted role ports", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [workItem(45, { type: "role", id: "missing-role" })],
    time,
  });
  let trustedCalls = 0;
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory(),
    time,
    roleContextAssembler: {
      async assemble() {
        trustedCalls += 1;
      },
    },
    orchestratorService: {
      async execute() {
        trustedCalls += 1;
      },
    },
  });

  const cycle = await loop.runCycle();

  assert.equal(cycle.staged, 1);
  assert.equal(trustedCalls, 0);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
});

test("concurrent scopes create only one question for the same missing target", async () => {
  const time = controlledClock();
  const target = { type: "role", id: "missing-specialist" };
  const ledger = new FakeLedger({
    source: [workItem(46, target), workItem(47, target)],
    time,
  });
  const firstStageStarted = deferred();
  const releaseFirstStage = deferred();
  const secondResolveStarted = deferred();
  const releaseSecondResolve = deferred();
  const directory = new FakeRoleDirectory();
  let resolveCalls = 0;
  directory.resolve = async (requestedTarget) => {
    directory.calls.push(clone(requestedTarget));
    resolveCalls += 1;
    if (resolveCalls === 2) {
      secondResolveStarted.resolve();
      await releaseSecondResolve.promise;
    }
    return null;
  };
  const originalStage = ledger.stageIntent.bind(ledger);
  ledger.stageIntent = async (input) => {
    firstStageStarted.resolve();
    await releaseFirstStage.promise;
    return originalStage(input);
  };
  const loop = createLoop({ ledger, directory, time });

  const wildcardCycle = loop.runCycle({ workLimit: 1 });
  await firstStageStarted.promise;
  const orchestratorCycle = loop.runCycle({
    roleId: "orchestrator",
    workLimit: 2,
  });
  await secondResolveStarted.promise;
  releaseFirstStage.resolve();
  await wildcardCycle;
  releaseSecondResolve.resolve();
  const concurrent = await orchestratorCycle;

  assert.equal(ledger.calls.stageIntent.length, 1);
  assert.equal(ledger.outbox.length, 1);
  assert.equal(ledger.outbox[0].intent.type, "ask_user");
  assert.equal(
    concurrent.outcomes.every(
      ({ status }) => status === "missing_target_waiting",
    ),
    true,
  );
});

test("different role cycles overlap while one item is decided only once", async () => {
  const time = controlledClock();
  const ledger = new FakeLedger({
    source: [
      workItem(50, { type: "role", id: "requirements-analyst" }),
      workItem(51, { type: "role", id: "developer" }),
    ],
    time,
  });
  const requirementsStarted = deferred();
  const developerStarted = deferred();
  const release = deferred();
  const directory = new FakeRoleDirectory({
    "requirements-analyst": worker({
      roleId: "requirements-analyst",
      decide: async () => {
        requirementsStarted.resolve();
        await release.promise;
        return completeDecision();
      },
    }),
    developer: worker({
      roleId: "developer",
      decide: async () => {
        developerStarted.resolve();
        await release.promise;
        return completeDecision();
      },
    }),
  });
  const trusted = {
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: { async execute() {} },
  };
  const loop = createLoop({ ledger, directory, time, ...trusted });

  const requirements = loop.runCycle({ roleId: "requirements-analyst" });
  await requirementsStarted.promise;
  const developer = loop.runCycle({ roleId: "developer" });
  await Promise.race([
    developerStarted.promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("different role cycle was serialized")),
      100,
    )),
  ]);
  release.resolve();
  await Promise.all([requirements, developer]);

  const wildcard = loop.runCycle();
  const developerAgain = loop.runCycle({ roleId: "developer" });
  await Promise.all([wildcard, developerAgain]);
  assert.deepEqual(
    ledger.calls.claim.map(({ itemId }) => itemId).sort(),
    ["work-item-50", "work-item-51"],
  );
});

test("root trusted failures use natural cycles without lease-based retry", async (t) => {
  for (const failurePoint of ["assembler", "service"]) {
    await t.test(failurePoint, async () => {
      const time = controlledClock();
      const root = workItem(
        failurePoint === "assembler" ? 60 : 61,
        { type: "role", id: "orchestrator" },
      );
      const ledger = new FakeLedger({ source: [root], time });
      let assembleCalls = 0;
      let serviceCalls = 0;
      const directory = new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => orchestrationDecision(item),
        }),
      });
      const loop = createLoop({
        ledger,
        directory,
        time,
        roleContextAssembler: {
          async assemble({ roleId, item }) {
            assembleCalls += 1;
            if (failurePoint === "assembler" && assembleCalls === 1) {
              throw new Error("trusted context failed");
            }
            return contextPacket(item, roleId);
          },
        },
        orchestratorService: {
          async execute() {
            serviceCalls += 1;
            if (failurePoint === "service" && serviceCalls === 1) {
              throw new Error("trusted mutation failed");
            }
            return { applied: true };
          },
        },
      });

      await assert.rejects(
        loop.runCycle({ roleId: "orchestrator" }),
        failurePoint === "assembler"
          ? /trusted context failed/
          : /trusted mutation failed/,
      );
      assert.equal(ledger.items[0].status, "queued");
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(ledger.calls.transition.length, 0);

      const recovered = await loop.runCycle({ roleId: "orchestrator" });

      assert.equal(recovered.orchestrated, 1);
      assert.equal(ledger.calls.claim.length, 0);
      assert.equal(ledger.calls.scheduleRetry.length, 0);
      assert.equal(assembleCalls, 2);
      assert.equal(serviceCalls, failurePoint === "assembler" ? 1 : 2);
    });
  }
});

test("a pre-write root authority rejection stays local to one orchestration outcome", async () => {
  const time = controlledClock();
  const root = workItem(65, { type: "role", id: "orchestrator" });
  const ledger = new FakeLedger({ source: [root], time });
  const denied = new OrchestratorServiceError(
    "ORCHESTRATOR_AUTHORITY_DENIED",
    "invalid dependency",
    403,
  );
  const loop = createLoop({
    ledger,
    directory: new FakeRoleDirectory({
      orchestrator: worker({
        roleId: "orchestrator",
        workerId: "employee-orchestrator",
        decide: async ({ item }) => orchestrationDecision(item),
      }),
    }),
    time,
    roleContextAssembler: {
      async assemble({ roleId, item }) {
        return contextPacket(item, roleId);
      },
    },
    orchestratorService: {
      async execute() {
        throw denied;
      },
    },
  });

  const cycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(cycle.workAttempts, 1);
  assert.deepEqual(cycle.outcomes, [{
    itemId: root.itemId,
    status: "orchestration_rejected",
    workerId: "employee-orchestrator",
    code: "ORCHESTRATOR_AUTHORITY_DENIED",
  }]);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.calls.claim.length, 0);
  assert.equal(ledger.calls.scheduleRetry.length, 0);
  assert.equal(ledger.calls.transition.length, 0);
});

test('a rejected root yields the next cycle so another root can advance', async () => {
  const time = controlledClock();
  const roots = [workItem(65, { type: 'role', id: 'orchestrator' }), workItem(66, { type: 'role', id: 'orchestrator' })];
  const ledger = new FakeLedger({ source: roots, time }); const processed = [];
  const loop = createLoop({ ledger, time,
    directory: new FakeRoleDirectory({ orchestrator: worker({ roleId: 'orchestrator', workerId: 'employee-orchestrator',
      decide: async ({ item }) => orchestrationDecision(item) }) }),
    roleContextAssembler: { async assemble({ roleId, item }) { return contextPacket(item, roleId); } },
    orchestratorService: { async execute({ item }) {
      processed.push(item.itemId);
      if (item.itemId === roots[0].itemId) throw new OrchestratorServiceError('ORCHESTRATOR_AUTHORITY_DENIED', 'invalid dependency', 403);
      return { applied: true };
    } },
  });
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  await loop.runCycle({ roleId: 'developer', workLimit: 1 });
  await loop.runCycle({ roleId: 'orchestrator', workLimit: 1 });
  assert.deepEqual(processed, roots.map(r => r.itemId));
  assert.equal(ledger.calls.claim.length, 0);
});

test("non-root orchestrator tasks never use the configured-root path", async (t) => {
  await t.test("graph-blocked child stays unclaimed", async () => {
    const time = controlledClock();
    const child = workItem(62, { type: "role", id: "orchestrator" });
    child.graph = {
      parentItemId: "work-item-root",
      dependsOnItemIds: ["work-item-unfinished-dependency"],
    };
    const ledger = new FakeLedger({ source: [child], time });
    let trustedCalls = 0;
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble() {
          trustedCalls += 1;
        },
      },
      orchestratorService: {
        async execute() {
          trustedCalls += 1;
        },
      },
    });

    const cycle = await loop.runCycle({ roleId: "orchestrator" });

    assert.equal(cycle.outcomes[0].status, "graph_blocked");
    assert.equal(ledger.calls.claim.length, 0);
    assert.equal(trustedCalls, 0);
  });

  await t.test("ready child is handled as a specialist", async () => {
    const time = controlledClock();
    const child = workItem(63, { type: "role", id: "orchestrator" });
    child.graph = {
      parentItemId: "work-item-root",
      dependsOnItemIds: [],
    };
    const ledger = new FakeLedger({ source: [child], time });
    let serviceCalls = 0;
    const loop = createLoop({
      ledger,
      directory: new FakeRoleDirectory({
        orchestrator: worker({
          roleId: "orchestrator",
          workerId: "employee-orchestrator",
          decide: async ({ item }) => orchestrationDecision(item),
        }),
      }),
      time,
      roleContextAssembler: {
        async assemble({ roleId, item }) {
          return contextPacket(item, roleId);
        },
      },
      orchestratorService: {
        async execute() {
          serviceCalls += 1;
        },
      },
    });

    const cycle = await loop.runCycle({ roleId: "orchestrator" });

    assert.equal(cycle.retried, 1);
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.calls.claim.length, 1);
    assert.equal(ledger.calls.scheduleRetry.length, 1);
    assert.equal(serviceCalls, 0);
  });
});

test("trusted loop ports are configured together and fit inside the lease", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      roleContextAssembler: { async assemble() {} },
    }),
    /configured together/,
  );
  assert.throws(
    () => createLoop({
      ledger,
      directory,
      time,
      leaseDurationMs: 2_000,
      resolveTimeoutMs: 1_000,
      decideTimeoutMs: 1_000,
      roleContextAssembler: { async assemble() {} },
      orchestratorService: { async execute() {} },
    }),
    /must fit within leaseDurationMs/,
  );
});

test("trusted loop constructor rejects accessor ports without invoking them", () => {
  const time = controlledClock();
  const ledger = new FakeLedger({ time });
  const directory = new FakeRoleDirectory();

  for (const [portName, method] of [
    ["roleContextAssembler", "assemble"],
    ["orchestratorService", "execute"],
  ]) {
    let getterCalls = 0;
    const accessorPort = {};
    Object.defineProperty(accessorPort, method, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => {};
      },
    });
    const ports = {
      roleContextAssembler: { async assemble() {} },
      orchestratorService: { async execute() {} },
      [portName]: accessorPort,
    };

    assert.throws(
      () => createLoop({ ledger, directory, time, ...ports }),
      new RegExp(`${portName} is invalid`),
    );
    assert.equal(getterCalls, 0);
  }
});
