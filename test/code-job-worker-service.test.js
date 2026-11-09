import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ciRepairSource } from './support/ci-repair-fixture.js';
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { summarizeOwnReviewFeedback } from "../src/adapters/github-own-review-feedback.js";
import { ReviewRepairContextReader } from "../src/services/review-repair-context-reader.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { beginCodeReadSession, createCodeReadContext, describeCodeReadContext } from "../src/lib/code-read-context.js";
import { beginCodeExecutionSession } from "../src/lib/code-execution-context.js";
import { createCodeExecutionWatchdog, codeExecutionWatchdogSignal, startCodeExecutionTurn, closeCodeExecutionWatchdog } from '../src/lib/code-execution-watchdog.js';
import { OperationQueue } from "../src/lib/operation-queue.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobBrainDirectory } from "../src/services/code-job-brain-directory.js";
import { CodeJobWorkerService } from "../src/services/code-job-worker-service.js";
import { CodeJobGrantFactory } from "../src/services/code-job-grant-factory.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { createTaskRunSettler } from '../src/services/work-ledger-run-control.js';
import { currentTaskExecution } from '../src/lib/task-execution-context.js';
import { PreparationAbortedError } from '../src/lib/preparation-cancellation.js';
import { AutomaticCodeJobPauseRecovery } from '../src/services/automatic-code-job-pause-recovery.js';
import { codeProtocolRecoveryFor } from '../src/services/code-job-protocol-recovery.js';
import { incompleteReadPauseReason } from '../src/services/code-job-read-recovery.js';
import { assertPreparedWriteRead, bindTrustedAction, modelObservation, observationDetail, verificationFailure } from "../src/services/code-job-worker-policy.js";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const FILE_SHA = "c".repeat(64);
const PROFILE_DIGEST = "d".repeat(64);

function pullRequestInputBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 42,
    rootItemId: "github:acme/dashboard:pull-request:42",
    workKey: "pr-work-42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: "1".repeat(40),
    eventId: "pull-request-event-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    ...overrides,
  };
}

function conflictInputBinding() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/dashboard",
    baseRefName: "main",
    baseRefOid: "4".repeat(40),
    headRepository: "contributor/dashboard",
    headRefName: "fix/conflict",
    headRefOid: "1".repeat(40),
  };
  return pullRequestInputBinding({ schemaVersion: 2, gitTarget });
}

function conflictExecutionSource(binding) {
  return createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "5".repeat(64),
        status: "conflicted",
        baseCommitOid: binding.gitTarget.baseRefOid,
        headCommitOid: binding.gitTarget.headRefOid,
        mergeBaseOid: "6".repeat(40),
        resultTreeOid: "7".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        resultObjectDigest: "a".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: binding.gitTarget,
    }),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

class IntegrationMemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    const value = this.values.get(name);
    return structuredClone(value === undefined ? fallback : value);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function grant(overrides = {}) {
  return {
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    workspaceId: "dashboard",
    repository: "acme/dashboard",
    operation: "modify",
    objective: "Repair the state transition.",
    acceptanceCriteria: ["The regression test passes."],
    evidence: ["A stale transition overwrites current state."],
    summary: "Repair the transition safely.",
    allowedActions: [
      "list_files",
      "read_text",
      "search_text",
      "write_text",
      "run_profile",
      "complete",
    ],
    writablePaths: ["src", "test"],
    requiredProfiles: [{ id: "node-tests", configDigest: PROFILE_DIGEST }],
    brainDigest: "1".repeat(64),
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    jobId: "code-job-1111111111111111111111111111111111111111111111111111111",
    sequence: 1,
    status: "queued",
    revision: 1,
    grant: grant(),
    execution: {
      sessionId: null,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
      cancellationSettlement: null,
    },
    ...overrides,
  };
}

function observation(action, {
  status = "succeeded",
  workspaceRevision = REVISION_A,
  actionAttemptNumber = 1,
  result = {},
} = {}) {
  const detail = {
    schemaVersion: 1,
    executor: {
      sessionStatus: "active",
      sessionAttemptNumber: actionAttemptNumber,
      actionStatus: status,
      actionAttemptNumber,
    },
    result: structuredClone(result),
  };
  return {
    turn: 1,
    actionId: action.actionId,
    actionType: action.type,
    actionDigest: digestValue(action),
    action: structuredClone(action),
    status,
    workspaceRevision,
    detail,
    detailDigest: digestValue(detail),
    recordedAt: "2026-08-01T00:00:00.000Z",
  };
}

class FakeJobStore {
  constructor(jobs, events = []) {
    this.jobs = new Map(jobs.map((entry) => {
      const copy = structuredClone(entry);
      copy.execution.actionAdmission ??= null;
      copy.execution.uncertainty ??= null;
      return [entry.jobId, copy];
    }));
    this.events = events;
    this.completionRequests = [];
    this.beforeAdmit = null;
    this.afterAdmit = null;
  }

  async listRunnable({ limit, roleId } = {}) {
    return {
      revision: 1,
      items: [...this.jobs.values()]
        .filter(
          (entry) =>
            ["queued", "starting", "active", "pausing", "cancelling"].includes(entry.status) &&
            (roleId === undefined || entry.grant.requestedBy.roleId === roleId),
        )
        .slice(0, limit)
        .map((entry) => structuredClone(entry)),
    };
  }

  async listReconcilable({ limit, roleId } = {}) {
    return {
      revision: 1,
      items: [...this.jobs.values()]
        .filter(
          (entry) =>
            entry.status === "unknown" &&
            (roleId === undefined || entry.grant.requestedBy.roleId === roleId),
        )
        .slice(0, limit)
        .map((entry) => structuredClone(entry)),
    };
  }

  async getForWorker(jobId) {
    const entry = this.jobs.get(jobId);
    return entry ? structuredClone(entry) : null;
  }

  #mutate(jobId, expectedRevision, operation, event) {
    const current = this.jobs.get(jobId);
    assert.equal(current.revision, expectedRevision);
    operation(current);
    current.revision += 1;
    this.events.push(event);
    return { status: "applied", job: structuredClone(current) };
  }

  async claimStarting({ jobId, expectedRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = "starting";
      current.execution.sessionId = current.jobId;
    }, "claim");
  }

  async activate({ jobId, expectedRevision, workspaceRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = "active";
      current.execution.workspaceRevision = workspaceRevision;
    }, "activate");
  }

  async acknowledgeAbsentSession({ jobId, expectedRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["pausing", "unknown"].includes(current.status));
      assert.equal(current.execution.pause.from, "starting");
      current.status = "paused";
    }, "session-absent");
  }

  async acknowledgeStartedSession({
    jobId,
    expectedRevision,
    workspaceRevision,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.equal(current.status, "pausing");
      assert.equal(current.execution.pause.from, "starting");
      current.status = "paused";
      current.execution.workspaceRevision = workspaceRevision;
      current.execution.pause.from = "active";
    }, "session-started");
  }

  async finalizeCancellation({
    jobId,
    expectedRevision,
    settlement,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.equal(current.status, "cancelling");
      current.status = "cancelled";
      current.execution.workspaceRevision = settlement.trustedWorkspaceRevision;
      current.execution.cancellationSettlement = {
        kind: settlement.kind,
        sessionId: settlement.sessionId,
        cancellationDigest: settlement.cancellationDigest,
        workspaceRevision: settlement.trustedWorkspaceRevision,
        proofDigest: settlement.proofDigest,
        settledAt: settlement.settledAt,
      };
      current.execution.pendingAction = null;
      current.execution.actionAdmission = null;
      current.execution.pause = null;
      current.execution.uncertainty = null;
    }, "cancelled");
  }

  async prepareAction({ jobId, expectedRevision, action, completionReport }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.execution.pendingAction = {
        turn: current.execution.turn + 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action: structuredClone(action),
        ...(completionReport === undefined ? {} : { completionReport: structuredClone(completionReport) }),
        preparedAt: "2026-08-01T00:00:01.000Z",
      };
      current.execution.actionAdmission = null;
    }, "prepare");
  }

  async admitAction({ jobId, expectedRevision, actionId, actionDigest }) {
    if (this.beforeAdmit) await this.beforeAdmit();
    const current = this.jobs.get(jobId);
    if (current.status !== "active" || current.revision !== expectedRevision) {
      throw Object.assign(new Error("admission lost the state race"), {
        code: "CODE_JOB_TRANSITION_CONFLICT",
      });
    }
    const changed = this.#mutate(jobId, expectedRevision, (entry) => {
      assert.equal(entry.execution.pendingAction.actionId, actionId);
      assert.equal(entry.execution.pendingAction.actionDigest, actionDigest);
      entry.execution.actionAdmission = {
        actionId,
        actionDigest,
        epoch: expectedRevision + 1,
        admittedAt: "2026-08-01T00:00:01.500Z",
      };
    }, "admit");
    if (this.afterAdmit) await this.afterAdmit();
    return changed;
  }

  async acknowledgeAbsentAction({
    jobId,
    expectedRevision,
    actionId,
    actionDigest,
    epoch,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["pausing", "unknown", "cancelling"].includes(current.status));
      assert.equal(current.execution.pendingAction.actionId, actionId);
      assert.equal(current.execution.pendingAction.actionDigest, actionDigest);
      assert.equal(current.execution.actionAdmission.epoch, epoch);
      current.status = current.status === "cancelling"
        ? "cancelled"
        : current.status === "unknown" &&
        current.execution.uncertainty?.from === "active"
          ? "active"
          : "paused";
      current.execution.pendingAction = current.status === "cancelled"
        ? null
        : current.execution.pendingAction;
      current.execution.actionAdmission = null;
      current.execution.uncertainty = null;
      if (current.status === "cancelled") current.execution.pause = null;
    }, "pause-acknowledged");
  }

  async markActionUnknown({
    jobId,
    expectedRevision,
    actionId,
    actionDigest,
    epoch,
    code,
    message,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["active", "pausing"].includes(current.status));
      assert.equal(current.execution.pendingAction.actionId, actionId);
      assert.equal(current.execution.pendingAction.actionDigest, actionDigest);
      assert.equal(current.execution.actionAdmission.epoch, epoch);
      const from = current.status;
      current.status = "unknown";
      current.execution.uncertainty = {
        from: from === "pausing" ? "pausing" : "active",
        code,
        message,
        at: "2026-08-01T00:00:01.875Z",
      };
    }, "unknown");
  }

  async pause({ jobId, expectedRevision, reason }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const from = current.status;
      if (from === "unknown") {
        assert.equal(current.execution.uncertainty.from, "active");
        current.execution.pause = {
          from: "active",
          reason,
          at: "2026-08-01T00:00:01.750Z",
        };
        current.execution.uncertainty.from = "pausing";
        return;
      }
      current.status =
        from === "starting" ||
        (from === "active" && current.execution.actionAdmission !== null)
          ? "pausing"
          : "paused";
      current.execution.pause = {
        from,
        reason,
        at: "2026-08-01T00:00:01.750Z",
      };
    }, "pause");
  }

  async cancel({ jobId, expectedRevision, reason }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const requestedFrom = current.status;
      const mustReconcile = current.execution.sessionId !== null;
      current.status = mustReconcile ? "cancelling" : "cancelled";
      const detail = {
        schemaVersion: 1,
        outcome: "cancelled",
        code: "CODE_JOB_CANCELLED",
        message: "cancelled by test",
        reason,
        requestedFrom,
      };
      current.execution.result = {
        kind: "cancelled",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-01T00:00:02.000Z",
      };
      if (!mustReconcile) {
        current.execution.pendingAction = null;
        current.execution.actionAdmission = null;
        current.execution.pause = null;
        current.execution.uncertainty = null;
      }
    }, "cancel");
  }

  async recordObservation({
    jobId,
    expectedRevision,
    actionId,
    status,
    workspaceRevision,
    detail,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const pending = current.execution.pendingAction;
      assert.equal(pending.actionId, actionId);
      current.execution.workspaceRevision = workspaceRevision;
      current.execution.turn = pending.turn;
      current.execution.pendingAction = null;
      current.execution.actionAdmission = null;
      current.status = current.status === "cancelling"
        ? "cancelled"
        : current.status === "unknown" &&
        current.execution.uncertainty?.from === "active"
          ? "active"
          : current.status === "pausing" || current.status === "unknown"
            ? "paused"
            : current.status;
      current.execution.uncertainty = null;
      if (current.status === "cancelled") current.execution.pause = null;
      current.execution.observations.push({
        turn: pending.turn,
        actionId,
        actionType: pending.action.type,
        actionDigest: pending.actionDigest,
        action: structuredClone(pending.action),
        ...(pending.completionReport === undefined ? {} : { completionReport: structuredClone(pending.completionReport) }),
        status,
        workspaceRevision,
        detail: structuredClone(detail),
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-01T00:00:02.000Z",
      });
    }, "observe");
  }

  async complete(value) {
    this.completionRequests.push(structuredClone(value));
    const { jobId, expectedRevision, result } = value;
    return this.#terminal(jobId, expectedRevision, "completed", result);
  }

  async fail({ jobId, expectedRevision, result }) {
    return this.#terminal(jobId, expectedRevision, "failed", result);
  }

  async fence({ jobId, expectedRevision, result }) {
    return this.#terminal(jobId, expectedRevision, "fenced", result);
  }

  #terminal(jobId, expectedRevision, status, result) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = status;
      current.execution.pendingAction = null;
      current.execution.result = { kind: status, detail: structuredClone(result) };
    }, status);
  }
}

class FakeExecutor {
  constructor(jobValue, events = [], { sessionStatus = "active", attempt = 1 } = {}) {
    this.events = events;
    this.calls = [];
    this.last = null;
    this.lastSignal = null;
    this.exists = !["queued", "starting"].includes(jobValue.status);
    this.session = {
      id: jobValue.jobId,
      workspaceId: jobValue.grant.workspaceId,
      requestedBy: structuredClone(jobValue.grant.requestedBy),
      inputBinding: Object.hasOwn(jobValue.grant, "inputBinding")
        ? structuredClone(jobValue.grant.inputBinding)
        : null,
      ...(Object.hasOwn(jobValue.grant, "executionSource")
        ? { executionSource: structuredClone(jobValue.grant.executionSource) }
        : {}),
      status: sessionStatus,
      workspaceRevision: REVISION_A,
      requiredProfiles: jobValue.grant.requiredProfiles.map(({ id }) => id),
      attempt: { number: attempt, status: sessionStatus },
      actions: [],
      error: null,
    };
  }

  async start(value) {
    this.calls.push({ method: "start", value: structuredClone(value) });
    this.events.push("executor.start");
    this.exists = true;
    return structuredClone(this.session);
  }

  async view(value) {
    this.calls.push({ method: "view", value: structuredClone(value) });
    if (!this.exists) {
      throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
    }
    return structuredClone(this.session);
  }

  async resume(value) {
    this.calls.push({ method: "resume", value: structuredClone(value) });
    this.events.push("executor.resume");
    this.session.status = "active";
    this.session.attempt = {
      number: this.session.attempt.number + 1,
      status: "active",
    };
    return structuredClone(this.session);
  }

  async perform(value, { signal = null } = {}) {
    this.lastSignal = signal;
    this.calls.push({ method: "perform", value: structuredClone(value) });
    this.events.push("executor.perform");
    const action = value.action;
    let result;
    if (action.type === "list_files") result = ["src/app.js"];
    if (action.type === "read_text") {
      result = {
        path: action.path,
        content: "export const value = 1;\n",
        sha256: FILE_SHA,
        bytes: 24,
      };
    }
    if (action.type === "search_text") result = { matches: [], truncated: false };
    if (action.type === "write_text") {
      this.session.workspaceRevision = REVISION_B;
      result = {
        path: action.path,
        sha256: "e".repeat(64),
        bytes: Buffer.byteLength(action.content),
        beforeWorkspaceRevision: REVISION_A,
        workspaceRevision: REVISION_B,
      };
    }
    if (action.type === "run_profile") {
      result = {
        exitCode: 0,
        signal: null,
        durationMs: 10,
        imageId: `sha256:${"f".repeat(64)}`,
        profileFingerprint: PROFILE_DIGEST,
        timedOut: false,
        stdout: "ok",
        stderr: "",
      };
    }
    if (action.type === "complete") {
      this.session.status = "completed";
      this.session.attempt.status = "completed";
      result = {
        created: [],
        modified: [{
          path: "src/app.js",
          beforeSha256: FILE_SHA,
          afterSha256: "e".repeat(64),
        }],
        deleted: [],
      };
    }
    this.last = {
      session: structuredClone(this.session),
      action: {
        id: action.actionId,
        type: action.type,
        status: "succeeded",
        attemptNumber: this.session.attempt.number,
        workspaceRevisionBefore: action.expectedWorkspaceRevision,
        workspaceRevisionAfter: this.session.workspaceRevision,
        error: null,
      },
      result,
    };
    const existingIndex = this.session.actions.findIndex(
      ({ id }) => id === this.last.action.id,
    );
    if (existingIndex < 0) this.session.actions.push(structuredClone(this.last.action));
    else this.session.actions[existingIndex] = structuredClone(this.last.action);
    this.last.session = structuredClone(this.session);
    return structuredClone(this.last);
  }

  async getActionResult(value) {
    this.calls.push({ method: "getActionResult", value: structuredClone(value) });
    return structuredClone({ action: this.last.action, result: this.last.result });
  }

  async reconcileAction(value) {
    this.calls.push({ method: "reconcileAction", value: structuredClone(value) });
    const action = this.session.actions.find(
      ({ id }) => id === value.action.actionId,
    );
    if (!action) {
      return { status: "absent", session: structuredClone(this.session) };
    }
    if (action.status === "running") {
      return {
        status: "running",
        session: structuredClone(this.session),
        action: structuredClone(action),
      };
    }
    const result = value.action.type === "complete"
      ? {
          created: [],
          modified: [{
            path: "src/app.js",
            beforeSha256: FILE_SHA,
            afterSha256: "e".repeat(64),
          }],
          deleted: [],
        }
      : { error: action.error };
    return {
      status: "terminal",
      session: structuredClone(this.session),
      action: structuredClone(action),
      result,
    };
  }

  async reconcileCancellation(value) {
    this.calls.push({
      method: "reconcileCancellation",
      value: structuredClone(value),
    });
    const settledAt = "2026-08-01T00:00:03.000Z";
    if (!this.exists) {
      const proof = {
        schemaVersion: 1,
        kind: "controlled_execution_absent",
        sessionId: value.sessionId,
        cancellationDigest: value.cancellationDigest,
        sourceRevision: null,
        trustedWorkspaceRevision: null,
        actionResolution: null,
        sandboxCleanupConfirmed: true,
        discardedAttempts: [],
        settledAt,
      };
      return {
        status: "settled",
        session: null,
        proof: { ...proof, proofDigest: digestValue(proof) },
      };
    }
    if (this.session.actions.some(({ status }) => status === "running")) {
      throw Object.assign(new Error("controlled action is still running"), {
        code: "CANCELLATION_PENDING",
      });
    }
    const expected = value.expectedAction;
    const action = expected === null
      ? null
      : this.session.actions.find(({ id }) => id === expected.actionId);
    const actionResolution = expected === null
      ? null
      : {
          actionId: expected.actionId,
          actionDigest: expected.actionDigest,
          disposition: action === undefined
            ? "absent"
            : action.status === "succeeded"
              ? "audited_succeeded"
              : action.status === "failed"
                ? "audited_failed"
                : "discarded_unknown",
          workspaceRevisionBefore:
            action?.workspaceRevisionBefore ?? value.expectedWorkspaceRevision,
          workspaceRevisionAfter: action?.workspaceRevisionAfter ?? null,
        };
    this.session.status = "cancelled";
    this.session.attempt.status = "cancelled";
    this.session.cleanupPending = false;
    this.session.updatedAt = settledAt;
    const proof = {
      schemaVersion: 1,
      kind: "controlled_execution_cancelled",
      sessionId: value.sessionId,
      cancellationDigest: value.cancellationDigest,
      sourceRevision: REVISION_A,
      trustedWorkspaceRevision: this.session.workspaceRevision,
      actionResolution,
      sandboxCleanupConfirmed: true,
      discardedAttempts: Array.from(
        { length: this.session.attempt.number },
        (_, index) => ({
          attemptNumber: index + 1,
          executionId: `attempt-${index + 1}`,
          disposition: "discarded",
        }),
      ),
      settledAt,
    };
    return {
      status: "settled",
      session: structuredClone(this.session),
      proof: { ...proof, proofDigest: digestValue(proof) },
    };
  }
}

function continuousFixture(decide, { content = "\uFEFForiginal\n", maxTurns = 64, requiredProfiles = [], executionSource, conflictSourceReader, grantVerifier = verifier([]) } = {}) {
  const initial = currentReadJob([]);
  initial.grant.requiredProfiles = requiredProfiles;
  if (executionSource) Object.assign(initial.grant, { schemaVersion: 3, executionSource, inputBinding: executionSource.inputBinding });
  const jobs = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const perform = executor.perform.bind(executor);
  const audited = new Map();
  executor.perform = async (value, options) => {
    const response = await perform(value, options);
    if (value.action.type === "read_text") response.result = { path: value.action.path, content,
      bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    if (value.action.type === "write_text") content = value.action.content;
    executor.last = response;
    audited.set(value.action.actionId, structuredClone(response));
    return response;
  };
  executor.getActionResult = async ({ actionId }) => structuredClone(audited.get(actionId));
  let calls = 0;
  const createWorker = () => new CodeJobWorkerService({ jobStore: jobs, executor, maxTurns,
    conflictSourceReader,
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide(input, authorization) { calls++; await authorization.beforeGenerate(); return decide(input); } },
    grantVerifier });
  return { initial, jobs, executor, get worker() { return createWorker(); }, calls: () => calls };
}

function continuousDecision(action) {
  return { schemaVersion: 1, confidence: 100, summary: "Controlled development", reason: "Current evidence", action };
}

for (const continuous of [false, true]) {
  test(`${continuous ? 'continuous' : 'single-turn'} completion retains model report separately from host verification`, async () => {
    const report = { type: 'complete', outcome: 'Inspection found one defect and an unverified GPU scenario.',
      evidence: ['model: file.cpp:42 needs follow-up', 'model claim: every check passed'] };
    const f = continuousFixture(async () => continuousDecision(report));
    const worker = new CodeJobWorkerService({ jobStore: f.jobs, executor: f.executor, grantVerifier: verifier([]),
      brainDirectory: { describe: () => ({ supportsCodeExecution: continuous }),
        decide: async () => continuousDecision(report) } });
    assert.equal((await worker.runCycle()).outcomes[0].status, 'completed');
    const job = await f.jobs.getForWorker(f.initial.jobId);
    assert.equal(job.execution.result.detail.outcome, report.outcome);
    assert.deepEqual(job.execution.result.detail.evidence, f.initial.grant.evidence);
    assert.deepEqual(job.execution.result.detail.completionReport.evidence, report.evidence);
    const action = f.executor.calls.find(x => x.method === 'perform' && x.value.action.type === 'complete').value.action;
    assert.deepEqual(Object.keys(action).sort(), ['actionId', 'expectedWorkspaceRevision', 'type']);
    const saved = job.execution.observations.at(-1).completionReport;
    assert.equal(saved.actionDigest, digestValue(action));
    assert.equal(saved.actionId, action.actionId);
    assert.equal(saved.workspaceRevision, action.expectedWorkspaceRevision);
  });
}

test('completion report survives executor settlement followed by worker restart', async () => {
  const report = { type: 'complete', outcome: 'One finding; hardware verification is still pending.', evidence: ['src/app.js:1'] };
  const f = continuousFixture(async () => continuousDecision(report));
  const complete = f.jobs.complete.bind(f.jobs);
  let failed = false;
  f.jobs.complete = async value => {
    if (!failed) { failed = true; throw new Error('completion acknowledgement lost'); }
    return complete(value);
  };
  await f.worker.runCycle();
  const observed = (await f.jobs.getForWorker(f.initial.jobId)).execution.observations.at(-1);
  assert.equal(observed.actionType, 'complete');
  assert.equal(observed.completionReport.outcome, report.outcome);
  f.jobs.jobs.get(f.initial.jobId).status = 'active';
  const resumed = new CodeJobWorkerService({ jobStore: f.jobs, executor: f.executor, grantVerifier: verifier([]),
    brainDirectory: { decide: async () => assert.fail('settled completion must not call the model again') } });
  assert.equal((await resumed.runCycle()).outcomes[0].status, 'completed');
  const result = (await f.jobs.getForWorker(f.initial.jobId)).execution.result.detail;
  assert.equal(result.outcome, report.outcome);
  assert.deepEqual(result.completionReport.evidence, report.evidence);
  assert.equal(f.executor.calls.filter(x => x.method === 'perform').length, 1);
});

for (const continuous of [false, true]) {
  test(`shutdown abort reaches an active ${continuous ? 'continuous' : 'single-turn'} code model and preserves its checkpoint`, async () => {
    const f = continuousFixture(async () => continuousDecision({ type: 'complete', outcome: 'done', evidence: [] }));
    const started = deferred(); const controller = new AbortController(); const reason = new Error('shutdown');
    const worker = new CodeJobWorkerService({ jobStore: f.jobs, executor: f.executor, grantVerifier: verifier([]),
      brainDirectory: { describe: () => ({ supportsCodeExecution: continuous }),
        async decide(_input, { signal }) {
          started.resolve(signal);
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } } });
    const running = worker.runCycle({ signal: controller.signal });
    const observed = await started.promise;
    const failed = assert.rejects(running, e => e === reason);
    controller.abort(reason);
    await failed;
    assert.equal(observed.aborted, true);
    assert.equal((await f.jobs.getForWorker(f.initial.jobId)).status, 'active');
    assert.equal(f.executor.calls.filter(c => c.method === 'perform').length, 0);
  });
}

test('repaging already consumed audited content cannot keep continuous code work alive for ten hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let expiredAt = null, elapsed = 0;
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext, { watchdog });
    const full = await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length: 500 });
    assert.equal(full.text.length, 500); assert.equal(full.nextOffset, null);
    for (let length = 1; length <= 61; length++) {
      t.mock.timers.tick(10 * 60_000); elapsed += 10 * 60_000;
      if (codeExecutionWatchdogSignal(watchdog).aborted) { expiredAt = elapsed; break; }
      await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length, sourceVersion: full.sourceVersion });
    }
    await tools.close();
    if (codeExecutionWatchdogSignal(watchdog).aborted) throw codeExecutionWatchdogSignal(watchdog).reason;
    return continuousDecision({ type: 'complete', outcome: 'all pages consumed', evidence: [] });
  }, { content: 'x'.repeat(500) });
  await fixture.worker.runCycle();
  assert.equal(expiredAt, 20 * 60_000, 'known prefix reframing must not repeatedly renew the original15min idle allowance');
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === 'perform' && value.action.type === 'read_text').length, 1);
});

test('new audited source ranges keep continuous code work healthy beyond ten virtual hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext, { watchdog });
    const first = await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length: 1 });
    for (let offset = 1; offset <= 61; offset++) {
      t.mock.timers.tick(10 * 60_000);
      assert.equal(codeExecutionWatchdogSignal(watchdog).aborted, false);
      await tools.invoke('read_source', { path: 'src/app.js', offset, length: 1, sourceVersion: first.sourceVersion });
    }
    await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length: 500, sourceVersion: first.sourceVersion });
    await tools.close();
    return continuousDecision({ type: 'complete', outcome: 'new source consumed', evidence: [] });
  }, { content: 'x'.repeat(500) });
  const result = await fixture.worker.runCycle();
  assert.equal(result.outcomes[0].status, 'completed', JSON.stringify(result));
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === 'perform' && value.action.type === 'read_text').length, 1);
});

test('a new durable read audit cannot reset watchdog coverage for unchanged source bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let changedAudit = false, expired = false;
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext, { watchdog });
    const first = await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length: 500 });
    t.mock.timers.tick(10 * 60_000);
    await tools.invoke('perform_action', { decision: continuousDecision({ type: 'read_text', path: 'src/app.js' }) });
    const page = await tools.invoke('read_source', { path: 'src/app.js', offset: 0, length: 100 });
    changedAudit = first.sourceVersion !== page.sourceVersion;
    t.mock.timers.tick(5 * 60_000); expired = codeExecutionWatchdogSignal(watchdog).aborted;
    await tools.close();
    if (expired) throw codeExecutionWatchdogSignal(watchdog).reason;
    return continuousDecision({ type: 'complete', outcome: 'source audit replaced', evidence: [] });
  }, { content: 'x'.repeat(500) });
  await fixture.worker.runCycle();
  assert.equal(changedAudit, true); assert.equal(expired, true);
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === 'perform' && value.action.type === 'read_text').length, 2);
});

test("continuous tools require complete current pages and reject old source versions after writes", async () => {
  const content = "\uFEFF" + "字\\\"".repeat(24_000) + "TAIL";
  let actual = "";
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    let page = await tools.invoke("read_source", { path: "src/app.js", offset: 0, length: 1_000 });
    const oldVersion = page.sourceVersion;
    assert.deepEqual((await tools.invoke("get_state", {})).sources, [{ path: "src/app.js", sourceVersion: oldVersion, fullyRead: false }]);
    await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "write_text", path: "src/app.js", content: "fixed\n" }) }),
      { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
    actual += page.text;
    while (page.nextOffset !== null) {
      page = await tools.invoke("read_source", { path: "src/app.js", offset: page.nextOffset, sourceVersion: page.sourceVersion });
      actual += page.text;
    }
    assert.equal((await tools.invoke("get_state", {})).sources[0].fullyRead, true);
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "write_text", path: "src/app.js", content: "fixed\n" }) });
    await assert.rejects(tools.invoke("read_source", { path: "src/app.js", offset: 1, sourceVersion: oldVersion }), { code: "CODE_READ_REVISION_INVALID" });
    assert.equal((await tools.invoke("get_state", {})).turn, 2);
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "fixed", evidence: [] });
  }, { content });
  const result = await fixture.worker.runCycle();
  assert.equal(result.outcomes[0].status, "completed", JSON.stringify(result));
  assert.equal(actual, content);
  assert.equal(fixture.calls(), 1);
  assert.deepEqual(fixture.executor.calls.filter(({ method }) => method === "perform").map(({ value }) => value.action.type), ["read_text", "write_text", "complete"]);
});

test("continuous bounded edits preserve a large audited file and reject stale or ambiguous replacements", async () => {
  const original = "unchanged prefix\n".repeat(9_000) + "replace exactly once\n" + "unchanged suffix\n";
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    let page = await tools.invoke("read_source", { path: "src/app.js", offset: 0, length: 1 });
    const sourceVersion = page.sourceVersion;
    const edit = { path: "src/app.js", sourceVersion, edits: [{ oldText: "replace exactly once", newText: "resolved" }] };
    await assert.rejects(tools.invoke("edit_source", edit), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
    while (page.nextOffset !== null) page = await tools.invoke("read_source", {
      path: "src/app.js", offset: page.nextOffset, sourceVersion,
    });
    await assert.rejects(tools.invoke("edit_source", { ...edit, edits: [{ oldText: "unchanged prefix", newText: "wrong" }] }),
      { code: "CODE_EDIT_MATCH_NOT_UNIQUE" });
    await assert.rejects(tools.invoke("edit_source", { ...edit, sourceVersion: "stale" }), { code: "CODE_READ_REVISION_INVALID" });
    await tools.invoke("edit_source", edit);
    await assert.rejects(tools.invoke("edit_source", edit), { code: "CODE_READ_REVISION_INVALID" });
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "resolved", evidence: [] });
  }, { content: original });
  const result = await fixture.worker.runCycle();
  assert.equal(result.outcomes[0].status, "completed", JSON.stringify(result));
  const writes = fixture.executor.calls.filter(({ method, value }) => method === "perform" && value.action.type === "write_text");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.action.content, original.replace("replace exactly once", "resolved"));
  assert.ok(writes[0].value.action.content.length > 96 * 1024);
  assert.equal(writes[0].value.action.expectedSha256, createHash("sha256").update(original).digest("hex"));
});

test("continuous conflict versions are complete sealed reference pages and cannot authorize workspace edits", async () => {
  const executionSource = conflictExecutionSource(conflictInputBinding());
  const contents = { ancestor: "original\n".repeat(20_000), head: "head\n", base: "base\n" };
  let readCalls = 0;
  const authorityCalls = [];
  let referenceVerificationCount;
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    const admittedCalls = authorityCalls.length;
    let page = await tools.invoke("read_conflict_source", { path: "src/app.js", version: "ancestor", offset: 0 });
    let actual = page.text;
    await assert.rejects(tools.invoke("read_conflict_source", { path: "src/app.js", version: "ancestor", offset: page.nextOffset, sourceVersion: "stale" }),
      { code: "CODE_READ_REVISION_INVALID" });
    while (page.nextOffset !== null) {
      page = await tools.invoke("read_conflict_source", { path: "src/app.js", version: "ancestor", offset: page.nextOffset, sourceVersion: page.sourceVersion });
      actual += page.text;
    }
    assert.equal(actual, contents.ancestor);
    for (const version of ["head", "base"]) assert.equal((await tools.invoke("read_conflict_source", {
      path: "src/app.js", version, offset: 0,
    })).text, contents[version]);
    await assert.rejects(tools.invoke("read_conflict_source", { path: "Other/app.js", version: "head", offset: 0 }),
      { code: "CODE_READ_DOCUMENT_NOT_FOUND" });
    referenceVerificationCount = authorityCalls.length - admittedCalls;
    const beforeEdit = authorityCalls.length;
    await assert.rejects(tools.invoke("edit_source", { path: "src/app.js", sourceVersion: page.sourceVersion,
      edits: [{ oldText: "original", newText: "wrong" }] }), { code: "CODE_READ_REVISION_INVALID" });
    assert.ok(authorityCalls.length > beforeEdit, "writes still verify current authority");
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "reference inspected", evidence: [] });
  }, { executionSource, grantVerifier: verifier(authorityCalls), conflictSourceReader: { async read(source) {
    readCalls++;
    return { inputBinding: source.inputBinding, preparationBinding: source.preparationBinding,
      documents: Object.entries(contents).map(([version, content]) => ({ path: "src/app.js", version, content,
        bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })) };
  } } });
  assert.equal((await fixture.worker.runCycle()).outcomes[0].status, "completed");
  assert.equal(readCalls, 1);
  assert.equal(referenceVerificationCount, 0, "immutable reference pages do not repeat full grant/preparation verification");
  assert.equal(fixture.executor.calls.filter(({ method }) => method === "perform").length, 1, "only final completion reaches the executor");
});

test("cached conflict reference pages stop when the job is paused", async () => {
  const executionSource = conflictExecutionSource(conflictInputBinding());
  let attempts = 0;
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    const page = await tools.invoke("read_conflict_source", { path: "src/app.js", version: "ancestor", offset: 0, length: 1 });
    fixture.jobs.jobs.get(fixture.initial.jobId).status = "paused";
    await assert.rejects(tools.invoke("read_conflict_source", { path: "src/app.js", version: "ancestor", offset: page.nextOffset, sourceVersion: page.sourceVersion }),
      { code: "CODE_JOB_SESSION_BUSY" });
    attempts++;
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "paused", evidence: [] });
  }, { executionSource, conflictSourceReader: { async read(source) {
    return { inputBinding: source.inputBinding, preparationBinding: source.preparationBinding,
      documents: ["ancestor", "head", "base"].map(version => ({ path: "src/app.js", version, content: "original\n",
        bytes: 9, sha256: createHash("sha256").update("original\n").digest("hex") })) };
  } } });
  assert.equal((await fixture.worker.runCycle()).outcomes[0].status, "paused");
  assert.equal(attempts, 1);
});

test("cached audited workspace pages do not repeat full authority scans", async () => {
  const authorityCalls = [];
  let pageVerifications;
  const content = "unchanged audited source\n".repeat(3_000);
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    let page = await tools.invoke("read_source", { path: "src/app.js", offset: 0, length: 1 });
    const beforePages = authorityCalls.length;
    let actual = page.text;
    while (page.nextOffset !== null) {
      page = await tools.invoke("read_source", { path: "src/app.js", offset: page.nextOffset, sourceVersion: page.sourceVersion });
      actual += page.text;
    }
    pageVerifications = authorityCalls.length - beforePages;
    assert.equal(actual, content);
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "read", evidence: [] });
  }, { content, grantVerifier: verifier(authorityCalls) });
  assert.equal((await fixture.worker.runCycle()).outcomes[0].status, "completed");
  assert.equal(pageVerifications, 0, "subsequent immutable audited pages reuse the verified read");
});

test("continuous final completion checks current required profiles and current full reads", async (t) => {
  for (const missing of ["profile", "pages"]) await t.test(missing, async () => {
    const fixture = continuousFixture(async ({ codeExecutionContext }) => {
      const tools = beginCodeExecutionSession(codeExecutionContext);
      if (missing === "pages") await tools.invoke("read_source", { path: "src/app.js", offset: 0, length: 1 });
      await tools.close();
      return continuousDecision({ type: "complete", outcome: "claimed complete", evidence: [] });
    }, { requiredProfiles: missing === "profile" ? [{ id: "node-tests", configDigest: PROFILE_DIGEST }] : [] });
    const result = await fixture.worker.runCycle();
    assert.equal(result.outcomes[0].status, "paused", JSON.stringify(result));
    assert.equal(result.outcomes[0].code, missing === "profile" ? "CODE_BRAIN_COMPLETION_NOT_READY" : "CODE_ARTIFACT_READ_INCOMPLETE");
    assert.equal(fixture.executor.calls.some(({ method, value }) => method === "perform" && value.action.type === "complete"), false);
  });
});

test("continuous code actions preserve action budget and sealed write scope", async (t) => {
  for (const violation of ["budget", "scope"]) await t.test(violation, async () => {
    const fixture = continuousFixture(async ({ codeExecutionContext }) => {
      const tools = beginCodeExecutionSession(codeExecutionContext);
      await tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "" }) });
      if (violation === "scope") await assert.rejects(tools.invoke("perform_action", {
        decision: continuousDecision({ type: "write_text", path: "Other/app.js", content: "forbidden" }),
      }), { code: "CODE_BRAIN_WRITE_NOT_PERMITTED" });
      await tools.close();
      return continuousDecision({ type: "complete", outcome: "complete", evidence: [] });
    }, { maxTurns: violation === "budget" ? 1 : 64 });
    const result = await fixture.worker.runCycle();
    assert.equal(result.outcomes[0].status, violation === "budget" ? "failed" : "completed", JSON.stringify(result));
    assert.equal(fixture.executor.calls.filter(({ method }) => method === "perform").some(({ value }) => value.action.path === "Other/app.js"), false);
    if (violation === "budget") assert.equal(result.outcomes[0].code, "CODE_JOB_TURN_LIMIT");
  });
});

test("continuous execution records an uncertain admitted action and never admits a later tool", async () => {
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "" }) }),
      { code: "CODE_JOB_ACTION_INTERRUPTED" });
    await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "src" }) }),
      { code: "CODE_EXECUTION_SESSION_REVOKED" });
    assert.deepEqual(await tools.close(), { settled: false });
    return continuousDecision({ type: "complete", outcome: "unconfirmed", evidence: [] });
  });
  const perform = fixture.executor.perform.bind(fixture.executor);
  fixture.executor.perform = async (...args) => {
    await perform(...args);
    throw Object.assign(new Error("lost response"), { code: "CODE_JOB_ACTION_INTERRUPTED" });
  };
  const result = await fixture.worker.runCycle();
  const current = await fixture.jobs.getForWorker(fixture.initial.jobId);
  assert.equal(result.outcomes[0].status, "unknown", JSON.stringify(result));
  assert.equal(current.execution.actionAdmission !== null, true);
  assert.equal(fixture.executor.calls.filter(({ method }) => method === "perform").length, 1);
});

for (const status of ["starting", "active"]) test(`temporary real authority verification preserves a ${status} job and backs off before retrying`, async () => {
  let now = Date.parse("2026-08-02T08:00:00.000Z");
  const clock = () => new Date(now);
  const fixture = await createVerifiedApprovedJob(clock);
  let current = (await fixture.jobs.claimStarting({ jobId: fixture.durableJob.jobId, expectedRevision: fixture.durableJob.revision })).job;
  if (status === "active") current = (await fixture.jobs.activate({ jobId: current.jobId, expectedRevision: current.revision, workspaceRevision: REVISION_A })).job;
  const executor = new FakeExecutor(current), brainCalls = [];
  const worker = new CodeJobWorkerService({ jobStore: fixture.jobs, executor, clock,
    grantVerifier: fixture.factory, brainDirectory: brain([{ type: "run_profile" }], brainCalls) });
  fixture.failWith(Object.assign(new Error("ledger read unavailable"), { code: "WORK_LEDGER_NOT_READY" }));
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "retry");
  assert.equal(result.outcomes[0].code, "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE");
  assert.deepEqual(await fixture.jobs.getForWorker(current.jobId), current);
  assert.deepEqual(executor.calls, []);
  assert.equal(brainCalls.length, 0);
  const checks = fixture.checks();
  fixture.failWith(null);
  assert.equal((await worker.runCycle()).outcomes[0].code, "CODE_JOB_MAINTENANCE_BACKOFF");
  assert.equal(fixture.checks(), checks);
  now += 60_000;
  assert.equal((await worker.runCycle()).outcomes[0].actionType, "run_profile");
  assert.equal((await fixture.jobs.getForWorker(current.jobId)).status, "active");
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
});

test("continuous real verifier outage after a settled action cannot admit another tool or complete the job", async () => {
  let now = Date.parse("2026-08-02T08:00:00.000Z"), decisions = 0;
  const clock = () => new Date(now), fixture = await createVerifiedApprovedJob(clock);
  const executor = new FakeExecutor(fixture.durableJob);
  const worker = new CodeJobWorkerService({ jobStore: fixture.jobs, executor, clock, grantVerifier: fixture.factory,
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        decisions++;
        if (decisions > 1) return continuousDecision({ type: "complete", outcome: "done", evidence: [] });
        const tools = beginCodeExecutionSession(codeExecutionContext);
        await tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) });
        fixture.failWith(Object.assign(new Error("assignment facts unavailable"), { code: "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE" }));
        await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "" }) }),
          { code: "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE" });
        await tools.close();
        return continuousDecision({ type: "complete", outcome: "cannot complete while authority is unavailable", evidence: [] });
      } } });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "retry");
  assert.equal(result.outcomes[0].code, "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE");
  const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
  assert.equal(current.status, "active");
  assert.equal(current.execution.pendingAction, null);
  assert.equal(current.execution.actionAdmission, null);
  assert.equal(current.execution.result, null);
  assert.deepEqual(current.execution.observations.map(({ actionType }) => actionType), ["run_profile"]);
  assert.equal((await worker.runCycle()).outcomes[0].code, "CODE_JOB_MAINTENANCE_BACKOFF");
  assert.equal(decisions, 1);
  fixture.failWith(null); now += 60_000;
  assert.equal((await worker.runCycle()).outcomes[0].status, "completed");
  assert.deepEqual(executor.calls.filter(({ method }) => method === "perform").map(({ value }) => value.action.type), ["run_profile", "complete"]);
});

for (const control of ["pause", "cancel"]) test(`authority verification backoff does not delay ${control} reconciliation`, async () => {
  let now = Date.parse("2026-08-01T00:00:02.000Z");
  const clock = () => new Date(now), fixture = await createVerifiedApprovedJob(clock);
  const starting = (await fixture.jobs.claimStarting({ jobId: fixture.durableJob.jobId, expectedRevision: fixture.durableJob.revision })).job;
  const executor = new FakeExecutor(starting);
  const worker = new CodeJobWorkerService({ jobStore: fixture.jobs, executor, clock, grantVerifier: fixture.factory, brainDirectory: brain([]) });
  fixture.failWith(Object.assign(new Error("ledger not ready"), { code: "WORK_LEDGER_NOT_READY" }));
  assert.equal((await worker.runCycle()).outcomes[0].status, "retry");
  await fixture.jobs[control]({ jobId: starting.jobId, expectedRevision: starting.revision, reason: "owner control during backoff" });
  now += 2_000;
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, control === "pause" ? "paused" : "cancelled", JSON.stringify(result.outcomes));
  assert.equal((await fixture.jobs.getForWorker(starting.jobId)).status, control === "pause" ? "paused" : "cancelled");
  assert.equal(executor.calls.some(({ method }) => ["start", "perform"].includes(method)), false);
});

test("continuous authority revocation after one action durably fences later tools and completion", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  let revoked = false, decisions = 0;
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor,
    grantVerifier: { async verify(value) {
      if (revoked) throw Object.assign(new Error('authority revoked during continuous turn'), { code: 'INVALID_CODE_JOB_AUTHORITY' });
      return structuredClone(value);
    } },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        decisions++;
        const tools = beginCodeExecutionSession(codeExecutionContext);
        await tools.invoke('perform_action', { decision: continuousDecision({ type: 'run_profile' }) });
        revoked = true;
        await assert.rejects(tools.invoke('perform_action', { decision: continuousDecision({ type: 'list_files', path: '' }) }),
          { code: 'INVALID_CODE_JOB_AUTHORITY' });
        await tools.close();
        return continuousDecision({ type: 'complete', outcome: 'must not complete after revocation', evidence: [] });
      } } });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, 'fenced');
  assert.equal(result.outcomes[0].code, 'INVALID_CODE_JOB_AUTHORITY');
  const current = await jobs.getForWorker(durableJob.jobId);
  assert.equal(current.status, 'fenced');
  assert.equal(current.execution.pendingAction, null);
  assert.equal(current.execution.actionAdmission, null);
  assert.equal(current.execution.observations.at(-1).actionType, 'run_profile');
  assert.equal(current.execution.observations.at(-1).status, 'succeeded');
  assert.deepEqual(executor.calls.filter(({ method }) => method === 'perform').map(({ value }) => value.action.type), ['run_profile']);
  await worker.runCycle();
  assert.equal(decisions, 1);
  assert.equal(executor.calls.filter(({ method }) => method === 'perform').length, 1);
});

test("continuous model failure after a settled write preserves audit and resumes without replaying it", async () => {
  let tools;
  const fixture = continuousFixture(async ({ codeExecutionContext }) => {
    tools = beginCodeExecutionSession(codeExecutionContext);
    await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "write_text", path: "src/app.js", content: "fixed\n" }) });
    throw Object.assign(new Error("model process ended"), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  });
  const first = await fixture.worker.runCycle();
  assert.equal(first.outcomes[0].status, "paused");
  assert.equal((await fixture.jobs.getForWorker(fixture.initial.jobId)).execution.observations.at(-1).actionType, "write_text");
  await assert.rejects(tools.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  // Operator resumes the same paused job after the provider is repaired.
  fixture.jobs.jobs.get(fixture.initial.jobId).status = "active";
  // A fresh worker uses the same durable job and executor; only completion is left.
  const resumed = new CodeJobWorkerService({ jobStore: fixture.jobs, executor: fixture.executor,
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      decide: async () => continuousDecision({ type: "complete", outcome: "done", evidence: [] }) }, grantVerifier: verifier([]) });
  assert.equal((await resumed.runCycle()).outcomes[0].status, "completed");
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === "perform" && value.action.type === "write_text").length, 1);
});

test("settled native timeout continues the same checkpoint after restart without replaying writes or profiles", async () => {
  const fixture = await continuousTimeoutFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "write_text", path: "src/app.js", content: "fixed\n" }) });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) });
    await tools.close();
    throw fixture.nativeTimeout();
  });
  const first = await fixture.worker().runCycle();
  assert.equal(first.outcomes[0].status, "active");
  const checkpoint = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
  assert.equal(checkpoint.execution.turn, 3);
  assert.equal(checkpoint.execution.timeoutContinuation.consecutiveNoProgress, 0);
  assert.equal(checkpoint.execution.timeoutContinuation.failedRunId,
    (await fixture.registry.get("code-job", checkpoint.jobId)).runId);
  assert.equal((await fixture.worker().runCycle()).selected, 0, "backoff does not consume another native turn");
  fixture.advance(11 * 60 * 60 * 1000);
  const restarted = fixture.restartJobs();
  await restarted.recover();
  assert.deepEqual((await restarted.getForWorker(checkpoint.jobId)).execution, checkpoint.execution);
  fixture.setDecide(async ({ codeExecutionContext, capabilities }) => {
    assert.equal(capabilities.requiredProfilesRemaining, 0);
    const tools = beginCodeExecutionSession(codeExecutionContext);
    assert.equal((await tools.invoke("get_state", {})).turn, 3);
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "done", evidence: [] });
  });
  const resumed = await fixture.worker({ jobStore: restarted }).runCycle();
  assert.equal(resumed.outcomes[0].status, "completed", JSON.stringify(resumed));
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === "perform" && value.action.type === "write_text").length, 1);
  assert.equal(fixture.executor.calls.filter(({ method, value }) => method === "perform" && value.action.type === "run_profile").length, 1);
});

async function continuousTimeoutFixture(initialDecide, { timeoutCode = "STRUCTURED_PROVIDER_TIMEOUT", startModel = true } = {}) {
  let now = Date.parse("2026-08-02T08:00:00.000Z");
  const clock = () => new Date(now);
  const storage = new IntegrationMemoryStore();
  const storeOptions = { store: storage, operationQueue: new OperationQueue(), exclusiveLease: { run: operation => operation() }, clock };
  const { jobs, durableJob } = await createRealApprovedJob({
    operation: "modify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ["src", "test"],
  }, { storage, clock });
  const executor = new FakeExecutor(durableJob);
  const audited = new Map();
  let content = "original\n";
  const originalPerform = executor.perform.bind(executor);
  executor.perform = async (value, options) => {
    const result = await originalPerform(value, options);
    if (value.action.type === "read_text") result.result = { path: value.action.path, content,
      bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    if (value.action.type === "write_text") {
      content = value.action.content;
      result.result.sha256 = createHash("sha256").update(content).digest("hex");
    }
    audited.set(value.action.actionId, structuredClone(result));
    return result;
  };
  executor.getActionResult = async ({ actionId }) => structuredClone(audited.get(actionId));
  const registry = new TaskRunRegistry({ store: new IntegrationMemoryStore(), receiptStore: new IntegrationMemoryStore(),
    clock, settleControl: async () => {} });
  let decide = initialDecide;
  return {
    jobs, durableJob, executor, registry,
    advance(milliseconds) { now += milliseconds; },
    restartJobs() { return new CodeJobStore(storeOptions); },
    setDecide(value) { decide = value; },
    nativeTimeout({ stopConfirmed = true, sessionStatus = "interrupted" } = {}) {
      if (startModel) currentTaskExecution().reportSession({ transport: "app-server", threadId: "native-thread", turnId: "native-turn", status: sessionStatus });
      if (stopConfirmed) currentTaskExecution().confirmStopped();
      return Object.assign(new Error("native inactivity deadline"), { code: timeoutCode });
    },
    worker(overrides = {}) {
      return new CodeJobWorkerService({ jobStore: jobs, executor, taskRuns: registry, grantVerifier: verifier([]), clock,
        brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
          async decide(input) {
            if (startModel) currentTaskExecution().reportSession({ transport: "app-server", threadId: "native-thread", turnId: "native-turn", status: "running" });
            return decide(input);
          } }, ...overrides });
    },
  };
}

test("protocol retry feedback requires this job's stopped native receipt and preserves owner controls", () => {
  const job = { jobId: "job-1", grant: { requestedBy: { roleId: "developer" } } };
  const run = { kind: "code-job", taskId: "job-1", roleId: "developer", runId: "run-1", active: false,
    mode: "active", pendingCommand: null, receipt: { kind: "code-job", taskId: "job-1", roleId: "developer",
      runId: "run-1", phase: "failed", finishedAt: "2026-10-24T03:41:36Z", stopConfirmed: true,
      session: { transport: "app-server" }, outcomeCode: "STRUCTURED_PROVIDER_RESPONSE_INVALID" } };
  for (const code of ["STRUCTURED_PROVIDER_RESPONSE_INVALID", "CODE_BRAIN_COMPLETION_NOT_READY", "CODE_BRAIN_RESPONSE_INVALID"]) {
    assert.equal(codeProtocolRecoveryFor(job, { ...run, receipt: { ...run.receipt, outcomeCode: code } }), code);
  }
  for (const change of [{ active: true }, { mode: "paused" }, { pendingCommand: "pause" }, { stopUnconfirmed: true },
    { taskId: "other" }, { roleId: "tester" }, { runId: "old-run" }]) {
    assert.equal(codeProtocolRecoveryFor(job, { ...run, ...change }), null);
  }
  for (const change of [{ stopConfirmed: false }, { finishedAt: null }, { phase: "running" }, { taskId: "other" },
    { session: null }, { outcomeCode: "STRUCTURED_PROVIDER_CLEANUP_FAILED" }]) {
    assert.equal(codeProtocolRecoveryFor(job, { ...run, receipt: { ...run.receipt, ...change } }), null);
  }
});

test("a confirmed unstarted model queue timeout retries the same job without an operator pause", async () => {
  let attempts = 0;
  const f = await continuousTimeoutFixture(async () => { attempts++; throw f.nativeTimeout(); },
    { timeoutCode: 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT', startModel: false });
  const worker = f.worker();
  const outcome = (await worker.runCycle()).outcomes[0];
  assert.equal(outcome.status, 'retry');
  assert.equal(outcome.code, 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT');
  const current = await f.jobs.getForWorker(f.durableJob.jobId);
  assert.equal(current.status, 'active');
  assert.equal(current.execution.pause, null);
  assert.equal(current.execution.turn, 0);
  assert.equal(f.executor.calls.some(call => call.method === 'perform'), false);
  assert.equal((await worker.runCycle()).outcomes[0].code, 'CODE_JOB_MAINTENANCE_BACKOFF');
  assert.equal(attempts, 1, 'backoff must not invoke another model');
  const receipt = (await f.registry.get('code-job', current.jobId)).receipt;
  assert.equal(receipt.stopConfirmed, true);
  assert.equal(receipt.session, null);
  assert.equal(receipt.modelStartedAt, null);
  f.advance(61_000);
  assert.equal((await worker.runCycle()).outcomes[0].status, 'retry');
  assert.equal(attempts, 2);
});

for (const startModel of [false, true]) test(`queue timeout requires a confirmed unstarted reservation: modelStarted=${startModel}`, async () => {
  const f = await continuousTimeoutFixture(async () => { throw f.nativeTimeout({ stopConfirmed: startModel }); },
    { timeoutCode: 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT', startModel });
  assert.equal((await f.worker().runCycle()).outcomes[0].status, 'paused');
  assert.equal((await f.jobs.getForWorker(f.durableJob.jobId)).status, 'paused');
});

test("provider format failure before read admission keeps the checkpoint runnable and reconciles the read once", async () => {
  const f = await continuousTimeoutFixture(async () => {
    const job = await f.jobs.getForWorker(f.durableJob.jobId);
    await f.jobs.prepareAction({ jobId: job.jobId, expectedRevision: job.revision,
      action: { type: 'read_text', actionId: 'pending-protocol-read', path: 'src/app.js',
        expectedWorkspaceRevision: job.execution.workspaceRevision } });
    throw f.nativeTimeout();
  }, { timeoutCode: 'STRUCTURED_PROVIDER_RESPONSE_INVALID' });
  assert.equal((await f.worker().runCycle()).outcomes[0].status, 'retry');
  const pending = (await f.jobs.getForWorker(f.durableJob.jobId)).execution.pendingAction;
  assert.equal(pending.actionId, 'pending-protocol-read');
  f.advance(61_000);
  await f.worker().runCycle();
  const current = await f.jobs.getForWorker(f.durableJob.jobId);
  assert.equal(current.status, 'active');
  assert.equal(current.execution.pendingAction, null);
  assert.equal(current.execution.turn, 1);
  assert.equal(f.executor.calls.filter(call => call.method === 'perform' && call.value.action.actionId === pending.actionId).length, 1);
});

test("a restarted continuous worker carries the stopped protocol failure into its fresh model request", async () => {
  const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout(); },
    { timeoutCode: "STRUCTURED_PROVIDER_RESPONSE_INVALID" });
  assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "retry");
  const prior = await fixture.registry.get("code-job", fixture.durableJob.jobId);
  assert.equal(prior.receipt.stopConfirmed, true);
  fixture.advance(120_000);
  fixture.setDecide(async input => {
    assert.equal(input.protocolRecoveryCode, "STRUCTURED_PROVIDER_RESPONSE_INVALID");
    const tools = beginCodeExecutionSession(input.codeExecutionContext);
    await tools.invoke("get_state", {});
    await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) });
    await tools.close();
    return continuousDecision({ type: "complete", outcome: "fresh checkpoint", evidence: [] });
  });
  const resumed = await fixture.worker().runCycle();
  assert.equal(resumed.outcomes[0].status, "completed", JSON.stringify(resumed));
  assert.equal(fixture.executor.calls.filter(call => call.value?.action?.type === "read_text").length, 1);
});

test("confirmed native idle timeout continues even when the last session label is still running", async () => {
  const fixture = await continuousTimeoutFixture(async () => {
    throw fixture.nativeTimeout({ sessionStatus: "running" });
  }, { timeoutCode: "STRUCTURED_PROVIDER_IDLE_TIMEOUT" });
  const outcome = (await fixture.worker().runCycle()).outcomes[0];
  assert.equal(outcome.status, "active");
  const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
  assert.equal(current.execution.timeoutContinuation.errorCode, "STRUCTURED_PROVIDER_IDLE_TIMEOUT");
  assert.equal(current.execution.timeoutContinuation.consecutiveNoProgress, 1);
});

test("native timeout no-progress budget and backoff survive restart and a job older than eleven hours", async () => {
  const fixture = await continuousTimeoutFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "" }) });
    await tools.invoke("perform_action", { decision: continuousDecision({ type: "search_text", query: "value", path: "src" }) });
    await tools.close();
    throw fixture.nativeTimeout();
  });
  for (const expected of [0, 1, 2]) {
    const result = await fixture.worker().runCycle();
    assert.equal(result.outcomes[0].status, "active", JSON.stringify(result));
    const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
    assert.equal(current.execution.timeoutContinuation.consecutiveNoProgress, expected);
    assert.equal(Date.parse(current.execution.timeoutContinuation.retryAfter) - Date.parse(current.execution.timeoutContinuation.recordedAt), expected === 2 ? 120_000 : 60_000);
    fixture.advance(120_000);
  }
  const beforeRestart = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
  fixture.advance(11 * 60 * 60 * 1000);
  const restarted = fixture.restartJobs();
  await restarted.recover();
  assert.deepEqual((await restarted.getForWorker(beforeRestart.jobId)).execution.timeoutContinuation,
    beforeRestart.execution.timeoutContinuation);
  const stopped = await fixture.worker({ jobStore: restarted }).runCycle();
  assert.equal(stopped.outcomes[0].status, "paused", JSON.stringify(stopped));
  const current = await restarted.getForWorker(beforeRestart.jobId);
  assert.equal(current.execution.timeoutContinuation.consecutiveNoProgress, 3);
  assert.match(current.execution.pause.reason, /连续 3 次.*保留断点/);
  assert.equal((await fixture.worker({ jobStore: restarted }).runCycle()).selected, 0);
  assert.ok(current.execution.turn > beforeRestart.execution.turn, "repeated query actions are audited but do not reset progress budget");
});

test("new trusted source and verification evidence reset consecutive inactivity while total job age remains unrestricted", async () => {
  let phase = "idle";
  const fixture = await continuousTimeoutFixture(async ({ codeExecutionContext }) => {
    const tools = beginCodeExecutionSession(codeExecutionContext);
    if (phase === "source") await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
    if (phase === "verification") await tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) });
    currentTaskExecution().reportActivity();
    currentTaskExecution().reportEvent({ type: "message", text: "Still thinking", itemId: "unchanged-message" });
    await tools.close();
    throw fixture.nativeTimeout();
  });
  for (const expected of [1, 2]) {
    assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "active");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation.consecutiveNoProgress, expected);
    fixture.advance(120_000);
  }
  fixture.advance(72 * 60 * 60 * 1000);
  phase = "source";
  assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "active");
  assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation.consecutiveNoProgress, 0);
  fixture.advance(60_000);
  phase = "idle";
  assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "active");
  assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation.consecutiveNoProgress, 1);
  fixture.advance(60_000);
  phase = "verification";
  assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "active");
  assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation.consecutiveNoProgress, 0);
});

test("native timeout continuation refuses absent, stale, unconfirmed and owner-held execution proofs", async (t) => {
  const cases = [
    ["no receipt", view => { delete view.receipt; }],
    ["stop missing", view => { delete view.receipt.stopConfirmed; }],
    ["stop false", view => { view.receipt.stopConfirmed = false; }],
    ["model never started", view => { view.receipt.modelStartedAt = null; }],
    ["finish unknown", view => { view.receipt.finishedAt = null; }],
    ["wrong role", view => { view.receipt.roleId = "tester"; }],
    ["wrong task", view => { view.receipt.taskId = "code-job-other"; }],
    ["wrong kind", view => { view.receipt.kind = "work-ledger"; }],
    ["wrong task revision", view => { view.receipt.taskRevision += 1; }],
    ["stale run", view => { view.receipt.runId = "old-run"; view.runId = "old-run"; }],
    ["active run", view => { view.active = true; }],
    ["running phase", view => { view.receipt.phase = "running"; }],
    ["owner held", view => { view.mode = "paused"; }],
    ["pending control", view => { view.pendingCommand = "pause"; }],
    ["stop unconfirmed", view => { view.stopUnconfirmed = true; }],
    ["cleanup failure", view => { view.receipt.outcomeCode = "STRUCTURED_PROVIDER_CLEANUP_FAILED"; }],
    ["non-native provider", view => { view.receipt.session = null; }],
  ];
  for (const [name, alter] of cases) await t.test(name, async () => {
    const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout({ sessionStatus: "running" }); });
    const taskRuns = {
      run: fixture.registry.run.bind(fixture.registry), order: fixture.registry.order.bind(fixture.registry),
      async get(...args) {
        const view = await fixture.registry.get(...args);
        if (!view.active) alter(view);
        return view;
      },
    };
    const outcome = (await fixture.worker({ taskRuns }).runCycle()).outcomes[0];
    assert.equal(outcome.status, "paused", JSON.stringify(outcome));
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
});

test("native timeout continuation does not substitute an old run receipt during invocation registration", async () => {
  const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout(); });
  const taskRuns = { run: fixture.registry.run.bind(fixture.registry), order: fixture.registry.order.bind(fixture.registry),
    async get(...args) {
      const view = await fixture.registry.get(...args);
      view.active = false;
      return view;
    } };
  assert.equal((await fixture.worker({ taskRuns }).runCycle()).outcomes[0].status, "paused");
  assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
});

test("native timeout backoff is enforced even when a caller supplies an unfiltered runnable page", async () => {
  const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout(); });
  await fixture.worker().runCycle();
  let calls = 0;
  fixture.setDecide(async () => { calls++; throw fixture.nativeTimeout(); });
  const unfiltered = new Proxy(fixture.jobs, { get(target, property) {
    if (property === "listRunnable") return async () => ({ revision: 0, items: [await fixture.jobs.getForWorker(fixture.durableJob.jobId)] });
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = await fixture.worker({ jobStore: unfiltered }).runCycle();
  assert.equal(result.outcomes[0].status, "active");
  assert.equal(result.outcomes[0].code, "CODE_JOB_TIMEOUT_BACKOFF");
  assert.equal(calls, 0);
});

test("native timeout continuation rechecks Head, configuration and session workspace authority", async (t) => {
  await t.test("Head revoked after the failed turn", async () => {
    let revoked = false;
    const fixture = await continuousTimeoutFixture(async () => { revoked = true; throw fixture.nativeTimeout(); });
    const grantVerifier = { async verify(value) {
      if (revoked) throw Object.assign(new Error("PR Head changed"), { code: "INVALID_CODE_JOB_AUTHORITY" });
      return structuredClone(value);
    } };
    assert.equal((await fixture.worker({ grantVerifier }).runCycle()).outcomes[0].status, "fenced");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
  await t.test("configuration changed before continuation admission", async () => {
    const gate = readyActionAdmissionGate();
    const fixture = await continuousTimeoutFixture(async () => {
      await activateNextConfiguration(gate);
      throw fixture.nativeTimeout();
    });
    const outcome = (await fixture.worker({ actionAdmissionGate: gate }).runCycle()).outcomes[0];
    assert.equal(outcome.status, "restart_required");
    assert.equal(outcome.code, "RUNTIME_RESTART_REQUIRED");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
  for (const [name, alter] of [
    ["workspace changed", session => { session.workspaceRevision = REVISION_B; }],
    ["session binding changed", session => { session.workspaceId = "other-workspace"; }],
    ["session cleanup pending", session => { session.cleanupPending = true; }],
  ]) await t.test(name, async () => {
    const fixture = await continuousTimeoutFixture(async () => {
      alter(fixture.executor.session);
      throw fixture.nativeTimeout();
    });
    assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "fenced");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
});

test("owner pause and cancel win the native timeout continuation CAS without changing checkpoints", async (t) => {
  for (const command of ["pause", "cancel"]) await t.test(command, async () => {
    let failed = false, verified = 0;
    const fixture = await continuousTimeoutFixture(async () => { failed = true; throw fixture.nativeTimeout(); });
    const grantVerifier = { async verify(value) {
      if (failed && ++verified === 2) {
        const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
        await fixture.jobs[command]({ jobId: current.jobId, expectedRevision: current.revision, reason: `owner ${command}` });
      }
      return structuredClone(value);
    } };
    const outcome = (await fixture.worker({ grantVerifier }).runCycle()).outcomes[0];
    assert.equal(outcome.status, command === "pause" ? "paused" : "cancelling");
    const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
    assert.equal(current.execution.timeoutContinuation, undefined);
    assert.equal(current.execution.turn, 0);
    assert.equal(current.execution.pause?.reason ?? current.execution.result.detail.reason, `owner ${command}`);
  });
});

test("native timeout leaves a pending or unknown executor action under existing reconciliation policy", async (t) => {
  await t.test("prepared action", async () => {
    const fixture = await continuousTimeoutFixture(async () => {
      const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
      await fixture.jobs.prepareAction({ jobId: current.jobId, expectedRevision: current.revision,
        action: { actionId: "pending-timeout-action", type: "list_files", path: "", expectedWorkspaceRevision: current.execution.workspaceRevision } });
      throw fixture.nativeTimeout();
    });
    assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "paused");
    const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
    assert.notEqual(current.execution.pendingAction, null);
    assert.equal(current.execution.timeoutContinuation, undefined);
  });
  await t.test("admitted action result unknown", async () => {
    const fixture = await continuousTimeoutFixture(async ({ codeExecutionContext }) => {
      const tools = beginCodeExecutionSession(codeExecutionContext);
      await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "list_files", path: "" }) }));
      throw fixture.nativeTimeout();
    });
    fixture.executor.perform = async () => { throw Object.assign(new Error("executor result lost"), { code: "STRUCTURED_PROVIDER_TIMEOUT" }); };
    assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "unknown");
    const current = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
    assert.notEqual(current.execution.uncertainty, null);
    assert.notEqual(current.execution.actionAdmission, null);
    assert.equal(current.execution.timeoutContinuation, undefined);
  });
});

test("manual provider pause remains paused and is never adopted by native timeout continuation", async () => {
  const fixture = await continuousTimeoutFixture(async () => { throw new Error("must not run"); });
  await fixture.jobs.claimStarting({ jobId: fixture.durableJob.jobId, expectedRevision: fixture.durableJob.revision });
  const starting = await fixture.jobs.getForWorker(fixture.durableJob.jobId);
  await fixture.jobs.activate({ jobId: starting.jobId, expectedRevision: starting.revision, workspaceRevision: REVISION_A });
  const active = await fixture.jobs.getForWorker(starting.jobId);
  await fixture.jobs.pause({ jobId: active.jobId, expectedRevision: active.revision, reason: "等待人工处理（STRUCTURED_PROVIDER_TIMEOUT）" });
  const paused = await fixture.jobs.getForWorker(active.jobId);
  assert.equal((await fixture.worker().runCycle()).selected, 0);
  assert.deepEqual(await fixture.jobs.getForWorker(active.jobId), paused);
});

test("native timeout recovery fails closed without durable stop evidence or the continuation store port", async (t) => {
  await t.test("native provider has not confirmed stop", async () => {
    const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout({ stopConfirmed: false }); });
    assert.equal((await fixture.worker().runCycle()).outcomes[0].status, "paused");
    const receipt = await fixture.registry.get("code-job", fixture.durableJob.jobId);
    assert.equal(receipt.receipt.stopConfirmed, false);
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
  await t.test("registry has no durable receipt store", async () => {
    const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout(); });
    const taskRuns = new TaskRunRegistry({ store: new IntegrationMemoryStore(), settleControl: async () => {} });
    assert.equal((await fixture.worker({ taskRuns }).runCycle()).outcomes[0].status, "paused");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
  await t.test("store does not support durable continuation", async () => {
    const fixture = await continuousTimeoutFixture(async () => { throw fixture.nativeTimeout(); });
    const jobStore = new Proxy(fixture.jobs, { get(target, property) {
      if (property === "recordTimeoutContinuation") return undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.equal((await fixture.worker({ jobStore }).runCycle()).outcomes[0].status, "paused");
    assert.equal((await fixture.jobs.getForWorker(fixture.durableJob.jobId)).execution.timeoutContinuation, undefined);
  });
});

test("continuous live pause waits for an admitted profile and prevents a second tool", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  const entered = deferred(), finish = deferred(), interrupted = deferred();
  const perform = executor.perform.bind(executor);
  executor.perform = async (...args) => { entered.resolve(); await finish.promise; return perform(...args); };
  const settle = createTaskRunSettler({ codeJobReader: { get: id => jobs.getForWorker(id) },
    codeJobControl: Object.fromEntries(['pause','cancel','resume'].map(name => [name, value => jobs[name](value)])) });
  const registry = new TaskRunRegistry({ store: new IntegrationMemoryStore(), settleControl: settle });
  let stopped = false;
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor, taskRuns: registry,
    grantVerifier: { verify: async value => structuredClone(value) },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        const tools = beginCodeExecutionSession(codeExecutionContext);
        currentTaskExecution().registerLiveControl({ steer: async () => {}, interrupt: async () => { tools.revoke(); interrupted.resolve(); } });
        const action = tools.invoke('perform_action', { decision: continuousDecision({ type: 'run_profile' }) });
        await interrupted.promise;
        await assert.rejects(tools.invoke('perform_action', { decision: continuousDecision({ type: 'list_files', path: '' }) }), { code: 'CODE_EXECUTION_SESSION_REVOKED' });
        await assert.rejects(action, { code: 'TASK_RUN_PAUSED' });
        assert.deepEqual(await tools.close(), { settled: true });
        currentTaskExecution().confirmStopped(); stopped = true;
        throw Object.assign(new Error('native turn interrupted'), { code: 'STRUCTURED_PROVIDER_CANCELLED' });
      } } });
  const cycle = worker.runCycle(); await entered.promise;
  const view = await registry.get('code-job', durableJob.jobId);
  await registry.control(view.kind, view.taskId, { runId: view.runId, expectedRevision: view.revision, command: 'pause' });
  await interrupted.promise;
  assert.equal(stopped, false);
  assert.equal((await registry.get(view.kind, view.taskId)).stopUnconfirmed, true);
  finish.resolve(); const result = await cycle;
  assert.equal(result.outcomes[0].status, 'paused', JSON.stringify(result));
  assert.equal((await jobs.getForWorker(durableJob.jobId)).execution.pendingAction, null);
  assert.equal(executor.calls.filter(({ method }) => method === 'perform').length, 1);
});

test("continuous cancellation aborts reasoning without an active executor action", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const entered = deferred();
  const executor = new FakeExecutor(durableJob);
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor,
    grantVerifier: { verify: async value => structuredClone(value) },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide(value, authorization) {
        entered.resolve();
        await new Promise((resolve, reject) => authorization.signal.addEventListener('abort', () => reject(
          Object.assign(new Error('cancelled'), { code: 'STRUCTURED_PROVIDER_CANCELLED' })), { once: true }));
      } } });
  const cycle = worker.runCycle(); await entered.promise;
  const current = await jobs.getForWorker(durableJob.jobId);
  await jobs.cancel({ jobId: current.jobId, expectedRevision: current.revision, reason: 'cancel reasoning' });
  assert.equal(worker.requestCancellation(current.jobId), true);
  assert.equal((await cycle).outcomes[0].status, 'cancelling');
  assert.equal(worker.requestCancellation(current.jobId), false);
  assert.equal(executor.calls.some(({ method }) => method === 'perform'), false);
});

test("continuous completion waits for undelivered owner instructions without replaying actions", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  const entered = deferred(), finish = deferred();
  const registry = new TaskRunRegistry({ store: new IntegrationMemoryStore(), settleControl: async () => {} });
  let calls = 0;
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor, taskRuns: registry,
    grantVerifier: { verify: async value => structuredClone(value) },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext, instructions }) {
        calls++;
        if (calls === 1) {
          const tools = beginCodeExecutionSession(codeExecutionContext);
          await tools.invoke('perform_action', { decision: continuousDecision({ type: 'run_profile' }) });
          await tools.close(); entered.resolve(); await finish.promise;
        } else assert.deepEqual(instructions, ['Check the additional acceptance requirement']);
        return continuousDecision({ type: 'complete', outcome: 'done', evidence: [] });
      } } });
  const first = worker.runCycle(); await entered.promise;
  const view = await registry.get('code-job', durableJob.jobId);
  await registry.control(view.kind, view.taskId, { runId: view.runId, expectedRevision: view.revision,
    command: 'instruct', instruction: 'Check the additional acceptance requirement' });
  finish.resolve();
  assert.equal((await first).outcomes[0].status, 'active');
  assert.equal(executor.calls.some(({ method, value }) => method === 'perform' && value.action.type === 'complete'), false);
  assert.equal((await worker.runCycle()).outcomes[0].status, 'completed');
  assert.equal(calls, 2);
  assert.equal(executor.calls.filter(({ method, value }) => method === 'perform' && value.action.type === 'run_profile').length, 1);
});

test("continuous pause winning during authority verification blocks action admission", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  const verifying = deferred(), release = deferred();
  const settle = createTaskRunSettler({ codeJobReader: { get: id => jobs.getForWorker(id) },
    codeJobControl: Object.fromEntries(['pause','cancel','resume'].map(name => [name, value => jobs[name](value)])) });
  const registry = new TaskRunRegistry({ store: new IntegrationMemoryStore(), settleControl: settle });
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor, taskRuns: registry,
    grantVerifier: { async verify(value) {
      const current = await jobs.getForWorker(durableJob.jobId);
      if (current.execution.pendingAction && current.execution.actionAdmission === null) { verifying.resolve(); await release.promise; }
      return structuredClone(value);
    } },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        const tools = beginCodeExecutionSession(codeExecutionContext);
        currentTaskExecution().registerLiveControl({ steer: async () => {}, interrupt: async () => tools.revoke() });
        await assert.rejects(tools.invoke('perform_action', { decision: continuousDecision({ type: 'run_profile' }) }), { code: 'TASK_RUN_PAUSED' });
        assert.deepEqual(await tools.close(), { settled: true });
        currentTaskExecution().confirmStopped();
        throw Object.assign(new Error('native stopped'), { code: 'STRUCTURED_PROVIDER_CANCELLED' });
      } } });
  const cycle = worker.runCycle(); await verifying.promise;
  const view = await registry.get('code-job', durableJob.jobId);
  await registry.control(view.kind, view.taskId, { runId: view.runId, expectedRevision: view.revision, command: 'pause' });
  release.resolve(); await cycle;
  assert.equal(executor.calls.some(({ method }) => method === 'perform'), false);
  assert.equal((await jobs.getForWorker(durableJob.jobId)).execution.actionAdmission, null);
});

test("continuous completion rejects later instructions once final completion wins", async () => {
  const { jobs, durableJob } = await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  const verifying = deferred(), release = deferred();
  const registry = new TaskRunRegistry({ store: new IntegrationMemoryStore(), settleControl: async () => {} });
  let returned = false, finalVerifications = 0;
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor, taskRuns: registry,
    grantVerifier: { async verify(value) {
      if (returned && ++finalVerifications === 2) { verifying.resolve(); await release.promise; }
      return structuredClone(value);
    } },
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        const tools = beginCodeExecutionSession(codeExecutionContext);
        await tools.invoke('perform_action', { decision: continuousDecision({ type: 'run_profile' }) });
        await tools.close(); returned = true;
        return continuousDecision({ type: 'complete', outcome: 'done', evidence: [] });
      } } });
  const cycle = worker.runCycle(); await verifying.promise;
  const view = await registry.get('code-job', durableJob.jobId);
  try {
    await assert.rejects(registry.control(view.kind, view.taskId, { runId: view.runId,
      expectedRevision: view.revision, command: 'instruct', instruction: 'Too late for this completed turn' }),
    { code: 'TASK_RUN_INSTRUCTIONS_CLOSED' });
  } finally { release.resolve(); }
  assert.equal((await cycle).outcomes[0].status, 'completed');
  assert.deepEqual(await registry.list(), { enabled: true, items: [], held: [] });
  await assert.rejects(registry.get('code-job', durableJob.jobId), { code: 'TASK_RUN_NOT_FOUND' });
});

function brain(responses, calls = []) {
  return {
    calls,
    async decide(value) {
      calls.push(structuredClone(value));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {
        schemaVersion: 1,
        confidence: 90,
        summary: "Proceed safely.",
        reason: "The observation supports this action.",
        action: structuredClone(next),
      };
    },
  };
}

function verifier(events, error = null) {
  return {
    async verify(value) {
      events.push("verify");
      if (error) throw error;
      return structuredClone(value);
    },
  };
}

test("worker shutdown and task controls cancel preparation without producing a business failure", async t => {
  for (const phase of ["start", "resume"]) for (const control of ["shutdown", "cancel", "pause"]) await t.test(`${phase}/${control}`, async () => {
    const initial = job();
    if (phase === "resume") Object.assign(initial, { status: "active", execution: { ...initial.execution,
      sessionId: initial.jobId, workspaceRevision: REVISION_A } });
    const jobs = new FakeJobStore([initial]), executor = new FakeExecutor(initial, [], { sessionStatus: phase === "resume" ? "interrupted" : "active" });
    const entered = deferred(), release = deferred(), shutdown = new AbortController();
    let received, preparations = 0;
    executor[phase] = async (_request, options) => {
      preparations++;
      received = options?.signal;
      entered.resolve();
      await new Promise(resolve => {
        release.promise.then(resolve);
        if (received?.aborted) resolve(); else received?.addEventListener("abort", resolve, { once: true });
      });
      if (received?.aborted) throw new PreparationAbortedError();
      throw new Error("preparation did not receive cancellation");
    };
    const decisions = brain([]), worker = new CodeJobWorkerService({ jobStore: jobs, executor, brainDirectory: decisions, grantVerifier: verifier([]) });
    const cycle = worker.runCycle({ signal: shutdown.signal }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    try {
      assert.ok(received instanceof AbortSignal);
      if (control === "shutdown") shutdown.abort(new Error("shutdown requested"));
      else {
        const current = await jobs.getForWorker(initial.jobId);
        await jobs[control]({ jobId: initial.jobId, expectedRevision: current.revision, reason: `owner ${control}` });
        assert.equal(worker.requestCancellation(initial.jobId), true);
      }
    } finally { release.resolve(); }
    const outcome = await cycle;
    if (control === "shutdown") assert.strictEqual(outcome.error, shutdown.signal.reason);
    else {
      assert.equal(outcome.error, undefined);
      await worker.runCycle();
      assert.equal((await jobs.getForWorker(initial.jobId)).status, control === "cancel" ? "cancelled" : "paused");
      assert.equal(preparations, 1, "owner control must not resume another preparation");
    }
    assert.notEqual((await jobs.getForWorker(initial.jobId)).status, "failed");
    assert.equal(decisions.calls.length, 0);
  });
});

function reviewRepairFixture() {
  const inputBinding = conflictInputBinding();
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `thread-${index}`, path: `src/file-${index}.js`, line: index + 1,
    isResolved: false, isOutdated: false,
    comments: [
      { id: `external-${index}`, author: { login: "reviewer" }, body: `Request ${index}: ${"完整意见".repeat(2500)}`, createdAt: "2026-10-10T01:00:00Z" },
      { id: `reply-${index}`, author: { login: "runtime-user" }, body: "Already considered; inspect the code", createdAt: "2026-10-10T02:00:00Z" },
    ],
  }));
  let live;
  const refresh = () => { live = {
    state: "open", author: "runtime-user", currentUser: "runtime-user",
    repo: "acme/dashboard", number: 42, headRefOid: inputBinding.headRefOid,
    ...summarizeOwnReviewFeedback({ reviews: [], threads }, "runtime-user"),
  }; };
  refresh();
  const reader = new ReviewRepairContextReader({
    github: { async readOwnPullRequestFeedback() { return structuredClone(live); } },
    executionContextReader: { async readPullRequestExecutionContext() { return { inputBinding, author: "runtime-user", reviewFeedbackDigest: live.reviewFeedbackDigest }; } },
  });
  const initial = job({ grant: grant({
    schemaVersion: 3, inputBinding,
    executionSource: createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: ["src", "test"] }),
  }) });
  return { initial, reader, get feedback() { return live; }, changeFeedback() { threads[0].comments[0].body += " Another requirement"; refresh(); } };
}

test("own PR repair worker delivers every full request and author reply through the actual code brain directory", async () => {
  const fixture = reviewRepairFixture();
  const store = new FakeJobStore([fixture.initial]);
  const executor = new FakeExecutor(fixture.initial);
  const calls = [];
  const directory = new CodeJobBrainDirectory({
    roles: { developer: { taskBrain: { provider: "local", model: "code", remoteData: { requirements: false, code: false, memory: false } } } },
    brainRouter: {
      describe(value) { return { ...value, remote: false }; },
      async generate(value) {
        calls.push(structuredClone(value));
        return JSON.stringify({ schemaVersion: 1, confidence: 90, summary: "Inspect code", reason: "Assess the full review requests", action: { type: "read_text", path: "src/app.js" } });
      },
    },
  });
  const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: directory, grantVerifier: verifier([]), reviewRepairContextReader: fixture.reader });
  const result = await worker.runCycle({ limit: 1, roleId: "developer" });
  assert.equal(result.outcomes[0].status, "active");
  assert.equal(calls.length, 1);
  const parts = calls[0].messages.slice(2);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(({ content }) => Buffer.byteLength(content) < 128 * 1024));
  const received = JSON.parse(parts.map(({ content }) => content.slice(content.indexOf("\n") + 1)).join(""));
  assert.equal(received.headRefOid, fixture.initial.grant.inputBinding.headRefOid);
  assert.equal(received.reviewFeedbackDigest, fixture.feedback.reviewFeedbackDigest);
  assert.deepEqual(received.feedback, fixture.feedback.feedback);
  assert.equal(received.feedback.threads.length, 12);
  assert.ok(received.feedback.threads.every(({ comments, discussion }) => comments[0].body.length > 2 * 1024 && discussion[1].author === "runtime-user"));
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
});

test('CI repair worker supplies immutable CI failure evidence to the real code brain without a Review reader', async () => {
  const { jobs: store, durableJob: initial } = await createRealReviewRepairJob('ci_repair');
  const source = initial.grant.executionSource;
  const executor = new FakeExecutor(initial), calls = [];
  const directory = new CodeJobBrainDirectory({ roles: { developer: { taskBrain: {
    provider: 'local', model: 'code', remoteData: { requirements: false, code: false, memory: false } } } },
    brainRouter: { describe(value) { return { ...value, remote: false }; }, async generate(value) {
      calls.push(structuredClone(value));
      return JSON.stringify({ schemaVersion: 1, confidence: 90, summary: 'Inspect CI defect', reason: 'Verify failure cause', action: { type: 'read_text', path: 'src/app.js' } });
    } } });
  const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: directory, grantVerifier: verifier([]) });
  const result = await worker.runCycle({ limit: 1, roleId: 'developer' });
  assert.equal(result.outcomes[0].status, 'active');
  assert.equal(result.outcomes[0].actionType, 'read_text');
  const message = calls[0].messages.find(message => message.content.startsWith('Original CI failure evidence JSON'));
  assert.ok(message);
  assert.deepEqual(JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)), source.ciEvidence);
  assert.equal(calls[0].messages.some(message => message.content.startsWith('Own PR repair feedback JSON')), false);
});

test("own PR repair fences feedback changed while deciding before performing any action", async () => {
  const fixture = reviewRepairFixture();
  const store = new FakeJobStore([fixture.initial]);
  const executor = new FakeExecutor(fixture.initial);
  const directory = brain([{ type: "read_text", path: "src/app.js" }]);
  const decide = directory.decide.bind(directory);
  directory.decide = async (value) => { const result = await decide(value); fixture.changeFeedback(); return result; };
  const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: directory, grantVerifier: verifier([]), reviewRepairContextReader: fixture.reader });
  const result = await worker.runCycle({ limit: 1 });
  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(result.outcomes[0].code, "CODE_REVIEW_REPAIR_CONTEXT_STALE");
  assert.equal(directory.calls.length, 1);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
});

test("own PR repair missing feedback reader pauses and temporary read failure retries without fallback", async () => {
  for (const unavailable of [false, true]) {
    const fixture = reviewRepairFixture();
    const store = new FakeJobStore([fixture.initial]);
    const executor = new FakeExecutor(fixture.initial);
    const directory = brain([{ type: "read_text", path: "src/app.js" }]);
    const worker = new CodeJobWorkerService({
      jobStore: store, executor, brainDirectory: directory, grantVerifier: verifier([]),
      ...(unavailable ? { reviewRepairContextReader: { async read() {
        if (directory.calls.length === 0 && !this.recovered) {
          this.recovered = true;
          throw Object.assign(new Error("offline"), { code: "CODE_REVIEW_REPAIR_CONTEXT_UNAVAILABLE" });
        }
        return fixture.reader.read({ job: fixture.initial });
      } } } : {}),
    });
    const result = await worker.runCycle({ limit: 1 });
    assert.equal(result.outcomes[0].status, unavailable ? "retry" : "paused");
    assert.equal(directory.calls.length, 0);
    assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
    if (unavailable) {
      await worker.runCycle({ limit: 1 });
      assert.equal(directory.calls.length, 1, "recovered read resumes on the next cycle without owner approval");
      assert.equal(executor.calls.some(({ method }) => method === "perform"), true);
    }
  }
});

test("a queued job is started and one semantic action is durably executed", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], brainCalls),
    grantVerifier: verifier(events),
    actionAdmissionGate: {
      async run(operation) {
        events.push("admission-gate-enter");
        const result = await operation();
        events.push("admission-gate-exit");
        return result;
      },
    },
  });

  const result = await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.equal(result.processed, 1);
  assert.equal(result.outcomes[0].actionType, "read_text");
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "active");
  assert.equal(stored.execution.turn, 1);
  assert.equal(stored.execution.pendingAction, null);
  const performed = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.match(performed.actionId, /^action-[a-f0-9]{55}$/);
  assert.equal(performed.expectedWorkspaceRevision, REVISION_A);
  const startIndex = events.indexOf("executor.start");
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "start").value,
    {
      sessionId: initial.jobId,
      workspaceId: initial.grant.workspaceId,
      requestedBy: initial.grant.requestedBy,
      inputBinding: null,
    },
  );
  const startAdmissionEnter = events.lastIndexOf(
    "admission-gate-enter",
    startIndex,
  );
  const startAdmissionExit = events.indexOf(
    "admission-gate-exit",
    startIndex,
  );
  assert.deepEqual(
    events.slice(startAdmissionEnter, startAdmissionExit + 1),
    [
      "admission-gate-enter",
      "verify",
      "executor.start",
      "admission-gate-exit",
    ],
  );
  const actionIndex = events.indexOf("admit");
  const actionAdmissionEnter = events.lastIndexOf(
    "admission-gate-enter",
    actionIndex,
  );
  const actionAdmissionExit = events.indexOf(
    "admission-gate-exit",
    actionIndex,
  );
  assert.equal(events[actionIndex - 1], "verify");
  assert.deepEqual(
    events.slice(actionAdmissionEnter, actionAdmissionExit + 1),
    ["admission-gate-enter", "verify", "admit", "admission-gate-exit"],
  );
  assert.equal(
    events[events.indexOf("executor.perform") - 1],
    "admission-gate-exit",
  );
  assert.deepEqual(Object.keys(brainCalls[0]), [
    "roleId",
    "task",
    "capabilities",
    "turn",
    "observations",
  ]);
  assert.equal(JSON.stringify(brainCalls[0]).includes("workspaceRevision"), false);
});

test("worker keeps every code turn for one Issue in the same brain session", async () => {
  const initial = job({
    grant: grant({
      subject: { number: 17 },
      inputBinding: null,
    }),
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], brainCalls),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.equal(
    brainCalls[0].sessionKey,
    "github:issue:acme/dashboard#17",
  );
});

test("worker forwards an exact PR input binding when starting a session", async () => {
  const inputBinding = pullRequestInputBinding();
  const initial = job({ grant: grant({ inputBinding }) });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.deepEqual(
    executor.calls.find(({ method }) => method === "start").value.inputBinding,
    inputBinding,
  );
});

test("worker forwards the complete sealed conflict source when starting a session", async () => {
  const inputBinding = conflictInputBinding();
  const executionSource = conflictExecutionSource(inputBinding);
  const initial = job({
    grant: grant({
      schemaVersion: 3,
      inputBinding,
      executionSource,
      writablePaths: ["src/app.js"],
    }),
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  const started = executor.calls.find(({ method }) => method === "start").value;
  assert.deepEqual(started.inputBinding, inputBinding);
  assert.deepEqual(started.executionSource, executionSource);
});

test("session input binding tampering fences before brain or executor actions", async (t) => {
  const cases = [
    ["missing", (session) => delete session.inputBinding],
    ["repository", (session) => {
      session.inputBinding.repository = "acme/other";
    }],
    ["pull request", (session) => {
      session.inputBinding.pullRequestNumber += 1;
    }],
    ["Head", (session) => {
      session.inputBinding.headRefOid = "4".repeat(40);
    }],
    ["event", (session) => {
      session.inputBinding.eventId = "pull-request-event-foreign";
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const inputBinding = pullRequestInputBinding();
      const initial = job({
        grant: grant({ inputBinding }),
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
          uncertainty: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      tamper(executor.session);
      const brainCalls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain(
          [{ type: "read_text", path: "src/app.js" }],
          brainCalls,
        ),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle({ limit: 1, roleId: "developer" });

      assert.equal(result.outcomes[0].status, "fenced");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.equal(brainCalls.length, 0);
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("session conflict-source tampering fences before brain or executor actions", async (t) => {
  const cases = [
    ["missing", (session) => delete session.executionSource],
    ["added field", (session) => {
      session.executionSource = {
        ...session.executionSource,
        forged: true,
      };
    }],
    ["preparation", (session) => {
      session.executionSource.preparationBinding.preparationId = "f".repeat(64);
    }],
    ["write scope", (session) => {
      session.executionSource.writeScope.paths = ["src/other.js"];
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const inputBinding = conflictInputBinding();
      const executionSource = conflictExecutionSource(inputBinding);
      const initial = job({
        grant: grant({
          schemaVersion: 3,
          inputBinding,
          executionSource,
          writablePaths: ["src/app.js"],
        }),
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
          uncertainty: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      tamper(executor.session);
      const brainCalls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain(
          [{ type: "read_text", path: "src/app.js" }],
          brainCalls,
        ),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle({ limit: 1, roleId: "developer" });

      assert.equal(result.outcomes[0].status, "fenced");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.equal(brainCalls.length, 0);
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("failed, running, and absent executor results cannot bypass the PR Head fence", async (t) => {
  const inputBinding = pullRequestInputBinding();

  await t.test("failed session", async () => {
    const initial = job({
      grant: grant({ inputBinding }),
      status: "active",
      revision: 3,
      execution: {
        ...job().execution,
        sessionId: job().jobId,
        workspaceRevision: REVISION_A,
      },
    });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], { sessionStatus: "failed" });
    executor.session.inputBinding.headRefOid = "4".repeat(40);
    executor.session.error = { code: "FAILED", message: "wrong Head" };
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(result.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  });

  for (const status of ["running", "absent"]) {
    await t.test(`${status} reconciliation`, async () => {
      const action = {
        type: "read_text",
        actionId: `head-fence-${status}`,
        expectedWorkspaceRevision: REVISION_A,
        path: "src/app.js",
      };
      const actionDigest = digestValue(action);
      const initial = job({
        grant: grant({ inputBinding }),
        status: "unknown",
        revision: 7,
        execution: {
          ...job().execution,
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          pendingAction: {
            turn: 1,
            actionId: action.actionId,
            actionDigest,
            action,
            preparedAt: "2026-08-01T00:00:01.000Z",
          },
          actionAdmission: {
            actionId: action.actionId,
            actionDigest,
            epoch: 6,
            admittedAt: "2026-08-01T00:00:01.500Z",
          },
          uncertainty: {
            from: "active",
            code: "AUDIT_BACKEND_UNAVAILABLE",
            at: "2026-08-01T00:00:02.000Z",
          },
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      executor.session.inputBinding.headRefOid = "5".repeat(40);
      if (status === "running") {
        executor.session.actions.push({
          id: action.actionId,
          type: action.type,
          status: "running",
          attemptNumber: 1,
          workspaceRevisionBefore: REVISION_A,
          workspaceRevisionAfter: null,
          error: null,
        });
      }
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain([]),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle();

      assert.equal(result.outcomes[0].status, "unknown");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.notEqual(
        (await store.getForWorker(initial.jobId)).execution.actionAdmission,
        null,
      );
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("start and resume responses cannot change the sealed input binding", async (t) => {
  const inputBinding = pullRequestInputBinding();

  await t.test("start omits binding", async () => {
    const initial = job({ grant: grant({ inputBinding }) });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial);
    delete executor.session.inputBinding;
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(
      result.outcomes[0].code,
      "CODE_JOB_SESSION_BINDING_INVALID",
    );
    assert.equal(brainCalls.length, 0);
    assert.equal(
      executor.calls.some(({ method }) => method === "perform"),
      false,
    );
  });

  await t.test("resume changes Head", async () => {
    const initial = job({
      grant: grant({ inputBinding }),
      status: "starting",
      revision: 2,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: null,
        turn: 0,
        pendingAction: null,
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
        uncertainty: null,
      },
    });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], {
      sessionStatus: "interrupted",
    });
    executor.exists = true;
    const resume = executor.resume.bind(executor);
    executor.resume = async (value) => {
      const session = await resume(value);
      session.inputBinding.headRefOid = "5".repeat(40);
      return session;
    };
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(
      result.outcomes[0].code,
      "CODE_JOB_SESSION_BINDING_INVALID",
    );
    assert.equal(brainCalls.length, 0);
    assert.equal(
      executor.calls.some(({ method }) => method === "perform"),
      false,
    );
  });
});

test("durable admission is the authorization cutover for one immutable action", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  let revoked = false;
  store.afterAdmit = async () => {
    revoked = true;
  };
  const grantVerifier = {
    async verify(value) {
      events.push("verify");
      if (revoked) {
        throw Object.assign(new Error("authority changed after admission"), {
          code: "INVALID_CODE_JOB_AUTHORITY",
        });
      }
      return structuredClone(value);
    },
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain(
      [{ type: "read_text", path: "src/app.js" }],
      brainCalls,
    ),
    grantVerifier,
  });

  const admittedCycle = await worker.runCycle({ limit: 1 });
  const performCount = executor.calls.filter(
    ({ method }) => method === "perform",
  ).length;
  const fencedCycle = await worker.runCycle({ limit: 1 });

  assert.equal(admittedCycle.outcomes[0].actionType, "read_text");
  assert.equal(performCount, 1);
  assert.equal(fencedCycle.outcomes[0].status, "fenced");
  assert.equal(fencedCycle.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.equal(
    executor.calls.filter(({ method }) => method === "perform").length,
    1,
  );
  assert.equal(brainCalls.length, 1);
});

test("configuration activation and action admission resolve revocation races", async (t) => {
  function preparedJob(actionId) {
    const action = {
      type: "list_files",
      actionId,
      expectedWorkspaceRevision: REVISION_A,
      path: "",
    };
    return job({
      status: "active",
      revision: 3,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: REVISION_A,
        turn: 0,
        pendingAction: {
          turn: 1,
          actionId,
          actionDigest: digestValue(action),
          action,
          preparedAt: "2026-08-01T00:00:01.000Z",
        },
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
      },
    });
  }

  function activeVerifier(activeVersion, events) {
    return {
      async verify(value) {
        events.push(`verify-v${activeVersion()}`);
        if (activeVersion() !== 1) {
          throw Object.assign(new Error("configuration authority changed"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    };
  }

  await t.test("activation first fences the waiting action", async () => {
    const gate = new ActionAdmissionGate();
    gate.bindEffective({
      version: 1,
      configurationDigest: "1".repeat(64),
    });
    const activationEntered = deferred();
    const releaseActivation = deferred();
    let activeVersion = 1;
    const activation = gate.run(async () => {
      activationEntered.resolve();
      await releaseActivation.promise;
      activeVersion = 2;
    });
    await activationEntered.promise;

    const events = [];
    const initial = preparedJob("activation-first-action");
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial, events);
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: activeVerifier(() => activeVersion, events),
      actionAdmissionGate: gate,
    });
    const cycle = worker.runCycle();

    await Promise.resolve();
    assert.equal(events.includes("admit"), false);
    releaseActivation.resolve();
    await activation;
    const result = await cycle;

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
    assert.equal(events.includes("admit"), false);
    assert.equal(events.includes("executor.perform"), false);
  });

  await t.test("admission first preserves only its immutable action", async () => {
    const gate = new ActionAdmissionGate();
    gate.bindEffective({
      version: 1,
      configurationDigest: "1".repeat(64),
    });
    let activeVersion = 1;
    const events = [];
    const initial = preparedJob("admission-first-action");
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial, events);
    const admissionPersisted = deferred();
    const releaseAdmission = deferred();
    store.afterAdmit = async () => {
      admissionPersisted.resolve();
      await releaseAdmission.promise;
    };
    const performEntered = deferred();
    const releasePerform = deferred();
    const perform = executor.perform.bind(executor);
    executor.perform = async (...args) => {
      performEntered.resolve();
      await releasePerform.promise;
      return perform(...args);
    };
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: activeVerifier(() => activeVersion, events),
      actionAdmissionGate: gate,
    });
    const cycle = worker.runCycle();
    await admissionPersisted.promise;
    const activation = gate.run(() => {
      activeVersion = 2;
    });

    await Promise.resolve();
    assert.equal(activeVersion, 1);
    releaseAdmission.resolve();
    await performEntered.promise;
    await activation;
    assert.equal(activeVersion, 2);
    releasePerform.resolve();
    const first = await cycle;
    const second = await worker.runCycle();

    assert.equal(first.outcomes[0].actionType, "list_files");
    assert.equal(second.outcomes[0].status, "fenced");
    assert.equal(
      executor.calls.filter(({ method }) => method === "perform").length,
      1,
    );
  });
});

test("pause during admitted session start waits for start reconciliation", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const entered = deferred();
  const release = deferred();
  const start = executor.start.bind(executor);
  executor.start = async (value) => {
    entered.resolve();
    await release.promise;
    return start(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events),
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const starting = await store.getForWorker(initial.jobId);
  const pausing = await store.pause({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "pause session start",
  });
  release.resolve();
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.pause.from, "active");
  assert.equal(stored.execution.workspaceRevision, REVISION_A);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
});

test("write actions receive only a trusted current-revision file hash", async () => {
  const readAction = {
    type: "read_text",
    actionId: "read-current",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const readObservation = observation(readAction, {
    result: {
      path: "src/app.js",
      content: "old",
      sha256: FILE_SHA,
      bytes: 3,
      truncated: false,
    },
  });
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [readObservation],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([
      { type: "write_text", path: "src/app.js", content: "new" },
    ], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  const action = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.equal(action.expectedSha256, FILE_SHA);
  assert.equal(action.expectedWorkspaceRevision, REVISION_A);
  const modelContext = JSON.stringify(brainCalls[0]);
  for (const forbidden of [FILE_SHA, "actionId", "profileId", "workspaceRevision"]) {
    assert.equal(modelContext.includes(forbidden), false);
  }
});

function trustedRead(content, { id = "read-current", truncated = false } = {}) {
  return observation({
    type: "read_text",
    actionId: id,
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  }, { result: {
    path: "src/app.js", content, sha256: FILE_SHA,
    bytes: Buffer.byteLength(content), truncated,
  } });
}

test("native code reading receives full audited text outside the compact model preview", async () => {
  const content = "\uFEFF" + "字\\\"".repeat(24 * 1024) + "\nFILE_END";
  const raw = {
    path: "src/app.js", content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content),
  };
  const readAction = {
    type: "read_text", actionId: "full-read-current",
    expectedWorkspaceRevision: REVISION_A, path: raw.path,
  };
  const audited = { action: {
    id: readAction.actionId, type: "read_text", status: "succeeded", attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A, workspaceRevisionAfter: REVISION_A,
    error: null,
  }, result: raw };
  const read = observation(readAction, { result: observationDetail(readAction, {
    session: { status: "active", attempt: { number: 1 } }, action: audited.action,
  }, raw).result });
  const unrelated = observation({ type: "list_files", actionId: "list-later",
    path: "", expectedWorkspaceRevision: REVISION_A }, { result: { files: [raw.path] } });
  const initial = job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: 2, observations: [read, unrelated],
  } });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const getActionResult = executor.getActionResult.bind(executor);
  executor.getActionResult = async (value) => {
    if (value.actionId !== readAction.actionId) return getActionResult(value);
    executor.calls.push({ method: "getActionResult", value });
    assert.deepEqual(value, { sessionId: initial.jobId, actionId: readAction.actionId });
    return structuredClone(audited);
  };
  let codeReadContext;
  const directory = {
    describe: () => ({ supportsCodeReading: true }),
    async decide(value) {
      codeReadContext = value.codeReadContext;
      assert.equal(value.observations.some(({ actionType }) => actionType === "read_text"), false);
      assert.deepEqual(describeCodeReadContext(codeReadContext), {
        documents: [{ path: raw.path, bytes: raw.bytes }],
      });
      const reader = beginCodeReadSession(codeReadContext);
      let offset = 0;
      let actual = "";
      do {
        const page = reader.readDocument(raw.path, offset, 16_000);
        actual += page.text;
        offset = page.nextOffset;
      } while (offset !== null);
      reader.assertComplete();
      reader.commit();
      reader.close();
      assert.equal(actual, content);
      assert.equal(actual[0], "\uFEFF");
      assert.match(actual, /FILE_END$/);
      return { schemaVersion: 1, confidence: 90, summary: "Read fixed profile", reason: "Verify",
        action: { type: "run_profile" } };
    },
  };
  const worker = new CodeJobWorkerService({
    jobStore: store, executor, brainDirectory: directory, grantVerifier: verifier([]), observationLimit: 1,
  });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].actionType, "run_profile");
  assert.ok(codeReadContext, "complete audited code must be available through the opaque read context");
  assert.equal(executor.calls.filter(({ method }) => method === "getActionResult").length, 2);
});

function fullAuditRead(content, { id = "full-read-current", path = "src/app.js", workspaceRevision = REVISION_A } = {}) {
  const action = { type: "read_text", actionId: id, expectedWorkspaceRevision: workspaceRevision, path };
  const audited = { action: {
    id, type: "read_text", status: "succeeded", attemptNumber: 1,
    workspaceRevisionBefore: workspaceRevision, workspaceRevisionAfter: workspaceRevision, error: null,
  }, result: { path, content, sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content) } };
  const read = observation(action, { workspaceRevision, result: observationDetail(action, {
    session: { status: "active", attempt: { number: 1 } }, action: audited.action,
  }, audited.result).result });
  return { action, audited, read };
}

function auditedReadExecutor(initial, reads) {
  const executor = new FakeExecutor(initial);
  const normalGet = executor.getActionResult.bind(executor);
  executor.getActionResult = async (value) => {
    const read = reads.find(({ action }) => action.actionId === value.actionId);
    if (!read) return normalGet(value);
    executor.calls.push({ method: "getActionResult", value: structuredClone(value) });
    return structuredClone(read.audited);
  };
  return executor;
}

function currentReadJob(observations) {
  return job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: observations.length, observations,
  } });
}

function concurrentWorkerFixture(count, decide, concurrency, continuous = false) {
  const makeJob = index => {
    const value = currentReadJob([]);
    value.jobId = `code-job-${String(index + 1).repeat(55)}`;
    value.sequence = index + 1;
    value.execution.sessionId = value.jobId;
    value.grant.objective = `job-${index + 1}`;
    return value;
  };
  const initial = Array.from({ length: count }, (_, index) => makeJob(index));
  const jobs = new FakeJobStore(initial);
  const listRunnable = jobs.listRunnable.bind(jobs);
  jobs.listRunnable = async query => {
    const page = await listRunnable({ ...query, limit: 100 });
    const cursor = query.afterSequence ?? 0;
    return { ...page, items: [...page.items.filter(job => job.sequence > cursor), ...page.items.filter(job => job.sequence <= cursor)].slice(0, query.limit) };
  };
  const executors = new Map(initial.map(value => [value.jobId, new FakeExecutor(value)]));
  const executor = Object.fromEntries(['start', 'view', 'resume', 'perform', 'getActionResult', 'reconcileAction', 'reconcileCancellation']
    .map(method => [method, (value, options) => executors.get(value.sessionId)[method](value, options)]));
  const worker = new CodeJobWorkerService({ jobStore: jobs, executor, brainDirectory: { decide,
    ...(continuous ? { describe: () => ({ supportsCodeExecution: true }) } : {}) },
    grantVerifier: verifier([]), ...(concurrency === undefined ? {} : { concurrency }) });
  return { worker, jobs, initial, executors, executor, addJob() {
    const value = makeJob(initial.length);
    initial.push(value); jobs.jobs.set(value.jobId, structuredClone(value)); executors.set(value.jobId, new FakeExecutor(value));
    return value;
  } };
}

test('an idle managed execution slot admits a later job before the original long job finishes', async () => {
  const release = Array.from({ length: 3 }, deferred), entered = [], owned = [], polls = [];
  let active = 0, maximum = 0;
  const f = concurrentWorkerFixture(1, async ({ task }) => {
    const index = Number(task.objective.slice(-1)) - 1;
    entered.push(index); active += 1; maximum = Math.max(maximum, active);
    await release[index].promise; active -= 1;
    return continuousDecision({ type: 'read_text', path: 'src/app.js' });
  }, 2);
  const track = operation => { const promise = Promise.resolve().then(operation); owned.push(promise); return promise; };
  const tick = () => {
    const promise = typeof f.worker.runReady === 'function' ? f.worker.runReady({ limit: 10 }, track) : f.worker.runCycle();
    polls.push(promise); return promise;
  };
  try {
    tick(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(entered, [0]);
    f.addJob(); f.addJob(); tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(entered, [0, 1], 'the second lane must discover work created after the first poll');
    await tick(); assert.deepEqual(entered, [0, 1], 'capacity and same-job exclusion survive duplicate polls');
    release[1].resolve(); await new Promise(resolve => setImmediate(resolve));
    await tick(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(entered, [0, 1, 2]); assert.equal(maximum, 2);
  } finally { release.forEach(value => value.resolve()); await Promise.allSettled([...polls, ...owned]); }
});

test('a known failed preparation is settled while the managed model lane remains occupied', async () => {
  const release = deferred(), owned = []; let decisions = 0;
  const f = concurrentWorkerFixture(1, async () => {
    decisions++; await release.promise;
    return continuousDecision({ type: 'read_text', path: 'src/app.js' });
  }, 1);
  const owner = operation => { const promise = Promise.resolve().then(operation); owned.push(promise); return promise; };
  try {
    await f.worker.runReady({ limit: 10 }, owner);
    await new Promise(resolve => setImmediate(resolve));
    const failed = f.addJob();
    f.jobs.jobs.get(failed.jobId).status = 'starting';
    const executor = f.executors.get(failed.jobId);
    executor.session.status = 'failed';
    executor.session.error = { code: 'CONTROLLED_GIT_PREFLIGHT_FAILED', message: 'Snapshot preflight failed' };
    const result = await f.worker.runReady({ limit: 1 }, owner);
    assert.equal((await f.jobs.getForWorker(failed.jobId)).status, 'failed');
    assert.equal((await f.jobs.getForWorker(failed.jobId)).execution.result.detail.code, 'CONTROLLED_GIT_PREFLIGHT_FAILED');
    assert.equal(decisions, 1, 'settling a host failure must not invoke another model');
    assert.equal(result.active, 1, 'the original model owner remains active');
  } finally { release.resolve(); await Promise.allSettled(owned); }
});

for (const [name, change] of [
  ['active owner', f => { f.run.active = true; }],
  ['owner hold', f => { f.run.mode = 'paused'; }],
  ['owner command', f => { f.run.pendingCommand = 'pause'; }],
  ['unconfirmed stop', f => { f.run.stopUnconfirmed = true; }],
  ['job paused', f => { f.job.status = 'paused'; }],
  ['pending action', f => { f.job.execution.pendingAction = {}; }],
  ['admitted action', f => { f.job.execution.actionAdmission = {}; }],
  ['unknown action', f => { f.job.execution.uncertainty = {}; }],
  ['mismatched session', f => { f.session.id = 'other-job'; }],
  ['preparing session', f => { f.session.status = 'preparing'; }],
  ['authority revoked', f => { f.verify = async () => { throw Object.assign(new Error('revoked'), { code: 'INVALID_CODE_JOB_AUTHORITY' }); }; }],
  ['concurrent owner pause', f => { f.verify = async value => { f.job.status = 'paused'; f.job.revision++; return value; }; }],
]) test(`failed preparation maintenance preserves ${name}`, async () => {
  const f = concurrentWorkerFixture(1, async () => assert.fail('no model needed'), 1);
  const job = f.jobs.jobs.get(f.initial[0].jobId), session = f.executors.get(job.jobId).session;
  job.status = 'starting'; session.status = 'failed';
  session.error = { code: 'CONTROLLED_GIT_PREFLIGHT_FAILED' };
  const context = { job, session, run: { active: false, mode: 'active', pendingCommand: null, stopUnconfirmed: false }, verify: async value => value };
  change(context);
  const worker = new CodeJobWorkerService({ jobStore: f.jobs, executor: f.executor,
    brainDirectory: { async decide() { assert.fail('no model needed'); } },
    taskRuns: { async get() { return context.run; }, async order() { return []; } },
    grantVerifier: { verify: context.verify } });
  await worker.runReady({ limit: 1 }, () => assert.fail('no model owner needed'));
  assert.notEqual((await f.jobs.getForWorker(job.jobId)).status, 'failed');
});

test('managed jobs keep independent abort signals and release a rejected owner reservation', async () => {
  const releases = [deferred(), deferred()], signals = [], owned = [];
  const controllers = [new AbortController(), new AbortController()];
  const f = concurrentWorkerFixture(1, async ({ task }, { signal }) => {
    const index = Number(task.objective.slice(-1)) - 1;
    signals[index] = signal;
    await releases[index].promise;
    signal.throwIfAborted();
    return continuousDecision({ type: 'read_text', path: 'src/app.js' });
  }, 2);
  const owner = operation => { const running = Promise.resolve().then(operation); owned.push(running); return running; };
  try {
    await assert.rejects(f.worker.runReady({ limit: 1 }, () => { throw new Error('owner closed'); }), /owner closed/);
    assert.equal(signals.length, 0);
    await f.worker.runReady({ limit: 1, signal: controllers[0].signal }, owner);
    await new Promise(resolve => setImmediate(resolve));
    f.addJob();
    await f.worker.runReady({ limit: 1, signal: controllers[1].signal }, owner);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(signals[0], controllers[0].signal);
    assert.strictEqual(signals[1], controllers[1].signal);
    controllers[0].abort(new Error('first job stopped'));
    assert.equal(signals[1].aborted, false);
    releases.forEach(value => value.resolve());
    const results = await Promise.allSettled(owned);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal((await f.jobs.getForWorker(f.initial[1].jobId)).execution.turn, 1);
  } finally { releases.forEach(value => value.resolve()); await Promise.allSettled(owned); }
});

test('managed cancellation reaches only its active continuous worker and retains late execution ownership', async () => {
  const release = deferred(), signals = [], owned = [];
  const controller = new AbortController();
  const f = concurrentWorkerFixture(2, async ({ task }, { signal }) => {
    signals[Number(task.objective.slice(-1)) - 1] = signal;
    await release.promise;
    signal.throwIfAborted();
  }, 2, true);
  let settled = 0;
  const owner = operation => {
    const running = Promise.resolve().then(operation).finally(() => { settled += 1; });
    running.catch(() => {}); owned.push(running); return running;
  };
  try {
    await f.worker.runReady({ limit: 2, signal: controller.signal }, owner);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signals.length, 2);
    assert.equal(f.worker.requestCancellation(f.initial[0].jobId), true);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    assert.equal(f.worker.requestCancellation('code-job-absent'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, 0, 'an abort signal does not prove the admitted executions stopped');
    controller.abort(new Error('shutdown'));
    assert.equal(signals[1].aborted, true);
    release.resolve(); await Promise.allSettled(owned);
    assert.equal(settled, 2);
  } finally { controller.abort(); release.resolve(); await Promise.allSettled(owned); }
});

test('bounded worker concurrency lets queued jobs progress while one decision remains active', async () => {
  const entered = Array.from({ length: 3 }, deferred), release = Array.from({ length: 3 }, deferred);
  const started = [], finished = []; let active = 0, maximum = 0;
  const { worker, jobs, initial } = concurrentWorkerFixture(3, async ({ task }) => {
    const index = Number(task.objective.slice(-1)) - 1;
    started.push(index); active += 1; maximum = Math.max(maximum, active); entered[index].resolve();
    await release[index].promise;
    active -= 1; finished.push(index);
    return { schemaVersion: 1, confidence: 90, summary: 'Read code', reason: 'Inspect the bound source', action: { type: 'read_text', path: 'src/app.js' } };
  }, 2);
  let settled = false; const running = worker.runCycle().finally(() => { settled = true; });
  try {
    await entered[0].promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1]);
    release[1].resolve(); await entered[2].promise;
    release[2].resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(finished, [1, 2]); assert.equal(maximum, 2); assert.equal(settled, false);
    assert.equal((await jobs.getForWorker(initial[1].jobId)).execution.turn, 1);
    assert.equal((await jobs.getForWorker(initial[0].jobId)).execution.turn, 0);
    release[0].resolve();
    const result = await running;
    assert.deepEqual(result.outcomes.map(value => value.jobId), initial.map(value => value.jobId));
    assert.equal(result.processed, 3);
  } finally { release.forEach(value => value.resolve()); await running; }
});

for (const continuous of [false, true]) test(`concurrent ${continuous ? 'continuous' : 'single-turn'} worker abort waits for owned late decisions and does not start another queued job`, async () => {
  const entered = [], release = Array.from({ length: 2 }, deferred), controller = new AbortController();
  const reason = new Error('stop this cycle');
  const { worker } = concurrentWorkerFixture(3, async ({ task }, { signal }) => {
    entered.push(task.objective);
    await release[Number(task.objective.slice(-1)) - 1].promise;
    signal.throwIfAborted();
  }, 2, continuous);
  let settled = false;
  const running = worker.runCycle({ signal: controller.signal }).then(() => null, error => error).finally(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(entered.length, 2);
    controller.abort(reason);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release[0].resolve();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'the other admitted decision still owns late work');
    release[1].resolve(); assert.strictEqual(await running, reason);
    assert.equal(entered.length, 2);
  } finally { release.forEach(value => value.resolve()); await running; }
});

test('worker concurrency defaults to serial and rejects invalid bounds', async () => {
  const release = deferred(), entered = [];
  const decide = async ({ task }) => {
    entered.push(task.objective);
    await release.promise;
    return { schemaVersion: 1, confidence: 90, summary: 'Read code', reason: 'Inspect source', action: { type: 'read_text', path: 'src/app.js' } };
  };
  const { worker } = concurrentWorkerFixture(2, decide);
  const running = worker.runCycle();
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(entered, ['job-1']);
    release.resolve(); await running; assert.deepEqual(entered, ['job-1', 'job-2']);
  } finally { release.resolve(); await running; }
  for (const concurrency of [0, -1, 9, 1.5, '2', null]) {
    assert.throws(() => concurrentWorkerFixture(1, decide, concurrency), /concurrency/);
  }
});

test("native code reading rejects mismatched audited file bindings before deciding", async (t) => {
  const mutations = [
    ["action id", (entry) => { entry.action.id = "other-read"; }],
    ["action type", (entry) => { entry.action.type = "write_text"; }],
    ["action status", (entry) => { entry.action.status = "failed"; }],
    ["workspace before", (entry) => { entry.action.workspaceRevisionBefore = REVISION_B; }],
    ["workspace after", (entry) => { entry.action.workspaceRevisionAfter = REVISION_B; }],
    ["attempt", (entry) => { entry.action.attemptNumber = 2; }],
    ["result path", (entry) => { entry.result.path = "src/other.js"; }],
    ["result hash", (entry) => { entry.result.sha256 = FILE_SHA; }],
    ["result byte count", (entry) => { entry.result.bytes -= 1; }],
    ["truncated audit", (entry) => { entry.result.truncated = true; }],
    ["audit error", (entry) => { entry.result.error = { code: "READ_FAILED" }; }],
    ["changed full text", (entry) => {
      entry.result.content += "changed";
      entry.result.bytes = Buffer.byteLength(entry.result.content);
      entry.result.sha256 = createHash("sha256").update(entry.result.content).digest("hex");
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const read = fullAuditRead("x".repeat(80 * 1024));
      const initial = currentReadJob([read.read]);
      mutate(read.audited);
      const executor = auditedReadExecutor(initial, [read]);
      let decisions = 0;
      const worker = new CodeJobWorkerService({ jobStore: new FakeJobStore([initial]), executor,
        grantVerifier: verifier([]), brainDirectory: {
          describe: () => ({ supportsCodeReading: true }),
          decide: async () => { decisions += 1; },
        } });
      const result = await worker.runCycle();
      assert.equal(result.outcomes[0].code, "CODE_JOB_AUDIT_RESULT_INVALID");
      assert.equal(result.outcomes[0].status, "fenced");
      assert.equal(decisions, 0);
      assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
    });
  }
});

test("native code reading chooses only the latest successful read per current-revision path", async () => {
  const old = fullAuditRead("old", { id: "old" });
  const latest = fullAuditRead("\uFEFF" + "字".repeat(30 * 1024), { id: "latest" });
  const stale = fullAuditRead("stale", { id: "stale", path: "src/stale.js", workspaceRevision: REVISION_B });
  const failed = fullAuditRead("failed", { id: "failed" });
  failed.read.status = "failed";
  const initial = currentReadJob([old.read, latest.read, stale.read, failed.read]);
  const executor = auditedReadExecutor(initial, [old, latest, stale, failed]);
  let manifest;
  const worker = new CodeJobWorkerService({ jobStore: new FakeJobStore([initial]), executor,
    grantVerifier: verifier([]), observationLimit: 1, brainDirectory: {
      describe: () => ({ supportsCodeReading: true }),
      decide: async ({ codeReadContext }) => {
        manifest = describeCodeReadContext(codeReadContext);
        return { action: { type: "run_profile" } };
      },
    } });
  assert.equal((await worker.runCycle()).outcomes[0].actionType, "run_profile");
  assert.deepEqual(manifest, { documents: [{ path: "src/app.js", bytes: latest.audited.result.bytes }] });
  assert.deepEqual(executor.calls.filter(({ method, value }) => method === "getActionResult" &&
    ["old", "latest", "stale", "failed"].includes(value.actionId)).map(({ value }) => value.actionId), ["latest"]);
});

test("native full-read proof permits a large overwrite only after complete actual page coverage", async (t) => {
  for (const mode of ["complete", "partial", "uncommitted", "revoked", "aborted", "cloned"]) {
    await t.test(mode, async () => {
      const read = fullAuditRead("\uFEFF" + "字\\\"".repeat(24 * 1024));
      const initial = currentReadJob([read.read]);
      const store = new FakeJobStore([initial]);
      const executor = auditedReadExecutor(initial, [read]);
      const worker = new CodeJobWorkerService({ jobStore: store, executor, grantVerifier: verifier([]),
        brainDirectory: {
          describe: () => ({ supportsCodeReading: true }),
          async decide({ codeReadContext }) {
            if (mode === "cloned") {
              assert.throws(() => beginCodeReadSession(structuredClone(codeReadContext)));
            } else {
              const abort = new AbortController();
              const reader = beginCodeReadSession(codeReadContext, { signal: abort.signal });
              let offset = 0;
              do {
                const page = reader.readDocument(read.action.path, offset, 16_000);
                offset = page.nextOffset;
                if (mode === "partial") break;
              } while (offset !== null);
              if (mode !== "uncommitted") reader.commit();
              if (mode === "revoked") reader.revoke();
              if (mode === "aborted") abort.abort();
              reader.close();
            }
            return { action: { type: "write_text", path: read.action.path, content: "replacement\n" } };
          },
        } });
      const result = await worker.runCycle();
      const perform = executor.calls.find(({ method }) => method === "perform");
      if (mode === "complete") {
        assert.equal(result.outcomes[0].actionType, "write_text");
        assert.equal(perform.value.action.expectedSha256, read.audited.result.sha256);
        assert.equal(perform.value.action.expectedWorkspaceRevision, REVISION_A);
        assert.equal((await store.getForWorker(initial.jobId)).execution.observations[0].detail.result.truncated, true);
      } else {
        assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
        assert.equal(result.outcomes[0].status, "paused");
        assert.equal(perform, undefined);
      }
    });
  }
});

test("native code reading requires actual coverage even when the original inline preview was complete", async (t) => {
  for (const complete of [false, true]) {
    await t.test(complete ? "read proof permits overwrite" : "inline preview cannot replace native proof", async () => {
      const read = fullAuditRead("small complete inline file\n");
      const initial = currentReadJob([read.read]);
      const executor = auditedReadExecutor(initial, [read]);
      const worker = new CodeJobWorkerService({ jobStore: new FakeJobStore([initial]), executor,
        grantVerifier: verifier([]), brainDirectory: {
          describe: () => ({ supportsCodeReading: true }),
          async decide({ codeReadContext, observations }) {
            assert.equal(JSON.parse(observations[0].detail).truncated, false);
            if (complete) {
              const reader = beginCodeReadSession(codeReadContext);
              reader.readDocument(read.action.path, 0);
              reader.commit();
              reader.close();
            }
            return { action: { type: "write_text", path: read.action.path, content: "replacement\n" } };
          },
        } });
      const result = await worker.runCycle();
      if (complete) {
        assert.equal(result.outcomes[0].actionType, "write_text");
        assert.equal(executor.calls.find(({ method }) => method === "perform").value.action.expectedSha256,
          read.audited.result.sha256);
      } else {
        assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
        assert.equal(result.outcomes[0].status, "paused");
        assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
      }
    });
  }
});

test("large-file write proofs bind exact job, workspace, action, path and hash", async (t) => {
  const read = fullAuditRead("x".repeat(80 * 1024));
  const initial = currentReadJob([read.read]);
  const session = new FakeExecutor(initial).session;
  const document = { actionId: read.action.actionId, ...read.audited.result };
  const cases = [
    ["same binding", {}], ["other job", { jobId: "other-job" }],
    ["other workspace", { workspaceRevision: REVISION_B }],
    ["other action", { document: { ...document, actionId: "other-read" } }],
    ["other path", { document: { ...document, path: "src/other.js" } }],
    ["other hash", { document: { ...document, content: "different", bytes: 9,
      sha256: createHash("sha256").update("different").digest("hex") } }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => {
      const context = createCodeReadContext({ jobId: change.jobId ?? initial.jobId,
        workspaceRevision: change.workspaceRevision ?? REVISION_A, documents: [change.document ?? document] });
      const reader = beginCodeReadSession(context);
      const path = (change.document ?? document).path;
      let offset = 0;
      do { offset = reader.readDocument(path, offset).nextOffset; } while (offset !== null);
      reader.commit();
      reader.close();
      const bind = () => bindTrustedAction(initial, session,
        { type: "write_text", path: read.action.path, content: "replacement" }, [], [], context);
      const prepared = { type: "write_text", path: read.action.path, expectedSha256: read.audited.result.sha256 };
      const assertPrepared = () => assertPreparedWriteRead(initial, session, prepared, [], context);
      if (name === "same binding") {
        assert.equal(bind().expectedSha256, read.audited.result.sha256);
        assert.doesNotThrow(assertPrepared);
      } else {
        assert.throws(bind, { code: "CODE_BRAIN_INCOMPLETE_READ" });
        assert.throws(assertPrepared, { code: "CODE_BRAIN_INCOMPLETE_READ" });
      }
    });
  }
});

test("incomplete native artifact reading pauses without misclassifying a code failure", async () => {
  const initial = job();
  const store = new FakeJobStore([initial]);
  const worker = new CodeJobWorkerService({ jobStore: store, executor: new FakeExecutor(initial),
    grantVerifier: verifier([]), brainDirectory: brain([
      Object.assign(new Error("Read remaining pages first"), { code: "CODE_ARTIFACT_READ_INCOMPLETE" }),
    ]) });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(result.outcomes[0].code, "CODE_ARTIFACT_READ_INCOMPLETE");
});

test("invalid native artifact reader pauses without indefinitely retrying", async () => {
  const initial = job();
  const store = new FakeJobStore([initial]);
  const calls = [];
  const worker = new CodeJobWorkerService({ jobStore: store, executor: new FakeExecutor(initial),
    grantVerifier: verifier([]), brainDirectory: brain([
      Object.assign(new Error("Artifact reader validation failed"), { code: "CODE_ARTIFACT_READ_INVALID" }),
    ], calls) });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(result.outcomes[0].code, "CODE_ARTIFACT_READ_INVALID");
  await worker.runCycle();
  assert.equal(calls.length, 1);
});

test("native capable recovery cannot reconstruct proof for a durable prepared large overwrite", async () => {
  const read = fullAuditRead("x".repeat(80 * 1024));
  const initial = currentReadJob([read.read]);
  const action = { type: "write_text", actionId: "prepared-native-overwrite",
    path: read.action.path, content: "replacement", expectedWorkspaceRevision: REVISION_A,
    expectedSha256: read.audited.result.sha256 };
  initial.execution.pendingAction = {
    turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action,
    preparedAt: "2026-08-01T00:00:01.000Z",
  };
  const executor = auditedReadExecutor(initial, [read]);
  const store = new FakeJobStore([initial]);
  const worker = new CodeJobWorkerService({ jobStore: store, executor, grantVerifier: verifier([]),
    brainDirectory: {
      describe: () => ({ supportsCodeReading: true }),
      decide: () => { assert.fail("prepared action recovery must not ask for a new decision"); },
    } });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(executor.calls.some(({ method }) => ["perform", "getActionResult"].includes(method)), false);
  assert.deepEqual((await store.getForWorker(initial.jobId)).execution.pendingAction.action, action);
});

test("read observations report every content truncation to the model", async (t) => {
  for (const content of ["x".repeat(30 * 1024), "字".repeat(10 * 1024)]) {
    await t.test(`UTF-8 bytes ${Buffer.byteLength(content)}`, () => {
      const rendered = JSON.parse(modelObservation(trustedRead(content)).detail);
      assert.equal(rendered.truncated, true);
      assert.ok(Buffer.byteLength(rendered.content) <= 24 * 1024);
      assert.equal(rendered.content.includes("\uFFFD"), false);
    });
  }
  const read = trustedRead("prefix", { truncated: true });
  const detail = observationDetail(read.action, {
    session: { status: "active", attempt: { number: 1 } },
    action: { status: "succeeded", attemptNumber: 1 },
  }, read.detail.result);
  assert.equal(detail.result.truncated, true);
});

test("whole-file writes pause when the latest trusted read is not fully visible", async (t) => {
  const large = "x".repeat(30 * 1024);
  const unrelated = observation({
    type: "list_files", path: "", actionId: "list-later",
    expectedWorkspaceRevision: REVISION_A,
  }, { result: { files: ["src/app.js"] } });
  const cases = [
    { name: "30 KiB read", observations: [trustedRead(large)] },
    { name: "UTF-8 read", observations: [trustedRead("字".repeat(10 * 1024))] },
    { name: "executor truncated read", observations: [trustedRead("prefix", { truncated: true })] },
    { name: "escaped JSON exceeds detail limit", observations: [trustedRead("\"".repeat(20 * 1024))] },
    { name: "latest incomplete read shadows complete read", observations: [trustedRead("old", { id: "older-read" }), trustedRead(large)] },
    { name: "observation history omitted", observations: [trustedRead("old"), unrelated], observationLimit: 1 },
    { name: "packer summarizes read", observations: [trustedRead("old"), ...Array.from({ length: 6 }, (_, i) => observation({
      type: "read_text", path: `test/other-${i}.js`, actionId: `other-${i}`,
      expectedWorkspaceRevision: REVISION_A,
    }, { result: { content: "x".repeat(24 * 1024), truncated: false } }))] },
    { name: "packer omits all observations", observations: [trustedRead("old")], fillFixedContext: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const initial = job({ status: "active", execution: {
        ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
        turn: scenario.observations.length, observations: scenario.observations,
      } });
      if (scenario.fillFixedContext) {
        const fixed = {
          task: {
            operation: initial.grant.operation, repository: initial.grant.repository,
            objective: "", acceptanceCriteria: initial.grant.acceptanceCriteria,
            evidence: initial.grant.evidence,
          },
          capabilities: {
            allowedActions: initial.grant.allowedActions, writablePaths: initial.grant.writablePaths,
            requiredProfilesRemaining: 1,
          },
          turn: initial.execution.turn + 1, observations: [],
        };
        initial.grant.objective = "x".repeat(128 * 1024 - Buffer.byteLength(JSON.stringify(fixed)) - 10);
      }
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      const calls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store, executor, grantVerifier: verifier([]),
        brainDirectory: brain([{ type: "write_text", path: "src/app.js", content: "replacement" }], calls),
        ...(scenario.observationLimit ? { observationLimit: scenario.observationLimit } : {}),
      });
      const result = await worker.runCycle();
      assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
      assert.equal(result.outcomes[0].status, "paused");
      assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
      const stored = await store.getForWorker(initial.jobId);
      assert.match(stored.execution.pause.reason, /src\/app\.js/);
      assert.equal(stored.execution.pause.reason.includes("replacement"), false);
    });
  }
});

test("absent legacy prepared overwrite requires a fully visible trusted read", async () => {
  const action = {
    type: "write_text", path: "src/app.js", content: "replacement",
    actionId: "legacy-overwrite", expectedWorkspaceRevision: REVISION_A,
    expectedSha256: FILE_SHA,
  };
  const initial = job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: 1, observations: [trustedRead("x".repeat(30 * 1024))],
    pendingAction: {
      turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action,
      preparedAt: "2026-08-01T00:00:01.000Z",
    },
  } });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store, executor, grantVerifier: verifier([]), brainDirectory: brain([]),
  });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.deepEqual(executor.calls.find(({ method }) => method === "reconcileAction").value.action, action);
  assert.deepEqual((await store.getForWorker(initial.jobId)).execution.pendingAction.action, action);
});

function automaticReadRecoveryFixture() {
  const action = { type: 'write_text', path: 'src/app.js', content: 'old candidate',
    actionId: 'legacy-auto-write', expectedWorkspaceRevision: REVISION_A, expectedSha256: FILE_SHA };
  const initial = job({ status: 'active', execution: { ...job().execution, sessionId: job().jobId,
    workspaceRevision: REVISION_A, turn: 1, observations: [trustedRead('x'.repeat(30 * 1024))],
    pendingAction: { turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action,
      preparedAt: '2026-08-01T00:00:01.000Z' } } });
  const store = new FakeJobStore([initial]), executor = new FakeExecutor(initial);
  const directory = brain([{ type: 'read_text', path: 'src/app.js' },
    { type: 'write_text', path: 'src/app.js', content: 'fresh candidate' }]);
  const options = { jobStore: store, executor, brainDirectory: directory,
    grantVerifier: verifier([]), unstartedWriteRecovery: { async canRecover() { return true; } } };
  return { action, initial, store, executor, directory, options, worker: () => new CodeJobWorkerService(options) };
}

test("automatic recovery rejects an absent legacy overwrite and replans through a fresh complete read", async (t) => {
  for (const managed of [false, true]) await t.test(managed ? 'managed child worker' : 'ordinary worker', async () => {
  const { action, initial, store, executor, directory, worker: createWorker } = automaticReadRecoveryFixture();
  const worker = createWorker();
  const run = async () => {
    if (!managed) return worker.runCycle();
    let operation;
    await worker.runReady({ limit: 1 }, callback => { operation = callback(); return operation; });
    return operation;
  };
  const first = await run();
  assert.equal(first.outcomes[0].status, 'active');
  assert.equal(first.outcomes[0].code, 'CODE_BRAIN_INCOMPLETE_READ');
  assert.equal(executor.calls.some(x => x.method === 'perform'), false);
  const rejected = await store.getForWorker(initial.jobId);
  assert.equal(rejected.execution.pendingAction, null);
  assert.equal(rejected.execution.turn, 2);
  assert.equal(rejected.execution.workspaceRevision, REVISION_A);
  const audit = rejected.execution.observations.at(-1);
  assert.equal(audit.status, 'failed');
  assert.equal(audit.detail.origin, 'host_pre_execution_rejection');
  assert.equal(audit.detail.notExecuted, true);
  assert.deepEqual(audit.action, action, 'retain the old candidate as history, never replay it');
  assert.equal(JSON.parse(modelObservation(audit).detail).notExecuted, true);
  await run();
  await run();
  const performed = executor.calls.filter(x => x.method === 'perform').map(x => x.value.action);
  assert.deepEqual(performed.map(x => x.type), ['read_text', 'write_text']);
  assert.notEqual(performed[1].actionId, action.actionId);
  assert.equal(performed[1].content, 'fresh candidate');
  assert.equal(directory.calls.length, 2);
  });
});

test('automatic read recovery cannot discard admitted, uncertain, busy or drifted writes', async (t) => {
  for (const [name, change] of [
    ['not automatically authorized', f => { f.options.unstartedWriteRecovery.canRecover = async () => false; }],
    ['admitted', f => { f.initial.execution.actionAdmission = { actionId: f.action.actionId,
      actionDigest: digestValue(f.action), epoch: 1, admittedAt: '2026-08-01T00:00:01.500Z' };
      f.options.jobStore = new FakeJobStore([f.initial]); }],
    ['unknown action settles before any rejection', f => {
      f.initial.status = 'unknown';
      f.initial.execution.actionAdmission = { actionId: f.action.actionId, actionDigest: digestValue(f.action),
        epoch: 1, admittedAt: '2026-08-01T00:00:01.500Z' };
      f.initial.execution.uncertainty = { from: 'active', code: 'LOST_ACK', message: 'Uncertain action', at: '2026-08-01T00:00:02.000Z' };
      f.options.jobStore = new FakeJobStore([f.initial]);
    }],
    ['running executor action', f => { f.executor.reconcileAction = async () => ({ status: 'running', session: structuredClone(f.executor.session) }); }],
    ['workspace changed during policy read', f => { f.options.unstartedWriteRecovery.canRecover = async () => {
      f.executor.session.workspaceRevision = REVISION_B; return true; }; }],
    ['owner pause at mutation admission', f => { f.options.actionAdmissionGate = { async run(operation) {
      const job = await f.store.getForWorker(f.initial.jobId);
      await f.store.pause({ jobId: job.jobId, expectedRevision: job.revision, reason: 'owner pause' });
      return operation(); } }; }],
  ]) await t.test(name, async () => {
    const f = automaticReadRecoveryFixture(); change(f);
    const worker = f.worker();
    await worker.runCycle();
    const stored = await f.options.jobStore.getForWorker(f.initial.jobId);
    assert.equal(stored.execution.observations.some(x => x.detail.origin === 'host_pre_execution_rejection'), false);
    assert.equal(f.executor.calls.some(x => x.method === 'perform'), false);
    assert.equal(f.directory.calls.length, 0);
    assert.equal(stored.execution.pendingAction.actionId, f.action.actionId);
  });
});

test('host read-rejection persistence failures retain or consume the old pending exactly once', async (t) => {
  for (const afterWrite of [false, true]) await t.test(afterWrite ? 'lost acknowledgement' : 'failed write', async () => {
    const f = automaticReadRecoveryFixture();
    const record = f.store.recordObservation.bind(f.store);
    let unavailable = true;
    f.store.recordObservation = async value => {
      if (!unavailable) return record(value);
      if (afterWrite) await record(value);
      throw new Error('storage unavailable');
    };
    const worker = f.worker();
    await worker.runCycle();
    const stored = await f.store.getForWorker(f.initial.jobId);
    assert.equal(stored.execution.pendingAction === null, afterWrite);
    assert.equal(f.executor.calls.some(x => x.method === 'perform'), false);
    unavailable = false;
    if (!afterWrite) await worker.runCycle();
    await worker.runCycle();
    assert.equal((await f.store.getForWorker(f.initial.jobId)).execution.observations
      .filter(x => x.detail.origin === 'host_pre_execution_rejection').length, 1);
    assert.equal(f.executor.calls.filter(x => x.method === 'perform').every(x => x.value.action.type === 'read_text'), true);
  });
});

test('real durable store resumes a host read pause, audits nonexecution and survives restart before fresh read and write', async () => {
  const storage = new IntegrationMemoryStore(), clock = () => new Date('2026-08-02T08:00:00.000Z');
  const { jobs, durableJob } = await createRealApprovedJob({ operation: 'modify',
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ['src'] }, { storage, clock });
  let current = (await jobs.claimStarting({ jobId: durableJob.jobId, expectedRevision: durableJob.revision })).job;
  current = (await jobs.activate({ jobId: current.jobId, expectedRevision: current.revision, workspaceRevision: REVISION_A })).job;
  const oldRead = trustedRead('x'.repeat(30 * 1024));
  current = (await jobs.prepareAction({ jobId: current.jobId, expectedRevision: current.revision, action: oldRead.action })).job;
  current = (await jobs.recordObservation({ jobId: current.jobId, expectedRevision: current.revision, actionId: oldRead.actionId,
    status: 'succeeded', workspaceRevision: REVISION_A, detail: oldRead.detail })).job;
  const action = { type: 'write_text', actionId: 'old-durable-write', path: 'src/app.js', content: 'old candidate',
    expectedWorkspaceRevision: REVISION_A, expectedSha256: FILE_SHA };
  current = (await jobs.prepareAction({ jobId: current.jobId, expectedRevision: current.revision, action })).job;
  current = (await jobs.pause({ jobId: current.jobId, expectedRevision: current.revision, reason: incompleteReadPauseReason(action.path) })).job;
  const proof = { runId: 'stopped-model', mode: 'active', active: false, pendingCommand: null, stopUnconfirmed: false,
    receipt: { runId: 'stopped-model', kind: 'code-job', taskId: current.jobId, roleId: 'developer', phase: 'failed',
      outcomeCode: 'STRUCTURED_PROVIDER_CANCELLED', stopConfirmed: true, registeredAt: current.createdAt,
      modelStartedAt: current.createdAt, finishedAt: current.createdAt } };
  const recovery = new AutomaticCodeJobPauseRecovery({ jobs, taskRuns: { async get() { return structuredClone(proof); } },
    eligibility: { async canRecover() { return false; }, async canReplanUnstartedWrite() { return true; } } });
  assert.equal((await recovery.runCycle()).resumed, 1);
  const executor = new FakeExecutor(await jobs.getForWorker(current.jobId));
  const directory = brain([{ type: 'read_text', path: action.path }, { type: 'write_text', path: action.path, content: 'fresh durable candidate' }]);
  const workerOptions = { executor, brainDirectory: directory, grantVerifier: verifier([]),
    unstartedWriteRecovery: { async canRecover() { return true; } } };
  const first = await new CodeJobWorkerService({ ...workerOptions, jobStore: jobs }).runCycle();
  assert.equal(first.outcomes[0].status, 'active');
  assert.equal(executor.calls.some(x => x.method === 'perform'), false);
  const restarted = new CodeJobStore({ store: storage, clock, operationQueue: new OperationQueue(),
    exclusiveLease: { run: operation => operation() } });
  await restarted.recover();
  const saved = await restarted.getForWorker(current.jobId);
  assert.equal(saved.execution.pendingAction, null);
  assert.deepEqual(saved.execution.observations.at(-1).action, action);
  const resumed = new CodeJobWorkerService({ ...workerOptions, jobStore: restarted });
  await resumed.runCycle(); await resumed.runCycle();
  const final = await restarted.getForWorker(current.jobId);
  assert.equal(final.execution.observations.filter(x => x.detail.origin === 'host_pre_execution_rejection').length, 1);
  assert.deepEqual(executor.calls.filter(x => x.method === 'perform').map(x => x.value.action.type), ['read_text', 'write_text']);
  assert.equal(executor.calls.find(x => x.method === 'perform' && x.value.action.type === 'write_text').value.action.content,
    'fresh durable candidate');
});

test("admitted legacy overwrite pauses after absent reconciliation without performing", async () => {
  const action = {
    type: "write_text", path: "src/app.js", content: "replacement",
    actionId: "admitted-legacy-overwrite", expectedWorkspaceRevision: REVISION_A,
    expectedSha256: FILE_SHA,
  };
  const initial = job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: 1, observations: [trustedRead("x".repeat(30 * 1024))],
    pendingAction: { turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action, preparedAt: "2026-08-01T00:00:01.000Z" },
    actionAdmission: { actionId: action.actionId, actionDigest: digestValue(action), epoch: 2, admittedAt: "2026-08-01T00:00:01.500Z" },
  } });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({ jobStore: store, executor, grantVerifier: verifier([]), brainDirectory: brain([]) });
  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
  // Existing recovery first reconciles the durable admission, then pauses.
  await worker.runCycle();
  await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.deepEqual(stored.execution.pendingAction.action, action);
});

test("a prepared action is retried exactly without asking the brain again", async () => {
  const pendingAction = {
    type: "list_files",
    actionId: "action-prepared",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: pendingAction.actionId,
        actionDigest: digestValue(pendingAction),
        action: pendingAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  assert.equal(brainCalls.length, 0);
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "perform").value.action,
    pendingAction,
  );
  assert.equal(events[events.indexOf("admit") - 1], "verify");
  assert.equal(events[events.indexOf("executor.perform") - 1], "admit");
});

test("a non-admitted prepared action fences once when executor authority changed", async () => {
  const action = {
    type: "list_files",
    actionId: "action-prepared-fenced",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.reconcileAction = async () => {
    throw Object.assign(new Error("profile authority changed"), {
      code: "PROFILE_CONFIG_CHANGED",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "PROFILE_CONFIG_CHANGED");
  assert.equal(second.selected, 0);
  assert.equal((await store.getForWorker(initial.jobId)).status, "fenced");
});

test("revoked authority blocks reconciliation of a newly prepared action", async () => {
  const action = {
    type: "list_files",
    actionId: "action-prepared-revoked",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const revoked = Object.assign(new Error("authority revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([], revoked),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.deepEqual(executor.calls, []);
});

test("pause winning before action admission prevents executor perform", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  store.beforeAdmit = async () => {
    const current = await store.getForWorker(initial.jobId);
    await store.pause({
      jobId: current.jobId,
      expectedRevision: current.revision,
      reason: "pause won admission",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const result = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("pause during an admitted action stays pausing until result reconciliation", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const entered = deferred();
  const release = deferred();
  const perform = executor.perform.bind(executor);
  executor.perform = async (value) => {
    entered.resolve();
    await release.promise;
    return perform(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const admitted = await store.getForWorker(initial.jobId);
  const pausing = await store.pause({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "pause in flight",
  });
  release.resolve();
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.turn, 1);
  assert.equal(stored.execution.pendingAction, null);
  assert.equal(stored.execution.actionAdmission, null);
});

async function createRealApprovedJob(grantOverrides = {}, {
  storage = new IntegrationMemoryStore(), clock = () => new Date("2026-08-02T08:00:00.000Z"),
} = {}) {
  const jobs = new CodeJobStore({
    store: storage,
    exclusiveLease: { run: (operation) => operation() },
    operationQueue: new OperationQueue(),
    clock,
    memoryReceiptVerifier: {
      async verify(value) {
        return { ...structuredClone(value), persisted: true };
      },
    },
  });
  await jobs.recover();
  const sealedGrant = createCodeJobGrant({
    proposalId: "integration-pause-proposal",
    contentDigest: "1".repeat(64),
    policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: "integration-work" },
    source: { assignmentId: "integration-assignment", eventId: "integration-event" },
    subject: {
      id: "github:acme/dashboard:pull-request:9",
      repository: "acme/dashboard",
      number: 9,
    },
    repository: "acme/dashboard",
    workspaceId: "dashboard",
    workspaceAuthorityDigest: "2".repeat(64),
    operation: "inspect",
    objective: "Inspect one file without losing an in-flight pause.",
    acceptanceCriteria: ["The admitted action is reconciled before pausing."],
    evidence: ["A pause can race an executor response."],
    summary: "Prove the durable pause boundary.",
    reason: "The worker and store need one integrated safety proof.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [{ id: "node-tests", configDigest: PROFILE_DIGEST }],
    brainDigest: "3".repeat(64),
    ...grantOverrides,
  });
  const created = await jobs.createApprovedJob({
    confirmationId: "confirmation-integration-pause",
    requestId: "request-integration-pause",
    displayedPayloadDigest: "4".repeat(64),
    approvalBindingDigest: "5".repeat(64),
    grant: sealedGrant,
  });
  const durableJob = await jobs.getForWorker(created.job.jobId);
  return {jobs,created,durableJob};
}

async function createVerifiedApprovedJob(clock) {
  let failure = null, checks = 0;
  const binding = conflictInputBinding();
  const factory = new CodeJobGrantFactory({
    executorAuthority: { workspaces: [{ id: "dashboard", capabilities: ["git_head_snapshot"],
      writablePaths: ["src", "test"], requiredProfiles: [{ id: "node-tests", configDigest: PROFILE_DIGEST }], authorityDigest: "2".repeat(64) }] },
    policyVersion: 1, workspaceByRepository: { "acme/dashboard": "dashboard" },
    codeActionRoles: ["developer"], codeOperationsByRole: { developer: ["inspect"] },
    taskBrainByRole: { developer: { provider: "ollama", model: "test-model", remoteData: { requirements: false, code: false, memory: false } } },
    brainProviders: { ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" } },
    inputAuthorityVerifier: { verify(value) { checks++; if (failure) throw failure; return structuredClone(value); } },
  });
  const { grant: sealed } = factory.create(normalizeBoundWorkProposal({
    proposalId: "verified-worker-proposal", policyVersion: 1, kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: binding.rootItemId },
    source: { assignmentId: "verified-worker-assignment", eventId: binding.eventId },
    binding: { eventId: binding.eventId, subject: { id: "github:pr:acme/dashboard#42", repository: "acme/dashboard", number: 42 },
      repository: "acme/dashboard", workspaceId: "dashboard", inputBinding: binding },
    payload: { operation: "inspect", objective: "Inspect with current authority", acceptanceCriteria: ["Current authority is verified"],
      evidence: [], summary: "Verify before effects", reason: "Temporary check failures preserve the checkpoint" },
  }));
  const { grantDigest: _grantDigest, ...content } = sealed;
  return { ...await createRealApprovedJob(content, { clock }), factory, failWith: value => { failure = value; }, checks: () => checks };
}

async function createRealReviewRepairJob(sourceKind = 'review_repair') {
  const fixture = reviewRepairFixture();
  const inputBinding = fixture.initial.grant.inputBinding;
  const writablePaths = ["Source", "Test"];
  const executionSource = sourceKind === 'ci_repair' ? ciRepairSource(inputBinding, writablePaths)
    : createReviewRepairCodeExecutionSource({ inputBinding, writablePaths });
  const approved = await createRealApprovedJob({
    ...fixture.initial.grant,
    executionSource,
    writablePaths,
    source: { assignmentId: "integration-assignment", eventId: inputBinding.eventId },
    subject: { id: "github:acme/dashboard:pull-request:42", repository: "acme/dashboard", number: 42 },
  });
  return { ...approved, reader: fixture.reader };
}

test("durable review repair admission permits configured descendants and keeps the sealed scope", async () => {
  const { jobs, durableJob } = await createRealReviewRepairJob();
  const starting = await jobs.claimStarting({ jobId: durableJob.jobId, expectedRevision: durableJob.revision });
  const active = await jobs.activate({ jobId: durableJob.jobId, expectedRevision: starting.job.revision, workspaceRevision: REVISION_A });
  const action = {
    type: "write_text", path: "Source/Systems/Analysis/AnalysisFAZSystem.cpp", content: "fixed\n",
    actionId: "review-repair-write", expectedWorkspaceRevision: REVISION_A, expectedSha256: FILE_SHA,
  };
  for (const path of ["Sources/AnalysisFAZSystem.cpp", "Other/AnalysisFAZSystem.cpp", "Source/.git/config"]) {
    await assert.rejects(jobs.prepareAction({ jobId: durableJob.jobId, expectedRevision: active.job.revision,
      action: { ...action, path } }), (error) => error.code === "INVALID_CODE_JOB");
  }
  const prepared = await jobs.prepareAction({ jobId: durableJob.jobId, expectedRevision: active.job.revision, action });
  assert.deepEqual(prepared.job.execution.pendingAction.action, action);
  assert.deepEqual(prepared.job.grant, durableJob.grant);
  assert.deepEqual((await jobs.getForWorker(durableJob.jobId)).execution.pendingAction.action, action);
});

test("review repair grant normalization rejects changed source kinds, modes, paths and input bindings", async () => {
  const { durableJob } = await createRealReviewRepairJob();
  const { grantDigest, ...content } = durableJob.grant;
  for (const tamper of [
    (value) => { value.executionSource.kind = "conflict_preparation"; },
    (value) => { value.executionSource.writeScope.mode = "exact_files"; },
    (value) => { value.writablePaths = ["Source"]; },
    (value) => { value.executionSource.inputBinding.eventId = "foreign-source-event"; },
  ]) {
    const changed = structuredClone(content);
    tamper(changed);
    assert.throws(() => createCodeJobGrant(changed), (error) => error.code === "INVALID_CODE_JOB_GRANT");
  }
  assert.equal(createCodeJobGrant(content).grantDigest, grantDigest);
});

test("review repair worker writes existing and new configured descendants through the real durable store", async (t) => {
  for (const existing of [true, false]) await t.test(existing ? "trusted existing file hash" : "new file", async () => {
    const { jobs, durableJob, reader } = await createRealReviewRepairJob();
    const executor = new FakeExecutor(durableJob);
    const path = existing ? "Source/Systems/Analysis/AnalysisFAZSystem.cpp" : "Test/ReviewRepair.test.cpp";
    const actions = [
      ...(existing ? [{ type: "read_text", path }] : []),
      { type: "write_text", path, content: "fixed\n" },
    ];
    const worker = new CodeJobWorkerService({ jobStore: jobs, executor,
      brainDirectory: brain(actions), grantVerifier: verifier([]), reviewRepairContextReader: reader });
    if (existing) assert.equal((await worker.runCycle({ limit: 1 })).outcomes[0].actionType, "read_text");
    const outcome = (await worker.runCycle({ limit: 1 })).outcomes[0];
    assert.equal(outcome.status, "active", outcome.code);
    assert.equal(outcome.actionType, "write_text");
    const write = executor.calls.find(({ method, value }) => method === "perform" && value.action.type === "write_text").value.action;
    assert.equal(write.path, path);
    assert.equal(write.expectedSha256, existing ? FILE_SHA : null);
    const stored = await jobs.getForWorker(durableJob.jobId);
    assert.equal(stored.execution.observations.at(-1).actionType, "write_text");
    assert.equal(stored.execution.observations.at(-1).status, "succeeded");
    assert.deepEqual(stored.grant, durableJob.grant);
  });
});

test("write admission keeps legacy configured prefixes and conflict exact files distinct", async (t) => {
  const inputBinding = conflictInputBinding();
  const conflictSource = conflictExecutionSource(inputBinding);
  for (const schemaVersion of [undefined, 2, 3]) await t.test(`grant ${schemaVersion ?? "legacy"}`, async () => {
    const { jobs, durableJob } = await createRealApprovedJob({
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      ...(schemaVersion === 3 ? {
        inputBinding, executionSource: conflictSource,
        source: { assignmentId: "integration-assignment", eventId: inputBinding.eventId },
        subject: { id: "github:acme/dashboard:pull-request:42", repository: "acme/dashboard", number: 42 },
      } : schemaVersion === 2 ? { inputBinding: null } : {}),
      operation: "modify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
      writablePaths: ["src/app.js"],
    });
    const starting = await jobs.claimStarting({ jobId: durableJob.jobId, expectedRevision: durableJob.revision });
    const active = await jobs.activate({ jobId: durableJob.jobId, expectedRevision: starting.job.revision, workspaceRevision: REVISION_A });
    const action = { type: "write_text", actionId: "scope-write", expectedWorkspaceRevision: REVISION_A,
      path: "src/app.js/child.js", content: "candidate\n", expectedSha256: null };
    if (schemaVersion === 3) {
      await assert.rejects(jobs.prepareAction({ jobId: durableJob.jobId, expectedRevision: active.job.revision, action }),
        (error) => error.code === "INVALID_CODE_JOB");
    } else {
      const prepared = await jobs.prepareAction({ jobId: durableJob.jobId, expectedRevision: active.job.revision, action });
      assert.equal(prepared.job.execution.pendingAction.action.path, action.path);
    }
  });
});

test("conflict worker still rejects descendants of sealed exact files", async () => {
  const inputBinding = conflictInputBinding();
  const initial = job({ grant: grant({ schemaVersion: 3, inputBinding,
    executionSource: conflictExecutionSource(inputBinding), writablePaths: ["src/app.js"] }) });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({ jobStore: store, executor,
    brainDirectory: brain([{ type: "write_text", path: "src/app.js/child.js", content: "forbidden" }]),
    grantVerifier: verifier([]) });
  const outcome = (await worker.runCycle({ limit: 1 })).outcomes[0];
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.code, "CODE_BRAIN_WRITE_NOT_PERMITTED");
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
});

test("review repair worker rejects sibling and outside paths before durable admission", async (t) => {
  for (const path of ["Sources/AnalysisFAZSystem.cpp", "Other/AnalysisFAZSystem.cpp", "Source/.git/config"]) await t.test(path, async () => {
    const { jobs, durableJob, reader } = await createRealReviewRepairJob();
    const executor = new FakeExecutor(durableJob);
    const worker = new CodeJobWorkerService({ jobStore: jobs, executor,
      brainDirectory: brain([{ type: "write_text", path, content: "forbidden\n" }]),
      grantVerifier: verifier([]), reviewRepairContextReader: reader });
    const outcome = (await worker.runCycle({ limit: 1 })).outcomes[0];
    assert.equal(outcome.status, "paused");
    assert.equal(outcome.code, "CODE_BRAIN_WRITE_NOT_PERMITTED");
    assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
    assert.equal((await jobs.getForWorker(durableJob.jobId)).execution.pendingAction, null);
  });
});

test('running controls retain a real code-job hold across interrupted action reconciliation and registry restart',async(t)=>{
  for(const command of ['pause','cancel'])await t.test(command,async()=>{
    const {jobs,created,durableJob}=await createRealApprovedJob();
    const settings=new IntegrationMemoryStore();const entered=deferred(),release=deferred();
    const executor=new FakeExecutor(durableJob);const perform=executor.perform.bind(executor);
    const reconcile=executor.reconcileAction.bind(executor);let response;
    executor.perform=async(value)=>{response=await perform(value);entered.resolve();await release.promise;
      throw Object.assign(new Error('response interrupted after admission'),{code:'CODE_JOB_ACTION_INTERRUPTED'});};
    executor.reconcileAction=async(value)=>({...await reconcile(value),result:response.result});
    const cancelExecution=executor.reconcileCancellation.bind(executor);
    executor.reconcileCancellation=async(value)=>{
      const result=await cancelExecution(value);
      const {proofDigest,...proof}=result.proof;
      proof.settledAt='2026-08-02T08:00:00.000Z';
      result.session.updatedAt=proof.settledAt;
      executor.session.updatedAt=proof.settledAt;
      result.proof={...proof,proofDigest:digestValue(proof)};
      return result;
    };
    const control=Object.fromEntries(['pause','cancel','resume'].map(method=>[method,async(value)=>{
      assert.equal(value.expectedRevision,(await jobs.getForWorker(value.jobId)).revision);
      return jobs[method](value);
    }]));
    const settle=createTaskRunSettler({codeJobReader:{get:id=>jobs.getForWorker(id)},codeJobControl:control});
    const registry=new TaskRunRegistry({store:settings,settleControl:settle});
    const createWorker=taskRuns=>new CodeJobWorkerService({jobStore:jobs,executor,taskRuns,
      brainDirectory:brain([{type:'read_text',path:'src/app.js'}]),grantVerifier:{verify:async value=>structuredClone(value)}});
    const cycle=createWorker(registry).runCycle();await entered.promise;
    const view=await registry.get('code-job',created.job.jobId);
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command});
    release.resolve();await cycle;
    assert.equal((await registry.list()).held[0].pendingCommand,command);
    const restarted=new TaskRunRegistry({store:settings,settleControl:settle});
    await restarted.reconcile();assert.equal((await restarted.list()).held[0].pendingCommand,command);
    const settledCycle=await createWorker(restarted).runCycle();await restarted.reconcile();
    const final=await jobs.getForWorker(created.job.jobId);
    assert.equal(final.status,command==='pause'?'paused':'cancelled',JSON.stringify(settledCycle.outcomes));
    assert.equal(final.jobId,created.job.jobId);assert.equal((await restarted.get('code-job',final.jobId)).pendingCommand,null);
    assert.equal(executor.calls.filter(call=>call.method==='perform').length,1);
  });
});

test("the real job store and worker preserve an in-flight pause across durable CAS", async () => {
  const {jobs,created,durableJob}=await createRealApprovedJob();
  const executor = new FakeExecutor(durableJob);
  const entered = deferred();
  const release = deferred();
  const perform = executor.perform.bind(executor);
  executor.perform = async (value) => {
    entered.resolve();
    await release.promise;
    return perform(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: jobs,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: { verify: async (value) => structuredClone(value) },
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const admitted = await jobs.getForWorker(created.job.jobId);
  const pausing = await jobs.pause({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "用户要求暂停正在执行的任务",
  });
  release.resolve();
  const outcome = await cycle;
  const paused = await jobs.getForWorker(created.job.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(outcome.outcomes[0].status, "paused");
  assert.equal(paused.status, "paused");
  assert.equal(paused.execution.turn, 1);
  assert.equal(paused.execution.pendingAction, null);
  assert.equal(paused.execution.actionAdmission, null);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
});

test("interrupted action results retain admission until trusted reconciliation", async (t) => {
  for (const pauseDuringAction of [false, true]) {
    await t.test(
      pauseDuringAction ? "pausing origin" : "active origin",
      async () => {
        const inputBinding = pullRequestInputBinding();
        const initial = job({
          grant: grant({ inputBinding }),
          status: "active",
          revision: 3,
          execution: {
            sessionId: job().jobId,
            workspaceRevision: REVISION_A,
            turn: 0,
            pendingAction: null,
            actionAdmission: null,
            observations: [],
            result: null,
            pause: null,
            uncertainty: null,
          },
        });
        const store = new FakeJobStore([initial]);
        const executor = new FakeExecutor(initial);
        const perform = executor.perform.bind(executor);
        executor.perform = async (value) => {
          const response = await perform(value);
          if (pauseDuringAction) {
            const current = await store.getForWorker(initial.jobId);
            await store.pause({
              jobId: current.jobId,
              expectedRevision: current.revision,
              reason: "用户要求动作后暂停",
            });
          }
          response.action.status = "interrupted";
          response.action.error = {
            code: "RESULT_UNKNOWN",
            message: "Action result could not be proven",
          };
          response.action.workspaceRevisionAfter = null;
          executor.session.status = "interrupted";
          executor.session.attempt.status = "interrupted";
          executor.session.workspaceRevision = REVISION_A;
          const storedAction = executor.session.actions.find(
            ({ id }) => id === response.action.id,
          );
          storedAction.status = "interrupted";
          storedAction.workspaceRevisionAfter = null;
          storedAction.error = structuredClone(response.action.error);
          response.session = structuredClone(executor.session);
          response.result = { error: structuredClone(response.action.error) };
          return response;
        };
        const brainCalls = [];
        const worker = new CodeJobWorkerService({
          jobStore: store,
          executor,
          brainDirectory: brain(
            [{ type: "write_text", path: "src/app.js", content: "changed\n" }],
            brainCalls,
          ),
          grantVerifier: verifier([]),
        });

        const uncertainCycle = await worker.runCycle();
        const unknown = await store.getForWorker(initial.jobId);

        assert.equal(uncertainCycle.outcomes[0].status, "unknown");
        assert.equal(uncertainCycle.outcomes[0].code, "RESULT_UNKNOWN");
        assert.equal(unknown.status, "unknown");
        assert.notEqual(unknown.execution.pendingAction, null);
        assert.notEqual(unknown.execution.actionAdmission, null);
        assert.equal(unknown.execution.observations.length, 0);
        assert.equal(
          unknown.execution.uncertainty.from,
          pauseDuringAction ? "pausing" : "active",
        );
        assert.equal(unknown.execution.uncertainty.code, "RESULT_UNKNOWN");
        assert.equal(
          unknown.execution.pause?.reason ?? null,
          pauseDuringAction ? "用户要求动作后暂停" : null,
        );

        const reconciledCycle = await worker.runCycle();
        const reconciled = await store.getForWorker(initial.jobId);
        assert.equal(
          reconciledCycle.outcomes[0].status,
          pauseDuringAction ? "paused" : "active",
        );
        assert.equal(
          reconciled.status,
          pauseDuringAction ? "paused" : "active",
        );
        assert.equal(reconciled.execution.pendingAction, null);
        assert.equal(reconciled.execution.actionAdmission, null);
        assert.equal(reconciled.execution.uncertainty, null);
        assert.equal(
          executor.calls.filter(({ method }) => method === "perform").length,
          1,
        );
        assert.equal(
          executor.calls.filter(({ method }) => method === "resume").length,
          1,
        );
        assert.deepEqual(
          executor.calls.find(({ method }) => method === "resume").value,
          { sessionId: initial.jobId, inputBinding },
        );
        assert.equal(brainCalls.length, 1);
      },
    );
  }
});

test("interrupted recovery converges after a lost resume acknowledgement", async () => {
  const action = {
    type: "write_text",
    actionId: "write-with-lost-resume-ack",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "changed\n",
    expectedSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 7,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "受控动作结果无法确认，必须先与执行器对账",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions = [{
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: { code: "RESULT_UNKNOWN", message: "Result unknown" },
  }];
  const resume = executor.resume.bind(executor);
  const actionAdmissionGate = readyActionAdmissionGate();
  await activateNextConfiguration(actionAdmissionGate);
  let loseAcknowledgement = true;
  executor.resume = async (value) => {
    const session = await resume(value);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw Object.assign(new Error("resume acknowledgement lost"), {
        code: "STATE_WRITE_FAILED",
      });
    }
    return session;
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
    actionAdmissionGate,
  });

  const lostAckCycle = await worker.runCycle();
  const recoveredCycle = await worker.runCycle();
  const recovered = await store.getForWorker(initial.jobId);

  assert.equal(lostAckCycle.outcomes[0].status, "unknown");
  assert.equal(recoveredCycle.outcomes[0].status, "active");
  assert.equal(recovered.status, "active");
  assert.equal(recovered.execution.pendingAction, null);
  assert.equal(recovered.execution.actionAdmission, null);
  assert.equal(recovered.execution.uncertainty, null);
  assert.equal(
    executor.calls.filter(({ method }) => method === "resume").length,
    1,
  );
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "resume").value,
    { sessionId: initial.jobId, inputBinding: null },
  );
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("the host selects fixed profiles and completes only after current-attempt proof", async () => {
  const profileAction = {
    type: "run_profile",
    actionId: "profile-current",
    expectedWorkspaceRevision: REVISION_A,
    profileId: "node-tests",
  };
  const profileObservation = observation(profileAction, {
    result: { exitCode: 0, stdout: "ok", stderr: "" },
  });
  const initial = job({
    grant: grant({ schemaVersion: 2, inputBinding: null }),
    status: "active",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [profileObservation],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([
      { type: "complete", outcome: "fixed", evidence: ["tests"] },
    ], brainCalls),
    grantVerifier: verifier(events),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(brainCalls[0].capabilities.requiredProfilesRemaining, 0);
  assert.equal(result.outcomes[0].status, "completed");
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.execution.result.detail.manifest.modified[0].path, "src/app.js");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
});

function failFirstProfileRun(executor, result) {
  const perform = executor.perform.bind(executor);
  let failed = false;
  executor.perform = async (...args) => {
    const response = await perform(...args);
    if (response.action.type !== "run_profile" || failed) return response;
    failed = true;
    executor.last.action.status = "failed";
    executor.last.action.error = result.error ?? null;
    executor.last.result = structuredClone(result);
    const index = executor.session.actions.findIndex(({ id }) => id === response.action.id);
    executor.session.actions[index] = structuredClone(executor.last.action);
    executor.last.session = structuredClone(executor.session);
    return structuredClone(executor.last);
  };
}

test("verify jobs settle a trusted failed profile once with an actionable reason", async (t) => {
  const cases = [
    {
      name: "test failure does not assert a product defect",
      result: {
        exitCode: 1, timedOut: false, stdout: "TAP version 13\nnot ok 1 - module startup\n",
        stderr: "ERR_MODULE_NOT_FOUND: missing dependency",
        error: { code: "TESTS_FAILED", message: "测试未通过或缺少有效通过用例" },
        testSummary: { total: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0, executed: 1 },
        profileId: "untrusted-profile", workspaceRevision: REVISION_B,
      },
      code: "CODE_JOB_VERIFICATION_FAILED",
      reason: /原因.*未确认|未确认.*原因/,
    },
    {
      name: "timed out process",
      result: { exitCode: null, timedOut: true, error: { code: "SANDBOX_TIMEOUT", message: "interrupted" } },
      code: "CODE_JOB_VERIFICATION_TIMEOUT",
      reason: /超时/,
    },
    {
      name: "sandbox unavailable",
      result: { error: { code: "SANDBOX_UNAVAILABLE", message: "Docker sandbox is unavailable" } },
      code: "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      reason: /环境.*不可用|不可用.*环境/,
    },
    {
      name: "sandbox process cannot start",
      result: { error: { code: "SANDBOX_START_FAILED", message: "Docker process failed to start" } },
      code: "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      reason: /环境.*不可用|不可用.*环境/,
    },
    {
      name: "unknown execution failure",
      result: { error: { code: "UNRECOGNIZED_FAILURE", message: "unknown failure" } },
      code: "CODE_JOB_VERIFICATION_UNKNOWN",
      reason: /原因.*未确认|未确认.*原因/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const initial = job({ grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }) });
      const events = [];
      const store = new FakeJobStore([initial], events);
      const executor = new FakeExecutor(initial, events);
      failFirstProfileRun(executor, scenario.result);
      const brainCalls = [];
      const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: brain([{ type: "run_profile" }, { type: "run_profile" }], brainCalls), grantVerifier: verifier(events) });

      const first = await worker.runCycle();
      const second = await worker.runCycle();
      const stored = await store.getForWorker(initial.jobId);

      assert.equal(first.outcomes[0].status, "failed");
      assert.equal(first.outcomes[0].code, scenario.code);
      assert.equal(stored.execution.result.detail.code, scenario.code);
      assert.match(stored.execution.result.detail.message, scenario.reason);
      assert.match(stored.execution.result.detail.message, /node-tests/);
      assert.match(stored.execution.result.detail.message, new RegExp(stored.execution.observations[0].actionId));
      assert.equal(stored.execution.result.detail.message.includes("untrusted-profile"), false);
      assert.equal(stored.execution.result.detail.message.includes("产品代码缺陷"), false);
      assert.equal(stored.execution.observations.length, 1);
      assert.equal(stored.execution.observations[0].status, "failed");
      assert.equal(stored.execution.observations[0].workspaceRevision, REVISION_A);
      assert.equal(events.indexOf("observe") < events.indexOf("failed"), true);
      assert.equal(second.selected, 0);
      assert.equal(brainCalls.length, 1);
      assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
      assert.equal(store.completionRequests.length, 0);
    });
  }
});

test("a profile cancelled before launch remains unexecuted and a verify job retries normally", async () => {
  const initial = job({ grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }) });
  const events = [], store = new FakeJobStore([initial], events), executor = new FakeExecutor(initial, events), calls = [];
  failFirstProfileRun(executor, { exitCode: null, timedOut: false, stdout: "", stderr: "",
    error: { code: "SANDBOX_ABORTED", message: "Windows fixed test was cancelled before launch",
      details: { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false } } });
  const worker = new CodeJobWorkerService({ jobStore: store, executor,
    brainDirectory: brain([{ type: "run_profile" }, { type: "run_profile" }, { type: "complete", outcome: "Retest passed.", evidence: [] }], calls), grantVerifier: verifier(events) });
  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "active");
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations[0].status, "failed");
  assert.equal((await worker.runCycle()).outcomes[0].status, "active");
  assert.equal(calls[1].capabilities.requiredProfilesRemaining, 1, "no passing result was invented for the unexecuted profile");
  assert.equal((await worker.runCycle()).outcomes[0].status, "completed");
  assert.deepEqual((await store.getForWorker(initial.jobId)).execution.observations.slice(0, 2).map(entry => entry.status), ["failed", "succeeded"]);
});

test("a durable unstarted profile can retry after restart without masking an earlier executed failure", async t => {
  for (const earlierFailed of [false, true]) await t.test(String(earlierFailed), async () => {
    const action = { type: "run_profile", actionId: "unstarted-after-restart", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
    const observations = earlierFailed ? [observation({ ...action, actionId: "executed-failure" },
      { status: "failed", result: { exitCode: 1, error: { code: "TESTS_FAILED", message: "checks failed" } } })] : [];
    observations.push({ ...observation(action, { status: "failed", result: { exitCode: null, timedOut: false, stdout: "", stderr: "",
      error: { code: "SANDBOX_ABORTED", message: "cancelled before launch",
        details: { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false } } } }), turn: observations.length + 1 });
    const initial = job({ grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }),
      status: "active", revision: 6, execution: { ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
        turn: observations.length, observations } });
    const store = new FakeJobStore([initial]), executor = new FakeExecutor(initial), calls = [];
    const worker = new CodeJobWorkerService({ jobStore: store, executor,
      brainDirectory: brain([{ type: "run_profile" }], calls), grantVerifier: verifier([]) });
    const result = (await worker.runCycle()).outcomes[0];
    assert.equal(result.status, earlierFailed ? "failed" : "active");
    assert.equal(calls.length, earlierFailed ? 0 : 1);
    if (earlierFailed) assert.equal(result.code, "CODE_JOB_VERIFICATION_FAILED");
  });
});

test("an interrupted profile with absent or contradictory unexecuted proof remains unknown", async t => {
  for (const variant of ["legacy-message-only", "cleanup-pending", "extra-proof-field", "exit-code", "output", "runtime-proof"]) {
    await t.test(variant, async () => {
      const result = { exitCode: null, timedOut: false, stdout: "", stderr: "", error: { code: "SANDBOX_ABORTED",
        message: "Windows fixed test was cancelled before launch",
        details: { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false } } };
      if (variant === "legacy-message-only") delete result.error.details;
      if (variant === "cleanup-pending") result.error.details.cleanupPending = true;
      if (variant === "extra-proof-field") result.error.details.extra = true;
      if (variant === "exit-code") result.exitCode = 0;
      if (variant === "output") result.stdout = "A process ran";
      if (variant === "runtime-proof") result.runtimeIdentity = { schemaVersion: 2 };
      const initial = job({ grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }) });
      const store = new FakeJobStore([initial]), executor = new FakeExecutor(initial);
      failFirstProfileRun(executor, result);
      const worker = new CodeJobWorkerService({ jobStore: store, executor,
        brainDirectory: brain([{ type: "run_profile" }]), grantVerifier: verifier([]) });
      assert.equal((await worker.runCycle()).outcomes[0].code, "CODE_JOB_VERIFICATION_UNKNOWN", variant);
    });
  }
});

test("verify jobs recover a durable failed profile locally before asking the brain again", async () => {
  const action = { type: "run_profile", actionId: "failed-profile-before-restart", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
  const initial = job({
    grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }),
    status: "active", revision: 5,
    execution: { ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A, turn: 1, observations: [observation(action, { status: "failed", result: { exitCode: 1, error: { code: "TESTS_FAILED", message: "checks failed" } } })] },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: brain([{ type: "run_profile" }], brainCalls), grantVerifier: verifier([]) });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "failed");
  assert.equal(result.outcomes[0].code, "CODE_JOB_VERIFICATION_FAILED");
  assert.equal(brainCalls.length, 0);
  assert.equal(executor.calls.length, 0);
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations.length, 1);
});

test("upgraded verify jobs keep a later passing retest instead of reviving an old failure", async () => {
  const failed = { type: "run_profile", actionId: "legacy-failed-profile", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
  const passed = { ...failed, actionId: "legacy-passed-retest" };
  const initial = job({
    grant: grant({ operation: "verify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [] }),
    status: "active", revision: 6,
    execution: { ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A, turn: 2,
      observations: [
        observation(failed, { status: "failed", result: { exitCode: 1, error: { code: "TESTS_FAILED", message: "old failure" } } }),
        { ...observation(passed, { result: { exitCode: 0 } }), turn: 2 },
      ],
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({ jobStore: store, executor, brainDirectory: brain([{ type: "complete", outcome: "Latest retest passed.", evidence: [] }]), grantVerifier: verifier([]) });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations.length, 3);
});

test("recovered verification selects the latest result of each fixed profile at the current workspace", () => {
  const initial = job({
    grant: grant({ operation: "verify", requiredProfiles: [
      { id: "node-tests", configDigest: PROFILE_DIGEST },
      { id: "ui-tests", configDigest: PROFILE_DIGEST },
    ] }),
    execution: { ...job().execution, workspaceRevision: REVISION_B, observations: [] },
  });
  const add = (profileId, status, revision = REVISION_B) => {
    const action = { type: "run_profile", actionId: `profile-${initial.execution.observations.length}`, expectedWorkspaceRevision: revision, profileId };
    initial.execution.observations.push(observation(action, {
      status, workspaceRevision: revision,
      result: status === "failed" ? { exitCode: 1, error: { code: "TESTS_FAILED", message: "failed" } } : { exitCode: 0 },
    }));
  };
  add("node-tests", "failed", REVISION_A);
  add("ui-tests", "succeeded");
  assert.equal(verificationFailure(initial), null, "a stale workspace failure does not fail current tests");
  add("node-tests", "failed");
  add("ui-tests", "succeeded");
  assert.equal(verificationFailure(initial)?.code, "CODE_JOB_VERIFICATION_FAILED", "another profile passing does not hide the failure");
  add("node-tests", "succeeded");
  assert.equal(verificationFailure(initial), null, "a passing retest supersedes its earlier failure");
  add("node-tests", "failed");
  assert.equal(verificationFailure(initial)?.code, "CODE_JOB_VERIFICATION_FAILED", "the latest failure is authoritative");
});

test("verify jobs wait for audit reconciliation before settling a failed profile without replay", async () => {
  const initial = job({
    grant: grant({
      operation: "verify",
      allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify],
      writablePaths: [],
    }),
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  failFirstProfileRun(executor, {
    exitCode: 1,
    error: { code: "TESTS_FAILED", message: "checks failed" },
  });
  executor.getActionResult = async () => {
    throw Object.assign(new Error("audit unavailable"), { code: "AUDIT_BACKEND_UNAVAILABLE" });
  };
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "run_profile" }], brainCalls),
    grantVerifier: verifier([]),
  });

  const uncertain = await worker.runCycle();
  assert.equal(uncertain.outcomes[0].status, "unknown");
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations.length, 0);
  const reconciled = await worker.runCycle();

  assert.equal(reconciled.outcomes[0].status, "failed");
  assert.equal(reconciled.outcomes[0].code, "CODE_JOB_VERIFICATION_FAILED");
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations.length, 1);
  assert.equal((await worker.runCycle()).selected, 0);
  assert.equal(brainCalls.length, 1);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
  assert.equal(executor.calls.filter(({ method }) => method === "reconcileAction").length, 1);
});

test("non-verification jobs stop after a required profile environment failure without another model call", async t => {
  for (const operation of ["modify", "inspect"]) {
    for (const code of ["SANDBOX_UNAVAILABLE", "SANDBOX_START_FAILED", "SANDBOX_IMAGE_UNAVAILABLE", "SANDBOX_PROFILE_NOT_FOUND", "INVALID_SANDBOX_CONFIG"]) {
      await t.test(`${operation}: ${code}`, async () => {
        const initial = job({ grant: grant({ operation }) });
        const store = new FakeJobStore([initial]), executor = new FakeExecutor(initial), calls = [];
        failFirstProfileRun(executor, { exitCode: null, error: { code, message: "environment unavailable" } });
        const worker = new CodeJobWorkerService({ jobStore: store, executor,
          brainDirectory: brain([{ type: "run_profile" }, { type: "run_profile" }], calls), grantVerifier: verifier([]) });
        assert.equal((await worker.runCycle()).outcomes[0].code, "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE");
        assert.equal((await worker.runCycle()).selected, 0);
        const current = await store.getForWorker(initial.jobId);
        assert.equal(current.status, "failed");
        assert.equal(current.execution.observations.length, 1);
        assert.equal(current.execution.observations[0].detail.result.error.code, code);
        assert.equal(calls.length, 1);
        assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
      });
    }
  }
});

test("a recovered modify job stops on current environment failure while keeping latest results per profile", () => {
  const action = { type: "run_profile", actionId: "environment-failure", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
  const failed = observation(action, { status: "failed", result: { error: { code: "SANDBOX_UNAVAILABLE" } } });
  const initial = job({ execution: { ...job().execution, workspaceRevision: REVISION_A, observations: [failed] } });
  assert.equal(verificationFailure(initial)?.code, "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE");
  initial.execution.observations.push(observation({ ...action, actionId: "passed-retest" }, { result: { exitCode: 0 } }));
  assert.equal(verificationFailure(initial), null);
  initial.execution.observations = [failed, observation({ ...action, actionId: "product-failure" },
    { status: "failed", result: { exitCode: 1, error: { code: "TESTS_FAILED" } } })];
  assert.equal(verificationFailure(initial), null, "a later executed test failure permits code repair");
  initial.execution.workspaceRevision = REVISION_B;
  initial.execution.observations = [failed];
  assert.equal(verificationFailure(initial), null, "old workspace results do not fail a new workspace");
});

test("restarted non-verification workers retain prior edits and settle environment failure without replay", async t => {
  for (const operation of ["modify", "inspect"]) await t.test(operation, async () => {
    const profile = { type: "run_profile", actionId: "durable-environment-failure", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
    const observations = operation === "modify" ? [observation({ type: "write_text", actionId: "prior-edit",
      expectedWorkspaceRevision: REVISION_A, path: "src/new.js", content: "export const fixed = true;\n" })] : [];
    observations.push(observation(profile, { status: "failed", result: { error: { code: "SANDBOX_UNAVAILABLE" } } }));
    const initial = job({ grant: grant({ operation }), status: "active", revision: 6,
      execution: { ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
        turn: observations.length, observations } });
    const store = new FakeJobStore([initial]), executor = new FakeExecutor(initial), calls = [];
    const worker = new CodeJobWorkerService({ jobStore: store, executor,
      brainDirectory: brain([{ type: "run_profile" }], calls), grantVerifier: verifier([]) });
    assert.equal((await worker.runCycle()).outcomes[0].code, "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE");
    const current = await store.getForWorker(initial.jobId);
    assert.equal(current.status, "failed");
    assert.deepEqual(current.execution.observations, observations);
    assert.equal(current.execution.workspaceRevision, REVISION_A);
    assert.equal(calls.length, 0);
    assert.deepEqual(executor.calls, []);
  });
});

test("continuous modify stops further tool actions after a profile environment failure", async () => {
  const initial = job(), store = new FakeJobStore([initial]), executor = new FakeExecutor(initial);
  failFirstProfileRun(executor, { error: { code: "SANDBOX_UNAVAILABLE" } });
  const worker = new CodeJobWorkerService({ jobStore: store, executor, grantVerifier: verifier([]),
    brainDirectory: { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }),
      async decide({ codeExecutionContext }) {
        const tools = beginCodeExecutionSession(codeExecutionContext);
        await tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) });
        await assert.rejects(tools.invoke("perform_action", { decision: continuousDecision({ type: "run_profile" }) }));
        await tools.close();
        return continuousDecision({ type: "complete", outcome: "environment unavailable", evidence: [] });
      } } });
  assert.equal((await worker.runCycle()).outcomes[0].status, "failed");
  assert.equal((await store.getForWorker(initial.jobId)).execution.observations.length, 1);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
});

test("modify jobs can repair and retest after a trusted profile failure", async () => {
  const initial = job();
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  failFirstProfileRun(executor, { exitCode: 1, error: { code: "TESTS_FAILED", message: "checks failed" } });
  const worker = new CodeJobWorkerService({
    jobStore: store, executor,
    brainDirectory: brain([{ type: "run_profile" }, { type: "write_text", path: "src/new.js", content: "export const fixed = true;\n" }, { type: "run_profile" }, { type: "complete", outcome: "Repair and retest completed.", evidence: [] }]),
    grantVerifier: verifier([]),
  });

  assert.equal((await worker.runCycle()).outcomes[0].status, "active");
  assert.equal((await worker.runCycle()).outcomes[0].status, "active");
  assert.equal((await worker.runCycle()).outcomes[0].status, "active");
  assert.equal((await worker.runCycle()).outcomes[0].status, "completed");
  assert.deepEqual((await store.getForWorker(initial.jobId)).execution.observations.map(({ status }) => status), ["failed", "succeeded", "succeeded", "succeeded"]);
});

test("profile observations preserve only bounded validated test summary counts", () => {
  const action = { type: "run_profile", actionId: "profile-summary", expectedWorkspaceRevision: REVISION_A, profileId: "node-tests" };
  const summary = { total: 4, passed: 1, failed: 1, cancelled: 0, skipped: 1, todo: 1, executed: 2 };
  const detail = observationDetail(action, { session: { status: "active", attempt: { number: 1 } }, action: { status: "failed", attemptNumber: 1 } }, { exitCode: 1, testSummary: { ...summary, testNames: ["x".repeat(100_000)] } });

  assert.deepEqual(detail.result.testSummary, summary);
  assert.deepEqual(JSON.parse(modelObservation(observation(action, { status: "failed", result: detail.result })).detail).testSummary, summary);
  const invalid = observationDetail(action, { session: { status: "active", attempt: { number: 1 } }, action: { status: "failed", attemptNumber: 1 } }, { testSummary: { ...summary, executed: -1 } });
  assert.equal(Object.hasOwn(invalid.result, "testSummary"), false);
  for (const inconsistent of [ { ...summary, executed: 3 }, { ...summary, total: 5 } ]) {
    const rejected = observationDetail(action, { session: { status: "active", attempt: { number: 1 } }, action: { status: "failed", attemptNumber: 1 } }, { testSummary: inconsistent });
    assert.equal(Object.hasOwn(rejected.result, "testSummary"), false);
    assert.equal(Object.hasOwn(JSON.parse(modelObservation(observation(action, { result: { testSummary: inconsistent } })).detail), "testSummary"), false);
  }
});

test("a changed PR Head fences the job before brain or executor access", async () => {
  const inputBinding = {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 17,
    rootItemId: "work-root-17",
    workKey: `pr-work-${"2".repeat(64)}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "a".repeat(40),
    eventId: "event-17",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
  };
  const initial = job({ grant: grant({ inputBinding }) });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const currentHead = "b".repeat(40);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        events.push("verify");
        if (value.inputBinding.headRefOid !== currentHead) {
          throw Object.assign(new Error("PR Head changed"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(
    executor.calls.some(({ method }) =>
      ["start", "view", "resume", "perform", "reconcileAction"].includes(method),
    ),
    false,
  );
  assert.equal(brainCalls.length, 0);
});

test("revoked active authority fences before session context reaches the worker", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events, authorityError),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.deepEqual(executor.calls, []);
  assert.equal(brainCalls.length, 0);
});

test("an already-completed executor action is reconciled after authority revocation", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-before-revocation",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    status: "active",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: {
        turn: 2,
        actionId: completeAction.actionId,
        actionDigest: digestValue(completeAction),
        action: completeAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: completeAction.actionId,
        actionDigest: digestValue(completeAction),
        epoch: 7,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [observation({
        type: "run_profile",
        actionId: "profile-before-complete",
        expectedWorkspaceRevision: REVISION_A,
        profileId: "node-tests",
      })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  executor.session.actions = [{
    id: completeAction.actionId,
    type: "complete",
    status: "succeeded",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: REVISION_A,
    error: null,
  }];
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events, authorityError),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(events.includes("verify"), true);
  assert.deepEqual(
    executor.calls.map(({ method }) => method),
    ["reconcileAction"],
  );
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
});

test("an unknown completed action reconciles directly to the completed terminal state", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-from-unknown",
    expectedWorkspaceRevision: REVISION_A,
  };
  const actionDigest = digestValue(completeAction);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: {
        turn: 2,
        actionId: completeAction.actionId,
        actionDigest,
        action: completeAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: completeAction.actionId,
        actionDigest,
        epoch: 6,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [observation({
        type: "run_profile",
        actionId: "profile-before-unknown-complete",
        expectedWorkspaceRevision: REVISION_A,
        profileId: "node-tests",
      })],
      result: null,
      pause: {
        from: "active",
        reason: "执行结果待对账（EXECUTION_FENCED）",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  executor.session.actions = [{
    id: completeAction.actionId,
    type: "complete",
    status: "succeeded",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: REVISION_A,
    error: null,
  }];
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
  assert.equal(brainCalls.length, 0);
  assert.deepEqual(
    executor.calls.map(({ method }) => method),
    ["reconcileAction"],
  );
});

test("a durable complete observation finishes locally after authority revocation", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-observed-before-revocation",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({ schemaVersion: 2, inputBinding: null }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction, {
        result: {
          created: [],
          modified: [],
          deleted: [],
        },
      })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events, authorityError),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.deepEqual(executor.calls, []);
  assert.equal(events.includes("verify"), false);
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
});

test("a durable schema v3 conflict completion keeps its sealed source and opens package delivery", async () => {
  const inputBinding = conflictInputBinding();
  const executionSource = conflictExecutionSource(inputBinding);
  const completeAction = {
    type: "complete",
    actionId: "complete-sealed-conflict",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({
      schemaVersion: 3,
      inputBinding,
      executionSource,
      writablePaths: ["src/app.js"],
    }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction, {
        result: { created: [], modified: [], deleted: [] },
      })],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor: new FakeExecutor(initial),
    brainDirectory: brain([]),
    grantVerifier: verifier([], new Error("durable recovery must not re-enter authority")),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
  assert.deepEqual(initial.grant.executionSource, executionSource);
});

test("a durable legacy PR completion recovers locally without opening a new package", async () => {
  const completeAction = {
    type: "complete",
    actionId: "legacy-complete-observed-before-upgrade",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({
      schemaVersion: 2,
      inputBinding: pullRequestInputBinding(),
    }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction)],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor: new FakeExecutor(initial, events),
    brainDirectory: brain([]),
    grantVerifier: verifier(events, new Error("must not verify recovery")),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(events.includes("verify"), false);
  assert.equal(store.completionRequests.length, 1);
  assert.equal("changePackageDelivery" in store.completionRequests[0], false);
});

test("change package delivery defaults off and requires a strict boolean", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-without-delivery",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction)],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const dependencies = {
    jobStore: store,
    executor: new FakeExecutor(initial),
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  };
  const worker = new CodeJobWorkerService(dependencies);

  await worker.runCycle();

  assert.equal(store.completionRequests.length, 1);
  assert.equal("changePackageDelivery" in store.completionRequests[0], false);
  for (const invalid of [null, 0, 1, "true", {}, []]) {
    assert.throws(
      () => new CodeJobWorkerService({
        ...dependencies,
        changePackageDeliveryEnabled: invalid,
      }),
      /changePackageDeliveryEnabled must be a boolean/,
    );
  }
});

test("resuming an interrupted session invalidates prior-attempt profile proof", async () => {
  const inputBinding = pullRequestInputBinding();
  const oldProfileAction = {
    type: "run_profile",
    actionId: "profile-old-attempt",
    expectedWorkspaceRevision: REVISION_A,
    profileId: "node-tests",
  };
  const initial = job({
    grant: grant({ inputBinding }),
    status: "active",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [observation(oldProfileAction, { actionAttemptNumber: 1 })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events, {
    sessionStatus: "interrupted",
    attempt: 1,
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "run_profile" }], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  assert.equal(brainCalls[0].capabilities.requiredProfilesRemaining, 1);
  const action = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.equal(action.profileId, "node-tests");
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "resume").value,
    { sessionId: initial.jobId, inputBinding },
  );
});

test("an uncertain audited result enters durable unknown and reconciles without replay", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  executor.getActionResult = async () => {
    throw Object.assign(new Error("corrupt artifact"), {
      code: "AUDIT_BACKEND_UNAVAILABLE",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const first = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "unknown");
  const unknown = await store.getForWorker(initial.jobId);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.execution.pendingAction.action.type, "read_text");
  assert.notEqual(unknown.execution.actionAdmission, null);
  assert.equal(unknown.execution.pause, null);
  assert.equal(unknown.execution.uncertainty.from, "active");
  assert.equal(unknown.execution.uncertainty.code, "AUDIT_BACKEND_UNAVAILABLE");
  assert.equal((await store.listRunnable()).items.length, 0);
  assert.equal((await store.listReconcilable()).items.length, 1);

  const second = await worker.runCycle();

  assert.equal(second.outcomes[0].status, "active");
  const reconciled = await store.getForWorker(initial.jobId);
  assert.equal(reconciled.status, "active");
  assert.equal(reconciled.execution.pendingAction, null);
  assert.equal(reconciled.execution.actionAdmission, null);
  assert.equal(reconciled.execution.uncertainty, null);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
  assert.equal(executor.calls.filter(({ method }) => method === "reconcileAction").length, 1);
});

test("unknown reconciliation failures remain isolated from brains and execution", async () => {
  const action = {
    type: "read_text",
    actionId: "turn-1-unknown-reconcile",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 6,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: {
        from: "active",
        reason: "执行结果待对账（AUDIT_BACKEND_UNAVAILABLE）",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const queued = job({
    jobId: "code-job-2222222222222222222222222222222222222222222222222222222",
    sequence: 2,
  });
  const store = new FakeJobStore([queued, initial]);
  const executor = new FakeExecutor(initial);
  executor.reconcileAction = async (value) => {
    executor.calls.push({ method: "reconcileAction", value: structuredClone(value) });
    throw Object.assign(new Error("audit still unavailable"), {
      code: "AUDIT_BACKEND_UNAVAILABLE",
    });
  };
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle({ limit: 1 });
  const next = await worker.runCycle({ limit: 1 });

  assert.equal(result.selected, 1);
  assert.equal(result.outcomes[0].status, "unknown");
  assert.equal(next.selected, 1);
  assert.equal(next.outcomes[0].jobId, queued.jobId);
  assert.equal((await store.getForWorker(initial.jobId)).status, "unknown");
  assert.equal(brainCalls.length, 0);
  const executorMethods = executor.calls.map(({ method }) => method);
  assert.equal(executorMethods[0], "reconcileAction");
  assert.equal(
    executorMethods.filter((method) => method === "reconcileAction").length,
    1,
  );
  assert.equal(executorMethods.includes("perform"), false);
});

test("deterministic context overflow fails once instead of retrying forever", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const overflow = Object.assign(new Error("context overflow"), {
    code: "CODE_BRAIN_CONTEXT_TOO_LARGE",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([overflow], brainCalls),
    grantVerifier: verifier(events),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "failed");
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_CONTEXT_TOO_LARGE");
  assert.equal(second.selected, 0);
  assert.equal(brainCalls.length, 1);
  assert.equal((await store.getForWorker(initial.jobId)).status, "failed");
});

test("known infrastructure failures retry between actions while other brain failures preserve pause policy", async (t) => {
  const automaticCodes = new Set(["BRAIN_CREDENTIAL_UNAVAILABLE", "BRAIN_PROVIDER_NOT_CONFIGURED", "REMOTE_DATA_NOT_AUTHORIZED",
    "STRUCTURED_PROVIDER_MODEL_CAPACITY",
    "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE", "STRUCTURED_PROVIDER_UNAVAILABLE",
    "STRUCTURED_PROVIDER_REAP_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    "STRUCTURED_PROVIDER_RESPONSE_INVALID"]);
  for (const code of [
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    "STRUCTURED_PROVIDER_MODEL_CAPACITY",
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    "CODE_BRAIN_ROLE_NOT_CONFIGURED",
    "CODE_TASK_BRAIN_NOT_CONFIGURED",
    "CODE_BRAIN_PATH_INVALID",
    "CODE_BRAIN_COMPLETION_NOT_READY",
    "REMOTE_DATA_NOT_AUTHORIZED",
    "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    "STRUCTURED_PROVIDER_UNAVAILABLE",
    "STRUCTURED_PROVIDER_CANCELLED",
    "STRUCTURED_PROVIDER_TIMEOUT",
    "STRUCTURED_PROVIDER_IDLE_TIMEOUT",
    "STRUCTURED_PROVIDER_OUTPUT_LIMIT",
    "STRUCTURED_PROVIDER_PROCESS_FAILED",
    "STRUCTURED_PROVIDER_PROCESS_EXITED",
    "STRUCTURED_PROVIDER_REAP_FAILED",
    "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
    "STRUCTURED_PROVIDER_REQUEST_FAILED",
    "STRUCTURED_PROVIDER_HTTP_FAILED",
    "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
    "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
  ]) {
    await t.test(code, async () => {
      const initial = job({
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      const brainCalls = [];
      const failure = Object.assign(new Error("brain needs operator action"), {
        code,
      });
      let now = Date.parse("2026-08-02T02:00:00.000Z");
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain([failure, failure], brainCalls),
        grantVerifier: verifier([]),
        clock: () => new Date(now),
      });

      const first = await worker.runCycle();
      const second = await worker.runCycle();

      const automatic = automaticCodes.has(code);
      assert.equal(first.outcomes[0].status, automatic ? "retry" : "paused");
      assert.equal(first.outcomes[0].code, code);
      assert.equal(second.selected, automatic ? 1 : 0);
      assert.equal((await store.getForWorker(initial.jobId)).status, automatic ? "active" : "paused");
      assert.equal(brainCalls.length, 1);
      if (automatic) {
        assert.equal(second.outcomes[0].code, "CODE_JOB_MAINTENANCE_BACKOFF");
        now += 60_000;
        assert.equal((await worker.runCycle()).outcomes[0].status, "retry");
        assert.equal(brainCalls.length, 2);
        assert.equal((await store.getForWorker(initial.jobId)).status, "active");
      }
    });
  }
});

test("proactive-only task-brain setup failure does not broaden Code Job pause policy", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const failure = Object.assign(new Error("role task brain is unavailable"), {
    code: "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([failure], brainCalls),
    grantVerifier: verifier([]),
  });

  const cycle = await worker.runCycle();

  assert.equal(cycle.outcomes[0].status, "retry");
  assert.equal(cycle.outcomes[0].code, "ROLE_TASK_BRAIN_NOT_CONFIGURED");
  assert.equal((await store.getForWorker(initial.jobId)).status, "active");
  assert.equal(brainCalls.length, 1);
});

test("two locally invalid model responses pause once without another cycle call", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const providerCalls = [];
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate(value) {
        providerCalls.push(structuredClone(value));
        return "not json";
      },
      describe(brainConfig) {
        return { ...brainConfig, remote: false };
      },
    },
    roles: {
      developer: {
        taskBrain: {
          provider: "brain-one",
          model: "qwen3.5:9b",
          remoteData: { requirements: false, code: false, memory: false },
        },
      },
    },
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: directory,
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "paused");
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_RESPONSE_INVALID");
  assert.equal(second.selected, 0);
  assert.equal(providerCalls.length, 2);
  assert.equal((await store.getForWorker(initial.jobId)).status, "paused");
});

test("revocation after an invalid response blocks the correction provider call", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const providerCalls = [];
  let revoked = false;
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate(value) {
        providerCalls.push(structuredClone(value));
        revoked = true;
        return "not json";
      },
      describe(brainConfig) {
        return { ...brainConfig, remote: false };
      },
    },
    roles: {
      developer: {
        taskBrain: {
          provider: "brain-one",
          model: "qwen3.5:9b",
          remoteData: { requirements: false, code: false, memory: false },
        },
      },
    },
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: directory,
    grantVerifier: {
      async verify(value) {
        if (revoked) {
          throw Object.assign(new Error("revoked before correction"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.equal(providerCalls.length, 1);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("workspace divergence fences once instead of retaining the oldest retry slot", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.workspaceRevision = REVISION_B;
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "CODE_JOB_WORKSPACE_DIVERGED");
  assert.equal(second.selected, 0);
});

test("session binding divergence fences once instead of retrying forever", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.workspaceId = "another-workspace";
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  assert.equal(second.selected, 0);
});

test("a cancelled admitted action is reconciled without entering the executor", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  store.afterAdmit = async () => {
    const admitted = await store.getForWorker(initial.jobId);
    await store.cancel({
      jobId: admitted.jobId,
      expectedRevision: admitted.revision,
      reason: "cancel won after admission",
    });
  };
  const decisions = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], decisions),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal(result.cancelled, 1);
  assert.equal(stored.status, "cancelled");
  assert.equal(decisions.length, 1);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("cancellation carries the sealed PR Head and rejects a mismatched settlement", async () => {
  const inputBinding = pullRequestInputBinding();
  const initial = job({
    grant: grant({ inputBinding }),
    status: "active",
    revision: 3,
    execution: {
      ...job().execution,
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "cancel exact PR Head",
  });
  const executor = new FakeExecutor(initial);
  executor.session.inputBinding.headRefOid = "6".repeat(40);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  const request = executor.calls.find(
    ({ method }) => method === "reconcileCancellation",
  ).value;

  assert.deepEqual(request.inputBinding, inputBinding);
  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(result.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelling");
});

test("durable cancellation aborts an in-flight action only as a best effort", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const entered = deferred();
  const release = deferred();
  executor.perform = async (_value, { signal }) => {
    executor.lastSignal = signal;
    entered.resolve(signal);
    await release.promise;
    throw Object.assign(new Error("action aborted"), {
      code: "CODE_JOB_ACTION_INTERRUPTED",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "run_profile", profileId: "node-tests" }]),
    grantVerifier: verifier([]),
  });

  const cycle = worker.runCycle();
  const signal = await entered.promise;
  assert.equal(signal.aborted, false);
  const admitted = await store.getForWorker(initial.jobId);
  const cancelling = await store.cancel({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "stop the running profile",
  });
  assert.equal(cancelling.job.status, "cancelling");
  assert.equal(worker.requestCancellation(initial.jobId), true);
  assert.equal(signal.aborted, true);
  release.resolve();

  const first = await cycle;
  assert.equal(first.outcomes[0].status, "cancelling");
  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(worker.requestCancellation(initial.jobId), false);
});

test("cancelling work waits for running actions before cleanup settlement", async () => {
  const action = {
    type: "complete",
    actionId: "cancel-running-action",
    expectedWorkspaceRevision: REVISION_A,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "running",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: null,
  });
  const cancelling = await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "wait for exact reconciliation",
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify() {
        throw new Error("cancelling work must not re-check revoked authority");
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal((await store.getForWorker(initial.jobId)).revision,
    cancelling.job.revision);

  executor.session.actions[0] = {
    ...executor.session.actions[0],
    status: "succeeded",
    workspaceRevisionAfter: REVISION_A,
  };
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  const second = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.execution.observations.length, 0);
  assert.equal(store.completionRequests.length, 0);
  assert.equal(brainCalls.length, 0);
});

test("a cancelling admitted session converges after the executor is absent", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "cancel session start",
  });
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(brainCalls.length, 0);
  assert.equal(executor.calls.filter(({ method }) => method === "start").length, 0);
});

test("an interrupted action is settled only by cleanup proof without replay", async () => {
  const action = {
    type: "write_text",
    actionId: "cancel-unknown-write",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedFileSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "stop an uncertain write",
  });
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: {
      code: "RESULT_UNKNOWN",
      message: "the write may have changed the isolated workspace",
      details: { cleanupPending: true },
    },
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(first.outcomes[0].status, "cancelled");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.execution.observations.length, 0);
  assert.equal(stored.execution.pendingAction, null);
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(store.completionRequests.length, 0);
  assert.equal(brainCalls.length, 0);
});

test("cancel-first transition prevents an admitted session start", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const beforeStartAdmission = deferred();
  const releaseVerification = deferred();
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    sessionTransitionLease,
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          beforeStartAdmission.resolve();
          await releaseVerification.promise;
        }
        return structuredClone(value);
      },
    },
  });

  const cycle = worker.runCycle();
  await beforeStartAdmission.promise;
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel wins the session admission",
  }));
  await cancellation;
  releaseVerification.resolve();
  const result = await cycle;

  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "start"), false);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);
  assert.ok(events.indexOf("cancel") > events.indexOf("claim"));
});

test("configuration-first admission claims no new work and starts or resumes no session", async (t) => {
  await t.test("start", async () => {
    const initial = job();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const events = [];
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial);
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
      actionAdmissionGate: gate,
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "restart_required");
    assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
    assert.equal(executor.calls.some(({ method }) => method === "start"), false);
    assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
    assert.equal(brainCalls.length, 0);
    assert.equal(events.includes("claim"), false);
    assert.equal((await store.getForWorker(initial.jobId)).status, "queued");
  });

  await t.test("resume", async () => {
    const initial = job({
      status: "starting",
      revision: 2,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: null,
        turn: 0,
        pendingAction: null,
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
        uncertainty: null,
      },
    });
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], {
      sessionStatus: "interrupted",
    });
    executor.exists = true;
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
      actionAdmissionGate: gate,
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "restart_required");
    assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
    assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
    assert.equal(brainCalls.length, 0);
    assert.equal((await store.getForWorker(initial.jobId)).status, "starting");
  });
});

test("claim-first admission releases cutover before durable storage settles", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const claimStarting = store.claimStarting.bind(store);
  const claimEntered = deferred();
  const releaseClaim = deferred();
  store.claimStarting = async (input) => {
    claimEntered.resolve();
    await releaseClaim.promise;
    return claimStarting(input);
  };
  const executor = new FakeExecutor(initial, events);
  const gate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    actionAdmissionGate: gate,
  });

  const cycle = worker.runCycle();
  await claimEntered.promise;
  const cutover = activateNextConfiguration(gate);
  const cutoverFinishedFirst = await Promise.race([
    cutover.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  releaseClaim.resolve();
  await cutover;
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(cutoverFinishedFirst, true);
  assert.equal(result.outcomes[0].status, "restart_required");
  assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
  assert.equal(stored.status, "starting");
  assert.equal(events.filter((event) => event === "claim").length, 1);
  assert.equal(executor.calls.some(({ method }) => method === "start"), false);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);
});

test("start-first admission releases the gate before the long start settles", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const startEntered = deferred();
  const startResult = deferred();
  executor.start = (value) => {
    executor.calls.push({ method: "start", value: structuredClone(value) });
    events.push("executor.start");
    startEntered.resolve();
    return startResult.promise;
  };
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const actionAdmissionGate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    sessionTransitionLease,
    actionAdmissionGate,
  });

  const cycle = worker.runCycle();
  await startEntered.promise;
  const cutover = activateNextConfiguration(actionAdmissionGate);
  assert.equal(
    await Promise.race([
      cutover,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel after start admission",
  }));
  const observed = await Promise.race([
    cancellation.then(() => "cancelled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);

  assert.equal(observed, "cancelled");
  assert.equal(events.indexOf("executor.start") < events.indexOf("cancel"), true);
  executor.exists = true;
  startResult.resolve(structuredClone(executor.session));
  const result = await cycle;

  assert.ok(["cancelling", "cancelled"].includes(result.outcomes[0].status));
  assert.equal(
    executor.calls.filter(({ method }) => method === "start").length,
    1,
  );
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("resume-first admission releases the gate before the long resume settles", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events, {
    sessionStatus: "interrupted",
  });
  executor.exists = true;
  const resumeEntered = deferred();
  const resumeResult = deferred();
  executor.resume = (value) => {
    executor.calls.push({ method: "resume", value: structuredClone(value) });
    events.push("executor.resume");
    resumeEntered.resolve();
    return resumeResult.promise;
  };
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const actionAdmissionGate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    sessionTransitionLease,
    actionAdmissionGate,
  });

  const cycle = worker.runCycle();
  await resumeEntered.promise;
  const cutover = activateNextConfiguration(actionAdmissionGate);
  assert.equal(
    await Promise.race([
      cutover,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel after resume admission",
  }));
  const observed = await Promise.race([
    cancellation.then(() => "cancelled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);

  assert.equal(observed, "cancelled");
  assert.equal(events.indexOf("executor.resume") < events.indexOf("cancel"), true);
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelling");
  resumeResult.resolve({
    ...structuredClone(executor.session),
    status: "active",
    attempt: { number: 2, status: "active" },
  });
  const result = await cycle;

  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(
    executor.calls.filter(({ method }) => method === "resume").length,
    1,
  );
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("cancellation committed during starting recovery prevents session resume", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.exists = true;
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before session recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});

test("cancellation committed during idle recovery prevents session resume", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before idle recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  const settled = await worker.runCycle();
  assert.equal(settled.outcomes[0].status, "cancelled");
});

test("cancellation committed during prepared recovery prevents session resume", async () => {
  const action = {
    type: "read_text",
    actionId: "cancel-before-prepared-resume",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  let verifyCount = 0;
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 3) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before prepared recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});

test("cancellation committed during unknown recovery prevents session resume", async () => {
  const action = {
    type: "write_text",
    actionId: "cancel-before-unknown-resume",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "export const value = 3;\n",
    expectedFileSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "the action result requires reconciliation",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: { code: "RESULT_UNKNOWN", message: "result unknown" },
  });
  const reconcile = executor.reconcileAction.bind(executor);
  let cancelled = false;
  executor.reconcileAction = async (value) => {
    const result = await reconcile(value);
    if (!cancelled) {
      cancelled = true;
      const current = await store.getForWorker(initial.jobId);
      await store.cancel({
        jobId: current.jobId,
        expectedRevision: current.revision,
        reason: "cancel before unknown recovery",
      });
    }
    return result;
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});
