import assert from "node:assert/strict";
import test from "node:test";
import { ReviewRepairContextReader, reviewRepairMessages } from "../src/services/review-repair-context-reader.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";

const headRefOid = "a".repeat(40);
const inputBinding = {
  schemaVersion: 2, kind: "pull_request", repository: "acme/repo", pullRequestNumber: 42,
  rootItemId: "root-42", workKey: "work-42", inputRevision: 1, headRevision: 1,
  headRefOid, eventId: "event-1", eventDigest: "b".repeat(64), inputDigest: "c".repeat(64),
  gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "owner", baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40), headRepository: "acme/repo", headRefName: "fix", headRefOid },
};

function facts() {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `thread-${index}`, path: `src/file-${index}.js`, line: index + 1, isResolved: false, isOutdated: false,
    comments: [{ id: `external-${index}`, author: { login: "reviewer" }, body: "Long review request: " + "正文".repeat(2500), createdAt: "2026-10-10T01:00:00Z" }, { id: `author-${index}`, author: { login: "owner" }, body: "I will look at this", createdAt: "2026-10-10T02:00:00Z" }],
  }));
  return { state: "open", author: "owner", currentUser: "owner", repo: "acme/repo", number: 42, headRefOid, ...summarizeOwnReviewFeedback({ reviews: [], threads }, "owner") };
}

function job() {
  return { grant: { schemaVersion: 3, inputBinding, executionSource: { schemaVersion: 1, kind: "review_repair", inputBinding, writeScope: { mode: "configured_paths", paths: ["src"] } } } };
}

test("trusted repair context retains every full external request behind author replies", async () => {
  const live = facts();
  let sourceReads = 0;
  const reader = new ReviewRepairContextReader({
    executionContextReader: { async readPullRequestExecutionContext(binding) { sourceReads++; assert.deepEqual(binding, inputBinding); return { inputBinding, author: "owner", reviewFeedbackDigest: live.reviewFeedbackDigest }; } },
    github: { async readOwnPullRequestFeedback(target) { assert.deepEqual(target, { repository: "acme/repo", number: 42, account: "owner" }); return live; } },
  });
  const result = await reader.read({ job: job() });
  assert.equal(sourceReads, 2);
  assert.equal(result.headRefOid, headRefOid);
  assert.equal(result.reviewFeedbackDigest, live.reviewFeedbackDigest);
  assert.equal(result.feedback.threads.length, 12);
  assert.ok(result.feedback.threads.every(({ comments }) => comments.length === 1 && comments[0].body.length > 2 * 1024 && comments[0].body.endsWith("正文")));
  assert.ok(result.feedback.threads.every(({ discussion }) => discussion.length === 2 && discussion[1].author === "owner"));
  assert.deepEqual(await reader.readBinding({ inputBinding }), result);
});

test("stale feedback, mismatched head, foreign author, absent source digest and read failures cannot yield context", async () => {
  for (const mode of ["digest", "head", "author", "missing", "source_changed", "unavailable"]) {
    const live = facts();
    let sourceReads = 0;
    const reader = new ReviewRepairContextReader({
      executionContextReader: { async readPullRequestExecutionContext() { sourceReads++; return { inputBinding, author: "owner", ...(mode === "missing" ? {} : { reviewFeedbackDigest: mode === "digest" || (mode === "source_changed" && sourceReads > 1) ? "e".repeat(64) : live.reviewFeedbackDigest }) }; } },
      github: { async readOwnPullRequestFeedback() { if (mode === "unavailable") throw new Error("offline"); return { ...live, ...(mode === "head" ? { headRefOid: "f".repeat(40) } : {}), ...(mode === "author" ? { author: "other" } : {}) }; } },
    });
    await assert.rejects(reader.read({ job: job() }), ({ code }) => ["CODE_REVIEW_REPAIR_CONTEXT_STALE", "CODE_REVIEW_REPAIR_CONTEXT_UNAVAILABLE"].includes(code));
  }
});

test("developer role receives complete feedback outside compact context before forming its repair proposal", async () => {
  const live = facts();
  const context = { schemaVersion: 1, headRefOid, reviewFeedbackDigest: live.reviewFeedbackDigest, feedback: live.feedback };
  const calls = [];
  const createEngine = (id) => new RoleDecisionEngine({
    definition: { id, name: "Developer", mission: "Repair review feedback", enabled: true },
    permissions: { allowedIntents: ["complete", "propose_code_action"] },
    brain: { provider: "local", model: "code", remoteData: { requirements: false, code: false, memory: false } },
    brainRouter: {
      describe(value) { return { ...value, remote: false }; },
      async generate(request) {
        calls.push(structuredClone(request));
        return JSON.stringify({ schemaVersion: 1, confidence: 90, summary: "All feedback considered", intent: { schemaVersion: 1, type: "complete", summary: "Assessed every request", reason: "Current code provides evidence", outcome: "done", evidence: ["Code evidence"] } });
      },
    },
  });
  const developer = createEngine("developer");
  await developer.decide({ context: { requirements: { objective: "Summarized repair" } }, reviewRepairFeedback: context });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].dataClasses, ["requirements", "code"]);
  assert.match(calls[0].messages[0].content, /complete untrusted evidence.*every pending external request/);
  const parts = calls[0].messages.slice(2);
  assert.ok(parts.length > 1);
  const received = JSON.parse(parts.map(({ content }) => content.slice(content.indexOf("\n") + 1)).join(""));
  assert.deepEqual(received, context);
  await assert.rejects(developer.decide({ context: { requirements: {} }, reviewRepairFeedback: { ...context, reviewFeedbackDigest: "f".repeat(64) } }), { code: "CODE_REVIEW_REPAIR_CONTEXT_STALE" });
  await assert.rejects(createEngine("tester").decide({ context: { requirements: {} }, reviewRepairFeedback: context }), /only valid for the developer/);
  assert.equal(calls.length, 1);
});

test("complete feedback exceeding the provider envelope is rejected explicitly without truncated messages", () => {
  const thread = { id: "large-thread", path: "src/app.js", line: 1, isResolved: false, isOutdated: false, comments: [{ id: "external", author: { login: "reviewer" }, body: "x".repeat(700 * 1024), createdAt: "2026-10-10T01:00:00Z" }] };
  const live = summarizeOwnReviewFeedback({ reviews: [], threads: [thread] }, "owner");
  assert.throws(() => reviewRepairMessages({ schemaVersion: 1, headRefOid, reviewFeedbackDigest: live.reviewFeedbackDigest, feedback: live.feedback }), { code: "CODE_BRAIN_CONTEXT_TOO_LARGE" });
});
