import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticOwnPrRepair } from "../src/services/automatic-own-pr-repair.js";
import { ciRepairSource } from './support/ci-repair-fixture.js';
import { readonlyVerificationFixture } from './support/readonly-verification-fixture.js';
import { FailedCodeJobContextReader, VERIFICATION_RECOVERY_ACTOR, VERIFICATION_RECOVERY_REASON } from '../src/services/failed-code-job-context-reader.js';
import { AutomaticOwnPrVerificationRecovery } from '../src/services/automatic-own-pr-verification-recovery.js';
import { planWorkItemTransition } from '../src/services/work-ledger-item-commands.js';
import { encodeVerificationRecoveryEvidence } from '../src/domain/verification-recovery-evidence.js';

const binding = {
  schemaVersion: 2, kind: "pull_request", repository: "acme/repo", pullRequestNumber: 42,
  rootItemId: "work-42", workKey: "pull-request-acme-repo-42", inputRevision: 1,
  headRevision: 1, headRefOid: "1".repeat(40), eventId: "event-42",
  eventDigest: "d".repeat(64), inputDigest: "e".repeat(64),
  gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "me",
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "2".repeat(40),
    headRepository: "acme/repo", headRefName: "fix/review", headRefOid: "1".repeat(40) },
};

function setup({ objectSync = null, ciRepairContextReader = null, codeJobReader = null,
  settledVerificationReader = null, ledgerOverrides = {} } = {}) {
  const configuration = {
    githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: "me" },
    trackedRepositories: ["acme/repo"],
    workCoordination: { policy: { workspaceByRepository: { "acme/repo": "repo" } } },
    codeExecutor: { workspaces: [{ id: "repo", gitHeadSnapshot: true, writablePaths: ["src", "test"] }] },
  };
  const event = { eventType: "pull_request.updated", subject: { repository: "acme/repo", number: 42 }, payload: {
    relation: "authored", author: "me", state: "open", nextAction: "address_review",
    reviewFeedbackDigest: "f".repeat(64), reviewFeedbackAvailable: true,
  } };
  const facts = { state: "open", author: "me", headRefOid: binding.headRefOid,
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: "f".repeat(64) };
  const saved = new Map();
  const calls = [];
  const service = new AutomaticOwnPrRepair({
    configurationReader: { readActive: async () => ({ configuration }) },
    store: { read: async (key, fallback) => structuredClone(saved.get(key) ?? fallback),
      write: async (key, value) => { saved.set(key, structuredClone(value)); } },
    ledger: { readPullRequestExecutionContext: async () => ({ inputBinding: binding, author: "me" }),
      readItemForReconciliation: async () => ({ event }), ...ledgerOverrides },
    github: { readOwnPullRequestFeedback: async () => structuredClone(facts),
      readPullRequestLocalWorkFacts: async () => structuredClone({ baseRefOid: binding.gitTarget.baseRefOid, isDraft: false, ...facts }) },
    objectSync,
    ciRepairContextReader,
    codeJobReader,
    settledVerificationReader,
    grantVerifier: { async verify(grant) { return grant; } },
    confirmations: { approve: async (id, request) => { calls.push({ id, request }); return { ...item(), status: "completed" }; } },
  });
  function item() {
    return { id: "confirmation-code-42", kind: "local.code-job-create", status: "pending",
      queueRevision: 3, itemRevision: 1, approvalBindingDigest: "a".repeat(64), displayedPayloadDigest: "b".repeat(64),
      requestedBy: { roleId: "developer", workItemId: "work-42" },
      display: { payload: { action: { type: "create_code_job", grant: {
        inputBinding: binding, operation: "inspect", requestedBy: { roleId: "developer" },
      } } } },
    };
  }
  return { service, configuration, facts, event, calls, item, saved };
}

function verificationRecoveryFixture() {
  const { raw, job, detail } = readonlyVerificationFixture({ binding });
  let row;
  const transitions = [], timeline = [];
  const proof = { schemaVersion: 1, jobId: job.jobId, grantDigest: job.grantDigest, inputBinding: structuredClone(binding),
    actionId: 'action-verify-profile', executionId: 'attempt-verify', profileId: 'tests',
    profileConfigDigest: 'b'.repeat(64), workspaceRevision: raw.execution.workspaceRevision,
    reason: 'preparation_interrupted_cleanup_confirmed' };
  const boxes = [{ itemId: binding.rootItemId, sourceBinding: binding, status: 'delivered',
    intent: { type: 'propose_code_action' }, outcome: { status: 'delivered', details: { downstreamRef: job.proposalId,
      resultAttestation: { kind: 'proposal_result', payload: { proposalId: job.proposalId, outcome: 'failed' } } } } }];
  const objectSync = { async prepare() {} };
  const codeJobReader = { async get() { return structuredClone(job); }, async getDetail() { return structuredClone(detail); } };
  const settledVerificationReader = { async read({ jobId }) { assert.equal(jobId, job.jobId); return structuredClone(proof); } };
  const s = setup({ objectSync, codeJobReader, settledVerificationReader,
    ledgerOverrides: { async listItems() { return { items: row.status === 'blocked' ? [structuredClone(row)] : [], nextCursor: null }; },
      async listTimeline() { return { items: structuredClone(timeline), nextCursor: null }; },
      async listOutbox() { return { items: structuredClone(boxes), nextCursor: null }; },
      async readItemForReconciliation() { return structuredClone(row); },
      async transition(request) {
        const planned = planWorkItemTransition({ state: { items: [row] }, input: request, clock: () => '2026-08-02T06:02:00.000Z' });
        transitions.push(request); Object.assign(row, planned.result);
        timeline.push({ ...planned.timelineEvents[0], sequence: timeline.length + 1 });
      } } });
  row = { itemId: binding.rootItemId, kind: 'source_root', status: 'blocked', statusReason: 'proposal_failed', revision: 4,
    currentTarget: { type: 'role', id: 'developer' }, ownerId: null, leaseId: null, leaseUntil: null, activeIntentId: null,
    sourceQuarantine: null, graph: { deliveries: [] }, event: s.event, createdAt: raw.createdAt,
    source: { kind: 'pull_request', scope: { kind: 'automatic', active: true }, workKey: binding.workKey,
      activeRevision: 1, revisions: [{ ...binding, revision: 1 }],
      current: { event: s.event, headRefOid: binding.headRefOid, eventId: binding.eventId,
        eventDigest: binding.eventDigest, inputDigest: binding.inputDigest } },
    decisionContext: { source: 'proposal', outcome: 'failed', referenceId: job.proposalId, observedAt: raw.updatedAt,
      value: { kind: 'code_action_proposal', evidence: [`code-job:${job.jobId}`, `memory:${job.memoryProjection.recordId}`] } } };
  timeline.push({ itemId: row.itemId, sequence: 1, type: 'pr_source_created', at: row.createdAt,
    details: { workKey: binding.workKey, headRefOid: binding.headRefOid, inputRevision: 1 } });
  return { s, row, raw, job, detail, proof, boxes, transitions, timeline, objectSync, codeJobReader, settledVerificationReader };
}

test('conflict queue timeout recovery delegates only to its dedicated current conflict record', async () => {
  const f = setup(); let current = true, calls = 0;
  f.service.conflictRepair = { async canReplanUnstartedWrite(job) { calls++; assert.equal(job.jobId, 'queued-conflict'); return current; } };
  const job = { jobId: 'queued-conflict', status: 'paused', grant: { executionSource: { kind: 'conflict_preparation' } },
    execution: { pendingAction: null, actionAdmission: null, uncertainty: null,
      pause: { from: 'active', reason: '等待人工处理（STRUCTURED_PROVIDER_QUEUE_TIMEOUT）' } } };
  assert.equal(await f.service.canRecoverPausedCodeJob(job), true);
  assert.equal(calls, 1);
  current = false;
  assert.equal(await f.service.canRecoverPausedCodeJob(job), false);
  job.execution.pause.reason = '等待人工处理（STRUCTURED_PROVIDER_RESPONSE_INVALID）';
  assert.equal(await f.service.canRecoverPausedCodeJob(job), false);
  assert.equal(calls, 3, 'protocol recovery must also check the current conflict record');
  current = true;
  assert.equal(await f.service.canRecoverPausedCodeJob(job), true);
});

test('disabled inline recovery leaves the dedicated recovery continuation responsible', async () => {
  const f = verificationRecoveryFixture();
  let evidenceReads = 0;
  f.settledVerificationReader.read = async () => { evidenceReads += 1; return structuredClone(f.proof); };
  await f.s.service.recover();
  assert.equal((await f.s.service.runCycle({ includeRecovery: false })).verificationRecovery, undefined);
  assert.equal(evidenceReads, 0);
  assert.equal(f.transitions.length, 0);
  assert.equal((await f.s.service.runRecoveryCycle()).verificationRecovery.requeued, 1);
  assert.equal(f.transitions.length, 1);
});

test('settled readonly verification failure gets one fresh automatic decision without replaying the failed job', async () => {
  const { s, row, job, transitions, timeline, objectSync, codeJobReader, settledVerificationReader } = verificationRecoveryFixture();
  const before = structuredClone(job);
  await s.service.recover();
  const result = await s.service.runCycle();
  assert.equal(result.verificationRecovery?.requeued ?? 0, 1, JSON.stringify(result));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].toStatus, 'queued');
  assert.deepEqual(Object.keys(transitions[0].details), ['code', 'downstreamRef', 'evidenceRefs']);
  assert.equal(row.statusReason, VERIFICATION_RECOVERY_REASON);
  assert.equal(timeline.at(-1).details.context.evidenceRefs.length, 6);
  assert.deepEqual(job, before, 'recovery cannot rewrite the failed job or claim its tests passed');
  assert.equal(s.calls.length, 0, 'recovery cannot approve or replay the old task');
  const contextReader = new FailedCodeJobContextReader({ codeJobReader, ledger: s.service.ledger });
  const context = await contextReader.read({ itemId: row.itemId, inputBinding: binding, decisionContext: row.decisionContext });
  assert.equal(context.automaticRecovery.reason, VERIFICATION_RECOVERY_REASON);
  assert.equal(context.ownerRetry, null);
  row.status = 'blocked';
  row.statusReason = 'proposal_failed';
  const restarted = new AutomaticOwnPrVerificationRecovery({ ledger: s.service.ledger, codeJobReader,
    settledVerificationReader, objectSync, current: async () => ({ config: s.configuration }) });
  await restarted.runCycle();
  assert.equal(transitions.length, 1, 'the same Head cannot receive an unbounded recovery loop');
  assert.equal(timeline.filter(entry => entry.actorId === VERIFICATION_RECOVERY_ACTOR).length, 1);
});

for (const [scenario, mutate] of [
  ['paused', f => { f.row.status = 'paused'; }],
  ['owner-held', f => { f.row.ownerId = 'owner:local'; }],
  ['active-intent', f => { f.row.activeIntentId = 'another-intent'; }],
  ['delivered-work', f => { f.row.graph.deliveries.push({}); }],
  ['quarantine', f => { f.row.sourceQuarantine = {}; }],
  ['scope-left', f => { f.row.source.scope.active = false; }],
  ['disabled', f => { f.s.configuration.githubActions.automaticOwnPrRepair = false; }],
  ['changed-Head', f => { f.s.facts.headRefOid = '9'.repeat(40); }],
  ['changed-Base', f => { f.s.facts.baseRefOid = '9'.repeat(40); }],
  ['changed-account', f => { f.s.configuration.githubActions.actorAccountId = 'other'; }],
  ['changed-source-binding', f => { f.row.source.current.inputDigest = '9'.repeat(64); }],
  ['modification-job', f => { f.job.operation = 'modify'; }],
  ['write-history', f => { f.detail.observations[0].actionType = 'write_text'; }],
  ['incomplete-history', f => { f.detail.historyAvailable = false; }],
  ['other-failure', f => { f.detail.terminalDetail.code = 'CODE_EXECUTION_UNSETTLED'; }],
  ['missing-creation', f => { f.timeline.shift(); }],
  ['pending-effect', f => { f.boxes[0].status = 'dispatching'; }],
  ['unknown-effect', f => { f.boxes[0].outcome.details.resultAttestation.payload.outcome = 'unknown'; }],
  ['rejected-effect', f => { f.boxes[0].outcome.details.resultAttestation.payload.outcome = 'rejected'; }],
  ['missing-attestation', f => { delete f.boxes[0].outcome.details.resultAttestation; }],
  ['settlement-unavailable', f => { f.settledVerificationReader.read = async () => null; }],
  ['wrong-proof-grant', f => { f.proof.grantDigest = '9'.repeat(64); }],
  ['wrong-proof-binding', f => { f.proof.inputBinding.rootItemId = 'different-root'; }],
  ['invalid-profile-proof', f => { f.proof.profileConfigDigest = 'invalid'; }],
  ['pause-during-sync', f => { f.objectSync.prepare = async () => { f.row.status = 'paused'; }; }],
  ['revision-during-sync', f => { f.objectSync.prepare = async () => { f.row.revision += 1; }; }],
  ['Base-during-sync', f => { f.objectSync.prepare = async () => { f.s.facts.baseRefOid = '9'.repeat(40); }; }],
  ['unknown-during-sync', f => { f.objectSync.prepare = async () => { f.boxes[0].outcome.details.resultAttestation.payload.outcome = 'unknown'; }; }],
  ['proof-during-sync', f => { f.objectSync.prepare = async () => { f.proof.profileConfigDigest = '9'.repeat(64); }; }],
  ['prior-recovery-other-job', f => { f.timeline.push({ itemId: f.row.itemId, sequence: 2, type: 'transitioned',
    actorId: VERIFICATION_RECOVERY_ACTOR, details: { reason: VERIFICATION_RECOVERY_REASON,
      context: { evidenceRefs: encodeVerificationRecoveryEvidence({ ...f.proof, headRefOid: binding.headRefOid }), downstreamRef: 'different-job' } } }); }],
  ['malformed-recovery-marker', f => { f.timeline.push({ itemId: f.row.itemId, sequence: 2, type: 'transitioned',
    actorId: VERIFICATION_RECOVERY_ACTOR, details: { reason: VERIFICATION_RECOVERY_REASON, context: {} } }); }],
]) {
  test(`settled verification recovery preserves ${scenario}`, async () => {
    const f = verificationRecoveryFixture(); mutate(f);
    const before = structuredClone(f.job);
    await f.s.service.recover(); await f.s.service.runCycle();
    assert.equal(f.transitions.length, 0);
    assert.deepEqual(f.job, before);
  });
}

test("own review feedback prepares configured Head source and automatically starts its code task", async () => {
  const s = setup();
  await s.service.recover();
  const source = await s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: "propose_code_action", operation: "modify" }, roleId: "developer" });
  assert.equal(source.kind, "review_repair");
  assert.deepEqual(source.writeScope.paths, ["src", "test"]);
  assert.equal((await s.service.approveCodeJob(s.item())).status, "completed");
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].request.requestId, /^auto-own-pr-repair-v1-/);
});

test('owned fix_ci prepares explicit controlled CI provenance instead of an ordinary unpublishable modify', async () => {
  const source = ciRepairSource(binding, ['src', 'test']); let reads = 0;
  const s = setup({ ciRepairContextReader: { async read({ inputBinding, event }) {
    reads++; assert.deepEqual(inputBinding, binding); assert.equal(event.payload.nextAction, 'fix_ci');
    return { facts: { state: 'open', author: 'me', headRefOid: binding.headRefOid, baseRefOid: binding.gitTarget.baseRefOid }, ciEvidence: source.ciEvidence };
  } } });
  s.event.payload.nextAction = 'fix_ci';
  await s.service.recover();
  const prepared = await s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
  assert.deepEqual(prepared, source);
  assert.equal(reads, 1);
});

test('missing automatic CI provenance retries instead of falling back to an ordinary modify job', async () => {
  const s = setup({ ciRepairContextReader: { async read() { return null; } } }); s.event.payload.nextAction = 'fix_ci';
  await s.service.recover();
  await assert.rejects(s.service.prepare({ item: { event: s.event }, inputBinding: binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' }), { code: 'OWN_PR_CI_SOURCE_NOT_READY' });
});

test("disabled, someone else's PR, no feedback, changed Head or different role cannot auto execute", async () => {
  for (const mutate of [
    (s) => { s.configuration.githubActions.automaticOwnPrRepair = false; },
    (s) => { s.facts.author = "other"; },
    (s) => { s.facts.reviewFeedbackCount = 0; },
    (s) => { s.facts.headRefOid = "9".repeat(40); },
    (s) => { s.event.payload.reviewFeedbackDigest = "9".repeat(64); },
  ]) {
    const s = setup(); await s.service.recover(); mutate(s);
    const result = await s.service.approveCodeJob(s.item());
    assert.equal(result.status, "pending"); assert.equal(s.calls.length, 0);
  }
  const s = setup(); await s.service.recover();
  const item = s.item(); item.requestedBy.roleId = "tester";
  assert.equal((await s.service.approveCodeJob(item)).status, "pending");
  assert.equal(s.calls.length, 0);
});

test("the same feedback is not repaired again after a successful push, including after restart", async () => {
  const s = setup(); await s.service.recover();
  await s.service.recordPublished({ repository: "acme/repo", number: 42,
    feedbackDigest: s.facts.reviewFeedbackDigest, commitOid: "3".repeat(40), confirmationId: "push-42" });
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  await s.service.recover();
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.event.payload.reviewFeedbackDigest = "7".repeat(64);
  s.facts.reviewFeedbackDigest = s.event.payload.reviewFeedbackDigest;
  assert.equal(await s.service.shouldRun({ event: s.event }), true);
});

test("resolving some previously repaired feedback does not repair the remaining old comments again", async () => {
  const s = setup(); await s.service.recover();
  await s.service.recordPublished({ repository: "acme/repo", number: 42,
    feedbackDigest: s.facts.reviewFeedbackDigest, feedbackFingerprints: ["1".repeat(64), "2".repeat(64)],
    commitOid: "3".repeat(40), confirmationId: "push-42" });
  s.event.payload.reviewFeedbackDigest = "7".repeat(64);
  s.facts.reviewFeedbackDigest = s.event.payload.reviewFeedbackDigest;
  s.facts.reviewFeedbackFingerprints = ["2".repeat(64)];
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.facts.reviewFeedbackFingerprints = ["4".repeat(64)];
  assert.equal(await s.service.shouldRun({ event: s.event }), true, "edited or new feedback is eligible");
});

test("automatic code approval prepares current Head objects then checks live authority again", async () => {
  let s;
  let prepared = 0;
  s = setup({ objectSync: { async prepare({ inputBinding }) {
    assert.deepEqual(inputBinding, binding);
    prepared += 1;
    s.facts.headRefOid = "9".repeat(40);
  } } });
  await s.service.recover();
  assert.equal((await s.service.approveCodeJob(s.item())).status, "pending");
  assert.equal(prepared, 1);
  assert.equal(s.calls.length, 0, "new remote Head during fetch cannot approve the obsolete task");
});

test("waiting repair tasks do not starve later tasks in bounded cycles", async () => {
  const visited = [];
  const repairs = [1, 2, 3].map((id) => ({ jobId: `job-${id}`, confirmationId: `confirmation-${id}`,
    inputBinding: binding, feedbackDigest: "f".repeat(64), status: "working", pushConfirmationId: null }));
  const service = new AutomaticOwnPrRepair({
    store: { async read() { return { schemaVersion: 1, repairs, published: [] }; } },
    confirmations: { async get() { return { status: "failed", failure: { outcome: "unknown" } }; } },
    codeJobReader: { async getDetail({ jobId }) { visited.push(jobId); return null; } },
    controlledCommitReader: {},
    grantVerifier: { async verify(grant) { return grant; } },
  });
  await service.recover();
  for (let cycle = 0; cycle < 3; cycle += 1) await service.runCycle({ limit: 1 });
  assert.deepEqual(visited, ["job-1", "job-2", "job-3"]);
});

test("new feedback cannot start a competing repair while the same PR push is unresolved", async () => {
  const s = setup();
  s.saved.set("automatic-own-pr-repair-state", { schemaVersion: 1, published: [], repairs: [{
    jobId: "previous-job", confirmationId: "previous-code", inputBinding: binding,
    feedbackDigest: "8".repeat(64), status: "pushing", pushConfirmationId: "previous-push",
  }] });
  await s.service.recover();
  assert.equal(await s.service.shouldRun({ event: s.event }), false);
  s.event.subject.number = 43;
  assert.equal(await s.service.shouldRun({ event: s.event }), true, "unrelated PRs remain independent");
});
