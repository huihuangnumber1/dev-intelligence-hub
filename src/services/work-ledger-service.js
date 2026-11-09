import { scheduler } from "node:timers/promises";
import { isAutomaticChildWait } from "./work-graph-wait-marker.js";
import { triageRetirementCandidate, planTriageRetirement } from './work-ledger-triage-retirement.js';
import { isReviewTestingRetirementCandidate, reviewTestingRetirementCandidate, matchesAutomaticReviewTestingHandoff,
  planAutomaticReviewTestingRetirement } from './automatic-review-testing-retirement.js';
import { indexRecordedDecisionFailures } from './work-ledger-decision-failure.js';
import { indexRecordedProposalFailures } from './work-ledger-proposal-failure.js';
import { indexUnstartedCodeDispatchFailures } from './work-ledger-delivery-failure.js';
import { consumeHeadAncestryCredential } from './automatic-head-ancestry-reader.js';
import { headAncestrySourceMatches } from '../domain/head-ancestry-receipt.js';
import { recordedFailureParentIds } from './work-ledger-graph-progress.js';
import { isParentCoordinationReturn, indexParentCoordinationReturns } from './work-ledger-graph-responsibility.js';
import { ciMaterialRecoveryCandidate, ciMaterialRetirement, planCiMaterialRecovery } from "./work-ledger-ci-material-recovery.js";
import { hostContextRecoveryCandidate, planHostContextRecovery, hostContextRetirement, hasPendingHostContextRecovery } from "./work-ledger-host-context-recovery.js";
import { automaticRoleHandoffCandidate } from "./work-ledger-role-handoff.js";
import { currentPrRoleHandoffProof } from './work-ledger-role-handoff-evidence.js';
import { completedRepairEvidenceRecoveryProof, repairDecisionAttemptBudget } from "./work-ledger-inspection-continuation.js";
import { automaticReviewWorkAdmission, automaticReviewContinuationEligibility } from "../domain/automatic-review-policy.js";
import { inactivePullRequestTakeoverRecoveryProof, sameHeadInternalReviewTakeoverRecoveryProof } from "./work-ledger-pr-retirement-recovery.js";
import { createWorkIntentDispatchBinding } from "../domain/work-intent-dispatch-binding.js";
import { planWorkItemRunControl } from './work-ledger-run-control.js';
import {
  createRevokedCodeConfirmationSettlement,
  completedCodeConfirmationForSettlement,
  createCompletedCodeConfirmationSettlement,
  isChangedCodeConfirmationDecision,
  codeConfirmationSettlementId,
  unstartedCodeConfirmationForSettlement,
  createUnstartedCodeConfirmationSettlement,
} from "./work-ledger-code-confirmation-settlement.js";
import { isChangedReviewConfirmationDecision, reviewConfirmationSettlementIds,
  createCompletedReviewConfirmationSettlement, hasReviewConfirmationSettlement } from "./work-ledger-review-confirmation-settlement.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import { samePullRequestGitTarget, normalizePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import {
  isTrustedPullRequestScopeLifecycleAssignment,
} from "../domain/pull-request-scope-lifecycle.js";
import {
  planWorkItemClaim,
  planWorkItemCompletion,
  planWorkItemHandoff,
  planWorkItemRetry,
  planWorkItemTransition,
} from "./work-ledger-item-commands.js";
import {
  attentionResultInputBinding,
  planAttentionBatchApplication,
  planSystemMaintenanceRetry,
  systemMaintenanceRetirement,
} from "./work-ledger-attention-commands.js";
import { planProposalBatchApplication } from "./work-ledger-proposal-commands.js";
import { planConditionWake } from "./work-ledger-condition-commands.js";
import {
  planWorkGraphCancellation,
  planWorkGraphChildCreation,
} from "./work-ledger-graph-commands.js";
import {
  planScopedWorkGraphCancellation,
  planWorkGraphReviewReplacement,
  planWorkGraphEscalation,
  planWorkGraphTaskPause,
  planWorkGraphTaskReassignment,
  planWorkGraphTaskResume,
} from "./work-ledger-orchestration-commands.js";
import {
  planWorkGraphAcceptanceRevision,
  planWorkGraphDeliveryDecision,
  planWorkGraphDeliverySubmission,
} from "./work-ledger-delivery-commands.js";
import {
  acknowledgeWorkGraphMemoryProjectionBatch,
  readWorkGraphMemoryProjectionBatch,
} from "./work-ledger-graph-memory.js";
import {
  planIntentAcknowledgement,
  planIntentBinding,
  planIntentClaim,
  planIntentStage,
} from "./work-ledger-outbox-commands.js";
import {
  createIssueSettlementIndex,
  indexIssueSettlementItem,
  issueAssignmentTargetKey,
  issueSubjectIdentityKey,
  isIssueScopeLifecycleEvent,
  isSameIssueSubject,
  planInactiveIssueRetirement,
  planRecoveredIssueScopeSettlement,
  settleIssueScope,
  settleSupersededIssueAssignments,
} from "./work-ledger-issue-lifecycle.js";
import {
  appendWorkLedgerTimeline,
  createAssignmentWorkItem,
  createGapAlertWorkItem,
  createPullRequestSourceRootWorkItem,
  findAssignmentBatchGap,
  MAX_WORK_LEDGER_INTAKE_BATCH,
  MAX_WORK_LEDGER_QUERY_PAGE,
  normalizeAssignmentBatch,
  normalizeReportedAssignmentGap,
  WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
} from "./work-ledger-records.js";
import {
  activatePendingPullRequestWorkSource,
  applyPullRequestScopeLifecycle,
  appendPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  currentWorkItemExecutionBinding,
  pendingInternalReviewMatchesDiscovery,
  pullRequestHeadAdmission,
  pullRequestScopeLifecycleMatchesSource,
  pullRequestScopeLifecycleTargetRole,
  pullRequestWorkDescriptor,
  pullRequestTrustedPredecessor,
  verifyPullRequestExecutionBinding as verifyPullRequestExecutionAuthority,
} from "./work-ledger-pr-source.js";
import {
  appendPullRequestCutoverTimelineEvent,
  arePullRequestCutoverProofsRetained,
  applyReadyPullRequestSourceCutover,
  createPullRequestCutoverTimelineIndex,
  CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  PR_SOURCE_AUTHORITY_FENCED_REASON,
  crossRootPullRequestCutoverCandidate,
  crossRootPullRequestCutoverActivation,
  crossRootPullRequestCutoverBlockerReason,
  crossRootPullRequestCutoverPendingId,
  crossRootPullRequestCutoverPendingReason,
  crossRootPullRequestCutoverPredecessorId,
  inspectPullRequestSourceCutover,
  normalizePullRequestSourceReconciliationCommand,
  planPullRequestSourceReconciliation,
  retireCrossRootPullRequestPredecessor,
} from "./work-ledger-pr-cutover-commands.js";
import {
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
  normalizeWorkLedgerPersistedState,
  retainWorkLedgerTimelineForCapacity,
  WORK_LEDGER_STATE_KEY,
  workLedgerPersistedStateDigest,
} from "./work-ledger-state.js";
import { MAX_WORKFLOW_RECORDS } from "./workflow-routing-state.js";
import {
  boundedLedgerString,
  ledgerDigest,
  cloneLedgerValue,
  hasExactLedgerKeys,
  isPlainLedgerObject,
  normalizeLedgerTimestamp,
  validatePositiveLimit,
  workLedgerError,
  WORK_LEDGER_OUTBOX_STATUSES,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";
import { projectWorkLedgerGraphView } from "./work-ledger-graph.js";
import { indexWorkLedgerGraphProgress } from "./work-ledger-graph-progress.js";
import { createLocalWorkLedgerCandidateProcessor } from
  "./work-ledger-candidate-processor.js";

const SHA256 = /^[a-f0-9]{64}$/;
const DIRECT_NEW_WORK_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

const DEFAULT_POST_COMMIT_YIELD = () => scheduler.yield();

const CLAIM_DEPENDENCY_SATISFIED_STATUSES = new Set([
  "completed",
  "superseded",
]);
const CLAIM_CHILD_SETTLED_STATUSES = new Set([
  ...CLAIM_DEPENDENCY_SATISFIED_STATUSES,
  "cancelled",
]);
const ACTIVE_QUESTION_STATUSES = new Set(["dispatch_pending", "waiting_user"]);

const MAX_PR_EXECUTION_BINDING_VERIFICATION_BATCH = 100_000;

const PR_SOURCE_REQUEUE_STATUSES = new Set([
  "blocked",
  "working",
  "retry_wait",
  "completed",
]);
const CROSS_ROOT_REPLACED_REASON =
  "pr_source_cross_root_cutover_replaced";
const PR_SOURCE_AUTHORITY_FENCE_DISPOSITIONS = new Set([
  "ignored_authority_fence",
  "ignored_legacy_downgrade",
  "ignored_unproven_head",
]);
const PR_SOURCE_AUTHORITY_FENCE_SAFE_STATUSES = new Set([
  "queued",
  "retry_wait",
]);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function assertLedgerRevisionProgress(durable, baseline) {
  if (durable === baseline) return;
  if (durable.revision < baseline.revision ||
      (durable.revision === baseline.revision &&
        workLedgerPersistedStateDigest(durable) !== workLedgerPersistedStateDigest(baseline))) {
    throw workLedgerError("WORK_LEDGER_STATE_REVISION_CONFLICT", "员工工作台账持久状态发生回退或分叉", 409);
  }
}

function isContentVersion(value) {
  return (
    isPlainLedgerObject(value) &&
    Reflect.ownKeys(value).length === 0 &&
    Object.isFrozen(value)
  );
}

function normalizeVersionedRead(result, expectedVersion) {
  const expectedKeys = result?.changed === true
    ? ["changed", "version", "value"]
    : ["changed", "version"];
  if (
    !hasExactLedgerKeys(result, expectedKeys) ||
    !isContentVersion(result.version) ||
    (result.changed !== true && result.changed !== false) ||
    (result.changed === false && result.version !== expectedVersion)
  ) {
    throw new TypeError("StateStore versioned read result is invalid");
  }
  return result;
}

function canRequeueAdvancedPullRequestRoot(root, nextSource) {
  if (nextSource.scope.active !== true) return false;
  const sameHead =
    root.source?.current?.headRefOid === nextSource?.current?.headRefOid;
  if (
    sameHead &&
    root.status === "blocked" &&
    root.statusReason === "proposal_rejected"
  ) {
    return false;
  }
  if (isAutomaticChildWait(root) && root.currentTarget?.id === "orchestrator" &&
      root.source?.scope.kind === "owner_requested" && nextSource.scope.kind === "owner_requested" &&
      (!sameHead || root.source.current.event.payload.gitTarget?.baseRefOid !==
        nextSource.current.event.payload.gitTarget?.baseRefOid)) return true;
  return PR_SOURCE_REQUEUE_STATUSES.has(root.status) ||
    (root.kind === "source_root" &&
      root.source?.kind === "pull_request" &&
      root.status === "superseded" &&
      root.statusReason === CROSS_ROOT_REPLACED_REASON);
}

function isIgnoredProtectedPullRequestReentry(root, envelope, observed) {
  return ["completed", "superseded", "paused"].includes(root.status) &&
    root.source.scope.active === false && envelope.event.eventType === "pull_request.created" &&
    observed.disposition.startsWith("ignored_") && observed.authorityChanged !== true &&
    observed.source.scope.active === false &&
    observed.source.authorityEpoch === root.source.authorityEpoch &&
    observed.source.activeRevision === root.source.activeRevision;
}

function fencedPullRequestRootPatch(root, disposition) {
  if (
    !PR_SOURCE_AUTHORITY_FENCE_DISPOSITIONS.has(disposition) ||
    !PR_SOURCE_AUTHORITY_FENCE_SAFE_STATUSES.has(root.status)
  ) {
    return {};
  }
  return {
    status: "blocked",
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    availableAt: null,
    statusReason: PR_SOURCE_AUTHORITY_FENCED_REASON,
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

function hasNewerIssueAssignment(items, item) {
  const event = currentWorkItemEvent(item);
  return items.some((candidate) =>
    candidate.sourceSequence > item.sourceSequence &&
    candidate.currentTarget?.type === item.currentTarget?.type &&
    candidate.currentTarget?.id === item.currentTarget?.id &&
    isSameIssueSubject(currentWorkItemEvent(candidate), event)
  );
}

function pullRequestRootsForLifecycle(itemsById, envelope) {
  const descriptor = pullRequestWorkDescriptor(envelope);
  if (descriptor === null || !descriptor.trustedLifecycle) return [];
  return [...itemsById.values()].filter((item) =>
    item.kind === "source_root" &&
    item.status !== "paused" &&
    pullRequestScopeLifecycleMatchesSource(item.source, envelope)
  );
}

function operationalPullRequestPredecessor(itemsById, root, authority, event) {
  // History from a source that left scope cannot take over live work.
  if (root.source.scope.active !== true) return null;
  const canonicalItemId = authority?.canonicalRootItemId ??
    authority?.lastTrustedRootItemId ?? null;
  if (canonicalItemId === null || canonicalItemId === root.itemId) return null;
  let candidate = itemsById.get(canonicalItemId) ?? null;
  if (
    candidate?.kind !== "source_root" ||
    !samePullRequestSubject(candidate, root)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      "跨来源 PR cutover 当前来源绑定无效",
      409,
    );
  }
  const pendingPredecessorItemId =
    crossRootPullRequestCutoverPredecessorId(candidate);
  if (pendingPredecessorItemId !== null) {
    candidate = itemsById.get(pendingPredecessorItemId) ?? null;
  }
  if (candidate?.itemId === root.itemId) return null;
  if (root.source.scope.kind === "automatic" && pendingInternalReviewMatchesDiscovery(candidate, event)) return null;
  if (
    candidate?.kind !== "source_root" ||
    !samePullRequestSubject(candidate, root)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
      "跨来源 PR cutover 前驱绑定无效",
      409,
    );
  }
  return candidate;
}

function ownsHeadAncestryPredecessor(state, root) {
  const predecessor = pullRequestTrustedPredecessor(state, root);
  return predecessor !== null && predecessor.headRefOid === root.source.current.headRefOid &&
    predecessor.sourceRootItemId === root.itemId &&
    (predecessor.canonicalRootItemId === null || predecessor.canonicalRootItemId === root.itemId) &&
    (predecessor.lastTrustedRootItemId === null || predecessor.lastTrustedRootItemId === root.itemId);
}

function newWorkAdmissionRun(value) {
  const gate = value === undefined ? DIRECT_NEW_WORK_ADMISSION : value;
  if (!gate || typeof gate.run !== "function") {
    throw new TypeError("actionAdmissionGate must provide run(operation)");
  }
  return gate.run.bind(gate);
}

function queryPage(records, idName, options = {}, allowedStatuses = null) {
  if (!isPlainLedgerObject(options)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const allowedKeys = new Set(["cursor", "limit", "status", "order"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const boundary = queryPageBoundary(options);
  if (
    options.status !== undefined &&
    (!allowedStatuses || !allowedStatuses.has(options.status))
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "状态过滤无效");
  }
  if (
    options.order !== undefined &&
    !new Set(["oldest", "newest"]).has(options.order)
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "排序方式无效");
  }
  const filtered = records.filter(
    (record) =>
      options.status === undefined || record.status === options.status,
  );
  if (options.order === "newest") filtered.reverse();
  const start = queryPageStart(filtered, idName, boundary.cursor);
  const items = filtered.slice(start, start + boundary.limit).map(cloneLedgerValue);
  return {
    items,
    nextCursor:
      start + items.length < filtered.length && items.length
        ? items.at(-1)[idName]
        : null,
  };
}

function queryPageBoundary(options) {
  const requestedLimit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "查询条数无效");
  }
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw workLedgerError("WORK_LEDGER_CURSOR_INVALID", "工作台账游标无效");
  }
  return {
    cursor: options.cursor ?? null,
    limit: Math.min(requestedLimit, MAX_WORK_LEDGER_QUERY_PAGE),
  };
}

function queryPageStart(records, idName, cursor) {
  let start = 0;
  if (cursor) {
    const cursorIndex = records.findIndex(
      (record) => record[idName] === cursor,
    );
    if (cursorIndex < 0) {
      throw workLedgerError(
        "WORK_LEDGER_CURSOR_INVALID",
        "工作台账游标已失效",
      );
    }
    start = cursorIndex + 1;
  }
  return start;
}

function queryWorkItemPage(records, options = {}) {
  if (!isPlainLedgerObject(options)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const allowedKeys = new Set(["cursor", "limit", "status", "order", "roleId"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const { roleId, ...pageOptions } = options;
  if (
    roleId !== undefined &&
    (
      typeof roleId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(roleId)
    )
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "岗位过滤无效");
  }
  const selected = roleId === undefined
    ? records
    : records.filter(
      (record) =>
        record.currentTarget?.type === "role" &&
        record.currentTarget.id === roleId,
    );
  return queryPage(selected, "itemId", pageOptions, WORK_LEDGER_STATUSES);
}

function isClaimCandidateAt(item, at) {
  if (item.status === "queued") return true;
  if (item.status === "retry_wait") {
    return Date.parse(item.availableAt) <= Date.parse(at);
  }
  return item.status === "working" &&
    typeof item.leaseUntil === "string" &&
    Date.parse(item.leaseUntil) <= Date.parse(at);
}

function queryClaimCandidatePage(records, options = {}) {
  if (!isPlainLedgerObject(options)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账候选查询无效");
  }
  const allowedKeys = new Set(["at", "cursor", "limit", "roleId"]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账候选查询无效");
  }
  let at;
  try {
    at = normalizeLedgerTimestamp(options.at, "at");
  } catch {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "候选查询时间无效");
  }
  const roleId = options.roleId;
  if (
    roleId !== undefined &&
    (
      typeof roleId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(roleId)
    )
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "岗位过滤无效");
  }
  const boundary = queryPageBoundary(options);
  const start = queryPageStart(records, "itemId", boundary.cursor);
  const selected = records.slice(start).filter((item) =>
    isClaimCandidateAt(item, at) &&
    !isParentCoordinationReturn(item) &&
    (
      roleId === undefined ||
      (
        item.currentTarget?.type === "role" &&
        item.currentTarget.id === roleId
      )
    )
  );
  const pageItems = selected.slice(0, boundary.limit).map(cloneLedgerValue);
  const page = {
    items: pageItems,
    nextCursor:
      selected.length > pageItems.length && pageItems.length > 0
        ? pageItems.at(-1).itemId
        : null,
  };
  const { byId, childrenByParent, graphProgressDigest } = indexWorkLedgerGraphProgress(records);
  const facts = page.items.map((item) => {
    const children = childrenByParent.get(item.itemId) ?? [];
    const dependencies = item.graph?.dependsOnItemIds ?? [];
    const progress = graphProgressDigest(item);
    return {
      itemId: item.itemId,
      ...(progress === null ? {} : { graphProgressDigest: progress }),
      graphBlocked:
        dependencies.some((dependencyId) =>
          !CLAIM_DEPENDENCY_SATISFIED_STATUSES.has(byId.get(dependencyId)?.status)
        ) ||
        children.some((child) =>
          !CLAIM_CHILD_SETTLED_STATUSES.has(child.status)
        ),
      submittedChildren: children.filter((child) =>
        child.graph?.deliveries?.at(-1)?.status === "submitted"
      ).length,
      satisfiedChildren: children.filter((child) =>
        CLAIM_CHILD_SETTLED_STATUSES.has(child.status)
      ).length,
    };
  });
  const activeQuestionTargets = [];
  const seenQuestionTargets = new Set();
  for (const item of records) {
    if (!ACTIVE_QUESTION_STATUSES.has(item.status)) continue;
    const target = item.currentTarget;
    const key = `${target.type}:${target.id}`;
    if (seenQuestionTargets.has(key)) continue;
    seenQuestionTargets.add(key);
    activeQuestionTargets.push(cloneLedgerValue(target));
  }
  return {
    ...page,
    facts,
    activeQuestionTargets,
  };
}

const ROLE_WORKLOAD_STATUS = new Map([
  ["working", { group: "working", priority: 0 }],
  ["dispatch_pending", { group: "working", priority: 0 }],
  ["waiting_user", { group: "waiting", priority: 1 }],
  ["waiting_condition", { group: "waiting", priority: 1 }],
  ["waiting_external", { group: "waiting", priority: 1 }],
  ["retry_wait", { group: "waiting", priority: 1 }],
  ["queued", { group: "queued", priority: 2 }],
  ["blocked", { group: "blocked", priority: 3 }],
]);

function workloadTitle(item) {
  const assignmentTitle = item.assignment?.work?.title;
  if (typeof assignmentTitle === "string" && assignmentTitle.trim()) {
    return assignmentTitle;
  }
  const event = currentWorkItemEvent(item);
  const eventTitle = event?.payload?.title;
  if (typeof eventTitle === "string" && eventTitle.trim()) return eventTitle;
  const subject = event?.subject;
  if (typeof subject?.repository === "string" && Number.isSafeInteger(subject.number)) {
    return `${subject.repository} #${subject.number}`;
  }
  return item.assignmentId || item.itemId;
}

function workloadSubject(item) {
  const event = currentWorkItemEvent(item);
  const subject = event?.subject;
  const repository = subject?.repository;
  const number = subject?.number;
  if (
    typeof repository !== "string" ||
    !repository ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return null;
  }
  const eventType = event?.eventType;
  const kind = typeof eventType === "string" && eventType.startsWith("pull_request.")
    ? "pull_request"
    : typeof eventType === "string" && eventType.startsWith("issue.")
      ? "issue"
      : item.source?.kind === "pull_request"
        ? "pull_request"
        : item.source?.kind === "issue"
          ? "issue"
          : null;
  return kind ? { kind, repository, number } : null;
}

function compareRoleWorkloadItems(left, right) {
  const priority = (ROLE_WORKLOAD_STATUS.get(left.status)?.priority ?? 99) -
    (ROLE_WORKLOAD_STATUS.get(right.status)?.priority ?? 99);
  if (priority !== 0) return priority;
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return updated || right.order - left.order;
}

function retainRecentRoleTask(tasks, task) {
  tasks.push(task);
  tasks.sort(compareRoleWorkloadItems);
  if (tasks.length > 3) tasks.pop();
}

export class WorkLedgerService {
  constructor({
    store,
    assignmentSource,
    exclusiveLease,
    operationQueue,
    actionAdmissionGate,
    clock = () => new Date(),
    idFactory,
    limits,
    postCommitYield = DEFAULT_POST_COMMIT_YIELD,
    candidateProcessor = createLocalWorkLedgerCandidateProcessor(),
    confirmationSettlementReader = null,
    obsoleteCodeJobSettler = null,
    hostContextRecoveryReader = null,
    reviewTestingRetirementReader = null,
  } = {}) {
    if (
      !store ||
      typeof store.read !== "function" ||
      typeof store.write !== "function"
    ) {
      throw new TypeError("WorkLedgerService requires a durable store");
    }
    if (
      !assignmentSource ||
      typeof assignmentSource.readAssignmentBatch !== "function"
    ) {
      throw new TypeError(
        "assignmentSource must provide readAssignmentBatch({ afterSequence, limit })",
      );
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("WorkLedgerService requires an exclusiveLease");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof idFactory !== "function") {
      throw new TypeError("idFactory must be a function");
    }
    if (typeof postCommitYield !== "function") {
      throw new TypeError("postCommitYield must be a function");
    }
    if (confirmationSettlementReader !== null &&
      typeof confirmationSettlementReader?.read !== "function") {
      throw new TypeError("confirmationSettlementReader must provide read");
    }
    if (obsoleteCodeJobSettler !== null && typeof obsoleteCodeJobSettler?.settle !== "function") {
      throw new TypeError("obsoleteCodeJobSettler must provide settle");
    }
    if (hostContextRecoveryReader !== null && typeof hostContextRecoveryReader?.read !== "function") {
      throw new TypeError("hostContextRecoveryReader must provide read");
    }
    if (
      !candidateProcessor ||
      typeof candidateProcessor.prepare !== "function" ||
      typeof candidateProcessor.commit !== "function" ||
      typeof candidateProcessor.discard !== "function"
    ) {
      throw new TypeError(
        "candidateProcessor must provide prepare, commit, and discard",
      );
    }
    this.store = store;
    this.assignmentSource = assignmentSource;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue || new OperationQueue();
    this.runNewWorkAdmission = newWorkAdmissionRun(actionAdmissionGate);
    this.clock = clock;
    this.idFactory = idFactory;
    this.postCommitYield = postCommitYield;
    this.candidateProcessor = candidateProcessor;
    this.confirmationSettlementReader = confirmationSettlementReader;
    this.obsoleteCodeJobSettler = obsoleteCodeJobSettler;
    this.hostContextRecoveryReader = hostContextRecoveryReader;
    if (reviewTestingRetirementReader !== null && typeof reviewTestingRetirementReader?.read !== 'function') {
      throw new TypeError('reviewTestingRetirementReader must provide read');
    }
    this.reviewTestingRetirementReader = reviewTestingRetirementReader;
    this.reviewTestingRetirementCursor = 0;
    this.limits = normalizeWorkLedgerLimits(limits);
    this.state = emptyWorkLedgerState();
    this.durableContentVersion = undefined;
    this.committedAuthoritySnapshot = null;
    this.graphSnapshotCache = null;
    this.roleWorkloadCache = null;
    this.ready = false;
    this.recoveryPromise = null;
    this.pullRequestScopeRecoveryPending = true;
  }

  async recover() {
    if (this.ready) return this.getSummary();
    this.recoveryPromise ||= this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
          await this.#reconcileRecoveredPullRequestScopes();
          await this.#recoverInactivePullRequestTakeovers();
          await this.#recoverCompletedRepairEvidence();
          await this.#reconcileRecoveredPullRequestAuthorityFences();
          await this.#reconcileRecoveredIssueScopes();
          this.ready = true;
          return this.getSummary();
        } catch (error) {
          this.ready = false;
          if (error?.code === "WORK_LEDGER_STATE_CORRUPTED") throw error;
          throw workLedgerError(
            "WORK_LEDGER_STATE_CORRUPTED",
            "无法恢复员工工作台账",
            503,
            { cause: error },
          );
        }
      }),
    );
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async getSummary() {
    this.#assertReady();
    const itemCounts = Object.fromEntries(
      [...WORK_LEDGER_STATUSES].map((status) => [status, 0]),
    );
    for (const item of this.state.items) itemCounts[item.status] += 1;
    const outboxCounts = { pending: 0, dispatching: 0, delivered: 0, failed: 0 };
    for (const entry of this.state.outbox) outboxCounts[entry.status] += 1;
    return cloneLedgerValue({
      revision: this.state.revision,
      intakeCursor: this.state.intakeCursor,
      sourceHighWatermark: this.state.sourceHighWatermark,
      attentionCursor: this.state.attentionCursor,
      attentionHighWatermark: this.state.attentionHighWatermark,
      proposalCursor: this.state.proposalCursor,
      proposalHighWatermark: this.state.proposalHighWatermark,
      timelineStartSequence: this.state.timelineStartSequence,
      nextTimelineSequence: this.state.nextTimelineSequence,
      itemCounts,
      outboxCounts,
      graphMemoryProjection: {
        cursor: this.state.graphMemoryProjection.cursor,
        highWatermark: this.state.graphMemoryProjection.nextSequence - 1,
        pending: this.state.graphMemoryProjection.pending.length,
      },
      outboxDeliverySemantics: WORK_LEDGER_OUTBOX_DELIVERY_SEMANTICS,
    });
  }

  async getRoleWorkloads() {
    this.#assertReady();
    if (this.roleWorkloadCache?.revision === this.state.revision) {
      return cloneLedgerValue(this.roleWorkloadCache.value);
    }
    const roles = new Map();
    for (const [order, item] of this.state.items.entries()) {
      if (item.currentTarget?.type !== "role") continue;
      const roleId = item.currentTarget.id;
      const workload = roles.get(roleId) ?? {
        roleId,
        counts: { queued: 0, working: 0, waiting: 0, blocked: 0 },
        tasks: [],
      };
      const status = ROLE_WORKLOAD_STATUS.get(item.status);
      if (status) {
        workload.counts[status.group] += 1;
        retainRecentRoleTask(workload.tasks, {
          itemId: item.itemId,
          status: item.status,
          statusReason: item.statusReason,
          title: workloadTitle(item),
          updatedAt: item.updatedAt,
          subject: workloadSubject(item),
          order,
        });
      }
      roles.set(roleId, workload);
    }
    const items = [...roles.values()]
      .sort((left, right) => left.roleId.localeCompare(right.roleId))
      .map((workload) => ({
        ...workload,
        tasks: workload.tasks
          .map(({ order: _order, ...task }) => task),
      }));
    const value = { items };
    this.roleWorkloadCache = { revision: this.state.revision, value };
    return cloneLedgerValue(value);
  }

  async listItems(options = {}) {
    this.#assertReady();
    return queryWorkItemPage(this.state.items, options);
  }

  async readAutomaticRoleHandoffCandidates({ events, afterSubjectId = null }) {
    this.#assertReady();
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      this.state = await this.#readDurableState();
      const candidates = events.map(event => {
        const candidate = automaticRoleHandoffCandidate(this.state, event);
        return candidate === null ? null : { ...candidate, event };
      }).filter(Boolean).sort((a, b) => a.event.subject.id.localeCompare(b.event.subject.id, "en"));
      const after = afterSubjectId === null ? 0 : candidates.findIndex(candidate => candidate.event.subject.id.localeCompare(afterSubjectId, "en") > 0);
      const start = after < 0 ? 0 : after;
      return cloneLedgerValue([...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 10));
    }));
  }

  async canReconnectOwnPullRequest({ itemId, expectedRevision, event }) {
    this.#assertReady();
    event = normalizeStoredWorkflowEvent(event);
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      this.state = await this.#readDurableState();
      const previous = this.state.items.find(item => item.itemId === itemId);
      if (!previous || previous.revision !== expectedRevision || previous.kind !== "source_root" ||
          previous.source?.kind !== "pull_request" || previous.source.scope.kind !== "automatic" ||
          previous.source.scope.active !== false || previous.source.pendingRevision !== null ||
          previous.status !== "blocked" || previous.statusReason !== "pr_source_left_scope" ||
          previous.sourceQuarantine !== null || previous.activeIntentId !== null ||
          previous.ownerId !== null || previous.leaseId !== null || previous.leaseUntil !== null ||
          previous.source.identity.subjectId !== event.subject.id ||
          previous.source.identity.repository !== event.subject.repository ||
          previous.source.identity.pullRequestNumber !== event.subject.number) return false;
      // This only supplies discovery lineage; normal intake still owns cutover.
      // The live Base may have advanced while the missing Head bridge was fenced.
      const target = this.state.items.find(item => samePullRequestSubject(previous, item) &&
        item.source.scope.kind === "automatic" && item.source.scope.active === true &&
        item.currentTarget.id === "developer" && item.status === "blocked" &&
        item.statusReason === PR_SOURCE_AUTHORITY_FENCED_REASON && item.source.pendingRevision === null &&
        item.sourceQuarantine === null && item.activeIntentId === null && item.decisionContext === null &&
        item.ownerId === null && item.leaseId === null && item.leaseUntil === null &&
        item.source.current.headRefOid === event.payload.headRefOid &&
        item.source.current.event.source.provider === event.source.provider &&
        item.source.current.event.source.scopeId === event.source.scopeId &&
        samePullRequestGitTarget({ ...item.source.current.event.payload.gitTarget,
          baseRefOid: event.payload.gitTarget.baseRefOid }, event.payload.gitTarget));
      if (!target) return false;
      const authority = pullRequestTrustedPredecessor(this.state, target);
      if (authority?.canonicalRootItemId !== null || authority.authorityFenced !== true ||
          authority.sourceRootItemId !== previous.itemId || authority.headRefOid !== previous.source.current.headRefOid) return false;
      const participants = this.state.items.filter(item =>
        [previous.itemId, target.itemId].includes(currentWorkItemInputBinding(item)?.rootItemId));
      return !participants.some(item => item.itemId !== previous.itemId && item.itemId !== target.itemId &&
        !CLAIM_CHILD_SETTLED_STATUSES.has(item.status));
    }));
  }

  async readItemProgress(itemIds) {
    this.#assertReady();
    if (!Array.isArray(itemIds) || itemIds.length > MAX_WORK_LEDGER_QUERY_PAGE ||
      itemIds.some((id) => typeof id !== "string" || !id || id.length > 192)) {
      throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作项进度查询无效");
    }
    const requested = new Set(itemIds);
    const { graphProgressDigest } = indexWorkLedgerGraphProgress(this.state.items);
    return this.state.items.filter((item) => requested.has(item.itemId)).map((item) => {
      const progress = graphProgressDigest(item);
      return cloneLedgerValue({
        itemId: item.itemId, status: item.status, statusReason: item.statusReason,
        currentTarget: item.currentTarget, updatedAt: item.updatedAt,
        ...(progress === null ? {} : { graphProgressDigest: progress }),
      });
    });
  }

  async readRepairDecisionBudget({ itemId, expectedRevision }) {
    this.#assertReady();
    const item = this.state.items.find(entry => entry.itemId === itemId);
    if (!item || item.revision !== expectedRevision) return null;
    return cloneLedgerValue(repairDecisionAttemptBudget(this.state, item));
  }

  async listClaimCandidates(options = {}) {
    this.#assertReady();
    const page = queryClaimCandidatePage(this.state.items, options);
    const failures = new Map([...indexRecordedDecisionFailures(this.state), ...indexUnstartedCodeDispatchFailures(this.state),
      ...indexRecordedProposalFailures(this.state)]);
    const failedChildParents = recordedFailureParentIds(this.state, failures);
    const coordinationParents = new Set(indexParentCoordinationReturns(this.state).values());
    page.items.forEach((item, index) => {
      if (hasPendingHostContextRecovery(this.state, item) || failedChildParents.has(item.itemId) ||
          coordinationParents.has(item.itemId)) page.facts[index].orchestrationReady = true;
    });
    return page;
  }

  // These host producer ports are intentionally absent from public runtime,
  // native, HTTP and CLI facades. A plain or replayed object never writes proof.
  async readHostHeadAncestryCandidates({ events, afterItemId = null }) {
    this.#assertReady();
    const current = new Map(events.map(event => [event.subject.id, event]));
    const candidates = this.state.items.filter(item => item.kind === "source_root" && item.currentTarget?.id === "developer" &&
      item.source?.scope?.kind === "automatic" && item.source.scope.active === false &&
      current.has(currentWorkItemEvent(item).subject.id) && ownsHeadAncestryPredecessor(this.state, item)).sort((a, b) => a.itemId.localeCompare(b.itemId));
    const start = afterItemId === null ? 0 : candidates.findIndex(item => item.itemId > afterItemId);
    const index = start < 0 ? 0 : start;
    return cloneLedgerValue({ items: [...candidates.slice(index), ...candidates.slice(0, index)].slice(0, 2)
      .map(root => ({ root, event: current.get(currentWorkItemEvent(root).subject.id) })) });
  }

  async recordHostHeadAncestry(credential) {
    const receipt = consumeHeadAncestryCredential(credential);
    if (receipt === null) return null;
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
      const root = this.state.items.find(item => item.itemId === receipt.rootItemId), source = root?.source;
      if (root?.revision !== receipt.rootRevision || root.kind !== "source_root" || root.currentTarget?.id !== "developer" ||
          source?.scope?.kind !== "automatic" || source.scope.active !== false || root.sourceQuarantine !== null ||
          root.ownerId !== null || root.leaseId !== null || root.leaseUntil !== null ||
          !["blocked", "waiting_external"].includes(root.status) || source.pendingRevision !== null ||
          source.workKey !== receipt.sourceWorkKey || source.inputRevision !== receipt.sourceInputRevision ||
          source.current.inputDigest !== receipt.sourceInputDigest || source.authorityEpoch !== receipt.authorityEpoch ||
          source.current.headRefOid !== receipt.ancestorHeadRefOid || !ownsHeadAncestryPredecessor(this.state, root)) return null;
      const at = this.#now(), updated = { ...root, revision: root.revision + 1, updatedAt: at,
        source: { ...source, headAncestryReceipt: receipt } };
      return this.#commitMutation({ patch: { items: this.state.items.map(item => item.itemId === root.itemId ? updated : item) },
        timelineEvents: [{ itemId: root.itemId, type: "pr_source_ignored", at, actorId: "host-head-ancestry-reader",
          details: { disposition: "host_ancestry_attested", receiptId: receipt.receiptId } }], result: receipt });
    }));
  }

  async listPendingPullRequestSources(options = {}) {
    this.#assertReady();
    const pendingRoots = this.state.items.filter((item) =>
      item.kind === "source_root" &&
      item.source?.kind === "pull_request" &&
      (
        item.source.pendingRevision !== null ||
        item.statusReason?.startsWith(
          `${CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON}:`,
        )
      )
    );
    return queryPage(
      pendingRoots,
      "itemId",
      options,
      WORK_LEDGER_STATUSES,
    );
  }

  async listTimeline(options = {}) {
    this.#assertReady();
    if (isPlainLedgerObject(options) && Object.hasOwn(options, "itemId")) {
      const { itemId: suppliedItemId, ...pageOptions } = options;
      const itemId = boundedLedgerString(suppliedItemId, "itemId", 192);
      return queryPage(this.state.timeline.filter((entry) => entry.itemId === itemId), "timelineId", pageOptions);
    }
    return queryPage(this.state.timeline, "timelineId", options);
  }

  async listOutbox(options = {}) {
    this.#assertReady();
    if (isPlainLedgerObject(options) && Object.hasOwn(options, "itemId")) {
      const { itemId: suppliedItemId, ...pageOptions } = options;
      const itemId = boundedLedgerString(suppliedItemId, "itemId", 192);
      return queryPage(this.state.outbox.filter(entry => entry.itemId === itemId), "intentId", pageOptions, WORK_LEDGER_OUTBOX_STATUSES);
    }
    return queryPage(
      this.state.outbox,
      "intentId",
      options,
      WORK_LEDGER_OUTBOX_STATUSES,
    );
  }

  async readItemForReconciliation(input = {}) {
    this.#assertReady();
    if (!hasExactLedgerKeys(input, ["itemId"])) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作项恢复查询无效",
      );
    }
    let itemId;
    try {
      itemId = boundedLedgerString(input.itemId, "itemId", 192);
    } catch {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作项恢复查询无效",
      );
    }
    const state = await this.#readCommittedAuthorityState();
    const item = state.items.find(candidate => candidate.itemId === itemId);
    return item ? cloneLedgerValue(item) : null;
  }

  async readReviewAdoptionContext(input = {}) {
    this.#assertReady();
    if (!hasExactLedgerKeys(input, ["itemId"])) throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "Review 采用上下文查询无效");
    let itemId;
    try { itemId = boundedLedgerString(input.itemId, "itemId", 192); }
    catch { throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "Review 采用上下文查询无效"); }
    const state = await this.#readCommittedAuthorityState();
    const item = state.items.find(candidate => candidate.itemId === itemId);
    if (!item) return null;
    const inputBinding = currentWorkItemExecutionBinding(item);
    const root = inputBinding === null ? null : state.items.find(candidate => candidate.itemId === inputBinding.rootItemId) ?? null;
    const activeDispatch = item.activeIntentId === null ? null : state.outbox.find(candidate => candidate.intentId === item.activeIntentId) ?? null;
    return cloneLedgerValue({ item, root, activeDispatch });
  }

  async readInternalReviewHandoff(input = {}) {
    this.#assertReady();
    if (!hasExactLedgerKeys(input, ["itemId"])) throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "内部复审交接查询无效");
    let itemId;
    try { itemId = boundedLedgerString(input.itemId, "itemId", 192); }
    catch { throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "内部复审交接查询无效"); }
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      this.state = await this.#readDurableState();
      const item = this.state.items.find((entry) => entry.itemId === itemId);
      const proof = currentPrRoleHandoffProof(this.state, item, {
        fromRoleId: 'developer', targetRoleId: 'pr-engineer', capability: 'pr-review',
      });
      return proof === null ? null : cloneLedgerValue({ kind: "developer_handoff", headRefOid: proof.executionBinding.headRefOid,
        brief: proof.bound.payload.brief, evidence: proof.bound.payload.evidence, evidenceAuthority: "developer_report" });
    }));
  }

  async isAttentionRequestCurrent(input = {}) {
    return (await this.areAttentionRequestsCurrent([input]))[0];
  }

  async areAttentionRequestsCurrent(inputs) {
    this.#assertReady();
    if (!Array.isArray(inputs) || inputs.length > 1_000) {
      throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "内部请示授权查询无效");
    }
    const bindings = inputs.map((input) => this.#normalizeAttentionAuthority(input));
    if (bindings.length === 0) return [];
    const state = await this.#readCommittedAuthorityState();
    return bindings.map((binding) => this.#attentionCurrentInState(state, binding));
  }

  #normalizeAttentionAuthority(input) {
    if (
      !hasExactLedgerKeys(input, ["requestKey", "producer"]) ||
      !isPlainLedgerObject(input.producer) ||
      !hasExactLedgerKeys(input.producer, ["roleId", "workItemId"])
    ) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "内部请示授权查询无效",
      );
    }
    let requestKey;
    let roleId;
    let workItemId;
    try {
      requestKey = boundedLedgerString(input.requestKey, "requestKey", 128);
      roleId = boundedLedgerString(input.producer.roleId, "roleId", 128);
      workItemId = boundedLedgerString(
        input.producer.workItemId,
        "workItemId",
        192,
      );
    } catch {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "内部请示授权查询无效",
      );
    }
    return { requestKey, roleId, workItemId };
  }

  #attentionCurrentInState(state, { requestKey, roleId, workItemId }) {
    const item = state.items.find(
      (candidate) => candidate.itemId === workItemId,
    );
    const intent = state.outbox.find(
      (candidate) => candidate.intentId === requestKey,
    );
    const ownsTarget =
      item?.currentTarget?.type === "role" &&
      item.currentTarget.id === roleId;
    const orchestratorTakeover =
      roleId === "orchestrator" &&
      intent?.requestedBy?.workerId === "employee-orchestrator";
    return Boolean(
      item?.status === "waiting_user" &&
        item.activeIntentId === requestKey &&
        intent?.itemId === workItemId &&
        attentionResultInputBinding(state, item, intent) !== undefined &&
        intent.status === "delivered" &&
        intent.intent?.type === "ask_user" &&
        intent.requestedBy?.roleId === roleId &&
        (ownsTarget || orchestratorTakeover) &&
        !hasNewerIssueAssignment(state.items, item),
    );
  }

  async isIntentDispatchCurrent(input = {}) {
    this.#assertReady();
    if (
      !hasExactLedgerKeys(input, [
        "intentId",
        "expectedRevision",
        "dispatchLeaseId",
        "bindingDigest",
        "itemId",
        "itemExpectedRevision",
      ]) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.itemExpectedRevision) ||
      input.itemExpectedRevision < 1
    ) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作意图派发授权查询无效",
      );
    }
    let intentId;
    let dispatchLeaseId;
    let bindingDigest;
    let itemId;
    try {
      intentId = boundedLedgerString(input.intentId, "intentId", 192);
      dispatchLeaseId = boundedLedgerString(
        input.dispatchLeaseId,
        "dispatchLeaseId",
        128,
      );
      bindingDigest = boundedLedgerString(
        input.bindingDigest,
        "bindingDigest",
        64,
      );
      itemId = boundedLedgerString(input.itemId, "itemId", 192);
    } catch {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作意图派发授权查询无效",
      );
    }
    if (!SHA256.test(bindingDigest)) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "工作意图派发授权查询无效",
      );
    }
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        const item = this.state.items.find(
          (candidate) => candidate.itemId === itemId,
        );
        const outbox = this.state.outbox.find(
          (candidate) => candidate.intentId === intentId,
        );
        return Boolean(
          item?.status === "dispatch_pending" &&
            item.revision === input.itemExpectedRevision &&
            item.activeIntentId === intentId &&
            outbox?.itemId === itemId &&
            outbox.status === "dispatching" &&
            outbox.revision === input.expectedRevision &&
            outbox.dispatchLeaseId === dispatchLeaseId &&
            outbox.dispatchBinding?.bindingDigest === bindingDigest,
        );
      }),
    );
  }

  async verifyPullRequestExecutionBinding(input = {}) {
    this.#assertReady();
    const state = await this.#readCommittedAuthorityState();
    return cloneLedgerValue(verifyPullRequestExecutionAuthority(state, input));
  }

  async verifyPullRequestExecutionBindings(input = {}) {
    this.#assertReady();
    if (
      !hasExactLedgerKeys(input, ["ledgerRevision", "bindings"]) ||
      !Number.isSafeInteger(input.ledgerRevision) ||
      input.ledgerRevision < 0 ||
      !Array.isArray(input.bindings) ||
      input.bindings.length > MAX_PR_EXECUTION_BINDING_VERIFICATION_BATCH
    ) {
      throw workLedgerError(
        "WORK_LEDGER_PR_EXECUTION_BINDING_BATCH_INVALID",
        "PR 执行输入批量校验请求无效",
      );
    }
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        if (this.state.revision !== input.ledgerRevision) {
          throw workLedgerError(
            "WORK_LEDGER_MEMORY_AUTHORITY_SNAPSHOT_STALE",
            "记忆投影绑定的工作台账快照已变化",
            409,
          );
        }
        const current = input.bindings.map((binding) => {
          try {
            verifyPullRequestExecutionAuthority(this.state, binding);
            return true;
          } catch (error) {
            if (error?.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE") {
              return false;
            }
            throw error;
          }
        });
        return cloneLedgerValue({
          ledgerRevision: this.state.revision,
          current,
        });
      }),
    );
  }

  async readAutomaticReviewAdmission(input = {}) {
    this.#assertReady();
    const state = await this.#readCommittedAuthorityState();
    const inputBinding = verifyPullRequestExecutionAuthority(state, input);
    const root = state.items.find(item => item.itemId === inputBinding.rootItemId);
    return cloneLedgerValue({ inputBinding, admission: automaticReviewWorkAdmission(root, inputBinding.inputRevision) });
  }

  // The low-risk promoter may point to work already admitted by the GitHub
  // source. Reusing this pointer creates no owner request or execution authority.
  async readCurrentAutomaticReviewWork({ repository, number, headRefOid, gitTarget }) {
    this.#assertReady();
    const target = normalizePullRequestGitTarget(gitTarget);
    if (!Number.isSafeInteger(number) || number < 1 || typeof repository !== "string" ||
        target.baseRepository !== repository || target.headRefOid !== headRefOid) return null;
    const state = await this.#readCommittedAuthorityState();
    for (const root of state.items) {
      if (root.kind !== "source_root" || root.currentTarget?.id !== "pr-engineer" ||
          root.graph.parentItemId !== null || ["completed", "cancelled", "superseded"].includes(root.status) ||
          root.source?.scope.kind !== "automatic" || root.source.scope.active !== true ||
          root.sourceQuarantine !== null || root.source.pendingRevision !== null ||
          root.source.identity.repository !== repository || root.source.identity.pullRequestNumber !== number) continue;
      const event = root.source.current.event;
      const admission = automaticReviewWorkAdmission(root);
      if (event.source.provider !== "github" || event.payload.relation !== "review_requested" || admission === null ||
          automaticReviewContinuationEligibility({ ...event.payload, kind: "pull_request" }, target.sourceAccountId, this.#now(), admission) !== null) continue;
      const binding = currentWorkItemExecutionBinding(root);
      if (!binding?.gitTarget || !samePullRequestGitTarget(binding.gitTarget, target)) continue;
      try { verifyPullRequestExecutionAuthority(state, binding); }
      catch (error) { if (error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE") continue; throw error; }
      return { workItemId: root.itemId };
    }
    return null;
  }

  async readPullRequestExecutionContext(input = {}) {
    this.#assertReady();
    const state = await this.#readCommittedAuthorityState();
    const inputBinding = verifyPullRequestExecutionAuthority(state, input);
    const root = state.items.find(candidate => candidate.itemId === inputBinding.rootItemId);
    const author = root?.source?.current?.event?.payload?.author;
    const reviewFeedbackDigest = root?.source?.current?.event?.payload?.reviewFeedbackDigest;
    return cloneLedgerValue({
      inputBinding,
      author: typeof author === "string" && GITHUB_LOGIN.test(author) ? author : null,
      ...(typeof reviewFeedbackDigest === "string" ? { reviewFeedbackDigest } : {}),
    });
  }

  async getGraphSnapshot({ signal = null } = {}) {
    this.#assertReady();
    signal = normalizeAbortSignal(signal);
    const assertActive = () => {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Graph read was aborted", "AbortError");
    };
    assertActive();
    // Read the committed file even when an unrelated candidate holds the writer
    // lease. A lost write ACK remains visible; an uncommitted candidate does not.
    const state = await this.#readCommittedAuthorityState();
    assertActive();
    return this.#currentGraphSnapshot(state);
  }

  async readAttentionRequestRetirement(input = {}) {
    // A temporarily non-current question is not proof that its task ended.
    await this.isAttentionRequestCurrent(input);
    const state = await this.#readCommittedAuthorityState();
    const item = state.items.find((candidate) => candidate.itemId === input.producer.workItemId);
    const intent = state.outbox.find((candidate) => candidate.intentId === input.requestKey);
    const ciRetirement = ciMaterialRetirement(intent);
    const hostRetirement = hostContextRetirement(intent);
    const maintenance = systemMaintenanceRetirement(intent) ?? hostRetirement ?? ciRetirement;
    if (item && intent?.itemId === item.itemId && intent.requestedBy.roleId === input.producer.roleId && maintenance !== null) {
      return { status: ciRetirement || ["delivery", "review"].includes(hostRetirement?.failure.stage) ? "queued" : "retry_wait",
        workItemRevision: maintenance.workItemRevision, reason: maintenance.reason };
    }
    if (
      !item || !["cancelled", "completed", "superseded"].includes(item.status) ||
      item.activeIntentId !== null || intent?.itemId !== item.itemId ||
      intent.intent.type !== "ask_user" || intent.requestedBy.roleId !== input.producer.roleId
    ) return null;
    return {
      status: item.status, workItemRevision: item.revision, reason: item.statusReason,
    };
  }

  async getLastCommittedGraphSnapshot() {
    this.#assertReady();
    return this.#currentGraphSnapshot(this.committedAuthoritySnapshot?.state ?? this.state);
  }

  async readGraphMemoryProjectionBatch(options = {}) {
    this.#assertReady();
    return readWorkGraphMemoryProjectionBatch(
      this.state.graphMemoryProjection,
      options,
    );
  }

  async readMemoryAuthoritySnapshot({ limit = 100 } = {}) {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        return cloneLedgerValue({
          ledgerRevision: this.state.revision,
          items: this.state.items,
          timeline: this.state.timeline,
          graph: readWorkGraphMemoryProjectionBatch(
            this.state.graphMemoryProjection,
            { limit },
          ),
        });
      }),
    );
  }

  async readMemoryAuthorityStatus() {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        const graph = this.state.graphMemoryProjection;
        return cloneLedgerValue({
          ledgerRevision: this.state.revision,
          graph: {
            cursor: graph.cursor,
            highWatermark: graph.nextSequence - 1,
            checkpointDigest: graph.checkpointDigest,
            highWatermarkDigest:
              graph.pending.at(-1)?.eventDigest ?? graph.checkpointDigest,
            authorityStateDigest: graph.authorityStateDigest,
          },
        });
      }),
    );
  }

  async acknowledgeGraphMemoryProjection(input = {}) {
    return this.acknowledgeGraphMemoryProjectionBatch({ receipts: [input] });
  }

  async acknowledgeGraphMemoryProjectionBatch(input = {}) {
    this.#assertReady();
    return this.#writeTransaction(async () => {
      const nextRevision = this.state.revision + 1;
      const acknowledgement = acknowledgeWorkGraphMemoryProjectionBatch(
        this.state.graphMemoryProjection,
        input,
        nextRevision,
      );
      if (!acknowledgement.write) {
        return cloneLedgerValue(acknowledgement.result);
      }
      await this.#persist(
        {
          ...this.state,
          revision: nextRevision,
          graphMemoryProjection: acknowledgement.projection,
        },
        { appendGraphMemory: false },
      );
      return cloneLedgerValue(acknowledgement.result);
    });
  }

  async intake({ limit = 100 } = {}) {
    this.#assertReady();
    const batchLimit = validatePositiveLimit(
      limit,
      MAX_WORK_LEDGER_INTAKE_BATCH,
      "limit",
    );
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
      if (this.pullRequestScopeRecoveryPending) {
        await this.#reconcileRecoveredPullRequestScopes();
      }
      const afterSequence = this.state.intakeCursor;
      let rawBatch;
      try {
        rawBatch = await this.assignmentSource.readAssignmentBatch({
          afterSequence,
          limit: batchLimit,
        });
      } catch (error) {
        const reportedGap = normalizeReportedAssignmentGap(error, afterSequence);
        if (reportedGap) {
          this.#assertSourceHighWatermark(reportedGap.highWatermark);
          return this.#recordGap(
            { highWatermark: reportedGap.highWatermark },
            reportedGap,
            this.#now(),
          );
        }
        if (error?.code === "WORK_LEDGER_SOURCE_INVALID") throw error;
        throw workLedgerError(
          "WORK_LEDGER_SOURCE_UNAVAILABLE",
          "无法读取可靠工作分派流",
          503,
          { cause: error },
        );
      }
      const batch = normalizeAssignmentBatch(rawBatch, {
        afterSequence,
        requestedLimit: batchLimit,
        itemByteBudget: this.limits.itemByteBudget,
      });
      this.#assertSourceHighWatermark(batch.highWatermark);
      const now = this.#now();
      const gap = findAssignmentBatchGap(batch, afterSequence);
      if (gap) return this.#recordGap(batch, gap, now);
      try {
        return await this.#recordBatch(batch, now);
      } catch (error) {
        // Only a rejected, pre-commit graph transition is isolated. Storage,
        // corruption, and admission failures must still stop the cycle.
        if (
          error?.code !== "WORK_LEDGER_GRAPH_TRANSITION_INVALID" ||
          error.cause?.code !== "WORK_GRAPH_INVALID_TRANSITION"
        ) throw error;
        return this.#recordRejectedIntake(batch, now, error.code);
      }
    }));
  }

  async retireInactiveIssues(input = {}) {
    this.#assertReady();
    const exactKeys = Object.hasOwn(input, "itemIds")
      ? ["updatedBefore", "itemIds"]
      : ["updatedBefore"];
    if (!hasExactLedgerKeys(input, exactKeys)) {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "Issue 活跃窗口维护参数无效",
      );
    }
    let updatedBefore;
    let itemIds;
    try {
      updatedBefore = normalizeLedgerTimestamp(
        input.updatedBefore,
        "updatedBefore",
      );
      if (Object.hasOwn(input, "itemIds")) {
        if (
          !Array.isArray(input.itemIds) ||
          input.itemIds.length > MAX_WORK_LEDGER_INTAKE_BATCH
        ) {
          throw new TypeError("itemIds");
        }
        itemIds = input.itemIds.map((itemId) =>
          boundedLedgerString(itemId, "itemId", 192));
        if (new Set(itemIds).size !== itemIds.length) {
          throw new TypeError("itemIds");
        }
      }
    } catch {
      throw workLedgerError(
        "WORK_LEDGER_QUERY_INVALID",
        "Issue 活跃窗口维护参数无效",
      );
    }
    return this.#executeCommand(planInactiveIssueRetirement, {
      updatedBefore,
      ...(itemIds === undefined ? {} : { itemIds }),
    });
  }

  async reconcilePullRequestSource(input = {}) {
    this.#assertReady();
    const command = normalizePullRequestSourceReconciliationCommand(input);
    const confirmationSettlements = await this.#readConfirmationSettlements([command], command.expectedGraphRevision);
    return this.#executeCommand((options) => planPullRequestSourceReconciliation({
      ...options, confirmationSettlements,
    }), command);
  }

  async reconcilePullRequestSourceBatch(input = {}) {
    this.#assertReady();
    if (
      !hasExactLedgerKeys(input, ["expectedGraphRevision", "items"]) ||
      !Number.isSafeInteger(input.expectedGraphRevision) ||
      input.expectedGraphRevision < 0 ||
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > MAX_WORK_LEDGER_QUERY_PAGE ||
      input.items.some((item) =>
        !hasExactLedgerKeys(item, [
          "itemId",
          "expectedRevision",
          "expectedPendingRevision",
        ])
      )
    ) {
      throw workLedgerError(
        "WORK_LEDGER_PR_SOURCE_RECONCILIATION_BATCH_INVALID",
        "PR 来源批量对账请求无效",
      );
    }
    const commands = input.items.map((item) => normalizePullRequestSourceReconciliationCommand({
      ...item, expectedGraphRevision: input.expectedGraphRevision,
    }));
    const confirmationSettlements = await this.#readConfirmationSettlements(commands, input.expectedGraphRevision);
    return this.#writeTransaction(async () => {
      if (this.state.revision !== input.expectedGraphRevision) {
        throw workLedgerError(
          "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
          "PR 来源批量对账的台账版本已变化",
          409,
        );
      }
      const outcomes = [];
      for (const item of input.items) {
        let mutation;
        try {
          mutation = planPullRequestSourceReconciliation({
            state: this.state,
            input: {
              ...item,
              expectedGraphRevision: input.expectedGraphRevision,
            },
            clock: () => this.#now(),
            timelineLimit: this.limits.timelineLimit,
            confirmationSettlements,
          });
        } catch (error) {
          if (
            error?.code !== "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT"
          ) {
            throw error;
          }
          outcomes.push({ itemId: item.itemId, status: "conflicted" });
          continue;
        }
        if (mutation.write === false) {
          outcomes.push({
            itemId: item.itemId,
            status: mutation.result.blockers.length > 0
              ? "blocked"
              : "unchanged",
          });
          continue;
        }
        await this.#commitMutation(mutation);
        outcomes.push({ itemId: item.itemId, status: "applied" });
        return cloneLedgerValue({ outcomes, stoppedAfterWrite: true });
      }
      return cloneLedgerValue({ outcomes, stoppedAfterWrite: false });
    });
  }

  async #readConfirmationSettlements(commands, expectedGraphRevision) {
    if (this.confirmationSettlementReader === null) return null;
    if (!this.state.items.some((item) => item.status === "blocked" &&
      item.activeIntentId === null && (isChangedCodeConfirmationDecision(item.decisionContext) ||
        isChangedReviewConfirmationDecision(item.decisionContext)))) return null;
    // Never hold the ledger lease while entering the confirmation queue: its
    // executor can call back into this ledger when verifying code authority.
    const snapshot = await this.#writeTransaction(() => {
      if (this.state.revision !== expectedGraphRevision) {
        throw workLedgerError("WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT", "PR 来源对账的台账版本已变化", 409);
      }
      const itemsById = new Map(this.state.items.map((item) => [item.itemId, item]));
      const candidates = new Map();
      const eligible = this.state.items.filter((item) => item.status === "blocked" &&
        item.activeIntentId === null && (isChangedCodeConfirmationDecision(item.decisionContext) ||
          isChangedReviewConfirmationDecision(item.decisionContext)))
        .map((item) => ({ item, binding: currentWorkItemInputBinding(item) }));
      for (const command of commands) {
        const root = itemsById.get(command.itemId);
        if (root?.source?.kind !== "pull_request") continue;
        if (root.revision !== command.expectedRevision ||
          (root.source.pendingRevision ?? root.source.activeRevision) !== command.expectedPendingRevision) {
          throw workLedgerError("WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT", "PR 来源对账的工作项版本已变化", 409);
        }
        const predecessorId = crossRootPullRequestCutoverPredecessorId(root);
        if (root.source.pendingRevision === null && predecessorId === null) continue;
        const participantRoot = predecessorId === null ? root : itemsById.get(predecessorId);
        if (participantRoot === undefined) continue;
        const active = currentWorkItemInputBinding(participantRoot);
        for (const { item, binding } of eligible) {
          if ((item.itemId === participantRoot.itemId ||
              (binding?.rootItemId === participantRoot.itemId &&
                binding.headRevision === active?.headRevision))) candidates.set(item.itemId, item);
        }
      }
      return {
        candidates: cloneLedgerValue([...candidates.values()].slice(0, MAX_WORK_LEDGER_QUERY_PAGE)),
        outbox: cloneLedgerValue(this.state.outbox.filter(({ itemId }) => candidates.has(itemId))),
      };
    });
    const outboxById = new Map(snapshot.outbox.map((entry) => [entry.intentId, entry]));
    const proofs = new Map();
    for (const item of snapshot.candidates) {
      if (isChangedReviewConfirmationDecision(item.decisionContext)) {
        const confirmations = [];
        for (const confirmationId of reviewConfirmationSettlementIds(item, outboxById)) {
          confirmations.push(await this.confirmationSettlementReader.read({ confirmationId }));
        }
        const proof = createCompletedReviewConfirmationSettlement(item, outboxById, confirmations);
        if (proof !== null) proofs.set(item.itemId, proof);
        continue;
      }
      const confirmation = await this.confirmationSettlementReader.read({
        confirmationId: codeConfirmationSettlementId(item.decisionContext),
      });
      let proof = createRevokedCodeConfirmationSettlement(item, outboxById, confirmation);
      if (proof === null && typeof this.obsoleteCodeJobSettler?.read === "function") {
        const unstarted = unstartedCodeConfirmationForSettlement(item, outboxById, confirmation);
        if (unstarted !== null) {
          const job = await this.obsoleteCodeJobSettler.read(unstarted);
          proof = createUnstartedCodeConfirmationSettlement(item, outboxById, confirmation, job);
        }
      }
      if (proof === null && this.obsoleteCodeJobSettler !== null) {
        const completed = completedCodeConfirmationForSettlement(item, outboxById, confirmation);
        if (completed !== null) {
          // A stored unknown result cannot authorize cancelling another live or
          // uncertain job. Only its already terminal fence can enter settlement.
          if (item.decisionContext.outcome === "unknown" &&
              (typeof this.obsoleteCodeJobSettler.read !== "function" ||
                (await this.obsoleteCodeJobSettler.read(completed))?.status !== "fenced")) continue;
          const job = await this.obsoleteCodeJobSettler.settle({ grant: completed.grant, receipt: completed.receipt }, {
            admitCancellation: (operation) => this.#writeTransaction(() => {
              if (this.state.revision !== expectedGraphRevision) {
                throw workLedgerError("WORK_LEDGER_STATE_REVISION_CONFLICT", "PR 来源在取消入场前已变化", 409);
              }
              // Enqueue under the source fence, then await outside the ledger
              // lease: cancellation can itself need the ledger/session queues.
              return { operation: operation() };
            }),
          });
          proof = createCompletedCodeConfirmationSettlement(item, outboxById, confirmation, job);
        }
      }
      if (proof !== null) proofs.set(item.itemId, proof);
    }
    // Revoked unstarted confirmations and terminal code jobs cannot resume.
    // Their settlement remains valid while we reacquire the ledger lease.
    // The planner re-reads durable state and checks its normal graph/item CAS;
    // each opaque proof additionally binds the captured item and outbox versions.
    return proofs;
  }

  async claim(input = {}) {
    return this.#admitNewWork(() =>
      this.#executeCommand(planWorkItemClaim, input, true),
    );
  }

  async transition(input = {}) {
    return this.#executeCommand(planWorkItemTransition, input);
  }

  async #prepareUnstartedReviewRecovery({ itemId, expectedRevision }) {
    if (!this.confirmationSettlementReader) return null;
    const item = await this.readItemForReconciliation({ itemId });
    const eligible = candidate => candidate?.revision === expectedRevision && candidate.kind === "source_root" &&
      candidate.status === "blocked" && candidate.statusReason === "proposal_stale" &&
      candidate.currentTarget?.id === "pr-engineer" && candidate.ownerId === null && candidate.leaseId === null &&
      candidate.activeIntentId === null && candidate.sourceQuarantine === null && candidate.graph.deliveries.length === 0;
    if (!eligible(item)) return null;
    const outboxes = new Map(this.state.outbox.filter(entry => entry.itemId === itemId).map(entry => [entry.intentId, cloneLedgerValue(entry)]));
    if (![...outboxes.values()].some(entry => entry.outcome?.details?.downstreamRef === item.decisionContext.referenceId &&
        entry.updatedAt === item.updatedAt)) return null;
    const ids = reviewConfirmationSettlementIds(item, outboxes);
    if (ids.length === 0) return null;
    const confirmations = [];
    for (const confirmationId of ids) confirmations.push(await this.confirmationSettlementReader.read({ confirmationId }));
    // A revoked row is as settled as absence only when publication never began.
    // The settlement proof below still binds every historical identity and row.
    if (confirmations.some(value => value !== null && (
      value?.item?.status !== "stale" || value.item.execution !== null || value.item.failure !== null ||
      value.item.receipt !== null || value.item.rejection !== null ||
      value.item.invalidation?.reason !== "authorization_changed"
    ))) return null;
    const proof = createCompletedReviewConfirmationSettlement(item, outboxes, confirmations);
    if (proof === null) return null;
    const timeline = this.state.timeline.filter(entry => entry.itemId === itemId);
    if (timeline[0]?.type !== "pr_source_created" || timeline[0].at !== item.createdAt ||
        timeline.some(entry => entry.details.reason === "review_authority_context_recovered") ||
        this.state.items.some(candidate => candidate.graph?.parentItemId === itemId)) return null;
    return { item, proof, eligible };
  }

  async canRecoverUnstartedReviewProposal(input) {
    return await this.#prepareUnstartedReviewRecovery(input) !== null;
  }

  async recoverUnstartedReviewProposal({ itemId, expectedRevision }) {
    const prepared = await this.#prepareUnstartedReviewRecovery({ itemId, expectedRevision });
    if (prepared === null) return false;
    const { item, proof, eligible } = prepared;
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
      const current = this.state.items.find(candidate => candidate.itemId === itemId);
      const currentOutboxes = new Map(this.state.outbox.filter(entry => entry.itemId === itemId).map(entry => [entry.intentId, entry]));
      const timeline = this.state.timeline.filter(entry => entry.itemId === itemId);
      if (!eligible(current) || ledgerDigest(current) !== ledgerDigest(item) ||
          !hasReviewConfirmationSettlement(current, currentOutboxes, proof) ||
          timeline[0]?.type !== "pr_source_created" || timeline[0].at !== current.createdAt ||
          timeline.some(entry => entry.details.reason === "review_authority_context_recovered") ||
          this.state.items.some(candidate => candidate.graph?.parentItemId === itemId)) return false;
      verifyPullRequestExecutionAuthority(this.state, currentWorkItemExecutionBinding(current));
      const mutation = planWorkItemTransition({ state: this.state, input: { itemId, expectedRevision, leaseId: null,
        actorId: "work-ledger-system", toStatus: "queued", reason: "review_authority_context_recovered",
        details: { evidenceRefs: [`proposal:${current.decisionContext.referenceId}`] } }, clock: () => this.#now() });
      await this.#commitMutation(mutation);
      return true;
    }));
  }

  async controlModelRun(input = {}) {
    return this.#executeCommand(planWorkItemRunControl, input);
  }

  async scheduleRetry(input = {}) {
    return this.#executeCommand(planWorkItemRetry, input);
  }

  async handoff(input = {}) {
    return this.#executeCommand(planWorkItemHandoff, input);
  }

  async complete(input = {}) {
    return this.#executeCommand(planWorkItemCompletion, input);
  }

  async cancelGraphTask(input = {}) {
    const planner = hasExactLedgerKeys(input, ["authority", "command"])
      ? planScopedWorkGraphCancellation
      : planWorkGraphCancellation;
    return this.#executeCommand(planner, input);
  }

  async retireAutomaticReviewTestingWork({ limit = 10 } = {}) {
    validatePositiveLimit(limit, 100, 'limit');
    if (!this.confirmationSettlementReader || !this.reviewTestingRetirementReader) return { retired: 0 };
    const captured = await this.#writeTransaction(() => {
      const candidates = this.state.items.filter(isReviewTestingRetirementCandidate);
      const start = this.reviewTestingRetirementCursor % Math.max(1, candidates.length);
      this.reviewTestingRetirementCursor = start + limit;
      return cloneLedgerValue([...candidates.slice(start), ...candidates.slice(0, start)].slice(0, limit)
        .map(reviewTestingRetirementCandidate).filter(Boolean));
    });
    let retired = 0;
    for (const candidate of captured) {
      const snapshot = await this.confirmationSettlementReader.read({ confirmationId: candidate.confirmationId });
      if (!matchesAutomaticReviewTestingHandoff(candidate, snapshot)) continue;
      // Stop/cancel executor activity outside the ledger lease, then recheck
      // the captured root under its normal writer and graph cancellation rules.
      const stopped = await this.reviewTestingRetirementReader.read(candidate);
      if (!stopped) continue;
      const result = await this.#admitNewWork(() => this.#executeCommand(options =>
        planAutomaticReviewTestingRetirement({ ...options, captured: candidate, snapshot, stopped }), {}));
      retired += result.retired;
    }
    return { retired };
  }

  async createGraphChild(input = {}) {
    return this.#executeCommand(Object.hasOwn(input.command ?? {}, "reviewReplacement")
      ? planWorkGraphReviewReplacement : planWorkGraphChildCreation, input);
  }

  async reviseGraphAcceptance(input = {}) {
    return this.#executeCommand(planWorkGraphAcceptanceRevision, input);
  }

  async submitGraphDelivery(input = {}) {
    return this.#executeCommand(planWorkGraphDeliverySubmission, input);
  }

  async decideGraphDelivery(input = {}) {
    return this.#executeCommand(planWorkGraphDeliveryDecision, input);
  }

  async reassignGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskReassignment, input);
  }

  async pauseGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskPause, input);
  }

  async resumeGraphTask(input = {}) {
    return this.#executeCommand(planWorkGraphTaskResume, input);
  }

  async stageGraphEscalation(input = {}) {
    return this.#executeCommand(planWorkGraphEscalation, input);
  }

  async stageIntent(input = {}) {
    return this.#executeCommand(planIntentStage, input);
  }

  async claimIntent(input = {}) {
    return this.#executeCommand(planIntentClaim, input, true);
  }

  async bindIntent(input = {}) {
    return this.#executeCommand(planIntentBinding, input);
  }

  async ackIntent(input = {}) {
    return this.#executeCommand(planIntentAcknowledgement, input);
  }

  async applyAttentionBatch(input = {}) {
    return this.#executeCommand(planAttentionBatchApplication, input);
  }

  async retrySystemMaintenanceQuestions(input = {}) {
    const result = await this.#executeCommand(planSystemMaintenanceRetry, input);
    if (!this.hostContextRecoveryReader || result.retried >= input.limit) return result;
    const retired = await this.#retireSupersededTriageQuestions(input, input.limit - result.retried);
    if (retired > 0) result.retired = retired;
    if (result.retried + retired >= input.limit) return result;
    // Called while the inbox holds its pending-question mutation lease. Read
    // task-run controls outside the ledger writer, then revalidate durable CAS.
    const captured = await this.#writeTransaction(() => {
      const pending = new Set(input.requestKeys);
      const candidates = [];
      for (const item of this.state.items) {
        if (!pending.has(item.activeIntentId)) continue;
        const ci = ciMaterialRecoveryCandidate(this.state, item);
        const candidate = ci ?? hostContextRecoveryCandidate(this.state, item);
        if (candidate) candidates.push({ itemId: item.itemId, snapshotDigest: candidate.snapshotDigest,
          ...(ci ? { ciMaterials: true, inputBinding: ci.readBinding, event: ci.readEvent } : {}),
          ...(candidate.reviewDiagnostics ? { reviewDiagnostics: true, confirmationIds: candidate.confirmationIds } : {}),
          ...(candidate.decisionOwner ? { controlItemId: candidate.decisionOwner.itemId, childItemId: item.itemId }
            : candidate.guardedChildItemId ? { childItemId: candidate.guardedChildItemId } : {}) });
        if (candidates.length >= input.limit - result.retried - retired) break;
      }
      return candidates;
    });
    for (const candidate of captured) {
      const control = candidate.reviewDiagnostics
        ? await this.hostContextRecoveryReader.readReviewDiagnostics?.({ itemId: candidate.itemId, childItemId: candidate.childItemId,
          confirmationIds: candidate.confirmationIds }) : candidate.ciMaterials
        ? await this.hostContextRecoveryReader.readCiMaterials?.({ itemId: candidate.itemId, inputBinding: candidate.inputBinding, event: candidate.event })
        : await this.hostContextRecoveryReader.read({ itemId: candidate.controlItemId ?? candidate.itemId,
          ...(candidate.childItemId ? { childItemId: candidate.childItemId } : {}) });
      const planner = candidate.ciMaterials ? planCiMaterialRecovery : planHostContextRecovery;
      const commit = () => this.#executeCommand(context => planner({ ...context, captured: candidate, control }), {});
      const recovered = await this.#admitNewWork(() => {
        if (!candidate.childItemId && !candidate.ciMaterials) return commit();
        if (!control || typeof this.hostContextRecoveryReader.withStoppedRuns !== "function") return { retried: 0 };
        return this.hostContextRecoveryReader.withStoppedRuns(control, commit)
          .then(guarded => guarded.executed ? guarded.result : { retried: 0 });
      });
      result.retried += recovered.retried;
    }
    return result;
  }

  async #retireSupersededTriageQuestions(input, limit) {
    const reader = this.hostContextRecoveryReader;
    if (input.requestKeys.length === 0 || typeof reader.readTriageRetirement !== 'function' || typeof reader.withStoppedRuns !== 'function') return 0;
    const captured = await this.#writeTransaction(() => {
      if (this.state.attentionCursor < this.state.attentionHighWatermark) return [];
      const pending = new Set(input.requestKeys), candidates = [];
      for (const item of this.state.items) {
        if (!pending.has(item.activeIntentId)) continue;
        const candidate = triageRetirementCandidate(this.state, item);
        if (candidate) candidates.push({ itemId: item.itemId, childItemId: candidate.child.itemId,
          snapshotDigest: candidate.snapshotDigest, inputBinding: candidate.inputBinding,
          confirmationIds: candidate.failure.confirmationIds });
        if (candidates.length >= limit) break;
      }
      return candidates;
    });
    let retired = 0;
    for (const candidate of captured) {
      const control = await reader.readTriageRetirement(candidate);
      if (!control) continue;
      const guarded = await this.#admitNewWork(() => reader.withStoppedRuns(control, () =>
        this.#executeCommand(context => planTriageRetirement({ ...context, captured: candidate, control }), {})));
      if (guarded.executed) retired += guarded.result.retired;
    }
    return retired;
  }

  async applyProposalBatch(input = {}) {
    return this.#executeCommand(planProposalBatchApplication, input);
  }

  async wakeCondition(input = {}) {
    return this.#executeCommand(planConditionWake, input);
  }

  #executeCommand(planner, input, requiresLeaseId = false) {
    this.#assertReady();
    return this.#writeTransaction(() => {
      const mutation = planner({
        state: this.state,
        input,
        clock: () => this.#now(),
        timelineLimit: this.limits.timelineLimit,
        ...(requiresLeaseId
          ? { newLeaseId: () => this.#newLeaseId() }
          : {}),
      });
      if (mutation.write === false) return cloneLedgerValue(mutation.result);
      return this.#commitMutation(mutation);
    });
  }

  async #commitMutation({ patch, timelineEvents, result }) {
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        ...patch,
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue(result);
  }

  async #recordGap(batch, gap, now) {
    const alert = createGapAlertWorkItem(gap, now);
    const existing = this.state.items.find(
      ({ assignmentId }) => assignmentId === alert.assignmentId,
    );
    if (existing && existing.inputDigest !== alert.inputDigest) {
      throw workLedgerError(
        "WORK_LEDGER_ASSIGNMENT_CONFLICT",
        "系统 gap 告警 ID 对应了不同输入",
        409,
      );
    }
    const items = existing ? this.state.items : [...this.state.items, alert];
    const timelineEvents = [];
    if (!existing) {
      timelineEvents.push({
        itemId: alert.itemId,
        type: "assignment_intaken",
        at: now,
        actorId: "work-ledger-system",
        details: {
          assignmentId: alert.assignmentId,
          sourceSequence: 0,
          inputDigest: alert.inputDigest,
          kind: "system_alert",
        },
      });
    }
    timelineEvents.push({
      itemId: alert.itemId,
      type: "intake_gap",
      at: now,
      actorId: "work-ledger-system",
      details: gap,
    });
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        sourceHighWatermark: batch.highWatermark,
        items,
      },
      timelineEvents,
    );
    await this.#persist(nextState);
    return cloneLedgerValue({
      received: 0,
      deduplicated: existing ? 1 : 0,
      cursor: this.state.intakeCursor,
      highWatermark: this.state.sourceHighWatermark,
      gap,
      itemIds: existing ? [] : [alert.itemId],
      alertItemId: alert.itemId,
    });
  }

  async #recordRejectedIntake(batch, now, code) {
    const details = {
      code,
      afterSequence: this.state.intakeCursor,
      nextSequence: batch.nextSequence,
      highWatermark: batch.highWatermark,
      batchDigest: ledgerDigest(batch.items),
    };
    const alreadyRecorded = this.state.timeline.some((entry) =>
      entry.type === "intake_rejected" &&
      entry.details.afterSequence === details.afterSequence &&
      entry.details.batchDigest === details.batchDigest &&
      entry.details.code === code
    );
    if (!alreadyRecorded) {
      await this.#commitMutation({
        patch: {},
        timelineEvents: [{
          itemId: null, type: "intake_rejected", at: now,
          actorId: "work-ledger-system", details,
        }],
        result: null,
      });
    }
    // Do not acknowledge or discard the offending envelopes. Their source
    // cursor stays unchanged so they can be replayed after the fault is fixed.
    return cloneLedgerValue({
      received: 0, deduplicated: 0,
      cursor: this.state.intakeCursor, highWatermark: batch.highWatermark,
      gap: null, itemIds: [], alertItemId: null, error: details,
    });
  }

  async #recordBatch(batch, now, deniedCutoverProofs = new Set(), scopeRecoveryRoots = null) {
    if (batch.items.length === 0) {
      return cloneLedgerValue({
        received: 0,
        deduplicated: 0,
        cursor: this.state.intakeCursor,
        highWatermark: this.state.sourceHighWatermark,
        gap: null,
        itemIds: [],
        alertItemId: null,
      });
    }
    const knownAssignments = new Map(
      this.state.items.map((item) => [
        item.assignmentId,
        {
          inputDigest: item.kind === "source_root"
            ? null
            : item.inputDigest,
          sourceSequence: item.sourceSequence,
        },
      ]),
    );
    for (const item of this.state.items) {
      if (item.source?.kind !== "pull_request") continue;
      for (const binding of item.source.bindings) {
        knownAssignments.set(binding.assignmentId, {
          inputDigest: binding.assignmentDigest,
          sourceSequence: binding.sourceSequence,
        });
      }
    }
    const initialItemIds = new Set(
      this.state.items.map(({ itemId }) => itemId),
    );
    const rootByWorkKey = new Map(
      this.state.items
        .filter(({ source }) => source?.kind === "pull_request")
        .map((item) => [item.source.workKey, item]),
    );
    const itemsById = new Map(
      this.state.items.map((item) => [item.itemId, item]),
    );
    const issueSettlementIndex = createIssueSettlementIndex(itemsById);
    const outboxById = new Map(
      this.state.outbox.map((entry) => [entry.intentId, entry]),
    );
    const touchedItemIds = new Set();
    const revisedItemIds = new Set();
    const retirePredecessorInBatch = (predecessor, locallySettled) => {
      const retired = retireCrossRootPullRequestPredecessor(locallySettled, now);
      const persisted = initialItemIds.has(predecessor.itemId);
      const settled = {
        ...retired,
        revision: !persisted || revisedItemIds.has(predecessor.itemId)
          ? predecessor.revision
          : retired.revision,
        ...(!persisted ? { status: "blocked" } : {}),
      };
      if (persisted && settled.revision !== predecessor.revision) {
        revisedItemIds.add(settled.itemId);
      }
      return settled;
    };
    const timelineEvents = [];
    const cutoverTimelineIndex = createPullRequestCutoverTimelineIndex(
      this.state.timeline,
      this.limits.timelineLimit,
    );
    let indexedTimelineEventCount = 0;
    const currentCutoverTimelineIndex = () => {
      while (indexedTimelineEventCount < timelineEvents.length) {
        appendPullRequestCutoverTimelineEvent(
          cutoverTimelineIndex,
          timelineEvents[indexedTimelineEventCount],
        );
        indexedTimelineEventCount += 1;
      }
      return cutoverTimelineIndex;
    };
    const cutoverProofChecks = [];
    const applyCutoverProofPolicy = (activation, checkId) => {
      if (activation.proposalSettlements.length === 0) return activation;
      if (deniedCutoverProofs.has(checkId)) {
        const blockersByItemId = new Map(
          activation.blockers.map((blocker) => [blocker.itemId, blocker]),
        );
        for (const { participant } of activation.proposalSettlements) {
          blockersByItemId.set(participant.itemId, participant);
        }
        return {
          ...activation,
          blockers: [...blockersByItemId.values()],
          proposalSettlements: [],
        };
      }
      cutoverProofChecks.push({
        checkId,
        proofs: activation.proposalSettlements.map(({ proof }) => proof),
      });
      return activation;
    };
    const applyRoleHandoff = (envelope) => {
      const candidate = automaticRoleHandoffCandidate({ items: [...itemsById.values()] }, envelope.event);
      const skipped = { candidate, applied: false };
      if (candidate === null || candidate.proofDigest !== envelope.event.payload.roleHandoffProof) return skipped;
      let target = itemsById.get(candidate.targetItemId);
      const predecessor = itemsById.get(candidate.predecessorItemId);
      // A predecessor marker cannot represent two independent unknown-effect
      // chains. Settle the target's own previous scope before activating it.
      const ownCutover = applyCutoverProofPolicy(inspectPullRequestSourceCutover(target,
        [...itemsById.values()], outboxById, { forceHeadChanged: true,
          timelineIndex: currentCutoverTimelineIndex() }), `role-handoff-own:${envelope.assignment.assignmentId}:${target.itemId}`);
      if (ownCutover.blockers.length !== 0) return skipped;
      const activation = applyPullRequestScopeLifecycle(target.source, envelope, { attemptAtActivation: target.attempt });
      if (!activation.authorityChanged || !activation.source.scope.active) return skipped;
      target = applyReadyPullRequestSourceCutover({ root: target, activation: ownCutover,
        itemsById, outboxById, nextInputRevision: activation.source.activeRevision,
        nextHeadRevision: activation.source.headRevision, now, timelineEvents });
      target = { ...target, source: activation.source, inputDigest: activation.source.current.inputDigest };
      const cutover = applyCutoverProofPolicy(inspectPullRequestSourceCutover(predecessor,
        [...itemsById.values()], outboxById, { forceHeadChanged: true, replacementRoot: target,
          timelineIndex: currentCutoverTimelineIndex() }), `role-handoff:${envelope.assignment.assignmentId}:${predecessor.itemId}:${target.itemId}`);
      if (cutover.blockers.length === 0) {
        const settled = applyReadyPullRequestSourceCutover({ root: predecessor,
          activation: crossRootPullRequestCutoverActivation(predecessor, cutover), itemsById, outboxById,
          nextInputRevision: target.source.activeRevision, nextHeadRevision: target.source.headRevision, now, timelineEvents });
        const retired = retirePredecessorInBatch(predecessor, settled);
        itemsById.set(retired.itemId, retired);
        rootByWorkKey.set(retired.source.workKey, retired);
        target.status = "queued";
        target.statusReason = "pr_source_role_handoff";
      } else {
        target.status = "blocked";
        target.statusReason = crossRootPullRequestCutoverPendingReason(predecessor.itemId);
        for (const blocker of cutover.blockers) {
          if (blocker.status === "cancelled") continue;
          const marked = { ...blocker, revision: initialItemIds.has(blocker.itemId) && !revisedItemIds.has(blocker.itemId)
            ? blocker.revision + 1 : blocker.revision,
            statusReason: crossRootPullRequestCutoverBlockerReason(target.itemId), updatedAt: now };
          revisedItemIds.add(marked.itemId);
          itemsById.set(marked.itemId, marked);
          if (marked.source?.kind === "pull_request") rootByWorkKey.set(marked.source.workKey, marked);
        }
      }
      target = { ...target, revision: initialItemIds.has(target.itemId) && !revisedItemIds.has(target.itemId)
        ? target.revision + 1 : target.revision, ownerId: null, leaseId: null, leaseUntil: null,
        activeIntentId: null, decisionContext: null, availableAt: null, updatedAt: now };
      revisedItemIds.add(target.itemId);
      itemsById.set(target.itemId, target);
      rootByWorkKey.set(target.source.workKey, target);
      touchedItemIds.add(target.itemId);
      return { candidate, applied: true };
    };
    let received = 0;
    let deduplicated = 0;
    const ignoreProtectedPullRequestReentry = (root, envelope, assignmentItem, disposition, recordAssignment = true) => {
      if (recordAssignment) {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
      }
      timelineEvents.push({
        itemId: root.itemId,
        type: "pr_source_ignored",
        at: now,
        actorId: "work-ledger-system",
        details: {
          workKey: root.source.workKey,
          sourceSequence: envelope.sequence,
          assignmentId: assignmentItem.assignmentId,
          eventId: envelope.event.eventId,
          eventDigest: envelope.event.contentDigest,
          inputDigest: assignmentItem.inputDigest,
          disposition,
          observedHeadRefOid: envelope.event.payload.headRefOid,
          scopeActive: root.source.scope.active,
        },
      });
    };
    const latestIssueAssignmentByTarget = new Map();
    const latestIssueLifecycleBySubject = new Map();
    for (const envelope of batch.items) {
      if (!envelope.event.eventType.startsWith("issue.")) continue;
      const subjectKey = issueSubjectIdentityKey(envelope.event);
      if (subjectKey === null) continue;
      if (isIssueScopeLifecycleEvent(envelope.event)) {
        latestIssueLifecycleBySubject.set(subjectKey, envelope.sequence);
        continue;
      }
      const targetKey = issueAssignmentTargetKey(
        envelope.event,
        envelope.assignment.target,
      );
      if (targetKey !== null) {
        latestIssueAssignmentByTarget.set(targetKey, envelope.sequence);
      }
    }
    for (const envelope of batch.items) {
      const assignmentItem = createAssignmentWorkItem(envelope, now);
      const existing = knownAssignments.get(assignmentItem.assignmentId);
      if (existing) {
        if (
          existing.inputDigest !== assignmentItem.inputDigest ||
          existing.sourceSequence !== assignmentItem.sourceSequence
        ) {
          throw workLedgerError(
            "WORK_LEDGER_ASSIGNMENT_CONFLICT",
            "相同 assignmentId 对应了不同输入，拒绝推进游标",
            409,
          );
        }
        if (scopeRecoveryRoots === null) {
          deduplicated += 1;
          continue;
        }
      }
      const cancelledSourceDescriptor = pullRequestWorkDescriptor(envelope);
      const cancelledSourceRoot = cancelledSourceDescriptor === null ? null :
        rootByWorkKey.get(cancelledSourceDescriptor.workKey);
      if (cancelledSourceRoot?.status === "cancelled" && !cancelledSourceDescriptor.trustedLifecycle) {
        // Keep owner cancellation final without rejecting the rest of the batch.
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        timelineEvents.push({
          itemId: cancelledSourceRoot.itemId,
          type: "pr_source_ignored",
          at: now,
          actorId: "work-ledger-system",
          details: {
            workKey: cancelledSourceRoot.source.workKey,
            sourceSequence: envelope.sequence,
            disposition: "ignored_cancelled_source",
          },
        });
        continue;
      }
      const trustedScopeLifecycle =
        isTrustedPullRequestScopeLifecycleAssignment(
          envelope.assignment,
          envelope.event,
        );
      if (envelope.event.eventType === "pull_request.role_handoff" && !trustedScopeLifecycle) {
        knownAssignments.set(assignmentItem.assignmentId, { inputDigest: assignmentItem.inputDigest, sourceSequence: assignmentItem.sourceSequence });
        received += 1;
        continue;
      }
      if (trustedScopeLifecycle) {
        if (envelope.event.eventType === "pull_request.role_handoff") {
          const { candidate, applied } = applyRoleHandoff(envelope);
          timelineEvents.push({ itemId: candidate?.targetItemId ?? null,
            type: applied ? "pr_source_revised" : "pr_source_ignored", at: now, actorId: "work-ledger-system",
            details: { sourceSequence: envelope.sequence, disposition: applied ? "role_handoff_applied" : "ignored_stale_role_handoff" } });
          knownAssignments.set(assignmentItem.assignmentId, { inputDigest: assignmentItem.inputDigest, sourceSequence: assignmentItem.sourceSequence });
          received += 1;
          continue;
        }
        const lifecycleActive = envelope.event.eventType === "pull_request.created";
        const lifecycleTargetRole = lifecycleActive ? pullRequestScopeLifecycleTargetRole(envelope) : null;
        const routedWorkKeys = new Set(batch.items
          .filter(candidate => candidate.event.eventId === envelope.event.eventId)
          .map(candidate => pullRequestWorkDescriptor(candidate))
          .filter(descriptor => descriptor !== null && !descriptor.trustedLifecycle)
          .map(descriptor => descriptor.workKey));
        for (let root of pullRequestRootsForLifecycle(itemsById, envelope)) {
          if (scopeRecoveryRoots !== null &&
              (scopeRecoveryRoots.get(root.itemId) !== envelope.sequence || !root.source.scope.active ||
                envelope.sequence <= root.source.bindings.at(-1).sourceSequence)) continue;
          if (root.status === "cancelled") {
            timelineEvents.push({ itemId: root.itemId, type: "pr_source_ignored", at: now,
              actorId: "work-ledger-system", details: { workKey: root.source.workKey,
                sourceSequence: envelope.sequence, disposition: "ignored_cancelled_source" } });
            continue;
          }
          const ordinaryRouteForLifecycle = routedWorkKeys.has(root.source.workKey) ||
            (lifecycleActive && root.source.current.eventId === envelope.event.eventId &&
              root.source.bindings.some(binding => binding.eventId === envelope.event.eventId && binding.scopeLifecycle !== true));
          if (lifecycleActive && root.source.identity.targetRoleId !== lifecycleTargetRole) continue;
          if (
            root?.status === "superseded" &&
            root.statusReason === CROSS_ROOT_REPLACED_REASON &&
            envelope.event.eventType === "pull_request.left_scope"
          ) {
            timelineEvents.push({
              itemId: root.itemId,
              type: "pr_source_ignored",
              at: now,
              actorId: "work-ledger-system",
              details: {
                workKey: root.source.workKey,
                sourceSequence: envelope.sequence,
                disposition: "ignored_superseded_scope_exit",
                scopeActive: root.source.scope.active,
              },
            });
            continue;
          }
          if (root.source.scope.active === lifecycleActive) {
            timelineEvents.push({
              itemId: root.itemId,
              type: "pr_source_ignored",
              at: now,
              actorId: "work-ledger-system",
              details: {
                workKey: root.source.workKey,
                sourceSequence: envelope.sequence,
                disposition: "ignored_redundant_scope_lifecycle",
                scopeActive: root.source.scope.active,
              },
            });
            continue;
          }
          const previousActiveRevision = root.source.activeRevision;
          const previousActiveHeadRefOid = root.source.current.headRefOid;
          const previousAttempt = root.attempt;
          let applied = applyPullRequestScopeLifecycle(root.source, envelope, { attemptAtActivation: previousAttempt });
          if (isIgnoredProtectedPullRequestReentry(root, envelope, applied)) {
            ignoreProtectedPullRequestReentry(root, envelope, assignmentItem, applied.disposition, false);
            continue;
          }
          const active = applied.source.scope.active;
          let cutover = inspectPullRequestSourceCutover(
            root,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          cutover = applyCutoverProofPolicy(
            cutover,
            `lifecycle:${envelope.assignment.assignmentId}:${root.itemId}`,
          );
          if (cutover.blockers.length > 0 && root.source.pending !== null &&
              root.source.revisions.some(revision => revision.headAncestryProof !== undefined &&
                revision.headRefOid === root.source.pending.headRefOid)) {
            // The lineage witness proves a target, never execution settlement.
            // Reentry may record responsibility while the old input remains
            // current and the new target waits behind the existing cutover.
            applied = applyPullRequestScopeLifecycle(root.source, envelope, { attemptAtActivation: previousAttempt, activate: false });
          }
          if (cutover.blockers.length === 0) {
            root = applyReadyPullRequestSourceCutover({
              root,
              activation: cutover,
              itemsById,
              outboxById,
              nextInputRevision: applied.source.activeRevision,
              nextHeadRevision: applied.source.headRevision,
              now,
              timelineEvents,
            });
          }
          const firstRevisionInBatch =
            initialItemIds.has(root.itemId) &&
            !revisedItemIds.has(root.itemId);
          const settlementPending = cutover.blockers.length > 0;
          root = {
            ...root,
            source: applied.source,
            inputDigest: applied.source.current.inputDigest,
            ...(firstRevisionInBatch
              ? { revision: root.revision + 1 }
              : {}),
            ...(settlementPending
              ? {
                  statusReason: active
                    ? "pr_source_reentered_scope_pending_settlement"
                    : "pr_source_left_scope_pending_settlement",
                }
              : {
                  status: active && ordinaryRouteForLifecycle
                    ? "queued"
                    : "blocked",
                  ownerId: null,
                  leaseId: null,
                  leaseUntil: null,
                  activeIntentId: null,
                  decisionContext: null,
                  availableAt: null,
                  statusReason: active
                    ? ordinaryRouteForLifecycle
                      ? "pr_source_reentered_scope"
                      : "pr_source_reentered_scope_without_route"
                    : "pr_source_left_scope",
                }),
            updatedAt: now,
          };
          if (firstRevisionInBatch) revisedItemIds.add(root.itemId);
          rootByWorkKey.set(root.source.workKey, root);
          itemsById.set(root.itemId, root);
          touchedItemIds.add(root.itemId);
          timelineEvents.push({
            itemId: root.itemId,
            type: "pr_source_revised",
            at: now,
            actorId: "work-ledger-system",
            details: {
              workKey: root.source.workKey,
              sourceSequence: envelope.sequence,
              inputRevision: root.source.inputRevision,
              activeRevision: root.source.activeRevision,
              pendingRevision: root.source.pendingRevision,
              headRevision: root.source.headRevision,
              headRefOid: root.source.current.headRefOid,
              disposition: applied.disposition,
              scopeActive: active,
              authorityEpoch: root.source.authorityEpoch,
              ...(previousActiveHeadRefOid !== root.source.current.headRefOid ? {
                previousHeadRefOid: previousActiveHeadRefOid,
                previousActiveRevision,
                decisionAttemptOffset: previousAttempt,
              } : {}),
            },
          });
        }
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      if (isIssueScopeLifecycleEvent(envelope.event)) {
        for (const itemId of settleIssueScope({
          event: envelope.event,
          sourceSequence: envelope.sequence,
          itemsById,
          outboxById,
          now,
          timelineEvents,
          issueIndex: issueSettlementIndex,
        })) {
          touchedItemIds.add(itemId);
        }
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      if (envelope.event.eventType === "pull_request.left_scope") {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      const issueSubjectKey = issueSubjectIdentityKey(envelope.event);
      const issueTargetKey = issueAssignmentTargetKey(
        envelope.event,
        assignmentItem.currentTarget,
      );
      if (
        issueSubjectKey !== null &&
        ((latestIssueAssignmentByTarget.get(issueTargetKey) ?? 0) >
            envelope.sequence ||
          (latestIssueLifecycleBySubject.get(issueSubjectKey) ?? 0) >
            envelope.sequence)
      ) {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        received += 1;
        continue;
      }
      for (const itemId of settleSupersededIssueAssignments({
        event: envelope.event,
        sourceSequence: envelope.sequence,
        target: assignmentItem.currentTarget,
        itemsById,
        outboxById,
        now,
        timelineEvents,
        issueIndex: issueSettlementIndex,
      })) {
        touchedItemIds.add(itemId);
      }
      const rootCandidate = createPullRequestSourceRootWorkItem(envelope, now);
      if (rootCandidate === null) {
        knownAssignments.set(assignmentItem.assignmentId, {
          inputDigest: assignmentItem.inputDigest,
          sourceSequence: assignmentItem.sourceSequence,
        });
        itemsById.set(assignmentItem.itemId, assignmentItem);
        indexIssueSettlementItem(issueSettlementIndex, assignmentItem);
        touchedItemIds.add(assignmentItem.itemId);
        received += 1;
        timelineEvents.push({
          itemId: assignmentItem.itemId,
          type: "assignment_intaken",
          at: now,
          actorId: "work-ledger-system",
          details: {
            assignmentId: assignmentItem.assignmentId,
            sourceSequence: assignmentItem.sourceSequence,
            inputDigest: assignmentItem.inputDigest,
            kind: assignmentItem.kind,
          },
        });
        continue;
      }

      let root = rootByWorkKey.get(rootCandidate.source.workKey);
      let disposition = "accepted";
      let headAdvanced = false;
      if (!root) {
        if (Object.hasOwn(envelope.event.payload, "headAncestryProof")) {
          knownAssignments.set(assignmentItem.assignmentId, { inputDigest: assignmentItem.inputDigest, sourceSequence: envelope.sequence });
          received += 1;
          continue;
        }
        const pendingCrossRoot = [...itemsById.values()].find(
          (item) =>
            item.itemId !== rootCandidate.itemId &&
            samePullRequestSubject(item, rootCandidate) &&
            crossRootPullRequestCutoverPredecessorId(item) !== null,
        );
        const priorAuthority = pullRequestTrustedPredecessor(
          { items: [...itemsById.values()] },
          rootCandidate,
        );
        const predecessorItemId = pendingCrossRoot === undefined
          ? priorAuthority?.canonicalRootItemId ??
            priorAuthority?.lastTrustedRootItemId ?? null
          : crossRootPullRequestCutoverPredecessorId(pendingCrossRoot);
        const predecessor = predecessorItemId === null
          ? null
          : itemsById.get(predecessorItemId) ?? null;
        const candidateAuthority = pullRequestTrustedPredecessor(
          { items: [...itemsById.values(), rootCandidate] },
          rootCandidate,
        );
        const candidateIsAuthoritative =
          candidateAuthority?.canonicalRootItemId === rootCandidate.itemId;
        const candidateFencesAuthority =
          candidateAuthority?.canonicalRootItemId === null &&
          candidateAuthority.authorityFenced === true &&
          candidateAuthority.lastTrustedRootItemId === predecessor?.itemId;
        if (
          predecessor !== null &&
          samePullRequestSubject(predecessor, rootCandidate) &&
          (candidateIsAuthoritative || candidateFencesAuthority)
        ) {
          let activation = inspectPullRequestSourceCutover(
            predecessor,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              replacementRoot: rootCandidate,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          activation = applyCutoverProofPolicy(
            activation,
            `new-root:${envelope.assignment.assignmentId}:${predecessor.itemId}:${rootCandidate.itemId}`,
          );
          if (activation.blockers.length > 0) {
            rootCandidate.status = "blocked";
            rootCandidate.statusReason =
              crossRootPullRequestCutoverPendingReason(predecessor.itemId);
            for (const blocker of activation.blockers) {
              if (blocker.status === "cancelled") continue;
              const marked = {
                ...blocker,
                revision:
                  initialItemIds.has(blocker.itemId) &&
                    !revisedItemIds.has(blocker.itemId)
                    ? blocker.revision + 1
                    : blocker.revision,
                statusReason: crossRootPullRequestCutoverBlockerReason(
                  rootCandidate.itemId,
                ),
                updatedAt: now,
              };
              if (initialItemIds.has(marked.itemId)) {
                revisedItemIds.add(marked.itemId);
              }
              itemsById.set(marked.itemId, marked);
              if (marked.source?.kind === "pull_request") {
                rootByWorkKey.set(marked.source.workKey, marked);
              }
            }
          } else if (candidateIsAuthoritative) {
            const locallySettled = applyReadyPullRequestSourceCutover({
              root: predecessor,
              activation: crossRootPullRequestCutoverActivation(
                predecessor,
                activation,
              ),
              itemsById,
              outboxById,
              nextInputRevision: rootCandidate.source.activeRevision,
              nextHeadRevision: rootCandidate.source.headRevision,
              now,
              timelineEvents,
            });
            const settled = retirePredecessorInBatch(predecessor, locallySettled);
            itemsById.set(settled.itemId, settled);
            rootByWorkKey.set(settled.source.workKey, settled);
          }
        } else if (
          predecessorItemId !== null &&
          (predecessor === null ||
            !samePullRequestSubject(predecessor, rootCandidate))
        ) {
          throw workLedgerError(
            "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
            "跨来源 PR cutover 前驱绑定无效",
            409,
          );
        }
        root = rootCandidate;
        rootByWorkKey.set(root.source.workKey, root);
        itemsById.set(root.itemId, root);
        timelineEvents.push({
          itemId: root.itemId,
          type: "pr_source_created",
          at: now,
          actorId: "work-ledger-system",
          details: {
            workKey: root.source.workKey,
            sourceSequence: envelope.sequence,
            inputRevision: 1,
            headRevision: 1,
            headRefOid: root.source.current.headRefOid,
          },
        });
      } else {
        const previousActiveHeadRefOid = root.source.current.headRefOid;
        if (Object.hasOwn(envelope.event.payload, "headAncestryProof") &&
            (root.revision !== root.source.headAncestryReceipt?.rootRevision + 1 ||
              !ownsHeadAncestryPredecessor({ items: [...itemsById.values()] }, root) ||
              !headAncestrySourceMatches(root.source.headAncestryReceipt, root.source, envelope.event))) {
          knownAssignments.set(assignmentItem.assignmentId, { inputDigest: assignmentItem.inputDigest, sourceSequence: envelope.sequence });
          received += 1;
          continue;
        }
        const previousActiveRevision = root.source.activeRevision;
        const previousAttempt = root.attempt;
        const predecessor = pullRequestTrustedPredecessor(
          { items: [...itemsById.values()] },
          root,
        );
        const crossRootPredecessor = operationalPullRequestPredecessor(
          itemsById,
          root,
          predecessor,
          envelope.event,
        );
        let appended = appendPullRequestWorkSource(
          root.source,
          envelope,
          {
            activate: false,
            ...(predecessor === null
              ? {}
              : { causalHeadRefOid: predecessor.headRefOid }),
            authorityEpochChanged:
              predecessor?.canonicalRootItemId !== root.itemId,
            authorityFenceRecovery:
              predecessor?.authorityFenced === true &&
              predecessor.trustedSourceRootItemId === root.itemId,
          },
        );
        if (isIgnoredProtectedPullRequestReentry(root, envelope, appended)) {
          ignoreProtectedPullRequestReentry(root, envelope, assignmentItem, appended.disposition);
          continue;
        }
        if (
          PR_SOURCE_AUTHORITY_FENCE_DISPOSITIONS.has(
            appended.disposition,
          ) &&
          crossRootPredecessor !== null
        ) {
          const currentPredecessor = itemsById.get(
            crossRootPredecessor.itemId,
          );
          let activation = inspectPullRequestSourceCutover(
            currentPredecessor,
            [...itemsById.values()],
            outboxById,
            {
              forceHeadChanged: true,
              replacementRoot: root,
              timelineIndex: currentCutoverTimelineIndex(),
            },
          );
          activation = applyCutoverProofPolicy(
            activation,
            `authority-fence:${envelope.assignment.assignmentId}:${currentPredecessor.itemId}:${root.itemId}`,
          );
          if (activation.blockers.length > 0) {
            root = {
              ...root,
              source: appended.source,
              status: "blocked",
              ownerId: null,
              leaseId: null,
              leaseUntil: null,
              activeIntentId: null,
              decisionContext: null,
              availableAt: null,
              statusReason: crossRootPullRequestCutoverPendingReason(
                currentPredecessor.itemId,
              ),
            };
            for (const blocker of activation.blockers) {
              if (blocker.status === "cancelled") continue;
              const marked = {
                ...blocker,
                revision:
                  initialItemIds.has(blocker.itemId) &&
                    !revisedItemIds.has(blocker.itemId)
                    ? blocker.revision + 1
                    : blocker.revision,
                statusReason: crossRootPullRequestCutoverBlockerReason(
                  root.itemId,
                ),
                updatedAt: now,
              };
              if (initialItemIds.has(marked.itemId)) {
                revisedItemIds.add(marked.itemId);
              }
              itemsById.set(marked.itemId, marked);
              if (marked.source?.kind === "pull_request") {
                rootByWorkKey.set(marked.source.workKey, marked);
              }
            }
          }
        }
        if (appended.disposition === "accepted") {
          const obsoletePendingRoots = [...itemsById.values()].filter(
            (candidate) =>
              appended.source.scope.active === true &&
              candidate.itemId !== root.itemId &&
              samePullRequestSubject(candidate, root) &&
              crossRootPullRequestCutoverPredecessorId(candidate) !== null &&
              crossRootPullRequestCutoverCandidate(candidate).sourceSequence <
                envelope.sequence,
          );
          for (const obsolete of obsoletePendingRoots) {
            const persisted = initialItemIds.has(obsolete.itemId);
            const replaced = {
              ...obsolete,
              status: persisted ? "superseded" : "blocked",
              revision:
                persisted && !revisedItemIds.has(obsolete.itemId)
                  ? obsolete.revision + 1
                  : obsolete.revision,
              ownerId: null,
              leaseId: null,
              leaseUntil: null,
              activeIntentId: null,
              availableAt: null,
              statusReason: "pr_source_cross_root_cutover_replaced",
              updatedAt: now,
            };
            if (persisted) revisedItemIds.add(replaced.itemId);
            itemsById.set(replaced.itemId, replaced);
            rootByWorkKey.set(replaced.source.workKey, replaced);
            for (const participant of itemsById.values()) {
              if (
                crossRootPullRequestCutoverPendingId(participant) !==
                  obsolete.itemId
              ) {
                continue;
              }
              const participantPersisted = initialItemIds.has(
                participant.itemId,
              );
              const cleared = {
                ...participant,
                revision:
                  participantPersisted &&
                    !revisedItemIds.has(participant.itemId)
                    ? participant.revision + 1
                    : participant.revision,
                statusReason: "pr_source_revised",
                updatedAt: now,
              };
              if (participantPersisted) revisedItemIds.add(cleared.itemId);
              itemsById.set(cleared.itemId, cleared);
              if (cleared.source?.kind === "pull_request") {
                rootByWorkKey.set(cleared.source.workKey, cleared);
              }
              if (cleared.itemId === root.itemId) root = cleared;
            }
          }
          const pendingRoot = { ...root, source: appended.source };
          if (crossRootPredecessor !== null) {
            const pendingRevision = appended.source.pendingRevision;
            const pendingHeadRevision = appended.source.revisions[
              pendingRevision - 1
            ].headRevision;
            const currentPredecessor = itemsById.get(
              crossRootPredecessor.itemId,
            );
            let activation = inspectPullRequestSourceCutover(
              currentPredecessor,
              [...itemsById.values()],
              outboxById,
              {
                forceHeadChanged: true,
                replacementRoot: pendingRoot,
                timelineIndex: currentCutoverTimelineIndex(),
              },
            );
            activation = applyCutoverProofPolicy(
              activation,
              `existing-root:${envelope.assignment.assignmentId}:${currentPredecessor.itemId}:${root.itemId}`,
            );
            if (activation.blockers.length > 0) {
              root = {
                ...pendingRoot,
                status: "blocked",
                ownerId: null,
                leaseId: null,
                leaseUntil: null,
                activeIntentId: null,
                decisionContext: null,
                availableAt: null,
                statusReason: crossRootPullRequestCutoverPendingReason(
                  currentPredecessor.itemId,
                ),
              };
              for (const blocker of activation.blockers) {
                if (blocker.status === "cancelled") continue;
                const marked = {
                  ...blocker,
                  revision:
                    initialItemIds.has(blocker.itemId) &&
                      !revisedItemIds.has(blocker.itemId)
                      ? blocker.revision + 1
                      : blocker.revision,
                  statusReason: crossRootPullRequestCutoverBlockerReason(
                    root.itemId,
                  ),
                  updatedAt: now,
                };
                if (initialItemIds.has(marked.itemId)) {
                  revisedItemIds.add(marked.itemId);
                }
                itemsById.set(marked.itemId, marked);
                if (marked.source?.kind === "pull_request") {
                  rootByWorkKey.set(marked.source.workKey, marked);
                }
              }
            } else {
              const locallySettled = applyReadyPullRequestSourceCutover({
                root: currentPredecessor,
                activation: crossRootPullRequestCutoverActivation(
                  currentPredecessor,
                  activation,
                ),
                itemsById,
                outboxById,
                nextInputRevision: pendingRevision,
                nextHeadRevision: pendingHeadRevision,
                now,
                timelineEvents,
              });
              const settled = retirePredecessorInBatch(currentPredecessor, locallySettled);
              itemsById.set(settled.itemId, settled);
              rootByWorkKey.set(settled.source.workKey, settled);
              const activated = activatePendingPullRequestWorkSource(
                appended.source,
                { attemptAtActivation: root.attempt },
              );
              appended = {
                ...appended,
                source: activated.source,
                activeAdvanced: true,
              };
            }
          } else {
            let activation = inspectPullRequestSourceCutover(
              pendingRoot,
              [...itemsById.values()],
              outboxById,
              { timelineIndex: currentCutoverTimelineIndex() },
            );
            activation = applyCutoverProofPolicy(
              activation,
              `same-root:${envelope.assignment.assignmentId}:${pendingRoot.itemId}`,
            );
            if (activation.blockers.length === 0) {
              const pendingRevision = appended.source.pendingRevision;
              const pendingHeadRevision = appended.source.revisions[
                pendingRevision - 1
              ].headRevision;
              root = applyReadyPullRequestSourceCutover({
                root,
                activation,
                itemsById,
                outboxById,
                nextInputRevision: pendingRevision,
                nextHeadRevision: pendingHeadRevision,
                now,
                timelineEvents,
              });
              const activated = activatePendingPullRequestWorkSource(
                appended.source,
                { attemptAtActivation: root.attempt },
              );
              appended = {
                ...appended,
                source: activated.source,
                activeAdvanced: true,
              };
            }
          }
        }
        disposition = appended.disposition;
        headAdvanced = appended.headAdvanced === true;
        const restoresLifecycleRoute =
          appended.disposition === "bound_existing_event" &&
          envelope.event.eventType === "pull_request.created" &&
          root.source.scope.active === true &&
          root.statusReason === "pr_source_reentered_scope_without_route";
        const firstRevisionInBatch =
          initialItemIds.has(root.itemId) && !revisedItemIds.has(root.itemId);
        const retireInactiveCompleted = root.status === "completed" &&
          root.source.scope.kind === "automatic" && root.source.scope.active === false &&
          appended.source.scope.active === false && appended.activeAdvanced;
        root = {
          ...root,
          source: appended.source,
          inputDigest: appended.source.current.inputDigest,
          ...(firstRevisionInBatch
            ? { revision: root.revision + 1 }
            : {}),
          ...((appended.activeAdvanced &&
              canRequeueAdvancedPullRequestRoot(root, appended.source)) ||
            restoresLifecycleRoute
            ? {
                status: "queued",
                ownerId: null,
                leaseId: null,
                leaseUntil: null,
                availableAt: null,
                statusReason: restoresLifecycleRoute
                  ? "pr_source_reentered_scope"
                  : "pr_source_revised",
              }
            : {}),
          ...fencedPullRequestRootPatch(root, appended.disposition),
          ...(retireInactiveCompleted ? {
            status: "blocked", statusReason: "pr_source_left_scope",
            ownerId: null, leaseId: null, leaseUntil: null, activeIntentId: null,
            availableAt: null, decisionContext: null,
          } : {}),
          updatedAt: now,
        };
        revisedItemIds.add(root.itemId);
        rootByWorkKey.set(root.source.workKey, root);
        itemsById.set(root.itemId, root);
        const currentHeadRevision = root.source.revisions[
          root.source.activeRevision - 1
        ].headRevision;
        const pendingHeadRevision = root.source.pendingRevision === null
          ? null
          : root.source.revisions[root.source.pendingRevision - 1].headRevision;
        timelineEvents.push({
          itemId: root.itemId,
          type: disposition.startsWith("ignored_")
            ? "pr_source_ignored"
            : "pr_source_revised",
          at: now,
          actorId: "work-ledger-system",
          details: {
            workKey: root.source.workKey,
            sourceSequence: envelope.sequence,
            inputRevision: root.source.inputRevision,
            activeRevision: root.source.activeRevision,
            pendingRevision: root.source.pendingRevision,
            headRevision: currentHeadRevision,
            headRefOid: root.source.current.headRefOid,
            currentHeadRevision,
            currentHeadRefOid: root.source.current.headRefOid,
            pendingHeadRevision,
            pendingHeadRefOid: root.source.pending?.headRefOid ?? null,
            observedHeadRevision: root.source.headRevision,
            observedHeadRefOid: (root.source.pending ?? root.source.current)
              .headRefOid,
            disposition,
            headAdvanced,
            ...(appended.activeAdvanced && previousActiveHeadRefOid !== root.source.current.headRefOid ? {
              previousHeadRefOid: previousActiveHeadRefOid,
              previousActiveRevision,
              decisionAttemptOffset: previousAttempt,
            } : {}),
          },
        });
      }
      knownAssignments.set(assignmentItem.assignmentId, {
        inputDigest: assignmentItem.inputDigest,
        sourceSequence: assignmentItem.sourceSequence,
      });
      touchedItemIds.add(root.itemId);
      received += 1;
    }
    timelineEvents.push({
      itemId: null,
      type: "intake_completed",
      at: now,
      actorId: "work-ledger-system",
      details: {
        afterSequence: this.state.intakeCursor,
        nextSequence: batch.nextSequence,
        highWatermark: batch.highWatermark,
        received,
        deduplicated,
      },
    });
    let nextState = this.#candidateWithTimeline(
      { ...this.state, revision: this.state.revision + 1,
        intakeCursor: batch.nextSequence, sourceHighWatermark: batch.highWatermark,
        items: [...itemsById.values()], outbox: [...outboxById.values()] },
      timelineEvents,
    );
    if (cutoverProofChecks.length > 0) {
      nextState = retainWorkLedgerTimelineForCapacity(this.state, nextState, this.limits);
    }
    const retainedProofIds = new Set(nextState.timeline.map(entry => entry.timelineId));
    const invalidCutoverProofs = cutoverProofChecks.filter(({ proofs }) =>
      !arePullRequestCutoverProofsRetained({ timeline: this.state.timeline,
        timelineLimit: this.limits.timelineLimit, appendedEventCount: timelineEvents.length, proofs }) ||
      proofs.some(proof => !retainedProofIds.has(proof.timelineId)));
    if (invalidCutoverProofs.length > 0) {
      const nextDeniedCutoverProofs = new Set(deniedCutoverProofs);
      for (const { checkId } of invalidCutoverProofs) {
        nextDeniedCutoverProofs.add(checkId);
      }
      if (nextDeniedCutoverProofs.size === deniedCutoverProofs.size) {
        throw workLedgerError(
          "WORK_LEDGER_PR_SOURCE_RECONCILIATION_CONFLICT",
          "PR cutover 证明无法在提交窗口内保持有效",
          409,
        );
      }
      return this.#recordBatch(batch, now, nextDeniedCutoverProofs, scopeRecoveryRoots);
    }
    if (scopeRecoveryRoots === null && batch.items.length > 1 &&
        timelineEvents.length > this.limits.timelineLimit &&
        timelineEvents.slice(0, timelineEvents.length - this.limits.timelineLimit).some(event => {
          if (!["pr_source_revised", "pr_source_activated"].includes(event.type) ||
              event.details?.decisionAttemptOffset === undefined) return false;
          const previous = this.state.items.find(item => item.itemId === event.itemId);
          const next = itemsById.get(event.itemId);
          const budget = next?.source?.decisionBudget;
          return previous?.source?.kind === "pull_request" && budget !== undefined &&
            previous.source.current.headRefOid !== next.source.current.headRefOid &&
            event.details.workKey === next.source.workKey &&
            event.details.activeRevision === budget.activationRevision &&
            event.details.headRefOid === next.source.current.headRefOid &&
            event.details.previousHeadRefOid === previous.source.current.headRefOid &&
            event.details.previousActiveRevision === previous.source.activeRevision &&
            budget.previousActiveRevision === previous.source.activeRevision &&
            event.details.decisionAttemptOffset === previous.attempt &&
            budget.attemptOffset === previous.attempt;
        })) {
      // Nothing has been written. Replan a smaller feed prefix so its real
      // activation receipt survives this commit; later intake consumes the rest.
      const items = batch.items.slice(0, Math.floor(batch.items.length / 2));
      return this.#recordBatch({ ...batch, items, nextSequence: items.at(-1).sequence }, now);
    }
    const stateBeforeCommit = this.state;
    try {
      await this.#persist(nextState);
    } catch (error) {
      if (error?.code !== "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID" ||
          scopeRecoveryRoots !== null || batch.items.length < 2 || this.state !== stateBeforeCommit) throw error;
      // The source validator rejected preparation before any write. Commit a
      // valid prefix; retain all remaining feed entries for subsequent intake.
      const items = batch.items.slice(0, Math.floor(batch.items.length / 2));
      return this.#recordBatch({ ...batch, items, nextSequence: items.at(-1).sequence },
        now, deniedCutoverProofs, scopeRecoveryRoots);
    }
    return cloneLedgerValue({
      received,
      deduplicated,
      cursor: this.state.intakeCursor,
      highWatermark: this.state.sourceHighWatermark,
      gap: null,
      itemIds: [...touchedItemIds],
      alertItemId: null,
    });
  }

  #assertSourceHighWatermark(highWatermark) {
    if (highWatermark < this.state.sourceHighWatermark) {
      throw workLedgerError(
        "WORK_LEDGER_SOURCE_ROLLBACK",
        "分派源高水位发生回退，拒绝推进游标",
        409,
      );
    }
  }

  #candidateWithTimeline(candidate, events) {
    const timeline = appendWorkLedgerTimeline(
      this.state,
      events,
      this.limits.timelineLimit,
    );
    return {
      ...candidate,
      timeline: timeline.timeline,
      timelineStartSequence: timeline.timelineStartSequence,
      nextTimelineSequence: timeline.nextTimelineSequence,
    };
  }

  #newLeaseId() {
    try {
      return boundedLedgerString(this.idFactory(), "leaseId", 128);
    } catch (error) {
      throw workLedgerError(
        "WORK_LEDGER_ID_INVALID",
        "租约 ID 生成器返回了无效值",
        500,
        { cause: error },
      );
    }
  }

  #now() {
    try {
      return normalizeLedgerTimestamp(this.clock(), "clock");
    } catch (error) {
      if (error?.code === "WORK_LEDGER_CLOCK_INVALID") throw error;
      throw workLedgerError(
        "WORK_LEDGER_CLOCK_INVALID",
        "工作台账时钟无效",
        500,
        { cause: error },
      );
    }
  }

  async #reconcileRecoveredIssueScopes() {
    const plan = planRecoveredIssueScopeSettlement(this.state, this.#now());
    if (plan === null) return;
    const nextState = this.#candidateWithTimeline(
      {
        ...this.state,
        revision: this.state.revision + 1,
        items: plan.items,
        outbox: plan.outbox,
      },
      plan.timelineEvents,
    );
    await this.#persist(nextState);
  }

  async #reconcileRecoveredPullRequestScopes() {
    const roots = this.state.items.filter(item => item.kind === "source_root" &&
      item.source?.scope.kind === "automatic" && item.source.scope.active &&
      !["paused", "cancelled", "superseded"].includes(item.status));
    const consumedCursor = this.state.intakeCursor;
    if (roots.length === 0 || consumedCursor === 0) {
      this.pullRequestScopeRecoveryPending = false;
      return;
    }
    let afterSequence = Math.min(...roots.map(root => root.source.bindings.at(-1).sourceSequence));
    const latestByRoot = new Map();
    let scanned = 0;
    let started = false;
    // Only a complete retained tail through the consumed cursor can prove
    // that an old exit was not followed by a later discovery reentry.
    while (afterSequence < consumedCursor) {
      if (scanned >= MAX_WORKFLOW_RECORDS) return;
      const limit = Math.min(MAX_WORK_LEDGER_INTAKE_BATCH, consumedCursor - afterSequence,
        MAX_WORKFLOW_RECORDS - scanned);
      let batch;
      try {
        const raw = await this.assignmentSource.readAssignmentBatch({ afterSequence, limit });
        batch = normalizeAssignmentBatch(raw, { afterSequence, requestedLimit: limit,
          itemByteBudget: this.limits.itemByteBudget });
      } catch (error) {
        const gap = normalizeReportedAssignmentGap(error, afterSequence);
        if (!started && gap?.reason === "source_retention" && gap.actualSequence <= consumedCursor) {
          afterSequence = gap.actualSequence - 1;
          started = true;
          continue;
        }
        return;
      }
      if (batch.highWatermark < this.state.sourceHighWatermark) return;
      const gap = findAssignmentBatchGap(batch, afterSequence);
      if (gap) {
        if (!started && gap.reason === "source_retention" && gap.actualSequence <= consumedCursor) {
          afterSequence = gap.actualSequence - 1;
          started = true;
          continue;
        }
        return;
      }
      started = true;
      scanned += batch.items.length;
      for (const envelope of batch.items) {
        if (!isTrustedPullRequestScopeLifecycleAssignment(envelope.assignment, envelope.event)) continue;
        for (const root of roots) {
          if (envelope.sequence > root.source.bindings.at(-1).sourceSequence &&
              pullRequestScopeLifecycleMatchesSource(root.source, envelope)) {
            latestByRoot.set(root.itemId, envelope);
          }
        }
      }
      afterSequence = batch.nextSequence;
    }
    const exits = [...new Map([...latestByRoot.values()]
      .filter(envelope => envelope.event.eventType === "pull_request.left_scope")
      .map(envelope => [envelope.sequence, envelope])).values()]
      .sort((left, right) => left.sequence - right.sequence);
    if (exits.length > 0) {
      await this.#recordBatch({ items: exits, nextSequence: consumedCursor,
        highWatermark: this.state.sourceHighWatermark }, this.#now(), new Set(),
      new Map([...latestByRoot].map(([itemId, envelope]) => [itemId, envelope.sequence])));
    }
    this.pullRequestScopeRecoveryPending = false;
  }

  async #recoverInactivePullRequestTakeovers() {
    let items = this.state.items;
    const timelineEvents = [];
    const now = this.#now();
    for (const item of this.state.items) {
      const proof = inactivePullRequestTakeoverRecoveryProof(this.state, item) ??
        sameHeadInternalReviewTakeoverRecoveryProof({ ...this.state, items }, item);
      if (proof === null) continue;
      const transition = planWorkItemTransition({
        state: { ...this.state, items },
        input: {
          itemId: item.itemId,
          expectedRevision: item.revision,
          leaseId: null,
          actorId: "work-ledger-system",
          toStatus: "queued",
          reason: proof.reason ?? "pr_source_inactive_takeover_recovered",
          details: { evidenceRefs: [proof.timelineId, proof.rootStateTimelineId, proof.replacementRootItemId ?? proof.inactiveRootItemId] },
        },
        clock: () => now,
      });
      items = transition.patch.items;
      timelineEvents.push(...transition.timelineEvents);
    }
    if (timelineEvents.length === 0) return;
    await this.#commitMutation({ patch: { items }, timelineEvents, result: null });
  }

  async #recoverCompletedRepairEvidence() {
    const now = this.#now();
    const timelineEvents = [];
    const items = this.state.items.map(item => {
      const proof = completedRepairEvidenceRecoveryProof(this.state, item);
      if (proof === null) return item;
      timelineEvents.push({ itemId: item.itemId, type: "transitioned", at: now, actorId: "work-ledger-system",
        details: { fromStatus: "completed", toStatus: "queued", reason: proof.reason,
          context: { evidenceRefs: [proof.intentId, proof.resultId] } } });
      return { ...item, status: "queued", statusReason: proof.reason,
        revision: item.revision + 1, updatedAt: now };
    });
    if (timelineEvents.length > 0) await this.#commitMutation({ patch: { items }, timelineEvents, result: null });
  }

  async #reconcileRecoveredPullRequestAuthorityFences() {
    const now = this.#now();
    const rootsBySubject = new Map();
    for (const item of this.state.items) {
      if (item?.kind !== "source_root" || item.source?.kind !== "pull_request") {
        continue;
      }
      const identity = item.source.identity;
      const subjectKey = JSON.stringify([
        identity.subjectId,
        identity.repository,
        identity.pullRequestNumber,
      ]);
      const roots = rootsBySubject.get(subjectKey) ?? [];
      roots.push(item);
      rootsBySubject.set(subjectKey, roots);
    }

    const fencedItems = [];
    for (const roots of rootsBySubject.values()) {
      const subjectState = { ...this.state, items: roots };
      for (const item of roots) {
        if (!PR_SOURCE_AUTHORITY_FENCE_SAFE_STATUSES.has(item.status)) {
          continue;
        }
        const admission = pullRequestHeadAdmission(subjectState, item);
        if (!admission.applies || admission.current || admission.pending) {
          continue;
        }
        fencedItems.push(item);
      }
    }
    if (fencedItems.length === 0) return;

    let items = this.state.items;
    const timelineEvents = [];
    for (const item of fencedItems) {
      const transition = planWorkItemTransition({
        state: { ...this.state, items },
        input: {
          itemId: item.itemId,
          expectedRevision: item.revision,
          actorId: "work-ledger-system",
          toStatus: "blocked",
          reason: PR_SOURCE_AUTHORITY_FENCED_REASON,
          details: { code: "WORK_LEDGER_PR_SOURCE_CUTOVER_PENDING" },
        },
        clock: () => now,
      });
      items = transition.patch.items;
      timelineEvents.push(...transition.timelineEvents);
    }
    await this.#commitMutation({
      patch: { items },
      timelineEvents,
      result: null,
    });
  }

  async #persist(candidate, { appendGraphMemory = true } = {}) {
    if (candidate.revision !== this.state.revision + 1) {
      throw workLedgerError(
        "WORK_LEDGER_STATE_REVISION_CONFLICT",
        "员工工作台账 revision 冲突",
        409,
      );
    }
    const normalized = await this.candidateProcessor.prepare({
      previousState: this.state,
      candidate,
      limits: this.limits,
      appendGraphMemory,
    });
    try {
      const writtenVersion = await this.store.write(
        WORK_LEDGER_STATE_KEY,
        normalized,
      );
      this.durableContentVersion =
        typeof this.store.readVersioned === "function" &&
        isContentVersion(writtenVersion)
          ? writtenVersion
          : undefined;
      this.committedAuthoritySnapshot = {
        version: this.durableContentVersion, state: normalized,
      };
    } catch (error) {
      await this.#discardPreparedCandidate();
      throw workLedgerError(
        "WORK_LEDGER_STATE_WRITE_FAILED",
        "无法持久化员工工作台账",
        503,
        { cause: error },
      );
    }
    this.state = normalized;
    await this.#commitPreparedCandidate();
    await this.#yieldAfterCommit();
  }

  async #discardPreparedCandidate() {
    try {
      await this.candidateProcessor.discard();
    } catch {
      // Durable state did not advance. A worker resynchronizes from this.state next time.
    }
  }

  async #commitPreparedCandidate() {
    try {
      await this.candidateProcessor.commit();
    } catch {
      // The durable write is authoritative. Worker synchronization is recoverable.
    }
  }

  #currentGraphSnapshot(state) {
    if (this.graphSnapshotCache?.state === state) return this.graphSnapshotCache.value;
    const value = projectWorkLedgerGraphView(state);
    if (!this.graphSnapshotCache || state.revision >= this.graphSnapshotCache.state.revision) {
      this.graphSnapshotCache = { state, value };
    }
    return value;
  }

  async #yieldAfterCommit() {
    try {
      await this.postCommitYield();
    } catch {
      // Fair scheduling is non-authoritative and cannot invalidate a committed write.
    }
  }

  async #readDurableState() {
    let stored;
    let observedVersion;
    if (typeof this.store.readVersioned === "function") {
      const result = normalizeVersionedRead(
        await this.store.readVersioned(WORK_LEDGER_STATE_KEY, null, {
          ifVersion: this.durableContentVersion,
        }),
        this.durableContentVersion,
      );
      if (!result.changed) {
        if (this.ready) assertLedgerRevisionProgress(this.state, this.committedAuthoritySnapshot?.state ?? this.state);
        return this.state;
      }
      stored = result.value;
      observedVersion = result.version;
    } else {
      stored = await this.store.read(WORK_LEDGER_STATE_KEY, null);
    }
    if (stored === null) {
      if (this.ready && (this.committedAuthoritySnapshot?.state ?? this.state).revision !== 0) {
        throw workLedgerError(
          "WORK_LEDGER_STATE_CORRUPTED",
          "员工工作台账持久状态意外消失",
          503,
        );
      }
      this.durableContentVersion = observedVersion;
      const state = emptyWorkLedgerState();
      this.committedAuthoritySnapshot = { version: observedVersion, state };
      return state;
    }
    const durable = observedVersion !== undefined && observedVersion === this.committedAuthoritySnapshot?.version
      ? this.committedAuthoritySnapshot.state : normalizeWorkLedgerPersistedState(stored, this.limits);
    if (this.ready) assertLedgerRevisionProgress(durable, this.committedAuthoritySnapshot?.state ?? this.state);
    this.durableContentVersion = observedVersion;
    this.committedAuthoritySnapshot = { version: observedVersion, state: durable };
    return durable;
  }

  async #readCommittedAuthorityState() {
    // Authority reads need committed state, not a place behind pending writes.
    // Keep their version cache separate from mutation bookkeeping, including
    // when another instance commits or a durable write loses its ACK.
    const snapshot = this.committedAuthoritySnapshot;
    const baseline = snapshot?.state ?? this.state;
    let stored;
    let durable;
    let observedVersion;
    if (typeof this.store.readVersioned === "function") {
      // The pair is published atomically after validation or a committed write.
      const version = snapshot?.version;
      const result = normalizeVersionedRead(
        await this.store.readVersioned(WORK_LEDGER_STATE_KEY, null, {
          ifVersion: version,
        }),
        version,
      );
      observedVersion = result.version;
      // Every caller still performs fresh I/O. Concurrent reads may return the
      // same token after another caller has already validated that content.
      if (result.version === this.committedAuthoritySnapshot?.version) durable = this.committedAuthoritySnapshot.state;
      else if (!result.changed) durable = snapshot.state;
      else stored = result.value;
    } else {
      stored = await this.store.read(WORK_LEDGER_STATE_KEY, null);
    }
    if (durable === undefined) {
      if (stored === null && baseline.revision !== 0) {
        throw workLedgerError(
          "WORK_LEDGER_STATE_CORRUPTED",
          "员工工作台账持久状态意外消失",
          503,
        );
      }
      durable = stored === null ? emptyWorkLedgerState() : normalizeWorkLedgerPersistedState(stored, this.limits);
    }
    assertLedgerRevisionProgress(durable, baseline);
    const latest = this.committedAuthoritySnapshot;
    if (latest?.state.revision === durable.revision) assertLedgerRevisionProgress(durable, latest.state);
    // A slower read cannot replace a newer committed snapshot published while
    // its I/O was in flight. Its own result still describes that earlier read.
    if (latest === snapshot || durable.revision > latest.state.revision) {
      this.committedAuthoritySnapshot = { version: observedVersion, state: durable };
    }
    return durable;
  }

  #writeTransaction(operation) {
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
        } catch (error) {
          if (
            error?.code === "WORK_LEDGER_STATE_CORRUPTED" ||
            error?.code === "WORK_LEDGER_STATE_REVISION_CONFLICT"
          ) {
            throw error;
          }
          throw workLedgerError(
            "WORK_LEDGER_STATE_CORRUPTED",
            "无法重读员工工作台账",
            503,
            { cause: error },
          );
        }
        return operation();
      }),
    );
  }

  async #admitNewWork(operation) {
    const admitted = await this.runNewWorkAdmission(() => ({
      // The service queue is the admission boundary. Carry its Promise out so
      // cutover never waits on the assignment source or durable store.
      operation: operation(),
    }));
    return admitted.operation;
  }

  #assertReady() {
    if (!this.ready) {
      throw workLedgerError(
        "WORK_LEDGER_NOT_READY",
        "员工工作台账尚未恢复",
        503,
      );
    }
  }
}
