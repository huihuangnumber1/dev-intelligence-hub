import { ledgerDigest } from "./work-ledger-values.js";
import { pullRequestTrustedPredecessor, trustedPrRoleForEvent } from "./work-ledger-pr-source.js";

// A host proof transfers one existing automatic responsibility. Ordinary
// metadata, owner requests and whole-discovery scope exits keep their contracts.
export function automaticRoleHandoffCandidate(state, event) {
  if (event.source.provider !== "github" || event.payload.relation !== "authored" ||
      trustedPrRoleForEvent(event)?.roleId !== "tester" || event.payload.state !== "open" ||
      event.payload.isDraft === true || event.payload.gitTargetAvailable !== true) return null;
  const subjectRoots = state.items.filter(item => item.kind === "source_root" &&
    item.source?.kind === "pull_request" && item.source.identity.subjectId === event.subject.id &&
    item.source.identity.repository === event.subject.repository && item.source.identity.pullRequestNumber === event.subject.number);
  const roots = subjectRoots.filter(item => item.source.identity.provider === event.source.provider &&
    item.source.identity.scopeId === event.source.scopeId);
  const target = roots.find(item => item.source.scope.kind === "automatic" &&
    item.currentTarget.id === "tester" && item.source.scope.active === false &&
    item.status === "blocked" && item.statusReason === "pr_source_left_scope");
  if (!target || target.source.pendingRevision !== null || target.sourceQuarantine !== null ||
      target.activeIntentId !== null || target.ownerId !== null || target.leaseId !== null ||
      target.source.current.headRefOid !== event.payload.headRefOid) return null;
  const authority = pullRequestTrustedPredecessor(state, target);
  const predecessor = roots.find(item => item.itemId === authority?.canonicalRootItemId);
  if (!predecessor || authority.authorityFenced || authority.headRefOid !== event.payload.headRefOid ||
      predecessor.source.scope.kind !== "automatic" || predecessor.source.scope.active !== true ||
      predecessor.currentTarget.id !== "developer" || predecessor.sourceQuarantine !== null ||
      !["queued", "retry_wait", "waiting_condition"].includes(predecessor.status) ||
      predecessor.source.pendingRevision !== null || predecessor.activeIntentId !== null ||
      predecessor.ownerId !== null || predecessor.leaseId !== null ||
      /owner|reject|cancel|pause/.test(predecessor.statusReason ?? "")) return null;
  const targetGit = event.payload.gitTarget;
  for (const item of [predecessor, target]) {
    const git = item.source.current.event.payload.gitTarget;
    if (!git || ["sourceAccountId", "baseRepository", "baseRefName", "headRepository", "headRefName"]
      .some(key => git[key] !== targetGit?.[key])) return null;
  }
  const oldHead = predecessor.source.current.headRefOid;
  if (oldHead !== event.payload.headRefOid && !target.source.revisions.some(revision =>
    revision.disposition === "accepted" && revision.headRefOid === event.payload.headRefOid &&
    revision.previousHeadRefOid === oldHead)) return null;
  const { roleHandoffProof: _proof, ...payload } = event.payload;
  const proofDigest = ledgerDigest({ roots: subjectRoots.map(item => ({ itemId: item.itemId,
    revision: item.revision, source: item.source, status: item.status, statusReason: item.statusReason,
    sourceQuarantine: item.sourceQuarantine })).sort((a, b) => a.itemId.localeCompare(b.itemId, "en")),
    source: event.source, subject: event.subject, payload });
  return { predecessorItemId: predecessor.itemId, targetItemId: target.itemId, proofDigest };
}
