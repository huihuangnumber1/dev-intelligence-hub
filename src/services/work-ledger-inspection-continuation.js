import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding, currentWorkItemInputBinding, pullRequestHeadAdmission,
  pullRequestTrustedPredecessor, pendingInternalReviewMatchesDiscovery } from "./work-ledger-pr-source.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { ledgerDigest } from "./work-ledger-values.js";
import { normalizeInternalReviewMetadata } from '../domain/internal-repair-review.js';
import { currentPrRoleHandoffProof } from './work-ledger-role-handoff-evidence.js';

const SOURCE_FIELDS = ["kind", "rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"];

function isOwnPullRequestRepairEvidenceItem(item) {
  if (item.source?.kind !== 'pull_request' || item.source.scope.active !== true || item.source.pendingRevision !== null) return false;
  const event = currentWorkItemEvent(item);
  if (item.source.scope.kind === 'internal_review' && item.source.identity.provider === 'internal-review-repair' &&
      item.source.identity.targetRoleId === 'pr-engineer' && event.source.provider === 'internal-review-repair' &&
      event.eventType === 'pull_request.internal_review_requested') {
    try { return normalizeInternalReviewMetadata(event.payload.internalReview).headRefOid === item.source.current.headRefOid; }
    catch { return false; }
  }
  if (item.source.scope.kind !== 'automatic' || item.source.identity.targetRoleId !== 'developer') return false;
  return event.source.provider === 'github' && event.payload.relation === 'authored' &&
    (event.payload.isDraft !== true || ['resolve_conflict', 'fix_ci'].includes(event.payload.nextAction)) &&
    event.payload.actionState === 'action_now' && ['address_review', 'resolve_conflict', 'fix_ci'].includes(event.payload.nextAction);
}

export function continuesOwnPullRequestRepairEvidence(item, outbox, result) {
  const bound = outbox.dispatchBinding?.boundIntent;
  const event = currentWorkItemEvent(item);
  const operation = outbox.intent.operation;
  if (result.kind !== "code_action_proposal" || result.requestedBy.roleId !== "developer" ||
      !["inspect", "verify"].includes(operation) || bound?.payload?.operation !== operation ||
      !isOwnPullRequestRepairEvidenceItem(item)) return false;
  if (operation === "verify" && item.source.scope.kind !== 'internal_review' && event.payload.nextAction !== "fix_ci") return false;
  try {
    const current = currentWorkItemExecutionBinding(item);
    return SOURCE_FIELDS.every(key => current?.[key] === outbox.sourceBinding?.[key]) &&
      samePullRequestExecutionBinding(current, bound.binding.inputBinding);
  } catch { return false; }
}

function hasCurrentRepairEvidenceAuthority(state, item) {
  const admission = pullRequestHeadAdmission(state, item);
  if (admission.current && !admission.pending) return true;
  if (item.source.scope.kind !== 'internal_review' || item.status !== 'completed' ||
      item.statusReason !== 'proposal_succeeded' || admission.pending) return false;
  const authority = pullRequestTrustedPredecessor(state, item);
  if (!authority || authority.authorityFenced) return false;
  const candidate = state.items.find(entry => entry.itemId === authority.canonicalRootItemId);
  if (candidate?.source?.scope.kind !== 'automatic' || candidate.source.scope.active !== true ||
      candidate.currentTarget?.id !== 'developer' || candidate.source.pendingRevision !== null ||
      candidate.sourceQuarantine !== null || candidate.ownerId !== null || candidate.leaseId !== null ||
      candidate.leaseUntil !== null || candidate.activeIntentId !== null || candidate.decisionContext !== null ||
      !(['queued', 'retry_wait'].includes(candidate.status) ||
        (candidate.status === 'blocked' && candidate.statusReason === 'pr_source_authority_fenced'))) return false;
  const restored = { ...item, status: 'queued', statusReason: 'pr_internal_review_evidence_continued' };
  if (!pendingInternalReviewMatchesDiscovery(restored, currentWorkItemEvent(candidate))) return false;
  const participants = new Set(state.items.filter(entry => currentWorkItemInputBinding(entry)?.rootItemId === candidate.itemId)
    .map(entry => entry.itemId));
  if (state.items.some(entry => participants.has(entry.itemId) && entry.itemId !== candidate.itemId &&
      !['completed', 'cancelled', 'superseded'].includes(entry.status)) ||
      state.outbox.some(box => participants.has(box.itemId) && ['pending', 'dispatching', 'unknown'].includes(box.status))) return false;
  // Completion wrongly released this internal duty to idle same-Head discovery.
  // Trial the existing authority rule without changing the competing root.
  const trial = { ...state, items: state.items.map(entry => entry.itemId === item.itemId ? restored : entry) };
  const recovered = pullRequestHeadAdmission(trial, restored);
  return recovered.current && !recovered.pending;
}

function settledRepairEvidence(state, item) {
  if (item.kind !== "source_root" || !isOwnPullRequestRepairEvidenceItem(item) ||
      item.activeIntentId !== null || item.sourceQuarantine !== null ||
      item.graph?.deliveries?.length > 0 ||
      (item.source.scope.kind !== 'internal_review' && !["resolve_conflict", "fix_ci"].includes(currentWorkItemEvent(item)?.payload?.nextAction)) ||
      item.decisionContext?.source !== "proposal" || item.decisionContext.outcome !== "succeeded") return null;
  if (!hasCurrentRepairEvidenceAuthority(state, item)) return null;
  const entries = state.outbox.filter(entry => entry.itemId === item.itemId && entry.status === "delivered" &&
    entry.intent.type === "propose_code_action" && entry.outcome?.status === "delivered" &&
    entry.outcome.details?.downstreamRef === item.decisionContext.referenceId);
  if (entries.length !== 1) return null;
  const outbox = entries[0];
  try {
    const attestation = normalizeWorkResultAttestation(outbox.outcome.details.resultAttestation);
    const result = attestation.payload;
    if (attestation.kind !== "proposal_result" || attestation.intentId !== outbox.intentId ||
        attestation.decisionContentDigest !== item.decisionContext.contentDigest || result.outcome !== "succeeded" ||
        result.proposalId !== item.decisionContext.referenceId || result.resultId !== item.decisionContext.value.resultId ||
        result.contentDigest !== item.decisionContext.value.resultDigest ||
        result.proposalContentDigest !== outbox.outcome.details.proposalDigest ||
        !continuesOwnPullRequestRepairEvidence(item, outbox, result)) return null;
    let reason;
    if (item.source.scope.kind === 'internal_review') reason = 'pr_internal_review_evidence_continued';
    else if (currentWorkItemEvent(item).payload.nextAction === 'fix_ci') {
      reason = outbox.intent.operation === 'verify' ? 'pr_ci_verification_continued' : 'pr_ci_inspection_continued';
    } else reason = 'pr_conflict_inspection_continued';
    return { outbox, attestation, result, reason };
  } catch { return null; }
}

export function completedRepairEvidenceRecoveryProof(state, item) {
  if (item.status !== 'completed' || item.statusReason !== 'proposal_succeeded' ||
      item.ownerId !== null || item.leaseId !== null) return null;
  const proof = settledRepairEvidence(state, item);
  return proof === null ? null : { intentId: proof.outbox.intentId, resultId: proof.result.resultId, reason: proof.reason };
}

// Successful intermediate work starts the next decision step. Lifetime claims
// and the persisted Head epoch stay intact; repeated failures without new sealed
// progress still consume the same bounded retry budget.
export function repairDecisionAttemptBudget(state, item) {
  if (!['developer', 'pr-engineer'].includes(item.currentTarget?.id) || !isOwnPullRequestRepairEvidenceItem(item) ||
      !['queued', 'working', 'retry_wait', 'blocked'].includes(item.status) ||
      (item.status !== 'working' && (item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null)) ||
      (item.status === 'blocked' && item.statusReason !== 'decision_attempts_exhausted')) return null;
  const history = state.timeline.filter(entry => entry.itemId === item.itemId);
  const evidence = item.currentTarget.id === 'developer' ? settledRepairEvidence(state, item) : null;
  const evidenceIndex = evidence === null ? -1 : history.findLastIndex(entry => entry.type === 'proposal_result_applied' &&
    entry.details?.intentId === evidence.outbox.intentId && entry.details.outcome === 'succeeded' &&
    entry.details.decision?.contentDigest === item.decisionContext.contentDigest &&
    entry.details.resultAttestationDigest === evidence.attestation.attestationDigest);
  let progress = evidenceIndex < 0 ? null : { outbox: evidence.outbox, index: evidenceIndex, reference: evidence.result.resultId };
  const handoff = currentPrRoleHandoffProof(state, item, item.currentTarget.id === 'pr-engineer'
    ? { fromRoleId: 'developer', targetRoleId: 'pr-engineer', capability: 'pr-review', timeline: history }
    : { fromRoleId: 'pr-engineer', targetRoleId: 'developer', capability: 'development', timeline: history });
  if (handoff) {
    const index = history.findIndex(entry => entry.timelineId === handoff.handedOff.timelineId);
    if (index >= 0 && (progress === null || index > progress.index)) {
      progress = { outbox: handoff.outbox, index, reference: `handoff:${handoff.bound.intentId}` };
    }
  }
  if (progress === null) return null;
  const stagedIndex = history.findLastIndex((entry, index) => index < progress.index && entry.type === 'intent_staged' &&
    entry.details?.intentId === progress.outbox.intentId);
  const progressClaim = history.findLast((entry, index) => index < stagedIndex && entry.type === 'claimed');
  const offset = progressClaim?.details?.attempt;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > item.attempt ||
      progressClaim.actorId !== progress.outbox.requestedBy.workerId ||
      progressClaim.details.inputDigest !== progress.outbox.inputDigest) return null;
  const claim = history.findLast(entry => entry.type === 'claimed');
  if (!claim || claim.details?.attempt !== item.attempt || claim.details.inputDigest !== item.inputDigest) return null;
  const failedIndex = history.findLastIndex((entry, index) => index > progress.index &&
    ['transitioned', 'retry_scheduled'].includes(entry.type) &&
    typeof entry.details?.context?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(entry.details.context.code));
  const failed = history[failedIndex], failedClaim = history[failedIndex - 1];
  const failure = failed && failedClaim?.type === 'claimed' && failedClaim.actorId === failed.actorId &&
    failedClaim.details?.inputDigest === item.inputDigest
    ? { code: failed.details.context.code, timelineId: failed.timelineId, at: failed.at,
      leaseId: failedClaim.details.leaseId, claimAt: failedClaim.at,
      current: failedIndex === history.length - 1 && failed.at === item.updatedAt &&
        failed.details.fromStatus === 'working' && failed.details.toStatus === 'blocked' &&
        failed.details.reason === 'decision_attempts_exhausted' }
    : null;
  return { attempt: item.attempt - offset, offset, intentId: progress.outbox.intentId, progressRef: progress.reference,
    claimLeaseId: claim.details.leaseId, failure };
}

export function isRecoveredRepairEvidence(previousState, previous, next) {
  if (!next || next.status !== "queued" || next.revision !== previous.revision + 1) return false;
  const proof = completedRepairEvidenceRecoveryProof(previousState, previous);
  if (!proof || next.statusReason !== proof.reason) return false;
  return ledgerDigest({ ...next, status: previous.status, statusReason: previous.statusReason,
    revision: previous.revision, updatedAt: previous.updatedAt }) === ledgerDigest(previous);
}
