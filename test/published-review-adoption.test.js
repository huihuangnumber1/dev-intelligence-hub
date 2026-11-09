import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBoundWorkProposal, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { verifyReviewPublicationSource, createReviewPublicationCandidate, createReviewPublicationAdoption,
  verifyReviewPublicationAdoption, ReviewPublicationAdoptionStore } from "../src/services/published-review-adoption.js";
import { ReviewPublicationReuseService, createReviewAdoptionTaskReader } from "../src/services/review-publication-reuse-service.js";
import { DeliveryEvidenceService } from "../src/services/delivery-evidence-service.js";
import { createWorkIntentDispatchBinding } from "../src/domain/work-intent-dispatch-binding.js";

async function sourceFixture() {
  const at = "2026-10-26T08:47:13.000Z";
  const binding = { schemaVersion: 2, kind: "pull_request", repository: "acme/repo", pullRequestNumber: 42,
    rootItemId: "old-review-root", workKey: "old-review-request", inputRevision: 1, headRevision: 1,
    headRefOid: "b".repeat(40), eventId: "review-event", eventDigest: "c".repeat(64), inputDigest: "d".repeat(64),
    gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "review-account", baseRepository: "acme/repo",
      baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "contributor/repo", headRefName: "fix/42", headRefOid: "b".repeat(40) } };
  const proposal = normalizeBoundWorkProposal({ proposalId: "work-intent-" + "a".repeat(64), policyVersion: 1,
    kind: "github_review_proposal", requestedBy: { roleId: "pr-engineer", workItemId: binding.rootItemId },
    source: { assignmentId: "old-review-assignment", eventId: binding.eventId },
    binding: { eventId: binding.eventId, subject: { repository: "acme/repo", number: 42 }, repository: "acme/repo",
      pullRequestNumber: 42, headRefOid: binding.headRefOid, inputBinding: binding },
    payload: { verdict: "approve", body: "Original published review", evidence: ["head:" + binding.headRefOid],
      summary: "Review complete", reason: "Current diff reviewed" } });
  const store = { value: null, async read(_name, fallback) { return structuredClone(this.value ?? fallback); },
    async write(_name, value) { this.value = structuredClone(value); } };
  const queue = new ConfirmationQueue({ store, clock: () => new Date(at),
    exclusiveLease: { async acquire() {}, run: operation => operation(), async close() {} },
    executor: { async execute() { return { status: "applied", receipt: { id: "12345", url: "https://github.com/acme/repo/pull/42", createdAt: at } }; },
      async reconcile() { assert.fail("Publication source must not be replayed"); } } });
  await queue.recover();
  const item = await queue.enqueue(createGitHubReviewProposalConfirmationPlan(proposal, { actorAccountId: "review-account" }));
  await queue.approve(item.id, { requestId: "source-review-publication", expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision, displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest });
  const result = createWorkProposalResult({ proposal, sequence: 1, downstreamRef: null, at,
    transition: { status: "succeeded", summary: "Review published", evidence: ["confirmation:" + item.id] } });
  return { proposal, result, confirmationSnapshot: await queue.readSettlement({ confirmationId: item.id }) };
}

test("a completed publication retains original producer provenance without a new evidence target", async () => {
  const source = await sourceFixture();
  const before = structuredClone(source);
  const proof = verifyReviewPublicationSource(source);
  assert.ok(proof);
  assert.equal(proof.producerTaskId, "old-review-root");
  assert.equal(proof.proposalId, source.proposal.proposalId);
  assert.equal(proof.resultId, source.result.resultId);
  assert.equal(proof.confirmationId, source.confirmationSnapshot.item.id);
  assert.equal(proof.receipt.id, "12345");
  assert.equal(proof.inputBinding.gitTarget.baseRefOid, "a".repeat(40));
  assert.equal(Object.hasOwn(source.proposal.binding, "evidenceTarget"), false);
  assert.deepEqual(source, before);
});

test("source verification rejects changed publication records and unresolved outcomes", async (t) => {
  const source = await sourceFixture();
  for (const [name, alter] of [
    ["proposal body", x => { x.proposal.payload.body = "Changed"; }],
    ["result producer", x => { x.result.requestedBy.workItemId = "different-task"; }],
    ["result confirmation", x => { x.result.evidence = ["confirmation:other"]; }],
    ["confirmation actor", x => { x.confirmationSnapshot.item.actor.accountId = "different-account"; }],
    ["confirmation head", x => { x.confirmationSnapshot.item.target.version = "f".repeat(40); }],
    ["not completed", x => { x.confirmationSnapshot.item.status = "pending"; x.confirmationSnapshot.item.receipt = null; }],
    ["unknown receipt", x => { x.confirmationSnapshot.item.receipt = null; }],
    ["wrong external id", x => { x.confirmationSnapshot.item.receipt.id = "not-a-github-id"; }],
  ]) await t.test(name, () => { const changed = structuredClone(source); alter(changed); assert.equal(verifyReviewPublicationSource(changed), null); });
});


async function candidateFixture() {
  const source = await sourceFixture();
  const inputBinding = { ...structuredClone(source.proposal.binding.inputBinding), rootItemId: "new-review-root",
    workKey: "new-review-request", eventId: "new-review-event", eventDigest: "e".repeat(64), inputDigest: "f".repeat(64) };
  const { createDeliveryEvidenceTarget } = await import("../src/domain/delivery-evidence-contract.js");
  const { createPullRequestReadFacts, createPullRequestReadIdentity } = await import("../src/domain/pull-request-read-facts.js");
  const { normalizeWorkflowEvent } = await import("../src/domain/workflow-events.js");
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed",
    occurredAt: "2026-10-26T08:22:22.000Z", source: { provider: "github", scopeId: "github-account:review-account" },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { headRefOid: inputBinding.headRefOid, gitTargetAvailable: true, gitTarget: inputBinding.gitTarget } });
  inputBinding.eventId = event.eventId;
  inputBinding.eventDigest = event.contentDigest;
  const acceptanceContract = { revision: 1, acceptanceCriteria: [{ criterionId: "published", description: "A verified published result" }],
    expectedDeliverables: [{ deliverableId: "review-result", kind: "review-report", description: "Published Review", required: true }] };
  const evidenceTarget = createDeliveryEvidenceTarget({ taskId: "new-review-child", roleId: "pr-engineer", acceptanceContract });
  const target = { inputBinding, evidenceTarget, requestedAt: "2026-10-26T08:22:22.000Z" };
  const factsInput = { identity: createPullRequestReadIdentity({ executionBinding: inputBinding, event }), observedAt: "2026-10-28T05:00:00.000Z",
    reviewDecision: "APPROVED", comments: [], reviewThreads: [], checks: [],
    reviews: [{ id: "PRR_original", author: "review-account", state: "APPROVED", submittedAt: "2026-10-26T08:47:13.000Z",
      commitOid: inputBinding.headRefOid, body: source.proposal.payload.body, bodyTruncated: false,
      url: "https://github.com/acme/repo/pull/42#pullrequestreview-12345" }],
    truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } };
  return { source, target, event, acceptanceContract, factsInput, facts: createPullRequestReadFacts(factsInput), createFacts: createPullRequestReadFacts };
}

test("publication candidates bind complete current material and the new contract without claiming delivery", async () => {
  const f = await candidateFixture();
  const first = createReviewPublicationCandidate(f);
  assert.ok(first);
  assert.equal(first.target.evidenceTarget.taskId, "new-review-child");
  assert.equal(first.source.producerTaskId, "old-review-root");
  assert.equal(first.requiresCurrentReview, true);
  assert.match(first.candidateId, /^review-publication-candidate-[a-f0-9]{64}$/);
  const later = createReviewPublicationCandidate({ ...f, facts: f.createFacts({ ...f.factsInput, observedAt: "2026-10-28T05:30:00.000Z" }) });
  assert.equal(later.candidateId, first.candidateId, "observation refresh is not a new recovery condition");
  const withChecks = createReviewPublicationCandidate({ ...f, facts: f.createFacts({ ...f.factsInput,
    checks: [{ kind: "check_run", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci.example/run/1", requirement: "required",
      startedAt: "2026-10-28T05:00:00.000Z", completedAt: "2026-10-28T05:05:00.000Z" }] }) });
  assert.ok(withChecks);
  assert.notEqual(withChecks.materialDigest, first.materialDigest);
  assert.match(first.coverage.feedbackDigest, /^[a-f0-9]{64}$/);
  assert.equal(withChecks.coverage.feedbackDigest, first.coverage.feedbackDigest);
  assert.equal(withChecks.candidateId, first.candidateId, "CI status is not a new Review feedback coverage condition");
  const differentContract = createReviewPublicationCandidate({ ...f, target: { ...f.target,
    evidenceTarget: { ...f.target.evidenceTarget, contractDigest: "0".repeat(64) } } });
  assert.notEqual(differentContract.candidateId, first.candidateId);
});

test("uncertain coverage, changed publication and different versions cannot become reuse candidates", async (t) => {
  const f = await candidateFixture();
  const changes = [
    ["truncated facts", x => { x.truncation.comments = true; }],
    ["truncated review", x => { x.reviews[0].bodyTruncated = true; }],
    ["edited published body", x => { x.reviews[0].body = "New unverified review content"; }],
    ["different author", x => { x.reviews[0].author = "different-account"; }],
    ["different receipt identity", x => { x.reviews[0].url = "https://github.com/acme/repo/pull/42#pullrequestreview-99999"; }],
    ["changed verdict", x => { x.reviews[0].state = "COMMENTED"; }],
    ["ambiguous same-second actor review", x => { x.reviews.push({ ...x.reviews[0], id: "PRR_later",
      state: "CHANGES_REQUESTED", body: "A conflicting follow-up", url: "https://github.com/acme/repo/pull/42#pullrequestreview-12346" }); }],
    ["new feedback", x => { x.comments.push({ id: "IC_new", author: "developer", body: "A new request", bodyTruncated: false,
      createdAt: "2026-10-27T08:00:00.000Z", updatedAt: "2026-10-27T08:00:00.000Z", url: "https://github.com/acme/repo/pull/42#issuecomment-1" }); }],
  ];
  for (const [name, change] of changes) await t.test(name, () => {
    const input = structuredClone(f.factsInput); change(input);
    assert.equal(createReviewPublicationCandidate({ ...f, facts: f.createFacts(input) }), null);
  });
  assert.equal(createReviewPublicationCandidate({ ...f, target: { ...f.target, requestedAt: "2026-10-27T00:00:00.000Z" } }), null);
  assert.equal(createReviewPublicationCandidate({ ...f, target: { ...f.target,
    inputBinding: { ...f.target.inputBinding, gitTarget: { ...f.target.inputBinding.gitTarget, baseRefOid: "1".repeat(40) } } } }), null);
});


test("publication source discovery retains outstanding work and reports an incomplete bounded scan", async () => {
  const f = await candidateFixture();
  const { WorkProposalEvidenceReader } = await import("../src/services/work-proposal-evidence-reader.js");
  const pending = structuredClone(f.source.proposal);
  pending.proposalId = "work-intent-" + "b".repeat(64);
  const state = { proposals: [{ proposal: f.source.proposal, status: "succeeded", resultId: f.source.result.resultId, downstreamRef: null },
    { proposal: pending, status: "pending_delivery", resultId: null, downstreamRef: null }], results: [f.source.result] };
  const reader = new WorkProposalEvidenceReader({ readState: () => state });
  const page = reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 10 });
  assert.equal(page.complete, true);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].status, "pending_delivery", "unknown or pending source work must stay visible to the reuse gate");
  assert.equal(page.items[0].result, null);
  assert.equal(reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 1 }).complete, false);
  const otherBase = structuredClone(f.target.inputBinding);
  otherBase.gitTarget.baseRefOid = "0".repeat(40);
  assert.equal(reader.listReviewPublicationSources({ inputBinding: otherBase, limit: 10 }).items.length, 2,
    "old-Base outstanding work must remain visible; candidate eligibility checks the exact Base separately");
  const { contentDigest: _legacyDigest, ...legacyContent } = structuredClone(pending);
  legacyContent.proposalId = "work-intent-" + "c".repeat(64);
  const { gitTarget: _legacyGitTarget, ...legacyBinding } = legacyContent.binding.inputBinding;
  legacyContent.binding.inputBinding = { ...legacyBinding, schemaVersion: 1 };
  const legacy = normalizeBoundWorkProposal(legacyContent);
  state.proposals.push({ proposal: legacy, status: "waiting_retry", resultId: null, downstreamRef: "legacy-unknown" });
  const withLegacy = reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 10 });
  assert.equal(withLegacy.items.length, 3, "a legacy binding without an account is uncertain, not unrelated");
  assert.ok(withLegacy.items.some(item => item.proposal.proposalId === legacy.proposalId));
  const otherRequest = { ...f.target.inputBinding, pullRequestNumber: 43 };
  assert.equal(reader.listReviewPublicationSources({ inputBinding: otherRequest, limit: 10 }).items.length, 0);
});


async function adoptionFixture() {
  const f = await candidateFixture();
  const candidate = createReviewPublicationCandidate(f);
  const coverageDigest = "9".repeat(64);
  const { contentDigest: _sourceDigest, ...content } = structuredClone(f.source.proposal);
  const proposal = normalizeBoundWorkProposal({ ...content, proposalId: "work-intent-" + "e".repeat(64),
    requestedBy: { roleId: f.target.evidenceTarget.roleId, workItemId: f.target.evidenceTarget.taskId },
    source: { assignmentId: "new-review-assignment", eventId: f.target.inputBinding.eventId },
    binding: { ...content.binding, eventId: f.target.inputBinding.eventId, inputBinding: f.target.inputBinding,
      evidenceTarget: f.target.evidenceTarget },
    payload: { ...content.payload, body: "Current complete feedback was reviewed; this note is local, not a new GitHub body",
      publicationReuse: { candidateId: candidate.candidateId, materialDigest: candidate.materialDigest, coverageDigest } } });
  return { ...f, candidate, proposal, coverageDigest, adoptedAt: "2026-10-28T05:50:00.000Z" };
}

test("adoption receipts bind the new assessment while preserving the original published body", async () => {
  const f = await adoptionFixture();
  const receipt = createReviewPublicationAdoption(f);
  assert.ok(receipt);
  assert.equal(receipt.outcome, "adopted_existing_review");
  assert.equal(receipt.source.publishedBody, f.source.proposal.payload.body);
  assert.equal(receipt.assessment.coverageNote, f.proposal.payload.body);
  assert.equal(receipt.assessment.coverageDigest, f.coverageDigest);
  assert.notEqual(receipt.source.publishedBodyDigest, receipt.assessment.coverageNoteDigest);
  assert.equal(receipt.target.evidenceTarget.taskId, "new-review-child");
  assert.equal(verifyReviewPublicationAdoption({ ...f, receipt }), true);
  assert.equal(createReviewPublicationAdoption({ ...f, coverageDigest: "8".repeat(64) }), null);
  assert.equal(verifyReviewPublicationAdoption({ ...f, receipt, coverageDigest: "8".repeat(64) }), false);
  const current = createReviewPublicationCandidate({ ...f, facts: f.createFacts({ ...f.factsInput,
    checks: [{ kind: "check_run", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci.example/run/1", requirement: "required",
      startedAt: "2026-10-28T05:00:00.000Z", completedAt: "2026-10-28T05:05:00.000Z" }] }) });
  assert.notEqual(current.materialDigest, f.candidate.materialDigest);
  assert.equal(verifyReviewPublicationAdoption({ ...f, candidate: current, receipt }), true,
    "CI-only changes do not erase a verified current feedback assessment");
  const later = createReviewPublicationAdoption({ ...f, adoptedAt: "2026-10-28T06:00:00.000Z" });
  assert.equal(later.adoptionId, receipt.adoptionId);
  const changed = structuredClone(receipt); changed.assessment.coverageNote = "An unsealed note";
  assert.equal(verifyReviewPublicationAdoption({ ...f, receipt: changed }), false);
  const { contentDigest: _old, ...content } = f.proposal;
  for (const payload of [
    { ...content.payload, verdict: "request_changes" },
    { ...content.payload, publicationReuse: { ...content.payload.publicationReuse, materialDigest: "0".repeat(64) } },
  ]) assert.equal(createReviewPublicationAdoption({ ...f, proposal: normalizeBoundWorkProposal({ ...content, payload }) }), null);
  assert.equal(createReviewPublicationAdoption({ ...f, proposal: undefined }), null);
});

test("a full bounded source page does not share a single-proposal node budget", async () => {
  const f = await candidateFixture();
  const { WorkProposalEvidenceReader } = await import("../src/services/work-proposal-evidence-reader.js");
  const { contentDigest: _digest, ...content } = f.source.proposal;
  const proposals = Array.from({ length: 100 }, (_, index) => ({ status: "failed", resultId: null, downstreamRef: null,
    proposal: normalizeBoundWorkProposal({ ...content, proposalId: "work-intent-" + index.toString(16).padStart(64, "0") }) }));
  const reader = new WorkProposalEvidenceReader({ readState: () => ({ proposals, results: [] }) });
  const page = reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 100 });
  assert.equal(page.complete, true);
  assert.equal(page.items.length, 100);
  page.items[0].proposal.payload.body = "Changed projection";
  assert.equal(proposals.at(-1).proposal.payload.body, f.source.proposal.payload.body);
  assert.equal(reader.listReviewPublicationSources({ inputBinding: f.target.inputBinding, limit: 99 }).complete, false);
});

test("adoption persistence is restart-safe and does not rewrite source or duplicate the receipt", async () => {
  const f = await adoptionFixture();
  const receipt = createReviewPublicationAdoption(f);
  const values = new Map(); let writes = 0;
  const store = { async read(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
    async write(key, value) { writes++; values.set(key, structuredClone(value)); } };
  const first = new ReviewPublicationAdoptionStore({ store });
  await first.recover();
  assert.deepEqual(await first.record(receipt), receipt);
  const restarted = new ReviewPublicationAdoptionStore({ store }); await restarted.recover();
  assert.deepEqual(await restarted.get(receipt.adoptionId), receipt);
  const again = createReviewPublicationAdoption({ ...f, adoptedAt: "2026-10-28T06:00:00.000Z" });
  assert.deepEqual(await restarted.record(again), receipt);
  assert.equal(writes, 1);
  const changed = structuredClone(receipt); changed.source.receipt.id = "99999";
  await assert.rejects(first.record(changed), { code: "REVIEW_PUBLICATION_ADOPTION_INVALID" });
  assert.deepEqual(await restarted.get(receipt.adoptionId), receipt);
});


test("adoption recovery validates each retained receipt without applying a single-proposal budget to the whole history", async () => {
  const f = await adoptionFixture();
  const { contentDigest: _digest, ...content } = f.proposal;
  const records = Array.from({ length: 60 }, (_, index) => createReviewPublicationAdoption({ ...f,
    proposal: normalizeBoundWorkProposal({ ...content, proposalId: "work-intent-" + index.toString(16).padStart(64, "0"),
      payload: { ...content.payload, body: `Coverage assessment ${index}` } }) }));
  assert.equal(records.every(Boolean), true);
  const store = { async read() { return { schemaVersion: 1, records: structuredClone(records) }; }, async write() { assert.fail("Recovery is read-only"); } };
  const receipts = new ReviewPublicationAdoptionStore({ store });
  assert.equal((await receipts.recover()).records, 60);
  assert.deepEqual(await receipts.get(records[59].adoptionId), records[59]);
});

async function reuseServiceFixture() {
  const f = await adoptionFixture(); const values = new Map(); let writes = 0, captures = 0;
  const stateStore = { async read(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
    async write(key, value) { writes++; values.set(key, structuredClone(value)); } };
  const receiptStore = new ReviewPublicationAdoptionStore({ store: stateStore });
  const task = { taskId: f.target.evidenceTarget.taskId, roleId: "pr-engineer", revision: 7, status: "waiting_external", rootStatus: "queued",
    activeIntentId: "work-intent-" + "7".repeat(64),
    inputBinding: f.target.inputBinding, event: f.event,
    acceptanceContract: f.acceptanceContract, requestedAt: f.target.requestedAt };
  const material = { facts: f.facts, feedbackSnapshot: { coverageDigest: f.coverageDigest } };
  const scan = { complete: true, items: [{ proposal: f.source.proposal, result: f.source.result, status: "succeeded", downstreamRef: null }] };
  const settlements = new Map([[f.source.confirmationSnapshot.item.id, f.source.confirmationSnapshot]]);
  const { WorkProposalEvidenceReader } = await import("../src/services/work-proposal-evidence-reader.js");
  const publicationSourceReader = new WorkProposalEvidenceReader({ readState: () => ({
    proposals: scan.items.map(row => ({ proposal: row.proposal, resultId: row.result?.resultId ?? null, status: row.status, downstreamRef: row.downstreamRef })),
    results: scan.items.flatMap(row => row.result ? [row.result] : []),
  }) });
  const { proposalId, contentDigest, ...boundContent } = f.proposal;
  const dispatch = { intentId: task.activeIntentId, itemId: task.taskId, inputDigest: task.inputBinding.inputDigest,
    intent: { type: "propose_github_review" }, status: "delivered",
    dispatchBinding: createWorkIntentDispatchBinding({ intentId: proposalId, ...boundContent }),
    outcome: { status: "delivered", details: { downstreamRef: proposalId, proposalDigest: contentDigest } } };
  const { schemaVersion: _schema, repository: _repo, pullRequestNumber: _number, gitTarget: _git, ...sourceBinding } = task.inputBinding;
  const ledger = { async readReviewAdoptionContext({ itemId }) {
    assert.equal(itemId, task.taskId);
    return { item: { ...task, itemId: task.taskId, kind: "graph_task", sourceQuarantine: null,
      assignmentId: f.proposal.source.assignmentId, inputDigest: task.inputBinding.inputDigest,
      currentTarget: { type: "role", id: task.roleId }, assignment: { graphTask: { sourceBinding } },
      graph: { acceptanceContracts: [task.acceptanceContract] } },
      root: { itemId: task.inputBinding.rootItemId, sourceQuarantine: null, source: { scope: { active: true } },
        status: task.rootStatus, createdAt: task.requestedAt }, activeDispatch: structuredClone(dispatch) };
  } };
  const service = new ReviewPublicationReuseService({ taskReader: createReviewAdoptionTaskReader(ledger),
    factsReader: { async get() { return material.facts; } }, publicationSourceReader,
    confirmationReader: { async readSettlements({ confirmationIds }) {
      return { queueRevision: f.source.confirmationSnapshot.queueRevision,
        items: confirmationIds.flatMap(id => settlements.has(id) ? [settlements.get(id).item] : []) };
    } },
    materialsReader: { async read(input) { captures++; assert.equal(input.taskId, task.taskId); assert.deepEqual(input.gitTarget, task.inputBinding.gitTarget); return material; } },
    receiptStore, inputAuthorityVerifier: { async verify(input) { return input; } }, clock: () => new Date(f.adoptedAt) });
  return { ...f, service, task, ledger, dispatch, material, scan, settlements, receiptStore, counts: () => ({ writes, captures }) };
}

test("host reuse produces new-task evidence without a GitHub write port and survives a lost result", async () => {
  const f = await reuseServiceFixture();
  assert.notEqual(f.task.activeIntentId, f.proposal.proposalId, "ledger dispatch identity is distinct from the sealed proposal");
  const catalog = await f.service.listCandidates({ taskId: f.task.taskId, materialDigest: f.candidate.materialDigest });
  assert.equal(catalog.candidates[0].candidateId, f.candidate.candidateId);
  assert.equal(f.counts().captures, 0, "candidate preview uses complete already-cached facts");
  const transition = await f.service.handle({ proposal: f.proposal });
  assert.equal(transition.status, "succeeded");
  assert.equal(transition.evidence.filter(value => value.startsWith("adoption:")).length, 1);
  assert.equal(f.counts().writes, 1);
  const again = await f.service.handle({ proposal: f.proposal });
  assert.deepEqual(again, transition);
  assert.equal(f.counts().writes, 1);
  const result = createWorkProposalResult({ proposal: f.proposal, sequence: 1, at: f.adoptedAt, downstreamRef: null, transition });
  const authority = { taskId: f.task.taskId, roleId: f.task.roleId, contractRevision: f.target.evidenceTarget.contractRevision,
    contractDigest: f.target.evidenceTarget.contractDigest, inputBinding: f.task.inputBinding };
  assert.equal(await f.service.verifyProposal({ proposal: f.proposal, result, authority }), true);
  assert.equal(await f.service.verifyProposal({ proposal: f.proposal, result, authority: { ...authority, taskId: "another-task" } }), false);
  const receipt = await f.receiptStore.getForProposal({ proposalId: f.proposal.proposalId, proposalDigest: f.proposal.contentDigest });
  assert.equal(receipt.source.publishedBody, f.source.proposal.payload.body);
  assert.equal(receipt.assessment.coverageNote, f.proposal.payload.body);
});

test("reuse follows the sealed proposal through a current dispatch before its acknowledgement", async () => {
  const f = await reuseServiceFixture();
  f.task.status = "dispatch_pending";
  f.dispatch.status = "dispatching";
  f.dispatch.outcome = null;
  assert.equal((await f.service.handle({ proposal: f.proposal })).status, "succeeded");
  assert.equal(f.counts().writes, 1);
});

test("reuse refuses mismatched or uncertain active dispatch evidence", async t => {
  const variants = {
    "outer intent": f => { f.dispatch.intentId = "work-intent-" + "8".repeat(64); },
    "other task": f => { f.dispatch.itemId = "another-task"; },
    "wrong intent kind": f => { f.dispatch.intent.type = "propose_code_action"; },
    "unknown dispatch": f => { f.dispatch.status = "unknown"; },
    "changed input": f => { f.dispatch.inputDigest = "8".repeat(64); },
    "changed seal": f => { f.dispatch.dispatchBinding.bindingDigest = "8".repeat(64); },
    "wrong producer": f => {
      f.dispatch.dispatchBinding.boundIntent.requestedBy.workItemId = "another-task";
      f.dispatch.dispatchBinding = createWorkIntentDispatchBinding(f.dispatch.dispatchBinding.boundIntent);
    },
    "changed source": f => {
      f.dispatch.dispatchBinding.boundIntent.source.assignmentId = "another-assignment";
      f.dispatch.dispatchBinding = createWorkIntentDispatchBinding(f.dispatch.dispatchBinding.boundIntent);
    },
    "wrong downstream id": f => { f.dispatch.outcome.details.downstreamRef = "another-proposal"; },
    "wrong downstream digest": f => { f.dispatch.outcome.details.proposalDigest = "8".repeat(64); },
    "no active dispatch": f => { f.task.activeIntentId = null; },
  };
  for (const [name, mutate] of Object.entries(variants)) await t.test(name, async () => {
    const f = await reuseServiceFixture(); mutate(f);
    await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE" });
    assert.equal(f.counts().writes, 0);
  });
});

test("reuse rechecks current dispatch ownership after recording its local receipt", async () => {
  const f = await reuseServiceFixture();
  const read = f.ledger.readReviewAdoptionContext; let reads = 0;
  f.ledger.readReviewAdoptionContext = async input => {
    if (++reads === 2) f.dispatch.outcome.details.downstreamRef = "another-proposal";
    return read(input);
  };
  await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_TARGET_CHANGED" });
  assert.equal(f.counts().writes, 1);
});

test("host verification preserves a captured assessment across CI updates and rejects new linked QA coverage", async () => {
  const f = await reuseServiceFixture();
  const transition = await f.service.handle({ proposal: f.proposal });
  const result = createWorkProposalResult({ proposal: f.proposal, sequence: 1, at: f.adoptedAt, downstreamRef: null, transition });
  f.material.facts = f.createFacts({ ...f.factsInput, checks: [{ kind: "check_run", name: "CI", status: "COMPLETED", conclusion: "SUCCESS",
    url: "https://ci.example/run/1", requirement: "required", startedAt: "2026-10-28T05:00:00.000Z", completedAt: "2026-10-28T05:05:00.000Z" }] });
  assert.equal(await f.service.verifyProposal({ proposal: f.proposal, result }), true);
  assert.deepEqual(await f.service.handle({ proposal: f.proposal }), transition, "a lost handler result can recover its receipt after CI changed");
  f.material.feedbackSnapshot.coverageDigest = "0".repeat(64);
  assert.equal(await f.service.verifyProposal({ proposal: f.proposal, result }), false);
  assert.equal(f.counts().writes, 1);
});

test("adopted publication flows through the normal new-task authoritative delivery catalog", async () => {
  const f = await reuseServiceFixture();
  const transition = await f.service.handle({ proposal: f.proposal });
  const result = createWorkProposalResult({ proposal: f.proposal, sequence: 1, at: f.adoptedAt, downstreamRef: null, transition });
  const evidence = new DeliveryEvidenceService({ publicationAdoptionVerifier: f.service, proposalResultReader: {
    async getResult() { return result; }, async getProposalForEvidence() { return f.proposal; }, async getResultForProposal() { return result; },
    async listEvidenceCandidates() { return { items: [{ proposal: f.proposal, result }], nextBeforeSequence: null }; },
  } });
  const target = f.target.evidenceTarget;
  const authority = { taskId: target.taskId, roleId: target.roleId, contractRevision: target.contractRevision, contractDigest: target.contractDigest };
  const catalog = await evidence.listForTask({ ...authority, kinds: ["review-report"] });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].deliverableId, "review-result");
  assert.equal(catalog[0].evidence.referenceId, result.resultId);
  assert.deepEqual(await evidence.verify({ ...authority, inputBinding: f.task.inputBinding, deliverableId: "review-result", evidence: catalog[0].evidence }), catalog[0].evidence);
  f.material.feedbackSnapshot.coverageDigest = "0".repeat(64);
  assert.deepEqual(await evidence.listForTask({ ...authority, kinds: ["review-report"] }), []);
  assert.equal(await evidence.verify({ ...authority, deliverableId: "review-result", evidence: catalog[0].evidence }), false);
  assert.equal(f.counts().writes, 1);
});

test("host reuse rejects changed linked coverage, current contract, manual pause and unsettled publication", async () => {
  const f = await reuseServiceFixture();
  f.material.feedbackSnapshot.coverageDigest = "0".repeat(64);
  await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED" });
  assert.equal(f.counts().writes, 0);
  f.material.feedbackSnapshot.coverageDigest = f.coverageDigest;
  f.task.acceptanceContract.revision++;
  await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_TARGET_CHANGED" });
  f.task.acceptanceContract.revision--;
  f.task.status = "paused";
  await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE" });
  f.task.status = "waiting_external";
  f.scan.items.push({ proposal: f.source.proposal, result: null, status: "waiting_confirmation", downstreamRef: "pending" });
  await assert.rejects(f.service.handle({ proposal: f.proposal }), { code: "REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE" });
  assert.equal(f.counts().writes, 0);
});

test("terminal proposal status cannot hide a still-actionable or uncertain confirmation", async (t) => {
  for (const [name, change] of [
    ["retryable absent publication", item => { item.status = "failed"; item.receipt = null; item.failure = { outcome: "absent", retryable: true }; }],
    ["unknown publication", item => { item.status = "failed"; item.receipt = null; item.failure = { outcome: "unknown", retryable: false }; }],
    ["owner rejected unknown outcome", item => { item.status = "rejected"; item.failure = null; item.execution.outcome = "unknown"; }],
    ["publication completed after handler failed", () => {}],
  ]) await t.test(name, async () => {
    const f = await reuseServiceFixture();
    f.scan.items[0].status = "failed";
    const snapshot = structuredClone(f.source.confirmationSnapshot);
    change(snapshot.item);
    f.settlements.set(snapshot.item.id, snapshot);
    await assert.rejects(f.service.listCandidates({ taskId: f.task.taskId, materialDigest: f.candidate.materialDigest }),
      { code: "REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE" });
    assert.deepEqual(f.counts(), { writes: 0, captures: 0 });
  });
});

test("task authority uses the original request time and rejects an inactive root", async () => {
  const f = await candidateFixture();
  const root = { itemId: f.target.inputBinding.rootItemId, sourceQuarantine: null, source: { scope: { active: true } },
    status: "queued", createdAt: f.target.requestedAt };
  const { schemaVersion: _schema, repository: _repo, pullRequestNumber: _number, gitTarget: _git, ...sourceBinding } = f.target.inputBinding;
  const child = { itemId: f.target.evidenceTarget.taskId, kind: "graph_task", sourceQuarantine: null,
    currentTarget: { type: "role", id: "pr-engineer" }, status: "blocked", revision: 7, activeIntentId: null,
    assignment: { graphTask: { sourceBinding } }, event: f.event,
    graph: { acceptanceContracts: [f.acceptanceContract] }, createdAt: "2026-10-26T09:13:23.000Z" };
  const reader = createReviewAdoptionTaskReader({ async readReviewAdoptionContext({ itemId }) {
    assert.equal(itemId, child.itemId);
    return { item: child, root, activeDispatch: null };
  } });
  const task = await reader.read({ taskId: child.itemId });
  assert.equal(task.requestedAt, root.createdAt);
  assert.notEqual(task.requestedAt, child.createdAt);
  assert.deepEqual(task.inputBinding, f.target.inputBinding);
  root.source.scope.active = false;
  assert.equal(await reader.read({ taskId: child.itemId }), null);
});
