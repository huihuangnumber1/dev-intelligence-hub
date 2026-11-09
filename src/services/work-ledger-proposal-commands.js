import { normalizeWorkProposalResult } from "../domain/work-proposal-contract.js";
import { continuesOwnPullRequestRepairEvidence } from "./work-ledger-inspection-continuation.js";
import { normalizeDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import {
  isWorkItemInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  createWorkDecisionContext,
} from "./work-ledger-state.js";
import {
  currentWorkItemExecutionBinding,
  pullRequestHeadAdmission,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "./work-ledger-pr-source.js";
import {
  createProposalResultAttestation,
} from "./work-ledger-result-attestation.js";
import { isSettledIssueReason } from "./work-ledger-issue-lifecycle.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import {
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const MAX_PROPOSAL_BATCH = 100;
const PROPOSAL_INTENT_TYPES = new Map([
  ["github_review_proposal", "propose_github_review"],
  [
    "github_pull_request_action_proposal",
    "propose_github_pull_request_action",
  ],
  ["code_action_proposal", "propose_code_action"],
  ["configuration_change_proposal", "propose_configuration_change"],
]);

const PULL_REQUEST_BINDING_FIELDS = Object.freeze([
  "kind",
  "rootItemId",
  "workKey",
  "inputRevision",
  "headRevision",
  "headRefOid",
  "eventId",
  "eventDigest",
  "inputDigest",
]);

function samePullRequestSourceBinding(left, right) {
  return left !== null && right !== null &&
    PULL_REQUEST_BINDING_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function contractedPullRequestInspectionStatus(state, item, outbox, result) {
  const boundIntent = outbox.dispatchBinding?.boundIntent;
  const contract = item.graph?.acceptanceContracts?.at(-1);
  if (
    item.kind !== "graph_task" ||
    typeof item.graph?.parentItemId !== "string" ||
    !(contract?.expectedDeliverables?.length > 0) ||
    result.kind !== "code_action_proposal" ||
    item.currentTarget?.type !== "role" ||
    item.currentTarget.id !== result.requestedBy.roleId ||
    outbox.sourceBinding?.kind !== "pull_request" ||
    outbox.intent.operation !== "inspect" ||
    boundIntent?.payload?.operation !== "inspect"
  ) {
    return null;
  }
  const admission = pullRequestHeadAdmission(state, item);
  if (!admission.applies || !admission.current || admission.pending) {
    return "blocked";
  }
  const current = currentWorkItemExecutionBinding(item);
  if (!samePullRequestSourceBinding(current, outbox.sourceBinding)) {
    return "blocked";
  }
  try {
    return current?.schemaVersion === 2 && samePullRequestExecutionBinding(
      current,
      boundIntent.binding.inputBinding,
    ) ? "queued" : "blocked";
  } catch {
    return "blocked";
  }
}

function proposalTimelineInputBinding(state, item, outbox) {
  const sourceBinding = outbox.sourceBinding;
  if (sourceBinding === null) return null;
  const dispatched = outbox.dispatchBinding?.boundIntent?.binding?.inputBinding;
  if (dispatched !== undefined) {
    const normalized = normalizePullRequestExecutionBinding(dispatched);
    if (samePullRequestSourceBinding(normalized, sourceBinding)) return normalized;
  }
  const current = currentWorkItemExecutionBinding(item);
  if (samePullRequestSourceBinding(current, sourceBinding)) return current;
  const root = state.items.find(
    (candidate) => candidate.itemId === sourceBinding.rootItemId,
  );
  return normalizePullRequestExecutionBinding({
    schemaVersion: 1,
    kind: "pull_request",
    repository: root.source.identity.repository,
    pullRequestNumber: root.source.identity.pullRequestNumber,
    ...sourceBinding,
  });
}

function invalid(message = "工作提案结果批次无效") {
  return workLedgerError("WORK_LEDGER_PROPOSAL_BATCH_INVALID", message, 502);
}

function dataArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_PROPOSAL_BATCH ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function normalizeResult(value) {
  try {
    return normalizeWorkProposalResult(value);
  } catch {
    throw invalid("工作提案结果无效");
  }
}

function normalizeBatch(input, state) {
  if (
    !hasExactLedgerKeys(input, [
      "items",
      "nextSequence",
      "highWatermark",
      "oldestAvailableSequence",
    ])
  ) {
    throw invalid();
  }
  const items = dataArray(input.items).map(normalizeResult);
  const nextSequence = input.nextSequence;
  const highWatermark = input.highWatermark;
  const oldest = input.oldestAvailableSequence;
  if (
    !Number.isSafeInteger(nextSequence) ||
    nextSequence < 0 ||
    !Number.isSafeInteger(highWatermark) ||
    highWatermark < 0 ||
    nextSequence > highWatermark ||
    !(oldest === null || (Number.isSafeInteger(oldest) && oldest >= 1)) ||
    items.some(
      (item, index) =>
        item.sequence > highWatermark ||
        (index > 0 && item.sequence !== items[index - 1].sequence + 1),
    ) ||
    (items.length > 0 && items.at(-1).sequence !== nextSequence) ||
    (items.length === 0 && nextSequence !== state.proposalCursor)
  ) {
    throw invalid("工作提案结果游标契约无效");
  }
  if (highWatermark < state.proposalHighWatermark) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_SOURCE_ROLLBACK",
      "工作提案结果源高水位发生回退",
      409,
    );
  }
  if (
    highWatermark > state.proposalCursor &&
    (oldest === null || oldest > state.proposalCursor + 1)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_GAP",
      "工作提案结果流存在无法安全跨越的缺口",
      409,
    );
  }
  const pending = items.filter(
    ({ sequence }) => sequence > state.proposalCursor,
  );
  if (
    pending.length > 0 &&
    pending[0].sequence !== state.proposalCursor + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_GAP",
      "工作提案结果序号不连续",
      409,
    );
  }
  return { items, pending, nextSequence, highWatermark };
}

function requireBoundProposal(state, result) {
  const item = requireWorkLedgerItem(state, result.requestedBy.workItemId);
  const matchingDownstreams = state.outbox.filter(
    (candidate) =>
      candidate.status === "delivered" &&
      candidate.outcome?.status === "delivered" &&
      candidate.outcome.details?.downstreamRef === result.proposalId,
  );
  const durablyQuarantined =
    item.sourceQuarantine?.kind === LEGACY_PR_SOURCE_QUARANTINE_KIND;
  const quarantinedSettlement =
    durablyQuarantined &&
    item.status === "blocked" &&
    item.activeIntentId === null;
  const settledIssueResult =
    item.status === "cancelled" &&
    item.activeIntentId === null &&
    isSettledIssueReason(item.statusReason);
  const outbox = state.outbox.find(
    (candidate) => candidate.intentId === item.activeIntentId,
  ) ?? ((quarantinedSettlement || settledIssueResult) &&
      matchingDownstreams.length === 1
    ? matchingDownstreams[0]
    : null);
  const waitingForResult =
    item.status === "waiting_external" &&
    item.activeIntentId === outbox?.intentId;
  const expectedIntentType = PROPOSAL_INTENT_TYPES.get(result.kind);
  const sealedSourceSettlement = (() => {
    if (
      !new Set([
        "pr_source_left_scope_pending_settlement",
        "pr_source_reentered_scope_pending_settlement",
      ]).has(item.statusReason) ||
      item.source?.kind !== "pull_request" ||
      outbox?.sourceBinding?.kind !== "pull_request" ||
      outbox.sourceBinding.rootItemId !== item.itemId ||
      outbox.sourceBinding.workKey !== item.source.workKey
    ) {
      return false;
    }
    const binding = outbox.sourceBinding;
    return item.source.revisions.some(
      (revision) =>
        revision.revision === binding.inputRevision &&
        revision.headRevision === binding.headRevision &&
        revision.headRefOid === binding.headRefOid &&
        revision.eventId === binding.eventId &&
        revision.eventDigest === binding.eventDigest &&
        revision.inputDigest === binding.inputDigest,
    );
  })();
  if (
    !outbox ||
    matchingDownstreams.length !== 1 ||
    matchingDownstreams[0].intentId !== outbox.intentId ||
    !expectedIntentType ||
    outbox.itemId !== item.itemId ||
    (outbox.inputDigest !== item.inputDigest && !sealedSourceSettlement) ||
    outbox.status !== "delivered" ||
    outbox.intent.type !== expectedIntentType ||
    outbox.requestedBy.roleId !== result.requestedBy.roleId ||
    (!waitingForResult && !quarantinedSettlement && !settledIssueResult) ||
    outbox.outcome?.status !== "delivered" ||
    outbox.outcome.details?.downstreamRef !== result.proposalId ||
    outbox.outcome.details?.proposalDigest !== result.proposalContentDigest
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
      "工作提案结果没有绑定当前等待中的受信意图",
      409,
    );
  }
  let evidenceTarget = null;
  const rawTarget = outbox.dispatchBinding?.boundIntent?.binding?.evidenceTarget;
  if (rawTarget !== undefined) {
    try {
      evidenceTarget = normalizeDeliveryEvidenceTarget(rawTarget);
    } catch (cause) {
      throw workLedgerError(
        "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        "工作提案证据目标绑定无效",
        409,
        { cause },
      );
    }
    if (
      evidenceTarget.taskId !== item.itemId ||
      evidenceTarget.roleId !== result.requestedBy.roleId
    ) {
      throw workLedgerError(
        "WORK_LEDGER_PROPOSAL_BINDING_CONFLICT",
        "工作提案证据目标不属于当前任务",
        409,
      );
    }
  }
  return {
    item,
    outbox,
    evidenceTarget,
    discardSettledIssueResult: settledIssueResult,
    discardUnsealedLegacyResult:
      durablyQuarantined &&
      (outbox.dispatchBinding === null ||
        !Object.hasOwn(outbox.dispatchBinding, "boundIntent")),
  };
}

export function planProposalBatchApplication({ state, input, clock }) {
  const batch = normalizeBatch(input, state);
  if (batch.nextSequence <= state.proposalCursor) {
    return {
      write: false,
      result: {
        applied: 0,
        deduplicated: batch.items.length,
        cursor: state.proposalCursor,
        highWatermark: state.proposalHighWatermark,
        itemIds: [],
      },
    };
  }

  const now = clock();
  let items = state.items;
  let outboxEntries = state.outbox;
  const timelineEvents = [];
  const appliedItemIds = [];
  for (const result of batch.pending) {
    const workingState = { ...state, items, outbox: outboxEntries };
    const {
      item,
      outbox,
      evidenceTarget,
      discardUnsealedLegacyResult,
      discardSettledIssueResult,
    } = requireBoundProposal(workingState, result);
    const timelineInputBinding = proposalTimelineInputBinding(
      workingState,
      item,
      outbox,
    );
    if (Date.parse(result.at) > Date.parse(now)) {
      throw invalid("工作提案结果时间晚于台账时钟");
    }
    if (discardSettledIssueResult) {
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "stale_result_discarded",
        at: now,
        actorId: "work-proposal-result-reconciler",
        details: {
          source: "proposal",
          intentId: outbox.intentId,
          resultRef: result.resultId,
          reason: item.statusReason,
        },
      });
      continue;
    }
    if (discardUnsealedLegacyResult) {
      const itemResult = moveWorkItem(item, {
        status: "blocked",
        now,
        reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
        activeIntentId: null,
      });
      items = replaceWorkLedgerRecord(items, "itemId", itemResult);
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "legacy_result_discarded",
        at: now,
        actorId: "work-proposal-result-reconciler",
        details: {
          source: "proposal",
          intentId: outbox.intentId,
          resultRef: result.resultId,
          reason: "unsealed_pr_source_quarantine",
        },
      });
      continue;
    }
    const succeeded = result.outcome === "succeeded";
    const decisionContext = createWorkDecisionContext({
      source: "proposal",
      referenceId: result.proposalId,
      outcome: result.outcome,
      value: {
        kind: result.kind,
        resultId: result.resultId,
        resultDigest: result.contentDigest,
        summary: result.summary,
        downstreamRef: result.downstreamRef,
        evidence: result.evidence,
      },
      observedAt: result.at,
    });
    const resultAttestation = createProposalResultAttestation({
      result,
      intentId: outbox.intentId,
      decisionContentDigest: decisionContext.contentDigest,
    });
    const outboxResult = {
      ...outbox,
      revision: outbox.revision + 1,
      outcome: {
        ...outbox.outcome,
        details: {
          ...outbox.outcome.details,
          resultAttestation,
        },
      },
      updatedAt: now,
    };
    outboxEntries = replaceWorkLedgerRecord(
      outboxEntries,
      "intentId",
      outboxResult,
    );
    const inspectionStatus = succeeded
      ? contractedPullRequestInspectionStatus(workingState, item, outbox, result)
      : null;
    const continueForEvidence = succeeded && (
      evidenceTarget !== null ||
      inspectionStatus === "queued" ||
      // Read-only repair evidence must return to the developer's next decision.
      continuesOwnPullRequestRepairEvidence(item, outbox, result)
    );
    let nextStatus = "blocked";
    if (succeeded) {
      nextStatus = continueForEvidence
        ? "queued"
        : inspectionStatus ?? "completed";
    }
    const sealedByLegacyCutover = isWorkItemInLegacyPullRequestCutover(item);
    let reason = `proposal_${result.outcome}`;
    if (sealedByLegacyCutover) {
      reason = LEGACY_PR_SOURCE_CUTOVER_REASON;
    } else if (continueForEvidence) {
      reason = "proposal_evidence_ready";
    } else if (inspectionStatus === "blocked") {
      reason = "proposal_source_stale";
    }
    const itemResult = moveWorkItem(item, {
      status: sealedByLegacyCutover ? "blocked" : nextStatus,
      now,
      reason,
      activeIntentId: null,
      decisionContext,
    });
    items = replaceWorkLedgerRecord(items, "itemId", itemResult);
    appliedItemIds.push(item.itemId);
    timelineEvents.push({
      itemId: item.itemId,
      type: "proposal_result_applied",
      at: now,
      actorId: "work-proposal-result-reconciler",
      details: {
        inputBinding: timelineInputBinding,
        workItemRevision: itemResult.revision,
        inputDigest: outbox.inputDigest,
        intentId: outbox.intentId,
        resultAttestationDigest: resultAttestation.attestationDigest,
        decision: decisionContext,
        proposalId: result.proposalId,
        resultRef: result.resultId,
        outcome: result.outcome,
        downstreamRef: result.downstreamRef,
        evidenceRefs: result.evidence,
      },
    });
  }
  return {
    patch: {
      items,
      outbox: outboxEntries,
      proposalCursor: batch.nextSequence,
      proposalHighWatermark: batch.highWatermark,
    },
    timelineEvents,
    result: {
      applied: batch.pending.length,
      deduplicated: batch.items.length - batch.pending.length,
      cursor: batch.nextSequence,
      highWatermark: batch.highWatermark,
      itemIds: appliedItemIds,
    },
  };
}
