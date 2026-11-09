import assert from "node:assert/strict";
import test from "node:test";

import { issuePrDetailMarkup, issuePrSummary } from "../public/issue-pr-status.js";

const issue = { kind: "issue" };
const pr = (relation, state, overrides = {}) => ({
  repo: "example/repo",
  number: 42,
  title: "Fix",
  state,
  relation,
  url: "https://github.com/example/repo/pull/42",
  ...overrides,
});

test("Issue status keeps mentions separate from formal links and never treats merge as acceptance", () => {
  assert.equal(issuePrSummary(issue).label, "PR 关联待刷新");
  assert.equal(issuePrSummary({ ...issue, pullRequestLinks: { complete: true, links: [] } }).label, "未发现关联 PR");
  assert.equal(issuePrSummary({ ...issue, pullRequestLinks: { complete: true, links: [pr("mention", "merged")] } }).label, "有 PR 提及，待核对");
  assert.equal(issuePrSummary({ ...issue, pullRequestLinks: { complete: true, links: [pr("formal", "open")] } }).label, "关联 PR 进行中");
  assert.equal(issuePrSummary({ ...issue, pullRequestLinks: { complete: true, links: [pr("formal", "closed")] } }).label, "关联 PR 已关闭");
  const merged = issuePrSummary({ ...issue, pullRequestLinks: { complete: true, links: [pr("formal", "merged")] } });
  assert.equal(merged.label, "关联 PR 已合并，待验收");
  assert.equal(merged.closeAdvice, "验收通过后可关闭");
});

test("Issue PR detail links show source and escape external titles", () => {
  const markup = issuePrDetailMarkup({
    ...issue,
    pullRequestLinks: {
      complete: false,
      links: [pr("mention", "open", { title: "<img onerror=alert(1)>" })],
    },
  });
  assert.match(markup, /仅提及/u);
  assert.match(markup, /部分记录/u);
  assert.match(markup, /先核对未读到的 PR/u);
  assert.match(markup, /href="https:\/\/github.com\/example\/repo\/pull\/42"/u);
  assert.doesNotMatch(markup, /<img/u);
  assert.equal(issuePrDetailMarkup({ kind: "pull_request" }), "");
});
