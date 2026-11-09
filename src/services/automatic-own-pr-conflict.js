import { isInternalRepairReviewEvent } from "../domain/internal-repair-review.js";
import { createConflictCodeExecutionSource } from "../domain/code-execution-source.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeBoundWorkProposal } from "../domain/work-proposal-contract.js";
import { createPullRequestExternalActionConfirmationPlan } from "../domain/pull-request-external-action.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { approveOwnPrAction, repairCommitMatchesJob, planOwnPrPushRetry, retryOwnPrPush, validateOwnPrPushRetry } from "./automatic-own-pr-repair-authorization.js";
import { AutomaticOwnPrInspectionRecovery } from "./automatic-own-pr-inspection-recovery.js";
import { AutomaticOwnPrConflictRecovery } from "./automatic-own-pr-conflict-recovery.js";
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";

const STATE_KEY = "automatic-own-pr-conflict-state";
const STATUSES = new Set(["working", "pushing", "published", "failed", "stale"]);
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const digest = value => createHash("sha256").update(value).digest("hex");
const samePr = (left, right) => left.repository === right.repository && left.pullRequestNumber === right.pullRequestNumber;
const active = record => ["working", "pushing"].includes(record.status);
const conflictTask = event => isInternalRepairReviewEvent(event) || isOwnerRequestedCiRepairEvent(event) || event?.payload?.nextAction === "resolve_conflict" && (
  event.payload.relation === "authored" ||
  (event.source?.provider === "local-owner" && event.eventType === "pull_request.owner_requested")
);

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error("自动冲突修复记录无效");
  const ids = new Set();
  for (const record of value.records) {
    normalizePullRequestExecutionBinding(record.inputBinding);
    if (typeof record.jobId !== "string" || ids.has(record.jobId) || typeof record.confirmationId !== "string" ||
        !STATUSES.has(record.status) || !(record.pushConfirmationId === null || typeof record.pushConfirmationId === "string")) {
      throw new Error("自动冲突修复绑定无效");
    }
    ids.add(record.jobId);
    validateOwnPrPushRetry(record.pushRetry);
    if (record.capabilityRecovery !== undefined && (record.capabilityRecovery?.capability !== "conflict-edit-and-source-v1" ||
        !Number.isSafeInteger(record.capabilityRecovery.pausedRevision) || record.capabilityRecovery.pausedRevision < 1 ||
        typeof record.capabilityRecovery.runId !== "string" || !record.capabilityRecovery.runId || record.capabilityRecovery.runId.length > 256)) {
      throw new Error("自动冲突修复恢复记录无效");
    }
    if (record.largeActionRecovery !== undefined && (record.largeActionRecovery?.capability !== "conflict-large-action-v1" ||
        !Number.isSafeInteger(record.largeActionRecovery.pausedRevision) || record.largeActionRecovery.pausedRevision < 1 ||
        typeof record.largeActionRecovery.runId !== "string" || !record.largeActionRecovery.runId || record.largeActionRecovery.runId.length > 256)) {
      throw new Error("自动冲突修复大文件恢复记录无效");
    }
    if (record.providerResponseRecovery !== undefined && (record.providerResponseRecovery?.capability !== "provider-response-retry-v1" ||
        !Number.isSafeInteger(record.providerResponseRecovery.pausedRevision) || record.providerResponseRecovery.pausedRevision < 1 ||
        typeof record.providerResponseRecovery.runId !== "string" || !record.providerResponseRecovery.runId || record.providerResponseRecovery.runId.length > 256)) {
      throw new Error("自动冲突修复模型响应恢复记录无效");
    }
  }
  return structuredClone(value);
}

// Uses the existing sealed conflict snapshot, validation profiles and two-parent
// commit pipeline. It grants no general-purpose push or self-review authority.
export class AutomaticOwnPrConflict {
  #queue = new OperationQueue();
  #state;
  #lastJobId = null;
  #inspections = new Map();

  constructor({ configurationReader, store, ledger, github, confirmations, codeJobReader,
    controlledCommitReader, objectSync, grantVerifier, conflictInspectionReader, codeJobControl, taskRuns, confirmationSettlementReader, inspectionEnvironmentReader }) {
    Object.assign(this, { configurationReader, store, ledger, github, confirmations, codeJobReader,
      controlledCommitReader, objectSync, grantVerifier, conflictInspectionReader, codeJobControl, taskRuns });
    this.inspectionRecovery = objectSync && typeof ledger.listItems === "function" && typeof ledger.transition === "function" &&
      typeof codeJobReader?.getDetail === "function" && typeof ledger.listTimeline === "function"
      ? new AutomaticOwnPrInspectionRecovery({ store, ledger, codeJobReader, objectSync, inspectionEnvironmentReader, current: binding => this.#current(binding, { inspectionRecovery: true }) }) : null;
    this.conflictRecovery = objectSync && conflictInspectionReader && typeof ledger.listOutbox === "function" &&
      typeof ledger.listItems === "function" && typeof ledger.transition === "function" &&
      typeof codeJobReader?.get === "function" && typeof codeJobReader.getDetail === "function"
      ? new AutomaticOwnPrConflictRecovery({ store, ledger, codeJobReader, confirmationSettlementReader,
        prepareInspection: request => this.prepareInspection(request), current: binding => this.#current(binding) }) : null;
  }

  async recover() {
    this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
    await this.inspectionRecovery?.recover();
    await this.conflictRecovery?.recover();
    for (const record of this.#state.records) {
      if (record.status !== "failed" || !record.pushConfirmationId || !this.confirmations.retry) continue;
      let item;
      try { item = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) { if (error?.code === "CONFIRMATION_NOT_FOUND") continue; throw error; }
      if (planOwnPrPushRetry(record, item)) await this.#update(record, "pushing");
    }
  }

  async shouldRun(item) {
    const binding = item.source?.identity;
    const event = currentWorkItemEvent(item);
    const target = { repository: binding?.repository ?? event?.subject?.repository,
      pullRequestNumber: binding?.pullRequestNumber ?? event?.subject?.number };
    if (!this.isInFlight(target)) {
      if (item.currentTarget?.id === "developer" && conflictTask(event) && this.conflictInspectionReader) {
        await this.prepareInspection({ itemId: item.itemId, itemRevision: item.revision, inputDigest: item.inputDigest });
      }
      return true;
    }
    const config = (await this.configurationReader.readActive())?.configuration;
    return config?.githubActions?.automaticOwnPrRepair !== true;
  }

  isInFlight(binding) {
    return this.#state.records.some(record => active(record) && samePr(record.inputBinding, binding));
  }

  async canReplanUnstartedWrite(job) {
    const grant = job?.grant;
    if (grant?.operation !== 'modify' || grant.executionSource?.kind !== 'conflict_preparation' ||
        !samePullRequestExecutionBinding(grant.executionSource.inputBinding, grant.inputBinding)) return false;
    const record = this.#state.records.find(row => row.jobId === job.jobId && row.status === 'working' &&
      samePullRequestExecutionBinding(row.inputBinding, grant.inputBinding));
    if (!record) return false;
    const item = await this.confirmations.get(record.confirmationId);
    if (item.kind !== 'local.code-job-create' || item.status !== 'completed' || item.receipt?.id !== job.jobId ||
        !isDeepStrictEqual(item.display?.payload?.action?.grant, grant) ||
        !await this.#current(record.inputBinding) || !await this.#grantCurrent(grant)) return false;
    return this.#state.records.some(row => row.jobId === record.jobId && row.confirmationId === record.confirmationId && row.status === 'working');
  }

  async readInspection({ itemId, itemRevision, inputDigest }) {
    const cached = this.#inspections.get(itemId);
    if (!cached) return null;
    const configuration = (await this.configurationReader.readActive())?.configuration;
    if (configuration?.githubActions?.enabled !== true || configuration.githubActions.automaticOwnPrRepair !== true ||
        !sameLogin(configuration.githubActions.actorAccountId, cached.inputBinding.gitTarget.sourceAccountId) ||
        !configuration.trackedRepositories.includes(cached.inputBinding.repository)) return null;
    const item = await this.ledger.readItemForReconciliation({ itemId });
    const binding = currentWorkItemExecutionBinding(item);
    if (item.revision !== itemRevision || item.inputDigest !== inputDigest || item.currentTarget?.id !== "developer" ||
        !conflictTask(currentWorkItemEvent(item)) || !binding || !samePullRequestExecutionBinding(cached.inputBinding, binding)) return null;
    // These captured bytes describe an immutable preparation, not publication
    // authority. Fresh facts, grant creation and execution recheck the target.
    return structuredClone(cached);
  }

  async prepareInspection({ itemId, itemRevision, inputDigest, force = false }) {
    if (!this.conflictInspectionReader) return null;
    const item = await this.ledger.readItemForReconciliation({ itemId });
    if (item.revision !== itemRevision || item.inputDigest !== inputDigest ||
        item.currentTarget?.id !== "developer" || !conflictTask(currentWorkItemEvent(item))) return null;
    const binding = currentWorkItemExecutionBinding(item);
    if (binding?.schemaVersion !== 2) return null;
    const configuration = await this.#current(binding);
    if (!configuration) return null;
    const cached = this.#inspections.get(itemId);
    if (!force && cached && samePullRequestExecutionBinding(cached.inputBinding, binding)) return structuredClone(cached);
    this.#inspections.delete(itemId);
    await this.objectSync.prepare({ configuration, inputBinding: binding });
    const inspection = await this.conflictInspectionReader.read(binding);
    const latest = await this.ledger.readItemForReconciliation({ itemId });
    if (!samePullRequestExecutionBinding(inspection.inputBinding, binding) ||
        latest.revision !== itemRevision || latest.inputDigest !== inputDigest || !await this.#current(binding)) {
      throw Object.assign(new Error("冲突检查材料在读取期间失效"), { code: "OWN_PR_CONFLICT_TARGET_CHANGED" });
    }
    this.#inspections.set(itemId, structuredClone(inspection));
    while (this.#inspections.size > 32) this.#inspections.delete(this.#inspections.keys().next().value);
    return structuredClone(inspection);
  }

  async prepare({ item, intent, inputBinding, roleId }) {
    if (roleId !== "developer" || intent.type !== "propose_code_action" || intent.operation !== "modify" ||
        (!isInternalRepairReviewEvent(currentWorkItemEvent(item)) && !isOwnerRequestedCiRepairEvent(currentWorkItemEvent(item)))) return undefined;
    try {
      const inspection = await this.prepareInspection({ itemId: item.itemId, itemRevision: item.revision, inputDigest: item.inputDigest });
      if (inspection === null) return undefined;
      if (!samePullRequestExecutionBinding(inspection.inputBinding, inputBinding)) {
        throw Object.assign(new Error("Internal conflict source changed"), { code: "OWN_PR_CONFLICT_TARGET_CHANGED" });
      }
      return createConflictCodeExecutionSource({ inputBinding, preparationBinding: inspection.preparationBinding });
    } catch (error) {
      if (!["OWN_PR_CONFLICT_TARGET_CHANGED", "CONFLICT_PREPARATION_NOT_CONFLICTED"].includes(error?.code)) throw error;
      throw Object.assign(new Error("内部修复的冲突来源需要重新检查"), { code: "OWN_PR_CONFLICT_SOURCE_NOT_READY" });
    }
  }

  async #current(binding, { rejectChangedTarget = false, inspectionRecovery = false } = {}) {
    const config = (await this.configurationReader.readActive())?.configuration;
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories.includes(binding.repository) ||
        !sameLogin(binding.gitTarget?.sourceAccountId, config.githubActions.actorAccountId)) return null;
    const context = await this.ledger.readPullRequestExecutionContext(binding);
    if (!samePullRequestExecutionBinding(context.inputBinding, binding)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const event = currentWorkItemEvent(root);
    // Object recovery may requeue a failed read-only inspection of an owned PR.
    // Conflict repair and publication still use the default conflict-only gate.
    const ordinaryInspection = inspectionRecovery && !conflictTask(event);
    if (ordinaryInspection && (root.kind !== "source_root" || root.source?.kind !== "pull_request" ||
        root.source.scope.kind !== "automatic" || root.source.scope.active !== true ||
        root.source.pendingRevision != null || root.sourceQuarantine != null ||
        ["paused", "cancelled", "superseded", "completed"].includes(root.status) ||
        (root.status === "blocked" && root.statusReason !== "proposal_failed") ||
        event?.source?.provider !== "github" || event.payload.relation !== "authored" ||
        root.source.identity.provider !== event.source.provider || root.source.identity.scopeId !== event.source.scopeId ||
        !sameLogin(context.author, config.githubActions.actorAccountId))) return null;
    const internal = isInternalRepairReviewEvent(event);
    const ownerCi = isOwnerRequestedCiRepairEvent(event);
    if ((internal || ownerCi) && (root.source?.scope.kind !== (internal ? "internal_review" : "owner_requested") || root.source.scope.active !== true ||
        root.source.identity.provider !== (internal ? "internal-review-repair" : "local-owner") || root.source.identity.scopeId !== event.source.scopeId ||
        root.source.pendingRevision != null || root.sourceQuarantine != null || ["paused", "cancelled", "superseded"].includes(root.status) ||
        (context.author !== null && !sameLogin(context.author, config.githubActions.actorAccountId)))) return null;
    if (ownerCi && !["queued", "working", "dispatch_pending", "retry_wait", "waiting_condition", "waiting_external", "completed"].includes(root.status)) return null;
    if ((!ordinaryInspection && !conflictTask(event)) || (event.payload.relation === "authored" && !sameLogin(context.author, config.githubActions.actorAccountId))) return null;
    const facts = await this.github.readOwnPullRequestConflict({ repository: binding.repository,
      number: binding.pullRequestNumber, account: config.githubActions.actorAccountId });
    if (rejectChangedTarget && sameLogin(facts.author, config.githubActions.actorAccountId) &&
        (facts.headRefOid !== binding.headRefOid || facts.baseRefOid !== binding.gitTarget.baseRefOid)) {
      throw Object.assign(new Error("冲突任务绑定的远端 Head/Base 已变化"), { code: "OWN_PR_CONFLICT_TARGET_CHANGED" });
    }
    if (facts.state !== "open" ||
        !sameLogin(facts.author, config.githubActions.actorAccountId) || facts.headRefOid !== binding.headRefOid ||
        facts.baseRefOid !== binding.gitTarget.baseRefOid || (!ordinaryInspection && facts.mergeStateStatus !== "DIRTY")) return null;
    return config;
  }

  async #grantCurrent(grant) {
    try { return isDeepStrictEqual(await this.grantVerifier.verify(grant), grant); }
    catch (error) { if (error?.code === "INVALID_CODE_JOB_AUTHORITY") return false; throw error; }
  }

  async approveCodeJob(item) {
    if (item.kind !== "local.code-job-create" || item.status !== "pending" || item.requestedBy?.roleId !== "developer") return item;
    const grant = item.display?.payload?.action?.grant;
    if (!grant?.inputBinding || !["inspect", "verify", "modify"].includes(grant.operation) ||
        (grant.operation === "modify" && (grant.executionSource?.kind !== "conflict_preparation" ||
          !samePullRequestExecutionBinding(grant.executionSource.inputBinding, grant.inputBinding)))) return item;
    let config;
    try {
      config = await this.#current(grant.inputBinding, { rejectChangedTarget: true });
      if (!config || !await this.#grantCurrent(grant)) return item;
      if (this.objectSync) {
        await this.objectSync.prepare({ configuration: config, inputBinding: grant.inputBinding });
        config = await this.#current(grant.inputBinding, { rejectChangedTarget: true });
        if (!config) return item;
      }
    }
    catch (error) {
      if (error?.code !== "OWN_PR_CONFLICT_TARGET_CHANGED") throw error;
      try { return await this.#invalidatePending(item); }
      catch (invalidation) { if (invalidation?.code === "CONFIRMATION_NOT_INVALIDATABLE") return item; throw invalidation; }
    }
    if (grant.operation === "modify") {
      await this.#queue.enqueue(async () => {
        const jobId = codeJobIdForGrant(grant);
        if (this.#state.records.some(record => record.jobId === jobId)) return;
        if (this.#state.records.some(record => active(record) && samePr(record.inputBinding, grant.inputBinding))) {
          throw Object.assign(new Error("此 PR 的冲突修复正在执行"), { code: "OWN_PR_REPAIR_ALREADY_RUNNING" });
        }
        await this.#save({ ...this.#state, records: [...this.#state.records, {
          jobId, confirmationId: item.id, inputBinding: grant.inputBinding, status: "working", pushConfirmationId: null,
        }] });
      });
    }
    return this.#approve(item);
  }

  #approve(item) {
    return approveOwnPrAction(this.confirmations, item);
  }

  async verifyPush(envelope) {
    if (envelope.kind !== "github.pull-request-push" || envelope.requestedBy?.roleId !== "developer" ||
        envelope.action?.controlledCommitEvidence?.executionSource?.kind !== "conflict_preparation") return false;
    const source = envelope.action.controlledCommitEvidence.executionSource;
    const record = this.#state.records.find(record => record.pushConfirmationId === envelope.id && record.status === "pushing" &&
      samePullRequestExecutionBinding(record.inputBinding, source.inputBinding));
    if (!record) return false;
    const codeItem = await this.confirmations.get(record.confirmationId);
    return await this.#grantCurrent(codeItem.display.payload.action.grant) && await this.#current(record.inputBinding) !== null;
  }

  runRecoveryCycle({ limit = 10 } = {}) {
    return this.#queue.enqueue(() => this.#recoverMaterials(limit));
  }

  async #recoverMaterials(limit) {
    const inspectionRecovery = await this.inspectionRecovery?.runCycle({ limit });
    const conflictRecovery = await this.conflictRecovery?.runCycle({ limit });
    return { ...(inspectionRecovery ? { inspectionRecovery } : {}), ...(conflictRecovery ? { conflictRecovery } : {}) };
  }

  runCycle({ limit = 10, includeRecovery = true } = {}) {
    return this.#queue.enqueue(async () => {
      const recovery = includeRecovery ? await this.#recoverMaterials(limit) : {};
      const pending = this.#state.records.filter(record => active(record) ||
        (this.confirmations.retry && record.pushConfirmationId && ["failed", "stale"].includes(record.status)));
      const start = pending.findIndex(record => record.jobId === this.#lastJobId) + 1;
      const candidates = [...pending.slice(start), ...pending.slice(0, start)].slice(0, limit);
      this.#lastJobId = candidates.at(-1)?.jobId ?? null;
      const result = { scanned: candidates.length, published: 0, failed: 0, stale: 0,
        ...recovery };
      for (const record of candidates) {
        try { const status = await this.#advance(record); if (Object.hasOwn(result, status)) result[status] += 1; }
        catch (error) { result.failed += 1; result.lastFailure = error?.code ?? "OWN_PR_CONFLICT_PROGRESS_UNAVAILABLE"; }
      }
      return result;
    });
  }

  async #advance(record) {
    const codeItem = await this.confirmations.get(record.confirmationId);
    const grant = codeItem.display.payload.action.grant;
    const retired = ["failed", "stale"].includes(record.status);
    if (record.pushConfirmationId) {
      let push;
      try { push = await this.confirmations.get(record.pushConfirmationId); }
      catch (error) { if (error?.code !== "CONFIRMATION_NOT_FOUND") throw error; }
      if (!push) return retired ? record.status : this.#advance({ ...record, pushConfirmationId: null });
      if (retired && !planOwnPrPushRetry(record, push)) return record.status;
      if (push.status === "completed") { await this.#update(record, "published"); return "published"; }
      if (push.status === "failed" && push.failure?.outcome === "unknown") return "waiting";
      const retry = this.confirmations.retry && planOwnPrPushRetry(record, push);
      if (retry) {
        if (codeItem.status !== "completed" || codeItem.receipt?.id !== record.jobId) return "waiting";
        if (!await this.#grantCurrent(grant) || !await this.#current(record.inputBinding)) {
          if (record.status !== "stale") await this.#update(record, "stale");
          return "stale";
        }
        await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId
          ? { ...row, status: "pushing", pushRetry: retry } : row) });
        await retryOwnPrPush(this.confirmations, push, retry);
        return "waiting";
      }
      if (["stale", "rejected", "failed"].includes(push.status)) {
        const status = push.status === "stale" ? "stale" : "failed";
        await this.#update(record, status); return status;
      }
      if (push.status === "pending") {
        if (!await this.#grantCurrent(grant) || !await this.#current(record.inputBinding)) return this.#retirePending(record, push);
        await this.#approve(push);
      }
      return "waiting";
    }
    const detail = await this.codeJobReader.getDetail({ jobId: record.jobId });
    if (!detail) {
      if (["stale", "rejected", "failed"].includes(codeItem.status)) {
        if (codeItem.failure?.outcome === "unknown") return "waiting";
        const status = codeItem.status === "stale" ? "stale" : "failed";
        await this.#update(record, status); return status;
      }
      if (codeItem.status === "pending") {
        if (!await this.#grantCurrent(grant) || !await this.#current(record.inputBinding)) return this.#retirePending(record, codeItem);
        await this.#approve(codeItem);
      }
      return "waiting";
    }
    if (detail.job.status === "paused") {
      return await this.#recoverSystemBlock(record, codeItem, detail.job) ? "working" : "waiting";
    }
    if (["failed", "cancelled", "fenced"].includes(detail.job.status)) { await this.#update(record, "failed"); return "failed"; }
    const receipt = detail.changePackage?.receipt?.controlledCommit;
    if (detail.job.status !== "completed" || !receipt) return "waiting";
    const config = await this.#current(record.inputBinding);
    if (!config || !await this.#grantCurrent(grant)) { await this.#update(record, "stale"); return "stale"; }
    const evidence = await this.controlledCommitReader.verify({ evidenceId: receipt.evidenceId });
    if (!repairCommitMatchesJob({ evidence, receipt, record, grant, sourceKind: "conflict_preparation", requireProfiles: true })) {
      throw Object.assign(new Error("冲突提交与验证任务不匹配"), { code: "OWN_PR_REPAIR_COMMIT_INVALID" });
    }
    const proposal = normalizeBoundWorkProposal({
      proposalId: `auto-own-pr-conflict-push-${digest(record.jobId)}`, policyVersion: grant.policyVersion,
      kind: "github_pull_request_action_proposal", requestedBy: grant.requestedBy, source: grant.source,
      binding: { eventId: grant.source.eventId, subject: grant.subject, repository: grant.repository,
        pullRequestNumber: grant.inputBinding.pullRequestNumber, headRefOid: grant.inputBinding.headRefOid, inputBinding: grant.inputBinding },
      payload: { action: { type: "push", controlledCommitEvidence: evidence }, summary: "自动解决合并冲突，更新原 PR",
        reason: "受控冲突修复已通过配置的验证", evidence: [`code-job:${record.jobId}`, `controlled-commit:${evidence.evidenceId}`] },
    });
    const plan = createPullRequestExternalActionConfirmationPlan(proposal, { actorAccountId: config.githubActions.actorAccountId });
    await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId
      ? { ...row, status: "pushing", pushConfirmationId: plan.id } : row) });
    const push = await this.confirmations.enqueue(plan);
    if (push.status === "pending") await this.#approve(push);
    return "waiting";
  }

  async #update(record, status) {
    await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId ? { ...row, status } : row) });
  }

  async #recoverSystemBlock(record, codeItem, job) {
    const responseFailure = job.pause?.reason === "等待人工处理（STRUCTURED_PROVIDER_RESPONSE_INVALID）";
    const code = responseFailure ? "STRUCTURED_PROVIDER_RESPONSE_INVALID" : "CODE_BRAIN_COMPLETION_NOT_READY";
    const recoveryKey = responseFailure ? "providerResponseRecovery" : "largeActionRecovery";
    const recovery = record[recoveryKey];
    if (!this.codeJobControl?.resume || !this.taskRuns?.get || record.status !== "working" ||
        codeItem.status !== "completed" ||
        codeItem.receipt?.id !== record.jobId || job.jobId !== record.jobId || job.operation !== "modify" ||
        job.pendingActionType !== null || job.uncertainty !== null ||
        job.pause?.reason !== `等待人工处理（${code}）` ||
        !samePullRequestExecutionBinding(job.inputBinding, record.inputBinding) ||
        (recovery && recovery.pausedRevision !== job.revision)) return false;
    const grant = codeItem.display.payload.action.grant;
    if (job.grantDigest !== grant.grantDigest || grant.executionSource?.kind !== "conflict_preparation" ||
        !await this.#current(record.inputBinding) || !await this.#grantCurrent(grant)) return false;
    const proof = await this.taskRuns.get("code-job", record.jobId);
    const receipt = proof?.receipt;
    const finished = Date.parse(receipt?.finishedAt);
    const started = Date.parse(receipt?.modelStartedAt);
    const paused = Date.parse(job.pause.at);
    if (proof?.mode !== "active" || proof.active !== false || proof.pendingCommand !== null || proof.stopUnconfirmed === true ||
        proof.runId !== receipt?.runId || receipt?.session?.transport !== "app-server" ||
        receipt?.kind !== "code-job" || receipt.taskId !== record.jobId || receipt.roleId !== "developer" ||
        receipt.phase !== "failed" || receipt.outcomeCode !== code || receipt.stopConfirmed !== true ||
        typeof receipt.runId !== "string" || !receipt.runId || !Number.isFinite(finished) || !Number.isFinite(started) || !Number.isFinite(paused) ||
        started < Date.parse(job.createdAt) || started > finished || finished > paused ||
        (recovery && recovery.runId !== receipt.runId)) return false;
    if (!recovery) {
      await this.#save({ ...this.#state, records: this.#state.records.map(row => row.jobId === record.jobId ? {
        ...row, [recoveryKey]: { capability: responseFailure ? "provider-response-retry-v1" : "conflict-large-action-v1",
          pausedRevision: job.revision, runId: receipt.runId },
      } : row) });
    }
    // CAS protects concurrent controls. A durable owner pause in TaskRuns is
    // still authoritative when the worker next tries to start its model.
    await this.codeJobControl.resume({ jobId: record.jobId, expectedRevision: job.revision });
    return true;
  }

  async #retirePending(record, item) {
    try {
      await this.#invalidatePending(item);
    } catch (error) {
      if (error?.code === "CONFIRMATION_NOT_INVALIDATABLE") return "waiting";
      throw error;
    }
    await this.#update(record, "stale");
    return "stale";
  }

  #invalidatePending(item) {
    return this.confirmations.invalidate(item.id, { requestedBy: item.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest, reason: "authorization_changed" });
  }

  async #save(value) {
    const next = normalizeState(value);
    try { await this.store.write(STATE_KEY, next); }
    catch (error) { this.#state = normalizeState(await this.store.read(STATE_KEY, this.#state)); throw error; }
    this.#state = next;
  }
}
