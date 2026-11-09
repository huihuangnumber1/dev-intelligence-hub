import { structuredPrTriage, isExternalRereview, hasRequiredReviewDeliverable, requiredReviewDeliverables, requiresReviewDelivery } from "../domain/pr-review-work-policy.js";
import { createHash } from "node:crypto";
import { permitsReviewPublicationSettlementIntent } from "./review-publication-settlement.js";
import { coordinatorGoalControl, permitsCoordinatorCancellation } from "../domain/work-goal-ownership.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";

import { deliveryAcceptanceContractDigest } from "../domain/delivery-evidence-contract.js";
import {
  assertRequirementSpecAcceptedInputsBudget,
  createRequirementSpec,
  normalizeRequirementSpec,
} from "../domain/requirement-spec-contract.js";
import { normalizeWorkGraphSnapshot } from "../domain/work-graph-contract.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import {
  WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
  WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS,
} from "./work-coordination-timing.js";

const ORCHESTRATOR_ROLE_ID = "orchestrator";
const ORCHESTRATOR_WORKER_ID = "employee-orchestrator";
const RESERVED_EVIDENCE_KINDS = new Set([
  "work-inputs",
  "requirement-spec",
]);
const INTERNALLY_TRUSTED_DELIVERABLE_KINDS = new Set([
  "requirement-spec",
  "text-report",
]);
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SAFE_DEPTH = 24;
const MAX_SAFE_ENTRIES = 500_000;
const MAX_SAFE_BYTES = 20 * 1024 * 1024;
const DIRECT_ACTION_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

export class OrchestratorServiceError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "OrchestratorServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function serviceError(code, message, statusCode, options) {
  return new OrchestratorServiceError(code, message, statusCode, options);
}

function invalid(message = "Orchestrator service input is invalid", options) {
  return serviceError("ORCHESTRATOR_SERVICE_INVALID", message, 400, options);
}

function denied(message) {
  return serviceError("ORCHESTRATOR_AUTHORITY_DENIED", message, 403);
}

function stale(message, options) {
  return serviceError("ORCHESTRATOR_CONTEXT_STALE", message, 409, options);
}

function evidenceRejected(message, options) {
  return serviceError(
    "ORCHESTRATOR_EVIDENCE_REJECTED",
    message,
    409,
    options,
  );
}

function evidenceVerifierUnavailable(message, options) {
  return serviceError(
    "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    message,
    503,
    options,
  );
}

function contextUnavailable(message, options) {
  return serviceError(
    "ORCHESTRATOR_CONTEXT_UNAVAILABLE",
    message,
    503,
    options,
  );
}

function ownEntries(value, name) {
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
  return entries;
}

function exactMap(value, keys, name) {
  const entries = ownEntries(value, name);
  const fields = new Map(entries);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return fields;
}

function safeClone(value, state = { entries: 0 }, depth = 0) {
  if (depth > MAX_SAFE_DEPTH) throw invalid("Input is too deeply nested");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      throw invalid("Input contains an invalid array");
    }
    state.entries += value.length;
    if (state.entries > MAX_SAFE_ENTRIES) throw invalid("Input is too large");
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw invalid("Input contains an invalid array");
      }
      result.push(safeClone(descriptor.value, state, depth + 1));
    }
    return result;
  }
  const entries = ownEntries(value, "Input object");
  state.entries += entries.length;
  if (state.entries > MAX_SAFE_ENTRIES) throw invalid("Input is too large");
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, safeClone(entry, state, depth + 1)]),
  );
}

function checkedClone(value) {
  const result = safeClone(value);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SAFE_BYTES) {
    throw invalid("Input is too large");
  }
  return result;
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

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedText(value, name, maximumBytes = 256) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function roleId(value, name) {
  const result = boundedText(value, name, 128);
  if (!SAFE_ROLE_ID.test(result)) throw invalid(`${name} is invalid`);
  return result;
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

function timeoutMilliseconds(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1 ||
    value > 24 * 60 * 60 * 1000
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function requirePort(value, method, name) {
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
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new TypeError(`${name} is invalid`);
        }
        return Object.freeze({ [method]: descriptor.value.bind(value) });
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

function optionalEvidenceVerifier(value) {
  if (value === undefined || value === null) return null;
  return requirePort(value, "verify", "evidenceVerifier");
}

function actionAdmissionRun(value) {
  const gate = value === undefined
    ? DIRECT_ACTION_ADMISSION
    : requirePort(value, "run", "actionAdmissionGate");
  return gate.run.bind(gate);
}

function carryOperation(invoke) {
  try {
    return Object.freeze({
      status: "started",
      operation: Promise.resolve(invoke()),
    });
  } catch (error) {
    return Object.freeze({ status: "failed", error });
  }
}

function normalizeCapabilityRoles(value) {
  const result = new Map();
  for (const [capability, configuredRoleId] of ownEntries(
    value,
    "capabilityRoles",
  )) {
    const key = roleId(capability, "capability");
    result.set(key, roleId(configuredRoleId, "capabilityRoles.roleId"));
  }
  return result;
}

function normalizeWorker(value) {
  const fields = exactMap(value, ["roleId", "workerId"], "worker");
  return {
    roleId: roleId(fields.get("roleId"), "worker.roleId"),
    workerId: boundedText(fields.get("workerId"), "worker.workerId", 128),
  };
}

function normalizeTarget(value, name) {
  const fields = exactMap(value, ["type", "id"], name);
  const type = fields.get("type");
  if (!["role", "person", "node"].includes(type)) {
    throw invalid(`${name}.type is invalid`);
  }
  return {
    type,
    id: boundedText(fields.get("id"), `${name}.id`, 128),
  };
}

function normalizeItem(value) {
  const item = checkedClone(value);
  const fields = new Map(ownEntries(item, "item"));
  for (const key of [
    "itemId",
    "revision",
    "inputDigest",
    "status",
    "ownerId",
    "leaseId",
    "currentTarget",
  ]) {
    if (!fields.has(key)) throw invalid("item is invalid");
  }
  const inputDigest = fields.get("inputDigest");
  if (typeof inputDigest !== "string" || !SHA256.test(inputDigest)) {
    throw invalid("item.inputDigest is invalid");
  }
  const ownerId = fields.get("ownerId");
  const leaseId = fields.get("leaseId");
  const rawLeaseUntil = fields.get("leaseUntil");
  if (ownerId !== null) boundedText(ownerId, "item.ownerId", 128);
  if (leaseId !== null) boundedText(leaseId, "item.leaseId", 128);
  if (
    rawLeaseUntil !== undefined &&
    rawLeaseUntil !== null &&
    (
      typeof rawLeaseUntil !== "string" ||
      !Number.isFinite(Date.parse(rawLeaseUntil))
    )
  ) {
    throw invalid("item.leaseUntil is invalid");
  }
  return {
    value: item,
    itemId: boundedText(fields.get("itemId"), "item.itemId", 192),
    revision: positiveRevision(fields.get("revision"), "item.revision"),
    inputDigest,
    status: boundedText(fields.get("status"), "item.status", 64),
    ownerId,
    leaseId,
    leaseUntil: rawLeaseUntil ?? null,
    currentTarget: normalizeTarget(fields.get("currentTarget"), "item.currentTarget"),
  };
}

function packetTrigger(value) {
  const packet = checkedClone(value);
  const fields = exactMap(
    packet,
    ["schemaVersion", "binding", "context", "acceptedInputs", "contextDigest"],
    "contextPacket",
  );
  if (fields.get("schemaVersion") !== 1) {
    throw invalid("contextPacket.schemaVersion is invalid");
  }
  const context = new Map(ownEntries(fields.get("context"), "contextPacket.context"));
  const requirements = new Map(
    ownEntries(context.get("requirements"), "contextPacket.context.requirements"),
  );
  return {
    packet,
    trigger: boundedText(
      requirements.get("trigger"),
      "contextPacket.context.requirements.trigger",
      128,
    ),
  };
}

function normalizeGraphView(value) {
  const view = checkedClone(value);
  const fields = exactMap(
    view,
    ["schemaVersion", "graph", "taskStates"],
    "graph view",
  );
  if (fields.get("schemaVersion") !== 1 || !Array.isArray(fields.get("taskStates"))) {
    throw invalid("graph view is invalid");
  }
  return normalizeWorkGraphSnapshot(fields.get("graph"));
}

function roleContextDigest(packet) {
  return sha256({
    domain: "mydashboard-role-context/v1",
    binding: packet.binding,
    dataClasses: Object.keys(packet.context).sort(),
    context: packet.context,
  });
}

function hasConsistentContextGraph(packet) {
  const graph = packet.context?.requirements?.graph;
  const binding = packet.binding;
  return graph !== undefined && graph !== null &&
    graph.graphId === binding?.graphId &&
    graph.revision === binding?.graphRevision &&
    graph.contentDigest === binding?.graphContentDigest;
}

function observationAdvanced(original, fresh) {
  return typeof original === "string" && typeof fresh === "string" &&
    Number.isFinite(Date.parse(original)) && Number.isFinite(Date.parse(fresh)) &&
    new Date(original).toISOString() === original &&
    new Date(fresh).toISOString() === fresh && Date.parse(fresh) > Date.parse(original);
}

function rebasePullRequestObservations(rebased, fresh) {
  const originalPr = rebased.context?.code?.pullRequest;
  const freshPr = fresh.context?.code?.pullRequest;
  if (
    !originalPr || !freshPr ||
    !SHA256.test(originalPr.identityDigest) ||
    originalPr.identityDigest !== freshPr.identityDigest ||
    !SHA256.test(originalPr.materialDigest) ||
    originalPr.materialDigest !== freshPr.materialDigest
  ) return;

  if (observationAdvanced(originalPr.observedAt, freshPr.observedAt) &&
      originalPr.summary?.contentDigest === originalPr.contentDigest &&
      freshPr.summary?.contentDigest === freshPr.contentDigest) {
    originalPr.observedAt = freshPr.observedAt;
    originalPr.contentDigest = freshPr.contentDigest;
    originalPr.summary.contentDigest = freshPr.summary.contentDigest;
  }
  for (const dataClass of ["requirements", "code"]) {
    const originalFacts = rebased.context[dataClass]?.facts;
    const freshFacts = fresh.context[dataClass]?.facts;
    if (!Array.isArray(originalFacts) || !Array.isArray(freshFacts) ||
        originalFacts.length !== freshFacts.length) continue;
    for (let index = 0; index < originalFacts.length; index += 1) {
      if (observationAdvanced(originalFacts[index].observedAt, freshFacts[index].observedAt)) {
        originalFacts[index].observedAt = freshFacts[index].observedAt;
      }
    }
  }
}

function hasValidDiagnosticDigest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { contentDigest, ...material } = value;
  return typeof contentDigest === "string" && SHA256.test(contentDigest) &&
    canonicalJsonDigest(material) === contentDigest;
}

function rebaseCiDiagnosticObservations(rebased, fresh) {
  const original = rebased.context?.code?.ciDiagnostics;
  const current = fresh.context?.code?.ciDiagnostics;
  if (!hasValidDiagnosticDigest(original) || !hasValidDiagnosticDigest(current) ||
      original.schemaVersion !== 1 || current.schemaVersion !== 1 ||
      original.repository !== current.repository || original.headRefOid !== current.headRefOid ||
      !Array.isArray(original.reports) || !Array.isArray(current.reports) ||
      original.reports.length !== current.reports.length || original.reports.length > 3) return;
  for (let index = 0; index < original.reports.length; index += 1) {
    const previous = original.reports[index];
    const next = current.reports[index];
    if (sameValue(previous, next)) continue;
    if (!hasValidDiagnosticDigest(previous) || !hasValidDiagnosticDigest(next) ||
        previous.schemaVersion !== 1 || previous.state !== "available" ||
        !["SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT"].includes(previous.result) ||
        previous.repository !== original.repository || previous.headRefOid !== original.headRefOid ||
        previous.checkout?.matched !== true || previous.checkout.sha !== original.headRefOid ||
        typeof previous.materialDigest !== "string" || !SHA256.test(previous.materialDigest) ||
        !observationAdvanced(previous.observedAt, next.observedAt)) return;
    const { observedAt: previousAt, contentDigest: previousDigest, ...previousMaterial } = previous;
    const { observedAt: nextAt, contentDigest: nextDigest, ...nextMaterial } = next;
    if (!sameValue(previousMaterial, nextMaterial)) return;
    original.reports[index] = checkedClone(next);
  }
  const { contentDigest, ...material } = original;
  original.contentDigest = canonicalJsonDigest(material);
}

function assertPacketIsFresh(original, fresh) {
  const normalizedFresh = checkedClone(fresh);
  if (sameValue(original, normalizedFresh)) return normalizedFresh;
  if (
    !hasConsistentContextGraph(original) ||
    !hasConsistentContextGraph(normalizedFresh) ||
    normalizedFresh.binding.graphRevision < original.binding.graphRevision ||
    (normalizedFresh.binding.graphRevision === original.binding.graphRevision &&
      normalizedFresh.binding.graphContentDigest !== original.binding.graphContentDigest) ||
    original.contextDigest !== roleContextDigest(original) ||
    normalizedFresh.contextDigest !== roleContextDigest(normalizedFresh)
  ) {
    throw stale("Role context changed before the requested action could execute");
  }
  // Rebase graph metadata and identical PR/build evidence observed again.
  // Complete material digests and every other scoped field still compare.
  const rebased = checkedClone(original);
  rebased.binding.graphRevision = normalizedFresh.binding.graphRevision;
  rebased.binding.graphContentDigest = normalizedFresh.binding.graphContentDigest;
  rebased.context.requirements.graph.revision = normalizedFresh.context.requirements.graph.revision;
  rebased.context.requirements.graph.contentDigest = normalizedFresh.context.requirements.graph.contentDigest;
  rebasePullRequestObservations(rebased, normalizedFresh);
  rebaseCiDiagnosticObservations(rebased, normalizedFresh);
  rebased.contextDigest = roleContextDigest(rebased);
  if (!sameValue(rebased, normalizedFresh)) {
    throw stale("Role context changed before the requested action could execute");
  }
  return normalizedFresh;
}

function rebaseIntentGraphRevision(intent, original, fresh) {
  if (sameValue(original, fresh)) return intent;
  const action = intent.type === "orchestrate" ? intent.action : intent;
  if (action.expectedGraphRevision !== original.binding.graphRevision) {
    throw stale("The decision does not reference its original context graph");
  }
  return intent.type === "orchestrate"
    ? { ...intent, action: { ...action, expectedGraphRevision: fresh.binding.graphRevision } }
    : { ...intent, expectedGraphRevision: fresh.binding.graphRevision };
}

function assertGraphBinding(packet, graph) {
  const binding = packet.binding;
  if (
    binding.graphId !== graph.graphId ||
    binding.graphRevision !== graph.revision ||
    binding.graphContentDigest !== graph.contentDigest
  ) {
    throw stale("Role context no longer matches the current work graph");
  }
}

function graphIndex(graph) {
  return new Map(graph.tasks.map((task) => [task.taskId, task]));
}

function rootTaskId(taskId, tasksById) {
  const visited = new Set();
  let task = tasksById.get(taskId);
  while (task) {
    if (visited.has(task.taskId)) throw invalid("Work graph hierarchy is cyclic");
    visited.add(task.taskId);
    if (task.parentTaskId === null) return task.taskId;
    task = tasksById.get(task.parentTaskId);
  }
  throw stale(`Task ${taskId} is no longer present in the work graph`);
}

function sameTarget(left, right) {
  return left.type === right.type && left.id === right.id;
}

function assertCurrentItem({ item, packet, worker, tasksById }) {
  const binding = packet.binding;
  const task = tasksById.get(item.itemId);
  if (
    !task ||
    binding.roleId !== worker.roleId ||
    binding.taskId !== item.itemId ||
    binding.taskRevision !== item.revision ||
    binding.inputDigest !== item.inputDigest ||
    task.revision !== item.revision ||
    !sameTarget(task.responsibility, item.currentTarget)
  ) {
    throw stale("The employee claim no longer matches its task binding");
  }
  return task;
}

function assertLocalSubmissionClaim({ worker, item, intent }) {
  if (worker.roleId === ORCHESTRATOR_ROLE_ID) {
    throw denied("The root orchestrator cannot submit a specialist delivery");
  }
  if (
    item.status !== "working" ||
    item.ownerId !== worker.workerId ||
    !item.leaseId ||
    item.currentTarget.type !== "role" ||
    item.currentTarget.id !== worker.roleId ||
    intent.taskId !== item.itemId ||
    intent.expectedTaskRevision !== item.revision
  ) {
    throw denied("The specialist delivery is not bound to the active claim");
  }
}

function directChildIds(packet) {
  const coordination = packet.context?.requirements?.coordination;
  if (!coordination || !Array.isArray(coordination.directChildren)) {
    throw denied("Only a configured root orchestrator can mutate the task graph");
  }
  return new Set(coordination.directChildren.map(({ taskId }) => taskId));
}

function reviewChildResponsibility(task) {
  return task.responsibility.type === "role" &&
    ["pr-engineer", "orchestrator"].includes(task.responsibility.id);
}

function malformedReviewChildWithSettledDeliveries(task) {
  const expected = latestContract(task).expectedDeliverables;
  const latestDeliveries = new Map(task.deliveries.map((delivery) => [delivery.deliverableId, delivery]));
  return reviewChildResponsibility(task) && expected.length > 0 &&
    expected.every(({ kind }) => kind === "text-report") &&
    task.deliveries.every(({ status }) => status !== "accepted") &&
    [...latestDeliveries.values()].every(({ status }) => status !== "submitted");
}

function cancelledMalformedReviewChild(task) {
  return task.status === "cancelled" && malformedReviewChildWithSettledDeliveries(task);
}

function cancelledConflictChildWithoutDelivery(task) {
  return task.status === "cancelled" && task.responsibility.type === "role" &&
    task.responsibility.id === "developer" && task.deliveries.length === 0;
}

function verifiedReviewReplacement(packet, action, tasksById, children) {
  if (!requiresReviewDelivery(packet.context, action)) return null;
  const recovery = packet.context.code?.reviewPublicationRecovery;
  if (recovery?.requiresTaskControlChecks !== true || !children.has(recovery.childTaskId)) return null;
  const old = tasksById.get(recovery.childTaskId);
  const visible = packet.context.requirements.coordination.directChildren.find(child => child.taskId === old.taskId);
  const candidate = recovery.candidates.find(candidate => candidate.replacementChildKey === action.childKey &&
    requiredReviewDeliverables(action.acceptanceContract).some(slot => slot.deliverableId === candidate.deliverableId));
  if (!candidate || old.revision !== recovery.childTaskRevision || visible?.ledgerStatus !== "blocked" || !visible.decisionFailure ||
      old.responsibility.type !== "role" || old.responsibility.id !== "pr-engineer" || old.deliveries.length !== 0 ||
      !hasRequiredReviewDeliverable(latestContract(old)) || [...children].some(taskId => taskId !== old.taskId &&
        (!["cancelled", "superseded"].includes(tasksById.get(taskId).status) || tasksById.get(taskId).deliveries.length !== 0))) return null;
  return { taskId: old.taskId, expectedTaskRevision: old.revision, reason: action.reason };
}

function assertStructuredPrTriageAction(packet, children, action, tasksById, automaticMode, capabilityRoles) {
  const triage = structuredPrTriage(packet.context);
  if (triage === null) return;
  if (!automaticMode && children.size === 0 && action.type !== "decompose") {
    throw denied("Initial structured PR triage must be decomposed");
  }
  const controlledChild = children.has(action.sourceTaskId) ? tasksById.get(action.sourceTaskId) : null;
  const childLedgerStatus = packet.context.requirements.coordination.directChildren.find(
    ({ taskId }) => taskId === action.sourceTaskId)?.ledgerStatus;
  if (!automaticMode && isExternalRereview(packet.context) && action.type === "pause" && controlledChild &&
      ["queued", "retry_wait", "blocked"].includes(childLedgerStatus) &&
      malformedReviewChildWithSettledDeliveries(controlledChild)) {
    throw denied("A settled malformed external rereview child must be cancelled before authoritative replacement");
  }
  if (isExternalRereview(packet.context) && action.type === "cancel" && controlledChild?.status === "paused" &&
      reviewChildResponsibility(controlledChild)) {
    throw denied("Automatic rereview correction must preserve an intentionally paused Review child");
  }
  if (action.type !== "decompose") return;
  const reviewReplacement = verifiedReviewReplacement(packet, action, tasksById, children);
  if (requiresReviewDelivery(packet.context, action) && !reviewReplacement &&
      (packet.context.code?.reviewPublicationRecovery || [...children].some(taskId => {
        const child = tasksById.get(taskId);
        const visible = packet.context.requirements.coordination.directChildren.find(value => value.taskId === taskId);
        return visible?.ledgerStatus === "blocked" && child.responsibility.type === "role" &&
          child.responsibility.id === "pr-engineer" && hasRequiredReviewDeliverable(latestContract(child));
      }))) throw denied("Blocked authoritative Review replacement requires an exact current host recovery candidate");
  if (automaticMode && [...children].some((taskId) => {
    const child = tasksById.get(taskId);
    return child.status === "paused" && child.responsibility.type === "role" &&
      (child.responsibility.id === capabilityRoles.get(action.capability) ||
       (action.capability === "pr-review" && reviewChildResponsibility(child)));
  })) {
    throw denied("Automatic coordination must preserve an intentionally paused child");
  }
  const replaceCancelledConflict = !automaticMode && triage.nextAction === "resolve_conflict" &&
    triage.suggestedCapability === "development" &&
    [...children].every((taskId) => cancelledConflictChildWithoutDelivery(tasksById.get(taskId)));
  if (!automaticMode && children.size !== 0 && !replaceCancelledConflict && !reviewReplacement && !(isExternalRereview(packet.context) &&
      [...children].every((taskId) => cancelledMalformedReviewChild(tasksById.get(taskId))))) {
    throw denied("Structured PR triage permits only one direct child");
  }
  if (!automaticMode && action.capability !== triage.suggestedCapability) {
    throw denied("Structured PR triage capability does not match trusted intake");
  }
  if (requiresReviewDelivery(packet.context, action) &&
      !hasRequiredReviewDeliverable(action.acceptanceContract)) {
    throw denied("External rereview requires a required authoritative Review delivery");
  }
  return reviewReplacement;
}

function hasVisibleSubmittedDelivery(packet, taskId, revision) {
  const payloads = [
    ...(packet.context?.requirements?.childDeliveries ?? []),
    ...(packet.context?.code?.childDeliveries ?? []),
  ];
  return payloads.some(
    (payload) =>
      payload.taskId === taskId &&
      payload.state === "submitted" &&
      payload.submittedDeliveryRevision === revision,
  );
}

function assertOrchestrator(worker, bindingTask) {
  if (
    worker.roleId !== ORCHESTRATOR_ROLE_ID ||
    worker.workerId !== ORCHESTRATOR_WORKER_ID ||
    bindingTask.parentTaskId !== null ||
    bindingTask.responsibility.type !== "role" ||
    bindingTask.responsibility.id !== ORCHESTRATOR_ROLE_ID
  ) {
    throw denied("This action requires the configured root orchestrator");
  }
}

function assertActionSource(action, graph, tasksById, bindingTask, children) {
  const source = tasksById.get(action.sourceTaskId);
  if (
    !source ||
    source.revision !== action.sourceTaskRevision ||
    action.expectedGraphRevision !== graph.revision
  ) {
    throw stale("The orchestration action references stale graph state");
  }
  if (
    source.taskId !== bindingTask.taskId &&
    !children.has(source.taskId)
  ) {
    throw denied("The orchestration source is outside the visible root scope");
  }
  return source;
}

function specialistRoleForCapability(capabilityRoles, capability) {
  const targetRoleId = capabilityRoles.get(capability);
  if (!targetRoleId) {
    throw denied(`No trusted role is configured for capability ${capability}`);
  }
  // Root coordination has no specialist delivery path. Reject before creating
  // or assigning a child whose required contract this role cannot fulfill.
  if (targetRoleId === ORCHESTRATOR_ROLE_ID) {
    throw denied("The root orchestrator cannot be assigned a specialist child contract");
  }
  return targetRoleId;
}

function latestContract(task) {
  const contract = task.acceptanceContracts.at(-1);
  if (!contract) throw stale(`Task ${task.taskId} has no acceptance contract`);
  return contract;
}

function matchingSubmission(task, decision) {
  const submitted = task.deliveries[decision.revision - 2];
  if (
    !submitted ||
    submitted.status !== "submitted" ||
    submitted.revision + 1 !== decision.revision ||
    submitted.contractRevision !== decision.contractRevision ||
    submitted.deliverableId !== decision.deliverableId ||
    !sameValue(submitted.evidence, decision.evidence)
  ) {
    throw stale(`Delivery ${decision.revision} has no matching submission`);
  }
  return submitted;
}

function deriveAcceptedInputsFromDependencies(
  dependencyIds,
  rootId,
  tasksById,
) {
  const acceptedInputs = [];
  for (const dependencyId of dependencyIds) {
    const dependency = tasksById.get(dependencyId);
    if (
      !dependency ||
      rootTaskId(dependencyId, tasksById) !== rootId ||
      dependency.status !== "completed"
    ) {
      throw stale(`Dependency ${dependencyId} is not an accepted task input`);
    }
    const contract = latestContract(dependency);
    const latestByDeliverable = new Map();
    for (const delivery of dependency.deliveries) {
      if (delivery.contractRevision === contract.revision) {
        latestByDeliverable.set(delivery.deliverableId, delivery);
      }
    }
    for (const expected of contract.expectedDeliverables) {
      const decision = latestByDeliverable.get(expected.deliverableId);
      if (decision?.status !== "accepted") {
        if (expected.required) {
          throw stale(
            `Required dependency delivery ${expected.deliverableId} is not accepted`,
          );
        }
        continue;
      }
      const submitted = matchingSubmission(dependency, decision);
      acceptedInputs.push({
        taskId: dependency.taskId,
        deliverableId: expected.deliverableId,
        taskRevision: dependency.revision,
        contractRevision: contract.revision,
        submittedDeliveryRevision: submitted.revision,
        decisionRevision: decision.revision,
        evidenceDigests: [
          ...new Set(decision.evidence.map(({ contentDigest }) => contentDigest)),
        ].sort(compareText),
      });
    }
  }
  return acceptedInputs.sort((left, right) =>
    compareText(
      `${left.taskId}\u0000${left.deliverableId}`,
      `${right.taskId}\u0000${right.deliverableId}`,
    )
  );
}

function deriveAcceptedInputs(task, tasksById) {
  return deriveAcceptedInputsFromDependencies(
    task.dependsOn,
    rootTaskId(task.taskId, tasksById),
    tasksById,
  );
}

function workInputsEvidence({ taskId, roleId: employeeRoleId, contextDigest, acceptedInputs }) {
  return {
    kind: "work-inputs",
    referenceId: `work-inputs:${taskId}:${contextDigest}`,
    contentDigest: sha256({
      domain: "mydashboard-work-inputs/v1",
      taskId,
      roleId: employeeRoleId,
      contextDigest,
      acceptedInputs,
    }),
  };
}

function waitForVerification(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function verifyExternalEvidence(
  verifier,
  evidence,
  authority,
  timeoutMs,
) {
  if (evidence.length === 0) return;
  if (!verifier) {
    throw evidenceVerifierUnavailable(
      "External evidence cannot be accepted without a configured verifier",
    );
  }
  const controller = new AbortController();
  const deadline = evidenceVerifierUnavailable(
    "External evidence verification timed out",
  );
  const timer = setTimeout(() => controller.abort(deadline), timeoutMs);
  try {
    for (const record of evidence) {
      let verified;
      try {
        verified = await waitForVerification(
          verifier.verify({
            taskId: authority.taskId,
            roleId: authority.roleId,
            contractRevision: authority.contractRevision,
            contractDigest: authority.contractDigest,
            deliverableId: authority.deliverableId,
            evidence: structuredClone(record),
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (cause) {
        if (cause === deadline) throw deadline;
        throw evidenceVerifierUnavailable(
          "External evidence authority is temporarily unavailable",
          { cause },
        );
      }
      if (verified === true) continue;
      let normalized;
      try {
        normalized = checkedClone(verified);
      } catch (cause) {
        throw evidenceRejected(
          "External evidence verifier returned invalid data",
          { cause },
        );
      }
      if (!sameValue(normalized, record)) {
        throw evidenceRejected(
          "External evidence verifier changed or rejected evidence",
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function assembleCurrentContext(assembler, input, timeoutMs) {
  const controller = new AbortController();
  const deadline = evidenceVerifierUnavailable(
    "Authoritative evidence catalog read timed out",
  );
  const timer = setTimeout(() => controller.abort(deadline), timeoutMs);
  try {
    return await waitForVerification(
      Promise.resolve().then(() => assembler.assemble({
        ...input,
        signal: controller.signal,
      })),
      controller.signal,
    );
  } catch (cause) {
    if (cause === deadline) throw cause;
    if (cause?.code === "ROLE_CONTEXT_STALE" && cause?.statusCode === 409) {
      throw stale("Unable to reassemble a current role context", { cause });
    }
    if (
      Number.isInteger(cause?.statusCode) &&
      cause.statusCode >= 500 &&
      cause.statusCode <= 599
    ) {
      throw contextUnavailable(
        "Unable to reassemble a current role context",
        { cause },
      );
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

function evidenceOfKind(evidence, kind) {
  return evidence.filter((record) => record.kind === kind);
}

function nonReservedEvidence(evidence) {
  return evidence.filter(({ kind }) => !RESERVED_EVIDENCE_KINDS.has(kind));
}

function currentExpectedDeliverable(task, deliverableId, contractRevision) {
  const contract = latestContract(task);
  const expected = contract.expectedDeliverables.find(
    (candidate) => candidate.deliverableId === deliverableId,
  );
  if (!expected || contractRevision !== contract.revision) {
    throw stale("The submitted delivery no longer matches its acceptance contract");
  }
  if (
    (deliverableId === "requirement-spec") !==
    (expected.kind === "requirement-spec")
  ) {
    throw evidenceRejected(
      "Requirement deliverable id and kind do not match",
    );
  }
  return { contract, expected };
}

function assertAcceptanceEvidence(task, submitted, externalEvidence) {
  const binding = currentExpectedDeliverable(
    task,
    submitted.deliverableId,
    submitted.contractRevision,
  );
  if (INTERNALLY_TRUSTED_DELIVERABLE_KINDS.has(binding.expected.kind)) {
    return binding;
  }
  if (!externalEvidence.some(({ kind }) => kind === binding.expected.kind)) {
    throw evidenceRejected(
      `Delivery ${submitted.deliverableId} lacks authoritative ${binding.expected.kind} evidence`,
    );
  }
  return binding;
}

function parseWorkInputsEvidence(task, evidence, acceptedInputs) {
  const records = evidenceOfKind(evidence, "work-inputs");
  if (records.length !== 1 || task.responsibility.type !== "role") {
    throw evidenceRejected("Delivery must contain one trusted work-input binding");
  }
  const record = records[0];
  const prefix = `work-inputs:${task.taskId}:`;
  if (!record.referenceId.startsWith(prefix)) {
    throw evidenceRejected("Work-input evidence is bound to another task");
  }
  const contextDigest = record.referenceId.slice(prefix.length);
  if (!SHA256.test(contextDigest)) {
    throw evidenceRejected("Work-input evidence contains an invalid context digest");
  }
  const expected = workInputsEvidence({
    taskId: task.taskId,
    roleId: task.responsibility.id,
    contextDigest,
    acceptedInputs,
  });
  if (!sameValue(record, expected)) {
    throw evidenceRejected("Work-input evidence no longer matches accepted inputs");
  }
  return contextDigest;
}

function parseRequirementSpec(task, submitted, acceptedInputs, graphRevision) {
  const records = evidenceOfKind(submitted.evidence, "requirement-spec");
  if (submitted.deliverableId !== "requirement-spec") {
    if (records.length !== 0) {
      throw evidenceRejected("Non-requirement delivery contains reserved spec evidence");
    }
    return null;
  }
  if (records.length !== 1) {
    throw evidenceRejected("Requirement delivery must contain one spec evidence record");
  }
  let parsed;
  try {
    parsed = normalizeRequirementSpec(JSON.parse(submitted.summary));
  } catch (cause) {
    throw evidenceRejected("Requirement delivery summary is not a valid specification", {
      cause,
    });
  }
  const expectedReference =
    `requirement-spec:${task.taskId}:${submitted.revision}`;
  if (
    records[0].referenceId !== expectedReference ||
    records[0].contentDigest !== parsed.contentDigest ||
    parsed.revision !== submitted.revision ||
    parsed.sourceTask.taskId !== task.taskId ||
    parsed.sourceTask.taskRevision !== task.revision - 1 ||
    parsed.sourceTask.graphRevision >= graphRevision ||
    !sameValue(parsed.acceptedInputs, acceptedInputs) ||
    submitted.summary !== JSON.stringify(parsed)
  ) {
    throw evidenceRejected("Requirement specification provenance is invalid");
  }
  return parsed;
}

function latestSubmitted(task, revision) {
  const delivery = task.deliveries.at(-1);
  if (delivery?.status !== "submitted" || delivery.revision !== revision) {
    throw stale("The requested delivery is no longer awaiting a decision");
  }
  return delivery;
}

function applied(value) {
  return value?.applied !== false;
}

function result(value) {
  return deepFreeze(value);
}

function operationResult(action, rootId, taskId, mutation, extra = {}) {
  return result({
    schemaVersion: 1,
    kind: "orchestration",
    action,
    applied: applied(mutation),
    rootTaskId: rootId,
    taskId,
    ...extra,
  });
}

async function readRecoveryGraph(graphReader) {
  try {
    return normalizeGraphView(await graphReader.getSnapshot());
  } catch {
    return null;
  }
}

async function recoverDeliverySubmission(graphReader, command, taskId, rootId) {
  const graph = await readRecoveryGraph(graphReader);
  if (!graph) return null;
  const task = graph.tasks.find((candidate) => candidate.taskId === taskId);
  const delivery = task?.deliveries.find(
    ({ revision }) => revision === command.deliveryRevision,
  );
  const expected = {
    deliverableId: command.deliverableId,
    revision: command.deliveryRevision,
    contractRevision: command.contractRevision,
    status: "submitted",
    summary: command.summary,
    evidence: command.evidence,
  };
  if (!delivery || !sameValue(delivery, expected)) return null;
  return result({
    schemaVersion: 1,
    kind: "delivery",
    action: "submit_delivery",
    applied: false,
    recovered: true,
    rootTaskId: rootId,
    taskId,
    deliveryRevision: delivery.revision,
  });
}

async function recoverDeliveryDecision(
  graphReader,
  command,
  rootId,
  expectedStatus,
) {
  const graph = await readRecoveryGraph(graphReader);
  if (!graph) return null;
  const task = graph.tasks.find(({ taskId }) => taskId === command.taskId);
  const submitted = task?.deliveries.find(
    ({ revision }) => revision === command.submittedDeliveryRevision,
  );
  const decision = task?.deliveries.find(
    ({ revision }) => revision === command.submittedDeliveryRevision + 1,
  );
  if (
    !submitted ||
    submitted.status !== "submitted" ||
    !decision ||
    decision.status !== expectedStatus ||
    decision.deliverableId !== submitted.deliverableId ||
    decision.contractRevision !== submitted.contractRevision ||
    decision.summary !== command.reason ||
    !sameValue(decision.evidence, submitted.evidence)
  ) {
    return null;
  }
  return result({
    schemaVersion: 1,
    kind: "orchestration",
    action: expectedStatus === "accepted"
      ? "accept_delivery"
      : "return_delivery",
    applied: false,
    recovered: true,
    rootTaskId: rootId,
    taskId: command.taskId,
    deliveryRevision: decision.revision,
  });
}

function projectActionResult(
  actionType,
  rootId,
  sourceTaskId,
  { createdTask = false, deliveryDecision = false } = {},
) {
  return (mutation) =>
    operationResult(
      actionType,
      rootId,
      createdTask ? mutation.taskId : sourceTaskId,
      mutation,
      deliveryDecision
        ? { deliveryRevision: mutation.deliveryRevision }
        : {},
    );
}

function planDecomposition({
  action,
  source,
  rootId,
  children,
  tasksById,
  capabilityRoles,
  reviewReplacement,
}) {
  if (source.taskId !== rootId) {
    throw denied("Only the configured root task can be decomposed");
  }
  const dependencyIds = action.dependsOn.map(({ taskId }) => taskId);
  for (const dependency of action.dependsOn) {
    const task = tasksById.get(dependency.taskId);
    if (
      !task ||
      !children.has(task.taskId) ||
      task.taskId === source.taskId ||
      task.revision !== dependency.revision ||
      task.status !== "completed" ||
      rootTaskId(task.taskId, tasksById) !== rootId
    ) {
      throw denied("A decomposition dependency is not an accepted visible child");
    }
  }
  if (
    action.acceptanceContract.expectedDeliverables.some(
      ({ deliverableId }) => deliverableId === "requirement-spec",
    )
  ) {
    const acceptedInputs = deriveAcceptedInputsFromDependencies(
      dependencyIds,
      rootId,
      tasksById,
    );
    try {
      assertRequirementSpecAcceptedInputsBudget(acceptedInputs);
    } catch (cause) {
      throw serviceError(
        "ORCHESTRATOR_REQUIREMENT_INPUT_BUDGET_EXCEEDED",
        "Requirement task inputs cannot fit in one auditable specification",
        409,
        { cause },
      );
    }
  }
  return {
    method: "createChild",
    command: {
      parentTaskId: source.taskId,
      childKey: action.childKey,
      work: action.work,
      target: {
        type: "role",
        id: specialistRoleForCapability(capabilityRoles, action.capability),
      },
      dependsOnTaskIds: dependencyIds,
      acceptanceContract: action.acceptanceContract,
      leaseId: null,
      expectedGraphRevision: action.expectedGraphRevision,
      expectedTaskRevisions: [
        { taskId: source.taskId, revision: source.revision },
        ...action.dependsOn.map(({ taskId, revision }) => ({ taskId, revision })),
      ].sort((left, right) => compareText(left.taskId, right.taskId)),
      ...(reviewReplacement ? { reviewReplacement } : {}),
    },
    recover: null,
    result: projectActionResult(action.type, rootId, source.taskId, {
      createdTask: true,
    }),
  };
}

function planAssignment({ action, source, rootId, children, capabilityRoles }) {
  if (!children.has(source.taskId)) {
    throw denied("Only a visible direct child can be assigned");
  }
  return {
    method: "reassignTask",
    command: {
      taskId: source.taskId,
      target: {
        type: "role",
        id: specialistRoleForCapability(capabilityRoles, action.capability),
      },
      reason: action.reason,
      expectedGraphRevision: action.expectedGraphRevision,
      expectedTaskRevision: action.sourceTaskRevision,
    },
    recover: null,
    result: projectActionResult(action.type, rootId, source.taskId),
  };
}

async function planDeliveryDecision({
  action,
  source,
  rootId,
  children,
  packet,
  graph,
  tasksById,
  evidenceVerifier,
  evidenceVerificationTimeoutMs,
  graphReader,
}) {
  if (!children.has(source.taskId)) {
    throw denied("Only a visible direct child delivery can be decided");
  }
  if (
    !hasVisibleSubmittedDelivery(
      packet,
      source.taskId,
      action.submittedDeliveryRevision,
    )
  ) {
    throw denied("The submitted delivery is outside the current review window");
  }
  const submitted = latestSubmitted(source, action.submittedDeliveryRevision);
  let verifiedEvidence = false;
  if (action.type === "accept_delivery") {
    if (isExternalRereview(packet.context) && reviewChildResponsibility(source) &&
        !hasRequiredReviewDeliverable(latestContract(source))) {
      throw denied("External rereview cannot be accepted from a local report");
    }
    const acceptedInputs = deriveAcceptedInputs(source, tasksById);
    const externalEvidence = nonReservedEvidence(submitted.evidence);
    parseWorkInputsEvidence(source, submitted.evidence, acceptedInputs);
    const { contract } = assertAcceptanceEvidence(
      source,
      submitted,
      externalEvidence,
    );
    parseRequirementSpec(source, submitted, acceptedInputs, graph.revision);
    await verifyExternalEvidence(
      evidenceVerifier,
      externalEvidence,
      {
        taskId: source.taskId,
        roleId: source.responsibility.id,
        contractRevision: contract.revision,
        contractDigest: deliveryAcceptanceContractDigest(contract),
        deliverableId: submitted.deliverableId,
      },
      evidenceVerificationTimeoutMs,
    );
    verifiedEvidence = externalEvidence.length > 0;
  }
  const expectedStatus =
    action.type === "accept_delivery" ? "accepted" : "rejected";
  const command = {
    taskId: source.taskId,
    submittedDeliveryRevision: action.submittedDeliveryRevision,
    decision: action.type === "accept_delivery" ? "accept" : "reject",
    reason: action.reason,
    expectedGraphRevision: action.expectedGraphRevision,
    expectedTaskRevision: action.sourceTaskRevision,
  };
  return {
    method: "decideDelivery",
    command,
    recover: () =>
      recoverDeliveryDecision(graphReader, command, rootId, expectedStatus),
    verifiedEvidence,
    result: projectActionResult(action.type, rootId, source.taskId, {
      deliveryDecision: true,
    }),
  };
}

function planEscalation({ action, source, rootId, summary }) {
  return {
    method: "stageEscalation",
    command: {
      taskId: source.taskId,
      reason: action.reason,
      expectedGraphRevision: action.expectedGraphRevision,
      expectedTaskRevision: action.sourceTaskRevision,
      summary,
      question: action.question,
      choices: action.choices,
    },
    recover: null,
    result: projectActionResult(action.type, rootId, source.taskId),
  };
}

function planTaskControl({ action, source, rootId }) {
  const method = {
    pause: "pauseTask",
    resume: "resumeTask",
    cancel: "cancelTask",
  }[action.type];
  return {
    method,
    command: {
      taskId: source.taskId,
      reason: action.reason,
      expectedGraphRevision: action.expectedGraphRevision,
      expectedTaskRevision: action.sourceTaskRevision,
      ...(action.type === "pause" && action.waitForChildren === true
        ? { waitForChildren: true }
        : {}),
    },
    recover: null,
    result: projectActionResult(action.type, rootId, source.taskId),
  };
}

async function createOrchestrationPlan(options) {
  switch (options.action.type) {
    case "decompose":
      return planDecomposition(options);
    case "assign":
      return planAssignment(options);
    case "accept_delivery":
    case "return_delivery":
      return planDeliveryDecision(options);
    case "escalate":
      return planEscalation(options);
    case "pause":
    case "resume":
    case "cancel":
      return planTaskControl(options);
    default:
      throw invalid("Unknown orchestration action");
  }
}

async function assertGraphStillCurrent(graphReader, expected) {
  let current;
  try {
    current = normalizeGraphView(await graphReader.getSnapshot());
  } catch (cause) {
    throw serviceError(
      "ORCHESTRATOR_GRAPH_UNAVAILABLE",
      "Unable to recheck the work graph after evidence verification",
      503,
      { cause },
    );
  }
  if (
    current.revision !== expected.revision ||
    current.contentDigest !== expected.contentDigest
  ) {
    throw stale("The work graph changed during evidence verification");
  }
}

export class OrchestratorService {
  #contextAssembler;
  #graphReader;
  #plannerFactory;
  #delivererFactory;
  #evidenceVerifier;
  #evidenceVerificationTimeoutMs;
  #evidenceMutationMarginMs;
  #clock;
  #capabilityRoles;
  #admitAction;
  #automaticMode;

  constructor({
    contextAssembler,
    graphReader,
    scopedGraphPlannerFactory,
    graphDelivererFactory,
    evidenceVerifier,
    evidenceVerificationTimeoutMs =
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS,
    evidenceMutationMarginMs =
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
    clock = () => new Date(),
    capabilityRoles = {},
    actionAdmissionGate,
    automaticMode = false,
  } = {}) {
    this.#contextAssembler = requirePort(
      contextAssembler,
      "assemble",
      "contextAssembler",
    );
    this.#graphReader = requirePort(graphReader, "getSnapshot", "graphReader");
    this.#plannerFactory = requirePort(
      scopedGraphPlannerFactory,
      "forRoot",
      "scopedGraphPlannerFactory",
    );
    this.#delivererFactory = requirePort(
      graphDelivererFactory,
      "forClaim",
      "graphDelivererFactory",
    );
    this.#evidenceVerifier = optionalEvidenceVerifier(evidenceVerifier);
    this.#evidenceVerificationTimeoutMs = timeoutMilliseconds(
      evidenceVerificationTimeoutMs,
      "evidenceVerificationTimeoutMs",
    );
    this.#evidenceMutationMarginMs = timeoutMilliseconds(
      evidenceMutationMarginMs,
      "evidenceMutationMarginMs",
    );
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#capabilityRoles = normalizeCapabilityRoles(capabilityRoles);
    this.#admitAction = actionAdmissionRun(actionAdmissionGate);
    this.#automaticMode = automaticMode === true;
    Object.freeze(this);
  }

  async execute(value) {
    const fields = exactMap(
      value,
      ["worker", "item", "contextPacket", "intent"],
      "execute input",
    );
    const worker = normalizeWorker(fields.get("worker"));
    const item = normalizeItem(fields.get("item"));
    const { packet: originalPacket, trigger } = packetTrigger(
      fields.get("contextPacket"),
    );
    let intent = normalizeWorkIntent(checkedClone(fields.get("intent")));
    let evidenceDeadlineAt = null;
    if (intent.type === "submit_delivery") {
      assertLocalSubmissionClaim({ worker, item, intent });
      evidenceDeadlineAt = this.#evidenceDeadline(item);
    }

    const freshPacket = await assembleCurrentContext(
      this.#contextAssembler,
      {
        roleId: worker.roleId,
        item: item.value,
        trigger,
      },
      this.#remainingEvidenceBudget(evidenceDeadlineAt),
    );
    const packet = assertPacketIsFresh(originalPacket, freshPacket);
    intent = rebaseIntentGraphRevision(intent, originalPacket, packet);

    let graph;
    try {
      graph = normalizeGraphView(await this.#graphReader.getSnapshot());
    } catch (cause) {
      throw serviceError(
        "ORCHESTRATOR_GRAPH_UNAVAILABLE",
        "Unable to read the current work graph",
        503,
        { cause },
      );
    }
    assertGraphBinding(packet, graph);
    const tasksById = graphIndex(graph);
    const bindingTask = assertCurrentItem({
      item,
      packet,
      worker,
      tasksById,
    });

    if (intent.type === "orchestrate") {
      return this.#executeOrchestration({
        worker,
        item,
        packet,
        intent,
        graph,
        tasksById,
        bindingTask,
      });
    }
    if (intent.type === "submit_delivery") {
      return this.#executeSubmission({
        worker,
        item,
        packet,
        intent,
        graph,
        tasksById,
        bindingTask,
        evidenceDeadlineAt,
      });
    }
    throw invalid("OrchestratorService only accepts trusted graph intents");
  }

  #evidenceDeadline(item) {
    if (item.leaseUntil === null) return null;
    const now = this.#clock();
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("clock returned an invalid value");
    }
    return Date.now() + Date.parse(item.leaseUntil) - nowMs;
  }

  #remainingEvidenceBudget(evidenceDeadlineAt) {
    if (evidenceDeadlineAt === null) {
      return this.#evidenceVerificationTimeoutMs;
    }
    const availableMs = Math.floor(
      evidenceDeadlineAt - Date.now() - this.#evidenceMutationMarginMs,
    );
    if (availableMs < 1) {
      throw evidenceVerifierUnavailable(
        "The active work lease has no remaining evidence budget",
      );
    }
    return Math.min(this.#evidenceVerificationTimeoutMs, availableMs);
  }

  async #executeOrchestration({
    worker,
    item,
    packet,
    intent,
    graph,
    tasksById,
    bindingTask,
  }) {
    assertOrchestrator(worker, bindingTask);
    if (!permitsReviewPublicationSettlementIntent(packet.context, intent)) {
      throw denied("Historical Review settlement only permits accepting its exact published delivery");
    }
    const children = directChildIds(packet);
    const action = intent.action;
    const reviewReplacement = assertStructuredPrTriageAction(packet, children, action, tasksById, this.#automaticMode, this.#capabilityRoles);
    const source = assertActionSource(
      action,
      graph,
      tasksById,
      bindingTask,
      children,
    );
    const rootId = bindingTask.taskId;
    const goalControl = coordinatorGoalControl({ rootTaskId: rootId, parentTaskId: bindingTask.parentTaskId,
      event: item.value?.source?.current?.event ?? item.value?.event, source: item.value?.source ?? null,
      childTaskIds: [...children] });
    if (action.type === "cancel" && !["cancelled", "completed", "superseded"].includes(source.status) &&
        !permitsCoordinatorCancellation(goalControl, source.taskId)) {
      throw denied("The coordinator may replace child plans, but cannot cancel the owner's goal");
    }
    const plan = await createOrchestrationPlan({
      action,
      source,
      rootId,
      children,
      packet,
      graph,
      tasksById,
      summary: intent.summary,
      capabilityRoles: this.#capabilityRoles,
      reviewReplacement,
      evidenceVerifier: this.#evidenceVerifier,
      evidenceVerificationTimeoutMs: this.#evidenceVerificationTimeoutMs,
      graphReader: this.#graphReader,
    });
    if (plan.verifiedEvidence) {
      await assertGraphStillCurrent(this.#graphReader, graph);
    }
    const planner = this.#plannerFactory.forRoot({ scopeRootTaskId: rootId });
    let operation;
    try {
      operation = requirePort(
        planner,
        plan.method,
        "trustedGraphPlanner",
      )[plan.method];
    } catch (cause) {
      throw serviceError(
        "ORCHESTRATOR_GRAPH_PORT_UNAVAILABLE",
        `Trusted graph operation ${plan.method} is unavailable`,
        503,
        { cause },
      );
    }
    const command = deepFreeze(checkedClone(plan.command));
    const admitted = await this.#admitAction(() => carryOperation(() => {
      // The exact graph operation is started while authority is current, but
      // its Promise is carried out so configuration cutover never waits on
      // graph persistence or recovery reads.
      return operation(command);
    }));
    let mutation;
    try {
      if (admitted.status === "failed") throw admitted.error;
      mutation = await admitted.operation;
    } catch (cause) {
      const recovered = plan.recover ? await plan.recover() : null;
      if (recovered) return recovered;
      throw cause;
    }
    return plan.result(mutation);
  }

  async #executeSubmission({
    worker,
    item,
    packet,
    intent,
    graph,
    tasksById,
    bindingTask,
    evidenceDeadlineAt,
  }) {
    assertLocalSubmissionClaim({ worker, item, intent });
    if (
      bindingTask.responsibility.type !== "role" ||
      bindingTask.responsibility.id !== worker.roleId ||
      intent.expectedGraphRevision !== graph.revision
    ) {
      throw denied("The specialist delivery is not bound to the active claim");
    }
    const { contract } = currentExpectedDeliverable(
      bindingTask,
      intent.deliverableId,
      intent.contractRevision,
    );
    const acceptedInputs = deriveAcceptedInputs(bindingTask, tasksById);
    if (!sameValue(packet.acceptedInputs, acceptedInputs)) {
      throw stale("The specialist inputs changed before delivery submission");
    }
    await verifyExternalEvidence(
      this.#evidenceVerifier,
      intent.evidence,
      {
        taskId: item.itemId,
        roleId: worker.roleId,
        contractRevision: contract.revision,
        contractDigest: deliveryAcceptanceContractDigest(contract),
        deliverableId: intent.deliverableId,
      },
      this.#remainingEvidenceBudget(evidenceDeadlineAt),
    );
    if (intent.evidence.length > 0) {
      await assertGraphStillCurrent(this.#graphReader, graph);
    }

    const deliveryRevision = bindingTask.deliveries.length + 1;
    const trustedEvidence = [
      ...intent.evidence.map((record) => ({ ...record })),
      workInputsEvidence({
        taskId: item.itemId,
        roleId: worker.roleId,
        contextDigest: packet.contextDigest,
        acceptedInputs,
      }),
    ];
    let summary = intent.summary;
    if (intent.deliverableId === "requirement-spec") {
      const specification = createRequirementSpec({
        draft: intent.artifact,
        revision: deliveryRevision,
        sourceTask: {
          taskId: item.itemId,
          taskRevision: item.revision,
          graphRevision: graph.revision,
        },
        acceptedInputs,
      });
      summary = JSON.stringify(specification);
      trustedEvidence.push({
        kind: "requirement-spec",
        referenceId: `requirement-spec:${item.itemId}:${deliveryRevision}`,
        contentDigest: specification.contentDigest,
      });
    }
    trustedEvidence.sort((left, right) =>
      compareText(
        `${left.kind}:${left.referenceId}:${left.contentDigest}`,
        `${right.kind}:${right.referenceId}:${right.contentDigest}`,
      )
    );
    const command = {
      deliveryRevision,
      contractRevision: intent.contractRevision,
      deliverableId: intent.deliverableId,
      summary,
      evidence: trustedEvidence,
      expectedGraphRevision: intent.expectedGraphRevision,
      expectedTaskRevision: intent.expectedTaskRevision,
    };
    const rootId = rootTaskId(bindingTask.taskId, tasksById);
    const deliverer = this.#delivererFactory.forClaim({
      scopeRootTaskId: item.itemId,
      taskId: item.itemId,
      workerId: worker.workerId,
      leaseId: item.leaseId,
    });
    let submitDelivery;
    try {
      submitDelivery = requirePort(
        deliverer,
        "submitDelivery",
        "trustedGraphDeliverer",
      ).submitDelivery;
    } catch (cause) {
      throw serviceError(
        "ORCHESTRATOR_GRAPH_PORT_UNAVAILABLE",
        "Trusted delivery operation is unavailable",
        503,
        { cause },
      );
    }
    const sealedCommand = deepFreeze(checkedClone(command));
    const admitted = await this.#admitAction(() => carryOperation(() => {
      // Keep only the synchronous mutation admission inside the shared gate.
      return submitDelivery(sealedCommand);
    }));
    let mutation;
    try {
      if (admitted.status === "failed") throw admitted.error;
      mutation = await admitted.operation;
    } catch (cause) {
      const recovered = await recoverDeliverySubmission(
        this.#graphReader,
        sealedCommand,
        item.itemId,
        rootId,
      );
      if (recovered) return recovered;
      throw cause;
    }
    return result({
      schemaVersion: 1,
      kind: "delivery",
      action: "submit_delivery",
      applied: applied(mutation),
      rootTaskId: rootId,
      taskId: item.itemId,
      deliveryRevision,
    });
  }
}
