import { randomUUID } from "node:crypto";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { WorkGraphStore } from "./services/work-graph-store.js";
import { createWorkerWorkLedgerCandidateProcessor } from
  "./services/work-ledger-candidate-processor.js";
import { WorkLedgerService } from "./services/work-ledger-service.js";
import {
  boundedLedgerString,
  hasExactLedgerKeys,
  workLedgerError,
} from "./services/work-ledger-values.js";

const GUARD_NAME = "mydashboard-work-ledger-v1";
const ORCHESTRATOR_PRINCIPAL_ID = "employee-orchestrator";
const RUNTIME_METHODS = Object.freeze([
  "getSummary",
  "getRoleWorkloads",
  "listItems",
  "readItemProgress",
  "readRepairDecisionBudget",
  "readInternalReviewHandoff",
  "listClaimCandidates",
  "listPendingPullRequestSources",
  "listTimeline",
  "listOutbox",
  "readItemForReconciliation",
  "readReviewAdoptionContext",
  "readAutomaticRoleHandoffCandidates",
  "canReconnectOwnPullRequest",
  "isAttentionRequestCurrent",
  "areAttentionRequestsCurrent",
  "readAttentionRequestRetirement",
  "isIntentDispatchCurrent",
  "verifyPullRequestExecutionBinding",
  "verifyPullRequestExecutionBindings",
  "readPullRequestExecutionContext",
  "readAutomaticReviewAdmission",
  "readCurrentAutomaticReviewWork",
  "intake",
  "retireInactiveIssues",
  "retireAutomaticReviewTestingWork",
  "reconcilePullRequestSource",
  "reconcilePullRequestSourceBatch",
  "claim",
  "transition",
  "recoverUnstartedReviewProposal",
  "canRecoverUnstartedReviewProposal",
  "controlModelRun",
  "scheduleRetry",
  "handoff",
  "complete",
  "cancelGraphTask",
  "stageIntent",
  "claimIntent",
  "bindIntent",
  "ackIntent",
  "applyAttentionBatch",
  "retrySystemMaintenanceQuestions",
  "applyProposalBatch",
  "wakeCondition",
]);

function runtimeClosedError() {
  return workLedgerError(
    "WORK_LEDGER_RUNTIME_CLOSED",
    "工作台账运行时已关闭",
    503,
  );
}

function scopedRootTaskId(value) {
  if (!hasExactLedgerKeys(value, ["scopeRootTaskId"])) {
    throw new TypeError("scoped work graph planner request is invalid");
  }
  try {
    return boundedLedgerString(
      value.scopeRootTaskId,
      "scopeRootTaskId",
      192,
    );
  } catch {
    throw new TypeError("scoped work graph planner request is invalid");
  }
}

function graphClaimAuthority(value) {
  if (
    !hasExactLedgerKeys(value, [
      "scopeRootTaskId",
      "taskId",
      "workerId",
      "leaseId",
    ])
  ) {
    throw new TypeError("work graph delivery claim is invalid");
  }
  try {
    return {
      scopeRootTaskId: boundedLedgerString(
        value.scopeRootTaskId,
        "scopeRootTaskId",
        192,
      ),
      taskId: boundedLedgerString(value.taskId, "taskId", 192),
      principalId: boundedLedgerString(value.workerId, "workerId", 128),
      leaseId: boundedLedgerString(value.leaseId, "leaseId", 128),
    };
  } catch {
    throw new TypeError("work graph delivery claim is invalid");
  }
}

export async function createWorkLedgerRuntime({
  store,
  assignmentSource,
  operationQueue,
  actionAdmissionGate,
  clock,
  idFactory = randomUUID,
  limits,
  postCommitYield,
  confirmationSettlementReader,
  obsoleteCodeJobSettler,
  hostContextRecoveryReader,
  reviewTestingRetirementReader,
  attachHostHeadAncestry,
  createCandidateProcessor = createWorkerWorkLedgerCandidateProcessor,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  if (typeof createCandidateProcessor !== "function") {
    throw new TypeError("createCandidateProcessor must be a function");
  }
  const guard = createGuard({ name: GUARD_NAME });
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("work ledger guard is invalid");
  }
  let closePromise = null;
  let accepting = true;
  let candidateProcessor = null;
  const acceptedOperations = new Set();
  const admit = (operation) => {
    if (!accepting) return Promise.reject(runtimeClosedError());
    let result;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    acceptedOperations.add(result);
    result.then(
      () => acceptedOperations.delete(result),
      () => acceptedOperations.delete(result),
    );
    return result;
  };
  const close = () => {
    accepting = false;
    closePromise ||= Promise.allSettled([...acceptedOperations]).then(
      async () => {
        let processorFailure;
        try {
          await candidateProcessor?.close?.();
        } catch (error) {
          processorFailure = error;
        }
        try {
          await guard.close();
        } catch (error) {
          if (processorFailure) {
            throw new AggregateError([processorFailure, error]);
          }
          throw error;
        }
        if (processorFailure) throw processorFailure;
      },
    );
    return closePromise;
  };

  try {
    await guard.acquire();
    candidateProcessor = createCandidateProcessor();
    const service = new WorkLedgerService({
      store,
      assignmentSource,
      exclusiveLease: guard,
      idFactory,
      candidateProcessor,
      ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
      ...(operationQueue ? { operationQueue } : {}),
      ...(clock ? { clock } : {}),
      ...(limits ? { limits } : {}),
      ...(postCommitYield === undefined ? {} : { postCommitYield }),
      ...(confirmationSettlementReader === undefined ? {} : { confirmationSettlementReader }),
      ...(obsoleteCodeJobSettler === undefined ? {} : { obsoleteCodeJobSettler }),
      ...(hostContextRecoveryReader === undefined ? {} : { hostContextRecoveryReader }),
      ...(reviewTestingRetirementReader === undefined ? {} : { reviewTestingRetirementReader }),
    });
    await service.recover();
    if (attachHostHeadAncestry !== undefined) {
      if (typeof attachHostHeadAncestry !== "function") throw new TypeError("Invalid host Head ancestry attachment");
      attachHostHeadAncestry(Object.freeze({
        readCandidates: options => admit(() => service.readHostHeadAncestryCandidates(options)),
        readItemForReconciliation: options => admit(() => service.readItemForReconciliation(options)),
        record: credential => admit(() => service.recordHostHeadAncestry(credential)),
      }));
    }
    const graph = new WorkGraphStore({ ledger: service });
    const graphReader = graph.reader();
    const graphPlanner = graph.planner({
      principalId: ORCHESTRATOR_PRINCIPAL_ID,
      scopeRootTaskId: null,
    });
    const wrapPlanner = (planner) => Object.freeze({
      createChild: (command) => admit(() => planner.createChild(command)),
      reviseAcceptanceContract: (command) =>
        admit(() => planner.reviseAcceptanceContract(command)),
      decideDelivery: (command) =>
        admit(() => planner.decideDelivery(command)),
      reassignTask: (command) =>
        admit(() => planner.reassignTask(command)),
      pauseTask: (command) => admit(() => planner.pauseTask(command)),
      resumeTask: (command) => admit(() => planner.resumeTask(command)),
      cancelTask: (command) => admit(() => planner.cancelTask(command)),
      stageEscalation: (command) =>
        admit(() => planner.stageEscalation(command)),
    });
    const runtime = {
      graphReader: Object.freeze({
        getSnapshot: (options) => admit(() => graphReader.getSnapshot(options)),
      }),
      graphBrowserReader: Object.freeze({
        getSnapshot: () =>
          admit(() => service.getLastCommittedGraphSnapshot()),
      }),
      graphPlanner: Object.freeze({
        createChild: (command) => admit(() => graphPlanner.createChild(command)),
        reviseAcceptanceContract: (command) =>
          admit(() => graphPlanner.reviseAcceptanceContract(command)),
        decideDelivery: (command) =>
          admit(() => graphPlanner.decideDelivery(command)),
        resumeTask: (command) => admit(() => graphPlanner.resumeTask(command)),
      }),
      scopedGraphPlannerFactory: Object.freeze({
        forRoot: (request) => {
          if (!accepting) throw runtimeClosedError();
          return wrapPlanner(graph.planner({
            principalId: ORCHESTRATOR_PRINCIPAL_ID,
            scopeRootTaskId: scopedRootTaskId(request),
          }));
        },
      }),
      graphDelivererFactory: Object.freeze({
        forClaim: (request) => {
          if (!accepting) throw runtimeClosedError();
          const authority = graphClaimAuthority(request);
          const deliverer = graph.deliverer(authority);
          return Object.freeze({
            submitDelivery: (command) =>
              admit(() => deliverer.submitDelivery(command)),
          });
        },
      }),
      graphMemoryProjectionSource: Object.freeze({
        readBatch: (options) =>
          admit(() => service.readGraphMemoryProjectionBatch(options)),
        ack: (receipt) =>
          admit(() => service.acknowledgeGraphMemoryProjection(receipt)),
        ackBatch: (request) =>
          admit(() => service.acknowledgeGraphMemoryProjectionBatch(request)),
      }),
      memoryAuthoritySource: Object.freeze({
        readSnapshot: (options) =>
          admit(() => service.readMemoryAuthoritySnapshot(options)),
        readStatus: () => admit(() => service.readMemoryAuthorityStatus()),
      }),
      close,
    };
    for (const method of RUNTIME_METHODS) {
      runtime[method] = (...args) => admit(() => service[method](...args));
    }
    return Object.freeze(runtime);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure while the ledger remains fail closed.
    }
    throw error;
  }
}
