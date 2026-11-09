import {
  assertWorkItemNotInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  assertExpectedWorkGraphRevision,
  assertWorkGraphCommandTransition,
  assertWorkGraphTasksInScope,
  normalizeWorkGraphCommandAuthority,
} from "./work-ledger-graph-command-support.js";
import { planWorkGraphCancellation, planWorkGraphChildCreation } from "./work-ledger-graph-commands.js";
import { hasRequiredReviewDeliverable, requiredReviewDeliverables } from "../domain/pr-review-work-policy.js";
import {
  createWorkIntentRecord,
  pendingWorkIntentRecord,
  normalizeLedgerWorkIntent,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  assertItemRevision,
  moveWorkItem,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  canonicalLedgerValue,
  hasExactLedgerKeys,
  normalizeLedgerTarget,
  workLedgerError,
} from "./work-ledger-values.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding, pullRequestHeadAdmission } from "./work-ledger-pr-source.js";
import { AUTO_RESUME_ON_CHILD_DELIVERY } from "./work-graph-wait-marker.js";
import { coordinatorGoalControl, permitsCoordinatorCancellation } from "../domain/work-goal-ownership.js";

const PAUSABLE_STATUSES = new Set(["queued", "blocked"]);
const ESCALATABLE_STATUSES = new Set(["queued", "retry_wait", "blocked"]);

function invalidCommand(message) {
  return workLedgerError("WORK_LEDGER_GRAPH_COMMAND_INVALID", message);
}

function commandString(value, name, maximumBytes) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw invalidCommand(`${name} 无效`);
  }
}

function commandReason(value) {
  let reason;
  try {
    reason = normalizeWorkReason(value);
  } catch {
    throw invalidCommand("reason 无效");
  }
  if (reason === null) throw invalidCommand("reason 无效");
  return reason;
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidCommand(`${name} 无效`);
  }
  return value;
}

function graphRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidCommand("expectedGraphRevision 无效");
  }
  return value;
}

function coordinatorEnvelope(input, commandKeys, message) {
  if (
    !hasExactLedgerKeys(input, ["authority", "command"]) ||
    !hasExactLedgerKeys(input.command, commandKeys)
  ) {
    throw invalidCommand(message);
  }
  return {
    authority: normalizeWorkGraphCommandAuthority(input.authority),
    command: input.command,
  };
}

function normalizeTaskCommand(input, message, { allowChildWait = false } = {}) {
  const commandKeys = [
    "taskId",
    "reason",
    "expectedGraphRevision",
    "expectedTaskRevision",
  ];
  const childWait = allowChildWait &&
    hasExactLedgerKeys(input, ["authority", "command"]) &&
    hasExactLedgerKeys(input.command, [...commandKeys, "waitForChildren"]);
  const { authority, command } = coordinatorEnvelope(
    input,
    childWait ? [...commandKeys, "waitForChildren"] : commandKeys,
    message,
  );
  if (childWait && command.waitForChildren !== true) {
    throw invalidCommand("waitForChildren 无效");
  }
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      reason: commandReason(command.reason),
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
      ...(childWait ? { waitForChildren: true } : {}),
    },
  };
}

function normalizeReassignCommand(input) {
  const { authority, command } = coordinatorEnvelope(
    input,
    [
      "taskId",
      "target",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
    ],
    "重新分派任务请求无效",
  );
  let target;
  try {
    target = normalizeLedgerTarget(command.target);
  } catch {
    throw invalidCommand("target 无效");
  }
  if (target.type !== "role") {
    throw invalidCommand("重新分派任务只能绑定可信岗位");
  }
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      target,
      reason: commandReason(command.reason),
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
    },
  };
}

function requireScopedTask(state, authority, taskId) {
  const item = requireWorkLedgerItem(state, taskId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertWorkGraphTasksInScope(state, [item.itemId], authority.scopeRootTaskId);
  return item;
}

function assertCoordinatableTask(item, state) {
  if (!["assignment", "graph_task", "source_root"].includes(item.kind)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "系统工作项不能由任务图编排器修改",
      409,
    );
  }
  if (item.kind === "source_root") {
    const admission = pullRequestHeadAdmission(state, item);
    if (!admission.current || admission.pending) {
      throw workLedgerError("WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING", "PR 来源正在切换，不能覆盖其编排状态", 409);
    }
  }
}

function hasSubmittedDelivery(item) {
  return item.graph.deliveries.at(-1)?.status === "submitted";
}

function assertNoActiveSideEffects(item) {
  if (
    item.ownerId !== null ||
    item.leaseId !== null ||
    item.leaseUntil !== null ||
    item.activeIntentId !== null ||
    hasSubmittedDelivery(item)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "任务仍有租约、活动意图或待审核交付，不能安全编排",
      409,
    );
  }
}

function assertCommandCas(state, item, command) {
  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertItemRevision(item, command.expectedTaskRevision);
}

function replaceAndValidate(state, updated) {
  const items = replaceWorkLedgerRecord(state.items, "itemId", updated);
  assertWorkGraphCommandTransition(state, items);
  return items;
}

export function planWorkGraphTaskReassignment({ state, input, clock }) {
  const { authority, command } = normalizeReassignCommand(input);
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item, state);
  assertNoActiveSideEffects(item);
  if (
    item.status !== "queued" ||
    (
      item.currentTarget.type === command.target.type &&
      item.currentTarget.id === command.target.id
    )
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有责任目标发生变化的安全 queued 任务可以重新分派",
      409,
    );
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "queued",
    now,
    reason: command.reason,
    target: command.target,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "handed_off",
        at: now,
        actorId: authority.actorId,
        details: {
          fromTarget: item.currentTarget,
          toTarget: command.target,
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planWorkGraphTaskPause({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "暂停任务请求无效",
    { allowChildWait: true },
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item, state);
  assertNoActiveSideEffects(item);
  if (!PAUSABLE_STATUSES.has(item.status)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有无活动副作用的 queued 或 blocked 任务可以暂停",
      409,
    );
  }
  if (
    command.waitForChildren &&
    (item.status !== "queued" ||
      item.statusReason !== "waiting_for_children" ||
      !state.items.some((candidate) =>
        candidate.graph?.parentItemId === item.itemId &&
        !["completed", "cancelled", "superseded"].includes(candidate.status)))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有已拆分且仍有未完成直属子任务的父任务可以等待交付",
      409,
    );
  }
  if (!command.waitForChildren && command.reason === AUTO_RESUME_ON_CHILD_DELIVERY) {
    throw invalidCommand("reason 是保留的子任务等待标记");
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "paused",
    now,
    reason: command.waitForChildren
      ? AUTO_RESUME_ON_CHILD_DELIVERY
      : command.reason,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "transitioned",
        at: now,
        actorId: authority.actorId,
        details: {
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planWorkGraphTaskResume({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "恢复任务请求无效",
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCommandCas(state, item, command);
  assertCoordinatableTask(item, state);
  assertNoActiveSideEffects(item);
  if (item.status !== "paused") {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有 paused 任务可以恢复为 queued",
      409,
    );
  }
  const now = clock();
  const updated = moveWorkItem(item, {
    status: "queued",
    now,
    reason: command.reason,
  });
  const items = replaceAndValidate(state, updated);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "transitioned",
        at: now,
        actorId: authority.actorId,
        details: {
          fromStatus: item.status,
          toStatus: updated.status,
          reason: command.reason,
        },
      },
    ],
    result: updated,
  };
}

export function planScopedWorkGraphCancellation({ state, input, clock }) {
  const { authority, command } = normalizeTaskCommand(
    input,
    "取消任务请求无效",
  );
  const item = requireScopedTask(state, authority, command.taskId);
  assertCoordinatableTask(item, state);
  const mutation = planWorkGraphCancellation({
    state,
    clock,
    input: {
      itemId: command.taskId,
      expectedGraphRevision: command.expectedGraphRevision,
      expectedRevision: command.expectedTaskRevision,
      actorId: authority.actorId,
      reason: command.reason,
    },
  });
  const control = coordinatorGoalControl({ rootTaskId: item.itemId,
    parentTaskId: item.graph.parentItemId, source: item.source, event: currentWorkItemEvent(item) });
  if (mutation.write !== false && !permitsCoordinatorCancellation(control, item.itemId)) {
    throw workLedgerError("WORK_LEDGER_GRAPH_SCOPE_DENIED", "员工可调整子任务计划，不能取消所有者目标", 403);
  }
  return mutation;
}

// The Review recovery hint grants no execution authority. Reuse the ordinary
// cancellation and creation gates, then commit both graph changes together.
export function planWorkGraphReviewReplacement({ state, input, clock }) {
  const value = canonicalLedgerValue(input, { errorCode: "WORK_LEDGER_GRAPH_COMMAND_INVALID" });
  if (!hasExactLedgerKeys(value, ["authority", "command"]) ||
      !hasExactLedgerKeys(value.command.reviewReplacement, ["taskId", "expectedTaskRevision", "reason"])) throw invalidCommand("Review 替代请求无效");
  const authority = normalizeWorkGraphCommandAuthority(value.authority);
  const { reviewReplacement, ...command } = value.command;
  const old = requireScopedTask(state, authority, reviewReplacement.taskId);
  const parent = requireScopedTask(state, authority, command.parentTaskId);
  if (old.kind !== "graph_task" || old.graph.parentItemId !== parent.itemId ||
      authority.scopeRootTaskId !== parent.itemId || parent.currentTarget.type !== "role" || parent.currentTarget.id !== "orchestrator" ||
      old.currentTarget.type !== "role" || old.currentTarget.id !== "pr-engineer" || old.activeIntentId !== null ||
      old.graph.deliveries.length !== 0 || state.items.some(item => item.graph.parentItemId === old.itemId) ||
      !hasRequiredReviewDeliverable(old.graph.acceptanceContracts.at(-1)) ||
      !requiredReviewDeliverables(command.acceptanceContract).some(slot =>
        requiredReviewDeliverables(old.graph.acceptanceContracts.at(-1)).some(oldSlot => oldSlot.deliverableId === slot.deliverableId)) ||
      command.target.type !== "role" || command.target.id !== "pr-engineer") throw invalidCommand("Review 替代目标无效");
  const reason = commandReason(reviewReplacement.reason);
  assertNoActiveSideEffects(old);
  const createInput = { authority, command };
  if (old.status === "cancelled" && old.revision === reviewReplacement.expectedTaskRevision + 1 && old.statusReason === reason) {
    const retained = planWorkGraphChildCreation({ state, input: createInput, clock });
    if (retained.write === false) return retained;
    throw invalidCommand("Review 替代任务缺失");
  }
  if (old.status !== "blocked") throw invalidCommand("Review 任务尚未结算");
  const now = clock(), pinnedClock = () => now;
  const cancelled = planScopedWorkGraphCancellation({ state, clock: pinnedClock, input: { authority, command: {
    taskId: old.itemId, expectedTaskRevision: reviewReplacement.expectedTaskRevision,
    expectedGraphRevision: command.expectedGraphRevision, reason,
  } } });
  // The ordinary planner validates its intermediate graph at the next revision;
  // the combined mutation still commits exactly one durable ledger revision.
  const created = planWorkGraphChildCreation({ state: { ...state, ...cancelled.patch, revision: state.revision + 1 },
    input: { authority, command: { ...command, expectedGraphRevision: state.revision + 1 } }, clock: pinnedClock });
  if (created.write === false) throw invalidCommand("Review 替代任务已存在但原任务未取消");
  assertWorkGraphCommandTransition(state, created.patch.items);
  return { ...created, result: { ...created.result, graphRevision: state.revision + 1 },
    timelineEvents: [...cancelled.timelineEvents, ...created.timelineEvents] };
}

function normalizeEscalationCommand(input) {
  const { authority, command } = coordinatorEnvelope(
    input,
    [
      "taskId",
      "reason",
      "expectedGraphRevision",
      "expectedTaskRevision",
      "summary",
      "question",
      "choices",
    ],
    "升级任务请求无效",
  );
  let intent;
  try {
    intent = normalizeLedgerWorkIntent({
      schemaVersion: 1,
      type: "ask_user",
      summary: command.summary,
      reason: command.reason,
      question: command.question,
      choices: command.choices,
    });
  } catch {
    throw invalidCommand("升级任务的 ask_user 内容无效");
  }
  return {
    authority,
    command: {
      taskId: commandString(command.taskId, "taskId", 192),
      reason: intent.reason,
      expectedGraphRevision: graphRevision(command.expectedGraphRevision),
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "expectedTaskRevision",
      ),
      intent,
    },
  };
}

export function planWorkGraphEscalation({ state, input, clock }) {
  const { authority, command } = normalizeEscalationCommand(input);
  const item = requireScopedTask(state, authority, command.taskId);
  const requestedBy = {
    roleId: "orchestrator",
    workerId: authority.actorId,
  };
  const now = clock();
  const candidate = createWorkIntentRecord(
    item,
    command.intent,
    requestedBy,
    now,
  );
  const existing = state.outbox.find(
    ({ intentId }) => intentId === candidate.intentId,
  );
  if (existing && existing.status !== "failed") {
    if (item.activeIntentId !== existing.intentId) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_TASK_CONFLICT",
        "历史升级意图不再是任务的活动意图，不能作为幂等重放",
        409,
      );
    }
    return {
      write: false,
      result: {
        applied: false,
        item,
        outbox: existing,
        deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
      },
    };
  }

  assertCommandCas(state, item, command);
  assertCoordinatableTask(item, state);
  assertNoActiveSideEffects(item);
  if (!ESCALATABLE_STATUSES.has(item.status)) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TASK_CONFLICT",
      "只有无活动副作用的 queued、retry_wait 或 blocked 任务可以升级",
      409,
    );
  }
  const outboxResult = pendingWorkIntentRecord(existing, candidate, now);
  const itemResult = moveWorkItem(item, {
    status: "dispatch_pending",
    now,
    reason: "intent_staged",
    activeIntentId: outboxResult.intentId,
  });
  const items = replaceAndValidate(state, itemResult);
  return {
    patch: {
      items,
      outbox: existing
        ? replaceWorkLedgerRecord(state.outbox, "intentId", outboxResult)
        : [...state.outbox, outboxResult],
    },
    timelineEvents: [
      {
        itemId: item.itemId,
        type: "intent_staged",
        at: now,
        actorId: authority.actorId,
        details: {
          inputBinding: currentWorkItemExecutionBinding(item),
          workItemRevision: itemResult.revision,
          intentId: outboxResult.intentId,
          intentDigest: outboxResult.intentDigest,
          intentType: outboxResult.intent.type,
          inputDigest: item.inputDigest,
          requestedBy,
          reusedFailedIntent: existing !== undefined,
          deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
          ...(outboxResult.intent.type === "ask_user"
            ? {
                consultationRequest: {
                  summary: outboxResult.intent.summary,
                  reason: outboxResult.intent.reason,
                  question: outboxResult.intent.question,
                  choices: outboxResult.intent.choices,
                },
              }
            : {}),
        },
      },
    ],
    result: {
      applied: true,
      item: itemResult,
      outbox: outboxResult,
      deliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    },
  };
}
