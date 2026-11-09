import assert from "node:assert/strict";
import test from "node:test";
import { OwnPrRepairProgressReader } from "../src/services/own-pr-repair-progress-reader.js";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";

const HEAD = "a".repeat(40), REPAIR = "b".repeat(40), DIGEST = "d".repeat(64), FP = "f".repeat(64);
function item(overrides = {}) {
  return { id: "github:pr:acme/repo#42", kind: "pull_request", relation: "authored",
    repo: "acme/repo", number: 42, author: "me", currentUser: "me", headRefOid: HEAD,
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: DIGEST,
    reviewFeedbackFingerprints: [FP], ...overrides };
}
function publication(overrides = {}) {
  return { repository: "acme/repo", number: 42, commitOid: REPAIR, confirmationId: "completed-push",
    feedbackDigest: DIGEST, feedbackFingerprints: [FP], ...overrides };
}
function reader({ published = [publication()], ancestor = true, unavailable = false } = {}) {
  const calls = [];
  const instance = new OwnPrRepairProgressReader({
    store: { async read() { if (unavailable) throw new Error("unavailable"); return { schemaVersion: 1, repairs: [], published }; },
      async write() { assert.fail("Progress reader must be read-only"); } },
    github: { async isCommitAncestor(input) { calls.push(input); if (ancestor instanceof Error) throw ancestor; return ancestor; } },
  });
  return { instance, calls };
}

test("published repair still in the current Head projects waiting Review without approval claims", async () => {
  const { instance, calls } = reader();
  const [result] = await instance.enrich([item()]);
  assert.equal(result.reviewRepairProgress.status, "published");
  assert.equal(result.reviewRepairProgress.headRefOid, HEAD);
  assert.deepEqual(result.reviewRepairProgress.commitOids, [REPAIR]);
  assert.equal(calls.length, 1);
  assert.equal(result.reviewRepairProgress.approved, undefined);
});

for (const [name, options, overrides] of [
  ["removed by force push", { ancestor: false }, {}],
  ["compare unavailable", { ancestor: new Error("unavailable") }, {}],
  ["store unavailable", { unavailable: true }, {}],
  ["new feedback", {}, { reviewFeedbackDigest: "e".repeat(64), reviewFeedbackFingerprints: ["e".repeat(64)] }],
  ["different PR", {}, { number: 43 }],
  ["different repository", {}, { repo: "another/repo" }],
  ["different owner", {}, { author: "another-user" }],
  ["missing full feedback", {}, { reviewFeedbackAvailable: false }],
]) test(`repair progress fails closed when ${name}`, async () => {
  const { instance } = reader(options);
  const [result] = await instance.enrich([item({ reviewRepairProgress: { status: "published" }, ...overrides })]);
  assert.equal(result.reviewRepairProgress, undefined);
});

test("only ancestor-verified publications can contribute to fingerprint coverage", async () => {
  const second = "e".repeat(64);
  const { instance } = reader({ published: [publication({ feedbackDigest: "1".repeat(64) }),
    publication({ commitOid: "c".repeat(40), feedbackDigest: "2".repeat(64), feedbackFingerprints: [second] })] });
  instance.github.isCommitAncestor = async ({ ancestorOid }) => ancestorOid === REPAIR;
  const [result] = await instance.enrich([item({ reviewFeedbackDigest: "3".repeat(64), reviewFeedbackFingerprints: [FP, second] })]);
  assert.equal(result.reviewRepairProgress, undefined);
});

test("fixed-OID successful ancestry is reused while each refresh reevaluates feedback and Head", async () => {
  const { instance, calls } = reader();
  assert.equal((await instance.enrich([item()]))[0].reviewRepairProgress.status, "published");
  assert.equal((await instance.enrich([item()]))[0].reviewRepairProgress.status, "published");
  assert.equal(calls.length, 1);
  await instance.enrich([item({ headRefOid: "c".repeat(40) })]);
  assert.equal(calls.length, 2);
  const [newFeedback] = await instance.enrich([item({ reviewFeedbackDigest: "e".repeat(64), reviewFeedbackFingerprints: [FP, "e".repeat(64)] })]);
  assert.equal(newFeedback.reviewRepairProgress, undefined);
});

test("failed ancestry reads are retried on the next refresh", async () => {
  const { instance } = reader();
  let calls = 0;
  instance.github.isCommitAncestor = async () => { if (++calls === 1) throw new Error("temporary failure"); return true; };
  assert.equal((await instance.enrich([item()]))[0].reviewRepairProgress, undefined);
  assert.equal((await instance.enrich([item()]))[0].reviewRepairProgress.status, "published");
  assert.equal(calls, 2);
});

for (const separatePrs of [false, true]) test(`bounded comparisons eventually verify later repairs (${separatePrs ? "across PRs" : "within one PR"})`, async () => {
  const publications = Array.from({ length: 9 }, (_, index) => publication({
    commitOid: (index + 1).toString(16).padStart(40, "0"), number: separatePrs ? index + 1 : 42,
  }));
  const { instance } = reader({ published: publications });
  const calls = [];
  instance.github.isCommitAncestor = async ({ ancestorOid }) => {
    calls.push(ancestorOid);
    return ancestorOid === publications[8].commitOid;
  };
  const items = separatePrs ? publications.map(row => item({ number: row.number })) : [item()];
  const first = await instance.enrich(items);
  assert.equal(first.at(-1).reviewRepairProgress, undefined);
  assert.equal(calls.length, 8);
  const second = await instance.enrich(items);
  assert.equal(second.at(-1).reviewRepairProgress?.status, "published");
  assert.ok(calls.length <= 16, "Each refresh retains the eight-request cap");
});

for (const [status, behind, mergeBase, expected] of [
  ["ahead", 0, REPAIR, true], ["identical", 0, REPAIR, true],
  ["diverged", 1, REPAIR, false], ["ahead", 0, HEAD, false], ["ahead", 1, REPAIR, false],
]) test(`GitHub ancestry requires matching fixed-OID evidence (${status}/${behind}/${mergeBase === REPAIR})`, async () => {
  let args;
  const github = new GitHubAdapter({ run: async (_command, input) => {
    args = input; return { status, behind_by: behind, merge_base_commit: { sha: mergeBase } };
  } });
  assert.equal(await github.isCommitAncestor({ repository: "acme/repo", ancestorOid: REPAIR, headRefOid: HEAD }), expected);
  assert.equal(args.includes(`repos/acme/repo/compare/${REPAIR}...${HEAD}`), true);
});
