import { normalizeConfirmationState } from "../domain/confirmation-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { createCompletedReviewConfirmationSettlement, reviewConfirmationSettlementIds } from "./work-ledger-review-confirmation-settlement.js";
import { hasExactLedgerKeys } from "./work-ledger-values.js";

export function reviewDiagnosticState(state, child) {
  if (child?.kind !== "graph_task" || child.currentTarget?.id !== "pr-engineer" || child.status !== "blocked" ||
      child.statusReason !== "proposal_stale" || child.activeIntentId !== null || child.sourceQuarantine !== null ||
      child.ownerId !== null || child.leaseId !== null || child.leaseUntil !== null || child.graph.deliveries.length !== 0) return null;
  const boxes = state.outbox.filter(box => box.itemId === child.itemId);
  if (boxes.length !== 1) return null;
  const ids = reviewConfirmationSettlementIds(child, new Map(boxes.map(box => [box.intentId, box])));
  if (!ids.length) return null;
  try {
    const result = normalizeWorkResultAttestation(boxes[0].outcome.details.resultAttestation).payload;
    return { code: "REVIEW_PROPOSAL_STALE", stage: "review", taskRevision: child.revision,
      proposalId: result.proposalId, resultDigest: result.contentDigest, recordedAt: result.at, confirmationIds: ids };
  } catch { return null; }
}

export function normalizeRecoveredReviewFailure(value, taskRevision) {
  if (!hasExactLedgerKeys(value, ["code", "stage", "taskRevision", "proposalId", "resultDigest", "confirmationId",
    "confirmationDigest", "recordedAt", "diagnosticDigest"]) || value.code !== "REVIEW_AUTHORIZATION_CHANGED" || value.stage !== "review" ||
      !Number.isSafeInteger(taskRevision) || taskRevision < 1 || value.taskRevision !== taskRevision ||
      typeof value.proposalId !== "string" || !/^work-intent-[a-f0-9]{64}$/.test(value.proposalId) ||
      typeof value.confirmationId !== "string" || !/^confirmation-github-review-[a-f0-9]{64}$/.test(value.confirmationId) ||
      ![value.resultDigest, value.confirmationDigest, value.diagnosticDigest].every(text => typeof text === "string" && /^[a-f0-9]{64}$/.test(text)) ||
      typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt)) ||
      new Date(value.recordedAt).toISOString() !== value.recordedAt) return null;
  return { ...value };
}

export function recoveredReviewFailureMatches(state, child, failure) {
  const normalized = normalizeRecoveredReviewFailure(failure, child?.revision);
  if (!normalized) return false;
  const current = reviewDiagnosticState(state, child);
  return current !== null && current.proposalId === normalized.proposalId && current.resultDigest === normalized.resultDigest &&
    current.recordedAt === normalized.recordedAt && current.confirmationIds.includes(normalized.confirmationId);
}

// Supply a new host diagnostic to the parent, preserving the child's original
// result and contract. This is neither publication nor acceptance evidence.
export function recoverReviewDiagnostic(state, candidate, control, now) {
  const { item, child, failure, inputBinding } = candidate;
  const boxes = new Map(state.outbox.filter(box => box.itemId === child.itemId).map(box => [box.intentId, box]));
  if (!createCompletedReviewConfirmationSettlement(child, boxes, control?.confirmations)) return null;
  const present = control.confirmations.filter(value => value !== null);
  if (present.length !== 1) return null;
  let confirmation;
  try { confirmation = normalizeConfirmationState({ schemaVersion: 1, revision: present[0].queueRevision, items: [present[0].item] }).items[0]; }
  catch { return null; }
  if (confirmation.status !== "stale" || confirmation.execution !== null || confirmation.failure !== null ||
      confirmation.invalidation?.reason !== "authorization_changed" || !failure.confirmationIds.includes(confirmation.id)) return null;
  const decisionContext = createWorkDecisionContext({ source: "proposal", outcome: "stale", referenceId: failure.proposalId, observedAt: now,
    value: { kind: "host_review_diagnostic", childTaskId: child.itemId, childTaskRevision: child.revision,
      code: "REVIEW_AUTHORIZATION_CHANGED", confirmationId: confirmation.id, confirmationStatus: confirmation.status,
      invalidationReason: confirmation.invalidation.reason, publicationExecuted: false, contractSatisfied: false,
      headRefOid: inputBinding.headRefOid, baseRefOid: inputBinding.gitTarget.baseRefOid,
      rootTaskId: item.itemId } });
  return { decisionContext, failure: { code: "REVIEW_AUTHORIZATION_CHANGED", stage: "review", taskRevision: child.revision,
    proposalId: failure.proposalId, resultDigest: failure.resultDigest, confirmationId: confirmation.id,
    confirmationDigest: canonicalJsonDigest(confirmation), recordedAt: failure.recordedAt, diagnosticDigest: decisionContext.contentDigest } };
}
