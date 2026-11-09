import { isDeepStrictEqual } from "node:util";
import { normalizeHeadAncestryReceipt, headAncestrySourceMatches, headAncestryEvent } from "../domain/head-ancestry-receipt.js";
import {
  createPullRequestExecutionBinding,
  normalizePullRequestExecutionBinding,
  pullRequestExecutionTargetMatchesEvent,
} from "../domain/pull-request-execution-binding.js";
import {
  pullRequestGitTargetFromEvent,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import {
  isTrustedPullRequestScopeLifecycleAssignment,
} from "../domain/pull-request-scope-lifecycle.js";
import {
  AUTHORED_PR_APPROVED_RULE_ID,
  AUTHORED_PR_SELF_FIX_RULE_ID,
  REVIEWED_PR_APPROVED_RULE_ID,
} from "../domain/pr-lifecycle-routing.js";
import {
  SHA256_PATTERN,
  boundedLedgerString,
  canonicalLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTarget,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";

const SOURCE_KEYS = [
  "schemaVersion",
  "kind",
  "workKey",
  "identity",
  "inputRevision",
  "activeRevision",
  "headRevision",
  "authorityEpoch",
  "scope",
  "pendingRevision",
  "current",
  "pending",
  "revisions",
  "bindings",
];
const LEGACY_SOURCE_KEYS = SOURCE_KEYS.filter(
  (key) => !["authorityEpoch", "scope"].includes(key),
);
const BUDGET_SOURCE_KEYS = [...SOURCE_KEYS, "decisionBudget"];
const DECISION_BUDGET_KEYS = ["headRefOid", "activationRevision", "previousActiveRevision", "attemptOffset"];
const SCOPE_KEYS = [
  "kind",
  "active",
  "revision",
  "lastLifecycleEventId",
];
const IDENTITY_KEYS = [
  "provider",
  "scopeId",
  "subjectId",
  "repository",
  "pullRequestNumber",
  "targetRoleId",
];
const OWNER_REQUESTED_PR_TARGET_ROLES = new Set([
  "orchestrator",
  "pr-engineer",
  "developer",
  "tester",
]);
const AUTHORED_PR_SELF_FIX_ACTIONS = new Set([
  "address_review",
  "fix_ci",
  "resolve_conflict",
  "continue_draft",
]);

export function trustedPrRoleForEvent(event) {
  if (
    event?.source?.provider !== "github" ||
    !["authored", "review_requested"].includes(event?.payload?.relation)
  ) {
    return null;
  }
  if (
    event.payload.relation === "authored" &&
    event.payload.actionState === "action_now" &&
    AUTHORED_PR_SELF_FIX_ACTIONS.has(event.payload.nextAction)
  ) {
    return { roleId: "developer", ruleId: AUTHORED_PR_SELF_FIX_RULE_ID };
  }
  const authoredApproved =
    event.payload.relation === "authored" &&
    event.payload.actionState === "waiting_other" &&
    event.payload.nextAction === "wait_merge" &&
    event.payload.reviewDecision === "APPROVED";
  const reviewedApproved =
    event.payload.relation === "review_requested" &&
    event.payload.actionState === "waiting_other" &&
    event.payload.nextAction === "wait_merge" &&
    event.payload.myReviewState === "APPROVED";
  if (authoredApproved) return { roleId: "tester", ruleId: AUTHORED_PR_APPROVED_RULE_ID };
  if (reviewedApproved) return { roleId: "tester", ruleId: REVIEWED_PR_APPROVED_RULE_ID };
  return null;
}

function isTrustedPrRoleAssignment(assignment, event) {
  const role = trustedPrRoleForEvent(event);
  return role !== null && assignment?.target?.type === "role" &&
    assignment.target.id === role.roleId && assignment.ruleId === role.ruleId;
}
const CURRENT_KEYS = [
  "sourceSequence",
  "eventId",
  "eventDigest",
  "inputDigest",
  "occurredAt",
  "headRefOid",
  "event",
];
const LEGACY_REVISION_KEYS = [
  "revision",
  "eventId",
  "eventDigest",
  "inputDigest",
  "occurredAt",
  "headRevision",
  "headRefOid",
  "previousHeadRefOid",
  "disposition",
];
const CAUSAL_REVISION_KEYS = [
  ...LEGACY_REVISION_KEYS,
  "causalHeadRefOid",
];
const AUTHORITY_REVISION_KEYS = [
  ...CAUSAL_REVISION_KEYS,
  "authorityEpochChanged",
];
const REVISION_KEYS = [
  ...AUTHORITY_REVISION_KEYS,
  "authorityEpochCutover",
];
const SCOPE_REVOCATION_REVISION_KEYS = [
  ...REVISION_KEYS,
  "scopeRevocationApplied",
];
const BINDING_KEYS = [
  "sourceSequence",
  "assignmentId",
  "assignmentDigest",
  "eventId",
  "inputRevision",
];
const SCOPE_LIFECYCLE_BINDING_KEYS = [...BINDING_KEYS, "scopeLifecycle"];
const INPUT_BINDING_KEYS = [
  "kind",
  "rootItemId",
  "workKey",
  "inputRevision",
  "headRevision",
  "headRefOid",
  "eventId",
  "eventDigest",
  "inputDigest",
];
const DISPOSITIONS = new Set([
  "accepted",
  "ignored_legacy_downgrade",
  "ignored_authority_fence",
  "ignored_stale",
  "ignored_unproven_head",
]);
const CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON =
  "pr_source_cross_root_cutover_pending";
const CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_PREFIX =
  "pr_source_cross_root_cutover_blocker:";

function crossRootProtectedParticipant(state, item, binding) {
  if (!item?.statusReason?.startsWith(
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_PREFIX,
  )) {
    return false;
  }
  const pendingItemId = item.statusReason.slice(
    CROSS_ROOT_PR_SOURCE_CUTOVER_BLOCKER_PREFIX.length,
  );
  const pendingRoot = state.items.find(
    (candidate) => candidate.itemId === pendingItemId,
  );
  const pendingPrefix = `${CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON}:`;
  if (!pendingRoot?.statusReason?.startsWith(pendingPrefix)) return false;
  const predecessorItemId = pendingRoot.statusReason.slice(
    pendingPrefix.length,
  );
  const predecessor = state.items.find(
    (candidate) => candidate.itemId === predecessorItemId,
  );
  const predecessorBinding = currentWorkItemInputBinding(predecessor);
  return Boolean(
    predecessor !== undefined &&
      samePullRequestSourceSubject(predecessor, pendingRoot) &&
      binding.rootItemId === predecessor.itemId &&
      predecessorBinding !== null &&
      binding.headRevision === predecessorBinding.headRevision &&
      binding.headRefOid === predecessorBinding.headRefOid,
  );
}
const MAX_TEXT_BYTES = 512;

export const LEGACY_PR_SOURCE_CUTOVER_REASON = "pr_source_legacy_cutover";
export const LEGACY_PR_SOURCE_QUARANTINE_KIND =
  "legacy_pull_request_source";

function invalid(message, code = "WORK_LEDGER_PR_SOURCE_INVALID") {
  return workLedgerError(code, message, 409);
}

function text(value, name, maximumBytes = MAX_TEXT_BYTES) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function digest(value, name) {
  const normalized = text(value, name, 64);
  if (!SHA256_PATTERN.test(normalized)) throw invalid(`${name} 无效`);
  return normalized;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function optionalPositiveInteger(value, name) {
  return value === null ? null : positiveInteger(value, name);
}

function plainArray(value, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function normalizePullRequestScope(value) {
  exact(value, SCOPE_KEYS, "PR scope");
  if (
    !["automatic", "owner_requested", "internal_review"].includes(value.kind) ||
    typeof value.active !== "boolean"
  ) {
    throw invalid("PR scope 状态无效");
  }
  const normalized = {
    kind: value.kind,
    active: value.active,
    revision: positiveInteger(value.revision, "scope.revision"),
    lastLifecycleEventId: value.lastLifecycleEventId === null
      ? null
      : text(
          value.lastLifecycleEventId,
          "scope.lastLifecycleEventId",
          192,
        ),
  };
  if (
    ["owner_requested", "internal_review"].includes(normalized.kind) &&
    (!normalized.active ||
      normalized.revision !== 1 ||
      normalized.lastLifecycleEventId !== null)
  ) {
    throw invalid("owner requested PR scope 状态无效");
  }
  return normalized;
}

function canonical(value, name) {
  try {
    return canonicalLedgerValue(value, {
      maximumEntries: 30_000,
      errorCode: "WORK_LEDGER_PR_SOURCE_INVALID",
    });
  } catch (error) {
    if (error?.code === "WORK_LEDGER_PR_SOURCE_INVALID") throw error;
    throw invalid(`${name} 无效`);
  }
}

function storedEvent(value) {
  try {
    return normalizeStoredWorkflowEvent(canonical(value, "event"));
  } catch {
    throw invalid("PR 来源事件无效");
  }
}

function exact(value, keys, name) {
  if (!hasExactLedgerKeys(value, keys)) throw invalid(`${name} 字段无效`);
  return value;
}

function head(value, name) {
  return text(value, name, 256);
}

function previousHead(value) {
  return value === null ? null : head(value, "previousHeadRefOid");
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function assignmentDigest(assignment, event) {
  return ledgerDigest({ assignment, event }, { maximumEntries: 30_000 });
}

function sourceInputDigest(workKey, event) {
  return ledgerDigest({ workKey, event }, { maximumEntries: 30_000 });
}

function identityFor(assignment, event, trustedLifecycle = false, lifecycleRoleId = "pr-engineer") {
  let target;
  try {
    target = normalizeLedgerTarget(assignment.target);
  } catch {
    return null;
  }
  const ownerRequested =
    event.source.provider === "local-owner" &&
    event.eventType === "pull_request.owner_requested";
  const allowedRoleTarget =
    target.type === "role" &&
    (target.id === "pr-engineer" ||
      (ownerRequested && OWNER_REQUESTED_PR_TARGET_ROLES.has(target.id)) ||
      isTrustedPrRoleAssignment(assignment, event));
  if (
    (!trustedLifecycle && !allowedRoleTarget) ||
    !event.eventType.startsWith("pull_request.") ||
    !(
      event.source.provider === "github" ||
      (event.source.provider === "local-owner" &&
        event.eventType === "pull_request.owner_requested") ||
      (event.source.provider === "internal-review-repair" &&
        event.eventType === "pull_request.internal_review_requested" && target.id === "pr-engineer")
    )
  ) {
    return null;
  }
  return {
    provider: text(event.source.provider, "provider", 128),
    scopeId: text(event.source.scopeId, "scopeId", 256),
    subjectId: text(event.subject.id, "subjectId", 512),
    repository: text(event.subject.repository, "repository", 140),
    pullRequestNumber: positiveInteger(
      event.subject.number,
      "pullRequestNumber",
    ),
    targetRoleId: trustedLifecycle ? lifecycleRoleId : target.id,
  };
}

function workKeyFor(identity) {
  return `pr-work-${ledgerDigest(identity)}`;
}

function normalizedEnvelope(value, lifecycleRoleId = "pr-engineer") {
  const sequence = positiveInteger(value.sequence, "sourceSequence");
  const assignment = canonical(value.assignment, "assignment");
  const rawEvent = canonical(value.event, "event");
  const ordinaryTarget = assignment.target?.type === "role" &&
    assignment.target?.id === "pr-engineer";
  const ownerRequestedTarget =
    assignment.target?.type === "role" &&
    OWNER_REQUESTED_PR_TARGET_ROLES.has(assignment.target?.id) &&
    rawEvent.source?.provider === "local-owner" &&
    rawEvent.eventType === "pull_request.owner_requested";
  const protectedRoleTarget =
    assignment.target?.type === "role" &&
    ((assignment.ruleId === AUTHORED_PR_SELF_FIX_RULE_ID &&
      assignment.target.id === "developer") ||
      (assignment.ruleId === AUTHORED_PR_APPROVED_RULE_ID &&
        assignment.target.id === "tester") ||
      (assignment.ruleId === REVIEWED_PR_APPROVED_RULE_ID &&
        assignment.target.id === "tester"));
  const lifecycleTarget = assignment.target?.type === "node" &&
    assignment.target?.id === "system-pull-request-scope-lifecycle" &&
    assignment.ruleId === "system-pull-request-scope-lifecycle";
  if (typeof rawEvent.eventType !== "string" ||
      !rawEvent.eventType.startsWith("pull_request.") ||
      (!ordinaryTarget &&
        !ownerRequestedTarget &&
        !protectedRoleTarget &&
        !lifecycleTarget)) {
    return null;
  }
  const event = storedEvent(rawEvent);
  const trustedLifecycle =
    isTrustedPullRequestScopeLifecycleAssignment(assignment, event);
  if (event.eventType === "pull_request.role_handoff" && !trustedLifecycle) return null;
  if (
    !trustedLifecycle &&
    !ordinaryTarget &&
    !ownerRequestedTarget &&
    !isTrustedPrRoleAssignment(assignment, event)
  ) {
    return null;
  }
  const identity = identityFor(assignment, event, trustedLifecycle, lifecycleRoleId);
  if (identity === null) return null;
  const assignmentId = text(
    assignment.assignmentId,
    "assignmentId",
    192,
  );
  if (assignment.eventId !== undefined && assignment.eventId !== event.eventId) {
    throw invalid("PR 分派与事件绑定不一致");
  }
  const workKey = workKeyFor(identity);
  const headRefOid = head(event.payload.headRefOid, "headRefOid");
  return {
    sequence,
    assignment,
    assignmentId,
    assignmentDigest: assignmentDigest(assignment, event),
    event,
    identity,
    workKey,
    headRefOid,
    previousHeadRefOid: event.payload.previousHeadRefOid === undefined
      ? null
      : previousHead(event.payload.previousHeadRefOid),
    inputDigest: sourceInputDigest(workKey, event),
    trustedLifecycle,
  };
}

function revisionFrom(
  input,
  revision,
  headRevision,
  disposition,
  causalHeadRefOid,
  authorityEpochChanged,
) {
  return {
    revision,
    eventId: input.event.eventId,
    eventDigest: input.event.contentDigest,
    inputDigest: input.inputDigest,
    occurredAt: input.event.occurredAt,
    headRevision,
    headRefOid: input.headRefOid,
    previousHeadRefOid: input.previousHeadRefOid,
    causalHeadRefOid,
    authorityEpochChanged,
    authorityEpochCutover: false,
    ...(input.event.source.provider === "github" && input.event.payload.relation === "review_requested" &&
      input.event.payload.reviewRequestEventId && Number.isFinite(Date.parse(input.event.payload.reviewReceivedAt))
      ? { incomingReview: { eventId: input.event.payload.reviewRequestEventId,
        receivedAt: new Date(input.event.payload.reviewReceivedAt).toISOString() } } : {}),
    disposition,
  };
}

function bindingFrom(input, inputRevision) {
  return {
    sourceSequence: input.sequence,
    assignmentId: input.assignmentId,
    assignmentDigest: input.assignmentDigest,
    eventId: input.event.eventId,
    inputRevision,
    ...(input.trustedLifecycle ? { scopeLifecycle: true } : {}),
  };
}

function currentFrom(input) {
  return {
    sourceSequence: input.sequence,
    eventId: input.event.eventId,
    eventDigest: input.event.contentDigest,
    inputDigest: input.inputDigest,
    occurredAt: input.event.occurredAt,
    headRefOid: input.headRefOid,
    event: structuredClone(input.event),
  };
}

export function pullRequestWorkDescriptor(envelope) {
  return normalizedEnvelope(envelope);
}

export function pullRequestScopeLifecycleTargetRole(envelope) {
  const input = normalizedEnvelope(envelope);
  if (input === null || !input.trustedLifecycle) return null;
  return trustedPrRoleForEvent(input.event)?.roleId ?? "pr-engineer";
}

export function pullRequestScopeLifecycleMatchesSource(source, envelope) {
  if (source?.kind !== "pull_request" || source.scope.kind !== "automatic") return false;
  const event = envelope.event;
  if (source.identity.provider !== event.source?.provider ||
      source.identity.scopeId !== event.source?.scopeId ||
      source.identity.subjectId !== event.subject?.id ||
      source.identity.repository !== event.subject?.repository ||
      source.identity.pullRequestNumber !== event.subject?.number) return false;
  const input = normalizedEnvelope(envelope, source.identity.targetRoleId);
  if (input === null || !input.trustedLifecycle || input.workKey !== source.workKey) return false;
  const observed = latestObservedInput(source).event;
  if (observed.payload.relation !== input.event.payload.relation) return false;
  if (source.identity.targetRoleId === "pr-engineer") return true;
  // Specialist routes share the discovery lane, not the PR engineer work key.
  // Bind that lane to its account and refs without trusting a changed Head.
  const previousTarget = observed.payload.gitTarget;
  const lifecycleTarget = input.event.payload.gitTarget;
  return ["authored", "review_requested"].includes(observed.payload.relation) &&
    previousTarget !== undefined && lifecycleTarget !== undefined &&
    ["sourceAccountId", "baseRepository", "baseRefName", "headRepository", "headRefName"]
      .every(key => typeof previousTarget[key] === "string" && previousTarget[key] === lifecycleTarget[key]);
}

export function createPullRequestWorkSource(envelope) {
  const input = normalizedEnvelope(envelope);
  if (input === null || input.trustedLifecycle) return null;
  return {
    descriptor: input,
    source: {
      schemaVersion: 1,
      kind: "pull_request",
      workKey: input.workKey,
      identity: input.identity,
      inputRevision: 1,
      activeRevision: 1,
      headRevision: 1,
      authorityEpoch: 1,
      scope: {
        kind: input.event.eventType === "pull_request.owner_requested"
          ? "owner_requested"
          : input.event.eventType === "pull_request.internal_review_requested" ? "internal_review" : "automatic",
        active: true,
        revision: 1,
        lastLifecycleEventId: null,
      },
      pendingRevision: null,
      current: currentFrom(input),
      pending: null,
      revisions: [revisionFrom(input, 1, 1, "accepted", null, false)],
      bindings: [bindingFrom(input, 1)],
      decisionBudget: { headRefOid: input.headRefOid, activationRevision: 1,
        previousActiveRevision: null, attemptOffset: 0 },
    },
  };
}

function latestObservedInput(source) {
  return source.pending ?? source.current;
}

function hasGitTargetMarker(event) {
  return Object.hasOwn(event?.payload ?? {}, "gitTargetAvailable");
}

function sameEventGitAuthority(left, right) {
  const leftState = gitTargetStateForEvent(left);
  const rightState = gitTargetStateForEvent(right);
  if (leftState !== rightState) return false;
  if (leftState !== "available") return true;
  return samePullRequestGitTarget(
    pullRequestGitTargetFromEvent(left),
    pullRequestGitTargetFromEvent(right),
  );
}

function sameEventExecutionAuthority(left, right) {
  return Boolean(
    left?.source?.provider === right?.source?.provider &&
      left?.source?.scopeId === right?.source?.scopeId &&
      sameEventGitAuthority(left, right),
  );
}

function isAuthorityFenceDisposition(disposition) {
  return disposition === "ignored_legacy_downgrade" ||
    disposition === "ignored_authority_fence";
}

function hasUnresolvedAuthorityFence(source) {
  const latestAcceptedIndex = source.revisions.findLastIndex(
    ({ disposition }) => disposition === "accepted",
  );
  return source.revisions
    .slice(latestAcceptedIndex + 1)
    .some(({ disposition }) => isAuthorityFenceDisposition(disposition));
}

function acceptedHeadChange(source, input, causalHeadRefOid) {
  const observed = latestObservedInput(source);
  const predecessor = causalHeadRefOid ?? observed.headRefOid;
  if (input.headRefOid === predecessor) return true;
  if (headAncestrySourceMatches(source.headAncestryReceipt, source, input.event)) return true;
  return (
    (input.event.eventType === "pull_request.updated" ||
      (input.event.eventType === "pull_request.owner_requested" && source.scope.kind === "owner_requested" &&
        input.event.source.provider === "local-owner" && input.event.source.scopeId === source.current.event.source.scopeId)) &&
    Array.isArray(input.event.payload.changedFields) &&
    input.event.payload.changedFields.includes("headRefOid") &&
    input.previousHeadRefOid === predecessor
  );
}

export function appendPullRequestWorkSource(
  value,
  envelope,
  {
    activate = true,
    causalHeadRefOid,
    authorityEpochChanged = false,
    authorityFenceRecovery = false,
    attemptAtActivation,
  } = {},
) {
  if (
    typeof activate !== "boolean" ||
    typeof authorityEpochChanged !== "boolean" ||
    typeof authorityFenceRecovery !== "boolean"
  ) {
    throw invalid("PR 来源激活选项无效");
  }
  const causalHead = causalHeadRefOid === undefined
    ? null
    : head(causalHeadRefOid, "causalHeadRefOid");
  const source = normalizePullRequestWorkSource(value);
  const input = normalizedEnvelope(envelope, source.identity.targetRoleId);
  if (input === null || input.workKey !== source.workKey) {
    throw invalid("PR 来源工作键不一致");
  }
  const lastBinding = source.bindings.at(-1);
  if (input.sequence <= lastBinding.sourceSequence) {
    throw invalid("PR 来源分派序号没有递增");
  }
  const duplicateBinding = source.bindings.find(
    ({ assignmentId }) => assignmentId === input.assignmentId,
  );
  if (duplicateBinding) {
    if (
      duplicateBinding.sourceSequence === input.sequence &&
      duplicateBinding.assignmentDigest === input.assignmentDigest
    ) {
      return { source, changed: false, disposition: "duplicate" };
    }
    throw invalid("相同 PR assignmentId 对应不同输入");
  }

  const existingRevision = source.revisions.find(
    ({ eventId }) => eventId === input.event.eventId,
  );
  if (existingRevision) {
    if (
      existingRevision.eventDigest !== input.event.contentDigest ||
      existingRevision.inputDigest !== input.inputDigest
    ) {
      throw invalid("相同 PR eventId 对应不同输入");
    }
    return {
      source: {
        ...source,
        bindings: [
          ...source.bindings,
          bindingFrom(input, existingRevision.revision),
        ],
      },
      changed: true,
      disposition: "bound_existing_event",
      headAdvanced: false,
      activeAdvanced: false,
    };
  }

  const revision = source.inputRevision + 1;
  const observed = latestObservedInput(source);
  const acceptedCausalHead = causalHead ?? observed.headRefOid;
  const recoveringAuthorityFence =
    !input.trustedLifecycle &&
    (hasUnresolvedAuthorityFence(source) || authorityFenceRecovery) &&
    sameEventExecutionAuthority(source.current.event, input.event);
  const stale = Date.parse(input.event.occurredAt) <
      Date.parse(observed.occurredAt) &&
    !recoveringAuthorityFence;
  const headChanged =
    input.headRefOid !== observed.headRefOid ||
    (causalHead !== null && input.headRefOid !== causalHead);
  const headProven = acceptedHeadChange(source, input, causalHead);
  const ancestryReceipt = headAncestrySourceMatches(source.headAncestryReceipt, source, input.event)
    ? source.headAncestryReceipt : null;
  const legacyDowngrade = gitTargetStateForEvent(input.event) === "legacy" &&
    [source.current, source.pending]
      .filter((pointer) => pointer !== null)
      .some(({ event }) => gitTargetStateForEvent(event) !== "legacy");
  const unavailableFence = gitTargetStateForEvent(input.event) ===
    "unavailable";
  const disposition = legacyDowngrade
    ? "ignored_legacy_downgrade"
    : unavailableFence
      ? "ignored_authority_fence"
      : stale
        ? "ignored_stale"
      : headChanged && !headProven
        ? "ignored_unproven_head"
        : "accepted";
  const accepted = disposition === "accepted";
  const executionAuthorityChanged =
    headChanged ||
    authorityEpochChanged ||
    recoveringAuthorityFence ||
    !sameEventGitAuthority(observed.event, input.event);
  const headRevision = accepted && executionAuthorityChanged
    ? source.headRevision + 1
    : source.headRevision;
  const nextSource = {
      ...source,
      inputRevision: revision,
      activeRevision: accepted && activate ? revision : source.activeRevision,
      headRevision: accepted ? headRevision : source.headRevision,
      authorityEpoch: accepted ? headRevision : source.authorityEpoch,
      pendingRevision: accepted
        ? activate ? null : revision
        : source.pendingRevision,
      current: accepted && activate ? currentFrom(input) : source.current,
      pending: accepted
        ? activate ? null : currentFrom(input)
        : source.pending,
      revisions: [
        ...source.revisions,
        revisionFrom(
          input,
          revision,
          accepted ? headRevision : null,
          disposition,
          acceptedCausalHead,
          accepted && executionAuthorityChanged,
        ),
      ],
      bindings: [...source.bindings, bindingFrom(input, revision)],
    };
  if (accepted && ancestryReceipt !== null) {
    nextSource.revisions.at(-1).headAncestryProof = ancestryReceipt;
    delete nextSource.headAncestryReceipt;
  }
  const activatedSource = accepted && activate
    ? applyPullRequestDecisionBudgetAtActivation(source, nextSource, attemptAtActivation)
    : nextSource;
  return {
    source: activatedSource,
    changed: true,
    disposition,
    headAdvanced: accepted && executionAuthorityChanged,
    activeAdvanced: accepted && activate,
  };
}

function acceptedCreatedLifecycleJoin(source, eventId) {
  const revision = source.revisions[source.activeRevision - 1];
  const previousLifecycle = source.revisions.find(candidate => candidate.eventId === source.scope.lastLifecycleEventId);
  return source.scope.active === false && source.current.eventId === eventId &&
    source.current.event.eventType === "pull_request.created" &&
    revision.disposition === "accepted" && revision.authorityEpochChanged === true &&
    previousLifecycle !== undefined && revision.revision > previousLifecycle.revision;
}

export function applyPullRequestScopeLifecycle(value, envelope, { attemptAtActivation, activate = true } = {}) {
  const source = normalizePullRequestWorkSource(value);
  const input = normalizedEnvelope(envelope, source.identity.targetRoleId);
  if (input === null || !input.trustedLifecycle) {
    throw invalid("PR 范围生命周期分派无效");
  }
  if (!pullRequestScopeLifecycleMatchesSource(source, envelope)) {
    throw invalid("PR 范围生命周期工作键不一致");
  }
  const active = ["pull_request.created", "pull_request.role_handoff"].includes(input.event.eventType);
  const authorityChanged = source.scope.active !== active;
  const appended = appendPullRequestWorkSource(source, envelope, {
    activate,
    authorityEpochChanged: authorityChanged,
    attemptAtActivation,
  });
  if (!appended.changed) return appended;
  const appendedRevision = appended.source.revisions.at(-1);
  const rejectedRevocation =
    authorityChanged &&
    !active &&
    appended.source.inputRevision > source.inputRevision &&
    appended.disposition !== "accepted";
  const appliedAuthorityChange =
    authorityChanged &&
    (appended.disposition === "accepted" || rejectedRevocation ||
      (appended.disposition === "bound_existing_event" && acceptedCreatedLifecycleJoin(source, input.event.eventId)));
  const revisions = rejectedRevocation
    ? [
        ...appended.source.revisions.slice(0, -1),
        { ...appendedRevision, scopeRevocationApplied: true },
      ]
    : appended.source.revisions;
  return {
    ...appended,
    source: {
      ...appended.source,
      revisions,
      authorityEpoch: appended.source.headRevision,
      scope: {
        ...appended.source.scope,
        active: appliedAuthorityChange ? active : appended.source.scope.active,
        revision: appliedAuthorityChange
          ? appended.source.scope.revision + 1
          : appended.source.scope.revision,
        lastLifecycleEventId: appliedAuthorityChange
          ? input.event.eventId
          : appended.source.scope.lastLifecycleEventId,
      },
    },
    authorityChanged: appliedAuthorityChange,
  };
}

function normalizeIdentity(value) {
  exact(value, IDENTITY_KEYS, "PR identity");
  return {
    provider: text(value.provider, "identity.provider", 128),
    scopeId: text(value.scopeId, "identity.scopeId", 256),
    subjectId: text(value.subjectId, "identity.subjectId", 512),
    repository: text(value.repository, "identity.repository", 140),
    pullRequestNumber: positiveInteger(
      value.pullRequestNumber,
      "identity.pullRequestNumber",
    ),
    targetRoleId: text(value.targetRoleId, "identity.targetRoleId", 128),
  };
}

function normalizeRevision(value, expectedRevision) {
  let headAncestryProof;
  if (Object.hasOwn(value, "headAncestryProof")) {
    headAncestryProof = normalizeHeadAncestryReceipt(value.headAncestryProof);
    const { headAncestryProof: omitted, ...revision } = value;
    value = revision;
    if (headAncestryEvent(headAncestryProof).eventId !== value.eventId ||
        headAncestryEvent(headAncestryProof).contentDigest !== value.eventDigest ||
        headAncestryProof.event.payload.headRefOid !== value.headRefOid ||
        headAncestryProof.sourceInputRevision + 1 !== expectedRevision || value.disposition !== "accepted" ||
        headAncestryProof.ancestorHeadRefOid !== value.causalHeadRefOid) throw invalid("PR ancestry revision binding is invalid");
  }
  let incomingReview;
  if (Object.hasOwn(value, "incomingReview")) {
    exact(value.incomingReview, ["eventId", "receivedAt"], "PR incoming Review");
    incomingReview = { eventId: text(value.incomingReview.eventId, "incomingReview.eventId", 192),
      receivedAt: timestamp(value.incomingReview.receivedAt, "incomingReview.receivedAt") };
    const { incomingReview: omitted, ...revision } = value;
    value = revision;
  }
  const hasScopeRevocation = hasExactLedgerKeys(
    value,
    SCOPE_REVOCATION_REVISION_KEYS,
  );
  const hasAuthorityCutover = hasScopeRevocation ||
    hasExactLedgerKeys(value, REVISION_KEYS);
  const hasAuthorityEpoch = hasAuthorityCutover ||
    hasExactLedgerKeys(value, AUTHORITY_REVISION_KEYS);
  const hasCausalHead = hasAuthorityEpoch ||
    hasExactLedgerKeys(value, CAUSAL_REVISION_KEYS);
  if (
    !hasCausalHead &&
    !hasExactLedgerKeys(value, LEGACY_REVISION_KEYS)
  ) {
    throw invalid("PR input revision 字段无效");
  }
  const revision = positiveInteger(value.revision, "inputRevision.revision");
  const disposition = text(value.disposition, "disposition", 64);
  if (revision !== expectedRevision || !DISPOSITIONS.has(disposition)) {
    throw invalid("PR input revision 顺序或结果无效");
  }
  const headRevision = optionalPositiveInteger(
    value.headRevision,
    "inputRevision.headRevision",
  );
  if ((disposition === "accepted") !== (headRevision !== null)) {
    throw invalid("PR input revision Head epoch 无效");
  }
  if (hasScopeRevocation && value.scopeRevocationApplied !== true) {
    throw invalid("PR scope 撤销历史无效");
  }
  return {
    revision,
    eventId: text(value.eventId, "inputRevision.eventId", 192),
    eventDigest: digest(value.eventDigest, "inputRevision.eventDigest"),
    inputDigest: digest(value.inputDigest, "inputRevision.inputDigest"),
    occurredAt: timestamp(value.occurredAt, "inputRevision.occurredAt"),
    headRevision,
    headRefOid: head(value.headRefOid, "inputRevision.headRefOid"),
    previousHeadRefOid: previousHead(value.previousHeadRefOid),
    causalHeadRefOid: hasCausalHead
      ? previousHead(value.causalHeadRefOid)
      : undefined,
    authorityEpochChanged: hasAuthorityEpoch
      ? value.authorityEpochChanged
      : undefined,
    authorityEpochCutover: hasAuthorityCutover
      ? value.authorityEpochCutover
      : undefined,
    ...(hasScopeRevocation ? { scopeRevocationApplied: true } : {}),
    ...(incomingReview ? { incomingReview } : {}),
    ...(headAncestryProof ? { headAncestryProof } : {}),
    disposition,
  };
}

function sealLegacyRevisionMetadata(revisions) {
  let previousHeadRevision = 0;
  let previousAcceptedHead = null;
  for (const revision of revisions) {
    if (revision.causalHeadRefOid === undefined) {
      revision.causalHeadRefOid = previousAcceptedHead;
    }
    if (revision.authorityEpochChanged === undefined) {
      revision.authorityEpochChanged =
        revision.disposition === "accepted" &&
        previousHeadRevision > 0 &&
        revision.headRevision === previousHeadRevision + 1;
    }
    if (revision.authorityEpochCutover === undefined) {
      revision.authorityEpochCutover = false;
    }
    if (revision.disposition === "accepted") {
      previousHeadRevision = revision.headRevision;
      previousAcceptedHead = revision.headRefOid;
    }
  }
}

function validateRevisionEpochHistory(revisions, expectedHeadRevision) {
  let previousHeadRevision = 0;
  let previousAcceptedHead = null;
  let cutoverCount = 0;
  for (const revision of revisions) {
    if (
      typeof revision.authorityEpochChanged !== "boolean" ||
      typeof revision.authorityEpochCutover !== "boolean"
    ) {
      throw invalid("PR authority epoch 历史无效");
    }
    if (revision.disposition !== "accepted") {
      if (revision.authorityEpochChanged || revision.authorityEpochCutover) {
        throw invalid("PR authority epoch 历史无效");
      }
      continue;
    }
    if (revision.headAncestryProof !== undefined &&
        (revision.headAncestryProof.ancestorHeadRefOid !== previousAcceptedHead ||
         revision.headAncestryProof.authorityEpoch !== previousHeadRevision)) throw invalid("PR ancestry predecessor is invalid");
    if (revision.authorityEpochCutover) cutoverCount += 1;
    const expectedRevision = previousHeadRevision === 0
      ? 1
      : previousHeadRevision + (revision.authorityEpochCutover
        ? 2
        : revision.authorityEpochChanged ? 1 : 0);
    if (
      revision.headRevision !== expectedRevision ||
      (previousHeadRevision === 0 &&
        (revision.authorityEpochChanged || revision.authorityEpochCutover)) ||
      (revision.authorityEpochCutover &&
        !revision.authorityEpochChanged) ||
      (revision.authorityEpochChanged &&
        previousHeadRevision > 0 &&
        (revision.causalHeadRefOid === null ||
          (revision.headAncestryProof === undefined && revision.headRefOid !== revision.causalHeadRefOid &&
            revision.previousHeadRefOid !== revision.causalHeadRefOid))) ||
      (!revision.authorityEpochChanged &&
        previousHeadRevision > 0 &&
        revision.headRefOid !== previousAcceptedHead)
    ) {
      throw invalid("PR Head epoch 历史无效");
    }
    previousHeadRevision = revision.headRevision;
    previousAcceptedHead = revision.headRefOid;
  }
  if (cutoverCount > 1 || previousHeadRevision !== expectedHeadRevision) {
    throw invalid("PR Head epoch 历史无效");
  }
}

function applyLegacyAuthorityCutover(revisions) {
  const accepted = revisions.filter(
    ({ disposition }) => disposition === "accepted",
  );
  if (
    accepted.length < 2 ||
    revisions.some(({ authorityEpochCutover }) => authorityEpochCutover)
  ) {
    return null;
  }
  const latest = accepted.at(-1);
  const predecessor = accepted.at(-2);
  latest.headRevision = predecessor.headRevision + 2;
  latest.authorityEpochChanged = true;
  latest.authorityEpochCutover = true;
  return latest.headRevision;
}

function normalizeBinding(value, revisionsByEvent, previousSequence) {
  const scopeLifecycle = hasExactLedgerKeys(value, SCOPE_LIFECYCLE_BINDING_KEYS);
  if (scopeLifecycle) {
    if (value.scopeLifecycle !== true) throw invalid("PR lifecycle binding 证明无效");
  } else exact(value, BINDING_KEYS, "PR assignment binding");
  const sourceSequence = positiveInteger(
    value.sourceSequence,
    "binding.sourceSequence",
  );
  const eventId = text(value.eventId, "binding.eventId", 192);
  const inputRevision = positiveInteger(
    value.inputRevision,
    "binding.inputRevision",
  );
  if (
    sourceSequence <= previousSequence ||
    revisionsByEvent.get(eventId)?.revision !== inputRevision
  ) {
    throw invalid("PR assignment binding 顺序或输入引用无效");
  }
  return {
    sourceSequence,
    assignmentId: text(value.assignmentId, "binding.assignmentId", 192),
    assignmentDigest: digest(
      value.assignmentDigest,
      "binding.assignmentDigest",
    ),
    eventId,
    inputRevision,
    ...(scopeLifecycle ? { scopeLifecycle: true } : {}),
  };
}

function normalizeEventPointer(
  value,
  source,
  revisionsByEvent,
  expectedRevision,
  name,
) {
  exact(value, CURRENT_KEYS, name);
  const event = storedEvent(value.event);
  const revision = revisionsByEvent.get(event.eventId);
  const current = {
    sourceSequence: positiveInteger(
      value.sourceSequence,
      "current.sourceSequence",
    ),
    eventId: text(value.eventId, "current.eventId", 192),
    eventDigest: digest(value.eventDigest, "current.eventDigest"),
    inputDigest: digest(value.inputDigest, "current.inputDigest"),
    occurredAt: timestamp(value.occurredAt, "current.occurredAt"),
    headRefOid: head(value.headRefOid, "current.headRefOid"),
    event: structuredClone(event),
  };
  if (
    !revision ||
    revision.revision !== expectedRevision ||
    revision.disposition !== "accepted" ||
    current.eventId !== event.eventId ||
    current.eventDigest !== event.contentDigest ||
    current.eventDigest !== revision.eventDigest ||
    current.inputDigest !== revision.inputDigest ||
    current.inputDigest !== sourceInputDigest(source.workKey, event) ||
    current.occurredAt !== event.occurredAt ||
    current.headRefOid !== event.payload.headRefOid ||
    current.headRefOid !== revision.headRefOid
    || (revision.incomingReview !== undefined &&
      (revision.incomingReview.eventId !== event.payload.reviewRequestEventId ||
       Date.parse(revision.incomingReview.receivedAt) !== Date.parse(event.payload.reviewReceivedAt)))
  ) {
    throw invalid("PR current input 绑定无效");
  }
  return current;
}

export function normalizePullRequestWorkSource(value) {
  let headAncestryReceipt;
  if (Object.hasOwn(value, "headAncestryReceipt")) {
    headAncestryReceipt = normalizeHeadAncestryReceipt(value.headAncestryReceipt);
    const { headAncestryReceipt: omitted, ...source } = value;
    value = source;
  }
  const legacySource = hasExactLedgerKeys(value, LEGACY_SOURCE_KEYS);
  const hasBudget = hasExactLedgerKeys(value, BUDGET_SOURCE_KEYS);
  if (!legacySource && !hasBudget) exact(value, SOURCE_KEYS, "PR source");
  if (value.schemaVersion !== 1 || value.kind !== "pull_request") {
    throw invalid("PR source 版本或类型无效");
  }
  const identity = normalizeIdentity(value.identity);
  const workKey = text(value.workKey, "workKey", 128);
  if (workKey !== workKeyFor(identity)) throw invalid("PR workKey 绑定无效");
  const inputRevision = positiveInteger(value.inputRevision, "inputRevision");
  const activeRevision = positiveInteger(value.activeRevision, "activeRevision");
  let headRevision = positiveInteger(value.headRevision, "headRevision");
  const authorityEpoch = legacySource
    ? headRevision
    : positiveInteger(value.authorityEpoch, "authorityEpoch");
  const scope = legacySource
    ? {
        kind: "automatic",
        active: true,
        revision: 1,
        lastLifecycleEventId: null,
      }
    : normalizePullRequestScope(value.scope);
  if (authorityEpoch !== headRevision) {
    throw invalid("PR authority epoch 指针无效");
  }
  const pendingRevision = optionalPositiveInteger(
    value.pendingRevision,
    "pendingRevision",
  );
  const rawRevisions = plainArray(value.revisions, "revisions");
  const hasIncompleteAuthorityHistory = rawRevisions.some((revision) => {
    const { incomingReview, headAncestryProof, ...authority } = revision;
    return !hasExactLedgerKeys(authority, AUTHORITY_REVISION_KEYS) &&
      !hasExactLedgerKeys(authority, REVISION_KEYS) &&
      !hasExactLedgerKeys(authority, SCOPE_REVOCATION_REVISION_KEYS);
  });
  const revisions = rawRevisions.map(
    (revision, index) => normalizeRevision(revision, index + 1),
  );
  if (revisions.length !== inputRevision || activeRevision > inputRevision) {
    throw invalid("PR source revision 指针无效");
  }
  const eventIds = revisions.map(({ eventId }) => eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw invalid("PR source eventId 重复");
  }
  sealLegacyRevisionMetadata(revisions);
  validateRevisionEpochHistory(revisions, headRevision);
  if (hasIncompleteAuthorityHistory) {
    headRevision = applyLegacyAuthorityCutover(revisions) ?? headRevision;
    validateRevisionEpochHistory(revisions, headRevision);
  }
  const acceptedRevisions = revisions.filter(
    ({ disposition }) => disposition === "accepted",
  );
  const latestAccepted = acceptedRevisions.at(-1);
  if (
    !latestAccepted ||
    (pendingRevision === null && activeRevision !== latestAccepted.revision) ||
    (pendingRevision !== null &&
      (pendingRevision !== latestAccepted.revision ||
        pendingRevision <= activeRevision))
  ) {
    throw invalid("PR Head epoch 指针无效");
  }
  const revisionsByEvent = new Map(
    revisions.map((revision) => [revision.eventId, revision]),
  );
  let previousSequence = 0;
  const bindings = plainArray(value.bindings, "bindings").map((binding) => {
    const normalized = normalizeBinding(
      binding,
      revisionsByEvent,
      previousSequence,
    );
    previousSequence = normalized.sourceSequence;
    return normalized;
  });
  if (
    bindings.length === 0 ||
    (scope.kind !== "automatic" && bindings.some(binding => binding.scopeLifecycle === true)) ||
    new Set(bindings.map(({ assignmentId }) => assignmentId)).size !==
      bindings.length
  ) {
    throw invalid("PR assignment binding 历史无效");
  }
  const source = {
    schemaVersion: 1,
    kind: "pull_request",
    workKey,
    identity,
    inputRevision,
    activeRevision,
    headRevision,
    authorityEpoch: headRevision,
    scope,
    pendingRevision,
    current: null,
    pending: null,
    ...(headAncestryReceipt ? { headAncestryReceipt } : {}),
    revisions,
    bindings,
  };
  source.current = normalizeEventPointer(
    value.current,
    source,
    revisionsByEvent,
    activeRevision,
    "PR current input",
  );
  if (pendingRevision === null) {
    if (value.pending !== null) throw invalid("PR pending input 指针无效");
  } else {
    if (value.pending === null) throw invalid("PR pending input 指针无效");
    source.pending = normalizeEventPointer(
      value.pending,
      source,
      revisionsByEvent,
      pendingRevision,
      "PR pending input",
    );
  }
  if (
    !bindings.some(
      ({ sourceSequence, eventId }) =>
        sourceSequence === source.current.sourceSequence &&
        eventId === source.current.eventId,
    )
  ) {
    throw invalid("PR current input 没有分派来源");
  }
  const lastLifecycleRevision = revisionsByEvent.get(
    scope.lastLifecycleEventId,
  );
  const currentLifecycleMatches =
    scope.lastLifecycleEventId === source.current.eventId &&
    ["pull_request.created", "pull_request.left_scope", "pull_request.role_handoff"].includes(
      source.current.event.eventType,
    ) &&
    scope.active ===
      (["pull_request.created", "pull_request.role_handoff"].includes(source.current.event.eventType));
  const historicalLifecycleMatches =
    lastLifecycleRevision?.disposition === "accepted" &&
    lastLifecycleRevision.authorityEpochChanged === true &&
    lastLifecycleRevision.revision < source.activeRevision;
  const pendingAncestryLifecycleMatches = source.scope.active === true && source.pending !== null &&
    source.pending.eventId === source.scope.lastLifecycleEventId && source.pending.event.eventType === "pull_request.created" &&
    revisions.some(revision => revision.headAncestryProof !== undefined && revision.revision < source.pendingRevision &&
      revision.headRefOid === source.pending.headRefOid);
  const rejectedRevocationMatches =
    scope.active === false &&
    lastLifecycleRevision?.scopeRevocationApplied === true &&
    lastLifecycleRevision.disposition !== "accepted";
  if (
    scope.lastLifecycleEventId !== null &&
    !currentLifecycleMatches &&
    !historicalLifecycleMatches &&
    !pendingAncestryLifecycleMatches &&
    !rejectedRevocationMatches
  ) {
    throw invalid("PR scope 生命周期绑定无效");
  }
  if (scope.active === false && !currentLifecycleMatches &&
      !historicalLifecycleMatches &&
      !rejectedRevocationMatches) {
    throw invalid("PR scope 非活动状态缺少生命周期绑定");
  }
  if (
    source.pending !== null &&
    !bindings.some(
      ({ sourceSequence, eventId }) =>
        sourceSequence === source.pending.sourceSequence &&
        eventId === source.pending.eventId,
    )
  ) {
    throw invalid("PR pending input 没有分派来源");
  }
  if (hasBudget) source.decisionBudget = normalizePullRequestDecisionBudget(value.decisionBudget, source);
  for (const receipt of [headAncestryReceipt, ...revisions.map(revision => revision.headAncestryProof)].filter(Boolean)) {
    if (identity.targetRoleId !== "developer" || scope.kind !== "automatic" || receipt.sourceWorkKey !== source.workKey ||
        receipt.rootItemId !== `work-item-${ledgerDigest({ kind: "source_root", workKey })}` ||
        receipt.event.source.provider !== identity.provider || receipt.event.source.scopeId !== identity.scopeId ||
        receipt.event.subject.repository !== identity.repository || receipt.event.subject.number !== identity.pullRequestNumber ||
        !revisions.some(revision => revision.disposition === "accepted" && revision.inputDigest === receipt.sourceInputDigest &&
          revision.headRefOid === receipt.ancestorHeadRefOid && revision.headRevision === receipt.authorityEpoch)) {
      throw invalid("PR ancestry source identity is invalid");
    }
  }
  return source;
}

function normalizePullRequestDecisionBudget(value, source) {
  exact(value, DECISION_BUDGET_KEYS, "PR decision budget");
  const budget = { headRefOid: head(value.headRefOid, "decisionBudget.headRefOid"),
    activationRevision: positiveInteger(value.activationRevision, "decisionBudget.activationRevision"),
    previousActiveRevision: optionalPositiveInteger(value.previousActiveRevision, "decisionBudget.previousActiveRevision"),
    attemptOffset: value.attemptOffset };
  const activated = source.revisions[budget.activationRevision - 1];
  const previous = budget.previousActiveRevision === null ? null : source.revisions[budget.previousActiveRevision - 1];
  if (!Number.isSafeInteger(budget.attemptOffset) || budget.attemptOffset < 0 ||
      budget.headRefOid !== source.current.headRefOid || budget.activationRevision > source.activeRevision ||
      activated?.disposition !== "accepted" || activated.headRefOid !== budget.headRefOid ||
      (previous === null ? budget.activationRevision !== 1 || budget.attemptOffset !== 0 :
        previous?.disposition !== "accepted" || previous.revision >= budget.activationRevision || previous.headRefOid === budget.headRefOid)) {
    throw invalid("PR decision budget activation 绑定无效");
  }
  return budget;
}

function applyPullRequestDecisionBudgetAtActivation(previousSource, nextSource, attemptAtActivation) {
  if (previousSource.current.headRefOid === nextSource.current.headRefOid) return nextSource;
  if (!Number.isSafeInteger(attemptAtActivation) || attemptAtActivation < 0) {
    throw invalid("实际 PR Head 激活缺少可信领取计数");
  }
  return { ...nextSource, decisionBudget: {
    headRefOid: nextSource.current.headRefOid,
    activationRevision: nextSource.activeRevision,
    previousActiveRevision: previousSource.activeRevision,
    attemptOffset: attemptAtActivation,
  } };
}

export function persistedPullRequestDecisionAttemptBudget(item) {
  const budget = item?.source?.decisionBudget;
  if (item?.kind !== "source_root" || item.source?.kind !== "pull_request" || !budget) return null;
  return Object.freeze({ attempt: item.attempt - budget.attemptOffset, offset: budget.attemptOffset, decisionBudget: budget });
}

export function currentWorkItemEvent(item) {
  return item?.source?.kind === "pull_request"
    ? item.source.current.event
    : item?.event;
}

// Keep the lifetime claim counter intact; only a proven accepted Head change
// opens a new decision budget. Metadata-only and authority updates do not.
export function pullRequestDecisionAttemptBudget(item, timeline, { initialActiveRevision = null } = {}) {
  const source = item?.source;
  if (item?.kind !== "source_root" || source?.kind !== "pull_request" ||
      !Array.isArray(timeline)) return null;
  const headRefOid = source.current.headRefOid;
  const accepted = source.revisions.filter((revision) =>
    revision.disposition === "accepted" && revision.revision <= source.activeRevision);
  if (!accepted.some(revision => revision.headRefOid !== headRefOid)) return null;
  const ordered = timeline.filter((entry) => entry.itemId === item.itemId)
    .toSorted((left, right) => left.sequence - right.sequence);
  let actualActive = initialActiveRevision === null ? null :
    accepted.find(revision => revision.revision === initialActiveRevision) ?? null;
  if (initialActiveRevision !== null && actualActive === null) return null;
  let activation = null;
  let previous = null;
  for (const entry of ordered) {
    if (!["pr_source_created", "pr_source_revised", "pr_source_activated"].includes(entry.type) ||
        entry.details?.workKey !== source.workKey) continue;
    const activeRevision = entry.details.activeRevision ?? (entry.type === "pr_source_created" ? entry.details.inputRevision : null);
    const active = accepted.find(revision => revision.revision === activeRevision &&
      revision.headRefOid === (entry.details.currentHeadRefOid ?? entry.details.headRefOid) &&
      revision.headRefOid === entry.details.headRefOid &&
      (entry.details.headRevision === undefined || revision.headRevision === entry.details.headRevision));
    if (!active) continue;
    if (actualActive !== null && active.headRefOid !== actualActive.headRefOid) {
      previous = actualActive;
      activation = entry;
    }
    actualActive = active;
  }
  if (!activation || actualActive?.headRefOid !== headRefOid || !previous || previous.headRefOid === headRefOid) return null;
  if (activation.details.previousActiveRevision !== undefined && activation.details.previousActiveRevision !== previous.revision) return null;
  let offset = activation.details.decisionAttemptOffset;
  if (offset === undefined) {
    const priorClaim = ordered.findLast((entry) => entry.sequence < activation.sequence && entry.type === "claimed");
    const claimSource = accepted.find((revision) => revision.inputDigest === priorClaim?.details?.inputDigest);
    const intervening = ordered.filter((entry) => entry.sequence > priorClaim?.sequence && entry.sequence < activation.sequence);
    // Legacy activations did not record the counter. Recover it only from a
    // retained old-Head claim followed by side-effect-free wait bookkeeping.
    if (!priorClaim || claimSource?.headRefOid !== previous.headRefOid ||
        intervening.some((entry) => ![
          "intent_staged", "intent_claimed", "intent_bound", "intent_acknowledged",
          "condition_satisfied", "intent_superseded", "pr_source_revised",
        ].includes(entry.type) ||
          (entry.type === "intent_staged" && entry.details?.intentType !== "wait_condition") ||
          (entry.type === "intent_acknowledged" && (entry.details?.outcome !== "delivered" ||
            entry.details.nextStatus !== "waiting_condition")))) return null;
    offset = priorClaim.details.attempt;
  } else if (activation.details.previousHeadRefOid !== previous.headRefOid) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.attempt) return null;
  const decisionBudget = { headRefOid, activationRevision: activation.details.activeRevision,
    previousActiveRevision: previous.revision, attemptOffset: offset };
  if (source.decisionBudget && !isDeepStrictEqual(source.decisionBudget, decisionBudget)) return null;
  return Object.freeze({ attempt: item.attempt - offset, offset, activation, decisionBudget,
    events: ordered.filter((entry) => entry.sequence > activation.sequence) });
}

export function sealLegacyPullRequestDecisionBudget(item, timeline) {
  if (item.source?.decisionBudget) return item.source;
  const proof = pullRequestDecisionAttemptBudget(item, timeline);
  return proof === null ? item.source : { ...item.source, decisionBudget: proof.decisionBudget };
}

export function isPullRequestDecisionBudgetRecoveryCandidate(item) {
  return item.kind === "source_root" && item.source?.kind === "pull_request" &&
      item.source.decisionBudget === undefined &&
      item.status === "blocked" && item.statusReason === "decision_attempts_exhausted" &&
      item.activeIntentId === null && item.decisionContext === null && item.sourceQuarantine === null &&
      item.ownerId === null && item.leaseId === null && item.leaseUntil === null &&
      item.source.pendingRevision === null && item.source.scope.active === true;
}

export function canRecoverPullRequestDecisionBudget(item, budget, maxAttempts) {
  if (!budget || !Array.isArray(budget.events) || !budget.activation || budget.offset < 1 || budget.attempt >= maxAttempts ||
      !isPullRequestDecisionBudgetRecoveryCandidate(item)) return false;
  const latest = budget.events.findLast((entry) => entry.type !== "pr_source_revised");
  if (latest?.type !== "transitioned" ||
      latest.details?.fromStatus !== "working" || latest.details.toStatus !== "blocked" ||
      latest.details.reason !== "decision_attempts_exhausted") return false;
  const sourceTail = budget.events.filter((entry) => entry.sequence > latest.sequence);
  if ((sourceTail.at(-1) ?? latest).at !== item.updatedAt || sourceTail.some((entry) =>
    entry.type !== "pr_source_revised" || entry.details?.workKey !== item.source.workKey ||
    !["accepted", "bound_existing_event"].includes(entry.details.disposition) ||
    entry.details.pendingRevision !== null || entry.details.headRefOid !== item.source.current.headRefOid ||
    !item.source.revisions.some((revision) => revision.disposition === "accepted" &&
      revision.revision === entry.details.activeRevision && revision.revision <= item.source.activeRevision &&
      revision.headRevision === entry.details.headRevision && revision.headRefOid === item.source.current.headRefOid)
  ) || (sourceTail.length > 0 && sourceTail.at(-1).details.activeRevision !== item.source.activeRevision)) return false;
  const claims = budget.events.filter((entry) => entry.type === "claimed");
  if (claims.at(-1)?.details?.attempt !== item.attempt || claims.some((entry) =>
    !item.source.revisions.some((revision) => revision.disposition === "accepted" &&
      revision.revision <= item.source.activeRevision && revision.headRefOid === item.source.current.headRefOid &&
      revision.inputDigest === entry.details?.inputDigest))) return false;
  return budget.events.every((entry) =>
    ["claimed", "retry_scheduled", "pr_source_revised"].includes(entry.type) ||
    (entry.type === "transitioned" && (
      (entry.details?.fromStatus === "working" && entry.details.toStatus === "blocked" &&
        entry.details.reason === "decision_attempts_exhausted") ||
      (entry.details?.fromStatus === "blocked" && entry.details.toStatus === "queued" &&
        entry.details.reason === "pr_head_decision_budget_recovered")
    )));
}

export function currentWorkItemInputBinding(item) {
  if (item?.source?.kind === "pull_request") {
    const revision = item.source.revisions[item.source.activeRevision - 1];
    return Object.freeze({
      kind: "pull_request",
      rootItemId: item.itemId,
      workKey: item.source.workKey,
      inputRevision: item.source.activeRevision,
      headRevision: revision.headRevision,
      headRefOid: item.source.current.headRefOid,
      eventId: item.source.current.eventId,
      eventDigest: item.source.current.eventDigest,
      inputDigest: item.source.current.inputDigest,
    });
  }
  const inherited = item?.kind === "graph_task"
    ? item.assignment?.graphTask?.sourceBinding
    : null;
  return inherited === null || inherited === undefined
    ? null
    : Object.freeze(normalizePullRequestInputBinding(inherited));
}

// A retained result describes the input that originally produced it. Historical
// identity can settle that result; it never grants execution on the current input.
export function matchesHistoricalPullRequestInputBinding(item, binding) {
  const source = item?.source;
  if (source?.kind !== "pull_request" || binding?.kind !== "pull_request" || binding.rootItemId !== item.itemId ||
      binding.workKey !== source.workKey || !Number.isSafeInteger(binding.inputRevision) || binding.inputRevision < 1 ||
      binding.inputRevision >= source.activeRevision) return false;
  const revision = source.revisions[binding.inputRevision - 1];
  return revision?.disposition === "accepted" && revision.revision === binding.inputRevision &&
    ["headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"].every(key => revision[key] === binding[key]) &&
    source.bindings.some(entry => entry.inputRevision === binding.inputRevision && entry.eventId === binding.eventId);
}

export function currentWorkItemExecutionBinding(item) {
  const sourceBinding = currentWorkItemInputBinding(item);
  if (sourceBinding === null) return null;
  try {
    return createPullRequestExecutionBinding({
      sourceBinding,
      event: currentWorkItemEvent(item),
    });
  } catch {
    return null;
  }
}

export function normalizePullRequestInputBinding(value) {
  exact(value, INPUT_BINDING_KEYS, "PR input binding");
  if (value.kind !== "pull_request") throw invalid("PR input binding 类型无效");
  return {
    kind: "pull_request",
    rootItemId: text(value.rootItemId, "inputBinding.rootItemId", 192),
    workKey: text(value.workKey, "inputBinding.workKey", 128),
    inputRevision: positiveInteger(
      value.inputRevision,
      "inputBinding.inputRevision",
    ),
    headRevision: positiveInteger(
      value.headRevision,
      "inputBinding.headRevision",
    ),
    headRefOid: head(value.headRefOid, "inputBinding.headRefOid"),
    eventId: text(value.eventId, "inputBinding.eventId", 192),
    eventDigest: digest(value.eventDigest, "inputBinding.eventDigest"),
    inputDigest: digest(value.inputDigest, "inputBinding.inputDigest"),
  };
}

function samePullRequestSourceSubject(left, right) {
  return Boolean(
    left?.source?.kind === "pull_request" &&
      right?.source?.kind === "pull_request" &&
      left.source.identity.subjectId === right.source.identity.subjectId &&
      left.source.identity.repository === right.source.identity.repository &&
      left.source.identity.pullRequestNumber ===
        right.source.identity.pullRequestNumber,
  );
}

export function pendingInternalReviewMatchesDiscovery(root, event) {
  if (root?.source?.scope?.kind !== "internal_review" || root.source.scope.active !== true ||
      root.sourceQuarantine !== null || root.source.pendingRevision !== null ||
      ["completed", "cancelled", "superseded"].includes(root.status) ||
      root.statusReason === "pr_source_cross_root_cutover_retired" ||
      event?.source?.provider !== "github" || ["closed", "merged"].includes(event.payload.state) ||
      root.source.identity.subjectId !== event.subject.id ||
      root.source.identity.repository !== event.subject.repository ||
      root.source.identity.pullRequestNumber !== event.subject.number) return false;
  const current = root.source.current.event;
  return current.eventType === "pull_request.internal_review_requested" &&
    current.payload.gitTargetAvailable === true && event.payload.gitTargetAvailable === true &&
    samePullRequestGitTarget(current.payload.gitTarget, event.payload.gitTarget);
}

function pointerForRevision(source, revision) {
  if (revision === source.activeRevision) return source.current;
  if (revision === source.pendingRevision) return source.pending;
  return null;
}

function gitTargetStateForEvent(event) {
  const target = pullRequestGitTargetFromEvent(event);
  if (
    hasGitTargetMarker(event) &&
    event.payload.gitTargetAvailable === false
  ) {
    if (target !== null) throw invalid("PR Git target 事件无效");
    return "unavailable";
  }
  if (target !== null) return "available";
  if (hasGitTargetMarker(event)) {
    throw invalid("PR Git target 事件无效");
  }
  return "legacy";
}

function subjectSourceObservations(item) {
  const source = normalizePullRequestWorkSource(item.source);
  const revisions = new Map(
    source.revisions.map((revision) => [revision.revision, revision]),
  );
  const firstBindings = new Map();
  for (const binding of source.bindings) {
    if (!firstBindings.has(binding.inputRevision)) {
      firstBindings.set(binding.inputRevision, binding);
    }
  }
  return {
    item,
    source,
    observations: [...firstBindings.values()].map((binding) => {
      const revision = revisions.get(binding.inputRevision);
      const pointer = pointerForRevision(source, revision.revision);
      const occurredAtMs = Date.parse(revision.occurredAt);
      if (!Number.isFinite(occurredAtMs)) {
        throw invalid("PR 来源事件时间无效");
      }
      return {
        item,
        source,
        binding,
        sourceSequence: binding.sourceSequence,
        revision,
        pointer,
        occurredAtMs,
      };
    }),
  };
}

function samePullRequestLifecycleObservation(left, right) {
  const leftMarked = left.binding.scopeLifecycle === true;
  const rightMarked = right.binding.scopeLifecycle === true;
  const trustedBindingProof = (leftMarked && rightMarked) ||
    (leftMarked && !rightMarked && right.source.identity.targetRoleId === "pr-engineer") ||
    (rightMarked && !leftMarked && left.source.identity.targetRoleId === "pr-engineer");
  return left.source.scope.kind === "automatic" && right.source.scope.kind === "automatic" &&
    trustedBindingProof &&
    left.source.identity.targetRoleId !== right.source.identity.targetRoleId &&
    ["provider", "scopeId", "subjectId", "repository", "pullRequestNumber"]
      .every(key => left.source.identity[key] === right.source.identity[key]) &&
    ["assignmentId", "assignmentDigest", "eventId"]
      .every(key => left.binding[key] === right.binding[key]) &&
    ["eventDigest", "occurredAt", "headRefOid", "previousHeadRefOid"]
      .every(key => left.revision[key] === right.revision[key]);
}

function evaluatePullRequestSubjectAuthority(state, root, preserveInactiveHistory = true, preserveInternalReview = true) {
  if (
    root?.source?.kind !== "pull_request" ||
    !Array.isArray(state?.items)
  ) {
    return null;
  }
  const candidates = state.items
    .filter((candidate) => samePullRequestSourceSubject(candidate, root))
    .map(subjectSourceObservations);
  const observations = candidates
    .flatMap(({ observations: entries }) => entries)
    .sort((left, right) => left.sourceSequence - right.sourceSequence);
  if (observations.length === 0) return null;
  const observationsBySequence = new Map();
  for (const observation of observations) {
    const sameSequence = observationsBySequence.get(observation.sourceSequence) ?? [];
    if (sameSequence.some(previous => !samePullRequestLifecycleObservation(previous, observation))) return null;
    sameSequence.push(observation);
    observationsBySequence.set(observation.sourceSequence, sameSequence);
  }
  const markerRequired = candidates.some(({ source }) =>
    [source.current, source.pending]
      .filter((pointer) => pointer !== null)
      .some(({ event }) => gitTargetStateForEvent(event) !== "legacy")
  );
  let predecessor = null;
  let canonical = null;
  const validAuthorities = new Map();
  const selectLatestValidAuthority = () => {
    const ordered = [...validAuthorities.values()].sort((left, right) => right.sourceSequence - left.sourceSequence);
    const latest = ordered[0] ?? null;
    if (!preserveInternalReview || latest?.source.scope.kind !== "automatic") return latest;
    return ordered.find(entry => pendingInternalReviewMatchesDiscovery(entry.item, latest.pointer.event)) ?? latest;
  };
  let trustedOccurredAtWatermark = Number.NEGATIVE_INFINITY;
  let trustedEvent = null;
  let trustedObservation = null;
  let authorityFenced = false;
  for (const observation of observations) {
    const gitTargetState = observation.pointer === null
      ? null
      : gitTargetStateForEvent(observation.pointer.event);
    const sourceInactive = observation.source.scope.active === false;
    const authorityNegative =
      observation.item.sourceQuarantine !== null ||
      isAuthorityFenceDisposition(observation.revision.disposition) ||
      (observation.pointer !== null &&
        (gitTargetState === "unavailable" ||
          (markerRequired && gitTargetState === "legacy")));
    if (sourceInactive) {
      validAuthorities.delete(observation.item.itemId);
      canonical = selectLatestValidAuthority();
      authorityFenced = canonical === null;
      // Leaving scope revokes execution authority, not an already accepted
      // causal bridge used by a later, independently active provenance.
      if (
        preserveInactiveHistory &&
        !authorityNegative &&
        observation.revision.disposition === "accepted" &&
        observation.occurredAtMs >= trustedOccurredAtWatermark &&
        (predecessor === null ||
          observation.revision.headRefOid === predecessor.revision.headRefOid ||
          observation.revision.previousHeadRefOid === predecessor.revision.headRefOid ||
          observation.revision.headAncestryProof?.ancestorHeadRefOid === predecessor.revision.headRefOid)
      ) {
        predecessor = observation;
        if (
          observation.pointer !== null &&
          (markerRequired ? gitTargetState === "available" : gitTargetState === "legacy")
        ) {
          trustedOccurredAtWatermark = Math.max(
            trustedOccurredAtWatermark,
            observation.occurredAtMs,
          );
        }
      }
      continue;
    }
    if (authorityNegative) {
      const independentOwnerAuthority = [...validAuthorities.values()].some(
        (candidate) =>
          candidate.item.itemId !== observation.item.itemId &&
          ["owner_requested", "internal_review"].includes(candidate.source.scope.kind),
      );
      if (independentOwnerAuthority) {
        validAuthorities.delete(observation.item.itemId);
        canonical = selectLatestValidAuthority();
        authorityFenced = false;
      } else {
        validAuthorities.clear();
        canonical = null;
        authorityFenced = true;
      }
      continue;
    }
    const exactFenceRecovery =
      authorityFenced &&
      observation.pointer !== null &&
      trustedEvent !== null &&
      sameEventExecutionAuthority(
        trustedEvent,
        observation.pointer.event,
      );
    if (
      !["owner_requested", "internal_review"].includes(observation.source.scope.kind) &&
      observation.occurredAtMs < trustedOccurredAtWatermark &&
      !exactFenceRecovery
    ) {
      continue;
    }
    const ownerRequestedAnchor =
      (observation.source.scope.kind === "owner_requested" &&
       observation.pointer?.event.eventType === "pull_request.owner_requested") ||
      (observation.source.scope.kind === "internal_review" &&
       observation.pointer?.event.eventType === "pull_request.internal_review_requested");
    const causal = ownerRequestedAnchor || predecessor === null ||
      observation.revision.headRefOid === predecessor.revision.headRefOid ||
      observation.revision.previousHeadRefOid === predecessor.revision.headRefOid ||
      observation.revision.headAncestryProof?.ancestorHeadRefOid === predecessor.revision.headRefOid;
    if (!causal) {
      validAuthorities.clear();
      canonical = null;
      authorityFenced = true;
      continue;
    }
    if (observation.revision.disposition !== "accepted") {
      if (observation.revision.disposition === "ignored_unproven_head") {
        validAuthorities.clear();
        canonical = null;
        authorityFenced = true;
      }
      continue;
    }
    predecessor = observation;
    const targetAuthorityCurrent = observation.pointer === null ||
      (markerRequired
        ? gitTargetState === "available"
        : gitTargetState === "legacy");
    if (
      observation.revision.disposition === "accepted" &&
      targetAuthorityCurrent &&
      observation.pointer !== null
    ) {
      trustedOccurredAtWatermark = Math.max(
        trustedOccurredAtWatermark,
        observation.occurredAtMs,
      );
      trustedEvent = observation.pointer.event;
      trustedObservation = observation;
    }
    const executable =
      observation.pointer !== null &&
      targetAuthorityCurrent;
    if (executable) {
      const retainInternalReview = preserveInternalReview && observation.source.scope.kind === "automatic" &&
        pendingInternalReviewMatchesDiscovery(canonical?.item, observation.pointer.event);
      if (
        canonical !== null &&
        canonical.item.itemId !== observation.item.itemId && !retainInternalReview
      ) {
        validAuthorities.clear();
      }
      validAuthorities.set(observation.item.itemId, observation);
      canonical = selectLatestValidAuthority();
      authorityFenced = false;
    }
  }
  return {
    canonical,
    predecessor,
    authorityFenced,
    trustedObservation,
  };
}

function canonicalPullRequestSourceRoot(state, root, preserveInactiveHistory = true, preserveInternalReview = true) {
  try {
    return evaluatePullRequestSubjectAuthority(state, root, preserveInactiveHistory, preserveInternalReview)?.canonical?.item ??
      null;
  } catch {
    return null;
  }
}

export function pullRequestTrustedPredecessor(state, root) {
  try {
    const authority = evaluatePullRequestSubjectAuthority(state, root);
    const predecessor = authority?.predecessor;
    if (predecessor === null || predecessor === undefined) return null;
    return Object.freeze({
      headRefOid: predecessor.revision.headRefOid,
      sourceRootItemId: predecessor.item.itemId,
      sourceSequence: predecessor.sourceSequence,
      canonicalRootItemId: authority.canonical?.item?.itemId ?? null,
      authorityFenced: authority.authorityFenced === true,
      lastTrustedRootItemId:
        authority.trustedObservation?.item?.itemId ?? null,
      trustedSourceRootItemId:
        authority.trustedObservation?.item?.itemId ?? null,
    });
  } catch {
    return null;
  }
}

export function pullRequestTrustedPredecessorHead(state, root) {
  return pullRequestTrustedPredecessor(state, root)?.headRefOid ?? null;
}

function headAdmission(state, item, preserveInactiveHistory, canonicalRootFor = canonicalPullRequestSourceRoot) {
  const binding = currentWorkItemInputBinding(item);
  if (binding === null) {
    return Object.freeze({ applies: false, current: true, pending: false });
  }
  const root = state?.items?.find(
    (candidate) => candidate.itemId === binding.rootItemId,
  );
  const current = root?.source?.kind === "pull_request"
    ? currentWorkItemInputBinding(root)
    : null;
  const boundEvent = currentWorkItemEvent(item);
  const currentEvent = root?.source?.kind === "pull_request"
    ? currentWorkItemEvent(root)
    : null;
  const canonicalRoot = canonicalRootFor(state, root, preserveInactiveHistory);
  const crossRootCutoverPending = state.items.some(
    (candidate) =>
      samePullRequestSourceSubject(candidate, root) &&
      typeof candidate.statusReason === "string" &&
      candidate.statusReason.startsWith(
        CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
      ),
  );
  const registeredCrossRootParticipant = crossRootProtectedParticipant(
    state,
    item,
    binding,
  );
  let targetMatches = false;
  try {
    const boundTarget = pullRequestGitTargetFromEvent(boundEvent);
    const currentTarget = pullRequestGitTargetFromEvent(currentEvent);
    const provenanceMatches =
      boundEvent?.source?.provider === currentEvent?.source?.provider &&
      boundEvent?.source?.scopeId === currentEvent?.source?.scopeId;
    targetMatches = provenanceMatches && (boundTarget === null || currentTarget === null
      ? boundTarget === null &&
        currentTarget === null &&
        boundEvent?.payload?.gitTargetAvailable === undefined &&
        currentEvent?.payload?.gitTargetAvailable === undefined
      : samePullRequestGitTarget(boundTarget, currentTarget));
  } catch {
    targetMatches = false;
  }
  const matches =
    current !== null &&
    binding.workKey === current.workKey &&
    binding.headRevision === current.headRevision &&
    binding.headRefOid === current.headRefOid &&
    targetMatches &&
    (canonicalRoot?.itemId === root?.itemId ||
      registeredCrossRootParticipant);
  return Object.freeze({
    applies: true,
    current: matches,
    pending:
      root?.source?.kind === "pull_request" &&
      (root.source.pendingRevision !== null || crossRootCutoverPending),
    rootItemId: binding.rootItemId,
    headRevision: binding.headRevision,
    currentHeadRevision: current?.headRevision ?? null,
  });
}

export function pullRequestHeadAdmission(state, item) {
  return headAdmission(state, item, true);
}

// Share subject evaluation only within one synchronous snapshot read. No cache
// survives a ledger mutation, including changes to another root for the PR.
export function pullRequestHeadAdmissions(state, items, { preserveInactiveHistory = true, preserveInternalReview = true } = {}) {
  const canonicalRoots = new Map();
  const canonicalRootFor = (snapshot, root, preserve) => {
    if (root?.source?.kind !== "pull_request") return null;
    const identity = root.source.identity;
    const key = JSON.stringify([identity.subjectId, identity.repository, identity.pullRequestNumber]);
    if (!canonicalRoots.has(key)) {
      canonicalRoots.set(key, canonicalPullRequestSourceRoot(snapshot, root, preserve, preserveInternalReview));
    }
    return canonicalRoots.get(key);
  };
  return items.map(item => headAdmission(state, item, preserveInactiveHistory, canonicalRootFor));
}

// Only persisted schema 11/12 projection validation uses the former policies.
// Execution and all newly persisted authority continue using the current one.
export function pullRequestHeadAdmissionForSchema11Migration(state, item) {
  return headAdmission(state, item, false, (snapshot, root, preserve) =>
    canonicalPullRequestSourceRoot(snapshot, root, preserve, false));
}

export function pullRequestHeadAdmissionForSchema12Migration(state, item) {
  return headAdmission(state, item, true, (snapshot, root, preserve) =>
    canonicalPullRequestSourceRoot(snapshot, root, preserve, false));
}

export function verifyPullRequestExecutionBinding(state, value) {
  let binding;
  try {
    binding = normalizePullRequestExecutionBinding(value);
  } catch {
    throw invalid(
      "PR 执行输入绑定无效",
      "WORK_LEDGER_PR_EXECUTION_BINDING_INVALID",
    );
  }
  const root = state?.items?.find(
    (candidate) => candidate.itemId === binding.rootItemId,
  );
  if (
    !root ||
    root.source?.kind !== "pull_request" ||
    root.sourceQuarantine !== null
  ) {
    throw invalid(
      "PR 执行输入来源已不可用",
      "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
  const source = normalizePullRequestWorkSource(root.source);
  const admission = pullRequestHeadAdmission(state, root);
  const current = currentWorkItemInputBinding(root);
  const revision = source.revisions.find(
    (candidate) => candidate.revision === binding.inputRevision,
  );
  const sourceBinding = source.bindings.find(
    (candidate) =>
      candidate.inputRevision === binding.inputRevision &&
      candidate.eventId === binding.eventId,
  );
  if (
    source.workKey !== binding.workKey ||
    source.identity.repository !== binding.repository ||
    source.identity.pullRequestNumber !== binding.pullRequestNumber ||
    revision?.disposition !== "accepted" ||
    revision.eventId !== binding.eventId ||
    revision.eventDigest !== binding.eventDigest ||
    revision.inputDigest !== binding.inputDigest ||
    revision.headRevision !== binding.headRevision ||
    revision.headRefOid !== binding.headRefOid ||
    sourceBinding === undefined ||
    current === null ||
    current.workKey !== binding.workKey ||
    current.headRevision !== binding.headRevision ||
    current.headRefOid !== binding.headRefOid ||
    !pullRequestExecutionTargetMatchesEvent(binding, source.current.event) ||
    admission.current !== true ||
    admission.pending !== false
  ) {
    throw invalid(
      "PR 执行输入已不再对应当前 Head",
      "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
  return Object.freeze(binding);
}

export function activatePendingPullRequestWorkSource(value, { attemptAtActivation } = {}) {
  const source = normalizePullRequestWorkSource(value);
  if (source.pendingRevision === null) {
    return { source, changed: false };
  }
  return {
    source: normalizePullRequestWorkSource(applyPullRequestDecisionBudgetAtActivation(source, {
      ...source,
      activeRevision: source.pendingRevision,
      pendingRevision: null,
      current: source.pending,
      pending: null,
    }, attemptAtActivation)),
    changed: true,
  };
}

export function hasPendingPullRequestSource(item) {
  return item?.source?.kind === "pull_request" &&
    item.source.pendingRevision !== null;
}

function validPullRequestScopeTransition(previousSource, nextSource) {
  const previousScope = previousSource.scope;
  const nextScope = nextSource.scope;
  if (nextScope.revision < previousScope.revision) return false;
  if (nextScope.revision === previousScope.revision) {
    return isDeepStrictEqual(previousScope, nextScope);
  }
  const advances = nextScope.revision - previousScope.revision;
  if (advances === 1 && nextScope.active === true &&
      acceptedCreatedLifecycleJoin(previousSource, nextScope.lastLifecycleEventId) &&
      nextSource.authorityEpoch === previousSource.authorityEpoch &&
      nextSource.bindings.slice(previousSource.bindings.length).some(binding =>
        binding.scopeLifecycle === true && binding.eventId === nextScope.lastLifecycleEventId &&
        binding.inputRevision === previousSource.activeRevision)) return true;
  const appendedRevisions = nextSource.revisions.slice(
    previousSource.revisions.length,
  );
  const authorityChanges = appendedRevisions.filter(
    ({ disposition, authorityEpochChanged }) =>
      disposition === "accepted" && authorityEpochChanged,
  ).length;
  const rejectedRevocations = appendedRevisions.filter(
    ({ disposition, scopeRevocationApplied }) =>
      disposition !== "accepted" && scopeRevocationApplied === true,
  ).length;
  const lastLifecycleRevision = nextSource.revisions.find(
    ({ eventId }) => eventId === nextScope.lastLifecycleEventId,
  );
  return (
    advances <= appendedRevisions.length &&
    advances <= authorityChanges + rejectedRevocations &&
    nextSource.authorityEpoch - previousSource.authorityEpoch >=
      advances - rejectedRevocations &&
    nextScope.active ===
      (advances % 2 === 0 ? previousScope.active : !previousScope.active) &&
    nextScope.lastLifecycleEventId !==
      previousScope.lastLifecycleEventId &&
    (nextSource.current.eventId === nextScope.lastLifecycleEventId ||
      lastLifecycleRevision?.scopeRevocationApplied === true) &&
    (lastLifecycleRevision?.scopeRevocationApplied === true ||
      ["pull_request.created", "pull_request.left_scope", "pull_request.role_handoff"].includes(
        nextSource.current.event.eventType,
      ))
  );
}

export function validatePullRequestSourceTransition(previousItems, nextItems, previousTimeline = [], nextTimeline = []) {
  const nextById = new Map(nextItems.map((item) => [item.itemId, item]));
  for (const previous of previousItems) {
    if (previous.source?.kind !== "pull_request") continue;
    const next = nextById.get(previous.itemId);
    if (!next || next.source?.kind !== "pull_request") {
      throw invalid("PR source root 不能删除", "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID");
    }
    const previousSource = normalizePullRequestWorkSource(previous.source);
    const nextSource = normalizePullRequestWorkSource(next.source);
    const beforeBudget = previousSource.decisionBudget;
    const afterBudget = nextSource.decisionBudget;
    const headChanged = previousSource.current.headRefOid !== nextSource.current.headRefOid;
    let validBudget = isDeepStrictEqual(beforeBudget, afterBudget);
    if (headChanged) {
      // One intake can activate a Head and then advance its metadata. The
      // committed active pointer anchors the proof even after old timeline trim.
      const proof = pullRequestDecisionAttemptBudget(next,
        nextTimeline.filter(entry => entry.sequence > (previousTimeline.at(-1)?.sequence ?? 0)),
        { initialActiveRevision: previousSource.activeRevision });
      validBudget = afterBudget !== undefined &&
        proof !== null && isDeepStrictEqual(afterBudget, proof.decisionBudget) &&
        afterBudget.activationRevision > previousSource.activeRevision &&
        afterBudget.activationRevision <= nextSource.activeRevision &&
        afterBudget.previousActiveRevision === previousSource.activeRevision &&
        afterBudget.attemptOffset === previous.attempt &&
        nextSource.revisions.slice(afterBudget.activationRevision - 1, nextSource.activeRevision)
          .every((revision) => revision.disposition !== "accepted" ||
            revision.headRefOid === afterBudget.headRefOid);
    } else if (beforeBudget === undefined && afterBudget !== undefined) {
      const proof = pullRequestDecisionAttemptBudget(previous, previousTimeline);
      validBudget = next.status === "working" && next.revision === previous.revision + 1 &&
        next.attempt === previous.attempt + 1 && next.activeIntentId === null &&
        ["queued", "retry_wait", "working"].includes(previous.status) && proof !== null &&
        isDeepStrictEqual(afterBudget, proof.decisionBudget);
    }
    if (
      previousSource.workKey !== nextSource.workKey ||
      !validBudget ||
      nextSource.inputRevision < previousSource.inputRevision ||
      nextSource.activeRevision < previousSource.activeRevision ||
      nextSource.headRevision < previousSource.headRevision ||
      nextSource.authorityEpoch < previousSource.authorityEpoch ||
      !validPullRequestScopeTransition(previousSource, nextSource) ||
      (previousSource.pendingRevision !== null &&
        nextSource.pendingRevision !== null &&
        nextSource.pendingRevision < previousSource.pendingRevision) ||
      (previousSource.pendingRevision !== null &&
        nextSource.pendingRevision === null &&
        nextSource.activeRevision < previousSource.pendingRevision) ||
      (nextSource.activeRevision === previousSource.activeRevision &&
        !isDeepStrictEqual(previousSource.current, nextSource.current)) ||
      (nextSource.pendingRevision === previousSource.pendingRevision &&
        !isDeepStrictEqual(previousSource.pending, nextSource.pending)) ||
      !isDeepStrictEqual(
        previousSource.revisions,
        nextSource.revisions.slice(0, previousSource.revisions.length),
      ) ||
      !isDeepStrictEqual(
        previousSource.bindings,
        nextSource.bindings.slice(0, previousSource.bindings.length),
      )
    ) {
      throw invalid(
        "PR source history 只能追加",
        "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
      );
    }
  }
}
