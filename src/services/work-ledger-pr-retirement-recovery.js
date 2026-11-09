import { currentWorkItemInputBinding, pullRequestHeadAdmission, pendingInternalReviewMatchesDiscovery } from "./work-ledger-pr-source.js";

const SETTLED_CHILD_STATUSES = new Set(["completed", "cancelled", "superseded"]);

export function sameHeadInternalReviewTakeoverRecoveryProof(state, root) {
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request" || root.source.scope.kind !== "internal_review" ||
      root.source.scope.active !== true || root.currentTarget?.id !== "pr-engineer" ||
      root.status !== "blocked" || root.statusReason !== "pr_source_cross_root_cutover_retired" ||
      root.source.pendingRevision !== null || root.source.activeRevision !== 1 || root.source.revisions.length !== 1 ||
      root.sourceQuarantine !== null || root.activeIntentId !== null || root.decisionContext !== null ||
      root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null) return null;
  if (state.items.some(item => item.itemId !== root.itemId && currentWorkItemInputBinding(item)?.rootItemId === root.itemId) ||
      state.outbox.some(entry => entry.itemId === root.itemId)) return null;
  const history = state.timeline.filter(entry => entry.itemId === root.itemId);
  const creation = history[0];
  if (creation?.type !== "pr_source_created" || creation.at !== root.createdAt ||
      creation.details.workKey !== root.source.workKey || creation.details.inputRevision !== 1 ||
      creation.details.sourceSequence !== root.source.current.sourceSequence || creation.details.headRevision !== 1 ||
      creation.details.headRefOid !== root.source.current.headRefOid || history.length % 2 !== 1) return null;
  for (let index = 1; index < history.length; index += 2) {
    const claimed = history[index], retry = history[index + 1];
    if (claimed.type !== "claimed" || claimed.details.inputDigest !== root.inputDigest ||
        retry.type !== "retry_scheduled" || retry.actorId !== claimed.actorId ||
        retry.details.fromStatus !== "working" || retry.details.code !== "ROLE_CONTEXT_TIMEOUT" ||
        retry.details.reason !== "system_maintenance_auto_retry") return null;
  }
  const restored = { ...root, status: "queued", statusReason: "pr_source_internal_review_takeover_recovered" };
  for (const candidate of state.items) {
    if (candidate.source?.kind !== "pull_request" || candidate.source.scope.kind !== "automatic" || candidate.source.scope.active !== true ||
        !["queued", "retry_wait"].includes(candidate.status) || candidate.source.pendingRevision !== null ||
        candidate.sourceQuarantine !== null || candidate.ownerId !== null || candidate.leaseId !== null ||
        candidate.leaseUntil !== null || candidate.activeIntentId !== null || candidate.decisionContext !== null ||
        !pendingInternalReviewMatchesDiscovery(restored, candidate.source.current.event)) continue;
    const participants = new Set(state.items.filter(item => {
      const binding = currentWorkItemInputBinding(item);
      return binding?.rootItemId === candidate.itemId && binding.headRefOid === root.source.current.headRefOid;
    }).map(item => item.itemId));
    if (state.items.some(item => participants.has(item.itemId) && item.itemId !== candidate.itemId && !SETTLED_CHILD_STATUSES.has(item.status)) ||
        state.outbox.some(entry => participants.has(entry.itemId) && ["pending", "dispatching"].includes(entry.status))) continue;
    const activation = state.timeline.findLast(entry => entry.itemId === candidate.itemId && entry.at === root.updatedAt &&
      ["pr_source_created", "pr_source_revised"].includes(entry.type) &&
      (entry.type === "pr_source_created" || entry.details.disposition === "accepted") &&
      entry.details.headRefOid === root.source.current.headRefOid &&
      entry.details.sourceSequence > root.source.current.sourceSequence &&
      candidate.source.bindings.some(binding => binding.sourceSequence === entry.details.sourceSequence &&
        binding.inputRevision === (entry.type === "pr_source_created" ? entry.details.inputRevision : entry.details.activeRevision)));
    if (!activation || Date.parse(history.at(-1).at) > Date.parse(activation.at)) continue;
    const trial = { ...state, items: state.items.map(item => item.itemId === root.itemId ? restored : item) };
    const admission = pullRequestHeadAdmission(trial, restored);
    if (admission.current && !admission.pending) return { timelineId: activation.timelineId,
      rootStateTimelineId: history.at(-1).timelineId, replacementRootItemId: candidate.itemId,
      reason: "pr_source_internal_review_takeover_recovered" };
  }
  return null;
}

function recoverableRootStateProof(state, root, activation) {
  const entry = state.timeline.findLast(event => event.itemId === root.itemId && event.sequence < activation.sequence &&
    !["pr_source_revised", "pr_source_ignored"].includes(event.type));
  if (!entry) return null;
  const status = {
    pr_source_created: "queued",
    claimed: "working",
    retry_scheduled: "retry_wait",
    transitioned: entry.details.toStatus,
    graph_parent_revised: entry.details.toStatus,
  }[entry.type];
  // Retirement erased the previous status. Require positive evidence that
  // this task was runnable, rather than silently undoing an owner pause.
  return ["queued", "working", "retry_wait"].includes(status) ? entry : null;
}

function inactiveMetadataActivationProof(state, root, candidate) {
  const source = candidate.source;
  if (source?.kind !== "pull_request" || source.scope.kind !== "automatic" || source.scope.active ||
      source.identity.subjectId !== root.source.identity.subjectId ||
      source.identity.repository !== root.source.identity.repository ||
      source.identity.pullRequestNumber !== root.source.identity.pullRequestNumber ||
      source.pendingRevision !== null || candidate.sourceQuarantine !== null ||
      source.current.event.eventType !== "pull_request.updated" ||
      source.current.headRefOid !== root.source.current.headRefOid || candidate.updatedAt !== root.updatedAt ||
      source.current.sourceSequence <= root.source.current.sourceSequence) return null;
  const exit = source.revisions.find(revision => revision.eventId === source.scope.lastLifecycleEventId);
  const exitBinding = source.bindings.find(binding => binding.inputRevision === exit?.revision);
  // The source was already revoked before the live task was admitted. A source
  // that legitimately took over and then left scope is deliberately excluded.
  if (!exitBinding || exitBinding.sourceSequence >= root.source.current.sourceSequence ||
      exit.revision >= source.activeRevision) return null;
  const recordedExit = exitBinding.scopeLifecycle === true || state.timeline.some(entry =>
    entry.itemId === candidate.itemId && entry.type === "pr_source_revised" &&
    entry.details.scopeActive === false && entry.details.activeRevision === exit.revision &&
    entry.details.sourceSequence === exitBinding.sourceSequence);
  if (!recordedExit) return null;
  return state.timeline.findLast(entry => entry.itemId === candidate.itemId &&
    entry.type === "pr_source_revised" && entry.at === root.updatedAt &&
    entry.details.disposition === "accepted" && entry.details.headAdvanced === true &&
    entry.details.pendingRevision === null && entry.details.activeRevision === source.activeRevision &&
    entry.details.sourceSequence === source.current.sourceSequence &&
    entry.details.headRefOid === root.source.current.headRefOid &&
    typeof entry.details.previousHeadRefOid === "string" &&
    entry.details.previousHeadRefOid !== entry.details.headRefOid) ?? null;
}

export function inactivePullRequestTakeoverRecoveryProof(state, root) {
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request" ||
      !["owner_requested", "internal_review"].includes(root.source.scope.kind) ||
      root.source.scope.active !== true || root.status !== "blocked" ||
      root.statusReason !== "pr_source_cross_root_cutover_retired" ||
      root.source.pendingRevision !== null || root.sourceQuarantine !== null ||
      root.activeIntentId !== null || root.decisionContext !== null ||
      root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null) return null;
  const admission = pullRequestHeadAdmission(state, root);
  if (!admission.current || admission.pending) return null;
  const participants = state.items.filter(item => currentWorkItemInputBinding(item)?.rootItemId === root.itemId);
  if (participants.some(item => item.itemId !== root.itemId && !SETTLED_CHILD_STATUSES.has(item.status))) return null;
  const participantIds = new Set(participants.map(item => item.itemId));
  if (state.outbox.some(entry => participantIds.has(entry.itemId) && ["pending", "dispatching"].includes(entry.status))) return null;
  for (const candidate of state.items) {
    const proof = inactiveMetadataActivationProof(state, root, candidate);
    const rootStateProof = proof === null ? null : recoverableRootStateProof(state, root, proof);
    if (rootStateProof !== null) return { timelineId: proof.timelineId,
      rootStateTimelineId: rootStateProof.timelineId, inactiveRootItemId: candidate.itemId };
  }
  return null;
}
