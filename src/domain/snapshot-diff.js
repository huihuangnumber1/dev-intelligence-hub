const IMPORTANT_FIELDS = [
  "state",
  "reviewDecision",
  "reviewFeedbackAvailable",
  "reviewFeedbackDigest",
  "actionState",
  "nextAction",
  "nextActor",
  "gitTarget",
  "gitTargetAvailable",
  "githubAccount",
  "baseRepository",
  "baseRefName",
  "baseRefOid",
  "headRepository",
  "headRefName",
  "headRefOid",
  "myReviewState",
  "myReviewCommitOid",
  "ciStatus",
  "mergeStateStatus",
  "unread",
  "dueAt",
];

function fingerprint(item) {
  return JSON.stringify(
    Object.fromEntries(IMPORTANT_FIELDS.map((field) => [field, item[field]])),
  );
}

export function diffSnapshots(previous, current) {
  if (!previous) return { baseline: true, added: [], changed: [], removed: [] };

  const before = new Map(previous.items.map((item) => [item.id, item]));
  const after = new Map(current.items.map((item) => [item.id, item]));
  const added = [];
  const changed = [];
  const removed = [];

  for (const item of current.items) {
    const oldItem = before.get(item.id);
    if (!oldItem) added.push(item);
    else if (fingerprint(oldItem) !== fingerprint(item)) {
      changed.push({ before: oldItem, after: item });
    }
  }
  for (const item of previous.items) {
    if (!after.has(item.id)) removed.push(item);
  }
  return { baseline: false, added, changed, removed };
}
