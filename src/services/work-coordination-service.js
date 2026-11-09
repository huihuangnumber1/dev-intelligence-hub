import { MAX_WORK_LEDGER_QUERY_PAGE } from "./work-ledger-records.js";
import { MAX_WORK_LEDGER_ITEMS } from "./work-ledger-state.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { TargetedCycleQueue } from "../lib/targeted-cycle-queue.js";
import { normalizeContinuationTarget } from "./work-continuation-state.js";

const SAFE_TRIGGER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const NO_ROLE_SCOPE = "*";
const SOURCE_RECONCILIATION_MAX_PAGES = Math.ceil(
  MAX_WORK_LEDGER_ITEMS / MAX_WORK_LEDGER_QUERY_PAGE,
);
const SOURCE_RECONCILIATION_CONFLICTS = new Set([
  "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
  "WORK_LEDGER_STATE_REVISION_CONFLICT",
  "WORK_LEDGER_REVISION_CONFLICT",
]);

function requirePort(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name} must provide ${method}`);
  }
  return value[method].bind(value);
}

function positiveLimit(value, name, maximum = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeTrigger(value) {
  if (typeof value !== "string" || !SAFE_TRIGGER.test(value)) {
    throw new TypeError("trigger is invalid");
  }
  return value;
}

function safeRoleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError("roleId is invalid");
  }
  return value;
}

function cycleOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(
      (key) => !["trigger", "includeWork", "roleId", "signal", "continuationTarget"].includes(key),
    )
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const includeWork = value.includeWork ?? true;
  if (typeof includeWork !== "boolean") {
    throw new TypeError("includeWork is invalid");
  }
  const roleId = value.roleId == null ? null : safeRoleId(value.roleId);
  const continuationTarget = normalizeContinuationTarget(value.continuationTarget);
  if (continuationTarget !== null && (!includeWork || roleId === null)) throw new TypeError('target requires a work role');
  if (!includeWork && roleId !== null) {
    throw new TypeError("roleId requires includeWork");
  }
  return Object.freeze({
    trigger: safeTrigger(value.trigger ?? "scheduled"),
    includeWork,
    roleId,
    continuationTarget,
    signal: normalizeAbortSignal(value.signal ?? null),
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error("Work coordination was cancelled"), {
    code: "WORK_COORDINATION_CANCELLED",
  });
}

async function skipProposalExecution() {
  return { skipped: "not_configured" };
}

async function skipCodeJobs() {
  return { skipped: "not_configured" };
}

async function skipCodeJobChangePackages() {
  return { skipped: "not_configured" };
}

async function skipChangePackageApplicationResults() {
  return { skipped: "not_configured" };
}

async function skipCodeJobMemory() {
  return { skipped: "not_configured" };
}

async function skipPullRequestSourceReconciliation() {
  return { skipped: "not_configured" };
}

async function readPendingPullRequestSources(listPendingSources, signal) {
  const roots = [];
  const seenItemIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (
    let pageNumber = 0;
    pageNumber < SOURCE_RECONCILIATION_MAX_PAGES;
    pageNumber += 1
  ) {
    throwIfAborted(signal);
    const page = await listPendingSources({
      limit: MAX_WORK_LEDGER_QUERY_PAGE,
      ...(cursor === null ? {} : { cursor }),
    });
    throwIfAborted(signal);
    if (
      !page ||
      !Array.isArray(page.items) ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string")
    ) {
      throw new TypeError(
        "ledger listPendingPullRequestSources returned an invalid page",
      );
    }
    for (const root of page.items) {
      if (
        typeof root?.itemId !== "string" ||
        seenItemIds.has(root.itemId)
      ) {
        throw new TypeError(
          "ledger listPendingPullRequestSources returned an invalid page",
        );
      }
      seenItemIds.add(root.itemId);
      roots.push(root);
    }
    if (page.nextCursor === null) return roots;
    if (
      page.items.length === 0 ||
      page.items.at(-1).itemId !== page.nextCursor ||
      seenCursors.has(page.nextCursor)
    ) {
      throw new TypeError(
        "ledger listPendingPullRequestSources returned an invalid cursor",
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new TypeError(
    "ledger listPendingPullRequestSources exceeded the bounded page limit",
  );
}

function optionalPullRequestSourceReconciler(ledger) {
  const commonMethods = [
    "listPendingPullRequestSources",
    "getSummary",
  ];
  const available = commonMethods.filter(
    (method) => typeof ledger?.[method] === "function",
  );
  const reconcileBatch =
    typeof ledger?.reconcilePullRequestSourceBatch === "function"
      ? ledger.reconcilePullRequestSourceBatch.bind(ledger)
      : null;
  const reconcileOne =
    typeof ledger?.reconcilePullRequestSource === "function"
      ? ledger.reconcilePullRequestSource.bind(ledger)
      : null;
  if (
    available.length === 0 &&
    reconcileBatch === null &&
    reconcileOne === null
  ) {
    return skipPullRequestSourceReconciliation;
  }
  if (
    available.length !== commonMethods.length ||
    (reconcileBatch === null && reconcileOne === null)
  ) {
    throw new TypeError(
      "ledger PR source reconciliation port is only partially configured",
    );
  }
  const listPendingSources = ledger.listPendingPullRequestSources.bind(ledger);
  const getSummary = ledger.getSummary.bind(ledger);
  return async ({ limit, signal = null }) => {
    const pendingRoots = await readPendingPullRequestSources(
      listPendingSources,
      signal,
    );
    const result = {
      scanned: 0,
      pending: pendingRoots.length,
      applied: 0,
      blocked: 0,
      conflicted: 0,
    };
    if (reconcileBatch !== null && pendingRoots.length > 0) {
      // A blocked first page must not hide later roots. Each batch stops after
      // its first write; limit counts applied roots, as in the single-item path.
      for (let offset = 0; offset < pendingRoots.length && result.applied < limit;) {
        const summary = await getSummary();
        throwIfAborted(signal);
        const roots = pendingRoots.slice(offset, offset + limit);
        let batch;
        try {
          batch = await reconcileBatch({
            expectedGraphRevision: summary.revision,
            items: roots.map((root) => ({
              itemId: root.itemId,
              expectedRevision: root.revision,
              expectedPendingRevision:
                root.source.pendingRevision ?? root.source.activeRevision,
            })),
          });
        } catch (error) {
          throwIfAborted(signal);
          if (!SOURCE_RECONCILIATION_CONFLICTS.has(error?.code)) throw error;
          // Another lane changed the ledger. Keep CAS intact and defer these
          // roots to a fresh cycle instead of failing housekeeping or spinning.
          result.scanned += roots.length;
          result.conflicted += roots.length;
          offset += roots.length;
          continue;
        }
        throwIfAborted(signal);
        if (!batch || !Array.isArray(batch.outcomes) || batch.outcomes.length < 1 || batch.outcomes.length > roots.length) {
          throw new TypeError(
            "ledger reconcilePullRequestSourceBatch returned an invalid result",
          );
        }
        result.scanned += batch.outcomes.length;
        offset += batch.outcomes.length;
        for (const outcome of batch.outcomes) {
          if (outcome?.status === "applied") result.applied += 1;
          else if (outcome?.status === "blocked") result.blocked += 1;
          else if (
            outcome?.status === "conflicted" ||
            outcome?.status === "unchanged"
          ) {
            result.conflicted += 1;
          } else {
            throw new TypeError(
              "ledger reconcilePullRequestSourceBatch returned an invalid result",
            );
          }
        }
      }
      return result;
    }
    for (const root of pendingRoots) {
      throwIfAborted(signal);
      if (result.applied >= limit) break;
      result.scanned += 1;
      try {
        const summary = await getSummary();
        throwIfAborted(signal);
        const outcome = await reconcileOne({
          itemId: root.itemId,
          expectedGraphRevision: summary.revision,
          expectedRevision: root.revision,
          expectedPendingRevision:
            root.source.pendingRevision ?? root.source.activeRevision,
        });
        throwIfAborted(signal);
        if (outcome.applied === true) result.applied += 1;
        else if (Array.isArray(outcome.blockers) && outcome.blockers.length > 0) {
          result.blocked += 1;
        } else {
          result.conflicted += 1;
        }
      } catch (error) {
        if (!SOURCE_RECONCILIATION_CONFLICTS.has(error?.code)) throw error;
        result.conflicted += 1;
      }
    }
    return result;
  };
}

function stableErrorCodes(error) {
  const codes = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0 && seen.size < 16 && codes.length < 8) {
    const current = pending.shift();
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (
      typeof code === "string" &&
      SAFE_ERROR_CODE.test(code) &&
      !codes.includes(code)
    ) {
      codes.push(code);
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    if (cause !== undefined) pending.push(cause);
    const errors = Object.getOwnPropertyDescriptor(current, "errors")?.value;
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 8));
  }
  return Object.freeze(codes);
}

function stableInternalErrorDetails(error) {
  const details = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0 && seen.size < 16 && details.length < 4) {
    const current = pending.shift();
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    const message = Object.getOwnPropertyDescriptor(current, "message")?.value;
    if (
      typeof code === "string" &&
      (code.startsWith("WORK_LEDGER_") || code.startsWith("ORCHESTRATOR_")) &&
      typeof message === "string" &&
      message.length > 0 &&
      Buffer.byteLength(message, "utf8") <= 240 &&
      !/\p{Cc}/u.test(message)
    ) {
      details.push(`${code}: ${message}`);
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    if (cause !== undefined) pending.push(cause);
    const errors = Object.getOwnPropertyDescriptor(current, "errors")?.value;
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 8));
  }
  return Object.freeze(details);
}

function stageFailure(stage, error) {
  const causeCodes = stableErrorCodes(error);
  const causeDetails = stableInternalErrorDetails(error);
  const causeSummary = causeCodes.length
    ? ` [${causeCodes.join(" > ")}]`
    : "";
  const detailSummary = causeDetails.length
    ? ` (${causeDetails.join("; ")})`
    : "";
  const wrapped = new Error(
    `员工主动循环阶段失败: ${stage}${causeSummary}${detailSummary}`,
    { cause: error },
  );
  wrapped.code = "WORK_COORDINATION_STAGE_FAILED";
  wrapped.stage = stage;
  wrapped.causeCodes = causeCodes;
  wrapped.causeDetails = causeDetails;
  return wrapped;
}

export class WorkCoordinationService {
  #intake;
  #runCodeJobs;
  #recoverCodeJobPauses;
  #dispatchCodeJobChangePackages;
  #reconcileChangePackageApplicationResults;
  #projectCodeJobMemory;
  #runProposals;
  #runReviewProposals;
  #runOwnPrRepairs;
  #runOwnPrRecoveries;
  #refreshOwnerPullRequestSources;
  #reconcileProposals;
  #reconcileAttention;
  #wakeConditions;
  #reconcilePullRequestSources;
  #runWork;
  #dispatch;
  #defaults;
  #inFlightByScope = new Map();
  #cycleTail = Promise.resolve();
  #targetedCycles = new TargetedCycleQueue();

  constructor({
    ledger,
    codeJobRunner,
    codeJobPauseRecovery = null,
    codeJobChangePackageDispatcher,
    changePackageApplicationResultReconciler,
    codeJobMemoryProjector,
    proposalRunner,
    reviewProposalRunner = null,
    automaticOwnPrRepair = null,
    ownerPullRequestSourceRefresher = null,
    proposalResultReconciler,
    attentionResultReconciler,
    conditionWaker,
    workLoop,
    dispatcher,
    intakeLimit = 100,
    workLimit = 20,
    dispatchLimit = 50,
    attentionLimit = 50,
    proposalLimit = 50,
    conditionLimit = 50,
    codeJobLimit = 10,
    codeJobMemoryLimit = 50,
  } = {}) {
    this.#intake = requirePort(ledger, "intake", "ledger");
    this.#recoverCodeJobPauses = codeJobPauseRecovery === null ? null : requirePort(codeJobPauseRecovery, "runCycle", "codeJobPauseRecovery");
    this.#runOwnPrRepairs = automaticOwnPrRepair === null ? null : requirePort(automaticOwnPrRepair, "runCycle", "automaticOwnPrRepair");
    this.#runOwnPrRecoveries = typeof automaticOwnPrRepair?.runRecoveryCycle === "function"
      ? requirePort(automaticOwnPrRepair, "runRecoveryCycle", "automaticOwnPrRepair") : null;
    this.#refreshOwnerPullRequestSources = ownerPullRequestSourceRefresher === null ? null :
      requirePort(ownerPullRequestSourceRefresher, "runCycle", "ownerPullRequestSourceRefresher");
    this.#runCodeJobs = codeJobRunner == null
      ? skipCodeJobs
      : requirePort(codeJobRunner, "runCycle", "codeJobRunner");
    this.#dispatchCodeJobChangePackages =
      codeJobChangePackageDispatcher == null
        ? skipCodeJobChangePackages
        : requirePort(
            codeJobChangePackageDispatcher,
            "runCycle",
            "codeJobChangePackageDispatcher",
          );
    this.#reconcileChangePackageApplicationResults =
      changePackageApplicationResultReconciler == null
        ? skipChangePackageApplicationResults
        : requirePort(
            changePackageApplicationResultReconciler,
            "runCycle",
            "changePackageApplicationResultReconciler",
          );
    this.#projectCodeJobMemory = codeJobMemoryProjector == null
      ? skipCodeJobMemory
      : requirePort(
          codeJobMemoryProjector,
          "runCycle",
          "codeJobMemoryProjector",
        );
    this.#runProposals = proposalRunner == null
      ? skipProposalExecution
      : requirePort(proposalRunner, "runCycle", "proposalRunner");
    this.#runReviewProposals = reviewProposalRunner === null
      ? null
      : requirePort(reviewProposalRunner, "runCycle", "reviewProposalRunner");
    this.#reconcileProposals = requirePort(
      proposalResultReconciler,
      "runCycle",
      "proposalResultReconciler",
    );
    this.#reconcileAttention = requirePort(
      attentionResultReconciler,
      "runCycle",
      "attentionResultReconciler",
    );
    this.#wakeConditions = requirePort(
      conditionWaker,
      "runCycle",
      "conditionWaker",
    );
    this.#reconcilePullRequestSources = optionalPullRequestSourceReconciler(
      ledger,
    );
    this.#runWork = requirePort(workLoop, "runCycle", "workLoop");
    this.#dispatch = requirePort(dispatcher, "dispatchPending", "dispatcher");
    this.#defaults = Object.freeze({
      intakeLimit: positiveLimit(intakeLimit, "intakeLimit"),
      workLimit: positiveLimit(workLimit, "workLimit"),
      dispatchLimit: positiveLimit(dispatchLimit, "dispatchLimit"),
      attentionLimit: positiveLimit(attentionLimit, "attentionLimit"),
      proposalLimit: positiveLimit(proposalLimit, "proposalLimit"),
      conditionLimit: positiveLimit(conditionLimit, "conditionLimit"),
      codeJobLimit: positiveLimit(codeJobLimit, "codeJobLimit"),
      codeJobMemoryLimit: positiveLimit(
        codeJobMemoryLimit,
        "codeJobMemoryLimit",
      ),
    });
  }

  async intake({ signal = null } = {}) {
    signal = normalizeAbortSignal(signal);
    throwIfAborted(signal);
    const result = await this.#intake({ limit: this.#defaults.intakeLimit });
    throwIfAborted(signal);
    return result;
  }

  runCycle(input = {}) {
    const options = cycleOptions(input);
    throwIfAborted(options.signal);
    const scope = options.includeWork
      ? `work:${options.roleId ?? NO_ROLE_SCOPE}`
      : "housekeeping";
    if (options.continuationTarget !== null) return this.#targetedCycles.run(
      JSON.stringify([scope, options.continuationTarget]), {
        signal: options.signal, current: () => this.#inFlightByScope.get(scope),
        execute: () => this.#startCycle(options, scope),
      });
    return this.#startCycle(options, scope);
  }

  #startCycle(options, scope) {
    const running = this.#inFlightByScope.get(scope);
    if (running) return running;
    const serialized = options.roleId === null;
    const execution = serialized
      ? this.#cycleTail.then(() => this.#performCycle(options))
      : this.#performCycle(options);
    const tracked = execution.finally(() => {
      if (this.#inFlightByScope.get(scope) === tracked) {
        this.#inFlightByScope.delete(scope);
      }
    });
    this.#inFlightByScope.set(scope, tracked);
    if (serialized) this.#cycleTail = tracked.catch(() => {});
    return tracked;
  }

  async #performCycle(options) {
    throwIfAborted(options.signal);
    const stages = options.roleId === null
      ? [
          ["proposal_execution", () =>
            this.#runProposals({
              limit: this.#defaults.proposalLimit,
              ...(options.signal === null ? {} : { signal: options.signal }),
            })],
          ["code_jobs", () =>
            this.#runCodeJobs({ limit: this.#defaults.codeJobLimit, ...(options.signal === null ? {} : { signal: options.signal }) })],
          ["code_job_change_packages", () =>
            this.#dispatchCodeJobChangePackages({
              limit: this.#defaults.codeJobLimit,
            })],
          ...(this.#runOwnPrRepairs === null ? [] : [["own_pr_repairs", () =>
            this.#runOwnPrRepairs({ limit: this.#defaults.codeJobLimit,
              ...(this.#runOwnPrRecoveries === null ? {} : { includeRecovery: false }) })]]),
          ["change_package_application_results", () =>
            this.#reconcileChangePackageApplicationResults()],
          ["code_job_memory", () =>
            this.#projectCodeJobMemory({
              limit: this.#defaults.codeJobMemoryLimit,
            })],
          ["proposal_results", () =>
            this.#reconcileProposals({ limit: this.#defaults.proposalLimit })],
          ["attention_results", () =>
            this.#reconcileAttention({ limit: this.#defaults.attentionLimit })],
          ["conditions", () =>
            this.#wakeConditions({ limit: this.#defaults.conditionLimit })],
          ["pull_request_source_reconciliation", () =>
            this.#reconcilePullRequestSources({
              limit: this.#defaults.intakeLimit,
              signal: options.signal,
            })],
        ]
      : options.roleId === "developer" && this.#runOwnPrRepairs !== null
        // Housekeeping owns long code execution and global memory projection.
        // Developer intake must not wait for another PR's model or build.
        ? [
            ["proposal_execution", () => this.#runProposals({ limit: this.#defaults.proposalLimit,
              ...(options.signal === null ? {} : { signal: options.signal }) })],
            ["code_job_change_packages", () => this.#dispatchCodeJobChangePackages({ limit: this.#defaults.codeJobLimit })],
            ["proposal_results", () => this.#reconcileProposals({ limit: this.#defaults.proposalLimit })],
            ["own_pr_repairs", () => this.#runOwnPrRepairs({ limit: this.#defaults.codeJobLimit,
              ...(this.#runOwnPrRecoveries === null ? {} : { includeRecovery: false }) })],
          ]
      : options.roleId === "pr-engineer"
        ? [["attention_results", () =>
            this.#reconcileAttention({ limit: this.#defaults.attentionLimit })]]
        : [];
    if (this.#runOwnPrRecoveries !== null && (options.roleId === null || options.roleId === "developer")) {
      stages.unshift(["own_pr_material_recovery", () => this.#runOwnPrRecoveries({ limit: this.#defaults.codeJobLimit })]);
    }
    if (this.#recoverCodeJobPauses !== null && (options.roleId === null || options.roleId === "developer")) {
      stages.unshift(["code_job_pause_recovery", () => this.#recoverCodeJobPauses({ limit: this.#defaults.codeJobLimit, signal: options.signal })]);
    }
    // Source refresh can read many historical requests and wait for GitHub.
    // Housekeeping owns that global sweep; role work must have an independent lane.
    if (this.#refreshOwnerPullRequestSources !== null && options.roleId === null) {
      stages.unshift(["owner_pull_request_source_refresh", () => this.#refreshOwnerPullRequestSources({
        limit: this.#defaults.codeJobLimit, signal: options.signal })]);
    }
    if (options.includeWork) {
      stages.push([
        "work",
        () =>
          this.#runWork({
            trigger: options.trigger,
            intakeLimit: this.#defaults.intakeLimit,
            workLimit: options.continuationTarget === null ? this.#defaults.workLimit : 1,
            ...(options.roleId === null ? {} : { roleId: options.roleId }),
            ...(options.continuationTarget === null ? {} : { continuationTarget: options.continuationTarget }),
            ...(options.signal === null ? {} : { signal: options.signal }),
          }),
      ]);
    }
    stages.push([
      "dispatch",
      () => this.#dispatch({
        limit: this.#defaults.dispatchLimit,
        ...(["pr-engineer", "orchestrator", "tester"].includes(options.roleId)
          ? { roleId: options.roleId } : {}),
      }),
    ]);
    if (options.roleId === "pr-engineer" && this.#runReviewProposals !== null) {
      stages.push(
        ["review_publication", () => this.#runReviewProposals({
          limit: this.#defaults.proposalLimit,
          ...(options.signal === null ? {} : { signal: options.signal }),
        })],
        ["review_results", () => this.#reconcileProposals({ limit: this.#defaults.proposalLimit })],
      );
    }
    const result = {
      trigger: options.trigger,
      includeWork: options.includeWork,
      roleId: options.roleId,
      stages: {},
    };
    const failures = [];
    for (const [name, operation] of stages) {
      try {
        throwIfAborted(options.signal);
        result.stages[name] = { ok: true, result: await operation() };
        throwIfAborted(options.signal);
      } catch (error) {
        if (options.signal?.aborted) throwIfAborted(options.signal);
        const failure = stageFailure(name, error);
        failures.push(failure);
        result.stages[name] = {
          ok: false,
          code: failure.code,
          causeCodes: failure.causeCodes,
        };
      }
    }
    if (failures.length) {
      const error = failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            `员工主动循环有多个阶段失败: ${
              failures.map(({ stage, causeCodes }) =>
                `${stage}${causeCodes.length ? ` [${causeCodes.join(" > ")}]` : ""}`
              ).join(", ")
            }`,
          );
      Object.defineProperty(error, "result", {
        configurable: false,
        enumerable: false,
        value: structuredClone(result),
        writable: false,
      });
      throw error;
    }
    return result;
  }
}
