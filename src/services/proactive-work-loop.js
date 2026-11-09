import { normalizeWorkDecision } from "../domain/work-intent.js";
import { isParentCoordinationReturn } from './work-ledger-graph-responsibility.js';
import { indexWorkLedgerGraphProgress } from './work-ledger-graph-progress.js';
import { isDeepStrictEqual } from "node:util";
import { permitsReviewPublicationSettlementIntent } from "./review-publication-settlement.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { TaskRunControlError } from './task-run-registry.js';
import { automaticReviewWorkEligibility } from "../domain/automatic-review-policy.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { TargetedCycleQueue } from "../lib/targeted-cycle-queue.js";
import { normalizeContinuationTarget, matchesContinuationTarget } from "./work-continuation-state.js";
import { brainFailureOwnerAttention } from "./brain-failure-policy.js";
import { createBrainRecoveryIntent } from "./brain-recovery-intent.js";
import { isWorkItemBrainInfrastructureFailure, requiresBrainMaintenance } from "../domain/brain-failure-recovery.js";
import { OrchestratorServiceError } from "./orchestrator-service.js";
import { RoleContextAssemblerError } from "./role-context-error.js";
import { PrEngineerServiceError } from "./pr-engineer-service.js";
import {
  normalizeWorkCoordinationTiming,
  WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS,
  WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS,
} from "./work-coordination-timing.js";
import {
  canRecoverPullRequestDecisionBudget,
  currentWorkItemEvent,
  currentWorkItemExecutionBinding,
  isPullRequestDecisionBudgetRecoveryCandidate,
  pullRequestDecisionAttemptBudget,
  persistedPullRequestDecisionAttemptBudget,
} from "./work-ledger-pr-source.js";
import { isPreWriteGraphRevisionConflict } from "./work-ledger-graph-command-support.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DEFAULT_INTAKE_LIMIT = 100;
const DEFAULT_WORK_LIMIT = 20;
const MAX_PAGE_COUNT = 100;
const PAGE_SIZE = 100;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const ORCHESTRATOR_ROLE_ID = "orchestrator";
const ORCHESTRATOR_WORKER_ID = "employee-orchestrator";
const SATISFIED_GRAPH_STATUSES = new Set(["completed", "superseded"]);
const SETTLED_GRAPH_CHILD_STATUSES = new Set([
  ...SATISFIED_GRAPH_STATUSES,
  "cancelled",
]);
const RUNTIME_ADMISSION_ERROR_CODES = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);
const ROOT_DECISION_DEFERRED_ERROR_CODES = new Set([
  "ROLE_CONTEXT_TIMEOUT",
  "STRUCTURED_BRAIN_RESPONSE_INVALID",
  "STRUCTURED_PROVIDER_RESPONSE_INVALID",
  "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION",
]);
const CONTEXT_CONTENTION_ERROR_CODES = new Set([
  "ROLE_CONTEXT_STALE",
  "ROLE_DECISION_INPUT_STALE",
  "ORCHESTRATOR_CONTEXT_STALE",
  "PR_REVIEW_READ_HEAD_CHANGED",
  "PR_REVIEW_READ_MATERIAL_CHANGED",
  "WORK_LEDGER_REVISION_CONFLICT",
]);

function isContextContention(error) {
  return CONTEXT_CONTENTION_ERROR_CODES.has(stableFailureCode(error)) ||
    isPreWriteGraphRevisionConflict(error);
}
const NON_BUDGET_CLAIM_FAILURE_CODES = new Set([
  "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  "WORK_LEDGER_GRAPH_BLOCKED",
]);
const PR_PREPARATION_DEFERRED_CODES = new Set([
  "CONTROLLED_GIT_UNSUPPORTED_TREE",
  "CONTROLLED_GIT_TIMEOUT",
  "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING",
  "OWN_PR_CONFLICT_TARGET_CHANGED",
  "OWN_PR_REPAIR_OBJECT_FETCH_FAILED",
  "OWN_PR_REPAIR_OBJECT_TIMEOUT",
  "OWN_PR_REPAIR_OBJECT_CREDENTIAL_FAILED",
  "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED",
]);
const DECISION_FAILURE_REASONS = Object.freeze({
  retry: "decision_failed",
  exhausted: "decision_attempts_exhausted",
});
const DELIVERY_FAILURE_REASONS = Object.freeze({
  retry: "delivery_failed",
  exhausted: "delivery_attempts_exhausted",
});
const OWNER_REQUEST_PRIORITIES = Object.freeze({
  normal: 1,
  high: 2,
  urgent: 3,
});
const HIGH_PRIORITY_ISSUE_LABELS = new Set([
  "urgent",
  "blocker",
  "priority: high",
  "p0",
  "p1",
]);

function requirePort(value, methods, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const port = {};
  try {
    for (const method of methods) {
      let current = value;
      let found = false;
      while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, method);
        if (descriptor) {
          if (
            !("value" in descriptor) ||
            typeof descriptor.value !== "function"
          ) {
            throw new TypeError(`${name} is invalid`);
          }
          port[method] = descriptor.value.bind(value);
          found = true;
          break;
        }
        current = Object.getPrototypeOf(current);
      }
      if (!found) throw new TypeError(`${name} is invalid`);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  return Object.freeze(port);
}

function optionalPortMethod(value, method, name) {
  let current = value;
  try {
    while (current !== null && current !== undefined) {
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
  return null;
}

function boundedString(value, name, maximumBytes = 128) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeRoleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError("roleId is invalid");
  }
  return value;
}

function dataEntries(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function cycleOptions(value = {}) {
  const entries = dataEntries(value);
  if (!entries) throw new TypeError("runCycle options are invalid");
  const input = Object.fromEntries(entries);
  if (
    Object.keys(input).some(
      (key) =>
        !["trigger", "intakeLimit", "workLimit", "roleId", "signal", "continuationTarget"].includes(
          key,
        ),
    )
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const continuationTarget = normalizeContinuationTarget(input.continuationTarget);
  if (continuationTarget !== null && input.roleId == null) throw new TypeError('target requires a work role');
  return Object.freeze({
    continuationTarget,
    trigger:
      input.trigger === undefined
        ? "scheduled"
        : boundedString(input.trigger, "trigger"),
    intakeLimit:
      input.intakeLimit === undefined
        ? DEFAULT_INTAKE_LIMIT
        : positiveInteger(input.intakeLimit, "intakeLimit", 100),
    workLimit:
      input.workLimit === undefined
        ? DEFAULT_WORK_LIMIT
        : positiveInteger(input.workLimit, "workLimit", 100),
    roleId: input.roleId === undefined ? null : safeRoleId(input.roleId),
    signal: normalizeAbortSignal(input.signal ?? null),
  });
}

function throwIfLoopAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error("Proactive work cycle was cancelled"), {
    code: "PROACTIVE_WORK_CANCELLED",
  });
}

function normalizeLoopClock(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    throw new TypeError("clock failed", { cause: error });
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw new TypeError("clock is invalid");
  }
  return timestamp;
}

function targetKey(target) {
  return `${target.type}:${target.id}`;
}

function isAvailable(item, now) {
  if (item.status === "queued") return true;
  if (item.status === "retry_wait") {
    return Date.parse(item.availableAt) <= Date.parse(now);
  }
  return (
    item.status === "working" &&
    typeof item.leaseUntil === "string" &&
    Date.parse(item.leaseUntil) <= Date.parse(now)
  );
}

function ownerRequestPriority(item) {
  let event;
  try {
    event = currentWorkItemEvent(item);
  } catch {
    return 0;
  }
  if (
    event?.source?.provider !== "local-owner" ||
    ![
      "owner_request.created",
      "pull_request.owner_requested",
      "issue.owner_requested",
    ].includes(
      event.eventType,
    )
  ) {
    return 0;
  }
  return OWNER_REQUEST_PRIORITIES[event.payload?.priority] ?? 0;
}

function issueEventFacts(item) {
  let event;
  try {
    event = currentWorkItemEvent(item);
  } catch {
    return null;
  }
  if (
    event?.source?.provider !== "github" ||
    typeof event.eventType !== "string" ||
    !event.eventType.startsWith("issue.") ||
    !event.payload ||
    typeof event.payload !== "object"
  ) {
    return null;
  }
  return event;
}

function issueUpdatedAt(event) {
  const value = event?.payload?.updatedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
}

function issueIsEligible(item, now, activeWindowDays) {
  const event = issueEventFacts(item);
  if (event === null) return true;
  if (["issue.completed", "issue.left_scope"].includes(event.eventType)) {
    return true;
  }
  const updatedAt = issueUpdatedAt(event);
  if (updatedAt === null) return true;
  return updatedAt > Date.parse(now) - activeWindowDays * 86_400_000;
}

function issuePriority(item) {
  const event = issueEventFacts(item);
  if (event === null) return 0;
  const labels = Array.isArray(event.payload.labels)
    ? event.payload.labels
    : [];
  return labels.some(
    (label) =>
      typeof label === "string" &&
      HIGH_PRIORITY_ISSUE_LABELS.has(label.toLowerCase()),
  )
    ? 1
    : 0;
}

function prioritizeWorkItems(items, candidateFacts, graphBlocked) {
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const children = childrenByParent.get(parentItemId) ?? [];
    children.push(item);
    childrenByParent.set(parentItemId, children);
  }
  return items
    .map((item, index) => {
      const issueEvent = issueEventFacts(item);
      const facts = candidateFacts?.get(item.itemId);
      const isRoot = item.currentTarget?.type === "role" &&
          item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
          item.graph?.parentItemId === null;
      const children = isRoot ? childrenByParent.get(item.itemId) ?? [] : [];
      const submittedChildren = facts?.submittedChildren ?? children.filter((child) =>
        child.graph?.deliveries?.at(-1)?.status === "submitted"
      ).length;
      const satisfiedChildren = facts?.satisfiedChildren ?? children.filter((child) =>
        SETTLED_GRAPH_CHILD_STATUSES.has(child.status)
      ).length;
      return {
        item,
        index,
        priority: Math.max(ownerRequestPriority(item), currentWorkItemEvent(item)?.payload?.reviewReceivedAt ? 2 : 0),
        issuePriority: issuePriority(item),
        issueUpdatedAt: issueUpdatedAt(issueEvent) ?? 0,
        isIssue: issueEvent !== null,
        submittedChildren,
        satisfiedChildren,
        waitingRoot: isRoot && graphBlocked.has(item.itemId) &&
          submittedChildren === 0 && satisfiedChildren === 0,
      };
    })
    .sort((left, right) =>
      right.priority - left.priority ||
      right.submittedChildren - left.submittedChildren ||
      right.satisfiedChildren - left.satisfiedChildren ||
      right.issuePriority - left.issuePriority ||
      Number(left.waitingRoot) - Number(right.waitingRoot) ||
      (left.isIssue && right.isIssue
        ? right.issueUpdatedAt - left.issueUpdatedAt
        : 0) ||
      left.index - right.index
    )
    .map(({ item }) => item);
}

function graphBlockedItemIds(items) {
  const statusById = new Map(items.map((item) => [item.itemId, item.status]));
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const childIds = childrenByParent.get(parentItemId) ?? [];
    childIds.push(item.itemId);
    childrenByParent.set(parentItemId, childIds);
  }
  return new Set(
    items
      .filter((item) => {
        const dependencies = item.graph?.dependsOnItemIds;
        const blockedByDependency = Array.isArray(dependencies) &&
          dependencies.some(
            (dependencyId) =>
              !SATISFIED_GRAPH_STATUSES.has(statusById.get(dependencyId)),
          );
        const blockedByChild = (childrenByParent.get(item.itemId) ?? []).some(
          (childId) =>
            !SETTLED_GRAPH_CHILD_STATUSES.has(statusById.get(childId)),
        );
        return blockedByDependency || blockedByChild;
      })
      .map(({ itemId }) => itemId),
  );
}

function candidatePriorityFacts(items) {
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const children = childrenByParent.get(parentItemId) ?? [];
    children.push(item);
    childrenByParent.set(parentItemId, children);
  }
  return new Map(items.map((item) => {
    const children = childrenByParent.get(item.itemId) ?? [];
    return [item.itemId, {
      itemId: item.itemId,
      submittedChildren: children.filter((child) =>
        child.graph?.deliveries?.at(-1)?.status === "submitted"
      ).length,
      satisfiedChildren: children.filter((child) =>
        SETTLED_GRAPH_CHILD_STATUSES.has(child.status)
      ).length,
    }];
  }));
}

function isConfiguredRootItem(item, resolution) {
  return (
    resolution.orchestrator === false &&
    resolution.roleId === ORCHESTRATOR_ROLE_ID &&
    item.currentTarget.type === "role" &&
    item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
    item.graph?.parentItemId === null
  );
}

function blockedRootSweepFingerprint(item, progress) {
  // Child delivery or contract changes need not revise the root. Include only
  // its related items so another role's unrelated writes cannot restart the sweep.
  const current = progress.byId.get(item.itemId);
  if (current?.revision !== item.revision) return null;
  const dependencies = new Set(item.graph?.dependsOnItemIds ?? []);
  const related = progress.relatedItems(item);
  if ([...dependencies].some((itemId) => !related.some((candidate) => candidate.itemId === itemId)) ||
      related.some((candidate) => !Number.isSafeInteger(candidate.revision))) return null;
  return JSON.stringify([item.revision, related
    .map(({ itemId, revision }) => [itemId, revision])
    .sort(([left], [right]) => left.localeCompare(right))]);
}

function stableFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (
      typeof code === "string" &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ) {
      return code;
    }
  } catch {
    // Errors are untrusted; fall through to one stable local classification.
  }
  return "ROLE_DECISION_FAILED";
}

function terminalPullRequestState(error) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      visited.has(current)
    ) {
      return null;
    }
    visited.add(current);
    try {
      const codeDescriptor = Object.getOwnPropertyDescriptor(current, "code");
      const stateDescriptor = Object.getOwnPropertyDescriptor(
        current,
        "terminalState",
      );
      if (
        codeDescriptor &&
        "value" in codeDescriptor &&
        codeDescriptor.value === "PR_FACTS_TERMINAL" &&
        stateDescriptor &&
        "value" in stateDescriptor &&
        ["CLOSED", "MERGED"].includes(stateDescriptor.value)
      ) {
        return stateDescriptor.value;
      }
      const causeDescriptor = Object.getOwnPropertyDescriptor(current, "cause");
      if (!causeDescriptor || !("value" in causeDescriptor)) return null;
      current = causeDescriptor.value;
    } catch {
      return null;
    }
  }
  return null;
}

function claimFailureOutcome(claim) {
  return {
    status: claim.status,
    ...(claim.code ? { code: claim.code } : {}),
  };
}

function claimFailureConsumesWorkBudget(claim) {
  return !NON_BUDGET_CLAIM_FAILURE_CODES.has(claim.code);
}

function isUnclaimedRootContextDeferral(result) {
  return (
    !result.claimAttempted &&
    result.outcome.status === "decision_deferred" &&
    (result.outcome.code === "PR_FACTS_STALE" ||
      ROOT_DECISION_DEFERRED_ERROR_CODES.has(result.outcome.code))
  );
}

function configuredResultConsumesWorkBudget(result) {
  if (result.outcome.status === "maintenance_required") return false;
  if (isUnclaimedRootContextDeferral(result)) return false;
  if (result.decisionSkipped === true && result.outcome.status === "graph_blocked") return false;
  return result.claimed ||
    !result.claimAttempted ||
    claimFailureConsumesWorkBudget(result.outcome);
}

function hasHealthyPendingRereviewChildren(item, context) {
  const event = currentWorkItemEvent(item);
  const payload = event?.payload;
  if (event?.eventType !== "pull_request.owner_requested" || event.source?.provider !== "local-owner" ||
      payload?.workType !== "general" || payload.nextAction !== "rereview" || payload.suggestedCapability !== "pr-review" ||
      typeof payload.expectedHeadRefOid !== "string" || payload.expectedHeadRefOid !== payload.headRefOid) return false;
  const coordination = context?.requirements?.coordination;
  const children = coordination?.directChildren;
  if (!Array.isArray(children) || children.length === 0 || coordination.deliveryWindow?.pendingCount !== 0 ||
      coordination.deliveryWindow.hasMore !== false) return false;
  return children.every(child => child.responsibility?.type === "role" && child.responsibility.id === "pr-engineer" &&
    ["queued", "working", "dispatch_pending", "waiting_external"].includes(child.ledgerStatus) &&
    child.hasMoreDeliverables === false && child.hasAcceptedRequiredReview === false && child.hasOtherDependencies === false &&
    Array.isArray(child.directDependencyTaskIds) && child.directDependencyTaskIds.length === 0 &&
    Array.isArray(child.deliverables) && child.deliverableCount === child.deliverables.length &&
    child.deliverables.some(slot => slot.required === true && ["review-report", "github-review"].includes(slot.kind)) &&
    child.deliverables.every(slot => slot.state === "none"));
}

function ownErrorData(error, name) {
  const descriptor = Object.getOwnPropertyDescriptor(error, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isStalePullRequestFactContext(error) {
  // A changed GitHub target or obsolete ledger binding defers its root. Other context
  // failures retain their existing admission, durability, or failure behavior.
  try {
    if (
      !(error instanceof RoleContextAssemblerError) ||
      ownErrorData(error, "code") !== "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" ||
      ownErrorData(error, "statusCode") !== 503
    ) return false;
    const refresh = ownErrorData(error, "cause");
    if (refresh instanceof Error &&
        ownErrorData(refresh, "code") === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" &&
        ownErrorData(refresh, "statusCode") === 409 && ownErrorData(refresh, "cause") === undefined) return true;
    if (
      !(refresh instanceof PrEngineerServiceError) ||
      ownErrorData(refresh, "code") !== "PR_FACT_REFRESH_FAILED" ||
      ownErrorData(refresh, "statusCode") !== 503
    ) return false;
    const stale = ownErrorData(refresh, "cause");
    return stale instanceof Error &&
      ownErrorData(stale, "name") === "GitHubReadError" &&
      ownErrorData(stale, "code") === "PR_FACTS_STALE" &&
      ownErrorData(stale, "statusCode") === 409 &&
      ownErrorData(stale, "cause") === undefined;
  } catch {
    return false;
  }
}

function isInitialInternalReviewFactBlock(item) {
  const source = item.source;
  const event = currentWorkItemEvent(item);
  return item.kind === "source_root" && source?.kind === "pull_request" &&
    item.currentTarget?.type === "role" && item.currentTarget.id === "pr-engineer" &&
    item.status === "blocked" && item.statusReason === "decision_attempts_exhausted" &&
    item.activeIntentId === null && item.decisionContext === null && item.sourceQuarantine === null &&
    item.ownerId === null && item.leaseId === null && item.leaseUntil === null &&
    source.scope.kind === "internal_review" && source.scope.active === true &&
    source.pendingRevision === null && source.activeRevision === 1 && source.revisions.length === 1 &&
    event?.eventType === "pull_request.internal_review_requested" && event.source.provider === "internal-review-repair" &&
    Number.isSafeInteger(item.attempt) && item.attempt > 0 && item.attempt <= 100;
}

function completeInternalReviewFactFailureHistory(item, timeline) {
  const events = [...timeline].sort((left, right) => left.sequence - right.sequence);
  const creation = events[0];
  if (events.length !== 1 + item.attempt * 2 || creation?.type !== "pr_source_created" ||
      creation.at !== item.createdAt || creation.details?.workKey !== item.source.workKey ||
      creation.details.headRefOid !== item.source.current.headRefOid || creation.details.inputRevision !== 1 ||
      events.at(-1).at !== item.updatedAt || new Set(events.map(entry => entry.sequence)).size !== events.length) return false;
  for (let attempt = 1; attempt <= item.attempt; attempt += 1) {
    const claimed = events[attempt * 2 - 1];
    const failed = events[attempt * 2];
    if (claimed.type !== "claimed" || claimed.details?.attempt !== attempt || claimed.details.inputDigest !== item.inputDigest ||
        failed.actorId !== claimed.actorId || failed.details?.fromStatus !== "working") return false;
    if (attempt === item.attempt) {
      if (failed.type !== "transitioned" || failed.details.toStatus !== "blocked" ||
          failed.details.reason !== "decision_attempts_exhausted" ||
          failed.details.context?.code !== "ROLE_CONTEXT_PR_FACT_UNAVAILABLE") return false;
    } else if (failed.type !== "retry_scheduled" || failed.details.reason !== "decision_failed" ||
        failed.details.code !== "ROLE_CONTEXT_PR_FACT_UNAVAILABLE") return false;
  }
  return true;
}

function timeoutError(code) {
  return Object.assign(new Error(code), { code });
}

async function withinAbortable(
  operation,
  durationMs,
  code,
  parentSignal = null,
) {
  const controller = new AbortController();
  const deadline = timeoutError(code);
  const handleParentAbort = () => {
    if (controller.signal.aborted) return;
    controller.abort(
      parentSignal.reason instanceof Error
        ? parentSignal.reason
        : Object.assign(new Error("Proactive work cycle was cancelled"), {
            code: "PROACTIVE_WORK_CANCELLED",
          }),
    );
  };
  if (parentSignal?.aborted) handleParentAbort();
  parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(deadline);
  }, durationMs);
  try {
    const result = await Promise.resolve().then(() =>
      operation(controller.signal),
    );
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    // A saved owner control must retain its claim while stop evidence is pending.
    if (error instanceof TaskRunControlError) throw error;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", handleParentAbort);
  }
}

function workerItemDto(item) {
  const {
    ownerId: _ownerId,
    leaseId: _leaseId,
    leaseUntil: _leaseUntil,
    ...visible
  } = item;
  return structuredClone({
    ...visible,
    event: currentWorkItemEvent(item),
  });
}

function orchestratorDecision(target) {
  const targetLabel = `${target.type}:${target.id}`;
  return {
    schemaVersion: 1,
    confidence: 100,
    summary: "需要用户决定缺失岗位的工作路由",
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary: `目标 ${targetLabel} 当前没有可执行员工`,
      reason: "系统保留了原始分派，但无法安全替用户选择接手人",
      question: `工作原计划交给 ${targetLabel}，请决定由谁接手或如何重新路由。`,
      choices: [
        {
          id: "reroute",
          label: "重新路由",
          description: "选择另一个岗位或员工处理。",
        },
        {
          id: "take-over",
          label: "我来接手",
          description: "将该工作保留给用户亲自处理。",
        },
        {
          id: "keep-waiting",
          label: "继续等待",
          description: "保持工作不执行，等待目标岗位可用。",
        },
      ],
    },
  };
}

function activeQuestionTargets(items) {
  return new Set(
    items
      .filter((item) =>
        ["dispatch_pending", "waiting_user"].includes(item.status),
      )
      .map((item) => targetKey(item.currentTarget)),
  );
}

export class ProactiveWorkLoop {
  constructor({
    ledger,
    roleDirectory,
    clock = () => new Date(),
    leaseDurationMs,
    maxAttempts = 3,
    retryBaseMs = 30 * 1000,
    retryMaxMs = 15 * 60 * 1000,
    resolveTimeoutMs,
    decideTimeoutMs,
    roleContextAssembler,
    orchestratorService,
    memoryQueryService,
    issueActiveWindowDays = 14,
    automaticReviewPolicy = null,
    automaticOwnPrRepair = null,
    reviewRepairContextReader = null,
    taskRuns = null,
  } = {}) {
    this.taskRuns = taskRuns;
    this.automaticReviewPolicy = automaticReviewPolicy;
    this.reviewRecoveryCursor = null;
    this.automaticOwnPrRepair = automaticOwnPrRepair;
    this.readReviewRepairContext = optionalPortMethod(reviewRepairContextReader,
      "readBinding", "reviewRepairContextReader.readBinding");
    this.ledger = requirePort(
      ledger,
      [
        "intake",
        "listItems",
        "claim",
        "stageIntent",
        "scheduleRetry",
        "transition",
      ],
      "ledger",
    );
    this.readItemForReconciliation = optionalPortMethod(
      ledger,
      "readItemForReconciliation",
      "ledger.readItemForReconciliation",
    );
    this.listTimeline = optionalPortMethod(ledger, "listTimeline", "ledger.listTimeline");
    this.readRepairDecisionBudget = optionalPortMethod(ledger, 'readRepairDecisionBudget', 'ledger.readRepairDecisionBudget');
    this.recoverUnstartedReviewProposal = optionalPortMethod(ledger,
      "recoverUnstartedReviewProposal", "ledger.recoverUnstartedReviewProposal");
    this.canRecoverUnstartedReviewProposal = optionalPortMethod(ledger,
      "canRecoverUnstartedReviewProposal", "ledger.canRecoverUnstartedReviewProposal");
    this.verifyPullRequestExecutionBinding = optionalPortMethod(
      ledger, "verifyPullRequestExecutionBinding", "ledger.verifyPullRequestExecutionBinding",
    );
    this.listClaimCandidates = optionalPortMethod(
      ledger,
      "listClaimCandidates",
      "ledger.listClaimCandidates",
    );
    this.retireInactiveIssues = optionalPortMethod(
      ledger,
      "retireInactiveIssues",
      "ledger.retireInactiveIssues",
    );
    this.roleDirectory = requirePort(
      roleDirectory,
      ["resolve"],
      "roleDirectory",
    );
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.clock = clock;
    const timing = normalizeWorkCoordinationTiming(
      {
        leaseDurationMs,
        resolveTimeoutMs,
        decisionTimeoutMs: decideTimeoutMs,
      },
      {
        roleContextEnabled:
          roleContextAssembler != null && orchestratorService != null,
      },
    );
    this.leaseDurationMs = timing.leaseDurationMs;
    this.resolveTimeoutMs = timing.resolveTimeoutMs;
    this.decideTimeoutMs = timing.decisionTimeoutMs;
    this.maxAttempts = positiveInteger(maxAttempts, "maxAttempts", 100);
    this.retryBaseMs = positiveInteger(
      retryBaseMs,
      "retryBaseMs",
      24 * 60 * 60 * 1000,
    );
    this.retryMaxMs = positiveInteger(
      retryMaxMs,
      "retryMaxMs",
      24 * 60 * 60 * 1000,
    );
    this.issueActiveWindowDays = positiveInteger(
      issueActiveWindowDays,
      "issueActiveWindowDays",
      3_650,
    );
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new TypeError("retryMaxMs is invalid");
    }
    if ((roleContextAssembler == null) !== (orchestratorService == null)) {
      throw new TypeError(
        "roleContextAssembler and orchestratorService must be configured together",
      );
    }
    this.roleContextAssembler = roleContextAssembler == null
      ? null
      : requirePort(
          roleContextAssembler,
          ["assemble"],
          "roleContextAssembler",
        );
    this.orchestratorService = orchestratorService == null
      ? null
      : requirePort(
          orchestratorService,
          ["execute"],
          "orchestratorService",
        );
    if (memoryQueryService != null && this.roleContextAssembler === null) {
      throw new TypeError(
        "memoryQueryService requires roleContextAssembler",
      );
    }
    this.memoryQueryService = memoryQueryService == null
      ? null
      : requirePort(
          memoryQueryService,
          ["execute", "verifyContext"],
          "memoryQueryService",
        );
    const leaseSafeDecisionPhaseMs =
      this.leaseDurationMs -
      this.resolveTimeoutMs -
      WORK_COORDINATION_EVIDENCE_VERIFICATION_TARGET_MS -
      WORK_COORDINATION_EVIDENCE_MUTATION_MARGIN_MS;
    this.decisionPhaseTimeoutMs = this.memoryQueryService === null
      ? this.decideTimeoutMs
      : Math.min(this.decideTimeoutMs * 3, leaseSafeDecisionPhaseMs);
    this.inFlightByScope = new Map();
    this.targetedCycles = new TargetedCycleQueue();
    this.inFlightItemIds = new Set();
    this.inFlightQuestionTargets = new Set();
    this.lastIssueRetirementKey = null;
    this.issueRetirementSweep = null;
    this.fencedClaimDeferrals = new Map();
    this.roleResolutionDeferrals = new Map();
    this.rootContextDeferralSweeps = new Map();
    this.prPreparationSweeps = new Map();
    this.blockedRootSweeps = new Map();
    this.claimCycleSequences = new Map();
  }

  runCycle(input = {}) {
    const options = cycleOptions(input);
    throwIfLoopAborted(options.signal);
    const scope = options.roleId ?? "*";
    if (options.continuationTarget !== null) return this.targetedCycles.run(
      JSON.stringify([scope, options.continuationTarget]), {
        signal: options.signal, current: () => this.inFlightByScope.get(scope),
        execute: () => this.#startCycle(options, scope),
      });
    return this.#startCycle(options, scope);
  }

  #startCycle(options, scope) {
    const running = this.inFlightByScope.get(scope);
    if (running) return running;
    const execution = this.#executeCycle(options);
    const tracked = execution.finally(() => {
      if (this.inFlightByScope.get(scope) === tracked) {
        this.inFlightByScope.delete(scope);
      }
    });
    this.inFlightByScope.set(scope, tracked);
    return tracked;
  }

  async #executeCycle(options) {
    throwIfLoopAborted(options.signal);
    const now = normalizeLoopClock(this.clock);
    const issueRetirementCutoff = new Date(
      Date.parse(now) - this.issueActiveWindowDays * 86_400_000,
    ).toISOString();
    const intake = await this.ledger.intake({ limit: options.intakeLimit });
    throwIfLoopAborted(options.signal);
    await this.#retireInactiveIssueWork(
      intake,
      issueRetirementCutoff,
      now,
      options.signal,
    );
    throwIfLoopAborted(options.signal);
    const recoveryOutcomes = await this.#recoverOldHeadDecisionExhaustion(options) ?? [];
    await this.#recoverUnstartedReviewProposals(options);
    const candidateAt = normalizeLoopClock(this.clock);
    const candidateWindow = await this.#listCandidateWindow(
      options,
      candidateAt,
    );
    const items = candidateWindow.items;
    throwIfLoopAborted(options.signal);
    const scope = options.roleId ?? "*";
    const claimCycleSequence = (this.claimCycleSequences.get(scope) ?? 0) + 1;
    this.claimCycleSequences.set(scope, claimCycleSequence);
    const itemRevisions = new Map(
      items.map((item) => [item.itemId, item.revision]),
    );
    const rootContextDeferralSweep = this.rootContextDeferralSweeps.get(scope) ?? new Map();
    this.rootContextDeferralSweeps.set(scope, rootContextDeferralSweep);
    for (const [itemId, deferral] of rootContextDeferralSweep) {
      if (itemRevisions.get(itemId) !== deferral.revision) rootContextDeferralSweep.delete(itemId);
    }
    const preparationSweep = this.prPreparationSweeps.get(scope) ?? new Map();
    this.prPreparationSweeps.set(scope, preparationSweep);
    for (const [itemId, revision] of preparationSweep) {
      if (itemRevisions.get(itemId) !== revision) preparationSweep.delete(itemId);
    }
    for (const [itemId, deferral] of this.fencedClaimDeferrals) {
      if (
        (
          itemRevisions.has(itemId) &&
          itemRevisions.get(itemId) !== deferral.revision
        ) ||
        (deferral.scope === scope && deferral.retryAfterCycle < claimCycleSequence)
      ) {
        this.fencedClaimDeferrals.delete(itemId);
      }
    }
    const resolutionDeferrals = this.roleResolutionDeferrals;
    for (const [key, deferral] of resolutionDeferrals) {
      if (
        deferral.scope === scope &&
        itemRevisions.get(deferral.itemId) !== deferral.revision
      ) {
        resolutionDeferrals.delete(key);
      }
    }
    const graphBlocked = candidateWindow.graphBlocked;
    const activeQuestions = candidateWindow.activeQuestions;
    const resolutions = new Map();
    const outcomes = intake.error
      ? [{ status: "intake_deferred", code: intake.error.code }]
      : [];
    outcomes.push(...recoveryOutcomes);
    let claimedCount = 0;
    let claimAttempts = 0;
    let workAttempts = 0;
    let availabilityChecks = 0;
    let availabilityBudgetUsed = 0;
    const availabilityCheckLimit = Math.max(
      options.workLimit + 3,
      options.workLimit * 2,
    );
    const claimAttemptLimit = Math.max(availabilityCheckLimit * 8, 32);

    const selectedItems = options.continuationTarget === null ? items : items.filter(item =>
      matchesContinuationTarget(item, options.continuationTarget));
    const prioritized = prioritizeWorkItems(selectedItems, candidateWindow.facts, graphBlocked);
    const scheduled = this.taskRuns ? await this.taskRuns.order(prioritized, 'work-item', 'itemId') : prioritized;
    const blockedRoots = scheduled.filter((item) =>
      item.currentTarget?.type === "role" && item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
      item.graph?.parentItemId === null && graphBlocked.has(item.itemId)
    );
    const blockedRootSweep = this.blockedRootSweeps.get(scope) ?? new Map();
    this.blockedRootSweeps.set(scope, blockedRootSweep);
    let relatedItems;
    let relatedProgress;
    const sweepFingerprint = async (item) => {
      if (relatedItems === undefined) {
        try {
          relatedItems = await this.#listAllItems(options.signal);
          if (new Set(relatedItems.map(({ itemId }) => itemId)).size !== relatedItems.length) relatedItems = null;
        } catch {
          throwIfLoopAborted(options.signal);
          // Missing scheduling evidence must leave the ordinary decision path eligible.
          relatedItems = null;
        }
      }
      if (relatedItems === null) return null;
      relatedProgress ??= indexWorkLedgerGraphProgress(relatedItems);
      return blockedRootSweepFingerprint(item, relatedProgress);
    };
    for (const [itemId, visited] of blockedRootSweep) {
      if (options.continuationTarget !== null && itemId !== options.continuationTarget.itemId) continue;
      const item = blockedRoots.find((candidate) => candidate.itemId === itemId);
      if (!item || item.revision !== visited.revision || await sweepFingerprint(item) !== visited.fingerprint) {
        blockedRootSweep.delete(itemId);
      }
    }
    let completedCandidateSweep = true;
    for (const item of scheduled) {
      throwIfLoopAborted(options.signal);
      if (
        workAttempts >= options.workLimit ||
        availabilityBudgetUsed >= availabilityCheckLimit ||
        claimAttempts >= claimAttemptLimit
      ) {
        completedCandidateSweep = false;
        break;
      }
      // Sweep cursors preserve fairness during discovery. A scheduled retry of
      // this exact input must recheck transient preparation/context failures.
      const rootDeferral = rootContextDeferralSweep.get(item.itemId);
      if (
        options.continuationTarget === null &&
        rootDeferral?.revision === item.revision &&
        Date.parse(rootDeferral.retryAt) > Date.parse(normalizeLoopClock(this.clock))
      ) {
        outcomes.push({ itemId: item.itemId, status: "decision_deferred", code: rootDeferral.code });
        continue;
      }
      if (options.continuationTarget === null && preparationSweep.get(item.itemId) === item.revision) continue;
      if (blockedRootSweep.has(item.itemId) && options.continuationTarget === null) continue;
      const fencedDeferral = this.fencedClaimDeferrals.get(item.itemId);
      if (
        fencedDeferral?.revision === item.revision &&
        fencedDeferral.scope === scope &&
        fencedDeferral.retryAfterCycle >= claimCycleSequence
      ) {
        continue;
      }
      const resolutionDeferralKey = `${scope}:${item.itemId}`;
      const resolutionDeferral = resolutionDeferrals.get(resolutionDeferralKey);
      if (
        resolutionDeferral?.revision === item.revision &&
        Date.parse(resolutionDeferral.retryAt) >
          Date.parse(normalizeLoopClock(this.clock))
      ) {
        outcomes.push({
          itemId: item.itemId,
          status: "resolution_deferred",
          code: resolutionDeferral.code,
        });
        continue;
      }
      if (!isAvailable(item, normalizeLoopClock(this.clock))) continue;
      if (
        options.roleId !== null &&
        options.roleId !== ORCHESTRATOR_ROLE_ID &&
        (item.currentTarget.type !== "role" || item.currentTarget.id !== options.roleId)
      ) continue;
      if (this.automaticReviewPolicy !== null && item.currentTarget?.id === "pr-engineer" &&
          automaticReviewWorkEligibility(item, this.automaticReviewPolicy, normalizeLoopClock(this.clock)) !== null) continue;
      if (
        !issueIsEligible(
          item,
          normalizeLoopClock(this.clock),
          this.issueActiveWindowDays,
        )
      ) {
        continue;
      }
      const key = targetKey(item.currentTarget);
      let resolution;
      try {
        if (!resolutions.has(key)) {
          try {
            resolutions.set(
              key,
              await this.#resolve(item.currentTarget, options.signal),
            );
          } catch (error) {
            throwIfLoopAborted(options.signal);
            resolutions.set(key, { status: "resolution_failed", error });
          }
        }
        resolution = resolutions.get(key);
      } catch {
        outcomes.push({ itemId: item.itemId, status: "resolution_failed" });
        continue;
      }
      if (resolution.status === "resolution_failed") {
        const code = stableFailureCode(resolution.error);
        const previous = resolutionDeferrals.get(resolutionDeferralKey);
        const failures =
          previous?.revision === item.revision ? previous.failures + 1 : 1;
        const backoff = Math.min(
          this.retryBaseMs * 2 ** Math.min(failures - 1, 20),
          this.retryMaxMs,
        );
        resolutionDeferrals.set(resolutionDeferralKey, {
          itemId: item.itemId,
          revision: item.revision,
          scope,
          failures,
          code,
          retryAt: new Date(
            Date.parse(normalizeLoopClock(this.clock)) + backoff,
          ).toISOString(),
        });
        outcomes.push({ itemId: item.itemId, status: "resolution_failed", code });
        continue;
      }
      resolutionDeferrals.delete(resolutionDeferralKey);
      if (options.roleId !== null && resolution.roleId !== options.roleId) {
        continue;
      }
      if (resolution.status === "paused") {
        outcomes.push({ itemId: item.itemId, status: "paused" });
        continue;
      }
      // Preparation can fetch Git objects and inspect conflicts. Resolve the
      // owner first so a scoped orchestrator cycle cannot prepare another role's work.
      if (this.automaticOwnPrRepair !== null) {
        try {
          if (!(await this.automaticOwnPrRepair.shouldRun(item))) continue;
        } catch (error) {
          throwIfLoopAborted(options.signal);
          const code = stableFailureCode(error);
          if (!PR_PREPARATION_DEFERRED_CODES.has(code)) throw error;
          availabilityBudgetUsed += 1;
          preparationSweep.set(item.itemId, item.revision);
          outcomes.push({ itemId: item.itemId, status: "conflict_material_deferred", code });
          continue;
        }
      }
      const isGraphBlocked = graphBlocked.has(item.itemId);
      const configuredRoot = isConfiguredRootItem(item, resolution);
      if (
        (resolution.orchestrator || this.roleContextAssembler === null) &&
        isGraphBlocked
      ) {
        continue;
      }
      if (resolution.orchestrator && activeQuestions.has(key)) {
        outcomes.push({
          itemId: item.itemId,
          status: "missing_target_waiting",
        });
        continue;
      }
      let reservedQuestionTarget = false;
      if (resolution.orchestrator) {
        if (this.inFlightQuestionTargets.has(key)) {
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
        this.inFlightQuestionTargets.add(key);
        reservedQuestionTarget = true;
        let questionAlreadyExists;
        try {
          questionAlreadyExists = activeQuestionTargets(
            await this.#listAllItems(options.signal),
          ).has(key);
          throwIfLoopAborted(options.signal);
        } catch (error) {
          this.inFlightQuestionTargets.delete(key);
          throw error;
        }
        if (questionAlreadyExists) {
          this.inFlightQuestionTargets.delete(key);
          activeQuestions.add(key);
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
      }
      if (
        this.roleContextAssembler !== null &&
        !resolution.orchestrator &&
        !configuredRoot &&
        isGraphBlocked
      ) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "graph_blocked" });
        continue;
      }
      if (this.inFlightItemIds.has(item.itemId)) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "already_in_flight" });
        continue;
      }
      this.inFlightItemIds.add(item.itemId);
      try {
        availabilityChecks += 1;
        availabilityBudgetUsed += 1;
        const availabilityOutcome = await this.#checkAvailability(
          item,
          resolution,
          options.signal,
        );
        if (availabilityOutcome !== null) {
          outcomes.push({ itemId: item.itemId, ...availabilityOutcome });
          continue;
        }
        const processAdmitted = async () => {
          if (
            this.roleContextAssembler !== null &&
            configuredRoot
          ) {
            const fingerprint = isGraphBlocked ? await sweepFingerprint(item) : null;
            const processed = await this.#processConfiguredOrchestrator({
              item,
              worker: resolution,
              options,
              graphBlocked: isGraphBlocked,
            });
            const graphClaimRejected = processed.claimAttempted && !processed.claimed &&
              processed.outcome.status === "claim_not_acquired" && processed.outcome.code === "WORK_LEDGER_GRAPH_BLOCKED";
            if (fingerprint !== null && !processed.claimed &&
                ((!processed.claimAttempted && processed.outcome.status === "graph_blocked") || graphClaimRejected)) {
              blockedRootSweep.set(item.itemId, { revision: item.revision, fingerprint });
            } else {
              blockedRootSweep.delete(item.itemId);
            }
            const rootContextDeferred = isUnclaimedRootContextDeferral(processed);
            if (rootContextDeferred) {
              const previous = rootContextDeferralSweep.get(item.itemId);
              const failures = previous?.revision === item.revision ? previous.failures + 1 : 1;
              const backoff = Math.min(
                this.retryBaseMs * 2 ** Math.min(failures - 1, 20),
                this.retryMaxMs,
              );
              rootContextDeferralSweep.set(item.itemId, {
                revision: item.revision,
                failures,
                code: processed.outcome.code,
                retryAt: new Date(Date.parse(normalizeLoopClock(this.clock)) + backoff).toISOString(),
              });
            } else {
              rootContextDeferralSweep.delete(item.itemId);
            }
            if (configuredResultConsumesWorkBudget(processed)) {
              workAttempts += 1;
            } else if (!rootContextDeferred) {
              availabilityBudgetUsed -= 1;
              if (graphClaimRejected && fingerprint !== null) {
                // The related-progress sweep already defers this exact input;
                // a child/dependency change must be able to invalidate it now.
                this.fencedClaimDeferrals.delete(item.itemId);
              } else {
                this.fencedClaimDeferrals.set(item.itemId, {
                  revision: item.revision,
                  retryAfterCycle: claimCycleSequence + 1,
                  scope,
                });
              }
            }
            if (processed.outcome.status === "orchestration_rejected") {
              this.fencedClaimDeferrals.set(item.itemId, {
                revision: item.revision,
                retryAfterCycle: claimCycleSequence + 1,
                scope,
              });
            } else if (configuredResultConsumesWorkBudget(processed)) {
              this.fencedClaimDeferrals.delete(item.itemId);
            }
            claimAttempts += processed.claimAttempted ? 1 : 0;
            claimedCount += processed.claimed ? 1 : 0;
            outcomes.push({ itemId: item.itemId, ...processed.outcome });
            return;
          }

          claimAttempts += 1;
          const claim = await this.#claim(item, resolution, options);
          if (!claim.item) {
            if (claimFailureConsumesWorkBudget(claim)) {
              workAttempts += 1;
              this.fencedClaimDeferrals.delete(item.itemId);
            } else {
              availabilityBudgetUsed -= 1;
              this.fencedClaimDeferrals.set(item.itemId, {
                revision: item.revision,
                retryAfterCycle: claimCycleSequence + 1,
                scope,
              });
            }
            outcomes.push({ itemId: item.itemId, ...claimFailureOutcome(claim) });
            return;
          }
          this.fencedClaimDeferrals.delete(item.itemId);
          workAttempts += 1;
          claimedCount += 1;
          const outcome = this.roleContextAssembler === null || resolution.orchestrator
            ? await this.#decideAndStage(claim.item, resolution, options)
            : await this.#processSpecialist(claim.item, resolution, options);
          // A host context failure has not made a decision. Keep its durable
          // retry and bounded availability/claim scan, but leave work capacity
          // for another eligible item in this cycle.
          if (outcome.decisionSkipped === true && ["retry_scheduled", "maintenance_required"].includes(outcome.status)) workAttempts -= 1;
          outcomes.push({ itemId: item.itemId, ...outcome });
          if (
            resolution.orchestrator &&
            ["staged", "stage_recovered", "stage_uncertain"].includes(
              outcome.status,
            )
          ) {
            activeQuestions.add(key);
          }
        };
        try {
          if (typeof resolution.withDecisionAdmission === 'function') {
            await resolution.withDecisionAdmission({item:workerItemDto(item),signal:options.signal},processAdmitted);
          } else await processAdmitted();
        } catch (error) {
          throwIfLoopAborted(options.signal);
          const code = stableFailureCode(error);
          if (!['STRUCTURED_PROVIDER_BUSY', 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT'].includes(code)) throw error;
          availabilityBudgetUsed -= 1;
          outcomes.push({itemId:item.itemId,status:'waiting_model',code});
        }
      } finally {
        this.inFlightItemIds.delete(item.itemId);
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
      }
    }

    // Continue a bounded root-context sweep across cycles without moving new or
    // urgent candidates behind old work. A changed revision is never skipped.
    if (completedCandidateSweep && options.continuationTarget === null) {
      this.prPreparationSweeps.delete(scope);
      this.blockedRootSweeps.delete(scope);
    }
    throwIfLoopAborted(options.signal);
    return {
      trigger: options.trigger,
      roleId: options.roleId,
      intake,
      scanned: items.length,
      availabilityChecks,
      workAttempts,
      claimAttempts,
      claimed: claimedCount,
      staged: outcomes.filter(({ status }) => status === "staged").length,
      recoveredStages: outcomes.filter(
        ({ status }) => status === "stage_recovered",
      ).length,
      retried: outcomes.filter(({ status }) => status === "retry_scheduled")
        .length,
      blocked: outcomes.filter(({ status }) => status === "blocked").length,
      orchestrated: outcomes.filter(({ status }) => status === "orchestrated")
        .length,
      submittedDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_submitted",
      ).length,
      recoveredDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_recovered",
      ).length,
      outcomes,
    };
  }

  async #resolve(target, signal) {
    throwIfLoopAborted(signal);
    if (target.type !== "role") return this.#orchestrator(target);
    const candidate = await withinAbortable(
      () => this.roleDirectory.resolve({ ...target }),
      this.resolveTimeoutMs,
      "ROLE_RESOLUTION_TIMEOUT",
      signal,
    );
    throwIfLoopAborted(signal);
    if (candidate === null || candidate === undefined) {
      return this.#orchestrator(target);
    }
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      candidate.roleId !== target.id ||
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.paused !== "boolean" ||
      typeof candidate.decide !== "function"
    ) {
      throw new TypeError("roleDirectory returned an invalid worker");
    }
    const workerId = boundedString(candidate.workerId, "workerId");
    const checkAvailability = optionalPortMethod(
      candidate,
      "checkAvailability",
      "roleDirectory returned an invalid worker",
    );
    const withDecisionAdmission = optionalPortMethod(candidate,'withDecisionAdmission','roleDirectory returned an invalid worker');
    if (!candidate.enabled || candidate.paused) {
      return {
        status: "paused",
        orchestrator: false,
        roleId: candidate.roleId,
        workerId,
      };
    }
    return {
      status: "active",
      orchestrator: false,
      roleId: candidate.roleId,
      workerId,
      decide: candidate.decide.bind(candidate),
      ...(checkAvailability === null ? {} : { checkAvailability }),
      ...(withDecisionAdmission === null ? {} : { withDecisionAdmission }),
    };
  }

  #orchestrator(target) {
    return {
      status: "active",
      orchestrator: true,
      roleId: ORCHESTRATOR_ROLE_ID,
      workerId: ORCHESTRATOR_WORKER_ID,
      decide: async () => orchestratorDecision(target),
    };
  }

  async #checkAvailability(item, worker, signal) {
    if (
      worker.orchestrator ||
      typeof worker.checkAvailability !== "function"
    ) {
      return null;
    }
    try {
      await withinAbortable(
        (availabilitySignal) => worker.checkAvailability({
          item: workerItemDto(item),
          signal: availabilitySignal,
        }),
        this.resolveTimeoutMs,
        "ROLE_RESOLUTION_TIMEOUT",
        signal,
      );
      throwIfLoopAborted(signal);
      return null;
    } catch (error) {
      throwIfLoopAborted(signal);
      const code = stableFailureCode(error);
      if (isWorkItemBrainInfrastructureFailure(code)) {
        return { status: "degraded", code };
      }
      return { status: "resolution_failed", code };
    }
  }

  async #claim(item, worker, options) {
    throwIfLoopAborted(options.signal);
    try {
      const claimed = {
        status: "claimed",
        item: await this.ledger.claim({
          itemId: item.itemId,
          expectedRevision: item.revision,
          workerId: worker.workerId,
          leaseDurationMs: this.leaseDurationMs,
        }),
      };
      throwIfLoopAborted(options.signal);
      return claimed;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        throw error;
      }
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        observed &&
        observed.status === "working" &&
        observed.ownerId === worker.workerId &&
        observed.revision === item.revision + 1 &&
        observed.attempt === item.attempt + 1 &&
        observed.inputDigest === item.inputDigest
      ) {
        return { status: "claim_recovered", item: observed };
      }
      return {
        status: observed ? "claim_not_acquired" : "claim_uncertain",
        code: stableFailureCode(error),
        item: null,
      };
    }
  }

  async #assembleContext(item, worker, options) {
    return withinAbortable(
      (signal) => this.roleContextAssembler.assemble({
        roleId: worker.roleId,
        item,
        trigger: options.trigger,
        signal,
      }),
      this.resolveTimeoutMs,
      "ROLE_CONTEXT_TIMEOUT",
      options.signal,
    );
  }

  async #decide(item, worker, options, context) {
    return normalizeWorkDecision(
      await withinAbortable(
        (signal) => this.#workerDecision(item, worker, options.trigger, context, signal),
        this.decideTimeoutMs,
        "ROLE_DECISION_TIMEOUT",
        options.signal,
      ),
    );
  }

  async #workerDecision(item, worker, trigger, context, signal) {
    const event = currentWorkItemEvent(item);
    const needsFeedback = this.readReviewRepairContext !== null && worker.roleId === "developer" &&
      event?.payload?.relation === "authored" && event.payload.nextAction === "address_review";
    const inputBinding = needsFeedback ? currentWorkItemExecutionBinding(item) : null;
    const feedback = needsFeedback ? await this.readReviewRepairContext({ inputBinding }) : null;
    const repairBudget = context && await this.#readRepairDecisionBudget(item, signal);
    if (repairBudget?.failure) context = { ...context, requirements: { ...context.requirements,
      repairDecisionRecovery: { code: repairBudget.failure.code, attempt: repairBudget.attempt,
        lifetimeClaims: item.attempt, progressReference: repairBudget.progressRef } } };
    throwIfLoopAborted(signal);
    const decide = ({instructions} = {}) => worker.decide({ item: workerItemDto(item), trigger,
      ...(context === undefined ? {} : { context }), signal,
      ...(instructions === undefined ? {} : {instructions}),
      ...(feedback === null ? {} : { reviewRepairFeedback: feedback }),
    });
    const decision = this.taskRuns ? await this.taskRuns.run({kind:'work-item',taskId:item.itemId,
      roleId:worker.roleId, title:event.payload?.title ?? event.subject?.id ?? item.itemId,
      subject:event.subject?.repository ? `${event.subject.repository} #${event.subject.number ?? ''}` : item.itemId,
      revision:item.revision,...(item.leaseId ? {leaseId:item.leaseId} : {})}, decide) : await decide();
    if (needsFeedback) {
      const current = await this.readReviewRepairContext({ inputBinding });
      if (current.reviewFeedbackDigest !== feedback.reviewFeedbackDigest) {
        throw Object.assign(new Error("Review 意见已变化，需要读取最新内容"), { code: "CODE_REVIEW_REPAIR_CONTEXT_STALE" });
      }
    }
    throwIfLoopAborted(signal);
    return decision;
  }

  async #decideWithMemory(item, worker, options, packet) {
    return withinAbortable(
      (signal) => this.#runDecisionPhaseWithMemory(
        item,
        worker,
        options,
        packet,
        signal,
      ),
      this.decisionPhaseTimeoutMs,
      "ROLE_DECISION_TIMEOUT",
      options.signal,
    );
  }

  async #runDecisionPhaseWithMemory(item, worker, options, packet, signal) {
    const decide = async (context) => {
      signal.throwIfAborted();
      const decision = normalizeWorkDecision(
        await withinAbortable(
          (stageSignal) => this.#workerDecision(item, worker, options.trigger, context, stageSignal),
          this.decideTimeoutMs,
          "ROLE_DECISION_TIMEOUT",
          signal,
        ),
      );
      signal.throwIfAborted();
      if (!permitsReviewPublicationSettlementIntent(context, decision.intent)) throw Object.assign(
        new Error("Historical Review settlement cannot create new work or ask for renewed authority"),
        { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
      return decision;
    };
    const first = await decide(packet.context);
    if (first.intent.type !== "query_memory") {
      await this.#verifyDecisionAuthority(item, worker, packet, signal, first.intent);
      return { decision: first, packet };
    }
    if (this.memoryQueryService === null) {
      throw Object.assign(
        new Error("Agent memory query is not configured"),
        { code: "AGENT_MEMORY_QUERY_UNAVAILABLE" },
      );
    }
    await this.#verifyDecisionAuthority(item, worker, packet, signal);
    await withinAbortable(
      (stageSignal) => this.memoryQueryService.execute({
        roleId: worker.roleId,
        workerId: worker.workerId,
        item,
        intent: first.intent,
        signal: stageSignal,
      }),
      this.decideTimeoutMs,
      "AGENT_MEMORY_QUERY_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    const refreshedPacket = await withinAbortable(
      (stageSignal) => this.roleContextAssembler.assemble({
        roleId: worker.roleId,
        item,
        trigger: options.trigger,
        signal: stageSignal,
      }),
      this.resolveTimeoutMs,
      "ROLE_CONTEXT_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    const second = await decide(refreshedPacket.context);
    if (second.intent.type === "query_memory") {
      throw Object.assign(
        new Error("Only one memory query is allowed per work iteration"),
        { code: "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED" },
      );
    }
    await this.#verifyDecisionAuthority(
      item,
      worker,
      refreshedPacket,
      signal,
      second.intent,
    );
    return { decision: second, packet: refreshedPacket };
  }

  async #verifyDecisionAuthority(item, worker, packet, signal, intent = null) {
    const current = await withinAbortable(
      (verificationSignal) =>
        this.#readCurrentDecisionItem(item.itemId, verificationSignal),
      this.resolveTimeoutMs,
      "ROLE_DECISION_INPUT_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
    if (!this.#sameDecisionInput(item, current)) {
      throw Object.assign(
        new Error("Role decision input changed while the provider was running"),
        { code: "ROLE_DECISION_INPUT_STALE" },
      );
    }
    if (intent?.type === "complete" && packet.context.code?.reviewPublicationSettlement !== undefined) {
      const fresh = await withinAbortable(verificationSignal => this.roleContextAssembler.assemble({
        roleId: worker.roleId, item, trigger: packet.context.requirements.trigger, signal: verificationSignal,
      }), this.resolveTimeoutMs, "ROLE_CONTEXT_TIMEOUT", signal);
      if (!isDeepStrictEqual(fresh.context.code?.reviewPublicationSettlement, packet.context.code.reviewPublicationSettlement) ||
          !permitsReviewPublicationSettlementIntent(fresh.context, intent)) throw Object.assign(
        new Error("Historical Review settlement changed before completion"), { code: "ROLE_DECISION_INPUT_STALE" });
    }
    const memoryContext = packet?.context?.memory?.agentQuery;
    if (memoryContext === undefined) return;
    if (this.memoryQueryService === null) {
      throw Object.assign(
        new Error("Memory context cannot be verified"),
        { code: "AGENT_MEMORY_QUERY_UNAVAILABLE" },
      );
    }
    await withinAbortable(
      (verificationSignal) => this.memoryQueryService.verifyContext({
        roleId: worker.roleId,
        item,
        context: memoryContext,
        signal: verificationSignal,
      }),
      this.resolveTimeoutMs,
      "AGENT_MEMORY_QUERY_VERIFICATION_TIMEOUT",
      signal,
    );
    signal.throwIfAborted();
  }

  async #readCurrentDecisionItem(itemId, signal = null) {
    throwIfLoopAborted(signal);
    try {
      const current = this.readItemForReconciliation === null
        ? await this.#findItem(itemId, signal)
        : await this.readItemForReconciliation({ itemId });
      throwIfLoopAborted(signal);
      if (current == null) {
        throw new Error("Role decision work item disappeared");
      }
      return current;
    } catch (cause) {
      throwIfLoopAborted(signal);
      throw Object.assign(
        new Error("Unable to revalidate the role decision input", { cause }),
        { code: "ROLE_DECISION_INPUT_UNAVAILABLE" },
      );
    }
  }

  #sameDecisionInput(expected, current) {
    return (
      current.itemId === expected.itemId &&
      current.revision === expected.revision &&
      current.inputDigest === expected.inputDigest &&
      current.status === expected.status &&
      current.ownerId === expected.ownerId &&
      current.leaseId === expected.leaseId &&
      current.leaseUntil === expected.leaseUntil &&
      current.currentTarget?.type === expected.currentTarget?.type &&
      current.currentTarget?.id === expected.currentTarget?.id
    );
  }

  async #processConfiguredOrchestrator({
    item,
    worker,
    options,
    graphBlocked,
  }) {
    throwIfLoopAborted(options.signal);
    let packet;
    let decision;
    try {
      packet = await this.#assembleContext(item, worker, options);
      if (graphBlocked && hasHealthyPendingRereviewChildren(item, packet.context)) {
        return { claimAttempted: false, claimed: false, decisionSkipped: true,
          outcome: { status: "graph_blocked", workerId: worker.workerId } };
      }
      ({ decision, packet } = await this.#decideWithMemory(
        item,
        worker,
        options,
        packet,
      ));
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (error instanceof TaskRunControlError) return {claimAttempted:false,claimed:false,
        outcome:{status:error.code === 'TASK_RUN_CANCELLED' ? 'cancelled' : error.code === 'TASK_RUN_CONTROL_PENDING' ? 'control_pending' : 'paused',workerId:worker.workerId,code:error.code}};
      const terminalState = terminalPullRequestState(error);
      if (terminalState !== null) {
        const claim = await this.#claim(item, worker, options);
        if (!claim.item) {
          return {
            claimAttempted: true,
            claimed: false,
            outcome: claimFailureOutcome(claim),
          };
        }
        return {
          claimAttempted: true,
          claimed: true,
          outcome: await this.#blockTerminalPullRequest(
            claim.item,
            worker.workerId,
            options,
            terminalState,
          ),
        };
      }
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        throw error;
      }
      if (isStalePullRequestFactContext(error)) {
        return {
          claimAttempted: false,
          claimed: false,
          outcome: {
            status: "decision_deferred",
            workerId: worker.workerId,
            code: "PR_FACTS_STALE",
          },
        };
      }
      const code = stableFailureCode(error);
      if (ROOT_DECISION_DEFERRED_ERROR_CODES.has(code) || isContextContention(error)) {
        return {
          claimAttempted: false,
          claimed: false,
          outcome: {
            status: "decision_deferred",
            workerId: worker.workerId,
            code,
          },
        };
      }
      if (!isWorkItemBrainInfrastructureFailure(code)) throw error;
      const claim = await this.#claim(item, worker, options);
      if (!claim.item) {
        return {
          claimAttempted: true,
          claimed: false,
          outcome: claimFailureOutcome(claim),
        };
      }
      return {
        claimAttempted: true,
        claimed: true,
        outcome: await this.#recordFailure(
          claim.item,
          worker,
          error,
          options,
        ),
      };
    }
    throwIfLoopAborted(options.signal);
    if (decision.intent.type === "orchestrate") {
      throwIfLoopAborted(options.signal);
      let executed;
      try {
        executed = await this.orchestratorService.execute({
          worker: { roleId: worker.roleId, workerId: worker.workerId },
          item,
          contextPacket: packet,
          intent: decision.intent,
        });
      } catch (error) {
        throwIfLoopAborted(options.signal);
        const code = stableFailureCode(error);
        if (isContextContention(error)) {
          return {
            claimAttempted: false,
            claimed: false,
            outcome: { status: "decision_deferred", workerId: worker.workerId, code },
          };
        }
        if (
          !(error instanceof OrchestratorServiceError) ||
          code !== "ORCHESTRATOR_AUTHORITY_DENIED"
        ) {
          throw error;
        }
        return {
          claimAttempted: false,
          claimed: false,
          outcome: {
            status: "orchestration_rejected",
            workerId: worker.workerId,
            code,
          },
        };
      }
      throwIfLoopAborted(options.signal);
      return {
        claimAttempted: false,
        claimed: false,
        outcome: {
          status: "orchestrated",
          workerId: worker.workerId,
          action: decision.intent.action.type,
          applied: executed.applied,
        },
      };
    }
    if (decision.intent.type === "submit_delivery") {
      throw Object.assign(
        new Error("The configured root orchestrator cannot submit a delivery"),
        { code: "ORCHESTRATOR_DELIVERY_NOT_SUPPORTED" },
      );
    }
    if (graphBlocked) {
      return {
        claimAttempted: false,
        claimed: false,
        outcome: { status: "graph_blocked", workerId: worker.workerId },
      };
    }
    const claim = await this.#claim(item, worker, options);
    if (!claim.item) {
      return {
        claimAttempted: true,
        claimed: false,
        outcome: claimFailureOutcome(claim),
      };
    }
    return {
      claimAttempted: true,
      claimed: true,
      outcome: await this.#stageDecision(
        claim.item,
        worker,
        options,
        decision,
      ),
    };
  }

  async #processSpecialist(item, worker, options) {
    throwIfLoopAborted(options.signal);
    let packet;
    let decision;
    let preparingInitialContext = true;
    let failureReasons = DECISION_FAILURE_REASONS;
    try {
      packet = await this.#assembleContext(item, worker, options);
      preparingInitialContext = false;
      ({ decision, packet } = await this.#decideWithMemory(
        item,
        worker,
        options,
        packet,
      ));
      throwIfLoopAborted(options.signal);
      if (decision.intent.type === "submit_delivery") {
        failureReasons = DELIVERY_FAILURE_REASONS;
        throwIfLoopAborted(options.signal);
        const executed = await this.orchestratorService.execute({
          worker: { roleId: worker.roleId, workerId: worker.workerId },
          item,
          contextPacket: packet,
          intent: decision.intent,
        });
        throwIfLoopAborted(options.signal);
        return {
          status: executed.recovered
            ? "delivery_recovered"
            : "delivery_submitted",
          workerId: worker.workerId,
          deliveryRevision: executed.deliveryRevision,
        };
      }
      if (decision.intent.type === "orchestrate") {
        throw Object.assign(
          new Error("A specialist cannot execute an orchestration action"),
          { code: "SPECIALIST_ORCHESTRATION_NOT_PERMITTED" },
        );
      }
    } catch (error) {
      throwIfLoopAborted(options.signal);
      const terminalState = terminalPullRequestState(error);
      if (terminalState !== null) {
        return this.#blockTerminalPullRequest(
          item,
          worker.workerId,
          options,
          terminalState,
        );
      }
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        // Configuration cutover is not an employee failure. Keep the durable
        // claim intact so the item can be recomputed after restart.
        throw error;
      }
      return this.#recordFailure(
        item,
        worker,
        error,
        options,
        failureReasons,
        preparingInitialContext,
      );
    }
    return this.#stageDecision(item, worker, options, decision);
  }

  async #blockTerminalPullRequest(item, actorId, options, terminalState) {
    throwIfLoopAborted(options.signal);
    try {
      await this.ledger.transition({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId,
        toStatus: "blocked",
        reason: "pr_source_terminal",
        details: {
          code: "PR_FACTS_TERMINAL",
          outcome: terminalState,
        },
      });
      throwIfLoopAborted(options.signal);
      return {
        status: "blocked",
        workerId: actorId,
        code: "PR_FACTS_TERMINAL",
      };
    } catch {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        observed?.status === "blocked" &&
        observed.statusReason === "pr_source_terminal"
      ) {
        return {
          status: "blocked",
          workerId: actorId,
          code: "PR_FACTS_TERMINAL",
        };
      }
      return {
        status: observed
          ? "terminal_state_unchanged"
          : "terminal_state_uncertain",
        workerId: actorId,
        code: "PR_FACTS_TERMINAL",
      };
    }
  }

  async #decideAndStage(item, worker, options) {
    throwIfLoopAborted(options.signal);
    let decision;
    try {
      decision = await this.#decide(item, worker, options);
    } catch (error) {
      throwIfLoopAborted(options.signal);
      return this.#recordFailure(item, worker, error, options);
    }

    throwIfLoopAborted(options.signal);
    return this.#stageDecision(item, worker, options, decision);
  }

  async #stageDecision(
    item,
    worker,
    options,
    decision,
    failureReasons = DECISION_FAILURE_REASONS,
  ) {
    throwIfLoopAborted(options.signal);
    try {
      await this.ledger.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: worker.workerId,
        roleId: worker.roleId,
        intent: decision.intent,
      });
      throwIfLoopAborted(options.signal);
      return { status: "staged", workerId: worker.workerId };
    } catch (error) {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (
        ["dispatch_pending", "waiting_user"].includes(observed?.status) &&
        observed.inputDigest === item.inputDigest &&
        (observed.status === "waiting_user" ||
          observed.revision === item.revision + 1)
      ) {
        return { status: "stage_recovered", workerId: worker.workerId };
      }
      if (
        observed?.status === "working" &&
        observed.revision === item.revision &&
        observed.leaseId === item.leaseId
      ) {
        return this.#recordFailure(
          item,
          worker,
          error,
          options,
          failureReasons,
        );
      }
      return {
        status: observed ? "stage_state_changed" : "stage_uncertain",
        workerId: worker.workerId,
      };
    }
  }

  async #readDecisionBudget(item, signal) {
    if (this.listTimeline === null || item.kind !== "source_root" ||
        item.source?.kind !== "pull_request") return null;
    if (!item.source.revisions.some((revision) => revision.disposition === "accepted" &&
      revision.revision <= item.source.activeRevision && revision.headRefOid !== item.source.current.headRefOid)) return null;
    const timeline = [];
    let cursor = null;
    try {
      for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
        throwIfLoopAborted(signal);
        const result = await this.listTimeline({ itemId: item.itemId, order: "newest", limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }) });
        throwIfLoopAborted(signal);
        timeline.push(...result.items);
        const budget = pullRequestDecisionAttemptBudget(item, timeline);
        if (budget !== null || !result.nextCursor) return budget;
        if (result.nextCursor === cursor) return null;
        cursor = result.nextCursor;
      }
    } catch {
      throwIfLoopAborted(signal);
    }
    return null;
  }

  async #readRepairDecisionBudget(item, signal) {
    if (this.readRepairDecisionBudget === null) return null;
    try {
      throwIfLoopAborted(signal);
      const budget = await this.readRepairDecisionBudget({ itemId: item.itemId, expectedRevision: item.revision });
      throwIfLoopAborted(signal);
      return budget;
    } catch (error) {
      throwIfLoopAborted(signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      return null;
    }
  }

  async #recoverUnstartedReviewProposals(options) {
    if (this.automaticReviewPolicy?.enabled !== true || this.roleContextAssembler === null ||
        this.recoverUnstartedReviewProposal === null ||
        (options.roleId !== null && options.roleId !== "pr-engineer")) return;
    // Recovery preparation shares the role's runtime budget with healthy work.
    // Scan one small page per cycle, retaining progress across blocked tasks.
    const readPage = () => this.ledger.listItems({ status: "blocked", roleId: "pr-engineer", limit: Math.min(2, options.workLimit),
      ...(this.reviewRecoveryCursor === null ? {} : { cursor: this.reviewRecoveryCursor }) });
    let result;
    try { result = await readPage(); }
    catch (error) {
      if (this.reviewRecoveryCursor === null || error?.code !== "WORK_LEDGER_CURSOR_INVALID") throw error;
      this.reviewRecoveryCursor = null; result = await readPage();
    }
    this.reviewRecoveryCursor = result.nextCursor ?? null;
    throwIfLoopAborted(options.signal);
    for (const item of result.items.filter(item => item.statusReason === "proposal_stale" &&
        item.decisionContext?.value?.kind === "github_review_proposal")) {
      try {
        if (this.canRecoverUnstartedReviewProposal !== null &&
            !await this.canRecoverUnstartedReviewProposal({ itemId: item.itemId, expectedRevision: item.revision })) continue;
        const binding = currentWorkItemExecutionBinding(item);
        if (binding?.schemaVersion !== 2) continue;
        await this.verifyPullRequestExecutionBinding(binding);
        const packet = await this.#assembleContext(item, { roleId: "pr-engineer" }, options);
        if (!packet?.context?.code?.pullRequest?.reviewMaterial) continue;
        throwIfLoopAborted(options.signal);
        await this.verifyPullRequestExecutionBinding(binding);
        await this.recoverUnstartedReviewProposal({ itemId: item.itemId, expectedRevision: item.revision });
      } catch (error) {
        throwIfLoopAborted(options.signal);
        if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      }
    }
  }

  async #recoverOldHeadDecisionExhaustion(options) {
    if (this.listTimeline === null || this.verifyPullRequestExecutionBinding === null) return;
    const blocked = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(options.signal);
      const result = await this.ledger.listItems({ status: "blocked", limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }) });
      throwIfLoopAborted(options.signal);
      blocked.push(...result.items.filter((item) => item.statusReason === "decision_attempts_exhausted" &&
        (options.roleId === null || item.currentTarget?.id === options.roleId)));
      if (!result.nextCursor) break;
      if (result.nextCursor === cursor) return;
      cursor = result.nextCursor;
    }
    let recovered = 0;
    const outcomes = [];
    for (const item of blocked) {
      if (recovered >= options.workLimit) break;
      const event = currentWorkItemEvent(item);
      if (await this.#recoverNativeResultStringBlock(item, options)) {
        recovered += 1;
        continue;
      }
      if (await this.#recoverRepairDecisionBlock(item, options)) {
        recovered += 1;
        continue;
      }
      if (item.kind === "graph_task" && item.currentTarget?.id === "developer" && event?.payload?.nextAction === "resolve_conflict" &&
          (item.graph?.deliveries ?? []).length === 0 &&
          item.activeIntentId === null && item.ownerId === null && item.leaseId === null && item.leaseUntil === null &&
          item.sourceQuarantine === null && item.decisionContext?.source === "proposal" &&
          item.decisionContext.outcome === "succeeded" && item.decisionContext.value?.kind === "code_action_proposal") {
        const result = await this.#recoverConflictInspectionBlock(item, options);
        if (result === true) recovered += 1;
        else if (result?.code) outcomes.push({ itemId: item.itemId, status: "conflict_material_deferred", code: result.code });
        continue;
      }
      if (isInitialInternalReviewFactBlock(item)) {
        if (await this.#recoverInternalReviewFactBlock(item, options)) recovered += 1;
        continue;
      }
      if (!isPullRequestDecisionBudgetRecoveryCandidate(item)) continue;
      const budget = await this.#readDecisionBudget(item, options.signal);
      if (!canRecoverPullRequestDecisionBudget(item, budget, this.maxAttempts)) continue;
      const binding = currentWorkItemExecutionBinding(item);
      if (binding === null) continue;
      try {
        await this.verifyPullRequestExecutionBinding(binding);
        throwIfLoopAborted(options.signal);
        await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision,
          leaseId: null, actorId: "work-ledger-system", toStatus: "queued",
          reason: "pr_head_decision_budget_recovered",
          details: { evidenceRefs: [`timeline:${budget.activation.timelineId}`] } });
        recovered += 1;
      } catch (error) {
        throwIfLoopAborted(options.signal);
        if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
        // Changed authority or a competing worker must be reconciled from a
        // fresh snapshot on the next cycle, without replaying any action.
      }
    }
    return outcomes;
  }

  async #recoverRepairDecisionBlock(item, options) {
    if (this.automaticOwnPrRepair === null || typeof this.taskRuns?.get !== 'function' ||
        item.status !== 'blocked' || item.statusReason !== 'decision_attempts_exhausted') return false;
    const budget = await this.#readRepairDecisionBudget(item, options.signal);
    if (!budget?.failure?.current || budget.attempt < 1 || budget.attempt >= this.maxAttempts) return false;
    try {
      const run = await this.taskRuns.get('work-item', item.itemId), receipt = run.receipt;
      const times = [budget.failure.claimAt, receipt?.registeredAt, receipt?.modelStartedAt,
        receipt?.finishedAt, budget.failure.at].map(Date.parse);
      if (run.active !== false || run.mode !== 'active' || run.pendingCommand !== null || run.phase !== 'failed' ||
          run.stopUnconfirmed === true || receipt?.kind !== 'work-item' || receipt.taskId !== item.itemId ||
          receipt.roleId !== item.currentTarget.id || receipt.phase !== 'failed' || receipt.taskRevision !== item.revision - 1 ||
          receipt.leaseId !== budget.failure.leaseId || receipt.outcomeCode !== budget.failure.code ||
          !(receipt.stopConfirmed === true || (receipt.session?.transport === 'app-server' && receipt.session.status === 'completed')) ||
          times.some(time => !Number.isFinite(time)) || times.some((time, index) => index > 0 && time < times[index - 1])) return false;
      const binding = currentWorkItemExecutionBinding(item);
      if (binding?.schemaVersion !== 2) return false;
      await this.verifyPullRequestExecutionBinding(binding);
      throwIfLoopAborted(options.signal);
      await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
        actorId: 'work-ledger-system', toStatus: 'queued', reason: 'repair_decision_progress_recovered',
        details: { evidenceRefs: [budget.failure.timelineId, budget.progressRef, `run:${receipt.runId}`] } });
      return true;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      return false;
    }
  }

  async #recoverNativeResultStringBlock(item, options) {
    const event = currentWorkItemEvent(item);
    if (this.automaticOwnPrRepair === null || typeof this.taskRuns?.get !== "function" ||
        item.kind !== "graph_task" || item.currentTarget?.type !== "role" || item.currentTarget.id !== "developer" ||
        event?.payload?.relation !== "authored" || item.activeIntentId !== null || item.sourceQuarantine !== null ||
        item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null ||
        item.decisionContext?.source !== "proposal" || item.decisionContext.outcome !== "succeeded" ||
        item.decisionContext.value?.kind !== "code_action_proposal") return false;
    try {
      const timeline = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
        throwIfLoopAborted(options.signal);
        const result = await this.listTimeline({ itemId: item.itemId, order: "newest", limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }) });
        timeline.push(...result.items);
        if (!result.nextCursor) break;
        if (result.nextCursor === cursor || page === MAX_PAGE_COUNT - 1) return false;
        cursor = result.nextCursor;
      }
      timeline.sort((left, right) => left.sequence - right.sequence);
      const creation = timeline[0], latest = timeline.at(-1), claim = timeline.at(-2);
      if (creation?.type !== "graph_child_created" || creation.at !== item.createdAt ||
          creation.details?.childTaskId !== item.itemId || creation.details.inputDigest !== item.inputDigest ||
          latest?.at !== item.updatedAt || latest.type !== "transitioned" || claim?.type !== "claimed" ||
          claim.details?.attempt !== item.attempt || claim.details?.inputDigest !== item.inputDigest ||
          latest.details?.fromStatus !== "working" || latest.details?.toStatus !== "blocked" ||
          latest.details?.reason !== "decision_attempts_exhausted" ||
          latest.details?.context?.code !== "STRUCTURED_PROVIDER_RESPONSE_INVALID" ||
          timeline.some(entry => entry.details?.reason === "native_result_string_format_retried") ||
          !timeline.some(entry => entry.type === "proposal_result_applied" &&
            entry.details.proposalId === item.decisionContext.referenceId && entry.details.outcome === "succeeded")) return false;
      const run = await this.taskRuns.get("work-item", item.itemId);
      const receipt = run.receipt;
      const times = [claim.at, receipt?.registeredAt, receipt?.modelStartedAt, receipt?.finishedAt, latest.at].map(Date.parse);
      // A completed native turn proves quiescence without confusing its shared
      // app-server process with a stopped per-task process. Owner holds win.
      if (run.active !== false || run.mode !== "active" || run.pendingCommand !== null || run.phase !== "failed" || run.stopUnconfirmed === true ||
          receipt?.kind !== "work-item" || receipt.taskId !== item.itemId || receipt.roleId !== "developer" ||
          receipt.phase !== "failed" || receipt.taskRevision !== item.revision - 1 || receipt.leaseId !== claim.details.leaseId ||
          receipt.outcomeCode !== "STRUCTURED_PROVIDER_RESPONSE_INVALID" || receipt.session?.transport !== "app-server" ||
          receipt.session.status !== "completed" || times.some(time => !Number.isFinite(time)) ||
          times.some((time, index) => index > 0 && time < times[index - 1])) return false;
      const binding = currentWorkItemExecutionBinding(item);
      if (binding?.schemaVersion !== 2) return false;
      await this.verifyPullRequestExecutionBinding(binding);
      throwIfLoopAborted(options.signal);
      // The native string parser now preserves literal line breaks. Permit one
      // fresh normal decision; never replay the failed output or reset attempts.
      await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision,
        leaseId: null, actorId: "work-ledger-system", toStatus: "queued", reason: "native_result_string_format_retried",
        details: { evidenceRefs: [`run:${receipt.runId}`, "native-result-string-parser:1"] } });
      return true;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      return false;
    }
  }

  async #recoverConflictInspectionBlock(item, options) {
    if (this.roleContextAssembler === null) return false;
    const timeline = [];
    let cursor = null;
    try {
      for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
        throwIfLoopAborted(options.signal);
        const result = await this.listTimeline({ itemId: item.itemId, order: "newest", limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }) });
        timeline.push(...result.items);
        if (!result.nextCursor) break;
        if (result.nextCursor === cursor || page === MAX_PAGE_COUNT - 1) return false;
        cursor = result.nextCursor;
      }
      timeline.sort((left, right) => left.sequence - right.sequence);
      const creation = timeline[0];
      const latest = timeline.at(-1);
      if (creation?.type !== "graph_child_created" || creation.at !== item.createdAt ||
          creation.details?.childTaskId !== item.itemId || creation.details.inputDigest !== item.inputDigest ||
          latest?.at !== item.updatedAt || latest.type !== "transitioned" ||
          latest.details?.context?.code !== "ROLE_DECISION_PR_REVIEW_REQUIRED" ||
          latest.details.reason !== "decision_attempts_exhausted" ||
          timeline.some(entry => entry.details?.reason === "conflict_inspection_material_recovered") ||
          !timeline.some(entry => entry.type === "proposal_result_applied" &&
            entry.details.proposalId === item.decisionContext.referenceId && entry.details.outcome === "succeeded")) return false;
      const binding = currentWorkItemExecutionBinding(item);
      if (binding?.schemaVersion !== 2) return false;
      await this.verifyPullRequestExecutionBinding(binding);
      if (typeof this.automaticOwnPrRepair?.conflictRepair?.prepareInspection === "function") {
        await this.automaticOwnPrRepair.conflictRepair.prepareInspection({ itemId: item.itemId,
          itemRevision: item.revision, inputDigest: item.inputDigest });
      }
      const packet = await this.#assembleContext(item, { roleId: "developer" }, options);
      const inspection = packet?.context?.code?.conflictInspection;
      if (!inspection || !samePullRequestExecutionBinding(inspection.inputBinding, binding) ||
          inspection.preparationBinding?.gitTarget?.headRefOid !== binding.headRefOid ||
          inspection.preparationBinding?.gitTarget?.baseRefOid !== binding.gitTarget.baseRefOid ||
          !Array.isArray(inspection.conflicts) || inspection.conflicts.length === 0) {
        return { code: "CONFLICT_INSPECTION_CONTEXT_MISSING" };
      }
      throwIfLoopAborted(options.signal);
      await this.verifyPullRequestExecutionBinding(binding);
      await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision,
        leaseId: null, actorId: "work-ledger-system", toStatus: "queued", reason: "conflict_inspection_material_recovered",
        details: { evidenceRefs: [`conflict-preparation:${inspection.preparationBinding.preparationId}`,
          `proposal:${item.decisionContext.referenceId}`, `head:${binding.headRefOid}`] } });
      return true;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      return { code: stableFailureCode(error) };
    }
  }

  async #recoverInternalReviewFactBlock(item, options) {
    if (this.roleContextAssembler === null) return false;
    const timeline = [];
    let cursor = null;
    try {
      for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
        throwIfLoopAborted(options.signal);
        const result = await this.listTimeline({ itemId: item.itemId, order: "newest", limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }) });
        timeline.push(...result.items);
        if (timeline.length > 1 + item.attempt * 2) return false;
        if (!result.nextCursor) break;
        if (result.nextCursor === cursor || page === MAX_PAGE_COUNT - 1) return false;
        cursor = result.nextCursor;
      }
      if (!completeInternalReviewFactFailureHistory(item, timeline)) return false;
      const binding = currentWorkItemExecutionBinding(item);
      if (binding?.schemaVersion !== 2) return false;
      await this.verifyPullRequestExecutionBinding(binding);
      const packet = await this.#assembleContext(item, { roleId: "pr-engineer" }, options);
      const feedback = packet?.context?.code?.originalRepairFeedback;
      const metadata = currentWorkItemEvent(item).payload.internalReview;
      if (!packet?.context?.code?.pullRequest?.reviewMaterial ||
          feedback?.reviewHeadRefOid !== binding.headRefOid || feedback.feedbackDigest !== metadata.feedbackDigest) return false;
      throwIfLoopAborted(options.signal);
      await this.verifyPullRequestExecutionBinding(binding);
      // Preserve the sealed Head budget and lifetime attempts. This narrow
      // recovery grants one normal claim; its own timeline event prevents a
      // second recovery even when that subsequent model attempt fails.
      await this.ledger.transition({ itemId: item.itemId, expectedRevision: item.revision,
        leaseId: null, actorId: "work-ledger-system", toStatus: "queued", reason: "internal_review_facts_recovered",
        details: { evidenceRefs: [`original-feedback:${feedback.snapshotId}`, `head:${binding.headRefOid}`] } });
      return true;
    } catch (error) {
      throwIfLoopAborted(options.signal);
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) throw error;
      return false;
    }
  }

  async #infrastructureRetryDelay(item, code, signal) {
    let failures = 0;
    if (this.listTimeline !== null) {
      try {
        const page = await withinAbortable(
          () => this.listTimeline({ itemId: item.itemId, order: "newest", limit: PAGE_SIZE }),
          this.resolveTimeoutMs, "ROLE_RETRY_HISTORY_TIMEOUT", signal,
        );
        // Claims sit between retries. Any other event starts a new failure streak.
        // A bounded tail suffices because the delay reaches its configured cap.
        for (const entry of page.items) {
          if (entry.type === "claimed") continue;
          if (entry.type !== "retry_scheduled" || entry.details.reason !== "system_maintenance_auto_retry" ||
              entry.details.code !== code) break;
          failures += 1;
        }
      } catch {
        throwIfLoopAborted(signal);
      }
    }
    return Math.min(Math.max(this.retryMaxMs, 60_000),
      Math.max(this.retryBaseMs, 60_000) * 2 ** Math.min(failures, 20));
  }

  async #recordFailure(
    item,
    worker,
    error,
    options,
    reasons = DECISION_FAILURE_REASONS,
    beforeDecision = false,
  ) {
    throwIfLoopAborted(options.signal);
    const actorId = worker.workerId;
    if (error instanceof TaskRunControlError) return {status:error.code === 'TASK_RUN_CANCELLED' ? 'cancelled' : error.code === 'TASK_RUN_CONTROL_PENDING' ? 'control_pending' : 'paused',workerId:actorId,code:error.code};
    const code = stableFailureCode(error);
    if (requiresBrainMaintenance(code)) {
      const failure = brainFailureOwnerAttention(code) ?? {
        summary: "岗位任务大脑需要维护",
        remediation: "请由维护人员检查并修复；修复前保留会话历史和隔离运行环境，不要删除。重试只会重新排队。",
        retryLabel: "修复后重试",
      };
      const outcome = await this.#stageDecision(item, worker, options, {
        intent: createBrainRecoveryIntent(code, {
          schemaVersion: 1, type: "ask_user",
          summary: `${failure.summary}（${worker.roleId}）`,
          reason: `真实任务不得回退到例行大脑；系统已安全停止（${code}）`,
          question: failure.remediation,
          choices: [{ id: "configured-retry", label: failure.retryLabel,
            description: "修复环境后重新排队；保留原任务权限与输入绑定。" }],
        }),
      });
      return ["staged", "stage_recovered"].includes(outcome.status)
        ? { status: "maintenance_required", workerId: actorId, code, decisionSkipped: true }
        : outcome;
    }
    const contention = isContextContention(error);
    const contextTimeout = beforeDecision && code === "ROLE_CONTEXT_TIMEOUT";
    const unavailablePrFacts = beforeDecision && error instanceof RoleContextAssemblerError &&
      code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" && error.statusCode === 503;
    const infrastructure = isWorkItemBrainInfrastructureFailure(code) || contextTimeout || unavailablePrFacts;
    const restoreAttempt = contention || infrastructure;
    const budget = restoreAttempt ? null : await this.#readRepairDecisionBudget(item, options.signal) ?? persistedPullRequestDecisionAttemptBudget(item);
    const attempt = budget?.attempt ?? item.attempt;
    const input = {
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId,
      reason:
        infrastructure ? "system_maintenance_auto_retry" : contention ? "context_changed" : attempt >= this.maxAttempts
          ? reasons.exhausted
          : reasons.retry,
    };
    const retryOutcome = { status: "retry_scheduled", workerId: actorId, code,
      ...(contextTimeout || unavailablePrFacts ? { decisionSkipped: true } : {}) };
    try {
      throwIfLoopAborted(options.signal);
      if (!restoreAttempt && attempt >= this.maxAttempts) {
        await this.ledger.transition({
          ...input,
          toStatus: "blocked",
          details: { code },
        });
        throwIfLoopAborted(options.signal);
        return { status: "blocked", workerId: actorId, code };
      }
      const exponent = contention ? 0 : Math.min(Math.max(attempt - 1, 0), 30);
      const normalDelay = infrastructure
        ? await this.#infrastructureRetryDelay(item, code, options.signal)
        : Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
      const delay = contextTimeout ? Math.max(60_000, normalDelay) : normalDelay;
      await this.ledger.scheduleRetry({
        ...input,
        ...(restoreAttempt ? { consumeAttempt: false } : {}),
        details: { code },
        availableAt: new Date(
          Date.parse(normalizeLoopClock(this.clock)) + delay,
        ).toISOString(),
      });
      throwIfLoopAborted(options.signal);
      return retryOutcome;
    } catch {
      throwIfLoopAborted(options.signal);
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
        options.signal,
      );
      throwIfLoopAborted(options.signal);
      if (observed?.status === "blocked") {
        return { status: "blocked", workerId: actorId, code };
      }
      if (observed?.status === "retry_wait") {
        return retryOutcome;
      }
      return {
        status: observed ? "failure_state_unchanged" : "failure_uncertain",
        workerId: actorId,
        code,
      };
    }
  }

  async #retireInactiveIssueWork(intake, updatedBefore, now, signal) {
    if (this.retireInactiveIssues === null) return;
    const retirementKey = now.slice(0, 10);
    if (this.lastIssueRetirementKey !== retirementKey) {
      let startedSweep = false;
      if (this.issueRetirementSweep?.key !== retirementKey) {
        startedSweep = true;
        const promise = this.retireInactiveIssues({ updatedBefore })
          .then(() => {
            this.lastIssueRetirementKey = retirementKey;
          })
          .finally(() => {
            if (this.issueRetirementSweep?.promise === promise) {
              this.issueRetirementSweep = null;
            }
          });
        this.issueRetirementSweep = { key: retirementKey, promise };
      }
      await this.issueRetirementSweep.promise;
      throwIfLoopAborted(signal);
      if (startedSweep) return;
    }
    if (intake.itemIds.length === 0) return;
    await this.retireInactiveIssues({
      updatedBefore,
      itemIds: intake.itemIds,
    });
    throwIfLoopAborted(signal);
  }

  async #observeItem(itemId, intakeLimit, signal = null) {
    throwIfLoopAborted(signal);
    try {
      if (this.readItemForReconciliation !== null) {
        const observed = await this.readItemForReconciliation({ itemId });
        throwIfLoopAborted(signal);
        return observed;
      }
      await this.ledger.intake({ limit: Math.min(intakeLimit, 1) });
      throwIfLoopAborted(signal);
      return await this.#findItem(itemId, signal);
    } catch {
      throwIfLoopAborted(signal);
      return null;
    }
  }

  async #findItem(itemId, signal = null) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(signal);
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(signal);
      const found = result.items.find((item) => item.itemId === itemId);
      if (found) return found;
      if (!result.nextCursor) return null;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }

  async #listCandidateWindow(options, at) {
    const roleId = options.roleId !== null &&
        options.roleId !== ORCHESTRATOR_ROLE_ID
      ? options.roleId
      : null;
    if (this.listClaimCandidates === null) {
      const allItems = await this.#listAllItems(options.signal);
      const items = allItems.filter((item) =>
        isAvailable(item, at) &&
        !isParentCoordinationReturn(item) &&
        (
          roleId === null ||
          (
            item.currentTarget.type === "role" &&
            item.currentTarget.id === roleId
          )
        )
      );
      return {
        items,
        graphBlocked: graphBlockedItemIds(allItems),
        activeQuestions: activeQuestionTargets(allItems),
        facts: candidatePriorityFacts(allItems),
      };
    }

    const items = [];
    const facts = new Map();
    const graphBlocked = new Set();
    const activeQuestions = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(options.signal);
      const result = await this.listClaimCandidates({
        at,
        limit: PAGE_SIZE,
        ...(roleId === null ? {} : { roleId }),
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(options.signal);
      if (
        !result ||
        !Array.isArray(result.items) ||
        !Array.isArray(result.facts) ||
        !Array.isArray(result.activeQuestionTargets) ||
        result.facts.length !== result.items.length
      ) {
        throw new TypeError("ledger listClaimCandidates result is invalid");
      }
      items.push(...result.items);
      for (const [index, fact] of result.facts.entries()) {
        if (
          !fact ||
          typeof fact.itemId !== "string" ||
          fact.itemId !== result.items[index]?.itemId ||
          typeof fact.graphBlocked !== "boolean" ||
          !Number.isSafeInteger(fact.submittedChildren) ||
          fact.submittedChildren < 0 ||
          !Number.isSafeInteger(fact.satisfiedChildren) ||
          fact.satisfiedChildren < 0
        ) {
          throw new TypeError("ledger listClaimCandidates result is invalid");
        }
        facts.set(fact.itemId, fact);
        if (fact.graphBlocked) graphBlocked.add(fact.itemId);
      }
      for (const target of result.activeQuestionTargets) {
        activeQuestions.add(targetKey(target));
      }
      if (!result.nextCursor) {
        return { items, graphBlocked, activeQuestions, facts };
      }
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }

  async #listAllItems(signal = null) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      throwIfLoopAborted(signal);
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      throwIfLoopAborted(signal);
      if (!result || !Array.isArray(result.items)) {
        throw new TypeError("ledger listItems result is invalid");
      }
      items.push(...result.items);
      if (!result.nextCursor) return items;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }
}
