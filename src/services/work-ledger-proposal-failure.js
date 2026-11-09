import { isDeepStrictEqual } from 'node:util';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { currentWorkItemExecutionBinding, currentWorkItemInputBinding } from './work-ledger-pr-source.js';
import { normalizeWorkResultAttestation } from './work-ledger-result-attestation.js';
import { hasExactLedgerKeys } from './work-ledger-values.js';

export function normalizeRecordedProposalFailure(value, taskRevision) {
  if (!hasExactLedgerKeys(value, ['code', 'stage', 'taskRevision', 'timelineId', 'timelineDigest', 'recordedAt']) ||
      value.code !== 'CODE_ACTION_PROPOSAL_FAILED' || value.stage !== 'proposal' ||
      !Number.isSafeInteger(taskRevision) || taskRevision < 1 || value.taskRevision !== taskRevision ||
      typeof value.timelineDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.timelineDigest) ||
      value.timelineId !== `work-timeline-${value.timelineDigest}` || typeof value.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) return null;
  return { code: value.code, stage: 'proposal', taskRevision, timelineId: value.timelineId,
    timelineDigest: value.timelineDigest, recordedAt: value.recordedAt };
}

// A settled failure wakes coordination. It says nothing about partial changes,
// process cleanup or retry authority; the failed child and its history stay intact.
export function indexRecordedProposalFailures(state) {
  const candidates = new Map(state.items.filter(item => item.kind === 'graph_task' && item.status === 'blocked' &&
    item.statusReason === 'proposal_failed' && item.activeIntentId === null && item.ownerId === null &&
    item.leaseId === null && item.leaseUntil === null && item.sourceQuarantine === null &&
    item.decisionContext?.source === 'proposal' && item.decisionContext.outcome === 'failed' &&
    item.decisionContext.value?.kind === 'code_action_proposal').map(item => [item.itemId, item]));
  if (candidates.size === 0) return new Map();
  const boxes = new Map(), latest = new Map();
  for (const box of state.outbox) if (candidates.has(box.itemId)) {
    const entries = boxes.get(box.itemId) ?? []; entries.push(box); boxes.set(box.itemId, entries);
  }
  for (let i = state.timeline.length - 1; i >= 0 && latest.size < candidates.size; i--) {
    const entry = state.timeline[i];
    if (candidates.has(entry.itemId) && !latest.has(entry.itemId)) latest.set(entry.itemId, entry);
  }
  const failures = new Map();
  for (const [id, item] of candidates) {
    const entry = latest.get(id), decision = item.decisionContext, entries = boxes.get(id) ?? [];
    if (entry?.type !== 'proposal_result_applied' || entry.at !== item.updatedAt || entry.details?.outcome !== 'failed' ||
        entry.details.workItemRevision !== item.revision || entry.details.decision?.contentDigest !== decision.contentDigest ||
        entries.some(box => ['pending', 'dispatching', 'unknown'].includes(box.status))) continue;
    const matches = entries.filter(box => box.status === 'delivered' && box.intent.type === 'propose_code_action' &&
      box.outcome?.status === 'delivered' && box.outcome.details?.downstreamRef === decision.referenceId &&
      box.intentId === entry.details.intentId && isDeepStrictEqual(box.sourceBinding, currentWorkItemInputBinding(item)));
    if (matches.length !== 1) continue;
    try {
      const box = matches[0], attestation = normalizeWorkResultAttestation(box.outcome.details.resultAttestation);
      const result = attestation.payload;
      if (attestation.kind !== 'proposal_result' || attestation.intentId !== box.intentId ||
          attestation.decisionContentDigest !== decision.contentDigest || attestation.attestationDigest !== entry.details.resultAttestationDigest ||
          result.kind !== 'code_action_proposal' || result.outcome !== 'failed' || result.proposalId !== decision.referenceId ||
          result.resultId !== decision.value.resultId || result.contentDigest !== decision.value.resultDigest ||
          result.proposalContentDigest !== box.outcome.details.proposalDigest ||
          !samePullRequestExecutionBinding(currentWorkItemExecutionBinding(item), box.dispatchBinding?.boundIntent?.binding?.inputBinding)) continue;
      const diagnostic = normalizeRecordedProposalFailure({ code: 'CODE_ACTION_PROPOSAL_FAILED', stage: 'proposal',
        taskRevision: item.revision, timelineId: entry.timelineId, timelineDigest: entry.contentDigest, recordedAt: entry.at }, item.revision);
      if (diagnostic) failures.set(id, diagnostic);
    } catch { /* Unsealed or obsolete evidence never makes coordination ready. */ }
  }
  return failures;
}
