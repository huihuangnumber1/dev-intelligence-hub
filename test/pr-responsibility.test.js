import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_STATES,
  assessPullRequestResponsibility,
  isPersonalPullRequest,
} from "../src/domain/pr-responsibility.js";

const now = "2026-07-31T09:00:00.000Z";
const currentUser = "local-owner";

function pullRequest(overrides = {}) {
  return {
    kind: "pull_request",
    relation: "authored",
    author: currentUser,
    currentUser,
    state: "open",
    updatedAt: "2026-07-30T09:00:00.000Z",
    reviewDecision: "",
    ciStatus: "NONE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    headRefOid: "head-2",
    myReviewState: "",
    myReviewCommitOid: "",
    latestOtherDecisionState: "",
    latestOtherDecisionCommitOid: "",
    latestChangeRequestCommitOid: "",
    outstandingChangeRequestCommitOids: [],
    reviewFactsAvailable: true,
    ...overrides,
  };
}

function assess(overrides) {
  return assessPullRequestResponsibility(pullRequest(overrides), {
    now,
    historicalAfterDays: 60,
  });
}

test("current assignees take precedence over PR authorship", () => {
  assert.equal(isPersonalPullRequest(pullRequest({ assignees: ['reviewer'] })), false);
  assert.equal(isPersonalPullRequest(pullRequest({ assignees: [] })), true);
  assert.equal(isPersonalPullRequest(pullRequest({ assignees: ['LOCAL-OWNER', 'reviewer'] })), true);
  assert.equal(isPersonalPullRequest(pullRequest({ author: 'contributor', assignees: [] })), false);
});

test("a PR assigned elsewhere cannot create author work from feedback or failed checks", async t => {
  for (const overrides of [
    { reviewDecision: 'CHANGES_REQUESTED', reviewFeedbackAvailable: true, reviewFeedbackCount: 1 },
    { mergeStateStatus: 'DIRTY' },
    { ciStatus: 'FAILURE' },
    { isDraft: true },
    { reviewFactsAvailable: false, headRefOid: null, ciStatus: 'UNKNOWN' },
  ]) await t.test(JSON.stringify(overrides), () => {
    const result = assess({ ...overrides, assignees: ['reviewer'] });
    assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
    assert.equal(result.nextActor, 'assignee');
    assert.equal(result.requiresConfirmation, false);
  });
  assert.equal(assess({ assignees: ['LOCAL-OWNER'], ciStatus: 'FAILURE' }).actionState, ACTION_STATES.ACTION_NOW);
});

test("a recent assigned PR without my review needs my review now", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextActor, "me");
  assert.equal(result.nextAction, "review");
  assert.equal(result.requiresConfirmation, false);
});

test("a new head commit after my review needs my re-review", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    myReviewState: "APPROVED",
    myReviewCommitOid: "reviewed-head",
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextAction, "rereview");
});

test("a Comment on the current Head reports unfinished review instead of an unreviewed new commit", () => {
  const result = assess({ relation: "review_requested", author: "contributor",
    myReviewState: "CHANGES_REQUESTED", myReviewCommitOid: "old-head",
    myLatestPublishedReviewState: "COMMENTED", myLatestPublishedReviewCommitOid: "head-2" });
  assert.equal(result.nextAction, "complete_review");
  assert.match(result.actionReasons[0], /当前提交已复审评论/);
});

test("a later incoming Assign starts a new review round even when the Head did not change", () => {
  for (const state of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]) {
    const facts = { relation: "review_requested", author: "contributor", myReviewState: state, myReviewCommitOid: "head-2",
      myLatestPublishedReviewState: state, myLatestPublishedReviewCommitOid: "head-2",
      myLatestPublishedReviewAt: "2026-07-30T10:00:00Z", incomingReviewFactsAvailable: true,
      reviewRecipient: currentUser, reviewReceivedFrom: "contributor", reviewReceivedVia: "assignee",
      reviewRequestEventId: "assign-again", reviewReceivedAt: "2026-07-31T08:00:00Z" };
    assert.equal(assess(facts).nextAction, "rereview");
    for (const patch of [{ reviewReceivedAt: "2026-07-30T09:00:00Z" }, { reviewReceivedAt: "2026-07-31T10:00:00Z" },
      { reviewReceivedFrom: currentUser }, { incomingReviewFactsAvailable: false }, { reviewRequestEventId: null }]) {
      assert.notEqual(assess({ ...facts, ...patch }).nextAction, "rereview");
    }
  }
});

test("taking live responsibility again after a published Review requests rereview on the same Head", () => {
  const facts = { relation: "review_requested", author: "contributor", assignees: [currentUser],
    myReviewState: "CHANGES_REQUESTED", myReviewCommitOid: "head-2", myLatestPublishedReviewState: "CHANGES_REQUESTED",
    myLatestPublishedReviewCommitOid: "head-2", myLatestPublishedReviewAt: "2026-07-30T10:00:00Z",
    incomingReviewFactsAvailable: true, reviewRecipient: currentUser, reviewReceivedFrom: currentUser,
    reviewReceivedVia: "assignee", reviewRequestEventId: "self-assign-again", reviewReceivedAt: "2026-07-31T08:00:00Z" };
  const result = assess(facts);
  assert.equal(result.nextAction, "rereview");
  assert.equal(result.nextActor, "me");
  assert.notEqual(assess({ ...facts, assignees: ["contributor"] }).nextAction, "rereview");
});

test("a later Comment cannot undo a decisive verdict on the same Head", () => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED"]) {
    const result = assess({ relation: "review_requested", author: "contributor",
      myReviewState: state, myReviewCommitOid: "head-2",
      myLatestPublishedReviewState: "COMMENTED", myLatestPublishedReviewCommitOid: "head-2" });
    assert.equal(result.nextAction, state === "APPROVED" ? "wait_merge" : "wait_author_changes");
  }
});

test("fresh current-Head publication facts fill a missing or older detail Review summary", () => {
  const missing = assess({ relation: "review_requested", author: "contributor",
    myLatestPublishedReviewState: "COMMENTED", myLatestPublishedReviewCommitOid: "head-2" });
  assert.equal(missing.nextAction, "complete_review");
  const approved = assess({ relation: "review_requested", author: "contributor",
    myReviewState: "CHANGES_REQUESTED", myReviewCommitOid: "old-head", myReviewAt: "2026-07-20T00:00:00Z",
    myLatestPublishedReviewState: "APPROVED", myLatestPublishedReviewCommitOid: "head-2", myLatestPublishedReviewAt: "2026-07-30T00:00:00Z" });
  assert.equal(approved.nextAction, "wait_merge");
});

test("historical change requests with resolved threads require verification without asserting an unfixed defect", () => {
  const result = assess({ reviewDecision: "CHANGES_REQUESTED", reviewFeedbackAvailable: true,
    reviewFeedbackCount: 1, reviewPendingThreadCount: 0, reviewChangeRequestCount: 1,
    outstandingChangeRequestCommitOids: ["old-head"] });
  assert.equal(result.nextAction, "address_review");
  assert.match(result.actionReasons[0], /历史修改要求.*核验/);
  assert.doesNotMatch(result.actionReasons[0], /尚未解决|尚未处理/);
});

test("a verified publication covering current feedback waits for review, retaining open discussion facts", () => {
  const result = assess({ reviewDecision: "CHANGES_REQUESTED", reviewFeedbackAvailable: true,
    reviewFeedbackCount: 2, reviewFeedbackDigest: "f".repeat(64), reviewPendingThreadCount: 1,
    reviewRepairProgress: { status: "published", headRefOid: "head-2", feedbackDigest: "f".repeat(64), commitOids: ["a".repeat(40)] } });
  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "reviewer");
  assert.equal(result.nextAction, "wait_review");
  assert.match(result.actionReasons[0], /修复已发布.*当前提交复审/);
  assert.match(result.actionReasons[0], /讨论未关闭/);
});

test("stale publication progress cannot hide new feedback or a different Head", () => {
  for (const progress of [
    { headRefOid: "old-head", feedbackDigest: "f".repeat(64) },
    { headRefOid: "head-2", feedbackDigest: "e".repeat(64) },
  ]) {
    const result = assess({ reviewDecision: "CHANGES_REQUESTED", reviewFeedbackAvailable: true,
      reviewFeedbackCount: 1, reviewFeedbackDigest: "f".repeat(64),
      reviewRepairProgress: { status: "published", commitOids: ["a".repeat(40)], ...progress } });
    assert.equal(result.nextAction, "address_review");
  }
});

test("changes I requested without a new commit are waiting on the author", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    myReviewState: "CHANGES_REQUESTED",
    myReviewCommitOid: "head-2",
  });

  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "author");
  assert.equal(result.nextAction, "wait_author_changes");
});

test("an assigned draft or conflicting head waits on the author before review", () => {
  const draft = assess({
    relation: "review_requested",
    author: "contributor",
    isDraft: true,
  });
  const conflict = assess({
    relation: "review_requested",
    author: "contributor",
    mergeStateStatus: "DIRTY",
  });
  assert.equal(draft.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(conflict.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(draft.nextActor, "author");
});

test("failed checks still require Review and a warning to the author", () => {
  for (const ciStatus of ["FAILURE", "ERROR"]) {
    const input = { relation: "review_requested", author: "contributor", ciStatus };
    const result = assess(input);
    assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
    assert.equal(result.nextActor, "me");
    assert.equal(result.nextAction, "review");
    assert.ok(result.actionReasons.some(reason => reason.includes("检查失败")));
    const approved = assess({ ...input, myReviewState: "APPROVED", myReviewCommitOid: "head-2" });
    assert.equal(approved.nextAction, "wait_merge", "failed CI does not erase a completed review");
  }
});

test("an authored PR with unresolved review feedback needs my action", () => {
  const result = assess({
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "head-2",
    latestChangeRequestCommitOid: "head-2",
    outstandingChangeRequestCommitOids: ["head-2"],
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextActor, "me");
  assert.equal(result.nextAction, "address_review");
});

test("new commits alone do not resolve requested changes on an authored PR", () => {
  const result = assess({
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "reviewed-head",
    latestChangeRequestCommitOid: "reviewed-head",
    outstandingChangeRequestCommitOids: ["reviewed-head"],
  });

  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(result.nextActor, "me");
  assert.equal(result.nextAction, "address_review");
});

test("unresolved inline feedback on an authored PR starts repair even with an approval or draft", () => {
  for (const overrides of [{ reviewDecision: "APPROVED" }, { isDraft: true }, { ciStatus: "FAILURE" }]) {
    const result = assess({ ...overrides, reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: "a".repeat(64) });
    assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
    assert.equal(result.nextAction, "address_review");
  }
});

test("authored merged and closed PRs cannot become actionable from remaining feedback", () => {
  for (const state of ["merged", "closed"]) {
    assert.equal(assess({ state, reviewFeedbackAvailable: true, reviewFeedbackCount: 1 }).actionState, ACTION_STATES.HISTORICAL);
  }
});

test("own feedback with a merge conflict routes to conflict preparation before ordinary repair", () => {
  const result = assess({ mergeStateStatus: "DIRTY", reviewFeedbackAvailable: true, reviewFeedbackCount: 1 });
  assert.equal(result.nextAction, "resolve_conflict");
  assert.equal(result.actionState, ACTION_STATES.ACTION_NOW);
});

test("failed own-feedback reads cannot infer repairs from a request-changes summary", () => {
  assert.equal(assess({ reviewFeedbackAvailable: false, reviewDecision: "CHANGES_REQUESTED", outstandingChangeRequestCommitOids: ["head-2"] }).actionState, ACTION_STATES.UNCERTAIN);
});

test("current authored blockers override an old change request", () => {
  const oldChangeRequest = {
    reviewDecision: "CHANGES_REQUESTED",
    latestOtherDecisionState: "CHANGES_REQUESTED",
    latestOtherDecisionCommitOid: "reviewed-head",
    latestChangeRequestCommitOid: "reviewed-head",
    outstandingChangeRequestCommitOids: ["reviewed-head"],
  };
  const conflict = assess({
    ...oldChangeRequest,
    mergeStateStatus: "DIRTY",
  });
  const failed = assess({
    ...oldChangeRequest,
    ciStatus: "FAILURE",
  });
  const draft = assess({
    ...oldChangeRequest,
    isDraft: true,
  });

  assert.equal(conflict.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(conflict.nextAction, "resolve_conflict");
  assert.equal(failed.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(failed.nextAction, "fix_ci");
  assert.equal(draft.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(draft.nextAction, "continue_draft");
});

test("merge conflicts and failing CI remain my authored actions", () => {
  const conflict = assess({ mergeStateStatus: "DIRTY" });
  const failed = assess({ ciStatus: "FAILURE" });

  assert.equal(conflict.nextAction, "resolve_conflict");
  assert.equal(failed.nextAction, "fix_ci");
  assert.equal(conflict.actionState, ACTION_STATES.ACTION_NOW);
  assert.equal(failed.actionState, ACTION_STATES.ACTION_NOW);
});

test("an approved authored PR waits for merge instead of claiming modification work", () => {
  const result = assess({
    reviewDecision: "APPROVED",
    latestOtherDecisionState: "APPROVED",
    latestOtherDecisionCommitOid: "head-2",
  });

  assert.equal(result.actionState, ACTION_STATES.WAITING_OTHER);
  assert.equal(result.nextActor, "merge_owner");
  assert.equal(result.nextAction, "wait_merge");
});

test("long inactive PRs go to cleanup even when their old CI failed", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    updatedAt: "2026-05-31T08:59:59.000Z",
    ciStatus: "FAILURE",
  });

  assert.equal(result.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(result.nextAction, "cleanup");
});

test("missing review facts are surfaced for confirmation instead of guessed", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    reviewFactsAvailable: false,
  });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
  assert.equal(result.requiresConfirmation, true);
});

test("a successful detail response without a head commit is still uncertain", () => {
  const result = assess({
    relation: "review_requested",
    author: "contributor",
    headRefOid: "",
  });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
});

test("closed and malformed PR records never enter the active queue", () => {
  const closed = assess({ state: "closed" });
  const malformed = assess({ updatedAt: "not-a-date" });

  assert.equal(closed.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(malformed.actionState, ACTION_STATES.UNCERTAIN);
});

test("the historical boundary starts at exactly sixty days", () => {
  const stillActive = assess({
    updatedAt: "2026-06-01T09:00:01.000Z",
  });
  const historical = assess({
    updatedAt: "2026-06-01T09:00:00.000Z",
  });

  assert.notEqual(stillActive.actionState, ACTION_STATES.HISTORICAL);
  assert.equal(historical.actionState, ACTION_STATES.HISTORICAL);
});

test("unknown CI state requires confirmation", () => {
  const result = assess({ ciStatus: "UNKNOWN" });

  assert.equal(result.actionState, ACTION_STATES.UNCERTAIN);
});
