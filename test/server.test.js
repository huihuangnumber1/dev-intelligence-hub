import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { WorkContinuationScheduler } from '../src/services/work-continuation-scheduler.js';

async function targetedContinuationChain({ holdOrdinary = false } = {}) {
  const values = new Map(), decisions = [], finished = deferred(), ordinaryStarted = deferred(), ordinaryRelease = deferred();
  let enabled = !holdOrdinary;
  const store = { async read(k, fallback) { return structuredClone(values.get(k) ?? fallback); },
    async write(k, v) { values.set(k, structuredClone(v)); } };
  const now = '2026-10-23T16:00:00.000Z';
  const items = ['first', 'continuation'].map((id, index) => ({
    itemId: `work-${id}`, kind: 'assignment', assignmentId: `assignment-${id}`, sourceSequence: index + 1,
    inputDigest: 'a'.repeat(64), assignment: { assignmentId: `assignment-${id}`, target: { type: 'role', id: 'developer' } },
    event: { eventId: `event-${id}`, eventType: 'pull_request.updated', subject: { id }, payload: {} },
    graph: { parentItemId: null, dependsOnItemIds: [], acceptanceContracts: [], deliveries: [] },
    currentTarget: { type: 'role', id: 'developer' }, activeIntentId: null, decisionContext: null,
    status: 'queued', revision: 1, ownerId: null, leaseId: null, leaseUntil: null,
    attempt: 0, availableAt: null, statusReason: null, createdAt: now, updatedAt: now,
  }));
  const ledger = { async intake() { return { received: 0 }; },
    async listItems() { return { items: structuredClone(items), nextCursor: null }; },
    async readItemForReconciliation({ itemId }) { return structuredClone(items.find(x => x.itemId === itemId) ?? null); },
    async readItemProgress(ids) { return structuredClone(items.filter(x => ids.includes(x.itemId))); },
    async claim(input) {
      const item = items.find(x => x.itemId === input.itemId);
      assert.equal(input.expectedRevision, item.revision);
      Object.assign(item, { status: 'working', revision: item.revision + 1, ownerId: input.workerId,
        leaseId: `lease-${item.itemId}`, leaseUntil: '2026-10-23T16:10:00.000Z', attempt: item.attempt + 1 });
      return structuredClone(item);
    },
    async stageIntent({ itemId }) { const item = items.find(x => x.itemId === itemId);
      Object.assign(item, { status: 'dispatch_pending', revision: item.revision + 1, ownerId: null, leaseId: null, leaseUntil: null }); },
    async scheduleRetry() { assert.fail('valid continuation must not retry its decision'); }, async transition() {},
  };
  const config = { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } };
  const scheduler = new WorkContinuationScheduler({ store,
    ledger: { ...ledger, async listClaimCandidates() { return { items: [structuredClone(items[1])],
      facts: [{ itemId: items[1].itemId, graphBlocked: false }], nextCursor: null }; } },
    configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return { enabled, paused: false }; } },
  });
  const definition = { id: 'developer', name: 'Developer', mission: 'Implement work', enabled: true, scheduleMinutes: 5 };
  const permissions = { allowedIntents: ['complete'] };
  const brain = { provider: 'local-test', model: 'target-chain', remoteData: { requirements: false, code: false, memory: false } };
  let coordination, cycleResult;
  const engine = { view() { return { definition, permissions, brain: { ...brain, remote: false } }; },
      async decide({ item }) { decisions.push(item.itemId);
        if (holdOrdinary && item.itemId === 'work-first') { ordinaryStarted.resolve(); await ordinaryRelease.promise; }
        else enabled = false;
        return { schemaVersion: 1, confidence: 100, summary: 'Done', intent: { schemaVersion: 1,
          type: 'complete', summary: 'Done', reason: 'Test complete', outcome: 'no-action', evidence: [] } }; } };
  const employee = new ConfiguredRoleEmployee({ definition, permissions, brain, taskBrain: brain, store,
    decisionEngine: engine, taskDecisionEngine: engine,
    onRun: async ({ roleId, signal, continuationTarget }) => {
      try { cycleResult = await coordination.runCycle({ roleId, signal,
        ...(continuationTarget ? { continuationTarget } : {}) }); return cycleResult;
      } finally { if (items[1].status === 'dispatch_pending' || !holdOrdinary) finished.resolve(); }
    },
  });
  const legacy = { id: 'pr-reviewer', scheduleMinutes: 0, async view() { return {}; },
    async roleView() { return { id: 'pr-reviewer', enabled: true, paused: false }; }, async run() {}, async control() {} };
  const registry = new EmployeeRegistry([legacy, employee]);
  const loop = new ProactiveWorkLoop({ ledger, clock: () => now,
    roleDirectory: new RoleWorkerDirectory({ workers: [employee.asRoleWorker()], legacyEmployeeRegistry: registry, legacyOwnedRoleIds: [] }) });
  const noOp = { async runCycle() {} };
  coordination = new WorkCoordinationService({ ledger, workLoop: loop, workLimit: 1,
    proposalResultReconciler: noOp, attentionResultReconciler: noOp, conditionWaker: noOp,
    dispatcher: { async dispatchPending() {} } });
  const timers = [];
  const background = startApplicationBackgroundWork({ config, employeeRegistry: registry,
    workContinuationScheduler: scheduler, refreshService: { async refresh() {} } },
    { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {} });
  try {
    await background.initialRefresh;
    if (holdOrdinary) {
      const ordinary = background.runEmployee('developer', { trigger: 'manual' });
      await ordinaryStarted.promise;
      enabled = true;
      await timers.find(t => t.delay === 10_000).callback();
      for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(decisions, ['work-first'], 'the target must wait rather than start a parallel role decision');
      assert.equal(scheduler.readStatus().running, 1, 'the target wake remains owned while queued');
      ordinaryRelease.resolve(); await ordinary;
    }
    await finished.promise;
    assert.deepEqual(cycleResult.stages.work.result.outcomes.map(x => ({ status: x.status, code: x.code })),
      [{ status: 'staged', code: undefined }]);
    assert.deepEqual(decisions, holdOrdinary ? ['work-first', 'work-continuation'] : ['work-continuation']);
    assert.equal(items[0].revision, holdOrdinary ? 3 : 1, 'a target wake must not spend its budget on the first ordinary candidate');
    assert.equal(items[1].status, 'dispatch_pending');
  } finally { ordinaryRelease.resolve(); enabled = false; await background.stop(); }
}

test('automatic role timer ticks use durable scheduling while manual runs and nonautomatic schedules remain available', async t => {
  for (const automatic of [true, false]) await t.test(String(automatic), async () => {
    const timers = [], decisions = [], revisions = [];
    const background = startApplicationBackgroundWork({
      config: { refreshMinutes: 7, githubActions: { enabled: true, automaticReview: automatic } },
      refreshService: { async refresh() {} },
      employeeRegistry: { schedules: () => [{ id: 'developer', intervalMinutes: 5 }],
        async runSelected(ids) { decisions.push(...ids); }, async runAll() {} },
      workContinuationScheduler: { async runCycle(options) { revisions.push(options.runtimeRevision); return { started: 0 }; } },
    }, { runtimeRevision: 'a'.repeat(64),
      setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
      clearIntervalFn() {}, reportError(error) { throw error; } });
    try {
      await background.initialRefresh;
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      decisions.length = 0;
      const wakes = revisions.length;
      await timers.find(timer => timer.delay === 5 * 60_000).callback();
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(decisions.includes('developer'), !automatic);
      if (automatic) { assert.ok(revisions.length > wakes); assert.equal(revisions.at(-1), 'a'.repeat(64)); }
      await background.runEmployee('developer', { trigger: 'manual' });
      assert.equal(decisions.includes('developer'), true);
    } finally { await background.stop(); }
  });
});

test('a durable continuation executes its exact lower-ranked item through the configured role chain', { timeout: 5_000 },
  () => targetedContinuationChain());
test('a targeted wake waits for an existing ordinary role cycle and executes afterwards without coalescing it away', { timeout: 5_000 },
  () => targetedContinuationChain({ holdOrdinary: true }));

test('the automatic configured role chain returns its exact preclaim deferral to the continuation', async () => {
  let dispatch;
  const values = new Map(), target = { itemId: 'work-stale', fingerprint: 'a'.repeat(64) };
  const employee = new ConfiguredRoleEmployee({
    definition: { id: 'orchestrator', name: 'Orchestrator', mission: 'Coordinate work', enabled: true, scheduleMinutes: 0 },
    permissions: { allowedIntents: ['complete'] },
    brain: { provider: 'local-test', model: 'test', remoteData: { requirements: false, code: false, memory: false } },
    decisionEngine: { view() { return {}; }, async decide() { assert.fail('stale facts must precede a model decision'); } },
    store: { async read(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
      async write(key, value) { values.set(key, structuredClone(value)); } },
    onRun: async ({ continuationTarget }) => {
      assert.deepEqual(continuationTarget, target);
      return { stages: { work: { ok: true, result: { scanned: 1, workAttempts: 0,
        outcomes: [{ itemId: target.itemId, status: 'decision_deferred', code: 'PR_FACTS_STALE', privateDetails: 'private material' }] } } } };
    },
  });
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { async refresh() {} },
    employeeRegistry: { schedules: () => [], async runSelected(ids, options) {
      return ids.includes('orchestrator') ? [await employee.run(options)] : [];
    } },
    workContinuationScheduler: { async runCycle(options) { dispatch = options.dispatch; return { started: 0 }; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError(error) { throw error; } });
  try {
    await background.initialRefresh;
    for (let i = 0; i < 10 && !dispatch; i++) await new Promise(resolve => setImmediate(resolve));
    const result = await dispatch({ roleId: 'orchestrator', continuationTarget: target, signal: new AbortController().signal });
    assert.deepEqual(result, { skipped: null, continuationOutcome: { ...target, status: 'decision_deferred', code: 'PR_FACTS_STALE' } });
    assert.equal(JSON.stringify(await employee.view()).includes('work-stale'), false);
    assert.equal(JSON.stringify(result).includes('private material'), false);
  } finally { await background.stop(); }
});

test('automatic continuation timeout reaches the role and keeps shutdown waiting for late work', { timeout: 5_000 }, async () => {
  const started = deferred(), cancelled = deferred(), release = deferred();
  const item = { itemId: 'work-timeout', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'developer' } };
  const config = { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true }, workCoordination: { leaseDurationMs: 1_000 } };
  let now = Date.now(), state, calls = 0;
  const scheduler = new WorkContinuationScheduler({
    store: { async read(_key, fallback) { return structuredClone(state ?? fallback); }, async write(_key, value) { state = structuredClone(value); } },
    ledger: {
      async listClaimCandidates() { return { items: [structuredClone(item)], facts: [{ itemId: item.itemId, graphBlocked: false }], nextCursor: null }; },
      async listItems() { return { items: [], nextCursor: null }; },
      async readItemForReconciliation() { return structuredClone(item); }, async readItemProgress() { return [structuredClone(item)]; },
    },
    configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return { enabled: true, paused: false }; } }, clock: () => new Date(now),
  });
  const timers = [];
  const background = startApplicationBackgroundWork({ config, workContinuationScheduler: scheduler,
    refreshService: { async refresh() {} },
    employeeRegistry: { schedules: () => [], async runSelected(ids, { signal }) {
      if (ids[0] !== 'developer') return;
      calls += 1; signal.addEventListener('abort', () => cancelled.resolve(signal.reason), { once: true });
      started.resolve(); await release.promise; signal.throwIfAborted();
    } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {}, reportError() {} });
  try {
    await started.promise; await background.initialRefresh;
    await new Promise(resolve => setImmediate(resolve)); now += 1_001;
    await timers.find(timer => timer.delay === 10_000).callback();
    assert.equal((await cancelled.promise).code, 'WORK_CONTINUATION_TIMEOUT');
    await timers.find(timer => timer.delay === 10_000).callback(); assert.equal(calls, 1);
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release.resolve(); await stopping; await background.initialRefresh;
    assert.equal(state.records[0].receipts[0].outcome, 'timed_out');
  } finally { release.resolve(); await background.stop(); }
});

test('continuation watchdog still stops owned work after fact refresh fails', { timeout: 5_000 }, async () => {
  const started = deferred(), cancelled = deferred(), release = deferred();
  const item = { itemId: 'work-timeout', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'developer' } };
  const config = { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true }, workCoordination: { leaseDurationMs: 1_000 } };
  let now = Date.now(), state, calls = 0, failRefresh = false;
  const scheduler = new WorkContinuationScheduler({
    store: { async read(_key, fallback) { return structuredClone(state ?? fallback); }, async write(_key, value) { state = structuredClone(value); } },
    ledger: {
      async listClaimCandidates() { return { items: [structuredClone(item)], facts: [{ itemId: item.itemId, graphBlocked: false }], nextCursor: null }; },
      async listItems() { return { items: [], nextCursor: null }; },
      async readItemForReconciliation() { return structuredClone(item); }, async readItemProgress() { return [structuredClone(item)]; },
    },
    configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return { enabled: true, paused: false }; } }, clock: () => new Date(now),
  });
  const timers = [];
  const background = startApplicationBackgroundWork({ config, workContinuationScheduler: scheduler,
    refreshService: { async refresh() { if (failRefresh) throw new Error('facts unavailable'); } },
    employeeRegistry: { schedules: () => [], async runSelected(ids, { signal }) {
      if (ids[0] !== 'developer') return;
      calls += 1; signal.addEventListener('abort', () => cancelled.resolve(signal.reason), { once: true });
      started.resolve(); await release.promise; signal.throwIfAborted();
    } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {}, reportError() {} });
  try {
    await started.promise; await background.initialRefresh;
    await new Promise(resolve => setImmediate(resolve));
    failRefresh = true;
    await timers.find(timer => timer.delay === 7 * 60_000).callback();
    now += 1_001;
    await timers.find(timer => timer.delay === 10_000).callback();
    assert.equal((await cancelled.promise).code, 'WORK_CONTINUATION_TIMEOUT');
    await timers.find(timer => timer.delay === 10_000).callback(); assert.equal(calls, 1);
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release.resolve(); await stopping; await background.initialRefresh;
    assert.equal(state.records[0].receipts[0].outcome, 'timed_out');
  } finally { release.resolve(); await background.stop(); }
});

test('deferred DingTalk enrichment releases facts and remains owned by shutdown', { timeout: 5_000 }, async () => {
  const started = deferred();
  let summarySignal, deferredRefresh;
  const background = startApplicationBackgroundWork({ config: { refreshMinutes: 7 },
    refreshService: {
      async refresh(options) { deferredRefresh = options.deferDingTalkSummary; },
      async summarizePendingDingTalk({ signal }) {
        summarySignal = signal; started.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
    employeeRegistry: { schedules: () => [], async runAll() {} },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  try {
    await background.initialRefresh;
    await started.promise;
    assert.equal(deferredRefresh, true);
    assert.equal(summarySignal.aborted, false);
    await background.stop();
    assert.equal(summarySignal.aborted, true);
  } finally { await background.stop(); }
});

test('shutdown removes unstarted queued manual work while still draining admitted work', { timeout: 5_000 }, async () => {
  const codeStarted = deferred(), releaseCode = deferred();
  let roleCalls = 0;
  const background = startApplicationBackgroundWork({ config: { refreshMinutes: 7 },
    refreshService: { async refresh() {} },
    workCoordination: { async runCycle() { codeStarted.resolve(); await releaseCode.promise; } },
    employeeRegistry: { schedules: () => [], async runSelected(ids) { if (ids.includes('requirements-analyst')) roleCalls += 1; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  const initial = background.initialRefresh.catch(error => error);
  try {
    await codeStarted.promise;
    const queued = background.runEmployee('requirements-analyst').catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(background.drainStatus().queuedOperationCount, 1);
    assert.equal(roleCalls, 0);
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    assert.equal((await queued).code, 'LIFECYCLE_SHUTDOWN_ABORTED');
    assert.equal(background.drainStatus().queuedOperationCount, 0);
    assert.equal(stopped, false);
    assert.equal(roleCalls, 0);
    releaseCode.resolve(); await stopping; await initial;
    assert.equal(roleCalls, 0, 'cancelled queued work must never execute later');
  } finally { releaseCode.resolve(); await background.stop(); await initial; }
});

test('automatic code execution leaves result reconciliation and fact refresh free while retaining shutdown ownership', { timeout: 5_000 }, async () => {
  const facts = deferred(), release = deferred(), timers = [];
  let refreshes = 0, reconciliations = 0, calls = 0, executions = 0, workerSignal;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { async refresh() { await facts.promise; refreshes += 1; } },
    employeeRegistry: { schedules: () => [], async runSelected() {} },
    workCoordination: { async intake() {}, async runCycle() { reconciliations += 1; } },
    codeJobExecution: { async runCycle({ signal }, runOperation) {
      calls += 1;
      if (executions === 0) {
        executions += 1;
        runOperation(async () => { workerSignal = signal; await release.promise; signal.throwIfAborted(); }).catch(() => {});
      }
      return { scheduled: executions };
    } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {}, reportError() {} });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0, 'execution needs admitted facts');
    facts.resolve(); await background.initialRefresh; await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 1);
    const tick = timers.find(timer => timer.delay === 10_000);
    const beforePolls = calls;
    await tick.callback(); await tick.callback(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls > beforePolls, 'short admission polls must continue while a model runs');
    assert.equal(executions, 1, 'continued polling must not duplicate the owned execution');
    await timers.find(timer => timer.delay === 7 * 60_000).callback();
    assert.equal(refreshes, 2); assert.equal(reconciliations, 2, 'fresh results can reconcile before the model returns');
    assert.ok(background.drainStatus().activeParticipants.some(participant => participant.id === DRAIN_PARTICIPANTS.codeJobExecution.id));
    const beforeStop = calls;
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(workerSignal.aborted, true); assert.equal(stopped, false);
    release.resolve(); await stopping; await tick.callback(); assert.equal(calls, beforeStop);
  } finally { facts.resolve(); release.resolve(); await background.initialRefresh; await background.stop(); }
});

for (const slowStage of ['legacy-review', 'housekeeping', 'memory-projection']) test(`automatic fact refresh remains free while ${slowStage} owns late work`, { timeout: 5_000 }, async () => {
  const started = deferred(), release = deferred(), timers = [];
  let refreshes = 0, reviews = 0, requirements = 0, initialSettled = false;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { async refresh() { refreshes += 1; } },
    workCoordination: { async intake() {}, async runCycle() {
      if (slowStage === 'housekeeping') { started.resolve(); await release.promise; }
    } },
    memoryProjector: { async runCycle() {
      if (slowStage === 'memory-projection') { started.resolve(); await release.promise; }
    } },
    employeeRegistry: { schedules: () => [{ id: 'requirements-analyst', intervalMinutes: 1 }, { id: 'pr-reviewer', intervalMinutes: 2 }],
      async runSelected(ids) {
        if (ids.includes('requirements-analyst')) requirements += 1;
        if (ids.includes('pr-reviewer')) {
          reviews += 1;
          if (slowStage === 'legacy-review') { started.resolve(); await release.promise; }
        }
      } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {}, reportError() {} });
  const initial = background.initialRefresh.then(() => { initialSettled = true; }, error => {
    if (error.code !== 'LIFECYCLE_SHUTDOWN_ABORTED') throw error;
  });
  try {
    await started.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(initialSettled, true, 'fresh facts must finish independently of model and projection work');
    await timers.find(timer => timer.delay === 60_000).callback(); assert.equal(requirements, 1);
    const duplicateReview = timers.find(timer => timer.delay === 120_000).callback();
    if (slowStage !== 'legacy-review') await duplicateReview;
    await timers.find(timer => timer.delay === 7 * 60_000).callback(); assert.equal(refreshes, 2);
    if (slowStage === 'legacy-review') assert.equal(reviews, 1, 'refresh and scheduled legacy patrol must coalesce');
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release.resolve(); await stopping; await initial; await duplicateReview;
  } finally { release.resolve(); await background.stop(); await initial; }
});

test('a continuation cancelled while waiting for fresh facts settles before the refresh and never runs later', async () => {
  const refreshing = deferred(), releaseRefresh = deferred(), controller = new AbortController();
  let refreshes = 0, dispatch, requirements = 0;
  const timeout = Object.assign(new Error('continuation expired'), { code: 'WORK_CONTINUATION_TIMEOUT' });
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { async refresh() { if (++refreshes > 1) { refreshing.resolve(); await releaseRefresh.promise; } } },
    employeeRegistry: { schedules: () => [], async runSelected(ids) { if (ids.includes('requirements-analyst')) requirements += 1; } },
    workContinuationScheduler: { async runCycle(options) { dispatch = options.dispatch; return { started: 0 }; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  try {
    await background.initialRefresh;
    await new Promise(resolve => setImmediate(resolve));
    const refresh = background.refresh({ notify: true }); await refreshing.promise;
    let settled = false;
    const waiting = dispatch({ roleId: 'requirements-analyst', signal: controller.signal }).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    controller.abort(timeout);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, true);
    assert.deepEqual(await waiting, { skipped: 'continuation_timeout' });
    assert.equal(requirements, 0);
    releaseRefresh.resolve(); await refresh;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(requirements, 0);
  } finally { releaseRefresh.resolve(); await background.stop(); }
});

test('an automatic general fact waiter does not occupy operational admission and stops before the active refresh', async () => {
  const gate = new OperationalQuiescenceGate(), refreshing = deferred(), release = deferred();
  let work = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    operations: { admission: { run: gate.run.bind(gate) } },
    refreshService: { async refresh() { refreshing.resolve(); await release.promise; } },
    employeeRegistry: { schedules: () => [], async runSelected() { work += 1; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  const initial = background.initialRefresh.catch(error => error);
  try {
    await refreshing.promise;
    assert.equal(gate.readStatus().activeOperations, 1, 'the admitted fact read owns one lease');
    let settled = false;
    const waiting = background.signalAgency({ trigger: 'waiting-for-facts' }).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(gate.readStatus().activeOperations, 1, 'unstarted general work must not own another lease');
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, true); assert.equal(stopped, false);
    await waiting; assert.equal(work, 0);
    release.resolve(); await stopping; await initial;
    assert.equal(gate.readStatus().activeOperations, 0);
  } finally { release.resolve(); await background.stop(); await initial; }
});

test('automatic local proposal retries run during long code work and remain in lifecycle drain', { timeout: 5_000 }, async () => {
  const refreshed = deferred(), codeStarted = deferred(), releaseCode = deferred();
  const retried = deferred(), releaseRetry = deferred(); const timers = []; let polls = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { async refresh() { await refreshed.promise; } },
    employeeRegistry: { schedules: () => [], async runSelected() {} },
    workCoordination: { async intake() {}, async runCycle() { codeStarted.resolve(); await releaseCode.promise; } },
    localCodeProposalRecovery: { async runCycle() { polls += 1; if (polls > 1) { retried.resolve(); await releaseRetry.promise; } } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {} });
  const initial = background.initialRefresh.catch(error => {
    if (error.code !== 'LIFECYCLE_SHUTDOWN_ABORTED') throw error;
  });
  try {
    const tick = timers.find(t => t.delay === 10_000);
    await tick.callback(); assert.equal(polls, 0, 'fresh facts are required');
    refreshed.resolve(); await codeStarted.promise;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(polls, 1);
    await tick.callback(); await retried.promise;
    await tick.callback(); assert.equal(polls, 2, 'duplicate ticks coalesce');
    assert.ok(background.drainStatus().activeParticipants.some(p => p.id === DRAIN_PARTICIPANTS.localCodeProposalRecovery.id));
    let stopped = false; const stopping = background.stop().then(() => { stopped = true; });
    releaseCode.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    releaseRetry.resolve(); await stopping; await initial;
    await tick.callback(); assert.equal(polls, 2);
  } finally { refreshed.resolve(); releaseCode.resolve(); releaseRetry.resolve(); await background.stop(); }
});

for (const port of ['localCodeProposalRecovery', 'codeJobExecution']) test(`a first ${port} tick cannot enter closed maintenance admission`, async () => {
  const gate = new OperationalQuiescenceGate(); const timers = []; let polls = 0; let token;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    operations: { admission: { run: gate.run.bind(gate) } },
    refreshService: { async refresh() {} }, employeeRegistry: { schedules: () => [], async runSelected() {} },
    [port]: { async runCycle() { polls += 1; } },
  }, { reportError() {}, setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {} });
  try {
    await background.initialRefresh; await new Promise(resolve => setImmediate(resolve));
    const before = polls; const tick = timers.find(t => t.delay === 10_000);
    token = await gate.enter();
    await tick.callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, before);
    gate.leave(token); token = null;
    await tick.callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, before + 1);
  } finally { if (token) gate.leave(token); await background.stop(); }
});

for (const port of ['localCodeProposalRecovery', 'codeJobExecution']) test(`manual mode does not poll the automatic ${port} port`, async () => {
  const timers = []; let polls = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: false } },
    refreshService: { async refresh() {} }, employeeRegistry: { schedules: () => [], async runSelected() {} },
    [port]: { async runCycle() { polls += 1; } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {} });
  try { await background.initialRefresh; await timers.find(t => t.delay === 10_000).callback(); assert.equal(polls, 0); }
  finally { await background.stop(); }
});

test('durable continuations start automatically after fresh intake and hand off without a role timer', { timeout: 5_000 }, async () => {
  const refresh = deferred();
  const developerStarted = deferred();
  const releaseDeveloper = deferred();
  const testerStarted = deferred();
  const releaseTester = deferred();
  const item = { itemId: 'work-continuation', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'developer' } };
  let persisted;
  let factRead = false;
  const roles = [];
  const config = { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } };
  const scheduler = new WorkContinuationScheduler({
    store: { async read(_key, fallback) { return structuredClone(persisted ?? fallback); }, async write(_key, state) { persisted = structuredClone(state); } },
    ledger: {
      async listClaimCandidates() { assert.equal(factRead, true); return { items: [structuredClone(item)], facts: [{ itemId: item.itemId, graphBlocked: false }], nextCursor: null }; },
      async listItems() { return { items: [], nextCursor: null }; },
      async readItemForReconciliation() { return structuredClone(item); },
      async readItemProgress() { return [structuredClone(item)]; },
    },
    configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return { enabled: true, paused: false }; } },
  });
  const timers = [];
  const background = startApplicationBackgroundWork({ config, workContinuationScheduler: scheduler,
    refreshService: { async refresh() { await refresh.promise; factRead = true; } },
    employeeRegistry: { schedules: () => [], async runSelected(ids) {
      const role = ids[0]; if (!['developer', 'tester'].includes(role)) return;
      roles.push(role);
      if (role === 'developer') { developerStarted.resolve(); await releaseDeveloper.promise; item.currentTarget.id = 'tester'; item.revision += 1; }
      if (role === 'tester') { testerStarted.resolve(); await releaseTester.promise; item.revision += 1; }
    } },
  }, { setIntervalFn(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearIntervalFn() {} });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(persisted, undefined);
    refresh.resolve(); await developerStarted.promise;
    assert.equal(persisted.records[0].status, 'running');
    const tick = timers.find(timer => timer.delay === 10_000);
    await tick.callback(); assert.deepEqual(roles, ['developer']);
    releaseDeveloper.resolve(); await testerStarted.promise;
    assert.deepEqual(roles, ['developer', 'tester']);
    assert.ok(background.drainStatus().activeParticipants.some(({ id }) => id === DRAIN_PARTICIPANTS.workContinuation.id));
    let stopped = false;
    const stopping = background.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    releaseTester.resolve(); await stopping; await background.initialRefresh;
    assert.notEqual(persisted.records[0].status, 'running', 'the durable acknowledgement must be included in shutdown drain');
  } finally { refresh.resolve(); releaseDeveloper.resolve(); releaseTester.resolve(); await background.stop(); }
});
import { createApplication } from "../src/composition-root.js";
import {
  createDashboardServer,
  DRAIN_PARTICIPANTS,
  startApplicationBackgroundWork,
  startDashboardServer,
} from "../src/server.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";
import { ConfiguredRoleEmployee } from "../src/services/configured-role-employee.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { RoleWorkerDirectory } from "../src/services/role-worker-directory.js";
import { WorkCoordinationService } from "../src/services/work-coordination-service.js";
import { createWorkProposalRunnerGroup } from "../src/services/work-proposal-runner-group.js";
import { ReviewHandoffReconciler } from "../src/services/review-handoff-reconciler.js";
import { createGitHubActionExecutor } from "../src/adapters/github-action-adapter.js";
import { githubCredentialSourceError } from "../src/lib/github-credential-source.js";
import { ManagedProcessError } from "../src/lib/managed-process.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { createSafeDisabledConfiguration } from "../src/lib/config.js";
import { ConfigurationStore } from "../src/services/configuration-store.js";
import {
  OperationalQuiescenceGate,
} from "../src/services/operational-quiescence-gate.js";
import { ProcessExclusiveGuard } from "../src/lib/process-exclusive-guard.js";
import { runCommand } from "../src/lib/command-runner.js";
import { normalizeOwnerWorkRequest } from "../src/domain/owner-work-request.js";

const safeEditableConfiguration = createSafeDisabledConfiguration(
  JSON.parse(
    readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
  ),
);

function request(server, {
  method = "GET",
  path = "/",
  headers = {},
  body = "",
} = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: "127.0.0.1:4173",
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: rawBody.toString("utf8"),
            rawBody,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
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

function operationalApplication({
  refresh = async () => ({ dashboard: {} }),
  createBackup = async () => ({
    backupId: `backup-${"a".repeat(64)}`,
    createdAt: "2026-08-08T01:02:03.004Z",
    checkpointId: `backup-checkpoint-${"b".repeat(64)}`,
    fileCount: 3,
    totalBytes: 1024,
  }),
} = {}) {
  const gate = new OperationalQuiescenceGate();
  const status = async () => ({
    schemaVersion: 1,
    liveness: { schemaVersion: 1, live: true },
    readiness: {
      schemaVersion: 1,
      checkedAt: "2026-08-08T01:02:03.004Z",
      ready: true,
      recoveryBlockers: [],
      unknownExternalActions: [],
      capacityWarnings: [],
      probeFailures: [],
      probeSummary: { total: 3, succeeded: 3, failed: 0, timedOut: 0 },
    },
    maintenance: gate.readStatus(),
    backups: {
      available: true,
      items: [],
      incompleteCount: 0,
      unrecognizedCount: 0,
    },
  });
  const application = {
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: false },
    },
    store: { async read() { return null; } },
    refreshService: { running: null, refresh },
    operations: {
      admission: { run: gate.run.bind(gate) },
      browser: {
        readStatus: status,
        async createBackup() {
          const token = await gate.enter();
          try {
            return await createBackup();
          } finally {
            gate.leave(token);
          }
        },
      },
    },
  };
  return { application, gate, status };
}

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function requestPort(port, options = {}) {
  const target = {
    address() {
      return { port };
    },
  };
  return request(target, {
    ...options,
    headers: {
      host: `127.0.0.1:${port}`,
      ...(options.headers || {}),
    },
  });
}

async function waitForPort(port, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await requestPort(port, options);
    } catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function pendingConfirmationItem() {
  return {
    id: "confirmation-pr-work-startup",
    kind: "github.pull-request-review",
    status: "pending",
    queueRevision: 8,
    itemRevision: 2,
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: "pr-work-startup",
    },
    actor: { provider: "github", accountId: "review-account" },
    target: {
      provider: "github",
      resourceId: "acme/repo#42",
      version: "a".repeat(40),
    },
    display: {
      title: "acme/repo #42 · Checkout",
      summary: "旧确认必须先与首次 GitHub 刷新对账",
      actionLabel: "确认并发布到 GitHub",
      evidence: ["Head 已复核"],
      payload: {
        actor: { provider: "github", accountId: "review-account" },
        target: {
          provider: "github",
          resourceId: "acme/repo#42",
          version: "a".repeat(40),
        },
        action: {
          type: "pull_request_review",
          reviewEvent: "APPROVE",
          body: "Looks good.",
        },
      },
    },
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "c".repeat(64),
    retryable: false,
  };
}

function healthyRefreshResult() {
  return {
    dashboard: {
      sourceStatus: { githubPullRequests: { ok: true } },
      items: [],
    },
  };
}

function startupApplication({
  port = 0,
  refresh,
  runAll,
  recoverConfirmations = async () => {},
  close = async () => {},
  queueCalls = [],
} = {}) {
  const item = pendingConfirmationItem();
  let snapshot = null;
  const performRefresh = refresh || (async () => healthyRefreshResult());
  const employee = {
    id: "pr-reviewer",
    async recordConfirmationOutcome() {},
    recoverConfirmations,
  };
  return {
    config: {
      port,
      refreshMinutes: 10,
      githubActions: { enabled: true },
    },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      running: null,
      async refresh(options) {
        const result = await performRefresh(options);
        snapshot = structuredClone(result?.dashboard || null);
        return result;
      },
    },
    employeeRegistry: {
      get(id) {
        return id === employee.id ? employee : null;
      },
      async listRoles() {
        return [];
      },
      async view() {
        return {};
      },
      schedules() {
        return [];
      },
      runAll: runAll || (async () => {}),
    },
    confirmationQueue: {
      async next() {
        queueCalls.push("next");
        return {
          queueRevision: 8,
          pendingCount: 1,
          item: structuredClone(item),
        };
      },
      async approve() {
        queueCalls.push("approve");
        return { ...structuredClone(item), status: "completed" };
      },
      async retry() {
        queueCalls.push("retry");
        return { ...structuredClone(item), status: "completed" };
      },
      async reject() {
        queueCalls.push("reject");
        return { ...structuredClone(item), status: "rejected" };
      },
      async get() {
        queueCalls.push("get");
        return structuredClone(item);
      },
      historyReader: {
        async list() {
          queueCalls.push("history");
          return {
            queueRevision: 8,
            filters: {},
            limit: 20,
            roleIdFacets: [],
            items: [],
            nextCursor: null,
          };
        },
      },
    },
    close,
  };
}

function safeConfigurationApplication() {
  const calls = [];
  const runtimeConfiguration = structuredClone(safeEditableConfiguration);
  let snapshot = {
    revision: 0,
    activeVersion: null,
    migration: {
      status: "pending",
      importedAt: null,
      importedBy: null,
      sourceDigest: null,
    },
    versions: [],
    draftRevisions: [],
    draftHeads: [],
    audit: [],
    projectionOutbox: [],
  };

  const fail = (statusCode, message) => {
    throw Object.assign(new Error(message), { statusCode });
  };
  const copy = (value) => structuredClone(value);
  const headDrafts = () => {
    const ids = new Set(snapshot.draftHeads.map((head) => head.draftRevisionId));
    return snapshot.draftRevisions.filter((draft) => ids.has(draft.draftRevisionId));
  };
  const requireDraft = (draftId, revision) => {
    const draft = snapshot.draftRevisions.find(
      (candidate) =>
        candidate.draftId === draftId && candidate.revision === revision,
    );
    if (!draft) fail(404, "配置草稿修订不存在");
    return draft;
  };
  const draftRecord = ({
    draftId,
    revision,
    configuration,
    proposedBy,
    supersedesRevisionId,
  }) => ({
    draftRevisionId: `configuration-draft-revision-${draftId}-${revision}`,
    contentDigest: `${revision}`.padStart(64, "a").slice(-64),
    draftId,
    revision,
    baseVersion: 0,
    configurationDigest: `${revision}`.padStart(64, "b").slice(-64),
    configuration: copy(configuration),
    proposedBy,
    createdAt: `2026-08-05T0${revision}:00:00.000Z`,
    supersedesRevisionId,
  });

  const draftManager = {
    async createInitializationDraft(input) {
      calls.push({ operation: "configuration_create", input: copy(input) });
      if (snapshot.activeVersion !== null) fail(409, "版本化配置已经完成初始化");
      const draft = draftRecord({
        draftId: "initial-draft",
        revision: 1,
        configuration: input.configuration,
        proposedBy: input.proposedBy,
        supersedesRevisionId: null,
      });
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        draftRevisions: [...snapshot.draftRevisions, draft],
        draftHeads: [
          ...snapshot.draftHeads,
          {
            draftId: draft.draftId,
            revision: draft.revision,
            draftRevisionId: draft.draftRevisionId,
          },
        ],
      };
      return copy(draft);
    },
    async reviseDraft(input) {
      calls.push({ operation: "configuration_revise", input: copy(input) });
      const headIndex = snapshot.draftHeads.findIndex(
        (candidate) => candidate.draftId === input.draftId,
      );
      const head = snapshot.draftHeads[headIndex];
      if (!head) fail(404, "配置草稿不存在");
      if (head.revision !== input.expectedDraftRevision) {
        fail(409, "配置草稿已有新修订");
      }
      const previous = requireDraft(head.draftId, head.revision);
      const draft = draftRecord({
        draftId: head.draftId,
        revision: head.revision + 1,
        configuration: input.configuration,
        proposedBy: input.proposedBy,
        supersedesRevisionId: previous.draftRevisionId,
      });
      const draftHeads = [...snapshot.draftHeads];
      draftHeads[headIndex] = {
        draftId: draft.draftId,
        revision: draft.revision,
        draftRevisionId: draft.draftRevisionId,
      };
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        draftRevisions: [...snapshot.draftRevisions, draft],
        draftHeads,
      };
      return copy(draft);
    },
  };

  const initializationItem = {
    id: "confirmation-configuration-initialization",
    kind: "local.configuration-activate",
    status: "pending",
    queueRevision: 12,
    itemRevision: 1,
    requestedBy: {
      roleId: "configuration-owner",
      workItemId: "configuration-initial-draft",
    },
    actor: { provider: "local-configuration", accountId: "owner:local" },
    target: {
      provider: "local-configuration",
      resourceId: "active-configuration",
      version: "c".repeat(64),
    },
    action: {
      type: "initialize_from_draft",
      validationDigest: "d".repeat(64),
    },
    display: {
      title: "初始化版本化配置",
      summary: "从已保存草稿初始化活动配置。",
      actionLabel: "确认初始化",
      evidence: [],
      payload: {
        actor: { provider: "local-configuration", accountId: "owner:local" },
        target: {
          provider: "local-configuration",
          resourceId: "active-configuration",
          version: "c".repeat(64),
        },
        action: {
          type: "initialize_from_draft",
          validationDigest: "d".repeat(64),
        },
      },
    },
    displayedPayloadDigest: "e".repeat(64),
    approvalBindingDigest: "f".repeat(64),
    retryable: false,
  };
  const githubItem = {
    ...copy(initializationItem),
    id: "confirmation-unrelated-github",
    kind: "github.pull-request-review",
    action: { type: "pull_request_review" },
  };
  const rollbackItem = {
    ...copy(initializationItem),
    id: "confirmation-configuration-rollback",
    action: { type: "activate_rollback" },
    display: {
      ...copy(initializationItem.display),
      payload: {
        ...copy(initializationItem.display.payload),
        action: { type: "activate_rollback" },
      },
    },
  };
  const items = new Map(
    [githubItem, rollbackItem, initializationItem].map((item) => [item.id, item]),
  );
  const publicItem = (item) => {
    if (!item) return null;
    const projected = copy(item);
    delete projected.action;
    return projected;
  };
  const nextInitialization = () => {
    const item = items.get(initializationItem.id);
    const pending = item.status === "pending" || item.retryable ? [item] : [];
    return {
      queueRevision: 12,
      pendingCount: pending.length,
      item: publicItem(pending[0] || null),
    };
  };
  const completeInitialization = () => {
    const head = snapshot.draftHeads[0];
    const draft = head && requireDraft(head.draftId, head.revision);
    if (!draft) fail(409, "初始化草稿不存在");
    const active = {
      configurationVersionId: "configuration-version-initialized",
      contentDigest: "1".repeat(64),
      version: 1,
      configurationDigest: draft.configurationDigest,
      configuration: copy(draft.configuration),
      source: "initialization",
      previousVersion: null,
      draftRevisionId: draft.draftRevisionId,
      rollbackOf: null,
      activatedBy: "owner:local",
      activatedAt: "2026-08-05T08:00:00.000Z",
      impactDigest: "2".repeat(64),
    };
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      activeVersion: 1,
      versions: [active],
    };
  };
  const confirmationQueue = {
    async next() {
      calls.push({ operation: "unsafe_confirmation_next" });
      throw new Error("safe mode must use an action-scoped query");
    },
    async nextForAction(kind, actionType, options) {
      calls.push({
        operation: "configuration_confirmation_next",
        kind,
        actionType,
        options: copy(options),
      });
      return copy(nextInitialization());
    },
    async get(id) {
      calls.push({ operation: "configuration_confirmation_get", id });
      const item = items.get(id);
      if (!item) fail(404, "确认项不存在");
      return publicItem(item);
    },
    async approve(id, input) {
      calls.push({ operation: "configuration_confirmation_approve", id, input: copy(input) });
      const item = items.get(id);
      item.status = "completed";
      completeInitialization();
      return publicItem(item);
    },
    async retry(id, input) {
      calls.push({ operation: "configuration_confirmation_retry", id, input: copy(input) });
      return publicItem(items.get(id));
    },
    async reject(id, input) {
      calls.push({ operation: "configuration_confirmation_reject", id, input: copy(input) });
      const item = items.get(id);
      item.status = "rejected";
      return publicItem(item);
    },
  };

  const reader = {
    async readSnapshot() {
      calls.push({ operation: "configuration_snapshot" });
      return copy(snapshot);
    },
    async readAuthoritySnapshot() {
      calls.push({ operation: "configuration_authority_snapshot" });
      const active = snapshot.versions.find(
        ({ version }) => version === snapshot.activeVersion,
      );
      return copy({
        revision: snapshot.revision,
        activeVersion: snapshot.activeVersion,
        versions: active
          ? [{
              version: active.version,
              configurationDigest: active.configurationDigest,
            }]
          : [],
        draftHeads: snapshot.draftHeads,
        draftRevisions: headDrafts().map((draft) => ({
          draftId: draft.draftId,
          draftRevisionId: draft.draftRevisionId,
          baseVersion: draft.baseVersion,
        })),
      });
    },
    async readControlPlaneSnapshot({ versionLimit, auditLimit }) {
      calls.push({ operation: "configuration_control_plane_snapshot" });
      const drafts = headDrafts();
      const editableDraft = drafts.findLast(
        (draft) => draft.baseVersion === (snapshot.activeVersion ?? 0),
      );
      const active = snapshot.versions.find(
        ({ version }) => version === snapshot.activeVersion,
      );
      return copy({
        revision: snapshot.revision,
        activeVersion: snapshot.activeVersion,
        versions: snapshot.versions.slice(-versionLimit).map((version) => ({
          version: version.version,
          configurationDigest: version.configurationDigest,
          source: version.source,
          previousVersion: version.previousVersion,
          draftRevisionId: version.draftRevisionId,
          rollbackOf: version.rollbackOf,
          activatedAt: version.activatedAt,
          impactDigest: version.impactDigest,
        })),
        draftRevisions: drafts.map((draft) => ({
          draftId: draft.draftId,
          draftRevisionId: draft.draftRevisionId,
          revision: draft.revision,
          baseVersion: draft.baseVersion,
          configurationDigest: draft.configurationDigest,
          createdAt: draft.createdAt,
        })),
        audit: snapshot.audit.slice(-auditLimit).map((entry) => ({
          sequence: entry.sequence,
          stateRevision: entry.stateRevision,
          kind: entry.kind,
          actor: entry.actor,
          occurredAt: entry.occurredAt,
          draftId: entry.draftId,
          configurationVersion: entry.configurationVersion,
          targetVersion: entry.targetVersion,
          impactDigest: entry.impactDigest,
        })),
        editableConfiguration:
          editableDraft?.configuration ?? active?.configuration ?? null,
        history: {
          totalVersions: snapshot.versions.length,
          totalAuditEntries: snapshot.audit.length,
          versionsTruncated: snapshot.versions.length > versionLimit,
          auditTruncated: snapshot.audit.length > auditLimit,
        },
      });
    },
    async readActive() {
      return copy(
        snapshot.versions.find(({ version }) => version === snapshot.activeVersion) || null,
      );
    },
    async readVersion({ version }) {
      const entry = snapshot.versions.find((candidate) => candidate.version === version);
      if (!entry) fail(404, "配置版本不存在");
      return copy(entry);
    },
    async readDraft({ draftId, revision }) {
      calls.push({ operation: "configuration_draft_read", draftId, revision });
      return copy(requireDraft(draftId, revision));
    },
    async readProjectionBatch() {
      return { highWatermark: 0, nextSequence: 0, items: [] };
    },
  };
  const simulator = {
    async prepareInitialization(input) {
      calls.push({ operation: "configuration_preview", input: copy(input) });
      return {
        kind: "configuration.initialize",
        ...copy(input),
        expectedActiveVersion: null,
        activeDigest: null,
        baselineDigest: "6".repeat(64),
        draftRevisionId: `configuration-draft-revision-${input.draftId}-${input.draftRevision}`,
        documentDigest: "3".repeat(64),
        validationDigest: "4".repeat(64),
        impactDigest: "5".repeat(64),
        impact: {
          changed: true,
          beforeDigest: "6".repeat(64),
          afterDigest: "3".repeat(64),
          security_tightening: [],
          authority_expansion: ["githubActions.enabled"],
          benign_claim_change: ["refreshMinutes"],
          restart_required: ["githubActions.enabled"],
        },
      };
    },
  };
  const confirmationRequester = {
    async requestInitialization(input) {
      calls.push({
        operation: "configuration_request_confirmation",
        input: copy(input),
      });
      return publicItem(initializationItem);
    },
  };
  const application = {
    config: runtimeConfiguration,
    configuration: {
      status: {
        safeMode: true,
        activeVersion: null,
        stateRevision: 0,
        migrationError: { code: "CONFIG_LOCAL_INVALID", message: "测试迁移失败" },
      },
      reader,
      draftManager,
      simulator,
      confirmationRequester,
    },
    confirmationQueue,
    store: { async read() { return null; } },
    refreshService: { running: null, async refresh() { fail(503, "safe mode"); } },
  };
  return { application, calls, getSnapshot: () => copy(snapshot), items };
}

async function withSafeConfigurationServer(run) {
  const fixture = safeConfigurationApplication();
  const backgroundWork = startApplicationBackgroundWork(fixture.application);
  const reportedErrors = [];
  const server = createDashboardServer(fixture.application, {
    backgroundWork,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ ...fixture, server, backgroundWork, reportedErrors });
  } finally {
    await server.shutdown();
  }
}

async function activeConfigurationApplication() {
  let durableState = null;
  const durableStore = {
    async read(_name, fallback = null) {
      return structuredClone(durableState ?? fallback);
    },
    async write(_name, value) {
      durableState = structuredClone(value);
    },
  };
  const configurationStore = new ConfigurationStore({
    store: durableStore,
    exclusiveLease: { run: (operation) => operation() },
    clock: (() => {
      let offset = 0;
      return () => new Date(Date.parse("2026-08-05T10:00:00.000Z") + offset++ * 1000);
    })(),
    idFactory: () => "active-draft",
  });
  await configurationStore.recover();
  await configurationStore.importBootstrap({
    configuration: safeEditableConfiguration,
    importedBy: "bootstrap-file",
  });

  const calls = [];
  const application = {
    config: structuredClone(safeEditableConfiguration),
    configuration: {
      status: {
        safeMode: false,
        activeVersion: 1,
        stateRevision: 1,
        migrationError: null,
      },
      reader: configurationStore,
      draftManager: configurationStore,
      simulator: configurationStore,
      confirmationRequester: {
        async requestDraftActivation(input) {
          calls.push({
            operation: "configuration_request_activation",
            input: structuredClone(input),
          });
          return { id: "confirmation-configuration-activation" };
        },
        async requestRollback(input) {
          calls.push({
            operation: "configuration_request_rollback",
            input: structuredClone(input),
          });
          return { id: "confirmation-configuration-rollback" };
        },
      },
    },
    store: durableStore,
    refreshService: { running: null, async refresh() {} },
  };
  return { application, calls, configurationStore };
}

async function withActiveConfigurationServer(run) {
  const fixture = await activeConfigurationApplication();
  const reportedErrors = [];
  const server = createDashboardServer(fixture.application, {
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ ...fixture, server, reportedErrors });
  } finally {
    await server.shutdown();
  }
}

function trustedConfigurationHeaders() {
  return {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
}

function confirmationApprovalRequest() {
  return {
    requestId: "request-startup-gate-0001",
    expectedQueueRevision: 8,
    expectedItemRevision: 2,
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "c".repeat(64),
  };
}

async function exerciseConfirmationRefreshGate(trigger) {
  const queueCalls = [];
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const reconcileStarted = deferred();
  const releaseReconcile = deferred();
  let refreshCalls = 0;
  let reconcileCalls = 0;
  const application = startupApplication({
    port: 4173,
    queueCalls,
    async refresh() {
      refreshCalls += 1;
      if (refreshCalls === 1) return healthyRefreshResult();
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return healthyRefreshResult();
    },
    async runAll() {
      reconcileCalls += 1;
      if (reconcileCalls === 1) return;
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    },
  });
  const timers = [];
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;
  const server = createDashboardServer(application, {
    backgroundWork,
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let cycle = null;

  try {
    const initiallyOpen = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(initiallyOpen.status, 200);
    queueCalls.length = 0;

    cycle =
      trigger === "periodic"
        ? timers[0].callback()
        : request(server, {
            method: "POST",
            path: "/api/refresh",
            headers: {
              origin: "http://127.0.0.1:4173",
              "x-mydashboard-action": "1",
            },
          });
    await refreshStarted.promise;

    const nextDuringRefresh = await request(server, {
      path: "/api/confirmations/next",
    });
    const attentionDuringRefresh = await request(server, {
      path: "/api/attention/next",
    });
    const historyDuringRefresh = await request(server, {
      path: "/api/confirmations/history",
    });
    const itemDuringRefresh = await request(server, {
      path: `/api/confirmations/${pendingConfirmationItem().id}`,
    });
    const approveDuringRefresh = await request(server, {
      method: "POST",
      path: `/api/confirmations/${pendingConfirmationItem().id}/approve`,
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(confirmationApprovalRequest()),
    });
    const internalAnswerDuringRefresh = await request(server, {
      method: "POST",
      path: `/api/attention/internal/attention-${"a".repeat(64)}/later`,
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(nextDuringRefresh.status, 200);
    assert.equal(attentionDuringRefresh.status, 200);
    assert.equal(historyDuringRefresh.status, 200);
    assert.equal(itemDuringRefresh.status, 200);
    assert.equal(approveDuringRefresh.status, 503);
    assert.equal(internalAnswerDuringRefresh.status, 503);
    assert.deepEqual(queueCalls, ["next", "next", "history", "get"]);
    queueCalls.length = 0;

    releaseRefresh.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 2);
    await reconcileStarted.promise;
    const nextDuringAgency = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(nextDuringAgency.status, 200);
    assert.deepEqual(queueCalls, ["next"]);

    releaseReconcile.resolve();
    const cycleResult = await cycle;
    if (trigger === "manual") assert.equal(cycleResult.status, 200);
    const reopened = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(queueCalls, ["next", "next"]);
  } finally {
    releaseRefresh.resolve();
    releaseReconcile.resolve();
    await Promise.resolve(cycle).catch(() => {});
    await server.shutdown();
  }
}

async function withServer(
  run,
  {
    legacyOnly = false,
    confirmationQueueEnabled = true,
    onClose,
    onDashboardRead,
    backgroundWork,
    workflowRouting,
    workLedgerView,
    dailyWorkLedgerView,
    workGraphView,
    ownerWorkRequests,
    ownerWorkRetry,
    attentionCoordinator,
    attentionBrowser,
    memorySearch,
    memoryAnswer,
    memoryImports,
    codeJobReader,
    codeJobControl,
    taskRuns,
    changePackageReader,
    changePackageApplicationRequester,
    changePackageApplicationStatusReader,
    codeJobEvidenceReader,
    jenkinsConnection,
    runtimeSourceIdentity,
    onRecordConfirmationOutcome,
  } = {},
) {
  const calls = [];
  const reportedErrors = [];
  const dashboard = {
    meta: { refreshedAt: "2026-07-31T09:00:00.000Z" },
    secretMarker: "private-dashboard-data",
  };
  const prEmployee = {
    id: "pr-reviewer",
    running: null,
    async view() {
      return {
        role: {
          id: "pr-reviewer",
          name: "PR 推进员工",
          state: "observing",
          revision: 4,
          paused: true,
          enabled: true,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "employee_tick", ...options });
      return this.view();
    },
    async tick(options) {
      return this.run(options);
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "employee_control", command, expectedRevision });
      return this.view();
    },
    async decide(id, decision, options) {
      calls.push({ operation: "employee_decide", id, decision, ...options });
      return this.view();
    },
    async resolveBlockedJob(id, action, options) {
      calls.push({
        operation: "employee_resolve_blocked",
        id,
        action,
        ...options,
      });
      return this.view();
    },
    async searchMemory(query, limit) {
      calls.push({ operation: "memory_search", query, limit });
      return [{ id: "memory-1", title: "Checkout review" }];
    },
    async recordConfirmationOutcome(item) {
      calls.push({ operation: "employee_confirmation_outcome", item });
      if (onRecordConfirmationOutcome) {
        return onRecordConfirmationOutcome(item);
      }
    },
  };
  const requirementsAnalyst = {
    id: "requirements-analyst",
    async view() {
      return {
        role: {
          id: this.id,
          name: "需求分析员工",
          state: "observing",
          revision: 2,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "analyst_tick", ...options });
      return this.view();
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "analyst_control", command, expectedRevision });
      return this.view();
    },
  };
  const application = {
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: false },
    },
    store: {
      async read() {
        if (onDashboardRead) return onDashboardRead();
        return dashboard;
      },
    },
    refreshService: {
      running: null,
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
        return { dashboard };
      },
      async confirmPullRequestResponsibility(id, actionState, headRefOid) {
        calls.push({ operation: "confirm", id, actionState, headRefOid });
        return dashboard;
      },
    },
    prEmployee,
    ...(typeof onClose === "function" ? { close: onClose } : {}),
  };
  if (confirmationQueueEnabled) {
    const confirmationItem = {
      id: "confirmation-pr-work-1",
      kind: "github.pull-request-review",
      status: "pending",
      queueRevision: 8,
      itemRevision: 2,
      requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-1" },
      actor: { provider: "github", accountId: "review-account" },
      target: {
        provider: "github",
        resourceId: "acme/repo#7",
        version: "a".repeat(40),
      },
      display: {
        title: "acme/repo #7 · Checkout",
        summary: "Ready to publish",
        actionLabel: "确认并发布到 GitHub",
        evidence: ["Head 已复核"],
        payload: {
          actor: { provider: "github", accountId: "review-account" },
          target: {
            provider: "github",
            resourceId: "acme/repo#7",
            version: "a".repeat(40),
          },
          action: {
            type: "pull_request_review",
            reviewEvent: "APPROVE",
            body: "Looks good.",
          },
        },
      },
      displayedPayloadDigest: "b".repeat(64),
      approvalBindingDigest: "c".repeat(64),
      retryable: false,
    };
    application.confirmationQueue = {
      historyReader: Object.freeze({
        async list(options) {
          calls.push({ operation: "confirmation_history_list", options });
          return {
            queueRevision: 8,
            filters: {
              ...(options.status ? { status: options.status } : {}),
              ...(options.kind ? { kind: options.kind } : {}),
              ...(options.roleId ? { roleId: options.roleId } : {}),
            },
            limit: options.limit || 25,
            roleIdFacets: ["former-reviewer", "pr-reviewer"],
            items: [
              {
                id: "confirmation-pr-work-completed",
                kind: "github.pull-request-review",
                status: "completed",
                requestedBy: {
                  roleId: "pr-reviewer",
                  workItemId: "pr-work-completed",
                },
                title: "acme/repo #7 · Checkout",
                summary: "Review 已完成",
                createdAt: "2026-08-05T01:00:00.000Z",
                updatedAt: "2026-08-05T01:01:00.000Z",
                retryable: false,
              },
            ],
            nextCursor: options.cursor ? null : "next-history-cursor",
          };
        },
      }),
      async next() {
        calls.push({ operation: "confirmation_next" });
        return {
          queueRevision: 8,
          pendingCount: 1,
          item: structuredClone(confirmationItem),
        };
      },
      async get(id) {
        calls.push({ operation: "confirmation_get", id });
        return structuredClone(confirmationItem);
      },
      async approve(id, input) {
        calls.push({ operation: "confirmation_approve", id, input });
        return { ...structuredClone(confirmationItem), status: "completed" };
      },
      async retry(id, input) {
        calls.push({ operation: "confirmation_retry", id, input });
        return { ...structuredClone(confirmationItem), status: "completed" };
      },
      async reject(id, input) {
        calls.push({ operation: "confirmation_reject", id, input });
        return { ...structuredClone(confirmationItem), status: "rejected" };
      },
    };
  }
  if (!legacyOnly) {
    application.employeeRegistry = new EmployeeRegistry([
      prEmployee,
      requirementsAnalyst,
    ]);
  }
  if (workflowRouting) {
    application.workflowRouting =
      typeof workflowRouting === "function"
        ? workflowRouting(calls)
        : workflowRouting;
  }
  if (workLedgerView) application.workLedgerView = workLedgerView;
  if (dailyWorkLedgerView) {
    application.dailyWorkLedgerView = dailyWorkLedgerView;
  }
  if (workGraphView) application.workGraphView = workGraphView;
  if (ownerWorkRequests) application.ownerWorkRequests = ownerWorkRequests;
  if (ownerWorkRetry) application.ownerWorkRetry = ownerWorkRetry;
  if (attentionCoordinator) {
    application.attentionCoordinator = attentionCoordinator;
  }
  if (attentionBrowser) application.attentionBrowser = attentionBrowser;
  if (memorySearch) application.memorySearch = memorySearch;
  if (memoryAnswer) application.memoryAnswer = memoryAnswer;
  if (memoryImports) application.memoryImports = memoryImports;
  if (codeJobReader) application.codeJobReader = codeJobReader;
  if (codeJobControl) application.codeJobControl = codeJobControl;
  if (jenkinsConnection) application.jenkinsConnection = jenkinsConnection;
  if (taskRuns) application.taskRuns = taskRuns;
  if (changePackageReader) application.changePackageReader = changePackageReader;
  if (changePackageApplicationRequester) {
    application.changePackageApplicationRequester =
      changePackageApplicationRequester;
  }
  if (changePackageApplicationStatusReader) {
    application.changePackageApplicationStatusReader =
      changePackageApplicationStatusReader;
  }
  if (codeJobEvidenceReader) {
    application.codeJobEvidenceReader = codeJobEvidenceReader;
  }
  const server = createDashboardServer(application, {
    backgroundWork,
    runtimeSourceIdentity,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ server, calls, reportedErrors });
  } finally {
    await server.shutdown();
  }
}

test('Jenkins connection HTTP API enforces local action headers and returns no supplied secret', async () => {
  const connected = [];
  const input = { repository: 'acme/repo', buildUrl: 'http://ci.example/job/Test/1/', username: 'fixture-user', password: 'fixture-secret' };
  await withServer(async ({ server }) => {
    const status = await request(server, { path: '/api/ci/jenkins/connection' });
    assert.deepEqual(JSON.parse(status.body), { configured: false });
    for (const headers of [{ 'content-type': 'application/json' }, { ...trustedConfigurationHeaders(), origin: 'http://other.invalid' }]) {
      const rejected = await request(server, { method: 'POST', path: '/api/ci/jenkins/connection', headers, body: JSON.stringify(input) });
      assert.equal(rejected.status, 403);
    }
    assert.equal(connected.length, 0);
    const accepted = await request(server, { method: 'POST', path: '/api/ci/jenkins/connection', headers: trustedConfigurationHeaders(), body: JSON.stringify(input) });
    assert.equal(accepted.status, 200); assert.deepEqual(connected, [input]); assert.ok(!accepted.body.includes(input.password));
    assert.equal(accepted.headers['cache-control'], 'no-store');
    const expanded = await request(server, { method: 'POST', path: '/api/ci/jenkins/connection', headers: trustedConfigurationHeaders(), body: JSON.stringify({ ...input, allowAllJobs: true }) });
    assert.equal(expanded.status, 400); assert.equal(connected.length, 1);
  }, { jenkinsConnection: { async status() { return { configured: false }; }, async connect(value) { connected.push(value); return { configured: true, username: value.username, state: 'available' }; } } });
});

test('task-run HTTP controls enforce origin and CAS through the real registry',async()=>{
  let saved=null;const entered=deferred(),gate=deferred();let calls=0;
  const registry=new TaskRunRegistry({store:{read:async(_k,f)=>saved??f,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:async()=>{}});
  const execution=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Check',subject:'repo#1',revision:1},async()=>{calls++;entered.resolve();if(calls===1)await gate.promise;return calls;});
  await entered.promise;
  try{await withServer(async({server})=>{
    const listed=await request(server,{path:'/api/task-runs'});assert.equal(listed.status,200);
    const view=JSON.parse(listed.body).items[0];
    const body=JSON.stringify({runId:view.runId,expectedRevision:view.revision,command:'instruct',instruction:'check locks'});
    const rejected=await request(server,{method:'POST',path:'/api/task-runs/work-item/work-1/control',headers:{'content-type':'application/json',origin:'http://wrong.invalid'},body});
    assert.equal(rejected.status,403);
    const accepted=await request(server,{method:'POST',path:'/api/task-runs/work-item/work-1/control',headers:trustedConfigurationHeaders(),body});assert.equal(accepted.status,200);
    const stale=await request(server,{method:'POST',path:'/api/task-runs/work-item/work-1/control',headers:trustedConfigurationHeaders(),body});assert.equal(stale.status,409);
    assert.equal(JSON.parse(stale.body).code,'TASK_RUN_CONFLICT');
  },{taskRuns:registry});}finally{gate.resolve();await execution;}
  assert.equal(calls,2);
});

test("live and health freeze the startup runtime source identity", async () => {
  const runtimeSourceIdentity = {
    schemaVersion: 1,
    headOid: "a".repeat(40),
    treeOid: "b".repeat(40),
    clean: true,
    runtimeDigest: "c".repeat(64),
    runtimeFileCount: 440,
    runtimeByteCount: 1_234_567,
  };
  await withServer(async ({ server }) => {
    runtimeSourceIdentity.headOid = "d".repeat(40);
    const live = JSON.parse((await request(server, { path: "/api/live" })).body);
    const health = JSON.parse(
      (await request(server, { path: "/api/health" })).body,
    );

    assert.equal(live.runtimeSource.headOid, "a".repeat(40));
    assert.deepEqual(health.runtimeSource, live.runtimeSource);
  }, { runtimeSourceIdentity });
});

test("system operations API preserves the browser projection and validates backup requests", async (t) => {
  const privateMarker = "private-producer-token-marker";
  const fixture = operationalApplication({
    async createBackup() {
      return {
        backupId: `backup-${"c".repeat(64)}`,
        createdAt: "2026-08-08T02:03:04.005Z",
        checkpointId: `backup-checkpoint-${"d".repeat(64)}`,
        fileCount: 4,
        totalBytes: 2048,
      };
    },
  });
  const server = createDashboardServer(fixture.application, {
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());

  const expectedStatus = await fixture.status();
  const status = await request(server, { path: "/api/system/status" });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), expectedStatus);
  assert.equal(status.body.includes(privateMarker), false);
  assert.equal(status.body.includes("producer"), false);
  assert.equal(status.body.includes("credential"), false);

  const statusWithQuery = await request(server, {
    path: "/api/system/status?path=private",
  });
  assert.equal(statusWithQuery.status, 400);

  const missingOrigin = await request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(missingOrigin.status, 403);

  const invalidContentType = await request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    },
    body: "{}",
  });
  assert.equal(invalidContentType.status, 415);

  const extraField = await request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: trustedConfigurationHeaders(),
    body: JSON.stringify({ producer: privateMarker }),
  });
  assert.equal(extraField.status, 400);

  const backup = await request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: trustedConfigurationHeaders(),
    body: "{}",
  });
  assert.equal(backup.status, 201);
  assert.deepEqual(JSON.parse(backup.body), {
    backupId: `backup-${"c".repeat(64)}`,
    createdAt: "2026-08-08T02:03:04.005Z",
    checkpointId: `backup-checkpoint-${"d".repeat(64)}`,
    fileCount: 4,
    totalBytes: 2048,
  });
  assert.equal(backup.body.includes(privateMarker), false);

  fixture.application.operations.browser.readStatus = async () => {
    throw new Error("private readiness failure");
  };
  const [failedStatus, independentLive] = await Promise.all([
    request(server, { path: "/api/system/status" }),
    request(server, { path: "/api/live" }),
  ]);
  assert.equal(failedStatus.status, 500);
  assert.equal(failedStatus.body.includes("private readiness failure"), false);
  assert.equal(independentLive.status, 200);
});

test("brain provider status API exposes only the sanitized readiness projection", async (t) => {
  const privateMarker = "private-codex-login-marker";
  const fixture = operationalApplication();
  const originalConfig = structuredClone(fixture.application.config);
  let receivedSignal = null;
  fixture.application.brainProviderStatus = {
    async readStatus({ signal }) {
      receivedSignal = signal;
      return {
        schemaVersion: 1,
        state: "available",
        cliAvailable: true,
        fileLoginAvailable: true,
      };
    },
  };
  const server = createDashboardServer(fixture.application, {
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());

  const response = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.deepEqual(fixture.application.config, originalConfig);
  assert.equal(response.body.includes(privateMarker), false);

  fixture.application.brainProviderStatus.readStatus = async () => ({
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
    credentialMode: "codex-native-login",
  });
  const native = await request(server, { path: "/api/brain-providers/status" });
  assert.equal(native.status, 200);
  assert.equal(JSON.parse(native.body).credentialMode, "codex-native-login");

  const query = await request(server, {
    path: "/api/brain-providers/status?source=private",
  });
  assert.equal(query.status, 400);

  fixture.application.brainProviderStatus.readStatus = async () => ({
    schemaVersion: 1,
    state: "file_login_unavailable",
    cliAvailable: true,
    fileLoginAvailable: false,
  });
  const unavailable = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(unavailable.status, 200);
  assert.equal(JSON.parse(unavailable.body).state, "file_login_unavailable");

  for (const [state, cliAvailable] of [
    ["unsafe_source", true],
    ["broker_blocked", true],
    ["cli_unavailable", false],
  ]) {
    fixture.application.brainProviderStatus.readStatus = async () => ({
      schemaVersion: 1,
      state,
      cliAvailable,
      fileLoginAvailable: false,
    });
    const projected = await request(server, {
      path: "/api/brain-providers/status",
    });
    assert.equal(projected.status, 200, state);
    assert.equal(JSON.parse(projected.body).state, state);
  }

  fixture.application.brainProviderStatus.readStatus = async () => ({
    schemaVersion: 1,
    state: "available",
    cliAvailable: false,
    fileLoginAvailable: true,
  });
  const incoherent = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(incoherent.status, 500);

  fixture.application.brainProviderStatus.readStatus = async () => ({
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
    privateMarker,
  });
  const invalid = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(invalid.status, 500);
  assert.equal(invalid.body.includes(privateMarker), false);

  fixture.application.brainProviderStatus.readStatus = async () => ({
    schemaVersion: 1, state: "available", cliAvailable: true,
    fileLoginAvailable: true, credentialMode: privateMarker,
  });
  const invalidMode = await request(server, { path: "/api/brain-providers/status" });
  assert.equal(invalidMode.status, 500);
  assert.equal(invalidMode.body.includes(privateMarker), false);

  fixture.application.brainProviderStatus = null;
  const missing = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(missing.status, 503);
});

test("brain provider status request cancellation is isolated per client", async (t) => {
  const fixture = operationalApplication();
  const firstStarted = deferred();
  const firstAborted = deferred();
  let reads = 0;
  fixture.application.brainProviderStatus = {
    async readStatus({ signal }) {
      reads += 1;
      if (reads > 1) {
        return {
          schemaVersion: 1,
          state: "available",
          cliAvailable: true,
          fileLoginAvailable: true,
        };
      }
      firstStarted.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          firstAborted.resolve();
          reject(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" }));
        }, { once: true });
      });
    },
  };
  const server = createDashboardServer(fixture.application, {
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());

  const outgoing = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    path: "/api/brain-providers/status",
    headers: { host: "127.0.0.1:4173" },
  });
  outgoing.on("error", () => {});
  outgoing.end();
  await firstStarted.promise;

  const independent = await request(server, {
    path: "/api/brain-providers/status",
  });
  assert.equal(independent.status, 200);
  outgoing.destroy();
  await firstAborted.promise;
  assert.equal(reads, 2);
});

test("backup drains an admitted HTTP mutation while liveness and status remain independent", async (t) => {
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const backupStarted = deferred();
  const releaseBackup = deferred();
  let refreshCalls = 0;
  const fixture = operationalApplication({
    async refresh() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return { dashboard: {} };
    },
    async createBackup() {
      backupStarted.resolve();
      await releaseBackup.promise;
      return {
        backupId: `backup-${"e".repeat(64)}`,
        createdAt: "2026-08-08T03:04:05.006Z",
        checkpointId: `backup-checkpoint-${"f".repeat(64)}`,
        fileCount: 1,
        totalBytes: 1,
      };
    },
  });
  const server = createDashboardServer(fixture.application, {
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseRefresh.resolve();
    releaseBackup.resolve();
    await server.shutdown();
  });

  const refresh = request(server, {
    method: "POST",
    path: "/api/refresh",
    headers: {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    },
  });
  await refreshStarted.promise;
  const backup = request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: trustedConfigurationHeaders(),
    body: "{}",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fixture.gate.readStatus().mode !== "open") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(fixture.gate.readStatus(), {
    mode: "closing",
    activeOperations: 1,
  });

  const [live, status, rejectedMutation] = await Promise.all([
    request(server, { path: "/api/live" }),
    request(server, { path: "/api/system/status" }),
    request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    }),
  ]);
  assert.equal(live.status, 200);
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body).maintenance, {
    mode: "closing",
    activeOperations: 1,
  });
  assert.equal(rejectedMutation.status, 503);
  assert.equal(refreshCalls, 1);

  releaseRefresh.resolve();
  assert.equal((await refresh).status, 200);
  await backupStarted.promise;
  assert.deepEqual(fixture.gate.readStatus(), {
    mode: "closed",
    activeOperations: 0,
  });
  const rejectedWhileClosed = await request(server, {
    method: "POST",
    path: "/api/refresh",
    headers: {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    },
  });
  assert.equal(rejectedWhileClosed.status, 503);
  assert.equal(refreshCalls, 1);

  releaseBackup.resolve();
  assert.equal((await backup).status, 201);
  assert.equal(fixture.gate.readStatus().mode, "open");
});

test("failed backup reopens admission and does not poison later HTTP work", async (t) => {
  let refreshCalls = 0;
  const reports = [];
  const fixture = operationalApplication({
    async refresh() {
      refreshCalls += 1;
      return { dashboard: {} };
    },
    async createBackup() {
      throw Object.assign(new Error("private backup failure"), {
        code: "BACKUP_private_credential", stage: "private backup failure",
        counts: { fileCount: "private backup failure", private: 123 },
      });
    },
  });
  const server = createDashboardServer(fixture.application, {
    reportError(value) { reports.push(value); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());

  const failed = await request(server, {
    method: "POST",
    path: "/api/system/backups",
    headers: trustedConfigurationHeaders(),
    body: "{}",
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.includes("private backup failure"), false);
  assert.deepEqual(reports.map((value) => JSON.parse(value)), [{
    code: "BACKUP_CREATE_FAILED", stage: "create_backup",
  }]);
  assert.equal(fixture.gate.readStatus().mode, "open");

  const laterMutation = await request(server, {
    method: "POST",
    path: "/api/refresh",
    headers: {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    },
  });
  assert.equal(laterMutation.status, 200);
  assert.equal(refreshCalls, 1);
});

test("backup failure diagnostics survive observer disconnect and contain only safe fields", async (t) => {
  for (const disconnect of [false, true]) {
    await t.test(disconnect ? "disconnected observer" : "connected observer", async (child) => {
      const started = deferred();
      const release = deferred();
      const reported = deferred();
      const observerClosed = deferred();
      const reports = [];
      const privateMarker = "credential-and-payload-must-never-be-logged";
      const cause = Object.assign(new Error(privateMarker), {
        code: "CHECKPOINT_CAPACITY_EXCEEDED", stage: "metadata_preflight",
        counts: { fileCount: 100_001, directoryCount: 3, totalBytes: 42, privateMarker },
      });
      const failure = Object.assign(new Error(privateMarker, { cause }), {
        code: "BACKUP_QUIESCENCE_FAILED", statusCode: 503,
      });
      const fixture = operationalApplication({ async createBackup() {
        started.resolve();
        await release.promise;
        throw failure;
      } });
      const server = createDashboardServer(fixture.application, {
        reportError(value) { reports.push(value); reported.resolve(); },
      });
      server.once("request", (_request, response) => response.once("close", observerClosed.resolve));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      child.after(async () => { release.resolve(); await server.shutdown(); });
      let outgoing;
      const response = new Promise((resolve, reject) => {
        outgoing = http.request({ host: "127.0.0.1", port: server.address().port,
          method: "POST", path: "/api/system/backups",
          headers: { host: "127.0.0.1:4173", "content-length": 2, ...trustedConfigurationHeaders() },
        }, (incoming) => { incoming.resume(); incoming.once("end", () => resolve(incoming.statusCode)); });
        outgoing.on("error", disconnect ? () => resolve(null) : reject);
        outgoing.end("{}");
      });
      await started.promise;
      if (disconnect) {
        outgoing.destroy();
        await observerClosed.promise;
        assert.equal(fixture.gate.readStatus().mode, "closed");
      }
      release.resolve();
      let timeout;
      try {
        await Promise.race([reported.promise, new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("backup failure diagnostic was lost")), 1000);
        })]);
      } finally { clearTimeout(timeout); }
      assert.equal(await response, disconnect ? null : 503);
      assert.equal(fixture.gate.readStatus().mode, "open");
      assert.equal(reports.length, 1);
      assert.equal(typeof reports[0], "string");
      assert.equal(reports[0].includes(privateMarker), false);
      assert.deepEqual(JSON.parse(reports[0]), {
        code: "BACKUP_QUIESCENCE_FAILED", stage: "metadata_preflight",
        causeCode: "CHECKPOINT_CAPACITY_EXCEEDED",
        counts: { fileCount: 100_001, directoryCount: 3, totalBytes: 42 },
      });
      const next = await request(server, { method: "POST", path: "/api/refresh", headers: trustedConfigurationHeaders() });
      assert.equal(next.status, 200);
    });
  }
});

test("a throwing backup diagnostic sink does not replace failure or prevent later work", async (t) => {
  const fixture = operationalApplication({ async createBackup() {
    throw Object.assign(new Error("private backup cause"), { code: "BACKUP_IO_FAILED", statusCode: 503 });
  } });
  const server = createDashboardServer(fixture.application, {
    reportError() { throw new Error("private logging failure"); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());
  const failed = await request(server, { method: "POST", path: "/api/system/backups",
    headers: trustedConfigurationHeaders(), body: "{}" });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.includes("private"), false);
  assert.equal(fixture.gate.readStatus().mode, "open");
  assert.equal((await request(server, { method: "POST", path: "/api/refresh", headers: trustedConfigurationHeaders() })).status, 200);
});

test("the same-origin process endpoint acknowledges before graceful shutdown", async () => {
  let applicationCloses = 0;
  await withServer(
    async ({ server, reportedErrors }) => {
      const live = await request(server, { path: "/api/live" });
      assert.equal(live.status, 200);
      assert.deepEqual(JSON.parse(live.body), {
        schemaVersion: 1,
        live: true,
        service: "mydashboard",
        processId: process.pid,
        managed: false,
        lifecycleState: "running",
      });
      const health = await request(server, { path: "/api/health" });
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).service, "mydashboard");
      assert.equal(JSON.parse(health.body).processId, process.pid);
      const closed = new Promise((resolve) => server.once("close", resolve));
      const response = await request(server, {
        method: "POST",
        path: "/api/system/shutdown",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
        },
      });
      assert.equal(response.status, 202);
      assert.deepEqual(JSON.parse(response.body), {
        accepted: true,
        state: "stopping",
      });
      await closed;
      await server.shutdown();
      assert.equal(applicationCloses, 1);
      assert.deepEqual(reportedErrors, []);
    },
    {
      async onClose() {
        applicationCloses += 1;
      },
    },
  );
});

test("the process endpoint rejects cross-origin, stale-query, and GET requests", async () => {
  await withServer(async ({ server }) => {
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/system/shutdown",
      headers: {
        origin: "http://malicious.invalid",
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const query = await request(server, {
      method: "POST",
      path: "/api/system/shutdown?force=1",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(query.status, 400);

    const get = await request(server, { path: "/api/system/shutdown" });
    assert.equal(get.status, 404);
    assert.equal(server.listening, true);
  });
});

test("a shutdown drain failure sets a nonzero process outcome", async () => {
  const failure = new Error("durable runtime failed to close");
  const exitCodes = [];
  const reportedErrors = [];
  const application = startupApplication({
    port: 4173,
    async close() {
      throw failure;
    },
  });
  const server = createDashboardServer(application, {
    backgroundWork: { async stop() {} },
    reportError(error) {
      reportedErrors.push(error);
    },
    setProcessExitCode(code) {
      exitCodes.push(code);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const response = await request(server, {
      method: "POST",
      path: "/api/system/shutdown",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(response.status, 202);
    await assert.rejects(() => server.shutdown(), (error) => error === failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(reportedErrors, [failure]);
  } finally {
    await server.shutdown().catch(() => {});
  }
});

test("durable Review handoffs recover at startup and ticks even while refresh is unavailable", async () => {
  const application = startupApplication({ refresh: async () => { throw new Error("offline"); } });
  let recovered = 0;
  application.reviewHandoffReconciler = { async runCycle() { recovered++; } };
  application.workCoordination = { async runCycle() {} };
  application.config.workCoordination = { tickSeconds: 30 };
  const timers = [];
  const background = startApplicationBackgroundWork(application, {
    setIntervalFn(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; },
    clearIntervalFn() {},
    reportError() {},
  });
  try {
    await assert.rejects(background.initialRefresh, /offline/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recovered, 1);
    await timers.find((timer) => timer.delay === 30_000).callback();
    assert.equal(recovered, 2);
  } finally { await background.stop(); }
});

test("shutdown signals the registered Review handoff participant", async () => {
  const started = deferred();
  const application = startupApplication();
  let handoffSignal;
  const participants = [];
  application.reviewHandoffReconciler = { runCycle({ signal }) {
    handoffSignal = signal;
    started.resolve();
    return new Promise((resolve) => {
      signal.addEventListener("abort", resolve, { once: true });
      if (signal.aborted) resolve();
    });
  } };
  const background = startApplicationBackgroundWork(application, {
    setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {},
    observeDrainParticipant(participant) { participants.push(participant.id); },
  });
  await started.promise;
  await background.stop();
  assert.equal(handoffSignal.aborted, true);
  assert.ok(participants.includes(DRAIN_PARTICIPANTS.reviewHandoffRecovery.id));
});

test("shutdown drains a cancelled GitHub handoff while retaining cleanup failures", async (t) => {
  for (const cleanupFails of [false, true]) {
    await t.test(cleanupFails ? "cleanup failure remains authoritative" : "cooperative cancellation succeeds", async () => {
      const started = deferred();
      const application = startupApplication();
      const githubAssignee = createGitHubActionExecutor({
        ghCommand: process.platform === "win32" ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "/usr/bin/gh",
        runner: {
          async run({ signal }) {
            started.resolve();
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
              if (signal.aborted) resolve();
            });
            throw new ManagedProcessError("PROCESS_ABORTED", "cancelled");
          },
        },
        credentialSource: Object.freeze({
          async acquire() {
            return Object.freeze({
              async use(callback) { return callback("fictional_test_token"); },
              release() {
                if (cleanupFails) throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
              },
            });
          },
        }),
      });
      application.reviewHandoffReconciler = new ReviewHandoffReconciler({
        confirmations: {
          async readReviewHandoffs() {
            return [{
              id: "review-42", actorAccountId: "local-owner",
              request: { requestId: "request-42", pullRequest: { repository: "acme/repo", number: 42 } },
              automaticReview: { reviewEvent: "COMMENT", headRefOid: "a".repeat(40) },
            }];
          },
          async recordReviewHandoff() {},
        },
        ownerWorkRequests: { async submit() {
          return { phase: "intaken", workItemId: "work-42", assignment: { target: { id: "tester" } } };
        } },
        githubAssignee,
      });
      const background = startApplicationBackgroundWork(application, {
        setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {},
      });
      await started.promise;
      if (cleanupFails) {
        await assert.rejects(background.stop(), { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" });
      } else {
        await background.stop();
      }
      await githubAssignee.close();
    });
  }
});

test("a timed-out handoff keeps its unfinished operation in the shutdown drain", async () => {
  const started = deferred();
  const release = deferred();
  const cycleFinished = deferred();
  const application = startupApplication();
  const reconciler = new ReviewHandoffReconciler({
    timeoutMs: 15,
    confirmations: {
      async readReviewHandoffs() { return [{ id: "review-42", request: { requestId: "request-42" } }]; },
      async recordReviewHandoff() {},
    },
    ownerWorkRequests: { async submit() {
      started.resolve();
      await release.promise;
      return { phase: "intaken", workItemId: "work-42", assignment: { target: { id: "tester" } } };
    } },
  });
  application.reviewHandoffReconciler = { async runCycle(options) {
    const results = await reconciler.runCycle(options);
    cycleFinished.resolve();
    return results;
  } };
  const background = startApplicationBackgroundWork(application, {
    setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {},
  });
  try {
    await started.promise;
    await cycleFinished.promise;
    assert.ok(background.drainStatus().activeParticipants.some(
      ({ id }) => id === DRAIN_PARTICIPANTS.reviewHandoffRecovery.id,
    ));
    let stopped = false;
    const stopping = background.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release.resolve();
    await stopping;
    assert.equal(stopped, true);
  } finally { release.resolve(); await background.stop(); }
});

test("a background drain timeout identifies the active participant without payloads", async () => {
  const memoryStarted = deferred();
  const releaseMemory = deferred();
  const privateMarker = "must-not-appear-in-drain-diagnostics";
  const application = startupApplication();
  application.memoryProjector = {
    async runCycle() {
      memoryStarted.resolve();
      await releaseMemory.promise;
      return privateMarker;
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 1_000,
  });
  await memoryStarted.promise;
  const server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 25,
    reportError() {},
    setProcessExitCode() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await assert.rejects(
      server.shutdown(),
      (error) => {
        assert.equal(error?.code, "LIFECYCLE_DRAIN_TIMEOUT");
        assert.match(error.message, /memoryProjector[.]runCycle/u);
        assert.doesNotMatch(error.message, new RegExp(privateMarker, "u"));
        assert.deepEqual(error.drainStatus, {
          schemaVersion: 1,
          activeParticipants: [{
            id: "memoryProjector.runCycle",
            count: 1,
          }],
          activeTaskCount: 1,
          backgroundOperationActive: true,
          confirmationOperationCount: 0,
          queuedOperationCount: 0,
        });
        return true;
      },
    );
  } finally {
    releaseMemory.resolve();
    await backgroundWork.stop();
  }
});

test("configuration safe mode starts no background reads or employees but permits confirmation operations", async () => {
  let refreshCalls = 0;
  let operationCalls = 0;
  const application = startupApplication({
    async refresh() {
      refreshCalls += 1;
      return healthyRefreshResult();
    },
  });
  application.configuration = {
    status: { safeMode: true, migrationError: { code: "CONFIG_LOCAL_INVALID" } },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      throw new Error("safe mode must not schedule work");
    },
  });

  assert.deepEqual(await backgroundWork.initialRefresh, {
    skipped: "configuration_safe_mode",
  });
  assert.deepEqual(await backgroundWork.refresh(), {
    skipped: "configuration_safe_mode",
  });
  assert.deepEqual(
    await backgroundWork.mutateFacts(async () => {
      operationCalls += 1;
    }),
    { skipped: "configuration_safe_mode" },
  );
  assert.equal(
    await backgroundWork.runConfirmationOperation(async () => {
      operationCalls += 1;
      return "confirmation-completed";
    }),
    "confirmation-completed",
  );
  assert.deepEqual(backgroundWork.timers, []);
  assert.equal(backgroundWork.confirmationReady(), true);
  assert.equal(refreshCalls, 0);
  assert.equal(operationCalls, 1);
  const firstStop = backgroundWork.stop();
  assert.strictEqual(backgroundWork.stop(), firstStop);
  await firstStop;
});

test("configuration safe mode shutdown drains an accepted confirmation operation", async () => {
  const operationStarted = deferred();
  const releaseOperation = deferred();
  const application = startupApplication();
  application.configuration = {
    status: { safeMode: true, migrationError: null },
  };
  const backgroundWork = startApplicationBackgroundWork(application);
  const operation = backgroundWork.runConfirmationOperation(async () => {
    operationStarted.resolve();
    await releaseOperation.promise;
    return "completed";
  });
  await operationStarted.promise;

  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(backgroundWork.confirmationReady(), false);
  await assert.rejects(
    backgroundWork.runConfirmationOperation(async () => "must-not-run"),
    (error) => error?.code === "CONFIRMATION_FACTS_NOT_READY",
  );

  releaseOperation.resolve();
  assert.equal(await operation, "completed");
  await stopping;
  assert.equal(stopped, true);
});

test("configuration safe mode shutdown drains an accepted confirmation read", async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  const application = startupApplication();
  application.configuration = {
    status: { safeMode: true, migrationError: null },
  };
  const backgroundWork = startApplicationBackgroundWork(application);
  const read = backgroundWork.runConfirmationRead(async () => {
    readStarted.resolve();
    await releaseRead.promise;
    return "completed";
  });
  await readStarted.promise;

  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  await assert.rejects(
    backgroundWork.runConfirmationRead(async () => "must-not-run"),
    (error) => error?.code === "CONFIRMATION_FACTS_NOT_READY",
  );

  releaseRead.resolve();
  assert.equal(await read, "completed");
  await stopping;
  assert.equal(stopped, true);
});

test("production drain participants reject every public trigger before execution and resume together", async (t) => {
  const gate = new OperationalQuiescenceGate();
  const agencyStarted = deferred();
  const releaseAgency = deferred();
  const reportedErrors = [];
  const executed = [];
  const participantIds = Object.values(DRAIN_PARTICIPANTS).filter(
    (participant) => participant !== DRAIN_PARTICIPANTS.reviewHandoffRecovery && participant !== DRAIN_PARTICIPANTS.workContinuation && participant !== DRAIN_PARTICIPANTS.localCodeProposalRecovery && participant !== DRAIN_PARTICIPANTS.codeJobExecution,
  ).map(
    (participant) => participant.id,
  );
  let employeeCycles = 0;
  const application = startupApplication({
    async refresh() {
      return healthyRefreshResult();
    },
    async runAll() {
      employeeCycles += 1;
      if (employeeCycles === 2) {
        agencyStarted.resolve();
        await releaseAgency.promise;
      }
    },
  });
  application.operations = {
    admission: { run: gate.run.bind(gate) },
  };
  application.workflowRouting = {
    async ingestSnapshot() {
      return { events: [], assignments: [] };
    },
  };
  application.workCoordination = {
    async intake() {},
    async runCycle() {},
  };
  application.employeeRegistry.get("pr-reviewer").recoverConfirmations = async () => {};
  application.memoryProjector = {
    async runCycle() {},
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
    reportError(error) {
      reportedErrors.push(error);
    },
    observeDrainParticipant(participant) {
      executed.push(participant.id);
    },
  });
  let maintenanceToken = null;
  t.after(async () => {
    releaseAgency.resolve();
    if (gate.readStatus().mode === "closed" && maintenanceToken) {
      gate.leave(maintenanceToken);
    }
    await backgroundWork.stop();
  });
  await backgroundWork.initialRefresh;
  await backgroundWork.runConfirmationOperation(async () => {});
  const employeeParticipant = DRAIN_PARTICIPANTS.employeeExecution.id;
  const employeeParticipantIndex = participantIds.indexOf(employeeParticipant);
  const expectedParticipantRun = [
    ...participantIds.slice(0, employeeParticipantIndex),
    DRAIN_PARTICIPANTS.memoryProjection.id,
    ...participantIds.slice(employeeParticipantIndex),
  ];
  assert.deepEqual(executed, expectedParticipantRun);

  async function assertRejectedBeforeParticipant(trigger) {
    const baseline = [...executed];
    await assert.rejects(trigger(), { code: "SYSTEM_QUIESCING" });
    assert.deepEqual(executed, baseline);
  }

  const admittedAgency = backgroundWork.runEmployee("pr-reviewer", {
    trigger: "manual",
  });
  await agencyStarted.promise;
  const entering = gate.enter();
  assert.deepEqual(gate.readStatus(), {
    mode: "closing",
    activeOperations: 1,
  });
  await assertRejectedBeforeParticipant(() => backgroundWork.refresh());
  await assertRejectedBeforeParticipant(() => backgroundWork.signalAgency());
  await assertRejectedBeforeParticipant(() =>
    backgroundWork.runEmployee("pr-reviewer"),
  );
  await assertRejectedBeforeParticipant(() =>
    backgroundWork.runConfirmationOperation(async () => "must-not-run"),
  );

  releaseAgency.resolve();
  await admittedAgency;
  const token = await entering;
  maintenanceToken = token;

  await assertRejectedBeforeParticipant(() => backgroundWork.refresh());
  await assertRejectedBeforeParticipant(() => backgroundWork.signalAgency());
  await assertRejectedBeforeParticipant(() =>
    backgroundWork.runEmployee("pr-reviewer"),
  );
  await assertRejectedBeforeParticipant(() =>
    backgroundWork.runConfirmationOperation(async () => "must-not-run"),
  );

  gate.leave(token);
  maintenanceToken = null;

  executed.length = 0;
  await backgroundWork.refresh();
  await backgroundWork.runConfirmationOperation(async () => {});
  assert.deepEqual(executed, expectedParticipantRun);
  assert.deepEqual(
    reportedErrors.map((error) => error.code),
    Array(6).fill("SYSTEM_QUIESCING"),
  );
});

test("configuration safe mode cannot bypass closed operational admission", async (t) => {
  const gate = new OperationalQuiescenceGate();
  const fixture = safeConfigurationApplication();
  fixture.application.operations = {
    admission: { run: gate.run.bind(gate) },
    browser: {
      async readStatus() {
        return { maintenance: gate.readStatus() };
      },
      async createBackup() {
        throw new Error("not used");
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(fixture.application);
  const server = createDashboardServer(fixture.application, {
    backgroundWork,
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let token = null;
  t.after(async () => {
    if (gate.readStatus().mode === "closed") gate.leave(token);
    await server.shutdown();
  });
  token = await gate.enter();

  await assert.rejects(
    backgroundWork.runConfirmationOperation(async () => "must-not-run"),
    { code: "SYSTEM_QUIESCING" },
  );
  await assert.rejects(backgroundWork.runAttentionOperation(async () => "must-not-run"), { code: "SYSTEM_QUIESCING" });
  const mutation = await request(server, {
    method: "POST",
    path: "/api/configuration/drafts",
    headers: trustedConfigurationHeaders(),
    body: "{}",
  });
  assert.equal(mutation.status, 503);
  assert.deepEqual(fixture.calls, []);
  const live = await request(server, { path: "/api/live" });
  assert.equal(live.status, 200);
});

test("configuration API exposes an uncertain runtime fence", async () => {
  await withSafeConfigurationServer(async ({ application, server }) => {
    application.configuration.runtimeStatus = {
      readStatus() {
        return {
          mode: "unknown",
          storedActive: null,
          runtimeEffective: null,
        };
      },
    };

    const response = await request(server, { path: "/api/configuration" });
    assert.equal(response.status, 200);
    const state = JSON.parse(response.body);
    assert.equal(state.status.runtimeMode, "unknown");
    assert.equal(state.pendingRestart, true);
  });
});

test("configuration API fails closed on contradictory or one-sided bindings", async () => {
  await withSafeConfigurationServer(async ({ application, server }) => {
    application.configuration.runtimeStatus = {
      readStatus() {
        return {
          mode: "ready",
          storedActive: null,
          runtimeEffective: null,
        };
      },
    };
    const contradictory = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(contradictory.status.runtimeMode, "unknown");
    assert.equal(contradictory.pendingRestart, true);

    delete application.configuration.runtimeStatus;
    application.configuration.status.activeVersion = 1;
    const runtimeOnly = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(runtimeOnly.status.runtimeMode, "restart_required");
    assert.equal(runtimeOnly.pendingRestart, true);
  });
});

test("safe-mode configuration API creates, revises, previews, and reloads only initialization drafts", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const initial = await request(server, { path: "/api/configuration" });
    assert.equal(initial.status, 200);
    const initialState = JSON.parse(initial.body);
    assert.deepEqual(Object.keys(initialState).sort(), [
      "audit",
      "drafts",
      "editableConfiguration",
      "history",
      "pendingRestart",
      "runtimeEffective",
      "status",
      "storedActive",
      "versions",
    ]);
    assert.equal(initialState.status.safeMode, true);
    assert.equal(initialState.status.runtimeMode, "boot_safe");
    assert.equal(initialState.status.stateRevision, 0);
    assert.equal(initialState.status.migrationError.code, "CONFIG_LOCAL_INVALID");
    assert.equal(initialState.storedActive, null);
    assert.equal(initialState.runtimeEffective.activeVersion, null);
    assert.match(initialState.runtimeEffective.configurationDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      initialState.runtimeEffective.configuration,
      safeEditableConfiguration,
    );
    assert.equal(initialState.pendingRestart, false);
    assert.deepEqual(initialState.drafts, []);
    assert.deepEqual(initialState.versions, []);
    assert.deepEqual(initialState.audit, []);
    assert.deepEqual(initialState.history, {
      totalVersions: 0,
      totalAuditEntries: 0,
      versionsTruncated: false,
      auditTruncated: false,
    });
    assert.deepEqual(
      initialState.editableConfiguration,
      safeEditableConfiguration,
    );
    assert.equal("projectionOutbox" in initialState, false);

    const firstConfiguration = structuredClone(safeEditableConfiguration);
    firstConfiguration.refreshMinutes = 20;
    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 0,
        configuration: firstConfiguration,
      }),
    });
    assert.equal(created.status, 201, created.body);
    const createdDraft = JSON.parse(created.body).draft;
    assert.equal(createdDraft.draftId, "initial-draft");
    assert.equal(createdDraft.revision, 1);
    assert.equal(createdDraft.baseVersion, 0);
    assert.equal("proposedBy" in createdDraft, false);
    assert.equal("contentDigest" in createdDraft, false);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_create").input,
      {
        expectedStateRevision: 0,
        configuration: firstConfiguration,
        proposedBy: "owner:local",
      },
    );

    const afterCreate = await request(server, { path: "/api/configuration" });
    assert.equal(afterCreate.status, 200);
    const createdState = JSON.parse(afterCreate.body);
    assert.equal(createdState.status.stateRevision, 1);
    assert.equal(createdState.drafts.length, 1);
    assert.equal(createdState.drafts[0].draftId, "initial-draft");
    assert.equal(createdState.drafts[0].baseVersion, 0);
    assert.equal("configuration" in createdState.drafts[0], false);
    assert.deepEqual(createdState.editableConfiguration, firstConfiguration);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_draft_read")
        .length,
      0,
    );

    const draftRead = await request(server, {
      path: "/api/configuration/drafts/initial-draft?revision=1",
    });
    assert.equal(draftRead.status, 200);
    assert.deepEqual(JSON.parse(draftRead.body).draft.configuration, firstConfiguration);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_draft_read")
        .length,
      1,
    );

    const secondConfiguration = structuredClone(firstConfiguration);
    secondConfiguration.refreshMinutes = 25;
    const revised = await request(server, {
      method: "PUT",
      path: "/api/configuration/drafts/initial-draft",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedDraftRevision: 1,
        expectedStateRevision: 1,
        configuration: secondConfiguration,
      }),
    });
    assert.equal(revised.status, 200, revised.body);
    assert.equal(JSON.parse(revised.body).draft.revision, 2);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_revise").input,
      {
        draftId: "initial-draft",
        expectedDraftRevision: 1,
        expectedStateRevision: 1,
        configuration: secondConfiguration,
        proposedBy: "owner:local",
      },
    );

    const reloaded = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(reloaded.status.stateRevision, 2);
    assert.equal(reloaded.drafts[0].revision, 2);
    assert.deepEqual(reloaded.editableConfiguration, secondConfiguration);

    const binding = { draftRevision: 2, expectedStateRevision: 2 };
    const preview = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts/initial-draft/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(binding),
    });
    assert.equal(preview.status, 200, preview.body);
    const prepared = JSON.parse(preview.body);
    assert.equal(prepared.kind, "configuration.initialize");
    assert.equal(prepared.expectedActiveVersion, null);
    assert.deepEqual(prepared.impact.restart_required, ["githubActions.enabled"]);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_preview").input,
      { draftId: "initial-draft", ...binding },
    );

    const queued = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts/initial-draft/request-confirmation",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(binding),
    });
    assert.equal(queued.status, 200, queued.body);
    assert.equal(
      JSON.parse(queued.body).request.id,
      "confirmation-configuration-initialization",
    );
    assert.deepEqual(
      calls.find(
        ({ operation }) => operation === "configuration_request_confirmation",
      ).input,
      { draftId: "initial-draft", ...binding },
    );
  });
});

test("safe-mode configuration mutations reject untrusted, expansive, and direct activation requests", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const configuration = structuredClone(safeEditableConfiguration);
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStateRevision: 0, configuration }),
    });
    const clientActor = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 0,
        configuration,
        proposedBy: "attacker",
      }),
    });
    const directPaths = [
      "/api/configuration/activate",
      "/api/configuration/rollback",
      "/api/confirmations/enqueue",
    ];
    const direct = await Promise.all(
      directPaths.map((path) =>
        request(server, {
          method: "POST",
          path,
          headers: trustedConfigurationHeaders(),
          body: "{}",
        }),
      ),
    );

    assert.equal(untrusted.status, 403);
    assert.equal(clientActor.status, 400);
    assert.deepEqual(direct.map(({ status }) => status), [404, 404, 404]);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_create").length,
      0,
    );
  });
});

test("safe mode exposes and operates only initialization confirmations then reports restart drift", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const configuration = structuredClone(safeEditableConfiguration);
    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({ expectedStateRevision: 0, configuration }),
    });
    assert.equal(created.status, 201);

    const directNext = await request(server, { path: "/api/confirmations/next" });
    const attentionNext = await request(server, { path: "/api/attention/next" });
    assert.equal(directNext.status, 200, directNext.body);
    assert.equal(attentionNext.status, 200, attentionNext.body);
    assert.equal(
      JSON.parse(directNext.body).item.id,
      "confirmation-configuration-initialization",
    );
    assert.equal(
      JSON.parse(attentionNext.body).item.id,
      "confirmation-configuration-initialization",
    );
    const scopedReads = calls.filter(
      ({ operation }) => operation === "configuration_confirmation_next",
    );
    assert.equal(scopedReads.length, 2);
    for (const read of scopedReads) {
      assert.equal(read.kind, "local.configuration-activate");
      assert.equal(read.actionType, "initialize_from_draft");
    }
    assert.equal(
      calls.some(({ operation }) => operation === "unsafe_confirmation_next"),
      false,
    );

    const approval = {
      requestId: "request-configuration-initialization-1",
      expectedQueueRevision: 12,
      expectedItemRevision: 1,
      displayedPayloadDigest: "e".repeat(64),
      approvalBindingDigest: "f".repeat(64),
    };
    for (const id of [
      "confirmation-unrelated-github",
      "confirmation-configuration-rollback",
    ]) {
      const denied = await request(server, {
        method: "POST",
        path: `/api/confirmations/${id}/approve`,
        headers: trustedConfigurationHeaders(),
        body: JSON.stringify(approval),
      });
      assert.equal(denied.status, 404, `${id}: ${denied.body}`);
    }
    assert.equal(
      calls.filter(
        ({ operation }) => operation === "configuration_confirmation_approve",
      ).length,
      0,
    );

    const approved = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-configuration-initialization/approve",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(approval),
    });
    assert.equal(approved.status, 200, approved.body);
    assert.equal(JSON.parse(approved.body).item.status, "completed");

    const status = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(status.status.safeMode, true);
    assert.equal(status.status.runtimeMode, "restart_required");
    assert.equal(status.storedActive.version, 1);
    assert.equal(status.runtimeEffective.activeVersion, null);
    assert.equal(status.pendingRestart, true);
    assert.deepEqual(status.editableConfiguration, configuration);

    const version = await request(server, {
      path: "/api/configuration/versions/1",
    });
    assert.equal(version.status, 200);
    assert.deepEqual(JSON.parse(version.body).version.configuration, configuration);

    const createAfterActivation = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({ expectedStateRevision: 2, configuration }),
    });
    assert.equal(createAfterActivation.status, 409);
  });
});

test("active configuration API stages revision-bound activation and rollback through confirmation", async () => {
  await withActiveConfigurationServer(async ({
    server,
    calls,
    configurationStore,
    application,
  }) => {
    const initial = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(initial.status.safeMode, false);
    assert.equal(initial.status.stateRevision, 1);
    assert.equal(initial.storedActive.version, 1);
    assert.deepEqual(initial.versions.map(({ version }) => version), [1]);
    assert.equal("configuration" in initial.versions[0], false);
    assert.equal(initial.audit.at(-1).kind, "bootstrap_imported");
    assert.equal("draftRevisionId" in initial.audit.at(-1), false);
    assert.equal("projectionOutbox" in initial, false);

    const changed = structuredClone(safeEditableConfiguration);
    changed.refreshMinutes = 19;
    application.configuration.runtimeStatus = {
      async readStatus() {
        return {
          mode: "unknown",
          storedActive: null,
          runtimeEffective: null,
        };
      },
    };
    const fenced = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration: changed,
      }),
    });
    assert.equal(fenced.status, 409);
    delete application.configuration.runtimeStatus;

    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration: changed,
      }),
    });
    assert.equal(created.status, 201, created.body);
    const draft = JSON.parse(created.body).draft;
    assert.equal(draft.baseVersion, 1);
    assert.equal(draft.revision, 1);

    const revisedConfiguration = structuredClone(changed);
    revisedConfiguration.refreshMinutes = 21;
    const revised = await request(server, {
      method: "PUT",
      path: `/api/configuration/drafts/${draft.draftId}`,
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedDraftRevision: 1,
        expectedStateRevision: 2,
        expectedActiveVersion: 1,
        configuration: revisedConfiguration,
      }),
    });
    assert.equal(revised.status, 200, revised.body);
    assert.equal(JSON.parse(revised.body).draft.revision, 2);

    const staleRevision = await request(server, {
      method: "PUT",
      path: `/api/configuration/drafts/${draft.draftId}`,
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedDraftRevision: 1,
        expectedStateRevision: 3,
        expectedActiveVersion: 1,
        configuration: revisedConfiguration,
      }),
    });
    assert.equal(staleRevision.status, 409);

    const afterRevision = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(afterRevision.status.stateRevision, 3);
    assert.equal(afterRevision.drafts[0].draftId, draft.draftId);
    assert.equal(afterRevision.drafts[0].revision, 2);
    assert.deepEqual(
      afterRevision.editableConfiguration,
      revisedConfiguration,
    );

    const activationBinding = {
      draftRevision: 2,
      expectedStateRevision: 3,
      expectedActiveVersion: 1,
    };
    const preview = await request(server, {
      method: "POST",
      path: `/api/configuration/drafts/${draft.draftId}/preview`,
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(activationBinding),
    });
    assert.equal(preview.status, 200, preview.body);
    const activationPreview = JSON.parse(preview.body);
    assert.equal(activationPreview.kind, "configuration.activate");
    assert.equal(activationPreview.draftId, draft.draftId);
    assert.equal(activationPreview.draftRevision, 2);
    assert.equal(activationPreview.expectedStateRevision, 3);
    assert.equal(activationPreview.expectedActiveVersion, 1);

    const requested = await request(server, {
      method: "POST",
      path: `/api/configuration/drafts/${draft.draftId}/request-confirmation`,
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(activationBinding),
    });
    assert.equal(requested.status, 200, requested.body);
    assert.equal(
      JSON.parse(requested.body).request.id,
      "confirmation-configuration-activation",
    );
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_request_activation")
        .input,
      { draftId: draft.draftId, ...activationBinding },
    );

    const preparedActivation = await configurationStore.prepareDraftActivation({
      draftId: draft.draftId,
      ...activationBinding,
    });
    await configurationStore.activateDraft({
      ...preparedActivation,
      activatedBy: "owner:local",
    });

    const afterActivation = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(afterActivation.storedActive.version, 2);
    assert.equal(afterActivation.runtimeEffective.activeVersion, 1);
    assert.equal(afterActivation.pendingRestart, true);
    assert.deepEqual(
      afterActivation.versions.map(({ version }) => version),
      [2, 1],
    );

    const rollbackBinding = {
      expectedStateRevision: 4,
      expectedActiveVersion: 2,
    };
    const beforeRestart = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(rollbackBinding),
    });
    assert.equal(beforeRestart.status, 409);

    application.configuration.status.activeVersion = 2;
    application.config = structuredClone(revisedConfiguration);
    const rollbackPreview = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(rollbackBinding),
    });
    assert.equal(rollbackPreview.status, 200, rollbackPreview.body);
    assert.equal(JSON.parse(rollbackPreview.body).kind, "configuration.rollback");

    const rollbackRequested = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/request-confirmation",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(rollbackBinding),
    });
    assert.equal(rollbackRequested.status, 200, rollbackRequested.body);
    assert.equal(
      JSON.parse(rollbackRequested.body).request.id,
      "confirmation-configuration-rollback",
    );
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_request_rollback")
        .input,
      { targetVersion: 1, ...rollbackBinding },
    );

    const stale = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 2,
        expectedActiveVersion: 1,
      }),
    });
    assert.equal(stale.status, 409);

    const direct = await request(server, {
      method: "POST",
      path: "/api/configuration/rollback",
      headers: trustedConfigurationHeaders(),
      body: "{}",
    });
    assert.equal(direct.status, 404);
  });
});

test("active configuration HTTP rejects stale Active and draft baselines without side effects", async () => {
  await withActiveConfigurationServer(async ({
    server,
    calls,
    configurationStore,
    application,
  }) => {
    const changed = structuredClone(safeEditableConfiguration);
    changed.refreshMinutes += 1;
    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration: changed,
      }),
    });
    assert.equal(created.status, 201, created.body);
    const draft = JSON.parse(created.body).draft;
    const activationBinding = {
      draftId: draft.draftId,
      draftRevision: 1,
      expectedStateRevision: 2,
      expectedActiveVersion: 1,
    };
    const prepared = await configurationStore.prepareDraftActivation(
      activationBinding,
    );
    await configurationStore.activateDraft({
      ...prepared,
      activatedBy: "owner:local",
    });
    application.configuration.status.activeVersion = 2;
    application.config = structuredClone(changed);

    let reviseCalls = 0;
    application.configuration.draftManager = {
      async reviseDraft(input) {
        reviseCalls += 1;
        return configurationStore.reviseDraft(input);
      },
    };
    const revisedConfiguration = structuredClone(changed);
    revisedConfiguration.refreshMinutes += 1;
    const routeRequests = (expectedActiveVersion) => [
      {
        method: "PUT",
        path: `/api/configuration/drafts/${draft.draftId}`,
        body: {
          expectedDraftRevision: 1,
          expectedStateRevision: 3,
          expectedActiveVersion,
          configuration: revisedConfiguration,
        },
      },
      {
        method: "POST",
        path: `/api/configuration/drafts/${draft.draftId}/preview`,
        body: {
          draftRevision: 1,
          expectedStateRevision: 3,
          expectedActiveVersion,
        },
      },
      {
        method: "POST",
        path: `/api/configuration/drafts/${draft.draftId}/request-confirmation`,
        body: {
          draftRevision: 1,
          expectedStateRevision: 3,
          expectedActiveVersion,
        },
      },
    ];

    for (const expectedActiveVersion of [1, 2]) {
      for (const candidate of routeRequests(expectedActiveVersion)) {
        const response = await request(server, {
          method: candidate.method,
          path: candidate.path,
          headers: trustedConfigurationHeaders(),
          body: JSON.stringify(candidate.body),
        });
        assert.equal(
          response.status,
          409,
          `${candidate.method} ${candidate.path}: ${response.body}`,
        );
      }
    }

    assert.equal(reviseCalls, 0);
    assert.equal(
      calls.filter(
        ({ operation }) => operation === "configuration_request_activation",
      ).length,
      0,
    );
    const snapshot = await configurationStore.readSnapshot();
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.activeVersion, 2);
    assert.equal(snapshot.draftHeads[0].revision, 1);
  });
});

test("active configuration mutations preserve the local owner trust boundary", async () => {
  await withActiveConfigurationServer(async ({ server }) => {
    const configuration = structuredClone(safeEditableConfiguration);
    configuration.refreshMinutes += 1;
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration,
      }),
    });
    const clientActor = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration,
        proposedBy: "attacker",
      }),
    });
    const rollbackExtraField = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        activatedBy: "attacker",
      }),
    });

    assert.equal(untrusted.status, 403);
    assert.equal(clientActor.status, 400);
    assert.equal(rollbackExtraField.status, 400);
  });

  await withSafeConfigurationServer(async ({ server }) => {
    const rollback = await request(server, {
      method: "POST",
      path: "/api/configuration/versions/1/rollback/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 0,
        expectedActiveVersion: 1,
      }),
    });
    assert.equal(rollback.status, 409);
  });
});

test("background work runs every registered employee after the initial refresh and on schedule", async () => {
  const calls = [];
  const timers = [];
  const clearedTimers = [];
  const employeeRegistry = {
    async runAll(options) {
      calls.push({ operation: "run_all", ...options });
    },
    schedules() {
      return [
        { id: "pr-reviewer", intervalMinutes: 3 },
        { id: "requirements-analyst", intervalMinutes: 11 },
      ];
    },
    async run(id, options) {
      calls.push({ operation: "run", id, ...options });
    },
  };
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry,
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
      },
    },
  };
  const setIntervalFn = (callback, milliseconds) => {
    const timer = {
      callback,
      milliseconds,
      unreferenced: false,
      unref() {
        this.unreferenced = true;
      },
    };
    timers.push(timer);
    return timer;
  };

  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn,
    clearIntervalFn(timer) {
      clearedTimers.push(timer);
    },
  });
  await backgroundWork.initialRefresh;

  assert.deepEqual(calls, [
    { operation: "refresh", notify: false },
    { operation: "run_all", trigger: "refresh_completed" },
  ]);
  assert.deepEqual(
    timers.map((timer) => timer.milliseconds),
    [7 * 60_000, 3 * 60_000, 11 * 60_000],
  );
  assert.equal(timers.every((timer) => timer.unreferenced), true);

  for (const timer of timers) await timer.callback();

  assert.deepEqual(calls.slice(2), [
    { operation: "refresh", notify: false },
    { operation: "run_all", trigger: "refresh_completed" },
    { operation: "run", id: "pr-reviewer", trigger: "scheduled" },
    {
      operation: "run",
      id: "requirements-analyst",
      trigger: "scheduled",
    },
  ]);

  await backgroundWork.stop();
  assert.deepEqual(clearedTimers, timers);

  const callsAfterStop = structuredClone(calls);
  for (const timer of timers) await timer.callback();
  assert.deepEqual(calls, callsAfterStop);
});

test("background work projects coordination before employees and their activity after", async () => {
  const calls = [];
  const employeeStarted = deferred();
  const releaseEmployee = deferred();
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runAll(options) {
        calls.push({ operation: "run_all", ...options });
        employeeStarted.resolve();
        await releaseEmployee.promise;
      },
    },
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
      },
    },
    workCoordination: {
      async intake() {
        calls.push({ operation: "intake" });
      },
      async runCycle(options) {
        calls.push({ operation: "work_cycle", ...options });
      },
    },
    memoryProjector: {
      async runCycle() {
        calls.push({ operation: "memory_projection" });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  try {
    await employeeStarted.promise;
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      { operation: "intake" },
      {
        operation: "work_cycle",
        trigger: "refresh_completed",
        includeWork: false,
      },
      { operation: "memory_projection" },
      { operation: "run_all", trigger: "refresh_completed" },
    ]);
    releaseEmployee.resolve();
    await backgroundWork.initialRefresh;
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      { operation: "intake" },
      {
        operation: "work_cycle",
        trigger: "refresh_completed",
        includeWork: false,
      },
      { operation: "memory_projection" },
      { operation: "run_all", trigger: "refresh_completed" },
      { operation: "memory_projection" },
    ]);
  } finally {
    releaseEmployee.resolve();
    await backgroundWork.stop();
  }
});

test("background agency aggregate safely identifies both memory projection stages", async () => {
  const beforeFailure = Object.assign(
    new Error("before-memory-private-message"),
    {
      code: "MEMORY_BEFORE_FAILED",
      stdout: "before-memory-private-stdout",
      stderr: "before-memory-private-stderr",
      command: "before-memory-private-command",
      token: "before-memory-private-token",
      details: "before-memory-private-details",
    },
  );
  const afterFailure = new Error("after-memory-private-message");
  let getterCalls = 0;
  for (const property of [
    "code",
    "stdout",
    "stderr",
    "command",
    "token",
    "details",
  ]) {
    Object.defineProperty(afterFailure, property, {
      get() {
        getterCalls += 1;
        return property === "code"
          ? "MEMORY_AFTER_GETTER_MUST_NOT_RUN"
          : `after-memory-private-${property}`;
      },
    });
  }
  const reportedErrors = [];
  const application = startupApplication();
  let projectionCalls = 0;
  application.memoryProjector = {
    async runCycle() {
      projectionCalls += 1;
      throw projectionCalls === 1 ? beforeFailure : afterFailure;
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    reportError(error) {
      reportedErrors.push(error);
    },
  });

  try {
    await backgroundWork.initialRefresh;

    assert.equal(projectionCalls, 2);
    assert.equal(reportedErrors.length, 1);
    const [aggregate] = reportedErrors;
    assert.equal(aggregate instanceof AggregateError, true);
    assert.strictEqual(aggregate.errors[0], beforeFailure);
    assert.strictEqual(aggregate.errors[1], afterFailure);
    assert.equal(
      aggregate.message,
      "员工主动循环、旧岗位巡查或记忆投影失败: " +
        "memory_before_employee [MEMORY_BEFORE_FAILED], " +
        "memory_after_employee",
    );
    assert.equal(getterCalls, 0);
    for (const secret of [
      "before-memory-private-message",
      "before-memory-private-stdout",
      "before-memory-private-stderr",
      "before-memory-private-command",
      "before-memory-private-token",
      "before-memory-private-details",
      "MEMORY_AFTER_GETTER_MUST_NOT_RUN",
    ]) {
      assert.equal(aggregate.message.includes(secret), false, secret);
    }
  } finally {
    await backgroundWork.stop();
  }
});

test("background agency summary keeps mixed stages while filtering abort identity", async () => {
  const coordinationFailure = Object.assign(
    new Error("coordination-private-message"),
    { code: "COORDINATION_FAILED", details: "coordination-private-details" },
  );
  const memoryFailure = Object.assign(
    new Error("memory-private-message"),
    { code: "memory-private-code", command: "memory-private-command" },
  );
  const employeeFailure = Object.assign(
    new Error("employee-private-message"),
    { code: "EMPLOYEE_FAILED", token: "employee-private-token" },
  );
  const afterMemoryStarted = deferred();
  const reportedErrors = [];
  let abortReason = null;
  let projectionCalls = 0;
  const application = startupApplication({
    async runAll() {
      throw employeeFailure;
    },
  });
  application.workCoordination = {
    async runCycle() {
      throw coordinationFailure;
    },
  };
  application.memoryProjector = {
    async runCycle({ signal }) {
      projectionCalls += 1;
      if (projectionCalls === 1) throw memoryFailure;
      afterMemoryStarted.resolve();
      await new Promise((resolve, reject) => {
        const rejectWithAbort = () => {
          abortReason = signal.reason;
          reject(abortReason);
        };
        if (signal.aborted) rejectWithAbort();
        else signal.addEventListener("abort", rejectWithAbort, { once: true });
      });
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 500,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  const initialFailure = backgroundWork.initialRefresh.then(
    () => null,
    (error) => error,
  );

  try {
    await afterMemoryStarted.promise;
    const stoppingFailure = backgroundWork.stop().then(
      () => null,
      (error) => error,
    );
    const [aggregate, drainFailure] = await Promise.all([
      initialFailure,
      stoppingFailure,
    ]);

    assert.equal(aggregate instanceof AggregateError, true);
    assert.strictEqual(drainFailure, aggregate);
    assert.strictEqual(aggregate.errors[0], coordinationFailure);
    assert.strictEqual(aggregate.errors[1], memoryFailure);
    assert.strictEqual(aggregate.errors[2], employeeFailure);
    assert.equal(aggregate.errors.includes(abortReason), false);
    assert.equal(abortReason?.code, "LIFECYCLE_SHUTDOWN_ABORTED");
    assert.equal(
      aggregate.message,
      "员工主动循环、旧岗位巡查或记忆投影失败: " +
        "coordination [COORDINATION_FAILED], " +
        "memory_before_employee, employee [EMPLOYEE_FAILED]",
    );
    for (const secret of [
      "coordination-private-message",
      "coordination-private-details",
      "memory-private-message",
      "memory-private-code",
      "memory-private-command",
      "employee-private-message",
      "employee-private-token",
      "LIFECYCLE_SHUTDOWN_ABORTED",
      "memory_after_employee",
    ]) {
      assert.equal(aggregate.message.includes(secret), false, secret);
    }
    assert.deepEqual(reportedErrors, [aggregate]);
  } finally {
    await Promise.allSettled([
      backgroundWork.stop(),
      backgroundWork.initialRefresh,
    ]);
  }
});

test("workflow routing observes every refreshed snapshot before confirmations and employees", async () => {
  const calls = [];
  const timers = [];
  let snapshot = null;
  let refreshNumber = 0;
  let backgroundWork;
  const application = {
    config: { refreshMinutes: 7 },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      async refresh(options) {
        refreshNumber += 1;
        snapshot = {
          cycle: refreshNumber,
          sourceStatus: { githubPullRequests: { ok: true } },
        };
        calls.push({ operation: "refresh", cycle: refreshNumber, ...options });
      },
    },
    workflowRouting: {
      async ingestSnapshot({ snapshot: routedSnapshot }) {
        assert.equal(backgroundWork.confirmationReady(), false);
        calls.push({ operation: "route", cycle: routedSnapshot.cycle });
      },
    },
    employeeRegistry: {
      get(id) {
        if (id !== "pr-reviewer") return null;
        return {
          async recoverConfirmations() {
            assert.equal(backgroundWork.confirmationReady(), false);
            calls.push({ operation: "recover", cycle: snapshot.cycle });
          },
        };
      },
      schedules() {
        return [];
      },
      async runAll(options) {
        assert.equal(backgroundWork.confirmationReady(), true);
        calls.push({ operation: "run_all", cycle: snapshot.cycle, ...options });
      },
    },
    confirmationQueue: {},
  };

  backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), true);

    await timers[0].callback();
    assert.equal(backgroundWork.confirmationReady(), true);

    await backgroundWork.refresh({ notify: true });
    assert.equal(backgroundWork.confirmationReady(), true);

    assert.deepEqual(calls, [
      { operation: "refresh", cycle: 1, notify: false },
      { operation: "route", cycle: 1 },
      { operation: "recover", cycle: 1 },
      { operation: "run_all", cycle: 1, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 2, notify: false },
      { operation: "route", cycle: 2 },
      { operation: "recover", cycle: 2 },
      { operation: "run_all", cycle: 2, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 3, notify: true },
      { operation: "route", cycle: 3 },
      { operation: "recover", cycle: 3 },
      { operation: "run_all", cycle: 3, trigger: "refresh_completed" },
    ]);
  } finally {
    await backgroundWork.stop();
  }
});

test("workflow routing failure keeps confirmations closed and skips employees", async () => {
  const calls = [];
  const timers = [];
  const reportedErrors = [];
  const routingFailure = new Error("workflow routing failed");
  let snapshot = null;
  let refreshNumber = 0;
  let routingCalls = 0;
  const application = {
    config: { refreshMinutes: 7 },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      async refresh(options) {
        refreshNumber += 1;
        snapshot = {
          cycle: refreshNumber,
          sourceStatus: { githubPullRequests: { ok: true } },
        };
        calls.push({ operation: "refresh", cycle: refreshNumber, ...options });
      },
    },
    workflowRouting: {
      async ingestSnapshot({ snapshot: routedSnapshot }) {
        routingCalls += 1;
        calls.push({ operation: "route", cycle: routedSnapshot.cycle });
        if (routingCalls > 1) throw routingFailure;
      },
    },
    employeeRegistry: {
      get(id) {
        if (id !== "pr-reviewer") return null;
        return {
          async recoverConfirmations() {
            calls.push({ operation: "recover", cycle: snapshot.cycle });
          },
        };
      },
      schedules() {
        return [];
      },
      async runAll(options) {
        calls.push({ operation: "run_all", cycle: snapshot.cycle, ...options });
      },
    },
    confirmationQueue: {},
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
    reportError(error) {
      reportedErrors.push(error);
    },
  });

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), true);

    await timers[0].callback();
    assert.equal(backgroundWork.confirmationReady(), false);

    await assert.rejects(
      backgroundWork.refresh({ notify: true }),
      (error) => error === routingFailure,
    );
    assert.equal(backgroundWork.confirmationReady(), false);

    assert.deepEqual(calls, [
      { operation: "refresh", cycle: 1, notify: false },
      { operation: "route", cycle: 1 },
      { operation: "recover", cycle: 1 },
      { operation: "run_all", cycle: 1, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 2, notify: false },
      { operation: "route", cycle: 2 },
      { operation: "refresh", cycle: 3, notify: true },
      { operation: "route", cycle: 3 },
    ]);
    assert.deepEqual(reportedErrors, [routingFailure, routingFailure]);
  } finally {
    await backgroundWork.stop();
  }
});

test("background stop waits for initial refresh and suppresses its employee callback", async () => {
  let finishRefresh;
  let refreshStarted;
  const started = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  const calls = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runAll(options) {
        calls.push({ operation: "run_all", ...options });
      },
    },
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
        refreshStarted();
        await new Promise((resolve) => {
          finishRefresh = resolve;
        });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application);
  await started;

  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  finishRefresh();
  await stopping;
  assert.deepEqual(calls, [{ operation: "refresh", notify: false }]);
});

test("background stop waits for a tracked scheduled task", async () => {
  let finishScheduledRun;
  let scheduledRunStarted;
  const started = new Promise((resolve) => {
    scheduledRunStarted = resolve;
  });
  const timers = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "pr-reviewer", intervalMinutes: 3 }];
      },
      async runAll() {},
      async run() {
        scheduledRunStarted();
        await new Promise((resolve) => {
          finishScheduledRun = resolve;
        });
      },
    },
    refreshService: {
      async refresh() {},
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;

  const scheduledRun = timers[1].callback();
  await started;
  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  finishScheduledRun();
  await Promise.all([scheduledRun, stopping]);
  assert.equal(stopped, true);
});

test("scheduled employees stay behind the confirmation gate when facts are stale", async () => {
  const timers = [];
  const employeeRuns = [];
  const application = {
    config: { refreshMinutes: 7 },
    confirmationQueue: {},
    store: {
      async read(name) {
        if (name !== "snapshot") return null;
        return {
          sourceStatus: {
            githubPullRequests: { ok: false, stale: true },
          },
        };
      },
    },
    employeeRegistry: {
      get() {
        return null;
      },
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids, options) {
        employeeRuns.push({ ids, ...options });
      },
    },
    refreshService: {
      async refresh() {},
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), false);

    await timers[1].callback();

    assert.deepEqual(employeeRuns, []);
  } finally {
    await backgroundWork.stop();
  }
});

test("scheduled and manual employees wait for refresh without an external queue", async () => {
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const timers = [];
  const employeeRuns = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids, options) {
        employeeRuns.push({ ids, ...options });
      },
    },
    refreshService: {
      async refresh() {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await refreshStarted.promise;
    const scheduled = timers[1].callback();
    const manual = backgroundWork.runEmployee("developer");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(employeeRuns, []);

    releaseRefresh.resolve();
    await Promise.all([backgroundWork.initialRefresh, scheduled, manual]);

    assert.deepEqual(employeeRuns, [
      { ids: ["pr-reviewer"], trigger: "refresh_completed" },
      { ids: ["developer"], trigger: "manual" },
      { ids: ["requirements-analyst"], trigger: "scheduled" },
    ]);
  } finally {
    releaseRefresh.resolve();
    await backgroundWork.stop();
  }
});

test("exact internal question status is read-only and rejects query parameters", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  let reads = 0;
  await withServer(async ({ server }) => {
    const result = await request(server, { path: `/api/attention/internal/${requestId}` });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { item: { requestId, status: "archived" } });
    assert.equal((await request(server, { path: `/api/attention/internal/${requestId}?answer=yes` })).status, 400);
    assert.equal(reads, 1);
  }, { attentionBrowser: { async readStatus(input) {
    reads++;
    assert.deepEqual(input, { requestId });
    return { requestId, status: "archived" };
  } } });
});

test("maintenance requests are a read-only separate endpoint", async () => {
  let reads = 0;
  const faults = { items: [{ requestId: `attention-${"a".repeat(64)}`, maintenanceCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" }], total: 1 };
  await withServer(async ({ server }) => {
    const result = await request(server, { path: "/api/attention/maintenance" });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), faults);
    assert.equal((await request(server, { path: "/api/attention/maintenance?unknown=1" })).status, 400);
    assert.equal(reads, 1);
  }, { attentionBrowser: { async listMaintenance() { reads += 1; return faults; } } });
});

test("Review runs while a developer is busy and drains on shutdown", async () => {
  const developerStarted = deferred();
  const releaseDeveloper = deferred();
  let reviewRunning = false;
  const releaseReview = deferred();
  const timers = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules: () => [{ id: "developer", intervalMinutes: 10 }, { id: "pr-engineer", intervalMinutes: 10 }],
      async runSelected(ids) {
        if (ids[0] === "developer") {
          developerStarted.resolve();
          await releaseDeveloper.promise;
        }
        if (ids[0] === "pr-engineer") {
          reviewRunning = true;
          await releaseReview.promise;
        }
      },
    },
    refreshService: { async refresh() {} },
  };
  const background = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn() {},
  });
  try {
    await background.initialRefresh;
    const developer = timers[1].callback();
    await developerStarted.promise;
    const review = timers[2].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reviewRunning, true,
      "a busy developer must not hold the Review scheduler");
    let stopped = false;
    const stopping = background.stop().then(() => { stopped = true; });
    releaseDeveloper.resolve();
    await developer;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "shutdown must still drain the independent Review");
    releaseReview.resolve();
    await Promise.all([review, stopping]);
  } finally {
    releaseDeveloper.resolve(); releaseReview.resolve();
    await background.stop();
  }
});

test("Review waits for fresh facts, coalesces ticks and cancels a startup wait on stop", async () => {
  const releaseRefresh = deferred();
  const releaseReview = deferred();
  const timers = [];
  let runs = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules: () => [{ id: "pr-engineer", intervalMinutes: 10 }],
      async runSelected(ids) {
        if (ids[0] !== "pr-engineer") return;
        runs += 1;
        await releaseReview.promise;
      },
    },
    refreshService: { async refresh() { await releaseRefresh.promise; } },
  };
  const background = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn() {},
  });
  try {
    const first = timers[1].callback();
    const second = timers[1].callback();
    const manual = background.runEmployee("pr-engineer");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 0);
    releaseRefresh.resolve();
    await background.initialRefresh;
    assert.equal(runs, 1);
    releaseReview.resolve();
    await Promise.all([first, second, manual]);
  } finally {
    releaseRefresh.resolve(); releaseReview.resolve();
    await background.stop();
  }

  const pendingRefresh = deferred();
  const pending = startApplicationBackgroundWork({ ...application, refreshService: {
    async refresh() { await pendingRefresh.promise; },
  } }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
  const review = pending.runEmployee("pr-engineer");
  const stopping = pending.stop();
  pendingRefresh.resolve();
  await Promise.all([review, stopping, pending.initialRefresh]);
  assert.equal(runs, 1, "stopping before startup facts must not run Review");
});

test("Review without fresh facts does not hold maintenance admission", { timeout: 2_000 }, async () => {
  const timers = [];
  const gate = new OperationalQuiescenceGate({ drainTimeoutMs: 100 });
  let runs = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7 },
    operations: { admission: { run: gate.run.bind(gate) } },
    employeeRegistry: {
      schedules: () => [{ id: "pr-engineer", intervalMinutes: 10 }],
      async runSelected() { runs += 1; },
    },
    refreshService: { async refresh() { throw new Error("upstream unavailable"); } },
  }, {
    setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn() {}, reportError() {},
  });
  try {
    await assert.rejects(background.initialRefresh, /upstream unavailable/);
    const review = timers[1].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.readStatus().activeOperations, 0);
    const token = await gate.enter();
    gate.leave(token);
    await review;
    assert.equal(runs, 0);
  } finally { await background.stop(); }
});

test("maintenance drains active Review and blocks manual Review while closed", async () => {
  const gate = new OperationalQuiescenceGate();
  const started = deferred();
  const release = deferred();
  const errors = [];
  let reviews = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7 },
    operations: { admission: { run: gate.run.bind(gate) } },
    employeeRegistry: {
      schedules: () => [],
      async runSelected(ids) {
        if (ids[0] !== "pr-engineer") return;
        reviews += 1; started.resolve(); await release.promise;
      },
    },
    refreshService: { async refresh() {} },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError(error) { errors.push(error); } });
  try {
    await background.initialRefresh;
    const review = background.runEmployee("pr-engineer");
    await started.promise;
    assert.equal(gate.readStatus().activeOperations, 1);
    const closing = gate.enter();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.readStatus().mode, "closing");
    release.resolve();
    await review;
    const token = await closing;
    await assert.rejects(background.runEmployee("pr-engineer"), { code: "SYSTEM_QUIESCING" });
    assert.equal(reviews, 1);
    gate.leave(token);
    assert.equal(errors.length, 1);
  } finally { release.resolve(); await background.stop(); }
});

test("Review waits for a newer refresh queued behind a developer", async () => {
  const timers = [];
  const developerStarted = deferred();
  const releaseDeveloper = deferred();
  const releaseRefresh = deferred();
  let refreshes = 0;
  let reviews = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules: () => [{ id: "developer", intervalMinutes: 10 }, { id: "pr-engineer", intervalMinutes: 11 }],
      async runSelected(ids) {
        if (ids[0] === "developer") { developerStarted.resolve(); await releaseDeveloper.promise; }
        if (ids[0] === "pr-engineer") reviews += 1;
      },
    },
    refreshService: { async refresh() { if (++refreshes > 1) await releaseRefresh.promise; } },
  }, {
    setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn() {},
  });
  try {
    await background.initialRefresh;
    const developer = timers[1].callback();
    await developerStarted.promise;
    const refresh = timers[0].callback();
    const review = timers[2].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reviews, 0, "a known newer refresh must invalidate the admitted snapshot");
    releaseDeveloper.resolve();
    await developer;
    releaseRefresh.resolve();
    await Promise.all([refresh, review]);
    assert.equal(reviews, 1);
  } finally {
    releaseDeveloper.resolve(); releaseRefresh.resolve(); await background.stop();
  }
});

for (const blocker of ["memory projection", "legacy patrol"]) {
  for (const roleId of ["developer", "orchestrator", "tester"]) {
    test(`automatic ${roleId} bypasses stalled ${blocker}, coalesces manual ticks and drains`, async () => {
      const blocked = deferred();
      const releaseBlocked = deferred();
      const releaseRole = deferred();
      const timers = [];
      let roleRuns = 0;
      let handoffs = 0;
      const background = startApplicationBackgroundWork({
        config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
        employeeRegistry: {
          schedules: () => [{ id: roleId, intervalMinutes: 10 }],
          async runSelected(ids) {
            if (ids[0] === "pr-reviewer" && blocker === "legacy patrol") {
              blocked.resolve(); await releaseBlocked.promise;
            }
            if (ids[0] !== roleId) return;
            roleRuns += 1;
            await releaseRole.promise;
          },
        },
        refreshService: { async refresh() {} },
        ...(blocker === "memory projection" ? {
          memoryProjector: { async runCycle() { blocked.resolve(); await releaseBlocked.promise; } },
        } : {}),
        reviewHandoffReconciler: { async runCycle() { handoffs += 1; } },
      }, {
        setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
        clearIntervalFn() {},
      });
      try {
        await blocked.promise;
        const handoffsBeforeRole = handoffs;
        const scheduled = timers[1].callback();
        const manual = background.runEmployee(roleId);
        manual.catch(() => {});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(roleRuns, 1, "fresh role handoffs must not wait for optional memory or legacy work");
        assert.equal(handoffs, handoffsBeforeRole, "other roles must not run Review-only handoff recovery");
        assert.ok(background.drainStatus().activeParticipants.some(
          ({ id }) => id === DRAIN_PARTICIPANTS.employeeExecution.id,
        ));
        const refreshed = background.initialRefresh;
        const manualStopped = assert.rejects(manual, { code: "LIFECYCLE_SHUTDOWN_ABORTED" });
        let stopped = false;
        const stopping = background.stop().then(() => { stopped = true; });
        releaseBlocked.resolve();
        await refreshed;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(stopped, false, "shutdown must drain the independent role");
        assert.equal(background.drainStatus().backgroundOperationActive, true);
        releaseRole.resolve();
        await Promise.all([scheduled, manualStopped, stopping]);
        assert.equal(roleRuns, 1, "manual and scheduled requests must share one role cycle");
      } finally {
        releaseBlocked.resolve(); releaseRole.resolve(); await background.stop();
      }
    });
 }
}

for (const roleId of ["developer", "orchestrator", "tester"]) {
  test(`automatic ${roleId} uses scoped coordination while general code jobs are busy`, async () => {
    const codeJobsStarted = deferred();
    const releaseCodeJobs = deferred();
    const workScopes = [];
    const noOpCycle = { async runCycle() {} };
    const coordination = new WorkCoordinationService({
      ledger: { async intake() {} },
      proposalResultReconciler: noOpCycle,
      attentionResultReconciler: noOpCycle,
      conditionWaker: noOpCycle,
      codeJobRunner: { async runCycle() { codeJobsStarted.resolve(); await releaseCodeJobs.promise; } },
      workLoop: { async runCycle(options) { workScopes.push(options); } },
      dispatcher: { async dispatchPending() {} },
    });
    const registry = new EmployeeRegistry(["pr-reviewer", roleId].map((id) => ({
      id,
      async view() {},
      async roleView() {},
      async control() {},
      run(options) {
        return id === roleId ? coordination.runCycle({
          trigger: `employee:${roleId}`, includeWork: true, roleId: id, signal: options.signal,
        }) : Promise.resolve();
      },
    })));
    const background = startApplicationBackgroundWork({
      config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: roleId === "developer", automaticReview: roleId !== "developer" } },
      employeeRegistry: registry,
      workCoordination: coordination,
      refreshService: { async refresh() {} },
    }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
    try {
      await codeJobsStarted.promise;
      const roleRun = background.runEmployee(roleId);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(workScopes.length, 1, "scoped role decisions must not wait for general code jobs");
      assert.equal(workScopes[0].roleId, roleId);
      assert.equal(workScopes[0].trigger, `employee:${roleId}`);
      assert.equal(workScopes[0].signal instanceof AbortSignal, true);
      assert.equal(workScopes[0].signal.aborted, false);
      await roleRun;
      releaseCodeJobs.resolve();
      await background.initialRefresh;
    } finally { releaseCodeJobs.resolve(); await background.stop(); }
  });
}

for (const roleId of ["developer", "orchestrator", "pr-engineer", "tester"]) {
  test(`automatic ${roleId} waits for refreshing facts without waiting for another role`, async () => {
    const timers = [];
    const generalStarted = deferred();
    const releaseGeneral = deferred();
    const releaseRefresh = deferred();
    let refreshes = 0;
    let roleRuns = 0;
    const background = startApplicationBackgroundWork({
      config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true, automaticReview: true } },
      employeeRegistry: {
        schedules: () => [{ id: "requirements-analyst", intervalMinutes: 10 }, { id: roleId, intervalMinutes: 11 }],
        async runSelected(ids) {
          if (ids[0] === "requirements-analyst") { generalStarted.resolve(); await releaseGeneral.promise; }
          if (ids[0] === roleId) roleRuns += 1;
        },
      },
      refreshService: { async refresh() { if (++refreshes > 1) await releaseRefresh.promise; } },
    }, {
      setIntervalFn(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
      clearIntervalFn() {},
    });
    try {
      await background.initialRefresh;
      let generalSettled = false;
      const general = timers[1].callback().finally(() => { generalSettled = true; });
      await generalStarted.promise;
      const refresh = timers[0].callback();
      const role = timers[2].callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(refreshes, 2, "refresh must begin while general work is still running");
      assert.equal(roleRuns, 0, "an actively refreshing snapshot must finish admission before new role work");
      releaseRefresh.resolve();
      await Promise.all([refresh, role]);
      assert.equal(roleRuns, 1);
      assert.equal(generalSettled, false, "newly admitted facts must release other roles before the long role ends");
      await background.runEmployee(roleId);
      assert.equal(roleRuns, 2);
      releaseGeneral.resolve(); await general;
    } finally {
      releaseGeneral.resolve(); releaseRefresh.resolve(); await background.stop();
    }
  });
}

test("automatic role waiters resume and later refreshes do not wait for general work", async () => {
  const refreshing = deferred(), releaseRefresh = deferred();
  const general = deferred(), releaseGeneral = deferred();
  let refreshes = 0, roleRuns = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticReview: true } },
    employeeRegistry: {
      schedules: () => [],
      async runSelected(ids) {
        if (ids[0] === "requirements-analyst") { general.resolve(); await releaseGeneral.promise; }
        if (ids[0] === "orchestrator") roleRuns += 1;
      },
    },
    refreshService: { async refresh() {
      if (++refreshes === 1) { refreshing.resolve(); await releaseRefresh.promise; }
    } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
  try {
    await refreshing.promise;
    const role = background.runEmployee("orchestrator");
    const generalRun = background.runEmployee("requirements-analyst");
    const nextRefresh = background.refresh({ notify: true });
    releaseRefresh.resolve();
    await general.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshes, 2, "the next refresh must not queue behind general role work");
    assert.equal(roleRuns, 1, "existing role waiters must use the now fully admitted facts");
    releaseGeneral.resolve();
    await Promise.all([role, generalRun, nextRefresh, background.initialRefresh]);
  } finally { releaseRefresh.resolve(); releaseGeneral.resolve(); await background.stop(); }
});

test("memory authority deferrals remain visible while automatic employee work continues", async () => {
  const logs = [], errors = [];
  let employees = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7 },
    employeeRegistry: { schedules: () => [], async runSelected() { employees++; } },
    refreshService: { async refresh() {} },
    memoryProjector: { async runCycle() { return { authorityBound: {
      status: "deferred", code: "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE", attempts: 2,
    } }; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {},
    log: value => logs.push(value), reportError: value => errors.push(value) });
  try {
    await background.initialRefresh;
    await background.runEmployee("tester", { trigger: "scheduled" });
    assert.ok(employees > 0);
    assert.equal(errors.length, 0);
    assert.ok(logs.some(value => /memory_before_employee.*WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE/u.test(value)));
    assert.ok(logs.some(value => /memory_after_employee.*WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE/u.test(value)));
  } finally { await background.stop(); }
});

test("automatic own-PR developer cancels a startup fact wait on stop", async () => {
  const releaseRefresh = deferred();
  let developers = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    employeeRegistry: {
      schedules: () => [],
      async runSelected(ids) { if (ids[0] === "developer") developers += 1; },
    },
    refreshService: { async refresh() { await releaseRefresh.promise; } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
  try {
    const developer = background.runEmployee("developer");
    const refreshing = assert.rejects(background.initialRefresh, { code: "LIFECYCLE_SHUTDOWN_ABORTED" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(developers, 0);
    const stopping = background.stop();
    releaseRefresh.resolve();
    await Promise.all([developer, stopping, refreshing]);
    assert.equal(developers, 0);
  } finally { releaseRefresh.resolve(); await background.stop(); }
});

test("automatic own-PR developer respects maintenance admission and drain", async () => {
  const gate = new OperationalQuiescenceGate();
  const started = deferred();
  const release = deferred();
  let developers = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    operations: { admission: { run: gate.run.bind(gate) } },
    employeeRegistry: {
      schedules: () => [],
      async runSelected(ids) {
        if (ids[0] !== "developer") return;
        developers += 1; started.resolve(); await release.promise;
      },
    },
    refreshService: { async refresh() {} },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  try {
    await background.initialRefresh;
    const developer = background.runEmployee("developer");
    await started.promise;
    const closing = gate.enter();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.readStatus().mode, "closing");
    release.resolve();
    await developer;
    const token = await closing;
    await assert.rejects(background.runEmployee("developer"), { code: "SYSTEM_QUIESCING" });
    assert.equal(developers, 1);
    gate.leave(token);
  } finally { release.resolve(); await background.stop(); }
});

test("automatic own-PR developer without fresh facts does not hold maintenance admission", async () => {
  const gate = new OperationalQuiescenceGate({ drainTimeoutMs: 100 });
  let developers = 0;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    operations: { admission: { run: gate.run.bind(gate) } },
    employeeRegistry: {
      schedules: () => [],
      async runSelected(ids) { if (ids[0] === "developer") developers += 1; },
    },
    refreshService: { async refresh() { throw new Error("upstream unavailable"); } },
  }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {}, reportError() {} });
  try {
    await assert.rejects(background.initialRefresh, /upstream unavailable/);
    await background.runEmployee("developer");
    assert.equal(gate.readStatus().activeOperations, 0);
    const token = await gate.enter();
    gate.leave(token);
    assert.equal(developers, 0);
  } finally { await background.stop(); }
});

for (const githubActions of [undefined, { enabled: true },
  { enabled: true, automaticOwnPrRepair: false }, { enabled: false, automaticOwnPrRepair: true }]) {
  test(`developer keeps serialized scheduling without enabled automatic own-PR repair: ${JSON.stringify(githubActions)}`, async () => {
    const memoryStarted = deferred();
    const releaseMemory = deferred();
    let developers = 0;
    const background = startApplicationBackgroundWork({
      config: { refreshMinutes: 7, githubActions },
      employeeRegistry: {
        schedules: () => [],
        async runSelected(ids) { if (ids[0] === "developer") developers += 1; },
      },
      refreshService: { async refresh() {} },
      memoryProjector: { async runCycle() { memoryStarted.resolve(); await releaseMemory.promise; } },
    }, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
    try {
      await memoryStarted.promise;
      const developer = background.runEmployee("developer");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(developers, 0);
      releaseMemory.resolve();
      await Promise.all([background.initialRefresh, developer]);
      assert.equal(developers, 1);
    } finally { releaseMemory.resolve(); await background.stop(); }
  });
}

test("overlapping scheduled role and refresh ticks are coalesced", async () => {
  const roleStarted = deferred();
  const releaseRole = deferred();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const timers = [];
  let refreshCount = 0;
  let roleRunCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids) {
        if (ids[0] !== "requirements-analyst") return;
        roleRunCount += 1;
        roleStarted.resolve();
        await releaseRole.promise;
      },
    },
    refreshService: {
      async refresh() {
        refreshCount += 1;
        if (refreshCount === 1) return;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    const firstRoleTick = timers[1].callback();
    await roleStarted.promise;
    const overlappingRoleTick = timers[1].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(roleRunCount, 1);
    releaseRole.resolve();
    await Promise.all([firstRoleTick, overlappingRoleTick]);
    assert.equal(roleRunCount, 1);

    const firstRefreshTick = timers[0].callback();
    await refreshStarted.promise;
    const overlappingRefreshTick = timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCount, 2);
    releaseRefresh.resolve();
    await Promise.all([firstRefreshTick, overlappingRefreshTick]);
    assert.equal(refreshCount, 2);
  } finally {
    releaseRole.resolve();
    releaseRefresh.resolve();
    await backgroundWork.stop();
  }
});

test("coalesced scheduled role ticks occupy one operational admission", async () => {
  const roleStarted = deferred();
  const releaseRole = deferred();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const timers = [];
  const gate = new OperationalQuiescenceGate();
  let roleRunCount = 0;
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    operations: {
      admission: { run: gate.run.bind(gate) },
    },
    employeeRegistry: {
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids) {
        if (ids[0] !== "requirements-analyst") return;
        roleRunCount += 1;
        roleStarted.resolve();
        await releaseRole.promise;
      },
    },
    refreshService: {
      async refresh() {
        refreshCount += 1;
        if (refreshCount === 1) return;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  const pending = [];

  try {
    await backgroundWork.initialRefresh;
    pending.push(timers[1].callback());
    await roleStarted.promise;
    for (let index = 0; index < 20; index += 1) {
      pending.push(timers[1].callback());
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(roleRunCount, 1);
    assert.deepEqual(gate.readStatus(), {
      mode: "open",
      activeOperations: 1,
    });

    releaseRole.resolve();
    await Promise.all(pending);
    assert.deepEqual(gate.readStatus(), {
      mode: "open",
      activeOperations: 0,
    });

    pending.push(timers[0].callback());
    await refreshStarted.promise;
    for (let index = 0; index < 20; index += 1) {
      pending.push(timers[0].callback());
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(refreshCount, 2);
    assert.deepEqual(gate.readStatus(), {
      mode: "open",
      activeOperations: 1,
    });

    releaseRefresh.resolve();
    await Promise.all(pending);
    assert.deepEqual(gate.readStatus(), {
      mode: "open",
      activeOperations: 0,
    });
  } finally {
    releaseRole.resolve();
    releaseRefresh.resolve();
    await Promise.allSettled(pending);
    await backgroundWork.stop();
  }
});

test("queued periodic roles do not occupy or survive quiescence", {
  timeout: 2_000,
}, async () => {
  const firstRoleStarted = deferred();
  const releaseFirstRole = deferred();
  const timers = [];
  const calls = [];
  const reportedErrors = [];
  const gate = new OperationalQuiescenceGate({ drainTimeoutMs: 500 });
  const application = {
    config: { refreshMinutes: 7 },
    operations: {
      admission: { run: gate.run.bind(gate) },
    },
    workCoordination: {
      async runCycle({ trigger }) {
        calls.push({ operation: "coordination", trigger });
      },
    },
    employeeRegistry: {
      schedules() {
        return [
          { id: "requirements-analyst", intervalMinutes: 11 },
          { id: "developer", intervalMinutes: 13 },
        ];
      },
      async runSelected(ids, { trigger }) {
        calls.push({ operation: "employee", id: ids[0], trigger });
        if (ids[0] === "requirements-analyst") {
          firstRoleStarted.resolve();
          await releaseFirstRole.promise;
        }
      },
    },
    memoryProjector: {
      async runCycle() {
        calls.push({ operation: "memory" });
      },
    },
    refreshService: {
      async refresh() {},
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  const pendingTicks = [];
  let entering = null;
  let maintenanceToken = null;

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;

    pendingTicks.push(timers[1].callback());
    await firstRoleStarted.promise;
    pendingTicks.push(timers[2].callback());
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(gate.readStatus(), {
      mode: "open",
      activeOperations: 1,
    });

    entering = gate.enter();
    assert.deepEqual(gate.readStatus(), {
      mode: "closing",
      activeOperations: 1,
    });
    releaseFirstRole.resolve();
    maintenanceToken = await entering;
    assert.deepEqual(gate.readStatus(), {
      mode: "closed",
      activeOperations: 0,
    });
    await Promise.all(pendingTicks);
    assert.deepEqual(calls, [
      { operation: "coordination", trigger: "scheduled" },
      { operation: "memory" },
      {
        operation: "employee",
        id: "requirements-analyst",
        trigger: "scheduled",
      },
      { operation: "memory" },
    ]);
    assert.deepEqual(
      reportedErrors.map((error) => error.code),
      ["SYSTEM_QUIESCING"],
    );

    gate.leave(maintenanceToken);
    maintenanceToken = null;
    await timers[2].callback();
    assert.deepEqual(calls.slice(-4), [
      { operation: "coordination", trigger: "scheduled" },
      { operation: "memory" },
      { operation: "employee", id: "developer", trigger: "scheduled" },
      { operation: "memory" },
    ]);
  } finally {
    releaseFirstRole.resolve();
    if (entering && gate.readStatus().mode === "closing") {
      try {
        maintenanceToken = await entering;
      } catch {
        maintenanceToken = null;
      }
    }
    if (maintenanceToken && gate.readStatus().mode === "closed") {
      gate.leave(maintenanceToken);
    }
    await Promise.allSettled(pendingTicks);
    await backgroundWork.stop();
  }
});

test("a pending refresh skips obsolete queued role ticks", async () => {
  const firstRoleStarted = deferred();
  const releaseFirstRole = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [
          { id: "requirements-analyst", intervalMinutes: 11 },
          { id: "developer", intervalMinutes: 13 },
        ];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          firstRoleStarted.resolve();
          await releaseFirstRole.promise;
        }
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeRole = timers[1].callback();
    await firstRoleStarted.promise;
    const obsoleteRole = timers[2].callback();
    const refresh = timers[0].callback();
    releaseFirstRole.resolve();
    await Promise.all([activeRole, obsoleteRole, refresh]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "scheduled",
      },
      { operation: "refresh", count: 2, notify: false },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);

    await timers[2].callback();
    assert.deepEqual(calls.at(-1), {
      operation: "run",
      ids: ["developer"],
      trigger: "scheduled",
    });
  } finally {
    releaseFirstRole.resolve();
    await backgroundWork.stop();
  }
});

test("a scheduled role requested after refresh in the same turn uses refreshed facts", async () => {
  const activeRoleStarted = deferred();
  const releaseActiveRole = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [
          { id: "requirements-analyst", intervalMinutes: 11 },
          { id: "developer", intervalMinutes: 13 },
        ];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          activeRoleStarted.resolve();
          await releaseActiveRole.promise;
        }
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeRole = timers[1].callback();
    await activeRoleStarted.promise;
    const refresh = backgroundWork.refresh();
    const scheduledAfterRefresh = timers[2].callback();
    releaseActiveRole.resolve();
    await Promise.all([activeRole, refresh, scheduledAfterRefresh]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "scheduled",
      },
      { operation: "refresh", count: 2, notify: false },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
      { operation: "run", ids: ["developer"], trigger: "scheduled" },
    ]);
  } finally {
    releaseActiveRole.resolve();
    await backgroundWork.stop();
  }
});

test("a manual employee run overtakes a queued scheduled role", async () => {
  const activeRoleStarted = deferred();
  const releaseActiveRole = deferred();
  const timers = [];
  const calls = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [
          { id: "requirements-analyst", intervalMinutes: 11 },
          { id: "developer", intervalMinutes: 13 },
        ];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          activeRoleStarted.resolve();
          await releaseActiveRole.promise;
        }
      },
    },
    refreshService: {
      async refresh() {},
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeRole = timers[1].callback();
    await activeRoleStarted.promise;
    const queuedScheduledRole = timers[2].callback();
    const manualEmployee = backgroundWork.runEmployee("pr-reviewer");
    releaseActiveRole.resolve();
    await Promise.all([activeRole, queuedScheduledRole, manualEmployee]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "scheduled",
      },
      { operation: "run", ids: ["pr-reviewer"], trigger: "manual" },
      { operation: "run", ids: ["developer"], trigger: "scheduled" },
    ]);
  } finally {
    releaseActiveRole.resolve();
    await backgroundWork.stop();
  }
});

test("a manual role run queued before refresh is never discarded", async () => {
  const firstManualStarted = deferred();
  const releaseFirstManual = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          firstManualStarted.resolve();
          await releaseFirstManual.promise;
        }
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeManual = backgroundWork.runEmployee("requirements-analyst");
    await firstManualStarted.promise;
    const queuedManual = backgroundWork.runEmployee("developer");
    const refresh = timers[0].callback();
    releaseFirstManual.resolve();
    await Promise.all([activeManual, queuedManual, refresh]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "manual",
      },
      { operation: "run", ids: ["developer"], trigger: "manual" },
      { operation: "refresh", count: 2, notify: false },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);
  } finally {
    releaseFirstManual.resolve();
    await backgroundWork.stop();
  }
});

test("a manual role run between two fact cycles uses the first fresh snapshot", async () => {
  const firstRefreshStarted = deferred();
  const releaseFirstRefresh = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
        if (refreshCount === 2) {
          firstRefreshStarted.resolve();
          await releaseFirstRefresh.promise;
        }
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const firstRefresh = timers[0].callback();
    await firstRefreshStarted.promise;
    const manual = backgroundWork.runEmployee("developer");
    const secondRefresh = backgroundWork.refresh({ notify: true });
    releaseFirstRefresh.resolve();
    await Promise.all([firstRefresh, manual, secondRefresh]);

    assert.deepEqual(calls, [
      { operation: "refresh", count: 2, notify: false },
      { operation: "run", ids: ["developer"], trigger: "manual" },
      { operation: "refresh", count: 3, notify: true },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);
  } finally {
    releaseFirstRefresh.resolve();
    await backgroundWork.stop();
  }
});

test("periodic refresh fences facts but reopens confirmations before slow agency", async () => {
  await exerciseConfirmationRefreshGate("periodic");
});

test("manual refresh fences facts but reopens confirmations before slow agency", async () => {
  await exerciseConfirmationRefreshGate("manual");
});

test("an unhealthy GitHub refresh permits local answers while external confirmation writes stay closed", async () => {
  const queueCalls = [];
  let internalAnswers = 0;
  const application = startupApplication({
    port: 4173,
    queueCalls,
    async refresh() {
      return {
        dashboard: {
          sourceStatus: {
            githubPullRequests: {
              ok: false,
              stale: true,
              error: "GitHub unavailable",
            },
          },
          items: [],
        },
      };
    },
  });
  application.attentionBrowser = Object.fromEntries(["answer", "reject", "later"].map(method =>
    [method, async () => { internalAnswers++; return { status: "answered" }; }]));
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;
  const server = createDashboardServer(application, {
    backgroundWork,
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const next = await request(server, { path: "/api/confirmations/next" });
    const history = await request(server, { path: "/api/confirmations/history" });
    const approve = await request(server, {
      method: "POST",
      path: `/api/confirmations/${pendingConfirmationItem().id}/approve`,
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(confirmationApprovalRequest()),
    });
    const manualEmployee = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(next.status, 200);
    assert.equal(history.status, 200);
    assert.equal(approve.status, 503);
    assert.equal(manualEmployee.status, 503);
    const internalAnswer = await request(server, { method: "POST", path: `/api/attention/internal/attention-${"a".repeat(64)}/answer`,
      headers: { origin: "http://127.0.0.1:4173", "x-mydashboard-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, contentDigest: "b".repeat(64), answer: { type: "text", text: "继续" } }),
    });
    assert.equal(internalAnswer.status, 200);
    assert.equal(internalAnswers, 1);
    assert.deepEqual(queueCalls, ["next", "history"]);
  } finally {
    await server.shutdown();
  }
});

test("shutdown drains local reads and internal answers during refresh and safe mode", async (t) => {
  for (const safeMode of [false, true]) for (const confirmationsEnabled of [true, false]) for (const method of ["runConfirmationRead", "runAttentionOperation"]) await t.test(`${safeMode}:${confirmationsEnabled}:${method}`, async () => {
  const refreshRelease = deferred();
  const readStarted = deferred();
  const readRelease = deferred();
  const app = startupApplication({
    async refresh() { await refreshRelease.promise; return healthyRefreshResult(); },
  });
  if (!confirmationsEnabled) app.confirmationQueue = null;
  if (safeMode) app.configuration = { status: { safeMode: true, migrationError: null } };
  const backgroundWork = startApplicationBackgroundWork(app, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
  const reading = backgroundWork[method](async () => {
    readStarted.resolve();
    await readRelease.promise;
    return "local history";
  });
  await readStarted.promise;
  let stopped = false;
  const stopping = backgroundWork.stop().then(() => { stopped = true; });
  try {
    await assert.rejects(backgroundWork[method](async () => "must not run"), { code: "CONFIRMATION_FACTS_NOT_READY" });
    assert.equal(stopped, false);
  } finally {
    refreshRelease.resolve();
    readRelease.resolve();
    await stopping;
  }
  assert.equal(await reading, "local history");
  });
});

test("internal answers cannot start after shutdown when external confirmations are disabled", async () => {
  const app = startupApplication({ async refresh() { return healthyRefreshResult(); } });
  app.confirmationQueue = null;
  const background = startApplicationBackgroundWork(app, { setIntervalFn() { return { unref() {} }; }, clearIntervalFn() {} });
  await background.initialRefresh;
  await background.stop();
  let writes = 0;
  await assert.rejects(background.runAttentionOperation(async () => { writes++; }), { code: "CONFIRMATION_FACTS_NOT_READY" });
  assert.equal(writes, 0);
});

test("server rejects an untrusted Host before exposing local data", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, {
      path: "/api/dashboard",
      headers: { host: "evil.example:4173" },
    });

    assert.equal(response.status, 421);
    assert.equal(response.body.includes("private-dashboard-data"), false);
  });
});

test("5xx responses hide internal details while 4xx responses stay actionable", async () => {
  const privatePath = "D:\\private\\runtime\\confirmation-store.json";
  await withServer(
    async ({ server, reportedErrors }) => {
      const internalFailure = await request(server, {
        path: "/api/dashboard",
      });
      const clientFailure = await request(server, {
        path: "/api/dashboard",
        headers: { host: "evil.example:4173" },
      });

      assert.equal(internalFailure.status, 500);
      assert.deepEqual(JSON.parse(internalFailure.body), {
        error: "服务器内部错误",
      });
      assert.equal(internalFailure.body.includes(privatePath), false);
      assert.equal(reportedErrors.length, 1);
      assert.match(reportedErrors[0].message, /cannot open/);
      assert.match(reportedErrors[0].message, /confirmation-store\.json/);
      assert.equal(clientFailure.status, 421);
      assert.deepEqual(JSON.parse(clientFailure.body), {
        error: "请求 Host 不属于本地指挥中枢",
      });
    },
    {
      onDashboardRead() {
        throw new Error(`cannot open ${privatePath}`);
      },
    },
  );
});

test("the local UI cannot be framed by another site", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server);

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(
      response.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
  });
});

test("write endpoints require same-origin action headers and JSON", async () => {
  await withServer(async ({ server, calls }) => {
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });
    const missingActionHeader = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: { origin: "http://127.0.0.1:4173" },
    });
    const plainText = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "text/plain",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "historical",
        headRefOid: "head-1",
      }),
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(missingActionHeader.status, 403);
    assert.equal(plainText.status, 415);
    assert.deepEqual(calls, []);
  });
});

test("workflow read APIs expose routing and forward only pagination filters", async () => {
  const routing = {
    current: {
      version: 3,
      digest: "routing-digest",
      definition: { enabled: true, rules: [] },
    },
    history: [],
  };
  const assignments = {
    items: [{ assignmentId: "assignment-1", target: { type: "role", id: "pr-reviewer" } }],
    nextCursor: "assignment-next",
  };
  const audit = {
    items: [{ auditId: "audit-1", outcome: "assigned" }],
    nextCursor: "audit-next",
  };

  await withServer(
    async ({ server, calls }) => {
      const routingResponse = await request(server, {
        path: "/api/workflow/routing",
      });
      const assignmentsResponse = await request(server, {
        path: "/api/workflow/assignments?limit=17&cursor=assignment%3Apage%2B2&ignored=1",
      });
      const auditResponse = await request(server, {
        path: "/api/workflow/audit?limit=9&cursor=audit%3Apage%2F2&ignored=1",
      });

      assert.equal(routingResponse.status, 200);
      assert.deepEqual(JSON.parse(routingResponse.body), routing);
      assert.equal(assignmentsResponse.status, 200);
      assert.deepEqual(JSON.parse(assignmentsResponse.body), assignments);
      assert.equal(auditResponse.status, 200);
      assert.deepEqual(JSON.parse(auditResponse.body), audit);
      assert.deepEqual(calls, [
        { operation: "workflow_get_config" },
        {
          operation: "workflow_list_assignments",
          options: { limit: "17", cursor: "assignment:page+2" },
        },
        {
          operation: "workflow_list_audit",
          options: { limit: "9", cursor: "audit:page/2" },
        },
      ]);
    },
    {
      workflowRouting(calls) {
        return {
          async getConfig() {
            calls.push({ operation: "workflow_get_config" });
            return routing;
          },
          async dryRun() {
            throw new Error("unexpected dry-run");
          },
          async listAssignments(options) {
            calls.push({ operation: "workflow_list_assignments", options });
            return assignments;
          },
          async listAudit(options) {
            calls.push({ operation: "workflow_list_audit", options });
            return audit;
          },
        };
      },
    },
  );
});

test("workflow dry-run is same-origin JSON and forwards only event and definition", async () => {
  const event = {
    eventId: "workflow-event-1",
    eventType: "pr.updated",
    source: "github",
  };
  const definition = { enabled: true, rules: [] };
  const explanation = {
    ruleOrder: [],
    usedFallback: false,
    rules: [],
  };
  const body = JSON.stringify({
    event,
    definition,
    context: { visitedNodes: ["root"] },
    changedBy: "browser-user",
    dispatch: true,
  });

  await withServer(
    async ({ server, calls }) => {
      const crossOrigin = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "https://evil.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const missingActionHeader = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "content-type": "application/json",
        },
        body,
      });
      const plainText = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "text/plain",
        },
        body,
      });
      const trusted = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body,
      });

      assert.equal(crossOrigin.status, 403);
      assert.equal(missingActionHeader.status, 403);
      assert.equal(plainText.status, 415);
      assert.equal(trusted.status, 200);
      assert.deepEqual(JSON.parse(trusted.body), {
        dryRun: true,
        persisted: false,
        assignments: [],
        explanation,
      });
      assert.deepEqual(calls, [
        {
          operation: "workflow_dry_run",
          input: { event, definition },
        },
      ]);
    },
    {
      workflowRouting(calls) {
        return {
          async getConfig() {
            throw new Error("unexpected config read");
          },
          async dryRun(input) {
            calls.push({ operation: "workflow_dry_run", input });
            return {
              dryRun: true,
              persisted: false,
              assignments: [],
              explanation,
            };
          },
          async listAssignments() {
            throw new Error("unexpected assignment read");
          },
          async listAudit() {
            throw new Error("unexpected audit read");
          },
        };
      },
    },
  );
});

test("workflow API exposes no config replacement or dispatch mutation", async () => {
  await withServer(
    async ({ server, calls }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all(
        ["/api/workflow/routing", "/api/workflow/dispatch"].map((path) =>
          request(server, {
            method: "POST",
            path,
            headers,
            body: JSON.stringify({ definition: {}, event: {} }),
          }),
        ),
      );

      assert.deepEqual(
        responses.map((response) => response.status),
        [404, 404],
      );
      assert.deepEqual(calls, []);
    },
    {
      workflowRouting(calls) {
        const unexpectedMutation = (operation) => async (input) => {
          calls.push({ operation, input });
        };
        return {
          async getConfig() {
            return { current: null, history: [] };
          },
          async dryRun() {
            return { dryRun: true, persisted: false };
          },
          async listAssignments() {
            return { items: [], nextCursor: null };
          },
          async listAudit() {
            return { items: [], nextCursor: null };
          },
          replaceConfig: unexpectedMutation("workflow_replace_config"),
          ingest: unexpectedMutation("workflow_dispatch"),
        };
      },
    },
  );
});

test("workflow APIs fail closed when routing is unavailable", async () => {
  await withServer(async ({ server }) => {
    const trustedHeaders = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const responses = await Promise.all([
      request(server, { path: "/api/workflow/routing" }),
      request(server, { path: "/api/workflow/assignments" }),
      request(server, { path: "/api/workflow/audit" }),
      request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: trustedHeaders,
        body: JSON.stringify({ event: {} }),
      }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [503, 503, 503, 503],
    );
  });
});

test("owner work request HTTP API is same-origin, structured, and read-back capable", async () => {
  const calls = [];
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const result = (deduplicated) => ({
    deduplicated,
    requestId: id,
    requestDigest: "a".repeat(64),
    phase: "intaken",
    request: {
      schemaVersion: 1,
      requestId: id,
      workType: "general",
      priority: "normal",
      title: "Coordinate release",
      description: "Create one shared command-center task.",
      acceptanceCriteria: ["One shared root"],
    },
    eventId: `workflow-event-${"b".repeat(64)}`,
    assignment: {
      assignmentId: `workflow-assignment-${"c".repeat(64)}`,
      eventId: `workflow-event-${"b".repeat(64)}`,
      target: { type: "role", id: "orchestrator" },
      configVersion: 1,
      configDigest: "d".repeat(64),
      ruleId: "system-owner-request-to-orchestrator",
    },
    workItemId: `work-item-${"e".repeat(64)}`,
    createdAt: "2026-08-08T01:00:00.000Z",
    updatedAt: "2026-08-08T01:00:02.000Z",
    audit: [],
  });
  let submitted = false;
  const ownerWorkRequests = {
    async submit(input) {
      calls.push({ operation: "submit", input });
      const response = result(submitted);
      submitted = true;
      return response;
    },
    async list(options) {
      calls.push({ operation: "list", options });
      return { items: [result(true)], nextCursor: null };
    },
    async get(requestId) {
      calls.push({ operation: "get", requestId });
      return requestId === id ? result(true) : null;
    },
  };
  const input = result(false).request;
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };

  await withServer(
    async ({ server }) => {
      const untrusted = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(untrusted.status, 403);

      const injected = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: JSON.stringify({
          ...input,
          targetRoleId: "developer",
        }),
      });
      assert.equal(injected.status, 400);
      assert.equal(calls.length, 0);

      const created = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: JSON.stringify(input),
      });
      const replay = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: JSON.stringify(input),
      });
      assert.equal(created.status, 201);
      assert.equal(replay.status, 200);
      assert.equal(JSON.parse(created.body).assignment.target.id, "orchestrator");

      const explicitPr = {
        schemaVersion: 2,
        requestId: id,
        workType: "pull_request",
        priority: "high",
        title: "Review selected PR",
        description: "Use an independently resolved PR authority source.",
        acceptanceCriteria: ["Bind the current Head"],
        pullRequest: { repository: "acme/repo", number: 42 },
      };
      const prResponse = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: JSON.stringify(explicitPr),
      });
      assert.equal(prResponse.status, 200);

      const namedPrHandoff = {
        ...explicitPr,
        schemaVersion: 4,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        responsiblePerson: { login: "named-reviewer", product: "qt" },
      };
      const namedPrResponse = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: JSON.stringify(namedPrHandoff),
      });
      assert.equal(namedPrResponse.status, 200);

      const listed = await request(server, {
        path: `/api/work/requests?limit=7&cursor=${id}`,
      });
      const read = await request(server, {
        path: `/api/work/requests/${id}`,
      });
      assert.equal(listed.status, 200);
      assert.equal(read.status, 200);
      assert.deepEqual(calls, [
        { operation: "submit", input },
        { operation: "submit", input },
        { operation: "submit", input: explicitPr },
        { operation: "submit", input: namedPrHandoff },
        { operation: "list", options: { limit: "7", cursor: id } },
        { operation: "get", requestId: id },
      ]);
    },
    { ownerWorkRequests },
  );
});

test("owner intake failures expose safe retry guidance without internal error details", async () => {
  let code = "OWNER_WORK_REQUEST_LEDGER_REJECTED";
  await withServer(async ({ server }) => {
    for (const failureCode of [
      "OWNER_WORK_REQUEST_LEDGER_REJECTED",
      "OWNER_WORK_REQUEST_LEDGER_STALLED",
      "OWNER_WORK_REQUEST_LEDGER_MISSING",
      "PRIVATE_DATABASE_FAILURE",
    ]) {
      code = failureCode;
      const response = await request(server, {
        method: "POST", path: "/api/work/requests",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1", "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1, requestId: "123e4567-e89b-42d3-a456-426614174000",
          workType: "general", priority: "high", title: "Coordinate",
          description: "Retry the same request", acceptanceCriteria: ["One root"],
        }),
      });
      assert.equal(response.status, 503);
      assert.doesNotMatch(response.body, /private-credential-path/);
      const body = JSON.parse(response.body);
      if (failureCode === "PRIVATE_DATABASE_FAILURE") {
        assert.deepEqual(body, { error: "服务器内部错误" });
      } else {
        assert.equal(body.code, failureCode);
        assert.match(body.error, /已保存.*重试原请求/);
      }
    }
  }, { ownerWorkRequests: {
    async submit() {
      throw Object.assign(new Error("private-credential-path"), { code, statusCode: 503 });
    },
    async list() { return { items: [], nextCursor: null }; },
    async get() { return null; },
  } });
});

test("owner work request HTTP limit accepts the largest canonical contract and rejects excess bytes", async () => {
  const submissions = [];
  const maximumRequest = normalizeOwnerWorkRequest({
    schemaVersion: 1,
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    workType: "general",
    priority: "urgent",
    title: "T".repeat(256),
    description: "\\".repeat(12 * 1024),
    acceptanceCriteria: Array.from(
      { length: 20 },
      (_, index) => `${String(index).padStart(2, "0")}${"\\".repeat(998)}`,
    ),
  });
  const maximumBody = JSON.stringify(maximumRequest);
  assert.equal(Buffer.byteLength(maximumBody) > 16 * 1024, true);
  assert.equal(Buffer.byteLength(maximumBody) < 72 * 1024, true);
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  const ownerWorkRequests = {
    async submit(input) {
      submissions.push(input);
      return { deduplicated: false, requestId: input.requestId };
    },
    async list() {
      return { items: [], nextCursor: null };
    },
    async get() {
      return null;
    },
  };

  await withServer(
    async ({ server }) => {
      const accepted = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: maximumBody,
      });
      assert.equal(accepted.status, 201);
      assert.equal(submissions.length, 1);
      assert.deepEqual(submissions[0], maximumRequest);

      const oversized = await request(server, {
        method: "POST",
        path: "/api/work/requests",
        headers: trustedHeaders,
        body: " ".repeat(72 * 1024 + 1),
      });
      assert.equal(oversized.status, 413);
      assert.equal(submissions.length, 1);
    },
    { ownerWorkRequests },
  );
});

test("owner decision retry HTTP boundary is exact, fail-closed, and signals agency only after success", async () => {
  const itemId = "work-item-owner-retry";
  const inputDigest = "a".repeat(64);
  const calls = [];
  const agencySignals = [];
  let failure = null;
  const successfulProjection = () => ({
    itemId,
    inputDigest,
    status: "queued",
    statusReason: "owner_retry_decision_exhaustion",
    revision: 8,
    attempt: 3,
    ownerId: null,
    privateMarker: "generic-ledger-authority-must-not-leak",
  });
  let projection = successfulProjection();
  const ownerWorkRetry = {
    async retryDecisionExhaustion(input) {
      calls.push(structuredClone(input));
      if (failure) throw failure;
      return projection;
    },
  };
  const backgroundWork = {
    async signalAgency(options) {
      agencySignals.push(structuredClone(options));
    },
  };
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json; charset=utf-8",
  };
  const body = JSON.stringify({
    expectedRevision: 7,
    expectedInputDigest: inputDigest,
  });

  await withServer(
    async ({ server }) => {
      const path = `/api/work/items/${itemId}/retry-decision-exhaustion`;
      const rejectedRequests = [
        {
          name: "missing same-origin headers",
          expectedStatus: 403,
          headers: { "content-type": "application/json" },
          body,
        },
        {
          name: "cross-origin request",
          expectedStatus: 403,
          headers: { ...trustedHeaders, origin: "http://example.test" },
          body,
        },
        {
          name: "non-JSON content type",
          expectedStatus: 415,
          headers: { ...trustedHeaders, "content-type": "text/plain" },
          body,
        },
        {
          name: "extra authority field",
          expectedStatus: 400,
          headers: trustedHeaders,
          body: JSON.stringify({
            expectedRevision: 7,
            expectedInputDigest: inputDigest,
            actorId: "attacker",
          }),
        },
        {
          name: "query parameter",
          expectedStatus: 400,
          path: `${path}?force=1`,
          headers: trustedHeaders,
          body,
        },
        {
          name: "whitespace item ID",
          expectedStatus: 400,
          path: "/api/work/items/%20/retry-decision-exhaustion",
          headers: trustedHeaders,
          body,
        },
        {
          name: "control-character item ID",
          expectedStatus: 400,
          path: "/api/work/items/%00/retry-decision-exhaustion",
          headers: trustedHeaders,
          body,
        },
        {
          name: "malformed encoded item ID",
          expectedStatus: 400,
          path: "/api/work/items/%E0%A4%A/retry-decision-exhaustion",
          headers: trustedHeaders,
          body,
        },
        {
          name: "overlong item ID",
          expectedStatus: 400,
          path: `/api/work/items/${"x".repeat(193)}/retry-decision-exhaustion`,
          headers: trustedHeaders,
          body,
        },
        {
          name: "missing expected revision",
          expectedStatus: 400,
          headers: trustedHeaders,
          body: JSON.stringify({ expectedInputDigest: inputDigest }),
        },
        {
          name: "missing expected input digest",
          expectedStatus: 400,
          headers: trustedHeaders,
          body: JSON.stringify({ expectedRevision: 7 }),
        },
        ...[0, -1, 1.5, "7", null].map((expectedRevision) => ({
          name: `invalid expected revision ${JSON.stringify(expectedRevision)}`,
          expectedStatus: 400,
          headers: trustedHeaders,
          body: JSON.stringify({ expectedRevision, expectedInputDigest: inputDigest }),
        })),
        ...[
          inputDigest.toUpperCase(),
          "a".repeat(63),
          "a".repeat(65),
          7,
          null,
        ].map((expectedInputDigest) => ({
          name: `invalid expected input digest ${JSON.stringify(expectedInputDigest)}`,
          expectedStatus: 400,
          headers: trustedHeaders,
          body: JSON.stringify({ expectedRevision: 7, expectedInputDigest }),
        })),
        ...[
          ["null JSON", "null"],
          ["array JSON", "[]"],
          ["string JSON", '"retry"'],
          ["number JSON", "7"],
          ["boolean JSON", "true"],
          ["malformed JSON", "{"],
          ["empty body", ""],
        ].map(([name, invalidBody]) => ({
          name,
          expectedStatus: 400,
          headers: trustedHeaders,
          body: invalidBody,
        })),
      ];
      for (const rejected of rejectedRequests) {
        const response = await request(server, {
          method: "POST",
          path: rejected.path || path,
          headers: rejected.headers,
          body: rejected.body,
        });
        assert.equal(response.status, rejected.expectedStatus, rejected.name);
        assert.equal(calls.length, 0, `${rejected.name}: retry port call`);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          agencySignals.length,
          0,
          `${rejected.name}: agency signal`,
        );
      }

      failure = Object.assign(new Error("工作项已变化"), {
        code: "OWNER_WORK_RETRY_STALE",
        statusCode: 409,
      });
      const stale = await request(server, {
        method: "POST",
        path,
        headers: trustedHeaders,
        body,
      });
      assert.equal(stale.status, 409);
      assert.equal(agencySignals.length, 0);

      failure = null;
      const invalidProjections = [
        { name: "null projection", value: null },
        {
          name: "array projection",
          value: Object.assign([], successfulProjection()),
        },
        {
          name: "wrong item ID",
          value: { ...successfulProjection(), itemId: "work-item-other" },
        },
        {
          name: "wrong input digest",
          value: { ...successfulProjection(), inputDigest: "b".repeat(64) },
        },
        {
          name: "wrong status",
          value: { ...successfulProjection(), status: "blocked" },
        },
        {
          name: "stale result revision",
          value: { ...successfulProjection(), revision: 7 },
        },
        {
          name: "skipped result revision",
          value: { ...successfulProjection(), revision: 9 },
        },
        {
          name: "negative attempt",
          value: { ...successfulProjection(), attempt: -1 },
        },
        {
          name: "fractional attempt",
          value: { ...successfulProjection(), attempt: 1.5 },
        },
        {
          name: "string attempt",
          value: { ...successfulProjection(), attempt: "3" },
        },
      ];
      for (const invalid of invalidProjections) {
        projection = invalid.value;
        const callsBefore = calls.length;
        const response = await request(server, {
          method: "POST",
          path,
          headers: trustedHeaders,
          body,
        });
        assert.equal(response.status, 500, invalid.name);
        assert.equal(calls.length, callsBefore + 1, invalid.name);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          agencySignals.length,
          0,
          `${invalid.name}: agency signal`,
        );
      }

      projection = successfulProjection();
      const retried = await request(server, {
        method: "POST",
        path,
        headers: trustedHeaders,
        body,
      });
      assert.equal(retried.status, 200);
      assert.deepEqual(JSON.parse(retried.body), {
        itemId,
        inputDigest,
        status: "queued",
        revision: 8,
        attempt: 3,
      });
      for (const input of calls) {
        assert.deepEqual(input, {
          itemId,
          expectedRevision: 7,
          expectedInputDigest: inputDigest,
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(agencySignals, [{
        trigger: "owner_retry_decision_exhaustion",
      }]);
    },
    { ownerWorkRetry, backgroundWork },
  );

  await withServer(async ({ server }) => {
    const unavailable = await request(server, {
      method: "POST",
      path: `/api/work/items/${itemId}/retry-decision-exhaustion`,
      headers: trustedHeaders,
      body,
    });
    assert.equal(unavailable.status, 503);
  });
});

test("work APIs expose only newest-first ledger projections", async () => {
  const calls = [];
  const workLedgerView = {
    async getSummary() {
      calls.push({ operation: "summary" });
      return { revision: 7, itemCounts: { queued: 3 } };
    },
    async listItems(options) {
      calls.push({ operation: "items", options });
      return { items: [{ itemId: "work-1" }], nextCursor: null };
    },
    async listTimeline(options) {
      calls.push({ operation: "timeline", options });
      return { items: [{ timelineId: "timeline-1" }], nextCursor: null };
    },
  };

  await withServer(
    async ({ server }) => {
      const summary = await request(server, { path: "/api/work/summary" });
      const items = await request(server, {
        path: "/api/work/items?limit=17&cursor=item%3A2&status=queued&order=newest&roleId=developer&ignored=1",
      });
      const timeline = await request(server, {
        path: "/api/work/timeline?limit=9&cursor=timeline%3A2&order=newest&status=blocked",
      });

      assert.equal(summary.status, 200);
      assert.deepEqual(JSON.parse(summary.body), {
        revision: 7,
        itemCounts: { queued: 3 },
        safeguards: {
          prEmployeePaused: true,
          externalActionsEnabled: false,
          automaticReviewEnabled: false,
        },
      });
      assert.deepEqual(JSON.parse(items.body), {
        items: [{ itemId: "work-1" }],
        nextCursor: null,
      });
      assert.deepEqual(JSON.parse(timeline.body), {
        items: [{ timelineId: "timeline-1" }],
        nextCursor: null,
      });
      assert.deepEqual(calls, [
        { operation: "summary" },
        {
          operation: "items",
          options: {
            limit: "17",
            cursor: "item:2",
            status: "queued",
            order: "newest",
            roleId: "developer",
          },
        },
        {
          operation: "timeline",
          options: {
            limit: "9",
            cursor: "timeline:2",
            order: "newest",
          },
        },
      ]);
    },
    { workLedgerView },
  );
});

test("daily work APIs expose the bounded daily projection without changing durable work APIs", async () => {
  const calls = [];
  const dailyWorkLedgerView = {
    async getSummary() {
      calls.push({ operation: "daily-summary" });
      return {
        revision: 8,
        itemCounts: { queued: 2 },
        dailyScope: { activeWindowDays: 14, currentItems: 2, historyItems: 7 },
      };
    },
    async listItems(options) {
      calls.push({ operation: "daily-items", options });
      return { items: [{ itemId: "daily-work-1" }], nextCursor: null };
    },
  };

  await withServer(async ({ server }) => {
    const summary = await request(server, { path: "/api/work/daily/summary" });
    const items = await request(server, {
      path: "/api/work/daily/items?limit=17&status=queued&order=newest&roleId=developer",
    });

    assert.equal(summary.status, 200);
    assert.deepEqual(JSON.parse(summary.body), {
      revision: 8,
      itemCounts: { queued: 2 },
      dailyScope: { activeWindowDays: 14, currentItems: 2, historyItems: 7 },
      safeguards: {
        prEmployeePaused: true,
        externalActionsEnabled: false,
        automaticReviewEnabled: false,
      },
    });
    assert.equal(items.status, 200);
    assert.deepEqual(JSON.parse(items.body), {
      items: [{ itemId: "daily-work-1" }],
      nextCursor: null,
    });
    assert.deepEqual(calls, [
      { operation: "daily-summary" },
      {
        operation: "daily-items",
        options: {
          limit: "17",
          status: "queued",
          order: "newest",
          roleId: "developer",
        },
      },
    ]);
  }, { dailyWorkLedgerView });
});

test("work graph API exposes only the read-only graph snapshot", async () => {
  const calls = [];
  const snapshot = {
    schemaVersion: 1,
    graph: {
      schemaVersion: 1,
      graphId: "work-ledger",
      revision: 4,
      tasks: [
        {
          taskId: "work-1",
          revision: 2,
          parentTaskId: null,
          status: "in_progress",
          responsibility: { type: "role", id: "orchestrator" },
          acceptanceContracts: [
            {
              revision: 1,
              acceptanceCriteria: [],
              expectedDeliverables: [],
            },
          ],
          deliveries: [],
          dependsOn: [],
        },
      ],
      contentDigest: "a".repeat(64),
    },
    taskStates: [
      {
        taskId: "work-1",
        taskRevision: 2,
        ledgerStatus: "working",
        ownerId: "employee-orchestrator",
        leaseUntil: "2026-08-03T04:10:00.000Z",
        availableAt: null,
        statusReason: null,
        updatedAt: "2026-08-03T04:00:00.000Z",
        work: { title: "Review PR", description: null },
      },
    ],
  };
  const workGraphView = {
    async getSnapshot() {
      calls.push({ operation: "get_graph_snapshot" });
      return snapshot;
    },
    async createChild() {
      calls.push({ operation: "create_graph_child" });
      throw new Error("graph writes must remain private");
    },
  };

  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });

      assert.equal(response.status, 200);
      const expected = {
        schemaVersion: 2,
        totalTaskCount: 1,
        graph: {
          schemaVersion: 1,
          graphId: "work-ledger",
          revision: 4,
          tasks: [{
            taskId: "work-1",
            revision: 2,
            parentTaskId: null,
            responsibility: { type: "role", id: "orchestrator" },
            acceptanceContract: {
              revision: 1,
              acceptanceCriteria: [],
              expectedDeliverables: [],
            },
            latestDeliveries: [],
            history: { acceptanceContractCount: 1, deliveryCount: 0 },
            dependsOn: [],
          }],
        },
        taskStates: [{
          taskId: "work-1",
          taskRevision: 2,
          ledgerStatus: "working",
          ownerId: "employee-orchestrator",
          statusReason: null,
          updatedAt: "2026-08-03T04:00:00.000Z",
          work: { title: "Review PR", description: null },
        }],
      };
      assert.deepEqual(JSON.parse(response.body), expected);
      assert.deepEqual(calls, [{ operation: "get_graph_snapshot" }]);
    },
    { workGraphView },
  );
});

test("work graph API returns a newest bounded window with complete references", async () => {
  const contract = {
    revision: 1,
    acceptanceCriteria: [],
    expectedDeliverables: [],
  };
  const tasks = Array.from({ length: 400 }, (_, index) => ({
    taskId: `task-${String(index).padStart(3, "0")}`,
    revision: 1,
    parentTaskId: index === 399 ? "task-000" : null,
    status: "pending",
    responsibility: { type: "role", id: "orchestrator" },
    acceptanceContracts: [structuredClone(contract)],
    deliveries: [],
    dependsOn: index === 399 ? ["task-001"] : [],
  }));
  tasks[399] = {
    ...tasks[399],
    revision: 4,
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [{
          deliverableId: "implementation",
          kind: "change-package",
          description: "Old implementation",
          required: true,
        }],
      },
      {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "verified",
          description: "Current behavior verified",
        }],
        expectedDeliverables: [{
          deliverableId: "implementation",
          kind: "change-package",
          description: "Current implementation",
          required: true,
        }],
      },
    ],
    deliveries: [
      {
        deliverableId: "implementation",
        revision: 1,
        contractRevision: 1,
        status: "accepted",
        summary: "obsolete delivery must stay private",
        evidence: [{
          kind: "artifact",
          referenceId: "obsolete",
          contentDigest: "a".repeat(64),
        }],
      },
      {
        deliverableId: "implementation",
        revision: 2,
        contractRevision: 2,
        status: "submitted",
        summary: "superseded current delivery",
        evidence: [{
          kind: "artifact",
          referenceId: "submitted",
          contentDigest: "b".repeat(64),
        }],
      },
      {
        deliverableId: "implementation",
        revision: 3,
        contractRevision: 2,
        status: "accepted",
        summary: "latest current delivery",
        evidence: [{
          kind: "artifact",
          referenceId: "accepted",
          contentDigest: "c".repeat(64),
        }],
      },
    ],
  };
  const taskStates = tasks.map((task, index) => ({
    taskId: task.taskId,
    taskRevision: task.revision,
    ledgerStatus: "queued",
    ownerId: null,
    statusReason: null,
    updatedAt: new Date(Date.parse("2026-08-03T00:00:00.000Z") + index * 1_000)
      .toISOString(),
    work: { title: `Task ${index}`, description: null },
  }));

  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });
      const body = JSON.parse(response.body);
      assert.equal(response.status, 200);
      assert.equal(body.schemaVersion, 2);
      assert.equal(body.totalTaskCount, 400);
      assert.equal(body.graph.tasks.length, 300);
      assert.equal(body.taskStates.length, 300);
      const ids = new Set(body.graph.tasks.map(({ taskId }) => taskId));
      assert.equal(ids.has("task-399"), true);
      for (const task of body.graph.tasks) {
        if (task.parentTaskId !== null) assert.equal(ids.has(task.parentTaskId), true);
        for (const dependencyId of task.dependsOn) {
          assert.equal(ids.has(dependencyId), true);
        }
      }
      const newest = body.graph.tasks.find(({ taskId }) => taskId === "task-399");
      assert.equal(newest.acceptanceContract.revision, 2);
      assert.deepEqual(newest.history, {
        acceptanceContractCount: 2,
        deliveryCount: 3,
      });
      assert.deepEqual(
        newest.latestDeliveries.map(({ revision }) => revision),
        [3],
      );
      assert.doesNotMatch(response.body, /obsolete delivery|superseded current/);
    },
    {
      workGraphView: {
        async getSnapshot() {
          return {
            schemaVersion: 1,
            graph: {
              schemaVersion: 1,
              graphId: "work-ledger",
              revision: 400,
              tasks,
            },
            taskStates,
          };
        },
      },
    },
  );
});

test("work graph HTTP boundary exposes no write route", async () => {
  const calls = [];
  const workGraphView = {
    async getSnapshot() {
      calls.push({ operation: "get_graph_snapshot" });
      return {};
    },
    async createChild() {
      calls.push({ operation: "create_graph_child" });
      throw new Error("graph writes must remain private");
    },
  };

  await withServer(
    async ({ server }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all([
        request(server, {
          method: "POST",
          path: "/api/work/graph",
          headers,
          body: JSON.stringify({ parentTaskId: "work-1" }),
        }),
        request(server, {
          method: "POST",
          path: "/api/work/graph/children",
          headers,
          body: JSON.stringify({ parentTaskId: "work-1" }),
        }),
      ]);

      assert.deepEqual(responses.map(({ status }) => status), [404, 404]);
      assert.deepEqual(calls, []);
    },
    { workGraphView },
  );
});

test("work HTTP boundary exposes no intake, claim, stage, dispatch, or outbox", async () => {
  await withServer(
    async ({ server, calls }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all(
        ["intake", "claim", "stage", "dispatch", "outbox"].map((name) =>
          request(server, {
            method: "POST",
            path: `/api/work/${name}`,
            headers,
            body: JSON.stringify({ itemId: "work-1" }),
          }),
        ),
      );

      assert.deepEqual(responses.map(({ status }) => status), [404, 404, 404, 404, 404]);
      assert.deepEqual(calls, []);
    },
    {
      workLedgerView: {
        async getSummary() {},
        async listItems() {},
        async listTimeline() {},
        async intake() { throw new Error("must remain private"); },
        async claim() { throw new Error("must remain private"); },
      },
    },
  );
});

test("work APIs fail closed when the ledger projection is unavailable", async () => {
  await withServer(async ({ server }) => {
    const responses = await Promise.all([
      request(server, { path: "/api/work/summary" }),
      request(server, { path: "/api/work/items" }),
      request(server, { path: "/api/work/timeline" }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [503, 503, 503]);
  });
});

test("work graph API fails closed when its projection is disabled or invalid", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/work/graph" });

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
  });
  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });

      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
    },
    { workGraphView: {} },
  );
});

test("code jobs expose only their safe newest-first reader projection", async () => {
  const calls = [];
  const codeJobReader = {
    async list(options) {
      calls.push(options);
      return {
        items: [{ id: "code-job-1", status: "queued" }],
        nextCursor: null,
      };
    },
  };
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: "/api/code/jobs?limit=9&order=newest&status=queued&cursor=job%3A2",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), {
        enabled: true,
        items: [{ id: "code-job-1", status: "queued" }],
        nextCursor: null,
      });
      assert.deepEqual(calls, [
        { limit: "9", cursor: "job:2", status: "queued", order: "newest" },
      ]);
    },
    { codeJobReader },
  );
});

test("disabled code jobs remain a stable empty read-only API", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/code/jobs" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      enabled: false,
      items: [],
      nextCursor: null,
    });
  });
});

test("code job detail forwards bounded pagination and reports missing jobs", async () => {
  const jobId = `code-job-${"a".repeat(55)}`;
  const calls = [];
  const detail = {
    job: {
      jobId,
      revision: 7,
      requestedBy: { roleId: "developer", workItemId: "work-1" },
    },
    archived: false,
    historyAvailable: true,
    observations: [],
    nextCursor: null,
    terminalDetail: null,
    changePackage: { status: "pending", receipt: null },
  };
  await withServer(
    async ({ server }) => {
      const found = await request(server, {
        path: `/api/code/jobs/${jobId}?limit=8&cursor=observation%3A2`,
      });
      const missing = await request(server, {
        path: `/api/code/jobs/code-job-${"b".repeat(55)}`,
      });
      const unknownQuery = await request(server, {
        path: `/api/code/jobs/${jobId}?status=active`,
      });
      const repeatedQuery = await request(server, {
        path: `/api/code/jobs/${jobId}?limit=4&limit=5`,
      });

      assert.equal(found.status, 200);
      assert.deepEqual(JSON.parse(found.body), { enabled: true, detail });
      assert.equal(missing.status, 404);
      assert.deepEqual([unknownQuery.status, repeatedQuery.status], [400, 400]);
      assert.deepEqual(calls, [
        { jobId, limit: "8", cursor: "observation:2" },
        { jobId: `code-job-${"b".repeat(55)}` },
      ]);
    },
    {
      codeJobReader: {
        async getDetail(options) {
          calls.push(options);
          return options.jobId === jobId ? detail : null;
        },
      },
    },
  );
});

test("code job detail binds and whitelists durable change package application status", async () => {
  const jobId = `code-job-${"e".repeat(55)}`;
  const packageDigest = "f".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const detail = {
    job: {
      jobId,
      revision: 9,
      requestedBy: { roleId: "developer", workItemId: "work-application" },
    },
    archived: false,
    historyAvailable: true,
    observations: [],
    nextCursor: null,
    terminalDetail: null,
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T02:00:00.000Z",
      },
    },
  };
  let projection = { status: "not_requested" };
  let getterCalls = 0;

  await withServer(
    async ({ server, reportedErrors }) => {
      const available = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(available.status, 200);
      assert.deepEqual(
        JSON.parse(available.body).detail.changePackage.application,
        { status: "not_requested", canRequest: true },
      );

      projection = {
        confirmationId: `confirmation-change-package-apply-${"1".repeat(64)}`,
        approvalBindingDigest: "2".repeat(64),
        requestedBy: {
          roleId: "developer",
          workItemId: "work-application",
        },
        job: { id: jobId, revision: 8, recordDigest: "3".repeat(64) },
        packageId,
        packageDigest,
        workspaceId: "dashboard",
        itemRevision: 3,
        createdAt: "2026-08-03T02:01:00.000Z",
        updatedAt: "2026-08-03T02:02:00.000Z",
        status: "applied",
        receipt: {
          id: `change-package-application-${"4".repeat(64)}`,
          createdAt: "2026-08-03T02:01:30.000Z",
        },
        failure: null,
        rejectedAt: null,
        privatePath: "D:\\private\\checkout",
      };
      const applied = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(applied.status, 200);
      const application = JSON.parse(applied.body).detail.changePackage.application;
      assert.deepEqual(application, {
        status: "applied",
        canRequest: false,
        confirmationId: projection.confirmationId,
        updatedAt: projection.updatedAt,
        retryable: false,
        receipt: projection.receipt,
        failure: null,
        rejectedAt: null,
      });
      assert.equal(applied.body.includes("private\\checkout"), false);
      assert.equal(applied.body.includes("approvalBindingDigest"), false);

      projection = { status: "not_requested" };
      Object.defineProperty(projection, "privatePath", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "D:\\private\\secret";
        },
      });
      const hostile = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(hostile.status, 500);
      assert.equal(hostile.body.includes("private"), false);
      assert.equal(getterCalls, 0);
      assert.equal(reportedErrors.length, 1);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageApplicationStatusReader: {
        async getForJob(requestedJobId) {
          assert.equal(requestedJobId, jobId);
          return projection;
        },
      },
    },
  );
});

test("code job controls bind identity to the path and reject extra fields", async () => {
  const jobId = `code-job-${"c".repeat(55)}`;
  const calls = [];
  const agencySignals = [];
  const signalFailure = new Error("agency wake failed");
  const codeJobControl = {
    async pause(input) {
      calls.push(["pause", input]);
      return { status: "applied", job: { jobId, status: "paused" } };
    },
    async resume(input) {
      calls.push(["resume", input]);
      return { status: "applied", job: { jobId, status: "active" } };
    },
    async cancel(input) {
      calls.push(["cancel", input]);
      if (input.expectedRevision === 10) {
        throw Object.assign(new Error("stale code job revision"), {
          code: "CODE_JOB_REVISION_CONFLICT",
          statusCode: 409,
        });
      }
      return { status: "applied", job: { jobId, status: "cancelled" } };
    },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(
    async ({ server, reportedErrors }) => {
      const paused = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "pause", expectedRevision: 7 }),
      });
      const resumed = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "resume", expectedRevision: 8 }),
      });
      const cancelled = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "cancel", expectedRevision: 9 }),
      });
      const bodyBoundJob = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({
          command: "pause",
          expectedRevision: 9,
          jobId: `code-job-${"d".repeat(55)}`,
        }),
      });
      const clientReason = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({
          command: "pause",
          expectedRevision: 9,
          reason: "client supplied",
        }),
      });
      const untrusted = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "pause", expectedRevision: 9 }),
      });
      const unsupported = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "delete", expectedRevision: 9 }),
      });
      const staleCancel = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "cancel", expectedRevision: 10 }),
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(
        [paused.status, resumed.status, cancelled.status],
        [200, 200, 200],
      );
      assert.deepEqual(JSON.parse(paused.body), {
        status: "applied",
        job: { jobId, status: "paused" },
      });
      assert.deepEqual(JSON.parse(cancelled.body), {
        status: "applied",
        job: { jobId, status: "cancelled" },
      });
      assert.deepEqual(
        [
          bodyBoundJob.status,
          clientReason.status,
          untrusted.status,
          unsupported.status,
          staleCancel.status,
        ],
        [400, 400, 403, 400, 409],
      );
      assert.deepEqual(calls, [
        [
          "pause",
          {
            jobId,
            expectedRevision: 7,
            reason: "用户从本地指挥中枢暂停代码任务",
          },
        ],
        ["resume", { jobId, expectedRevision: 8 }],
        [
          "cancel",
          {
            jobId,
            expectedRevision: 9,
            reason: "用户从本地指挥中枢取消代码任务",
          },
        ],
        [
          "cancel",
          {
            jobId,
            expectedRevision: 10,
            reason: "用户从本地指挥中枢取消代码任务",
          },
        ],
      ]);
      assert.deepEqual(agencySignals, [
        { trigger: "code_job_cancel_requested" },
      ]);
      assert.deepEqual(reportedErrors, [signalFailure]);
    },
    {
      codeJobControl,
      backgroundWork: {
        async signalAgency(options) {
          agencySignals.push(options);
          throw signalFailure;
        },
      },
    },
  );
});

test("code job package reads require a ready receipt bound to the manifest", async () => {
  const jobId = `code-job-${"e".repeat(55)}`;
  const packageDigest = "f".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const calls = [];
  const detail = {
    job: {
      jobId,
      revision: 11,
      requestedBy: { roleId: "developer", workItemId: "work-1" },
    },
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T01:00:00.000Z",
      },
    },
  };
  const manifest = {
    packageId,
    packageDigest,
    job: { id: jobId },
    changes: { created: [], modified: [], deleted: [] },
  };
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), { manifest });
      assert.deepEqual(calls, [
        ["detail", { jobId }],
        ["package", packageId],
      ]);
    },
    {
      codeJobReader: {
        async getDetail(input) {
          calls.push(["detail", input]);
          return detail;
        },
      },
      changePackageReader: {
        async get(input) {
          calls.push(["package", input]);
          return manifest;
        },
      },
    },
  );
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 409);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageReader: {
        async get() {
          return { ...manifest, packageDigest: "0".repeat(64) };
        },
      },
    },
  );
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 404);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageReader: {
        async get() {
          throw Object.assign(new Error("missing package"), {
            code: "CHANGE_PACKAGE_NOT_FOUND",
          });
        },
      },
    },
  );
});

test("code job evidence downloads exact digest-bound bytes without accepting paths", async () => {
  const jobId = `code-job-${"8".repeat(55)}`;
  const packageDigest = "9".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const profileId = "node-tests";
  const kind = "stdout";
  const content = Buffer.from('{"stdout":"tests passed"}\n', "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const calls = [];
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/${profileId}/${kind}?packageDigest=${packageDigest}&sha256=${sha256}`;
  await withServer(
    async ({ server }) => {
      const downloaded = await request(server, { path: endpoint });
      assert.equal(downloaded.status, 200);
      assert.deepEqual(downloaded.rawBody, content);
      assert.equal(downloaded.headers["content-length"], String(content.length));
      assert.equal(downloaded.headers["x-content-sha256"], sha256);
      assert.equal(downloaded.headers.etag, `"${sha256}"`);
      assert.equal(
        downloaded.headers["content-digest"],
        `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`,
      );
      assert.match(
        downloaded.headers["content-disposition"],
        new RegExp(`attachment; filename="${profileId}-${kind}-${sha256.slice(0, 12)}\\.json"`),
      );
      assert.equal(downloaded.headers["x-content-type-options"], "nosniff");

      const invalid = await Promise.all([
        request(server, {
          path: endpoint.replace(`&sha256=${sha256}`, ""),
        }),
        request(server, { path: `${endpoint}&path=private.txt` }),
        request(server, { path: `${endpoint}&sha256=${sha256}` }),
        request(server, {
          path: endpoint.replace(`/${profileId}/${kind}`, "/..%2Fprivate/stdout"),
        }),
      ]);
      assert.deepEqual(invalid.map(({ status }) => status), [400, 400, 400, 404]);
      assert.equal(calls.length, 1);
    },
    {
      codeJobEvidenceReader: {
        async read(input) {
          calls.push(input);
          return {
            jobId,
            packageId,
            packageDigest,
            profileId,
            kind,
            sha256,
            bytes: content.length,
            content,
          };
        },
      },
    },
  );
  assert.deepEqual(calls, [{
    jobId,
    packageId,
    packageDigest,
    profileId,
    kind,
    expectedSha256: sha256,
  }]);
});

test("code job evidence fails before streaming when the reader result is corrupt", async () => {
  const jobId = `code-job-${"7".repeat(55)}`;
  const packageDigest = "6".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const sha256 = "5".repeat(64);
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/node-tests/output?packageDigest=${packageDigest}&sha256=${sha256}`;
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, { path: endpoint });
      assert.equal(response.status, 500);
      assert.doesNotMatch(response.body, /PRIVATE ARTIFACT/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.equal(reportedErrors.length, 1);
      assert.equal(reportedErrors[0].statusCode, 500);
    },
    {
      codeJobEvidenceReader: {
        async read() {
          return {
            jobId,
            packageId,
            packageDigest,
            profileId: "node-tests",
            kind: "output",
            sha256,
            bytes: 16,
            content: Buffer.from("PRIVATE ARTIFACT", "utf8"),
          };
        },
      },
    },
  );
});

test("code job evidence keeps an immutable URL binding across an untrusted await", async () => {
  const jobId = `code-job-${"a".repeat(55)}`;
  const packageDigest = "b".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const expectedSha256 = "c".repeat(64);
  const secret = Buffer.from("PRIVATE CROSS-JOB ARTIFACT\n", "utf8");
  const secretSha256 = createHash("sha256").update(secret).digest("hex");
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/node-tests/output?packageDigest=${packageDigest}&sha256=${expectedSha256}`;
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, { path: endpoint });
      assert.equal(response.status, 500);
      assert.doesNotMatch(response.body, /PRIVATE CROSS-JOB ARTIFACT/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.equal(reportedErrors.length, 1);
    },
    {
      codeJobEvidenceReader: {
        async read(input) {
          assert.equal(Object.isFrozen(input), true);
          for (const [field, value] of Object.entries({
            jobId: `code-job-${"d".repeat(55)}`,
            packageId: `change-package-${"e".repeat(64)}`,
            packageDigest: "e".repeat(64),
            profileId: "foreign-tests",
            kind: "stderr",
            expectedSha256: secretSha256,
          })) {
            assert.equal(Reflect.set(input, field, value), false);
          }
          return {
            jobId: `code-job-${"d".repeat(55)}`,
            packageId: `change-package-${"e".repeat(64)}`,
            packageDigest: "e".repeat(64),
            profileId: "foreign-tests",
            kind: "stderr",
            sha256: secretSha256,
            bytes: secret.length,
            content: secret,
          };
        },
      },
    },
  );
});

test("code job package apply derives authority and only requests confirmation", async () => {
  const jobId = `code-job-${"1".repeat(55)}`;
  const packageDigest = "2".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const requestedBy = { roleId: "developer", workItemId: "work-9" };
  const calls = [];
  const agencySignals = [];
  const detail = {
    job: { jobId, revision: 13, requestedBy },
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T02:00:00.000Z",
      },
    },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(
    async ({ server }) => {
      const accepted = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 13 }),
      });
      const stale = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 12 }),
      });
      const forged = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 13, packageId: "forged" }),
      });
      const wrongContentType = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: { ...headers, "content-type": "text/plain" },
        body: JSON.stringify({ expectedRevision: 13 }),
      });

      assert.equal(accepted.status, 200);
      assert.deepEqual(JSON.parse(accepted.body), {
        request: { id: "confirmation-package-1", status: "pending" },
      });
      assert.deepEqual(
        [stale.status, forged.status, wrongContentType.status],
        [409, 400, 415],
      );
      assert.deepEqual(calls, [
        { packageId, requestedBy },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(agencySignals, [
        { trigger: "change_package_application_requested" },
      ]);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageApplicationStatusReader: {
        async getForJob() { return { status: "not_requested" }; },
      },
      changePackageApplicationRequester: {
        async request(input) {
          calls.push(input);
          return { id: "confirmation-package-1", status: "pending" };
        },
      },
      backgroundWork: {
        signalAgency(options) { agencySignals.push(options); },
      },
    },
  );

  for (const [code, status] of [
    ["CHANGE_PACKAGE_APPLICATION_STALE", 409],
    ["CHANGE_PACKAGE_TARGET_DIRTY", 409],
    ["CHANGE_PACKAGE_TARGET_STALE", 409],
    ["CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT", 409],
    ["INVALID_CHANGE_PACKAGE_APPLICATION", 400],
    ["CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE", 503],
  ]) {
    await withServer(
      async ({ server }) => {
        const response = await request(server, {
          method: "POST",
          path: `/api/code/jobs/${jobId}/change-package/apply`,
          headers,
          body: JSON.stringify({ expectedRevision: 13 }),
        });
        assert.equal(response.status, status, code);
      },
      {
        codeJobReader: { async getDetail() { return detail; } },
        changePackageApplicationStatusReader: {
          async getForJob() { return { status: "not_requested" }; },
        },
        changePackageApplicationRequester: {
          async request() {
            throw Object.assign(new Error("application request rejected"), {
              code,
            });
          },
        },
      },
    );
  }
});

test("package apply fails closed when its lifecycle reader is unavailable", async () => {
  const jobId = `code-job-${"5".repeat(55)}`;
  const packageDigest = "6".repeat(64);
  let requesterCalls = 0;
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: 4 }),
      });

      assert.equal(response.status, 503);
      assert.equal(requesterCalls, 0);
    },
    {
      codeJobReader: {
        async getDetail() {
          return {
            job: {
              jobId,
              revision: 4,
              requestedBy: { roleId: "developer", workItemId: "work-4" },
            },
            changePackage: {
              status: "ready",
              receipt: {
                packageId: `change-package-${packageDigest}`,
                packageDigest,
              },
            },
          };
        },
      },
      changePackageApplicationRequester: {
        async request() { requesterCalls += 1; },
      },
    },
  );
});

test("a projected application lifecycle blocks duplicate package requests", async () => {
  const jobId = `code-job-${"6".repeat(55)}`;
  const packageDigest = "7".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  let requesterCalls = 0;
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: 4 }),
      });
      assert.equal(response.status, 409);
      assert.equal(requesterCalls, 0);
    },
    {
      codeJobReader: {
        async getDetail() {
          return {
            job: {
              jobId,
              revision: 4,
              requestedBy: { roleId: "developer", workItemId: "work-4" },
            },
            changePackage: {
              status: "ready",
              receipt: { packageId, packageDigest },
            },
          };
        },
      },
      changePackageApplicationStatusReader: {
        async getForJob() {
          return {
            status: "pending",
            confirmationId: `confirmation-change-package-apply-${"8".repeat(64)}`,
            requestedBy: { roleId: "developer", workItemId: "work-4" },
            job: { id: jobId, revision: 3, recordDigest: "9".repeat(64) },
            packageId,
            packageDigest,
            workspaceId: "dashboard",
            itemRevision: 1,
            createdAt: "2026-08-03T02:00:00.000Z",
            updatedAt: "2026-08-03T02:00:00.000Z",
          };
        },
      },
      changePackageApplicationRequester: {
        async request() { requesterCalls += 1; },
      },
    },
  );
});

test("code job detail and mutation routes fail closed without required ports", async () => {
  const jobId = `code-job-${"3".repeat(55)}`;
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(async ({ server }) => {
    const responses = await Promise.all([
      request(server, { path: `/api/code/jobs/${jobId}` }),
      request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "pause", expectedRevision: 1 }),
      }),
      request(server, { path: `/api/code/jobs/${jobId}/change-package` }),
      request(server, {
        path: `/api/code/jobs/${jobId}/change-package/change-package-${"4".repeat(64)}/evidence/node-tests/output?packageDigest=${"4".repeat(64)}&sha256=${"5".repeat(64)}`,
      }),
      request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
    ]);
    assert.deepEqual(
      responses.map(({ status }) => status),
      [503, 503, 503, 503, 503],
    );
  });
});

test("unified attention read projects external authorization without exposing actions", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, { path: "/api/attention/next" });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.source, "external_confirmation");
    assert.equal(body.externalEnabled, true);
    assert.equal(body.externalQueueRevision, 8);
    assert.equal(body.item.id, "confirmation-pr-work-1");
    assert.deepEqual(calls, [{ operation: "confirmation_next" }]);
  });
});

test("unified attention read strictly parses bounded session exclusions", async () => {
  const external = {
    id: "confirmation-pr-work-1",
    approvalBindingDigest: "c".repeat(64),
  };
  const internal = {
    requestId: `attention-${"a".repeat(64)}`,
    contentDigest: "b".repeat(64),
  };
  const reads = [];
  const attentionCoordinator = {
    async next(options) {
      reads.push(options);
      return {
        available: false,
        source: null,
        pendingCount: 0,
        externalEnabled: true,
        externalQueueRevision: 8,
        item: null,
      };
    },
  };
  const deferred = [
    `external:${external.id}:${external.approvalBindingDigest}`,
    `internal:${internal.requestId}:${internal.contentDigest}`,
  ];

  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/attention/next?${deferred
          .map((value) => `deferred=${encodeURIComponent(value)}`)
          .join("&")}`,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(reads, [{ external: [external], internal: [internal] }]);

      const invalidPaths = [
        "/api/attention/next?unknown=1",
        `/api/attention/next?deferred=${encodeURIComponent("external:bad::binding")}`,
        `/api/attention/next?deferred=${encodeURIComponent(deferred[0])}&deferred=${encodeURIComponent(deferred[0])}`,
        `/api/attention/next?${Array.from(
          { length: 33 },
          (_, index) =>
            `deferred=${encodeURIComponent(
              `external:confirmation-${index}:${index.toString(16).padStart(64, "0")}`,
            )}`,
        ).join("&")}`,
      ];
      for (const path of invalidPaths) {
        const invalid = await request(server, { path });
        assert.equal(invalid.status, 400, path);
      }
      assert.equal(reads.length, 1);
    },
    { attentionCoordinator },
  );
});

test("internal attention mutations are source-bound and only signal background work", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  const digest = "b".repeat(64);
  const calls = [];
  const attentionBrowser = Object.fromEntries(
    ["answer", "reject", "later"].map((operation) => [
      operation,
      async (input) => {
        calls.push({ operation, input });
        return {
          requestId,
          contentDigest: digest,
          status: operation === "later" ? "pending" : operation === "reject" ? "rejected" : "answered",
          revision: operation === "later" ? 3 : 4,
        };
      },
    ]),
  );
  const backgroundWork = {
    runConfirmationOperation(operation) { return operation(); },
    signalAgency(options) { calls.push({ operation: "signal", options }); },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };

  await withServer(
    async ({ server }) => {
      const answer = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/answer`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "text", text: "按最近一年迁移" },
        }),
      });
      const reject = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/reject`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "reject", reason: "缺少上下文" },
        }),
      });
      const later = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "later" },
        }),
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual([answer.status, reject.status, later.status], [200, 200, 200]);
      assert.deepEqual(calls, [
        {
          operation: "answer",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "text", text: "按最近一年迁移" },
            requestId,
          },
        },
        { operation: "signal", options: { trigger: "user_answered" } },
        {
          operation: "reject",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "reject", reason: "缺少上下文" },
            requestId,
          },
        },
        { operation: "signal", options: { trigger: "user_answered" } },
        {
          operation: "later",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "later" },
            requestId,
          },
        },
      ]);
    },
    { attentionBrowser, backgroundWork },
  );
});

test("internal attention answers use local admission while external confirmation facts are pending", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  let mutations = 0;
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/answer`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 1,
          contentDigest: "b".repeat(64),
          answer: { type: "text", text: "继续" },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(mutations, 1);
    },
    {
      attentionBrowser: {
        answer() { mutations += 1; return { requestId, status: "answered" }; },
        reject() { mutations += 1; },
        later() { mutations += 1; },
      },
      backgroundWork: {
        runAttentionOperation(operation) { return operation(); },
        runConfirmationOperation() {
          throw Object.assign(new Error("facts pending"), {
            code: "CONFIRMATION_FACTS_NOT_READY",
            statusCode: 503,
          });
        },
      },
    },
  );
});

test("internal attention rejects untrusted callers and body-supplied request ids", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  const body = JSON.stringify({
    requestId,
    expectedRevision: 3,
    contentDigest: "b".repeat(64),
    answer: { type: "later" },
  });
  let browserCalls = 0;
  await withServer(
    async ({ server }) => {
      const crossOrigin = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers: {
          origin: "https://evil.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const suppliedId = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const wrongNamespace = await request(server, {
        method: "POST",
        path: `/api/confirmations/${requestId}/answer`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });

      assert.deepEqual(
        [crossOrigin.status, suppliedId.status, wrongNamespace.status],
        [403, 400, 404],
      );
      assert.equal(browserCalls, 0);
    },
    {
      attentionBrowser: {
        async answer() { browserCalls += 1; },
        async reject() { browserCalls += 1; },
        async later() { browserCalls += 1; },
      },
    },
  );
});

test("the confirmation API exposes only the next immutable projection", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/confirmations/next",
    });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.pendingCount, 1);
    assert.equal(body.item.id, "confirmation-pr-work-1");
    assert.equal(body.item.display.payload.action.body, "Looks good.");
    assert.equal("action" in body.item, false);
    assert.deepEqual(calls, [{ operation: "confirmation_next" }]);
  });
});

test("the confirmation API reads one immutable item for a bound job", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/confirmations/confirmation-pr-work-1",
    });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.item.id, "confirmation-pr-work-1");
    assert.equal(body.item.display.payload.action.body, "Looks good.");
    assert.equal("action" in body.item, false);
    assert.deepEqual(calls, [{
      operation: "confirmation_get",
      id: "confirmation-pr-work-1",
    }]);
  });
});

test("confirmation history is a GET-only, filtered, read-only projection", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: `/api/confirmations/history?status=completed&kind=github.pull-request-review&roleId=pr-reviewer&limit=20&cursor=${"a".repeat(32)}`,
    });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.roleIdFacets, ["former-reviewer", "pr-reviewer"]);
    assert.deepEqual(Object.keys(body.items[0]).sort(), [
      "createdAt",
      "id",
      "kind",
      "requestedBy",
      "retryable",
      "status",
      "summary",
      "title",
      "updatedAt",
    ]);
    assert.deepEqual(calls, [
      {
        operation: "confirmation_history_list",
        options: {
          status: "completed",
          kind: "github.pull-request-review",
          roleId: "pr-reviewer",
          limit: 20,
          cursor: "a".repeat(32),
        },
      },
    ]);

    const post = await request(server, {
      method: "POST",
      path: "/api/confirmations/history",
    });
    assert.equal(post.status, 404);
    assert.equal(
      calls.filter(({ operation }) => operation === "confirmation_history_list")
        .length,
      1,
    );
  });
});

test("confirmation history rejects every non-whitelisted or duplicate filter before reading", async () => {
  await withServer(async ({ server, calls }) => {
    const paths = [
      "/api/confirmations/history?unknown=value",
      "/api/confirmations/history?status=completed&status=rejected",
      "/api/confirmations/history?status=pending",
      "/api/confirmations/history?kind=github.unknown-action",
      "/api/confirmations/history?roleId=PR%20Admin",
      "/api/confirmations/history?limit=0",
      "/api/confirmations/history?limit=51",
      "/api/confirmations/history?limit=01",
      "/api/confirmations/history?cursor=short",
    ];
    for (const path of paths) {
      const response = await request(server, { path });
      assert.equal(response.status, 400, path);
    }
    assert.equal(
      calls.some(({ operation }) => operation === "confirmation_history_list"),
      false,
    );
  });
});

test("confirmation mutations forward only bound requests and sync the employee", async () => {
  const signals = [];
  const backgroundWork = {
    runConfirmationOperation(operation) { return operation(); },
    signalAgency(options) { signals.push(options); },
  };
  await withServer(async ({ server, calls }) => {
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const binding = {
      requestId: "request-confirmation-0001",
      expectedQueueRevision: 8,
      expectedItemRevision: 2,
      displayedPayloadDigest: "b".repeat(64),
      approvalBindingDigest: "c".repeat(64),
    };

    for (const operation of ["approve", "retry", "reject"]) {
      const response = await request(server, {
        method: "POST",
        path: `/api/confirmations/confirmation-pr-work-1/${operation}`,
        headers,
        body: JSON.stringify(
          operation === "reject" ? { ...binding, reason: "暂不发布" } : binding,
        ),
      });
      assert.equal(response.status, 200);
      const result = JSON.parse(response.body);
      assert.equal(result.item.status, operation === "reject" ? "rejected" : "completed");
      assert.equal(result.next.pendingCount, 1);
      assert.equal(result.employeeSyncPending, false);
    }
    await new Promise((resolve) => setImmediate(resolve));

    for (const operation of ["approve", "retry", "reject"]) {
      const call = calls.find(
        (candidate) => candidate.operation === `confirmation_${operation}`,
      );
      assert.equal(call.id, "confirmation-pr-work-1");
      assert.deepEqual(
        call.input,
        operation === "reject" ? { ...binding, reason: "暂不发布" } : binding,
      );
    }
    assert.equal(
      calls.filter((call) => call.operation === "employee_confirmation_outcome")
        .length,
      3,
    );
    assert.deepEqual(signals, Array.from({ length: 3 }, () => ({
      trigger: "confirmation_answered",
    })));
  }, { backgroundWork });
});

test("confirmation mutation response does not wait for a busy employee queue", async () => {
  const syncStarted = deferred();
  const releaseSync = deferred();
  let responsePromise;
  let quickResponse;
  await withServer(async ({ server }) => {
    responsePromise = request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/reject",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "request-confirmation-busy-employee",
        expectedQueueRevision: 8,
        expectedItemRevision: 2,
        displayedPayloadDigest: "b".repeat(64),
        approvalBindingDigest: "c".repeat(64),
        reason: "承认结果未知并封存",
      }),
    });
    await syncStarted.promise;
    try {
      quickResponse = await Promise.race([
        responsePromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
    } finally {
      releaseSync.resolve();
      await responsePromise;
    }
    assert.notEqual(quickResponse, null);
    assert.equal(quickResponse.status, 200);
    assert.equal(JSON.parse(quickResponse.body).employeeSyncPending, true);
  }, {
    onRecordConfirmationOutcome() {
      syncStarted.resolve();
      return releaseSync.promise;
    },
  });
});

test("confirmation writes reject untrusted callers and expose no enqueue route", async () => {
  await withServer(async ({ server, calls }) => {
    const body = JSON.stringify({ requestId: "request-confirmation-0001" });
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/approve",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body,
    });
    const wrongType = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/reject",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "text/plain",
      },
      body,
    });
    const enqueue = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/enqueue",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body,
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(wrongType.status, 415);
    assert.equal(enqueue.status, 404);
    assert.equal(
      calls.some((call) => call.operation.startsWith("confirmation_")),
      false,
    );
  });
});

test("disabled external actions expose an empty read view and reject writes", async () => {
  await withServer(
    async ({ server }) => {
      const next = await request(server, { path: "/api/confirmations/next" });
      const history = await request(server, {
        path: "/api/confirmations/history",
      });
      const approve = await request(server, {
        method: "POST",
        path: "/api/confirmations/confirmation-pr-work-1/approve",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: "request-confirmation-0001" }),
      });

      assert.deepEqual(JSON.parse(next.body), {
        available: false,
        queueRevision: 0,
        pendingCount: 0,
        item: null,
      });
      assert.deepEqual(JSON.parse(history.body), {
        available: false,
        queueRevision: 0,
        filters: {},
        limit: 25,
        roleIdFacets: [],
        items: [],
        nextCursor: null,
      });
      assert.equal(approve.status, 503);
    },
    { confirmationQueueEnabled: false },
  );
});

test("closing the HTTP server releases application-owned runtimes", async () => {
  let closed = 0;
  await withServer(
    async ({ server }) => {
      await server.shutdown();
    },
    {
      onClose() {
        closed += 1;
      },
    },
  );
  assert.equal(closed, 1);
});

test(
  "pending composition startup cleanup obeys the server deadline and holds its lease",
  { timeout: 2_000 },
  async () => {
    const events = [];
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const startupFailure = new Error("workflow startup failed");
    let suppliedRuntimeLifecycle = null;
    let leaseReleased = false;
    const writerLease = {
      async acquire() {
        events.push("lease-acquire");
      },
      async close() {
        if (leaseReleased) return;
        leaseReleased = true;
        events.push("lease-release");
      },
    };
    const starting = startDashboardServer({
      writerLease,
      createApplicationFn: (options = {}) => {
        suppliedRuntimeLifecycle = options.runtimeLifecycle || null;
        return createApplication({
          config: structuredClone(safeEditableConfiguration),
          store: {
            async read(_key, fallback = null) {
              return fallback;
            },
            async write() {},
          },
          externalActions: false,
          runtimeLifecycle: options.runtimeLifecycle,
          codeExecutorRuntimeFactory: async () => ({
            async close() {
              events.push("runtime-close");
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              events.push("runtime-closed");
            },
          }),
          workflowRoutingRuntimeFactory: async () => {
            throw startupFailure;
          },
        });
      },
      shutdownDrainTimeoutMs: 20,
      log() {},
    }).then(
      () => null,
      (error) => error,
    );
    await cleanupStarted.promise;

    const stillPending = Symbol("still pending");
    const beforeRelease = await Promise.race([
      starting,
      new Promise((resolve) => setTimeout(() => resolve(stillPending), 250)),
    ]);
    try {
      assert.notStrictEqual(
        beforeRelease,
        stillPending,
        "server startup remained trapped inside composition cleanup",
      );
      assert.equal(beforeRelease instanceof AggregateError, true);
      assert.strictEqual(beforeRelease.errors[0], startupFailure);
      assert.equal(beforeRelease.errors[1].code, "LIFECYCLE_DRAIN_TIMEOUT");
      assert.deepEqual(events, ["lease-acquire", "runtime-close"]);
      assert.notEqual(suppliedRuntimeLifecycle, null);
    } finally {
      releaseCleanup.resolve();
      if (suppliedRuntimeLifecycle) {
        await suppliedRuntimeLifecycle.close();
      }
      await starting;
      if (!leaseReleased) await writerLease.close();
    }

    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close",
      "runtime-closed",
      "lease-release",
    ]);
  },
);

test("the application writer lease covers recovery through final runtime close", async () => {
  const events = [];
  const application = startupApplication({
    port: await availablePort(),
    async close() {
      events.push("application-close");
    },
  });
  const writerLease = {
    async acquire() {
      events.push("lease-acquire");
    },
    async close() {
      events.push("lease-close");
    },
  };
  const server = await startDashboardServer({
    writerLease,
    createApplicationFn: async () => {
      assert.deepEqual(events, ["lease-acquire"]);
      events.push("application-recovery");
      return application;
    },
    log() {},
  });

  assert.deepEqual(events, ["lease-acquire", "application-recovery"]);
  await server.shutdown();
  assert.deepEqual(events, [
    "lease-acquire",
    "application-recovery",
    "application-close",
    "lease-close",
  ]);
});

test("runtime source is reverified after composition and immediately before listen", async () => {
  const port = await availablePort();
  const application = startupApplication({ port });
  let verificationCount = 0;

  const server = await startDashboardServer({
    createApplicationFn: async () => application,
    verifyRuntimeSourceFn: async () => {
      verificationCount += 1;
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(100),
      }));
    },
    log() {},
  });

  try {
    assert.equal(verificationCount, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/live`)).status, 200);
  } finally {
    await server.shutdown();
  }
});

test("a failed runtime close retains the writer lease fail-closed", async () => {
  const closeFailure = new Error("runtime writer may still be active");
  let leaseCloses = 0;
  const application = startupApplication({
    port: await availablePort(),
    async close() {
      throw closeFailure;
    },
  });
  const writerLease = {
    async acquire() {},
    async close() {
      leaseCloses += 1;
    },
  };
  const server = await startDashboardServer({
    writerLease,
    createApplicationFn: async () => application,
    log() {},
  });

  await assert.rejects(server.shutdown(), (error) => error === closeFailure);
  assert.equal(leaseCloses, 0);
});

test("shutdown aborts cooperative background work before bounded draining", async () => {
  const refreshStarted = deferred();
  let observedSignal = null;
  const application = startupApplication({
    async refresh({ signal } = {}) {
      observedSignal = signal;
      refreshStarted.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 100,
  });
  await refreshStarted.promise;

  await backgroundWork.stop();
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  await Promise.allSettled([backgroundWork.initialRefresh]);
});

test("shutdown drains the admitted memory projection port then stops its cycle", async () => {
  const projectionStarted = deferred();
  const releaseProjectionPort = deferred();
  let observedSignal = null;
  let laterSteps = 0;
  let stopSettled = false;
  const application = startupApplication();
  application.memoryProjector = {
    async runCycle({ signal }) {
      observedSignal = signal;
      projectionStarted.resolve();
      await releaseProjectionPort.promise;
      signal.throwIfAborted();
      laterSteps += 1;
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 500,
  });
  await projectionStarted.promise;

  const stopping = backgroundWork.stop().finally(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(stopSettled, false, "the admitted projection port must drain");

  releaseProjectionPort.resolve();
  await stopping;
  assert.equal(laterSteps, 0);
  await Promise.allSettled([backgroundWork.initialRefresh]);
});

async function configurationRestartShutdownRace({
  proposalRunnerFactory = (runner) => runner,
  expectedClaimExecutions = 1,
  transformRejection = (error) => error,
  additionalStage = async () => {},
  settleCutover = (control) => control.commit({
    version: 40,
    configurationDigest: "b".repeat(64),
  }),
  close = async () => {},
} = {}) {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({ version: 39, configurationDigest: "a".repeat(64) });
  const noOpCycle = { async runCycle() {} };
  const proposalStarted = deferred();
  const releaseProposal = deferred();
  let racing = false;
  let claimExecutions = 0;
  let applicationCloses = 0;
  let leaseCloses = 0;
  let stopping;
  let statusBeforeStop;
  const reportedErrors = [];
  const coordinator = new WorkCoordinationService({
    ledger: { async intake() {} },
    proposalRunner: proposalRunnerFactory({
      async runCycle() {
        if (racing) {
          proposalStarted.resolve();
          await releaseProposal.promise;
        }
        try {
          return await gate.run(() => { claimExecutions += 1; });
        } catch (error) {
          throw transformRejection(error);
        }
      },
    }),
    proposalResultReconciler: {
      async runCycle() { if (racing) await additionalStage(gate); },
    },
    attentionResultReconciler: noOpCycle,
    conditionWaker: noOpCycle,
    workLoop: noOpCycle,
    dispatcher: { async dispatchPending() {} },
  });
  const application = startupApplication({
    async close() { applicationCloses += 1; await close(); },
  });
  let server;
  let backgroundWork;
  application.workCoordination = {
    intake: (options) => coordinator.intake(options),
    async runCycle(options) {
      try {
        return await coordinator.runCycle(options);
      } catch (error) {
        if (racing) {
          // Shutdown may resume between the failed coordination promise and
          // the background task's rejection/finally handlers.
          queueMicrotask(() => {
            statusBeforeStop = backgroundWork.drainStatus();
            stopping = server.shutdown().then(
              () => ({ succeeded: true }),
              (failure) => ({ succeeded: false, failure }),
            );
          });
        }
        throw error;
      }
    },
  };
  backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 500,
    reportError(error) { reportedErrors.push(error); },
    setIntervalFn() { return { unref() {} }; },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;
  server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 1_000,
    writerLease: {
      async acquire() {},
      async close() { leaseCloses += 1; },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    racing = true;
    const cycling = backgroundWork.signalAgency().then(
      () => assert.fail("the old configuration must reject the cycle"),
      (error) => error,
    );
    await proposalStarted.promise;
    await gate.cutover(settleCutover);
    releaseProposal.resolve();
    const cycleFailure = await cycling;
    assert.ok(stopping, "shutdown must race the tracked rejection");
    const shutdown = await stopping;
    assert.equal(statusBeforeStop.activeTaskCount, 1);
    assert.equal(claimExecutions, expectedClaimExecutions, "cutover must prevent another proposal claim");
    assert.deepEqual(backgroundWork.drainStatus().activeParticipants, []);
    assert.equal(backgroundWork.drainStatus().activeTaskCount, 0);
    assert.deepEqual(reportedErrors, [cycleFailure]);
    return { shutdown, cycleFailure, applicationCloses, leaseCloses };
  } finally {
    releaseProposal.resolve();
    await Promise.allSettled([backgroundWork.stop(), server.shutdown()]);
  }
}

test("shutdown drains a configuration cutover admission rejection racing task settlement", async () => {
  const result = await configurationRestartShutdownRace();
  assert.equal(result.cycleFailure.code, "WORK_COORDINATION_STAGE_FAILED");
  assert.equal(result.cycleFailure.cause.code, "RUNTIME_RESTART_REQUIRED");
  assert.deepEqual(result.shutdown, { succeeded: true });
  assert.equal(result.applicationCloses, 1);
  assert.equal(result.leaseCloses, 1);
});

test("shutdown drains an aggregate containing only real configuration restart rejections", async () => {
  const result = await configurationRestartShutdownRace({
    additionalStage: (gate) => gate.run(() => assert.fail("must not be admitted")),
  });
  assert.ok(result.cycleFailure instanceof AggregateError);
  assert.equal(result.cycleFailure.errors.length, 2);
  assert.deepEqual(result.shutdown, { succeeded: true });
  assert.equal(result.applicationCloses, 1);
  assert.equal(result.leaseCloses, 1);
});

test("shutdown drains real grouped proposal runners containing only configuration restart rejections", async (t) => {
  for (const count of [2, 3]) {
    await t.test(`${count} proposal runners`, async () => {
      const result = await configurationRestartShutdownRace({
        proposalRunnerFactory: (runner) => createWorkProposalRunnerGroup(
          Array.from({ length: count }, () => runner),
        ),
        expectedClaimExecutions: count,
        additionalStage: (gate) => gate.run(() => assert.fail("must not be admitted")),
      });
      assert.ok(result.cycleFailure instanceof AggregateError);
      const groupFailure = result.cycleFailure.errors
        .find((error) => error.stage === "proposal_execution").cause;
      assert.ok(groupFailure instanceof AggregateError);
      assert.equal(groupFailure.message, "one or more work proposal runners failed");
      assert.equal(groupFailure.errors.length, count);
      assert.deepEqual(result.shutdown, { succeeded: true });
      assert.equal(result.applicationCloses, 1);
      assert.equal(result.leaseCloses, 1);
    });
  }
});

test("shutdown retains real I/O and unknown write failures inside grouped proposal runners", async (t) => {
  for (const [name, failure] of [
    ["real I/O without an error code", new Error("durable append failed")],
    ["unknown external write", Object.assign(new Error("external write was not confirmed"), {
      code: "EXTERNAL_ACTION_UNKNOWN",
    })],
  ]) {
    await t.test(name, async () => {
      const result = await configurationRestartShutdownRace({
        proposalRunnerFactory: (runner) => createWorkProposalRunnerGroup([
          runner,
          { async runCycle(options) {
            try { return await runner.runCycle(options); }
            catch { throw failure; }
          } },
        ]),
        expectedClaimExecutions: 2,
      });
      const groupFailure = result.cycleFailure.cause;
      assert.ok(groupFailure instanceof AggregateError);
      assert.equal(groupFailure.errors.length, 2);
      assert.ok(groupFailure.errors.includes(failure));
      assert.equal(result.shutdown.succeeded, false);
      assert.equal(result.shutdown.failure, result.cycleFailure);
      assert.equal(result.applicationCloses, 0);
      assert.equal(result.leaseCloses, 0);
    });
  }
});

test("shutdown retains non-admission failures alongside a configuration cutover", async (t) => {
  for (const [name, options] of [
    ["a plain error with the same code", {
      transformRejection: () => Object.assign(new Error("ordinary failure"), {
        code: "RUNTIME_RESTART_REQUIRED",
      }),
    }],
    ["an aggregate with a real I/O failure", {
      additionalStage: async () => { throw new Error("durable append failed"); },
    }],
    ["an aggregate with an unknown external write", {
      additionalStage: async () => {
        throw Object.assign(new Error("external write was not confirmed"), {
          code: "EXTERNAL_ACTION_UNKNOWN",
        });
      },
    }],
    ["a foreign aggregate wrapper", {
      transformRejection: (error) => new AggregateError([error], "foreign failure"),
    }],
    ["a typed rejection with another failure cause", {
      transformRejection: (error) => Object.assign(error, {
        cause: new Error("durable runtime failed"),
      }),
    }],
    ["an unknown configuration state", {
      settleCutover: (control) => control.markUnknown(),
    }],
  ]) {
    await t.test(name, async () => {
      const result = await configurationRestartShutdownRace(options);
      assert.equal(result.shutdown.succeeded, false);
      assert.equal(result.shutdown.failure, result.cycleFailure);
      assert.equal(result.applicationCloses, 0);
      assert.equal(result.leaseCloses, 0);
    });
  }
});

test("a pure configuration restart rejection does not suppress runtime close failure", async () => {
  const failure = Object.assign(new Error("native termination is unconfirmed"), {
    code: "NATIVE_CODEX_REAP_UNCONFIRMED",
  });
  const result = await configurationRestartShutdownRace({
    close: async () => { throw failure; },
  });
  assert.equal(result.shutdown.succeeded, false);
  assert.equal(result.shutdown.failure, failure);
  assert.equal(result.applicationCloses, 1);
  assert.equal(result.leaseCloses, 0);
});

test("shutdown preserves a real memory projection failure after abort", async () => {
  const projectionStarted = deferred();
  const releaseProjectionPort = deferred();
  const projectionFailure = new Error("memory projection append failed");
  const reportedErrors = [];
  const application = startupApplication();
  application.memoryProjector = {
    async runCycle() {
      projectionStarted.resolve();
      await releaseProjectionPort.promise;
      throw projectionFailure;
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 500,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  const initialFailure = backgroundWork.initialRefresh.catch((error) => error);
  await projectionStarted.promise;

  const stopping = backgroundWork.stop();
  releaseProjectionPort.resolve();

  await assert.rejects(stopping, (error) => error === projectionFailure);
  assert.equal(await initialFailure, projectionFailure);
  assert.deepEqual(reportedErrors, [projectionFailure]);
});

test("shutdown reaps an active external refresh command before completing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-command-drain-"));
  const marker = path.join(directory, "pid.txt");
  let observedSignal = null;
  const application = startupApplication({
    async refresh({ signal } = {}) {
      observedSignal = signal;
      try {
        await runCommand(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
          ],
          { timeoutMs: 30_000, signal },
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    },
  });
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 2_000,
  });
  t.after(async () => {
    await Promise.allSettled([backgroundWork.stop()]);
    await Promise.allSettled([backgroundWork.initialRefresh]);
    await rm(directory, { recursive: true, force: true });
  });
  let processId = null;
  const startupDeadline = performance.now() + 20_000;
  while (performance.now() < startupDeadline) {
    try {
      processId = Number(await readFile(marker, "utf8"));
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(Number.isSafeInteger(processId), true);
  const server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 2_500,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const startedAt = performance.now();
  await server.shutdown();
  const durationMs = performance.now() - startedAt;

  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(durationMs < 2_000, true, `shutdown took ${durationMs} ms`);
  assert.throws(
    () => process.kill(processId, 0),
    (error) => error?.code === "ESRCH",
  );
  await Promise.allSettled([backgroundWork.initialRefresh]);
});

test("shutdown abort reaches an active role provider before runtimes and lease close", async () => {
  const providerStarted = deferred();
  let providerSignal = null;
  let applicationCloses = 0;
  let leaseCloses = 0;
  const application = startupApplication({
    async close() {
      applicationCloses += 1;
    },
  });
  application.employeeRegistry = {
    get(id) {
      return id === "pr-reviewer" ? { async recoverConfirmations() {} } : null;
    },
    schedules() {
      return [];
    },
    async runSelected(ids, options) {
      if (!ids.includes("developer")) return;
      providerSignal = options.signal;
      providerStarted.resolve();
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(providerSignal.reason);
        providerSignal?.addEventListener("abort", onAbort, { once: true });
        if (providerSignal?.aborted) onAbort();
      });
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 100,
  });
  await backgroundWork.initialRefresh;
  const running = backgroundWork.runEmployee("developer", { trigger: "manual" });
  const observed = running.then(
    () => null,
    (error) => error,
  );
  await providerStarted.promise;
  const server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 150,
    writerLease: {
      async acquire() {},
      async close() {
        leaseCloses += 1;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  await server.shutdown();
  assert.equal(providerSignal instanceof AbortSignal, true);
  assert.equal(providerSignal.aborted, true);
  assert.equal((await observed)?.code, "LIFECYCLE_SHUTDOWN_ABORTED");
  assert.equal(applicationCloses, 1);
  assert.equal(leaseCloses, 1);
});

test("an active role provider that ignores abort keeps shutdown fail-closed", async () => {
  const providerStarted = deferred();
  const providerRelease = deferred();
  let providerSignal = null;
  let applicationCloses = 0;
  let leaseCloses = 0;
  const application = startupApplication({
    async close() {
      applicationCloses += 1;
    },
  });
  application.employeeRegistry = {
    get(id) {
      return id === "pr-reviewer" ? { async recoverConfirmations() {} } : null;
    },
    schedules() {
      return [];
    },
    async runSelected(ids, options) {
      if (!ids.includes("developer")) return;
      providerSignal = options.signal;
      providerStarted.resolve();
      await providerRelease.promise;
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 20,
  });
  await backgroundWork.initialRefresh;
  const running = backgroundWork.runEmployee("developer", { trigger: "manual" });
  await providerStarted.promise;
  const server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 40,
    writerLease: {
      async acquire() {},
      async close() {
        leaseCloses += 1;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await assert.rejects(server.shutdown(), { code: "LIFECYCLE_DRAIN_TIMEOUT" });
    assert.equal(providerSignal instanceof AbortSignal, true);
    assert.equal(providerSignal.aborted, true);
    assert.equal(applicationCloses, 0);
    assert.equal(leaseCloses, 0);
  } finally {
    providerRelease.resolve();
    await running.catch(() => {});
  }
});

test("a composed role provider cannot detach from shutdown by ignoring its signal", async () => {
  const providerStarted = deferred();
  const providerRelease = deferred();
  let providerSignal = null;
  let applicationCloses = 0;
  let leaseCloses = 0;
  const roleState = new Map();
  const roleStore = {
    async read(key, fallback) {
      return structuredClone(roleState.has(key) ? roleState.get(key) : fallback);
    },
    async write(key, value) {
      roleState.set(key, structuredClone(value));
    },
  };
  const decisionEngine = {
    async decide({ signal }) {
      providerSignal = signal;
      providerStarted.resolve();
      await providerRelease.promise;
      return {
        schemaVersion: 1,
        confidence: 100,
        summary: "released test provider",
        intent: {
          schemaVersion: 1,
          type: "complete",
          summary: "released test provider",
          reason: "test cleanup",
          outcome: "no-action",
          evidence: [],
        },
      };
    },
    view() {
      return {
        definition: {
          id: "developer",
          name: "Developer",
          mission: "Implement assigned work",
          enabled: true,
          scheduleMinutes: 5,
        },
        permissions: { allowedIntents: ["complete"] },
        brain: {
          provider: "local-test",
          model: "ignored-signal-provider",
          remote: false,
          remoteData: { requirements: false, code: false, memory: false },
        },
      };
    },
  };
  let workCoordination = null;
  const developer = new ConfiguredRoleEmployee({
    definition: decisionEngine.view().definition,
    permissions: decisionEngine.view().permissions,
    brain: {
      provider: "local-test",
      model: "ignored-signal-provider",
      remoteData: { requirements: false, code: false, memory: false },
    },
    decisionEngine,
    store: roleStore,
    onRun: ({ roleId, signal }) => workCoordination.runCycle({
      trigger: `employee:${roleId}`,
      includeWork: true,
      roleId,
      signal,
    }),
  });
  const legacyReviewer = {
    id: "pr-reviewer",
    scheduleMinutes: 0,
    async recoverConfirmations() {},
    async view() { return {}; },
    async roleView() {
      return { id: "pr-reviewer", enabled: true, paused: false };
    },
    async run() {},
    async control() {},
  };
  const employeeRegistry = new EmployeeRegistry([legacyReviewer, developer]);
  const item = {
    itemId: "work-item-shutdown-provider",
    kind: "assignment",
    assignmentId: "assignment-shutdown-provider",
    sourceSequence: 1,
    inputDigest: "shutdown-provider-input",
    assignment: {
      assignmentId: "assignment-shutdown-provider",
      target: { type: "role", id: "developer" },
    },
    event: {
      eventId: "event-shutdown-provider",
      eventType: "issue.created",
      subject: { id: "github:issue:acme/repo#1" },
      payload: {},
    },
    graph: {
      parentItemId: null,
      dependsOnItemIds: [],
      acceptanceContracts: [],
      deliveries: [],
    },
    currentTarget: { type: "role", id: "developer" },
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
    createdAt: "2026-08-08T01:00:00.000Z",
    updatedAt: "2026-08-08T01:00:00.000Z",
  };
  const ledger = {
    async intake() {
      return { received: 0 };
    },
    async listItems() {
      return { items: [structuredClone(item)], nextCursor: null };
    },
    async claim(input) {
      item.status = "working";
      item.revision += 1;
      item.ownerId = input.workerId;
      item.leaseId = "lease-shutdown-provider";
      item.leaseUntil = "2026-08-08T01:02:00.000Z";
      item.attempt += 1;
      return structuredClone(item);
    },
    async stageIntent() {
      throw new Error("shutdown provider must not stage an intent");
    },
    async scheduleRetry() {},
    async transition() {},
  };
  const roleDirectory = new RoleWorkerDirectory({
    workers: [developer.asRoleWorker()],
    legacyEmployeeRegistry: employeeRegistry,
    legacyOwnedRoleIds: ["pr-reviewer"],
  });
  const workLoop = new ProactiveWorkLoop({
    ledger,
    roleDirectory,
    clock: () => "2026-08-08T01:00:00.000Z",
  });
  const noOpCycle = { async runCycle() {} };
  workCoordination = new WorkCoordinationService({
    ledger,
    proposalResultReconciler: noOpCycle,
    attentionResultReconciler: noOpCycle,
    conditionWaker: noOpCycle,
    workLoop,
    dispatcher: { async dispatchPending() {} },
  });
  const application = startupApplication({
    async close() {
      applicationCloses += 1;
    },
  });
  application.employeeRegistry = employeeRegistry;
  application.workCoordination = workCoordination;
  const backgroundWork = startApplicationBackgroundWork(application, {
    drainTimeoutMs: 20,
  });
  await backgroundWork.initialRefresh;
  const running = backgroundWork.runEmployee("developer", { trigger: "manual" });
  await providerStarted.promise;
  const server = createDashboardServer(application, {
    backgroundWork,
    shutdownDrainTimeoutMs: 40,
    writerLease: {
      async acquire() {},
      async close() {
        leaseCloses += 1;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await assert.rejects(server.shutdown(), { code: "LIFECYCLE_DRAIN_TIMEOUT" });
    assert.equal(providerSignal instanceof AbortSignal, true);
    assert.equal(providerSignal.aborted, true);
    assert.equal(applicationCloses, 0);
    assert.equal(leaseCloses, 0);
  } finally {
    providerRelease.resolve();
    await running.catch(() => {});
  }
});

test("a bounded shutdown timeout retains the application and writer lease fail-closed", async () => {
  let applicationCloses = 0;
  let leaseCloses = 0;
  const application = startupApplication({
    async close() {
      applicationCloses += 1;
    },
  });
  const server = createDashboardServer(application, {
    backgroundWork: { stop: () => new Promise(() => {}) },
    writerLease: {
      async acquire() {},
      async close() {
        leaseCloses += 1;
      },
    },
    shutdownDrainTimeoutMs: 20,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  await assert.rejects(server.shutdown(), { code: "LIFECYCLE_DRAIN_TIMEOUT" });
  assert.equal(applicationCloses, 0);
  assert.equal(leaseCloses, 0);
});

test("shutdown closes browser preconnections that have not sent an HTTP request", async () => {
  const events = [];
  const application = startupApplication({
    async close() { events.push("application-close"); },
  });
  const server = createDashboardServer(application, {
    backgroundWork: { async stop() { events.push("background-stop"); } },
    writerLease: {
      async acquire() {},
      async close() { events.push("lease-close"); },
    },
    shutdownDrainTimeoutMs: 250,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise((resolve) => server.once("connection", resolve));
  const client = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  const connected = new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  await Promise.all([accepted, connected]);
  try {
    assert.equal(client.bytesWritten, 0);
    await server.shutdown();
    assert.deepEqual(events, ["background-stop", "application-close", "lease-close"]);
  } finally {
    client.destroy();
    await server.shutdown().catch(() => {});
  }
});

test("shutdown closes a reused browser connection whose next HTTP headers are incomplete", { timeout: 2000 }, async (t) => {
  const events = [];
  const application = startupApplication({ async close() { events.push('application-close'); } });
  application.config.port = 4173;
  const server = createDashboardServer(application, {
    backgroundWork: { async stop() { events.push('background-stop'); } },
    writerLease: { async acquire() {}, async close() { events.push('lease-close'); } },
    shutdownDrainTimeoutMs: 250,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const accepted = deferred(), finished = deferred();
  server.once('connection', socket => accepted.resolve(socket));
  server.once('request', (_request, response) => response.once('finish', finished.resolve));
  const client = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  let response = '';
  client.on('data', chunk => { response += chunk.toString(); });
  t.after(async () => { client.destroy(); await server.shutdown().catch(() => {}); });
  try {
    const socket = await accepted.promise;
    client.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:4173\r\nConnection: keep-alive\r\n\r\n');
    await finished.promise;
    const nextHeaders = new Promise(resolve => socket.once('data', resolve));
    client.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:4173\r\nX-Pending:');
    await nextHeaders;
    const closed = new Promise(resolve => client.once('close', resolve));
    await server.shutdown();
    await closed;
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /\r\n0\r\n\r\n$/);
    assert.deepEqual(events, ['background-stop', 'application-close', 'lease-close']);
  } finally {
    client.destroy();
    await server.shutdown().catch(() => {});
  }
});

test("shutdown preserves an accepted pipelined POST after an earlier response finishes", { timeout: 2000 }, async (t) => {
  const started = deferred(), release = deferred(), firstFinished = deferred(), accepted = deferred();
  const events = [];
  const application = startupApplication({
    async refresh() { started.resolve(); return release.promise; },
    async close() { events.push('application-close'); },
  });
  application.config.port = 4173;
  const server = createDashboardServer(application, { shutdownDrainTimeoutMs: 1000,
    writerLease: { async acquire() {}, async close() { events.push('lease-close'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.once('connection', socket => accepted.resolve(socket));
  server.on('request', (incoming, response) => {
    if (incoming.method === 'GET') response.once('finish', firstFinished.resolve);
  });
  const client = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  const closed = new Promise(resolve => client.once('close', resolve));
  let response = '', clientError = null, stopping;
  client.on('data', chunk => { response += chunk.toString(); });
  client.on('error', error => { clientError = error; });
  t.after(async () => { release.resolve(healthyRefreshResult()); client.destroy(); await server.shutdown().catch(() => {}); });
  try {
    const socket = await accepted.promise;
    client.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:4173\r\nConnection: keep-alive\r\n\r\n' +
      'POST /api/refresh HTTP/1.1\r\nHost: 127.0.0.1:4173\r\nOrigin: http://127.0.0.1:4173\r\nX-MyDashboard-Action: 1\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');
    await Promise.all([started.promise, firstFinished.promise]);
    stopping = server.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(socket.destroyed, false);
    assert.deepEqual(events, []);
    release.resolve(healthyRefreshResult());
    await stopping;
    await closed;
    assert.equal(clientError, null);
    assert.equal((response.match(/HTTP\/1\.1 200 /g) ?? []).length, 2);
    assert.equal((response.match(/\r\n0\r\n\r\n/g) ?? []).length, 2);
    assert.deepEqual(events, ['application-close', 'lease-close']);
  } finally {
    release.resolve(healthyRefreshResult());
    client.destroy();
    await stopping?.catch(() => {});
    await server.shutdown().catch(() => {});
  }
});

test("shutdown waits for an accepted POST instead of treating it as a browser preconnection", async () => {
  const started = deferred();
  const release = deferred();
  const events = [];
  const application = startupApplication({
    async refresh() { started.resolve(); return release.promise; },
    async close() { events.push("application-close"); },
  });
  application.config.port = 4173;
  const server = createDashboardServer(application, {
    writerLease: {
      async acquire() {},
      async close() { events.push("lease-close"); },
    },
    shutdownDrainTimeoutMs: 1_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let socket;
  server.once("request", (incoming) => { socket = incoming.socket; });
  const pending = request(server, {
    method: "POST", path: "/api/refresh",
    headers: { origin: "http://127.0.0.1:4173", "x-mydashboard-action": "1", connection: "close" },
  });
  await started.promise;
  const stopping = server.shutdown();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.destroyed, false);
    assert.deepEqual(events, []);
    release.resolve(healthyRefreshResult());
    assert.equal((await pending).status, 200);
    await stopping;
    assert.deepEqual(events, ["application-close", "lease-close"]);
  } finally {
    release.resolve(healthyRefreshResult());
    await pending.catch(() => {});
    await stopping.catch(() => {});
  }
});

test("an unfinished POST keeps shutdown and the writer lease fail-closed", async () => {
  const started = deferred();
  const release = deferred();
  const events = [];
  const application = startupApplication({
    async refresh() { started.resolve(); return release.promise; },
    async close() { events.push("application-close"); },
  });
  application.config.port = 4173;
  const server = createDashboardServer(application, {
    writerLease: {
      async acquire() {},
      async close() { events.push("lease-close"); },
    },
    shutdownDrainTimeoutMs: 100,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let socket;
  server.once("request", (incoming) => { socket = incoming.socket; });
  const pending = request(server, {
    method: "POST", path: "/api/refresh",
    headers: { origin: "http://127.0.0.1:4173", "x-mydashboard-action": "1", connection: "close" },
  });
  await started.promise;
  try {
    await assert.rejects(server.shutdown(), { code: "LIFECYCLE_DRAIN_TIMEOUT" });
    assert.equal(socket.destroyed, false);
    assert.deepEqual(events, []);
  } finally {
    release.resolve(healthyRefreshResult());
    await pending;
  }
});

test("the writer lease excludes restore before recovery has opened a listener", async () => {
  const name = `mydashboard-test-writer-${createHash("sha256")
    .update(`${process.pid}-${Date.now()}-${Math.random()}`)
    .digest("hex")}`;
  const owner = new ProcessExclusiveGuard({ name });
  const competitor = new ProcessExclusiveGuard({ name });
  const recoveryStarted = deferred();
  const releaseRecovery = deferred();
  const application = startupApplication({ port: await availablePort() });
  let server = null;
  const starting = startDashboardServer({
    writerLease: owner,
    createApplicationFn: async () => {
      recoveryStarted.resolve();
      await releaseRecovery.promise;
      return application;
    },
    log() {},
  });

  try {
    await recoveryStarted.promise;
    const contention = await competitor.acquire().then(
      () => null,
      (error) => error,
    );
    assert.equal(contention?.code, "PROCESS_GUARD_HELD");
    assert.equal(server, null);
  } finally {
    await competitor.close();
    releaseRecovery.resolve();
    server = await starting.catch(() => null);
    if (server) await server.shutdown();
    else await owner.close();
  }

  const successor = new ProcessExclusiveGuard({ name });
  await successor.acquire();
  await successor.close();
});

test("awaited shutdown releases a delayed runtime before an immediate restart", async () => {
  let applicationNumber = 0;
  let runtimeHeld = false;
  let releaseFirstClose;
  let firstCloseStarted;
  const closeStarted = new Promise((resolve) => {
    firstCloseStarted = resolve;
  });
  const createApplicationFn = async () => {
    if (runtimeHeld) throw new Error("runtime lock still held");
    runtimeHeld = true;
    applicationNumber += 1;
    const currentApplication = applicationNumber;
    return {
      config: { port: 0, refreshMinutes: 10 },
      store: {
        async read() {
          return null;
        },
      },
      refreshService: {
        running: null,
        async refresh() {},
      },
      employeeRegistry: {
        get() {
          return null;
        },
        async listRoles() {
          return [];
        },
        schedules() {
          return [];
        },
        async runAll() {},
      },
      async close() {
        if (currentApplication === 1) {
          firstCloseStarted();
          await new Promise((resolve) => {
            releaseFirstClose = resolve;
          });
        }
        runtimeHeld = false;
      },
    };
  };
  const options = { createApplicationFn, log() {} };

  const firstServer = await startDashboardServer(options);
  assert.equal(firstServer instanceof http.Server, true);
  assert.equal(typeof firstServer.shutdown, "function");

  let shutdownFinished = false;
  const stopping = firstServer.shutdown().then(() => {
    shutdownFinished = true;
  });
  await closeStarted;
  assert.equal(shutdownFinished, false);
  await assert.rejects(
    () => startDashboardServer(options),
    /runtime lock still held/,
  );

  releaseFirstClose();
  await stopping;
  const restartedServer = await startDashboardServer(options);
  await restartedServer.shutdown();
  assert.equal(runtimeHeld, false);
});

test("startup allows local confirmation reads while writes wait for initial reconciliation", async () => {
  const port = await availablePort();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const reconcileStarted = deferred();
  const releaseReconcile = deferred();
  const queueCalls = [];
  let runAllCalls = 0;
  const application = startupApplication({
    port,
    queueCalls,
    async refresh() {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return healthyRefreshResult();
    },
    async recoverConfirmations() {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    },
    async runAll(options) {
      runAllCalls += 1;
      assert.deepEqual(options, { trigger: "refresh_completed" });
    },
  });
  let server = null;
  let startupSettled = false;
  const starting = startDashboardServer({
    createApplicationFn: async () => application,
    log() {},
  }).then(
    (startedServer) => {
      startupSettled = true;
      server = startedServer;
      return startedServer;
    },
    (error) => {
      startupSettled = true;
      throw error;
    },
  );

  try {
    await refreshStarted.promise;
    assert.equal(startupSettled, false);
    const healthDuringRefresh = await waitForPort(port, {
      path: "/api/health",
    });
    assert.equal(healthDuringRefresh.status, 200);
    const confirmationDuringRefresh = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmationDuringRefresh.status, 200);
    const historyDuringRefresh = await requestPort(port, { path: "/api/confirmations/history" });
    assert.equal(historyDuringRefresh.status, 200);
    const approvalDuringRefresh = await requestPort(port, {
      method: "POST", path: "/api/confirmations/confirmation-pr-work-1/approve",
      headers: { origin: `http://127.0.0.1:${port}`, "x-mydashboard-action": "1", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(approvalDuringRefresh.status, 503);
    assert.deepEqual(queueCalls, ["next", "history"]);

    releaseRefresh.resolve();
    await reconcileStarted.promise;
    assert.equal(startupSettled, false);
    const confirmationDuringReconcile = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmationDuringReconcile.status, 200);
    assert.deepEqual(queueCalls, ["next", "history", "next"]);

    releaseReconcile.resolve();
    server = await starting;
    const confirmation = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmation.status, 200);
    assert.equal(JSON.parse(confirmation.body).pendingCount, 1);
    assert.deepEqual(queueCalls, ["next", "history", "next", "next"]);
    assert.equal(runAllCalls, 1);
  } finally {
    releaseRefresh.resolve();
    releaseReconcile.resolve();
    if (!server) server = await starting.catch(() => null);
    if (server) await server.shutdown();
  }
});

test("initial refresh failure closes the listening server and releases resources", async () => {
  const port = await availablePort();
  const refreshFailure = new Error("initial GitHub refresh failed");
  const initialRefresh = deferred();
  let backgroundStops = 0;
  let applicationCloses = 0;
  const application = startupApplication({
    port,
    async close() {
      applicationCloses += 1;
    },
  });
  const starting = startDashboardServer({
    createApplicationFn: async () => application,
    startBackgroundWorkFn() {
      return {
        initialRefresh: initialRefresh.promise,
        async stop() {
          backgroundStops += 1;
        },
      };
    },
    log() {},
  });
  let server = null;

  try {
    const health = await waitForPort(port, { path: "/api/health" });
    assert.equal(health.status, 200);
    initialRefresh.reject(refreshFailure);
    await assert.rejects(starting, (error) => error === refreshFailure);
  } finally {
    initialRefresh.reject(refreshFailure);
    server = await starting.catch(() => null);
    if (server) await server.shutdown();
  }

  assert.equal(backgroundStops, 1);
  assert.equal(applicationCloses, 1);
  await assert.rejects(
    requestPort(port, { path: "/api/confirmations/next" }),
    (error) => ["ECONNREFUSED", "ECONNRESET"].includes(error.code),
  );
});

test("same-origin UI requests can refresh and confirm the displayed head", async () => {
  await withServer(async ({ server, calls }) => {
    const trustedHeaders = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    };
    const refresh = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: trustedHeaders,
    });
    const confirm = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        ...trustedHeaders,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      }),
    });

    assert.equal(refresh.status, 200);
    assert.equal(confirm.status, 200);
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      {
        operation: "confirm",
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      },
    ]);
  });
});

test("responsibility confirmation is routed through the fact-cycle gate", async () => {
  const gateCalls = [];
  await withServer(
    async ({ server, calls }) => {
      const response = await request(server, {
        method: "POST",
        path: "/api/pr-responsibility/confirm",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          id: "github:pr:acme/repo#7",
          actionState: "waiting_other",
          headRefOid: "head-7",
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(gateCalls, ["entered", "completed"]);
      assert.deepEqual(calls, [
        {
          operation: "confirm",
          id: "github:pr:acme/repo#7",
          actionState: "waiting_other",
          headRefOid: "head-7",
        },
      ]);
    },
    {
      backgroundWork: {
        async mutateFacts(operation) {
          gateCalls.push("entered");
          const result = await operation();
          gateCalls.push("completed");
          return result;
        },
      },
    },
  );
});

test("the scheduled service path can request notification delivery", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      method: "POST",
      path: "/api/refresh?notify=1",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ operation: "refresh", notify: true }]);
  });
});

test("dashboard and health expose the proactive employee without changing stored data", async () => {
  await withServer(async ({ server }) => {
    const dashboard = await request(server, { path: "/api/dashboard" });
    const health = await request(server, { path: "/api/health" });

    assert.equal(dashboard.status, 200);
    const dashboardBody = JSON.parse(dashboard.body);
    const healthBody = JSON.parse(health.body);
    assert.equal(dashboardBody.employee.role.id, "pr-reviewer");
    assert.equal("employees" in dashboardBody, false);
    assert.equal(healthBody.employee.state, "observing");
    assert.deepEqual(
      healthBody.employees.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
  });
});

test("server keeps legacy prEmployee-only applications operational", async () => {
  await withServer(async ({ server, calls }) => {
    const health = await request(server, { path: "/api/health" });
    const list = await request(server, { path: "/api/employees" });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(health.status, 200);
    assert.deepEqual(
      JSON.parse(health.body).employees.map((employee) => employee.id),
      ["pr-reviewer"],
    );
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).items.length, 1);
    assert.equal(run.status, 200);
    assert.deepEqual(calls, [
      { operation: "employee_tick", trigger: "manual" },
    ]);
  }, { legacyOnly: true });
});

test("employee discovery and dynamic routes work for every registered role", async () => {
  await withServer(async ({ server, calls }) => {
    const list = await request(server, { path: "/api/employees" });
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 2 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const missing = await request(server, {
      method: "POST",
      path: "/api/employees/missing-role/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(list.status, 200);
    assert.deepEqual(
      JSON.parse(list.body).items.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
    assert.equal("jobs" in JSON.parse(list.body).items[0], false);
    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(missing.status, 404);
    assert.equal(untrusted.status, 403);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("analyst_")),
      [
        { operation: "analyst_control", command: "pause", expectedRevision: 2 },
        { operation: "analyst_tick", trigger: "manual" },
      ],
    );
  });
});

test("employee discovery includes each role's current workload", async () => {
  const workLedgerView = {
    async getSummary() { return { itemCounts: {} }; },
    async listItems() { return { items: [], nextCursor: null }; },
    async listTimeline() { return { items: [], nextCursor: null }; },
    async getRoleWorkloads() {
      return {
        items: [{
          roleId: "requirements-analyst",
          counts: { queued: 2, working: 1, waiting: 3, blocked: 4 },
          tasks: [{
            itemId: "work-item-visible",
            status: "working",
            title: "Clarify acceptance criteria",
            updatedAt: "2026-08-26T10:00:00.000Z",
            subject: null,
          }],
        }],
      };
    },
  };

  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/employees" });
    const roles = JSON.parse(response.body).items;
    const requirements = roles.find(({ id }) => id === "requirements-analyst");
    const reviewer = roles.find(({ id }) => id === "pr-reviewer");

    assert.equal(response.status, 200);
    assert.equal(requirements.workload.counts.working, 1);
    assert.equal(requirements.workload.tasks[0].title, "Clarify acceptance criteria");
    assert.deepEqual(reviewer.workload, {
      available: true,
      counts: { queued: 0, working: 0, waiting: 0, blocked: 0 },
      tasks: [],
    });
  }, { workLedgerView });

  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/employees" });
    const roles = JSON.parse(response.body).items;
    assert.equal(response.status, 200);
    assert.equal(roles[0].workload.available, false);
  });

  await withServer(async ({ server, reportedErrors }) => {
    const response = await request(server, { path: "/api/employees" });
    const roles = JSON.parse(response.body).items;
    assert.equal(response.status, 200);
    assert.equal(roles[0].workload.available, false);
    assert.equal(reportedErrors.length, 1);
  }, {
    workLedgerView: {
      async getSummary() { return { itemCounts: {} }; },
      async listItems() { return { items: [], nextCursor: null }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
      async getRoleWorkloads() { throw new Error("ledger unavailable"); },
    },
  });
});

test("employee control, manual run, draft decisions, and blocked recovery use trusted local mutations", async () => {
  await withServer(async ({ server, calls }) => {
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 4 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const decide = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/decide",
      headers,
      body: JSON.stringify({
        id: "pr-work-1",
        decision: "accept",
        headRefOid: "head-1",
        expectedRevision: 4,
      }),
    });
    const retryBlocked = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/resolve",
      headers,
      body: JSON.stringify({
        id: "pr-work-blocked",
        action: "retry",
        headRefOid: "head-blocked",
        expectedRevision: 4,
      }),
    });
    const expansiveBlocked = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/resolve",
      headers,
      body: JSON.stringify({
        id: "pr-work-blocked",
        action: "dismiss",
        headRefOid: "head-blocked",
        expectedRevision: 4,
        targetRoleId: "pr-engineer",
      }),
    });

    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(decide.status, 200);
    assert.equal(retryBlocked.status, 200);
    assert.equal(expansiveBlocked.status, 400);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("employee_")),
      [
        { operation: "employee_control", command: "pause", expectedRevision: 4 },
        { operation: "employee_tick", trigger: "manual" },
        {
          operation: "employee_decide",
          id: "pr-work-1",
          decision: "accept",
          headRefOid: "head-1",
          expectedRevision: 4,
        },
        {
          operation: "employee_resolve_blocked",
          id: "pr-work-blocked",
          action: "retry",
          headRefOid: "head-blocked",
          expectedRevision: 4,
        },
      ],
    );
  });
});

test("retrying a blocked PR job signals only the legacy employee after persistence", async () => {
  const signalled = deferred();
  await withServer(async ({ server }) => {
    const response = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/resolve",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "pr-work-blocked",
        action: "retry",
        headRefOid: "head-blocked",
        expectedRevision: 4,
      }),
    });

    assert.equal(response.status, 200);
    const signal = await Promise.race([
      signalled.promise,
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    assert.deepEqual(signal, {
      id: "pr-reviewer",
      options: { trigger: "blocked_job_retry" },
    });
  }, {
    backgroundWork: {
      async runEmployee(id, options) {
        signalled.resolve({ id, options });
      },
    },
  });
});

test("dismissing a blocked PR job never wakes the employee", async () => {
  let signalCount = 0;
  await withServer(async ({ server }) => {
    const response = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/resolve",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "pr-work-blocked",
        action: "dismiss",
        headRefOid: "head-blocked",
        expectedRevision: 4,
      }),
    });

    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signalCount, 0);
  }, {
    backgroundWork: {
      async runEmployee() {
        signalCount += 1;
      },
    },
  });
});

test("memory search is local, bounded, and read-only", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/memory/search?q=checkout&limit=999",
    });
    const defaultLimit = await request(server, {
      path: "/api/memory/search?q=checkout",
    });

    assert.equal(response.status, 200);
    assert.equal(defaultLimit.status, 200);
    assert.deepEqual(JSON.parse(response.body).items, [
      { id: "memory-1", title: "Checkout review" },
    ]);
    assert.deepEqual(calls.slice(-2), [
      {
        operation: "memory_search",
        query: "checkout",
        limit: 100,
      },
      {
        operation: "memory_search",
        query: "checkout",
        limit: 30,
      },
    ]);
  });
});

test("unified memory keeps the legacy search shape and reports local health", async () => {
  const memorySearch = {
    async search(options) {
      assert.deepEqual(options, { q: "checkout", limit: 100 });
      return {
        items: [{ id: "memory-2", title: "Unified checkout memory" }],
        nextCursor: null,
        totalMatched: 1,
        indexHealthy: true,
      };
    },
    async getHealth() {
      return {
        ready: true,
        revision: 3,
        recordCount: 8,
        indexHealthy: true,
        lastIndexError: "",
      };
    },
  };
  await withServer(
    async ({ server }) => {
      const search = await request(server, {
        path: "/api/memory/search?q=checkout&limit=999",
      });
      const health = await request(server, { path: "/api/health" });

      assert.equal(search.status, 200);
      assert.deepEqual(JSON.parse(search.body), {
        query: "checkout",
        items: [{ id: "memory-2", title: "Unified checkout memory" }],
      });
      assert.deepEqual(JSON.parse(health.body).memory, {
        ready: true,
        revision: 3,
        recordCount: 8,
        indexHealthy: true,
        lastIndexError: "",
      });
    },
    { memorySearch },
  );
});

test("health reports memory authority catch-up without exposing stale query data", async () => {
  const authorityError = Object.assign(
    new Error("memory authority has not caught up"),
    {
      code: "MEMORY_AUTHORITY_NOT_CURRENT",
      statusCode: 503,
    },
  );
  const memorySearch = {
    async search() {
      throw authorityError;
    },
    async getHealth() {
      throw authorityError;
    },
  };

  await withServer(
    async ({ server, reportedErrors }) => {
      const health = await request(server, { path: "/api/health" });
      const query = await request(server, {
        path: "/api/memory/query?q=checkout",
      });

      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body).memory, {
        ready: false,
        authorityCurrent: false,
      });
      assert.equal(query.status, 503);
      assert.deepEqual(reportedErrors, []);
    },
    { memorySearch },
  );
});

test("health does not mask unexpected memory failures", async () => {
  const memorySearch = {
    async search() {
      return { items: [] };
    },
    async getHealth() {
      throw new Error("memory health failed unexpectedly");
    },
  };

  await withServer(
    async ({ server, reportedErrors }) => {
      const health = await request(server, { path: "/api/health" });

      assert.equal(health.status, 500);
      assert.equal(reportedErrors.length, 1);
      assert.match(reportedErrors[0].message, /failed unexpectedly/);
    },
    { memorySearch },
  );
});

test("health stays responsive during a pending memory authority check and shares its probe", async () => {
  let resolveHealth;
  let calls = 0;
  const pending = new Promise(resolve => { resolveHealth = resolve; });
  const memorySearch = { async search() { throw new Error("Query must retain its own authority check"); },
    async getHealth() { calls += 1; return pending; } };
  await withServer(async ({ server }) => {
    const started = Date.now();
    const checks = Promise.all([request(server, { path: "/api/health" }), request(server, { path: "/api/health" })]);
    const failSafe = setTimeout(() => resolveHealth({ ready: true }), 2_000);
    try {
      const responses = await checks;
      assert.ok(Date.now() - started < 1_500, "Health must not wait for the authority queue");
      assert.equal(calls, 1);
      for (const health of responses) {
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.body).memory, { ready: false, authorityCurrent: false, checking: true });
      }
      resolveHealth({ ready: true, authorityCurrent: true });
      await new Promise(resolve => setImmediate(resolve));
      await request(server, { path: "/api/health" });
      assert.equal(calls, 2, "A completed probe must not become a cached authority claim");
    } finally { clearTimeout(failSafe); resolveHealth({ ready: true }); }
  }, { memorySearch });
});

test("unified memory query forwards only bounded filters and pagination", async () => {
  const calls = [];
  const cursor = Buffer.from(
    JSON.stringify(["2026-08-02T01:02:03.000Z", `memory-${"a".repeat(64)}`]),
  ).toString("base64url");
  const memorySearch = {
    async search(options) {
      calls.push(options);
      return {
        items: [],
        nextCursor: null,
        totalMatched: 0,
        indexHealthy: true,
      };
    },
    async getHealth() {
      return { ready: true };
    },
  };
  const query = new URLSearchParams({
    q: "结算失败",
    roleId: "requirements-analyst",
    repository: "acme/repo",
    eventType: "requirements.clarified",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    limit: "5",
    cursor,
  });

  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/memory/query?${query}`,
      });
      const unknown = await request(server, {
        path: "/api/memory/query?debug=1",
      });
      const duplicate = await request(server, {
        path: "/api/memory/query?q=one&q=two",
      });

      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), {
        items: [],
        nextCursor: null,
        totalMatched: 0,
        indexHealthy: true,
      });
      assert.deepEqual(calls, [Object.fromEntries(query)]);
      assert.equal(unknown.status, 400);
      assert.equal(duplicate.status, 400);
    },
    { memorySearch },
  );
});

test("unified memory query fails closed when the local journal is unavailable", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/memory/query?q=test" });

    assert.equal(response.status, 503);
  });
});

test("cited memory answering is an explicit same-origin bounded operation", async () => {
  const calls = [];
  const input = {
    schemaVersion: 1,
    question: "测试为什么失败？",
    mode: "configured",
    retrieval: {
      kind: "query",
      filters: { query: "测试失败", repository: "acme/repo" },
    },
  };
  const result = {
    schemaVersion: 1,
    status: "insufficient_evidence",
    answer: "证据不足",
    derived: false,
    claims: [],
    citations: [],
    context: {
      contextDigest: "a".repeat(64),
      recordIds: [],
      records: [],
    },
    brain: {
      mode: "configured",
      provider: "ollama",
      model: "qwen",
      remote: false,
    },
    localRerunAvailable: true,
  };
  await withServer(
    async ({ server }) => {
      const body = JSON.stringify(input);
      const accepted = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body,
      });
      const crossOrigin = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "https://attacker.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const wrongType = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "text/plain",
        },
        body,
      });

      assert.equal(accepted.status, 200);
      assert.deepEqual(JSON.parse(accepted.body), result);
      assert.equal(crossOrigin.status, 403);
      assert.equal(wrongType.status, 415);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].value, input);
      assert.equal(calls[0].signal?.aborted, false);
    },
    {
      memoryAnswer: {
        async answer(value, { signal } = {}) {
          calls.push({ value: structuredClone(value), signal });
          return structuredClone(result);
        },
      },
    },
  );
});

test("disconnecting a memory answer client cancels server work and frees the next slot", async () => {
  const started = deferred();
  const cancelled = deferred();
  let inFlight = 0;
  let observedSignal = null;
  await withServer(
    async ({ server, reportedErrors }) => {
      const body = JSON.stringify({ slow: true });
      let outgoing;
      const abandoned = new Promise((resolve) => {
        outgoing = http.request({
          host: "127.0.0.1",
          port: server.address().port,
          method: "POST",
          path: "/api/memory/answer",
          headers: {
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-mydashboard-action": "1",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        });
        outgoing.on("response", (response) => {
          response.resume();
          response.on("end", resolve);
        });
        outgoing.on("error", resolve);
        outgoing.end(body);
      });

      await started.promise;
      outgoing.destroy();
      await cancelled.promise;
      await abandoned;

      const next = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ slow: false }),
      });

      assert.equal(observedSignal.aborted, true);
      assert.equal(next.status, 200);
      assert.deepEqual(JSON.parse(next.body), { status: "answered" });
      assert.deepEqual(reportedErrors, []);
    },
    {
      memoryAnswer: {
        async answer(value, { signal }) {
          if (inFlight >= 1) {
            throw Object.assign(new Error("busy"), { statusCode: 429 });
          }
          inFlight += 1;
          try {
            if (!value.slow) return { status: "answered" };
            observedSignal = signal;
            started.resolve();
            await new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                cancelled.resolve();
                reject(Object.assign(new Error("cancelled"), {
                  code: "MEMORY_ANSWER_CANCELLED",
                  statusCode: 499,
                }));
              }, { once: true });
            });
          } finally {
            inFlight -= 1;
          }
        },
      },
    },
  );
});

test("memory answer availability and provider failures remain safely classified", async () => {
  await withServer(async ({ server }) => {
    const unavailable = await request(server, {
      method: "POST",
      path: "/api/memory/answer",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ safe: true }),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(JSON.parse(unavailable.body), { error: "服务器内部错误" });
  });

  const failure = Object.assign(new Error("private provider response"), {
    code: "STRUCTURED_PROVIDER_REQUEST_FAILED",
    statusCode: 502,
  });
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ safe: true }),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
      assert.deepEqual(reportedErrors, [failure]);
      assert.equal(response.body.includes("private provider response"), false);
    },
    {
      memoryAnswer: {
        async answer() { throw failure; },
      },
    },
  );
});

test("memory session and Git imports require explicit same-origin opt-in ports", async () => {
  const calls = [];
  const session = {
    schemaVersion: 1,
    provider: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-05T01:00:00.000Z",
    title: "Memory work",
    entries: [{
      role: "user",
      occurredAt: "2026-08-05T01:00:01.000Z",
      content: "Continue the command center.",
    }],
  };
  const git = {
    schemaVersion: 1,
    repository: "acme/repo",
    commits: [{
      oid: "a".repeat(40),
      occurredAt: "2026-08-05T01:02:00.000Z",
      author: "Ada",
      subject: "Add memory import",
      body: "",
    }],
  };
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };

  await withServer(
    async ({ server }) => {
      const sessionResponse = await request(server, {
        method: "POST",
        path: "/api/memory/import/session",
        headers: trustedHeaders,
        body: JSON.stringify(session),
      });
      const gitResponse = await request(server, {
        method: "POST",
        path: "/api/memory/import/git",
        headers: trustedHeaders,
        body: JSON.stringify(git),
      });
      const untrusted = await request(server, {
        method: "POST",
        path: "/api/memory/import/session",
        headers: {
          ...trustedHeaders,
          origin: "https://attacker.example",
        },
        body: JSON.stringify(session),
      });

      assert.equal(sessionResponse.status, 200);
      assert.deepEqual(JSON.parse(sessionResponse.body), {
        schemaVersion: 1,
        kind: "session",
        added: 1,
      });
      assert.equal(gitResponse.status, 200);
      assert.deepEqual(JSON.parse(gitResponse.body), {
        schemaVersion: 1,
        kind: "git",
        added: 1,
      });
      assert.equal(untrusted.status, 403);
      assert.deepEqual(calls, [
        { kind: "session", value: session },
        { kind: "git", value: git },
      ]);
    },
    {
      memoryImports: {
        session: {
          async importSession(value) {
            calls.push({ kind: "session", value: structuredClone(value) });
            return { schemaVersion: 1, kind: "session", added: 1 };
          },
        },
        git: {
          async importCommits(value) {
            calls.push({ kind: "git", value: structuredClone(value) });
            return { schemaVersion: 1, kind: "git", added: 1 };
          },
        },
      },
    },
  );
});

test("disabled and oversized memory imports fail before invoking an importer", async () => {
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(async ({ server }) => {
    const unavailable = await request(server, {
      method: "POST",
      path: "/api/memory/import/session",
      headers: trustedHeaders,
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    assert.equal(unavailable.status, 503);
  });

  let calls = 0;
  await withServer(
    async ({ server }) => {
      const oversized = await request(server, {
        method: "POST",
        path: "/api/memory/import/git",
        headers: trustedHeaders,
        body: "x".repeat(3 * 1024 * 1024 + 1),
      });
      assert.equal(oversized.status, 413);
      assert.equal(calls, 0);
    },
    {
      memoryImports: {
        git: {
          async importCommits() {
            calls += 1;
          },
        },
      },
    },
  );
});
