import { isDeepStrictEqual } from 'node:util';
import { currentWorkItemEvent, currentWorkItemInputBinding, currentWorkItemExecutionBinding,
  verifyPullRequestExecutionBinding } from './work-ledger-pr-source.js';

// A specialist's retained contract belongs to its graph. Targeting the
// orchestrator returns coordination to the root; it does not turn the child
// into an independently executable orchestrator.
export function isParentCoordinationReturn(item) {
  return item?.kind === 'graph_task' && typeof item.graph?.parentItemId === 'string' &&
    item.currentTarget?.type === 'role' && item.currentTarget.id === 'orchestrator';
}

function idleCoordinationItem(item, unsettledDispatches, { child = false } = {}) {
  return (child ? ['queued', 'retry_wait', 'blocked'] : ['queued', 'retry_wait']).includes(item?.status) && item.activeIntentId == null &&
    item.ownerId == null && item.leaseId == null && item.leaseUntil == null && item.sourceQuarantine == null &&
    item.decisionContext?.outcome !== 'unknown' && !unsettledDispatches.has(item.itemId) &&
    !item.graph.deliveries.some(delivery => delivery.status === 'submitted' &&
      !item.graph.deliveries.some(later => later.deliverableId === delivery.deliverableId && later.revision > delivery.revision));
}

// Ownership is structural; readiness additionally needs the current source and
// an idle root/child. Handoff prose and outbox proof never grant graph authority.
export function indexParentCoordinationReturns(state) {
  const items = new Map(state.items.map(item => [item.itemId, item]));
  const unsettledDispatches = new Set((state.outbox ?? [])
    .filter(box => ['pending', 'dispatching', 'unknown'].includes(box.status)).map(box => box.itemId));
  const returns = new Map();
  for (const child of state.items) {
    if (!isParentCoordinationReturn(child) || !idleCoordinationItem(child, unsettledDispatches, { child: true })) continue;
    const ancestry = new Set([child.itemId]);
    const lineage = [child];
    let root = items.get(child.graph.parentItemId);
    while (root && root.graph.parentItemId !== null && !ancestry.has(root.itemId)) {
      if (!idleCoordinationItem(root, unsettledDispatches, { child: true })) break;
      ancestry.add(root.itemId);
      lineage.push(root);
      root = items.get(root.graph.parentItemId);
    }
    if (!root || ancestry.has(root.itemId) || root.graph.parentItemId !== null ||
        root.currentTarget?.type !== 'role' || root.currentTarget.id !== 'orchestrator' || !idleCoordinationItem(root, unsettledDispatches)) continue;
    const rootBinding = currentWorkItemInputBinding(root);
    if (lineage.some(item => !isDeepStrictEqual(rootBinding, currentWorkItemInputBinding(item)))) continue;
    if (rootBinding !== null) {
      const binding = currentWorkItemExecutionBinding(root);
      if (!binding || lineage.some(item => !isDeepStrictEqual(binding, currentWorkItemExecutionBinding(item)))) continue;
      try { verifyPullRequestExecutionBinding(state, binding); } catch { continue; }
    } else if (lineage.some(item => !isDeepStrictEqual(currentWorkItemEvent(root), currentWorkItemEvent(item)))) continue;
    returns.set(child.itemId, root.itemId);
  }
  return returns;
}
