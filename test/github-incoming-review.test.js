import assert from "node:assert/strict";
import test from "node:test";
import { projectIncomingReview } from "../src/adapters/github-incoming-review.js";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { automaticReviewEligibility } from "../src/domain/automatic-review-policy.js";
const event = (type, at, extra = {}) => ({ __typename: type, id: `event-${type}`, createdAt: at, actor: { login: "dev" }, ...extra });
test("receipt time follows assignment and ignores newer review requests", () => {
  const pr = { reviews: { nodes: [] }, assignees: { nodes: [{ login: "me" }] }, reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
    timelineItems: { nodes: [event("AssignedEvent", "2026-10-01T00:00:00Z", { assignee: { login: "me" } }), event("ReviewRequestedEvent", "2026-10-09T00:00:00Z", { requestedReviewer: { login: "ME" } })] } };
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, "2026-10-01T00:00:00Z");
  pr.timelineItems.nodes.push(event("ReviewRequestRemovedEvent", "2026-10-09T01:00:00Z", { requestedReviewer: { login: "me" } }));
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, "2026-10-01T00:00:00Z");
  pr.assignees.nodes = [];
  assert.equal(projectIncomingReview(pr, "me").reviewRecipient, null);
});

test("a new Review round requires reassignment after unassignment, even with an outstanding review request", () => {
  const firstHead = "a".repeat(40);
  const nextHead = "b".repeat(40);
  const pr = {
    reviews: { nodes: [] },
    assignees: { nodes: [{ login: "me" }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
    timelineItems: { nodes: [
      event("AssignedEvent", "2026-10-08T08:00:00Z", { id: "assignment-1", assignee: { login: "me" } }),
      event("ReviewRequestedEvent", "2026-10-08T08:30:00Z", { requestedReviewer: { login: "me" } }),
    ] },
  };
  const facts = (head, myReviewState = null) => ({
    kind: "pull_request", state: "open", isDraft: false, author: "dev",
    headRefOid: head, ciStatus: "SUCCESS", myReviewState, myReviewCommitOid: firstHead,
    ...projectIncomingReview(pr, "me"),
  });
  assert.equal(automaticReviewEligibility(facts(firstHead), "me", "2026-10-08T09:00:00Z"), null);
  for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) {
    pr.reviews.nodes = [{ author: { login: "me" }, state, submittedAt: "2026-10-08T09:00:00Z", commit: { oid: firstHead } }];
    assert.equal(automaticReviewEligibility(facts(nextHead, state), "me", "2026-10-08T09:30:00Z"), "ASSIGNMENT_ALREADY_REVIEWED", "a new commit cannot reuse a reviewed assignment while handoff is pending");
  }
  pr.assignees.nodes = [];
  pr.timelineItems.nodes.push(event("UnassignedEvent", "2026-10-08T09:00:00Z", { assignee: { login: "me" } }));
  for (const verdict of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) {
    assert.equal(automaticReviewEligibility(facts(nextHead, verdict), "me", "2026-10-09T10:00:00Z"), "NO_CURRENT_INCOMING_REQUEST");
  }
  pr.assignees.nodes = [{ login: "ME" }];
  pr.timelineItems.nodes.push(event("AssignedEvent", "2026-10-09T09:00:00Z", { id: "assignment-2", assignee: { login: "me" } }));
  for (const verdict of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]) {
    const current = facts(nextHead, verdict);
    assert.equal(current.reviewRequestEventId, "assignment-2");
    assert.equal(current.reviewReceivedAt, "2026-10-09T09:00:00Z");
    assert.equal(automaticReviewEligibility(current, "me", "2026-10-09T10:00:00Z"), null);
  }
});

test("reviewer-only requests do not start an automatic Review round", () => {
  const pr = {
    reviews: { nodes: [] },
    assignees: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
    timelineItems: { nodes: [event("ReviewRequestedEvent", "2026-10-09T00:00:00Z", { requestedReviewer: { login: "me" } })] },
  };
  assert.equal(projectIncomingReview(pr, "me").reviewRecipient, null);
  assert.equal(projectIncomingReview(pr, "me").reviewRequestEventId, null);
});

test("a newer Comment consumes the assignment even when an older decisive Review exists", () => {
  const pr = {
    assignees: { nodes: [{ login: "me" }] },
    timelineItems: { nodes: [event("AssignedEvent", "2026-10-09T09:00:00Z", { assignee: { login: "me" } })] },
    reviews: { nodes: [
      { author: { login: "me" }, state: "APPROVED", submittedAt: "2026-10-08T09:00:00Z" },
      { author: { login: "ME" }, state: "COMMENTED", submittedAt: "2026-10-09T09:30:00Z" },
      { author: { login: "other" }, state: "APPROVED", submittedAt: "2026-10-09T09:45:00Z" },
      { author: { login: "me" }, state: "PENDING", submittedAt: null },
    ] },
  };
  assert.equal(projectIncomingReview(pr, "me").myLatestPublishedReviewAt, "2026-10-09T09:30:00Z");
});

test("latest published Review state and Head stay paired with its publication time", () => {
  const pr = { assignees: { nodes: [] }, timelineItems: { nodes: [] }, reviews: { nodes: [
    { author: { login: "me" }, state: "CHANGES_REQUESTED", submittedAt: "2026-10-08T00:00:00Z", commit: { oid: "old-head" } },
    { author: { login: "me" }, state: "COMMENTED", submittedAt: "2026-10-09T00:00:00Z", commit: { oid: "current-head" } },
    { author: { login: "me" }, state: "PENDING", submittedAt: null, commit: { oid: "pending-head" } },
  ] } };
  const facts = projectIncomingReview(pr, "me");
  assert.equal(facts.myLatestPublishedReviewState, "COMMENTED");
  assert.equal(facts.myLatestPublishedReviewCommitOid, "current-head");
});
test("bounded timeline without a matching event cannot invent a receipt time", () => {
  const pr = { reviews: { nodes: [] }, assignees: { nodes: [{ login: "me" }] }, reviewRequests: { nodes: [] }, timelineItems: { nodes: [], pageInfo: { hasPreviousPage: true } } };
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, null);
});
test("reviewer-only PRs are excluded from personal discovery before enrichment", async () => {
  let details = 0;
  const record = { number: 1, title: "fix", url: "https://github.com/acme/repo/pull/1", repository: { nameWithOwner: "acme/repo" }, author: { login: "dev" }, state: "open" };
  const target = { number: 1, url: record.url, state: "OPEN", author: record.author, changedFiles: 1,
    baseRefName: "main", baseRefOid: "a".repeat(40), headRefName: "fix/review", headRefOid: "b".repeat(40),
    headRepository: { nameWithOwner: "acme/repo" } };
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTargets {"))) {
      return { data: { r0: { nameWithOwner: "acme/repo", pullRequest: { ...target,
        baseRef: { name: target.baseRefName, repository: record.repository, target: { oid: target.baseRefOid } },
        headRef: { name: target.headRefName, repository: target.headRepository, target: { oid: target.headRefOid } },
      } } } };
    }
    if (args[0] === "api") return { login: "me" };
    if (args[0] === "search") return args.includes("--review-requested=@me") ? [record] : [];
    details++;
    return { ...target, reviews: [], labels: [], assignees: [], statusCheckRollup: [] };
  } });
  assert.deepEqual(await adapter.searchRelevantPullRequests(), []);
  assert.equal(details, 0);
});
