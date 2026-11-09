import {
  normalizeConfirmationPlan,
  normalizeConfirmationState,
} from "../domain/confirmation-contract.js";
import { createCodeActionProposalConfirmationPlan, codeJobConfirmationIdForProposal } from "../domain/code-action-proposal-confirmation.js";
import { createWorkIntentDispatchBinding } from "../domain/work-intent-dispatch-binding.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import { currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { currentWorkItemInputBinding, matchesHistoricalPullRequestInputBinding } from "./work-ledger-pr-source.js";
import { ledgerDigest } from "./work-ledger-values.js";
import { normalizeCodeJobConfirmationResult } from "./code-job-confirmation-result.js";
import { hasSettledCodeJobAuthorityFence, hasStoppedCodeJobAuthorityFence } from "./obsolete-code-job-settler.js";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";

// Only server-side confirmation reads can mint these ephemeral capabilities.
// A public reconciliation command cannot supply a JSON flag as settlement proof.
const settlements = new WeakMap();

export function codeConfirmationSettlementId(decision) {
  const value = decision?.value;
  // These references locate the historical proof readers; the result remains
  // unknown until exact job/memory and stopped-execution proof are checked.
  if (decision?.source === "proposal" && decision.outcome === "unknown" &&
      typeof decision.referenceId === "string" && value?.kind === "code_action_proposal" &&
      typeof value.downstreamRef === "string" && value.downstreamRef.startsWith("confirmation-code-job-") &&
      Array.isArray(value.evidence) && value.evidence.length === 4 &&
      value.evidence[0] === `confirmation:${value.downstreamRef}` &&
      typeof value.evidence[1] === "string" && value.evidence[1].startsWith("code-job:") &&
      value.evidence[2] === "code-job-status:fenced" &&
      typeof value.evidence[3] === "string" && value.evidence[3].startsWith("memory:memory-")) return value.downstreamRef;
  if (decision?.source !== "proposal" || decision.outcome !== "stale" ||
      typeof decision.referenceId !== "string" || value?.kind !== "code_action_proposal" ||
      !Array.isArray(value.evidence) || value.evidence.length !== 3 ||
      value.evidence[1] !== "authorization_changed" ||
      !["old_confirmation_status:stale", "old_confirmation_status:completed", "old_confirmation_status:executing", "old_confirmation_status:failed"].includes(value.evidence[2])) return null;
  // Older terminal handler results retained the confirmation only in evidence.
  // This locates its sealed record; it does not itself prove settlement.
  const reference = value.downstreamRef === null && typeof value.evidence[0] === "string"
    ? value.evidence[0].slice("confirmation:".length) : value.downstreamRef;
  return typeof reference === "string" && reference.startsWith("confirmation-code-job-") &&
    value.evidence[0] === `confirmation:${reference}` ? reference : null;
}

export function isChangedCodeConfirmationDecision(decision) {
  return codeConfirmationSettlementId(decision) !== null;
}

export function isRevokedCodeConfirmationDecision(decision) {
  return isChangedCodeConfirmationDecision(decision) &&
    decision.value.evidence[2] === "old_confirmation_status:stale";
}

function digest(value) {
  return ledgerDigest(value, { maximumEntries: 30_000 });
}

function matchingDeliveredProposal(item, outboxById) {
  const candidates = [...outboxById.values()].filter((outbox) =>
    outbox.itemId === item.itemId && outbox.status === "delivered" &&
    outbox.intent?.type === "propose_code_action" &&
    outbox.outcome?.status === "delivered" &&
    outbox.outcome.details?.downstreamRef === item.decisionContext.referenceId);
  if (candidates.length !== 1) return null;
  const outbox = candidates[0];
  const currentBinding = outbox.inputDigest === item.inputDigest &&
    digest(outbox.sourceBinding) === digest(currentWorkItemInputBinding(item));
  const historicalBinding = item.kind === "source_root" && item.source?.pendingRevision != null &&
    outbox.inputDigest === outbox.sourceBinding?.inputDigest &&
    matchesHistoricalPullRequestInputBinding(item, outbox.sourceBinding);
  if (!currentBinding && !historicalBinding) return null;
  const bound = outbox.dispatchBinding?.boundIntent;
  if (!bound || bound.intentId !== item.decisionContext.referenceId) return null;
  const { intentId, ...content } = bound;
  const proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...content });
  if (proposal.kind !== "code_action_proposal" ||
    proposal.requestedBy.workItemId !== item.itemId ||
    proposal.requestedBy.roleId !== item.currentTarget?.id ||
    proposal.requestedBy.roleId !== outbox.requestedBy?.roleId ||
    proposal.contentDigest !== outbox.outcome.details.proposalDigest ||
    outbox.outcome.details.resultAttestation?.decisionContentDigest !==
      item.decisionContext.contentDigest) return null;
  return { proposal, outbox };
}

function createSettlement(item, outbox) {
  const proof = Object.freeze({});
  settlements.set(proof, {
    itemId: item.itemId, itemRevision: item.revision, inputDigest: item.inputDigest,
    decisionDigest: item.decisionContext.contentDigest,
    intentId: outbox.intentId, outboxDigest: digest(outbox),
  });
  return proof;
}

export function unstartedConflictProposalForRecovery(item, outboxById) {
  try {
    const decision = item?.decisionContext, value = decision?.value;
    if (item?.status !== "blocked" || item.activeIntentId !== null || item.sourceQuarantine != null ||
        decision?.source !== "proposal" || decision.outcome !== "stale" || value?.kind !== "code_action_proposal" ||
        value.downstreamRef !== null || digest(value.evidence) !== digest(["authorization_changed", `proposal:${decision.referenceId}`])) return null;
    const delivered = matchingDeliveredProposal(item, outboxById);
    if (delivered === null) return null;
    const { proposal, outbox } = delivered;
    if (outbox.updatedAt !== item.updatedAt || proposal.payload.operation !== "modify" ||
        proposal.source.assignmentId !== item.assignmentId || proposal.source.eventId !== proposal.binding.inputBinding.eventId ||
        proposal.binding.executionSource?.kind !== "conflict_preparation" ||
        !samePullRequestExecutionBinding(proposal.binding.inputBinding, currentWorkItemExecutionBinding(item)) ||
        digest(createWorkIntentDispatchBinding(outbox.dispatchBinding.boundIntent)) !== digest(outbox.dispatchBinding)) return null;
    const attestation = normalizeWorkResultAttestation(outbox.outcome.details.resultAttestation);
    const result = attestation.payload;
    if (attestation.kind !== "proposal_result" || attestation.intentId !== outbox.intentId ||
        result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
        result.kind !== proposal.kind || digest(result.requestedBy) !== digest(proposal.requestedBy)) return null;
    const expected = createWorkDecisionContext({ source: "proposal", referenceId: result.proposalId, outcome: result.outcome,
      value: { kind: result.kind, resultId: result.resultId, resultDigest: result.contentDigest, summary: result.summary,
        downstreamRef: result.downstreamRef, evidence: result.evidence }, observedAt: result.at });
    return digest(expected) === digest(decision) ? { ...delivered, confirmationId: codeJobConfirmationIdForProposal(proposal) } : null;
  } catch { return null; }
}

function matchingHistoricalConfirmation(item, outboxById, confirmation) {
  const delivered = matchingDeliveredProposal(item, outboxById);
  if (delivered === null) return null;
  const { proposal, outbox } = delivered;
  const expected = normalizeConfirmationPlan(createCodeActionProposalConfirmationPlan(proposal, {
    grant: confirmation.action.grant,
    // Rebuilding a historical binding does not grant new execution authority.
    allowedOperationsByRole: { [proposal.requestedBy.roleId]: [proposal.payload.operation] },
  }));
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, confirmation[key]]));
  return digest(expected) === digest(actual) ? { grant: expected.action.grant, outbox } : null;
}

export function failedCodeConfirmationRecoveryId(decision) {
  const value = decision?.value, reference = value?.downstreamRef, evidence = value?.evidence;
  return decision?.source === "proposal" && decision.outcome === "failed" && value?.kind === "code_action_proposal" &&
    typeof reference === "string" && reference.startsWith("confirmation-code-job-") &&
    Array.isArray(evidence) && evidence.length === 4 && evidence[0] === `confirmation:${reference}` &&
    typeof evidence[1] === "string" && evidence[1].startsWith("code-job:") && evidence[2] === "code-job-status:failed" &&
    typeof evidence[3] === "string" && evidence[3].startsWith("memory:") ? reference : null;
}

// Normal failed results have their own proof path. They must not become stale
// confirmation settlements or confer authority to resume the failed job.
export function failedCodeConfirmationForRecovery(item, outboxById, snapshot) {
  const confirmationId = failedCodeConfirmationRecoveryId(item?.decisionContext);
  if (item?.status !== "blocked" || item.statusReason !== "proposal_failed" || item.activeIntentId !== null ||
      item.sourceQuarantine != null || confirmationId === null || snapshot == null ||
      [...outboxById.values()].some(outbox => outbox.itemId === item.itemId &&
        ["pending", "dispatching", "unknown"].includes(outbox.status))) return null;
  try {
    const confirmation = normalizeConfirmationState({
      schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item],
    }).items[0];
    if (confirmation.id !== confirmationId || confirmation.kind !== "local.code-job-create" ||
        confirmation.status !== "completed") return null;
    const historical = matchingHistoricalConfirmation(item, outboxById, confirmation);
    if (historical === null || confirmation.receipt.id !== codeJobIdForGrant(historical.grant) ||
        historical.outbox.updatedAt !== item.updatedAt || historical.grant.source.assignmentId !== item.assignmentId ||
        digest(createWorkIntentDispatchBinding(historical.outbox.dispatchBinding.boundIntent)) !== digest(historical.outbox.dispatchBinding) ||
        !samePullRequestExecutionBinding(historical.grant.inputBinding, currentWorkItemExecutionBinding(item)) ||
        item.decisionContext.value.evidence[1] !== `code-job:${confirmation.receipt.id}`) return null;
    const attestation = normalizeWorkResultAttestation(historical.outbox.outcome.details.resultAttestation);
    const result = attestation.payload;
    if (attestation.kind !== "proposal_result" || attestation.intentId !== historical.outbox.intentId ||
        result.outcome !== "failed" || result.proposalId !== item.decisionContext.referenceId ||
        result.proposalContentDigest !== historical.grant.contentDigest || result.kind !== "code_action_proposal" ||
        digest(result.requestedBy) !== digest(historical.grant.requestedBy)) return null;
    const expected = createWorkDecisionContext({ source: "proposal", referenceId: result.proposalId, outcome: result.outcome,
      value: { kind: result.kind, resultId: result.resultId, resultDigest: result.contentDigest, summary: result.summary,
        downstreamRef: result.downstreamRef, evidence: result.evidence }, observedAt: result.at });
    return digest(expected) === digest(item.decisionContext) ? { ...historical, receipt: confirmation.receipt } : null;
  } catch { return null; }
}

export function completedCodeConfirmationForSettlement(item, outboxById, snapshot) {
  if (item?.status !== "blocked" || item.activeIntentId !== null || item.sourceQuarantine != null ||
    !isChangedCodeConfirmationDecision(item.decisionContext) ||
    snapshot == null) return null;
  try {
    const confirmation = normalizeConfirmationState({
      schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item],
    }).items[0];
    if (confirmation.id !== codeConfirmationSettlementId(item.decisionContext) ||
      confirmation.kind !== "local.code-job-create" || confirmation.status !== "completed") return null;
    const historical = matchingHistoricalConfirmation(item, outboxById, confirmation);
    if (historical === null || confirmation.receipt.id !== codeJobIdForGrant(historical.grant)) return null;
    return { ...historical, receipt: confirmation.receipt };
  } catch {
    return null;
  }
}

export function createCompletedCodeConfirmationSettlement(item, outboxById, snapshot, value) {
  const completed = completedCodeConfirmationForSettlement(item, outboxById, snapshot);
  if (completed === null || value == null) return null;
  try {
    const job = normalizeCodeJobConfirmationResult(value, completed.grant, completed.receipt);
    if (item.decisionContext.outcome === "unknown" &&
        (job.status !== "fenced" || !hasStoppedCodeJobAuthorityFence(value) || job.memoryProjection === null ||
          item.decisionContext.value.evidence[1] !== `code-job:${job.jobId}` ||
          item.decisionContext.value.evidence[3] !== `memory:${job.memoryProjection.recordId}`)) return null;
    if ((!["completed", "failed", "cancelled"].includes(job.status) && !hasSettledCodeJobAuthorityFence(value)) ||
      job.terminalResult?.kind !== job.status || job.pendingActionType !== null || job.uncertainty !== null) return null;
    return createSettlement(item, completed.outbox);
  } catch {
    return null;
  }
}

export function createRevokedCodeConfirmationSettlement(item, outboxById, snapshot) {
  if (item?.status !== "blocked" || item.activeIntentId !== null ||
    item.sourceQuarantine != null ||
    !isRevokedCodeConfirmationDecision(item.decisionContext) || snapshot == null) return null;
  try {
    const confirmation = normalizeConfirmationState({
      schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item],
    }).items[0];
    if (confirmation.id !== codeConfirmationSettlementId(item.decisionContext) ||
      confirmation.kind !== "local.code-job-create" || confirmation.status !== "stale" ||
      confirmation.execution !== null || confirmation.receipt !== null ||
      confirmation.failure !== null || confirmation.rejection !== null ||
      confirmation.invalidation?.reason !== "authorization_changed" ||
      digest(confirmation.invalidation.requestedBy) !== digest(confirmation.requestedBy) ||
      confirmation.invalidation.approvalBindingDigest !== confirmation.approvalBindingDigest) return null;
    const historical = matchingHistoricalConfirmation(item, outboxById, confirmation);
    return historical === null ? null : createSettlement(item, historical.outbox);
  } catch {
    // Missing, malformed, mismatched or executed confirmations never release work.
    return null;
  }
}

export function unstartedCodeConfirmationForSettlement(item, outboxById, snapshot) {
  if (item?.status !== "blocked" || item.activeIntentId !== null || item.sourceQuarantine != null ||
      item.decisionContext?.outcome !== "stale" || !isChangedCodeConfirmationDecision(item.decisionContext) || snapshot == null) return null;
  try {
    const confirmation = normalizeConfirmationState({ schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item] }).items[0];
    if (confirmation.id !== codeConfirmationSettlementId(item.decisionContext) || confirmation.kind !== "local.code-job-create" ||
        confirmation.status !== "stale" || confirmation.execution === null || confirmation.receipt !== null ||
        confirmation.failure !== null || confirmation.rejection !== null || confirmation.invalidation !== null) return null;
    const historical = matchingHistoricalConfirmation(item, outboxById, confirmation);
    return historical === null ? null : { ...historical, receipt: { id: codeJobIdForGrant(historical.grant), createdAt: null } };
  } catch { return null; }
}

export function createUnstartedCodeConfirmationSettlement(item, outboxById, snapshot, job) {
  const unstarted = unstartedCodeConfirmationForSettlement(item, outboxById, snapshot);
  // Undefined means that the trusted reader is unavailable, not an absent job.
  return unstarted !== null && job === null ? createSettlement(item, unstarted.outbox) : null;
}

export function hasCodeConfirmationSettlement(item, outboxById, proof) {
  const stored = proof && settlements.get(proof);
  const outbox = stored && outboxById.get(stored.intentId);
  return Boolean(stored && stored.itemId === item.itemId &&
    stored.itemRevision === item.revision && stored.inputDigest === item.inputDigest &&
    stored.decisionDigest === item.decisionContext?.contentDigest &&
    outbox !== undefined && digest(outbox) === stored.outboxDigest);
}
