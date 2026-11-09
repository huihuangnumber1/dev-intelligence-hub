// This context can settle a publication against its original input. It grants
// no authority to act on the current PR or to create another work item.
export function permitsReviewPublicationSettlementIntent(context, intent) {
  const settlement = context?.code?.reviewPublicationSettlement;
  if (settlement === undefined) return true;
  if (settlement?.schemaVersion !== 1 || settlement.scope !== "historical_publication_only" ||
      settlement.inputBinding?.rootItemId !== context.requirements?.currentTask?.taskId ||
      !Array.isArray(settlement.entries) || settlement.entries.length === 0) return false;
  if (intent?.type === "complete") return settlement.allAccepted === true &&
    settlement.entries.every(entry => entry.state === "accepted" && entry.completed === true);
  const action = intent?.action;
  return intent?.type === "orchestrate" && action?.type === "accept_delivery" && settlement.entries.some(entry =>
    entry.state === "submitted" && entry.taskId === action.sourceTaskId &&
    entry.taskRevision === action.sourceTaskRevision && entry.submittedDeliveryRevision === action.submittedDeliveryRevision);
}
