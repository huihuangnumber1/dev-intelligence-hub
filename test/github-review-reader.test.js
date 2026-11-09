import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReviewReader, consumeCompletedReviewRead } from "../src/adapters/github-review-reader.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";
import { createOriginalRepairFeedbackSnapshot } from "../src/domain/original-repair-feedback.js";
import { isReviewSourceFailure } from "../src/domain/review-source-failure.js";

const TARGET = { pullRequestNumber: 42, gitTarget: {
  schemaVersion: 1, provider: "github", sourceAccountId: "reviewer",
  baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40),
  headRepository: "contributor/repo", headRefName: "feature", headRefOid: "b".repeat(40),
} };

function fixture({ changed = 117, moved = false, movedBase = false, missingFile = false, missingDiff = false, liveBase = TARGET.gitTarget.baseRefOid, onCompleteReviewRead = null } = {}) {
  const calls = [];
  const files = Array.from({ length: changed }, (_, i) => ({ filename: `src/${i}.js`, status: "modified", additions: 2, deletions: 1 }));
  const diff = files.slice(0, missingDiff ? -1 : undefined).map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n-old\n+${"new ".repeat(180)}\n`).join("");
  let metadataCalls = 0;
  const run = async (command, args) => {
    assert.equal(command, "gh");
    calls.push(args);
    const endpoint = args[3];
    if (endpoint === "graphql") { metadataCalls += 1; const headOid = moved && metadataCalls > 1 ? "c".repeat(40) : TARGET.gitTarget.headRefOid; return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: {
      number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN", author: { login: "contributor" }, changedFiles: changed,
      baseRefName: "main", baseRefOid: TARGET.gitTarget.baseRefOid,
      baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: movedBase && metadataCalls > 1 ? "d".repeat(40) : liveBase } },
      headRefName: "feature", headRefOid: headOid,
      headRef: { name: "feature", repository: { nameWithOwner: "contributor/repo" }, target: { oid: headOid } },
      headRepository: { nameWithOwner: "contributor/repo" },
    } } } }; }
    if (endpoint === "user") return { login: "reviewer" };
    if (endpoint === "repos/acme/repo/pulls/42") return { number: 42, title: "Fixture PR", body: "", html_url: "https://github.com/acme/repo/pull/42",
      head: { sha: TARGET.gitTarget.headRefOid }, base: { repo: { full_name: "acme/repo" } } };
    if (endpoint === "repos/acme/repo/pulls/42/files?per_page=100") {
      assert.ok(args.includes("--paginate"));
      return [files.slice(0, 100), files.slice(100, missingFile ? -1 : undefined)];
    }
    if (endpoint.includes("/contents/")) {
      if (endpoint.includes("/contents/?")) return [{ type: "file", path: "src/related.js" }];
      return { type: "file", encoding: "base64", content: Buffer.from("related implementation\n").toString("base64") };
    }
    throw new Error("unexpected fixture request");
  };
  const runText = async (command, args) => {
    calls.push(args);
    assert.ok(args.includes("Accept: application/vnd.github.diff"));
    assert.match(args[3], new RegExp(`${TARGET.gitTarget.baseRefOid}\\.\\.\\.${TARGET.gitTarget.headRefOid}$`));
    return diff;
  };
  return { reader: new GitHubReviewReader({ run, runText, onCompleteReviewRead }), files, diff, calls };
}

test("historical PR base SHA cannot authorize a reader against a moved live base", async () => {
  const { reader } = fixture({ changed: 1, liveBase: "d".repeat(40) });
  let session;
  try {
    await assert.rejects(async () => { session = await reader.open(TARGET); }, { code: "PR_REVIEW_READ_HEAD_CHANGED" });
  } finally { await session?.close(); }
});

test("a live base movement after the diff read rejects mixed evidence despite an unchanged historical scalar", async () => {
  await assert.rejects(fixture({ changed: 1, movedBase: true }).reader.open(TARGET), { code: "PR_REVIEW_READ_HEAD_CHANGED" });
});

test("an account change after reading the diff cannot produce a review session", async () => {
  const { reader } = fixture({ changed: 1 });
  const run = reader.run;
  let accountReads = 0;
  reader.run = async (command, args, options) => {
    if (args[3] === "user" && ++accountReads === 2) return { login: "other-account" };
    return run(command, args, options);
  };
  await assert.rejects(reader.open(TARGET), { code: "PR_REVIEW_READ_ACCOUNT_CHANGED" });
  assert.equal(accountReads, 2);
});

for (const boundary of ["files", "diff", "final-target"])
test(`raw GitHub ${boundary} I/O failures belong to the review reader`, async () => {
  const { reader } = fixture({ changed: 1 });
  const original = reader.run;
  let targetReads = 0;
  reader.run = async (...args) => {
    const endpoint = args[1][3];
    if ((boundary === "files" && endpoint.includes("/files?")) ||
        (boundary === "final-target" && endpoint === "graphql" && ++targetReads === 2)) {
      throw new Error("private raw gh response");
    }
    return original(...args);
  };
  if (boundary === "diff") reader.runText = async () => { throw new Error("private raw diff stderr"); };
  await assert.rejects(reader.open(TARGET), error => {
    assert.equal(isReviewSourceFailure(error), true);
    assert.equal(error.code, "PR_REVIEW_READ_UNAVAILABLE");
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "PR review source is unavailable");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});

test("raw source I/O during final completeness validation keeps source identity", async (t) => {
  const { reader } = fixture({ changed: 1 });
  const session = await reader.open(TARGET);
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff"]) await tool(session, "read_document", { document, offset: 0, length: 48000 });
  reader.run = async () => { throw new Error("private final gh response"); };
  await assert.rejects(session.assertComplete(), error => isReviewSourceFailure(error) && error.code === "PR_REVIEW_READ_UNAVAILABLE");
});

async function rpc(session, method, params = {}) {
  const response = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

async function tool(session, name, args) {
  const result = await rpc(session, "tools/call", { name, arguments: args });
  if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
  return JSON.parse(result.content[0].text);
}

test("internal repair review pages the immutable original defect and every thread beside the current Head", async (t) => {
  const originalHead = "c".repeat(40);
  const { feedback, reviewFeedbackDigest } = summarizeOwnReviewFeedback({ reviews: [], threads: Array.from({ length: 10 }, (_, index) => ({
    id: `thread-${index}`, path: `src/${index}.js`, line: index + 1, isResolved: false, isOutdated: false,
    comments: [
      { id: `defect-${index}`, author: { login: "external-reviewer" }, body: `Original defect ${index}: ${"details ".repeat(1_000)}`,
        createdAt: "2026-10-10T01:00:00Z", updatedAt: "2026-10-10T01:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: originalHead } } },
      { id: `reply-${index}`, author: { login: "author" }, body: `Author reply ${index}: fixed`,
        createdAt: "2026-10-10T02:00:00Z", updatedAt: "2026-10-10T02:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: originalHead } } },
    ],
  })) }, "author");
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 42,
    context: { schemaVersion: 1, headRefOid: originalHead, reviewFeedbackDigest, feedback },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: originalHead, observedAt: "2026-10-10T03:00:00.000Z" } });
  const descriptor = { snapshotId: snapshot.snapshotId, feedbackDigest: reviewFeedbackDigest,
    originalHeadRefOid: originalHead, reviewHeadRefOid: TARGET.gitTarget.headRefOid };
  const f = fixture({ changed: 1 }); let reads = 0;
  f.reader.originalRepairFeedbackReader = { async read(request) {
    reads++; assert.equal(request.snapshotId, snapshot.snapshotId); return snapshot;
  } };
  const session = await f.reader.open({ ...TARGET, repairFeedback: descriptor }); t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "repair-feedback-manifest.json"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const first = await tool(session, "read_document", { document: "repair-feedback.json", offset: 0, length: 1_000 });
  assert.ok(first.nextOffset); await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  let text = first.text, offset = first.nextOffset;
  while (offset !== null) { const next = await tool(session, "read_document", { document: "repair-feedback.json", offset, length: 8_000 }); text += next.text; offset = next.nextOffset; }
  const original = JSON.parse(text);
  assert.equal(original.feedback.threads.length, 10);
  assert.match(original.feedback.threads[9].comments[0].body, /Original defect 9/);
  assert.match(original.contextualObservations[9].discussion.at(-1).body, /Author reply 9/);
  assert.equal(original.originalHeadRefOid, originalHead);
  assert.equal(JSON.parse((await tool(session, "read_document", { document: "repair-feedback-manifest.json", offset: 0 })).text).reviewHeadRefOid,
    TARGET.gitTarget.headRefOid);
  await session.assertComplete(); assert.equal(reads, 1);
});

test("repair feedback cannot be substituted, omitted, or bound to another review Head", async () => {
  const target = { ...TARGET, repairFeedback: { snapshotId: `repair-feedback-snapshot-${"a".repeat(64)}`,
    feedbackDigest: "f".repeat(64), originalHeadRefOid: "c".repeat(40), reviewHeadRefOid: TARGET.gitTarget.headRefOid } };
  await assert.rejects(fixture({ changed: 1 }).reader.open(target), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
  const substituted = fixture({ changed: 1 }); substituted.reader.originalRepairFeedbackReader = { async read() { return {}; } };
  await assert.rejects(substituted.reader.open(target), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
  await assert.rejects(fixture({ changed: 1 }).reader.open({ ...target,
    repairFeedback: { ...target.repairFeedback, reviewHeadRefOid: "9".repeat(40) } }), /feedback Head is invalid/);
});

test("native skill resources are scoped to this reader and must be read before a review completes", async (t) => {
  const skillDocuments = { "review-skill/SKILL.md": "Follow the native review procedure.", "review-skill/manifest.json": "{}", "review-skill/references/correctness.md": "Trace boundary conditions." };
  const session = await fixture({ changed: 1 }).reader.open(TARGET, { skillDocuments });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const registered = (await rpc(session, "tools/list")).tools.find((entry) => entry.name === "read_document");
  assert.ok(registered.inputSchema.properties.document.enum.includes("review-skill/SKILL.md"));
  assert.equal((await tool(session, "read_document", { document: "review-skill/SKILL.md", offset: 0 })).text, skillDocuments["review-skill/SKILL.md"]);
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  await tool(session, "read_document", { document: "review-skill/manifest.json", offset: 0 });
  await session.assertComplete();
  assert.equal((await tool(session, "read_document", { document: "review-skill/references/correctness.md", offset: 0 })).text, skillDocuments["review-skill/references/correctness.md"]);
  await assert.rejects(tool(session, "read_document", { document: "review-skill/../../auth.json", offset: 0 }), { code: "PR_REVIEW_READ_DOCUMENT_INVALID" });
});

test("CLI can page through all 117 files and a diff beyond the old prompt budget", async (t) => {
  const f = fixture();
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  assert.ok(session.diffText.length > 60_000);
  assert.equal(JSON.parse(session.manifestText).files.length, 117);
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const init = await rpc(session, "initialize", { protocolVersion: "2024-11-05" });
  assert.ok(init.capabilities.tools);
  assert.deepEqual((await rpc(session, "tools/list")).tools.map((x) => x.name), ["read_document", "read_source", "list_directory"]);
  for (const [document, expected] of [["review-manifest.json", session.manifestText], ["review.diff", f.diff]]) {
    let offset = 0;
    let text = "";
    do {
      const page = await tool(session, "read_document", { document, offset, length: 8_000 });
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(text, expected);
  }
  await session.assertComplete();
  const related = await tool(session, "read_source", { path: "src/related.js", revision: "head", offset: 0 });
  assert.equal(related.text, "related implementation\n");
  assert.ok(f.calls.some((args) => args[3] === `repos/contributor/repo/contents/src/related.js?ref=${TARGET.gitTarget.headRefOid}`));
  assert.equal((await tool(session, "list_directory", { path: "", revision: "base" })).entries[0].path, "src/related.js");
});

test("partial documents, including a skipped middle range, cannot complete a review", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  await tool(session, "read_document", { document: "review-manifest.json", offset: 0, length: 48_000 });
  await tool(session, "read_document", { document: "review.diff", offset: 0, length: 1_000 });
  for (let offset = 2_000; offset < session.diffText.length; offset += 48_000) {
    await tool(session, "read_document", { document: "review.diff", offset, length: 48_000 });
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
});

test("the read endpoint rejects host paths, unpinned revisions, and write tools", async (t) => {
  const session = await fixture().reader.open(TARGET);
  t.after(() => session.close());
  for (const path of ["../auth.json", "C:\\private\\token", "/etc/passwd", "src//secret"]) {
    await assert.rejects(tool(session, "read_source", { path, revision: "head", offset: 0 }), { code: "PR_REVIEW_READ_PATH_INVALID" });
  }
  await assert.rejects(tool(session, "read_source", { path: "a.js", revision: "main", offset: 0 }), { code: "PR_REVIEW_READ_REVISION_INVALID" });
  await assert.rejects(tool(session, "write_file", { path: "a.js", text: "change" }), { code: "PR_REVIEW_READ_TOOL_NOT_ALLOWED" });
  assert.equal((await fetch(session.url.replace(/review\/.+$/, "review/wrong"), { method: "POST" })).status, 404);
});

test("a changed Head or incomplete GitHub response is rejected before a CLI can review it", async () => {
  for (const options of [{ moved: true }, { missingFile: true }, { missingDiff: true }]) {
    await assert.rejects(fixture(options).reader.open(TARGET), { code: options.moved ? "PR_REVIEW_READ_HEAD_CHANGED" : options.missingFile ? "PR_REVIEW_READ_FILES_INCOMPLETE" : "PR_REVIEW_READ_DIFF_INCOMPLETE" });
  }
});

test("cancellation closes the read endpoint and releases its listener", async () => {
  const controller = new AbortController();
  const session = await fixture().reader.open(TARGET, { signal: controller.signal });
  controller.abort();
  await session.close();
  await assert.rejects(fetch(session.url));
});

test("source paging reuses the decoded immutable blob and retries a failed fetch", async (t) => {
  const f = fixture({ changed: 1 });
  const original = f.reader.run;
  const source = "related implementation\n".repeat(5_000);
  let blobs = 0;
  f.reader.run = async (command, args, options) => {
    if (args[3].includes("/contents/src/large.js")) return { type: "file", encoding: "none", sha: "c".repeat(40) };
    if (args[3].includes("/git/blobs/")) {
      blobs += 1;
      if (blobs === 1) throw Object.assign(new Error("temporary upstream error"), { code: "PRIVATE_REMOTE_RESPONSE" });
      return { encoding: "base64", content: Buffer.from(source).toString("base64") };
    }
    return original(command, args, options);
  };
  const session = await f.reader.open(TARGET);
  t.after(() => session.close());
  const args = { path: "src/large.js", revision: "head", offset: 0 };
  await assert.rejects(tool(session, "read_source", args), { code: "PR_REVIEW_READ_FAILED" });
  let text = "", offset = 0;
  do {
    const result = await tool(session, "read_source", { ...args, offset });
    text += result.text;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(text, source);
  assert.equal(blobs, 2);
});


async function fullFeedbackFixture(body = "Full author evidence " + "证据".repeat(10000), { relation = "review_requested" } = {}) {
  const { normalizeWorkflowEvent } = await import("../src/domain/workflow-events.js");
  const { createPullRequestExecutionBinding } = await import("../src/domain/pull-request-execution-binding.js");
  const { createPullRequestReadIdentity, createPullRequestReadFacts, projectPullRequestReadFactsContext } = await import("../src/domain/pull-request-read-facts.js");
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: "2026-10-28T05:00:00.000Z",
    source: { provider: "github", scopeId: "github-account:reviewer" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { gitTarget: TARGET.gitTarget, gitTargetAvailable: true, headRefOid: TARGET.gitTarget.headRefOid,
      ...(relation === null ? {} : { relation }) } });
  const executionBinding = createPullRequestExecutionBinding({ event, sourceBinding: { kind: "pull_request", rootItemId: "review-root", workKey: "review-42",
    inputRevision: 1, headRevision: 1, headRefOid: TARGET.gitTarget.headRefOid, eventId: event.eventId, eventDigest: event.contentDigest, inputDigest: "c".repeat(64) } });
  const facts = createPullRequestReadFacts({ identity: createPullRequestReadIdentity({ executionBinding, event }),
    observedAt: "2026-10-28T05:01:00.000Z", reviewDecision: "APPROVED", comments: [{ id: "IC_evidence", author: "developer", body, bodyTruncated: false,
      createdAt: "2026-10-28T05:00:00.000Z", updatedAt: "2026-10-28T05:00:00.000Z", url: "https://github.com/acme/repo/pull/42#issuecomment-1" }],
    reviews: [], reviewThreads: [], checks: [], truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } });
  const materialDigest = projectPullRequestReadFactsContext(facts).materialDigest;
  return { facts, materialDigest, body, event };
}

test("only completed host reads produce a durable Review result proof", async t => {
  const { facts, materialDigest } = await fullFeedbackFixture("Author feedback");
  const records = [];
  let recorder = receipt => records.push(consumeCompletedReviewRead(receipt));
  const { reader } = fixture({ changed: 1, onCompleteReviewRead: receipt => recorder(receipt) });
  reader.currentReviewFeedbackReader = {
    async read() { return facts; },
  };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } });
  t.after(() => session.close());
  const intent = { type: "propose_github_review", verdict: "approve", body: "Reviewed current code" };
  await assert.rejects(tool(session, "record_review_coverage", { verdict: "approve", readProofId: "model-forged-proof" }),
    { code: "PR_REVIEW_READ_TOOL_NOT_ALLOWED" });
  await assert.rejects(session.assertComplete(intent), { code: "PR_REVIEW_READ_INCOMPLETE" });
  assert.equal(records.length, 0);
  for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48000 });
  }
  await session.assertComplete(intent);
  assert.equal(records.length, 1, "complete host reads must retain proof for later cross-task result reuse");
  assert.equal(records[0].taskId, "review-child");
  assert.equal(records[0].intent.body, intent.body);
  assert.ok(records[0].coverage.feedbackDigest);
  let failedReceipt;
  recorder = async receipt => { failedReceipt = receipt; throw Object.assign(new Error("Optional receipt cache failed"), { code: "REVIEW_PUBLICATION_ADOPTION_CORRUPTED" }); };
  await session.assertComplete(intent); // Optional producer receipt writing cannot block ordinary publication.
  assert.equal(consumeCompletedReviewRead(failedReceipt), null, "a failed callback cannot retain a live attestation");
});

async function crossTaskReuseFixture(t, { proofWriteFailure = false, sourceRelation = "review_requested", checkForgery = false } = {}) {
  const { ReviewPublicationAdoptionStore } = await import("../src/services/published-review-adoption.js");
  const { ReviewPublicationReuseService } = await import("../src/services/review-publication-reuse-service.js");
  const { normalizeBoundWorkProposal, createWorkProposalResult } = await import("../src/domain/work-proposal-contract.js");
  const { createGitHubReviewProposalConfirmationPlan } = await import("../src/domain/github-review-proposal-confirmation.js");
  const { ConfirmationQueue } = await import("../src/services/confirmation-queue.js");
  const { createPullRequestReadFacts, createPullRequestReadIdentity, projectPullRequestReadFactsContext } = await import("../src/domain/pull-request-read-facts.js");
  const { normalizeWorkflowEvent } = await import("../src/domain/workflow-events.js");
  const { createDeliveryEvidenceTarget } = await import("../src/domain/delivery-evidence-contract.js");
  const { readGitHubReviewFeedbackSnapshot } = await import("../src/adapters/github-review-feedback-snapshot.js");
  const original = await fullFeedbackFixture("Author feedback https://github.com/acme/product/issues/7", { relation: sourceRelation });
  const { createPullRequestWorkSource, currentWorkItemExecutionBinding } = await import("../src/services/work-ledger-pr-source.js");
  const { createReviewAdoptionTaskReader } = await import("../src/services/review-publication-reuse-service.js");
  const originalAssignment = { assignmentId: "source-assignment", eventId: original.event.eventId, target: { type: "role", id: "pr-engineer" } };
  const admitted = createPullRequestWorkSource({ sequence: 1, assignment: originalAssignment, event: original.event });
  assert.ok(admitted, "normalized legacy or known GitHub events really reach the supported ledger route");
  const originalItem = { itemId: "review-root", kind: "source_root", revision: 2, status: "working", sourceQuarantine: null,
    activeIntentId: null, currentTarget: originalAssignment.target, assignmentId: originalAssignment.assignmentId, assignment: originalAssignment,
    event: original.event, source: admitted.source, inputDigest: admitted.source.current.inputDigest, createdAt: "2026-10-28T05:00:00.000Z",
    graph: { acceptanceContracts: [{ revision: 1, acceptanceCriteria: [], expectedDeliverables: [] }] } };
  const actualProducer = createReviewAdoptionTaskReader({ async readReviewAdoptionContext() { return { item: originalItem, root: originalItem, activeDispatch: null }; } });
  const sourceTask = await actualProducer.read({ taskId: originalItem.itemId });
  const originalBinding = currentWorkItemExecutionBinding(originalItem);
  const { contentDigest: _originalDigest, schemaVersion: _originalVersion, ...originalContent } = original.facts;
  original.facts = createPullRequestReadFacts({ ...originalContent, identity: createPullRequestReadIdentity({ executionBinding: originalBinding, event: original.event }) });
  original.materialDigest = projectPullRequestReadFactsContext(original.facts).materialDigest;
  const values = new Map();
  let failProofWrite = proofWriteFailure;
  const store = { async read(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
    async write(key, value) {
      if (failProofWrite && value.readProofs?.length) { failProofWrite = false; throw new Error("Receipt storage temporarily unavailable"); }
      values.set(key, structuredClone(value));
    } };
  const intent = { type: "propose_github_review", verdict: "approve", body: "Reviewed current code" };
  let source = null, facts = original.facts, policyDigest = "d".repeat(64), description = "", linkedBody = "Original linked requirement";
  let receiverProposal = null;
  const tasks = new Map([[sourceTask.taskId, sourceTask]]);
  let completionNumber = 0;
  const { reader } = fixture({ changed: 1, onCompleteReviewRead: async receipt => {
    if (!checkForgery) return service.recordReviewCoverage(receipt);
    completionNumber++;
    assert.equal(Object.isFrozen(receipt), true);
    assert.deepEqual(Object.keys(receipt), []);
    await service.recordReviewCoverage(structuredClone(receipt));
    const task = tasks.get(sourceTask.taskId);
    if (completionNumber <= 2) {
      const changed = completionNumber === 1 ? { ...task, taskId: "unrelated-task" }
        : { ...task, inputBinding: { ...task.inputBinding, inputDigest: "f".repeat(64) } };
      tasks.set(sourceTask.taskId, changed);
      await service.recordReviewCoverage(receipt);
      tasks.set(sourceTask.taskId, task);
      assert.equal((await receiptStore.readProofs()).records.length, 0, "completed token cannot cross task or current input");
      await service.recordReviewCoverage(receipt);
      assert.equal((await receiptStore.readProofs()).records.length, 0, "rejected completion token is consumed once");
      return;
    }
    await service.recordReviewCoverage(receipt);
    const saved = values.get("review-publication-adoptions");
    const proof = saved.readProofs;
    saved.readProofs = [];
    await service.recordReviewCoverage(receipt);
    assert.equal((await receiptStore.readProofs()).records.length, 0, "successful token cannot be replayed after receipt loss");
    saved.readProofs = proof;
  } });
  const baseRun = reader.run;
  reader.run = async (...args) => {
    if (args[1][3] === "repos/acme/product/issues/7") return { number: 7, title: "Linked requirement", body: linkedBody, state: "open",
      user: { login: "qa" }, comments: 0, created_at: "2026-10-28T04:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: "https://github.com/acme/product/issues/7" };
    if (args[1][3] === "repos/acme/product/issues/7/comments?per_page=20&page=1") return [];
    const value = await baseRun(...args);
    return args[1][3] === "repos/acme/repo/pulls/42" ? { ...value, title: "Qt Fixture PR", body: description } : value;
  };
  const ports = receiptStore => ({ taskReader: { async read({ taskId }) { return structuredClone(tasks.get(taskId)); } },
    factsReader: { async get() { return facts; } }, publicationSourceReader: { async listReviewPublicationSources() {
      return { complete: true, items: [...(source ? [{ ...source, status: "succeeded", downstreamRef: null }] : []),
        ...(receiverProposal ? [{ proposal: receiverProposal, status: "running", result: null, downstreamRef: null }] : [])] };
    } }, confirmationReader: { async readSettlements() { return { queueRevision: source.confirmationSnapshot.queueRevision, items: [source.confirmationSnapshot.item] }; } },
    materialsReader: { async read(input, options) { return readGitHubReviewFeedbackSnapshot({ target: {
      gitTarget: input.gitTarget, pullRequestNumber: input.pullRequestNumber,
      feedbackSnapshot: { taskId: input.taskId, materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } },
      factsReader: { async read() { return facts; } }, run: reader.run, options, excludedPublication: input.excludedPublication }); } },
    receiptStore, inputAuthorityVerifier: { async verify(input) { return input; } },
    policyReader: async () => policyDigest, clock: () => new Date("2026-10-28T05:05:00.000Z") });
  let receiptStore = new ReviewPublicationAdoptionStore({ store });
  let service = new ReviewPublicationReuseService(ports(receiptStore));
  if (checkForgery) {
    await service.recordReviewCoverage({ taskId: sourceTask.taskId, inputBinding: originalBinding, intent,
      coverage: { schemaVersion: 1, feedbackDigest: "a".repeat(64), descriptionDigest: "b".repeat(64),
        referencedMaterialDigest: "c".repeat(64), checksDigest: "d".repeat(64) },
      observedAt: original.facts.observedAt, policyDigest });
    assert.equal((await receiptStore.readProofs()).records.length, 0, "plain caller metadata cannot attest real complete reads");
  }
  reader.currentReviewFeedbackReader = { async read() { return original.facts; } };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: sourceTask.taskId, materialDigest: original.materialDigest } },
    { skillDocuments: { "review-skill/SKILL.md": "Review policy", "review-skill/manifest.json": JSON.stringify({ digest: policyDigest }) } });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json", "review-skill/SKILL.md", "review-skill/manifest.json", "linked-material-001.json"]) {
    await tool(session, "read_document", { document, offset: 0, length: 48000 });
  }
  if (checkForgery) {
    await session.assertComplete(intent);
    await session.assertComplete(intent);
  }
  await session.assertComplete(intent);
  const expectsProof = !proofWriteFailure && sourceRelation === "review_requested";
  assert.equal(values.get("review-publication-adoptions")?.readProofs?.length ?? 0, expectsProof ? 1 : 0,
    "only positively known standard-review sources may persist a reusable producer proof");
  const proposal = normalizeBoundWorkProposal({ proposalId: "work-intent-" + "a".repeat(64), policyVersion: 1,
    kind: "github_review_proposal", requestedBy: { roleId: "pr-engineer", workItemId: sourceTask.taskId },
    source: { assignmentId: "source-assignment", eventId: originalBinding.eventId },
    binding: { eventId: originalBinding.eventId, subject: { repository: "acme/repo", number: 42 }, repository: "acme/repo",
      pullRequestNumber: 42, headRefOid: originalBinding.headRefOid, inputBinding: originalBinding },
    payload: { verdict: intent.verdict, body: intent.body, evidence: ["head:" + originalBinding.headRefOid], summary: "Review complete", reason: "Code read" } });
  const at = "2026-10-28T05:02:00.000Z";
  const queueValues = new Map();
  const publicationQueueStore = { async read(k, f) { return structuredClone(queueValues.get(k) ?? f); }, async write(k, v) { queueValues.set(k, structuredClone(v)); } };
  const queue = new ConfirmationQueue({ store: publicationQueueStore,
    clock: () => new Date(at), exclusiveLease: { async acquire() {}, run: op => op(), async close() {} },
    reviewHandoffPolicy: { testingOwnersByProduct: { qt: ["qa-user"] } },
    executor: { async execute() { return { status: "applied", receipt: { id: "12345", url: "https://github.com/acme/repo/pull/42", createdAt: at } }; }, async reconcile() { assert.fail("No replay"); } } });
  await queue.recover();
  const publication = await queue.enqueue(createGitHubReviewProposalConfirmationPlan(proposal, { actorAccountId: "reviewer" }));
  const { AutomaticReviewPublisher } = await import("../src/services/automatic-review-publisher.js");
  const { ReviewHandoffReconciler } = await import("../src/services/review-handoff-reconciler.js");
  await new AutomaticReviewPublisher({ enabled: true, queue, clock: () => new Date(at), testingOwnersByProduct: { qt: ["qa-user"] },
    github: { async readIncomingReviewRequest() { return { kind: "pull_request", state: "open", isDraft: false, title: "Qt Fixture PR",
      currentUser: "reviewer", author: "developer", assignees: ["reviewer"], headRefOid: originalBinding.headRefOid,
      incomingReviewFactsAvailable: true, reviewRecipient: "reviewer", reviewReceivedFrom: "developer", reviewReceivedVia: "assignee",
      reviewRequestEventId: "AE_original", reviewReceivedAt: "2026-10-28T05:00:00.000Z" }; } } }).publish(publication);
  let oldHandoffs = 0;
  const originalHandoff = new ReviewHandoffReconciler({ confirmations: queue, testingOwnersByProduct: { qt: ["qa-user"] },
    ownerWorkRequests: { async submit() { assert.fail("Automatic source handoff is assignment only"); } },
    githubAssignee: { async assignAssignee() { assert.fail("Use verdict routing"); }, async assignReviewOutcome() { oldHandoffs++; return { assigneeLogin: "qa-user" }; } } });
  assert.equal((await originalHandoff.runCycle())[0].status, "completed");
  assert.equal(oldHandoffs, 1);
  source = { proposal, result: createWorkProposalResult({ proposal, sequence: 1, downstreamRef: null, at,
    transition: { status: "succeeded", summary: "Published", evidence: ["confirmation:" + publication.id] } }),
    confirmationSnapshot: await queue.readSettlement({ confirmationId: publication.id }) };
  const { createPrTriageWorkRequest, createOwnerPullRequestEvent } = await import("../src/domain/owner-work-request.js");
  const ownerRequest = createPrTriageWorkRequest({ requestKey: "future-owner-rereview", targetRoleId: "pr-engineer",
    repository: "acme/repo", number: 42, nextAction: "rereview", expectedHeadRefOid: TARGET.gitTarget.headRefOid });
  const event = createOwnerPullRequestEvent(ownerRequest, { repository: "acme/repo", number: 42, title: "Fixture PR",
    state: "open", gitTarget: TARGET.gitTarget }, "2026-10-28T05:00:30.000Z");
  const binding = { ...originalBinding, rootItemId: "owner-root", workKey: "owner-review", eventId: event.eventId, eventDigest: event.contentDigest };
  const contract = { revision: 1, acceptanceCriteria: [{ criterionId: "qa-note", description: "Also deliver a separate QA execution note" }],
    expectedDeliverables: [{ deliverableId: "review", kind: "github-review", description: "Code Review", required: true },
      { deliverableId: "qa-note", kind: "text-report", description: "Additional QA note", required: true }] };
  const task = { taskId: "owner-child", roleId: "pr-engineer", revision: 2, status: "working", rootStatus: "queued",
    activeIntentId: null, inputBinding: binding, event, acceptanceContract: contract, requestedAt: event.occurredAt };
  tasks.set(task.taskId, task);
  const { contentDigest: _digest, schemaVersion: _version, ...content } = original.facts;
  facts = createPullRequestReadFacts({ ...content, identity: createPullRequestReadIdentity({ executionBinding: binding, event }), observedAt: "2026-10-28T05:03:00.000Z",
    reviews: [{ id: "PRR_published", author: "reviewer", state: "APPROVED", commitOid: binding.headRefOid, submittedAt: at,
      body: intent.body, bodyTruncated: false, url: "https://github.com/acme/repo/pull/42#pullrequestreview-12345" }] });
  // Reconstruct both readers from persisted bytes; no producer closure survives.
  receiptStore = new ReviewPublicationAdoptionStore({ store });
  service = new ReviewPublicationReuseService(ports(receiptStore));
  const list = () => service.listCandidates({ taskId: task.taskId, materialDigest: projectPullRequestReadFactsContext(facts).materialDigest });
  const catalog = await list();
  assert.equal(Boolean(catalog.verifiedResult), expectsProof, "host must require actual persisted producer proof across restart");
  const target = createDeliveryEvidenceTarget({ taskId: task.taskId, roleId: task.roleId, acceptanceContract: contract, deliverableId: "review" });
  return { service, receiptStore, store, values, task, tasks, source, catalog, list, target, binding, event, publicationQueueStore,
    changePolicy: () => { policyDigest = "e".repeat(64); }, changeDescription: () => { description = "Author changed requirements"; },
    changeLinked: () => { linkedBody = "QA changed linked acceptance requirement"; },
    changeFacts: change => { const { contentDigest, schemaVersion, ...c } = facts; facts = createPullRequestReadFacts(change(c)); },
    normalizeBoundWorkProposal, createWorkProposalResult,
    registerReceiverProposal(value) { receiverProposal = value; task.activeProposal = { proposalId: value.proposalId, contentDigest: value.contentDigest }; task.status = "waiting_external"; },
    async asAutomaticReceiver({ relation = "review_requested", contracted = false } = {}) {
      const { createPullRequestWorkSource } = await import("../src/services/work-ledger-pr-source.js");
      const { createReviewAdoptionTaskReader } = await import("../src/services/review-publication-reuse-service.js");
      const autoEvent = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: "2026-10-28T05:04:00.000Z",
        source: { provider: "github", scopeId: "github-dashboard" }, subject: original.event.subject,
        payload: { gitTarget: TARGET.gitTarget, gitTargetAvailable: true, headRefOid: TARGET.gitTarget.headRefOid,
          ...(relation === null ? {} : { relation }), assignees: ["reviewer"], reviewRecipient: "reviewer", reviewReceivedFrom: "developer",
          reviewReceivedAt: "2026-10-28T05:04:00.000Z", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_fresh_assignment" } });
      const assignment = { assignmentId: "fresh-automatic-assignment", eventId: autoEvent.eventId, target: { type: "role", id: "pr-engineer" } };
      const created = createPullRequestWorkSource({ sequence: 1, event: autoEvent, assignment });
      assert.ok(created);
      const autoItem = { itemId: "automatic-current-root", kind: "source_root", revision: 2, status: "working", sourceQuarantine: null,
        activeIntentId: null, currentTarget: assignment.target, assignmentId: assignment.assignmentId, assignment, event: autoEvent,
        source: created.source, inputDigest: created.source.current.inputDigest, createdAt: autoEvent.occurredAt,
        graph: { acceptanceContracts: [contracted ? contract : { revision: 1, acceptanceCriteria: [], expectedDeliverables: [] }] } };
      const actualReader = createReviewAdoptionTaskReader({ async readReviewAdoptionContext() { return { item: autoItem, root: autoItem, activeDispatch: null }; } });
      const automaticTask = await actualReader.read({ taskId: autoItem.itemId });
      if (relation === "review_requested") assert.equal(automaticTask.automaticSettlement.kind, "automatic_review_settlement");
      else assert.equal(automaticTask.automaticSettlement, undefined, "unknown relation cannot receive a typed automatic settlement target");
      tasks.delete(task.taskId); Object.assign(task, automaticTask); tasks.set(task.taskId, task);
      const { contentDigest, schemaVersion, ...c } = facts;
      facts = createPullRequestReadFacts({ ...c, identity: createPullRequestReadIdentity({ executionBinding: task.inputBinding, event: autoEvent }), observedAt: "2026-10-28T05:05:00.000Z" });
      return { task, event: autoEvent, binding: task.inputBinding, catalog: await list() };
    },
    async readCurrentFull() {
      reader.currentReviewFeedbackReader = { async read() { return facts; } };
      const current = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: task.taskId,
        materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } });
      try {
        for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json", "linked-material-001.json"]) {
          await tool(current, "read_document", { document, offset: 0, length: 48000 });
        }
        await current.assertComplete({ type: "propose_github_review", verdict: "approve", body: "Full current code review" });
      } finally { await current.close(); }
    },
    async fullReviewFallback() {
      const currentCatalog = await list();
      assert.equal(currentCatalog.verifiedResult, undefined);
      assert.ok(currentCatalog.candidates.length > 0, "legacy full-reading candidate remains available");
      reader.currentReviewFeedbackReader = { async read() { return facts; } };
      const fullSession = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: task.taskId,
        materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } });
      try {
        for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json", "linked-material-001.json"]) {
          await tool(fullSession, "read_document", { document, offset: 0, length: 48000 });
        }
        const c = currentCatalog.candidates[0];
        const reuse = { candidateId: c.candidateId, materialDigest: c.materialDigest,
          coverageDigest: JSON.parse(fullSession.manifestText).feedbackSnapshot.coverageDigest };
        await fullSession.assertComplete({ type: "propose_github_review", publicationReuse: reuse });
        const ordinary = normalizeBoundWorkProposal({ proposalId: "work-intent-" + "b".repeat(64), policyVersion: 1, kind: "github_review_proposal",
          requestedBy: { roleId: "pr-engineer", workItemId: task.taskId }, source: { assignmentId: "target-assignment", eventId: event.eventId },
          binding: { eventId: event.eventId, subject: event.subject, repository: "acme/repo", pullRequestNumber: 42,
            headRefOid: binding.headRefOid, inputBinding: binding, evidenceTarget: target },
          payload: { verdict: "approve", body: "Full current review completed", publicationReuse: reuse,
            evidence: ["head:" + binding.headRefOid], summary: "Full current review", reason: "Read current materials" } });
        task.status = "waiting_external"; task.activeProposal = { proposalId: ordinary.proposalId, contentDigest: ordinary.contentDigest };
        assert.equal((await service.handle({ proposal: ordinary })).status, "succeeded");
      } finally { await fullSession.close(); }
    } };
}

test("real producer proof survives restart and reuses code Review across contracts without completing residual work", async t => {
  const f = await crossTaskReuseFixture(t, { checkForgery: true });
  const v = f.catalog.verifiedResult;
  const reuse = { candidateId: v.candidateId, materialDigest: v.materialDigest, coverageDigest: v.coverageDigest, readProofId: v.readProofId };
  const proposal = f.normalizeBoundWorkProposal({ proposalId: "work-intent-" + "b".repeat(64), policyVersion: 1, kind: "github_review_proposal",
    requestedBy: { roleId: "pr-engineer", workItemId: f.task.taskId }, source: { assignmentId: "owner-child-assignment", eventId: f.event.eventId },
    binding: { eventId: f.event.eventId, subject: f.event.subject, repository: "acme/repo", pullRequestNumber: 42,
      headRefOid: f.binding.headRefOid, inputBinding: f.binding, evidenceTarget: f.target },
    payload: { verdict: v.verdict, body: "Host proved identical code Review coverage; QA note remains pending", publicationReuse: reuse,
      evidence: ["head:" + f.binding.headRefOid], summary: "Reuse code Review", reason: "Verified producer coverage" } });
  f.task.status = "waiting_external";
  f.task.activeProposal = { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest };
  const result = await f.service.handle({ proposal });
  assert.equal(result.status, "succeeded");
  const receipt = await f.receiptStore.getForProposal({ proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest });
  assert.equal(receipt.assessment.readProofId, v.readProofId);
  assert.equal(receipt.target.evidenceTarget.deliverables.length, 1);
  assert.equal(receipt.target.evidenceTarget.deliverables[0].deliverableId, "review");
  assert.equal(f.task.status, "waiting_external", "adoption must not finish the current task");
  assert.equal(f.task.acceptanceContract.expectedDeliverables[1].deliverableId, "qa-note");
  assert.equal(f.task.acceptanceContract.expectedDeliverables[1].required, true);
});

test("canonical adoption record corruption propagates from the actual store through candidate preview", async t => {
  const f = await crossTaskReuseFixture(t);
  f.values.get("review-publication-adoptions").records = [{ adoptionId: "forged-canonical-record" }];
  await assert.rejects(f.list(), { code: "REVIEW_PUBLICATION_ADOPTION_CORRUPTED" });
  await assert.rejects(f.receiptStore.readProofs(), { code: "REVIEW_PUBLICATION_ADOPTION_CORRUPTED" });
});

test("damaged optional proof metadata preserves valid canonical adoption history and full reading", async t => {
  const f = await crossTaskReuseFixture(t);
  const v = f.catalog.verifiedResult;
  const proofProposal = f.normalizeBoundWorkProposal({ proposalId: "work-intent-" + "c".repeat(64), policyVersion: 1, kind: "github_review_proposal",
    requestedBy: { roleId: "pr-engineer", workItemId: f.task.taskId }, source: { assignmentId: "owner-child-assignment", eventId: f.event.eventId },
    binding: { eventId: f.event.eventId, subject: f.event.subject, repository: "acme/repo", pullRequestNumber: 42,
      headRefOid: f.binding.headRefOid, inputBinding: f.binding, evidenceTarget: f.target },
    payload: { verdict: v.verdict, body: "Host proved identical Review coverage", publicationReuse: {
      candidateId: v.candidateId, materialDigest: v.materialDigest, coverageDigest: v.coverageDigest, readProofId: v.readProofId },
      evidence: ["head:" + f.binding.headRefOid], summary: "Reuse code Review", reason: "Verified coverage" } });
  f.registerReceiverProposal(proofProposal);
  assert.equal((await f.service.handle({ proposal: proofProposal })).status, "succeeded");
  const state = f.values.get("review-publication-adoptions"), retained = structuredClone(state.records[0]);
  state.readProofs = "damaged optional metadata";
  assert.equal((await f.list()).verifiedResult, undefined);
  assert.deepEqual(await f.receiptStore.get(retained.adoptionId), retained);
  await f.fullReviewFallback();
  assert.equal(f.values.get("review-publication-adoptions").records.length, 2);
  assert.deepEqual(await f.receiptStore.get(retained.adoptionId), retained);
});

for (const sourceRelation of [null, "legacy_unknown"])
test(`a normalized ${sourceRelation === null ? "missing" : "unknown"} GitHub relation cannot issue reusable proof through ledger and full reader`, async t => {
  const f = await crossTaskReuseFixture(t, { sourceRelation });
  assert.equal(f.catalog.verifiedResult, undefined);
  await f.fullReviewFallback();
});

for (const relation of [null, "legacy_unknown"])
test(`a known producer proof cannot skip full reading for a ${relation === null ? "missing" : "unknown"} receiver relation`, async t => {
  const f = await crossTaskReuseFixture(t);
  const current = await f.asAutomaticReceiver({ relation, contracted: true });
  assert.equal(current.catalog.verifiedResult, undefined);
  await f.readCurrentFull();
});

for (const scenario of ["description", "linked", "checks", "policy", "independent", "unknown", "missing-proof", "corrupt-proof", "author-comment", "body-forgery", "base", "head"])
test(`result reuse falls back to full assessment after ${scenario}`, async t => {
  const f = await crossTaskReuseFixture(t);
  if (scenario === "description") f.changeDescription();
  if (scenario === "linked") f.changeLinked();
  if (scenario === "checks") f.changeFacts(c => ({ ...c, checks: [{ kind: "check_run", name: "CodeTest", status: "COMPLETED", conclusion: "FAILURE",
    url: "https://ci.example/42", requirement: "required", startedAt: "2026-10-28T05:02:00.000Z", completedAt: "2026-10-28T05:03:00.000Z" }] }));
  if (scenario === "policy") f.changePolicy();
  if (scenario === "independent") f.task.event = { ...f.task.event, payload: { ...f.task.event.payload, reviewPurpose: "independent_review/v1" } };
  if (scenario === "unknown") f.task.event = { ...f.task.event, payload: { ...f.task.event.payload, reviewPurpose: "unknown-purpose" } };
  if (scenario === "missing-proof") f.values.get("review-publication-adoptions").readProofs = [];
  if (scenario === "corrupt-proof") f.values.get("review-publication-adoptions").readProofs[0].bodyDigest = "0".repeat(64);
  if (scenario === "author-comment") f.changeFacts(c => ({ ...c, comments: [...c.comments, { ...c.comments[0], id: "new-comment", body: "New author requirement",
    createdAt: "2026-10-28T05:04:00.000Z", updatedAt: "2026-10-28T05:04:00.000Z" }] }));
  if (scenario === "body-forgery") f.changeFacts(c => ({ ...c, reviews: c.reviews.map(r => ({ ...r, body: "Different published body" })) }));
  if (["head", "base"].includes(scenario)) {
    f.task.inputBinding = structuredClone(f.task.inputBinding);
    f.task.inputBinding.gitTarget[scenario === "head" ? "headRefOid" : "baseRefOid"] = "f".repeat(40);
  }
  // A mismatched target may be rejected before candidate generation, which is
  // equally fail-closed; no new model/queue/action is started by this reader.
  let catalog;
  try { catalog = await f.list(); } catch { catalog = {}; }
  assert.equal(catalog.verifiedResult, undefined);
  assert.notEqual(f.task.status, "completed");
});

for (const scenario of ["write-failed", "capacity", "corrupt-metadata"])
test(`optimization ${scenario} leaves the real full-review and normal adoption path usable`, async t => {
  const f = await crossTaskReuseFixture(t, { proofWriteFailure: scenario === "write-failed" });
  if (scenario === "corrupt-metadata") f.values.get("review-publication-adoptions").readProofs = "invalid optimization metadata";
  if (scenario === "capacity") {
    const { canonicalJsonDigest } = await import("../src/lib/canonical-json-digest.js");
    const first = f.values.get("review-publication-adoptions").readProofs[0];
    const { readProofId, ...content } = first;
    f.values.get("review-publication-adoptions").readProofs = Array.from({ length: 1000 }, (_, i) => {
      const c = { ...content, producerTaskId: `other-task-${i}` };
      return { ...c, readProofId: `review-read-proof-${canonicalJsonDigest(c)}` };
    });
    assert.deepEqual(await f.receiptStore.recordReadProof(first), { recorded: false, diagnostic: "REVIEW_READ_PROOF_CAPACITY" });
    assert.equal(f.values.get("review-publication-adoptions").readProofs.length, 1000);
  }
  await f.fullReviewFallback();
  assert.equal(f.values.get("review-publication-adoptions").records.length, 1);
  f.values.get("review-publication-adoptions").records[0].adoptionId = "forged-original-record";
  await assert.rejects(f.receiptStore.recover(), { code: "REVIEW_PUBLICATION_ADOPTION_CORRUPTED" }, "original record corruption remains strict");
});

async function automaticSettlementFixture(t, { enabled = true, changeBeforeExecution = false } = {}) {
  const f = await crossTaskReuseFixture(t);
  const current = await f.asAutomaticReceiver();
  assert.ok(current.catalog.verifiedResult, "a fresh automatic Assign can reuse an older proven Review");
  assert.equal(current.task.acceptanceContract.expectedDeliverables.length, 0, "no synthetic delivery contract");
  const v = current.catalog.verifiedResult;
  const reuse = { candidateId: v.candidateId, materialDigest: v.materialDigest, coverageDigest: v.coverageDigest, readProofId: v.readProofId };
  const proposal = f.normalizeBoundWorkProposal({ proposalId: "work-intent-" + "b".repeat(64), policyVersion: 1, kind: "github_review_proposal",
    requestedBy: { roleId: "pr-engineer", workItemId: current.task.taskId },
    source: { assignmentId: current.task.automaticSettlement.assignmentId, eventId: current.event.eventId },
    binding: { eventId: current.event.eventId, subject: current.event.subject, repository: "acme/repo", pullRequestNumber: 42,
      headRefOid: current.binding.headRefOid, inputBinding: current.binding },
    payload: { verdict: v.verdict, body: "Host verified the prior code Review; settle this current assignment", publicationReuse: reuse,
      evidence: ["head:" + current.binding.headRefOid], summary: "Reuse code Review", reason: "Verified current business coverage" } });
  f.registerReceiverProposal(proposal);
  const { createPullRequestExternalActionExecutor } = await import("../src/services/pull-request-external-action-executor.js");
  const { ConfirmationQueue } = await import("../src/services/confirmation-queue.js");
  const { AutomaticReviewPublisher } = await import("../src/services/automatic-review-publisher.js");
  const { GitHubReviewProposalHandler } = await import("../src/services/github-review-proposal-handler.js");
  const { ReviewHandoffReconciler } = await import("../src/services/review-handoff-reconciler.js");
  const counts = { reviewPost: 0, handoff: 0, verifiedExecution: 0 };
  const authority = { async verify() { return structuredClone(current.binding); } };
  const executor = createPullRequestExternalActionExecutor({ enabledActions: ["review"],
    credentialSource: Object.freeze({ async acquire() { assert.fail("verified reuse must not post a Review"); } }),
    transport: { async observe() { assert.fail("Reuse uses the exact original receipt, not a new marker search"); },
      async perform() { counts.reviewPost++; assert.fail("A reused Review must never be posted again"); } },
    inputAuthorityVerifier: authority, reviewResultVerifier: { async verify(envelope, options) { counts.verifiedExecution++; return f.service.verifyAutomaticSettlement(envelope, options); } } });
  t.after(() => executor.close());
  const queueStore = f.publicationQueueStore;
  const clock = () => new Date("2026-10-28T05:06:00.000Z");
  const createQueue = async () => {
    const queue = new ConfirmationQueue({ store: queueStore, executor, clock,
      exclusiveLease: { async acquire() {}, run: op => op(), async close() {} }, reviewHandoffPolicy: { testingOwnersByProduct: { qt: ["qa-user"] } } });
    await queue.recover(); return queue;
  };
  let queue = await createQueue();
  const incoming = { kind: "pull_request", state: "open", isDraft: false, author: "developer", assignees: ["reviewer"],
    title: "Qt Fixture PR", currentUser: "reviewer",
    headRefOid: current.binding.headRefOid, incomingReviewFactsAvailable: true, reviewRecipient: "reviewer", reviewReceivedFrom: "developer",
    reviewReceivedAt: "2026-10-28T05:04:00.000Z", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_fresh_assignment",
    myReviewState: "APPROVED", myReviewCommitOid: current.binding.headRefOid, myLatestPublishedReviewAt: "2026-10-28T05:02:00.000Z" };
  const createHandler = queue => new GitHubReviewProposalHandler({ confirmationProducer: queue, inputAuthorityVerifier: authority,
    publicationAdopter: f.service, actorAccountId: "reviewer", clock, automaticReviewPublisher: {
      async publish(item) {
        if (changeBeforeExecution === "proof") f.values.get("review-publication-adoptions").readProofs = [];
        else if (changeBeforeExecution === "authority") current.task.automaticSettlement.authorityEpoch++;
        else if (changeBeforeExecution === "checks") f.changeFacts(c => ({ ...c, checks: [{ kind: "check_run", name: "CodeTest", status: "COMPLETED", conclusion: "FAILURE",
          url: "https://ci.example/42", requirement: "required", startedAt: "2026-10-28T05:02:00.000Z", completedAt: "2026-10-28T05:03:00.000Z" }] }));
        else if (changeBeforeExecution) f.changeDescription();
        return new AutomaticReviewPublisher({ enabled, queue, clock, assignAfterReview: true,
          testingOwnersByProduct: { qt: ["qa-user"] }, github: { async readIncomingReviewRequest() { return incoming; } } }).publish(item);
      } } });
  const handle = handler => handler.handle({ proposal, status: "pending_delivery", attempt: 1, downstreamRef: null });
  const handoff = queue => new ReviewHandoffReconciler({ confirmations: queue, automaticAssignmentsEnabled: true,
    testingOwnersByProduct: { qt: ["qa-user"] }, ownerWorkRequests: { async submit() { assert.fail("automatic handoff should remain assignment only"); } },
    githubAssignee: { async assignAssignee() { assert.fail("Current verdict routing must be used"); },
      async assignReviewOutcome(input) { counts.handoff++; assert.equal(input.headRefOid, current.binding.headRefOid); return { assigneeLogin: "qa-user" }; } } });
  const result = await handle(createHandler(queue));
  return { ...f, current, proposal, result, counts, queue, handoff,
    async restart() { queue = await createQueue(); return { queue, result: await handle(createHandler(queue)) }; } };
}

test("fresh automatic receiver settles the prior Review through current confirmation and handoff without Review POST or replay", async t => {
  const f = await automaticSettlementFixture(t);
  assert.equal(f.source.confirmationSnapshot.item.reviewHandoff.status, "completed", "the first publication already completed its old handoff");
  assert.equal(f.result.status, "succeeded");
  assert.equal(f.counts.reviewPost, 0);
  assert.equal(f.counts.verifiedExecution, 1, "executor must verify current proof at the action boundary");
  const pending = await f.queue.readReviewHandoffs();
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].id, f.source.confirmationSnapshot.item.id, "current Assign has its own controlled confirmation");
  const handoffResult = (await f.handoff(f.queue).runCycle())[0];
  assert.equal(handoffResult.status, "completed", JSON.stringify(handoffResult));
  assert.equal(f.counts.handoff, 1);
  const again = await f.restart();
  assert.equal(again.result.status, "succeeded");
  assert.equal((await f.handoff(again.queue).runCycle()).length, 0);
  assert.equal(f.counts.handoff, 1);
  assert.equal(f.counts.verifiedExecution, 1);
  assert.equal(f.counts.reviewPost, 0);
});

test("automatic result settlement retains the automatic Review switch and rejects coverage changes before execution", async t => {
  const disabled = await automaticSettlementFixture(t, { enabled: false });
  assert.equal(disabled.result.status, "waiting_confirmation");
  assert.equal(disabled.counts.verifiedExecution, 0);
  assert.equal((await disabled.queue.readReviewHandoffs()).length, 0);
  const changed = await automaticSettlementFixture(t, { changeBeforeExecution: true });
  assert.equal(changed.result.status, "stale");
  assert.equal(changed.counts.reviewPost, 0);
  assert.equal((await changed.queue.readReviewHandoffs()).length, 0);
});

for (const change of ["proof", "authority", "checks"])
test(`automatic settlement rejects ${change} loss/change at execution before Review or handoff`, async t => {
  const f = await automaticSettlementFixture(t, { changeBeforeExecution: change });
  assert.equal(f.result.status, "stale");
  assert.equal(f.counts.reviewPost, 0);
  assert.equal(f.counts.handoff, 0);
  assert.equal((await f.queue.readReviewHandoffs()).length, 0);
});

test("current author discussion is a required paged document rather than an inline preview", async (t) => {
  const { facts, materialDigest, body } = await fullFeedbackFixture();
  const { reader } = fixture({ changed: 1 }); let reads = 0;
  const run = reader.run;
  reader.run = async (command, args, options) => {
    const value = await run(command, args, options);
    return args[3] === "repos/acme/repo/pulls/42" ? { ...value, html_url: "https://github.com/Acme/Repo/pull/42" } : value;
  };
  reader.currentReviewFeedbackReader = { async read(input) { reads++; assert.equal(input.taskId, "review-child"); assert.equal(input.materialDigest, materialDigest); return facts; } };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "review-description.json"]) await tool(session, "read_document", { document, offset: 0, length: 48000 });
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  let text = "", offset = 0;
  while (offset !== null) { const next = await tool(session, "read_document", { document: "review-feedback.json", offset, length: 4000 }); text += next.text; offset = next.nextOffset; }
  assert.equal(JSON.parse(text).comments[0].body, body);
  await session.assertComplete(); assert.equal(reads, 2);
});


test("linked product issue text is mandatory and changes during review invalidate the snapshot", async (t) => {
  const root = "https://github.com/acme/product/issues/7";
  const { facts, materialDigest } = await fullFeedbackFixture(`I supplemented validation: ${root}#issuecomment-9`);
  const { reader } = fixture({ changed: 1 }); const original = reader.run;
  reader.currentReviewFeedbackReader = { async read() { return facts; } };
  let extraResult = "";
  reader.run = async (command, args, options) => {
    if (args[3] === "repos/acme/product/issues/7") return { number: 7, title: "Hardware validation", body: "Bug context", state: "open",
      user: { login: "qa" }, comments: 1, created_at: "2026-10-28T04:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: root };
    if (args[3] === "repos/acme/product/issues/7/comments?per_page=20&page=1") return [{ id: 9, node_id: "IC_9", body: "Validation procedure; actual hardware result is still pending QA" + extraResult,
      user: { login: "developer" }, created_at: "2026-10-28T05:00:00Z", updated_at: "2026-10-28T05:00:00Z",
      html_url: `${root}#issuecomment-9`, issue_url: "https://api.github.com/repos/acme/product/issues/7" }];
    return original(command, args, options);
  };
  const session = await reader.open({ ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } });
  t.after(() => session.close());
  for (const document of ["review-manifest.json", "review.diff", "review-description.json", "review-feedback.json"]) {
    let offset = 0; while (offset !== null) offset = (await tool(session, "read_document", { document, offset, length: 48000 })).nextOffset;
  }
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_INCOMPLETE" });
  const manifest = JSON.parse(session.manifestText);
  const reference = manifest.feedbackSnapshot.linkedMaterials[0];
  const linked = JSON.parse((await tool(session, "read_document", { document: reference.document, offset: 0, length: 48000 })).text);
  assert.match(linked.comments[0].body, /still pending QA/);
  await session.assertComplete();
  extraResult = "; QA has now added actual execution results";
  await assert.rejects(session.assertComplete(), { code: "PR_REVIEW_READ_MATERIAL_CHANGED" });
});

test("semantic feedback coverage survives CI observations and changes with the PR description", async () => {
  const { readGitHubReviewFeedbackSnapshot } = await import("../src/adapters/github-review-feedback-snapshot.js");
  const { createPullRequestReadFacts, projectPullRequestReadFactsContext } = await import("../src/domain/pull-request-read-facts.js");
  const initial = await fullFeedbackFixture("Complete author evidence");
  const { reader } = fixture({ changed: 1 });
  let facts = initial.facts, description = "";
  const capture = () => readGitHubReviewFeedbackSnapshot({
    target: { ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } },
    factsReader: { async read() { return facts; } }, run: async (...args) => {
      const value = await reader.run(...args);
      return args[1][3] === "repos/acme/repo/pulls/42" ? { ...value, body: description } : value;
    },
  });
  const first = await capture();
  const { contentDigest: _digest, schemaVersion: _schema, ...content } = facts;
  facts = createPullRequestReadFacts({ ...content, observedAt: "2026-10-28T05:02:00.000Z", checks: [{
    kind: "check_run", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci.example/run/1",
    requirement: "required", startedAt: "2026-10-28T05:00:00.000Z", completedAt: "2026-10-28T05:01:00.000Z" }] });
  const afterCI = await capture();
  assert.notEqual(afterCI.feedbackSnapshot.snapshotDigest, first.feedbackSnapshot.snapshotDigest);
  assert.equal(afterCI.feedbackSnapshot.coverageDigest, first.feedbackSnapshot.coverageDigest);
  description = "QA added execution results";
  assert.notEqual((await capture()).feedbackSnapshot.coverageDigest, first.feedbackSnapshot.coverageDigest);
});

for (const boundary of ["facts", "description", "account"])
test(`feedback snapshot owns raw ${boundary} I/O and preserves its caller abort reason`, async () => {
  const { readGitHubReviewFeedbackSnapshot } = await import("../src/adapters/github-review-feedback-snapshot.js");
  const { facts, materialDigest } = await fullFeedbackFixture("Complete evidence");
  const { reader } = fixture({ changed: 1 });
  const controller = new AbortController(), reason = new Error("snapshot cancelled");
  let cancel = false;
  const fail = () => { if (cancel) controller.abort(reason); throw new Error("private source response"); };
  const capture = () => readGitHubReviewFeedbackSnapshot({
    target: { ...TARGET, feedbackSnapshot: { taskId: "review-child", materialDigest } },
    factsReader: { async read() { if (boundary === "facts") fail(); return facts; } },
    run: async (...args) => {
      if (args[1][3] === (boundary === "account" ? "user" : "repos/acme/repo/pulls/42")) fail();
      return reader.run(...args);
    }, options: { signal: controller.signal },
  });
  await assert.rejects(capture(), error => isReviewSourceFailure(error) && error.code === "PR_REVIEW_READ_UNAVAILABLE");
  cancel = true;
  await assert.rejects(capture(), error => error === reason);
});
