import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { validationBrowserLaunchOptions } from
  "./playwright-validation-options.mjs";
import { verifyLiveDashboard } from "./system-live-validation.mjs";
import { partitionBrowserFailures } from "./ui-validation-diagnostics.mjs";
import {
  buildUiArtifactReceipt,
  parseUiValidationCommandArguments,
  prepareUiArtifactDirectory,
  writeUiArtifactReceipt,
} from "./system-ui-artifact-receipt.mjs";

const baseUrl = "http://127.0.0.1:4173";
const { outputDirectory: relativeOutputDirectory, runId, liveService } =
  parseUiValidationCommandArguments(process.argv.slice(2));
const preparedOutput = await prepareUiArtifactDirectory({
  root: process.cwd(),
  runId,
});
assert.equal(preparedOutput.relativeDirectory, relativeOutputDirectory);
const outputDirectory = preparedOutput.directory;
await verifyLiveDashboard({
  baseUrl,
  expectedRuntimeSource: liveService.runtimeSource,
  expectedLiveService: liveService,
});

const browser = await chromium.launch(validationBrowserLaunchOptions({
  headless: true,
}));
const results = [];
let artifactReceiptEnvelope = null;

try {

async function observedPage(options) {
  const page = await browser.newPage(options);
  const consoleErrors = [];
  const httpErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({
        text: message.text(),
        location: message.location(),
      });
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    httpErrors.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, consoleErrors, httpErrors, pageErrors };
}

async function pageDiagnostics(
  observation,
  { expectedHttpFailures = [] } = {},
) {
  const { page, consoleErrors, httpErrors, pageErrors } = observation;
  const partitionedFailures = partitionBrowserFailures(
    { consoleErrors, httpErrors },
    expectedHttpFailures,
  );
  const diagnostics = await page.evaluate(() => {
    const accessibilityIssues = [];
    if (!document.documentElement.lang.trim()) {
      accessibilityIssues.push("document language is missing");
    }
    if (!document.title.trim()) {
      accessibilityIssues.push("document title is missing");
    }
    const ids = new Set();
    for (const element of document.querySelectorAll("[id]")) {
      if (ids.has(element.id)) {
        accessibilityIssues.push(`duplicate id: ${element.id}`);
      }
      ids.add(element.id);
    }
    for (const image of document.querySelectorAll("img")) {
      if (!image.hasAttribute("alt")) {
        accessibilityIssues.push("image alternative text is missing");
      }
    }
    for (const dialog of document.querySelectorAll("dialog[open]")) {
      if (
        !dialog.getAttribute("aria-label")?.trim() &&
        !dialog.getAttribute("aria-labelledby")?.trim()
      ) {
        accessibilityIssues.push(`open dialog is unnamed: ${dialog.id || "unknown"}`);
      }
    }
    for (const button of document.querySelectorAll("button")) {
      if (
        !button.textContent?.trim() &&
        !button.getAttribute("aria-label")?.trim() &&
        !button.getAttribute("title")?.trim()
      ) {
        accessibilityIssues.push("button accessible name is missing");
      }
    }
    return {
      accessibilityIssues,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  return {
    ...partitionedFailures,
    pageErrors,
    horizontalOverflow: diagnostics.horizontalOverflow,
    accessibilityFailures: diagnostics.accessibilityIssues.length,
    accessibilityIssues: diagnostics.accessibilityIssues,
  };
}

function sectionByTitle(page, title) {
  return page.locator(".section").filter({
    has: page.locator("h2", { hasText: title }),
  });
}

async function routeEmptyAttentionQueue(page) {
  await page.route("**/api/attention/next**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        source: null,
        pendingCount: 0,
        externalEnabled: true,
        externalQueueRevision: 0,
        item: null,
      }),
    }),
  );
}

function deferred() {
  let resolve;
  return {
    promise: new Promise((next) => {
      resolve = next;
    }),
    resolve,
  };
}

async function assertPending(promise, message) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, message);
}

async function systemStatusResult(
  page,
  { expectError = false, expectedCheckedAt = "" } = {},
) {
  const systemBackup = page.locator("[data-system-backup-create]");
  const systemError = page.locator('.system-status-panel [role="alert"]');
  if (expectError) {
    await systemError.waitFor();
  } else {
    if (!expectedCheckedAt) {
      throw new Error("successful System status response is missing readiness.checkedAt");
    }
    await page
      .locator(".system-status-checked")
      .filter({ hasText: `检查时间：${expectedCheckedAt}` })
      .waitFor();
  }
  const systemErrorVisible = await systemError.isVisible();
  return {
    systemStatusText: await page.locator(".system-status-panel").innerText(),
    systemBackupVisible: await systemBackup.isVisible(),
    systemErrorVisible,
    systemErrorText: systemErrorVisible ? await systemError.innerText() : "",
  };
}

async function activateSystemAndReadStatus(page) {
  const systemStatusResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" &&
      url.origin === new URL(baseUrl).origin &&
      url.pathname === "/api/system/status";
  });
  await page.locator('[data-view="system"]').click();
  const response = await systemStatusResponse;
  if (!response.ok()) return systemStatusResult(page, { expectError: true });
  const status = await response.json();
  const checkedAt = status?.readiness?.checkedAt;
  return systemStatusResult(page, { expectedCheckedAt: checkedAt });
}

async function validate(name, viewport) {
  const observation = await observedPage({ viewport, acceptDownloads: true });
  const { page } = observation;
  await routeEmptyAttentionQueue(page);
  const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#content .section").first().waitFor();
  await page.screenshot({
    path: path.join(outputDirectory, `${name}.png`),
    fullPage: true,
  });
  await page.keyboard.press("Tab");
  const skipLinkFocused = await page.evaluate(
    () => document.activeElement?.matches?.(".skip-link") === true,
  );
  await page.keyboard.press("Enter");
  const skipTargetFocused = await page.evaluate(
    () => document.activeElement?.id === "main-content",
  );

  const actionNowCount = await sectionByTitle(
    page,
    "现在轮到我",
  ).locator(".work-item").count();
  const sourceHealth = await page.locator("#source-health").innerText();
  const employeeState = await page
    .locator(".employee-panel .status-pill")
    .first()
    .innerText();
  let detailHasResponsibility = false;
  if (actionNowCount) {
    await sectionByTitle(page, "现在轮到我").locator(".work-item").first().click();
    await page.locator("#detail-dialog[open]").waitFor();
    detailHasResponsibility = await page
      .locator("#detail-dialog")
      .getByText("责任状态", { exact: true })
      .isVisible();
    await page.getByRole("button", { name: "关闭详情" }).click();
  }
  await page.locator('[data-view="prs"]').click();
  const { viewTitleUpdated, viewHeadingFocused } = await page.evaluate(() => ({
    viewTitleUpdated:
      document.title === "Pull Requests · Development Intelligence Hub",
    viewHeadingFocused:
      document.activeElement === document.querySelector("#page-title"),
  }));
  const prSectionTitles = await page.locator(".section-heading h2").allTextContents();
  await page.locator('[data-view="versions"]').click();
  const versionRows = await page.locator(".version-row").count();
  const newestVersionFirstNote = (
    await sectionByTitle(page, "跟踪版本")
      .locator(".section-heading span")
      .innerText()
  ).includes("最新创建/发布在前");
  await page.locator('[data-view="signals"]').click();
  const signalCount = await page.locator(".work-item").count();
  if (signalCount) {
    await page.locator(".work-item").first().click();
    await page.locator("dialog[open]").waitFor();
    await page.getByRole("button", { name: "关闭详情" }).click();
  }
  await page.locator('[data-view="employees"]').click();
  const employeeJobCount = await page.locator(".employee-job").count();
  await page.locator('[data-view="memory"]').click();
  await page.locator("#memory-search-form").waitFor();
  const memorySearchVisible = await page
    .getByLabel("搜索 PR、仓库、问题或处理结论")
    .isVisible();
  const system = await activateSystemAndReadStatus(page);
  const diagnostics = await pageDiagnostics(observation);
  results.push({
    name,
    status: response?.status(),
    actionNowCount,
    sourceHealth,
    employeeState,
    employeeJobCount,
    memorySearchVisible,
    systemStatusVisible:
      system.systemStatusText.includes("Liveness") &&
      system.systemStatusText.includes("Readiness") &&
      system.systemStatusText.includes("一致性备份"),
    systemBackupVisible: system.systemBackupVisible,
    systemErrorVisible: system.systemErrorVisible,
    systemErrorText: system.systemErrorText,
    detailHasResponsibility,
    skipLinkFocused,
    skipTargetFocused,
    viewTitleUpdated,
    viewHeadingFocused,
    prSectionTitles,
    versionRows,
    newestVersionFirstNote,
    signalCount,
    ...diagnostics,
  });
  await page.close();
}

await validate("desktop-1440", { width: 1440, height: 1000 });
await validate("mobile-390", { width: 390, height: 844 });

async function validateConfirmationQueue() {
  const liveDashboard = await fetch(`${baseUrl}/api/dashboard`).then((response) =>
    response.json(),
  );
  const fixture = structuredClone(liveDashboard);
  fixture.employee = {
    role: {
      id: "pr-reviewer",
      name: "PR 推进员工",
      state: "observing",
      revision: 1,
      brain: { provider: "ollama", model: "qwen3.5:9b" },
      paused: false,
      lastRun: null,
      lastError: "",
    },
    jobs: [],
    confirmationQueue: [],
  };
  const seed =
    fixture.groups.actionNow[0] ||
    fixture.groups.waitingOther[0] ||
    fixture.groups.myPullRequests[0];
  const uncertain = {
    ...seed,
    id: "fixture:uncertain-pr",
    repo: "local/fixture",
    number: 1,
    title: "需要确认责任归属的测试 PR",
    headRefOid: "fixture-head-1",
    actionState: "uncertain",
    nextActor: "unknown",
    nextAction: "confirm",
    actionReasons: ["审核事实不完整"],
    reasons: ["需要你确认责任归属"],
    score: 80,
    brainAssessment: {
      classification: "waiting_other",
      nextActor: "author",
      confidence: 0.74,
      evidence: ["缺少完整审核事实"],
      recommendedAction: "建议确认是否正在等待作者",
      requiresConfirmation: true,
    },
  };
  fixture.groups.uncertainPullRequests = [uncertain];
  fixture.counts.uncertainPullRequests = 1;

  const confirmed = structuredClone(fixture);
  confirmed.groups.uncertainPullRequests = [];
  confirmed.groups.waitingOther = [
    {
      ...uncertain,
      actionState: "waiting_other",
      nextActor: "other",
      nextAction: "wait_other",
      actionReasons: ["你已确认：当前等待他人处理"],
      reasons: ["你已确认：当前等待他人处理"],
      score: 35,
    },
    ...confirmed.groups.waitingOther,
  ];
  confirmed.counts.uncertainPullRequests = 0;
  confirmed.counts.waitingOther += 1;

  const observation = await observedPage({
    viewport: { width: 1100, height: 820 },
  });
  const { page } = observation;
  const requests = [];
  await routeEmptyAttentionQueue(page);
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }),
  );
  await page.route("**/api/pr-responsibility/confirm", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(confirmed),
    });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#confirmation-dialog[open]").waitFor();
  const recommendationVisible = await page
    .getByText("建议确认是否正在等待作者", { exact: true })
    .isVisible();
  await page.getByRole("button", { name: "等待别人", exact: true }).click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  const confirmedVisible = await sectionByTitle(page, "等待别人")
    .getByText("需要确认责任归属的测试 PR", { exact: true })
    .isVisible();
  const diagnostics = await pageDiagnostics(observation);
  results.push({
    name: "confirmation-queue",
    recommendationVisible,
    confirmedVisible,
    request: requests[0],
    ...diagnostics,
  });
  await page.close();
}

await validateConfirmationQueue();

async function validateCodeJobControlAndPackage(name, viewport) {
  const liveDashboard = await fetch(`${baseUrl}/api/dashboard`).then((response) =>
    response.json(),
  );
  const fixture = structuredClone(liveDashboard);
  fixture.groups.uncertainPullRequests = [];
  fixture.counts.uncertainPullRequests = 0;
  if (fixture.employee) fixture.employee.confirmationQueue = [];

  const jobId = `code-job-${"c".repeat(55)}`;
  const packageDigest = "d".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const workspaceRevision = "e".repeat(64);
  const sourceRevision = "f".repeat(64);
  const recordDigest = "1".repeat(64);
  const now = "2026-08-02T05:00:00.000Z";
  const evidenceByKind = Object.fromEntries(
    ["output", "stdout", "stderr"].map((kind) => {
      const content = Buffer.from(
        `${JSON.stringify({ kind, status: "passed" })}\n`,
        "utf8",
      );
      return [
        kind,
        {
          content,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ];
    }),
  );
  let jobStatus = "active";
  let jobRevision = 7;
  let applyQueued = false;
  const requests = [];

  const job = () => ({
    jobId,
    status: jobStatus,
    revision: jobRevision,
    proposalId: "proposal-ui-validation",
    proposalContentDigest: "2".repeat(64),
    grantDigest: "3".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-ui-validation" },
    subject: { kind: "issue", id: "local/fixture#12" },
    repository: "local/fixture",
    workspaceId: "fixture-workspace",
    operation: "modify",
    objective: "修复付款失败路径并保留受控证据",
    acceptanceCriteria: ["固定测试通过", "只修改 src/pay.js"],
    evidence: ["Issue #12 复现失败"],
    summary: "验证 Code Job 详情与变更包流程",
    reason: "本地 UI 验收",
    allowedActions: ["read_text", "write_text", "run_profile", "complete"],
    writablePaths: ["src/pay.js"],
    requiredProfiles: ["node-tests"],
    turn: 1,
    pendingActionType: null,
    observationCount: 1,
    latestObservation: {
      actionType: "run_profile",
      status: "succeeded",
      recordedAt: now,
    },
    terminalResult: jobStatus === "cancelled"
      ? { kind: "cancelled", recordedAt: now }
      : null,
    memoryProjection: null,
    pause: jobStatus === "paused" ? { reason: "UI validation", at: now } : null,
    uncertainty: null,
    createdAt: now,
    updatedAt: now,
  });
  const detail = () => ({
    job: job(),
    archived: false,
    historyAvailable: true,
    observations: [
      {
        turn: 1,
        actionId: "action-ui-validation",
        actionType: "run_profile",
        actionDigest: "4".repeat(64),
        status: "succeeded",
        workspaceRevision,
        detailDigest: "5".repeat(64),
        detail: {
          schemaVersion: 1,
          executor: { actionStatus: "succeeded", actionAttemptNumber: 1 },
          result: { exitCode: 0, durationMs: 812, timedOut: false, error: null },
        },
        recordedAt: now,
      },
    ],
    nextCursor: null,
    terminalDetail: null,
    changePackage: {
      status: "ready",
      receipt: { packageId, packageDigest, deliveredAt: now },
      application: applyQueued
        ? {
            status: "pending",
            canRequest: false,
            confirmationId: confirmationItem.id,
            updatedAt: now,
          }
        : { status: "not_requested", canRequest: true },
    },
  });
  const manifest = {
    schemaVersion: 1,
    job: { id: jobId, revision: jobRevision, recordDigest },
    proposal: { id: "proposal-ui-validation", contentDigest: "2".repeat(64) },
    grant: { digest: "3".repeat(64) },
    workspace: { id: "fixture-workspace", sourceRevision, workspaceRevision },
    passedProfiles: [
      {
        id: "node-tests",
        configDigest: "4".repeat(64),
        workspaceRevision,
        actionId: "action-ui-validation",
        attemptNumber: 1,
        imageId: "node@sha256:fixture",
        artifacts: Object.fromEntries(
          Object.entries(evidenceByKind).map(([kind, evidence]) => [
            kind,
            {
              path: `${jobId}/action-ui-validation/${kind}.json`,
              sha256: evidence.sha256,
              bytes: evidence.content.length,
            },
          ]),
        ),
      },
    ],
    changes: {
      created: [],
      modified: [
        {
          path: "src/pay.js",
          beforeSha256: "6".repeat(64),
          blob: { sha256: "7".repeat(64), bytes: 128 },
        },
      ],
      deleted: [],
    },
    packageId,
    packageDigest,
  };
  const confirmationItem = {
    id: "confirmation-change-package-ui-validation",
    kind: "local.change-package-apply",
    status: "pending",
    queueRevision: 12,
    itemRevision: 1,
    requestedBy: { roleId: "developer", workItemId: "work-ui-validation" },
    actor: {
      provider: "local-code",
      accountId: "change-package-application-service",
    },
    target: {
      provider: "local-code",
      resourceId: "fixture-workspace",
      version: "8".repeat(40),
    },
    display: {
      title: "应用已验证的本地变更包",
      summary: "将 1 项文件变更应用到已选择的本地 checkout。",
      actionLabel: "确认并应用变更包",
      evidence: ["修改 1 个文件", "已通过 node-tests"],
      payload: {
        actor: {
          provider: "local-code",
          accountId: "change-package-application-service",
        },
        target: {
          provider: "local-code",
          resourceId: "fixture-workspace",
          version: "8".repeat(40),
        },
        action: {
          type: "apply_change_package",
          packageId,
          packageDigest,
          job: { id: jobId, revision: jobRevision, recordDigest },
          proposal: { id: "proposal-ui-validation", contentDigest: "2".repeat(64) },
          grant: { digest: "3".repeat(64) },
          workspace: { id: "fixture-workspace", sourceRevision, workspaceRevision },
          changeSetDigest: "9".repeat(64),
          testEvidenceDigest: "a".repeat(64),
          targetAuthorityDigest: "b".repeat(64),
          expectedHeadOid: "8".repeat(40),
        },
      },
    },
    displayedPayloadDigest: "a".repeat(64),
    approvalBindingDigest: "b".repeat(64),
    retryable: false,
  };

  const observation = await observedPage({ viewport, acceptDownloads: true });
  const { page, consoleErrors, httpErrors, pageErrors } = observation;
  const overflowChecks = [];
  const focusChecks = [];
  async function recordHorizontalOverflow(stage) {
    overflowChecks.push({
      stage,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    });
  }
  async function recordDialogFocus(stage, selector) {
    focusChecks.push({
      stage,
      inside: await page.evaluate(
        ({ dialogSelector, actionSelector }) => {
          const activeElement = document.activeElement;
          return Boolean(
            document.querySelector(dialogSelector)?.contains(activeElement) &&
              (!actionSelector || activeElement?.matches(actionSelector)),
          );
        },
        { dialogSelector: "#detail-dialog", actionSelector: selector },
      ),
    });
  }
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    }),
  );
  await page.route("**/api/attention/next**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: applyQueued,
        source: applyQueued ? "external_confirmation" : null,
        pendingCount: applyQueued ? 1 : 0,
        externalEnabled: true,
        externalQueueRevision: 12,
        item: applyQueued ? confirmationItem : null,
      }),
    }),
  );
  await page.route("**/api/work/summary", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        itemCounts: {},
        safeguards: { prEmployeePaused: true, externalActionsEnabled: false },
      }),
    }),
  );
  for (const endpoint of ["items", "timeline"]) {
    await page.route(`**/api/work/${endpoint}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [] }),
      }),
    );
  }
  await page.route("**/api/code/jobs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (request.method() === "POST") {
      requests.push({ pathname, body: request.postDataJSON() });
      if (pathname.endsWith("/control")) {
        const input = request.postDataJSON();
        if (input.expectedRevision !== jobRevision) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "stale code job revision" }),
          });
          return;
        }
        if (input.command === "pause") {
          jobStatus = "paused";
        } else if (input.command === "resume") {
          jobStatus = "active";
        } else if (input.command === "cancel") {
          jobStatus = "cancelled";
        } else {
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: "unexpected code job command" }),
          });
          return;
        }
        jobRevision += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "applied", job: job() }),
        });
        return;
      }
      if (pathname.endsWith("/change-package/apply")) {
        applyQueued = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ request: { id: confirmationItem.id, status: "pending" } }),
        });
        return;
      }
    }
    if (request.method() === "GET" && pathname === "/api/code/jobs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, items: [job()], nextCursor: null }),
      });
      return;
    }
    if (request.method() === "GET" && pathname.endsWith("/change-package")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ manifest: { ...manifest, job: { ...manifest.job, revision: jobRevision } } }),
      });
      return;
    }
    if (request.method() === "GET" && pathname.includes("/evidence/")) {
      const kind = pathname.split("/").at(-1);
      const evidence = evidenceByKind[kind];
      const packageBinding = url.searchParams.get("packageDigest");
      const shaBinding = url.searchParams.get("sha256");
      if (
        !evidence ||
        packageBinding !== packageDigest ||
        shaBinding !== evidence.sha256
      ) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "stale evidence binding" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        headers: {
          "content-disposition": `attachment; filename="node-tests-${kind}.json"`,
          "x-content-sha256": evidence.sha256,
        },
        body: evidence.content,
      });
      return;
    }
    if (request.method() === "GET" && pathname === `/api/code/jobs/${jobId}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, detail: detail() }),
      });
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "unexpected code job request" }),
    });
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('[data-view="work"]').click();
  await page.locator(`[data-code-job-id="${jobId}"]`).click();
  await page.locator("#detail-dialog[open]").waitFor();
  await page
    .getByText("修复付款失败路径并保留受控证据", { exact: true })
    .waitFor();
  const objectiveVisible = true;
  const applicationStatusVisible = await page
    .getByText("尚未申请", { exact: true })
    .isVisible();
  await recordHorizontalOverflow("detail-open");
  await page.getByRole("button", { name: "安全暂停", exact: true }).click();
  await page.getByRole("button", { name: "恢复执行", exact: true }).waitFor();
  await recordDialogFocus("pause-successor", '[data-code-job-control="resume"]');
  await page.getByRole("button", { name: "查看变更包", exact: true }).click();
  await page
    .getByRole("button", { name: "申请应用变更包", exact: true })
    .waitFor();
  const manifestVisible = await page
    .locator(".code-job-manifest .code-job-change-list li")
    .filter({ hasText: "src/pay.js" })
    .isVisible();
  await recordDialogFocus("package-successor", "[data-code-job-apply]");
  await recordHorizontalOverflow("manifest-open");
  const stdoutEvidence = evidenceByKind.stdout;
  const stdoutEvidenceRow = page
    .locator(".code-job-profile-artifacts dd")
    .filter({ hasText: stdoutEvidence.sha256 });
  const downloadStarted = page.waitForEvent("download");
  await stdoutEvidenceRow.getByRole("link", { name: "下载原始证据" }).click();
  const download = await downloadStarted;
  const downloadUrl = download.url();
  const downloadedEvidence = Buffer.from(
    await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`evidence download failed: ${response.status}`);
      return [...new Uint8Array(await response.arrayBuffer())];
    }, downloadUrl),
  );
  await download.cancel().catch(() => {});
  const evidenceDownloadDigestMatches =
    createHash("sha256").update(downloadedEvidence).digest("hex") ===
      stdoutEvidence.sha256 &&
    downloadedEvidence.equals(stdoutEvidence.content);

  await page.keyboard.press("Escape");
  await page.locator("#detail-dialog").waitFor({ state: "hidden" });
  const escapeClosedDetail = true;
  await page.locator(`[data-code-job-id="${jobId}"]`).click();
  await page.locator("#detail-dialog[open]").waitFor();
  await page
    .getByText("修复付款失败路径并保留受控证据", { exact: true })
    .waitFor();
  const staleActionFocusAfterReopen = await page.evaluate(() =>
    document.activeElement?.matches?.(
      "[data-code-job-control], [data-code-job-history-more], [data-code-job-package], [data-code-job-apply]",
    ),
  );
  await page.getByRole("button", { name: "查看变更包", exact: true }).click();
  await page
    .getByRole("button", { name: "申请应用变更包", exact: true })
    .waitFor();
  await recordDialogFocus("package-successor-after-reopen", "[data-code-job-apply]");
  await page
    .getByRole("button", { name: "申请应用变更包", exact: true })
    .click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  const packageConfirmationVisible = await page
    .locator("#confirmation-dialog")
    .getByText(packageId, { exact: true })
    .isVisible();
  const singleOpenDialog = (await page.locator("dialog[open]").count()) === 1;
  const confirmationFocusInsideDialog = await page.evaluate(() =>
    document
      .querySelector("#confirmation-dialog")
      ?.contains(document.activeElement),
  );
  await recordHorizontalOverflow("confirmation-open");
  await page
    .locator("#confirmation-dialog")
    .getByRole("button", { name: "稍后再看", exact: true })
    .click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  await page.locator(`[data-code-job-id="${jobId}"]`).click();
  await page.locator("#detail-dialog[open]").waitFor();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page
    .locator("#detail-dialog")
    .getByText("已取消", { exact: true })
    .waitFor();
  const cancellationStatusVisible = true;
  const cancellationRemovedControls =
    (await page.locator("#detail-dialog [data-code-job-control]").count()) === 0;
  const cancellationSingleOpenDialog =
    (await page.locator("dialog[open]").count()) === 1;
  await recordDialogFocus("cancel-successor", ".dialog-close");
  await recordHorizontalOverflow("cancelled");
  const diagnostics = await pageDiagnostics(observation);

  results.push({
    name: `code-job-control-package-${name}`,
    objectiveVisible,
    applicationStatusVisible,
    manifestVisible,
    evidenceDownloadDigestMatches,
    escapeClosedDetail,
    staleActionFocusAfterReopen,
    packageConfirmationVisible,
    singleOpenDialog,
    confirmationFocusInsideDialog,
    cancellationStatusVisible,
    cancellationRemovedControls,
    cancellationSingleOpenDialog,
    focusChecks,
    horizontalOverflow:
      diagnostics.horizontalOverflow ||
      overflowChecks.some((check) => check.overflow),
    overflowChecks,
    consoleErrors,
    httpErrors,
    pageErrors,
    accessibilityFailures: diagnostics.accessibilityFailures,
    accessibilityIssues: diagnostics.accessibilityIssues,
    requests,
  });
  await page.close();
}

await validateCodeJobControlAndPackage("desktop-1100", {
  width: 1100,
  height: 820,
});
await validateCodeJobControlAndPackage("mobile-390", {
  width: 390,
  height: 844,
});

async function validateExternalReviewConfirmation() {
  const liveDashboard = await fetch(`${baseUrl}/api/dashboard`).then((response) =>
    response.json(),
  );
  const fixture = structuredClone(liveDashboard);
  fixture.groups.uncertainPullRequests = [];
  fixture.counts.uncertainPullRequests = 0;
  const reviewJob = {
    id: "pr-work-fixture",
    subjectId: "github:pr:local/fixture#9",
    repo: "local/fixture",
    number: 9,
    title: "员工主动生成的评审草稿",
    url: "https://example.invalid/local/fixture/pull/9",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    nextAction: "review",
    triggerReason: "等待你首次审核",
    status: "waiting_confirmation",
    summary: "发现错误路径缺少覆盖。",
    evidence: ["src/pay.js 修改了失败分支"],
    steps: ["补充失败路径测试"],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    requiresApproval: true,
    brain: { provider: "ollama", model: "qwen3.5:9b" },
    createdAt: "2026-07-31T10:00:00.000Z",
  };
  fixture.employee = {
    role: {
      id: "pr-reviewer",
      name: "PR 推进员工",
      mission: "主动巡查与你相关的 PR，生成评审草稿或推进方案",
      state: "waiting_user",
      revision: 8,
      brain: { provider: "ollama", model: "qwen3.5:9b" },
      paused: false,
      lastRun: {
        trigger: "refresh_completed",
        at: "2026-07-31T10:00:00.000Z",
        summary: "新建 1 个评审作业",
      },
      lastError: "",
    },
    jobs: [reviewJob],
    confirmationQueue: [],
  };
  const published = structuredClone(fixture);
  published.employee.jobs[0].status = "published";
  published.employee.role.state = "observing";
  published.employee.role.revision = 9;

  const confirmationItem = {
    id: "confirmation-pr-work-fixture",
    kind: "github.pull-request-review",
    status: "pending",
    queueRevision: 8,
    itemRevision: 2,
    requestedBy: { roleId: "pr-reviewer", workItemId: reviewJob.id },
    actor: { provider: "github", accountId: "review-account" },
    target: {
      provider: "github",
      resourceId: "local/fixture#9",
      version: reviewJob.headRefOid,
    },
    display: {
      title: "local/fixture #9 · 员工主动生成的评审草稿",
      summary: reviewJob.summary,
      actionLabel: "确认并发布到 GitHub",
      evidence: reviewJob.evidence,
      payload: {
        actor: { provider: "github", accountId: "review-account" },
        target: {
          provider: "github",
          resourceId: "local/fixture#9",
          version: reviewJob.headRefOid,
        },
        action: {
          type: "pull_request_review",
          reviewEvent: "REQUEST_CHANGES",
          body: reviewJob.reviewBody,
        },
      },
    },
    displayedPayloadDigest: "a".repeat(64),
    approvalBindingDigest: "b".repeat(64),
    retryable: false,
  };

  const observation = await observedPage({
    viewport: { width: 1100, height: 820 },
  });
  const { page } = observation;
  const requests = [];
  let wasPublished = false;
  let confirmationPhase = "later";
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wasPublished ? published : fixture),
    }),
  );
  await page.route("**/api/attention/next**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: !wasPublished,
        source: wasPublished ? null : "external_confirmation",
        pendingCount: wasPublished ? 0 : 1,
        externalEnabled: true,
        externalQueueRevision: wasPublished ? 10 : 8,
        item: wasPublished ? null : confirmationItem,
      }),
    }),
  );
  await page.route("**/api/confirmations/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      pathname === "/api/confirmations/history"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          queueRevision: wasPublished ? 10 : 8,
          filters: {},
          limit: 20,
          roleIdFacets: ["pr-reviewer"],
          items: [],
          nextCursor: null,
        }),
      });
      return;
    }
    if (request.method() === "POST") {
      requests.push({
        phase: confirmationPhase,
        pathname,
        body: request.postDataJSON(),
      });
      if (
        confirmationPhase === "approve" &&
        pathname ===
          "/api/confirmations/confirmation-pr-work-fixture/approve"
      ) {
        wasPublished = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            item: { ...confirmationItem, status: "completed" },
            next: { queueRevision: 10, pendingCount: 0, item: null },
            employeeSyncPending: false,
          }),
        });
        return;
      }
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "unexpected confirmation request" }),
    });
  });
  await page.route("**/api/memory/query**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "memory-fixture",
            title: reviewJob.title,
            summary: reviewJob.summary,
            repository: reviewJob.repo,
            number: reviewJob.number,
            event: "analysis_ready",
            createdAt: reviewJob.createdAt,
          },
        ],
        totalMatched: 1,
        nextCursor: null,
        indexHealthy: true,
      }),
    }),
  );

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#confirmation-dialog[open]").waitFor();
  const actorVisible = await page
    .getByText("review-account", { exact: true })
    .isVisible();
  const headVisible = await page.getByText(reviewJob.headRefOid, { exact: true }).isVisible();
  const reviewBodyVisible = await page
    .getByText(reviewJob.reviewBody, { exact: true })
    .isVisible();
  await page.getByRole("button", { name: "稍后再看", exact: true }).click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  const laterRequestCount = requests.filter(
    (request) => request.phase === "later",
  ).length;

  confirmationPhase = "approve";
  await page.reload({ waitUntil: "networkidle" });
  const deferredPersistedAcrossReload =
    (await page.locator("#confirmation-dialog[open]").count()) === 0;
  await page.locator('[data-view="employees"]').click();
  const deferredRestore = page.locator("#confirmation-deferred-restore");
  await deferredRestore.waitFor();
  const deferredRestoreVisible = await deferredRestore.isVisible();
  await deferredRestore.click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  assert.equal(await page.locator("[data-review-handoff]").inputValue(), "pull_request");
  await page
    .getByRole("button", { name: "确认发布并分配下一步", exact: true })
    .click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  await page.locator('[data-view="employees"]').click();
  await page.locator(".employee-job-history > summary").click();
  const publishedBadge = page.getByText("已发布", { exact: true });
  await publishedBadge.waitFor();
  const publishedVisible = await publishedBadge.isVisible();
  await page.locator('[data-view="memory"]').click();
  await page.getByText(reviewJob.title, { exact: true }).waitFor();
  const diagnostics = await pageDiagnostics(observation);

  results.push({
    name: "external-review-confirmation",
    actorVisible,
    headVisible,
    reviewBodyVisible,
    publishedVisible,
    laterRequestCount,
    deferredPersistedAcrossReload,
    deferredRestoreVisible,
    request: requests.find((request) => request.phase === "approve"),
    ...diagnostics,
  });
  await page.close();
}

async function validateSystemStatusFailureStates() {
  const expectedSystemStatusFailure = Object.freeze({
    method: "GET",
    url: `${baseUrl}/api/system/status`,
    status: 503,
  });
  const initialObservation = await observedPage({
    viewport: { width: 1100, height: 820 },
  });
  const { page: initialFailure } = initialObservation;
  await routeEmptyAttentionQueue(initialFailure);
  await initialFailure.route("**/api/system/status", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture failure" }),
    }),
  );
  await initialFailure.goto(baseUrl, { waitUntil: "networkidle" });
  const initial = await activateSystemAndReadStatus(initialFailure);
  results.push({
    name: "system-status-initial-error",
    ...initial,
    ...await pageDiagnostics(initialObservation, {
      expectedHttpFailures: [expectedSystemStatusFailure],
    }),
  });
  await initialFailure.close();

  const staleFailureObservation = await observedPage({
    viewport: { width: 1100, height: 820 },
  });
  const { page: staleFailure } = staleFailureObservation;
  await routeEmptyAttentionQueue(staleFailure);
  await staleFailure.goto(baseUrl, { waitUntil: "networkidle" });
  await activateSystemAndReadStatus(staleFailure);
  await staleFailure.locator('[data-view="memory"]').click();
  await staleFailure.locator("#memory-search-form").waitFor();
  const staleFailureResponse = deferred();
  const staleFailureRouteEntered = deferred();
  await staleFailure.route("**/api/system/status", async (route) => {
    staleFailureRouteEntered.resolve();
    await staleFailureResponse.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture failure" }),
    });
  });
  const staleResult = activateSystemAndReadStatus(staleFailure);
  await staleFailureRouteEntered.promise;
  await assertPending(staleResult, "stale 503 activation must remain pending");
  staleFailureResponse.resolve();
  const stale = await staleResult;
  results.push({
    name: "system-status-stale-error",
    ...stale,
    ...await pageDiagnostics(staleFailureObservation, {
      expectedHttpFailures: [expectedSystemStatusFailure],
    }),
  });
  await staleFailure.close();

  const staleSuccessObservation = await observedPage({
    viewport: { width: 1100, height: 820 },
  });
  const { page: staleSuccess } = staleSuccessObservation;
  await routeEmptyAttentionQueue(staleSuccess);
  await staleSuccess.addInitScript(() => {
    const fetchWithHeldSystemStatusJson = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchWithHeldSystemStatusJson(...args);
      const input = args[0];
      const url = new URL(
        typeof input === "string" ? input : input.url,
        window.location.href,
      );
      if (
        !window.__validatorHoldSystemStatusJson ||
        url.pathname !== "/api/system/status"
      ) {
        return response;
      }
      window.__validatorHoldSystemStatusJson = false;
      window.fetch = fetchWithHeldSystemStatusJson;
      return new Proxy(response, {
        get(target, property) {
          if (property === "json") {
            return async () => {
              window.__validatorSystemStatusJsonEntered = true;
              await new Promise((resolve) => {
                window.__validatorReleaseSystemStatusJson = resolve;
              });
              return target.json();
            };
          }
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  });
  await staleSuccess.goto(baseUrl, { waitUntil: "networkidle" });
  await activateSystemAndReadStatus(staleSuccess);
  const heldSuccess = await staleSuccess.evaluate(async () => {
    const response = await fetch("/api/system/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`fixture status ${response.status}`);
    return response.json();
  });
  const expectedCheckedAt = "2035-01-02T03:04:05.000Z";
  heldSuccess.readiness = { ...heldSuccess.readiness, checkedAt: expectedCheckedAt };
  await staleSuccess.locator('[data-view="memory"]').click();
  await staleSuccess.locator("#memory-search-form").waitFor();
  const staleSuccessResponse = deferred();
  const staleSuccessRouteEntered = deferred();
  const staleSuccessResponseEvent = deferred();
  staleSuccess.waitForResponse = () => staleSuccessResponseEvent.promise;
  await staleSuccess.route("**/api/system/status", async (route) => {
    staleSuccessRouteEntered.resolve();
    await staleSuccessResponse.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(heldSuccess),
    });
    const response = {
      url: () => `${baseUrl}/api/system/status`,
      request: () => ({ method: () => "GET" }),
      ok: () => true,
      json: async () => structuredClone(heldSuccess),
    };
    staleSuccessResponseEvent.resolve(response);
  });
  await staleSuccess.evaluate(() => {
    window.__validatorHoldSystemStatusJson = true;
    window.__validatorSystemStatusJsonEntered = false;
    window.__validatorReleaseSystemStatusJson = null;
  });
  const staleSuccessResult = activateSystemAndReadStatus(staleSuccess);
  await staleSuccessRouteEntered.promise;
  await assertPending(staleSuccessResult, "stale 200 activation must remain pending");
  staleSuccessResponse.resolve();
  await staleSuccess.waitForFunction(
    () => window.__validatorSystemStatusJsonEntered === true,
  );
  let staleSuccessSettled = false;
  let staleSuccessValue;
  let staleSuccessError;
  staleSuccessResult.then(
    (value) => {
      staleSuccessSettled = true;
      staleSuccessValue = value;
    },
    (error) => {
      staleSuccessSettled = true;
      staleSuccessError = error;
    },
  );
  await staleSuccess.evaluate(() => null);
  await new Promise((resolve) => setImmediate(resolve));
  if (staleSuccessError) throw staleSuccessError;
  if (staleSuccessSettled) {
    assert.equal(
      staleSuccessValue.systemStatusText.includes(`检查时间：${expectedCheckedAt}`),
      true,
      "stale 200 activation returned pre-response System content",
    );
  }
  assert.equal(
    staleSuccessSettled,
    false,
    "stale 200 activation must wait for current response rendering",
  );
  await staleSuccess.evaluate(() => {
    window.__validatorHoldSystemStatusJson = false;
    window.__validatorReleaseSystemStatusJson();
  });
  const success = await staleSuccessResult;
  results.push({
    name: "system-status-stale-success",
    expectedCheckedAt,
    ...success,
    ...await pageDiagnostics(staleSuccessObservation),
  });
  await staleSuccess.close();
}

await validateExternalReviewConfirmation();
await validateSystemStatusFailureStates();

for (const result of results.filter((entry) => entry.name.includes("-"))) {
  if (["desktop-1440", "mobile-390"].includes(result.name)) {
    assert.equal(result.status, 200, `${result.name}: page must load`);
    assert.deepEqual(result.consoleErrors, [], `${result.name}: console errors`);
    assert.deepEqual(result.httpErrors, [], `${result.name}: HTTP errors`);
    assert.deepEqual(result.pageErrors, [], `${result.name}: page errors`);
    assert.equal(result.horizontalOverflow, false, `${result.name}: overflow`);
    assert.equal(result.memorySearchVisible, true, `${result.name}: memory search`);
    assert.equal(result.skipLinkFocused, true, `${result.name}: skip link focus`);
    assert.equal(result.skipTargetFocused, true, `${result.name}: skip target focus`);
    assert.equal(result.viewTitleUpdated, true, `${result.name}: document title`);
    assert.equal(result.viewHeadingFocused, true, `${result.name}: heading focus`);
    assert.equal(result.systemStatusVisible, true, `${result.name}: system status`);
    assert.equal(result.systemBackupVisible, true, `${result.name}: system backup`);
    assert.equal(
      result.systemErrorVisible,
      false,
      `${result.name}: system error ${result.systemErrorText}`,
    );
    assert.equal(
      result.newestVersionFirstNote,
      true,
      `${result.name}: version ordering note`,
    );
    if (result.actionNowCount) {
      assert.equal(
        result.detailHasResponsibility,
        true,
        `${result.name}: PR detail evidence`,
      );
    }
  }
}

const responsibilityResult = results.find(
  (entry) => entry.name === "confirmation-queue",
);
assert.equal(responsibilityResult.recommendationVisible, true);
assert.equal(responsibilityResult.confirmedVisible, true);
assert.equal(responsibilityResult.request.headRefOid, "fixture-head-1");

const reviewResult = results.find(
  (entry) => entry.name === "external-review-confirmation",
);
assert.equal(reviewResult.actorVisible, true);
assert.equal(reviewResult.headVisible, true);
assert.equal(reviewResult.reviewBodyVisible, true);
assert.equal(reviewResult.publishedVisible, true);
assert.equal(reviewResult.laterRequestCount, 0);
assert.equal(reviewResult.deferredPersistedAcrossReload, true);
assert.equal(reviewResult.deferredRestoreVisible, true);
assert.equal(
  reviewResult.request.pathname,
  "/api/confirmations/confirmation-pr-work-fixture/approve",
);
assert.deepEqual(Object.keys(reviewResult.request.body).sort(), [
  "approvalBindingDigest",
  "displayedPayloadDigest",
  "expectedItemRevision",
  "expectedQueueRevision",
  "requestId",
  "reviewHandoff",
]);
assert.equal(reviewResult.request.body.expectedQueueRevision, 8);
assert.equal(reviewResult.request.body.expectedItemRevision, 2);
assert.equal(reviewResult.request.body.displayedPayloadDigest, "a".repeat(64));
assert.equal(reviewResult.request.body.approvalBindingDigest, "b".repeat(64));
assert.deepEqual(reviewResult.request.body.reviewHandoff, {
  workType: "pull_request",
  responsiblePerson: null,
});

const initialSystemFailure = results.find(
  (entry) => entry.name === "system-status-initial-error",
);
assert.equal(initialSystemFailure.systemErrorVisible, true);
assert.equal(initialSystemFailure.systemBackupVisible, false);
assert.match(initialSystemFailure.systemErrorText, /读取系统状态失败（503）/);

const staleSystemFailure = results.find(
  (entry) => entry.name === "system-status-stale-error",
);
assert.equal(staleSystemFailure.systemErrorVisible, true);
assert.equal(staleSystemFailure.systemBackupVisible, true);
assert.match(staleSystemFailure.systemErrorText, /读取系统状态失败（503）/);

const staleSystemSuccess = results.find(
  (entry) => entry.name === "system-status-stale-success",
);
assert.equal(staleSystemSuccess.systemErrorVisible, false);
assert.equal(staleSystemSuccess.systemBackupVisible, true);
assert.equal(
  staleSystemSuccess.systemStatusText.includes(
    `检查时间：${staleSystemSuccess.expectedCheckedAt}`,
  ),
  true,
);

const codeJobResults = results.filter((entry) =>
  entry.name.startsWith("code-job-control-package-"),
);
assert.equal(codeJobResults.length, 2);
for (const codeJobResult of codeJobResults) {
  assert.equal(codeJobResult.objectiveVisible, true, codeJobResult.name);
  assert.equal(codeJobResult.applicationStatusVisible, true, codeJobResult.name);
  assert.equal(codeJobResult.manifestVisible, true, codeJobResult.name);
  assert.equal(
    codeJobResult.evidenceDownloadDigestMatches,
    true,
    `${codeJobResult.name}: evidence download digest`,
  );
  assert.equal(codeJobResult.escapeClosedDetail, true, codeJobResult.name);
  assert.equal(codeJobResult.staleActionFocusAfterReopen, false, codeJobResult.name);
  assert.equal(codeJobResult.packageConfirmationVisible, true, codeJobResult.name);
  assert.equal(codeJobResult.singleOpenDialog, true, codeJobResult.name);
  assert.equal(codeJobResult.confirmationFocusInsideDialog, true, codeJobResult.name);
  assert.equal(codeJobResult.cancellationStatusVisible, true, codeJobResult.name);
  assert.equal(codeJobResult.cancellationRemovedControls, true, codeJobResult.name);
  assert.equal(codeJobResult.cancellationSingleOpenDialog, true, codeJobResult.name);
  assert.equal(codeJobResult.horizontalOverflow, false, codeJobResult.name);
  assert.deepEqual(codeJobResult.consoleErrors, [], `${codeJobResult.name}: console errors`);
  assert.deepEqual(codeJobResult.httpErrors, [], `${codeJobResult.name}: HTTP errors`);
  assert.deepEqual(codeJobResult.pageErrors, [], `${codeJobResult.name}: page errors`);
  assert.equal(
    codeJobResult.focusChecks.every((check) => check.inside),
    true,
    `${codeJobResult.name}: focus must remain on the intended dialog action`,
  );
  assert.deepEqual(
    codeJobResult.requests.map(({ pathname }) => pathname),
    [
      `/api/code/jobs/${`code-job-${"c".repeat(55)}`}/control`,
      `/api/code/jobs/${`code-job-${"c".repeat(55)}`}/change-package/apply`,
      `/api/code/jobs/${`code-job-${"c".repeat(55)}`}/control`,
    ],
  );
  assert.deepEqual(codeJobResult.requests[0].body, {
    command: "pause",
    expectedRevision: 7,
  });
  assert.deepEqual(codeJobResult.requests[1].body, { expectedRevision: 8 });
  assert.deepEqual(codeJobResult.requests[2].body, {
    command: "cancel",
    expectedRevision: 8,
  });
}

const expectedScenarios = [
  "desktop-1440",
  "mobile-390",
  "confirmation-queue",
  "code-job-control-package-desktop-1100",
  "code-job-control-package-mobile-390",
  "external-review-confirmation",
  "system-status-initial-error",
  "system-status-stale-error",
  "system-status-stale-success",
];
assert.deepEqual(
  results.map(({ name }) => name),
  expectedScenarios,
  "UI validation scenarios must be complete and ordered",
);
for (const result of results) {
  assert.deepEqual(result.consoleErrors, [], `${result.name}: console errors`);
  assert.deepEqual(result.httpErrors, [], `${result.name}: HTTP errors`);
  assert.deepEqual(result.pageErrors, [], `${result.name}: page errors`);
  assert.equal(result.horizontalOverflow, false, `${result.name}: overflow`);
  assert.equal(
    result.accessibilityFailures,
    0,
    `${result.name}: accessibility ${result.accessibilityIssues.join(", ")}`,
  );
}

await verifyLiveDashboard({
  baseUrl,
  expectedRuntimeSource: liveService.runtimeSource,
  expectedLiveService: liveService,
});
const validationResults = {
  schemaVersion: 1,
  runId,
  status: "passed",
  liveService,
  scenarios: results.map((result) => ({
    name: result.name,
    status: "passed",
    consoleErrors: result.consoleErrors.length,
    pageErrors: result.pageErrors.length,
    horizontalOverflow: result.horizontalOverflow,
    accessibilityFailures: result.accessibilityFailures,
  })),
  details: results,
};
await writeFile(
  path.join(outputDirectory, "results.json"),
  `${JSON.stringify(validationResults, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);
const receipt = await buildUiArtifactReceipt({
  root: process.cwd(),
  runId,
  liveService,
  completedAt: new Date().toISOString(),
});
artifactReceiptEnvelope = await writeUiArtifactReceipt({
  root: process.cwd(),
  receipt,
});
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify(artifactReceiptEnvelope)}\n`);
