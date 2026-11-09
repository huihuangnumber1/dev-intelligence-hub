import {
  configurationImpactCategories,
  createConfigurationFetch,
  isCurrentConfigurationRequest,
  normalizeConfigurationBinding,
  sameConfigurationBinding,
} from "./configuration-view-support.js";
import {
  createConfirmationDialogOwnership,
  createExternalConfirmationReconciler,
  createInternalConfirmationReconciler,
  createSessionDeferredConfirmationStore,
} from "./confirmation-dialog-support.js";
import { postAttentionDuringFactRefresh } from "./attention-submission.js";
import { internalAttentionDisplay } from "./internal-attention-display.js";
import { maintenanceAttentionMarkup } from "./maintenance-attention.js";
import { summarizeDashboardErrors } from "./status-error-summary.js";
import { bindConfigurationFormController } from "./configuration-form-controller.js";
import {
  configurationDocumentFromForm,
  createConfigurationFormState,
} from "./configuration-form-support.js";
import { renderBrainProviderStatus } from "./brain-provider-status-view.js";
import {
  githubSourceEventUrl,
  githubTargetUrl,
} from "./github-target-link.js";
import { githubItemDetailMarkup } from "./github-item-detail.js";
import { issuePrDetailMarkup, issuePrSummary } from "./issue-pr-status.js";
import { renderConfigurationSettingsSkeleton } from "./settings-view.js";
import { renderSystemStatus } from "./system-status-view.js";
import { announcementDetailMarkup } from "./announcement-markup.js";
import { dingtalkDetailMarkup } from "./dingtalk-detail-markup.js";
import {
  bindManualWorkAssignment,
  createManualWorkAssignmentAttempts,
} from "./manual-work-assignment.js";
import {
  inferTestingProduct,
  normalizeReviewHandoffHistory,
  prLifecycleStatus,
  prLifecycleStageLabel,
  prReviewLifecycleRoute,
  reviewerOwnerRouting,
  testingOwnerRouting,
} from "./review-handoff-routing.js";
import { createWorkflowView } from "./workflow-view.js";
import { createWorkView } from "./work-view.js";
import { createTaskRunsView } from "./task-runs-view.js";
import {
  createPrEmployeeRecoveryIntent,
  isPrEmployeeRecoveryIntentCurrent,
  prEmployeeBlockedActions,
} from "./pr-employee-job-support.js";

const configurationFetch = createConfigurationFetch({ timeoutMs: 45_000 });
const configurationActivationActions = Object.freeze({
  initialize_from_draft: Object.freeze({
    eyebrow: "INITIALIZATION",
    subject: "draft",
    subjectLabel: "初始化草稿",
    initialVersion: true,
  }),
  activate_draft: Object.freeze({
    eyebrow: "ACTIVATION",
    subject: "draft",
    subjectLabel: "激活草稿",
    initialVersion: false,
  }),
  activate_rollback: Object.freeze({
    eyebrow: "ROLLBACK",
    subject: "version",
    subjectLabel: "回滚目标",
    initialVersion: false,
  }),
});

const lanReadOnly = location.hostname !== "127.0.0.1";
const localViews = new Set(["signals", "memory", "configuration"]);
if (lanReadOnly) document.body.classList.add("lan-read-only");
const content = document.querySelector("#content");
const refreshButton = document.querySelector("#refresh-button");
const lastUpdated = document.querySelector("#last-updated");
const sourceHealth = document.querySelector("#source-health");
const statusBanner = document.querySelector("#status-banner");
const dialog = document.querySelector("#detail-dialog");
const dialogContent = document.querySelector("#dialog-content");
const detailCloseButton = dialog.querySelector(".dialog-close");
const confirmationDialog = document.querySelector("#confirmation-dialog");
const confirmationContent = document.querySelector("#confirmation-content");
const confirmationCloseButton = confirmationDialog.querySelector(
  ".confirmation-close",
);
const confirmationDialogOwnership = createConfirmationDialogOwnership();
const pageTitle = document.querySelector("#page-title");
const taskRunsView = createTaskRunsView({
  container: document.querySelector("#task-runs"),
  dialog: document.querySelector("#task-run-dialog"),
  embedded: true,
});

let dashboard = null;
let employeeRoles = [];
let employeeRolesLoaded = false;
let employeeRolesError = "";
let employeeRolesRequestSequence = 0;
let lastAppliedEmployeeRolesRequest = 0;
let employeeRolesAbortController = null;
let maintenanceAttention = { items: [], total: 0, loaded: false, error: "" };
let maintenanceRequestSequence = 0;
let maintenanceReadInFlight = null;
const manualWorkAssignmentAttempts = createManualWorkAssignmentAttempts();
let currentView = "overview";
let itemIndex = new Map();
let jobIndex = new Map();
let memoryResults = [];
let memoryFilters = {
  query: "",
  roleId: "",
  repository: "",
  eventType: "",
  from: "",
  to: "",
};
let memoryNextCursor = null;
let memoryTotalMatched = 0;
let memoryIndexHealthy = true;
let memoryLoaded = false;
let memorySearchRequestSequence = 0;
let lastAppliedMemorySearchRequest = 0;
let memorySearchAbortController = null;
let memoryQuestion = "";
let memoryAnswerResult = null;
let memoryAnswerPending = false;
let memoryAnswerRequestSequence = 0;
let lastAppliedMemoryAnswerRequest = 0;
let memoryAnswerAbortController = null;
let requestSequence = 0;
let lastAppliedRequest = 0;
let confirmationRequestSequence = 0;
let lastAppliedConfirmationRequest = 0;
let deferredConfirmationRestore = null;
let confirmationQueueState = {
  available: false,
  source: null,
  externalEnabled: false,
  queueRevision: 0,
  pendingCount: 0,
  item: null,
};
let confirmationQueueLoaded = false;
const CONFIRMATION_HISTORY_PAGE_SIZE = 20;
const CONFIRMATION_HISTORY_ROLE_FACET_LIMIT = 64;
const confirmationHistoryStatuses = Object.freeze([
  ["", "全部状态"],
  ["completed", "已完成"],
  ["failed", "执行失败"],
  ["rejected", "已拒绝"],
  ["stale", "已失效"],
]);
const confirmationHistoryKinds = Object.freeze([
  ["", "全部类型"],
  ["github.pull-request-comment", "GitHub PR 评论"],
  ["github.work-proposal-review", "GitHub PR Review"],
  ["github.pull-request-update-branch", "GitHub PR 分支更新"],
  ["github.pull-request-push", "GitHub PR 受控推送"],
  ["github.pull-request-merge", "GitHub PR 合并"],
  ["github.pull-request-review", "GitHub PR Review（旧队列）"],
  ["local.code-job-create", "本地代码任务"],
  ["local.change-package-apply", "本地变更包应用"],
  ["local.configuration-activate", "本地配置切换"],
]);
const pullRequestConfirmationActionTypes = Object.freeze({
  "github.pull-request-comment": "pull_request_comment",
  "github.work-proposal-review": "pull_request_review",
  "github.pull-request-update-branch": "pull_request_update_branch",
  "github.pull-request-push": "pull_request_push",
  "github.pull-request-merge": "pull_request_merge",
  "github.pull-request-review": "pull_request_review",
});
let confirmationHistoryFilters = { status: "", kind: "", roleId: "" };
let confirmationHistoryItems = [];
let confirmationHistoryRoleIdFacets = [];
let confirmationHistoryNextCursor = null;
let confirmationHistoryAvailable = false;
let confirmationHistoryLoaded = false;
let confirmationHistoryLoading = false;
let confirmationHistoryError = "";
let confirmationHistoryQueueRevision = null;
let confirmationHistoryRequestSequence = 0;
let lastAppliedConfirmationHistoryRequest = 0;
let confirmationHistoryAbortController = null;
let activeExternalConfirmation = null;
let activeInternalAttention = null;
let activeConfirmationKey = "";
let codeJobDetailFocusIntent = null;
let configurationState = null;
let configurationLoadError = "";
let configurationRequestSequence = 0;
let lastAppliedConfigurationRequest = 0;
let configurationAbortController = null;
let configurationFormState = null;
let configurationEditorDirty = false;
let configurationEditorStale = false;
let configurationEditorBinding = null;
let configurationEditorError = "";
let configurationOperationError = "";
let configurationPreview = null;
let configurationOperationPending = false;
let configurationNotice = "";
let configurationAutoSelected = false;
let brainProviderStatusState = null;
let brainProviderStatusError = "";
let brainProviderStatusLoading = false;
let brainProviderStatusRequestSequence = 0;
let lastAppliedBrainProviderStatusRequest = 0;
let brainProviderStatusAbortController = null;
let systemStatusState = null;
let systemStatusError = "";
let systemStatusLoading = false;
let systemStatusOperationPending = false;
let systemStatusNotice = "";
let systemStatusRequestSequence = 0;
let lastAppliedSystemStatusRequest = 0;
let systemStatusAbortController = null;
const MAX_DEFERRED_CONFIRMATIONS = 32;
const deferredConfirmationStore = createSessionDeferredConfirmationStore({
  getStorage: () => window.sessionStorage,
  storageKey: "mydashboard.deferred-confirmations.v1",
});
const deferredConfirmations = new Set(deferredConfirmationStore.load());

function rememberDeferredConfirmation(key) {
  if (!key) return;
  deferredConfirmations.delete(key);
  deferredConfirmations.add(key);
  while (deferredConfirmations.size > MAX_DEFERRED_CONFIRMATIONS) {
    deferredConfirmations.delete(deferredConfirmations.values().next().value);
  }
  deferredConfirmationStore.save(deferredConfirmations);
}

function attentionNextUrl() {
  const params = new URLSearchParams();
  for (const key of deferredConfirmations) {
    const [source, id, digest, extra] = key.split("\u0000");
    if (
      extra !== undefined ||
      !["external", "internal"].includes(source) ||
      !id ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      continue;
    }
    params.append("deferred", `${source}:${id}:${digest}`);
  }
  const query = params.toString();
  return `/api/attention/next${query ? `?${query}` : ""}`;
}

const viewTitles = {
  workbench: "任务工作台",
  overview: "今天需要你推动什么",
  prs: "Pull Requests",
  issues: "分配给我的 Issues",
  versions: "版本与里程碑",
  signals: "钉钉中的行动信号",
  employees: "你的数字员工",
  memory: "搜索做过的事情",
  workflow: "工作流指挥",
  work: "主动工作台账",
  "automation-tests": "自动化测试库",
  configuration: "配置中心",
  system: "系统状态与恢复",
};
const CONFIGURATION_BACKED_VIEWS = Object.freeze([
  "automation-tests",
  "configuration",
]);

function isConfigurationBackedView(view = currentView) {
  return CONFIGURATION_BACKED_VIEWS.includes(view);
}

const workflowView = createWorkflowView({
  requestIdFactory: lanReadOnly ? () => "lan-read-only" : undefined,
  onChange() {
    if (dashboard && currentView === "workflow") render();
  },
});

const workView = createWorkView({
  requestIdFactory: lanReadOnly ? () => "lan-read-only" : undefined,
  onChange() {
    if (dashboard && currentView === "work") render();
  },
  onDetail(markup) {
    showCodeJobDetail(markup);
  },
  onDetailClose() {
    codeJobDetailFocusIntent = null;
    if (dialog.open) dialog.close();
  },
  onNotice(message) {
    statusBanner.hidden = false;
    statusBanner.textContent = message;
  },
  async onApplyRequested() {
    codeJobDetailFocusIntent = null;
    if (dialog.open) dialog.close();
    try {
      await refreshConfirmationQueue({ showConfirmation: false });
    } catch (error) {
      statusBanner.hidden = false;
      statusBanner.textContent = `${error.message}。页面会自动重试读取确认队列。`;
    }
    queueMicrotask(showNextConfirmation);
  },
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function relativeTime(value) {
  if (!value) return "未知时间";
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (Math.abs(seconds) < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function kindLabel(item) {
  return {
    pull_request: "PR",
    issue: "ISSUE",
    mention: "@ME",
    todo: "TODO",
    conversation: "CHAT",
    announcement: "NOTICE",
    message: "TODAY",
    mail: "邮件",
  }[item.kind] || item.kind.toUpperCase();
}

function actionStateLabel(value) {
  return {
    action_now: "现在轮到我",
    waiting_other: "等待别人",
    historical: "历史清理",
    uncertain: "需要确认",
  }[value] || value;
}

function nextActorLabel(value) {
  return {
    me: "我",
    author: "PR 作者",
    reviewer: "审核人",
    merge_owner: "合并负责人",
    ci: "自动检查",
    none: "无需行动",
    other: "其他人",
    unknown: "待确认",
  }[value] || value;
}

function employeeStateLabel(value) {
  return {
    disabled: "未启用",
    paused: "已暂停",
    observing: "已启用",
    working: "正在工作",
    waiting_user: "等待你确认",
    degraded: "部分能力异常",
  }[value] || value || "未知";
}

function jobStateLabel(value) {
  return {
    queued: "等待处理",
    running: "分析中",
    retry_wait: "等待重试",
    ready: "方案已就绪",
    ready_for_human: "等待你确认",
    confirmation_enqueue_pending: "正在加入确认队列",
    confirmation_invalidation_pending: "正在安全失效旧确认",
    waiting_confirmation: "等待发布确认",
    waiting_retry_confirmation: "等待重试确认",
    published: "已发布",
    accepted: "你已接受",
    rejected: "你已驳回",
    blocked: "处理受阻",
    dismissed: "已关闭",
    superseded: "已被新状态替代",
  }[value] || value || "未知";
}

function reviewVerdictLabel(value) {
  return {
    approve: "建议通过",
    comment: "建议评论",
    request_changes: "建议修改",
    none: "内部推进方案",
  }[value] || value || "未形成结论";
}

function uniqueItems(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function pullRequestGroups() {
  const groups = dashboard.groups || {};
  const legacy = uniqueItems([
    ...(groups.reviewRequested || []),
    ...(groups.myPullRequests || []),
  ]);
  return {
    actionNow:
      groups.actionNow ||
      legacy.filter((item) => !item.actionState && item.score >= 80),
    waitingOther:
      groups.waitingOther ||
      legacy.filter((item) => !item.actionState && item.score < 80),
    uncertain: groups.uncertainPullRequests || [],
    historical: groups.historicalPullRequests || [],
  };
}

function workItem(item) {
  itemIndex.set(item.id, item);
  let priorityClass = "";
  if (item.score >= 90) priorityClass = "urgent";
  else if (item.score >= 80) priorityClass = "attention";

  const reason = item.reasons?.[0] || "持续跟踪";
  let reasonClass = "";
  if (/失败|逾期|冲突|修改/.test(reason)) reasonClass = "danger";
  else if (item.actionState === "waiting_other") reasonClass = "waiting";
  else if (item.actionState === "historical") reasonClass = "historical";
  else if (item.actionState === "uncertain") reasonClass = "uncertain";
  const source = item.repo
    ? `${escapeHtml(item.repo)} #${item.number}`
    : escapeHtml(item.context || kindLabel(item));
  const issueProgress = issuePrSummary(item);
  return `
    <button class="work-item" data-item-id="${escapeHtml(item.id)}">
      <span class="priority ${priorityClass}">${item.score ?? "—"}</span>
      <span class="item-copy">
        <span class="item-title">${escapeHtml(item.title)}</span>
        <span class="item-meta">
          <span>${kindLabel(item)}</span>
          <span>${source}</span>
          <span>${relativeTime(item.updatedAt)}</span>
        </span>
        ${issueProgress ? `<span class="item-progress">${escapeHtml(issueProgress.label)} · 关闭判断：${escapeHtml(issueProgress.closeAdvice)}</span>` : ""}
      </span>
      <span class="reason ${reasonClass}">${escapeHtml(reason)}</span>
    </button>`;
}

function section(title, items, emptyText, caption = "") {
  return `
    <section class="section">
      <div class="section-heading">
        <h2>${escapeHtml(title)}</h2>
        <span>${caption || `${items.length} ITEMS`}</span>
      </div>
      ${
        items.length
          ? `<div class="work-list">${items.map(workItem).join("")}</div>`
          : `<div class="empty">${escapeHtml(emptyText)}</div>`
      }
    </section>`;
}

function dingtalkReportView() {
  const report = dashboard.dingtalkReport;
  if (!report) {
    return `
      <section class="section">
        <div class="section-heading">
          <h2>定时工作汇报</h2>
          <span>09:00–20:00</span>
        </div>
        <div class="empty">首份每日总览将在 09:00 生成，之后于 12:00、15:00、18:00 和 20:00 更新。</div>
      </section>`;
  }
  const status = report.status === "sent"
    ? "已发送"
    : report.status === "failed"
      ? "发送失败"
      : "发送中";
  const highlights = (report.highlights || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `
    <section class="section">
      <div class="section-heading">
        <h2>定时工作汇报</h2>
        <span>${escapeHtml(report.time || "")} · ${escapeHtml(status)}</span>
      </div>
      <article class="dingtalk-report-card ${report.status === "failed" ? "is-failed" : ""}">
        <p class="eyebrow">${escapeHtml(report.kind === "daily_overview" ? "DAILY OVERVIEW" : report.kind === "daily_close" ? "DAILY CLOSE" : "PROGRESS REPORT")}</p>
        <h3>${escapeHtml(report.title)}</h3>
        <p>${escapeHtml(report.summary)}</p>
        ${highlights ? `<ul>${highlights}</ul>` : ""}
        ${report.error ? `<p class="dingtalk-report-error">${escapeHtml(report.error)}</p>` : ""}
      </article>
    </section>`;
}

function metrics(counts) {
  return `
    <section class="metrics" aria-label="工作量概览">
      <div class="metric"><strong>${counts.actionNow ?? counts.urgent}</strong><span>现在轮到你</span></div>
      <div class="metric"><strong>${counts.waitingOther ?? 0}</strong><span>等待别人</span></div>
      <div class="metric"><strong>${counts.uncertainPullRequests ?? 0}</strong><span>需要你确认</span></div>
      <div class="metric"><strong>${counts.issues}</strong><span>分配给你的 Issues</span></div>
    </section>`;
}

function employeeJob(job) {
  jobIndex.set(job.id, job);
  const summary = job.status === "superseded"
    ? "历史快照：后续 PR 状态已替代这次判断"
    : job.summary || job.triggerReason || job.error || "等待员工处理";
  return `
    <button class="employee-job" data-job-id="${escapeHtml(job.id)}">
      <span class="employee-job-main">
        <strong>${escapeHtml(job.repo || "未知仓库")} #${escapeHtml(job.number ?? "?")} · ${escapeHtml(job.title || "未命名 PR")}</strong>
        <span>${escapeHtml(summary)}</span>
      </span>
      <span class="status-pill status-${escapeHtml(job.status)}">${escapeHtml(jobStateLabel(job.status))}</span>
    </button>`;
}

const historicalPrJobStatuses = new Set([
  "published",
  "accepted",
  "rejected",
  "dismissed",
  "superseded",
]);

function employeePanel({ expanded = false } = {}) {
  const employee = dashboard.employee;
  if (!employee?.role) {
    return `<section class="section employee-panel">
      <div class="section-heading"><h2>PR 推进员工</h2><span>尚未连接</span></div>
      <div class="empty">服务重启后将加载主动员工。</div>
    </section>`;
  }
  const { role } = employee;
  const currentJobs = employee.jobs.filter(
    (job) => !historicalPrJobStatuses.has(job.status),
  );
  const historicalJobs = employee.jobs.filter((job) =>
    historicalPrJobStatuses.has(job.status),
  );
  const activeJob = currentJobs.find((job) => job.status === "running");
  const recentJobs = expanded ? currentJobs : currentJobs.slice(0, 3);
  const brain = role.brain?.provider
    ? `${role.brain.provider} / ${role.brain.model || "默认模型"}${role.brain.remoteCodeContext ? " · 代码上下文将发送到远程服务" : ""}`
    : "未配置大脑";
  const lastRun = role.lastRun;
  const activity = activeJob
    ? `正在初判 ${activeJob.repo} #${activeJob.number}：${activeJob.triggerReason}`
    : lastRun?.summary || "等待第一次主动巡查";
  const pendingConfirmationCount = employee.confirmationQueue?.length || 0;
  return `
    <section class="section employee-panel" aria-labelledby="pr-employee-title">
      <div class="employee-heading">
        <div>
          <p class="eyebrow">DIGITAL EMPLOYEE / PR</p>
          <h2 id="pr-employee-title">${escapeHtml(role.name)}</h2>
        </div>
        <span class="status-pill status-${escapeHtml(role.state)}">${escapeHtml(employeeStateLabel(role.state))}</span>
      </div>
      <p class="employee-mission">${escapeHtml(role.mission)}</p>
      <dl class="employee-summary">
        <div><dt>为什么启动</dt><dd>${escapeHtml(lastRun?.trigger || "等待事件")}${lastRun?.at ? ` · ${relativeTime(lastRun.at)}` : ""}</dd></div>
        <div><dt>正在做什么</dt><dd>${escapeHtml(activity)}</dd></div>
        <div><dt>当前大脑</dt><dd>${escapeHtml(brain)}</dd></div>
        <div><dt>岗位边界</dt><dd>只做发现、初判和分流；代码 Review 交给 PR 工程师</dd></div>
      </dl>
      ${role.lastError ? `<p class="employee-error">${escapeHtml(role.lastError)}</p>` : ""}
      <div class="employee-actions">
        <button class="refresh-button" data-employee-run ${role.paused ? "disabled" : ""}>立即巡查</button>
        ${pendingConfirmationCount > 0 ? `<button class="secondary-button" data-role-confirmations>处理待确认（${pendingConfirmationCount}）</button>` : ""}
        <button class="secondary-button" data-employee-control="${role.paused ? "resume" : "pause"}">${role.paused ? "恢复员工" : "暂停员工"}</button>
      </div>
      ${
        recentJobs.length
          ? `<div class="employee-jobs">${recentJobs.map(employeeJob).join("")}</div>`
          : `<div class="empty">当前没有需要推进的 PR 作业。</div>`
      }
      ${expanded && historicalJobs.length
        ? `<details class="employee-job-history"><summary>历史作业（${historicalJobs.length}）</summary><div class="employee-jobs">${historicalJobs.map(employeeJob).join("")}</div></details>`
        : ""}
    </section>`;
}

function assignedBrainLabel(brain, missingLabel) {
  if (!brain?.provider) return missingLabel;
  const location = brain.remote === true ? "第三方" : "本地";
  return `${brain.provider} / ${brain.model || "默认模型"} · ${location}`;
}

function roleBrainLabel(role) {
  return assignedBrainLabel(role?.brain, "未配置日常大脑");
}

function roleTaskBrainLabel(role) {
  return assignedBrainLabel(
    role?.taskBrain,
    "未配置（高风险任务将等待）",
  );
}

function roleWorkloadStatusLabel(status) {
  return {
    queued: "待领取",
    working: "处理中",
    dispatch_pending: "等待派发",
    waiting_user: "等待答复",
    waiting_condition: "等待条件",
    waiting_external: "等待授权",
    retry_wait: "等待重试",
    blocked: "已阻塞",
  }[status] || status || "未知";
}

function reviewWorkStage(status) {
  return {
    queued: { step: "第 1/5 步", label: "已分配，等待领取", owner: "PR 工程师" },
    working: { step: "第 2/5 步", label: "正在审查当前 Head", owner: "PR 工程师" },
    dispatch_pending: { step: "第 3/5 步", label: "正在生成 Review 建议", owner: "系统" },
    waiting_user: { step: "第 4/5 步", label: "等待你补充判断", owner: "你" },
    waiting_condition: { step: "第 4/5 步", label: "等待检查或外部条件", owner: "条件满足后由 PR 工程师继续" },
    waiting_external: { step: "第 4/5 步", label: "Review 建议已生成，等待你确认发布", owner: "你" },
    retry_wait: { step: "第 3/5 步", label: "审查暂未完成，等待自动重试", owner: "PR 工程师" },
    blocked: { step: "链路受阻", label: "需要处理阻塞原因后继续", owner: "你或任务负责人" },
    completed: { step: "第 5/5 步", label: "Review 已发布或任务已完成", owner: "下一棒岗位 / 合并负责人" },
  }[status] || { step: "状态未知", label: roleWorkloadStatusLabel(status), owner: "待系统确认" };
}

function roleWorkloadTask(task, roleId) {
  const subject = task?.subject;
  const sourceUrl = githubTargetUrl({
    resourceType: subject?.kind,
    resourceId: `${subject?.repository || ""}#${subject?.number || ""}`,
  });
  const title = escapeHtml(task?.title || "未命名任务");
  const titleMarkup = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span>${title}</span>`;
  const isReviewRole = ["pr-engineer", "pr-reviewer"].includes(roleId);
  const stage = isReviewRole ? reviewWorkStage(task?.status) : null;
  return `<li>
    <span class="status-pill status-${escapeHtml(task?.status || "unknown")}">${escapeHtml(roleWorkloadStatusLabel(task?.status))}</span>
    <div class="employee-role-task-copy">
      ${titleMarkup}
      ${stage ? `<small><strong>${escapeHtml(stage.step)}</strong> · ${escapeHtml(stage.label)} · 下一责任人：${escapeHtml(stage.owner)}</small>` : ""}
      ${task?.statusReason ? `<small class="employee-role-task-diagnostic">台账原因：${escapeHtml(task.statusReason)}</small>` : ""}
    </div>
  </li>`;
}

function roleWorkloadMarkup(role) {
  const workload = role.workload || {};
  if (workload.available === false) {
    return `<section class="employee-role-workload" aria-label="当前任务">
      <div class="employee-role-workload-heading"><strong>当前任务</strong></div>
      <p class="employee-role-task-empty">工作台账未启用，暂时无法判断该岗位是否有任务</p>
    </section>`;
  }
  const counts = workload.counts || {};
  const tasks = Array.isArray(workload.tasks) ? workload.tasks.slice(0, 3) : [];
  return `<section class="employee-role-workload" aria-label="当前任务">
    <div class="employee-role-workload-heading">
      <strong>当前任务</strong>
      <span class="employee-role-workload-actions">
        ${["pr-engineer", "pr-reviewer"].includes(role.id) && Number(counts.waiting) > 0 ? '<button type="button" class="secondary-button" data-role-confirmations>处理确认队列</button>' : ""}
        <button type="button" class="secondary-button" data-role-work="${escapeHtml(role.id)}">查看该岗位任务</button>
      </span>
    </div>
    <dl class="employee-role-workload-counts">
      <div><dt>待领取</dt><dd>${Number(counts.queued) || 0}</dd></div>
      <div><dt>处理中</dt><dd>${Number(counts.working) || 0}</dd></div>
      <div><dt>等待</dt><dd>${Number(counts.waiting) || 0}</dd></div>
      <div><dt>阻塞</dt><dd>${Number(counts.blocked) || 0}</dd></div>
    </dl>
    ${tasks.length
      ? `<ul class="employee-role-task-list">${tasks.map((task) => roleWorkloadTask(task, role.id)).join("")}</ul>`
      : '<p class="employee-role-task-empty">当前没有进行中的任务</p>'}
  </section>`;
}

function employeeRoleCard(role) {
  const lastRun = role.lastRun;
  const permissions = role.permissions?.allowedIntents || [];
  return `<article class="employee-role-card">
    <div class="employee-role-card-heading">
      <div><p class="eyebrow">${escapeHtml(role.id)}</p><h3>${escapeHtml(role.name)}</h3></div>
      <span class="status-pill status-${escapeHtml(role.state)}">${escapeHtml(employeeStateLabel(role.state))}</span>
    </div>
    <p>${escapeHtml(role.mission || "尚未配置岗位使命")}</p>
    ${roleWorkloadMarkup(role)}
    <dl class="employee-role-meta">
      <div><dt>日常大脑</dt><dd>${escapeHtml(roleBrainLabel(role))}</dd></div>
      <div><dt>任务大脑</dt><dd>${escapeHtml(roleTaskBrainLabel(role))}</dd></div>
      <div><dt>最近行动</dt><dd>${lastRun?.at ? `${relativeTime(lastRun.at)} · ${escapeHtml(lastRun.trigger || "主动循环")}` : "尚未运行"}</dd></div>
      ${lastRun?.summary ? `<div><dt>运行结果</dt><dd>${escapeHtml(lastRun.summary)}</dd></div>` : ""}
      <div><dt>权限</dt><dd>${escapeHtml(permissions.length ? permissions.join(" · ") : "岗位专用能力")}</dd></div>
    </dl>
    ${role.lastError || role.lastErrorCode ? `<p class="employee-error">${escapeHtml(role.lastError || role.lastErrorCode)}</p>` : ""}
    <div class="employee-actions">
      <button class="refresh-button" data-role-run="${escapeHtml(role.id)}" ${role.paused || !role.enabled ? "disabled" : ""}>立即运行</button>
      <button class="secondary-button" data-role-control="${role.paused ? "resume" : "pause"}" data-role-id="${escapeHtml(role.id)}" data-role-revision="${escapeHtml(role.revision)}" ${!role.enabled ? "disabled" : ""}>${role.paused ? "恢复岗位" : "暂停岗位"}</button>
    </div>
  </article>`;
}

function confirmationHistoryStatusLabel(status) {
  return new Map(confirmationHistoryStatuses).get(status) || status || "未知";
}

function confirmationHistoryKindLabel(kind) {
  return new Map(confirmationHistoryKinds).get(kind) || kind || "未知类型";
}

function confirmationHistoryOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function validConfirmationHistoryRoleId(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value)
  );
}

function compareConfirmationHistoryRoleIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function confirmationHistoryRoleIds() {
  const roleIds = new Set(
    employeeRoles
      .map((role) => role?.id)
      .filter((roleId) => typeof roleId === "string" && roleId),
  );
  for (const roleId of confirmationHistoryRoleIdFacets) roleIds.add(roleId);
  for (const item of confirmationHistoryItems) {
    const roleId = item?.requestedBy?.roleId;
    if (typeof roleId === "string" && roleId) roleIds.add(roleId);
  }
  if (confirmationHistoryFilters.roleId) {
    roleIds.add(confirmationHistoryFilters.roleId);
  }
  return [...roleIds].sort(compareConfirmationHistoryRoleIds);
}

function confirmationPendingMarkup() {
  if (!confirmationQueueLoaded) {
    return '<div class="empty">正在读取下一项确认…</div>';
  }
  const [entry] = pendingConfirmations();
  const managed = confirmationQueueState.systemManagedCount || 0;
  const automaticStatus = managed > 0
    ? `<p class="confirmation-note">系统正在自动处理 ${managed} 项 Review，无需你确认。进展可在岗位任务和确认历史查看。</p>` : "";
  if (!entry) {
    return automaticStatus || '<div class="empty">当前没有需要你处理的确认。</div>';
  }
  const item = entry.item || entry.job;
  const title = item.display?.title || item.title || "待确认事项";
  const summary = item.display?.summary || item.summary || "等待你逐项判断";
  const roleId = item.requestedBy?.roleId || item.producer?.roleId || "未标注岗位";
  const pendingCount = Number.isInteger(confirmationQueueState.pendingCount)
    ? Math.max(confirmationQueueState.pendingCount, pendingConfirmations().length)
    : pendingConfirmations().length;
  const source = item.resolutionRequired === true
    ? "结果未知待封存"
    : entry.kind === "internal_request"
      ? "员工咨询"
      : entry.kind === "review_draft"
        ? "本地 Review 草稿"
      : "动作授权";
  const destination = entry.kind === "internal_request"
    ? `提交答复后，结果写入本地台账，原任务重新排队给 ${roleId} 继续处理；驳回后原任务转为阻塞。两者都可在“主动工作台账”追踪；选择“稍后”仍保留在待确认队列。`
    : entry.kind === "review_draft"
      ? "接受或驳回只处理这份本地 Review 草稿，不会直接写入 GitHub；如果存在受控发布动作，它会作为另一项授权单独确认。"
    : "确认或驳回后，结果会进入下方“只读确认历史”；选择“稍后”仍保留在待确认队列。";
  return `${automaticStatus}<article class="confirmation-pending-item">
    <div class="confirmation-history-row-heading">
      <strong>${escapeHtml(title)}</strong>
      <span class="status-pill status-waiting_user">下一项</span>
    </div>
    <p>${escapeHtml(summary)}</p>
    <small>${escapeHtml(source)} · ${escapeHtml(roleId)} · 当前还剩 ${pendingCount} 项（含当前项）</small>
    <p><strong>处理去向：</strong>${escapeHtml(destination)}</p>
    <button type="button" class="refresh-button" data-role-confirmations>处理下一项确认</button>
  </article>`;
}

function deferredConfirmationMarkup() {
  const restore = deferredConfirmationRestore;
  const count = restore ? restore.deferred.length : deferredConfirmations.size;
  if (count === 0) return "";
  return `<div class="confirmation-deferred-controls">
    <button class="secondary-button" id="confirmation-deferred-restore" type="button" ${restore ? 'disabled aria-busy="true"' : ""}>${restore ? `正在重新查看稍后项（${count}）…` : `重新查看稍后项（${count}）`}</button>
    <small>仅恢复本页会话中选择“稍后”的事项，不会批准或执行任何动作。</small>
  </div>`;
}

function confirmationHistoryItemMarkup(item) {
  const roleId = item.requestedBy?.roleId || "未标注岗位";
  const workItemId = item.requestedBy?.workItemId || "未标注工作项";
  return `<article class="confirmation-history-item">
    <div class="confirmation-history-row-heading">
      <strong>${escapeHtml(item.title || "未命名确认")}</strong>
      <span class="status-pill status-${escapeHtml(item.status)}">${escapeHtml(confirmationHistoryStatusLabel(item.status))}</span>
    </div>
    <p>${escapeHtml(item.summary || "")}</p>
    ${item.automaticReview ? `<p><strong>自动 Review · ${escapeHtml({ APPROVE: "通过", REQUEST_CHANGES: "需修改", COMMENT: "评论" }[item.automaticReview.event] || "待核对")}</strong> · Head ${escapeHtml(item.automaticReview.headRefOid.slice(0, 8))} · <a href="${escapeHtml(item.automaticReview.url)}" target="_blank" rel="noreferrer">在 GitHub 查看</a></p>` : ""}
    ${item.automaticOwnPrRepair ? `<p><strong>自动修复我的 PR · ${item.automaticOwnPrRepair.stage === "push" ? "更新原 PR" : "创建开发任务"}</strong></p>` : ""}
    <small>${escapeHtml(confirmationHistoryKindLabel(item.kind))} · ${escapeHtml(roleId)} · ${escapeHtml(workItemId)} · ${escapeHtml(relativeTime(item.updatedAt))}${item.retryable ? " · 可再次逐项确认" : ""}</small>
    ${item.diagnosticCode ? `<code class="confirmation-history-diagnostic">诊断：${escapeHtml(item.diagnosticCode)}</code>` : ""}
    ${item.ownerDecision?.type === "seal_unknown_and_forbid_replay" ? '<small class="confirmation-history-resolution">已承认结果未知并封存（禁止重放）</small>' : ""}
    ${item.reviewHandoff ? `<small class="confirmation-history-resolution">${escapeHtml(reviewHandoffStatusText(item))}</small>` : ""}
  </article>`;
}

function confirmationHistoryMarkup() {
  if (!confirmationHistoryLoaded && confirmationHistoryLoading) {
    return '<div class="empty">正在读取确认历史…</div>';
  }
  if (!confirmationHistoryLoaded) {
    return '<div class="empty">确认历史尚未读取。</div>';
  }
  if (confirmationHistoryError && !confirmationHistoryItems.length) {
    return '<div class="empty">本次未能读取匹配的确认历史，请稍后重试。</div>';
  }
  if (!confirmationHistoryAvailable) {
    return '<div class="empty">确认历史读取能力未启用。</div>';
  }
  if (!confirmationHistoryItems.length) {
    return '<div class="empty">当前筛选条件下没有确认历史。</div>';
  }
  return `<div class="confirmation-history-list">${confirmationHistoryItems
    .map(confirmationHistoryItemMarkup)
    .join("")}</div>`;
}

function confirmationHistoryRoleOptionsMarkup() {
  return [
    confirmationHistoryOption("", "全部岗位", confirmationHistoryFilters.roleId),
    ...confirmationHistoryRoleIds().map((roleId) =>
      confirmationHistoryOption(
        roleId,
        roleId,
        confirmationHistoryFilters.roleId,
      ),
    ),
  ].join("");
}

function confirmationHistoryMetaText() {
  return confirmationHistoryLoaded
    ? `${confirmationHistoryItems.length} RECORDS · 最新创建在前`
    : "READ ONLY";
}

function confirmationHistoryPaginationVisible() {
  return Boolean(confirmationHistoryNextCursor) ||
    confirmationHistoryItems.length > CONFIRMATION_HISTORY_PAGE_SIZE;
}

function confirmationHistoryPaginationLabel() {
  if (confirmationHistoryLoading) return "正在加载更早记录…";
  return confirmationHistoryNextCursor ? "加载更早记录" : "已加载全部记录";
}

function confirmationCenterView() {
  const statusOptions = confirmationHistoryStatuses
    .map(([value, label]) =>
      confirmationHistoryOption(value, label, confirmationHistoryFilters.status),
    )
    .join("");
  const kindOptions = confirmationHistoryKinds
    .map(([value, label]) =>
      confirmationHistoryOption(value, label, confirmationHistoryFilters.kind),
    )
    .join("");
  const roleOptions = confirmationHistoryRoleOptionsMarkup();
  const historyMeta = confirmationHistoryMetaText();
  const paginationVisible = confirmationHistoryPaginationVisible();
  const pendingCount = Number.isInteger(confirmationQueueState.pendingCount)
    ? confirmationQueueState.pendingCount
    : 0;
  const pendingCountLabel = pendingCount > 0
    ? `还剩 ${pendingCount} 项（含当前项）`
    : "当前 0 项";
  return `<section class="section confirmation-center" aria-labelledby="confirmation-center-title">
    <div class="section-heading">
      <h2 id="confirmation-center-title">确认中心</h2>
      <span>自动 Review 可在历史记录中追踪；其他授权与咨询逐项处理</span>
    </div>
    <div class="confirmation-center-grid">
      <section class="confirmation-center-panel" id="confirmation-pending-panel" aria-labelledby="confirmation-pending-title">
        <div class="confirmation-center-panel-heading">
          <div><p class="eyebrow">PENDING</p><h3 id="confirmation-pending-title">待你逐项确认</h3></div>
          <span>${pendingCountLabel}</span>
        </div>
        ${confirmationPendingMarkup()}
        ${deferredConfirmationMarkup()}
        <p class="confirmation-center-note">系统仍按现有优先级逐条弹框确认；此处只显示下一项，不在列表中授权。</p>
      </section>
      <section class="confirmation-center-panel" id="confirmation-history-panel" aria-labelledby="confirmation-history-title" aria-busy="${confirmationHistoryLoading}">
        <div class="confirmation-center-panel-heading">
          <div><p class="eyebrow">HISTORY</p><h3 id="confirmation-history-title">只读确认历史</h3></div>
          <span id="confirmation-history-meta">${escapeHtml(historyMeta)}</span>
        </div>
        <form class="confirmation-history-filter" id="confirmation-history-filter">
          <label for="confirmation-history-status">状态<select id="confirmation-history-status" name="status">${statusOptions}</select></label>
          <label for="confirmation-history-kind">类型<select id="confirmation-history-kind" name="kind">${kindOptions}</select></label>
          <label for="confirmation-history-role">岗位<select id="confirmation-history-role" name="roleId">${roleOptions}</select></label>
          <label for="confirmation-history-automatic">记录<select id="confirmation-history-automatic" name="automatic"><option value="">全部记录</option><option value="true" ${confirmationHistoryFilters.automatic ? "selected" : ""}>自动 Review 记录</option></select></label>
          <button class="secondary-button" id="confirmation-history-apply" type="submit">应用筛选</button>
        </form>
        <p class="employee-error" id="confirmation-history-error" role="status" ${confirmationHistoryError ? "" : "hidden"}>${escapeHtml(confirmationHistoryError)}</p>
        <div id="confirmation-history-results" aria-live="polite">${confirmationHistoryMarkup()}</div>
        <div id="confirmation-history-pagination">
          <button class="secondary-button confirmation-history-more" id="confirmation-history-load-more" type="button" aria-disabled="${confirmationHistoryLoading || !confirmationHistoryNextCursor}" ${paginationVisible ? "" : "hidden"}>${escapeHtml(confirmationHistoryPaginationLabel())}</button>
        </div>
      </section>
    </div>
  </section>`;
}

function reviewFlowMarkup() {
  const steps = [
    ["1", "分配", "主控或你把 PR 交给 PR 工程师"],
    ["2", "审查", "PR 工程师读取当前 Head、改动和检查结果"],
    ["3", "形成建议", "生成 Approve、Request changes 或 Comment"],
    ["4", "发布 Review", "开启自动 Review 后，近期 Assign 给你的 PR 自动发布；按自动分配开关执行后续交接"],
    ["5", "交接推进", "按结论交给测试、开发或 PR 岗位；最终由合并负责人决定"],
  ];
  return `<section class="section review-flow-section" aria-labelledby="review-flow-title">
    <div class="section-heading">
      <h2 id="review-flow-title">PR Review 工作方式</h2>
      <span>自动 Review 和后续分配可在配置中心关闭；记录在下方查看</span>
    </div>
    <ol class="review-flow">${steps.map(([number, title, detail]) => `<li><span>${number}</span><div><strong>${title}</strong><small>${detail}</small></div></li>`).join("")}</ol>
  </section>`;
}

function employeesView() {
  if (!employeeRolesLoaded) {
    return '<section class="section"><div class="empty">正在读取岗位编制…</div></section>';
  }
  const loadError = employeeRolesError
    ? `<p class="employee-error">${escapeHtml(employeeRolesError)}。系统会自动重试，其他指挥功能不受影响。</p>`
    : "";
  const roster = employeeRoles.length
    ? `<div class="employee-roster">${employeeRoles.map(employeeRoleCard).join("")}</div>`
    : employeeRolesError
      ? '<div class="empty">暂时无法显示岗位编制。</div>'
      : '<div class="empty">尚未配置数字员工。</div>';
  return `${reviewFlowMarkup()}
    ${confirmationCenterView()}
    ${maintenanceAttentionMarkup(maintenanceAttention)}
    <section class="section">
      <div class="section-heading"><h2>岗位编制</h2><span>${employeeRoles.length} ROLES · 每个岗位可独立配置大脑与权限</span></div>
      ${loadError}
      ${roster}
    </section>
    ${employeePanel({ expanded: true })}`;
}

function memoryString(value) {
  return typeof value === "string" ? value : "";
}

function memoryStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

function memoryContextRecords(result = memoryAnswerResult) {
  return Array.isArray(result?.context?.records)
    ? result.context.records.filter(
        (record) => record && typeof record === "object" && !Array.isArray(record),
      )
    : [];
}

const MEMORY_AUTHORITY_LABELS = Object.freeze({
  raw: "原始记录",
  derived: "派生记录",
});
const MEMORY_LIFECYCLE_LABELS = Object.freeze({
  current: "当前有效",
  obsolete: "已被新事实替代",
});

function memoryRecordLabel(record) {
  const authority =
    MEMORY_AUTHORITY_LABELS[record?.labels?.authority] || "未分类记录";
  const lifecycle =
    MEMORY_LIFECYCLE_LABELS[record?.labels?.lifecycle] || "状态未知";
  return `${authority} · ${lifecycle}`;
}

function memoryCitationLinks(citationIds, recordsById, numberById) {
  return memoryStringArray(citationIds)
    .map((recordId) => {
      const record = recordsById.get(recordId);
      const number = numberById.get(recordId) || "?";
      const title = memoryString(record?.title) || recordId;
      return `<a class="memory-citation-link" data-memory-citation="${escapeHtml(recordId)}" href="#memory-context-${escapeHtml(recordId)}" aria-label="查看引用 ${escapeHtml(number)}：${escapeHtml(title)}">[${escapeHtml(number)}] ${escapeHtml(title)}</a>`;
    })
    .join("");
}

function memoryClaimRows(result, recordsById, numberById) {
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  if (!claims.length) {
    return '<p class="memory-answer-empty">当前上下文不足以形成可验证的回答，请调整搜索条件后重试。</p>';
  }
  return `<ol class="memory-claims">${claims
    .map(
      (claim) => `<li><details class="memory-claim" open>
        <summary>${escapeHtml(memoryString(claim?.statement))}</summary>
        <div class="memory-claim-citations">${memoryCitationLinks(claim?.citationIds, recordsById, numberById)}</div>
        ${claim?.derived === true ? '<span class="memory-derived-label">派生结论</span>' : ""}
      </details></li>`,
    )
    .join("")}</ol>`;
}

function memoryEvidenceMarkup(record) {
  const evidence = memoryStringArray(record?.evidence);
  if (!evidence.length) return '<span class="memory-record-empty">无记录内证据</span>';
  return `<ul>${evidence.map((entry) => `<li><code>${escapeHtml(entry)}</code></li>`).join("")}</ul>`;
}

function memoryContextRecordMarkup(record, index, citedIds) {
  const recordId = memoryString(record?.recordId);
  const sourceKind = memoryString(record?.source?.kind) || "unknown";
  const sourceId = memoryString(record?.source?.id) || "unknown";
  const labels = memoryRecordLabel(record);
  const cited = citedIds.has(recordId);
  return `<details class="memory-context-record" id="memory-context-${escapeHtml(recordId)}" ${cited ? "data-cited=true" : ""}>
    <summary>
      <span><strong>[${index + 1}] ${escapeHtml(memoryString(record?.title) || "未命名记录")}</strong><small>${escapeHtml(labels)}</small></span>
      ${cited ? '<span class="memory-cited-label">回答已引用</span>' : ""}
    </summary>
    <dl class="memory-record-meta">
      <div><dt>recordId</dt><dd><code>${escapeHtml(recordId)}</code></dd></div>
      <div><dt>contentDigest</dt><dd><code>${escapeHtml(memoryString(record?.contentDigest))}</code></dd></div>
      <div><dt>labels</dt><dd><code>${escapeHtml(memoryString(record?.labels?.authority))} / ${escapeHtml(memoryString(record?.labels?.lifecycle))}</code></dd></div>
      <div><dt>source</dt><dd><code>${escapeHtml(sourceKind)}:${escapeHtml(sourceId)}</code></dd></div>
      <div><dt>event</dt><dd>${escapeHtml(memoryString(record?.eventType) || "unknown")}</dd></div>
      <div><dt>time</dt><dd>${escapeHtml(memoryString(record?.occurredAt) || "unknown")}</dd></div>
      <div><dt>role / repository</dt><dd>${escapeHtml(memoryString(record?.roleId) || "未标注岗位")} / ${escapeHtml(memoryString(record?.repository) || "未标注仓库")}</dd></div>
    </dl>
    <div class="memory-record-section"><strong>summary</strong><p>${escapeHtml(memoryString(record?.summary))}</p></div>
    <div class="memory-record-section"><strong>content</strong><pre>${escapeHtml(memoryString(record?.content))}</pre></div>
    <div class="memory-record-section"><strong>evidence</strong>${memoryEvidenceMarkup(record)}</div>
    ${record?.sourceUrl ? `<a class="memory-record-source" href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noreferrer">打开原始来源 →</a>` : ""}
  </details>`;
}

function memoryAnswerView() {
  if (memoryAnswerPending) {
    return '<section class="memory-answer-panel" id="memory-answer-panel" aria-live="polite" aria-busy="true"><div class="empty">正在从可引用的本地记录中形成回答…</div></section>';
  }
  if (!memoryAnswerResult) return "";
  const records = memoryContextRecords();
  const recordsById = new Map(
    records.map((record) => [memoryString(record.recordId), record]),
  );
  const numberById = new Map(
    records.map((record, index) => [memoryString(record.recordId), index + 1]),
  );
  const claims = Array.isArray(memoryAnswerResult.claims)
    ? memoryAnswerResult.claims
    : [];
  const citedIds = new Set(
    claims.flatMap((claim) => memoryStringArray(claim?.citationIds)),
  );
  const brain = memoryAnswerResult.brain || {};
  const providerLocation = brain.remote === true ? "远程模型" : "本地模型";
  const provider = [memoryString(brain.provider), memoryString(brain.model)]
    .filter(Boolean)
    .join(" / ") || "未标注模型";
  const mode = brain.mode === "local" ? "本地重新运行" : "配置模型";
  const contextDigest = memoryString(memoryAnswerResult.context?.contextDigest);
  const contextRecordIds = memoryStringArray(
    memoryAnswerResult.context?.recordIds,
  );
  const canRerunLocally =
    memoryAnswerResult.localRerunAvailable === true &&
    /^[a-f0-9]{64}$/.test(contextDigest) &&
    contextRecordIds.length > 0 &&
    memoryString(memoryAnswerResult.context?.question).length > 0;
  return `<section class="memory-answer-panel" id="memory-answer-panel" aria-live="polite" aria-busy="false">
    <div class="memory-answer-heading">
      <div><p class="eyebrow">CITED MEMORY ANSWER</p><h3>${memoryAnswerResult.status === "answered" ? "有依据的回答" : "证据不足"}</h3></div>
      <span>${memoryAnswerResult.derived === true ? "派生回答" : "检索结论"} · ${escapeHtml(providerLocation)} · ${escapeHtml(provider)} · ${escapeHtml(mode)}</span>
    </div>
    ${memoryAnswerResult.answer ? `<p class="memory-answer-summary">${escapeHtml(memoryString(memoryAnswerResult.answer))}</p>` : ""}
    ${memoryClaimRows(memoryAnswerResult, recordsById, numberById)}
    <div class="memory-context-heading">
      <div><strong>可复现回答上下文</strong><span>${records.length} RECORDS · digest <code>${escapeHtml(contextDigest || "unavailable")}</code></span></div>
      ${canRerunLocally ? '<button class="secondary-button" id="memory-rerun-local" type="button">本地模型重新运行</button>' : ""}
    </div>
    <div class="memory-context-records">${records
      .map((record, index) => memoryContextRecordMarkup(record, index, citedIds))
      .join("")}</div>
  </section>`;
}

function memoryRows() {
  if (!memoryLoaded) return '<div class="empty">正在读取本地记忆…</div>';
  if (!memoryResults.length) {
    return '<div class="empty">没有找到匹配的员工记忆。</div>';
  }
  return `<div class="memory-list">${memoryResults
    .map(
      (memory) => `
        <article class="memory-item">
          <div class="memory-heading">
            <strong>${escapeHtml(memory.title || "未命名记录")}</strong>
            <span>${relativeTime(memory.createdAt)}</span>
          </div>
          <p>${escapeHtml(memory.summary || "")}</p>
          <span>${escapeHtml(memory.roleId || "未标注岗位")} · ${escapeHtml(memory.repository || "未标注仓库")} ${memory.number ? `#${memory.number}` : ""} · ${escapeHtml(memory.event || "observation")}</span>
          ${memory.sourceUrl ? `<a href="${escapeHtml(memory.sourceUrl)}" target="_blank" rel="noreferrer">打开来源 →</a>` : ""}
        </article>`,
    )
    .join("")}</div>`;
}

function memoryView() {
  return `<section class="section memory-section">
    <div class="section-heading"><h2>统一本地记忆</h2><span>${memoryResults.length}/${memoryTotalMatched} RESULTS · ${memoryIndexHealthy ? "本地索引正常" : "本地索引降级"}</span></div>
    <form class="memory-search" id="memory-search-form">
      <label for="memory-query">搜索 PR、仓库、问题或处理结论</label>
      <div class="memory-search-primary"><input id="memory-query" name="query" value="${escapeHtml(memoryFilters.query)}" autocomplete="off" /><button class="refresh-button" type="submit">搜索</button></div>
      <div class="memory-filters">
        <label>岗位<input name="roleId" value="${escapeHtml(memoryFilters.roleId)}" placeholder="例如 developer" autocomplete="off" /></label>
        <label>仓库<input name="repository" value="${escapeHtml(memoryFilters.repository)}" placeholder="owner/repo" autocomplete="off" /></label>
        <label>事件类型<input name="eventType" value="${escapeHtml(memoryFilters.eventType)}" placeholder="例如 work.completed" autocomplete="off" /></label>
        <label>开始日期<input name="from" type="date" value="${escapeHtml(memoryFilters.from)}" /></label>
        <label>结束日期<input name="to" type="date" value="${escapeHtml(memoryFilters.to)}" /></label>
      </div>
    </form>
    <form class="memory-question" id="memory-question-form">
      <label for="memory-question">向本地记忆提问</label>
      <div class="memory-question-primary"><input id="memory-question" name="question" maxlength="4096" value="${escapeHtml(memoryQuestion)}" placeholder="例如：上次结算 PR 为什么没有合入？" autocomplete="off" /><button class="refresh-button" type="submit" ${memoryAnswerPending ? "disabled" : ""}>${memoryAnswerPending ? "回答中…" : "询问记忆"}</button></div>
      <p>回答只使用当前筛选条件检索到的记录；每条结论都必须带有可检查的本地引用。</p>
    </form>
    ${memoryAnswerView()}
    ${memoryRows()}
    ${memoryNextCursor ? '<button class="secondary-button memory-more" id="memory-load-more" type="button">加载更早记录</button>' : ""}
  </section>`;
}

function versionRows(items) {
  if (!items.length) return '<div class="empty">当前跟踪仓库没有开放里程碑或发布记录。</div>';
  return items
    .map((item) => {
      const total = (item.openIssues || 0) + (item.closedIssues || 0);
      const progress = total ? Math.round((item.closedIssues / total) * 100) : 0;
      const date = item.dueAt
        ? `截止 ${new Date(item.dueAt).toLocaleDateString("zh-CN")}`
        : item.publishedAt
          ? `发布于 ${new Date(item.publishedAt).toLocaleDateString("zh-CN")}`
          : "无日期";
      return `
        <a class="version-row" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
          <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.repo)} · ${date}</span></div>
          <div class="progress" aria-label="完成 ${progress}%"><i style="width:${progress}%"></i></div>
          <div>${item.type === "milestone" ? `${item.closedIssues}/${total}` : escapeHtml(item.tag || "Release")}</div>
        </a>`;
    })
    .join("");
}

function overviewView() {
  const prs = pullRequestGroups();
  return [
    metrics(dashboard.counts),
    employeePanel(),
    section(
      "现在轮到我",
      prs.actionNow.slice(0, 7),
      "当前没有明确轮到你处理的 PR。",
      `${prs.actionNow.length} TOTAL · 在 Pull Requests 查看全部`,
    ),
    prs.uncertain.length
      ? section(
          "需要我确认",
          prs.uncertain,
          "",
          `${prs.uncertain.length} ITEMS · 将逐条弹窗确认`,
        )
      : "",
    `<div class="two-column">
      ${section("等待别人", prs.waitingOther.slice(0, 6), "当前没有等待他人的 PR。", `${prs.waitingOther.length} TOTAL`)}
      ${section("分配给我的 Issues", dashboard.groups.myIssues.slice(0, 6), "没有分配给你的开放 Issue。", `${dashboard.groups.myIssues.length} TOTAL · 在 Issues 查看全部`)}
    </div>`,
  ].join("");
}

function versionsView() {
  return `<section class="section">
    <div class="section-heading"><h2>跟踪版本</h2><span>${dashboard.groups.versions.length} RECORDS · 最新创建/发布在前</span></div>
    <div>${versionRows(dashboard.groups.versions)}</div>
  </section>`;
}

function activeConfigurationDocument() {
  return plainRecord(configurationState?.runtimeEffective?.configuration);
}

function activeAutomationTestSource(profileId) {
  const profile = plainRecord(
    activeConfigurationDocument()?.codeExecutor?.profiles?.[profileId],
  );
  const asset = plainRecord(profile?.asset);
  return ["node-script", "windows-test", "windows-build"].includes(profile?.kind) && typeof asset?.source === "string"
    ? asset.source
    : "";
}

function automationTestsView() {
  if (!hasConfigurationState()) {
    return `<section class="automation-test-library"><div class="empty">${escapeHtml(configurationLoadError || "正在读取自动化测试库…")}</div></section>`;
  }
  const configuration = activeConfigurationDocument();
  const executor = plainRecord(configuration?.codeExecutor) || {};
  const profiles = plainRecord(executor.profiles) || {};
  const bindings = plainRecord(executor.requiredProfilesByWorkspace) || {};
  const repositoryBindings = plainRecord(
    configuration?.workCoordination?.policy?.workspaceByRepository,
  ) || {};
  const runtimeVersion = configurationState?.runtimeEffective?.activeVersion;
  const storedVersion = storedActiveConfiguration()?.version;
  const pendingRestart = Number.isSafeInteger(storedVersion) &&
    storedVersion !== runtimeVersion;
  const pendingConfiguration = pendingRestart
    ? plainRecord(storedActiveConfiguration()?.configuration)
    : null;
  const pendingAssets = Object.values(
    plainRecord(pendingConfiguration?.codeExecutor?.profiles) || {},
  ).filter(
    (profile) => ["node-script", "windows-test", "windows-build"].includes(profile?.kind) && plainRecord(profile.asset),
  ).length;
  const assets = Object.entries(profiles)
    .filter(([, profile]) => ["node-script", "windows-test", "windows-build"].includes(profile?.kind) && plainRecord(profile.asset))
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
  const activeVersion = Number.isSafeInteger(runtimeVersion) ? runtimeVersion : null;
  const rows = assets.map(([profileId, profile]) => {
    const asset = profile.asset;
    const workspaceIds = Object.entries(bindings)
      .filter(([, profileIds]) => Array.isArray(profileIds) && profileIds.includes(profileId))
      .map(([workspaceId]) => workspaceId)
      .sort();
    const repositories = Object.entries(repositoryBindings)
      .filter(([, workspaceId]) => workspaceIds.includes(workspaceId))
      .map(([repository]) => repository)
      .sort();
    const automatic = activeVersion !== null && executor.enabled === true && workspaceIds.length > 0;
    const statusLabel = executor.enabled !== true
      ? "执行器已关闭"
      : activeVersion === null
        ? "运行时未载入"
        : automatic
          ? "自动执行"
          : "尚未绑定";
    return `<article class="automation-test-card">
      <header>
        <div>
          <p class="eyebrow">TEST ASSET / ${escapeHtml(profileId)}</p>
          <h2>${escapeHtml(asset.title)}</h2>
        </div>
        <span class="status-pill ${automatic ? "status-active" : "status-waiting_user"}">${statusLabel}</span>
      </header>
      <p>${escapeHtml(asset.description)}</p>
      <dl>
        <div><dt>资产版本</dt><dd>v${escapeHtml(asset.version)}</dd></div>
        <div><dt>${profile.kind.startsWith("windows-") ? "Windows 运行程序" : "运行镜像"}</dt><dd><code>${escapeHtml(profile.nodeExecutable || profile.image)}</code></dd></div>
        ${profile.kind === "windows-build" ? "<div><dt>验证类型</dt><dd>构建（不计为测试通过）</dd></div>" : ""}
        <div><dt>超时</dt><dd>${escapeHtml(profile.timeoutMs)} ms</dd></div>
        <div><dt>工作区</dt><dd>${workspaceIds.length ? workspaceIds.map(escapeHtml).join("、") : "未绑定"}</dd></div>
        <div><dt>自动复用仓库</dt><dd>${repositories.length ? repositories.map(escapeHtml).join("、") : "绑定工作区后生效"}</dd></div>
      </dl>
      <details data-automation-test-source="${escapeHtml(profileId)}">
        <summary>查看受版本保护的脚本</summary>
        <pre><code></code></pre>
      </details>
    </article>`;
  }).join("");
  return `<section class="automation-test-library">
    <div class="automation-test-library-intro">
      <div>
        <p class="eyebrow">LOCAL / VERSIONED / REUSABLE</p>
        <h2>受控自动化测试资产</h2>
        <p>脚本正文和版本随配置摘要封印。执行器启用并绑定工作区后，开发或测试岗位处理该仓库的每个代码任务时都会自动执行；脚本不能从模型返回值临时替换。</p>
      </div>
      <button type="button" class="secondary-button" data-open-test-library-configuration>在配置中心管理</button>
    </div>
    <div class="automation-test-library-summary">
      <strong>${assets.length} 个脚本资产</strong>
      <span>${activeVersion === null ? "当前运行时未载入 Active 配置" : `运行时配置 v${activeVersion}`} · ${Object.keys(bindings).length} 个工作区绑定</span>
    </div>
    ${pendingRestart ? `<div class="notice warning">配置 v${escapeHtml(storedVersion)} 已保存，等待重启；其中有 ${pendingAssets} 个脚本资产。本页卡片仅表示当前运行时实际执行的配置。</div>` : ""}
    ${rows || '<div class="empty">当前还没有可复用脚本。请在配置中心新增“可复用自动化测试脚本”，再把它绑定到工作区。</div>'}
  </section>`;
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function hasConfigurationState() {
  return configurationState !== null;
}

function configurationStatus(state = configurationState) {
  return plainRecord(state?.status) || {};
}

function configurationStateRevision(state = configurationState) {
  const candidates = [
    configurationStatus(state).stateRevision,
    state?.stateRevision,
  ];
  return candidates.find(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
}

function sameConfigurationRevision(left, right) {
  const leftRevision = configurationStateRevision(left);
  return (
    Number.isSafeInteger(leftRevision) &&
    leftRevision === configurationStateRevision(right)
  );
}

function currentConfigurationBinding() {
  const draft = configurationDraft();
  return {
    expectedStateRevision: configurationStateRevision(),
    expectedActiveVersion: configurationActiveVersion(),
    draftId: typeof draft?.draftId === "string" ? draft.draftId : null,
    draftRevision: Number.isSafeInteger(draft?.revision) ? draft.revision : null,
  };
}

function currentPreviewBinding() {
  const preview = plainRecord(configurationPreview?.preview) ||
    plainRecord(configurationPreview);
  return normalizeConfigurationBinding(preview);
}

function configurationDraft(state = configurationState) {
  const drafts = Array.isArray(state?.drafts)
    ? state.drafts.filter(plainRecord)
    : [];
  const baseVersion = configurationStatus(state).safeMode === true
    ? 0
    : configurationActiveVersion(state);
  return drafts.find((draft) => draft.baseVersion === baseVersion) || null;
}

function storedActiveConfiguration(state = configurationState) {
  return plainRecord(state?.storedActive);
}

function configurationDocumentCandidate() {
  const draft = configurationDraft();
  const runtime = plainRecord(configurationState?.runtimeEffective);
  const stored = storedActiveConfiguration();
  const candidates = [
    draft?.configuration,
    configurationState?.editableConfiguration,
    runtime?.configuration,
    stored?.configuration,
  ];
  return candidates.map(plainRecord).find(Boolean) || null;
}

function configurationActiveVersion(state = configurationState) {
  const candidates = [
    storedActiveConfiguration(state)?.version,
    configurationStatus(state).activeVersion,
  ];
  return candidates.find(
    (value) => Number.isSafeInteger(value) && value >= 1,
  ) ?? null;
}

function configurationRequiresRestart(state = configurationState) {
  return (
    state?.pendingRestart === true ||
    plainRecord(state?.pendingRestart) !== null ||
    (configurationStatus(state).safeMode === true &&
      configurationActiveVersion(state) !== null)
  );
}

function sameConfigurationRuntimeState(left, right) {
  const leftStatus = configurationStatus(left);
  const rightStatus = configurationStatus(right);
  return (
    leftStatus.safeMode === rightStatus.safeMode &&
    leftStatus.runtimeMode === rightStatus.runtimeMode &&
    configurationActiveVersion(left) === configurationActiveVersion(right) &&
    configurationRequiresRestart(left) === configurationRequiresRestart(right)
  );
}

function configurationRuntimePresentation() {
  const mode = configurationStatus().runtimeMode;
  if (mode === "cutover") {
    return {
      label: "正在切换配置",
      notice: "配置切换正在完成，新动作暂不接纳",
      detail: "请等待当前确认完成，不要重复提交。",
      tone: "warning",
    };
  }
  if (mode === "unknown" || mode === "unbound") {
    return {
      label: "状态无法确认",
      notice: "运行时配置状态无法确认，请重启服务完成恢复",
      detail: "在恢复完成前，系统保持封闭，不会接纳新动作。",
      tone: "error",
    };
  }
  if (mode === "restart_required") {
    return {
      label: "等待重启",
      notice: "已保存，重启服务后生效",
      detail: "系统不会自动重启。请在方便时手动重启服务。",
      tone: "warning",
    };
  }
  if (mode === "boot_safe") {
    return {
      label: "安全启动",
      notice: "",
      detail: "普通员工和外部动作保持关闭。",
      tone: "normal",
    };
  }
  return {
    label: mode === "ready" ? "已就绪" : "未知",
    notice: "",
    detail: "",
    tone: "normal",
  };
}

function configurationErrorText(value) {
  if (typeof value === "string") return value;
  const error = plainRecord(value);
  if (!error) return "";
  return [error.code, error.message].filter(Boolean).join(" · ");
}

function configurationImpactMarkup(impact) {
  const changed = configurationImpactCategories(impact);
  if (!changed.length) {
    return '<p class="configuration-help">预览未报告配置路径变化。</p>';
  }
  return `<div class="configuration-impact-list">${changed
    .map(
      (category) => `<section>
        <strong>${escapeHtml(category.label)} · ${category.count}</strong>
        ${listMarkup(category.paths)}
      </section>`,
    )
    .join("")}</div>`;
}

function configurationPreviewMarkup() {
  if (!configurationPreview) return "";
  const preview = plainRecord(configurationPreview.preview) || configurationPreview;
  const impact = plainRecord(preview.impact) || {};
  const title = {
    "configuration.initialize": "初始化影响预览",
    "configuration.activate": "下一版本影响预览",
    "configuration.rollback": `回滚到 v${preview.targetVersion ?? "?"} 的影响预览`,
  }[preview.kind] || "配置影响预览";
  return `<section class="configuration-preview" aria-labelledby="configuration-preview-title">
    <div class="section-heading">
      <h2 id="configuration-preview-title">${escapeHtml(title)}</h2>
      <span>只显示路径，不展示敏感配置值</span>
    </div>
    ${configurationImpactMarkup(impact)}
    <dl class="configuration-digests">
      <div><dt>配置摘要</dt><dd><code>${escapeHtml(preview.documentDigest || "未提供")}</code></dd></div>
      <div><dt>验证摘要</dt><dd><code>${escapeHtml(preview.validationDigest || "未提供")}</code></dd></div>
    </dl>
  </section>`;
}

function configurationAuthorityBinding(
  binding = currentConfigurationBinding(),
) {
  if (
    configurationStatus().safeMode === true &&
    binding.expectedActiveVersion === null
  ) {
    return {};
  }
  const expectedActiveVersion = binding.expectedActiveVersion;
  if (!Number.isSafeInteger(expectedActiveVersion)) {
    throw new Error("活动配置版本不可用，请重新读取后再试。");
  }
  return { expectedActiveVersion };
}

function configurationRollbackBinding(targetVersion) {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new Error("回滚目标版本无效。");
  }
  return {
    expectedStateRevision: configurationStateRevision(),
    expectedActiveVersion: configurationActiveVersion(),
    targetVersion,
  };
}

function configurationVersionSourceLabel(source) {
  return {
    bootstrap: "启动导入",
    initialization: "安全初始化",
    draft: "草稿激活",
    rollback: "回滚生成",
  }[source] || "版本变更";
}

function configurationVersionsMarkup(activeVersion, actionsEnabled) {
  const versions = Array.isArray(configurationState?.versions)
    ? configurationState.versions.filter(plainRecord)
    : [];
  const audit = Array.isArray(configurationState?.audit)
    ? configurationState.audit.filter(plainRecord)
    : [];
  if (!versions.length && !audit.length) return "";
  const previewBinding = currentPreviewBinding();
  const versionRows = versions.map((version) => {
    const versionNumber = Number(version.version);
    const isActive = versionNumber === activeVersion;
    const rollbackBinding = isActive
      ? null
      : configurationRollbackBinding(versionNumber);
    const rollbackPreviewed = rollbackBinding &&
      sameConfigurationBinding(previewBinding, rollbackBinding);
    return `<li class="configuration-version-row">
      <div>
        <strong>v${escapeHtml(versionNumber)}</strong>
        <span>${escapeHtml(configurationVersionSourceLabel(version.source))}${version.rollbackOf ? ` · 来自 v${escapeHtml(version.rollbackOf)}` : ""}</span>
        <small>${escapeHtml(version.activatedAt || "时间未知")} · <code>${escapeHtml(version.configurationDigest || "无摘要")}</code></small>
      </div>
      ${isActive
        ? '<span class="status-pill status-active">当前 Active</span>'
        : `<div class="configuration-version-actions">
            <button type="button" class="secondary-button" aria-label="预览回滚到 v${versionNumber}" data-configuration-rollback-preview="${versionNumber}" ${configurationOperationPending || !actionsEnabled ? "disabled" : ""}>预览回滚</button>
            <button type="button" aria-label="请求回滚到 v${versionNumber} 的确认" data-configuration-rollback-request="${versionNumber}" ${configurationOperationPending || !actionsEnabled || !rollbackPreviewed ? "disabled" : ""}>请求回滚确认</button>
          </div>`}
    </li>`;
  }).join("");
  const auditRows = audit.slice(0, 12).map((entry) => `<li>
    <strong>${escapeHtml(entry.kind || "配置事件")}</strong>
    <span>revision ${escapeHtml(entry.stateRevision ?? "?")} · ${escapeHtml(entry.occurredAt || "时间未知")}</span>
  </li>`).join("");
  return `<section class="configuration-history" aria-labelledby="configuration-history-title">
    <div class="section-heading">
      <h2 id="configuration-history-title">版本与审计</h2>
      <span>最近 ${versions.length} 个版本 · ${audit.length} 条审计</span>
    </div>
    <ol class="configuration-version-list">${versionRows}</ol>
    ${auditRows ? `<details class="configuration-audit"><summary>查看最近审计记录</summary><ol>${auditRows}</ol></details>` : ""}
  </section>`;
}

function configurationView() {
  const brainProviderStatus = renderBrainProviderStatus({
    state: brainProviderStatusState,
    loading: brainProviderStatusLoading,
    error: brainProviderStatusError,
    pendingRestart: configurationRequiresRestart(),
  });
  if (!hasConfigurationState()) {
    return `<section class="configuration-panel">
      ${brainProviderStatus}
      <div class="empty">${escapeHtml(configurationLoadError || "正在读取本地配置状态…")}</div>
      ${configurationLoadError ? '<button class="secondary-button" data-configuration-reload>重新读取</button>' : ""}
    </section>`;
  }

  const status = configurationStatus();
  const safeMode = status.safeMode === true;
  const activeVersion = configurationActiveVersion();
  const stateRevision = configurationStateRevision();
  const draft = configurationDraft();
  const draftId = typeof draft?.draftId === "string" ? draft.draftId : null;
  const draftRevision = Number.isSafeInteger(draft?.revision) ? draft.revision : null;
  const initializationOpen = safeMode && activeVersion === null;
  const activeEditingOpen =
    !safeMode && activeVersion !== null && status.runtimeMode === "ready";
  const editingOpen = initializationOpen || activeEditingOpen;
  const migrationError = configurationErrorText(status.migrationError);
  const runtime = configurationRuntimePresentation();
  const runtimeNotice = runtime.notice || (
    configurationRequiresRestart() ? "已保存，重启服务后生效" : ""
  );
  const notice = runtimeNotice || configurationNotice;
  const operationNotice = !runtimeNotice && Boolean(configurationNotice);
  const noticeClass = runtime.tone === "error"
    ? "configuration-runtime-error"
    : runtime.tone === "warning"
      ? "configuration-runtime-warning"
      : "configuration-success";
  const statusLabel = initializationOpen
    ? "等待初始化"
    : activeVersion === null
      ? "未初始化"
      : `已保存 v${activeVersion}`;
  const activationPreviewReady =
    !configurationEditorDirty &&
    sameConfigurationBinding(
      currentPreviewBinding(),
      currentConfigurationBinding(),
    );
  const structuredForm = configurationFormState
    ? renderConfigurationSettingsSkeleton({ state: configurationFormState })
    : "";

  const editor = editingOpen
    ? configurationEditorBinding !== null && configurationFormState !== null
      ? `<section class="configuration-editor" aria-labelledby="configuration-editor-title">
          <h2 id="configuration-editor-title">${initializationOpen ? "初始化配置" : `基于 v${activeVersion} 的下一版本配置`}</h2>
          <p id="configuration-editor-help" class="configuration-help">使用结构化字段保存本地草稿，再预览逐项影响并加入统一确认队列。页面不会直接激活或回滚配置。</p>
          ${structuredForm}
          <div class="configuration-actions">
            <button type="button" class="secondary-button" data-configuration-preview ${configurationOperationPending || configurationEditorStale ? "disabled" : ""}>预览影响</button>
            <button type="button" class="secondary-button" data-configuration-request ${configurationOperationPending || configurationEditorStale || !activationPreviewReady ? "disabled" : ""}>请求激活确认</button>
            ${configurationEditorStale ? '<button type="button" class="secondary-button" data-configuration-reset>放弃本地编辑并载入最新配置</button>' : ""}
          </div>
        </section>`
      : `<div class="configuration-inline-error" role="alert">服务端没有提供可编辑的规范化配置。请重新读取配置状态，不能用空对象创建草稿。</div>`
    : `<div class="configuration-locked">
        <strong>${activeVersion === null ? "当前不可编辑" : `活动配置 v${activeVersion}`}</strong>
        <p>${safeMode ? "初始化版本已写入本地存储；重启后才会进入 Active 配置模式。" : "配置运行时当前不可确认，系统保持封闭。"}</p>
      </div>`;

  return `<div class="configuration-panel">
    ${brainProviderStatus}
    ${notice ? `<div class="${noticeClass}" ${operationNotice ? "data-configuration-operation-notice" : ""} role="${runtime.tone === "error" ? "alert" : "status"}"><strong>${escapeHtml(notice)}</strong>${runtime.detail ? `<span>${escapeHtml(runtime.detail)}</span>` : ""}</div>` : ""}
    ${configurationLoadError ? `<div class="configuration-inline-error" role="alert">${escapeHtml(configurationLoadError)}</div>` : ""}
    ${configurationOperationError ? `<div class="configuration-inline-error" data-configuration-operation-error role="alert">${escapeHtml(configurationOperationError)}</div>` : ""}
    <section class="configuration-status" aria-labelledby="configuration-status-title">
      <div class="configuration-status-heading">
        <div>
          <p class="eyebrow">LOCAL CONFIGURATION / VERSIONED</p>
          <h2 id="configuration-status-title">${safeMode ? "安全初始化模式" : "版本化配置"}</h2>
        </div>
        <span class="status-pill ${initializationOpen ? "status-waiting_user" : "status-active"}">${escapeHtml(statusLabel)}</span>
      </div>
      <p>${initializationOpen ? "当前没有 Active 配置。只有你确认的初始化草稿可以写入 v1，员工和外部动作保持关闭。" : "这里展示存储状态与当前进程实际使用状态；任何新版本或回滚都必须先预览，再由你逐项确认。"}</p>
      <dl class="configuration-summary">
        <div><dt>存储版本</dt><dd>${activeVersion === null ? "尚无 Active" : `v${activeVersion}`}</dd></div>
        <div><dt>状态修订</dt><dd>${stateRevision ?? "未知"}</dd></div>
        <div><dt>当前草稿</dt><dd>${draftId ? `${escapeHtml(draftId)} · r${draftRevision ?? "?"}` : "尚未保存"}</dd></div>
        <div><dt>运行时</dt><dd>${escapeHtml(runtime.label)}</dd></div>
      </dl>
      <p><a href="/jenkins.html">连接 Jenkins 构建日志</a>：让岗位自动读取失败检查的具体原因。</p>
      ${migrationError ? `<p class="configuration-migration-error"><strong>启动配置未导入：</strong>${escapeHtml(migrationError)}</p>` : ""}
    </section>
    ${editor}
    ${configurationPreviewMarkup()}
    ${configurationVersionsMarkup(activeVersion, activeEditingOpen)}
  </div>`;
}

function preserveConfirmationHistoryPanel() {
  if (currentView !== "employees") return null;
  const panel = content.querySelector("#confirmation-history-panel");
  if (!panel) return null;

  const focusedElement = document.activeElement;
  const restoreFocus = panel.contains(focusedElement) ? focusedElement : null;
  const placeholder = document.createComment("confirmation-history-panel");
  panel.replaceWith(placeholder);
  return { panel, restoreFocus };
}

function restoreConfirmationHistoryPanel(preservedPanel) {
  if (!preservedPanel) return;
  const replacement = content.querySelector("#confirmation-history-panel");
  if (!replacement) return;
  replacement.replaceWith(preservedPanel.panel);
  if (preservedPanel.restoreFocus?.isConnected) {
    preservedPanel.restoreFocus.focus({ preventScroll: true });
  }
}

function bindConfirmationHistoryView() {
  const restoreDeferred = content.querySelector("#confirmation-deferred-restore");
  if (restoreDeferred && !restoreDeferred.dataset.confirmationDeferredBound) {
    restoreDeferred.dataset.confirmationDeferredBound = "true";
    restoreDeferred.addEventListener("click", restoreDeferredConfirmations);
  }
  const filter = content.querySelector("#confirmation-history-filter");
  if (filter && !filter.dataset.confirmationHistoryBound) {
    filter.dataset.confirmationHistoryBound = "true";
    filter.addEventListener("submit", applyConfirmationHistoryFilters);
  }
  const loadMore = content.querySelector("#confirmation-history-load-more");
  if (loadMore && !loadMore.dataset.confirmationHistoryBound) {
    loadMore.dataset.confirmationHistoryBound = "true";
    loadMore.addEventListener("click", loadMoreConfirmationHistory);
  }
}

function render() {
  pageTitle.textContent = viewTitles[currentView];
  document.title = `${viewTitles[currentView]} · Development Intelligence Hub`;
  document.querySelector('#task-runs').hidden = currentView !== 'workbench';
  content.hidden = currentView === 'workbench';
  if (currentView === 'workbench') return;
  if (lanReadOnly && localViews.has(currentView)) {
    content.innerHTML = '<div class="empty">此页面的详细内容仅在本机工作台可见。</div>';
    return;
  }
  if (!isConfigurationBackedView() && currentView !== "system" && !dashboard) {
    content.innerHTML = '<div class="empty">正在建立第一次数据快照。配置恢复不依赖该快照，可从“配置中心”继续。</div>';
    return;
  }
  itemIndex = new Map();
  jobIndex = new Map();
  const views = {
    overview: overviewView,
    prs: () => {
      const prs = pullRequestGroups();
      return (
        section("现在轮到我", prs.actionNow, "当前没有明确轮到你处理的 PR。") +
        section("等待别人", prs.waitingOther, "当前没有等待他人的 PR。") +
        section("需要确认", prs.uncertain, "当前没有需要你确认归属的 PR。") +
        section(
          "历史待清理",
          prs.historical,
          "当前没有长期未活动、需要清理的 PR。",
        )
      );
    },
    issues: () =>
      section("开放 Issues", dashboard.groups.myIssues, "没有分配给你的开放 Issue。"),
    versions: versionsView,
    signals: () =>
      dingtalkReportView() +
      section("钉钉今日重点", dashboard.groups.dingtalk, "今天没有重要消息、邮件、公告、@我或待办。"),
    employees: employeesView,
    memory: memoryView,
    workflow: () => workflowView.render(),
    work: () => workView.render(),
    "automation-tests": automationTestsView,
    configuration: configurationView,
    system: () => renderSystemStatus({
      state: systemStatusState,
      loading: systemStatusLoading,
      error: systemStatusError,
      operationPending: systemStatusOperationPending,
      notice: systemStatusNotice,
    }),
  };
  const preservedHistoryPanel = preserveConfirmationHistoryPanel();
  content.innerHTML = views[currentView]();
  restoreConfirmationHistoryPanel(preservedHistoryPanel);
  content.querySelectorAll("[data-item-id]").forEach((button) => {
      button.addEventListener("click", () => showDetail(itemIndex.get(button.dataset.itemId)));
  });
  content.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () =>
      showEmployeeJob(jobIndex.get(button.dataset.jobId)),
    );
  });
  content.querySelector("[data-employee-control]")?.addEventListener(
    "click",
    handleEmployeeControl,
  );
  content.querySelector("[data-employee-run]")?.addEventListener(
    "click",
    handleEmployeeRun,
  );
  content.querySelectorAll("[data-role-control]").forEach((button) => {
    button.addEventListener("click", handleRoleControl);
  });
  content.querySelectorAll("[data-role-run]").forEach((button) => {
    button.addEventListener("click", handleRoleRun);
  });
  content.querySelector("[data-maintenance-reload]")?.addEventListener("click", () => void loadMaintenanceAttention());
  content.querySelectorAll("[data-maintenance-attention]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = maintenanceAttention.items.find(({ requestId }) => requestId === button.dataset.maintenanceAttention);
      if (item) showConfirmationEntry({ kind: "internal_request", item, key: `internal:${item.requestId}:${item.contentDigest}` }, 1);
    });
  });
  content.querySelectorAll("[data-role-work]").forEach((button) => {
    button.addEventListener("click", handleRoleWork);
  });
  content.querySelectorAll("[data-role-confirmations]").forEach((button) => {
    button.addEventListener("click", handleRoleConfirmations);
  });
  bindConfirmationHistoryView();
  content.querySelector("#memory-search-form")?.addEventListener(
    "submit",
    handleMemorySearch,
  );
  content.querySelector("#memory-question-form")?.addEventListener(
    "submit",
    handleMemoryQuestion,
  );
  content.querySelector("#memory-load-more")?.addEventListener(
    "click",
    handleMemoryLoadMore,
  );
  content.querySelector("#memory-rerun-local")?.addEventListener(
    "click",
    handleMemoryLocalRerun,
  );
  content.querySelector("[data-open-test-library-configuration]")?.addEventListener(
    "click",
    () => activateView("configuration"),
  );
  bindAutomationTestLibraryView();
  bindConfigurationView();
  bindSystemStatusView();
  workflowView.bind(content);
  workView.bind(content);
}

function bindAutomationTestLibraryView() {
  content.querySelectorAll("[data-automation-test-source]").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      const code = details.querySelector("code");
      if (code) {
        code.textContent = activeAutomationTestSource(
          details.dataset.automationTestSource,
        );
      }
    }, { once: true });
  });
}

function bindSystemStatusView() {
  content.querySelector("[data-system-status-reload]")?.addEventListener(
    "click",
    () => void loadSystemStatus(),
  );
  content.querySelector("[data-system-backup-create]")?.addEventListener(
    "click",
    () => void createSystemBackup(),
  );
}

async function loadBrainProviderStatus() {
  const sequence = ++brainProviderStatusRequestSequence;
  brainProviderStatusAbortController?.abort();
  const controller = new AbortController();
  brainProviderStatusAbortController = controller;
  brainProviderStatusLoading = true;
  brainProviderStatusError = "";
  if (currentView === "configuration") {
    renderConfigurationPreservingEditorFocus();
  }
  try {
    const response = await fetch("/api/brain-providers/status", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`读取 Codex CLI 能力失败（${response.status}）`);
    }
    const result = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== brainProviderStatusRequestSequence ||
      sequence < lastAppliedBrainProviderStatusRequest
    ) {
      return false;
    }
    lastAppliedBrainProviderStatusRequest = sequence;
    brainProviderStatusState = result;
    brainProviderStatusError = "";
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    if (sequence === brainProviderStatusRequestSequence) {
      brainProviderStatusError = error.message || "读取 Codex CLI 能力失败";
    }
    return false;
  } finally {
    if (brainProviderStatusAbortController === controller) {
      brainProviderStatusAbortController = null;
      brainProviderStatusLoading = false;
      if (currentView === "configuration") {
        renderConfigurationPreservingEditorFocus();
      }
    }
  }
}

async function loadSystemStatus() {
  const sequence = ++systemStatusRequestSequence;
  systemStatusAbortController?.abort();
  const controller = new AbortController();
  systemStatusAbortController = controller;
  systemStatusLoading = true;
  if (currentView === "system") render();
  try {
    const response = await fetch("/api/system/status", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`读取系统状态失败（${response.status}）`);
    const result = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== systemStatusRequestSequence ||
      sequence < lastAppliedSystemStatusRequest
    ) {
      return false;
    }
    lastAppliedSystemStatusRequest = sequence;
    systemStatusState = result;
    systemStatusError = "";
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    if (sequence === systemStatusRequestSequence) {
      systemStatusError = error.message || "读取系统状态失败";
    }
    return false;
  } finally {
    if (systemStatusAbortController === controller) {
      systemStatusAbortController = null;
      systemStatusLoading = false;
      if (currentView === "system") render();
    }
  }
}

async function createSystemBackup() {
  if (systemStatusOperationPending) return;
  systemStatusOperationPending = true;
  systemStatusError = "";
  systemStatusNotice = "";
  if (currentView === "system") render();
  try {
    const response = await fetch("/api/system/backups", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`创建备份失败（${response.status}）`);
    const result = await response.json();
    systemStatusNotice = `备份 ${result.backupId || ""} 已完成并通过校验。`;
    await loadSystemStatus();
  } catch (error) {
    systemStatusError = error.message || "创建备份失败";
  } finally {
    systemStatusOperationPending = false;
    if (currentView === "system") render();
  }
}

function bindConfigurationView() {
  content
    .querySelector("[data-brain-provider-status-reload]")
    ?.addEventListener("click", () => void loadBrainProviderStatus());
  const form = content.querySelector("[data-configuration-structured-form]");
  if (form && configurationFormState) {
    bindConfigurationFormController({
      root: form,
      getState: () => configurationFormState,
      onStateChange: handleConfigurationFormStateChange,
      onInvalidate: handleConfigurationFormInvalidate,
      onError: handleConfigurationFormError,
    });
    const submit = form.querySelector("[data-configuration-submit]");
    if (submit) {
      const draft = configurationDraft();
      const initializationOpen =
        configurationStatus().safeMode === true &&
        configurationActiveVersion() === null;
      submit.textContent = draft?.draftId
        ? "保存新修订"
        : initializationOpen
          ? "保存初始化草稿"
          : "保存下一版本草稿";
      submit.disabled = configurationOperationPending || configurationEditorStale;
    }
    form.setAttribute("aria-busy", `${configurationOperationPending}`);
    if (configurationOperationPending) {
      form.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = true;
      });
    } else if (configurationEditorStale) {
      form
        .querySelectorAll("[data-configuration-operation]")
        .forEach((button) => {
          button.disabled = true;
        });
    }
    updateConfigurationFormStatus();
  }
  form?.addEventListener("submit", handleConfigurationSave);
  content
    .querySelector("[data-configuration-preview]")
    ?.addEventListener("click", handleConfigurationPreview);
  content
    .querySelector("[data-configuration-request]")
    ?.addEventListener("click", handleConfigurationRequest);
  content
    .querySelector("[data-configuration-reload]")
    ?.addEventListener("click", () => void loadConfiguration());
  content
    .querySelector("[data-configuration-reset]")
    ?.addEventListener("click", resetConfigurationEditor);
  content
    .querySelectorAll("[data-configuration-rollback-preview]")
    .forEach((button) =>
      button.addEventListener("click", handleConfigurationRollbackPreview),
    );
  content
    .querySelectorAll("[data-configuration-rollback-request]")
    .forEach((button) =>
      button.addEventListener("click", handleConfigurationRollbackRequest),
    );
}

function updateConfigurationFormStatus({ focus = false } = {}) {
  const status = content.querySelector("#configuration-form-status");
  if (!status) return;
  status.textContent = configurationEditorError;
  status.classList.remove("configuration-success");
  status.classList.toggle("configuration-inline-error", Boolean(configurationEditorError));
  if (focus && configurationEditorError) status.focus({ preventScroll: true });
}

function handleConfigurationFormInvalidate() {
  configurationEditorError = "";
  configurationOperationError = "";
  invalidateConfigurationPreviewUi();
  updateConfigurationFormStatus();
}

function handleConfigurationFormStateChange(
  nextState,
  {
    render: renderView = false,
    focusTarget = null,
    announcement = "",
  } = {},
) {
  configurationFormState = nextState;
  configurationEditorDirty = nextState.dirty;
  configurationEditorError = "";
  configurationOperationError = "";
  if (renderView && currentView === "configuration") {
    render();
    restoreConfigurationStructureFocus(focusTarget);
    announceConfigurationStructureChange(announcement);
  }
}

function configurationPathElement(selector, datasetKey, path) {
  if (!Array.isArray(path)) return null;
  const expected = JSON.stringify(path.map((segment) => `${segment}`));
  return [...content.querySelectorAll(selector)].find(
    (element) => element.dataset?.[datasetKey] === expected,
  ) ?? null;
}

function firstFocusableConfigurationControl(container) {
  if (!container) return null;
  if (container.matches("input, select, button, summary")) return container;
  return container.querySelector("[data-configuration-field]") ??
    container.querySelector("summary") ??
    container.querySelector("[data-configuration-operation]") ??
    container.querySelector("button");
}

function restoreConfigurationStructureFocus(target) {
  if (!target || !Array.isArray(target.path)) return;
  let focusable = null;
  if (target.scope === "entry") {
    focusable = firstFocusableConfigurationControl(
      configurationPathElement(
        "[data-configuration-entry]",
        "configurationEntry",
        target.path,
      ),
    );
  } else if (target.scope === "collection") {
    const collection = configurationPathElement(
      "[data-configuration-collection]",
      "configurationCollection",
      target.path,
    );
    focusable = collection?.querySelector(
      ":scope > [data-configuration-structure-template] > summary",
    ) ?? firstFocusableConfigurationControl(collection);
  } else if (target.scope === "slot") {
    focusable = configurationPathElement(
      "[data-configuration-field]",
      "configurationField",
      target.path,
    );
    if (!focusable) {
      focusable = firstFocusableConfigurationControl(
        configurationPathElement(
          "[data-configuration-node]",
          "configurationNode",
          target.path,
        ),
      );
    }
    if (!focusable) {
      const template = configurationPathElement(
        "[data-configuration-template-value-root]",
        "configurationTemplateValueRoot",
        target.path,
      );
      focusable = firstFocusableConfigurationControl(template);
    }
  } else if (target.scope === "slot-template") {
    const template = configurationPathElement(
      "[data-configuration-template-value-root]",
      "configurationTemplateValueRoot",
      target.path,
    );
    focusable = firstFocusableConfigurationControl(template) ??
      configurationPathElement(
        "[data-configuration-field]",
        "configurationField",
        target.path,
      );
  }
  focusable?.focus({ preventScroll: true });
}

function announceConfigurationStructureChange(message) {
  if (!message) return;
  const status = content.querySelector("#configuration-form-status");
  if (!status) return;
  status.textContent = "";
  status.classList.remove("configuration-inline-error");
  status.classList.add("configuration-success");
  queueMicrotask(() => {
    if (status.isConnected && currentView === "configuration") {
      status.textContent = message;
    }
  });
}

function handleConfigurationFormError(message) {
  configurationEditorError = message;
  configurationOperationError = "";
  updateConfigurationFormStatus();
}

function invalidateConfigurationPreviewUi() {
  configurationPreview = null;
  configurationNotice = "";
  content.querySelector(".configuration-preview")?.remove();
  content.querySelector("[data-configuration-operation-error]")?.remove();
  content.querySelector("[data-configuration-operation-notice]")?.remove();
  content
    .querySelectorAll(
      "[data-configuration-request], [data-configuration-rollback-request]",
    )
    .forEach((button) => {
      button.disabled = true;
    });
}

function requiredConfigurationBinding() {
  const binding = currentConfigurationBinding();
  const expectedStateRevision = binding.expectedStateRevision;
  if (!Number.isSafeInteger(expectedStateRevision)) {
    throw new Error("配置状态修订不可用，请重新读取后再试。");
  }
  return {
    expectedStateRevision,
    draft: configurationDraft(),
    ...configurationAuthorityBinding(binding),
  };
}

function requiredConfigurationEditorBinding() {
  const binding = configurationEditorBinding;
  if (!binding || !Number.isSafeInteger(binding.expectedStateRevision)) {
    throw new Error("编辑器没有可靠的配置修订绑定，请刷新页面后再试。");
  }
  return binding;
}

function resetConfigurationEditor() {
  const editable = configurationDocumentCandidate();
  if (!editable) {
    configurationEditorError = "服务端没有提供可载入的规范化配置。";
    render();
    return;
  }
  const binding = currentConfigurationBinding();
  try {
    configurationFormState = createConfigurationFormState(editable, binding);
  } catch (error) {
    configurationFormState = null;
    configurationEditorBinding = null;
    configurationEditorError = error.message;
    render();
    return;
  }
  configurationEditorDirty = false;
  configurationEditorStale = false;
  configurationEditorBinding = binding;
  configurationEditorError = "";
  configurationOperationError = "";
  configurationPreview = null;
  configurationNotice = "已载入最新配置，请重新核对后保存";
  render();
  content.querySelector("[data-configuration-field]")?.focus();
}

async function configurationResponseError(response, fallback) {
  const payload = await response.json().catch(() => null);
  const detail = configurationErrorText(payload?.error);
  return new Error(detail || `${fallback}（${response.status}）`);
}

async function runConfigurationOperation(
  operation,
  { editorError = true, focusSelector = null } = {},
) {
  if (configurationOperationPending) return;
  configurationOperationPending = true;
  configurationEditorError = "";
  configurationOperationError = "";
  if (currentView === "configuration") render();
  try {
    await operation();
  } catch (error) {
    if (editorError) {
      configurationEditorError = error.message;
    } else {
      configurationOperationError = error.message;
    }
  } finally {
    configurationOperationPending = false;
    if (currentView === "configuration") {
      render();
      if (configurationEditorError) {
        const invalid = content.querySelector("[data-configuration-first-invalid]");
        if (invalid) invalid.focus({ preventScroll: true });
        else updateConfigurationFormStatus({ focus: true });
      } else if (configurationOperationError && focusSelector) {
        content.querySelector(focusSelector)?.focus();
      }
    }
  }
}

async function handleConfigurationSave(event) {
  event.preventDefault();
  if (!configurationFormState) {
    configurationEditorError = "结构化配置表单尚未就绪，请重新读取配置状态。";
    render();
    updateConfigurationFormStatus({ focus: true });
    return;
  }
  const materialized = configurationDocumentFromForm(configurationFormState);
  if (!materialized.ok) {
    configurationEditorError = `有 ${materialized.issues.length} 个配置问题，请从第一个标记字段开始修正。`;
    render();
    const firstInvalid = content.querySelector("[data-configuration-first-invalid]");
    if (firstInvalid) firstInvalid.focus({ preventScroll: true });
    else updateConfigurationFormStatus({ focus: true });
    return;
  }
  configurationEditorDirty = true;
  await runConfigurationOperation(async () => {
    const configuration = materialized.configuration;
    const editorBinding = requiredConfigurationEditorBinding();
    const {
      expectedStateRevision,
      draftId,
      draftRevision: expectedDraftRevision,
    } = editorBinding;
    const authorityBinding = configurationAuthorityBinding(editorBinding);
    if (draftId && !Number.isSafeInteger(expectedDraftRevision)) {
      throw new Error("草稿修订绑定无效，请刷新页面后再试。");
    }
    const response = await configurationFetch(
      draftId
        ? `/api/configuration/drafts/${encodeURIComponent(draftId)}`
        : "/api/configuration/drafts",
      {
        method: draftId ? "PUT" : "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify(
          draftId
            ? {
                expectedDraftRevision,
                expectedStateRevision,
                ...authorityBinding,
                configuration,
              }
            : {
                expectedStateRevision,
                ...authorityBinding,
                configuration,
              },
        ),
      },
    );
    if (response.status === 409) {
      await loadConfiguration({ renderView: false });
      configurationEditorStale = true;
      throw new Error("配置状态已有更新。本地内容已保留供复制；请放弃本地编辑并载入最新配置，再重新核对修改。");
    }
    if (!response.ok) {
      throw await configurationResponseError(response, "保存配置草稿失败");
    }
    await response.json();
    configurationEditorDirty = false;
    configurationEditorStale = false;
    configurationPreview = null;
    configurationNotice = configurationStatus().safeMode === true
      ? "初始化草稿已保存"
      : "下一版本草稿已保存";
    await loadConfiguration({ renderView: false });
  });
}

async function handleConfigurationPreview() {
  await runConfigurationOperation(async () => {
    const { draft, ...requestBinding } = requiredConfigurationBinding();
    if (
      typeof draft?.draftId !== "string" ||
      !Number.isSafeInteger(draft.revision)
    ) {
      throw new Error("请先保存配置草稿，再预览影响。");
    }
    if (configurationEditorDirty) {
      throw new Error("编辑内容尚未保存。请先保存新修订，再预览影响。");
    }
    const response = await configurationFetch(
      `/api/configuration/drafts/${encodeURIComponent(draft.draftId)}/preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({
          draftRevision: draft.revision,
          ...requestBinding,
        }),
      },
    );
    if (response.status === 409) {
      await loadConfiguration({ renderView: false });
      throw new Error("草稿或配置状态已经变化。请根据最新修订重新预览。");
    }
    if (!response.ok) {
      throw await configurationResponseError(response, "预览配置影响失败");
    }
    configurationPreview = await response.json();
    configurationNotice = "影响预览已更新";
  });
}

async function handleConfigurationRequest() {
  await runConfigurationOperation(async () => {
    const { draft, ...requestBinding } = requiredConfigurationBinding();
    if (
      typeof draft?.draftId !== "string" ||
      !Number.isSafeInteger(draft.revision)
    ) {
      throw new Error("请先保存并预览配置草稿。");
    }
    if (
      configurationEditorDirty ||
      !configurationPreview ||
      !sameConfigurationBinding(
        currentPreviewBinding(),
        currentConfigurationBinding(),
      )
    ) {
      throw new Error("请先保存当前编辑内容并查看最新影响预览。");
    }
    const response = await configurationFetch(
      `/api/configuration/drafts/${encodeURIComponent(draft.draftId)}/request-confirmation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({
          draftRevision: draft.revision,
          ...requestBinding,
        }),
      },
    );
    if (response.status === 409) {
      await loadConfiguration({ renderView: false });
      throw new Error("草稿或配置状态已经变化。请重新预览后再请求确认。");
    }
    if (!response.ok) {
      throw await configurationResponseError(response, "请求配置确认失败");
    }
    await response.json();
    configurationNotice = configurationStatus().safeMode === true
      ? "初始化配置已加入确认队列"
      : "下一版本配置已加入确认队列";
    try {
      await refreshConfirmationQueue({
        showConfirmation: false,
        renderView: false,
      });
    } catch (error) {
      statusBanner.hidden = false;
      statusBanner.textContent = `${error.message}。请求已经提交，页面会自动重试读取确认队列。`;
    }
    queueMicrotask(showNextConfirmation);
  });
}

async function handleConfigurationRollbackPreview(event) {
  const targetVersion = Number(
    event.currentTarget.dataset.configurationRollbackPreview,
  );
  await runConfigurationOperation(async () => {
    const binding = configurationRollbackBinding(targetVersion);
    if (
      !Number.isSafeInteger(binding.expectedStateRevision) ||
      !Number.isSafeInteger(binding.expectedActiveVersion)
    ) {
      throw new Error("配置版本绑定不可用，请重新读取后再试。");
    }
    const response = await configurationFetch(
      `/api/configuration/versions/${targetVersion}/rollback/preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({
          expectedStateRevision: binding.expectedStateRevision,
          expectedActiveVersion: binding.expectedActiveVersion,
        }),
      },
    );
    if (response.status === 409) {
      await loadConfiguration({ renderView: false });
      throw new Error("活动配置或回滚目标已经变化，请重新预览。");
    }
    if (!response.ok) {
      throw await configurationResponseError(response, "预览配置回滚失败");
    }
    configurationPreview = await response.json();
    configurationNotice = `已预览回滚到 v${targetVersion} 的影响`;
  }, {
    editorError: false,
    focusSelector: `[data-configuration-rollback-preview="${targetVersion}"]`,
  });
}

async function handleConfigurationRollbackRequest(event) {
  const targetVersion = Number(
    event.currentTarget.dataset.configurationRollbackRequest,
  );
  await runConfigurationOperation(async () => {
    const binding = configurationRollbackBinding(targetVersion);
    if (!sameConfigurationBinding(currentPreviewBinding(), binding)) {
      throw new Error("请先查看该目标版本的最新回滚影响预览。");
    }
    const response = await configurationFetch(
      `/api/configuration/versions/${targetVersion}/rollback/request-confirmation`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({
          expectedStateRevision: binding.expectedStateRevision,
          expectedActiveVersion: binding.expectedActiveVersion,
        }),
      },
    );
    if (response.status === 409) {
      await loadConfiguration({ renderView: false });
      throw new Error("活动配置或回滚目标已经变化，请重新预览后再确认。");
    }
    if (!response.ok) {
      throw await configurationResponseError(response, "请求配置回滚确认失败");
    }
    await response.json();
    configurationNotice = `回滚到 v${targetVersion} 的请求已加入确认队列`;
    try {
      await refreshConfirmationQueue({
        showConfirmation: false,
        renderView: false,
      });
    } catch (error) {
      statusBanner.hidden = false;
      statusBanner.textContent = `${error.message}。请求已经提交，页面会自动重试读取确认队列。`;
    }
    queueMicrotask(showNextConfirmation);
  }, {
    editorError: false,
    focusSelector: `[data-configuration-rollback-request="${targetVersion}"]`,
  });
}

function detailRows(item) {
  const stateLabels = {
    open: "Open",
    closed: "Closed",
    merged: "Merged",
  };
  const relationLabels = {
    assigned: "分配给我",
    mentioned: "明确 @我",
    direct: "直接收件",
    copied: "抄送给我",
    followed: "订阅动态",
    participated: "我参与的讨论",
    authored: "我创建的",
    review_requested: "等待我 Review",
  };
  const updatedAt = item.updatedAt
    ? new Date(item.updatedAt).toLocaleString("zh-CN")
    : null;
  const createdAt = item.createdAt
    ? new Date(item.createdAt).toLocaleString("zh-CN")
    : null;
  const changeSize = item.kind === "pull_request" &&
      Number.isFinite(item.changedFiles)
    ? `${item.changedFiles} 个文件 · +${item.additions || 0} / -${item.deletions || 0}`
    : null;
  const fields = [
    ["来源", item.repo || item.context || "钉钉"],
    ["编号", item.number ? `#${item.number}` : null],
    ["状态", stateLabels[item.state] || item.state],
    ["与我的关系", relationLabels[item.relation] || item.relation],
    ["优先级", `${item.score} · ${(item.reasons || []).join("、")}`],
    ["责任状态", actionStateLabel(item.actionState)],
    ["下一位行动人", nextActorLabel(item.nextActor)],
    ["下一步", item.nextAction],
    ["作者", item.author],
    ["负责人", item.assignees?.length ? item.assignees.map((name) => `@${name}`).join("、") : null],
    ["改动规模", changeSize],
    ["讨论", Number.isSafeInteger(item.commentsCount) ? `${item.commentsCount} 条评论` : null],
    ["我的审核结论", item.myReviewState],
    ["我的审核提交", item.myReviewCommitOid],
    ["当前提交", item.headRefOid],
    ["审核", item.reviewDecision],
    ["CI", item.ciStatus],
    ["合并状态", item.mergeStateStatus],
    ["里程碑", item.milestone],
    ["标签", item.labels?.join("、")],
    ["创建时间", createdAt],
    ["最近更新", updatedAt],
  ].filter(([, value]) => value);
  return fields.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function brainAssessment(item) {
  if (!item.brainAssessment) return "";
  const assessment = item.brainAssessment;
  return `
    <aside class="brain-assessment">
      <strong>大脑建议（仍需你确认）</strong>
      <p>${escapeHtml(assessment.recommendedAction || "暂无建议")}</p>
      <span>建议归类：${escapeHtml(actionStateLabel(assessment.classification))} · 置信度 ${Math.round((assessment.confidence || 0) * 100)}%</span>
    </aside>`;
}

function prLifecycleStatusMarkup(item) {
  if (item?.kind !== "pull_request") return "";
  const lifecycle = prLifecycleStatus(item);
  return `<section class="pr-lifecycle-status">
    <div>
      <strong>${escapeHtml(lifecycle.title)}</strong>
      <span>${escapeHtml(prLifecycleStageLabel(lifecycle.stage))}</span>
    </div>
    <dl>
      <dt>当前下一棒</dt><dd>${escapeHtml(lifecycle.nextOwner)}</dd>
      <dt>闭环规则</dt><dd>${escapeHtml(lifecycle.nextStep)}</dd>
    </dl>
  </section>`;
}

function listMarkup(items) {
  if (!items?.length) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function showEmployeeJob(job) {
  if (!job) return;
  codeJobDetailFocusIntent = null;
  const historical = historicalPrJobStatuses.has(job.status);
  const summary = job.summary || job.triggerReason || job.error || "";
  const review = job.reviewBody
    ? `<section class="review-preview">
        <strong>${escapeHtml(reviewVerdictLabel(job.reviewVerdict))}</strong>
        <pre>${escapeHtml(job.reviewBody)}</pre>
      </section>`
    : "";
  const recoveryIntent = createPrEmployeeRecoveryIntent(
    job,
    dashboard?.employee?.role?.revision,
  );
  const recoveryActions = recoveryIntent
    ? prEmployeeBlockedActions(job)
    : [];
  const recovery = recoveryActions.length
    ? `<section class="employee-job-recovery">
        <h3>失败恢复</h3>
        <p>重新分析会再次核对当前 PR 与 Head；关闭只忽略当前这一次失败，不会影响新 Head。</p>
        <div class="confirmation-actions" data-pr-job-recovery="${escapeHtml(recoveryIntent.id)}" data-head-ref-oid="${escapeHtml(recoveryIntent.headRefOid)}" data-expected-revision="${escapeHtml(recoveryIntent.expectedRevision)}">
          ${recoveryActions.map((action, index) => `<button class="${index === 0 ? "" : "secondary"}" data-pr-job-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`).join("")}
        </div>
      </section>`
    : "";
  const confirmationAction = [
    "ready_for_human",
    "waiting_confirmation",
    "waiting_retry_confirmation",
  ].includes(job.status)
    ? `<section class="employee-job-confirmation">
        <h3>需要你确认什么</h3>
        <p>${job.status === "ready_for_human"
          ? "确认是否接受这份 Review 草稿。接受或驳回都只记录本地结论，不会直接写入 GitHub；如有发布动作，会另行逐项确认。"
          : "核对将要发布到 GitHub 的完整 Review、账号和绑定 Head，并决定确认发布、驳回或稍后处理。"}</p>
        <button type="button" class="refresh-button" data-pr-job-confirmation="${escapeHtml(job.id)}">处理这项确认</button>
      </section>`
    : "";
  dialogContent.innerHTML = `
    <article class="detail employee-detail">
      <p class="eyebrow">PR EMPLOYEE / ${escapeHtml(jobStateLabel(job.status))}</p>
      <h2>${escapeHtml(job.repo)} #${job.number} · ${escapeHtml(job.title)}</h2>
      ${historical ? "<p>这是历史作业。以下判断和触发原因记录的是当时的 PR 状态，不代表当前仍需处理。</p>" : ""}
      ${summary ? `<p>${historical ? "当时判断：" : ""}${escapeHtml(summary)}</p>` : ""}
      <h3>依据</h3>
      ${listMarkup(job.evidence)}
      <h3>建议步骤</h3>
      ${listMarkup(job.steps)}
      ${review}
      <dl class="detail-grid">
        <dt>触发原因</dt><dd>${escapeHtml(job.triggerReason || "")}</dd>
        <dt>当前 Head</dt><dd>${escapeHtml(job.headRefOid || "")}</dd>
        <dt>岗位大脑</dt><dd>${escapeHtml(job.brain?.provider || "")} / ${escapeHtml(job.brain?.model || "未记录")}</dd>
        <dt>状态</dt><dd>${escapeHtml(jobStateLabel(job.status))}</dd>
      </dl>
      ${confirmationAction}
      ${recovery}
      ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">在 GitHub 中打开 →</a>` : ""}
    </article>`;
  dialogContent
    .querySelector("[data-pr-job-recovery]")
    ?.addEventListener("click", handleBlockedJobResolution);
  dialogContent
    .querySelector("[data-pr-job-confirmation]")
    ?.addEventListener("click", handleRoleConfirmations);
  dialog.showModal();
}

function closeBlockedJobDialog(container) {
  if (container?.isConnected) closeDetailDialog();
}

async function handleBlockedJobResolution(event) {
  const button = event.target.closest("[data-pr-job-action]");
  if (!button) return;
  const container = button.closest("[data-pr-job-recovery]");
  const recoveryIntent = {
    id: container?.dataset.prJobRecovery || "",
    headRefOid: container?.dataset.headRefOid || "",
    expectedRevision: Number(container?.dataset.expectedRevision),
  };
  const job = jobIndex.get(recoveryIntent.id);
  const action = button.dataset.prJobAction;
  const actionIsCurrent = prEmployeeBlockedActions(job).some(
    (candidate) => candidate.id === action,
  );
  if (
    !actionIsCurrent ||
    !isPrEmployeeRecoveryIntentCurrent(
      recoveryIntent,
      job,
      dashboard?.employee?.role?.revision,
    )
  ) {
    closeBlockedJobDialog(container);
    statusBanner.hidden = false;
    statusBanner.textContent = "该失败作业已变化，请打开最新状态后再操作。";
    return;
  }
  container.querySelectorAll("button").forEach((control) => {
    control.disabled = true;
  });
  const sequence = ++requestSequence;
  const recoveryRequest = { ...recoveryIntent, action };
  try {
    const response = await fetch("/api/pr-review-jobs/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify(recoveryRequest),
    });
    if (response.status === 409) {
      const nextDashboard = await fetchDashboard();
      if (nextDashboard) applyDashboard(nextDashboard, sequence);
      closeBlockedJobDialog(container);
      statusBanner.hidden = false;
      statusBanner.textContent = "该失败作业对应的 PR 已变化，请查看最新状态。";
      return;
    }
    if (!response.ok) throw new Error(`失败作业恢复失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    closeBlockedJobDialog(container);
    statusBanner.hidden = false;
    statusBanner.textContent = action === "retry"
      ? "已重新加入分析队列；岗位会按调度尽快处理。"
      : "已关闭当前失败；同一 PR 出现新 Head 或新动作时仍会重新处理。";
    void loadEmployeeRoles();
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    container.querySelectorAll("button").forEach((control) => {
      control.disabled = false;
    });
  }
}

function applyDashboard(
  nextDashboard,
  sequence,
  { renderView = true } = {},
) {
  if (!nextDashboard || sequence < lastAppliedRequest) return false;
  lastAppliedRequest = sequence;
  dashboard = nextDashboard;
  updateChrome();
  if (renderView) render();
  return true;
}

function applyConfirmationQueue(nextState, sequence = ++confirmationRequestSequence) {
  if (
    !nextState ||
    sequence < confirmationRequestSequence ||
    sequence < lastAppliedConfirmationRequest
  ) return false;
  lastAppliedConfirmationRequest = sequence;
  confirmationQueueState = {
    available: Boolean(nextState.available),
    source: nextState.source || null,
    externalEnabled: Boolean(nextState.externalEnabled),
    queueRevision:
      nextState.externalQueueRevision || nextState.queueRevision || 0,
    pendingCount: nextState.pendingCount || 0,
    automaticReviewEnabled: nextState.automaticReviewEnabled === true,
    systemManagedCount: nextState.systemManagedCount || 0,
    item: nextState.item || null,
  };
  confirmationQueueLoaded = true;
  void reconcileActiveExternalConfirmation();
  void reconcileActiveInternalConfirmation();
  return true;
}

function invalidateConfirmationQueueSnapshot(
  sequence = ++confirmationRequestSequence,
) {
  if (
    sequence < confirmationRequestSequence ||
    sequence < lastAppliedConfirmationRequest
  ) return false;
  lastAppliedConfirmationRequest = sequence;
  confirmationQueueLoaded = false;
  confirmationQueueState = {
    available: false,
    source: null,
    externalEnabled: false,
    queueRevision: 0,
    pendingCount: 0,
    item: null,
  };
  return true;
}

async function handleEmployeeControl(event) {
  const button = event.currentTarget;
  const command = button.dataset.employeeControl;
  button.disabled = true;
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/employees/pr-reviewer/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        command,
        expectedRevision: dashboard.employee.role.revision,
      }),
    });
    if (!response.ok) throw new Error(`员工控制失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    void loadEmployeeRoles();
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
  }
}

async function handleEmployeeRun(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "巡查中…";
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/employees/pr-reviewer/run", {
      method: "POST",
      headers: { "x-mydashboard-action": "1" },
    });
    if (!response.ok) throw new Error(`主动巡查失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    void loadEmployeeRoles();
    await refreshConfirmationQueue({ showConfirmation: false });
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
    button.textContent = "立即巡查";
  }
}

async function loadEmployeeRoles() {
  if (currentView === "employees") void loadMaintenanceAttention();
  const sequence = ++employeeRolesRequestSequence;
  employeeRolesAbortController?.abort();
  const controller = new AbortController();
  employeeRolesAbortController = controller;
  try {
    const response = await fetch("/api/employees", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`读取岗位失败（${response.status}）`);
    const payload = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== employeeRolesRequestSequence ||
      sequence < lastAppliedEmployeeRolesRequest
    ) {
      return false;
    }
    lastAppliedEmployeeRolesRequest = sequence;
    employeeRoles = Array.isArray(payload.items) ? payload.items : [];
    employeeRolesLoaded = true;
    employeeRolesError = "";
    if (dashboard && currentView === "employees") render();
    return true;
  } catch (error) {
    if (
      controller.signal.aborted ||
      error?.name === "AbortError" ||
      sequence !== employeeRolesRequestSequence
    ) {
      return false;
    }
    employeeRolesLoaded = true;
    employeeRolesError = error.message || "读取岗位失败";
    if (dashboard && currentView === "employees") render();
    return false;
  } finally {
    if (employeeRolesAbortController === controller) {
      employeeRolesAbortController = null;
    }
  }
}

function loadMaintenanceAttention({ afterCurrent = false } = {}) {
  if (maintenanceReadInFlight) {
    return afterCurrent
      ? maintenanceReadInFlight.then(() => loadMaintenanceAttention())
      : maintenanceReadInFlight;
  }
  const tracked = readMaintenanceAttention().finally(() => {
    if (maintenanceReadInFlight === tracked) maintenanceReadInFlight = null;
  });
  maintenanceReadInFlight = tracked;
  return tracked;
}

async function readMaintenanceAttention() {
  const sequence = ++maintenanceRequestSequence;
  try {
    const response = await fetch("/api/attention/maintenance", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`读取系统故障失败（${response.status}）`);
    const payload = await response.json();
    if (!Array.isArray(payload.items) || !Number.isSafeInteger(payload.total) || payload.total < payload.items.length) {
      throw new Error("系统故障列表格式无效");
    }
    if (sequence !== maintenanceRequestSequence) return;
    const next = { items: payload.items, total: payload.total, loaded: true, error: "" };
    if (JSON.stringify(next) === JSON.stringify(maintenanceAttention)) return;
    maintenanceAttention = next;
  } catch (error) {
    if (sequence !== maintenanceRequestSequence) return;
    maintenanceAttention = { ...maintenanceAttention, loaded: true, error: error.message || "读取系统故障失败" };
  }
  if (dashboard && currentView === "employees") render();
}

async function handleRoleControl(event) {
  const button = event.currentTarget;
  const roleId = button.dataset.roleId;
  button.disabled = true;
  const sequence = ++requestSequence;
  try {
    const response = await fetch(`/api/employees/${encodeURIComponent(roleId)}/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        command: button.dataset.roleControl,
        expectedRevision: Number(button.dataset.roleRevision),
      }),
    });
    if (!response.ok) throw new Error(`岗位控制失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    void loadEmployeeRoles();
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
  }
}

async function handleRoleRun(event) {
  const button = event.currentTarget;
  const roleId = button.dataset.roleRun;
  button.disabled = true;
  button.textContent = "运行中…";
  const sequence = ++requestSequence;
  try {
    const response = await fetch(`/api/employees/${encodeURIComponent(roleId)}/run`, {
      method: "POST",
      headers: { "x-mydashboard-action": "1" },
    });
    if (!response.ok) throw new Error(`岗位运行失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    void loadEmployeeRoles();
    await refreshConfirmationQueue({ showConfirmation: false });
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
    button.textContent = "立即运行";
  }
}

function handleRoleWork(event) {
  const roleId = event.currentTarget.dataset.roleWork;
  workView.setRoleFilter(roleId);
  activateView("work");
}

async function handleRoleConfirmations(event) {
  const jobId = event?.currentTarget?.dataset?.prJobConfirmation || "";
  const requestedJob = jobId ? jobIndex.get(jobId) : null;
  if (dialog.open) closeDetailDialog();
  activateView("employees");
  content.querySelector("#confirmation-pending-panel")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
  if (!requestedJob) {
    showNextConfirmation();
    return;
  }
  try {
    await showJobConfirmation(requestedJob);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = `${error.message}。该作业可能已经更新，请刷新后重试。`;
  }
}

function memoryTimestamp(date, endOfDay = false) {
  if (!date) return "";
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  return new Date(`${date}${suffix}`).toISOString();
}

function memoryQueryUrl(filters, cursor = null) {
  const params = new URLSearchParams({ limit: "50" });
  const values = {
    q: filters.query,
    roleId: filters.roleId,
    repository: filters.repository,
    eventType: filters.eventType,
    from: memoryTimestamp(filters.from),
    to: memoryTimestamp(filters.to, true),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return `/api/memory/query?${params}`;
}

function normalizedMemoryFilters(filters = {}) {
  return Object.fromEntries(
    Object.keys(memoryFilters).map((key) => [
      key,
      String(filters[key] || "").trim(),
    ]),
  );
}

function memoryFiltersEqual(left, right) {
  return Object.keys(memoryFilters).every((key) => left[key] === right[key]);
}

function memoryFiltersFromForm(form) {
  return normalizedMemoryFilters(
    form ? Object.fromEntries(new FormData(form)) : memoryFilters,
  );
}

function memoryAnswerFilters(filters) {
  return {
    query: filters.query,
    roleId: filters.roleId,
    repository: filters.repository,
    eventType: filters.eventType,
    from: memoryTimestamp(filters.from),
    to: memoryTimestamp(filters.to, true),
  };
}

function isAbortedRequest(error, controller) {
  return controller.signal.aborted || error?.name === "AbortError";
}

function cancelMemoryAnswerRequest() {
  memoryAnswerRequestSequence += 1;
  memoryAnswerAbortController?.abort();
  memoryAnswerAbortController = null;
  memoryAnswerPending = false;
}

function normalizedConfirmationHistoryFilters(filters = {}) {
  const status = String(filters.status || "").trim();
  const kind = String(filters.kind || "").trim();
  const roleId = String(filters.roleId || "").trim();
  const allowedStatuses = new Set(
    confirmationHistoryStatuses.map(([value]) => value),
  );
  const allowedKinds = new Set(
    confirmationHistoryKinds.map(([value]) => value),
  );
  return {
    status: allowedStatuses.has(status) ? status : "",
    kind: allowedKinds.has(kind) ? kind : "",
    roleId: validConfirmationHistoryRoleId(roleId) ? roleId : "",
    ...(filters.automatic === true || filters.automatic === "true" ? { automatic: "true" } : {}),
  };
}

function normalizedConfirmationHistoryRoleIdFacets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validConfirmationHistoryRoleId))]
    .sort(compareConfirmationHistoryRoleIds)
    .slice(0, CONFIRMATION_HISTORY_ROLE_FACET_LIMIT);
}

function confirmationHistoryFiltersFromForm(form) {
  return normalizedConfirmationHistoryFilters(
    form
      ? Object.fromEntries(new FormData(form))
      : confirmationHistoryFilters,
  );
}

function sameConfirmationHistoryFilters(left, right) {
  return ["status", "kind", "roleId", "automatic"].every(
    (key) => left[key] === right[key],
  );
}

function normalizedConfirmationHistoryItems(value) {
  if (!Array.isArray(value)) return [];
  const allowedStatuses = new Set(
    confirmationHistoryStatuses.map(([status]) => status).filter(Boolean),
  );
  const allowedKinds = new Set(
    confirmationHistoryKinds.map(([kind]) => kind).filter(Boolean),
  );
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const requestedBy = item.requestedBy;
    if (
      typeof item.id !== "string" ||
      !allowedStatuses.has(item.status) ||
      !allowedKinds.has(item.kind) ||
      !requestedBy ||
      typeof requestedBy !== "object" ||
      typeof requestedBy.roleId !== "string" ||
      typeof requestedBy.workItemId !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string"
    ) {
      return [];
    }
    const ownerDecision = item.ownerDecision;
    const reviewHandoff = normalizeReviewHandoffHistory(item.reviewHandoff);
    const validOwnerDecision =
      item.status === "rejected" &&
      ownerDecision &&
      typeof ownerDecision === "object" &&
      !Array.isArray(ownerDecision) &&
      Object.keys(ownerDecision).length === 2 &&
      ownerDecision.type === "seal_unknown_and_forbid_replay" &&
      typeof ownerDecision.at === "string";
    return [{
      id: item.id.slice(0, 128),
      kind: item.kind,
      status: item.status,
      requestedBy: {
        roleId: requestedBy.roleId.slice(0, 128),
        workItemId: requestedBy.workItemId.slice(0, 128),
      },
      title: typeof item.title === "string" ? item.title.slice(0, 1_024) : "",
      summary:
        typeof item.summary === "string" ? item.summary.slice(0, 4_096) : "",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      retryable: item.retryable === true,
      ...(["push", "code_task"].includes(item.automaticOwnPrRepair?.stage)
        ? { automaticOwnPrRepair: { stage: item.automaticOwnPrRepair.stage } } : {}),
      ...(item.automaticReview && ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(item.automaticReview.event) &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.automaticReview.headRefOid || "") &&
        /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(item.automaticReview.resourceId || "")
        ? { automaticReview: { event: item.automaticReview.event, headRefOid: item.automaticReview.headRefOid,
            url: (() => {
              const prUrl = `https://github.com/${item.automaticReview.resourceId.replace("#", "/pull/")}`;
              return typeof item.automaticReview.publishedUrl === "string" && item.automaticReview.publishedUrl.startsWith(`${prUrl}#pullrequestreview-`) && /^\d+$/.test(item.automaticReview.publishedUrl.slice(`${prUrl}#pullrequestreview-`.length)) ? item.automaticReview.publishedUrl : prUrl;
            })() } } : {}),
      ...(reviewHandoff ? { reviewHandoff } : {}),
      ...(typeof item.diagnosticCode === "string" &&
          /^[A-Z][A-Z0-9_]{2,63}$/.test(item.diagnosticCode)
        ? { diagnosticCode: item.diagnosticCode }
        : {}),
      ...(validOwnerDecision
        ? {
            ownerDecision: {
              type: ownerDecision.type,
              at: ownerDecision.at,
            },
          }
        : {}),
    }];
  });
}

function updateConfirmationHistoryView({ syncFilters = false } = {}) {
  const panel = content.querySelector("#confirmation-history-panel");
  if (!panel) return false;

  panel.setAttribute("aria-busy", String(confirmationHistoryLoading));
  const meta = panel.querySelector("#confirmation-history-meta");
  if (meta) meta.textContent = confirmationHistoryMetaText();

  const form = panel.querySelector("#confirmation-history-filter");
  const status = form?.querySelector("#confirmation-history-status");
  const kind = form?.querySelector("#confirmation-history-kind");
  const role = form?.querySelector("#confirmation-history-role");
  if (syncFilters && status) status.value = confirmationHistoryFilters.status;
  if (syncFilters && kind) kind.value = confirmationHistoryFilters.kind;
  const automatic = form?.querySelector("#confirmation-history-automatic");
  if (syncFilters && automatic) automatic.value = confirmationHistoryFilters.automatic || "";
  if (role) {
    const options = confirmationHistoryRoleOptionsMarkup();
    if (role.innerHTML !== options) role.innerHTML = options;
    if (syncFilters) role.value = confirmationHistoryFilters.roleId;
  }

  const error = panel.querySelector("#confirmation-history-error");
  if (error) {
    error.textContent = confirmationHistoryError;
    error.hidden = !confirmationHistoryError;
  }

  const results = panel.querySelector("#confirmation-history-results");
  if (results) {
    const markup = confirmationHistoryMarkup();
    if (results.innerHTML !== markup) results.innerHTML = markup;
  }

  const loadMore = panel.querySelector("#confirmation-history-load-more");
  if (loadMore) {
    loadMore.hidden = !confirmationHistoryPaginationVisible();
    loadMore.setAttribute(
      "aria-disabled",
      String(confirmationHistoryLoading || !confirmationHistoryNextCursor),
    );
    loadMore.textContent = confirmationHistoryPaginationLabel();
  }
  return true;
}

async function loadConfirmationHistory(
  filters = confirmationHistoryFilters,
  { append = false } = {},
) {
  const normalized = normalizedConfirmationHistoryFilters(filters);
  const cursor = append ? confirmationHistoryNextCursor : null;
  if (append && !cursor) return false;
  const filtersChanged = !sameConfirmationHistoryFilters(
    normalized,
    confirmationHistoryFilters,
  );
  const sequence = ++confirmationHistoryRequestSequence;
  confirmationHistoryAbortController?.abort();
  const controller = new AbortController();
  confirmationHistoryAbortController = controller;
  confirmationHistoryFilters = normalized;
  if (!append && filtersChanged) {
    confirmationHistoryItems = [];
    confirmationHistoryNextCursor = null;
    confirmationHistoryLoaded = false;
  }
  confirmationHistoryLoading = true;
  confirmationHistoryError = "";
  updateConfirmationHistoryView();
  try {
    const params = new URLSearchParams({
      limit: String(CONFIRMATION_HISTORY_PAGE_SIZE),
    });
    for (const [key, value] of Object.entries(normalized)) {
      if (value) params.set(key, value);
    }
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/confirmations/history?${params}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`读取确认历史失败（${response.status}）`);
    }
    const result = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== confirmationHistoryRequestSequence ||
      sequence < lastAppliedConfirmationHistoryRequest
    ) {
      return false;
    }
    lastAppliedConfirmationHistoryRequest = sequence;
    const pageItems = normalizedConfirmationHistoryItems(result.items);
    confirmationHistoryRoleIdFacets = normalizedConfirmationHistoryRoleIdFacets(
      result.roleIdFacets,
    );
    confirmationHistoryItems = append
      ? [
          ...new Map(
            [...confirmationHistoryItems, ...pageItems].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ]
      : pageItems;
    confirmationHistoryNextCursor =
      typeof result.nextCursor === "string" &&
      /^[A-Za-z0-9_-]{16,512}$/.test(result.nextCursor)
        ? result.nextCursor
        : null;
    confirmationHistoryQueueRevision =
      Number.isSafeInteger(result.queueRevision) && result.queueRevision >= 0
        ? result.queueRevision
        : null;
    confirmationHistoryAvailable = result.available !== false;
    confirmationHistoryLoaded = true;
    confirmationHistoryLoading = false;
    confirmationHistoryError = "";
    updateConfirmationHistoryView();
    return true;
  } catch (error) {
    if (isAbortedRequest(error, controller)) return false;
    if (sequence === confirmationHistoryRequestSequence) {
      confirmationHistoryLoaded = true;
      confirmationHistoryLoading = false;
      confirmationHistoryError = error.message || "读取确认历史失败";
      updateConfirmationHistoryView();
    }
    throw error;
  } finally {
    if (confirmationHistoryAbortController === controller) {
      confirmationHistoryAbortController = null;
    }
  }
}

async function applyConfirmationHistoryFilters(event) {
  event.preventDefault();
  try {
    await loadConfirmationHistory(
      confirmationHistoryFiltersFromForm(event.currentTarget),
    );
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

async function loadMoreConfirmationHistory() {
  if (confirmationHistoryLoading || !confirmationHistoryNextCursor) return;
  try {
    await loadConfirmationHistory(confirmationHistoryFilters, {
      append: true,
    });
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

async function loadMemories(
  filters = memoryFilters,
  { append = false, resetAnswer = false } = {},
) {
  const normalized = normalizedMemoryFilters(filters);
  const cursor = append ? memoryNextCursor : null;
  const sequence = ++memorySearchRequestSequence;
  memorySearchAbortController?.abort();
  const controller = new AbortController();
  memorySearchAbortController = controller;
  try {
    const response = await fetch(memoryQueryUrl(normalized, cursor), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`记忆搜索失败（${response.status}）`);
    const result = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== memorySearchRequestSequence ||
      sequence < lastAppliedMemorySearchRequest
    ) {
      return false;
    }
    lastAppliedMemorySearchRequest = sequence;
    memoryFilters = normalized;
    memoryResults = append
      ? [...memoryResults, ...(result.items || [])]
      : result.items || [];
    memoryNextCursor = result.nextCursor || null;
    memoryTotalMatched = Number(result.totalMatched) || 0;
    memoryIndexHealthy = result.indexHealthy !== false;
    memoryLoaded = true;
    if (resetAnswer) {
      memoryAnswerResult = null;
      memoryAnswerPending = false;
    }
    if (currentView === "memory") render();
    return true;
  } catch (error) {
    if (isAbortedRequest(error, controller)) return false;
    throw error;
  } finally {
    if (memorySearchAbortController === controller) {
      memorySearchAbortController = null;
    }
  }
}

function memoryAnswerRequest({ question, mode, filters, context }) {
  const retrieval = mode === "local"
    ? {
        kind: "context",
        contextDigest: memoryString(context?.contextDigest),
        recordIds: memoryStringArray(context?.recordIds),
      }
    : {
        kind: "query",
        filters: memoryAnswerFilters(filters),
      };
  return {
    schemaVersion: 1,
    question,
    mode,
    retrieval,
  };
}

async function loadMemoryAnswer(request) {
  const sequence = ++memoryAnswerRequestSequence;
  memoryAnswerAbortController?.abort();
  const controller = new AbortController();
  memoryAnswerAbortController = controller;
  memoryQuestion = request.question;
  memoryAnswerPending = true;
  if (request.retrieval.kind === "query") memoryAnswerResult = null;
  statusBanner.hidden = true;
  if (currentView === "memory") render();
  try {
    const response = await fetch("/api/memory/answer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`记忆问答失败（${response.status}）`);
    const result = await response.json();
    if (
      controller.signal.aborted ||
      sequence !== memoryAnswerRequestSequence ||
      sequence < lastAppliedMemoryAnswerRequest
    ) {
      return false;
    }
    lastAppliedMemoryAnswerRequest = sequence;
    memoryAnswerResult = result;
    memoryAnswerPending = false;
    if (currentView === "memory") render();
    return true;
  } catch (error) {
    if (isAbortedRequest(error, controller)) return false;
    if (sequence === memoryAnswerRequestSequence) {
      memoryAnswerPending = false;
      if (currentView === "memory") render();
    }
    throw error;
  } finally {
    if (memoryAnswerAbortController === controller) {
      memoryAnswerAbortController = null;
    }
  }
}

async function handleMemorySearch(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  cancelMemoryAnswerRequest();
  try {
    await loadMemories(memoryFiltersFromForm(form), { resetAnswer: true });
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    if (currentView === "memory") render();
    submit.disabled = false;
  }
}

async function handleMemoryQuestion(event) {
  event.preventDefault();
  const question = String(new FormData(event.currentTarget).get("question") || "").trim();
  if (!question) {
    statusBanner.hidden = false;
    statusBanner.textContent = "请输入要向本地记忆提出的问题";
    return;
  }
  memoryQuestion = question;
  const filters = memoryFiltersFromForm(
    content.querySelector("#memory-search-form"),
  );
  cancelMemoryAnswerRequest();
  try {
    const searchNeedsSynchronization =
      memorySearchAbortController !== null ||
      !memoryFiltersEqual(filters, memoryFilters);
    if (
      searchNeedsSynchronization &&
      !(await loadMemories(filters, { resetAnswer: true }))
    ) {
      return;
    }
    await loadMemoryAnswer(
      memoryAnswerRequest({ question, mode: "configured", filters }),
    );
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

async function handleMemoryLocalRerun() {
  const context = memoryAnswerResult?.context;
  const question = memoryString(context?.question);
  if (!question) return;
  try {
    await loadMemoryAnswer(
      memoryAnswerRequest({ question, mode: "local", context }),
    );
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

async function handleMemoryLoadMore(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadMemories(memoryFilters, { append: true });
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    button.disabled = false;
  }
}

function showDetail(item) {
  if (!item) return;
  codeJobDetailFocusIntent = null;
  dialogContent.innerHTML = `
    <article class="detail">
      <p class="eyebrow">${kindLabel(item)} / EVIDENCE</p>
      ${item.summaryStatus
        ? `<h2>${escapeHtml(item.context || "钉钉今日摘要")}</h2>`
        : item.kind === "announcement"
        ? announcementDetailMarkup(item.title)
        : `<h2>${escapeHtml(item.title)}</h2>`}
      ${dingtalkDetailMarkup(item)}
      ${prLifecycleStatusMarkup(item)}
      ${brainAssessment(item)}
      ${issuePrDetailMarkup(item)}
      ${githubItemDetailMarkup(item)}
      <dl class="detail-grid">${detailRows(item)}</dl>
      ${item.url ? `<a class="detail-source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${["issue", "pull_request"].includes(item.kind) ? "在 GitHub 查看完整内容" : "在来源中打开"} →</a>` : ""}
      ${["pull_request", "issue"].includes(item.kind) ? '<div data-manual-work-assignment-container></div>' : ""}
    </article>`;
  dialog.showModal();
  return bindManualWorkAssignment(
    dialogContent.querySelector("[data-manual-work-assignment-container]"), item,
    { fetchImpl: fetch, attempts: manualWorkAssignmentAttempts },
  );
}

function codeJobActionFocusIntent(element) {
  if (!element?.matches || !dialogContent.contains(element)) return null;
  if (element.matches("[data-code-job-control]")) {
    return { type: "control", command: element.dataset.codeJobControl };
  }
  if (element.matches("[data-code-job-history-more]")) {
    return { type: "history" };
  }
  if (element.matches("[data-code-job-package]")) {
    return { type: "package" };
  }
  if (element.matches("[data-code-job-apply]")) {
    return { type: "apply" };
  }
  return null;
}

function codeJobFocusSelectors(intent) {
  if (intent?.type === "control") {
    const sameCommand = ["pause", "resume", "cancel"].includes(intent.command)
      ? intent.command
      : null;
    if (sameCommand === null) return [];
    return [
      `[data-code-job-control="${sameCommand}"]`,
      "[data-code-job-control]",
    ];
  }
  if (intent?.type === "history") return ["[data-code-job-history-more]"];
  if (intent?.type === "package") {
    return ["[data-code-job-package]", "[data-code-job-apply]"];
  }
  if (intent?.type === "apply") return ["[data-code-job-apply]"];
  return [];
}

function restoreCodeJobDetailFocus() {
  if (!codeJobDetailFocusIntent || !dialog.open) return;
  const candidate = codeJobFocusSelectors(codeJobDetailFocusIntent)
    .map((selector) => dialogContent.querySelector(selector))
    .find((element) => element && !element.disabled && !element.closest("[hidden]"));
  (candidate || detailCloseButton).focus({ preventScroll: true });
}

function showCodeJobDetail(markup) {
  const activeIntent = codeJobActionFocusIntent(document.activeElement);
  if (activeIntent) codeJobDetailFocusIntent = activeIntent;
  dialogContent.innerHTML = markup;
  dialogContent.querySelectorAll("[data-code-job-control]").forEach((button) => {
    button.addEventListener("click", () => {
      codeJobDetailFocusIntent = codeJobActionFocusIntent(button);
      workView.controlCodeJob(button.dataset.codeJobControl);
    });
  });
  dialogContent.querySelector("[data-code-job-history-more]")?.addEventListener(
    "click",
    (event) => {
      codeJobDetailFocusIntent = codeJobActionFocusIntent(event.currentTarget);
      workView.loadMoreCodeJobObservations();
    },
  );
  dialogContent.querySelector("[data-code-job-package]")?.addEventListener(
    "click",
    (event) => {
      codeJobDetailFocusIntent = codeJobActionFocusIntent(event.currentTarget);
      workView.loadCodeJobChangePackage();
    },
  );
  dialogContent.querySelector("[data-code-job-apply]")?.addEventListener(
    "click",
    (event) => {
      codeJobDetailFocusIntent = codeJobActionFocusIntent(event.currentTarget);
      workView.requestCodeJobChangePackageApply();
    },
  );
  if (!dialog.open) dialog.showModal();
  restoreCodeJobDetailFocus();
}

function closeDetailDialog() {
  codeJobDetailFocusIntent = null;
  workView.closeDetail();
  if (dialog.open) dialog.close();
}

function confirmationKey(kind, item) {
  return `${kind}\u0000${item.id}\u0000${item.headRefOid || ""}`;
}

function setConfirmationButtonsDisabled(disabled) {
  confirmationContent.querySelectorAll("button, select").forEach((control) => {
    control.disabled = disabled;
  });
}

function beginConfirmationSubmission(setContentControlsDisabled) {
  const owner = confirmationDialogOwnership.current();
  if (!confirmationDialogOwnership.beginSubmission(owner)) return null;
  setContentControlsDisabled(true);
  confirmationCloseButton.disabled = true;
  return owner;
}

function restoreConfirmationSubmission(owner, setContentControlsDisabled) {
  if (!confirmationDialogOwnership.finishSubmission(owner)) return false;
  setContentControlsDisabled(false);
  confirmationCloseButton.disabled = false;
  return true;
}

function closeConfirmationSubmission(owner) {
  if (!confirmationDialogOwnership.ownsSubmission(owner)) return false;
  return closeConfirmationDialog(owner);
}

function beginExternalConfirmationSubmission(button, operation) {
  const owner = beginConfirmationSubmission(setConfirmationButtonsDisabled);
  if (owner === null) return null;
  const actions = button.closest(".confirmation-actions");
  if (actions) actions.setAttribute("aria-busy", "true");
  button.dataset.externalIdleLabel = button.textContent;
  button.textContent =
    operation === "reject" && activeExternalConfirmation?.resolutionRequired === true
      ? "正在封存…"
      : "正在提交…";
  return owner;
}

function restoreExternalConfirmation(owner) {
  if (!restoreConfirmationSubmission(owner, setConfirmationButtonsDisabled)) {
    return false;
  }
  confirmationContent
    .querySelector(".confirmation-actions")
    ?.removeAttribute("aria-busy");
  const button = confirmationContent.querySelector("[data-external-idle-label]");
  if (button) {
    button.textContent = button.dataset.externalIdleLabel;
    delete button.dataset.externalIdleLabel;
  }
  return true;
}

function closeConfirmationDialog(
  owner = confirmationDialogOwnership.current(),
) {
  if (owner !== null && !confirmationDialogOwnership.close(owner)) return false;
  confirmationCloseButton.disabled = false;
  if (confirmationDialog.open) confirmationDialog.close();
  return true;
}

function closeExternalConfirmation(owner) {
  if (!closeConfirmationSubmission(owner)) return false;
  activeConfirmationKey = "";
  activeExternalConfirmation = null;
  return true;
}

const reconcileActiveExternalConfirmation = createExternalConfirmationReconciler({
  getCurrent() {
    const owner = confirmationDialogOwnership.current();
    if (!confirmationDialog.open || !activeExternalConfirmation || owner === null) return null;
    return { owner, key: activeConfirmationKey, item: activeExternalConfirmation,
      requestSequence: lastAppliedConfirmationRequest,
      submitting: confirmationDialogOwnership.ownsSubmission(owner),
      automaticReviewEnabled: confirmationQueueState.automaticReviewEnabled };
  },
  async readItem(id) {
    const response = await fetch(`/api/confirmations/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json();
    return result.available === true ? result.item : null;
  },
  onResolved(owner) {
    if (!closeConfirmationDialog(owner)) return false;
    activeExternalConfirmation = null;
    activeConfirmationKey = "";
    invalidateConfirmationQueueSnapshot();
    statusBanner.hidden = false;
    statusBanner.textContent = "这项确认已由系统接管、处理或失效，旧弹窗已关闭。";
    void refreshConfirmationQueue().catch(error => { statusBanner.textContent = error.message; });
    return true;
  },
});

const reconcileActiveInternalConfirmation = createInternalConfirmationReconciler({
  getCurrent() {
    const owner = confirmationDialogOwnership.current();
    if (!confirmationDialog.open || !activeInternalAttention || owner === null) return null;
    return { owner, key: activeConfirmationKey, item: activeInternalAttention,
      requestSequence: lastAppliedConfirmationRequest,
      submitting: confirmationDialogOwnership.ownsSubmission(owner) };
  },
  async readItem(id) {
    const response = await fetch(`/api/attention/internal/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()).item ?? null;
  },
  onResolved(owner) {
    if (!closeConfirmationDialog(owner)) return false;
    activeInternalAttention = null;
    activeConfirmationKey = "";
    invalidateConfirmationQueueSnapshot();
    statusBanner.hidden = false;
    statusBanner.textContent = "这项请示已处理或归档，旧弹窗已关闭。";
    void refreshConfirmationQueue().catch(error => { statusBanner.textContent = error.message; });
    return true;
  },
});

function pendingConfirmations() {
  if (!confirmationQueueLoaded) return [];
  const externalActions =
    confirmationQueueState.source === "external_confirmation" &&
    confirmationQueueState.item
    ? [
        {
          kind: "external_action",
          item: confirmationQueueState.item,
          key: `external\u0000${confirmationQueueState.item.id}\u0000${confirmationQueueState.item.approvalBindingDigest}`,
        },
      ]
    : [];
  const internalRequests =
    confirmationQueueState.source === "internal_request" &&
    confirmationQueueState.item
      ? [
          {
            kind: "internal_request",
            item: confirmationQueueState.item,
            key: `internal\u0000${confirmationQueueState.item.requestId}\u0000${confirmationQueueState.item.contentDigest}`,
          },
        ]
      : [];
  const responsibilities = dashboard
    ? pullRequestGroups().uncertain.map((item) => ({
        kind: "responsibility",
        item,
        key: confirmationKey("responsibility", item),
      }))
    : [];
  const legacyReviewDrafts = confirmationQueueState.externalEnabled
    ? []
    : dashboard
      ? (dashboard.employee?.confirmationQueue || []).map((job) => ({
          kind: "review_draft",
          job,
          key: confirmationKey("review", job),
        }))
      : [];
  return [
    ...externalActions,
    ...responsibilities,
    ...internalRequests,
    ...legacyReviewDrafts,
  ].filter(
    (entry) => !deferredConfirmations.has(entry.key),
  );
}

function showResponsibilityConfirmation(entry, remaining) {
  const { item } = entry;
  confirmationContent.innerHTML = `
    <article class="confirmation">
      <p class="eyebrow">CONFIRMATION QUEUE / ${remaining} LEFT</p>
      <h2>这条 PR 现在轮到谁？</h2>
      <p class="confirmation-title">${escapeHtml(item.repo)} #${item.number} · ${escapeHtml(item.title)}</p>
      <p class="confirmation-reason">${escapeHtml(item.actionReasons?.[0] || "现有事实不足以可靠判断责任归属。")}</p>
      ${brainAssessment(item)}
      <div class="confirmation-actions" data-confirmation-id="${escapeHtml(item.id)}" data-head-ref-oid="${escapeHtml(item.headRefOid)}">
        <button data-decision="action_now">现在轮到我</button>
        <button data-decision="waiting_other">等待别人</button>
        <button data-decision="historical">归入历史清理</button>
        <button class="secondary" data-decision="later">稍后再问</button>
      </div>
      <p class="confirmation-note">确认只保存在本机，并绑定当前提交；出现新提交后会重新判断。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleConfirmation);
}

function reviewEventLabel(value) {
  return {
    APPROVE: "Approve",
    REQUEST_CHANGES: "Request changes",
    COMMENT: "Comment Review",
  }[value] || value || "未知动作";
}

function reviewHandoffPullRequest(item) {
  const target = item?.display?.payload?.target || item?.target || {};
  const match = /^([^#]+)#([1-9]\d*)$/.exec(target.resourceId || "");
  if (!match) return null;
  const groups = dashboard?.groups || {};
  return uniqueItems(
    Object.values(groups).flatMap((value) => Array.isArray(value) ? value : []),
  ).find((candidate) =>
    candidate.kind === "pull_request" &&
    candidate.repo === match[1] &&
    candidate.number === Number(match[2])
  ) || null;
}

function reviewHandoffLifecycle(reviewEvent, item) {
  const reviewIntent = item?.display?.payload?.reviewIntent;
  return prReviewLifecycleRoute(
    reviewHandoffPullRequest(item),
    reviewIntent || reviewEvent,
  );
}

function reviewFollowUpLabel(reviewEvent, item) {
  return reviewHandoffLifecycle(reviewEvent, item).summary;
}

function reviewHandoffSearchText(item) {
  return JSON.stringify({
    title: item?.display?.title,
    summary: item?.display?.summary,
    evidence: item?.display?.evidence,
    action: item?.display?.payload?.action,
  });
}

function configuredOwnerOptions(routing, product, selectedLogin = "") {
  return (routing.ownersByProduct[product] || []).map((login, index) =>
    `<option value="${escapeHtml(login)}"${login === selectedLogin || (!selectedLogin && index === 0) ? " selected" : ""}>${escapeHtml(routing.ownerLabel(login))}</option>`
  ).join("");
}

function reviewHandoffMarkup(reviewEvent, item) {
  if (item.reviewHandoff) return `<section class="review-handoff"><strong>已确认的交接选择</strong><p>${escapeHtml(reviewHandoffStatusText(item))}</p><small>交接选择已绑定本次批准，重试不会更换负责人。</small></section>`;
  if (item.status !== "pending") return '<section class="review-handoff"><small>本次历史批准未绑定交接选择；重试仅恢复原动作。发布完成后可在 PR 卡片手动分配。</small></section>';
  const lifecycle = reviewHandoffLifecycle(reviewEvent, item);
  const selected = lifecycle.workType;
  const option = (value, label) => `<option value="${value}"${selected === value ? " selected" : ""}>${label}</option>`;
  const testingRouting = testingOwnerRouting(activeConfigurationDocument());
  const reviewerRouting = reviewerOwnerRouting(activeConfigurationDocument());
  const product = inferTestingProduct(
    reviewHandoffSearchText(item),
    testingRouting.products,
  );
  const reviewerProduct = inferTestingProduct(
    reviewHandoffSearchText(item),
    reviewerRouting.products,
  );
  const productOptions = testingRouting.products.map((candidate) =>
    `<option value="${escapeHtml(candidate)}"${candidate === product ? " selected" : ""}>${escapeHtml(testingRouting.productLabel(candidate))}</option>`
  ).join("");
  const reviewerProductOptions = reviewerRouting.products.map((candidate) =>
    `<option value="${escapeHtml(candidate)}"${candidate === reviewerProduct ? " selected" : ""}>${escapeHtml(reviewerRouting.productLabel(candidate))}</option>`
  ).join("");
  return `<section class="review-handoff">
    <div>
      <strong>发布后立即交接</strong>
      <small>${escapeHtml(lifecycle.summary)}</small>
      <span class="review-lifecycle-badge">${lifecycle.ownership === "self" ? "我的 PR" : lifecycle.ownership === "other" ? "别人的 PR" : "待核对所有权"} · ${escapeHtml(prLifecycleStageLabel(lifecycle.stage))}</span>
    </div>
    <label>下一责任岗位
      <select data-review-handoff data-review-responsible-kind="${escapeHtml(lifecycle.responsibleKind)}">
        ${option("testing", "测试工程师 · 验证后交回合并门禁")}
        ${option("development", "开发工程师 · 自己修复、测试并推送新 Head")}
        ${option("pull_request", lifecycle.responsibleKind === "external_reviewer" ? "其他 Reviewer · 外部审核" : "PR 工程师 · 跟踪作者修复并复审")}
        <option value="">不创建下一步任务</option>
      </select>
    </label>
    <div class="review-testing-owner" data-review-testing-owner${selected === "testing" ? "" : " hidden"}>
      <label>版本类型
        <select data-review-testing-product>${productOptions}</select>
      </label>
      <label>具体测试负责人
        <select data-review-testing-person>${configuredOwnerOptions(testingRouting, product)}</select>
      </label>
      <small data-review-testing-recommendation>已按 PR 内容推荐；可在此切换。候选账号来自配置中心；Review 发布成功后，GitHub Assignee 会转交给该测试负责人。</small>
    </div>
    <div class="review-testing-owner" data-review-external-owner${lifecycle.responsibleKind === "external_reviewer" ? "" : " hidden"}>
      <label>版本类型
        <select data-review-external-product>${reviewerProductOptions}</select>
      </label>
      <label>外部 Reviewer
        <select data-review-external-person>${configuredOwnerOptions(reviewerRouting, reviewerProduct)}</select>
      </label>
      <small>将创建绑定该 GitHub 账号的本地跟进任务；不会直接调用 GitHub 的 Request review。对方提出问题后，任务会回到自己的开发闭环。</small>
    </div>
  </section>`;
}

function bindReviewHandoffControls(item) {
  const root = confirmationContent.querySelector(".review-handoff");
  if (!root) return;
  const workType = root.querySelector("[data-review-handoff]");
  if (!workType) return;
  const testingRouting = testingOwnerRouting(activeConfigurationDocument());
  const reviewerRouting = reviewerOwnerRouting(activeConfigurationDocument());
  const ownerControls = root.querySelector("[data-review-testing-owner]");
  const product = root.querySelector("[data-review-testing-product]");
  const person = root.querySelector("[data-review-testing-person]");
  const reviewerControls = root.querySelector("[data-review-external-owner]");
  const reviewerProduct = root.querySelector("[data-review-external-product]");
  const reviewerPerson = root.querySelector("[data-review-external-person]");
  const updateVisibility = () => {
    ownerControls.hidden = workType.value !== "testing";
    reviewerControls.hidden = !(
      workType.value === "pull_request" &&
      workType.dataset.reviewResponsibleKind === "external_reviewer"
    );
  };
  workType.addEventListener("change", updateVisibility);
  product.addEventListener("change", () => {
    person.innerHTML = configuredOwnerOptions(testingRouting, product.value);
  });
  reviewerProduct.addEventListener("change", () => {
    reviewerPerson.innerHTML = configuredOwnerOptions(
      reviewerRouting,
      reviewerProduct.value,
    );
  });
  updateVisibility();
}

function pullRequestConfirmationActionType(kind) {
  return typeof kind === "string" &&
      Object.hasOwn(pullRequestConfirmationActionTypes, kind)
    ? pullRequestConfirmationActionTypes[kind]
    : null;
}

function pullRequestActionLabel(type) {
  return {
    pull_request_comment: "PR 评论",
    pull_request_review: "PR Review",
    pull_request_update_branch: "更新 PR 分支",
    pull_request_push: "推送受控 commit",
    pull_request_merge: "合并 PR",
  }[type] || "未知 PR 动作";
}

function mergeMethodLabel(value) {
  return {
    merge: "Merge commit",
    squash: "Squash and merge",
    rebase: "Rebase and merge",
  }[value] || value || "未知方式";
}

function pullRequestActionDetailRows(action, item) {
  const rows = [
    `<dt>动作</dt><dd>${escapeHtml(pullRequestActionLabel(action.type))}</dd>`,
  ];
  if (action.type === "pull_request_review") {
    const reviewIntent = item?.display?.payload?.reviewIntent;
    rows.push(
      `<dt>Review 类型</dt><dd>${escapeHtml(reviewEventLabel(action.reviewEvent))}${reviewIntent && reviewIntent !== action.reviewEvent ? `（内部结论：${escapeHtml(reviewEventLabel(reviewIntent))}）` : ""}</dd>`,
      `<dt>发布后由谁推进</dt><dd>${escapeHtml(reviewFollowUpLabel(action.reviewEvent, item))}</dd>`,
    );
  } else if (action.type === "pull_request_update_branch") {
    rows.push(
      `<dt>预期 Head</dt><dd><code>${escapeHtml(action.expectedHeadOid || "未知")}</code></dd>`,
      `<dt>预期 Base</dt><dd><code>${escapeHtml(action.expectedBaseOid || "未知")}</code></dd>`,
    );
  } else if (action.type === "pull_request_push") {
    rows.push(
      `<dt>当前远端 Head</dt><dd><code>${escapeHtml(action.expectedOldOid || "未知")}</code></dd>`,
      `<dt>目标分支</dt><dd>${escapeHtml(action.remote?.repository || "未知")} · <code>${escapeHtml(action.remote?.refName || "未知")}</code></dd>`,
      `<dt>受控 commit</dt><dd><code>${escapeHtml(action.controlledCommitEvidence?.commit?.oid || "未知")}</code></dd>`,
    );
  } else if (action.type === "pull_request_merge") {
    rows.push(
      `<dt>合并方式</dt><dd>${escapeHtml(mergeMethodLabel(action.method))}</dd>`,
      `<dt>预期 Head</dt><dd><code>${escapeHtml(action.expectedHeadOid || "未知")}</code></dd>`,
    );
  }
  return rows.join("");
}

function pullRequestActionBodyMarkup(action) {
  if (!["pull_request_comment", "pull_request_review"].includes(action.type)) {
    return "";
  }
  return `<div class="review-preview">
    <strong>将发布的完整正文</strong>
    <pre>${escapeHtml(action.body || "没有正文")}</pre>
  </div>`;
}

function pullRequestTargetMarkup(target) {
  const resourceId = target.resourceId || "未知";
  const url = githubTargetUrl({
    resourceId,
    resourceType: "pull_request",
  });
  if (url === null) return escapeHtml(resourceId);
  return `<a class="confirmation-target-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(resourceId)} · 在 GitHub 中打开 ↗</a>`;
}

function showGitHubActionConfirmation(entry, remaining) {
  const item = structuredClone(entry.item);
  const payload = item.display?.payload || {};
  const actor = payload.actor || item.actor || {};
  const target = payload.target || item.target || {};
  const action = payload.action || {};
  const expectedActionType = pullRequestConfirmationActionType(item.kind);
  if (expectedActionType === null || action.type !== expectedActionType) {
    showUnsupportedExternalConfirmation(entry, remaining);
    return;
  }
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  const operation = item.retryable ? "retry" : "approve";
  const actionLabel = item.retryable
    ? "确认并重试发布到 GitHub"
    : item.display?.actionLabel || "确认并发布到 GitHub";
  const primaryActionLabel = action.type === "pull_request_review"
    ? item.retryable ? "重试发布并分配下一步" : "确认发布并分配下一步"
    : actionLabel;
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation">
      <p class="eyebrow">EXTERNAL ACTION / ${remaining} LEFT</p>
      <h2>${escapeHtml(item.display?.title || "确认外部动作")}</h2>
      <p class="confirmation-reason">${escapeHtml(item.display?.summary || "确认后将执行外部写入")}</p>
      <dl class="detail-grid confirmation-grid">
        <dt>执行账号</dt><dd>${escapeHtml(actor.accountId || "未指定")}</dd>
        <dt>目标</dt><dd>${pullRequestTargetMarkup(target)}</dd>
        <dt>绑定 Head</dt><dd><code>${escapeHtml(target.version || "未知")}</code></dd>
        ${pullRequestActionDetailRows(action, item)}
      </dl>
      ${action.type === "pull_request_review" ? reviewHandoffMarkup(action.reviewEvent, item) : ""}
      ${pullRequestActionBodyMarkup(action)}
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="${operation}">${escapeHtml(primaryActionLabel)}</button>
        <button class="secondary" data-external-operation="reject">驳回，不发布</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">只有点击确认按钮才会执行当前这一项 GitHub 写入；发布成功后才创建所选的下一棒任务。动作、账号和 Head 均与本次展示内容绑定。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
  if (action.type === "pull_request_review") bindReviewHandoffControls(item);
}

function codeOperationLabel(value) {
  return {
    inspect: "检查代码",
    modify: "修改隔离副本",
    verify: "验证代码",
  }[value] || value || "未知操作";
}

function showCodeJobConfirmation(entry, remaining) {
  const item = structuredClone(entry.item);
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  const payload = item.display?.payload || {};
  const action = payload.action || {};
  const grant = action.grant || {};
  const operation = item.retryable ? "retry" : "approve";
  const actionLabel = item.retryable
    ? "确认并重试创建本地代码任务"
    : item.display?.actionLabel || "批准创建本地代码任务";
  const profiles = (grant.requiredProfiles || []).map(
    (profile) => `${profile.id} · ${profile.configDigest}`,
  );
  const inputBinding = grant.inputBinding || null;
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation code-job-confirmation">
      <p class="eyebrow">LOCAL CODE AUTHORIZATION / ${remaining} LEFT</p>
      <h2>${escapeHtml(item.display?.title || "确认本地代码任务")}</h2>
      <p class="confirmation-reason">${escapeHtml(item.display?.summary || grant.summary || "确认后只创建一个本地隔离任务")}</p>
      <dl class="detail-grid confirmation-grid">
        <dt>请求岗位</dt><dd>${escapeHtml(item.requestedBy?.roleId || "未指定")}</dd>
        <dt>仓库</dt><dd>${escapeHtml(grant.repository || "未知")}</dd>
        <dt>可信工作区</dt><dd>${escapeHtml(grant.workspaceId || "未知")}</dd>
        ${inputBinding ? `<dt>PR 输入</dt><dd>${pullRequestTargetMarkup({ resourceId: `${inputBinding.repository}#${inputBinding.pullRequestNumber}` })}</dd><dt>精确 Head</dt><dd><code>${escapeHtml(inputBinding.headRefOid)}</code></dd>` : ""}
        <dt>代码操作</dt><dd>${escapeHtml(codeOperationLabel(grant.operation))}</dd>
        <dt>绑定提案</dt><dd><code>${escapeHtml(grant.contentDigest || item.target?.version || "未知")}</code></dd>
        <dt>授权大脑</dt><dd><code>${escapeHtml(grant.brainDigest || "未知")}</code></dd>
      </dl>
      <div class="review-preview">
        <strong>任务目标</strong>
        <pre>${escapeHtml(grant.objective || "未提供")}</pre>
      </div>
      <p class="confirmation-reason"><strong>验收条件</strong></p>
      ${listMarkup(grant.acceptanceCriteria)}
      <p class="confirmation-reason"><strong>可写相对路径</strong></p>
      ${listMarkup(grant.writablePaths?.length ? grant.writablePaths : ["无（只读任务）"])}
      <p class="confirmation-reason"><strong>允许的受控动作</strong></p>
      ${listMarkup(grant.allowedActions)}
      <p class="confirmation-reason"><strong>必须运行的固定测试</strong></p>
      ${listMarkup(profiles)}
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="${operation}">${escapeHtml(actionLabel)}</button>
        <button class="secondary" data-external-operation="reject">驳回，不创建</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">批准只创建持久化的隔离本地代码任务；本次点击不会调用模型、修改源目录、提交或推送 GitHub。后续动作仍受固定工具、路径和 Docker 测试约束。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showChangePackageApplicationConfirmation(entry, remaining) {
  const item = structuredClone(entry.item);
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  const payload = item.display?.payload || {};
  const action = payload.action || {};
  const target = payload.target || item.target || {};
  const job = action.job || {};
  const workspace = action.workspace || {};
  const operation = item.retryable ? "retry" : "approve";
  const actionLabel = item.retryable
    ? "确认并重试应用变更包"
    : item.display?.actionLabel || "确认并应用变更包";
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation change-package-confirmation">
      <p class="eyebrow">LOCAL CHANGE PACKAGE / ${remaining} LEFT</p>
      <h2>${escapeHtml(item.display?.title || "应用已验证的本地变更包")}</h2>
      <p class="confirmation-reason">${escapeHtml(item.display?.summary || "确认后将把已验证的变更应用到目标 checkout")}</p>
      <dl class="detail-grid confirmation-grid">
        <dt>目标工作区</dt><dd>${escapeHtml(target.resourceId || workspace.id || "未知")}</dd>
        <dt>预期 Head</dt><dd><code>${escapeHtml(target.version || action.expectedHeadOid || "未知")}</code></dd>
        <dt>变更包 ID</dt><dd><code>${escapeHtml(action.packageId || "未知")}</code></dd>
        <dt>变更包摘要</dt><dd><code>${escapeHtml(action.packageDigest || "未知")}</code></dd>
        <dt>任务绑定</dt><dd>${escapeHtml(job.id || "未知")} · revision ${escapeHtml(job.revision ?? "未知")}</dd>
        <dt>源修订</dt><dd><code>${escapeHtml(workspace.sourceRevision || "未知")}</code></dd>
        <dt>工作区修订</dt><dd><code>${escapeHtml(workspace.workspaceRevision || "未知")}</code></dd>
        <dt>变更集合摘要</dt><dd><code>${escapeHtml(action.changeSetDigest || "未知")}</code></dd>
        <dt>测试证据摘要</dt><dd><code>${escapeHtml(action.testEvidenceDigest || "未知")}</code></dd>
      </dl>
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="${operation}">${escapeHtml(actionLabel)}</button>
        <button class="secondary" data-external-operation="reject">驳回，不应用</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">确认只应用当前展示且已通过固定测试的变更包，并绑定目标工作区与预期 Head；目标状态变化后必须重新确认。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showConfigurationActivationConfirmation(entry, remaining, descriptor) {
  const item = structuredClone(entry.item);
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  const payload = item.display?.payload || {};
  const action = payload.action || {};
  const impact = payload.impact || {};
  const nextVersion = descriptor.initialVersion
    ? 1
    : Number(action.expectedActiveVersion) + 1;
  const subjectValue = descriptor.subject === "version"
    ? `v${action.targetVersion ?? "未知"}`
    : `${action.draftId || "未知"} · r${action.draftRevision ?? "未知"}`;
  const operation = item.retryable ? "retry" : "approve";
  const actionLabel = item.retryable
    ? "确认并重试配置变更"
    : item.display?.actionLabel || "确认并激活配置";
  confirmationDialog.setAttribute(
    "aria-labelledby",
    "configuration-confirmation-title",
  );
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation configuration-confirmation">
      <p class="eyebrow">CONFIGURATION ${descriptor.eyebrow} / ${remaining} LEFT</p>
      <h2 id="configuration-confirmation-title">${escapeHtml(item.display?.title || "确认版本化配置变更")}</h2>
      <p class="confirmation-reason">${escapeHtml(item.display?.summary || "确认后将把当前摘要绑定的配置保存为新版本")}</p>
      <dl class="detail-grid confirmation-grid">
        <dt>保存版本</dt><dd>v${escapeHtml(Number.isSafeInteger(nextVersion) ? nextVersion : "未知")}</dd>
        <dt>${descriptor.subjectLabel}</dt><dd>${escapeHtml(subjectValue)}</dd>
        <dt>状态修订</dt><dd>${escapeHtml(action.expectedStateRevision ?? "未知")}</dd>
        <dt>配置摘要</dt><dd><code>${escapeHtml(action.documentDigest || "未知")}</code></dd>
        <dt>验证摘要</dt><dd><code>${escapeHtml(action.validationDigest || "未知")}</code></dd>
        <dt>影响摘要</dt><dd><code>${escapeHtml(action.impactDigest || "未知")}</code></dd>
      </dl>
      <p class="confirmation-reason"><strong>逐项影响</strong></p>
      ${configurationImpactMarkup(impact)}
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="${operation}">${escapeHtml(actionLabel)}</button>
        <button class="secondary" data-external-operation="reject">驳回，不激活</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">批准只会保存当前摘要、状态修订和版本绑定的配置变更；不会自动重启服务，也不会绕过岗位、代码执行器或 GitHub 动作的独立权限。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showUnsupportedExternalConfirmation(entry, remaining) {
  const item = structuredClone(entry.item);
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation">
      <p class="eyebrow">UNSUPPORTED AUTHORIZATION / ${remaining} LEFT</p>
      <h2>暂不支持这类确认</h2>
      <p class="confirmation-reason">系统不会为未知动作显示批准入口。请稍后查看升级后的确认内容。</p>
      <div class="confirmation-actions">
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showUnknownResultResolution(entry, remaining) {
  const item = structuredClone(entry.item);
  const payload = item.display?.payload || {};
  const target = payload.target || item.target || {};
  const action = payload.action || {};
  const githubAction =
    pullRequestConfirmationActionType(item.kind) === action.type;
  const historicalBody = githubAction &&
      ["pull_request_comment", "pull_request_review"].includes(action.type)
    ? `<div class="review-preview">
        <strong>当时拟发布的完整正文（不会再次发布）</strong>
        <pre>${escapeHtml(action.body || "没有正文")}</pre>
      </div>`
    : "";
  activeInternalAttention = null;
  activeExternalConfirmation = item;
  confirmationContent.innerHTML = `
    <article class="confirmation external-confirmation">
      <p class="eyebrow">UNCERTAIN EXTERNAL RESULT / ${remaining} LEFT</p>
      <h2>${escapeHtml(item.display?.title || "外部动作结果未知")}</h2>
      <p class="confirmation-reason">系统已完成只读核对，但现有证据仍不能证明该动作当时一定执行或一定未执行。为防止重复写入，系统不会自动重试。</p>
      <dl class="detail-grid confirmation-grid">
        <dt>请求岗位</dt><dd>${escapeHtml(item.requestedBy?.roleId || "未指定")}</dd>
        <dt>目标</dt><dd>${escapeHtml(target.resourceId || "未知")}</dd>
        <dt>绑定版本</dt><dd><code>${escapeHtml(target.version || "未知")}</code></dd>
        <dt>诊断</dt><dd><code>${escapeHtml(item.failure?.code || "EXTERNAL_OUTCOME_UNKNOWN")}</code></dd>
        ${githubAction ? pullRequestActionDetailRows(action) : `<dt>动作类型</dt><dd>${escapeHtml(action.type || "未知")}</dd>`}
      </dl>
      ${historicalBody}
      <p class="confirmation-reason"><strong>原始提案摘要</strong></p>
      <p>${escapeHtml(item.display?.summary || "未提供")}</p>
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(item.display?.evidence)}
      <div class="confirmation-actions" data-external-confirmation-id="${escapeHtml(item.id)}">
        <button data-external-operation="reject">承认结果未知并封存</button>
        <button class="secondary wide" data-external-operation="later">稍后再看</button>
      </div>
      <p class="confirmation-note">封存只记录本机所有者决定并解除恢复阻断；不会调用 GitHub，也不会重新执行、评论、Review、更新、推送或合并。</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleExternalConfirmation);
}

function showExternalActionConfirmation(entry, remaining) {
  if (entry.item?.resolutionRequired === true) {
    showUnknownResultResolution(entry, remaining);
    return;
  }
  const configurationActionType = entry.item?.display?.payload?.action?.type;
  const configurationAction = Object.hasOwn(
    configurationActivationActions,
    configurationActionType,
  )
    ? configurationActivationActions[configurationActionType]
    : null;
  if (
    entry.item?.kind === "local.configuration-activate" &&
    configurationAction
  ) {
    showConfigurationActivationConfirmation(
      entry,
      remaining,
      configurationAction,
    );
    return;
  }
  if (entry.item?.kind === "local.code-job-create") {
    showCodeJobConfirmation(entry, remaining);
    return;
  }
  if (entry.item?.kind === "local.change-package-apply") {
    showChangePackageApplicationConfirmation(entry, remaining);
    return;
  }
  if (pullRequestConfirmationActionType(entry.item?.kind) !== null) {
    showGitHubActionConfirmation(entry, remaining);
    return;
  }
  showUnsupportedExternalConfirmation(entry, remaining);
}

function internalContextMarkup(context = []) {
  if (!context.length) return "";
  return `<dl class="detail-grid confirmation-grid">${context
    .map(
      ({ label, value }) => {
        const sourceUrl = label === "来源事件"
          ? githubSourceEventUrl(value)
          : null;
        const valueMarkup = sourceUrl === null
          ? escapeHtml(value)
          : `<a class="confirmation-target-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(value)} · 打开 GitHub ↗</a>`;
        return `<dt>${escapeHtml(label)}</dt><dd>${valueMarkup}</dd>`;
      },
    )
    .join("")}</dl>`;
}

function showInternalAttention(entry, remaining) {
  const item = structuredClone(entry.item);
  const display = internalAttentionDisplay(item);
  activeInternalAttention = item;
  activeExternalConfirmation = null;
  const choices = display.choices
    .map(
      (choice) => `
        <button type="button" data-internal-choice="${escapeHtml(choice.id)}">
          ${escapeHtml(choice.label)}
          ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
        </button>`,
    )
    .join("");
  confirmationContent.innerHTML = `
    <article class="confirmation internal-attention">
      <p class="eyebrow">EMPLOYEE CONSULTATION / 还剩 ${remaining} 项（含当前项）</p>
      <h2>${escapeHtml(display.question || "员工需要你做一个决定")}</h2>
      <p class="confirmation-reason">来自 ${escapeHtml(item.producer?.roleId || "orchestrator")} · 提交后写入本地台账，并唤醒原任务</p>
      ${internalContextMarkup(item.context)}
      ${choices ? `<div class="confirmation-actions internal-choice-actions">${choices}</div>` : ""}
      <form class="internal-answer-form">
        <label for="internal-answer-text">补充文字答复</label>
        <textarea id="internal-answer-text" name="answer" maxlength="4096" placeholder="输入你的判断或补充信息"></textarea>
        <div class="confirmation-actions">
          <button type="submit">提交文字答复</button>
          <button type="button" class="secondary" data-internal-operation="reject">驳回请示</button>
          <button type="button" class="secondary wide" data-internal-operation="later">稍后再看</button>
        </div>
      </form>
      <p class="confirmation-note">提交答复后，原任务重新排队给该岗位继续处理；驳回后，原任务转入阻塞；两者均可在“主动工作台账”追踪。选择“稍后再看”会继续留在待确认队列，本页暂不再弹出。这里不会直接执行代码或写入 GitHub。</p>
    </article>`;
  const root = confirmationContent.querySelector(".internal-attention");
  root.addEventListener("click", handleInternalAttentionClick);
  root
    .querySelector(".internal-answer-form")
    .addEventListener("submit", handleInternalTextAnswer);
}

function setInternalButtonsDisabled(disabled) {
  confirmationContent.querySelectorAll("button, textarea").forEach((control) => {
    control.disabled = disabled;
  });
}

async function submitInternalAttention(operation, answer) {
  const item = activeInternalAttention;
  if (!item || !["answer", "reject", "later"].includes(operation)) return;
  const roleId = item.producer?.roleId || "对应岗位";
  const submissionOwner = beginConfirmationSubmission(setInternalButtonsDisabled);
  if (submissionOwner === null) return;
  try {
    const response = await postAttentionDuringFactRefresh(
      `/api/attention/internal/${encodeURIComponent(item.requestId)}/${operation}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({
          expectedRevision: item.revision,
          contentDigest: item.contentDigest,
          answer,
        }),
      },
      {
        isCurrent: () => confirmationDialogOwnership.ownsSubmission(submissionOwner),
        onWaiting: () => {
          statusBanner.hidden = false;
          statusBanner.textContent = "正在核对最新事实，将自动重试提交这条请示…";
        },
      },
    );
    if (response === null) return;
    if (response.status === 409) {
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      if (!closeConfirmationSubmission(submissionOwner)) return;
      activeInternalAttention = null;
      activeConfirmationKey = "";
      invalidateConfirmationQueueSnapshot();
      statusBanner.hidden = false;
      statusBanner.textContent = "员工请示内容已经变化，请查看最新问题后重新答复。";
      try {
        await refreshConfirmationQueue({ showConfirmation: false });
      } catch (error) {
        statusBanner.textContent += ` ${error.message}。页面会自动重试。`;
      }
      queueMicrotask(showNextConfirmation);
      return;
    }
    if (!response.ok) throw new Error(`员工请示处理失败（${response.status}）`);
    await response.json();
  } catch (error) {
    if (!restoreConfirmationSubmission(
      submissionOwner,
      setInternalButtonsDisabled,
    )) {
      return;
    }
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
    return;
  }
  if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
  if (operation === "later") rememberDeferredConfirmation(activeConfirmationKey);
  if (!closeConfirmationSubmission(submissionOwner)) return;
  activeInternalAttention = null;
  activeConfirmationKey = "";
  invalidateConfirmationQueueSnapshot();
  if (item.maintenanceCode) void loadMaintenanceAttention({ afterCurrent: true });
  const completedMessage = operation === "answer"
    ? `答复已写入本地台账，原任务将重新排队给 ${roleId} 继续处理；可在“主动工作台账”追踪。`
    : operation === "reject"
      ? "驳回已写入本地台账，原任务将转入“阻塞”；可在“主动工作台账”追踪。"
      : "此项仍在待确认队列，本页暂不再弹出；可点击“重新查看稍后项”恢复。";
  let refreshError = null;
  try {
    await refreshConfirmationQueue({ showConfirmation: false });
    if (currentView === "work") await workView.load();
  } catch (error) {
    refreshError = error;
  }
  statusBanner.hidden = false;
  statusBanner.textContent = refreshError
    ? `${completedMessage} ${refreshError.message}。页面会自动重试。`
    : completedMessage;
  queueMicrotask(showNextConfirmation);
}

function handleInternalAttentionClick(event) {
  const choice = event.target.closest("[data-internal-choice]");
  if (choice) {
    submitInternalAttention("answer", {
      type: "choice",
      choiceId: choice.dataset.internalChoice,
    });
    return;
  }
  const operation = event.target.closest("[data-internal-operation]")
    ?.dataset.internalOperation;
  if (operation === "reject") {
    submitInternalAttention("reject", {
      type: "reject",
      reason: "用户在统一确认弹框中驳回请示",
    });
  } else if (operation === "later") {
    submitInternalAttention("later", { type: "later" });
  }
}

function handleInternalTextAnswer(event) {
  event.preventDefault();
  const text = new FormData(event.currentTarget).get("answer")?.trim() || "";
  if (!text) {
    statusBanner.hidden = false;
    statusBanner.textContent = "请输入答复内容，或选择一个选项。";
    return;
  }
  submitInternalAttention("answer", { type: "text", text });
}

function showReviewDraftConfirmation(entry, remaining) {
  const { job } = entry;
  confirmationContent.innerHTML = `
    <article class="confirmation review-confirmation">
      <p class="eyebrow">PR EMPLOYEE / 当前项 · 队列还剩 ${remaining} 项</p>
      <h2>请确认是否接受这份 Review 草稿</h2>
      <p class="confirmation-title">${escapeHtml(job.repo)} #${job.number} · ${escapeHtml(job.title)}</p>
      <p class="confirmation-reason">${escapeHtml(job.summary || job.triggerReason || "")}</p>
      <div class="review-preview">
        <strong>${escapeHtml(reviewVerdictLabel(job.reviewVerdict))}</strong>
        <pre>${escapeHtml(job.reviewBody || "没有生成评审正文")}</pre>
      </div>
      <p class="confirmation-reason"><strong>依据</strong></p>
      ${listMarkup(job.evidence)}
      <div class="confirmation-actions" data-review-job-id="${escapeHtml(job.id)}" data-head-ref-oid="${escapeHtml(job.headRefOid)}">
        <button data-review-decision="accept">接受草稿</button>
        <button class="secondary" data-review-decision="reject">驳回草稿</button>
        <button class="secondary wide" data-review-decision="later">稍后再看</button>
      </div>
      ${job.url ? `<a class="confirmation-target-link" href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">在 GitHub 中打开 ↗</a>` : ""}
      <p class="confirmation-note">${confirmationQueueState.externalEnabled
        ? "接受只确认本地 Review 内容，随后会生成一项独立的 GitHub 发布确认；本次点击不会直接写入 GitHub。"
        : "当前未启用 GitHub 外部动作。接受或驳回只记录在本机，不会发布 GitHub Review。"}</p>
    </article>`;
  confirmationContent
    .querySelector(".confirmation-actions")
    .addEventListener("click", handleReviewDraftDecision);
}

function showConfirmationEntry(entry, remaining) {
  if (confirmationDialog.open || dialog.open) return;
  if (!entry) return;
  confirmationDialogOwnership.open();
  confirmationCloseButton.disabled = false;
  activeConfirmationKey = entry.key;
  confirmationDialog.removeAttribute("aria-labelledby");
  if (entry.kind === "external_action") {
    showExternalActionConfirmation(entry, remaining);
  } else if (entry.kind === "internal_request") {
    showInternalAttention(entry, remaining);
  } else if (entry.kind === "review_draft") {
    activeInternalAttention = null;
    activeExternalConfirmation = null;
    showReviewDraftConfirmation(entry, remaining);
  } else {
    activeInternalAttention = null;
    activeExternalConfirmation = null;
    showResponsibilityConfirmation(entry, remaining);
  }
  confirmationDialog.showModal();
}

async function showJobConfirmation(job) {
  if (job.status === "ready_for_human") {
    const entry = {
      kind: "review_draft",
      job,
      key: confirmationKey("review", job),
    };
    showConfirmationEntry(entry, 1);
    return;
  }
  if (typeof job.confirmationId === "string" && job.confirmationId) {
    const response = await fetch(
      `/api/confirmations/${encodeURIComponent(job.confirmationId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`读取这项确认失败（${response.status}）`);
    }
    const result = await response.json();
    const item = result.item;
    if (
      !item ||
      item.id !== job.confirmationId ||
      !["pending", "failed"].includes(item.status)
    ) {
      throw new Error("这项确认已经处理或失效");
    }
    showConfirmationEntry({
      kind: "external_action",
      item,
      key: `external\u0000${item.id}\u0000${item.approvalBindingDigest}`,
    }, 1);
    return;
  }
  throw new Error("这项作业尚未生成可确认内容");
}

function showNextConfirmation() {
  const pending = pendingConfirmations();
  showConfirmationEntry(pending[0], pending.length);
}

async function handleConfirmation(event) {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  const itemId = button.closest("[data-confirmation-id]").dataset.confirmationId;
  const headRefOid = button.closest("[data-confirmation-id]").dataset.headRefOid;
  const decision = button.dataset.decision;
  if (decision === "later") {
    rememberDeferredConfirmation(activeConfirmationKey);
    activeConfirmationKey = "";
    closeConfirmationDialog();
    await refreshAfterDeferral();
    return;
  }

  const submissionOwner = beginConfirmationSubmission(
    setConfirmationButtonsDisabled,
  );
  if (submissionOwner === null) return;
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/pr-responsibility/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({ id: itemId, actionState: decision, headRefOid }),
    });
    if (response.status === 409) {
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      const nextDashboard = await fetchDashboard();
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      applyDashboard(nextDashboard, sequence);
      if (!closeConfirmationSubmission(submissionOwner)) return;
      statusBanner.hidden = false;
      statusBanner.textContent = "PR 已出现新提交，请根据最新事实重新确认。";
      queueMicrotask(showNextConfirmation);
      return;
    }
    if (!response.ok) throw new Error(`确认保存失败（${response.status}）`);
    const nextDashboard = await response.json();
    if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
    applyDashboard(nextDashboard, sequence);
    if (!closeConfirmationSubmission(submissionOwner)) return;
    activeConfirmationKey = "";
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    if (!restoreConfirmationSubmission(
      submissionOwner,
      setConfirmationButtonsDisabled,
    )) {
      return;
    }
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

function externalConfirmationOutcomeMessage(item, result, operation) {
  if (
    !["approve", "retry"].includes(operation) ||
    typeof item?.kind !== "string" ||
    !item.kind.startsWith("github.")
  ) {
    return null;
  }
  const completed = result?.item;
  if (completed?.status === "completed") {
    return "GitHub 已确认发布成功。";
  }
  if (completed?.status === "failed") {
    if (completed.failure?.code === "GITHUB_SELF_REVIEW_UNSUPPORTED") {
      return (
        "GitHub 不允许 PR 作者批准或请求修改自己的 PR，" +
        "本次确认未产生外部写入；新提案将改为 COMMENT Review。"
      );
    }
    return completed.failure?.outcome === "unknown"
      ? "GitHub 未能确认发布结果，已禁止自动重试；请在确认历史中查看诊断。"
      : "GitHub 发布失败，已确认没有产生外部写入；可在确认历史中安全重试。";
  }
  if (completed?.status === "stale") {
    return "GitHub 目标已经变化，本次未发布；请查看最新提案。";
  }
  if (["pending", "executing"].includes(completed?.status)) {
    return "GitHub 发布请求已接受，正在执行；请稍后在确认历史中查看结果。";
  }
  return null;
}

function reviewHandoffStatusText(item) {
  const handoff = item?.reviewHandoff;
  if (!handoff) return "";
  const person = handoff.assignedLogin || handoff.selection.responsiblePerson?.login;
  const destination = `${handoff.selection.workType}${person ? ` · @${person}` : ""}`;
  if (handoff.status === "completed") return `下一步已分配：${destination}；工作项 ${handoff.workItemId}。`;
  if (handoff.status === "stale") return `交接已停止：PR 状态、Head 或分配策略已变化（${handoff.diagnosticCode}），请核对最新 PR。`;
  if (item.status !== "completed") return `已保存交接选择：${destination}；只有 GitHub Review 明确完成后才会分配。`;
  if (handoff.status === "retrying") return `交接待重试：${destination}（${handoff.diagnosticCode}）。服务端会继续恢复，不会重新发布 Review。`;
  return `交接已持久保存：${destination}；服务端正在分配，关闭页面不影响推进。可在确认历史查看结果。`;
}

function selectedReviewHandoffPerson(item, workType) {
  const root = confirmationContent.querySelector(".review-handoff");
  if (!root) return null;
  if (workType === "testing") {
    return {
      product: root.querySelector("[data-review-testing-product]")?.value || "qt",
      login: root.querySelector("[data-review-testing-person]")?.value || "",
    };
  }
  if (
    workType === "pull_request" &&
    root.querySelector("[data-review-handoff]")?.dataset.reviewResponsibleKind ===
      "external_reviewer"
  ) {
    return {
      product: root.querySelector("[data-review-external-product]")?.value || "qt",
      login: root.querySelector("[data-review-external-person]")?.value || "",
    };
  }
  if (
    workType === "development" &&
    reviewHandoffLifecycle(
      (item.display?.payload?.action || item.action)?.reviewEvent,
      item,
    ).responsibleKind === "self"
  ) {
    const configuration = activeConfigurationDocument();
    return {
      product: inferTestingProduct(reviewHandoffSearchText(item)),
      login: configuration.githubLogin || configuration.githubActions?.actorAccountId || "",
    };
  }
  return null;
}

async function handleExternalConfirmation(event) {
  const button = event.target.closest("[data-external-operation]");
  if (!button) return;
  const operation = button.dataset.externalOperation;
  if (operation === "later") {
    rememberDeferredConfirmation(activeConfirmationKey);
    activeConfirmationKey = "";
    activeExternalConfirmation = null;
    closeConfirmationDialog();
    await refreshAfterDeferral();
    return;
  }
  const item = activeExternalConfirmation;
  if (!item || !["approve", "retry", "reject"].includes(operation)) return;
  const handoffWorkType = operation === "reject"
    ? ""
    : confirmationContent.querySelector("[data-review-handoff]")?.value || "";
  const handoffResponsiblePerson = selectedReviewHandoffPerson(
    item,
    handoffWorkType,
  );
  const submissionOwner = beginExternalConfirmationSubmission(button, operation);
  if (submissionOwner === null) return;
  try {
    const response = await postAttentionDuringFactRefresh(
      `/api/confirmations/${encodeURIComponent(item.id)}/${operation}`,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        expectedQueueRevision: item.queueRevision,
        expectedItemRevision: item.itemRevision,
        displayedPayloadDigest: item.displayedPayloadDigest,
        approvalBindingDigest: item.approvalBindingDigest,
        ...(operation !== "reject" && (item.reviewHandoff || handoffWorkType)
          ? { reviewHandoff: item.reviewHandoff?.selection || { workType: handoffWorkType, responsiblePerson: handoffResponsiblePerson } }
          : {}),
        ...(operation === "reject"
          ? {
              reason: item.resolutionRequired === true
                ? "用户确认结果仍未知并封存，禁止重试"
                : "用户在确认弹框中驳回",
            }
          : {}),
      }),
      },
      {
        isCurrent: () => confirmationDialogOwnership.ownsSubmission(submissionOwner),
        onWaiting: () => {
          statusBanner.hidden = false;
          statusBanner.textContent = "正在核对最新事实，确认请求将自动重试，请勿重复点击…";
        },
      },
    );
    if (response === null) return;
    if (response.status === 409) {
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      invalidateConfirmationQueueSnapshot();
      if (!closeExternalConfirmation(submissionOwner)) return;
      statusBanner.hidden = false;
      statusBanner.textContent = "确认内容或目标状态已经变化，请查看最新内容后重新确认。";
      try {
        const applied = await refreshConfirmationQueue({ showConfirmation: false });
        if (applied) queueMicrotask(showNextConfirmation);
      } catch (error) {
        statusBanner.textContent += ` ${error.message}。成功读取最新确认内容前不会再次弹出。`;
        return;
      }
      try {
        if (item.kind === "local.configuration-activate") {
          await loadConfiguration();
        }
        const sequence = ++requestSequence;
        const nextDashboard = await fetchDashboard();
        if (nextDashboard) applyDashboard(nextDashboard, sequence);
      } catch (error) {
        statusBanner.textContent += ` ${error.message}。其他页面数据会自动重试。`;
      }
      return;
    }
    if (!response.ok) throw new Error(`外部动作确认失败（${response.status}）`);
    const confirmationResult = await response.json();
    if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
    const configurationCompleted =
      item.kind === "local.configuration-activate" &&
      ["approve", "retry"].includes(operation) &&
      confirmationResult?.item?.status === "completed";
    if (configurationCompleted) {
      configurationNotice = "已保存，重启服务后生效";
      configurationPreview = null;
      configurationEditorDirty = false;
    }
    const reviewPublished =
      ["approve", "retry"].includes(operation) &&
      confirmationResult?.item?.status === "completed" &&
      (item.display?.payload?.action || item.action)?.type === "pull_request_review";
    invalidateConfirmationQueueSnapshot();
    if (!closeExternalConfirmation(submissionOwner)) return;
    const loadResult = await load({ showConfirmation: false });
    let refreshError = loadResult?.refreshError || null;
    if (configurationCompleted) {
      try {
        await loadConfiguration();
      } catch (error) {
        refreshError ||= error;
      }
    }
    let outcomeMessage = externalConfirmationOutcomeMessage(
      item,
      confirmationResult,
      operation,
    );
    if (confirmationResult.item?.reviewHandoff) {
      outcomeMessage = `${outcomeMessage || "确认结果已记录。"} ${reviewHandoffStatusText(confirmationResult.item)}`;
    } else if (reviewPublished && !handoffWorkType) {
      outcomeMessage = "GitHub 已确认发布成功；你选择了不创建下一步任务。";
    }
    if (refreshError) {
      outcomeMessage = `${outcomeMessage || "确认结果已记录。"} ${refreshError.message}。页面会自动重试。`;
    }
    if (outcomeMessage) {
      statusBanner.hidden = false;
      statusBanner.textContent = outcomeMessage;
    } else {
      queueMicrotask(showNextConfirmation);
    }
  } catch (error) {
    if (!restoreExternalConfirmation(submissionOwner)) return;
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

async function handleReviewDraftDecision(event) {
  const button = event.target.closest("[data-review-decision]");
  if (!button) return;
  const container = button.closest("[data-review-job-id]");
  const decision = button.dataset.reviewDecision;
  if (decision === "later") {
    rememberDeferredConfirmation(activeConfirmationKey);
    activeConfirmationKey = "";
    closeConfirmationDialog();
    await refreshAfterDeferral();
    return;
  }
  const submissionOwner = beginConfirmationSubmission(
    setConfirmationButtonsDisabled,
  );
  if (submissionOwner === null) return;
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/pr-review-jobs/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mydashboard-action": "1",
      },
      body: JSON.stringify({
        id: container.dataset.reviewJobId,
        decision,
        headRefOid: container.dataset.headRefOid,
        expectedRevision: dashboard.employee.role.revision,
      }),
    });
    if (response.status === 409) {
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      const nextDashboard = await fetchDashboard();
      if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
      if (nextDashboard) applyDashboard(nextDashboard, sequence);
      if (!closeConfirmationSubmission(submissionOwner)) return;
      statusBanner.hidden = false;
      statusBanner.textContent = "员工草稿对应的 PR 已更新，请查看最新结果。";
      activeConfirmationKey = "";
      queueMicrotask(showNextConfirmation);
      return;
    }
    if (!response.ok) throw new Error(`草稿确认失败（${response.status}）`);
    const nextDashboard = await response.json();
    if (!confirmationDialogOwnership.ownsSubmission(submissionOwner)) return;
    applyDashboard(nextDashboard, sequence);
    if (!closeConfirmationSubmission(submissionOwner)) return;
    activeConfirmationKey = "";
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    if (!restoreConfirmationSubmission(
      submissionOwner,
      setConfirmationButtonsDisabled,
    )) {
      return;
    }
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  }
}

function updateChrome() {
  const brain = dashboard.meta.brain || {};
  const errors = [
    ...(dashboard.meta.errors || []),
    ...(brain.errors || []).map((error) => `大脑: ${error}`),
    ...(dashboard.employee?.role?.lastError
      ? [`PR 员工: ${dashboard.employee.role.lastError}`]
      : []),
  ];
  const brainLabel = brain.enabled
    ? `${brain.provider || "AI"} / ${brain.model || "未配置模型"}${brain.fallbackUsed ? `（已回退 ${brain.fallbackProvider || "本地模型"} / ${brain.fallbackModel || ""}）` : ""}`
    : "确定性规则";
  lastUpdated.textContent = `更新于 ${relativeTime(dashboard.meta.refreshedAt)} · ${dashboard.meta.durationMs} ms`;
  sourceHealth.classList.toggle("error", errors.length > 0);
  sourceHealth.innerHTML = `
    <span class="pulse"></span>
    <div>
      <strong>${errors.length ? "部分能力异常" : "指挥中枢已连接"}</strong>
      <span>${dashboard.meta.sources.github} GitHub · ${dashboard.meta.sources.dingtalk} 钉钉 · ${escapeHtml(brainLabel)}</span>
    </div>`;
  statusBanner.hidden = errors.length === 0;
  statusBanner.textContent = errors.length
    ? `部分数据未能刷新：${summarizeDashboardErrors(errors).join("；")}`
      : "";
}

function updateConfigurationChrome() {
  if (dashboard || !hasConfigurationState()) return;
  const status = configurationStatus();
  const runtime = configurationRuntimePresentation();
  const activeVersion = configurationActiveVersion();
  const stateRevision = configurationStateRevision();
  lastUpdated.textContent = `配置状态 revision ${stateRevision ?? "未知"}`;
  const runtimeError = ["unknown", "unbound"].includes(status.runtimeMode);
  sourceHealth.classList.toggle("error", status.safeMode === true || runtimeError);
  sourceHealth.innerHTML = `
    <span class="pulse"></span>
    <div>
      <strong>${runtimeError ? "配置运行时已封闭" : status.safeMode === true ? "安全恢复模式" : "配置中心已连接"}</strong>
      <span>${activeVersion === null ? "尚无 Active 配置" : `本地已保存 v${activeVersion}`} · ${escapeHtml(runtime.label)}</span>
    </div>`;
}

function configurationTemplateIdentity(template) {
  if (!template?.matches?.("[data-configuration-structure-template]")) {
    return null;
  }
  const structurePath = template.dataset.configurationStructureTemplate;
  const valueRoot = template.dataset.configurationTemplateValueRoot;
  if (typeof structurePath !== "string" || typeof valueRoot !== "string") {
    return null;
  }
  return JSON.stringify([
    template.hasAttribute("data-configuration-replace-template")
      ? "replace"
      : "add",
    structurePath,
    valueRoot,
    template.dataset.configurationTemplateVariant ?? "",
  ]);
}

function configurationTemplateControlIdentity(control) {
  const template = control?.closest?.("[data-configuration-structure-template]");
  const templateIdentity = configurationTemplateIdentity(template);
  if (!templateIdentity) return null;
  if (control.matches("summary")) {
    return JSON.stringify([templateIdentity, "summary"]);
  }
  if (control.dataset.configurationTemplateKey !== undefined) {
    return JSON.stringify([templateIdentity, "key"]);
  }
  if (control.dataset.configurationTemplateField !== undefined) {
    return JSON.stringify([
      templateIdentity,
      "field",
      control.dataset.configurationTemplateField,
    ]);
  }
  if (control.dataset.configurationTemplateScalarType !== undefined) {
    const valueControl = control
      .closest("[data-configuration-template-scalar]")
      ?.querySelector("[data-configuration-template-field]");
    if (!valueControl) return null;
    return JSON.stringify([
      templateIdentity,
      "scalar-type",
      valueControl.dataset.configurationTemplateField,
    ]);
  }
  if (control.dataset.configurationOperation !== undefined) {
    return JSON.stringify([templateIdentity, "operation"]);
  }
  return null;
}

function configurationTemplateControls() {
  return [...content.querySelectorAll(
    "[data-configuration-structure-template] summary, " +
      "[data-configuration-template-key], " +
      "[data-configuration-template-field], " +
      "[data-configuration-template-scalar-type], " +
      "[data-configuration-structure-template] [data-configuration-operation]",
  )];
}

function configurationTemplateDomSnapshot(active) {
  const templates = [...content.querySelectorAll(
    "[data-configuration-structure-template]",
  )].flatMap((template) => {
    const identity = configurationTemplateIdentity(template);
    return identity ? [{ identity, open: template.open === true }] : [];
  });
  const controls = configurationTemplateControls().flatMap((control) => {
    const identity = configurationTemplateControlIdentity(control);
    if (!identity) return [];
    return [{
      identity,
      value: typeof control.value === "string" ? control.value : null,
      checked: typeof control.checked === "boolean" ? control.checked : null,
      inputType: control.tagName === "INPUT" ? control.type : null,
      readOnly: control.tagName === "INPUT" ? control.readOnly : null,
      editKind:
        typeof control.dataset.configurationEditKind === "string"
          ? control.dataset.configurationEditKind
          : null,
    }];
  });
  const activeIdentity = configurationTemplateControlIdentity(active);
  const selection = activeIdentity && typeof active.selectionStart === "number"
    ? {
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
      }
    : null;
  return { templates, controls, activeIdentity, selection };
}

function restoreConfigurationTemplateDom(snapshot) {
  const templates = new Map(
    [...content.querySelectorAll("[data-configuration-structure-template]")]
      .flatMap((template) => {
        const identity = configurationTemplateIdentity(template);
        return identity ? [[identity, template]] : [];
      }),
  );
  for (const retained of snapshot.templates) {
    const template = templates.get(retained.identity);
    if (template) template.open = retained.open;
  }

  const controls = new Map(
    configurationTemplateControls().flatMap((control) => {
      const identity = configurationTemplateControlIdentity(control);
      return identity ? [[identity, control]] : [];
    }),
  );
  for (const retained of snapshot.controls) {
    const control = controls.get(retained.identity);
    if (!control) continue;
    if (control.tagName === "INPUT" && retained.inputType) {
      control.type = retained.inputType;
      control.readOnly = retained.readOnly === true;
    }
    if (retained.editKind === null) {
      delete control.dataset.configurationEditKind;
    } else {
      control.dataset.configurationEditKind = retained.editKind;
    }
    if (retained.value !== null) control.value = retained.value;
    if (retained.checked !== null) control.checked = retained.checked;
  }

  const activeControl = snapshot.activeIdentity
    ? controls.get(snapshot.activeIdentity)
    : null;
  activeControl?.focus({ preventScroll: true });
  if (
    activeControl &&
    snapshot.selection &&
    typeof activeControl.setSelectionRange === "function"
  ) {
    const maximum = activeControl.value.length;
    activeControl.setSelectionRange(
      Math.min(snapshot.selection.start, maximum),
      Math.min(snapshot.selection.end, maximum),
      snapshot.selection.direction || undefined,
    );
  }
}

function renderConfigurationPreservingEditorFocus() {
  const active = document.activeElement;
  const fieldPath = active?.dataset?.configurationField;
  const selection = fieldPath && typeof active.selectionStart === "number"
    ? {
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
      }
    : null;
  const templateSnapshot = configurationTemplateDomSnapshot(active);
  render();
  restoreConfigurationTemplateDom(templateSnapshot);
  if (fieldPath) {
    const nextField = [...content.querySelectorAll("[data-configuration-field]")]
      .find((control) => control.dataset.configurationField === fieldPath);
    if (!nextField) return;
    nextField.focus({ preventScroll: true });
    if (selection && typeof nextField.setSelectionRange === "function") {
      const maximum = nextField.value.length;
      nextField.setSelectionRange(
        Math.min(selection.start, maximum),
        Math.min(selection.end, maximum),
        selection.direction || undefined,
      );
    }
  }
}

function applyConfigurationState(
  nextState,
  sequence,
  { renderView = true } = {},
) {
  if (!plainRecord(nextState) || sequence < lastAppliedConfigurationRequest) {
    return false;
  }
  const unchanged = sameConfigurationRevision(configurationState, nextState);
  const runtimeUnchanged = sameConfigurationRuntimeState(
    configurationState,
    nextState,
  );
  const hadLoadError = Boolean(configurationLoadError);
  lastAppliedConfigurationRequest = sequence;
  configurationLoadError = "";
  configurationState = nextState;
  if (unchanged) {
    if (!runtimeUnchanged) updateConfigurationChrome();
    if (
      renderView &&
      isConfigurationBackedView() &&
      (!runtimeUnchanged || hadLoadError)
    ) {
      renderConfigurationPreservingEditorFocus();
    }
    return true;
  }
  const editable = configurationDocumentCandidate();
  const binding = currentConfigurationBinding();
  if (
    configurationPreview &&
    !sameConfigurationBinding(currentPreviewBinding(), binding)
  ) {
    configurationPreview = null;
  }
  if (editable && !configurationEditorDirty) {
    try {
      configurationFormState = createConfigurationFormState(editable, binding);
      configurationEditorDirty = false;
      configurationEditorStale = false;
      configurationEditorBinding = binding;
      configurationEditorError = "";
    } catch (error) {
      configurationFormState = null;
      configurationEditorBinding = null;
      configurationEditorError = error.message;
    }
  }
  updateConfigurationChrome();
  if (
    renderView &&
    !configurationAutoSelected &&
    !dashboard &&
    configurationStatus().safeMode === true
  ) {
    configurationAutoSelected = true;
    activateView("configuration", { focusHeading: false });
  } else if (
    renderView &&
    isConfigurationBackedView()
  ) {
    render();
  }
  return true;
}

async function loadConfiguration({ renderView = true } = {}) {
  const sequence = ++configurationRequestSequence;
  configurationAbortController?.abort();
  const controller = new AbortController();
  configurationAbortController = controller;
  try {
    const response = await configurationFetch("/api/configuration", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw await configurationResponseError(response, "读取配置状态失败");
    }
    const nextState = await response.json();
    if (
      !isCurrentConfigurationRequest({
        sequence,
        currentSequence: configurationRequestSequence,
        lastAppliedSequence: lastAppliedConfigurationRequest,
        signal: controller.signal,
      })
    ) {
      return false;
    }
    applyConfigurationState(nextState, sequence, { renderView });
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    if (
      !isCurrentConfigurationRequest({
        sequence,
        currentSequence: configurationRequestSequence,
        lastAppliedSequence: lastAppliedConfigurationRequest,
        signal: controller.signal,
      })
    ) {
      return false;
    }
    const nextError = error.message;
    const errorChanged = configurationLoadError !== nextError;
    configurationLoadError = nextError;
    if (
      renderView &&
      errorChanged &&
      isConfigurationBackedView()
    ) {
      renderConfigurationPreservingEditorFocus();
    }
    return false;
  } finally {
    if (configurationAbortController === controller) {
      configurationAbortController = null;
    }
  }
}

async function fetchDashboard() {
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取失败（${response.status}）`);
  return response.json();
}

async function fetchConfirmationQueue() {
  const response = await fetch(attentionNextUrl(), { cache: "no-store" });
  if (!response.ok) throw new Error(`读取确认队列失败（${response.status}）`);
  return response.json();
}

function refreshLoadedConfirmationHistory(
  queueRevision = confirmationQueueState.queueRevision,
) {
  if (
    currentView !== "employees" ||
    !confirmationHistoryLoaded ||
    confirmationHistoryLoading
  ) {
    return;
  }
  if (
    !confirmationHistoryError &&
    Number.isSafeInteger(queueRevision) &&
    queueRevision >= 0 &&
    confirmationHistoryQueueRevision === queueRevision
  ) {
    return;
  }
  void loadConfirmationHistory().catch((error) => {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  });
}

async function refreshConfirmationQueue({
  showConfirmation = true,
  renderView = true,
  sequence = ++confirmationRequestSequence,
} = {}) {
  const nextState = await fetchConfirmationQueue();
  const applied = applyConfirmationQueue(nextState, sequence);
  if (applied && dashboard && renderView) render();
  if (applied) refreshLoadedConfirmationHistory();
  if (applied && showConfirmation) queueMicrotask(showNextConfirmation);
  return applied;
}

async function loadConfigurationBackedView({ showConfirmation = true } = {}) {
  await Promise.all([
    loadConfiguration(),
    ...(currentView === "configuration" ? [loadBrainProviderStatus()] : []),
    refreshConfirmationQueue({
      showConfirmation: false,
      renderView: false,
    }),
  ]);
  if (showConfirmation) queueMicrotask(showNextConfirmation);
}

async function restoreDeferredConfirmations() {
  if (deferredConfirmationRestore !== null) return;
  const deferred = [...deferredConfirmations];
  if (deferred.length === 0) return;
  const restore = {
    sequence: ++confirmationRequestSequence,
    deferred,
  };
  deferredConfirmationRestore = restore;
  deferredConfirmations.clear();
  deferredConfirmationStore.clear();
  if (dashboard && currentView === "employees") render();
  try {
    const applied = await refreshConfirmationQueue({
      showConfirmation: false,
      sequence: restore.sequence,
    });
    const superseded = lastAppliedConfirmationRequest > restore.sequence;
    if (!applied && !superseded) {
      for (const key of restore.deferred) rememberDeferredConfirmation(key);
      statusBanner.hidden = false;
      statusBanner.textContent = "确认列表正在更新；稍后项已保留，请再次点击重新查看。";
    }
    if (deferredConfirmationRestore === restore) {
      deferredConfirmationRestore = null;
      if (dashboard && currentView === "employees") render();
    }
    if (applied && !superseded) queueMicrotask(showNextConfirmation);
  } catch (error) {
    const superseded = lastAppliedConfirmationRequest > restore.sequence;
    if (!superseded) {
      for (const key of restore.deferred) rememberDeferredConfirmation(key);
      statusBanner.hidden = false;
      statusBanner.textContent = `${error.message}。稍后项仍保留，可再次尝试。`;
    }
    if (deferredConfirmationRestore === restore) {
      deferredConfirmationRestore = null;
      if (dashboard && currentView === "employees") render();
    }
  }
}

async function refreshAfterDeferral() {
  try {
    await refreshConfirmationQueue({ showConfirmation: false });
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = `${error.message}。页面会自动重试读取确认队列。`;
  }
  queueMicrotask(showNextConfirmation);
}

async function load({ showConfirmation = true } = {}) {
  if (lanReadOnly) {
    const sequence = ++requestSequence;
    try {
      void loadEmployeeRoles();
      const snapshot = await fetchDashboard();
      if (snapshot) applyDashboard(snapshot, sequence);
      else render();
      if (currentView === "work") await workView.load();
      if (currentView === "workflow") await workflowView.load();
      if (currentView === "system") await loadSystemStatus();
      if (currentView === "automation-tests") await loadConfiguration();
    } catch {
      statusBanner.hidden = false;
      statusBanner.textContent = "局域网查看暂不可用，页面会自动重试。";
    }
    return;
  }
  if (isConfigurationBackedView()) {
    try {
      await loadConfigurationBackedView({ showConfirmation });
    } catch (error) {
      statusBanner.hidden = false;
      statusBanner.textContent = `${error.message}。页面会自动重试。`;
    }
    return;
  }
  const sequence = ++requestSequence;
  const confirmationSequence = ++confirmationRequestSequence;
  void loadEmployeeRoles();
  if (!hasConfigurationState()) {
    void loadConfiguration();
  }
  if (currentView === "system") {
    void loadSystemStatus();
  }
  try {
    const [dashboardResult, confirmationResult] = await Promise.allSettled([
      fetchDashboard(),
      fetchConfirmationQueue(),
    ]);
    let currentConfirmationFailure = false;
    if (confirmationResult.status === "fulfilled") {
      const applied = applyConfirmationQueue(
        confirmationResult.value,
        confirmationSequence,
      );
      if (applied && showConfirmation) queueMicrotask(showNextConfirmation);
    } else {
      currentConfirmationFailure = invalidateConfirmationQueueSnapshot(
        confirmationSequence,
      );
    }
    if (dashboardResult.status === "rejected") throw dashboardResult.reason;
    const refreshError = currentConfirmationFailure
      ? confirmationResult.reason
      : null;
    if (!dashboardResult.value) {
      render();
      refreshLoadedConfirmationHistory();
      if (confirmationResult.status === "rejected" && currentConfirmationFailure) {
        statusBanner.hidden = false;
        statusBanner.textContent =
          `${confirmationResult.reason.message}。主页面仍可使用，确认队列会自动重试。`;
      }
      return { refreshError };
    }
    applyDashboard(dashboardResult.value, sequence);
    if (currentView === "workflow") await workflowView.load();
    if (currentView === "work") await workView.load();
    refreshLoadedConfirmationHistory();
    if (confirmationResult.status === "rejected" && currentConfirmationFailure) {
      statusBanner.hidden = false;
      statusBanner.textContent =
        `${confirmationResult.reason.message}。主页面仍可使用，确认队列会自动重试。`;
    }
    return { refreshError };
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = `${error.message}。页面会自动重试。`;
    return { refreshError: error };
  }
}

async function refresh() {
  void taskRunsView.refresh();
  if (lanReadOnly) return load();
  refreshButton.disabled = true;
  refreshButton.classList.add("loading");
  if (isConfigurationBackedView()) {
    try {
      await loadConfigurationBackedView();
    } catch (error) {
      statusBanner.hidden = false;
      statusBanner.textContent = error.message;
    } finally {
      refreshButton.disabled = false;
      refreshButton.classList.remove("loading");
    }
    return;
  }
  if (currentView === "system") {
    try {
      await loadSystemStatus();
    } finally {
      refreshButton.disabled = false;
      refreshButton.classList.remove("loading");
    }
    return;
  }
  const sequence = ++requestSequence;
  try {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: { "x-mydashboard-action": "1" },
    });
    if (!response.ok) throw new Error(`刷新失败（${response.status}）`);
    applyDashboard(await response.json(), sequence);
    void loadEmployeeRoles();
    await refreshConfirmationQueue({ showConfirmation: false });
    if (currentView === "workflow") await workflowView.load();
    if (currentView === "work") await workView.load();
    queueMicrotask(showNextConfirmation);
  } catch (error) {
    statusBanner.hidden = false;
    statusBanner.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("loading");
  }
}

function activateView(view, { focusHeading = true } = {}) {
  if (!Object.hasOwn(viewTitles, view)) return;
  document.querySelector(".nav-item.active")?.classList.remove("active");
  document.querySelector(".nav-item[aria-current=page]")?.removeAttribute(
    "aria-current",
  );
  const button = document.querySelector(`.nav-item[data-view="${view}"]`);
  button?.classList.add("active");
  button?.setAttribute("aria-current", "page");
  const navigation = button?.closest(".nav");
  if (button && navigation?.scrollWidth > navigation.clientWidth) {
    const navigationBounds = navigation.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    navigation.scrollTo({
      left: navigation.scrollLeft + buttonBounds.left - navigationBounds.left -
        (navigationBounds.width - buttonBounds.width) / 2,
      behavior: "auto",
    });
  }
  currentView = view;
  try { sessionStorage.setItem('mydashboard.active-view', view); } catch { /* Navigation works without browser storage. */ }
  render();
  if (lanReadOnly) {
    if (focusHeading) pageTitle.focus({ preventScroll: true });
    if (view === "automation-tests") void loadConfiguration();
    if (view === "work") void workView.load();
    if (view === "workflow") void workflowView.load();
    if (view === "system") void loadSystemStatus();
    return;
  }
  if (currentView === "employees") void loadMaintenanceAttention();
  if (focusHeading) pageTitle.focus({ preventScroll: true });
  if (currentView === "configuration") {
    void loadConfiguration();
    void loadBrainProviderStatus();
  }
  if (currentView === "automation-tests") {
    void loadConfiguration();
  }
  if (currentView === "system") {
    void loadSystemStatus();
  }
  if (currentView === "memory" && !memoryLoaded) {
    loadMemories().catch((error) => {
      statusBanner.hidden = false;
      statusBanner.textContent = error.message;
    });
  }
  if (
    currentView === "employees" &&
    !confirmationHistoryLoaded &&
    !confirmationHistoryLoading
  ) {
    loadConfirmationHistory().catch((error) => {
      statusBanner.hidden = false;
      statusBanner.textContent = error.message;
    });
  }
  if (currentView === "workflow" && workflowView.needsLoad()) {
    workflowView.load();
  }
  if (currentView === "work" && workView.needsLoad()) {
    workView.load();
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    activateView(button.dataset.view);
  });
});

refreshButton.addEventListener("click", refresh);
document.querySelector(".dialog-close").addEventListener("click", closeDetailDialog);
confirmationCloseButton.addEventListener("click", async () => {
  if (confirmationCloseButton.disabled) return;
  if (activeInternalAttention) {
    await submitInternalAttention("later", { type: "later" });
    return;
  }
  if (activeConfirmationKey) {
    rememberDeferredConfirmation(activeConfirmationKey);
    activeConfirmationKey = "";
  }
  activeInternalAttention = null;
  activeExternalConfirmation = null;
  closeConfirmationDialog();
  await refreshAfterDeferral();
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDetailDialog();
});
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDetailDialog();
});
dialog.addEventListener("close", () => {
  codeJobDetailFocusIntent = null;
});
confirmationDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  confirmationCloseButton.click();
});
confirmationDialog.addEventListener("close", () => {
  if (confirmationDialog.open) return;
  confirmationDialogOwnership.handleCloseEvent({ dialogOpen: false });
  confirmationCloseButton.disabled = false;
});
document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable=true]")) return;
  if (/^[1-9]$/.test(event.key)) {
    document.querySelectorAll(".nav-item")[Number(event.key) - 1]?.click();
  }
  if (event.key === "0") {
    activateView("configuration");
  }
  if (event.key.toLowerCase() === "s") {
    activateView("system");
  }
  if (event.key.toLowerCase() === "t") {
    activateView("automation-tests");
  }
});

try {
  if (sessionStorage.getItem('mydashboard.active-view') === 'workbench') activateView('workbench', {focusHeading: false});
} catch { /* Browser storage is optional. */ }
void taskRunsView.start();
await load();
setInterval(load, 60_000);
