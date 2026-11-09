import { assertExpectedWorkGraphRevision } from "./work-ledger-graph-command-support.js";
import { hasCodeConfirmationSettlement } from "./work-ledger-code-confirmation-settlement.js";
import { hasReviewConfirmationSettlement } from "./work-ledger-review-confirmation-settlement.js";
import { requireWorkLedgerItem } from "./work-ledger-item-commands.js";
import {
  activatePendingPullRequestWorkSource,
  currentWorkItemInputBinding,
  matchesHistoricalPullRequestInputBinding,
  pullRequestHeadAdmission,
} from "./work-ledger-pr-source.js";
import { assertItemRevision } from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  ledgerDigest,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

const ROOT_READY_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "completed",
  "superseded",
]);
const CHILD_SUPERSEDABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "blocked",
]);
const CHILD_TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "superseded",
]);
const CROSS_ROOT_RETIRABLE_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "retry_wait",
  "blocked",
]);
const CROSS_ROOT_FENCE_DISPOSITIONS = new Set([
  "ignored_authority_fence",
  "ignored_legacy_downgrade",
  "ignored_unproven_head",
]);

export const CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON =
  "pr_source_cross_root_cutover_pending";
export const CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON =
  "pr_source_cross_root_cutover_blocker";
export const PR_SOURCE_AUTHORITY_FENCED_REASON =
  "pr_source_authority_fenced";

const pullRequestCutoverTimelineIndexes = new WeakMap();

function recordCutoverTimelineEvent(index, entry) {
  const state = pullRequestCutoverTimelineIndexes.get(index);
  if (state === undefined) return;
  const itemId =
    typeof entry?.itemId === "string" &&
      entry.type !== "pr_source_revised" && entry.type !== "pr_source_ignored"
      ? entry.itemId
      : null;
  const record = { entry, itemId };
  if (itemId !== null) state.latestByItemId.set(itemId, record);
  if (state.timelineLimit === null) return;
  state.window.push(record);
  while (state.window.length - state.windowStart > state.timelineLimit) {
    const expired = state.window[state.windowStart];
    state.windowStart += 1;
    if (
      expired.itemId !== null &&
      state.latestByItemId.get(expired.itemId) === expired
    ) {
      state.latestByItemId.delete(expired.itemId);
    }
  }
  if (
    state.windowStart >= 1024 &&
    state.windowStart * 2 >= state.window.length
  ) {
    state.window.splice(0, state.windowStart);
    state.windowStart = 0;
  }
}

export function createPullRequestCutoverTimelineIndex(
  timeline = [],
  timelineLimit = null,
) {
  if (!Array.isArray(timeline)) {
    throw new TypeError("pull request cutover timeline must be an array");
  }
  if (
    timelineLimit !== null &&
    (!Number.isSafeInteger(timelineLimit) || timelineLimit < 1)
  ) {
    throw new TypeError("pull request cutover timeline limit must be positive");
  }
  const index = Object.freeze({});
  pullRequestCutoverTimelineIndexes.set(index, {
    latestByItemId: new Map(),
    timelineLimit,
    window: timelineLimit === null ? null : [],
    windowStart: 0,
  });
  for (const entry of timeline) recordCutoverTimelineEvent(index, entry);
  return index;
}

export function appendPullRequestCutoverTimelineEvent(index, entry) {
  if (!pullRequestCutoverTimelineIndexes.has(index)) {
    throw new TypeError("pull request cutover timeline index is invalid");
  }
  recordCutoverTimelineEvent(index, entry);
}

function latestCutoverTimelineEvent(index, itemId) {
  return pullRequestCutoverTimelineIndexes.get(index)?.latestByItemId
    .get(itemId)?.entry ?? null;
}

export function arePullRequestCutoverProofsRetained({
  timeline,
  timelineLimit,
  appendedEventCount,
  proofs,
}) {
  if (!Array.isArray(timeline) || !Array.isArray(proofs)) {
    throw new TypeError("pull request cutover proof inputs must be arrays");
  }
  if (!Number.isSafeInteger(timelineLimit) || timelineLimit < 1) {
    throw new TypeError("pull request cutover timeline limit must be positive");
  }
  if (!Number.isSafeInteger(appendedEventCount) || appendedEventCount < 0) {
    throw new TypeError(
      "pull request cutover appended event count must be non-negative",
    );
  }
  const retainedStart = Math.max(
    0,
    timeline.length + appendedEventCount - timelineLimit,
  );
  return proofs.every((proof) => timeline.indexOf(proof) >= retainedStart);
}

function marker(reason, itemId) {
  return `${reason}:${itemId}`;
}

function markedItemId(statusReason, reason) {
  const prefix = `${reason}:`;
  if (typeof statusReason !== "string" || !statusReason.startsWith(prefix)) {
    return null;
  }
  const itemId = statusReason.slice(prefix.length);
  return itemId.length > 0 ? itemId : null;
}

export function crossRootPullRequestCutoverPendingReason(predecessorItemId) {
  return marker(
    CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
    normalizeItemId(predecessorItemId),
  );
}

export function crossRootPullRequestCutoverBlockerReason(pendingItemId) {
  return marker(
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON,
    normalizeItemId(pendingItemId),
  );
}

export function crossRootPullRequestCutoverPredecessorId(item) {
  return markedItemId(
    item?.statusReason,
    CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  );
}

export function crossRootPullRequestCutoverPendingId(item) {
  return markedItemId(
    item?.statusReason,
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_REASON,
  );
}

function invalid(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_INVALID",
    message,
  );
}

function conflict(message) {
  return workLedgerError(
    "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
    message,
    409,
  );
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function graphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expectedGraphRevision 无效");
  }
  return value;
}

function normalizeItemId(value) {
  try {
    return boundedLedgerString(value, "itemId", 192);
  } catch {
    throw invalid("itemId 无效");
  }
}

export function normalizePullRequestSourceReconciliationCommand(value) {
  if (
    !hasExactLedgerKeys(value, [
      "itemId",
      "expectedGraphRevision",
      "expectedRevision",
      "expectedPendingRevision",
    ])
  ) {
    throw invalid("PR 来源对账命令无效");
  }
  return {
    itemId: normalizeItemId(value.itemId),
    expectedGraphRevision: graphRevision(value.expectedGraphRevision),
    expectedRevision: positiveRevision(
      value.expectedRevision,
      "expectedRevision",
    ),
    expectedPendingRevision: positiveRevision(
      value.expectedPendingRevision,
      "expectedPendingRevision",
    ),
  };
}

function pendingHeadChanged(source) {
  if (source.pendingRevision === null) return false;
  const active = source.revisions[source.activeRevision - 1];
  const pending = source.revisions[source.pendingRevision - 1];
  return active.headRevision !== pending.headRevision;
}

export function isExpiredCodeConfirmation(decision) {
  const value = decision?.value;
  // Authorization changes can leave a running job quarantined. Only the
  // confirmation-only stale result proves that no code job was started.
  return decision?.outcome === "stale" &&
    value?.kind === "code_action_proposal" &&
    typeof value.downstreamRef === "string" &&
    value.downstreamRef.startsWith("confirmation-code-job-") &&
    Array.isArray(value.evidence) && value.evidence.length === 1 &&
    value.evidence[0] === `confirmation:${value.downstreamRef}`;
}

function isCodeProposalStoppedBeforeConfirmation(decision) {
  const value = decision?.value;
  // This handler result is emitted only before enqueueing a confirmation.
  // Other stale results can represent an executing or quarantined code job.
  return decision?.outcome === "stale" &&
    value?.kind === "code_action_proposal" &&
    value.downstreamRef === null &&
    typeof decision.referenceId === "string" &&
    Array.isArray(value.evidence) && value.evidence.length === 2 &&
    value.evidence[0] === "authorization_changed" &&
    value.evidence[1] === `proposal:${decision.referenceId}`;
}

function latestSettledProposalProof(item, timelineIndex, codeConfirmationSettled) {
  if (
    item.decisionContext?.source !== "proposal" ||
    (item.decisionContext?.outcome !== "rejected" &&
      !isExpiredCodeConfirmation(item.decisionContext) &&
      !isCodeProposalStoppedBeforeConfirmation(item.decisionContext) &&
      !codeConfirmationSettled) ||
    typeof item.decisionContext.contentDigest !== "string"
  ) {
    return null;
  }
  const entry = latestCutoverTimelineEvent(timelineIndex, item.itemId);
  return entry?.type === "proposal_result_applied" &&
    entry.details?.outcome === item.decisionContext.outcome &&
    entry.details?.decision?.contentDigest ===
      item.decisionContext.contentDigest &&
    Number.isSafeInteger(entry.details?.workItemRevision) &&
    entry.details.workItemRevision <= item.revision
    ? entry
    : null;
}

function definitiveBlockedSettlement(item, outboxById, timelineIndex, confirmationSettlements) {
  if (item.status !== "blocked" || item.activeIntentId !== null) return null;
  if ([
    "pr_source_left_scope",
    "pr_source_reentered_scope_without_route",
    "pr_source_cross_root_cutover_retired",
    PR_SOURCE_AUTHORITY_FENCED_REASON,
  ].includes(item.statusReason)) {
    return { proposalProof: null };
  }
  if (item.statusReason === "decision_attempts_exhausted") {
    return { proposalProof: null };
  }
  if (
    item.statusReason === "attention_rejected" &&
    item.decisionContext?.source === "attention" &&
    item.decisionContext?.outcome === "rejected"
  ) {
    return { proposalProof: null };
  }
  if (
    item.statusReason === "proposal_failed" &&
    item.decisionContext?.source === "proposal" &&
    item.decisionContext?.outcome === "failed"
  ) {
    return { proposalProof: null };
  }
  const confirmationSettled = hasCodeConfirmationSettlement(
    item, outboxById, confirmationSettlements?.get(item.itemId),
  ) || hasReviewConfirmationSettlement(item, outboxById, confirmationSettlements?.get(item.itemId));
  const proposalProof = latestSettledProposalProof(item, timelineIndex, confirmationSettled);
  if (
    proposalProof !== null &&
    (item.statusReason === `proposal_${item.decisionContext.outcome}` ||
      (["pr_source_revised", "pr_source_left_scope_pending_settlement",
        "pr_source_reentered_scope_pending_settlement"].includes(item.statusReason) && confirmationSettled) ||
      crossRootPullRequestCutoverPendingId(item) !== null)
  ) {
    return { proposalProof };
  }
  if (item.statusReason !== "intent_failed") return null;
  return [...outboxById.values()].some(
    (outbox) =>
      outbox.itemId === item.itemId &&
      outbox.inputDigest === item.inputDigest &&
      outbox.status === "failed" &&
      outbox.outcome?.status === "failed" &&
      outbox.updatedAt === item.updatedAt,
  )
    ? { proposalProof: null }
    : null;
}

function sourceEpochChildren(items, root) {
  const active = currentWorkItemInputBinding(root);
  return items.filter((item) => {
    const binding = currentWorkItemInputBinding(item);
    return (
      item.itemId !== root.itemId &&
      binding?.rootItemId === root.itemId &&
      binding.headRevision === active.headRevision
    );
  });
}

function unstartedIntent(item, outboxById) {
  if (item.status !== "dispatch_pending" || item.activeIntentId === null) {
    return null;
  }
  const outbox = outboxById.get(item.activeIntentId);
  if (
    outbox?.status === "pending" ||
    (outbox?.status === "dispatching" && outbox.dispatchBinding === null)
  ) {
    return outbox;
  }
  return null;
}

function retainedWorkflowWaitBinding(item, outbox) {
  const binding = outbox.sourceBinding;
  if (outbox.inputDigest !== binding?.inputDigest) return false;
  if (ledgerDigest(binding) === ledgerDigest(currentWorkItemInputBinding(item))) return true;
  return matchesHistoricalPullRequestInputBinding(item, binding);
}

function obsoleteHeadCondition(item, outboxById) {
  if (item.status !== "waiting_condition" || item.activeIntentId === null) return null;
  const outbox = outboxById.get(item.activeIntentId);
  const condition = outbox?.intent?.condition;
  if (outbox?.status !== "delivered" || outbox.outcome?.status !== "delivered" ||
      outbox.intent.type !== "wait_condition" || condition?.kind !== "workflow_fact" ||
      !["merge-state", "ci-status", "review-decision", "next-action", "action-state", "head-oid", "base-oid", "state"].includes(condition.fact) ||
      outbox.sourceBinding == null || !retainedWorkflowWaitBinding(item, outbox)) return null;
  return outbox;
}

function ownerRequestedAfterCancellation(replacementRoot, predecessor) {
  const event = replacementRoot?.event;
  return predecessor.status === "cancelled" &&
    predecessor.activeIntentId === null &&
    replacementRoot?.source?.scope?.kind === "owner_requested" &&
    replacementRoot.source.scope.active === true &&
    samePullRequestSubject(predecessor, replacementRoot) &&
    event?.eventType === "pull_request.owner_requested" &&
    event.source?.provider === "local-owner" &&
    Date.parse(event.occurredAt) > Date.parse(predecessor.updatedAt);
}

export function inspectPullRequestSourceCutover(
  root,
  items,
  outboxById,
  { forceHeadChanged = false, timelineIndex = null, confirmationSettlements = null, replacementRoot = null } = {},
) {
  const headChanged = forceHeadChanged || pendingHeadChanged(root.source);
  const participants = [
    root,
    ...(headChanged ? sourceEpochChildren(items, root) : []),
  ];
  const proposalSettlements = [];
  const blockers = participants.filter((item) => {
    const statusReady = item.itemId === root.itemId
      ? ROOT_READY_STATUSES.has(item.status) ||
        ownerRequestedAfterCancellation(replacementRoot, item)
      : CHILD_TERMINAL_STATUSES.has(item.status) ||
        CHILD_SUPERSEDABLE_STATUSES.has(item.status);
    if (statusReady) return false;
    if (headChanged && obsoleteHeadCondition(item, outboxById) !== null) return false;
    const settlement = definitiveBlockedSettlement(
      item,
      outboxById,
      timelineIndex,
      confirmationSettlements,
    );
    if (settlement !== null) {
      if (settlement.proposalProof !== null) {
        proposalSettlements.push({
          participant: item,
          proof: settlement.proposalProof,
        });
      }
      return false;
    }
    return unstartedIntent(item, outboxById) === null;
  });
  return { blockers, headChanged, participants, proposalSettlements };
}

export function crossRootPullRequestCutoverActivation(root, activation) {
  return {
    ...activation,
    participants: activation.participants.filter(
      (participant) =>
        participant.status !== "cancelled" &&
        (participant.itemId === root.itemId ||
          !CHILD_TERMINAL_STATUSES.has(participant.status)),
    ),
  };
}

function samePullRequestSubject(left, right) {
  return Boolean(
    left?.source?.kind === "pull_request" &&
      right?.source?.kind === "pull_request" &&
      left.source.identity.subjectId === right.source.identity.subjectId &&
      left.source.identity.repository === right.source.identity.repository &&
      left.source.identity.pullRequestNumber ===
        right.source.identity.pullRequestNumber,
  );
}

export function registeredCrossRootPullRequestCutover(
  state,
  item,
  outbox = null,
) {
  const pendingItemId = crossRootPullRequestCutoverPendingId(item);
  if (pendingItemId === null) return null;
  const pendingRoot = state.items.find(
    (candidate) => candidate.itemId === pendingItemId,
  );
  const predecessorItemId = crossRootPullRequestCutoverPredecessorId(
    pendingRoot,
  );
  const predecessor = state.items.find(
    (candidate) => candidate.itemId === predecessorItemId,
  );
  const protectedParticipant = predecessor === undefined
    ? false
    : item.itemId === predecessor.itemId ||
      sourceEpochChildren(state.items, predecessor).some(
        (candidate) => candidate.itemId === item.itemId,
      );
  if (
    pendingRoot?.kind !== "source_root" ||
    pendingRoot.status !== "blocked" ||
    predecessor?.kind !== "source_root" ||
    !samePullRequestSubject(predecessor, pendingRoot) ||
    !protectedParticipant
  ) {
    return null;
  }
  if (outbox !== null) {
    const current = currentWorkItemInputBinding(item);
    const binding = outbox.sourceBinding;
    if (
      current === null ||
      outbox.itemId !== item.itemId ||
      binding?.rootItemId !== current.rootItemId ||
      binding.workKey !== current.workKey ||
      binding.inputRevision !== current.inputRevision ||
      binding.headRevision !== current.headRevision ||
      binding.headRefOid !== current.headRefOid ||
      binding.eventId !== current.eventId ||
      binding.eventDigest !== current.eventDigest ||
      binding.inputDigest !== current.inputDigest
    ) {
      return null;
    }
  }
  return pendingRoot;
}

function failSupersededIntent(outbox, nextInputRevision, now) {
  return {
    ...outbox,
    status: "failed",
    revision: outbox.revision + 1,
    dispatcherId: null,
    dispatchLeaseId: null,
    dispatchLeaseUntil: null,
    outcome: {
      status: "failed",
      details: {
        reason: "pr_source_superseded_before_dispatch",
        nextInputRevision,
      },
    },
    updatedAt: now,
  };
}

export function applyReadyPullRequestSourceCutover({
  root,
  activation,
  itemsById,
  outboxById,
  nextInputRevision,
  nextHeadRevision,
  now,
  timelineEvents,
}) {
  let rootResult = activation.headChanged && root.status !== "cancelled"
    ? { ...root, decisionContext: null }
    : root;
  for (const participant of activation.participants) {
    const activeOutbox = unstartedIntent(participant, outboxById);
    const obsoleteCondition = activation.headChanged ? obsoleteHeadCondition(participant, outboxById) : null;
    const supersededIntent = activeOutbox ?? obsoleteCondition;
    if (supersededIntent !== null) {
      if (activeOutbox !== null) outboxById.set(
        activeOutbox.intentId, failSupersededIntent(activeOutbox, nextInputRevision, now),
      );
      timelineEvents.push({
        itemId: participant.itemId,
        type: "intent_superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          intentId: supersededIntent.intentId,
          reason: obsoleteCondition === null ? "pr_source_superseded_before_dispatch" : "pr_head_condition_superseded",
          nextInputRevision,
        },
      });
      if (participant.itemId === root.itemId) {
        rootResult = {
          ...rootResult,
          status: "queued",
          activeIntentId: null,
          statusReason: "pr_source_revised",
        };
      }
    }
    if (
      activation.headChanged &&
      participant.itemId !== root.itemId &&
      participant.status !== "superseded"
    ) {
      const binding = currentWorkItemInputBinding(participant);
      const superseded = {
        ...participant,
        status: "superseded",
        revision: participant.revision + 1,
        ownerId: null,
        leaseId: null,
        leaseUntil: null,
        activeIntentId: null,
        availableAt: null,
        statusReason: "pr_head_superseded",
        updatedAt: now,
      };
      itemsById.set(superseded.itemId, superseded);
      timelineEvents.push({
        itemId: superseded.itemId,
        type: "superseded",
        at: now,
        actorId: "work-ledger-system",
        details: {
          rootItemId: root.itemId,
          previousHeadRevision: binding.headRevision,
          nextHeadRevision,
        },
      });
    }
  }
  return rootResult;
}

export function retireCrossRootPullRequestPredecessor(root, now) {
  if (!CROSS_ROOT_RETIRABLE_STATUSES.has(root.status)) return root;
  return {
    ...root,
    status: "blocked",
    revision: root.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    activeIntentId: null,
    decisionContext: null,
    availableAt: null,
    statusReason: "pr_source_cross_root_cutover_retired",
    updatedAt: now,
  };
}

function publicBlockers(activation) {
  return activation.blockers.map((item) => ({
    itemId: item.itemId,
    status: item.status,
    reason: item.activeIntentId === null
      ? `status:${item.status}`
      : "active_intent",
    activeIntentId: item.activeIntentId,
  }));
}

function resultFor(stateRevision, root, applied, blockers) {
  return {
    applied,
    graphRevision: stateRevision,
    itemId: root.itemId,
    itemRevision: root.revision,
    activeRevision: root.source.activeRevision,
    pendingRevision: root.source.pendingRevision,
    blockers,
  };
}

function crossRootActivationRevision(root) {
  return root.source.pendingRevision ?? root.source.activeRevision;
}

function sourceObservationForRevision(source, inputRevision) {
  const revision = source.revisions[inputRevision - 1];
  const binding = source.bindings.find(
    (candidate) => candidate.inputRevision === inputRevision,
  );
  if (
    revision?.revision !== inputRevision ||
    binding?.eventId !== revision.eventId ||
    !Number.isSafeInteger(binding.sourceSequence) ||
    binding.sourceSequence < 1
  ) {
    throw conflict("跨来源 PR cutover 候选绑定无效");
  }
  return {
    inputRevision,
    sourceSequence: binding.sourceSequence,
  };
}

function fencedCandidateRevision(source) {
  return source.revisions.findLast(
    ({ revision, disposition }) =>
      revision > source.activeRevision &&
      CROSS_ROOT_FENCE_DISPOSITIONS.has(disposition),
  )?.revision ?? null;
}

export function crossRootPullRequestCutoverCandidate(root) {
  if (crossRootPullRequestCutoverPredecessorId(root) === null) return null;
  const inputRevision = root.source.pendingRevision ??
    fencedCandidateRevision(root.source) ??
    root.source.activeRevision;
  const observation = sourceObservationForRevision(root.source, inputRevision);
  const pointer = inputRevision === root.source.pendingRevision
    ? root.source.pending
    : inputRevision === root.source.activeRevision
      ? root.source.current
      : null;
  if (
    pointer !== null &&
    (pointer.sourceSequence !== observation.sourceSequence ||
      pointer.eventId !== root.source.revisions[inputRevision - 1].eventId)
  ) {
    throw conflict("跨来源 PR cutover 候选指针无效");
  }
  return observation;
}

function operationalPullRequestSourceObservation(root) {
  const observation = sourceObservationForRevision(
    root.source,
    root.source.activeRevision,
  );
  if (
    root.source.current.sourceSequence !== observation.sourceSequence ||
    root.source.current.eventId !==
      root.source.revisions[root.source.activeRevision - 1].eventId
  ) {
    throw conflict("跨来源 PR cutover 前驱指针无效");
  }
  return observation;
}

function assertCrossRootCutoverChain(root, predecessor) {
  const candidate = crossRootPullRequestCutoverCandidate(root);
  const pendingSequence = candidate?.sourceSequence;
  let predecessorSequence = operationalPullRequestSourceObservation(
    predecessor,
  ).sourceSequence;
  const source = predecessor.source;
  const previous = source.revisions[source.activeRevision - 2];
  // A later scope departure cannot invalidate an already registered same-Head
  // chain. Only the immediately preceding accepted observation may anchor it;
  // normal authority, settlement and CAS checks still govern activation.
  if (predecessorSequence >= pendingSequence && source.pendingRevision === null &&
      source.scope.kind === "automatic" && source.scope.active === false &&
      source.current.event.eventType === "pull_request.left_scope" &&
      source.scope.lastLifecycleEventId === source.current.eventId &&
      previous?.disposition === "accepted" && previous.headRefOid === source.current.headRefOid &&
      source.current.headRefOid === root.source.revisions[candidate.inputRevision - 1].headRefOid) {
    predecessorSequence = sourceObservationForRevision(source, previous.revision).sourceSequence;
  }
  if (
    predecessor.kind !== "source_root" ||
    predecessor.source?.kind !== "pull_request" ||
    predecessor.itemId === root.itemId ||
    !samePullRequestSubject(predecessor, root) ||
    predecessor.source.workKey === root.source.workKey ||
    !Number.isSafeInteger(pendingSequence) ||
    !Number.isSafeInteger(predecessorSequence) ||
    predecessorSequence >= pendingSequence
  ) {
    throw conflict("跨来源 PR cutover 绑定链无效");
  }
}

function planCrossRootPullRequestSourceReconciliation({
  state,
  command,
  root,
  predecessorItemId,
  clock,
  timelineLimit,
  confirmationSettlements,
}) {
  if (root.status !== "blocked") {
    throw conflict("跨来源 PR cutover 状态无效");
  }
  if (
    command.expectedPendingRevision !== crossRootActivationRevision(root)
  ) {
    throw conflict("PR 来源已不再指向预期版本");
  }
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(root, command.expectedRevision);
  const predecessor = state.items.find(
    (candidate) => candidate.itemId === predecessorItemId,
  );
  if (!predecessor) throw conflict("跨来源 PR cutover 前驱不存在");
  assertCrossRootCutoverChain(root, predecessor);
  const rootCandidateSequence = crossRootPullRequestCutoverCandidate(root)
    .sourceSequence;
  const newerPendingRoot = state.items.find(
    (candidate) =>
      candidate.itemId !== root.itemId &&
      samePullRequestSubject(candidate, root) &&
      crossRootPullRequestCutoverPredecessorId(candidate) ===
        predecessor.itemId &&
      crossRootPullRequestCutoverCandidate(candidate).sourceSequence >
        rootCandidateSequence,
  );
  if (newerPendingRoot !== undefined) {
    throw conflict("跨来源 PR cutover 已有更新的待激活来源");
  }
  const pendingAdmission = pullRequestHeadAdmission(state, root);
  if (pendingAdmission.applies && pendingAdmission.current !== true) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, [
        {
          itemId: root.itemId,
          status: root.status,
          reason: "source_authority_fenced",
          activeIntentId: null,
        },
      ]),
    };
  }

  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activation = inspectPullRequestSourceCutover(
    predecessor,
    state.items,
    outboxById,
    {
      forceHeadChanged: true,
      replacementRoot: root,
      confirmationSettlements,
      timelineIndex: createPullRequestCutoverTimelineIndex(
        state.timeline,
        timelineLimit,
      ),
    },
  );
  if (
    activation.blockers.some(
      (blocker) =>
        blocker.status !== "cancelled" &&
        crossRootPullRequestCutoverPendingId(blocker) !== root.itemId,
    )
  ) {
    throw conflict("跨来源 PR cutover blocker 标记无效");
  }
  const blockers = publicBlockers(activation);
  if (blockers.length > 0) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, blockers),
    };
  }

  const now = clock();
  const itemsById = new Map(
    state.items.map((item) => [item.itemId, item]),
  );
  const timelineEvents = [];
  const crossRootActivation = crossRootPullRequestCutoverActivation(
    predecessor,
    activation,
  );
  const locallySettledPredecessor = applyReadyPullRequestSourceCutover({
    root: predecessor,
    activation: crossRootActivation,
    itemsById,
    outboxById,
    nextInputRevision: crossRootActivationRevision(root),
    nextHeadRevision: root.source.headRevision,
    now,
    timelineEvents,
  });
  const settledPredecessor = retireCrossRootPullRequestPredecessor(
    locallySettledPredecessor,
    now,
  );
  itemsById.set(settledPredecessor.itemId, settledPredecessor);
  for (const item of itemsById.values()) {
    if (crossRootPullRequestCutoverPendingId(item) !== root.itemId) continue;
    itemsById.set(item.itemId, {
      ...item,
      revision: item.revision + 1,
      statusReason: item.statusReason ===
          crossRootPullRequestCutoverBlockerReason(root.itemId)
        ? null
        : item.statusReason,
      updatedAt: now,
    });
  }
  for (const item of itemsById.values()) {
    if (
      item.itemId === root.itemId ||
      !samePullRequestSubject(item, root) ||
      crossRootPullRequestCutoverPredecessorId(item) !== predecessor.itemId ||
      crossRootPullRequestCutoverCandidate(item).sourceSequence >=
        rootCandidateSequence
    ) {
      continue;
    }
    itemsById.set(item.itemId, {
      ...item,
      status: "superseded",
      revision: item.revision + 1,
      ownerId: null,
      leaseId: null,
      leaseUntil: null,
      activeIntentId: null,
      availableAt: null,
      statusReason: "pr_source_cross_root_cutover_replaced",
      updatedAt: now,
    });
    timelineEvents.push({
      itemId: item.itemId,
      type: "superseded",
      at: now,
      actorId: "work-ledger-system",
      details: {
        reason: "pr_source_cross_root_cutover_replaced",
        nextRootItemId: root.itemId,
      },
    });
  }
  const activated = activatePendingPullRequestWorkSource(root.source, { attemptAtActivation: root.attempt });
  const next = {
    ...root,
    source: activated.source,
    inputDigest: activated.source.current.inputDigest,
    status: "queued",
    revision: root.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: "pr_source_cutover_activated",
    updatedAt: now,
  };
  itemsById.set(next.itemId, next);
  timelineEvents.push({
    itemId: next.itemId,
    type: "pr_source_activated",
    at: now,
    actorId: "work-ledger-system",
    details: {
      workKey: next.source.workKey,
      activeRevision: next.source.activeRevision,
      headRevision: next.source.headRevision,
      headRefOid: next.source.current.headRefOid,
      predecessorItemId,
      ...(root.source.current.headRefOid === next.source.current.headRefOid ? {} : {
        previousHeadRefOid: root.source.current.headRefOid,
        previousActiveRevision: root.source.activeRevision,
        decisionAttemptOffset: root.attempt,
      }),
    },
  });
  if (!arePullRequestCutoverProofsRetained({
    timeline: state.timeline,
    timelineLimit,
    appendedEventCount: timelineEvents.length,
    proofs: activation.proposalSettlements.map(({ proof }) => proof),
  })) {
    return {
      write: false,
      result: resultFor(
        state.revision,
        root,
        false,
        publicBlockers({ ...activation, blockers: [predecessor] }),
      ),
    };
  }
  return {
    patch: {
      items: [...itemsById.values()],
      outbox: [...outboxById.values()],
    },
    timelineEvents,
    result: resultFor(state.revision + 1, next, true, []),
  };
}

export function planPullRequestSourceReconciliation({
  state,
  input,
  clock,
  timelineLimit,
  confirmationSettlements = null,
}) {
  const command = normalizePullRequestSourceReconciliationCommand(input);
  const root = requireWorkLedgerItem(state, command.itemId);
  if (root.kind !== "source_root" || root.source?.kind !== "pull_request") {
    throw conflict("工作项不是 PR 来源根");
  }
  const predecessorItemId = crossRootPullRequestCutoverPredecessorId(root);
  if (predecessorItemId !== null) {
    return planCrossRootPullRequestSourceReconciliation({
      state,
      command,
      root,
      predecessorItemId,
      clock,
      timelineLimit,
      confirmationSettlements,
    });
  }
  if (
    typeof root.statusReason === "string" &&
    root.statusReason.startsWith(
      `${CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON}:`,
    )
  ) {
    throw conflict("跨来源 PR cutover marker 损坏");
  }
  if (root.source.pendingRevision === null) {
    if (root.source.activeRevision !== command.expectedPendingRevision) {
      throw conflict("PR 来源已不再指向预期版本");
    }
    return {
      write: false,
      result: resultFor(state.revision, root, false, []),
    };
  }
  if (root.source.pendingRevision !== command.expectedPendingRevision) {
    throw conflict("PR pending 版本已变化");
  }
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(root, command.expectedRevision);

  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activation = inspectPullRequestSourceCutover(
    root,
    state.items,
    outboxById,
    {
      confirmationSettlements,
      timelineIndex: createPullRequestCutoverTimelineIndex(
        state.timeline,
        timelineLimit,
      ),
    },
  );
  const blockers = publicBlockers(activation);
  if (blockers.length > 0) {
    return {
      write: false,
      result: resultFor(state.revision, root, false, blockers),
    };
  }

  const now = clock();
  const pendingRevision = root.source.pendingRevision;
  const pendingHeadRevision = root.source.revisions[
    pendingRevision - 1
  ].headRevision;
  const itemsById = new Map(
    state.items.map((item) => [item.itemId, item]),
  );
  const timelineEvents = [];
  const locallySettledRoot = applyReadyPullRequestSourceCutover({
    root,
    activation,
    itemsById,
    outboxById,
    nextInputRevision: pendingRevision,
    nextHeadRevision: pendingHeadRevision,
    now,
    timelineEvents,
  });
  const activated = activatePendingPullRequestWorkSource(root.source, { attemptAtActivation: root.attempt });
  const next = {
    ...locallySettledRoot,
    source: activated.source,
    inputDigest: activated.source.current.inputDigest,
    status: locallySettledRoot.status === "paused" ? "paused" : "queued",
    revision: locallySettledRoot.revision + 1,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: "pr_source_cutover_activated",
    updatedAt: now,
  };
  itemsById.set(next.itemId, next);
  timelineEvents.push({
    itemId: next.itemId,
    type: "pr_source_activated",
    at: now,
    actorId: "work-ledger-system",
    details: {
      workKey: next.source.workKey,
      activeRevision: next.source.activeRevision,
      headRevision: pendingHeadRevision,
      headRefOid: next.source.current.headRefOid,
      ...(root.source.current.headRefOid === next.source.current.headRefOid ? {} : {
        previousHeadRefOid: root.source.current.headRefOid,
        previousActiveRevision: root.source.activeRevision,
        decisionAttemptOffset: root.attempt,
      }),
    },
  });
  if (!arePullRequestCutoverProofsRetained({
    timeline: state.timeline,
    timelineLimit,
    appendedEventCount: timelineEvents.length,
    proofs: activation.proposalSettlements.map(({ proof }) => proof),
  })) {
    return {
      write: false,
      result: resultFor(
        state.revision,
        root,
        false,
        publicBlockers({ ...activation, blockers: [root] }),
      ),
    };
  }
  return {
    patch: {
      items: [...itemsById.values()],
      outbox: [...outboxById.values()],
    },
    timelineEvents,
    result: resultFor(state.revision + 1, next, true, []),
  };
}
