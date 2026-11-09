import assert from "node:assert/strict";
import test from "node:test";
import { readGitHubReferencedMaterials } from "../src/adapters/github-referenced-materials.js";

function fixture({ missing = false, wrongParent = false } = {}) {
  const calls = [];
  const root = "https://github.com/acme/product/issues/7";
  const comment = (id, body) => ({ id, node_id: `IC_${id}`, user: { login: id === 9 ? "developer" : "qa" }, body,
    created_at: "2026-10-28T05:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: `${root}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/acme/product/issues/${wrongParent ? 8 : 7}` });
  const run = async (command, args) => { assert.equal(command, "gh"); const endpoint = args[3]; calls.push(endpoint);
    if (missing) throw new Error("read unavailable");
    if (endpoint === "repos/acme/product/issues/7") return { number: 7, title: "Hardware behavior", body: "Original report", state: "open",
      user: { login: "qa" }, created_at: "2026-10-28T04:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: root, comments: 2 };
    if (endpoint === "repos/acme/product/issues/7/comments?per_page=20&page=1") {
      assert.equal(args.includes("--paginate"), false);
      return [comment(9, "QA validation procedure; execution pending"), comment(10, "Executed the requested scenarios; actual results recorded")];
    }
    throw new Error("unexpected request"); };
  const input = { run, repository: "acme/repo", pullRequestNumber: 42,
    bodies: [`Author supplement: ${root}#issuecomment-9`, `same source again ${root}#issuecomment-9`,
      "Current PR https://github.com/acme/repo/pull/42", "unrelated host https://github.com.attacker.invalid/acme/repo/issues/1"] };
  return { input, calls };
}

test("referenced issue material includes the anchored plan and later QA results without recursive fetches", async () => {
  const f = fixture(); const result = await readGitHubReferencedMaterials(f.input);
  assert.equal(Object.keys(result.documents).length, 1);
  const body = JSON.parse(Object.values(result.documents)[0]);
  assert.equal(body.issue.title, "Hardware behavior");
  assert.equal(body.comments.length, 2);
  assert.match(body.comments[0].body, /execution pending/);
  assert.match(body.comments[1].body, /actual results/);
  assert.equal(f.calls.length, 2);
  assert.equal(result.references.length, 1);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("missing or mismatched linked material is an internal read error", async () => {
  for (const options of [{ missing: true }, { wrongParent: true }]) {
    await assert.rejects(readGitHubReferencedMaterials(fixture(options).input), { code: "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE" });
  }
});

test("reference pagination is complete and oversized discussions stop before all pages are fetched", async () => {
  const f = fixture(); const original = f.input.run;
  let pages = 0;
  f.input.run = async (command, args) => {
    if (args[3] === "repos/acme/product/issues/7") return { ...await original(command, args), comments: 2000 };
    if (args[3].includes("/comments?")) {
      pages++;
      return Array.from({ length: 20 }, (_, offset) => {
        const id = (pages - 1) * 20 + offset + 9;
        return { id, body: "测".repeat(25000), user: { login: "qa" }, created_at: "2026-10-28T05:00:00Z", updated_at: "2026-10-28T05:00:00Z",
          html_url: `https://github.com/acme/product/issues/7#issuecomment-${id}`, issue_url: "https://api.github.com/repos/acme/product/issues/7" };
      });
    }
    return original(command, args);
  };
  await assert.rejects(readGitHubReferencedMaterials(f.input), { code: "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE" });
  assert.equal(pages, 3, "byte overflow stops reading instead of fetching all 100 pages");
});

test("missing anchored evidence and inconsistent pagination cannot look like complete material", async () => {
  for (const kind of ["anchor", "count", "duplicate", "malformed-page"]) {
    const f = fixture(); const original = f.input.run;
    if (kind === "anchor") f.input.bodies = ["https://github.com/acme/product/issues/7#issuecomment-999"];
    f.input.run = async (command, args) => {
      const value = await original(command, args);
      if (args[3].includes("/comments?")) {
        if (kind === "count") return value.slice(0, 1);
        if (kind === "duplicate") return [value[0], value[0]];
        if (kind === "malformed-page") return { values: value };
      }
      return value;
    };
    await assert.rejects(readGitHubReferencedMaterials(f.input), { code: "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE" });
  }
});

test("explicit Review and inline links include later replies from other Reviews and bind their contents", async () => {
  const root = "https://github.com/acme/product/pull/7";
  let reply = "Later QA: verified on hardware";
  let invalidParent = false, missingRoot = false, inlineReads = 0;
  const run = async (_command, args) => {
    const endpoint = args[3];
    if (endpoint === "repos/acme/product/issues/7") return { number: 7, title: "Linked PR", body: "Context", state: "open", comments: 0,
      user: { login: "developer" }, created_at: "2026-10-28T04:00:00Z", updated_at: "2026-10-28T05:00:00Z", html_url: root };
    if (endpoint === "repos/acme/product/issues/7/comments?per_page=20&page=1") return [];
    if (endpoint === "repos/acme/product/pulls/7/reviews/11") return { id: 11, body: "See inline discussion", state: "COMMENTED",
      user: { login: "reviewer" }, submitted_at: "2026-10-28T05:00:00Z", html_url: `${root}#pullrequestreview-11` };
    if (endpoint === "repos/acme/product/pulls/7/comments?per_page=20&page=1") {
      inlineReads++;
      const comment = (id, reviewId, body, replyTo = null) => ({ id, pull_request_review_id: reviewId, in_reply_to_id: replyTo,
        body, user: { login: "qa" }, created_at: "2026-10-28T05:00:00Z", updated_at: "2026-10-28T05:00:00Z",
        html_url: `${root}#discussion_r${id}`, pull_request_url: `https://api.github.com/repos/acme/product/pulls/${invalidParent ? 8 : 7}` });
      return [...(missingRoot ? [] : [comment(100, 11, "Check hardware edge")]), comment(101, 12, reply, 100), comment(102, 99, "Unrelated thread")];
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const input = { run, repository: "acme/repo", pullRequestNumber: 42, bodies: [`${root}#pullrequestreview-11 ${root}#discussion_r101`] };
  const before = await readGitHubReferencedMaterials(input);
  const snapshot = JSON.parse(Object.values(before.documents)[0]);
  assert.equal(inlineReads, 1, "shared reference downloads inline comments once");
  assert.deepEqual(snapshot.anchors.map(anchor => anchor.comments.map(comment => comment.id)), [["100", "101"], ["100", "101"]]);
  assert.match(snapshot.anchors[0].comments[1].body, /verified on hardware/);
  reply = "QA correction: reconnect fails";
  assert.notEqual((await readGitHubReferencedMaterials(input)).digest, before.digest);
  invalidParent = true;
  await assert.rejects(readGitHubReferencedMaterials(input), { code: "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE" });
  invalidParent = false; missingRoot = true;
  await assert.rejects(readGitHubReferencedMaterials(input), { code: "PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE" });
});
