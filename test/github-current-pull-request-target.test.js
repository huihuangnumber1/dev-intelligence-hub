import assert from "node:assert/strict";
import test from "node:test";
import {
  projectGitHubCurrentPullRequestTarget,
  readGitHubCurrentPullRequestTargetBatch,
} from "../src/adapters/github-current-pull-request-target.js";

const identity = { repository: "acme/repo", number: 42, sourceAccountId: "reviewer" };
const OLD = "a".repeat(40), LIVE = "c".repeat(40), HEAD = "b".repeat(40);
function repository(number = 42) {
  return { nameWithOwner: "acme/repo", pullRequest: {
    number, url: `https://github.com/acme/repo/pull/${number}`, state: "OPEN",
    author: { login: "author" }, changedFiles: 2,
    baseRefName: "main", baseRefOid: OLD,
    baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: LIVE } },
    headRefName: "feature", headRefOid: HEAD,
    headRepository: { nameWithOwner: "contributor/repo" },
    headRef: { name: "feature", repository: { nameWithOwner: "contributor/repo" }, target: { oid: HEAD } },
  } };
}
const response = (repo = repository()) => ({ data: { repository: repo } });

test("current target uses live base commit when the PR scalar still records an older base", () => {
  const observed = projectGitHubCurrentPullRequestTarget(response(), identity);
  assert.equal(observed.gitTarget.baseRefOid, LIVE);
  assert.equal(observed.gitTarget.headRefOid, HEAD);
});

test("missing, deleted, malformed or contradictory live refs never fall back to PR scalars", async (t) => {
  for (const [name, change] of [
    ["deleted base", (pr) => { pr.baseRef = null; }],
    ["missing base", (pr) => { delete pr.baseRef; }],
    ["missing base target", (pr) => { pr.baseRef.target = null; }],
    ["non-commit base", (pr) => { pr.baseRef.target = {}; }],
    ["invalid base oid", (pr) => { pr.baseRef.target.oid = "main"; }],
    ["wrong base ref", (pr) => { pr.baseRef.name = "develop"; }],
    ["wrong base repo", (pr) => { pr.baseRef.repository.nameWithOwner = "attacker/repo"; }],
    ["deleted head", (pr) => { pr.headRef = null; }],
    ["moved head", (pr) => { pr.headRef.target.oid = LIVE; }],
    ["wrong head ref", (pr) => { pr.headRef.name = "other"; }],
    ["wrong head repo", (pr) => { pr.headRef.repository.nameWithOwner = "attacker/repo"; }],
  ]) await t.test(name, () => {
    const repo = repository(); change(repo.pullRequest);
    assert.throws(() => projectGitHubCurrentPullRequestTarget(response(repo), identity), { code: "GITHUB_CURRENT_PR_TARGET_INVALID" });
  });
});

test("current target rejects account-independent PR identity substitution and active payloads", () => {
  const repo = repository(); repo.nameWithOwner = "attacker/repo";
  assert.throws(() => projectGitHubCurrentPullRequestTarget(response(repo), identity));
  const active = repository(); let evaluated = false;
  Object.defineProperty(active.pullRequest, "baseRef", { enumerable: true, get() { evaluated = true; return {}; } });
  assert.throws(() => projectGitHubCurrentPullRequestTarget(response(active), identity));
  assert.equal(evaluated, false);
});

test("terminal observations retire work without requiring deleted refs or inventing an executable target", () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const repo = repository(); repo.pullRequest.state = state;
    repo.pullRequest.baseRef = null; repo.pullRequest.headRef = null; repo.pullRequest.headRepository = null;
    const observed = projectGitHubCurrentPullRequestTarget(response(repo), identity);
    assert.equal(observed.state, state); assert.equal(observed.gitTarget, null);
    assert.equal(observed.headRefOid, HEAD);
  }
});

test("one batch reads at most 25 coherent PR observations and rejects partial results", async () => {
  const identities = Array.from({ length: 25 }, (_, i) => ({ ...identity, number: i + 1 }));
  let calls = 0;
  const run = async (_command, args) => {
    calls += 1; assert.ok(args.includes("graphql"));
    return { data: Object.fromEntries(identities.map((entry, i) => [`r${i}`, repository(entry.number)])) };
  };
  assert.equal((await readGitHubCurrentPullRequestTargetBatch(run, identities)).length, 25);
  assert.equal(calls, 1);
  await assert.rejects(readGitHubCurrentPullRequestTargetBatch(run, [...identities, identity]));
  assert.equal(calls, 1);
  await assert.rejects(readGitHubCurrentPullRequestTargetBatch(async () => ({ data: { r0: repository() } }), identities));
});

test("a deleted discovery ref cannot mask malformed surviving refs", async () => {
  for (const change of [
    (pr) => { pr.baseRef.name = "other"; },
    (pr) => { pr.baseRef.repository.nameWithOwner = "attacker/repo"; },
    (pr) => { pr.baseRef.target.oid = "invalid"; },
    (pr) => { delete pr.baseRef; },
  ]) {
    const repo = repository(); repo.pullRequest.headRef = null; change(repo.pullRequest);
    await assert.rejects(readGitHubCurrentPullRequestTargetBatch(async () => ({ data: { r0: repo } }), [identity]));
  }
});

test("a moved discovery head is unavailable only after every remaining target field validates", async () => {
  const repo = repository();
  repo.pullRequest.headRef.target.oid = LIVE;
  const [observed] = await readGitHubCurrentPullRequestTargetBatch(async () => ({ data: { r0: repo } }), [identity]);
  assert.equal(observed.gitTarget, null);
  assert.equal(observed.gitTargetUnavailableReason, "HEAD_REF_CHANGED");
  assert.throws(() => projectGitHubCurrentPullRequestTarget(response(repo), identity), { code: "GITHUB_CURRENT_PR_TARGET_INVALID" });
  for (const change of [
    pr => { pr.baseRef = null; pr.headRef.target.oid = "invalid"; },
    pr => { pr.baseRef.repository.nameWithOwner = "attacker/repo"; },
    pr => { pr.baseRef.target.oid = "invalid"; },
    pr => { pr.headRef.repository.nameWithOwner = "attacker/repo"; },
    pr => { pr.headRefName = pr.headRef.name = "../unsafe"; },
    pr => { pr.headRepository.nameWithOwner = undefined; },
    pr => { delete pr.baseRef; },
  ]) {
    const malformed = structuredClone(repo);
    change(malformed.pullRequest);
    await assert.rejects(readGitHubCurrentPullRequestTargetBatch(async () => ({ data: { r0: malformed } }), [identity]),
      { code: "GITHUB_CURRENT_PR_TARGET_INVALID" });
  }
});

test("discovery rejects mixed object formats instead of hiding them as a moved head", async (t) => {
  for (const [scalarLength, liveLength] of [[64, 40], [40, 64]]) {
    await t.test(`PR head ${scalarLength}, live head and base ${liveLength}`, async () => {
      const repo = repository();
      repo.pullRequest.headRefOid = "b".repeat(scalarLength);
      repo.pullRequest.headRef.target.oid = "c".repeat(liveLength);
      repo.pullRequest.baseRef.target.oid = "a".repeat(liveLength);
      await assert.rejects(readGitHubCurrentPullRequestTargetBatch(async () => ({ data: { r0: repo } }), [identity]),
        { code: "GITHUB_CURRENT_PR_TARGET_INVALID" });
    });
  }
});
