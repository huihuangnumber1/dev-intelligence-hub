import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeExecutionJournal } from "../src/services/code-execution-journal.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobWorkerService } from "../src/services/code-job-worker-service.js";
import { ObsoleteCodeJobSettler } from "../src/services/obsolete-code-job-settler.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "../src/services/controlled-code-executor.js";

const WORKSPACE_ID = "dashboard";
const SOURCE_CONTENT = "export const value = 1;\n";
const ISOLATED_CONTENT = "export const value = 2;\n";
const PROFILE_ID = "node-tests";
const PROFILE_DEFINITION = Object.freeze({ kind: "integration-test" });
const PROFILE_DIGEST = digestValue(PROFILE_DEFINITION);

const exclusiveLease = Object.freeze({
  run(operation) {
    return operation();
  },
});

function monotonicClock(initial = "2026-08-03T00:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    forJobs: () => new Date(now++),
    forExecutor: () => new Date(now++).toISOString(),
  };
}

function attemptExecutionId(sessionId, number = 1) {
  return `attempt-${digestValue({ number, sessionId }).slice(0, 24)}`;
}

function approval() {
  const grant = createCodeJobGrant({
    proposalId: "proposal-cancellation-integration",
    contentDigest: "a".repeat(64),
    policyVersion: 1,
    requestedBy: {
      roleId: "developer",
      workItemId: "work-cancellation-integration",
    },
    source: {
      assignmentId: "assignment-cancellation-integration",
      eventId: "event-cancellation-integration",
    },
    subject: {
      id: "github:acme/dashboard:pull-request:17",
      repository: "acme/dashboard",
      number: 17,
    },
    repository: "acme/dashboard",
    workspaceId: WORKSPACE_ID,
    workspaceAuthorityDigest: "b".repeat(64),
    operation: "modify",
    objective: "Update the dashboard value in an isolated workspace.",
    acceptanceCriteria: ["The source checkout remains unchanged until delivery."],
    evidence: ["The controlled write acknowledgement can be lost."],
    summary: "Exercise cancellation of an uncertain controlled write.",
    reason: "Cancellation must discard unknown isolated side effects.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src"],
    requiredProfiles: [{ id: PROFILE_ID, configDigest: PROFILE_DIGEST }],
    brainDigest: "c".repeat(64),
  });
  return {
    confirmationId: "confirmation-cancellation-integration",
    requestId: "request-cancellation-integration",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant,
  };
}

class NoopSandbox {
  constructor() {
    this.cleanupCalls = [];
  }

  getProfileFingerprint(profileId) {
    return profileId === PROFILE_ID ? PROFILE_DIGEST : null;
  }

  async run() {
    throw new Error("The cancellation scenario must not run a profile");
  }

  async cleanup(request) {
    this.cleanupCalls.push(structuredClone(request));
  }
}

function instrumentBroker(broker, calls) {
  return new Proxy(broker, {
    get(target, property) {
      if (property === "createExecution") {
        return async (request) => {
          calls.createExecution += 1;
          return target.createExecution(request);
        };
      }
      if (property === "writeFile") {
        return async (request) => {
          calls.writeFile += 1;
          await target.writeFile(request);
          throw new Error("The isolated write succeeded but its acknowledgement was lost");
        };
      }
      if (property === "discardExecution") {
        return async (request) => {
          calls.discardExecution += 1;
          return target.discardExecution(request);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function instrumentExecutor(executor, calls) {
  return Object.freeze({
    start: executor.start.bind(executor),
    view: executor.view.bind(executor),
    resume(request) {
      calls.resume += 1;
      return executor.resume(request);
    },
    perform: executor.perform.bind(executor),
    getActionResult: executor.getActionResult.bind(executor),
    reconcileAction: executor.reconcileAction.bind(executor),
    reconcileCancellation: executor.reconcileCancellation.bind(executor),
  });
}

function createJobStore(store, clock) {
  return new CodeJobStore({
    store,
    exclusiveLease,
    operationQueue: new OperationQueue(),
    clock,
  });
}

function createExecutor({ broker, sandbox, store, journal, clock }) {
  return new ControlledCodeExecutor({
    broker,
    sandbox,
    store,
    journal,
    profileDefinitions: { [PROFILE_ID]: PROFILE_DEFINITION },
    requiredProfilesByWorkspace: { [WORKSPACE_ID]: [PROFILE_ID] },
    clock,
  });
}

test("cancelling an admitted unknown write discards it without resume and survives restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "code-job-cancel-integration-"));
  const sourceRoot = path.join(root, "source");
  const scratchRoot = path.join(root, "scratch");
  const stateRoot = path.join(root, "state");
  const journalRoot = path.join(root, "execution-artifacts");
  const sourceFile = path.join(sourceRoot, "src", "app.js");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, SOURCE_CONTENT);
  t.after(() => rm(root, { recursive: true, force: true }));

  const clock = monotonicClock();
  const durableStore = new StateStore(stateRoot);
  const jobs = createJobStore(durableStore, clock.forJobs);
  await jobs.recover();

  const brokerCalls = {
    createExecution: 0,
    writeFile: 0,
    discardExecution: 0,
  };
  const baseBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [{
      id: WORKSPACE_ID,
      sourceRoot,
      writablePaths: ["src"],
    }],
  });
  const broker = instrumentBroker(baseBroker, brokerCalls);
  const sandbox = new NoopSandbox();
  const executor = createExecutor({
    broker,
    sandbox,
    store: durableStore,
    journal: new CodeExecutionJournal({ root: journalRoot }),
    clock: clock.forExecutor,
  });
  await executor.recover();

  const executorCalls = { resume: 0 };
  const decisions = [
    { type: "read_text", path: "src/app.js" },
    { type: "write_text", path: "src/app.js", content: ISOLATED_CONTENT },
  ];
  const brainDirectory = {
    async decide() {
      const action = decisions.shift();
      assert.ok(action, "the worker requested an unexpected extra brain turn");
      return { action };
    },
  };
  const worker = new CodeJobWorkerService({
    jobStore: jobs,
    executor: instrumentExecutor(executor, executorCalls),
    brainDirectory,
    grantVerifier: {
      async verify(grant) {
        return structuredClone(grant);
      },
    },
  });

  const created = await jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;
  const executionId = attemptExecutionId(jobId);
  const isolatedFile = path.join(
    scratchRoot,
    WORKSPACE_ID,
    executionId,
    "src",
    "app.js",
  );

  const readCycle = await worker.runCycle();
  assert.equal(readCycle.outcomes[0].status, "active");
  assert.equal(readCycle.outcomes[0].actionType, "read_text");

  const uncertainCycle = await worker.runCycle();
  assert.equal(uncertainCycle.outcomes[0].status, "unknown");
  assert.equal(uncertainCycle.outcomes[0].actionType, "write_text");
  assert.equal(uncertainCycle.outcomes[0].code, "RESULT_UNKNOWN");

  const unknown = await jobs.getForWorker(jobId);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.execution.pendingAction.action.type, "write_text");
  assert.equal(
    unknown.execution.actionAdmission.actionDigest,
    unknown.execution.pendingAction.actionDigest,
  );
  assert.equal(unknown.execution.uncertainty.code, "RESULT_UNKNOWN");
  const interruptedSession = await executor.view({ sessionId: jobId });
  assert.equal(interruptedSession.status, "interrupted");
  assert.equal(interruptedSession.actions.at(-1).status, "interrupted");
  assert.equal(interruptedSession.attempt.number, 1);
  assert.equal(await readFile(isolatedFile, "utf8"), ISOLATED_CONTENT);
  assert.equal(await readFile(sourceFile, "utf8"), SOURCE_CONTENT);

  let cancellationRequests = 0;
  const settler = new ObsoleteCodeJobSettler({
    codeJobReader: jobs,
    codeJobControl: { cancel: (request) => {
      cancellationRequests += 1;
      return jobs.cancel(request);
    } },
  });
  const settlementInput = { grant: approval().grant, receipt: { id: jobId, createdAt: created.job.createdAt } };
  assert.equal((await settler.settle(settlementInput)).status, "cancelling");
  assert.equal((await settler.settle(settlementInput)).status, "cancelling");
  assert.equal(cancellationRequests, 1);

  const cancelledCycle = await worker.runCycle();
  assert.equal(cancelledCycle.outcomes[0].status, "cancelled");
  const cancelled = await jobs.getForWorker(jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await settler.settle(settlementInput)).status, "cancelled");
  assert.equal(cancellationRequests, 1);
  assert.equal(cancelled.execution.pendingAction, null);
  assert.equal(cancelled.execution.actionAdmission, null);
  assert.equal(cancelled.execution.uncertainty, null);
  assert.deepEqual(cancelled.execution.cancellationSettlement, {
    kind: "controlled_execution_cancelled",
    sessionId: jobId,
    cancellationDigest: cancelled.execution.result.detailDigest,
    workspaceRevision: cancelled.execution.workspaceRevision,
    proofDigest: cancelled.execution.cancellationSettlement.proofDigest,
    settledAt: cancelled.execution.cancellationSettlement.settledAt,
  });
  assert.match(
    cancelled.execution.cancellationSettlement.proofDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(executorCalls.resume, 0);
  assert.deepEqual(brokerCalls, {
    createExecution: 1,
    writeFile: 1,
    discardExecution: 1,
  });
  assert.equal((await executor.view({ sessionId: jobId })).attempt.number, 1);
  await assert.rejects(
    readFile(isolatedFile),
    (error) => error?.code === "ENOENT",
  );
  assert.deepEqual(await readdir(path.join(scratchRoot, WORKSPACE_ID)), []);
  assert.equal(await readFile(sourceFile, "utf8"), SOURCE_CONTENT);

  const restartedStore = new StateStore(stateRoot);
  const restartedJobs = createJobStore(restartedStore, clock.forJobs);
  await restartedJobs.recover();
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [{
      id: WORKSPACE_ID,
      sourceRoot,
      writablePaths: ["src"],
    }],
  });
  const restartedExecutor = createExecutor({
    broker: restartedBroker,
    sandbox: new NoopSandbox(),
    store: restartedStore,
    journal: new CodeExecutionJournal({ root: journalRoot }),
    clock: clock.forExecutor,
  });
  await restartedExecutor.recover();

  const recoveredJob = await restartedJobs.getForWorker(jobId);
  const recoveredSession = await restartedExecutor.view({ sessionId: jobId });
  assert.equal(recoveredJob.status, "cancelled");
  assert.deepEqual(
    recoveredJob.execution.cancellationSettlement,
    cancelled.execution.cancellationSettlement,
  );
  assert.equal(recoveredSession.status, "cancelled");
  assert.equal(recoveredSession.attempt.number, 1);
  assert.equal(recoveredSession.attempt.status, "cancelled");
  assert.deepEqual(await readdir(path.join(scratchRoot, WORKSPACE_ID)), []);
  assert.equal(await readFile(sourceFile, "utf8"), SOURCE_CONTENT);
});
