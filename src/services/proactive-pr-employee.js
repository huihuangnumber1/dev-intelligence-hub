import { createHash } from "node:crypto";
import { isBrainRequestInfrastructureFailure } from "../domain/brain-failure-recovery.js";
import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import { automaticReviewEligibility } from "../domain/automatic-review-policy.js";
import { normalizePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { createPrReviewConfirmationPlan } from "../domain/pr-review-confirmation.js";
import { EmployeeController } from "./employee-controller.js";

const STATE_KEY = "pr-employee-state";
const MEMORY_KEY = "pr-employee-memory";
const ACTIVE_JOB_STATES = new Set([
  "queued",
  "running",
  "retry_wait",
  "ready",
  "ready_for_human",
  "confirmation_enqueue_pending",
  "confirmation_invalidation_pending",
  "waiting_confirmation",
  "waiting_retry_confirmation",
]);
const WORK_POLICY_BY_ACTION = Object.freeze({
  review: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
    triageTargetRoleId: "pr-engineer",
  },
  rereview: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
    triageTargetRoleId: "pr-engineer",
  },
  complete_review: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
    triageTargetRoleId: "pr-engineer",
  },
  fix_ci: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
    triageTargetRoleId: "developer",
  },
  resolve_conflict: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
    triageTargetRoleId: "developer",
  },
  address_review: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
    triageTargetRoleId: "developer",
  },
  continue_draft: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
    triageTargetRoleId: "developer",
  },
});
const DECISIONS = new Set(["accept", "reject"]);
const BLOCKED_JOB_ACTIONS = new Set(["retry", "dismiss"]);
const DIRECT_ACTION_ADMISSION = Object.freeze({
  run: (operation) => operation(),
});
const RUNTIME_ADMISSION_FAILURES = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);

function actionAdmissionRun(value) {
  const gate = value === undefined ? DIRECT_ACTION_ADMISSION : value;
  if (!gate || typeof gate.run !== "function") {
    throw new TypeError("actionAdmissionGate must provide run(operation)");
  }
  return gate.run.bind(gate);
}

async function runAdmittedOperation(admitAction, operation) {
  const admitted = await admitAction(() => {
    try {
      return { operation: operation(), synchronousError: null };
    } catch (error) {
      return { operation: null, synchronousError: error };
    }
  });
  if (admitted.synchronousError !== null) throw admitted.synchronousError;
  return admitted.operation;
}

function stableFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor
      ? descriptor.value
      : null;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
      return code;
    }
  } catch {
    // Treat hostile error values as an ordinary job failure.
  }
  return "PR_EMPLOYEE_JOB_FAILED";
}

function isSameRunningClaim(job, claimed) {
  return Boolean(
    job &&
      job.id === claimed.id &&
      job.status === "running" &&
      job.fingerprint === claimed.fingerprint &&
      job.headRefOid === claimed.headRefOid &&
      job.gitTargetDigest === claimed.gitTargetDigest &&
      job.policyVersion === claimed.policyVersion &&
      job.attempts === claimed.attempts &&
      job.startedAt === claimed.startedAt &&
      job.leaseUntil === claimed.leaseUntil &&
      job.brain?.provider === claimed.brain?.provider &&
      job.brain?.model === claimed.brain?.model,
  );
}

function serviceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function defaultState() {
  return {
    jobs: [],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "",
  };
}

function normalizedState(value) {
  if (!value || typeof value !== "object") return defaultState();
  return {
    ...defaultState(),
    ...value,
    jobs: Array.isArray(value.jobs) ? value.jobs : [],
    memoryOutbox: Array.isArray(value.memoryOutbox)
      ? value.memoryOutbox
      : [],
  };
}

function itemGitTargetDigest(item) {
  if (item?.gitTargetAvailable !== true || !item.gitTarget) return null;
  try {
    const target = normalizePullRequestGitTarget(item.gitTarget);
    if (
      target.baseRepository !== item.repo ||
      target.headRefOid !== item.headRefOid
    ) {
      return null;
    }
    return createHash("sha256")
      .update(JSON.stringify(target), "utf8")
      .digest("hex");
  } catch {
    return null;
  }
}

function sameJobGitTarget(job, item) {
  const currentDigest = itemGitTargetDigest(item);
  return currentDigest !== null && currentDigest === job.gitTargetDigest;
}

function jobMatchesCurrentCandidate(job, item, policyVersion) {
  return Boolean(
    item &&
      isCandidate(item) &&
      item.headRefOid === job.headRefOid &&
      sameJobGitTarget(job, item) &&
      item.nextAction === job.nextAction &&
      item.relation === job.relation &&
      job.policyVersion === policyVersion,
  );
}

function isAnalysisBlocked(job) {
  return Boolean(
    job?.status === "blocked" &&
      !job.confirmationId &&
      !job.confirmationFailure,
  );
}

function brainIdentity(brain) {
  if (typeof brain?.provider !== "string" || !brain.provider ||
      typeof brain.model !== "string" || !brain.model) return null;
  return { provider: brain.provider, model: brain.model };
}

function sameBrain(left, right) {
  return Boolean(left && right && left.provider === right.provider && left.model === right.model);
}

function hasValidAnalysisAttemptBudget(job) {
  const budget = job.analysisAttemptBudget;
  return budget === undefined || Boolean(brainIdentity(budget) &&
    Number.isSafeInteger(budget.attemptOffset) && budget.attemptOffset >= 0 &&
    Number.isSafeInteger(job.attempts) && budget.attemptOffset <= job.attempts);
}

function analysisAttemptBudget(job, brain) {
  if (!hasValidAnalysisAttemptBudget(job)) return null;
  const budget = job.analysisAttemptBudget;
  if (job.status === "retry_wait" && canRebindAnalysisModel(job, brain)) {
    return { ...brain, attemptOffset: job.attempts };
  }
  return sameBrain(budget, brain) ? { ...brain, attemptOffset: budget.attemptOffset }
    : { ...brain, attemptOffset: 0 };
}

function isLegacyOllamaTransportFailure(job) {
  return job.failureCode === undefined && job.failurePhase === undefined &&
    job.brain?.provider === "ollama" &&
    job.error === "Ollama employee transport request failed";
}

function hasRecoverableAnalysisIdentity(job, brain) {
  return Boolean(brain && ["blocked", "retry_wait"].includes(job.status) &&
    !job.confirmationId && !job.confirmationFailure && !job.confirmationIntent && !job.handoffWorkItemId &&
    !job.completedAt && !job.decision && !job.leaseUntil &&
    Number.isSafeInteger(job.attempts) && job.attempts >= 1 && job.attempts < Number.MAX_SAFE_INTEGER &&
    hasValidAnalysisAttemptBudget(job));
}

function knownAnalysisTransportFailure(job) {
  const failure = job.analysisFailure;
  return job.brain?.provider === "ollama" && job.error === "Ollama employee transport request failed" &&
    (failure === undefined ? isLegacyOllamaTransportFailure(job) : failure.phase === "analysis" && failure.code === "PR_EMPLOYEE_JOB_FAILED") &&
    (!job.brain.fallbackFrom || job.brain.fallbackFrom.reason === "PR_EMPLOYEE_PRIMARY_TIMEOUT" ||
      isBrainRequestInfrastructureFailure(job.brain.fallbackFrom.reason));
}

function recordedInfrastructureFailure(job) {
  const failure = job.analysisFailure;
  return failure?.phase === "analysis" && failure.infrastructureFailure === true && failure.modelFailure === false &&
    (failure.code === "PR_EMPLOYEE_PRIMARY_TIMEOUT" || isBrainRequestInfrastructureFailure(failure.code) || knownAnalysisTransportFailure(job));
}

function canRebindAnalysisModel(job, brain) {
  if (!hasRecoverableAnalysisIdentity(job, brain)) return false;
  const failure = job.analysisFailure;
  if (failure === undefined ? !isLegacyOllamaTransportFailure(job)
    : failure?.phase !== "analysis" || (failure.modelFailure !== true && !recordedInfrastructureFailure(job))) return false;
  const previousBrain = brainIdentity(job.analysisAttemptBudget ?? job.brain?.fallbackFrom ?? job.brain);
  return Boolean(previousBrain && !sameBrain(previousBrain, brain));
}

function recoverInfrastructureAnalysis(job, brain, runAt) {
  if (!isAnalysisBlocked(job) || !hasRecoverableAnalysisIdentity(job, brain)) return null;
  if (!knownAnalysisTransportFailure(job) && !recordedInfrastructureFailure(job)) return null;
  const previousBrain = brainIdentity(job.analysisAttemptBudget ?? job.brain?.fallbackFrom ?? job.brain);
  if (!sameBrain(previousBrain, brain)) return null;
  // Only the last persisted failure is proven infrastructure-related. Refund
  // that one attempt; retain all earlier charges and the complete job history.
  const offset = (job.analysisAttemptBudget?.attemptOffset ?? 0) + 1;
  if (offset > job.attempts) return null;
  return { ...job, status: "queued", error: "", startedAt: null, leaseUntil: null, nextAttemptAt: null,
    analysisAttemptBudget: { ...brain, attemptOffset: offset }, infrastructureRetryRequestedAt: runAt, updatedAt: runAt };
}

function recoverForChangedAnalysisModel(job, brain, runAt) {
  if (!isAnalysisBlocked(job) || !canRebindAnalysisModel(job, brain)) return null;
  return { ...job, status: "queued", error: "", startedAt: null, leaseUntil: null, nextAttemptAt: null,
    analysisAttemptBudget: { ...brain, attemptOffset: job.attempts },
    modelRetryRequestedAt: runAt, updatedAt: runAt };
}

function jobFingerprint(item, policyVersion) {
  return [
    item.id,
    itemGitTargetDigest(item),
    item.nextAction,
    policyVersion,
  ].join("\u0000");
}

function jobId(fingerprint) {
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `pr-work-${digest.slice(0, 20)}`;
}

function workPolicy(item) {
  const policy = WORK_POLICY_BY_ACTION[item?.nextAction];
  return policy?.relations.includes(item?.relation) ? policy : null;
}

function effectiveWorkPolicy(item, triageOnly) {
  const policy = workPolicy(item);
  if (!policy || triageOnly !== true) return policy;
  return {
    ...policy,
    mode: "triage",
    workType: "triage_plan",
    requiresApproval: false,
    targetRoleId: policy.triageTargetRoleId || "pr-engineer",
  };
}

function isCandidate(item) {
  return Boolean(
    item?.kind === "pull_request" &&
      item.actionState === "action_now" &&
      item.reviewFactsAvailable === true &&
      item.headRefOid &&
      itemGitTargetDigest(item) !== null &&
      workPolicy(item),
  );
}

function roleState(state, enabled) {
  if (!enabled) return "disabled";
  if (state.paused) return "paused";
  if (
    state.jobs.some((job) =>
      ["queued", "running", "retry_wait"].includes(job.status),
    )
  ) {
    return "working";
  }
  if (
    state.jobs.some(
      (job) => job.status === "confirmation_invalidation_pending",
    )
  ) {
    return "degraded";
  }
  if (
    state.jobs.some((job) =>
      [
        "ready_for_human",
        "waiting_confirmation",
        "waiting_retry_confirmation",
      ].includes(job.status),
    )
  ) {
    return "waiting_user";
  }
  if (state.jobs.some((job) => job.status === "blocked")) return "degraded";
  if (state.memoryOutboxError) return "degraded";
  if (state.lastError) return "degraded";
  return "observing";
}

function latestJobError(jobs) {
  const job = [...jobs]
    .filter(
      (job) =>
        ["retry_wait", "blocked"].includes(job.status) && job.error,
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0),
    )[0];
  if (!job) return "";
  const primary = job.brain?.fallbackFrom;
  if (!primary) return `#${job.number}: ${job.error}`;
  const detail = primary.nativeFailure;
  const stage = detail ? ` (${detail.method ?? detail.kind}, ${detail.code ?? "未知"})` : "";
  return `#${job.number}：主模型 ${primary.provider}/${primary.model} 失败（${primary.reason}${stage}）；备用模型 ${job.brain.provider}/${job.brain.model} 失败（${job.error}）`;
}

function trimJobs(jobs, limit) {
  const cappedLimit = Math.max(1, Number(limit) || 500);
  if (jobs.length <= cappedLimit) return jobs;
  const active = jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status));
  const terminal = jobs
    .filter((job) => !ACTIVE_JOB_STATES.has(job.status))
    .sort(
      (left, right) =>
        Date.parse(
          right.completedAt || right.updatedAt || right.createdAt || 0,
        ) -
        Date.parse(
          left.completedAt || left.updatedAt || left.createdAt || 0,
        ),
    );
  return [
    ...active,
    ...terminal.slice(0, Math.max(0, cappedLimit - active.length)),
  ];
}

function memoryText(memory) {
  return [
    memory.title,
    memory.summary,
    ...(memory.evidence || []),
    ...(memory.steps || []),
    memory.reviewBody,
    memory.repository,
    memory.sourceId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

function sameJsonValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function projectWork(state) {
  const jobs = [...state.jobs].sort(
    (left, right) =>
      Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0),
  );
  return {
    jobs,
    confirmationQueue: jobs.filter(
      (job) => job.status === "ready_for_human",
    ),
  };
}

export class ProactivePrEmployeeService {
  #admitAction;

  #isCandidate(item) {
    // The GitHub source already routes authored review feedback to developer.
    // A legacy owner-request handoff would supersede that automatic repair root.
    if (
      this.config.triageOnly === true &&
      this.config.automaticOwnPrRepair === true &&
      item?.relation === "authored" &&
      ["address_review", "resolve_conflict"].includes(item.nextAction)
    ) {
      return false;
    }
    const policy = this.config.automaticReviewPolicy;
    return isCandidate(item) && (policy == null || item.relation !== "review_requested" ||
      (policy.enabled && automaticReviewEligibility(item, policy.account, this.clock()) === null));
  }

  async #stillNeedsReviewTriage(item, signal) {
    const policy = this.config.automaticReviewPolicy;
    if (this.config.triageOnly !== true || policy?.enabled !== true || item.relation !== "review_requested") return true;
    const unavailable = () => Object.assign(new Error("无法读取 PR 当前审核与分配状态"), { code: "PR_LIVE_REVIEW_FACTS_UNAVAILABLE" });
    if (typeof this.github.readIncomingReviewRequest !== "function") throw unavailable();
    const facts = await this.github.readIncomingReviewRequest({ repository: item.repo, number: item.number, account: policy.account },
      signal === null ? undefined : { signal });
    signal?.throwIfAborted();
    if (facts?.kind !== "pull_request" || facts.incomingReviewFactsAvailable !== true ||
        typeof facts.repo !== "string" || facts.repo.toLowerCase() !== item.repo.toLowerCase() ||
        typeof facts.currentUser !== "string" || facts.currentUser.toLowerCase() !== policy.account.toLowerCase() ||
        !["open", "closed", "merged"].includes(facts.state?.toLowerCase()) || typeof facts.isDraft !== "boolean" ||
        typeof facts.author !== "string" || !facts.author || !Array.isArray(facts.assignees) ||
        !facts.assignees.every(login => typeof login === "string" && login.length > 0) ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(facts.headRefOid || "")) throw unavailable();
    const reason = automaticReviewEligibility(facts, policy.account, this.clock());
    if (reason === "INVALID_TARGET" || (reason === "SELF_AUTHORED" && facts.author.toLowerCase() !== policy.account.toLowerCase())) throw unavailable();
    return facts.headRefOid === item.headRefOid && reason === null;
  }

  constructor({
    store,
    github,
    reviewer,
    config = {},
    clock = () => new Date(),
    operationQueue = null,
    producerQueue = null,
    triageHandoff = null,
    githubActions = { enabled: false },
    actionAdmissionGate,
  }) {
    this.store = store;
    this.github = github;
    this.reviewer = reviewer;
    this.#admitAction = actionAdmissionRun(actionAdmissionGate);
    this.clock = clock;
    const basePolicyVersion = Number.isSafeInteger(config.policyVersion)
      ? config.policyVersion
      : 1;
    this.config = {
      enabled: true,
      name: "PR 推进员工",
      policyVersion: 1,
      tickMinutes: 2,
      maxJobsPerTick: 2,
      maxAttempts: 3,
      retryMinutes: [1, 5, 30],
      memoryLimit: 1_000,
      memoryOutboxLimit: 100,
      jobLimit: 500,
      initialPaused: false,
      triageOnly: false,
      ...config,
      // Triage is a new responsibility contract. Advancing the effective
      // policy retires persisted Review drafts and pre-handoff triage jobs
      // instead of presenting either as actionable work after restart.
      policyVersion: config.triageOnly === true
        ? basePolicyVersion + 2
        : basePolicyVersion,
    };
    this.producerQueue = producerQueue;
    this.triageHandoff = triageHandoff;
    if (
      this.config.triageOnly === true &&
      (!this.triageHandoff || typeof this.triageHandoff.submit !== "function")
    ) {
      throw new TypeError("Triage-only PR employee requires a durable handoff port");
    }
    this.githubActions = { ...githubActions };
    if (
      this.githubActions.enabled === true &&
      (!this.producerQueue ||
        typeof this.producerQueue.enqueue !== "function" ||
        typeof this.producerQueue.get !== "function" ||
        typeof this.producerQueue.invalidate !== "function")
    ) {
      throw new TypeError(
        "Enabled GitHub actions require a confirmation queue",
      );
    }
    this.controller = new EmployeeController({
      definition: {
        id: "pr-reviewer",
        name: this.config.name,
        mission: this.config.triageOnly
          ? "主动发现相关 PR，完成基础筛选、优先级初判和岗位分流"
          : "主动巡查与你相关的 PR，生成评审草稿或推进方案",
        enabled: this.config.enabled,
      },
      store,
      stateKey: STATE_KEY,
      createState: () => ({
        ...defaultState(),
        paused: Boolean(this.config.initialPaused),
      }),
      normalizeState: normalizedState,
      resolveState: roleState,
      applyControl: (state) => ({
        ...state,
        lastError: "",
      }),
      projectRole: (state) => ({
        brain: {
          provider: this.reviewer?.provider || "",
          model: this.reviewer?.model || "",
          remoteCodeContext: Boolean(this.reviewer?.remoteCodeContext),
        },
        lastRun: state.lastRun,
        lastError:
          latestJobError(state.jobs) ||
          state.memoryOutboxError ||
          state.lastError,
      }),
      projectWork,
      operationQueue,
      run: ({ trigger = "scheduled", state, signal = null }) =>
        this.#performTick(trigger, state, signal),
    });
  }

  get id() {
    return this.controller.id;
  }

  get running() {
    return this.controller.running;
  }

  get scheduleMinutes() {
    return Number(this.config.tickMinutes) || 0;
  }

  run(options = {}) {
    return this.controller.run(options);
  }

  tick(options = {}) {
    return this.run(options);
  }

  control(command, expectedRevision) {
    return this.controller.control(command, expectedRevision);
  }

  decide(id, decision, options = {}) {
    return this.controller.enqueue(() => this.#decide(id, decision, options));
  }

  resolveBlockedJob(id, action, options = {}) {
    return this.controller.enqueue(() =>
      this.#resolveBlockedJob(id, action, options));
  }

  recoverConfirmations() {
    return this.controller.enqueue(() => this.#recoverConfirmations());
  }

  recordConfirmationOutcome(item) {
    return this.controller.enqueue(() => this.#recordConfirmationOutcome(item));
  }

  async view() {
    return this.controller.view();
  }

  async roleView() {
    return this.controller.roleView();
  }

  async searchMemory(query = "", limit = 30) {
    const [storedMemories, state] = await Promise.all([
      this.store.read(MEMORY_KEY, []),
      this.controller.readState(),
    ]);
    const memories = [
      ...(Array.isArray(state.memoryOutbox) ? state.memoryOutbox : []),
      ...(Array.isArray(storedMemories) ? storedMemories : []),
    ].filter(
      (memory, index, all) =>
        all.findIndex((candidate) => candidate.id === memory.id) === index,
    );
    const terms = String(query)
      .trim()
      .toLocaleLowerCase("zh-CN")
      .split(/\s+/)
      .filter(Boolean);
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
    return memories
      .filter((memory) => {
        const text = memoryText(memory);
        return terms.every((term) => text.includes(term));
      })
      .sort(
        (left, right) =>
          Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0),
      )
      .slice(0, cappedLimit);
  }

  #usesExternalConfirmations() {
    return this.githubActions.enabled === true;
  }

  async #recoverConfirmations() {
    let state = await this.controller.readState();
    if (!this.#usesExternalConfirmations()) {
      if (!this.producerQueue) return this.controller.project(state);
      const legacyIds = state.jobs
        .filter(
          (job) =>
            job.confirmationId &&
            [
              "confirmation_enqueue_pending",
              "confirmation_invalidation_pending",
              "waiting_confirmation",
              "waiting_retry_confirmation",
              "superseded",
            ].includes(job.status),
        )
        .map((job) => job.id);
      for (const id of legacyIds) {
        const invalidated = await this.#invalidateSupersededConfirmation(
          state,
          id,
          { failClosed: true },
        );
        state = invalidated.state;
      }
      return this.controller.project(state);
    }

    const recoverableIds = state.jobs
      .filter((job) =>
        [
          "ready_for_human",
          "confirmation_enqueue_pending",
          "confirmation_invalidation_pending",
          "waiting_confirmation",
          "waiting_retry_confirmation",
          "blocked",
          "superseded",
        ].includes(job.status),
      )
      .map((job) => job.id);
    for (const id of recoverableIds) {
      let index = state.jobs.findIndex((job) => job.id === id);
      if (index < 0) continue;
      let job = state.jobs[index];
      if (job.status === "ready_for_human") {
        try {
          const confirmationIntent = createPrReviewConfirmationPlan(job, {
            githubActions: this.githubActions,
          });
          job = {
            ...job,
            status: "confirmation_enqueue_pending",
            confirmationId: confirmationIntent.id,
            confirmationIntent,
            updatedAt: this.clock().toISOString(),
          };
        } catch {
          job = {
            ...job,
            status: "blocked",
            error: "PR Review 确认计划无效",
            updatedAt: this.clock().toISOString(),
          };
        }
        state.jobs[index] = job;
        state = await this.controller.writeState(state);
      }

      index = state.jobs.findIndex((candidate) => candidate.id === id);
      job = state.jobs[index];
      if (
        ["superseded", "confirmation_invalidation_pending"].includes(
          job.status,
        ) &&
        job.confirmationId
      ) {
        const invalidated = await this.#invalidateSupersededConfirmation(
          state,
          job.id,
          { failClosed: true },
        );
        state = invalidated.state;
        continue;
      }
      if (job.status === "confirmation_enqueue_pending") {
        state = await this.#enqueuePendingConfirmation(state, id, {
          failClosed: true,
        });
        continue;
      }
      if (job.confirmationId) {
        try {
          const item = await this.producerQueue.get(job.confirmationId);
          state = await this.#applyConfirmationOutcome(state, item);
        } catch {
          const failedAt = this.clock().toISOString();
          state.jobs[index] = {
            ...job,
            error: "无法恢复外部动作确认状态",
            updatedAt: failedAt,
          };
          state.lastError = `#${job.number}: ${state.jobs[index].error}`;
          state = await this.controller.writeState(state);
        }
      }
    }
    state = await this.#reconcileRecoveredJobs(state);
    return this.controller.project(state);
  }

  async #recordConfirmationOutcome(item) {
    let state = await this.controller.readState();
    state = await this.#applyConfirmationOutcome(state, item);
    return this.controller.project(state);
  }

  async #enqueuePendingConfirmation(
    state,
    id,
    { failClosed = false } = {},
  ) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const job = state.jobs[index];
    if (
      job.status !== "confirmation_enqueue_pending" ||
      !job.confirmationIntent
    ) {
      return state;
    }
    const snapshot = await this.store.read("snapshot", null);
    if (
      !Array.isArray(snapshot?.items) ||
      snapshot.sourceStatus?.githubPullRequests?.ok !== true
    ) {
      const updatedAt = this.clock().toISOString();
      state.jobs[index] = {
        ...job,
        error: "GitHub PR 事实尚未健康刷新，确认不会进入队列",
        updatedAt,
      };
      state.lastError = `#${job.number}: ${state.jobs[index].error}`;
      return this.controller.writeState(state, { bumpRevision: false });
    }
    const current = snapshot.items.find((item) => item.id === job.subjectId);
    if (!jobMatchesCurrentCandidate(job, current, this.config.policyVersion)) {
      const invalidated = await this.#invalidateSupersededConfirmation(
        state,
        id,
        { failClosed },
      );
      return invalidated.state;
    }
    try {
      const item = await this.producerQueue.enqueue(job.confirmationIntent);
      return this.#applyConfirmationOutcome(state, item);
    } catch {
      const updatedAt = this.clock().toISOString();
      state.jobs[index] = {
        ...job,
        error: "外部动作确认队列暂不可用，将在下次巡查时重试",
        updatedAt,
      };
      state.lastError = `#${job.number}: ${state.jobs[index].error}`;
      return this.controller.writeState(state);
    }
  }

  #producerInvalidation(job) {
    let intentBindingDigest = "";
    if (job.confirmationIntent) {
      try {
        intentBindingDigest = normalizeConfirmationPlan(
          job.confirmationIntent,
        ).approvalBindingDigest;
      } catch {
        return null;
      }
    }
    const approvalBindingDigest =
      job.confirmationBindingDigest ||
      intentBindingDigest;
    if (!job.confirmationId || !approvalBindingDigest) return null;
    return {
      requestedBy: { roleId: this.id, workItemId: job.id },
      approvalBindingDigest,
      reason: "work_item_superseded",
    };
  }

  async #prepareConfirmationInvalidation(state, id) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return { state, intent: null };
    const job = state.jobs[index];
    const intent = this.#producerInvalidation(job);
    if (!intent) return { state, intent: null };
    if (
      job.confirmationInvalidationIntent &&
      !sameJsonValue(job.confirmationInvalidationIntent, intent)
    ) {
      throw serviceError(409, "PR 作业失效意图与原确认绑定不一致");
    }
    const status =
      job.status === "superseded"
        ? "superseded"
        : "confirmation_invalidation_pending";
    if (
      job.status === status &&
      sameJsonValue(job.confirmationInvalidationIntent, intent)
    ) {
      return { state, intent };
    }
    const updatedAt = this.clock().toISOString();
    state.jobs[index] = {
      ...job,
      status,
      confirmationInvalidationIntent: intent,
      error: "旧外部动作确认正在安全失效",
      updatedAt,
    };
    state.lastError = `#${job.number}: ${state.jobs[index].error}`;
    state = await this.controller.writeState(state);
    return { state, intent };
  }

  async #completeMissingConfirmationInvalidation(state, id) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const completedAt = this.clock().toISOString();
    state.jobs[index] = {
      ...state.jobs[index],
      status: "superseded",
      confirmationInvalidationIntent: null,
      error: "",
      updatedAt: completedAt,
      completedAt,
    };
    state.lastError = "";
    return this.controller.writeState(state);
  }

  async #recordInvalidationFailure(state, id) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const job = state.jobs[index];
    const updatedAt = this.clock().toISOString();
    state.jobs[index] = {
      ...job,
      error: "无法安全失效旧的外部动作确认",
      updatedAt,
    };
    state.lastError = `#${job.number}: ${state.jobs[index].error}`;
    return this.controller.writeState(state, { bumpRevision: false });
  }

  async #reconcileRecoveredJobs(state) {
    const snapshot = await this.store.read("snapshot", null);
    if (snapshot?.sourceStatus?.githubPullRequests?.ok !== true) return state;
    const currentBySubject = new Map(
      snapshot.items.filter((item) => this.#isCandidate(item)).map((item) => [item.id, item]),
    );
    const ids = state.jobs
      .filter((job) => ACTIVE_JOB_STATES.has(job.status))
      .map((job) => job.id);
    for (const id of ids) {
      const job = state.jobs.find((candidate) => candidate.id === id);
      const current = currentBySubject.get(job.subjectId);
      if (jobMatchesCurrentCandidate(job, current, this.config.policyVersion)) {
        continue;
      }
      if (job.confirmationId) {
        const invalidated = await this.#invalidateSupersededConfirmation(
          state,
          id,
          { failClosed: true },
        );
        state = invalidated.state;
        continue;
      }
      const index = state.jobs.findIndex((candidate) => candidate.id === id);
      const completedAt = this.clock().toISOString();
      state.jobs[index] = {
        ...job,
        status: "superseded",
        updatedAt: completedAt,
        completedAt,
      };
      state = await this.controller.writeState(state);
    }
    return state;
  }

  async #invalidateSupersededConfirmation(
    state,
    id,
    { failClosed = false } = {},
  ) {
    let prepared;
    try {
      prepared = await this.#prepareConfirmationInvalidation(state, id);
    } catch (error) {
      const job = state.jobs.find((candidate) => candidate.id === id);
      const emergencyVeto = job ? this.#producerInvalidation(job) : null;
      if (job && emergencyVeto) {
        try {
          await this.producerQueue.invalidate(job.confirmationId, emergencyVeto);
        } catch {
          // The queue installs its in-process veto before its durable write.
        }
      }
      throw error;
    }
    state = prepared.state;
    const job = state.jobs.find((candidate) => candidate.id === id);
    const invalidation = prepared.intent;
    if (!job || !invalidation) return { state, safe: true };

    try {
      const item = await this.producerQueue.invalidate(
        job.confirmationId,
        invalidation,
      );
      state = await this.#applyConfirmationOutcome(state, item);
      return { state, safe: item.status === "stale" };
    } catch (error) {
      if (error?.statusCode === 404 && !job.confirmationBindingDigest) {
        state = await this.#completeMissingConfirmationInvalidation(state, id);
        return { state, safe: true };
      }
      try {
        const item = await this.producerQueue.get(job.confirmationId);
        if (
          ["completed", "rejected", "stale"].includes(item.status) ||
          (item.status === "failed" && !item.retryable)
        ) {
          state = await this.#applyConfirmationOutcome(state, item);
          return { state, safe: item.status === "stale" };
        }
      } catch {
        // The durable invalidation intent and queue veto remain authoritative.
      }
      state = await this.#recordInvalidationFailure(state, id);
      if (failClosed) {
        throw serviceError(
          503,
          "旧外部动作确认尚未安全失效，拒绝启动服务",
        );
      }
      return { state, safe: false };
    }
  }

  async #applyConfirmationOutcome(state, item) {
    const workItemId = item?.requestedBy?.workItemId;
    if (
      item?.requestedBy?.roleId !== "pr-reviewer" ||
      typeof workItemId !== "string"
    ) {
      throw serviceError(400, "确认项不属于 PR 推进员工");
    }
    const index = state.jobs.findIndex((job) => job.id === workItemId);
    if (index < 0) throw serviceError(404, "找不到确认项对应的 PR 作业");
    const job = state.jobs[index];
    if (job.confirmationId && job.confirmationId !== item.id) {
      throw serviceError(409, "PR 作业已绑定其他确认项");
    }
    if (
      job.confirmationBindingDigest &&
      job.confirmationBindingDigest !== item.approvalBindingDigest
    ) {
      throw serviceError(409, "PR 作业确认内容已变化");
    }
    const terminalStatus = {
      superseded: "stale",
      published: "completed",
      rejected: "rejected",
    }[job.status];
    if (terminalStatus && item.status !== terminalStatus) {
      throw serviceError(409, "终态 PR 作业不能被其他确认结果覆盖");
    }

    const projection = {
      pending: "waiting_confirmation",
      executing: "waiting_confirmation",
      completed: "published",
      rejected: "rejected",
      stale: "superseded",
      failed: item.retryable ? "waiting_retry_confirmation" : "blocked",
    }[item.status];
    if (!projection) throw serviceError(400, "确认项状态无效");

    const updatedAt = this.clock().toISOString();
    const terminal = new Set([
      "published",
      "rejected",
      "superseded",
      "blocked",
    ]).has(projection);
    const previousStatus = job.status;
    if (
      previousStatus === projection &&
      job.confirmationId === item.id &&
      job.confirmationBindingDigest === item.approvalBindingDigest &&
      job.confirmationIntent === null &&
      job.confirmationInvalidationIntent === null &&
      job.confirmationStatus === item.status &&
      sameJsonValue(job.confirmationReceipt, item.receipt) &&
      sameJsonValue(job.confirmationFailure, item.failure) &&
      sameJsonValue(job.confirmationRejection, item.rejection) &&
      sameJsonValue(job.confirmationInvalidation, item.invalidation)
    ) {
      return state;
    }
    const updated = {
      ...job,
      status: projection,
      confirmationId: item.id,
      confirmationBindingDigest: item.approvalBindingDigest,
      confirmationIntent: null,
      confirmationInvalidationIntent: null,
      confirmationStatus: item.status,
      confirmationReceipt: item.receipt || null,
      confirmationFailure: item.failure || null,
      confirmationRejection: item.rejection || null,
      confirmationInvalidation: item.invalidation || null,
      error:
        projection === "blocked"
          ? `外部动作结果无法确认：${item.failure?.code || "UNKNOWN"}`
          : "",
      updatedAt,
      ...(terminal ? { completedAt: updatedAt } : {}),
      ...(projection === "published" ? { decision: "published" } : {}),
      ...(projection === "rejected" ? { decision: "reject" } : {}),
    };
    state.jobs[index] = updated;
    state.lastError = projection === "blocked" ? `#${job.number}: ${updated.error}` : "";
    if (terminal && previousStatus !== projection) {
      const event = {
        published: "review_published",
        rejected: "review_rejected",
        superseded: "review_stale",
        blocked: "review_outcome_unknown",
      }[projection];
      state = this.#queueMemory(state, updated, event);
    }
    state = await this.controller.writeState(state);
    return this.#flushMemoryOutbox(state);
  }

  async #decide(id, decision, { headRefOid, expectedRevision } = {}) {
    if (typeof id !== "string" || !id.trim()) {
      throw serviceError(400, "作业 id 不能为空");
    }
    if (!DECISIONS.has(decision)) {
      throw serviceError(400, "decision 只能是 accept 或 reject");
    }
    let state = await this.controller.readState();
    this.controller.assertRevision(state, expectedRevision);
    const index = state.jobs.findIndex((job) => job.id === id.trim());
    if (index < 0) throw serviceError(404, "找不到这条 PR 员工作业");
    const job = state.jobs[index];
    if (job.status !== "ready_for_human") {
      throw serviceError(409, "该评审草稿已不在待确认状态");
    }
    if (job.headRefOid !== headRefOid) {
      throw serviceError(409, "PR head 已变化，请查看最新草稿");
    }
    const snapshot = await this.store.read("snapshot");
    const current = snapshot?.items?.find((item) => item.id === job.subjectId);
    if (
      !current ||
      current.headRefOid !== job.headRefOid ||
      !sameJobGitTarget(job, current) ||
      !this.#isCandidate(current)
    ) {
      state.jobs[index] = {
        ...job,
        status: "superseded",
        completedAt: this.clock().toISOString(),
      };
      await this.controller.writeState(state);
      throw serviceError(409, "PR 状态或 head 已变化，旧草稿已失效");
    }

    const decidedAt = this.clock().toISOString();
    const decidedJob = {
      ...job,
      status: decision === "accept" ? "accepted" : "rejected",
      decision,
      decidedAt,
      updatedAt: decidedAt,
      completedAt: decidedAt,
    };
    state.jobs[index] = decidedJob;
    state.lastError = "";
    state = this.#queueMemory(state, decidedJob, `draft_${decision}`);
    state = await this.controller.writeState(state);
    state = await this.#flushMemoryOutbox(state);
    return this.controller.project(state);
  }

  async #resolveBlockedJob(
    id,
    action,
    { headRefOid, expectedRevision } = {},
  ) {
    if (typeof id !== "string" || !id.trim()) {
      throw serviceError(400, "作业 id 不能为空");
    }
    if (!BLOCKED_JOB_ACTIONS.has(action)) {
      throw serviceError(400, "blocked job action 只能是 retry 或 dismiss");
    }
    let state = await this.controller.readState();
    this.controller.assertRevision(state, expectedRevision);
    const index = state.jobs.findIndex((job) => job.id === id.trim());
    if (index < 0) throw serviceError(404, "找不到这条 PR 员工作业");
    const job = state.jobs[index];
    if (!isAnalysisBlocked(job)) {
      throw serviceError(409, "该作业不是可恢复的分析失败");
    }
    if (job.headRefOid !== headRefOid) {
      throw serviceError(409, "PR head 已变化，请查看最新作业");
    }

    const snapshot = await this.store.read("snapshot", null);
    if (snapshot?.sourceStatus?.githubPullRequests?.ok !== true) {
      throw serviceError(
        503,
        "GitHub PR 事实尚未健康刷新，失败作业保持不变",
      );
    }
    const current = snapshot?.items?.find(
      (item) => item.id === job.subjectId,
    );
    if (
      !this.#isCandidate(current) ||
      !jobMatchesCurrentCandidate(job, current, this.config.policyVersion)
    ) {
      const completedAt = this.clock().toISOString();
      state.jobs[index] = {
        ...job,
        status: "superseded",
        updatedAt: completedAt,
        completedAt,
      };
      state.lastError = "";
      await this.controller.writeState(state);
      throw serviceError(409, "PR 状态或 head 已变化，旧失败作业已失效");
    }

    const updatedAt = this.clock().toISOString();
    if (action === "retry") {
      state.jobs[index] = {
        ...job,
        status: "queued",
        attempts: 0,
        ...(job.analysisAttemptBudget ? {
          analysisAttemptBudget: { ...job.analysisAttemptBudget, attemptOffset: 0 },
        } : {}),
        error: "",
        startedAt: null,
        leaseUntil: null,
        nextAttemptAt: null,
        retryRequestedAt: updatedAt,
        updatedAt,
      };
      state.lastError = "";
      state = this.#queueMemory(
        state,
        state.jobs[index],
        "analysis_retry_requested",
      );
    } else {
      state.jobs[index] = {
        ...job,
        status: "dismissed",
        decision: "dismiss",
        error: "",
        leaseUntil: null,
        nextAttemptAt: null,
        updatedAt,
        completedAt: updatedAt,
      };
      state.lastError = "";
      state = this.#queueMemory(
        state,
        state.jobs[index],
        "analysis_dismissed",
      );
    }
    state = await this.controller.writeState(state);
    state = await this.#flushMemoryOutbox(state);
    return this.controller.project(state);
  }

  async #performTick(trigger, state, signal = null) {
    signal?.throwIfAborted();
    state = await this.#flushMemoryOutbox(state);
    signal?.throwIfAborted();
    if (this.#usesExternalConfirmations()) {
      const invalidationIds = state.jobs
        .filter(
          (job) => job.status === "confirmation_invalidation_pending",
        )
        .map((job) => job.id);
      for (const id of invalidationIds) {
        signal?.throwIfAborted();
        const invalidated = await this.#invalidateSupersededConfirmation(
          state,
          id,
        );
        state = invalidated.state;
        signal?.throwIfAborted();
      }
      const pendingIds = state.jobs
        .filter((job) => job.status === "confirmation_enqueue_pending")
        .map((job) => job.id);
      for (const id of pendingIds) {
        signal?.throwIfAborted();
        state = await this.#enqueuePendingConfirmation(state, id);
        signal?.throwIfAborted();
      }
      const linkedIds = state.jobs
        .filter((job) =>
          ["waiting_confirmation", "waiting_retry_confirmation"].includes(
            job.status,
          ),
        )
        .map((job) => job.id);
      for (const id of linkedIds) {
        signal?.throwIfAborted();
        const job = state.jobs.find((candidate) => candidate.id === id);
        try {
          const item = await this.producerQueue.get(job.confirmationId);
          signal?.throwIfAborted();
          state = await this.#applyConfirmationOutcome(state, item);
        } catch {
          signal?.throwIfAborted();
          state.lastError = `#${job.number}: 暂时无法同步外部动作确认状态`;
          state = await this.controller.writeState(state, {
            bumpRevision: false,
          });
        }
      }
    }

    const runAt = this.clock().toISOString();
    const [snapshot, memories] = await Promise.all([
      this.store.read("snapshot"),
      this.store.read(MEMORY_KEY, []),
    ]);
    signal?.throwIfAborted();
    if (!snapshot?.items) {
      state.lastRun = {
        trigger,
        at: runAt,
        newJobs: 0,
        summary: "尚无事实快照，等待数据源完成首次刷新",
      };
      state = await this.controller.writeState(state, { bumpRevision: false });
      signal?.throwIfAborted();
      return state;
    }
    if (snapshot.sourceStatus?.githubPullRequests?.ok !== true) {
      state.lastRun = {
        trigger,
        at: runAt,
        newJobs: 0,
        summary: "GitHub PR 本轮未刷新，未使用旧数据触发员工",
      };
      state = await this.controller.writeState(state, { bumpRevision: false });
      signal?.throwIfAborted();
      return state;
    }

    const candidates = snapshot.items.filter((item) => this.#isCandidate(item));
    const currentBySubject = new Map(candidates.map((item) => [item.id, item]));
    let jobsChanged = false;
    const unresolvedSubjects = new Set(
      state.jobs
        .filter(
          (job) =>
            job.status === "confirmation_invalidation_pending" ||
            (job.status === "blocked" &&
              job.confirmationFailure?.outcome === "unknown"),
        )
        .map((job) => job.subjectId),
    );
    const activeIds = state.jobs
      .filter(
        (job) =>
          ACTIVE_JOB_STATES.has(job.status) || isAnalysisBlocked(job),
      )
      .map((job) => job.id);
    for (const id of activeIds) {
      signal?.throwIfAborted();
      let job = state.jobs.find((candidate) => candidate.id === id);
      if (job.status === "confirmation_invalidation_pending") {
        unresolvedSubjects.add(job.subjectId);
        continue;
      }
      const current = currentBySubject.get(job.subjectId);
      if (jobMatchesCurrentCandidate(job, current, this.config.policyVersion)) {
        continue;
      }
      if (this.#usesExternalConfirmations() && job.confirmationId) {
        const invalidated = await this.#invalidateSupersededConfirmation(
          state,
          job.id,
        );
        signal?.throwIfAborted();
        state = invalidated.state;
        job = state.jobs.find((candidate) => candidate.id === id);
        if (!invalidated.safe) unresolvedSubjects.add(job.subjectId);
        if (job.status === "superseded" || !invalidated.safe) continue;
      }
      jobsChanged = true;
      const index = state.jobs.findIndex((candidate) => candidate.id === id);
      state.jobs[index] = {
        ...job,
        status: "superseded",
        completedAt: runAt,
        updatedAt: runAt,
      };
    }

    if (jobsChanged) {
      state = await this.controller.writeState(state);
      signal?.throwIfAborted();
    }

    const requestedBrain = brainIdentity(this.reviewer);
    const recoveredJobs = state.jobs.map((job) => {
      const current = currentBySubject.get(job.subjectId);
      if (!jobMatchesCurrentCandidate(job, current, this.config.policyVersion) ||
          job.repo !== current.repo || job.number !== current.number ||
          job.fingerprint !== jobFingerprint(current, this.config.policyVersion)) return job;
      return recoverForChangedAnalysisModel(job, requestedBrain, runAt) ?? recoverInfrastructureAnalysis(job, requestedBrain, runAt) ?? job;
    });
    if (recoveredJobs.some((job, index) => job !== state.jobs[index])) {
      state = await runAdmittedOperation(this.#admitAction,
        () => this.controller.writeState({ ...state, jobs: recoveredJobs }));
      signal?.throwIfAborted();
    }

    const fingerprints = new Set(
      [
        ...state.jobs,
        ...(Array.isArray(memories) ? memories : []),
        ...state.memoryOutbox,
      ]
        .map((entry) => entry.fingerprint)
        .filter(Boolean),
    );
    const newJobs = candidates
      .map((item) => ({
        item,
        fingerprint: jobFingerprint(item, this.config.policyVersion),
      }))
      .filter(({ item }) => !unresolvedSubjects.has(item.id))
      .filter(({ fingerprint }) => !fingerprints.has(fingerprint))
      .map(({ item, fingerprint }) => this.#newJob(item, fingerprint, runAt));
    if (newJobs.length) {
      const admittedState = {
        ...state,
        jobs: trimJobs([...state.jobs, ...newJobs], this.config.jobLimit),
      };
      state = await runAdmittedOperation(
        this.#admitAction,
        () => this.controller.writeState(admittedState),
      );
      signal?.throwIfAborted();
    }
    const jobsBeforeTrim = state.jobs.length;
    if (!newJobs.length) {
      state = {
        ...state,
        jobs: trimJobs(state.jobs, this.config.jobLimit),
      };
    }
    const jobsTrimmed = state.jobs.length !== jobsBeforeTrim;
    state.lastRun = {
      trigger,
      at: runAt,
      newJobs: newJobs.length,
      observed: candidates.length,
      summary: candidates.length
        ? `巡查 ${candidates.length} 条需行动 PR，新建 ${newJobs.length} 个作业`
        : "已主动巡查，没有发现需要启动的新 PR 作业",
    };
    if (
      !state.jobs.some(
        (job) => job.status === "confirmation_invalidation_pending",
      )
    ) {
      state.lastError = "";
    }
    state = await this.controller.writeState(state, {
      bumpRevision: jobsTrimmed,
    });
    signal?.throwIfAborted();

    const readyToRun = state.jobs
      .filter((job) => this.#canRun(job, runAt))
      .slice(0, Math.max(1, this.config.maxJobsPerTick));
    for (const job of readyToRun) {
      signal?.throwIfAborted();
      state = await this.#runJob(state, job.id, signal);
    }
    signal?.throwIfAborted();
    return state;
  }

  #newJob(item, fingerprint, createdAt) {
    return {
      id: jobId(fingerprint),
      fingerprint,
      policyVersion: this.config.policyVersion,
      subjectId: item.id,
      repo: item.repo,
      number: item.number,
      title: item.title,
      url: item.url,
      relation: item.relation,
      headRefOid: item.headRefOid,
      gitTargetDigest: itemGitTargetDigest(item),
      nextAction: item.nextAction,
      triggerReason: item.actionReasons?.[0] || "PR 状态需要你采取行动",
      status: "queued",
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
  }

  #canRun(job, now) {
    if (job.status === "queued") return true;
    if (job.status === "running") {
      return Date.parse(job.leaseUntil || 0) <= Date.parse(now);
    }
    if (job.status === "retry_wait") {
      return Date.parse(job.nextAttemptAt || 0) <= Date.parse(now);
    }
    return false;
  }

  async #runJob(state, id, signal = null) {
    signal?.throwIfAborted();
    let index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const startedAt = this.clock().toISOString();
    const requestedBrain = brainIdentity(this.reviewer);
    const budget = requestedBrain ? analysisAttemptBudget(state.jobs[index], requestedBrain) : null;
    const claimed = {
      ...state.jobs[index],
      status: "running",
      attempts: (state.jobs[index].attempts || 0) + 1,
      startedAt,
      updatedAt: startedAt,
      leaseUntil: new Date(Date.parse(startedAt) + 120_000).toISOString(),
      error: "",
      analysisFailure: null,
      brain: {
        provider: this.reviewer?.provider || "",
        model: this.reviewer?.model || "",
      },
      ...(budget ? { analysisAttemptBudget: budget } : {}),
    };
    const claimedState = {
      ...state,
      jobs: state.jobs.map((job, jobIndex) =>
        jobIndex === index ? claimed : job,
      ),
    };
    state = await runAdmittedOperation(
      this.#admitAction,
      () => this.controller.writeState(claimedState),
    );
    signal?.throwIfAborted();

    let attemptBrain = claimed.brain;
    let failurePhase = "context";
    try {
      if (!this.reviewer) throw new Error("岗位大脑未配置");
      const snapshot = await this.store.read("snapshot");
      signal?.throwIfAborted();
      const item = snapshot?.items?.find(
        (candidate) =>
          candidate.id === claimed.subjectId &&
          candidate.headRefOid === claimed.headRefOid &&
          sameJobGitTarget(claimed, candidate) &&
          candidate.nextAction === claimed.nextAction &&
          candidate.relation === claimed.relation,
      );
      if (!item || !this.#isCandidate(item)) {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      const policy = effectiveWorkPolicy(item, this.config.triageOnly);
      const context = await this.github.loadReviewContext(item, {
        includePatch: policy.mode === "review",
        ...(signal === null ? {} : { signal }),
      });
      signal?.throwIfAborted();
      if (
        context.headRefOid !== claimed.headRefOid ||
        !sameJobGitTarget(claimed, context)
      ) {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      const { analysis, brain: actualBrain } = await runAdmittedOperation(
        this.#admitAction,
        async () => {
          const input = {
            ...context,
            workMode: policy.mode,
            requestedAction: item.nextAction,
          };
          const options = signal === null ? undefined : { signal };
          failurePhase = "analysis";
          return typeof this.reviewer.analyzeWithReceipt === "function"
            ? this.reviewer.analyzeWithReceipt(input, options)
            : { analysis: await this.reviewer.analyze(input, options), brain: claimed.brain };
        },
      );
      attemptBrain = actualBrain;
      failurePhase = "post_analysis";
      signal?.throwIfAborted();
      const latest = await this.store.read("snapshot");
      signal?.throwIfAborted();
      const current = latest?.items?.find(
        (candidate) => candidate.id === claimed.subjectId,
      );
      if (
        !current ||
        current.headRefOid !== claimed.headRefOid ||
        !sameJobGitTarget(claimed, current) ||
        current.nextAction !== claimed.nextAction ||
        current.relation !== claimed.relation ||
        !this.#isCandidate(current)
      ) {
        return this.#finishAsSuperseded(state, claimed.id);
      }

      index = state.jobs.findIndex((job) => job.id === claimed.id);
      const completedAt = this.clock().toISOString();
      failurePhase = "handoff";
      // Analysis may outlive a publication or QA handoff while the dashboard
      // snapshot still has the same Head. Re-read live scope before creating work.
      if (policy.targetRoleId === "pr-engineer" && !await this.#stillNeedsReviewTriage(current, signal)) {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      const handoff = policy.targetRoleId
        ? await this.triageHandoff.submit({
            requestKey: claimed.id,
            targetRoleId: policy.targetRoleId,
            repository: item.repo,
            number: item.number,
            nextAction: item.nextAction,
            expectedHeadRefOid: claimed.headRefOid,
            ...(policy.targetRoleId === "pr-engineer" && current.gitTarget ? { gitTarget: current.gitTarget } : {}),
          })
        : null;
      if (
        handoff !== null &&
        (typeof handoff !== "object" ||
          typeof handoff.workItemId !== "string" ||
          handoff.workItemId.length < 1)
      ) {
        throw new Error("PR triage handoff did not return a durable work item");
      }
      const completed = {
        ...state.jobs[index],
        workType: policy.workType,
        summary: analysis.summary,
        confidence: analysis.confidence,
        evidence: analysis.evidence,
        steps: analysis.steps,
        questions: analysis.questions,
        reviewVerdict:
          policy.mode === "review" ? analysis.reviewVerdict : "none",
        reviewBody: policy.mode === "review" ? analysis.reviewBody : "",
        requiresApproval: policy.requiresApproval,
        ...(policy.targetRoleId ? { targetRoleId: policy.targetRoleId } : {}),
        ...(handoff ? { handoffWorkItemId: handoff.workItemId } : {}),
        status: policy.requiresApproval ? "ready_for_human" : "ready",
        brain: { ...actualBrain },
        updatedAt: completedAt,
        completedAt,
        leaseUntil: null,
      };
      if (policy.requiresApproval && this.#usesExternalConfirmations()) {
        const confirmationIntent = createPrReviewConfirmationPlan(completed, {
          githubActions: this.githubActions,
        });
        state.jobs[index] = {
          ...completed,
          status: "confirmation_enqueue_pending",
          confirmationId: confirmationIntent.id,
          confirmationIntent,
        };
      } else {
        state.jobs[index] = completed;
      }
      failurePhase = "persistence";
      state.lastError = "";
      state = this.#queueMemory(state, state.jobs[index], "analysis_ready");
      signal?.throwIfAborted();
      state = await this.controller.writeState(state);
      signal?.throwIfAborted();
      state = await this.#flushMemoryOutbox(state);
      signal?.throwIfAborted();
      if (state.jobs[index].status === "confirmation_enqueue_pending") {
        return this.#enqueuePendingConfirmation(state, claimed.id);
      }
      return state;
    } catch (error) {
      signal?.throwIfAborted();
      if (stableFailureCode(error) === "PR_CONTEXT_STALE") {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      if (RUNTIME_ADMISSION_FAILURES.has(stableFailureCode(error))) {
        throw error;
      }
      try {
        state = await this.controller.readState();
      } catch {
        throw error;
      }
      index = state.jobs.findIndex((job) => job.id === claimed.id);
      if (index < 0 || !isSameRunningClaim(state.jobs[index], claimed)) {
        return state;
      }
      const failedAt = this.clock().toISOString();
      const attempts = state.jobs[index].attempts || 1;
      const failureReceipt = failurePhase === "analysis" && typeof this.reviewer?.getFailureReceipt === "function"
        ? this.reviewer.getFailureReceipt(error) : null;
      const failureBrain = failureReceipt?.brain ?? attemptBrain;
      const legacyTransportFailure = failureBrain?.provider === "ollama" &&
        error?.code === undefined && error?.message === "Ollama employee transport request failed";
      const infrastructureFailure = failurePhase === "analysis" && (failureReceipt?.infrastructureFailure === true ||
        (failureReceipt === null && legacyTransportFailure));
      const nextBudget = infrastructureFailure && budget ? { ...budget, attemptOffset: budget.attemptOffset + 1 } : budget;
      const modelAttempts = attempts - (nextBudget?.attemptOffset ?? 0);
      const blocked = !infrastructureFailure && modelAttempts >= this.config.maxAttempts;
      const retryIndex = infrastructureFailure && ["STRUCTURED_PROVIDER_BUSY", "STRUCTURED_PROVIDER_QUEUE_TIMEOUT"].includes(error?.code)
        ? 0 : Math.min((infrastructureFailure ? attempts : modelAttempts) - 1, this.config.retryMinutes.length - 1);
      const retryMinutes = this.config.retryMinutes[retryIndex] || 1;
      state.jobs[index] = {
        ...state.jobs[index],
        status: blocked ? "blocked" : "retry_wait",
        brain: { ...failureBrain },
        analysisFailure: { phase: failurePhase, code: stableFailureCode(error),
          modelFailure: failurePhase === "analysis" && (failureReceipt?.modelFailure ?? false),
          ...(infrastructureFailure ? { infrastructureFailure: true } : {}) },
        ...(nextBudget ? { analysisAttemptBudget: nextBudget } : {}),
        error: error.message || String(error),
        updatedAt: failedAt,
        leaseUntil: null,
        nextAttemptAt: blocked
          ? null
          : new Date(Date.parse(failedAt) + retryMinutes * 60_000).toISOString(),
      };
      state.lastError = `#${state.jobs[index].number}: ${state.jobs[index].error}`;
      if (blocked) {
        state = this.#queueMemory(
          state,
          state.jobs[index],
          "analysis_blocked",
        );
      }
      state = await this.controller.writeState(state);
      return this.#flushMemoryOutbox(state);
    }
  }

  async #finishAsSuperseded(state, id) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const completedAt = this.clock().toISOString();
    state.jobs[index] = {
      ...state.jobs[index],
      status: "superseded",
      completedAt,
      updatedAt: completedAt,
      leaseUntil: null,
    };
    return this.controller.writeState(state);
  }

  #queueMemory(state, job, event) {
    const createdAt = this.clock().toISOString();
    const id = `${job.id}:${event}`;
    const memory = {
      id,
      event,
      fingerprint: job.fingerprint,
      roleId: "pr-reviewer",
      sourceId: job.subjectId,
      sourceUrl: job.url,
      repository: job.repo,
      number: job.number,
      headRefOid: job.headRefOid,
      title: job.title,
      summary: job.summary || job.triggerReason || job.error || "",
      evidence: job.evidence || [],
      steps: job.steps || [],
      reviewBody: job.reviewBody || "",
      decision: job.decision || "",
      brain: job.brain || null,
      createdAt,
    };
    const pending = [
      ...state.memoryOutbox.filter((candidate) => candidate.id !== id),
      memory,
    ];
    const outboxLimit = Math.max(
      1,
      Number(this.config.memoryOutboxLimit) || 100,
    );
    const dropped = Math.max(0, pending.length - outboxLimit);
    return {
      ...state,
      memoryOutbox: pending.slice(-outboxLimit),
      memoryOutboxDropped: (state.memoryOutboxDropped || 0) + dropped,
    };
  }

  async #flushMemoryOutbox(state) {
    if (!state.memoryOutbox.length) return state;
    try {
      const memories = await this.store.read(MEMORY_KEY, []);
      const pendingIds = new Set(
        state.memoryOutbox.map((memory) => memory.id),
      );
      const next = [
        ...state.memoryOutbox,
        ...(Array.isArray(memories)
          ? memories.filter((memory) => !pendingIds.has(memory.id))
          : []),
      ]
        .sort(
          (left, right) =>
            Date.parse(right.createdAt || 0) -
            Date.parse(left.createdAt || 0),
        )
        .slice(0, Math.max(1, this.config.memoryLimit));
      await this.store.write(MEMORY_KEY, next);
      return this.controller.writeState(
        { ...state, memoryOutbox: [], memoryOutboxError: "" },
        { bumpRevision: false },
      );
    } catch (error) {
      const failed = {
        ...state,
        memoryOutboxError: `记忆队列写入失败：${error.message || error}`,
      };
      try {
        return await this.controller.writeState(failed, {
          bumpRevision: false,
        });
      } catch {
        return failed;
      }
    }
  }
}
