import assert from "node:assert/strict";
import test from "node:test";

import { withPrLifecycleRoutes } from "../src/domain/pr-lifecycle-routing.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";
import { assessPullRequestResponsibility } from "../src/domain/pr-responsibility.js";
import { workflowEventsFromSnapshots } from "../src/domain/workflow-snapshot-events.js";
import { createPullRequestWorkSource, appendPullRequestWorkSource } from "../src/services/work-ledger-pr-source.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";

function pullRequestEvent(overrides = {}) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.status",
    occurredAt: "2026-08-27T06:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "PR 42",
      relation: "authored",
      state: "open",
      actionState: "action_now",
      nextAction: "address_review",
      ...overrides,
    },
  });
}

function definition() {
  return withPrLifecycleRoutes({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [{
      id: "generic-pr-route",
      source: "root",
      enabled: true,
      priority: 100,
      fallback: false,
      condition: {
        op: "equals",
        path: "eventType",
        value: "pull_request.status",
      },
      targets: [{ type: "role", id: "pr-engineer" }],
      onMatch: "stop",
    }],
  });
}

test("external review feedback on my PR routes directly to the developer", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent(),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "developer" },
  ]);
});

test("inline review feedback routes from real snapshot facts to a revisable developer PR root", () => {
  const headRefOid = "a".repeat(40);
  const item = {
    id: "github:pr:acme/repo#42", kind: "pull_request", repo: "acme/repo", number: 42,
    title: "Own PR", author: "local-owner", currentUser: "local-owner", relation: "authored",
    state: "open", updatedAt: "2026-08-27T05:00:00.000Z", headRefOid,
    reviewFactsAvailable: true, ciStatus: "NONE", mergeStateStatus: "CLEAN", isDraft: false,
  };
  const buildItem = (commentId) => {
    const feedback = summarizeOwnReviewFeedback({ reviews: [], threads: [{ id: commentId, path: "example.js", line: 1, isResolved: false, isOutdated: false, comments: [{ id: commentId, author: { login: "reviewer" }, body: "Fix this empty access", createdAt: "2026-08-27T05:30:00Z" }] }] }, "local-owner");
    const facts = { ...item, ...feedback };
    return { ...facts, ...assessPullRequestResponsibility(facts, { now: "2026-08-27T06:00:00.000Z" }) };
  };
  const snapshot = (feedbackItem, refreshedAt) => ({ refreshedAt, items: [feedbackItem], sourceStatus: { githubPullRequests: { ok: true, stale: false } } });
  const firstSnapshot = snapshot(buildItem("comment-1"), "2026-08-27T06:00:00.000Z");
  const [first] = workflowEventsFromSnapshots(null, firstSnapshot, { sourceScopeId: "dashboard" });
  const route = (event) => ({
    ...routeWorkflowEvent({ event, config: definition() }).assignments[0],
    assignmentId: `assignment-${event.eventId}`,
    eventId: event.eventId,
    createdAt: event.occurredAt,
  });
  const firstAssignment = route(first);
  assert.deepEqual(firstAssignment.target, { type: "role", id: "developer" });
  const initial = createPullRequestWorkSource({ sequence: 1, assignment: firstAssignment, event: first }).source;
  const nextSnapshot = snapshot(buildItem("comment-2"), "2026-08-27T07:00:00.000Z");
  const [next] = workflowEventsFromSnapshots(firstSnapshot, nextSnapshot, { sourceScopeId: "dashboard" });
  const updated = appendPullRequestWorkSource(initial, { sequence: 2, assignment: route(next), event: next });
  assert.equal(updated.activeAdvanced, true);
  assert.equal(updated.headAdvanced, false);
  assert.equal(updated.source.inputRevision, 2);
  assert.equal(updated.source.current.headRefOid, headRefOid);
  assert.notEqual(updated.source.current.inputDigest, initial.current.inputDigest);
});

test("another author's PR and my waiting PR remain with the PR engineer", () => {
  for (const event of [
    pullRequestEvent({
      relation: "review_requested",
      nextAction: "review",
    }),
    pullRequestEvent({
      actionState: "waiting_other",
      nextAction: "wait_rereview",
    }),
  ]) {
    const routed = routeWorkflowEvent({ event, config: definition() });
    assert.deepEqual(routed.assignments.map(({ target }) => target), [
      { type: "role", id: "pr-engineer" },
    ]);
  }
});

test("my PR enters testing after an external reviewer approves the current Head", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent({
      actionState: "waiting_other",
      nextAction: "wait_merge",
      reviewDecision: "APPROVED",
    }),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "tester" },
  ]);
});

test("another author's approved PR does not create an automatic local tester route", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent({
      relation: "review_requested",
      actionState: "waiting_other",
      nextAction: "wait_merge",
      myReviewState: "APPROVED",
    }),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "pr-engineer" },
  ]);
});
