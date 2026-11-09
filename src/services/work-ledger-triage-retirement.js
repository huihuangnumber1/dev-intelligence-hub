import { isDeepStrictEqual } from 'node:util';
import { createPrTriageWorkRequest, ownerWorkRequestDigest } from '../domain/owner-work-request.js';
import { automaticReviewEligibility, isAutomaticReviewExecution } from '../domain/automatic-review-policy.js';
import { normalizeConfirmationState } from '../domain/confirmation-contract.js';
import { canonicalJsonDigest } from '../lib/canonical-json-digest.js';
import { normalizePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { ledgerDigest, hasExactLedgerKeys } from './work-ledger-values.js';
import { currentWorkItemExecutionBinding, currentWorkItemInputBinding, verifyPullRequestExecutionBinding } from './work-ledger-pr-source.js';
import { reviewDiagnosticState, recoverReviewDiagnostic } from './work-ledger-review-diagnostic.js';
import { planWorkGraphCancellation } from './work-ledger-graph-commands.js';

const REASON = 'automatic_triage_review_already_published';
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function automaticTriageRetirement(outbox) {
  const proof = outbox?.outcome?.details?.automaticTriageRetirement;
  if (!hasExactLedgerKeys(proof, ['schemaVersion', 'intentId', 'questionRef', 'workItemRevision', 'reason', 'inputBinding', 'sourceDigest', 'digest']) ||
      proof.schemaVersion !== 1 || proof.intentId !== outbox.intentId || proof.questionRef !== outbox.outcome.details.questionRef ||
      outbox.status !== 'delivered' || outbox.outcome.status !== 'delivered' || !/^attention-[a-f0-9]{64}$/.test(proof.questionRef) ||
      proof.reason !== REASON || !Number.isSafeInteger(proof.workItemRevision) || proof.workItemRevision < 1 ||
      typeof proof.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sourceDigest) || outbox.sourceBinding === null) return null;
  try {
    const { digest, ...core } = proof;
    if (ledgerDigest(core) !== digest) return null;
    const binding = normalizePullRequestExecutionBinding(proof.inputBinding);
    const pointer = Object.fromEntries(Object.keys(outbox.sourceBinding).map(key => [key, binding[key]]));
    if (!isDeepStrictEqual(pointer, outbox.sourceBinding)) return null;
    return proof;
  } catch { return null; }
}

export function triageRetirementCandidate(state, root) {
  if (root?.kind !== 'source_root' || root.currentTarget?.id !== 'orchestrator' || root.status !== 'waiting_user' ||
      root.source?.scope?.kind !== 'owner_requested' || root.source.scope.active !== true || root.source.pendingRevision !== null ||
      root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null || root.sourceQuarantine !== null) return null;
  const inputBinding = currentWorkItemExecutionBinding(root);
  if (inputBinding?.schemaVersion !== 2) return null;
  try { verifyPullRequestExecutionBinding(state, inputBinding); } catch { return null; }
  const children = state.items.filter(item => item.graph?.parentItemId === root.itemId);
  if (children.length !== 1 || state.items.some(item => item.graph?.parentItemId === children[0].itemId)) return null;
  const child = children[0], failure = reviewDiagnosticState(state, child);
  if (!failure || !isDeepStrictEqual(inputBinding, currentWorkItemExecutionBinding(child))) return null;
  const rootBoxes = state.outbox.filter(box => box.itemId === root.itemId);
  if (rootBoxes.some(box => box.status !== 'delivered' || box.intent?.type !== 'ask_user' || box.outcome?.status !== 'delivered' ||
      box.outcome.details?.resultAttestation)) return null;
  const ask = rootBoxes.find(box => box.intentId === root.activeIntentId);
  if (!ask || ask.requestedBy?.roleId !== 'orchestrator' || !ask.outcome.details?.questionRef ||
      ask.inputDigest !== root.inputDigest || !isDeepStrictEqual(ask.sourceBinding, currentWorkItemInputBinding(root))) return null;
  const childBoxes = state.outbox.filter(box => box.itemId === child.itemId);
  return { item: root, child, ask, failure, inputBinding,
    snapshotDigest: canonicalJsonDigest({ root, child, rootBoxes, childBoxes }) };
}

export function matchRetiredTriageSource(input, record, job) {
  const binding = input.inputBinding;
  if (!record || record.phase !== 'intaken' || record.workItemId !== input.itemId || record.event?.eventId !== binding.eventId ||
      !job || job.status !== 'superseded' || job.workType !== 'triage_plan' || job.targetRoleId !== 'pr-engineer' ||
      job.relation !== 'review_requested' || job.handoffWorkItemId !== input.itemId || job.repo !== binding.repository ||
      job.number !== binding.pullRequestNumber || job.headRefOid !== binding.headRefOid ||
      !['review', 'rereview'].includes(job.nextAction)) return null;
  let expected;
  try { expected = createPrTriageWorkRequest({ requestKey: job.id, targetRoleId: job.targetRoleId,
    repository: job.repo, number: job.number, nextAction: job.nextAction, expectedHeadRefOid: job.headRefOid }); }
  catch { return null; }
  if (!isDeepStrictEqual(expected, record.request) || record.requestId !== expected.requestId ||
      record.requestDigest !== ownerWorkRequestDigest(expected) || record.event.source?.provider !== 'local-owner' ||
      record.event.source.scopeId !== `owner-request:${expected.requestId}` ||
      typeof record.recordDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.recordDigest) ||
      ![job.createdAt, record.createdAt, job.completedAt].every(value => Number.isFinite(Date.parse(value))) ||
      Date.parse(job.createdAt) > Date.parse(record.createdAt) || Date.parse(record.createdAt) > Date.parse(job.completedAt)) return null;
  return { requestId: expected.requestId, requestCreatedAt: record.createdAt, jobId: job.id,
    jobDigest: canonicalJsonDigest(job), ownerRecordDigest: record.recordDigest };
}

// Normalize the queue record at the host boundary; only its bound receipt is used.
export function publishedTriageReview(snapshot, binding, actorAccountId, facts, requestCreatedAt) {
  let item;
  try { item = normalizeConfirmationState({ schemaVersion: 1, revision: snapshot.queueRevision, items: [snapshot.item] }).items[0]; }
  catch { return null; }
  const payload = item.display?.payload;
  const stateByEvent = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };
  let publishedBinding;
  try { publishedBinding = normalizePullRequestExecutionBinding(payload?.action?.inputBinding); } catch { return null; }
  if (item.status !== 'completed' || !isAutomaticReviewExecution(item) || !sameLogin(payload?.actor?.accountId, actorAccountId) ||
      payload?.target?.provider !== 'github' || payload.target.resourceId !== `${binding.repository}#${binding.pullRequestNumber}` ||
      payload.target.version !== binding.headRefOid || payload.action?.type !== 'pull_request_review' ||
      typeof payload.action.reviewEvent !== 'string' || !Object.hasOwn(stateByEvent, payload.action.reviewEvent) || publishedBinding.repository !== binding.repository ||
      publishedBinding.pullRequestNumber !== binding.pullRequestNumber || publishedBinding.headRefOid !== binding.headRefOid ||
      stateByEvent[payload.action.reviewEvent] !== facts.myLatestPublishedReviewState ||
      facts.myLatestPublishedReviewCommitOid !== binding.headRefOid || !item.receipt ||
      typeof item.receipt.id !== 'string' || !/^\d+$/.test(item.receipt.id) ||
      item.receipt.url !== `https://github.com/${binding.repository}/pull/${binding.pullRequestNumber}` ||
      !Number.isFinite(Date.parse(item.receipt.createdAt)) ||
      Date.parse(item.receipt.createdAt) !== Date.parse(facts.myLatestPublishedReviewAt) ||
      Date.parse(item.receipt.createdAt) > Date.parse(requestCreatedAt)) return null;
  return { confirmationId: item.id, confirmationDigest: canonicalJsonDigest(item), reviewId: item.receipt.id,
    publishedAt: item.receipt.createdAt };
}

function stopped(run, item, roleId, now) {
  const receipt = run?.receipt;
  return run?.kind === 'work-item' && run.taskId === item.itemId && run.roleId === roleId && run.active === false &&
    run.mode === 'active' && run.pendingCommand === null && run.stopUnconfirmed !== true && run.phase === 'completed' &&
    receipt?.kind === 'work-item' && receipt.taskId === item.itemId && receipt.roleId === roleId &&
    receipt.phase === 'completed' && receipt.stopConfirmed === true && Number.isSafeInteger(receipt.taskRevision) &&
    receipt.taskRevision <= item.revision && [receipt.registeredAt, receipt.modelStartedAt, receipt.finishedAt].every(value => Number.isFinite(Date.parse(value))) &&
    Date.parse(receipt.registeredAt) <= Date.parse(receipt.modelStartedAt) && Date.parse(receipt.modelStartedAt) <= Date.parse(receipt.finishedAt) &&
    Date.parse(receipt.finishedAt) <= Date.parse(item.updatedAt) && Date.parse(item.updatedAt) <= Date.parse(now);
}

export function planTriageRetirement({ state, captured, control, clock }) {
  const noChange = { write: false, result: { retired: 0 } };
  const candidate = triageRetirementCandidate(state, state.items.find(item => item.itemId === captured.itemId));
  const now = clock();
  if (!candidate || candidate.snapshotDigest !== captured.snapshotDigest || !control ||
      !stopped(control.run, candidate.item, 'orchestrator', now) || !stopped(control.childRun, candidate.child, 'pr-engineer', now)) return noChange;
  const { item, child, ask, inputBinding } = candidate;
  const source = matchRetiredTriageSource({ itemId: item.itemId, inputBinding }, control.ownerRecord, control.triageJob);
  const observed = Date.parse(control.observedAt), current = Date.parse(now), facts = control.incomingFacts;
  if (!source || !sameLogin(control.actorAccountId, inputBinding.gitTarget.sourceAccountId) ||
      !Number.isFinite(observed) || observed > current || current - observed > 120000 ||
      Date.parse(control.triageJob.completedAt) > current ||
      facts?.incomingReviewFactsAvailable !== true || typeof facts.state !== 'string' || facts.headRefOid !== inputBinding.headRefOid ||
      !Array.isArray(facts.assignees) || !facts.assignees.every(login => typeof login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) ||
      automaticReviewEligibility(facts, control.actorAccountId, now) !== 'NO_CURRENT_INCOMING_REQUEST' ||
      !recoverReviewDiagnostic(state, candidate, control, now)) return noChange;
  if (!Array.isArray(control.publishedReviews) || control.publishedReviews.length > 4) return noChange;
  const matches = control.publishedReviews.map(snapshot => publishedTriageReview(snapshot, inputBinding,
    control.actorAccountId, facts, source.requestCreatedAt)).filter(Boolean);
  if (matches.length !== 1 || candidate.failure.confirmationIds.includes(matches[0].confirmationId)) return noChange;
  // The inbox holds its pending-question lease. Remove only that local wait
  // while planning cancellation; the intermediate state is never persisted.
  const cancellable = { ...item, status: 'queued', activeIntentId: null };
  let cancellation;
  try { cancellation = planWorkGraphCancellation({ state: { ...state, items: state.items.map(entry => entry.itemId === item.itemId ? cancellable : entry) },
    input: { itemId: item.itemId, expectedGraphRevision: state.revision, expectedRevision: item.revision,
      actorId: 'work-ledger-system', reason: REASON }, clock: () => now }); }
  catch (error) { if (error?.code === 'WORK_LEDGER_CANCELLATION_UNSAFE') return noChange; throw error; }
  const retirement = { ...source, ...matches[0], childItemId: child.itemId, childRevision: child.revision };
  const core = { schemaVersion: 1, intentId: ask.intentId, questionRef: ask.outcome.details.questionRef,
    workItemRevision: item.revision + 1, reason: REASON, inputBinding, sourceDigest: ledgerDigest(retirement) };
  return { ...cancellation, patch: { ...cancellation.patch,
    outbox: state.outbox.map(box => box.intentId === ask.intentId ? { ...box, revision: box.revision + 1, updatedAt: now,
      outcome: { ...box.outcome, details: { ...box.outcome.details, automaticTriageRetirement: { ...core, digest: ledgerDigest(core) } } } } : box) },
  timelineEvents: [
    { itemId: item.itemId, type: 'intent_superseded', at: now, actorId: 'work-ledger-system', details: {
      intentId: ask.intentId, reason: REASON, inputBinding, inputDigest: ask.inputDigest, workItemRevision: item.revision + 1,
      retirement } },
    ...cancellation.timelineEvents], result: { retired: 1 } };
}
