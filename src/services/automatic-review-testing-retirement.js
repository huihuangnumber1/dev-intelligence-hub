import { isDeepStrictEqual } from 'node:util';
import { isAutomaticReviewExecution } from '../domain/automatic-review-policy.js';
import { reviewHandoffRequestId } from '../domain/review-handoff.js';
import { planWorkGraphCancellation } from './work-ledger-graph-commands.js';
import { currentWorkItemExecutionBinding } from './work-ledger-pr-source.js';
import { ledgerDigest } from './work-ledger-values.js';
import { stoppedCodeJobExecutor } from './obsolete-code-job-settler.js';

const REASON = 'automatic_review_external_qa_only';
const stoppedProofs = new WeakMap();
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function retirementInputs(item) {
  const source = item?.source, event = source?.current?.event, person = event?.payload?.responsiblePerson;
  if (item?.kind !== 'source_root' || item.currentTarget?.id !== 'tester' ||
      !['queued', 'retry_wait', 'waiting_external', 'blocked'].includes(item.status) ||
      ['attention_rejected', 'proposal_rejected'].includes(item.statusReason) || item.decisionContext?.outcome === 'rejected' ||
      item.ownerId !== null || item.leaseId !== null || item.activeIntentId !== null || item.sourceQuarantine !== null ||
      item.graph.deliveries.length !== 0 || source?.kind !== 'pull_request' || source.scope.kind !== 'owner_requested' ||
      source.scope.active !== true || source.activeRevision !== 1 || source.pendingRevision !== null ||
      event?.eventType !== 'pull_request.owner_requested' || event.source.provider !== 'local-owner' ||
      event.payload.workType !== 'testing' || !person?.login) return null;
  const confirmationId = /^确认：(confirmation-github-review-[a-f0-9]{64})$/m.exec(event.payload.description || '')?.[1];
  if (!confirmationId || sameLogin(person.login, event.payload.gitTarget?.sourceAccountId)) return null;
  return { source, person, confirmationId };
}

export function isReviewTestingRetirementCandidate(item) { return retirementInputs(item) !== null; }

export function reviewTestingRetirementCandidate(item) {
  const inputs = retirementInputs(item);
  if (!inputs) return null;
  const { source, person, confirmationId } = inputs;
  const binding = currentWorkItemExecutionBinding(item);
  if (!confirmationId || !binding || sameLogin(person.login, binding.gitTarget?.sourceAccountId)) return null;
  return { itemId: item.itemId, snapshotDigest: ledgerDigest(item), confirmationId, inputBinding: binding,
    mayHaveRun: item.attempt > 0,
    requestId: source.identity.scopeId.replace(/^owner-request:/, ''), responsiblePerson: person };
}

export function matchesAutomaticReviewTestingHandoff(candidate, snapshot) {
  const item = snapshot?.item, handoff = item?.reviewHandoff, binding = candidate.inputBinding;
  return Boolean(item?.id === candidate.confirmationId && item.status === 'completed' && item.receipt &&
    isAutomaticReviewExecution(item) && item.action?.reviewEvent === 'APPROVE' &&
    item.target.resourceId === `${binding.repository}#${binding.pullRequestNumber}` && item.target.version === binding.headRefOid &&
    sameLogin(item.actor.accountId, binding.gitTarget?.sourceAccountId) && handoff?.status === 'completed' &&
    handoff.requestId === candidate.requestId && handoff.requestId === reviewHandoffRequestId(item) &&
    handoff.selection.workType === 'testing' && isDeepStrictEqual(handoff.selection.responsiblePerson, candidate.responsiblePerson) &&
    sameLogin(handoff.assignedLogin, candidate.responsiblePerson.login) &&
    (handoff.workItemId === candidate.itemId || (handoff.deliveryKind === 'assignment_only' && handoff.workItemId === null)));
}

function runStopped(run, kind, taskId, roleId) {
  const receipt = run?.receipt;
  return Boolean(run?.active === false && run.mode === 'active' && run.pendingCommand === null &&
    run.stopUnconfirmed !== true && run.kind === kind && run.taskId === taskId && run.roleId === roleId &&
    receipt?.kind === kind && receipt.taskId === taskId && receipt.roleId === roleId &&
    receipt.runId === run.runId && ['completed', 'failed'].includes(receipt.phase) &&
    Number.isFinite(Date.parse(receipt.finishedAt)) && receipt.stopConfirmed === true);
}

function executorStopped(job, session, observations) {
  if (observations === null) return false;
  const unstarted = job.status === 'cancelled' && job.turn === 0 && job.observationCount === 0;
  if (session === null) return unstarted;
  if (unstarted && session.actions?.length === 0) {
    return session.id === job.jobId && session.workspaceId === job.workspaceId && session.status === 'cancelled' &&
      session.attempt?.status === 'cancelled' && session.cleanupPending === false &&
      isDeepStrictEqual(session.inputBinding, job.inputBinding) && isDeepStrictEqual(session.requestedBy, job.requestedBy) &&
      isDeepStrictEqual(session.executionSource ?? null, job.executionSource ?? null);
  }
  return stoppedCodeJobExecutor(job, session, observations, ['completed', 'interrupted', 'failed', 'cancelled']);
}

export class AutomaticReviewTestingStopReader {
  constructor({ codeJobs, codeControl, taskRuns, codeExecutor }) {
    Object.assign(this, { codeJobs, codeControl, taskRuns, codeExecutor });
  }

  async #run(kind, id) {
    try { return await this.taskRuns.get(kind, id); }
    catch (error) { if (error?.code === 'TASK_RUN_NOT_FOUND') return null; throw error; }
  }

  async #observations(job) {
    const observations = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const detail = await this.codeJobs.getDetail({ jobId: job.jobId, limit: 20, ...(cursor ? { cursor } : {}) });
      if (detail?.archived !== false || detail.historyAvailable !== true || !detail.terminalDetail ||
          !isDeepStrictEqual(detail.job, job) || !Array.isArray(detail.observations)) return null;
      observations.push(...detail.observations);
      if (observations.length > job.observationCount) return null;
      if (detail.nextCursor === null) return observations.length === job.observationCount ? observations : null;
      if (typeof detail.nextCursor !== 'string' || !detail.nextCursor || cursors.has(detail.nextCursor)) return null;
      cursor = detail.nextCursor; cursors.add(cursor);
    }
    return null;
  }

  async read(candidate) {
    const rootRun = await this.#run('work-item', candidate.itemId);
    const rootStopped = run => run === null ? !candidate.mayHaveRun : runStopped(run, 'work-item', candidate.itemId, 'tester');
    if (!rootStopped(rootRun)) return null;
    const jobs = [], cursors = new Set();
    let cursor = null, revision;
    for (let page = 0; page < 20; page++) {
      const batch = await this.codeJobs.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      if (revision !== undefined && revision !== batch.revision) return null;
      revision = batch.revision;
      jobs.push(...batch.items.filter(job => job.requestedBy?.workItemId === candidate.itemId));
      if (batch.nextCursor === null) { cursor = null; break; }
      if (cursors.has(batch.nextCursor)) return null;
      cursor = batch.nextCursor; cursors.add(cursor);
    }
    if (cursor !== null) return null;
    for (const job of jobs) {
      if (job.requestedBy.roleId !== 'tester' || !['inspect', 'verify'].includes(job.operation) ||
          !isDeepStrictEqual(job.inputBinding, candidate.inputBinding) ||
          job.writablePaths.length !== 0 || job.executionSource || ['paused', 'pausing', 'unknown'].includes(job.status) ||
          job.uncertainty !== null) return null;
      const run = await this.#run('code-job', job.jobId);
      if (run && (run.mode !== 'active' || run.pendingCommand !== null || run.stopUnconfirmed === true)) return null;
    }
    for (const job of jobs) {
      if (!['completed', 'cancelled', 'failed', 'fenced', 'cancelling'].includes(job.status)) {
        await this.codeControl.cancel({ jobId: job.jobId, expectedRevision: job.revision, reason: REASON });
        return null;
      }
      const run = await this.#run('code-job', job.jobId);
      const unstartedCancellation = job.status === 'cancelled' && job.turn === 0 && job.observationCount === 0;
      if (job.status === 'cancelling' || !(run === null ? unstartedCancellation :
        runStopped(run, 'code-job', job.jobId, 'tester'))) return null;
      let session;
      try { session = await this.codeExecutor.view({ sessionId: job.jobId }); }
      catch (error) { if (error?.code !== 'SESSION_NOT_FOUND') throw error; session = null; }
      const observations = await this.#observations(job);
      if (!executorStopped(job, session, observations)) return null;
      const latest = await this.codeJobs.get(job.jobId);
      if (!isDeepStrictEqual(latest, job)) return null;
      if (!isDeepStrictEqual(run, await this.#run('code-job', job.jobId))) return null;
      if (session !== null && !isDeepStrictEqual(session, await this.codeExecutor.view({ sessionId: job.jobId }))) return null;
    }
    if (!rootStopped(await this.#run('work-item', candidate.itemId))) return null;
    const proof = Object.freeze({});
    stoppedProofs.set(proof, candidate.snapshotDigest);
    return proof;
  }
}

export function planAutomaticReviewTestingRetirement({ state, captured, snapshot, stopped, clock }) {
  const unchanged = { write: false, result: { retired: 0 } };
  const current = reviewTestingRetirementCandidate(state.items.find(item => item.itemId === captured.itemId));
  if (!current || current.snapshotDigest !== captured.snapshotDigest || stoppedProofs.get(stopped) !== current.snapshotDigest ||
      !matchesAutomaticReviewTestingHandoff(current, snapshot)) return unchanged;
  // The host proved external QA assignment and settled the unintended local
  // executor. This temporary state only admits the existing graph cancel plan.
  const items = state.items.map(item => item.itemId === captured.itemId ? { ...item, status: 'queued' } : item);
  try {
    const result = planWorkGraphCancellation({ state: { ...state, items }, clock,
      input: { itemId: captured.itemId, expectedGraphRevision: state.revision,
        expectedRevision: items.find(item => item.itemId === captured.itemId).revision,
        actorId: 'work-ledger-system', reason: REASON } });
    return { ...result, result: { retired: 1 } };
  } catch (error) { if (error?.code === 'WORK_LEDGER_CANCELLATION_UNSAFE') return unchanged; throw error; }
}
