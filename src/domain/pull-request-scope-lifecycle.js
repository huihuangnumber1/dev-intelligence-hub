export const PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID =
  "system-pull-request-scope-lifecycle";
export const PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY = 10_000;
export const PULL_REQUEST_SCOPE_LIFECYCLE_REASON =
  "系统可信 PR 自动发现范围生命周期";
export const PULL_REQUEST_SCOPE_LIFECYCLE_TARGET = Object.freeze({
  type: "node",
  id: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
});

const LIFECYCLE_EVENT_TYPES = new Set([
  "pull_request.role_handoff",
  "pull_request.created",
  "pull_request.left_scope",
]);

export function isPullRequestScopeLifecycleEventType(eventType) {
  return LIFECYCLE_EVENT_TYPES.has(eventType);
}

export function isTrustedPullRequestScopeLifecycleAssignment(
  assignment,
  event,
) {
  return Boolean(
    isPullRequestScopeLifecycleEventType(event?.eventType) &&
      assignment?.eventId === event.eventId &&
      assignment.eventType === event.eventType &&
      assignment.ruleId === PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID &&
      assignment.priority === PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY &&
      assignment.reason === PULL_REQUEST_SCOPE_LIFECYCLE_REASON &&
      assignment.target?.type === PULL_REQUEST_SCOPE_LIFECYCLE_TARGET.type &&
      assignment.target?.id === PULL_REQUEST_SCOPE_LIFECYCLE_TARGET.id,
  );
}
