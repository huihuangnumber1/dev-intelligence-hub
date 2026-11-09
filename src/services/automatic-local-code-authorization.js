import { isDeepStrictEqual } from 'node:util';
import { OperationQueue } from '../lib/operation-queue.js';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { approveOwnPrAction } from './automatic-own-pr-repair-authorization.js';
import { pendingOverwriteRecoveryCandidate, stoppedCodeJobRun } from './code-job-read-recovery.js';
import { recoverableNativePauseCode } from './automatic-code-job-pause-recovery.js';
import { normalizeInternalReviewMetadata } from '../domain/internal-repair-review.js';
import { currentWorkItemEvent } from './work-ledger-pr-source.js';
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../domain/code-job-contract.js';

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const STALE_TARGET = Symbol('stale local code target');
const ACTIVE = new Set(['queued', 'working', 'dispatch_pending', 'waiting_external', 'waiting_condition']);
const OPERATIONS = { developer: new Set(['inspect', 'modify', 'verify']), tester: new Set(['inspect', 'verify']) };

function canObserveInternalReviewOwner(root, grant) {
  if (root.kind !== 'source_root' || root.source?.kind !== 'pull_request' ||
      root.source.scope.kind !== 'internal_review' || root.source.identity?.provider !== 'internal-review-repair' ||
      !['inspect', 'verify'].includes(grant.operation) || !Array.isArray(grant.writablePaths) || grant.writablePaths.length !== 0 ||
      !Array.isArray(grant.allowedActions) ||
      grant.allowedActions.some(action => !CODE_JOB_ACTIONS_BY_OPERATION[grant.operation].includes(action))) return false;
  const event = currentWorkItemEvent(root);
  if (event?.eventType !== 'pull_request.internal_review_requested' || event.source?.provider !== 'internal-review-repair') return false;
  try { return normalizeInternalReviewMetadata(event.payload.internalReview).headRefOid === grant.inputBinding.headRefOid; }
  catch { return false; }
}

// Routine local work has no external Review provenance. Its authorization
// cannot be used as a Review-repair or conflict-publication receipt.
export class AutomaticLocalCodeAuthorization {
  #operations = new OperationQueue();

  constructor({ specialized, configurationReader, ledger, github, confirmations, grantVerifier, objectSync, roleStateReader,
    taskRuns = null, clock = () => new Date() }) {
    Object.assign(this, { specialized, configurationReader, ledger, github, confirmations, grantVerifier, objectSync, roleStateReader, taskRuns, clock });
  }

  approveCodeJob(item) {
    return this.#operations.enqueue(async () => {
      const specialized = await this.specialized.approveCodeJob(item);
      if (specialized.status !== 'pending' || specialized.kind !== 'local.code-job-create') return specialized;
      const grant = specialized.display?.payload?.action?.grant;
      const role = specialized.requestedBy?.roleId;
      if (!grant?.inputBinding || Object.hasOwn(grant, 'executionSource') || !OPERATIONS[role]?.has(grant.operation)) return specialized;
      const current = await this.#current(specialized, grant);
      if (!current) return specialized;
      if (current === STALE_TARGET) return this.#invalidate(specialized);
      await this.objectSync.prepare({ configuration: current, inputBinding: grant.inputBinding });
      const rechecked = await this.#current(specialized, grant);
      if (!rechecked) return specialized;
      if (rechecked === STALE_TARGET) return this.#invalidate(specialized);
      return approveOwnPrAction(this.confirmations, specialized);
    });
  }

  #invalidate(item) {
    return this.confirmations.invalidate(item.id, { requestedBy: item.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest, reason: 'authorization_changed' });
  }

  async canRecoverPausedCodeJob(job) {
    const grant = job?.grant;
    const role = grant?.requestedBy?.roleId;
    if (!grant?.inputBinding || !OPERATIONS[role]?.has(grant.operation)) return false;
    if (Object.hasOwn(grant, 'executionSource')) {
      const code = recoverableNativePauseCode(job);
      const supported = ['ci_repair', 'review_repair', 'conflict_preparation'].includes(grant.executionSource?.kind);
      if (!supported || code === null ||
          !this.taskRuns?.get || !await this.#sourceAuthorityCurrent(job, 'canRecoverPausedCodeJob')) return false;
      return this.#workControlsCurrent(job);
    }
    const current = await this.#current({ requestedBy: grant.requestedBy }, grant);
    return current !== null && current !== STALE_TARGET;
  }

  async canReplanUnstartedWrite(job) {
    const grant = job?.grant, binding = grant?.inputBinding, role = grant?.requestedBy?.roleId;
    if (!pendingOverwriteRecoveryCandidate(job) || !binding || role !== 'developer' || !this.taskRuns?.get) return false;
    if (!Object.hasOwn(grant, 'executionSource')) {
      const current = await this.#current({ requestedBy: grant.requestedBy }, grant);
      if (current === null || current === STALE_TARGET) return false;
    } else {
      if (!await this.#sourceAuthorityCurrent(job, 'canReplanUnstartedWrite')) return false;
    }
    const getRun = async (kind, taskId) => {
      try { return await this.taskRuns.get(kind, taskId); }
      catch (error) { if (error?.code === 'TASK_RUN_NOT_FOUND') return null; throw error; }
    };
    const proof = await getRun('code-job', job.jobId);
    const before = job.status === 'paused' ? job.execution.pause?.at : new Date(this.clock()).toISOString();
    if (!stoppedCodeJobRun(proof, job, before)) return false;
    return this.#workControlsCurrent(job);
  }

  async #sourceAuthorityCurrent(job, method) {
    const grant = job.grant, binding = grant.inputBinding, role = grant.requestedBy.roleId;
    // Dedicated source records remain authoritative for repair continuation.
    if (role !== 'developer' || !['conflict_preparation', 'review_repair', 'ci_repair'].includes(grant.executionSource?.kind)) return false;
    const config = (await this.configurationReader.readActive())?.configuration;
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories?.includes(binding.repository) ||
        !sameLogin(binding.gitTarget?.sourceAccountId, config.githubActions.actorAccountId)) return false;
    const roleState = await this.roleStateReader.read(role);
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const task = grant.requestedBy.workItemId === binding.rootItemId ? root :
      await this.ledger.readItemForReconciliation({ itemId: grant.requestedBy.workItemId });
    return roleState?.enabled === true && roleState.paused === false && root && task && root.source?.scope?.active === true &&
      ![root, task].some(item => ['paused', 'cancelled', 'superseded', 'completed'].includes(item.status) ||
        (item.status === 'blocked' && ['attention_rejected', 'proposal_rejected'].includes(item.statusReason))) &&
      task.currentTarget?.type === 'role' && task.currentTarget.id === role &&
      typeof this.specialized[method] === 'function' && await this.specialized[method](job) === true;
  }

  async #workControlsCurrent(job) {
    const grant = job.grant, binding = grant.inputBinding;
    for (const taskId of new Set([grant.requestedBy.workItemId, binding.rootItemId])) {
      let run;
      try { run = await this.taskRuns.get('work-item', taskId); }
      catch (error) { if (error?.code !== 'TASK_RUN_NOT_FOUND') throw error; }
      if (run && (run.mode !== 'active' || run.pendingCommand !== null || run.stopUnconfirmed === true)) return false;
    }
    return true;
  }

  async #current(item, grant) {
    const config = (await this.configurationReader.readActive())?.configuration;
    const actor = config?.githubActions?.actorAccountId;
    const role = item.requestedBy.roleId;
    const binding = grant.inputBinding;
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories?.includes(binding.repository) ||
        !sameLogin(binding.gitTarget?.sourceAccountId, actor)) return null;
    const roleState = await this.roleStateReader.read(role);
    if (roleState?.enabled !== true || roleState.paused !== false) return null;
    const context = await this.ledger.readPullRequestExecutionContext(binding);
    if (!samePullRequestExecutionBinding(context.inputBinding, binding)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const task = item.requestedBy.workItemId === binding.rootItemId ? root :
      await this.ledger.readItemForReconciliation({ itemId: item.requestedBy.workItemId });
    if (!root || !task || !ACTIVE.has(root.status) || !ACTIVE.has(task.status) ||
        root.source?.scope?.active !== true || task.currentTarget?.type !== 'role' || task.currentTarget.id !== role) return null;
    const ownerRequested = root.source.scope.kind === 'owner_requested' && root.source.identity?.provider === 'local-owner';
    const observeInternalOwner = context.author === null && canObserveInternalReviewOwner(root, grant);
    if (!sameLogin(context.author, actor) && !ownerRequested && !observeInternalOwner) return null;
    const facts = await this.github.readPullRequestLocalWorkFacts({ repository: binding.repository,
      number: binding.pullRequestNumber, account: actor, authorAccountId: context.author });
    if (facts.state !== 'open' || (context.author !== null && !sameLogin(facts.author, context.author)) ||
        (observeInternalOwner && !sameLogin(facts.author, actor)) ||
        facts.headRefOid !== binding.headRefOid || facts.baseRefOid !== binding.gitTarget.baseRefOid) return STALE_TARGET;
    try {
      if (!isDeepStrictEqual(await this.grantVerifier.verify(grant), grant)) return null;
    } catch (error) {
      if (error?.code === 'INVALID_CODE_JOB_AUTHORITY') return null;
      throw error;
    }
    return config;
  }
}
