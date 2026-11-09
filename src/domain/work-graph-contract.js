import { createHash } from "node:crypto";

const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const INVALID_PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,254}[A-Za-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TASK_STATUSES = new Set([
  "pending",
  "paused",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
const SATISFIED_TASK_STATUSES = new Set(["completed", "superseded"]);
const RESPONSIBILITY_TYPES = new Set(["role", "person", "node"]);
const DELIVERY_STATUSES = new Set(["submitted", "accepted", "rejected"]);

export const WORK_GRAPH_DEFAULT_LIMITS = Object.freeze({
  maxTasks: 10_000,
  maxDepth: 32,
  maxFanOut: 64,
  maxDependenciesPerTask: 64,
  maxContractsPerTask: 32,
  maxAcceptanceCriteriaPerContract: 64,
  maxExpectedDeliverablesPerContract: 64,
  maxDeliveriesPerTask: 256,
  maxEvidencePerDelivery: 32,
  maxDeliveryBytesPerTask: 256 * 1_024,
  maxTotalDeliveryBytes: 8 * 1_024 * 1_024,
  maxGraphBytes: 16 * 1_024 * 1_024,
});

export class WorkGraphError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkGraphError";
    this.code = code;
    this.statusCode = code === "WORK_GRAPH_STALE_REVISION" ? 409 : 400;
  }
}

function graphError(code, message) {
  return new WorkGraphError(code, message);
}

function invalid(message = "工作图无效") {
  return graphError("WORK_GRAPH_INVALID", message);
}

function limitExceeded(message = "工作图超过限制") {
  return graphError("WORK_GRAPH_LIMIT_EXCEEDED", message);
}

function staleRevision(message = "工作图输入修订已过期") {
  return graphError("WORK_GRAPH_STALE_REVISION", message);
}

function dataKeys(value, error = invalid()) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
  }
  return keys;
}

function exactObject(value, expectedKeys, error = invalid()) {
  const keys = dataKeys(value, error);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function denseArray(value, maximum, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid();
  }
  if (value.length > maximum) throw limitExceeded();
  if (value.length < minimum) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw invalid();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value, name, maximumBytes, pattern = null, { empty = false, multiline = false } = {}) {
  if (
    typeof value !== "string" ||
    (multiline ? INVALID_PROSE_CONTROL : INVALID_CONTROL).test(value) ||
    (!empty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function safeInteger(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contentDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function normalizeLimits(value = {}) {
  const allowed = Object.keys(WORK_GRAPH_DEFAULT_LIMITS);
  const keys = dataKeys(value, invalid("工作图 limits 无效"));
  if (keys.some((key) => !allowed.includes(key))) {
    throw invalid("工作图 limits 无效");
  }
  const limits = { ...WORK_GRAPH_DEFAULT_LIMITS };
  for (const key of keys) {
    const limit = safeInteger(value[key], key);
    if (limit > WORK_GRAPH_DEFAULT_LIMITS[key]) {
      throw invalid(`${key} 不能超过系统硬上限`);
    }
    limits[key] = limit;
  }
  return limits;
}

function normalizeOptions(value, allowedKeys) {
  if (value === undefined) return {};
  const keys = dataKeys(value, invalid("工作图 options 无效"));
  if (
    keys.some(
      (key) => !allowedKeys.includes(key) || value[key] === undefined,
    )
  ) {
    throw invalid("工作图 options 无效");
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function normalizeResponsibility(value) {
  exactObject(value, ["type", "id"]);
  if (!RESPONSIBILITY_TYPES.has(value.type)) throw invalid("责任目标类型无效");
  return {
    type: value.type,
    id: boundedText(value.id, "responsibility.id", 128),
  };
}

function normalizeCriterion(value) {
  exactObject(value, ["criterionId", "description"]);
  return {
    criterionId: boundedText(value.criterionId, "criterionId", 128, SAFE_TOKEN),
    description: boundedText(value.description, "criterion.description", 4_096),
  };
}

function normalizeExpectedDeliverable(value) {
  exactObject(value, ["deliverableId", "kind", "description", "required"]);
  if (typeof value.required !== "boolean") throw invalid("deliverable.required 无效");
  return {
    deliverableId: boundedText(value.deliverableId, "deliverableId", 128, SAFE_TOKEN),
    kind: boundedText(value.kind, "deliverable.kind", 128, SAFE_TOKEN),
    description: boundedText(value.description, "deliverable.description", 4_096),
    required: value.required,
  };
}

function normalizeContract(value, limits) {
  exactObject(value, ["revision", "acceptanceCriteria", "expectedDeliverables"]);
  const acceptanceCriteria = denseArray(
    value.acceptanceCriteria,
    limits.maxAcceptanceCriteriaPerContract,
  )
    .map(normalizeCriterion)
    .sort((left, right) => compareText(left.criterionId, right.criterionId));
  const expectedDeliverables = denseArray(
    value.expectedDeliverables,
    limits.maxExpectedDeliverablesPerContract,
  )
    .map(normalizeExpectedDeliverable)
    .sort((left, right) => compareText(left.deliverableId, right.deliverableId));
  if (
    new Set(acceptanceCriteria.map(({ criterionId }) => criterionId)).size !==
      acceptanceCriteria.length ||
    new Set(expectedDeliverables.map(({ deliverableId }) => deliverableId)).size !==
      expectedDeliverables.length
  ) {
    throw invalid("验收契约内 ID 重复");
  }
  return {
    revision: safeInteger(value.revision, "contract.revision"),
    acceptanceCriteria,
    expectedDeliverables,
  };
}

export function normalizeWorkGraphAcceptanceContract(value, optionsValue) {
  const options = normalizeOptions(optionsValue, ["limits"]);
  const limitOverrides = Object.hasOwn(options, "limits") ? options.limits : {};
  return deepFreeze(normalizeContract(value, normalizeLimits(limitOverrides)));
}

function normalizeEvidence(value) {
  exactObject(value, ["kind", "referenceId", "contentDigest"]);
  return {
    kind: boundedText(value.kind, "evidence.kind", 128, SAFE_TOKEN),
    referenceId: boundedText(value.referenceId, "evidence.referenceId", 512, SAFE_ID),
    contentDigest: boundedText(value.contentDigest, "evidence.contentDigest", 64, SHA256),
  };
}

function normalizeDelivery(value, limits) {
  exactObject(value, [
    "deliverableId",
    "revision",
    "contractRevision",
    "status",
    "summary",
    "evidence",
  ]);
  if (!DELIVERY_STATUSES.has(value.status)) throw invalid("delivery.status 无效");
  const evidence = denseArray(value.evidence, limits.maxEvidencePerDelivery, {
    minimum: 1,
  })
    .map(normalizeEvidence)
    .sort((left, right) =>
      compareText(
        `${left.kind}:${left.referenceId}:${left.contentDigest}`,
        `${right.kind}:${right.referenceId}:${right.contentDigest}`,
      ),
    );
  const evidenceKeys = evidence.map(
    ({ kind, referenceId, contentDigest: digest }) => `${kind}:${referenceId}:${digest}`,
  );
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    throw invalid("delivery.evidence 重复");
  }
  return {
    deliverableId: boundedText(value.deliverableId, "delivery.deliverableId", 128, SAFE_TOKEN),
    revision: safeInteger(value.revision, "delivery.revision"),
    contractRevision: safeInteger(value.contractRevision, "delivery.contractRevision"),
    status: value.status,
    summary: boundedText(value.summary, "delivery.summary", 16 * 1_024, null, { multiline: true }),
    evidence,
  };
}

export function normalizeWorkGraphDelivery(value, optionsValue) {
  const options = normalizeOptions(optionsValue, ["limits"]);
  const limitOverrides = Object.hasOwn(options, "limits") ? options.limits : {};
  return deepFreeze(normalizeDelivery(value, normalizeLimits(limitOverrides)));
}

function assertSequentialRevisions(values, name) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].revision !== index + 1) {
      throw invalid(`${name} 修订必须连续`);
    }
  }
}

function latestContractIsSatisfied(contracts, deliveries) {
  const current = contracts.at(-1);
  const latestByDeliverable = new Map();
  for (const delivery of deliveries) {
    if (delivery.contractRevision === current.revision) {
      latestByDeliverable.set(delivery.deliverableId, delivery);
    }
  }
  return current.expectedDeliverables
    .filter(({ required }) => required)
    .every(({ deliverableId }) =>
      latestByDeliverable.get(deliverableId)?.status === "accepted",
    );
}

function isSatisfiedTaskStatus(status) {
  return SATISFIED_TASK_STATUSES.has(status);
}

function isSettledChildTaskStatus(status) {
  return status === "cancelled" || isSatisfiedTaskStatus(status);
}

function normalizeTask(value, limits, deliveryBudget) {
  exactObject(value, [
    "taskId",
    "revision",
    "parentTaskId",
    "status",
    "responsibility",
    "acceptanceContracts",
    "deliveries",
    "dependsOn",
  ]);
  if (!TASK_STATUSES.has(value.status)) throw invalid("task.status 无效");
  const revision = safeInteger(value.revision, "task.revision");
  const acceptanceContracts = denseArray(
    value.acceptanceContracts,
    limits.maxContractsPerTask,
    { minimum: 1 },
  )
    .map((entry) => normalizeContract(entry, limits))
    .sort((left, right) => left.revision - right.revision);
  assertSequentialRevisions(acceptanceContracts, "acceptanceContracts");

  const deliveries = denseArray(value.deliveries, limits.maxDeliveriesPerTask)
    .map((entry) => normalizeDelivery(entry, limits))
    .sort((left, right) => left.revision - right.revision);
  assertSequentialRevisions(deliveries, "deliveries");
  const contractsByRevision = new Map(
    acceptanceContracts.map((entry) => [entry.revision, entry]),
  );
  for (const entry of deliveries) {
    const boundContract = contractsByRevision.get(entry.contractRevision);
    if (!boundContract) {
      throw staleRevision("delivery 引用了不存在或尚未生效的契约修订");
    }
    if (
      !boundContract.expectedDeliverables.some(
        ({ deliverableId }) => deliverableId === entry.deliverableId,
      )
    ) {
      throw invalid("delivery 未绑定契约中的预期交付物");
    }
  }
  const latestContractRevision = acceptanceContracts.at(-1).revision;
  const latestDeliveryRevision = deliveries.at(-1)?.revision ?? 0;
  if (revision < latestContractRevision || revision < latestDeliveryRevision) {
    throw staleRevision("task.revision 落后于契约或交付修订");
  }
  if (
    value.status === "completed" &&
    !latestContractIsSatisfied(acceptanceContracts, deliveries)
  ) {
    throw invalid("completed 任务缺少当前契约要求的已验收交付物");
  }

  const deliveryBytes = Buffer.byteLength(JSON.stringify(deliveries), "utf8");
  if (deliveryBytes > limits.maxDeliveryBytesPerTask) {
    throw limitExceeded("单个任务的交付内容超过限制");
  }
  deliveryBudget.bytes += deliveryBytes;
  if (deliveryBudget.bytes > limits.maxTotalDeliveryBytes) {
    throw limitExceeded("工作图交付内容总量超过限制");
  }

  const dependsOn = denseArray(value.dependsOn, limits.maxDependenciesPerTask)
    .map((entry) => boundedText(entry, "dependsOn", 256, SAFE_ID))
    .sort(compareText);
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw invalid("dependsOn 重复");
  }
  return {
    taskId: boundedText(value.taskId, "taskId", 256, SAFE_ID),
    revision,
    parentTaskId:
      value.parentTaskId === null
        ? null
        : boundedText(value.parentTaskId, "parentTaskId", 256, SAFE_ID),
    status: value.status,
    responsibility: normalizeResponsibility(value.responsibility),
    acceptanceContracts,
    deliveries,
    dependsOn,
  };
}

function assertReferencesAndHierarchy(tasks, limits) {
  const byId = new Map(tasks.map((entry) => [entry.taskId, entry]));
  const children = new Map();
  const activeChildren = new Map();
  for (const task of tasks) {
    if (task.parentTaskId !== null && !byId.has(task.parentTaskId)) {
      throw graphError(
        "WORK_GRAPH_DANGLING_REFERENCE",
        `父任务 ${task.parentTaskId} 不存在`,
      );
    }
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw graphError(
          "WORK_GRAPH_DANGLING_REFERENCE",
          `依赖任务 ${dependency} 不存在`,
        );
      }
      if (dependency === task.taskId) {
        throw graphError("WORK_GRAPH_CYCLE", `任务 ${task.taskId} 自依赖`);
      }
    }
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task.taskId);
    children.set(task.parentTaskId, siblings);
    if (task.parentTaskId !== null && task.status !== "superseded") {
      const activeSiblingCount = (activeChildren.get(task.parentTaskId) ?? 0) + 1;
      activeChildren.set(task.parentTaskId, activeSiblingCount);
      if (activeSiblingCount > limits.maxFanOut) {
        throw limitExceeded("父任务有效 fan-out 超过限制");
      }
    }
  }

  for (const task of tasks) {
    const childIds = children.get(task.taskId) ?? [];
    if (
      task.status === "completed" &&
      (
        childIds.some(
          (childId) => !isSettledChildTaskStatus(byId.get(childId).status),
        ) ||
        task.dependsOn.some(
          (dependencyId) =>
            !isSatisfiedTaskStatus(byId.get(dependencyId).status),
        )
      )
    ) {
      throw invalid("completed 任务仍有未完成的依赖或直接子任务");
    }
    if (
      TERMINAL_TASK_STATUSES.has(task.status) &&
      childIds.some((childId) =>
        ["pending", "paused", "in_progress"].includes(
          byId.get(childId).status,
        ),
      )
    ) {
      throw invalid("终态父任务仍有活动的直接子任务");
    }
  }

  const hierarchyVisiting = new Set();
  const hierarchyDepth = new Map();
  function depthOf(taskId) {
    if (hierarchyDepth.has(taskId)) return hierarchyDepth.get(taskId);
    if (hierarchyVisiting.has(taskId)) {
      throw graphError("WORK_GRAPH_CYCLE", "父子关系构成循环");
    }
    hierarchyVisiting.add(taskId);
    const parentId = byId.get(taskId).parentTaskId;
    const depth = parentId === null ? 0 : depthOf(parentId) + 1;
    hierarchyVisiting.delete(taskId);
    if (depth > limits.maxDepth) throw limitExceeded("任务层级超过限制");
    hierarchyDepth.set(taskId, depth);
    return depth;
  }
  for (const task of tasks) depthOf(task.taskId);

  const prerequisiteVisiting = new Set();
  const prerequisiteVisited = new Set();
  function visitPrerequisites(taskId) {
    if (prerequisiteVisiting.has(taskId)) {
      throw graphError("WORK_GRAPH_CYCLE", "父子完成关系与任务依赖构成循环");
    }
    if (prerequisiteVisited.has(taskId)) return;
    prerequisiteVisiting.add(taskId);
    const prerequisites = [
      ...byId.get(taskId).dependsOn,
      ...(children.get(taskId) ?? []),
    ];
    for (const prerequisite of prerequisites) {
      visitPrerequisites(prerequisite);
    }
    prerequisiteVisiting.delete(taskId);
    prerequisiteVisited.add(taskId);
  }
  for (const task of tasks) visitPrerequisites(task.taskId);
}

function normalizeContent(value, limits, deliveryBudget) {
  exactObject(value, ["schemaVersion", "graphId", "revision", "tasks"]);
  if (value.schemaVersion !== 1) throw invalid("schemaVersion 无效");
  const tasks = denseArray(value.tasks, limits.maxTasks)
    .map((entry) => normalizeTask(entry, limits, deliveryBudget))
    .sort((left, right) => compareText(left.taskId, right.taskId));
  if (new Set(tasks.map(({ taskId }) => taskId)).size !== tasks.length) {
    throw invalid("taskId 重复");
  }
  assertReferencesAndHierarchy(tasks, limits);
  const revision = safeInteger(value.revision, "graph.revision", {
    minimum: 0,
  });
  if (tasks.some((task) => task.revision > revision)) {
    throw staleRevision("graph.revision 落后于任务修订");
  }
  return {
    schemaVersion: 1,
    graphId: boundedText(value.graphId, "graphId", 256, SAFE_ID),
    revision,
    tasks,
  };
}

function normalizedContent(value, limits) {
  return normalizeContent(value, limits, { bytes: 0 });
}

function assertGraphSize(snapshot, limits) {
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > limits.maxGraphBytes) {
    throw limitExceeded("工作图序列化内容超过限制");
  }
}

function assertExpectedRevision(revision, expectedRevision) {
  if (expectedRevision === undefined) return;
  const expected = safeInteger(expectedRevision, "expectedRevision", {
    minimum: 0,
  });
  if (revision !== expected) throw staleRevision();
}

export function createWorkGraphSnapshot(value, optionsValue) {
  const options = normalizeOptions(optionsValue, ["limits"]);
  const limitOverrides = Object.hasOwn(options, "limits") ? options.limits : {};
  const limits = normalizeLimits(limitOverrides);
  exactObject(value, ["graphId", "revision", "tasks"]);
  const content = normalizedContent({ schemaVersion: 1, ...value }, limits);
  const snapshot = {
    ...content,
    contentDigest: contentDigest(content),
  };
  assertGraphSize(snapshot, limits);
  return deepFreeze(snapshot);
}

export function normalizeWorkGraphSnapshot(
  value,
  optionsValue,
) {
  const options = normalizeOptions(optionsValue, ["limits", "expectedRevision"]);
  const limitOverrides = Object.hasOwn(options, "limits") ? options.limits : {};
  const limits = normalizeLimits(limitOverrides);
  exactObject(value, [
    "schemaVersion",
    "graphId",
    "revision",
    "tasks",
    "contentDigest",
  ]);
  const content = normalizedContent(
    {
      schemaVersion: value.schemaVersion,
      graphId: value.graphId,
      revision: value.revision,
      tasks: value.tasks,
    },
    limits,
  );
  const digest = boundedText(value.contentDigest, "contentDigest", 64, SHA256);
  if (digest !== contentDigest(content)) throw invalid("工作图摘要绑定无效");
  assertExpectedRevision(content.revision, options.expectedRevision);
  const snapshot = { ...content, contentDigest: digest };
  assertGraphSize(snapshot, limits);
  return deepFreeze(snapshot);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertHistoryPrefix(previousEntries, nextEntries, name) {
  if (
    nextEntries.length < previousEntries.length ||
    previousEntries.some((entry, index) => !sameValue(entry, nextEntries[index]))
  ) {
    throw graphError(
      "WORK_GRAPH_INVALID_TRANSITION",
      `${name} 历史只能追加`,
    );
  }
}

function childrenByParent(tasks) {
  const children = new Map();
  for (const task of tasks) {
    const childIds = children.get(task.parentTaskId) ?? [];
    childIds.push(task.taskId);
    children.set(task.parentTaskId, childIds);
  }
  return children;
}

function revisionBoundTaskContent(task, children) {
  const { revision, ...ownContent } = task;
  return {
    ...ownContent,
    directChildTaskIds: [...(children.get(task.taskId) ?? [])].sort(compareText),
  };
}

function terminalReactivationTaskIds(value, maximumTasks) {
  if (value === undefined) return new Set();
  const ids = denseArray(value, maximumTasks).map((taskId) =>
    boundedText(taskId, "terminalReactivationTaskId", 256, SAFE_ID)
  );
  if (new Set(ids).size !== ids.length) {
    throw invalid("terminalReactivationTaskIds 重复");
  }
  return new Set(ids);
}

function terminalSupersessionTaskIds(value, maximumTasks) {
  if (value === undefined) return new Set();
  const ids = denseArray(value, maximumTasks).map((taskId) =>
    boundedText(taskId, "terminalSupersessionTaskId", 256, SAFE_ID)
  );
  if (new Set(ids).size !== ids.length) {
    throw invalid("terminalSupersessionTaskIds 重复");
  }
  return new Set(ids);
}

function supersededReactivationTaskIds(value, maximumTasks) {
  if (value === undefined) return new Set();
  const ids = denseArray(value, maximumTasks).map((taskId) =>
    boundedText(taskId, "supersededReactivationTaskId", 256, SAFE_ID)
  );
  if (new Set(ids).size !== ids.length) {
    throw invalid("supersededReactivationTaskIds 重复");
  }
  return new Set(ids);
}

function assertTaskStatusTransition(
  previousTask,
  nextTask,
  reactivationIds,
  supersededReactivationIds,
  supersessionIds,
) {
  const {
    revision: previousRevision,
    status: previousStatus,
    ...previousContent
  } = previousTask;
  const {
    revision: nextRevision,
    status: nextStatus,
    ...nextContent
  } = nextTask;
  const allowedReactivation =
    previousStatus !== "superseded" &&
    reactivationIds.has(previousTask.taskId) &&
    ["in_progress", "pending"].includes(nextStatus) &&
    nextRevision === previousRevision + 1 &&
    sameValue(previousContent, nextContent);
  const allowedSupersession =
    previousStatus !== "superseded" &&
    supersessionIds.has(previousTask.taskId) &&
    nextStatus === "superseded" &&
    nextRevision === previousRevision + 1 &&
    sameValue(previousContent, nextContent);
  const allowedSupersededReactivation =
    previousStatus === "superseded" &&
    supersededReactivationIds.has(previousTask.taskId) &&
    ["in_progress", "pending"].includes(nextStatus) &&
    nextRevision === previousRevision + 1 &&
    sameValue(previousContent, nextContent);
  if (
    TERMINAL_TASK_STATUSES.has(previousStatus) &&
    !sameValue(previousTask, nextTask) &&
    !allowedReactivation &&
    !allowedSupersededReactivation &&
    !allowedSupersession
  ) {
    throw graphError(
      "WORK_GRAPH_INVALID_TRANSITION",
      `终态任务 ${previousTask.taskId} 不可改写或复活`,
    );
  }
}

function assertNoTerminalAncestor(task, tasksById) {
  let ancestorId = task.parentTaskId;
  while (ancestorId !== null) {
    const ancestor = tasksById.get(ancestorId);
    if (TERMINAL_TASK_STATUSES.has(ancestor.status)) {
      throw graphError(
        "WORK_GRAPH_INVALID_TRANSITION",
        `新任务 ${task.taskId} 不可挂在终态祖先 ${ancestorId} 下`,
      );
    }
    ancestorId = ancestor.parentTaskId;
  }
}

export function validateWorkGraphTransition(previousValue, nextValue, optionsValue) {
  const options = normalizeOptions(optionsValue, [
    "limits",
    "supersededReactivationTaskIds",
    "terminalReactivationTaskIds",
    "terminalSupersessionTaskIds",
  ]);
  const normalizationOptions = Object.hasOwn(options, "limits")
    ? { limits: options.limits }
    : undefined;
  const previous = normalizeWorkGraphSnapshot(
    previousValue,
    normalizationOptions,
  );
  const next = normalizeWorkGraphSnapshot(nextValue, normalizationOptions);
  const reactivationIds = terminalReactivationTaskIds(
    options.terminalReactivationTaskIds,
    (normalizationOptions?.limits?.maxTasks ?? WORK_GRAPH_DEFAULT_LIMITS.maxTasks),
  );
  const supersessionIds = terminalSupersessionTaskIds(
    options.terminalSupersessionTaskIds,
    (normalizationOptions?.limits?.maxTasks ?? WORK_GRAPH_DEFAULT_LIMITS.maxTasks),
  );
  const supersededReactivationIds = supersededReactivationTaskIds(
    options.supersededReactivationTaskIds,
    (normalizationOptions?.limits?.maxTasks ?? WORK_GRAPH_DEFAULT_LIMITS.maxTasks),
  );
  if (
    previous.graphId !== next.graphId ||
    previous.revision === Number.MAX_SAFE_INTEGER ||
    next.revision !== previous.revision + 1
  ) {
    throw staleRevision("工作图 transition 必须保持 graphId 且修订恰好递增 1");
  }

  const nextById = new Map(next.tasks.map((task) => [task.taskId, task]));
  const previousChildren = childrenByParent(previous.tasks);
  const nextChildren = childrenByParent(next.tasks);
  const previousTaskIds = new Set(
    previous.tasks.map((task) => task.taskId),
  );
  for (const previousTask of previous.tasks) {
    const nextTask = nextById.get(previousTask.taskId);
    if (!nextTask) {
      throw graphError(
        "WORK_GRAPH_INVALID_TRANSITION",
        `既有任务 ${previousTask.taskId} 不可删除`,
      );
    }
    assertTaskStatusTransition(
      previousTask,
      nextTask,
      reactivationIds,
      supersededReactivationIds,
      supersessionIds,
    );
    const changed = !sameValue(
      revisionBoundTaskContent(
        previousTask,
        previousChildren,
      ),
      revisionBoundTaskContent(nextTask, nextChildren),
    );
    const revisionDelta = nextTask.revision - previousTask.revision;
    // Integrated stores may advance a task for bounded operational facts that
    // are intentionally absent from this shared projection.
    if (
      (changed && revisionDelta !== 1) ||
      (!changed && ![0, 1].includes(revisionDelta))
    ) {
      throw graphError(
        "WORK_GRAPH_INVALID_TRANSITION",
        `任务 ${previousTask.taskId} 修订与内容变化不一致`,
      );
    }
    assertHistoryPrefix(
      previousTask.acceptanceContracts,
      nextTask.acceptanceContracts,
      `任务 ${previousTask.taskId} acceptanceContracts`,
    );
    assertHistoryPrefix(
      previousTask.deliveries,
      nextTask.deliveries,
      `任务 ${previousTask.taskId} deliveries`,
    );
    const latestContractRevision = nextTask.acceptanceContracts.at(-1).revision;
    for (const appendedDelivery of nextTask.deliveries.slice(
      previousTask.deliveries.length,
    )) {
      if (appendedDelivery.contractRevision !== latestContractRevision) {
        throw staleRevision(
          `任务 ${previousTask.taskId} 的新交付绑定了过期契约修订`,
        );
      }
      if (["accepted", "rejected"].includes(appendedDelivery.status)) {
        const submitted = nextTask.deliveries[appendedDelivery.revision - 2];
        if (
          submitted?.status !== "submitted" ||
          submitted.deliverableId !== appendedDelivery.deliverableId ||
          submitted.contractRevision !== appendedDelivery.contractRevision ||
          !sameValue(submitted.evidence, appendedDelivery.evidence)
        ) {
          throw graphError(
            "WORK_GRAPH_INVALID_TRANSITION",
            `任务 ${previousTask.taskId} 的交付审核没有紧邻匹配的 submitted 记录`,
          );
        }
      }
    }
  }
  for (const nextTask of next.tasks) {
    if (previousTaskIds.has(nextTask.taskId)) continue;
    if (
      nextTask.revision !== 1 ||
      !["pending", "in_progress"].includes(nextTask.status) ||
      nextTask.acceptanceContracts.length !== 1 ||
      nextTask.acceptanceContracts[0].revision !== 1 ||
      nextTask.deliveries.length !== 0
    ) {
      throw graphError(
        "WORK_GRAPH_INVALID_TRANSITION",
        `新任务 ${nextTask.taskId} 必须从无历史的 pending 修订 1 开始`,
      );
    }
    assertNoTerminalAncestor(nextTask, nextById);
  }
  return next;
}

function graphIndex(snapshot, options) {
  const normalized = normalizeWorkGraphSnapshot(snapshot, options);
  const byId = new Map(normalized.tasks.map((task) => [task.taskId, task]));
  const children = new Map();
  for (const task of normalized.tasks) {
    const childIds = children.get(task.parentTaskId) ?? [];
    childIds.push(task.taskId);
    children.set(task.parentTaskId, childIds);
  }
  return { snapshot: normalized, byId, children };
}

function terminalAncestor(task, byId) {
  let parentId = task.parentTaskId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (TERMINAL_TASK_STATUSES.has(parent.status)) return parent.taskId;
    parentId = parent.parentTaskId;
  }
  return null;
}

function pendingTasks(index) {
  return index.snapshot.tasks.filter(({ status }) => status === "pending");
}

function blockingTaskIds(task, index) {
  const blockers = task.dependsOn.filter(
    (dependencyId) =>
      !isSatisfiedTaskStatus(index.byId.get(dependencyId).status),
  );
  blockers.push(
    ...(index.children.get(task.taskId) ?? []).filter(
      (childId) => !isSettledChildTaskStatus(index.byId.get(childId).status),
    ),
  );
  const ancestor = terminalAncestor(task, index.byId);
  if (ancestor !== null) blockers.push(ancestor);
  return [...new Set(blockers)].sort(compareText);
}

export function getReadyWorkGraphTaskIds(snapshot, options) {
  const index = graphIndex(snapshot, options);
  return deepFreeze(
    pendingTasks(index)
      .filter((task) => blockingTaskIds(task, index).length === 0)
      .map(({ taskId }) => taskId)
      .sort(compareText),
  );
}

export function getBlockedWorkGraphTasks(snapshot, options) {
  const index = graphIndex(snapshot, options);
  return deepFreeze(
    pendingTasks(index)
      .map((task) => ({
        taskId: task.taskId,
        blockingTaskIds: blockingTaskIds(task, index),
      }))
      .filter(({ blockingTaskIds: blockers }) => blockers.length > 0)
      .sort((left, right) => compareText(left.taskId, right.taskId)),
  );
}

export function getParallelReadyWorkGraphTaskIds(snapshot, options) {
  const index = graphIndex(snapshot, options);
  const ready = pendingTasks(index).filter(
    (task) => blockingTaskIds(task, index).length === 0,
  );
  const counts = new Map();
  for (const task of ready) {
    counts.set(task.parentTaskId, (counts.get(task.parentTaskId) ?? 0) + 1);
  }
  return deepFreeze(
    ready
      .filter((task) => counts.get(task.parentTaskId) > 1)
      .map(({ taskId }) => taskId)
      .sort(compareText),
  );
}

export function deriveParentTaskOutcome(snapshot, taskId, options) {
  const index = graphIndex(snapshot, options);
  const normalizedTaskId = boundedText(taskId, "taskId", 256, SAFE_ID);
  const parent = index.byId.get(normalizedTaskId);
  if (!parent) {
    throw graphError(
      "WORK_GRAPH_TASK_NOT_FOUND",
      `任务 ${normalizedTaskId} 不存在`,
    );
  }
  const childTaskIds = index.children.get(normalizedTaskId) ?? [];
  if (childTaskIds.length === 0) {
    throw graphError(
      "WORK_GRAPH_NOT_PARENT",
      `任务 ${normalizedTaskId} 没有子任务`,
    );
  }
  const children = childTaskIds.map((childId) => index.byId.get(childId));
  const statusIds = (status) =>
    children
      .filter((task) => task.status === status)
      .map(({ taskId: childId }) => childId)
      .sort(compareText);
  const completedTaskIds = statusIds("completed");
  const failedTaskIds = statusIds("failed");
  const cancelledTaskIds = statusIds("cancelled");
  const supersededTaskIds = statusIds("superseded");
  const activeTaskIds = children
    .filter((task) =>
      ["pending", "paused", "in_progress"].includes(task.status)
    )
    .map(({ taskId: childId }) => childId)
    .sort(compareText);

  let outcome = "pending";
  if (parent.status === "cancelled") outcome = "cancelled";
  else if (parent.status === "superseded") outcome = "superseded";
  else if (parent.status === "failed" || failedTaskIds.length > 0) outcome = "failed";
  else if (
    cancelledTaskIds.length > 0 &&
    cancelledTaskIds.length + supersededTaskIds.length === children.length
  ) {
    outcome = "cancelled";
  } else if (
    children.every(({ status }) => isSettledChildTaskStatus(status)) &&
    parent.dependsOn.every(
      (dependencyId) =>
        isSatisfiedTaskStatus(index.byId.get(dependencyId).status),
    ) &&
    latestContractIsSatisfied(parent.acceptanceContracts, parent.deliveries)
  ) {
    outcome = "completed";
  } else if (
    parent.status === "in_progress" ||
    children.some((task) => task.status !== "pending")
  ) {
    outcome = "partial";
  }

  return deepFreeze({
    graphRevision: index.snapshot.revision,
    graphContentDigest: index.snapshot.contentDigest,
    taskId: parent.taskId,
    taskRevision: parent.revision,
    outcome,
    childTaskIds: [...childTaskIds].sort(compareText),
    completedTaskIds,
    failedTaskIds,
    cancelledTaskIds,
    supersededTaskIds,
    activeTaskIds,
  });
}
