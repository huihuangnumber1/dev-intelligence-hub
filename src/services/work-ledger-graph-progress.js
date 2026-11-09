import { ledgerDigest } from './work-ledger-values.js';
import { isDeepStrictEqual } from 'node:util';
import { currentWorkItemEvent, currentWorkItemInputBinding, currentWorkItemExecutionBinding, verifyPullRequestExecutionBinding } from './work-ledger-pr-source.js';
import { isParentCoordinationReturn } from './work-ledger-graph-responsibility.js';

// A retained failure makes coordination ready; it never grants a child retry.
export function recordedFailureParentIds(state, failures) {
  if (failures.size === 0) return new Set();
  const items = new Map(state.items.map(item => [item.itemId, item]));
  const parents = new Set();
  for (const id of failures.keys()) {
    const child = items.get(id), parent = items.get(child?.graph?.parentItemId);
    if (parents.has(parent?.itemId)) continue;
    if (!parent || parent.graph?.parentItemId !== null || parent.currentTarget?.type !== 'role' || parent.currentTarget.id !== 'orchestrator' ||
        !['queued', 'retry_wait'].includes(parent.status) || parent.activeIntentId !== null ||
        parent.ownerId !== null || parent.leaseId !== null || parent.leaseUntil !== null || parent.sourceQuarantine !== null) continue;
    if (parent.kind === 'assignment') {
      const failure = failures.get(id), event = currentWorkItemEvent(parent);
      if (failure.code !== 'delivery-evidence-incompatible' || failure.operation !== 'inspect' ||
          event?.source?.provider !== 'github' || !event.eventType?.startsWith('issue.') || event.payload?.state !== 'open' ||
          currentWorkItemInputBinding(parent) !== null || currentWorkItemInputBinding(child) !== null ||
          !isDeepStrictEqual(event, currentWorkItemEvent(child)) || parent.decisionContext?.outcome === 'unknown' ||
          (state.outbox ?? []).some(box => [parent.itemId, child.itemId].includes(box.itemId) &&
            ['pending', 'dispatching', 'unknown'].includes(box.status))) continue;
      parents.add(parent.itemId);
      continue;
    }
    if (parent.kind !== 'source_root') continue;
    const binding = currentWorkItemExecutionBinding(parent);
    if (!binding || !isDeepStrictEqual(binding, currentWorkItemExecutionBinding(child))) continue;
    try { verifyPullRequestExecutionBinding(state, binding); } catch { continue; }
    parents.add(parent.itemId);
  }
  return parents;
}

// Related-task progress is a scheduling observation, not the root's execution
// identity. Unrelated graph activity must not renew a stalled root's budget.
export function indexWorkLedgerGraphProgress(items) {
  const byId = new Map(items.map(item => [item.itemId, item]));
  const childrenByParent = new Map();
  for (const item of items) {
    const parentId = item.graph?.parentItemId;
    if (typeof parentId !== 'string') continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(item);
    childrenByParent.set(parentId, children);
  }
  // Nested handbacks can change without revising a direct ancestor. Observe
  // only those returns within their structural root, independently of the
  // source/idle proof that decides whether coordination may run.
  const nestedReturnsByRoot = new Map();
  for (const item of items) {
    if (!isParentCoordinationReturn(item)) continue;
    let root = byId.get(item.graph.parentItemId);
    const seen = new Set([item.itemId]);
    while (root?.graph?.parentItemId != null && !seen.has(root.itemId)) {
      seen.add(root.itemId);
      root = byId.get(root.graph.parentItemId);
    }
    if (!root || seen.has(root.itemId) || root.graph?.parentItemId !== null ||
        root.itemId === item.graph.parentItemId || root.currentTarget?.type !== 'role' ||
        root.currentTarget.id !== 'orchestrator') continue;
    const returned = nestedReturnsByRoot.get(root.itemId) ?? [];
    returned.push(item);
    nestedReturnsByRoot.set(root.itemId, returned);
  }
  const relatedItems = item => {
    const ids = new Set([...(childrenByParent.get(item.itemId) ?? []).map(child => child.itemId),
      ...(item.graph?.dependsOnItemIds ?? []), ...(nestedReturnsByRoot.get(item.itemId) ?? []).map(child => child.itemId)]);
    return [...ids].map(id => byId.get(id)).filter(Boolean);
  };
  const summarize = id => {
    const item = byId.get(id);
    return { itemId: id, revision: item?.revision ?? null, status: item?.status ?? null };
  };
  const graphProgressDigest = item => {
    const children = childrenByParent.get(item.itemId) ?? [];
    const dependencies = item.graph?.dependsOnItemIds ?? [];
    const nestedReturns = nestedReturnsByRoot.get(item.itemId) ?? [];
    if (children.length === 0 && dependencies.length === 0) return null;
    return ledgerDigest({ domain: 'work-ledger-related-progress/v1', itemId: item.itemId,
      children: children.map(child => child.itemId).sort().map(summarize),
      dependencies: [...dependencies].sort().map(summarize),
      // Leave the existing digest exactly intact for roots without newly
      // relevant nested returns; unrelated work cannot reset their budgets.
      ...(nestedReturns.length === 0 ? {} : { coordinationReturns: nestedReturns.map(child => child.itemId).sort().map(summarize) }) }, {
      // This trusted projection has five container/scalar entries plus four per
      // related task. Keep its budget bounded by the already-validated ledger.
      maximumEntries: 5 + 4 * (children.length + dependencies.length) + (nestedReturns.length === 0 ? 0 : 1 + 4 * nestedReturns.length),
    });
  };
  return { byId, childrenByParent, graphProgressDigest, relatedItems };
}
