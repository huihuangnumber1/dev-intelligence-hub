// Both model decisions and host execution use the same intake and delivery
// definitions. Execution still owns graph state, permissions and side effects.
export function structuredPrTriage(context) {
  const event = context?.code?.sourceEvent ?? context?.code?.event;
  if (event?.eventType !== "pull_request.owner_requested" ||
      event?.source?.provider !== "local-owner" || event?.payload?.workType !== "general" ||
      !["development", "pr-review"].includes(event?.payload?.suggestedCapability) ||
      typeof event?.payload?.nextAction !== "string" ||
      typeof event?.payload?.expectedHeadRefOid !== "string") return null;
  return event.payload;
}

export function isExternalRereview(context) {
  const triage = structuredPrTriage(context);
  return triage?.nextAction === "rereview" && triage.suggestedCapability === "pr-review" &&
    context.code?.internalReview?.kind !== "developer_handoff";
}

export function requiredReviewDeliverables(contract) {
  return (contract?.expectedDeliverables ?? []).filter(({ kind, required }) =>
    required && ["review-report", "github-review"].includes(kind));
}

export function hasRequiredReviewDeliverable(contract) {
  return requiredReviewDeliverables(contract).length > 0;
}

export function requiresReviewDelivery(context, action) {
  return isExternalRereview(context) && action?.type === "decompose" && action.capability === "pr-review";
}
