import {
  assertCompleteTransition,
  assertGeneralTransition,
  assertHandoffTransition,
  assertItemRevision,
  assertRetryTransition,
  assertWorkLease,
  moveWorkItem,
  normalizeHandoffTarget,
  normalizeRetryAt,
  normalizeWorkActor,
  normalizeWorkDetails,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  workLedgerError,
} from "./work-ledger-values.js";
import { isParentCoordinationReturn } from './work-ledger-graph-responsibility.js';
import {
  assertWorkLedgerGraphClaimable,
  assertWorkLedgerGraphCompletable,
} from "./work-ledger-graph.js";
import {
  hasPendingPullRequestSource,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
  pullRequestHeadAdmission,
  sealLegacyPullRequestDecisionBudget,
} from "./work-ledger-pr-source.js";

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_PREFIX =
  "pr_source_cross_root_cutover_pending:";

export function normalizeWorkLeaseDuration(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_LEASE_MS ||
    value > MAX_LEASE_MS
  ) {
    throw workLedgerError(
      "WORK_LEDGER_LEASE_INVALID",
      "租约时长必须在 1 秒到 24 小时之间",
    );
  }
  return value;
}

export function replaceWorkLedgerRecord(records, idName, replacement) {
  return records.map((record) =>
    record[idName] === replacement[idName] ? replacement : record,
  );
}

export function requireWorkLedgerItem(state, itemId) {
  const item = state.items.find((candidate) => candidate.itemId === itemId);
  if (!item) {
    throw workLedgerError("WORK_LEDGER_ITEM_NOT_FOUND", "工作项不存在", 404);
  }
  return item;
}

export function isWorkItemInLegacyPullRequestCutover(item) {
  return item.sourceQuarantine?.kind === LEGACY_PR_SOURCE_QUARANTINE_KIND ||
    item.statusReason === LEGACY_PR_SOURCE_CUTOVER_REASON;
}

export function assertWorkItemNotInLegacyPullRequestCutover(item) {
  if (isWorkItemInLegacyPullRequestCutover(item)) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_LEGACY_CUTOVER",
      "旧版 PR 工作项尚未完成 Head 切换，只能对账已封印动作",
      409,
    );
  }
}

function assertNoActiveIntent(item) {
  if (item.activeIntentId !== null) {
    throw workLedgerError(
      "WORK_LEDGER_ACTIVE_INTENT_CONFLICT",
      "工作项仍绑定活动意图，必须通过对应闭环命令推进",
      409,
    );
  }
}

function assertCurrentPullRequestHead(state, item) {
  const admission = pullRequestHeadAdmission(state, item);
  if (admission.applies && (!admission.current || admission.pending)) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      "PR Head 已变化，当前工作项不能继续启动新动作",
      409,
    );
  }
}

export function planWorkItemClaim({ state, input, clock, newLeaseId }) {
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const ownerId = boundedLedgerString(input.workerId, "workerId", 128);
  const duration = normalizeWorkLeaseDuration(input.leaseDurationMs);
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertItemRevision(item, input.expectedRevision);
  if (hasPendingPullRequestSource(item)) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      "PR 来源正在切换 Head，当前工作项不能领取",
      409,
    );
  }
  assertCurrentPullRequestHead(state, item);
  const now = clock();
  const expiredLease =
    item.status === "working" && Date.parse(item.leaseUntil) <= Date.parse(now);
  if (item.status === "working" && !expiredLease) {
    throw workLedgerError(
      "WORK_LEDGER_LEASE_ACTIVE",
      "工作项租约尚未过期",
      409,
    );
  }
  if (
    !["queued", "retry_wait", "working"].includes(item.status) ||
    (item.status === "retry_wait" &&
      Date.parse(item.availableAt) > Date.parse(now))
  ) {
    throw workLedgerError(
      item.status === "retry_wait"
        ? "WORK_LEDGER_NOT_AVAILABLE"
        : "WORK_LEDGER_STATUS_CONFLICT",
      "工作项当前不可领取",
      409,
    );
  }
  if (isParentCoordinationReturn(item)) {
    throw workLedgerError('WORK_LEDGER_GRAPH_BLOCKED', '专职子任务已交回父任务编排，当前不可独立领取', 409);
  }
  assertWorkLedgerGraphClaimable(state, itemId);
  const leaseId = newLeaseId();
  const leaseUntil = new Date(Date.parse(now) + duration).toISOString();
  const itemResult = {
    ...item,
    source: sealLegacyPullRequestDecisionBudget(item, state.timeline),
    status: "working",
    revision: item.revision + 1,
    ownerId,
    leaseId,
    leaseUntil,
    attempt: item.attempt + 1,
    availableAt: null,
    statusReason: null,
    updatedAt: now,
  };
  const timelineEvents = [];
  if (expiredLease) {
    timelineEvents.push({
      itemId: item.itemId,
      type: "lease_expired",
      at: now,
      actorId: ownerId,
      details: {
        previousLeaseId: item.leaseId,
        previousOwnerId: item.ownerId,
        previousLeaseUntil: item.leaseUntil,
      },
    });
  }
  timelineEvents.push({
    itemId: item.itemId,
    type: "claimed",
    at: now,
    actorId: ownerId,
    details: {
      leaseId,
      leaseUntil,
      attempt: itemResult.attempt,
      inputDigest: item.inputDigest,
    },
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents,
    result: itemResult,
  };
}

export function planWorkItemTransition({ state, input, clock }) {
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const reason = normalizeWorkReason(input.reason);
  const context = normalizeWorkDetails(input.details ?? {});
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  if (item.statusReason?.startsWith(
    CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_PREFIX,
  )) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      "跨来源 PR cutover 只能通过来源对账推进",
      409,
    );
  }
  assertNoActiveIntent(item);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  assertWorkLease(item, input.leaseId, now);
  assertGeneralTransition(item.status, input.toStatus);
  const itemResult = moveWorkItem(item, {
    status: input.toStatus,
    now,
    reason,
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "transitioned",
        at: now,
        actorId,
        details: {
          fromStatus: item.status,
          toStatus: input.toStatus,
          reason,
          context,
        },
      },
    ],
    result: itemResult,
  };
}

export function planWorkItemRetry({ state, input, clock }) {
  const consumeAttempt = input.consumeAttempt === undefined ? true : input.consumeAttempt;
  if (typeof consumeAttempt !== "boolean") {
    throw workLedgerError("WORK_LEDGER_RETRY_INVALID", "consumeAttempt must be a boolean");
  }
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const reason = normalizeWorkReason(input.reason);
  const details = normalizeWorkDetails(input.details);
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertNoActiveIntent(item);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  assertWorkLease(item, input.leaseId, now);
  assertRetryTransition(item.status);
  if (!consumeAttempt && (item.status !== "working" || item.ownerId !== actorId)) {
    throw workLedgerError("WORK_LEDGER_LEASE_CONFLICT", "Only the active claim owner can restore an attempt", 409);
  }
  const availableAt = normalizeRetryAt(input.availableAt, now);
  const itemResult = moveWorkItem(item, {
    status: "retry_wait",
    now,
    reason,
    availableAt,
  });
  if (!consumeAttempt) itemResult.attempt = Math.max(0, item.attempt - 1);
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "retry_scheduled",
        at: now,
        actorId,
        details: {
          fromStatus: item.status,
          availableAt,
          reason,
          ...details,
        },
      },
    ],
    result: itemResult,
  };
}

export function planWorkItemHandoff({ state, input, clock }) {
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const target = normalizeHandoffTarget(input.target);
  const reason = normalizeWorkReason(input.reason);
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertNoActiveIntent(item);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  assertWorkLease(item, input.leaseId, now);
  assertHandoffTransition(item.status);
  const itemResult = moveWorkItem(item, {
    status: "queued",
    now,
    reason,
    target,
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "handed_off",
        at: now,
        actorId,
        details: {
          fromTarget: item.currentTarget,
          toTarget: target,
          fromStatus: item.status,
          reason,
        },
      },
    ],
    result: itemResult,
  };
}

export function planWorkItemCompletion({ state, input, clock }) {
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const result = normalizeWorkDetails(input.result);
  const item = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertNoActiveIntent(item);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  assertWorkLease(item, input.leaseId, now);
  assertCompleteTransition(item.status);
  assertWorkLedgerGraphCompletable(state, itemId);
  const itemResult = moveWorkItem(item, {
    status: "completed",
    now,
    reason: "completed",
  });
  return {
    patch: {
      items: replaceWorkLedgerRecord(state.items, "itemId", itemResult),
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "completed",
        at: now,
        actorId,
        details: { fromStatus: item.status, result },
      },
    ],
    result: itemResult,
  };
}
