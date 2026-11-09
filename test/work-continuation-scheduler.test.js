import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkContinuationScheduler } from '../src/services/work-continuation-scheduler.js';
import { WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState, migrateWorkContinuationState } from '../src/services/work-continuation-state.js';
import { continuationFingerprint, normalizeContinuationTarget } from '../src/services/work-continuation-state.js';
import { indexWorkLedgerGraphProgress } from '../src/services/work-ledger-graph-progress.js';
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { RoleDecisionEngine } from '../src/services/role-decision-engine.js';
import { coordinatorGoalControl } from '../src/domain/work-goal-ownership.js';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let persisted;
  let now = Date.parse('2026-10-21T00:00:00.000Z');
  const items = [{ itemId: 'work-one', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'developer' } }];
  const role = { enabled: true, paused: false };
  const config = { githubActions: { enabled: true, automaticOwnPrRepair: true } };
  const operations = [];
  const dispatched = [];
  const store = {
    async read(key, fallback) { assert.equal(key, WORK_CONTINUATION_STATE_KEY); return clone(persisted ?? fallback); },
    async write(key, state) { assert.equal(key, WORK_CONTINUATION_STATE_KEY); persisted = normalizeWorkContinuationState(state); },
  };
  const ledger = {
    async listItems() { return { items: clone(items.filter(item => ['waiting_external', 'waiting_condition', 'retry_wait', 'paused', 'dispatch_pending'].includes(item.status))), nextCursor: null }; },
    async listClaimCandidates() { return { items: clone(items), nextCursor: null, facts: items.map(item => ({ itemId: item.itemId, graphBlocked: false })) }; },
    async readItemForReconciliation({ itemId }) { return clone(items.find(item => item.itemId === itemId) ?? null); },
    async readItemProgress(ids) { return clone(items.filter(item => ids.includes(item.itemId))); },
  };
  const options = { store, ledger, configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return role; } }, clock: () => new Date(now) };
  const dispatch = async ({ roleId }) => {
    assert.ok(persisted.records.some(record => record.roleId === roleId && record.status === 'running'), 'intent must be durable before dispatch');
    dispatched.push(roleId);
    items.filter(item => item.currentTarget.id === roleId).forEach(item => { item.revision += 1; });
  };
  const runOperation = operation => { const running = operation(); operations.push(running); return running; };
  return { items, role, config, options, store, ledger, dispatched, dispatch, runOperation,
    state: () => clone(persisted), seed: value => { persisted = clone(value); },
    advance: ms => { now += ms; }, async drain() { await Promise.all(operations.splice(0)); } };
}

function relatedProgressFixture() {
  const f = fixture();
  f.items[0].currentTarget.id = 'orchestrator';
  f.items[0].graph = { parentItemId: null, dependsOnItemIds: [] };
  f.items.push({ itemId: 'review-child', revision: 7, status: 'completed', currentTarget: { type: 'role', id: 'pr-engineer' },
    graph: { parentItemId: f.items[0].itemId, dependsOnItemIds: [] } });
  const project = item => ({ ...clone(item), graphProgressDigest: indexWorkLedgerGraphProgress(f.items).graphProgressDigest(item) });
  f.ledger.listClaimCandidates = async () => ({ items: [clone(f.items[0])], nextCursor: null,
    facts: [{ itemId: f.items[0].itemId, graphBlocked: false, graphProgressDigest: project(f.items[0]).graphProgressDigest }] });
  f.ledger.readItemProgress = async ids => f.items.filter(item => ids.includes(item.itemId)).map(project);
  return f;
}

test('coordination progress preserves the existing digest when there is no related nested return', () => {
  const root = { itemId: 'root', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'orchestrator' },
    graph: { parentItemId: null, dependsOnItemIds: [] } };
  const child = { itemId: 'child', revision: 2, status: 'queued', graph: { parentItemId: 'root', dependsOnItemIds: [] } };
  const items = [root, child];
  // Captured before nested-return observations were added: unaffected roots
  // must retain their persisted condition reference across this code change.
  const existingDigest = '8852ff68a5424b5f10445ca623196a9f9dadefac851b20392e21de8803b716f8';
  const read = () => indexWorkLedgerGraphProgress(items).graphProgressDigest(root);
  assert.equal(read(), existingDigest);
  const nested = { itemId: 'nested', kind: 'graph_task', revision: 1, status: 'queued',
    currentTarget: { type: 'role', id: 'developer' }, graph: { parentItemId: child.itemId, dependsOnItemIds: [] } };
  items.push(nested);
  assert.equal(read(), existingDigest);
  nested.revision++;
  assert.equal(read(), existingDigest, 'ordinary nested work cannot reset a root coordination budget');
  items.push({ ...root, itemId: 'unrelated-root' }, { ...nested, itemId: 'unrelated-return',
    currentTarget: { type: 'role', id: 'orchestrator' }, graph: { parentItemId: 'unrelated-parent', dependsOnItemIds: [] } },
  { ...child, itemId: 'unrelated-parent', graph: { parentItemId: 'unrelated-root', dependsOnItemIds: [] } });
  assert.equal(read(), existingDigest, 'another root nested return cannot reset this budget');
  nested.currentTarget.id = 'orchestrator';
  assert.notEqual(read(), existingDigest);
});

test('an unassigned automatic Review waits across retries and restart until assignment changes', async () => {
  const f = fixture();
  f.config.githubActions.automaticReview = true;
  f.config.githubActions.actorAccountId = 'reviewer';
  f.items[0].currentTarget.id = 'pr-engineer';
  f.items[0].event = { source: { provider: 'github' }, payload: { relation: 'review_requested', state: 'open', isDraft: false,
    author: 'developer', assignees: [], headRefOid: 'a'.repeat(40) } };
  let scheduler = new WorkContinuationScheduler(f.options);
  for (let index = 0; index < 3; index++) {
    await scheduler.runCycle(f); await f.drain(); f.advance(600_000);
  }
  assert.deepEqual(f.dispatched, []);
  const waiting = f.state().records[0];
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.recovery.action, 'await_condition');
  assert.equal(waiting.condition.type, 'fact_change');
  assert.match(waiting.condition.reference, /NO_CURRENT_INCOMING_REQUEST/);
  scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await f.drain();
  assert.deepEqual(f.state().records[0], waiting, 'unchanged admission does not write another wake or retry');
  f.items[0].event.payload.assignees = ['reviewer'];
  f.items[0].revision++;
  await scheduler.runCycle(f); await f.drain();
  assert.deepEqual(f.dispatched, ['pr-engineer']);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('automatic Review configuration and already-reviewed Head use the same wait gate as execution', async () => {
  const f = fixture();
  Object.assign(f.config.githubActions, { automaticReview: false, actorAccountId: 'reviewer' });
  f.items[0].currentTarget.id = 'pr-engineer';
  const payload = { relation: 'review_requested', state: 'open', isDraft: false, author: 'developer', assignees: ['reviewer'],
    headRefOid: 'a'.repeat(40), myReviewState: 'APPROVED', myReviewCommitOid: 'a'.repeat(40) };
  f.items[0].event = { source: { provider: 'github' }, payload };
  const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.dispatched.length, 0);
  assert.match(f.state().records[0].condition.reference, /AUTOMATIC_REVIEW_DISABLED/);
  f.config.githubActions.automaticReview = true;
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.dispatched.length, 0);
  assert.match(f.state().records[0].condition.reference, /HEAD_ALREADY_REVIEWED/);
  payload.headRefOid = 'b'.repeat(40);
  f.items[0].revision++;
  await scheduler.runCycle(f); await f.drain();
  assert.deepEqual(f.dispatched, ['pr-engineer']);
});

test('explicit owner Review and manual role pause retain their existing controls', async () => {
  const owner = fixture();
  Object.assign(owner.config.githubActions, { automaticReview: false, actorAccountId: 'reviewer' });
  owner.items[0].currentTarget.id = 'pr-engineer';
  owner.items[0].event = { source: { provider: 'local-owner' }, payload: { relation: 'review_requested' } };
  await new WorkContinuationScheduler(owner.options).runCycle(owner); await owner.drain();
  assert.deepEqual(owner.dispatched, ['pr-engineer']);
  const paused = fixture();
  Object.assign(paused.config.githubActions, { automaticReview: true, actorAccountId: 'reviewer' });
  paused.items[0].currentTarget.id = 'pr-engineer';
  paused.items[0].event = { source: { provider: 'github' }, payload: { relation: 'review_requested', state: 'open', isDraft: false,
    author: 'developer', assignees: ['reviewer'], headRefOid: 'a'.repeat(40) } };
  paused.role.paused = true;
  const scheduler = new WorkContinuationScheduler(paused.options);
  await scheduler.runCycle(paused); await paused.drain();
  assert.deepEqual(paused.dispatched, []);
  assert.equal(paused.state().records[0].condition.type, 'manual_resume');
  paused.role.paused = false;
  await scheduler.runCycle(paused); await paused.drain();
  assert.deepEqual(paused.dispatched, ['pr-engineer']);
});

test('unrelated graph churn keeps backoff while a related child or dependency change rearms once', async () => {
  const f = relatedProgressFixture(), scheduler = new WorkContinuationScheduler(f.options);
  f.items.push({ itemId: 'unrelated', revision: 1, status: 'completed', currentTarget: { type: 'role', id: 'tester' } });
  let calls = 0;
  const run = async () => { await scheduler.runCycle({ ...f, dispatch: async () => { calls++; } }); await f.drain(); };
  for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
  const before = f.state().records.find(record => record.itemId === 'work-one');
  f.items[2].revision++;
  await run();
  assert.equal(calls, 3);
  assert.deepEqual(f.state().records.find(record => record.itemId === 'work-one'), before);
  f.items[1].revision++;
  await run();
  assert.equal(calls, 4);
  assert.equal(f.state().records[0].attempt, 1);
  await run();
  assert.equal(calls, 4);
  f.items[0].graph.dependsOnItemIds = ['unrelated'];
  await run();
  assert.equal(calls, 5);
  f.items[2].revision++;
  await run();
  assert.equal(calls, 6, 'the previously unrelated item now belongs to this dependency observation');
});

test('related progress during an active wake preserves the owner and survives its late acknowledgement', async () => {
  const f = relatedProgressFixture(), scheduler = new WorkContinuationScheduler(f.options), held = deferred();
  let calls = 0;
  await scheduler.runCycle({ ...f, dispatch: async () => { calls++; await held.promise; } });
  await new Promise(resolve => setImmediate(resolve));
  const fingerprint = f.state().records[0].fingerprint;
  f.items[1].revision++;
  await scheduler.runCycle({ ...f, dispatch: async () => { calls++; } });
  assert.equal(calls, 1, 'the actual running owner retains the role until settlement');
  assert.equal(f.state().records[0].status, 'pending');
  held.resolve(); await f.drain();
  assert.equal(f.state().records[0].status, 'pending');
  assert.equal(f.state().records[0].fingerprint, fingerprint);
  assert.equal(f.state().records[0].receipts[0].outcome, 'progressed');
  await scheduler.runCycle({ ...f, dispatch: async value => { calls++; await f.dispatch(value); } }); await f.drain();
  assert.equal(calls, 2);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('unavailable related-progress telemetry cannot prevent an otherwise admitted role dispatch', async () => {
  const f = relatedProgressFixture(), scheduler = new WorkContinuationScheduler(f.options);
  f.ledger.readItemProgress = async () => { throw new Error('observation unavailable'); };
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.state().records[0].receipts[0].outcome, 'progressed');
  assert.equal(scheduler.readStatus().lastError, 'progress_observation_failed');
});

test('a durable wake survives restart and advances through the existing role dispatch', async () => {
  const f = fixture();
  const first = new WorkContinuationScheduler(f.options);
  await first.runCycle({ dispatch: f.dispatch, runOperation: async () => { throw new Error('admission closed'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().records[0].status, 'running');
  assert.equal(first.readStatus().lastError, 'wake_receipt_failed');
  assert.equal(f.dispatched.length, 0);
  const restarted = new WorkContinuationScheduler(f.options);
  await restarted.runCycle(f);
  await f.drain();
  assert.deepEqual(f.dispatched, ['developer']);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('dispatch carries only the exact durable target fingerprint and progresses that item', async () => {
  const f = fixture();
  f.items.push({ ...clone(f.items[0]), itemId: 'work-other' });
  const expected = { itemId: f.items[0].itemId, fingerprint: continuationFingerprint(f.items[0]) };
  await new WorkContinuationScheduler(f.options).runCycle({ ...f, async dispatch({ roleId, continuationTarget }) {
    assert.equal(roleId, 'developer');
    assert.deepEqual(continuationTarget, expected);
    assert.equal(f.state().records.find(x => x.itemId === expected.itemId).status, 'running');
    f.items.find(x => x.itemId === continuationTarget.itemId).revision += 1;
  } });
  await f.drain();
  assert.equal(f.items[0].revision, 2);
  assert.equal(f.items[1].revision, 1);
  assert.equal(f.state().records.find(x => x.itemId === expected.itemId).status, 'delivered');
});

test('continuation target normalization rejects malformed or executable input without evaluating it', () => {
  const valid = { itemId: 'work-one', fingerprint: 'a'.repeat(64) };
  assert.deepEqual(normalizeContinuationTarget(valid), valid);
  assert.equal(Object.isFrozen(normalizeContinuationTarget(valid)), true);
  for (const value of [{ ...valid, extra: true }, { itemId: '../outside', fingerprint: valid.fingerprint },
    { ...valid, fingerprint: [valid.fingerprint] }, { ...valid, fingerprint: 'not-a-hash' }]) {
    assert.throws(() => normalizeContinuationTarget(value));
  }
  let calls = 0;
  const getter = { fingerprint: valid.fingerprint };
  Object.defineProperty(getter, 'itemId', { enumerable: true, get() { calls += 1; return valid.itemId; } });
  assert.throws(() => normalizeContinuationTarget(getter)); assert.equal(calls, 0);
});

test('interrupted third attempts recover without exceeding the persisted schema', async () => {
  const f = fixture();
  await new WorkContinuationScheduler(f.options).runCycle({ dispatch: f.dispatch, runOperation: async () => {} });
  const state = f.state(); state.records[0].attempt = 3; f.seed(state);
  await new WorkContinuationScheduler(f.options).runCycle(f);
  await f.drain();
  assert.equal(f.state().records[0].attempt, 3);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('no dispatch occurs when the durable intent cannot be saved', async () => {
  const f = fixture(); f.store.write = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(new WorkContinuationScheduler(f.options).runCycle(f), /disk unavailable/);
  assert.equal(f.dispatched.length, 0);
});

test('lost wake acknowledgement recovers in the same process without losing the intent', async () => {
  const f = fixture(); const write = f.store.write; let writes = 0;
  f.store.write = async (...args) => { if (++writes === 2) throw new Error('ack write failed'); return write(...args); };
  const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await assert.rejects(f.drain(), /ack write failed/);
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
  assert.equal(f.dispatched.length, 2);
});

test('slow roles coalesce while other roles advance and old acknowledgements cannot overwrite a new revision', async () => {
  const f = fixture(); const blocked = deferred();
  f.items.push({ itemId: 'work-test', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'tester' } });
  const scheduler = new WorkContinuationScheduler(f.options);
  let developerRuns = 0;
  const dispatch = async ({ roleId }) => {
    if (roleId === 'developer') { developerRuns += 1; await blocked.promise; }
    else await f.dispatch({ roleId });
  };
  await scheduler.runCycle({ ...f, dispatch });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.dispatched, ['tester']);
  f.items[0].revision += 1;
  await scheduler.runCycle({ ...f, dispatch });
  assert.equal(developerRuns, 1);
  const pending = f.state().records.find(record => record.itemId === 'work-one');
  assert.equal(pending.status, 'pending');
  blocked.resolve(); await f.drain();
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').fingerprint, pending.fingerprint);
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').status, 'pending');
  assert.notEqual(f.state().records.find(record => record.itemId === 'work-one').receipts[0].finishedAt, null);
});

test('repeated unchanged inputs back off and remain recoverable after stalled diagnostics', async () => {
  const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options); let calls = 0;
  const input = { ...f, dispatch: async () => { calls += 1; } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scheduler.runCycle(input); await f.drain();
    await scheduler.runCycle(input); await f.drain();
    assert.equal(calls, attempt + 1);
    f.advance(90_000);
  }
  assert.equal(scheduler.readStatus().stalledCount, 1);
  f.advance(300_000);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
});

test('unchanged deterministic decision failures stop model retries across restart and rearm on effective input changes', async t => {
  for (const code of ['ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION', 'STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED', 'STRUCTURED_PROVIDER_RESPONSE_INVALID', 'STRUCTURED_BRAIN_RESPONSE_INVALID'])
    for (const status of ['queued', 'retry_wait']) for (const change of ['task', 'related-child', 'configuration', 'runtime']) await t.test(`${code}: ${status}: ${change}`, async () => {
    const f = relatedProgressFixture();
    f.items[0].status = status;
    let runtimeRevision = 'a'.repeat(64), calls = 0, receipt;
    f.options.taskRuns = { async order(items) { return items; }, async get() { return { active: false, receipt }; } };
    let scheduler = new WorkContinuationScheduler(f.options);
    const dispatch = async () => {
      calls++;
      receipt = { roleId: f.items[0].currentTarget.id, taskId: f.items[0].itemId, taskRevision: f.items[0].revision, registeredAt: f.options.clock().toISOString(),
        phase: 'failed', outcomeCode: code };
    };
    const run = async () => { await scheduler.runCycle({ ...f, dispatch, runtimeRevision }); await f.drain(); };
    for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
    assert.equal(calls, 3);
    assert.equal(f.state().records[0].recovery.action, 'await_condition');
    scheduler = new WorkContinuationScheduler(f.options);
    f.advance(3600_000); await run();
    assert.equal(calls, 3, 'restart and elapsed time do not change the rejected input');
    if (change === 'task') f.items[0].revision++;
    if (change === 'related-child') f.items[1].revision++;
    if (change === 'configuration') f.config.workCoordination = { leaseDurationMs: 180_000 };
    if (change === 'runtime') runtimeRevision = 'b'.repeat(64);
    await run();
    assert.equal(calls, 4, `${change} rearms the existing task without a new enqueue`);
  });
});

test('owner root cancel responses stop through real decision and run receipts, then rearm only on effective change', async () => {
  const f = relatedProgressFixture();
  let calls = 0;
  const runState = new Map();
  const runStore = {
    async read(key, fallback) { return clone(runState.get(key) ?? fallback); },
    async write(key, value) { runState.set(key, clone(value)); },
  };
  const runs = new TaskRunRegistry({ store: runStore, receiptStore: runStore,
    settleControl: async () => {}, clock: f.options.clock });
  f.options.taskRuns = runs;
  const root = f.items[0];
  const control = coordinatorGoalControl({ rootTaskId: root.itemId, parentTaskId: null,
    event: { source: { provider: 'local-owner' }, eventType: 'owner_request.created' }, childTaskIds: [f.items[1].itemId] });
  const engine = new RoleDecisionEngine({ definition: { id: 'orchestrator', name: 'Coordinator', mission: 'Preserve the owner goal', enabled: true, scheduleMinutes: 5 },
    permissions: { allowedIntents: ['orchestrate'] }, brain: { provider: 'fake', model: 'fake', remoteData: { requirements: false, code: false, memory: false } },
    brainRouter: { describe: () => ({}), async generate() {
      calls++;
      return JSON.stringify({ schemaVersion: 1, confidence: 90, summary: 'Cancel plan',
        intent: { schemaVersion: 1, type: 'orchestrate', summary: 'Cancel plan', action: { schemaVersion: 1, type: 'cancel',
          sourceTaskId: root.itemId, sourceTaskRevision: root.revision, expectedGraphRevision: 1, reason: 'Failed child plan' } } });
    } },
  });
  const dispatch = async () => {
    await assert.rejects(runs.run({ kind: 'work-item', taskId: root.itemId, roleId: 'orchestrator', revision: root.revision,
      title: 'Preserve the owner goal', subject: 'Owner request' },
      () => engine.decide({ item: {}, context: { requirements: { coordination: { goalControl: control } } } })),
    error => error.code === 'STRUCTURED_BRAIN_RESPONSE_INVALID');
  };
  let scheduler = new WorkContinuationScheduler(f.options);
  const run = async () => { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); };
  for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
  assert.equal(calls, 6, 'three wakes, each with only the existing two correction attempts');
  assert.equal(root.status, 'queued');
  assert.equal(f.state().records[0].status, 'stalled');
  assert.equal(f.state().records[0].nextAttemptAt, null);
  assert.equal(f.state().records[0].recovery.action, 'await_condition');
  scheduler = new WorkContinuationScheduler(f.options);
  f.advance(3_600_000); await run();
  assert.equal(calls, 6, 'restart and time cannot renew an unchanged rejected goal');
  f.items[1].revision++; await run();
  assert.equal(calls, 8, 'effective child progress rearms the same goal without a new enqueue');
  assert.equal(root.status, 'queued');
});

test('configuration failures wait for effective changes instead of repeating every five minutes', async t => {
  for (const code of ['ROLE_TASK_BRAIN_NOT_CONFIGURED', 'BRAIN_PROVIDER_NOT_CONFIGURED', 'REMOTE_DATA_NOT_AUTHORIZED'])
    for (const change of ['task', 'related-child', 'configuration', 'runtime']) await t.test(`${code}: ${change}`, async () => {
  const f = relatedProgressFixture(); let calls = 0;
  let runtimeRevision = 'a'.repeat(64);
  f.items[0].currentTarget.id = 'requirements-analyst';
  let scheduler = new WorkContinuationScheduler(f.options);
  const dispatch = async ({ continuationTarget }) => {
    calls++;
    return { skipped: null, continuationOutcome: { ...continuationTarget, status: 'degraded', code } };
  };
  const run = async () => { await scheduler.runCycle({ ...f, dispatch, runtimeRevision }); await f.drain(); };
  for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
  scheduler = new WorkContinuationScheduler(f.options);
  f.advance(3600_000); await run();
  assert.equal(calls, 3);
  assert.equal(f.state().records[0].recovery.action, 'await_condition');
  assert.equal(f.state().records[0].nextAttemptAt, null);
  if (change === 'task') f.items[0].revision++;
  if (change === 'related-child') f.items[1].revision++;
  if (change === 'configuration') f.config.workCoordination = { leaseDurationMs: 180_000 };
  if (change === 'runtime') runtimeRevision = 'b'.repeat(64);
  await run(); assert.equal(calls, 4);
  });
});

test('a root without children also stops repeating completed unchanged model decisions', async () => {
  const f = fixture(); f.items[0].currentTarget.id = 'orchestrator';
  let receipt, calls = 0;
  f.options.taskRuns = { async order(items) { return items; }, async get() { return { active: false, receipt }; } };
  let scheduler = new WorkContinuationScheduler(f.options);
  const dispatch = async () => {
    calls++;
    receipt = { taskId: f.items[0].itemId, roleId: 'orchestrator', taskRevision: f.items[0].revision,
      registeredAt: f.options.clock().toISOString(), modelStartedAt: f.options.clock().toISOString(),
      finishedAt: f.options.clock().toISOString(), phase: 'completed', stopConfirmed: true,
      session: { transport: 'app-server', status: 'completed' } };
  };
  const run = async () => { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); };
  for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
  assert.equal(calls, 3);
  assert.equal(f.state().records[0].recovery.action, 'await_condition');
  scheduler = new WorkContinuationScheduler(f.options);
  f.advance(3600_000); await run();
  assert.equal(calls, 3, 'elapsed time and restart cannot justify another identical model call');
  f.items[0].revision++;
  await run();
  assert.equal(calls, 4, 'a real root revision change resumes the same work');
});

test('completed model decisions without graph progress wait across restart and wake on child changes', async () => {
  const f = relatedProgressFixture(); let calls = 0, receipt;
  f.options.taskRuns = { async order(items) { return items; }, async get() { return { active: false, receipt }; } };
  let scheduler = new WorkContinuationScheduler(f.options);
  const dispatch = async () => {
    calls++;
    receipt = { taskId: f.items[0].itemId, roleId: 'orchestrator', taskRevision: f.items[0].revision,
      registeredAt: f.options.clock().toISOString(), modelStartedAt: f.options.clock().toISOString(),
      finishedAt: f.options.clock().toISOString(), phase: 'completed', stopConfirmed: true,
      session: { transport: 'app-server', status: 'completed' } };
  };
  const run = async () => { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); };
  for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
  scheduler = new WorkContinuationScheduler(f.options);
  f.advance(3600_000); await run();
  assert.equal(calls, 3);
  assert.equal(f.state().records[0].recovery.action, 'await_condition');
  f.items[1].revision++;
  await run(); assert.equal(calls, 4);
});

test('missing or unconfirmed model/graph evidence keeps a continuation recoverable', async t => {
  for (const variant of ['missing-graph-progress', 'active', 'unconfirmed', 'no-model', 'unfinished', 'old-run', 'future-finish']) await t.test(variant, async () => {
    const f = relatedProgressFixture(); let calls = 0, receipt;
    if (variant === 'missing-graph-progress') f.ledger.readItemProgress = async ids =>
      f.items.filter(item => ids.includes(item.itemId)).map(item => structuredClone(item));
    f.items[0].currentTarget.id = 'orchestrator';
    f.options.taskRuns = { async order(items) { return items; }, async get() { return { active: variant === 'active', receipt }; } };
    const scheduler = new WorkContinuationScheduler(f.options);
    const dispatch = async () => {
      calls++;
      const now = f.options.clock().toISOString();
      receipt = { taskId: f.items[0].itemId, roleId: 'orchestrator', taskRevision: f.items[0].revision,
        registeredAt: now, modelStartedAt: now, finishedAt: now, phase: 'completed', stopConfirmed: true,
        session: { transport: 'app-server', status: 'completed' } };
      if (variant === 'unconfirmed') receipt.stopConfirmed = false;
      if (variant === 'no-model') receipt.modelStartedAt = null;
      if (variant === 'unfinished') receipt.finishedAt = null;
      if (variant === 'old-run') receipt.registeredAt = '2020-01-01T00:00:00.000Z';
      if (variant === 'future-finish') receipt.finishedAt = '2099-01-01T00:00:00.000Z';
    };
    for (let i = 0; i < 4; i++) {
      await scheduler.runCycle({ ...f, dispatch }); await f.drain(); f.advance(3600_000);
    }
    assert.equal(calls, 4);
    assert.equal(f.state().records[0].recovery.action, 'retry');
  });
});

test('unchanged preclaim stale facts wait across restart and rearm on effective changes', async t => {
  for (const change of ['task', 'related-child', 'configuration', 'runtime']) await t.test(change, async () => {
    const f = relatedProgressFixture(); let runtimeRevision = 'a'.repeat(64), calls = 0;
    let scheduler = new WorkContinuationScheduler(f.options);
    const dispatch = async ({ continuationTarget }) => {
      calls++;
      return { skipped: null, continuationOutcome: { ...continuationTarget, status: 'decision_deferred', code: 'PR_FACTS_STALE' } };
    };
    const run = async () => { await scheduler.runCycle({ ...f, dispatch, runtimeRevision }); await f.drain(); };
    for (let i = 0; i < 3; i++) { await run(); f.advance(90_000); }
    assert.equal(calls, 3);
    assert.equal(f.state().records[0].recovery.action, 'await_condition');
    assert.equal(f.state().records[0].nextAttemptAt, null);
    assert.equal(f.state().records[0].receipts.at(-1).errorCode, 'PR_FACTS_STALE');
    scheduler = new WorkContinuationScheduler(f.options);
    f.advance(3600_000); await run();
    assert.equal(calls, 3);
    if (change === 'task') f.items[0].revision++;
    if (change === 'related-child') f.items[1].revision++;
    if (change === 'configuration') f.config.workCoordination = { leaseDurationMs: 180_000 };
    if (change === 'runtime') runtimeRevision = 'b'.repeat(64);
    await run(); assert.equal(calls, 4);
  });
});

test('unmatched and transient preclaim observations retain retry without a model receipt', async t => {
  for (const variant of ['other-item', 'old-fingerprint', 'wrong-status', 'timeout', 'capacity', 'extra-field', 'accessor', 'missing']) await t.test(variant, async () => {
    const f = fixture(); let calls = 0, accessorReads = 0;
    f.options.taskRuns = { async order(items) { return items; }, async get() { return null; } };
    const scheduler = new WorkContinuationScheduler(f.options);
    const dispatch = async ({ continuationTarget }) => {
      calls++;
      const outcome = { ...continuationTarget, status: 'decision_deferred', code: 'PR_FACTS_STALE' };
      if (variant === 'other-item') outcome.itemId = 'another-work-item';
      if (variant === 'old-fingerprint') outcome.fingerprint = 'f'.repeat(64);
      if (variant === 'wrong-status') outcome.status = 'waiting_model';
      if (variant === 'timeout') outcome.code = 'ROLE_CONTEXT_TIMEOUT';
      if (variant === 'capacity') outcome.code = 'STRUCTURED_PROVIDER_MODEL_CAPACITY';
      if (variant === 'extra-field') outcome.extra = true;
      if (variant === 'accessor') Object.defineProperty(outcome, 'code', { enumerable: true, get() { accessorReads++; return 'PR_FACTS_STALE'; } });
      return { skipped: null, continuationOutcome: variant === 'missing' ? null : outcome };
    };
    for (let i = 0; i < 4; i++) { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); f.advance(3600_000); }
    assert.equal(calls, 4);
    assert.equal(f.state().records[0].recovery.action, 'retry');
    assert.equal(scheduler.readStatus().lastError, null);
    assert.equal(accessorReads, 0);
  });
});

test('real task-run failure receipts bound repeated automatic model decisions without losing restart recovery', async t => {
  for (const [code, roleId] of [['ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION', 'developer'],
    ['STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED', 'orchestrator']]) await t.test(code, async () => {
  const f = fixture(), values = new Map(); let modelCalls = 0;
  f.items[0].currentTarget.id = roleId;
  const runStore = { async read(key, fallback) { return clone(values.get(key) ?? fallback); },
    async write(key, value) { values.set(key, clone(value)); } };
  const taskRuns = new TaskRunRegistry({ store: runStore, receiptStore: runStore, clock: f.options.clock,
    settleControl: async () => { assert.fail('no owner control is requested'); } });
  f.options.taskRuns = taskRuns;
  let scheduler = new WorkContinuationScheduler(f.options);
  const dispatch = async () => {
    await assert.rejects(taskRuns.run({ kind: 'work-item', taskId: 'work-one', roleId,
      title: 'Resolve a task', subject: 'Test work', revision: f.items[0].revision }, async () => {
      modelCalls++;
      throw Object.assign(new Error('decision cannot complete'), { code });
    }), { code });
  };
  for (let i = 0; i < 3; i++) { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); f.advance(90_000); }
  assert.equal(modelCalls, 3);
  assert.equal(f.state().records[0].recovery.action, 'await_condition');
  scheduler = new WorkContinuationScheduler(f.options);
  f.advance(3600_000); await scheduler.runCycle({ ...f, dispatch }); await f.drain();
  assert.equal(modelCalls, 3);
  f.items[0].revision++;
  await scheduler.runCycle({ ...f, dispatch }); await f.drain();
  assert.equal(modelCalls, 4);
  });
});

test('transient or stale decision failure receipts keep automatic backoff', async t => {
  for (const variant of ['transient', 'old-revision', 'old-run']) await t.test(variant, async () => {
    const f = fixture(); let receipt, calls = 0;
    f.options.taskRuns = { async order(items) { return items; }, async get() { return { active: false, receipt }; } };
    const scheduler = new WorkContinuationScheduler(f.options);
    const dispatch = async () => { calls++; receipt = { roleId: 'developer', taskId: 'work-one', taskRevision: variant === 'old-revision' ? 0 : 1,
      registeredAt: variant === 'old-run' ? '2026-10-20T00:00:00.000Z' : f.options.clock().toISOString(),
      phase: 'failed', outcomeCode: variant === 'transient' ? 'STRUCTURED_PROVIDER_MODEL_CAPACITY' : 'ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION' }; };
    for (let i = 0; i < 4; i++) { await scheduler.runCycle({ ...f, dispatch }); await f.drain(); f.advance(3600_000); }
    assert.equal(calls, 4);
    assert.equal(f.state().records[0].recovery.action, 'retry');
  });
});

test('slow unchanged retries cannot keep a third ready item from its role', async () => {
  const f = fixture();
  f.config.workCoordination = { leaseDurationMs: 20 * 60_000 };
  f.items.push(...['work-two', 'work-three'].map(itemId => ({ ...clone(f.items[0]), itemId })));
  const scheduler = new WorkContinuationScheduler(f.options), starts = [];
  for (let cycle = 0; cycle < 16; cycle++) {
    await scheduler.runCycle({ ...f, dispatch: async ({ continuationTarget }) => {
      starts.push(continuationTarget.itemId);
      f.advance(6 * 60_000);
    } });
    await f.drain(); await new Promise(resolve => setImmediate(resolve)); f.advance(10_000);
  }
  assert.deepEqual(starts.slice(0, 3), ['work-one', 'work-two', 'work-three']);
  assert.ok(f.items.every(item => starts.filter(itemId => itemId === item.itemId).length >= 5));
  assert.ok(f.state().records.every(record => record.receipts.at(-1).outcome === 'no_progress'));
});

test('same-role execution history survives restart and a new input fingerprint', async () => {
  const f = fixture(), starts = [];
  f.config.workCoordination = { leaseDurationMs: 20 * 60_000 };
  f.items.push(...['work-two', 'work-three'].map(itemId => ({ ...clone(f.items[0]), itemId })));
  const input = { ...f, dispatch: async ({ continuationTarget }) => {
    starts.push(continuationTarget.itemId); f.advance(6 * 60_000);
  } };
  await new WorkContinuationScheduler(f.options).runCycle(input); await f.drain();
  const originalReceipt = f.state().records[0].receipts[0];
  f.items[0].revision++;
  for (let cycle = 0; cycle < 2; cycle++) {
    await new WorkContinuationScheduler(f.options).runCycle(input); await f.drain();
  }
  assert.deepEqual(starts, ['work-one', 'work-two', 'work-three']);
  const record = f.state().records.find(record => record.itemId === 'work-one');
  assert.notEqual(record.fingerprint, originalReceipt.fingerprint);
  assert.deepEqual(record.receipts, [originalReceipt], 'a new Head does not erase its previous execution opportunity');
});

test('a receipt from another role does not remove a new role assignment from its FIFO turn', async () => {
  const f = fixture(), scheduler = new WorkContinuationScheduler(f.options), starts = [];
  await scheduler.runCycle({ ...f, dispatch: async () => {} }); await f.drain();
  f.advance(60_000);
  f.items[0].currentTarget.id = 'tester'; f.items[0].revision++;
  f.items.push({ ...clone(f.items[0]), itemId: 'work-test-peer' });
  await scheduler.runCycle({ ...f, dispatch: async ({ roleId, continuationTarget }) => {
    starts.push([roleId, continuationTarget.itemId]);
  } });
  await f.drain();
  assert.deepEqual(starts, [['tester', 'work-one']]);
});

test('manual task priority wins before same-priority execution history rotates', async () => {
  const f = fixture(), values = new Map(), starts = [];
  const taskRuns = new TaskRunRegistry({ clock: f.options.clock, settleControl: async () => {}, store: {
    async read(key, fallback) { return clone(values.get(key) ?? fallback); },
    async write(key, value) { values.set(key, clone(value)); },
  } });
  f.options.taskRuns = taskRuns;
  f.config.workCoordination = { leaseDurationMs: 20 * 60_000 };
  f.items.push(...['high-one', 'high-two'].map(itemId => ({ ...clone(f.items[0]), itemId })));
  for (const item of f.items.slice(1)) {
    await taskRuns.run({ kind: 'work-item', taskId: item.itemId, roleId: 'developer',
      title: item.itemId, subject: 'fairness regression', revision: item.revision }, async () => {
      const view = await taskRuns.get('work-item', item.itemId);
      await taskRuns.control('work-item', item.itemId, { command: 'priority', priority: 'high',
        runId: view.runId, expectedRevision: view.revision });
    });
  }
  const scheduler = new WorkContinuationScheduler(f.options);
  for (let cycle = 0; cycle < 3; cycle++) {
    await scheduler.runCycle({ ...f, dispatch: async ({ continuationTarget }) => {
      starts.push(continuationTarget.itemId); f.advance(6 * 60_000);
    } });
    await f.drain(); await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(starts, ['high-one', 'high-two', 'high-one']);
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').receipts.length, 0);
});

test('a fair same-role peer waits for actual settlement while another role can advance', async () => {
  const f = fixture(), release = deferred(), began = deferred(), starts = [];
  f.config.workCoordination = { leaseDurationMs: 1_000 };
  f.items.push({ ...clone(f.items[0]), itemId: 'work-peer' });
  f.items.push({ ...clone(f.items[0]), itemId: 'work-test', currentTarget: { type: 'role', id: 'tester' } });
  const scheduler = new WorkContinuationScheduler(f.options);
  const input = { ...f, dispatch: async ({ roleId, signal, continuationTarget }) => {
    starts.push(continuationTarget.itemId);
    if (roleId === 'developer') { began.resolve(); await release.promise; signal.throwIfAborted(); }
    else f.items.find(item => item.itemId === continuationTarget.itemId).revision++;
  } };
  await scheduler.runCycle(input); await began.promise;
  f.items[0].revision++; f.advance(1_001);
  await scheduler.runCycle(input); await scheduler.runCycle(input);
  assert.equal(starts.filter(itemId => itemId === 'work-one').length, 1);
  assert.equal(starts.includes('work-peer'), false, 'timeout or a changed Head cannot release the active role');
  assert.ok(starts.includes('work-test'));
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').receipts[0].outcome, 'running');
  release.resolve(); await f.drain(); await new Promise(resolve => setImmediate(resolve));
  await scheduler.runCycle({ ...f, dispatch: async ({ continuationTarget }) => { starts.push(continuationTarget.itemId); } });
  await f.drain();
  assert.equal(starts.filter(itemId => itemId === 'work-one').length, 1);
  assert.ok(starts.includes('work-peer'));
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').receipts[0].outcome, 'timed_out');
});

test('automatic mode, role pause, task pause and graph dependencies retain their boundaries', async () => {
  for (const boundary of ['mode', 'role', 'task', 'graph', 'scope']) {
    const f = fixture();
    if (boundary === 'mode') f.config.githubActions.enabled = false;
    if (boundary === 'role') f.role.paused = true;
    if (boundary === 'task') f.options.taskRuns = { async order() { return []; } };
    if (boundary === 'graph') {
      const list = f.ledger.listClaimCandidates;
      f.ledger.listClaimCandidates = async () => { const page = await list(); page.facts[0].graphBlocked = true; return page; };
    }
    if (boundary === 'scope') f.items[0].source = { scope: { active: false } };
    await new WorkContinuationScheduler(f.options).runCycle(f); await f.drain();
    assert.equal(f.dispatched.length, 0, boundary);
  }
});

test('a host-proven root coordination retry wakes despite its blocked child while role and task holds win', async t => {
  for (const boundary of ['ready', 'unproven', 'specialist', 'role-pause', 'task-hold']) await t.test(boundary, async () => {
    const f = fixture();
    Object.assign(f.items[0], { kind: 'source_root', status: 'retry_wait', statusReason: 'host_context_facts_recovered',
      currentTarget: { type: 'role', id: boundary === 'specialist' ? 'developer' : 'orchestrator' } });
    const list = f.ledger.listClaimCandidates;
    f.ledger.listClaimCandidates = async () => { const page = await list();
      Object.assign(page.facts[0], { graphBlocked: true, submittedChildren: 0, orchestrationReady: boundary !== 'unproven' }); return page; };
    if (boundary === 'role-pause') f.role.paused = true;
    if (boundary === 'task-hold') f.options.taskRuns = { async order() { return []; } };
    await new WorkContinuationScheduler(f.options).runCycle(f); await f.drain();
    assert.deepEqual(f.dispatched, boundary === 'ready' ? ['orchestrator'] : []);
  });
});

test('task pause introduced after persistence is rechecked before dispatch', async () => {
  const f = fixture(); let paused = false;
  f.options.taskRuns = { async order(items) { return paused ? [] : items; } };
  await new WorkContinuationScheduler(f.options).runCycle({ ...f, runOperation: operation => {
    paused = true; return f.runOperation(operation);
  } });
  await f.drain(); assert.equal(f.dispatched.length, 0);
  assert.equal(f.state().records[0].reason, 'runtime_deferred');
  assert.equal(f.state().records[0].attempt, 0);
});

test('role rotation, bounded cursor recovery and failed preparation do not starve ready work', async () => {
  const f = fixture();
  f.items.push(...['tester', 'orchestrator', 'pr-engineer', 'requirements-analyst'].map((id, index) => ({
    itemId: `work-${index}`, revision: 1, status: 'queued', currentTarget: { type: 'role', id },
  })));
  const scheduler = new WorkContinuationScheduler({ ...f.options, preparations: [async () => { throw new Error('one unavailable reconciler'); }] });
  for (let count = 0; count < 3; count += 1) { await scheduler.runCycle(f); await f.drain(); }
  assert.equal(new Set(f.dispatched).size, 5);
  assert.equal(scheduler.readStatus().lastError, 'reconciliation_failed');
  const list = f.ledger.listClaimCandidates; let cursorCalls = 0;
  f.ledger.listClaimCandidates = async options => {
    cursorCalls += 1;
    if (options.cursor) throw Object.assign(new Error('revision changed'), { code: 'WORK_LEDGER_CURSOR_INVALID' });
    return { ...await list(), nextCursor: 'page-two' };
  };
  await scheduler.runCycle(f); await f.drain();
  await scheduler.runCycle(f); await f.drain();
  assert.equal(cursorCalls, 3);
});

test('obsolete and terminal pending intents are retired without dispatch', async () => {
  const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle({ dispatch: f.dispatch, runOperation: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  f.items.splice(0);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'superseded');
  assert.equal(f.dispatched.length, 0);
});

test('blocked ledger work retires stale continuation without dispatch and resumes on a new revision', async () => {
  for (const reason of ['decision_attempts_exhausted', 'pr_source_left_scope', 'pr_source_authority_fenced']) {
    const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options);
    for (let attempt = 0; attempt < 3; attempt++) {
      await scheduler.runCycle({ ...f, dispatch: async () => {} }); await f.drain(); f.advance(90_000);
    }
    const receipts = f.state().records[0].receipts;
    Object.assign(f.items[0], { status: 'blocked', statusReason: reason, revision: 2 });
    const candidates = f.ledger.listClaimCandidates;
    f.ledger.listClaimCandidates = async () => f.items[0].status === 'blocked'
      ? { items: [], facts: [], nextCursor: null } : candidates();
    await scheduler.runCycle(f); await f.drain();
    assert.equal(f.state().records[0].status, 'superseded', reason);
    assert.deepEqual(f.state().records[0].receipts, receipts);
    assert.equal(f.dispatched.length, 0);
    Object.assign(f.items[0], { status: 'queued', statusReason: null, revision: 3 });
    await scheduler.runCycle(f); await f.drain();
    assert.equal(f.state().records[0].status, 'delivered');
    assert.equal(f.dispatched.length, 1);
  }
});

test('retired cross-root PR work leaves the stalled wake backlog and can reenter on a real new revision', async () => {
  const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options);
  const stalled = { ...f, dispatch: async () => {} };
  for (let attempt = 0; attempt < 3; attempt++) {
    await scheduler.runCycle(stalled); await f.drain(); f.advance(90_000);
  }
  assert.equal(scheduler.readStatus().stalledCount, 1);
  const receipts = f.state().records[0].receipts;
  f.items[0].status = 'blocked'; f.items[0].statusReason = 'pr_source_cross_root_cutover_retired';
  f.items[0].revision++;
  const candidates = f.ledger.listClaimCandidates;
  f.ledger.listClaimCandidates = async () => f.items[0].status === 'blocked'
    ? { items: [], facts: [], nextCursor: null } : candidates();
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'superseded');
  assert.equal(scheduler.readStatus().stalledCount, 0);
  assert.equal(scheduler.readStatus().handoffs.length, 0);
  assert.deepEqual(f.state().records[0].receipts, receipts);
  assert.equal(f.dispatched.length, 0);
  f.items[0].status = 'queued'; f.items[0].statusReason = null; f.items[0].revision++;
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
  assert.equal(f.dispatched.length, 1);
});

test('persisted continuation timestamps and unknown schema versions fail validation', () => {
  assert.throws(() => normalizeWorkContinuationState({ schemaVersion: 3, records: [] }));
  assert.throws(() => normalizeWorkContinuationState({ schemaVersion: 1, records: [{
    itemId: 'work-one', roleId: 'developer', fingerprint: 'a'.repeat(64), attempt: 1,
    status: 'running', reason: 'work_ready', updatedAt: 123, nextAttemptAt: null,
  }] }));
});

test('adjacent completion signals share preparations and cleanup reads one bounded batch', async () => {
  const f = fixture(); let prepared = 0; let batches = 0; let durableReads = 0;
  const read = f.ledger.readItemForReconciliation;
  f.ledger.readItemForReconciliation = async args => { durableReads += 1; return read(args); };
  const progress = f.ledger.readItemProgress;
  f.ledger.readItemProgress = async ids => { batches += 1; assert.ok(ids.length <= 20); return progress(ids); };
  const scheduler = new WorkContinuationScheduler({ ...f.options, preparations: [async () => { prepared += 1; }] });
  const input = { ...f, dispatch: async () => {} };
  await scheduler.runCycle(input); await f.drain();
  const before = durableReads;
  await scheduler.runCycle(input); await f.drain();
  assert.equal(prepared, 1); assert.equal(batches, 1); assert.equal(durableReads, before);
  f.advance(5_000); await scheduler.runCycle(input); await f.drain(); assert.equal(prepared, 2);
});

test('handoff records preserve source, condition and execution receipts across the next input', async () => {
  const f = fixture(); f.items[0].graph = { parentItemId: 'work-parent' };
  const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await f.drain();
  let record = f.state().records[0];
  assert.equal(record.source.parentItemId, 'work-parent');
  assert.equal(record.source.itemRevision, 1);
  assert.equal(record.condition.type, 'claimable');
  assert.match(record.condition.reference, /^input:[a-f0-9]{64}$/);
  assert.equal(record.receipts.length, 1);
  assert.equal(record.receipts[0].outcome, 'progressed');
  assert.equal(record.receipts[0].observedRevision, 2);
  assert.ok(record.receipts[0].finishedAt);
  const wakeId = record.receipts[0].wakeId;
  await scheduler.runCycle(f); await f.drain();
  record = f.state().records[0];
  assert.equal(record.receipts.length, 2);
  assert.equal(record.receipts[0].wakeId, wakeId);
  for (let wake = 2; wake < 6; wake += 1) { await scheduler.runCycle(f); await f.drain(); }
  record = f.state().records[0];
  assert.equal(record.receipts.length, 5);
  assert.equal(record.receipts.some(receipt => receipt.wakeId === wakeId), false);
  assert.deepEqual(record.receipts.map(receipt => receipt.observedRevision), [3, 4, 5, 6, 7]);
});

test('waiting external handoffs persist their trigger without executing until the ledger wakes them', async () => {
  const f = fixture(); const item = f.items[0];
  item.status = 'waiting_external'; item.activeIntentId = 'work-intent-one';
  const list = f.ledger.listClaimCandidates;
  f.ledger.listClaimCandidates = async () => item.status === 'queued' ? list() : { items: [], facts: [], nextCursor: null };
  const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.state().records[0].status, 'waiting');
  assert.deepEqual(f.state().records[0].condition, { type: 'intent_result', reference: 'work-intent-one' });
  item.status = 'queued'; item.revision += 1;
  await scheduler.runCycle(f); await f.drain();
  assert.deepEqual(f.dispatched, ['developer']);
});

test('overdue execution requests stop and retains ownership until its actual operation settles', async () => {
  const f = fixture(); const release = deferred(); const began = deferred();
  f.config.workCoordination = { leaseDurationMs: 1_000 };
  const scheduler = new WorkContinuationScheduler(f.options); let calls = 0; let executionSignal;
  const input = { ...f, dispatch: async ({ signal }) => { calls += 1; executionSignal = signal; began.resolve(); await release.promise; signal.throwIfAborted(); } };
  await scheduler.runCycle(input); await began.promise;
  f.advance(1_001); await scheduler.runCycle(input);
  assert.equal(executionSignal.aborted, true);
  assert.equal(f.state().records[0].recovery.action, 'wait_for_stop');
  assert.equal(f.state().records[0].status, 'running');
  assert.equal(scheduler.readStatus().overdueCount, 1);
  await scheduler.runCycle(input); assert.equal(calls, 1);
  release.resolve(); await f.drain();
  const record = f.state().records[0];
  assert.equal(record.receipts[0].outcome, 'timed_out');
  assert.equal(record.receipts[0].errorCode, 'WORK_CONTINUATION_TIMEOUT');
  assert.equal(record.recovery.action, 'retry');
  f.advance(30_001); await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
});

test('timeout recovery is persisted before cancellation and never loses the old receipt after a revision changes', async () => {
  const f = fixture(); const began = deferred(), release = deferred(); let executionSignal;
  f.config.workCoordination = { leaseDurationMs: 1_000 };
  const scheduler = new WorkContinuationScheduler(f.options);
  const input = { ...f, dispatch: async ({ signal }) => { executionSignal = signal; began.resolve(); await release.promise; signal.throwIfAborted(); } };
  await scheduler.runCycle(input); await began.promise;
  f.items[0].revision += 1; await scheduler.runCycle(input);
  f.advance(1_001);
  const write = f.store.write; f.store.write = async () => { throw new Error('storage unavailable'); };
  // No new ledger change may mask a missing durable timeout request.
  await assert.rejects(scheduler.runCycle(input), /storage unavailable/);
  assert.equal(executionSignal.aborted, false);
  f.store.write = write;
  await scheduler.runCycle(input); assert.equal(executionSignal.aborted, true);
  assert.equal(scheduler.readStatus().overdueCount, 1);
  assert.equal(f.state().records[0].receipts[0].errorCode, 'WORK_CONTINUATION_TIMEOUT');
  release.resolve(); await f.drain();
  const record = f.state().records[0];
  assert.equal(record.status, 'pending');
  assert.equal(record.receipts[0].outcome, 'timed_out');
});

test('ready work can displace waiting diagnostics at capacity', async () => {
  const f = fixture();
  f.items[0].status = 'waiting_external';
  f.ledger.listClaimCandidates = async () => ({ items: [], facts: [], nextCursor: null });
  await new WorkContinuationScheduler(f.options).runCycle(f);
  const template = f.state().records[0];
  const scheduler = new WorkContinuationScheduler(f.options);
  const began = deferred(), release = deferred();
  f.items[0].status = 'queued'; f.items[0].revision += 1;
  f.ledger.listClaimCandidates = async () => ({ items: [clone(f.items[0])], facts: [{ itemId: f.items[0].itemId, graphBlocked: false }], nextCursor: null });
  await scheduler.runCycle({ ...f, dispatch: async () => { began.resolve(); await release.promise; } });
  await began.promise;
  const running = f.state().records[0];
  f.items.push(...Array.from({ length: 999 }, (_, index) => ({
    itemId: `waiting-${index}`, revision: 1, status: 'waiting_external', currentTarget: { type: 'role', id: 'developer' },
  })));
  f.seed({ schemaVersion: 2, records: [running, ...f.items.slice(1).map(item => ({ ...clone(template), itemId: item.itemId }))] });
  const ready = { itemId: 'ready-new', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'tester' } };
  f.items.push(ready);
  f.ledger.listItems = async () => ({ items: clone(f.items.slice(1, 101)), nextCursor: null });
  f.ledger.listClaimCandidates = async () => ({ items: [clone(ready)], facts: [{ itemId: ready.itemId, graphBlocked: false }], nextCursor: null });
  try {
    await scheduler.runCycle(f);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.dispatched, ['tester']);
    assert.equal(f.state().records.length, 1000);
    assert.equal(f.state().records.find(record => record.itemId === running.itemId).receipts[0].outcome, 'running');
  } finally { release.resolve(); await f.drain(); }
});

test('legacy wake migration is detached and does not fabricate a past execution', () => {
  const old = { schemaVersion: 1, records: [{ itemId: 'work-one', roleId: 'developer', fingerprint: 'a'.repeat(64),
    status: 'running', attempt: 3, reason: 'work_ready', nextAttemptAt: null, updatedAt: '2026-10-21T00:00:00.000Z' }] };
  const before = clone(old), state = migrateWorkContinuationState(old);
  assert.deepEqual(old, before); assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.records[0].receipts, []); assert.equal(state.records[0].source.itemRevision, null);
  assert.deepEqual(migrateWorkContinuationState(state), state);
});
