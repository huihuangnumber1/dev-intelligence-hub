import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  githubWorkItemFromUrl,
  manualHistoricalWorkMarkup,
  manualWorkAssignmentMarkup,
  ownerWorkRequestForItem,
  createManualWorkAssignmentAttempts,
} from "../public/manual-work-assignment.js";

const pullRequest = {
  id: "github:pr:ExampleOrg/SoftwareApp#23991",
  kind: "pull_request",
  repo: "ExampleOrg/SoftwareApp",
  number: 23991,
  title: "新增 Retina Thickness-Trend 分析页面",
  url: "https://github.com/ExampleOrg/SoftwareApp/pull/23991",
};

test("manual assignment retry keeps its request ID and frozen payload until success", () => {
  let nextId = 0;
  const attempts = createManualWorkAssignmentAttempts(() => `request-${++nextId}`);
  const options = { workType: "pull_request", priority: "high" };
  const first = attempts.requestFor(pullRequest, options);
  const retry = attempts.requestFor({ ...pullRequest, summary: "Refreshed while retrying" }, options);
  assert.deepEqual(retry, first);
  first.description = "Caller mutation must not change the saved retry";
  assert.deepEqual(attempts.requestFor(pullRequest, options), retry);
  assert.equal(nextId, 1);
  const otherPriority = attempts.requestFor(pullRequest, { ...options, priority: "urgent" });
  const otherPr = attempts.requestFor({ ...pullRequest, number: 1 }, options);
  const development = attempts.requestFor(pullRequest, { ...options, workType: "development" });
  assert.equal(new Set([retry, otherPriority, otherPr, development].map((entry) => entry.requestId)).size, 4);
  attempts.complete(retry.requestId);
  assert.notEqual(attempts.requestFor(pullRequest, options).requestId, retry.requestId);
  attempts.complete(retry.requestId);
  assert.equal(attempts.requestFor(pullRequest, options).requestId, "request-5");
});

test("detail form coalesces double submits and reuses a failed request after reopening", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function showDetail(item)");
  const end = app.indexOf("\nfunction codeJobActionFocusIntent", start);
  assert.ok(start >= 0 && end > start);
  let activeForm;
  function createForm() {
    const button = { disabled: false };
    const status = { textContent: "" };
    const section = { outerHTML: "" };
    return {
      button, status, section,
      values: { workType: "pull_request", priority: "high" },
      querySelector(selector) { return selector.startsWith("button") ? button : status; },
      closest() { return section; },
      addEventListener(_type, handler) { this.submit = handler; },
    };
  }
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  const bodies = [];
  let requestIds = 0;
  const context = {
    manualWorkAssignmentAttempts: createManualWorkAssignmentAttempts(() => `id-${++requestIds}`),
    manualWorkAssignmentMarkup,
    dialogContent: { querySelector() { return activeForm; } },
    dialog: { showModal() {} },
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.values[key]; } },
    kindLabel: () => "PR",
    escapeHtml: (value) => String(value ?? ""),
    dingtalkDetailMarkup: () => "", prLifecycleStatusMarkup: () => "",
    brainAssessment: () => "", issuePrDetailMarkup: () => "",
    githubItemDetailMarkup: () => "", detailRows: () => "",
    async fetch(_url, options) {
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1 ? firstResponse : {
        ok: true, status: 200,
        async json() { return { requestId: bodies.at(-1).requestId, workItemId: "one-work-item", assignment: { target: { id: "pr-engineer" } } }; },
      };
    },
  };
  runInNewContext(app.slice(start, end), context);
  activeForm = createForm();
  context.showDetail(pullRequest);
  const firstForm = activeForm;
  const submit = (form) => form.submit({ currentTarget: form, preventDefault() {} });
  const pending = submit(firstForm);
  await submit(firstForm);
  assert.equal(bodies.length, 1);
  resolveFirst({ ok: false, status: 503, async json() { return { error: "请求已保存" }; } });
  await pending;
  assert.match(firstForm.status.textContent, /请求已保存.*id-1/);
  assert.equal(firstForm.button.disabled, false);
  assert.equal(firstForm.button.textContent, "重试原请求");

  activeForm = createForm();
  context.showDetail({ ...pullRequest, title: "Updated title" });
  await submit(activeForm);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(activeForm.section.outerHTML, /one-work-item/);
  assert.equal(requestIds, 1);
});

test("PR detail offers a manual assignment form with a direct review option", () => {
  const markup = manualWorkAssignmentMarkup(pullRequest);

  assert.match(markup, /手动分配工作/);
  assert.match(markup, /PR Review \/ 推进/);
  assert.match(markup, /开发实现/);
  assert.match(markup, /测试验证/);
  assert.match(markup, /data-manual-work-assignment/);
});

test("a PR review assignment freezes the structured PR target", () => {
  const request = ownerWorkRequestForItem(pullRequest, {
    workType: "pull_request",
    priority: "high",
    requestId: "12345678-1234-4123-8123-123456789abc",
  });

  assert.equal(request.schemaVersion, 2);
  assert.deepEqual(request.pullRequest, {
    repository: "ExampleOrg/SoftwareApp",
    number: 23991,
  });
  assert.match(request.description, /github\.com\/ExampleOrg\/SoftwareApp\/pull\/23991/);
  assert.equal(request.acceptanceCriteria.length, 2);
});

test("an Issue development assignment becomes an audited capability request", () => {
  const request = ownerWorkRequestForItem({
    kind: "issue",
    repo: "ExampleOrg/ProductApp",
    number: 12917,
    title: "Retina Thickness Change 页面",
    url: "https://github.com/ExampleOrg/ProductApp/issues/12917",
  }, {
    workType: "development",
    priority: "urgent",
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });

  assert.equal(request.schemaVersion, 6);
  assert.deepEqual(request.issue, {
    repository: "ExampleOrg/ProductApp",
    number: 12917,
  });
  assert.equal(request.workType, "development");
  assert.match(request.description, /ExampleOrg\/ProductApp #12917/);
});

test("an approved PR testing handoff binds the configured GitHub test owner", () => {
  const request = ownerWorkRequestForItem(pullRequest, {
    workType: "testing",
    priority: "high",
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    responsiblePerson: { login: "qt-tester-primary", product: "qt" },
  });

  assert.equal(request.schemaVersion, 3);
  assert.deepEqual(request.responsiblePerson, {
    login: "qt-tester-primary",
    product: "qt",
  });
  assert.deepEqual(request.pullRequest, {
    repository: pullRequest.repo,
    number: pullRequest.number,
  });
  assert.match(request.title, /负责人 @qt-tester-primary/);
  assert.match(request.description, /指定测试负责人/);
});

test("review and self-fix handoffs preserve their named responsible person", () => {
  const reviewer = ownerWorkRequestForItem(pullRequest, {
    workType: "pull_request",
    priority: "high",
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    responsiblePerson: { login: "qt-reviewer", product: "qt" },
  });
  const developer = ownerWorkRequestForItem(pullRequest, {
    workType: "development",
    priority: "high",
    requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    responsiblePerson: { login: "local-owner", product: "qt" },
  });

  assert.equal(reviewer.schemaVersion, 4);
  assert.deepEqual(reviewer.responsiblePerson, {
    login: "qt-reviewer",
    product: "qt",
  });
  assert.deepEqual(reviewer.pullRequest, {
    repository: pullRequest.repo,
    number: pullRequest.number,
  });
  assert.ok(
    reviewer.acceptanceCriteria.includes(
      "PR Review / 推进结果明确交付给 @qt-reviewer",
    ),
  );
  assert.equal(developer.schemaVersion, 4);
  assert.deepEqual(developer.pullRequest, reviewer.pullRequest);
  assert.match(developer.description, /指定负责人：@local-owner/);
});

test("assignment result replaces the form with its durable work item", () => {
  const markup = manualWorkAssignmentMarkup(pullRequest, {
    target: "pr-engineer",
    workItemId: "work-item-123",
    requestId: "request-123",
  });

  assert.match(markup, /已分配工作/);
  assert.match(markup, /pr-engineer/);
  assert.match(markup, /work-item-123/);
  assert.ok(!markup.includes("<form"));
});

test("a GitHub PR or Issue URL becomes a bounded manual work item", () => {
  assert.deepEqual(
    githubWorkItemFromUrl(
      "https://github.com/ExampleOrg/SoftwareApp/pull/23991?notification_referrer_id=1#discussion",
    ),
    {
      id: "github:pr:ExampleOrg/SoftwareApp#23991",
      kind: "pull_request",
      repo: "ExampleOrg/SoftwareApp",
      number: 23991,
      title: "ExampleOrg/SoftwareApp #23991",
      url: "https://github.com/ExampleOrg/SoftwareApp/pull/23991",
      summary: "由你通过 GitHub 地址人工加入日常任务",
    },
  );
  assert.deepEqual(
    githubWorkItemFromUrl("https://github.com/ExampleOrg/ProductApp/issues/12917/"),
    {
      id: "github:issue:ExampleOrg/ProductApp#12917",
      kind: "issue",
      repo: "ExampleOrg/ProductApp",
      number: 12917,
      title: "ExampleOrg/ProductApp #12917",
      url: "https://github.com/ExampleOrg/ProductApp/issues/12917",
      summary: "由你通过 GitHub 地址人工加入日常任务",
    },
  );
});

test("manual GitHub URL parsing rejects ambiguous or untrusted targets", () => {
  for (const value of [
    "http://github.com/acme/repo/pull/1",
    "https://evil.example/acme/repo/pull/1",
    "https://user@github.com/acme/repo/pull/1",
    "https://github.com/acme/repo/pulls/1",
    "https://github.com/acme/repo/issues/not-a-number",
    "https://github.com/acme/repo/issues/1/comments",
  ]) {
    assert.throws(
      () => githubWorkItemFromUrl(value),
      /GitHub PR 或 Issue 地址无效/,
    );
  }
});

test("work view exposes an explicit historical task form", () => {
  const markup = manualHistoricalWorkMarkup();

  assert.match(markup, /人工加入历史任务/);
  assert.match(markup, /name="sourceUrl"/);
  assert.match(markup, /name="workType"/);
  assert.match(markup, /data-manual-historical-work/);
  assert.match(markup, /不会扩大自动扫描范围/);
});

test("manual Issue work keeps its canonical GitHub identity", () => {
  const request = ownerWorkRequestForItem(
    githubWorkItemFromUrl("https://github.com/ExampleOrg/ProductApp/issues/12917"),
    {
      workType: "development",
      priority: "high",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    },
  );

  assert.equal(request.schemaVersion, 6);
  assert.deepEqual(request.issue, {
    repository: "ExampleOrg/ProductApp",
    number: 12917,
  });
});
