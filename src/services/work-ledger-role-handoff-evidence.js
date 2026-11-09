import { createWorkIntentDispatchBinding } from '../domain/work-intent-dispatch-binding.js';
import { currentWorkItemEvent, currentWorkItemExecutionBinding, currentWorkItemInputBinding,
  pullRequestHeadAdmission } from './work-ledger-pr-source.js';
import { ledgerDigest } from './work-ledger-values.js';

function lastDeliveredHandoff(outboxes, itemId) {
  return outboxes.findLast(entry => entry.itemId === itemId && entry.intent.type === 'handoff' &&
    entry.status === 'delivered' && entry.outcome?.status === 'delivered');
}

// Evidence of one acknowledged responsibility transfer, not a model report of
// work completion. Its exact dispatch and adjacent host event must agree.
export function currentPrRoleHandoffProof(state, item, { fromRoleId, targetRoleId, capability, timeline = state.timeline }) {
  // This proof remains PR-only and cannot authorize generic remote work.
  if (currentWorkItemInputBinding(item) == null || currentWorkItemExecutionBinding(item)?.schemaVersion !== 2) return null;
  return currentRoleHandoffReportProof(state, item, { fromRoleId, targetRoleId, capability, timeline,
    outbox: lastDeliveredHandoff(state.outbox, item.itemId) });
}

// Display provenance only. A report does not confer execution authority or
// establish ownership; callers must establish graph responsibility separately.
export function currentCoordinationReturnReport(state, item, { outboxes, timeline, timelineBySequence }) {
  const outbox = lastDeliveredHandoff(outboxes, item.itemId);
  const fromRoleId = outbox?.requestedBy.roleId;
  if (!fromRoleId || fromRoleId === 'orchestrator') return null;
  const proof = currentRoleHandoffReportProof(state, item, {
    fromRoleId, targetRoleId: 'orchestrator', capability: 'coordination', outbox, timeline, timelineBySequence,
  });
  if (proof === null || proof.bound.payload.reason !== proof.outbox.intent.reason ||
      timeline.findLast(entry => entry.itemId === item.itemId && entry.type === 'handed_off') !== proof.handedOff) return null;
  return { brief: proof.bound.payload.brief, reason: proof.outbox.intent.reason,
    evidence: [...proof.bound.payload.evidence], evidenceAuthority: 'specialist_report' };
}

function currentRoleHandoffReportProof(state, item, { fromRoleId, targetRoleId, capability, outbox, timeline, timelineBySequence }) {
  if (item?.currentTarget?.type !== 'role' || item.currentTarget.id !== targetRoleId || item.sourceQuarantine != null) return null;
  const admission = pullRequestHeadAdmission(state, item);
  if (admission.applies && (!admission.current || admission.pending)) return null;
  const bound = outbox?.dispatchBinding?.boundIntent;
  const sourceBinding = currentWorkItemInputBinding(item), executionBinding = currentWorkItemExecutionBinding(item);
  const event = currentWorkItemEvent(item);
  if (!outbox || !bound ||
      outbox.inputDigest !== item.inputDigest || ledgerDigest(outbox.sourceBinding) !== ledgerDigest(sourceBinding) ||
      outbox.requestedBy.roleId !== fromRoleId || outbox.intent.capability !== capability ||
      bound.kind !== 'handoff' || bound.requestedBy.roleId !== fromRoleId || bound.requestedBy.workItemId !== item.itemId ||
      bound.binding.targetRoleId !== targetRoleId || bound.binding.eventId !== event.eventId ||
      ledgerDigest(bound.binding.subject) !== ledgerDigest(event.subject) ||
      bound.source.assignmentId !== item.assignmentId || bound.source.eventId !== event.eventId ||
      bound.payload.capability !== capability || bound.payload.brief !== outbox.intent.brief ||
      ledgerDigest(bound.payload.evidence) !== ledgerDigest(outbox.intent.evidence) ||
      ledgerDigest(createWorkIntentDispatchBinding(bound)) !== ledgerDigest(outbox.dispatchBinding) ||
      outbox.outcome.details?.downstreamRef !== bound.intentId) return null;
  const acknowledged = timeline.findLast(entry => entry.itemId === item.itemId && entry.type === 'intent_acknowledged' &&
    entry.details?.intentId === outbox.intentId && entry.details.outcome === 'delivered' && entry.details.nextStatus === 'queued');
  const handedOff = acknowledged && (timelineBySequence === undefined
    ? timeline.find(entry => entry.sequence === acknowledged.sequence + 1)
    : timelineBySequence.get(acknowledged.sequence + 1));
  if (handedOff?.type !== 'handed_off' || handedOff.itemId !== item.itemId || handedOff.at !== outbox.updatedAt ||
      handedOff.details?.fromTarget?.type !== 'role' || handedOff.details.fromTarget.id !== fromRoleId ||
      handedOff.details.toTarget?.type !== 'role' || handedOff.details.toTarget.id !== targetRoleId) return null;
  return { outbox, bound, executionBinding, acknowledged, handedOff };
}
