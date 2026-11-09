import { isInternalRepairReviewEvent } from "../domain/internal-repair-review.js";
import { isOwnerRequestedCiRepairEvent } from "./ci-repair-context-reader.js";
import { coordinatorGoalControl } from "../domain/work-goal-ownership.js";
import { createHash } from "node:crypto";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { deliveryAcceptanceContractDigest, deliveryEvidenceKindsForProposal } from "../domain/delivery-evidence-contract.js";
import { hasRequiredReviewDeliverable, isExternalRereview } from "../domain/pr-review-work-policy.js";

import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import {
  createPullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { normalizeConflictPreparationBinding } from "../domain/conflict-preparation-binding.js";
import { normalizeRepairFeedbackDescriptor } from "../domain/original-repair-feedback.js";
import { normalizeWorkGraphSnapshot } from "../domain/work-graph-contract.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import { WORK_LEDGER_STATUSES } from "./work-ledger-values.js";
import { createRoleContextEvidenceCatalogAdapter } from "./role-context-evidence-catalog.js";
import { normalizeRecordedDeliveryFailure } from "./work-ledger-delivery-failure.js";
import { normalizeRecordedDecisionFailure } from './work-ledger-decision-failure.js';
import { normalizeRecordedProposalFailure } from './work-ledger-proposal-failure.js';
import {
  RoleContextAssemblerError,
  roleContextError,
} from "./role-context-error.js";
import {
  normalizePullRequestInputBinding,
  normalizePullRequestWorkSource,
} from "./work-ledger-pr-source.js";

export { RoleContextAssemblerError };

const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PULL_REQUEST_CONTEXT_BYTES = 96 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_ENTRIES = 500;
const MAX_ROOT_DELIVERABLE_SLOTS = 4;
const MAX_ROOT_DELIVERY_PAYLOADS = 1;
const MAX_SPECIALIST_REJECTION_REASON_BYTES = 4 * 1024;
const MAX_SPECIALIST_REJECTION_EVIDENCE = 8;
const MAX_ROOT_CHILD_DESCRIPTION_BYTES = 512;
const MAX_ROOT_RETURNED_TASKS = 4;
const ORCHESTRATOR_ROLE_ID = "orchestrator";
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,254}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESPONSIBILITY_TYPES = new Set(["role", "person", "node"]);
const FACT_NAMES = Object.freeze([
  "action-state",
  "ci-status",
  "merge-state",
  "next-action",
  "review-decision",
  "state",
]);
const ISSUE_FACT_NAMES = Object.freeze([
  "issue-description",
  "issue-comments-count",
  "issue-latest-comment",
]);
const DATA_CLASS_BY_DELIVERABLE_KIND = new Map([
  ["requirement-spec", "requirements"],
  ["text-report", "requirements"],
  ["change-package", "code"],
  ["test-report", "code"],
  ["review-report", "code"],
  ["github-review", "code"],
]);

function contextError(code, message, statusCode, options) {
  return roleContextError(code, message, statusCode, options);
}

function invalid(message = "Role context input is invalid", options) {
  return contextError("ROLE_CONTEXT_INVALID", message, 400, options);
}

function ownData(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} is invalid`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} is invalid`);
    }
    entries.push([key, descriptor.value]);
  }
  return new Map(entries);
}

function exactData(value, keys, name) {
  const entries = ownData(value, name);
  if (
    entries.size !== keys.length ||
    keys.some((key) => !entries.has(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return entries;
}

function denseArray(value, name, maximum = MAX_CANONICAL_ENTRIES) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} is invalid`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} is invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value, name, maximumBytes = 16 * 1024) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function nullableText(value, name, maximumBytes) {
  return value === null ? null : text(value, name, maximumBytes);
}

function identifier(value, name, maximumBytes = 256) {
  const normalized = text(value, name, maximumBytes);
  if (!SAFE_ID.test(normalized)) throw invalid(`${name} is invalid`);
  return normalized;
}

function positiveRevision(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function truncateUtf8(value, maximumBytes) {
  if (value === null || Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalValue(value, depth = 0) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw invalid("Role context data is too deep");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (
      INVALID_CONTROL.test(value) ||
      Buffer.byteLength(value, "utf8") > 512 * 1024
    ) {
      throw invalid("Role context text is invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return denseArray(value, "Role context array").map((entry) =>
      canonicalValue(entry, depth + 1)
    );
  }
  const entries = [...ownData(value, "Role context object").entries()];
  if (entries.length > MAX_CANONICAL_ENTRIES) {
    throw invalid("Role context object is too large");
  }
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [
        text(key, "Role context key", 128),
        canonicalValue(entry, depth + 1),
      ]),
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function bindPortMethod(value, method, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  throw new TypeError(`${name} is invalid`);
}

function requireGraphReader(value) {
  return Object.freeze({
    getSnapshot: bindPortMethod(value, "getSnapshot", "graphReader"),
  });
}

function optionalFactSource(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    read: bindPortMethod(value, "read", "factSource"),
  });
}

function optionalPullRequestContextReader(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    read: bindPortMethod(value, "read", "pullRequestContextReader"),
  });
}

function optionalMemoryQueryReader(value) {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    readContext: bindPortMethod(value, "readContext", "memoryQueryReader"),
  });
}

async function readFailedCodeJobContext(reader, item, signal) {
  if (!reader || item.sourceBinding === null ||
      item.decisionContext?.source !== "proposal" || item.decisionContext.outcome !== "failed" ||
      item.decisionContext.value?.kind !== "code_action_proposal") return null;
  const result = await reader.read({
    itemId: item.taskId,
    inputBinding: createPullRequestExecutionBinding({ sourceBinding: item.sourceBinding, event: item.event }),
    decisionContext: item.decisionContext,
    ...(signal === undefined ? {} : { signal }),
  });
  signal?.throwIfAborted();
  return result === null ? null : canonicalValue(result);
}

function normalizeTarget(value, name) {
  const fields = exactData(value, ["type", "id"], name);
  const type = fields.get("type");
  if (!RESPONSIBILITY_TYPES.has(type)) throw invalid(`${name} is invalid`);
  return {
    type,
    id: text(fields.get("id"), `${name}.id`, 128),
  };
}

function inheritedPullRequestInputBinding(fields) {
  if (!fields.has("kind") || fields.get("kind") !== "graph_task") {
    return null;
  }
  if (!fields.has("assignment")) throw invalid("item is invalid");
  const assignment = ownData(fields.get("assignment"), "item.assignment");
  if (!assignment.has("graphTask")) throw invalid("item assignment is invalid");
  const graphTask = ownData(
    assignment.get("graphTask"),
    "item.assignment.graphTask",
  );
  if (!graphTask.has("sourceBinding")) {
    throw invalid("item source binding is invalid");
  }
  const sourceBinding = graphTask.get("sourceBinding");
  if (sourceBinding === null) return null;
  try {
    return normalizePullRequestInputBinding(sourceBinding);
  } catch (cause) {
    throw invalid("item source binding is invalid", { cause });
  }
}

function normalizeItem(value) {
  const fields = ownData(value, "item");
  for (const key of [
    "itemId",
    "revision",
    "inputDigest",
    "assignmentId",
    "currentTarget",
    "decisionContext",
    "event",
  ]) {
    if (!fields.has(key)) throw invalid("item is invalid");
  }
  let source = null;
  if (fields.has("source") && fields.get("source") !== null) {
    try {
      source = normalizePullRequestWorkSource(fields.get("source"));
    } catch (cause) {
      throw invalid("item source is invalid", { cause });
    }
  }
  const taskId = identifier(fields.get("itemId"), "item.itemId", 192);
  let sourceBinding = inheritedPullRequestInputBinding(fields);
  if (source !== null) {
    const revision = source.revisions[source.activeRevision - 1];
    sourceBinding = normalizePullRequestInputBinding({
      kind: "pull_request",
      rootItemId: taskId,
      workKey: source.workKey,
      inputRevision: source.activeRevision,
      headRevision: revision.headRevision,
      headRefOid: source.current.headRefOid,
      eventId: source.current.eventId,
      eventDigest: source.current.eventDigest,
      inputDigest: source.current.inputDigest,
    });
  }
  const rawEvent = canonicalValue(
    source === null ? fields.get("event") : source.current.event,
  );
  let event = rawEvent;
  if (sourceBinding !== null) {
    try {
      event = normalizeStoredWorkflowEvent(rawEvent);
    } catch (cause) {
      throw invalid("item source event is invalid", { cause });
    }
  }
  const eventFields = ownData(event, "item.event");
  const eventId = identifier(eventFields.get("eventId"), "eventId", 512);
  const eventType = text(eventFields.get("eventType"), "eventType", 128);
  const inputDigest = digest(fields.get("inputDigest"), "item.inputDigest");
  if (source !== null && inputDigest !== source.current.inputDigest) {
    throw invalid("item source input is stale");
  }
  if (
    sourceBinding !== null &&
    (
      eventId !== sourceBinding.eventId ||
      event.contentDigest !== sourceBinding.eventDigest ||
      event.payload?.headRefOid !== sourceBinding.headRefOid ||
      !eventType.startsWith("pull_request.")
    )
  ) {
    throw invalid("item source event is stale");
  }
  return {
    taskId,
    taskRevision: positiveRevision(fields.get("revision"), "item.revision"),
    inputDigest,
    assignmentId: identifier(
      fields.get("assignmentId"),
      "item.assignmentId",
      512,
    ),
    currentTarget: normalizeTarget(fields.get("currentTarget"), "currentTarget"),
    decisionContext: canonicalValue(fields.get("decisionContext")),
    event,
    eventId,
    eventType,
    sourceBinding,
    source,
  };
}

function classifyDeliverable(kind) {
  const normalized = identifier(kind, "deliverable.kind", 128);
  const dataClass = DATA_CLASS_BY_DELIVERABLE_KIND.get(normalized);
  if (!dataClass) {
    throw contextError(
      "ROLE_CONTEXT_CLASSIFICATION_REQUIRED",
      `No data class is registered for deliverable kind ${normalized}`,
      403,
    );
  }
  return { kind: normalized, dataClass };
}

function classifyContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria,
    expectedDeliverables: contract.expectedDeliverables.map((deliverable) => ({
      ...deliverable,
      ...classifyDeliverable(deliverable.kind),
    })),
  };
}

function publicContract(contract) {
  return {
    revision: contract.revision,
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
    })),
    expectedDeliverables: contract.expectedDeliverables.map(
      ({ dataClass: _dataClass, ...deliverable }) => ({ ...deliverable }),
    ),
  };
}

function normalizeDispatchFailure(value, task) {
  const code = ownData(value, "dispatch failure").get("code");
  if (code !== "delivery-evidence-incompatible") {
    const failure = exactData(value, ["intentId", "code", "downstreamCreated"], "dispatch failure");
    if (!["conflict-source-stale", "policy-binding-invalid"].includes(code) || failure.get("downstreamCreated") !== false) throw invalid("dispatch failure is invalid");
    return { intentId: identifier(failure.get("intentId"), "dispatchFailure.intentId"), code, downstreamCreated: false };
  }
  const failure = exactData(value, ["intentId", "code", "downstreamCreated", "operation", "contractRevision",
    "contractDigest", "compatibleEvidenceKinds", "expectedDeliverables"], "dispatch failure");
  const operation = failure.get("operation"), contract = task?.acceptanceContracts.at(-1);
  if (failure.get("downstreamCreated") !== false || !["inspect", "verify", "modify"].includes(operation) || !contract ||
      failure.get("contractRevision") !== contract.revision ||
      digest(failure.get("contractDigest"), "dispatchFailure.contractDigest") !== deliveryAcceptanceContractDigest(contract)) throw invalid("dispatch failure contract is stale");
  const kinds = denseArray(failure.get("compatibleEvidenceKinds"), "dispatch failure evidence kinds", 2).map(value => identifier(value, "evidence kind"));
  const expected = denseArray(failure.get("expectedDeliverables"), "dispatch failure deliverables", 100).map(value => {
    const entry = exactData(value, ["deliverableId", "kind"], "dispatch failure deliverable");
    return { deliverableId: identifier(entry.get("deliverableId"), "deliverableId"), kind: identifier(entry.get("kind"), "kind") };
  });
  if (JSON.stringify(kinds) !== JSON.stringify(deliveryEvidenceKindsForProposal({ kind: "code_action_proposal", operation })) ||
      JSON.stringify(expected) !== JSON.stringify(contract.expectedDeliverables.map(({ deliverableId, kind }) => ({ deliverableId, kind }))) ||
      expected.some(({ kind }) => kinds.includes(kind))) throw invalid("dispatch failure action is compatible");
  return { intentId: identifier(failure.get("intentId"), "dispatchFailure.intentId"), code, downstreamCreated: false,
    operation, contractRevision: contract.revision, contractDigest: failure.get("contractDigest"),
    compatibleEvidenceKinds: kinds, expectedDeliverables: expected };
}

function normalizeCoordinationReturn(value, taskId, tasksById) {
  if (value == null) return null;
  const fields = exactData(value, ['kind', 'rootTaskId', 'handoff'], 'coordination return');
  const rootTaskId = identifier(fields.get('rootTaskId'), 'coordination return root');
  let task = tasksById.get(taskId);
  if (!task || fields.get('kind') !== 'parent_coordination' || task.parentTaskId === null ||
      task?.responsibility.type !== 'role' || task.responsibility.id !== 'orchestrator') throw invalid('coordination return task is invalid');
  while (task?.parentTaskId != null) task = tasksById.get(task.parentTaskId);
  if (task?.taskId !== rootTaskId || task.responsibility.type !== 'role' ||
      task.responsibility.id !== 'orchestrator') throw invalid('coordination return root is invalid');
  let handoff = null;
  if (fields.get('handoff') !== null) {
    const report = exactData(fields.get('handoff'), ['brief', 'reason', 'evidence', 'evidenceAuthority'], 'coordination return report');
    if (report.get('evidenceAuthority') !== 'specialist_report') throw invalid('coordination return report authority is invalid');
    handoff = {
      brief: text(report.get('brief'), 'coordination return brief', 4096),
      reason: text(report.get('reason'), 'coordination return reason', 4096),
      evidence: denseArray(report.get('evidence'), 'coordination return evidence', 20)
        .map(entry => text(entry, 'coordination return evidence entry', 2048)),
      evidenceAuthority: 'specialist_report',
    };
  }
  return { kind: 'parent_coordination', rootTaskId, handoff };
}

function normalizeSnapshot(value) {
  const snapshot = exactData(
    value,
    ["schemaVersion", "graph", "taskStates"],
    "graph snapshot",
  );
  if (snapshot.get("schemaVersion") !== 1) {
    throw invalid("graph snapshot schemaVersion is invalid");
  }
  let graph;
  try {
    graph = normalizeWorkGraphSnapshot(snapshot.get("graph"));
  } catch (cause) {
    throw invalid("graph snapshot is invalid", { cause });
  }
  const tasksById = new Map(
    graph.tasks.map((task) => [task.taskId, task]),
  );

  const states = denseArray(snapshot.get("taskStates"), "taskStates", 5_000);
  const statesById = new Map();
  for (const entry of states) {
    const fields = ownData(entry, "task state");
    for (const key of ["taskId", "taskRevision", "work"]) {
      if (!fields.has(key)) throw invalid("task state is invalid");
    }
    const taskId = identifier(fields.get("taskId"), "taskState.taskId");
    const ledgerStatus = fields.get("ledgerStatus") ?? null;
    if (ledgerStatus !== null && !WORK_LEDGER_STATUSES.has(ledgerStatus)) {
      throw invalid("taskState.ledgerStatus is invalid");
    }
    const work = exactData(fields.get("work"), ["title", "description"], "task work");
    let dispatchFailure = null;
    let deliveryFailure = null;
    let decisionFailure = null;
    let proposalFailure = null;
    if (ledgerStatus === "blocked" && fields.get("statusReason") === "intent_failed" && fields.get("dispatchFailure") != null) {
      dispatchFailure = normalizeDispatchFailure(fields.get("dispatchFailure"), tasksById.get(taskId));
    }
    if (ledgerStatus === "blocked" && fields.get("statusReason") === "delivery_attempts_exhausted" && fields.get("deliveryFailure") != null) {
      deliveryFailure = normalizeRecordedDeliveryFailure(fields.get("deliveryFailure"), fields.get("taskRevision"));
      if (deliveryFailure === null) throw invalid("delivery failure binding is invalid");
    }
    if (ledgerStatus === 'blocked' && fields.get('statusReason') === 'decision_attempts_exhausted' && fields.get('decisionFailure') != null) {
      decisionFailure = normalizeRecordedDecisionFailure(fields.get('decisionFailure'), fields.get('taskRevision'));
      if (decisionFailure === null) throw invalid('decision failure binding is invalid');
    }
    if (ledgerStatus === 'blocked' && fields.get('statusReason') === 'proposal_failed' && fields.get('proposalFailure') != null) {
      proposalFailure = normalizeRecordedProposalFailure(fields.get('proposalFailure'), fields.get('taskRevision'));
      if (proposalFailure === null) throw invalid('proposal failure binding is invalid');
    }
    if (statesById.has(taskId)) throw invalid("task state IDs are duplicated");
    statesById.set(taskId, {
      taskId,
      taskRevision: positiveRevision(
        fields.get("taskRevision"),
        "taskState.taskRevision",
      ),
      ledgerStatus,
      blockingCondition: ledgerStatus === "blocked" && fields.get("statusReason") === "proposal_stale"
        ? "proposal-stale" : dispatchFailure?.code ?? deliveryFailure?.code ?? decisionFailure?.code ?? proposalFailure?.code ?? null,
      dispatchFailure,
      deliveryFailure,
      decisionFailure,
      proposalFailure,
      coordinationReturn: normalizeCoordinationReturn(fields.get('coordinationReturn'), taskId, tasksById),
      work: {
        title: nullableText(work.get("title"), "work.title", 256),
        description: nullableText(
          work.get("description"),
          "work.description",
          16 * 1_024,
        ),
      },
    });
  }
  return {
    graphId: graph.graphId,
    graphRevision: graph.revision,
    graphContentDigest: graph.contentDigest,
    tasksById,
    statesById,
  };
}

function sameTarget(left, right) {
  return left.type === right.type && left.id === right.id;
}

function rootTaskId(taskId, tasksById) {
  const visited = new Set();
  let current = tasksById.get(taskId);
  while (current) {
    if (visited.has(current.taskId)) throw invalid("graph hierarchy contains a cycle");
    visited.add(current.taskId);
    if (current.parentTaskId === null) return current.taskId;
    current = tasksById.get(current.parentTaskId);
  }
  throw invalid("graph hierarchy contains a missing parent");
}

function assertCurrentBinding({ roleId, item, task, taskState }) {
  if (task.revision !== item.taskRevision || taskState.taskRevision !== task.revision) {
    throw contextError(
      "ROLE_CONTEXT_STALE",
      "The claimed task revision no longer matches the graph",
      409,
    );
  }
  if (!sameTarget(task.responsibility, item.currentTarget)) {
    throw contextError(
      "ROLE_CONTEXT_STALE",
      "The claimed task responsibility no longer matches the work item",
      409,
    );
  }
  if (
    roleId !== "orchestrator" &&
    (task.responsibility.type !== "role" || task.responsibility.id !== roleId)
  ) {
    throw contextError(
      "ROLE_CONTEXT_AUTHORITY_DENIED",
      "The role is not responsible for the claimed task",
      403,
    );
  }
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchingSubmission(deliveries, decision, code, message) {
  const submitted = deliveries[decision.revision - 2];
  if (
    !submitted ||
    submitted.status !== "submitted" ||
    submitted.revision + 1 !== decision.revision ||
    submitted.contractRevision !== decision.contractRevision ||
    submitted.deliverableId !== decision.deliverableId ||
    !sameEvidence(submitted.evidence, decision.evidence)
  ) {
    throw contextError(code, message, 409);
  }
  return submitted;
}

function currentDeliveryState(task) {
  const currentContract = classifyContract(task.acceptanceContracts.at(-1));
  const latestByDeliverable = new Map();
  for (const record of task.deliveries) {
    if (record.contractRevision === currentContract.revision) {
      latestByDeliverable.set(record.deliverableId, record);
    }
  }
  return {
    currentContract,
    deliveries: task.deliveries,
    latestByDeliverable,
  };
}

function acceptedDependency(task) {
  if (task.status !== "completed") {
    throw contextError(
      "ROLE_CONTEXT_DEPENDENCY_NOT_ACCEPTED",
      `Dependency ${task.taskId} is not completed`,
      409,
    );
  }
  const { currentContract, deliveries, latestByDeliverable } =
    currentDeliveryState(task);
  const projected = [];
  const acceptedInputs = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const accepted = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (accepted?.status !== "accepted") {
      if (expectedDelivery.required) {
        throw contextError(
          "ROLE_CONTEXT_DEPENDENCY_NOT_ACCEPTED",
          `Required dependency delivery ${expectedDelivery.deliverableId} is not accepted`,
          409,
        );
      }
      continue;
    }
    const submitted = matchingSubmission(
      deliveries,
      accepted,
      "ROLE_CONTEXT_DEPENDENCY_INVALID",
      `Accepted dependency delivery ${expectedDelivery.deliverableId} has no matching submission`,
    );
    const evidenceDigests = [
      ...new Set(accepted.evidence.map(({ contentDigest }) => contentDigest)),
    ].sort(compareText);
    projected.push({
      dataClass: expectedDelivery.dataClass,
      delivery: {
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        required: expectedDelivery.required,
        submittedDeliveryRevision: submitted.revision,
        decisionRevision: accepted.revision,
        summary: submitted.summary,
        acceptanceReason: accepted.summary,
        evidence: accepted.evidence.map((entry) => ({ ...entry })),
      },
    });
    acceptedInputs.push({
      taskId: task.taskId,
      taskRevision: task.revision,
      contractRevision: currentContract.revision,
      deliverableId: expectedDelivery.deliverableId,
      submittedDeliveryRevision: submitted.revision,
      decisionRevision: accepted.revision,
      evidenceDigests,
    });
  }
  return { contractRevision: currentContract.revision, projected, acceptedInputs };
}

function appendDependency(target, task, contractRevision, deliveries) {
  if (deliveries.length === 0) return;
  target.push({
    taskId: task.taskId,
    taskRevision: task.revision,
    contractRevision,
    deliverables: deliveries.sort((left, right) =>
      compareText(left.deliverableId, right.deliverableId)
    ),
  });
}

function projectDependencies(currentTask, snapshot) {
  const currentRoot = rootTaskId(currentTask.taskId, snapshot.tasksById);
  const requirements = [];
  const code = [];
  const acceptedInputs = [];
  for (const dependencyId of currentTask.dependsOn) {
    const dependency = snapshot.tasksById.get(dependencyId);
    if (!dependency) throw invalid(`Dependency ${dependencyId} does not exist`);
    if (rootTaskId(dependency.taskId, snapshot.tasksById) !== currentRoot) {
      throw contextError(
        "ROLE_CONTEXT_SCOPE_DENIED",
        `Dependency ${dependency.taskId} is outside the current root`,
        403,
      );
    }
    const projection = acceptedDependency(dependency);
    appendDependency(
      requirements,
      dependency,
      projection.contractRevision,
      projection.projected
        .filter(({ dataClass }) => dataClass === "requirements")
        .map(({ delivery: value }) => value),
    );
    appendDependency(
      code,
      dependency,
      projection.contractRevision,
      projection.projected
        .filter(({ dataClass }) => dataClass === "code")
        .map(({ delivery: value }) => value),
    );
    acceptedInputs.push(...projection.acceptedInputs);
  }
  const dependencyOrder = (left, right) => compareText(left.taskId, right.taskId);
  acceptedInputs.sort((left, right) =>
    compareText(
      `${left.taskId}\u0000${left.deliverableId}`,
      `${right.taskId}\u0000${right.deliverableId}`,
    )
  );
  return {
    requirements: requirements.sort(dependencyOrder),
    code: code.sort(dependencyOrder),
    acceptedInputs,
  };
}

function isConfiguredRootOrchestrator(roleId, task) {
  return (
    roleId === ORCHESTRATOR_ROLE_ID &&
    task.parentTaskId === null &&
    task.responsibility.type === "role" &&
    task.responsibility.id === ORCHESTRATOR_ROLE_ID
  );
}

function projectChildDeliveries(task) {
  const { currentContract, deliveries, latestByDeliverable } =
    currentDeliveryState(task);

  const slots = [];
  const payloads = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const latest = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (!latest) {
      slots.push({
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        required: expectedDelivery.required,
        state: "none",
        submittedDeliveryRevision: null,
        decisionRevision: null,
      });
      continue;
    }

    const decision = latest.status === "submitted" ? null : latest;
    const submitted = decision
      ? matchingSubmission(
          deliveries,
          decision,
          "ROLE_CONTEXT_CHILD_DELIVERY_INVALID",
          `Child delivery ${expectedDelivery.deliverableId} has no matching submission`,
        )
      : latest;
    slots.push({
      deliverableId: expectedDelivery.deliverableId,
      kind: expectedDelivery.kind,
      required: expectedDelivery.required,
      state: latest.status,
      submittedDeliveryRevision: submitted.revision,
      decisionRevision: decision?.revision ?? null,
    });
    payloads.push({
      dataClass: expectedDelivery.dataClass,
      payload: {
        taskId: task.taskId,
        taskRevision: task.revision,
        contractRevision: currentContract.revision,
        deliverableId: expectedDelivery.deliverableId,
        kind: expectedDelivery.kind,
        state: latest.status,
        submittedDeliveryRevision: submitted.revision,
        decisionRevision: decision?.revision ?? null,
        summary: submitted.summary,
        decisionReason: decision?.summary ?? null,
        evidence: submitted.evidence.map((entry) => ({ ...entry })),
      },
    });
  }
  return { contractRevision: currentContract.revision, slots, payloads };
}

function projectCurrentTaskRejection(roleId, currentTask, deliveryState) {
  if (
    roleId === ORCHESTRATOR_ROLE_ID ||
    currentTask.parentTaskId === null ||
    currentTask.responsibility.type !== "role" ||
    currentTask.responsibility.id !== roleId
  ) {
    return null;
  }

  const { currentContract, deliveries, latestByDeliverable } = deliveryState;
  const rejected = [];
  for (const expectedDelivery of currentContract.expectedDeliverables) {
    const decision = latestByDeliverable.get(expectedDelivery.deliverableId);
    if (decision?.status !== "rejected") continue;
    const submitted = matchingSubmission(
      deliveries,
      decision,
      "ROLE_CONTEXT_CURRENT_REJECTION_INVALID",
      `Rejected current delivery ${expectedDelivery.deliverableId} has no matching submission`,
    );
    rejected.push({ decision, expectedDelivery, submitted });
  }
  rejected.sort(
    (left, right) =>
      right.decision.revision - left.decision.revision ||
      compareText(
        left.expectedDelivery.deliverableId,
        right.expectedDelivery.deliverableId,
      ),
  );
  const selected = rejected.at(0);
  if (!selected) return null;

  const reason = truncateUtf8(
    selected.decision.summary,
    MAX_SPECIALIST_REJECTION_REASON_BYTES,
  );
  const evidence = selected.decision.evidence.slice(
    0,
    MAX_SPECIALIST_REJECTION_EVIDENCE,
  );
  return {
    dataClass: selected.expectedDelivery.dataClass,
    value: {
      contractRevision: currentContract.revision,
      deliverableId: selected.expectedDelivery.deliverableId,
      kind: selected.expectedDelivery.kind,
      submittedDeliveryRevision: selected.submitted.revision,
      decisionRevision: selected.decision.revision,
      reason,
      reasonTruncated: reason !== selected.decision.summary,
      evidence: evidence.map((entry) => ({ ...entry })),
      hasMoreEvidence: selected.decision.evidence.length > evidence.length,
    },
  };
}

function projectRootCoordination(roleId, currentTask, snapshot, item) {
  if (!isConfiguredRootOrchestrator(roleId, currentTask)) return null;

  const allChildren = [...snapshot.tasksById.values()]
    .filter(({ parentTaskId }) => parentTaskId === currentTask.taskId)
    .sort((left, right) => compareText(left.taskId, right.taskId));
  const supersededChildCount = allChildren.filter(
    ({ status }) => status === "superseded",
  ).length;
  const children = allChildren.filter(
    ({ status }) => status !== "superseded",
  );
  const childIds = new Set(children.map(({ taskId }) => taskId));
  const deliveryPayloads = [];
  let shownReturnReports = 0;
  let shownReturnedTasks = 0;
  const returnsByAncestor = new Map();
  let returnReportCount = 0;
  for (const task of snapshot.tasksById.values()) {
    const returned = snapshot.statesById.get(task.taskId)?.coordinationReturn;
    if (returned?.rootTaskId !== currentTask.taskId) continue;
    if (returned.handoff) returnReportCount++;
    if (childIds.has(task.taskId)) continue;
    let ancestor = task;
    while (ancestor && !childIds.has(ancestor.taskId)) ancestor = snapshot.tasksById.get(ancestor.parentTaskId);
    if (!ancestor) continue;
    const siblings = returnsByAncestor.get(ancestor.taskId) ?? [];
    siblings.push(task);
    returnsByAncestor.set(ancestor.taskId, siblings);
  }
  const projectReturn = returned => {
    const report = returned.handoff;
    // Share the ordinary root payload budget across direct and nested returns.
    const showReport = report != null && shownReturnReports++ === 0;
    return {
      kind: returned.kind, rootTaskId: returned.rootTaskId, hasHandoffReport: report != null,
      ...(showReport ? { handoff: {
        brief: truncateUtf8(report.brief, MAX_ROOT_CHILD_DESCRIPTION_BYTES),
        briefTruncated: Buffer.byteLength(report.brief, 'utf8') > MAX_ROOT_CHILD_DESCRIPTION_BYTES,
        reason: truncateUtf8(report.reason, MAX_ROOT_CHILD_DESCRIPTION_BYTES),
        reasonTruncated: Buffer.byteLength(report.reason, 'utf8') > MAX_ROOT_CHILD_DESCRIPTION_BYTES,
        evidence: report.evidence.slice(0, MAX_SPECIALIST_REJECTION_EVIDENCE)
          .map(entry => truncateUtf8(entry, MAX_ROOT_CHILD_DESCRIPTION_BYTES)),
        evidenceTruncated: report.evidence.slice(0, MAX_SPECIALIST_REJECTION_EVIDENCE)
          .some(entry => Buffer.byteLength(entry, 'utf8') > MAX_ROOT_CHILD_DESCRIPTION_BYTES),
        hasMoreEvidence: report.evidence.length > MAX_SPECIALIST_REJECTION_EVIDENCE,
        evidenceAuthority: 'specialist_report',
      } } : {}),
    };
  };
  const directChildren = children.map((child) => {
    const taskState = snapshot.statesById.get(child.taskId);
    if (!taskState || taskState.taskRevision !== child.revision) {
      throw contextError(
        "ROLE_CONTEXT_STALE",
        `Child task ${child.taskId} no longer matches its graph state`,
        409,
      );
    }
    const deliveries = projectChildDeliveries(child);
    deliveryPayloads.push(
      ...deliveries.payloads.filter(({ payload }) => payload.state === "submitted"),
    );
    const visibleDeliverables = deliveries.slots.slice(
      0,
      MAX_ROOT_DELIVERABLE_SLOTS,
    );
    const returned = taskState.coordinationReturn;
    const descendants = (returnsByAncestor.get(child.taskId) ?? []).sort((left, right) => compareText(left.taskId, right.taskId));
    const descendantReturns = descendants.slice(0, Math.max(0, MAX_ROOT_RETURNED_TASKS - shownReturnedTasks)).map(task => {
      shownReturnedTasks++;
      const state = snapshot.statesById.get(task.taskId), contract = projectChildDeliveries(task);
      return { taskId: task.taskId, taskRevision: task.revision, parentTaskId: task.parentTaskId,
        ledgerStatus: state.ledgerStatus, contractRevision: contract.contractRevision,
        deliverableCount: contract.slots.length, hasMoreDeliverables: contract.slots.length > MAX_ROOT_DELIVERABLE_SLOTS,
        deliverables: contract.slots.slice(0, MAX_ROOT_DELIVERABLE_SLOTS),
        coordinationReturn: projectReturn(state.coordinationReturn) };
    });
    return {
      taskId: child.taskId,
      taskRevision: child.revision,
      status: child.status,
      ledgerStatus: taskState.ledgerStatus,
      blockingCondition: taskState.blockingCondition,
      ...(taskState.dispatchFailure === null ? {} : { dispatchFailure: { ...taskState.dispatchFailure } }),
      ...(taskState.deliveryFailure === null ? {} : { deliveryFailure: { ...taskState.deliveryFailure } }),
      ...(taskState.decisionFailure === null ? {} : { decisionFailure: { ...taskState.decisionFailure } }),
      ...(taskState.proposalFailure === null ? {} : { proposalFailure: { ...taskState.proposalFailure } }),
      ...(returned === null ? {} : { coordinationReturn: projectReturn(returned) }),
      ...(descendants.length === 0 ? {} : { descendantCoordinationReturns: {
        count: descendants.length, tasks: descendantReturns, hasMore: descendants.length > descendantReturns.length,
      } }),
      responsibility: { ...child.responsibility },
      work: {
        title: taskState.work.title,
        description: truncateUtf8(
          taskState.work.description,
          MAX_ROOT_CHILD_DESCRIPTION_BYTES,
        ),
      },
      directDependencyTaskIds: child.dependsOn.filter((taskId) =>
        childIds.has(taskId)
      ),
      hasOtherDependencies: child.dependsOn.some((taskId) =>
        !childIds.has(taskId)
      ),
      contractRevision: deliveries.contractRevision,
      deliverableCount: deliveries.slots.length,
      hasMoreDeliverables:
        deliveries.slots.length > visibleDeliverables.length,
      hasAcceptedRequiredReview: deliveries.slots.some(({ kind, required, state }) =>
        required && state === "accepted" && ["review-report", "github-review"].includes(kind)),
      deliverables: visibleDeliverables,
    };
  });
  const payloadOrder = (left, right) =>
    compareText(
      `${left.taskId}\u0000${left.deliverableId}`,
      `${right.taskId}\u0000${right.deliverableId}`,
    );
  const sortedPayloads = deliveryPayloads.sort(({ payload: left }, { payload: right }) =>
    payloadOrder(left, right)
  );
  const selectedPayloads = sortedPayloads.slice(0, MAX_ROOT_DELIVERY_PAYLOADS);
  const requirements = selectedPayloads
    .filter(({ dataClass }) => dataClass === "requirements")
    .map(({ payload }) => payload);
  const code = selectedPayloads
    .filter(({ dataClass }) => dataClass === "code")
    .map(({ payload }) => payload);
  const goalControl = coordinatorGoalControl({ rootTaskId: currentTask.taskId, parentTaskId: currentTask.parentTaskId,
    event: item.event, source: item.source, childTaskIds: directChildren.map(child => child.taskId) });
  return {
    coordination: {
      schemaVersion: 2,
      rootTaskId: currentTask.taskId,
      ...(goalControl === null ? {} : { goalControl }),
      directChildren,
      history: {
        supersededChildCount,
      },
      deliveryWindow: {
        pendingCount: sortedPayloads.length,
        shownCount: selectedPayloads.length,
        hasMore: sortedPayloads.length > selectedPayloads.length,
      },
      ...(returnReportCount === 0 ? {} : { returnReportWindow: {
        pendingCount: returnReportCount, shownCount: Math.min(shownReturnReports, 1), hasMore: returnReportCount > Math.min(shownReturnReports, 1),
      } }),
    },
    requirements,
    code,
  };
}

function normalizeFactObservation(value, name) {
  const fields = exactData(
    value,
    ["healthy", "fresh", "value", "observedAt"],
    `fact ${name}`,
  );
  if (
    typeof fields.get("healthy") !== "boolean" ||
    typeof fields.get("fresh") !== "boolean"
  ) {
    throw invalid(`fact ${name} is invalid`);
  }
  if (
    fields.get("healthy") !== true ||
    fields.get("fresh") !== true ||
    fields.get("value") === null ||
    fields.get("value") === ""
  ) {
    return null;
  }
  const maximumBytes = name === "issue-description"
    ? 16 * 1024
    : name === "issue-latest-comment"
      ? 8 * 1024
      : 4 * 1024;
  const valueText = text(fields.get("value"), `fact ${name}.value`, maximumBytes);
  const observedAt = fields.get("observedAt");
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(Date.parse(observedAt)).toISOString() !== observedAt
  ) {
    throw invalid(`fact ${name}.observedAt is invalid`);
  }
  return { name, value: valueText, observedAt };
}

async function readFacts(factSource, event, signal) {
  signal?.throwIfAborted();
  if (!factSource) return [];
  const facts = [];
  const names = event.eventType.startsWith("issue.")
    ? [...FACT_NAMES, ...ISSUE_FACT_NAMES]
    : FACT_NAMES;
  for (const name of names) {
    signal?.throwIfAborted();
    let observation;
    try {
      observation = await factSource.read(
        {
          item: { event: structuredClone(event) },
          fact: name,
        },
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw contextError(
        "ROLE_CONTEXT_FACT_UNAVAILABLE",
        `Unable to read current fact ${name}`,
        503,
        { cause },
      );
    }
    signal?.throwIfAborted();
    const normalized = normalizeFactObservation(observation, name);
    if (normalized) facts.push(normalized);
  }
  return facts;
}

function normalizePullRequestContext(value) {
  const normalized = canonicalValue(value);
  const hasReviewMaterial = Object.hasOwn(normalized, "reviewMaterial");
  const hasMaterialDigest = Object.hasOwn(normalized, "materialDigest");
  const fields = exactData(
    normalized,
    [
      "schemaVersion",
      "identityDigest",
      "contentDigest",
      "observedAt",
      "summary",
      "comments",
      "reviews",
      "reviewThreads",
      "checks",
      "contextTruncated",
      ...(hasReviewMaterial ? ["reviewMaterial"] : []),
      ...(hasMaterialDigest ? ["materialDigest"] : []),
    ],
    "pullRequest context",
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    typeof fields.get("contextTruncated") !== "boolean"
  ) {
    throw invalid("pullRequest context is invalid");
  }
  if (hasReviewMaterial) {
    const material = exactData(
      fields.get("reviewMaterial"),
      [
        "schemaVersion",
        "gitTarget",
        "additions",
        "deletions",
        "changedFiles",
        "files",
        "filesTruncated",
        "patch",
        "patchTruncated",
      ],
      "pullRequest review material",
    );
    const files = material.get("files");
    if (
      material.get("schemaVersion") !== 1 ||
      typeof material.get("patch") !== "string" ||
      /\u0000/u.test(material.get("patch")) ||
      typeof material.get("patchTruncated") !== "boolean" ||
      typeof material.get("filesTruncated") !== "boolean" ||
      !Array.isArray(files) ||
      files.length > 100 ||
      !["additions", "deletions", "changedFiles"].every((name) =>
        Number.isSafeInteger(material.get(name)) && material.get(name) >= 0)
    ) {
      throw invalid("pullRequest review material is invalid");
    }
    try {
      normalizePullRequestGitTarget(material.get("gitTarget"));
    } catch (cause) {
      throw invalid("pullRequest review material is invalid", { cause });
    }
    for (const [index, file] of files.entries()) {
      const entry = exactData(
        file,
        ["path", "additions", "deletions"],
        `pullRequest review material file ${index}`,
      );
      if (
        typeof entry.get("path") !== "string" ||
        entry.get("path").length === 0 ||
        INVALID_CONTROL.test(entry.get("path")) ||
        Buffer.byteLength(entry.get("path"), "utf8") > 2_048 ||
        !["additions", "deletions"].every((name) =>
          Number.isSafeInteger(entry.get(name)) && entry.get(name) >= 0)
      ) {
        throw invalid("pullRequest review material file is invalid");
      }
    }
  }
  digest(fields.get("identityDigest"), "pullRequest.identityDigest");
  digest(fields.get("contentDigest"), "pullRequest.contentDigest");
  if (hasMaterialDigest) digest(fields.get("materialDigest"), "pullRequest.materialDigest");
  const observedAt = fields.get("observedAt");
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(Date.parse(observedAt)).toISOString() !== observedAt ||
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
      MAX_PULL_REQUEST_CONTEXT_BYTES
  ) {
    throw invalid("pullRequest context is invalid");
  }
  return normalized;
}

async function readPullRequestContext(reader, item, signal) {
  signal?.throwIfAborted();
  if (!item.eventType.startsWith("pull_request.") || reader === null) {
    return null;
  }
  if (item.sourceBinding === null) {
    throw contextError(
      "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
      "Current PR task has no exact source binding",
      503,
    );
  }
  try {
    const value = await reader.read(
      {
        sourceBinding: item.sourceBinding,
        event: item.event,
      },
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    const normalized = normalizePullRequestContext(value);
    if (normalized.reviewMaterial) {
      let executionBinding;
      try {
        executionBinding = createPullRequestExecutionBinding({
          sourceBinding: item.sourceBinding,
          event: item.event,
        });
      } catch (cause) {
        throw contextError(
          "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
          "PR review material requires an atomic execution binding",
          503,
          { cause },
        );
      }
      if (
        executionBinding.schemaVersion !== 2 ||
        !samePullRequestGitTarget(
          normalizePullRequestGitTarget(normalized.reviewMaterial.gitTarget),
          executionBinding.gitTarget,
        )
      ) {
        throw contextError(
          "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
          "PR review material does not match the exact source binding",
          503,
        );
      }
    }
    return normalized;
  } catch (cause) {
    signal?.throwIfAborted();
    if (
      cause instanceof RoleContextAssemblerError &&
      cause.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE"
    ) {
      throw cause;
    }
    throw contextError(
      "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
      "Unable to read bounded PR task facts",
      503,
      { cause },
    );
  }
}

async function readMemoryQueryContext(reader, roleId, item, signal) {
  signal?.throwIfAborted();
  if (reader === null) return null;
  try {
    const result = await reader.readContext({
      roleId,
      item: {
        itemId: item.taskId,
        itemRevision: item.taskRevision,
        inputDigest: item.inputDigest,
        currentTarget: { ...item.currentTarget },
      },
    });
    signal?.throwIfAborted();
    return result === null ? null : canonicalValue(result);
  } catch (cause) {
    signal?.throwIfAborted();
    let code = null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      code = descriptor && "value" in descriptor ? descriptor.value : null;
    } catch {
      // Untrusted errors collapse to the unavailable classification below.
    }
    if (code === "AGENT_MEMORY_QUERY_CITATION_STALE") {
      throw contextError(
        "ROLE_CONTEXT_MEMORY_STALE",
        "The persisted agent memory answer no longer has current citations",
        409,
        { cause },
      );
    }
    throw contextError(
      "ROLE_CONTEXT_MEMORY_UNAVAILABLE",
      "Unable to read the persisted agent memory answer",
      503,
      { cause },
    );
  }
}

function assertPacketSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTEXT_BYTES) {
    throw contextError(
      "ROLE_CONTEXT_TOO_LARGE",
      "Role context exceeds 128 KiB",
      413,
    );
  }
}

export class RoleContextAssembler {
  #graphReader;
  #factSource;
  #pullRequestContextReader;
  #memoryQueryReader;
  #evidenceCatalogAdapter;
  #failedCodeJobContextReader;
  #internalReviewHandoffReader;
  #originalRepairFeedbackReader;
  #conflictInspectionReader;
  #ciDiagnosticReader;
  #settlementInputAuthorityVerifier;
  #settlementEvidenceVerifier;
  #publicationReuseReader;

  constructor({
    graphReader,
    factSource,
    pullRequestContextReader,
    memoryQueryReader,
    evidenceCatalog,
    failedCodeJobContextReader,
    internalReviewHandoffReader,
    originalRepairFeedbackReader,
    conflictInspectionReader,
    ciDiagnosticReader,
    settlementInputAuthorityVerifier,
    settlementEvidenceVerifier,
    publicationReuseReader,
  } = {}) {
    this.#graphReader = requireGraphReader(graphReader);
    this.#settlementInputAuthorityVerifier = settlementInputAuthorityVerifier == null ? null :
      bindPortMethod(settlementInputAuthorityVerifier, "verify", "settlementInputAuthorityVerifier");
    this.#settlementEvidenceVerifier = settlementEvidenceVerifier == null ? null :
      bindPortMethod(settlementEvidenceVerifier, "verify", "settlementEvidenceVerifier");
    this.#publicationReuseReader = publicationReuseReader == null ? null :
      bindPortMethod(publicationReuseReader, "listCandidates", "publicationReuseReader");
    this.#factSource = optionalFactSource(factSource);
    this.#pullRequestContextReader = optionalPullRequestContextReader(
      pullRequestContextReader,
    );
    this.#memoryQueryReader = optionalMemoryQueryReader(memoryQueryReader);
    this.#failedCodeJobContextReader = failedCodeJobContextReader == null ? null : Object.freeze({
      read: bindPortMethod(failedCodeJobContextReader, "read", "failedCodeJobContextReader"),
    });
    this.#internalReviewHandoffReader = internalReviewHandoffReader == null ? null : Object.freeze({
      read: bindPortMethod(internalReviewHandoffReader, "read", "internalReviewHandoffReader"),
    });
    this.#originalRepairFeedbackReader = originalRepairFeedbackReader == null ? null : Object.freeze({
      readBinding: bindPortMethod(originalRepairFeedbackReader, "readBinding", "originalRepairFeedbackReader"),
    });
    this.#conflictInspectionReader = conflictInspectionReader == null ? null : Object.freeze({
      read: bindPortMethod(conflictInspectionReader, "read", "conflictInspectionReader"),
    });
    this.#ciDiagnosticReader = ciDiagnosticReader == null ? null : Object.freeze({
      read: bindPortMethod(ciDiagnosticReader, "read", "ciDiagnosticReader"),
    });
    this.#evidenceCatalogAdapter =
      createRoleContextEvidenceCatalogAdapter(evidenceCatalog);
    Object.freeze(this);
  }

  async assemble(value) {
    const input = ownData(value, "assemble input");
    const assembleKeys = input.has("signal")
      ? ["roleId", "item", "trigger", "signal"]
      : ["roleId", "item", "trigger"];
    if (
      input.size !== assembleKeys.length ||
      assembleKeys.some((key) => !input.has(key))
    ) {
      throw invalid("assemble input is invalid");
    }
    const roleId = text(input.get("roleId"), "roleId", 128);
    if (!SAFE_ROLE_ID.test(roleId)) throw invalid("roleId is invalid");
    const trigger = text(input.get("trigger"), "trigger", 128);
    const item = normalizeItem(input.get("item"));
    const signal = input.get("signal");
    if (
      signal !== undefined &&
      (
        signal === null ||
        typeof signal !== "object" ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function" ||
        typeof signal.throwIfAborted !== "function"
      )
    ) {
      throw invalid("signal is invalid");
    }
    signal?.throwIfAborted();

    let snapshotValue;
    try {
      snapshotValue = await this.#graphReader.getSnapshot(
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw contextError(
        "ROLE_CONTEXT_GRAPH_UNAVAILABLE",
        "Unable to read the work graph",
        503,
        { cause },
      );
    }
    signal?.throwIfAborted();
    const snapshot = normalizeSnapshot(snapshotValue);
    signal?.throwIfAborted();
    const currentTask = snapshot.tasksById.get(item.taskId);
    const taskState = snapshot.statesById.get(item.taskId);
    if (!currentTask || !taskState) {
      throw contextError(
        "ROLE_CONTEXT_STALE",
        "The claimed task no longer exists in the graph",
        409,
      );
    }
    assertCurrentBinding({ roleId, item, task: currentTask, taskState });

    const deliveryState = currentDeliveryState(currentTask);
    const { currentContract } = deliveryState;
    const currentAcceptanceContract = publicContract(currentContract);
    const dependencies = projectDependencies(currentTask, snapshot);
    const coordination = projectRootCoordination(roleId, currentTask, snapshot, item);
    const currentTaskRejection = projectCurrentTaskRejection(
      roleId,
      currentTask,
      deliveryState,
    );
    const reviewPublicationSettlement = await this.#readReviewPublicationSettlement(roleId, item, currentTask, snapshot, signal);
    const [facts, authoritativeEvidence, pullRequest, memoryQuery, failedExecution, internalReview] = await Promise.all([
      readFacts(this.#factSource, item.event, signal),
      this.#evidenceCatalogAdapter.read({
        roleId,
        taskId: currentTask.taskId,
        acceptanceContract: currentAcceptanceContract,
        signal,
      }),
      reviewPublicationSettlement === null ? readPullRequestContext(this.#pullRequestContextReader, item, signal) : null,
      readMemoryQueryContext(this.#memoryQueryReader, roleId, item, signal),
      readFailedCodeJobContext(this.#failedCodeJobContextReader, item, signal),
      roleId === "pr-engineer" && this.#internalReviewHandoffReader !== null
        ? this.#internalReviewHandoffReader.read({ itemId: item.taskId }) : null,
    ]);
    signal?.throwIfAborted();
    if (internalReview !== null && internalReview.headRefOid !== item.event.payload?.headRefOid) {
      throw contextError("ROLE_CONTEXT_STALE", "内部复审交接已不属于当前 Head", 409);
    }
    let conflictInspection = null;
    if (roleId === "developer" && (item.event.payload?.nextAction === "resolve_conflict" ||
        isInternalRepairReviewEvent(item.event) || isOwnerRequestedCiRepairEvent(item.event)) && this.#conflictInspectionReader) {
      try {
        conflictInspection = await this.#conflictInspectionReader.read({ itemId: item.taskId,
          itemRevision: item.taskRevision, inputDigest: item.inputDigest });
        signal?.throwIfAborted();
        if (conflictInspection !== null) {
          const expectedBinding = createPullRequestExecutionBinding({ sourceBinding: item.sourceBinding, event: item.event });
          const preparation = normalizeConflictPreparationBinding(conflictInspection.preparationBinding);
          if (!samePullRequestExecutionBinding(conflictInspection.inputBinding, expectedBinding) ||
              !samePullRequestGitTarget(preparation.gitTarget, expectedBinding.gitTarget)) throw new TypeError("Conflict inspection binding changed");
          conflictInspection = canonicalValue(conflictInspection);
        }
      } catch (cause) {
        signal?.throwIfAborted();
        throw contextError("ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE", "无法读取绑定的冲突检查材料", 503, { cause });
      }
    }
    let originalRepairFeedback = null;
    if (roleId === "pr-engineer" && item.eventType === "pull_request.internal_review_requested") {
      if (this.#originalRepairFeedbackReader === null) throw contextError("OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE", "内部修复复审需要完整原始反馈快照", 503);
      originalRepairFeedback = normalizeRepairFeedbackDescriptor(await this.#originalRepairFeedbackReader.readBinding({
        inputBinding: createPullRequestExecutionBinding({ sourceBinding: item.sourceBinding, event: item.event }),
        internalReview: item.event.payload.internalReview,
      }));
      if (originalRepairFeedback.reviewHeadRefOid !== item.event.payload.headRefOid ||
          originalRepairFeedback.feedbackDigest !== item.event.payload.internalReview.feedbackDigest) throw contextError("ROLE_CONTEXT_STALE", "原始反馈与内部复审绑定不一致", 409);
    }
    const isPullRequest = item.eventType.startsWith("pull_request.");
    let reviewPublicationReuse = null;
    if (roleId === "pr-engineer" && isPullRequest && item.eventType !== "pull_request.internal_review_requested" && internalReview === null &&
        this.#publicationReuseReader !== null && (hasRequiredReviewDeliverable(currentAcceptanceContract) || item.event.source.provider === "github") && typeof pullRequest?.materialDigest === "string") {
      reviewPublicationReuse = canonicalValue(await this.#publicationReuseReader({ taskId: currentTask.taskId, materialDigest: pullRequest.materialDigest },
        signal === null ? {} : { signal }));
      signal?.throwIfAborted();
    }
    let reviewPublicationRecovery = null;
    if (coordination !== null && this.#publicationReuseReader !== null && typeof pullRequest?.materialDigest === "string" &&
        isExternalRereview({ code: { sourceEvent: item.event } })) {
      const child = coordination.coordination.directChildren.find(child => child.ledgerStatus === "blocked" &&
        child.responsibility.type === "role" && child.responsibility.id === "pr-engineer" && child.decisionFailure &&
        !child.hasMoreDeliverables && child.deliverables.every(slot => slot.state === "none") &&
        hasRequiredReviewDeliverable({ expectedDeliverables: child.deliverables }));
      if (child) {
        const catalog = canonicalValue(await this.#publicationReuseReader({ taskId: child.taskId, materialDigest: pullRequest.materialDigest },
          signal === null ? {} : { signal }));
        signal?.throwIfAborted();
        if (catalog.complete === true && catalog.candidates.length > 0) {
          reviewPublicationRecovery = { childTaskId: child.taskId, childTaskRevision: child.taskRevision,
            candidates: catalog.candidates.map(candidate => ({ ...candidate,
              replacementChildKey: `review-reuse-${canonicalJsonDigest([currentTask.taskId, candidate.reviewUrl, candidate.deliverableId])}` })),
            requiresTaskControlChecks: true };
        }
      }
    }

    const binding = {
      roleId,
      taskId: currentTask.taskId,
      taskRevision: currentTask.revision,
      inputDigest: item.inputDigest,
      graphId: snapshot.graphId,
      graphRevision: snapshot.graphRevision,
      graphContentDigest: snapshot.graphContentDigest,
      contractRevision: currentContract.revision,
      ...(item.sourceBinding === null
        ? {}
        : { source: item.sourceBinding }),
    };
    const proposalDecisionContext =
      item.decisionContext?.source === "proposal"
        ? item.decisionContext
        : null;
    const requirementsDecisionContext = proposalDecisionContext
      ? null
      : item.decisionContext;
    const requirements = {
      schemaVersion: 1,
      trigger,
      roleId,
      graph: {
        graphId: snapshot.graphId,
        revision: snapshot.graphRevision,
        contentDigest: snapshot.graphContentDigest,
      },
      currentTask: {
        taskId: currentTask.taskId,
        revision: currentTask.revision,
        parentTaskId: currentTask.parentTaskId,
        responsibility: { ...currentTask.responsibility },
        work: { ...taskState.work },
        acceptanceContract: currentAcceptanceContract,
      },
      source: {
        assignmentId: item.assignmentId,
        eventId: item.eventId,
        eventType: item.eventType,
        ...(item.sourceBinding === null ? {} : item.sourceBinding),
      },
      ...(requirementsDecisionContext === null
        ? {}
        : { decisionContext: requirementsDecisionContext }),
      acceptedDependencies: dependencies.requirements,
      facts: isPullRequest ? [] : facts,
      ...(currentTaskRejection?.dataClass === "requirements"
        ? { currentTaskRejection: currentTaskRejection.value }
        : {}),
      ...(coordination
        ? {
            coordination: coordination.coordination,
            childDeliveries: coordination.requirements,
          }
        : {}),
    };
    const context = { requirements };
    if (
      isPullRequest ||
      dependencies.code.length > 0 ||
      coordination?.code.length > 0 ||
      currentTaskRejection?.dataClass === "code" ||
      proposalDecisionContext !== null ||
      authoritativeEvidence.length > 0
    ) {
      context.code = {
        ...(isPullRequest ? { sourceEvent: item.event } : {}),
        ...(pullRequest === null ? {} : { pullRequest: reviewPublicationReuse?.verifiedResult
          ? Object.fromEntries(Object.entries(pullRequest).filter(([key]) =>
            ["schemaVersion", "identityDigest", "contentDigest", "materialDigest", "observedAt", "summary", "checks"].includes(key)))
          : pullRequest }),
        ...(reviewPublicationSettlement === null ? {} : { reviewPublicationSettlement }),
        ...(reviewPublicationReuse === null ? {} : { reviewPublicationReuse }),
        ...(reviewPublicationRecovery === null ? {} : { reviewPublicationRecovery }),
        acceptedDependencies: dependencies.code,
        facts: isPullRequest ? facts : [],
        ...(proposalDecisionContext === null
          ? {}
          : { decisionContext: proposalDecisionContext }),
        ...(failedExecution === null ? {} : { failedExecution }),
        ...(conflictInspection === null ? {} : { conflictInspection }),
        ...(internalReview === null ? {} : { internalReview }),
        ...(originalRepairFeedback === null ? {} : { originalRepairFeedback }),
        ...(currentTaskRejection?.dataClass === "code"
          ? { currentTaskRejection: currentTaskRejection.value }
          : {}),
        ...(coordination?.code.length > 0
          ? { childDeliveries: coordination.code }
          : {}),
        ...(authoritativeEvidence.length > 0
          ? { authoritativeEvidence }
          : {}),
      };
    }
    if (memoryQuery !== null) {
      context.memory = { agentQuery: memoryQuery };
    }
    if (isPullRequest && pullRequest !== null && context.code && this.#ciDiagnosticReader && item.sourceBinding !== null) {
      const baselinePacket = { schemaVersion: 1, binding, context, acceptedInputs: dependencies.acceptedInputs, contextDigest: "0".repeat(64) };
      const remaining = Math.min(12000, MAX_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify(baselinePacket), "utf8") - 32);
      if (remaining >= 256) {
        let executionBinding;
        try {
          executionBinding = createPullRequestExecutionBinding({ sourceBinding: item.sourceBinding, event: item.event });
          if (executionBinding.schemaVersion !== 2) throw invalid("CI diagnostic Git target is unavailable");
          const value = await this.#ciDiagnosticReader.read({ repository: executionBinding.repository,
            headRefOid: executionBinding.headRefOid, headRefName: executionBinding.gitTarget.headRefName,
            checks: pullRequest.checks, maximumBytes: remaining }, signal === undefined ? {} : { signal });
          signal?.throwIfAborted();
          if (value !== null) {
            const diagnostic = canonicalValue(value);
            const { contentDigest, ...material } = diagnostic;
            if (diagnostic.schemaVersion !== 1 || diagnostic.repository !== executionBinding.repository ||
                diagnostic.headRefOid !== executionBinding.headRefOid || !Array.isArray(diagnostic.reports) || diagnostic.reports.length > 3 ||
                canonicalJsonDigest(material) !== contentDigest || Buffer.byteLength(JSON.stringify(diagnostic), "utf8") > remaining) throw invalid("CI diagnostic binding is invalid");
            context.code.ciDiagnostics = diagnostic;
          }
        } catch {
          signal?.throwIfAborted();
          context.code.ciDiagnostics = { schemaVersion: 1, repository: item.event.subject.repository,
            headRefOid: item.sourceBinding.headRefOid, state: "unavailable", code: "CI_DIAGNOSTICS_UNAVAILABLE" };
          if (Buffer.byteLength(JSON.stringify(context.code.ciDiagnostics)) > remaining) delete context.code.ciDiagnostics;
        }
      }
    }
    assertPacketSize(context);

    const contextDigest = sha256({
      domain: "mydashboard-role-context/v1",
      binding,
      dataClasses: Object.keys(context).sort(compareText),
      context,
    });
    const packet = {
      schemaVersion: 1,
      binding,
      context,
      acceptedInputs: dependencies.acceptedInputs,
      contextDigest,
    };
    assertPacketSize(packet);
    signal?.throwIfAborted();
    return deepFreeze(packet);
  }

  async #readReviewPublicationSettlement(roleId, item, currentTask, snapshot, signal) {
    const event = item.event, payload = event.payload;
    if (this.#settlementInputAuthorityVerifier === null || this.#settlementEvidenceVerifier === null ||
        !isConfiguredRootOrchestrator(roleId, currentTask) || currentTask.acceptanceContracts.at(-1).expectedDeliverables.length !== 0 ||
        !["queued", "working"].includes(snapshot.statesById.get(currentTask.taskId)?.ledgerStatus) ||
        event.eventType !== "pull_request.owner_requested" || event.source?.provider !== "local-owner" ||
        payload?.workType !== "general" || payload.nextAction !== "rereview" || payload.suggestedCapability !== "pr-review" ||
        item.sourceBinding === null) return null;
    const children = [...snapshot.tasksById.values()].filter(task => task.parentTaskId === currentTask.taskId && task.status !== "superseded");
    if (children.length === 0) return null;
    const entries = [];
    for (const child of children) {
      const state = snapshot.statesById.get(child.taskId);
      if (child.responsibility.type !== "role" || child.responsibility.id !== "pr-engineer" || child.dependsOn.length !== 0 ||
          state?.taskRevision !== child.revision || !["waiting_external", "completed"].includes(state.ledgerStatus)) return null;
      const { currentContract, deliveries, latestByDeliverable } = currentDeliveryState(child);
      if (!currentContract.expectedDeliverables.some(slot => slot.required) ||
          currentContract.expectedDeliverables.some(slot => slot.kind !== "github-review")) return null;
      const contractDigest = deliveryAcceptanceContractDigest(publicContract(currentContract));
      for (const slot of currentContract.expectedDeliverables) {
        const latest = latestByDeliverable.get(slot.deliverableId);
        if (!["submitted", "accepted"].includes(latest?.status)) return null;
        const submitted = latest.status === "submitted" ? latest : matchingSubmission(deliveries, latest,
          "ROLE_CONTEXT_CHILD_DELIVERY_INVALID", "Published Review acceptance has no exact submission");
        const records = submitted.evidence.filter(record => record.kind === "github-review");
        if (records.length !== 1) return null;
        entries.push({ taskId: child.taskId, taskRevision: child.revision, contractRevision: currentContract.revision,
          contractDigest, deliverableId: slot.deliverableId,
          submittedDeliveryRevision: submitted.revision, state: latest.status, completed: state.ledgerStatus === "completed",
          evidence: records[0] });
      }
    }
    const inputBinding = createPullRequestExecutionBinding({ sourceBinding: item.sourceBinding, event });
    if (inputBinding.schemaVersion !== 2) return null;
    const verifiedInput = await this.#settlementInputAuthorityVerifier(inputBinding);
    signal?.throwIfAborted();
    if (!samePullRequestExecutionBinding(verifiedInput, inputBinding)) throw invalid("Historical Review input authority changed");
    for (const entry of entries) {
      const verified = await this.#settlementEvidenceVerifier({ taskId: entry.taskId, roleId: "pr-engineer",
        contractRevision: entry.contractRevision, contractDigest: entry.contractDigest, deliverableId: entry.deliverableId,
        inputBinding, evidence: entry.evidence, ...(signal === undefined ? {} : { signal }) });
      signal?.throwIfAborted();
      if (verified !== true && !sameEvidence(verified, entry.evidence)) return null;
    }
    return { schemaVersion: 1, scope: "historical_publication_only", inputBinding,
      allAccepted: entries.every(entry => entry.state === "accepted" && entry.completed), entries };
  }
}
