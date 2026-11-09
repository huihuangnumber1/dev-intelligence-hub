import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { validationBrowserLaunchOptions } from
  "../../scripts/playwright-validation-options.mjs";

const publicDirectory = path.resolve("public");
const deferredConfirmationStorageKey = "mydashboard.deferred-confirmations.v1";
const historyDelayMs = 120;
const unknownConfirmationDelayMs = 300;
let appendFailuresRemaining = 1;
let attentionFailuresRemaining = 0;
let dashboardFailuresRemaining = 0;
let externalConflictRemaining = 0;
let externalFactRefreshRemaining = 0;
let confirmationEnabled = false;
let internalAttentionEnabled = false;
let confirmationFixtureName = "active";
let historyMutation = 0;
let queueRevision = 1;
let historyRequestCount = 0;
let deferredRestoreRace = null;
let queueLoadRace = null;
const confirmationSubmissions = [];
const internalSubmissions = [];

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function dashboardFixture() {
  return {
    meta: {
      refreshedAt: "2026-08-06T01:00:00.000Z",
      durationMs: 1,
      sources: { github: 0, dingtalk: 0 },
      errors: [],
      brain: { enabled: false, errors: [] },
    },
    counts: {
      actionNow: 0,
      waitingOther: 0,
      uncertainPullRequests: 0,
      issues: 0,
    },
    groups: {
      actionNow: [],
      waitingOther: [],
      uncertainPullRequests: [],
      historicalPullRequests: [],
      reviewRequested: [],
      myPullRequests: [],
      myIssues: [],
      versions: [],
      dingtalk: [],
    },
    employee: null,
  };
}

function historyItem(status, suffix) {
  return {
    id: `confirmation-history-${suffix}`,
    kind: "github.pull-request-review",
    status,
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: `work-history-${suffix}`,
    },
    title:
      historyMutation
        ? `History mutation ${historyMutation}`
        : suffix === "completed"
        ? "History completed <img data-history-xss src=x onerror=alert(1)>"
        : `History ${suffix}`,
    summary: "Read-only history fixture <script>alert(1)</script>",
    createdAt: "2026-08-06T01:00:00.000Z",
    updatedAt: "2026-08-06T01:01:00.000Z",
    retryable: status === "failed",
    ...(status === "failed"
      ? { diagnosticCode: "GITHUB_LOGIN_UNAVAILABLE" }
      : {}),
    ...(status === "rejected"
      ? {
          diagnosticCode: "GITHUB_MARKER_ABSENT",
          ownerDecision: {
            type: "seal_unknown_and_forbid_replay",
            at: "2026-08-06T01:01:00.000Z",
          },
        }
      : {}),
  };
}

function historyPageItems(status, cursor) {
  if (cursor) return [historyItem(status, "older")];
  return Array.from({ length: 20 }, (_, index) =>
    historyItem(status, index === 0 ? status : `${status}-${index}`),
  );
}

async function historyResponse(url, response) {
  historyRequestCount += 1;
  const status = url.searchParams.get("status") || "completed";
  const cursor = url.searchParams.get("cursor");
  const roleId = url.searchParams.get("roleId");
  await new Promise((resolve) =>
    setTimeout(resolve, status === "rejected" ? historyDelayMs * 2 : historyDelayMs),
  );
  if (cursor && appendFailuresRemaining > 0) {
    if (cursor) appendFailuresRemaining -= 1;
    json(response, 503, { error: "fixture failure" });
    return;
  }
  json(response, 200, {
    available: roleId !== "unavailable-reader",
    queueRevision,
    filters: {
      ...(status ? { status } : {}),
      ...(url.searchParams.get("kind")
        ? { kind: url.searchParams.get("kind") }
        : {}),
      ...(url.searchParams.get("roleId")
        ? { roleId: url.searchParams.get("roleId") }
        : {}),
    },
    limit: 20,
    roleIdFacets: ["former-reviewer", "pr-reviewer", "unavailable-reader"],
    items: roleId === "unavailable-reader" ? [] : historyPageItems(status, cursor),
    nextCursor: cursor ? null : "abcdefghijklmnop",
  });
}

const confirmationFixtures = Object.freeze({
  active: Object.freeze({
    kind: "github.pull-request-review",
    title: "Fixture confirmation",
    actionLabel: "Approve fixture",
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "APPROVE",
      body: "Fixture review",
    }),
  }),
  comment: Object.freeze({
    kind: "github.pull-request-comment",
    title: "Fixture PR 评论",
    actionLabel: "确认并发布评论",
    action: Object.freeze({
      type: "pull_request_comment",
      body: "Fixture PR comment",
    }),
  }),
  review: Object.freeze({
    kind: "github.work-proposal-review",
    title: "Fixture PR Review",
    actionLabel: "确认并发布 Review",
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "REQUEST_CHANGES",
      body: "Fixture review request",
    }),
  }),
  update: Object.freeze({
    kind: "github.pull-request-update-branch",
    title: "Fixture 更新 PR 分支",
    actionLabel: "确认并更新分支",
    action: Object.freeze({
      type: "pull_request_update_branch",
      expectedHeadOid: "c".repeat(40),
      expectedBaseOid: "d".repeat(40),
    }),
  }),
  push: Object.freeze({
    kind: "github.pull-request-push",
    title: "Fixture 推送受控 commit",
    actionLabel: "确认并推送 commit",
    action: Object.freeze({
      type: "pull_request_push",
      expectedOldOid: "e".repeat(40),
      remote: Object.freeze({ repository: "fixture/head", refName: "feature" }),
      controlledCommitEvidence: Object.freeze({
        commit: Object.freeze({ oid: "f".repeat(40) }),
      }),
    }),
  }),
  merge: Object.freeze({
    kind: "github.pull-request-merge",
    title: "Fixture 合并 PR",
    actionLabel: "确认并合并 PR",
    action: Object.freeze({
      type: "pull_request_merge",
      method: "squash",
      expectedHeadOid: "1".repeat(40),
    }),
  }),
  code: Object.freeze({
    kind: "local.code-job-create",
    title: "Fixture 本地只读代码任务",
    actionLabel: "确认并创建本地代码任务（不会立即执行）",
    action: Object.freeze({
      type: "create_code_job",
      grant: Object.freeze({
        repository: "fixture/repo",
        workspaceId: "fixture-workspace",
        operation: "inspect",
        objective: "检查代码并输出依据",
        acceptanceCriteria: ["给出可追溯的检查结果"],
        writablePaths: [],
        allowedActions: ["read_text", "complete"],
        requiredProfiles: [],
      }),
    }),
  }),
  unknown: Object.freeze({
    kind: "github.work-proposal-review",
    title: "Fixture 结果未知 Review",
    actionLabel: "不得显示发布按钮",
    resolutionRequired: true,
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "COMMENT",
      body: "Fixture uncertain review",
    }),
  }),
  failed: Object.freeze({
    kind: "github.work-proposal-review",
    title: "Fixture failed Review",
    actionLabel: "Publish failing fixture",
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "COMMENT",
      body: "Fixture failed review",
    }),
  }),
});

function confirmationItem() {
  const fixture = confirmationFixtures[confirmationFixtureName];
  return {
    id: `confirmation-${confirmationFixtureName}`,
    kind: fixture.kind,
    queueRevision: 7,
    itemRevision: 3,
    displayedPayloadDigest: "a".repeat(64),
    approvalBindingDigest: "b".repeat(64),
    retryable: false,
    ...(fixture.resolutionRequired
      ? {
          resolutionRequired: true,
          failure: {
            code: "GITHUB_MARKER_ABSENT",
            outcome: "unknown",
            retryable: false,
            at: "2026-08-06T01:02:00.000Z",
          },
        }
      : {}),
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-active" },
    display: {
      title: fixture.title,
      summary: "Approve this fixture action",
      actionLabel: fixture.actionLabel,
      payload: {
        actor: { accountId: "fixture" },
        target: { resourceId: "fixture/pr#42", version: "abcdef" },
        action: structuredClone(fixture.action),
      },
    },
  };
}

function attentionFixture() {
  if (internalAttentionEnabled) {
    return {
      available: true,
      source: "internal_request",
      pendingCount: 1,
      externalEnabled: true,
      externalQueueRevision: queueRevision,
      item: {
        requestId: `attention-${"a".repeat(64)}`,
        revision: 1,
        contentDigest: "b".repeat(64),
        producer: { roleId: "orchestrator", workItemId: "work-local" },
        question: "Who should own this work?",
        context: [],
        choices: [],
      },
    };
  }
  if (confirmationEnabled) {
    return {
      available: true,
      source: "external_confirmation",
      pendingCount: 1,
      externalEnabled: true,
      externalQueueRevision: queueRevision,
      item: confirmationItem(),
    };
  }
  return {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled: true,
    externalQueueRevision: queueRevision,
    item: null,
  };
}

function safeStaticPath(pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(publicDirectory, relative);
  if (
    resolved !== path.join(publicDirectory, "index.html") &&
    !resolved.startsWith(`${publicDirectory}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

function contentType(file) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[path.extname(file)] || "application/octet-stream";
}

function createFixtureServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/api/dashboard") {
        if (dashboardFailuresRemaining > 0) {
          dashboardFailuresRemaining -= 1;
          json(response, 503, { error: "fixture dashboard failure" });
          return;
        }
        json(response, 200, dashboardFixture());
        return;
      }
      if (url.pathname === "/api/refresh") {
        json(response, 200, dashboardFixture());
        return;
      }
      if (url.pathname === "/fixture/enable-confirmation") {
        const requestedFixture = url.searchParams.get("fixture") || "active";
        if (!Object.hasOwn(confirmationFixtures, requestedFixture)) {
          json(response, 400, { error: "unknown fixture" });
          return;
        }
        confirmationFixtureName = requestedFixture;
        if (!confirmationEnabled) {
          confirmationEnabled = true;
        }
        queueRevision += 1;
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/fixture/enable-internal") {
        internalAttentionEnabled = true;
        queueRevision += 1;
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/fixture/deferred-restore-race") {
        deferredRestoreRace = { requests: 0, releaseOlder: null };
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/fixture/deferred-restore-issued-race") {
        deferredRestoreRace = {
          mode: "newer-in-flight-fails",
          requests: 0,
          olderSeen: deferred(),
          newerSeen: deferred(),
          releaseOlder: deferred(),
          releaseNewer: deferred(),
        };
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/fixture/fail-next-attention") {
        attentionFailuresRemaining = 1;
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/attention/next") {
        if (attentionFailuresRemaining > 0) {
          attentionFailuresRemaining -= 1;
          json(response, 503, { error: "fixture attention failure" });
          return;
        }
        if (queueLoadRace !== null) {
          const race = queueLoadRace;
          race.requests += 1;
          if (race.requests === 1) {
            const olderSnapshot = attentionFixture();
            race.olderSeen.resolve();
            await race.releaseOlder.promise;
            if (race.olderStatus === 200) {
              json(response, 200, olderSnapshot);
            } else {
              json(response, 503, { error: "older refresh failed" });
            }
            return;
          }
          if (race.requests === 2) {
            race.newerSeen.resolve();
            await race.releaseNewer.promise;
            queueLoadRace = null;
            json(response, 200, attentionFixture());
            return;
          }
        }
        if (deferredRestoreRace !== null) {
          const race = deferredRestoreRace;
          race.requests += 1;
          if (race.mode === "newer-in-flight-fails") {
            if (race.requests === 1) {
              const olderSnapshot = attentionFixture();
              race.olderSeen.resolve();
              await race.releaseOlder.promise;
              json(response, 200, olderSnapshot);
              return;
            }
            race.newerSeen.resolve();
            await race.releaseNewer.promise;
            deferredRestoreRace = null;
            json(response, 503, { error: "newer refresh failed" });
            return;
          }
          if (race.requests === 1) {
            await new Promise((resolve) => {
              race.releaseOlder = resolve;
            });
            json(response, 503, { error: "older restore failed" });
            return;
          }
          deferredRestoreRace = null;
          json(response, 200, attentionFixture());
          setTimeout(() => race.releaseOlder(), 300);
          return;
        }
        json(response, 200, attentionFixture());
        return;
      }
      if (
        request.method === "POST" &&
        /^\/api\/attention\/internal\/attention-[a-f0-9]{64}\/(answer|reject)$/.test(url.pathname)
      ) {
        let body = "";
        for await (const chunk of request) body += chunk;
        internalSubmissions.push({ path: url.pathname, body: JSON.parse(body) });
        internalAttentionEnabled = false;
        attentionFailuresRemaining = 1;
        queueRevision += 1;
        json(response, 200, { accepted: true });
        return;
      }
      if (
        request.method === "POST" &&
        /^\/api\/confirmations\/confirmation-[a-z]+\/(approve|retry|reject)$/.test(
          url.pathname,
        )
      ) {
        let body = "";
        for await (const chunk of request) body += chunk;
        confirmationSubmissions.push({
          path: url.pathname,
          body: JSON.parse(body),
        });
        if (externalFactRefreshRemaining > 0) {
          externalFactRefreshRemaining -= 1;
          json(response, 503, {
            code: "CONFIRMATION_FACTS_NOT_READY",
            error: "fixture facts refreshing",
          });
          return;
        }
        if (externalConflictRemaining > 0) {
          externalConflictRemaining -= 1;
          dashboardFailuresRemaining = 1;
          json(response, 409, { error: "fixture stale confirmation" });
          return;
        }
        confirmationEnabled = false;
        historyMutation += 1;
        queueRevision += 1;
        if (confirmationFixtureName === "unknown") {
          await new Promise((resolve) =>
            setTimeout(resolve, unknownConfirmationDelayMs),
          );
        }
        json(response, 200, {
          item: confirmationFixtureName === "failed"
            ? {
                status: "failed",
                failure: {
                  code: "GITHUB_SELF_REVIEW_UNSUPPORTED",
                  outcome: "absent",
                  retryable: true,
                },
              }
            : {
                status: url.pathname.endsWith("/reject")
                  ? "rejected"
                  : "completed",
              },
        });
        return;
      }
      if (url.pathname === "/api/employees") {
        json(response, 200, { items: [] });
        return;
      }
      if (url.pathname === "/api/confirmations/history") {
        await historyResponse(url, response);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "fixture route unavailable" });
        return;
      }
      const file = safeStaticPath(url.pathname);
      if (!file) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": contentType(file) });
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
}

async function launchBrowser() {
  return chromium.launch(validationBrowserLaunchOptions({ headless: true }));
}

async function submitHistoryFilter(page, filters) {
  for (const [name, value] of Object.entries(filters)) {
    await page.selectOption(`#confirmation-history-${name}`, value);
  }
  await page.locator("#confirmation-history-apply").focus();
  await page.locator("#confirmation-history-filter").evaluate((form) => {
    form.requestSubmit(document.querySelector("#confirmation-history-apply"));
  });
}

async function stableIdentity(page, handle, selector) {
  return page.evaluate(
    ([node, expectedSelector]) => node === document.querySelector(expectedSelector),
    [handle, selector],
  );
}

const server = createFixtureServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "networkidle",
  });
  await page.locator('[data-view="employees"]').click();
  await page.locator(".confirmation-history-item").first().waitFor();

  const initialHistoryRequestCount = historyRequestCount;
  const unchangedQueueRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/attention/next",
  );
  await page.locator("#refresh-button").dispatchEvent("click");
  await unchangedQueueRead;
  await page.waitForTimeout(historyDelayMs + 50);
  assert.equal(historyRequestCount, initialHistoryRequestCount);

  assert.equal(
    await page.locator('#confirmation-history-role option[value="former-reviewer"]').count(),
    1,
  );
  let form = await page.locator("#confirmation-history-filter").elementHandle();
  let liveRegion = await page.locator("#confirmation-history-results").elementHandle();
  let loadMore = await page.locator("#confirmation-history-load-more").elementHandle();

  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /History completed <img data-history-xss src=x onerror=alert\(1\)>/,
  );
  assert.equal(await page.locator(".confirmation-history-item img").count(), 0);

  await submitHistoryFilter(page, { status: "rejected" });
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");
  await page.locator("#refresh-button").dispatchEvent("click");
  await page.getByText("History rejected", { exact: true }).waitFor();
  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /已承认结果未知并封存（禁止重放）/u,
  );
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");

  await submitHistoryFilter(page, { status: "rejected" });
  await submitHistoryFilter(page, { status: "stale" });
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");
  await page.getByText("History stale", { exact: true }).waitFor();
  assert.equal(await page.getByText("History rejected", { exact: true }).count(), 0);
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");

  await submitHistoryFilter(page, { status: "failed" });
  await page.getByText("History failed", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".confirmation-history-item .status-pill").first().textContent(),
    "执行失败",
  );
  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /可再次逐项确认/,
  );
  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /诊断：GITHUB_LOGIN_UNAVAILABLE/,
  );

  await submitHistoryFilter(page, { role: "unavailable-reader" });
  await page.getByText("确认历史读取能力未启用。", { exact: true }).waitFor();

  await submitHistoryFilter(page, { status: "", role: "" });
  await page.locator(".confirmation-history-item strong").first().waitFor();
  await page.locator("#confirmation-history-load-more").focus();
  await page.locator("#confirmation-history-load-more").click();
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");
  await page.locator("#confirmation-history-error:not([hidden])").waitFor();
  assert.equal(await stableIdentity(page, loadMore, "#confirmation-history-load-more"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");

  await page.locator("#confirmation-history-load-more").click();
  await page.getByText("History older", { exact: true }).waitFor();
  assert.equal(await stableIdentity(page, loadMore, "#confirmation-history-load-more"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");
  assert.equal(await page.locator("#confirmation-history-load-more").getAttribute("aria-disabled"), "true");

  for (const fixture of [
    ["comment", /PR 评论.*将发布的完整正文/s, "确认并发布评论"],
    ["review", /PR Review.*Review 类型.*将发布的完整正文/s, "确认发布并分配下一步"],
    ["update", /更新 PR 分支.*预期 Head.*预期 Base/s, "确认并更新分支"],
    ["push", /推送受控 commit.*目标分支.*受控 commit/s, "确认并推送 commit"],
    ["merge", /合并 PR.*合并方式.*预期 Head/s, "确认并合并 PR"],
  ]) {
    await page.evaluate(
      (name) => fetch(`/fixture/enable-confirmation?fixture=${name}`, { method: "POST" }),
      fixture[0],
    );
    await page.locator("#refresh-button").click();
    await page.locator("#confirmation-dialog[open]").waitFor();
    assert.match(await page.locator("#confirmation-dialog").textContent(), fixture[1]);
    const targetLink = page.getByRole("link", {
      name: "fixture/pr#42 · 在 GitHub 中打开 ↗",
      exact: true,
    });
    assert.equal(
      await targetLink.getAttribute("href"),
      "https://github.com/fixture/pr/pull/42",
    );
    assert.equal(await targetLink.getAttribute("target"), "_blank");
    assert.equal(await targetLink.getAttribute("rel"), "noreferrer");
    await page.getByRole("button", { name: fixture[2] }).waitFor();
    await page.getByRole("button", { name: "稍后再看" }).click();
    await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
    if (fixture[0] === "comment") {
      const restore = page.locator("#confirmation-deferred-restore");
      await restore.waitFor();
      assert.match(await restore.textContent(), /重新查看稍后项（1）/);
      const deferredKey = `external\u0000confirmation-comment\u0000${"b".repeat(64)}`;
      assert.equal(
        await page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          deferredConfirmationStorageKey,
        ),
        JSON.stringify([deferredKey]),
      );

      await page.reload({ waitUntil: "networkidle" });
      await page.locator('[data-view="employees"]').click();
      await page.locator(".confirmation-history-item").first().waitFor();
      form = await page.locator("#confirmation-history-filter").elementHandle();
      liveRegion = await page.locator("#confirmation-history-results").elementHandle();
      loadMore = await page.locator("#confirmation-history-load-more").elementHandle();
      await page.locator("#confirmation-deferred-restore").waitFor();
      assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);
      assert.match(
        await page.locator("#confirmation-deferred-restore").textContent(),
        /重新查看稍后项（1）/,
      );

      await page.evaluate(() =>
        fetch("/fixture/fail-next-attention", { method: "POST" })
      );
      await page.locator("#confirmation-deferred-restore").click();
      await page.getByText(/稍后项仍保留，可再次尝试/u).waitFor();
      assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);
      assert.equal(
        await page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          deferredConfirmationStorageKey,
        ),
        JSON.stringify([deferredKey]),
      );

      await page.locator("#confirmation-deferred-restore").click();
      await page.locator("#confirmation-dialog[open]").waitFor();
      assert.equal(
        await page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          deferredConfirmationStorageKey,
        ),
        null,
      );
      assert.equal(historyMutation, 0);
      assert.match(
        await page.locator("#confirmation-dialog").textContent(),
        /Fixture PR 评论.*Fixture PR comment/s,
      );
      await page.getByRole("button", { name: "稍后再看" }).click();
      await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });

      await page.evaluate(() =>
        fetch("/fixture/deferred-restore-race", { method: "POST" })
      );
      await page.locator("#confirmation-deferred-restore").click();
      const newerQueueResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/attention/next" && response.status() === 200;
      });
      await page.locator("#refresh-button").dispatchEvent("click");
      await newerQueueResponse;
      assert.equal(
        await page.locator("#confirmation-deferred-restore").isDisabled(),
        true,
      );
      await page.locator("#confirmation-dialog[open]").waitFor();
      await page.waitForTimeout(350);
      assert.equal(
        await page.locator("#confirmation-deferred-restore").count(),
        0,
      );
      assert.doesNotMatch(
        await page.locator("#status-banner").textContent(),
        /稍后项仍保留/u,
      );
      await page.getByRole("button", { name: "稍后再看" }).click();
      await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });

      await page.evaluate(() =>
        fetch("/fixture/deferred-restore-issued-race", { method: "POST" })
      );
      const issuedRace = deferredRestoreRace;
      await page.locator("#confirmation-deferred-restore").click();
      await issuedRace.olderSeen.promise;
      await page.locator("#refresh-button").dispatchEvent("click");
      await issuedRace.newerSeen.promise;
      const olderRestored = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/attention/next" &&
        response.status() === 200
      );
      issuedRace.releaseOlder.resolve();
      await olderRestored;
      await page.getByText(/稍后项已保留，请再次点击重新查看/u).waitFor();
      assert.equal(
        await page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          deferredConfirmationStorageKey,
        ),
        JSON.stringify([deferredKey]),
      );
      const newerFailed = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/attention/next" &&
        response.status() === 503
      );
      issuedRace.releaseNewer.resolve();
      await newerFailed;
      await page.locator("#confirmation-deferred-restore").click();
      await page.locator("#confirmation-dialog[open]").waitFor();
      await page.getByRole("button", { name: "稍后再看" }).click();
      await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
    }
  }

  await page.selectOption("#confirmation-history-status", "stale");
  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.locator("#confirmation-history-status").inputValue(), "stale");

  const refreshSubmissionStart = confirmationSubmissions.length;
  externalFactRefreshRemaining = 1;
  await page.getByRole("button", { name: "确认发布并分配下一步" }).click();
  await page.getByText("正在核对最新事实，确认请求将自动重试，请勿重复点击…", {
    exact: true,
  }).waitFor({ timeout: 3_000 });
  assert.equal(await page.locator(".confirmation-actions").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator(".confirmation-close").isDisabled(), true);
  assert.equal(await page.locator("#confirmation-dialog button:enabled").count(), 0);
  assert.equal(historyMutation, 0);
  assert.equal(
    confirmationSubmissions.at(-1).path,
    "/api/confirmations/confirmation-active/approve",
  );
  await page.getByText(/GitHub 已确认发布成功/u).waitFor();
  const refreshSubmissions = confirmationSubmissions.slice(refreshSubmissionStart);
  assert.equal(refreshSubmissions.length, 2);
  assert.deepEqual(refreshSubmissions[1], refreshSubmissions[0]);
  assert.equal(historyMutation, 1);
  await page
    .locator(".confirmation-history-item strong")
    .filter({ hasText: "History mutation 1" })
    .first()
    .waitFor();
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.locator("#confirmation-history-status").inputValue(), "stale");

  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  attentionFailuresRemaining = 1;
  await page.getByRole("button", { name: "确认发布并分配下一步" }).click();
  await page.getByText(/GitHub 已确认发布成功.*读取确认队列失败（503）/u).waitFor();
  assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);

  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=failed", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  await page.getByRole("button", { name: "确认发布并分配下一步" }).click();
  await page.getByText(
    "GitHub 不允许 PR 作者批准或请求修改自己的 PR，本次确认未产生外部写入；新提案将改为 COMMENT Review。",
    { exact: true },
  ).waitFor();
  assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);

  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=unknown", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  assert.match(
    await page.locator("#confirmation-dialog").textContent(),
    /结果未知.*不会自动重试/s,
  );
  assert.equal(
    await page.getByRole("button", { name: /发布|批准|重试/ }).count(),
    0,
  );
  await page.getByRole("button", { name: "承认结果未知并封存" }).click();
  const sealingButton = page.getByRole("button", { name: "正在封存…" });
  await sealingButton.waitFor({ timeout: unknownConfirmationDelayMs });
  assert.equal(await sealingButton.isDisabled(), true);
  assert.equal(
    await page.locator('.confirmation-actions[aria-busy="true"]').count(),
    1,
  );
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  assert.equal(
    confirmationSubmissions.at(-1).path,
    "/api/confirmations/confirmation-unknown/reject",
  );
  assert.equal(
    confirmationSubmissions.at(-1).body.reason,
    "用户确认结果仍未知并封存，禁止重试",
  );

  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  externalConflictRemaining = 1;
  externalFactRefreshRemaining = 1;
  const conflictSubmissionStart = confirmationSubmissions.length;
  const mutationsBeforeConflict = historyMutation;
  await page.getByRole("button", { name: "确认发布并分配下一步" }).click();
  await page.getByText(/确认内容或目标状态已经变化.*其他页面数据会自动重试/u).waitFor();
  await page.locator("#confirmation-dialog[open]").waitFor();
  const conflictSubmissions = confirmationSubmissions.slice(conflictSubmissionStart);
  assert.equal(conflictSubmissions.length, 2);
  assert.deepEqual(conflictSubmissions[1], conflictSubmissions[0]);
  assert.equal(historyMutation, mutationsBeforeConflict);
  await page.getByRole("button", { name: "确认发布并分配下一步" }).click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  assert.notEqual(
    confirmationSubmissions.at(-1).body.requestId,
    conflictSubmissions[0].body.requestId,
  );

  for (const operation of ["answer", "reject"]) {
    await page.evaluate(() => fetch("/fixture/enable-internal", { method: "POST" }));
    await page.locator("#refresh-button").click();
    await page.locator("#confirmation-dialog[open] .internal-attention").waitFor();
    if (operation === "answer") {
      await page.locator("#internal-answer-text").fill("Assign a configured owner");
      await page.getByRole("button", { name: "提交文字答复" }).click();
    } else {
      await page.getByRole("button", { name: "驳回请示" }).click();
    }
    await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
    await page.getByText(/已写入本地台账.*读取确认队列失败（503）/u).waitFor({ timeout: 3_000 });
    assert.ok(internalSubmissions.at(-1).path.endsWith(`/${operation}`));
  }

  await page.evaluate(() => fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" }));
  queueLoadRace = {
    requests: 0,
    olderSeen: deferred(),
    newerSeen: deferred(),
    releaseOlder: deferred(),
    releaseNewer: deferred(),
  };
  const race = queueLoadRace;
  await page.locator("#refresh-button").dispatchEvent("click");
  await race.olderSeen.promise;
  await page.locator("#refresh-button").dispatchEvent("click");
  await race.newerSeen.promise;
  const olderFailure = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/attention/next" && response.status() === 503
  );
  race.releaseOlder.resolve();
  await olderFailure;
  const newerSuccess = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/attention/next" && response.status() === 200
  );
  race.releaseNewer.resolve();
  await newerSuccess;
  await page.locator("#confirmation-dialog[open]").waitFor({ timeout: 3_000 });
  assert.match(await page.locator("#confirmation-dialog").textContent(), /Fixture confirmation/u);

  // A successful older read must not open an obsolete item while a newer read
  // is in flight. Once a dialog opens, later queue reads cannot replace it.
  confirmationEnabled = false;
  internalAttentionEnabled = false;
  const racePage = await browser.newPage();
  racePage.on("pageerror", (error) => pageErrors.push(error.message));
  await racePage.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "networkidle",
  });
  confirmationEnabled = true;
  confirmationFixtureName = "comment";
  queueLoadRace = {
    requests: 0,
    olderStatus: 200,
    olderSeen: deferred(),
    newerSeen: deferred(),
    releaseOlder: deferred(),
    releaseNewer: deferred(),
  };
  const successRace = queueLoadRace;
  await racePage.locator("#refresh-button").dispatchEvent("click");
  await successRace.olderSeen.promise;
  await racePage.evaluate(() => fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" }));
  await racePage.locator("#refresh-button").dispatchEvent("click");
  await successRace.newerSeen.promise;
  const olderSuccess = racePage.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/attention/next" &&
    response.status() === 200
  );
  successRace.releaseOlder.resolve();
  await olderSuccess;
  const currentSuccess = racePage.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/attention/next" &&
    response.status() === 200
  );
  successRace.releaseNewer.resolve();
  await currentSuccess;
  await racePage.locator("#confirmation-dialog[open]").waitFor({ timeout: 3_000 });
  assert.match(
    await racePage.locator("#confirmation-dialog").textContent(),
    /Fixture confirmation/u,
  );
  await racePage.close();

  // Local code authorization shares the same submission path as GitHub
  // actions. A fact refresh must not require another click or create two jobs.
  confirmationEnabled = true;
  confirmationFixtureName = "code";
  const codePage = await browser.newPage();
  codePage.on("pageerror", (error) => pageErrors.push(error.message));
  await codePage.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
  await codePage.locator("#confirmation-dialog[open] .code-job-confirmation").waitFor();
  const codeSubmissionStart = confirmationSubmissions.length;
  const mutationsBeforeCode = historyMutation;
  externalFactRefreshRemaining = 2;
  await codePage.getByRole("button", {
    name: "确认并创建本地代码任务（不会立即执行）",
    exact: true,
  }).click();
  await codePage.getByText("正在核对最新事实，确认请求将自动重试，请勿重复点击…", {
    exact: true,
  }).waitFor();
  await codePage.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  const codeSubmissions = confirmationSubmissions.slice(codeSubmissionStart);
  assert.equal(codeSubmissions.length, 3);
  assert.ok(codeSubmissions.every((entry) => entry.path === "/api/confirmations/confirmation-code/approve"));
  assert.deepEqual(codeSubmissions[1], codeSubmissions[0]);
  assert.deepEqual(codeSubmissions[2], codeSubmissions[0]);
  assert.equal(historyMutation, mutationsBeforeCode + 1);
  await codePage.close();
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("confirmation history Playwright fixture passed");
