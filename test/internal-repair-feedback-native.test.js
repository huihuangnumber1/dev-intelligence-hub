import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubReviewReader } from "../src/adapters/github-review-reader.js";
import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";
import { createOriginalRepairFeedbackSnapshot, createOriginalRepairFeedbackArchiveRecord,
  originalRepairFeedbackArchiveKey, originalRepairFeedbackArchiveReference } from "../src/domain/original-repair-feedback.js";
import { StateStore } from "../src/lib/state-store.js";
import { OriginalRepairFeedbackReader } from "../src/services/original-repair-feedback-reader.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";

const HEAD = "b".repeat(40), ORIGINAL = "c".repeat(40), BASE = "a".repeat(40);
const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "author", baseRepository: "acme/repo",
  baseRefName: "main", baseRefOid: BASE, headRepository: "acme/repo", headRefName: "fix", headRefOid: HEAD };

async function callTool(url, document, offset, length = 8_000) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_document", arguments: { document, offset, length } } }) });
  const result = (await response.json()).result; assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

for (const partial of [true, false]) {
  test(`real native internal completion ${partial ? "rejects correctly cited unread original requests" : "accepts only after all original feedback pages"}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "internal-original-feedback-"));
    t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
    const home = path.join(root, "home"); await mkdir(home); await writeFile(path.join(home, "auth.json"), "fixture-native-login");
    const summary = summarizeOwnReviewFeedback({ reviews: [], threads: Array.from({ length: 10 }, (_, index) => ({ id: `t-${index}`,
      path: `src/${index}.js`, line: index + 1, isResolved: false, isOutdated: false, comments: [
        { id: `original-${index}`, author: { login: "reviewer" }, body: `Original defect ${index} ${"details ".repeat(1_000)}`,
          createdAt: "2026-10-10T00:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: ORIGINAL } } },
        { id: `reply-${index}`, author: { login: "author" }, body: `Author reply ${index}`,
          createdAt: "2026-10-10T01:00:00Z", pullRequestReview: { state: "COMMENTED", commit: { oid: ORIGINAL } } },
      ] })) }, "author");
    const snapshot = createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 42,
      context: { schemaVersion: 1, headRefOid: ORIGINAL, reviewFeedbackDigest: summary.reviewFeedbackDigest, feedback: summary.feedback },
      provenance: { kind: "captured_before_repair", observedHeadRefOid: ORIGINAL, observedAt: "2026-10-10T02:00:00.000Z" } });
    const descriptor = { snapshotId: snapshot.snapshotId, feedbackDigest: snapshot.feedbackDigest,
      originalHeadRefOid: ORIGINAL, reviewHeadRefOid: HEAD };
    const feedbackStore = new StateStore(path.join(root, "feedback"));
    await feedbackStore.write(originalRepairFeedbackArchiveKey(snapshot.snapshotId), createOriginalRepairFeedbackArchiveRecord(snapshot));
    await feedbackStore.write("automatic-own-pr-repair-state", { schemaVersion: 2, feedbackSnapshots: [], repairs: [], published: [{
      repository: snapshot.repository, number: snapshot.number, feedbackDigest: snapshot.feedbackDigest, commitOid: HEAD,
      confirmationId: "confirmation-push", feedbackSnapshotId: snapshot.snapshotId, feedbackSnapshotArchive: originalRepairFeedbackArchiveReference(snapshot),
    }] });
    const reader = new GitHubReviewReader({ originalRepairFeedbackReader: new OriginalRepairFeedbackReader({ store: feedbackStore }),
      runText: async () => "", run: async (_command, args) => {
        if (args[3] === "user") return { login: "author" };
        if (args[3] === "repos/acme/repo/pulls/42/files?per_page=100") return [[]];
        assert.equal(args[3], "graphql");
        return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: { number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN",
          author: { login: "author" }, changedFiles: 0, baseRefName: "main", baseRefOid: BASE, headRefName: "fix", headRefOid: HEAD,
          baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: BASE } },
          headRef: { name: "fix", repository: { nameWithOwner: "acme/repo" }, target: { oid: HEAD } }, headRepository: { nameWithOwner: "acme/repo" } } } } };
      } });
    const metadata = { kind: "own_pr_repair", headRefOid: HEAD, feedbackDigest: snapshot.feedbackDigest,
      publicationConfirmationId: "confirmation-push", controlledCommitEvidenceId: "controlled-fix" };
    const evidence = [`head:${HEAD}`, "publication:confirmation-push", "controlled-commit:controlled-fix"];
    const decision = { schemaVersion: 1, summary: "Internal review assessed", confidence: 90,
      intent: { schemaVersion: 1, type: "complete", summary: "Internal static assessment complete", reason: "Original requests assessed against the current code",
        outcome: "done", evidence } };
    let feedbackText = "";
    const provider = createNativeCodexBrainProvider({ id: "native-feedback", cliKind: "codex-cli", credentialMode: "codex-native-login", timeoutMs: 5_000 }, {
      environment: { ...process.env, CODEX_HOME: home, DIH_CODEX_NATIVE_TRANSPORT: "app-server" }, temporaryRoot: path.join(root, "runtime"),
      commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: [] }; } },
      rootDirectoryManager: { async prepare({ directory, validateLocation }) { await validateLocation(); await mkdir(directory, { recursive: true });
        const stat = await lstat(directory, { bigint: true }); return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) }; } },
      reviewReaderFactory: (target, options) => reader.open(target, options),
      appServerRunner: { async run(call) {
        assert.equal((await readFile(path.join(call.cwd, "task.json"), "utf8")).includes("Original defect 9"), false, "model request contains descriptors, never feedback body");
        const url = call.appServer.isolation.reader.url;
        for (const document of ["review-manifest.json", "review.diff", "review-skill/SKILL.md", "review-skill/manifest.json", "repair-feedback-manifest.json", "repair-feedback.json"]) {
          let offset = 0;
          do { const page = await callTool(url, document, offset); if (document === "repair-feedback.json") feedbackText += page.text;
            offset = page.nextOffset; if (partial && document === "repair-feedback.json") break;
          } while (offset !== null);
        }
        await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(decision) }));
        const stdout = JSON.stringify({ type: "thread.started", thread_id: "feedback-review-thread" });
        return { exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.from(stdout), stderrBytes: Buffer.alloc(0) };
      } },
    });
    t.after(() => provider.close());
    const engine = new RoleDecisionEngine({ definition: { id: "pr-engineer", name: "PR engineer", mission: "Internal assessment", enabled: true },
      permissions: { allowedIntents: ["complete", "handoff", "propose_github_review"] },
      brain: { provider: provider.id, model: "fixture", remoteData: { requirements: true, code: true, memory: false } },
      brainRouter: new BrainRouter({ providers: [provider] }) });
    const event = { eventType: "pull_request.internal_review_requested", subject: { repository: "acme/repo", number: 42 },
      payload: { headRefOid: HEAD, internalReview: metadata } };
    const outcome = engine.decide({ item: { event }, context: { requirements: {}, code: { sourceEvent: event,
      originalRepairFeedback: descriptor, pullRequest: { reviewMaterial: { gitTarget } } } } });
    if (partial) await assert.rejects(outcome, { code: "PR_REVIEW_READ_INCOMPLETE" });
    else { assert.equal((await outcome).intent.type, "complete"); assert.match(feedbackText, /Original defect 9/); assert.match(feedbackText, /Author reply 9/); }
  });
}
