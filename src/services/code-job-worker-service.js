import { OperationQueue } from "../lib/operation-queue.js";
import { createHash } from "node:crypto";
import { beginCodeReadSession, createCodeReadContext, hasCompleteCodeRead } from "../lib/code-read-context.js";
import { createCodeExecutionContext, closeCodeExecutionContext, revokeCodeExecutionContext } from "../lib/code-execution-context.js";
import { normalizeStructuredCodeActionDecision } from "../domain/structured-code-action-contract.js";
import { TaskRunControlError } from './task-run-registry.js';
import { codeProtocolRecoveryFor, hasUnadmittedProtocolRead, MODEL_QUEUE_TIMEOUT, stoppedCodeJobQueueTimeout } from './code-job-protocol-recovery.js';
import { isCodeJobBrainRetryableFailure } from "../domain/brain-failure-recovery.js";
import { currentTaskExecution } from '../lib/task-execution-context.js';
import { normalizeCodeSourceEdits, applyCodeSourceEdits } from '../lib/code-source-edits.js';
import { digestValue } from "../domain/code-executor-contract.js";
import {
  canCreateCodeJobChangePackageEvent,
} from "../domain/code-job-change-package-event.js";
import { packCodeJobBrainContext } from "./code-job-context-packer.js";
import { normalizeReviewRepairFeedbackContext } from "./review-repair-context-reader.js";
import { normalizeCiRepairEvidence } from '../domain/ci-repair-evidence.js';
import { githubEntitySessionKey } from "../lib/session-key.js";
import { INCOMPLETE_READ_CODE, pendingOverwriteRecoveryCandidate } from './code-job-read-recovery.js';
import {
  assertSessionBinding,
  assertPreparedWriteRead,
  bindTrustedAction,
  cleanText,
  isAuthorityErrorCode,
  isDeterministicFailureCode,
  isFencingExecutorCode,
  isRestartRequiredCode,
  modelObservation,
  normalizeActionResponse,
  normalizeCycleOptions,
  observationDetail,
  positiveInteger,
  requiresOperatorPause,
  safeErrorCode,
  sameValue,
  selectCycleCandidates,
  successfulProfiles,
  terminalResult,
  completionReportForAction,
  trustedObservationAction,
  verificationFailure,
  workerError,
} from "./code-job-worker-policy.js";

const DIRECT_ACTION_ADMISSION = Object.freeze({
  run: (operation) => operation(),
});

export { CodeJobWorkerError } from "./code-job-worker-policy.js";

const RUNNABLE_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "cancelling",
]);
const TERMINAL_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);
const CONTINUABLE_NATIVE_TIMEOUTS = new Set(["STRUCTURED_PROVIDER_TIMEOUT", "STRUCTURED_PROVIDER_IDLE_TIMEOUT"]);

function semanticProgressFingerprint(job) {
  const files = new Map();
  const verifications = new Map();
  const sortedFiles = () => [...files].sort(([left], [right]) => left.localeCompare(right));
  for (const observation of job.execution.observations) {
    if (observation.status !== "succeeded") continue;
    const action = trustedObservationAction(observation);
    const result = observation.detail?.result;
    if (["read_text", "write_text"].includes(action.type) && typeof action.path === "string" &&
        /^[a-f0-9]{64}$/u.test(result?.sha256)) files.set(action.path, result.sha256);
    const profile = action.type === "run_profile" ? job.grant.requiredProfiles.find(({ id }) => id === action.profileId) : null;
    if (profile && result?.exitCode === 0 && result.timedOut === false) {
      const evidence = { profileId: action.profileId, profileFingerprint: profile.configDigest, files: sortedFiles() };
      verifications.set(digestValue(evidence), evidence);
    }
  }
  // Action IDs, timestamps, read counts and model heartbeats are not progress.
  return digestValue({ files: sortedFiles(), verifications: [...verifications].sort(([left], [right]) => left.localeCompare(right)) });
}

function isSettledNativeTimeout(view, initial, runId, code) {
  const receipt = view?.receipt;
  const registeredAt = Date.parse(receipt?.registeredAt);
  const modelStartedAt = Date.parse(receipt?.modelStartedAt);
  const finishedAt = Date.parse(receipt?.finishedAt);
  return typeof runId === "string" && view?.runId === runId && view.active === false &&
    view.mode === "active" && view.pendingCommand === null && view.stopUnconfirmed !== true &&
    receipt?.runId === runId && receipt.kind === "code-job" && receipt.taskId === initial.jobId &&
    receipt.roleId === initial.grant.requestedBy.roleId && receipt.taskRevision === initial.revision &&
    receipt.phase === "failed" && receipt.outcomeCode === code && receipt.stopConfirmed === true &&
    // A reaped timeout may retain its last "running" native label. The durable
    // terminal receipt and stop confirmation, not that label, prove settlement.
    receipt.session?.transport === "app-server" &&
    Number.isFinite(registeredAt) && Number.isFinite(modelStartedAt) && Number.isFinite(finishedAt) &&
    registeredAt >= Date.parse(initial.updatedAt) && registeredAt <= modelStartedAt && modelStartedAt <= finishedAt;
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

function sameSessionTransitionFence(expected, current) {
  return current !== null &&
    current.status === expected.status &&
    current.revision === expected.revision &&
    current.execution.workspaceRevision ===
      expected.execution.workspaceRevision &&
    sameValue(
      current.execution.pendingAction,
      expected.execution.pendingAction,
    ) &&
    sameValue(
      current.execution.actionAdmission,
      expected.execution.actionAdmission,
    );
}

function inputBindingForJob(job) {
  return Object.hasOwn(job.grant, "inputBinding")
    ? job.grant.inputBinding
    : null;
}

function executionSourceForJob(job) {
  return job.grant.schemaVersion === 3
    ? job.grant.executionSource
    : undefined;
}

function executionSourceRequestForJob(job) {
  const executionSource = executionSourceForJob(job);
  return executionSource === undefined
    ? {}
    : { executionSource: structuredClone(executionSource) };
}

function assertJobSessionInputBinding(job, session) {
  const expectedProfiles = job.grant.requiredProfiles.map(({ id }) => id).sort();
  const actualProfiles = Array.isArray(session?.requiredProfiles)
    ? [...session.requiredProfiles].sort()
    : [];
  if (
    session?.id !== job.jobId ||
    session.workspaceId !== job.grant.workspaceId ||
    !sameValue(session.requestedBy, job.grant.requestedBy) ||
    !sameValue(actualProfiles, expectedProfiles) ||
    !Object.hasOwn(session, "inputBinding") ||
    !sameValue(session.inputBinding, inputBindingForJob(job)) ||
    (Object.hasOwn(session, "executionSource") !==
      (executionSourceForJob(job) !== undefined)) ||
    (executionSourceForJob(job) !== undefined &&
      !sameValue(session.executionSource, executionSourceForJob(job)))
  ) {
    throw workerError(
      "CODE_JOB_SESSION_BINDING_INVALID",
      "Controlled executor session input does not match the sealed code job",
    );
  }
  return session;
}

function assertJobSessionBinding(job, session) {
  assertJobSessionInputBinding(job, session);
  return assertSessionBinding(job, session);
}

function currentJobOutcome(jobId, current) {
  return {
    jobId,
    status: current?.status ?? "missing",
    actionType: current?.execution.pendingAction?.action.type ?? null,
  };
}

function isCurrentAuditedRead(job, observation) {
  return observation.actionType === "read_text" && observation.status === "succeeded" &&
    observation.workspaceRevision === job.execution.workspaceRevision;
}

function sessionTransitionLease(operationQueue = new OperationQueue()) {
  return Object.freeze({
    run(operation) {
      return operationQueue.enqueue(operation);
    },
  });
}

function cancellationSettlement(job, response) {
  const proof = response?.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw workerError(
      "CODE_JOB_CANCELLATION_PROOF_INVALID",
      "Controlled executor did not return a cancellation proof",
    );
  }
  const { proofDigest, ...proofContent } = proof;
  if (response.session !== null && response.session !== undefined) {
    assertJobSessionInputBinding(job, response.session);
  }
  const pending = job.execution.pendingAction;
  const resolution = proof.actionResolution;
  const commonInvalid =
    response.status !== "settled" ||
    proof.schemaVersion !== 1 ||
    proof.sessionId !== job.jobId ||
    proof.cancellationDigest !== job.execution.result?.detailDigest ||
    proof.sandboxCleanupConfirmed !== true ||
    digestValue(proofContent) !== proofDigest ||
    (pending === null) !== (resolution === null) ||
    (pending !== null &&
      (resolution.actionId !== pending.actionId ||
        resolution.actionDigest !== pending.actionDigest ||
        resolution.workspaceRevisionBefore !==
          pending.action.expectedWorkspaceRevision));
  if (commonInvalid) {
    throw workerError(
      "CODE_JOB_CANCELLATION_PROOF_INVALID",
      "Cancellation proof does not match the durable code job",
    );
  }
  if (proof.kind === "controlled_execution_absent") {
    if (
      response.session !== null ||
      job.execution.workspaceRevision !== null ||
      pending !== null ||
      job.execution.actionAdmission !== null ||
      proof.sourceRevision !== null ||
      proof.trustedWorkspaceRevision !== null ||
      !Array.isArray(proof.discardedAttempts) ||
      proof.discardedAttempts.length !== 0
    ) {
      throw workerError(
        "CODE_JOB_CANCELLATION_PROOF_INVALID",
        "Missing-session proof does not match the durable code job",
      );
    }
    return proof;
  }
  const session = response.session;
  const expectedProfiles = job.grant.requiredProfiles.map(({ id }) => id).sort();
  const actualProfiles = Array.isArray(session?.requiredProfiles)
    ? [...session.requiredProfiles].sort()
    : [];
  if (
    proof.kind !== "controlled_execution_cancelled" ||
    session?.id !== job.jobId ||
    session.workspaceId !== job.grant.workspaceId ||
    !sameValue(session.requestedBy, job.grant.requestedBy) ||
    !sameValue(actualProfiles, expectedProfiles) ||
    session.status !== "cancelled" ||
    session.cleanupPending !== false ||
    session.workspaceRevision !== proof.trustedWorkspaceRevision ||
    session.updatedAt !== proof.settledAt ||
    !Array.isArray(proof.discardedAttempts) ||
    proof.discardedAttempts.length < 1 ||
    session.attempt?.number !== proof.discardedAttempts.at(-1)?.attemptNumber ||
    session.attempt?.status !== "cancelled"
  ) {
    throw workerError(
      "CODE_JOB_CANCELLATION_PROOF_INVALID",
      "Settled executor session does not match its cancellation proof",
    );
  }
  return proof;
}

export class CodeJobWorkerService {
  #jobs;
  #executor;
  #brain;
  #taskRuns;
  #reviewRepairContextReader;
  #verifyGrant;
  #actionAdmission;
  #queue;
  #sessionTransitions;
  #maxTurns;
  #concurrency;
  #observationLimit;
  #changePackageDeliveryEnabled;
  #runnableCursor;
  #reconcilableCursor;
  #preferReconcilable;
  #cancellationControllers;
  #continuousControllers;
  #cycleSignal = null;
  #recordTimeoutContinuation;
  #clock;
  #maintenanceRetryNotBefore = new Map();
  #conflictSourceReader;
  #managedExecutions = new Map();
  #managedWorkers = new Map();
  #preparationRecoveryCursor = 0;
  #unstartedWriteRecovery;

  constructor({
    jobStore,
    executor,
    brainDirectory,
    taskRuns = null,
    reviewRepairContextReader,
    conflictSourceReader,
    unstartedWriteRecovery = null,
    grantVerifier,
    actionAdmissionGate = DIRECT_ACTION_ADMISSION,
    operationQueue = new OperationQueue(),
    sessionTransitionLease: suppliedSessionTransitionLease =
      sessionTransitionLease(),
    maxTurns = 64,
    concurrency = 1,
    observationLimit = 20,
    changePackageDeliveryEnabled = false,
    clock = () => new Date(),
  } = {}) {
    this.#jobs = requirePort(
      jobStore,
      [
        "listRunnable",
        "listReconcilable",
        "getForWorker",
        "claimStarting",
        "activate",
        "acknowledgeAbsentSession",
        "acknowledgeStartedSession",
        "prepareAction",
        "admitAction",
        "acknowledgeAbsentAction",
        "markActionUnknown",
        "recordObservation",
        "finalizeCancellation",
        "pause",
        "complete",
        "fail",
        "fence",
      ],
      "code job worker store",
    );
    this.#executor = requirePort(
      executor,
      [
        "start",
        "view",
        "resume",
        "perform",
        "getActionResult",
        "reconcileAction",
        "reconcileCancellation",
      ],
      "controlled code executor",
    );
    this.#brain = requirePort(brainDirectory,
      typeof brainDirectory?.describe === "function" ? ["decide", "describe"] : ["decide"],
      "code job brain");
    this.#taskRuns = taskRuns;
    this.#unstartedWriteRecovery = unstartedWriteRecovery === null ? null :
      requirePort(unstartedWriteRecovery, ['canRecover'], 'unstarted write recovery');
    this.#recordTimeoutContinuation = typeof jobStore?.recordTimeoutContinuation === "function"
      ? jobStore.recordTimeoutContinuation.bind(jobStore) : null;
    if (typeof clock !== "function") throw new TypeError("code job worker clock is invalid");
    this.#clock = clock;
    this.#reviewRepairContextReader = reviewRepairContextReader === undefined
      ? null : requirePort(reviewRepairContextReader, ["read"], "review repair context reader");
    this.#conflictSourceReader = conflictSourceReader == null ? null : requirePort(conflictSourceReader, ["read"], "conflict source reader");
    this.#verifyGrant = requirePort(
      grantVerifier,
      ["verify"],
      "code job grant verifier",
    ).verify;
    this.#actionAdmission = requirePort(
      actionAdmissionGate,
      ["run"],
      "code job action admission gate",
    ).run;
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("code job worker queue is invalid");
    }
    if (typeof changePackageDeliveryEnabled !== "boolean") {
      throw new TypeError("changePackageDeliveryEnabled must be a boolean");
    }
    this.#queue = operationQueue;
    this.#sessionTransitions = requirePort(
      suppliedSessionTransitionLease,
      ["run"],
      "code job session transition lease",
    );
    this.#maxTurns = positiveInteger(maxTurns, "maxTurns", 128);
    this.#concurrency = positiveInteger(concurrency, "concurrency", 8);
    this.#observationLimit = positiveInteger(
      observationLimit,
      "observationLimit",
      100,
    );
    this.#changePackageDeliveryEnabled = changePackageDeliveryEnabled;
    this.#runnableCursor = 0;
    this.#reconcilableCursor = 0;
    this.#preferReconcilable = true;
    this.#cancellationControllers = new Map();
    this.#continuousControllers = new Map();
    Object.freeze(this);
  }

  runCycle(value = {}) {
    const options = normalizeCycleOptions(value);
    return this.#queue.enqueue(async () => {
      options.signal?.throwIfAborted();
      if (this.#managedExecutions.size > 0) return { selected: 0, processed: 0, succeeded: 0,
        cancelled: 0, fenced: 0, failed: 0, outcomes: [], skipped: 'managed_jobs_active' };
      this.#cycleSignal = options.signal;
      const onAbort = () => {
        for (const controller of [...this.#cancellationControllers.values(), ...this.#continuousControllers.values()]) {
          controller.abort(options.signal.reason);
        }
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try { return await this.#runCycle(options); }
      finally {
        options.signal?.removeEventListener("abort", onAbort);
        this.#cycleSignal = null;
      }
    });
  }

  requestCancellation(jobId) {
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new TypeError("code job id is invalid");
    }
    const controller = this.#cancellationControllers.get(jobId);
    const continuous = this.#continuousControllers.get(jobId);
    const managed = this.#managedExecutions.get(jobId)?.worker.requestCancellation(jobId) ?? false;
    controller?.abort();
    continuous?.abort();
    return managed || controller !== undefined || continuous !== undefined;
  }

  runReady(value, runOperation) {
    const options = normalizeCycleOptions(value);
    if (typeof runOperation !== 'function') throw new TypeError('managed code execution requires an operation owner');
    return this.#queue.enqueue(async () => {
      options.signal?.throwIfAborted();
      const idle = [...this.#managedWorkers].filter(([id]) => !this.#managedExecutions.has(id)).slice(0, options.limit);
      for (const [id, worker] of idle) {
        const job = await this.#jobs.getForWorker(id);
        this.#managedWorkers.delete(id);
        if (job && (RUNNABLE_STATUSES.has(job.status) || job.status === 'unknown')) this.#managedWorkers.set(id, worker);
      }
      const preparationRecovery = await this.#settleFailedPreparations(options);
      const capacity = Math.min(options.limit, this.#concurrency - this.#managedExecutions.size);
      if (capacity <= 0) return { selected: 0, scheduled: 0, active: this.#managedExecutions.size, preparationRecovery };
      const selected = await this.#selectCycle(options, capacity, new Set(this.#managedExecutions.keys()));
      let scheduled = 0;
      for (const job of selected.items) {
        options.signal?.throwIfAborted();
        let worker = this.#managedWorkers.get(job.jobId);
        if (!worker) {
          worker = this.#createManagedWorker(job.jobId);
          this.#managedWorkers.set(job.jobId, worker);
        }
        const record = { worker, promise: null };
        this.#managedExecutions.set(job.jobId, record);
        try {
          record.promise = Promise.resolve(runOperation(() => worker.runCycle({ ...options, limit: 1 })))
            .then(result => {
              const status = result?.outcomes?.[0]?.status;
              if (!status || TERMINAL_STATUSES.has(status) || status === 'paused') this.#managedWorkers.delete(job.jobId);
              return result;
            }, error => { this.#managedWorkers.delete(job.jobId); throw error; })
            .finally(() => { if (this.#managedExecutions.get(job.jobId) === record) this.#managedExecutions.delete(job.jobId); });
          // The supplied runtime/server owner retains and observes the whole
          // operation. This observer only prevents an unhandled bookkeeping tail.
          record.promise.catch(() => {});
          scheduled += 1;
        } catch (error) {
          this.#managedExecutions.delete(job.jobId);
          this.#managedWorkers.delete(job.jobId);
          throw error;
        }
      }
      return { selected: selected.items.length, scheduled, active: this.#managedExecutions.size, preparationRecovery };
    });
  }

  async #settleFailedPreparations(options) {
    const page = await this.#jobs.listRunnable({ limit: options.limit, afterSequence: this.#preparationRecoveryCursor,
      ...(options.roleId === null ? {} : { roleId: options.roleId }) });
    this.#preparationRecoveryCursor = page.items.at(-1)?.sequence ?? 0;
    const result = { scanned: page.items.length, failed: 0, outcomes: [] };
    const ownerAllows = async jobId => {
      if (!this.#taskRuns?.get) return true;
      let run;
      try { run = await this.#taskRuns.get('code-job', jobId); }
      catch (error) { if (error?.code !== 'TASK_RUN_NOT_FOUND') throw error; }
      return !run || (run.active === false && run.mode === 'active' && run.pendingCommand === null && run.stopUnconfirmed !== true);
    };
    // Terminal executor preparation is host bookkeeping, not another model
    // execution. It must not wait behind occupied managed decision lanes.
    for (const job of page.items) {
      options.signal?.throwIfAborted();
      if (job.status !== 'starting' || job.execution.pendingAction !== null || job.execution.actionAdmission !== null ||
          job.execution.uncertainty !== null || this.#managedExecutions.has(job.jobId)) continue;
      try {
        if (!await ownerAllows(job.jobId)) continue;
        const session = await this.#viewOptionalSession(job.jobId);
        if (session?.status !== 'failed') continue;
        assertJobSessionInputBinding(job, session);
        await this.#verifyAuthority(job.grant);
        const current = await this.#jobs.getForWorker(job.jobId);
        if (current?.status !== 'starting' || current.revision !== job.revision || !await ownerAllows(job.jobId)) continue;
        options.signal?.throwIfAborted();
        const code = safeErrorCode(session.error);
        await this.#jobs.fail({ jobId: job.jobId, expectedRevision: job.revision,
          result: { schemaVersion: 1, code, message: cleanText(session.error?.message ?? 'Code job preparation failed', 2_048) } });
        this.#managedWorkers.delete(job.jobId);
        result.failed++;
        result.outcomes.push({ jobId: job.jobId, status: 'failed', code });
      } catch (error) {
        options.signal?.throwIfAborted();
        result.outcomes.push({ jobId: job.jobId, status: 'waiting', code: safeErrorCode(error) });
      }
    }
    return result;
  }

  #createManagedWorker(jobId) {
    const page = async (query, reconcilable) => {
      const job = await this.#jobs.getForWorker(jobId);
      const matches = job && (query.roleId === undefined || job.grant.requestedBy.roleId === query.roleId) &&
        (reconcilable ? job.status === 'unknown' : RUNNABLE_STATUSES.has(job.status));
      return { revision: job?.revision ?? 0, items: matches ? [job] : [] };
    };
    return new CodeJobWorkerService({
      jobStore: { ...this.#jobs, listRunnable: query => page(query, false), listReconcilable: query => page(query, true),
        ...(this.#recordTimeoutContinuation === null ? {} : { recordTimeoutContinuation: this.#recordTimeoutContinuation }) },
      executor: this.#executor, brainDirectory: this.#brain, taskRuns: this.#taskRuns,
      unstartedWriteRecovery: this.#unstartedWriteRecovery,
      ...(this.#reviewRepairContextReader === null ? {} : { reviewRepairContextReader: this.#reviewRepairContextReader }),
      ...(this.#conflictSourceReader === null ? {} : { conflictSourceReader: this.#conflictSourceReader }),
      grantVerifier: { verify: this.#verifyGrant }, actionAdmissionGate: { run: this.#actionAdmission },
      sessionTransitionLease: this.#sessionTransitions, maxTurns: this.#maxTurns, observationLimit: this.#observationLimit,
      changePackageDeliveryEnabled: this.#changePackageDeliveryEnabled, clock: this.#clock,
    });
  }

  async #selectCycle(options, maximum = options.limit, excluded = new Set()) {
    const now = new Date(this.#clock()).getTime();
    if (!Number.isFinite(now)) throw workerError("CODE_JOB_CLOCK_INVALID", "Code job worker clock is invalid");
    for (const [jobId, notBefore] of this.#maintenanceRetryNotBefore) {
      if (notBefore <= now) this.#maintenanceRetryNotBefore.delete(jobId);
    }
    const query = {
      limit: Math.min(100, options.limit + excluded.size),
      ...(options.roleId === null ? {} : { roleId: options.roleId }),
    };
    const reconcilable = await this.#jobs.listReconcilable({
      ...query,
      afterSequence: this.#reconcilableCursor,
    });
    const runnablePage = await this.#jobs.listRunnable({
      ...query,
      afterSequence: this.#runnableCursor,
    });
    const available = runnablePage.items.filter(job => !excluded.has(job.jobId));
    const runnable = this.#taskRuns ? {...runnablePage,items:await this.#taskRuns.order(available,'code-job','jobId')} : { ...runnablePage, items: available };
    const selection = selectCycleCandidates(
      reconcilable.items.filter(job => !excluded.has(job.jobId)),
      runnable.items,
      maximum,
      this.#preferReconcilable,
    );
    this.#preferReconcilable = selection.preferReconcilable;
    const selected = { items: selection.selected };
    const lastReconcilable = selected.items.findLast(
      ({ status }) => status === "unknown",
    );
    const lastRunnable = selected.items.findLast(
      ({ status }) => status !== "unknown",
    );
    if (lastReconcilable) this.#reconcilableCursor = lastReconcilable.sequence;
    if (lastRunnable) this.#runnableCursor = lastRunnable.sequence;
    return selected;
  }

  async #runCycle(options) {
    const selected = await this.#selectCycle(options);
    const processSelected = async selectedJob => {
      options.signal?.throwIfAborted();
      if (["queued", "starting", "active"].includes(selectedJob.status) && this.#maintenanceRetryNotBefore.has(selectedJob.jobId)) {
        return { jobId: selectedJob.jobId, status: "retry", actionType: null, code: "CODE_JOB_MAINTENANCE_BACKOFF" };
      }
      try {
        return await this.#process(selectedJob.jobId);
      } catch (error) {
        options.signal?.throwIfAborted();
        return this.#handleFailure(selectedJob.jobId, error);
      }
    };
    const outcomes = new Array(selected.items.length);
    let nextIndex = 0, failed = false;
    const consume = async () => {
      try {
        while (!failed && nextIndex < selected.items.length) {
          const index = nextIndex++;
          outcomes[index] = await processSelected(selected.items[index]);
        }
      } catch (error) { failed = true; throw error; }
    };
    // Keep ownership of every admitted job until it settles, including late
    // cancellation. A rejected lane must not release the cycle's shared signal.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(this.#concurrency, selected.items.length) }, consume));
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return {
      selected: selected.items.length,
      processed: outcomes.length,
      succeeded: outcomes.filter(({ status }) => status === "completed").length,
      cancelled: outcomes.filter(({ status }) => status === "cancelled").length,
      fenced: outcomes.filter(({ status }) => status === "fenced").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      outcomes,
    };
  }

  async #process(jobId) {
    let job = await this.#requireRunnableJob(jobId);
    if (job.status === "unknown") {
      return this.#reconcileUnknown(job);
    }
    if (job.status === "cancelling") {
      return this.#reconcileCancellation(job);
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return { jobId, status: job.status, actionType: null };
    }

    if (job.status === "queued") {
      const admitted = await this.#actionAdmission(() => ({
        // Claim the exact queued job while configuration authority is current,
        // then carry the durable write out so cutover never waits on storage.
        operation: this.#jobs.claimStarting({
          jobId,
          expectedRevision: job.revision,
        }),
      }));
      job = (await admitted.operation).job;
    }

    if (job.status === "starting") {
      await this.#verifyAuthority(job.grant);
      let session = await this.#viewOptionalSession(job.jobId);
      if (session === null) {
        await this.#verifyAuthority(job.grant);
        const started = await this.#startUnchangedSession(job);
        if (started.session === null) {
          if (
            started.job?.status === "pausing" &&
            started.job.execution.pause?.from === "starting"
          ) {
            return this.#reconcileStartingPause(started.job);
          }
          if (started.job?.status === "cancelling") {
            return this.#reconcileCancellation(started.job);
          }
          return currentJobOutcome(job.jobId, started.job);
        }
        job = started.job;
        session = started.session;
      }
      let current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status === "cancelling") {
        return this.#reconcileCancellation(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      assertJobSessionInputBinding(job, session);
      if (session.status === "interrupted") {
        await this.#verifyAuthority(job.grant);
        const resumed = await this.#resumeUnchangedSession(job);
        if (resumed.session === null) {
          return currentJobOutcome(job.jobId, resumed.job);
        }
        job = resumed.job;
        session = resumed.session;
        assertJobSessionInputBinding(job, session);
      }
      current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status === "cancelling") {
        return this.#reconcileCancellation(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      if (session.status === "failed") {
        return this.#finishFailed(job, session.error);
      }
      if (session.status !== "active") {
        throw workerError(
          "CODE_JOB_SESSION_NOT_ACTIVE",
          "Controlled executor did not activate the claimed session",
        );
      }
      assertJobSessionBinding(job, session);
      job = (await this.#jobs.activate({
        jobId,
        expectedRevision: job.revision,
        workspaceRevision: session.workspaceRevision,
      })).job;
    }

    if (job.status === "pausing") {
      if (job.execution.pause?.from === "starting") {
        return this.#reconcileStartingPause(job);
      }
      if (job.execution.pendingAction === null) {
        throw workerError(
          "CODE_JOB_PENDING_ACTION_MISSING",
          "Pausing code job lost its admitted action",
        );
      }
      return this.#continuePending(job);
    }
    if (job.status !== "active") {
      return { jobId, status: job.status, actionType: null };
    }
    if (job.execution.pendingAction !== null) {
      return this.#continuePending(job);
    }

    const durableObservation = job.execution.observations.at(-1);
    if (
      durableObservation?.actionType === "complete" &&
      durableObservation.status === "succeeded"
    ) {
      return this.#completeObservedJob(job, durableObservation);
    }
    const failedVerification = verificationFailure(job);
    if (failedVerification !== null) {
      return this.#finishFailed(job, failedVerification);
    }
    if (job.execution.timeoutContinuation !== undefined) {
      const now = new Date(this.#clock()).getTime();
      if (!Number.isFinite(now)) throw workerError("CODE_JOB_CLOCK_INVALID", "Code job worker clock is invalid");
      if (Date.parse(job.execution.timeoutContinuation.retryAfter) > now) {
        return { jobId, status: "active", actionType: null, code: "CODE_JOB_TIMEOUT_BACKOFF" };
      }
    }

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    assertJobSessionInputBinding(job, session);
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (session.status === "completed") {
      return this.#recoverCompleted(job, session);
    }
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      const resumed = await this.#resumeUnchangedSession(job);
      if (resumed.session === null) {
        return currentJobOutcome(job.jobId, resumed.job);
      }
      job = resumed.job;
      session = resumed.session;
      assertJobSessionInputBinding(job, session);
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for another action",
      );
    }
    assertJobSessionBinding(job, session);
    if (job.execution.workspaceRevision !== session.workspaceRevision) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Code job and controlled executor workspace revisions diverged",
      );
    }

    if (job.execution.turn >= this.#maxTurns) {
      return this.#finishFailed(job, {
        code: "CODE_JOB_TURN_LIMIT",
        message: "Code job reached its configured turn limit",
      });
    }

    const description = await this.#brain.describe?.(job.grant.requestedBy.roleId, job.grant.brainDigest);
    if (description?.supportsCodeExecution === true) return this.#runContinuous(job);

    const passedProfiles = successfulProfiles(job, session);
    const remainingProfiles = job.grant.requiredProfiles.filter(
      ({ id }) => !passedProfiles.has(id),
    );
    await this.#verifyAuthority(job.grant);
    const brainContext = this.#brainContext(job, remainingProfiles);
    const codeReadContext = await this.#codeReadContext(job);
    const reviewRepairFeedback = await this.#readReviewRepairFeedback(job);
    const ciRepairEvidence = executionSourceForJob(job)?.kind === 'ci_repair' ? normalizeCiRepairEvidence(executionSourceForJob(job).ciEvidence) : null;
    const sessionKey = Number.isSafeInteger(job.grant.subject?.number) &&
        job.grant.subject.number > 0
      ? githubEntitySessionKey({
          kind: job.grant.inputBinding === null ? "issue" : "pull_request",
          repository: job.grant.repository,
          number: job.grant.subject.number,
        })
      : null;
    const decide = ({instructions} = {}) => this.#brain.decide(
      {
        roleId: job.grant.requestedBy.roleId,
        ...(sessionKey === null ? {} : { sessionKey }),
        ...brainContext,
        ...(codeReadContext === null ? {} : { codeReadContext }),
        ...(instructions === undefined ? {} : {instructions}),
        ...(reviewRepairFeedback === null ? {} : { reviewRepairFeedback }),
        ...(ciRepairEvidence === null ? {} : { ciRepairEvidence }),
      },
      {
        beforeGenerate: () => this.#verifyAuthority(job.grant),
        brainDigest: job.grant.brainDigest,
        ...(this.#cycleSignal === null ? {} : { signal: this.#cycleSignal }),
      },
    );
    const decision = this.#taskRuns ? await this.#taskRuns.run({kind:'code-job',taskId:job.jobId,
      roleId:job.grant.requestedBy.roleId,title:job.grant.objective,
      subject:job.grant.repository,revision:job.revision},decide) : await decide();
    this.#cycleSignal?.throwIfAborted();
    if (reviewRepairFeedback !== null) {
      const currentFeedback = await this.#readReviewRepairFeedback(job);
      if (currentFeedback.reviewFeedbackDigest !== reviewRepairFeedback.reviewFeedbackDigest) throw workerError("CODE_REVIEW_REPAIR_CONTEXT_STALE", "Review feedback changed while the code brain was deciding");
    }
    const action = bindTrustedAction(
      job,
      session,
      decision.action,
      remainingProfiles,
      brainContext.observations,
      codeReadContext,
    );
    await this.#verifyAuthority(job.grant);
    job = (await this.#jobs.prepareAction({
      jobId,
      expectedRevision: job.revision,
      action,
      ...completionReportForAction(action, decision.action),
    })).job;
    await this.#verifyAuthority(job.grant);
    return this.#performPending(job, session);
  }

  #brainContext(job, remainingProfiles) {
    return packCodeJobBrainContext({
      task: {
        operation: job.grant.operation,
        repository: job.grant.repository,
        objective: job.grant.objective,
        acceptanceCriteria: job.grant.acceptanceCriteria,
        evidence: job.grant.evidence,
      },
      capabilities: {
        allowedActions: job.grant.allowedActions,
        writablePaths: job.grant.writablePaths,
        requiredProfilesRemaining: remainingProfiles.length,
      },
      turn: job.execution.turn + 1,
      observations: job.execution.observations
        .slice(-this.#observationLimit)
        .map(modelObservation),
    });
  }

  async #codeReadContext(job, { onlyPath = null } = {}) {
    if ((await this.#brain.describe?.(job.grant.requestedBy.roleId, job.grant.brainDigest))?.supportsCodeReading !== true) {
      return null;
    }
    const latest = new Map();
    for (let index = job.execution.observations.length - 1; index >= 0; index -= 1) {
      const observation = job.execution.observations[index];
      if (!isCurrentAuditedRead(job, observation)) continue;
      const action = trustedObservationAction(observation);
      if (onlyPath !== null && action.path !== onlyPath) continue;
      if (!latest.has(action.path)) latest.set(action.path, { action, observation });
    }
    const documents = await Promise.all([...latest.values()].map(async ({ action, observation }) => {
      const audited = await this.#executor.getActionResult({ sessionId: job.jobId, actionId: action.actionId });
      const result = audited?.result;
      const bytes = typeof result?.content === "string" ? Buffer.from(result.content, "utf8") : null;
      const currentRevision = job.execution.workspaceRevision;
      if (
        action.expectedWorkspaceRevision !== currentRevision ||
        audited?.action?.id !== action.actionId || audited.action.type !== "read_text" ||
        audited.action.status !== "succeeded" || audited.action.error != null ||
        audited.action.workspaceRevisionBefore !== currentRevision ||
        audited.action.workspaceRevisionAfter !== currentRevision ||
        audited.action.attemptNumber !== observation.detail?.executor?.actionAttemptNumber ||
        result?.path !== action.path || bytes === null ||
        result.content !== bytes.toString("utf8") || result.bytes !== bytes.length ||
        result.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
        result.truncated === true || result.error != null ||
        !sameValue(observationDetail(action, {
          session: { status: observation.detail?.executor?.sessionStatus,
            attempt: { number: observation.detail?.executor?.sessionAttemptNumber } },
          action: audited.action,
        }, result).result, observation.detail?.result)
      ) {
        throw workerError("CODE_JOB_AUDIT_RESULT_INVALID", "Audited text does not match its current workspace read observation");
      }
      return { actionId: action.actionId, path: action.path, sha256: result.sha256,
        bytes: result.bytes, content: result.content };
    }));
    return createCodeReadContext({ jobId: job.jobId,
      workspaceRevision: job.execution.workspaceRevision, documents });
  }

  async #continuousSnapshot(jobId) {
    currentTaskExecution()?.assertRunning?.();
    const job = await this.#jobs.getForWorker(jobId);
    if (job?.status !== "active" || job.execution.pendingAction !== null) {
      throw workerError("CODE_JOB_SESSION_BUSY", "Continuous code job is not ready for another action");
    }
    await this.#verifyAuthority(job.grant);
    const session = await this.#executor.view({ sessionId: jobId });
    assertJobSessionBinding(job, session);
    if (session.status !== "active" || session.workspaceRevision !== job.execution.workspaceRevision) {
      throw workerError("CODE_JOB_WORKSPACE_DIVERGED", "Continuous job no longer matches the active executor workspace");
    }
    const passed = successfulProfiles(job, session);
    const remainingProfiles = job.grant.requiredProfiles.filter(({ id }) => !passed.has(id));
    return { job, session, remainingProfiles, context: this.#brainContext(job, remainingProfiles) };
  }

  async #continuousAction(snapshot, decision, codeReadContext, signal) {
    const { job, session, remainingProfiles, context } = snapshot;
    currentTaskExecution()?.assertRunning?.();
    signal?.throwIfAborted();
    if (job.execution.turn >= this.#maxTurns) {
      return this.#finishFailed(job, { code: "CODE_JOB_TURN_LIMIT", message: "Code job reached its configured action limit" });
    }
    const action = bindTrustedAction(job, session, decision.action, remainingProfiles, context.observations, codeReadContext);
    await this.#verifyAuthority(job.grant);
    currentTaskExecution()?.assertRunning?.();
    const prepared = (await this.#jobs.prepareAction({ jobId: job.jobId, expectedRevision: job.revision, action,
      ...completionReportForAction(action, decision.action) })).job;
    currentTaskExecution()?.reportProgress(`正在执行受控动作：${action.type}`);
    currentTaskExecution()?.reportEvent?.({ type: "tool", text: `${action.type}${action.path ? ` · ${action.path}` : ""}`, itemId: action.actionId });
    return this.#executePending(prepared, session, { continuous: true, signal });
  }

  async #runContinuous(initial) {
    let previousRun = null;
    if (this.#taskRuns?.get) {
      try { previousRun = await this.#taskRuns.get("code-job", initial.jobId); }
      catch (error) { if (error?.code !== "TASK_RUN_NOT_FOUND") throw error; }
    }
    const protocolRecoveryCode = codeProtocolRecoveryFor(initial, previousRun);
    const controller = new AbortController();
    const reads = new Map();
    let lastSourceReadIdentity = null;
    let workspaceRevision = initial.execution.workspaceRevision;
    let fatal = null;
    let invocationRunId = null;
    let conflictReads = null;
    const feedback = await this.#readReviewRepairFeedback(initial);
    const closeReads = () => {
      for (const { reader } of reads.values()) { reader.revoke(); reader.close(); }
      reads.clear();
    };
    const snapshot = async () => {
      controller.signal.throwIfAborted();
      if (fatal) throw fatal;
      const state = await this.#continuousSnapshot(initial.jobId);
      if (workspaceRevision !== state.job.execution.workspaceRevision) {
        closeReads(); workspaceRevision = state.job.execution.workspaceRevision;
      }
      return state;
    };
    const readActiveJob = async (signal) => {
      currentTaskExecution()?.assertRunning?.();
      controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (fatal) throw fatal;
      const job = await this.#jobs.getForWorker(initial.jobId);
      if (job?.status !== "active" || job.execution.pendingAction !== null || !sameValue(job.grant, initial.grant)) {
        throw workerError("CODE_JOB_SESSION_BUSY", "Source read job is no longer active");
      }
      if (workspaceRevision !== job.execution.workspaceRevision) {
        closeReads(); workspaceRevision = job.execution.workspaceRevision;
      }
      return job;
    };
    const readSourcePage = (entry, sourcePath, offset, length) => {
      const page = entry.reader.readDocument(sourcePath, offset, length);
      entry.reader.commit();
      lastSourceReadIdentity = { path: page.path, sha256: entry.sha256, totalLength: page.totalLength };
      return { ...page, sourceVersion: entry.actionId };
    };
    const latestRead = (job, sourcePath) => job.execution.observations.findLast((entry) =>
      isCurrentAuditedRead(job, entry) && trustedObservationAction(entry).path === sourcePath);
    const currentReads = (job) => {
      const latest = new Map();
      for (const entry of job.execution.observations) {
        if (isCurrentAuditedRead(job, entry)) {
          latest.set(trustedObservationAction(entry).path, entry);
        }
      }
      return latest;
    };
    const assertFeedback = async () => {
      if (feedback !== null && (await this.#readReviewRepairFeedback(initial)).reviewFeedbackDigest !== feedback.reviewFeedbackDigest) {
        throw workerError("CODE_REVIEW_REPAIR_CONTEXT_STALE", "Review feedback changed during continuous execution");
      }
    };
    let capability;
    const perform = async (decision, state, { signal } = {}) => {
      let readContext;
      if (decision.action.type === "write_text") {
        const entry = reads.get(decision.action.path);
        if (entry) { entry.reader.assertComplete(); entry.reader.commit(); readContext = entry.context; }
        else readContext = await this.#codeReadContext(state.job, { onlyPath: decision.action.path });
      }
      await assertFeedback();
      try {
        await this.#continuousAction(state, decision, readContext, signal);
        const current = await this.#jobs.getForWorker(initial.jobId);
        if (current?.execution.workspaceRevision !== workspaceRevision) {
          closeReads(); workspaceRevision = current?.execution.workspaceRevision;
        }
        // A failed profile or non-active result cannot authorize later actions.
        if (current?.status !== "active") revokeCodeExecutionContext(capability);
      } catch (error) {
        const current = await this.#jobs.getForWorker(initial.jobId);
        if (current?.execution.pendingAction !== null || isAuthorityErrorCode(error.code) || isFencingExecutorCode(error.code)) {
          fatal = error;
          revokeCodeExecutionContext(capability);
          await this.#handleFailure(initial.jobId, error);
        }
        throw error;
      }
    };
    const getState = async () => {
      const state = await snapshot();
      return { status: state.job.status, turn: state.job.execution.turn, remainingActions: Math.max(0, this.#maxTurns - state.job.execution.turn),
        capabilities: state.context.capabilities, observation: state.context.observations.at(-1) ?? null,
        sources: [...currentReads(state.job)].map(([sourcePath, observation]) => ({ path: sourcePath, sourceVersion: observation.actionId,
          fullyRead: hasCompleteCodeRead(reads.get(sourcePath)?.context, { jobId: state.job.jobId, workspaceRevision,
            actionId: observation.actionId, path: sourcePath, sha256: observation.detail?.result?.sha256 }) })) };
    };
    capability = createCodeExecutionContext({
      sourceReadIdentity: () => lastSourceReadIdentity,
      getState,
      readConflictSource: async ({ path: sourcePath, version, offset, length, sourceVersion }, options) => {
        await readActiveJob(options?.signal);
        if (!this.#conflictSourceReader || initial.grant.executionSource?.kind !== "conflict_preparation") {
          throw workerError("CODE_READ_DOCUMENT_NOT_FOUND", "No sealed conflict versions are available");
        }
        const expectedVersion = initial.grant.executionSource.preparationBinding.preparationId;
        if ((sourceVersion !== undefined && sourceVersion !== expectedVersion) || (offset !== 0 && sourceVersion !== expectedVersion)) {
          throw workerError("CODE_READ_REVISION_INVALID", "Conflict pages require their sealed preparation version");
        }
        conflictReads ??= await this.#openConflictReads(initial, options);
        // The reader owns an immutable, verified reference copy. Page reads
        // cannot authorize writes; actions and completion use fresh snapshots.
        await readActiveJob(options?.signal);
        const key = `conflict-versions/${version}/${sourcePath}`;
        const document = conflictReads.documents.get(key);
        if (!document) throw workerError("CODE_READ_DOCUMENT_NOT_FOUND", "Path/version is outside the sealed conflicts");
        const page = conflictReads.reader.readDocument(key, offset, length);
        conflictReads.requested.add(key);
        lastSourceReadIdentity = { path: key, sha256: document.sha256, totalLength: page.totalLength };
        return { ...page, sourcePath, version, sourceVersion: expectedVersion };
      },
      editSource: async (value, options) => {
        const request = normalizeCodeSourceEdits(value);
        const state = await snapshot();
        const entry = reads.get(request.path);
        if (!entry || entry.actionId !== request.sourceVersion || latestRead(state.job, request.path)?.actionId !== entry.actionId) {
          throw workerError("CODE_READ_REVISION_INVALID", "Edits require the current audited source version");
        }
        entry.reader.assertComplete();
        const parts = [];
        let page;
        do {
          page = entry.reader.readDocument(request.path, page?.nextOffset ?? 0);
          parts.push(page.text);
        } while (page.nextOffset !== null);
        const content = applyCodeSourceEdits(parts.join(""), request.edits);
        // Host composition reuses the audited SHA, sealed write scope, action
        // budget and executor limits of a normal write_text action.
        await perform({ action: { type: "write_text", path: request.path, content } }, state, options);
        return getState();
      },
      progressFingerprint: async () => {
        const current = await this.#jobs.getForWorker(initial.jobId);
        if (current === null) throw workerError("CODE_JOB_NOT_FOUND", "Continuous code job no longer exists");
        return semanticProgressFingerprint(current);
      },
      performAction: async ({ decision: rawDecision }, options) => {
        const decision = normalizeStructuredCodeActionDecision(rawDecision);
        if (decision.action.type === "complete") throw workerError("CODE_EXECUTION_COMPLETE_NOT_ALLOWED", "Complete is a final decision, not a tool action");
        await perform(decision, await snapshot(), options);
        const current = await this.#jobs.getForWorker(initial.jobId);
        return current?.status === "active" ? getState() : { status: current?.status ?? "missing" };
      },
      readSource: async ({ path: sourcePath, offset, length, sourceVersion }, options) => {
        const current = await readActiveJob(options?.signal);
        const cached = reads.get(sourcePath);
        if (cached && latestRead(current, sourcePath)?.actionId === cached.actionId) {
          if ((sourceVersion !== undefined && sourceVersion !== cached.actionId) ||
              (offset !== 0 && sourceVersion !== cached.actionId)) {
            throw workerError("CODE_READ_REVISION_INVALID", "Source pages must belong to the current audited read");
          }
          return readSourcePage(cached, sourcePath, offset, length);
        }
        let state = await snapshot();
        let entry = reads.get(sourcePath);
        const audit = latestRead(state.job, sourcePath);
        if (entry && entry.actionId !== audit?.actionId) {
          entry.reader.revoke(); entry.reader.close(); reads.delete(sourcePath); entry = null;
        }
        if ((sourceVersion !== undefined && sourceVersion !== (entry?.actionId ?? audit?.actionId)) ||
            (offset !== 0 && (!entry || sourceVersion !== entry.actionId))) {
          throw workerError("CODE_READ_REVISION_INVALID", "Source pages must belong to the current audited read");
        }
        if (!entry) {
          if (!audit) {
            await perform({ action: { type: "read_text", path: sourcePath } }, state, options);
            state = await snapshot();
          }
          const currentRead = latestRead(state.job, sourcePath);
          if (!currentRead) throw workerError("CODE_READ_DOCUMENT_NOT_FOUND", "Controlled source read did not succeed");
          const context = await this.#codeReadContext(state.job, { onlyPath: sourcePath });
          if (context === null) throw workerError("CODE_ARTIFACT_READ_INVALID", "Continuous execution requires audited source reading");
          // #codeReadContext has verified these audited bytes and SHA against
          // the executor result. Keep content identity process-private.
          entry = { context, reader: beginCodeReadSession(context, options), actionId: currentRead.actionId,
            sha256: currentRead.detail.result.sha256 };
          reads.set(sourcePath, entry);
        }
        return readSourcePage(entry, sourcePath, offset, length);
      },
      close: async () => {
        const current = await this.#jobs.getForWorker(initial.jobId);
        return { settled: Boolean(current) && current.status !== "unknown" && current.execution.actionAdmission === null };
      },
    });
    const execute = async ({ instructions } = {}) => {
      try {
        if (this.#taskRuns?.get) {
          const running = await this.#taskRuns.get("code-job", initial.jobId);
          if (running.active === true && running.kind === "code-job" && running.taskId === initial.jobId &&
              running.roleId === initial.grant.requestedBy.roleId) invocationRunId = running.runId;
        }
        const state = await snapshot();
        const subject = initial.grant.subject;
        const sessionKey = Number.isSafeInteger(subject?.number) && subject.number > 0
          ? githubEntitySessionKey({ kind: initial.grant.inputBinding === null ? "issue" : "pull_request", repository: initial.grant.repository, number: subject.number }) : null;
        const decision = await this.#brain.decide({ roleId: initial.grant.requestedBy.roleId,
          ...state.context, codeExecutionContext: capability,
          ...(protocolRecoveryCode === null ? {} : { protocolRecoveryCode }),
          ...(sessionKey === null ? {} : { sessionKey }), ...(instructions === undefined ? {} : { instructions }),
          ...(feedback === null ? {} : { reviewRepairFeedback: feedback }),
          ...(executionSourceForJob(initial)?.kind === 'ci_repair' ? { ciRepairEvidence: normalizeCiRepairEvidence(executionSourceForJob(initial).ciEvidence) } : {}) },
        { beforeGenerate: () => this.#verifyAuthority(initial.grant), brainDigest: initial.grant.brainDigest, signal: controller.signal });
        await closeCodeExecutionContext(capability);
        if (fatal) throw fatal;
        const current = await this.#jobs.getForWorker(initial.jobId);
        if (current?.status !== "active") return currentJobOutcome(initial.jobId, current);
        if (decision.action?.type !== "complete") throw workerError("CODE_BRAIN_RESPONSE_INVALID", "Continuous turn must return a final completion decision");
        const finalState = await snapshot();
        for (const [sourcePath, latest] of currentReads(finalState.job)) {
          const entry = reads.get(sourcePath);
          if (!entry || entry.actionId !== latest.actionId) throw workerError("CODE_ARTIFACT_READ_INCOMPLETE", "Current audited source was not fully read");
          entry.reader.assertComplete();
        }
        conflictReads?.reader.assertComplete([...conflictReads.requested]);
        await assertFeedback();
        const taskExecution = currentTaskExecution();
        if (taskExecution?.beginCompletion && !(await taskExecution.beginCompletion())) {
          return { jobId: initial.jobId, status: "active", actionType: null, code: "CODE_JOB_OWNER_INSTRUCTIONS_PENDING" };
        }
        return this.#continuousAction(finalState, decision, null);
      } finally {
        await closeCodeExecutionContext(capability);
        closeReads();
      }
    };
    this.#continuousControllers.set(initial.jobId, controller);
    if (this.#cycleSignal?.aborted) controller.abort(this.#cycleSignal.reason);
    try {
      return await (this.#taskRuns ? this.#taskRuns.run({ kind: "code-job", taskId: initial.jobId, roleId: initial.grant.requestedBy.roleId,
        title: initial.grant.objective, subject: initial.grant.repository, revision: initial.revision }, execute,
      { repeatOnInstruction: false, requireStopConfirmation: true }) : execute());
    } catch (error) {
      const continued = await this.#continueSettledNativeTimeout(initial, invocationRunId, error);
      if (continued !== null) return continued;
      throw error;
    } finally {
      conflictReads?.reader.revoke();
      conflictReads?.reader.close();
      if (this.#continuousControllers.get(initial.jobId) === controller) this.#continuousControllers.delete(initial.jobId);
    }
  }

  async #openConflictReads(job, options) {
    const source = job.grant.executionSource;
    const result = await this.#conflictSourceReader.read(structuredClone(source));
    if (!sameValue(result.inputBinding, job.grant.inputBinding) || !sameValue(result.preparationBinding, source.preparationBinding)) {
      throw workerError("CODE_JOB_AUDIT_RESULT_INVALID", "Conflict source binding changed");
    }
    const expected = new Set(source.preparationBinding.conflicts.flatMap(({ path }) =>
      ["ancestor", "head", "base"].map(version => `conflict-versions/${version}/${path}`)));
    const documents = new Map();
    if (!Array.isArray(result.documents) || result.documents.length !== expected.size) {
      throw workerError("CODE_JOB_AUDIT_RESULT_INVALID", "Conflict source set is incomplete");
    }
    for (const entry of result.documents) {
      const key = `conflict-versions/${entry.version}/${entry.path}`;
      if (!expected.delete(key)) throw workerError("CODE_JOB_AUDIT_RESULT_INVALID", "Unexpected conflict source");
      documents.set(key, { actionId: `conflict-read-${digestValue({ path: key, sha256: entry.sha256 })}`,
        path: key, sha256: entry.sha256, bytes: entry.bytes, content: entry.content });
    }
    const context = createCodeReadContext({ jobId: job.jobId,
      workspaceRevision: source.preparationBinding.evidenceDigest, documents: [...documents.values()] });
    return { reader: beginCodeReadSession(context, options), documents, requested: new Set() };
  }

  async #continueSettledNativeTimeout(initial, runId, error) {
    const code = safeErrorCode(error);
    if (!CONTINUABLE_NATIVE_TIMEOUTS.has(code) || !this.#recordTimeoutContinuation || !this.#taskRuns?.get) return null;
    let proof;
    try { proof = await this.#taskRuns.get("code-job", initial.jobId); } catch { return null; }
    if (!isSettledNativeTimeout(proof, initial, runId, code)) return null;
    const current = await this.#jobs.getForWorker(initial.jobId);
    if (current?.status !== "active" || current.execution.pendingAction !== null ||
        current.execution.actionAdmission !== null || current.execution.uncertainty !== null ||
        current.execution.pause !== null) return null;
    await this.#verifyAuthority(current.grant);
    const session = await this.#executor.view({ sessionId: current.jobId });
    assertJobSessionBinding(current, session);
    if (session.status !== "active" || session.cleanupPending === true ||
        session.workspaceRevision !== current.execution.workspaceRevision) {
      throw workerError("CODE_JOB_WORKSPACE_DIVERGED", "Timeout checkpoint no longer matches its active executor session");
    }
    try {
      return await this.#actionAdmission(async () => {
        const fresh = await this.#jobs.getForWorker(current.jobId);
        if (!sameSessionTransitionFence(current, fresh)) return currentJobOutcome(initial.jobId, fresh);
        await this.#verifyAuthority(fresh.grant);
        const latestProof = await this.#taskRuns.get("code-job", initial.jobId);
        if (!isSettledNativeTimeout(latestProof, initial, runId, code)) return null;
        const changed = await this.#recordTimeoutContinuation({ jobId: fresh.jobId, expectedRevision: fresh.revision,
          failedRunId: runId, errorCode: code, failedAt: latestProof.receipt.finishedAt,
          baselineProgressFingerprint: semanticProgressFingerprint(initial), progressFingerprint: semanticProgressFingerprint(fresh) });
        return { jobId: fresh.jobId, status: changed.job.status, actionType: null, code };
      });
    } catch (continuationError) {
      if (["CODE_JOB_REVISION_CONFLICT", "CODE_JOB_TRANSITION_CONFLICT"].includes(continuationError?.code)) {
        return currentJobOutcome(initial.jobId, await this.#jobs.getForWorker(initial.jobId));
      }
      throw continuationError;
    }
  }

  async #readReviewRepairFeedback(job) {
    if (executionSourceForJob(job)?.kind !== "review_repair") return null;
    if (this.#reviewRepairContextReader === null) throw workerError("CODE_REVIEW_REPAIR_CONTEXT_NOT_CONFIGURED", "Own PR repair requires the complete trusted feedback context reader");
    const context = normalizeReviewRepairFeedbackContext(await this.#reviewRepairContextReader.read({ job }));
    if (context.headRefOid !== job.grant.executionSource.inputBinding.headRefOid) throw workerError("CODE_REVIEW_REPAIR_CONTEXT_STALE", "Review feedback does not match the code job Head");
    return context;
  }

  async #reconcileStartingPause(job, knownSession = null) {
    const session = knownSession ?? await this.#viewOptionalSession(job.jobId);
    if (session === null) {
      const changed = await this.#jobs.acknowledgeAbsentSession({
        jobId: job.jobId,
        expectedRevision: job.revision,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    assertJobSessionInputBinding(job, session);
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (!["active", "interrupted"].includes(session.status)) {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Admitted session start is still being reconciled",
      );
    }
    assertJobSessionBinding(job, session);
    const changed = await this.#jobs.acknowledgeStartedSession({
      jobId: job.jobId,
      expectedRevision: job.revision,
      workspaceRevision: session.workspaceRevision,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
    };
  }

  async #reconcileCancellation(job) {
    const pending = job.execution.pendingAction;
    const response = await this.#executor.reconcileCancellation({
      sessionId: job.jobId,
      inputBinding: structuredClone(inputBindingForJob(job)),
      ...executionSourceRequestForJob(job),
      cancellationDigest: job.execution.result.detailDigest,
      expectedWorkspaceRevision: job.execution.workspaceRevision,
      expectedAction: pending === null
        ? null
        : {
            actionId: pending.actionId,
            actionDigest: pending.actionDigest,
          },
    });
    const settlement = cancellationSettlement(job, response);
    const current = await this.#jobs.getForWorker(job.jobId);
    if (
      current?.status !== "cancelling" ||
      current.execution.result?.detailDigest !==
        job.execution.result.detailDigest ||
      !sameValue(current.execution.pendingAction, pending) ||
      !sameValue(
        current.execution.actionAdmission,
        job.execution.actionAdmission,
      )
    ) {
      return currentJobOutcome(job.jobId, current);
    }
    const changed = await this.#jobs.finalizeCancellation({
      jobId: job.jobId,
      expectedRevision: current.revision,
      settlement,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
    };
  }

  async #continuePending(job) {
    let authorityError = null;
    if (job.status !== "pausing") {
      try {
        await this.#verifyAuthority(job.grant);
      } catch (error) {
        authorityError = error;
      }
    }

    if (
      authorityError !== null &&
      job.execution.actionAdmission === null
    ) {
      throw authorityError;
    }

    let reconciled;
    try {
      reconciled = await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: job.execution.pendingAction.action,
      });
    } catch (error) {
      if (authorityError && error?.code === "SESSION_NOT_FOUND") {
        throw authorityError;
      }
      throw error;
    }
    assertJobSessionInputBinding(job, reconciled.session);

    if (reconciled.status === "running") {
      throw workerError(
        "CODE_JOB_ACTION_BUSY",
        "Prepared action is still running in the controlled executor",
      );
    }
    if (reconciled.status === "terminal") {
      const outcome = await this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
      if (authorityError && outcome.status !== "completed") {
        throw authorityError;
      }
      return outcome;
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid reconciliation result",
      );
    }
    if (job.status === "pausing") {
      const admission = job.execution.actionAdmission;
      if (admission === null) {
        throw workerError(
          "CODE_JOB_ADMISSION_MISSING",
          "Reconciling code job lost its action admission",
        );
      }
      const changed = await this.#jobs.acknowledgeAbsentAction({
        jobId: job.jobId,
        expectedRevision: job.revision,
        actionId: admission.actionId,
        actionDigest: admission.actionDigest,
        epoch: admission.epoch,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    if (authorityError) throw authorityError;

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      const resumed = await this.#resumeUnchangedSession(job);
      if (resumed.session === null) {
        return currentJobOutcome(job.jobId, resumed.job);
      }
      job = resumed.job;
      session = resumed.session;
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for a prepared action",
      );
    }
    assertJobSessionBinding(job, session);
    const pending = job.execution.pendingAction;
    if (
      pending.action.type === "write_text" && pending.action.expectedSha256 !== null
    ) {
      const passed = successfulProfiles(job, session);
      const remaining = job.grant.requiredProfiles.filter(({ id }) => !passed.has(id));
      try {
        assertPreparedWriteRead(job, session, pending.action, this.#brainContext(job, remaining).observations);
      } catch (error) {
        if (error?.code !== INCOMPLETE_READ_CODE) throw error;
        const recovered = await this.#replanUnstartedWrite(job, session, error);
        if (recovered !== null) return recovered;
        throw error;
      }
    }
    return this.#performPending(job, session);
  }

  async #replanUnstartedWrite(job, session, error) {
    if (this.#unstartedWriteRecovery === null || job.status !== 'active' ||
        !pendingOverwriteRecoveryCandidate(job) || session.cleanupPending === true ||
        !await this.#unstartedWriteRecovery.canRecover(job)) return null;
    return this.#actionAdmission(async () => {
      this.#cycleSignal?.throwIfAborted();
      const fresh = await this.#jobs.getForWorker(job.jobId);
      if (!sameSessionTransitionFence(job, fresh)) return currentJobOutcome(job.jobId, fresh);
      if (!pendingOverwriteRecoveryCandidate(fresh) || !await this.#unstartedWriteRecovery.canRecover(fresh)) return null;
      await this.#verifyAuthority(fresh.grant);
      const pending = fresh.execution.pendingAction;
      const latest = await this.#executor.reconcileAction({ sessionId: fresh.jobId, action: pending.action });
      assertJobSessionBinding(fresh, latest.session);
      if (latest.status !== 'absent' || latest.session.status !== 'active' || latest.session.cleanupPending === true ||
          latest.session.workspaceRevision !== fresh.execution.workspaceRevision ||
          latest.session.attempt.number !== session.attempt.number) {
        throw workerError('CODE_JOB_ACTION_BUSY', 'Prepared write needs a fresh executor reconciliation');
      }
      this.#cycleSignal?.throwIfAborted();
      const changed = await this.#jobs.recordObservation({ jobId: fresh.jobId, expectedRevision: fresh.revision,
        actionId: pending.actionId, status: 'failed', workspaceRevision: fresh.execution.workspaceRevision,
        detail: { schemaVersion: 1, origin: 'host_pre_execution_rejection', notExecuted: true,
          result: { bytes: 0, error: { code: INCOMPLETE_READ_CODE,
            message: `宿主在执行前拒绝旧写入，工作区未修改。${cleanText(error.message, 1_536)}` } } } });
      return { jobId: fresh.jobId, status: changed.job.status, actionType: 'write_text', code: INCOMPLETE_READ_CODE };
    });
  }

  async #reconcileUnknown(job) {
    const pending = job.execution.pendingAction;
    const admission = job.execution.actionAdmission;
    if (pending === null || admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    const reconciled = await this.#executor.reconcileAction({
      sessionId: job.jobId,
      action: pending.action,
    });
    assertJobSessionInputBinding(job, reconciled.session);
    if (reconciled.status === "running") {
      return {
        jobId: job.jobId,
        status: "unknown",
        actionType: pending.action.type,
      };
    }
    if (reconciled.status === "terminal") {
      if (reconciled.action?.status === "interrupted") {
        const interrupted = normalizeActionResponse(pending, reconciled);
        assertJobSessionBinding(job, interrupted.session);
        if (
          interrupted.action.workspaceRevisionAfter !== null ||
          interrupted.session.workspaceRevision !==
            job.execution.workspaceRevision
        ) {
          throw workerError(
            "CODE_JOB_WORKSPACE_DIVERGED",
            "Interrupted action recovery does not match the trusted workspace",
          );
        }
        let recoveredSession = interrupted.session;
        if (recoveredSession.status === "interrupted") {
          const resumed = await this.#resumeUnchangedSession(job, {
            trustedReconciliation: true,
          });
          if (resumed.session === null) {
            return currentJobOutcome(job.jobId, resumed.job);
          }
          job = resumed.job;
          recoveredSession = resumed.session;
          assertJobSessionBinding(job, recoveredSession);
        }
        if (
          recoveredSession.status !== "active" ||
          recoveredSession.workspaceRevision !== job.execution.workspaceRevision ||
          recoveredSession.attempt.number <= interrupted.action.attemptNumber
        ) {
          throw workerError(
            "CODE_JOB_SESSION_DIVERGED",
            "Interrupted action did not recover into a later trusted attempt",
          );
        }
        return this.#performPending(job, recoveredSession, {
          reconcileExisting: true,
          reconciled: { ...reconciled, session: recoveredSession },
          acceptInterrupted: true,
        });
      }
      return this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid unknown-action reconciliation",
      );
    }
    const changed = await this.#jobs.acknowledgeAbsentAction({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: admission.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: pending.action.type,
    };
  }

  async #resumeUnchangedSession(
    job,
    { trustedReconciliation = false } = {},
  ) {
    return this.#runUnchangedSessionTransition(
      job,
      (current, runtime) => this.#executor.resume({
        sessionId: current.jobId,
        inputBinding: structuredClone(inputBindingForJob(current)),
        ...executionSourceRequestForJob(current),
      }, runtime),
      { trustedReconciliation },
    );
  }

  async #startUnchangedSession(job) {
    return this.#runUnchangedSessionTransition(job, (current, runtime) =>
      this.#executor.start({
        sessionId: current.jobId,
        workspaceId: current.grant.workspaceId,
        requestedBy: current.grant.requestedBy,
        inputBinding: structuredClone(inputBindingForJob(current)),
        ...executionSourceRequestForJob(current),
      }, runtime),
    );
  }

  async #runUnchangedSessionTransition(
    job,
    invoke,
    { trustedReconciliation = false } = {},
  ) {
    const controller = new AbortController(), parent = this.#cycleSignal;
    const abort = () => controller.abort(parent.reason);
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    this.#cancellationControllers.set(job.jobId, controller);
    try {
      const enter = () => this.#sessionTransitions.run(async () => {
        controller.signal.throwIfAborted();
        const current = await this.#jobs.getForWorker(job.jobId);
        if (!sameSessionTransitionFence(job, current)) {
          return { job: current, operation: null };
        }
        if (!trustedReconciliation) {
          await this.#verifyAuthority(current.grant);
        }

        // Invocation must enqueue synchronously. The returned Promise is carried
        // as data so this narrow lease never waits for the executor operation.
        controller.signal.throwIfAborted();
        const operation = Promise.resolve(invoke(current, { signal: controller.signal }));
        return { job: current, operation };
      });
      const admitted = trustedReconciliation
        ? await enter()
        : await this.#actionAdmission(enter);
      if (admitted.operation === null) {
        return { job: admitted.job, session: null };
      }

      const session = await admitted.operation;
      const current = await this.#jobs.getForWorker(job.jobId);
      if (!sameSessionTransitionFence(admitted.job, current)) {
        return { job: current, session: null };
      }
      assertJobSessionInputBinding(current, session);
      return { job: current, session };
    } finally {
      parent?.removeEventListener("abort", abort);
      if (this.#cancellationControllers.get(job.jobId) === controller) this.#cancellationControllers.delete(job.jobId);
    }
  }

  async #performPending(...args) {
    const [job] = args;
    if (!this.#taskRuns || ['pausing','cancelling','unknown'].includes(job.status)) return this.#executePending(...args);
    return this.#taskRuns.run({kind:'code-job',taskId:job.jobId,roleId:job.grant.requestedBy.roleId,
      title:job.grant.objective,subject:job.grant.repository,revision:job.revision},
      () => {currentTaskExecution()?.reportProgress(`正在执行受控动作：${job.execution.pendingAction?.action.type ?? '状态核对'}`);return this.#executePending(...args);},
      {repeatOnInstruction:false});
  }

  async #executePending(
    job,
    session,
    {
      reconcileExisting = false,
      reconciled = null,
      acceptInterrupted = false,
      continuous = false,
      signal = this.#cycleSignal,
    } = {},
  ) {
    const pending = job.execution.pendingAction;
    if (pending === null) {
      throw workerError(
        "CODE_JOB_PENDING_ACTION_MISSING",
        "Code job lost its prepared action before execution",
      );
    }
    if (
      !reconcileExisting &&
      pending.action.expectedWorkspaceRevision !== session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Prepared action no longer matches the controlled workspace revision",
      );
    }
    let result;
    let response;
    if (reconcileExisting) {
      const current = reconciled ?? await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: pending.action,
      });
      assertJobSessionInputBinding(job, current.session);
      if (current.status === "absent") {
        throw workerError(
          "CODE_JOB_SESSION_DIVERGED",
          "Executor lost an action that was already observed",
        );
      }
      if (current.status === "running") {
        throw workerError(
          "CODE_JOB_ACTION_BUSY",
          "Prepared action is still running in the controlled executor",
        );
      }
      response = normalizeActionResponse(pending, current);
      result = current.result;
    } else {
      const admission = await this.#actionAdmission(async () => {
        if (continuous) { currentTaskExecution()?.assertRunning?.(); signal?.throwIfAborted(); }
        const fresh = await this.#jobs.getForWorker(job.jobId);
        if (
          fresh?.status !== "active" ||
          fresh.execution.pendingAction?.actionDigest !== pending.actionDigest
        ) {
          return { admitted: false, job: fresh };
        }
        await this.#verifyAuthority(fresh.grant);
        if (continuous) { currentTaskExecution()?.assertRunning?.(); signal?.throwIfAborted(); }
        const changed = await this.#jobs.admitAction({
          jobId: fresh.jobId,
          expectedRevision: fresh.revision,
          actionId: pending.actionId,
          actionDigest: pending.actionDigest,
        });
        return { admitted: true, job: changed.job };
      });
      if (!admission.admitted) {
        return {
          jobId: job.jobId,
          status: admission.job?.status ?? "missing",
          actionType: null,
        };
      }
      job = admission.job;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this.#cancellationControllers.set(job.jobId, controller);
      try {
        const admitted = await this.#jobs.getForWorker(job.jobId);
        if (
          admitted?.status === "cancelling" &&
          admitted.execution.pendingAction?.actionDigest === pending.actionDigest
        ) {
          return this.#reconcileCancellation(admitted);
        }
        if (
          admitted?.status !== "active" ||
          admitted.execution.actionAdmission?.actionDigest !==
            pending.actionDigest
        ) {
          return {
            jobId: job.jobId,
            status: admitted?.status ?? "missing",
            actionType: null,
          };
        }
        job = admitted;
        response = normalizeActionResponse(
          pending,
          await this.#executor.perform(
            {
              sessionId: job.jobId,
              action: pending.action,
            },
            { signal: controller.signal },
          ),
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (this.#cancellationControllers.get(job.jobId) === controller) {
          this.#cancellationControllers.delete(job.jobId);
        }
      }
    }
    assertJobSessionBinding(job, response.session);
    if (
      !reconcileExisting &&
      ["succeeded", "failed"].includes(response.action.status)
    ) {
      const audited = await this.#executor.getActionResult({
        sessionId: job.jobId,
        actionId: pending.actionId,
      });
      if (
        audited?.action?.id !== response.action.id ||
        audited.action.type !== response.action.type ||
        audited.action.status !== response.action.status ||
        audited.action.workspaceRevisionBefore !==
          pending.action.expectedWorkspaceRevision
      ) {
        throw workerError(
          "CODE_JOB_AUDIT_RESULT_INVALID",
          "Audited executor result does not match the performed action",
        );
      }
      response = { ...response, action: audited.action };
      result = audited.result;
    } else if (!reconcileExisting) {
      result = { error: response.action.error };
    }
    const status = response.action.status;
    if (
      response.action.workspaceRevisionAfter !== null &&
      response.action.workspaceRevisionAfter !== response.session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Executor action result is bound to a different workspace revision",
      );
    }
    if (status === "interrupted" && !acceptInterrupted) {
      throw workerError(
        safeErrorCode(response.action.error, "CODE_JOB_ACTION_INTERRUPTED"),
        "Controlled executor reported an uncertain action result",
      );
    }
    const detail = observationDetail(pending.action, response, result);
    const latest = await this.#jobs.getForWorker(job.jobId);
    if (latest?.status === "cancelling") {
      return this.#reconcileCancellation(latest);
    }
    if (
      !latest ||
      !["active", "pausing", "unknown"].includes(latest.status) ||
      latest.execution.pendingAction?.actionDigest !== pending.actionDigest
    ) {
      return {
        jobId: job.jobId,
        status: latest?.status ?? "missing",
        actionType: null,
      };
    }
    job = latest;
    const admission = latest.execution.uncertainty !== null
      ? latest.execution.actionAdmission
      : null;
    if (latest.execution.uncertainty !== null && admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    job = (await this.#jobs.recordObservation({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: pending.actionId,
      status,
      workspaceRevision: response.session.workspaceRevision,
      detail,
      ...(admission === null
        ? {}
        : {
            actionDigest: admission.actionDigest,
            epoch: admission.epoch,
          }),
    })).job;
    if (job.status === "cancelled") {
      return {
        jobId: job.jobId,
        status: "cancelled",
        actionType: pending.action.type,
      };
    }
    if (pending.action.type === "complete" && status === "succeeded") {
      job = await this.#completeJob(
        job,
        pending.action,
        detail,
        response.session.workspaceRevision,
        pending.completionReport,
      );
      return { jobId: job.jobId, status: "completed", actionType: "complete" };
    }
    const failedVerification = verificationFailure(job);
    if (failedVerification !== null) {
      return this.#finishFailed(job, failedVerification);
    }
    return {
      jobId: job.jobId,
      status: job.status,
      actionType: pending.action.type,
    };
  }

  async #recoverCompleted(job, session) {
    assertJobSessionBinding(job, session);
    if (job.execution.pendingAction !== null) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion has no matching terminal action to reconcile",
      );
    }
    const observation = job.execution.observations.at(-1);
    if (
      observation?.actionType !== "complete" ||
      observation.status !== "succeeded"
    ) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion is missing its durable code job observation",
      );
    }
    return this.#completeObservedJob(job, observation);
  }

  async #completeObservedJob(job, observation) {
    trustedObservationAction(observation);
    job = await this.#completeJob(
      job,
      observation.action,
      observation.detail,
      observation.workspaceRevision,
      observation.completionReport,
    );
    return { jobId: job.jobId, status: "completed", actionType: "complete" };
  }

  async #completeJob(job, action, detail, workspaceRevision, completionReport) {
    const changed = await this.#jobs.complete({
      jobId: job.jobId,
      expectedRevision: job.revision,
      result: terminalResult(job, action, detail, workspaceRevision, completionReport),
      ...(this.#changePackageDeliveryEnabled &&
          canCreateCodeJobChangePackageEvent(job)
        ? { changePackageDelivery: true }
        : {}),
    });
    return changed.job;
  }

  async #finishFailed(job, error) {
    const result = {
      schemaVersion: 1,
      code: safeErrorCode(error),
      message: cleanText(error?.message ?? "Code job execution failed", 2_048),
    };
    const current = await this.#jobs.getForWorker(job.jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return { jobId: job.jobId, status: current?.status ?? "missing", actionType: null };
    }
    const changed = await this.#jobs.fail({
      jobId: job.jobId,
      expectedRevision: current.revision,
      result,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
      code: result.code,
    };
  }

  async #handleFailure(jobId, error) {
    const code = safeErrorCode(error);
    let current;
    try {
      current = await this.#jobs.getForWorker(jobId);
    } catch (readError) {
      return {
        jobId,
        status: "retry",
        actionType: null,
        code,
        readCode: safeErrorCode(readError),
      };
    }
    if (error instanceof TaskRunControlError) return {jobId,status:current?.status ?? 'unknown',actionType:null,code};
    if (current?.status === "unknown") {
      return {
        jobId,
        status: "unknown",
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (["cancelling", "cancelled"].includes(current?.status)) {
      return {
        jobId,
        status: current.status,
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    const admission = current?.execution?.actionAdmission ?? null;
    const pending = current?.execution?.pendingAction ?? null;
    if (admission !== null && pending !== null) {
      try {
        const changed = await this.#jobs.markActionUnknown({
          jobId,
          expectedRevision: current.revision,
          actionId: admission.actionId,
          actionDigest: admission.actionDigest,
          epoch: admission.epoch,
          code,
          message: "受控动作结果无法确认，必须先与执行器对账",
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: pending.action.type,
          code,
        };
      } catch (unknownError) {
        const latest = await this.#jobs.getForWorker(jobId);
        return {
          jobId,
          status: latest?.status === "unknown" ? "unknown" : "retry",
          actionType: latest?.execution?.pendingAction?.action.type ?? null,
          code,
          unknownCode: safeErrorCode(unknownError),
        };
      }
    }
    if (isRestartRequiredCode(code)) {
      return {
        jobId,
        status: "restart_required",
        actionType: current?.execution?.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (
      isDeterministicFailureCode(code) &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      return this.#finishFailed(current, error);
    }
    // A failed brain request between executor actions can retry from the same
    // checkpoint. An admitted or uncertain action still follows reconciliation.
    const stoppedQueueWait = code === MODEL_QUEUE_TIMEOUT && current?.status === 'active' && this.#taskRuns?.get &&
      current.execution.pendingAction === null && current.execution.actionAdmission === null && current.execution.uncertainty === null &&
      stoppedCodeJobQueueTimeout(current, await this.#taskRuns.get('code-job', jobId));
    const stoppedPreparedRead = code === 'STRUCTURED_PROVIDER_RESPONSE_INVALID' && hasUnadmittedProtocolRead(current) &&
      this.#taskRuns?.get && codeProtocolRecoveryFor(current, await this.#taskRuns.get('code-job', jobId)) === code;
    const authorityVerificationUnavailable = code === "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE" && current &&
      ["queued", "starting", "active"].includes(current.status) && current.execution.actionAdmission === null;
    if (authorityVerificationUnavailable ||
        ((isCodeJobBrainRetryableFailure(code) || stoppedQueueWait) && current?.status === "active" &&
          (current.execution.pendingAction === null || stoppedPreparedRead) && current.execution.actionAdmission === null)) {
      const now = new Date(this.#clock()).getTime();
      if (!Number.isFinite(now)) throw workerError("CODE_JOB_CLOCK_INVALID", "Code job worker clock is invalid");
      if (this.#maintenanceRetryNotBefore.size >= 1_024) {
        this.#maintenanceRetryNotBefore.delete(this.#maintenanceRetryNotBefore.keys().next().value);
      }
      this.#maintenanceRetryNotBefore.set(jobId, now + 60_000);
      return { jobId, status: "retry", actionType: null, code };
    }
    if (
      (requiresOperatorPause(code) || code === "STRUCTURED_PROVIDER_IDLE_TIMEOUT") &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      if (["pausing", "paused"].includes(current.status)) {
        return {
          jobId,
          status: current.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      }
      try {
        const changed = await this.#jobs.pause({
          jobId,
          expectedRevision: current.revision,
          reason: code === "CODE_BRAIN_INCOMPLETE_READ"
            ? `等待人工处理（${code}）：${cleanText(error.message, 1_536)}`
            : `等待人工处理（${code}）`,
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      } catch (pauseError) {
        return {
          jobId,
          status: "retry",
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
          pauseCode: safeErrorCode(pauseError),
        };
      }
    }
    if (
      current &&
      ["pausing", "paused"].includes(current.status) &&
      ["CODE_JOB_REVISION_CONFLICT", "CODE_JOB_TRANSITION_CONFLICT"].includes(
        code,
      )
    ) {
      return {
        jobId,
        status: current.status,
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (isAuthorityErrorCode(code) || isFencingExecutorCode(code)) {
      try {
        if (current && !TERMINAL_STATUSES.has(current.status)) {
          const changed = await this.#jobs.fence({
            jobId,
            expectedRevision: current.revision,
            result: {
              schemaVersion: 1,
              code,
              message: cleanText(error?.message ?? "Code job was fenced", 2_048),
            },
          });
          return { jobId, status: changed.job.status, actionType: null, code };
        }
        return { jobId, status: current?.status ?? "missing", actionType: null, code };
      } catch (fenceError) {
        return {
          jobId,
          status: "retry",
          actionType: null,
          code,
          fenceCode: safeErrorCode(fenceError),
        };
      }
    }
    return { jobId, status: "retry", actionType: null, code };
  }

  async #requireRunnableJob(jobId) {
    const job = await this.#jobs.getForWorker(jobId);
    if (!job) {
      throw workerError("CODE_JOB_NOT_FOUND", "Selected code job no longer exists");
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return job;
    }
    return job;
  }

  async #verifyAuthority(grant) {
    const current = await this.#verifyGrant(grant);
    if (!sameValue(current, grant)) {
      throw workerError(
        "CODE_JOB_AUTHORITY_PROTOCOL_ERROR",
        "Grant verifier returned a different code job authority",
      );
    }
    return current;
  }

  async #viewOptionalSession(sessionId) {
    try {
      return await this.#executor.view({ sessionId });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
  }

}
