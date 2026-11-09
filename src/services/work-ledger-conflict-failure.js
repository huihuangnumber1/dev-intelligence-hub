import { isDeepStrictEqual } from "node:util";
import { currentWorkItemInputBinding } from "./work-ledger-pr-source.js";

// Only this exact failed dispatch ends before any bound downstream proposal.
// The projection is diagnostic evidence, never execution authorization.
export function unstartedConflictDispatchFailure(item, outboxes) {
  if (item?.status !== "blocked" || item.statusReason !== "intent_failed" || item.decisionContext !== null) return null;
  const binding = currentWorkItemInputBinding(item);
  if (binding === null) return null;
  const matches = [...outboxes].filter(outbox => outbox.itemId === item.itemId &&
    outbox.status === "failed" && outbox.updatedAt === item.updatedAt &&
    outbox.intent?.type === "propose_code_action" && outbox.intent.operation === "modify" &&
    outbox.requestedBy?.roleId === "developer" && outbox.inputDigest === item.inputDigest &&
    isDeepStrictEqual(outbox.sourceBinding, binding) && outbox.dispatchBinding === null &&
    outbox.outcome?.status === "failed" &&
    isDeepStrictEqual(outbox.outcome.details, { code: "conflict-source-stale" }));
  return matches.length === 1
    ? { intentId: matches[0].intentId, code: "conflict-source-stale", downstreamCreated: false } : null;
}
