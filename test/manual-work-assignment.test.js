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
  bindManualWorkAssignment,
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

test("detail retries preserve their request and reopening restores the durable assignment", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf("function showDetail(item)");
  const end = app.indexOf("\nfunction codeJobActionFocusIntent", start);
  assert.ok(start >= 0 && end > start);
  let activeForm;
  let activeContainer;
  function createForm() {
    const button = { disabled: false };
    const status = { textContent: "" };
    return {
      button, status,
      values: { workType: "pull_request", priority: "high" },
      elements: { namedItem(name) { return { value: activeForm.values[name] }; } },
      querySelector(selector) { return selector.startsWith("button") ? button : status; },
      addEventListener(_type, handler) { this.submit = handler; },
    };
  }
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  const bodies = [];
  let savedRecords = [];
  let requestIds = 0;
  const context = {
    manualWorkAssignmentAttempts: createManualWorkAssignmentAttempts(() => `id-${++requestIds}`),
    bindManualWorkAssignment,
    dialogContent: { querySelector() { return activeContainer; } },
    dialog: { showModal() {} },
    kindLabel: () => "PR",
    escapeHtml: (value) => String(value ?? ""),
    dingtalkDetailMarkup: () => "", prLifecycleStatusMarkup: () => "",
    brainAssessment: () => "", issuePrDetailMarkup: () => "",
    githubItemDetailMarkup: () => "", detailRows: () => "",
    async fetch(url, options) {
      if (options.method !== "POST") {
        assert.equal(new URL(url, "http://localhost").searchParams.get("sourceUrl"), pullRequest.url);
        assert.equal(options.cache, "no-store");
        return { ok: true, async json() { return { items: savedRecords, nextCursor: null }; } };
      }
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1 ? firstResponse : {
        ok: true, status: 200,
        async json() {
          const result = { requestId: bodies.at(-1).requestId, phase: "intaken", request: bodies.at(-1), workItemId: "one-work-item", assignment: { target: { id: "pr-engineer" } } };
          savedRecords = [result];
          return result;
        },
      };
    },
  };
  runInNewContext(app.slice(start, end), context);
  function reopen(item) {
    if (activeContainer) activeContainer.isConnected = false;
    activeForm = createForm();
    activeContainer = { isConnected: true, innerHTML: "", querySelectorAll() { return [activeForm]; } };
    return context.showDetail(item);
  }
  await reopen(pullRequest);
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

  await reopen({ ...pullRequest, title: "Updated title" });
  await submit(activeForm);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(activeContainer.innerHTML, /one-work-item/);
  assert.equal(requestIds, 1);

  // Even a fresh browser controller must recover the assignment from the server.
  context.manualWorkAssignmentAttempts = createManualWorkAssignmentAttempts(() => `fresh-${++requestIds}`);
  await reopen({ ...pullRequest, title: "Reopened after assignment" });
  assert.match(activeContainer.innerHTML, /已分配工作/);
  assert.match(activeContainer.innerHTML, /one-work-item/);
  assert.match(activeContainer.innerHTML, /PR 工程师/);
  assert.match(activeContainer.innerHTML, /<details>\s*<summary>另行分配工作/);
  assert.doesNotMatch(activeContainer.innerHTML, /<details open/);
  assert.equal(bodies.length, 2);
});

test("assignment history loads every page and ignores detached dialogs", async () => {
  const container = { isConnected: true, innerHTML: "", querySelectorAll() { return []; } };
  const calls = [];
  await bindManualWorkAssignment(container, pullRequest, {
    async fetchImpl(url) {
      calls.push(new URL(url, "http://localhost").searchParams.get("cursor"));
      return { ok: true, async json() { return { items: [{ requestId: `record-${calls.length}`, request: { workType: "testing" }, phase: "intaken", assignment: { target: { id: "tester" } } }], nextCursor: calls.length === 1 ? "next-page" : null }; } };
    },
  });
  assert.deepEqual(calls, [null, "next-page"]);
  assert.match(container.innerHTML, /record-1/);
  assert.match(container.innerHTML, /record-2/);
  let resolve;
  const pending = bindManualWorkAssignment(container, pullRequest, {
    fetchImpl: () => new Promise((done) => { resolve = done; }),
  });
  container.isConnected = false;
  container.innerHTML = "different dialog";
  resolve({ ok: true, async json() { return { items: [], nextCursor: null }; } });
  await pending;
  assert.equal(container.innerHTML, "different dialog");
});

test("assignment detail shows current blocking and folds retired tasks into history", async () => {
  const container = { isConnected: true, innerHTML: "", querySelectorAll() { return []; } };
  const record = (id, status, statusReason) => ({
    requestId: id, workItemId: `work-${id}`, phase: "intaken", request: { workType: "general" },
    assignment: { target: { id: "pr-engineer" } },
    progress: { status, statusReason, currentTarget: { type: "role", id: "developer" } },
  });
  await bindManualWorkAssignment(container, pullRequest, {
    async fetchImpl() { return { ok: true, async json() { return { items: [
      record("active", "blocked", "pr_source_cross_root_cutover_pending:predecessor"),
      record("retired", "blocked", "pr_source_cross_root_cutover_retired"),
      record("replaced", "superseded", "pr_source_cross_root_cutover_replaced"),
      { ...record("unknown", "queued"), progress: null },
    ], nextCursor: null }; } }; },
  });
  const [current, history] = container.innerHTML.split('<details data-assignment-history>');
  assert.match(current, /当前分配/);
  assert.match(current, /等待旧任务交接/);
  assert.match(current, /开发工程师/);
  assert.match(current, /台账状态暂不可用/);
  assert.doesNotMatch(current, /work-retired|work-replaced/);
  assert.match(history, /历史分配（2）/);
  assert.match(history, /已停用/);
  assert.match(history, /已被替代/);
  assert.doesNotMatch(container.innerHTML, /<details[^>]* open/);
});

test("old assignments show their dates and do not imply automatic work is absent", async () => {
  const container = { isConnected: true, innerHTML: "", querySelectorAll() { return []; } };
  await bindManualWorkAssignment(container, pullRequest, {
    async fetchImpl() { return { ok: true, async json() { return { items: [{
      requestId: 'old-request', workItemId: 'old-work', phase: 'intaken', request: { workType: 'general' },
      createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-17T09:04:02.000Z',
      assignment: { target: { id: 'orchestrator' } }, progress: { status: 'superseded' },
    }], nextCursor: null }; } }; },
  });
  assert.match(container.innerHTML, /当前没有进行中的分配请求/);
  assert.match(container.innerHTML, /创建于/);
  assert.match(container.innerHTML, /2026-10-04/);
  assert.match(container.innerHTML, /更新于/);
  assert.match(container.innerHTML, /2026-10-17/);
  assert.doesNotMatch(container.innerHTML, /<details[^>]* open/);
});

test("failed assignment lookup offers a read retry without an unverified create form", async () => {
  let retry;
  let reads = 0;
  const container = { isConnected: true, innerHTML: "", querySelector() { return { addEventListener(_event, handler) { retry = handler; } }; } };
  await bindManualWorkAssignment(container, pullRequest, {
    async fetchImpl() {
      reads++;
      return { ok: false, status: 503 };
    },
  });
  assert.match(container.innerHTML, /未能读取分配记录/);
  assert.doesNotMatch(container.innerHTML, /<form/);
  assert.equal(reads, 1);
  assert.equal(typeof retry, "function");
});

test("reopened pending assignment resumes its stored urgent development request", async () => {
  const input = ownerWorkRequestForItem(pullRequest, {
    workType: "development", priority: "urgent", requestId: "saved-request-id",
  });
  const saved = { phase: "routed", requestId: input.requestId, request: input, assignment: { target: { id: "developer" } } };
  let submit;
  const button = { disabled: false };
  const status = { textContent: "" };
  const form = {
    dataset: { manualWorkAssignmentResume: input.requestId },
    querySelector(selector) { return selector.startsWith("button") ? button : status; },
    addEventListener(_event, handler) { submit = handler; },
  };
  const container = { isConnected: true, innerHTML: "", querySelector() { return form; }, querySelectorAll() { return [form]; } };
  const posts = [];
  await bindManualWorkAssignment(container, pullRequest, {
    attempts: createManualWorkAssignmentAttempts(() => { throw new Error("Must reuse the saved request"); }),
    async fetchImpl(_url, options) {
      if (options.method !== "POST") return { ok: true, async json() { return { items: [saved], nextCursor: null }; } };
      posts.push(JSON.parse(options.body));
      return { ok: true, async json() { return { ...saved, phase: "intaken", workItemId: "resumed-work" }; } };
    },
  });
  assert.match(container.innerHTML, /分配请求已保存/);
  assert.match(container.innerHTML, /继续原分配/);
  assert.doesNotMatch(container.innerHTML, /<h3>已分配工作/);
  await submit({ preventDefault() {} });
  assert.deepEqual(posts, [input]);
  assert.match(container.innerHTML, /已分配工作/);
  assert.match(container.innerHTML, /resumed-work/);
});

test("PR detail offers a manual assignment form with a direct review option", () => {
  const markup = manualWorkAssignmentMarkup(pullRequest);

  assert.match(markup, /手动分配工作/);
  assert.match(markup, /PR Review \/ 推进/);
  assert.match(markup, /开发实现/);
  assert.match(markup, /测试验证/);
  assert.match(markup, /data-manual-work-assignment/);
});

test("closed PR manual assignment offers only non-code coordination work", () => {
  for (const state of ["closed", "MERGED"]) {
    const markup = manualWorkAssignmentMarkup({ ...pullRequest, state });

    assert.doesNotMatch(markup, /PR Review \/ 推进/);
    assert.doesNotMatch(markup, /开发实现/);
    assert.doesNotMatch(markup, /测试验证/);
    assert.match(markup, /需求梳理/);
    assert.match(markup, /已关闭/);
  }
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

test("unassigned PR development and testing keep the structured PR target", () => {
  for (const workType of ["development", "testing"]) {
    const request = ownerWorkRequestForItem(pullRequest, {
      workType,
      priority: "high",
      requestId: "12345678-1234-4123-8123-123456789abc",
    });

    assert.equal(request.schemaVersion, 2);
    assert.deepEqual(request.pullRequest, {
      repository: pullRequest.repo,
      number: pullRequest.number,
    });
    assert.equal("responsiblePerson" in request, false);
  }
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
  assert.match(markup, /OPEN/);
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
