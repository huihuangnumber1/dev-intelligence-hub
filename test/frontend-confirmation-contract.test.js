import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createConfirmationDialogOwnership, createExternalConfirmationReconciler,
  createInternalConfirmationReconciler, shouldCloseExternalConfirmation } from "../public/confirmation-dialog-support.js";

test("internal question reconciliation follows the exact archived question without posting an answer", async () => {
  const state = { owner: 1, key: "internal-active", requestSequence: 2, submitting: false,
    item: { requestId: "attention-active", status: "pending" } };
  let result = { requestId: "attention-another", status: "archived" }, closes = 0;
  const reconcile = createInternalConfirmationReconciler({ getCurrent: () => ({ ...state }),
    readItem: async id => { assert.equal(id, state.item.requestId); return result; },
    onResolved: owner => { assert.equal(owner, 1); closes++; return true; } });
  for (result of [null, result, state.item, { ...state.item, status: "unknown" }]) {
    assert.equal(await reconcile(), false);
  }
  for (const status of ["answered", "rejected", "archived"]) {
    result = { ...state.item, status };
    assert.equal(await reconcile(), true);
  }
  assert.equal(closes, 3);
});

for (const change of ["owner", "key", "requestSequence", "submitting", "closed", "readFailure", "newerRead"]) {
  test(`internal question refresh preserves a changed ${change}`, async () => {
    let state = { owner: 1, key: "internal", requestSequence: 2, submitting: false,
      item: { requestId: "attention-active", status: "pending" } };
    const reads = [];
    let closes = 0;
    const reconcile = createInternalConfirmationReconciler({ getCurrent: () => state ? { ...state } : null,
      readItem: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
      onResolved: () => { closes++; return true; } });
    const pending = reconcile();
    if (change === "closed") state = null;
    else if (change === "readFailure") reads[0].reject(new Error("unavailable"));
    else if (change === "newerRead") { const newer = reconcile(); reads[1].resolve(state.item); await newer; }
    else state[change] = change === "submitting" ? true : "changed";
    reads[0].resolve({ requestId: "attention-active", status: "archived" });
    assert.equal(await pending, false);
    assert.equal(closes, 0);
  });
}

test("exact confirmation refresh closes settled or system-managed Reviews while preserving failures", () => {
  const item = { id: "review-1", approvalBindingDigest: "a".repeat(64), status: "pending",
    kind: "github.work-proposal-review", display: { payload: { action: { type: "pull_request_review" } } } };
  for (const status of ["completed", "stale", "rejected", "executing"]) {
    assert.equal(shouldCloseExternalConfirmation(item, { ...item, status }), true);
  }
  assert.equal(shouldCloseExternalConfirmation(item, item), false);
  assert.equal(shouldCloseExternalConfirmation(item, item, true), true);
  assert.equal(shouldCloseExternalConfirmation(item, { ...item, status: "failed", resolutionRequired: true }, true), false);
  assert.equal(shouldCloseExternalConfirmation(item, { ...item, kind: "github.pull-request-comment" }, true), false);
  assert.equal(shouldCloseExternalConfirmation(item, { ...item, id: "another", status: "stale" }), false);
  assert.equal(shouldCloseExternalConfirmation(item, null), false);
});

for (const change of ["owner", "key", "requestSequence", "submitting", "closed"]) {
  test(`a late confirmation read cannot close a changed ${change}`, async () => {
    let release;
    let current = { owner: 1, key: "external-1", requestSequence: 1, submitting: false,
      item: { id: "review-1", status: "pending" } };
    let closes = 0;
    const reconcile = createExternalConfirmationReconciler({
      getCurrent: () => current ? { ...current } : null,
      readItem: id => { assert.equal(id, "review-1"); return new Promise(resolve => { release = resolve; }); },
      onResolved: () => { closes += 1; return true; },
    });
    const pending = reconcile();
    if (change === "closed") current = null;
    else current[change] = change === "submitting" ? true : "changed";
    release({ id: "review-1", status: "stale" });
    assert.equal(await pending, false);
    assert.equal(closes, 0);
  });
}

test("confirmation reconciliation uses the active id and leaves pending items open despite another next item", async () => {
  const state = { owner: 1, key: "active", requestSequence: 2, submitting: false,
    nextItemId: "another", item: { id: "review-1", status: "pending" } };
  let refreshed = state.item;
  let closedOwner = null;
  const reconcile = createExternalConfirmationReconciler({ getCurrent: () => ({ ...state }),
    readItem: async id => { assert.equal(id, state.item.id); return refreshed; },
    onResolved: owner => { closedOwner = owner; return true; },
  });
  assert.equal(await reconcile(), false);
  refreshed = { ...state.item, status: "stale" };
  assert.equal(await reconcile(), true);
  assert.equal(closedOwner, 1);
});

test("failed and out-of-order confirmation reads never dismiss the current decision", async () => {
  const state = { owner: 1, key: "active", requestSequence: 1, submitting: false,
    item: { id: "review-1", status: "pending" } };
  const releases = [];
  let closes = 0;
  const reconcile = createExternalConfirmationReconciler({ getCurrent: () => ({ ...state }),
    readItem: () => new Promise((resolve, reject) => releases.push({ resolve, reject })),
    onResolved: () => { closes += 1; },
  });
  const older = reconcile(), newer = reconcile();
  releases[1].resolve(state.item);
  assert.equal(await newer, false);
  releases[0].resolve({ ...state.item, status: "stale" });
  assert.equal(await older, false);
  const failed = reconcile();
  releases[2].reject(new Error("unavailable"));
  assert.equal(await failed, false);
  assert.equal(closes, 0);
});

const root = path.resolve(import.meta.dirname, "..");

test("the dashboard keeps one confirmation dialog for local and external decisions", async () => {
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /kind: "external_action"/);
  assert.match(app, /kind: "internal_request"/);
  assert.match(app, /kind: "responsibility"/);
  assert.match(app, /kind: "review_draft"/);
  assert.equal(app.includes("showReviewDraftConfirmation"), true);
  assert.equal(app.includes("/api/pr-review-jobs/decide"), true);
  assert.match(
    app,
    /const legacyReviewDrafts = confirmationQueueState\.externalEnabled\s*\? \[\]/,
  );
});

test("dashboard loading remains available when the confirmation queue is degraded", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function load({ showConfirmation");
  const end = app.indexOf("\nasync function refresh()", start);
  const loader = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(loader, /Promise\.allSettled\(\[/);
  assert.match(loader, /dashboardResult\.status === "rejected"/);
  assert.match(loader, /confirmationResult\.status === "fulfilled"/);
  assert.match(loader, /applyDashboard\(dashboardResult\.value, sequence\)/);
  assert.match(loader, /confirmationResult\.reason\.message/);
  assert.ok(
    loader.indexOf("applyDashboard(dashboardResult.value, sequence)") <
      loader.lastIndexOf("confirmationResult.reason.message"),
  );
  assert.doesNotMatch(
    loader,
    /const \[nextDashboard, nextConfirmationQueue\] = await Promise\.all\(/,
  );
});

test("the employee view separates the next pending decision from read-only history", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function confirmationCenterView");
  const end = app.indexOf("\nfunction memoryString", start);
  const confirmationCenter = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(confirmationCenter, /id="confirmation-pending-panel"/);
  assert.match(confirmationCenter, /待你逐项确认/);
  assert.match(confirmationCenter, /逐条弹框确认/);
  assert.match(confirmationCenter, /id="confirmation-history-panel"/);
  assert.match(confirmationCenter, /只读确认历史/);
  assert.match(confirmationCenter, /id="confirmation-history-filter"/);
  assert.match(confirmationCenter, /id="confirmation-history-apply"/);
  assert.match(confirmationCenter, /id="confirmation-history-error"/);
  assert.match(confirmationCenter, /id="confirmation-history-results"/);
  assert.match(confirmationCenter, /id="confirmation-history-pagination"/);
  assert.match(confirmationCenter, /<select[^>]+name="status"/);
  assert.match(confirmationCenter, /<select[^>]+name="kind"/);
  assert.match(confirmationCenter, /<select[^>]+name="roleId"/);
  assert.doesNotMatch(confirmationCenter, /type="checkbox"/);
  assert.doesNotMatch(confirmationCenter, /批量/);
  assert.doesNotMatch(confirmationCenter, /data-external-operation/);
  assert.doesNotMatch(confirmationCenter, /data-confirmation-id/);
});

test("confirmation history uses only the paged GET reader and never an approval endpoint", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function loadConfirmationHistory");
  const end = app.indexOf("\nasync function loadMemories", start);
  const loader = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(loader, /new URLSearchParams/);
  assert.match(loader, /\/api\/confirmations\/history/);
  assert.match(loader, /method: "GET"/);
  assert.match(loader, /confirmationHistoryNextCursor/);
  assert.match(
    loader,
    /const cursor = append \? confirmationHistoryNextCursor : null/,
  );
  assert.match(loader, /if \(append && !cursor\) return false/);
  assert.match(loader, /confirmationHistoryAbortController\?\.abort\(\)/);
  assert.match(loader, /sequence !== confirmationHistoryRequestSequence/);
  assert.match(loader, /sequence < lastAppliedConfirmationHistoryRequest/);
  assert.match(
    loader,
    /if \(!append && filtersChanged\) \{[\s\S]*confirmationHistoryItems = \[\];[\s\S]*confirmationHistoryNextCursor = null;[\s\S]*confirmationHistoryLoaded = false;/,
  );
  const failure = loader.slice(loader.indexOf("  } catch (error)"));
  assert.doesNotMatch(failure, /confirmationHistoryItems = \[\]/);
  assert.doesNotMatch(failure, /confirmationHistoryNextCursor = null/);
  assert.doesNotMatch(loader, /\brender\(\)/);
  assert.match(loader, /updateConfirmationHistoryView/);
  assert.doesNotMatch(loader, /\/approve|\/retry|\/reject/);
});

test("confirmation history keeps stable controls and a stable live region for local updates", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function updateConfirmationHistoryView");
  const end = app.indexOf("\nasync function loadConfirmationHistory", start);
  const updater = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(updater, /#confirmation-history-filter/);
  assert.match(updater, /#confirmation-history-results/);
  assert.match(updater, /#confirmation-history-load-more/);
  assert.match(updater, /replaceChildren|\.innerHTML/);
  assert.doesNotMatch(updater, /content\.innerHTML|\brender\(\)/);
});

test("confirmation center layout stays bounded on tablet and mobile widths", async () => {
  const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");
  const baseStart = styles.indexOf(".confirmation-center-grid");
  const tabletStart = styles.indexOf("@media (max-width: 820px)");
  const mobileStart = styles.indexOf("@media (max-width: 540px)");
  const base = styles.slice(baseStart, tabletStart);
  const tablet = styles.slice(tabletStart, mobileStart);
  const mobile = styles.slice(mobileStart);

  assert.ok(baseStart >= 0 && tabletStart > baseStart && mobileStart > tabletStart);
  assert.match(base, /\.confirmation-center-panel \{[\s\S]*min-width: 0/);
  assert.match(
    base,
    /\.confirmation-history-filter \{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    base,
    /\.confirmation-history-filter select \{[\s\S]*width: 100%;[\s\S]*min-width: 0/,
  );
  assert.match(
    tablet,
    /\.confirmation-center-grid \{\s*grid-template-columns: 1fr;/,
  );
  assert.match(
    mobile,
    /\.confirmation-history-filter \{\s*grid-template-columns: 1fr;/,
  );
});

test("external confirmation renders the exact authorization context", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");

  for (const visibleLabel of [
    "执行账号",
    "目标",
    "绑定 Head",
    "Review 类型",
    "将发布的完整正文",
    "依据",
    "确认并发布到 GitHub",
    "发布后由谁推进",
    "发布后立即交接",
    "下一责任岗位",
    "测试工程师 · 验证后交回合并门禁",
    "开发工程师 · 自己修复、测试并推送新 Head",
    "确认发布并分配下一步",
    "版本类型",
    "具体测试负责人",
    "候选账号来自配置中心",
  ]) {
    assert.equal(app.includes(visibleLabel), true, visibleLabel);
  }
  assert.doesNotMatch(app, /submitReviewHandoff/);
  assert.match(app, /reviewHandoff: item\.reviewHandoff\?\.selection/);
  assert.match(app, /关闭页面不影响推进/);
  assert.match(app, /data-review-testing-person/);
  assert.match(app, /handoffResponsiblePerson/);
  assert.match(app, /bindManualWorkAssignment/);
  const assignment = await readFile(path.join(root, "public", "manual-work-assignment.js"), "utf8");
  assert.match(assignment, /\/api\/work\/requests/);
  assert.match(app, /confirmationResult\?\.item\?\.status === "completed"/);
  assert.match(
    app,
    /external\\u0000\$\{confirmationQueueState\.item\.id\}\\u0000\$\{confirmationQueueState\.item\.approvalBindingDigest\}/,
  );
  assert.match(app, /githubTargetUrl/);
  assert.match(app, /target="_blank"/);
  assert.match(app, /rel="noreferrer"/);
  assert.match(app, /在 GitHub 中打开/);
  assert.match(
    styles,
    /\.confirmation-target-link:focus-visible \{[\s\S]*outline: 2px solid var\(--green\);[\s\S]*outline-offset: 2px;/,
  );
});

test("employee consultations link a GitHub source event to its original page", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function internalContextMarkup");
  const end = app.indexOf("\nfunction showInternalAttention", start);
  const renderer = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /githubSourceEventUrl/);
  assert.match(renderer, /label === "来源事件"/);
  assert.match(renderer, /target="_blank"/);
  assert.match(renderer, /rel="noreferrer"/);
  assert.match(renderer, /打开 GitHub/);
});

test("all five PR action kinds have exact browser approval routes and details", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const routerStart = app.indexOf("function showExternalActionConfirmation");
  const routerEnd = app.indexOf("\nfunction showInternalAttention", routerStart);
  const router = app.slice(routerStart, routerEnd);
  const rendererStart = app.indexOf("function pullRequestConfirmationActionType");
  const rendererEnd = app.indexOf("\nfunction codeOperationLabel", rendererStart);
  const renderer = app.slice(rendererStart, rendererEnd);

  assert.ok(routerStart >= 0 && routerEnd > routerStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
  for (const [kind, actionType, label] of [
    ["github.pull-request-comment", "pull_request_comment", "PR 评论"],
    ["github.work-proposal-review", "pull_request_review", "PR Review"],
    ["github.pull-request-update-branch", "pull_request_update_branch", "更新 PR 分支"],
    ["github.pull-request-push", "pull_request_push", "推送受控 commit"],
    ["github.pull-request-merge", "pull_request_merge", "合并 PR"],
  ]) {
    assert.equal(app.includes(kind), true, kind);
    assert.equal(app.includes(actionType), true, actionType);
    assert.equal(renderer.includes(label), true, label);
  }
  assert.match(router, /pullRequestConfirmationActionType/);
  assert.match(renderer, /action\.type !== expectedActionType/);
  for (const visibleLabel of [
    "动作",
    "预期 Base",
    "目标分支",
    "受控 commit",
    "合并方式",
  ]) {
    assert.equal(renderer.includes(visibleLabel), true, visibleLabel);
  }
  assert.match(renderer, /data-external-operation="\$\{operation\}"/);
  assert.match(renderer, /data-external-operation="reject"/);
  assert.match(renderer, /data-external-operation="later"/);
});

test("code authorization uses local-only wording and an exact kind branch", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  assert.match(app, /item\?\.kind === "local\.code-job-create"/);
  for (const visibleLabel of [
    "请求岗位",
    "可信工作区",
    "PR 输入",
    "精确 Head",
    "代码操作",
    "任务目标",
    "验收条件",
    "可写相对路径",
    "允许的受控动作",
    "必须运行的固定测试",
    "批准创建本地代码任务",
    "本次点击不会调用模型、修改源目录、提交或推送 GitHub",
  ]) {
    assert.equal(app.includes(visibleLabel), true, visibleLabel);
  }
  const start = app.indexOf("function showCodeJobConfirmation");
  const end = app.indexOf("\nfunction showChangePackageApplicationConfirmation", start);
  const renderer = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /grant\.inputBinding/);
  assert.match(renderer, /pullRequestTargetMarkup/);
  assert.match(renderer, /inputBinding\.repository/);
  assert.match(renderer, /inputBinding\.pullRequestNumber/);
  assert.match(renderer, /inputBinding\.headRefOid/);
});

test("change package application uses an exact immutable confirmation branch", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  assert.match(app, /item\?\.kind === "local\.change-package-apply"/);
  for (const visibleLabel of [
    "应用已验证的本地变更包",
    "目标工作区",
    "预期 Head",
    "变更包摘要",
    "变更集合摘要",
    "测试证据摘要",
    "确认并应用变更包",
  ]) {
    assert.equal(app.includes(visibleLabel), true, visibleLabel);
  }
  const start = app.indexOf("function showChangePackageApplicationConfirmation");
  const end = app.indexOf("\nfunction showUnsupportedExternalConfirmation", start);
  const renderer = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(renderer, /sourceRoot|writablePaths|data-external-operation="execute"/);
});

test("a package application closes detail before refreshing and showing the unified queue", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async onApplyRequested()");
  const end = app.indexOf("\n  },", start);
  const callback = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.ok(callback.indexOf("dialog.close()") < callback.indexOf("refreshConfirmationQueue"));
  assert.ok(callback.indexOf("refreshConfirmationQueue") < callback.indexOf("queueMicrotask(showNextConfirmation)"));
  assert.doesNotMatch(callback, /confirmationDialog\.showModal/);
});

test("unknown confirmation kinds have no approve or reject control", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function showUnsupportedExternalConfirmation");
  const end = app.indexOf("\nfunction showUnknownResultResolution", start);
  const renderer = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /data-external-operation="later"/);
  assert.equal(renderer.includes('data-external-operation="approve"'), false);
  assert.equal(renderer.includes('data-external-operation="retry"'), false);
  assert.equal(renderer.includes('data-external-operation="reject"'), false);
});

test("unknown external results expose sealing but never approval or replay", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function showUnknownResultResolution");
  const end = app.indexOf("\nfunction showExternalActionConfirmation", start);
  const renderer = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /不会自动重试/);
  assert.match(renderer, /承认结果未知并封存/);
  assert.match(renderer, /data-external-operation="reject"/);
  assert.match(renderer, /data-external-operation="later"/);
  assert.equal(renderer.includes('data-external-operation="approve"'), false);
  assert.equal(renderer.includes('data-external-operation="retry"'), false);
});

test("browser mutations send binding metadata and never submit an action payload", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const end = app.indexOf("\nfunction updateChrome", start);
  const handler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /requestId: crypto\.randomUUID\(\)/);
  assert.match(handler, /expectedQueueRevision: item\.queueRevision/);
  assert.match(handler, /expectedItemRevision: item\.itemRevision/);
  assert.match(handler, /displayedPayloadDigest: item\.displayedPayloadDigest/);
  assert.match(handler, /approvalBindingDigest: item\.approvalBindingDigest/);
  assert.equal(handler.includes("action: item"), false);
  assert.equal(handler.includes("body: action"), false);
});

test("GitHub confirmation results are reported before another dialog can replace them", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function externalConfirmationOutcomeMessage");
  const end = app.indexOf("\nasync function handleReviewDraftDecision", start);
  const handler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /GitHub 已确认发布成功/);
  assert.match(handler, /已确认没有产生外部写入/);
  assert.match(handler, /新提案将改为 COMMENT Review/);
  assert.match(handler, /未能确认发布结果，已禁止自动重试/);
  assert.match(handler, /if \(outcomeMessage\)/);
  assert.match(handler, /else \{\s*queueMicrotask\(showNextConfirmation\)/s);
});

test("later closes the popup without entering the mutation branch", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const fetchStart = app.indexOf("const response = await postAttentionDuringFactRefresh", start);
  const laterBranch = app.slice(start, fetchStart);

  assert.match(laterBranch, /if \(operation === "later"\)/);
  assert.match(laterBranch, /closeConfirmationDialog\(\)/);
  assert.match(laterBranch, /await refreshAfterDeferral\(\)/);
  assert.match(laterBranch, /return;/);
  assert.equal(laterBranch.includes("fetch("), false);
});

test("a conflict hides the stale snapshot until a fresh queue read succeeds", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const end = app.indexOf("\nasync function handleReviewDraftDecision", start);
  const handler = app.slice(start, end);
  const conflict = handler.slice(
    handler.indexOf("if (response.status === 409)"),
    handler.indexOf("if (!response.ok)"),
  );

  assert.match(conflict, /invalidateConfirmationQueueSnapshot\(\)/);
  assert.match(conflict, /await refreshConfirmationQueue/);
  assert.ok(
    conflict.indexOf("invalidateConfirmationQueueSnapshot()") <
      conflict.indexOf("await refreshConfirmationQueue"),
  );
  assert.match(conflict, /成功读取最新确认内容前不会再次弹出/);
});

test("external confirmation completion only cleans up its own modal", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("async function handleExternalConfirmation");
  const end = app.indexOf("\nasync function handleReviewDraftDecision", start);
  const handler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(
    handler,
    /const submissionOwner = beginExternalConfirmationSubmission\(button, operation\)/,
  );
  assert.match(handler, /closeExternalConfirmation\(submissionOwner\)/);
  assert.match(handler, /restoreExternalConfirmation\(submissionOwner\)/);
  assert.match(
    app,
    /beginConfirmationSubmission\(setConfirmationButtonsDisabled\)/,
  );
  assert.match(app, /confirmationCloseButton\.disabled = true/);
  assert.match(app, /setAttribute\("aria-busy", "true"\)/);
  assert.match(app, /"正在封存…"/);
  assert.match(app, /removeAttribute\("aria-busy"\)/);
  assert.match(app, /if \(confirmationCloseButton\.disabled\) return;/);
});

test("a stale submission owner cannot finish or close the next modal", () => {
  const ownership = createConfirmationDialogOwnership();
  const firstOwner = ownership.open();

  assert.equal(ownership.beginSubmission(firstOwner), true);
  assert.equal(ownership.close(firstOwner), true);

  const nextOwner = ownership.open();
  assert.equal(ownership.beginSubmission(nextOwner), true);
  assert.equal(ownership.finishSubmission(firstOwner), false);
  assert.equal(ownership.close(firstOwner), false);
  assert.equal(ownership.ownsSubmission(nextOwner), true);
  assert.equal(ownership.finishSubmission(nextOwner), true);
  assert.equal(ownership.close(nextOwner), true);
});

test("missing ownership cannot begin, own, finish, or close a submission", () => {
  const ownership = createConfirmationDialogOwnership();

  assert.equal(ownership.beginSubmission(null), false);
  assert.equal(ownership.ownsSubmission(null), false);
  assert.equal(ownership.finishSubmission(null), false);
  assert.equal(ownership.close(null), false);
});

test("an old close task cannot release a modal opened by show-next first", async () => {
  const ownership = createConfirmationDialogOwnership();
  const firstOwner = ownership.open();
  assert.equal(ownership.close(firstOwner), true);

  let nextOwner = null;
  await new Promise((resolve) => {
    queueMicrotask(() => {
      nextOwner = ownership.open();
      assert.equal(ownership.beginSubmission(nextOwner), true);
    });
    setTimeout(() => {
      assert.equal(
        ownership.handleCloseEvent({ dialogOpen: true }),
        false,
      );
      resolve();
    }, 0);
  });

  assert.equal(ownership.current(), nextOwner);
  assert.equal(ownership.ownsSubmission(nextOwner), true);
});

test("the native close event only releases ownership while the dialog stays closed", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf('confirmationDialog.addEventListener("close"');
  const end = app.indexOf("\ndocument.addEventListener", start);
  const listener = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(listener, /if \(confirmationDialog\.open\) return;/);
  assert.match(
    listener,
    /confirmationDialogOwnership\.handleCloseEvent\(\{ dialogOpen: false \}\)/,
  );
  assert.equal((app.match(/confirmationDialog\.close\(\)/g) || []).length, 1);
});

test("every asynchronous confirmation mutation is bound to its modal owner", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const handlers = [
    ["async function submitInternalAttention", "\nfunction handleInternalAttentionClick"],
    ["async function handleConfirmation", "\nasync function handleExternalConfirmation"],
    ["async function handleReviewDraftDecision", "\nfunction updateChrome"],
  ];

  for (const [startMarker, endMarker] of handlers) {
    const start = app.indexOf(startMarker);
    const end = app.indexOf(endMarker, start);
    const handler = app.slice(start, end);

    assert.ok(start >= 0 && end > start, startMarker);
    assert.match(handler, /const submissionOwner = beginConfirmationSubmission\(/);
    assert.match(handler, /confirmationDialogOwnership\.ownsSubmission\(submissionOwner\)/);
    assert.match(handler, /closeConfirmationSubmission\(submissionOwner\)/);
    assert.match(handler, /restoreConfirmationSubmission\(\s*submissionOwner/);
  }
});

test("local-only deferrals close before refreshing without starting a submission", async () => {
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const handlers = [
    ["async function handleConfirmation", "\nasync function handleExternalConfirmation"],
    ["async function handleReviewDraftDecision", "\nfunction updateChrome"],
  ];

  for (const [startMarker, endMarker] of handlers) {
    const start = app.indexOf(startMarker);
    const end = app.indexOf(endMarker, start);
    const handler = app.slice(start, end);
    const begin = handler.indexOf("const submissionOwner");
    const laterBranch = handler.slice(0, begin);

    assert.ok(start >= 0 && end > start && begin > 0, startMarker);
    assert.match(laterBranch, /if \(decision === "later"\)/);
    assert.ok(
      laterBranch.indexOf("closeConfirmationDialog()") <
        laterBranch.indexOf("await refreshAfterDeferral()"),
      startMarker,
    );
    assert.doesNotMatch(laterBranch, /beginConfirmationSubmission/);
  }
});

test("a late mutation cannot settle another modal for any confirmation kind", () => {
  for (const kind of ["internal", "responsibility", "review_draft"]) {
    const ownership = createConfirmationDialogOwnership();
    const oldOwner = ownership.open();
    assert.equal(ownership.beginSubmission(oldOwner), true, kind);
    assert.equal(ownership.close(oldOwner), true, kind);

    const nextOwner = ownership.open();
    assert.equal(ownership.beginSubmission(nextOwner), true, kind);
    assert.equal(ownership.ownsSubmission(oldOwner), false, kind);
    assert.equal(ownership.finishSubmission(oldOwner), false, kind);
    assert.equal(ownership.close(oldOwner), false, kind);
    assert.equal(ownership.ownsSubmission(nextOwner), true, kind);
  }
});
