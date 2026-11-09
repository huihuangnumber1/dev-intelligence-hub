import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { createPullRequestReadFacts, createPullRequestReadIdentity, projectPullRequestReadFactsContext } from "../src/domain/pull-request-read-facts.js";
import { BoundReviewFeedbackReader } from "../src/services/bound-review-feedback-reader.js";
import { isReviewSourceFailure } from "../src/domain/review-source-failure.js";

function fixture() {
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo",
    baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "contributor/repo", headRefName: "fix/42", headRefOid: "b".repeat(40) };
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: "2026-10-28T05:00:00.000Z",
    source: { provider: "github", scopeId: "github-account:reviewer" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { gitTarget, gitTargetAvailable: true, headRefOid: gitTarget.headRefOid } });
  const inputBinding = createPullRequestExecutionBinding({ event, sourceBinding: { kind: "pull_request", rootItemId: "review-root",
    workKey: "review-42", inputRevision: 1, headRevision: 1, headRefOid: gitTarget.headRefOid,
    eventId: event.eventId, eventDigest: event.contentDigest, inputDigest: "c".repeat(64) } });
  const factsInput = { identity: createPullRequestReadIdentity({ executionBinding: inputBinding, event }), observedAt: "2026-10-28T05:01:00.000Z",
    reviewDecision: "APPROVED", comments: [{ id: "IC_1", author: "developer", body: "Complete test evidence "+"text ".repeat(4000),
      createdAt: "2026-10-28T05:00:00.000Z", updatedAt: "2026-10-28T05:00:00.000Z", bodyTruncated: false,
      url: "https://github.com/acme/repo/pull/42#issuecomment-1" }], reviews: [], reviewThreads: [], checks: [],
    truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } };
  const facts = createPullRequestReadFacts(factsInput);
  const task = { taskId: "review-child", roleId: "pr-engineer", status: "working", inputBinding, event };
  const request = { taskId: task.taskId, materialDigest: projectPullRequestReadFactsContext(facts).materialDigest,
    gitTarget, pullRequestNumber: 42 };
  let reads = 0; let verifications = 0;
  const reader = new BoundReviewFeedbackReader({ taskReader: { async read() { return structuredClone(task); } },
    factsReader: { async refresh(value) { reads++; assert.deepEqual(value.executionBinding, inputBinding); return facts; } },
    inputAuthorityVerifier: { async verify(value) { verifications++; return value; } } });
  return { reader, task, request, facts, factsInput, counts: () => ({ reads, verifications }) };
}

test("review feedback reads full fresh material under the current task authority", async () => {
  const f = fixture(); const result = await f.reader.read(f.request);
  assert.equal(result.comments[0].body, f.facts.comments[0].body);
  assert.ok(result.comments[0].body.length > 16000);
  assert.deepEqual(f.counts(), { reads: 1, verifications: 2 });
});

test("changed target and material are internal read failures, not an incomplete review result", async () => {
  const f = fixture();
  await assert.rejects(f.reader.read({ ...f.request, gitTarget: { ...f.request.gitTarget, baseRefOid: "d".repeat(40) } }),
    { code: "PR_REVIEW_READ_HEAD_CHANGED" });
  assert.equal(f.counts().reads, 0);
  await assert.rejects(f.reader.read({ ...f.request, materialDigest: "0".repeat(64) }), { code: "PR_REVIEW_READ_MATERIAL_CHANGED" });
});

test("parent verification may capture fresh facts while model reading still requires an exact material digest", async () => {
  const f = fixture(); const { materialDigest, ...currentRequest } = f.request;
  assert.deepEqual(await f.reader.readCurrent(currentRequest), f.facts);
  await assert.rejects(f.reader.read(currentRequest));
  await assert.rejects(f.reader.readCurrent({ ...currentRequest, gitTarget: { ...currentRequest.gitTarget, headRefOid: "0".repeat(40) } }),
    { code: "PR_REVIEW_READ_HEAD_CHANGED" });
  assert.equal(f.counts().reads, 1);
});

test("the production ledger adapter resolves an inherited review binding and rejects paused work", async () => {
  const f = fixture();
  const { schemaVersion, repository, pullRequestNumber, gitTarget, ...sourceBinding } = f.task.inputBinding;
  const item = { itemId: f.task.taskId, revision: 7, kind: "graph_task", currentTarget: { type: "role", id: "pr-engineer" },
    sourceQuarantine: null, status: "working", event: f.task.event, assignment: { graphTask: { sourceBinding } } };
  let refreshes = 0;
  const reader = new BoundReviewFeedbackReader({ ledger: { async readItemForReconciliation(input) {
    assert.deepEqual(input, { itemId: f.task.taskId }); return structuredClone(item);
  } }, factsReader: { async refresh(input) {
    refreshes++; assert.deepEqual(input.executionBinding, f.task.inputBinding); return f.facts;
  } }, inputAuthorityVerifier: { async verify(input) { return input; } } });
  assert.deepEqual(await reader.read(f.request), f.facts);
  item.status = "paused";
  await assert.rejects(reader.read(f.request), { code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE" });
  assert.equal(refreshes, 1);
});

for (const boundary of ["task", "authority", "facts"])
test(`bound feedback reader owns raw ${boundary} failures and preserves cancellation`, async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error("caller cancellation");
  let cancel = false;
  const fail = () => { if (cancel) controller.abort(reason); throw new Error("private source response"); };
  const reader = new BoundReviewFeedbackReader({
    taskReader: { async read() { if (boundary === "task") fail(); return f.task; } },
    inputAuthorityVerifier: { async verify(value) { if (boundary === "authority") fail(); return value; } },
    factsReader: { async refresh() { if (boundary === "facts") fail(); return f.facts; } },
  });
  await assert.rejects(reader.read(f.request), error => {
    assert.equal(isReviewSourceFailure(error), true);
    assert.equal(error.code, "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE");
    assert.equal(error.message, "PR review feedback is unavailable");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
  cancel = true;
  await assert.rejects(reader.read(f.request, { signal: controller.signal }), error => error === reason);
});
