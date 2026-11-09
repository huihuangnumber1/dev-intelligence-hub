import { buildDashboard } from "../domain/dashboard-model.js";
import { mergeMailNotifications } from "../domain/dingtalk-mail.js";
import {
  ACTION_STATES,
  assessPullRequestResponsibility,
  isPersonalPullRequest,
} from "../domain/pr-responsibility.js";
import { prioritize } from "../domain/prioritizer.js";
import { diffSnapshots } from "../domain/snapshot-diff.js";
import { runStructuredProviderRequest } from "../lib/structured-provider-request.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizeNativeFailure } from "./task-run-execution-receipts.js";
import {
  resolveEffectivePullRequestUpdatedWindow,
} from "../domain/pull-request-updated-window.js";
import {
  applyDingTalkSummaries,
  dingTalkDigestFacts,
  prepareDingTalkDigest,
} from "../domain/dingtalk-digest.js";
import {
  createDingTalkReport,
  dueDingTalkReportSlot,
  normalizeDingTalkReportState,
  projectDingTalkReportState,
} from "../domain/dingtalk-report.js";

const DINGTALK_REPORT_STATE_KEY = "dingtalk-report-state";
const AUXILIARY_TIMEOUT_MS = 5_000;
const DINGTALK_TIMEOUT_MS = 30_000;

function auxiliaryTimeoutError() {
  return Object.assign(new Error("辅助数据读取超时，本轮保留已有数据"), {
    code: "REFRESH_AUXILIARY_TIMEOUT",
  });
}

function auxiliaryRead(operation, deadline, signal) {
  signal?.throwIfAborted();
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) return Promise.reject(auxiliaryTimeoutError());
  const controller = new AbortController();
  return runStructuredProviderRequest({
    controller, timeoutMs: remainingMs, signal,
    operation: () => operation(controller.signal),
    cancellationError: () => signal.reason,
    timeoutError: auxiliaryTimeoutError,
  });
}
const DINGTALK_KINDS_BY_SOURCE = Object.freeze({
  "daily messages": ["announcement", "message"],
  unread: ["conversation"],
  mentions: ["mention"],
  todos: ["todo"],
  mail: ["mail"],
});

const CONFIRMABLE_ACTION_STATES = new Set([
  ACTION_STATES.ACTION_NOW,
  ACTION_STATES.WAITING_OTHER,
  ACTION_STATES.HISTORICAL,
]);

function dashboardOptions(config) {
  return {
    issueActiveWindowDays: config.githubRead?.issueActiveWindowDays ?? 14,
  };
}

function personalSnapshot(snapshot) {
  return snapshot == null ? snapshot : { ...snapshot,
    items: snapshot.items.filter(item => item.kind !== 'pull_request' || isPersonalPullRequest(item)) };
}

function serviceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function clockMilliseconds(clock) {
  const value = clock();
  let milliseconds = Number.NaN;
  if (value instanceof Date) milliseconds = value.getTime();
  else if (typeof value === "number") milliseconds = value;
  else if (typeof value === "string") milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("RefreshService clock returned an invalid time");
  }
  return milliseconds;
}

function confirmedAssessment(actionState) {
  if (actionState === ACTION_STATES.ACTION_NOW) {
    return {
      actionState,
      nextActor: "me",
      nextAction: "user_confirmed_action",
      actionReasons: ["你已确认：现在轮到你处理"],
      requiresConfirmation: false,
    };
  }
  if (actionState === ACTION_STATES.WAITING_OTHER) {
    return {
      actionState,
      nextActor: "other",
      nextAction: "wait_other",
      actionReasons: ["你已确认：当前等待他人处理"],
      requiresConfirmation: false,
    };
  }
  return {
    actionState,
    nextActor: "none",
    nextAction: "archive",
    actionReasons: ["你已确认：这是历史事项，无需当前处理"],
    requiresConfirmation: false,
  };
}

function deduplicate(items) {
  const result = new Map();
  for (const item of items) {
    const existing = result.get(item.id);
    if (!existing) {
      result.set(item.id, item);
      continue;
    }
    if (item.relation === "authored") {
      result.set(item.id, item);
    } else if (
      existing.relation !== "authored" &&
      existing.assignmentSource !== "assignee" &&
      item.assignmentSource === "assignee"
    ) {
      result.set(item.id, item);
    }
  }
  return [...result.values()];
}

function brainAssessmentFingerprint(item, brainConfig) {
  return JSON.stringify({
    provider: brainConfig.provider || "",
    model: brainConfig.model || "",
    policyVersion: brainConfig.policyVersion || 1,
    relation: item.relation || "",
    assignmentSource: item.assignmentSource || "",
    author: item.author || "",
    currentUser: item.currentUser || "",
    gitTarget: item.gitTarget || null,
    gitTargetAvailable: item.gitTargetAvailable,
    githubAccount: item.githubAccount || "",
    baseRepository: item.baseRepository || "",
    baseRefName: item.baseRefName || "",
    baseRefOid: item.baseRefOid || "",
    headRepository: item.headRepository || "",
    headRefName: item.headRefName || "",
    state: item.state || "",
    isDraft: Boolean(item.isDraft),
    reviewFactsAvailable: item.reviewFactsAvailable === true,
    reviewFeedbackAvailable: item.reviewFeedbackAvailable,
    reviewFeedbackDigest: item.reviewFeedbackDigest,
    reviewFeedbackCount: item.reviewFeedbackCount,
    headRefOid: item.headRefOid || "",
    myReviewState: item.myReviewState || "",
    myReviewCommitOid: item.myReviewCommitOid || "",
    latestOtherDecisionState: item.latestOtherDecisionState || "",
    latestOtherDecisionCommitOid: item.latestOtherDecisionCommitOid || "",
    outstandingChangeRequestCommitOids:
      item.outstandingChangeRequestCommitOids || [],
    reviewDecision: item.reviewDecision || "",
    ciStatus: item.ciStatus || "",
    mergeStateStatus: item.mergeStateStatus || "",
    actionState: item.actionState || "uncertain",
  });
}

export class RefreshService {
  constructor({
    github,
    dingtalk,
    store,
    notifier,
    config,
    brain = null,
    operationQueue = null,
    repairProgressReader = null,
    clock = () => new Date(),
    auxiliaryTimeoutMs = AUXILIARY_TIMEOUT_MS,
    dingtalkTimeoutMs = DINGTALK_TIMEOUT_MS,
    dingtalkSummaryTimeoutMs = 180_000,
  }) {
    this.github = github;
    this.brain = brain;
    this.dingtalk = dingtalk;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    if (typeof clock !== "function") {
      throw new TypeError("RefreshService clock must be a function");
    }
    this.clock = clock;
    if (!Number.isSafeInteger(auxiliaryTimeoutMs) || auxiliaryTimeoutMs < 1 || auxiliaryTimeoutMs > 30_000) {
      throw new TypeError("RefreshService auxiliaryTimeoutMs must be between 1 and 30000");
    }
    this.auxiliaryTimeoutMs = auxiliaryTimeoutMs;
    if (!Number.isSafeInteger(dingtalkTimeoutMs) || dingtalkTimeoutMs < 1 || dingtalkTimeoutMs > 30_000) {
      throw new TypeError("RefreshService dingtalkTimeoutMs must be between 1 and 30000");
    }
    this.dingtalkTimeoutMs = dingtalkTimeoutMs;
    if (!Number.isSafeInteger(dingtalkSummaryTimeoutMs) || dingtalkSummaryTimeoutMs < 1 || dingtalkSummaryTimeoutMs > 600_000) {
      throw new TypeError("RefreshService dingtalkSummaryTimeoutMs must be between 1 and 600000");
    }
    this.dingtalkSummaryTimeoutMs = dingtalkSummaryTimeoutMs;
    this.pendingDingTalkSummary = null;
    this.summaryOperations = Promise.resolve();
    this.running = null;
    this.operationQueue = operationQueue;
    this.repairProgressReader = repairProgressReader;
    this.operations = Promise.resolve();
  }

  refresh(options = {}) {
    if (this.running) return this.running;
    const operation = this.#enqueue(() => this.#performRefresh(options));
    const tracked = operation.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  confirmPullRequestResponsibility(id, actionState, headRefOid) {
    return this.#enqueue(() =>
      this.#confirmPullRequestResponsibility(id, actionState, headRefOid),
    );
  }

  summarizePendingDingTalk({ signal } = {}) {
    const operation = this.summaryOperations.then(async () => {
      signal?.throwIfAborted();
      const request = this.pendingDingTalkSummary;
      if (!request) return { skipped: "no_pending_summary" };
      const meta = { enabled: true, errors: [] };
      const items = await this.#summarizeDingTalk(request.items, meta, signal,
        performance.now() + this.dingtalkSummaryTimeoutMs);
      return this.#enqueue(async () => {
        signal?.throwIfAborted();
        const current = await this.store.read("snapshot");
        if (this.pendingDingTalkSummary !== request || current?.refreshedAt !== request.refreshedAt ||
            current.brain?.dingtalkSummaryFingerprint !== request.fingerprint) return { skipped: "snapshot_changed" };
        const brain = { ...current.brain, ...meta,
          errors: [...current.brain.errors, ...meta.errors],
          dingtalkSummaryState: meta.dingtalkSummaryError ? "failed" : "complete" };
        // Summary metadata must not replace PR assessment/provider metadata.
        brain.enabled = current.brain.enabled;
        const next = { ...current, brain,
          items: [...current.items.filter(item => !Object.values(DINGTALK_KINDS_BY_SOURCE).flat().includes(item.kind)), ...items],
          sources: { ...current.sources, dingtalk: items.length } };
        const previous = await this.store.read("previous-snapshot");
        const dashboard = buildDashboard(next, previous, dashboardOptions(this.config));
        dashboard.dingtalkReport = projectDingTalkReportState(normalizeDingTalkReportState(await this.store.read(DINGTALK_REPORT_STATE_KEY)));
        signal?.throwIfAborted();
        await this.store.write("snapshot", next);
        await this.store.write("dashboard", dashboard);
        this.pendingDingTalkSummary = null;
        return { summarized: brain.dingtalkSummarized, state: brain.dingtalkSummaryState };
      });
    });
    this.summaryOperations = operation.catch(() => {});
    return operation;
  }

  #enqueue(operation) {
    if (this.operationQueue) return this.operationQueue.enqueue(operation);
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => {});
    return result;
  }

  async #confirmPullRequestResponsibility(id, actionState, headRefOid) {
    if (typeof id !== "string" || !id.trim()) {
      throw serviceError(400, "PR id 不能为空");
    }
    if (!CONFIRMABLE_ACTION_STATES.has(actionState)) {
      throw serviceError(
        400,
        "actionState 只能是 action_now、waiting_other 或 historical",
      );
    }
    if (typeof headRefOid !== "string" || !headRefOid.trim()) {
      throw serviceError(400, "headRefOid 不能为空");
    }

    const snapshot = await this.store.read("snapshot");
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw serviceError(409, "尚无可确认的当前快照，请先刷新");
    }

    const itemId = id.trim();
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw serviceError(404, `当前快照中找不到 ${itemId}`);
    }
    if (item.kind !== "pull_request") {
      throw serviceError(409, "只有 PR 可以确认责任状态");
    }
    if (item.actionState !== ACTION_STATES.UNCERTAIN) {
      throw serviceError(409, "该 PR 已不是待确认状态");
    }
    if (!item.headRefOid) {
      throw serviceError(409, "PR 缺少当前提交标识，无法安全保存确认结果");
    }
    if (item.headRefOid !== headRefOid.trim()) {
      throw serviceError(409, "PR 已出现新提交，请根据最新事实重新确认");
    }

    const overrides = await this.store.read(
      "pr-responsibility-overrides",
      {},
    );
    const confirmedAt = new Date().toISOString();
    const nextOverrides = {
      ...(overrides && typeof overrides === "object" ? overrides : {}),
      [item.id]: {
        id: item.id,
        headRefOid: item.headRefOid,
        actionState,
        confirmedAt,
      },
    };
    const confirmedItem = {
      ...item,
      ...confirmedAssessment(actionState),
      responsibilityConfirmedAt: confirmedAt,
    };
    const nextSnapshot = {
      ...snapshot,
      items: snapshot.items.map((candidate) =>
        candidate.id === item.id ? confirmedItem : candidate,
      ),
    };
    const previousSnapshot = await this.store.read("previous-snapshot");
    const dashboard = buildDashboard(
      nextSnapshot,
      previousSnapshot,
      dashboardOptions(this.config),
    );

    await this.store.write("pr-responsibility-overrides", nextOverrides);
    await this.store.write("snapshot", nextSnapshot);
    await this.store.write("dashboard", dashboard);
    return dashboard;
  }

  async #assessUncertainPullRequests(items, signal, deadline) {
    const brainConfig = this.config.brain || {};
    const meta = {
      enabled: Boolean(brainConfig.enabled),
      provider: brainConfig.primaryBrain?.provider || brainConfig.provider || "",
      model: brainConfig.primaryBrain?.model || brainConfig.model || "",
      assessed: 0,
      errors: [],
    };
    if (!meta.enabled) return { items, meta };
    if (!this.brain) {
      meta.errors.push("大脑适配器未配置");
      return { items, meta };
    }

    const limit = brainConfig.maxAssessmentsPerRefresh ?? 3;
    const candidates = items
      .filter(
        (item) =>
          item.actionState === ACTION_STATES.UNCERTAIN &&
          !item.brainAssessment,
      )
      .slice(0, limit);
    for (const item of candidates) {
      signal?.throwIfAborted();
      try {
        // Adapters receive a detached input: a late response cannot mutate a published snapshot.
        item.brainAssessment = await auxiliaryRead(
          stageSignal => this.brain.assessPullRequest(structuredClone(item), { signal: stageSignal }),
          deadline, signal,
        );
        meta.assessed += 1;
      } catch (error) {
        signal?.throwIfAborted();
        meta.errors.push(`${item.repo || item.id} #${item.number || "?"}: ${error.message}`);
        if (error.code === "REFRESH_AUXILIARY_TIMEOUT") break;
      }
    }
    return { items, meta };
  }

  async #summarizeDingTalk(items, brainMeta, signal, deadline) {
    const prepared = prepareDingTalkDigest(items);
    brainMeta.dingtalkGroups = prepared.groups.length;
    brainMeta.dingtalkSummarized = 0;
    if (prepared.groups.length === 0) {
      return applyDingTalkSummaries(prepared);
    }
    if (
      !brainMeta.enabled ||
      !this.brain ||
      typeof this.brain.summarizeDingTalk !== "function"
    ) {
      return applyDingTalkSummaries(prepared);
    }

    try {
      signal?.throwIfAborted();
      const facts = dingTalkDigestFacts(prepared.groups);
      const receipt = await auxiliaryRead(async stageSignal =>
        typeof this.brain.summarizeDingTalkWithReceipt === "function"
          ? this.brain.summarizeDingTalkWithReceipt(facts, { signal: stageSignal })
          : { summaries: await this.brain.summarizeDingTalk(facts, { signal: stageSignal }), fallbackUsed: false },
      deadline, signal);
      const summaries = receipt.summaries;
      if (receipt.fallbackUsed) {
        brainMeta.fallbackUsed = true;
        brainMeta.fallbackProvider = this.config.brain?.provider || "ollama";
        brainMeta.fallbackModel = this.config.brain?.model || "";
      }
      brainMeta.dingtalkSummarized = summaries.length;
      return applyDingTalkSummaries(prepared, summaries);
    } catch (error) {
      signal?.throwIfAborted();
      brainMeta.dingtalkSummaryError = {
        message: error.message,
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.primaryFailureCode === "string" ? { primaryFailureCode: error.primaryFailureCode } : {}),
        ...(typeof error.fallbackFailureCode === "string" ? { fallbackFailureCode: error.fallbackFailureCode } : {}),
      };
      try {
        const diagnostic = Object.getOwnPropertyDescriptor(error, "primaryNativeFailure")?.value;
        if (diagnostic) brainMeta.dingtalkSummaryError.primaryNativeFailure = normalizeNativeFailure(diagnostic);
      } catch { /* Invalid diagnostics do not replace the original provider failure. */ }
      brainMeta.errors.push("钉钉 AI 摘要暂时不可用，已显示消息摘录；系统将自动重试。");
      return applyDingTalkSummaries(prepared);
    }
  }

  async #performRefresh({ notify = false, signal, deferDingTalkSummary = false } = {}) {
    signal?.throwIfAborted();
    const startedAt = clockMilliseconds(this.clock);
    const observationLowerBound = new Date(startedAt).toISOString();
    const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
      this.config.githubRead?.pullRequestUpdatedWindow,
      observationLowerBound,
    );
    const [previous, notificationBaseline, responsibilityOverrides] =
      await Promise.all([
        this.store.read("snapshot"),
        this.store.read("notification-snapshot"),
        this.store.read("pr-responsibility-overrides", {}),
      ]);
    signal?.throwIfAborted();
    const previousItems = previous?.items || [];
    const errors = [];
    const since = previous?.refreshedAt;

    // Collect independent sources while GitHub is loading. A slow mailbox gets
    // its own bounded read, without spending the optional AI enrichment budget.
    const dingtalkCollection = this.config.dingtalk.enabled
      ? auxiliaryRead(stageSignal => this.dingtalk.collect(since, {
          signal: stageSignal, mailEnabled: this.config.dingtalk.mailEnabled === true,
          sourceTimeoutMs: Math.max(1, this.dingtalkTimeoutMs - Math.min(1000, Math.floor(this.dingtalkTimeoutMs / 5))),
        }), performance.now() + this.dingtalkTimeoutMs, signal).catch((error) => ({
          items: previousItems.filter((item) =>
            ["announcement", "message", "mention", "todo", "conversation",
              ...(this.config.dingtalk.mailEnabled ? ["mail"] : [])].includes(item.kind)),
          errors: [`钉钉: ${error.message}`],
          retained: true,
        }))
      : Promise.resolve({ items: [], errors: [] });

    const githubCalls = this.config.githubRead?.enabled === false
      ? [[], [], []].map((value) => ({ status: "fulfilled", value }))
      : await Promise.allSettled([
          this.github.searchRelevantPullRequests({
            signal,
            effectiveUpdatedWindow,
          }),
          this.github.searchIssues({ signal }),
          this.github.versions(this.config.trackedRepositories, { signal }),
        ]);
    signal?.throwIfAborted();
    const names = [
      "GitHub 与我相关的 PR",
      "GitHub Issue",
      "GitHub 版本",
    ];
    const githubFallbacks = [
      previousItems.filter((item) => item.kind === "pull_request"),
      previousItems.filter((item) => item.kind === "issue"),
      previous?.versions || [],
    ];
    const githubValues = githubCalls.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      errors.push(`${names[index]}: ${result.reason.message}`);
      return githubFallbacks[index];
    });
    const previousPullRequests = new Map(
      (previous?.items || [])
        .filter((item) => item.kind === "pull_request")
        .map((item) => [item.id, item]),
    );
    let pullRequests = githubValues[0].filter(isPersonalPullRequest).map(({ reviewRepairProgress: _previous, ...item }) => item);
    if (githubCalls[0].status === "fulfilled" && this.config.githubRead?.enabled !== false && this.repairProgressReader !== null) {
      pullRequests = await this.repairProgressReader.enrich(pullRequests, { signal });
    }
    const classifiedPullRequests = pullRequests.map((item) => {
      const classified = {
        ...item,
        ...assessPullRequestResponsibility(item, {
          now: observationLowerBound,
          historicalAfterDays:
            this.config.prResponsibility?.historicalAfterDays ?? 30,
        }),
      };
      const previousItem = previousPullRequests.get(item.id);
      const override = responsibilityOverrides?.[item.id];
      const matchingOverride =
        classified.headRefOid &&
        override?.headRefOid === classified.headRefOid &&
        CONFIRMABLE_ACTION_STATES.has(override?.actionState);
      const assessmentFingerprint = brainAssessmentFingerprint(
        classified,
        this.config.brain || {},
      );
      if (
        classified.actionState === ACTION_STATES.UNCERTAIN &&
        previousItem?.brainAssessment &&
        (previousItem.brainAssessmentFingerprint === assessmentFingerprint ||
          matchingOverride)
      ) {
        classified.brainAssessment = previousItem.brainAssessment;
      }
      if (classified.actionState === ACTION_STATES.UNCERTAIN) {
        classified.brainAssessmentFingerprint = assessmentFingerprint;
      } else {
        delete classified.brainAssessment;
        delete classified.brainAssessmentFingerprint;
      }
      if (
        classified.actionState !== ACTION_STATES.UNCERTAIN ||
        !matchingOverride
      ) {
        return classified;
      }
      return {
        ...classified,
        ...confirmedAssessment(override.actionState),
        responsibilityConfirmedAt: override.confirmedAt || "",
      };
    });
    // PR assessments share one budget rather than one timeout per PR.
    const auxiliaryDeadline = performance.now() + this.auxiliaryTimeoutMs;
    const brainAssessment = this.#assessUncertainPullRequests(
      classifiedPullRequests,
      signal,
      auxiliaryDeadline,
    );
    const [assessedPullRequests, dingtalkResult] = await Promise.all([
      brainAssessment,
      dingtalkCollection,
    ]);
    signal?.throwIfAborted();
    errors.push(...dingtalkResult.errors);
    dingtalkResult.items = mergeMailNotifications(dingtalkResult.items,
      [...assessedPullRequests.items, ...githubValues[1]]);
    const staleDingTalkKinds = new Set(
      (dingtalkResult.failedSources || [])
        .flatMap((source) => DINGTALK_KINDS_BY_SOURCE[source] || []),
    );
    const prepared = prepareDingTalkDigest(dingtalkResult.items);
    const fingerprint = canonicalJsonDigest([dingTalkDigestFacts(prepared.groups), this.config.brain ?? null]);
    let summaryRequest = null;
    let freshDingTalkItems;
    const reusable = !dingtalkResult.retained && previous?.brain?.dingtalkSummaryState === "complete" && previous.brain.dingtalkSummarized > 0 &&
      previous.brain.dingtalkSummaryFingerprint === fingerprint;
    if (reusable) {
      const ids = new Set(prepared.groups.map(group => `dingtalk:digest:${group.groupId}`));
      freshDingTalkItems = [...prepared.passthrough, ...previous.items.filter(item => ids.has(item.id))];
      Object.assign(assessedPullRequests.meta, { dingtalkSummaryFingerprint: fingerprint, dingtalkSummaryState: "complete",
        dingtalkGroups: prepared.groups.length, dingtalkSummarized: previous.brain.dingtalkSummarized });
      for (const key of ["fallbackUsed", "fallbackProvider", "fallbackModel"]) {
        if (Object.hasOwn(previous.brain, key)) assessedPullRequests.meta[key] = previous.brain[key];
      }
    } else if (deferDingTalkSummary && !dingtalkResult.retained && prepared.groups.length > 0 &&
        assessedPullRequests.meta.enabled && typeof this.brain?.summarizeDingTalk === "function") {
      freshDingTalkItems = applyDingTalkSummaries(prepared);
      Object.assign(assessedPullRequests.meta, { dingtalkSummaryFingerprint: fingerprint, dingtalkSummaryState: "pending",
        dingtalkGroups: prepared.groups.length, dingtalkSummarized: 0 });
      summaryRequest = { refreshedAt: observationLowerBound, fingerprint, items: structuredClone(dingtalkResult.items) };
    } else {
      freshDingTalkItems = dingtalkResult.retained ? dingtalkResult.items :
        await this.#summarizeDingTalk(dingtalkResult.items, assessedPullRequests.meta, signal, performance.now() + this.dingtalkSummaryTimeoutMs);
      if (!dingtalkResult.retained) Object.assign(assessedPullRequests.meta, {
        dingtalkSummaryFingerprint: fingerprint, dingtalkSummaryState: assessedPullRequests.meta.dingtalkSummaryError ? "failed" : "complete" });
    }
    const summarizedDingTalkItems = deduplicate([
      ...freshDingTalkItems,
      ...previousItems.filter((item) => staleDingTalkKinds.has(item.kind)),
    ]);
    if (summaryRequest) summaryRequest.items = deduplicate([
      ...summaryRequest.items, ...previousItems.filter(item => staleDingTalkKinds.has(item.kind)),
    ]);
    // A fact refresh can finish before the model. Keep that same request when
    // both its authorization/configuration and complete input are unchanged.
    if (summaryRequest && this.pendingDingTalkSummary?.fingerprint === fingerprint &&
        canonicalJsonDigest(this.pendingDingTalkSummary.items) === canonicalJsonDigest(summaryRequest.items)) {
      summaryRequest = this.pendingDingTalkSummary;
    }
    signal?.throwIfAborted();

    const snapshot = {
      refreshedAt: observationLowerBound,
      sources: {
        github:
          assessedPullRequests.items.length + githubValues[1].length,
        dingtalk: summarizedDingTalkItems.length,
      },
      sourceStatus: {
        githubPullRequests: {
          ok: githubCalls[0].status === "fulfilled",
          stale: githubCalls[0].status !== "fulfilled",
          enabled: this.config.githubRead?.enabled !== false,
          complete:
            this.config.githubRead?.enabled !== false &&
            githubCalls[0].status === "fulfilled",
          effectiveUpdatedWindow,
        },
        githubIssues: {
          ok: githubCalls[1].status === "fulfilled",
          stale: githubCalls[1].status !== "fulfilled",
        },
        githubVersions: {
          ok: githubCalls[2].status === "fulfilled",
          stale: githubCalls[2].status !== "fulfilled",
        },
        dingtalk: {
          ok: dingtalkResult.errors.length === 0,
          stale: dingtalkResult.errors.length > 0,
        },
      },
      errors,
      brain: assessedPullRequests.meta,
      items: deduplicate([
        ...assessedPullRequests.items,
        ...githubValues[1],
        ...summarizedDingTalkItems,
      ]),
      versions: githubValues[2],
    };
    snapshot.durationMs = Math.max(
      0,
      clockMilliseconds(this.clock) - startedAt,
    );
    const diff = diffSnapshots(personalSnapshot(previous), snapshot);
    const dashboard = buildDashboard(
      snapshot,
      previous,
      dashboardOptions(this.config),
    );

    let reportState = normalizeDingTalkReportState(
      await this.store.read(DINGTALK_REPORT_STATE_KEY),
    );
    let scheduledReportError = "";
    if (
      this.config.dingtalk.enabled &&
      !errors.length &&
      typeof this.notifier.sendReport === "function"
    ) {
      const reportNow = new Date(clockMilliseconds(this.clock));
      const slot = dueDingTalkReportSlot(reportNow, reportState.lastSlotKey);
      if (slot) {
        const report = createDingTalkReport(
          dashboard,
          slot,
          reportState,
          reportNow,
        );
        reportState = {
          schemaVersion: 1,
          revision: reportState.revision + 1,
          lastSlotKey: slot.slotKey,
          baseline: report.baseline,
          latest: { status: "sending", report },
        };
        await this.store.write(DINGTALK_REPORT_STATE_KEY, reportState);
        try {
          await this.notifier.sendReport(report, { signal });
          reportState = {
            ...reportState,
            revision: reportState.revision + 1,
            latest: {
              status: "sent",
              report,
              sentAt: new Date(clockMilliseconds(this.clock)).toISOString(),
            },
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          reportState = {
            ...reportState,
            revision: reportState.revision + 1,
            latest: {
              status: "failed",
              report,
              error: "本时段汇报发送失败；为避免重复发送，系统不会自动重发。",
            },
          };
          scheduledReportError = `钉钉定时汇报: ${error.message}`;
        }
        await this.store.write(DINGTALK_REPORT_STATE_KEY, reportState);
      }
    }
    dashboard.dingtalkReport = projectDingTalkReportState(reportState);

    let notification = { sent: false, reason: "disabled" };
    let notificationDiff = null;
    if (notify && this.config.dingtalk.enabled && !errors.length) {
      notificationDiff = diffSnapshots(personalSnapshot(notificationBaseline), snapshot);
      try {
        notification = await this.notifier.send(
          notificationDiff,
          prioritize(
            snapshot.items,
            snapshot.refreshedAt,
            dashboardOptions(this.config),
          ),
          { signal },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        notification = {
          sent: false,
          reason: "send-failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      signal?.throwIfAborted();
      if (
        notification.sent === true ||
        ["baseline", "no-important-change"].includes(notification.reason)
      ) {
        await this.store.write("notification-snapshot", snapshot);
      }
    }
    if (scheduledReportError) errors.push(scheduledReportError);

    await this.store.write("previous-snapshot", previous);
    signal?.throwIfAborted();
    await this.store.write("snapshot", snapshot);
    signal?.throwIfAborted();
    await this.store.write("dashboard", dashboard);
    signal?.throwIfAborted();
    await this.store.write("last-run", {
      diff,
      notificationDiff,
      notification,
    });
    if (summaryRequest) summaryRequest.refreshedAt = observationLowerBound;
    this.pendingDingTalkSummary = summaryRequest;
    return { dashboard, diff, notification };
  }
}
