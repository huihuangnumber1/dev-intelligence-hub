import { normalizeWorkGraphAcceptanceContract } from "../domain/work-graph-contract.js";
import { hasPendingHostContextRecovery } from "./work-ledger-host-context-recovery.js";
import { hasPendingCiMaterialRecovery } from "./work-ledger-ci-material-recovery.js";
import { assertWorkLedgerGraphClaimable } from "./work-ledger-graph.js";
import {
  normalizeStoredWorkflowEvent,
  normalizeWorkflowEvent,
} from "../domain/workflow-events.js";
import {
  assertWorkItemNotInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  assertItemRevision,
  assertWorkLease,
  moveWorkItem,
  normalizeWorkActor,
  normalizeWorkReason,
} from "./work-ledger-transitions.js";
import {
  boundedLedgerString,
  boundedLedgerText,
  canonicalLedgerValue,
  hasExactLedgerKeys,
  normalizeLedgerTarget,
  workLedgerError,
} from "./work-ledger-values.js";
import {
  createGraphChildWorkItem,
  graphChildAssignmentId,
} from "./work-ledger-records.js";
import {
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  pullRequestHeadAdmission,
} from "./work-ledger-pr-source.js";
import {
  assertExpectedWorkGraphRevision,
  assertWorkGraphCommandTransition,
  assertWorkGraphTasksInScope,
  normalizeWorkGraphCommandAuthority,
} from "./work-ledger-graph-command-support.js";

const CANCELLABLE_STATUSES = new Set([
  "queued",
  "paused",
  "retry_wait",
  "blocked",
]);
const ACTIVE_SIDE_EFFECT_STATUSES = new Set([
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
]);
const CHILD_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const CHILD_PARENT_STATUSES = new Set([
  "queued",
  "working",
]);

function retryParentReady(state, parent, now) {
  if (parent.status !== "retry_wait" || !Number.isFinite(Date.parse(parent.availableAt)) ||
      Date.parse(parent.availableAt) > Date.parse(now)) return false;
  try {
    // A due retry follows ordinary claim readiness. Failed or unfinished
    // children still require their existing, separately verified recovery.
    assertWorkLedgerGraphClaimable(state, parent.itemId);
    return true;
  } catch (error) {
    if (error?.code === "WORK_LEDGER_GRAPH_BLOCKED") return false;
    throw error;
  }
}

function graphCommandError(message, statusCode = 400) {
  return workLedgerError(
    "WORK_LEDGER_GRAPH_COMMAND_INVALID",
    message,
    statusCode,
  );
}

function graphCommandString(value, name, maximumBytes) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw graphCommandError(`${name} 无效`);
  }
}

function graphCommandArray(value, maximumEntries = 1_000) {
  const normalized = canonicalLedgerValue(value, {
    maximumEntries,
    maximumStringBytes: 16 * 1024,
    errorCode: "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  });
  if (!Array.isArray(normalized)) {
    throw graphCommandError("工作图命令数组无效");
  }
  return normalized;
}

function normalizeTaskIdArray(value, name) {
  const taskIds = graphCommandArray(value, 128)
    .map((entry) => graphCommandString(entry, name, 192))
    .sort();
  if (new Set(taskIds).size !== taskIds.length) {
    throw graphCommandError(`${name} 重复`);
  }
  return taskIds;
}

function normalizeTaskRevisionBindings(value, requiredTaskIds) {
  const bindings = graphCommandArray(value, 256).map((entry) => {
    if (!hasExactLedgerKeys(entry, ["taskId", "revision"])) {
      throw graphCommandError("expectedTaskRevisions 无效");
    }
    const taskId = graphCommandString(entry.taskId, "taskId", 192);
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
      throw graphCommandError("任务 revision 无效");
    }
    return { taskId, revision: entry.revision };
  });
  const taskIds = bindings.map(({ taskId }) => taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw graphCommandError("expectedTaskRevisions 重复");
  }
  const actual = [...taskIds].sort();
  const expected = [...requiredTaskIds].sort();
  if (
    actual.length !== expected.length ||
    actual.some((taskId, index) => taskId !== expected[index])
  ) {
    throw graphCommandError("expectedTaskRevisions 未精确覆盖引用任务");
  }
  return new Map(bindings.map(({ taskId, revision }) => [taskId, revision]));
}

function normalizeChildWork(value) {
  if (!hasExactLedgerKeys(value, ["title", "description"])) {
    throw graphCommandError("子任务工作说明无效");
  }
  let description;
  try { description = boundedLedgerText(value.description, "work.description", 16 * 1024); }
  catch { throw graphCommandError("work.description 无效"); }
  return {
    title: graphCommandString(value.title, "work.title", 256),
    description,
  };
}

function normalizeInitialAcceptanceContract(value) {
  let contract;
  try {
    contract = normalizeWorkGraphAcceptanceContract(value);
  } catch {
    throw graphCommandError("子任务初始验收契约无效");
  }
  if (contract.revision !== 1) {
    throw graphCommandError("子任务初始验收契约无效");
  }
  return contract;
}

function normalizeGraphChildCommand(input) {
  if (!hasExactLedgerKeys(input, ["authority", "command"])) {
    throw graphCommandError("创建子任务请求无效");
  }
  const authority = normalizeWorkGraphCommandAuthority(input.authority);
  const command = input.command;
  if (
    !hasExactLedgerKeys(command, [
      "parentTaskId",
      "childKey",
      "work",
      "target",
      "dependsOnTaskIds",
      "acceptanceContract",
      "leaseId",
      "expectedGraphRevision",
      "expectedTaskRevisions",
    ])
  ) {
    throw graphCommandError("创建子任务命令无效");
  }
  const parentTaskId = graphCommandString(
    command.parentTaskId,
    "parentTaskId",
    192,
  );
  const childKey = graphCommandString(command.childKey, "childKey", 128);
  if (!CHILD_KEY.test(childKey)) throw graphCommandError("childKey 无效");
  const dependsOnItemIds = normalizeTaskIdArray(
    command.dependsOnTaskIds,
    "dependsOnTaskIds",
  );
  const referencedTaskIds = [...new Set([
    parentTaskId,
    ...dependsOnItemIds,
  ])];
  const expectedTaskRevisions = normalizeTaskRevisionBindings(
    command.expectedTaskRevisions,
    referencedTaskIds,
  );
  if (
    !Number.isSafeInteger(command.expectedGraphRevision) ||
    command.expectedGraphRevision < 0
  ) {
    throw graphCommandError("工作图 revision 无效");
  }
  const leaseId = command.leaseId === null
    ? null
    : graphCommandString(command.leaseId, "leaseId", 128);
  let target;
  try {
    target = normalizeLedgerTarget(command.target);
  } catch {
    throw graphCommandError("子任务责任目标无效");
  }
  return {
    authority,
    command: {
      parentTaskId,
      childKey,
      work: normalizeChildWork(command.work),
      target,
      dependsOnItemIds,
      acceptanceContract: normalizeInitialAcceptanceContract(
        command.acceptanceContract,
      ),
      leaseId,
      expectedGraphRevision: command.expectedGraphRevision,
      expectedTaskRevisions,
    },
  };
}

function assertTaskRevisionBindings(state, revisions) {
  for (const [taskId, expectedRevision] of revisions) {
    const item = requireWorkLedgerItem(state, taskId);
    assertWorkItemNotInLegacyPullRequestCutover(item);
    assertItemRevision(item, expectedRevision);
  }
}

function graphChildResult(stateRevision, child, parent, applied) {
  return {
    applied,
    graphRevision: stateRevision,
    taskId: child.itemId,
    taskRevision: child.revision,
    parentTaskId: parent.itemId,
    parentTaskRevision: parent.revision,
  };
}

function assertDependencySourceEpoch(dependency, sourceBinding) {
  const dependencyBinding = currentWorkItemInputBinding(dependency);
  if (dependencyBinding === null) return;
  if (
    sourceBinding === null ||
    dependencyBinding.rootItemId !== sourceBinding.rootItemId ||
    dependencyBinding.workKey !== sourceBinding.workKey ||
    dependencyBinding.headRevision !== sourceBinding.headRevision ||
    dependencyBinding.headRefOid !== sourceBinding.headRefOid
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_SOURCE_EPOCH_CONFLICT",
      "子任务不能依赖不同 PR Head epoch 的任务",
      409,
    );
  }
}

export function planWorkGraphChildCreation({ state, input, clock }) {
  const normalized = normalizeGraphChildCommand(input);
  const { authority, command } = normalized;
  const parent = requireWorkLedgerItem(state, command.parentTaskId);
  assertWorkItemNotInLegacyPullRequestCutover(parent);
  const sourceAdmission = pullRequestHeadAdmission(state, parent);
  if (
    sourceAdmission.applies &&
    (!sourceAdmission.current || sourceAdmission.pending)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
      "父任务的 PR Head 已变化，不能继续创建旧 Head 子任务",
      409,
    );
  }
  const sourceBinding = currentWorkItemInputBinding(parent);
  let parentEvent;
  try {
    const currentEvent = currentWorkItemEvent(parent);
    parentEvent = Object.hasOwn(currentEvent, "eventId")
      ? normalizeStoredWorkflowEvent(currentEvent)
      : normalizeWorkflowEvent(currentEvent);
  } catch (cause) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_SOURCE_INVALID",
      "父任务缺少可供子任务继承的可信来源事件",
      409,
      { cause },
    );
  }
  for (const dependencyId of command.dependsOnItemIds) {
    const dependency = requireWorkLedgerItem(state, dependencyId);
    assertWorkItemNotInLegacyPullRequestCutover(dependency);
    assertDependencySourceEpoch(dependency, sourceBinding);
  }
  const assignmentId = graphChildAssignmentId(
    command.parentTaskId,
    command.childKey,
    sourceBinding,
  );
  const existing = state.items.find(
    (item) => item.assignmentId === assignmentId,
  );
  assertWorkGraphTasksInScope(
    state,
    [
      command.parentTaskId,
      ...command.dependsOnItemIds,
      ...(existing ? [existing.itemId] : []),
    ],
    authority.scopeRootTaskId,
  );
  const now = existing?.createdAt ?? clock();
  const child = createGraphChildWorkItem(
    {
      parentItemId: command.parentTaskId,
      childKey: command.childKey,
      work: command.work,
      target: command.target,
      dependsOnItemIds: command.dependsOnItemIds,
      acceptanceContract: command.acceptanceContract,
      parentEvent,
      sourceBinding,
    },
    now,
  );
  if (existing) {
    if (
      existing.kind !== "graph_task" ||
      existing.inputDigest !== child.inputDigest
    ) {
      throw workLedgerError(
        "WORK_LEDGER_GRAPH_CHILD_CONFLICT",
        "相同父任务和 childKey 已绑定不同子任务内容",
        409,
      );
    }
    return {
      write: false,
      result: graphChildResult(state.revision, existing, parent, false),
    };
  }

  assertExpectedWorkGraphRevision(command.expectedGraphRevision, state);
  assertTaskRevisionBindings(state, command.expectedTaskRevisions);
  const retryReady = retryParentReady(state, parent, now);
  if (
    !["assignment", "graph_task", "source_root"].includes(parent.kind) ||
    (!CHILD_PARENT_STATUSES.has(parent.status) && !retryReady && !hasPendingHostContextRecovery(state, parent) && !hasPendingCiMaterialRecovery(state, parent))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_PARENT_CONFLICT",
      "当前父任务不能创建子任务",
      409,
    );
  }
  assertWorkLease(parent, command.leaseId, now);
  if (parent.status === "working" && parent.ownerId !== authority.actorId) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_AUTHORITY_DENIED",
      "只有当前租约员工可以拆分执行中的任务",
      403,
    );
  }

  const parentResult = parent.status === "queued"
    ? {
        ...parent,
        revision: parent.revision + 1,
        statusReason: "waiting_for_children",
        updatedAt: now,
      }
    : moveWorkItem(parent, {
        status: "queued",
        now,
        reason: "waiting_for_children",
      });
  const items = [
    ...replaceWorkLedgerRecord(state.items, "itemId", parentResult),
    child,
  ];
  assertWorkGraphCommandTransition(state, items);
  return {
    patch: { items },
    timelineEvents: [
      {
        itemId: child.itemId,
        type: "graph_child_created",
        at: now,
        actorId: authority.actorId,
        details: {
          parentTaskId: parent.itemId,
          childTaskId: child.itemId,
          childKey: command.childKey,
          inputDigest: child.inputDigest,
          sourceBinding,
        },
      },
      {
        itemId: parent.itemId,
        type: "graph_parent_revised",
        at: now,
        actorId: authority.actorId,
        details: {
          childTaskId: child.itemId,
          childKey: command.childKey,
          fromStatus: parent.status,
          toStatus: parentResult.status,
        },
      },
    ],
    result: graphChildResult(
      state.revision + 1,
      child,
      parentResult,
      true,
    ),
  };
}

function normalizeExpectedRevisions(input) {
  if (
    !Number.isSafeInteger(input.expectedGraphRevision) ||
    input.expectedGraphRevision < 0 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_REVISION_INVALID",
      "工作图或工作项 revision 无效",
    );
  }
}

function activeAncestorItems(state, root) {
  const byId = new Map(state.items.map((item) => [item.itemId, item]));
  const ancestors = [];
  let parentItemId = root.graph.parentItemId;
  while (parentItemId !== null) {
    const parent = byId.get(parentItemId);
    if (!parent) break;
    if (ACTIVE_SIDE_EFFECT_STATUSES.has(parent.status)) ancestors.push(parent);
    parentItemId = parent.graph.parentItemId;
  }
  return ancestors;
}

function descendantItems(state, rootItemId) {
  const childrenByParent = new Map();
  for (const item of state.items) {
    const siblings = childrenByParent.get(item.graph.parentItemId) ?? [];
    siblings.push(item);
    childrenByParent.set(item.graph.parentItemId, siblings);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(rootItemId) ?? [])];
  while (pending.length > 0) {
    const item = pending.pop();
    descendants.push(item);
    pending.push(...(childrenByParent.get(item.itemId) ?? []));
  }
  return descendants.sort((left, right) =>
    left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0
  );
}

function cancellationResult(rootItemId, items, changedItemIds) {
  return {
    root: items.find(({ itemId }) => itemId === rootItemId),
    cancelledItemIds: [...changedItemIds].sort(),
  };
}

function activeDependentItems(state, cancelledItemIds) {
  const affected = new Set(cancelledItemIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.items) {
      if (
        affected.has(item.itemId) ||
        !item.graph.dependsOnItemIds.some((itemId) => affected.has(itemId))
      ) {
        continue;
      }
      affected.add(item.itemId);
      changed = true;
    }
  }
  return state.items.filter(
    (item) =>
      !cancelledItemIds.has(item.itemId) &&
      affected.has(item.itemId) &&
      ACTIVE_SIDE_EFFECT_STATUSES.has(item.status),
  );
}

export function planWorkGraphCancellation({ state, input, clock }) {
  if (
    !hasExactLedgerKeys(input, [
      "itemId",
      "expectedGraphRevision",
      "expectedRevision",
      "actorId",
      "reason",
    ])
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_INVALID",
      "取消任务请求无效",
    );
  }
  normalizeExpectedRevisions(input);
  const itemId = boundedLedgerString(input.itemId, "itemId", 192);
  const actorId = normalizeWorkActor(input.actorId);
  const reason = normalizeWorkReason(input.reason);
  if (reason === null) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_INVALID",
      "取消任务必须说明原因",
    );
  }
  const root = requireWorkLedgerItem(state, itemId);
  assertWorkItemNotInLegacyPullRequestCutover(root);
  assertExpectedWorkGraphRevision(input.expectedGraphRevision, state);
  assertItemRevision(root, input.expectedRevision);
  if (root.status === "cancelled") {
    return {
      write: false,
      result: cancellationResult(root.itemId, state.items, []),
    };
  }
  if (root.status === "completed") {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_CONFLICT",
      "已完成工作项不能取消",
      409,
    );
  }

  const scope = [root, ...descendantItems(state, root.itemId)];
  const unsafe = scope.filter(
    (item) =>
      !["completed", "cancelled"].includes(item.status) &&
      !CANCELLABLE_STATUSES.has(item.status),
  );
  const changed = scope.filter(({ status }) => CANCELLABLE_STATUSES.has(status));
  const changedItemIds = new Set(changed.map(({ itemId: changedId }) => changedId));
  if (
    unsafe.length > 0 ||
    activeAncestorItems(state, root).length > 0 ||
    activeDependentItems(state, changedItemIds).length > 0
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CANCELLATION_UNSAFE",
      "任务树仍有员工租约、等待结果或待分发副作用，不能直接取消",
      409,
    );
  }

  const now = clock();
  const cancelled = changed.map((item) =>
    moveWorkItem(item, {
      status: "cancelled",
      now,
      reason,
    }),
  );
  let items = state.items;
  for (const item of cancelled) {
    items = replaceWorkLedgerRecord(items, "itemId", item);
  }
  const cancelledItemIds = cancelled.map(({ itemId }) => itemId);
  return {
    patch: { items },
    timelineEvents: cancelled.map((item) => ({
      itemId: item.itemId,
      type: "cancelled",
      at: now,
      actorId,
      details: {
        rootItemId: root.itemId,
        reason,
      },
    })),
    result: cancellationResult(root.itemId, items, cancelledItemIds),
  };
}
