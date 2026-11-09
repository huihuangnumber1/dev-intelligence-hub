import { isDeepStrictEqual } from "node:util";
import { createProposalDeliveryEvidenceTarget, deliveryAcceptanceContractDigest,
  deliveryEvidenceKindsForProposal, DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE } from "../domain/delivery-evidence-contract.js";
import { currentWorkItemEvent, currentWorkItemInputBinding } from "./work-ledger-pr-source.js";
import { hasExactLedgerKeys } from "./work-ledger-values.js";

export function indexUnstartedCodeDispatchFailures(state) {
  const candidates = new Map(state.items.filter(item => item.kind === "graph_task" && item.status === "blocked" &&
    item.statusReason === "intent_failed" && item.leaseUntil === null).map(item => [item.itemId, item]));
  if (candidates.size === 0) return new Map();
  const boxesByItem = new Map();
  for (const box of state.outbox) {
    if (!candidates.has(box.itemId)) continue;
    const boxes = boxesByItem.get(box.itemId) ?? [];
    boxes.push(box);
    boxesByItem.set(box.itemId, boxes);
  }
  const failures = new Map();
  for (const [id, item] of candidates) {
    const boxes = boxesByItem.get(id) ?? [];
    if (boxes.some(box => ["pending", "dispatching", "unknown"].includes(box.status))) continue;
    const failure = unstartedDeliveryContractFailure(item, boxes) ?? unstartedCodePolicyBindingFailure(item, boxes);
    if (failure) failures.set(id, failure);
  }
  return failures;
}

export function normalizeRecordedDeliveryFailure(value, taskRevision) {
  if (!hasExactLedgerKeys(value, ["code", "stage", "taskRevision", "timelineId", "timelineDigest", "recordedAt"]) ||
      typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) || value.stage !== "delivery" ||
      !Number.isSafeInteger(taskRevision) || taskRevision < 1 || value.taskRevision !== taskRevision ||
      typeof value.timelineDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.timelineDigest) ||
      value.timelineId !== `work-timeline-${value.timelineDigest}` || typeof value.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) return null;
  return { code: value.code, stage: "delivery", taskRevision, timelineId: value.timelineId,
    timelineDigest: value.timelineDigest, recordedAt: value.recordedAt };
}

// Retained worker outcome only; it does not diagnose the product's CI failure
// or say that earlier proposals were never executed.
export function recordedDeliveryFailure(item, latest) {
  if (item?.kind !== "graph_task" || item.status !== "blocked" || item.statusReason !== "delivery_attempts_exhausted" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null ||
      item.sourceQuarantine !== null || latest?.itemId !== item.itemId || latest.type !== "transitioned" ||
      latest.at !== item.updatedAt || latest.details?.toStatus !== "blocked" || latest.details.reason !== "delivery_attempts_exhausted") return null;
  return normalizeRecordedDeliveryFailure({ code: latest.details.context?.code, stage: "delivery", taskRevision: item.revision,
    timelineId: latest.timelineId, timelineDigest: latest.contentDigest, recordedAt: latest.at }, item.revision);
}

// This explains a failed pre-binding decision to the parent. It does not
// authorize retry, alter the delivery contract, or replay a downstream action.
export function unstartedDeliveryContractFailure(item, outboxes) {
  if (item?.kind !== "graph_task" || item.status !== "blocked" || item.statusReason !== "intent_failed" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.sourceQuarantine !== null) return null;
  const binding = currentWorkItemInputBinding(item), contract = item.graph.acceptanceContracts.at(-1);
  const event = currentWorkItemEvent(item);
  // Issue inspections cannot produce an authoritative package. A confirmed
  // pre-binding rejection needs parent coordination just like a PR rejection;
  // it does not authorize an inspection retry or a different delivery contract.
  const issueInspection = binding === null && event?.source?.provider === "github" &&
    event.eventType?.startsWith("issue.") && event.payload?.state === "open" &&
    item.currentTarget?.type === "role" && item.currentTarget.id === "developer" &&
    item.leaseUntil === null && item.decisionContext?.outcome !== "unknown" && item.graph.deliveries.length === 0;
  if ((binding === null && !issueInspection) || !contract) return null;
  const matches = outboxes.filter(outbox => outbox.itemId === item.itemId && outbox.status === "failed" &&
    outbox.updatedAt === item.updatedAt && outbox.dispatchBinding === null && outbox.inputDigest === item.inputDigest &&
    isDeepStrictEqual(outbox.sourceBinding, binding) && outbox.requestedBy?.roleId === item.currentTarget.id &&
    outbox.intent?.type === "propose_code_action" &&
    (issueInspection ? outbox.intent.operation === "inspect" : ["verify", "modify"].includes(outbox.intent.operation)) &&
    outbox.intent.deliverableId === undefined && outbox.outcome?.status === "failed" &&
    ["policy-binding-invalid", "delivery-evidence-incompatible"].some(code => isDeepStrictEqual(outbox.outcome.details, { code })) &&
    Number.isFinite(Date.parse(contract.recordedAt)) && Date.parse(contract.recordedAt) <= Date.parse(outbox.createdAt));
  if (matches.length !== 1) return null;
  const [failed] = matches;
  const proposal = { kind: "code_action_proposal", operation: failed.intent.operation };
  try {
    createProposalDeliveryEvidenceTarget({ taskId: item.itemId, roleId: item.currentTarget.id, acceptanceContract: contract, proposal });
    return null;
  } catch (error) {
    if (error?.code !== DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE) return null;
  }
  return { intentId: failed.intentId, code: "delivery-evidence-incompatible", downstreamCreated: false,
    operation: failed.intent.operation, contractRevision: contract.revision, contractDigest: deliveryAcceptanceContractDigest(contract),
    compatibleEvidenceKinds: [...deliveryEvidenceKindsForProposal(proposal)],
    expectedDeliverables: contract.expectedDeliverables.map(({ deliverableId, kind }) => ({ deliverableId, kind })) };
}

// A compatible contract can still fail policy binding. Report only the retained
// host outcome; it does not establish the underlying cause or authorize replay.
export function unstartedCodePolicyBindingFailure(item, outboxes) {
  if (item?.kind !== "graph_task" || item.status !== "blocked" || item.statusReason !== "intent_failed" ||
      item.activeIntentId !== null || item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null ||
      item.sourceQuarantine !== null || item.currentTarget?.type !== "role") return null;
  const binding = currentWorkItemInputBinding(item), contract = item.graph.acceptanceContracts.at(-1);
  if (binding === null || !contract) return null;
  const matches = outboxes.filter(outbox => outbox.itemId === item.itemId && outbox.status === "failed" &&
    outbox.updatedAt === item.updatedAt && outbox.dispatchBinding === null && outbox.inputDigest === item.inputDigest &&
    isDeepStrictEqual(outbox.sourceBinding, binding) && outbox.requestedBy?.roleId === item.currentTarget.id &&
    outbox.intent?.type === "propose_code_action" && ["verify", "modify"].includes(outbox.intent.operation) &&
    outbox.outcome?.status === "failed" && isDeepStrictEqual(outbox.outcome.details, { code: "policy-binding-invalid" }) &&
    Number.isFinite(Date.parse(contract.recordedAt)) && Date.parse(contract.recordedAt) <= Date.parse(outbox.createdAt));
  if (matches.length !== 1) return null;
  const [failed] = matches;
  try {
    createProposalDeliveryEvidenceTarget({ taskId: item.itemId, roleId: item.currentTarget.id, acceptanceContract: contract,
      proposal: { kind: "code_action_proposal", operation: failed.intent.operation }, deliverableId: failed.intent.deliverableId });
  } catch { return null; }
  return { intentId: failed.intentId, code: "policy-binding-invalid", downstreamCreated: false };
}
