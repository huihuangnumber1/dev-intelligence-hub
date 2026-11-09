import { isDeepStrictEqual } from "node:util";
import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeCiRepairEvidence } from "../domain/ci-repair-evidence.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { indexWorkLedgerGraphProgress } from "./work-ledger-graph-progress.js";
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding, currentWorkItemInputBinding,
  pullRequestTrustedPredecessor, verifyPullRequestExecutionBinding } from "./work-ledger-pr-source.js";
import { hasExactLedgerKeys, ledgerDigest } from "./work-ledger-values.js";
import { moveWorkItem } from "./work-ledger-transitions.js";

const CI_MATERIALS_RECOVERED = "ci_materials_recovered";

// Adapter for a persisted, untyped material request. Scope decisions and owner
// holds are not material requests, even when their text also mentions CI.
function isCiMaterialQuestion(intent, event) {
  return isOwnerRequestedCiRepairEvent(event) && intent?.type === "ask_user" &&
    intent.summary === "请求补齐 QuickTest.cn 运行材料或可读取来源" &&
    intent.reason === "开发子任务已完成限制报告交付，未产生修复或测试证据。当前仅有 QuickTest.cn FAILURE 快照，缺少最新远端状态及实际失败运行材料，无法判断是否需要代码修复。重复派发相同任务不能消除渠道缺口，因此升级请求缺失信息，不请求例行修复授权，也不将工具限制认定为代码缺陷或结束根任务。" &&
    intent.question === `请提供 ${event.subject.repository} #${event.subject.number} 的最新 Head/检查状态，以及 QuickTest.cn 失败运行的链接或编号、检查对应 SHA、实际检出 SHA、失败阶段、首个有效错误和相关测试报告；也可提供这些材料的可读取来源。当前绑定 Head 为 ${event.payload.headRefOid}。补齐后继续交由 development 定位和处理必要修复。` &&
    isDeepStrictEqual(intent.choices, [
      { id: "provide-run-evidence", label: "提供运行材料", description: "补充最新状态及失败运行日志、提交绑定和测试报告。" },
      { id: "provide-readonly-source", label: "提供可读取来源", description: "指出现有只读渠道或日志材料位置，以便继续取证。" }]);
}

function isSameCiMaterialSource(previous, next) {
  return isOwnerRequestedCiRepairEvent(next) && next.subject.repository === previous.subject.repository &&
    next.subject.number === previous.subject.number && next.payload.headRefOid === previous.payload.headRefOid &&
    next.source.scopeId === previous.source.scopeId &&
    isDeepStrictEqual({ ...previous.payload.gitTarget, baseRefOid: next.payload.gitTarget?.baseRefOid }, next.payload.gitTarget);
}

export function ciMaterialRecoveryCandidate(state, item) {
  if (state.attentionCursor < state.attentionHighWatermark || item?.kind !== "source_root" ||
      item.status !== "waiting_user" || item.currentTarget?.id !== "orchestrator" ||
      item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null || item.sourceQuarantine !== null ||
      item.source?.scope.active !== true) return null;
  const event = currentWorkItemEvent(item), ask = state.outbox.find(box => box.intentId === item.activeIntentId);
  const inputBinding = currentWorkItemExecutionBinding(item);
  if (!inputBinding || !isCiMaterialQuestion(ask?.intent, event) || ask.itemId !== item.itemId ||
      ask.requestedBy.roleId !== "orchestrator" || ask.requestedBy.workerId !== "employee-orchestrator" ||
      ask.status !== "delivered" || ask.outcome?.status !== "delivered" || ask.outcome.details?.resultAttestation ||
      ask.dispatchBinding?.boundIntent?.kind !== "attention_request" ||
      !/^attention-[a-f0-9]{64}$/.test(ask.outcome.details?.questionRef ?? "") ||
      !isDeepStrictEqual(ask.sourceBinding, currentWorkItemInputBinding(item))) return null;
  const children = limitationChildren(state, item, ask);
  if (children === null || ask.outcome.details?.ciMaterialRetirement) return null;
  let readBinding = inputBinding, readEvent = event;
  if (item.source.pendingRevision !== null) {
    const pending = item.source.pending, authority = pullRequestTrustedPredecessor(state, item);
    if (!pending || !isSameCiMaterialSource(event, pending.event) || authority?.canonicalRootItemId !== item.itemId || authority.authorityFenced) return null;
    const revision = item.source.revisions[item.source.pendingRevision - 1];
    readEvent = pending.event;
    readBinding = normalizePullRequestExecutionBinding({ ...inputBinding, inputRevision: item.source.pendingRevision,
      headRevision: revision.headRevision, inputDigest: pending.inputDigest, eventId: pending.eventId,
      eventDigest: pending.eventDigest, gitTarget: pending.event.payload.gitTarget });
  } else {
    try { verifyPullRequestExecutionBinding(state, inputBinding); } catch { return null; }
  }
  const staged = state.timeline.find(entry => entry.itemId === item.itemId && entry.type === "intent_staged" && entry.details.intentId === ask.intentId);
  if (!Number.isSafeInteger(staged?.details.workItemRevision) || staged.details.workItemRevision < 2) return null;
  const childrenDigest = childHistoryDigest(children);
  return { item, ask, inputBinding, readBinding, readEvent, decisionRevision: staged.details.workItemRevision - 1,
    childrenDigest, snapshotDigest: ledgerDigest({ item: canonicalJsonDigest(item), ask: canonicalJsonDigest(ask),
      childrenDigest, staged: canonicalJsonDigest(staged) }) };
}

function limitationChildren(state, item, ask) {
  const { childrenByParent } = indexWorkLedgerGraphProgress(state.items);
  const children = [], related = new Set([item.itemId]);
  for (const parent of related) for (const child of childrenByParent.get(parent) ?? []) {
    if (related.has(child.itemId)) return null;
    related.add(child.itemId); children.push(child);
  }
  if (children.length === 0 || children.some(child => child.status !== "completed" || child.ownerId !== null ||
      child.leaseId !== null || child.sourceQuarantine !== null ||
      !isDeepStrictEqual(currentWorkItemInputBinding(child), ask.sourceBinding) ||
      child.graph.deliveries.some(delivery => child.graph.acceptanceContracts
        .find(contract => contract.revision === delivery.contractRevision)?.expectedDeliverables
        .find(expected => expected.deliverableId === delivery.deliverableId)?.kind !== "text-report"))) return null;
  // This old request followed limitation reports only. Other proposals require
  // their own effect settlement and must not be inferred from missing materials.
  if (state.outbox.some(box => related.has(box.itemId) && box.intentId !== ask.intentId)) return null;
  return children;
}

function childHistoryDigest(children) {
  // These records have already crossed the ledger's per-field validation. Hash
  // complete records separately so combining legal histories adds no new cap.
  return canonicalJsonDigest(children.map(child => canonicalJsonDigest(child)));
}

export function ciMaterialRetirement(outbox) {
  const proof = outbox?.outcome?.details?.ciMaterialRetirement;
  if (!hasExactLedgerKeys(proof, ["schemaVersion", "intentId", "questionRef", "workItemRevision", "reason",
    "inputBinding", "readBinding", "materialDigest", "childrenDigest", "digest"]) || proof.schemaVersion !== 1 ||
      proof.reason !== CI_MATERIALS_RECOVERED || proof.intentId !== outbox.intentId ||
      proof.questionRef !== outbox.outcome.details.questionRef || outbox.status !== "delivered" ||
      outbox.outcome.status !== "delivered" || !Number.isSafeInteger(proof.workItemRevision) || proof.workItemRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(proof.materialDigest ?? "") || !/^[a-f0-9]{64}$/.test(proof.childrenDigest ?? "") || !outbox.sourceBinding) return null;
  try {
    const original = normalizePullRequestExecutionBinding(proof.inputBinding), read = normalizePullRequestExecutionBinding(proof.readBinding);
    if (original.schemaVersion !== 2 || read.schemaVersion !== 2 || read.rootItemId !== original.rootItemId ||
        read.repository !== original.repository || read.pullRequestNumber !== original.pullRequestNumber ||
        read.headRefOid !== original.headRefOid ||
        !isDeepStrictEqual({ ...original.gitTarget, baseRefOid: read.gitTarget.baseRefOid }, read.gitTarget) ||
        !isDeepStrictEqual(Object.fromEntries(Object.keys(outbox.sourceBinding).map(key => [key, original[key]])), outbox.sourceBinding)) return null;
    const { digest, ...core } = proof;
    return digest === ledgerDigest(core) ? proof : null;
  } catch { return null; }
}

export function planCiMaterialRecovery({ state, captured, control, clock }) {
  const candidate = ciMaterialRecoveryCandidate(state, state.items.find(item => item.itemId === captured.itemId));
  const noChange = { write: false, result: { retried: 0 } };
  if (!candidate || candidate.snapshotDigest !== captured.snapshotDigest) return noChange;
  const { item, ask, inputBinding, readBinding, decisionRevision, childrenDigest } = candidate;
  const run = control?.run, receipt = run?.receipt;
  if (typeof control?.actorAccountId !== "string" || control.actorAccountId.toLowerCase() !== inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
      run?.kind !== "work-item" || run.taskId !== item.itemId || run.roleId !== "orchestrator" ||
      run.active !== false || run.mode !== "active" || run.pendingCommand !== null || run.stopUnconfirmed === true ||
      run.phase !== "completed" || receipt?.kind !== "work-item" || receipt.taskId !== item.itemId ||
      receipt.roleId !== "orchestrator" || receipt.phase !== "completed" || receipt.stopConfirmed !== true ||
      receipt.taskRevision !== decisionRevision ||
      ![receipt.registeredAt, receipt.modelStartedAt, receipt.finishedAt, ask.createdAt].every(value => Number.isFinite(Date.parse(value))) ||
      !(Date.parse(receipt.registeredAt) <= Date.parse(receipt.modelStartedAt) && Date.parse(receipt.modelStartedAt) <= Date.parse(receipt.finishedAt) &&
        Date.parse(receipt.finishedAt) <= Date.parse(ask.createdAt))) return noChange;
  let material;
  try { material = normalizeCiRepairEvidence(control.ciEvidence); } catch { return noChange; }
  if (material.repository !== readBinding.repository || material.number !== readBinding.pullRequestNumber ||
      material.headRefOid !== readBinding.headRefOid || material.headRefName !== readBinding.gitTarget.headRefName ||
      !material.diagnostics.some(report => report.check === "QuickTest.cn" && report.state === "available" && Array.isArray(report.failures) && report.failures.length > 0)) return noChange;
  const now = clock(), updated = moveWorkItem(item, { status: "queued", now,
    reason: CI_MATERIALS_RECOVERED, activeIntentId: null });
  const core = { schemaVersion: 1, intentId: ask.intentId, questionRef: ask.outcome.details.questionRef,
    workItemRevision: updated.revision, reason: CI_MATERIALS_RECOVERED, inputBinding, readBinding, materialDigest: material.contentDigest, childrenDigest };
  return { patch: { items: state.items.map(entry => entry.itemId === item.itemId ? updated : entry),
    outbox: state.outbox.map(entry => entry.intentId === ask.intentId ? { ...ask, revision: ask.revision + 1, updatedAt: now,
      outcome: { ...ask.outcome, details: { ...ask.outcome.details, ciMaterialRetirement: { ...core, digest: ledgerDigest(core) } } } } : entry) },
    timelineEvents: [{ itemId: item.itemId, type: "intent_superseded", at: now, actorId: "work-ledger-system",
      details: { intentId: ask.intentId, reason: CI_MATERIALS_RECOVERED, workItemRevision: updated.revision, materialDigest: material.contentDigest } },
    { itemId: item.itemId, type: "transitioned", at: now, actorId: "work-ledger-system",
      details: { fromStatus: item.status, toStatus: "queued", reason: CI_MATERIALS_RECOVERED } }], result: { retried: 1 } };
}

// Previously persisted CI recoveries used retry_wait. Only their unchanged
// proof-bearing parent can continue; creating its child restores queued state.
export function hasPendingCiMaterialRecovery(state, item) {
  if (item?.kind !== "source_root" || item.currentTarget?.id !== "orchestrator" || item.status !== "retry_wait" ||
      item.statusReason !== CI_MATERIALS_RECOVERED || item.activeIntentId !== null || item.ownerId !== null ||
      item.leaseId !== null || item.sourceQuarantine !== null || item.source?.pendingRevision !== null) return false;
  const binding = currentWorkItemExecutionBinding(item);
  for (const ask of state.outbox) {
    if (ask.itemId !== item.itemId) continue;
    const proof = ciMaterialRetirement(ask);
    if (proof?.workItemRevision !== item.revision || !isDeepStrictEqual(proof.readBinding, binding)) continue;
    const children = limitationChildren(state, item, ask);
    if (children === null || proof.childrenDigest !== childHistoryDigest(children)) continue;
    try { verifyPullRequestExecutionBinding(state, binding); return true; } catch { return false; }
  }
  return false;
}
