import assert from "node:assert/strict";
import test from "node:test";
import { createCodeJobGrant, createQueuedCodeJob, CODE_JOB_ACTIONS_BY_OPERATION } from "../src/domain/code-job-contract.js";
import { projectNormalizedCodeJobForBrowser } from "../src/domain/code-job-browser-projection.js";
import { FailedCodeJobContextReader, VERIFICATION_RECOVERY_ACTOR, VERIFICATION_RECOVERY_REASON,
  AUTOMATIC_VERIFICATION_FAILURE } from "../src/services/failed-code-job-context-reader.js";
import { AutomaticOwnPrInspectionRecovery } from "../src/services/automatic-own-pr-inspection-recovery.js";
import { AutomaticOwnPrConflict } from "../src/services/automatic-own-pr-conflict.js";
import { pullRequestExternalActionBinding } from './support/pull-request-external-action-fixture.js';
import { encodeVerificationRecoveryEvidence } from '../src/domain/verification-recovery-evidence.js';
import { normalizeWorkflowEvent } from '../src/domain/workflow-events.js';
import { createPullRequestExecutionBinding } from '../src/domain/pull-request-execution-binding.js';
import { createConflictCodeExecutionSource } from '../src/domain/code-execution-source.js';
import { createConflictPreparationBinding } from '../src/domain/conflict-preparation-binding.js';
import { createPullRequestWorkSource, appendPullRequestWorkSource, currentWorkItemInputBinding,
  currentWorkItemEvent, verifyPullRequestExecutionBinding } from '../src/services/work-ledger-pr-source.js';

function fixture({ operation = "modify", failureCode = "GIT_SNAPSHOT_TIMEOUT", actions = ["read_text", "search_text", "read_text"],
  inputBinding: suppliedBinding, verifyBinding, conflict = false } = {}) {
  const itemId = "work-item-repair";
  const inputBinding = suppliedBinding ?? {
    schemaVersion: 1, kind: "pull_request", repository: "acme/widgets", pullRequestNumber: 17,
    rootItemId: itemId, workKey: "pr-work-repair", inputRevision: 3, headRevision: 2,
    headRefOid: "1".repeat(40), eventId: "event-repair", eventDigest: "2".repeat(64), inputDigest: "3".repeat(64),
  };
  const grant = createCodeJobGrant({
    schemaVersion: conflict ? 3 : 2, proposalId: "work-intent-repair", contentDigest: "a".repeat(64), policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: itemId },
    source: { assignmentId: "assignment-repair", eventId: inputBinding.eventId },
    subject: { id: "github:pr:acme/widgets#17", repository: "acme/widgets", number: 17 },
    repository: "acme/widgets", workspaceId: "widgets-local", inputBinding,
    ...(conflict ? { executionSource: createConflictCodeExecutionSource({ inputBinding,
      preparationBinding: createConflictPreparationBinding({ gitTarget: inputBinding.gitTarget,
        preparation: { schemaVersion: 1, baseCommitOid: inputBinding.gitTarget.baseRefOid, headCommitOid: inputBinding.headRefOid,
          preparationId: '1'.repeat(64), boundaryDigest: '2'.repeat(64), evidenceDigest: '3'.repeat(64), mergeBaseOid: '4'.repeat(40),
          resultTreeOid: '5'.repeat(40), resultObjectDigest: '6'.repeat(64), status: 'conflicted', materialization: 'full-tree',
          conflicts: [{ path: 'src/app.js', mode: '100644' }] } }) }) } : {}),
    workspaceAuthorityDigest: "9".repeat(64), operation, objective: "Repair the review feedback",
    acceptanceCriteria: ["Cover each outstanding defect"], evidence: ["review-feedback"],
    summary: "Repair feedback", reason: "Requested changes", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[operation]],
    writablePaths: operation === "modify" ? [conflict ? "src/app.js" : "src"] : [], requiredProfiles: [{ id: "tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
  const raw = structuredClone(createQueuedCodeJob({
    confirmationId: "confirmation-repair", requestId: "request-repair-0001", grant,
    displayedPayloadDigest: "d".repeat(64), approvalBindingDigest: "e".repeat(64),
  }, { sequence: 1, revision: 1, createdAt: "2026-08-02T06:00:00.000Z" }));
  raw.status = "failed";
  raw.updatedAt = "2026-08-02T06:01:00.000Z";
  raw.execution.turn = actions.length;
  raw.execution.observations = actions.map((actionType) => ({
    actionType, status: "succeeded", recordedAt: "2026-08-02T06:00:30.000Z",
  }));
  raw.execution.result = { kind: "failed", detail: { code: failureCode, message: "DO-NOT-EXPOSE-RAW-ERROR" }, recordedAt: raw.updatedAt };
  raw.execution.memoryProjection = { memoryRecordId: `memory-${"f".repeat(64)}`, projectedAt: raw.updatedAt };
  const job = projectNormalizedCodeJobForBrowser(raw);
  const decisionContext = {
    source: "proposal", outcome: "failed", observedAt: raw.updatedAt,
    value: { kind: "code_action_proposal", evidence: [`code-job:${job.jobId}`, `memory:${job.memoryProjection.recordId}`] },
  };
  const detail = { job, terminalDetail: raw.execution.result.detail,
    observations: raw.execution.observations, nextCursor: null, historyAvailable: true };
  const retry = { itemId, type: "transitioned", actorId: "owner:local", at: "2026-08-02T06:02:00.000Z",
    details: { toStatus: "queued", reason: "snapshot_timeout_fixed_retry",
      context: { downstreamRef: job.jobId, note: "Fixed-Head snapshot verified; retry original task." } } };
  const page = { items: [retry], nextCursor: null };
  const calls = [];
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail(request) { calls.push(request); return structuredClone(detail); } },
    ledger: { async listTimeline(request) { calls.push(request); return structuredClone(page); },
      ...(verifyBinding ? { verifyPullRequestExecutionBinding: verifyBinding } : {}) },
  });
  return { reader, input: { itemId, inputBinding, decisionContext }, detail, page, retry, calls };
}

test("failed repair context includes the actual failure and matching owner recovery request", async () => {
  const f = fixture();
  const result = await f.reader.read(f.input);
  assert.equal(result.failureCode, "GIT_SNAPSHOT_TIMEOUT");
  assert.equal(result.historyComplete, true);
  assert.equal(result.observedActions.length, 3);
  assert.equal(result.ownerRetry.note, f.retry.details.context.note);
  assert.equal(JSON.stringify(result).includes("DO-NOT-EXPOSE-RAW-ERROR"), false);
  assert.deepEqual(f.calls, [{ jobId: f.detail.job.jobId, limit: 20 }, { itemId: f.input.itemId, limit: 100, order: "newest" }]);
});

function revisedSourceFixture() {
  const target = { schemaVersion: 1, provider: 'github', sourceAccountId: 'runtime-user',
    baseRepository: 'acme/widgets', baseRefName: 'main', baseRefOid: '5'.repeat(40),
    headRepository: 'acme/widgets', headRefName: 'fix/repair', headRefOid: '1'.repeat(40) };
  const envelope = (sequence, gitTarget = target) => {
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.updated',
      occurredAt: `2026-08-02T05:00:0${sequence}.000Z`, source: { provider: 'github', scopeId: 'dashboard' },
      subject: { id: 'github:pr:acme/widgets#17', repository: 'acme/widgets', number: 17 },
      payload: { title: 'Repair feedback', headRefOid: gitTarget.headRefOid, ciStatus: 'FAILURE',
        changedFields: ['ciStatus'], gitTargetAvailable: true, gitTarget } });
    return { sequence, event, assignment: { assignmentId: `assignment-${sequence}`, eventId: event.eventId,
      target: { type: 'role', id: 'pr-engineer' }, reason: 'repair', createdAt: event.occurredAt } };
  };
  const root = { itemId: 'work-item-repair', kind: 'source_root', sourceQuarantine: null,
    source: createPullRequestWorkSource(envelope(1)).source };
  const binding = () => createPullRequestExecutionBinding({ sourceBinding: currentWorkItemInputBinding(root),
    event: currentWorkItemEvent(root) });
  const verified = [];
  const f = fixture({ inputBinding: binding(), verifyBinding: async value => {
    verified.push(structuredClone(value));
    return verifyPullRequestExecutionBinding({ items: [root] }, value);
  } });
  root.source = appendPullRequestWorkSource(root.source, envelope(2), { attemptAtActivation: 0 }).source;
  f.input.inputBinding = structuredClone(binding());
  return { ...f, root, binding, envelope, target, verified };
}

test('failed code diagnostics survive a same-target fact revision verified by the ledger', async () => {
  const f = revisedSourceFixture();
  const before = structuredClone(f.input);
  const result = await f.reader.read(f.input);
  assert.equal(result.jobId, f.detail.job.jobId);
  assert.equal(result.failureCode, 'GIT_SNAPSHOT_TIMEOUT');
  assert.equal(result.observedActions.length, 3);
  assert.deepEqual(f.verified, [f.detail.job.inputBinding, f.input.inputBinding]);
  assert.deepEqual(f.input, before);
});

test('historical diagnostics still reject changed targets, epochs and unregistered source facts', async t => {
  for (const scenario of ['base', 'account', 'head', 'epoch', 'forged-old-event', 'forged-current-event', 'pending', 'quarantine']) {
    await t.test(scenario, async () => {
      const f = revisedSourceFixture();
      if (scenario === 'base') f.input.inputBinding.gitTarget.baseRefOid = '6'.repeat(40);
      if (scenario === 'account') f.input.inputBinding.gitTarget.sourceAccountId = 'another-user';
      if (scenario === 'head') {
        f.input.inputBinding.headRefOid = '6'.repeat(40);
        f.input.inputBinding.gitTarget.headRefOid = f.input.inputBinding.headRefOid;
      }
      if (scenario === 'epoch') f.input.inputBinding.headRevision += 1;
      if (scenario === 'forged-old-event') f.detail.job.inputBinding.eventDigest = '0'.repeat(64);
      if (scenario === 'forged-current-event') f.input.inputBinding.eventDigest = '0'.repeat(64);
      if (scenario === 'pending') f.root.source = appendPullRequestWorkSource(f.root.source,
        f.envelope(3, { ...f.target, baseRefOid: '6'.repeat(40) }), { activate: false, attemptAtActivation: 0 }).source;
      if (scenario === 'quarantine') f.root.sourceQuarantine = { reason: 'unknown_execution' };
      await assert.rejects(f.reader.read(f.input), { code: 'ROLE_CONTEXT_CODE_JOB_STALE' });
    });
  }
});

test('historical source verification respects cancellation and unavailable ledger evidence', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancelled' : 'unavailable', async () => {
    const f = revisedSourceFixture();
    const controller = new AbortController();
    const reader = new FailedCodeJobContextReader({
      codeJobReader: { async getDetail() { return f.detail; } },
      ledger: {
        async listTimeline() { return f.page; },
        async verifyPullRequestExecutionBinding() {
          if (cancel) controller.abort();
          throw Object.assign(new Error('DO-NOT-EXPOSE-LEDGER-ERROR'), { code: 'WORK_LEDGER_RUNTIME_CLOSED' });
        },
      },
    });
    await assert.rejects(reader.read({ ...f.input, signal: controller.signal }),
      cancel ? { name: 'AbortError' } : { code: 'ROLE_CONTEXT_CODE_JOB_UNAVAILABLE' });
  });
});

function automaticRetry(f) {
  f.retry.actorId = "automatic-own-pr-inspection-recovery";
  f.retry.details.reason = "automatic_inspection_objects_ready";
  f.retry.details.context = { downstreamRef: f.detail.job.jobId, code: "GIT_HEAD_UNAVAILABLE" };
}

test('failed conflict context recognizes only the exact zero-action preparation recovery', async t => {
  const binding = revisedSourceFixture().detail.job.inputBinding;
  for (const scenario of ['valid', 'actor', 'reason', 'code', 'job', 'failure', 'action', 'history', 'archived',
    'head', 'preparation', 'extra-evidence', 'not-conflict']) {
    await t.test(scenario, async () => {
      const f = fixture({ operation: 'modify', inputBinding: binding, conflict: scenario !== 'not-conflict',
        failureCode: 'CONTROLLED_GIT_PREFLIGHT_FAILED', actions: scenario === 'action' ? ['write_text'] : [] });
      f.detail.archived = false;
      f.retry.actorId = 'automatic-own-pr-conflict-recovery';
      f.retry.details.reason = 'automatic_conflict_material_recovered';
      f.retry.details.context = { code: 'CONTROLLED_GIT_PREFLIGHT_FAILED', downstreamRef: f.detail.job.jobId,
        evidenceRefs: [`failure:${f.detail.job.jobId}`, `conflict-preparation:${'7'.repeat(64)}`, `head:${binding.headRefOid}`] };
      if (scenario === 'actor') f.retry.actorId = 'other-system';
      if (scenario === 'reason') f.retry.details.reason = 'other-recovery';
      if (scenario === 'code') f.retry.details.context.code = 'OTHER_FAILURE';
      if (scenario === 'job') f.retry.details.context.downstreamRef = 'other-job';
      if (scenario === 'failure') f.detail.terminalDetail.code = 'CODE_BRAIN_RESPONSE_INVALID';
      if (scenario === 'history') f.detail.historyAvailable = false;
      if (scenario === 'archived') f.detail.archived = true;
      if (scenario === 'head') f.retry.details.context.evidenceRefs[2] = `head:${'9'.repeat(40)}`;
      if (scenario === 'preparation') f.retry.details.context.evidenceRefs[1] = 'conflict-preparation:unsealed';
      if (scenario === 'extra-evidence') f.retry.details.context.evidenceRefs.push('note:untrusted');
      const result = await f.reader.read(f.input);
      assert.equal(result.ownerRetry, null);
      assert.deepEqual(result.automaticRecovery, scenario === 'valid' ? { at: f.retry.at, reason: 'automatic_conflict_material_recovered',
        failureCode: 'CONTROLLED_GIT_PREFLIGHT_FAILED', jobId: f.detail.job.jobId, preparationId: '7'.repeat(64), headRefOid: binding.headRefOid } : null);
    });
  }
});

test('verification recovery context requires exact settled readonly failure metadata', async t => {
  for (const scenario of ['valid', 'reordered', 'head', 'action', 'execution', 'profile', 'fingerprint', 'workspace',
    'duplicate', 'missing', 'extra', 'unknown-reference', 'history', 'write', 'failure']) {
    await t.test(scenario, async () => {
      const f = fixture({ operation: 'verify', failureCode: AUTOMATIC_VERIFICATION_FAILURE, actions: ['read_text', 'run_profile'] });
      f.retry.actorId = VERIFICATION_RECOVERY_ACTOR;
      f.retry.details.reason = VERIFICATION_RECOVERY_REASON;
      f.retry.details.context = { downstreamRef: f.detail.job.jobId, code: AUTOMATIC_VERIFICATION_FAILURE,
        evidenceRefs: encodeVerificationRecoveryEvidence({ headRefOid: f.input.inputBinding.headRefOid,
          actionId: 'action-profile', executionId: 'attempt-one', profileId: 'tests',
          profileConfigDigest: 'b'.repeat(64), workspaceRevision: '7'.repeat(64) }) };
      const context = f.retry.details.context;
      const replace = (prefix, value) => { context.evidenceRefs = context.evidenceRefs.map(ref => ref.startsWith(prefix) ? `${prefix}${value}` : ref); };
      if (scenario === 'head') replace('head:', '9'.repeat(40));
      if (scenario === 'action') replace('action:', '../action');
      if (scenario === 'execution') replace('execution:', '../attempt');
      if (scenario === 'profile') replace('profile:', 'other');
      if (scenario === 'fingerprint') replace('profile-config:', 'invalid');
      if (scenario === 'workspace') replace('workspace:', 'invalid');
      if (scenario === 'reordered') context.evidenceRefs.reverse();
      if (scenario === 'duplicate') context.evidenceRefs[1] = context.evidenceRefs[0];
      if (scenario === 'missing') context.evidenceRefs.pop();
      if (scenario === 'extra') context.evidenceRefs.push('note:untrusted');
      if (scenario === 'unknown-reference') context.evidenceRefs[1] = 'note:untrusted';
      if (scenario === 'history') f.detail.historyAvailable = false;
      if (scenario === 'write') f.detail.observations[0].actionType = 'write_text';
      if (scenario === 'failure') f.detail.terminalDetail.code = 'SANDBOX_ABORTED';
      const result = await f.reader.read(f.input);
      assert.equal(result.ownerRetry, null);
      if (['valid', 'reordered'].includes(scenario)) assert.equal(result.automaticRecovery.jobId, f.detail.job.jobId);
      else assert.equal(result.automaticRecovery, null);
    });
  }
});

test("developer context identifies the system recovery of its exact zero-action inspection", async () => {
  const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [] });
  automaticRetry(f);
  const result = await f.reader.read(f.input);
  assert.equal(result.ownerRetry, null);
  assert.deepEqual(result.automaticRecovery, { at: f.retry.at, reason: "automatic_inspection_objects_ready",
    failureCode: "GIT_HEAD_UNAVAILABLE", jobId: f.detail.job.jobId });
});

test("snapshot timeout recovery context preserves its actual failure classification", async () => {
  const f = fixture({ operation: "inspect", failureCode: "GIT_SNAPSHOT_TIMEOUT", actions: [] });
  automaticRetry(f);
  f.retry.details.context.code = "GIT_SNAPSHOT_TIMEOUT";
  assert.equal((await f.reader.read(f.input)).automaticRecovery.failureCode, "GIT_SNAPSHOT_TIMEOUT");
  f.retry.details.context.code = "GIT_HEAD_UNAVAILABLE";
  assert.equal((await f.reader.read(f.input)).automaticRecovery, null);
});

test("automatic recovery context rejects mismatched, incomplete and non-inspection recovery evidence", async (t) => {
  for (const options of [
    { operation: "modify" }, { failureCode: "GIT_SNAPSHOT_PROCESS_FAILED" }, { actions: ["read_text"] },
    { mutate: f => { f.retry.actorId = "other-system"; } },
    { mutate: f => { f.retry.details.reason = "other-recovery"; } },
    { mutate: f => { f.retry.details.context.code = "OTHER_FAILURE"; } },
    { mutate: f => { f.retry.details.context.downstreamRef = "other-job"; } },
    { mutate: f => { f.retry.at = f.input.decisionContext.observedAt; } },
    { mutate: f => { f.detail.historyAvailable = false; } },
  ]) await t.test(JSON.stringify(options), async () => {
    const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [], ...options });
    automaticRetry(f); options.mutate?.(f);
    assert.equal((await f.reader.read(f.input)).automaticRecovery, null);
  });
});

async function recoveryFixture(options = {}) {
  const f = fixture({ operation: "inspect", failureCode: "GIT_HEAD_UNAVAILABLE", actions: [], ...options });
  const state = new Map();
  const calls = [];
  const item = { itemId: f.input.itemId, revision: 5, status: "blocked", statusReason: "proposal_failed",
    currentTarget: { type: "role", id: "developer" }, activeIntentId: null, leaseId: null,
    graph: { deliveries: [] }, decisionContext: structuredClone(f.input.decisionContext) };
  const dependencies = {
    store: { async read(key, fallback) { return structuredClone(state.get(key) ?? fallback); },
      async write(key, value) { state.set(key, structuredClone(value)); } },
    ledger: { async listItems() { return { items: [structuredClone(item)] }; },
      async readItemForReconciliation() { return structuredClone(item); },
      async transition(request) { calls.push(request); item.status = request.toStatus; item.revision += 1; } },
    codeJobReader: { async get() { return f.detail.job; } }, failedContextReader: f.reader,
    current: async () => ({}), objectSync: { async prepare() { calls.push("objects-ready"); } },
  };
  const makeService = async () => { const service = new AutomaticOwnPrInspectionRecovery(dependencies); await service.recover(); return service; };
  return { ...f, item, state, calls, dependencies, makeService, service: await makeService() };
}

test("automatic inspection recovery prepares objects then requeues the same failed task with history intact", async () => {
  const f = await recoveryFixture();
  assert.equal((await f.service.runCycle()).requeued, 1);
  assert.equal(f.calls[0], "objects-ready");
  assert.deepEqual(f.calls[1], { itemId: f.item.itemId, expectedRevision: 5, leaseId: null,
    actorId: "automatic-own-pr-inspection-recovery", toStatus: "queued", reason: "automatic_inspection_objects_ready",
    details: { code: "GIT_HEAD_UNAVAILABLE", downstreamRef: f.detail.job.jobId } });
  assert.deepEqual(f.item.decisionContext, f.input.decisionContext);
  f.item.status = "blocked";
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0, "restart cannot replay a settled recovery");
  assert.equal(f.calls.length, 2);
});

async function ordinaryInspectionRecoveryFixture({ child = false } = {}) {
  const inputBinding = pullRequestExternalActionBinding({ rootItemId: child ? 'work-root' : 'work-item-repair', pullRequestNumber: 17,
    gitTarget: { baseRepository: 'acme/widgets', headRepository: 'acme/widgets', headRefOid: '1'.repeat(40) } });
  const f = await recoveryFixture({ inputBinding });
  const root = child ? { ...structuredClone(f.item), itemId: inputBinding.rootItemId, status: 'waiting_external',
    currentTarget: { type: 'role', id: 'orchestrator' } } : f.item;
  Object.assign(root, { kind: 'source_root', sourceQuarantine: null,
    source: { kind: 'pull_request', identity: { provider: 'github', scopeId: 'github-dashboard' },
      scope: { kind: 'automatic', active: true }, pendingRevision: null,
      current: { event: { eventType: 'pull_request.updated', source: { provider: 'github', scopeId: 'github-dashboard' },
        subject: { repository: 'acme/widgets', number: 17 },
        payload: { relation: 'authored', author: 'runtime-user', nextAction: 'continue_draft' } } } } });
  const config = { trackedRepositories: ['acme/widgets'],
    githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: 'runtime-user' } };
  const context = { inputBinding, author: 'runtime-user' };
  const facts = { state: 'open', isDraft: true, author: 'runtime-user',
    headRefOid: inputBinding.headRefOid, baseRefOid: inputBinding.gitTarget.baseRefOid, mergeStateStatus: 'CLEAN' };
  const dependencies = { ...f.dependencies,
    configurationReader: { async readActive() { return { configuration: structuredClone(config) }; } },
    ledger: { ...f.dependencies.ledger,
      async readItemForReconciliation({ itemId }) { return structuredClone(itemId === root.itemId ? root : f.item); },
      async readPullRequestExecutionContext() { return structuredClone(context); },
      async listTimeline() { return structuredClone(f.page); } },
    github: { async readOwnPullRequestConflict() { return structuredClone(facts); } },
    codeJobReader: { ...f.dependencies.codeJobReader, async getDetail() { return structuredClone(f.detail); } },
    confirmations: { async approve() { assert.fail('inspection recovery cannot approve a task'); } },
  };
  const service = new AutomaticOwnPrConflict(dependencies);
  await service.recover();
  return { ...f, root, config, context, facts, dependencies, service };
}

test('ordinary owned PR inspections recover missing Git objects without requiring a merge conflict', async () => {
  const f = await ordinaryInspectionRecoveryFixture();
  const oldJob = structuredClone(f.detail.job);
  const result = await f.service.runRecoveryCycle();
  assert.equal(result.inspectionRecovery.requeued, 1);
  assert.equal(f.calls[0], 'objects-ready');
  assert.equal(f.calls[1].reason, 'automatic_inspection_objects_ready');
  assert.equal(f.item.status, 'queued');
  assert.deepEqual(f.detail.job, oldJob, 'historical failed execution stays unchanged');
  f.item.status = 'blocked';
  const restarted = new AutomaticOwnPrConflict(f.dependencies);
  await restarted.recover();
  assert.equal((await restarted.runRecoveryCycle()).inspectionRecovery.requeued, 0);
  assert.equal(f.calls.length, 2, 'recovery receipt prevents replay');
});

for (const change of ['disabled', 'other-author', 'changed-head', 'changed-base', 'inactive-source',
  'pending-source', 'quarantined-source', 'paused', 'conflict-no-longer-present']) {
  test(`ordinary inspection recovery preserves ${change} boundary`, async () => {
    const f = await ordinaryInspectionRecoveryFixture();
    if (change === 'disabled') f.config.githubActions.automaticOwnPrRepair = false;
    if (change === 'other-author') f.context.author = f.facts.author = 'another-user';
    if (change === 'changed-head') f.facts.headRefOid = '9'.repeat(40);
    if (change === 'changed-base') f.facts.baseRefOid = '9'.repeat(40);
    if (change === 'inactive-source') f.item.source.scope.active = false;
    if (change === 'pending-source') f.item.source.pendingRevision = { revision: 99 };
    if (change === 'quarantined-source') f.item.sourceQuarantine = { reason: 'unsettled-cutover' };
    if (change === 'paused') f.item.status = 'paused';
    if (change === 'conflict-no-longer-present') f.item.source.current.event.payload.nextAction = 'resolve_conflict';
    assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 0);
    assert.deepEqual(f.calls, []);
  });
}

test('ordinary inspection recovery rechecks the target after synchronizing objects', async () => {
  const f = await ordinaryInspectionRecoveryFixture();
  f.dependencies.objectSync.prepare = async () => { f.calls.push('objects-ready'); f.facts.headRefOid = '9'.repeat(40); };
  assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 0);
  assert.equal(f.item.status, 'blocked');
  assert.deepEqual(f.calls, ['objects-ready']);
});

test('ordinary child inspections recover under an active source root assigned to another role', async () => {
  const f = await ordinaryInspectionRecoveryFixture({ child: true });
  assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 1);
  assert.equal(f.item.status, 'queued');
  assert.equal(f.root.status, 'waiting_external');
});

for (const status of ['paused', 'cancelled', 'completed', 'superseded', 'blocked']) {
  test(`ordinary child inspection recovery respects a ${status} source root`, async () => {
    const f = await ordinaryInspectionRecoveryFixture({ child: true });
    f.root.status = status;
    f.root.statusReason = 'attention_rejected';
    assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 0);
    assert.deepEqual(f.calls, []);
  });
}

for (const code of ["WORK_LEDGER_CURSOR_INVALID", "MEMORY_STORAGE_FAILED"]) {
  test(`automatic inspection recovery handles a retired page cursor only (${code})`, async () => {
    const f = await recoveryFixture();
    const requests = [];
    const failure = Object.assign(new Error("cursor task left blocked work"), { code });
    f.dependencies.ledger.listItems = async request => {
      requests.push(request);
      if (requests.length === 1) return { items: [], nextCursor: "retired-task" };
      if (request.cursor) throw failure;
      return { items: [structuredClone(f.item)], nextCursor: null };
    };
    await f.service.runCycle();
    if (code === "WORK_LEDGER_CURSOR_INVALID") {
      assert.equal((await f.service.runCycle()).requeued, 1);
      assert.equal(requests.length, 3);
      assert.equal(requests[1].cursor, "retired-task");
      assert.equal(Object.hasOwn(requests[2], "cursor"), false);
    } else {
      await assert.rejects(f.service.runCycle(), error => error === failure);
      assert.equal(requests.length, 2);
      assert.deepEqual(f.calls, []);
    }
  });
}

test("zero-action snapshot timeouts share the existing automatic inspection recovery budget", async () => {
  const f = await recoveryFixture({ failureCode: "GIT_SNAPSHOT_TIMEOUT" });
  assert.equal((await f.service.runCycle()).requeued, 1);
  assert.equal(f.calls[1].details.code, "GIT_SNAPSHOT_TIMEOUT");
  f.item.status = "blocked";
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0);
  const exhausted = await recoveryFixture({ failureCode: "GIT_SNAPSHOT_TIMEOUT" });
  exhausted.state.set("automatic-own-pr-inspection-recovery-state", { schemaVersion: 1,
    records: [1, 2, 3].map(attempt => ({ itemId: exhausted.item.itemId, jobId: `code-job-old-${attempt}`,
      inputBinding: exhausted.input.inputBinding, attempt, status: "requeued" })) });
  assert.equal((await (await exhausted.makeService()).runCycle()).requeued, 0);
  assert.deepEqual(exhausted.calls, []);
});

test("automatic inspection recovery preserves failed modifications, observed actions and uncertain context", async (t) => {
  for (const scenario of [
    { operation: "modify" }, { failureCode: "GIT_SNAPSHOT_PROCESS_FAILED" }, { actions: ["read_text"] },
    { change: f => { f.item.leaseId = "active-lease"; } },
    { change: f => { f.item.activeIntentId = "active-intent"; } },
    { change: f => { f.item.graph.deliveries = [{ status: "submitted" }]; } },
    { change: f => { f.item.status = "paused"; } },
    { change: f => { f.detail.historyAvailable = false; } },
    { change: f => { f.dependencies.current = async () => null; } },
    { change: f => { f.dependencies.objectSync.prepare = async () => { throw Object.assign(new Error(), { code: "OBJECTS_NOT_READY" }); }; } },
  ]) await t.test(JSON.stringify(scenario), async () => {
    const f = await recoveryFixture(scenario);
    scenario.change?.(f);
    f.service = await f.makeService();
    assert.equal((await f.service.runCycle()).requeued, 0);
    assert.equal(f.item.status === "queued", false);
    assert.equal(f.calls.some(value => typeof value === "object"), false);
  });
});

test("automatic inspection recovery retains its durable three-attempt budget", async () => {
  const f = await recoveryFixture();
  f.state.set("automatic-own-pr-inspection-recovery-state", { schemaVersion: 1,
    records: [1, 2, 3].map(attempt => ({ itemId: f.item.itemId, jobId: `code-job-old-${attempt}`,
      inputBinding: f.input.inputBinding, attempt, status: "requeued" })) });
  assert.equal((await (await f.makeService()).runCycle()).requeued, 0);
  assert.deepEqual(f.calls, []);
});

test("inspection recovery rechecks the target and task after synchronization", async (t) => {
  for (const change of [
    f => { f.dependencies.current = async () => null; },
    f => { f.item.revision += 1; },
    f => { f.item.leaseId = "new-lease"; },
  ]) await t.test(change.toString(), async () => {
    const f = await recoveryFixture();
    f.dependencies.objectSync.prepare = async () => { change(f); };
    // Resolve the latest authority on each check, as the production callback does.
    const original = f.dependencies.current;
    f.dependencies.current = async (...args) => original(...args);
    const current = (...args) => f.dependencies.current(...args);
    f.service = new AutomaticOwnPrInspectionRecovery({ ...f.dependencies, current });
    await f.service.recover();
    assert.equal((await f.service.runCycle()).requeued, 0);
    assert.equal(f.item.status, "blocked");
  });
});

test("inspection recovery resumes a prepared transition after restart without consuming another attempt", async () => {
  const f = await recoveryFixture();
  const transition = f.dependencies.ledger.transition;
  f.dependencies.ledger.transition = async () => { throw Object.assign(new Error(), { code: "WORK_LEDGER_REVISION_MISMATCH" }); };
  assert.equal((await f.service.runCycle()).requeued, 0);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records[0].attempt, 1);
  f.dependencies.ledger.transition = transition;
  assert.equal((await (await f.makeService()).runCycle()).requeued, 1);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records.length, 1);
  assert.equal(f.state.get("automatic-own-pr-inspection-recovery-state").records[0].attempt, 1);
});

test("a failed repair context rejects another job, Head, authority epoch or memory receipt", async (t) => {
  const mutations = [
    (f) => { f.input.inputBinding.headRefOid = "4".repeat(40); },
    (f) => { f.input.inputBinding.headRevision += 1; },
    (f) => { f.input.inputBinding.inputRevision += 1; },
    (f) => { f.input.itemId = "other-item"; },
    (f) => { f.input.decisionContext.value.evidence[1] = `memory:memory-${"0".repeat(64)}`; },
    (f) => { f.input.decisionContext.value.evidence.push(f.input.decisionContext.value.evidence[0]); },
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(String(index), async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.reader.read(f.input), { code: "ROLE_CONTEXT_CODE_JOB_STALE" });
  });
});

test("unrelated, stale or non-owner transitions do not become retry evidence", async (t) => {
  for (const mutate of [
    (entry) => { entry.itemId = "other-item"; },
    (entry) => { entry.actorId = "developer"; },
    (entry) => { entry.at = "2026-08-02T06:00:00.000Z"; },
    (entry) => { entry.details.context.downstreamRef = "other-job"; },
    (entry) => { entry.details.toStatus = "blocked"; },
  ]) await t.test(mutate.toString(), async () => {
    const f = fixture(); mutate(f.retry);
    assert.equal((await f.reader.read(f.input)).ownerRetry, null);
  });
});

test("partial history and invalid error text never imply a clean completed execution", async () => {
  const f = fixture();
  f.detail.observations.pop();
  f.detail.nextCursor = { offset: 2 };
  f.detail.terminalDetail.code = "unexpected secret-bearing provider text";
  f.retry.details.context.note = "x".repeat(1025);
  const result = await f.reader.read(f.input);
  assert.equal(result.historyComplete, false);
  assert.equal(result.observationCount, 3);
  assert.equal(result.failureCode, null);
  assert.equal(result.ownerRetry.note, null);
  assert.equal(result.status, "failed");
});

test("retry lookup follows task-local pages and stops at the failure boundary", async () => {
  const f = fixture();
  const requests = [];
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail() { return f.detail; } },
    ledger: { async listTimeline(request) {
      requests.push(request);
      return request.cursor === undefined
        ? { items: [{ itemId: f.input.itemId, type: "claimed", at: "2026-08-02T06:03:00.000Z" }], nextCursor: "older-events" }
        : f.page;
    } },
  });
  assert.equal((await reader.read(f.input)).ownerRetry.note, f.retry.details.context.note);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, "older-events");
  requests.length = 0;
  f.input.decisionContext.observedAt = "2026-08-02T06:04:00.000Z";
  assert.equal((await reader.read(f.input)).ownerRetry, null);
  assert.equal(requests.length, 1);
});

test("caller cancellation stops further retry-history reads", async () => {
  const f = fixture();
  const controller = new AbortController();
  let calls = 0;
  const reader = new FailedCodeJobContextReader({
    codeJobReader: { async getDetail() { return f.detail; } },
    ledger: { async listTimeline() { calls += 1; controller.abort(); return f.page; } },
  });
  await assert.rejects(reader.read({ ...f.input, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("ordinary outcomes and a failure before job creation need no execution read", async () => {
  const f = fixture();
  f.input.decisionContext.outcome = "succeeded";
  assert.equal(await f.reader.read(f.input), null);
  f.input.decisionContext.outcome = "failed";
  f.input.decisionContext.value.evidence = ["confirmation:failed-before-job"];
  assert.equal(await f.reader.read(f.input), null);
  assert.equal(f.calls.length, 0);
});

test("failed context readers reject accessor ports without invoking them", () => {
  let calls = 0;
  const port = {};
  Object.defineProperty(port, "getDetail", { get() { calls += 1; return async () => {}; } });
  assert.throws(() => new FailedCodeJobContextReader({ codeJobReader: port, ledger: {} }), TypeError);
  const ledger = { async listTimeline() {} };
  Object.defineProperty(ledger, 'verifyPullRequestExecutionBinding', { get() { calls += 1; return async () => {}; } });
  assert.throws(() => new FailedCodeJobContextReader({ codeJobReader: { async getDetail() {} }, ledger }), TypeError);
  assert.equal(calls, 0);
});

// Docker availability recovery is distinct from zero-action Git preparation.
async function environmentRecoveryFixture() {
  const f = await ordinaryInspectionRecoveryFixture();
  Object.assign(f.detail.job, { turn: 1, observationCount: 1,
    latestObservation: { actionType: 'run_profile', status: 'failed', recordedAt: f.input.decisionContext.observedAt } });
  f.detail.observations = [{ actionType: 'run_profile', status: 'failed', recordedAt: f.input.decisionContext.observedAt }];
  f.detail.terminalDetail.code = AUTOMATIC_VERIFICATION_FAILURE;
  const proof = { schemaVersion: 1, reason: 'docker_prestart_environment_restored', jobId: f.detail.job.jobId,
    grantDigest: f.detail.job.grantDigest, inputBinding: f.detail.job.inputBinding,
    headRefOid: f.detail.job.inputBinding.headRefOid, actionId: 'action-profile', executionId: 'execution-profile',
    profileId: 'tests', profileConfigDigest: 'b'.repeat(64), workspaceRevision: '7'.repeat(64), imageId: `sha256:${'c'.repeat(64)}` };
  let proofReads = 0, readProof = async () => structuredClone(proof);
  f.dependencies.inspectionEnvironmentReader = { async read() { proofReads += 1; return readProof(); } };
  f.service = new AutomaticOwnPrConflict(f.dependencies);
  await f.service.recover();
  return { ...f, proof, proofReads: () => proofReads, setReadProof(fn) { readProof = fn; } };
}

test('restored Docker requeues the same owned draft inspection once with effective-change evidence and unchanged old job', async () => {
  const f = await environmentRecoveryFixture(), before = structuredClone(f.detail);
  assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 1);
  const transition = f.calls.find(call => typeof call === 'object');
  assert.equal(transition.reason, 'automatic_inspection_environment_restored');
  assert.equal(transition.details.evidenceRefs.at(-1), `docker-image:${f.proof.imageId}`);
  assert.equal(f.proofReads(), 2, 'readiness is freshly checked before requeue');
  assert.deepEqual(f.detail, before);
  f.page.items.unshift({ itemId: f.item.itemId, type: 'transitioned', actorId: transition.actorId,
    at: '2026-08-02T06:03:00.000Z', details: { toStatus: 'queued', reason: transition.reason, context: transition.details } });
  const context = await f.reader.read(f.input);
  assert.equal(context.automaticRecovery.reason, transition.reason);
  assert.equal(context.automaticRecovery.imageId, f.proof.imageId);
  assert.equal(context.ownerRetry, null);
  f.item.status = 'blocked';
  f.detail.job.inputBinding = { ...f.detail.job.inputBinding, inputRevision: f.detail.job.inputBinding.inputRevision + 1 };
  f.context.inputBinding = f.detail.job.inputBinding;
  const restarted = new AutomaticOwnPrConflict(f.dependencies); await restarted.recover();
  assert.equal((await restarted.runRecoveryCycle()).inspectionRecovery.requeued, 0);
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1, 'fact revisions cannot replenish the Head budget');
});

for (const [scenario, change] of [
  ['no-effective-change', f => f.setReadProof(async () => null)],
  ['retired-root', f => { f.item.statusReason = 'pr_source_cross_root_cutover_retired'; }],
  ['readiness-lost', f => f.setReadProof(async () => f.proofReads() === 1 ? structuredClone(f.proof) : null)],
  ['changed-Head', f => { f.dependencies.objectSync.prepare = async () => { f.facts.headRefOid = '9'.repeat(40); }; }],
  ['revision-race', f => { f.dependencies.objectSync.prepare = async () => { f.item.revision += 1; }; }],
]) test(`Docker inspection recovery retains ${scenario} boundary`, async () => {
  const f = await environmentRecoveryFixture(); change(f);
  assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 0);
  assert.equal(f.item.status, 'blocked');
  assert.equal(f.calls.some(call => typeof call === 'object'), false);
});

test('prepared Docker recovery resumes the same receipt after restart, separately from the Git preparation budget', async () => {
  const f = await environmentRecoveryFixture(), key = 'automatic-own-pr-inspection-recovery-state';
  f.state.set(key, { schemaVersion: 1, records: [1, 2, 3].map(attempt => ({
    itemId: f.item.itemId, jobId: `code-job-git-${attempt}`, inputBinding: f.input.inputBinding, attempt, status: 'requeued' })) });
  const transition = f.dependencies.ledger.transition;
  f.dependencies.ledger.transition = async () => { throw Object.assign(new Error('revision race'), { code: 'WORK_LEDGER_REVISION_MISMATCH' }); };
  f.service = new AutomaticOwnPrConflict(f.dependencies); await f.service.recover();
  assert.equal((await f.service.runRecoveryCycle()).inspectionRecovery.requeued, 0);
  assert.equal(f.state.get(key).records.length, 4);
  assert.equal(f.state.get(key).records.at(-1).status, 'prepared');
  f.dependencies.ledger.transition = transition;
  const restarted = new AutomaticOwnPrConflict(f.dependencies); await restarted.recover();
  assert.equal((await restarted.runRecoveryCycle()).inspectionRecovery.requeued, 1);
  assert.equal(f.state.get(key).records.length, 4);
  assert.equal(f.state.get(key).records.at(-1).status, 'requeued');
});
