import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewEligibility, automaticReviewContinuationEligibility, automaticReviewWorkAdmission, automaticTestingOwner,
  createAutomaticReviewAssignmentProof, automaticReviewAssignmentSupersedes } from "../src/domain/automatic-review-policy.js";

const now = "2026-10-09T10:00:00.000Z";
const item = {
  kind: "pull_request", state: "open", author: "developer", currentUser: "reviewer",
  headRefOid: "a".repeat(40), isDraft: false, ciStatus: "SUCCESS",
  incomingReviewFactsAvailable: true, reviewRecipient: "reviewer",
  reviewReceivedAt: "2026-10-09T09:00:00Z", reviewReceivedFrom: "developer",
  reviewReceivedVia: "assignee", reviewRequestEventId: "event-1",
};

test("a reused old Review cannot make the same Assign supersede its already completed settlement", () => {
  const target = { resourceId: "acme/repo#42", version: item.headRefOid };
  const next = { id: "current-confirmation", kind: "github.work-proposal-review", actor: { accountId: "reviewer" },
    target, approvalBindingDigest: "c".repeat(64) };
  const previous = { status: "completed", actor: next.actor, target, action: { publishedReviewReuse: {} },
    execution: { startedAt: "2026-10-09T09:50:00Z", outcome: "already" }, receipt: { createdAt: "2026-10-09T09:30:00Z" } };
  const facts = { ...item, assignees: ["reviewer"], myLatestPublishedReviewAt: previous.receipt.createdAt,
    myLatestPublishedReviewCommitOid: item.headRefOid, reviewReceivedAt: "2026-10-09T09:45:00Z" };
  assert.equal(automaticReviewAssignmentSupersedes(previous, next, createAutomaticReviewAssignmentProof(next, facts, now)), false);
  const fresh = { ...facts, reviewRequestEventId: "new-assign", reviewReceivedAt: "2026-10-09T09:55:00Z" };
  assert.equal(automaticReviewAssignmentSupersedes(previous, next, createAutomaticReviewAssignmentProof(next, fresh, now)), true);
  for (const outcome of ["unknown", "failed"]) assert.equal(automaticReviewAssignmentSupersedes({ ...previous,
    execution: { ...previous.execution, outcome } }, next, createAutomaticReviewAssignmentProof(next, fresh, now)), false);
  assert.equal(automaticReviewAssignmentSupersedes({ ...previous, status: "failed" }, next, createAutomaticReviewAssignmentProof(next, fresh, now)), false);
});
test('automatic Review uses the current assignment without an age, sender, or CI permission gate', () => {
  assert.equal(automaticReviewEligibility({ ...item, assignees: ['reviewer'],
    incomingReviewFactsAvailable: false, reviewRecipient: null, reviewReceivedAt: null,
    reviewReceivedFrom: null, reviewRequestEventId: null, ciStatus: 'PENDING' }, 'reviewer', now), null);
});

test('live automatic Review still requires the current assignee and avoids republishing the same Head', () => {
  assert.equal(automaticReviewEligibility({ ...item, assignees: [] }, 'reviewer', now), 'NO_CURRENT_INCOMING_REQUEST');
  assert.equal(automaticReviewEligibility({ ...item, assignees: ['reviewer'], myLatestPublishedReviewCommitOid: item.headRefOid }, 'reviewer', now), 'HEAD_ALREADY_REVIEWED');
  assert.equal(automaticReviewEligibility({ ...item, assignees: ['reviewer'], myLatestPublishedReviewCommitOid: 'b'.repeat(40), myLatestPublishedReviewAt: now }, 'reviewer', now), null);
});
test("automatic Review uses incoming request time rather than PR creation or activity", () => {
  assert.equal(automaticReviewEligibility({ ...item, createdAt: "2025-01-01T00:00:00Z" }, "reviewer", now), null);
  for (const reviewReceivedAt of ["2026-10-08T09:59:59Z", "2026-10-09T10:00:01Z", null]) {
    assert.ok(automaticReviewEligibility({ ...item, reviewReceivedAt, updatedAt: now }, "reviewer", now));
  }
});
test("missing, revoked, self-authored, draft and already reviewed heads do not auto publish", () => {
  for (const patch of [
    { incomingReviewFactsAvailable: false }, { reviewRecipient: "other" },
    { reviewReceivedVia: "reviewer" },
    { author: "REVIEWER" }, { reviewReceivedFrom: "reviewer" }, { state: "merged" },
    { isDraft: true }, { myReviewState: "APPROVED", myReviewCommitOid: item.headRefOid },
    { ciStatus: "PENDING" }, { ciStatus: "UNKNOWN" },
  ]) assert.ok(automaticReviewEligibility({ ...item, ...patch }, "reviewer", now));
  assert.equal(automaticReviewEligibility({ ...item, myReviewState: "CHANGES_REQUESTED", myReviewCommitOid: "b".repeat(40) }, "reviewer", now), null);
});

test("failed checks remain eligible for evidence-based automatic Review", () => {
  for (const ciStatus of ["FAILURE", "ERROR"]) {
    assert.equal(automaticReviewEligibility({ ...item, ciStatus }, "reviewer", now), null);
  }
});

test("a published Review consumes its assignment until a later Assign arrives", () => {
  assert.equal(automaticReviewEligibility({ ...item, myLatestPublishedReviewAt: "2026-10-09T09:30:00Z" }, "reviewer", now), "ASSIGNMENT_ALREADY_REVIEWED");
  assert.equal(automaticReviewEligibility({ ...item, myLatestPublishedReviewAt: "2026-10-09T09:30:00Z", reviewReceivedAt: "2026-10-09T09:45:00Z" }, "reviewer", now), null);
});

test("a later incoming Assign reopens the same Head exactly until that Assign is reviewed", () => {
  for (const state of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]) {
    const facts = { ...item, assignees: ["reviewer"], myReviewState: state, myReviewCommitOid: item.headRefOid,
      myLatestPublishedReviewState: state, myLatestPublishedReviewCommitOid: item.headRefOid,
      myLatestPublishedReviewAt: "2026-10-09T09:30:00Z", reviewReceivedAt: "2026-10-09T09:45:00Z" };
    assert.equal(automaticReviewEligibility(facts, "reviewer", now), null);
    assert.equal(automaticReviewEligibility({ ...facts, myLatestPublishedReviewAt: "2026-10-09T09:50:00Z" },
      "reviewer", now), "HEAD_ALREADY_REVIEWED");
    for (const patch of [{ incomingReviewFactsAvailable: false }, { reviewRecipient: "other" },
      { reviewRequestEventId: null }, { reviewReceivedVia: "reviewer" },
      { reviewReceivedAt: "2026-10-09T10:01:00Z" }, { myLatestPublishedReviewAt: null }]) {
      assert.equal(automaticReviewEligibility({ ...facts, ...patch }, "reviewer", now), "HEAD_ALREADY_REVIEWED");
    }
  }
});

test("a reviewer taking current responsibility again reopens the same Head after publication", () => {
  for (const state of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]) {
    const facts = { ...item, assignees: ["reviewer", "developer"], reviewReceivedFrom: "REVIEWER",
      reviewReceivedAt: "2026-10-09T09:45:00Z", myReviewState: state, myReviewCommitOid: item.headRefOid,
      myLatestPublishedReviewCommitOid: item.headRefOid, myLatestPublishedReviewAt: "2026-10-09T09:30:00Z" };
    assert.equal(automaticReviewEligibility(facts, "reviewer", now), null);
    assert.equal(automaticReviewEligibility({ ...facts, myLatestPublishedReviewAt: "2026-10-09T09:50:00Z" }, "reviewer", now), "HEAD_ALREADY_REVIEWED");
    for (const patch of [{ assignees: ["developer"] }, { assignees: undefined },
      { reviewReceivedAt: "2026-10-09T09:00:00Z" }, { reviewReceivedAt: "2026-10-09T10:01:00Z" },
      { reviewRequestEventId: null }, { incomingReviewFactsAvailable: false }, { reviewRecipient: "other" }]) {
      assert.ok(automaticReviewEligibility({ ...facts, ...patch }, "reviewer", now));
    }
    assert.equal(automaticReviewEligibility({ ...facts, author: "reviewer" }, "reviewer", now), "SELF_AUTHORED");
  }
});

test("later-Assign publication proof is bound, cannot be serialized and never settles unknown execution", () => {
  const target = { resourceId: "acme/repo#42", version: item.headRefOid };
  const next = { id: "review-next", kind: "github.work-proposal-review", actor: { accountId: "reviewer" },
    target, approvalBindingDigest: "c".repeat(64) };
  const previous = { status: "completed", actor: next.actor, target, receipt: { createdAt: "2026-10-09T09:30:00Z" } };
  const facts = { ...item, assignees: ["reviewer"], myLatestPublishedReviewCommitOid: item.headRefOid,
    myLatestPublishedReviewAt: previous.receipt.createdAt, reviewReceivedAt: "2026-10-09T09:45:00Z" };
  const proof = createAutomaticReviewAssignmentProof(next, facts, now);
  assert.equal(automaticReviewAssignmentSupersedes(previous, next, proof), true);
  for (const forged of [{}, structuredClone(proof), JSON.parse(JSON.stringify(proof)), null]) {
    assert.equal(automaticReviewAssignmentSupersedes(previous, next, forged), false);
  }
  for (const changed of [{ ...next, id: "other" }, { ...next, approvalBindingDigest: "d".repeat(64) }]) {
    assert.equal(automaticReviewAssignmentSupersedes(previous, changed, proof), false);
  }
  for (const changed of [{ ...previous, status: "executing" }, { ...previous, status: "failed", failure: { outcome: "unknown" } },
    { ...previous, receipt: { createdAt: "2026-10-09T09:50:00Z" } }]) {
    assert.equal(automaticReviewAssignmentSupersedes(changed, next, proof), false);
  }
});
test("testing routing uses explicit product evidence and configured owners only", () => {
  const owners = { qt: ["qt-tester"], bs: ["bs-tester"] };
  assert.deepEqual(automaticTestingOwner({ title: "fix Qt renderer", labels: [] }, owners), { login: "qt-tester", product: "qt" });
  assert.deepEqual(automaticTestingOwner({ title: "B/S build", labels: [] }, owners), { login: "bs-tester", product: "bs" });
  assert.equal(automaticTestingOwner({ title: "ambiguous", labels: [] }, owners), null);
  assert.equal(automaticTestingOwner({ title: "Qt renderer" }, {}), null);
});

function admittedRoot({ createdAt = "2026-10-09T09:10:00Z", provider = "github", workType = "pull_request", facts = {} } = {}) {
  const source = { provider, scopeId: provider === "github" ? "github-dashboard" : "owner-request:request-1" };
  const event = { source, eventType: provider === "github" ? "pull_request.created" : "pull_request.owner_requested",
    payload: { ...item, relation: "review_requested", workType, ...facts } };
  return { createdAt, event, sourceQuarantine: null, source: { kind: "pull_request", identity: source,
    scope: { active: true, kind: provider === "github" ? "automatic" : "owner_requested" }, activeRevision: 1,
    current: { event }, revisions: [{ revision: 1, disposition: "accepted", occurredAt: createdAt }] } };
}

test("ledger intake proof survives later snapshots without moving the original Assign window", () => {
  const root = admittedRoot();
  const admission = automaticReviewWorkAdmission(root);
  root.source.current = { event: { ...root.event, occurredAt: "2026-10-11T09:00:00Z", payload: { ...root.event.payload, ciStatus: "FAILURE" } } };
  assert.deepEqual(automaticReviewWorkAdmission(root), admission);
  const later = "2026-10-11T10:00:00Z";
  assert.equal(automaticReviewEligibility(root.source.current.event.payload, "reviewer", later), "OUTSIDE_RECEIVED_WINDOW");
  assert.equal(automaticReviewContinuationEligibility(root.source.current.event.payload, "reviewer", later, admission), null);
});

test("old first observations cannot claim prior admission, and a later Assign cannot borrow the first root's timestamp", () => {
  const lateRoot = admittedRoot({ createdAt: "2026-10-11T09:10:00Z" });
  assert.equal(automaticReviewContinuationEligibility(item, "reviewer", "2026-10-11T10:00:00Z",
    automaticReviewWorkAdmission(lateRoot)), "OUTSIDE_RECEIVED_WINDOW");
  const root = admittedRoot();
  root.source.current = { event: { ...root.event, payload: { ...root.event.payload, reviewRequestEventId: "event-2", reviewReceivedAt: "2026-10-10T09:00:00Z" } } };
  root.source.activeRevision = 2;
  root.source.revisions.push({ revision: 2, disposition: "accepted", occurredAt: "2026-10-12T09:00:00Z" });
  assert.equal(automaticReviewWorkAdmission(root).admittedAt, "2026-10-12T09:00:00.000Z");
});

test("only a current explicit Review root grants owner continuation, not general triage or retired work", () => {
  const root = admittedRoot({ provider: "local-owner" });
  assert.deepEqual(automaticReviewWorkAdmission(root), { kind: "owner_requested", admittedAt: root.createdAt });
  assert.equal(automaticReviewWorkAdmission(admittedRoot({ provider: "local-owner", workType: "general" })), null);
  root.source.scope.active = false;
  assert.equal(automaticReviewWorkAdmission(root), null);
  root.source.scope.active = true; root.sourceQuarantine = { reason: "stale" };
  assert.equal(automaticReviewWorkAdmission(root), null);
});

test("a Head-bound orchestrated rereview grants continuation while other general triage stays excluded", () => {
  const root = admittedRoot({ provider: "local-owner", workType: "general", facts: {
    nextAction: "rereview", suggestedCapability: "pr-review", expectedHeadRefOid: item.headRefOid,
  } });
  root.source.identity.targetRoleId = "orchestrator";
  root.source.current.headRefOid = item.headRefOid;
  assert.deepEqual(automaticReviewWorkAdmission(root), { kind: "owner_requested", admittedAt: root.createdAt });
  for (const patch of [
    { nextAction: "confirm" }, { suggestedCapability: "development" },
    { expectedHeadRefOid: "b".repeat(40) }, { headRefOid: "b".repeat(40) },
  ]) {
    const changed = structuredClone(root);
    Object.assign(changed.source.current.event.payload, patch);
    assert.equal(automaticReviewWorkAdmission(changed), null);
  }
  root.source.identity.targetRoleId = "developer";
  assert.equal(automaticReviewWorkAdmission(root), null);
});

test("a Head-bound orchestrated review completion has publication admission", () => {
  const root = admittedRoot({ provider: "local-owner", workType: "general", facts: {
    nextAction: "complete_review", suggestedCapability: "pr-review", expectedHeadRefOid: item.headRefOid,
  } });
  root.source.identity.targetRoleId = "orchestrator";
  root.source.current.headRefOid = item.headRefOid;
  assert.deepEqual(automaticReviewWorkAdmission(root), { kind: "owner_requested", admittedAt: root.createdAt });
});

test('a current orchestrated initial Review grants the same automatic publication admission as rereview', () => {
  const root = admittedRoot({ provider: 'local-owner', workType: 'general', facts: {
    nextAction: 'review', suggestedCapability: 'pr-review', expectedHeadRefOid: item.headRefOid,
  } });
  root.source.identity.targetRoleId = 'orchestrator';
  root.source.current.headRefOid = item.headRefOid;
  assert.deepEqual(automaticReviewWorkAdmission(root), { kind: 'owner_requested', admittedAt: root.createdAt });
});

test("replacement Assign retains its own timely intake across later snapshots", () => {
  const root = admittedRoot();
  const incomingReview = { eventId: "event-2", receivedAt: "2026-10-10T09:00:00Z" };
  const facts = { ...item, relation: "review_requested", reviewRequestEventId: incomingReview.eventId, reviewReceivedAt: incomingReview.receivedAt };
  root.source.current = { event: { ...root.event, payload: facts } };
  root.source.activeRevision = 3;
  root.source.revisions.push(
    { revision: 2, disposition: "accepted", occurredAt: "2026-10-10T09:10:00Z", incomingReview },
    { revision: 3, disposition: "accepted", occurredAt: "2026-10-12T09:10:00Z", incomingReview },
  );
  const admission = automaticReviewWorkAdmission(root);
  assert.equal(admission.admittedAt, "2026-10-10T09:10:00.000Z");
  assert.equal(automaticReviewContinuationEligibility(facts, "reviewer", "2026-10-12T10:00:00Z", admission), null);
});
