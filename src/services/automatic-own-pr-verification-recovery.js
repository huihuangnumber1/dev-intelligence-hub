import { isDeepStrictEqual } from 'node:util';
import { OperationQueue } from '../lib/operation-queue.js';
import { normalizeCodeJobBrowserProjection } from '../domain/code-job-browser-projection.js';
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../domain/code-job-contract.js';
import { encodeVerificationRecoveryEvidence, decodeVerificationRecoveryEvidence } from '../domain/verification-recovery-evidence.js';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { currentWorkItemInputBinding } from './work-ledger-pr-source.js';
import { FailedCodeJobContextReader, VERIFICATION_RECOVERY_REASON, VERIFICATION_RECOVERY_ACTOR,
  AUTOMATIC_VERIFICATION_FAILURE } from './failed-code-job-context-reader.js';

const FAILURE = AUTOMATIC_VERIFICATION_FAILURE;
const READONLY_ACTIONS = new Set(CODE_JOB_ACTIONS_BY_OPERATION.verify);

function eligible(item) {
  return item?.kind === 'source_root' && item.source?.kind === 'pull_request' &&
    item.source.scope.kind === 'automatic' && item.source.scope.active === true &&
    item.status === 'blocked' && item.statusReason === 'proposal_failed' && item.currentTarget?.id === 'developer' &&
    item.ownerId === null && item.leaseId === null && item.leaseUntil === null && item.activeIntentId === null &&
    item.sourceQuarantine === null && Array.isArray(item.graph?.deliveries) && item.graph.deliveries.length === 0 &&
    item.decisionContext?.source === 'proposal' && item.decisionContext.outcome === 'failed' &&
    item.decisionContext.value?.kind === 'code_action_proposal';
}

function currentBindingMatches(item, binding) {
  const current = currentWorkItemInputBinding(item);
  return current !== null && Object.entries(current).every(([key, value]) => binding[key] === value);
}

function matchesProof(proof, job) {
  return proof?.schemaVersion === 1 && proof.jobId === job.jobId && proof.grantDigest === job.grantDigest &&
    proof.reason === 'preparation_interrupted_cleanup_confirmed' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(proof.actionId ?? '') && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(proof.executionId ?? '') &&
    /^[a-f0-9]{64}$/u.test(proof.profileConfigDigest ?? '') && /^[a-f0-9]{64}$/u.test(proof.workspaceRevision ?? '') &&
    job.requiredProfiles.includes(proof.profileId) && samePullRequestExecutionBinding(proof.inputBinding, job.inputBinding);
}

// A settled infrastructure failure may get one NEW decision per Head. The
// ledger transition is the durable budget; no failed job or receipt is reset.
export class AutomaticOwnPrVerificationRecovery {
  #queue = new OperationQueue();
  #cursor = null;

  constructor({ ledger, codeJobReader, settledVerificationReader, objectSync, current }) {
    Object.assign(this, { ledger, codeJobReader, settledVerificationReader, objectSync, current });
    this.failedContextReader = new FailedCodeJobContextReader({ codeJobReader, ledger });
  }

  runCycle({ limit = 10 } = {}) {
    return this.#queue.enqueue(async () => {
      const read = () => this.ledger.listItems({ status: 'blocked', roleId: 'developer', order: 'newest', limit,
        ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
      let page;
      try { page = await read(); }
      catch (error) {
        if (this.#cursor === null || error?.code !== 'WORK_LEDGER_CURSOR_INVALID') throw error;
        this.#cursor = null; page = await read();
      }
      this.#cursor = page.nextCursor ?? null;
      const result = { scanned: 0, requeued: 0, failed: 0 };
      for (const item of page.items) {
        if (!eligible(item)) continue;
        result.scanned += 1;
        try { if (await this.#recoverItem(item)) result.requeued += 1; }
        catch (error) { result.failed += 1; result.lastFailure = error?.code ?? 'OWN_PR_VERIFICATION_RECOVERY_UNAVAILABLE'; }
      }
      return result;
    });
  }

  async #readAll(method, itemId, options = {}) {
    const items = [], seen = new Set();
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.ledger[method]({ itemId, limit: 100, ...options,
        ...(cursor === null ? {} : { cursor }) });
      if (!Array.isArray(result.items) || result.items.length > 100) return null;
      items.push(...result.items);
      if (result.nextCursor == null) return items;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) return null;
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    return null;
  }

  async #canRecover(item, job) {
    const reads = await Promise.allSettled([
      this.#readAll('listTimeline', item.itemId, { order: 'oldest' }),
      this.#readAll('listOutbox', item.itemId),
    ]);
    if (reads.some(read => read.status !== 'fulfilled' || read.value === null)) return false;
    const [history, boxes] = reads.map(read => read.value);
    const creation = history[0];
    if (creation?.itemId !== item.itemId || creation.type !== 'pr_source_created' || creation.at !== item.createdAt ||
        creation.details.workKey !== job.inputBinding.workKey ||
        history.some((entry, index) => entry.itemId !== item.itemId || !Number.isSafeInteger(entry.sequence) ||
          (index > 0 && entry.sequence <= history[index - 1].sequence)) ||
        history.some(entry => {
          if (entry.actorId !== VERIFICATION_RECOVERY_ACTOR || entry.type !== 'transitioned' ||
              entry.details.reason !== VERIFICATION_RECOVERY_REASON) return false;
          const evidence = decodeVerificationRecoveryEvidence(entry.details.context?.evidenceRefs);
          return evidence === null || evidence.headRefOid === job.inputBinding.headRefOid;
        })) return false;
    let currentFailure = false;
    for (const box of boxes.filter(entry => entry.sourceBinding?.headRefOid === job.inputBinding.headRefOid)) {
      if (box.itemId !== item.itemId || box.status !== 'delivered' || box.outcome?.status !== 'delivered' ||
          box.intent.type !== 'propose_code_action') return false;
      const result = box.outcome.details?.resultAttestation;
      if (result?.kind !== 'proposal_result' || !['succeeded', 'failed', 'stale'].includes(result.payload?.outcome)) return false;
      if (box.outcome.details.downstreamRef === item.decisionContext.referenceId) {
        if (result.payload.proposalId !== job.proposalId || result.payload.outcome !== 'failed') return false;
        currentFailure = true;
      }
    }
    return currentFailure;
  }

  async #recoverItem(item) {
    const references = item.decisionContext.value.evidence?.filter(value => typeof value === 'string' && value.startsWith('code-job:'));
    if (references?.length !== 1) return false;
    const jobId = references[0].slice(9), value = await this.codeJobReader.get(jobId);
    if (!value) return false;
    const job = normalizeCodeJobBrowserProjection(value);
    if (job.status !== 'failed' || job.operation !== 'verify' || job.writablePaths.length !== 0 || job.inputBinding?.schemaVersion !== 2 ||
        job.requestedBy.roleId !== 'developer' || job.requestedBy.workItemId !== item.itemId ||
        job.allowedActions.some(action => !READONLY_ACTIONS.has(action))) return false;
    const inputBinding = job.inputBinding;
    if (!currentBindingMatches(item, inputBinding)) return false;
    const failure = await this.failedContextReader.read({ itemId: item.itemId, inputBinding, decisionContext: item.decisionContext });
    if (failure?.failureCode !== FAILURE || failure.operation !== 'verify' || failure.historyComplete !== true ||
        failure.observedActions.some(action => !READONLY_ACTIONS.has(action.actionType)) || !await this.#canRecover(item, job)) return false;
    const proof = await this.settledVerificationReader.read({ jobId, job });
    if (!matchesProof(proof, job)) return false;
    let current = await this.current(inputBinding);
    if (!current) return false;
    await this.objectSync.prepare({ configuration: current.config, inputBinding });
    current = await this.current(inputBinding);
    if (!current || !isDeepStrictEqual(await this.settledVerificationReader.read({ jobId, job }), proof)) return false;
    const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
    if (!eligible(latest) || latest.revision !== item.revision || !currentBindingMatches(latest, inputBinding) ||
        !isDeepStrictEqual(latest.decisionContext, item.decisionContext) ||
        !await this.#canRecover(latest, job)) return false;
    await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
      actorId: VERIFICATION_RECOVERY_ACTOR, toStatus: 'queued', reason: VERIFICATION_RECOVERY_REASON,
      details: { code: FAILURE, downstreamRef: jobId,
        evidenceRefs: encodeVerificationRecoveryEvidence({ ...proof, headRefOid: inputBinding.headRefOid }) } });
    return true;
  }
}
