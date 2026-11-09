import { digestValue } from "../src/domain/code-executor-contract.js";
import { AutomaticHeadAncestryReader } from "../src/services/automatic-head-ancestry-reader.js";
import { createBrainRecoveryIntent } from "../src/services/brain-recovery-intent.js";
import { currentWorkItemExecutionBinding } from "../src/services/work-ledger-pr-source.js";
import { indexRecordedProposalFailures } from '../src/services/work-ledger-proposal-failure.js';
import { createPrTriageWorkRequest, ownerWorkRequestDigest } from '../src/domain/owner-work-request.js';
import { triageRetirementCandidate, matchRetiredTriageSource, publishedTriageReview, planTriageRetirement, automaticTriageRetirement } from '../src/services/work-ledger-triage-retirement.js';
import { createCiRepairEvidence } from "../src/domain/ci-repair-evidence.js";
import { isDeepStrictEqual } from "node:util";
import { ciMaterialRecoveryCandidate, planCiMaterialRecovery, hasPendingCiMaterialRecovery } from "../src/services/work-ledger-ci-material-recovery.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { automaticRoleHandoffCandidate } from "../src/services/work-ledger-role-handoff.js";
import { indexWorkLedgerGraphProgress, recordedFailureParentIds } from "../src/services/work-ledger-graph-progress.js";
import { indexParentCoordinationReturns } from '../src/services/work-ledger-graph-responsibility.js';
import { currentPrRoleHandoffProof } from '../src/services/work-ledger-role-handoff-evidence.js';
import { OrchestratorService } from '../src/services/orchestrator-service.js';
import { WorkGraphStore } from '../src/services/work-graph-store.js';
import { projectWorkLedgerGraphView } from '../src/services/work-ledger-graph.js';

async function parentCoordinationLedgerFixture({ binding = 'v2', direct = false, returned = true } = {}) {
  const record = binding === 'generic' ? issueAssignment(1) : binding === 'v1' ? prAssignment(1) : ownerRequestedPrAssignment(1);
  record.assignment.target = { type: 'role', id: 'orchestrator' };
  const f = await createFixture({ records: [record] });
  await f.service.intake();
  f.read = async id => (await f.service.listItems({ limit: 100 })).items.find(item => item.itemId === id);
  const root = (await f.service.listItems()).items[0];
  const input = prGraphChildCommand(root, (await f.service.getSummary()).revision, 'retained-contract');
  input.command.acceptanceContract.expectedDeliverables = [{ deliverableId: 'package', kind: 'change-package',
    description: 'Retained specialist package', required: true }];
  const created = await f.service.createGraphChild(input);
  let child = await f.read(created.taskId);
  if (!returned) { f.root = await f.read(root.itemId); f.child = child; return f; }
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: 'employee-developer', leaseDurationMs: 30000 });
  if (direct) {
    await f.service.handoff({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
      actorId: 'employee-developer', target: { type: 'role', id: 'orchestrator' }, reason: 'Coordinate contract' });
  } else {
    await f.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
      actorId: 'employee-developer', roleId: 'developer', intent: handoffIntent({ capability: 'coordination',
        brief: 'Review the retained specialist contract', reason: 'Coordinate contract' }) });
    const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
      policy: createWorkIntentPolicy({ capabilityRoles: { coordination: 'orchestrator' } }),
      attentionProducer: { async create() { assert.fail('No attention request'); } },
      proposalProducer: { async create() { assert.fail('No proposal'); } } });
    assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  }
  f.root = await f.read(root.itemId); f.child = await f.read(child.itemId);
  return f;
}

for (const binding of ['generic', 'v1', 'v2']) for (const direct of [false, true]) {
  test(`parent coordination return preserves ${binding} ${direct ? 'direct ledger' : 'dispatched'} handback after restart`, async () => {
    const f = await parentCoordinationLedgerFixture({ binding, direct });
    const restarted = await createFixture({ source: f.source, store: f.store, time: f.time });
    const before = f.store.stored();
    const page = await restarted.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator', limit: 1 });
    assert.deepEqual(page.items.map(item => item.itemId), [f.root.itemId]);
    assert.equal(page.nextCursor, null); assert.equal(page.facts[0].orchestrationReady, true);
    assert.deepEqual((await restarted.service.listClaimCandidates({ at: f.time.clock(), roleId: 'developer' })).items, []);
    const state = (await restarted.service.getGraphSnapshot()).taskStates.find(entry => entry.taskId === f.child.itemId);
    assert.equal(state.coordinationReturn.rootTaskId, f.root.itemId);
    assert.equal(state.coordinationReturn.handoff?.brief ?? null, direct ? null : 'Review the retained specialist contract');
    const proof = currentPrRoleHandoffProof(before, f.child, { fromRoleId: 'developer', targetRoleId: 'orchestrator', capability: 'coordination' });
    assert.equal(proof !== null, binding === 'v2' && !direct, 'PR authority proof retains its existing schema restriction');
    await assert.rejects(restarted.service.claim({ itemId: f.child.itemId, expectedRevision: f.child.revision,
      workerId: 'employee-orchestrator', leaseDurationMs: 30000 }), { code: 'WORK_LEDGER_GRAPH_BLOCKED' });
    assert.deepEqual(f.store.stored(), before, 'discovery, restart and refused claims preserve all history');
  });
}

test('parent coordination return filters before every role page while normal specialist work remains claimable', async () => {
  const f = await parentCoordinationLedgerFixture();
  for (let index = 0; index < 3; index++) {
    const parent = await f.read(f.root.itemId);
    await f.service.createGraphChild(prGraphChildCommand(parent, (await f.service.getSummary()).revision, `normal-${index}`));
  }
  let cursor = null; const ids = [];
  do {
    const page = await f.service.listClaimCandidates({ at: f.time.clock(), limit: 1, ...(cursor === null ? {} : { cursor }) });
    assert.equal(page.items.length, 1); assert.deepEqual(page.facts.map(row => row.itemId), page.items.map(row => row.itemId));
    ids.push(page.items[0].itemId); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(ids.length, 4); assert(!ids.includes(f.child.itemId));
  const developer = await f.service.listClaimCandidates({ at: f.time.clock(), limit: 1, roleId: 'developer' });
  const claimed = await f.service.claim({ itemId: developer.items[0].itemId, expectedRevision: developer.items[0].revision,
    workerId: 'employee-developer', leaseDurationMs: 30000 });
  assert.equal(claimed.attempt, 1);
});

test('parent coordination return readiness preserves paused, active, unknown, submitted and stale boundaries', async () => {
  const f = await parentCoordinationLedgerFixture(), base = f.store.stored();
  const mutate = (which, update) => { const state = clone(base); update(state.items.find(item => item.itemId === f[which].itemId), state); return state; };
  const cases = [
    mutate('root', item => { item.status = 'paused'; }),
    mutate('child', item => { item.status = 'paused'; }),
    mutate('root', item => { item.status = 'blocked'; }),
    mutate('child', item => { item.status = 'working'; item.ownerId = 'employee-orchestrator'; item.leaseId = 'active'; item.leaseUntil = '2026-08-03T00:00:00.000Z'; }),
    mutate('child', item => { item.status = 'waiting_external'; item.activeIntentId = 'retained-active-effect'; }),
    mutate('child', item => { item.decisionContext = { outcome: 'unknown' }; }),
    mutate('child', item => { item.graph.deliveries.push({ deliverableId: 'package', revision: 1, status: 'submitted' }); }),
    mutate('child', item => { item.assignment.graphTask.sourceBinding.rootItemId = 'wrong-root'; }),
    mutate('child', item => { item.assignment.graphTask.sourceBinding.headRefOid = PR_HEAD_B; }),
    mutate('root', item => { item.source.pendingRevision = item.source.activeRevision + 1; }),
    mutate('child', (_item, state) => { state.outbox.push({ itemId: f.child.itemId, status: 'unknown' }); }),
  ];
  for (const state of cases) assert.equal(indexParentCoordinationReturns(state).size, 0);
  const blocked = mutate('child', item => { item.status = 'blocked'; item.statusReason = 'decision_attempts_exhausted'; });
  assert.equal(indexParentCoordinationReturns(blocked).get(f.child.itemId), f.root.itemId,
    'safe blocked handbacks still need their existing root coordination');
  assert.deepEqual(f.store.stored(), base);
});

test('parent coordination return exposes persisted blocked handback without inventing failure proof', async () => {
  const f = await parentCoordinationLedgerFixture();
  const child = await f.service.transition({ itemId: f.child.itemId, expectedRevision: f.child.revision,
    leaseId: null, actorId: 'employee-orchestrator', toStatus: 'blocked', reason: 'historical_coordination_failure' });
  const before = f.store.stored(), restarted = await createFixture({ store: f.store, source: f.source, time: f.time });
  const facts = await restarted.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(facts.facts[0].orchestrationReady, true);
  const visible = (await restarted.service.getGraphSnapshot()).taskStates.find(state => state.taskId === child.itemId);
  assert.equal(visible.ledgerStatus, 'blocked');
  assert.equal(visible.coordinationReturn.handoff.brief, 'Review the retained specialist contract');
  assert.equal(visible.decisionFailure, undefined);
  assert.equal(child.attempt, f.child.attempt);
  assert.deepEqual(f.store.stored(), before);
});

test('parent coordination return separates ownership from forged or mismatched report content', async () => {
  const f = await parentCoordinationLedgerFixture();
  for (const field of ['brief', 'reason', 'evidence', 'source', 'target', 'timeline', 'missing-outbox']) {
    const state = f.store.stored(), box = state.outbox.find(entry => entry.itemId === f.child.itemId);
    if (field === 'brief') box.intent.brief = 'Forged model report';
    if (field === 'reason') box.intent.reason = 'Forged reason';
    if (field === 'evidence') box.intent.evidence = ['forged:artifact'];
    if (field === 'source') box.sourceBinding.headRefOid = PR_HEAD_B;
    if (field === 'target') box.dispatchBinding.boundIntent.binding.targetRoleId = 'developer';
    if (field === 'timeline') state.timeline = state.timeline.filter(entry => entry.type !== 'handed_off');
    if (field === 'missing-outbox') state.outbox = [];
    const view = projectWorkLedgerGraphView(state);
    const returned = view.taskStates.find(row => row.taskId === f.child.itemId).coordinationReturn;
    assert.equal(returned.rootTaskId, f.root.itemId);
    assert.equal(returned.handoff, null, field);
    assert.equal(indexParentCoordinationReturns(state).get(f.child.itemId), f.root.itemId,
      'report content cannot add or remove structural graph ownership');
  }
});

test('parent coordination return authenticates the actual specialist role after an existing reassignment', async () => {
  const f = await parentCoordinationLedgerFixture({ binding: 'generic', returned: false });
  const moved = await f.service.reassignGraphTask({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: f.root.itemId },
    command: { taskId: f.child.itemId, expectedTaskRevision: f.child.revision,
      expectedGraphRevision: (await f.service.getSummary()).revision, target: { type: 'role', id: 'tester' }, reason: 'Existing scoped reassignment' } });
  const claimed = await f.service.claim({ itemId: moved.itemId, expectedRevision: moved.revision, workerId: 'employee-tester', leaseDurationMs: 30000 });
  await f.service.stageIntent({ itemId: claimed.itemId, expectedRevision: claimed.revision, leaseId: claimed.leaseId,
    actorId: 'employee-tester', roleId: 'tester', intent: handoffIntent({ capability: 'coordination', brief: 'Tester returns the retained contract' }) });
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: createWorkIntentPolicy({ capabilityRoles: { coordination: 'orchestrator' } }),
    attentionProducer: { async create() { assert.fail('No attention'); } }, proposalProducer: { async create() { assert.fail('No proposal'); } } });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  const item = await f.read(moved.itemId);
  assert.equal(item.assignment.target.id, 'developer');
  const returned = (await f.service.getGraphSnapshot()).taskStates.find(row => row.taskId === item.itemId).coordinationReturn;
  assert.equal(returned.handoff.brief, 'Tester returns the retained contract');
});

test('parent coordination return folds actual nested handback under its visible ancestor and preserves scope gates', async () => {
  const f = await parentCoordinationLedgerFixture({ binding: 'generic', returned: false });
  const graph = new WorkGraphStore({ ledger: f.service }), reader = graph.reader();
  const nestedInput = prGraphChildCommand(f.child, (await f.service.getSummary()).revision, 'nested-return');
  nestedInput.authority.scopeRootTaskId = f.root.itemId;
  nestedInput.command.acceptanceContract.expectedDeliverables = [{ deliverableId: 'nested-package', kind: 'change-package', required: true, description: 'Nested retained contract' }];
  const created = await f.service.createGraphChild(nestedInput);
  let nested = await f.read(created.taskId);
  nested = await f.service.claim({ itemId: nested.itemId, expectedRevision: nested.revision,
    workerId: 'employee-developer', leaseDurationMs: 30000 });
  nested = await f.service.handoff({ itemId: nested.itemId, expectedRevision: nested.revision, leaseId: nested.leaseId,
    actorId: 'employee-developer', target: { type: 'role', id: 'orchestrator' }, reason: 'Nested coordination return' });
  const page = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.deepEqual(page.items.map(item => item.itemId), [f.root.itemId]); assert.equal(page.facts[0].orchestrationReady, true);
  const assembler = new RoleContextAssembler({ graphReader: reader });
  const root = await f.read(f.root.itemId), packet = await assembler.assemble({ roleId: 'orchestrator', item: root, trigger: 'employee:orchestrator' });
  const ancestor = packet.context.requirements.coordination.directChildren[0];
  assert.equal(ancestor.taskId, f.child.itemId);
  assert.equal(ancestor.descendantCoordinationReturns.count, 1);
  assert.equal(ancestor.descendantCoordinationReturns.tasks[0].taskId, nested.itemId);
  assert.equal(ancestor.descendantCoordinationReturns.tasks[0].deliverables[0].deliverableId, 'nested-package');
  const host = new OrchestratorService({ contextAssembler: assembler, graphReader: reader,
    scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) { return graph.planner({ principalId: 'employee-orchestrator', scopeRootTaskId }); } },
    graphDelivererFactory: { forClaim() { assert.fail('Root must not acquire child authority'); } } });
  const makeIntent = task => ({ schemaVersion: 1, type: 'orchestrate', summary: 'Resolve nested return', reason: 'Resolve nested return',
    action: { schemaVersion: 1, type: 'cancel', sourceTaskId: task.itemId, sourceTaskRevision: task.revision,
      expectedGraphRevision: packet.binding.graphRevision, reason: 'Resolve nested return' } });
  const before = f.store.stored();
  await assert.rejects(host.execute({ worker: { roleId: 'orchestrator', workerId: 'employee-orchestrator' },
    item: root, contextPacket: packet, intent: makeIntent(nested) }), { code: 'ORCHESTRATOR_AUTHORITY_DENIED' });
  assert.deepEqual(f.store.stored(), before, 'nested metadata never grants direct grandchild authority');
  const state = f.store.stored(), intermediate = state.items.find(item => item.itemId === f.child.itemId);
  intermediate.status = 'working'; intermediate.ownerId = 'employee-developer'; intermediate.leaseId = 'active'; intermediate.leaseUntil = '2026-08-03T00:00:00.000Z';
  assert.equal(indexParentCoordinationReturns(state).size, 0, 'an active historical ancestor cannot be bypassed');
  const planner = graph.planner({ principalId: 'employee-orchestrator', scopeRootTaskId: root.itemId });
  const parent = await f.read(f.child.itemId);
  await planner.pauseTask({ taskId: parent.itemId, expectedTaskRevision: parent.revision,
    expectedGraphRevision: (await reader.getSnapshot()).graph.revision, reason: 'Owner pauses intermediate' });
  const paused = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.notEqual(paused.facts[0].orchestrationReady, true);
  const pausedPacket = await assembler.assemble({ roleId: 'orchestrator', item: await f.read(root.itemId), trigger: 'employee:orchestrator' });
  assert.equal(pausedPacket.context.requirements.coordination.directChildren[0].descendantCoordinationReturns, undefined);
  const suspended = await f.read(parent.itemId);
  await planner.resumeTask({ taskId: suspended.itemId, expectedTaskRevision: suspended.revision,
    expectedGraphRevision: (await reader.getSnapshot()).graph.revision, reason: 'Owner resumes intermediate' });
  const freshRoot = await f.read(root.itemId), freshPacket = await assembler.assemble({ roleId: 'orchestrator', item: freshRoot, trigger: 'employee:orchestrator' });
  const visibleParent = await f.read(parent.itemId), intent = makeIntent(visibleParent);
  intent.action.expectedGraphRevision = freshPacket.binding.graphRevision;
  await host.execute({ worker: { roleId: 'orchestrator', workerId: 'employee-orchestrator' },
    item: freshRoot, contextPacket: freshPacket, intent });
  assert.equal((await f.read(nested.itemId)).status, 'cancelled');
  assert.equal((await f.read(nested.itemId)).attempt, nested.attempt);
});

test('parent coordination return bounds nested contracts and shares one authenticated report payload', async () => {
  const f = await parentCoordinationLedgerFixture({ binding: 'generic', returned: false });
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: createWorkIntentPolicy({ capabilityRoles: { coordination: 'orchestrator' } }),
    attentionProducer: { async create() { assert.fail('No attention'); } }, proposalProducer: { async create() { assert.fail('No proposal'); } } });
  for (let index = 0; index < 6; index++) {
    const parent = await f.read(f.child.itemId), input = prGraphChildCommand(parent, (await f.service.getSummary()).revision, `nested-${index}`);
    input.authority.scopeRootTaskId = f.root.itemId;
    input.command.acceptanceContract.expectedDeliverables = [{ deliverableId: 'retained-package', kind: 'change-package', required: true, description: 'Retained contract' }];
    const created = await f.service.createGraphChild(input);
    let child = await f.read(created.taskId);
    child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: 'employee-developer', leaseDurationMs: 30000 });
    await f.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
      actorId: 'employee-developer', roleId: 'developer', intent: handoffIntent({ capability: 'coordination',
        brief: '界'.repeat(1000), reason: 'r'.repeat(1500), evidence: Array.from({ length: 20 }, (_, n) => `${n}:` + 'e'.repeat(1000)) }) });
    assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  }
  const assembler = new RoleContextAssembler({ graphReader: { getSnapshot: () => f.service.getGraphSnapshot() } });
  const packet = await assembler.assemble({ roleId: 'orchestrator', item: await f.read(f.root.itemId), trigger: 'employee:orchestrator' });
  const coordination = packet.context.requirements.coordination;
  const nested = coordination.directChildren[0].descendantCoordinationReturns;
  assert.equal(nested.count, 6); assert.equal(nested.tasks.length, 4); assert.equal(nested.hasMore, true);
  const reports = nested.tasks.flatMap(task => task.coordinationReturn.handoff ? [task.coordinationReturn.handoff] : []);
  assert.equal(reports.length, 1);
  assert(reports[0].briefTruncated); assert(reports[0].reasonTruncated); assert(reports[0].hasMoreEvidence);
  assert(Buffer.byteLength(reports[0].brief, 'utf8') <= 512);
  assert.equal(reports[0].evidence.length, 8);
  assert(reports[0].evidence.every(entry => Buffer.byteLength(entry, 'utf8') <= 512));
  assert.deepEqual(coordination.returnReportWindow, { pendingCount: 6, shownCount: 1, hasMore: true });
  assert(Buffer.byteLength(JSON.stringify(packet), 'utf8') <= 128 * 1024);
});

test('parent coordination return rearms an already stalled root on a second nested handback', async () => {
  const f = await parentCoordinationLedgerFixture({ binding: 'generic', returned: false }), nested = [];
  for (let index = 0; index < 2; index++) {
    const parent = await f.read(f.child.itemId);
    const input = prGraphChildCommand(parent, (await f.service.getSummary()).revision, `nested-wake-${index}`);
    input.authority.scopeRootTaskId = f.root.itemId;
    nested.push((await f.service.createGraphChild(input)).taskId);
  }
  const handback = async id => {
    const item = await f.read(id), claim = await f.service.claim({ itemId: id, expectedRevision: item.revision,
      workerId: 'employee-developer', leaseDurationMs: 30000 });
    await f.service.handoff({ itemId: id, expectedRevision: claim.revision, leaseId: claim.leaseId,
      actorId: 'employee-developer', target: { type: 'role', id: 'orchestrator' }, reason: 'Actual nested return' });
  };
  await handback(nested[0]);
  let persisted, calls = 0;
  const options = { ledger: f.service, clock: f.time.clock,
    store: { async read(_key, fallback) { return structuredClone(persisted ?? fallback); },
      async write(_key, value) { persisted = structuredClone(value); } },
    configurationReader: { async readActive() { return { configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }; } },
    roleStateReader: { async read(id) { return { enabled: id === 'orchestrator', paused: false }; } } };
  let scheduler = new WorkContinuationScheduler(options);
  const run = async () => {
    const operations = [];
    const result = await scheduler.runCycle({ dispatch: async target => {
      assert.equal(target.continuationTarget.itemId, f.root.itemId); calls++;
      return { continuationOutcome: { ...target.continuationTarget, status: 'decision_deferred', code: 'PR_FACTS_STALE' } };
    }, runOperation(operation) { const pending = operation(); operations.push(pending); return pending; } });
    await Promise.all(operations); return result;
  };
  for (let index = 0; index < 3; index++) { await run(); f.time.advance(90000); }
  assert.equal(calls, 3);
  const record = persisted.records.find(row => row.itemId === f.root.itemId);
  assert.equal(record.recovery.action, 'await_condition');
  const previousCondition = record.condition.reference, fingerprint = record.fingerprint;
  scheduler = new WorkContinuationScheduler(options);
  await run(); assert.equal(calls, 3, 'restart alone preserves the stalled observation');
  f.source.records.push(issueAssignment(2, { issueNumber: 43 })); f.source.highWatermark = 2;
  await f.service.intake(); await run();
  assert.equal(calls, 3, 'unrelated intake cannot rearm the root');
  const before = (await f.service.readItemProgress([f.root.itemId]))[0].graphProgressDigest;
  const rootRevision = (await f.read(f.root.itemId)).revision, ancestorRevision = (await f.read(f.child.itemId)).revision;
  await handback(nested[1]);
  assert.equal((await f.read(f.root.itemId)).revision, rootRevision);
  assert.equal((await f.read(f.child.itemId)).revision, ancestorRevision);
  const page = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(page.facts[0].orchestrationReady, true);
  assert(!page.items.some(item => nested.includes(item.itemId)));
  assert.equal((await run()).started, 1);
  assert.equal(calls, 4, 'the second actual nested handback rearms its existing root');
  assert.notEqual((await f.service.readItemProgress([f.root.itemId]))[0].graphProgressDigest, before);
  const nextRecord = persisted.records.find(row => row.itemId === f.root.itemId);
  assert.equal(nextRecord.fingerprint, fingerprint, 'scheduling progress does not change execution input identity');
  assert.notEqual(nextRecord.condition.reference, previousCondition);
  await run(); assert.equal(calls, 4, 'unchanged nested returns retain ordinary backoff');
});
import { indexRecordedDecisionFailures, decisionFailureParentIds } from '../src/services/work-ledger-decision-failure.js';
import { unstartedDeliveryContractFailure, unstartedCodePolicyBindingFailure, indexUnstartedCodeDispatchFailures } from "../src/services/work-ledger-delivery-failure.js";
import { hostContextRecoveryCandidate, planHostContextRecovery, hasPendingHostContextRecovery } from "../src/services/work-ledger-host-context-recovery.js";
import { WorkContinuationScheduler } from "../src/services/work-continuation-scheduler.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBackupManifest } from "../src/domain/backup-manifest.js";
import { createProductionRestoreMigrationRegistry } from "../src/services/production-restore-migration-registry.js";
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { createTaskRunSettler } from '../src/services/work-ledger-run-control.js';
import { WorkConditionWaker } from '../src/services/work-condition-waker.js';
import { WorkflowFactSource } from '../src/services/workflow-fact-source.js';
import { WorkCoordinationService } from '../src/services/work-coordination-service.js';
import { ProactiveWorkLoop } from '../src/services/proactive-work-loop.js';
import { prepareWorkLedgerCandidate } from '../src/services/work-ledger-candidate-validation.js';
import { RoleContextAssembler } from '../src/services/role-context-assembler.js';
import { createPullRequestReadIdentity } from '../src/domain/pull-request-read-facts.js';
import { createOriginalRepairFeedbackSnapshot } from '../src/domain/original-repair-feedback.js';
import { ownReviewFeedbackDigest } from '../src/adapters/github-own-review-feedback.js';
import { internalRepairReviewRequestId } from '../src/domain/internal-repair-review.js';
import { OriginalRepairFeedbackReader } from '../src/services/original-repair-feedback-reader.js';

async function exhaustedInternalReviewFactsFixture({ attempts = 3 } = {}) {
  const feedback = { changeRequests: [{ id: 'review-1', author: 'reviewer', body: 'Preserve both eyes after a failed load' }], threads: [] };
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: 'acme/repo', number: 42,
    context: { schemaVersion: 1, headRefOid: PR_HEAD_A, reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
    provenance: { kind: 'captured_before_repair', observedHeadRefOid: PR_HEAD_A, observedAt: '2026-08-02T01:00:00.000Z' } });
  const metadata = { kind: 'own_pr_repair', headRefOid: PR_HEAD_B, feedbackDigest: snapshot.feedbackDigest,
    publicationConfirmationId: 'owner-publication-1', controlledCommitEvidenceId: 'controlled-commit-1' };
  const request = { schemaVersion: 7, requestId: internalRepairReviewRequestId({ repository: 'acme/repo', number: 42, ...metadata }),
    workType: 'pull_request', priority: 'high', title: 'Review the existing repair', description: 'Assess every original request against the current Head',
    acceptanceCriteria: ['Read every original request'], pullRequest: { repository: 'acme/repo', number: 42 }, internalReview: metadata };
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.internal_review_requested',
    occurredAt: '2026-08-02T01:01:00.000Z', source: { provider: 'internal-review-repair', scopeId: `internal-review:${request.requestId}` },
    subject: { id: 'github:pr:acme/repo#42', repository: 'acme/repo', number: 42 },
    payload: { title: request.title, workType: 'pull_request', state: 'open', headRefOid: PR_HEAD_B,
      ...prGitFacts(PR_HEAD_B), internalReview: metadata } });
  const record = { sequence: 1, event, assignment: { assignmentId: 'workflow-assignment-internal-review', eventId: event.eventId,
    target: { type: 'role', id: 'pr-engineer' }, reason: 'internal-review', createdAt: event.occurredAt } };
  const fixture = await createFixture({ records: [record] });
  for (let turn = 0; turn < attempts; turn += 1) {
    await decisionBudgetLoop(fixture, { maxAttempts: attempts, assemble: unavailablePrContext, decide: async () => assert.fail('Facts must precede model work') }).runCycle();
    fixture.time.advance(8_000);
  }
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.statusReason, 'decision_attempts_exhausted');
  const feedbackState = { schemaVersion: 1, feedbackSnapshots: [snapshot], repairs: [], published: [{
    repository: 'acme/repo', number: 42, feedbackDigest: snapshot.feedbackDigest, commitOid: PR_HEAD_B,
    confirmationId: metadata.publicationConfirmationId, feedbackSnapshotId: snapshot.snapshotId,
    reviewDelivery: { status: 'completed', request, workItemId: item.itemId, roleId: 'pr-engineer' },
  }] };
  return { ...fixture, snapshot, metadata, feedbackState };
}

function internalReviewContextAssembler(fixture, { missingFeedback = false, staleFacts = false } = {}) {
  const facts = new WorkflowFactSource({ store: { async read() { return {}; } }, clock: fixture.time.clock,
    pullRequestFacts: { async context(input) {
      const identity = createPullRequestReadIdentity(input);
      return { schemaVersion: 1, identityDigest: identity.identityDigest, contentDigest: 'a'.repeat(64), observedAt: fixture.time.clock(),
        summary: {}, comments: [], reviews: [], reviewThreads: [], checks: [], contextTruncated: false,
        reviewMaterial: { schemaVersion: 1, gitTarget: { ...input.executionBinding.gitTarget, ...(staleFacts ? { headRefOid: PR_HEAD_A } : {}) },
          additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false, patch: '', patchTruncated: false } };
    } } });
  return new RoleContextAssembler({ graphReader: { getSnapshot: () => fixture.service.getGraphSnapshot() },
    pullRequestContextReader: facts.pullRequestTaskContextReader(),
    originalRepairFeedbackReader: new OriginalRepairFeedbackReader({ executionContextReader: fixture.service,
      store: { async read() { return missingFeedback ? { schemaVersion: 1, repairs: [], published: [] } : clone(fixture.feedbackState); } } }),
  });
}

test('internal review fact recovery assembles exact live context and the complete original feedback before one normal claim', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture();
  const before = (await fixture.service.listItems()).items[0];
  fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
  const assembler = internalReviewContextAssembler(fixture);
  let modelCalls = 0;
  const cycle = await decisionBudgetLoop(fixture, { assemble: (input) => assembler.assemble(input), decide: async ({ context }) => {
    modelCalls += 1;
    assert.equal(context.code.originalRepairFeedback.snapshotId, fixture.snapshot.snapshotId);
    assert.equal(context.code.pullRequest.reviewMaterial.gitTarget.headRefOid, PR_HEAD_B);
    return { schemaVersion: 1, confidence: 90, summary: 'Internal review complete', intent: {
      schemaVersion: 1, type: 'complete', summary: 'Reviewed existing repair', reason: 'All original requests assessed', outcome: 'done', evidence: [] } };
  } }).runCycle();
  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.staged, 1);
  assert.equal(modelCalls, 1);
  const after = (await fixture.service.listItems()).items[0];
  assert.equal(after.attempt, before.attempt + 1);
  assert.deepEqual(after.source.decisionBudget, before.source.decisionBudget);
  const recovery = (await fixture.service.listTimeline({ itemId: before.itemId, limit: 100 })).items.filter(entry =>
    entry.type === 'transitioned' && entry.details.reason === 'internal_review_facts_recovered');
  assert.equal(recovery.length, 1);
});

for (const existing of [false, true]) {
test(`same-Head discovery refresh preserves an uncompleted internal repair review (${existing ? 'existing' : 'new'} discovery root)`, async () => {
  const seed = await exhaustedInternalReviewFactsFixture({ attempts: 1 });
  const internalRecord = { ...clone(seed.source.records[0]), sequence: existing ? 2 : 1 };
  const fixture = await createFixture({ records: existing
    ? [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) }), internalRecord] : [internalRecord] });
  fixture.feedbackState = seed.feedbackState;
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items.find(item => item.source?.scope.kind === 'internal_review');
  fixture.source.records.push(prAssignment(existing ? 3 : 2, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    occurredAt: '2026-08-02T01:02:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = existing ? 3 : 2;
  await fixture.service.intake();
  const secondarySequence = existing ? 4 : 3;
  fixture.source.records.push(prAssignment(secondarySequence, { headRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:03:00.000Z', sourceScopeId: 'secondary-view', gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = secondarySequence;
  await fixture.service.intake();
  const exit = prAssignment(secondarySequence + 1, { eventType: 'pull_request.left_scope', headRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:04:00.000Z', sourceScopeId: 'secondary-view', gitFacts: prGitFacts(PR_HEAD_B) });
  fixture.source.records.push(prScopeLifecycleAssignment(secondarySequence + 1, exit.event));
  fixture.source.highWatermark = secondarySequence + 1;
  await fixture.service.intake();
  const retained = await fixture.service.readItemForReconciliation({ itemId: before.itemId });
  assert.equal(retained.status, 'queued', 'metadata refresh cannot retire the pending review of this exact Head');
  await fixture.service.readPullRequestExecutionContext(prExecutionBinding(retained));
  const assembler = internalReviewContextAssembler(fixture);
  let reviewed = 0;
  const cycle = await decisionBudgetLoop(fixture, { assemble: input => assembler.assemble(input), decide: async ({ context }) => {
    reviewed += 1;
    assert.equal(context.code.originalRepairFeedback.snapshotId, seed.snapshot.snapshotId);
    return { schemaVersion: 1, confidence: 90, summary: 'Review repaired Head', intent: {
      schemaVersion: 1, type: 'complete', summary: 'Review complete', reason: 'Assessed original feedback', outcome: 'done', evidence: [] } };
  } }).runCycle();
  assert.equal(cycle.staged, 1);
  assert.equal(reviewed, 1);
  const outbox = (await fixture.service.listOutbox()).items.find(entry => entry.itemId === before.itemId);
  const staged = await fixture.service.readItemForReconciliation({ itemId: before.itemId });
  const dispatch = await fixture.service.claimIntent({ intentId: outbox.intentId, expectedRevision: outbox.revision,
    dispatcherId: 'review-dispatcher', leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: staged.revision,
    outcome: 'delivered', nextStatus: 'completed', actorId: 'review-dispatcher', details: {} });
  const discovery = (await fixture.service.listItems()).items.find(item => item.source?.scope.kind === 'automatic');
  await fixture.service.readPullRequestExecutionContext(prExecutionBinding(discovery));
});
}

for (const change of ['Head', 'Base', 'account', 'closed']) {
test(`internal review priority does not retain obsolete ${change} authority`, async () => {
  const seed = await exhaustedInternalReviewFactsFixture({ attempts: 1 });
  const fixture = await createFixture({ records: clone(seed.source.records) });
  await fixture.service.intake();
  const internal = (await fixture.service.listItems()).items[0];
  const head = change === 'Head' ? PR_HEAD_C : PR_HEAD_B;
  fixture.source.records.push(prAssignment(2, { headRefOid: head, previousHeadRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:02:00.000Z', gitFacts: { ...prGitFacts(head,
      change === 'Base' ? { baseRefOid: '9'.repeat(40) } : change === 'account' ? { sourceAccountId: 'another-account' } : {}),
      ...(change === 'closed' ? { state: 'closed' } : {}) } }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  await assert.rejects(fixture.service.readPullRequestExecutionContext(prExecutionBinding(internal)),
    { code: 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE' });
});
}

async function legacySameHeadInternalReviewTakeoverFixture({ existing = true } = {}) {
  const seed = await exhaustedInternalReviewFactsFixture({ attempts: 1 });
  const internalRecord = { ...clone(seed.source.records[0]), sequence: existing ? 2 : 1 };
  const fixture = await createFixture({ records: existing
    ? [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) }), internalRecord] : [internalRecord] });
  await fixture.service.intake();
  const internal = (await fixture.service.listItems()).items.find(item => item.source?.scope.kind === 'internal_review');
  await decisionBudgetLoop(fixture, { assemble: async () => {
    throw Object.assign(new Error('context timed out before model execution'), { code: 'ROLE_CONTEXT_TIMEOUT' });
  } }).runCycle();
  fixture.time.advance(1_000);
  fixture.source.records.push(prAssignment(existing ? 3 : 2, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    occurredAt: '2026-08-02T01:02:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = existing ? 3 : 2;
  await fixture.service.intake();
  // Persist the exact legacy retirement shape: it erased the runnable status
  // without adding a root timeline event or changing its sealed source.
  const previous = fixture.store.stored();
  const state = clone(previous);
  const review = state.items.find(item => item.itemId === internal.itemId);
  const discovery = state.items.find(item => item.source?.scope.kind === 'automatic');
  Object.assign(review, { status: 'blocked', statusReason: 'pr_source_cross_root_cutover_retired',
    revision: review.revision + 1, availableAt: null, updatedAt: discovery.updatedAt });
  state.revision += 1;
  fixture.store.replaceStored(appendWorkGraphMemoryEvents(previous, state, normalizeWorkLedgerLimits()));
  return { ...fixture, internalId: internal.itemId, discoveryId: discovery.itemId };
}

for (const existing of [false, true]) {
test(`normal recovery restores an internal review retired by same-Head metadata after context-only retries once (${existing ? 'existing' : 'new'} discovery root)`, async () => {
  const fixture = await legacySameHeadInternalReviewTakeoverFixture({ existing });
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const restored = await restarted.service.readItemForReconciliation({ itemId: fixture.internalId });
  assert.equal(restored.status, 'queued');
  await restarted.service.readPullRequestExecutionContext(prExecutionBinding(restored));
  const again = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(await again.service.readItemForReconciliation({ itemId: fixture.internalId }), restored);
  assert.equal((await again.service.listTimeline({ itemId: fixture.internalId, limit: 100 })).items.filter(entry =>
    entry.details.reason === 'pr_source_internal_review_takeover_recovered').length, 1);
});
}

test('schema 12 migrates the sealed automatic authority baseline to pending internal review without rewriting history', async () => {
  const fixture = await legacySameHeadInternalReviewTakeoverFixture();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 12;
  Object.assign(legacy.items.find(item => item.itemId === fixture.internalId), { status: 'queued', statusReason: null });
  const before = clone(legacy);
  const migrated = normalizeWorkLedgerPersistedState(legacy);
  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  for (const key of ['items', 'timeline', 'outbox']) assert.deepEqual(migrated[key], before[key]);
  assert.deepEqual(legacy, before);
  assert.deepEqual(migrated.graphMemoryProjection.pending.slice(0, before.graphMemoryProjection.pending.length), before.graphMemoryProjection.pending);
  assert.ok(migrated.graphMemoryProjection.pending.length > before.graphMemoryProjection.pending.length);
  assert.deepEqual(normalizeWorkLedgerPersistedState(migrated), migrated);
  const internal = migrated.items.find(item => item.itemId === fixture.internalId);
  assert.equal(pullRequestHeadAdmission(migrated, internal).current, true);
  for (const corruption of ['hash', 'current-schema']) {
    const invalid = clone(before);
    if (corruption === 'hash') invalid.graphMemoryProjection.pending.at(-1).eventDigest = 'f'.repeat(64);
    else invalid.schemaVersion = WORK_LEDGER_STATE_SCHEMA_VERSION;
    assert.throws(() => normalizeWorkLedgerPersistedState(invalid), { code: 'WORK_LEDGER_STATE_CORRUPTED' });
  }
});

for (const scenario of ['paused', 'expired-history', 'missing-activation', 'model-work', 'unknown-effect', 'replacement-working', 'changed-Base']) {
test(`same-Head internal review recovery preserves ${scenario}`, async () => {
  const fixture = await legacySameHeadInternalReviewTakeoverFixture();
  const state = fixture.store.stored();
  const root = state.items.find(item => item.itemId === fixture.internalId);
  const replacement = state.items.find(item => item.itemId === fixture.discoveryId);
  if (scenario === 'paused') root.status = 'paused';
  if (scenario === 'expired-history') state.timeline = state.timeline.filter(entry => entry.itemId !== root.itemId || entry.type !== 'pr_source_created');
  if (scenario === 'missing-activation') state.timeline = state.timeline.filter(entry => entry.itemId !== replacement.itemId || entry.at !== root.updatedAt);
  if (scenario === 'model-work') state.timeline.findLast(entry => entry.itemId === root.itemId).details.code = 'ROLE_DECISION_INVALID';
  if (scenario === 'unknown-effect') state.outbox.push({ itemId: root.itemId, status: 'dispatching' });
  if (scenario === 'replacement-working') replacement.status = 'working';
  if (scenario === 'changed-Base') replacement.source.current.event.payload.gitTarget.baseRefOid = '9'.repeat(40);
  const { sameHeadInternalReviewTakeoverRecoveryProof } = await import('../src/services/work-ledger-pr-retirement-recovery.js');
  const before = clone(state);
  assert.equal(sameHeadInternalReviewTakeoverRecoveryProof(state, root), null);
  assert.deepEqual(state, before);
});
}

test('internal review fact recovery cannot repeat after a real model failure and restart', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture();
  const assembler = internalReviewContextAssembler(fixture);
  let modelCalls = 0;
  const options = { assemble: (input) => assembler.assemble(input), decide: async () => { modelCalls += 1; throw new Error('Model failed after valid context'); } };
  assert.equal((await decisionBudgetLoop(fixture, options).runCycle()).blocked, 1);
  const blocked = (await fixture.service.listItems()).items[0];
  assert.equal(blocked.attempt, 4);
  fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
  assert.equal((await decisionBudgetLoop(fixture, options).runCycle()).claimed, 0);
  assert.deepEqual((await fixture.service.listItems()).items[0], blocked);
  assert.equal(modelCalls, 1);
});

test('internal review fact recovery preserves a competing revision committed while context assembly awaits', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture();
  const assembler = internalReviewContextAssembler(fixture);
  const entered = deferred(), finish = deferred();
  const cycle = decisionBudgetLoop(fixture, { assemble: async input => {
    const packet = await assembler.assemble(input);
    entered.resolve();
    await finish.promise;
    return packet;
  }, decide: async () => assert.fail('A competing block must not be claimed') }).runCycle();
  await entered.promise;
  const before = (await fixture.service.listItems()).items[0];
  const queued = await fixture.service.transition({ itemId: before.itemId, expectedRevision: before.revision,
    leaseId: null, actorId: 'owner-task-control', toStatus: 'queued', reason: 'owner-reconsidered-work' });
  const competing = await fixture.service.transition({ itemId: queued.itemId, expectedRevision: queued.revision,
    leaseId: null, actorId: 'owner-task-control', toStatus: 'blocked', reason: 'owner-kept-work-blocked' });
  const writes = fixture.store.writes.length;
  finish.resolve();
  assert.equal((await cycle).claimed, 0);
  assert.deepEqual((await fixture.service.listItems()).items[0], competing);
  assert.equal(fixture.store.writes.length, writes);
  assert.equal((await fixture.service.listTimeline({ itemId: before.itemId, limit: 100 })).items.some(entry =>
    entry.details.reason === 'internal_review_facts_recovered'), false);
});

test('internal review fact recovery does not queue after the second execution authority check fails', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture();
  const before = (await fixture.service.listItems()).items[0];
  const verify = fixture.service.verifyPullRequestExecutionBinding.bind(fixture.service);
  let checks = 0;
  fixture.service.verifyPullRequestExecutionBinding = async input => {
    checks += 1;
    if (checks === 2) throw Object.assign(new Error('Authority changed during context read'), { code: 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE' });
    return verify(input);
  };
  const assembler = internalReviewContextAssembler(fixture);
  const writes = fixture.store.writes.length;
  const cycle = await decisionBudgetLoop(fixture, { assemble: input => assembler.assemble(input), decide: async () => assert.fail('Authority is no longer current') }).runCycle();
  assert.equal(checks, 2);
  assert.equal(cycle.claimed, 0);
  assert.deepEqual((await fixture.service.listItems()).items[0], before);
  assert.equal(fixture.store.writes.length, writes);
});

test('internal review fact recovery reads a valid multi-page history and recovers exactly once', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture({ attempts: 51 });
  const timeline = fixture.service.listTimeline.bind(fixture.service);
  const pages = [];
  fixture.service.listTimeline = async input => {
    const result = await timeline(input);
    pages.push({ cursor: input.cursor ?? null, size: result.items.length, nextCursor: result.nextCursor });
    return result;
  };
  const assembler = internalReviewContextAssembler(fixture);
  const options = { assemble: input => assembler.assemble(input), decide: async () => { throw new Error('Real model failure after recovered context'); } };
  assert.equal((await decisionBudgetLoop(fixture, options).runCycle()).blocked, 1);
  assert.deepEqual(pages.map(page => page.size), [100, 3]);
  assert.equal(pages[1].cursor, pages[0].nextCursor);
  assert.equal(pages[1].nextCursor, null);
  const blocked = (await fixture.service.listItems()).items[0];
  assert.equal(blocked.attempt, 52);
  assert.equal((await decisionBudgetLoop(fixture, options).runCycle()).claimed, 0);
  assert.deepEqual((await fixture.service.listItems()).items[0], blocked);
  assert.equal((await timeline({ itemId: blocked.itemId, limit: 100, order: 'newest' })).items.filter(entry =>
    entry.details.reason === 'internal_review_facts_recovered').length, 1);
});

for (const failure of ['later-page failure', 'repeated cursor']) {
  test(`internal review fact recovery preserves blocked state on ${failure}`, async () => {
    const fixture = await exhaustedInternalReviewFactsFixture();
    const before = (await fixture.service.listItems()).items[0];
    const timeline = fixture.service.listTimeline.bind(fixture.service);
    let reads = 0;
    fixture.service.listTimeline = async input => {
      reads += 1;
      if (reads === 2 && failure === 'later-page failure') throw new Error('Timeline page unavailable');
      const result = await timeline({ ...input, limit: 2 });
      if (reads === 2) result.nextCursor = input.cursor;
      return result;
    };
    const writes = fixture.store.writes.length;
    const cycle = await decisionBudgetLoop(fixture, { assemble: async () => assert.fail('Incomplete history must fail before context read'),
      decide: async () => assert.fail('Incomplete history must not reach the model') }).runCycle();
    assert.equal(reads, 2);
    assert.equal(cycle.claimed, 0);
    assert.deepEqual((await fixture.service.listItems()).items[0], before);
    assert.equal(fixture.store.writes.length, writes);
  });
}

test('internal review fact recovery stops paging once history exceeds every possible valid event count', async () => {
  const fixture = await exhaustedInternalReviewFactsFixture();
  let item = (await fixture.service.listItems()).items[0];
  for (let turn = 0; turn < 10; turn += 1) {
    item = await fixture.service.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
      actorId: 'owner-task-control', toStatus: 'queued', reason: 'owner-reconsidered-work' });
    item = await fixture.service.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
      actorId: 'owner-task-control', toStatus: 'blocked', reason: 'decision_attempts_exhausted', details: { code: 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE' } });
  }
  const timeline = fixture.service.listTimeline.bind(fixture.service);
  let reads = 0;
  fixture.service.listTimeline = async input => { reads += 1; return timeline({ ...input, limit: 2 }); };
  const writes = fixture.store.writes.length;
  const cycle = await decisionBudgetLoop(fixture, { assemble: async () => assert.fail('Extra history cannot qualify'), decide: async () => assert.fail('Must stay blocked') }).runCycle();
  assert.equal(reads, 4, 'stop only after eight entries exceed the seven possible valid entries');
  assert.equal(cycle.claimed, 0);
  assert.deepEqual((await fixture.service.listItems()).items[0], item);
  assert.equal(fixture.store.writes.length, writes);
});

for (const variant of ['missingFeedback', 'staleFacts', 'missingHistory', 'unknownFailure', 'paused', 'existingAction']) {
  test(`internal review fact recovery preserves ${variant} blocks without claiming or writing`, async () => {
    const fixture = await exhaustedInternalReviewFactsFixture();
    const state = fixture.store.stored();
    if (variant === 'missingHistory') {
      const creation = state.timeline.find(entry => entry.type === 'pr_source_created');
      state.timeline = state.timeline.filter(entry => entry.sequence > creation.sequence);
      state.timelineStartSequence = state.timeline[0].sequence;
    }
    if (variant === 'unknownFailure') {
      const entry = state.timeline.find(entry => entry.type === 'retry_scheduled');
      entry.details.code = 'ROLE_DECISION_FAILED';
      const { timelineId: _id, contentDigest: _digest, ...content } = entry;
      entry.contentDigest = ledgerDigest(content); entry.timelineId = `work-timeline-${entry.contentDigest}`;
    }
    if (variant === 'paused') { state.items[0].status = 'paused'; state.items[0].statusReason = 'owner_task_run_pause'; }
    if (variant === 'existingAction') {
      // No fabricated context is persisted: an existing delivered action is a
      // different history and cannot qualify for this pre-model recovery.
      const entry = clone(state.timeline.find(entry => entry.type === 'retry_scheduled'));
      entry.type = 'intent_staged'; entry.sequence = state.nextTimelineSequence++; entry.at = state.items[0].updatedAt;
      entry.details = { intentId: 'unknown-action' };
      const { timelineId: _id, contentDigest: _digest, ...content } = entry;
      entry.contentDigest = ledgerDigest(content); entry.timelineId = `work-timeline-${entry.contentDigest}`; state.timeline.push(entry);
    }
    fixture.store.replaceStored(state);
    fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
    const before = (await fixture.service.listItems()).items[0];
    const writes = fixture.store.writes.length;
    const assembler = internalReviewContextAssembler(fixture, { [variant]: true });
    const cycle = await decisionBudgetLoop(fixture, { assemble: input => assembler.assemble(input), decide: async () => assert.fail('Must remain blocked') }).runCycle();
    assert.equal(cycle.claimed, 0);
    assert.deepEqual((await fixture.service.listItems()).items[0], before);
    assert.equal(fixture.store.writes.length, writes);
  });
}

async function deliverHeadBoundWait(service, item, condition) {
  const workerId = 'employee-pr-engineer';
  const claimed = await service.claim({ itemId: item.itemId, expectedRevision: item.revision, workerId, leaseDurationMs: 30_000 });
  const staged = await service.stageIntent({ itemId: claimed.itemId, expectedRevision: claimed.revision,
    leaseId: claimed.leaseId, actorId: workerId, roleId: 'pr-engineer', intent: waitIntent(condition) });
  const dispatch = await service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30_000 });
  const result = await service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    outcome: 'delivered', nextStatus: 'waiting_condition', actorId: 'work-intent-dispatcher',
    details: { conditionRef: `bound-${dispatch.intentId}`, downstreamRef: `bound-${dispatch.intentId}` } });
  return { item: result.item, intentId: dispatch.intentId };
}

function decisionBudgetLoop(fixture, { decide, assemble = async () => ({ context: {} }), maxAttempts = 3,
  conditionForWait = () => ({ kind: 'workflow_fact', fact: 'ci-status', oneOf: ['SUCCESS'] }) } = {}) {
  let waitTurn = 0;
  return new ProactiveWorkLoop({
    ledger: fixture.service,
    clock: fixture.time.clock,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    maxAttempts,
    roleDirectory: { async resolve() { return {
      roleId: 'pr-engineer', workerId: 'employee-pr-engineer', enabled: true, paused: false,
      decide: decide ?? (async () => ({ schemaVersion: 1, confidence: 90, summary: 'Wait for CI',
        intent: { ...waitIntent(conditionForWait(++waitTurn)), summary: `Wait for observation ${waitTurn}` } })),
    }; } },
    roleContextAssembler: { assemble },
    orchestratorService: { async execute() { throw new Error('Unexpected orchestration'); } },
  });
}

async function exhaustedOldHeadWaitsFixture({ fixtureOptions = {}, ...options } = {}) {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })], ...fixtureOptions });
  const loop = decisionBudgetLoop(fixture, options);
  for (let turn = 0; turn < 3; turn += 1) {
    const cycle = await loop.runCycle();
    assert.equal(cycle.staged, 1, JSON.stringify(cycle));
    const staged = (await fixture.service.listOutbox()).items.at(-1);
    const item = (await fixture.service.listItems()).items[0];
    const dispatch = await fixture.service.claimIntent({ intentId: staged.intentId, expectedRevision: staged.revision,
      dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30_000 });
    const result = await fixture.service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
      dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: item.revision,
      outcome: 'delivered', nextStatus: 'waiting_condition', actorId: 'work-intent-dispatcher',
      details: { conditionRef: `bound-${dispatch.intentId}`, downstreamRef: `bound-${dispatch.intentId}` } });
    if (turn < 2) await fixture.service.wakeCondition({ itemId: result.item.itemId,
      expectedRevision: result.item.revision, intentId: dispatch.intentId, actorId: 'work-condition-waker',
      observation: { kind: 'workflow_fact', fact: 'ci-status', value: 'SUCCESS', observedAt: fixture.time.clock() } });
  }
  assert.equal((await fixture.service.listItems()).items[0].attempt, 3);
  return fixture;
}

async function activateDecisionBudgetHead(fixture, headRefOid = PR_HEAD_B) {
  fixture.source.records.push(prAssignment(2, { headRefOid, previousHeadRefOid: PR_HEAD_A,
    changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:05:00.000Z', gitFacts: prGitFacts(headRefOid) }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const housekeeping = new WorkCoordinationService({ ledger: fixture.service, conditionWaker: { async runCycle() {} },
    proposalResultReconciler: { async runCycle() {} }, attentionResultReconciler: { async runCycle() {} },
    workLoop: { async runCycle() {} }, dispatcher: { async dispatchPending() {} } });
  await housekeeping.runCycle({ includeWork: false });
  return (await fixture.service.listItems()).items[0];
}

test('a new accepted PR Head gets a separate decision budget after three old-Head waits and restart', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture();
  const historicalOutbox = (await fixture.service.listOutbox()).items;
  const active = await activateDecisionBudgetHead(fixture);
  assert.equal(active.source.current.headRefOid, PR_HEAD_B);
  assert.equal(active.attempt, 3, 'lifetime claim history remains intact');
  const recovered = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  let modelCalls = 0;
  const loop = decisionBudgetLoop(recovered, {
    decide: async () => { modelCalls += 1; throw new Error('The model must not run without context'); },
    assemble: async ({ item }) => {
      assert.equal(item.source.current.headRefOid, PR_HEAD_B);
      throw Object.assign(new Error('Current PR facts unavailable'), { code: 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE' });
    },
  });
  for (const [turn, status] of [[1, 'retry_wait'], [2, 'retry_wait'], [3, 'blocked']]) {
    await loop.runCycle();
    const item = (await recovered.service.listItems()).items[0];
    assert.equal(item.attempt, 3 + turn);
    assert.equal(item.status, status, `new Head decision attempt ${turn}`);
    fixture.time.advance(8_000);
  }
  assert.equal(modelCalls, 0, 'context failure is not a completed model execution');
  assert.deepEqual((await recovered.service.listOutbox()).items, historicalOutbox);
  assert.equal((await recovered.service.listTimeline({ limit: 100 })).items.filter(e => e.type === 'claimed').length, 6);
});

async function batchedHeadActivationFixture({ candidateProcessor, legacy = true } = {}) {
  const fixture = await createFixture({ records: [prAssignment(1)], candidateProcessor });
  await fixture.service.intake();
  const previous = fixture.store.stored();
  if (legacy) {
    delete previous.items[0].source.decisionBudget;
    fixture.store.replaceStored(previous);
    fixture.service = (await createFixture({ source: fixture.source, store: fixture.store,
      time: fixture.time, candidateProcessor })).service;
  }
  fixture.source.records.push(prAssignment(2, { headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A, changedFields: ['headRefOid'],
    occurredAt: '2026-08-02T01:00:02.000Z' }));
  for (const sequence of [3, 4, 5, 6]) {
    fixture.source.records.push(prAssignment(sequence, { headRefOid: PR_HEAD_B,
      occurredAt: `2026-08-02T01:00:0${sequence}.000Z`,
      title: `Updated PR metadata ${sequence}` }));
  }
  fixture.source.highWatermark = 6;
  return { ...fixture, previous };
}

for (const [processorName, createProcessor] of [
  ['local', createLocalWorkLedgerCandidateProcessor],
  ['worker', createWorkerWorkLedgerCandidateProcessor],
]) {
  test(`${processorName} intake claims a legacy PR after a Head activation and metadata updates in one batch`, async (t) => {
    const processor = createProcessor();
    t.after(() => processor.close());
    const fixture = await batchedHeadActivationFixture({ candidateProcessor: processor });

    const intake = await fixture.service.intake();
    assert.equal(intake.cursor, 6);
    const item = (await fixture.service.listClaimCandidates({ roleId: 'pr-engineer',
      at: fixture.time.clock() })).items[0];
    assert.equal(item.source.activeRevision, 6);
    assert.deepEqual(item.source.decisionBudget, { headRefOid: PR_HEAD_B,
      activationRevision: 2, previousActiveRevision: 1, attemptOffset: 0 });
    assert.deepEqual(item.source.revisions[0], fixture.previous.items[0].source.revisions[0]);
    const claimed = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 });
    assert.equal(claimed.status, 'working');
    assert.equal(claimed.attempt, 1);
    assert.deepEqual(claimed.source.decisionBudget, item.source.decisionBudget);
    assert.deepEqual(fixture.store.stored().outbox, fixture.previous.outbox);
  });
}

for (const corruption of [3, 4, 5, 6, 'missing activation proof', 'wrong activation predecessor', 'history rewrite']) {
  test(`prepared Head activation rejects ${corruption} against the actual activation timeline`, async (t) => {
    const processor = createLocalWorkLedgerCandidateProcessor();
    t.after(() => processor.close());
    let captured;
    const fixture = await batchedHeadActivationFixture({ candidateProcessor: {
      async prepare(request) { captured = clone(request); return processor.prepare(request); },
      commit: () => processor.commit(), discard: () => processor.discard(),
    } });
    await fixture.service.intake();
    const candidate = prepareWorkLedgerCandidate(captured);
    const { previousState, limits } = captured;
    const before = clone(candidate);
    const item = candidate.items[0];
    if (typeof corruption === 'number') {
      item.source.decisionBudget.activationRevision = corruption;
      assert.deepEqual(candidate.timeline, before.timeline, 'keep the genuine activation timeline unchanged');
    } else if (corruption === 'history rewrite') {
      item.source.bindings[0].assignmentDigest = 'f'.repeat(64);
    } else {
      const activation = candidate.timeline.find(entry => entry.details.decisionAttemptOffset !== undefined);
      if (corruption === 'missing activation proof') delete activation.details.decisionAttemptOffset;
      else activation.details.previousHeadRefOid = PR_HEAD_C;
      const { timelineId: _id, contentDigest: _digest, ...content } = activation;
      activation.contentDigest = ledgerDigest(content);
      activation.timelineId = `work-timeline-${activation.contentDigest}`;
    }
    assert.doesNotThrow(() => normalizeWorkLedgerPersistedState(candidate, limits));
    const writes = fixture.store.writes.length;
    assert.throws(() => prepareWorkLedgerCandidate({ previousState, candidate, limits,
      appendGraphMemory: false }), error => error.code === 'WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID');
    assert.equal(fixture.store.writes.length, writes);
    assert.deepEqual(fixture.store.stored(), before);
  });
}

test('prepared Head activation cannot hide an intermediate Head behind a later metadata budget', async () => {
  let captured;
  const fixture = await batchedHeadActivationFixture({ candidateProcessor: {
    async prepare(request) { captured ??= clone(request); return prepareWorkLedgerCandidate(request); },
    async commit() {}, async discard() {},
  } });
  captured = null;
  fixture.source.records.push(
    prAssignment(7, { headRefOid: PR_HEAD_C, previousHeadRefOid: PR_HEAD_B,
      changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:00:07.000Z' }),
    prAssignment(8, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_C,
      changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:00:08.000Z' }),
  );
  fixture.source.highWatermark = 8;
  const intake = await fixture.service.intake();
  assert.ok(intake.cursor > 1 && intake.cursor < 8, 'commit only a strictly valid prefix');
  const committed = fixture.store.stored();
  const { previousState, limits } = captured;
  const candidate = normalizeWorkLedgerPersistedState(
    appendWorkGraphMemoryEvents(previousState, captured.candidate, limits), limits);
  candidate.items[0].source.decisionBudget.previousActiveRevision = 1;
  assert.equal(candidate.items[0].source.decisionBudget.activationRevision, 8);
  assert.doesNotThrow(() => normalizeWorkLedgerPersistedState(candidate, limits));
  assert.throws(() => prepareWorkLedgerCandidate({ previousState, candidate, limits,
    appendGraphMemory: false }), error => error.code === 'WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID');
  assert.deepEqual(fixture.store.stored(), committed);
});

test('Head activation uses the committed pointer after old source timeline entries are trimmed', async () => {
  const fixture = await createFixture({ records: [prAssignment(1)], limits: { timelineLimit: 64 } });
  await fixture.service.intake();
  const original = fixture.store.stored().items[0];
  fixture.source.records.push(...Array.from({ length: 70 }, (_, index) => assignment(index + 2)));
  fixture.source.highWatermark = 71;
  await fixture.service.intake({ limit: 100 });
  assert.equal(fixture.store.stored().timeline.some(entry => entry.itemId === original.itemId), false);
  fixture.source.records.push(prAssignment(72, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:01:00.000Z' }),
  prAssignment(73, { headRefOid: PR_HEAD_B, title: 'Metadata after activation',
    occurredAt: '2026-08-02T01:01:01.000Z' }));
  fixture.source.highWatermark = 73;
  await fixture.service.intake();
  const updated = fixture.store.stored().items.find(item => item.itemId === original.itemId);
  assert.deepEqual(updated.source.decisionBudget, { headRefOid: PR_HEAD_B,
    activationRevision: 2, previousActiveRevision: 1, attemptOffset: 0 });
  assert.equal(updated.source.activeRevision, 3);
});

for (const [processorName, createProcessor] of [
  ['local', createLocalWorkLedgerCandidateProcessor],
  ['worker', createWorkerWorkLedgerCandidateProcessor],
]) {
  test(`${processorName} intake preserves this mutation's activation proof when 70 unrelated assignments would trim it`, async (t) => {
    const processor = createProcessor();
    t.after(() => processor.close());
    const fixture = await createFixture({ records: [prAssignment(1)],
      limits: { timelineLimit: 64 }, candidateProcessor: processor });
    await fixture.service.intake();
    const previous = fixture.store.stored();
    fixture.source.records.push(prAssignment(2, { headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A, changedFields: ['headRefOid'],
      occurredAt: '2026-08-02T01:00:02.000Z' }),
    ...Array.from({ length: 70 }, (_, index) => assignment(index + 3)));
    fixture.source.highWatermark = 72;

    const writes = fixture.store.writes.length;
    fixture.store.failNextWrite();
    await assert.rejects(fixture.service.intake({ limit: 100 }),
      error => error.code === 'WORK_LEDGER_STATE_WRITE_FAILED');
    assert.equal(fixture.store.writes.length, writes, 'do not retry a failed durable write');
    assert.deepEqual(fixture.store.stored(), previous);
    const first = await fixture.service.intake({ limit: 100 });
    assert(first.cursor >= 2 && first.cursor < 72, 'commit a proven prefix before the activation is trimmed');
    assert.equal(first.highWatermark, 72);
    const pages = [first];
    fixture.service = (await createFixture({ source: fixture.source, store: fixture.store,
      time: fixture.time, limits: { timelineLimit: 64 }, candidateProcessor: processor })).service;
    while (pages.at(-1).cursor < 72 && pages.length < 5) {
      const page = await fixture.service.intake({ limit: 100 });
      assert(page.cursor > pages.at(-1).cursor);
      pages.push(page);
    }
    assert.equal(pages.at(-1).cursor, 72);
    assert.equal(pages.reduce((sum, page) => sum + page.received, 0), 71);
    const durable = fixture.store.stored();
    assert.equal(durable.timeline.length, 64);
    const item = durable.items.find(item => item.itemId === previous.items[0].itemId);
    assert.deepEqual(item.source.decisionBudget, { headRefOid: PR_HEAD_B,
      activationRevision: 2, previousActiveRevision: 1, attemptOffset: 0 });
    assert.deepEqual(item.source.revisions.slice(0, 1), previous.items[0].source.revisions);
    assert.deepEqual(item.source.bindings.slice(0, 1), previous.items[0].source.bindings);
    assert.equal(item.attempt, 0);
    const claimed = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 });
    assert.equal(claimed.status, 'working');
    assert.equal(claimed.attempt, 1);
    assert.deepEqual(claimed.source.decisionBudget, item.source.decisionBudget);
    assert.deepEqual(fixture.store.stored().outbox, previous.outbox);
  });
}

test('a deferred Head activation starts its budget only after an explicit time wait is satisfied', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture({ conditionForWait: (turn) => turn === 3 ?
    { kind: 'time', notBefore: '2026-08-02T02:01:00.000Z' } :
    { kind: 'workflow_fact', fact: 'ci-status', oneOf: ['SUCCESS'] } });
  const waiting = await activateDecisionBudgetHead(fixture);
  assert.equal(waiting.status, 'waiting_condition');
  assert.equal(waiting.source.current.headRefOid, PR_HEAD_A);
  assert.equal(waiting.source.pending.headRefOid, PR_HEAD_B);
  assert.equal((await decisionBudgetLoop(fixture, { assemble: unavailablePrContext }).runCycle()).claimed, 0);
  fixture.time.advance(60_000);
  await fixture.service.wakeCondition({ itemId: waiting.itemId, expectedRevision: waiting.revision,
    intentId: waiting.activeIntentId, actorId: 'work-condition-waker',
    observation: { kind: 'time', observedAt: fixture.time.clock() } });
  const housekeeping = new WorkCoordinationService({ ledger: fixture.service, conditionWaker: { async runCycle() {} },
    proposalResultReconciler: { async runCycle() {} }, attentionResultReconciler: { async runCycle() {} },
    workLoop: { async runCycle() {} }, dispatcher: { async dispatchPending() {} } });
  await housekeeping.runCycle({ includeWork: false });
  const activation = (await fixture.service.listTimeline({ limit: 100 })).items.findLast(e => e.type === 'pr_source_activated');
  assert.equal(activation.details.decisionAttemptOffset, 3);
  assert.equal(activation.details.previousHeadRefOid, PR_HEAD_A);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal((await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle()).retried, 1);
  assert.equal((await restarted.service.listItems()).items[0].attempt, 4);
});

function unavailablePrContext() {
  throw Object.assign(new Error('Current PR facts unavailable'), { code: 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE' });
}

test('a fresh Base automatically requeues an own PR blocked on obsolete facts and preserves its history', async () => {
  const makeRecord = (sequence, baseRefOid = 'd'.repeat(40)) => {
    const record = prAssignment(sequence, { gitFacts: { ...prGitFacts(PR_HEAD_A, { baseRefOid }),
      relation: 'authored', nextAction: 'resolve_conflict', actionState: 'action_now', isDraft: true } });
    record.assignment.target.id = 'developer'; record.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
    return record;
  };
  const fixture = await createFixture({ records: [makeRecord(1)] });
  await fixture.service.intake();
  const initial = (await fixture.service.listItems()).items[0];
  const claim = await fixture.service.claim({ itemId: initial.itemId, expectedRevision: initial.revision,
    workerId: 'developer-worker', leaseDurationMs: 60_000 });
  await fixture.service.transition({ itemId: initial.itemId, expectedRevision: claim.revision, leaseId: claim.leaseId,
    actorId: 'developer-worker', toStatus: 'blocked', reason: 'decision_attempts_exhausted',
    details: { code: 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE' } });
  const blocked = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(makeRecord(2, 'e'.repeat(40))); fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const refreshed = (await fixture.service.listItems()).items[0];
  assert.equal(refreshed.status, 'queued');
  assert.equal(refreshed.statusReason, 'pr_source_revised');
  assert.equal(refreshed.attempt, blocked.attempt);
  assert.deepEqual(refreshed.source.decisionBudget, blocked.source.decisionBudget);
  assert.equal(refreshed.source.current.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual((await restarted.service.listItems()).items[0], refreshed);
  const history = (await restarted.service.listTimeline({ itemId: initial.itemId, limit: 100 })).items;
  assert.equal(history.filter(entry => entry.details?.context?.code === 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE').length, 1);
  assert.equal(history.at(-1).type, 'pr_source_revised');
});

test('replaced pending Heads bind the decision budget to the actual A-to-C activation', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture({ conditionForWait: turn => turn === 3 ?
    { kind: 'time', notBefore: '2026-08-02T02:01:00.000Z' } :
    { kind: 'workflow_fact', fact: 'ci-status', oneOf: ['SUCCESS'] } });
  await activateDecisionBudgetHead(fixture);
  fixture.source.records.push(prAssignment(3, { headRefOid: PR_HEAD_C, previousHeadRefOid: PR_HEAD_B,
    changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:06:00.000Z', gitFacts: prGitFacts(PR_HEAD_C) }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const waiting = (await fixture.service.listItems()).items[0];
  assert.equal(waiting.source.current.headRefOid, PR_HEAD_A);
  assert.equal(waiting.source.pending.headRefOid, PR_HEAD_C);
  assert.deepEqual(waiting.source.decisionBudget, { headRefOid: PR_HEAD_A, activationRevision: 1,
    previousActiveRevision: null, attemptOffset: 0 }, 'pending replacement cannot reset the active budget');
  fixture.time.advance(60_000);
  await fixture.service.wakeCondition({ itemId: waiting.itemId, expectedRevision: waiting.revision,
    intentId: waiting.activeIntentId, actorId: 'work-condition-waker', observation: { kind: 'time', observedAt: fixture.time.clock() } });
  const housekeeping = new WorkCoordinationService({ ledger: fixture.service, conditionWaker: { async runCycle() {} },
    proposalResultReconciler: { async runCycle() {} }, attentionResultReconciler: { async runCycle() {} },
    workLoop: { async runCycle() {} }, dispatcher: { async dispatchPending() {} } });
  await housekeeping.runCycle({ includeWork: false });
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const cycle = await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle();
  assert.equal(cycle.retried, 1, 'first decision on actual activated C must retain its own budget');
  const item = (await restarted.service.listItems()).items[0];
  assert.equal(item.attempt, 4);
  assert.equal(item.source.current.headRefOid, PR_HEAD_C);
  assert.deepEqual(item.source.decisionBudget, { headRefOid: PR_HEAD_C, activationRevision: 3,
    previousActiveRevision: 1, attemptOffset: 3 });
});

test('durable Head budget survives global timeline trim and restart before first and second failures', async () => {
  const limits = { timelineLimit: 64 };
  const fixture = await exhaustedOldHeadWaitsFixture({ fixtureOptions: { limits } });
  await activateDecisionBudgetHead(fixture);
  fixture.source.records.push(...Array.from({ length: 70 }, (_, index) => assignment(index + 3)));
  fixture.source.highWatermark = 72;
  await fixture.service.intake({ limit: 100 });
  assert.equal((await fixture.service.listTimeline({ limit: 100 })).items.some(entry => entry.type === 'pr_source_activated' ||
    entry.itemId === (fixture.store.stored().items[0].itemId)), false, 'activation and all old claims were trimmed');
  for (const turn of [1, 2]) {
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
    const cycle = await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle({ roleId: 'pr-engineer' });
    assert.equal(cycle.retried, 1, `current Head failure ${turn} after trim`);
    assert.equal((await restarted.service.listItems()).items.find(item => item.kind === 'source_root').attempt, 3 + turn);
    fixture.time.advance(8_000);
  }
});

test('a normal legacy claim seals its strictly proven budget before later timeline trim', async () => {
  const limits = { timelineLimit: 64 };
  const fixture = await exhaustedOldHeadWaitsFixture({ fixtureOptions: { limits } });
  await activateDecisionBudgetHead(fixture);
  const legacy = fixture.store.stored();
  delete legacy.items[0].source.decisionBudget;
  fixture.store.replaceStored(legacy);
  const before = ledgerDigest(legacy.items[0]);
  let restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
  assert.equal(ledgerDigest((await restarted.service.listItems()).items[0]), before, 'reading old source adds no field');
  assert.equal((await restarted.service.listItems()).items[0].source.decisionBudget, undefined);
  assert.equal((await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle()).retried, 1);
  const claimed = (await restarted.service.listItems()).items[0];
  assert.equal(claimed.attempt, 4);
  assert.equal(claimed.source.decisionBudget.attemptOffset, 3);
  fixture.source.records.push(...Array.from({ length: 70 }, (_, index) => assignment(index + 3)));
  fixture.source.highWatermark = 72;
  await restarted.service.intake({ limit: 100 });
  fixture.time.advance(8_000);
  restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
  assert.equal((await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle({ roleId: 'pr-engineer' })).retried, 1);
  const current = (await restarted.service.listItems()).items.find(item => item.kind === 'source_root');
  assert.equal(current.attempt, 5);
  assert.deepEqual(current.source.decisionBudget, claimed.source.decisionBudget);
});

test('a legacy normal claim without retained activation proof never guesses an offset', async () => {
  const limits = { timelineLimit: 64 };
  const fixture = await exhaustedOldHeadWaitsFixture({ fixtureOptions: { limits } });
  await activateDecisionBudgetHead(fixture);
  const legacy = fixture.store.stored();
  delete legacy.items[0].source.decisionBudget;
  fixture.store.replaceStored(legacy);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
  fixture.source.records.push(...Array.from({ length: 70 }, (_, index) => assignment(index + 3)));
  fixture.source.highWatermark = 72;
  await restarted.service.intake({ limit: 100 });
  assert.equal((await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle({ roleId: 'pr-engineer' })).blocked, 1);
  const item = (await restarted.service.listItems()).items.find(item => item.kind === 'source_root');
  assert.equal(item.attempt, 4);
  assert.equal(item.source.decisionBudget, undefined);
});

test('a same-Head base update preserves the durable budget and its activation binding', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture();
  const active = await activateDecisionBudgetHead(fixture);
  fixture.source.records.push(prAssignment(3, { headRefOid: PR_HEAD_B, changedFields: ['gitTarget'],
    occurredAt: '2026-08-02T01:06:00.000Z', gitFacts: prGitFacts(PR_HEAD_B, { baseRefOid: 'e'.repeat(40) }) }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const updated = (await fixture.service.listItems()).items[0];
  assert.equal(updated.source.activeRevision, 3);
  assert.deepEqual(updated.source.decisionBudget, active.source.decisionBudget);
});

test('a durable genuine exhaustion remains blocked when maxAttempts later increases', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture();
  await activateDecisionBudgetHead(fixture);
  const loop = decisionBudgetLoop(fixture, { assemble: unavailablePrContext });
  for (let turn = 0; turn < 3; turn += 1) {
    await loop.runCycle();
    fixture.time.advance(8_000);
  }
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.statusReason, 'decision_attempts_exhausted');
  assert.equal(item.attempt, 6);
  const durableBudget = persistedPullRequestDecisionAttemptBudget(item);
  assert.equal(canRecoverPullRequestDecisionBudget(item, durableBudget, 4), false);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal((await decisionBudgetLoop(restarted, { maxAttempts: 4, assemble: unavailablePrContext }).runCycle()).claimed, 0);
  assert.deepEqual((await restarted.service.listItems()).items[0], item);
});

test('cross-root activation uses the receiving root counter and retains the predecessor budget', async () => {
  const fixture = await exhaustedOldHeadWaitsFixture();
  const predecessor = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(ownerRequestedPrAssignment(2, { headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B), occurredAt: '2026-08-02T01:10:00.000Z' }));
  fixture.source.highWatermark = 2;
  assert.equal((await fixture.service.intake()).error, undefined);
  const items = (await fixture.service.listItems()).items;
  const receiver = items.find(item => item.itemId !== predecessor.itemId);
  assert.equal(receiver.attempt, 0);
  assert.equal(receiver.source.decisionBudget.attemptOffset, 0);
  assert.deepEqual(items.find(item => item.itemId === predecessor.itemId).source.decisionBudget, predecessor.source.decisionBudget);
  assert.equal((await decisionBudgetLoop(fixture, { assemble: unavailablePrContext }).runCycle()).retried, 1);
});

for (const change of ['offset', 'delete', 'over-attempt', 'wrong-head', 'wrong-predecessor']) {
  test(`durable budget validation rejects ${change} without writing`, async () => {
    const fixture = await exhaustedOldHeadWaitsFixture();
    await activateDecisionBudgetHead(fixture);
    const previous = fixture.store.stored();
    const candidate = clone(previous);
    candidate.revision += 1;
    const item = candidate.items[0];
    item.revision += 1;
    if (change === 'delete') delete item.source.decisionBudget;
    else if (change === 'offset') item.source.decisionBudget.attemptOffset = 2;
    else if (change === 'over-attempt') item.source.decisionBudget.attemptOffset = 4;
    else if (change === 'wrong-head') item.source.decisionBudget.headRefOid = PR_HEAD_A;
    else item.source.decisionBudget.previousActiveRevision = item.source.activeRevision;
    const writes = fixture.store.writes.length;
    assert.throws(() => prepareWorkLedgerCandidate({ previousState: previous, candidate,
      limits: normalizeWorkLedgerLimits(), appendGraphMemory: false }), error =>
      ['WORK_LEDGER_STATE_CORRUPTED', 'WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID'].includes(error.code));
    assert.equal(fixture.store.writes.length, writes);
    assert.deepEqual(fixture.store.stored(), previous);
  });
}

async function legacyActivatedDecisionBlockFixture() {
  const fixture = await exhaustedOldHeadWaitsFixture();
  await activateDecisionBudgetHead(fixture);
  let claimed = (await fixture.service.listItems()).items[0];
  claimed = await fixture.service.claim({ itemId: claimed.itemId, expectedRevision: claimed.revision,
    workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 });
  await fixture.service.transition({ itemId: claimed.itemId, expectedRevision: claimed.revision,
    leaseId: claimed.leaseId, actorId: 'employee-pr-engineer', toStatus: 'blocked',
    reason: 'decision_attempts_exhausted', details: { code: 'ROLE_CONTEXT_PR_FACT_UNAVAILABLE' } });
  const legacy = fixture.store.stored();
  delete legacy.items[0].source.decisionBudget;
  for (const entry of legacy.timeline) {
    delete entry.details.decisionAttemptOffset;
    delete entry.details.previousHeadRefOid;
    delete entry.details.previousActiveRevision;
    const { timelineId: _timelineId, contentDigest: _digest, ...content } = entry;
    entry.contentDigest = ledgerDigest(content);
    entry.timelineId = `work-timeline-${entry.contentDigest}`;
  }
  fixture.store.replaceStored(legacy);
  fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
  // The real claim and failure transition reproduce the deployed legacy state;
  // only the newly introduced metadata is removed from this historical fixture.
  const blocked = (await fixture.service.listItems()).items[0];
  assert.equal(blocked.statusReason, 'decision_attempts_exhausted');
  assert.equal(blocked.attempt, 4);
  return fixture;
}

test('a legacy activated Head block recovers automatically once and keeps genuine same-Head exhaustion blocked after restart', async () => {
  const fixture = await legacyActivatedDecisionBlockFixture();
  const outbox = (await fixture.service.listOutbox()).items;
  let restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  let modelCalls = 0;
  const options = { assemble: unavailablePrContext, decide: async () => { modelCalls += 1; } };
  const recovered = await decisionBudgetLoop(restarted, options).runCycle();
  assert.equal(recovered.retried, 1);
  assert.equal(recovered.claimed, 1);
  assert.equal((await restarted.service.listItems()).items[0].attempt, 5);
  assert.equal((await restarted.service.listItems()).items[0].status, 'retry_wait');
  fixture.time.advance(8_000);
  restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const loop = decisionBudgetLoop(restarted, options);
  assert.equal((await loop.runCycle()).blocked, 1);
  const genuinelyExhausted = (await restarted.service.listItems()).items[0];
  assert.equal(genuinelyExhausted.attempt, 6);
  assert.equal((await loop.runCycle()).claimed, 0);
  assert.deepEqual((await restarted.service.listItems()).items[0], genuinelyExhausted);
  assert.equal(modelCalls, 0);
  assert.deepEqual((await restarted.service.listOutbox()).items, outbox);
  assert.equal((await restarted.service.listTimeline({ limit: 100 })).items.filter(entry =>
    entry.type === 'transitioned' && entry.details.reason === 'pr_head_decision_budget_recovered').length, 1);
});

for (const update of ['live-base', 'bound-existing-event']) {
  test(`legacy Head-budget recovery composes with automatic intake of ${update} facts`, async () => {
    const fixture = await legacyActivatedDecisionBlockFixture();
    const originalOutbox = (await fixture.service.listOutbox()).items;
    fixture.time.advance(1_000);
    const record = update === 'live-base' ? prAssignment(3, {
      headRefOid: PR_HEAD_B, changedFields: ['gitTarget'], occurredAt: '2026-08-02T01:06:00.000Z',
      gitFacts: prGitFacts(PR_HEAD_B, { baseRefOid: 'e'.repeat(40) }),
    }) : { ...clone(fixture.source.records[1]), sequence: 3,
      assignment: { ...clone(fixture.source.records[1].assignment), assignmentId: 'new-binding-for-current-event' } };
    fixture.source.records.push(record);
    fixture.source.highWatermark = 3;
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    const loop = decisionBudgetLoop(restarted, { assemble: async ({ item }) => {
      assert.equal(item.source.current.headRefOid, PR_HEAD_B);
      if (update === 'live-base') assert.equal(item.source.current.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
      return unavailablePrContext();
    } });
    const cycle = await loop.runCycle();
    assert.equal(cycle.intake.cursor, 3);
    assert.equal(cycle.retried, 1, JSON.stringify(cycle));
    const item = (await restarted.service.listItems()).items[0];
    assert.equal(item.attempt, 5);
    assert.equal(item.status, 'retry_wait');
    assert.deepEqual((await restarted.service.listOutbox()).items, originalOutbox);
  });
}

for (const protection of ['paused', 'cancelled', 'waiting_condition', 'waiting_external',
  'active_intent', 'unknown_action', 'missing_proof', 'stale_activation', 'same_head']) {
  test(`automatic Head-budget recovery preserves ${protection} work`, async () => {
    const fixture = await legacyActivatedDecisionBlockFixture();
    const durable = fixture.store.stored();
    const item = durable.items[0];
    if (['paused', 'cancelled', 'waiting_condition', 'waiting_external'].includes(protection)) {
      item.status = protection;
      item.statusReason = `protected-${protection}`;
    } else if (protection === 'active_intent') {
      item.activeIntentId = durable.outbox.at(-1).intentId;
    } else if (protection === 'missing_proof') {
      durable.timeline = durable.timeline.filter(entry => entry.type !== 'claimed' || entry.details.attempt > 3);
      // Retention removes a prefix, never holes; retain only the activation and
      // subsequent events so an absent historical counter cannot be guessed.
      const activation = durable.timeline.findLast(entry => entry.type === 'pr_source_revised');
      durable.timeline = durable.timeline.filter(entry => entry.sequence >= activation.sequence);
      durable.timelineStartSequence = durable.timeline[0].sequence;
    } else if (protection === 'stale_activation') {
      const activation = durable.timeline.findLast(entry => entry.type === 'pr_source_revised');
      activation.details.headRefOid = PR_HEAD_C;
      const { timelineId: _id, contentDigest: _digest, ...content } = activation;
      activation.contentDigest = ledgerDigest(content);
      activation.timelineId = `work-timeline-${activation.contentDigest}`;
    } else if (protection === 'unknown_action') {
      const appended = appendWorkLedgerTimeline(durable, [{ itemId: item.itemId, type: 'intent_staged',
        at: fixture.time.clock(), actorId: 'employee-pr-engineer', details: { intentId: 'unknown-external-action' } }],
      normalizeWorkLedgerLimits().timelineLimit);
      durable.timeline = appended.timeline;
      durable.timelineStartSequence = appended.timelineStartSequence;
      durable.nextTimelineSequence = appended.nextTimelineSequence;
    } else {
      // No accepted Head boundary exists in this legacy source history.
      item.source.revisions = item.source.revisions.map(revision => ({ ...revision, headRefOid: PR_HEAD_B }));
    }
    fixture.store.replaceStored(durable);
    // Boundary fixtures that would violate persisted schema are tested at the
    // recovery predicate below; never weaken production state validation.
    if (['active_intent', 'same_head'].includes(protection)) {
      const budget = pullRequestDecisionAttemptBudget(item, durable.timeline);
      assert.equal(canRecoverPullRequestDecisionBudget(item, budget, 3), false);
      return;
    }
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    const before = (await restarted.service.listItems()).items[0];
    const cycle = await decisionBudgetLoop(restarted, { assemble: unavailablePrContext }).runCycle();
    assert.equal(cycle.claimed, 0);
    assert.deepEqual((await restarted.service.listItems()).items[0], before);
  });
}

async function completedInactivePrFixture() {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({ itemId: root.itemId, expectedRevision: root.revision,
    workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 });
  const staged = await fixture.service.stageIntent({ itemId: root.itemId, expectedRevision: root.revision,
    leaseId: root.leaseId, actorId: 'employee-pr-engineer', roleId: 'pr-engineer', intent: reviewIntent() });
  const claimed = await fixture.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30_000 });
  const sealed = await fixture.service.bindIntent({ intentId: claimed.intentId, expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision, dispatcherId: claimed.dispatcherId, dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, { requestedBy: { roleId: 'pr-engineer', workItemId: staged.item.itemId },
      binding: { repository: 'acme/repo', pullRequestNumber: 42 } }) });
  const left = prAssignment(2, { eventType: 'pull_request.left_scope', occurredAt: '2026-08-02T01:05:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A) }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, left));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  await fixture.service.ackIntent({ intentId: sealed.intentId, expectedRevision: sealed.revision,
    itemExpectedRevision: root.revision, dispatchLeaseId: sealed.dispatchLeaseId, actorId: 'work-intent-dispatcher',
    outcome: 'delivered', nextStatus: 'completed', details: { downstreamRef: 'sealed-before-left-scope' } });
  fixture.source.records.push(prAssignment(3, { pullRequestNumber: 43, headRefOid: PR_HEAD_C, gitFacts: prGitFacts(PR_HEAD_C) }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  return fixture;
}

for (const limit of [1, 2, 100]) {
  test(`ignored scope reentry preserves a completed inactive PR and cannot poison intake (limit ${limit})`, async () => {
    const fixture = await completedInactivePrFixture();
    const before = (await fixture.service.listItems()).items.find(item => item.source.identity.pullRequestNumber === 42);
    assert.equal(before.status, 'completed');
    assert.equal(before.source.scope.active, false);
    const outbox = (await fixture.service.listOutbox()).items;
    const changed = prAssignment(5, { eventType: 'pull_request.created', headRefOid: PR_HEAD_B,
      occurredAt: '2026-08-02T01:10:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) });
    fixture.source.records.push(prScopeLifecycleAssignment(4, changed.event), changed,
      prAssignment(6, { pullRequestNumber: 43, headRefOid: PR_HEAD_C, changedFields: ['gitTarget'],
        occurredAt: '2026-08-02T01:11:00.000Z', gitFacts: prGitFacts(PR_HEAD_C, { baseRefOid: 'e'.repeat(40) }) }));
    fixture.source.highWatermark = 6;
    const feed = clone(fixture.source.records);
    for (let step = 0; step < 3; step += 1) {
      const result = await fixture.service.intake({ limit });
      assert.equal(result.error, undefined, JSON.stringify(result));
      if (result.cursor === 6) break;
    }
    assert.equal((await fixture.service.getSummary()).intakeCursor, 6);
    const items = (await fixture.service.listItems()).items;
    assert.deepEqual(items.find(item => item.itemId === before.itemId), before);
    assert.equal(items.find(item => item.source.identity.pullRequestNumber === 43).source.current.event.payload.gitTarget.baseRefOid,
      'e'.repeat(40), 'a later legitimate PR update must not be stuck behind a rejected observation');
    assert.deepEqual((await fixture.service.listOutbox()).items, outbox);
    assert.deepEqual(fixture.source.records, feed);
    const audit = (await fixture.service.listTimeline({ limit: 100 })).items.filter(entry =>
      entry.itemId === before.itemId && entry.type === 'pr_source_ignored' && [4, 5].includes(entry.details.sourceSequence));
    assert.equal(audit.length, 2);
    assert.ok(audit.every(entry => entry.details.disposition === 'ignored_unproven_head'));
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    assert.equal((await restarted.service.intake({ limit })).received, 0);
    assert.deepEqual((await restarted.service.listItems()).items, items);
  });
}

for (const limit of [1, 100]) {
  test(`a proven Head advance retires completed inactive work without blocking later intake (limit ${limit})`, async () => {
    const fixture = await completedInactivePrFixture();
    const before = (await fixture.service.listItems()).items.find(item => item.source.identity.pullRequestNumber === 42);
    const outboxes = (await fixture.service.listOutbox()).items;
    const previousState = fixture.store.stored();
    fixture.source.records.push(prAssignment(4, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
      changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:10:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) }),
    prAssignment(5, { headRefOid: PR_HEAD_B, changedFields: ['gitTarget'],
      occurredAt: '2026-08-02T01:11:00.000Z', gitFacts: prGitFacts(PR_HEAD_B, { baseRefOid: 'e'.repeat(40) }) }),
    prAssignment(6, { pullRequestNumber: 43, headRefOid: PR_HEAD_C, changedFields: ['gitTarget'],
      occurredAt: '2026-08-02T01:12:00.000Z', gitFacts: prGitFacts(PR_HEAD_C, { baseRefOid: 'e'.repeat(40) }) }));
    fixture.source.highWatermark = 6;
    for (let step = 0; step < 3; step++) {
      const result = await fixture.service.intake({ limit });
      assert.equal(result.error, undefined, JSON.stringify(result));
      if (result.cursor === 6) break;
    }
    assert.equal((await fixture.service.getSummary()).intakeCursor, 6);
    const items = (await fixture.service.listItems()).items;
    const retired = items.find(item => item.itemId === before.itemId);
    assert.equal(retired.status, 'blocked');
    assert.equal(retired.statusReason, 'pr_source_left_scope');
    assert.equal(retired.source.scope.active, false);
    assert.equal(retired.source.current.headRefOid, PR_HEAD_B);
    assert.equal(retired.decisionContext, null);
    assert.deepEqual(retired.graph, before.graph);
    assert.deepEqual((await fixture.service.listOutbox()).items, outboxes);
    await assert.rejects(fixture.service.claim({ itemId: retired.itemId, expectedRevision: retired.revision,
      workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 }));
    if (limit === 100) {
      const after = fixture.store.stored();
      validateWorkLedgerGraphTransition(previousState, after);
      for (const mutate of [
        item => { item.status = 'completed'; },
        item => { item.source.scope.revision++; },
        item => { item.source.identity.scopeId = 'another-scope'; },
        item => { item.graph.acceptanceContracts[0].acceptanceCriteria.push('Changed historical contract'); },
        item => { item.activeIntentId = 'unsettled-intent'; },
        item => { item.source.current.sourceSequence = before.source.current.sourceSequence; },
        item => { item.source.activeRevision = before.source.activeRevision; },
      ]) {
        const forged = clone(after);
        mutate(forged.items.find(item => item.itemId === retired.itemId));
        assert.throws(() => validateWorkLedgerGraphTransition(previousState, forged));
      }
    }
    assert.equal(items.find(item => item.source.identity.pullRequestNumber === 43).source.current.event.payload.gitTarget.baseRefOid,
      'e'.repeat(40));
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    assert.equal((await restarted.service.intake({ limit })).received, 0);
    assert.deepEqual((await restarted.service.listItems()).items, items);
  });
}

test('accepted scope reentry and a later proven Head update retain normal authority rules', async () => {
  const fixture = await completedInactivePrFixture();
  const before = (await fixture.service.listItems()).items.find(item => item.source.identity.pullRequestNumber === 42);
  const outbox = (await fixture.service.listOutbox()).items;
  const created = prAssignment(5, { eventType: 'pull_request.created', headRefOid: PR_HEAD_A,
    occurredAt: '2026-08-02T01:10:00.000Z', gitFacts: prGitFacts(PR_HEAD_A) });
  fixture.source.records.push(prScopeLifecycleAssignment(4, created.event), created);
  fixture.source.highWatermark = 5;
  assert.equal((await fixture.service.intake({ limit: 100 })).error, undefined);
  let active = (await fixture.service.listItems()).items.find(item => item.itemId === before.itemId);
  assert.equal(active.status, 'queued');
  assert.equal(active.source.scope.active, true);
  assert.equal(active.source.current.headRefOid, PR_HEAD_A);
  assert.equal(active.attempt, before.attempt);
  assert.deepEqual((await fixture.service.listOutbox()).items, outbox);
  fixture.source.records.push(prAssignment(6, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:11:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = 6;
  assert.equal((await fixture.service.intake()).error, undefined);
  active = (await fixture.service.listItems()).items.find(item => item.itemId === before.itemId);
  assert.equal(active.source.current.headRefOid, PR_HEAD_B);
  const budget = pullRequestDecisionAttemptBudget(active, (await fixture.service.listTimeline({ limit: 100 })).items);
  assert.equal(budget.attempt, 0);
  assert.equal(budget.offset, before.attempt);
});

test('a cancelled inactive PR ignores both unproven reentry routes without poisoning intake', async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const left = prAssignment(2, { eventType: 'pull_request.left_scope', occurredAt: '2026-08-02T01:05:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A) }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, left));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, false);
  await fixture.service.cancelGraphTask({ itemId: root.itemId, expectedRevision: root.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    actorId: 'owner-task-control', reason: 'Owner repaired this PR' });
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, 'cancelled');
  const created = prAssignment(4, { eventType: 'pull_request.created', headRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:10:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) });
  fixture.source.records.push(prScopeLifecycleAssignment(3, created.event), created, assignment(5));
  fixture.source.highWatermark = 5;
  const intake = await fixture.service.intake({ limit: 100 });
  assert.equal(intake.error, undefined);
  assert.equal(intake.cursor, 5);
  assert.deepEqual((await fixture.service.listItems()).items.find(item => item.itemId === root.itemId), root);
  const audit = (await fixture.service.listTimeline({ limit: 100 })).items.filter(entry =>
    entry.type === 'pr_source_ignored' && entry.details.disposition === 'ignored_cancelled_source');
  assert.equal(audit.length, 2);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal((await restarted.service.intake()).received, 0);
  assert.deepEqual((await restarted.service.listItems()).items.find(item => item.itemId === root.itemId), root);
});

test('a new PR Head supersedes an obsolete delivered condition and remains wakeable after recovery', async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const initial = (await fixture.service.listItems()).items[0];
  const waiting = await deliverHeadBoundWait(fixture.service, initial, { kind: 'workflow_fact', fact: 'merge-state', oneOf: ['CLEAN', 'BLOCKED'] });
  const historical = (await fixture.service.listOutbox()).items.find(entry => entry.intentId === waiting.intentId);
  const latest = prAssignment(2, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    changedFields: ['headRefOid', 'mergeStateStatus'], occurredAt: '2026-08-02T01:05:00.000Z',
    ciStatus: 'SUCCESS', gitFacts: { ...prGitFacts(PR_HEAD_B), mergeStateStatus: 'BLOCKED' } });
  await fixture.store.write('snapshot', { refreshedAt: fixture.time.clock(),
    sourceStatus: { githubPullRequests: { ok: true, stale: false } },
    items: [{ id: initial.event.subject.id, ...latest.event.payload }] });
  const facts = new WorkflowFactSource({ store: fixture.store, clock: fixture.time.clock });
  const waker = new WorkConditionWaker({ ledger: fixture.service, factSource: facts, clock: fixture.time.clock });
  assert.equal((await waker.runCycle()).woken, 0, 'new-Head facts must not satisfy an old-Head condition');
  fixture.source.records.push(latest); fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const housekeeping = new WorkCoordinationService({ ledger: fixture.service, conditionWaker: waker,
    proposalResultReconciler: { async runCycle() {} }, attentionResultReconciler: { async runCycle() {} },
    workLoop: { async runCycle() {} }, dispatcher: { async dispatchPending() {} } });
  await housekeeping.runCycle({ includeWork: false });
  let active = (await fixture.service.listItems()).items[0];
  assert.equal(active.status, 'queued');
  assert.equal(active.source.current.headRefOid, PR_HEAD_B);
  assert.equal(active.activeIntentId, null);
  assert.deepEqual((await fixture.service.listOutbox()).items.find(entry => entry.intentId === waiting.intentId), historical,
    'superseding a wait preserves the original delivered receipt');
  assert.equal((await fixture.service.listTimeline({ limit: 100 })).items.filter(entry =>
    entry.type === 'intent_superseded' && entry.details.intentId === waiting.intentId).length, 1);
  const recovered = new WorkLedgerService({ store: fixture.store, assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(), clock: fixture.time.clock, idFactory: incrementingIds() });
  await recovered.recover();
  active = (await recovered.listItems()).items[0];
  await deliverHeadBoundWait(recovered, active, { kind: 'workflow_fact', fact: 'ci-status', oneOf: ['SUCCESS'] });
  const recoveredWaker = new WorkConditionWaker({ ledger: recovered, factSource: facts, clock: fixture.time.clock });
  assert.equal((await recoveredWaker.runCycle()).woken, 1, 'a later wait observes the active event, not the original root event');
  assert.equal((await recoveredWaker.runCycle()).woken, 0);
  const runnable = (await recovered.listItems()).items[0];
  const claim = await recovered.claim({ itemId: runnable.itemId, expectedRevision: runnable.revision,
    workerId: 'employee-pr-engineer', leaseDurationMs: 30_000 });
  assert.equal(claim.source.current.headRefOid, PR_HEAD_B);
});

test('new PR code does not bypass an explicit time condition', async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const initial = (await fixture.service.listItems()).items[0];
  await deliverHeadBoundWait(fixture.service, initial, { kind: 'time', notBefore: '2026-08-03T01:00:00.000Z' });
  fixture.source.records.push(prAssignment(2, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:05:00.000Z', gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = 2; await fixture.service.intake();
  assert.equal((await fixture.service.listItems()).items[0].status, 'waiting_condition');
});

test('a cancelled PR predecessor stays unchanged without rejecting unrelated intake', async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  await fixture.service.cancelGraphTask({
    itemId: root.itemId, expectedRevision: root.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    actorId: 'employee-orchestrator', reason: 'owner-took-manual-repair',
  });
  const cancelled = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(prAssignment(2, {
    sourceScopeId: 'github-secondary', occurredAt: '2026-08-02T01:05:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A),
  }), issueAssignment(3));
  fixture.source.highWatermark = 3;
  const intake = await fixture.service.intake();
  assert.equal(intake.error, undefined);
  assert.equal(intake.cursor, 3);
  const items = (await fixture.service.listItems()).items;
  assert.deepEqual(items.find(item => item.itemId === root.itemId), cancelled);
  const pending = items.find(item => item.source?.identity?.scopeId === 'github-secondary');
  assert.equal(pending.status, 'blocked');
  assert.equal(items.find(item => item.event.subject.id.startsWith('github:issue:')).status, 'queued');
  const result = await fixture.service.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pending.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedPendingRevision: pending.source.activeRevision,
  });
  assert.equal(result.applied, false);
  assert.equal(result.blockers[0].itemId, root.itemId);
  assert.equal(result.blockers[0].status, 'cancelled');
  fixture.source.records.push(prAssignment(4, {
    occurredAt: '2026-08-02T01:10:00.000Z', gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;
  assert.equal((await fixture.service.intake()).error, undefined);
  assert.deepEqual((await fixture.service.listItems()).items.find(item => item.itemId === root.itemId), cancelled);
  fixture.source.records.push(prScopeLifecycleAssignment(5, prAssignment(5, {
    eventType: 'pull_request.left_scope', occurredAt: '2026-08-02T01:15:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event));
  fixture.source.highWatermark = 5;
  assert.equal((await fixture.service.intake()).error, undefined);
  assert.deepEqual((await fixture.service.listItems()).items.find(item => item.itemId === root.itemId), cancelled);
});

for (const recoveredPending of [false, true]) {
  test(`a fresh owner PR request can replace a cancelled task without rewriting it (${recoveredPending ? "recovered pending" : "new intake"})`, async () => {
    const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
    await fixture.service.intake();
    const original = (await fixture.service.listItems()).items[0];
    await fixture.service.cancelGraphTask({
      itemId: original.itemId, expectedRevision: original.revision,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      actorId: "employee-orchestrator", reason: "owner-repaired-this-round",
    });
    const cancelled = (await fixture.service.listItems()).items[0];
    const request = ownerRequestedPrAssignment(2, {
      occurredAt: "2026-08-02T02:10:00.000Z", headRefOid: PR_HEAD_B,
      gitFacts: prGitFacts(PR_HEAD_B),
    });
    request.assignment.target = { type: "role", id: "developer" };
    fixture.source.records.push(request);
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    let active = (await fixture.service.listItems()).items.find(item => item.itemId !== cancelled.itemId);
    let service = fixture.service;
    if (recoveredPending) {
      // The deployed predecessor version has already stored this request as blocked.
      await service.transition({
        itemId: active.itemId, expectedRevision: active.revision, leaseId: null,
        actorId: "work-ledger-system", toStatus: "blocked",
        reason: `pr_source_cross_root_cutover_pending:${cancelled.itemId}`,
      });
      service = new WorkLedgerService({
        store: fixture.store, assignmentSource: fixture.source,
        exclusiveLease: new ExclusiveLease(), clock: fixture.time.clock, idFactory: incrementingIds(),
      });
      await service.recover();
      active = (await service.listItems()).items.find(item => item.itemId === active.itemId);
      const result = await service.reconcilePullRequestSource({
        itemId: active.itemId, expectedRevision: active.revision,
        expectedGraphRevision: (await service.getSummary()).revision,
        expectedPendingRevision: active.source.activeRevision,
      });
      assert.equal(result.applied, true);
      active = (await service.listItems()).items.find(item => item.itemId === active.itemId);
    }
    assert.equal(active.status, "queued");
    assert.equal(active.currentTarget.id, "developer");
    assert.equal(active.source.current.headRefOid, PR_HEAD_B);
    assert.deepEqual((await service.listItems()).items.find(item => item.itemId === cancelled.itemId), cancelled);
    const binding = prExecutionBinding(active);
    assert.deepEqual(await service.verifyPullRequestExecutionBinding(binding), binding);
    const claimed = await service.claim({
      itemId: active.itemId, expectedRevision: active.revision,
      workerId: "employee-developer", leaseDurationMs: 30_000,
    });
    assert.equal(claimed.status, "working");
    assert.equal(claimed.source.current.headRefOid, PR_HEAD_B);
  });
}

test("an owner request predating cancellation cannot reopen cancelled PR work", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const original = (await fixture.service.listItems()).items[0];
  await fixture.service.cancelGraphTask({
    itemId: original.itemId, expectedRevision: original.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    actorId: "employee-orchestrator", reason: "owner-repaired-this-round",
  });
  const cancelled = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const pending = (await fixture.service.listItems()).items.find(item => item.itemId !== cancelled.itemId);
  assert.equal(pending.status, "blocked");
  const result = await fixture.service.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pending.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedPendingRevision: pending.source.activeRevision,
  });
  assert.equal(result.applied, false);
  assert.equal(result.blockers[0].status, "cancelled");
  assert.deepEqual((await fixture.service.listItems()).items.find(item => item.itemId === cancelled.itemId), cancelled);
});

test('real ledger settles a pause after model failure, restores the same item, and cancels safely',async()=>{
  const {service}=await createFixture({records:[issueAssignment(1)]});
  await service.intake();
  const item=(await service.listItems()).items[0];
  let claimed=await service.claim({itemId:item.itemId,expectedRevision:item.revision,workerId:'employee-pr-reviewer',leaseDurationMs:60000});
  let saved=null;
  const registry=new TaskRunRegistry({store:{read:async(_k,f)=>saved??f,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:createTaskRunSettler({ledger:service})});
  const task=()=>({kind:'work-item',taskId:claimed.itemId,roleId:'pr-reviewer',title:'Check',subject:'Issue',revision:claimed.revision,leaseId:claimed.leaseId});
  const entered=deferred(), gate=deferred();
  const execution=registry.run(task(),async()=>{entered.resolve();await gate.promise;throw new Error('model process failed');});
  const rejected=assert.rejects(execution,e=>e.code==='TASK_RUN_PAUSED');await entered.promise;
  let view=await registry.get('work-item',claimed.itemId);
  await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});gate.resolve();await rejected;
  assert.equal((await service.readItemForReconciliation({itemId:item.itemId})).status,'paused');
  view=await registry.get(view.kind,view.taskId);
  await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'resume'});
  const resumed=await service.readItemForReconciliation({itemId:item.itemId});assert.equal(resumed.status,'queued');assert.equal(resumed.attempt,0);
  claimed=await service.claim({itemId:item.itemId,expectedRevision:resumed.revision,workerId:'employee-pr-reviewer',leaseDurationMs:60000});
  const started=deferred(), finish=deferred();
  const cancelled=registry.run(task(),async()=>{started.resolve();await finish.promise;});
  const cancelRejection=assert.rejects(cancelled,e=>e.code==='TASK_RUN_CANCELLED');await started.promise;
  view=await registry.get('work-item',item.itemId);
  await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'cancel'});finish.resolve();await cancelRejection;
  assert.equal((await service.readItemForReconciliation({itemId:item.itemId})).status,'cancelled');
});
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { normalizeAttentionRequest } from "../src/domain/attention-contract.js";
import {
  createAttentionItem,
  resolveAttentionItem,
} from "../src/services/attention-inbox-state.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
  workProposalDigest,
} from "../src/domain/work-proposal-contract.js";
import {
  createDeliveryEvidenceTarget,
} from "../src/domain/delivery-evidence-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerIssueEvent } from "../src/domain/owner-work-request.js";
import { createWorkIntentDispatchBinding } from "../src/domain/work-intent-dispatch-binding.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import {
  createPullRequestExecutionBinding,
} from "../src/domain/pull-request-execution-binding.js";
import {
  PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
  PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
  PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
  PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
} from "../src/domain/pull-request-scope-lifecycle.js";
import {
  AUTHORED_PR_APPROVED_RULE_ID,
  AUTHORED_PR_SELF_FIX_RULE_ID,
  REVIEWED_PR_APPROVED_RULE_ID,
} from "../src/domain/pr-lifecycle-routing.js";
import {
  createWorkGraphAuthorityObservationEvent,
  createWorkGraphSourceAuthority,
  createLegacyWorkGraphMemoryEvent,
  workGraphMemoryRecordReceipt,
} from "../src/domain/work-graph-memory-event.js";
import { createMemoryRuntime } from "../src/memory-runtime.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";
import { AttentionInbox } from "../src/services/attention-inbox.js";
import { MemoryAnswerService } from "../src/services/memory-answer-service.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";
import { MemoryProjector } from "../src/services/memory-projector.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { createCodeJobGrant, CODE_JOB_ACTIONS_BY_OPERATION } from "../src/domain/code-job-contract.js";
import { createCodeActionProposalConfirmationPlan } from "../src/domain/code-action-proposal-confirmation.js";
import { normalizeConfirmationPlan, normalizeConfirmationState } from "../src/domain/confirmation-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { reviewDiagnosticState } from "../src/services/work-ledger-review-diagnostic.js";
import { isChangedReviewConfirmationDecision, reviewConfirmationSettlementIds } from "../src/services/work-ledger-review-confirmation-settlement.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobApprovalExecutor } from "../src/services/code-job-approval-executor.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ObsoleteCodeJobSettler, hasUnstartedCodeJobAuthorityFence, hasSettledCodeJobAuthorityFence, hasStoppedCodeJobAuthorityFence, hasUnstartedCodeJobPreparationFailure } from "../src/services/obsolete-code-job-settler.js";
import { AutomaticOwnPrConflictRecovery } from '../src/services/automatic-own-pr-conflict-recovery.js';
import { FailedCodeJobContextReader } from '../src/services/failed-code-job-context-reader.js';
import { createConflictPreparationBinding } from '../src/domain/conflict-preparation-binding.js';
import { createConflictCodeExecutionSource } from '../src/domain/code-execution-source.js';
import {
  createLocalWorkLedgerCandidateProcessor,
  createWorkerWorkLedgerCandidateProcessor,
} from
  "../src/services/work-ledger-candidate-processor.js";
import {
  createWorkDecisionContext,
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
  normalizeWorkLedgerPersistedState,
  WORK_LEDGER_STATE_SCHEMA_VERSION,
} from "../src/services/work-ledger-state.js";
import { ledgerDigest } from "../src/services/work-ledger-values.js";
import { pullRequestDecisionAttemptBudget, canRecoverPullRequestDecisionBudget, persistedPullRequestDecisionAttemptBudget } from "../src/services/work-ledger-pr-source.js";
import { validateWorkLedgerGraphTransition } from "../src/services/work-ledger-graph.js";
import {
  migrateWorkGraphMemoryProjection,
  appendWorkGraphMemoryEvents,
  acknowledgeWorkGraphMemoryProjectionBatch,
} from "../src/services/work-ledger-graph-memory.js";
import {
  appendPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  normalizePullRequestWorkSource,
  pullRequestHeadAdmission,
  pullRequestTrustedPredecessor,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "../src/services/work-ledger-pr-source.js";
import {
  crossRootPullRequestCutoverBlockerReason,
  crossRootPullRequestCutoverCandidate,
  createPullRequestCutoverTimelineIndex,
  inspectPullRequestSourceCutover,
} from "../src/services/work-ledger-pr-cutover-commands.js";
import { createRevokedCodeConfirmationSettlement } from "../src/services/work-ledger-code-confirmation-settlement.js";
import {
  appendWorkLedgerTimeline,
  createAssignmentWorkItem,
  createGraphChildWorkItem,
  createPullRequestSourceRootWorkItem,
  createWorkIntentRecord,
} from "../src/services/work-ledger-records.js";

const STATE_KEY = "work-ledger-state";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

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

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([key, value]) => [key, clone(value)]),
    );
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? clone(this.values.get(name)) : clone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copied = clone(value);
    this.values.set(name, copied);
    this.writes.push({ name, value: copied });
  }

  failNextWrite(error = new Error("durable write unavailable")) {
    this.nextWriteError = error;
  }

  stored(name = STATE_KEY) {
    return clone(this.values.get(name));
  }

  replaceStored(value, name = STATE_KEY) {
    this.values.set(name, clone(value));
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

class FakeAssignmentSource {
  constructor(records = []) {
    this.records = records.map(clone);
    this.calls = [];
    this.oldestAvailableSequence = records.length ? records[0].sequence : 1;
    this.highWatermark = records.length ? records.at(-1).sequence : 0;
    this.override = null;
  }

  async readAssignmentBatch(request) {
    this.calls.push(clone(request));
    if (this.override) return this.override(request);
    const items = this.records
      .filter(({ sequence }) => sequence > request.afterSequence)
      .slice(0, request.limit);
    return clone({
      items,
      nextSequence: items.at(-1)?.sequence ?? request.afterSequence,
      highWatermark: this.highWatermark,
      oldestAvailableSequence: this.oldestAvailableSequence,
    });
  }
}

function assignment(sequence, target = { type: "role", id: "pr-reviewer" }) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: `workflow-event-${sequence}`,
      target,
      reason: `route-${sequence}`,
      createdAt: "2026-08-02T01:00:00.000Z",
    },
    event: {
      schemaVersion: 1,
      eventId: `workflow-event-${sequence}`,
      eventType: sequence % 2 ? "pull_request.created" : "issue.created",
      occurredAt: "2026-08-02T01:00:00.000Z",
      subject: { id: `subject-${sequence}` },
      payload: { number: sequence, title: `Work ${sequence}` },
    },
  };
}

function issueAssignment(
  sequence,
  {
    eventType = "issue.updated",
    occurredAt = "2026-08-02T01:00:00.000Z",
    repository = "acme/product",
    issueNumber = 42,
    state = "open",
  } = {},
) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType,
    occurredAt,
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: `github:issue:${repository}#${issueNumber}`,
      repository,
      number: issueNumber,
    },
    payload: {
      title: `Issue ${issueNumber}`,
      state,
      updatedAt: occurredAt,
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-issue-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "requirements-analyst" },
      reason: "issue-events-to-requirements",
      createdAt: occurredAt,
    },
    event,
  };
}

class ContentVersionMemoryStore extends MemoryStore {
  constructor(entries = {}) {
    super(entries);
    this.versions = new Map();
    this.versionedValueReads = 0;
  }

  async readVersioned(name, fallback = null, { ifVersion } = {}) {
    const version = this.#versionFor(name);
    if (ifVersion === version) return { changed: false, version };
    this.versionedValueReads += 1;
    return {
      changed: true,
      version,
      value: await super.read(name, fallback),
    };
  }

  async write(name, value) {
    await super.write(name, value);
    return this.#replaceVersion(name);
  }

  replaceStored(value, name = STATE_KEY) {
    super.replaceStored(value, name);
    this.#replaceVersion(name);
  }

  #versionFor(name) {
    if (!this.versions.has(name)) this.#replaceVersion(name);
    return this.versions.get(name);
  }

  #replaceVersion(name) {
    const version = Object.freeze({});
    this.versions.set(name, version);
    return version;
  }
}

function ownerRequestedIssueAssignment(sequence, issueNumber) {
  const occurredAt = `2026-08-02T01:${String(sequence).padStart(2, "0")}:00.000Z`;
  const event = createOwnerIssueEvent({
    schemaVersion: 6,
    requestId:
      `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workType: "requirements",
    priority: "high",
    title: `Owner Issue ${issueNumber}`,
    description: "Keep this manually selected Issue in daily work.",
    acceptanceCriteria: ["Preserve the selected Issue independently"],
    issue: { repository: "acme/product", number: issueNumber },
  }, occurredAt);
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-owner-issue-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "requirements-analyst" },
      reason: "owner-issue-to-requirements",
      createdAt: occurredAt,
    },
    event,
  };
}

function persistLegacyIssueLifecycleAssignment(fixture, record) {
  const durable = fixture.store.stored();
  const createdAt = record.event.occurredAt;
  const item = createAssignmentWorkItem(record, createdAt);
  const appended = appendWorkLedgerTimeline(
    durable,
    [{
      itemId: item.itemId,
      type: "assignment_intaken",
      at: createdAt,
      actorId: "work-ledger-system",
      details: {
        assignmentId: item.assignmentId,
        sourceSequence: item.sourceSequence,
      },
    }],
    normalizeWorkLedgerLimits().timelineLimit,
  );
  durable.revision += 1;
  durable.intakeCursor = record.sequence;
  durable.sourceHighWatermark = record.sequence;
  durable.items.push(item);
  durable.timeline = appended.timeline;
  durable.timelineStartSequence = appended.timelineStartSequence;
  durable.nextTimelineSequence = appended.nextTimelineSequence;
  durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
    durable.items,
    durable.revision,
    normalizeWorkLedgerLimits(),
  );
  fixture.store.replaceStored(durable);
  return item;
}

const PR_HEAD_A = "a".repeat(40);
const PR_HEAD_B = "b".repeat(40);
const PR_HEAD_C = "c".repeat(40);

test("automatic Review admission is recovered from verified durable PR roots and rejects stale bindings", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { ciStatus: "FAILURE", author: "developer",
    gitFacts: { ...prGitFacts(PR_HEAD_A), relation: "review_requested", reviewRequestEventId: "AE_42",
      reviewReceivedAt: "2026-08-02T01:00:00Z" } })] });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const binding = prExecutionBinding(root);
  const result = await fixture.service.readAutomaticReviewAdmission(binding);
  assert.deepEqual(result.inputBinding, binding);
  assert.deepEqual(result.admission, { kind: "assigned", admittedAt: root.createdAt,
    reviewRequestEventId: "AE_42", reviewReceivedAt: "2026-08-02T01:00:00Z" });
  fixture.time.advance(48 * 60 * 60 * 1000);
  const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  assert.deepEqual(await restarted.service.readAutomaticReviewAdmission(binding), result);
  await assert.rejects(restarted.service.readAutomaticReviewAdmission({ ...binding, headRefOid: PR_HEAD_B,
    gitTarget: { ...binding.gitTarget, headRefOid: PR_HEAD_B } }),
    { code: "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" });
});

function prGitFacts(headRefOid, overrides = {}) {
  return {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid,
      ...overrides,
    },
  };
}

function prAssignment(
  sequence,
  {
    eventType = "pull_request.updated",
    occurredAt = "2026-08-02T01:00:00.000Z",
    headRefOid = PR_HEAD_A,
    previousHeadRefOid,
    changedFields = ["ciStatus"],
    ciStatus = "PENDING",
    author,
    title = "PR 42",
    repository = "acme/repo",
    pullRequestNumber = 42,
    sourceScopeId = "github-dashboard",
    sourceProvider = "github",
    gitFacts = {},
  } = {},
) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType,
    occurredAt,
    source: { provider: sourceProvider, scopeId: sourceScopeId },
    subject: {
      id: `github:pr:${repository}#${pullRequestNumber}`,
      repository,
      number: pullRequestNumber,
    },
    payload: {
      title,
      headRefOid,
      ciStatus,
      ...(author === undefined ? {} : { author }),
      changedFields,
      ...gitFacts,
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
      createdAt: occurredAt,
    },
    event,
  };
}

function ownerRequestedPrAssignment(sequence, overrides = {}) {
  return prAssignment(sequence, {
    eventType: "pull_request.owner_requested",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceProvider: "local-owner",
    sourceScopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000",
    gitFacts: prGitFacts(PR_HEAD_A),
    ...overrides,
  });
}

function prScopeLifecycleAssignment(sequence, event) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-scope-${sequence}`,
      eventId: event.eventId,
      eventType: event.eventType,
      subject: clone(event.subject),
      configVersion: 1,
      configDigest: "1".repeat(64),
      ruleId: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
      target: PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
      priority: PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
      reason: PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
      createdAt: event.occurredAt,
    },
    event: clone(event),
  };
}

function prGraphChildCommand(parent, graphRevision, childKey = "resolve-conflict") {
  return {
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: parent.itemId,
    },
    command: {
      parentTaskId: parent.itemId,
      childKey,
      work: {
        title: "解决 PR 冲突",
        description: "在绑定的 PR Head 上生成并验证冲突修复。",
      },
      target: { type: "role", id: "developer" },
      dependsOnTaskIds: [],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      leaseId: null,
      expectedGraphRevision: graphRevision,
      expectedTaskRevisions: [{
        taskId: parent.itemId,
        revision: parent.revision,
      }],
    },
  };
}

function prExecutionBinding(item) {
  return createPullRequestExecutionBinding({
    sourceBinding: currentWorkItemInputBinding(item),
    event: currentWorkItemEvent(item),
  });
}

function controlledClock(initial = "2026-08-02T02:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now).toISOString(),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function incrementingIds() {
  let next = 1;
  return () => `lease-${String(next++).padStart(4, "0")}`;
}

async function createFixture({
  records = [],
  source = new FakeAssignmentSource(records),
  store = new MemoryStore(),
  lease = new ExclusiveLease(),
  time = controlledClock(),
  limits,
  actionAdmissionGate,
  postCommitYield,
  candidateProcessor,
  confirmationSettlementReader,
  hostContextRecoveryReader,
} = {}) {
  const service = new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock: time.clock,
    idFactory: incrementingIds(),
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
    ...(limits ? { limits } : {}),
    ...(postCommitYield === undefined ? {} : { postCommitYield }),
    ...(candidateProcessor === undefined ? {} : { candidateProcessor }),
    ...(confirmationSettlementReader === undefined ? {} : { confirmationSettlementReader }),
    ...(hostContextRecoveryReader === undefined ? {} : { hostContextRecoveryReader }),
  });
  await service.recover();
  return { service, source, store, lease, time };
}

test("an orchestrator parent can create a child once its scheduled retry is due", async () => {
  const record = ownerRequestedPrAssignment(1);
  record.assignment.target = { type: "role", id: "orchestrator" };
  const f = await createFixture({ records: [record] });
  await f.service.intake();
  let parent = (await f.service.listItems()).items[0];
  parent = await f.service.claim({ itemId: parent.itemId, expectedRevision: parent.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 });
  await f.service.scheduleRetry({ itemId: parent.itemId, expectedRevision: parent.revision,
    leaseId: parent.leaseId, actorId: "employee-orchestrator", reason: "system_maintenance_auto_retry",
    availableAt: new Date(Date.parse(f.time.clock()) + 1000).toISOString() });
  parent = (await f.service.listItems()).items[0];
  const before = f.store.stored();
  await assert.rejects(f.service.createGraphChild(prGraphChildCommand(parent, (await f.service.getSummary()).revision)),
    { code: "WORK_LEDGER_GRAPH_PARENT_CONFLICT" });
  assert.deepEqual(f.store.stored(), before, "early retries must not mutate the graph");
  f.time.advance(1000);
  const created = await f.service.createGraphChild(prGraphChildCommand(parent, (await f.service.getSummary()).revision));
  const child = (await f.service.listItems()).items.find(item => item.itemId === created.taskId);
  assert.equal(child.graph.parentItemId, parent.itemId);
  assert.equal(child.currentTarget.id, "developer");
});

test("automatic Review lookup binds the existing root and survives a same-target metadata refresh", async () => {
  const facts = { ...prGitFacts(PR_HEAD_A), relation: "review_requested", state: "open", isDraft: false,
    author: "contributor", assignees: ["runtime-user", "contributor"] };
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: facts })] });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const query = { repository: "acme/repo", number: 42, headRefOid: PR_HEAD_A, gitTarget: facts.gitTarget };
  const binding = currentWorkItemExecutionBinding(root);
  assert.deepEqual(await fixture.service.readCurrentAutomaticReviewWork(query), { workItemId: root.itemId });
  fixture.source.records.push(prAssignment(2, { occurredAt: "2026-08-02T01:01:00.000Z",
    changedFields: ["assignees"], gitFacts: { ...facts, assignees: ["runtime-user"] } }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  assert.deepEqual(await fixture.service.readCurrentAutomaticReviewWork(query), { workItemId: root.itemId });
  assert.deepEqual(await fixture.service.verifyPullRequestExecutionBinding(binding), binding);
  const items = (await fixture.service.listItems()).items;
  assert.equal(items.length, 1, "no competing owner source is needed");
  const claimed = await fixture.service.claim({ itemId: root.itemId, expectedRevision: items[0].revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30000 });
  assert.equal(claimed.status, "working");
  assert.deepEqual(await fixture.service.readCurrentAutomaticReviewWork(query), { workItemId: root.itemId });
});

test("automatic Review lookup rejects changed targets, revoked ownership and already reviewed work", async () => {
  for (const change of ["base", "head", "account", "repository", "number", "base-ref", "head-ref", "fork",
    "unassigned", "self", "published", "closed", "legacy"]) {
    const facts = { ...prGitFacts(PR_HEAD_A), relation: "review_requested", state: "open", isDraft: false,
      author: "contributor", assignees: ["runtime-user"] };
    if (change === "unassigned") facts.assignees = ["contributor"];
    if (change === "self") facts.author = "runtime-user";
    if (change === "published") { facts.myReviewState = "APPROVED"; facts.myReviewCommitOid = PR_HEAD_A; }
    if (change === "closed") facts.state = "closed";
    const sourceFacts = structuredClone(facts);
    if (change === "legacy") { delete sourceFacts.gitTarget; delete sourceFacts.gitTargetAvailable; }
    const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: sourceFacts })] });
    await fixture.service.intake();
    const query = { repository: "acme/repo", number: 42, headRefOid: PR_HEAD_A, gitTarget: structuredClone(facts.gitTarget) };
    if (change === "base") query.gitTarget.baseRefOid = "e".repeat(40);
    if (change === "head") { query.headRefOid = PR_HEAD_B; query.gitTarget.headRefOid = PR_HEAD_B; }
    if (change === "account") query.gitTarget.sourceAccountId = "another-user";
    if (change === "base-ref") query.gitTarget.baseRefName = "release";
    if (change === "head-ref") query.gitTarget.headRefName = "other-feature";
    if (change === "fork") query.gitTarget.headRepository = "other/repo";
    if (change === "repository") { query.repository = "acme/other"; query.gitTarget.baseRepository = "acme/other"; }
    if (change === "number") query.number = 43;
    assert.equal(await fixture.service.readCurrentAutomaticReviewWork(query), null, change);
  }
});

test("committed context authority stays readable while candidate validation holds the writer lease", async () => {
  const entered = deferred(), release = deferred();
  let hold = false;
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })], store: new ContentVersionMemoryStore(),
    candidateProcessor: {
      async prepare(input) { if (hold) { entered.resolve(); await release.promise; } return prepareWorkLedgerCandidate(input); },
      async commit() {}, async discard() {},
    },
  });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const binding = prExecutionBinding(root);
  hold = true;
  fixture.source.records.push(prAssignment(2, { pullRequestNumber: 43 }));
  fixture.source.highWatermark = 2;
  const write = fixture.service.intake();
  await entered.promise;
  try {
    const blocked = Symbol('writer blocked readers');
    const result = await Promise.race([
      Promise.all([fixture.service.getGraphSnapshot(), fixture.service.readItemForReconciliation({ itemId: root.itemId }),
        fixture.service.verifyPullRequestExecutionBinding(binding), fixture.service.readAutomaticReviewAdmission(binding),
        fixture.service.readPullRequestExecutionContext(binding), fixture.service.readReviewAdoptionContext({ itemId: root.itemId })]),
      new Promise(resolve => setImmediate(() => resolve(blocked))),
    ]);
    assert.notEqual(result, blocked, 'reading committed context must not wait for an unrelated uncommitted candidate');
    assert.equal(result[0].graph.tasks.length, 1);
    assert.deepEqual(result[1], root);
    assert.deepEqual(result[2], binding);
    assert.deepEqual(result[3].inputBinding, binding);
    assert.deepEqual(result[4].inputBinding, binding);
    assert.deepEqual(result[5], { item: root, root, activeDispatch: null });
    result[1].status = 'cancelled';
    assert.equal((await fixture.service.readItemForReconciliation({ itemId: root.itemId })).status, root.status);
  } finally { release.resolve(); await write; }
  assert.equal((await fixture.service.getGraphSnapshot()).graph.tasks.length, 2);
});

test("Review adoption reads the committed task and sealed dispatch together without refreshing writer state", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })], store: new ContentVersionMemoryStore() });
  await fixture.service.intake();
  const original = (await fixture.service.listItems()).items[0];
  const other = await createFixture({ source: fixture.source, store: fixture.store });
  const item = await other.service.claim({ itemId: original.itemId, expectedRevision: original.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  const staged = await other.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision,
    leaseId: item.leaseId, actorId: "employee-pr-engineer", roleId: "pr-engineer", intent: reviewIntent() });
  const claimed = await other.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  const sealed = await other.service.bindIntent({ intentId: claimed.intentId, expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision, dispatcherId: claimed.dispatcherId, dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, { requestedBy: { roleId: "pr-engineer", workItemId: item.itemId },
      binding: { repository: "acme/repo", pullRequestNumber: 42 } }) });
  assert.deepEqual((await fixture.service.listOutbox()).items, [], "the reader's writer state is deliberately stale");
  const context = await fixture.service.readReviewAdoptionContext({ itemId: item.itemId });
  assert.equal(context.item.activeIntentId, sealed.intentId);
  assert.deepEqual(context.root, context.item);
  const storedDispatch = fixture.store.stored().outbox.find(row => row.intentId === sealed.intentId);
  assert.deepEqual(context.activeDispatch, storedDispatch);
  context.activeDispatch.dispatchBinding.bindingDigest = "0".repeat(64);
  assert.deepEqual((await fixture.service.readReviewAdoptionContext({ itemId: item.itemId })).activeDispatch, storedDispatch);
  assert.deepEqual((await fixture.service.listOutbox()).items, [], "a context read must not advance writer bookkeeping");
  assert.equal(await fixture.service.readReviewAdoptionContext({ itemId: "missing-item" }), null);
  await assert.rejects(fixture.service.readReviewAdoptionContext({ itemId: item.itemId, extra: true }), { code: "WORK_LEDGER_QUERY_INVALID" });
});

test("a version observed by a context read also fences later mutations against durable rollback", async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: [assignment(1)], store });
  await fixture.service.intake();
  const previous = store.stored();
  const item = (await fixture.service.listItems()).items[0];
  const other = await createFixture({ source: fixture.source, store });
  fixture.source.records.push(assignment(2));
  fixture.source.highWatermark = 2;
  await other.service.intake();
  assert.equal((await fixture.service.getGraphSnapshot()).graph.tasks.length, 2);
  store.replaceStored(previous);
  const writes = store.writes.length;
  await assert.rejects(fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: 'employee-pr-reviewer', leaseDurationMs: 30_000 }), { code: 'WORK_LEDGER_STATE_REVISION_CONFLICT' });
  assert.equal(store.writes.length, writes);
});

for (const variant of ['older', 'fork']) {
test(`committed authority reads preserve the latest cache against a late ${variant} snapshot`, async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: [assignment(1)], store });
  await fixture.service.intake();
  const other = await createFixture({ source: fixture.source, store });
  fixture.source.records.push(assignment(2)); fixture.source.highWatermark = 2;
  await other.service.intake();
  const captured = await store.readVersioned(STATE_KEY);
  const entered = deferred(), release = deferred();
  const readVersioned = store.readVersioned.bind(store);
  let intercept = true;
  store.readVersioned = (...args) => {
    if (!intercept) return readVersioned(...args);
    intercept = false; entered.resolve(); return release.promise;
  };
  const slow = fixture.service.getGraphSnapshot();
  await entered.promise;
  if (variant === 'fork') {
    const fork = store.stored(); fork.items[0].statusReason = 'valid-but-forked'; store.replaceStored(fork);
  } else {
    fixture.source.records.push(assignment(3)); fixture.source.highWatermark = 3;
    await other.service.intake();
  }
  const latest = await fixture.service.getGraphSnapshot();
  if (variant === 'fork') {
    const rejected = assert.rejects(slow, { code: 'WORK_LEDGER_STATE_REVISION_CONFLICT' });
    release.resolve(captured); await rejected;
  } else {
    release.resolve(captured);
    assert.equal((await slow).graph.tasks.length, 2);
  }
  assert.equal(await fixture.service.getGraphSnapshot(), latest, 'a late result must not evict the latest validated graph');
});
}

for (const variant of ['changed', 'unchanged', 'missing']) {
test(`a late ${variant} writer read cannot lower the context-observed authority revision`, async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: variant === 'missing' ? [] : [assignment(1)], store });
  if (variant !== 'missing') await fixture.service.intake();
  const captured = await store.readVersioned(STATE_KEY);
  const entered = deferred(), release = deferred();
  const readVersioned = store.readVersioned.bind(store);
  let intercept = true;
  store.readVersioned = (...args) => {
    if (!intercept) return readVersioned(...args);
    intercept = false; entered.resolve(); return release.promise;
  };
  const writer = fixture.service.verifyPullRequestExecutionBindings({ ledgerRevision: captured.value?.revision ?? 0, bindings: [] });
  await entered.promise;
  const other = await createFixture({ source: fixture.source, store });
  fixture.source.records.push(assignment(variant === 'missing' ? 1 : 2));
  fixture.source.highWatermark = variant === 'missing' ? 1 : 2;
  await other.service.intake();
  const latest = await fixture.service.getGraphSnapshot();
  const code = variant === 'missing' ? 'WORK_LEDGER_STATE_CORRUPTED' : 'WORK_LEDGER_STATE_REVISION_CONFLICT';
  const rejected = assert.rejects(writer, { code });
  release.resolve(variant === 'unchanged' ? { changed: false, version: captured.version } : captured);
  await rejected;
  assert.equal(await fixture.service.getGraphSnapshot(), latest);
});
}

test('concurrent committed authority reads reuse validation of the same returned content version', async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: [assignment(1)], store });
  await fixture.service.intake();
  const other = await createFixture({ source: fixture.source, store });
  fixture.source.records.push(assignment(2)); fixture.source.highWatermark = 2;
  await other.service.intake();
  const result = await Promise.all(Array.from({ length: 3 }, () => fixture.service.getGraphSnapshot()));
  assert.equal(result[0].graph.tasks.length, 2);
  assert.ok(result.every(snapshot => snapshot === result[0]));
});

test("already expired graph contexts skip durable reads and leave the next live read available", async () => {
  const fixture = await createFixture();
  let reads = 0;
  const originalRead = fixture.store.read.bind(fixture.store);
  fixture.store.read = async (...args) => { reads++; return originalRead(...args); };
  const controller = new AbortController();
  const reason = new Error("role context already expired");
  controller.abort(reason);
  const cancelled = Array.from({ length: 5 }, () => fixture.service.getGraphSnapshot({ signal: controller.signal }));
  const outcomes = Promise.allSettled(cancelled);
  const results = await outcomes;
  assert.ok(results.every(result => result.status === "rejected" && result.reason === reason));
  assert.equal(reads, 0, "expired contexts must not start another durable read");
  assert.ok((await fixture.service.getGraphSnapshot()).graph);
  assert.equal(reads, 1);
});

test("graph cancellation is rechecked after an in-flight committed read", async (t) => {
  await t.test("read in flight", async () => {
    const fixture = await createFixture();
    const entered = deferred(), release = deferred();
    const originalRead = fixture.store.read.bind(fixture.store);
    const cache = fixture.service.graphSnapshotCache;
    fixture.store.read = async (...args) => { entered.resolve(); await release.promise; return originalRead(...args); };
    const controller = new AbortController(), reason = new Error("expired during durable read");
    const result = fixture.service.getGraphSnapshot({ signal: controller.signal });
    const rejected = assert.rejects(result, error => error === reason);
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    await rejected;
    assert.equal(fixture.service.graphSnapshotCache, cache);
  });
});

test("task timeline filtering preserves an older recovery record amid unrelated activity", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const original = (await fixture.service.listTimeline()).items.find((entry) => entry.itemId === item.itemId);
  fixture.source.records.push(...Array.from({ length: 105 }, (_, index) => assignment(index + 2)));
  fixture.source.highWatermark = 106;
  await fixture.service.intake({ limit: 100 });
  await fixture.service.intake({ limit: 100 });
  assert.equal((await fixture.service.listTimeline({ limit: 100, order: "newest" })).items
    .some((entry) => entry.itemId === item.itemId), false);
  const scoped = await fixture.service.listTimeline({ itemId: item.itemId, limit: 1, order: "newest" });
  assert.deepEqual(scoped.items, [original]);
  assert.equal(scoped.nextCursor, null);
  await assert.rejects(fixture.service.listTimeline({ itemId: "" }));
  await assert.rejects(fixture.service.listTimeline({ itemId: item.itemId, unsupported: true }));
});

async function createLedgerMemoryPipeline(service, options = {}) {
  const store = options.store ?? new MemoryStore();
  const journal = new LocalMemoryJournal({
    store,
    exclusiveLease: new ExclusiveLease(),
    ...(options.maximumRecords === undefined
      ? {}
      : { maximumRecords: options.maximumRecords }),
  });
  await journal.recover();
  const projector = new MemoryProjector({
    memoryProducer: journal,
    memoryLifecycleProducer: journal,
    memoryAuthorityReader: journal,
    memoryAuthoritySource: {
      readSnapshot: (request) => service.readMemoryAuthoritySnapshot(request),
    },
    graphProjectionSource: {
      ackBatch: (request) =>
        service.acknowledgeGraphMemoryProjectionBatch(request),
    },
    store,
  });
  return { store, journal, projector };
}

async function restartMemoryRuntime(service, store) {
  return createMemoryRuntime({
    store,
    authoritySource: {
      readStatus: () => service.readMemoryAuthorityStatus(),
    },
    createGuard: () => ({
      async acquire() {},
      async run(operation) { return operation(); },
      async close() {},
    }),
  });
}

async function restartStandaloneMemoryRuntime(store) {
  return createMemoryRuntime({
    store,
    createGuard: () => ({
      async acquire() {},
      async run(operation) { return operation(); },
      async close() {},
    }),
  });
}

function memoryAnswerForRuntime(runtime, generateCalls) {
  const brain = {
    provider: "local-test",
    model: "authority-test",
    remoteData: { requirements: false, code: false, memory: false },
  };
  return new MemoryAnswerService({
    contextRetriever: new MemoryContextRetriever({
      memorySearch: { search: runtime.search.search },
      contextReader: runtime.contextReader,
    }),
    brainRouter: {
      describe(value) {
        return {
          provider: value.provider,
          model: value.model,
          remote: false,
          remoteData: structuredClone(value.remoteData),
        };
      },
      async generate() {
        generateCalls.push("generate");
        return JSON.stringify({
          schemaVersion: 1,
          status: "insufficient_evidence",
          claims: [],
        });
      },
    },
    configuredBrain: brain,
    localBrain: brain,
  });
}

function ordinaryMemoryFact(index) {
  return {
    schemaVersion: 1,
    source: { kind: "local-session", id: `capacity-fill-${index}` },
    occurredAt: "2026-08-02T03:00:00.000Z",
    roleId: null,
    repository: null,
    eventType: "memory.capacity_fixture",
    title: `Capacity filler ${index}`,
    summary: "Ordinary memory must not overtake authority lifecycle.",
    content: "local filler",
    evidence: [],
    tags: ["capacity"],
    sourceUrl: null,
    subjectNumber: null,
  };
}

function legacySingleEventProjection(state, item, kind, graphRecord) {
  const event = createLegacyWorkGraphMemoryEvent({
    sequence: 1,
    previousDigest: null,
    ledgerRevision: state.revision,
    taskRevision: item.revision,
    item,
    kind,
    record: graphRecord,
  });
  return {
    revision: state.revision,
    nextSequence: 2,
    cursor: 0,
    checkpointDigest: null,
    sourceHistoryDigest: state.graphMemoryProjection.sourceHistoryDigest,
    lastAcknowledgement: null,
    pending: [event],
  };
}

test("an explicit invalid ledger admission gate never degrades to direct mode", async () => {
  await assert.rejects(
    createFixture({ actionAdmissionGate: null }),
    /actionAdmissionGate must provide run\(operation\)/,
  );
});

test("intake atomically advances its cursor and preserves unresolved targets", async () => {
  const records = [
    assignment(1, { type: "role", id: "missing-role" }),
    assignment(2, { type: "person", id: "missing-person" }),
    assignment(3, { type: "node", id: "missing-node" }),
  ];
  const { service, source, store } = await createFixture({ records });

  const result = await service.intake({ limit: 10 });
  const page = await service.listItems({ limit: 10 });
  const timeline = await service.listTimeline({ limit: 20 });
  const summary = await service.getSummary();

  assert.deepEqual(source.calls, [{ afterSequence: 0, limit: 10 }]);
  assert.equal(result.received, 3);
  assert.equal(result.deduplicated, 0);
  assert.equal(result.cursor, 3);
  assert.equal(result.gap, null);
  assert.equal(summary.intakeCursor, 3);
  assert.equal(summary.itemCounts.queued, 3);
  assert.deepEqual(
    page.items.map(({ assignmentId, status, currentTarget }) => ({
      assignmentId,
      status,
      currentTarget,
    })),
    records.map(({ assignment }) => ({
      assignmentId: assignment.assignmentId,
      status: "queued",
      currentTarget: assignment.target,
    })),
  );
  assert.equal(page.items.every((item) => item.inputDigest.length === 64), true);
  assert.equal(
    timeline.items.filter(({ type }) => type === "assignment_intaken").length,
    3,
  );
  assert.equal(timeline.items.at(-1).type, "intake_completed");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].name, STATE_KEY);
  assert.equal(store.writes[0].value.intakeCursor, 3);
  assert.equal(store.writes[0].value.items.length, 3);
});

test("assignment progress reads are bounded, detached, and do not expose task payloads", async () => {
  const { service, store } = await createFixture({ records: [assignment(1), assignment(2)] });
  await service.intake();
  const item = (await service.listItems()).items[1];
  const writes = store.writes.length;
  const progress = await service.readItemProgress([item.itemId, "missing-item"]);
  assert.deepEqual(progress, [{
    itemId: item.itemId, status: item.status, statusReason: item.statusReason,
    currentTarget: item.currentTarget, updatedAt: item.updatedAt,
  }]);
  progress[0].currentTarget.id = "caller-mutation";
  assert.deepEqual((await service.readItemProgress([item.itemId]))[0].currentTarget, item.currentTarget);
  assert.deepEqual(await service.readItemProgress([]), []);
  for (const input of [null, [null], [""], Array(101).fill(item.itemId)]) {
    await assert.rejects(service.readItemProgress(input), { code: "WORK_LEDGER_QUERY_INVALID" });
  }
  assert.equal(store.writes.length, writes);
});

test("role workloads expose exact counts and bounded recent task summaries", async () => {
  const records = [
    assignment(1, { type: "role", id: "developer" }),
    assignment(2, { type: "role", id: "pr-engineer" }),
    assignment(3, { type: "role", id: "developer" }),
    assignment(4, { type: "node", id: "system-node" }),
  ];
  const { service } = await createFixture({ records });
  await service.intake({ limit: 10 });

  const workloads = await service.getRoleWorkloads();
  const developerPage = await service.listItems({
    roleId: "developer",
    order: "newest",
  });

  assert.deepEqual(
    workloads.items.map(({ roleId, counts }) => ({ roleId, counts })),
    [
      {
        roleId: "developer",
        counts: { queued: 2, working: 0, waiting: 0, blocked: 0 },
      },
      {
        roleId: "pr-engineer",
        counts: { queued: 1, working: 0, waiting: 0, blocked: 0 },
      },
    ],
  );
  assert.deepEqual(
    workloads.items[0].tasks.map(({ title, status, statusReason }) => ({ title, status, statusReason })),
    [
      { title: "Work 3", status: "queued", statusReason: null },
      { title: "Work 1", status: "queued", statusReason: null },
    ],
  );
  assert.deepEqual(
    developerPage.items.map(({ currentTarget }) => currentTarget.id),
    ["developer", "developer"],
  );
  await assert.rejects(
    service.listItems({ roleId: "../developer" }),
    { code: "WORK_LEDGER_QUERY_INVALID" },
  );
  workloads.items[0].counts.queued = 999;
  assert.equal((await service.getRoleWorkloads()).items[0].counts.queued, 2);
});

test("claim candidate pages exclude durable history and active leases by role", async () => {
  const fixture = await createFixture({
    records: [
      assignment(1, { type: "role", id: "developer" }),
      assignment(2, { type: "role", id: "developer" }),
      assignment(3, { type: "role", id: "developer" }),
      assignment(4, { type: "role", id: "tester" }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  await fixture.service.claim({
    itemId: items[1].itemId,
    expectedRevision: items[1].revision,
    workerId: "employee-developer-active",
    leaseDurationMs: 60_000,
  });
  await fixture.service.claim({
    itemId: items[2].itemId,
    expectedRevision: items[2].revision,
    workerId: "employee-developer-expired",
    leaseDurationMs: 1_000,
  });
  fixture.time.advance(2_000);

  const page = await fixture.service.listClaimCandidates({
    at: fixture.time.clock(),
    roleId: "developer",
    limit: 10,
  });

  assert.deepEqual(
    page.items.map(({ itemId, status }) => ({ itemId, status })),
    [
      { itemId: items[0].itemId, status: "queued" },
      { itemId: items[2].itemId, status: "working" },
    ],
  );
  assert.deepEqual(page.facts, page.items.map(({ itemId }) => ({
    itemId,
    graphBlocked: false,
    submittedChildren: 0,
    satisfiedChildren: 0,
  })));
  assert.deepEqual(page.activeQuestionTargets, []);
  assert.equal(page.nextCursor, null);
  await assert.rejects(
    fixture.service.listClaimCandidates({
      at: fixture.time.clock(),
      roleId: "../developer",
    }),
    { code: "WORK_LEDGER_QUERY_INVALID" },
  );
});

test("claim candidate pagination survives its cursor being claimed", async () => {
  const fixture = await createFixture({
    records: Array.from(
      { length: 3 },
      (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
    ),
  });
  await fixture.service.intake({ limit: 10 });
  const expectedItemIds = (await fixture.service.listItems({ limit: 10 }))
    .items.map(({ itemId }) => itemId);
  const at = fixture.time.clock();

  const firstPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
  });
  await fixture.service.claim({
    itemId: firstPage.items[0].itemId,
    expectedRevision: firstPage.items[0].revision,
    workerId: "employee-developer-concurrent",
    leaseDurationMs: 60_000,
  });
  const secondPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  const thirdPage = await fixture.service.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: secondPage.nextCursor,
  });
  const observedItemIds = [
    ...firstPage.items,
    ...secondPage.items,
    ...thirdPage.items,
  ].map(({ itemId }) => itemId);

  assert.deepEqual(observedItemIds, expectedItemIds);
  assert.equal(new Set(observedItemIds).size, expectedItemIds.length);
  assert.deepEqual(
    [firstPage, secondPage, thirdPage].flatMap(({ facts }) => facts),
    expectedItemIds.map((itemId) => ({
      itemId,
      graphBlocked: false,
      submittedChildren: 0,
      satisfiedChildren: 0,
    })),
  );
  assert.equal(thirdPage.nextCursor, null);
});

test("related progress supports a full-capacity ledger without widening raw value budgets", () => {
  const parent = { itemId: "root", revision: 1, status: "queued", graph: {} };
  const children = Array.from({ length: 4_999 }, (_, index) => ({
    itemId: `child-${index}`, revision: 1, status: "queued",
    graph: { parentItemId: parent.itemId },
  }));
  for (const dependencies of [[], children.map(({ itemId }) => itemId)]) {
    parent.graph.dependsOnItemIds = dependencies;
    const items = [parent, ...children];
    const digest = indexWorkLedgerGraphProgress(items).graphProgressDigest(parent);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(indexWorkLedgerGraphProgress([...items].reverse()).graphProgressDigest(parent), digest);
    children[0].revision += 1;
    assert.notEqual(indexWorkLedgerGraphProgress(items).graphProgressDigest(parent), digest);
  }
});

test("claim candidate pages retain facts from the complete dependency graph", async () => {
  const fixture = await createFixture({
    records: Array.from(
      { length: 4 },
      (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
    ),
  });
  await fixture.service.intake({ limit: 10 });
  const durable = fixture.store.stored();
  const [parent, cancelledChild, cancelledDependency, consumer] = durable.items;
  cancelledChild.graph.parentItemId = parent.itemId;
  cancelledChild.status = "cancelled";
  cancelledChild.statusReason = "child-scope-retired";
  cancelledDependency.status = "cancelled";
  cancelledDependency.statusReason = "dependency-retired";
  consumer.graph.parentItemId = parent.itemId;
  consumer.graph.dependsOnItemIds = [cancelledDependency.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const at = fixture.time.clock();

  const firstPage = await recovered.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
  });
  const secondPage = await recovered.listClaimCandidates({
    at,
    roleId: "developer",
    limit: 1,
    cursor: firstPage.nextCursor,
  });

  assert.deepEqual(firstPage.items.map(({ itemId }) => itemId), [parent.itemId]);
  assert.deepEqual(firstPage.facts, [{
    itemId: parent.itemId,
    graphProgressDigest: indexWorkLedgerGraphProgress(durable.items).graphProgressDigest(parent),
    graphBlocked: true,
    submittedChildren: 0,
    satisfiedChildren: 1,
  }]);
  assert.deepEqual(secondPage.items.map(({ itemId }) => itemId), [consumer.itemId]);
  assert.deepEqual(secondPage.facts, [{
    itemId: consumer.itemId,
    graphProgressDigest: indexWorkLedgerGraphProgress(durable.items).graphProgressDigest(consumer),
    graphBlocked: true,
    submittedChildren: 0,
    satisfiedChildren: 0,
  }]);
  assert.equal(secondPage.nextCursor, null);
});

test("role workloads group active states and retain only the three highest-priority tasks", async () => {
  const records = Array.from(
    { length: 6 },
    (_, index) => assignment(index + 1, { type: "role", id: "developer" }),
  );
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems()).items;
  const claim = (item, workerId) => fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });

  await claim(items[0], "employee-working");
  fixture.time.advance(1);
  const waiting = await claim(items[1], "employee-waiting");
  await fixture.service.transition({
    itemId: waiting.itemId,
    expectedRevision: waiting.revision,
    leaseId: waiting.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-waiting",
    reason: "await-test-condition",
    details: { conditionRef: "test:role-workload" },
  });
  fixture.time.advance(1);
  const retry = await claim(items[2], "employee-retry");
  await fixture.service.scheduleRetry({
    itemId: retry.itemId,
    expectedRevision: retry.revision,
    leaseId: retry.leaseId,
    actorId: "employee-retry",
    availableAt: "2026-08-02T02:02:00.000Z",
    reason: "temporary-test-failure",
  });
  fixture.time.advance(1);
  const blocked = await claim(items[3], "employee-blocked");
  await fixture.service.transition({
    itemId: blocked.itemId,
    expectedRevision: blocked.revision,
    leaseId: blocked.leaseId,
    toStatus: "blocked",
    actorId: "employee-blocked",
    reason: "terminal-test-failure",
  });

  const workload = (await fixture.service.getRoleWorkloads()).items[0];
  assert.deepEqual(workload.counts, {
    queued: 2,
    working: 1,
    waiting: 2,
    blocked: 1,
  });
  assert.deepEqual(
    workload.tasks.map(({ status }) => status),
    ["working", "retry_wait", "waiting_condition"],
  );
});

test("PR execution context returns the current author with the verified binding", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        author: "review-account",
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
    ],
  });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const inputBinding = prExecutionBinding(item);

  assert.deepEqual(
    await fixture.service.readPullRequestExecutionContext(inputBinding),
    { inputBinding, author: "review-account" },
  );
});

test("PR execution context exposes current feedback digest for trusted repair reads", async () => {
  const reviewFeedbackDigest = "e".repeat(64);
  const fixture = await createFixture({ records: [prAssignment(1, { author: "review-account", gitFacts: { ...prGitFacts(PR_HEAD_A), reviewFeedbackDigest } })] });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const inputBinding = prExecutionBinding(item);
  assert.deepEqual(await fixture.service.readPullRequestExecutionContext(inputBinding), { inputBinding, author: "review-account", reviewFeedbackDigest });
});

test("PR engineer intake keeps one durable task across events on the same Head", async () => {
  const records = [
    prAssignment(1, {
      eventType: "pull_request.updated",
      changedFields: ["labels", "ciStatus"],
    }),
    prAssignment(2, {
      eventType: "pull_request.classified",
      changedFields: ["labels"],
    }),
    prAssignment(3, {
      eventType: "pull_request.status",
      changedFields: ["ciStatus"],
      title: "PR 42 latest source facts",
    }),
  ];
  const { service } = await createFixture({ records });

  const result = await service.intake({ limit: 10 });
  const items = (await service.listItems({ limit: 10 })).items;

  assert.equal(result.received, 3);
  assert.equal(items.length, 1);
  assert.equal(items[0].currentTarget.id, "pr-engineer");
  assert.equal(items[0].source.kind, "pull_request");
  assert.equal(items[0].source.inputRevision, 3);
  assert.equal(items[0].source.activeRevision, 3);
  assert.equal(items[0].source.headRevision, 1);
  assert.equal(items[0].source.current.sourceSequence, 3);
  assert.equal(items[0].source.current.headRefOid, PR_HEAD_A);
  assert.equal(items[0].source.current.event.eventType, "pull_request.status");
  const currentGraph = await service.getGraphSnapshot();
  const projectedRoot = currentGraph.taskStates.find(
    ({ taskId }) => taskId === items[0].itemId,
  );
  assert.equal(projectedRoot.work.title, "PR 42 latest source facts");
  assert.deepEqual(
    items[0].source.revisions.map(({ disposition, headRevision }) => ({
      disposition,
      headRevision,
    })),
    [
      { disposition: "accepted", headRevision: 1 },
      { disposition: "accepted", headRevision: 1 },
      { disposition: "accepted", headRevision: 1 },
    ],
  );
  const memoryBaseline = await service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(memoryBaseline.cursor, 0);
  assert.equal(memoryBaseline.highWatermark, 1);
  assert.equal(memoryBaseline.items.length, 1);
  assert.equal(memoryBaseline.items[0].kind, "authority_observed");
  assert.equal(memoryBaseline.items[0].sourceAuthority.citable, false);
  assert.equal(
    memoryBaseline.items[0].authorityStateDigest,
    memoryBaseline.authorityStateDigest,
  );
  await service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: items[0].itemId,
    },
    command: {
      taskId: items[0].itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "fixed-head-reviewed",
          description: "在固定 PR Head 上完成审查。",
        }],
        expectedDeliverables: [],
      },
      reason: "bind-real-pr-acceptance",
      expectedGraphRevision: (await service.getSummary()).revision,
      expectedTaskRevision: items[0].revision,
    },
  });
  const projected = await service.readGraphMemoryProjectionBatch({ limit: 10 });
  assert.equal(projected.highWatermark, 2);
  assert.equal(projected.items.at(-1).kind, "acceptance_contract");
  assert.equal(projected.items.at(-1).recordRevision, 2);
  assert.match(
    projected.items.at(-1).memoryRecord.title,
    /PR 42 latest source facts/,
  );
});

test("empty assignment feed replay performs no durable ledger write", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const before = fixture.store.stored();
  fixture.store.writes.length = 0;

  const replay = await fixture.service.intake();

  assert.equal(replay.received, 0);
  assert.equal(replay.deduplicated, 0);
  assert.equal(fixture.store.writes.length, 0);
  assert.deepEqual(fixture.store.stored(), before);
});

test("a new PR Head advances the epoch without creating another task", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const items = (await fixture.service.listItems({ limit: 10 })).items;

  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, before.itemId);
  assert.equal(items[0].source.inputRevision, 2);
  assert.equal(items[0].source.headRevision, 2);
  assert.equal(items[0].source.current.headRefOid, PR_HEAD_B);
});

test("leaving and re-entering automatic PR scope fences every older authority epoch", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(before);

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const inactive = (await fixture.service.listItems()).items[0];
  assert.deepEqual(inactive.source.scope, {
    kind: "automatic",
    active: false,
    revision: 2,
    lastLifecycleEventId: leftEvent.eventId,
  });
  assert.equal(inactive.source.authorityEpoch, 2);
  assert.equal(inactive.source.headRevision, 2);
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  assert.equal(inactive.ownerId, null);
  assert.equal(inactive.leaseId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const createdOrdinary = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, createdOrdinary.event),
    createdOrdinary,
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  const active = (await fixture.service.listItems()).items[0];
  assert.deepEqual(active.source.scope, {
    kind: "automatic",
    active: true,
    revision: 3,
    lastLifecycleEventId: createdOrdinary.event.eventId,
  });
  assert.equal(active.source.authorityEpoch, 3);
  assert.equal(active.source.headRevision, 3);
  assert.equal(active.status, "queued");
  assert.equal(active.statusReason, "pr_source_reentered_scope");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = prExecutionBinding(active);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );

  fixture.source.records.push(prAssignment(5, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 5;
  const updatedIntake = await fixture.service.intake();
  const updated = (await fixture.service.listItems()).items[0];

  assert.equal(updatedIntake.cursor, 5);
  assert.equal(updated.source.current.event.eventType, "pull_request.updated");
  assert.deepEqual(updated.source.scope, active.source.scope);
  assert.equal(updated.source.authorityEpoch, active.source.authorityEpoch);
});

async function sourceExitHistoryFixture({
  ownerOccurredAt = "2026-08-02T01:00:00.000Z",
  bridgeOptions = {},
  omitBridge = false,
  receiverHead = PR_HEAD_B,
  receiverOccurredAt = "2026-08-02T01:20:00.000Z",
  leaveScope = true,
} = {}) {
  const fixture = await createFixture({ records: [ownerRequestedPrAssignment(1, {
    occurredAt: ownerOccurredAt,
  })] });
  await fixture.service.intake();
  const records = [
    prAssignment(2, { occurredAt: "2026-08-02T01:05:00.000Z", gitFacts: prGitFacts(PR_HEAD_A) }),
    prAssignment(3, { occurredAt: "2026-08-02T01:10:00.000Z", headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A, changedFields: ["headRefOid"], gitFacts: prGitFacts(PR_HEAD_B), ...bridgeOptions }),
    prScopeLifecycleAssignment(4, prAssignment(4, { eventType: "pull_request.left_scope",
      occurredAt: "2026-08-02T01:15:00.000Z", headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B) }).event),
    prAssignment(5, { sourceScopeId: "github-secondary", occurredAt: receiverOccurredAt,
      headRefOid: receiverHead, gitFacts: prGitFacts(receiverHead) }),
  ];
  let exitedState;
  for (const record of records) {
    fixture.source.records.push((omitBridge && record.sequence === 3) || (!leaveScope && record.sequence === 4)
      ? assignment(record.sequence) : record);
    fixture.source.highWatermark = record.sequence;
    await fixture.service.intake();
    if (record.sequence === 4) exitedState = fixture.store.stored();
  }
  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const inactive = roots.find(item => item.source?.identity.scopeId === "github-dashboard");
  const receiver = roots.find(item => item.source?.identity.scopeId === "github-secondary");
  return { ...fixture, inactive, receiver, exitedState };
}

async function schema11SourceExitProjectionFixture(options) {
  const fixture = await sourceExitHistoryFixture(options);
  const state = fixture.store.stored();
  state.schemaVersion = 11;
  const projection = acknowledgeWorkGraphMemoryProjectionBatch(state.graphMemoryProjection, {
    receipts: state.graphMemoryProjection.pending.slice(0, 2).map(workGraphMemoryRecordReceipt),
  }, state.revision).projection;
  state.graphMemoryProjection = projection;
  // Under the previous policy, skipping the inactive A -> B bridge leaves
  // the receiving B provenance fenced. Preserve that sealed old baseline.
  const authorities = state.items.filter(item => item.source?.kind === "pull_request")
    .map(item => ({ item, authority: createWorkGraphSourceAuthority({
      executionBinding: prExecutionBinding(item),
      provenance: { provider: item.source.identity.provider, scopeId: item.source.identity.scopeId },
      citable: false,
    }) }));
  const authorityStateDigest = ledgerDigest(authorities.map(({ item, authority }) => ({
    taskId: item.itemId, bindingDigest: authority.bindingDigest, citable: false,
  })).sort((left, right) => left.taskId.localeCompare(right.taskId, "en")));
  const receiverAuthority = authorities.find(({ item }) => item.itemId === fixture.receiver.itemId).authority;
  const event = createWorkGraphAuthorityObservationEvent({
    sequence: projection.nextSequence,
    previousDigest: projection.pending.at(-1)?.eventDigest ?? projection.checkpointDigest,
    ledgerRevision: state.revision,
    taskRevision: fixture.receiver.revision,
    item: fixture.receiver,
    occurredAt: state.timeline.at(-1).at,
    sourceAuthority: receiverAuthority,
    authorityStateDigest,
  });
  projection.pending.push(event);
  projection.nextSequence += 1;
  projection.authorityStateDigest = authorityStateDigest;
  fixture.store.replaceStored(state);
  return { ...fixture, legacy: state };
}

test("schema v11 recovers a previous-policy authority baseline before appending the current observation", async () => {
  const fixture = await schema11SourceExitProjectionFixture();
  const before = clone(fixture.legacy);
  const normalized = normalizeWorkLedgerPersistedState(before);
  assert.equal(normalized.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(before, fixture.legacy);
  assert.deepEqual(normalized.items, before.items);
  assert.deepEqual(normalized.timeline, before.timeline);
  assert.deepEqual(normalized.outbox, before.outbox);
  const previous = before.graphMemoryProjection;
  const next = normalized.graphMemoryProjection;
  assert.deepEqual(next.pending.slice(0, previous.pending.length), previous.pending);
  assert.equal(next.pending.length, previous.pending.length + 1);
  assert.equal(next.pending.at(-1).kind, "authority_observed");
  assert.equal(next.pending.at(-1).previousDigest, previous.pending.at(-1).eventDigest);
  assert.notEqual(next.authorityStateDigest, previous.authorityStateDigest);
  for (const key of ["cursor", "checkpointDigest", "lastAcknowledgement", "sourceHistoryDigest"]) {
    assert.deepEqual(next[key], previous[key]);
  }
  assert.deepEqual(normalizeWorkLedgerPersistedState(normalized), normalized);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const batch = await restarted.service.readGraphMemoryProjectionBatch({ limit: 100 });
  assert.deepEqual(batch.items, next.pending);
  assert.deepEqual(fixture.store.stored(), before, "read-only migration does not rewrite the original store");
  await assert.rejects(restarted.service.verifyPullRequestExecutionBinding(prExecutionBinding(fixture.inactive)),
    error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
  const receiver = (await restarted.service.listItems({ limit: 10 })).items.find(item => item.itemId === fixture.receiver.itemId);
  assert.equal((await restarted.service.claim({ itemId: receiver.itemId, expectedRevision: receiver.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 })).status, "working");
  assert.equal(fixture.store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  const second = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(await second.service.listItems({ limit: 10 }), await restarted.service.listItems({ limit: 10 }));
});

test("schema v11 preserves an already current policy projection without appending another observation", async () => {
  const fixture = await sourceExitHistoryFixture();
  const state = fixture.store.stored();
  state.schemaVersion = 11;
  const normalized = normalizeWorkLedgerPersistedState(state);
  assert.equal(normalized.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(normalized.graphMemoryProjection, state.graphMemoryProjection);
});

for (const schemaVersion of [10, 11]) {
  test(`schema v${schemaVersion} policy upgrade recovers a full migration tail and drains it across restarts`, async () => {
    const fixture = await schema11SourceExitProjectionFixture();
    const state = clone(fixture.legacy);
    state.schemaVersion = schemaVersion;
    fixture.store.replaceStored(state);
    const limits = { graphMemoryOutboxLimit: 1 };
    assert.equal(state.items.length, 3);
    assert.deepEqual(state.graphMemoryProjection.pending.map(event => event.kind),
      ["authority_invalidated", "authority_invalidated", "authority_invalidated", "authority_observed"]);
    const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
    const normalized = normalizeWorkLedgerPersistedState(state, limits);
    assert.deepEqual(normalizeWorkLedgerPersistedState(normalized, limits), normalized);
    const batch = await restarted.service.readGraphMemoryProjectionBatch({ limit: 100 });
    assert.deepEqual(batch.items.slice(0, 4), state.graphMemoryProjection.pending);
    assert.equal(batch.items.length, 5);
    assert.equal(batch.items.at(-1).kind, "authority_observed");
    const extraObservation = clone(normalized);
    const projection = extraObservation.graphMemoryProjection;
    const tail = projection.pending.at(-1);
    const receiver = normalized.items.find(item => item.itemId === fixture.receiver.itemId);
    projection.pending.push(createWorkGraphAuthorityObservationEvent({
      sequence: projection.nextSequence++, previousDigest: tail.eventDigest,
      ledgerRevision: normalized.revision, taskRevision: receiver.revision, item: receiver,
      occurredAt: tail.occurredAt, sourceAuthority: tail.sourceAuthority,
      authorityStateDigest: tail.authorityStateDigest,
    }));
    assert.throws(() => normalizeWorkLedgerPersistedState(extraObservation, limits),
      error => error.code === "WORK_LEDGER_STATE_CORRUPTED");
    assert.throws(() => normalizeWorkLedgerPersistedState(normalized, {
      ...limits, graphMemoryEventByteBudget: 1,
    }), error => error.code === "WORK_LEDGER_STATE_CORRUPTED");
    const writes = fixture.store.writes.length;
    await assert.rejects(restarted.service.reviseGraphAcceptance({
      authority: { actorId: "employee-orchestrator", scopeRootTaskId: receiver.itemId },
      command: { taskId: receiver.itemId, acceptanceContract: { revision: 2,
        acceptanceCriteria: [{ criterionId: "capacity-boundary", description: "Require a new ordinary graph record" }],
        expectedDeliverables: [] }, reason: "ordinary-command-at-capacity",
        expectedGraphRevision: normalized.revision, expectedTaskRevision: receiver.revision },
    }), error => error.code === "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED");
    assert.equal(fixture.store.writes.length, writes);
    fixture.store.replaceStored(normalized);
    const second = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
    assert.deepEqual(await second.service.readGraphMemoryProjectionBatch({ limit: 100 }), batch);
    for (const event of batch.items) {
      await second.service.acknowledgeGraphMemoryProjection(workGraphMemoryRecordReceipt(event));
      const recovered = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time, limits });
      assert.equal((await recovered.service.readGraphMemoryProjectionBatch({ limit: 100 })).cursor, event.sequence);
    }
    const drained = await second.service.readGraphMemoryProjectionBatch({ limit: 100 });
    assert.deepEqual(drained.items, []);
    assert.equal(drained.cursor, batch.highWatermark);
    assert.equal(fixture.store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  });
}

test("schema v10 former-policy authority baseline passes the production restore before public recovery", async (t) => {
  const fixture = await schema11SourceExitProjectionFixture();
  const state = clone(fixture.legacy);
  state.schemaVersion = 10;
  const prefix = path.join(tmpdir(), "mydashboard-policy-upgrade-");
  const directory = await mkdtemp(prefix);
  assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(path.join(directory, "work-ledger-state.json"), bytes);
  const manifest = createBackupManifest({ createdAt: fixture.time.clock(),
    stores: [{ name: "fixture", revision: state.revision, digest: ledgerDigest(state) }],
    files: [{ path: "work-ledger-state.json", kind: "mutable", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }] });
  const registry = createProductionRestoreMigrationRegistry();
  await registry.migrate({ directory, manifest });
  const restored = JSON.parse(await readFile(path.join(directory, "work-ledger-state.json"), "utf8"));
  assert.equal(restored.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(restored.items, state.items);
  assert.deepEqual(restored.graphMemoryProjection.pending.slice(0, 4), state.graphMemoryProjection.pending);
  const once = await readFile(path.join(directory, "work-ledger-state.json"));
  await registry.migrate({ directory, manifest });
  assert.deepEqual(await readFile(path.join(directory, "work-ledger-state.json")), once);
  fixture.store.replaceStored(restored);
  const recovered = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time,
    limits: { graphMemoryOutboxLimit: 1 } });
  assert.equal((await recovered.service.readGraphMemoryProjectionBatch({ limit: 100 })).items.length, 5);
});

test("schema v11 authority migration cannot authorize a takeover older than the accepted history", async () => {
  const fixture = await schema11SourceExitProjectionFixture({ receiverOccurredAt: "2026-08-02T01:08:00.000Z" });
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const writes = fixture.store.writes.length;
  const receiver = (await restarted.service.listItems({ limit: 10 })).items.find(item => item.itemId === fixture.receiver.itemId);
  await assert.rejects(restarted.service.verifyPullRequestExecutionBinding(prExecutionBinding(receiver)),
    error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
  await assert.rejects(restarted.service.claim({ itemId: receiver.itemId, expectedRevision: receiver.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 }),
  error => ["WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING", "WORK_LEDGER_PR_EXECUTION_BINDING_STALE"].includes(error.code));
  assert.equal(fixture.store.writes.length, writes);
});

for (const corruption of ["authority digest", "high watermark", "sealed high watermark", "event", "chain", "receipt", "source history", "schema 12 legacy baseline"]) {
  test(`schema v11 authority migration rejects ${corruption} without writing`, async () => {
    const fixture = await schema11SourceExitProjectionFixture();
    const state = clone(fixture.legacy);
    const projection = state.graphMemoryProjection;
    if (corruption === "authority digest") projection.authorityStateDigest = "0".repeat(64);
    if (corruption === "high watermark") projection.nextSequence += 1;
    if (corruption === "event") projection.pending.at(-1).memoryRecord.title = "forged";
    if (["sealed high watermark", "chain"].includes(corruption)) {
      const tail = projection.pending.at(-1);
      projection.pending[projection.pending.length - 1] = createWorkGraphAuthorityObservationEvent({
        sequence: tail.sequence, previousDigest: corruption === "chain" ? "0".repeat(64) : tail.previousDigest,
        ledgerRevision: tail.ledgerRevision, taskRevision: tail.taskRevision, item: fixture.receiver,
        occurredAt: tail.occurredAt, sourceAuthority: tail.sourceAuthority,
        authorityStateDigest: corruption === "sealed high watermark" ? "0".repeat(64) : tail.authorityStateDigest,
      });
    }
    if (corruption === "receipt") projection.lastAcknowledgement.receipt.memoryRecordDigest = "0".repeat(64);
    if (corruption === "source history") projection.sourceHistoryDigest = "0".repeat(64);
    if (corruption === "schema 12 legacy baseline") state.schemaVersion = 12;
    fixture.store.replaceStored(state);
    const writes = fixture.store.writes.length;
    await assert.rejects(createFixture({ source: fixture.source, store: fixture.store, time: fixture.time }),
      error => error.code === "WORK_LEDGER_STATE_CORRUPTED");
    assert.equal(fixture.store.writes.length, writes);
    assert.deepEqual(fixture.store.stored(), state);
  });
}

test("accepted Head history survives a source exit when a new provenance takes over", async () => {
  const fixture = await sourceExitHistoryFixture();
  const { inactive, receiver } = fixture;
  assert.equal(inactive.source.scope.active, false);
  const historicalAuthority = pullRequestTrustedPredecessor(fixture.exitedState, inactive);
  assert.equal(historicalAuthority.headRefOid, PR_HEAD_B);
  assert.notEqual(historicalAuthority.canonicalRootItemId, inactive.itemId);
  assert.notEqual(historicalAuthority.lastTrustedRootItemId, inactive.itemId);
  await assert.rejects(fixture.service.verifyPullRequestExecutionBinding(prExecutionBinding(inactive)),
    error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
  const binding = prExecutionBinding(receiver);
  assert.deepEqual(await fixture.service.verifyPullRequestExecutionBinding(binding), binding);
  const claimed = await fixture.service.claim({ itemId: receiver.itemId, expectedRevision: receiver.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  assert.equal(claimed.status, "working");
  assert.equal(claimed.source.current.headRefOid, PR_HEAD_B);
  assert.deepEqual((await fixture.service.listItems({ limit: 10 })).items.find(item => item.itemId === inactive.itemId), inactive);
});

for (const leaveScope of [false, true]) {
  test(`accepted Head history rejects an older takeover while source exit=${leaveScope}`, async () => {
    const fixture = await sourceExitHistoryFixture({ leaveScope, receiverOccurredAt: "2026-08-02T01:08:00.000Z" });
    assert.equal(fixture.inactive.source.scope.active, !leaveScope);
    const before = fixture.store.stored();
    const writes = fixture.store.writes.length;
    await assert.rejects(fixture.service.verifyPullRequestExecutionBinding(prExecutionBinding(fixture.receiver)),
      error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
    await assert.rejects(fixture.service.claim({ itemId: fixture.receiver.itemId,
      expectedRevision: fixture.receiver.revision, workerId: "employee-pr-engineer", leaseDurationMs: 30_000 }),
    error => ["WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING", "WORK_LEDGER_PR_EXECUTION_BINDING_STALE"].includes(error.code));
    assert.deepEqual(fixture.store.stored(), before);
    assert.equal(fixture.store.writes.length, writes);
  });
}

for (const [name, options] of [
  ["unknown receiver Head", { receiverHead: PR_HEAD_C }],
  ["missing historical bridge", { omitBridge: true }],
  ["rejected historical bridge", { bridgeOptions: { previousHeadRefOid: undefined } }],
  ["unavailable historical target", { bridgeOptions: { gitFacts: { gitTargetAvailable: false } } }],
  ["legacy historical target downgrade", { bridgeOptions: { gitFacts: {} } }],
  ["history older than the trusted watermark", { ownerOccurredAt: "2099-01-01T00:00:00.000Z" }],
]) {
  test(`a source exit cannot use ${name} to authorize a new provenance`, async () => {
    const fixture = await sourceExitHistoryFixture(options);
    const before = fixture.store.stored();
    const writes = fixture.store.writes.length;
    const binding = prExecutionBinding(fixture.receiver);
    await assert.rejects(fixture.service.verifyPullRequestExecutionBinding(binding),
      error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
    await assert.rejects(fixture.service.claim({ itemId: fixture.receiver.itemId,
      expectedRevision: fixture.receiver.revision, workerId: "employee-pr-engineer", leaseDurationMs: 30_000 }),
    error => ["WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING", "WORK_LEDGER_PR_EXECUTION_BINDING_STALE"].includes(error.code));
    assert.deepEqual(fixture.store.stored(), before);
    assert.equal(fixture.store.writes.length, writes);
  });
}

test("quarantining an inactive source cannot lend its accepted history to a new provenance", async () => {
  const fixture = await sourceExitHistoryFixture();
  const state = fixture.store.stored();
  const inactive = state.items.find(item => item.itemId === fixture.inactive.itemId);
  inactive.sourceQuarantine = { kind: "legacy" };
  const authority = pullRequestTrustedPredecessor(state, fixture.receiver);
  assert.equal(authority.authorityFenced, true);
  assert.equal(authority.canonicalRootItemId, null);
  assert.equal(pullRequestHeadAdmission(state, fixture.receiver).current, false);
  assert.equal(pullRequestHeadAdmission(state, inactive).current, false);
});

async function inactiveAutomaticUpdateFixture({ childWorking = false, ownerPaused = false, ownerResumed = false } = {}) {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const exit = prAssignment(2, { eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z", gitFacts: prGitFacts(PR_HEAD_A) });
  fixture.source.records.push(prScopeLifecycleAssignment(2, exit.event));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(3, { headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const owner = (await fixture.service.listItems()).items.find(item => item.source.scope.kind === "owner_requested");
  await fixture.service.createGraphChild(prGraphChildCommand(owner, (await fixture.service.getSummary()).revision));
  if (childWorking) {
    const child = (await fixture.service.listItems()).items.find(item => item.graph?.parentItemId === owner.itemId);
    await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
      workerId: "configured-developer", leaseDurationMs: 30_000 });
  }
  if (ownerPaused) {
    const current = (await fixture.service.listItems()).items.find(item => item.itemId === owner.itemId);
    await fixture.service.controlModelRun({ itemId: current.itemId, expectedRevision: current.revision,
      leaseId: null, command: "pause" });
    if (ownerResumed) {
      const paused = (await fixture.service.listItems()).items.find(item => item.itemId === owner.itemId);
      await fixture.service.controlModelRun({ itemId: paused.itemId, expectedRevision: paused.revision,
        leaseId: null, command: "resume" });
    }
  }
  fixture.time.advance(1000);
  fixture.source.records.push(prAssignment(4, { occurredAt: "2026-08-02T01:20:00.000Z",
    headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B), changedFields: ["milestone"] }));
  fixture.source.highWatermark = 4;
  return { ...fixture, automatic, owner };
}

for (const childWorking of [false, true]) {
  test(`an inactive automatic metadata update cannot retire the current owner Review (child working=${childWorking})`, async () => {
    const fixture = await inactiveAutomaticUpdateFixture({ childWorking });
    const before = fixture.store.stored();
    await fixture.service.intake();
    const state = fixture.store.stored();
    const owner = state.items.find(item => item.itemId === fixture.owner.itemId);
    const childBefore = before.items.find(item => item.graph?.parentItemId === owner.itemId);
    const child = state.items.find(item => item.itemId === childBefore.itemId);
    const automatic = state.items.find(item => item.itemId === fixture.automatic.itemId);
    assert.deepEqual(owner, before.items.find(item => item.itemId === owner.itemId));
    assert.deepEqual(child, childBefore);
    assert.equal(pullRequestHeadAdmission(state, owner).current, true);
    assert.equal(automatic.source.current.headRefOid, PR_HEAD_B);
    assert.equal(automatic.source.scope.active, false);
    assert.equal(automatic.status, "blocked");
    await assert.rejects(fixture.service.claim({ itemId: automatic.itemId, expectedRevision: automatic.revision,
      workerId: "employee-pr-engineer", leaseDurationMs: 30_000 }), error => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING");
    if (!childWorking) assert.equal((await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
      workerId: "configured-developer", leaseDurationMs: 30_000 })).status, "working");
  });
}

async function legacyInactiveTakeoverFixture(options) {
  const fixture = await inactiveAutomaticUpdateFixture(options);
  await fixture.service.intake();
  const state = fixture.store.stored();
  const automatic = state.items.find(item => item.itemId === fixture.automatic.itemId);
  const owner = state.items.find(item => item.itemId === fixture.owner.itemId);
  const child = state.items.find(item => item.graph?.parentItemId === owner.itemId);
  // Persist the state written by the old intake path; superseded work stays historical.
  Object.assign(owner, { status: "blocked", statusReason: "pr_source_cross_root_cutover_retired",
    revision: owner.revision + 1, updatedAt: automatic.updatedAt });
  Object.assign(child, { status: "superseded", statusReason: "pr_head_superseded",
    revision: child.revision + 1, updatedAt: automatic.updatedAt });
  fixture.store.replaceStored(state);
  return { ...fixture, state, owner, automatic, child };
}

test("normal recovery restores only the current Review retired by an inactive metadata update once", async () => {
  const fixture = await legacyInactiveTakeoverFixture();
  const recovered = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const state = fixture.store.stored();
  const owner = state.items.find(item => item.itemId === fixture.owner.itemId);
  assert.equal(owner.status, "queued");
  assert.equal(owner.statusReason, "pr_source_inactive_takeover_recovered");
  assert.equal(owner.attempt, fixture.owner.attempt);
  assert.deepEqual(owner.source, fixture.owner.source);
  assert.deepEqual(state.items.find(item => item.itemId === fixture.child.itemId), fixture.child);
  assert.equal(state.intakeCursor, fixture.state.intakeCursor);
  assert.equal((await recovered.service.claim({ itemId: owner.itemId, expectedRevision: owner.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 })).status, "working");
  const writes = fixture.store.writes.length;
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal(fixture.store.writes.length, writes);
  assert.equal(fixture.store.stored().timeline.filter(entry => entry.itemId === owner.itemId &&
    entry.details.reason === "pr_source_inactive_takeover_recovered").length, 1);
});

for (const status of ["paused", "cancelled", "completed", "superseded"]) {
  test(`inactive takeover recovery preserves ${status} work`, async () => {
    const fixture = await legacyInactiveTakeoverFixture();
    const owner = fixture.state.items.find(item => item.itemId === fixture.owner.itemId);
    owner.status = status;
    owner.statusReason = status === "paused" ? "owner-paused" : owner.statusReason;
    fixture.store.replaceStored(fixture.state);
    await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    assert.deepEqual(fixture.store.stored().items.find(item => item.itemId === owner.itemId), owner);
  });
}

test("inactive takeover recovery requires the retained activation proof", async () => {
  const fixture = await legacyInactiveTakeoverFixture();
  fixture.state.timeline = [];
  fixture.state.timelineStartSequence = fixture.state.nextTimelineSequence;
  fixture.store.replaceStored(fixture.state);
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId), fixture.owner);
});

for (const retainExitProof of [false, true]) {
  test(`legacy unmarked scope exit requires its recorded revocation (proof retained=${retainExitProof})`, async () => {
    const fixture = await legacyInactiveTakeoverFixture();
    const automatic = fixture.state.items.find(item => item.itemId === fixture.automatic.itemId);
    for (const binding of automatic.source.bindings) delete binding.scopeLifecycle;
    if (!retainExitProof) {
      const exitIndex = fixture.state.timeline.findLastIndex(entry => entry.itemId === automatic.itemId && entry.details.scopeActive === false);
      fixture.state.timeline = fixture.state.timeline.slice(exitIndex + 1);
      fixture.state.timelineStartSequence = fixture.state.timeline[0].sequence;
    }
    fixture.store.replaceStored(fixture.state);
    await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
    assert.equal(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId).status,
      retainExitProof ? "queued" : "blocked");
  });
}

test("inactive takeover recovery does not restart work with an unsettled child", async () => {
  const fixture = await legacyInactiveTakeoverFixture();
  const child = fixture.state.items.find(item => item.itemId === fixture.child.itemId);
  child.status = "queued";
  child.statusReason = null;
  fixture.store.replaceStored(fixture.state);
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId), fixture.owner);
});

test("inactive takeover recovery cannot resume an owner pause erased by the old retirement path", async () => {
  const fixture = await legacyInactiveTakeoverFixture({ ownerPaused: true });
  assert.equal(fixture.state.timeline.findLast(entry => entry.itemId === fixture.owner.itemId && entry.type === "transitioned").details.toStatus, "paused");
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId), fixture.owner);
});

test("inactive takeover recovery honors an explicit owner resume before retirement", async () => {
  const fixture = await legacyInactiveTakeoverFixture({ ownerPaused: true, ownerResumed: true });
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId).status, "queued");
});

test("inactive takeover recovery cannot infer runnable work after root history expires", async () => {
  const fixture = await legacyInactiveTakeoverFixture();
  const rootIndex = fixture.state.timeline.findLastIndex(entry => entry.itemId === fixture.owner.itemId);
  fixture.state.timeline = fixture.state.timeline.slice(rootIndex + 1);
  fixture.state.timelineStartSequence = fixture.state.timeline[0].sequence;
  fixture.store.replaceStored(fixture.state);
  await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.deepEqual(fixture.store.stored().items.find(item => item.itemId === fixture.owner.itemId), fixture.owner);
});

test("a changed Head cannot restore automatic PR scope without causal proof", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const changedHead = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, changedHead.event),
    changedHead,
  );
  fixture.source.highWatermark = 4;

  const intake = await fixture.service.intake({ limit: 10 });
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(intake.cursor, 4);
  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.revisions.at(-1).headRefOid, PR_HEAD_B);
  assert.equal(
    root.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a rejected changed-Head left-scope still revokes automatic authority", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(before);
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const inactive = (await fixture.service.listItems()).items[0];

  assert.equal(inactive.source.scope.active, false);
  assert.equal(inactive.source.scope.revision, 2);
  assert.equal(inactive.source.scope.lastLifecycleEventId, leftEvent.eventId);
  assert.equal(inactive.source.current.headRefOid, PR_HEAD_A);
  assert.equal(
    inactive.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const restarted = await createFixture({ store: fixture.store });
  const recoveredInactive = (await restarted.service.listItems()).items[0];
  assert.equal(recoveredInactive.source.scope.active, false);
  assert.equal(
    recoveredInactive.source.scope.lastLifecycleEventId,
    leftEvent.eventId,
  );
  assert.equal(recoveredInactive.source.current.headRefOid, PR_HEAD_A);

  const reentered = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, reentered.event),
    reentered,
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  const active = (await fixture.service.listItems()).items[0];

  assert.equal(active.source.scope.active, true);
  assert.equal(active.source.scope.revision, 3);
  assert.equal(active.source.current.headRefOid, PR_HEAD_A);
  assert.equal(active.source.authorityEpoch, before.source.authorityEpoch + 1);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a stale lifecycle replay cannot recover an unresolved authority fence", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:20:00.000Z",
      gitFacts: { gitTargetAvailable: false },
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const staleCreated = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(4, staleCreated));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.eventId, leftEvent.eventId);
  assert.equal(root.source.revisions.at(-1).disposition, "ignored_stale");
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("rebinding an accepted lifecycle event cannot restore revoked PR scope", async () => {
  const initial = prAssignment(1, {
    eventType: "pull_request.created",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  fixture.source.records.push(prScopeLifecycleAssignment(3, initial.event));
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];

  assert.equal(intake.cursor, 3);
  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.revision, 2);
  assert.equal(root.source.current.eventId, leftEvent.eventId);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a completed automatic PR root can leave scope without blocking later intake", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.complete({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-scope-exit" },
  });
  assert.equal(root.status, "completed");

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    assignment(3),
  );
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const inactive = items.find(({ itemId }) => itemId === root.itemId);

  assert.equal(intake.received, 2);
  assert.equal((await fixture.service.getSummary()).intakeCursor, 3);
  assert.notEqual(items.find(({ assignmentId }) => assignmentId === "workflow-assignment-3"), undefined);
  assert.equal(inactive.source.scope.active, false);
  assert.equal(inactive.source.authorityEpoch, root.source.authorityEpoch + 1);
  assert.equal(inactive.source.inputRevision, root.source.inputRevision + 1);
  assert.equal(inactive.status, "blocked");
  assert.equal(inactive.statusReason, "pr_source_left_scope");
  assert.equal(inactive.ownerId, null);
  assert.equal(inactive.leaseId, null);
  assert.equal(inactive.activeIntentId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const created = prAssignment(5, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(4, created.event),
    created,
  );
  fixture.source.highWatermark = 5;
  await fixture.service.intake({ limit: 10 });

  const reentered = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === root.itemId,
  );
  assert.equal(reentered.source.scope.active, true);
  assert.equal(reentered.source.authorityEpoch, inactive.source.authorityEpoch + 1);
  assert.equal(reentered.status, "queued");
  assert.equal(reentered.statusReason, "pr_source_reentered_scope");
});

test("a redundant scope-created event preserves completed PR work", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.complete({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-redundant-created" },
  });

  const repeatedCreated = prAssignment(2, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, repeatedCreated),
    assignment(3),
  );
  fixture.source.highWatermark = 3;

  const intake = await fixture.service.intake({ limit: 10 });
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const preserved = items.find(({ itemId }) => itemId === root.itemId);

  assert.equal(intake.received, 2);
  assert.equal(intake.cursor, 3);
  assert.equal(preserved.status, "completed");
  assert.equal(preserved.revision, root.revision);
  assert.deepEqual(preserved.source, root.source);
  assert.notEqual(
    items.find(({ assignmentId }) => assignmentId === "workflow-assignment-3"),
    undefined,
  );
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  assert.notEqual(
    timeline.items.find((entry) =>
      entry.type === "pr_source_ignored" &&
      entry.details.disposition === "ignored_redundant_scope_lifecycle"
    ),
    undefined,
  );
});

test("a batch of old completed PR roots leaves scope with mixed Head proof", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        pullRequestNumber: 41,
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
      prAssignment(2, {
        pullRequestNumber: 42,
        gitFacts: prGitFacts(PR_HEAD_A),
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const completedRoots = [];
  for (const queued of (await fixture.service.listItems({ limit: 10 })).items) {
    const claimed = await fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: queued.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    completedRoots.push(await fixture.service.complete({
      itemId: claimed.itemId,
      expectedRevision: claimed.revision,
      leaseId: claimed.leaseId,
      actorId: "employee-pr-engineer",
      result: { outcome: "completed-before-batch-scope-exit" },
    }));
  }
  const previousByNumber = new Map(
    completedRoots.map((root) => [root.source.identity.pullRequestNumber, root]),
  );
  const acceptedLeftEvent = prAssignment(3, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    pullRequestNumber: 41,
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const unprovenLeftEvent = prAssignment(4, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    pullRequestNumber: 42,
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, acceptedLeftEvent),
    prScopeLifecycleAssignment(4, unprovenLeftEvent),
  );
  fixture.source.highWatermark = 4;

  const intake = await fixture.service.intake({ limit: 10 });
  const inactiveByNumber = new Map(
    (await fixture.service.listItems({ limit: 10 })).items.map((root) => [
      root.source.identity.pullRequestNumber,
      root,
    ]),
  );
  const accepted = inactiveByNumber.get(41);
  const unproven = inactiveByNumber.get(42);

  assert.equal(intake.received, 2);
  assert.equal(intake.cursor, 4);
  assert.equal(accepted.status, "blocked");
  assert.equal(accepted.statusReason, "pr_source_left_scope");
  assert.equal(unproven.source.scope.active, false);
  assert.equal(
    unproven.source.activeRevision,
    previousByNumber.get(42).source.activeRevision,
  );
  assert.equal(
    unproven.source.authorityEpoch,
    previousByNumber.get(42).source.authorityEpoch,
  );
  assert.equal(
    unproven.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(
    unproven.source.revisions.at(-1).scopeRevocationApplied,
    true,
  );
  assert.equal(unproven.status, "blocked");
  assert.equal(unproven.statusReason, "pr_source_left_scope");
});

test("scope exit with a proven new Head preserves activation proof and does not block later intake", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await stageSealedPrReview(fixture);
  const initial = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(prAssignment(2, { occurredAt: "2026-08-02T01:04:00.000Z",
    headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A, changedFields: ["headRefOid"], gitFacts: prGitFacts(PR_HEAD_B) }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  assert.equal((await fixture.service.listItems()).items.find(root => root.itemId === initial.itemId).source.pendingRevision, 2);
  const exit = prAssignment(3, { eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B) }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(3, exit),
    prAssignment(4, { pullRequestNumber: 43, occurredAt: "2026-08-02T01:06:00.000Z", gitFacts: prGitFacts(PR_HEAD_A) }));
  fixture.source.highWatermark = 4;
  assert.equal((await fixture.service.intake()).cursor, 4);
  const roots = (await fixture.service.listItems()).items;
  const retired = roots.find(root => root.itemId === initial.itemId);
  assert.equal(retired.source.scope.active, false);
  assert.equal(retired.source.current.headRefOid, PR_HEAD_B);
  assert.equal(retired.source.decisionBudget.attemptOffset, 1);
  assert.equal(roots.find(root => root.source.identity.pullRequestNumber === 43).status, "queued");
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  assert.equal((await restarted.service.intake()).received, 0);
});

test("an explicit owner PR source survives automatic left-scope and never reuses its old binding", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    ownerRequestedPrAssignment(3),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const inactiveAutomatic = roots.find(
    ({ source }) => source.scope.kind === "automatic",
  );
  assert.notEqual(owner, undefined);
  assert.equal(owner.source.scope.active, true);
  assert.equal(owner.status, "queued");
  assert.equal(inactiveAutomatic.source.scope.active, false);
  assert.equal(inactiveAutomatic.status, "blocked");
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const ownerBinding = prExecutionBinding(owner);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("owner-requested PR work reaches developer and tester with the exact PR source", async () => {
  for (const roleId of ["developer", "tester"]) {
    const assignment = ownerRequestedPrAssignment(1);
    assignment.assignment.target = { type: "role", id: roleId };
    assignment.assignment.reason = `owner-pr-${roleId}`;
    const fixture = await createFixture({ records: [assignment] });

    await fixture.service.intake({ limit: 10 });

    const [item] = (await fixture.service.listItems({ limit: 10 })).items;
    assert.deepEqual(
      {
        roleId: item.currentTarget.id,
        targetRoleId: item.source.identity.targetRoleId,
        headRefOid: item.source.current.headRefOid,
        scopeKind: item.source.scope.kind,
      },
      {
        roleId,
        targetRoleId: roleId,
        headRefOid: PR_HEAD_A,
        scopeKind: "owner_requested",
      },
    );
  }
});

test("trusted authored PR lifecycle work reaches its developer and tester", async () => {
  const cases = [
    {
      roleId: "developer",
      ruleId: AUTHORED_PR_SELF_FIX_RULE_ID,
      payload: {
        relation: "authored",
        actionState: "action_now",
        nextAction: "address_review",
      },
    },
    {
      roleId: "tester",
      ruleId: AUTHORED_PR_APPROVED_RULE_ID,
      payload: {
        relation: "authored",
        actionState: "waiting_other",
        nextAction: "wait_merge",
        reviewDecision: "APPROVED",
      },
    },
    {
      roleId: "tester",
      ruleId: REVIEWED_PR_APPROVED_RULE_ID,
      payload: {
        relation: "review_requested",
        actionState: "waiting_other",
        nextAction: "wait_merge",
        myReviewState: "APPROVED",
      },
    },
  ];
  for (const { roleId, ruleId, payload } of cases) {
    const assignment = prAssignment(1, { gitFacts: payload });
    assignment.assignment.target = { type: "role", id: roleId };
    assignment.assignment.ruleId = ruleId;
    assignment.assignment.reason = `authored-pr-${roleId}`;
    const fixture = await createFixture({ records: [assignment] });

    await fixture.service.intake({ limit: 10 });

    const [item] = (await fixture.service.listItems({ limit: 10 })).items;
    assert.equal(item.currentTarget.id, roleId);
    assert.equal(item.source.identity.targetRoleId, roleId);
    assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  }
});

test("automatic scope lifecycle ignores a same-PR specialist root with a different work key", async () => {
  const developer = prAssignment(1, {
    gitFacts: {
      relation: "authored",
      actionState: "action_now",
      nextAction: "address_review",
    },
  });
  developer.assignment.target = { type: "role", id: "developer" };
  developer.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  developer.assignment.reason = "authored-pr-self-fix";
  const fixture = await createFixture({ records: [developer] });
  await fixture.service.intake();

  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  const result = await fixture.service.intake();
  const [root] = (await fixture.service.listItems()).items;

  assert.equal(result.cursor, 2);
  assert.equal(root.currentTarget.id, "developer");
  assert.equal(root.source.identity.targetRoleId, "developer");
  assert.equal(root.source.scope.active, true);
});

async function inactiveRoleHandoffFixture(nextHead = PR_HEAD_B) {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"), specialistPrAssignment(2, "tester")] });
  await fixture.service.intake();
  fixture.source.records.push(specialistScopeExit(3));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const reentry = specialistPrAssignment(5, "developer", "authored", {
    eventType: "pull_request.created", occurredAt: "2026-08-02T01:20:00.000Z" });
  fixture.source.records.push(prScopeLifecycleAssignment(4, reentry.event), reentry);
  fixture.source.highWatermark = 5;
  await fixture.service.intake();
  const moved = specialistPrAssignment(6, "tester", "authored", {
    occurredAt: "2026-08-02T01:30:00.000Z", headRefOid: nextHead, previousHeadRefOid: PR_HEAD_A, changedFields: ["headRefOid"],
    gitFacts: { ...prGitFacts(nextHead), relation: "authored", actionState: "waiting_other",
      nextAction: "wait_merge", reviewDecision: "APPROVED", state: "open" } });
  fixture.source.records.push(moved);
  fixture.source.highWatermark = 6;
  await fixture.service.intake();
  return { ...fixture, moved };
}

for (const limit of [1, 100]) test(`host verified role handoff transfers inactive tester responsibility after developer reentry (limit=${limit})`, async () => {
  const fixture = await inactiveRoleHandoffFixture();
  const before = (await fixture.service.listItems()).items;
  const old = before.find(item => item.currentTarget.id === "developer");
  assert.equal(pullRequestHeadAdmission(fixture.store.stored(), old).current, true);
  const candidates = await fixture.service.readAutomaticRoleHandoffCandidates({ events: [fixture.moved.event] });
  assert.equal(candidates.length, 1);
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.role_handoff",
    occurredAt: "2026-08-02T01:40:00.000Z", source: fixture.moved.event.source, subject: fixture.moved.event.subject,
    payload: { ...fixture.moved.event.payload, roleHandoffProof: candidates[0].proofDigest } });
  fixture.source.records.push(prScopeLifecycleAssignment(7, event));
  fixture.source.highWatermark = 7;
  await fixture.service.intake({ limit });
  const roots = (await fixture.service.listItems()).items;
  const developer = roots.find(item => item.currentTarget.id === "developer");
  const tester = roots.find(item => item.currentTarget.id === "tester");
  assert.equal(developer.statusReason, "pr_source_cross_root_cutover_retired");
  assert.equal(tester.source.scope.active, true);
  assert.equal(tester.status, "queued");
  assert.equal(tester.source.current.headRefOid, PR_HEAD_B);
  assert.equal(tester.attempt, before.find(item => item.itemId === tester.itemId).attempt);
  assert.equal(pullRequestHeadAdmission(fixture.store.stored(), developer).current, false);
  assert.equal(pullRequestHeadAdmission(fixture.store.stored(), tester).current, true);
  const restarted = await createFixture({ store: fixture.store, source: fixture.source });
  assert.deepEqual((await restarted.service.listItems()).items, roots);
});

test("role handoff also transfers responsibility when approval changes without a new Head", async () => {
  const fixture = await inactiveRoleHandoffFixture(PR_HEAD_A);
  assert.equal((await fixture.service.readAutomaticRoleHandoffCandidates({ events: [fixture.moved.event] })).length, 1);
});

test("snapshot delta cannot invalidate its own verified role handoff before ledger intake", async () => {
  const fixture = await inactiveRoleHandoffFixture();
  const values = new Map();
  let recoverHandoff = false;
  const runtime = await createWorkflowRoutingRuntime({ workflowRouting: { schemaVersion: 1, enabled: true, maxHops: 8, rules: [] } }, {
    store: { async read(name, fallback) { return clone(values.get(name) ?? fallback); }, async write(name, value) { values.set(name, clone(value)); } },
    clock: () => "2026-08-02T01:51:00.000Z",
    createGuard: () => ({ async acquire() {}, run: operation => operation(), async close() {} }),
    roleHandoffReader: { async read({ events }) {
      if (!recoverHandoff) return [];
      const candidates = await fixture.service.readAutomaticRoleHandoffCandidates({ events });
      return candidates.map(({ event, proofDigest }) => normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.role_handoff",
        occurredAt: "2026-08-02T01:51:00.000Z", source: event.source, subject: event.subject,
        payload: { ...event.payload, roleHandoffProof: proofDigest } }));
    } },
  });
  try {
    const item = { ...fixture.moved.event.payload, kind: "pull_request", id: fixture.moved.event.subject.id,
      repo: "acme/repo", number: 42 };
    const snapshot = { refreshedAt: "2026-08-02T01:40:00.000Z", items: [item],
      sourceStatus: { githubPullRequests: { ok: true, complete: true, stale: false }, githubIssues: { ok: true } } };
    await runtime.ingestSnapshot({ snapshot });
    const oldFeed = await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 });
    recoverHandoff = true;
    await runtime.ingestSnapshot({ snapshot: { ...snapshot, refreshedAt: "2026-08-02T01:50:00.000Z",
      items: [{ ...item, title: "Approval with refreshed CI", ciStatus: "SUCCESS" }] } });
    const feed = await runtime.readAssignmentBatch({ afterSequence: oldFeed.nextSequence, limit: 100 });
    const records = feed.items.map((record, index) => ({ ...record, sequence: 7 + index }));
    fixture.source.records.push(...records);
    fixture.source.highWatermark = 6 + records.length;
    await fixture.service.intake();
    const roots = (await fixture.service.listItems()).items;
    assert.equal(roots.find(item => item.currentTarget.id === "tester").source.scope.active, true);
    assert.equal(roots.find(item => item.currentTarget.id === "developer").statusReason, "pr_source_cross_root_cutover_retired");
  } finally { await runtime.close(); }
});

test("role handoff preserves owner controls, provenance, independent authority and retained Head proof", async () => {
  const fixture = await inactiveRoleHandoffFixture();
  const original = fixture.store.stored();
  for (const variant of ["pause", "cancel", "rejected", "quarantine", "account", "branch", "unproven-head", "owner-authority"]) {
    const state = clone(original), event = clone(fixture.moved.event);
    const developer = state.items.find(item => item.currentTarget.id === "developer");
    const tester = state.items.find(item => item.currentTarget.id === "tester");
    if (variant === "pause") developer.status = "paused";
    if (variant === "cancel") tester.status = "cancelled";
    if (variant === "rejected") developer.statusReason = "proposal_rejected";
    if (variant === "quarantine") tester.sourceQuarantine = {};
    if (variant === "account") event.payload.gitTarget.sourceAccountId = "other-account";
    if (variant === "branch") event.payload.gitTarget.headRefName = "other/branch";
    if (variant === "unproven-head") event.payload.headRefOid = "c".repeat(40);
    if (variant === "owner-authority") {
      const ownerFixture = await createFixture({ records: [ownerRequestedPrAssignment(1, {
        occurredAt: "2026-08-02T01:35:00.000Z", headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B) })] });
      await ownerFixture.service.intake();
      const [owner] = (await ownerFixture.service.listItems()).items;
      owner.source.bindings[0].sourceSequence = 20;
      owner.source.current.sourceSequence = 20;
      state.items.push(owner);
    }
    assert.equal(automaticRoleHandoffCandidate(state, event), null, variant);
  }
});

test("a claim after host verification invalidates the role handoff proof without poisoning intake", async () => {
  const fixture = await inactiveRoleHandoffFixture();
  const [candidate] = await fixture.service.readAutomaticRoleHandoffCandidates({ events: [fixture.moved.event] });
  const developer = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "developer");
  await fixture.service.claim({ itemId: developer.itemId, expectedRevision: developer.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.role_handoff",
    occurredAt: "2026-08-02T01:40:00.000Z", source: fixture.moved.event.source, subject: fixture.moved.event.subject,
    payload: { ...fixture.moved.event.payload, roleHandoffProof: candidate.proofDigest } });
  fixture.source.records.push(prScopeLifecycleAssignment(7, event));
  fixture.source.highWatermark = 7;
  await fixture.service.intake();
  assert.equal((await fixture.service.listItems()).items.find(item => item.currentTarget.id === "tester").source.scope.active, false);
  assert.equal((await fixture.service.getSummary()).intakeCursor, 7);
});

test("role handoff fences a sealed predecessor child and resumes through normal cutover reconciliation", async () => {
  const fixture = await inactiveRoleHandoffFixture();
  const developer = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "developer");
  const sealed = await stageSealedPrChildReview(fixture);
  const [candidate] = await fixture.service.readAutomaticRoleHandoffCandidates({ events: [fixture.moved.event] });
  assert.ok(candidate);
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.role_handoff",
    occurredAt: "2026-08-02T01:40:00.000Z", source: fixture.moved.event.source, subject: fixture.moved.event.subject,
    payload: { ...fixture.moved.event.payload, roleHandoffProof: candidate.proofDigest } });
  fixture.source.records.push(prScopeLifecycleAssignment(7, event));
  fixture.source.highWatermark = 7;
  await fixture.service.intake();
  let tester = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "tester");
  assert.equal(tester.status, "blocked");
  assert.equal(tester.statusReason, `pr_source_cross_root_cutover_pending:${developer.itemId}`);
  assert.equal(tester.source.pendingRevision, null);
  await assert.rejects(fixture.service.claim({ itemId: tester.itemId, expectedRevision: tester.revision,
    workerId: "employee-tester", leaseDurationMs: 30_000 }));
  const restarted = await createFixture({ store: fixture.store, source: fixture.source });
  const child = (await restarted.service.listItems()).items.find(item => item.itemId === sealed.childItemId);
  assert.equal(child.activeIntentId, sealed.outbox.intentId);
  await restarted.service.ackIntent({ intentId: sealed.outbox.intentId, expectedRevision: sealed.outbox.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId, itemExpectedRevision: child.revision,
    actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "completed",
    details: { downstreamRef: "settled-child-review" } });
  tester = (await restarted.service.listItems()).items.find(item => item.itemId === tester.itemId);
  await restarted.service.reconcilePullRequestSource({ itemId: tester.itemId, expectedRevision: tester.revision,
    expectedGraphRevision: (await restarted.service.getSummary()).revision, expectedPendingRevision: tester.source.activeRevision });
  assert.equal((await restarted.service.listItems()).items.find(item => item.itemId === tester.itemId).status, "queued");
  assert.equal((await restarted.service.listItems()).items.find(item => item.itemId === developer.itemId).statusReason,
    "pr_source_cross_root_cutover_retired");
});

function specialistPrAssignment(sequence, roleId, relation = "authored", overrides = {}) {
  const payload = roleId === "developer"
    ? { relation, actionState: "action_now", nextAction: "address_review" }
    : { relation, actionState: "waiting_other", nextAction: "wait_merge",
        ...(relation === "authored" ? { reviewDecision: "APPROVED" } : { myReviewState: "APPROVED" }) };
  const record = prAssignment(sequence, { gitFacts: { ...prGitFacts(PR_HEAD_A), ...payload }, ...overrides });
  record.assignment.target = { type: "role", id: roleId };
  record.assignment.ruleId = roleId === "developer" ? AUTHORED_PR_SELF_FIX_RULE_ID
    : relation === "authored" ? AUTHORED_PR_APPROVED_RULE_ID : REVIEWED_PR_APPROVED_RULE_ID;
  record.assignment.reason = `trusted-pr-${roleId}`;
  return record;
}

for (const [roleId, relation] of [["developer", "authored"], ["tester", "authored"], ["tester", "review_requested"]]) {
  test(`trusted ${relation} scope exit revokes the automatic ${roleId} without a PR engineer root`, async () => {
    const fixture = await createFixture({ records: [specialistPrAssignment(1, roleId, relation)] });
    await fixture.service.intake();
    const before = (await fixture.service.listItems()).items[0];
    const oldBinding = prExecutionBinding(before);
    const leftEvent = prAssignment(2, { eventType: "pull_request.left_scope",
      occurredAt: "2026-08-02T01:05:00.000Z", headRefOid: PR_HEAD_B,
      gitFacts: { ...prGitFacts(PR_HEAD_B), relation } }).event;
    fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
    fixture.source.highWatermark = 2;

    const intake = await fixture.service.intake();
    const [inactive] = (await fixture.service.listItems()).items;

    assert.equal(intake.cursor, 2);
    assert.equal(inactive.currentTarget.id, roleId);
    assert.equal(inactive.source.scope.active, false);
    assert.equal(inactive.source.scope.lastLifecycleEventId, leftEvent.eventId);
    assert.equal(inactive.source.current.headRefOid, PR_HEAD_A);
    assert.equal(inactive.source.revisions.at(-1).disposition, "ignored_unproven_head");
    assert.equal(inactive.status, "blocked");
    assert.equal(inactive.statusReason, "pr_source_left_scope");
    assert.equal(inactive.attempt, before.attempt);
    await assert.rejects(fixture.service.verifyPullRequestExecutionBinding(oldBinding),
      error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
  });
}

function persistConsumedPrLifecycle(fixture, record) {
  const durable = fixture.store.stored();
  durable.intakeCursor = record.sequence;
  durable.sourceHighWatermark = record.sequence;
  fixture.store.replaceStored(durable);
}

test("normal recovery retires a specialist scope exit already consumed by the legacy role lookup exactly once", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer")] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const leftEvent = prAssignment(2, { eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z", headRefOid: PR_HEAD_B,
    gitFacts: { ...prGitFacts(PR_HEAD_B), relation: "authored" } }).event;
  const exit = prScopeLifecycleAssignment(2, leftEvent);
  fixture.source.records.push(exit);
  fixture.source.highWatermark = 2;
  persistConsumedPrLifecycle(fixture, exit);

  const restarted = await createFixture({ store: fixture.store, source: fixture.source });
  const [retired] = (await restarted.service.listItems()).items;
  assert.equal(retired.source.scope.active, false);
  assert.equal(retired.source.scope.lastLifecycleEventId, leftEvent.eventId);
  assert.equal(retired.source.current.headRefOid, PR_HEAD_A);
  assert.equal(retired.statusReason, "pr_source_left_scope");
  assert.equal(retired.attempt, before.attempt);
  assert.equal((await restarted.service.getSummary()).intakeCursor, 2);
  const writes = fixture.store.writes.length;
  const second = await createFixture({ store: fixture.store, source: fixture.source });
  assert.deepEqual((await second.service.listItems()).items[0], retired);
  assert.equal(fixture.store.writes.length, writes);
});

function specialistScopeExit(sequence, overrides = {}) {
  return prScopeLifecycleAssignment(sequence, prAssignment(sequence, {
    eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: { ...prGitFacts(PR_HEAD_A), relation: "authored" }, ...overrides,
  }).event);
}

for (const boundary of ["relation", "account", "branch", "discovery scope"]) {
  test(`trusted specialist scope exit preserves a different ${boundary}`, async () => {
    const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer")] });
    await fixture.service.intake();
    const before = (await fixture.service.listItems()).items[0];
    const exit = specialistScopeExit(2, boundary === "discovery scope" ? { sourceScopeId: "other-account" }
      : { gitFacts: { ...prGitFacts(PR_HEAD_A, boundary === "account" ? { sourceAccountId: "other-user" }
        : boundary === "branch" ? { headRefName: "other/branch" } : {}),
      relation: boundary === "relation" ? "review_requested" : "authored" } });
    fixture.source.records.push(exit);
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    assert.deepEqual((await fixture.service.listItems()).items[0], before);
  });
}

test("historical scope recovery reads a retained multi-page tail without moving the intake cursor", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer")] });
  await fixture.service.intake();
  const exit = specialistScopeExit(152);
  fixture.source.records = [...Array.from({ length: 100 }, (_, index) => assignment(index + 52)), exit];
  fixture.source.oldestAvailableSequence = 52;
  fixture.source.highWatermark = 152;
  fixture.source.override = request => {
    if (request.afterSequence < 51) {
      throw Object.assign(new Error("Old assignments retained from 52"), { code: "WORKFLOW_ASSIGNMENT_GAP", details: {
        afterSequence: request.afterSequence, expectedSequence: request.afterSequence + 1,
        oldestAvailableSequence: 52, highWatermark: 152,
      } });
    }
    const items = fixture.source.records.filter(record => record.sequence > request.afterSequence).slice(0, request.limit);
    return { items, nextSequence: items.at(-1)?.sequence ?? request.afterSequence, highWatermark: 152, oldestAvailableSequence: 52 };
  };
  persistConsumedPrLifecycle(fixture, exit);
  const recovered = await createFixture({ store: fixture.store, source: fixture.source });
  const [root] = (await recovered.service.listItems()).items;
  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.scope.lastLifecycleEventId, exit.event.eventId);
  assert.equal((await recovered.service.getSummary()).intakeCursor, 152);
  assert.deepEqual(fixture.source.calls.slice(-2), [{ afterSequence: 51, limit: 100 }, { afterSequence: 151, limit: 1 }]);
});

for (const failure of ["missing tail", "later page unavailable"]) {
  test(`historical scope recovery makes no partial write on ${failure} and retries normal intake`, async () => {
    const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer")] });
    await fixture.service.intake();
    const before = (await fixture.service.listItems()).items[0];
    const exit = specialistScopeExit(2);
    fixture.source.records.push(exit, ...Array.from({ length: 150 }, (_, index) => assignment(index + 3)));
    fixture.source.highWatermark = 152;
    persistConsumedPrLifecycle(fixture, { sequence: 152 });
    let tailReads = 0;
    fixture.source.override = request => {
      if (request.afterSequence >= 101 && request.afterSequence < 152) {
        tailReads += 1;
        if (tailReads > 1) throw new Error("Recovery repeated a non-advancing tail");
        if (failure === "later page unavailable") throw new Error("Retained source unavailable");
        return { items: [], nextSequence: request.afterSequence, highWatermark: 152, oldestAvailableSequence: 1 };
      }
      const items = fixture.source.records.filter(record => record.sequence > request.afterSequence).slice(0, request.limit);
      return { items, nextSequence: items.at(-1)?.sequence ?? request.afterSequence, highWatermark: 152, oldestAvailableSequence: 1 };
    };
    const writes = fixture.store.writes.length;
    const recovered = await createFixture({ store: fixture.store, source: fixture.source });
    assert.deepEqual((await recovered.service.listItems()).items[0], before);
    assert.equal(fixture.store.writes.length, writes);
    assert.equal(tailReads, 1, "an empty or unavailable tail stops without looping");
    fixture.source.override = null;
    await recovered.service.intake();
    assert.equal((await recovered.service.listItems()).items[0].source.scope.active, false);
    assert.equal((await recovered.service.getSummary()).intakeCursor, 152);
  });
}

test("historical scope recovery preserves a later trusted discovery reentry without granting authority", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer")] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items[0];
  const reentry = prScopeLifecycleAssignment(3, prAssignment(3, { eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z", gitFacts: { ...prGitFacts(PR_HEAD_A), relation: "authored" } }).event);
  fixture.source.records.push(specialistScopeExit(2), reentry);
  fixture.source.highWatermark = 3;
  persistConsumedPrLifecycle(fixture, reentry);
  const writes = fixture.store.writes.length;
  const recovered = await createFixture({ store: fixture.store, source: fixture.source });
  assert.deepEqual((await recovered.service.listItems()).items[0], before);
  assert.equal(fixture.store.writes.length, writes);
});

test("historical scope recovery cannot revoke a later specialist assignment when its old join history is missing", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"), assignment(2),
    specialistPrAssignment(3, "developer", "authored", { occurredAt: "2026-08-02T01:10:00.000Z" })] });
  await fixture.service.intake();
  const before = (await fixture.service.listItems()).items.find(root => root.kind === "source_root");
  assert.equal(before.source.bindings.at(-1).sourceSequence, 3);
  // The retained lifecycle predates the root's latest bound assignment; the
  // missing discovery join cannot be reconstructed into a fresh revocation.
  fixture.source.records = [specialistScopeExit(2), fixture.source.records[2]];
  fixture.source.oldestAvailableSequence = 2;
  const writes = fixture.store.writes.length;
  const recovered = await createFixture({ store: fixture.store, source: fixture.source });
  assert.deepEqual((await recovered.service.listItems()).items.find(root => root.itemId === before.itemId), before);
  assert.equal(fixture.store.writes.length, writes);
});

test("historical automatic scope retirement preserves explicit owner work and deliberately paused work", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"),
    specialistPrAssignment(2, "developer", "authored", { pullRequestNumber: 43 })] });
  await fixture.service.intake();
  let paused = (await fixture.service.listItems()).items.find(root => root.source.identity.pullRequestNumber === 43);
  paused = await fixture.service.controlModelRun({ itemId: paused.itemId,
    expectedRevision: paused.revision, leaseId: null, command: "pause" });
  fixture.source.records.push(ownerRequestedPrAssignment(3));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const owner = (await fixture.service.listItems()).items.find(root => root.source.scope.kind === "owner_requested");
  const exit = specialistScopeExit(4);
  fixture.source.records.push(exit, specialistScopeExit(5, { pullRequestNumber: 43 }));
  fixture.source.highWatermark = 5;
  persistConsumedPrLifecycle(fixture, { sequence: 5 });
  const recovered = await createFixture({ store: fixture.store, source: fixture.source });
  const roots = (await recovered.service.listItems()).items;
  assert.deepEqual(roots.find(root => root.itemId === owner.itemId), owner);
  assert.deepEqual(roots.find(root => root.itemId === paused.itemId), paused);
  const retired = roots.find(root => root.source.scope.kind === "automatic" && root.source.identity.pullRequestNumber === 42);
  assert.equal(retired.source.scope.active, false);
  assert.equal(retired.source.scope.lastLifecycleEventId, exit.event.eventId);
});

test("historical scope recovery keeps sealed unknown side effects fenced while revoking their source", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const sealed = await stageSealedPrReview(fixture);
  const before = (await fixture.service.listItems()).items[0];
  const outbox = (await fixture.service.listOutbox()).items;
  const oldBinding = prExecutionBinding(before);
  const exit = prScopeLifecycleAssignment(2, prAssignment(2, { eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z", gitFacts: prGitFacts(PR_HEAD_A) }).event);
  fixture.source.records.push(exit);
  fixture.source.highWatermark = 2;
  persistConsumedPrLifecycle(fixture, exit);
  const recovered = await createFixture({ store: fixture.store, source: fixture.source });
  const [root] = (await recovered.service.listItems()).items;
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "dispatch_pending");
  assert.equal(root.statusReason, "pr_source_left_scope_pending_settlement");
  assert.equal(root.activeIntentId, sealed.outbox.intentId);
  assert.equal(root.attempt, before.attempt);
  assert.deepEqual((await recovered.service.listOutbox()).items, outbox);
  await assert.rejects(recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    error => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE");
});

for (const recoveredExit of [false, true]) {
  test(`one trusted exit shared by automatic developer and tester preserves independent owner authority (recovery=${recoveredExit})`, async () => {
    const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"),
      specialistPrAssignment(2, "tester"), ownerRequestedPrAssignment(3)] });
    await fixture.service.intake();
    const owner = (await fixture.service.listItems()).items.find(root => root.source.scope.kind === "owner_requested");
    const ownerBinding = prExecutionBinding(owner);
    assert.deepEqual(await fixture.service.verifyPullRequestExecutionBinding(ownerBinding), ownerBinding);
    const exit = specialistScopeExit(4, { headRefOid: PR_HEAD_B,
      gitFacts: { ...prGitFacts(PR_HEAD_B), relation: "authored" } });
    fixture.source.records.push(exit);
    fixture.source.highWatermark = 4;
    if (recoveredExit) persistConsumedPrLifecycle(fixture, exit);
    else await fixture.service.intake();
    const restarted = await createFixture({ store: fixture.store, source: fixture.source });
    const roots = (await restarted.service.listItems()).items;
    assert.equal(roots.filter(root => root.source.scope.kind === "automatic" && !root.source.scope.active).length, 2);
    assert.deepEqual(roots.find(root => root.itemId === owner.itemId), owner);
    assert.deepEqual(await restarted.service.verifyPullRequestExecutionBinding(ownerBinding), ownerBinding);
  });
}

for (const limit of [1, 100]) for (const lifecycleFirst of [false, true]) for (const reentryHead of [PR_HEAD_A, PR_HEAD_B]) {
test(`shared lifecycle history admits only proven routed reentry (limit=${limit}, lifecycleFirst=${lifecycleFirst}, proven=${reentryHead === PR_HEAD_A})`, async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"), specialistPrAssignment(2, "tester")] });
  await fixture.service.intake();
  fixture.source.records.push(specialistScopeExit(3));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  const route = specialistPrAssignment(lifecycleFirst ? 5 : 4, "developer", "authored", {
    eventType: "pull_request.created", occurredAt: "2026-08-02T01:20:00.000Z", headRefOid: reentryHead,
    gitFacts: { ...prGitFacts(reentryHead), relation: "authored", actionState: "action_now", nextAction: "address_review" } });
  const lifecycle = prScopeLifecycleAssignment(lifecycleFirst ? 4 : 5, route.event);
  fixture.source.records.push(...(lifecycleFirst ? [lifecycle, route] : [route, lifecycle]));
  fixture.source.highWatermark = 5;
  await fixture.service.intake({ limit });
  if (limit === 1) {
    const intermediate = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "developer");
    if (lifecycleFirst) assert.equal(intermediate.status, "blocked");
    await assert.rejects(fixture.service.claim({ itemId: intermediate.itemId, expectedRevision: intermediate.revision,
      workerId: "employee-developer", leaseDurationMs: 30_000 }));
    await fixture.service.intake({ limit });
  }
  const root = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "developer");
  const tester = (await fixture.service.listItems()).items.find(item => item.currentTarget.id === "tester");
  assert.equal(tester.source.scope.active, false);
  if (reentryHead !== PR_HEAD_A) {
    assert.equal(root.source.scope.active, false);
    assert.equal(root.source.current.headRefOid, PR_HEAD_A);
    assert.equal(pullRequestHeadAdmission(fixture.store.stored(), root).current, false);
    return;
  }
  assert.equal(root.status, "queued");
  assert.equal(root.source.scope.active, true);
  const binding = prExecutionBinding(root);
  assert.deepEqual(await fixture.service.verifyPullRequestExecutionBinding(binding), binding);
  const restarted = await createFixture({ store: fixture.store, source: fixture.source });
  assert.deepEqual(await restarted.service.verifyPullRequestExecutionBinding(binding), binding);
});
}

test("a new trusted lifecycle anchor recognizes identical legacy PR engineer history without rewriting it", async () => {
  const engineer = prAssignment(3, { gitFacts: { ...prGitFacts(PR_HEAD_A), relation: "authored" } });
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"),
    specialistPrAssignment(2, "tester"), engineer, ownerRequestedPrAssignment(4)] });
  await fixture.service.intake();
  fixture.source.records.push(specialistScopeExit(5, { headRefOid: PR_HEAD_B,
    gitFacts: { ...prGitFacts(PR_HEAD_B), relation: "authored" } }));
  fixture.source.highWatermark = 5;
  await fixture.service.intake();
  const state = fixture.store.stored();
  const legacy = state.items.find(item => item.source.scope.kind === "automatic" && item.currentTarget.id === "pr-engineer");
  delete legacy.source.bindings.at(-1).scopeLifecycle;
  const legacyBefore = clone(legacy);
  const owner = state.items.find(item => item.source.scope.kind === "owner_requested");
  assert.notEqual(pullRequestTrustedPredecessor(state, owner), null);
  assert.equal(pullRequestHeadAdmission(state, owner).current, true);
  assert.deepEqual(legacy, legacyBefore);
  for (const invalidProof of ["all unmarked", "unmarked specialist", "duplicate role"]) {
    const altered = clone(state);
    const automatic = altered.items.filter(item => item.source.scope.kind === "automatic");
    if (invalidProof === "all unmarked") for (const item of automatic) delete item.source.bindings.at(-1).scopeLifecycle;
    if (invalidProof === "unmarked specialist") {
      automatic.find(item => item.currentTarget.id === "pr-engineer").source.bindings.at(-1).scopeLifecycle = true;
      delete automatic.find(item => item.currentTarget.id === "developer").source.bindings.at(-1).scopeLifecycle;
    }
    if (invalidProof === "duplicate role") altered.items.push(clone(automatic.find(item => item.currentTarget.id === "developer")));
    assert.equal(pullRequestTrustedPredecessor(altered, owner), null, invalidProof);
  }
  const route = specialistPrAssignment(6, "developer", "authored", {
    eventType: "pull_request.created", occurredAt: "2026-08-02T01:20:00.000Z" });
  fixture.source.records.push(route, prScopeLifecycleAssignment(7, route.event));
  fixture.source.highWatermark = 7;
  await fixture.service.intake();
  const reentered = fixture.store.stored();
  const historicalEngineer = reentered.items.find(item => item.itemId === legacy.itemId);
  delete historicalEngineer.source.bindings.find(binding => binding.eventId === legacy.source.scope.lastLifecycleEventId).scopeLifecycle;
  const developer = reentered.items.find(item => item.currentTarget.id === "developer");
  assert.notEqual(pullRequestTrustedPredecessor(reentered, developer), null);
  assert.equal(pullRequestHeadAdmission(reentered, developer).current, true);
});

test("shared lifecycle proof keeps legacy bindings intact and rejects conflicting or unmarked duplicate sequences", async () => {
  const fixture = await createFixture({ records: [specialistPrAssignment(1, "developer"),
    specialistPrAssignment(2, "tester"), ownerRequestedPrAssignment(3)] });
  await fixture.service.intake();
  fixture.source.records.push(specialistScopeExit(4, { headRefOid: PR_HEAD_B,
    gitFacts: { ...prGitFacts(PR_HEAD_B), relation: "authored" } }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  const state = fixture.store.stored();
  const automatic = state.items.filter(item => item.source.scope.kind === "automatic");
  const owner = state.items.find(item => item.source.scope.kind === "owner_requested");
  assert.notEqual(pullRequestTrustedPredecessor(state, owner), null);
  for (const item of automatic) {
    assert.equal(Object.hasOwn(item.source.bindings[0], "scopeLifecycle"), false);
    assert.equal(item.source.bindings.at(-1).scopeLifecycle, true);
  }
  for (const tamper of ["unmarked", "assignment digest", "event digest", "owner scope"]) {
    const altered = clone(state);
    const source = altered.items.find(item => item.itemId === automatic[0].itemId).source;
    if (tamper === "unmarked") delete source.bindings.at(-1).scopeLifecycle;
    if (tamper === "assignment digest") source.bindings.at(-1).assignmentDigest = "f".repeat(64);
    if (tamper === "event digest") source.revisions.at(-1).eventDigest = "f".repeat(64);
    if (tamper === "owner scope") source.scope.kind = "owner_requested";
    if (tamper === "assignment digest" || tamper === "event digest") {
      assert.doesNotThrow(() => normalizePullRequestWorkSource(source), "the duplicate authority check owns this conflict");
    }
    assert.equal(pullRequestTrustedPredecessor(altered, altered.items.find(item => item.itemId === owner.itemId)), null, tamper);
  }
  for (const invalidMarker of [false, "unknown", { kind: "scope" }]) {
    const source = clone(automatic[0].source);
    source.bindings.at(-1).scopeLifecycle = invalidMarker;
    assert.throws(() => normalizePullRequestWorkSource(source), error => error.code === "WORK_LEDGER_PR_SOURCE_INVALID");
  }
  const unknownField = clone(automatic[0].source);
  unknownField.bindings.at(-1).unknownLifecycleProof = true;
  assert.throws(() => normalizePullRequestWorkSource(unknownField), error => error.code === "WORK_LEDGER_PR_SOURCE_INVALID");
});

test("an authored PR can hand off from review to self-fix and then testing", async () => {
  const review = prAssignment(1, {
    gitFacts: {
      relation: "authored",
      actionState: "waiting_other",
      nextAction: "wait_review",
    },
  });
  const fixture = await createFixture({ records: [review] });
  await fixture.service.intake({ limit: 10 });

  const selfFix = prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: {
      relation: "authored",
      actionState: "action_now",
      nextAction: "address_review",
      reviewDecision: "CHANGES_REQUESTED",
    },
  });
  selfFix.assignment.target = { type: "role", id: "developer" };
  selfFix.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  selfFix.assignment.reason = "authored-pr-self-fix";
  fixture.source.records.push(selfFix);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });

  const testing = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    gitFacts: {
      ...prGitFacts(PR_HEAD_B, { headRefName: "fix/review-feedback" }),
      relation: "authored",
      actionState: "waiting_other",
      nextAction: "wait_merge",
      reviewDecision: "APPROVED",
    },
  });
  testing.assignment.target = { type: "role", id: "tester" };
  testing.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  testing.assignment.reason = "authored-pr-approved";
  fixture.source.records.push(testing);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });

  const roots = (await fixture.service.listItems({ limit: 10 })).items.filter(
    (item) => item.kind === "source_root",
  );
  const active = roots.filter((item) => item.status === "queued");
  assert.equal(active.length, 1);
  assert.equal(active[0].currentTarget.id, "tester");
  assert.equal(active[0].source.current.headRefOid, PR_HEAD_B);
  assert.equal(
    roots.filter(
      (item) =>
        item.status === "blocked" &&
        item.statusReason === "pr_source_cross_root_cutover_retired",
    ).length,
    2,
  );
});

test("automatic left-scope after an owner request revokes only the automatic source", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const ownerBeforeExit = roots.find(
    ({ source }) => source.scope.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(ownerBeforeExit);

  const leftEvent = prAssignment(3, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(3, leftEvent));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const automatic = roots.find(({ source }) => source.scope.kind === "automatic");
  assert.equal(owner.status, "queued");
  assert.equal(owner.source.scope.active, true);
  assert.equal(automatic.status, "blocked");
  assert.equal(automatic.source.scope.active, false);
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("cross-source assignment order outranks an older owner event timestamp", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      occurredAt: "2026-08-02T01:20:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);
  fixture.source.records.push(ownerRequestedPrAssignment(2, {
    occurredAt: "2026-08-02T01:10:00.000Z",
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("an owner-requested dual read anchors a new Head before automatic discovery catches up", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      headRefOid: PR_HEAD_A,
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  const automatic = (await fixture.service.listItems()).items[0];
  const automaticBinding = prExecutionBinding(automatic);
  fixture.source.records.push(ownerRequestedPrAssignment(2, {
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);
  assert.equal(owner.source.current.headRefOid, PR_HEAD_B);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(automaticBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("an unavailable automatic source cannot revoke a valid owner source", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const owner = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.scope?.kind === "owner_requested",
  );
  const ownerBinding = prExecutionBinding(owner);

  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(ownerBinding),
    ownerBinding,
  );
});

test("a retired owner source never revives its old binding when the successor is fenced", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const owner = roots.find(({ source }) => source.scope.kind === "owner_requested");
  const ownerBinding = prExecutionBinding(owner);

  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const automatic = roots.find(({ source }) => source.scope.kind === "automatic");
  const automaticBinding = prExecutionBinding(automatic);
  assert.equal(
    roots.find(({ source }) => source.scope.kind === "owner_requested")
      .statusReason,
    "pr_source_cross_root_cutover_retired",
  );

  fixture.source.records.push(prAssignment(4, {
    occurredAt: "2026-08-02T01:20:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  for (const binding of [ownerBinding, automaticBinding]) {
    await assert.rejects(
      fixture.service.verifyPullRequestExecutionBinding(binding),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
});

test("a forged PR scope lifecycle assignment cannot revoke automatic authority", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const forgedEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const forged = prScopeLifecycleAssignment(2, forgedEvent);
  forged.assignment.priority -= 1;
  const fixture = await createFixture({ records: [initial, forged] });

  await fixture.service.intake();
  const items = (await fixture.service.listItems()).items;
  const root = items.find(({ kind }) => kind === "source_root");

  assert.equal(root.source.scope.active, true);
  assert.equal(root.source.authorityEpoch, 1);
  assert.equal(items.length, 1);
  assert.equal((await fixture.service.getSummary()).intakeCursor, 2);
});

test("inactive PR scope and its authority epoch survive restart", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const source = new FakeAssignmentSource([
    initial,
    prScopeLifecycleAssignment(2, leftEvent),
  ]);
  const store = new MemoryStore();
  const first = await createFixture({ source, store });
  await first.service.intake();

  const recovered = await createFixture({ source, store });
  const root = (await recovered.service.listItems()).items[0];

  assert.equal(root.source.scope.active, false);
  assert.equal(root.source.authorityEpoch, 2);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_left_scope");
});

test("a re-entry route split across intake pages still restores queued work", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const created = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(3, created.event),
    created,
  );
  fixture.source.highWatermark = 4;

  await fixture.service.intake({ limit: 1 });
  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_reentered_scope_without_route");
  await fixture.service.intake({ limit: 1 });
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.statusReason, "pr_source_reentered_scope");
  assert.equal(root.source.authorityEpoch, 3);
});

test("a backlog may leave and re-enter PR scope in one atomic intake", async () => {
  const initial = prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake();
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  const created = prAssignment(4, {
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(
    prScopeLifecycleAssignment(2, leftEvent),
    prScopeLifecycleAssignment(3, created.event),
    created,
  );
  fixture.source.highWatermark = 4;

  await fixture.service.intake({ limit: 10 });
  const root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, true);
  assert.equal(root.source.scope.revision, 3);
  assert.equal(root.source.authorityEpoch, 3);
  assert.equal(root.status, "queued");
});

test("leaving PR scope atomically fails an unsealed pending action", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  const outbox = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.deepEqual((await fixture.service.listOutbox({ itemId: root.itemId, limit: 1 })).items, [outbox]);
  assert.deepEqual((await fixture.service.listOutbox({ itemId: "unrelated-work-item" })).items, []);
  await assert.rejects(fixture.service.listOutbox({ itemId: "" }));
  await assert.rejects(fixture.service.listOutbox({ itemId: root.itemId, unsupported: true }));
  assert.equal(root.status, "blocked");
  assert.equal(root.activeIntentId, null);
  assert.equal(outbox.status, "failed");
  assert.equal(
    outbox.outcome.details.reason,
    "pr_source_superseded_before_dispatch",
  );
});

test("a sealed action can settle after scope exit but cannot restore PR authority", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const oldBinding = prExecutionBinding(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "dispatch_pending");
  assert.equal(root.statusReason, "pr_source_left_scope_pending_settlement");
  assert.equal(root.activeIntentId, sealed.intentId);

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "sealed-before-left-scope" },
  });
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.scope.active, false);
  assert.equal(root.status, "completed");
  assert.equal(root.activeIntentId, null);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(
      oldBinding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("PR execution verification rereads shared durable state before every decision", async () => {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new FakeAssignmentSource([prAssignment(1)]);
  const first = await createFixture({ store, lease, source });
  await first.service.intake();
  const headAItem = (await first.service.listItems()).items[0];
  const headABinding = prExecutionBinding(headAItem);

  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBinding(headABinding),
    headABinding,
  );

  source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  source.highWatermark = 2;
  const second = await createFixture({ store, lease, source });
  await second.service.intake();
  const headBItem = (await second.service.listItems()).items[0];
  const headBBinding = prExecutionBinding(headBItem);

  await assert.rejects(
    first.service.verifyPullRequestExecutionBinding(headABinding),
    (error) => error?.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBinding(headBBinding),
    headBBinding,
  );
});

test("PR execution bindings are batch-verified against one exact ledger revision", async () => {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new FakeAssignmentSource([prAssignment(1)]);
  const first = await createFixture({ store, lease, source });
  await first.service.intake();
  const headAItem = (await first.service.listItems()).items[0];
  const headABinding = prExecutionBinding(headAItem);
  const headASnapshot = await first.service.readMemoryAuthoritySnapshot();

  source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  source.highWatermark = 2;
  const second = await createFixture({ store, lease, source });
  await second.service.intake();
  const headBItem = (await second.service.listItems()).items[0];
  const headBBinding = prExecutionBinding(headBItem);

  await assert.rejects(
    first.service.verifyPullRequestExecutionBindings({
      ledgerRevision: headASnapshot.ledgerRevision,
      bindings: [headABinding],
    }),
    (error) =>
      error?.code === "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE" &&
      error?.statusCode === 409,
  );
  const currentSnapshot = await first.service.readMemoryAuthoritySnapshot();
  assert.deepEqual(
    await first.service.verifyPullRequestExecutionBindings({
      ledgerRevision: currentSnapshot.ledgerRevision,
      bindings: [headABinding, headBBinding],
    }),
    {
      ledgerRevision: currentSnapshot.ledgerRevision,
      current: [false, true],
    },
  );
});

test("a new PR Head clears an answered old-Head decision while same-Head facts preserve it", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const attentionResult = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [attentionResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let root = (await fixture.service.listItems()).items[0];
  const oldHeadDecision = structuredClone(root.decisionContext);
  assert.equal(oldHeadDecision.source, "attention");
  assert.deepEqual(oldHeadDecision.value.answer, {
    type: "choice",
    choiceId: "yes",
  });

  fixture.source.records.push(
    prAssignment(2, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "SUCCESS",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.activeRevision, 2);
  assert.equal(root.source.headRevision, 1);
  assert.deepEqual(root.decisionContext, oldHeadDecision);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.activeRevision, 3);
  assert.equal(root.source.headRevision, 2);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.decisionContext, null);
});

test("a new PR Head clears a completed old-Head proposal result", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const proposalResult = await prepareProposalResult(fixture, {
    roleId: "pr-engineer",
    workerId: "employee-pr-engineer",
  });
  await fixture.service.applyProposalBatch({
    items: [proposalResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "completed");
  assert.equal(root.decisionContext.source, "proposal");

  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.decisionContext, null);
});

for (const claimedByDispatcher of [false, true]) {
  const stateName = claimedByDispatcher ? "unbound dispatching" : "pending";
  test(`a new PR Head atomically supersedes a ${stateName} old-Head intent`, async () => {
    const fixture = await createFixture({ records: [prAssignment(1)] });
    await fixture.service.intake();
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    const staged = await fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-engineer",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    });
    if (claimedByDispatcher) {
      await fixture.service.claimIntent({
        intentId: staged.outbox.intentId,
        expectedRevision: staged.outbox.revision,
        dispatcherId: "work-intent-dispatcher",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(
      prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: PR_HEAD_B,
        previousHeadRefOid: PR_HEAD_A,
        changedFields: ["headRefOid"],
      }),
    );
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    const root = (await fixture.service.listItems()).items[0];
    const outbox = (await fixture.service.listOutbox()).items[0];
    assert.equal(root.itemId, item.itemId);
    assert.equal(root.status, "queued");
    assert.equal(root.activeIntentId, null);
    assert.equal(root.source.activeRevision, 2);
    assert.equal(root.source.pendingRevision, null);
    assert.equal(root.source.current.headRefOid, PR_HEAD_B);
    assert.equal(outbox.status, "failed");
    assert.equal(outbox.sourceBinding.inputRevision, 1);
    assert.equal(outbox.sourceBinding.headRevision, 1);
    assert.equal(outbox.sourceBinding.headRefOid, PR_HEAD_A);
    assert.equal(
      outbox.outcome.details.reason,
      "pr_source_superseded_before_dispatch",
    );
    assert.equal(outbox.dispatchLeaseId, null);

    const recovered = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await recovered.recover();
    assert.equal(
      (await recovered.listOutbox()).items[0].sourceBinding.headRefOid,
      PR_HEAD_A,
    );
  });
}

test("a sealed old-Head intent blocks cutover until its result is reconciled", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const attentionResult = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [attentionResult],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let item = (await fixture.service.listItems()).items[0];
  assert.equal(item.decisionContext.source, "attention");
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  let root = (await fixture.service.listItems()).items[0];
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  assert.equal(root.activeIntentId, sealed.intentId);
  const pendingTimeline = (await fixture.service.listTimeline({
    limit: 100,
    order: "newest",
  })).items.find(({ type }) => type === "pr_source_revised");
  assert.deepEqual(
    {
      currentHeadRevision: pendingTimeline.details.currentHeadRevision,
      currentHeadRefOid: pendingTimeline.details.currentHeadRefOid,
      pendingHeadRevision: pendingTimeline.details.pendingHeadRevision,
      pendingHeadRefOid: pendingTimeline.details.pendingHeadRefOid,
    },
    {
      currentHeadRevision: 1,
      currentHeadRefOid: PR_HEAD_A,
      pendingHeadRevision: 2,
      pendingHeadRefOid: PR_HEAD_B,
    },
  );
  assert.equal(
    pendingTimeline.details.headRevision,
    pendingTimeline.details.currentHeadRevision,
  );
  assert.equal(
    pendingTimeline.details.headRefOid,
    pendingTimeline.details.currentHeadRefOid,
  );
  const writesBeforeBlockedReconciliation = fixture.store.writes.length;
  assert.deepEqual(
    await fixture.service.reconcilePullRequestSourceBatch({
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      items: [{
        itemId: root.itemId,
        expectedRevision: root.revision,
        expectedPendingRevision: 2,
      }],
    }),
    {
      outcomes: [{ itemId: root.itemId, status: "blocked" }],
      stoppedAfterWrite: false,
    },
  );
  assert.equal(fixture.store.writes.length, writesBeforeBlockedReconciliation);
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(blocked.applied, false);
  assert.deepEqual(blocked.blockers, [{
      itemId: root.itemId,
      status: "dispatch_pending",
      reason: "active_intent",
      activeIntentId: sealed.intentId,
    }]);
  assert.equal(fixture.store.writes.length, writesBeforeBlockedReconciliation);

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-1" },
  });
  root = (await fixture.service.listItems()).items[0];
  const activationCommand = {
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  assert.deepEqual(
    await fixture.service.reconcilePullRequestSourceBatch({
      expectedGraphRevision: activationCommand.expectedGraphRevision,
      items: [{
        itemId: activationCommand.itemId,
        expectedRevision: activationCommand.expectedRevision,
        expectedPendingRevision: activationCommand.expectedPendingRevision,
      }],
    }),
    {
      outcomes: [{ itemId: root.itemId, status: "applied" }],
      stoppedAfterWrite: true,
    },
  );
  const writesAfterActivation = fixture.store.writes.length;
  const timelineAfterActivation = (await fixture.service.listTimeline({
    limit: 100,
  })).items.length;
  const replay = await fixture.service.reconcilePullRequestSource(
    activationCommand,
  );
  assert.equal(replay.applied, false);
  assert.equal(replay.activeRevision, 2);
  assert.equal(fixture.store.writes.length, writesAfterActivation);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 100 })).items.length,
    timelineAfterActivation,
  );

  root = (await fixture.service.listItems()).items[0];
  const historical = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pending, null);
  assert.equal(root.decisionContext, null);
  assert.equal(historical.status, "delivered");
  assert.equal(historical.sourceBinding.headRefOid, PR_HEAD_A);
});

test("pending PR source discovery is filtered before paging and survives restart", async () => {
  const ordinary = Array.from({ length: 130 }, (_, index) =>
    assignment(index + 1, { type: "role", id: "requirements-analyst" })
  );
  const fixture = await createFixture({
    records: [...ordinary, prAssignment(131)],
  });
  await fixture.service.intake({ limit: 100 });
  await fixture.service.intake({ limit: 100 });
  let root = (await fixture.service.listItems({ limit: 100, order: "newest" }))
    .items.find(({ source }) => source?.kind === "pull_request");
  assert.ok(root);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(prAssignment(132, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 132;
  await fixture.service.intake({ limit: 100 });

  assert.equal(
    (await fixture.service.listItems({ limit: 100 })).items.some(
      ({ source }) =>
        source?.kind === "pull_request" && source.pendingRevision !== null,
    ),
    false,
  );
  let pending = await fixture.service.listPendingPullRequestSources({
    limit: 100,
  });
  assert.deepEqual(pending.items.map(({ itemId }) => itemId), [root.itemId]);
  assert.equal(pending.nextCursor, null);

  const recovered = await createFixture({
    source: fixture.source,
    store: fixture.store,
    time: fixture.time,
  });
  pending = await recovered.service.listPendingPullRequestSources({ limit: 1 });
  assert.deepEqual(pending.items.map(({ itemId }) => itemId), [root.itemId]);
  root = pending.items[0];
  await recovered.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    itemExpectedRevision: root.revision,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-paged" },
  });
  root = (await recovered.service.listPendingPullRequestSources({ limit: 1 }))
    .items[0];
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: (await recovered.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: root.source.pendingRevision,
  };
  const outcomes = await Promise.all([
    recovered.service.reconcilePullRequestSource(command),
    recovered.service.reconcilePullRequestSource(command),
  ]);
  assert.deepEqual(outcomes.map(({ applied }) => applied).sort(), [false, true]);
  assert.deepEqual(
    await recovered.service.listPendingPullRequestSources({ limit: 100 }),
    { items: [], nextCursor: null },
  );
});

async function stageSealedPrReview(fixture, itemId = null) {
  await fixture.service.intake();
  const items = (await fixture.service.listItems({ limit: 100 })).items;
  let root = itemId === null
    ? items[0]
    : items.find((item) => item.itemId === itemId);
  assert.notEqual(root, undefined);
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const outbox = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  return { outbox, rootItemId: staged.item.itemId };
}

async function stageSealedPrChildReview(fixture) {
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    roleId: "developer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const outbox = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "developer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  return { childItemId: child.itemId, outbox };
}

test("same-root cutover releases durably rejected attention", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const result = await prepareAttentionResult(
    fixture,
    { type: "reject", reason: "需求需要重新梳理" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  await fixture.service.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pendingRevision, null);
});

async function revokedCodeConfirmationFixture({ executed = false, createdJob = false, observedConfirmationStatus = null, legacyNullReference = false,
  conflict = false, reviseSource = true, failedPreparation = false, failureCode = 'CONTROLLED_GIT_PREFLIGHT_FAILED',
  fencedResult = false, sameHeadBaseChange = false, fencedEvidence = null } = {}) {
  let overrideSnapshot;
  let confirmationQueue;
  const reads = [];
  const confirmationSettlementReader = {
    read: async (input) => {
      reads.push(input);
      // A real callback into the ledger would deadlock if the service held its
      // ledger queue/lease while asking the confirmation queue for settlement.
      await fixture.service.readItemForReconciliation({ itemId: plan.requestedBy.workItemId });
      return overrideSnapshot === undefined
        ? confirmationQueue.readSettlement(input) : clone(overrideSnapshot);
    },
  };
  const record = authoredReviewRepairAssignment(1, conflict ? { gitFacts: {
    ...prGitFacts(PR_HEAD_A), relation: 'authored', actionState: 'action_now', nextAction: 'resolve_conflict', mergeStateStatus: 'DIRTY',
  } } : {});
  record.assignment.target = { type: "role", id: "developer" };
  const fixture = await createFixture({
    records: [record],
    confirmationSettlementReader,
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000,
  });
  const intent = codeActionIntent();
  const executionSource = conflict ? createConflictCodeExecutionSource({ inputBinding: prExecutionBinding(item),
    preparationBinding: createConflictPreparationBinding({ gitTarget: prExecutionBinding(item).gitTarget,
      preparation: { schemaVersion: 1, baseCommitOid: prExecutionBinding(item).gitTarget.baseRefOid,
      headCommitOid: prExecutionBinding(item).gitTarget.headRefOid, preparationId: '1'.repeat(64), boundaryDigest: '2'.repeat(64),
      evidenceDigest: '3'.repeat(64), mergeBaseOid: '4'.repeat(40), resultTreeOid: '5'.repeat(40),
      resultObjectDigest: '6'.repeat(64), status: 'conflicted', materialization: 'full-tree',
      conflicts: [{ path: 'src/app.js', mode: '100644' }] } }) }) : null;
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: "employee-developer", roleId: "developer", intent,
  });
  const content = {
    policyVersion: 1, kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: item.itemId },
    source: { assignmentId: item.assignmentId, eventId: item.event.eventId },
    binding: {
      eventId: item.event.eventId, subject: item.event.subject,
      repository: "acme/repo", workspaceId: "dashboard", inputBinding: prExecutionBinding(item),
      ...(executionSource === null ? {} : { executionSource }),
    },
    payload: Object.fromEntries(["operation", "objective", "acceptanceCriteria", "evidence", "summary", "reason"]
      .map((key) => [key, intent[key]])),
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId: `work-intent-${workProposalDigest(content)}`, ...content,
  });
  let outbox = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000,
  });
  outbox = await fixture.service.bindIntent({
    intentId: outbox.intentId, expectedRevision: outbox.revision,
    itemExpectedRevision: staged.item.revision, dispatcherId: outbox.dispatcherId,
    dispatchLeaseId: outbox.dispatchLeaseId,
    boundIntent: { intentId: proposal.proposalId, ...content },
  });
  await fixture.service.ackIntent({
    intentId: outbox.intentId, expectedRevision: outbox.revision,
    itemExpectedRevision: staged.item.revision, dispatchLeaseId: outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "waiting_external",
    details: { downstreamRef: proposal.proposalId, proposalDigest: proposal.contentDigest },
  });
  const grant = createCodeJobGrant({
    schemaVersion: conflict ? 3 : 2, proposalId: proposal.proposalId, contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion, requestedBy: proposal.requestedBy, source: proposal.source,
    subject: proposal.binding.subject, repository: proposal.binding.repository,
    workspaceId: proposal.binding.workspaceId, inputBinding: proposal.binding.inputBinding,
    ...(executionSource === null ? {} : { executionSource }),
    workspaceAuthorityDigest: "9".repeat(64), ...proposal.payload,
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: conflict ? ['src/app.js'] : ["src"],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
  const plan = normalizeConfirmationPlan(createCodeActionProposalConfirmationPlan(proposal, {
    grant, allowedOperationsByRole: { developer: ["modify"] },
  }));
  const jobs = new CodeJobStore({
    store: fixture.store, exclusiveLease: new ExclusiveLease(), clock: () => new Date(fixture.time.clock()),
    operationQueue: new OperationQueue(),
    memoryReceiptVerifier: { verify: async value => ({ ...clone(value), persisted: true }) },
  });
  await jobs.recover();
  confirmationQueue = new ConfirmationQueue({
    store: fixture.store, exclusiveLease: new ExclusiveLease(), clock: () => new Date(fixture.time.clock()),
    executor: createdJob
      ? new CodeJobApprovalExecutor({ codeJobStore: jobs, grantVerifier: { verify: async (value) => value } })
      : { execute: async () => ({ status: "stale" }), reconcile: async () => ({ status: "unknown" }) },
  });
  await confirmationQueue.recover();
  const { displayedPayloadDigest: _display, approvalBindingDigest: _binding, ...queuePlan } = plan;
  const queued = await confirmationQueue.enqueue(queuePlan);
  if (executed || createdJob) {
    await confirmationQueue.approve(queued.id, {
      requestId: "request-executed-stale", expectedQueueRevision: queued.queueRevision,
      expectedItemRevision: queued.itemRevision, displayedPayloadDigest: queued.displayedPayloadDigest,
      approvalBindingDigest: queued.approvalBindingDigest,
    });
  } else {
    await confirmationQueue.invalidate(queued.id, {
      requestedBy: queued.requestedBy, approvalBindingDigest: queued.approvalBindingDigest,
      reason: "authorization_changed",
    });
  }
  if (createdJob) {
    const job = (await jobs.list()).items[0];
    if (failedPreparation || fencedResult) {
      const failed = await jobs[fencedResult ? 'fence' : 'fail']({ jobId: job.jobId, expectedRevision: job.revision,
        result: { code: fencedResult ? 'INVALID_CODE_JOB_AUTHORITY' : failureCode,
          message: fencedResult ? 'The bound Base changed' : 'Mirror preflight failed before any action' } });
      await jobs.markMemoryProjected({ jobId: job.jobId, expectedRevision: failed.job.revision,
        sourceRecordDigest: failed.job.recordDigest, memoryRecordId: `memory-${'8'.repeat(64)}`, memoryRecordDigest: '8'.repeat(64) });
    } else {
      await jobs.pause({ jobId: job.jobId, expectedRevision: job.revision,
        reason: "等待人工处理（CODE_BRAIN_RESPONSE_INVALID）" });
    }
  }
  const snapshot = await confirmationQueue.readSettlement({ confirmationId: queued.id });
  const failedJob = failedPreparation || fencedResult ? await jobs.get(snapshot.item.receipt.id) : null;
  const result = createWorkProposalResult({
    proposal, sequence: 1, at: fixture.time.clock(), downstreamRef: legacyNullReference ? null : plan.id,
    transition: failedPreparation || fencedResult ? { status: fencedResult ? 'unknown' : 'failed',
      summary: fencedResult ? '本地代码任务已停止' : '本地代码任务执行失败', evidence: fencedEvidence ?? [
      `confirmation:${plan.id}`, `code-job:${failedJob.jobId}`, `code-job-status:${fencedResult ? 'fenced' : 'failed'}`, `memory:${failedJob.memoryProjection.recordId}`,
    ] } : { status: "stale", summary: "旧确认已安全撤销", evidence: [
      `confirmation:${plan.id}`, "authorization_changed", `old_confirmation_status:${observedConfirmationStatus ?? (createdJob ? "completed" : "stale")}`,
    ] },
  });
  await fixture.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1,
    oldestAvailableSequence: 1 });
  const update = authoredReviewRepairAssignment(2, {
    occurredAt: "2026-08-02T01:15:00.000Z", ciStatus: "SUCCESS", title: "Updated PR facts",
    ...(createdJob ? sameHeadBaseChange ? { gitFacts: { ...prGitFacts(PR_HEAD_A, { baseRefOid: 'e'.repeat(40) }),
      relation: 'authored', actionState: 'action_now', nextAction: 'resolve_conflict', mergeStateStatus: 'DIRTY' },
      changedFields: ['gitTarget'] } : { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"] } : {}),
  });
  update.assignment.target = record.assignment.target;
  if (reviseSource) {
    fixture.source.records.push(update);
    fixture.source.highWatermark = 2;
    assert.equal((await fixture.service.intake()).error, undefined);
  }
  item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  if (reviseSource) assert.notEqual(item.source.pendingRevision, null);
  // Reproduce the retained state from earlier source intake: only the reason
  // was replaced; the proposal decision and its latest result remain intact.
  if (!createdJob) {
    const durable = fixture.store.stored();
    durable.items.find(({ itemId }) => itemId === item.itemId).statusReason = "pr_source_revised";
    fixture.store.replaceStored(durable);
  }
  fixture.service = new WorkLedgerService({
    store: fixture.store, assignmentSource: fixture.source, exclusiveLease: fixture.lease,
    clock: fixture.time.clock, idFactory: incrementingIds(), confirmationSettlementReader,
  });
  await fixture.service.recover();
  item = (await fixture.service.listItems()).items[0];
  return { ...fixture, item, proposal, plan, snapshot, reads, confirmationQueue, jobs,
    replaceSnapshot: (next) => { overrideSnapshot = next; },
    command: {
      itemId: item.itemId, expectedRevision: item.revision,
      expectedPendingRevision: item.source.pendingRevision,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
    },
  };
}

function stoppedFenceRun(job) {
  return { kind: 'code-job', taskId: job.jobId, roleId: job.requestedBy.roleId, runId: 'settled-native-fence',
    active: false, mode: 'active', pendingCommand: null, receipt: { kind: 'code-job', taskId: job.jobId,
      roleId: job.requestedBy.roleId, runId: 'settled-native-fence', phase: 'failed', stopConfirmed: true,
      finishedAt: job.updatedAt, outcomeCode: 'INVALID_CODE_JOB_AUTHORITY', session: { transport: 'app-server' } } };
}

test("host ancestry reaches pending after restart while the old unknown executor still blocks cutover", async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, reviseSource: false });
  const original = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
  const job = await f.jobs.get(f.snapshot.item.receipt.id), oldJob = clone(job), oldBoxes = (await f.service.listOutbox({ itemId: original.itemId })).items;
  const oldEvent = currentWorkItemEvent(original);
  const exit = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:20:00.000Z",
    source: oldEvent.source, subject: oldEvent.subject, payload: oldEvent.payload });
  f.source.records.push(prScopeLifecycleAssignment(2, exit)); f.source.highWatermark = 2;
  await f.service.intake();
  const input = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed", occurredAt: "2026-08-02T01:30:00.000Z",
    source: oldEvent.source, subject: oldEvent.subject, payload: { ...oldEvent.payload, author: "runtime-user", assignees: ["runtime-user"],
      state: "open", isDraft: false, relation: "authored", actionState: "action_now", nextAction: "address_review",
      headRefOid: PR_HEAD_B, ...prGitFacts(PR_HEAD_B) } });
  const producer = new AutomaticHeadAncestryReader({ account: "runtime-user", clock: f.time.clock,
    ledger: { readCandidates: options => f.service.readHostHeadAncestryCandidates(options),
      readItemForReconciliation: options => f.service.readItemForReconciliation(options) },
    github: { isCommitAncestor: async () => true, readPullRequestRoleHandoffFacts: async () => ({
      state: "open", isDraft: false, author: "runtime-user", assignees: ["runtime-user"], gitTarget: input.payload.gitTarget }) },
    record: credential => f.service.recordHostHeadAncestry(credential) });
  const events = await producer.read({ events: [input] });
  assert.equal(events.length, 2);
  const proven = f.store.stored();
  assert.ok(proven.items.find(item => item.itemId === original.itemId).source.headAncestryReceipt);
  await f.service.recover();
  const bridge = authoredReviewRepairAssignment(3);
  bridge.event = clone(events[0]); bridge.assignment.eventId = events[0].eventId;
  f.source.records.push(bridge, prScopeLifecycleAssignment(4, events[1])); f.source.highWatermark = 4;
  await f.service.intake();
  let root = await f.service.readItemForReconciliation({ itemId: original.itemId });
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B, "proof stores the real target without executing it");
  assert.equal(root.decisionContext.outcome, "unknown");
  assert.equal((await f.service.listItems()).items.filter(item => item.kind === "source_root").length, 1);
  const run = stoppedFenceRun(job); run.receipt.stopConfirmed = false; run.receipt.phase = "unknown"; run.receipt.finishedAt = null;
  f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
    codeJobControl: { cancel: async () => assert.fail("An unknown old execution cannot be cancelled or replayed") },
    taskRuns: { get: async () => clone(run) } });
  const command = () => ({ itemId: root.itemId, expectedRevision: root.revision, expectedPendingRevision: root.source.pendingRevision,
    expectedGraphRevision: f.store.stored().revision });
  const blocked = await f.service.reconcilePullRequestSource(command());
  assert.equal(blocked.applied, false);
  await assert.rejects(f.service.claim({ itemId: root.itemId, expectedRevision: root.revision, workerId: "employee-developer", leaseDurationMs: 30000 }),
    error => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING");
  await assert.rejects(f.service.verifyPullRequestExecutionBinding(f.proposal.binding.inputBinding), { code: "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" });
  assert.deepEqual(await f.jobs.get(job.jobId), oldJob);
  assert.deepEqual((await f.service.listOutbox({ itemId: original.itemId })).items, oldBoxes);
  await f.service.recover();
  root = await f.service.readItemForReconciliation({ itemId: original.itemId });
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  assert.equal((await f.service.reconcilePullRequestSource(command())).applied, false, "restart cannot manufacture stop proof");
  Object.assign(run.receipt, stoppedFenceRun(job).receipt);
  assert.equal((await f.service.reconcilePullRequestSource(command())).applied, true, "only the existing strict stopped-executor settlement can activate it");
  root = await f.service.readItemForReconciliation({ itemId: original.itemId });
  assert.equal(root.source.current.headRefOid, PR_HEAD_B); assert.equal(root.source.pendingRevision, null);
  assert.equal(root.status, "queued");
  assert.deepEqual(await f.jobs.get(job.jobId), oldJob);
  assert.deepEqual((await f.service.listOutbox({ itemId: original.itemId })).items, oldBoxes);
});

for (const variant of ["source-input-race", "other-authority-race", "other-root", "failed-write"]) {
  test(`host ancestry private writer burns a credential on failed consumption (${variant})`, async () => {
    const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, reviseSource: false });
    const old = currentWorkItemEvent(f.item);
    const exit = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:20:00.000Z",
      source: old.source, subject: old.subject, payload: old.payload });
    f.source.records.push(prScopeLifecycleAssignment(2, exit)); f.source.highWatermark = 2; await f.service.intake();
    const input = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed", occurredAt: "2026-08-02T01:30:00.000Z",
      source: old.source, subject: old.subject, payload: { ...old.payload, author: "runtime-user", assignees: ["runtime-user"],
        state: "open", isDraft: false, relation: "authored", actionState: "action_now", nextAction: "address_review",
        headRefOid: PR_HEAD_B, ...prGitFacts(PR_HEAD_B) } });
    let captured;
    const producer = new AutomaticHeadAncestryReader({ account: "runtime-user", clock: f.time.clock,
      ledger: { readCandidates: options => f.service.readHostHeadAncestryCandidates(options),
        readItemForReconciliation: options => f.service.readItemForReconciliation(options) },
      github: { isCommitAncestor: async () => true, readPullRequestRoleHandoffFacts: async () => ({
        state: "open", isDraft: false, author: "runtime-user", assignees: ["runtime-user"], gitTarget: input.payload.gitTarget }) },
      record: async credential => {
        captured = credential;
        if (variant === "other-root") return (await createFixture()).service.recordHostHeadAncestry(credential);
        if (variant === "source-input-race") {
          const changed = authoredReviewRepairAssignment(3, { occurredAt: "2026-08-02T01:25:00.000Z",
            gitFacts: { ...prGitFacts(PR_HEAD_A), relation: "authored", actionState: "action_now", nextAction: "address_review" }, ciStatus: "FAILURE" });
          f.source.records.push(changed); f.source.highWatermark = 3; await f.service.intake();
        }
        if (variant === "other-authority-race") {
          f.source.records.push(ownerRequestedPrAssignment(3, { occurredAt: "2026-08-02T01:25:00.000Z", headRefOid: PR_HEAD_A }));
          f.source.highWatermark = 3; await f.service.intake();
        }
        if (variant === "failed-write") {
          const write = f.store.write.bind(f.store); let failed = false;
          f.store.write = async (key, value) => {
            if (!failed && key === STATE_KEY) { failed = true; throw new Error("Fixture unavailable store"); }
            return write(key, value);
          };
        }
        return f.service.recordHostHeadAncestry(credential);
      } });
    assert.deepEqual(await producer.read({ events: [input] }), []);
    assert.ok(captured);
    assert.equal(await f.service.recordHostHeadAncestry(captured), null, "failed consumption cannot be replayed");
    assert.equal(await f.service.recordHostHeadAncestry(JSON.parse(JSON.stringify(captured))), null);
    assert.equal((await f.service.readItemForReconciliation({ itemId: f.item.itemId })).source.headAncestryReceipt, undefined);
  });
}

test("real Head ancestry candidate pages give a later provable root a bounded opportunity", async () => {
  const records = Array.from({ length: 5 }, (_, index) => authoredReviewRepairAssignment(index + 1, { pullRequestNumber: 41 + index }));
  const f = await createFixture({ records }); await f.service.intake();
  const initial = (await f.service.listItems()).items.filter(item => item.kind === "source_root");
  let sequence = 5;
  for (const root of initial) {
    const old = currentWorkItemEvent(root);
    const exit = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:20:00.000Z",
      source: old.source, subject: old.subject, payload: old.payload });
    f.source.records.push(prScopeLifecycleAssignment(++sequence, exit));
  }
  f.source.highWatermark = sequence; await f.service.intake();
  const roots = (await f.service.listItems()).items.filter(item => item.kind === "source_root").sort((a, b) => a.itemId.localeCompare(b.itemId));
  const events = roots.map((root, index) => {
    const old = currentWorkItemEvent(root), head = (index + 11).toString(16).repeat(40);
    return normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed", occurredAt: "2026-08-02T01:30:00.000Z",
      source: old.source, subject: old.subject, payload: { ...old.payload, author: "runtime-user", assignees: ["runtime-user"], state: "open",
        isDraft: false, relation: "authored", actionState: "action_now", nextAction: "address_review", headRefOid: head, ...prGitFacts(head) } });
  });
  let calls = 0;
  const reader = new AutomaticHeadAncestryReader({ account: "runtime-user", clock: f.time.clock,
    ledger: { readCandidates: options => f.service.readHostHeadAncestryCandidates(options),
      readItemForReconciliation: options => f.service.readItemForReconciliation(options) },
    github: { isCommitAncestor: async ({ headRefOid }) => { calls++; return headRefOid === events[4].payload.headRefOid; },
      readPullRequestRoleHandoffFacts: async ({ number }) => { calls++; const event = events.find(e => e.subject.number === number);
        return { state: "open", isDraft: false, author: "runtime-user", assignees: ["runtime-user"], gitTarget: event.payload.gitTarget }; } },
    record: credential => f.service.recordHostHeadAncestry(credential) });
  let emitted = [];
  for (let round = 0; round < 3; round++) {
    const before = calls; emitted.push(...await reader.read({ events })); assert.ok(calls - before <= 6);
  }
  assert.equal(emitted.length, 2);
  assert.ok((await f.service.readItemForReconciliation({ itemId: roots[4].itemId })).source.headAncestryReceipt);
  assert.equal((await f.service.listItems()).items.filter(root => root.source?.headAncestryReceipt).length, 1);
});

test("host ancestry proof cannot write after configuration admission closes", async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, reviseSource: false });
  const old = currentWorkItemEvent(f.item);
  const exit = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:20:00.000Z",
    source: old.source, subject: old.subject, payload: old.payload });
  f.source.records.push(prScopeLifecycleAssignment(2, exit)); f.source.highWatermark = 2; await f.service.intake();
  const gate = readyActionAdmissionGate();
  const { service } = await createFixture({ source: f.source, store: f.store, time: f.time, actionAdmissionGate: gate });
  const input = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed", occurredAt: "2026-08-02T01:30:00.000Z",
    source: old.source, subject: old.subject, payload: { ...old.payload, author: "runtime-user", assignees: ["runtime-user"], state: "open",
      isDraft: false, relation: "authored", actionState: "action_now", nextAction: "address_review", headRefOid: PR_HEAD_B, ...prGitFacts(PR_HEAD_B) } });
  const github = { isCommitAncestor: async () => true, readPullRequestRoleHandoffFacts: async () => ({
    state: "open", isDraft: false, author: "runtime-user", assignees: ["runtime-user"], gitTarget: input.payload.gitTarget }) };
  const readerFor = (ledger, record) => new AutomaticHeadAncestryReader({ account: "runtime-user", clock: f.time.clock, github, record,
    ledger: { readCandidates: options => ledger.readHostHeadAncestryCandidates(options),
      readItemForReconciliation: options => ledger.readItemForReconciliation(options) } });
  const before = f.store.stored();
  let deniedCredential;
  const reader = readerFor(service, async credential => {
    deniedCredential = credential;
    await activateNextConfiguration(gate);
    return service.recordHostHeadAncestry(credential);
  });
  assert.deepEqual(await reader.read({ events: [input] }), [], "a restart-required gate must prevent proof events");
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(service.intake(), { code: "RUNTIME_RESTART_REQUIRED" });
  assert.deepEqual(f.store.stored(), before, "denied proof cannot write a receipt, revision, or timeline event");
  assert.equal(await service.recordHostHeadAncestry(deniedCredential), null);
  assert.equal(await service.recordHostHeadAncestry(JSON.parse(JSON.stringify(deniedCredential))), null);
  assert.equal(reader.readDiagnostics().lastFailure, "RUNTIME_RESTART_REQUIRED");
  const recoveredGate = new ActionAdmissionGate();
  recoveredGate.bindEffective({ version: 2, configurationDigest: "2".repeat(64) });
  const recovered = await createFixture({ source: f.source, store: f.store, time: f.time, actionAdmissionGate: recoveredGate });
  assert.equal(await recovered.service.recordHostHeadAncestry(deniedCredential), null, "recovery cannot revive a rejected token");
  let freshCredential;
  const fresh = readerFor(recovered.service, credential => {
    freshCredential = credential;
    return recovered.service.recordHostHeadAncestry(credential);
  });
  const events = await fresh.read({ events: [input] });
  assert.equal(events.length, 2); assert.notStrictEqual(freshCredential, deniedCredential);
  const after = f.store.stored(), root = after.items.find(item => item.itemId === f.item.itemId);
  assert.equal(after.revision, before.revision + 1); assert.ok(root.source.headAncestryReceipt);
  assert.deepEqual(root.decisionContext, before.items.find(item => item.itemId === root.itemId).decisionContext);
  assert.equal(root.status, "blocked", "fresh lineage proof still cannot resume the old unknown execution");
});

test('a stopped authority-fenced proposal_unknown activates a new Base after restart without rewriting its old outcome', async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, sameHeadBaseChange: true });
  const job = await f.jobs.get(f.snapshot.item.receipt.id), beforeJob = clone(job), beforeConfirmation = clone(f.snapshot.item);
  const root = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
  const decision = clone(root.decisionContext), boxes = (await f.service.listOutbox({ itemId: root.itemId })).items;
  assert.equal(root.statusReason, 'proposal_unknown');
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.current.event.payload.gitTarget.baseRefOid, 'd'.repeat(40));
  assert.equal(root.source.pending.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
  const run = stoppedFenceRun(job);
  f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
    codeJobControl: { cancel: async () => assert.fail('A terminal job must not be resumed or cancelled') },
    taskRuns: { get: async () => clone(run) } });
  const result = await f.service.reconcilePullRequestSource(f.command);
  assert.equal(result.applied, true, 'The exact stopped fence must settle the historical proposal_unknown');
  const next = await f.service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(next.status, 'queued');
  assert.equal(next.source.pendingRevision, null);
  assert.equal(next.source.current.headRefOid, PR_HEAD_A);
  assert.equal(next.source.current.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
  assert.deepEqual(await f.jobs.get(job.jobId), beforeJob);
  assert.deepEqual((await f.confirmationQueue.readSettlement({ confirmationId: f.plan.id })).item, beforeConfirmation);
  const historical = (await f.service.listOutbox({ itemId: root.itemId })).items;
  assert.deepEqual(historical, boxes);
  assert.equal(decision.outcome, 'unknown');
  const timeline = f.store.stored().timeline.filter(entry => entry.itemId === root.itemId && entry.type === 'proposal_result_applied');
  assert.equal(timeline.at(-1).details.decision.outcome, 'unknown');
  await f.service.recover();
  const stable = await f.service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(stable.status, 'queued');
  assert.equal((await f.service.reconcilePullRequestSource({ itemId: stable.itemId, expectedRevision: stable.revision,
    expectedPendingRevision: stable.source.activeRevision, expectedGraphRevision: (await f.service.getSummary()).revision })).applied, false);
});

test('proposal_unknown cutover keeps missing stop evidence, unsettled execution and mismatched history fenced', async t => {
  for (const variant of ['missing-run', 'active-run', 'unconfirmed-stop', 'stop-unconfirmed', 'pending-command',
    'wrong-run-job', 'wrong-run-role', 'wrong-run-id', 'wrong-transport', 'missing-finish', 'changed-run', 'changed-job',
    'missing-detail', 'wrong-terminal-code', 'archived-history', 'partial-history', 'memory-mismatch',
    'wrong-confirmation', 'wrong-receipt', 'unknown-action', 'unsettled-write', 'cloned-proof', 'changed-proof']) await t.test(variant, async () => {
    const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, sameHeadBaseChange: true });
    const originalJob = await f.jobs.get(f.snapshot.item.receipt.id), originalRoot = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
    const job = clone(originalJob), detail = await f.jobs.getDetail({ jobId: job.jobId, limit: 1 }), run = stoppedFenceRun(job);
    if (variant === 'active-run') run.active = true;
    if (variant === 'unconfirmed-stop') run.receipt.stopConfirmed = false;
    if (variant === 'stop-unconfirmed') run.stopUnconfirmed = true;
    if (variant === 'pending-command') run.pendingCommand = { type: 'cancel' };
    if (variant === 'wrong-run-job') run.taskId = 'another-job';
    if (variant === 'wrong-run-role') run.roleId = 'tester';
    if (variant === 'wrong-run-id') run.runId = 'another-run';
    if (variant === 'wrong-transport') run.receipt.session.transport = 'untrusted';
    if (variant === 'missing-finish') run.receipt.finishedAt = null;
    if (variant === 'wrong-terminal-code') detail.terminalDetail.code = 'CODE_ACTION_RESULT_UNKNOWN';
    if (variant === 'archived-history') detail.archived = true;
    if (variant === 'partial-history') detail.nextCursor = 'unread-history';
    if (variant === 'memory-mismatch') job.memoryProjection.recordId = `memory-${'f'.repeat(64)}`;
    if (variant === 'unknown-action') Object.assign(job, { status: 'unknown', terminalResult: null, memoryProjection: null,
      pendingActionType: 'write_text', uncertainty: { from: 'active', code: 'CODE_ACTION_RESULT_UNKNOWN', message: 'Possible write', at: job.updatedAt } });
    if (variant === 'unsettled-write') {
      Object.assign(job, { turn: 1, observationCount: 1,
        latestObservation: { actionType: 'write_text', status: 'succeeded', recordedAt: job.updatedAt } });
      detail.observations = [{ actionType: 'write_text', status: 'succeeded' }];
    }
    detail.job = clone(job);
    if (['wrong-confirmation', 'wrong-receipt'].includes(variant)) {
      const snapshot = clone(f.snapshot);
      if (variant === 'wrong-confirmation') snapshot.item.approvalBindingDigest = 'f'.repeat(64);
      else snapshot.item.receipt.id = 'code-job-another';
      f.replaceSnapshot(snapshot);
    }
    let reads = 0, jobReads = 0;
    const reader = { get: async () => {
      const value = clone(job);
      if (variant === 'changed-job' && jobReads++ > 0) value.revision++;
      return value;
    }, ...(variant === 'missing-detail' ? {} : { getDetail: async () => clone(detail) }) };
    f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: reader,
      codeJobControl: { cancel: async () => assert.fail('Unproven fenced execution must not be cancelled') },
      taskRuns: variant === 'missing-run' ? null : { get: async () => {
        const value = clone(run);
        if (variant === 'changed-run') value.receipt.finishedAt = new Date(Date.parse(run.receipt.finishedAt) + reads++).toISOString();
        return value;
      } } });
    if (['cloned-proof', 'changed-proof'].includes(variant)) {
      const raw = await f.jobs.getForWorker(job.jobId);
      const proof = await f.service.obsoleteCodeJobSettler.read({ grant: raw.grant, receipt: f.snapshot.item.receipt });
      assert.equal(hasStoppedCodeJobAuthorityFence(proof), true);
      const forwarded = variant === 'cloned-proof' ? clone(proof) : proof;
      if (variant === 'changed-proof') forwarded.revision++;
      assert.equal(hasStoppedCodeJobAuthorityFence(forwarded), false);
      f.service.obsoleteCodeJobSettler = { read: async () => forwarded, settle: async () => forwarded };
    }
    assert.equal((await f.service.reconcilePullRequestSource(f.command)).applied, false);
    assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.item.itemId }), originalRoot);
    assert.deepEqual(await f.jobs.get(originalJob.jobId), originalJob);
  });
});

test('proposal_unknown requires the exact code-job, fenced status and memory references from its sealed result', async t => {
  for (const variant of ['wrong-job-reference', 'wrong-memory-reference', 'wrong-status-reference', 'extra-reference']) await t.test(variant, async () => {
    const base = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, sameHeadBaseChange: true });
    const references = clone(base.item.decisionContext.value.evidence);
    if (variant === 'wrong-job-reference') references[1] = 'code-job:code-job-another';
    if (variant === 'wrong-memory-reference') references[3] = `memory:memory-${'f'.repeat(64)}`;
    if (variant === 'wrong-status-reference') references[2] = 'code-job-status:failed';
    if (variant === 'extra-reference') references.push('owner-approval');
    const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, sameHeadBaseChange: true, fencedEvidence: references });
    const job = await f.jobs.get(f.snapshot.item.receipt.id), root = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
    f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
      codeJobControl: { cancel: async () => assert.fail('The old result must remain intact') }, taskRuns: { get: async () => stoppedFenceRun(job) } });
    assert.equal((await f.service.reconcilePullRequestSource(f.command)).applied, false);
    assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.item.itemId }), root);
  });
});

test('proposal_unknown cannot use an unstarted stale confirmation and missing job as native stop proof', async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, fencedResult: true, sameHeadBaseChange: true });
  const root = await f.service.readItemForReconciliation({ itemId: f.item.itemId }), snapshot = clone(f.snapshot);
  snapshot.item.status = 'stale';
  snapshot.item.receipt = null;
  snapshot.item.execution.outcome = 'stale';
  f.replaceSnapshot(snapshot);
  f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: { get: async () => null },
    codeJobControl: { cancel: async () => assert.fail('A missing job is not native stop proof for an unknown result') } });
  assert.equal((await f.service.reconcilePullRequestSource(f.command)).applied, false);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.item.itemId }), root);
});

test('optional native proof errors preserve old stale settlement but keep proposal_unknown fenced', async t => {
  for (const unknownResult of [false, true]) await t.test(unknownResult ? 'unknown' : 'stale', async () => {
    const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, sameHeadBaseChange: true, fencedResult: unknownResult });
    let job = await f.jobs.get(f.snapshot.item.receipt.id);
    if (!unknownResult) {
      await f.jobs.fence({ jobId: job.jobId, expectedRevision: job.revision, result: { code: 'INVALID_CODE_JOB_AUTHORITY' } });
      job = await f.jobs.get(job.jobId);
    }
    const root = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
    f.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
      codeJobControl: { cancel: async () => assert.fail('A failed optional reader cannot authorize a mutation') },
      taskRuns: { get: async () => { throw Object.assign(new Error('Native reader temporarily unavailable'), { code: 'TASK_RUN_READER_UNAVAILABLE' }); } } });
    assert.equal((await f.service.reconcilePullRequestSource(f.command)).applied, !unknownResult);
    if (unknownResult) assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.item.itemId }), root);
    assert.deepEqual(await f.jobs.get(job.jobId), job);
  });
});

test('a normally settled proposal_failed conflict preparation requeues once without rewriting its failed job or confirmation', async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, reviseSource: false, failedPreparation: true });
  const job = (await f.jobs.list()).items[0], before = await f.jobs.get(job.jobId);
  const item = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
  assert.equal(item.statusReason, 'proposal_failed');
  assert.equal(item.decisionContext.outcome, 'failed');
  const outbox = (await f.service.listOutbox({ itemId: item.itemId })).items[0];
  assert.equal(outbox.outcome.details.resultAttestation.payload.outcome, 'failed');
  const confirmation = await f.confirmationQueue.get(f.plan.id);
  const refreshedPreparation = { ...clone(job.executionSource.preparationBinding), preparationId: '7'.repeat(64) };
  f.time.advance(1_000);
  const recovery = new AutomaticOwnPrConflictRecovery({ store: f.store, ledger: f.service,
    confirmationSettlementReader: f.service.confirmationSettlementReader, codeJobReader: f.jobs,
    current: async () => true, prepareInspection: async request => {
      assert.equal(request.force, true);
      return { inputBinding: job.inputBinding, preparationBinding: refreshedPreparation, conflicts: refreshedPreparation.conflicts };
    } });
  await recovery.recover();
  assert.equal((await recovery.runCycle()).requeued, 1);
  const queued = await f.service.readItemForReconciliation({ itemId: item.itemId });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.attempt, item.attempt);
  assert.deepEqual(await f.jobs.get(job.jobId), before);
  assert.deepEqual(await f.confirmationQueue.get(f.plan.id), confirmation);
  assert.deepEqual((await f.service.listOutbox({ itemId: item.itemId })).items[0], outbox);
  const failedContext = await new FailedCodeJobContextReader({ codeJobReader: f.jobs, ledger: f.service }).read({
    itemId: queued.itemId, inputBinding: job.inputBinding, decisionContext: queued.decisionContext });
  assert.equal(failedContext.ownerRetry, null);
  assert.deepEqual(failedContext.automaticRecovery, { at: queued.updatedAt, reason: 'automatic_conflict_material_recovered',
    failureCode: 'CONTROLLED_GIT_PREFLIGHT_FAILED', jobId: job.jobId,
    preparationId: refreshedPreparation.preparationId, headRefOid: job.inputBinding.headRefOid });
  await recovery.recover();
  assert.equal((await recovery.runCycle()).requeued, 0);
});

test('normal failed conflict preparation recovery preserves invalid proofs, changed inputs and possible effects', async t => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, reviseSource: false, failedPreparation: true });
  const before = await f.jobs.get(f.snapshot.item.receipt.id), original = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
  const boxes = (await f.service.listOutbox({ itemId: original.itemId })).items;
  const originalDetail = await f.jobs.getDetail({ jobId: before.jobId, limit: 1 });
  for (const variant of ['genuine-execution-failure', 'missing-confirmation', 'confirmation-binding', 'wrong-receipt',
    'wrong-job-evidence', 'wrong-memory-evidence', 'job-memory-changed', 'unsealed-result', 'changed-decision', 'changed-input', 'unknown-outbox',
    'archived-history', 'partial-history', 'observed-action', 'written-job', 'uncertain-job', 'job-changed',
    'current-authority-revoked', 'source-revised-during-prepare', 'owner-paused', 'leased', 'delivered']) {
    await t.test(variant, async () => {
      const item = clone(original), outboxes = clone(boxes), snapshot = clone(f.snapshot), job = clone(before), detail = clone(originalDetail);
      if (variant === 'genuine-execution-failure') detail.terminalDetail.code = 'CODE_BRAIN_RESPONSE_INVALID';
      if (variant === 'confirmation-binding') snapshot.item.approvalBindingDigest = 'f'.repeat(64);
      if (variant === 'wrong-receipt') snapshot.item.receipt.id = 'code-job-another';
      if (variant === 'wrong-job-evidence') item.decisionContext.value.evidence[1] = 'code-job:code-job-another';
      if (variant === 'wrong-memory-evidence') item.decisionContext.value.evidence[3] = `memory:memory-${'f'.repeat(64)}`;
      if (variant === 'job-memory-changed') {
        job.memoryProjection.recordId = `memory-${'f'.repeat(64)}`;
        detail.job = clone(job);
      }
      if (variant === 'unsealed-result') delete outboxes[0].outcome.details.resultAttestation;
      if (variant === 'changed-decision') item.decisionContext.value.summary = 'Unsealed replacement result';
      if (variant === 'changed-input') item.inputDigest = 'f'.repeat(64);
      if (variant === 'unknown-outbox') outboxes.push({ ...clone(outboxes[0]), intentId: 'unknown-intent', status: 'unknown' });
      if (variant === 'archived-history') detail.archived = true;
      if (variant === 'partial-history') detail.nextCursor = 'unread-history';
      if (variant === 'observed-action') detail.observations.push({ actionType: 'write_text' });
      if (variant === 'written-job') {
        job.turn = 1; job.observationCount = 1;
        job.latestObservation = { actionType: 'write_text', status: 'succeeded', recordedAt: job.updatedAt };
        detail.job = clone(job); detail.observations = [{ actionType: 'write_text', status: 'succeeded' }];
      }
      if (variant === 'uncertain-job') {
        job.status = 'unknown'; job.terminalResult = null; job.memoryProjection = null; job.pendingActionType = 'write_text';
        job.uncertainty = { from: 'active', code: 'CODE_ACTION_RESULT_UNKNOWN', message: 'Write effect is unknown', at: job.updatedAt };
        detail.job = clone(job);
      }
      if (variant === 'job-changed') detail.job.revision++;
      if (variant === 'owner-paused') item.status = 'paused';
      if (variant === 'leased') item.leaseId = 'another-lease';
      if (variant === 'delivered') item.graph.deliveries.push({ deliveryId: 'existing-delivery' });
      const recovery = new AutomaticOwnPrConflictRecovery({ store: f.store,
        ledger: { listItems: async () => ({ items: [clone(item)], nextCursor: null }),
          listOutbox: async () => ({ items: clone(outboxes), nextCursor: null }), readItemForReconciliation: async () => clone(item),
          transition: async () => assert.fail('Unproven recovery must not transition') },
        confirmationSettlementReader: { read: async () => variant === 'missing-confirmation' ? null : clone(snapshot) },
        codeJobReader: { get: async () => clone(job), getDetail: async () => clone(detail) },
        current: async () => variant !== 'current-authority-revoked', prepareInspection: async () => {
          if (variant === 'source-revised-during-prepare') item.revision++;
          return { inputBinding: before.inputBinding, preparationBinding: before.executionSource.preparationBinding,
            conflicts: before.executionSource.preparationBinding.conflicts };
        } });
      await recovery.recover();
      assert.deepEqual(await recovery.runCycle(), { scanned: ['owner-paused', 'leased', 'delivered'].includes(variant) ? 0 : 1, requeued: 0, failed: 0 });
      assert.deepEqual(await f.jobs.get(before.jobId), before);
      assert.deepEqual(await f.service.readItemForReconciliation({ itemId: original.itemId }), original);
    });
  }
});

test('normal failed conflict preparation recovery shares the durable three-attempt budget and resumes only its prepared record', async t => {
  for (const { prior, status, requeued } of [{ prior: 2, requeued: 1 }, { prior: 3, requeued: 0 },
    { prior: 3, status: 'prepared', requeued: 1 }, { prior: 3, status: 'requeued', requeued: 0 }]) {
    await t.test(`${prior} prior recoveries, ${status ?? 'new failure'}`, async () => {
      const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, reviseSource: false, failedPreparation: true });
      const job = await f.jobs.get(f.snapshot.item.receipt.id), key = 'automatic-own-pr-conflict-recovery-state';
      await f.store.write(key, { schemaVersion: 1, records: Array.from({ length: prior }, (_, index) => ({
        itemId: f.item.itemId, inputBinding: job.inputBinding, failureRef: status && index === prior - 1 ? job.jobId : `previous-failure-${index}`,
        attempt: index + 1, status: status && index === prior - 1 ? status : 'requeued',
      })) });
      const recovery = new AutomaticOwnPrConflictRecovery({ store: f.store, ledger: f.service,
        confirmationSettlementReader: f.service.confirmationSettlementReader, codeJobReader: f.jobs,
        current: async () => true, prepareInspection: async () => {
          assert.equal(requeued, 1, 'Exhausted or acknowledged recovery must not prepare');
          return { inputBinding: job.inputBinding, preparationBinding: job.executionSource.preparationBinding,
            conflicts: job.executionSource.preparationBinding.conflicts };
        } });
      await recovery.recover();
      assert.equal((await recovery.runCycle()).requeued, requeued);
      assert.equal((await f.service.readItemForReconciliation({ itemId: f.item.itemId })).status, requeued ? 'queued' : 'blocked');
      const saved = await f.store.read(key);
      assert.equal(saved.records.length, status || !requeued ? prior : prior + 1);
      assert.equal(Math.max(...saved.records.map(record => record.attempt)), 3);
      assert.deepEqual(await f.jobs.get(job.jobId), job);
    });
  }
});

test('a sealed, unstarted preflight failure requeues the same current conflict root without rewriting old results', async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, reviseSource: false });
  let job = (await f.jobs.list()).items[0];
  await f.jobs.fail({ jobId: job.jobId, expectedRevision: job.revision,
    result: { code: 'CONTROLLED_GIT_PREFLIGHT_FAILED', message: 'Mirror preflight failed' } });
  job = await f.jobs.getForWorker(job.jobId);
  const before = await f.jobs.get(job.jobId), confirmation = await f.confirmationQueue.get(f.plan.id);
  const proof = await new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
    codeJobControl: { cancel: async () => assert.fail('recovery must not cancel') } }).read({ grant: job.grant, receipt: f.snapshot.item.receipt });
  assert.equal(hasUnstartedCodeJobPreparationFailure(proof), true);
  assert.equal(hasUnstartedCodeJobAuthorityFence(proof), false);
  assert.equal(hasUnstartedCodeJobPreparationFailure(clone(proof)), false);
  proof.turn++;
  assert.equal(hasUnstartedCodeJobPreparationFailure(proof), false);
  const recovery = new AutomaticOwnPrConflictRecovery({ store: f.store, ledger: f.service,
    confirmationSettlementReader: f.service.confirmationSettlementReader, codeJobReader: f.jobs,
    current: async () => true, prepareInspection: async () => ({ inputBinding: job.grant.inputBinding,
      preparationBinding: job.grant.executionSource.preparationBinding,
      conflicts: job.grant.executionSource.preparationBinding.conflicts }) });
  await recovery.recover();
  assert.equal((await recovery.runCycle()).requeued, 1);
  assert.equal((await f.service.readItemForReconciliation({ itemId: f.item.itemId })).status, 'queued');
  assert.deepEqual(await f.jobs.get(job.jobId), before);
  assert.deepEqual(await f.confirmationQueue.get(f.plan.id), confirmation);
  const restarted = new AutomaticOwnPrConflictRecovery({ store: f.store, ledger: f.service,
    confirmationSettlementReader: f.service.confirmationSettlementReader, codeJobReader: f.jobs,
    current: async () => true, prepareInspection: async () => assert.fail('already recovered') });
  await restarted.recover();
  assert.equal((await restarted.runCycle()).requeued, 0);
});

for (const variant of ['other-failure', 'job-paused', 'archived-history', 'partial-history', 'observed-action',
  'binding-changed', 'current-authority-revoked', 'source-revised-during-prepare']) {
  test(`unstarted conflict failure recovery preserves ${variant}`, async () => {
    const f = await revokedCodeConfirmationFixture({ createdJob: true, conflict: true, reviseSource: false });
    let job = (await f.jobs.list()).items[0];
    if (variant !== 'job-paused') await f.jobs.fail({ jobId: job.jobId, expectedRevision: job.revision,
      result: { code: variant === 'other-failure' ? 'INVALID_CODE_JOB_AUTHORITY' : 'CONTROLLED_GIT_PREFLIGHT_FAILED' } });
    job = await f.jobs.getForWorker(job.jobId);
    const before = await f.jobs.get(job.jobId);
    const reader = { get: id => f.jobs.get(id), getDetail: async request => {
      const detail = await f.jobs.getDetail(request);
      if (variant === 'archived-history') detail.archived = true;
      if (variant === 'partial-history') detail.nextCursor = 'unread-history';
      if (variant === 'observed-action') detail.observations.push({ actionType: 'write_text' });
      if (variant === 'binding-changed') detail.job.revision++;
      return detail;
    } };
    let revisedRoot = null;
    const recovery = new AutomaticOwnPrConflictRecovery({ store: f.store, ledger: f.service,
      confirmationSettlementReader: f.service.confirmationSettlementReader, codeJobReader: reader,
      current: async () => variant !== 'current-authority-revoked', prepareInspection: async () => {
        if (variant === 'source-revised-during-prepare') {
          const update = authoredReviewRepairAssignment(2, { headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
            changedFields: ['headRefOid'], occurredAt: '2026-08-02T01:15:00.000Z' });
          f.source.records.push(update); f.source.highWatermark = 2;
          await f.service.intake();
          revisedRoot = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
        }
        return { inputBinding: job.grant.inputBinding, preparationBinding: job.grant.executionSource.preparationBinding,
          conflicts: job.grant.executionSource.preparationBinding.conflicts };
      } });
    await recovery.recover();
    assert.equal((await recovery.runCycle()).requeued, 0);
    assert.deepEqual(await f.jobs.get(job.jobId), before);
    const root = await f.service.readItemForReconciliation({ itemId: f.item.itemId });
    if (revisedRoot !== null) assert.deepEqual(root, revisedRoot);
    else assert.equal(root.status, 'blocked');
  });
}

test("a paused old-Head code job is settled after restart and the updated PR becomes claimable", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  const oldJob = (await fixture.jobs.list()).items[0];
  assert.equal(oldJob.status, "paused");
  let cancellations = 0;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: { get: (id) => fixture.jobs.get(id) },
    codeJobControl: {
      cancel: async (request) => {
        // The callback must run outside the ledger transaction.
        await fixture.service.getSummary();
        cancellations += 1;
        return fixture.jobs.cancel(request);
      },
    },
  });
  const result = await fixture.service.reconcilePullRequestSource(fixture.command);
  assert.equal(result.applied, true, "a settled old job must not permanently fence the next Head");
  const next = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(next.source.current.headRefOid, PR_HEAD_B);
  assert.equal(next.source.pendingRevision, null);
  assert.equal(next.status, "queued");
  assert.equal((await fixture.jobs.get(oldJob.jobId)).status, "cancelled");
  assert.equal((await fixture.confirmationQueue.get(fixture.plan.id)).status, "completed");
  assert.equal(cancellations, 1);
  const claimed = await fixture.service.claim({ itemId: next.itemId, expectedRevision: next.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  assert.equal(claimed.status, "working");
});

for (const status of ["failed", "cancelled", "fenced"]) {
  test(`an already ${status} old-Head job preserves its terminal result during PR source recovery`, async () => {
    const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
    const job = (await fixture.jobs.list()).items[0];
    const request = { jobId: job.jobId, expectedRevision: job.revision };
    if (status === "cancelled") await fixture.jobs.cancel({ ...request, reason: "Owner cancelled" });
    else await fixture.jobs[status === "failed" ? "fail" : "fence"]({ ...request, result: { code: "OLD_JOB_STOPPED" } });
    const before = await fixture.jobs.get(job.jobId);
    fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
      codeJobReader: fixture.jobs,
      codeJobControl: { cancel: async () => { assert.fail("a terminal job must not be cancelled again"); } },
    });
    const result = await fixture.service.reconcilePullRequestSource(fixture.command);
    assert.equal(result.applied, status !== "fenced");
    assert.deepEqual(await fixture.jobs.get(job.jobId), before);
  });
}

test("an unstarted authority-fenced old-Head job releases only with its exact terminal detail", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  const job = (await fixture.jobs.list()).items[0];
  await fixture.jobs.fence({ jobId: job.jobId, expectedRevision: job.revision,
    result: { code: "INVALID_CODE_JOB_AUTHORITY", message: "Old PR Head is no longer current" } });
  const before = await fixture.jobs.get(job.jobId);
  const settleWith = reader => new ObsoleteCodeJobSettler({ codeJobReader: reader,
    codeJobControl: { cancel: async () => assert.fail("a terminal fence must remain intact") } });
  fixture.service.obsoleteCodeJobSettler = settleWith({ get: id => fixture.jobs.get(id) });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
  for (const variant of ["wrong-code", "missing-detail", "archived", "incomplete", "changed-revision", "observed-action"]) {
    const projection = structuredClone(before);
    if (variant === "observed-action") {
      projection.turn = 1;
      projection.observationCount = 1;
      projection.latestObservation = { actionType: "read_text", status: "succeeded", recordedAt: projection.updatedAt };
    }
    fixture.service.obsoleteCodeJobSettler = settleWith({ get: async () => structuredClone(projection),
      getDetail: async request => {
        const detail = await fixture.jobs.getDetail(request);
        detail.job = structuredClone(projection);
        if (variant === "wrong-code") detail.terminalDetail.code = "OWNER_STOPPED";
        if (variant === "missing-detail") return null;
        if (variant === "archived") detail.archived = true;
        if (variant === "incomplete") detail.nextCursor = "unread-history";
        if (variant === "changed-revision") detail.job.revision += 1;
        return detail;
      } });
    assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false, variant);
  }
  fixture.service.obsoleteCodeJobSettler = settleWith(fixture.jobs);
  const storedJob = await fixture.jobs.getForWorker(job.jobId);
  const marked = await fixture.service.obsoleteCodeJobSettler.read({ grant: storedJob.grant, receipt: fixture.snapshot.item.receipt });
  assert.equal(hasUnstartedCodeJobAuthorityFence(marked), true);
  assert.equal(hasUnstartedCodeJobAuthorityFence(structuredClone(marked)), false);
  marked.turn = 1;
  assert.equal(hasUnstartedCodeJobAuthorityFence(marked), false);
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.deepEqual(await fixture.jobs.get(job.jobId), before);
  const next = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(next.source.current.headRefOid, PR_HEAD_B);
  assert.equal(next.source.pendingRevision, null);
});

test("an admitted old-Head job keeps the next Head fenced until cancellation is settled", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  let job = (await fixture.jobs.list()).items[0];
  await fixture.jobs.resume({ jobId: job.jobId, expectedRevision: job.revision });
  job = await fixture.jobs.get(job.jobId);
  await fixture.jobs.claimStarting({ jobId: job.jobId, expectedRevision: job.revision });
  let cancellations = 0;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async (request) => { cancellations += 1; return fixture.jobs.cancel(request); } },
  });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const result = await fixture.service.reconcilePullRequestSource(fixture.command);
    assert.equal(result.applied, false);
    assert.equal((await fixture.jobs.get(job.jobId)).status, "cancelling");
    const root = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
    assert.equal(root.source.current.headRefOid, PR_HEAD_A);
    assert.notEqual(root.source.pendingRevision, null);
  }
  assert.equal(cancellations, 1);
});

async function stoppedStartedFenceFixture({ unexecutedWrite = false } = {}) {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  let job = (await fixture.jobs.list()).items[0];
  await fixture.jobs.resume({ jobId: job.jobId, expectedRevision: job.revision });
  job = await fixture.jobs.get(job.jobId);
  let result = await fixture.jobs.claimStarting({ jobId: job.jobId, expectedRevision: job.revision });
  result = await fixture.jobs.activate({ jobId: job.jobId, expectedRevision: result.job.revision, workspaceRevision: "4".repeat(64) });
  result = await fixture.jobs.prepareAction({ jobId: job.jobId, expectedRevision: result.job.revision,
    action: { type: "read_text", actionId: "old-read", path: "src/app.js", expectedWorkspaceRevision: "4".repeat(64) } });
  result = await fixture.jobs.recordObservation({ jobId: job.jobId, expectedRevision: result.job.revision,
    actionId: "old-read", status: "succeeded", workspaceRevision: "4".repeat(64), detail: { path: "src/app.js", content: "old" } });
  if (unexecutedWrite) {
    result = await fixture.jobs.prepareAction({ jobId: job.jobId, expectedRevision: result.job.revision,
      action: { type: "write_text", actionId: "rejected-write", path: "src/app.js", content: "never written",
        expectedSha256: "5".repeat(64), expectedWorkspaceRevision: "4".repeat(64) } });
    result = await fixture.jobs.recordObservation({ jobId: job.jobId, expectedRevision: result.job.revision,
      actionId: "rejected-write", status: "failed", workspaceRevision: "4".repeat(64),
      detail: { schemaVersion: 1, origin: "host_pre_execution_rejection", notExecuted: true,
        result: { bytes: 0, error: { code: "CODE_ARTIFACT_READ_INCOMPLETE", message: "Rejected before admission" } } } });
  }
  await fixture.jobs.fence({ jobId: job.jobId, expectedRevision: result.job.revision, result: { code: "INVALID_CODE_JOB_AUTHORITY" } });
  job = await fixture.jobs.get(job.jobId);
  const run = { kind: "code-job", taskId: job.jobId, roleId: job.requestedBy.roleId, runId: "stopped-native",
    active: false, mode: "active", pendingCommand: null, receipt: { kind: "code-job", taskId: job.jobId,
      roleId: job.requestedBy.roleId, runId: "stopped-native", phase: "failed", stopConfirmed: true,
      finishedAt: job.updatedAt, session: { transport: "app-server" } } };
  const session = { id: job.jobId, workspaceId: job.workspaceId, requestedBy: structuredClone(job.requestedBy),
    inputBinding: structuredClone(job.inputBinding), executionSource: structuredClone(job.executionSource), status: "interrupted", revision: 1,
    workspaceRevision: "4".repeat(64), attempt: { number: 1, status: "interrupted" }, cleanupPending: false,
    actions: [{ id: "old-read", type: "read_text", status: "succeeded", workspaceRevisionAfter: "4".repeat(64) }], updatedAt: job.updatedAt };
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async () => assert.fail("a settled terminal fence must not be rewritten") },
    taskRuns: { get: async () => structuredClone(run) }, codeExecutorReader: { view: async () => structuredClone(session) } });
  return { ...fixture, job, run, session };
}

test("a started authority-fenced job releases the next PR generation only after native and executor settlement", async () => {
  const fixture = await stoppedStartedFenceFixture();
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  const root = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pendingRevision, null);
  assert.equal(root.status, "queued");
  assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
});

async function restoredAuthorityFenceFixture({ denied = false, cleanupFailure = false, changeControl = false, corruptProof = false } = {}) {
  const fixture = await stoppedStartedFenceFixture();
  fixture.run.runId = fixture.run.receipt.runId = "restored-preflight";
  fixture.run.receipt.stopConfirmed = false;
  fixture.run.receipt.session = null;
  fixture.run.receipt.outcomeCode = 'INVALID_CODE_JOB_AUTHORITY';
  fixture.session.status = fixture.session.attempt.status = "active";
  fixture.session.sourceRevision = "3".repeat(64);
  let cleanups = 0, held = false;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async () => assert.fail("the original fenced result must survive") },
    taskRuns: { get: async () => structuredClone(fixture.run) },
    codeExecutorReader: { view: async () => structuredClone(fixture.session) },
    nativeExecution: { withEntityQuiescence: async (grant, operation) => {
      assert.equal(grant.grantDigest, fixture.job.grantDigest);
      if (denied) return { executed: false };
      held = true;
      try { return { executed: true, result: await operation() }; } finally { held = false; }
    } },
    codeExecutorControl: { reconcileCancellation: async request => {
      assert.equal(held, true, "native exclusion must remain held through cleanup");
      cleanups++;
      assert.equal(request.sessionId, fixture.job.jobId);
      assert.equal(request.expectedWorkspaceRevision, fixture.session.workspaceRevision);
      assert.deepEqual(request.inputBinding, fixture.job.inputBinding);
      assert.equal(request.expectedAction, null);
      if (cleanupFailure && cleanups === 1) {
        fixture.session.status = fixture.session.attempt.status = "cancelling";
        fixture.session.revision++;
        throw Object.assign(new Error("cleanup pending"), { code: "WORKSPACE_DISPOSAL_PENDING" });
      }
      fixture.session.status = fixture.session.attempt.status = "cancelled";
      fixture.session.revision++;
      if (changeControl) fixture.run.mode = "paused";
      const proof = { schemaVersion: 1, kind: "controlled_execution_cancelled", sessionId: request.sessionId,
        cancellationDigest: request.cancellationDigest, sourceRevision: fixture.session.sourceRevision,
        trustedWorkspaceRevision: fixture.session.workspaceRevision, actionResolution: null,
        sandboxCleanupConfirmed: true, discardedAttempts: [{ attemptNumber: 1, executionId: "discarded-attempt", disposition: "discarded" }],
        settledAt: fixture.job.updatedAt };
      return { status: "settled", session: structuredClone(fixture.session), proof: { ...proof,
        proofDigest: corruptProof ? "0".repeat(64) : digestValue(proof) } };
    } },
  });
  return { ...fixture, cleanups: () => cleanups };
}

test("a restored authority failure before model launch automatically cleans up and releases the new PR generation", async () => {
  const fixture = await restoredAuthorityFenceFixture();
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.equal(fixture.cleanups(), 1);
  assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
  assert.equal(fixture.run.receipt.stopConfirmed, false, "historical native receipts must not be rewritten");
  assert.equal((await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId })).source.pendingRevision, null);
});

for (const variant of ["denied", "cleanupFailure", "changeControl", "corruptProof"]) {
  test(`restored authority settlement retains the source fence on ${variant}`, async () => {
    const fixture = await restoredAuthorityFenceFixture({ [variant]: true });
    const result = await fixture.service.reconcilePullRequestSource(fixture.command).catch(() => ({ applied: false }));
    assert.equal(result.applied, false);
    assert.equal(fixture.cleanups(), variant === "denied" ? 0 : 1);
    assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
  });
}

test("restored authority cleanup resumes its same cancelling executor after transient workspace disposal failure", async () => {
  const fixture = await restoredAuthorityFenceFixture({ cleanupFailure: true });
  await fixture.service.reconcilePullRequestSource(fixture.command).catch(() => {});
  assert.equal(fixture.session.status, 'cancelling');
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.equal(fixture.cleanups(), 2);
  assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
});

test("a host-rejected write is retained as unexecuted evidence during stopped fence settlement", async () => {
  const fixture = await stoppedStartedFenceFixture({ unexecutedWrite: true });
  const detail = await fixture.jobs.getDetail({ jobId: fixture.job.jobId, limit: 20 });
  assert.equal(detail.observations[1].detail.notExecuted, true);
  assert.equal(detail.observations[1].detail.origin, "host_pre_execution_rejection");
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
});

test("a native stop and executor drain completed after authority fencing can settle the old generation", async () => {
  const fixture = await stoppedStartedFenceFixture();
  fixture.time.advance(5_000);
  fixture.run.receipt.finishedAt = fixture.time.clock();
  fixture.session.updatedAt = fixture.time.clock();
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
});

test("started fence proof cannot be copied or minted across changing host controls", async () => {
  const fixture = await stoppedStartedFenceFixture();
  const stored = await fixture.jobs.getForWorker(fixture.job.jobId);
  const marked = await fixture.service.obsoleteCodeJobSettler.read({ grant: stored.grant, receipt: fixture.snapshot.item.receipt });
  assert.equal(hasSettledCodeJobAuthorityFence(marked), true);
  assert.equal(hasSettledCodeJobAuthorityFence(structuredClone(marked)), false);
  marked.revision++;
  assert.equal(hasSettledCodeJobAuthorityFence(marked), false);
  let reads = 0;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async () => assert.fail("terminal result must remain unchanged") },
    taskRuns: { get: async () => { const view = structuredClone(fixture.run); if (++reads > 1) view.mode = "paused"; return view; } },
    codeExecutorReader: { view: async () => structuredClone(fixture.session) } });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
});

test("missing host nonexecution metadata cannot settle an unmatched historical action", async () => {
  const fixture = await stoppedStartedFenceFixture({ unexecutedWrite: true });
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: { get: id => fixture.jobs.get(id), getDetail: async input => {
      const detail = await fixture.jobs.getDetail(input);
      for (const observation of detail.observations) delete observation.detail.notExecuted;
      return detail;
    } },
    codeJobControl: { cancel: async () => assert.fail("uncertain history must remain fenced") },
    taskRuns: { get: async () => structuredClone(fixture.run) }, codeExecutorReader: { view: async () => structuredClone(fixture.session) } });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
});

test("missing stop evidence preserves the fence without failing unrelated reconciliation", async (t) => {
  for (const missing of ["native", "executor"]) await t.test(missing, async () => {
    const fixture = await stoppedStartedFenceFixture();
    fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs,
      codeJobControl: { cancel: async () => assert.fail("missing evidence cannot rewrite a fence") },
      taskRuns: { get: async () => { if (missing === "native") throw Object.assign(new Error("missing"), { code: "TASK_RUN_NOT_FOUND" }); return structuredClone(fixture.run); } },
      codeExecutorReader: { view: async () => { if (missing === "executor") throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" }); return structuredClone(fixture.session); } } });
    assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
  });
});

test("started fence settlement preserves controls, unsettled actions and exact executor identity", async (t) => {
  for (const [name, alter] of [
    ["unconfirmed native stop", f => { f.run.receipt.stopConfirmed = false; }],
    ["live native run", f => { f.run.active = true; }],
    ["owner pause", f => { f.run.mode = "paused"; }],
    ["pending owner control", f => { f.run.pendingCommand = "pause"; }],
    ["preparation still running", f => { f.session.status = "preparing"; }],
    ["unsettled action", f => { f.session.actions[0].status = "interrupted"; }],
    ["cleanup pending", f => { f.session.cleanupPending = true; }],
    ["different executor binding", f => { f.session.inputBinding.headRefOid = "f".repeat(40); }],
    ["different workspace version", f => { f.session.workspaceRevision = "f".repeat(64); }],
  ]) await t.test(name, async () => {
    const fixture = await stoppedStartedFenceFixture();
    alter(fixture);
    assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
    assert.deepEqual(await fixture.jobs.get(fixture.job.jobId), fixture.job);
  });
});

test("stale PR source reconciliation commands cannot cancel an old code job", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  fixture.service.obsoleteCodeJobSettler = {
    settle: async () => { assert.fail("stale command must be rejected before cancellation"); },
  };
  for (const field of ["expectedGraphRevision", "expectedRevision", "expectedPendingRevision"]) {
    await assert.rejects(fixture.service.reconcilePullRequestSource({
      ...fixture.command, [field]: fixture.command[field] + 1,
    }), (error) => error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT");
  }
});

test("mismatched executed confirmations and code jobs cannot release a pending PR Head", async (t) => {
  for (const variant of ["receipt", "grant", "job", "createdAt", "missing"]) await t.test(variant, async () => {
    const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
    const original = (await fixture.jobs.list()).items[0];
    if (variant === "receipt" || variant === "grant") {
      const snapshot = clone(fixture.snapshot);
      if (variant === "receipt") snapshot.item.receipt.id = "code-job-other";
      else snapshot.item.action.grant.brainDigest = "e".repeat(64);
      fixture.replaceSnapshot(snapshot);
    }
    fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
      codeJobReader: { get: async (id) => {
        const job = await fixture.jobs.get(id);
        if (variant === "missing") return null;
        if (variant === "job") return { ...job, grantDigest: "e".repeat(64) };
        if (variant === "createdAt") return { ...job, createdAt: "2026-08-02T01:00:00.000Z" };
        return job;
      } },
      codeJobControl: { cancel: async () => { assert.fail("unbound evidence cannot cancel a job"); } },
    });
    try {
      const result = await fixture.service.reconcilePullRequestSource(fixture.command);
      assert.equal(result.applied, false);
    } catch (error) {
      assert.equal(error.code, "INVALID_CODE_JOB_RESULT");
    }
    assert.deepEqual(await fixture.jobs.get(original.jobId), original);
    assert.notEqual((await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId })).source.pendingRevision, null);
  });
});

test("PR source reconciliation settles an unstarted revoked code confirmation after source revision replaced its reason", async () => {
  const fixture = await revokedCodeConfirmationFixture();
  const result = await fixture.service.reconcilePullRequestSource(fixture.command);
  assert.equal(result.applied, true);
  const next = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(next.status, "queued");
  assert.equal(next.source.pendingRevision, null);
  assert.deepEqual(fixture.reads, [{ confirmationId: fixture.plan.id }]);
});

test("PR source reconciliation does not mistake an executed stale confirmation for an unstarted revocation", async () => {
  const fixture = await revokedCodeConfirmationFixture({ executed: true });
  assert.equal(fixture.snapshot.item.execution.outcome, "stale");
  assert.equal(fixture.snapshot.item.invalidation, null);
  const result = await fixture.service.reconcilePullRequestSource(fixture.command);
  assert.equal(result.applied, false);
  assert.equal(result.blockers[0].itemId, fixture.item.itemId);
});

test("PR source batch reconciliation uses the same trusted revoked-confirmation settlement", async () => {
  const fixture = await revokedCodeConfirmationFixture();
  const { expectedGraphRevision, ...item } = fixture.command;
  const result = await fixture.service.reconcilePullRequestSourceBatch({ expectedGraphRevision, items: [item] });
  assert.deepEqual(result, { outcomes: [{ itemId: item.itemId, status: "applied" }], stoppedAfterWrite: true });
});

test("PR source reconciliation rejects absent, executed or mismatched confirmation proof", async (t) => {
  const variants = [
    ["missing confirmation", () => null],
    ["omitted execution field", (value) => { delete value.item.execution; return value; }],
    ["executed absent outcome", (value) => {
      value.item.execution = { requestId: "request-proved-absent", attempt: 1,
        startedAt: value.item.createdAt, outcome: "absent" }; return value;
    }],
    ["receipt present", (value) => { value.item.receipt = { id: "created-job" }; return value; }],
    ["different invalidation", (value) => { value.item.invalidation.reason = "work_item_superseded"; return value; }],
    ["different proposer", (value) => { value.item.requestedBy.workItemId = "work-other"; return value; }],
    ["different proposal", (value) => { value.item.action.grant.proposalId = `work-intent-${"f".repeat(64)}`; return value; }],
    ["impossible queue revision", (value) => { value.queueRevision = 0; return value; }],
  ];
  for (const [name, change] of variants) await t.test(name, async () => {
    const fixture = await revokedCodeConfirmationFixture();
    fixture.replaceSnapshot(change(clone(fixture.snapshot)));
    const result = await fixture.service.reconcilePullRequestSource(fixture.command);
    assert.equal(result.applied, false);
    assert.equal(result.blockers[0].itemId, fixture.item.itemId);
  });
});

test("revoked-confirmation settlement preserves active-intent, decision, outbox and retained-timeline fences", async () => {
  const fixture = await revokedCodeConfirmationFixture();
  const state = fixture.store.stored();
  const item = state.items.find(({ itemId }) => itemId === fixture.item.itemId);
  const outbox = new Map(state.outbox.map((entry) => [entry.intentId, entry]));
  const proof = createRevokedCodeConfirmationSettlement(item, outbox, fixture.snapshot);
  assert.notEqual(proof, null);
  const inspect = (candidate = item, { timeline = state.timeline, proofs = new Map([[item.itemId, proof]]), entries = outbox } = {}) =>
    inspectPullRequestSourceCutover(candidate, [candidate], entries, {
      timelineIndex: createPullRequestCutoverTimelineIndex(timeline), confirmationSettlements: proofs,
    }).blockers;
  assert.deepEqual(inspect(), []);
  assert.equal(inspect({ ...item, activeIntentId: "intent-current" }).length, 1);
  assert.equal(inspect({ ...item, revision: item.revision + 1 }).length, 1);
  assert.equal(inspect({ ...item, decisionContext: { ...item.decisionContext, contentDigest: "e".repeat(64) } }).length, 1);
  assert.equal(inspect(item, { proofs: new Map([[item.itemId, {}]]) }).length, 1);
  assert.equal(inspect(item, { timeline: [] }).length, 1);
  assert.equal(inspect(item, { timeline: [...state.timeline, { itemId: item.itemId, type: "transitioned" }] }).length, 1);
  const delivered = [...outbox.values()].find((entry) => entry.itemId === item.itemId);
  assert.equal(inspect(item, { entries: new Map([[delivered.intentId, { ...delivered, revision: delivered.revision + 1 }]]) }).length, 1);
  const retained = state.timeline.find((entry) => entry.type === "proposal_result_applied");
  assert.equal(inspect(item, { timeline: [{ ...retained, details: { ...retained.details,
    decision: { ...retained.details.decision, contentDigest: "b".repeat(64) } } }] }).length, 1);
  const result = inspectPullRequestSourceCutover(item, [item], outbox, {
    timelineIndex: createPullRequestCutoverTimelineIndex([...state.timeline, { itemId: "other", type: "assignment_intaken" }], 1),
    confirmationSettlements: new Map([[item.itemId, proof]]),
  });
  assert.equal(result.blockers.length, 1);
});

test("PR source reconciliation keeps command fields exact and rejects graph changes during confirmation read", async () => {
  const fixture = await revokedCodeConfirmationFixture();
  await assert.rejects(fixture.service.reconcilePullRequestSource({ ...fixture.command, confirmedUnstarted: true }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_INVALID");
  assert.equal(fixture.reads.length, 0);
  fixture.service.confirmationSettlementReader = {
    read: async (input) => {
      fixture.source.records.push(issueAssignment(3));
      fixture.source.highWatermark = 3;
      await fixture.service.intake();
      return fixture.confirmationQueue.readSettlement(input);
    },
  };
  await assert.rejects(fixture.service.reconcilePullRequestSource(fixture.command),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT");
  const current = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(current.status, "blocked");
  assert.equal(current.source.pendingRevision, fixture.item.source.pendingRevision);
});

test("PR source reconciliation remains blocked without its trusted reader and fails closed when the queue cannot be read", async () => {
  const fixture = await revokedCodeConfirmationFixture();
  fixture.service.confirmationSettlementReader = null;
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
  fixture.service.confirmationSettlementReader = { read: async () => { throw new Error("settlement unavailable"); } };
  await assert.rejects(fixture.service.reconcilePullRequestSource(fixture.command), /settlement unavailable/);
  const current = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(current.status, "blocked");
  assert.equal(current.source.pendingRevision, fixture.item.source.pendingRevision);
});

for (const nextStatus of ["blocked", "retry_wait"]) {
  test(`same-root cutover releases a definitively failed ${nextStatus} action`, async () => {
    const fixture = await createFixture({ records: [prAssignment(1)] });
    const sealed = await stageSealedPrReview(fixture);
    let root = (await fixture.service.listItems()).items.find(
      ({ itemId }) => itemId === sealed.rootItemId,
    );
    await fixture.service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: root.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "failed",
      nextStatus,
      ...(nextStatus === "retry_wait"
        ? { availableAt: "2026-08-02T02:01:00.000Z" }
        : {}),
      details: { code: "definite_downstream_rejection" },
    });
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }));
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    root = (await fixture.service.listItems()).items[0];
    assert.equal(root.status, "queued");
    assert.equal(root.source.current.headRefOid, PR_HEAD_B);
    assert.equal(root.source.pendingRevision, null);
  });
}

for (const [destination, initialStatus] of [
  ["new", "queued"], ["existing", "queued"],
  ["new", "completed"], ["existing", "completed"],
]) {
  test(`one intake batch revises and retires a ${initialStatus} PR root once when moving to a ${destination} root`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    });
    await fixture.service.intake();
    let sequence = 1;
    if (destination === "existing") {
      for (const sourceScopeId of ["github-secondary", "github-dashboard"]) {
        sequence += 1;
        fixture.source.records.push(prAssignment(sequence, {
          sourceScopeId,
          occurredAt: `2026-08-02T01:0${sequence}:00.000Z`,
          gitFacts: prGitFacts(PR_HEAD_A),
        }));
        fixture.source.highWatermark = sequence;
        await fixture.service.intake();
      }
    }
    fixture.source.records.push(issueAssignment(++sequence, { issueNumber: 99 }));
    fixture.source.highWatermark = sequence;
    await fixture.service.intake();
    let before = (await fixture.service.listItems({ limit: 10 })).items.find(
      ({ source }) => source?.identity.scopeId === "github-dashboard",
    );
    if (initialStatus === "completed") {
      const claimed = await fixture.service.claim({
        itemId: before.itemId,
        expectedRevision: before.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
      before = await fixture.service.complete({
        itemId: claimed.itemId,
        expectedRevision: claimed.revision,
        leaseId: claimed.leaseId,
        actorId: "employee-pr-engineer",
        result: { outcome: "completed-before-new-observations" },
      });
    }
    const previousState = fixture.store.stored();
    const update = prAssignment(++sequence, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      ciStatus: "SUCCESS",
      gitFacts: prGitFacts(PR_HEAD_A),
    });
    const replacement = prAssignment(++sequence, {
      sourceScopeId: "github-secondary",
      occurredAt: "2026-08-02T01:11:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    });
    const following = issueAssignment(++sequence);
    fixture.source.records.push(update, replacement, following);
    fixture.source.highWatermark = sequence;

    const result = await fixture.service.intake();

    assert.equal(result.error, undefined);
    assert.equal(result.received, 3);
    assert.equal(result.cursor, sequence);
    const items = (await fixture.service.listItems({ limit: 10 })).items;
    const retired = items.find(({ itemId }) => itemId === before.itemId);
    assert.equal(retired.revision, before.revision + 1);
    assert.equal(retired.statusReason, "pr_source_cross_root_cutover_retired");
    assert.ok(retired.source.bindings.some(
      ({ assignmentId }) => assignmentId === update.assignment.assignmentId,
    ));
    assert.ok(items.some(
      ({ assignmentId }) => assignmentId === following.assignment.assignmentId,
    ));
    assert.equal(items.filter(({ source }) =>
      source?.kind === "pull_request" && source.identity.scopeId === "github-secondary"
    ).length, 1);
    if (initialStatus === "completed") {
      const committed = fixture.store.stored();
      for (const tamper of [
        (state) => {
          state.items.find(({ itemId }) => itemId === retired.itemId)
            .source.activeRevision = before.source.activeRevision;
        },
        (state) => {
          const successor = state.items.find(({ source }) =>
            source?.identity.scopeId === "github-secondary"
          );
          successor.source.current.sourceSequence = retired.source.current.sourceSequence;
        },
      ]) {
        const forged = clone(committed);
        tamper(forged);
        assert.throws(() => validateWorkLedgerGraphTransition(previousState, forged));
      }
    }
    assert.equal((await fixture.service.intake()).received, 0);
  });
}

for (const predecessorStatus of ["queued", "working"]) {
  test(`cross-root cutover retires a ${predecessorStatus} predecessor atomically`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    });
    await fixture.service.intake();
    let predecessor = (await fixture.service.listItems()).items[0];
    if (predecessorStatus === "working") {
      predecessor = await fixture.service.claim({
        itemId: predecessor.itemId,
        expectedRevision: predecessor.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;

    await fixture.service.intake();

    const roots = (await fixture.service.listItems({ limit: 10 })).items;
    const retired = roots.find(({ itemId }) => itemId === predecessor.itemId);
    const active = roots.find(({ itemId }) => itemId !== predecessor.itemId);
    assert.equal(retired.status, "blocked");
    assert.equal(retired.ownerId, null);
    assert.equal(retired.leaseId, null);
    assert.equal(retired.leaseUntil, null);
    assert.equal(retired.activeIntentId, null);
    assert.equal(active.status, "queued");
    const claimed = await fixture.service.claim({
      itemId: active.itemId,
      expectedRevision: active.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
    assert.equal(claimed.status, "working");
  });
}

async function rejectBoundPullRequestProposal(fixture, sealed) {
  const {
    intentId: proposalId,
    ...proposalContent
  } = sealed.outbox.dispatchBinding.boundIntent;
  const proposal = normalizeBoundWorkProposal({
    proposalId,
    ...proposalContent,
  });
  const sealedItemId = sealed.rootItemId ?? sealed.childItemId;
  let predecessor = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === sealedItemId,
  );
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: predecessor.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "waiting_external",
    details: {
      downstreamRef: proposal.proposalId,
      proposalDigest: proposal.contentDigest,
    },
  });
  await fixture.service.applyProposalBatch({
    items: [createWorkProposalResult({
      proposal,
      sequence: 1,
      transition: {
        status: "rejected",
        summary: "所有者拒绝旧提案",
        evidence: [],
      },
      downstreamRef: "confirmation-rejected-cross-root",
      at: fixture.time.clock(),
    })],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  predecessor = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  assert.equal(predecessor.status, "blocked");
  assert.equal(predecessor.statusReason, "proposal_rejected");
  return predecessor;
}

async function rejectSealedPullRequestProposal(fixture) {
  return rejectBoundPullRequestProposal(
    fixture,
    await stageSealedPrReview(fixture),
  );
}

test("same-Head PR observations do not repeat a rejected Review decision", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  let root = await rejectSealedPullRequestProposal(fixture);
  const settledDecision = structuredClone(root.decisionContext);

  fixture.source.records.push(prAssignment(2, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_A,
    changedFields: ["ciStatus"],
    ciStatus: "SUCCESS",
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  root = (await fixture.service.listItems()).items[0];
  assert.ok(root.source.activeRevision >= 1);
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "proposal_rejected");
  assert.deepEqual(root.decisionContext, settledDecision);
});

test("a new PR Head reopens a rejected Review decision", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  let root = await rejectSealedPullRequestProposal(fixture);

  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  root = (await fixture.service.listItems()).items[0];
  assert.equal(root.status, "queued");
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.decisionContext, null);
});

test("an owner-requested PR root retires a durably rejected proposal predecessor", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);

  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const retired = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const active = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(retired.status, "blocked");
  assert.equal(retired.statusReason, "pr_source_cross_root_cutover_retired");
  assert.equal(active.status, "queued");
  assert.equal(active.statusReason, null);
});

test("an owner-requested PR root supersedes a child with a durably rejected proposal", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrChildReview(fixture);
  const rejectedChild = await rejectBoundPullRequestProposal(fixture, sealed);
  const predecessor = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ kind }) => kind === "source_root");
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const retired = items.find(({ itemId }) => itemId === predecessor.itemId);
  const child = items.find(({ itemId }) => itemId === rejectedChild.itemId);
  const active = items.find(
    ({ kind, itemId }) => kind === "source_root" && itemId !== retired.itemId,
  );
  assert.equal(
    retired.statusReason,
    "pr_source_cross_root_cutover_retired",
  );
  assert.equal(child.status, "superseded");
  assert.equal(child.statusReason, "pr_head_superseded");
  assert.equal(active.status, "queued");
});

test("an ignored stale source audit preserves rejected proposal settlement in the same intake batch", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const deliveredHistory = (await fixture.service.listOutbox()).items;
  fixture.source.records.push(
    prAssignment(2, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T00:59:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "FAILURE",
    }),
    ownerRequestedPrAssignment(3),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.match(blocked.source.revisions.at(-1).disposition, /^ignored_/);
  assert.equal(
    blocked.statusReason,
    "pr_source_cross_root_cutover_retired",
  );
  assert.equal(pending.status, "queued");
  assert.equal(pending.statusReason, null);
  assert.deepEqual((await fixture.service.listOutbox()).items, deliveredHistory);
  assert.ok((await fixture.service.listTimeline({ itemId: predecessor.itemId })).items
    .some((entry) => entry.type === "pr_source_ignored"));
});

test("a persisted rejected-proposal blocker recovers through restart and real reconciliation", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const predecessorId = sealed.rootItemId;
  const pendingId = roots.find(({ itemId }) => itemId !== predecessorId).itemId;
  await rejectBoundPullRequestProposal(fixture, sealed);

  const legacy = fixture.store.stored();
  const legacyPredecessor = legacy.items.find(
    ({ itemId }) => itemId === predecessorId,
  );
  legacyPredecessor.statusReason = crossRootPullRequestCutoverBlockerReason(
    pendingId,
  );
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let pending = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingId,
  );

  const result = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pending.revision,
    expectedPendingRevision:
      pending.source.pendingRevision ?? pending.source.activeRevision,
  });

  assert.equal(result.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const predecessor = roots.find(({ itemId }) => itemId === predecessorId);
  pending = roots.find(({ itemId }) => itemId === pendingId);
  assert.equal(
    predecessor.statusReason,
    "pr_source_cross_root_cutover_retired",
  );
  assert.equal(pending.status, "queued");
  assert.equal(pending.statusReason, "pr_source_cutover_activated");
});

test("a rejected proposal stays blocked after its retained proof rotates out", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit: 6 },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  fixture.source.records.push(
    ...Array.from({ length: 7 }, (_, index) => assignment(index + 2)),
  );
  fixture.source.highWatermark = 8;
  await fixture.service.intake();
  assert.equal(
    (await fixture.service.listTimeline({ limit: 20 })).items.some(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    ),
    false,
  );

  fixture.source.records.push(ownerRequestedPrAssignment(9));
  fixture.source.highWatermark = 9;
  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
  );
});

test('same-intake byte retention cannot release a rejected proposal cutover', async () => {
  const seed = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const predecessor = await rejectSealedPullRequestProposal(seed);
  const before = seed.store.stored();
  const proofIndex = before.timeline.findIndex(entry => entry.itemId === predecessor.itemId && entry.type === 'proposal_result_applied');
  assert.ok(proofIndex >= 0);
  before.timeline = before.timeline.slice(proofIndex);
  before.timelineStartSequence = before.timeline[0].sequence;
  seed.store.replaceStored(before);
  const limits = { stateByteBudget: legacyLedgerCapacityBytes(before) + 20 };
  const fixture = await createFixture({ store: seed.store, source: seed.source, time: seed.time, limits });
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const durable = fixture.store.stored();
  assert.ok(durable.timeline.length < 20_000);
  assert.equal(durable.timeline.some(entry => entry.timelineId === before.timeline[0].timelineId), false);
  const roots = durable.items.filter(item => item.kind === 'source_root');
  const blocked = roots.find(item => item.itemId === predecessor.itemId);
  const pending = roots.find(item => item.itemId !== predecessor.itemId);
  assert.equal(blocked.statusReason, `pr_source_cross_root_cutover_blocker:${pending.itemId}`);
  assert.equal(pending.status, 'blocked');
  assert.deepEqual(durable.outbox, before.outbox);
});

test("same-intake retention rotation cannot release a rejected proposal cutover", async () => {
  const timelineLimit = 6;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 2),
    ),
    ownerRequestedPrAssignment(fillerCount + 2),
  );
  fixture.source.highWatermark = fillerCount + 2;

  await fixture.service.intake();

  const retainedTimeline = (await fixture.service.listTimeline({ limit: 20 }))
    .items;
  assert.equal(
    retainedTimeline.some(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    ),
    false,
  );
  const roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
  );
});

for (const targetPosition of ["first", "middle", "boundary"]) {
  test(`same-intake ${targetPosition} cutover cannot rely on proof evicted before commit`, async () => {
    const timelineLimit = 6;
    const fixture = await createFixture({
      records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
      limits: { timelineLimit },
    });
    const predecessor = await rejectSealedPullRequestProposal(fixture);
    const before = fixture.store.stored();
    const proofIndex = before.timeline.findIndex(
      ({ itemId, type }) =>
        itemId === predecessor.itemId && type === "proposal_result_applied",
    );
    assert.notEqual(proofIndex, -1);
    const eventsAfterProof = before.timeline.length - proofIndex - 1;
    const eventsNeededToEvict = timelineLimit - eventsAfterProof;
    assert.ok(eventsNeededToEvict > 1);
    const beforeCount = targetPosition === "first"
      ? 0
      : targetPosition === "middle"
        ? Math.floor(eventsNeededToEvict / 2)
        : eventsNeededToEvict - 1;
    const afterCount = targetPosition === "boundary"
      ? 0
      : eventsNeededToEvict - beforeCount;
    let nextSequence = 2;
    const beforeAssignments = Array.from(
      { length: beforeCount },
      () => assignment(nextSequence++),
    );
    const ownerAssignment = ownerRequestedPrAssignment(nextSequence++);
    const afterAssignments = Array.from(
      { length: afterCount },
      () => assignment(nextSequence++),
    );
    fixture.source.records.push(
      ...beforeAssignments,
      ownerAssignment,
      ...afterAssignments,
    );
    fixture.source.highWatermark = nextSequence - 1;

    await fixture.service.intake();

    const retainedTimeline = (
      await fixture.service.listTimeline({ limit: 20 })
    ).items;
    assert.equal(
      retainedTimeline.some(
        ({ itemId, type }) =>
          itemId === predecessor.itemId && type === "proposal_result_applied",
      ),
      false,
    );
    const roots = (await fixture.service.listItems({ limit: 20 })).items
      .filter(({ kind }) => kind === "source_root");
    const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
    const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
    assert.equal(
      blocked.statusReason,
      `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
    );
    assert.equal(pending.status, "blocked");
    assert.equal(
      pending.statusReason,
      `pr_source_cross_root_cutover_pending:${blocked.itemId}`,
    );
  });
}

test("direct reconciliation cannot rely on proof evicted by its activation event", async () => {
  const timelineLimit = 12;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const predecessor = await rejectBoundPullRequestProposal(fixture, sealed);
  let stored = fixture.store.stored();
  const pending = stored.items.find(
    ({ kind, itemId }) =>
      kind === "source_root" && itemId !== predecessor.itemId,
  );
  const proofIndex = stored.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = stored.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 3),
    ),
  );
  fixture.source.highWatermark = fillerCount + 2;
  await fixture.service.intake();
  stored = fixture.store.stored();
  const storedPredecessor = stored.items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  storedPredecessor.statusReason = crossRootPullRequestCutoverBlockerReason(
    pending.itemId,
  );
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { timelineLimit },
  });
  await recovered.recover();
  const currentPending = (await recovered.listItems({ limit: 20 })).items
    .find(({ itemId }) => itemId === pending.itemId);

  const result = await recovered.reconcilePullRequestSource({
    itemId: currentPending.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: currentPending.revision,
    expectedPendingRevision:
      currentPending.source.pendingRevision ??
      currentPending.source.activeRevision,
  });

  assert.equal(result.applied, false);
  const roots = (await recovered.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === pending.itemId).statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("a new authority fence registers a predecessor whose proof expires before commit", async () => {
  const timelineLimit = 24;
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
    limits: { timelineLimit },
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    prAssignment(2, {
      sourceScopeId: "github-secondary",
      gitFacts: { gitTargetAvailable: false },
    }),
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 3),
    ),
  );
  fixture.source.highWatermark = fillerCount + 2;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 50 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("an existing authority fence registers a predecessor whose proof expires before commit", async () => {
  const timelineLimit = 24;
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
    limits: { timelineLimit },
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 20 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const existing = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const predecessorRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const predecessor = await rejectBoundPullRequestProposal(
    fixture,
    await stageSealedPrReview(fixture, predecessorRoot.itemId),
  );
  const before = fixture.store.stored();
  const proofIndex = before.timeline.findIndex(
    ({ itemId, type }) =>
      itemId === predecessor.itemId && type === "proposal_result_applied",
  );
  assert.notEqual(proofIndex, -1);
  const eventsAfterProof = before.timeline.length - proofIndex - 1;
  const fillerCount = timelineLimit - eventsAfterProof - 2;
  assert.ok(fillerCount > 0);
  fixture.source.records.push(
    prAssignment(3, {
      sourceScopeId: "github-dashboard",
      gitFacts: { gitTargetAvailable: false },
    }),
    ...Array.from(
      { length: fillerCount },
      (_, index) => assignment(index + 4),
    ),
  );
  fixture.source.highWatermark = fillerCount + 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 50 })).items.filter(
    ({ kind }) => kind === "source_root",
  );
  const pending = roots.find(({ itemId }) => itemId === existing.itemId);
  assert.equal(
    roots.find(({ itemId }) => itemId === predecessor.itemId).statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(
    pending.statusReason,
    `pr_source_cross_root_cutover_pending:${predecessor.itemId}`,
  );
});

test("a later durable transition keeps stale rejected-proposal context blocked across restart", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  let predecessor = await rejectSealedPullRequestProposal(fixture);
  predecessor = await fixture.service.transition({
    itemId: predecessor.itemId,
    expectedRevision: predecessor.revision,
    leaseId: null,
    actorId: "work-ledger-system",
    toStatus: "queued",
    reason: "owner_reopened_after_rejection",
  });
  predecessor = await fixture.service.transition({
    itemId: predecessor.itemId,
    expectedRevision: predecessor.revision,
    leaseId: null,
    actorId: "work-ledger-system",
    toStatus: "blocked",
    reason: "proposal_rejected",
  });
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await recovered.intake();

  const roots = (await recovered.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
});

test("a self-consistent forged rejected-proposal context without matching evidence stays blocked", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const predecessor = await rejectSealedPullRequestProposal(fixture);
  const forged = fixture.store.stored();
  const forgedItem = forged.items.find(
    ({ itemId }) => itemId === predecessor.itemId,
  );
  forgedItem.decisionContext = createWorkDecisionContext({
    source: "proposal",
    referenceId: `work-intent-${"f".repeat(64)}`,
    outcome: "rejected",
    value: { summary: "self-consistent but unattested replacement" },
    observedAt: fixture.time.clock(),
  });
  fixture.store.replaceStored(forged);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  fixture.source.records.push(ownerRequestedPrAssignment(2));
  fixture.source.highWatermark = 2;

  await recovered.intake();

  const roots = (await recovered.listItems({ limit: 10 })).items;
  const blocked = roots.find(({ itemId }) => itemId === predecessor.itemId);
  const pending = roots.find(({ itemId }) => itemId !== predecessor.itemId);
  assert.equal(
    blocked.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  assert.equal(pending.status, "blocked");
});

for (const cutover of ["same-root-head", "cross-provenance-root"]) {
  test(`${cutover} invalidates old PR memory through the durable system pipeline`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        title: "PR authority memory fixture",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    let root = (await fixture.service.listItems({ limit: 10 })).items[0];
    await fixture.service.reviseGraphAcceptance({
      authority: {
        actorId: "employee-orchestrator",
        scopeRootTaskId: root.itemId,
      },
      command: {
        taskId: root.itemId,
        acceptanceContract: {
          revision: 2,
          acceptanceCriteria: [{
            criterionId: "old-authority-proof",
            description: "Old authority conclusion must never survive cutover",
          }],
          expectedDeliverables: [],
        },
        reason: "memory-authority-integration",
        expectedGraphRevision: (await fixture.service.getSummary()).revision,
        expectedTaskRevision: root.revision,
      },
    });
    const pendingBeforeProjection =
      await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 });
    const contractEvent = pendingBeforeProjection.items.find(
      ({ kind }) => kind === "acceptance_contract",
    );
    assert.notEqual(contractEvent, undefined);
    const oldContractId = workGraphMemoryRecordReceipt(contractEvent)
      .memoryRecordId;
    const memory = await createLedgerMemoryPipeline(fixture.service);
    await memory.projector.runCycle();
    const oldWorkId = memory.journal.search({
      eventType: "work.queued",
      repository: "acme/repo",
    }).items[0].id;
    const sealedWork = memory.journal.readRecords({
      recordIds: [oldWorkId],
    }).items[0].record;
    const sealedAuthority = JSON.parse(sealedWork.content).sourceAuthority;
    assert.equal(sealedAuthority.executionBinding.schemaVersion, 2);
    assert.equal(sealedAuthority.executionBinding.gitTarget.headRefOid, PR_HEAD_A);
    assert.deepEqual(sealedAuthority.provenance, {
      provider: "github",
      scopeId: "github-dashboard",
    });
    const prTimeline = memory.journal.search({
      q: "工作时间线",
      repository: "acme/repo",
    });
    assert.equal(prTimeline.items.length, 0);
    assert.deepEqual(
      memory.journal.readRecords({ recordIds: [oldWorkId, oldContractId] })
        .items.map(({ labels }) => labels.lifecycle),
      ["current", "current"],
    );

    fixture.source.records.push(
      cutover === "same-root-head"
        ? prAssignment(2, {
            occurredAt: "2026-08-02T01:05:00.000Z",
            title: "PR authority memory fixture",
            headRefOid: PR_HEAD_B,
            previousHeadRefOid: PR_HEAD_A,
            changedFields: ["headRefOid"],
            gitFacts: prGitFacts(PR_HEAD_B),
          })
        : prAssignment(2, {
            occurredAt: "2026-08-02T01:05:00.000Z",
            title: "PR authority memory fixture",
            sourceScopeId: "github-secondary",
            gitFacts: prGitFacts(PR_HEAD_A),
          }),
    );
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    const authorityTail =
      await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 });
    assert.equal(
      authorityTail.items.some(({ kind }) => kind === "authority_invalidated"),
      true,
    );

    const standalone = await restartStandaloneMemoryRuntime(memory.store);
    for (const operation of [
      () => standalone.search.search({
        q: "Old authority conclusion must never survive cutover",
        repository: "acme/repo",
      }),
      () => standalone.contextReader.readRecords({
        recordIds: [oldWorkId, oldContractId],
      }),
    ]) {
      await assert.rejects(
        operation,
        (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
      );
    }
    const generateCalls = [];
    await assert.rejects(
      memoryAnswerForRuntime(standalone, generateCalls).answer({
        schemaVersion: 1,
        question: "Can the old PR conclusion still be used?",
        mode: "configured",
        retrieval: {
          kind: "query",
          filters: {
            query: "Old authority conclusion must never survive cutover",
            repository: "acme/repo",
          },
        },
      }),
      (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
    );
    assert.deepEqual(generateCalls, []);
    await standalone.close();

    const staleAuthoritativeRuntime = await restartMemoryRuntime(
      fixture.service,
      memory.store,
    );
    await assert.rejects(
      staleAuthoritativeRuntime.search.search({ repository: "acme/repo" }),
      (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
    );
    await staleAuthoritativeRuntime.close();

    await memory.projector.runCycle();
    assert.deepEqual(
      memory.journal.readRecords({ recordIds: [oldWorkId, oldContractId] })
        .items.map(({ labels }) => labels.lifecycle),
      ["obsolete", "obsolete"],
    );

    const runtime = await restartMemoryRuntime(fixture.service, memory.store);
    const currentWork = await runtime.search.search({
      q: "PR authority memory fixture",
      eventType: "work.queued",
      repository: "acme/repo",
    });
    const currentContext = await runtime.contextReader.readRecords({
      recordIds: currentWork.items.map(({ id }) => id),
    });
    assert.equal(
      currentContext.items.some(
        ({ labels }) => labels.lifecycle === "current",
      ),
      true,
    );
    const packet = await new MemoryContextRetriever({
      memorySearch: { search: runtime.search.search },
      contextReader: runtime.contextReader,
    }).retrieve({
      question: "Can the old authority conclusion still be used?",
      retrieval: {
        kind: "query",
        filters: {
          query: "Old authority conclusion must never survive cutover",
          repository: "acme/repo",
        },
      },
    });
    assert.equal(
      packet.records.some(({ recordId }) => recordId === oldContractId),
      true,
    );
    assert.equal(packet.citableRecordIds.includes(oldContractId), false);
    await runtime.close();
  });
}

test("a fenced pending Head immediately makes the active Head memory non-citable", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "Pending Head memory fixture",
    })],
  });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "pending-head",
          description: "Pending Head must fence this conclusion",
        }],
        expectedDeliverables: [],
      },
      reason: "pending-head-memory",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const contractEvent = (await fixture.service.readGraphMemoryProjectionBatch({
    limit: 10,
  })).items.find(({ kind }) => kind === "acceptance_contract");
  const contractId = workGraphMemoryRecordReceipt(contractEvent).memoryRecordId;
  const memory = await createLedgerMemoryPipeline(fixture.service);
  await memory.projector.runCycle();
  const sealed = await stageSealedPrReview(fixture, root.itemId);
  await memory.projector.runCycle();

  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    title: "Pending Head memory fixture",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === sealed.rootItemId,
  );
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  const authorityTail = await fixture.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(authorityTail.items.at(-1).kind, "authority_invalidated");
  await memory.projector.runCycle();
  assert.equal(
    memory.journal.readRecords({ recordIds: [contractId] })
      .items[0].labels.lifecycle,
    "obsolete",
  );
  const runtime = await restartMemoryRuntime(fixture.service, memory.store);
  const packet = await new MemoryContextRetriever({
    memorySearch: { search: runtime.search.search },
    contextReader: runtime.contextReader,
  }).retrieve({
    question: "May the active old Head conclusion be cited?",
    retrieval: {
      kind: "query",
      filters: {
        query: "Pending Head must fence this conclusion",
        repository: "acme/repo",
      },
    },
  });
  assert.equal(packet.citableRecordIds.includes(contractId), false);
  await runtime.close();
});

test("memory capacity failure leaves the ledger HWM pending and every read fails closed", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "PR memory capacity fixture",
    })],
  });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "capacity-authority",
          description: "Authority lifecycle must be persisted before ack",
        }],
        expectedDeliverables: [],
      },
      reason: "memory-capacity-integration",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const maximumRecords = 40;
  const memory = await createLedgerMemoryPipeline(fixture.service, {
    maximumRecords,
  });
  await memory.projector.runCycle();
  const initialAuthority = await fixture.service.readMemoryAuthorityStatus();
  const initialCount = memory.journal.getHealth().recordCount;
  await memory.journal.appendBatch({
    records: Array.from(
      { length: maximumRecords - initialCount },
      (_, index) => ordinaryMemoryFact(index + 1),
    ),
  });
  assert.equal(memory.journal.getHealth().recordCount, maximumRecords);

  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const pendingAuthority = await fixture.service.readMemoryAuthorityStatus();
  assert.equal(pendingAuthority.graph.cursor, initialAuthority.graph.cursor);
  assert.equal(
    pendingAuthority.graph.highWatermark > pendingAuthority.graph.cursor,
    true,
  );
  await assert.rejects(
    memory.projector.runCycle(),
    (error) => error.code === "MEMORY_CAPACITY_EXCEEDED",
  );
  const afterFailure = await fixture.service.readMemoryAuthorityStatus();
  assert.equal(afterFailure.graph.cursor, initialAuthority.graph.cursor);
  assert.equal(memory.journal.getHealth().recordCount, maximumRecords);

  const runtime = await restartMemoryRuntime(fixture.service, memory.store);
  await assert.rejects(
    runtime.search.search({}),
    (error) => error.code === "MEMORY_AUTHORITY_NOT_CURRENT",
  );
  await runtime.close();
});

test("a new PR provenance waits for the old sealed action across restart", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  let pendingRoot = roots.find(({ itemId }) => itemId !== oldRoot.itemId);
  assert.equal(oldRoot.status, "dispatch_pending");
  assert.match(oldRoot.statusReason, /^pr_source_cross_root_cutover_blocker:/);
  assert.equal(pendingRoot.status, "blocked");
  assert.equal(
    pendingRoot.statusReason,
    `pr_source_cross_root_cutover_pending:${oldRoot.itemId}`,
  );
  await assert.rejects(
    fixture.service.claim({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );
  await assert.rejects(
    fixture.service.transition({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      leaseId: null,
      actorId: "work-ledger-system",
      toStatus: "queued",
      reason: "bypass-cross-root-cutover",
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 10 })).items;
  oldRoot = roots.find(({ itemId }) => itemId === oldRoot.itemId);
  pendingRoot = roots.find(({ itemId }) => itemId === pendingRoot.itemId);
  await assert.rejects(
    recovered.claim({
      itemId: pendingRoot.itemId,
      expectedRevision: pendingRoot.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: oldRoot.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-cross-root" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });

  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  oldRoot = roots.find(({ itemId }) => itemId === oldRoot.itemId);
  pendingRoot = roots.find(({ itemId }) => itemId === pendingRoot.itemId);
  assert.equal(oldRoot.status, "completed");
  assert.equal(pendingRoot.status, "queued");
  assert.equal(pendingRoot.statusReason, "pr_source_cutover_activated");
});

test("a newer provenance chains behind the same sealed predecessor", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  const pending = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  const olderPending = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  assert.equal(roots.length, 3);
  assert.equal(pending.source.identity.scopeId, "github-tertiary");
  assert.equal(pending.status, "blocked");
  assert.equal(olderPending.status, "blocked");
  assert.equal(
    olderPending.statusReason,
    `pr_source_cross_root_cutover_pending:${oldRoot.itemId}`,
  );
  assert.equal(
    oldRoot.statusReason,
    `pr_source_cross_root_cutover_blocker:${pending.itemId}`,
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: olderPending.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: olderPending.revision,
      expectedPendingRevision: olderPending.source.activeRevision,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const currentOldRoot = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === oldRoot.itemId);
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: currentOldRoot.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-latest-source" },
  });
  const currentPending = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === pending.itemId);
  await fixture.service.reconcilePullRequestSource({
    itemId: currentPending.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: currentPending.revision,
    expectedPendingRevision: currentPending.source.activeRevision,
  });
  const activatedRoots = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(
    activatedRoots.find(({ itemId }) => itemId === pending.itemId).status,
    "queued",
  );
  assert.equal(
    activatedRoots.find(({ itemId }) => itemId === olderPending.itemId).status,
    "superseded",
  );
});

async function createAuditedCrossRootCandidateRace({ restart }) {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const staleA = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:06:00.000Z",
    sourceScopeId: "github-dashboard",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  const staleB = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:04:00.000Z",
    sourceScopeId: "github-secondary",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  const staleC = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:07:00.000Z",
    sourceScopeId: "github-tertiary",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A),
  };
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(4, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(5, staleA),
    prAssignment(6, staleB),
    prAssignment(7, staleC),
    prAssignment(8, staleA),
    prAssignment(9, staleB),
    prAssignment(10, staleC),
  );
  fixture.source.highWatermark = 10;
  await fixture.service.intake();

  const service = restart
    ? new WorkLedgerService({
        store: fixture.store,
        assignmentSource: fixture.source,
        exclusiveLease: new ExclusiveLease(),
        clock: fixture.time.clock,
        idFactory: incrementingIds(),
      })
    : fixture.service;
  if (restart) await service.recover();
  roots = (await service.listItems({ limit: 10 })).items;
  const pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const pendingC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  return { pendingA, pendingC, sealed, sealedB, service };
}

for (const scenario of [
  { reconcileOrder: "older-first", restart: false },
  { reconcileOrder: "newer-first", restart: true },
]) {
  test(`audit-only bindings preserve cross-root candidate order (${scenario.reconcileOrder}, restart=${scenario.restart})`, async () => {
    const {
      pendingA,
      pendingC,
      sealed,
      sealedB,
      service,
    } = await createAuditedCrossRootCandidateRace(scenario);

    assert.deepEqual(crossRootPullRequestCutoverCandidate(pendingA), {
      inputRevision: 2,
      sourceSequence: 3,
    });
    assert.deepEqual(crossRootPullRequestCutoverCandidate(pendingC), {
      inputRevision: 1,
      sourceSequence: 4,
    });
    const tamperedPending = structuredClone(pendingA);
    tamperedPending.source.pending.sourceSequence = 8;
    assert.throws(
      () => crossRootPullRequestCutoverCandidate(tamperedPending),
      (error) =>
        error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    );
    assert.equal(pendingA.source.bindings.at(-1).sourceSequence, 8);
    assert.equal(pendingC.source.bindings.at(-1).sourceSequence, 10);
    assert.equal(sealedB.source.current.sourceSequence, 2);
    assert.equal(sealedB.source.bindings.at(-1).sourceSequence, 9);
    assert.equal(pendingA.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(pendingC.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(sealedB.source.revisions.at(-1).disposition, "ignored_stale");
    assert.equal(pendingA.source.bindings.length, 4);
    assert.equal(pendingA.source.revisions.length, 3);
    assert.equal(pendingC.source.bindings.length, 3);
    assert.equal(pendingC.source.revisions.length, 2);
    assert.equal(sealedB.source.bindings.length, 3);
    assert.equal(sealedB.source.revisions.length, 2);
    assert.equal(
      sealedB.statusReason,
      `pr_source_cross_root_cutover_blocker:${pendingC.itemId}`,
    );
    const summaryBeforeAck = await service.getSummary();
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision,
        expectedRevision: pendingC.revision,
        expectedPendingRevision: pendingC.source.activeRevision + 1,
      }),
      (error) =>
        error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    );
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision - 1,
        expectedRevision: pendingC.revision,
        expectedPendingRevision: pendingC.source.activeRevision,
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
    await assert.rejects(
      service.reconcilePullRequestSource({
        itemId: pendingC.itemId,
        expectedGraphRevision: summaryBeforeAck.revision,
        expectedRevision: pendingC.revision + 1,
        expectedPendingRevision: pendingC.source.activeRevision,
      }),
      (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
    );
    await service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: sealedB.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "latest-candidate-after-audit-only-inputs" },
    });

    const graphRevision = (await service.getSummary()).revision;
    const olderCommand = {
      itemId: pendingA.itemId,
      expectedGraphRevision: graphRevision,
      expectedRevision: pendingA.revision,
      expectedPendingRevision: pendingA.source.pendingRevision,
    };
    const newerCommand = {
      itemId: pendingC.itemId,
      expectedGraphRevision: graphRevision,
      expectedRevision: pendingC.revision,
      expectedPendingRevision: pendingC.source.activeRevision,
    };
    let activated;
    if (scenario.reconcileOrder === "older-first") {
      await assert.rejects(
        service.reconcilePullRequestSource(olderCommand),
        (error) =>
          error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      );
      activated = await service.reconcilePullRequestSource(newerCommand);
    } else {
      activated = await service.reconcilePullRequestSource(newerCommand);
      await assert.rejects(
        service.reconcilePullRequestSource(olderCommand),
        (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
      );
    }

    assert.equal(activated.applied, true);
    const roots = (await service.listItems({ limit: 10 })).items;
    assert.equal(
      roots.find(({ itemId }) => itemId === pendingC.itemId).status,
      "queued",
    );
    assert.equal(
      roots.find(({ itemId }) => itemId === pendingA.itemId).status,
      "superseded",
    );
    assert.equal(
      roots.find(({ itemId }) => itemId === sealedB.itemId).status,
      "completed",
    );
  });
}

test("an existing-root return supersedes an older cross-root candidate", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  let rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  assert.equal(rootA.source.pendingRevision, 2);
  assert.equal(rootA.status, "dispatch_pending");
  assert.equal(rootA.statusReason, "pr_source_revised");
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const staleReconcile = await recovered.reconcilePullRequestSource({
    itemId: rootB.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootB.revision,
    expectedPendingRevision: rootB.source.activeRevision,
  });
  assert.equal(staleReconcile.applied, false);
  assert.equal(
    (await recovered.listItems({ limit: 10 })).items.find(
      ({ itemId }) => itemId === rootB.itemId,
    ).status,
    "superseded",
  );

  rootA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootA.itemId,
  );
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-returned-root" },
  });
  rootA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootA.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: rootA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootA.revision,
    expectedPendingRevision: 2,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  rootA = roots.find(({ itemId }) => itemId === rootA.itemId);
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(rootA.status, "queued");
  assert.equal(rootA.source.pendingRevision, null);
  assert.equal(rootB.status, "superseded");
  const claimed = await recovered.claim({
    itemId: rootA.itemId,
    expectedRevision: rootA.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");
});

test("a superseded automatic PR root ignores a later scope exit without blocking intake", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const supersededBefore = (await fixture.service.listItems({ limit: 10 }))
    .items.find(
      ({ source }) => source?.identity?.scopeId === "github-secondary",
    );
  assert.equal(supersededBefore.status, "superseded");
  assert.equal(
    supersededBefore.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );

  const leftEvent = prAssignment(4, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(4, leftEvent));
  fixture.source.highWatermark = 4;

  const result = await fixture.service.intake();
  const supersededAfter = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ itemId }) => itemId === supersededBefore.itemId);

  assert.equal(result.cursor, 4);
  assert.equal(supersededAfter.status, "superseded");
  assert.equal(supersededAfter.statusReason, supersededBefore.statusReason);
  assert.equal(supersededAfter.revision, supersededBefore.revision);
  assert.equal(supersededAfter.source.scope.active, true);
});

for (const sameScopeRoleTransfer of [false, true]) {
test(`a completed PR root returning behind sealed provenance waits without poisoning intake (same scope role transfer=${sameScopeRoleTransfer})`, async () => {
  const approvedFacts = {
    ...prGitFacts(PR_HEAD_A), relation: "authored", actionState: "waiting_other",
    nextAction: "wait_merge", reviewDecision: "APPROVED",
  };
  const initial = prAssignment(1, {
    sourceScopeId: "github-dashboard", gitFacts: approvedFacts,
  });
  if (sameScopeRoleTransfer) {
    initial.assignment.target.id = "tester";
    initial.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  }
  const fixture = await createFixture({
    records: [initial],
  });
  await fixture.service.intake();
  let rootA = (await fixture.service.listItems()).items[0];
  rootA = await fixture.service.claim({
    itemId: rootA.itemId, expectedRevision: rootA.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000,
  });
  rootA = await fixture.service.complete({
    itemId: rootA.itemId, expectedRevision: rootA.revision,
    leaseId: rootA.leaseId, actorId: "employee-pr-engineer",
    result: { outcome: "completed-before-provenance-return" },
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: sameScopeRoleTransfer ? "github-dashboard" : "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const rootB = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId !== rootA.itemId,
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const before = fixture.store.stored();
  assert.equal(before.items.find(({ itemId }) => itemId === rootA.itemId).status, "completed");
  const returned = prAssignment(3, {
    eventType: "pull_request.status", occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard", gitFacts: approvedFacts,
  });
  if (sameScopeRoleTransfer) {
    returned.assignment.target.id = "tester";
    returned.assignment.ruleId = AUTHORED_PR_APPROVED_RULE_ID;
  }
  fixture.source.records.push(returned, assignment(4));
  if (sameScopeRoleTransfer) {
    fixture.source.records.push(prScopeLifecycleAssignment(5, prAssignment(5, {
      eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-dashboard", gitFacts: prGitFacts(PR_HEAD_A),
    }).event));
  }
  fixture.source.highWatermark = sameScopeRoleTransfer ? 5 : 4;
  const intake = await fixture.service.intake();
  assert.equal(intake.cursor, fixture.source.highWatermark);
  const after = fixture.store.stored();
  const pending = after.items.find(({ itemId }) => itemId === rootA.itemId);
  assert.equal(pending.status, "blocked");
  assert.equal(pending.source.activeRevision, rootA.source.activeRevision);
  assert.ok(pending.source.pendingRevision > pending.source.activeRevision);
  assert.equal(pending.statusReason, `pr_source_cross_root_cutover_pending:${rootB.itemId}`);
  assert.deepEqual(pending.source.current, rootA.source.current);
  assert.equal(pending.activeIntentId, null);
  assert.equal(pending.leaseId, null);
  for (const mutate of [
    (item) => { item.statusReason = "pr_source_cross_root_cutover_pending:missing-root"; },
    (item) => { item.source.pendingRevision = item.source.activeRevision; },
    (item) => { item.source.pending.sourceSequence = item.source.current.sourceSequence; },
    (item) => { item.source.current.headRefOid = PR_HEAD_B; },
    (item) => { item.ownerId = "unreleased-owner"; },
    (item) => { item.activeIntentId = "unsettled-intent"; },
  ]) {
    const invalid = clone(after);
    mutate(invalid.items.find(({ itemId }) => itemId === rootA.itemId));
    assert.throws(() => validateWorkLedgerGraphTransition(before, invalid));
  }
  const recovered = (await createFixture({ store: fixture.store, source: fixture.source })).service;
  const pendingAfterRestart = (await recovered.listItems()).items.find(({ itemId }) => itemId === pending.itemId);
  if (sameScopeRoleTransfer) {
    const exited = after.items.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(exited.source.scope.active, false);
    assert.equal(exited.statusReason, "pr_source_left_scope_pending_settlement");
    assert.equal(exited.activeIntentId, sealed.outbox.intentId);
    for (const mutate of [
      (item) => { item.activeIntentId = null; },
      (item) => { item.source.scope.active = true; },
      (item) => { item.source.scope.revision -= 1; },
    ]) {
      const invalid = clone(after);
      mutate(invalid.items.find(({ itemId }) => itemId === rootB.itemId));
      assert.throws(() => validateWorkLedgerGraphTransition(before, invalid));
    }
    // The newer scope exit must not grant stale pending work execution rights.
    // A new trusted source observation is required before it can be activated.
    await assert.rejects(recovered.claim({
      itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
      workerId: "employee-tester", leaseDurationMs: 30_000,
    }));
    return;
  }
  const blocked = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedPendingRevision: pendingAfterRestart.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  const predecessor = (await recovered.listItems()).items.find(({ itemId }) => itemId === rootB.itemId);
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId, expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: predecessor.revision, dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "completed",
    details: { downstreamRef: "completed-root-return-review" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pendingAfterRestart.revision,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedPendingRevision: pendingAfterRestart.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
});
}

test("an existing root returning behind an active sealed provenance waits for settlement", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingBeforeReturn = (
    await fixture.service.listItems({ limit: 10 })
  ).items.find(({ itemId }) => itemId === rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const returnedA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(returnedA.status, "blocked");
  assert.equal(returnedA.source.activeRevision, 1);
  assert.equal(returnedA.source.pendingRevision, 2);
  assert.equal(
    returnedA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(sealedB.status, "dispatch_pending");
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${returnedA.itemId}`,
  );
  assert.equal(sealedB.revision, dispatchingBeforeReturn.revision + 1);
  assert.equal(sealed.outbox.itemId, sealedB.itemId);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const stillBlocked = await recovered.reconcilePullRequestSource({
    itemId: returnedA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: returnedA.revision,
    expectedPendingRevision: returnedA.source.pendingRevision,
  });
  assert.equal(stillBlocked.applied, false);
  assert.deepEqual(
    stillBlocked.blockers.map(({ itemId }) => itemId),
    [sealedB.itemId],
  );
  await assert.rejects(
    recovered.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: dispatchingBeforeReturn.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "stale-before-return-marker" },
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await recovered.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-return-cutover" },
  });
  const pendingA = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === returnedA.itemId,
  );
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === returnedA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(completedB.status, "completed");
});

for (const predecessorStatus of ["queued", "working"]) {
  test(`an existing root return atomically retires an active ${predecessorStatus} provenance`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    let roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    let rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    if (predecessorStatus === "working") {
      rootB = await fixture.service.claim({
        itemId: rootB.itemId,
        expectedRevision: rootB.revision,
        workerId: "employee-pr-engineer",
        leaseDurationMs: 30_000,
      });
    }
    fixture.source.records.push(prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 3;

    await fixture.service.intake();

    roots = (await fixture.service.listItems({ limit: 10 })).items;
    const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
    const retiredB = roots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(activeA.status, "queued");
    assert.equal(activeA.source.activeRevision, 2);
    assert.equal(activeA.source.pendingRevision, null);
    assert.equal(retiredB.status, "blocked");
    assert.equal(
      retiredB.statusReason,
      "pr_source_cross_root_cutover_retired",
    );
    assert.equal(retiredB.ownerId, null);
    assert.equal(retiredB.leaseId, null);
    assert.equal(retiredB.leaseUntil, null);
    assert.equal(retiredB.activeIntentId, null);
  });
}

test("an acknowledgement before an existing-root return permits immediate activation", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingB = (await fixture.service.listItems({ limit: 10 })).items
    .find(({ itemId }) => itemId === rootB.itemId);
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: dispatchingB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-before-return" },
  });
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(activeA.statusReason, "pr_source_revised");
  assert.equal(completedB.status, "completed");
});

test("an expired sealed active provenance is reclaimable after an existing-root return", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 10 })).items;
  const pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-return-crash",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, sealed.outbox.attempt + 1);
  assert.deepEqual(reclaimed.dispatchBinding, sealed.outbox.dispatchBinding);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-return-recovered" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  assert.equal(
    roots.find(({ itemId }) => itemId === pendingA.itemId).status,
    "queued",
  );
  assert.equal(
    roots.find(({ itemId }) => itemId === sealedB.itemId).status,
    "completed",
  );
});

for (const fence of [
  {
    name: "unavailable target",
    input: { gitFacts: { gitTargetAvailable: false } },
  },
  {
    name: "legacy target",
    input: { gitFacts: {} },
  },
  {
    name: "unproven Head",
    input: {
      headRefOid: PR_HEAD_C,
      gitFacts: prGitFacts(PR_HEAD_C),
    },
  },
]) {
  test(`an ${fence.name} fence registers the last operational sealed provenance`, async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const rootB = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-tertiary",
    ...fence.input,
  }));
  fixture.source.highWatermark = 3;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const fencedC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  assert.equal(fencedC.status, "blocked");
  assert.equal(
    fencedC.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${fencedC.itemId}`,
  );
  const fencedReconciliation = await fixture.service
    .reconcilePullRequestSource({
      itemId: fencedC.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: fencedC.revision,
      expectedPendingRevision: fencedC.source.activeRevision,
    });
  assert.equal(fencedReconciliation.applied, false);
  assert.equal(
    fencedReconciliation.blockers[0].reason,
    "source_authority_fenced",
  );
  });
}

for (const fence of [
  {
    name: "unavailable target",
    input: { gitFacts: { gitTargetAvailable: false } },
    disposition: "ignored_authority_fence",
  },
  {
    name: "legacy target",
    input: { gitFacts: {} },
    disposition: "ignored_legacy_downgrade",
  },
  {
    name: "unproven Head",
    input: {
      headRefOid: PR_HEAD_C,
      gitFacts: prGitFacts(PR_HEAD_C),
    },
    disposition: "ignored_unproven_head",
  },
]) {
  test(`an existing ${fence.name} fence registers its operational sealed predecessor`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    const roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    const rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    await stageSealedPrReview(fixture, rootB.itemId);
    fixture.source.records.push(prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-dashboard",
      ...fence.input,
    }));
    fixture.source.highWatermark = 3;

    await fixture.service.intake();

    const fencedRoots = (await fixture.service.listItems({ limit: 10 })).items;
    const fencedA = fencedRoots.find(({ itemId }) => itemId === rootA.itemId);
    const sealedB = fencedRoots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(fencedA.status, "blocked");
    assert.equal(fencedA.source.pendingRevision, null);
    assert.equal(fencedA.source.revisions.at(-1).disposition, fence.disposition);
    assert.equal(
      fencedA.statusReason,
      `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
    );
    assert.equal(
      sealedB.statusReason,
      `pr_source_cross_root_cutover_blocker:${fencedA.itemId}`,
    );
    const fencedReconciliation = await fixture.service
      .reconcilePullRequestSource({
        itemId: fencedA.itemId,
        expectedGraphRevision: (await fixture.service.getSummary()).revision,
        expectedRevision: fencedA.revision,
        expectedPendingRevision: fencedA.source.activeRevision,
      });
    assert.equal(fencedReconciliation.applied, false);
    assert.equal(
      fencedReconciliation.blockers[0].reason,
      "source_authority_fenced",
    );
  });
}

async function createExistingFenceScenario() {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const oldBinding = prExecutionBinding(rootB);
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  const dispatchingBeforeFence = (
    await fixture.service.listItems({ limit: 10 })
  ).items.find(({ itemId }) => itemId === rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  return {
    fixture,
    rootA: roots.find(({ itemId }) => itemId === rootA.itemId),
    rootB: roots.find(({ itemId }) => itemId === rootB.itemId),
    dispatchingBeforeFence,
    oldBinding,
    sealed,
  };
}

test("a fenced candidate keeps its exact observation across audit-only bindings", async () => {
  const { fixture, rootA, rootB } = await createExistingFenceScenario();
  const staleAudit = {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T00:59:00.000Z",
    sourceScopeId: "github-dashboard",
    ciStatus: "FAILURE",
    gitFacts: prGitFacts(PR_HEAD_A, {
      sourceAccountId: "audit-only-account",
    }),
  };
  fixture.source.records.push(
    prAssignment(4, staleAudit),
    prAssignment(5, staleAudit),
  );
  fixture.source.highWatermark = 5;
  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const roots = (await recovered.listItems({ limit: 10 })).items;
  const fencedA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(fencedA.source.pendingRevision, null);
  assert.equal(fencedA.source.revisions.at(-1).disposition, "ignored_stale");
  assert.equal(fencedA.source.bindings.at(-1).sourceSequence, 5);
  assert.deepEqual(crossRootPullRequestCutoverCandidate(fencedA), {
    inputRevision: 2,
    sourceSequence: 3,
  });
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${fencedA.itemId}`,
  );

  const tampered = structuredClone(fencedA);
  const fenceBinding = tampered.source.bindings.find(
    ({ inputRevision }) => inputRevision === 2,
  );
  fenceBinding.inputRevision = 3;
  assert.throws(
    () => crossRootPullRequestCutoverCandidate(tampered),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const fenced = await recovered.reconcilePullRequestSource({
    itemId: fencedA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: fencedA.revision,
    expectedPendingRevision: fencedA.source.activeRevision,
  });
  assert.equal(fenced.applied, false);
  assert.equal(fenced.blockers[0].reason, "source_authority_fenced");
});

test("an active acknowledgement after an existing fence permits trusted return", async () => {
  const { fixture, rootA, rootB, sealed } =
    await createExistingFenceScenario();
  await fixture.service.ackIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    itemExpectedRevision: rootB.revision,
    dispatchLeaseId: sealed.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "existing-fence-active-ack" },
  });
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  const roots = (await fixture.service.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
  const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 3);
  assert.equal(activeA.source.pendingRevision, null);
  assert.equal(completedB.status, "completed");
});

test("an existing fence transfers to trusted pending input and survives restart recovery", async () => {
  const {
    fixture,
    rootA: fencedA,
    rootB: fencedB,
    dispatchingBeforeFence,
    oldBinding,
    sealed,
  } = await createExistingFenceScenario();
  assert.equal(fencedB.revision, dispatchingBeforeFence.revision + 1);
  await assert.rejects(
    fixture.service.ackIntent({
      intentId: sealed.outbox.intentId,
      expectedRevision: sealed.outbox.revision,
      itemExpectedRevision: dispatchingBeforeFence.revision,
      dispatchLeaseId: sealed.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "stale-existing-fence-ack" },
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let pendingA = roots.find(({ itemId }) => itemId === fencedA.itemId);
  let sealedB = roots.find(({ itemId }) => itemId === fencedB.itemId);
  assert.equal(pendingA.status, "blocked");
  assert.equal(pendingA.source.pendingRevision, 3);
  assert.equal(
    pendingA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: pendingA.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: pendingA.revision,
      expectedPendingRevision: fencedA.source.activeRevision,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  fixture.time.advance(30_000);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-existing-fence",
    leaseDurationMs: 30_000,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  pendingA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  sealedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "existing-fence-reclaimed" },
  });
  await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 3);
  assert.equal(activeA.source.pendingRevision, null);
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(activeA);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
});

test("a trusted return transfers a fenced sealed predecessor into recoverable cutover", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  const oldBinding = prExecutionBinding(rootB);
  const sealed = await stageSealedPrReview(fixture, rootB.itemId);
  fixture.source.records.push(prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-tertiary",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  let pendingA = roots.find(({ itemId }) => itemId === rootA.itemId);
  let sealedB = roots.find(({ itemId }) => itemId === rootB.itemId);
  const fencedC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  assert.equal(pendingA.status, "blocked");
  assert.equal(pendingA.source.pendingRevision, 2);
  assert.equal(
    pendingA.statusReason,
    `pr_source_cross_root_cutover_pending:${sealedB.itemId}`,
  );
  assert.equal(
    sealedB.statusReason,
    `pr_source_cross_root_cutover_blocker:${pendingA.itemId}`,
  );
  assert.equal(fencedC.status, "superseded");
  assert.equal(
    fencedC.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(blocked.applied, false);
  fixture.time.advance(30_000);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-authority-fence",
    leaseDurationMs: 30_000,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  pendingA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  sealedB = roots.find(({ itemId }) => itemId === sealedB.itemId);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: sealedB.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-fenced-recovered" },
  });
  const activated = await recovered.reconcilePullRequestSource({
    itemId: pendingA.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingA.revision,
    expectedPendingRevision: pendingA.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  roots = (await recovered.listItems({ limit: 10 })).items;
  const activeA = roots.find(({ itemId }) => itemId === pendingA.itemId);
  assert.equal(activeA.status, "queued");
  assert.equal(activeA.source.activeRevision, 2);
  assert.equal(activeA.source.pendingRevision, null);
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(
      prExecutionBinding(activeA),
    ),
    prExecutionBinding(activeA),
  );
});

for (const acknowledgementOrder of ["before", "after"]) {
  test(`a trusted return converges when sealed work is acknowledged ${acknowledgementOrder} its fence`, async () => {
    const fixture = await createFixture({
      records: [prAssignment(1, {
        sourceScopeId: "github-dashboard",
        gitFacts: prGitFacts(PR_HEAD_A),
      })],
    });
    await fixture.service.intake();
    fixture.source.records.push(prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    let roots = (await fixture.service.listItems({ limit: 10 })).items;
    const rootA = roots.find(
      ({ source }) => source.identity.scopeId === "github-dashboard",
    );
    const rootB = roots.find(
      ({ source }) => source.identity.scopeId === "github-secondary",
    );
    const sealed = await stageSealedPrReview(fixture, rootB.itemId);
    const acknowledge = async () => {
      const currentB = (
        await fixture.service.listItems({ limit: 10 })
      ).items.find(({ itemId }) => itemId === rootB.itemId);
      await fixture.service.ackIntent({
        intentId: sealed.outbox.intentId,
        expectedRevision: sealed.outbox.revision,
        itemExpectedRevision: currentB.revision,
        dispatchLeaseId: sealed.outbox.dispatchLeaseId,
        actorId: "work-intent-dispatcher",
        outcome: "delivered",
        nextStatus: "completed",
        details: { downstreamRef: `ack-${acknowledgementOrder}-fence` },
      });
    };
    if (acknowledgementOrder === "before") await acknowledge();
    fixture.source.records.push(prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: { gitTargetAvailable: false },
    }));
    fixture.source.highWatermark = 3;
    await fixture.service.intake();
    if (acknowledgementOrder === "after") await acknowledge();
    fixture.source.records.push(prAssignment(4, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    }));
    fixture.source.highWatermark = 4;

    await fixture.service.intake();

    roots = (await fixture.service.listItems({ limit: 10 })).items;
    const activeA = roots.find(({ itemId }) => itemId === rootA.itemId);
    const completedB = roots.find(({ itemId }) => itemId === rootB.itemId);
    assert.equal(activeA.status, "queued");
    assert.equal(activeA.source.activeRevision, 2);
    assert.equal(activeA.source.pendingRevision, null);
    assert.equal(completedB.status, "completed");
  });
}

async function createReplacedPendingRootScenario() {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  const sealedA = await stageSealedPrReview(fixture);
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const rootA = roots.find(({ itemId }) => itemId === sealedA.rootItemId);
  let rootB = roots.find(
    ({ source }) => source.identity.scopeId === "github-secondary",
  );
  let rootC = roots.find(
    ({ source }) => source.identity.scopeId === "github-tertiary",
  );
  await fixture.service.ackIntent({
    intentId: sealedA.outbox.intentId,
    expectedRevision: sealedA.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealedA.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-before-c" },
  });
  await fixture.service.reconcilePullRequestSource({
    itemId: rootC.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: rootC.revision,
    expectedPendingRevision: rootC.source.activeRevision,
  });
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  assert.equal(rootC.status, "queued");
  return { fixture, rootB, rootC };
}

for (const predecessorStatus of ["queued", "working", "completed", "sealed"]) {
  test(`a replaced pending source root returns after a ${predecessorStatus} successor`, async () => {
  const { fixture, rootB: replacedB, rootC: queuedC } =
    await createReplacedPendingRootScenario();
  let rootC = queuedC;
  let sealedC = null;
  if (["working", "completed"].includes(predecessorStatus)) {
    rootC = await fixture.service.claim({
      itemId: rootC.itemId,
      expectedRevision: rootC.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    });
  }
  if (predecessorStatus === "completed") {
    rootC = await fixture.service.complete({
      itemId: rootC.itemId,
      expectedRevision: rootC.revision,
      leaseId: rootC.leaseId,
      actorId: "employee-pr-engineer",
      result: { outcome: "successor-completed" },
    });
  }
  if (predecessorStatus === "sealed") {
    sealedC = await stageSealedPrReview(fixture, rootC.itemId);
    rootC = (await fixture.service.listItems({ limit: 10 })).items.find(
      ({ itemId }) => itemId === rootC.itemId,
    );
  }
  const oldBinding = prExecutionBinding(replacedB);
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;

  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let rootB = roots.find(({ itemId }) => itemId === replacedB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  if (sealedC !== null) {
    assert.equal(rootB.status, "blocked");
    assert.equal(rootB.source.pendingRevision, 2);
    await recovered.ackIntent({
      intentId: sealedC.outbox.intentId,
      expectedRevision: sealedC.outbox.revision,
      itemExpectedRevision: rootC.revision,
      dispatchLeaseId: sealedC.outbox.dispatchLeaseId,
      actorId: "work-intent-dispatcher",
      outcome: "delivered",
      nextStatus: "completed",
      details: { downstreamRef: "github-review-proposal-before-b-return" },
    });
    await recovered.reconcilePullRequestSource({
      itemId: rootB.itemId,
      expectedGraphRevision: (await recovered.getSummary()).revision,
      expectedRevision: rootB.revision,
      expectedPendingRevision: rootB.source.pendingRevision,
    });
    roots = (await recovered.listItems({ limit: 10 })).items;
    rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
    rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  }
  assert.equal(rootB.status, "queued");
  assert.equal(
    rootB.statusReason,
    predecessorStatus === "sealed"
      ? "pr_source_cutover_activated"
      : "pr_source_revised",
  );
  assert.equal(rootB.source.activeRevision, 2);
  assert.equal(rootB.source.pendingRevision, null);
  assert.equal(rootC.ownerId, null);
  assert.equal(rootC.leaseId, null);
  assert.equal(rootC.leaseUntil, null);
  assert.equal(
    rootC.status,
    ["completed", "sealed"].includes(predecessorStatus)
      ? "completed"
      : "blocked",
  );
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(rootB);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
  const claimedB = await recovered.claim({
    itemId: rootB.itemId,
    expectedRevision: rootB.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedB.status, "working");
  });
}

test("a durable replaced root activates its pending return after successor settlement", async () => {
  const { fixture, rootB: replacedB, rootC: queuedC } =
    await createReplacedPendingRootScenario();
  const sealedC = await stageSealedPrReview(fixture, queuedC.itemId);
  fixture.source.records.push(prAssignment(4, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:15:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();

  const durable = fixture.store.stored();
  const pendingB = durable.items.find(
    ({ itemId }) => itemId === replacedB.itemId,
  );
  assert.equal(pendingB.status, "blocked");
  assert.equal(pendingB.source.pendingRevision, 2);
  pendingB.status = "superseded";
  pendingB.statusReason = "pr_source_cross_root_cutover_replaced";
  fixture.store.replaceStored(durable);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let rootC = roots.find(({ itemId }) => itemId === queuedC.itemId);
  await recovered.ackIntent({
    intentId: sealedC.outbox.intentId,
    expectedRevision: sealedC.outbox.revision,
    itemExpectedRevision: rootC.revision,
    dispatchLeaseId: sealedC.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "settled-before-durable-return" },
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  const rootB = roots.find(({ itemId }) => itemId === replacedB.itemId);

  await recovered.reconcilePullRequestSource({
    itemId: rootB.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: rootB.revision,
    expectedPendingRevision: rootB.source.pendingRevision,
  });

  const activated = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootB.itemId,
  );
  assert.equal(activated.status, "queued");
  assert.equal(activated.statusReason, "pr_source_cutover_activated");
  assert.equal(activated.source.activeRevision, 2);
  assert.equal(activated.source.pendingRevision, null);
});

test("reactivating a replaced source root never revives its old child or intent", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  let rootB = roots[0];
  const childResult = await fixture.service.createGraphChild(
    prGraphChildCommand(
      rootB,
      (await fixture.service.getSummary()).revision,
      "historic-b-child",
    ),
  );
  let child = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === childResult.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  child = await fixture.service.complete({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    result: { outcome: "historic-child-completed" },
  });
  const oldChildBinding = prExecutionBinding(child);
  const sealedB = await stageSealedPrReview(fixture, rootB.itemId);
  rootB = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === rootB.itemId,
  );
  const oldRootBinding = prExecutionBinding(rootB);
  await fixture.service.ackIntent({
    intentId: sealedB.outbox.intentId,
    expectedRevision: sealedB.outbox.revision,
    itemExpectedRevision: rootB.revision,
    dispatchLeaseId: sealedB.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T03:00:00.000Z",
    details: { code: "historic-b-intent-failed" },
  });
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  let rootA = (await fixture.service.listItems({ limit: 10 })).items.find(
    ({ source }) => source?.identity?.scopeId === "github-dashboard",
  );
  const sealedA = await stageSealedPrReview(fixture, rootA.itemId);
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      sourceScopeId: "github-secondary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(4, {
      occurredAt: "2026-08-02T01:15:00.000Z",
      sourceScopeId: "github-tertiary",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  );
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootA = roots.find(({ itemId }) => itemId === rootA.itemId);
  let rootC = roots.find(
    ({ source }) => source?.identity?.scopeId === "github-tertiary",
  );
  await fixture.service.ackIntent({
    intentId: sealedA.outbox.intentId,
    expectedRevision: sealedA.outbox.revision,
    itemExpectedRevision: rootA.revision,
    dispatchLeaseId: sealedA.outbox.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "a-before-c-activation" },
  });
  await fixture.service.reconcilePullRequestSource({
    itemId: rootC.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: rootC.revision,
    expectedPendingRevision: rootC.source.activeRevision,
  });
  roots = (await fixture.service.listItems({ limit: 10 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  assert.equal(rootB.status, "superseded");
  assert.equal(
    rootB.statusReason,
    "pr_source_cross_root_cutover_replaced",
  );
  fixture.source.records.push(prAssignment(5, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:20:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 5;
  await fixture.service.intake();

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  roots = (await recovered.listItems({ limit: 20 })).items;
  rootB = roots.find(({ itemId }) => itemId === rootB.itemId);
  rootC = roots.find(({ itemId }) => itemId === rootC.itemId);
  child = roots.find(({ itemId }) => itemId === child.itemId);
  const historicalOutbox = (await recovered.listOutbox({ limit: 20 })).items
    .find(({ intentId }) => intentId === sealedB.outbox.intentId);
  assert.equal(rootB.status, "queued");
  assert.equal(rootB.source.activeRevision, 3);
  assert.equal(rootB.activeIntentId, null);
  assert.equal(rootC.status, "blocked");
  assert.equal(child.status, "completed");
  assert.equal(historicalOutbox.status, "failed");
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldRootBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  await assert.rejects(
    recovered.verifyPullRequestExecutionBinding(oldChildBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const newBinding = prExecutionBinding(rootB);
  assert.deepEqual(
    await recovered.verifyPullRequestExecutionBinding(newBinding),
    newBinding,
  );
  const claimedB = await recovered.claim({
    itemId: rootB.itemId,
    expectedRevision: rootB.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedB.status, "working");
});

test("a crashed cross-root sealed action can be reclaimed only for settlement", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let roots = (await recovered.listItems({ limit: 10 })).items;
  let oldRoot = roots.find(({ itemId }) => itemId === sealed.rootItemId);
  let pendingRoot = roots.find(({ itemId }) => itemId !== oldRoot.itemId);
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-crash",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, sealed.outbox.attempt + 1);
  assert.deepEqual(reclaimed.dispatchBinding, sealed.outbox.dispatchBinding);
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: oldRoot.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-recovered" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });
  roots = (await recovered.listItems({ limit: 10 })).items;
  assert.equal(
    roots.find(({ itemId }) => itemId === pendingRoot.itemId).status,
    "queued",
  );
});

test("a crashed sealed child registered in cross-root cutover can settle", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const sealed = await stageSealedPrChildReview(fixture);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(30_000);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  let items = (await recovered.listItems({ limit: 10 })).items;
  let child = items.find(({ itemId }) => itemId === sealed.childItemId);
  let pendingRoot = items.find(
    ({ source }) => source?.identity?.scopeId === "github-secondary",
  );
  assert.equal(
    child.statusReason,
    `pr_source_cross_root_cutover_blocker:${pendingRoot.itemId}`,
  );
  const reclaimed = await recovered.claimIntent({
    intentId: sealed.outbox.intentId,
    expectedRevision: sealed.outbox.revision,
    dispatcherId: "dispatcher-after-child-crash",
    leaseDurationMs: 30_000,
  });
  await recovered.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: child.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-child-recovered" },
  });
  pendingRoot = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === pendingRoot.itemId,
  );
  await recovered.reconcilePullRequestSource({
    itemId: pendingRoot.itemId,
    expectedGraphRevision: (await recovered.getSummary()).revision,
    expectedRevision: pendingRoot.revision,
    expectedPendingRevision: pendingRoot.source.activeRevision,
  });
  items = (await recovered.listItems({ limit: 10 })).items;
  child = items.find(({ itemId }) => itemId === child.itemId);
  assert.equal(child.status, "completed");
  assert.equal(
    items.find(({ itemId }) => itemId === pendingRoot.itemId).status,
    "queued",
  );
});

test("an expired sealed old-Head intent is reclaimed and settled before cutover", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: root.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "dispatcher-before-crash",
    leaseDurationMs: 1_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.time.advance(1_000);

  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const reclaimed = await fixture.service.claimIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    dispatcherId: "dispatcher-after-crash",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(reclaimed.dispatchBinding, sealed.dispatchBinding);
  assert.equal(reclaimed.attempt, sealed.attempt + 1);
  await fixture.service.ackIntent({
    intentId: reclaimed.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: root.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-recovered" },
  });
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const activated = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });

  assert.equal(activated.applied, true);
  assert.equal(activated.activeRevision, 2);
  assert.equal(
    (await fixture.service.listOutbox()).items[0].sourceBinding.headRefOid,
    PR_HEAD_A,
  );
});

test("PR source reconciliation is targeted by graph, item, and pending revision CAS", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "blocked",
    actorId: "work-ledger-system",
    reason: "hold-for-cutover-cas-test",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  const graphRevision = (await fixture.service.getSummary()).revision;
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: graphRevision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      ...command,
      expectedGraphRevision: graphRevision - 1,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      ...command,
      expectedRevision: root.revision + 1,
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  assert.equal(fixture.store.writes.length, writesBefore);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  await assert.rejects(
    fixture.service.reconcilePullRequestSource({
      itemId: root.itemId,
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedRevision: root.revision,
      expectedPendingRevision: 2,
    }),
    (error) =>
      error.code === "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  );
  assert.equal(root.source.activeRevision, 1);
  assert.equal(root.source.pendingRevision, 3);
});

test("PR source reconciliation converges after a lost durable acknowledgement", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "blocked",
    actorId: "work-ledger-system",
    reason: "hold-before-new-head",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items[0];
  root = await fixture.service.transition({
    itemId: root.itemId,
    expectedRevision: root.revision,
    leaseId: null,
    toStatus: "queued",
    actorId: "work-ledger-system",
    reason: "local-work-is-quiescent",
  });
  const command = {
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  };
  const durableWrite = fixture.store.write.bind(fixture.store);
  let loseAcknowledgement = true;
  fixture.store.write = async (...args) => {
    await durableWrite(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("durable acknowledgement lost");
    }
  };

  await assert.rejects(
    fixture.service.reconcilePullRequestSource(command),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  const writesAfterLostAcknowledgement = fixture.store.writes.length;
  const durableRoot = fixture.store.stored().items.find(
    ({ itemId }) => itemId === root.itemId,
  );
  assert.equal(durableRoot.source.activeRevision, 2);
  assert.equal(durableRoot.source.pendingRevision, null);

  const replay = await fixture.service.reconcilePullRequestSource(command);
  assert.equal(replay.applied, false);
  assert.equal(replay.activeRevision, 2);
  assert.equal(fixture.store.writes.length, writesAfterLostAcknowledgement);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 100 })).items
      .filter(({ type }) => type === "pr_source_activated").length,
    1,
  );
});

test("PR graph children are Head-bound and old epochs become neutral superseded work", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const first = await fixture.service.createGraphChild(
    prGraphChildCommand(root, 1),
  );
  let firstChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === first.taskId,
  );
  const graph = await fixture.service.getGraphSnapshot();
  const projectedChild = graph.graph.tasks.find(
    ({ taskId }) => taskId === first.taskId,
  );
  assert.equal(
    graph.graph.tasks.some(({ taskId }) => taskId === root.itemId),
    true,
  );
  assert.equal(projectedChild.parentTaskId, root.itemId);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.rootItemId, root.itemId);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.headRevision, 1);
  assert.equal(firstChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_A);

  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const afterCutover = (await fixture.service.listItems()).items;
  root = afterCutover.find(({ kind }) => kind === "source_root");
  firstChild = afterCutover.find(({ itemId }) => itemId === first.taskId);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(firstChild.status, "superseded");
  assert.equal(firstChild.statusReason, "pr_head_superseded");
  const claimedRoot = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  root = await fixture.service.handoff({
    itemId: claimedRoot.itemId,
    expectedRevision: claimedRoot.revision,
    leaseId: claimedRoot.leaseId,
    actorId: "employee-pr-engineer",
    target: { type: "role", id: "pr-engineer" },
    reason: "decompose-new-head",
  });
  const crossEpochDependency = prGraphChildCommand(
    root,
    (await fixture.service.getSummary()).revision,
    "must-not-depend-on-old-head",
  );
  crossEpochDependency.command.dependsOnTaskIds = [first.taskId];
  crossEpochDependency.command.expectedTaskRevisions.push({
    taskId: first.taskId,
    revision: firstChild.revision,
  });
  await assert.rejects(
    fixture.service.createGraphChild(crossEpochDependency),
    (error) => error.code === "WORK_LEDGER_GRAPH_SOURCE_EPOCH_CONFLICT",
  );
  const second = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  const secondChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === second.taskId,
  );
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(secondChild.assignment.graphTask.sourceBinding.headRevision, 2);
  assert.equal(secondChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_B);

  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const third = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  const thirdChild = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === third.taskId,
  );
  assert.notEqual(third.taskId, first.taskId);
  assert.notEqual(third.taskId, second.taskId);
  assert.equal(thirdChild.assignment.graphTask.sourceBinding.headRevision, 3);
  assert.equal(thirdChild.assignment.graphTask.sourceBinding.headRefOid, PR_HEAD_A);
});

test("a cancelled old-Head child becomes neutral when the next Head activates", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, (await fixture.service.getSummary()).revision),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  await fixture.service.cancelGraphTask({
    itemId: child.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: child.revision,
    actorId: "employee-orchestrator",
    reason: "obsolete-old-head-plan",
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  const items = (await fixture.service.listItems()).items;
  root = items.find(({ kind }) => kind === "source_root");
  child = items.find(({ itemId }) => itemId === child.itemId);
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(child.status, "superseded");
  assert.equal(child.statusReason, "pr_head_superseded");
  const claimedRoot = await fixture.service.claim({
    itemId: root.itemId,
    expectedRevision: root.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimedRoot.status, "working");
});

test("a sealed old-Head child blocks root activation until its action is settled", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(
    prGraphChildCommand(root, 1),
  );
  let child = (await fixture.service.listItems()).items.find(
    ({ itemId }) => itemId === created.taskId,
  );
  child = await fixture.service.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: child.itemId,
    expectedRevision: child.revision,
    leaseId: child.leaseId,
    actorId: "employee-developer",
    roleId: "developer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item, {
      requestedBy: {
        roleId: "developer",
        workItemId: staged.item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();

  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  assert.equal(root.source.current.headRefOid, PR_HEAD_A);
  assert.equal(root.source.pending.headRefOid, PR_HEAD_B);
  const blocked = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(blocked.applied, false);
  assert.deepEqual(blocked.blockers, [{
      itemId: child.itemId,
      status: "dispatch_pending",
      reason: "active_intent",
      activeIntentId: sealed.intentId,
    }]);
  await assert.rejects(
    fixture.service.claim({
      itemId: root.itemId,
      expectedRevision: root.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  );

  await fixture.service.ackIntent({
    intentId: sealed.intentId,
    expectedRevision: sealed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatchLeaseId: sealed.dispatchLeaseId,
    actorId: "work-intent-dispatcher",
    outcome: "delivered",
    nextStatus: "completed",
    details: { downstreamRef: "github-review-proposal-child-1" },
  });
  root = (await fixture.service.listItems()).items.find(
    ({ kind }) => kind === "source_root",
  );
  const activated = await fixture.service.reconcilePullRequestSource({
    itemId: root.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedRevision: root.revision,
    expectedPendingRevision: 2,
  });
  assert.equal(activated.applied, true);
  assert.equal(activated.activeRevision, 2);
  assert.deepEqual(activated.blockers, []);

  const settledItems = (await fixture.service.listItems()).items;
  root = settledItems.find(({ kind }) => kind === "source_root");
  child = settledItems.find(({ itemId }) => itemId === child.itemId);
  const historical = (await fixture.service.listOutbox()).items[0];
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(child.status, "superseded");
  assert.equal(historical.sourceBinding.rootItemId, root.itemId);
  assert.equal(historical.sourceBinding.headRevision, 1);
  assert.equal(historical.sourceBinding.headRefOid, PR_HEAD_A);
});

test("an unproven newer PR Head is audited but never activated", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(item.source.inputRevision, 2);
  assert.equal(item.source.activeRevision, 1);
  assert.equal(item.source.headRevision, 1);
  assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  assert.equal(
    item.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
});

test("recovery blocks legacy queued PR roots whose source authority is fenced", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  legacy.items[0].status = "queued";
  legacy.items[0].statusReason = null;
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const item = (await recovered.service.listItems()).items[0];

  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
  assert.equal(item.revision, legacy.items[0].revision + 1);
  assert.equal((await recovered.service.getSummary()).revision, legacy.revision + 1);
});

test("recovery blocks legacy retry-wait PR roots whose source authority is fenced", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  legacy.items[0].status = "retry_wait";
  legacy.items[0].availableAt = "2026-08-02T01:00:00.000Z";
  legacy.items[0].statusReason = "decision_failed";
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const item = (await recovered.service.listItems()).items[0];

  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "pr_source_authority_fenced");
  assert.equal(item.availableAt, null);
});

test("recovery isolates PR authority fences by subject", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1),
      prAssignment(2, {
        pullRequestNumber: 43,
        title: "PR 43 remains trusted",
      }),
    ],
  });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  const legacy = fixture.store.stored();
  const fenced = legacy.items.find(
    ({ source }) => source?.identity?.pullRequestNumber === 42,
  );
  fenced.status = "queued";
  fenced.statusReason = null;
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const roots = (await recovered.service.listItems({ limit: 10 })).items;
  const byNumber = new Map(
    roots.map((item) => [item.source.identity.pullRequestNumber, item]),
  );

  assert.equal(byNumber.get(42).status, "blocked");
  assert.equal(byNumber.get(42).statusReason, "pr_source_authority_fenced");
  assert.equal(byNumber.get(43).status, "queued");
});

test("a legitimate A to B to A force-push creates three distinct Head epochs", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_A,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(item.source.activeRevision, 3);
  assert.equal(item.source.headRevision, 3);
  assert.equal(item.source.current.headRefOid, PR_HEAD_A);
  assert.deepEqual(
    item.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("provenance return intake follows the global PR Head chain", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      headRefOid: PR_HEAD_A,
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      sourceScopeId: "replacement-scope",
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_C,
      previousHeadRefOid: PR_HEAD_B,
      changedFields: ["headRefOid"],
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const returnedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const replacedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "replacement-scope",
  );

  assert.equal(roots.length, 2);
  assert.equal(returnedRoot.source.current.headRefOid, PR_HEAD_C);
  assert.equal(returnedRoot.source.revisions.at(-1).disposition, "accepted");
  assert.equal(
    returnedRoot.source.revisions.at(-1).causalHeadRefOid,
    PR_HEAD_B,
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(returnedRoot),
    ),
    prExecutionBinding(returnedRoot),
  );
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(replacedRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a status-only provenance return catches up to the trusted Head and recovers", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      headRefOid: PR_HEAD_A,
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      sourceScopeId: "replacement-scope",
    }),
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:10:00.000Z",
      headRefOid: PR_HEAD_B,
      changedFields: ["ciStatus"],
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const recovered = await createFixture({ records, store: fixture.store });
  const roots = (await recovered.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");
  const returnedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const replacedRoot = roots.find(
    ({ source }) => source.identity.scopeId === "replacement-scope",
  );

  assert.equal(returnedRoot.source.current.headRefOid, PR_HEAD_B);
  assert.equal(returnedRoot.source.revisions.at(-1).previousHeadRefOid, null);
  assert.equal(
    returnedRoot.source.revisions.at(-1).causalHeadRefOid,
    PR_HEAD_B,
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(returnedRoot),
    ),
    prExecutionBinding(returnedRoot),
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(
      prExecutionBinding(replacedRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("provenance round trips never resurrect an earlier exact binding", async (t) => {
  for (const scenario of [
    {
      name: "same Head",
      replacementHead: PR_HEAD_A,
      returnOptions: {},
      replacementOptions: {},
    },
    {
      name: "A to B to A",
      replacementHead: PR_HEAD_B,
      replacementOptions: {
        previousHeadRefOid: PR_HEAD_A,
        changedFields: ["headRefOid"],
      },
      returnOptions: {
        previousHeadRefOid: PR_HEAD_B,
        changedFields: ["headRefOid"],
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const initial = prAssignment(1, {
        occurredAt: "2026-08-02T01:00:00.000Z",
        headRefOid: PR_HEAD_A,
        gitFacts: prGitFacts(PR_HEAD_A),
      });
      const fixture = await createFixture({ records: [initial] });
      await fixture.service.intake({ limit: 10 });
      const initialRoot = (await fixture.service.listItems({ limit: 10 }))
        .items.find(({ kind }) => kind === "source_root");
      const oldBinding = prExecutionBinding(initialRoot);
      const replacement = prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: scenario.replacementHead,
        sourceScopeId: "replacement-scope",
        gitFacts: prGitFacts(scenario.replacementHead),
        ...scenario.replacementOptions,
      });
      const returned = prAssignment(3, {
        occurredAt: "2026-08-02T01:10:00.000Z",
        headRefOid: PR_HEAD_A,
        gitFacts: prGitFacts(PR_HEAD_A),
        ...scenario.returnOptions,
      });
      fixture.source.records.push(replacement, returned);
      fixture.source.highWatermark = 3;
      await fixture.service.intake({ limit: 10 });

      const recovered = await createFixture({
        records: [initial, replacement, returned],
        store: fixture.store,
      });
      const roots = (await recovered.service.listItems({ limit: 10 })).items
        .filter(({ kind }) => kind === "source_root");
      const returnedRoot = roots.find(
        ({ source }) => source.identity.scopeId === "github-dashboard",
      );
      const currentBinding = prExecutionBinding(returnedRoot);

      assert.deepEqual(
        returnedRoot.source.revisions.map(({ headRevision }) => headRevision),
        [1, 2],
      );
      assert.deepEqual(
        returnedRoot.source.revisions.map(
          ({ authorityEpochChanged }) => authorityEpochChanged,
        ),
        [false, true],
      );
      await assert.rejects(
        recovered.service.verifyPullRequestExecutionBinding(oldBinding),
        (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
      );
      assert.deepEqual(
        await recovered.service.verifyPullRequestExecutionBinding(
          currentBinding,
        ),
        currentBinding,
      );
    });
  }
});

test("an exact target rollback stays in a newer authority epoch after restart", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const changed = prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A, { baseRefOid: "e".repeat(40) }),
  });
  const rolledBack = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(changed, rolledBack);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });

  const recovered = await createFixture({
    records: [initial, changed, rolledBack],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("restart cuts over ambiguous legacy target history before authorizing bindings", async () => {
  const records = [
    prAssignment(1, {
      occurredAt: "2026-08-02T01:00:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A, { baseRefOid: "e".repeat(40) }),
    }),
    prAssignment(3, {
      occurredAt: "2026-08-02T01:10:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A),
    }),
  ];
  const fixture = await createFixture({ records });
  await fixture.service.intake({ limit: 10 });
  const beforeUpgrade = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const preparedBeforeUpgrade = prExecutionBinding(beforeUpgrade);
  const legacy = fixture.store.stored();
  const legacyRoot = legacy.items.find(({ kind }) => kind === "source_root");
  for (const revision of legacyRoot.source.revisions) {
    delete revision.causalHeadRefOid;
    delete revision.authorityEpochChanged;
    delete revision.authorityEpochCutover;
  }
  fixture.store.replaceStored(legacy);

  const recovered = await createFixture({ records, store: fixture.store });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 4],
  );
  assert.equal(
    currentRoot.source.revisions.at(-1).authorityEpochCutover,
    true,
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(preparedBeforeUpgrade),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = prExecutionBinding(currentRoot);
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a new provenance with an unproven Head fences the whole PR", async () => {
  const fixture = await createFixture({
    records: [
      prAssignment(1, {
        occurredAt: "2026-08-02T01:00:00.000Z",
        headRefOid: PR_HEAD_A,
      }),
      prAssignment(2, {
        occurredAt: "2026-08-02T01:05:00.000Z",
        headRefOid: PR_HEAD_B,
        changedFields: ["headRefOid"],
        sourceScopeId: "unproven-scope",
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  const roots = (await fixture.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root");

  assert.equal(roots.length, 2);
  for (const root of roots) {
    await assert.rejects(
      fixture.service.verifyPullRequestExecutionBinding(
        prExecutionBinding(root),
      ),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
});

test("a future-dated unproven provenance cannot permanently block recovery", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const unprovenFuture = prAssignment(2, {
    occurredAt: "2026-08-02T01:50:00.000Z",
    headRefOid: PR_HEAD_B,
    changedFields: ["headRefOid"],
    sourceScopeId: "future-unproven-scope",
    gitFacts: prGitFacts(PR_HEAD_B),
  });
  fixture.source.records.push(unprovenFuture);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const recoveredObservation = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    headRefOid: PR_HEAD_A,
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(recoveredObservation);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });
  const recovered = await createFixture({
    records: [initial, unprovenFuture, recoveredObservation],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(
      ({ kind, source }) =>
        kind === "source_root" &&
        source.identity.scopeId === "github-dashboard",
    );
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2],
  );
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("future unavailable facts fence locally and exact normal-time recovery survives restart", async () => {
  const initial = prAssignment(1, {
    occurredAt: "2026-08-02T01:00:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const fixture = await createFixture({ records: [initial] });
  await fixture.service.intake({ limit: 10 });
  const initialRoot = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const oldBinding = prExecutionBinding(initialRoot);
  const unavailableFuture = prAssignment(2, {
    occurredAt: "2099-01-01T00:00:00.000Z",
    gitFacts: { gitTargetAvailable: false },
  });
  fixture.source.records.push(unavailableFuture);
  fixture.source.highWatermark = 2;
  await fixture.service.intake({ limit: 10 });
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const exactRecovery = prAssignment(3, {
    occurredAt: "2026-08-02T01:10:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  fixture.source.records.push(exactRecovery);
  fixture.source.highWatermark = 3;
  await fixture.service.intake({ limit: 10 });
  const recoveredBeforeRestart = (await fixture.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  assert.equal(recoveredBeforeRestart.status, "queued");
  const recovered = await createFixture({
    records: [initial, unavailableFuture, exactRecovery],
    store: fixture.store,
  });
  const currentRoot = (await recovered.service.listItems({ limit: 10 }))
    .items.find(({ kind }) => kind === "source_root");
  const currentBinding = prExecutionBinding(currentRoot);

  assert.deepEqual(
    currentRoot.source.revisions.map(({ disposition }) => disposition),
    ["accepted", "ignored_authority_fence", "accepted"],
  );
  assert.equal(currentRoot.status, "queued");
  assert.equal(currentRoot.source.headRevision, 2);
  await assert.rejects(
    recovered.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await recovered.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a trusted provenance recovers exactly after another source fences it", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, {
      occurredAt: "2099-01-01T00:00:00.000Z",
      sourceScopeId: "github-dashboard",
      gitFacts: prGitFacts(PR_HEAD_A),
    })],
  });
  await fixture.service.intake();
  let roots = (await fixture.service.listItems({ limit: 10 })).items;
  const initialRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const oldBinding = prExecutionBinding(initialRoot);
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    sourceScopeId: "github-secondary",
    gitFacts: { gitTargetAvailable: false },
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  fixture.source.records.push(prAssignment(3, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:10:00.000Z",
    sourceScopeId: "github-dashboard",
    gitFacts: prGitFacts(PR_HEAD_A),
  }));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();

  roots = (await fixture.service.listItems({ limit: 10 })).items;
  const recoveredRoot = roots.find(
    ({ source }) => source.identity.scopeId === "github-dashboard",
  );
  const currentBinding = prExecutionBinding(recoveredRoot);
  assert.equal(recoveredRoot.status, "queued");
  assert.deepEqual(
    recoveredRoot.source.revisions.map(({ disposition }) => disposition),
    ["accepted", "accepted"],
  );
  assert.equal(recoveredRoot.source.headRevision, 2);
  await assert.rejects(
    fixture.service.verifyPullRequestExecutionBinding(oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    await fixture.service.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
  assert.deepEqual(
    await restarted.verifyPullRequestExecutionBinding(currentBinding),
    currentBinding,
  );
});

test("a late old-Head event is audited without rolling the PR task back", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const headB = (await fixture.service.listItems()).items[0];
  fixture.source.records.push(
    prAssignment(3, {
      eventType: "pull_request.status",
      occurredAt: "2026-08-02T01:01:00.000Z",
      headRefOid: PR_HEAD_A,
      changedFields: ["ciStatus"],
      ciStatus: "FAILURE",
    }),
  );
  fixture.source.highWatermark = 3;

  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];

  assert.equal((await fixture.service.getSummary()).intakeCursor, 3);
  assert.equal(item.itemId, headB.itemId);
  assert.equal(item.source.inputRevision, 3);
  assert.equal(item.source.activeRevision, 2);
  assert.equal(item.source.headRevision, 2);
  assert.equal(item.source.current.headRefOid, PR_HEAD_B);
  assert.equal(item.source.revisions.at(-1).disposition, "ignored_stale");
});

test("a full limit-one v1 PR outbox gains one v2 baseline, restarts, and drains", async () => {
  const input = prAssignment(1, {
    gitFacts: prGitFacts(PR_HEAD_A),
    title: "Legacy v1 PR memory",
  });
  const fixture = await createFixture({ records: [input] });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  await fixture.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "legacy-v1",
          description: "Legacy v1 graph conclusion",
        }],
        expectedDeliverables: [],
      },
      reason: "legacy-v1-fixture",
      expectedGraphRevision: (await fixture.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const legacy = fixture.store.stored();
  root = legacy.items.find(({ kind }) => kind === "source_root");
  legacy.graphMemoryProjection = legacySingleEventProjection(
    legacy,
    root,
    "acceptance_contract",
    root.graph.acceptanceContracts.at(-1),
  );
  fixture.store.replaceStored(legacy);
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 1 });

  const recovered = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  const firstBatch = await recovered.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(firstBatch.highWatermark, 2);
  assert.deepEqual(
    firstBatch.items.map(({ schemaVersion, kind }) => ({ schemaVersion, kind })),
    [
      { schemaVersion: 1, kind: "acceptance_contract" },
      { schemaVersion: 2, kind: "authority_observed" },
    ],
  );
  const restartedBeforeDrain = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  assert.deepEqual(
    await restartedBeforeDrain.service.readGraphMemoryProjectionBatch({
      limit: 10,
    }),
    firstBatch,
  );

  const memory = await createLedgerMemoryPipeline(
    restartedBeforeDrain.service,
  );
  await memory.projector.runCycle();
  const v1RecordId = workGraphMemoryRecordReceipt(firstBatch.items[0])
    .memoryRecordId;
  assert.equal(
    memory.journal.readRecords({ recordIds: [v1RecordId] })
      .items[0].labels.lifecycle,
    "obsolete",
  );
  const afterDrain = await createFixture({
    records: [input],
    store: fixture.store,
    limits,
  });
  assert.deepEqual(
    await afterDrain.service.readGraphMemoryProjectionBatch({ limit: 10 }),
    {
      cursor: 2,
      highWatermark: 2,
      checkpointDigest: firstBatch.highWatermarkDigest,
      highWatermarkDigest: firstBatch.highWatermarkDigest,
      authorityStateDigest: firstBatch.authorityStateDigest,
      items: [],
    },
  );
  root = (await afterDrain.service.listItems()).items[0];
  await afterDrain.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 3,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      reason: "cap-restored-after-drain",
      expectedGraphRevision: (await afterDrain.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const ordinaryAfterDrain =
    await afterDrain.service.readGraphMemoryProjectionBatch({ limit: 10 });
  assert.equal(ordinaryAfterDrain.items.length, 1);
  assert.equal(ordinaryAfterDrain.items[0].kind, "acceptance_contract");
});

test("v1 non-PR graph memory drains without synthesizing a PR authority baseline", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  const item = legacy.items[0];
  legacy.graphMemoryProjection = legacySingleEventProjection(
    legacy,
    item,
    "acceptance_contract",
    item.graph.acceptanceContracts[0],
  );
  fixture.store.replaceStored(legacy);
  const recovered = await createFixture({
    records: [assignment(1)],
    store: fixture.store,
    limits: normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 1 }),
  });
  const batch = await recovered.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].schemaVersion, 1);
  assert.equal(batch.items.some(({ kind }) => kind === "authority_observed"), false);
});

test("recovery rejects deleting an authority invalidation tail with nextSequence rollback", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  const memory = await createLedgerMemoryPipeline(fixture.service);
  await memory.projector.runCycle();
  fixture.source.records.push(prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const tampered = fixture.store.stored();
  assert.equal(
    tampered.graphMemoryProjection.pending.at(-1).kind,
    "authority_invalidated",
  );
  tampered.graphMemoryProjection.pending.pop();
  tampered.graphMemoryProjection.nextSequence -= 1;
  fixture.store.replaceStored(tampered);

  await assert.rejects(
    createFixture({
      records: fixture.source.records,
      store: fixture.store,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema v8 safely consolidates queued PR assignments into one source root", async () => {
  const records = [
    prAssignment(1, { eventType: "pull_request.updated" }),
    prAssignment(2, { eventType: "pull_request.classified" }),
    prAssignment(3, { eventType: "pull_request.status" }),
  ];
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(
      record,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 3 });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 3,
    sourceHighWatermark: 3,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({
    records,
    store,
    limits,
  });

  const migrated = (await fixture.service.listItems({ limit: 10 })).items;
  const roots = migrated.filter(({ kind }) => kind === "source_root");
  const oldAssignments = migrated.filter(({ kind }) => kind === "assignment");

  assert.equal(store.writes.length, 0);
  assert.equal(store.stored().schemaVersion, 8);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status, "queued");
  assert.equal(roots[0].source.inputRevision, 3);
  assert.equal(roots[0].source.headRevision, 1);
  assert.equal(oldAssignments.length, 3);
  assert.equal(oldAssignments.every(({ status }) => status === "cancelled"), true);
  assert.equal(
    (await fixture.service.readGraphMemoryProjectionBatch({ limit: 10 }))
      .highWatermark,
    4,
  );

  await fixture.service.claim({
    itemId: roots[0].itemId,
    expectedRevision: roots[0].revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.equal(store.stored().graphMemoryProjection.nextSequence, 5);
  assert.equal(
    store.stored().graphMemoryProjection.pending.at(-1).kind,
    "authority_observed",
  );
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits,
  });
  await recovered.recover();
  assert.equal(
    (await recovered.readGraphMemoryProjectionBatch({ limit: 10 }))
      .highWatermark,
    4,
  );
});

test("full schema v8 outbox with multiple PR roots only overflows for one trusted baseline", async () => {
  const records = [
    prAssignment(1, {
      gitFacts: prGitFacts(PR_HEAD_A),
      title: "PR 42 migration",
    }),
    prAssignment(2, {
      pullRequestNumber: 43,
      sourceScopeId: "github-secondary",
      headRefOid: PR_HEAD_B,
      gitFacts: prGitFacts(PR_HEAD_B),
      title: "PR 43 migration",
    }),
  ];
  const items = records.map((entry) => {
    const item = createAssignmentWorkItem(
      entry,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const limits = normalizeWorkLedgerLimits({ graphMemoryOutboxLimit: 2 });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 2,
    sourceHighWatermark: 2,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(items, 1, limits),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const first = await createFixture({ records, store, limits });
  const firstBatch = await first.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal((await first.service.listItems({ limit: 10 })).items
    .filter(({ kind }) => kind === "source_root").length, 2);
  assert.equal(firstBatch.items.length, 3);
  assert.equal(firstBatch.items.at(-1).kind, "authority_observed");
  assert.equal(
    firstBatch.items.slice(0, 2).every(
      ({ kind }) => kind === "acceptance_contract",
    ),
    true,
  );

  const restarted = await createFixture({ records, store, limits });
  assert.deepEqual(
    await restarted.service.readGraphMemoryProjectionBatch({ limit: 10 }),
    firstBatch,
  );
  let root = (await restarted.service.listItems({ limit: 10 })).items.find(
    ({ kind }) => kind === "source_root",
  );
  const writesBeforeRejectedGraphAppend = store.writes.length;
  await assert.rejects(
    restarted.service.reviseGraphAcceptance({
      authority: {
        actorId: "employee-orchestrator",
        scopeRootTaskId: root.itemId,
      },
      command: {
        taskId: root.itemId,
        acceptanceContract: {
          revision: 2,
          acceptanceCriteria: [{
            criterionId: "migration-capacity",
            description: "Migration authority tail has drained",
          }],
          expectedDeliverables: [],
        },
        reason: "ordinary-append-before-migration-drain",
        expectedGraphRevision: (await restarted.service.getSummary()).revision,
        expectedTaskRevision: root.revision,
      },
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED",
  );
  assert.equal(store.writes.length, writesBeforeRejectedGraphAppend);

  const memory = await createLedgerMemoryPipeline(restarted.service);
  await memory.projector.runCycle();
  const afterDrain = await createFixture({ records, store, limits });
  root = (await afterDrain.service.listItems({ limit: 10 })).items.find(
    ({ kind }) => kind === "source_root",
  );
  await afterDrain.service.reviseGraphAcceptance({
    authority: {
      actorId: "employee-orchestrator",
      scopeRootTaskId: root.itemId,
    },
    command: {
      taskId: root.itemId,
      acceptanceContract: {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "migration-capacity",
          description: "Migration authority tail has drained",
        }],
        expectedDeliverables: [],
      },
      reason: "ordinary-append-after-migration-drain",
      expectedGraphRevision: (await afterDrain.service.getSummary()).revision,
      expectedTaskRevision: root.revision,
    },
  });
  const ordinary = await afterDrain.service.readGraphMemoryProjectionBatch({
    limit: 10,
  });
  assert.equal(ordinary.cursor, 3);
  assert.equal(ordinary.items.length, 1);
  assert.equal(ordinary.items[0].kind, "acceptance_contract");
});

test("schema v8 mixed-Head PR work is durably fenced from new actions", async () => {
  const records = [
    prAssignment(1, { headRefOid: PR_HEAD_A }),
    prAssignment(2, {
      occurredAt: "2026-08-02T01:05:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
    }),
  ];
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(
      record,
      "2026-08-02T02:00:00.000Z",
    );
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  Object.assign(items[0], {
    status: "working",
    ownerId: "legacy-pr-worker",
    leaseId: "legacy-pr-lease",
    leaseUntil: "2026-08-03T02:00:00.000Z",
    attempt: 1,
  });
  const legacyChild = createGraphChildWorkItem(
    {
      parentItemId: items[0].itemId,
      childKey: "legacy-conflict-fix",
      work: {
        title: "旧版冲突修复",
        description: "不得绕过 PR Head 切换继续执行。",
      },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: items[0].event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  delete legacyChild.source;
  delete legacyChild.sourceQuarantine;
  delete legacyChild.assignment.graphTask.sourceBinding;
  items.push(legacyChild);
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: 2,
    sourceHighWatermark: 2,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({ records, store, limits });
  const migrated = (await fixture.service.listItems({ limit: 10 })).items;
  const working = migrated.find(
    ({ assignmentId }) => assignmentId === items[0].assignmentId,
  );
  const root = migrated.find(({ kind }) => kind === "source_root");
  const child = migrated.find(({ itemId }) => itemId === legacyChild.itemId);

  assert.equal(store.writes.length, 0);
  assert.equal(root.status, "blocked");
  assert.equal(root.statusReason, "pr_source_legacy_cutover");
  assert.equal(working.status, "working");
  assert.equal(working.statusReason, "pr_source_legacy_cutover");
  assert.equal(child.status, "blocked");
  assert.equal(child.statusReason, "pr_source_legacy_cutover");
  await assert.rejects(
    fixture.service.claim({
      itemId: child.itemId,
      expectedRevision: child.revision,
      workerId: "legacy-developer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: working.leaseId,
      actorId: "legacy-pr-worker",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  assert.equal(store.writes.length, 0);

  fixture.source.records.push(assignment(3));
  fixture.source.highWatermark = 3;
  await fixture.service.intake();
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);

  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const persisted = (await recovered.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === working.itemId,
  );
  assert.equal(persisted.statusReason, "pr_source_legacy_cutover");
  await assert.rejects(
    recovered.stageIntent({
      itemId: persisted.itemId,
      expectedRevision: persisted.revision,
      leaseId: persisted.leaseId,
      actorId: "legacy-pr-worker",
      roleId: "pr-engineer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

test("schema v8 quarantine closes over cross-tree and transitive dependency consumers", async () => {
  const firstPr = prAssignment(1);
  const secondPr = prAssignment(2, {
    repository: "acme/other-repo",
    pullRequestNumber: 7,
    title: "PR 7",
  });
  const ordinaryRecord = prAssignment(3);
  ordinaryRecord.assignment = {
    ...ordinaryRecord.assignment,
    assignmentId: "workflow-assignment-ordinary-3",
    target: { type: "role", id: "developer" },
  };
  const firstPrItem = createAssignmentWorkItem(
    firstPr,
    "2026-08-02T02:00:00.000Z",
  );
  const secondPrItem = createAssignmentWorkItem(
    secondPr,
    "2026-08-02T02:00:00.000Z",
  );
  const ordinaryParent = createAssignmentWorkItem(
    ordinaryRecord,
    "2026-08-02T02:00:00.000Z",
  );
  for (const item of [firstPrItem, secondPrItem]) {
    Object.assign(item, {
      status: "completed",
      revision: 2,
      statusReason: "legacy_completed",
    });
  }
  const crossTreeWorker = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "cross-tree-worker",
      work: {
        title: "消费旧 PR 结果",
        description: "不得基于无法证明 Head 的旧 PR 结果继续执行。",
      },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [secondPrItem.itemId, firstPrItem.itemId].sort(),
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  Object.assign(crossTreeWorker, {
    status: "working",
    revision: 2,
    ownerId: "legacy-cross-tree-worker",
    leaseId: "legacy-cross-tree-lease",
    leaseUntil: "2026-08-03T02:00:00.000Z",
    attempt: 1,
  });
  const directConsumer = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "direct-consumer",
      work: { title: "直接消费者", description: "消费旧 PR 交付。" },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [secondPrItem.itemId],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  Object.assign(directConsumer, {
    status: "completed",
    revision: 2,
    statusReason: "legacy_completed",
  });
  const twoHopConsumer = createGraphChildWorkItem(
    {
      parentItemId: ordinaryParent.itemId,
      childKey: "two-hop-consumer",
      work: { title: "两跳消费者", description: "传递消费旧 PR 交付。" },
      target: { type: "role", id: "developer" },
      dependsOnItemIds: [directConsumer.itemId],
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
      },
      parentEvent: ordinaryParent.event,
      sourceBinding: null,
    },
    "2026-08-02T02:00:00.000Z",
  );
  const items = [
    secondPrItem,
    firstPrItem,
    ordinaryParent,
    crossTreeWorker,
    directConsumer,
    twoHopConsumer,
  ];
  for (const item of items) {
    delete item.source;
    delete item.sourceQuarantine;
    if (item.kind === "graph_task") {
      delete item.assignment.graphTask.sourceBinding;
    }
  }
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 2,
    intakeCursor: 3,
    sourceHighWatermark: 3,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      2,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const fixture = await createFixture({
    records: [firstPr, secondPr, ordinaryRecord],
    store,
    limits,
  });
  let migrated = (await fixture.service.listItems({ limit: 20 })).items;
  const roots = migrated
    .filter(({ kind }) => kind === "source_root")
    .sort((left, right) =>
      left.source.workKey === right.source.workKey
        ? left.itemId.localeCompare(right.itemId)
        : left.source.workKey.localeCompare(right.source.workKey)
    );
  const secondRoot = roots.find(
    ({ source }) => source.identity.repository === "acme/other-repo",
  );
  let migratedWorker = migrated.find(
    ({ itemId }) => itemId === crossTreeWorker.itemId,
  );
  let migratedDirect = migrated.find(
    ({ itemId }) => itemId === directConsumer.itemId,
  );
  let migratedTwoHop = migrated.find(
    ({ itemId }) => itemId === twoHopConsumer.itemId,
  );

  assert.equal(roots.length, 2);
  assert.equal(
    migratedWorker.sourceQuarantine.rootItemId,
    roots[0].itemId,
  );
  assert.equal(migratedDirect.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedTwoHop.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedWorker.status, "working");
  assert.equal(migratedTwoHop.status, "blocked");
  await assert.rejects(
    fixture.service.claim({
      itemId: migratedTwoHop.itemId,
      expectedRevision: migratedTwoHop.revision,
      workerId: "legacy-two-hop-worker",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: migratedWorker.itemId,
      expectedRevision: migratedWorker.revision,
      leaseId: migratedWorker.leaseId,
      actorId: migratedWorker.ownerId,
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );

  fixture.source.records.push(assignment(4));
  fixture.source.highWatermark = 4;
  await fixture.service.intake();
  assert.equal(store.stored().schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  const recovered = new WorkLedgerService({
    store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits,
  });
  await recovered.recover();
  migrated = (await recovered.listItems({ limit: 20 })).items;
  migratedWorker = migrated.find(({ itemId }) => itemId === crossTreeWorker.itemId);
  migratedDirect = migrated.find(({ itemId }) => itemId === directConsumer.itemId);
  migratedTwoHop = migrated.find(({ itemId }) => itemId === twoHopConsumer.itemId);
  assert.equal(migratedWorker.sourceQuarantine.rootItemId, roots[0].itemId);
  assert.equal(migratedDirect.sourceQuarantine.rootItemId, secondRoot.itemId);
  assert.equal(migratedTwoHop.sourceQuarantine.rootItemId, secondRoot.itemId);
  await assert.rejects(
    recovered.claim({
      itemId: migratedTwoHop.itemId,
      expectedRevision: migratedTwoHop.revision,
      workerId: "legacy-two-hop-worker",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
  await assert.rejects(
    recovered.stageIntent({
      itemId: migratedWorker.itemId,
      expectedRevision: migratedWorker.revision,
      leaseId: migratedWorker.leaseId,
      actorId: migratedWorker.ownerId,
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

for (const [legacyState, prepareOutbox] of [
  ["pending", () => {}],
  [
    "unsealed dispatching",
    (outbox) => {
      Object.assign(outbox, {
        status: "dispatching",
        revision: 2,
        attempt: 1,
        dispatcherId: "legacy-dispatcher",
        dispatchLeaseId: "legacy-dispatch-lease",
        dispatchLeaseUntil: "2026-08-02T03:00:00.000Z",
        dispatchBinding: null,
      });
    },
  ],
]) {
  test(`schema v8 ${legacyState} intent is failed while entering PR-source quarantine`, async () => {
    const record = prAssignment(1);
    const item = createAssignmentWorkItem(record, "2026-08-02T02:00:00.000Z");
    const outbox = createWorkIntentRecord(
      item,
      reviewIntent(),
      { roleId: "pr-engineer", workerId: "employee-pr-engineer" },
      "2026-08-02T02:00:00.000Z",
    );
    Object.assign(item, {
      status: "dispatch_pending",
      revision: 3,
      activeIntentId: outbox.intentId,
    });
    delete item.source;
    delete item.sourceQuarantine;
    prepareOutbox(outbox);
    delete outbox.sourceBinding;
    delete outbox.brainRecovery;
    const limits = normalizeWorkLedgerLimits();
    const legacy = {
      ...emptyWorkLedgerState(),
      schemaVersion: 8,
      revision: 3,
      intakeCursor: 1,
      sourceHighWatermark: 1,
      items: [item],
      outbox: [outbox],
      graphMemoryProjection: migrateWorkGraphMemoryProjection(
        [item],
        3,
        limits,
      ),
    };
    const fixture = await createFixture({
      records: [record],
      store: new MemoryStore({ [STATE_KEY]: legacy }),
    });

    let migratedItem = (await fixture.service.listItems()).items.find(
      ({ assignmentId }) => assignmentId === item.assignmentId,
    );
    let migratedOutbox = (await fixture.service.listOutbox()).items[0];
    assert.equal(migratedItem.status, "blocked");
    assert.equal(migratedItem.activeIntentId, null);
    assert.equal(migratedItem.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
    assert.equal(
      migratedItem.sourceQuarantine.reason,
      LEGACY_PR_SOURCE_CUTOVER_REASON,
    );
    assert.equal(migratedOutbox.status, "failed");
    assert.equal(migratedOutbox.dispatcherId, null);
    assert.equal(migratedOutbox.dispatchLeaseId, null);
    assert.equal(migratedOutbox.dispatchLeaseUntil, null);
    assert.deepEqual(migratedOutbox.outcome, {
      status: "failed",
      details: { reason: "pr_source_legacy_cutover_before_dispatch" },
    });

    fixture.source.records.push(assignment(2));
    fixture.source.highWatermark = 2;
    await fixture.service.intake();
    assert.equal(
      fixture.store.stored().schemaVersion,
      WORK_LEDGER_STATE_SCHEMA_VERSION,
    );
    const recovered = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await recovered.recover();
    migratedItem = (await recovered.listItems()).items.find(
      ({ assignmentId }) => assignmentId === item.assignmentId,
    );
    migratedOutbox = (await recovered.listOutbox()).items.find(
      ({ intentId }) => intentId === outbox.intentId,
    );
    assert.equal(migratedItem.status, "blocked");
    assert.equal(migratedItem.activeIntentId, null);
    assert.equal(
      migratedItem.sourceQuarantine.reason,
      LEGACY_PR_SOURCE_CUTOVER_REASON,
    );
    assert.equal(migratedOutbox.status, "failed");
    assert.equal(
      migratedOutbox.outcome.details.reason,
      "pr_source_legacy_cutover_before_dispatch",
    );
  });
}

test("schema v8 sealed intent settlement cannot release its PR source quarantine", async () => {
  const record = prAssignment(1);
  const item = createAssignmentWorkItem(record, "2026-08-02T02:00:00.000Z");
  const outbox = createWorkIntentRecord(
    item,
    reviewIntent(),
    { roleId: "pr-engineer", workerId: "employee-pr-engineer" },
    "2026-08-02T02:00:00.000Z",
  );
  const dispatchBinding = createWorkIntentDispatchBinding(
    boundReviewIntent(item, {
      requestedBy: {
        roleId: "pr-engineer",
        workItemId: item.itemId,
      },
      binding: { repository: "acme/repo", pullRequestNumber: 42 },
    }),
  );
  Object.assign(item, {
    status: "dispatch_pending",
    revision: 3,
    activeIntentId: outbox.intentId,
  });
  delete item.source;
  delete item.sourceQuarantine;
  Object.assign(outbox, {
    status: "dispatching",
    revision: 3,
    attempt: 1,
    dispatcherId: "legacy-dispatcher",
    dispatchLeaseId: "legacy-dispatch-lease",
    dispatchLeaseUntil: "2026-08-02T02:00:00.000Z",
    dispatchBinding,
  });
  delete outbox.sourceBinding;
  delete outbox.brainRecovery;
  const limits = normalizeWorkLedgerLimits();
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 3,
    intakeCursor: 1,
    sourceHighWatermark: 1,
    items: [item],
    outbox: [outbox],
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      [item],
      3,
      limits,
    ),
  };
  const fixture = await createFixture({
    records: [record],
    store: new MemoryStore({ [STATE_KEY]: legacy }),
  });
  let quarantined = (await fixture.service.listItems()).items.find(
    ({ assignmentId }) => assignmentId === item.assignmentId,
  );
  assert.equal(quarantined.sourceQuarantine.reason, LEGACY_PR_SOURCE_CUTOVER_REASON);

  const reclaimed = await fixture.service.claimIntent({
    intentId: outbox.intentId,
    expectedRevision: outbox.revision,
    dispatcherId: "legacy-settlement-dispatcher",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(reclaimed.dispatchBinding, dispatchBinding);
  await fixture.service.ackIntent({
    intentId: outbox.intentId,
    expectedRevision: reclaimed.revision,
    itemExpectedRevision: quarantined.revision,
    dispatchLeaseId: reclaimed.dispatchLeaseId,
    actorId: reclaimed.dispatcherId,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T04:00:00.000Z",
    details: { code: "legacy_downstream_timeout" },
  });
  quarantined = (await fixture.service.listItems()).items.find(
    ({ assignmentId }) => assignmentId === item.assignmentId,
  );
  assert.equal(quarantined.status, "blocked");
  assert.equal(quarantined.activeIntentId, null);
  assert.equal(quarantined.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(quarantined.sourceQuarantine.reason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  await assert.rejects(
    fixture.service.claim({
      itemId: quarantined.itemId,
      expectedRevision: quarantined.revision,
      workerId: "employee-pr-engineer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
  );
});

test("schema v8 PR history uses independent source-root byte budgets", async () => {
  const migrationCapacity = normalizeWorkLedgerLimits({
    sourceRootByteBudget: 16 * 1024 * 1024,
    sourceStateByteBudget: 96 * 1024 * 1024,
  });
  assert.equal(migrationCapacity.sourceRootByteBudget, 16 * 1024 * 1024);
  assert.equal(migrationCapacity.sourceStateByteBudget, 96 * 1024 * 1024);
  const records = Array.from({ length: 12 }, (_, index) =>
    prAssignment(index + 1, {
      eventType: index === 0
        ? "pull_request.updated"
        : "pull_request.status",
      occurredAt: `2026-08-02T01:${String(index).padStart(2, "0")}:00.000Z`,
      ciStatus: index % 2 === 0 ? "PENDING" : "FAILURE",
    })
  );
  const items = records.map((record) => {
    const item = createAssignmentWorkItem(record, record.event.occurredAt);
    delete item.source;
    delete item.sourceQuarantine;
    return item;
  });
  const root = createPullRequestSourceRootWorkItem(
    records[0],
    records[0].event.occurredAt,
  );
  for (const record of records.slice(1)) {
    const appended = appendPullRequestWorkSource(root.source, record, { attemptAtActivation: root.attempt });
    root.source = appended.source;
    root.inputDigest = appended.source.current.inputDigest;
    root.updatedAt = record.event.occurredAt;
  }
  const capacityBytes = (item) => {
    const view = structuredClone(item);
    delete view.graph;
    if (view.source === null) delete view.source;
    if (view.sourceQuarantine === null) delete view.sourceQuarantine;
    return Buffer.byteLength(`${JSON.stringify(view, null, 2)}\n`, "utf8");
  };
  const operationalItemByteBudget = Math.max(
    ...items.map((item) => capacityBytes({
      ...item,
      status: "cancelled",
      statusReason: "consolidated_pr_source_root",
    })),
  );
  const sourceRootByteBudget = capacityBytes(root);
  assert.ok(sourceRootByteBudget > operationalItemByteBudget);
  const limits = normalizeWorkLedgerLimits({
    itemByteBudget: operationalItemByteBudget,
    sourceRootByteBudget,
  });
  const legacy = {
    ...emptyWorkLedgerState(),
    schemaVersion: 8,
    revision: 1,
    intakeCursor: records.length,
    sourceHighWatermark: records.length,
    items,
    graphMemoryProjection: migrateWorkGraphMemoryProjection(
      items,
      1,
      limits,
    ),
  };
  const store = new MemoryStore({ [STATE_KEY]: legacy });
  const recovered = await createFixture({ records, store, limits });

  const migratedRoot = (await recovered.service.listItems({ limit: 20 }))
    .items.find(({ kind }) => kind === "source_root");
  assert.equal(migratedRoot.source.inputRevision, records.length);
  assert.ok(capacityBytes(migratedRoot) > limits.itemByteBudget);

  const undersizedStore = new MemoryStore({ [STATE_KEY]: legacy });
  const undersized = new WorkLedgerService({
    store: undersizedStore,
    assignmentSource: recovered.source,
    exclusiveLease: new ExclusiveLease(),
    clock: recovered.time.clock,
    idFactory: incrementingIds(),
    limits: {
      itemByteBudget: operationalItemByteBudget,
      sourceRootByteBudget: sourceRootByteBudget - 1,
    },
  });
  await assert.rejects(
    undersized.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersizedStore.stored(), legacy);
  assert.equal(undersizedStore.writes.length, 0);
});

test("recovery rejects tampering with the append-only PR source history", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  await fixture.service.intake();
  const tampered = fixture.store.stored();
  tampered.items[0].source.revisions[0].headRevision = 2;
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("PR decision timeline recovery rejects a rehashed foreign execution binding", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: askUserIntent(),
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(({ type }) => type === "intent_staged");
  assert.deepEqual(timeline.details.inputBinding, prExecutionBinding(item));
  assert.equal(timeline.details.workItemRevision, item.revision + 1);
  timeline.details.inputBinding.repository = "foreign/repo";
  timeline.details.inputBinding.gitTarget.baseRepository = "foreign/repo";
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  const contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${contentDigest}`;
  timeline.contentDigest = contentDigest;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("PR timeline recovery rejects rebinding an old decision to the current Head", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: askUserIntent(),
  });
  fixture.source.records.push(
    prAssignment(2, {
      occurredAt: "2026-08-02T02:00:00.000Z",
      headRefOid: PR_HEAD_B,
      previousHeadRefOid: PR_HEAD_A,
      changedFields: ["headRefOid"],
      gitFacts: prGitFacts(PR_HEAD_B),
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const current = (await fixture.service.listItems()).items[0];
  const currentBinding = prExecutionBinding(current);
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(({ type }) => type === "intent_staged");
  timeline.details.inputBinding = structuredClone(currentBinding);
  timeline.details.inputDigest = currentBinding.inputDigest;
  timeline.details.workItemRevision = current.revision;
  timeline.at = current.updatedAt;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  const contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${contentDigest}`;
  timeline.contentDigest = contentDigest;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a failed intake write advances neither the durable cursor nor live items", async () => {
  const { service, source, store } = await createFixture({
    records: [assignment(1)],
  });
  store.failNextWrite();

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await service.getSummary()).intakeCursor, 0);
  assert.deepEqual((await service.listItems()).items, []);
  assert.equal(store.stored(), undefined);

  const retried = await service.intake();
  assert.equal(retried.cursor, 1);
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
  assert.equal(store.stored().items.length, 1);
});

test("invalid intake transitions retain the batch and durable diagnostic while existing work can proceed", async () => {
  const local = createLocalWorkLedgerCandidateProcessor();
  let rejectIntake = false;
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
    candidateProcessor: {
      commit: () => local.commit(),
      discard: () => local.discard(),
      async prepare(input) {
        if (rejectIntake && input.candidate.intakeCursor > input.previousState.intakeCursor) {
          const candidate = clone(input.candidate);
          const terminal = candidate.items.find(({ status }) => status === "completed");
          terminal.status = "queued";
          terminal.revision += 1;
          return local.prepare({ ...input, candidate });
        }
        return local.prepare(input);
      },
    },
  });
  await fixture.service.intake();
  let terminal = (await fixture.service.listItems()).items[0];
  terminal = await fixture.service.claim({
    itemId: terminal.itemId, expectedRevision: terminal.revision,
    workerId: "test-worker", leaseDurationMs: 30_000,
  });
  await fixture.service.complete({
    itemId: terminal.itemId, expectedRevision: terminal.revision,
    leaseId: terminal.leaseId, actorId: "test-worker", result: { outcome: "done" },
  });
  fixture.source.records.push(assignment(3));
  fixture.source.highWatermark = 3;
  rejectIntake = true;
  const result = await fixture.service.intake();
  assert.equal(result.error.code, "WORK_LEDGER_GRAPH_TRANSITION_INVALID");
  assert.equal(result.cursor, 2);
  assert.equal(result.received, 0);
  const after = fixture.store.stored();
  assert.equal(after.intakeCursor, 2);
  assert.equal(after.items.length, 2);
  assert.equal(after.items[0].status, "completed");
  const diagnostic = after.timeline.at(-1);
  assert.equal(diagnostic.type, "intake_rejected");
  assert.equal(diagnostic.details.afterSequence, 2);
  assert.equal(diagnostic.details.nextSequence, 3);
  assert.equal(diagnostic.details.batchDigest.length, 64);
  await fixture.service.intake();
  assert.equal(fixture.store.stored().revision, after.revision, "unchanged rejection does not generate noise");
  const available = (await fixture.service.listItems()).items[1];
  const claimed = await fixture.service.claim({
    itemId: available.itemId, expectedRevision: available.revision,
    workerId: "test-worker", leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");
  rejectIntake = false;
  assert.equal((await fixture.service.intake()).cursor, 3);
  assert.equal(fixture.store.stored().items.length, 3);
});

test("candidate processing commits only after durable write and discards failed writes", async () => {
  const events = [];
  const local = createLocalWorkLedgerCandidateProcessor();
  const candidateProcessor = {
    async prepare(request) {
      events.push("prepare");
      return local.prepare(request);
    },
    async commit() {
      events.push("commit");
      return local.commit();
    },
    async discard() {
      events.push("discard");
      return local.discard();
    },
  };
  const store = new MemoryStore();
  const durableWrite = store.write.bind(store);
  store.write = async (...arguments_) => {
    events.push("write");
    return durableWrite(...arguments_);
  };
  const { service } = await createFixture({
    records: [assignment(1)],
    store,
    candidateProcessor,
  });
  store.failNextWrite();

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  await service.intake();

  assert.deepEqual(events, [
    "prepare",
    "write",
    "discard",
    "prepare",
    "write",
    "commit",
  ]);
});

test("malformed worker success cannot reach the durable store", async (t) => {
  class MalformedCandidateWorker extends EventEmitter {
    constructor() {
      super();
      this.terminationCount = 0;
    }

    postMessage(message) {
      queueMicrotask(() => {
        this.emit("message", { requestId: message.requestId, ok: true });
      });
    }

    ref() {}

    unref() {}

    async terminate() {
      this.terminationCount += 1;
      return 1;
    }
  }

  const worker = new MalformedCandidateWorker();
  const candidateProcessor = createWorkerWorkLedgerCandidateProcessor({
    workerFactory: () => worker,
  });
  t.after(() => candidateProcessor.close());
  const store = new MemoryStore();
  const { service } = await createFixture({
    records: [assignment(1)],
    store,
    candidateProcessor,
  });

  await assert.rejects(
    service.intake(),
    (error) =>
      error.code === "WORK_LEDGER_STATE_CORRUPTED" &&
      error.statusCode === 503,
  );

  assert.equal(worker.terminationCount, 1);
  assert.equal(store.writes.length, 0);
  assert.equal(store.stored(), undefined);
});

test("a source retention gap creates a durable blocked system alert without skipping", async () => {
  const source = new FakeAssignmentSource([assignment(5), assignment(6)]);
  source.oldestAvailableSequence = 5;
  const { service } = await createFixture({ source });

  const first = await service.intake();
  const repeated = await service.intake();
  const items = (await service.listItems({ limit: 10 })).items;
  const timeline = (await service.listTimeline({ limit: 20 })).items;

  assert.deepEqual(first.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 6,
    reason: "source_retention",
  });
  assert.equal(first.cursor, 0);
  assert.equal(repeated.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
  assert.equal(items[0].currentTarget.type, "node");
  assert.equal(items[0].currentTarget.id, "work-ledger-system");
  assert.equal(
    timeline.filter(({ type }) => type === "intake_gap").length,
    2,
  );
  assert.deepEqual(source.calls.map(({ afterSequence }) => afterSequence), [0, 0]);
});

test("an internal source sequence gap is blocked as a system alert before partial intake", async () => {
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [assignment(1), assignment(3)],
    nextSequence: 3,
    highWatermark: 3,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  const result = await service.intake();
  const items = (await service.listItems()).items;

  assert.deepEqual(result.gap, {
    expectedSequence: 2,
    actualSequence: 3,
    highWatermark: 3,
    reason: "source_sequence",
  });
  assert.equal(result.cursor, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "system_alert");
  assert.equal(items[0].status, "blocked");
});

test("configuration-first admission neither intakes nor claims work", async (t) => {
  await t.test("intake", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.intake(),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fixture.source.calls.length, 0);
    assert.equal(fixture.store.writes.length, 0);
    assert.deepEqual((await fixture.service.listItems()).items, []);
  });

  await t.test("claim", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await createFixture({
      records: [assignment(1)],
      actionAdmissionGate: gate,
    });
    await fixture.service.intake();
    const queued = (await fixture.service.listItems()).items[0];
    await activateNextConfiguration(gate);

    await assert.rejects(
      fixture.service.claim({
        itemId: queued.itemId,
        expectedRevision: queued.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    const unchanged = (await fixture.service.listItems()).items[0];
    assert.equal(unchanged.status, "queued");
    assert.equal(unchanged.revision, queued.revision);
    assert.equal(fixture.store.writes.length, 1);
  });
});

test("intake-first admission releases cutover before its source settles", async () => {
  const gate = readyActionAdmissionGate();
  const sourceEntered = deferred();
  const releaseSource = deferred();
  const source = new FakeAssignmentSource([assignment(1)]);
  source.override = async ({ afterSequence, limit }) => {
    sourceEntered.resolve();
    await releaseSource.promise;
    return {
      items: source.records
        .filter(({ sequence }) => sequence > afterSequence)
        .slice(0, limit),
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    };
  };
  const fixture = await createFixture({
    source,
    actionAdmissionGate: gate,
  });

  const intake = fixture.service.intake();
  await sourceEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseSource.resolve();
  assert.equal((await intake).received, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("claim-first admission releases cutover before its durable write settles", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const writeEntered = deferred();
  const releaseWrite = deferred();
  const write = fixture.store.write.bind(fixture.store);
  let deferNextWrite = true;
  fixture.store.write = async (...args) => {
    if (deferNextWrite) {
      deferNextWrite = false;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return write(...args);
  };

  const claim = fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await writeEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseWrite.resolve();
  const claimed = await claim;
  assert.equal(claimed.status, "working");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("trusted reconciliation rereads one durable item without new intake", async () => {
  const gate = readyActionAdmissionGate();
  const fixture = await createFixture({
    records: [assignment(1)],
    actionAdmissionGate: gate,
  });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const concurrent = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await concurrent.recover();
  const claimed = await concurrent.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await activateNextConfiguration(gate);
  const sourceCalls = fixture.source.calls.length;

  const reconciled = await fixture.service.readItemForReconciliation({
    itemId: queued.itemId,
  });

  assert.equal(reconciled.status, "working");
  assert.equal(reconciled.revision, claimed.revision);
  assert.equal(reconciled.leaseId, claimed.leaseId);
  assert.equal(fixture.source.calls.length, sourceCalls);
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(
    fixture.service.readItemForReconciliation({ itemId: queued.itemId, extra: true }),
    (error) => error?.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("claim records a bounded lease, revision, and immutable input digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];

  const claimed = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "working");
  assert.equal(claimed.revision, queued.revision + 1);
  assert.equal(claimed.leaseId, "lease-0001");
  assert.equal(claimed.leaseUntil, "2026-08-02T02:00:30.000Z");
  assert.equal(claimed.ownerId, "employee-pr-reviewer");
  assert.equal(claimed.inputDigest, queued.inputDigest);
  assert.equal(claimed.attempt, 1);

  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: queued.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.claim({
      itemId: queued.itemId,
      expectedRevision: claimed.revision,
      workerId: "employee-other",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_ACTIVE",
  );
});

test("graph dependencies and child ownership block work before a lease is issued", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [consumer, prerequisite] = durable.items;
  consumer.graph.dependsOnItemIds = [prerequisite.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.claim({
      itemId: consumer.itemId,
      expectedRevision: consumer.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let gate = await recovered.claim({
    itemId: prerequisite.itemId,
    expectedRevision: prerequisite.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  gate = await recovered.complete({
    itemId: gate.itemId,
    expectedRevision: gate.revision,
    leaseId: gate.leaseId,
    actorId: "employee-pr-reviewer",
    result: { outcome: "prerequisite-complete" },
  });
  assert.equal(gate.status, "completed");
  const readyConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const claimed = await recovered.claim({
    itemId: readyConsumer.itemId,
    expectedRevision: readyConsumer.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.equal(claimed.status, "working");

  const parentFixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await parentFixture.service.intake();
  const parentState = parentFixture.store.stored();
  const [parent, child] = parentState.items;
  child.graph.parentItemId = parent.itemId;
  parentFixture.store.replaceStored(parentState);
  const parentService = new WorkLedgerService({
    store: parentFixture.store,
    assignmentSource: parentFixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: parentFixture.time.clock,
    idFactory: incrementingIds(),
  });
  await parentService.recover();
  await assert.rejects(
    parentService.claim({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("a cancelled child settles parent claiming and completion", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, cancelledChild] = durable.items;
  cancelledChild.graph.parentItemId = parent.itemId;
  cancelledChild.status = "cancelled";
  cancelledChild.statusReason = "replaced-by-corrected-work";
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  const claimed = await recovered.claim({
    itemId: parent.itemId,
    expectedRevision: parent.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const completed = await recovered.complete({
    itemId: claimed.itemId,
    expectedRevision: claimed.revision,
    leaseId: claimed.leaseId,
    actorId: "employee-orchestrator",
    result: { outcome: "cancelled-child-settled" },
  });

  assert.equal(completed.status, "completed");
});

test("a cancelled dependency remains unsatisfied for real ledger claims", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [consumer, cancelledDependency] = durable.items;
  consumer.graph.dependsOnItemIds = [cancelledDependency.itemId];
  cancelledDependency.status = "cancelled";
  cancelledDependency.statusReason = "dependency-was-cancelled";
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.claim({
      itemId: consumer.itemId,
      expectedRevision: consumer.revision,
      workerId: "employee-orchestrator",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
});

test("completion reports an ordinary graph conflict before corrupt-state handling", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-orchestrator",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.complete({
      itemId: parent.itemId,
      expectedRevision: parent.revision,
      leaseId: parent.leaseId,
      actorId: "employee-orchestrator",
      result: { outcome: "premature" },
    }),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_BLOCKED" && error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation atomically closes a safe subtree and blocks its dependents", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child, dependent] = durable.items;
  child.graph.parentItemId = root.itemId;
  dependent.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "owner-cancelled-scope",
  };

  const result = await recovered.cancelGraphTask(request);

  assert.equal(result.root.status, "cancelled");
  assert.deepEqual(result.cancelledItemIds, [child.itemId, root.itemId].sort());
  const byId = new Map(
    (await recovered.listItems({ limit: 10 })).items.map((item) => [
      item.itemId,
      item,
    ]),
  );
  assert.equal(byId.get(root.itemId).status, "cancelled");
  assert.equal(byId.get(child.itemId).status, "cancelled");
  assert.equal(byId.get(dependent.itemId).status, "queued");
  const writesAfterCancellation = fixture.store.writes.length;
  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  const cancelledRoot = byId.get(root.itemId);
  const replay = await recovered.cancelGraphTask({
    ...request,
    expectedGraphRevision: fixture.store.stored().revision,
    expectedRevision: cancelledRoot.revision,
  });
  assert.equal(replay.root.status, "cancelled");
  assert.deepEqual(replay.cancelledItemIds, []);
  assert.equal(fixture.store.writes.length, writesAfterCancellation);
  await assert.rejects(
    recovered.claim({
      itemId: dependent.itemId,
      expectedRevision: dependent.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_BLOCKED",
  );
  const cancelledEvents = (await recovered.listTimeline({ limit: 20 })).items
    .filter(({ type }) => type === "cancelled");
  assert.equal(cancelledEvents.length, 2);

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
  assert.equal(
    (await restarted.listItems({ status: "cancelled" })).items.length,
    2,
  );
});

test("graph cancellation refuses an active descendant and invokes no DTO accessors", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [root, child] = durable.items;
  child.graph.parentItemId = root.itemId;
  Object.assign(child, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "child-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  const request = {
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: root.revision,
    actorId: "employee-orchestrator",
    reason: "cancel-tree",
  };

  await assert.rejects(
    recovered.cancelGraphTask(request),
    (error) =>
      error.code === "WORK_LEDGER_CANCELLATION_UNSAFE" &&
      error.statusCode === 409,
  );
  assert.equal(fixture.store.stored().revision, durable.revision);

  let invoked = false;
  const hostile = { ...request };
  Object.defineProperty(hostile, "reason", {
    enumerable: true,
    get() {
      invoked = true;
      return "hidden";
    },
  });
  await assert.rejects(
    recovered.cancelGraphTask(hostile),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_INVALID",
  );
  assert.equal(invoked, false);
});

test("graph cancellation refuses an already active reverse dependency consumer", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [dependency, consumer] = durable.items;
  consumer.graph.dependsOnItemIds = [dependency.itemId];
  Object.assign(consumer, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "consumer-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: dependency.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: dependency.revision,
      actorId: "employee-orchestrator",
      reason: "dependency-invalidated",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("graph cancellation refuses an active ancestor", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const durable = fixture.store.stored();
  const [parent, child] = durable.items;
  child.graph.parentItemId = parent.itemId;
  Object.assign(parent, {
    status: "working",
    ownerId: "employee-planner",
    leaseId: "parent-lease",
    leaseUntil: "2026-08-02T03:00:00.000Z",
    attempt: 1,
  });
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  await assert.rejects(
    recovered.cancelGraphTask({
      itemId: child.itemId,
      expectedGraphRevision: durable.revision,
      expectedRevision: child.revision,
      actorId: "employee-orchestrator",
      reason: "child-no-longer-needed",
    }),
    (error) => error.code === "WORK_LEDGER_CANCELLATION_UNSAFE",
  );
  assert.equal(fixture.store.stored().revision, durable.revision);
});

test("completed descendants do not create false active-dependent cancellation conflicts", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();
  let durable = fixture.store.stored();
  const [root, child, consumer] = durable.items;
  child.graph.parentItemId = root.itemId;
  consumer.graph.dependsOnItemIds = [child.itemId];
  fixture.store.replaceStored(durable);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  let completedChild = await recovered.claim({
    itemId: child.itemId,
    expectedRevision: child.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  completedChild = await recovered.complete({
    itemId: child.itemId,
    expectedRevision: completedChild.revision,
    leaseId: completedChild.leaseId,
    actorId: "employee-developer",
    result: { outcome: "child-complete" },
  });
  const currentConsumer = (await recovered.listItems()).items.find(
    ({ itemId }) => itemId === consumer.itemId,
  );
  const workingConsumer = await recovered.claim({
    itemId: consumer.itemId,
    expectedRevision: currentConsumer.revision,
    workerId: "employee-consumer",
    leaseDurationMs: 30_000,
  });
  assert.equal(workingConsumer.status, "working");

  durable = fixture.store.stored();
  const currentRoot = durable.items.find(({ itemId }) => itemId === root.itemId);
  const result = await recovered.cancelGraphTask({
    itemId: root.itemId,
    expectedGraphRevision: durable.revision,
    expectedRevision: currentRoot.revision,
    actorId: "employee-orchestrator",
    reason: "remaining-root-work-cancelled",
  });

  assert.deepEqual(result.cancelledItemIds, [root.itemId]);
  assert.equal(result.root.status, "cancelled");
  assert.equal(
    (await recovered.listItems()).items.find(
      ({ itemId }) => itemId === child.itemId,
    ).status,
    "completed",
  );
});

test("an expired working lease is recoverable and every claim is auditable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const first = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-first",
    leaseDurationMs: 1_000,
  });
  fixture.time.advance(1_000);

  const recovered = await fixture.service.claim({
    itemId: first.itemId,
    expectedRevision: first.revision,
    workerId: "employee-recovery",
    leaseDurationMs: 2_000,
  });
  const types = (await fixture.service.listTimeline({ limit: 20 })).items.map(
    ({ type }) => type,
  );

  assert.equal(recovered.leaseId, "lease-0002");
  assert.equal(recovered.ownerId, "employee-recovery");
  assert.equal(recovered.attempt, 2);
  assert.deepEqual(
    types.filter((type) => ["lease_expired", "claimed"].includes(type)),
    ["claimed", "lease_expired", "claimed"],
  );
});

test("every working command rejects the old worker exactly at lease expiry without writing", async (t) => {
  const cases = [
    {
      name: "transition",
      invoke: (service, item) => service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-old",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
    },
    {
      name: "scheduleRetry",
      invoke: (service, item) => service.scheduleRetry({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        availableAt: "2026-08-02T02:02:00.000Z",
        reason: "temporary-failure",
      }),
    },
    {
      name: "handoff",
      invoke: (service, item) => service.handoff({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        target: { type: "role", id: "tester" },
        reason: "ready-for-testing",
      }),
    },
    {
      name: "complete",
      invoke: (service, item) => service.complete({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        result: { outcome: "done" },
      }),
    },
    {
      name: "stageIntent",
      invoke: (service, item) => service.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: "employee-old",
        roleId: "pr-reviewer",
        intent: reviewIntent(),
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      await fixture.service.intake();
      let item = (await fixture.service.listItems()).items[0];
      item = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-old",
        leaseDurationMs: 1_000,
      });
      fixture.time.advance(1_000);
      const writesBefore = fixture.store.writes.length;

      await assert.rejects(
        entry.invoke(fixture.service, item),
        (error) =>
          error.code === "WORK_LEDGER_LEASE_EXPIRED" &&
          error.statusCode === 409,
      );

      assert.equal(fixture.store.writes.length, writesBefore);
      assert.equal((await fixture.service.listItems()).items[0].status, "working");
      const recovered = await fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-recovery",
        leaseDurationMs: 1_000,
      });
      assert.equal(recovered.ownerId, "employee-recovery");
      assert.equal(recovered.attempt, 2);
    });
  }
});

test("assignment input rejects accessors without invoking them", async () => {
  let invoked = false;
  const unsafeAssignment = assignment(1);
  Object.defineProperty(unsafeAssignment.event.payload, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("must not run");
    },
  });
  const source = new FakeAssignmentSource();
  source.override = ({ afterSequence }) => ({
    items: [unsafeAssignment],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const { service } = await createFixture({ source });

  await assert.rejects(
    service.intake(),
    (error) => error.code === "WORK_LEDGER_SOURCE_INVALID",
  );
  assert.equal(invoked, false);
  assert.equal((await service.getSummary()).intakeCursor, 0);
});

test("transition requires the exact item revision and active work lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const queued = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: "wrong-lease",
      toStatus: "waiting_user",
      actorId: "employee-pr-reviewer",
      reason: "need-product-choice",
      details: { questionRef: "question-1" },
    }),
    (error) => error.code === "WORK_LEDGER_LEASE_CONFLICT",
  );

  const waiting = await fixture.service.transition({
    itemId: working.itemId,
    expectedRevision: working.revision,
    leaseId: working.leaseId,
    toStatus: "waiting_user",
    actorId: "employee-pr-reviewer",
    reason: "need-product-choice",
    details: { questionRef: "question-1" },
  });

  assert.equal(waiting.status, "waiting_user");
  assert.equal(waiting.ownerId, null);
  assert.equal(waiting.leaseId, null);
  assert.equal(waiting.leaseUntil, null);
  assert.equal(waiting.statusReason, "need-product-choice");
  assert.equal(waiting.revision, working.revision + 1);

  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: working.revision,
      toStatus: "queued",
      actorId: "owner",
      reason: "answered",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      toStatus: "dispatch_pending",
      actorId: "owner",
      reason: "bypass-outbox",
      details: {},
    }),
    (error) => error.code === "WORK_LEDGER_TRANSITION_INVALID",
  );
});

test("contention retry restores only an owned active claim attempt", async (t) => {
  for (const variant of ["refund", "default", "invalidBoolean", "wrongOwner", "wrongLease", "wrongRevision"]) {
    await t.test(variant, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      await fixture.service.intake();
      let item = (await fixture.service.listItems()).items[0];
      item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision, workerId: "employee-pr-reviewer", leaseDurationMs: 30_000 });
      const input = {
        itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
        actorId: "employee-pr-reviewer", availableAt: "2026-08-02T02:01:00.000Z",
        reason: "context_changed", consumeAttempt: false,
      };
      if (variant === "default") delete input.consumeAttempt;
      if (variant === "invalidBoolean") input.consumeAttempt = "false";
      if (variant === "wrongOwner") input.actorId = "other-worker";
      if (variant === "wrongLease") input.leaseId = "wrong-lease";
      if (variant === "wrongRevision") input.expectedRevision -= 1;
      if (!["refund", "default"].includes(variant)) {
        await assert.rejects(fixture.service.scheduleRetry(input));
        assert.equal((await fixture.service.listItems()).items[0].attempt, 1);
        return;
      }
      const retried = await fixture.service.scheduleRetry(input);
      assert.equal(retried.status, "retry_wait");
      assert.equal(retried.attempt, variant === "refund" ? 0 : 1);
      assert.equal(retried.leaseId, null);
    });
  }
});

test("retry, handoff, and completion are explicit durable timeline events", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.scheduleRetry({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    availableAt: "2026-08-02T02:01:00.000Z",
    reason: "ci-still-running",
    details: { code: "ROLE_CONTEXT_TIMEOUT" },
  });

  assert.equal(item.status, "retry_wait");
  assert.equal(item.availableAt, "2026-08-02T02:01:00.000Z");
  const retryEvent = (await fixture.service.listTimeline()).items.find(
    ({ type }) => type === "retry_scheduled",
  );
  assert.equal(retryEvent.details.code, "ROLE_CONTEXT_TIMEOUT");
  await assert.rejects(
    fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "WORK_LEDGER_NOT_AVAILABLE",
  );

  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.handoff({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    target: { type: "role", id: "requirements-analyst" },
    reason: "requirement-unclear",
  });

  assert.equal(item.status, "queued");
  assert.deepEqual(item.currentTarget, {
    type: "role",
    id: "requirements-analyst",
  });
  assert.equal(item.assignment.target.id, "pr-reviewer");

  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-requirements",
    leaseDurationMs: 30_000,
  });
  item = await fixture.service.complete({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-requirements",
    result: { outcome: "clarified", evidenceRefs: ["note-1"] },
  });

  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(item.status, "completed");
  assert.equal(item.leaseId, null);
  assert.equal(types.includes("retry_scheduled"), true);
  assert.equal(types.includes("handed_off"), true);
  assert.equal(types.includes("completed"), true);
});

function reviewIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_github_review",
    summary: "建议批准 PR",
    reason: "检查通过",
    verdict: "approve",
    body: "本地审查未发现阻塞问题。",
    evidence: ["tests:passed"],
    ...overrides,
  };
}

function externalPullRequestActionIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_github_pull_request_action",
    summary: "请求更新 PR 分支",
    reason: "当前 Head 已落后 base",
    action: { type: "update_branch" },
    evidence: ["merge-state:behind"],
    ...overrides,
  };
}

function boundReviewIntent(item, overrides = {}) {
  const content = {
    policyVersion: 4,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    },
    binding: {
      repository: "acme/repo",
      pullRequestNumber: 41,
    },
    payload: {
      verdict: "approve",
      body: "本地审查未发现阻塞问题。",
      evidence: ["tests:passed"],
    },
    ...overrides,
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

async function prepareClaimedReviewIntent(fixture, leaseDurationMs = 30_000) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { item, staged, claimed };
}

async function prepareClaimedPullRequestReviewIntent(
  fixture,
  leaseDurationMs = 30_000,
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: reviewIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { staged, claimed };
}

async function prepareClaimedPullRequestExternalActionIntent(
  fixture,
  leaseDurationMs = 30_000,
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-engineer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-engineer",
    roleId: "pr-engineer",
    intent: externalPullRequestActionIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs,
  });
  return { staged, claimed };
}

function pullRequestReviewProposalBinding(item) {
  const event = currentWorkItemEvent(item);
  return {
    eventId: event.eventId,
    subject: event.subject,
    repository: event.subject.repository,
    pullRequestNumber: event.subject.number,
    headRefOid: event.payload.headRefOid,
    inputBinding: prExecutionBinding(item),
  };
}

function boundPullRequestReviewIntent(item, binding) {
  const event = currentWorkItemEvent(item);
  return boundReviewIntent(item, {
    requestedBy: {
      roleId: "pr-engineer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: event.eventId,
    },
    binding,
    payload: {
      verdict: "approve",
      body: "本地审查未发现阻塞问题。",
      evidence: ["tests:passed"],
      summary: "建议批准 PR",
      reason: "检查通过",
    },
  });
}

function boundPullRequestExternalActionIntent(item, binding) {
  const event = currentWorkItemEvent(item);
  const content = {
    policyVersion: 4,
    kind: "github_pull_request_action_proposal",
    requestedBy: {
      roleId: "pr-engineer",
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: event.eventId,
    },
    binding,
    payload: {
      action: { type: "update_branch" },
      evidence: ["merge-state:behind"],
      summary: "请求更新 PR 分支",
      reason: "当前 Head 已落后 base",
    },
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

function codeActionIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "propose_code_action",
    summary: "修改受控代码",
    reason: "需要验证修复",
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["回归测试通过"],
    evidence: ["revision 未校验"],
    ...overrides,
  };
}

async function assertDispatchFailureWakesParent(fixture, parent) {
  const before = clone(fixture.store.stored());
  const page = await fixture.service.listClaimCandidates({ at: fixture.time.clock(), roleId: "orchestrator" });
  const fact = page.facts.find(entry => entry.itemId === parent.itemId);
  assert.equal(fact.graphBlocked, true);
  assert.equal(fact.orchestrationReady, true, "a retained dispatch rejection needs a fresh coordinating decision");
  const wakes = [], operations = [];
  const scheduler = new WorkContinuationScheduler({ store: new MemoryStore(), ledger: fixture.service,
    configurationReader: { readActive: async () => ({ configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }) },
    roleStateReader: { read: async () => ({ enabled: true, paused: false }) }, clock: fixture.time.clock });
  await scheduler.runCycle({ dispatch: async ({ roleId }) => { wakes.push(roleId); },
    runOperation: operation => { const pending = operation(); operations.push(pending); return pending; } });
  await Promise.all(operations);
  assert.deepEqual(wakes, ["orchestrator"], "the real ledger fact must wake the parent without a manual retry");
  assert.deepEqual(fixture.store.stored(), before, "notification never resumes or replays the rejected child");
  await assert.rejects(fixture.service.claim({ itemId: parent.itemId, expectedRevision: before.items.find(item => item.itemId === parent.itemId).revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  for (const variant of ["child-pause", "child-lease", "child-owned", "child-active-intent", "bound", "unknown", "pending", "dispatching",
    "duplicate", "parent-pause", "parent-owned", "parent-active-intent", "source-left", "source-pending", "changed-child-binding"]) {
    const state = clone(before), root = state.items.find(item => item.itemId === parent.itemId);
    const child = state.items.find(item => item.graph.parentItemId === parent.itemId);
    const box = state.outbox.find(item => item.itemId === child.itemId && item.status === "failed");
    if (variant === "child-pause") child.status = "paused";
    if (variant === "child-lease") child.leaseUntil = "2026-08-03T00:00:00.000Z";
    if (variant === "child-owned") child.ownerId = "employee-developer";
    if (variant === "child-active-intent") child.activeIntentId = box.intentId;
    if (variant === "bound") box.dispatchBinding = {};
    if (["unknown", "pending", "dispatching"].includes(variant)) state.outbox.push({ ...clone(box), status: variant });
    if (variant === "duplicate") state.outbox.push(clone(box));
    if (variant === "parent-pause") root.status = "paused";
    if (variant === "parent-owned") root.ownerId = "employee-orchestrator";
    if (variant === "parent-active-intent") root.activeIntentId = box.intentId;
    if (variant === "source-left") root.source.scope.active = false;
    if (variant === "source-pending") root.source.pendingRevision = root.source.inputRevision + 1;
    if (variant === "changed-child-binding") child.assignment.graphTask.sourceBinding.headRefOid = "f".repeat(40);
    assert.equal(recordedFailureParentIds(state, indexUnstartedCodeDispatchFailures(state)).has(root.itemId), false, variant);
  }
}

async function rejectedIssueInspectionFixture() {
  const f = await parentCoordinationLedgerFixture({ binding: "generic", returned: false });
  let child = await f.read(f.child.itemId);
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  await f.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
    actorId: "employee-developer", roleId: "developer", intent: codeActionIntent({ operation: "inspect" }) });
  let binds = 0, proposals = 0;
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: { bind() { binds++; assert.fail("incompatible inspection must stop before policy binding"); } },
    attentionProducer: { async create() { assert.fail("No attention request"); } },
    proposalProducer: { async create() { proposals++; assert.fail("No downstream proposal"); } } });
  const result = await dispatcher.dispatchPending();
  assert.equal(result.blocked, 1);
  assert.equal(result.items[0].code, "policy-binding-invalid", "the original safety rejection stays unchanged");
  assert.equal(binds, 0); assert.equal(proposals, 0);
  return f;
}

test("a rejected issue inspection wakes its existing parent coordinator without replay after restart", async () => {
  const f = await rejectedIssueInspectionFixture(), child = f.child;
  const before = f.store.stored(), failed = before.items.find(item => item.itemId === child.itemId);
  assert.equal(failed.status, "blocked"); assert.equal(failed.currentTarget.id, "developer");
  const box = before.outbox.find(entry => entry.itemId === child.itemId);
  assert.equal(box.dispatchBinding, null); assert.equal(box.outcome.downstreamRef, undefined);
  const restarted = await createFixture({ source: f.source, store: f.store, time: f.time });
  const page = await restarted.service.listClaimCandidates({ at: f.time.clock(), roleId: "orchestrator" });
  const fact = page.facts.find(entry => entry.itemId === f.root.itemId);
  assert.equal(fact.graphBlocked, true);
  assert.equal(fact.orchestrationReady, true, "the confirmed pre-binding rejection must reach its issue parent");
  const assembler = new RoleContextAssembler({ graphReader: { getSnapshot: () => restarted.service.getGraphSnapshot() } });
  const root = (await restarted.service.listItems()).items.find(item => item.itemId === f.root.itemId);
  const packet = await assembler.assemble({ roleId: "orchestrator", item: root, trigger: "employee:orchestrator" });
  const visible = packet.context.requirements.coordination.directChildren[0];
  assert.equal(visible.blockingCondition, "delivery-evidence-incompatible");
  assert.equal(visible.dispatchFailure.operation, "inspect");
  assert.deepEqual(visible.dispatchFailure.compatibleEvidenceKinds, []);
  assert.equal(visible.dispatchFailure.downstreamCreated, false);
  const wakes = [], operations = [];
  const scheduler = new WorkContinuationScheduler({ store: new MemoryStore(), ledger: restarted.service,
    configurationReader: { readActive: async () => ({ configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }) },
    roleStateReader: { read: async () => ({ enabled: true, paused: false }) }, clock: f.time.clock });
  await scheduler.runCycle({ dispatch: async ({ roleId }) => { wakes.push(roleId); },
    runOperation: operation => { const pending = operation(); operations.push(pending); return pending; } });
  await Promise.all(operations);
  assert.deepEqual(wakes, ["orchestrator"], "natural scheduling requests a fresh coordinating decision");
  await assert.rejects(restarted.service.claim({ itemId: root.itemId, expectedRevision: root.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  assert.deepEqual(f.store.stored(), before, "wake and diagnostic do not resume, replay, or rewrite failed history");

  for (const variant of ["child-pause", "lease", "active-intent", "unknown-decision", "delivery", "bound", "pending", "unknown", "duplicate",
    "changed-input", "new-contract", "wrong-operation", "wrong-code", "closed", "changed-event", "parent-pause", "parent-owned", "parent-unknown"]) {
    const state = clone(before), current = state.items.find(item => item.itemId === child.itemId);
    const parent = state.items.find(item => item.itemId === root.itemId), outbox = state.outbox.find(entry => entry.itemId === child.itemId);
    if (variant === "child-pause") current.status = "paused";
    if (variant === "lease") current.leaseUntil = "2026-08-03T00:00:00.000Z";
    if (variant === "active-intent") current.activeIntentId = outbox.intentId;
    if (variant === "unknown-decision") current.decisionContext = { outcome: "unknown" };
    if (variant === "delivery") current.graph.deliveries.push({ status: "submitted" });
    if (variant === "bound") outbox.dispatchBinding = {};
    if (["pending", "unknown"].includes(variant)) state.outbox.push({ ...clone(outbox), status: variant });
    if (variant === "duplicate") state.outbox.push(clone(outbox));
    if (variant === "changed-input") outbox.inputDigest = "f".repeat(64);
    if (variant === "new-contract") current.graph.acceptanceContracts.at(-1).recordedAt = "2026-08-03T00:00:00.000Z";
    if (variant === "wrong-operation") outbox.intent.operation = "modify";
    if (variant === "wrong-code") outbox.outcome.details.code = "policy-denied";
    if (variant === "closed") parent.event.payload.state = "closed";
    if (variant === "changed-event") parent.event.eventId = "changed-event";
    if (variant === "parent-pause") parent.status = "paused";
    if (variant === "parent-owned") parent.ownerId = "active-owner";
    if (variant === "parent-unknown") parent.decisionContext = { outcome: "unknown" };
    assert.equal(recordedFailureParentIds(state, indexUnstartedCodeDispatchFailures(state)).has(root.itemId), false, variant);
  }
});

test("issue inspection failure reaches controlled parent replanning and stops waking once corrected work is pending", async () => {
  const f = await rejectedIssueInspectionFixture(), before = f.store.stored();
  const restarted = await createFixture({ source: f.source, store: f.store, time: f.time });
  const graph = new WorkGraphStore({ ledger: restarted.service }), reader = graph.reader();
  const assembler = new RoleContextAssembler({ graphReader: reader });
  const host = new OrchestratorService({ contextAssembler: assembler, graphReader: reader, capabilityRoles: { development: "developer" },
    scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) { return graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId }); } },
    graphDelivererFactory: { forClaim() { assert.fail("Parent cannot acquire child delivery authority"); } } });
  const schedulerStore = new MemoryStore(), options = { store: schedulerStore, ledger: restarted.service,
    configurationReader: { readActive: async () => ({ configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }) },
    roleStateReader: { read: async roleId => ({ enabled: roleId === "orchestrator", paused: false }) }, clock: f.time.clock };
  let scheduler = new WorkContinuationScheduler(options), decisions = 0;
  const dispatch = async ({ roleId }) => {
    assert.equal(roleId, "orchestrator");
    const items = (await restarted.service.listItems()).items, root = items.find(item => item.itemId === f.root.itemId);
    const child = items.find(item => item.itemId === f.child.itemId);
    const packet = await assembler.assemble({ roleId, item: root, trigger: "employee:orchestrator" });
    const source = decisions === 0 ? child : root;
    const action = { schemaVersion: 1, type: decisions === 0 ? "cancel" : "decompose", sourceTaskId: source.itemId,
      sourceTaskRevision: source.revision, expectedGraphRevision: packet.binding.graphRevision, reason: "Continue original issue with compatible work" };
    if (decisions === 1) Object.assign(action, { childKey: "corrected-development", capability: "development", dependsOn: [],
      work: { title: "Continue issue implementation", description: "Produce the original required package through controlled modification" },
      acceptanceContract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [{ deliverableId: "package", kind: "change-package",
        description: "Original required package", required: true }] } });
    assert.ok(decisions < 2, "unchanged pending child must not cause another parent model decision");
    const result = await host.execute({ worker: { roleId, workerId: "employee-orchestrator" }, item: root, contextPacket: packet,
      intent: { schemaVersion: 1, type: "orchestrate", summary: "Continue issue", reason: action.reason, action } });
    assert.equal(result.applied, true); decisions++;
  };
  const cycle = async () => {
    const operations = [];
    await scheduler.runCycle({ dispatch, runOperation: operation => { const pending = operation(); operations.push(pending); return pending; } });
    await Promise.all(operations);
  };
  await cycle();
  assert.equal(decisions, 1, "real scheduler invokes the controlled coordinator to consume the failure");
  await cycle();
  assert.equal(decisions, 2, "related cancellation progress permits one corrected decomposition");
  for (let index = 0; index < 3; index++) { f.time.advance(600_000); await cycle(); }
  scheduler = new WorkContinuationScheduler(options);
  await cycle();
  assert.equal(decisions, 2, "restart and unchanged pending work never replay the old inspection or busy-loop parent decisions");
  const after = f.store.stored(), failed = after.items.find(item => item.itemId === f.child.itemId);
  assert.equal(failed.status, "cancelled");
  assert.equal(failed.attempt, before.items.find(item => item.itemId === failed.itemId).attempt);
  assert.deepEqual(failed.graph.acceptanceContracts, before.items.find(item => item.itemId === failed.itemId).graph.acceptanceContracts);
  assert.deepEqual(after.outbox, before.outbox, "replanning preserves every original intent and creates no downstream proposal");
  assert.equal(after.items.filter(item => item.graph.parentItemId === f.root.itemId && item.status === "queued").length, 1);
});

test("a historical unbound verification failure reaches its waiting orchestrator without changing child history", async () => {
  const record = ownerRequestedPrAssignment(1);
  record.assignment.target = { type: "role", id: "orchestrator" };
  const fixture = await createFixture({ records: [record] });
  await fixture.service.intake();
  const [parent] = (await fixture.service.listItems()).items;
  const command = prGraphChildCommand(parent, (await fixture.service.getSummary()).revision);
  command.command.acceptanceContract.expectedDeliverables = [{ deliverableId: "ci-fix-package", kind: "change-package",
    description: "保留原修复包", required: true }];
  const created = await fixture.service.createGraphChild(command);
  let child = (await fixture.service.listItems()).items.find(item => item.itemId === created.taskId);
  child = await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  const staged = await fixture.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision,
    leaseId: child.leaseId, actorId: "employee-developer", roleId: "developer", intent: codeActionIntent({ operation: "verify" }) });
  const outbox = await fixture.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: outbox.intentId, expectedRevision: outbox.revision,
    dispatchLeaseId: outbox.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    actorId: "work-intent-dispatcher", outcome: "failed", nextStatus: "blocked", details: { code: "policy-binding-invalid" } });
  const before = clone(fixture.store.stored());
  const snapshot = await fixture.service.getGraphSnapshot();
  const diagnostic = snapshot.taskStates.find(item => item.taskId === child.itemId).dispatchFailure;
  assert.equal(diagnostic?.code, "delivery-evidence-incompatible");
  assert.equal(diagnostic.downstreamCreated, false);
  assert.deepEqual(diagnostic.compatibleEvidenceKinds, ["test-report"]);
  assert.deepEqual(diagnostic.expectedDeliverables, [{ deliverableId: "ci-fix-package", kind: "change-package" }]);
  assert.equal((await fixture.service.listItems()).items.find(item => item.itemId === parent.itemId).status, "queued");
  assert.deepEqual(fixture.store.stored(), before, "diagnostic projection never resets or replays work");
  await assertDispatchFailureWakesParent(fixture, parent);
  const failedChild = before.items.find(item => item.itemId === child.itemId);
  const failedBoxes = before.outbox.filter(item => item.itemId === child.itemId);
  for (const variant of ["paused", "active-intent", "bound", "unknown", "changed-input", "new-contract", "compatible-contract", "different-error", "duplicate"]) {
    const candidate = clone(failedChild), boxes = clone(failedBoxes), box = boxes.at(-1);
    if (variant === "paused") candidate.status = "paused";
    if (variant === "active-intent") candidate.activeIntentId = box.intentId;
    if (variant === "bound") box.dispatchBinding = {};
    if (variant === "unknown") box.status = "unknown";
    if (variant === "changed-input") box.inputDigest = "f".repeat(64);
    if (variant === "new-contract") candidate.graph.acceptanceContracts.at(-1).recordedAt = "2026-08-03T00:00:00.000Z";
    if (variant === "compatible-contract") candidate.graph.acceptanceContracts.at(-1).expectedDeliverables[0].kind = "test-report";
    if (variant === "different-error") box.outcome.details.code = "policy-denied";
    if (variant === "duplicate") boxes.push(clone(box));
    assert.equal(unstartedDeliveryContractFailure(candidate, boxes), null, variant);
  }
});

test("a compatible code proposal's unbound policy failure reaches its parent without replay", async () => {
  const record = ownerRequestedPrAssignment(1);
  record.assignment.target = { type: "role", id: "orchestrator" };
  const fixture = await createFixture({ records: [record] });
  await fixture.service.intake();
  const [parent] = (await fixture.service.listItems()).items;
  const command = prGraphChildCommand(parent, (await fixture.service.getSummary()).revision);
  command.command.acceptanceContract.expectedDeliverables = [{ deliverableId: "ci-fix-package", kind: "change-package",
    description: "Continue the controlled repair", required: true }];
  const created = await fixture.service.createGraphChild(command);
  let child = (await fixture.service.listItems()).items.find(item => item.itemId === created.taskId);
  child = await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  const staged = await fixture.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision,
    leaseId: child.leaseId, actorId: "employee-developer", roleId: "developer",
    intent: { ...codeActionIntent({ operation: "modify" }), deliverableId: "ci-fix-package" } });
  const outbox = await fixture.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: outbox.intentId, expectedRevision: outbox.revision,
    dispatchLeaseId: outbox.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    actorId: "work-intent-dispatcher", outcome: "failed", nextStatus: "blocked", details: { code: "policy-binding-invalid" } });
  const before = clone(fixture.store.stored());
  const snapshot = await fixture.service.getGraphSnapshot();
  assert.deepEqual(snapshot.taskStates.find(item => item.taskId === child.itemId).dispatchFailure,
    { intentId: outbox.intentId, code: "policy-binding-invalid", downstreamCreated: false });
  assert.deepEqual(fixture.store.stored(), before, "diagnosis never resumes a child or replays a failed intent");
  await assertDispatchFailureWakesParent(fixture, parent);
  const failedChild = before.items.find(item => item.itemId === child.itemId);
  const failedBoxes = before.outbox.filter(item => item.itemId === child.itemId);
  for (const variant of ["paused", "active-intent", "owner", "lease", "bound", "unknown", "changed-input",
    "changed-source", "new-contract", "wrong-delivery", "different-error", "duplicate", "old-outcome"]) {
    const candidate = clone(failedChild), boxes = clone(failedBoxes), box = boxes.at(-1);
    if (variant === "paused") candidate.status = "paused";
    if (variant === "active-intent") candidate.activeIntentId = box.intentId;
    if (variant === "owner") candidate.ownerId = "employee-developer";
    if (variant === "lease") candidate.leaseUntil = "2026-08-03T00:00:00.000Z";
    if (variant === "bound") box.dispatchBinding = {};
    if (variant === "unknown") box.status = "unknown";
    if (variant === "changed-input") box.inputDigest = "f".repeat(64);
    if (variant === "changed-source") box.sourceBinding = null;
    if (variant === "new-contract") candidate.graph.acceptanceContracts.at(-1).recordedAt = "2026-08-03T00:00:00.000Z";
    if (variant === "wrong-delivery") box.intent.deliverableId = "other-package";
    if (variant === "different-error") box.outcome.details.code = "policy-denied";
    if (variant === "duplicate") boxes.push(clone(box));
    if (variant === "old-outcome") box.updatedAt = "2026-08-01T00:00:00.000Z";
    assert.equal(unstartedCodePolicyBindingFailure(candidate, boxes), null, variant);
  }
});

function missingHostContextIntent(child) {
  return { schemaVersion: 1, type: "ask_user", summary: "补齐未知阻塞的宿主上下文",
    reason: `子任务 revision ${child.revision} 的 ledgerStatus 为 blocked，但 blockingCondition 为 null，且没有提案处理结果、失败码或活动执行信息。原交付已退回，当前没有待验收交付。现有只读工具未提供任务详情查询能力，无法可靠确定恢复路径；不能猜测基础设施故障、取消已有修复任务、重复修改或宣告 CI 修复成功。`,
    question: `请补充开发子任务 ${child.itemId} 的宿主阻塞原因及最新补充验证提案处理结果引用，注明是否存在活动执行；如有失败，请提供错误码和恢复状态。本次仅补齐缺失状态，不请求重新授权常规修复或发布。`,
    choices: [{ id: "supply-blocking-context", label: "补齐阻塞上下文",
      description: "提供宿主记录的阻塞原因和验证提案状态，保留原修复包及任务历史，再按证据继续。" }] };
}

function missingPolicyContextIntent(child) {
  return { summary: "升级续接任务缺失的阻塞诊断",
    reason: "续接任务仍为 blocked，但 blockingCondition=null，未提供本次 dispatchFailure、下游创建状态或恢复结论。现有证据不足以安全选择恢复动作；旧任务的契约不兼容不能解释本次阻塞。此次升级只索取缺失的运行事实，不请求常规修复授权，不取消既有任务或改写契约。",
    question: `#${currentWorkItemEvent(child).subject.number} 的续接开发任务仍被标记为 blocked，但没有原因。请补充本次派发的失败代码、关联提案或作业标识、是否创建下游及当前恢复结论；若这些信息暂不可取得，请明确是否有意暂缓该子任务。`,
    choices: [{ id: "provide-blocking-evidence", label: "补充阻塞诊断", description: "提供宿主记录中的失败及恢复事实，以便选择匹配的恢复方式；继续保留原任务、契约和失败历史。" },
      { id: "explicitly-defer-child", label: "明确暂缓子任务", description: "若暂时无法取得诊断且有意停止推进，明确暂缓范围；不表示代码已修复或 CI 已通过。" }] };
}

async function pendingHostContextFixture({ policy = false, beforeRecoveryAdmission } = {}) {
  const record = ownerRequestedPrAssignment(1, { gitFacts: { ...prGitFacts(PR_HEAD_A),
    workType: "general", nextAction: "fix_ci", suggestedCapability: "development", expectedHeadRefOid: PR_HEAD_A } });
  record.assignment.target = { type: "role", id: "orchestrator" };
  let control;
  let recoveryArmed = false;
  const controlReads = [];
  const fixture = await createFixture({ records: [record],
    actionAdmissionGate: { async run(operation) { if (recoveryArmed) beforeRecoveryAdmission?.(control); return operation(); } },
    hostContextRecoveryReader: {
      read: async input => { controlReads.push(input); return clone(control); },
      async withStoppedRuns(expected, operation) {
        if (JSON.stringify(expected) !== JSON.stringify(control)) return { executed: false };
        return { executed: true, result: await operation() };
      },
    } });
  await fixture.service.intake();
  let [parent] = (await fixture.service.listItems()).items;
  const command = prGraphChildCommand(parent, (await fixture.service.getSummary()).revision);
  command.command.acceptanceContract.expectedDeliverables = [{ deliverableId: "ci-fix-package", kind: "change-package", description: "保留修复包", required: true }];
  const created = await fixture.service.createGraphChild(command);
  let child = (await fixture.service.listItems()).items.find(item => item.itemId === created.taskId);
  child = await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: "employee-developer", leaseDurationMs: 30_000 });
  const failed = await fixture.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
    actorId: "employee-developer", roleId: "developer", intent: policy
      ? { ...codeActionIntent({ operation: "modify" }), deliverableId: "ci-fix-package" }
      : codeActionIntent({ operation: "verify" }) });
  const dispatch = await fixture.service.claimIntent({ intentId: failed.outbox.intentId, expectedRevision: failed.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision, dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: failed.item.revision, actorId: "work-intent-dispatcher", outcome: "failed", nextStatus: "blocked", details: { code: "policy-binding-invalid" } });
  child = (await fixture.service.listItems()).items.find(item => item.itemId === child.itemId);
  parent = (await fixture.service.listItems()).items.find(item => item.itemId === parent.itemId);
  control = { actorAccountId: "SV-li-zhenhui", run: { kind: "work-item", taskId: parent.itemId, roleId: "orchestrator", active: false,
    mode: "active", pendingCommand: null, phase: "completed", receipt: { taskId: parent.itemId, kind: "work-item", roleId: "orchestrator",
      taskRevision: parent.revision, registeredAt: fixture.time.clock(), modelStartedAt: fixture.time.clock(), finishedAt: fixture.time.clock(), phase: "completed", stopConfirmed: true } } };
  // Configuration and GitHub projections can spell the same login with different case.
  control.actorAccountId = prExecutionBinding(parent).gitTarget.sourceAccountId.toUpperCase();
  if (policy) control.childRun = { kind: "work-item", taskId: child.itemId, roleId: "developer", active: false,
    mode: "active", pendingCommand: null, phase: "completed", receipt: { taskId: child.itemId, kind: "work-item", roleId: "developer",
      taskRevision: child.revision - 2, registeredAt: fixture.time.clock(), modelStartedAt: fixture.time.clock(),
      finishedAt: fixture.time.clock(), phase: "completed", stopConfirmed: true } };
  const questionItem = policy ? child : parent;
  const { summary, reason, question, choices } = policy ? missingPolicyContextIntent(child) : missingHostContextIntent(child);
  const staged = await fixture.service.stageGraphEscalation({ authority: { actorId: "employee-orchestrator", scopeRootTaskId: parent.itemId },
    command: { taskId: questionItem.itemId, expectedTaskRevision: questionItem.revision, expectedGraphRevision: (await fixture.service.getSummary()).revision,
      summary, reason, question, choices } });
  let ask = await fixture.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  ask = await fixture.service.bindIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    dispatcherId: "work-intent-dispatcher",
    itemExpectedRevision: staged.item.revision, boundIntent: boundAttentionIntent(staged.item, ask) });
  const request = normalizeAttentionRequest({ requestKey: ask.intentId, type: "ask_user",
    producer: { roleId: "orchestrator", workItemId: questionItem.itemId }, question, choices, context: [] });
  const attention = createAttentionItem(request, 1, fixture.time.clock());
  await fixture.service.ackIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision, actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "waiting_user",
    details: { questionRef: attention.requestId } });
  return { ...fixture, parentId: parent.itemId, childId: child.itemId, askId: ask.intentId, control, controlReads, request, attention,
    retry: () => { recoveryArmed = true; return fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [ask.intentId] }); } };
}

test("host diagnostics retire a child's obsolete status question once without replaying its failed proposal", async () => {
  const fixture = await pendingHostContextFixture({ policy: true });
  const before = clone(fixture.store.stored());
  const failed = before.outbox.find(entry => entry.itemId === fixture.childId && entry.status === "failed");
  assert.deepEqual(await fixture.retry(), { retried: 1 });
  assert.deepEqual(fixture.controlReads, [{ itemId: fixture.parentId, childItemId: fixture.childId }]);
  const after = fixture.store.stored(), child = after.items.find(entry => entry.itemId === fixture.childId);
  assert.equal(child.status, "retry_wait");
  assert.equal(child.statusReason, "host_context_facts_recovered");
  assert.equal(child.activeIntentId, null);
  assert.deepEqual(after.outbox.find(entry => entry.intentId === failed.intentId), failed);
  assert.deepEqual(await fixture.retry(), { retried: 0 });
  assert.deepEqual(await fixture.service.readAttentionRequestRetirement({ requestKey: fixture.askId,
    producer: { roleId: "orchestrator", workItemId: fixture.childId } }),
    { status: "retry_wait", workItemRevision: child.revision, reason: "host_context_facts_recovered" });
  const repeated = clone(before);
  repeated.outbox.find(entry => entry.intentId === fixture.askId).outcome =
    clone(after.outbox.find(entry => entry.intentId === fixture.askId).outcome);
  assert.equal(hostContextRecoveryCandidate(repeated, repeated.items.find(entry => entry.itemId === fixture.childId)), null,
    "a retained proof prevents the same input, child, contract and failure from consuming another retry");
  const late = resolveAttentionItem(fixture.attention, { type: "choice", choiceId: "explicitly-defer-child" },
    2, fixture.time.clock(), 1).outbox;
  const saved = clone(child);
  await fixture.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(fixture.store.stored().items.find(entry => entry.itemId === child.itemId), saved,
    "an archived obsolete request cannot later impersonate a new owner command");
});

test("child diagnostic recovery preserves decisions, exact history and both execution owners", async t => {
  for (const variant of ["root-pause", "child-pause", "delivery", "real-question", "extra-choice", "answered", "backlog",
    "bound-failure", "unknown", "new-contract", "intervening-revision", "root-active", "root-command", "child-active",
    "child-command", "child-paused", "child-stop-unknown", "child-no-receipt", "child-wrong-revision", "wrong-actor", "cas-root"]) {
    await t.test(variant, async () => {
      const fixture = await pendingHostContextFixture({ policy: true });
      const state = clone(fixture.store.stored()), item = state.items.find(entry => entry.itemId === fixture.childId);
      const root = state.items.find(entry => entry.itemId === fixture.parentId);
      const original = hostContextRecoveryCandidate(state, item);
      assert.ok(original);
      const captured = { itemId: item.itemId, snapshotDigest: original.snapshotDigest };
      const ask = state.outbox.find(entry => entry.intentId === fixture.askId);
      const failed = state.outbox.find(entry => entry.itemId === item.itemId && entry.status === "failed");
      if (variant === "root-pause") root.status = "paused";
      if (variant === "child-pause") item.status = "paused";
      if (variant === "delivery") item.graph.deliveries.push({});
      if (variant === "real-question") ask.intent.question = "Change the acceptance policy?";
      if (variant === "extra-choice") ask.intent.choices.push({ id: "new-choice" });
      if (variant === "answered") ask.outcome.details.resultAttestation = {};
      if (variant === "backlog") state.attentionHighWatermark++;
      if (variant === "bound-failure") failed.dispatchBinding = {};
      if (variant === "unknown") failed.status = "unknown";
      if (variant === "new-contract") item.graph.acceptanceContracts.at(-1).recordedAt = "2027-01-01T00:00:00.000Z";
      if (variant === "intervening-revision") item.revision++;
      if (variant === "root-active") fixture.control.run.active = true;
      if (variant === "root-command") fixture.control.run.pendingCommand = { type: "pause" };
      if (variant === "child-active") fixture.control.childRun.active = true;
      if (variant === "child-command") fixture.control.childRun.pendingCommand = { type: "pause" };
      if (variant === "child-paused") fixture.control.childRun.mode = "paused";
      if (variant === "child-stop-unknown") fixture.control.childRun.receipt.stopConfirmed = false;
      if (variant === "child-no-receipt") fixture.control.childRun.receipt = null;
      if (variant === "child-wrong-revision") fixture.control.childRun.receipt.taskRevision++;
      if (variant === "wrong-actor") fixture.control.actorAccountId = "someone-else";
      if (variant === "cas-root") root.revision++;
      const before = clone(state);
      assert.deepEqual(planHostContextRecovery({ state, captured, control: fixture.control, clock: fixture.time.clock }),
        { write: false, result: { retried: 0 } });
      assert.deepEqual(state, before);
    });
  }
});

test("a root restart or owner control after proof reading fences child question recovery", async t => {
  for (const change of ["root-restart", "root-command", "child-command"]) await t.test(change, async () => {
    const fixture = await pendingHostContextFixture({ policy: true, beforeRecoveryAdmission(control) {
      if (change === "root-restart") control.run.active = true;
      if (change === "root-command") control.run.pendingCommand = { type: "pause" };
      if (change === "child-command") control.childRun.pendingCommand = { type: "cancel" };
    } });
    const before = clone(fixture.store.stored());
    assert.deepEqual(await fixture.retry(), { retried: 0 });
    assert.deepEqual(fixture.store.stored(), before, "unchanged ledger revision cannot stand in for current run ownership");
  });
});

test("new host facts retire only the obsolete question and give its parent one normal decision", async () => {
  const fixture = await pendingHostContextFixture();
  const runtime = await createWorkLedgerRuntime({ store: fixture.store, assignmentSource: fixture.source, clock: fixture.time.clock,
    createGuard: () => ({ acquire: async () => {}, run: fn => fixture.lease.run(fn), close: async () => {} }),
    createCandidateProcessor: createLocalWorkLedgerCandidateProcessor, hostContextRecoveryReader: { read: async () => fixture.control } });
  const inboxStore = new MemoryStore();
  const inbox = new AttentionInbox({ store: inboxStore, exclusiveLease: new ExclusiveLease(), authority: runtime, clock: fixture.time.clock });
  await inbox.recover();
  await inbox.create(fixture.request);
  const before = clone(fixture.store.stored());
  assert.equal((await inbox.retrySystemQuestions()).retried, 1);
  assert.deepEqual(await inbox.archiveRetired(), { archived: 1 });
  assert.equal(inboxStore.stored("attention-inbox").items[0].result, null);
  assert.equal(inboxStore.stored("attention-inbox").items[0].question, fixture.request.question);
  assert.equal((await inbox.readOutbox()).items.length, 0);
  const after = fixture.store.stored();
  const parent = after.items.find(item => item.itemId === fixture.parentId);
  const oldParent = before.items.find(item => item.itemId === fixture.parentId);
  assert.equal(parent.status, "retry_wait");
  assert.equal(parent.activeIntentId, null);
  assert.equal(parent.attempt, oldParent.attempt);
  assert.deepEqual(parent.decisionContext, oldParent.decisionContext);
  assert.deepEqual(after.items.find(item => item.itemId === fixture.childId), before.items.find(item => item.itemId === fixture.childId));
  const proof = after.outbox.find(entry => entry.intentId === fixture.askId).outcome.details.hostContextRetirement;
  assert.equal(proof.reason, "host_context_facts_recovered");
  assert.equal(proof.failure.downstreamCreated, false);
  assert.equal(proof.failure.code, "delivery-evidence-incompatible");
  const candidates = await runtime.listClaimCandidates({ at: fixture.time.clock(), limit: 100 });
  const fact = candidates.facts.find(entry => entry.itemId === parent.itemId);
  assert.equal(fact.graphBlocked, true, "the specialist still cannot claim a child-blocked root");
  assert.equal(fact.orchestrationReady, true, "the host-proven recovery needs a fresh coordinating decision");
  await assert.rejects(runtime.claim({ itemId: parent.itemId, expectedRevision: parent.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  const wakes = [], operations = [];
  const scheduler = new WorkContinuationScheduler({ store: new MemoryStore(), ledger: runtime,
    configurationReader: { readActive: async () => ({ configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }) },
    roleStateReader: { read: async () => ({ enabled: true, paused: false }) }, clock: fixture.time.clock });
  await scheduler.runCycle({ dispatch: async ({ roleId }) => { wakes.push(roleId); },
    runOperation: operation => { const pending = operation(); operations.push(pending); return pending; } });
  await Promise.all(operations);
  assert.deepEqual(wakes, ["orchestrator"], "the real ledger fact reaches the durable role wake path");
  for (const boundary of ["child-revision", "parent-revision", "proof-digest", "root-pause", "child-unknown"]) {
    const snapshot = clone(after), root = snapshot.items.find(item => item.itemId === parent.itemId);
    const failedChild = snapshot.items.find(item => item.itemId === fixture.childId);
    if (boundary === "child-revision") failedChild.revision++;
    if (boundary === "parent-revision") root.revision++;
    if (boundary === "proof-digest") snapshot.outbox.find(entry => entry.intentId === fixture.askId).outcome.details.hostContextRetirement.digest = "f".repeat(64);
    if (boundary === "root-pause") root.status = "paused";
    if (boundary === "child-unknown") snapshot.outbox.find(entry => entry.itemId === fixture.childId).status = "unknown";
    assert.equal(hasPendingHostContextRecovery(snapshot, root), false, boundary);
  }
  await runtime.close();
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time,
    hostContextRecoveryReader: { read: async () => fixture.control } });
  assert.deepEqual(await restarted.service.readAttentionRequestRetirement({ requestKey: fixture.askId,
    producer: { roleId: "orchestrator", workItemId: fixture.parentId } }),
    { status: "retry_wait", workItemRevision: parent.revision, reason: "host_context_facts_recovered" });
  const late = resolveAttentionItem(fixture.attention, { type: "choice", choiceId: "supply-blocking-context" }, 2, fixture.time.clock(), 1).outbox;
  const savedParent = clone(parent);
  await restarted.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(restarted.store.stored().items.find(item => item.itemId === parent.itemId), savedParent);
  // A new ask/failure intent ID with the same input and contract cannot consume another retry.
  const duplicateState = clone(after);
  const duplicateParent = duplicateState.items.find(item => item.itemId === parent.itemId);
  Object.assign(duplicateParent, oldParent);
  const duplicateAsk = clone(before.outbox.find(entry => entry.intentId === fixture.askId));
  duplicateAsk.intentId = `work-intent-${"f".repeat(64)}`;
  duplicateParent.activeIntentId = duplicateAsk.intentId;
  duplicateState.outbox.push(duplicateAsk);
  duplicateState.outbox.find(entry => entry.itemId === fixture.childId).intentId = `work-intent-${"e".repeat(64)}`;
  assert.equal(hostContextRecoveryCandidate(duplicateState, duplicateParent), null);
});

test("host-recovered parent can create a fresh child after restart without changing the failed delivery", async () => {
  const fixture = await pendingHostContextFixture();
  assert.equal((await fixture.retry()).retried, 1);
  const before = clone(fixture.store.stored());
  const parent = before.items.find(item => item.itemId === fixture.parentId);
  assert.equal(hasPendingHostContextRecovery(before, parent), true);
  const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
  const command = prGraphChildCommand(parent, before.revision, "repair-after-host-recovery");
  const created = await restarted.service.createGraphChild(command);
  const after = clone(fixture.store.stored());
  const currentParent = after.items.find(item => item.itemId === parent.itemId);
  const child = after.items.find(item => item.itemId === created.taskId);
  assert.equal(currentParent.status, "queued");
  assert.equal(currentParent.statusReason, "waiting_for_children");
  assert.equal(currentParent.revision, parent.revision + 1);
  assert.equal(hasPendingHostContextRecovery(after, currentParent), false);
  assert.equal(child.currentTarget.id, "developer");
  assert.equal(child.status, "queued");
  assert.deepEqual(after.items.find(item => item.itemId === fixture.childId), before.items.find(item => item.itemId === fixture.childId));
  assert.deepEqual(after.outbox, before.outbox);
  assert.equal((await restarted.service.createGraphChild(command)).taskId, child.itemId);
  assert.deepEqual(fixture.store.stored(), after, "replay returns the existing child without another write");
  const claimed = await restarted.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  assert.equal(claimed.status, "working");
});

test("host-recovery child creation rejects missing, changed or held proof and stale commands", async t => {
  for (const boundary of ["missing-proof", "proof-digest", "child-revision", "parent-revision", "root-pause", "ordinary-retry", "graph-revision"]) {
    await t.test(boundary, async () => {
      const fixture = await pendingHostContextFixture();
      assert.equal((await fixture.retry()).retried, 1);
      const state = clone(fixture.store.stored());
      const parent = state.items.find(item => item.itemId === fixture.parentId);
      const command = prGraphChildCommand(parent, state.revision, "repair-after-host-recovery");
      const proof = state.outbox.find(entry => entry.intentId === fixture.askId).outcome.details.hostContextRetirement;
      if (boundary === "missing-proof") delete state.outbox.find(entry => entry.intentId === fixture.askId).outcome.details.hostContextRetirement;
      if (boundary === "proof-digest") proof.digest = "f".repeat(64);
      if (boundary === "child-revision") state.items.find(item => item.itemId === fixture.childId).revision++;
      if (boundary === "parent-revision") { parent.revision++; command.command.expectedTaskRevisions[0].revision = parent.revision; }
      if (boundary === "root-pause") { parent.status = "paused"; parent.availableAt = null; }
      if (boundary === "ordinary-retry") parent.statusReason = "retry-backoff";
      if (boundary === "graph-revision") command.command.expectedGraphRevision--;
      fixture.store.replaceStored(state);
      const restarted = await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time });
      const before = clone(fixture.store.stored());
      await assert.rejects(restarted.service.createGraphChild(command), error =>
        error.code === (boundary === "graph-revision" ? "WORK_LEDGER_STATE_REVISION_CONFLICT" : "WORK_LEDGER_GRAPH_PARENT_CONFLICT"));
      assert.deepEqual(fixture.store.stored(), before, boundary);
    });
  }
});

test("host fact recovery preserves owner controls, unanswered real questions and unproven state", async t => {
  for (const variant of ["disabled", "paused", "pending", "active", "unknown-stop", "wrong-receipt", "no-receipt", "future-receipt",
    "wrong-actor", "real-question", "multiple-choices", "wrong-revision", "wrong-child", "bound-child", "backlog", "answered", "unsealed",
    "owner-blocked", "unknown-child", "changed-root"]) {
    await t.test(variant, async () => {
      const fixture = await pendingHostContextFixture();
      const state = clone(fixture.store.stored());
      const original = hostContextRecoveryCandidate(state, state.items.find(item => item.itemId === fixture.parentId));
      const captured = { itemId: fixture.parentId, snapshotDigest: original.snapshotDigest };
      const ask = state.outbox.find(entry => entry.intentId === fixture.askId);
      const child = state.items.find(item => item.itemId === fixture.childId);
      if (variant === "disabled") fixture.control.actorAccountId = null;
      if (variant === "paused") fixture.control.run.mode = "paused";
      if (variant === "pending") fixture.control.run.pendingCommand = { type: "pause" };
      if (variant === "active") fixture.control.run.active = true;
      if (variant === "unknown-stop") fixture.control.run.receipt.stopConfirmed = false;
      if (variant === "wrong-receipt") fixture.control.run.receipt.taskRevision++;
      if (variant === "no-receipt") fixture.control.run.receipt = null;
      if (variant === "future-receipt") fixture.control.run.receipt.finishedAt = "2027-01-01T00:00:00.000Z";
      if (variant === "wrong-actor") fixture.control.actorAccountId = "someone-else";
      if (variant === "real-question") ask.intent.question = "是否改变验收口径？";
      if (variant === "multiple-choices") ask.intent.choices.push({ id: "yes", label: "继续", description: "需要决策" });
      if (variant === "wrong-revision") child.revision++;
      if (variant === "wrong-child") child.graph.parentItemId = "work-item-" + "e".repeat(64);
      if (variant === "bound-child") state.outbox.find(entry => entry.itemId === child.itemId).dispatchBinding = {};
      if (variant === "backlog") state.attentionHighWatermark++;
      if (variant === "answered") ask.outcome.details.resultAttestation = {};
      if (variant === "unsealed") ask.dispatchBinding = null;
      if (variant === "owner-blocked") state.items.find(item => item.itemId === fixture.parentId).status = "blocked";
      if (variant === "unknown-child") state.outbox.find(entry => entry.itemId === child.itemId).status = "unknown";
      if (variant === "changed-root") state.items.find(item => item.itemId === fixture.parentId).revision++;
      const before = clone(state);
      assert.deepEqual(planHostContextRecovery({ state, captured, control: fixture.control, clock: fixture.time.clock }),
        { write: false, result: { retried: 0 } });
      assert.deepEqual(state, before);
    });
  }
});

test("host context retirement commits before archive and a recorded owner rejection wins", async t => {
  for (const reject of [false, true]) await t.test(reject ? "owner rejection" : "durable failure and restart", async () => {
    const fixture = await pendingHostContextFixture();
    const store = new MemoryStore();
    const options = { store, exclusiveLease: new ExclusiveLease(), authority: fixture.service, clock: fixture.time.clock };
    let inbox = new AttentionInbox(options);
    await inbox.recover();
    const attention = await inbox.create(fixture.request);
    if (reject) {
      await inbox.reject({ requestId: attention.requestId, expectedRevision: attention.revision,
        contentDigest: attention.contentDigest, answer: { type: "reject", reason: "先暂停" } });
      assert.equal((await inbox.retrySystemQuestions()).retried, 0);
      assert.equal((await inbox.archiveRetired()).archived, 0);
      const batch = await inbox.readOutbox();
      await fixture.service.applyAttentionBatch(batch);
      assert.equal(fixture.store.stored().items.find(item => item.itemId === fixture.parentId).status, "blocked");
      assert.equal((await fixture.retry()).retried, 0);
    } else {
      fixture.store.failNextWrite();
      await assert.rejects(inbox.retrySystemQuestions(), error => error.cause?.message === "durable write unavailable");
      assert.equal((await inbox.archiveRetired()).archived, 0);
      assert.equal(store.stored("attention-inbox").items[0].status, "pending");
      assert.equal((await inbox.retrySystemQuestions()).retried, 1);
      // Simulate losing the process between the ledger commit and inbox archive.
      inbox = new AttentionInbox(options);
      await inbox.recover();
      assert.equal((await inbox.archiveRetired()).archived, 1);
      assert.equal(store.stored("attention-inbox").items[0].result, null);
      assert.equal((await inbox.readOutbox()).items.length, 0);
      assert.equal((await inbox.archiveRetired()).archived, 0);
    }
  });
});

function handoffIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "handoff",
    summary: "需要测试岗位继续处理",
    reason: "开发检查已经完成",
    capability: "testing",
    brief: "执行跨平台回归",
    evidence: ["unit-tests:passed"],
    ...overrides,
  };
}

function askUserIntent() {
  return {
    schemaVersion: 1,
    type: "ask_user",
    summary: "需要用户确认验收口径",
    reason: "当前事实不足以替用户决定",
    question: "是否继续按当前验收口径推进？",
    choices: [
      { id: "yes", label: "继续", description: "保持当前口径" },
      { id: "no", label: "停止", description: "退回重新梳理" },
    ],
  };
}

function waitIntent(condition) {
  return {
    schemaVersion: 1,
    type: "wait_condition",
    summary: "等待外部事实",
    reason: "事实满足后再重新判断",
    condition,
    checkAfterSeconds: 60,
  };
}

test("stageIntent persists a complete policy-safe intent before dispatch is claimable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBeforeStage = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        ...reviewIntent(),
        dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
      },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBeforeStage);

  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(fixture.store.writes.length, writesBeforeStage + 1);
  assert.equal(staged.item.status, "dispatch_pending");
  assert.equal(staged.item.leaseId, null);
  assert.equal(staged.outbox.status, "pending");
  assert.match(staged.outbox.intentId, /^work-intent-[a-f0-9]{64}$/);
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "pr-reviewer",
    workerId: "employee-pr-reviewer",
  });
  assert.deepEqual(staged.outbox.intent, {
    ...reviewIntent(),
    dispatchIntentId: staged.outbox.intent.dispatchIntentId,
  });
  assert.match(
    staged.outbox.intent.dispatchIntentId,
    /^work-dispatch-intent-[a-f0-9]{64}$/,
  );
  assert.equal(staged.deliverySemantics, "at-least-once-idempotent");
  assert.equal(fixture.store.stored().outbox.length, 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 20 })).items.at(-1).type,
    "intent_staged",
  );

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: staged.item.itemId,
      expectedRevision: staged.item.revision,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: {
        schemaVersion: 1,
        type: "propose_code_action",
        summary: "unsafe",
        reason: "unsafe",
        operation: "modify",
        objective: "unsafe",
        acceptanceCriteria: ["unsafe"],
        evidence: [],
        command: "rm -rf /",
      },
    }),
    (error) => error.code === "WORK_INTENT_INVALID",
  );
});

test("stageIntent binds the active lease owner and target role with one orchestrator exception", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-impostor",
      roleId: "pr-reviewer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  await assert.rejects(
    fixture.service.stageIntent({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "developer",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  assert.equal(fixture.store.writes.length, writesBefore);

  const takeoverFixture = await createFixture({
    records: [assignment(1, { type: "person", id: "missing-owner" })],
  });
  await takeoverFixture.service.intake();
  let takeover = (await takeoverFixture.service.listItems()).items[0];
  takeover = await takeoverFixture.service.claim({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    workerId: "employee-orchestrator",
    leaseDurationMs: 30_000,
  });
  const askUser = {
    schemaVersion: 1,
    type: "ask_user",
    summary: "目标岗位缺失",
    reason: "需要用户决定安全路由",
    question: "由哪个岗位接手？",
    choices: [],
  };
  await assert.rejects(
    takeoverFixture.service.stageIntent({
      itemId: takeover.itemId,
      expectedRevision: takeover.revision,
      leaseId: takeover.leaseId,
      actorId: "employee-orchestrator",
      roleId: "orchestrator",
      intent: reviewIntent(),
    }),
    (error) => error.code === "WORK_LEDGER_REQUESTER_IDENTITY_CONFLICT",
  );
  const staged = await takeoverFixture.service.stageIntent({
    itemId: takeover.itemId,
    expectedRevision: takeover.revision,
    leaseId: takeover.leaseId,
    actorId: "employee-orchestrator",
    roleId: "orchestrator",
    intent: askUser,
  });
  assert.deepEqual(staged.outbox.requestedBy, {
    roleId: "orchestrator",
    workerId: "employee-orchestrator",
  });
});

test("newest ledger query order paginates inside the selected order", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2), assignment(3)],
  });
  await fixture.service.intake();

  const first = await fixture.service.listItems({ order: "newest", limit: 2 });
  const second = await fixture.service.listItems({
    order: "newest",
    limit: 2,
    cursor: first.nextCursor,
  });
  const timeline = await fixture.service.listTimeline({
    order: "newest",
    limit: 2,
  });

  assert.deepEqual(first.items.map(({ sourceSequence }) => sourceSequence), [3, 2]);
  assert.deepEqual(second.items.map(({ sourceSequence }) => sourceSequence), [1]);
  assert.equal(timeline.items[0].type, "intake_completed");
  await assert.rejects(
    fixture.service.listItems({ order: "sideways" }),
    (error) => error.code === "WORK_LEDGER_QUERY_INVALID",
  );
});

test("recovery rejects requestedBy tampering because identity is part of the intent digest", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].requestedBy.workerId = "employee-impostor";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("outbox dispatch uses expiring leases and acknowledgement fences stale workers", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  const first = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 1_000,
  });
  assert.equal(first.status, "dispatching");
  assert.equal(first.dispatchLeaseId, "lease-0002");
  assert.equal(first.attempt, 1);
  assert.equal(first.deliverySemantics, "at-least-once-idempotent");

  await assert.rejects(
    fixture.service.claimIntent({
      intentId: first.intentId,
      expectedRevision: first.revision,
      dispatcherId: "another-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_ACTIVE",
  );
  fixture.time.advance(1_000);
  const recovered = await fixture.service.claimIntent({
    intentId: first.intentId,
    expectedRevision: first.revision,
    dispatcherId: "recovery-dispatcher",
    leaseDurationMs: 2_000,
  });
  assert.equal(recovered.dispatchLeaseId, "lease-0003");
  assert.equal(recovered.attempt, 2);

  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: first.revision,
      dispatchLeaseId: recovered.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_REVISION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      intentId: recovered.intentId,
      expectedRevision: recovered.revision,
      dispatchLeaseId: first.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "recovery-dispatcher",
      details: { downstreamRef: "confirmation-1" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_CONFLICT",
  );

  const acknowledged = await fixture.service.ackIntent({
    intentId: recovered.intentId,
    expectedRevision: recovered.revision,
    dispatchLeaseId: recovered.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "recovery-dispatcher",
    details: { downstreamRef: "confirmation-1" },
  });

  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.outbox.dispatchLeaseId, null);
  assert.equal(acknowledged.item.status, "waiting_external");
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_acknowledged",
  );
});

test("intent policy binding is durable, idempotent, and fenced by its live lease", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture, 1_000);
  const boundIntent = boundReviewIntent(staged.item);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent,
  };
  const writesBeforeBinding = fixture.store.writes.length;

  const sealed = await fixture.service.bindIntent(input);

  assert.equal(sealed.revision, claimed.revision + 1);
  assert.deepEqual(sealed.dispatchBinding.boundIntent, boundIntent);
  assert.match(sealed.dispatchBinding.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);
  assert.equal(
    (await fixture.service.listTimeline({ limit: 50 })).items.at(-1).type,
    "intent_bound",
  );

  const replay = await fixture.service.bindIntent(input);
  assert.deepEqual(replay.dispatchBinding, sealed.dispatchBinding);
  assert.equal(fixture.store.writes.length, writesBeforeBinding + 1);

  fixture.time.advance(1_000);
  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_INTENT_LEASE_EXPIRED",
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    sealed.dispatchBinding,
  );
});

test("a failed binding write leaves the claimed intent exactly retryable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const input = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  };
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.bindIntent(input),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);

  const retried = await fixture.service.bindIntent(input);
  assert.deepEqual(retried.dispatchBinding.boundIntent, input.boundIntent);
});

test("intent binding rejects stale items and semantically changed plans without writing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const base = {
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
  };
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.bindIntent({
      ...base,
      itemExpectedRevision: staged.item.revision + 1,
      boundIntent: boundReviewIntent(staged.item),
    }),
    (error) => error.code === "WORK_LEDGER_REVISION_CONFLICT",
  );
  const changedSource = boundReviewIntent(staged.item, {
    source: {
      assignmentId: "workflow-assignment-forged",
      eventId: staged.item.event.eventId,
    },
  });
  await assert.rejects(
    fixture.service.bindIntent({ ...base, boundIntent: changedSource }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listOutbox()).items[0].dispatchBinding, null);
});

test("recovery rejects a tampered durable intent binding", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].dispatchBinding.boundIntent.payload.body = "篡改后的动作";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema v7 quarantines an in-flight intent whose old policy binding is unknowable", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await prepareClaimedReviewIntent(fixture, 1_000);
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 7;
  for (const entry of legacy.outbox) delete entry.brainRecovery;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
  }
  for (const entry of legacy.outbox) {
    delete entry.dispatchBinding;
    delete entry.sourceBinding;
  }
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();
  assert.deepEqual(
    (await recovered.listOutbox()).items[0].dispatchBinding,
    { status: "legacy_unknown" },
  );
  const quarantined = (await recovered.listOutbox()).items[0];
  const writesBeforeClaim = fixture.store.writes.length;
  await assert.rejects(
    recovered.claimIntent({
      intentId: quarantined.intentId,
      expectedRevision: quarantined.revision,
      dispatcherId: "recovery-dispatcher",
      leaseDurationMs: 1_000,
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
  );
  assert.equal(fixture.store.writes.length, writesBeforeClaim);
  assert.equal(fixture.store.stored().schemaVersion, 7);
});

test("schema v9 quarantines a sealed PR proposal without an input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } = await prepareClaimedPullRequestReviewIntent(
    fixture,
    1_000,
  );
  const legacyBinding = pullRequestReviewProposalBinding(staged.item);
  delete legacyBinding.inputBinding;
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestReviewIntent(staged.item, legacyBinding),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  for (const entry of legacy.outbox) delete entry.brainRecovery;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const quarantined = (await recovered.listOutbox()).items[0];
  assert.deepEqual(quarantined.dispatchBinding, { status: "legacy_unknown" });
  const writesBeforeClaims = fixture.store.writes.length;
  for (const dispatcherId of ["recovery-dispatcher-1", "recovery-dispatcher-2"]) {
    await assert.rejects(
      recovered.claimIntent({
        intentId: quarantined.intentId,
        expectedRevision: quarantined.revision,
        dispatcherId,
        leaseDurationMs: 1_000,
      }),
      (error) => error.code === "WORK_LEDGER_INTENT_BINDING_UNKNOWN",
    );
  }
  assert.equal(fixture.store.writes.length, writesBeforeClaims);
});

test("schema v9 also quarantines a sealed PR external action without input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } =
    await prepareClaimedPullRequestExternalActionIntent(fixture, 1_000);
  const legacyBinding = pullRequestReviewProposalBinding(staged.item);
  delete legacyBinding.inputBinding;
  await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestExternalActionIntent(
      staged.item,
      legacyBinding,
    ),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  for (const entry of legacy.outbox) delete entry.brainRecovery;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const quarantined = (await recovered.listOutbox()).items[0];
  assert.deepEqual(quarantined.dispatchBinding, { status: "legacy_unknown" });
});

test("schema v9 preserves a sealed PR proposal with an input binding", async () => {
  const fixture = await createFixture({ records: [prAssignment(1)] });
  const { staged, claimed } = await prepareClaimedPullRequestReviewIntent(
    fixture,
  );
  const sealed = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: claimed.dispatcherId,
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundPullRequestReviewIntent(
      staged.item,
      pullRequestReviewProposalBinding(staged.item),
    ),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 9;
  for (const entry of legacy.outbox) delete entry.brainRecovery;
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  const migrated = (await recovered.listOutbox()).items[0];
  assert.deepEqual(migrated.dispatchBinding, sealed.dispatchBinding);
  assert.deepEqual(
    migrated.dispatchBinding.boundIntent.binding.inputBinding,
    prExecutionBinding(staged.item),
  );
});

test("a delivered handoff atomically acknowledges the outbox and queues the trusted role", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const writesBeforeAck = fixture.store.writes.length;

  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    target: { type: "role", id: "tester" },
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  });

  assert.equal(fixture.store.writes.length, writesBeforeAck + 1);
  assert.equal(acknowledged.outbox.status, "delivered");
  assert.equal(acknowledged.item.status, "queued");
  assert.deepEqual(acknowledged.item.currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal(acknowledged.item.assignment.target.id, "pr-reviewer");
  assert.deepEqual(
    (await fixture.service.listTimeline({ limit: 50 })).items
      .slice(-2)
      .map(({ type }) => type),
    ["intent_acknowledged", "handed_off"],
  );

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listItems()).items[0].currentTarget, {
    type: "role",
    id: "tester",
  });
  assert.equal((await recovered.listOutbox()).items[0].status, "delivered");
});

test("handoff acknowledgement is exact, role-only, and retryable after a failed atomic write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: handoffIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "queued",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: `bound-${dispatch.intentId}` },
  };

  await assert.rejects(
    fixture.service.ackIntent(base),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "person", id: "someone" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  fixture.store.failNextWrite();
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listOutbox()).items[0].status, "dispatching");
  assert.equal((await fixture.service.listItems()).items[0].status, "dispatch_pending");

  const retried = await fixture.service.ackIntent({
    ...base,
    target: { type: "role", id: "tester" },
  });
  assert.equal(retried.outbox.status, "delivered");
  assert.equal(retried.item.status, "queued");
});

test("non-handoff intents cannot use queued acknowledgement or inject a target", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const base = {
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    actorId: "work-intent-dispatcher",
    details: { downstreamRef: "bound-review" },
  };

  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "queued",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
  await assert.rejects(
    fixture.service.ackIntent({
      ...base,
      nextStatus: "waiting_external",
      target: { type: "role", id: "tester" },
    }),
    (error) => error.code === "WORK_LEDGER_INTENT_ACK_INVALID",
  );
});

test("the real assignment-feed gap error becomes a blocked alert", async () => {
  const source = new FakeAssignmentSource();
  let oldestAvailableSequence = 5;
  let highWatermark = 8;
  source.override = ({ afterSequence }) => {
    throw Object.assign(new Error("retention gap"), {
      code: "WORKFLOW_ASSIGNMENT_GAP",
      statusCode: 409,
      details: Object.freeze({
        afterSequence,
        expectedSequence: afterSequence + 1,
        oldestAvailableSequence,
        highWatermark,
      }),
    });
  };
  const { service } = await createFixture({ source });

  const result = await service.intake();

  assert.deepEqual(result.gap, {
    expectedSequence: 1,
    actualSequence: 5,
    highWatermark: 8,
    reason: "source_retention",
  });
  assert.equal(result.cursor, 0);
  assert.equal((await service.getSummary()).sourceHighWatermark, 8);
  assert.equal((await service.listItems()).items[0].status, "blocked");

  oldestAvailableSequence = 6;
  highWatermark = 9;
  await service.intake();
  assert.equal((await service.listItems()).items.length, 1);
  assert.equal((await service.getSummary()).sourceHighWatermark, 9);
});

test("a reused assignmentId with different input blocks cursor advancement", async () => {
  const source = new FakeAssignmentSource([assignment(1)]);
  const { service } = await createFixture({ source });
  await service.intake({ limit: 1 });
  const conflicting = assignment(2);
  conflicting.assignment.assignmentId = "workflow-assignment-1";
  source.records.push(conflicting);
  source.highWatermark = 2;

  await assert.rejects(
    service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_ASSIGNMENT_CONFLICT",
  );

  assert.equal((await service.getSummary()).intakeCursor, 1);
  assert.equal((await service.listItems()).items.length, 1);
});

test("recovery restores work, timeline, and outbox and rejects input tampering", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const before = {
    summary: await fixture.service.getSummary(),
    items: await fixture.service.listItems(),
    timeline: await fixture.service.listTimeline(),
    outbox: await fixture.service.listOutbox(),
  };
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();

  assert.deepEqual(await recovered.getSummary(), before.summary);
  assert.deepEqual(await recovered.listItems(), before.items);
  assert.deepEqual(await recovered.listTimeline(), before.timeline);
  assert.deepEqual(await recovered.listOutbox(), before.outbox);

  const tampered = fixture.store.stored();
  tampered.items[0].event.payload.title = "tampered";
  fixture.store.replaceStored(tampered);
  const rejected = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await assert.rejects(
    rejected.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery revalidates the complete work-intent DTO", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox[0].intent.command = "git push --force";
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("recovery rejects dispatch-pending work without exactly one active outbox", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const tampered = fixture.store.stored();
  tampered.outbox = [];
  fixture.store.replaceStored(tampered);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a failed intent can be restaged with the same idempotency key", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  let staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const dispatchIntentId = staged.outbox.intent.dispatchIntentId;
  let dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "confirmation-bridge",
    leaseDurationMs: 30_000,
  });
  dispatch = await fixture.service.bindIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "confirmation-bridge",
    dispatchLeaseId: dispatch.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  const failed = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "confirmation-bridge",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);
  item = await fixture.service.claim({
    itemId: failed.item.itemId,
    expectedRevision: failed.item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.equal(staged.outbox.intentId, dispatch.intentId);
  assert.equal(staged.outbox.intent.dispatchIntentId, dispatchIntentId);
  assert.equal(staged.outbox.status, "pending");
  assert.equal(staged.outbox.dispatchBinding, null);
  assert.equal(staged.outbox.attempt, 1);
  assert.equal((await fixture.service.listOutbox()).items.length, 1);
  assert.equal(
    (await fixture.service.listOutbox({ status: "pending" })).items.length,
    1,
  );
  const types = (await fixture.service.listTimeline({ limit: 50 })).items.map(
    ({ type }) => type,
  );
  assert.equal(types.includes("retry_scheduled"), true);
});

for (const variant of ["new business", "legacy business", "legacy recovery"]) {
test(`failed question retry preserves recovery origin (${variant})`, async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const intent = variant === "legacy recovery"
    ? systemMaintenanceIntent("pr-reviewer", "STRUCTURED_PROVIDER_MODEL_CAPACITY")
    : askUserIntent();
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-pr-reviewer", leaseDurationMs: 30_000 });
  const staged = await fixture.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision,
    leaseId: item.leaseId, actorId: item.ownerId, roleId: "pr-reviewer", intent });
  const dispatch = await fixture.service.claimIntent({ intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision, dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    outcome: "failed", nextStatus: "retry_wait", availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "work-intent-dispatcher", details: { code: "attention-temporarily-unavailable" } });
  if (variant.startsWith("legacy")) {
    const stored = fixture.store.stored();
    delete stored.outbox[0].brainRecovery;
    fixture.store.replaceStored(stored);
  }
  fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
  fixture.time.advance(60_000);
  item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-pr-reviewer", leaseDurationMs: 30_000 });
  const retry = () => fixture.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision,
    leaseId: item.leaseId, actorId: item.ownerId, roleId: "pr-reviewer", intent });
  if (variant === "legacy recovery") {
    await assert.rejects(retry(), { code: "WORK_LEDGER_INTENT_CONFLICT" });
    assert.equal(Object.hasOwn(fixture.store.stored().outbox[0], "brainRecovery"), false);
  } else {
    const restaged = await retry();
    assert.equal(restaged.outbox.intentId, dispatch.intentId);
    assert.equal(restaged.outbox.status, "pending");
    assert.equal(Object.hasOwn(restaged.outbox, "brainRecovery"), variant === "new business");
  }
});
}

for (const legacy of [false, true]) {
for (const recovery of [false, true]) {
test(`graph escalation preserves failed intent origin (legacy=${legacy}, recovery=${recovery})`, async () => {
  const record = ownerRequestedPrAssignment(1);
  record.assignment.target = { type: "role", id: "orchestrator" };
  const fixture = await createFixture({ records: [record] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 30_000 });
  const code = "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED";
  const intent = recovery ? createBrainRecoveryIntent(code, systemMaintenanceIntent("orchestrator", code)) : askUserIntent();
  const staged = await fixture.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision,
    leaseId: item.leaseId, actorId: item.ownerId, roleId: "orchestrator", intent });
  const dispatch = await fixture.service.claimIntent({ intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision, dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  await fixture.service.ackIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId, itemExpectedRevision: staged.item.revision,
    outcome: "failed", nextStatus: "blocked", actorId: "work-intent-dispatcher", details: { code: "attention-conflict" } });
  if (legacy) {
    const stored = fixture.store.stored();
    delete stored.outbox[0].brainRecovery;
    fixture.store.replaceStored(stored);
  }
  fixture.service = (await createFixture({ source: fixture.source, store: fixture.store, time: fixture.time })).service;
  item = (await fixture.service.listItems()).items[0];
  const plain = clone(intent);
  const input = { authority: { actorId: "employee-orchestrator", scopeRootTaskId: item.itemId }, command: {
    taskId: item.itemId, expectedTaskRevision: item.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    summary: plain.summary, reason: plain.reason, question: plain.question, choices: plain.choices,
  } };
  if (recovery) {
    const before = fixture.store.stored();
    await assert.rejects(fixture.service.stageGraphEscalation(input), { code: "WORK_LEDGER_INTENT_CONFLICT" });
    assert.deepEqual(fixture.store.stored(), before);
  } else {
    const restaged = await fixture.service.stageGraphEscalation(input);
    assert.equal(restaged.outbox.intentId, staged.outbox.intentId);
    assert.equal(restaged.outbox.status, "pending");
    assert.equal(Object.hasOwn(restaged.outbox, "brainRecovery"), !legacy);
  }
});
}
}

test("capacity rejection leaves the next assignment and cursor retryable", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
    limits: { itemLimit: 1 },
  });
  await fixture.service.intake({ limit: 1 });

  await assert.rejects(
    fixture.service.intake({ limit: 1 }),
    (error) => error.code === "WORK_LEDGER_CAPACITY_EXCEEDED",
  );

  assert.equal((await fixture.service.getSummary()).intakeCursor, 1);
  assert.equal((await fixture.service.listItems()).items.length, 1);
  assert.equal(fixture.store.stored().intakeCursor, 1);
  assert.deepEqual(
    fixture.source.calls.map(({ afterSequence }) => afterSequence),
    [0, 1],
  );
});

function legacyLedgerCapacityBytes(state) {
  const { graphMemoryProjection: _projection, ...view } = state;
  view.schemaVersion = 1;
  view.items = state.items.filter(item => item.kind !== 'source_root').map(item => {
    const { graph: _graph, ...value } = item;
    if (value.source === null) delete value.source;
    if (value.sourceQuarantine === null) delete value.sourceQuarantine;
    return value;
  });
  return Buffer.byteLength(`${JSON.stringify(view, null, 2)}\n`);
}

for (const [name, factory] of [['local', createLocalWorkLedgerCandidateProcessor], ['worker', createWorkerWorkLedgerCandidateProcessor]]) {
  test(`${name} byte retention lets claims and Review publication receipts advance before the timeline count limit`, async t => {
    const seed = await createFixture({ records: [assignment(1)] });
    await seed.service.intake();
    const old = seed.store.stored();
    const history = appendWorkLedgerTimeline(old, Array.from({ length: 12 }, () => ({
      itemId: null, type: 'intake_completed', at: seed.time.clock(), actorId: 'work-ledger-system',
      details: { note: '历史记录'.repeat(300) },
    })), 20_000);
    const previous = { ...old, timeline: history.timeline, timelineStartSequence: history.timelineStartSequence,
      nextTimelineSequence: history.nextTimelineSequence };
    seed.store.replaceStored(previous);
    const limits = { stateByteBudget: legacyLedgerCapacityBytes(previous) + 20 };
    const processor = factory();
    t.after(() => processor.close());
    const fixture = await createFixture({ store: seed.store, source: seed.source, time: seed.time, limits, candidateProcessor: processor });
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: 'employee-pr-reviewer', leaseDurationMs: 30_000 });
    const claimed = fixture.store.stored();
    assert.ok(claimed.timeline.length < previous.timeline.length);
    assert.equal(claimed.timeline.at(-1).type, 'claimed');
    assert.equal(claimed.timeline.at(-1).sequence, previous.nextTimelineSequence);
    assert.deepEqual(claimed.items[0].graph, previous.items[0].graph);
    assert.deepEqual(claimed.outbox, previous.outbox);
    const staged = await fixture.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision,
      leaseId: item.leaseId, actorId: 'employee-pr-reviewer', roleId: 'pr-reviewer', intent: reviewIntent() });
    let dispatch = await fixture.service.claimIntent({ intentId: staged.outbox.intentId,
      expectedRevision: staged.outbox.revision, dispatcherId: 'confirmation-bridge', leaseDurationMs: 30_000 });
    dispatch = await fixture.service.bindIntent({ intentId: dispatch.intentId, expectedRevision: dispatch.revision,
      itemExpectedRevision: staged.item.revision, dispatcherId: 'confirmation-bridge',
      dispatchLeaseId: dispatch.dispatchLeaseId, boundIntent: boundReviewIntent(staged.item) });
    const delivered = await fixture.service.ackIntent({ intentId: dispatch.intentId,
      expectedRevision: dispatch.revision, dispatchLeaseId: dispatch.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision, actorId: 'confirmation-bridge',
      outcome: 'delivered', nextStatus: 'waiting_external', details: { downstreamRef: 'existing-review-proposal' } });
    assert.equal(delivered.outbox.status, 'delivered');
    const durable = fixture.store.stored();
    assert.ok(legacyLedgerCapacityBytes(durable) <= limits.stateByteBudget);
    assert.deepEqual(durable.timeline.map(e => e.sequence), Array.from({ length: durable.timeline.length }, (_, i) => durable.timelineStartSequence + i));
    const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time, limits });
    assert.deepEqual((await restarted.service.listTimeline({ limit: 100 })).items, durable.timeline);
    assert.deepEqual((await restarted.service.listOutbox()).items, durable.outbox);
  });
}

test('byte retention keeps all new receipts even when old history cannot free enough space', () => {
  const previous = emptyWorkLedgerState();
  const history = appendWorkLedgerTimeline(previous, [{ type: 'intake_completed',
    at: '2026-08-02T01:00:00.000Z', details: { note: 'old' } }], 20_000);
  Object.assign(previous, { timeline: history.timeline, timelineStartSequence: history.timelineStartSequence,
    nextTimelineSequence: history.nextTimelineSequence });
  const added = appendWorkLedgerTimeline(previous, [{ type: 'intake_completed',
    at: '2026-08-02T01:01:00.000Z', details: { note: 'new receipt'.repeat(500) } }], 20_000);
  const candidate = { ...previous, revision: 1, timeline: added.timeline,
    timelineStartSequence: added.timelineStartSequence, nextTimelineSequence: added.nextTimelineSequence };
  const before = clone(candidate);
  assert.throws(() => prepareWorkLedgerCandidate({ previousState: previous, candidate,
    limits: normalizeWorkLedgerLimits({ stateByteBudget: legacyLedgerCapacityBytes(previous) + 20 }) }),
  error => error.code === 'WORK_LEDGER_CAPACITY_EXCEEDED');
  assert.deepEqual(candidate, before);
});

test('byte retention accepts the hard budget when new receipts prevent reaching its optional reserve', () => {
  const previous = emptyWorkLedgerState();
  const history = appendWorkLedgerTimeline(previous, [{ type: 'intake_completed',
    at: '2026-08-02T01:00:00.000Z', details: { note: 'old'.repeat(100) } }], 20_000);
  Object.assign(previous, { timeline: history.timeline, timelineStartSequence: history.timelineStartSequence,
    nextTimelineSequence: history.nextTimelineSequence });
  const added = appendWorkLedgerTimeline(previous, [{ type: 'intake_completed',
    at: '2026-08-02T01:01:00.000Z', details: { note: 'new receipt'.repeat(200) } }], 20_000);
  const candidate = { ...previous, revision: 1, timeline: added.timeline,
    timelineStartSequence: added.timelineStartSequence, nextTimelineSequence: added.nextTimelineSequence };
  const suffix = { ...candidate, timeline: added.appended, timelineStartSequence: added.appended[0].sequence };
  const limit = legacyLedgerCapacityBytes(suffix) + 20;
  const result = prepareWorkLedgerCandidate({ previousState: previous, candidate,
    limits: normalizeWorkLedgerLimits({ stateByteBudget: limit }) });
  assert.deepEqual(result.timeline, added.appended);
  assert.ok(legacyLedgerCapacityBytes(result) <= limit);
  assert.ok(legacyLedgerCapacityBytes(result) > limit * 0.9);
});

test('byte retention cannot hide a modified historical receipt before validation', () => {
  const previous = emptyWorkLedgerState();
  const history = appendWorkLedgerTimeline(previous, [{ type: 'intake_completed',
    at: '2026-08-02T01:00:00.000Z', details: { note: 'old'.repeat(500) } }], 20_000);
  Object.assign(previous, { timeline: history.timeline, timelineStartSequence: history.timelineStartSequence,
    nextTimelineSequence: history.nextTimelineSequence });
  const candidate = clone({ ...previous, revision: 1 });
  candidate.timeline[0].details.note += 'altered';
  assert.throws(() => prepareWorkLedgerCandidate({ previousState: previous, candidate,
    limits: normalizeWorkLedgerLimits({ stateByteBudget: legacyLedgerCapacityBytes(previous) }) }));
  assert.equal(previous.timeline[0].details.note, 'old'.repeat(500));
});

test("timeline retention remains contiguous and recoverable", async () => {
  const fixture = await createFixture({
    records: [assignment(1)],
    limits: { timelineLimit: 3 },
  });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  const summary = await fixture.service.getSummary();
  const timeline = (await fixture.service.listTimeline()).items;
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.map(({ sequence }) => sequence), [2, 3, 4]);
  assert.equal(summary.timelineStartSequence, 2);
  assert.equal(summary.nextTimelineSequence, 5);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { timelineLimit: 3 },
  });
  await recovered.recover();
  assert.deepEqual((await recovered.listTimeline()).items, timeline);
});

test("services sharing an exclusive lease re-read durable state before writes", async () => {
  const store = new MemoryStore();
  const source = new FakeAssignmentSource([assignment(1)]);
  const lease = new ExclusiveLease();
  const time = controlledClock();
  const first = await createFixture({ store, source, lease, time });
  const second = await createFixture({ store, source, lease, time });
  await first.service.intake();
  const queued = (await first.service.listItems()).items[0];

  const claimed = await second.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-second-process",
    leaseDurationMs: 30_000,
  });
  const waiting = await first.service.transition({
    itemId: claimed.itemId,
    expectedRevision: claimed.revision,
    leaseId: claimed.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-second-process",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });

  assert.equal(waiting.status, "waiting_condition");
  assert.equal(store.stored().items.length, 1);
  assert.equal(store.stored().items[0].revision, waiting.revision);
});

test("durable revision rollback and same-revision forks fail closed", async (t) => {
  await t.test("rollback", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const rolledBack = fixture.store.stored();
    let item = (await fixture.service.listItems()).items[0];
    item = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    fixture.store.replaceStored(rolledBack);

    await assert.rejects(
      fixture.service.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        toStatus: "waiting_condition",
        actorId: "employee-pr-reviewer",
        reason: "await-ci",
        details: { conditionRef: "ci:pr-1" },
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("fork", async () => {
    const fixture = await createFixture({ records: [assignment(1)] });
    await fixture.service.intake();
    const item = (await fixture.service.listItems()).items[0];
    const fork = fixture.store.stored();
    fork.items[0].statusReason = "valid-but-forked";
    fixture.store.replaceStored(fork);

    await assert.rejects(
      fixture.service.claim({
        itemId: item.itemId,
        expectedRevision: item.revision,
        workerId: "employee-pr-reviewer",
        leaseDurationMs: 30_000,
      }),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });
});

test("a failed transition write preserves the active lease for exact retry", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  fixture.store.failNextWrite();

  await assert.rejects(
    fixture.service.transition({
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "await-ci",
      details: { conditionRef: "ci:pr-1" },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  assert.equal((await fixture.service.listItems()).items[0].status, "working");
  const retried = await fixture.service.transition({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    toStatus: "waiting_condition",
    actorId: "employee-pr-reviewer",
    reason: "await-ci",
    details: { conditionRef: "ci:pr-1" },
  });
  assert.equal(retried.status, "waiting_condition");
});

test("transition details reject untrusted command-like fields", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const item = (await fixture.service.listItems()).items[0];
  const working = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    fixture.service.transition({
      itemId: working.itemId,
      expectedRevision: working.revision,
      leaseId: working.leaseId,
      toStatus: "waiting_condition",
      actorId: "employee-pr-reviewer",
      reason: "unsafe",
      details: { command: "git push" },
    }),
    (error) => error.code === "WORK_LEDGER_DETAILS_INVALID",
  );
});

async function prepareAttentionResult(
  fixture,
  answer,
  {
    workerId = "employee-pr-reviewer",
    roleId = "pr-reviewer",
    intent = askUserIntent(),
    legacyRecovery = false,
  } = {},
) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: workerId,
    roleId,
    intent,
  });
  const request = normalizeAttentionRequest({
    requestKey: staged.outbox.intentId,
    type: "ask_user",
    producer: {
      roleId,
      workItemId: item.itemId,
    },
    question: intent.question,
    context: [],
    choices: intent.choices,
  });
  const attentionItem = createAttentionItem(
    request,
    1,
    "2026-08-02T01:59:00.000Z",
  );
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_user",
    actorId: "work-intent-dispatcher",
    details: {
      questionRef: attentionItem.requestId,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  if (legacyRecovery) {
    const historical = fixture.store.stored();
    delete historical.outbox.find(entry => entry.intentId === staged.outbox.intentId).brainRecovery;
    fixture.store.replaceStored(historical);
    fixture.service = (await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time })).service;
  }
  return resolveAttentionItem(
    attentionItem,
    answer,
    2,
    "2026-08-02T02:00:00.000Z",
    1,
  ).outbox;
}

function systemMaintenanceIntent(roleId, code = "STRUCTURED_PROVIDER_MODEL_CAPACITY") {
  const summaries = {
    STRUCTURED_PROVIDER_MODEL_CAPACITY: "所选模型暂时满载",
    STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED: "岗位 CLI 会话进度未能安全归档",
    STRUCTURED_PROVIDER_CLEANUP_FAILED: "岗位任务大脑的隔离运行环境未能安全清理",
    STRUCTURED_PROVIDER_REAP_FAILED: "岗位任务大脑的受监督 CLI 进程未能安全结束",
  };
  return {
    schemaVersion: 1, type: "ask_user",
    summary: `${summaries[code]}（${roleId}）`,
    reason: `真实任务不得回退到例行大脑；系统已安全停止（${code}）`,
    question: "保留会话历史，修复后重试",
    choices: [{ id: "configured-retry", label: "修复后重试", description: "重新排队" }],
  };
}

test("U3 new model questions copying historical recovery text cannot refund or automatically retry", async () => {
  for (const code of ["STRUCTURED_PROVIDER_MODEL_CAPACITY", "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED"]) {
    const fixture = await createFixture({ records: [assignment(1)] });
    const answer = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
      intent: systemMaintenanceIntent("pr-reviewer", code),
    });
    const waiting = (await fixture.service.listItems()).items[0];
    assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10,
      requestKeys: [waiting.activeIntentId] })).retried, 0);
    await fixture.service.applyAttentionBatch({ items: [answer], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
    const resumed = (await fixture.service.listItems()).items[0];
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.attempt, waiting.attempt);
  }
});

test("U3 host recovery identity survives independent wording and restart with original PR input", async () => {
  for (const code of ["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_REAP_FAILED"]) {
    const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
    const intent = createBrainRecoveryIntent(code, { schemaVersion: 1, type: "ask_user",
      summary: "Updated summary", reason: "Updated explanation", question: "Updated repair question",
      choices: [{ id: "configured-retry", label: "Try again", description: "Updated help" }] });
    const answer = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
      workerId: "employee-pr-engineer", roleId: "pr-engineer", intent,
    });
    const waiting = (await fixture.service.listItems()).items[0];
    const before = fixture.store.stored().outbox[0];
    assert.equal(before.brainRecovery.code, code);
    assert.equal(before.brainRecovery.intentId, before.intentId);
    const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
    assert.equal((await restarted.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [waiting.activeIntentId] })).retried, 0);
    await restarted.service.applyAttentionBatch({ items: [answer], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
    const resumed = (await restarted.service.listItems()).items[0];
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.attempt, waiting.attempt - 1);
    assert.equal(resumed.inputDigest, waiting.inputDigest);
    assert.deepEqual(resumed.source, waiting.source);
    assert.deepEqual(restarted.store.stored().outbox[0].brainRecovery, before.brainRecovery);
  }
});

test("U3 serialized host intent loses recovery authority and rejects copied recovery fields", async () => {
  const code = "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED";
  const original = createBrainRecoveryIntent(code, systemMaintenanceIntent("pr-reviewer", code));
  const fixture = await createFixture({ records: [assignment(1)] });
  const answer = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
    intent: JSON.parse(JSON.stringify(original)),
  });
  const waiting = (await fixture.service.listItems()).items[0];
  assert.equal(fixture.store.stored().outbox[0].brainRecovery, null);
  await fixture.service.applyAttentionBatch({ items: [answer], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.equal((await fixture.service.listItems()).items[0].attempt, waiting.attempt);
  for (const extra of [{ recoveryCode: code }, { brainRecovery: { schemaVersion: 1, code } }]) {
    const forged = await createFixture({ records: [assignment(1)] });
    await assert.rejects(prepareAttentionResult(forged, { type: "choice", choiceId: "configured-retry" }, {
      intent: { ...JSON.parse(JSON.stringify(original)), ...extra },
    }), { code: "WORK_INTENT_INVALID" });
    assert.equal(forged.store.stored().outbox.length, 0);
  }
});

test("U3 stored recovery rejects malformed code and mismatched task input intent and source stamps", async () => {
  const code = "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED";
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer",
    intent: createBrainRecoveryIntent(code, systemMaintenanceIntent("pr-engineer", code)),
  });
  const valid = fixture.store.stored();
  for (const tamper of [
    stamp => { stamp.schemaVersion = 2; },
    stamp => { stamp.code = "UNKNOWN_FAILURE"; },
    stamp => { stamp.itemId = "other-task"; },
    stamp => { stamp.inputDigest = "f".repeat(64); },
    stamp => { stamp.intentId = `work-intent-${"f".repeat(64)}`; },
    stamp => { stamp.sourceBinding.headRefOid = PR_HEAD_B; },
    stamp => { stamp.extra = true; },
  ]) {
    const bad = clone(valid);
    const stamp = bad.outbox[0].brainRecovery;
    tamper(stamp);
    const { digest, ...core } = stamp;
    stamp.digest = ledgerDigest(core);
    assert.throws(() => normalizeWorkLedgerPersistedState(bad), { code: "WORK_LEDGER_STATE_CORRUPTED" });
  }
  for (const malformed of [false, "configured-retry", {}, { schemaVersion: 1, code }]) {
    const bad = clone(valid);
    bad.outbox[0].brainRecovery = malformed;
    assert.throws(() => normalizeWorkLedgerPersistedState(bad), { code: "WORK_LEDGER_STATE_CORRUPTED" });
  }
  const changedText = clone(valid);
  changedText.outbox[0].intent.reason = "Post-hoc change to sealed wording";
  assert.throws(() => normalizeWorkLedgerPersistedState(changedText), { code: "WORK_LEDGER_STATE_CORRUPTED" });
});

test("U3 real host failure stages a bound recovery capability", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const cycle = await decisionBudgetLoop(fixture, { assemble: async () => {
    throw Object.assign(new Error("Host session failed"), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  } }).runCycle();
  assert.equal(cycle.outcomes[0].status, "maintenance_required");
  const outbox = fixture.store.stored().outbox[0];
  assert.equal(outbox.brainRecovery.code, "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  assert.equal(outbox.brainRecovery.itemId, outbox.itemId);
  assert.equal(outbox.brainRecovery.inputDigest, outbox.inputDigest);
});

test("U3 real dispatcher projects recovery identity and owner answer preserves the sealed task", async () => {
  const f = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await f.service.intake();
  const queued = (await f.service.listItems()).items[0];
  const item = await f.service.claim({ itemId: queued.itemId, expectedRevision: queued.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  await f.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: item.ownerId, roleId: "pr-engineer", intent: createBrainRecoveryIntent("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", {
      schemaVersion: 1, type: "ask_user", summary: "Independent summary", reason: "Independent reason",
      question: "Independent question", choices: [{ id: "configured-retry", label: "Independent label", description: "Independent help" }],
    }) });
  const inboxStore = new MemoryStore();
  const inboxOptions = { store: inboxStore, exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock };
  const inbox = new AttentionInbox(inboxOptions);
  await inbox.recover();
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: createWorkIntentPolicy({ capabilityRoles: { "pr-review": "pr-engineer" } }),
    attentionProducer: inbox, proposalProducer: { async create() { assert.fail("No proposal expected"); } } });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  const waiting = (await f.service.listItems()).items[0];
  const originalOutbox = f.store.stored().outbox[0];
  assert.equal(inboxStore.stored("attention-inbox").items[0].recoveryCode, "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  const restartedInbox = new AttentionInbox(inboxOptions);
  await restartedInbox.recover();
  assert.equal(await restartedInbox.next(), null);
  const fault = (await restartedInbox.listMaintenance()).items[0];
  assert.equal(fault.maintenanceCode, "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  assert.equal(fault.question, "Independent question");
  f.time.advance(1_000);
  await restartedInbox.answer({ requestId: fault.requestId, expectedRevision: fault.revision,
    contentDigest: fault.contentDigest, answer: { type: "choice", choiceId: "configured-retry" } });
  const restarted = await createFixture({ store: f.store, source: f.source, time: f.time });
  await restarted.service.applyAttentionBatch(await restartedInbox.readOutbox());
  const resumed = (await restarted.service.listItems()).items[0];
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.attempt, waiting.attempt - 1);
  assert.deepEqual(resumed.source, waiting.source);
  const delivered = restarted.store.stored().outbox[0];
  assert.deepEqual(delivered.intent, originalOutbox.intent);
  assert.deepEqual(delivered.brainRecovery, originalOutbox.brainRecovery);
  assert.ok(delivered.outcome.details.resultAttestation);
});

test("session and process maintenance questions wait for explicit repair retry across restart", async () => {
  for (const code of ["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_REAP_FAILED"]) {
    const fixture = await createFixture({ records: [assignment(1)] });
    const answer = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
      intent: systemMaintenanceIntent("pr-reviewer", code), legacyRecovery: true,
    });
    const waiting = (await fixture.service.listItems()).items[0];
    const input = { limit: 10, requestKeys: [waiting.activeIntentId] };
    assert.equal((await fixture.service.retrySystemMaintenanceQuestions(input)).retried, 0);
    assert.equal((await fixture.service.listItems()).items[0].status, "waiting_user");
    const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
    assert.equal((await restarted.service.retrySystemMaintenanceQuestions(input)).retried, 0);
    await restarted.service.applyAttentionBatch({ items: [answer], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
    const resumed = (await restarted.service.listItems()).items[0];
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.inputDigest, waiting.inputDigest);
    assert.equal(resumed.activeIntentId, null);
    assert.equal(resumed.attempt, waiting.attempt - 1);
  }
});

test("an explicit session repair retry preserves the PR source and Head budget", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const answer = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer",
    intent: systemMaintenanceIntent("pr-engineer", "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED"), legacyRecovery: true,
  });
  const waiting = (await fixture.service.listItems()).items[0];
  await fixture.service.applyAttentionBatch({ items: [answer], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const resumed = (await fixture.service.listItems()).items[0];
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.attempt, waiting.attempt - 1);
  assert.deepEqual(resumed.source, waiting.source);
  const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  assert.equal((await restarted.service.listItems()).items[0].attempt, resumed.attempt);
});

test("system maintenance questions retry without an owner answer and discard a raced result", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const intent = systemMaintenanceIntent("pr-reviewer");
  const raced = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, { intent, legacyRecovery: true });
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = { requestKey: waiting.activeIntentId,
    producer: { roleId: "pr-reviewer", workItemId: waiting.itemId } };
  const delivered = structuredClone(fixture.store.stored().outbox[0]);
  assert.equal(Object.hasOwn(delivered, "brainRecovery"), false, "historical absence stays absent");
  assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) })).retried, 1);
  const retrying = (await fixture.service.listItems()).items[0];
  assert.equal(retrying.status, "retry_wait");
  assert.equal(retrying.activeIntentId, null);
  assert.equal(retrying.attempt, waiting.attempt - 1);
  assert.equal(retrying.decisionContext, waiting.decisionContext);
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), false);
  assert.deepEqual(await fixture.service.readAttentionRequestRetirement(authority), {
    status: "retry_wait", workItemRevision: retrying.revision, reason: "system_maintenance_auto_retry",
  });
  assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) })).retried, 0);
  assert.equal(fixture.store.stored().outbox[0].intentId, delivered.intentId);
  assert.deepEqual(fixture.store.stored().outbox[0].intent, delivered.intent);
  assert.equal(Object.hasOwn(fixture.store.stored().outbox[0], "brainRecovery"), false);
  assert.equal(fixture.store.stored().outbox[0].outcome.details.resultAttestation, undefined);
  await fixture.service.applyAttentionBatch({ items: [raced], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.equal((await fixture.service.getSummary()).attentionCursor, 1);
  assert.equal((await fixture.service.listItems()).items[0].status, "retry_wait");
  assert.equal(fixture.store.stored().timeline.at(-1).type, "stale_result_discarded");
  const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  assert.deepEqual(await restarted.service.readAttentionRequestRetirement(authority), {
    status: "retry_wait", workItemRevision: retrying.revision, reason: "system_maintenance_auto_retry",
  });
});

test("U3 legacy retirement proofs reject mismatched bindings and cannot retire a new model question", async () => {
  const historical = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const intent = systemMaintenanceIntent("pr-engineer");
  await prepareAttentionResult(historical, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer", intent, legacyRecovery: true,
  });
  const waiting = (await historical.service.listItems()).items[0];
  const authority = { requestKey: waiting.activeIntentId, producer: { roleId: "pr-engineer", workItemId: waiting.itemId } };
  assert.equal((await historical.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [waiting.activeIntentId] })).retried, 1);
  const valid = historical.store.stored();
  const proof = valid.outbox[0].outcome.details.maintenanceRetirement;
  assert.equal((await historical.service.readAttentionRequestRetirement(authority)).reason, "system_maintenance_auto_retry");
  for (const tamper of [
    value => { value.intentId = `work-intent-${"f".repeat(64)}`; },
    value => { value.questionRef = `attention-${"f".repeat(64)}`; },
    value => { value.inputBinding.headRefOid = PR_HEAD_B; },
    value => { value.code = "UNKNOWN_FAILURE"; },
  ]) {
    const bad = clone(valid);
    const value = bad.outbox[0].outcome.details.maintenanceRetirement;
    tamper(value);
    const { digest, ...core } = value;
    value.digest = ledgerDigest(core);
    const store = new MemoryStore();
    store.replaceStored(bad);
    const restarted = await createFixture({ store, source: historical.source, time: historical.time });
    assert.equal(await restarted.service.readAttentionRequestRetirement(authority), null);
  }
  const model = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await prepareAttentionResult(model, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer", intent: JSON.parse(JSON.stringify(intent)),
  });
  const copied = model.store.stored();
  copied.outbox[0].outcome.details.maintenanceRetirement = clone(proof);
  model.store.replaceStored(copied);
  const restarted = await createFixture({ store: model.store, source: model.source, time: model.time });
  assert.equal(await restarted.service.readAttentionRequestRetirement(authority), null);
  assert.equal((await restarted.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [waiting.activeIntentId] })).retried, 0);
  assert.equal((await restarted.service.listItems()).items[0].status, "waiting_user");
});

test("automatic maintenance settles an old PR question through cross-root pending Head activation and restart", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  const raced = await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer", intent: systemMaintenanceIntent("pr-engineer"), legacyRecovery: true,
  });
  const old = (await fixture.service.listItems()).items[0];
  const authority = { requestKey: old.activeIntentId, producer: { roleId: "pr-engineer", workItemId: old.itemId } };
  fixture.source.records.push(prAssignment(2, { sourceScopeId: "github-secondary", gitFacts: prGitFacts(PR_HEAD_A),
    occurredAt: "2026-08-02T02:05:00.000Z" }),
  prAssignment(3, { sourceScopeId: "github-secondary", headRefOid: PR_HEAD_B, previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"], gitFacts: prGitFacts(PR_HEAD_B), occurredAt: "2026-08-02T02:06:00.000Z" }));
  fixture.source.highWatermark = 3;
  fixture.time.advance(600_000);
  await fixture.service.intake();
  let replacement = (await fixture.service.listItems()).items.find(item => item.itemId !== old.itemId);
  assert.equal(replacement.source.current.headRefOid, PR_HEAD_A);
  assert.equal(replacement.source.pending.headRefOid, PR_HEAD_B);
  assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) })).retried, 1);
  const activated = await fixture.service.reconcilePullRequestSource({ itemId: replacement.itemId,
    expectedGraphRevision: (await fixture.service.getSummary()).revision, expectedRevision: replacement.revision,
    expectedPendingRevision: replacement.source.pendingRevision });
  assert.equal(activated.applied, true);
  replacement = (await fixture.service.listItems()).items.find(item => item.itemId === replacement.itemId);
  assert.equal(replacement.status, "queued");
  assert.equal(replacement.source.current.headRefOid, PR_HEAD_B);
  assert.deepEqual(replacement.source.decisionBudget, { headRefOid: PR_HEAD_B, activationRevision: 2,
    previousActiveRevision: 1, attemptOffset: replacement.attempt });
  const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  assert.equal((await restarted.service.readAttentionRequestRetirement(authority)).reason, "system_maintenance_auto_retry");
  await restarted.service.applyAttentionBatch({ items: [raced], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.equal((await restarted.service.getSummary()).attentionCursor, 1);
  const claimable = (await restarted.service.listItems()).items.find(item => item.itemId === replacement.itemId);
  const claimed = await restarted.service.claim({ itemId: claimable.itemId, expectedRevision: claimable.revision,
    workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
  assert.equal(claimed.status, "working");
});

test("automatic maintenance never releases a business question or an applied rejection", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareAttentionResult(fixture, { type: "reject", reason: "stop" });
  assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) })).retried, 0);
  await fixture.service.applyAttentionBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.equal((await fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) })).retried, 0);
  assert.equal((await fixture.service.listItems()).items[0].statusReason, "attention_rejected");
});

test("retiring a historical infrastructure question restores the complete business decision budget", async () => {
  const fixture = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await prepareAttentionResult(fixture, { type: "choice", choiceId: "configured-retry" }, {
    workerId: "employee-pr-engineer", roleId: "pr-engineer", intent: systemMaintenanceIntent("pr-engineer"), legacyRecovery: true,
  });
  await fixture.service.retrySystemMaintenanceQuestions({ limit: 10,
    requestKeys: fixture.store.stored().outbox.map(entry => entry.intentId) });
  fixture.time.advance(60_000);
  for (let turn = 1; turn <= 3; turn += 1) {
    const cycle = await decisionBudgetLoop(fixture, { maxAttempts: 3, assemble: unavailablePrContext }).runCycle();
    assert.equal(turn < 3 ? cycle.retried : cycle.blocked, 1);
    assert.equal((await fixture.service.listItems()).items[0].attempt, turn);
    fixture.time.advance(60_000);
  }
});

test("orchestrator takeover question stays answerable for an unconfigured target", async () => {
  for (const target of [
    { type: "role", id: "developer" },
    { type: "person", id: "missing-owner" },
  ]) {
    const fixture = await createFixture({ records: [assignment(1, target)] });
    await prepareAttentionResult(
      fixture,
      { type: "text", text: "Assign a configured owner" },
      { workerId: "employee-orchestrator", roleId: "orchestrator" },
    );
    const waiting = (await fixture.service.listItems()).items[0];
    const authority = {
      requestKey: waiting.activeIntentId,
      producer: { roleId: "orchestrator", workItemId: waiting.itemId },
    };
    assert.equal(waiting.status, "waiting_user");
    assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);
    assert.equal(await fixture.service.isAttentionRequestCurrent({
      ...authority,
      producer: { ...authority.producer, roleId: "developer" },
    }), false);

    const inbox = new AttentionInbox({
      store: new MemoryStore(),
      exclusiveLease: new ExclusiveLease(),
      authority: fixture.service,
    });
    await inbox.recover();
    const intent = askUserIntent();
    const request = normalizeAttentionRequest({
      ...authority,
      type: "ask_user",
      question: intent.question,
      context: [],
      choices: intent.choices,
    });
    const receipt = await inbox.create(request);
    assert.equal((await inbox.next()).requestId, receipt.requestId);
    await inbox.answer({
      requestId: receipt.requestId,
      expectedRevision: receipt.revision,
      contentDigest: receipt.contentDigest,
      answer: { type: "text", text: "Assign a configured owner" },
    });
    assert.equal((await inbox.readOutbox()).items.length, 1);
  }
});

for (const lifecycle of [
  { eventType: "issue.left_scope", reason: "issue_source_left_scope" },
  { eventType: "issue.completed", reason: "issue_source_completed" },
]) {
  test(`${lifecycle.eventType} cancels its historical user question and revokes attention authority`, async () => {
    const initial = issueAssignment(1);
    const fixture = await createFixture({ records: [initial] });
    await prepareAttentionResult(
      fixture,
      { type: "text", text: "already completed" },
      {
        workerId: "configured-requirements-analyst",
        roleId: "requirements-analyst",
      },
    );
    const waiting = (await fixture.service.listItems()).items[0];
    assert.equal(waiting.status, "waiting_user");
    const authority = {
      requestKey: waiting.activeIntentId,
      producer: { roleId: "requirements-analyst", workItemId: waiting.itemId },
    };
    assert.equal(await fixture.service.readAttentionRequestRetirement(authority), null);
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: waiting.activeIntentId,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      true,
    );
    for (const producer of [
      { roleId: "developer", workItemId: waiting.itemId },
      { roleId: "requirements-analyst", workItemId: `${waiting.itemId}-wrong` },
    ]) {
      assert.equal(
        await fixture.service.isAttentionRequestCurrent({
          requestKey: waiting.activeIntentId,
          producer,
        }),
        false,
      );
    }
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: `${waiting.activeIntentId}-wrong`,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      false,
    );

    fixture.source.records.push(
      issueAssignment(2, {
        eventType: lifecycle.eventType,
        occurredAt: "2026-08-02T02:05:00.000Z",
        state: "closed",
      }),
    );
    fixture.source.highWatermark = 2;
    await fixture.service.intake();

    const items = (await fixture.service.listItems({ limit: 10 })).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].itemId, waiting.itemId);
    assert.equal(items[0].status, "cancelled");
    assert.equal(items[0].statusReason, lifecycle.reason);
    assert.equal(items[0].activeIntentId, null);
    assert.deepEqual(await fixture.service.readAttentionRequestRetirement(authority), {
      status: "cancelled", workItemRevision: items[0].revision, reason: lifecycle.reason,
    });
    assert.equal(await fixture.service.readAttentionRequestRetirement({
      ...authority, requestKey: "unknown-question",
    }), null);
    assert.equal(await fixture.service.readAttentionRequestRetirement({
      ...authority, producer: { ...authority.producer, roleId: "developer" },
    }), null);
    assert.equal(
      await fixture.service.isAttentionRequestCurrent({
        requestKey: waiting.activeIntentId,
        producer: {
          roleId: "requirements-analyst",
          workItemId: waiting.itemId,
        },
      }),
      false,
    );
  });
}

test("new Issue evidence revokes an older question for the same role", async () => {
  const initial = issueAssignment(1);
  const fixture = await createFixture({ records: [initial] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "old answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = {
    requestKey: waiting.activeIntentId,
    producer: {
      roleId: "requirements-analyst",
      workItemId: waiting.itemId,
    },
  };
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);

  fixture.source.records.push(issueAssignment(2, {
    eventType: "issue.updated",
    occurredAt: "2026-08-02T02:05:00.000Z",
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), false);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.length, 2);
  const retired = items.find(({ itemId }) => itemId === waiting.itemId);
  assert.equal(retired.status, "cancelled");
  assert.equal(retired.statusReason, "issue_assignment_superseded");
  assert.equal(retired.activeIntentId, null);
  assert.equal(items.find(({ itemId }) => itemId !== waiting.itemId).status, "queued");
});

test("attention authority reads a newer durable ledger written by another instance", async () => {
  const fixture = await createFixture({
    records: [issueAssignment(1)], store: new ContentVersionMemoryStore(),
  });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "old answer" },
    { workerId: "configured-requirements-analyst", roleId: "requirements-analyst" },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = {
    requestKey: waiting.activeIntentId,
    producer: { roleId: "requirements-analyst", workItemId: waiting.itemId },
  };
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);

  const other = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await other.recover();
  fixture.source.records.push(issueAssignment(2, {
    eventType: "issue.updated",
    occurredAt: "2026-08-02T02:05:00.000Z",
  }));
  fixture.source.highWatermark = 2;
  await other.intake();

  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), false);
  const retired = (await other.listItems()).items.find(
    (item) => item.itemId === waiting.itemId,
  );
  assert.deepEqual(await fixture.service.readAttentionRequestRetirement(authority), {
    status: "cancelled", workItemRevision: retired.revision, reason: "issue_assignment_superseded",
  });
});

test("attention reads reuse validated state only when durable content is unchanged", async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: [issueAssignment(1)], store });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "old answer" },
    { workerId: "configured-requirements-analyst", roleId: "requirements-analyst" },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = {
    requestKey: waiting.activeIntentId,
    producer: { roleId: "requirements-analyst", workItemId: waiting.itemId },
  };
  const originalState = fixture.service.state;
  const originalVersion = fixture.service.durableContentVersion;
  const valueReads = store.versionedValueReads;
  let authorityReads = 0;
  const readVersioned = store.readVersioned.bind(store);
  store.readVersioned = (...args) => { authorityReads += 1; return readVersioned(...args); };
  assert.deepEqual(await fixture.service.areAttentionRequestsCurrent([
    authority, { ...authority, requestKey: "not-the-active-intent" },
  ]), [true, false]);
  assert.equal(authorityReads, 1, "a maintenance batch must share one durable authority read");
  store.read = () => { throw new Error("Unchanged attention queries must not decode the entire ledger again"); };
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);
  assert.equal(await fixture.service.isAttentionRequestCurrent(authority), true);
  assert.equal(await fixture.service.readAttentionRequestRetirement(authority), null);
  assert.equal(store.versionedValueReads, valueReads);
  assert.equal(fixture.service.state, originalState);
  assert.equal(fixture.service.durableContentVersion, originalVersion);
});

test("attention does not pair an old question with a newer durable version during reconciliation", async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({ records: [issueAssignment(1)], store });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "old answer" },
    { workerId: "configured-requirements-analyst", roleId: "requirements-analyst" },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const authority = {
    requestKey: waiting.activeIntentId,
    producer: { roleId: "requirements-analyst", workItemId: waiting.itemId },
  };
  const oldState = fixture.service.state;
  const oldVersion = fixture.service.durableContentVersion;
  const other = new WorkLedgerService({
    store, assignmentSource: fixture.source, exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock, idFactory: incrementingIds(),
  });
  await other.recover();
  fixture.source.records.push(issueAssignment(2, {
    eventType: "issue.updated", occurredAt: "2026-08-02T02:05:00.000Z",
  }));
  fixture.source.highWatermark = 2;
  await other.intake();
  const readVersioned = store.readVersioned.bind(store);
  const newer = await readVersioned(STATE_KEY);
  const readStarted = deferred();
  const readRelease = deferred();
  let intercept = true;
  store.readVersioned = (...args) => {
    if (!intercept) return readVersioned(...args);
    intercept = false;
    readStarted.resolve();
    return readRelease.promise;
  };
  const reconciliation = fixture.service.readItemForReconciliation({ itemId: waiting.itemId });
  await readStarted.promise;
  const checked = deferred();
  readRelease.resolve(newer);
  queueMicrotask(() => {
    try {
      assert.equal(fixture.service.durableContentVersion, oldVersion, 'a read must not advance writer bookkeeping');
      assert.equal(fixture.service.state, oldState);
      fixture.service.isAttentionRequestCurrent(authority).then(checked.resolve, checked.reject);
    } catch (error) { checked.reject(error); }
  });
  const current = await checked.promise;
  await reconciliation;
  assert.equal(current, false);
});

test("one intake batch keeps only the newest Issue assignment for one role", async () => {
  const fixture = await createFixture({
    records: [
      issueAssignment(1),
      issueAssignment(2, {
        eventType: "issue.updated",
        occurredAt: "2026-08-02T02:05:00.000Z",
      }),
    ],
  });

  const result = await fixture.service.intake({ limit: 10 });

  assert.equal(result.received, 2);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceSequence, 2);
  assert.equal(items[0].status, "queued");
});

test("inactive Issue maintenance retires work outside the configured active window", async () => {
  const fixture = await createFixture({
    records: [
      issueAssignment(1, {
        occurredAt: "2026-07-01T00:00:00.000Z",
        issueNumber: 41,
      }),
      issueAssignment(2, {
        occurredAt: "2026-08-20T00:00:00.000Z",
        issueNumber: 42,
      }),
    ],
  });
  await fixture.service.intake({ limit: 10 });

  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(result.retired, 1);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  const oldIssue = items.find(({ sourceSequence }) => sourceSequence === 1);
  const recentIssue = items.find(({ sourceSequence }) => sourceSequence === 2);
  assert.equal(oldIssue.status, "cancelled");
  assert.equal(oldIssue.statusReason, "issue_outside_active_window");
  assert.equal(recentIssue.status, "queued");
});

test("targeted Issue maintenance retires newly received stale work", async () => {
  const fixture = await createFixture({
    records: [issueAssignment(1, {
      occurredAt: "2026-07-01T00:00:00.000Z",
      issueNumber: 41,
    })],
  });

  const intake = await fixture.service.intake({ limit: 10 });
  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: intake.itemIds,
  });

  assert.equal(result.retired, 1);
  const item = (await fixture.service.listItems({ limit: 10 })).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.statusReason, "issue_outside_active_window");
});

test("targeted Issue maintenance retires every selected role for one Issue", async () => {
  const requirements = issueAssignment(1, {
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  const developer = issueAssignment(2, {
    eventType: "issue.updated",
    occurredAt: "2026-07-01T00:05:00.000Z",
  });
  developer.assignment.target = { type: "role", id: "developer" };
  const fixture = await createFixture({ records: [requirements, developer] });
  const intake = await fixture.service.intake({ limit: 10 });

  const result = await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: intake.itemIds,
  });

  assert.equal(result.retired, 2);
  const items = (await fixture.service.listItems({ limit: 10 })).items;
  assert.equal(items.every(({ status }) => status === "cancelled"), true);
});

test("recovery retires a legacy Issue assignment superseded by newer evidence", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "legacy answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const newer = persistLegacyIssueLifecycleAssignment(
    fixture,
    issueAssignment(2, {
      eventType: "issue.updated",
      occurredAt: "2026-08-02T02:05:00.000Z",
    }),
  );

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  const items = (await restarted.service.listItems({ limit: 10 })).items;
  const retired = items.find(({ itemId }) => itemId === waiting.itemId);
  assert.equal(retired.status, "cancelled");
  assert.equal(retired.statusReason, "issue_assignment_superseded");
  assert.equal(items.find(({ itemId }) => itemId === newer.itemId).status, "queued");
});

test("content-version caching reuses validated graph state and still fails closed", async (t) => {
  await t.test("unchanged durable content reuses the validated graph projection", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();

    const first = await fixture.service.getGraphSnapshot();
    const readsAfterFirstProjection = store.versionedValueReads;
    const second = await fixture.service.getGraphSnapshot();

    assert.equal(second, first);
    assert.equal(store.versionedValueReads, readsAfterFirstProjection);
  });

  await t.test("a durable rollback invalidates the cache", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    const rolledBack = store.stored();
    const item = (await fixture.service.listItems()).items[0];
    await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    await fixture.service.getGraphSnapshot();

    store.replaceStored(rolledBack);
    await assert.rejects(
      fixture.service.getGraphSnapshot(),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("a same-revision fork invalidates the cache", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    await fixture.service.getGraphSnapshot();
    const fork = store.stored();
    fork.items[0].statusReason = "valid-but-forked";
    store.replaceStored(fork);

    await assert.rejects(
      fixture.service.getGraphSnapshot(),
      (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
    );
  });

  await t.test("a lost write acknowledgement is visible on the next graph read", async () => {
    const store = new ContentVersionMemoryStore();
    const fixture = await createFixture({
      records: [assignment(1)],
      store,
    });
    await fixture.service.intake();
    const waiting = await prepareWaitingCondition(fixture, {
      kind: "workflow_fact",
      fact: "ci-status",
      oneOf: ["success"],
    });
    const before = await fixture.service.getGraphSnapshot();
    const durableWrite = store.write.bind(store);
    let loseAcknowledgement = true;
    store.write = async (...arguments_) => {
      const version = await durableWrite(...arguments_);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("durable acknowledgement lost");
      }
      return version;
    };

    await assert.rejects(
      fixture.service.wakeCondition({
        itemId: waiting.item.itemId,
        expectedRevision: waiting.item.revision,
        intentId: waiting.intentId,
        actorId: "work-condition-waker",
        observation: {
          kind: "workflow_fact",
          fact: "ci-status",
          value: "success",
          observedAt: "2026-08-02T02:00:00.000Z",
        },
      }),
      (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
    );

    const browserSnapshot = await fixture.service.getLastCommittedGraphSnapshot();
    assert.equal(browserSnapshot, before);
    const recovered = await fixture.service.getGraphSnapshot();
    assert.equal(recovered.graph.revision, before.graph.revision + 1);
    assert.equal(recovered.graph.tasks[0].revision, waiting.item.revision + 1);
  });
});

test("browser and authoritative graph reads expose only committed state during an in-flight write", async () => {
  const store = new ContentVersionMemoryStore();
  const fixture = await createFixture({
    records: [assignment(1)],
    store,
    postCommitYield: async () => {},
  });
  await fixture.service.intake();
  const before = await fixture.service.getLastCommittedGraphSnapshot();
  const item = (await fixture.service.listItems()).items[0];
  const writeStarted = deferred();
  const releaseWrite = deferred();
  const durableWrite = store.write.bind(store);
  store.write = async (...arguments_) => {
    writeStarted.resolve();
    await releaseWrite.promise;
    return durableWrite(...arguments_);
  };

  const claim = fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  await writeStarted.promise;
  const browserSnapshot = await fixture.service.getLastCommittedGraphSnapshot();
  try {
    assert.equal(browserSnapshot, before);
    assert.equal(await fixture.service.getGraphSnapshot(), before);
  } finally { releaseWrite.resolve(); await claim; }
  const after = await fixture.service.getGraphSnapshot();
  assert.equal(after.graph.revision, before.graph.revision + 1);
});

test("a committed ledger write yields after publishing its browser snapshot", async () => {
  const yieldStarted = deferred();
  const releaseYield = deferred();
  const fixture = await createFixture({
    records: [assignment(1)],
    postCommitYield: async () => {
      yieldStarted.resolve();
      await releaseYield.promise;
    },
  });

  const intake = fixture.service.intake();
  await yieldStarted.promise;
  const duringYield = await fixture.service.getLastCommittedGraphSnapshot();
  let intakeSettled = false;
  intake.finally(() => {
    intakeSettled = true;
  });
  await Promise.resolve();

  assert.equal(duringYield.graph.revision, 1);
  assert.equal(intakeSettled, false);

  releaseYield.resolve();
  await intake;
});

test("recovery preserves distinct manual Issues assigned to the same role", async () => {
  const fixture = await createFixture({
    records: [
      ownerRequestedIssueAssignment(1, 101),
      ownerRequestedIssueAssignment(2, 102),
    ],
  });
  await fixture.service.intake({ limit: 10 });
  assert.deepEqual(
    (await fixture.service.listItems({ limit: 10 })).items.map(({ status }) => status),
    ["queued", "queued"],
  );

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });
  const recovered = (await restarted.service.listItems({ limit: 10 })).items;

  assert.deepEqual(recovered.map(({ status }) => status), ["queued", "queued"]);
  assert.deepEqual(
    recovered.map(({ event }) => event.subject.number).sort((left, right) => left - right),
    [101, 102],
  );
});

test("recovery does not treat a newer Issue graph child as a root assignment", async () => {
  const olderDeveloperRecord = issueAssignment(1);
  olderDeveloperRecord.assignment.target = { type: "role", id: "developer" };
  const fixture = await createFixture({ records: [olderDeveloperRecord] });
  await fixture.service.intake();
  const olderDeveloper = (await fixture.service.listItems()).items[0];
  const newerRoot = persistLegacyIssueLifecycleAssignment(
    fixture,
    issueAssignment(2, {
      eventType: "issue.updated",
      occurredAt: "2026-08-02T02:05:00.000Z",
    }),
  );
  const newerChildRecord = issueAssignment(3, {
    eventType: "issue.updated",
    occurredAt: "2026-08-02T02:06:00.000Z",
  });
  newerChildRecord.assignment.target = { type: "role", id: "developer" };
  const newerChild = persistLegacyIssueLifecycleAssignment(
    fixture,
    newerChildRecord,
  );
  const durable = fixture.store.stored();
  const child = durable.items.find(({ itemId }) => itemId === newerChild.itemId);
  child.graph.parentItemId = newerRoot.itemId;
  fixture.store.replaceStored(durable);

  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  const items = (await restarted.service.listItems({ limit: 10 })).items;
  assert.equal(
    items.find(({ itemId }) => itemId === olderDeveloper.itemId).status,
    "queued",
  );
  assert.equal(
    items.find(({ itemId }) => itemId === newerChild.itemId).status,
    "queued",
  );
});

test("recovery retires a persisted Issue lifecycle task but preserves a later reopen", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await prepareAttentionResult(
    fixture,
    { type: "text", text: "already completed" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  const completed = issueAssignment(2, {
    eventType: "issue.completed",
    occurredAt: "2026-08-02T02:05:00.000Z",
    state: "closed",
  });
  const legacyLifecycle = persistLegacyIssueLifecycleAssignment(
    fixture,
    completed,
  );
  const writesBeforeRecovery = fixture.store.writes.length;
  const reopened = issueAssignment(3, {
    occurredAt: "2026-08-02T02:10:00.000Z",
    state: "open",
  });
  const restarted = await createFixture({
    store: fixture.store,
    source: new FakeAssignmentSource([reopened]),
    time: controlledClock("2026-08-02T02:10:00.000Z"),
  });

  assert.equal(fixture.store.writes.length, writesBeforeRecovery + 1);
  const recovered = (await restarted.service.listItems({ limit: 10 })).items;
  assert.equal(recovered.length, 2);
  assert.equal(
    recovered.find(({ itemId }) => itemId === legacyLifecycle.itemId).status,
    "cancelled",
  );
  assert.equal(
    recovered.every(({ statusReason }) => statusReason === "issue_source_completed"),
    true,
  );

  await restarted.service.intake();
  const afterReopen = (await restarted.service.listItems({ limit: 10 })).items;
  const reopenedItem = afterReopen.find(
    (item) => currentWorkItemEvent(item).eventId === reopened.event.eventId,
  );
  assert.equal(reopenedItem.status, "queued");
  assert.equal(reopenedItem.statusReason, null);
});

test("a late answer for lifecycle-cancelled Issue work is discarded without blocking the cursor", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  const result = await prepareAttentionResult(
    fixture,
    { type: "text", text: "late answer" },
    {
      workerId: "configured-requirements-analyst",
      roleId: "requirements-analyst",
    },
  );
  fixture.source.records.push(
    issueAssignment(2, {
      eventType: "issue.left_scope",
      occurredAt: "2026-08-02T02:05:00.000Z",
      state: "closed",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  const applied = await fixture.service.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });

  assert.equal(applied.cursor, 1);
  assert.equal(applied.applied, 1);
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.decisionContext, null);
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  const discarded = timeline.items.find(
    ({ type }) => type === "stale_result_discarded",
  );
  assert.equal(discarded.details.reason, "issue_source_left_scope");
});

test("late answers for superseded or inactive Issue work are safely discarded", async (context) => {
  for (const scenario of [
    {
      name: "superseded",
      reason: "issue_assignment_superseded",
      settle: async (fixture) => {
        fixture.source.records.push(issueAssignment(2, {
          eventType: "issue.updated",
          occurredAt: "2026-08-02T02:05:00.000Z",
        }));
        fixture.source.highWatermark = 2;
        await fixture.service.intake();
      },
    },
    {
      name: "inactive",
      reason: "issue_outside_active_window",
      settle: (fixture) => fixture.service.retireInactiveIssues({
        updatedBefore: "2026-08-15T00:00:00.000Z",
      }),
    },
  ]) {
    await context.test(scenario.name, async () => {
      const initial = scenario.name === "inactive"
        ? issueAssignment(1, { occurredAt: "2026-07-01T00:00:00.000Z" })
        : issueAssignment(1);
      const fixture = await createFixture({ records: [initial] });
      const result = await prepareAttentionResult(
        fixture,
        { type: "text", text: "late answer" },
        {
          workerId: "configured-requirements-analyst",
          roleId: "requirements-analyst",
        },
      );
      await scenario.settle(fixture);

      const applied = await fixture.service.applyAttentionBatch({
        items: [result],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });

      assert.equal(applied.cursor, 1);
      assert.equal(applied.applied, 1);
      const item = (await fixture.service.listItems()).items.find(
        ({ itemId }) => itemId === result.producer.workItemId,
      );
      assert.equal(item.status, "cancelled");
      assert.equal(item.statusReason, scenario.reason);
      assert.equal(item.decisionContext, null);
      const timeline = await fixture.service.listTimeline({ limit: 100 });
      const discarded = timeline.items.filter(
        ({ type }) => type === "stale_result_discarded",
      );
      assert.equal(discarded.length, 1);
      assert.equal(discarded[0].details.reason, scenario.reason);
    });
  }
});

function boundAttentionIntent(item, outbox) {
  const content = {
    policyVersion: 1,
    kind: "attention_request",
    requestedBy: {
      roleId: outbox.requestedBy.roleId,
      workItemId: item.itemId,
    },
    source: {
      assignmentId: item.assignmentId,
      eventId: item.event.eventId,
    },
    binding: { requestKey: outbox.intentId },
    payload: {
      question: outbox.intent.question,
      choices: outbox.intent.choices,
    },
  };
  return {
    intentId: `work-intent-${workProposalDigest(content)}`,
    ...content,
  };
}

test("Issue lifecycle settlement revokes a persisted dispatch binding", async () => {
  const fixture = await createFixture({ records: [issueAssignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "configured-requirements-analyst",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "configured-requirements-analyst",
    roleId: "requirements-analyst",
    intent: askUserIntent(),
  });
  const claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const bound = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundAttentionIntent(staged.item, staged.outbox),
  });
  const authority = {
    intentId: bound.intentId,
    expectedRevision: bound.revision,
    dispatchLeaseId: bound.dispatchLeaseId,
    bindingDigest: bound.dispatchBinding.bindingDigest,
    itemId: staged.item.itemId,
    itemExpectedRevision: staged.item.revision,
  };
  assert.equal(await fixture.service.isIntentDispatchCurrent(authority), true);

  fixture.source.records.push(
    issueAssignment(2, {
      eventType: "issue.left_scope",
      occurredAt: "2026-08-02T02:05:00.000Z",
      state: "closed",
    }),
  );
  fixture.source.highWatermark = 2;
  await fixture.service.intake();

  assert.equal(await fixture.service.isIntentDispatchCurrent(authority), false);
});

function quarantineStoredItem(
  durable,
  item,
  { preserveWorkState = false } = {},
) {
  const sequence = Math.max(
    durable.intakeCursor,
    durable.sourceHighWatermark,
  ) + 1;
  const record = prAssignment(sequence, {
    repository: "legacy/quarantine",
    pullRequestNumber: 1_000 + sequence,
    title: "Legacy quarantined PR source",
  });
  const root = createPullRequestSourceRootWorkItem(
    record,
    item.updatedAt,
  );
  const quarantine = {
    kind: LEGACY_PR_SOURCE_QUARANTINE_KIND,
    rootItemId: root.itemId,
    workKey: root.source.workKey,
    reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
  };
  Object.assign(root, {
    status: "blocked",
    statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
    sourceQuarantine: quarantine,
  });
  Object.assign(
    item,
    preserveWorkState
      ? {
          statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          sourceQuarantine: quarantine,
        }
      : {
          status: "blocked",
          activeIntentId: null,
          statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          sourceQuarantine: quarantine,
        },
  );
  durable.items.push(root);
  durable.intakeCursor = sequence;
  durable.sourceHighWatermark = sequence;
  durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
    durable.items,
    durable.revision,
    normalizeWorkLedgerLimits(),
  );
  return quarantine;
}

test("an answered attention result atomically advances its cursor and requeues durable context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  const batch = {
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const waiting = (await fixture.service.listItems()).items[0];
  await assert.rejects(
    fixture.service.transition({
      itemId: waiting.itemId,
      expectedRevision: waiting.revision,
      actorId: "unbound-system",
      toStatus: "blocked",
      reason: "bypass",
    }),
    (error) => error.code === "WORK_LEDGER_ACTIVE_INTENT_CONFLICT",
  );

  const applied = await fixture.service.applyAttentionBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "queued");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.decisionContext.source, "attention");
  assert.equal(item.decisionContext.outcome, "answered");
  assert.deepEqual(item.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
  assert.equal(summary.attentionCursor, 1);
  assert.equal(summary.attentionHighWatermark, 1);
  const stored = fixture.store.stored();
  const resultTimeline = stored.timeline.find(
    ({ type }) => type === "attention_answer_applied",
  );
  const resultAttestation = stored.outbox[0].outcome.details.resultAttestation;
  assert.match(resultAttestation.attestationDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    resultTimeline.details.resultAttestationDigest,
    resultAttestation.attestationDigest,
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyAttentionBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(await recovered.getSummary(), summary);
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    item.decisionContext,
  );
});

test("recovery rejects a rehashed attention conclusion that disagrees with its receipt", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "attention_answer_applied",
  );
  timeline.details.answer = { type: "choice", choiceId: "forged" };
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("a rejected attention result blocks work while a gap advances nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "reject",
    reason: "需求需要重新梳理",
  });
  const writesBeforeGap = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.applyAttentionBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_ATTENTION_GAP",
  );
  assert.equal((await fixture.service.getSummary()).attentionCursor, 0);
  assert.equal(fixture.store.writes.length, writesBeforeGap);

  await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.decisionContext.outcome, "rejected");
});

test("PR ask_user answers and rejections retain the exact immutable execution binding", async (t) => {
  for (const [name, answer] of [
    ["answered", { type: "choice", choiceId: "yes" }],
    ["rejected", { type: "reject", reason: "owner stopped this Head" }],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
      });
      const outbox = await prepareAttentionResult(fixture, answer, {
        workerId: "employee-pr-engineer",
        roleId: "pr-engineer",
      });
      const waiting = (await fixture.service.listItems()).items[0];
      const expectedBinding = prExecutionBinding(waiting);
      await fixture.service.applyAttentionBatch({
        items: [outbox],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
      const timeline = (await fixture.service.listTimeline({ limit: 20 })).items;
      const staged = timeline.find(({ type }) => type === "intent_staged");
      const settled = timeline.find(({ type }) =>
        ["attention_answer_applied", "attention_rejection_applied"].includes(
          type,
        )
      );
      assert.deepEqual(staged.details.inputBinding, expectedBinding);
      assert.deepEqual(settled.details.inputBinding, expectedBinding);
      assert.equal(Number.isSafeInteger(staged.details.workItemRevision), true);
      assert.equal(staged.details.workItemRevision > 0, true);
      assert.equal(Number.isSafeInteger(settled.details.workItemRevision), true);
      assert.equal(
        settled.details.workItemRevision > staged.details.workItemRevision,
        true,
      );
    });
  }
});

test("a same-Head PR fact update does not strand an answered user question", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const result = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  const waiting = (await fixture.service.listItems()).items[0];
  const originalBinding = prExecutionBinding(waiting);
  const updatedAssignment = prAssignment(2, {
    eventType: "pull_request.status",
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_A,
    changedFields: ["ciStatus"],
    ciStatus: "SUCCESS",
    gitFacts: prGitFacts(PR_HEAD_A),
  });
  const stored = fixture.store.stored();
  const candidate = structuredClone(stored);
  candidate.revision += 1;
  const revised = candidate.items.find(({ itemId }) => itemId === waiting.itemId);
  const appended = appendPullRequestWorkSource(revised.source, updatedAssignment, { attemptAtActivation: revised.attempt });
  assert.equal(appended.activeAdvanced, true);
  revised.source = appended.source;
  revised.inputDigest = appended.source.current.inputDigest;
  fixture.store.replaceStored(appendWorkGraphMemoryEvents(
    stored,
    candidate,
    normalizeWorkLedgerLimits(),
  ));
  assert.equal(revised.status, "waiting_user");
  assert.equal(revised.source.activeRevision, 2);
  assert.notEqual(revised.inputDigest, waiting.inputDigest);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.equal(await recovered.isAttentionRequestCurrent({
    requestKey: waiting.activeIntentId,
    producer: { roleId: "pr-engineer", workItemId: waiting.itemId },
  }), true);
  const applied = await recovered.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  assert.equal(applied.cursor, 1);
  const settled = (await recovered.listItems()).items[0];
  assert.equal(settled.status, "queued");
  assert.deepEqual(settled.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
  const timeline = (await recovered.listTimeline({ limit: 100 })).items;
  const answer = timeline.find(({ type }) => type === "attention_answer_applied");
  assert.deepEqual(answer.details.inputBinding, originalBinding);
  assert.equal(answer.details.inputDigest, waiting.inputDigest);

  const restarted = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await restarted.recover();
});

test("an answered question for an old PR Head cannot settle the new Head", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const result = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  const stored = fixture.store.stored();
  const candidate = structuredClone(stored);
  candidate.revision += 1;
  const item = candidate.items[0];
  const appended = appendPullRequestWorkSource(item.source, prAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
    gitFacts: prGitFacts(PR_HEAD_B),
  }), { attemptAtActivation: item.attempt });
  assert.equal(appended.activeAdvanced, true);
  item.source = appended.source;
  item.inputDigest = appended.source.current.inputDigest;
  fixture.store.replaceStored(appendWorkGraphMemoryEvents(
    stored,
    candidate,
    normalizeWorkLedgerLimits(),
  ));
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.equal(await recovered.isAttentionRequestCurrent({
    requestKey: result.requestKey,
    producer: { roleId: "pr-engineer", workItemId: item.itemId },
  }), false);
  await assert.rejects(
    recovered.applyAttentionBatch({
      items: [result],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_ATTENTION_BINDING_CONFLICT",
  );
});

test("a question answered after its PR leaves scope is recorded without requeueing", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const result = await prepareAttentionResult(
    fixture,
    { type: "choice", choiceId: "yes" },
    { workerId: "employee-pr-engineer", roleId: "pr-engineer" },
  );
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const waiting = (await fixture.service.listItems()).items[0];
  assert.equal(waiting.source.scope.active, false);
  assert.equal(waiting.statusReason, "pr_source_left_scope_pending_settlement");

  await fixture.service.applyAttentionBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const settled = (await fixture.service.listItems()).items[0];
  assert.equal(settled.status, "blocked");
  assert.equal(settled.statusReason, "pr_source_left_scope");
  assert.deepEqual(settled.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
});

test("a sealed attention result advances its cursor without reviving legacy PR-source work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const outbox = await prepareAttentionResult(fixture, {
    type: "choice",
    choiceId: "yes",
  });
  const durable = fixture.store.stored();
  durable.outbox[0].dispatchBinding = createWorkIntentDispatchBinding(
    boundAttentionIntent(durable.items[0], durable.outbox[0]),
  );
  quarantineStoredItem(durable, durable.items[0]);
  fixture.store.replaceStored(durable);
  fixture.service = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await fixture.service.recover();

  const applied = await fixture.service.applyAttentionBatch({
    items: [outbox],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(summary.attentionCursor, 1);
  assert.equal(summary.attentionHighWatermark, 1);
  assert.equal(item.status, "blocked");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(item.decisionContext.source, "attention");
  assert.equal(item.decisionContext.outcome, "answered");
  assert.deepEqual(item.decisionContext.value.answer, {
    type: "choice",
    choiceId: "yes",
  });
});

test("legacy attention settlement discards unsealed quarantine and rejects reason-only fallback", async (t) => {
  for (const seal of [false, true]) {
    await t.test(
      seal ? "status reason alone is not quarantine" : "unsealed quarantine",
      async () => {
        const fixture = await createFixture({ records: [assignment(1)] });
        const outbox = await prepareAttentionResult(fixture, {
          type: "choice",
          choiceId: "yes",
        });
        const durable = fixture.store.stored();
        const item = durable.items[0];
        if (seal) {
          durable.outbox[0].dispatchBinding = createWorkIntentDispatchBinding(
            boundAttentionIntent(item, durable.outbox[0]),
          );
          Object.assign(item, {
            status: "blocked",
            activeIntentId: null,
            statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          });
        } else {
          quarantineStoredItem(durable, item, { preserveWorkState: true });
        }
        fixture.store.replaceStored(durable);
        fixture.service = new WorkLedgerService({
          store: fixture.store,
          assignmentSource: fixture.source,
          exclusiveLease: fixture.lease,
          clock: fixture.time.clock,
          idFactory: incrementingIds(),
        });
        await fixture.service.recover();
        if (!seal) {
          const waiting = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(waiting.status, "waiting_user");
          assert.notEqual(waiting.activeIntentId, null);
          assert.equal(
            waiting.sourceQuarantine.kind,
            LEGACY_PR_SOURCE_QUARANTINE_KIND,
          );
        }

        const batch = {
          items: [outbox],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        };
        if (!seal) {
          const applied = await fixture.service.applyAttentionBatch(batch);
          const settled = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(applied.applied, 1);
          assert.equal((await fixture.service.getSummary()).attentionCursor, 1);
          assert.equal(settled.status, "blocked");
          assert.equal(settled.activeIntentId, null);
          assert.equal(settled.decisionContext, null);
          const audit = (await fixture.service.listTimeline({
            order: "newest",
          })).items[0];
          assert.equal(audit.type, "legacy_result_discarded");
          assert.equal(audit.details.source, "attention");
          return;
        }
        await assert.rejects(
          fixture.service.applyAttentionBatch(batch),
          (error) => error.code === "WORK_LEDGER_ATTENTION_BINDING_CONFLICT",
        );
        assert.equal((await fixture.service.getSummary()).attentionCursor, 0);
      },
    );
  }
});

async function prepareProposalResult(
  fixture,
  {
    outcome = "succeeded",
    sequence = 1,
    kind = "github_review_proposal",
    downstreamRef,
    proposalDigest,
    authoritativeEvidence = false,
    sealSource = false,
    intentOverrides = {},
    roleId: configuredRoleId,
    workerId: configuredWorkerId,
    itemId: selectedItemId,
  } = {},
) {
  await fixture.service.intake();
  let item = selectedItemId === undefined ? (await fixture.service.listItems()).items[0]
    : await fixture.service.readItemForReconciliation({ itemId: selectedItemId });
  const codeProposal = kind === "code_action_proposal";
  const externalActionProposal =
    kind === "github_pull_request_action_proposal";
  const roleId = configuredRoleId ??
    (codeProposal ? "developer" : "pr-reviewer");
  const workerId = configuredWorkerId ?? `employee-${roleId}`;
  let evidenceTarget;
  if (authoritativeEvidence) {
    const acceptanceContract = {
      revision: 1,
      acceptanceCriteria: [],
      expectedDeliverables: [
        {
          deliverableId: codeProposal ? "change-package" : "review-report",
          kind: codeProposal ? "change-package" : "review-report",
          description: codeProposal
            ? "可追溯的代码变更包"
            : "可追溯的 PR 审查报告",
          required: true,
        },
      ],
    };
    const durable = fixture.store.stored();
    const durableItem = durable.items.find(
      ({ itemId }) => itemId === item.itemId,
    );
    durableItem.graph.acceptanceContracts = [
      {
        ...acceptanceContract,
        recordedAt: durableItem.graph.acceptanceContracts[0].recordedAt,
      },
    ];
    durable.graphMemoryProjection = migrateWorkGraphMemoryProjection(
      durable.items,
      durable.revision,
      normalizeWorkLedgerLimits(),
    );
    fixture.store.replaceStored(durable);
    fixture.service = new WorkLedgerService({
      store: fixture.store,
      assignmentSource: fixture.source,
      exclusiveLease: fixture.lease,
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
    });
    await fixture.service.recover();
    item = (await fixture.service.listItems()).items[0];
    evidenceTarget = createDeliveryEvidenceTarget({
      taskId: item.itemId,
      roleId,
      acceptanceContract,
    });
  }
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: workerId,
    roleId,
    intent: codeProposal
      ? codeActionIntent(intentOverrides)
      : externalActionProposal
        ? externalPullRequestActionIntent(intentOverrides)
        : reviewIntent(intentOverrides),
  });
  const proposalContent = {
    policyVersion: 1,
    kind,
    requestedBy: {
      roleId,
      workItemId: staged.item.itemId,
    },
    source: {
      assignmentId: staged.item.assignmentId,
      eventId: staged.item.event.eventId,
    },
    binding: codeProposal
      ? {
          repository: "acme/repo",
          workspaceId: "dashboard",
          ...(sealSource
            ? { inputBinding: prExecutionBinding(staged.item) }
            : {}),
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        }
      : {
          repository: "acme/repo",
          pullRequestNumber: 1,
          ...(evidenceTarget === undefined ? {} : { evidenceTarget }),
        },
    payload: codeProposal
      ? {
          operation: intentOverrides.operation ?? "modify",
          objective: "修复并发覆盖",
          acceptanceCriteria: ["回归测试通过"],
        }
      : externalActionProposal
        ? { action: { type: "update_branch" } }
        : { verdict: "approve", body: "本地审查通过。" },
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId: authoritativeEvidence || sealSource
      ? `work-intent-${workProposalDigest(proposalContent)}`
      : `work-intent-${
          codeProposal
            ? "c".repeat(64)
            : externalActionProposal
              ? "d".repeat(64)
              : "b".repeat(64)
        }`,
    ...proposalContent,
  });
  let claimed = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  if (evidenceTarget !== undefined || sealSource) {
    claimed = await fixture.service.bindIntent({
      intentId: claimed.intentId,
      expectedRevision: claimed.revision,
      itemExpectedRevision: staged.item.revision,
      dispatcherId: "work-intent-dispatcher",
      dispatchLeaseId: claimed.dispatchLeaseId,
      boundIntent: {
        intentId: proposal.proposalId,
        ...proposalContent,
      },
    });
  }
  await fixture.service.ackIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    dispatchLeaseId: claimed.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_external",
    actorId: "work-intent-dispatcher",
    details: {
      downstreamRef: downstreamRef ?? proposal.proposalId,
      proposalDigest: proposalDigest ?? proposal.contentDigest,
    },
  });
  return createWorkProposalResult({
    proposal,
    sequence,
    transition: {
      status: outcome,
      summary: `提案结果：${outcome}`,
      evidence: ["proposal-audit-1"],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });
}

test("a late proposal result for retired Issue work is discarded and advances", async () => {
  const record = issueAssignment(1, {
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  record.assignment.target = { type: "role", id: "pr-reviewer" };
  const fixture = await createFixture({ records: [record] });
  const result = await prepareProposalResult(fixture);
  const waiting = (await fixture.service.listItems()).items[0];
  await fixture.service.retireInactiveIssues({
    updatedBefore: "2026-08-15T00:00:00.000Z",
    itemIds: [waiting.itemId],
  });

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });

  assert.equal(applied.applied, 1);
  assert.equal(applied.cursor, 1);
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "cancelled");
  assert.equal(item.statusReason, "issue_outside_active_window");
  assert.equal(item.decisionContext, null);
  const timeline = await fixture.service.listTimeline({ limit: 100 });
  const discarded = timeline.items.find(
    ({ type }) => type === "stale_result_discarded",
  );
  assert.equal(discarded.details.source, "proposal");
  assert.equal(discarded.details.reason, "issue_outside_active_window");
});

test("a bound GitHub proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  assert.equal(fixture.store.stored().outbox[0].dispatchBinding, null);
  const batch = {
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  };

  const applied = await fixture.service.applyProposalBatch(batch);
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, "proposal_succeeded");
  assert.equal(item.decisionContext.source, "proposal");
  assert.equal(item.decisionContext.outcome, "succeeded");
  assert.equal(item.decisionContext.value.resultId, result.resultId);
  assert.equal(summary.proposalCursor, 1);
  assert.equal(summary.proposalHighWatermark, 1);
  const decisionTimeline =
    (await fixture.service.listTimeline({ order: "newest" })).items[0];
  assert.equal(decisionTimeline.type, "proposal_result_applied");
  assert.equal(
    decisionTimeline.details.intentId,
    fixture.store.stored().outbox[0].intentId,
  );
  assert.equal(decisionTimeline.details.workItemRevision, item.revision);
  assert.deepEqual(decisionTimeline.details.decision, item.decisionContext);
  assert.equal(
    decisionTimeline.details.decision.value.resultId,
    result.resultId,
  );
  assert.deepEqual(
    decisionTimeline.details.decision.value.evidence,
    result.evidence,
  );

  const restarted = await createFixture({
    records: [assignment(1)],
    store: fixture.store,
  });
  const recoveredTimeline =
    (await restarted.service.listTimeline({ order: "newest" })).items[0];
  assert.equal(recoveredTimeline.entryId, decisionTimeline.entryId);
  assert.equal(
    recoveredTimeline.details.intentId,
    fixture.store.stored().outbox[0].intentId,
  );

  const writesBeforeReplay = fixture.store.writes.length;
  const replayed = await fixture.service.applyProposalBatch(batch);
  assert.equal(replayed.applied, 0);
  assert.equal(replayed.deduplicated, 1);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);
});

test("a sealed proposal result settles after its PR leaves scope", async () => {
  const fixture = await createFixture({
    records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })],
  });
  const result = await prepareProposalResult(fixture, {
    roleId: "pr-engineer",
  });
  const leftEvent = prAssignment(2, {
    eventType: "pull_request.left_scope",
    occurredAt: "2026-08-02T01:05:00.000Z",
    gitFacts: prGitFacts(PR_HEAD_A),
  }).event;
  fixture.source.records.push(prScopeLifecycleAssignment(2, leftEvent));
  fixture.source.highWatermark = 2;

  await fixture.service.intake();
  const pending = (await fixture.service.listItems()).items[0];
  assert.equal(pending.status, "waiting_external");
  assert.equal(
    pending.statusReason,
    "pr_source_left_scope_pending_settlement",
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const settled = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(settled.status, "completed");
  assert.equal(settled.activeIntentId, null);
  assert.equal(settled.statusReason, "proposal_succeeded");
});

test("recovery rejects a rehashed proposal conclusion not sealed by its result attestation", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  timeline.details.decision.value.summary = "forged successful conclusion";
  timeline.details.decision.value.evidence = ["forged-evidence"];
  timeline.details.evidenceRefs = ["forged-evidence"];
  timeline.details.decision.contentDigest = ledgerDigest({
    source: timeline.details.decision.source,
    referenceId: timeline.details.decision.referenceId,
    outcome: timeline.details.decision.outcome,
    value: timeline.details.decision.value,
    observedAt: timeline.details.decision.observedAt,
  });
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("current state rejects removing both copies of a proposal result receipt", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  delete timeline.details.resultAttestationDigest;
  delete stored.outbox[0].outcome.details.resultAttestation;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await assert.rejects(
    recovered.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
});

test("schema 10 migration quarantines an unattested proposal conclusion", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture);
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const stored = fixture.store.stored();
  stored.schemaVersion = 10;
  const timeline = stored.timeline.find(
    ({ type }) => type === "proposal_result_applied",
  );
  delete timeline.details.resultAttestationDigest;
  delete stored.outbox[0].outcome.details.resultAttestation;
  const { timelineId: _timelineId, contentDigest: _contentDigest, ...content } =
    timeline;
  timeline.contentDigest = ledgerDigest(content);
  timeline.timelineId = `work-timeline-${timeline.contentDigest}`;
  fixture.store.replaceStored(stored);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();
  const recoveredTimeline = await recovered.listTimeline({ limit: 20 });
  assert.equal(
    recoveredTimeline.items.some(
      ({ type }) => type === "proposal_result_applied",
    ),
    false,
  );
  const discarded = recoveredTimeline.items.find(
    ({ type }) => type === "legacy_result_discarded",
  );
  assert.equal(discarded.details.originalType, "proposal_result_applied");
  assert.equal(
    discarded.details.reason,
    "unsealed_result_attestation_migration",
  );
});

test("a sealed proposal result advances its cursor without completing legacy PR-source work", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
  });
  const durable = fixture.store.stored();
  quarantineStoredItem(durable, durable.items[0]);
  fixture.store.replaceStored(durable);
  fixture.service = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: fixture.lease,
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await fixture.service.recover();

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  const summary = await fixture.service.getSummary();

  assert.equal(applied.applied, 1);
  assert.equal(summary.proposalCursor, 1);
  assert.equal(summary.proposalHighWatermark, 1);
  assert.equal(item.status, "blocked");
  assert.equal(item.activeIntentId, null);
  assert.equal(item.statusReason, LEGACY_PR_SOURCE_CUTOVER_REASON);
  assert.equal(item.decisionContext.source, "proposal");
  assert.equal(item.decisionContext.outcome, "succeeded");
  assert.equal(item.decisionContext.value.resultId, result.resultId);
});

test("legacy proposal settlement discards unsealed quarantine and rejects reason-only fallback", async (t) => {
  for (const seal of [false, true]) {
    await t.test(
      seal ? "status reason alone is not quarantine" : "unsealed quarantine",
      async () => {
        const fixture = await createFixture({ records: [assignment(1)] });
        const result = await prepareProposalResult(fixture, {
          authoritativeEvidence: seal,
        });
        const durable = fixture.store.stored();
        const item = durable.items[0];
        if (seal) {
          Object.assign(item, {
            status: "blocked",
            activeIntentId: null,
            statusReason: LEGACY_PR_SOURCE_CUTOVER_REASON,
          });
        } else {
          quarantineStoredItem(durable, item, { preserveWorkState: true });
        }
        fixture.store.replaceStored(durable);
        fixture.service = new WorkLedgerService({
          store: fixture.store,
          assignmentSource: fixture.source,
          exclusiveLease: fixture.lease,
          clock: fixture.time.clock,
          idFactory: incrementingIds(),
        });
        await fixture.service.recover();
        if (!seal) {
          const waiting = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(waiting.status, "waiting_external");
          assert.notEqual(waiting.activeIntentId, null);
          assert.equal(
            waiting.sourceQuarantine.kind,
            LEGACY_PR_SOURCE_QUARANTINE_KIND,
          );
        }

        const batch = {
          items: [result],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        };
        if (!seal) {
          const applied = await fixture.service.applyProposalBatch(batch);
          const settled = (await fixture.service.listItems()).items.find(
            ({ itemId }) => itemId === item.itemId,
          );
          assert.equal(applied.applied, 1);
          assert.equal((await fixture.service.getSummary()).proposalCursor, 1);
          assert.equal(settled.status, "blocked");
          assert.equal(settled.activeIntentId, null);
          assert.equal(settled.decisionContext, null);
          const audit = (await fixture.service.listTimeline({
            order: "newest",
          })).items[0];
          assert.equal(audit.type, "legacy_result_discarded");
          assert.equal(audit.details.source, "proposal");
          return;
        }
        await assert.rejects(
          fixture.service.applyProposalBatch(batch),
          (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        );
        assert.equal((await fixture.service.getSummary()).proposalCursor, 0);
      },
    );
  }
});

test("authoritative proposal evidence requeues graph work with trusted result context", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
  });
  const firstOutbox = fixture.store.stored().outbox[0];
  const waiting = (await fixture.service.listItems()).items[0];
  const boundTarget = fixture.store.stored().outbox[0].dispatchBinding
    .boundIntent.binding.evidenceTarget;
  assert.deepEqual(
    boundTarget,
    createDeliveryEvidenceTarget({
      taskId: waiting.itemId,
      roleId: "pr-reviewer",
      acceptanceContract: waiting.graph.acceptanceContracts.at(-1),
    }),
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const queued = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(queued.status, "queued");
  assert.equal(queued.statusReason, "proposal_evidence_ready");
  assert.equal(queued.activeIntentId, null);
  assert.deepEqual(
    {
      source: queued.decisionContext.source,
      referenceId: queued.decisionContext.referenceId,
      outcome: queued.decisionContext.outcome,
      value: queued.decisionContext.value,
      observedAt: queued.decisionContext.observedAt,
    },
    {
      source: "proposal",
      referenceId: result.proposalId,
      outcome: "succeeded",
      value: {
        kind: result.kind,
        resultId: result.resultId,
        resultDigest: result.contentDigest,
        summary: result.summary,
        downstreamRef: result.downstreamRef,
        evidence: result.evidence,
      },
      observedAt: result.at,
    },
  );
  assert.match(queued.decisionContext.contentDigest, /^[a-f0-9]{64}$/);

  const nextTurn = await fixture.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(nextTurn.decisionContext, queued.decisionContext);
  const continued = await fixture.service.stageIntent({
    itemId: nextTurn.itemId,
    expectedRevision: nextTurn.revision,
    leaseId: nextTurn.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  assert.notEqual(continued.outbox.intentId, firstOutbox.intentId);
  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    firstOutbox.intent.dispatchIntentId,
  );
});

test("a successful intervening proposal starts a new retry identity", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const { staged, claimed } = await prepareClaimedReviewIntent(fixture);
  const failedDispatchIntentId = staged.outbox.intent.dispatchIntentId;
  const bound = await fixture.service.bindIntent({
    intentId: claimed.intentId,
    expectedRevision: claimed.revision,
    itemExpectedRevision: staged.item.revision,
    dispatcherId: "work-intent-dispatcher",
    dispatchLeaseId: claimed.dispatchLeaseId,
    boundIntent: boundReviewIntent(staged.item),
  });
  await fixture.service.ackIntent({
    intentId: bound.intentId,
    expectedRevision: bound.revision,
    dispatchLeaseId: bound.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "failed",
    nextStatus: "retry_wait",
    availableAt: "2026-08-02T02:01:00.000Z",
    actorId: "work-intent-dispatcher",
    details: { code: "temporary-unavailable" },
  });
  fixture.time.advance(60_000);

  const result = await prepareProposalResult(fixture, {
    authoritativeEvidence: true,
    intentOverrides: {
      summary: "先提交另一份审查",
      body: "另一份独立审查。",
    },
  });
  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const continued = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });

  assert.notEqual(
    continued.outbox.intent.dispatchIntentId,
    failedDispatchIntentId,
  );
  const historicalFailure = (await fixture.service.listOutbox()).items.find(
    ({ intent }) => intent.dispatchIntentId === failedDispatchIntentId,
  );
  assert.equal(historicalFailure.status, "failed");
});

test("a bound code proposal id distinct from its staged intent completes work", async () => {
  const fixture = await createFixture({
    records: [assignment(1, { type: "role", id: "developer" })],
  });
  const result = await prepareProposalResult(fixture, {
    kind: "code_action_proposal",
  });

  assert.notEqual(
    fixture.store.stored().outbox[0].intentId,
    result.proposalId,
  );
  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.statusReason, "proposal_succeeded");
});

function authoredReviewRepairAssignment(sequence, overrides = {}) {
  const record = prAssignment(sequence, {
    gitFacts: {
      ...prGitFacts(overrides.headRefOid ?? PR_HEAD_A),
      relation: "authored",
      actionState: "action_now",
      nextAction: "address_review",
      reviewDecision: "CHANGES_REQUESTED",
      reviewFeedbackCount: 1,
    },
    ...overrides,
  });
  record.assignment.target = { type: "role", id: "developer" };
  record.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  record.assignment.reason = "authored-pr-self-fix";
  return record;
}

async function contractedInspectionFixture({ automatic = false } = {}) {
  const record = automatic
    ? prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })
    : ownerRequestedPrAssignment(1);
  if (!automatic) record.assignment.target = { type: "role", id: "orchestrator" };
  const fixture = await createFixture({ records: [record] });
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items[0];
  const command = prGraphChildCommand(
    root,
    (await fixture.service.getSummary()).revision,
    "inspect-and-verify",
  );
  command.command.acceptanceContract.expectedDeliverables = [
    { deliverableId: "implementation", kind: "change-package", description: "必要修改", required: false },
    { deliverableId: "verification", kind: "test-report", description: "受控验证", required: true },
  ];
  const child = await fixture.service.createGraphChild(command);
  const proposals = [];
  const dispatcher = new WorkIntentDispatcher({
    ledger: fixture.service,
    policy: createWorkIntentPolicy({
      version: 1,
      capabilityRoles: { development: "developer" },
      codeActionRoles: ["developer"],
      workspaceByRepository: { "acme/repo": "dashboard" },
    }),
    attentionProducer: { async create() { throw new Error("unexpected attention"); } },
    proposalProducer: {
      async create(value) {
        const proposal = normalizeBoundWorkProposal(value);
        proposals.push(proposal);
        return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest,
          kind: proposal.kind, status: "pending_delivery", revision: 1, createdAt: fixture.time.clock() };
      },
    },
    clock: fixture.time.clock,
  });
  async function dispatch(operation) {
    const current = await fixture.service.readItemForReconciliation({ itemId: child.taskId });
    const claimed = await fixture.service.claim({
      itemId: current.itemId, expectedRevision: current.revision,
      workerId: "employee-developer", leaseDurationMs: 30_000,
    });
    await fixture.service.stageIntent({
      itemId: claimed.itemId, expectedRevision: claimed.revision,
      leaseId: claimed.leaseId, actorId: "employee-developer", roleId: "developer",
      intent: codeActionIntent({ operation }),
    });
    assert.equal((await dispatcher.dispatchPending()).delivered, 1);
    return proposals.at(-1);
  }
  return { ...fixture, childId: child.taskId, dispatch };
}

test("contracted PR child inspection requeues for authoritative verification", async () => {
  const fixture = await contractedInspectionFixture();
  const original = await fixture.service.readItemForReconciliation({ itemId: fixture.childId });
  const proposal = await fixture.dispatch("inspect");
  assert.equal(Object.hasOwn(proposal.binding, "evidenceTarget"), false);
  const result = createWorkProposalResult({
    proposal, sequence: 1,
    transition: { status: "succeeded", summary: "只读检查完成，仍需验证", evidence: ["inspection-audit"] },
    downstreamRef: "inspection-confirmation", at: fixture.time.clock(),
  });
  await fixture.service.applyProposalBatch({
    items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1,
  });
  const queued = await fixture.service.readItemForReconciliation({ itemId: fixture.childId });
  assert.equal(queued.status, "queued");
  assert.equal(queued.activeIntentId, null);
  assert.deepEqual(queued.graph, original.graph);
  assert.deepEqual(currentWorkItemInputBinding(queued), currentWorkItemInputBinding(original));
  assert.equal(queued.decisionContext.referenceId, proposal.proposalId);
  assert.equal(queued.decisionContext.value.resultDigest, result.contentDigest);
  assert.deepEqual(queued.decisionContext.value.evidence, result.evidence);

  const verification = await fixture.dispatch("verify");
  assert.deepEqual(verification.binding.inputBinding, proposal.binding.inputBinding);
  assert.deepEqual(verification.binding.evidenceTarget, createDeliveryEvidenceTarget({
    taskId: fixture.childId, roleId: "developer",
    acceptanceContract: queued.graph.acceptanceContracts.at(-1), deliverableId: "verification",
  }));
});

test("contracted PR child inspection failures and stale outcomes stay blocked", async (t) => {
  for (const outcome of ["failed", "stale"]) {
    await t.test(outcome, async () => {
      const fixture = await contractedInspectionFixture();
      const proposal = await fixture.dispatch("inspect");
      const result = createWorkProposalResult({
        proposal, sequence: 1,
        transition: { status: outcome, summary: `Inspection ${outcome}`, evidence: [] },
        downstreamRef: "inspection-confirmation", at: fixture.time.clock(),
      });
      await fixture.service.applyProposalBatch({
        items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1,
      });
      const item = await fixture.service.readItemForReconciliation({ itemId: fixture.childId });
      assert.equal(item.status, "blocked");
      assert.equal(item.statusReason, `proposal_${outcome}`);
      assert.deepEqual(item.graph.deliveries, []);
    });
  }
});

test("contracted PR child inspection settles without reviving a pending newer Head", async () => {
  const fixture = await contractedInspectionFixture({ automatic: true });
  const proposal = await fixture.dispatch("inspect");
  const updated = prAssignment(2, {
    occurredAt: "2026-08-02T01:15:00.000Z",
    headRefOid: PR_HEAD_B,
    gitFacts: prGitFacts(PR_HEAD_B),
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  });
  fixture.source.records.push(updated);
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const root = (await fixture.service.listItems()).items.find((item) => item.kind === "source_root");
  assert.notEqual(root.source.pendingRevision, null);
  const result = createWorkProposalResult({
    proposal, sequence: 1,
    transition: { status: "succeeded", summary: "旧 Head 检查完成", evidence: ["inspection-audit"] },
    downstreamRef: "inspection-confirmation", at: fixture.time.clock(),
  });

  await fixture.service.applyProposalBatch({
    items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1,
  });

  const item = await fixture.service.readItemForReconciliation({ itemId: fixture.childId });
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "proposal_source_stale");
  assert.equal(item.activeIntentId, null);
  assert.deepEqual(item.graph.deliveries, []);
  assert.equal(item.decisionContext.referenceId, proposal.proposalId);

  const pending = await fixture.service.readItemForReconciliation({ itemId: root.itemId });
  const activated = await fixture.service.reconcilePullRequestSource({
    itemId: pending.itemId, expectedRevision: pending.revision,
    expectedGraphRevision: (await fixture.service.getSummary()).revision,
    expectedPendingRevision: pending.source.pendingRevision,
  });
  assert.equal(activated.applied, true);
  const current = await fixture.service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(current.source.pendingRevision, null);
  assert.equal(current.source.current.headRefOid, PR_HEAD_B);
  const oldChild = await fixture.service.readItemForReconciliation({ itemId: fixture.childId });
  assert.notEqual(oldChild.status, "queued");
  assert.deepEqual(oldChild.graph.deliveries, []);
});

async function deliverRepairRoleHandoff(f, targetRole) {
  let item = (await f.service.listItems()).items[0];
  const roleId = item.currentTarget.id;
  item = await f.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: `employee-${roleId}`, leaseDurationMs: 30000 });
  await f.service.stageIntent({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: `employee-${roleId}`, roleId, intent: handoffIntent({
      capability: targetRole === 'pr-engineer' ? 'pr-review' : 'development', brief: 'Continue the bound repair with the recorded evidence' }) });
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: createWorkIntentPolicy({ capabilityRoles: { 'pr-review': 'pr-engineer', development: 'developer' } }),
    attentionProducer: { create: async () => assert.fail('Unexpected attention') },
    proposalProducer: { create: async () => assert.fail('Unexpected proposal') } });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  return f.service.readItemForReconciliation({ itemId: item.itemId });
}

test('a trusted repair role handoff starts the receiving roles own decision budget in both directions', async () => {
  const f = await createFixture({ records: [authoredReviewRepairAssignment(1, { gitFacts: {
    ...prGitFacts(PR_HEAD_A), relation: 'authored', actionState: 'action_now', nextAction: 'fix_ci', isDraft: true,
  } })] });
  await f.service.intake();
  for (const target of ['pr-engineer', 'developer']) {
    let item = await deliverRepairRoleHandoff(f, target);
    const offset = item.attempt;
    item = await f.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: `employee-${target}`, leaseDurationMs: 30000 });
    const budget = await f.service.readRepairDecisionBudget({ itemId: item.itemId, expectedRevision: item.revision });
    assert.equal(budget?.attempt, 1, target);
    assert.equal(budget.offset, offset);
    assert.equal(item.attempt, offset + 1);
    const { repairDecisionAttemptBudget } = await import('../src/services/work-ledger-inspection-continuation.js');
    const durable = f.store.stored();
    for (const variant of ['dispatch-seal', 'source-binding', 'unacknowledged', 'wrong-target', 'missing-stage', 'manual-scope']) {
      const state = clone(durable), root = state.items.find(x => x.itemId === item.itemId);
      const box = state.outbox.findLast(x => x.itemId === item.itemId && x.intent.type === 'handoff');
      const handedOff = state.timeline.findLast(x => x.itemId === item.itemId && x.type === 'handed_off');
      if (variant === 'dispatch-seal') box.dispatchBinding.bindingDigest = 'f'.repeat(64);
      if (variant === 'source-binding') box.sourceBinding.inputDigest = 'f'.repeat(64);
      if (variant === 'unacknowledged') box.status = 'dispatching';
      if (variant === 'wrong-target') handedOff.details.toTarget.id = 'tester';
      if (variant === 'missing-stage') state.timeline = state.timeline.filter(x => x.type !== 'intent_staged');
      if (variant === 'manual-scope') root.source.scope.kind = 'owner_requested';
      assert.equal(repairDecisionAttemptBudget(state, root), null, variant);
    }
    // Return the claim without consuming another model attempt before the next handoff.
    await f.service.scheduleRetry({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
      actorId: `employee-${target}`, availableAt: new Date(Date.parse(f.time.clock()) + 1000).toISOString(),
      consumeAttempt: false, reason: 'context_changed' });
    f.time.advance(1000);
  }
});

test('an internal own-repair review inspection continues developer work instead of completing the review root', async () => {
  const f = await exhaustedInternalReviewFactsFixture({ attempts: 1 });
  const root = (await f.service.listItems()).items[0];
  await f.service.transition({ itemId: root.itemId, expectedRevision: root.revision, leaseId: null,
    actorId: 'work-ledger-system', toStatus: 'queued', reason: 'fixture_context_available' });
  const item = await deliverRepairRoleHandoff(f, 'developer');
  const result = await prepareProposalResult(f, { kind: 'code_action_proposal', itemId: item.itemId,
    sealSource: true, intentOverrides: { operation: 'inspect' } });
  await f.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const current = await f.service.readItemForReconciliation({ itemId: item.itemId });
  assert.equal(current.status, 'queued');
  assert.equal(current.currentTarget.id, 'developer');
  const discovery = authoredReviewRepairAssignment(2, { headRefOid: PR_HEAD_B, occurredAt: f.time.clock(), gitFacts: {
    ...prGitFacts(PR_HEAD_B), gitTarget: clone(current.source.current.event.payload.gitTarget),
    relation: 'authored', actionState: 'action_now', nextAction: 'fix_ci',
  } });
  f.source.records.push(discovery);
  f.source.highWatermark = 2;
  await f.service.intake();
  const withDiscovery = f.store.stored();
  Object.assign(withDiscovery.items.find(x => x.itemId === current.itemId), { status: 'completed', statusReason: 'proposal_succeeded' });
  const automatic = withDiscovery.items.find(x => x.itemId !== current.itemId && x.source?.scope.kind === 'automatic');
  assert.ok(automatic);
  automatic.status = 'blocked'; automatic.statusReason = 'pr_source_authority_fenced';
  const { completedRepairEvidenceRecoveryProof } = await import('../src/services/work-ledger-inspection-continuation.js');
  const completed = withDiscovery.items.find(x => x.itemId === current.itemId);
  assert.equal(pullRequestHeadAdmission(withDiscovery, completed).current, false, 'false completion released authority to discovery');
  assert.equal(completedRepairEvidenceRecoveryProof(withDiscovery, completed)?.reason, 'pr_internal_review_evidence_continued');
  for (const variant of ['active-replacement', 'owner-hold', 'unknown-effect', 'retained-result']) {
    const state = clone(withDiscovery), other = state.items.find(x => x.itemId === automatic.itemId);
    if (variant === 'active-replacement') { other.status = 'working'; other.ownerId = 'another-worker'; }
    if (variant === 'owner-hold') { other.status = 'paused'; other.statusReason = 'owner_task_run_pause'; }
    if (variant === 'unknown-effect') state.outbox.push({ itemId: other.itemId, status: 'unknown' });
    if (variant === 'retained-result') other.decisionContext = { source: 'proposal', outcome: 'succeeded' };
    assert.equal(completedRepairEvidenceRecoveryProof(state, state.items.find(x => x.itemId === current.itemId)), null, variant);
  }
  // Retain the real authority history when simulating the old completion bug.
  const { appendWorkGraphMemoryEvents } = await import('../src/services/work-ledger-graph-memory.js');
  withDiscovery.graphMemoryProjection = appendWorkGraphMemoryEvents(f.store.stored(), withDiscovery,
    normalizeWorkLedgerLimits()).graphMemoryProjection;
  f.store.replaceStored(withDiscovery);
  const restarted = await createFixture({ store: f.store, source: f.source, time: f.time });
  const recovered = await restarted.service.readItemForReconciliation({ itemId: current.itemId });
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.statusReason, 'pr_internal_review_evidence_continued');
  assert.equal(recovered.attempt, current.attempt);
});

for (const operation of ['inspect', 'verify']) {
test(`successful repair ${operation} opens the next decision budget while retaining lifetime claims`, async () => {
  const f = await createFixture({ records: [authoredReviewRepairAssignment(1, { gitFacts: {
    ...prGitFacts(PR_HEAD_A), relation: 'authored', actionState: 'action_now', nextAction: 'fix_ci', isDraft: true,
  } })] });
  const result = await prepareProposalResult(f, { kind: 'code_action_proposal', sealSource: true, intentOverrides: { operation } });
  await f.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  let item = (await f.service.listItems()).items[0];
  const progressAttempt = item.attempt;
  item = await f.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId: 'employee-developer', leaseDurationMs: 30000 });
  const budget = await f.service.readRepairDecisionBudget({ itemId: item.itemId, expectedRevision: item.revision });
  assert.equal(budget.attempt, 1);
  assert.equal(budget.offset, progressAttempt);
  assert.equal(item.attempt, progressAttempt + 1);
  assert.equal(await f.service.readRepairDecisionBudget({ itemId: item.itemId, expectedRevision: item.revision - 1 }), null);
  await f.service.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: 'employee-developer', toStatus: 'blocked', reason: 'decision_attempts_exhausted',
    details: { code: 'ROLE_DECISION_PR_REVIEW_REQUIRED' } });
  item = await f.service.readItemForReconciliation({ itemId: item.itemId });
  const failedBudget = await f.service.readRepairDecisionBudget({ itemId: item.itemId, expectedRevision: item.revision });
  assert.equal(failedBudget.attempt, 1);
  assert.equal(failedBudget.failure.code, 'ROLE_DECISION_PR_REVIEW_REQUIRED');
  assert.equal(failedBudget.failure.leaseId, budget.claimLeaseId);
  const { repairDecisionAttemptBudget } = await import('../src/services/work-ledger-inspection-continuation.js');
  const durable = f.store.stored();
  for (const variant of ['manual', 'inactive', 'paused', 'changed-role', 'unknown-intent', 'missing-seal',
    'changed-result', 'missing-claim', 'changed-claim-input']) {
    const state = clone(durable), root = state.items.find(x => x.itemId === item.itemId);
    if (variant === 'manual') root.source.scope.kind = 'owner_requested';
    if (variant === 'inactive') root.source.scope.active = false;
    if (variant === 'paused') root.status = 'paused';
    if (variant === 'changed-role') root.currentTarget.id = 'pr-engineer';
    if (variant === 'unknown-intent') root.activeIntentId = 'unknown-intent';
    if (variant === 'missing-seal') delete state.outbox[0].outcome.details.resultAttestation;
    if (variant === 'changed-result') root.decisionContext.value.resultDigest = 'f'.repeat(64);
    if (variant === 'missing-claim') state.timeline = state.timeline.filter(x => x.type !== 'claimed');
    if (variant === 'changed-claim-input') state.timeline.find(x => x.type === 'claimed').details.inputDigest = 'f'.repeat(64);
    assert.equal(repairDecisionAttemptBudget(state, root), null, variant);
  }
});
}

for (const nextAction of ["resolve_conflict", "fix_ci"]) {
for (const operation of nextAction === "fix_ci" ? ["inspect", "verify"] : ["inspect"]) {
for (const isDraft of [false, true]) {
test(`own PR ${nextAction} ${operation} continues and a historical evidence-only completion recovers once (Draft=${isDraft})`, async () => {
  const fixture = await createFixture({ records: [authoredReviewRepairAssignment(1, { gitFacts: {
    ...prGitFacts(PR_HEAD_A), relation: "authored", actionState: "action_now", nextAction, isDraft,
  } })] });
  const result = await prepareProposalResult(fixture, { kind: "code_action_proposal", sealSource: true,
    intentOverrides: { operation } });
  await fixture.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const original = (await fixture.service.listItems()).items[0];
  assert.equal(original.status, "queued", "read-only evidence is not completion of PR repair");
  const durable = fixture.store.stored();
  const old = durable.items.find(i => i.itemId === original.itemId);
  old.status = "completed"; old.statusReason = "proposal_succeeded";
  fixture.store.replaceStored(durable);
  const recovered = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  const current = (await recovered.service.listItems()).items[0];
  assert.equal(current.status, "queued");
  assert.equal(current.statusReason, nextAction === "fix_ci"
    ? operation === "verify" ? "pr_ci_verification_continued" : "pr_ci_inspection_continued"
    : "pr_conflict_inspection_continued");
  assert.equal(current.attempt, original.attempt, "recovery does not reset the decision budget");
  const restarted = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
  assert.equal((await restarted.service.listItems()).items[0].revision, current.revision);
});

}
}
}

test('automatic repair recovers a spent lifetime budget after sealed progress and still bounds consecutive failures', async () => {
  for (const [roleId, failureCode] of [['developer', 'ROLE_DECISION_PR_REVIEW_REQUIRED'], ['pr-engineer', 'ROLE_DECISION_INTERNAL_REVIEW_ONLY']]) {
  for (const variant of ['current', 'owner-paused', 'unknown-stop', 'running-turn', 'old-receipt']) {
    const f = await createFixture({ records: [authoredReviewRepairAssignment(1, { gitFacts: {
      ...prGitFacts(PR_HEAD_A), relation: 'authored', actionState: 'action_now', nextAction: 'fix_ci', isDraft: true,
    } })] });
    const result = await prepareProposalResult(f, { kind: 'code_action_proposal', sealSource: true,
      intentOverrides: { operation: 'verify' } });
    await f.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
    if (roleId === 'pr-engineer') await deliverRepairRoleHandoff(f, roleId);
    let item = (await f.service.listItems()).items[0];
    item = await f.service.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: `employee-${roleId}`, leaseDurationMs: 30000 });
    const failedClaim = item;
    await f.service.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
      actorId: `employee-${roleId}`, toStatus: 'blocked', reason: 'decision_attempts_exhausted',
      details: { code: failureCode } });
    const before = await f.service.readItemForReconciliation({ itemId: item.itemId });
    let modelCalls = 0;
    const loop = new ProactiveWorkLoop({ ledger: f.service, clock: f.time.clock, maxAttempts: 3,
      retryBaseMs: 1000, retryMaxMs: 8000, automaticOwnPrRepair: { shouldRun: async () => true },
      taskRuns: { order: async items => items, run: async (_task, operation) => operation({ instructions: [] }),
        get: async () => ({ active: false, phase: 'failed', mode: variant === 'owner-paused' ? 'paused' : 'active',
          pendingCommand: null, stopUnconfirmed: variant === 'unknown-stop', receipt: { kind: 'work-item',
            taskId: item.itemId, roleId, phase: 'failed', runId: 'failed-decision-run',
            taskRevision: variant === 'old-receipt' ? failedClaim.revision - 1 : failedClaim.revision,
            leaseId: failedClaim.leaseId, outcomeCode: failureCode, stopConfirmed: false,
            registeredAt: f.time.clock(), modelStartedAt: f.time.clock(), finishedAt: f.time.clock(),
            session: { transport: 'app-server', status: variant === 'running-turn' ? 'running' : 'completed' } } }) },
      roleDirectory: { resolve: async () => ({ roleId, workerId: `employee-${roleId}`, enabled: true, paused: false,
        decide: async ({ context }) => { modelCalls++;
          assert.equal(context.requirements.repairDecisionRecovery.code, failureCode);
          throw Object.assign(new Error('A further invalid completion'), { code: failureCode }); } }) },
      roleContextAssembler: { assemble: async () => ({ context: { requirements: {}, code: {} } }) },
      orchestratorService: { execute: async () => assert.fail('Unexpected orchestration') } });
    const cycle = await loop.runCycle({ roleId });
    if (variant !== 'current') {
      assert.equal(cycle.claimed, 0, variant);
      assert.equal(modelCalls, 0, variant);
      assert.deepEqual(await f.service.readItemForReconciliation({ itemId: item.itemId }), before, variant);
      continue;
    }
    assert.equal(cycle.claimed, 1);
    assert.equal(cycle.retried, 1, 'successful verification must not consume the next failure budget');
    item = await f.service.readItemForReconciliation({ itemId: item.itemId });
    assert.equal(item.attempt, failedClaim.attempt + 1, 'lifetime claims are retained');
    f.time.advance(8000);
    assert.equal((await loop.runCycle({ roleId })).blocked, 1);
    item = await f.service.readItemForReconciliation({ itemId: item.itemId });
    assert.equal(item.attempt, failedClaim.attempt + 2);
    assert.equal((await loop.runCycle({ roleId })).claimed, 0);
    assert.equal(modelCalls, 2, 'no new successful progress means no further retries');
  }
  }
});

for (const nextAction of ["resolve_conflict", "fix_ci"]) {
test(`${nextAction} continuation never reopens a completed modification, Draft review repair or owner-stopped task`, async () => {
  for (const variant of ["modify", "verify-other", "draft", "paused", "cancelled"]) {
    const fixture = await createFixture({ records: [authoredReviewRepairAssignment(1, { gitFacts: {
      ...prGitFacts(PR_HEAD_A), relation: "authored", actionState: "action_now", nextAction: ["draft", "verify-other"].includes(variant) ? "address_review" : nextAction, isDraft: variant === "draft",
    } })] });
    const result = await prepareProposalResult(fixture, { kind: "code_action_proposal", sealSource: true,
      intentOverrides: { operation: variant === "modify" ? "modify" : variant === "verify-other" ? "verify" : "inspect" } });
    await fixture.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
    if (["paused", "cancelled"].includes(variant)) {
      const durable = fixture.store.stored();
      durable.items[0].status = variant; durable.items[0].statusReason = `owner_task_run_${variant}`;
      fixture.store.replaceStored(durable);
    }
    const recovered = await createFixture({ store: fixture.store, source: fixture.source, time: fixture.time });
    assert.equal((await recovered.service.listItems()).items[0].status, ["paused", "cancelled"].includes(variant) ? variant : "completed", variant);
  }
});
}

test("stale creation settlement does not cancel an existing job or treat an unavailable reader as absence", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  const snapshot = clone(fixture.snapshot);
  snapshot.item.status = "stale"; snapshot.item.receipt = null;
  fixture.replaceSnapshot(snapshot);
  let cancelled = 0;
  const readOnly = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async () => { cancelled += 1; assert.fail("stale admission only permits a read"); } } });
  fixture.service.obsoleteCodeJobSettler = readOnly;
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
  assert.equal(cancelled, 0);
  fixture.service.obsoleteCodeJobSettler = { read: async () => undefined, settle: async () => null };
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
});

test("own PR review repair continues after successful inspection without a graph evidence target", async () => {
  const fixture = await createFixture({
    records: [authoredReviewRepairAssignment(1)],
  });
  const result = await prepareProposalResult(fixture, {
    kind: "code_action_proposal",
    sealSource: true,
    intentOverrides: { operation: "inspect" },
  });
  const original = (await fixture.service.listItems()).items[0];
  assert.equal(original.source.kind, "pull_request");
  assert.equal(
    fixture.store.stored().outbox[0].dispatchBinding.boundIntent.binding
      .evidenceTarget,
    undefined,
  );

  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const queued = (await fixture.service.listItems()).items[0];
  assert.equal(queued.itemId, original.itemId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.statusReason, "proposal_evidence_ready");
  assert.equal(queued.activeIntentId, null);
  assert.equal(queued.decisionContext.referenceId, result.proposalId);
  assert.equal(queued.decisionContext.value.resultDigest, result.contentDigest);
  assert.deepEqual(queued.decisionContext.value.evidence, result.evidence);

  const restarted = await createFixture({
    records: fixture.source.records,
    store: fixture.store,
  });
  const nextTurn = await restarted.service.claim({
    itemId: queued.itemId,
    expectedRevision: queued.revision,
    workerId: "employee-developer",
    leaseDurationMs: 30_000,
  });
  assert.deepEqual(nextTurn.decisionContext, queued.decisionContext);
  const modification = await restarted.service.stageIntent({
    itemId: nextTurn.itemId,
    expectedRevision: nextTurn.revision,
    leaseId: nextTurn.leaseId,
    actorId: "employee-developer",
    roleId: "developer",
    intent: codeActionIntent(),
  });
  assert.notEqual(modification.outbox.intentId, original.activeIntentId);
});

test("own PR review repair inspection failures and stale outcomes stay blocked", async (t) => {
  for (const outcome of ["failed", "stale", "unknown", "rejected"]) {
    await t.test(outcome, async () => {
      const fixture = await createFixture({
        records: [authoredReviewRepairAssignment(1)],
      });
      const result = await prepareProposalResult(fixture, {
        kind: "code_action_proposal",
        sealSource: true,
        intentOverrides: { operation: "inspect" },
        outcome,
      });
      await fixture.service.applyProposalBatch({
        items: [result],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
      const item = (await fixture.service.listItems()).items[0];
      assert.equal(item.status, "blocked");
      assert.equal(item.statusReason, `proposal_${outcome}`);
      assert.equal(item.decisionContext.outcome, outcome);
    });
  }
});

test("own PR inspection does not continue repair against a pending newer Head", async () => {
  const fixture = await createFixture({
    records: [authoredReviewRepairAssignment(1)],
  });
  const result = await prepareProposalResult(fixture, {
    kind: "code_action_proposal",
    sealSource: true,
    intentOverrides: { operation: "inspect" },
  });
  fixture.source.records.push(authoredReviewRepairAssignment(2, {
    occurredAt: "2026-08-02T01:05:00.000Z",
    headRefOid: PR_HEAD_B,
    previousHeadRefOid: PR_HEAD_A,
    changedFields: ["headRefOid"],
  }));
  fixture.source.highWatermark = 2;
  await fixture.service.intake();
  const waiting = (await fixture.service.listItems()).items[0];
  assert.notEqual(waiting.source.pendingRevision, null);
  assert.equal(waiting.source.current.headRefOid, PR_HEAD_A);

  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const settled = (await fixture.service.listItems()).items[0];
  assert.equal(settled.status, "completed");
  assert.equal(settled.statusReason, "proposal_succeeded");
  assert.equal(settled.source.current.headRefOid, PR_HEAD_A);
  assert.notEqual(settled.source.pendingRevision, null);
});

test("successful inspection alone still completes ordinary analysis and final code operations", async (t) => {
  const cases = [
    {
      name: "ordinary Issue inspection",
      record: assignment(1, { type: "role", id: "developer" }),
      operation: "inspect",
      sealSource: false,
    },
    {
      name: "owner requested PR inspection",
      record: (() => {
        const record = ownerRequestedPrAssignment(1);
        record.assignment.target = { type: "role", id: "developer" };
        return record;
      })(),
      operation: "inspect",
      sealSource: true,
    },
    {
      name: "unsealed own PR inspection",
      record: authoredReviewRepairAssignment(1),
      operation: "inspect",
      sealSource: false,
    },
    ...["modify", "verify"].map((operation) => ({
      name: `own PR ${operation}`,
      record: authoredReviewRepairAssignment(1),
      operation,
      sealSource: true,
    })),
  ];
  for (const { name, record, operation, sealSource } of cases) {
    await t.test(name, async () => {
      const fixture = await createFixture({ records: [record] });
      const result = await prepareProposalResult(fixture, {
        kind: "code_action_proposal",
        sealSource,
        intentOverrides: { operation },
      });
      await fixture.service.applyProposalBatch({
        items: [result],
        nextSequence: 1,
        highWatermark: 1,
        oldestAvailableSequence: 1,
      });
      const item = (await fixture.service.listItems()).items[0];
      assert.equal(item.status, "completed");
      assert.equal(item.statusReason, "proposal_succeeded");
    });
  }
});

test("a PR external action result settles only its trusted external-action intent", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, {
    kind: "github_pull_request_action_proposal",
  });
  const stored = fixture.store.stored().outbox[0];
  assert.equal(
    stored.intent.type,
    "propose_github_pull_request_action",
  );
  assert.match(
    stored.intent.dispatchIntentId,
    /^work-dispatch-intent-[a-f0-9]{64}$/,
  );

  const applied = await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];

  assert.equal(applied.applied, 1);
  assert.equal(item.status, "completed");
  assert.equal(item.statusReason, "proposal_succeeded");
});

test("proposal results reject forged downstream and digest bindings", async (t) => {
  for (const field of ["downstreamRef", "proposalDigest"]) {
    await t.test(field, async () => {
      const fixture = await createFixture({ records: [assignment(1)] });
      const result = await prepareProposalResult(fixture, {
        ...(field === "downstreamRef"
          ? { downstreamRef: `work-intent-${"d".repeat(64)}` }
          : { proposalDigest: "d".repeat(64) }),
      });

      await assert.rejects(
        fixture.service.applyProposalBatch({
          items: [result],
          nextSequence: 1,
          highWatermark: 1,
          oldestAvailableSequence: 1,
        }),
        (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
      );
      assert.equal((await fixture.service.listItems()).items[0].status, "waiting_external");
    });
  }
});

test("proposal results fail closed when two outbox records claim one downstream", async () => {
  const fixture = await createFixture({
    records: [assignment(1), assignment(2)],
  });
  await fixture.service.intake();
  const items = (await fixture.service.listItems()).items;
  const proposal = normalizeBoundWorkProposal({
    proposalId: `work-intent-${"e".repeat(64)}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: items[0].itemId,
    },
    source: {
      assignmentId: items[0].assignmentId,
      eventId: items[0].event.eventId,
    },
    binding: { repository: "acme/repo", pullRequestNumber: 1 },
    payload: { verdict: "approve", body: "本地审查通过。" },
  });

  for (const [index, item] of items.entries()) {
    const claimedItem = await fixture.service.claim({
      itemId: item.itemId,
      expectedRevision: item.revision,
      workerId: "employee-pr-reviewer",
      leaseDurationMs: 30_000,
    });
    const staged = await fixture.service.stageIntent({
      itemId: claimedItem.itemId,
      expectedRevision: claimedItem.revision,
      leaseId: claimedItem.leaseId,
      actorId: "employee-pr-reviewer",
      roleId: "pr-reviewer",
      intent: reviewIntent({ body: `本地审查通过 ${index + 1}。` }),
    });
    const claimedIntent = await fixture.service.claimIntent({
      intentId: staged.outbox.intentId,
      expectedRevision: staged.outbox.revision,
      dispatcherId: "work-intent-dispatcher",
      leaseDurationMs: 30_000,
    });
    await fixture.service.ackIntent({
      intentId: claimedIntent.intentId,
      expectedRevision: claimedIntent.revision,
      dispatchLeaseId: claimedIntent.dispatchLeaseId,
      itemExpectedRevision: staged.item.revision,
      outcome: "delivered",
      nextStatus: "waiting_external",
      actorId: "work-intent-dispatcher",
      details: {
        downstreamRef: proposal.proposalId,
        proposalDigest: proposal.contentDigest,
      },
    });
  }
  const result = createWorkProposalResult({
    proposal,
    sequence: 1,
    transition: {
      status: "succeeded",
      summary: "提案已成功",
      evidence: [],
    },
    downstreamRef: "confirmation-1",
    at: fixture.time.clock(),
  });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [result],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
  );
  assert.deepEqual(
    (await fixture.service.listItems()).items.map(({ status }) => status),
    ["waiting_external", "waiting_external"],
  );
});

test("a failed proposal blocks work while gaps and binding changes fail closed", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const result = await prepareProposalResult(fixture, { outcome: "unknown" });

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [],
      nextSequence: 0,
      highWatermark: 1,
      oldestAvailableSequence: 2,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_GAP",
  );
  assert.equal((await fixture.service.getSummary()).proposalCursor, 0);

  await assert.rejects(
    fixture.service.applyProposalBatch({
      items: [{ ...result, proposalContentDigest: "0".repeat(64) }],
      nextSequence: 1,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    }),
    (error) => error.code === "WORK_LEDGER_PROPOSAL_BATCH_INVALID",
  );

  await fixture.service.applyProposalBatch({
    items: [result],
    nextSequence: 1,
    highWatermark: 1,
    oldestAvailableSequence: 1,
  });
  const item = (await fixture.service.listItems()).items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.statusReason, "proposal_unknown");
});

test("work ledger recovers schema v1 state with an empty proposal checkpoint", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 1;
  delete legacy.graphMemoryProjection;
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  fixture.store.replaceStored(legacy);
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  const summary = await recovered.recover();

  assert.equal(summary.proposalCursor, 0);
  assert.equal(summary.proposalHighWatermark, 0);
  assert.equal(summary.intakeCursor, 1);
});

test("schema v2 migration is lazy and preserves an active outbox through its next write", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: reviewIntent(),
  });
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const entry of legacy.items) {
    delete entry.graph;
    delete entry.source;
    delete entry.sourceQuarantine;
  }
  for (const entry of legacy.outbox) {
    delete entry.dispatchBinding;
    delete entry.sourceBinding;
    delete entry.brainRecovery;
  }
  fixture.store.replaceStored(legacy);
  const writesBeforeRecovery = fixture.store.writes.length;
  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });

  await recovered.recover();

  assert.equal(fixture.store.writes.length, writesBeforeRecovery);
  assert.equal(fixture.store.stored().schemaVersion, 2);
  const recoveredItem = (await recovered.listItems()).items[0];
  const recoveredOutbox = (await recovered.listOutbox()).items[0];
  assert.equal(recoveredItem.itemId, staged.item.itemId);
  assert.equal(recoveredItem.revision, staged.item.revision);
  assert.equal(recoveredItem.activeIntentId, staged.outbox.intentId);
  assert.deepEqual(recoveredItem.graph, {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [],
        recordedAt: recoveredItem.createdAt,
      },
    ],
    deliveries: [],
  });
  assert.equal(recoveredOutbox.intentId, staged.outbox.intentId);

  const claimed = await recovered.claimIntent({
    intentId: recoveredOutbox.intentId,
    expectedRevision: recoveredOutbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });

  assert.equal(claimed.status, "dispatching");
  assert.equal(
    fixture.store.stored().schemaVersion,
    WORK_LEDGER_STATE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    fixture.store.stored().items[0].graph,
    recoveredItem.graph,
  );
});

test("schema v2 keeps its original byte budget while graph metadata stays separately bounded", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  const legacyBytes = Buffer.byteLength(
    `${JSON.stringify(legacy, null, 2)}\n`,
    "utf8",
  );
  const exactStore = new MemoryStore({ [STATE_KEY]: legacy });
  const recovered = new WorkLedgerService({
    store: exactStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes },
  });

  await recovered.recover();
  assert.equal((await recovered.listItems()).items.length, 1);
  assert.equal(exactStore.stored().schemaVersion, 2);
  assert.equal(exactStore.writes.length, 0);

  const undersizedStore = new MemoryStore({ [STATE_KEY]: legacy });
  const undersized = new WorkLedgerService({
    store: undersizedStore,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
    limits: { stateByteBudget: legacyBytes - 1 },
  });
  await assert.rejects(
    undersized.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersizedStore.stored(), legacy);
  assert.equal(undersizedStore.writes.length, 0);
});

test("schema v2 keeps the original per-item byte budget during migration", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  await fixture.service.intake();
  const legacy = fixture.store.stored();
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  const legacyItemBytes = Buffer.byteLength(
    `${JSON.stringify(legacy.items[0], null, 2)}\n`,
    "utf8",
  );
  const createRecovered = (itemByteBudget) => {
    const store = new MemoryStore({ [STATE_KEY]: legacy });
    const service = new WorkLedgerService({
      store,
      assignmentSource: fixture.source,
      exclusiveLease: new ExclusiveLease(),
      clock: fixture.time.clock,
      idFactory: incrementingIds(),
      limits: { itemByteBudget },
    });
    return { service, store };
  };
  const exact = createRecovered(legacyItemBytes);

  await exact.service.recover();

  assert.equal((await exact.service.listItems()).items.length, 1);
  assert.equal(exact.store.writes.length, 0);

  const undersized = createRecovered(legacyItemBytes - 1);
  await assert.rejects(
    undersized.service.recover(),
    (error) => error.code === "WORK_LEDGER_STATE_CORRUPTED",
  );
  assert.deepEqual(undersized.store.stored(), legacy);
  assert.equal(undersized.store.writes.length, 0);
});

async function prepareWaitingCondition(fixture, condition) {
  await fixture.service.intake();
  let item = (await fixture.service.listItems()).items[0];
  item = await fixture.service.claim({
    itemId: item.itemId,
    expectedRevision: item.revision,
    workerId: "employee-pr-reviewer",
    leaseDurationMs: 30_000,
  });
  const staged = await fixture.service.stageIntent({
    itemId: item.itemId,
    expectedRevision: item.revision,
    leaseId: item.leaseId,
    actorId: "employee-pr-reviewer",
    roleId: "pr-reviewer",
    intent: waitIntent(condition),
  });
  const dispatch = await fixture.service.claimIntent({
    intentId: staged.outbox.intentId,
    expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher",
    leaseDurationMs: 30_000,
  });
  const acknowledged = await fixture.service.ackIntent({
    intentId: dispatch.intentId,
    expectedRevision: dispatch.revision,
    dispatchLeaseId: dispatch.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision,
    outcome: "delivered",
    nextStatus: "waiting_condition",
    actorId: "work-intent-dispatcher",
    details: {
      conditionRef: `bound-${dispatch.intentId}`,
      downstreamRef: `bound-${dispatch.intentId}`,
    },
  });
  return { item: acknowledged.item, intentId: staged.outbox.intentId };
}

test("condition wake is atomically bound, durable, and idempotent", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const input = {
    itemId: waiting.item.itemId,
    expectedRevision: waiting.item.revision,
    intentId: waiting.intentId,
    actorId: "work-condition-waker",
    observation: {
      kind: "workflow_fact",
      fact: "ci-status",
      value: "success",
      observedAt: "2026-08-02T02:00:00.000Z",
    },
  };

  const woken = await fixture.service.wakeCondition(input);
  assert.equal(woken.status, "queued");
  assert.equal(woken.activeIntentId, null);
  assert.equal(woken.decisionContext.source, "condition");
  assert.deepEqual(woken.decisionContext.value, {
    fact: "ci-status",
    kind: "workflow_fact",
    value: "success",
  });

  const writesBeforeReplay = fixture.store.writes.length;
  const replay = await fixture.service.wakeCondition(input);
  assert.equal(replay.itemId, woken.itemId);
  assert.equal(fixture.store.writes.length, writesBeforeReplay);

  const recovered = new WorkLedgerService({
    store: fixture.store,
    assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(),
    clock: fixture.time.clock,
    idFactory: incrementingIds(),
  });
  await recovered.recover();
  assert.deepEqual(
    (await recovered.listItems()).items[0].decisionContext,
    woken.decisionContext,
  );
});

test("graph recovery reads a condition wake that lost its durable acknowledgement", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const before = await fixture.service.getGraphSnapshot();
  const durableWrite = fixture.store.write.bind(fixture.store);
  let loseAcknowledgement = true;
  fixture.store.write = async (...args) => {
    await durableWrite(...args);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("durable acknowledgement lost");
    }
  };

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "success",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );

  const recovered = await fixture.service.getGraphSnapshot();
  assert.equal(recovered.graph.revision, before.graph.revision + 1);
  assert.equal(recovered.graph.tasks[0].revision, waiting.item.revision + 1);
});

test("an unmatched condition observation writes nothing", async () => {
  const fixture = await createFixture({ records: [assignment(1)] });
  const waiting = await prepareWaitingCondition(fixture, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  const writesBefore = fixture.store.writes.length;

  await assert.rejects(
    fixture.service.wakeCondition({
      itemId: waiting.item.itemId,
      expectedRevision: waiting.item.revision,
      intentId: waiting.intentId,
      actorId: "work-condition-waker",
      observation: {
        kind: "workflow_fact",
        fact: "ci-status",
        value: "failure",
        observedAt: "2026-08-02T02:00:00.000Z",
      },
    }),
    (error) => error.code === "WORK_LEDGER_CONDITION_OBSERVATION_INVALID",
  );
  assert.equal(fixture.store.writes.length, writesBefore);
  assert.equal((await fixture.service.listItems()).items[0].status, "waiting_condition");
});

for (const priorStatus of ["executing", "failed"]) {
  test(`a later completed creation confirmation recovers after an earlier ${priorStatus} observation`, async () => {
    const fixture = await revokedCodeConfirmationFixture({ createdJob: true, observedConfirmationStatus: priorStatus });
    fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs, codeJobControl: fixture.jobs });
    const result = await fixture.service.reconcilePullRequestSource(fixture.command);
    assert.equal(result.applied, true, "current completed evidence must settle an earlier nonterminal observation");
    const root = await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId });
    assert.equal(root.source.current.headRefOid, PR_HEAD_B);
    assert.equal(root.status, "queued");
  });
}

test("a changed ledger during executed-confirmation reading cannot cancel the obsolete job", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  const read = fixture.service.confirmationSettlementReader.read.bind(fixture.service.confirmationSettlementReader);
  fixture.service.confirmationSettlementReader = { read: async (input) => {
    const snapshot = await read(input);
    fixture.source.records.push(assignment(3));
    fixture.source.highWatermark = 3;
    await fixture.service.intake();
    return snapshot;
  } };
  let cancellations = 0;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: fixture.jobs,
    codeJobControl: { cancel: async (request) => { cancellations += 1; return fixture.jobs.cancel(request); } },
  });
  await assert.rejects(fixture.service.reconcilePullRequestSource(fixture.command),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT");
  assert.equal(cancellations, 0, "a stale asynchronous read must be rejected before requesting cancellation");
  assert.equal((await fixture.jobs.list()).items[0].status, "paused");
});

test("a legacy null downstream reference still reconciles the exact completed code confirmation", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true, legacyNullReference: true });
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs, codeJobControl: fixture.jobs });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.equal((await fixture.service.readItemForReconciliation({ itemId: fixture.item.itemId })).source.current.headRefOid, PR_HEAD_B);
});

test("an executed stale code confirmation releases cutover only after a read proves no job exists", async () => {
  const fixture = await revokedCodeConfirmationFixture({ executed: true });
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs, codeJobControl: fixture.jobs });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, true);
  assert.equal((await fixture.jobs.list()).items.length, 0);
});

test("restart during old-job cancellation preserves the fence until a trusted receipt makes the new Head claimable", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  let job = (await fixture.jobs.list()).items[0];
  await fixture.jobs.resume({ jobId: job.jobId, expectedRevision: job.revision });
  job = await fixture.jobs.get(job.jobId);
  await fixture.jobs.claimStarting({ jobId: job.jobId, expectedRevision: job.revision });
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: fixture.jobs, codeJobControl: fixture.jobs });
  assert.equal((await fixture.service.reconcilePullRequestSource(fixture.command)).applied, false);
  const jobs = new CodeJobStore({ store: fixture.store, exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(), clock: () => new Date(fixture.time.clock()) });
  await jobs.recover();
  const service = new WorkLedgerService({ store: fixture.store, assignmentSource: fixture.source,
    exclusiveLease: new ExclusiveLease(), clock: fixture.time.clock, idFactory: incrementingIds(),
    confirmationSettlementReader: fixture.service.confirmationSettlementReader,
    obsoleteCodeJobSettler: new ObsoleteCodeJobSettler({ codeJobReader: jobs, codeJobControl: jobs }),
  });
  await service.recover();
  assert.equal((await service.reconcilePullRequestSource(fixture.command)).applied, false);
  const cancelling = await jobs.getForWorker(job.jobId);
  assert.equal(cancelling.status, "cancelling");
  // The executor test separately proves production receipt generation and cleanup.
  const content = { schemaVersion: 1, kind: "controlled_execution_absent", sessionId: job.jobId,
    cancellationDigest: cancelling.execution.result.detailDigest,
    sourceRevision: null, trustedWorkspaceRevision: null, actionResolution: null,
    sandboxCleanupConfirmed: true, discardedAttempts: [], settledAt: fixture.time.clock() };
  await jobs.finalizeCancellation({ jobId: job.jobId, expectedRevision: cancelling.revision,
    settlement: { ...content, proofDigest: digestValue(content) } });
  assert.equal((await service.reconcilePullRequestSource(fixture.command)).applied, true);
  const root = await service.readItemForReconciliation({ itemId: fixture.item.itemId });
  assert.equal(root.source.current.headRefOid, PR_HEAD_B);
  assert.equal(root.source.pendingRevision, null);
  assert.equal((await service.claim({ itemId: root.itemId, expectedRevision: root.revision,
    workerId: "employee-developer", leaseDurationMs: 30000 })).status, "working");
  assert.equal((await jobs.list()).items.length, 1);
});

test("a changed ledger during code-job reading cannot admit obsolete cancellation", async () => {
  const fixture = await revokedCodeConfirmationFixture({ createdJob: true });
  let cancellations = 0;
  fixture.service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({
    codeJobReader: { get: async (id) => {
      const job = await fixture.jobs.get(id);
      fixture.source.records.push(assignment(3));
      fixture.source.highWatermark = 3;
      await fixture.service.intake();
      return job;
    } },
    codeJobControl: { cancel: async (request) => { cancellations += 1; return fixture.jobs.cancel(request); } },
  });
  await assert.rejects(fixture.service.reconcilePullRequestSource(fixture.command),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT");
  assert.equal(cancellations, 0);
  assert.equal((await fixture.jobs.list()).items[0].status, "paused");
});


for (const eventType of ["issue.left_scope", "issue.completed"]) {
  test(`${eventType} retires a submitted child delivery without blocking unrelated PR intake`, async () => {
    const f = await createFixture({ records: [issueAssignment(1)] });
    await f.service.intake();
    const root = (await f.service.listItems()).items[0];
    const create = prGraphChildCommand(root, (await f.service.getSummary()).revision, "issue-analysis");
    create.command.acceptanceContract.expectedDeliverables = [{ deliverableId: "analysis", kind: "text-report",
      description: "Scoped analysis", required: true }];
    const created = await f.service.createGraphChild(create);
    let child = await f.service.readItemForReconciliation({ itemId: created.taskId });
    child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
      workerId: "employee-developer", leaseDurationMs: 30000 });
    await f.service.submitGraphDelivery({ authority: { actorId: "employee-developer", scopeRootTaskId: root.itemId,
      taskId: child.itemId, leaseId: child.leaseId }, command: { deliveryRevision: 1, contractRevision: 1,
      deliverableId: "analysis", summary: "Analysis awaiting review", evidence: [{ kind: "work-inputs",
        referenceId: "fixture-inputs", contentDigest: "a".repeat(64) }],
      expectedGraphRevision: (await f.service.getSummary()).revision, expectedTaskRevision: child.revision } });
    const submitted = (await f.service.readItemForReconciliation({ itemId: child.itemId })).graph.deliveries[0];
    f.source.records.push(issueAssignment(2, { eventType, state: "closed", occurredAt: "2026-08-02T02:05:00.000Z" }),
      prAssignment(3, { occurredAt: "2026-08-02T02:06:00.000Z" }));
    f.source.highWatermark = 3;
    await f.service.intake();
    const retired = await f.service.readItemForReconciliation({ itemId: child.itemId });
    assert.equal(retired.status, "cancelled");
    assert.deepEqual(retired.graph.deliveries[0], submitted);
    assert.equal(retired.graph.deliveries.length, 2);
    assert.equal(retired.graph.deliveries[1].status, "rejected");
    assert.deepEqual(retired.graph.deliveries[1].evidence, submitted.evidence);
    assert.equal(f.store.stored().intakeCursor, 3);
    assert.ok((await f.service.listItems()).items.some(i => i.source?.kind === "pull_request"));
    const recovered = await createFixture({ store: f.store, source: f.source, time: f.time });
    await recovered.service.intake();
    assert.deepEqual((await recovered.service.readItemForReconciliation({ itemId: child.itemId })).graph.deliveries, retired.graph.deliveries);
  });
}


for (const [processorName, createProcessor] of [["local", createLocalWorkLedgerCandidateProcessor],
  ["worker", createWorkerWorkLedgerCandidateProcessor]]) {
  test(`${processorName} intake automatically splits scope reentry followed by metadata and preserves later PRs`, async t => {
    const processor = createProcessor(); t.after(() => processor.close());
    let f = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })], candidateProcessor: processor });
    await f.service.intake();
    const initial = (await f.service.listItems()).items[0];
    const left = prAssignment(2, { eventType: "pull_request.left_scope", occurredAt: "2026-08-02T01:10:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A) });
    const created = prAssignment(4, { eventType: "pull_request.created", occurredAt: "2026-08-02T01:15:00.000Z",
      gitFacts: prGitFacts(PR_HEAD_A) });
    f.source.records.push(prScopeLifecycleAssignment(2, left.event), prScopeLifecycleAssignment(3, created.event), created,
      prAssignment(5, { occurredAt: "2026-08-02T01:20:00.000Z", title: "Metadata after reentry", gitFacts: prGitFacts(PR_HEAD_A) }),
      prAssignment(6, { occurredAt: "2026-08-02T01:25:00.000Z", pullRequestNumber: 43 }));
    f.source.highWatermark = 6;
    let cursor = 1;
    for (let turn = 0; cursor < 6 && turn < 8; turn++) {
      const page = await f.service.intake({ limit: 100 });
      assert.ok(page.cursor > cursor);
      assert.equal(page.highWatermark, 6);
      cursor = page.cursor;
      f = await createFixture({ store: f.store, source: f.source, time: f.time, candidateProcessor: processor });
    }
    assert.equal(cursor, 6);
    const current = await f.service.readItemForReconciliation({ itemId: initial.itemId });
    assert.equal(current.source.scope.active, true);
    assert.equal(current.source.scope.revision, initial.source.scope.revision + 2);
    assert.equal(current.source.current.event.payload.title, "Metadata after reentry");
    assert.equal(current.attempt, initial.attempt);
    assert.ok((await f.service.listItems()).items.some(i => i.source?.identity.pullRequestNumber === 43));
  });
}


test("an invalid single PR source event remains rejected without skipping its sequence", async () => {
  const processor = createLocalWorkLedgerCandidateProcessor();
  let reject = false, preparations = 0;
  const f = await createFixture({ records: [prAssignment(1)], candidateProcessor: {
    prepare: q => { if (reject) { preparations++; throw Object.assign(new Error("invalid source"), { code: "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID" }); } return processor.prepare(q); },
    commit: () => processor.commit(), discard: () => processor.discard(),
  } });
  await f.service.intake();
  f.source.records.push(prAssignment(2, { title: "New metadata" })); f.source.highWatermark = 2; reject = true;
  await assert.rejects(f.service.intake(), e => e.code === "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID");
  assert.equal(preparations, 1); assert.equal(f.store.stored().intakeCursor, 1);
});

test("an intake storage failure never starts source-prefix retries", async () => {
  const f = await createFixture({ records: [prAssignment(1)] }); await f.service.intake();
  f.source.records.push(prAssignment(2, { title: "First metadata" }), prAssignment(3, { title: "Second metadata" }));
  f.source.highWatermark = 3; let writes = 0;
  f.store.write = async () => { writes++; throw new Error("storage unavailable"); };
  await assert.rejects(f.service.intake(), e => e.code === "WORK_LEDGER_STATE_WRITE_FAILED");
  assert.equal(writes, 1); assert.equal(f.store.stored().intakeCursor, 1);
});

function legacyCiMaterialQuestion(event) {
  return { type: 'ask_user', summary: '请求补齐 QuickTest.cn 运行材料或可读取来源',
    reason: '开发子任务已完成限制报告交付，未产生修复或测试证据。当前仅有 QuickTest.cn FAILURE 快照，缺少最新远端状态及实际失败运行材料，无法判断是否需要代码修复。重复派发相同任务不能消除渠道缺口，因此升级请求缺失信息，不请求例行修复授权，也不将工具限制认定为代码缺陷或结束根任务。',
    question: `请提供 ${event.subject.repository} #${event.subject.number} 的最新 Head/检查状态，以及 QuickTest.cn 失败运行的链接或编号、检查对应 SHA、实际检出 SHA、失败阶段、首个有效错误和相关测试报告；也可提供这些材料的可读取来源。当前绑定 Head 为 ${event.payload.headRefOid}。补齐后继续交由 development 定位和处理必要修复。`,
    choices: [{ id: 'provide-run-evidence', label: '提供运行材料', description: '补充最新状态及失败运行日志、提交绑定和测试报告。' },
      { id: 'provide-readonly-source', label: '提供可读取来源', description: '指出现有只读渠道或日志材料位置，以便继续取证。' }] };
}

async function pendingCiMaterialFixture({ changedBase = true, duringRead = () => {} } = {}) {
  const assignment = sequence => ownerRequestedPrAssignment(sequence, { occurredAt: sequence === 1 ? '2026-08-02T01:10:00.000Z' : '2026-08-02T02:00:00.000Z',
    gitFacts: { ...prGitFacts(PR_HEAD_A, sequence > 1 ? { baseRefOid: 'e'.repeat(40) } : {}),
      workType: 'general', nextAction: 'fix_ci', suggestedCapability: 'development', expectedHeadRefOid: PR_HEAD_A } });
  const record = assignment(1); record.assignment.target = { type: 'role', id: 'orchestrator' };
  let control;
  const fixture = await createFixture({ records: [record], hostContextRecoveryReader: {
    read: async () => null,
    async readCiMaterials({ inputBinding, event }) {
      assert.equal(inputBinding.gitTarget.baseRefOid, changedBase ? 'e'.repeat(40) : 'd'.repeat(40));
      assert.equal(event.payload.gitTarget.baseRefOid, inputBinding.gitTarget.baseRefOid);
      const result = clone(control); duringRead(control); return result;
    },
    async withStoppedRuns(expected, operation) {
      return isDeepStrictEqual(expected, control) ? { executed: true, result: await operation() } : { executed: false };
    },
  } });
  await fixture.service.intake();
  let root = (await fixture.service.listItems()).items[0];
  const created = await fixture.service.createGraphChild(prGraphChildCommand(root, (await fixture.service.getSummary()).revision, 'ci-diagnosis'));
  let child = await fixture.service.readItemForReconciliation({ itemId: created.taskId });
  child = await fixture.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: 'employee-developer', leaseDurationMs: 30000 });
  await fixture.service.complete({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
    actorId: 'employee-developer', result: { outcome: 'limitations-report-only' } });
  root = await fixture.service.readItemForReconciliation({ itemId: root.itemId });
  const requestIntent = legacyCiMaterialQuestion(currentWorkItemEvent(root));
  control = { actorAccountId: 'runtime-user', run: { kind: 'work-item', taskId: root.itemId, roleId: 'orchestrator', active: false,
    mode: 'active', pendingCommand: null, phase: 'completed', receipt: { kind: 'work-item', taskId: root.itemId, roleId: 'orchestrator',
      taskRevision: root.revision, phase: 'completed', stopConfirmed: true, registeredAt: fixture.time.clock(),
      modelStartedAt: fixture.time.clock(), finishedAt: fixture.time.clock() } } };
  const { type: _type, ...question } = requestIntent;
  const staged = await fixture.service.stageGraphEscalation({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: root.itemId },
    command: { taskId: root.itemId, expectedTaskRevision: root.revision, expectedGraphRevision: (await fixture.service.getSummary()).revision, ...question } });
  let ask = await fixture.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30000 });
  ask = await fixture.service.bindIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    dispatcherId: 'work-intent-dispatcher', itemExpectedRevision: staged.item.revision, boundIntent: boundAttentionIntent(staged.item, ask) });
  const request = normalizeAttentionRequest({ requestKey: ask.intentId, type: 'ask_user', producer: { roleId: 'orchestrator', workItemId: root.itemId },
    question: question.question, choices: question.choices, context: [] });
  const attention = createAttentionItem(request, 1, fixture.time.clock());
  await fixture.service.ackIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision, actorId: 'work-intent-dispatcher', outcome: 'delivered', nextStatus: 'waiting_user', details: { questionRef: attention.requestId } });
  if (changedBase) { const next = assignment(2); next.assignment.target = record.assignment.target;
    fixture.source.records.push(next); fixture.source.highWatermark = 2; await fixture.service.intake(); }
  const event = currentWorkItemEvent(root), branch = event.payload.gitTarget.headRefName;
  control.ciEvidence = createCiRepairEvidence({ schemaVersion: 1, repository: event.subject.repository, number: event.subject.number,
    headRefOid: PR_HEAD_A, headRefName: branch, checks: [{ kind: 'status_context', name: 'QuickTest.cn', url: 'https://ci.example/build/1742/', conclusion: 'FAILURE' }],
    diagnostics: [{ state: 'available', check: 'QuickTest.cn', repository: event.subject.repository, headRefOid: PR_HEAD_A,
      buildUrl: 'https://ci.example/build/1742/', untrustedEvidence: true, checkout: { matched: true, sha: PR_HEAD_A, branch },
      failures: [{ message: 'compiler error observed' }] }] });
  return { ...fixture, rootId: root.itemId, childId: child.itemId, askId: ask.intentId, request, attention, control,
    retry: () => fixture.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [ask.intentId] }) };
}

test('available bound CI material retires its obsolete question before ordinary Base cutover', async () => {
  const f = await pendingCiMaterialFixture();
  const before = clone(f.store.stored());
  assert.equal(before.items.find(item => item.itemId === f.rootId).status, 'waiting_user');
  assert.deepEqual(await f.retry(), { retried: 1 });
  let root = await f.service.readItemForReconciliation({ itemId: f.rootId });
  assert.equal(root.status, 'queued');
  assert.equal(root.activeIntentId, null);
  const retirement = await f.service.readAttentionRequestRetirement({ requestKey: f.askId, producer: f.request.producer });
  assert.equal(retirement.reason, 'ci_materials_recovered');
  await f.service.reconcilePullRequestSource({ itemId: root.itemId, expectedRevision: root.revision,
    expectedPendingRevision: root.source.pendingRevision, expectedGraphRevision: (await f.service.getSummary()).revision });
  root = await f.service.readItemForReconciliation({ itemId: f.rootId });
  assert.equal(root.status, 'queued');
  assert.equal(root.source.current.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
  assert.deepEqual(await f.retry(), { retried: 0 });
  const saved = clone(root);
  const late = resolveAttentionItem(f.attention, { type: 'choice', choiceId: 'provide-run-evidence' }, 2, f.time.clock(), 1).outbox;
  await f.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: root.itemId }), saved);
});

test('CI material recovery without a Base change makes the orchestrator ready and archives without an answer', async () => {
  const f = await pendingCiMaterialFixture({ changedBase: false });
  const inboxStore = new MemoryStore();
  const inbox = new AttentionInbox({ store: inboxStore, exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 1 });
  const page = await f.service.listClaimCandidates({ limit: 100, at: f.time.clock() });
  const index = page.items.findIndex(item => item.itemId === f.rootId);
  assert.ok(index >= 0);
  assert.equal(page.facts[index].graphBlocked, false);
  assert.deepEqual(await inbox.archiveRetired(), { archived: 1 });
  assert.equal(inboxStore.stored('attention-inbox').items[0].result, null);
  assert.equal((await inbox.readOutbox()).items.length, 0);
  const ready = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const created = await f.service.createGraphChild(prGraphChildCommand(ready, (await f.service.getSummary()).revision, 'repair-after-materials'));
  assert.equal((await f.service.readItemForReconciliation({ itemId: created.taskId })).status, 'queued');
  assert.equal((await f.service.readItemForReconciliation({ itemId: f.rootId })).status, 'queued');
});

test('CI material recovery preserves holds, real questions, source bindings and unknown effects', async t => {
  const f = await pendingCiMaterialFixture();
  for (const variant of ['root-paused', 'child-paused', 'extra-proposal', 'pending-answer', 'real-question', 'extra-choice',
    'answered', 'new-head', 'new-account', 'source-left', 'wrong-actor', 'run-active', 'run-paused', 'run-command', 'stop-unknown',
    'wrong-decision-revision', 'no-evidence', 'bad-evidence-digest', 'empty-failures', 'unavailable-material', 'changed-snapshot']) {
    await t.test(variant, () => {
      const state = clone(f.store.stored()), control = clone(f.control), root = state.items.find(item => item.itemId === f.rootId);
      const candidate = ciMaterialRecoveryCandidate(state, root);
      assert.ok(candidate);
      const captured = { itemId: f.rootId, snapshotDigest: candidate.snapshotDigest };
      const ask = state.outbox.find(box => box.intentId === f.askId), child = state.items.find(item => item.itemId === f.childId);
      if (variant === 'root-paused') root.status = 'paused';
      if (variant === 'child-paused') child.status = 'paused';
      if (variant === 'extra-proposal') state.outbox.push({ ...clone(ask), intentId: `work-intent-${'f'.repeat(64)}`, itemId: child.itemId, status: 'unknown' });
      if (variant === 'pending-answer') state.attentionHighWatermark++;
      if (variant === 'real-question') ask.intent.question = 'Should we change the required acceptance scope?';
      if (variant === 'extra-choice') ask.intent.choices.push({ id: 'pause', label: 'Pause' });
      if (variant === 'answered') ask.outcome.details.resultAttestation = {};
      if (variant === 'new-head') root.source.pending.event.payload.headRefOid = PR_HEAD_B;
      if (variant === 'new-account') root.source.pending.event.payload.gitTarget.sourceAccountId = 'another-user';
      if (variant === 'source-left') root.source.scope.active = false;
      if (variant === 'wrong-actor') control.actorAccountId = 'another-user';
      if (variant === 'run-active') control.run.active = true;
      if (variant === 'run-paused') control.run.mode = 'paused';
      if (variant === 'run-command') control.run.pendingCommand = { type: 'pause' };
      if (variant === 'stop-unknown') control.run.receipt.stopConfirmed = false;
      if (variant === 'wrong-decision-revision') control.run.receipt.taskRevision++;
      if (variant === 'no-evidence') delete control.ciEvidence;
      if (variant === 'bad-evidence-digest') control.ciEvidence.contentDigest = 'f'.repeat(64);
      if (['empty-failures', 'unavailable-material'].includes(variant)) {
        const { triggerDigest, contentDigest, ...material } = control.ciEvidence;
        if (variant === 'empty-failures') material.diagnostics[0].failures = [];
        else material.diagnostics[0].state = 'unavailable';
        control.ciEvidence = createCiRepairEvidence(material);
      }
      if (variant === 'changed-snapshot') root.revision++;
      const unchanged = clone(state);
      assert.deepEqual(planCiMaterialRecovery({ state, captured, control, clock: f.time.clock }), { write: false, result: { retried: 0 } });
      assert.deepEqual(state, unchanged);
    });
  }
});

for (const change of ['active', 'pause-command']) {
  test(`a ${change} after the CI material read prevents automatic question retirement`, async () => {
    const f = await pendingCiMaterialFixture({ duringRead(control) {
      if (change === 'active') control.run.active = true;
      else control.run.pendingCommand = { type: 'pause' };
    } });
    assert.deepEqual(await f.retry(), { retried: 0 });
    assert.equal((await f.service.readItemForReconciliation({ itemId: f.rootId })).status, 'waiting_user');
  });
}

test('CI material recovery fingerprints complete legal histories beyond the default aggregate digest budget', async () => {
  const f = await pendingCiMaterialFixture();
  const state = clone(f.store.stored());
  for (const item of state.items.filter(item => [f.rootId, f.childId].includes(item.itemId))) {
    item.revision += 31;
    for (let revision = 2; revision <= 32; revision++) item.graph.acceptanceContracts.push({ revision,
      acceptanceCriteria: Array.from({ length: 64 }, (_, index) => ({ criterionId: `criterion-${String(index).padStart(2, '0')}`, description: 'Historical criterion' })),
      expectedDeliverables: Array.from({ length: 64 }, (_, index) => ({ deliverableId: `report-${String(index).padStart(2, '0')}`,
        kind: 'text-report', description: 'Optional historical report', required: false })), recordedAt: item.updatedAt });
  }
  state.revision += 62;
  const staged = state.timeline.find(entry => entry.itemId === f.rootId && entry.type === 'intent_staged');
  staged.details.workItemRevision += 31;
  const { timelineId, contentDigest, ...content } = staged;
  staged.contentDigest = ledgerDigest(content); staged.timelineId = `work-timeline-${staged.contentDigest}`;
  f.control.run.receipt.taskRevision += 31;
  state.graphMemoryProjection = migrateWorkGraphMemoryProjection(state.items, state.revision, normalizeWorkLedgerLimits());
  const legal = normalizeWorkLedgerPersistedState(state);
  const root = legal.items.find(item => item.itemId === f.rootId);
  const candidate = ciMaterialRecoveryCandidate(legal, root);
  assert.ok(candidate);
  const result = planCiMaterialRecovery({ state: legal, captured: { itemId: root.itemId, snapshotDigest: candidate.snapshotDigest },
    control: f.control, clock: f.time.clock });
  assert.equal(result.result.retried, 1);
  const changed = clone(legal);
  changed.items.find(item => item.itemId === f.childId).graph.acceptanceContracts[20].acceptanceCriteria[40].description = 'Changed historical evidence';
  assert.deepEqual(planCiMaterialRecovery({ state: changed, captured: { itemId: root.itemId, snapshotDigest: candidate.snapshotDigest },
    control: f.control, clock: f.time.clock }), { write: false, result: { retried: 0 } });
});

async function persistedRetryCiMaterialFixture() {
  const f = await pendingCiMaterialFixture({ changedBase: false });
  await f.retry();
  const legacy = clone(f.store.stored()), root = legacy.items.find(item => item.itemId === f.rootId);
  root.status = 'retry_wait'; root.availableAt = root.updatedAt;
  const transition = legacy.timeline.findLast(entry => entry.itemId === f.rootId && entry.type === 'transitioned');
  transition.type = 'retry_scheduled';
  transition.details = { fromStatus: 'waiting_user', availableAt: root.availableAt, reason: 'ci_materials_recovered', restoredAttempts: 0 };
  const { timelineId, contentDigest, ...content } = transition;
  transition.contentDigest = ledgerDigest(content); transition.timelineId = `work-timeline-${transition.contentDigest}`;
  legacy.graphMemoryProjection = migrateWorkGraphMemoryProjection(legacy.items, legacy.revision, normalizeWorkLedgerLimits());
  const durable = normalizeWorkLedgerPersistedState(legacy);
  return { f, durable, rootId: f.rootId };
}

test('a persisted retry_wait CI recovery can create its next child after restart', async () => {
  const { f, durable, rootId } = await persistedRetryCiMaterialFixture();
  await f.store.write(STATE_KEY, durable);
  const recovered = await createFixture({ store: f.store, source: f.source, time: f.time });
  const root = await recovered.service.readItemForReconciliation({ itemId: rootId });
  assert.equal(root.status, 'retry_wait');
  assert.equal(hasPendingCiMaterialRecovery(durable, root), true);
  const created = await recovered.service.createGraphChild(prGraphChildCommand(root,
    (await recovered.service.getSummary()).revision, 'repair-after-restored-materials'));
  assert.equal((await recovered.service.readItemForReconciliation({ itemId: created.taskId })).status, 'queued');
  assert.equal((await recovered.service.readItemForReconciliation({ itemId: rootId })).status, 'queued');
  assert.equal((await recovered.service.readItemForReconciliation({ itemId: rootId })).activeIntentId, null);
});

test('legacy CI parent admission still requires its unchanged retirement proof and source', async t => {
  const { durable, rootId } = await persistedRetryCiMaterialFixture();
  for (const variant of ['owner-paused', 'no-proof', 'bad-proof', 'changed-child', 'extra-outbox', 'changed-root', 'source-left', 'source-pending']) {
    await t.test(variant, () => {
      const state = clone(durable), root = state.items.find(item => item.itemId === rootId);
      const ask = state.outbox.find(box => box.itemId === rootId);
      if (variant === 'owner-paused') root.status = 'paused';
      if (variant === 'no-proof') delete ask.outcome.details.ciMaterialRetirement;
      if (variant === 'bad-proof') ask.outcome.details.ciMaterialRetirement.digest = 'f'.repeat(64);
      if (variant === 'changed-child') state.items.find(item => item.graph.parentItemId === rootId).revision++;
      if (variant === 'extra-outbox') state.outbox.push({ ...clone(ask), intentId: `work-intent-${'f'.repeat(64)}`, status: 'unknown' });
      if (variant === 'changed-root') root.revision++;
      if (variant === 'source-left') root.source.scope.active = false;
      if (variant === 'source-pending') root.source.pendingRevision = 2;
      assert.equal(hasPendingCiMaterialRecovery(state, root), false);
    });
  }
});

test('a settled failed code proposal wakes its coordinating parent without replaying the child', async () => {
  const record = ownerRequestedPrAssignment(1, { gitFacts: { ...prGitFacts(PR_HEAD_A), workType: 'general',
    nextAction: 'fix_ci', suggestedCapability: 'development', expectedHeadRefOid: PR_HEAD_A } });
  record.assignment.target = { type: 'role', id: 'orchestrator' };
  const f = await createFixture({ records: [record] });
  await f.service.intake();
  const root = (await f.service.listItems()).items[0];
  const created = await f.service.createGraphChild(prGraphChildCommand(root,
    (await f.service.getSummary()).revision, 'failed-code-coordination'));
  const result = await prepareProposalResult(f, { kind: 'code_action_proposal', outcome: 'failed',
    itemId: created.taskId, intentOverrides: { operation: 'inspect' }, sealSource: true });
  await f.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  const before = await f.service.readItemForReconciliation({ itemId: created.taskId });
  assert.equal(before.statusReason, 'proposal_failed');
  const graph = await f.service.getGraphSnapshot();
  const projected = graph.taskStates.find(row => row.taskId === before.itemId);
  assert.equal(projected.proposalFailure?.code, 'CODE_ACTION_PROPOSAL_FAILED');
  assert.equal(projected.proposalFailure.stage, 'proposal');
  assert.equal(projected.proposalFailure.taskRevision, before.revision);
  const page = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(page.facts.find(row => row.itemId === root.itemId).orchestrationReady, true);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: before.itemId }), before);
  const durable = f.store.stored();
  for (const variant of ['paused', 'owned', 'active-intent', 'unknown-outbox', 'missing-seal', 'wrong-attestation',
    'wrong-result', 'changed-binding', 'duplicate-outbox', 'later-event', 'wrong-revision']) {
    const state = clone(durable), item = state.items.find(x => x.itemId === before.itemId);
    const box = state.outbox.find(x => x.itemId === item.itemId);
    const latest = state.timeline.findLast(x => x.itemId === item.itemId);
    if (variant === 'paused') item.status = 'paused';
    if (variant === 'owned') item.ownerId = 'another-worker';
    if (variant === 'active-intent') item.activeIntentId = 'unknown-intent';
    if (variant === 'unknown-outbox') box.status = 'unknown';
    if (variant === 'missing-seal') delete box.outcome.details.resultAttestation;
    if (variant === 'wrong-attestation') latest.details.resultAttestationDigest = 'f'.repeat(64);
    if (variant === 'wrong-result') item.decisionContext.value.resultId = 'another-result';
    if (variant === 'changed-binding') box.sourceBinding.inputDigest = 'f'.repeat(64);
    if (variant === 'duplicate-outbox') state.outbox.push(clone(box));
    if (variant === 'later-event') state.timeline.push({ itemId: item.itemId, type: 'another-event' });
    if (variant === 'wrong-revision') latest.details.workItemRevision++;
    assert.equal(indexRecordedProposalFailures(state).has(item.itemId), false, variant);
  }
});

test('a retained child decision failure wakes its coordinating parent with the exact host diagnostic', async () => {
  const record = ownerRequestedPrAssignment(1, { gitFacts: { ...prGitFacts(PR_HEAD_A), workType: 'general',
    nextAction: 'fix_ci', suggestedCapability: 'development', expectedHeadRefOid: PR_HEAD_A } });
  record.assignment.target = { type: 'role', id: 'orchestrator' };
  const f = await createFixture({ records: [record] });
  await f.service.intake();
  const root = (await f.service.listItems()).items[0];
  const created = await f.service.createGraphChild(prGraphChildCommand(root,
    (await f.service.getSummary()).revision, 'ci-decision-diagnostic'));
  let child = await f.service.readItemForReconciliation({ itemId: created.taskId });
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: 'employee-developer', leaseDurationMs: 30000 });
  await f.service.transition({ itemId: child.itemId, expectedRevision: child.revision,
    leaseId: child.leaseId, actorId: 'employee-developer', toStatus: 'blocked',
    reason: 'decision_attempts_exhausted', details: { code: 'ROLE_DECISION_PR_REVIEW_REQUIRED' } });
  const before = await f.service.readItemForReconciliation({ itemId: child.itemId });
  const graph = await f.service.getGraphSnapshot();
  const projected = graph.taskStates.find(row => row.taskId === child.itemId);
  assert.equal(projected.decisionFailure?.code, 'ROLE_DECISION_PR_REVIEW_REQUIRED');
  assert.equal(projected.decisionFailure.stage, 'decision');
  assert.equal(projected.decisionFailure.taskRevision, before.revision);
  const page = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(page.facts.find(row => row.itemId === root.itemId).orchestrationReady, true);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: child.itemId }), before,
    'parent notification does not requeue the child or reset its attempts');
  const durable = await f.store.read(STATE_KEY);
  for (const variant of ['paused-child', 'owned-child', 'active-intent', 'changed-claim', 'changed-input', 'old-timeline', 'paused-parent', 'inactive-source']) {
    const state = clone(durable), changedChild = state.items.find(item => item.itemId === child.itemId);
    const changedParent = state.items.find(item => item.itemId === root.itemId);
    const latest = state.timeline.findLast(entry => entry.itemId === child.itemId);
    const claim = state.timeline.findLast(entry => entry.itemId === child.itemId && entry.type === 'claimed');
    if (variant === 'paused-child') changedChild.status = 'paused';
    if (variant === 'owned-child') changedChild.ownerId = 'another-worker';
    if (variant === 'active-intent') changedChild.activeIntentId = 'unsettled-intent';
    if (variant === 'changed-claim') claim.actorId = 'another-worker';
    if (variant === 'changed-input') changedChild.inputDigest = 'f'.repeat(64);
    if (variant === 'old-timeline') latest.at = '2026-08-01T00:00:00.000Z';
    if (variant === 'paused-parent') changedParent.status = 'paused';
    if (variant === 'inactive-source') changedParent.source.scope.active = false;
    assert.equal(decisionFailureParentIds(state, indexRecordedDecisionFailures(state)).has(root.itemId), false, variant);
  }
});

async function blockedDeliveryDiagnosticFixture({ hostContextRecoveryReader } = {}) {
  const record = ownerRequestedPrAssignment(1, { gitFacts: { ...prGitFacts(PR_HEAD_A), workType: 'general',
    nextAction: 'fix_ci', suggestedCapability: 'development', expectedHeadRefOid: PR_HEAD_A } });
  record.assignment.target = { type: 'role', id: 'orchestrator' };
  const f = await createFixture({ records: [record], hostContextRecoveryReader });
  await f.service.intake();
  let root = (await f.service.listItems()).items[0];
  const command = prGraphChildCommand(root, (await f.service.getSummary()).revision, 'ci-diagnostic-summary');
  command.command.acceptanceContract.expectedDeliverables = [
    { deliverableId: 'ci-resolution-summary', kind: 'text-report', description: 'Bound CI diagnosis and limitations', required: true },
    { deliverableId: 'ci-fix-verification', kind: 'test-report', description: 'Actual verification evidence only', required: false }];
  const created = await f.service.createGraphChild(command);
  const inspected = await prepareProposalResult(f, { kind: 'code_action_proposal', itemId: created.taskId,
    intentOverrides: { operation: 'inspect' }, sealSource: true });
  await f.service.applyProposalBatch({ items: [inspected], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  let child = await f.service.readItemForReconciliation({ itemId: created.taskId });
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: 'employee-developer', leaseDurationMs: 30000 });
  await f.service.submitGraphDelivery({ authority: { actorId: 'employee-developer', scopeRootTaskId: root.itemId,
    taskId: child.itemId, leaseId: child.leaseId }, command: { deliveryRevision: 1, contractRevision: 1,
      deliverableId: 'ci-fix-verification', summary: 'A completed preflight does not establish remote CI success',
      evidence: [{ kind: 'test-report', referenceId: 'fixture-previous-verification', contentDigest: 'a'.repeat(64) }],
      expectedGraphRevision: (await f.service.getSummary()).revision, expectedTaskRevision: child.revision } });
  child = await f.service.readItemForReconciliation({ itemId: child.itemId });
  await f.service.decideGraphDelivery({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: root.itemId }, command: {
    taskId: child.itemId, submittedDeliveryRevision: 1, decision: 'accept', reason: 'Accept the reported check only, not CI success',
    expectedGraphRevision: (await f.service.getSummary()).revision, expectedTaskRevision: child.revision } });
  child = await f.service.readItemForReconciliation({ itemId: child.itemId });
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: 'employee-developer', leaseDurationMs: 30000 });
  child = await f.service.transition({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
    actorId: 'employee-developer', toStatus: 'blocked', reason: 'delivery_attempts_exhausted', details: { code: 'ORCHESTRATOR_EVIDENCE_REJECTED' } });
  root = await f.service.readItemForReconciliation({ itemId: root.itemId });
  return { ...f, rootId: root.itemId, childId: child.itemId };
}

test('a blocked delivery retains its host failure beside accepted verification history', async () => {
  const f = await blockedDeliveryDiagnosticFixture();
  const before = await f.service.readItemForReconciliation({ itemId: f.childId });
  const state = (await f.service.getGraphSnapshot()).taskStates.find(task => task.taskId === f.childId);
  assert.equal(state.deliveryFailure.code, 'ORCHESTRATOR_EVIDENCE_REJECTED');
  assert.equal(state.deliveryFailure.stage, 'delivery');
  assert.equal(state.deliveryFailure.taskRevision, before.revision);
  assert.equal(Object.hasOwn(state.deliveryFailure, 'downstreamCreated'), false);
  assert.equal(before.graph.deliveries.at(-1).status, 'accepted');
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.childId }), before);
});

async function pendingDeliveryDiagnosticQuestionFixture({ duringRead = () => {} } = {}) {
  let control;
  const reads = [];
  const f = await blockedDeliveryDiagnosticFixture({ hostContextRecoveryReader: {
    async read(input) { reads.push(input); const captured = clone(control); duringRead(control); return captured; },
    async withStoppedRuns(expected, operation) {
      return isDeepStrictEqual(expected, control) ? { executed: true, result: await operation() } : { executed: false };
    },
  } });
  const root = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const child = await f.service.readItemForReconciliation({ itemId: f.childId });
  const receipt = (item, roleId, taskRevision) => ({ kind: 'work-item', taskId: item.itemId, roleId, active: false,
    mode: 'active', pendingCommand: null, phase: 'completed', receipt: { kind: 'work-item', taskId: item.itemId, roleId,
      taskRevision, phase: 'completed', stopConfirmed: true, registeredAt: f.time.clock(), modelStartedAt: f.time.clock(), finishedAt: f.time.clock() } });
  control = { actorAccountId: 'runtime-user', run: receipt(root, 'orchestrator', root.revision), childRun: receipt(child, 'developer', child.revision - 1) };
  const question = `请补充开发子任务 ${child.itemId} 在 revision ${child.revision} 被标记为 blocked 的宿主原因或失败记录，尤其是 ci-resolution-summary 未登记的处理结果。这是缺失诊断信息请求，不是检查、修改或更新 PR 的授权请求。`;
  const choices = [{ id: 'provide-blocker-evidence', label: '补充阻塞诊断', description: '提供宿主失败码、对应意图处理结果或可读取的诊断引用；保留原任务与历史，再据证据决定恢复。' }];
  const staged = await f.service.stageGraphEscalation({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: root.itemId }, command: {
    taskId: root.itemId, expectedTaskRevision: root.revision, expectedGraphRevision: (await f.service.getSummary()).revision,
    summary: '请求补充阻塞证据，不请求重复修复授权。',
    reason: `多个调度周期中，开发子任务始终停留在 revision ${child.revision}、blocked、blockingCondition=null；必需总结未登记且无待验收交付。现有输入及可用只读工具不能确定阻塞原因，无法安全选择恢复措施。需补充宿主诊断信息，不能盲目取消、替换或重复执行；已验收验证报告不代表 QuickTest.cn 已解决，根任务保持未完成。`, question, choices } });
  let ask = await f.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30000 });
  ask = await f.service.bindIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    dispatcherId: 'work-intent-dispatcher', itemExpectedRevision: staged.item.revision, boundIntent: boundAttentionIntent(staged.item, ask) });
  const request = normalizeAttentionRequest({ requestKey: ask.intentId, type: 'ask_user', producer: { roleId: 'orchestrator', workItemId: root.itemId },
    question, choices, context: [] });
  const attention = createAttentionItem(request, 1, f.time.clock());
  await f.service.ackIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision, actorId: 'work-intent-dispatcher', outcome: 'delivered', nextStatus: 'waiting_user', details: { questionRef: attention.requestId } });
  return { ...f, control, reads, request, attention, askId: ask.intentId,
    retry: () => f.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [ask.intentId] }) };
}

test('recorded delivery diagnostics retire a host-only question while retaining accepted reports and allowing follow-up work', async () => {
  const f = await pendingDeliveryDiagnosticQuestionFixture();
  const child = await f.service.readItemForReconciliation({ itemId: f.childId });
  const inboxStore = new MemoryStore();
  const inbox = new AttentionInbox({ store: inboxStore, exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 1 });
  assert.deepEqual(f.reads, [{ itemId: f.rootId, childItemId: f.childId }]);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.childId }), child);
  assert.deepEqual(await inbox.archiveRetired(), { archived: 1 });
  assert.equal((await inbox.readOutbox()).items.length, 0);
  const parent = await f.service.readItemForReconciliation({ itemId: f.rootId });
  assert.equal(parent.status, 'queued');
  const page = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(page.facts.find(fact => fact.itemId === f.rootId).orchestrationReady, true);
  const next = await f.service.createGraphChild(prGraphChildCommand(parent, (await f.service.getSummary()).revision, 'resolve-recorded-delivery-failure'));
  assert.equal((await f.service.readItemForReconciliation({ itemId: next.taskId })).status, 'queued');
  const late = resolveAttentionItem(f.attention, { type: 'choice', choiceId: 'provide-blocker-evidence' }, 2, f.time.clock(), 1).outbox;
  const saved = await f.service.readItemForReconciliation({ itemId: f.rootId });
  await f.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.rootId }), saved);
});

test('delivery diagnostic recovery preserves real questions, pending effects and both stopped owners', async t => {
  const f = await pendingDeliveryDiagnosticQuestionFixture();
  for (const variant of ['root-pause', 'child-pause', 'root-active', 'child-active', 'root-control', 'child-control', 'child-stop-unknown',
    'child-revision', 'actor', 'business-question', 'extra-choice', 'answered', 'backlog', 'submitted-report', 'missing-acceptance',
    'failure-code', 'failure-missing', 'failure-not-latest', 'pending-effect', 'failed-effect', 'stale-effect', 'unknown-effect', 'child-history', 'root-revision']) {
    await t.test(variant, () => {
      const state = clone(f.store.stored()), control = clone(f.control), root = state.items.find(item => item.itemId === f.rootId);
      const candidate = hostContextRecoveryCandidate(state, root); assert.ok(candidate);
      const captured = { itemId: root.itemId, snapshotDigest: candidate.snapshotDigest };
      const child = state.items.find(item => item.itemId === f.childId), ask = state.outbox.find(box => box.intentId === f.askId);
      const failed = state.timeline.findLast(entry => entry.itemId === child.itemId);
      if (variant === 'root-pause') root.status = 'paused';
      if (variant === 'child-pause') child.status = 'paused';
      if (variant === 'root-active') control.run.active = true;
      if (variant === 'child-active') control.childRun.active = true;
      if (variant === 'root-control') control.run.pendingCommand = { type: 'pause' };
      if (variant === 'child-control') control.childRun.pendingCommand = { type: 'pause' };
      if (variant === 'child-stop-unknown') control.childRun.receipt.stopConfirmed = false;
      if (variant === 'child-revision') control.childRun.receipt.taskRevision++;
      if (variant === 'actor') control.actorAccountId = 'another-user';
      if (variant === 'business-question') ask.intent.question = 'Change the acceptance scope?';
      if (variant === 'extra-choice') ask.intent.choices.push({ id: 'pause', label: 'Pause' });
      if (variant === 'answered') ask.outcome.details.resultAttestation = {};
      if (variant === 'backlog') state.attentionHighWatermark++;
      if (variant === 'submitted-report') child.graph.deliveries.at(-1).status = 'submitted';
      if (variant === 'missing-acceptance') child.graph.deliveries.pop();
      if (variant === 'failure-code') failed.details.context.code = 'SOME_OTHER_ERROR';
      if (variant === 'failure-missing') delete failed.details.context.code;
      if (variant === 'failure-not-latest') state.timeline.push({ ...clone(failed), type: 'graph_acceptance_contract_revised' });
      if (variant === 'pending-effect') state.outbox.find(box => box.itemId === child.itemId).status = 'unknown';
      if (['failed-effect', 'stale-effect', 'unknown-effect'].includes(variant)) {
        const box = state.outbox.find(box => box.itemId === child.itemId), attestation = box.outcome.details.resultAttestation;
        const { resultId, contentDigest, ...body } = attestation.payload;
        body.outcome = variant.split('-')[0];
        const hash = workProposalDigest(body);
        attestation.payload = { ...body, contentDigest: hash, resultId: `work-proposal-result-${hash}` };
        const { attestationDigest, ...core } = attestation;
        attestation.attestationDigest = ledgerDigest(core);
      }
      if (variant === 'child-history') child.graph.deliveries[0].summary += ' changed';
      if (variant === 'root-revision') root.revision++;
      const before = clone(state);
      assert.deepEqual(planHostContextRecovery({ state, captured, control, clock: f.time.clock }), { write: false, result: { retried: 0 } });
      assert.deepEqual(state, before);
    });
  }
});

for (const owner of ['root', 'child']) {
  test(`a ${owner} owner change after diagnostic reading cannot retire its question`, async () => {
    const f = await pendingDeliveryDiagnosticQuestionFixture({ duringRead(control) {
      if (owner === 'root') control.run.pendingCommand = { type: 'pause' };
      else control.childRun.active = true;
    } });
    assert.deepEqual(await f.retry(), { retried: 0 });
    assert.equal((await f.service.readItemForReconciliation({ itemId: f.rootId })).status, 'waiting_user');
  });
}

test('the same delivery failure and contract cannot consume another host recovery', async () => {
  const f = await pendingDeliveryDiagnosticQuestionFixture();
  const before = clone(f.store.stored());
  assert.deepEqual(await f.retry(), { retried: 1 });
  const proof = f.store.stored().outbox.find(box => box.intentId === f.askId).outcome.details.hostContextRetirement;
  before.outbox.find(box => box.intentId === f.askId).outcome.details.hostContextRetirement = clone(proof);
  assert.equal(hostContextRecoveryCandidate(before, before.items.find(item => item.itemId === f.rootId)), null);
});

async function pendingReviewDiagnosticFixture({ sourceRecord } = {}) {
  let control, queue;
  const reads = [];
  const reader = {
    async read() { assert.fail('Review recovery must use its own automatic mode and role checks'); },
    async readReviewDiagnostics(input) {
      reads.push(clone(input));
      return { ...clone(control), confirmations: await Promise.all(input.confirmationIds.map(confirmationId => queue.readSettlement({ confirmationId }))) };
    },
    async withStoppedRuns(_control, operation) { return { executed: true, result: await operation() }; },
  };
  const record = sourceRecord ?? ownerRequestedPrAssignment(1, { gitFacts: { ...prGitFacts(PR_HEAD_A), workType: 'general',
    state: 'open', nextAction: 'rereview', suggestedCapability: 'pr-review', expectedHeadRefOid: PR_HEAD_A } });
  record.assignment.target = { type: 'role', id: 'orchestrator' };
  const f = await createFixture({ records: [record], hostContextRecoveryReader: reader });
  await f.service.intake();
  let root = (await f.service.listItems()).items[0];
  const command = prGraphChildCommand(root, (await f.service.getSummary()).revision, 'review-existing-head');
  command.command.target.id = 'pr-engineer';
  command.command.acceptanceContract.expectedDeliverables = [{ deliverableId: 'github-rereview', kind: 'github-review', description: 'Published review', required: true }];
  const created = await f.service.createGraphChild(command);
  let child = await f.service.readItemForReconciliation({ itemId: created.taskId });
  child = await f.service.claim({ itemId: child.itemId, expectedRevision: child.revision, workerId: 'employee-pr-engineer', leaseDurationMs: 30000 });
  const decisionRevision = child.revision;
  await f.service.stageIntent({ itemId: child.itemId, expectedRevision: child.revision, leaseId: child.leaseId,
    actorId: 'employee-pr-engineer', roleId: 'pr-engineer', intent: reviewIntent() });
  let proposal;
  const dispatcher = new WorkIntentDispatcher({ ledger: f.service, clock: f.time.clock,
    policy: createWorkIntentPolicy({ githubReviewRoles: ['pr-engineer'] }),
    attentionProducer: { async create() { assert.fail('unexpected attention dispatch'); } },
    proposalProducer: { async create(value) { proposal = normalizeBoundWorkProposal(value);
      return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, kind: proposal.kind,
        status: 'pending_delivery', revision: 1, createdAt: f.time.clock() }; } } });
  const dispatched = await dispatcher.dispatchPending();
  assert.equal(dispatched.delivered, 1, JSON.stringify((await f.service.listOutbox()).items.map(box => box.outcome)));
  const actorAccountId = prExecutionBinding(root).gitTarget.sourceAccountId;
  queue = new ConfirmationQueue({ store: new MemoryStore(), exclusiveLease: new ExclusiveLease(),
    clock: () => new Date(f.time.clock()), executor: { async execute() { assert.fail('no Review publication'); }, async reconcile() { assert.fail('no Review replay'); } } });
  await queue.recover();
  const plan = createGitHubReviewProposalConfirmationPlan(proposal, { actorAccountId, legacyRecovery: true });
  const queued = await queue.enqueue(plan);
  await queue.invalidate(queued.id, { requestedBy: proposal.requestedBy, approvalBindingDigest: queued.approvalBindingDigest, reason: 'authorization_changed' });
  const result = createWorkProposalResult({ proposal, sequence: 1, transition: { status: 'stale', summary: 'GitHub Review 提案已失效',
    evidence: [`confirmation:${queued.id}`] }, downstreamRef: null, at: f.time.clock() });
  await f.service.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  root = await f.service.readItemForReconciliation({ itemId: root.itemId });
  child = await f.service.readItemForReconciliation({ itemId: child.itemId });
  const stopped = (item, roleId, taskRevision) => ({ kind: 'work-item', taskId: item.itemId, roleId, active: false, mode: 'active', pendingCommand: null,
    stopUnconfirmed: false, phase: 'completed', receipt: { kind: 'work-item', taskId: item.itemId, roleId, taskRevision,
      registeredAt: f.time.clock(), modelStartedAt: f.time.clock(), finishedAt: f.time.clock(), phase: 'completed', stopConfirmed: true } });
  control = { actorAccountId, run: stopped(root, 'orchestrator', root.revision), childRun: stopped(child, 'pr-engineer', decisionRevision) };
  const question = `请补充子任务 ${child.itemId} 的 proposal-stale 宿主校验原因及当前有效绑定，以确定原任务的恢复路径。这是缺失的执行诊断，不是请求再次授权常规 Review；目前没有本轮发布成功的证据。`;
  const choices = [{ id: 'provide-stale-diagnostics', label: '补充宿主失效诊断', description: '提供失效校验项与当前有效绑定，保留原子任务及尝试历史，再确定恢复方式。' },
    { id: 'suspend-intentionally', label: '有意暂缓本轮工作', description: '仅在确需停止推进时明确暂缓；不视为 Review 已交付或根任务已完成。' }];
  const staged = await f.service.stageGraphEscalation({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: root.itemId }, command: {
    taskId: root.itemId, expectedTaskRevision: root.revision, expectedGraphRevision: (await f.service.getSummary()).revision,
    summary: '升级复审提案失效的具体诊断缺口',
    reason: '直属子任务为 blocked/proposal-stale，github-rereview 尚无交付。当前材料的 Head/Base 未变，也未提供提案失效的具体校验原因，无法安全确定恢复方式；已有 APPROVED Review 不能替代本契约权威交付，根任务不能完成。', question, choices } });
  let ask = await f.service.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision, dispatcherId: 'work-intent-dispatcher', leaseDurationMs: 30000 });
  ask = await f.service.bindIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    dispatcherId: 'work-intent-dispatcher', itemExpectedRevision: staged.item.revision, boundIntent: boundAttentionIntent(staged.item, ask) });
  const request = normalizeAttentionRequest({ requestKey: ask.intentId, type: 'ask_user', producer: { roleId: 'orchestrator', workItemId: root.itemId }, question, choices, context: [] });
  const attention = createAttentionItem(request, 1, f.time.clock());
  await f.service.ackIntent({ intentId: ask.intentId, expectedRevision: ask.revision, dispatchLeaseId: ask.dispatchLeaseId,
    itemExpectedRevision: staged.item.revision, actorId: 'work-intent-dispatcher', outcome: 'delivered', nextStatus: 'waiting_user', details: { questionRef: attention.requestId } });
  return { ...f, rootId: root.itemId, childId: child.itemId, askId: ask.intentId, request, attention, queue, control, reads, reader };
}

async function obsoleteTriageReviewFixture() {
  const jobId = 'pr-work-obsolete-review';
  const gitFacts = { ...prGitFacts(PR_HEAD_A), workType: 'general', state: 'open', nextAction: 'rereview',
    suggestedCapability: 'pr-review', expectedHeadRefOid: PR_HEAD_A };
  const base = ownerRequestedPrAssignment(1, { gitFacts });
  const ownerRequest = createPrTriageWorkRequest({ requestKey: jobId, targetRoleId: 'pr-engineer',
    repository: base.event.subject.repository, number: base.event.subject.number, nextAction: 'rereview', expectedHeadRefOid: PR_HEAD_A });
  const record = ownerRequestedPrAssignment(1, { gitFacts, sourceScopeId: `owner-request:${ownerRequest.requestId}` });
  const f = await pendingReviewDiagnosticFixture({ sourceRecord: record });
  const child = await f.service.readItemForReconciliation({ itemId: f.childId });
  const ids = reviewConfirmationSettlementIds(child, new Map(f.store.stored().outbox.map(box => [box.intentId, box])));
  const stale = (await Promise.all(ids.map(confirmationId => f.queue.readSettlement({ confirmationId })))).find(Boolean);
  const priorPlan = normalizeConfirmationPlan(Object.fromEntries(['id', 'kind', 'requestedBy', 'actor', 'target', 'action', 'display']
    .map(key => [key, key === 'id' ? `confirmation-github-review-${'9'.repeat(64)}` : clone(stale.item[key])])));
  const publishedAt = '2026-08-02T00:31:00.000Z';
  const published = { ...clone(stale.item), ...priorPlan, status: 'completed', createdAt: '2026-08-02T00:30:00.000Z', updatedAt: publishedAt,
    execution: { requestId: `auto-review-v1-${'a'.repeat(48)}`, attempt: 1, startedAt: publishedAt, outcome: 'applied' },
    receipt: { id: '12345', url: `https://github.com/${base.event.subject.repository}/pull/${base.event.subject.number}`, createdAt: publishedAt },
    failure: null, rejection: null, invalidation: null };
  normalizeConfirmationState({ schemaVersion: 1, revision: stale.queueRevision, items: [published] });
  const extra = {
    ownerRecord: { phase: 'intaken', workItemId: f.rootId, event: record.event, requestId: ownerRequest.requestId,
      request: ownerRequest, requestDigest: ownerWorkRequestDigest(ownerRequest), createdAt: record.event.occurredAt, recordDigest: 'b'.repeat(64) },
    triageJob: { id: jobId, status: 'superseded', workType: 'triage_plan', targetRoleId: 'pr-engineer', relation: 'review_requested',
      handoffWorkItemId: f.rootId, repo: base.event.subject.repository, number: base.event.subject.number,
      headRefOid: PR_HEAD_A, nextAction: 'rereview', createdAt: '2026-08-02T01:00:00.000Z', completedAt: '2026-08-02T01:11:00.000Z' },
    observedAt: f.time.clock(), incomingFacts: { kind: 'pull_request', state: 'open', isDraft: false, author: 'another-author',
      assignees: ['another-reviewer'], incomingReviewFactsAvailable: true, headRefOid: PR_HEAD_A,
      myLatestPublishedReviewCommitOid: PR_HEAD_A, myLatestPublishedReviewAt: publishedAt,
      myLatestPublishedReviewState: { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[published.display.payload.action.reviewEvent] },
    publishedReviews: [{ queueRevision: stale.queueRevision, item: published }],
  };
  f.reader.readTriageRetirement = async input => ({ ...await f.reader.readReviewDiagnostics(input), ...clone(extra) });
  return { ...f, extra };
}

test('superseded automatic Review triage retires its redundant graph and unanswered question without replaying a Review', async () => {
  const f = await obsoleteTriageReviewFixture();
  const before = await f.service.readItemForReconciliation({ itemId: f.childId });
  const rootBefore = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const candidate = triageRetirementCandidate(f.store.stored(), rootBefore);
  assert.ok(candidate, 'a quiet Review graph with an unanswered question is eligible for provenance checks');
  assert.ok(matchRetiredTriageSource({ itemId: f.rootId, inputBinding: candidate.inputBinding }, f.extra.ownerRecord, f.extra.triageJob));
  assert.ok(publishedTriageReview(f.extra.publishedReviews[0], candidate.inputBinding, f.control.actorAccountId,
    f.extra.incomingFacts, f.extra.ownerRecord.createdAt), 'the earlier automatic Review must have a well-formed matching receipt');
  const inbox = new AttentionInbox({ store: new MemoryStore(), exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 0, retired: 1 });
  const parent = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const child = await f.service.readItemForReconciliation({ itemId: f.childId });
  assert.equal(parent.status, 'cancelled');
  assert.equal(child.status, 'cancelled');
  assert.equal(child.attempt, before.attempt);
  assert.deepEqual(child.decisionContext, before.decisionContext);
  assert.deepEqual(child.graph.deliveries, before.graph.deliveries);
  assert.equal(parent.activeIntentId, null);
  const retiredBox = f.store.stored().outbox.find(box => box.intentId === f.askId);
  assert.ok(automaticTriageRetirement(retiredBox));
  for (const variant of ['digest', 'source-digest', 'question', 'status', 'binding', 'accessor']) {
    const box = clone(retiredBox), proof = box.outcome.details.automaticTriageRetirement;
    let getterCalls = 0;
    if (variant === 'digest') proof.digest = 'f'.repeat(64);
    if (variant === 'source-digest') proof.sourceDigest = 'invalid';
    if (variant === 'question') proof.questionRef = `attention-${'f'.repeat(64)}`;
    if (variant === 'status') box.status = 'failed';
    if (variant === 'binding') box.sourceBinding.inputDigest = 'f'.repeat(64);
    if (variant === 'accessor') Object.defineProperty(proof, 'digest', { enumerable: true, get() { getterCalls++; return 'f'.repeat(64); } });
    assert.equal(automaticTriageRetirement(box), null, variant);
    assert.equal(getterCalls, 0);
  }
  assert.deepEqual(await inbox.archiveRetired(), { archived: 1 });
  assert.equal((await inbox.readOutbox()).items.length, 0);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 0 });
  const late = resolveAttentionItem(f.attention, { type: 'choice', choiceId: 'provide-stale-diagnostics' }, 2, f.time.clock(), 1).outbox;
  await f.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.rootId }), parent);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.childId }), child);
});

test('automatic triage retirement preserves explicit requests, current ownership, holds, effects and publication provenance', async t => {
  const f = await obsoleteTriageReviewFixture();
  const root = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const candidate = triageRetirementCandidate(f.store.stored(), root);
  const captured = { itemId: f.rootId, snapshotDigest: candidate.snapshotDigest };
  const original = await f.reader.readTriageRetirement({ itemId: f.rootId, childItemId: f.childId,
    inputBinding: candidate.inputBinding, confirmationIds: candidate.failure.confirmationIds });
  const variants = ['manual-request', 'request-digest', 'job-not-superseded', 'different-handoff', 'different-job-head',
    'live-assignee', 'missing-assignees', 'malformed-assignees', 'new-live-head', 'missing-live-review', 'dismissed-review',
    'manual-publication', 'later-publication', 'missing-publication', 'duplicate-publication', 'wrong-actor',
    'stale-facts', 'future-facts', 'paused-parent', 'paused-child', 'inactive-source', 'changed-root',
    'active-root-run', 'paused-root-run', 'unconfirmed-child', 'unknown-proposal', 'active-intent', 'earlier-owner-answer', 'executed-stale-review', 'rejected-review'];
  for (const variant of variants) {
    await t.test(variant, () => {
      const state = clone(f.store.stored()), control = clone(original);
      const parent = state.items.find(item => item.itemId === f.rootId), child = state.items.find(item => item.itemId === f.childId);
      if (variant === 'manual-request') { control.ownerRecord.request.description += '\nExplicit additional review'; control.ownerRecord.requestDigest = ownerWorkRequestDigest(control.ownerRecord.request); }
      if (variant === 'request-digest') control.ownerRecord.requestDigest = 'f'.repeat(64);
      if (variant === 'job-not-superseded') control.triageJob.status = 'ready';
      if (variant === 'different-handoff') control.triageJob.handoffWorkItemId = 'another-root';
      if (variant === 'different-job-head') control.triageJob.headRefOid = PR_HEAD_B;
      if (variant === 'live-assignee') control.incomingFacts.assignees = [control.actorAccountId];
      if (variant === 'missing-assignees') delete control.incomingFacts.assignees;
      if (variant === 'malformed-assignees') control.incomingFacts.assignees = [null];
      if (variant === 'new-live-head') control.incomingFacts.headRefOid = PR_HEAD_B;
      if (variant === 'missing-live-review') control.incomingFacts.myLatestPublishedReviewCommitOid = '';
      if (variant === 'dismissed-review') control.incomingFacts.myLatestPublishedReviewState = 'DISMISSED';
      if (variant === 'manual-publication') control.publishedReviews[0].item.execution.requestId = 'manual-review-request';
      if (variant === 'later-publication') {
        control.publishedReviews[0].item.receipt.createdAt = f.time.clock();
        control.incomingFacts.myLatestPublishedReviewAt = f.time.clock();
      }
      if (variant === 'missing-publication') control.publishedReviews = [];
      if (variant === 'duplicate-publication') control.publishedReviews.push(clone(control.publishedReviews[0]));
      if (variant === 'wrong-actor') control.actorAccountId = 'another-actor';
      if (variant === 'stale-facts') control.observedAt = new Date(Date.parse(f.time.clock()) - 120001).toISOString();
      if (variant === 'future-facts') control.observedAt = new Date(Date.parse(f.time.clock()) + 1).toISOString();
      if (variant === 'paused-parent') parent.status = 'paused';
      if (variant === 'paused-child') child.status = 'paused';
      if (variant === 'inactive-source') parent.source.scope.active = false;
      if (variant === 'changed-root') parent.revision++;
      if (variant === 'active-root-run') control.run.active = true;
      if (variant === 'paused-root-run') control.run.mode = 'paused';
      if (variant === 'unconfirmed-child') control.childRun.receipt.stopConfirmed = false;
      if (variant === 'unknown-proposal') state.outbox.find(box => box.itemId === f.childId).status = 'unknown';
      if (variant === 'active-intent') child.activeIntentId = 'unsettled-intent';
      if (variant === 'earlier-owner-answer') {
        const earlier = clone(state.outbox.find(box => box.intentId === f.askId));
        earlier.intentId = `work-intent-${'f'.repeat(64)}`;
        earlier.outcome.details.resultAttestation = { kind: 'attention_result' };
        state.outbox.push(earlier);
      }
      if (variant === 'executed-stale-review') control.confirmations.find(Boolean).item.execution = { requestId: 'unknown-execution', attempt: 1, startedAt: f.time.clock(), outcome: 'unknown' };
      if (variant === 'rejected-review') control.confirmations.find(Boolean).item.status = 'rejected';
      const before = clone(state);
      assert.deepEqual(planTriageRetirement({ state, captured, control, clock: f.time.clock }), { write: false, result: { retired: 0 } });
      assert.deepEqual(state, before);
    });
  }
});

test('a changed task-run guard leaves automatic triage retirement and ordinary recovery untouched', async () => {
  const f = await obsoleteTriageReviewFixture();
  f.reader.withStoppedRuns = async () => ({ executed: false });
  const before = clone(f.store.stored());
  const inbox = new AttentionInbox({ store: new MemoryStore(), exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 0 });
  assert.deepEqual(f.store.stored(), before);
});

test('an answered triage question stays on the normal answer path and is never automatically retired', async () => {
  const f = await obsoleteTriageReviewFixture();
  const inbox = new AttentionInbox({ store: new MemoryStore(), exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  const question = await inbox.next();
  await inbox.answer({ requestId: question.requestId, expectedRevision: question.revision, contentDigest: question.contentDigest,
    answer: { type: 'choice', choiceId: 'provide-stale-diagnostics' } });
  const before = clone(f.store.stored());
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 0 });
  assert.deepEqual(f.store.stored(), before);
  assert.equal((await inbox.readOutbox()).items.length, 1);
});

test('automatic triage retirement fingerprints complete legal contract histories without truncating its CAS', async () => {
  const f = await obsoleteTriageReviewFixture(), state = clone(f.store.stored());
  for (const item of state.items.filter(item => [f.rootId, f.childId].includes(item.itemId))) {
    item.revision += 31;
    for (let revision = 2; revision <= 32; revision++) item.graph.acceptanceContracts.push({ revision,
      acceptanceCriteria: Array.from({ length: 64 }, (_, index) => ({ criterionId: `criterion-${String(index).padStart(2, '0')}`, description: 'Historical criterion' })),
      expectedDeliverables: Array.from({ length: 64 }, (_, index) => ({ deliverableId: `report-${String(index).padStart(2, '0')}`,
        kind: 'text-report', description: 'Optional historical report', required: false })), recordedAt: item.updatedAt });
  }
  state.revision += 62;
  const staged = state.timeline.find(entry => entry.itemId === f.rootId && entry.type === 'intent_staged');
  staged.details.workItemRevision += 31;
  const { timelineId, contentDigest, ...content } = staged;
  staged.contentDigest = ledgerDigest(content); staged.timelineId = `work-timeline-${staged.contentDigest}`;
  f.control.run.receipt.taskRevision += 31;
  state.graphMemoryProjection = migrateWorkGraphMemoryProjection(state.items, state.revision, normalizeWorkLedgerLimits());
  const legal = normalizeWorkLedgerPersistedState(state), root = legal.items.find(item => item.itemId === f.rootId);
  const candidate = triageRetirementCandidate(legal, root);
  assert.ok(candidate);
  const captured = { itemId: f.rootId, snapshotDigest: candidate.snapshotDigest };
  const control = await f.reader.readTriageRetirement({ itemId: f.rootId, childItemId: f.childId,
    inputBinding: candidate.inputBinding, confirmationIds: candidate.failure.confirmationIds });
  const result = planTriageRetirement({ state: legal, captured, control, clock: f.time.clock });
  assert.equal(result.result.retired, 1);
  assert.equal(result.patch.items.find(item => item.itemId === f.childId).graph.acceptanceContracts.length, 32);
  const changed = clone(legal);
  changed.items.find(item => item.itemId === f.childId).graph.acceptanceContracts[20].acceptanceCriteria[40].description = 'Changed historical evidence';
  assert.deepEqual(planTriageRetirement({ state: changed, captured, control, clock: f.time.clock }), { write: false, result: { retired: 0 } });
});

test('recorded Review revocation supplies host diagnostics and archives the old question without publishing or accepting a Review', async () => {
  const f = await pendingReviewDiagnosticFixture();
  const child = await f.service.readItemForReconciliation({ itemId: f.childId });
  const reviewBox = f.store.stored().outbox.find(box => box.itemId === child.itemId);
  assert.deepEqual(reviewBox.sourceBinding, currentWorkItemInputBinding(child));
  assert.deepEqual(reviewBox.dispatchBinding.boundIntent.binding.inputBinding, prExecutionBinding(child));
  assert.equal(isChangedReviewConfirmationDecision(child.decisionContext), true);
  assert.ok(reviewConfirmationSettlementIds(child, new Map(f.store.stored().outbox.map(box => [box.intentId, box]))).length, 'matching historical confirmation plans');
  assert.ok(reviewDiagnosticState(f.store.stored(), child));
  const before = await f.service.readItemForReconciliation({ itemId: f.rootId });
  const candidate = hostContextRecoveryCandidate(f.store.stored(), before);
  assert.ok(candidate);
  const inbox = new AttentionInbox({ store: new MemoryStore(), exclusiveLease: new ExclusiveLease(), authority: f.service, clock: f.time.clock });
  await inbox.recover(); await inbox.create(f.request);
  assert.deepEqual(await inbox.retrySystemQuestions(), { retried: 1 }, JSON.stringify(f.reads));
  const parent = await f.service.readItemForReconciliation({ itemId: f.rootId });
  assert.equal(parent.status, 'queued');
  assert.equal(parent.decisionContext.value.kind, 'host_review_diagnostic');
  assert.equal(parent.decisionContext.value.invalidationReason, 'authorization_changed');
  assert.equal(parent.decisionContext.value.publicationExecuted, false);
  assert.equal(parent.decisionContext.value.contractSatisfied, false);
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.childId }), child);
  assert.deepEqual(await inbox.archiveRetired(), { archived: 1 });
  assert.equal((await inbox.readOutbox()).items.length, 0);
  const ready = await f.service.listClaimCandidates({ at: f.time.clock(), roleId: 'orchestrator' });
  assert.equal(ready.facts.find(row => row.itemId === f.rootId).orchestrationReady, true);
  const late = resolveAttentionItem(f.attention, { type: 'choice', choiceId: 'suspend-intentionally' }, 2, f.time.clock(), 1).outbox;
  await f.service.applyAttentionBatch({ items: [late], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
  assert.deepEqual(await f.service.readItemForReconciliation({ itemId: f.rootId }), parent);
  // Exercise the normal coordinator's cleanup path, without a replacement Review.
  await f.service.cancelGraphTask({ authority: { actorId: 'employee-orchestrator', scopeRootTaskId: parent.itemId }, command: {
    taskId: child.itemId, expectedTaskRevision: child.revision, expectedGraphRevision: (await f.service.getSummary()).revision,
    reason: 'Already-reviewed Head has left this automatic assignment' } });
  const claimed = await f.service.claim({ itemId: parent.itemId, expectedRevision: parent.revision,
    workerId: 'employee-orchestrator', leaseDurationMs: 30000 });
  await f.service.complete({ itemId: claimed.itemId, expectedRevision: claimed.revision, leaseId: claimed.leaseId,
    actorId: 'employee-orchestrator', result: { outcome: 'obsolete-review-request-retired' } });
  assert.equal((await f.service.readItemForReconciliation({ itemId: parent.itemId })).status, 'completed');
});

test('Review diagnostic recovery preserves paused owners, user decisions, effects and exact confirmation authority', async t => {
  const f = await pendingReviewDiagnosticFixture();
  const saved = clone(f.store.stored()), root = saved.items.find(item => item.itemId === f.rootId);
  const captured = { itemId: root.itemId, snapshotDigest: hostContextRecoveryCandidate(saved, root).snapshotDigest };
  const ids = hostContextRecoveryCandidate(saved, root).confirmationIds;
  const control = { ...clone(f.control), confirmations: await Promise.all(ids.map(confirmationId => f.queue.readSettlement({ confirmationId }))) };
  for (const variant of ['root-paused', 'child-paused', 'root-active', 'child-active', 'root-command', 'child-command', 'unknown-stop',
    'root-revision', 'child-revision', 'child-receipt-role', 'account', 'business-question', 'selected-choice', 'source-left', 'source-pending',
    'pending-effect', 'unknown-effect', 'changed-child-input', 'unbound-result', 'wrong-reference', 'missing-confirmation',
    'pending-confirmation', 'executing-confirmation', 'completed-confirmation', 'rejected-confirmation', 'unknown-confirmation-effect',
    'different-invalidation', 'confirmation-binding', 'duplicate-snapshot', 'changed-history']) await t.test(variant, () => {
    const state = clone(saved), observed = clone(control), parent = state.items.find(item => item.itemId === f.rootId);
    const child = state.items.find(item => item.itemId === f.childId), ask = state.outbox.find(box => box.intentId === f.askId);
    const box = state.outbox.find(box => box.itemId === child.itemId), confirmation = observed.confirmations.find(value => value !== null);
    if (variant === 'root-paused') observed.run.mode = 'paused';
    if (variant === 'child-paused') observed.childRun.mode = 'paused';
    if (variant === 'root-active') observed.run.active = true;
    if (variant === 'child-active') observed.childRun.active = true;
    if (variant === 'root-command') observed.run.pendingCommand = { type: 'pause' };
    if (variant === 'child-command') observed.childRun.pendingCommand = { type: 'pause' };
    if (variant === 'unknown-stop') observed.childRun.receipt.stopConfirmed = false;
    if (variant === 'root-revision') parent.revision++;
    if (variant === 'child-revision') child.revision++;
    if (variant === 'child-receipt-role') observed.childRun.receipt.roleId = 'developer';
    if (variant === 'account') observed.actorAccountId = 'other-user';
    if (variant === 'business-question') ask.intent.question = 'Should we change the requirements?';
    if (variant === 'selected-choice') ask.outcome.details.resultAttestation = {};
    if (variant === 'source-left') parent.source.scope.active = false;
    if (variant === 'source-pending') parent.source.pendingRevision = 2;
    if (variant === 'pending-effect') box.status = 'pending';
    if (variant === 'unknown-effect') box.status = 'unknown';
    if (variant === 'changed-child-input') box.inputDigest = box.sourceBinding.inputDigest;
    if (variant === 'unbound-result') box.dispatchBinding = null;
    if (variant === 'wrong-reference') child.decisionContext.value.evidence[0] = `confirmation:confirmation-github-review-${'f'.repeat(64)}`;
    if (variant === 'missing-confirmation') observed.confirmations = observed.confirmations.map(() => null);
    if (variant === 'pending-confirmation') confirmation.item.status = 'pending';
    if (variant === 'executing-confirmation') confirmation.item.status = 'executing';
    if (variant === 'completed-confirmation') confirmation.item.status = 'completed';
    if (variant === 'rejected-confirmation') confirmation.item.status = 'rejected';
    if (variant === 'unknown-confirmation-effect') confirmation.item.execution = {};
    if (variant === 'different-invalidation') confirmation.item.invalidation.reason = 'head_changed';
    if (variant === 'confirmation-binding') confirmation.item.approvalBindingDigest = 'f'.repeat(64);
    if (variant === 'duplicate-snapshot') observed.confirmations.push(clone(confirmation));
    if (variant === 'changed-history') box.revision++;
    assert.equal(planHostContextRecovery({ state, captured, control: observed, clock: f.time.clock }).result.retried, 0);
  });
});

test('the same Review diagnostic cannot repeatedly retire questions and malformed legacy evidence stays untrusted', async () => {
  const f = await pendingReviewDiagnosticFixture();
  const original = clone(f.store.stored());
  assert.deepEqual(await f.service.retrySystemMaintenanceQuestions({ limit: 10, requestKeys: [f.askId] }), { retried: 1 });
  const proof = f.store.stored().outbox.find(box => box.intentId === f.askId).outcome.details.hostContextRetirement;
  original.outbox.find(box => box.intentId === f.askId).outcome.details.hostContextRetirement = clone(proof);
  assert.equal(hostContextRecoveryCandidate(original, original.items.find(item => item.itemId === f.rootId)), null);
  const child = original.items.find(item => item.itemId === f.childId);
  child.decisionContext.value.evidence = [{ toString: null }];
  assert.equal(isChangedReviewConfirmationDecision(child.decisionContext), false);
});


test("a sealed historical code confirmation settles after an intervening source activation", async () => {
  const f = await revokedCodeConfirmationFixture({ createdJob: true });
  let job = (await f.jobs.list()).items[0];
  await f.jobs.fence({ jobId: job.jobId, expectedRevision: job.revision,
    result: { code: "INVALID_CODE_JOB_AUTHORITY", message: "Old source authority expired before execution" } });
  const before = await f.jobs.get(job.jobId);
  const { activatePendingPullRequestWorkSource } = await import('../src/services/work-ledger-pr-source.js');
  const previous = f.store.stored(), durable = clone(previous);
  const root = durable.items.find(i => i.itemId === f.item.itemId);
  // A retained legacy source advance leaves the sealed old decision attached.
  root.source = activatePendingPullRequestWorkSource(root.source, { attemptAtActivation: root.attempt }).source;
  root.inputDigest = root.source.current.inputDigest;
  root.statusReason = "pr_source_revised";
  durable.graphMemoryProjection = appendWorkGraphMemoryEvents(previous, durable, normalizeWorkLedgerLimits()).graphMemoryProjection;
  f.store.replaceStored(durable);
  const settler = new ObsoleteCodeJobSettler({ codeJobReader: f.jobs,
    codeJobControl: { cancel: async () => assert.fail("a terminal historical job must never be replayed or cancelled") } });
  const service = new WorkLedgerService({ store: f.store, assignmentSource: f.source, exclusiveLease: f.lease,
    clock: f.time.clock, idFactory: incrementingIds(), confirmationSettlementReader: f.service.confirmationSettlementReader,
    obsoleteCodeJobSettler: settler });
  await service.recover();
  const update = authoredReviewRepairAssignment(3, { headRefOid: "c".repeat(40), previousHeadRefOid: PR_HEAD_B,
    changedFields: ["headRefOid"], occurredAt: "2026-08-02T01:30:00.000Z" });
  update.assignment.target = { type: "role", id: "developer" };
  f.source.records.push(update); f.source.highWatermark = 3;
  await service.intake();
  const pending = await service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(pending.source.activeRevision, 2);
  assert.equal(pending.source.pendingRevision, 3);
  const command = { itemId: root.itemId, expectedRevision: pending.revision,
    expectedPendingRevision: 3, expectedGraphRevision: (await service.getSummary()).revision };
  const { completedCodeConfirmationForSettlement } = await import('../src/services/work-ledger-code-confirmation-settlement.js');
  const snapshot = await f.confirmationQueue.readSettlement({ confirmationId: f.plan.id });
  const state = f.store.stored();
  for (const variant of ["unrecorded", "rejected", "event-digest", "wrong-work-key", "wrong-root", "input-digest", "missing-seal", "no-pending"]) {
    const copied = clone(state), item = copied.items.find(i => i.itemId === root.itemId);
    const box = copied.outbox.find(o => o.itemId === root.itemId && o.outcome?.details?.downstreamRef === item.decisionContext.referenceId);
    if (variant === "unrecorded") item.source.bindings = item.source.bindings.filter(b => b.inputRevision !== box.sourceBinding.inputRevision);
    if (variant === "rejected") item.source.revisions[box.sourceBinding.inputRevision - 1].disposition = "ignored_stale";
    if (variant === "event-digest") item.source.revisions[box.sourceBinding.inputRevision - 1].eventDigest = "f".repeat(64);
    if (variant === "wrong-work-key") box.sourceBinding.workKey = "another-work-key";
    if (variant === "wrong-root") box.sourceBinding.rootItemId = "another-root";
    if (variant === "input-digest") box.inputDigest = "f".repeat(64);
    if (variant === "missing-seal") delete box.outcome.details.resultAttestation;
    if (variant === "no-pending") item.source.pendingRevision = null;
    assert.equal(completedCodeConfirmationForSettlement(item, new Map(copied.outbox.map(o => [o.intentId, o])), snapshot), null, variant);
  }
  service.obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader: { get: id => f.jobs.get(id) },
    codeJobControl: { cancel: async () => assert.fail("no terminal detail means no recovery") } });
  assert.equal((await service.reconcilePullRequestSource(command)).applied, false, "historical identity is not physical stop evidence");
  service.obsoleteCodeJobSettler = settler;
  const result = await service.reconcilePullRequestSource(command);
  assert.equal(result.applied, true, "settled old confirmation must not pin later review/Head input forever");
  const current = await service.readItemForReconciliation({ itemId: root.itemId });
  assert.equal(current.status, "queued");
  assert.equal(current.source.pendingRevision, null);
  assert.equal(current.source.current.headRefOid, "c".repeat(40));
  assert.deepEqual(await f.jobs.get(job.jobId), before);
});

async function ownConflictRecoveryFixture({ sealedChild = false } = {}) {
  const f = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await f.service.intake();
  const sealed = sealedChild ? await stageSealedPrChildReview(f) : null;
  const left = prAssignment(2, { eventType: 'pull_request.left_scope', occurredAt: '2026-08-02T01:05:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A) }).event;
  const returned = prAssignment(3, { eventType: 'pull_request.created', headRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:20:00.000Z', gitFacts: { ...prGitFacts(PR_HEAD_B), state: 'open', isDraft: false,
      author: 'runtime-user', assignees: ['runtime-user'], relation: 'authored', actionState: 'action_now', nextAction: 'resolve_conflict' } });
  returned.assignment.target.id = 'developer';
  returned.assignment.ruleId = AUTHORED_PR_SELF_FIX_RULE_ID;
  f.source.records.push(prScopeLifecycleAssignment(2, left), returned); f.source.highWatermark = 3;
  await f.service.intake();
  const recovered = await createFixture({ source: f.source, store: f.store });
  const roots = (await recovered.service.listItems()).items;
  const previous = roots.find(item => item.currentTarget.id === 'pr-engineer');
  const fenced = roots.find(item => item.currentTarget.id === 'developer');
  return { f, recovered, previous, fenced, returned, sealed };
}

test('own conflict reconnection preserves an independently current owner request', async () => {
  const { f, recovered, previous, returned } = await ownConflictRecoveryFixture();
  const owner = ownerRequestedPrAssignment(4, { headRefOid: PR_HEAD_B, gitFacts: prGitFacts(PR_HEAD_B),
    occurredAt: '2026-08-02T01:25:00.000Z' });
  f.source.records.push(owner); f.source.highWatermark = 4;
  await recovered.service.intake();
  const latest = await recovered.service.readItemForReconciliation({ itemId: previous.itemId });
  assert.equal(await recovered.service.canReconnectOwnPullRequest({ itemId: latest.itemId,
    expectedRevision: latest.revision, event: returned.event }), false);
  const current = (await recovered.service.listItems()).items.find(item => item.source?.scope.kind === 'owner_requested');
  assert.equal(pullRequestHeadAdmission(f.store.stored(), current).current, true);
});

test('own conflict reconnection preserves a sealed unresolved predecessor child', async () => {
  const { f, recovered, previous, returned, sealed } = await ownConflictRecoveryFixture({ sealedChild: true });
  const before = f.store.stored().outbox.find(entry => entry.intentId === sealed.outbox.intentId);
  assert.equal(await recovered.service.canReconnectOwnPullRequest({ itemId: previous.itemId,
    expectedRevision: previous.revision, event: returned.event }), false);
  assert.deepEqual(f.store.stored().outbox.find(entry => entry.intentId === sealed.outbox.intentId), before);
});

for (const limit of [1, 100]) test(`a fresh verified own conflict reconnects a fenced developer root through normal intake (limit=${limit})`, async () => {
  const { f, recovered, previous, fenced, returned } = await ownConflictRecoveryFixture();
  assert.equal(previous.source.scope.active, false);
  assert.equal(fenced.statusReason, 'pr_source_authority_fenced');
  assert.equal(fenced.source.pendingRevision, null);
  assert.equal(pullRequestHeadAdmission(f.store.stored(), fenced).current, false);
  const { AutomaticReviewReentryReader } = await import('../src/services/automatic-review-reentry-reader.js');
  const reader = new AutomaticReviewReentryReader({ ledger: recovered.service, account: 'runtime-user',
    automaticReview: false, automaticOwnPrRepair: true,
    github: { async readPullRequestRoleHandoffFacts() { return { state: 'open', isDraft: false, author: 'runtime-user',
      assignees: ['runtime-user'], gitTarget: { ...returned.event.payload.gitTarget, baseRefOid: 'e'.repeat(40) } }; } } });
  const values = new Map();
  const runtime = await createWorkflowRoutingRuntime({ workflowRouting: { schemaVersion: 1, enabled: true, maxHops: 8,
    rules: [{ id: 'own-conflict-route', source: 'root', enabled: true, priority: 1, fallback: false,
      condition: { op: 'equals', path: 'payload.relation', value: 'authored' },
      targets: [{ type: 'role', id: 'developer' }], onMatch: 'stop' }] } }, {
    store: { async read(name, fallback) { return clone(values.get(name) ?? fallback); }, async write(name, value) { values.set(name, clone(value)); } },
    clock: () => '2026-08-02T01:30:00.000Z', createGuard: () => ({ async acquire() {}, run: operation => operation(), async close() {} }),
    scopeReentryReader: reader,
  });
  try {
    const snapshot = { refreshedAt: '2026-08-02T01:30:00.000Z',
      sourceStatus: { githubPullRequests: { ok: true, complete: true, stale: false }, githubIssues: { ok: true } },
      items: [{ ...returned.event.payload, gitTarget: { ...returned.event.payload.gitTarget, baseRefOid: 'e'.repeat(40) },
        kind: 'pull_request', id: returned.event.subject.id, repo: 'acme/repo', number: 42 }] };
    await runtime.ingestSnapshot({ snapshot });
    const feed = await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 });
    assert.ok(feed.items.some(record => record.event.eventType === 'pull_request.updated' &&
      record.event.payload.previousHeadRefOid === PR_HEAD_A && record.assignment.target.id === 'developer'));
    f.source.records.push(...feed.items.map((record, index) => ({ ...record, sequence: 4 + index })));
    f.source.highWatermark = 3 + feed.items.length;
    while (f.store.stored().intakeCursor < f.source.highWatermark) await recovered.service.intake({ limit });
    const current = await recovered.service.readItemForReconciliation({ itemId: fenced.itemId });
    assert.equal(current.status, 'queued');
    assert.equal(current.source.current.headRefOid, PR_HEAD_B);
    assert.equal(current.source.current.event.payload.gitTarget.baseRefOid, 'e'.repeat(40));
    await recovered.service.verifyPullRequestExecutionBinding(prExecutionBinding(current));
    assert.equal((await recovered.service.readItemForReconciliation({ itemId: previous.itemId })).source.scope.active, false);
    const restarted = await createFixture({ source: f.source, store: f.store });
    await restarted.service.verifyPullRequestExecutionBinding(prExecutionBinding(current));
    const stableFeed = await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 });
    await runtime.ingestSnapshot({ snapshot });
    assert.deepEqual(await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 }), stableFeed);
  } finally { await runtime.close(); }
});

for (const limit of [1, 100]) test(`a fresh complete snapshot reconnects a reassigned PR whose new created Head was unproven (limit=${limit})`, async () => {
  const f = await createFixture({ records: [prAssignment(1, { gitFacts: prGitFacts(PR_HEAD_A) })] });
  await f.service.intake();
  const left = prAssignment(2, { eventType: 'pull_request.left_scope', occurredAt: '2026-08-02T01:05:00.000Z',
    gitFacts: prGitFacts(PR_HEAD_A) }).event;
  f.source.records.push(prScopeLifecycleAssignment(2, left)); f.source.highWatermark = 2;
  await f.service.intake();
  const returned = prAssignment(4, { eventType: 'pull_request.created', headRefOid: PR_HEAD_B,
    occurredAt: '2026-08-02T01:20:00.000Z', gitFacts: { ...prGitFacts(PR_HEAD_B), state: 'open', isDraft: false,
      author: 'another-user', assignees: ['runtime-user'], relation: 'review_requested', nextAction: 'rereview',
      incomingReviewFactsAvailable: true, reviewRecipient: 'runtime-user', reviewReceivedFrom: 'another-user',
      reviewReceivedVia: 'assignee', reviewReceivedAt: '2026-08-02T01:19:00.000Z', reviewRequestEventId: 'new-assignment' } });
  f.source.records.push(prScopeLifecycleAssignment(3, returned.event), returned); f.source.highWatermark = 4;
  await f.service.intake();
  const old = (await f.service.listItems()).items[0];
  assert.equal(old.source.scope.active, false);
  assert.equal(old.source.revisions.at(-1).disposition, 'ignored_unproven_head');
  const { AutomaticReviewReentryReader } = await import('../src/services/automatic-review-reentry-reader.js');
  const values = new Map();
  let recoveryEnabled = false;
  const reader = new AutomaticReviewReentryReader({ ledger: f.service, account: 'runtime-user' });
  const runtime = await createWorkflowRoutingRuntime({ workflowRouting: { schemaVersion: 1, enabled: true, maxHops: 8,
    rules: [{ id: 'review-route', source: 'root', enabled: true, priority: 1, fallback: false,
      condition: { op: 'equals', path: 'payload.relation', value: 'review_requested' },
      targets: [{ type: 'role', id: 'pr-engineer' }], onMatch: 'stop' }] } }, {
    store: { async read(name, fallback) { return clone(values.get(name) ?? fallback); }, async write(name, value) { values.set(name, clone(value)); } },
    clock: () => '2026-08-02T01:30:00.000Z',
    createGuard: () => ({ async acquire() {}, run: operation => operation(), async close() {} }),
    scopeReentryReader: { read: options => recoveryEnabled ? reader.read(options) : [] },
  });
  try {
    const snapshot = { refreshedAt: '2026-08-02T01:30:00.000Z',
      sourceStatus: { githubPullRequests: { ok: true, complete: true, stale: false }, githubIssues: { ok: true } },
      items: [{ ...returned.event.payload, kind: 'pull_request', id: returned.event.subject.id, repo: 'acme/repo', number: 42 }] };
    await runtime.ingestSnapshot({ snapshot });
    recoveryEnabled = true;
    await runtime.ingestSnapshot({ snapshot });
    const feed = await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 });
    assert.ok(feed.items.some(record => record.event.eventType === 'pull_request.created' &&
      record.assignment.target.id === 'pr-engineer'), JSON.stringify(feed.items.map(record => ({ type: record.event.eventType,
      target: record.assignment.target, relation: record.event.payload.relation }))));
    f.source.records.push(...feed.items.map((record, index) => ({ ...record, sequence: 5 + index })));
    f.source.highWatermark = 4 + feed.items.length;
    for (let index = 0; index < feed.items.length && f.store.stored().intakeCursor < f.source.highWatermark; index++) {
      await f.service.intake({ limit });
    }
    assert.equal(f.store.stored().intakeCursor, f.source.highWatermark);
    const current = await f.service.readItemForReconciliation({ itemId: old.itemId });
    assert.equal(current.source.scope.active, true);
    assert.equal(current.status, 'queued');
    assert.equal(current.source.current.headRefOid, PR_HEAD_B);
    await f.service.verifyPullRequestExecutionBinding(prExecutionBinding(current));
    await assert.rejects(f.service.verifyPullRequestExecutionBinding(prExecutionBinding(old)),
      error => error.code === 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE');
    const restarted = await createFixture({ store: f.store, source: f.source });
    await restarted.service.verifyPullRequestExecutionBinding(prExecutionBinding(current));
    const stableFeed = await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 });
    await runtime.ingestSnapshot({ snapshot });
    assert.deepEqual(await runtime.readAssignmentBatch({ afterSequence: 0, limit: 100 }), stableFeed);
  } finally { await runtime.close(); }
});

async function legacyAutomaticReviewTestingFixture() {
  const { reviewHandoffRequestId } = await import('../src/domain/review-handoff.js');
  const confirmation = { id: `confirmation-github-review-${'a'.repeat(64)}`, kind: 'github.work-proposal-review',
    actor: { provider: 'github', accountId: 'runtime-user' }, target: { provider: 'github', resourceId: 'acme/repo#42', version: PR_HEAD_A },
    action: { type: 'pull_request_review', reviewEvent: 'APPROVE', body: 'Reviewed' }, status: 'completed',
    receipt: { id: 'published-review' }, execution: { requestId: `auto-review-v1-${'b'.repeat(48)}` },
    approvalBindingDigest: 'c'.repeat(64), displayedPayloadDigest: 'd'.repeat(64) };
  const requestId = reviewHandoffRequestId(confirmation);
  const person = { login: 'qa-owner', product: 'qt' };
  const record = ownerRequestedPrAssignment(1, { sourceScopeId: `owner-request:${requestId}`,
    gitFacts: { ...prGitFacts(PR_HEAD_A), workType: 'testing', responsiblePerson: person,
      description: `已确认完成 GitHub Review，继续处理 https://github.com/acme/repo/pull/42。\n确认：${confirmation.id}\n批准时 Head：${PR_HEAD_A}` } });
  record.assignment.target = { type: 'role', id: 'tester' };
  const f = await createFixture({ records: [record] }); await f.service.intake();
  let root = (await f.service.listItems()).items[0];
  root = await f.service.claim({ itemId: root.itemId, expectedRevision: root.revision,
    workerId: 'employee-tester', leaseDurationMs: 30_000 });
  await f.service.transition({ itemId: root.itemId, expectedRevision: root.revision, leaseId: root.leaseId,
    actorId: 'employee-tester', toStatus: 'waiting_external', reason: 'legacy_automatic_testing' });
  root = await f.service.readItemForReconciliation({ itemId: root.itemId });
  confirmation.reviewHandoff = { requestId, selection: { workType: 'testing', responsiblePerson: person },
    status: 'completed', workItemId: root.itemId, roleId: 'tester', assignedLogin: person.login };
  f.service.confirmationSettlementReader = { async read() { return { item: clone(confirmation) }; } };
  const job = { jobId: 'legacy-review-test-job', revision: 1, status: 'active', requestedBy: { roleId: 'tester', workItemId: root.itemId },
    workspaceId: 'oct-software', operation: 'verify', inputBinding: prExecutionBinding(root), writablePaths: [], turn: 0, observationCount: 0, uncertainty: null };
  let cancels = 0, unconfirmed = false, jobPaused = false;
  const observations = [];
  const session = { id: job.jobId, workspaceId: job.workspaceId, status: 'cancelled', attempt: { status: 'cancelled' },
    cleanupPending: false, inputBinding: job.inputBinding, requestedBy: job.requestedBy, actions: [], workspaceRevision: 'e'.repeat(64) };
  const { AutomaticReviewTestingStopReader } = await import('../src/services/automatic-review-testing-retirement.js');
  f.service.reviewTestingRetirementReader = new AutomaticReviewTestingStopReader({
    codeJobs: { async list() { return { revision: job.revision, items: [clone(job)], nextCursor: null }; }, async get() { return clone(job); },
      async getDetail() { return { archived: false, historyAvailable: true, terminalDetail: { code: 'CODE_JOB_CANCELLED' },
        job: clone(job), observations: clone(observations), nextCursor: null }; } },
    codeControl: { async cancel(input) { assert.equal(input.jobId, job.jobId); cancels++; job.status = 'cancelling'; job.revision++; } },
    codeExecutor: { async view() { return clone(session); } },
    taskRuns: { async get(kind, taskId) { return { kind, taskId, roleId: 'tester', runId: `${kind}-run`,
      active: kind === 'code-job' && ['active', 'cancelling'].includes(job.status), mode: kind === 'code-job' && jobPaused ? 'paused' : 'active',
      pendingCommand: null, stopUnconfirmed: unconfirmed, receipt: { kind, taskId, roleId: 'tester', runId: `${kind}-run`,
        phase: 'completed', finishedAt: '2026-08-02T01:50:00.000Z', stopConfirmed: !unconfirmed } }; } },
  });
  return { ...f, root, confirmation, job, session, observations, get cancels() { return cancels; },
    setUnconfirmed(value) { unconfirmed = value; }, setJobPaused(value) { jobPaused = value; } };
}

test('system retires legacy automatic QA work only after normal code cancellation and confirmed stop', async () => {
  const f = await legacyAutomaticReviewTestingFixture();
  assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
  assert.equal(f.cancels, 1);
  assert.equal((await f.service.readItemForReconciliation({ itemId: f.root.itemId })).status, 'waiting_external');
  assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
  assert.equal(f.cancels, 1);
  f.job.status = 'cancelled'; f.job.revision++; f.setUnconfirmed(true);
  assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
  f.setUnconfirmed(false);
  const runtime = await createWorkLedgerRuntime({ store: f.store, assignmentSource: f.source, clock: f.time.clock,
    confirmationSettlementReader: f.service.confirmationSettlementReader,
    reviewTestingRetirementReader: f.service.reviewTestingRetirementReader,
    createGuard: () => ({ async acquire() {}, run: operation => f.lease.run(operation), async close() {} }) });
  try { assert.deepEqual(await runtime.retireAutomaticReviewTestingWork(), { retired: 1 }); }
  finally { await runtime.close(); }
  const retired = await f.service.readItemForReconciliation({ itemId: f.root.itemId });
  assert.equal(retired.status, 'cancelled');
  assert.equal(retired.statusReason, 'automatic_review_external_qa_only');
  assert.deepEqual(retired.source, f.root.source);
  assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
  const restarted = await createFixture({ store: f.store, source: f.source });
  assert.equal((await restarted.service.readItemForReconciliation({ itemId: retired.itemId })).status, 'cancelled');
});

test('a JSON stop flag cannot authorize retirement of legacy QA work', async () => {
  const f = await legacyAutomaticReviewTestingFixture();
  f.service.reviewTestingRetirementReader = { async read() { return { stopped: true }; } };
  assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
  assert.equal(f.cancels, 0);
  assert.equal((await f.service.readItemForReconciliation({ itemId: f.root.itemId })).status, 'waiting_external');
});

for (const variant of ['manual-review', 'wrong-Head', 'wrong-actor', 'wrong-request', 'wrong-work', 'wrong-QA', 'paused-code-job', 'paused-native-control']) {
  test(`legacy QA retirement preserves unrelated authority (${variant})`, async () => {
    const f = await legacyAutomaticReviewTestingFixture();
    if (variant === 'manual-review') f.confirmation.execution.requestId = 'explicit-owner-approval';
    if (variant === 'wrong-Head') f.confirmation.target.version = PR_HEAD_B;
    if (variant === 'wrong-actor') f.confirmation.actor.accountId = 'another-reviewer';
    if (variant === 'wrong-request') f.confirmation.reviewHandoff.requestId = 'different-request';
    if (variant === 'wrong-work') f.confirmation.reviewHandoff.workItemId = 'different-root';
    if (variant === 'wrong-QA') f.confirmation.reviewHandoff.assignedLogin = 'different-QA';
    if (variant === 'paused-code-job') f.job.status = 'paused';
    if (variant === 'paused-native-control') f.setJobPaused(true);
    assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
    assert.equal(f.cancels, 0);
    assert.equal((await f.service.readItemForReconciliation({ itemId: f.root.itemId })).status, 'waiting_external');
  });
}

for (const status of ['completed', 'failed', 'fenced']) {
  test(`legacy QA work with positively stopped ${status} execution can retire without rewriting job history`, async () => {
    const f = await legacyAutomaticReviewTestingFixture();
    f.job.status = status; f.job.turn = 1; f.job.observationCount = 1;
    f.session.status = f.session.attempt.status = status === 'fenced' ? 'interrupted' : status;
    f.session.actions.push({ id: 'read-1', type: 'read_text', status: 'succeeded', workspaceRevisionAfter: f.session.workspaceRevision });
    f.observations.push({ actionId: 'read-1', actionType: 'read_text', status: 'succeeded', workspaceRevision: f.session.workspaceRevision });
    const before = clone(f.job);
    f.setUnconfirmed(true);
    assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
    f.setUnconfirmed(false);
    f.session.cleanupPending = true;
    assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 0 });
    f.session.cleanupPending = false;
    assert.deepEqual(await f.service.retireAutomaticReviewTestingWork(), { retired: 1 });
    assert.deepEqual(f.job, before);
    assert.equal(f.cancels, 0);
  });
}
