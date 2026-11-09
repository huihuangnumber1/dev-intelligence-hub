import {
  codeJobIdForGrant,
  normalizeCodeJobGrant,
} from "../domain/code-job-contract.js";
import {
  isActiveCodeJobBrowserStatus,
} from "../domain/code-job-browser-projection.js";
import { normalizeConfirmationPlan } from "../domain/confirmation-contract.js";
import {
  codeJobConfirmationIdForProposal,
  createCodeActionProposalConfirmationPlan,
} from "../domain/code-action-proposal-confirmation.js";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  cloneWorkProposalValue,
  isTerminalWorkProposalStatus,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { normalizeCodeJobConfirmationResult } from "./code-job-confirmation-result.js";
import { WorkProposalRunnerService } from "./work-proposal-runner.js";

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const VERIFICATION_FAILURE_SUMMARIES = Object.freeze({
  CODE_JOB_VERIFICATION_FAILED: "本地验证未通过；请查看测试记录，尚不能认定为产品代码缺陷",
  CODE_JOB_VERIFICATION_TIMEOUT: "本地验证超时；请检查测试耗时和执行环境",
  CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE: "本地验证环境不可用；请检查执行器及依赖",
  CODE_JOB_VERIFICATION_UNKNOWN: "本地验证结果无法判断；请查看执行记录",
});
const CONFIRMATION_STATUSES = new Set([
  "pending",
  "executing",
  "completed",
  "failed",
  "stale",
  "rejected",
]);
const INVALIDATION_REASONS = new Set([
  "work_item_superseded",
  "authorization_changed",
]);
const AUTHORIZATION_ERROR_CODES = new Set([
  "INVALID_CODE_JOB_AUTHORITY",
  "WORK_INTENT_POLICY_DENIED",
]);
const ACTIVE_PROPOSAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter(
    (status) => !isTerminalWorkProposalStatus(status),
  ),
);
const REQUIRED_CONFIRMATION_KEYS = Object.freeze([
  "id",
  "kind",
  "status",
  "queueRevision",
  "itemRevision",
  "requestedBy",
  "actor",
  "target",
  "display",
  "displayedPayloadDigest",
  "approvalBindingDigest",
  "retryable",
]);
const OPTIONAL_CONFIRMATION_KEYS = new Set([
  "receipt",
  "failure",
  "rejection",
  "invalidation",
]);
const FACTORY_KEYS = new Set([
  "enabled",
  "runner",
  "confirmationProducer",
  "automaticOwnPrRepair",
  "codeJobReader",
  "grantFactory",
  "clock",
  "pollIntervalMs",
  "leaseDurationMs",
  "handlerTimeoutMs",
  "retryBaseMs",
  "retryMaxMs",
  "defaultBatchLimit",
]);

function invalidProposal(message = "代码工作提案处理失败") {
  return workProposalError("INVALID_CODE_ACTION_PROPOSAL", message);
}

function invalidConfirmation(message = "代码任务确认结果无效") {
  return workProposalError("INVALID_CODE_ACTION_CONFIRMATION", message);
}

function invalidJob(message = "代码任务结果无效") {
  return workProposalError("INVALID_CODE_JOB_RESULT", message);
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(value, new TypeError("clock is invalid"));
}

function sameValue(left, right) {
  try {
    return (
      JSON.stringify(cloneWorkProposalValue(left)) ===
      JSON.stringify(cloneWorkProposalValue(right))
    );
  } catch {
    return false;
  }
}

function boundedReference(
  value,
  error,
  { minimumBytes = 1, maximumBytes = 256 } = {},
) {
  const size = typeof value === "string" ? Buffer.byteLength(value, "utf8") : -1;
  if (
    typeof value !== "string" ||
    size < minimumBytes ||
    size > maximumBytes ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw error;
  }
  return value;
}

function normalizedStoredProposal(value, error) {
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    error,
  );
  const proposal = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    normalizeWorkProposalDigest(value.contentDigest, error) !==
    proposal.contentDigest
  ) {
    throw error;
  }
  return proposal;
}

function normalizeHandlerInput(value) {
  const error = invalidProposal();
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "attempt", "downstreamRef"],
    error,
  );
  if (!ACTIVE_PROPOSAL_STATUSES.has(value.status)) throw error;
  return {
    proposal: normalizedStoredProposal(value.proposal, error),
    status: value.status,
    attempt: safeWorkProposalInteger(value.attempt, "attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef:
      value.downstreamRef === null
        ? null
        : boundedReference(value.downstreamRef, error),
  };
}

function normalizeFailure(value, error) {
  assertWorkProposalExactKeys(
    value,
    ["code", "outcome", "retryable", "at"],
    error,
  );
  if (
    typeof value.code !== "string" ||
    !FAILURE_CODE.test(value.code) ||
    !["absent", "unknown"].includes(value.outcome) ||
    typeof value.retryable !== "boolean" ||
    value.retryable !== (value.outcome === "absent")
  ) {
    throw error;
  }
  return {
    code: value.code,
    outcome: value.outcome,
    retryable: value.retryable,
    at: normalizeWorkProposalTimestamp(value.at, error),
  };
}

function normalizeReceipt(value, error) {
  assertWorkProposalExactKeys(value, ["id", "createdAt"], error);
  return {
    id: boundedReference(value.id, error),
    createdAt: normalizeWorkProposalTimestamp(value.createdAt, error),
  };
}

function validateOptionalConfirmationFields(item, keys, expected, error) {
  const optional = keys.filter((key) => OPTIONAL_CONFIRMATION_KEYS.has(key));
  const allowed = {
    pending: [],
    executing: [],
    completed: ["receipt"],
    failed: ["failure"],
    stale: ["invalidation"],
    rejected: ["rejection"],
  }[item.status];
  if (optional.some((key) => !allowed.includes(key))) throw error;
  if (
    (item.status === "completed" && !optional.includes("receipt")) ||
    (item.status === "failed" && !optional.includes("failure")) ||
    (item.status === "rejected" && !optional.includes("rejection")) ||
    (item.status !== "failed" && item.retryable)
  ) {
    throw error;
  }
  if (item.status === "rejected") {
    assertWorkProposalExactKeys(
      item.rejection,
      ["requestId", "reason", "at"],
      error,
    );
    if (!REQUEST_ID.test(boundedReference(item.rejection.requestId, error))) {
      throw error;
    }
    boundedReference(item.rejection.reason, error, {
      minimumBytes: 0,
      maximumBytes: 1_024,
    });
    normalizeWorkProposalTimestamp(item.rejection.at, error);
  }
  if (item.status === "stale" && item.invalidation !== undefined) {
    assertWorkProposalExactKeys(
      item.invalidation,
      ["reason", "requestedBy", "approvalBindingDigest", "at"],
      error,
    );
    if (
      !INVALIDATION_REASONS.has(item.invalidation.reason) ||
      !sameValue(item.invalidation.requestedBy, expected.requestedBy) ||
      normalizeWorkProposalDigest(
        item.invalidation.approvalBindingDigest,
        error,
      ) !== expected.approvalBindingDigest
    ) {
      throw error;
    }
    normalizeWorkProposalTimestamp(item.invalidation.at, error);
  }
}

function normalizeConfirmationItem(value, expected) {
  const error = invalidConfirmation();
  const entries = workProposalDataEntries(value, error);
  const keys = entries.map(([key]) => key);
  if (
    REQUIRED_CONFIRMATION_KEYS.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !REQUIRED_CONFIRMATION_KEYS.includes(key) &&
        !OPTIONAL_CONFIRMATION_KEYS.has(key),
    )
  ) {
    throw error;
  }
  const item = cloneWorkProposalValue(Object.fromEntries(entries));
  if (
    item.id !== expected.id ||
    item.kind !== expected.kind ||
    !CONFIRMATION_STATUSES.has(item.status) ||
    !Number.isSafeInteger(item.queueRevision) ||
    item.queueRevision < 1 ||
    !Number.isSafeInteger(item.itemRevision) ||
    item.itemRevision < 1 ||
    !sameValue(item.requestedBy, expected.requestedBy) ||
    !sameValue(item.actor, expected.actor) ||
    !sameValue(item.target, expected.target) ||
    !sameValue(item.display, expected.display) ||
    normalizeWorkProposalDigest(item.displayedPayloadDigest, error) !==
      expected.displayedPayloadDigest ||
    normalizeWorkProposalDigest(item.approvalBindingDigest, error) !==
      expected.approvalBindingDigest ||
    typeof item.retryable !== "boolean"
  ) {
    throw error;
  }
  validateOptionalConfirmationFields(item, keys, expected, error);
  const failure =
    item.status === "failed" ? normalizeFailure(item.failure, error) : null;
  if (failure && item.retryable !== failure.retryable) throw error;
  return {
    ...item,
    receipt:
      item.status === "completed"
        ? normalizeReceipt(item.receipt, error)
        : null,
    failure,
  };
}

function normalizeOwnedConfirmationItem(value, proposal, confirmationId) {
  const error = invalidConfirmation("旧代码任务确认绑定无效");
  const entries = workProposalDataEntries(value, error);
  const projected = cloneWorkProposalValue(Object.fromEntries(entries));
  const embeddedAction = projected.display?.payload?.action;
  let expected;
  try {
    expected = normalizeConfirmationPlan({
      id: projected.id,
      kind: projected.kind,
      requestedBy: projected.requestedBy,
      actor: projected.actor,
      target: projected.target,
      action: embeddedAction,
      display: projected.display,
    });
  } catch {
    throw error;
  }
  const item = normalizeConfirmationItem(projected, expected);
  assertWorkProposalExactKeys(expected.action, ["type", "grant"], error);
  if (
    item.id !== confirmationId ||
    item.kind !== "local.code-job-create" ||
    expected.action.type !== "create_code_job" ||
    !sameValue(item.requestedBy, proposal.requestedBy) ||
    !sameValue(item.actor, {
      provider: "local-code",
      accountId: "controlled-code-executor",
    }) ||
    !sameValue(item.target, {
      provider: "local-code",
      resourceId: proposal.binding.workspaceId,
      version: proposal.contentDigest,
    })
  ) {
    throw error;
  }
  let grant;
  try {
    grant = normalizeCodeJobGrant(expected.action.grant);
  } catch {
    throw error;
  }
  const proposalBinding = {
    proposalId: proposal.proposalId,
    contentDigest: proposal.contentDigest,
    policyVersion: proposal.policyVersion,
    requestedBy: proposal.requestedBy,
    source: proposal.source,
    subject: proposal.binding.subject,
    repository: proposal.binding.repository,
    workspaceId: proposal.binding.workspaceId,
    inputBinding: proposal.binding.inputBinding,
    ...(Object.hasOwn(proposal.binding, "executionSource")
      ? { executionSource: proposal.binding.executionSource }
      : {}),
    operation: proposal.payload.operation,
    objective: proposal.payload.objective,
    acceptanceCriteria: proposal.payload.acceptanceCriteria,
    evidence: proposal.payload.evidence,
    summary: proposal.payload.summary,
    reason: proposal.payload.reason,
  };
  const grantBinding = Object.fromEntries(
    Object.keys(proposalBinding).map((key) => [key, grant[key]]),
  );
  if (!sameValue(grantBinding, proposalBinding)) throw error;
  return item;
}

function nextAttemptAt(clock, pollIntervalMs) {
  return new Date(
    Date.parse(normalizeClock(clock)) + pollIntervalMs,
  ).toISOString();
}

function active(status, downstreamRef, clock, pollIntervalMs) {
  return {
    status,
    downstreamRef,
    nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
  };
}

function terminal(status, summary, item, evidence = []) {
  return {
    status,
    summary,
    evidence: [`confirmation:${item.id}`, ...evidence],
  };
}

function confirmationFailureTransition(item, clock, pollIntervalMs) {
  if (item.failure.retryable) {
    return {
      status: "waiting_retry",
      reason: item.failure.code,
      nextAttemptAt: nextAttemptAt(clock, pollIntervalMs),
    };
  }
  return terminal(
    "unknown",
    "本地代码任务创建结果无法确认",
    item,
    [item.failure.code],
  );
}


function factoryOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Code proposal runner options are invalid");
  }
  const entries = workProposalDataEntries(
    value,
    new TypeError("Code proposal runner options are invalid"),
  );
  if (entries.some(([key]) => !FACTORY_KEYS.has(key))) {
    throw new TypeError("Code proposal runner options are invalid");
  }
  return Object.fromEntries(entries);
}

export class CodeActionProposalHandler {
  #enqueue;
  #getConfirmation;
  #invalidateConfirmation;
  #getCodeJob;
  #createGrant;
  #clock;
  #pollIntervalMs;
  #automaticOwnPrRepair;

  constructor({
    confirmationProducer,
    codeJobReader,
    grantFactory,
    automaticOwnPrRepair = null,
    clock = () => new Date(),
    pollIntervalMs = 15_000,
  } = {}) {
    const confirmation = requirePort(
      confirmationProducer,
      ["enqueue", "get", "invalidate"],
      "confirmationProducer",
    );
    this.#enqueue = confirmation.enqueue;
    this.#automaticOwnPrRepair = automaticOwnPrRepair;
    this.#getConfirmation = confirmation.get;
    this.#invalidateConfirmation = confirmation.invalidate;
    this.#getCodeJob = requirePort(codeJobReader, ["get"], "codeJobReader").get;
    this.#createGrant = requirePort(
      grantFactory,
      ["create"],
      "grantFactory",
    ).create;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#pollIntervalMs = positiveInteger(
      pollIntervalMs,
      "pollIntervalMs",
      MAX_POLL_INTERVAL_MS,
    );
  }

  async handle(value) {
    const input = normalizeHandlerInput(value);
    const legacyInputBinding =
      input.proposal.binding.inputBinding !== null &&
      input.proposal.binding.inputBinding.schemaVersion !== 2;
    let existingItem = null;
    let existingValue = null;
    let knownMissingConfirmationId = null;
    if (input.downstreamRef !== null) {
      try {
        existingValue = await this.#getConfirmation(input.downstreamRef);
      } catch (error) {
        if (!legacyInputBinding || error?.code !== "CONFIRMATION_NOT_FOUND") {
          throw error;
        }
        knownMissingConfirmationId = input.downstreamRef;
      }
      if (existingValue !== null) {
        existingItem = normalizeOwnedConfirmationItem(
          existingValue,
          input.proposal,
          input.downstreamRef,
        );
      } else {
        knownMissingConfirmationId = input.downstreamRef;
      }
    }
    if (legacyInputBinding) {
      const owned =
        existingItem ??
        (await this.#findOwnedConfirmation(
          input.proposal,
          knownMissingConfirmationId,
        ));
      if (owned) {
        return this.#invalidateChangedAuthorization(owned, input.proposal);
      }
      return {
        status: "stale",
        summary: "旧版 PR 输入绑定只能恢复查看，未进入新的代码任务确认",
        evidence: [
          "legacy_input_binding",
          `proposal:${input.proposal.proposalId}`,
        ],
      };
    }
    // Completed confirmation is a durable handoff. Validate its sealed identity
    // and observe the executor; the executor owns authority checks before effects.
    if (existingItem?.status === 'completed' &&
        ['running', 'waiting_confirmation', 'waiting_retry'].includes(input.status)) {
      const grant = normalizeCodeJobGrant(existingValue.display.payload.action.grant);
      const expected = normalizeConfirmationPlan(createCodeActionProposalConfirmationPlan(input.proposal, {
        grant, allowedOperationsByRole: { [input.proposal.requestedBy.roleId]: [input.proposal.payload.operation] },
      }));
      return this.#transitionConfirmation(normalizeConfirmationItem(existingValue, expected), grant);
    }
    let authority;
    try {
      authority = await this.#createGrant(
        cloneWorkProposalValue(input.proposal),
      );
    } catch (error) {
      if (AUTHORIZATION_ERROR_CODES.has(error?.code)) {
        const owned =
          existingItem ??
          (await this.#findOwnedConfirmation(input.proposal));
        if (owned) {
          return this.#invalidateChangedAuthorization(owned, input.proposal);
        }
        return {
          status: "stale",
          summary: "代码任务授权已变化，未进入确认队列",
          evidence: [
            "authorization_changed",
            `proposal:${input.proposal.proposalId}`,
          ],
        };
      }
      throw error;
    }
    const plan = createCodeActionProposalConfirmationPlan(
      input.proposal,
      authority,
    );
    const expected = normalizeConfirmationPlan(plan);
    const grant = expected.action.grant;
    const confirmationId = expected.id;
    const jobId = codeJobIdForGrant(grant);

    if (
      existingItem !== null &&
      (input.downstreamRef !== confirmationId ||
        existingItem.approvalBindingDigest !==
          expected.approvalBindingDigest)
    ) {
      return this.#invalidateChangedAuthorization(
        existingItem,
        input.proposal,
      );
    }

    if (input.status === "running") {
      return this.#pollJob(
        jobId,
        grant,
        { id: jobId, createdAt: null },
        confirmationId,
      );
    }

    if (input.status === "waiting_confirmation") {
      return this.#transitionConfirmation(
        normalizeConfirmationItem(await this.#approveAutomatically(existingValue), expected),
        grant,
      );
    }

    if (input.status === "waiting_retry" && input.downstreamRef !== null) {
      return this.#transitionConfirmation(
        normalizeConfirmationItem(await this.#approveAutomatically(existingValue), expected),
        grant,
      );
    }

    if (input.status !== "pending_delivery" && input.status !== "waiting_retry") {
      throw invalidProposal();
    }
    if (input.downstreamRef !== null) throw invalidProposal();
    let queued;
    try {
      queued = await this.#enqueue(plan);
    } catch (error) {
      if (error?.code !== "CONFIRMATION_ID_CONFLICT") throw error;
      const owned = normalizeOwnedConfirmationItem(
        await this.#getConfirmation(confirmationId),
        input.proposal,
        confirmationId,
      );
      return this.#invalidateChangedAuthorization(owned, input.proposal);
    }
    const item = normalizeConfirmationItem(await this.#approveAutomatically(queued), expected);
    return this.#transitionConfirmation(item, grant);
  }

  #approveAutomatically(item) {
    return this.#automaticOwnPrRepair === null ? item : this.#automaticOwnPrRepair.approveCodeJob(item);
  }

  async #findOwnedConfirmation(proposal, knownMissingId = null) {
    const id = codeJobConfirmationIdForProposal(proposal);
    if (id === knownMissingId) return null;
    let value;
    try {
      value = await this.#getConfirmation(id);
    } catch (error) {
      if (error?.code === "CONFIRMATION_NOT_FOUND") return null;
      throw error;
    }
    return normalizeOwnedConfirmationItem(value, proposal, id);
  }

  async #invalidateChangedAuthorization(item, proposal) {
    const invalidation = {
      requestedBy: proposal.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest,
      reason: "authorization_changed",
    };
    let current = item;
    if (
      item.status === "pending" ||
      (item.status === "failed" && item.failure?.retryable) ||
      item.status === "stale"
    ) {
      try {
        current = normalizeOwnedConfirmationItem(
          await this.#invalidateConfirmation(item.id, invalidation),
          proposal,
          item.id,
        );
      } catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_INVALIDATABLE") throw error;
        current = normalizeOwnedConfirmationItem(
          await this.#getConfirmation(item.id),
          proposal,
          item.id,
        );
      }
    }
    if (current.status === "pending") {
      throw invalidConfirmation("旧代码任务确认未能安全撤销");
    }
    const revoked =
      current.status === "stale" &&
      current.invalidation?.reason === "authorization_changed";
    return terminal(
      "stale",
      revoked
        ? "代码任务授权已变化，旧确认已撤销"
        : "代码任务授权已变化，旧确认结果已隔离",
      current,
      ["authorization_changed", `old_confirmation_status:${current.status}`],
    );
  }

  async #transitionConfirmation(item, grant) {
    if (["pending", "executing"].includes(item.status)) {
      return active(
        "waiting_confirmation",
        item.id,
        this.#clock,
        this.#pollIntervalMs,
      );
    }
    if (item.status === "completed") {
      return this.#pollJob(item.receipt.id, grant, item.receipt, item.id);
    }
    if (item.status === "rejected") {
      return terminal("rejected", "用户已拒绝本地代码任务", item);
    }
    if (item.status === "stale") {
      return terminal("stale", "本地代码任务提案已失效", item);
    }
    return confirmationFailureTransition(
      item,
      this.#clock,
      this.#pollIntervalMs,
    );
  }

  async #pollJob(jobId, grant, receipt, confirmationId) {
    const value = await this.#getCodeJob(jobId);
    if (value === null) throw invalidJob("已批准的本地代码任务不存在");
    const effectiveReceipt = {
      id: jobId,
      createdAt: receipt.createdAt ?? value.createdAt,
    };
    const job = normalizeCodeJobConfirmationResult(value, grant, effectiveReceipt);
    if (
      isActiveCodeJobBrowserStatus(job.status) ||
      job.memoryProjection === null
    ) {
      return active(
        "running",
        confirmationId,
        this.#clock,
        this.#pollIntervalMs,
      );
    }
    const evidence = [
      `code-job:${job.jobId}`,
      `code-job-status:${job.status}`,
      ...(job.memoryProjection === null
        ? []
        : [`memory:${job.memoryProjection.recordId}`]),
    ];
    if (job.status === "completed") {
      return terminal(
        "succeeded",
        "本地代码任务已完成并通过可信检查",
        { id: confirmationId },
        evidence,
      );
    }
    if (job.status === "failed") {
      return terminal(
        "failed",
        VERIFICATION_FAILURE_SUMMARIES[job.verificationOutcome] ?? "本地代码任务执行失败",
        { id: confirmationId },
        job.verificationOutcome === undefined
          ? evidence
          : [...evidence, `verification-outcome:${job.verificationOutcome}`],
      );
    }
    if (job.status === "cancelled") {
      return terminal(
        "rejected",
        "本地代码任务已由用户取消",
        { id: confirmationId },
        evidence,
      );
    }
    return terminal(
      "unknown",
      "本地代码任务因安全边界被隔离",
      { id: confirmationId },
      evidence,
    );
  }
}

export function createCodeActionProposalRunnerService(value = {}) {
  const options = factoryOptions(value);
  if (options.enabled === undefined || options.enabled === false) return null;
  if (options.enabled !== true) {
    throw new TypeError("Code proposal runner enabled flag is invalid");
  }
  const handler = new CodeActionProposalHandler({
    confirmationProducer: options.confirmationProducer,
    codeJobReader: options.codeJobReader,
    grantFactory: options.grantFactory,
    automaticOwnPrRepair: options.automaticOwnPrRepair,
    clock: options.clock,
    pollIntervalMs: options.pollIntervalMs,
  });
  return new WorkProposalRunnerService({
    runner: options.runner,
    handler,
    clock: options.clock,
    leaseDurationMs: options.leaseDurationMs,
    handlerTimeoutMs: options.handlerTimeoutMs,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    defaultBatchLimit: options.defaultBatchLimit,
  });
}
