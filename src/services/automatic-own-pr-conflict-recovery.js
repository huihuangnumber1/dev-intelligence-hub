import { isDeepStrictEqual } from "node:util";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { unstartedConflictDispatchFailure } from "./work-ledger-conflict-failure.js";
import { codeConfirmationSettlementId, completedCodeConfirmationForSettlement, failedCodeConfirmationRecoveryId,
  failedCodeConfirmationForRecovery, unstartedConflictProposalForRecovery } from "./work-ledger-code-confirmation-settlement.js";
import { ObsoleteCodeJobSettler, hasUnstartedCodeJobAuthorityFence, hasUnstartedCodeJobPreparationFailure } from "./obsolete-code-job-settler.js";
import { AUTOMATIC_CONFLICT_PREPARATION_FAILURE, CONFLICT_PREPARATION_RECOVERY_ACTOR,
  CONFLICT_PREPARATION_RECOVERY_REASON } from "./failed-code-job-context-reader.js";

const STATE_KEY = "automatic-own-pr-conflict-recovery-state";
const MAX_RECOVERIES = 3;

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error("自动冲突恢复记录无效");
  const keys = new Set();
  for (const record of value.records) {
    normalizePullRequestExecutionBinding(record.inputBinding);
    const key = `${record.itemId}:${record.failureRef}`;
    if (typeof record.itemId !== "string" || typeof record.failureRef !== "string" || keys.has(key) ||
        !Number.isSafeInteger(record.attempt) || record.attempt < 1 || record.attempt > MAX_RECOVERIES ||
        !["prepared", "requeued"].includes(record.status)) throw new Error("自动冲突恢复记录无效");
    keys.add(key);
  }
  return structuredClone(value);
}

function eligible(item) {
  return item?.status === "blocked" && ["intent_failed", "proposal_stale", "proposal_failed"].includes(item.statusReason) &&
    (item.statusReason !== "proposal_failed" || failedCodeConfirmationRecoveryId(item.decisionContext) !== null) &&
    item.currentTarget?.type === "role" && item.currentTarget.id === "developer" &&
    item.activeIntentId === null && item.leaseId === null && item.sourceQuarantine == null &&
    Array.isArray(item.graph?.deliveries) && item.graph.deliveries.length === 0;
}

// These reads prove the previous attempt never reached an action. Recovery
// creates a fresh decision and grant; it cannot resume or approve the old job.
export class AutomaticOwnPrConflictRecovery {
  #state;
  #cursor = null;
  #settler;

  constructor({ store, ledger, confirmationSettlementReader, codeJobReader, prepareInspection, current }) {
    Object.assign(this, { store, ledger, confirmationSettlementReader, prepareInspection, current });
    this.#settler = new ObsoleteCodeJobSettler({ codeJobReader,
      codeJobControl: { cancel: async () => { throw new Error("Conflict recovery cannot cancel jobs"); } } });
  }

  async recover() {
    this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
  }

  async runCycle({ limit = 10 } = {}) {
    const readPage = () => this.ledger.listItems({ status: "blocked", roleId: "developer", order: "newest", limit,
      ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
    let page;
    try { page = await readPage(); }
    catch (error) {
      if (this.#cursor === null || error?.code !== "WORK_LEDGER_CURSOR_INVALID") throw error;
      this.#cursor = null;
      page = await readPage();
    }
    this.#cursor = page.nextCursor ?? null;
    const result = { scanned: 0, requeued: 0, failed: 0 };
    const candidates = page.items.filter(eligible);
    if (candidates.length === 0) return result;
    for (const item of candidates) {
      result.scanned++;
      try {
        const outboxes = await this.#readOutboxes(item.itemId);
        if (outboxes !== null && await this.#recoverItem(item, outboxes)) result.requeued++;
      }
      catch (error) { result.failed++; result.lastFailure = error?.code ?? "OWN_PR_CONFLICT_RECOVERY_UNAVAILABLE"; }
    }
    return result;
  }

  async #readOutboxes(itemId) {
    const items = [], cursors = new Set();
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.ledger.listOutbox({ itemId, limit: 100, ...(cursor === null ? {} : { cursor }) });
      items.push(...result.items);
      if (!result.nextCursor) return new Map(items.map(item => [item.intentId, item]));
      if (cursors.has(result.nextCursor)) return null;
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    return null;
  }

  async #failureRef(item, outboxes) {
    if (item.statusReason === "intent_failed" && item.decisionContext === null) {
      return unstartedConflictDispatchFailure(item, outboxes.values())?.intentId ?? null;
    }
    if (item.statusReason === "proposal_failed") {
      const confirmationId = failedCodeConfirmationRecoveryId(item.decisionContext);
      if (confirmationId === null || typeof this.confirmationSettlementReader?.read !== "function") return null;
      const snapshot = await this.confirmationSettlementReader.read({ confirmationId });
      const completed = failedCodeConfirmationForRecovery(item, outboxes, snapshot);
      if (completed === null || completed.grant.operation !== "modify" ||
          completed.grant.executionSource?.kind !== "conflict_preparation") return null;
      const job = await this.#settler.read(completed);
      return hasUnstartedCodeJobPreparationFailure(job) && job.memoryProjection !== null &&
        item.decisionContext.value.evidence[3] === `memory:${job.memoryProjection.recordId}` ? job.jobId : null;
    }
    if (item.statusReason !== "proposal_stale") return null;
    const unstarted = unstartedConflictProposalForRecovery(item, outboxes);
    if (unstarted !== null && typeof this.confirmationSettlementReader?.read === "function") {
      return await this.confirmationSettlementReader.read({ confirmationId: unstarted.confirmationId }) === null
        ? unstarted.proposal.proposalId : null;
    }
    const confirmationId = codeConfirmationSettlementId(item.decisionContext);
    if (confirmationId === null || typeof this.confirmationSettlementReader?.read !== "function") return null;
    const snapshot = await this.confirmationSettlementReader.read({ confirmationId });
    const completed = completedCodeConfirmationForSettlement(item, outboxes, snapshot);
    // observedAt precedes the atomic application. The delivered outbox and
    // blocked item share the actual ledger commit time, including on replay.
    if (completed === null || completed.outbox.updatedAt !== item.updatedAt || completed.grant.operation !== "modify" ||
        completed.grant.executionSource?.kind !== "conflict_preparation" ||
        !samePullRequestExecutionBinding(completed.grant.inputBinding, currentWorkItemExecutionBinding(item))) return null;
    const job = await this.#settler.read(completed);
    return hasUnstartedCodeJobAuthorityFence(job) || hasUnstartedCodeJobPreparationFailure(job) ? job.jobId : null;
  }

  async #recoverItem(item, outboxes) {
    const binding = currentWorkItemExecutionBinding(item);
    if (binding?.schemaVersion !== 2) return false;
    const failureRef = await this.#failureRef(item, outboxes);
    if (failureRef === null) return false;
    const prior = this.#state.records.filter(record => record.itemId === item.itemId &&
      samePullRequestExecutionBinding(record.inputBinding, binding));
    let record = prior.find(record => record.failureRef === failureRef);
    if (record?.status === "requeued") return false;
    const attempt = Math.max(0, ...prior.map(record => record.attempt)) + 1;
    if (!record && attempt > MAX_RECOVERIES) return false;
    if (!await this.current(binding)) return false;
    const inspection = await this.prepareInspection({ itemId: item.itemId, itemRevision: item.revision,
      inputDigest: item.inputDigest, force: true });
    if (!inspection?.preparationBinding || !Array.isArray(inspection.conflicts) || inspection.conflicts.length === 0 ||
        !samePullRequestExecutionBinding(inspection.inputBinding, binding)) return false;
    const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
    if (!eligible(latest) || !isDeepStrictEqual(latest, item) ||
        await this.#failureRef(latest, await this.#readOutboxes(item.itemId) ?? new Map()) !== failureRef ||
        !await this.current(binding)) return false;
    if (!record) {
      record = { itemId: item.itemId, inputBinding: binding, failureRef, attempt, status: "prepared" };
      await this.#save([...this.#state.records, record]);
    }
    await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
      actorId: CONFLICT_PREPARATION_RECOVERY_ACTOR, toStatus: "queued", reason: CONFLICT_PREPARATION_RECOVERY_REASON,
      details: { ...(item.statusReason === "proposal_failed" ? { code: AUTOMATIC_CONFLICT_PREPARATION_FAILURE, downstreamRef: failureRef } : {}),
        evidenceRefs: [`failure:${failureRef}`, `conflict-preparation:${inspection.preparationBinding.preparationId}`,
        `head:${binding.headRefOid}`] } });
    await this.#save(this.#state.records.map(entry => entry.itemId === item.itemId && entry.failureRef === failureRef
      ? { ...entry, status: "requeued" } : entry));
    return true;
  }

  async #save(records) {
    const next = normalizeState({ schemaVersion: 1, records });
    try { await this.store.write(STATE_KEY, next); this.#state = next; }
    catch (error) {
      this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
      throw error;
    }
  }
}
