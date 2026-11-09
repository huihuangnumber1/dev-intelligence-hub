import { isDeepStrictEqual } from "node:util";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";
import { unstartedDeliveryContractFailure, unstartedCodePolicyBindingFailure, recordedDeliveryFailure,
  normalizeRecordedDeliveryFailure } from "./work-ledger-delivery-failure.js";
import { deliveryAcceptanceContractDigest } from "../domain/delivery-evidence-contract.js";
import { normalizeWorkResultAttestation } from "./work-ledger-result-attestation.js";
import { currentWorkItemEvent, currentWorkItemInputBinding, currentWorkItemExecutionBinding,
  verifyPullRequestExecutionBinding } from "./work-ledger-pr-source.js";
import { hasExactLedgerKeys, ledgerDigest } from "./work-ledger-values.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import { reviewDiagnosticState, normalizeRecoveredReviewFailure, recoveredReviewFailureMatches, recoverReviewDiagnostic } from "./work-ledger-review-diagnostic.js";

export const HOST_CONTEXT_RECOVERED = "host_context_facts_recovered";

// Restricted adapter for the old untyped host-status question. Product decisions
// and renewed authorization questions must never be inferred from a choice label.
function requestedChild(intent) {
  const delivery = requestedDeliveryChild(intent);
  if (delivery) return delivery;
  if (intent?.type !== "ask_user" || intent.summary !== "补齐未知阻塞的宿主上下文" ||
      !isDeepStrictEqual(intent.choices, [{ id: "supply-blocking-context", label: "补齐阻塞上下文",
        description: "提供宿主记录的阻塞原因和验证提案状态，保留原修复包及任务历史，再按证据继续。" }])) return null;
  const match = /^子任务 revision ([1-9][0-9]*) 的 ledgerStatus 为 blocked，但 blockingCondition 为 null，且没有提案处理结果、失败码或活动执行信息。原交付已退回，当前没有待验收交付。现有只读工具未提供任务详情查询能力，无法可靠确定恢复路径；不能猜测基础设施故障、取消已有修复任务、重复修改或宣告 CI 修复成功。$/.exec(intent.reason);
  const question = /^请补充开发子任务 (work-item-[a-f0-9]{64}) 的宿主阻塞原因及最新补充验证提案处理结果引用，注明是否存在活动执行；如有失败，请提供错误码和恢复状态。本次仅补齐缺失状态，不请求重新授权常规修复或发布。$/.exec(intent.question);
  return match && question && Number.isSafeInteger(Number(match[1])) ? { itemId: question[1], revision: Number(match[1]) } : null;
}

function requestedDeliveryChild(intent) {
  if (intent?.type !== "ask_user" || intent.summary !== "请求补充阻塞证据，不请求重复修复授权。" ||
      !isDeepStrictEqual(intent.choices, [{ id: "provide-blocker-evidence", label: "补充阻塞诊断",
        description: "提供宿主失败码、对应意图处理结果或可读取的诊断引用；保留原任务与历史，再据证据决定恢复。" }])) return null;
  const reason = /^多个调度周期中，开发子任务始终停留在 revision ([1-9][0-9]*)、blocked、blockingCondition=null；必需总结未登记且无待验收交付。现有输入及可用只读工具不能确定阻塞原因，无法安全选择恢复措施。需补充宿主诊断信息，不能盲目取消、替换或重复执行；已验收验证报告不代表 QuickTest.cn 已解决，根任务保持未完成。$/.exec(intent.reason);
  const question = /^请补充开发子任务 (work-item-[a-f0-9]{64}) 在 revision ([1-9][0-9]*) 被标记为 blocked 的宿主原因或失败记录，尤其是 ci-resolution-summary 未登记的处理结果。这是缺失诊断信息请求，不是检查、修改或更新 PR 的授权请求。$/.exec(intent.question);
  return reason && question && reason[1] === question[2] && Number.isSafeInteger(Number(reason[1]))
    ? { itemId: question[1], revision: Number(reason[1]), deliveryContext: true } : null;
}

function requestedReviewChild(intent) {
  if (intent?.type !== "ask_user" || intent.summary !== "升级复审提案失效的具体诊断缺口" ||
      intent.reason !== "直属子任务为 blocked/proposal-stale，github-rereview 尚无交付。当前材料的 Head/Base 未变，也未提供提案失效的具体校验原因，无法安全确定恢复方式；已有 APPROVED Review 不能替代本契约权威交付，根任务不能完成。" ||
      !isDeepStrictEqual(intent.choices, [
        { id: "provide-stale-diagnostics", label: "补充宿主失效诊断", description: "提供失效校验项与当前有效绑定，保留原子任务及尝试历史，再确定恢复方式。" },
        { id: "suspend-intentionally", label: "有意暂缓本轮工作", description: "仅在确需停止推进时明确暂缓；不视为 Review 已交付或根任务已完成。" }])) return null;
  const match = /^请补充子任务 (work-item-[a-f0-9]{64}) 的 proposal-stale 宿主校验原因及当前有效绑定，以确定原任务的恢复路径。这是缺失的执行诊断，不是请求再次授权常规 Review；目前没有本轮发布成功的证据。$/.exec(intent.question);
  return match ? { itemId: match[1], reviewContext: true } : null;
}

function settledCodeProposalResult(box) {
  if (box.intent.type !== "propose_code_action" || box.dispatchBinding === null) return null;
  try {
    const result = normalizeWorkResultAttestation(box.outcome?.details?.resultAttestation);
    return result.kind === "proposal_result" && result.intentId === box.intentId && result.payload.outcome !== "unknown" &&
      result.payload.proposalId === box.outcome.details.downstreamRef && result.payload.proposalContentDigest === box.outcome.details.proposalDigest ? result : null;
  } catch { return null; }
}

export function hostContextRetirement(outbox) {
  const proof = outbox?.outcome?.details?.hostContextRetirement;
  const delivery = normalizeRecordedDeliveryFailure(proof?.failure, proof?.childRevision);
  const review = normalizeRecoveredReviewFailure(proof?.failure, proof?.childRevision);
  if (!hasExactLedgerKeys(proof, ["schemaVersion", "intentId", "questionRef", "workItemRevision", "reason",
    "inputBinding", "childId", "childRevision", "childInputBinding", "failure", "recoveryKey", "digest"]) ||
      proof.schemaVersion !== 1 || proof.reason !== HOST_CONTEXT_RECOVERED || proof.intentId !== outbox.intentId ||
      proof.questionRef !== outbox.outcome.details.questionRef || outbox.status !== "delivered" || outbox.outcome.status !== "delivered" ||
      !Number.isSafeInteger(proof.workItemRevision) || proof.workItemRevision < 1 ||
      !(review || (delivery?.code === "ORCHESTRATOR_EVIDENCE_REJECTED") ||
        (["delivery-evidence-incompatible", "policy-binding-invalid"].includes(proof.failure?.code) &&
          proof.failure.stage === undefined && proof.failure.downstreamCreated === false)) ||
      !isDeepStrictEqual(proof.childInputBinding, outbox.sourceBinding)) return null;
  const { digest, ...core } = proof;
  const pointer = proof.inputBinding && Object.fromEntries(Object.keys(outbox.sourceBinding ?? {}).map(key => [key, proof.inputBinding[key]]));
  return ledgerDigest(core) === digest && isDeepStrictEqual(pointer, outbox.sourceBinding) ? proof : null;
}

export function hostContextRecoveryCandidate(state, item) {
  if (item?.kind === "graph_task") return childPolicyContextCandidate(state, item);
  if (state.attentionCursor < state.attentionHighWatermark || item?.kind !== "source_root" || item.status !== "waiting_user" ||
      item.currentTarget?.id !== "orchestrator" || item.sourceQuarantine !== null || item.ownerId !== null ||
      item.leaseId !== null || item.leaseUntil !== null) return null;
  const event = currentWorkItemEvent(item);
  const reviewEvent = event?.eventType === "pull_request.owner_requested" && event.source.provider === "local-owner" &&
      item.source?.scope.kind === "owner_requested" && event.payload.workType === "general" && event.payload.suggestedCapability === "pr-review" &&
      ["review", "rereview"].includes(event.payload.nextAction) && event.payload.expectedHeadRefOid === event.payload.headRefOid;
  const ciEvent = isOwnerRequestedCiRepairEvent(event);
  if (!reviewEvent && !ciEvent) return null;
  const ask = state.outbox.find(entry => entry.intentId === item.activeIntentId);
  const wanted = (reviewEvent ? requestedReviewChild(ask?.intent) : null) ?? (ciEvent ? requestedChild(ask?.intent) : null);
  if (!wanted || ask.itemId !== item.itemId || ask.inputDigest !== item.inputDigest || ask.requestedBy.roleId !== "orchestrator" ||
      ask.requestedBy.workerId !== "employee-orchestrator" || ask.status !== "delivered" || ask.outcome?.status !== "delivered" ||
      ask.outcome.details?.resultAttestation || !/^attention-[a-f0-9]{64}$/.test(ask.outcome.details?.questionRef ?? "") ||
      ask.dispatchBinding?.boundIntent?.kind !== "attention_request" ||
      !isDeepStrictEqual(ask.sourceBinding, currentWorkItemInputBinding(item))) return null;
  const child = state.items.find(entry => entry.itemId === wanted.itemId);
  if (!child || (!wanted.reviewContext && child.revision !== wanted.revision) || child.graph?.parentItemId !== item.itemId ||
      child.leaseUntil !== null ||
      !isDeepStrictEqual(currentWorkItemInputBinding(child), currentWorkItemInputBinding(item))) return null;
  if (state.outbox.some(entry => [item.itemId, child.itemId].includes(entry.itemId) &&
      ["pending", "dispatching", "unknown"].includes(entry.status))) return null;
  const failure = wanted.reviewContext ? reviewDiagnosticState(state, child) : wanted.deliveryContext
    ? recordedDeliveryFailure(child, state.timeline.findLast(entry => entry.itemId === child.itemId)) : unstartedDeliveryContractFailure(child, state.outbox);
  if (wanted.deliveryContext && (child.currentTarget?.id !== "developer" || failure?.code !== "ORCHESTRATOR_EVIDENCE_REJECTED" ||
      child.graph.deliveries.at(-1)?.status === "submitted" ||
      !child.graph.deliveries.some(entry => entry.status === "accepted" && child.graph.acceptanceContracts
        .find(contract => contract.revision === entry.contractRevision)?.expectedDeliverables
        .find(expected => expected.deliverableId === entry.deliverableId)?.kind === "test-report") ||
      state.outbox.some(box => [item.itemId, child.itemId].includes(box.itemId) && box.intent.type !== "ask_user" &&
        settledCodeProposalResult(box)?.payload.outcome !== "succeeded"))) return null;
  const inputBinding = currentWorkItemExecutionBinding(item);
  if (!failure || !inputBinding) return null;
  try { verifyPullRequestExecutionBinding(state, inputBinding); } catch { return null; }
  // Outboxes are retained with their root (capacity rejects instead of evicting
  // active history). Exclude question/failed-intent IDs from the durable one-shot key.
  const { intentId: _failedIntentId, ...retainedCause } = failure;
  const cause = wanted.reviewContext ? { code: failure.code, stage: failure.stage, proposalId: failure.proposalId, resultDigest: failure.resultDigest,
    contractDigest: deliveryAcceptanceContractDigest(child.graph.acceptanceContracts.at(-1)) } : wanted.deliveryContext ? { code: failure.code, stage: failure.stage,
    contractDigest: deliveryAcceptanceContractDigest(child.graph.acceptanceContracts.at(-1)) } : retainedCause;
  const recoveryKey = ledgerDigest({ rootItemId: item.itemId, inputBinding, childId: child.itemId,
    childInputBinding: currentWorkItemInputBinding(child), cause });
  if (state.outbox.some(entry => hostContextRetirement(entry)?.recoveryKey === recoveryKey)) return null;
  return { item, child, ask, inputBinding, failure, recoveryKey,
    ...(wanted.deliveryContext || wanted.reviewContext ? { guardedChildItemId: child.itemId } : {}),
    ...(wanted.reviewContext ? { reviewDiagnostics: true, confirmationIds: failure.confirmationIds } : {}),
    snapshotDigest: canonicalJsonDigest({ item, child, ask, failure,
      ...(wanted.reviewContext ? { boxes: state.outbox.filter(box => [item.itemId, child.itemId].includes(box.itemId)) } : {}) }) };
}

function childPolicyContextCandidate(state, item) {
  if (state.attentionCursor < state.attentionHighWatermark || item.status !== "waiting_user" ||
      item.currentTarget?.id !== "developer" || item.sourceQuarantine !== null || item.ownerId !== null ||
      item.leaseId !== null || item.leaseUntil !== null || item.graph.deliveries.length !== 0) return null;
  const root = state.items.find(entry => entry.itemId === item.graph.parentItemId);
  if (root?.kind !== "source_root" || root.currentTarget?.id !== "orchestrator" || root.status !== "queued" ||
      root.sourceQuarantine !== null || root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null ||
      !isOwnerRequestedCiRepairEvent(currentWorkItemEvent(root)) ||
      !isDeepStrictEqual(currentWorkItemInputBinding(item), currentWorkItemInputBinding(root))) return null;
  const ask = state.outbox.find(entry => entry.intentId === item.activeIntentId), intent = ask?.intent;
  const expectedQuestion = `#${currentWorkItemEvent(item).subject.number} 的续接开发任务仍被标记为 blocked，但没有原因。请补充本次派发的失败代码、关联提案或作业标识、是否创建下游及当前恢复结论；若这些信息暂不可取得，请明确是否有意暂缓该子任务。`;
  if (intent?.type !== "ask_user" || intent.summary !== "升级续接任务缺失的阻塞诊断" ||
      intent.reason !== "续接任务仍为 blocked，但 blockingCondition=null，未提供本次 dispatchFailure、下游创建状态或恢复结论。现有证据不足以安全选择恢复动作；旧任务的契约不兼容不能解释本次阻塞。此次升级只索取缺失的运行事实，不请求常规修复授权，不取消既有任务或改写契约。" ||
      intent.question !== expectedQuestion || !isDeepStrictEqual(intent.choices, [
        { id: "provide-blocking-evidence", label: "补充阻塞诊断", description: "提供宿主记录中的失败及恢复事实，以便选择匹配的恢复方式；继续保留原任务、契约和失败历史。" },
        { id: "explicitly-defer-child", label: "明确暂缓子任务", description: "若暂时无法取得诊断且有意停止推进，明确暂缓范围；不表示代码已修复或 CI 已通过。" }]) ||
      ask.itemId !== item.itemId || ask.inputDigest !== item.inputDigest || ask.requestedBy.roleId !== "orchestrator" ||
      ask.requestedBy.workerId !== "employee-orchestrator" || ask.status !== "delivered" || ask.outcome?.status !== "delivered" ||
      ask.outcome.details?.resultAttestation || !/^attention-[a-f0-9]{64}$/.test(ask.outcome.details?.questionRef ?? "") ||
      ask.dispatchBinding?.boundIntent?.kind !== "attention_request" ||
      !isDeepStrictEqual(ask.sourceBinding, currentWorkItemInputBinding(item))) return null;
  const boxes = state.outbox.filter(entry => entry.itemId === item.itemId);
  if (state.outbox.some(entry => [root.itemId, item.itemId].includes(entry.itemId) &&
      ["pending", "dispatching", "unknown"].includes(entry.status))) return null;
  const staged = state.timeline.find(entry => entry.itemId === item.itemId && entry.type === "intent_staged" &&
    entry.details.intentId === ask.intentId && entry.details.workItemRevision === item.revision - 1);
  const previous = staged && state.timeline.findLast(entry => entry.itemId === item.itemId && entry.sequence < staged.sequence);
  const failed = boxes.find(entry => entry.intentId === previous?.details?.intentId);
  if (previous?.type !== "intent_acknowledged" || previous.details.outcome !== "failed" ||
      previous.details.nextStatus !== "blocked" || previous.at !== failed?.updatedAt) return null;
  const child = { ...item, revision: item.revision - 2, status: "blocked", statusReason: "intent_failed",
    activeIntentId: null, updatedAt: failed.updatedAt };
  const failure = unstartedCodePolicyBindingFailure(child, boxes);
  if (!failure || failure.intentId !== failed.intentId || failed.intent.operation !== "modify") return null;
  for (const box of boxes) {
    if (box.intent.type !== "propose_code_action" || box.dispatchBinding === null) continue;
    if (!settledCodeProposalResult(box)) return null;
  }
  const inputBinding = currentWorkItemExecutionBinding(item);
  if (!inputBinding) return null;
  try { verifyPullRequestExecutionBinding(state, inputBinding); } catch { return null; }
  const { intentId: _failedIntentId, ...cause } = failure;
  const recoveryKey = ledgerDigest({ rootItemId: root.itemId, inputBinding, childId: item.itemId, cause,
    contractDigest: deliveryAcceptanceContractDigest(item.graph.acceptanceContracts.at(-1)) });
  if (state.outbox.some(entry => hostContextRetirement(entry)?.recoveryKey === recoveryKey)) return null;
  return { item, child, ask, inputBinding, failure, recoveryKey, decisionOwner: root, failed,
    snapshotDigest: ledgerDigest({ item, root, ask, failed, failure }) };
}

// A blocked specialist still prevents an ordinary claim. The completed host
// recovery instead needs the configured root orchestrator's unleased decision.
export function hasPendingHostContextRecovery(state, item) {
  if (item?.kind !== "source_root" || item.currentTarget?.id !== "orchestrator" ||
      !["retry_wait", "queued"].includes(item.status) || item.statusReason !== HOST_CONTEXT_RECOVERED ||
      item.activeIntentId !== null || item.sourceQuarantine !== null || item.ownerId !== null ||
      item.leaseId !== null || item.leaseUntil !== null) return false;
  const binding = currentWorkItemExecutionBinding(item);
  if (!binding) return false;
  let proof = null;
  for (const outbox of state.outbox) {
    if (outbox.itemId !== item.itemId) continue;
    const stored = hostContextRetirement(outbox);
    if (stored?.workItemRevision === item.revision && isDeepStrictEqual(stored.inputBinding, binding)) {
      proof = stored;
      break;
    }
  }
  if (!proof) return false;
  const child = state.items.find(entry => entry.itemId === proof.childId);
  if (child?.revision !== proof.childRevision || child.graph?.parentItemId !== item.itemId ||
      !isDeepStrictEqual(currentWorkItemInputBinding(child), proof.childInputBinding) ||
      !(proof.failure.stage === "review" ? recoveredReviewFailureMatches(state, child, proof.failure) && item.decisionContext?.contentDigest === proof.failure.diagnosticDigest
        : isDeepStrictEqual(proof.failure.stage === "delivery"
        ? recordedDeliveryFailure(child, state.timeline.findLast(entry => entry.itemId === child.itemId))
        : unstartedDeliveryContractFailure(child, state.outbox), proof.failure))) return false;
  try { verifyPullRequestExecutionBinding(state, binding); } catch { return false; }
  return true;
}

function stoppedDecisionRun(run, target, roleId, revision, now) {
  return run?.kind === "work-item" && run.taskId === target && run.roleId === roleId && run.active === false &&
    run.mode === "active" && run.pendingCommand === null && run.stopUnconfirmed !== true && run.phase === "completed" &&
    run.receipt?.kind === "work-item" && run.receipt.taskId === target && run.receipt.roleId === roleId &&
    run.receipt.taskRevision === revision && run.receipt.phase === "completed" && run.receipt.stopConfirmed === true &&
    [run.receipt.registeredAt, run.receipt.modelStartedAt, run.receipt.finishedAt].every(value => Number.isFinite(Date.parse(value))) &&
    Date.parse(run.receipt.registeredAt) <= Date.parse(run.receipt.modelStartedAt) &&
    Date.parse(run.receipt.modelStartedAt) <= Date.parse(run.receipt.finishedAt) && Date.parse(run.receipt.finishedAt) <= Date.parse(now);
}

function hasStoppedDecision(candidate, control, now) {
  if (candidate.decisionOwner) {
    const { item, decisionOwner: root, failed, inputBinding } = candidate;
    return typeof control?.actorAccountId === "string" && control.actorAccountId.toLowerCase() === inputBinding.gitTarget.sourceAccountId.toLowerCase() &&
      stoppedDecisionRun(control.run, root.itemId, "orchestrator", root.revision, now) &&
      stoppedDecisionRun(control.childRun, item.itemId, "developer", item.revision - 4, now) &&
      Date.parse(control.childRun.receipt.finishedAt) <= Date.parse(failed.createdAt);
  }
  const { item, ask, inputBinding } = candidate;
  const run = control?.run, receipt = run?.receipt;
  // The decision's revision is followed by exactly two parent revisions:
  // staging its ask_user escalation and acknowledging the question's delivery.
  const rootStopped = typeof control?.actorAccountId === "string" && control.actorAccountId.toLowerCase() === inputBinding.gitTarget.sourceAccountId.toLowerCase() &&
    run?.kind === "work-item" && run.taskId === item.itemId &&
    run.roleId === "orchestrator" && run.active === false && run.mode === "active" && run.pendingCommand === null &&
    run.stopUnconfirmed !== true && run.phase === "completed" && receipt?.kind === "work-item" && receipt.taskId === item.itemId &&
    receipt.roleId === "orchestrator" && receipt.phase === "completed" && receipt.stopConfirmed === true &&
    receipt.taskRevision === item.revision - 2 &&
    [receipt.registeredAt, receipt.modelStartedAt, receipt.finishedAt, ask.createdAt, ask.updatedAt].every(value => Number.isFinite(Date.parse(value))) &&
    Date.parse(receipt.registeredAt) <= Date.parse(receipt.modelStartedAt) && Date.parse(receipt.modelStartedAt) <= Date.parse(receipt.finishedAt) &&
    Date.parse(receipt.finishedAt) <= Date.parse(ask.createdAt) && Date.parse(ask.createdAt) <= Date.parse(ask.updatedAt);
  return rootStopped && (!candidate.guardedChildItemId ||
    (stoppedDecisionRun(control.childRun, candidate.child.itemId, candidate.reviewDiagnostics ? "pr-engineer" : "developer",
      candidate.child.revision - (candidate.reviewDiagnostics ? 3 : 1), now) &&
      Date.parse(control.childRun.receipt.finishedAt) <= Date.parse(candidate.failure.recordedAt)));
}

export function planHostContextRecovery({ state, captured, control, clock }) {
  const candidate = hostContextRecoveryCandidate(state, state.items.find(item => item.itemId === captured.itemId));
  const now = clock();
  if (!candidate || candidate.snapshotDigest !== captured.snapshotDigest || !hasStoppedDecision(candidate, control, now)) {
    return { write: false, result: { retried: 0 } };
  }
  const { item, child, ask, inputBinding, recoveryKey } = candidate;
  let failure = candidate.failure;
  const recoveredReview = candidate.reviewDiagnostics ? recoverReviewDiagnostic(state, candidate, control, now) : null;
  if (candidate.reviewDiagnostics && !recoveredReview) return { write: false, result: { retried: 0 } };
  if (recoveredReview) failure = recoveredReview.failure;
  const readyForOrchestration = Boolean(candidate.guardedChildItemId);
  const updated = moveWorkItem(item, { status: readyForOrchestration ? "queued" : "retry_wait", now,
    ...(readyForOrchestration ? {} : { availableAt: now }),
    reason: HOST_CONTEXT_RECOVERED, activeIntentId: null,
    ...(recoveredReview ? { decisionContext: recoveredReview.decisionContext } : {}) });
  const core = { schemaVersion: 1, intentId: ask.intentId, questionRef: ask.outcome.details.questionRef,
    workItemRevision: updated.revision, reason: HOST_CONTEXT_RECOVERED, inputBinding,
    childId: child.itemId, childRevision: child.revision, childInputBinding: currentWorkItemInputBinding(child), failure, recoveryKey };
  return { patch: { items: state.items.map(entry => entry.itemId === item.itemId ? updated : entry),
    outbox: state.outbox.map(entry => entry.intentId === ask.intentId ? { ...ask, revision: ask.revision + 1, updatedAt: now,
      outcome: { ...ask.outcome, details: { ...ask.outcome.details, hostContextRetirement: { ...core, digest: ledgerDigest(core) } } } } : entry) },
    timelineEvents: [{ itemId: item.itemId, type: "intent_superseded", at: now, actorId: "work-ledger-system",
      details: { intentId: ask.intentId, reason: HOST_CONTEXT_RECOVERED, inputBinding, inputDigest: ask.inputDigest,
        workItemRevision: updated.revision, code: failure.code } },
    { itemId: item.itemId, type: readyForOrchestration ? "transitioned" : "retry_scheduled", at: now, actorId: "work-ledger-system",
      details: readyForOrchestration ? { fromStatus: item.status, toStatus: "queued", reason: HOST_CONTEXT_RECOVERED }
        : { fromStatus: item.status, availableAt: now, reason: HOST_CONTEXT_RECOVERED, restoredAttempts: 0 } }],
    result: { retried: 1 } };
}
