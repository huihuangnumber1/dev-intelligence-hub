import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import {
  deliveryEvidenceKindsForProposal,
  normalizeDeliveryEvidenceTarget,
} from "../domain/delivery-evidence-contract.js";
import {
  assertWorkProposalExactKeys,
  boundedWorkProposalText,
  cloneWorkProposalValue,
  normalizeWorkProposalDigest,
  normalizeWorkProposalReference,
  safeWorkProposalInteger,
  workProposalArrayValues,
  workProposalError,
} from "../domain/work-proposal-contract.js";

const EVIDENCE_KINDS = new Set([
  "change-package",
  "test-report",
  "review-report",
  "github-review",
]);
const MAX_EVIDENCE_CANDIDATES = 100;

function evidenceQueryError() {
  return workProposalError(
    "INVALID_WORK_PROPOSAL_EVIDENCE_QUERY",
    "工作提案证据查询无效",
  );
}

function optionalAbortSignal(value, error) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function" ||
    typeof value.throwIfAborted !== "function"
  ) {
    throw error;
  }
  return value;
}

function normalizeEvidenceReferenceQuery(value, key) {
  const error = evidenceQueryError();
  if (typeof value === "string") {
    return { reference: value, signal: null, error };
  }
  assertWorkProposalExactKeys(
    value,
    Object.hasOwn(value ?? {}, "signal") ? [key, "signal"] : [key],
    error,
  );
  return {
    reference: value[key],
    signal: optionalAbortSignal(value.signal, error),
    error,
  };
}

function normalizeEvidenceResultId(value) {
  const query = normalizeEvidenceReferenceQuery(value, "resultId");
  return {
    resultId: normalizeWorkProposalReference(query.reference, "resultId", {
      maximumBytes: 96,
      error: query.error,
    }),
    signal: query.signal,
  };
}

function normalizeEvidenceProposalId(value) {
  const query = normalizeEvidenceReferenceQuery(value, "proposalId");
  return {
    proposalId: normalizeWorkProposalReference(query.reference, "proposalId", {
      maximumBytes: 512,
      error: query.error,
    }),
    signal: query.signal,
  };
}

function normalizeEvidenceKinds(value, error) {
  const kinds = workProposalArrayValues(
    value,
    EVIDENCE_KINDS.size,
    error,
  );
  if (
    kinds.length === 0 ||
    kinds.some((kind) => !EVIDENCE_KINDS.has(kind)) ||
    new Set(kinds).size !== kinds.length
  ) {
    throw error;
  }
  return new Set(kinds);
}

function normalizeEvidenceCandidateQuery(value) {
  const error = evidenceQueryError();
  const optionalKeys = ["beforeSequence", "signal"].filter((key) =>
    Object.hasOwn(value ?? {}, key)
  );
  assertWorkProposalExactKeys(
    value,
    [
      "taskId",
      "roleId",
      "contractRevision",
      "contractDigest",
      "kinds",
      "limit",
      ...optionalKeys,
    ],
    error,
  );
  return {
    taskId: boundedWorkProposalText(value.taskId, "taskId", {
      maximumBytes: 256,
      error,
    }),
    roleId: boundedWorkProposalText(value.roleId, "roleId", {
      maximumBytes: 128,
      pattern: /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/,
      error,
    }),
    contractRevision: safeWorkProposalInteger(
      value.contractRevision,
      "contractRevision",
      { minimum: 1, error },
    ),
    contractDigest: normalizeWorkProposalDigest(value.contractDigest, error),
    kinds: normalizeEvidenceKinds(value.kinds, error),
    limit: safeWorkProposalInteger(value.limit, "limit", {
      minimum: 1,
      maximum: MAX_EVIDENCE_CANDIDATES,
      error,
    }),
    beforeSequence: Object.hasOwn(value, "beforeSequence")
      ? safeWorkProposalInteger(value.beforeSequence, "beforeSequence", {
          minimum: 1,
          error,
        })
      : Number.MAX_SAFE_INTEGER,
    signal: optionalAbortSignal(value.signal, error),
  };
}

function checkAbort(signal) {
  signal?.throwIfAborted();
}

function proposalSupportsEvidenceKind(proposal, evidenceKind) {
  const descriptor = proposal.kind === "code_action_proposal"
    ? { kind: proposal.kind, operation: proposal.payload.operation }
    : { kind: proposal.kind };
  return deliveryEvidenceKindsForProposal(descriptor).includes(evidenceKind);
}

function proposalEvidenceTarget(proposal, query) {
  if (
    proposal.requestedBy.workItemId !== query.taskId ||
    proposal.requestedBy.roleId !== query.roleId
  ) {
    return null;
  }
  let target;
  try {
    target = normalizeDeliveryEvidenceTarget(proposal.binding.evidenceTarget);
  } catch {
    return null;
  }
  const [deliverable] = target.deliverables;
  return target.taskId === query.taskId &&
      target.roleId === query.roleId &&
      target.contractRevision === query.contractRevision &&
      target.contractDigest === query.contractDigest &&
      query.kinds.has(deliverable.kind) &&
      proposalSupportsEvidenceKind(proposal, deliverable.kind)
    ? target
    : null;
}

function evidenceCandidate(result, proposal, query) {
  if (
    result.outcome !== "succeeded" ||
    result.requestedBy.workItemId !== query.taskId ||
    result.requestedBy.roleId !== query.roleId ||
    proposalEvidenceTarget(proposal, query) === null
  ) {
    return null;
  }
  return cloneWorkProposalValue({ proposal, result });
}

function evidenceCandidatePage(state, query) {
  const proposalsById = new Map(
    state.proposals.map((entry) => [entry.proposal.proposalId, entry.proposal]),
  );
  const matches = [];
  for (let index = state.results.length - 1; index >= 0; index -= 1) {
    const result = state.results[index];
    if (result.sequence >= query.beforeSequence) continue;
    const proposal = proposalsById.get(result.proposalId);
    const candidate = proposal === undefined
      ? null
      : evidenceCandidate(result, proposal, query);
    if (candidate !== null) matches.push(candidate);
    if (matches.length > query.limit) break;
  }
  const hasMore = matches.length > query.limit;
  const items = hasMore ? matches.slice(0, query.limit) : matches;
  return {
    items,
    nextBeforeSequence: hasMore ? items.at(-1).result.sequence : null,
  };
}

export class WorkProposalEvidenceReader {
  #readState;

  constructor({ readState } = {}) {
    if (typeof readState !== "function") {
      throw new TypeError("readState is invalid");
    }
    this.#readState = readState;
  }

  getResult(value) {
    const { resultId, signal } = normalizeEvidenceResultId(value);
    const state = this.#readState();
    checkAbort(signal);
    const result = state.results.find(
      (candidate) => candidate.resultId === resultId,
    );
    const projection = result === undefined
      ? null
      : cloneWorkProposalValue(result);
    checkAbort(signal);
    return projection;
  }

  getProposalForEvidence(value) {
    const { proposalId, signal } = normalizeEvidenceProposalId(value);
    const state = this.#readState();
    checkAbort(signal);
    const item = state.proposals.find(
      (candidate) => candidate.proposal.proposalId === proposalId,
    );
    const projection = item === undefined
      ? null
      : cloneWorkProposalValue(item.proposal);
    checkAbort(signal);
    return projection;
  }

  getResultForProposal(value) {
    const { proposalId, signal } = normalizeEvidenceProposalId(value);
    const state = this.#readState();
    checkAbort(signal);
    const item = state.proposals.find(
      (candidate) => candidate.proposal.proposalId === proposalId,
    );
    const result = item?.resultId === null || item === undefined
      ? undefined
      : state.results.find((candidate) => candidate.resultId === item.resultId);
    const projection = result === undefined
      ? null
      : cloneWorkProposalValue(result);
    checkAbort(signal);
    return projection;
  }

  // Discovery is separate from the task-scoped accepted-evidence catalog.
  // Include all versions for this PR/account: even an old-Base pending action
  // can still publish. Candidate eligibility checks the exact target separately.
  listReviewPublicationSources(value) {
    const error = evidenceQueryError();
    const keys = ["inputBinding", "limit", ...(Object.hasOwn(value ?? {}, "signal") ? ["signal"] : [])];
    assertWorkProposalExactKeys(value, keys, error);
    const inputBinding = normalizePullRequestExecutionBinding(value.inputBinding);
    if (inputBinding.schemaVersion !== 2) throw error;
    const maximum = safeWorkProposalInteger(value.limit, "limit", { minimum: 1, maximum: MAX_EVIDENCE_CANDIDATES, error });
    const signal = optionalAbortSignal(value.signal, error);
    checkAbort(signal);
    const state = this.#readState();
    const results = new Map(state.results.map(result => [result.resultId, result]));
    const matches = state.proposals.filter(entry => {
      const proposal = entry.proposal;
      if (proposal.kind !== "github_review_proposal") return false;
      try {
        const source = normalizePullRequestExecutionBinding(proposal.binding.inputBinding);
        return source.repository === inputBinding.repository && source.pullRequestNumber === inputBinding.pullRequestNumber &&
          (source.schemaVersion === 1 ||
            source.gitTarget.sourceAccountId.toLowerCase() === inputBinding.gitTarget.sourceAccountId.toLowerCase());
      } catch { return false; }
    });
    checkAbort(signal);
    return { complete: matches.length <= maximum, items: matches.slice(-maximum).reverse().map(entry => cloneWorkProposalValue({
      proposal: entry.proposal, result: results.get(entry.resultId) ?? null,
      status: entry.status, downstreamRef: entry.downstreamRef,
    })) };
  }

  listEvidenceCandidates(value) {
    const query = normalizeEvidenceCandidateQuery(value);
    const state = this.#readState();
    checkAbort(query.signal);
    const page = evidenceCandidatePage(state, query);
    checkAbort(query.signal);
    return page;
  }
}
