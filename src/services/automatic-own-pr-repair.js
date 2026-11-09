import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { isAutomaticChildWait } from "./work-graph-wait-marker.js";
import { createReviewRepairCodeExecutionSource, createCiRepairCodeExecutionSource, isHeadRepairExecutionSource } from "../domain/code-execution-source.js";
import { normalizeCiRepairEvidence } from '../domain/ci-repair-evidence.js';
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { createPullRequestExternalActionConfirmationPlan } from "../domain/pull-request-external-action.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { recoverableNativePauseCode } from './automatic-code-job-pause-recovery.js';
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";
import { AutomaticOwnPrVerificationRecovery } from './automatic-own-pr-verification-recovery.js';
import { approveOwnPrAction, repairCommitMatchesJob, planOwnPrPushRetry, retryOwnPrPush, validateOwnPrPushRetry } from "./automatic-own-pr-repair-authorization.js";
import { normalizeOwnerWorkRequest } from "../domain/owner-work-request.js";
import { internalRepairReviewRequestId, normalizeInternalReviewMetadata, isInternalCiRepairReviewEvent } from "../domain/internal-repair-review.js";
import { isOwnerPublicationId, normalizeObservedOwnerPublication } from "../domain/observed-owner-publication.js";
import { createOriginalRepairFeedbackSnapshot, createOriginalCiRepairFeedbackSnapshot, normalizeOriginalRepairFeedbackSnapshot, normalizeOriginalRepairFeedbackArchiveReference,
  originalRepairFeedbackBinding, originalRepairFeedbackForRow } from "../domain/original-repair-feedback.js";
import { persistOriginalRepairFeedbackArchives, planOriginalRepairFeedbackArchives, readOriginalRepairFeedbackSnapshot,
  validateOriginalRepairFeedbackArchives } from "./original-repair-feedback-archive.js";

export const AUTOMATIC_OWN_PR_REPAIR_STATE_KEY = "automatic-own-pr-repair-state";
const STATE_KEY = AUTOMATIC_OWN_PR_REPAIR_STATE_KEY;
const DIGEST = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["working", "failed", "stale", "pushing", "published"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fingerprintsValid = (value) => value === undefined ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string" && DIGEST.test(entry)) && new Set(value).size === value.length);
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const samePullRequest = (binding, repository, number) =>
  binding.repository === repository && binding.pullRequestNumber === number;
const sourceKindFor = row => row.sourceKind ?? 'review_repair';
const matchesCurrentRepair = (record, current) => current !== null &&
  sourceKindFor(record) === current.sourceKind && (current.sourceKind === 'ci_repair'
    ? record.ciTriggerDigest === current.ciEvidence.triggerDigest : record.feedbackDigest === current.feedbackDigest);

function repairError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function normalizeAutomaticOwnPrRepairState(value) {
  if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.repairs) || !Array.isArray(value.published)) {
    throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复记录无法读取");
  }
  const ids = new Set();
  const feedbackSnapshots = (value.feedbackSnapshots ?? []).map(normalizeOriginalRepairFeedbackSnapshot);
  if (new Set(feedbackSnapshots.map((entry) => entry.snapshotId)).size !== feedbackSnapshots.length ||
      (value.schemaVersion === 2 && feedbackSnapshots.length)) throw repairError("OWN_PR_REPAIR_STATE_INVALID", "原始反馈快照绑定无效");
  const archiveReferences = new Map();
  const snapshotFor = (row) => {
    if (row.feedbackSnapshotArchive === undefined) {
      if (value.schemaVersion === 2 && row.feedbackSnapshotId !== undefined) throw repairError("OWN_PR_REPAIR_STATE_INVALID", "原始反馈归档引用缺失");
      return feedbackSnapshots.find((entry) => entry.snapshotId === row.feedbackSnapshotId);
    }
    if (value.schemaVersion !== 2) throw repairError("OWN_PR_REPAIR_STATE_INVALID", "原始反馈归档版本无效");
    const reference = normalizeOriginalRepairFeedbackArchiveReference(row.feedbackSnapshotArchive);
    if (reference.snapshotId !== row.feedbackSnapshotId ||
        (archiveReferences.has(reference.snapshotId) && !isDeepStrictEqual(archiveReferences.get(reference.snapshotId), reference))) {
      throw repairError("OWN_PR_REPAIR_STATE_INVALID", "原始反馈归档引用绑定无效");
    }
    archiveReferences.set(reference.snapshotId, reference);
    return reference;
  };
  for (const row of value.repairs) {
    normalizePullRequestExecutionBinding(row.inputBinding);
    if (!STATUSES.has(row.status) || !DIGEST.test(row.feedbackDigest) ||
        typeof row.jobId !== "string" || typeof row.confirmationId !== "string" || ids.has(row.jobId) ||
        !fingerprintsValid(row.feedbackFingerprints) || !['review_repair', 'ci_repair'].includes(sourceKindFor(row)) ||
        (sourceKindFor(row) === 'ci_repair' && !DIGEST.test(row.ciTriggerDigest))) {
      throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复记录绑定无效");
    }
    ids.add(row.jobId);
    validateOwnPrPushRetry(row.pushRetry);
    const snapshot = snapshotFor(row);
    if (row.feedbackSnapshotId !== undefined && (!snapshot || snapshot.originalHeadRefOid !== row.inputBinding.headRefOid ||
      snapshot.feedbackDigest !== row.feedbackDigest || snapshot.repository !== row.inputBinding.repository ||
      snapshot.number !== row.inputBinding.pullRequestNumber)) throw repairError("OWN_PR_REPAIR_STATE_INVALID", "修复任务原始反馈快照无效");
  }
  for (const row of value.published) {
    if (typeof row.repository !== "string" || !Number.isSafeInteger(row.number) ||
        !DIGEST.test(row.feedbackDigest) || !/^[a-f0-9]{40,64}$/.test(row.commitOid) ||
        typeof row.confirmationId !== "string" || !fingerprintsValid(row.feedbackFingerprints) || !['review_repair', 'ci_repair'].includes(sourceKindFor(row)) ||
        (sourceKindFor(row) === 'ci_repair' && !DIGEST.test(row.ciTriggerDigest))) {
      throw repairError("OWN_PR_REPAIR_STATE_INVALID", "自动修复发布记录绑定无效");
    }
    const snapshot = snapshotFor(row);
    if (row.feedbackSnapshotId !== undefined && (!snapshot || snapshot.repository !== row.repository ||
      snapshot.number !== row.number || snapshot.feedbackDigest !== row.feedbackDigest)) throw repairError("OWN_PR_REPAIR_STATE_INVALID", "修复发布原始反馈快照无效");
    const provenance = row.publicationProvenance === undefined ? null : normalizeObservedOwnerPublication(row.publicationProvenance, row);
    if (provenance) {
      const repairs = value.repairs.filter((repair) => repair.jobId === provenance.jobId);
      if (repairs.length !== 1 || repairs[0].feedbackDigest !== row.feedbackDigest ||
          !samePullRequestExecutionBinding(repairs[0].inputBinding, provenance.inputBinding) ||
          (snapshot && snapshot.originalHeadRefOid !== provenance.inputBinding.headRefOid)) {
        throw repairError("OWN_PR_REPAIR_STATE_INVALID", "历史 owner 发布来源与原修复记录不匹配");
      }
    }
    if (row.reviewDelivery !== undefined) {
      const delivery = row.reviewDelivery;
      const request = normalizeOwnerWorkRequest(delivery.request);
      if (request.schemaVersion !== 7 || request.pullRequest.repository !== row.repository ||
          request.pullRequest.number !== row.number || request.internalReview.headRefOid !== row.commitOid ||
          request.internalReview.publicationConfirmationId !== row.confirmationId ||
          request.internalReview.feedbackDigest !== row.feedbackDigest ||
          request.internalReview.kind !== (sourceKindFor(row) === 'ci_repair' ? 'own_pr_ci_repair' : 'own_pr_repair') ||
          (provenance && request.internalReview.controlledCommitEvidenceId !== provenance.controlledCommitReceipt.evidenceId) ||
          request.requestId !== internalRepairReviewRequestId({ repository: row.repository, number: row.number, ...request.internalReview }) ||
          !["pending", "completed", "stale"].includes(delivery.status) ||
          (delivery.status === "completed" && (typeof delivery.workItemId !== "string" || delivery.roleId !== "pr-engineer"))) {
        throw repairError("OWN_PR_REPAIR_STATE_INVALID", "内部复审交接记录无效");
      }
    }
  }
  return structuredClone({ ...value, feedbackSnapshots });
}
const normalizeState = normalizeAutomaticOwnPrRepairState;

// This port is composed from trusted configuration, ledger and GitHub facts.
// A model cannot opt an unrelated task into unattended execution.
export class AutomaticOwnPrRepair {
  #queue = new OperationQueue();
  #approvalQueue = new OperationQueue();
  #state = null;
  #lastJobId = null;
  #lastPublishedId = null;

  constructor({ configurationReader, store, ledger, github, confirmations,
    codeJobReader = null, controlledCommitReader = null, objectSync = null, grantVerifier, ownerWorkRequests = null,
    historicalRepairFeedbackReader = null, historicalControlledCommitReader = null, ciRepairContextReader = null, conflictRepair = null,
    settledVerificationReader = null, clock = () => new Date() }) {
    if (typeof grantVerifier?.verify !== "function") throw new TypeError("Automatic own PR repair requires current grant verification");
    this.configurationReader = configurationReader;
    this.store = store;
    this.ledger = ledger;
    this.github = github;
    this.confirmations = confirmations;
    this.codeJobReader = codeJobReader;
    this.controlledCommitReader = controlledCommitReader;
    this.objectSync = objectSync;
    this.grantVerifier = grantVerifier;
    this.ownerWorkRequests = ownerWorkRequests;
    this.historicalRepairFeedbackReader = historicalRepairFeedbackReader;
    this.historicalControlledCommitReader = historicalControlledCommitReader;
    this.clock = clock;
    this.conflictRepair = conflictRepair;
    this.ciRepairContextReader = ciRepairContextReader;
    this.verificationRecovery = objectSync && settledVerificationReader &&
      ['listItems', 'listTimeline', 'listOutbox', 'transition'].every(method => typeof ledger[method] === 'function') &&
      typeof codeJobReader?.get === 'function' && typeof codeJobReader.getDetail === 'function' &&
      typeof github.readPullRequestLocalWorkFacts === 'function'
      ? new AutomaticOwnPrVerificationRecovery({ ledger, codeJobReader, settledVerificationReader, objectSync,
        current: binding => this.#verificationCurrent(binding) }) : null;
  }

  async recover() {
    const state = normalizeState(await this.store.read(STATE_KEY, {
      schemaVersion: 1, repairs: [], published: [],
    }));
    await validateOriginalRepairFeedbackArchives(this.store, state);
    this.#state = state;
    await this.conflictRepair?.recover();
    for (const record of this.#state.repairs) {
      if (record.status !== "failed" || !record.pushConfirmationId || !this.confirmations.retry) continue;
      let item;
      try { item = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) { if (error?.code === "CONFIRMATION_NOT_FOUND") continue; throw error; }
      if (planOwnPrPushRetry(record, item)) await this.#update(record, { status: "pushing" });
    }
  }

  async #configuration() {
    return (await this.configurationReader.readActive())?.configuration;
  }

  async #grantCurrent(grant) {
    try { return isDeepStrictEqual(await this.grantVerifier.verify(grant), grant); }
    catch (error) {
      if (error?.code === "INVALID_CODE_JOB_AUTHORITY") return false;
      throw error;
    }
  }

  #wasPublished(repository, number, feedbackDigest) {
    return this.#state.published.some((row) => row.repository === repository &&
      row.number === number && row.feedbackDigest === feedbackDigest);
  }

  #ciWasPublished(repository, number, triggerDigest) {
    return this.#state.published.some(row => row.repository === repository && row.number === number &&
      sourceKindFor(row) === 'ci_repair' && row.ciTriggerDigest === triggerDigest);
  }

  #isInFlight(repository, number) {
    return this.#state.repairs.some((row) => samePullRequest(row.inputBinding, repository, number) &&
      ["working", "pushing"].includes(row.status));
  }

  #feedbackPublished(repository, number, facts) {
    if (this.#wasPublished(repository, number, facts.reviewFeedbackDigest)) return true;
    const fingerprints = facts.reviewFeedbackFingerprints;
    if (!fingerprintsValid(fingerprints) || !fingerprints?.length) return false;
    const consumed = new Set(this.#state.published
      .filter((row) => row.repository === repository && row.number === number)
      .flatMap((row) => row.feedbackFingerprints ?? []));
    return fingerprints.every((value) => consumed.has(value));
  }

  async shouldRun(item) {
    if (this.conflictRepair && !await this.conflictRepair.shouldRun(item)) return false;
    const event = currentWorkItemEvent(item);
    const ciRequest = event?.payload?.nextAction === 'fix_ci' &&
      (event.payload.relation === 'authored' ||
        (item.currentTarget?.id === 'developer' && isOwnerRequestedCiRepairEvent(event)));
    if (event?.payload?.nextAction === "resolve_conflict" && this.#isInFlight(event.subject?.repository, event.subject?.number)) return false;
    if (ciRequest && this.ciRepairContextReader !== null &&
        this.#isInFlight(event.subject?.repository, event.subject?.number)) return false;
    if (ciRequest && this.#state.published.some(row =>
      sourceKindFor(row) === 'ci_repair' && row.repository === event.subject?.repository && row.number === event.subject?.number &&
      row.feedbackSnapshotArchive?.originalHeadRefOid === event.payload.headRefOid)) return false;
    if (event?.payload?.relation !== "authored" || event.payload.nextAction !== "address_review") return true;
    const config = await this.#configuration();
    if (config?.githubActions?.automaticOwnPrRepair !== true) return true;
    const payload = event.payload;
    const repository = event.subject?.repository ?? payload.repo;
    const number = event.subject?.number ?? payload.number;
    if (this.#wasPublished(repository, number, payload.reviewFeedbackDigest) ||
        this.#isInFlight(repository, number)) return false;
    if (!this.#state.published.some((row) => row.repository === repository && row.number === number)) return true;
    const facts = await this.github.readOwnPullRequestFeedback({ repository, number, account: config.githubActions.actorAccountId });
    return !this.#feedbackPublished(repository, number, facts);
  }

  async #current(binding) {
    if (this.conflictRepair?.isInFlight(binding)) return null;
    const config = await this.#configuration();
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories.includes(binding.repository)) return null;
    let context;
    try { context = await this.ledger.readPullRequestExecutionContext(binding); }
    catch (error) {
      if (error?.code === 'WORK_LEDGER_PR_EXECUTION_BINDING_STALE') return null;
      throw error;
    }
    if (!samePullRequestExecutionBinding(context.inputBinding, binding)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const event = currentWorkItemEvent(root);
    const internalCiReview = await this.#internalCiReviewOrigin(binding, config, context, root);
    const ownerCiRequest = isOwnerRequestedCiRepairEvent(event) && root?.kind === 'source_root' &&
      root.itemId === binding.rootItemId && root.source?.kind === 'pull_request' &&
      root.source.scope.kind === 'owner_requested' && root.source.scope.active === true &&
      (['queued', 'working', 'dispatch_pending', 'retry_wait', 'waiting_condition', 'waiting_external', 'completed'].includes(root.status) ||
        isAutomaticChildWait(root)) && root.sourceQuarantine === null &&
      root.source.identity.provider === event.source.provider && root.source.identity.scopeId === event.source.scopeId &&
      event.eventId === binding.eventId && event.contentDigest === binding.eventDigest &&
      sameLogin(binding.gitTarget?.sourceAccountId, config.githubActions.actorAccountId);
    if (event?.eventType === 'pull_request.owner_requested' && !ownerCiRequest) return null;
    if (!ownerCiRequest && !internalCiReview && (event?.payload?.relation !== "authored" || !sameLogin(context.author, config.githubActions.actorAccountId))) return null;
    if (ownerCiRequest && context.author !== null && !sameLogin(context.author, config.githubActions.actorAccountId)) return null;
    if ((event.payload.nextAction === 'fix_ci' || internalCiReview) && this.ciRepairContextReader !== null) {
      const current = await this.ciRepairContextReader.read({ inputBinding: binding, event });
      if (current === null) return null;
      const ciEvidence = normalizeCiRepairEvidence(current.ciEvidence);
      const facts = current.facts;
      if (facts?.state !== 'open' || !sameLogin(facts.author, config.githubActions.actorAccountId) || facts.headRefOid !== binding.headRefOid ||
          facts.baseRefOid !== binding.gitTarget.baseRefOid || ciEvidence.repository !== binding.repository ||
          ciEvidence.number !== binding.pullRequestNumber || ciEvidence.headRefOid !== binding.headRefOid ||
          ciEvidence.headRefName !== binding.gitTarget.headRefName || this.#ciWasPublished(binding.repository, binding.pullRequestNumber, ciEvidence.triggerDigest)) return null;
      return { config, facts, ciEvidence, feedbackDigest: ciEvidence.contentDigest, sourceKind: 'ci_repair' };
    }
    if (event.payload.nextAction !== 'address_review') return null;
    const facts = await this.github.readOwnPullRequestFeedback({
      repository: binding.repository, number: binding.pullRequestNumber,
      account: config.githubActions.actorAccountId,
    });
    if (facts.state !== "open" || facts.isDraft === true || facts.draft === true || !sameLogin(facts.author, context.author) ||
        facts.headRefOid !== binding.headRefOid || facts.reviewFeedbackAvailable !== true ||
        !Number.isSafeInteger(facts.reviewFeedbackCount) || facts.reviewFeedbackCount < 1 || !DIGEST.test(facts.reviewFeedbackDigest) ||
        facts.reviewFeedbackDigest !== event.payload.reviewFeedbackDigest ||
        this.#feedbackPublished(binding.repository, binding.pullRequestNumber, facts)) return null;
    return { config, facts, feedbackDigest: facts.reviewFeedbackDigest, sourceKind: 'review_repair' };
  }

  async #internalCiReviewOrigin(binding, config, context, root) {
    const event = currentWorkItemEvent(root);
    if (!isInternalCiRepairReviewEvent(event) || root?.kind !== 'source_root' || root.itemId !== binding.rootItemId ||
        root.currentTarget?.type !== 'role' || root.currentTarget.id !== 'developer' || root.source?.kind !== 'pull_request' ||
        root.source.scope.kind !== 'internal_review' || root.source.scope.active !== true ||
        root.source.pendingRevision != null || root.sourceQuarantine != null ||
        !['queued', 'working', 'dispatch_pending', 'retry_wait', 'waiting_condition', 'waiting_external', 'completed'].includes(root.status) ||
        root.source.identity.provider !== event.source.provider || root.source.identity.scopeId !== event.source.scopeId ||
        event.eventId !== binding.eventId || event.contentDigest !== binding.eventDigest ||
        !sameLogin(binding.gitTarget?.sourceAccountId, config.githubActions.actorAccountId) ||
        (context.author !== null && !sameLogin(context.author, config.githubActions.actorAccountId))) return false;
    const metadata = event.payload.internalReview;
    const published = this.#state.published.find(row => row.repository === binding.repository && row.number === binding.pullRequestNumber &&
      row.commitOid === binding.headRefOid && row.confirmationId === metadata.publicationConfirmationId);
    if (!published?.feedbackSnapshotId || sourceKindFor(published) !== 'ci_repair') return false;
    try {
      await this.readOriginalFeedbackBinding({ inputBinding: binding, internalReview: metadata });
      return true;
    } catch (error) {
      if (['OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE', 'OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID'].includes(error?.code)) return false;
      throw error;
    }
  }

  async #verificationCurrent(binding) {
    const current = await this.#current(binding);
    if (!current || !sameLogin(binding.gitTarget.sourceAccountId, current.config.githubActions.actorAccountId)) return null;
    const facts = await this.github.readPullRequestLocalWorkFacts({ repository: binding.repository, number: binding.pullRequestNumber,
      account: current.config.githubActions.actorAccountId, authorAccountId: current.config.githubActions.actorAccountId });
    return facts.state === 'open' && facts.isDraft === false && sameLogin(facts.author, current.config.githubActions.actorAccountId) &&
      facts.headRefOid === binding.headRefOid && facts.baseRefOid === binding.gitTarget.baseRefOid ? current : null;
  }

  async prepare({ item, intent, inputBinding, roleId }) {
    const event = currentWorkItemEvent(item);
    const conflictSource = await this.conflictRepair?.prepare?.({ item, intent, inputBinding, roleId });
    if (conflictSource !== undefined) return conflictSource;
    if (roleId !== "developer" || intent.type !== "propose_code_action" || intent.operation !== "modify" ||
        (event?.payload?.relation !== "authored" && !isOwnerRequestedCiRepairEvent(event) && !isInternalCiRepairReviewEvent(event)) ||
        (!['address_review', 'fix_ci'].includes(event?.payload?.nextAction) && !isInternalCiRepairReviewEvent(event))) return undefined;
    const current = await this.#current(inputBinding);
    if (!current) {
      if ((event?.payload?.nextAction === 'fix_ci' || isInternalCiRepairReviewEvent(event)) &&
          (this.ciRepairContextReader !== null || isOwnerRequestedCiRepairEvent(event)) &&
          (await this.#configuration())?.githubActions?.automaticOwnPrRepair === true) {
        throw repairError('OWN_PR_CI_SOURCE_NOT_READY', 'CI 修复来源需要重新读取当前检查');
      }
      return undefined;
    }
    const workspaceId = current.config.workCoordination.policy.workspaceByRepository[inputBinding.repository];
    const workspace = current.config.codeExecutor.workspaces.find(({ id }) => id === workspaceId);
    if (!workspace || workspace.gitHeadSnapshot !== true) {
      if (current.sourceKind === 'ci_repair') throw repairError('OWN_PR_CI_SOURCE_NOT_READY', 'CI 修复需要配置的固定 Head 工作区');
      return undefined;
    }
    return current.sourceKind === 'ci_repair'
      ? createCiRepairCodeExecutionSource({ inputBinding, writablePaths: workspace.writablePaths, ciEvidence: current.ciEvidence })
      : createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: workspace.writablePaths });
  }

  async approveCodeJob(item) {
    return this.#approvalQueue.enqueue(() => this.#approveCodeJob(item));
  }

  async #approveCodeJob(item) {
    const binding = item.display?.payload?.action?.grant?.inputBinding;
    if (this.conflictRepair && (!binding || !this.#isInFlight(binding.repository, binding.pullRequestNumber))) {
      const approved = await this.conflictRepair.approveCodeJob(item);
      if (approved.status !== "pending") return approved;
    }
    if (item.kind !== "local.code-job-create" || item.status !== "pending" || item.requestedBy.roleId !== "developer") return item;
    const grant = item.display?.payload?.action?.grant;
    if (!grant?.inputBinding || !["inspect", "modify", "verify"].includes(grant.operation)) return item;
    if (grant.operation === "modify" && !isHeadRepairExecutionSource(grant.executionSource)) {
      if (Object.hasOwn(grant, 'executionSource')) return item;
      const root = await this.ledger.readItemForReconciliation({ itemId: grant.inputBinding.rootItemId });
      if (!isInternalCiRepairReviewEvent(currentWorkItemEvent(root))) return item;
      const config = await this.#configuration();
      if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
          !config.trackedRepositories.includes(grant.inputBinding.repository)) return item;
      const context = await this.ledger.readPullRequestExecutionContext(grant.inputBinding);
      // Retire only the unstarted legacy grant. A fresh decision must seal new
      // current-Head CI provenance before any followup write can be approved.
      return samePullRequestExecutionBinding(context.inputBinding, grant.inputBinding) &&
        await this.#internalCiReviewOrigin(grant.inputBinding, config, context, root) ? this.#invalidatePending(item) : item;
    }
    let current = await this.#current(grant.inputBinding);
    if (!current) return grant.executionSource?.kind === 'ci_repair' ? this.#invalidatePending(item) : item;
    if (grant.operation === 'modify' && (grant.executionSource.kind !== current.sourceKind ||
        (current.sourceKind === 'ci_repair' && grant.executionSource.ciEvidence.triggerDigest !== current.ciEvidence.triggerDigest))) return this.#invalidatePending(item);
    if (this.objectSync) {
      await this.objectSync.prepare({ configuration: current.config, inputBinding: grant.inputBinding });
      current = await this.#current(grant.inputBinding);
      if (!current) return grant.executionSource?.kind === 'ci_repair' ? this.#invalidatePending(item) : item;
      if (grant.operation === 'modify' && (grant.executionSource.kind !== current.sourceKind ||
          (current.sourceKind === 'ci_repair' && grant.executionSource.ciEvidence.triggerDigest !== current.ciEvidence.triggerDigest))) return this.#invalidatePending(item);
    }
    if (grant.operation === "modify") {
      const jobId = codeJobIdForGrant(grant);
      await this.#queue.enqueue(async () => {
        if (this.#state.repairs.some((row) => row.jobId === jobId)) return;
        const duplicate = this.#isInFlight(grant.repository, grant.inputBinding.pullRequestNumber) ||
          (current.sourceKind === 'ci_repair'
            ? this.#ciWasPublished(grant.repository, grant.inputBinding.pullRequestNumber, current.ciEvidence.triggerDigest)
            : this.#wasPublished(grant.repository, grant.inputBinding.pullRequestNumber, current.feedbackDigest));
        if (duplicate) throw repairError("OWN_PR_REPAIR_ALREADY_RUNNING", "此轮 Review 意见已经在修复");
        const snapshot = current.sourceKind === 'ci_repair'
          ? createOriginalCiRepairFeedbackSnapshot({ repository: grant.inputBinding.repository, number: grant.inputBinding.pullRequestNumber,
            ciEvidence: grant.executionSource.ciEvidence, provenance: { kind: 'captured_before_ci_repair', observedHeadRefOid: grant.inputBinding.headRefOid,
              observedAt: new Date(this.clock()).toISOString() } })
          : createOriginalRepairFeedbackSnapshot({ repository: grant.inputBinding.repository,
          number: grant.inputBinding.pullRequestNumber,
          context: { schemaVersion: 1, headRefOid: grant.inputBinding.headRefOid,
            reviewFeedbackDigest: current.facts.reviewFeedbackDigest, feedback: current.facts.feedback },
          provenance: { kind: "captured_before_repair", observedHeadRefOid: grant.inputBinding.headRefOid,
            observedAt: new Date(this.clock()).toISOString() } });
        await this.#save({ ...this.#state,
          feedbackSnapshots: this.#state.feedbackSnapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)
            ? this.#state.feedbackSnapshots : [...this.#state.feedbackSnapshots, snapshot], repairs: [...this.#state.repairs, {
          jobId, confirmationId: item.id, inputBinding: grant.inputBinding,
          feedbackSnapshotId: snapshot.snapshotId,
          feedbackDigest: current.sourceKind === 'ci_repair' ? grant.executionSource.ciEvidence.contentDigest : current.feedbackDigest,
          status: "working", pushConfirmationId: null,
          ...(current.sourceKind === 'ci_repair' ? { sourceKind: 'ci_repair', ciTriggerDigest: grant.executionSource.ciEvidence.triggerDigest } : {}),
          ...(current.facts.reviewFeedbackFingerprints ? { feedbackFingerprints: current.facts.reviewFeedbackFingerprints } : {}),
        }] });
      });
    }
    return this.#approve(item);
  }

  #approve(item) {
    return approveOwnPrAction(this.confirmations, item);
  }

  #invalidatePending(item) {
    if (item.status !== 'pending' || typeof this.confirmations.invalidate !== 'function') return item;
    return this.confirmations.invalidate(item.id, { requestedBy: item.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest, reason: 'authorization_changed' });
  }

  async verifyPush(envelope) {
    if (envelope.action?.controlledCommitEvidence?.executionSource?.kind === "conflict_preparation") {
      return this.conflictRepair === null ? false : this.conflictRepair.verifyPush(envelope);
    }
    if (envelope.kind !== "github.pull-request-push" || envelope.requestedBy?.roleId !== "developer" ||
        !isHeadRepairExecutionSource(envelope.action?.controlledCommitEvidence?.executionSource)) return false;
    const source = envelope.action.controlledCommitEvidence.executionSource;
    const record = this.#state.repairs.find((row) => row.pushConfirmationId === envelope.id &&
      samePullRequestExecutionBinding(row.inputBinding, source.inputBinding));
    if (!record || record.status !== "pushing" || sourceKindFor(record) !== source.kind) return false;
    if (source.kind === 'ci_repair' && (source.ciEvidence?.contentDigest !== record.feedbackDigest ||
        source.ciEvidence.triggerDigest !== record.ciTriggerDigest)) return false;
    const codeItem = await this.confirmations.get(record.confirmationId);
    if (!await this.#grantCurrent(codeItem.display.payload.action.grant)) return false;
    const current = await this.#current(source.inputBinding);
    return matchesCurrentRepair(record, current);
  }

  async recordPublished(value) {
    return this.#queue.enqueue(async () => {
      if (this.#wasPublished(value.repository, value.number, value.feedbackDigest)) return;
      await this.#save({ ...this.#state, published: [...this.#state.published, value] });
    });
  }

  canRecoverPausedCodeJob(job) {
    const kind = job?.grant?.executionSource?.kind;
    if (!['review_repair', 'ci_repair'].includes(kind) &&
        !(kind === 'conflict_preparation' && recoverableNativePauseCode(job) !== null)) return Promise.resolve(false);
    return this.canReplanUnstartedWrite(job);
  }

  async canReplanUnstartedWrite(job) {
    const grant = job?.grant, source = grant?.executionSource;
    if (source?.kind === 'conflict_preparation') return this.conflictRepair?.canReplanUnstartedWrite(job) ?? false;
    if (grant?.operation !== 'modify' || !isHeadRepairExecutionSource(source) ||
        !samePullRequestExecutionBinding(source.inputBinding, grant.inputBinding)) return false;
    const record = this.#state.repairs.find(row => row.jobId === job.jobId && row.status === 'working' &&
      sourceKindFor(row) === source.kind && samePullRequestExecutionBinding(row.inputBinding, grant.inputBinding));
    if (!record) return false;
    const item = await this.confirmations.get(record.confirmationId);
    if (item.kind !== 'local.code-job-create' || item.status !== 'completed' || item.receipt?.id !== job.jobId ||
        !isDeepStrictEqual(item.display?.payload?.action?.grant, grant) || !await this.#grantCurrent(grant)) return false;
    const current = await this.#current(record.inputBinding);
    if (!matchesCurrentRepair(record, current)) return false;
    if (source.kind === 'review_repair') {
      // The Review reader seals feedback and Head, not the current Base tip.
      if (typeof this.github.readPullRequestLocalWorkFacts !== 'function') return false;
      const actor = current.config.githubActions.actorAccountId;
      const facts = await this.github.readPullRequestLocalWorkFacts({ repository: grant.inputBinding.repository,
        number: grant.inputBinding.pullRequestNumber, account: actor, authorAccountId: actor });
      if (facts.state !== 'open' || !sameLogin(facts.author, actor) || facts.headRefOid !== grant.inputBinding.headRefOid ||
          facts.baseRefOid !== grant.inputBinding.gitTarget?.baseRefOid) return false;
    }
    return this.#state.repairs.some(row => row.jobId === record.jobId && row.confirmationId === record.confirmationId && row.status === 'working');
  }

  async runRecoveryCycle({ limit = 10 } = {}) {
    const result = await (this.conflictRepair?.runRecoveryCycle({ limit }) ?? Promise.resolve({}));
    return this.verificationRecovery ? { ...result, verificationRecovery: await this.verificationRecovery.runCycle({ limit }) } : result;
  }

  runCycle({ limit = 10, includeRecovery = true } = {}) {
    return this.#queue.enqueue(async () => {
      const pending = !this.codeJobReader || !this.controlledCommitReader ? [] :
        this.#state.repairs.filter((row) => ["working", "pushing"].includes(row.status) ||
          (this.confirmations.retry && row.pushConfirmationId && ["failed", "stale"].includes(row.status)));
      const start = pending.findIndex((row) => row.jobId === this.#lastJobId) + 1;
      const candidates = [...pending.slice(start), ...pending.slice(0, start)].slice(0, limit);
      this.#lastJobId = candidates.at(-1)?.jobId ?? null;
      const result = { scanned: candidates.length, published: 0, failed: 0, stale: 0 };
      for (const record of candidates) {
        try {
          const status = await this.#advance(record);
          if (Object.hasOwn(result, status)) result[status] += 1;
        } catch (error) {
          // Keep durable work eligible for reconciliation; unknown writes are
          // never automatically retried as a new GitHub publication.
          result.failed += 1;
          result.lastFailure = error?.code ?? "OWN_PR_REPAIR_PROGRESS_UNAVAILABLE";
        }
      }
      await this.#reconcileReviews(limit, result);
      if (includeRecovery && this.verificationRecovery) result.verificationRecovery = await this.verificationRecovery.runCycle({ limit });
      if (this.conflictRepair) {
        const conflicts = await this.conflictRepair.runCycle({ limit, includeRecovery });
        for (const key of ["scanned", "published", "failed", "stale"]) result[key] += conflicts[key];
        if (conflicts.lastFailure) result.lastFailure = conflicts.lastFailure;
      }
      return result;
    });
  }

  async #advance(record) {
    if (record.pushConfirmationId) {
      let push;
      try { push = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) {
        if (error?.code !== "CONFIRMATION_NOT_FOUND") throw error;
        record = { ...record, pushConfirmationId: null };
      }
      // An absent item after recording the intent can be reconstructed with
      // its deterministic id; an unknown queue outcome must not be replayed.
      const retired = ["failed", "stale"].includes(record.status);
      if (!push) return retired ? record.status : this.#advance(record);
      if (retired && !planOwnPrPushRetry(record, push)) return record.status;
      if (push.status === "completed") {
        const commitOid = push.display.payload.action.controlledCommitEvidence.commit.oid;
        const published = { repository: record.inputBinding.repository,
          number: record.inputBinding.pullRequestNumber, feedbackDigest: record.feedbackDigest,
          commitOid, confirmationId: push.id };
        if (sourceKindFor(record) === 'ci_repair') Object.assign(published, { sourceKind: 'ci_repair', ciTriggerDigest: record.ciTriggerDigest });
        if (record.feedbackSnapshotId) published.feedbackSnapshotId = record.feedbackSnapshotId;
        if (record.feedbackFingerprints) published.feedbackFingerprints = record.feedbackFingerprints;
        published.reviewDelivery = this.#reviewDelivery(published, push.display.payload.action.controlledCommitEvidence);
        await this.#save({ ...this.#state,
          published: this.#wasPublished(published.repository, published.number, published.feedbackDigest)
            ? this.#state.published : [...this.#state.published, published],
          repairs: this.#state.repairs.map((row) => row.jobId === record.jobId ? { ...row, status: "published" } : row),
        });
        return "published";
      }
      if (push.status === "failed" && push.failure?.outcome === "unknown") return "waiting";
      const retry = this.confirmations.retry && planOwnPrPushRetry(record, push);
      if (retry) {
        const codeItem = await this.confirmations.get(record.confirmationId);
        if (codeItem.status !== "completed" || codeItem.receipt?.id !== record.jobId) return "waiting";
        if (!await this.#grantCurrent(codeItem.display.payload.action.grant) || !matchesCurrentRepair(record, await this.#current(record.inputBinding))) {
          if (record.status !== "stale") await this.#update(record, { status: "stale" });
          return "stale";
        }
        await this.#update(record, { status: "pushing", pushRetry: retry });
        await retryOwnPrPush(this.confirmations, push, retry);
        return "waiting";
      }
      if (["rejected", "stale", "failed"].includes(push.status)) {
        await this.#update(record, { status: push.status === "stale" ? "stale" : "failed" });
        return push.status === "stale" ? "stale" : "failed";
      }
      if (push.status === 'pending') {
        const current = await this.#current(record.inputBinding);
        if (matchesCurrentRepair(record, current)) await this.#approve(push);
        else if (sourceKindFor(record) === 'ci_repair') {
          await this.#invalidatePending(push); await this.#update(record, { status: 'stale' }); return 'stale';
        }
      }
      return "waiting";
    }
    const detail = await this.codeJobReader.getDetail({ jobId: record.jobId });
    if (!detail) {
      const codeItem = await this.confirmations.get(record.confirmationId);
      if (["rejected", "stale"].includes(codeItem.status) ||
          (codeItem.status === "failed" && codeItem.failure?.outcome !== "unknown")) {
        const status = codeItem.status === "stale" ? "stale" : "failed";
        await this.#update(record, { status }); return status;
      }
      if (codeItem.status === "pending") {
        let current = await this.#current(record.inputBinding);
        if (!matchesCurrentRepair(record, current)) {
          if (sourceKindFor(record) === 'ci_repair') await this.#invalidatePending(codeItem);
          await this.#update(record, { status: "stale" }); return "stale";
        }
        if (this.objectSync) {
          await this.objectSync.prepare({ configuration: current.config, inputBinding: record.inputBinding });
          current = await this.#current(record.inputBinding);
          if (!matchesCurrentRepair(record, current)) {
            if (sourceKindFor(record) === 'ci_repair') await this.#invalidatePending(codeItem);
            await this.#update(record, { status: "stale" }); return "stale";
          }
        }
        await this.#approve(codeItem);
      }
      return "waiting";
    }
    if (["failed", "cancelled", "fenced"].includes(detail.job.status)) {
      await this.#update(record, { status: "failed" }); return "failed";
    }
    // A settled empty export can never acquire a publication receipt. Release
    // this repair's exclusion without claiming the PR or its CI was repaired.
    if (detail.job.status === "completed" && detail.changePackage?.status === "ready" &&
        detail.changePackage.receipt?.noChanges === true) {
      await this.#update(record, { status: "failed" }); return "failed";
    }
    const receipt = detail.changePackage?.receipt?.controlledCommit;
    if (detail.job.status !== "completed" || !receipt) return "waiting";
    const codeItem = await this.confirmations.get(record.confirmationId);
    const grant = codeItem.display.payload.action.grant;
    if (!await this.#grantCurrent(grant)) { await this.#update(record, { status: "stale" }); return "stale"; }
    const evidence = await this.controlledCommitReader.verify({ evidenceId: receipt.evidenceId });
    if (!repairCommitMatchesJob({ evidence, receipt, record, grant, sourceKind: sourceKindFor(record) })) {
      throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "修复提交与代码任务不匹配");
    }
    const current = await this.#current(record.inputBinding);
    if (!matchesCurrentRepair(record, current)) {
      await this.#update(record, { status: "stale" }); return "stale";
    }
    const proposal = normalizeBoundWorkProposal({
      proposalId: `auto-own-pr-repair-push-${digest(record.jobId)}`,
      policyVersion: grant.policyVersion, kind: "github_pull_request_action_proposal",
      requestedBy: grant.requestedBy, source: grant.source,
      binding: { eventId: grant.source.eventId, subject: grant.subject,
        repository: grant.repository, pullRequestNumber: grant.inputBinding.pullRequestNumber,
        headRefOid: grant.inputBinding.headRefOid, inputBinding: grant.inputBinding },
      payload: { action: { type: "push", controlledCommitEvidence: evidence },
        summary: sourceKindFor(record) === 'ci_repair' ? '自动修复 CI 检查，更新原 PR' : "自动修复 Review 意见，更新原 PR",
        reason: "隔离修改已通过配置的验证，推送受控提交",
        evidence: [`code-job:${record.jobId}`, `controlled-commit:${evidence.evidenceId}`] },
    });
    const plan = createPullRequestExternalActionConfirmationPlan(proposal,
      { actorAccountId: current.config.githubActions.actorAccountId });
    await this.#update(record, { status: "pushing", pushConfirmationId: plan.id });
    const push = await this.confirmations.enqueue(plan);
    if (push.status === "pending") await this.#approve(push);
    return "waiting";
  }

  #reviewDelivery(published, evidence) {
    const ci = sourceKindFor(published) === 'ci_repair';
    const internalReview = normalizeInternalReviewMetadata({ kind: ci ? 'own_pr_ci_repair' : "own_pr_repair", headRefOid: published.commitOid,
      feedbackDigest: published.feedbackDigest, publicationConfirmationId: published.confirmationId,
      controlledCommitEvidenceId: evidence.evidenceId });
    const request = normalizeOwnerWorkRequest({ schemaVersion: 7,
      requestId: internalRepairReviewRequestId({ repository: published.repository, number: published.number, ...internalReview }),
      workType: "pull_request", priority: "high", title: `修复后内部复审：${published.repository} #${published.number}`,
      description: `受控修复已确认发布到 Head ${published.commitOid}。请核对${ci ? '原 CI 失败检查、诊断证据' : '原 Review 反馈'}与当前代码，完成内部静态复审；有缺陷则退回研发。此交接不表示${ci ? '新 Head 的 CI 已通过、' : ''}外部人员已收到通知或 GitHub 批准。`,
      acceptanceCriteria: ["逐项核对修复反馈和当前 Head 代码", "区分已有真实测试证据与未覆盖范围", "交付绑定 Head 和修复发布来源的内部结论；剩余缺陷交接研发"],
      pullRequest: { repository: published.repository, number: published.number }, internalReview });
    return { status: "pending", request };
  }

  async #reviewCurrent(published) {
    const config = await this.#configuration();
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories?.includes(published.repository)) return "automation_disabled";
    const facts = sourceKindFor(published) === 'ci_repair'
      ? await this.github.readPullRequestLocalWorkFacts({ repository: published.repository, number: published.number,
        account: config.githubActions.actorAccountId, authorAccountId: config.githubActions.actorAccountId })
      : await this.github.readOwnPullRequestFeedback({ repository: published.repository,
        number: published.number, account: config.githubActions.actorAccountId });
    if (facts.state !== "open") return "pull_request_closed";
    if (sourceKindFor(published) !== 'ci_repair' && (facts.isDraft === true || facts.draft === true)) return "pull_request_draft";
    if (!sameLogin(facts.author, config.githubActions.actorAccountId)) return "author_changed";
    if (facts.headRefOid !== published.commitOid) return "head_changed";
    return null;
  }

  async #legacyReviewDelivery(published) {
    // Queue publication and observed owner publication remain separate sources.
    if (!this.ownerWorkRequests || !this.controlledCommitReader || await this.#reviewCurrent(published)) return null;
    let push;
    try { push = await this.confirmations.get(published.confirmationId); }
    catch (error) {
      if (error?.code !== "CONFIRMATION_NOT_FOUND") throw error;
      return isOwnerPublicationId(published.confirmationId) ? this.#observedOwnerReviewDelivery(published) : null;
    }
    const evidence = push?.display?.payload?.action?.controlledCommitEvidence;
    if (push?.status !== "completed" || push.kind !== "github.pull-request-push" ||
        evidence?.commit?.oid !== published.commitOid || !isHeadRepairExecutionSource(evidence.executionSource) ||
        evidence.executionSource.kind !== sourceKindFor(published) ||
        evidence.executionSource.inputBinding.repository !== published.repository ||
        evidence.executionSource.inputBinding.pullRequestNumber !== published.number) return null;
    const verified = await this.controlledCommitReader.verify({ evidenceId: evidence.evidenceId });
    if (!isDeepStrictEqual(verified, evidence)) throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "历史发布回执与受控修复证据不匹配");
    await this.#ensurePublishedSnapshot(published, evidence);
    return this.#reviewDelivery(published, evidence);
  }

  async #observedOwnerCommit(published) {
    if (typeof this.historicalControlledCommitReader?.findCommitted !== "function" || !this.codeJobReader) {
      throw repairError("OWN_PR_REPAIR_OWNER_PUBLICATION_UNAVAILABLE", "历史 owner 发布的只读来源尚不可用");
    }
    const repairs = this.#state.repairs.filter((row) => samePullRequest(row.inputBinding, published.repository, published.number) &&
      row.feedbackDigest === published.feedbackDigest);
    if (repairs.length !== 1 || this.#state.published.filter((row) => row.confirmationId === published.confirmationId).length !== 1) {
      throw repairError("OWN_PR_REPAIR_OWNER_PUBLICATION_AMBIGUOUS", "历史 owner 发布没有唯一修复记录");
    }
    const repair = repairs[0];
    const config = await this.#configuration();
    if (!sameLogin(repair.inputBinding.gitTarget.sourceAccountId, config?.githubActions?.actorAccountId) ||
        (published.feedbackFingerprints && repair.feedbackFingerprints &&
          !isDeepStrictEqual(published.feedbackFingerprints, repair.feedbackFingerprints))) {
      throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "历史修复作者或反馈绑定不匹配");
    }
    const committed = await this.historicalControlledCommitReader.findCommitted({ inputBinding: repair.inputBinding,
      jobId: repair.jobId, commitOid: published.commitOid });
    if (!committed) throw repairError("OWN_PR_REPAIR_OWNER_PUBLICATION_UNAVAILABLE", "历史 owner 发布缺少 committed delivery");
    const evidence = committed.evidence;
    const detail = await this.codeJobReader.getDetail({ jobId: repair.jobId });
    const job = detail?.job;
    const receipt = detail?.changePackage?.receipt?.controlledCommit;
    if (job?.status !== "completed" || job.jobId !== repair.jobId ||
        !samePullRequestExecutionBinding(job.inputBinding, repair.inputBinding) ||
        !isDeepStrictEqual(job.executionSource, evidence.executionSource) ||
        job.proposalId !== evidence.package.proposal.id || job.proposalContentDigest !== evidence.package.proposal.contentDigest ||
        job.grantDigest !== evidence.package.grant.digest || job.workspaceId !== evidence.workspace.id ||
        !Array.isArray(job.requiredProfiles) || job.requiredProfiles.length !== evidence.tests.profiles.length ||
        !job.requiredProfiles.every((id) => evidence.tests.profiles.some((profile) => profile.id === id)) ||
        receipt?.evidenceId !== evidence.evidenceId || receipt.evidenceDigest !== evidence.evidenceDigest || receipt.commitOid !== published.commitOid) {
      throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "历史 owner 发布与原代码任务或测试证据不匹配");
    }
    return { ...committed, repair, actorAccountId: config.githubActions.actorAccountId };
  }

  async #observedOwnerReviewDelivery(published) {
    const proof = await this.#observedOwnerCommit(published);
    const publicationProvenance = normalizeObservedOwnerPublication({ schemaVersion: 1, kind: "observed_owner_publication",
      publicationId: published.confirmationId, observedAt: new Date(this.clock()).toISOString(),
      actorAccountId: proof.actorAccountId, jobId: proof.repair.jobId, inputBinding: proof.repair.inputBinding,
      controlledCommitReceipt: proof.receipt }, published);
    const reviewDelivery = this.#reviewDelivery(published, proof.evidence);
    await this.#ensurePublishedSnapshot(published, proof.evidence, { publicationProvenance, reviewDelivery });
    return reviewDelivery;
  }

  async #verifyObservedOwnerPublication(published) {
    const provenance = normalizeObservedOwnerPublication(published.publicationProvenance, published);
    const proof = await this.#observedOwnerCommit(published);
    if (!isDeepStrictEqual(provenance.controlledCommitReceipt, proof.receipt) || provenance.jobId !== proof.repair.jobId ||
        !samePullRequestExecutionBinding(provenance.inputBinding, proof.repair.inputBinding) ||
        !sameLogin(provenance.actorAccountId, proof.actorAccountId)) {
      throw repairError("OWN_PR_REPAIR_COMMIT_INVALID", "历史 owner 发布持久来源已变化");
    }
    return proof.evidence;
  }

  async #ensurePublishedSnapshot(published, evidence = null, publicationPatch = {}) {
    if (published.feedbackSnapshotId) {
      if (Object.keys(publicationPatch).length === 0) return published;
      const updated = { ...published, ...publicationPatch };
      await this.#save({ ...this.#state, published: this.#state.published.map((entry) =>
        entry.confirmationId === published.confirmationId ? updated : entry) });
      return this.#state.published.find((entry) => entry.confirmationId === published.confirmationId);
    }
    if (!evidence && published.publicationProvenance) evidence = await this.#verifyObservedOwnerPublication(published);
    if (!evidence) {
      const push = await this.confirmations.get(published.confirmationId);
      evidence = push?.display?.payload?.action?.controlledCommitEvidence;
      if (push?.status !== "completed" || evidence?.commit?.oid !== published.commitOid ||
          !isDeepStrictEqual(await this.controlledCommitReader.verify({ evidenceId: evidence.evidenceId }), evidence)) {
        throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE", "缺少原始修复发布证据");
      }
    }
    const binding = evidence.executionSource?.inputBinding;
    if (evidence.executionSource?.kind !== "review_repair" || binding?.repository !== published.repository ||
        binding.pullRequestNumber !== published.number) throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID", "原始反馈 Head 绑定无效");
    let snapshot = [...this.#state.feedbackSnapshots, ...this.#state.repairs.map((row) => originalRepairFeedbackForRow(this.#state, row)).filter(Boolean)]
      .find((entry) => entry.repository === published.repository &&
      entry.number === published.number && entry.originalHeadRefOid === binding.headRefOid && entry.feedbackDigest === published.feedbackDigest);
    if (snapshot?.bodyHash) snapshot = await readOriginalRepairFeedbackSnapshot(this.store, this.#state, snapshot);
    if (!snapshot) {
      if (typeof this.historicalRepairFeedbackReader?.read !== "function") throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE", "原始修复反馈证据尚不可用");
      const historical = await this.historicalRepairFeedbackReader.read({ jobId: evidence.package.job.id,
        inputBinding: binding, feedbackDigest: published.feedbackDigest });
      if (historical?.context?.headRefOid !== binding.headRefOid || historical.context.reviewFeedbackDigest !== published.feedbackDigest) {
        throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE", "原始完整反馈摘要或 Head 不匹配");
      }
      snapshot = createOriginalRepairFeedbackSnapshot({ repository: published.repository, number: published.number, ...historical });
    }
    const updated = { ...published, ...publicationPatch, feedbackSnapshotId: snapshot.snapshotId };
    await this.#save({ ...this.#state, feedbackSnapshots: this.#state.feedbackSnapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)
      ? this.#state.feedbackSnapshots : [...this.#state.feedbackSnapshots, snapshot],
      published: this.#state.published.map((entry) => entry.confirmationId === published.confirmationId ? updated : entry) });
    return this.#state.published.find((entry) => entry.confirmationId === published.confirmationId && entry.commitOid === published.commitOid);
  }

  async readOriginalFeedbackBinding({ inputBinding, internalReview }) {
    const metadata = normalizeInternalReviewMetadata(internalReview);
    const published = () => this.#state.published.find((entry) => entry.repository === inputBinding.repository && entry.number === inputBinding.pullRequestNumber &&
        entry.commitOid === inputBinding.headRefOid && entry.commitOid === metadata.headRefOid &&
        entry.feedbackDigest === metadata.feedbackDigest && entry.confirmationId === metadata.publicationConfirmationId);
    const read = async () => {
      const row = published();
      if (!row) throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE", "内部复审没有匹配的修复发布记录");
      if (!row.feedbackSnapshotId) await this.#ensurePublishedSnapshot(row);
      const state = this.#state;
      const current = await this.ledger.readPullRequestExecutionContext(inputBinding);
      if (!samePullRequestExecutionBinding(current.inputBinding, inputBinding)) throw repairError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID", "内部复审当前 Head 授权已变化");
      const descriptor = originalRepairFeedbackBinding(state, inputBinding, metadata);
      await readOriginalRepairFeedbackSnapshot(this.store, state, { ...descriptor, repository: inputBinding.repository, number: inputBinding.pullRequestNumber });
      return descriptor;
    };
    // A sealed archive is immutable. Only historical snapshot creation needs
    // serialization with repair mutations and their potentially slow network I/O.
    return published()?.feedbackSnapshotId ? read() : this.#queue.enqueue(read);
  }

  async readOriginalFeedbackSnapshot(query) {
    return readOriginalRepairFeedbackSnapshot(this.store, this.#state, query);
  }

  async #reconcileReviews(limit, result) {
    const eligible = this.#state.published.filter((row) => row.reviewDelivery === undefined || row.reviewDelivery.status === "pending");
    const start = eligible.findIndex((row) => row.confirmationId === this.#lastPublishedId) + 1;
    const candidates = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, limit);
    this.#lastPublishedId = candidates.at(-1)?.confirmationId ?? null;
    for (let published of candidates) {
      try {
        if (!published.reviewDelivery) {
          const delivery = await this.#legacyReviewDelivery(published);
          if (!delivery) continue;
          published = this.#state.published.find((entry) => entry.confirmationId === published.confirmationId);
          if (!published.reviewDelivery) published = await this.#updateReview(published, delivery);
        }
        const stale = await this.#reviewCurrent(published);
        if (stale) {
          await this.#updateReview(published, { ...published.reviewDelivery, status: "stale", reason: stale });
          result.reviewStale = (result.reviewStale ?? 0) + 1; continue;
        }
        if (published.publicationProvenance) await this.#verifyObservedOwnerPublication(published);
        published = await this.#ensurePublishedSnapshot(published);
        if (typeof this.ownerWorkRequests?.submitInternalReview !== "function") {
          throw repairError("OWN_PR_REPAIR_REVIEW_NOT_READY", "内部复审入口尚未就绪");
        }
        const accepted = await this.ownerWorkRequests.submitInternalReview(published.reviewDelivery.request);
        if (accepted?.phase !== "intaken" || typeof accepted.workItemId !== "string" || accepted.assignment?.target?.id !== "pr-engineer") {
          throw repairError("OWN_PR_REPAIR_REVIEW_NOT_INTAKEN", "内部复审未进入 PR 工程师台账");
        }
        await this.#updateReview(published, { ...published.reviewDelivery, status: "completed",
          workItemId: accepted.workItemId, roleId: accepted.assignment.target.id });
        result.reviewDelivered = (result.reviewDelivered ?? 0) + 1;
      } catch (error) {
        result.reviewPending = (result.reviewPending ?? 0) + 1;
        result.lastReviewFailure = error?.code ?? "OWN_PR_REPAIR_REVIEW_UNAVAILABLE";
      }
    }
  }

  async #updateReview(published, reviewDelivery) {
    const updated = { ...published, reviewDelivery };
    await this.#save({ ...this.#state, published: this.#state.published.map((row) =>
      row.confirmationId === published.confirmationId && row.commitOid === published.commitOid ? updated : row) });
    return updated;
  }

  async #update(record, patch) {
    await this.#save({ ...this.#state, repairs: this.#state.repairs.map((row) => row.jobId === record.jobId ? { ...row, ...patch } : row) });
  }

  async #save(value) {
    const plan = planOriginalRepairFeedbackArchives(value);
    const state = normalizeState(plan.state);
    // The body must be durable and verified before its inline copy is released.
    await persistOriginalRepairFeedbackArchives(this.store, plan.records);
    await validateOriginalRepairFeedbackArchives(this.store, state, this.#state);
    try { await this.store.write(STATE_KEY, state); }
    catch (error) {
      const durable = normalizeState(await this.store.read(STATE_KEY, this.#state));
      await validateOriginalRepairFeedbackArchives(this.store, durable);
      this.#state = durable;
      throw error;
    }
    this.#state = state;
  }
}
