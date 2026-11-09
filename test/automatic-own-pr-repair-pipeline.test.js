import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createPrTriageWorkRequest, createOwnerPullRequestEvent } from "../src/domain/owner-work-request.js";
import { OrchestratorService } from "../src/services/orchestrator-service.js";
import { CiRepairContextReader } from "../src/services/ci-repair-context-reader.js";
import { createPullRequestReadFacts, createPullRequestReadIdentity } from "../src/domain/pull-request-read-facts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ciRepairSource } from './support/ci-repair-fixture.js';
import { createCiRepairEvidence } from '../src/domain/ci-repair-evidence.js';

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { CODE_JOB_ACTIONS_BY_OPERATION, codeJobIdForGrant, createCodeJobGrant } from "../src/domain/code-job-contract.js";
import { createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { createControlledCommitEvidence, createControlledCommitMessage } from "../src/domain/controlled-commit-evidence.js";
import { createChangePackageControlledCommitReceipt } from "../src/domain/change-package-controlled-commit.js";
import { createPullRequestExternalActionConfirmationPlan } from "../src/domain/pull-request-external-action.js";
import { normalizeBoundWorkProposal, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { createWorkDecisionContext } from "../src/services/work-ledger-state.js";
import { createProposalResultAttestation } from "../src/services/work-ledger-result-attestation.js";
import { createWorkIntentDispatchBinding } from "../src/domain/work-intent-dispatch-binding.js";
import { AutomaticOwnPrRepair } from "../src/services/automatic-own-pr-repair.js";
import { AutomaticOwnPrConflict } from "../src/services/automatic-own-pr-conflict.js";
import { HistoricalControlledCommitReader } from "../src/services/historical-controlled-commit-reader.js";
import { CodeActionProposalHandler } from "../src/services/code-action-proposal-handler.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { OwnerWorkRequestService } from "../src/services/owner-work-request-service.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { StateStore } from "../src/lib/state-store.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { internalReviewEvidence } from "../src/domain/internal-repair-review.js";
import { ownReviewFeedbackDigest } from "../src/adapters/github-own-review-feedback.js";
import { OriginalRepairFeedbackReader } from "../src/services/original-repair-feedback-reader.js";
import { createOriginalRepairFeedbackSnapshot, createOriginalRepairFeedbackArchiveRecord,
  originalRepairFeedbackArchiveKey, originalRepairFeedbackArchiveReference } from "../src/domain/original-repair-feedback.js";
import { currentWorkItemExecutionBinding, currentWorkItemInputBinding } from "../src/services/work-ledger-pr-source.js";
import { pullRequestExternalActionBinding, externalActionControlledCommit } from "./support/pull-request-external-action-fixture.js";

const CREATED_AT = "2026-10-10T03:00:00.000Z";
const ORIGINAL_FEEDBACK = { changeRequests: [{ id: "review-123", author: "reviewer", body: "Fix the reviewed race",
  submittedAt: "2026-10-10T01:00:00Z", reviewedHeadRefOid: "2".repeat(40) }], threads: [] };
const FEEDBACK_DIGEST = ownReviewFeedbackDigest(ORIGINAL_FEEDBACK);
const STATE_KEY = "automatic-own-pr-repair-state";
const clone = (value) => structuredClone(value);

class MemoryStore {
  values = new Map();
  async read(key, fallback) { return clone(this.values.has(key) ? this.values.get(key) : fallback); }
  async write(key, value) { this.values.set(key, clone(value)); }
}

function codeProposal(binding, conflict = false, operation = "modify", ci = false, diagnostics = []) {
  return normalizeBoundWorkProposal({
    proposalId: "own-pr-repair-code-proposal", policyVersion: 7, kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: binding.rootItemId },
    source: { assignmentId: "assignment-own-pr-repair", eventId: binding.eventId },
    binding: {
      eventId: binding.eventId,
      subject: { id: binding.rootItemId, repository: binding.repository, number: binding.pullRequestNumber },
      repository: binding.repository, workspaceId: "repair-workspace", inputBinding: binding,
      ...(operation !== "modify" ? {} : { executionSource: conflict ? externalActionControlledCommit(binding).executionSource
        : ci ? ciRepairSource(binding, ['src', 'test'], diagnostics) : createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src", "test"] }) }),
    },
    payload: {
      operation, objective: conflict ? "Resolve the current PR merge conflict and verify the result" : "Fix the reviewed race and add a regression test",
      acceptanceCriteria: ["Configured regression profile passes"], evidence: ["review:123"],
      summary: "Repair my PR", reason: "An external reviewer identified a reproducible bug",
    },
  });
}

function grantFor(proposal) {
  return createCodeJobGrant({
    schemaVersion: proposal.binding.executionSource ? 3 : 2, proposalId: proposal.proposalId, contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion, requestedBy: proposal.requestedBy, source: proposal.source,
    subject: proposal.binding.subject, repository: proposal.binding.repository,
    workspaceId: proposal.binding.workspaceId, inputBinding: proposal.binding.inputBinding,
    ...(proposal.binding.executionSource ? { executionSource: proposal.binding.executionSource } : {}),
    workspaceAuthorityDigest: "9".repeat(64), ...proposal.payload,
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[proposal.payload.operation]], writablePaths: proposal.binding.executionSource?.kind === "conflict_preparation"
      ? proposal.binding.executionSource.writeScope.paths : proposal.payload.operation === "modify" ? ["src", "test"] : [],
    requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }], brainDigest: "c".repeat(64),
  });
}

function queuedJob(grant) {
  return {
    jobId: codeJobIdForGrant(grant), status: "queued", revision: 1,
    proposalId: grant.proposalId, proposalContentDigest: grant.contentDigest, grantDigest: grant.grantDigest,
    requestedBy: grant.requestedBy, subject: grant.subject, repository: grant.repository,
    workspaceId: grant.workspaceId, inputBinding: grant.inputBinding,
    ...(grant.executionSource ? { executionSource: grant.executionSource } : {}),
    operation: grant.operation, objective: grant.objective, acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence, summary: grant.summary, reason: grant.reason, allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths, requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
    turn: 0, pendingActionType: null, observationCount: 0, latestObservation: null,
    terminalResult: null, memoryProjection: null, pause: null, uncertainty: null,
    createdAt: CREATED_AT, updatedAt: CREATED_AT,
  };
}

function controlledCommit(grant, overrides = {}) {
  const conflict = grant.executionSource.kind === "conflict_preparation";
  const changedPath = conflict ? grant.executionSource.writeScope.paths[0] : "src/value.js";
  const workspace = { id: grant.workspaceId, sourceRevision: "a".repeat(64), workspaceRevision: "b".repeat(64) };
  const artifact = (kind, marker) => ({ path: `repair/node-tests/${kind}.json`, sha256: marker.repeat(64), bytes: 12 });
  const manifest = createChangePackage({
    job: { id: codeJobIdForGrant(grant), revision: 7, recordDigest: "9".repeat(64) },
    proposal: { id: grant.proposalId, contentDigest: grant.contentDigest },
    grant: { digest: grant.grantDigest }, workspace,
    passedProfiles: [{
      id: "node-tests", configDigest: "b".repeat(64), workspaceRevision: workspace.workspaceRevision,
      actionId: "action-node-tests", attemptNumber: 1, imageId: "sha256:image-node-tests",
      artifacts: { output: artifact("output", "c"), stdout: artifact("stdout", "d"), stderr: artifact("stderr", "e") },
    }],
    created: [], modified: [{ path: changedPath, beforeSha256: "f".repeat(64), content: Buffer.from("fixed\n") }], deleted: [],
    ...overrides,
  }).manifest;
  const identity = { name: "MyDashboard Developer", email: "developer@mydashboard.local", timestamp: Date.parse(CREATED_AT) / 1_000, timezone: "+0000" };
  const finalTreeOid = "5".repeat(40);
  return createControlledCommitEvidence({
    executionSource: grant.executionSource, manifest,
    resolution: { resolvedPaths: [changedPath], finalTreeOid },
    commit: {
      objectFormat: "sha1", oid: "6".repeat(40), treeOid: finalTreeOid,
      parents: conflict ? [grant.inputBinding.headRefOid, grant.inputBinding.gitTarget.baseRefOid] : [grant.inputBinding.headRefOid], author: identity, committer: identity,
      messageDigest: createHash("sha256").update(createControlledCommitMessage({ executionSource: grant.executionSource, manifest })).digest("hex"),
      objectSetDigest: "e".repeat(64),
    }, createdAt: CREATED_AT,
  });
}

async function fixture({ enabled = true, conflict = false, ci = false, ownerRequestedCi = false, ownerGraph = null, ciContextReader = null, ciDiagnostics = () => [], operation = "modify", objectSync = null, pushOutcome = "applied", store = new MemoryStore(), clock = () => new Date(CREATED_AT), codeJobControl, taskRuns, recoveryLedger = {}, conflictInspectionReader } = {}) {
  const originalBinding = ownerGraph?.binding ?? pullRequestExternalActionBinding({
    gitTarget: { headRepository: "acme/repo", headRefName: "fix/review-feedback" },
  });
  const ownerEvent = ownerGraph?.root.source.current.event ?? (ownerRequestedCi ? normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.owner_requested", occurredAt: CREATED_AT,
    source: { provider: "local-owner", scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000" },
    subject: { id: originalBinding.rootItemId, repository: originalBinding.repository, number: originalBinding.pullRequestNumber },
    payload: { workType: "general", nextAction: "fix_ci", suggestedCapability: "development", expectedHeadRefOid: originalBinding.headRefOid,
      headRefOid: originalBinding.headRefOid, gitTargetAvailable: true, gitTarget: originalBinding.gitTarget } }) : null);
  const binding = ownerEvent === null ? originalBinding : { ...originalBinding, eventId: ownerEvent.eventId, eventDigest: ownerEvent.contentDigest };
  let proposal = codeProposal(binding, conflict, operation, ci, ciDiagnostics(binding));
  let observedCiEvidence = ci ? clone(proposal.binding.executionSource.ciEvidence) : null;
  let grant = grantFor(proposal);
  const config = {
    trackedRepositories: [binding.repository],
    githubActions: { enabled: true, automaticOwnPrRepair: enabled, actorAccountId: "runtime-user" },
    workCoordination: { policy: { workspaceByRepository: { [binding.repository]: grant.workspaceId } } },
    codeExecutor: { workspaces: [{ id: grant.workspaceId, gitHeadSnapshot: true, writablePaths: grant.writablePaths }] },
  };
  const item = { itemId: binding.rootItemId, event: {
    subject: { repository: binding.repository, number: binding.pullRequestNumber },
    payload: { relation: "authored", nextAction: conflict ? "resolve_conflict" : ci ? 'fix_ci' : "address_review", headRefOid: binding.headRefOid,
      mergeStateStatus: conflict ? "DIRTY" : "CLEAN", reviewFeedbackDigest: FEEDBACK_DIGEST },
  } };
  const facts = { state: "open", author: "runtime-user", headRefOid: binding.headRefOid,
    mergeStateStatus: conflict ? "DIRTY" : "CLEAN", baseRefOid: binding.gitTarget.baseRefOid,
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: FEEDBACK_DIGEST, feedback: clone(ORIGINAL_FEEDBACK) };
  const context = { inputBinding: binding, author: "runtime-user" };
  if (ownerRequestedCi) {
    // The pipeline's mock ledger represents the already verified owner root.
    // Exercise the real missing-author/event branch without rewriting history.
    Object.assign(item, { kind: "source_root", status: "queued", sourceQuarantine: null, event: ownerEvent,
      currentTarget: { type: "role", id: "developer" },
      source: { kind: "pull_request", identity: { provider: ownerEvent.source.provider, scopeId: ownerEvent.source.scopeId },
        scope: { kind: "owner_requested", active: true }, current: { event: ownerEvent } } });
    context.author = null;
    if (ownerGraph) Object.assign(item, clone(ownerGraph.root));
  }
  const jobs = new Map();
  const details = new Map();
  const verified = new Map();
  const pushes = [];
  let codeJobApprovalCount = 0;
  const guardFactory = () => ({ async acquire() {}, run: (operation) => operation(), async close() {} });
  const routing = await createWorkflowRoutingRuntime({ workflowRouting: { schemaVersion: 1, enabled: true, maxHops: 8, rules: [] } },
    { store, createGuard: guardFactory, clock });
  const reviewLedger = await createWorkLedgerRuntime({ store, assignmentSource: routing, createGuard: guardFactory,
    clock, idFactory: () => "review-delivery-lease" });
  const ownerWorkRequests = new OwnerWorkRequestService({ store, workflowRouting: routing, ledger: reviewLedger,
    capabilityReadiness: { async read(capability) { return { capability, roleId: capability === "development" ? "developer" : "pr-engineer", enabled: true, paused: false }; } },
    roleReadiness: { async read(roleId) { return { roleId, enabled: true, paused: false }; } },
    pullRequestResolver: { async resolvePullRequestTarget() { return { repository: binding.repository,
      number: binding.pullRequestNumber, title: "Review repaired PR", state: facts.state,
      gitTarget: { ...binding.gitTarget, headRefOid: facts.headRefOid } }; } },
    exclusiveLease: { run: (operation) => operation() }, clock });
  await ownerWorkRequests.recover();
  let loseReviewAcknowledgement = false;
  let deliveryPaused = false;
  const internalReviewPort = { async submitInternalReview(request) {
    if (deliveryPaused) throw new Error("internal review dispatch temporarily unavailable");
    const result = await ownerWorkRequests.submitInternalReview(request);
    if (loseReviewAcknowledgement) { loseReviewAcknowledgement = false; throw new Error("lost internal review acknowledgement"); }
    return result;
  } };
  let service;
  let queue;
  let failNextPushEnqueue = false;
  let interruptApprovalKind = null;
  let interruptPushRetry = false;
  let grantCurrent = true;
  const executor = {
    async execute(envelope) {
      if (envelope.kind === "local.code-job-create") {
        if (!conflict) {
        const repair = (await store.read(STATE_KEY)).repairs.find((row) => row.jobId === codeJobIdForGrant(envelope.action.grant));
        assert.ok((await store.read(originalRepairFeedbackArchiveKey(repair.feedbackSnapshotId))).snapshot,
          "complete feedback must be durable before approving the modify job");
        }
        codeJobApprovalCount += 1;
        const job = queuedJob(envelope.action.grant);
        jobs.set(job.jobId, job);
        return { status: "applied", receipt: { id: job.jobId, createdAt: CREATED_AT } };
      }
      assert.equal(envelope.kind, "github.pull-request-push");
      assert.equal(await service.verifyPush(envelope), true, "push must have current automatic repair authority");
      pushes.push(clone(envelope));
      const outcome = typeof pushOutcome === "function" ? pushOutcome(pushes.length) : pushOutcome;
      if (outcome === "unknown") return { status: "unknown", code: "TEST_PUSH_UNKNOWN" };
      if (outcome === "absent") return { status: "error", error: { code: "GITHUB_TIMEOUT", trust: "absent" } };
      facts.headRefOid = envelope.action.controlledCommitEvidence.commit.oid;
      return { status: "applied", receipt: { id: envelope.action.controlledCommitEvidence.commit.oid, createdAt: CREATED_AT } };
    },
    async reconcile(envelope) {
      if (pushOutcome === "unknown") return { status: "unknown", code: "TEST_PUSH_UNKNOWN" };
      return facts.headRefOid === envelope.action.controlledCommitEvidence.commit.oid
        ? { status: "already", receipt: { id: facts.headRefOid } } : { status: "absent", code: "GITHUB_PUSH_ABSENT" };
    },
  };
  const confirmationPort = {
    async enqueue(plan) {
      if (failNextPushEnqueue && plan.kind === "github.pull-request-push") {
        failNextPushEnqueue = false;
        throw Object.assign(new Error("simulated crash before queue write"), { code: "TEST_ENQUEUE_CRASH" });
      }
      return queue.enqueue(plan);
    },
    get: (...args) => queue.get(...args), approve: async (...args) => {
      if ((await queue.get(args[0])).kind === interruptApprovalKind) {
        interruptApprovalKind = null;
        throw new Error("approval interrupted before execution");
      }
      return queue.approve(...args);
    },
    invalidate: (...args) => queue.invalidate(...args),
    retry: (...args) => {
      if (interruptPushRetry) { interruptPushRetry = false; throw new Error("retry interrupted before execution"); }
      return queue.retry(...args);
    },
  };
  function makeQueue() {
    return new ConfirmationQueue({ store, executor, exclusiveLease: { run: (operation) => operation() }, clock });
  }
  function makeService() {
    const dependencies = {
      objectSync,
      configurationReader: { async readActive() { return { configuration: config }; } }, store,
      ledger: { ...(ownerGraph?.ledger ?? { async readPullRequestExecutionContext() { return clone(context); }, async readItemForReconciliation() { return clone(item); } }), ...recoveryLedger },
      github: { async readOwnPullRequestFeedback() { return clone(facts); }, async readOwnPullRequestConflict() { return clone(facts); },
        async readPullRequestLocalWorkFacts() { return clone(facts); } }, confirmations: confirmationPort,
      ...(ci ? { ciRepairContextReader: ciContextReader ?? { async read() { return { facts: clone(facts), ciEvidence: clone(observedCiEvidence) }; } } } : {}),
      codeJobReader: { async get(jobId) { return clone(jobs.get(jobId) ?? null); }, async getDetail({ jobId }) { return clone(details.get(jobId) ?? null); } },
      conflictInspectionReader,
      confirmationSettlementReader: { read: request => queue.readSettlement(request) },
      controlledCommitReader: { async verify({ evidenceId }) { return clone(verified.get(evidenceId)); } },
      historicalControlledCommitReader: new HistoricalControlledCommitReader({ store,
        controlledCommitReader: { async verify({ evidenceId }) { return clone(verified.get(evidenceId)); } } }),
      grantVerifier: { async verify(value) {
        if (!grantCurrent) throw Object.assign(new Error("revoked grant"), { code: "INVALID_CODE_JOB_AUTHORITY" });
        return clone(value);
      } },
      ownerWorkRequests: internalReviewPort,
      clock,
      historicalRepairFeedbackReader: { async read({ inputBinding, feedbackDigest }) {
        return { context: { schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest, feedback: clone(ORIGINAL_FEEDBACK) },
          provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: facts.headRefOid, observedAt: CREATED_AT } };
      } },
    };
    return new AutomaticOwnPrRepair({ ...dependencies, conflictRepair: new AutomaticOwnPrConflict({ ...dependencies, codeJobControl, taskRuns }) });
  }
  queue = makeQueue(); await queue.recover();
  service = makeService(); await service.recover();
  function handler() {
    return new CodeActionProposalHandler({
      confirmationProducer: confirmationPort, codeJobReader: { async get(id) { return clone(jobs.get(id) ?? null); } },
      grantFactory: { async create() { return { grant, allowedOperationsByRole: { developer: ["inspect", "modify", "verify"] } }; } },
      automaticOwnPrRepair: service, clock: () => new Date(CREATED_AT),
    });
  }
  return {
    store, binding, config, item, facts, context, jobs, pushes, ownerWorkRequests, reviewLedger, details, verified,
    get proposal() { return proposal; }, get grant() { return grant; },
    adoptProposal(value) { proposal = normalizeBoundWorkProposal(value); grant = grantFor(proposal);
      observedCiEvidence = grant.executionSource?.ciEvidence ? clone(grant.executionSource.ciEvidence) : null; },
    get service() { return service; }, get queue() { return queue; },
    get codeJobApprovalCount() { return codeJobApprovalCount; },
    async deliver() { return handler().handle({ proposal, status: "pending_delivery", attempt: 1, downstreamRef: null }); },
    async resume(transition) { return handler().handle({ proposal, status: transition.status, attempt: 2, downstreamRef: transition.downstreamRef }); },
    completeJob(overrides) {
      const evidence = controlledCommit(grant, overrides);
      verified.set(evidence.evidenceId, evidence);
      details.set(codeJobIdForGrant(grant), {
        job: { ...queuedJob(grant), status: "completed" },
        changePackage: { receipt: { controlledCommit: { evidenceId: evidence.evidenceId, evidenceDigest: evidence.evidenceDigest, commitOid: evidence.commit.oid } } },
      });
      return evidence;
    },
    crashBeforePushQueueWrite() { failNextPushEnqueue = true; },
    interruptApproval(kind) { interruptApprovalKind = kind; },
    interruptRetry() { interruptPushRetry = true; },
    revokeGrant() { grantCurrent = false; },
    changeCiDiagnostics(diagnostics) {
      const { contentDigest, triggerDigest, ...material } = observedCiEvidence;
      observedCiEvidence = createCiRepairEvidence({ ...material, diagnostics });
    },
    loseReviewAcknowledgement() { loseReviewAcknowledgement = true; },
    pauseReviewDelivery(value = true) { deliveryPaused = value; },
    async restart() {
      queue = makeQueue(); await queue.recover();
      service = makeService(); await service.recover();
    },
  };
}

test('CI failure repairs automatically publish a controlled commit and hand off immutable CI evidence once across restart', async () => {
  const f = await fixture({ ci: true });
  const prepared = await f.service.prepare({ item: f.item, inputBinding: f.binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
  assert.deepEqual(prepared, f.grant.executionSource);
  await f.deliver();
  assert.equal(f.codeJobApprovalCount, 1);
  assert.equal(await f.service.shouldRun(f.item), false, 'in-flight CI repair suppresses another decision');
  const repair = (await f.store.read(STATE_KEY)).repairs[0];
  assert.equal(repair.sourceKind, 'ci_repair');
  const archived = await f.store.read(originalRepairFeedbackArchiveKey(repair.feedbackSnapshotId));
  assert.equal(archived.snapshot.ciEvidence.contentDigest, repair.feedbackDigest);
  assert.equal(Object.hasOwn(archived.snapshot, 'feedback'), false);
  const evidence = f.completeJob();
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.deepEqual(f.pushes[0].action.controlledCommitEvidence.commit.parents, [f.binding.headRefOid]);
  const published = (await f.store.read(STATE_KEY)).published[0];
  assert.equal(published.sourceKind, 'ci_repair');
  assert.equal(published.reviewDelivery.status, 'completed');
  assert.equal(published.reviewDelivery.request.internalReview.kind, 'own_pr_ci_repair');
  assert.equal(published.reviewDelivery.request.internalReview.headRefOid, evidence.commit.oid);
  assert.match(published.reviewDelivery.request.description, /不表示新 Head 的 CI 已通过/);
  assert.equal(published.reviewDelivery.roleId, 'pr-engineer');
  await f.restart(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(await f.service.shouldRun(f.item), false);
});

async function publishedInternalCiFollowup() {
  const f = await fixture({ ci: true });
  await f.deliver(); f.completeJob();
  await f.service.runCycle(); await f.service.runCycle();
  const published = (await f.store.read(STATE_KEY)).published[0];
  const request = published.reviewDelivery.request;
  const event = clone(createOwnerPullRequestEvent(request, { repository: f.binding.repository, number: f.binding.pullRequestNumber,
    title: 'Review published repair', state: 'open', gitTarget: { ...f.binding.gitTarget, headRefOid: published.commitOid } }, CREATED_AT));
  const binding = { ...f.binding, rootItemId: published.reviewDelivery.workItemId,
    headRefOid: published.commitOid, eventId: event.eventId, eventDigest: event.contentDigest,
    gitTarget: { ...f.binding.gitTarget, headRefOid: published.commitOid } };
  Object.assign(f.context, { inputBinding: binding, author: null });
  Object.assign(f.item, { itemId: binding.rootItemId, kind: 'source_root', status: 'working', sourceQuarantine: null,
    currentTarget: { type: 'role', id: 'developer' }, event,
    source: { kind: 'pull_request', pendingRevision: null, scope: { kind: 'internal_review', active: true },
      identity: { provider: event.source.provider, scopeId: event.source.scopeId }, current: { event } } });
  const { contentDigest, ...proposal } = codeProposal(binding, false, 'modify', true);
  f.adoptProposal({ ...proposal, proposalId: 'internal-ci-followup' });
  return { f, binding };
}

test('a published internal CI review can continue a developer fix with fresh sealed CI provenance', async () => {
  const { f, binding } = await publishedInternalCiFollowup();
  const prepared = await f.service.prepare({ item: f.item, inputBinding: binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
  assert.deepEqual(prepared, f.grant.executionSource);
  await f.deliver();
  assert.equal(f.codeJobApprovalCount, 2);
  assert.equal((await f.store.read(STATE_KEY)).repairs.at(-1).sourceKind, 'ci_repair');
});

test('an unstarted internal CI modify grant without provenance is retired rather than manually approved', async () => {
  const { f } = await publishedInternalCiFollowup();
  const proposal = clone(f.proposal);
  delete proposal.binding.executionSource;
  delete proposal.contentDigest;
  f.adoptProposal(proposal);
  assert.equal((await f.deliver()).status, 'stale');
  assert.equal(f.codeJobApprovalCount, 1, 'the unsealed followup never starts');
});

for (const variant of ['disabled', 'paused', 'author', 'head', 'base', 'feedback', 'publication', 'commit']) {
  test(`internal CI followup retains publication, remote target and owner controls (${variant})`, async () => {
    const { f, binding } = await publishedInternalCiFollowup();
    if (variant === 'disabled') f.config.githubActions.automaticOwnPrRepair = false;
    if (variant === 'paused') f.item.status = 'paused';
    if (variant === 'author') f.facts.author = 'other';
    if (variant === 'head') f.facts.headRefOid = 'f'.repeat(40);
    if (variant === 'base') f.facts.baseRefOid = 'f'.repeat(40);
    const metadata = f.item.source.current.event.payload.internalReview;
    if (variant === 'feedback') metadata.feedbackDigest = 'f'.repeat(64);
    if (variant === 'publication') metadata.publicationConfirmationId = 'unrelated-publication';
    if (variant === 'commit') metadata.controlledCommitEvidenceId = 'unrelated-commit';
    const prepare = () => f.service.prepare({ item: f.item, inputBinding: binding,
      intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
    if (variant === 'disabled') assert.equal(await prepare(), undefined);
    else await assert.rejects(prepare, { code: 'OWN_PR_CI_SOURCE_NOT_READY' });
    assert.equal(f.codeJobApprovalCount, 1);
  });
}

test('native CI and Review continuation requires the exact live repair receipt', async t => {
  for (const kind of ['review', 'ci']) await t.test(kind, async () => {
    const f = await fixture({ ci: kind === 'ci' });
    await f.deliver();
    const job = { jobId: codeJobIdForGrant(f.grant), grant: clone(f.grant) };
    assert.equal(await f.service.canRecoverPausedCodeJob(job), true);
    assert.equal(await f.service.canRecoverPausedCodeJob({ ...job, jobId: 'other-job' }), false);
    f.revokeGrant();
    assert.equal(await f.service.canRecoverPausedCodeJob(job), false);
    assert.equal(f.pushes.length, 0);
  });
});

test('unstarted write replanning requires the exact still-working conflict, review or CI repair receipt', async (t) => {
  for (const kind of ['conflict', 'review', 'ci']) await t.test(kind, async () => {
    const f = await fixture({ conflict: kind === 'conflict', ci: kind === 'ci' });
    await f.deliver();
    const job = { jobId: codeJobIdForGrant(f.grant), grant: clone(f.grant) };
    assert.equal(await f.service.canReplanUnstartedWrite(job), true);
    assert.equal(f.pushes.length, 0, 'eligibility cannot publish');
    await f.restart();
    assert.equal(await f.service.canReplanUnstartedWrite(job), true);
    assert.equal(await f.service.canReplanUnstartedWrite({ ...job, jobId: 'foreign-job' }), false);
    const changed = clone(job);
    changed.grant.objective = 'unrelated authority';
    assert.equal(await f.service.canReplanUnstartedWrite(changed), false);
    f.revokeGrant();
    assert.equal(await f.service.canReplanUnstartedWrite(job), false);
  });
});

test('repair-origin recovery rejects changed remote identity and settled source records', async (t) => {
  for (const kind of ['conflict', 'review', 'ci']) for (const change of ['head', 'base', 'author', 'disabled', 'settled']) {
    await t.test(`${kind}: ${change}`, async () => {
      const f = await fixture({ conflict: kind === 'conflict', ci: kind === 'ci' });
      await f.deliver();
      const job = { jobId: codeJobIdForGrant(f.grant), grant: clone(f.grant) };
      if (change === 'head') f.facts.headRefOid = '9'.repeat(40);
      if (change === 'base') f.facts.baseRefOid = '9'.repeat(40);
      if (change === 'author') f.facts.author = 'other';
      if (change === 'disabled') f.config.githubActions.automaticOwnPrRepair = false;
      if (change === 'settled') {
        const key = kind === 'conflict' ? 'automatic-own-pr-conflict-state' : STATE_KEY;
        const value = await f.store.read(key);
        (kind === 'conflict' ? value.records : value.repairs)[0].status = 'failed';
        await f.store.write(key, value); await f.restart();
      }
      assert.equal(await f.service.canReplanUnstartedWrite(job), false);
      assert.equal(f.pushes.length, 0);
    });
  }
});

test("owner-requested CI repair seals fresh ownership and uses controlled commit, auto publication and internal review", async () => {
  const f = await fixture({ ci: true, ownerRequestedCi: true });
  const original = clone(f.item.event);
  const source = await f.service.prepare({ item: f.item, inputBinding: f.binding,
    intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' });
  assert.equal(source?.kind, 'ci_repair');
  assert.equal(f.context.author, null);
  assert.deepEqual(f.item.event, original);
  await f.deliver();
  assert.equal(f.codeJobApprovalCount, 1);
  assert.equal(await f.service.shouldRun(f.item), false, 'in-flight owner CI repair suppresses another decision');
  f.completeJob();
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  const published = (await f.store.read(STATE_KEY)).published[0];
  assert.equal(published.sourceKind, 'ci_repair');
  assert.equal(published.reviewDelivery.status, 'completed');
  assert.equal(published.reviewDelivery.request.internalReview.kind, 'own_pr_ci_repair');
  await f.restart(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(await f.service.shouldRun(f.item), false, 'published original Head remains consumed');
});

for (const ci of [false, true]) {
  test(`settled empty repair releases the PR without fabricating publication across restart (ci=${ci})`, async () => {
    const f = await fixture({ ci });
    await f.deliver();
    f.completeJob();
    const detail = f.details.get(codeJobIdForGrant(f.grant));
    detail.changePackage = { status: 'ready', receipt: { noChanges: true } };
    const before = clone(detail);
    const conflictItem = clone(f.item);
    conflictItem.event.payload.nextAction = 'resolve_conflict';
    conflictItem.event.payload.headRefOid = '9'.repeat(40);
    assert.equal(await f.service.shouldRun(f.item), false);
    assert.equal(await f.service.shouldRun(conflictItem), false, 'historical repair excludes newer conflict work');
    await f.restart();
    const result = await f.service.runCycle();
    assert.equal(result.failed, 1);
    assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, 'failed');
    assert.equal(await f.service.shouldRun(f.item), true);
    assert.equal(await f.service.shouldRun(conflictItem), true, 'empty completion releases newer conflict work');
    await f.restart();
    assert.equal((await f.service.runCycle()).scanned, 0);
    assert.equal(f.codeJobApprovalCount, 1, 'the old job must never be replayed');
    assert.equal(f.jobs.size, 1);
    assert.equal(f.pushes.length, 0);
    assert.deepEqual(f.store.values.get(STATE_KEY).published, []);
    assert.deepEqual((await f.ownerWorkRequests.list()).items, []);
    assert.deepEqual(detail, before, 'the terminal job and its source binding remain immutable');
  });
}

for (const scenario of ['active-job', 'paused-job', 'pending-package', 'missing-package', 'nonempty-package']) {
  test(`repair keeps its exclusion until empty completion is proven (${scenario})`, async () => {
    const f = await fixture({ ci: true });
    await f.deliver();
    f.completeJob();
    const detail = f.details.get(codeJobIdForGrant(f.grant));
    detail.changePackage = { status: 'ready', receipt: { noChanges: true } };
    if (scenario === 'active-job') detail.job.status = 'active';
    if (scenario === 'paused-job') detail.job.status = 'paused';
    if (scenario === 'pending-package') detail.changePackage.status = 'pending';
    if (scenario === 'missing-package') delete detail.changePackage;
    if (scenario === 'nonempty-package') detail.changePackage.receipt.noChanges = false;
    const before = clone(detail);
    await f.restart();
    assert.equal((await f.service.runCycle()).failed, 0);
    assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, 'working');
    assert.equal(await f.service.shouldRun(f.item), false);
    assert.equal(f.pushes.length, 0);
    assert.deepEqual(detail, before);
  });
}

test("normal local completion cannot strand an already controlled owner CI publication", async () => {
  const f = await fixture({ ci: true, ownerRequestedCi: true });
  await f.deliver(); f.completeJob();
  f.item.status = 'completed';
  await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
});

for (const drift of ['author', 'head', 'base', 'actor', 'paused', 'rejected', 'inactive', 'source-scope', 'event-binding', 'checks', 'reader-unavailable']) {
  test(`owner CI provenance cannot bypass current authority (${drift})`, async () => {
    const f = await fixture({ ci: true, ownerRequestedCi: true });
    if (drift === 'author') f.facts.author = 'other-author';
    if (drift === 'head') f.facts.headRefOid = '9'.repeat(40);
    if (drift === 'base') f.facts.baseRefOid = '9'.repeat(40);
    if (drift === 'actor') f.config.githubActions.actorAccountId = 'other-account';
    if (drift === 'paused') f.item.status = 'paused';
    if (drift === 'rejected') { f.item.status = 'blocked'; f.item.statusReason = 'proposal_rejected'; }
    if (drift === 'inactive') f.item.source.scope.active = false;
    if (drift === 'source-scope') f.item.source.identity.scopeId = 'other-scope';
    if (drift === 'event-binding') f.item.source.current.event = { ...f.item.source.current.event, eventId: 'workflow-event-stale' };
    if (drift === 'checks') f.service.ciRepairContextReader.read = async () => null;
    if (drift === 'reader-unavailable') f.service.ciRepairContextReader = null;
    await assert.rejects(f.service.prepare({ item: f.item, inputBinding: f.binding,
      intent: { type: 'propose_code_action', operation: 'modify' }, roleId: 'developer' }),
      error => error.code === 'OWN_PR_CI_SOURCE_NOT_READY');
    assert.equal(f.codeJobApprovalCount, 0);
    assert.equal(f.pushes.length, 0);
  });
}

for (const waitForChildren of [false, true]) test(`real owner triage and graph dispatch generate CI provenance before automatic publication (child wait=${waitForChildren})`, async () => {
  const store = new MemoryStore(), initial = await fixture({ ci: true, store });
  const request = await initial.ownerWorkRequests.submit(createPrTriageWorkRequest({ requestKey: "owner-ci-real-dispatch",
    targetRoleId: "developer", repository: initial.binding.repository, number: initial.binding.pullRequestNumber,
    nextAction: "fix_ci", expectedHeadRefOid: initial.binding.headRefOid }));
  const root = await initial.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
  const originalEvent = clone(root.source.current.event);
  const assembler = new RoleContextAssembler({ graphReader: initial.reviewLedger.graphReader });
  const packet = await assembler.assemble({ roleId: "orchestrator", item: root, trigger: "scheduled" });
  const orchestrator = new OrchestratorService({ contextAssembler: assembler, graphReader: initial.reviewLedger.graphReader,
    scopedGraphPlannerFactory: initial.reviewLedger.scopedGraphPlannerFactory, graphDelivererFactory: initial.reviewLedger.graphDelivererFactory,
    capabilityRoles: { development: "developer" }, clock: () => new Date(CREATED_AT) });
  const reason = "Route current owner-requested CI repair through controlled execution";
  await orchestrator.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: root, contextPacket: packet,
    intent: { schemaVersion: 1, type: "orchestrate", summary: "Create CI repair child", reason, action: {
      schemaVersion: 1, type: "decompose", sourceTaskId: root.itemId, sourceTaskRevision: root.revision,
      expectedGraphRevision: packet.context.requirements.graph.revision, reason, childKey: "controlled-ci-repair",
      work: { title: "Repair CI", description: "Repair the current failed checks and publish a controlled commit" },
      capability: "development", dependsOn: [], acceptanceContract: { revision: 1, acceptanceCriteria: [],
        expectedDeliverables: [{ deliverableId: "implementation", kind: "change-package", description: "Controlled repair", required: true }] },
    } } });
  const child = (await initial.reviewLedger.listItems({ limit: 100 })).items.find(item => item.graph.parentItemId === root.itemId);
  if (waitForChildren) {
    const parent = await initial.reviewLedger.readItemForReconciliation({ itemId: root.itemId });
    await initial.reviewLedger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: root.itemId }).pauseTask({
      taskId: root.itemId, expectedTaskRevision: parent.revision,
      expectedGraphRevision: (await initial.reviewLedger.getSummary()).revision,
      reason: "Wait for the existing repair child", waitForChildren: true,
    });
  }
  const binding = currentWorkItemExecutionBinding(child);
  assert.equal(Object.hasOwn(originalEvent.payload, "relation"), false);
  assert.equal((await initial.reviewLedger.readPullRequestExecutionContext(binding)).author, null);
  let f;
  const ciReader = new CiRepairContextReader({ github: {
    async readPullRequestLocalWorkFacts() { return clone(f.facts); },
    async loadPullRequestFacts(input) {
      return createPullRequestReadFacts({ identity: createPullRequestReadIdentity(input), observedAt: CREATED_AT,
        reviewDecision: "NONE", comments: [], reviews: [], reviewThreads: [],
        checks: f.grant.executionSource.ciEvidence.checks.map(check => ({ ...check, status: "COMPLETED",
          startedAt: null, completedAt: null, requirement: "required" })),
        truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } });
    },
  } });
  f = await fixture({ ci: true, ownerRequestedCi: true, store, ciContextReader: ciReader,
    ownerGraph: { binding, root: await initial.reviewLedger.readItemForReconciliation({ itemId: root.itemId }), ledger: initial.reviewLedger } });
  const claimed = await initial.reviewLedger.claim({ itemId: child.itemId, expectedRevision: child.revision,
    workerId: "employee-developer", leaseDurationMs: 30_000 });
  await initial.reviewLedger.stageIntent({ itemId: child.itemId, expectedRevision: claimed.revision, leaseId: claimed.leaseId,
    actorId: "employee-developer", roleId: "developer", intent: { schemaVersion: 1, type: "propose_code_action", operation: "modify",
      summary: "Repair current CI", reason: "Current GitHub checks fail", objective: "Fix the bound failed CI checks",
      acceptanceCriteria: ["Configured regression passes"], evidence: ["Current CI check failure"] } });
  let prepared = 0;
  const dispatcher = new WorkIntentDispatcher({ ledger: initial.reviewLedger,
    policy: createWorkIntentPolicy({ codeActionRoles: ["developer"], workspaceByRepository: { [binding.repository]: f.grant.workspaceId } }),
    reviewRepairSourcePreparer: { async prepare(input) { prepared++; return f.service.prepare(input); } },
    attentionProducer: { async create() { assert.fail("Routine CI repair must not ask the owner"); } },
    proposalProducer: { async create(value) {
      const proposal = normalizeBoundWorkProposal(value);
      assert.equal(proposal.binding.executionSource?.kind, "ci_repair");
      f.adoptProposal(value);
      return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, kind: proposal.kind,
        status: "pending_delivery", revision: 1, createdAt: CREATED_AT };
    } }, clock: () => new Date(CREATED_AT) });
  const dispatched = await dispatcher.dispatchPending();
  assert.equal(dispatched.delivered, 1, JSON.stringify(dispatched));
  assert.equal(prepared, 1);
  assert.equal(f.grant.executionSource.kind, "ci_repair");
  await f.deliver();
  assert.equal(await f.service.shouldRun(child), false, "only the developer is suppressed while its CI repair is active");
  assert.equal(await f.service.shouldRun(f.item), true, "the orchestrator remains able to settle and coordinate its children");
  f.completeJob();
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  const published = (await store.read(STATE_KEY)).published[0];
  assert.equal(published.reviewDelivery.request.internalReview.kind, "own_pr_ci_repair");
  assert.deepEqual((await initial.reviewLedger.readItemForReconciliation({ itemId: root.itemId })).source.current.event, originalEvent);
  await f.restart(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
});

for (const change of ['head', 'base', 'author', 'disabled', 'grant']) test(`CI publication stops after ${change} authority changes`, async () => {
  const f = await fixture({ ci: true }); await f.deliver(); f.completeJob();
  if (change === 'head') f.facts.headRefOid = '9'.repeat(40);
  if (change === 'base') f.facts.baseRefOid = '9'.repeat(40);
  if (change === 'author') f.facts.author = 'other';
  if (change === 'disabled') f.config.githubActions.automaticOwnPrRepair = false;
  if (change === 'grant') f.revokeGrant();
  assert.equal((await f.service.runCycle()).stale, 1);
  assert.equal(f.pushes.length, 0);
});

test('unknown CI push outcomes stay fenced across restart instead of publishing a second commit', async () => {
  const f = await fixture({ ci: true, pushOutcome: 'unknown' });
  await f.deliver(); f.completeJob(); await f.service.runCycle();
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal((await f.store.read(STATE_KEY)).repairs[0].status, 'pushing');
  assert.equal(await f.service.shouldRun(f.item), false);
});

test('retired CI push resumes the same confirmation after automatic mode is restored', async () => {
  const f = await fixture({ ci: true, pushOutcome: attempt => attempt === 1 ? "absent" : "applied" });
  await f.deliver(); f.completeJob(); await f.service.runCycle();
  const original = (await f.store.read(STATE_KEY)).repairs[0];
  f.config.githubActions.automaticOwnPrRepair = false;
  await f.service.runCycle(); await f.restart();
  assert.equal((await f.store.read(STATE_KEY)).repairs[0].status, "stale");
  f.config.githubActions.automaticOwnPrRepair = true;
  await f.service.runCycle(); await f.service.runCycle();
  const recovered = (await f.store.read(STATE_KEY)).repairs[0];
  assert.equal(recovered.status, "published");
  assert.equal(recovered.pushConfirmationId, original.pushConfirmationId);
  assert.equal(f.codeJobApprovalCount, 1);
  assert.equal(f.pushes.length, 2);
});

test('a retired ledger binding invalidates an unadmitted CI push instead of leaving a manual confirmation', async () => {
  const f = await fixture({ ci: true }); await f.deliver(); f.completeJob();
  f.interruptApproval('github.pull-request-push');
  assert.equal((await f.service.runCycle()).failed, 1);
  const record = (await f.store.read(STATE_KEY)).repairs[0];
  assert.equal((await f.queue.get(record.pushConfirmationId)).status, 'pending');
  f.service.ledger.readPullRequestExecutionContext = async () => {
    throw Object.assign(new Error('source retired'), { code: 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE' });
  };
  assert.equal((await f.service.runCycle()).stale, 1);
  assert.equal((await f.queue.get(record.pushConfirmationId)).status, 'stale');
  assert.equal(f.pushes.length, 0);
  await f.restart(); await f.service.runCycle();
  assert.equal((await f.store.read(STATE_KEY)).repairs[0].status, 'stale');
});

for (const phase of ['approval', 'publication']) test(`optional Jenkins outage at CI ${phase} preserves trigger authority and the original sealed diagnosis`, async () => {
  const f = await fixture({ ci: true, ciDiagnostics: binding => [{ check: 'QuickTest', schemaVersion: 1,
    repository: binding.repository, headRefOid: binding.headRefOid, buildUrl: 'https://ci.example/job/QuickTest/12/', buildNumber: 12,
    state: 'available', result: 'FAILURE', untrustedEvidence: true,
    checkout: { matched: true, sha: binding.headRefOid, branch: binding.gitTarget.headRefName },
    failures: [{ name: 'CodeTest.Original', text: 'Original immutable CI defect', truncated: false }] }] });
  const original = clone(f.grant.executionSource.ciEvidence);
  const unavailable = [{ check: 'QuickTest', state: 'unavailable', code: 'JENKINS_AUTH_REQUIRED' }];
  if (phase === 'approval') f.changeCiDiagnostics(unavailable);
  await f.deliver(); f.completeJob();
  if (phase === 'publication') f.changeCiDiagnostics(unavailable);
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  const published = (await f.store.read(STATE_KEY)).published[0];
  assert.equal(published.feedbackDigest, original.contentDigest);
  assert.equal(published.ciTriggerDigest, original.triggerDigest);
  const archive = await f.store.read(originalRepairFeedbackArchiveKey(published.feedbackSnapshotId));
  assert.deepEqual(archive.snapshot.ciEvidence, original);
  assert.equal(published.reviewDelivery.status, 'completed');
});

for (const kind of ["dispatch-stale", "authority-fenced", "proposal-before-confirmation"]) {
  for (const variant of ["recover", "disabled", "head-drift", "paused", "source-mismatch", "preparation-failed", "concurrent-change", "later-ledger-change", "budget-exhausted",
    ...(kind === "dispatch-stale" ? ["bound-dispatch", "unknown-failure"] : kind === "authority-fenced"
      ? ["observed-action", "archived", "unknown-terminal", "changed-detail"] : ["confirmation-exists", "forged-result"])]) {
  test(`automatic conflict recovery rebuilds materials only after a proven unstarted failure (${kind}, ${variant})`, async () => {
    let f, reads = 0;
    const outboxes = [], transitions = [];
    f = await fixture({ conflict: true, objectSync: { async prepare() {} },
      recoveryLedger: {
        async listItems() { return { items: [clone(f.item)], nextCursor: null }; },
        async listOutbox() { return { items: clone(outboxes), nextCursor: null }; },
        async transition(request) {
          assert.equal(request.expectedRevision, f.item.revision);
          transitions.push(request); f.item.status = "queued"; f.item.revision++;
        },
      },
      conflictInspectionReader: { async read(inputBinding) {
        reads++;
        if (reads > 1 && variant === "preparation-failed") throw Object.assign(new Error("material is still invalid"), { code: "CONTROLLED_GIT_PREPARATION_TAMPERED" });
        if (reads > 1 && variant === "concurrent-change") f.item.revision++;
        return { inputBinding, preparationBinding: externalActionControlledCommit(inputBinding).executionSource.preparationBinding,
          conflicts: [{ path: "src/conflict.txt" }] };
      } },
    });
    const b = f.binding;
    Object.assign(f.item, { kind: "graph_task", revision: 4, inputDigest: "e".repeat(64), status: "blocked",
      statusReason: kind === "dispatch-stale" ? "intent_failed" : "proposal_stale", updatedAt: CREATED_AT,
      currentTarget: { type: "role", id: "developer" }, activeIntentId: null, leaseId: null,
      graph: { deliveries: [] }, decisionContext: null,
      assignmentId: f.proposal.source.assignmentId, assignment: { graphTask: { sourceBinding: Object.fromEntries(
        ["kind", "rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"].map(key => [key, b[key]])) } },
    });
    f.item.event = { schemaVersion: 1, eventId: b.eventId, contentDigest: b.eventDigest,
      occurredAt: CREATED_AT, eventType: "pull_request.updated", source: { provider: "github", scopeId: "test" },
      subject: { id: `github:pr:${b.repository}#${b.pullRequestNumber}`, repository: b.repository, number: b.pullRequestNumber },
      payload: { nextAction: "resolve_conflict", relation: "authored", headRefOid: b.headRefOid, gitTargetAvailable: true, gitTarget: b.gitTarget } };
    const outbox = { intentId: "host-conflict-intent", itemId: f.item.itemId, inputDigest: f.item.inputDigest,
      sourceBinding: currentWorkItemInputBinding(f.item), requestedBy: { roleId: "developer" },
      intent: { type: "propose_code_action", operation: "modify" }, updatedAt: CREATED_AT,
      status: "failed", dispatchBinding: null, outcome: { status: "failed", details: { code: "conflict-source-stale" } } };
    if (kind === "authority-fenced") {
      const result = await f.deliver();
      const confirmation = await f.queue.get(result.downstreamRef);
      const job = f.jobs.get(codeJobIdForGrant(f.grant));
      Object.assign(job, { status: "fenced", terminalResult: { kind: "fenced", recordedAt: CREATED_AT } });
      f.details.set(job.jobId, { job: clone(job), archived: false, historyAvailable: true, observations: [], nextCursor: null,
        terminalDetail: { code: "INVALID_CODE_JOB_AUTHORITY" } });
      f.item.decisionContext = { source: "proposal", outcome: "stale", referenceId: f.proposal.proposalId,
        contentDigest: "8".repeat(64), observedAt: "2026-10-10T02:59:59.800Z", value: { kind: "code_action_proposal",
          downstreamRef: confirmation.id, evidence: [`confirmation:${confirmation.id}`, "authorization_changed", "old_confirmation_status:completed"] } };
      const { proposalId, contentDigest, ...content } = f.proposal;
      Object.assign(outbox, { status: "delivered", dispatchBinding: createWorkIntentDispatchBinding({ intentId: proposalId, ...content }),
        outcome: { status: "delivered", details: { downstreamRef: proposalId, proposalDigest: f.proposal.contentDigest,
          resultAttestation: { decisionContentDigest: f.item.decisionContext.contentDigest } } } });
    }
    if (kind === "proposal-before-confirmation") {
      if (variant === "confirmation-exists") await f.deliver();
      const result = createWorkProposalResult({ proposal: f.proposal, sequence: 1, at: "2026-10-10T02:59:59.800Z", downstreamRef: null,
        transition: { status: "stale", summary: "Source invalid before enqueue", evidence: ["authorization_changed", `proposal:${f.proposal.proposalId}`] } });
      f.item.decisionContext = createWorkDecisionContext({ source: "proposal", referenceId: result.proposalId, outcome: result.outcome,
        observedAt: result.at, value: { kind: result.kind, resultId: result.resultId, resultDigest: result.contentDigest,
          summary: result.summary, downstreamRef: result.downstreamRef, evidence: result.evidence } });
      const { proposalId, contentDigest, ...content } = f.proposal;
      Object.assign(outbox, { status: "delivered", dispatchBinding: createWorkIntentDispatchBinding({ intentId: proposalId, ...content }),
        outcome: { status: "delivered", details: { downstreamRef: proposalId, proposalDigest: contentDigest,
          resultAttestation: createProposalResultAttestation({ intentId: outbox.intentId, result,
            decisionContentDigest: f.item.decisionContext.contentDigest }) } } });
      if (variant === "forged-result") outbox.outcome.details.resultAttestation.payload.summary = "forged";
    }
    outboxes.push(outbox);
    // Existing cached material must not be reused to recover an expired source.
    await f.service.conflictRepair.prepareInspection({ itemId: f.item.itemId, itemRevision: 4, inputDigest: f.item.inputDigest });
    assert.equal(reads, 1);
    if (variant === "disabled") f.config.githubActions.automaticOwnPrRepair = false;
    if (variant === "head-drift") f.facts.headRefOid = "9".repeat(40);
    if (variant === "paused") f.item.status = "paused";
    if (variant === "later-ledger-change") f.item.updatedAt = "2026-10-10T03:00:01.000Z";
    if (variant === "source-mismatch") outbox.inputDigest = "9".repeat(64);
    if (variant === "bound-dispatch") outbox.dispatchBinding = {};
    if (variant === "unknown-failure") outbox.outcome.details.code = "conflict-source-invalid";
    if (variant === "budget-exhausted") {
      await f.store.write("automatic-own-pr-conflict-recovery-state", { schemaVersion: 1,
        records: [1, 2, 3].map(attempt => ({ itemId: f.item.itemId, inputBinding: b, failureRef: `old-${attempt}`, attempt, status: "requeued" })) });
      await f.service.conflictRepair.conflictRecovery.recover();
    }
    if (kind === "authority-fenced") {
      const job = f.jobs.get(codeJobIdForGrant(f.grant)), detail = f.details.get(job.jobId);
      if (variant === "observed-action") {
        Object.assign(job, { turn: 1, observationCount: 1, latestObservation: { actionType: "read_text", status: "succeeded", recordedAt: CREATED_AT } });
        detail.job = clone(job);
      }
      if (variant === "archived") detail.archived = true;
      if (variant === "unknown-terminal") detail.terminalDetail.code = "OWNER_STOPPED";
      if (variant === "changed-detail") detail.job.revision++;
    }
    const result = await f.service.conflictRepair.runCycle();
    if (variant !== "recover") {
      assert.equal(result.conflictRecovery?.requeued, 0);
      assert.equal(transitions.length, 0);
      assert.equal(f.pushes.length, 0);
      return;
    }
    assert.equal(result.conflictRecovery?.requeued, 1);
    assert.equal(reads, 2);
    assert.equal(transitions.length, 1);
    assert.equal(f.item.status, "queued");
    assert.equal(f.pushes.length, 0);
    await f.restart();
    f.item.status = "blocked";
    await f.service.conflictRepair.runCycle();
    assert.equal(transitions.length, 1, "a restarted host must not replay a settled recovery");
  });
  }
}

test("automatic conflict materials are synchronized and read only for a current owned task", async () => {
  for (const variant of ["current", "disabled", "stale-item", "base-drift"]) {
    let syncs = 0;
    const f = await fixture({ conflict: true, operation: "inspect", objectSync: { async prepare() { syncs += 1; } } });
    const b = f.binding;
    f.item.kind = "graph_task"; f.item.revision = 3; f.item.inputDigest = "e".repeat(64);
    f.item.currentTarget = { type: "role", id: "developer" };
    f.item.assignment = { graphTask: { sourceBinding: Object.fromEntries(
      ["kind", "rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"].map(key => [key, b[key]])) } };
    f.item.event = { schemaVersion: 1, eventId: b.eventId, contentDigest: b.eventDigest,
      occurredAt: CREATED_AT, eventType: "pull_request.updated", source: { provider: "github", scopeId: "test" },
      subject: { id: `github:pr:${b.repository}#${b.pullRequestNumber}`, repository: b.repository, number: b.pullRequestNumber },
      payload: { nextAction: "resolve_conflict", relation: "authored", headRefOid: b.headRefOid, gitTargetAvailable: true, gitTarget: b.gitTarget } };
    f.config.githubActions.automaticOwnPrRepair = variant !== "disabled";
    let reads = 0;
    f.service.conflictRepair.conflictInspectionReader = { async read(inputBinding) {
      reads += 1;
      if (variant === "base-drift") f.facts.baseRefOid = "9".repeat(40);
      return { inputBinding, conflicts: [{ path: "src/conflict.txt" }] };
    } };
    const request = { itemId: f.item.itemId, itemRevision: variant === "stale-item" ? 2 : 3, inputDigest: f.item.inputDigest };
    if (variant === "base-drift") {
      await assert.rejects(f.service.conflictRepair.prepareInspection(request), error => error.code === "OWN_PR_CONFLICT_TARGET_CHANGED");
    } else {
      assert.equal(await f.service.conflictRepair.readInspection(request), null);
      if (variant === "current") assert.equal(await f.service.shouldRun(f.item), true);
      else await f.service.conflictRepair.prepareInspection(request);
      const result = await f.service.conflictRepair.readInspection(request);
      assert.equal(result !== null, variant === "current", variant);
      if (variant === "current") {
        const detached = await f.service.conflictRepair.readInspection(request);
        detached.conflicts[0].path = "caller-mutated";
        assert.equal((await f.service.conflictRepair.readInspection(request)).conflicts[0].path, "src/conflict.txt");
        // A new claim may change the revision while immutable source binding stays exact.
        f.item.revision += 1;
        assert.equal(await f.service.conflictRepair.readInspection(request), null);
        assert.ok(await f.service.conflictRepair.readInspection({ ...request, itemRevision: f.item.revision }));
        f.config.githubActions.automaticOwnPrRepair = false;
        assert.equal(await f.service.conflictRepair.readInspection({ ...request, itemRevision: f.item.revision }), null);
      }
    }
    assert.equal(reads, ["current", "base-drift"].includes(variant) ? 1 : 0);
    assert.equal(syncs, reads);
    assert.equal(f.codeJobApprovalCount, 0); assert.equal(f.pushes.length, 0);
  }
});

test("own PR feedback creates and publishes an approved repair through the real confirmation and proposal pipeline", async () => {
  const f = await fixture();
  const transition = await f.deliver();
  assert.equal(transition.status, "running");
  assert.equal(f.jobs.size, 1, "code job is automatically approved without user input");
  assert.equal((await f.queue.get(transition.downstreamRef)).status, "completed");
  const evidence = f.completeJob();
  assert.equal(await f.service.shouldRun(f.item), false, "running repair suppresses duplicate decisions");
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].action.controlledCommitEvidence.evidenceId, evidence.evidenceId);
  assert.equal(f.pushes[0].action.inputBinding.gitTarget.headRefName, "fix/review-feedback");
  assert.deepEqual(f.pushes[0].action.controlledCommitEvidence.commit.parents, [f.binding.headRefOid]);
  assert.equal((await f.service.runCycle()).published, 1);
  const history = await f.queue.list();
  assert.deepEqual(history.items.map(({ automaticOwnPrRepair }) => automaticOwnPrRepair.stage).sort(), ["code_task", "push"]);
  assert.equal(await f.service.shouldRun(f.item), false);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "published");
  assert.equal(f.store.values.get(STATE_KEY).published.length, 1);
});

for (const isDraft of [false, true]) {
test(`automatic mode resolves and publishes own PR conflicts without an owner confirmation, including after restart (Draft=${isDraft})`, async () => {
  const f = await fixture({ conflict: true });
  f.facts.isDraft = isDraft;
  f.item.event.payload.isDraft = isDraft;
  f.facts.reviewFeedbackCount = 0;
  const transition = await f.deliver();
  assert.equal(transition.status, "running");
  assert.equal(f.jobs.size, 1);
  const evidence = f.completeJob();
  await f.restart();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.deepEqual(evidence.commit.parents, [f.binding.headRefOid, f.binding.gitTarget.baseRefOid]);
  await f.service.runCycle();
  await f.restart();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1, "the system never repeats the same publication after restart");
  const history = await f.queue.list();
  assert.equal(history.items.length, 2);
  assert.ok(history.items.every(row => row.status === "completed" && row.automaticOwnPrRepair));
});

}

test("conflict checks and verification start automatically for orchestrator-assigned owner PR work", async () => {
  for (const operation of ["inspect", "verify"]) {
    const f = await fixture({ conflict: true, operation });
    f.item.event = { ...f.item.event, source: { provider: "local-owner" }, eventType: "pull_request.owner_requested",
      payload: { nextAction: "resolve_conflict", workType: "general" } };
    f.context.author = null;
    assert.equal((await f.deliver()).status, "running");
    assert.equal(f.codeJobApprovalCount, 1);
    assert.equal(f.pushes.length, 0);
  }
});

test("automatic conflict recovery resumes settled capability and provider blocks while preserving owner controls", async () => {
  for (const code of ["CODE_BRAIN_COMPLETION_NOT_READY", "STRUCTURED_PROVIDER_RESPONSE_INVALID"]) {
    const recoveryKey = code === "STRUCTURED_PROVIDER_RESPONSE_INVALID" ? "providerResponseRecovery" : "largeActionRecovery";
    for (const changed of [null, "owner", "owner-reason", "unsettled", "unknown", "pending-action", "wrong-code", "active", "pending-command", "drift", "revoked", "disabled", "other-run"]) {
      let f, resumes = 0;
      const proof = { runId: "stopped-run", mode: "active", active: false, pendingCommand: null, stopUnconfirmed: false,
        receipt: { runId: "stopped-run", kind: "code-job", roleId: "developer", phase: "failed", stopConfirmed: true,
          outcomeCode: code, session: { transport: "app-server" },
          modelStartedAt: "2026-10-10T03:00:30.000Z", finishedAt: "2026-10-10T03:01:00.000Z" } };
      f = await fixture({ conflict: true, taskRuns: { async get() { return clone(proof); } },
        codeJobControl: { async resume({ jobId, expectedRevision }) {
          const job = f.details.get(jobId).job;
          assert.equal(job.revision, expectedRevision);
          resumes++; job.status = "active"; job.revision++; job.pause = null;
        } } });
      await f.deliver();
      const job = clone([...f.jobs.values()][0]);
      Object.assign(job, { status: "paused", revision: 12, pause: {
        reason: `等待人工处理（${code}）`, at: "2026-10-10T03:01:01.000Z" } });
      proof.receipt.taskId = job.jobId;
      f.details.set(job.jobId, { job });
      if (changed === "owner") proof.mode = "paused";
      if (changed === "owner-reason") job.pause.reason = "用户从本地指挥中枢暂停代码任务";
      if (changed === "unsettled") proof.receipt.stopConfirmed = false;
      if (changed === "unknown") job.uncertainty = { code: "unknown" };
      if (changed === "pending-action") job.pendingActionType = "write_text";
      if (changed === "wrong-code") proof.receipt.outcomeCode = "STRUCTURED_PROVIDER_TIMEOUT";
      if (changed === "active") proof.active = true;
      if (changed === "pending-command") proof.pendingCommand = "pause";
      if (changed === "drift") f.facts.headRefOid = "9".repeat(40);
      if (changed === "revoked") f.revokeGrant();
      if (changed === "disabled") f.config.githubActions.automaticOwnPrRepair = false;
      if (changed === "other-run") proof.runId = "different-run";
      if (changed === null) {
        const state = await f.store.read("automatic-own-pr-conflict-state");
        state.records[0].capabilityRecovery = { capability: "conflict-edit-and-source-v1", pausedRevision: 8, runId: "earlier-stopped-run" };
        await f.store.write("automatic-own-pr-conflict-state", state);
      }
      await f.restart();
      await f.service.runCycle();
      assert.equal(resumes, changed === null ? 1 : 0, String(changed));
      if (changed === null) {
        await f.restart(); await f.service.runCycle();
        assert.equal(resumes, 1);
        job.status = "paused"; job.revision++; job.pause = { reason: `等待人工处理（${code}）`, at: "2026-10-10T03:01:01.000Z" };
        await f.service.runCycle();
        assert.equal(resumes, 1, "a second block cannot replay the one-time capability recovery");
        const state = await f.store.read("automatic-own-pr-conflict-state");
        assert.equal(state.records[0][recoveryKey].pausedRevision, 12);
        assert.equal(state.records[0].capabilityRecovery.runId, "earlier-stopped-run", "retain the earlier recovery audit");
      }
      assert.equal(f.pushes.length, 0);
    }
  }
});

test("conflict automation rejects disabled mode, another author, changed targets and cleared conflicts", async () => {
  for (const change of [
    f => { f.config.githubActions.automaticOwnPrRepair = false; },
    f => { f.facts.author = "another-author"; },
    f => { f.facts.mergeStateStatus = "CLEAN"; },
    f => { f.item.event.payload.nextAction = "wait_review"; },
    f => { f.item.event.payload.relation = "review_requested"; },
    f => { f.revokeGrant(); },
  ]) {
    const f = await fixture({ conflict: true });
    change(f);
    assert.equal((await f.deliver()).status, "waiting_confirmation");
    assert.equal(f.codeJobApprovalCount, 0);
    assert.equal(f.pushes.length, 0);
  }
});

test("automatic owner conflict inspection retires its obsolete confirmation when the remote target advances", async () => {
  for (const field of ["headRefOid", "baseRefOid"]) {
    const f = await fixture({ conflict: true, operation: "inspect", enabled: false });
    const waiting = await f.deliver();
    assert.equal(waiting.status, "waiting_confirmation");
    f.config.githubActions.automaticOwnPrRepair = true;
    f.facts[field] = "9".repeat(40);
    assert.equal((await f.resume(waiting)).status, "stale");
    assert.equal((await f.queue.get(waiting.downstreamRef)).status, "stale");
    assert.equal(f.codeJobApprovalCount, 0);
  }
});

test("a conflict push with unknown remote outcome is never submitted again after restart", async () => {
  const f = await fixture({ conflict: true, pushOutcome: "unknown" });
  await f.deliver(); f.completeJob();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  await f.restart();
  await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(await f.service.shouldRun(f.item), false);
});

for (const conflict of [false, true]) {
  const stateKey = conflict ? "automatic-own-pr-conflict-state" : STATE_KEY;
  const rows = state => conflict ? state.records : state.repairs;
  test(`automatic push retries a confirmed absent timeout without another code job (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: attempt => attempt === 1 ? "absent" : "applied" });
    await f.deliver(); f.completeJob(); await f.service.runCycle();
    assert.equal(f.pushes.length, 1);
    // Recover records already terminalized by the previous runtime as well.
    const saved = await f.store.read(stateKey);
    rows(saved)[0].status = "failed";
    await f.store.write(stateKey, saved);
    await f.restart(); await f.service.runCycle(); await f.service.runCycle();
    assert.equal(f.pushes.length, 2);
    assert.equal(f.codeJobApprovalCount, 1);
    const record = rows(await f.store.read(stateKey))[0];
    assert.equal(record.status, "published");
    assert.equal(record.pushRetry.attempt, 1);
    assert.equal((await f.queue.get(record.pushConfirmationId)).status, "completed");
  });

  test(`automatic absent push retry budget survives cycles and restart (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: "absent" });
    await f.deliver(); f.completeJob(); await f.service.runCycle();
    for (let i = 0; i < 7; i += 1) { await f.restart(); await f.service.runCycle(); }
    assert.equal(f.pushes.length, 4, "one initial attempt and at most three retries");
    assert.equal(rows(await f.store.read(stateKey))[0].status, "failed");
  });

  for (const restart of [false, true]) {
    test(`retired absent push retries when current authority becomes valid again (conflict=${conflict}, restart=${restart})`, async () => {
      const f = await fixture({ conflict, pushOutcome: attempt => attempt === 1 ? "absent" : "applied" });
      await f.deliver(); f.completeJob(); await f.service.runCycle();
      const original = rows(await f.store.read(stateKey))[0];
      f.config.githubActions.automaticOwnPrRepair = false;
      await f.service.runCycle();
      assert.equal(rows(await f.store.read(stateKey))[0].status, "stale");
      if (restart) await f.restart();
      await f.service.runCycle();
      assert.equal(f.pushes.length, 1, "disabled automation cannot retry");
      f.config.githubActions.automaticOwnPrRepair = true;
      await f.service.runCycle(); await f.service.runCycle();
      const recovered = rows(await f.store.read(stateKey))[0];
      assert.equal(f.pushes.length, 2);
      assert.equal(f.codeJobApprovalCount, 1);
      assert.equal(recovered.status, "published");
      assert.equal(recovered.pushConfirmationId, original.pushConfirmationId);
      assert.equal(recovered.pushRetry.attempt, 1);
      await f.restart(); await f.service.runCycle();
      assert.equal(f.pushes.length, 2, "recovery cannot publish twice");
    });
  }

  test(`retired unknown pushes remain untouched (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: "unknown" });
    await f.deliver(); f.completeJob(); await f.service.runCycle();
    const saved = await f.store.read(stateKey);
    rows(saved)[0].status = "stale";
    await f.store.write(stateKey, saved);
    const original = await f.queue.get(rows(saved)[0].pushConfirmationId);
    await f.restart(); await f.service.runCycle(); await f.service.runCycle();
    assert.equal(f.pushes.length, 1);
    assert.deepEqual(await f.queue.get(original.id), original);
    assert.equal(rows(await f.store.read(stateKey))[0].status, "stale");
  });

  test(`failed push recovery rechecks the original code receipt after restart (conflict=${conflict})`, async (t) => {
    for (const proof of ["incomplete", "missing-receipt", "different-job"]) await t.test(proof, async () => {
      const f = await fixture({ conflict, pushOutcome: "absent" });
      await f.deliver(); f.completeJob(); await f.service.runCycle();
      const saved = await f.store.read(stateKey);
      const record = rows(saved)[0];
      record.status = "failed";
      await f.store.write(stateKey, saved); await f.restart();
      const get = f.service.confirmations.get;
      f.service.confirmations.get = async (...args) => {
        const item = await get(...args);
        if (item.id !== record.confirmationId) return item;
        if (proof === "incomplete") return { ...item, status: "pending", receipt: null };
        return { ...item, receipt: proof === "missing-receipt" ? null : { ...item.receipt, id: "code-job-different" } };
      };
      await f.service.runCycle(); await f.service.runCycle();
      assert.equal(f.pushes.length, 1);
      assert.equal(rows(await f.store.read(stateKey))[0].pushRetry, undefined);
    });
  });

  test(`still-disabled retired pushes do not rewrite their state (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: "absent" });
    await f.deliver(); f.completeJob(); await f.service.runCycle();
    f.config.githubActions.automaticOwnPrRepair = false;
    await f.service.runCycle();
    let writes = 0;
    const write = f.store.write.bind(f.store);
    f.store.write = async (key, value) => { if (key === stateKey) writes++; return write(key, value); };
    await f.service.runCycle(); await f.service.runCycle();
    assert.equal(f.pushes.length, 1);
    assert.equal(writes, 0);
  });

  test(`retry intent is replayed once after acknowledgement loss (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: attempt => attempt === 1 ? "absent" : "applied" });
    await f.deliver(); f.completeJob(); await f.service.runCycle();
    f.interruptRetry(); await f.service.runCycle();
    assert.equal(rows(await f.store.read(stateKey))[0].pushRetry.attempt, 1);
    await f.restart(); await f.service.runCycle(); await f.service.runCycle();
    assert.equal(f.pushes.length, 2);
    assert.equal(rows(await f.store.read(stateKey))[0].pushRetry.attempt, 1);
  });

  test(`unknown result after an automatic retry remains fenced (conflict=${conflict})`, async () => {
    const f = await fixture({ conflict, pushOutcome: attempt => attempt === 1 ? "absent" : "unknown" });
    await f.deliver(); f.completeJob(); await f.service.runCycle(); await f.service.runCycle();
    await f.restart(); await f.service.runCycle(); await f.service.runCycle();
    assert.equal(f.pushes.length, 2);
    assert.equal(await f.service.shouldRun(f.item), false);
  });

  test(`automatic retries recheck the target and current grant (conflict=${conflict})`, async () => {
    for (const change of [f => { f.config.githubActions.automaticOwnPrRepair = false; },
      f => { f.facts.headRefOid = "9".repeat(40); }, f => f.revokeGrant()]) {
      const f = await fixture({ conflict, pushOutcome: "absent" });
      await f.deliver(); f.completeJob(); await f.service.runCycle();
      change(f); await f.service.runCycle(); await f.restart(); await f.service.runCycle();
      assert.equal(f.pushes.length, 1);
    }
  });
}

test("target drift during object synchronization retires the obsolete conflict inspection", async () => {
  let f;
  f = await fixture({ conflict: true, operation: "inspect", objectSync: { async prepare() {
    f.facts.baseRefOid = "9".repeat(40);
  } } });
  assert.equal((await f.deliver()).status, "stale");
  assert.equal(f.codeJobApprovalCount, 0);
});

test("a changed Base revokes a completed conflict repair before automatic push", async () => {
  const f = await fixture({ conflict: true });
  await f.deliver(); f.completeJob();
  f.facts.baseRefOid = "9".repeat(40);
  assert.equal((await f.service.runCycle()).stale, 1);
  assert.equal(f.pushes.length, 0);
});

test("review feedback and conflict repair cannot start competing work on the same PR", async () => {
  for (const conflict of [false, true]) {
    const f = await fixture({ conflict });
    await f.deliver();
    f.item.event.payload.nextAction = conflict ? "address_review" : "resolve_conflict";
    assert.equal(await f.service.shouldRun(f.item), false);
    await f.restart();
    assert.equal(await f.service.shouldRun(f.item), false);
  }
});

test("interrupted automatic conflict approvals release obsolete code and push tasks after Base drift", async () => {
  for (const kind of ["local.code-job-create", "github.pull-request-push"]) {
    const f = await fixture({ conflict: true });
    if (kind === "local.code-job-create") {
      f.interruptApproval(kind);
      await assert.rejects(f.deliver(), /approval interrupted/);
    } else {
      await f.deliver(); f.completeJob();
      f.interruptApproval(kind);
      assert.equal((await f.service.runCycle()).failed, 1);
    }
    await f.restart();
    f.facts.baseRefOid = "9".repeat(40);
    assert.equal((await f.service.runCycle()).stale, 1);
    assert.equal(await f.service.shouldRun(f.item), true);
    const history = await f.queue.list();
    assert.equal(history.items.find(row => row.kind === kind).status, "stale");
    assert.equal(f.pushes.length, 0);
  }
});

test("automatic modification captures original complete feedback before approval and exposes its immutable binding after publication", async () => {
  const f = await fixture(); await f.deliver();
  const before = await f.store.read(STATE_KEY);
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.feedbackSnapshots.length, 0);
  const captured = (await f.store.read(originalRepairFeedbackArchiveKey(before.repairs[0].feedbackSnapshotId))).snapshot;
  assert.equal(captured.originalHeadRefOid, f.binding.headRefOid);
  assert.equal(captured.feedbackDigest, FEEDBACK_DIGEST);
  assert.equal(captured.provenance.kind, "captured_before_repair");
  f.completeJob(); await f.service.runCycle(); await f.service.runCycle();
  const published = (await f.store.read(STATE_KEY)).published[0];
  const original = await f.service.readOriginalFeedbackSnapshot({ snapshotId: published.feedbackSnapshotId,
    repository: f.binding.repository, number: f.binding.pullRequestNumber, feedbackDigest: FEEDBACK_DIGEST,
    originalHeadRefOid: f.binding.headRefOid });
  assert.equal(original.feedback.changeRequests[0].body, "Fix the reviewed race");
  f.facts.feedback.changeRequests[0].body = "a later live change";
  assert.equal((await f.service.readOriginalFeedbackSnapshot({ snapshotId: original.snapshotId,
    repository: f.binding.repository, number: f.binding.pullRequestNumber, feedbackDigest: FEEDBACK_DIGEST,
    originalHeadRefOid: f.binding.headRefOid })).feedback.changeRequests[0].body, "Fix the reviewed race");
  f.config.githubActions.automaticOwnPrRepair = false;
  const request = (await f.ownerWorkRequests.list()).items[0];
  const current = await f.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
  const reader = new OriginalRepairFeedbackReader({ store: f.store, executionContextReader: f.reviewLedger });
  const beforeRead = JSON.stringify(await f.store.read(STATE_KEY));
  const descriptor = await reader.readBinding({ inputBinding: currentWorkItemExecutionBinding(current), internalReview: request.request.internalReview });
  assert.equal(descriptor.snapshotId, original.snapshotId, "disabling new repairs cannot erase captured review evidence");
  assert.equal((await reader.read({ snapshotId: descriptor.snapshotId, repository: f.binding.repository,
    number: f.binding.pullRequestNumber, feedbackDigest: descriptor.feedbackDigest, originalHeadRefOid: descriptor.originalHeadRefOid })).feedbackDigest, FEEDBACK_DIGEST);
  assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), beforeRead, "independent review reader cannot write state");
});

test("published feedback reads do not wait for unrelated conflict reconciliation", async () => {
  const f = await fixture(); await f.deliver();
  f.completeJob(); await f.service.runCycle(); await f.service.runCycle();
  const request = (await f.ownerWorkRequests.list()).items[0];
  const current = await f.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
  const inputBinding = currentWorkItemExecutionBinding(current);
  f.context.inputBinding = inputBinding;
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  f.service.conflictRepair = { async runCycle() {
    entered.resolve(); await released.promise;
    return { scanned: 0, published: 0, failed: 0, stale: 0 };
  } };
  const cycle = f.service.runCycle();
  await entered.promise;
  const stateBefore = await f.store.read(STATE_KEY);
  const reading = f.service.readOriginalFeedbackBinding({ inputBinding, internalReview: request.request.internalReview });
  let timer;
  try {
    const descriptor = await Promise.race([reading,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 200); })]);
    assert.ok(descriptor, "sealed original feedback must be readable while another PR reconciliation is pending");
    assert.equal(descriptor.feedbackDigest, FEEDBACK_DIGEST);
    assert.deepEqual(await f.store.read(STATE_KEY), stateBefore, "the read cannot mutate repair state");
  } finally {
    clearTimeout(timer); released.resolve(); await cycle; await reading;
  }
  f.context.inputBinding = { ...inputBinding, headRefOid: "9".repeat(40),
    gitTarget: { ...inputBinding.gitTarget, headRefOid: "9".repeat(40) } };
  await assert.rejects(f.service.readOriginalFeedbackBinding({ inputBinding, internalReview: request.request.internalReview }),
    { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  f.context.inputBinding = inputBinding;
  await assert.rejects(f.service.readOriginalFeedbackBinding({ inputBinding,
    internalReview: { ...request.request.internalReview, feedbackDigest: "9".repeat(64) } }),
    { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
  const archiveKey = originalRepairFeedbackArchiveKey(stateBefore.published[0].feedbackSnapshotId);
  const archive = await f.store.read(archiveKey);
  archive.snapshot.feedback.changeRequests[0].body = "corrupt archive";
  await f.store.write(archiveKey, archive);
  await assert.rejects(f.service.readOriginalFeedbackBinding({ inputBinding, internalReview: request.request.internalReview }),
    { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
});

function historicalFeedbackState(count, bodyBytes = 32) {
  const feedbackSnapshots = Array.from({ length: count }, (_, index) => {
    const feedback = { changeRequests: [{ id: `historical-review-${index}`, author: "reviewer", body: `${index}:` + "x".repeat(bodyBytes) }], threads: [] };
    return createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 1_000 + index,
      context: { schemaVersion: 1, headRefOid: "a".repeat(40), reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
      provenance: { kind: "captured_before_repair", observedHeadRefOid: "a".repeat(40), observedAt: CREATED_AT } });
  });
  return { schemaVersion: 1, repairs: [], feedbackSnapshots, published: feedbackSnapshots.map((snapshot, index) => ({
    repository: snapshot.repository, number: snapshot.number, feedbackDigest: snapshot.feedbackDigest,
    feedbackSnapshotId: snapshot.snapshotId, feedbackFingerprints: [createHash("sha256").update(`historical-${index}`).digest("hex")],
    commitOid: "b".repeat(40), confirmationId: `historical-push-${index}`,
  })) };
}

for (const [name, count, bodyBytes] of [["round 129", 128, 32], ["16 MiB aggregate rollover", 15, 1024 * 1024]]) {
  test(`automatic modification admits ${name} while preserving every archived and active snapshot`, async () => {
    const f = await fixture();
    const legacy = historicalFeedbackState(count, bodyBytes);
    await f.store.write(STATE_KEY, legacy);
    await f.service.recover();
    const reader = new OriginalRepairFeedbackReader({ store: f.store });
    const before = JSON.stringify(await f.store.read(STATE_KEY));
    assert.deepEqual(await reader.read(legacy.feedbackSnapshots[0]), legacy.feedbackSnapshots[0]);
    assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), before, "legacy reads preserve inline state");
    if (bodyBytes > 32) {
      f.facts.feedback.changeRequests[0].body = "new round " + "n".repeat(bodyBytes);
      f.facts.reviewFeedbackDigest = ownReviewFeedbackDigest(f.facts.feedback);
      f.item.event.payload.reviewFeedbackDigest = f.facts.reviewFeedbackDigest;
      assert.ok(Buffer.byteLength(JSON.stringify(legacy.feedbackSnapshots)) + Buffer.byteLength(JSON.stringify(f.facts.feedback)) > 16 * 1024 * 1024);
    }
    assert.equal((await f.deliver()).status, "running");
    const state = await f.store.read(STATE_KEY);
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.feedbackSnapshots, []);
    assert.deepEqual(state.published.map(({ feedbackSnapshotArchive: _archive, ...row }) => row), legacy.published);
    assert.equal(state.repairs.length, 1);
    assert.equal(state.repairs[0].status, "working");
    f.config.githubActions.automaticOwnPrRepair = false;
    await f.restart();
    for (const snapshot of legacy.feedbackSnapshots) {
      assert.deepEqual(await reader.read(snapshot), snapshot);
      assert.deepEqual(await f.service.readOriginalFeedbackSnapshot(snapshot), snapshot);
    }
    const active = state.repairs[0].feedbackSnapshotArchive;
    assert.deepEqual((await reader.read(active)).feedback, f.facts.feedback);
    assert.equal([...f.store.values.keys()].filter((key) => key.startsWith("original-repair-feedback-record-")).length, count + 1);
  });
}

for (const failure of ["archive-before-write", "archive-lost-ack", "archive-readback", "state-before-write", "state-lost-ack"]) {
  test(`snapshot archival recovers ${failure} without a lost body or duplicate approval`, async () => {
    const store = new MemoryStore();
    const f = await fixture({ store });
    const originalRead = store.read.bind(store), originalWrite = store.write.bind(store);
    let armed = true, archiveWasWritten = false;
    store.write = async (key, value) => {
      const archive = key.startsWith("original-repair-feedback-record-");
      if (armed && ((failure === "archive-before-write" && archive) || (failure === "state-before-write" && key === STATE_KEY))) {
        armed = false; throw new Error(failure);
      }
      await originalWrite(key, value);
      if (archive) archiveWasWritten = true;
      if (armed && ((failure === "archive-lost-ack" && archive) || (failure === "state-lost-ack" && key === STATE_KEY))) {
        armed = false; throw new Error(failure);
      }
    };
    store.read = async (key, fallback) => {
      if (armed && failure === "archive-readback" && archiveWasWritten && key.startsWith("original-repair-feedback-record-")) {
        armed = false; throw new Error(failure);
      }
      return originalRead(key, fallback);
    };
    await assert.rejects(f.deliver(), new RegExp(failure));
    assert.equal(f.jobs.size, 0, "feedback must be verified before approval");
    const partial = await store.read(STATE_KEY, { repairs: [] });
    assert.equal(partial.repairs.length, failure === "state-lost-ack" ? 1 : 0);
    await f.restart();
    const resumed = await f.deliver();
    assert.equal(resumed.status, "running");
    assert.deepEqual(await f.deliver(), resumed);
    await f.restart();
    assert.equal((await store.read(STATE_KEY)).repairs.length, 1);
    assert.equal([...store.values.keys()].filter((key) => key.startsWith("original-repair-feedback-record-")).length, 1);
    assert.equal(f.jobs.size, 1);
    const reference = (await store.read(STATE_KEY)).repairs[0].feedbackSnapshotArchive;
    assert.deepEqual((await f.service.readOriginalFeedbackSnapshot(reference)).feedback, ORIGINAL_FEEDBACK);
  });
}

for (const failure of ["partial-archive-write", "partial-archive-readback", "migration-state-lost-ack"]) {
  test(`legacy multi-snapshot migration recovers ${failure} across a later-clock restart`, async () => {
    let now = CREATED_AT;
    const f = await fixture({ clock: () => new Date(now) });
    const legacy = historicalFeedbackState(3);
    await f.store.write(STATE_KEY, legacy);
    await f.service.recover();
    const inlineBytes = JSON.stringify(await f.store.read(STATE_KEY));
    const historicalKeys = legacy.feedbackSnapshots.map(({ snapshotId }) => originalRepairFeedbackArchiveKey(snapshotId));
    const firstKey = historicalKeys[0], interruptedKey = historicalKeys[1];
    const originalRead = f.store.read.bind(f.store), originalWrite = f.store.write.bind(f.store);
    const verifiedArchives = new Set(), archiveWrites = new Map();
    let armed = true, migrationPending = true;
    f.store.write = async (key, value) => {
      if (key.startsWith("original-repair-feedback-record-")) {
        if (migrationPending) assert.equal(JSON.stringify(await originalRead(STATE_KEY)), inlineBytes,
          "archive writes cannot release any historical inline body");
        if (armed && failure === "partial-archive-write" && key === interruptedKey) {
          assert.ok(verifiedArchives.has(firstKey), "interruption follows a durable, verified earlier archive");
          armed = false;
          throw new Error(failure);
        }
        await originalWrite(key, value);
        archiveWrites.set(key, (archiveWrites.get(key) ?? 0) + 1);
        return;
      }
      if (key === STATE_KEY && migrationPending) {
        assert.equal(JSON.stringify(await originalRead(STATE_KEY)), inlineBytes,
          "the old inline state remains byte-for-byte intact until migration commits");
        for (const row of [...value.repairs, ...value.published]) {
          assert.ok(verifiedArchives.has(originalRepairFeedbackArchiveKey(row.feedbackSnapshotId)),
            "every referenced archive must pass readback before committing the hot state");
        }
        assert.equal(value.published.length, legacy.published.length);
        assert.equal(value.repairs.length, 1);
        assert.deepEqual(value.feedbackSnapshots, []);
        migrationPending = false;
        await originalWrite(key, value);
        if (armed && failure === "migration-state-lost-ack") {
          armed = false;
          throw new Error(failure);
        }
        return;
      }
      return originalWrite(key, value);
    };
    f.store.read = async (key, fallback) => {
      const value = await originalRead(key, fallback);
      if (key.startsWith("original-repair-feedback-record-") && value) {
        if (armed && failure === "partial-archive-readback" && key === interruptedKey) {
          assert.ok(verifiedArchives.has(firstKey), "interruption follows a durable, verified earlier archive");
          armed = false;
          throw new Error(failure);
        }
        verifiedArchives.add(key);
      }
      return value;
    };
    await assert.rejects(f.deliver(), new RegExp(failure));
    assert.equal(armed, false, "the intended migration fault was reached");
    assert.equal(f.codeJobApprovalCount, 0, "partial migration cannot authorize a code job");
    assert.equal(f.jobs.size, 0);
    if (failure !== "migration-state-lost-ack") {
      assert.equal(JSON.stringify(await f.store.read(STATE_KEY)), inlineBytes);
    } else {
      assert.equal((await f.store.read(STATE_KEY)).schemaVersion, 2, "a lost acknowledgement retains the committed state");
    }
    const committedArchives = new Map([...f.store.values]
      .filter(([key]) => key.startsWith("original-repair-feedback-record-"))
      .map(([key, value]) => [key, JSON.stringify(value)]));
    assert.ok(committedArchives.has(firstKey));
    now = "2026-10-11T03:00:00.000Z";
    await f.restart();
    const resumed = await f.deliver();
    assert.equal(resumed.status, "running");
    assert.deepEqual(await f.deliver(), resumed);
    await f.restart();
    const migrated = await f.store.read(STATE_KEY);
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.feedbackSnapshots, []);
    assert.deepEqual(migrated.published.map(({ feedbackSnapshotArchive: _archive, ...row }) => row), legacy.published);
    const reader = new OriginalRepairFeedbackReader({ store: f.store });
    for (const [index, snapshot] of legacy.feedbackSnapshots.entries()) {
      assert.deepEqual(migrated.published[index].feedbackSnapshotArchive, originalRepairFeedbackArchiveReference(snapshot));
      assert.deepEqual(await reader.read(migrated.published[index].feedbackSnapshotArchive), snapshot);
      assert.deepEqual(await f.service.readOriginalFeedbackSnapshot(snapshot), snapshot);
    }
    const active = await reader.read(migrated.repairs[0].feedbackSnapshotArchive);
    assert.deepEqual(active.feedback, ORIGINAL_FEEDBACK);
    assert.equal(active.originalHeadRefOid, f.binding.headRefOid);
    assert.equal(active.provenance.observedAt, failure === "migration-state-lost-ack" ? CREATED_AT : now);
    assert.equal(migrated.repairs.length, 1);
    assert.equal(f.codeJobApprovalCount, 1, "restart and repeated delivery approve the new repair exactly once");
    assert.equal(f.jobs.size, 1);
    assert.equal(f.pushes.length, 0);
    for (const [key, bytes] of committedArchives) {
      assert.equal(JSON.stringify(await f.store.read(key)), bytes, "retry preserves each committed immutable archive byte-for-byte");
    }
    assert.ok([...archiveWrites.values()].every((count) => count === 1), "retry cannot rewrite an existing archive");
    assert.equal(archiveWrites.size, legacy.feedbackSnapshots.length + 1);
  });
}

test("a corrupt immutable feedback archive is never overwritten or approved", async () => {
  const f = await fixture();
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: f.binding.repository, number: f.binding.pullRequestNumber,
    context: { schemaVersion: 1, headRefOid: f.binding.headRefOid, reviewFeedbackDigest: FEEDBACK_DIGEST, feedback: ORIGINAL_FEEDBACK },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: f.binding.headRefOid, observedAt: CREATED_AT } });
  const key = originalRepairFeedbackArchiveKey(snapshot.snapshotId);
  const corrupt = clone(createOriginalRepairFeedbackArchiveRecord(snapshot));
  corrupt.snapshot.feedback.changeRequests[0].body = "different body with the old hash";
  await f.store.write(key, corrupt);
  const before = JSON.stringify(await f.store.read(key));
  await assert.rejects(f.deliver(), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  assert.equal(JSON.stringify(await f.store.read(key)), before);
  assert.equal(await f.store.read(STATE_KEY, null), null);
  assert.equal(f.jobs.size, 0);
});

test("new publication references require a verified archive and snapshots retain the 2 MiB body boundary", async () => {
  const f = await fixture();
  const snapshot = historicalFeedbackState(1).feedbackSnapshots[0];
  await assert.rejects(f.service.recordPublished({ repository: snapshot.repository, number: snapshot.number,
    feedbackDigest: snapshot.feedbackDigest, commitOid: "b".repeat(40), confirmationId: "missing-archive-publication",
    feedbackSnapshotId: snapshot.snapshotId, feedbackSnapshotArchive: originalRepairFeedbackArchiveReference(snapshot) }),
  { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  assert.equal(await f.store.read(STATE_KEY, null), null);
  const feedback = { changeRequests: [{ id: "oversized", author: "reviewer", body: "x".repeat(2 * 1024 * 1024) }], threads: [] };
  assert.throws(() => createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 42,
    context: { schemaVersion: 1, headRefOid: "a".repeat(40), reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: "a".repeat(40), observedAt: CREATED_AT } }),
  { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
});

for (const matched of [true, false]) {
  test(`legacy original feedback recovery ${matched ? "preserves exact digest and separate observed Head" : "fails closed on changed original requests"}`, async () => {
    const f = await fixture(); f.pauseReviewDelivery(); await f.deliver(); f.completeJob();
    await f.service.runCycle(); await f.service.runCycle();
    const state = await f.store.read(STATE_KEY); state.feedbackSnapshots = [];
    for (const entry of [...state.repairs, ...state.published]) { delete entry.feedbackSnapshotId; delete entry.feedbackSnapshotArchive; }
    await f.store.write(STATE_KEY, state); await f.restart();
    if (!matched) f.service.historicalRepairFeedbackReader = { async read({ inputBinding, feedbackDigest }) {
      return { context: { schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest,
        feedback: { changeRequests: [{ ...ORIGINAL_FEEDBACK.changeRequests[0], body: "a different defect" }], threads: [] } },
        provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: f.facts.headRefOid, observedAt: CREATED_AT } };
    } };
    f.pauseReviewDelivery(false); const result = await f.service.runCycle(); const recovered = await f.store.read(STATE_KEY);
    if (matched) {
      assert.equal(result.reviewDelivered, 1, "the first recovery cycle records its successful internal intake");
      assert.equal(result.reviewPending, undefined);
      assert.equal(result.lastReviewFailure, undefined);
      assert.equal(recovered.published[0].reviewDelivery.status, "completed");
      const snapshot = (await f.store.read(originalRepairFeedbackArchiveKey(recovered.published[0].feedbackSnapshotId))).snapshot;
      assert.equal(snapshot.originalHeadRefOid, f.binding.headRefOid);
      assert.equal(snapshot.provenance.observedHeadRefOid, f.facts.headRefOid);
      assert.notEqual(snapshot.originalHeadRefOid, snapshot.provenance.observedHeadRefOid);
      assert.equal(snapshot.feedbackDigest, FEEDBACK_DIGEST);
      const requests = (await f.ownerWorkRequests.list()).items;
      assert.equal(requests.length, 1);
      await f.restart();
      await f.service.runCycle();
      assert.equal((await f.store.read(STATE_KEY)).published[0].reviewDelivery.status, "completed");
      assert.deepEqual((await f.ownerWorkRequests.list()).items, requests, "restart cannot repeat an already completed intake");
    } else {
      assert.equal(result.lastReviewFailure, "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID");
      assert.equal(recovered.feedbackSnapshots.length, 0); assert.equal((await f.ownerWorkRequests.list()).items.length, 0);
    }
    assert.equal(f.pushes.length, 1);
  });
}

test("a repeated delivery and restart reuse the same repair and never publish twice", async () => {
  const f = await fixture();
  const first = await f.deliver();
  assert.deepEqual(await f.deliver(), first);
  f.completeJob();
  await f.service.runCycle();
  await f.restart();
  await f.service.runCycle();
  await f.service.runCycle();
  assert.equal(f.jobs.size, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.store.values.get(STATE_KEY).published.length, 1);
  assert.equal(await f.service.shouldRun(f.item), false);
});

test("published repair enters the real internal PR engineer intake exactly once across restart and lost acknowledgement", async () => {
  const f = await fixture(); await f.deliver(); const evidence = f.completeJob();
  await f.service.runCycle(); f.loseReviewAcknowledgement();
  const reconciliation = await f.service.runCycle();
  assert.equal(f.store.values.get(STATE_KEY).published[0].reviewDelivery.status, "pending");
  const before = await f.ownerWorkRequests.list();
  assert.equal(before.items.length, 1, JSON.stringify(reconciliation));
  assert.equal(before.items[0].assignment.target.id, "pr-engineer");
  assert.equal(before.items[0].request.internalReview.headRefOid, evidence.commit.oid);
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  const after = await f.ownerWorkRequests.list();
  assert.equal(after.items.length, 1, "normal owner request idempotency owns dispatch recovery");
  assert.equal(after.items[0].workItemId, before.items[0].workItemId);
  assert.equal(f.store.values.get(STATE_KEY).published[0].reviewDelivery.status, "completed");
  const item = await f.reviewLedger.readItemForReconciliation({ itemId: after.items[0].workItemId });
  assert.equal(item.source.current.event.source.provider, "internal-review-repair");
  assert.equal(item.source.current.event.eventType, "pull_request.internal_review_requested");
  assert.equal(f.pushes.length, 1);
  await assert.rejects(f.ownerWorkRequests.submit(after.items[0].request), { code: "OWNER_WORK_REQUEST_INTERNAL_ONLY" });
});

for (const [name, drift, reason] of [
  ["policy disabled", (f) => { f.config.githubActions.automaticOwnPrRepair = false; }, "automation_disabled"],
  ["Head replaced", (f) => { f.facts.headRefOid = "9".repeat(40); }, "head_changed"],
  ["PR closed", (f) => { f.facts.state = "closed"; }, "pull_request_closed"],
  ["PR Draft", (f) => { f.facts.isDraft = true; }, "pull_request_draft"],
]) {
  test(`pending internal repair review settles when ${name} without repushing`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(); await f.service.runCycle();
    f.loseReviewAcknowledgement(); await f.service.runCycle(); drift(f);
    await f.restart(); await f.service.runCycle();
    const delivery = f.store.values.get(STATE_KEY).published[0].reviewDelivery;
    assert.equal(delivery.status, "stale"); assert.equal(delivery.reason, reason);
    assert.equal(f.pushes.length, 1);
  });
}

test("legacy publication only recovers review for the exact verified live Head and preserves archived rows", async () => {
  const f = await fixture(); f.pauseReviewDelivery(); await f.deliver(); f.completeJob();
  await f.service.runCycle(); await f.service.runCycle();
  const state = await f.store.read(STATE_KEY);
  delete state.published[0].reviewDelivery;
  const archived = { repository: f.binding.repository, number: f.binding.pullRequestNumber,
    feedbackDigest: "8".repeat(64), commitOid: "9".repeat(40), confirmationId: "archived-unavailable-push" };
  state.published.unshift(archived);
  await f.store.write(STATE_KEY, state);
  f.pauseReviewDelivery(false); await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  const recovered = await f.store.read(STATE_KEY);
  assert.deepEqual(recovered.published[0], archived);
  assert.equal(recovered.published[1].reviewDelivery.status, "completed");
  assert.equal((await f.ownerWorkRequests.list()).items.length, 1);
  assert.equal(f.pushes.length, 1);
});

async function historicalOwnerPublicationFixture({ store = new MemoryStore() } = {}) {
  const f = await fixture({ store });
  await f.deliver();
  const evidence = f.completeJob();
  const grant = f.grant;
  const pushProposal = normalizeBoundWorkProposal({
    proposalId: "old-owner-repair-push", policyVersion: grant.policyVersion,
    kind: "github_pull_request_action_proposal", requestedBy: grant.requestedBy, source: grant.source,
    binding: { eventId: grant.source.eventId, subject: grant.subject,
      repository: grant.repository, pullRequestNumber: grant.inputBinding.pullRequestNumber,
      headRefOid: grant.inputBinding.headRefOid, inputBinding: grant.inputBinding },
    payload: { action: { type: "push", controlledCommitEvidence: evidence },
      summary: "Old repair push", reason: "Owner sealed this historical attempt", evidence: [] },
  });
  const sealed = await f.queue.enqueue(createPullRequestExternalActionConfirmationPlan(pushProposal,
    { actorAccountId: f.config.githubActions.actorAccountId }));
  await f.queue.reject(sealed.id, { requestId: "seal-old-publication",
    expectedQueueRevision: sealed.queueRevision, expectedItemRevision: sealed.itemRevision,
    displayedPayloadDigest: sealed.displayedPayloadDigest, approvalBindingDigest: sealed.approvalBindingDigest,
    reason: "Do not retry the old publication" });
  const state = await f.store.read(STATE_KEY);
  state.repairs[0].status = "failed";
  state.repairs[0].pushConfirmationId = sealed.id;
  delete state.repairs[0].feedbackSnapshotId;
  delete state.repairs[0].feedbackSnapshotArchive;
  state.feedbackSnapshots = [];
  await f.store.write(STATE_KEY, state);
  await f.service.recover();
  const publication = { repository: f.binding.repository, number: f.binding.pullRequestNumber,
    feedbackDigest: FEEDBACK_DIGEST, commitOid: evidence.commit.oid,
    confirmationId: "owner-publication-12345678-1234-4123-8123-123456789abc" };
  await f.service.recordPublished(publication);
  const request = { eventId: `code-job-change-package-event-${"d".repeat(64)}`,
    eventDigest: "d".repeat(64), packageId: evidence.package.packageId,
    packageDigest: evidence.package.packageDigest, executionSource: evidence.executionSource,
    recordedAt: evidence.createdAt };
  const receipt = createChangePackageControlledCommitReceipt(request, evidence);
  await f.store.write("change-package-controlled-commits", { schemaVersion: 1, revision: 1,
    deliveries: [{ request, status: "committed", evidenceId: evidence.evidenceId, receipt }] });
  f.facts.headRefOid = evidence.commit.oid;
  await f.restart();
  return { f, evidence, publication, request, receipt, sealed,
    originalRepairs: clone((await f.store.read(STATE_KEY)).repairs),
    originalQueue: clone(await f.store.read("confirmation-queue")) };
}

test("disk-backed historical owner publication recovers internal review without retrying a sealed push", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "owner-publication-review-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const { f, evidence, publication, receipt, originalRepairs, originalQueue } =
    await historicalOwnerPublicationFixture({ store: new StateStore(directory) });
  const result = await f.service.runCycle();
  assert.equal(result.reviewDelivered, 1, JSON.stringify(result));
  const state = await f.store.read(STATE_KEY);
  assert.equal(state.published[0].publicationProvenance.kind, "observed_owner_publication");
  assert.equal(state.published[0].publicationProvenance.publicationId, publication.confirmationId);
  assert.deepEqual(state.published[0].publicationProvenance.controlledCommitReceipt, receipt);
  assert.equal(state.published[0].reviewDelivery.status, "completed");
  assert.deepEqual(state.repairs, originalRepairs);
  assert.deepEqual(await f.store.read("confirmation-queue"), originalQueue);
  assert.equal(f.pushes.length, 0);
  const accepted = (await f.ownerWorkRequests.list()).items;
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].assignment.target.id, "pr-engineer");
  assert.equal(accepted[0].request.internalReview.controlledCommitEvidenceId, evidence.evidenceId);
  await f.restart();
  await f.service.runCycle();
  assert.deepEqual((await f.ownerWorkRequests.list()).items, accepted);
  const current = await f.reviewLedger.readItemForReconciliation({ itemId: accepted[0].workItemId });
  f.config.githubActions.automaticOwnPrRepair = false;
  const reader = new OriginalRepairFeedbackReader({ store: new StateStore(directory), executionContextReader: f.reviewLedger });
  const descriptor = await reader.readBinding({ inputBinding: currentWorkItemExecutionBinding(current),
    internalReview: accepted[0].request.internalReview });
  const snapshot = await reader.read({ ...descriptor, repository: f.binding.repository, number: f.binding.pullRequestNumber });
  assert.deepEqual(snapshot.feedback, ORIGINAL_FEEDBACK);
  assert.equal(snapshot.originalHeadRefOid, f.binding.headRefOid);
  assert.equal(snapshot.provenance.observedHeadRefOid, evidence.commit.oid);
});

for (const failure of ["publication-before-write", "publication-lost-ack", "intake-lost-ack"]) {
  test(`historical owner publication resumes ${failure} with one internal intake and preserved seals`, async () => {
    const { f, originalQueue, originalRepairs } = await historicalOwnerPublicationFixture();
    const write = f.store.write.bind(f.store);
    let armed = true;
    if (failure === "intake-lost-ack") f.loseReviewAcknowledgement();
    else f.store.write = async (key, value) => {
      if (armed && key === STATE_KEY && value.published[0].publicationProvenance) {
        armed = false;
        const row = value.published[0];
        assert.equal(row.reviewDelivery.status, "pending", "provenance and delivery intent commit together");
        assert.ok(await f.store.read(originalRepairFeedbackArchiveKey(row.feedbackSnapshotId)), "the original body must already be durable");
        if (failure === "publication-before-write") throw new Error(failure);
        await write(key, value);
        throw new Error(failure);
      }
      return write(key, value);
    };
    const first = await f.service.runCycle();
    assert.equal(first.reviewPending, 1);
    const beforeRestart = (await f.ownerWorkRequests.list()).items;
    assert.equal(beforeRestart.length, failure === "intake-lost-ack" ? 1 : 0);
    await f.restart();
    await f.ownerWorkRequests.recover();
    await f.service.runCycle();
    await f.service.runCycle();
    const state = await f.store.read(STATE_KEY);
    assert.equal(state.published[0].reviewDelivery.status, "completed");
    const requests = (await f.ownerWorkRequests.list()).items;
    assert.equal(requests.length, 1);
    if (beforeRestart.length) assert.equal(requests[0].workItemId, beforeRestart[0].workItemId);
    assert.deepEqual(state.repairs, originalRepairs);
    assert.deepEqual(await f.store.read("confirmation-queue"), originalQueue);
    assert.equal(f.pushes.length, 0);
  });
}

for (const [name, drift] of [
  ["current author changed", async ({ f }) => { f.facts.author = "another-author"; }],
  ["current Head changed", async ({ f }) => { f.facts.headRefOid = "8".repeat(40); }],
  ["committed delivery missing", async ({ f }) => {
    await f.store.write("change-package-controlled-commits", { schemaVersion: 1, revision: 0, deliveries: [] });
  }],
  ["committed delivery ambiguous", async ({ f }) => {
    const evidence = controlledCommit(f.grant, { modified: [{ path: "src/value.js", beforeSha256: "f".repeat(64), content: Buffer.from("other fix\n") }] });
    const request = { eventId: `code-job-change-package-event-${"e".repeat(64)}`, eventDigest: "e".repeat(64),
      packageId: evidence.package.packageId, packageDigest: evidence.package.packageDigest,
      executionSource: evidence.executionSource, recordedAt: evidence.createdAt };
    const state = await f.store.read("change-package-controlled-commits");
    state.deliveries.push({ request, status: "committed", evidenceId: evidence.evidenceId,
      receipt: createChangePackageControlledCommitReceipt(request, evidence) });
    state.revision += 1;
    await f.store.write("change-package-controlled-commits", state);
  }],
  ["package receipt changed", async ({ f }) => {
    const state = await f.store.read("change-package-controlled-commits");
    state.deliveries[0].receipt.packageId = `change-package-${"f".repeat(64)}`;
    await f.store.write("change-package-controlled-commits", state);
  }],
  ["original source binding changed", async ({ f }) => {
    const state = await f.store.read("change-package-controlled-commits");
    state.deliveries[0].request.executionSource.inputBinding.inputRevision += 1;
    await f.store.write("change-package-controlled-commits", state);
  }],
  ["sealed evidence missing", async ({ f, evidence }) => { f.verified.delete(evidence.evidenceId); }],
  ["sealed evidence belongs to another job", async ({ f, evidence }) => {
    f.verified.set(evidence.evidenceId, controlledCommit(f.grant, {
      job: { id: "code-job-other", revision: 7, recordDigest: "9".repeat(64) },
    }));
  }],
  ["job history changed", async ({ f }) => { f.details.get(codeJobIdForGrant(f.grant)).job.jobId = "code-job-other"; }],
  ["job status unknown", async ({ f }) => { f.details.get(codeJobIdForGrant(f.grant)).job.status = "unknown"; }],
  ["job Head binding changed", async ({ f }) => { f.details.get(codeJobIdForGrant(f.grant)).job.inputBinding.inputRevision += 1; }],
  ["original feedback changed", async ({ f }) => {
    f.service.historicalRepairFeedbackReader = { async read({ inputBinding, feedbackDigest }) {
      return { context: { schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest,
        feedback: { changeRequests: [{ ...ORIGINAL_FEEDBACK.changeRequests[0], body: "another defect" }], threads: [] } },
      provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: f.facts.headRefOid, observedAt: CREATED_AT } };
    } };
  }],
  ["repair history missing", async ({ f }) => {
    const state = await f.store.read(STATE_KEY); state.repairs = []; await f.store.write(STATE_KEY, state); await f.service.recover();
  }],
  ["repair history ambiguous", async ({ f }) => {
    const state = await f.store.read(STATE_KEY); state.repairs.push({ ...state.repairs[0], jobId: "code-job-another" });
    await f.store.write(STATE_KEY, state); await f.service.recover();
  }],
  ["unknown publication source", async ({ f }) => {
    const state = await f.store.read(STATE_KEY); state.published[0].confirmationId = "unrecognized-offline-record";
    await f.store.write(STATE_KEY, state); await f.service.recover();
  }],
  ["historical reader unavailable", async ({ f }) => { f.service.historicalControlledCommitReader = null; }],
]) {
  test(`historical owner review fails closed when ${name}`, async () => {
    const scenario = await historicalOwnerPublicationFixture();
    const { f } = scenario;
    await drift(scenario);
    const stateBefore = clone(await f.store.read(STATE_KEY));
    await f.service.runCycle();
    const stateAfter = await f.store.read(STATE_KEY);
    assert.deepEqual(stateAfter, stateBefore);
    assert.deepEqual(await f.store.read("confirmation-queue"), scenario.originalQueue);
    assert.equal((await f.ownerWorkRequests.list()).items.length, 0);
    assert.equal(f.pushes.length, 0);
  });
}

test("persisted historical owner provenance rejects drift from its repair and feedback archive", async () => {
  const { f } = await historicalOwnerPublicationFixture();
  await f.service.runCycle();
  const valid = await f.store.read(STATE_KEY);
  for (const change of [
    (state) => { state.published[0].publicationProvenance.inputBinding.inputRevision += 1; },
    (state) => { state.published[0].publicationProvenance.jobId = "code-job-other"; },
    (state) => { state.published[0].publicationProvenance.controlledCommitReceipt.evidenceId = `controlled-git-commit-${"a".repeat(64)}`; },
    (state) => { state.repairs[0].feedbackDigest = "a".repeat(64); },
  ]) {
    const corrupt = clone(valid); change(corrupt);
    await f.store.write(STATE_KEY, corrupt);
    await assert.rejects(f.service.recover());
    assert.deepEqual(await f.store.read(STATE_KEY), corrupt, "recovery cannot rewrite corrupt provenance");
  }
  await f.store.write(STATE_KEY, valid);
  await f.service.recover();
});

test("disk-backed repair delivery resumes a lost acknowledgement through durable normal request intake", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "repair-review-delivery-"));
  t.after(async () => {
    assert.equal(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep), true);
    await rm(directory, { recursive: true, force: true });
  });
  const f = await fixture({ store: new StateStore(directory) });
  await f.deliver(); f.completeJob(); await f.service.runCycle();
  f.loseReviewAcknowledgement(); await f.service.runCycle();
  const accepted = (await f.ownerWorkRequests.list()).items[0];
  await f.restart(); await f.ownerWorkRequests.recover(); await f.service.runCycle();
  const state = await new StateStore(directory).read(STATE_KEY);
  assert.equal(state.published[0].reviewDelivery.status, "completed");
  assert.equal(state.published[0].reviewDelivery.workItemId, accepted.workItemId);
  assert.equal((await f.ownerWorkRequests.list()).items.length, 1);
  assert.equal(f.pushes.length, 1);
});

for (const needsRepair of [false, true]) {
  test(`real internal PR review ${needsRepair ? "returns defects to development" : "completes locally"} without a self-review confirmation`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob();
    await f.service.runCycle(); await f.service.runCycle();
    const request = (await f.ownerWorkRequests.list()).items[0];
    const queued = await f.reviewLedger.readItemForReconciliation({ itemId: request.workItemId });
    const claimed = await f.reviewLedger.claim({ itemId: queued.itemId, expectedRevision: queued.revision,
      workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
    const packet = await new RoleContextAssembler({ graphReader: f.reviewLedger.graphReader,
      originalRepairFeedbackReader: new OriginalRepairFeedbackReader({ store: f.store, executionContextReader: f.reviewLedger }),
      pullRequestContextReader: { async read() { return { schemaVersion: 1, identityDigest: "a".repeat(64), contentDigest: "b".repeat(64),
        materialDigest: "c".repeat(64),
        observedAt: CREATED_AT, summary: {}, comments: [], reviews: [], reviewThreads: [], checks: [], contextTruncated: false,
        reviewMaterial: { schemaVersion: 1, gitTarget: { ...f.binding.gitTarget, headRefOid: request.request.internalReview.headRefOid },
          additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false, patch: "", patchTruncated: false } }; } },
    }).assemble({
      roleId: "pr-engineer", item: claimed, trigger: "assigned" });
    const evidence = internalReviewEvidence(request.request.internalReview);
    const intent = { schemaVersion: 1, type: needsRepair ? "handoff" : "complete",
      summary: needsRepair ? "A remaining defect needs repair" : "Internal static review completed",
      reason: "Assessed the bound repair; recorded actual verification coverage separately", evidence,
      ...(needsRepair ? { capability: "development", brief: "The bound repair still has a concrete race; add a regression for that condition" }
        : { outcome: "done" }) };
    const engine = new RoleDecisionEngine({
      definition: { id: "pr-engineer", name: "PR engineer", mission: "Assess repair", enabled: true },
      permissions: { allowedIntents: ["complete", "handoff", "propose_github_review"] },
      brain: { provider: "synthetic", model: "fixture", remoteData: { code: false, memory: false, requirements: false } },
      brainRouter: { describe: () => ({ singleAttempt: true, supportsReviewReading: true }), async generate(input) {
        assert.deepEqual(input.reviewTarget.feedbackSnapshot, { taskId: claimed.itemId, materialDigest: "c".repeat(64) });
        return JSON.stringify({ schemaVersion: 1, summary: intent.summary, confidence: 90, intent });
      } },
    });
    const decision = await engine.decide({ item: claimed, context: packet.context });
    await f.reviewLedger.stageIntent({ itemId: claimed.itemId, expectedRevision: claimed.revision,
      leaseId: claimed.leaseId, actorId: "employee-pr-engineer", roleId: "pr-engineer", intent: decision.intent });
    const dispatcher = new WorkIntentDispatcher({ ledger: f.reviewLedger,
      policy: createWorkIntentPolicy({ capabilityRoles: { development: "developer" } }),
      attentionProducer: { async create() { assert.fail("internal review must not create an attention request"); } },
      proposalProducer: { async create() { assert.fail("internal review must not create a GitHub proposal"); } },
      clock: () => new Date(CREATED_AT) });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.delivered, 1, JSON.stringify(result));
    const completed = await f.reviewLedger.readItemForReconciliation({ itemId: claimed.itemId });
    assert.equal(completed.status, needsRepair ? "queued" : "completed");
    if (needsRepair) assert.equal(completed.currentTarget.id, "developer");
    assert.equal((await f.queue.list()).items.length, 2, "only the original controlled code and push confirmations exist");
    assert.equal((await dispatcher.dispatchPending()).scanned, 0);
    assert.equal(f.pushes.length, 1);
  });
}

test("a crash after recording the code intent resumes approval without a second developer decision", async () => {
  const f = await fixture();
  const approve = f.queue.approve.bind(f.queue);
  f.queue.approve = async () => { throw new Error("simulated pre-approval crash"); };
  await assert.rejects(f.deliver(), /simulated pre-approval crash/);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "working");
  f.queue.approve = approve;
  await f.service.runCycle();
  assert.equal(f.jobs.size, 1);
});

test("disabled auto repair leaves the original explicit confirmation path intact", async () => {
  const f = await fixture({ enabled: false });
  const transition = await f.deliver();
  assert.equal(transition.status, "waiting_confirmation");
  assert.equal(f.jobs.size, 0);
  assert.equal((await f.queue.get(transition.downstreamRef)).status, "pending");
  assert.equal((await f.service.runCycle()).scanned, 0);
  assert.equal(f.pushes.length, 0);
});

for (const [name, drift] of [
  ["switch disabled", (f) => { f.config.githubActions.automaticOwnPrRepair = false; }],
  ["head replaced", (f) => { f.facts.headRefOid = "9".repeat(40); }],
  ["author replaced", (f) => { f.facts.author = "different-author"; }],
  ["feedback changed", (f) => { f.facts.reviewFeedbackDigest = "a".repeat(64); }],
  ["PR closed", (f) => { f.facts.state = "closed"; }],
]) {
  test(`completed repair is not pushed when ${name}`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(); drift(f);
    assert.equal((await f.service.runCycle()).stale, 1);
    await f.service.runCycle();
    assert.equal(f.pushes.length, 0);
  });
}

test("controlled evidence belonging to another job never produces a push", async () => {
  const f = await fixture(); await f.deliver();
  f.completeJob({ job: { id: "code-job-another", revision: 7, recordDigest: "9".repeat(64) } });
  const result = await f.service.runCycle();
  assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
  assert.equal(f.pushes.length, 0);
});

test("completed repair cannot publish after its versioned code authority was revoked", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob(); f.revokeGrant();
  assert.equal((await f.service.runCycle()).stale, 1);
  assert.equal(f.pushes.length, 0);
});

test("the push executor rechecks versioned code authority after its plan was saved", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob();
  const approve = f.queue.approve.bind(f.queue);
  f.queue.approve = async () => { throw new Error("paused before push approval"); };
  await f.service.runCycle();
  const pushId = f.store.values.get(STATE_KEY).repairs[0].pushConfirmationId;
  f.revokeGrant();
  const push = await f.queue.get(pushId);
  assert.equal(await f.service.verifyPush({ ...push, action: push.display.payload.action }), false);
  f.queue.approve = approve;
  assert.equal(f.pushes.length, 0);
});

for (const [name, wrongPackage] of [
  ["another grant", { grant: { digest: "8".repeat(64) } }],
  ["another proposal", { proposal: { id: "another-proposal", contentDigest: "8".repeat(64) } }],
]) {
  test(`controlled evidence for the same job but ${name} never produces a push`, async () => {
    const f = await fixture(); await f.deliver(); f.completeJob(wrongPackage);
    const result = await f.service.runCycle();
    assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
    assert.equal(f.pushes.length, 0);
  });
}

test("passing an unrelated profile cannot satisfy the approved required profile", async () => {
  const f = await fixture(); await f.deliver();
  f.completeJob({ passedProfiles: [{
    id: "lint-only", configDigest: "8".repeat(64), workspaceRevision: "b".repeat(64),
    actionId: "action-lint-only", attemptNumber: 1, imageId: "sha256:image-lint-only",
    artifacts: Object.fromEntries(["output", "stdout", "stderr"].map((kind) => [kind, {
      path: `repair/lint-only/${kind}.json`, sha256: "8".repeat(64), bytes: 12,
    }])),
  }] });
  const result = await f.service.runCycle();
  assert.equal(result.lastFailure, "OWN_PR_REPAIR_COMMIT_INVALID");
  assert.equal(f.pushes.length, 0);
});

test("an unknown push outcome is never automatically replayed across cycles or restart", async () => {
  const f = await fixture({ pushOutcome: "unknown" }); await f.deliver(); f.completeJob();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  const pushId = f.store.values.get(STATE_KEY).repairs[0].pushConfirmationId;
  const push = await f.queue.get(pushId);
  assert.equal(push.status, "failed");
  assert.equal(push.failure.outcome, "unknown");
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.store.values.get(STATE_KEY).published.length, 0);
  assert.equal(await f.service.shouldRun(f.item), false, "unknown publication keeps duplicate repair fenced");
});

test("restart reconstructs a durably saved push intent after a crash before enqueue", async () => {
  const f = await fixture(); await f.deliver(); f.completeJob(); f.crashBeforePushQueueWrite();
  const failed = await f.service.runCycle();
  assert.equal(failed.lastFailure, "TEST_ENQUEUE_CRASH");
  const intent = clone(f.store.values.get(STATE_KEY).repairs[0]);
  assert.equal(intent.status, "pushing");
  assert.equal(typeof intent.pushConfirmationId, "string");
  assert.equal(f.pushes.length, 0);
  await f.restart(); await f.service.runCycle(); await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].id, intent.pushConfirmationId);
  assert.equal(f.store.values.get(STATE_KEY).repairs[0].status, "published");
});


test("admitted owner CI repair prepares and publishes current conflicts without changing its requested action", async () => {
  let reads = 0;
  const f = await fixture({ conflict: true, ownerRequestedCi: true, objectSync: { async prepare() {} },
    conflictInspectionReader: { async read(inputBinding) {
      reads++;
      return { inputBinding, preparationBinding: externalActionControlledCommit(inputBinding).executionSource.preparationBinding,
        conflicts: [{ path: "src/conflict.txt" }] };
    } },
  });
  const b = f.binding, event = f.item.source.current.event;
  Object.assign(f.item, { revision: 3, inputDigest: b.inputDigest });
  Object.assign(f.item.source, { workKey: b.workKey, activeRevision: b.inputRevision, pendingRevision: null,
    revisions: Array.from({ length: b.inputRevision }, () => ({ headRevision: b.headRevision })),
    current: { event, headRefOid: b.headRefOid, eventId: b.eventId, eventDigest: b.eventDigest, inputDigest: b.inputDigest } });
  assert.equal(await f.service.shouldRun(f.item), true);
  assert.equal(reads, 1, "a conflicting owner CI task needs the same sealed conflict material as other repair work");
  const request = { itemId: f.item.itemId, itemRevision: f.item.revision, inputDigest: f.item.inputDigest };
  for (const variant of ["author", "head", "base", "clean", "context-author", "paused", "blocked", "scope", "inactive", "pending", "quarantined"]) {
    const facts = clone(f.facts), item = clone(f.item), author = f.context.author;
    if (variant === "author") f.facts.author = "another-author";
    if (variant === "head") f.facts.headRefOid = "9".repeat(40);
    if (variant === "base") f.facts.baseRefOid = "9".repeat(40);
    if (variant === "clean") f.facts.mergeStateStatus = "CLEAN";
    if (variant === "context-author") f.context.author = "another-author";
    if (variant === "paused") f.item.status = "paused";
    if (variant === "blocked") f.item.status = "blocked";
    if (variant === "scope") f.item.source.scope.kind = "automatic";
    if (variant === "inactive") f.item.source.scope.active = false;
    if (variant === "pending") f.item.source.pendingRevision = 2;
    if (variant === "quarantined") f.item.sourceQuarantine = { reason: "source_changed" };
    assert.equal(await f.service.conflictRepair.prepareInspection(request), null, variant);
    Object.assign(f.facts, facts); Object.assign(f.item, item); f.context.author = author;
  }
  assert.equal(reads, 1, "rejected targets cannot prepare or replace conflict material");
  const source = await f.service.prepare({ item: f.item, intent: { type: "propose_code_action", operation: "modify" },
    inputBinding: b, roleId: "developer" });
  assert.equal(source.kind, "conflict_preparation");
  assert.equal(f.item.source.current.event.payload.nextAction, "fix_ci");
  assert.equal((await f.deliver()).status, "running");
  const evidence = f.completeJob();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].action.controlledCommitEvidence.evidenceId, evidence.evidenceId);
});

test("internal repair review handed to development prepares and publishes sealed conflicts without a copied nextAction", async () => {
  const f = await fixture({ conflict: true, objectSync: { async prepare() {} } });
  const b = f.binding;
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.internal_review_requested", occurredAt: CREATED_AT,
    source: { provider: "internal-review-repair", scopeId: "internal-review:123e4567-e89b-42d3-a456-426614174000" },
    subject: { id: b.rootItemId, repository: b.repository, number: b.pullRequestNumber },
    payload: { workType: "pull_request", state: "open", headRefOid: b.headRefOid, gitTargetAvailable: true, gitTarget: b.gitTarget,
      internalReview: { kind: "own_pr_ci_repair", headRefOid: b.headRefOid, feedbackDigest: FEEDBACK_DIGEST,
        publicationConfirmationId: "prior-publication", controlledCommitEvidenceId: "prior-controlled-commit" } } });
  // Rebind the fixture through the actual event rather than inventing CI/conflict status fields.
  Object.assign(b, { eventId: event.eventId, eventDigest: event.contentDigest });
  Object.assign(f.item, { kind: "source_root", status: "queued", revision: 3, inputDigest: b.inputDigest,
    currentTarget: { type: "role", id: "developer" }, sourceQuarantine: null, event,
    source: { kind: "pull_request", identity: { provider: event.source.provider, scopeId: event.source.scopeId },
      scope: { kind: "internal_review", active: true }, current: { event } } });
  Object.assign(f.item.source, { workKey: b.workKey, activeRevision: b.inputRevision,
    revisions: Array.from({ length: b.inputRevision }, () => ({ headRevision: b.headRevision })),
    current: { event, headRefOid: b.headRefOid, eventId: b.eventId, eventDigest: b.eventDigest, inputDigest: b.inputDigest } });
  f.context.author = null;
  let reads = 0;
  f.service.conflictRepair.conflictInspectionReader = { async read(inputBinding) {
    reads += 1; return { inputBinding, preparationBinding: externalActionControlledCommit(inputBinding).executionSource.preparationBinding,
      conflicts: [{ path: "src/conflict.txt" }] };
  } };
  assert.equal(await f.service.shouldRun(f.item), true);
  assert.equal(reads, 1, "internal development must prepare current conflicts even without nextAction");
  const request = { itemId: f.item.itemId, itemRevision: f.item.revision, inputDigest: f.item.inputDigest };
  for (const variant of ["author", "head", "base", "clean", "context-author", "paused", "scope"]) {
    const facts = clone(f.facts), author = f.context.author, status = f.item.status, scope = f.item.source.scope.kind;
    if (variant === "author") f.facts.author = "another-author";
    if (variant === "head") f.facts.headRefOid = "9".repeat(40);
    if (variant === "base") f.facts.baseRefOid = "9".repeat(40);
    if (variant === "clean") f.facts.mergeStateStatus = "CLEAN";
    if (variant === "context-author") f.context.author = "another-author";
    if (variant === "paused") f.item.status = "paused";
    if (variant === "scope") f.item.source.scope.kind = "automatic";
    assert.equal(await f.service.conflictRepair.prepareInspection(request), null, variant);
    Object.assign(f.facts, facts); f.context.author = author; f.item.status = status; f.item.source.scope.kind = scope;
  }
  assert.equal(reads, 1, "rejected targets never regenerate sealed materials");
  const source = await f.service.prepare({ item: f.item, intent: { type: "propose_code_action", operation: "modify" },
    inputBinding: b, roleId: "developer" });
  assert.equal(source.kind, "conflict_preparation");
  const proposal = codeProposal(b, true);
  // The pipeline fixture normally owns this proposal at construction time.
  const { contentDigest, ...rawProposal } = proposal;
  f.adoptProposal(rawProposal);
  const transition = await f.deliver();
  assert.equal(transition.status, "running");
  const evidence = f.completeJob();
  await f.service.runCycle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].action.controlledCommitEvidence.evidenceId, evidence.evidenceId);
});
