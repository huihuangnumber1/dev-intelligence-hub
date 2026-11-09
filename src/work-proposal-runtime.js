import { randomUUID } from "node:crypto";
import {
  assertWorkProposalExactKeys,
  normalizeWorkProposalAdvanceRequest,
  normalizeWorkProposalClaimRequest,
  normalizeWorkProposalRunnerScope,
  workProposalArrayValues,
  workProposalDataEntries,
  workProposalError,
} from "./domain/work-proposal-contract.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { WorkProposalStore } from "./services/work-proposal-store.js";

const GUARD_NAME = "mydashboard-work-proposal-v1";
const DIRECT_ACTION_ADMISSION = Object.freeze({
  run: (operation) => operation(),
});

function validateGuard(value) {
  if (
    !value ||
    typeof value.acquire !== "function" ||
    typeof value.run !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new TypeError("work proposal guard is invalid");
  }
  return value;
}

function frozenPort(methods) {
  return Object.freeze(methods);
}

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

function invalidRunnerRequest() {
  return workProposalError(
    "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
    "工作提案 runner 请求无效",
  );
}

function runtimeClosedError() {
  return workProposalError(
    "WORK_PROPOSAL_RUNTIME_CLOSED",
    "工作提案运行时已关闭",
    503,
  );
}

function normalizeRunnerScopes(value) {
  const error = new TypeError("runnerScopes is invalid");
  let entries;
  try {
    entries = workProposalArrayValues(value, 32, error).map((entry) =>
      normalizeWorkProposalRunnerScope(entry),
    );
  } catch (cause) {
    throw new TypeError("runnerScopes is invalid", { cause });
  }
  const runnerIds = new Set(entries.map(({ runnerId }) => runnerId));
  if (runnerIds.size !== entries.length) throw error;
  return entries.map((entry) =>
    Object.freeze({
      ...entry,
      allowedKinds: Object.freeze(entry.allowedKinds),
      allowedRoleIds: Object.freeze(entry.allowedRoleIds),
    }),
  );
}

function bindClaimRequest(value, scope) {
  const error = invalidRunnerRequest();
  const fields = new Map(workProposalDataEntries(value, error));
  if (
    fields.size < 1 ||
    fields.size > 2 ||
    !fields.has("leaseDurationMs") ||
    [...fields.keys()].some((key) =>
      !["leaseDurationMs", "excludeProposalIds"].includes(key)
    )
  ) {
    throw error;
  }
  return normalizeWorkProposalClaimRequest({
    runnerId: scope.runnerId,
    leaseDurationMs: fields.get("leaseDurationMs"),
    ...(fields.has("excludeProposalIds")
      ? { excludeProposalIds: fields.get("excludeProposalIds") }
      : {}),
  });
}

function bindAdvanceRequest(value, scope) {
  const error = invalidRunnerRequest();
  assertWorkProposalExactKeys(
    value,
    ["proposalId", "contentDigest", "expectedRevision", "leaseId", "transition"],
    error,
  );
  return normalizeWorkProposalAdvanceRequest({
    proposalId: value.proposalId,
    contentDigest: value.contentDigest,
    expectedRevision: value.expectedRevision,
    runnerId: scope.runnerId,
    leaseId: value.leaseId,
    transition: value.transition,
  });
}

export async function createWorkProposalRuntime({
  store,
  clock,
  idFactory = randomUUID,
  limits,
  runnerScopes = [],
  actionAdmissionGate,
  operationQueue = new OperationQueue(),
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const scopes = normalizeRunnerScopes(runnerScopes);
  const admitAction = actionAdmissionRun(actionAdmissionGate);
  const guard = validateGuard(createGuard({ name: GUARD_NAME }));
  let closePromise = null;
  let accepting = true;
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
    closePromise ||= Promise.allSettled([...acceptedOperations]).then(() => guard.close());
    return closePromise;
  };
  try {
    await guard.acquire();
    const proposals = new WorkProposalStore({
      store,
      exclusiveLease: guard,
      operationQueue,
      idFactory,
      ...(clock ? { clock } : {}),
      ...(limits ? { limits } : {}),
    });
    await proposals.recover();
    const runners = Object.freeze(
      Object.fromEntries(
        scopes.map((scope) => [
          scope.runnerId,
          frozenPort({
            claim: (value) => admit(() => {
              const request = bindClaimRequest(value, scope);
              return runAdmittedOperation(
                admitAction,
                () => proposals.claim(request, scope),
              );
            }),
            advance: (value) =>
              admit(() => proposals.advance(bindAdvanceRequest(value, scope), scope)),
          }),
        ]),
      ),
    );
    return Object.freeze({
      producer: frozenPort({
        create: (value) => admit(() => proposals.create(value)),
      }),
      runners,
      consumer: frozenPort({
        readResultBatch: (value) => admit(() => proposals.readResultBatch(value)),
      }),
      evidenceReader: frozenPort({
        getResult: (value) => admit(() => proposals.getResult(value)),
        getProposalForEvidence: (value) =>
          admit(() => proposals.getProposalForEvidence(value)),
        getResultForProposal: (value) =>
          admit(() => proposals.getResultForProposal(value)),
        listReviewPublicationSources: (value) =>
          admit(() => proposals.listReviewPublicationSources(value)),
        listEvidenceCandidates: (value) =>
          admit(() => proposals.listEvidenceCandidates(value)),
      }),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after closing the independent guard.
    }
    throw error;
  }
}
