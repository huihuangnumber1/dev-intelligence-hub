const OWNER_EVENTS = new Set(["owner_request.created", "pull_request.owner_requested", "issue.owner_requested"]);

// Inputs are normalized host records. Children inherit source events, but do
// not own the admitted goal. This is a derived control view, never a permission
// supplied by a model or an actor-name override for the trusted owner channel.
export function coordinatorGoalControl({ rootTaskId, parentTaskId, event, source = null, childTaskIds = [] }) {
  if (parentTaskId !== null) return null;
  const ownerOrigin = source?.kind === "pull_request"
    ? source.identity.provider === "local-owner" && source.scope.kind === "owner_requested"
    : event?.source?.provider === "local-owner" && OWNER_EVENTS.has(event.eventType);
  if (!ownerOrigin) return null;
  return Object.freeze({
    rootTaskId,
    owner: "local-owner",
    cancellableTaskIds: Object.freeze([...new Set(childTaskIds)].filter(id => id !== rootTaskId).sort()),
  });
}

export function permitsCoordinatorCancellation(control, taskId) {
  return control === null || control.cancellableTaskIds.includes(taskId);
}
