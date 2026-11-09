const DAY_MS = 86_400_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const assignmentProofs = new WeakMap();

export function hasLaterIncomingAssignment(item, account, now) {
  const currentlyAssigned = Array.isArray(item?.assignees) && item.assignees.some(login => sameLogin(login, account));
  // Taking live responsibility again is a fresh Assign. Legacy projections
  // without current assignees still need an assignment from another account.
  if (item.incomingReviewFactsAvailable !== true || !sameLogin(item.reviewRecipient, account) ||
      !LOGIN.test(item.reviewReceivedFrom || "") || (!currentlyAssigned && sameLogin(item.reviewReceivedFrom, account)) ||
      item.reviewReceivedVia !== "assignee" || !item.reviewRequestEventId) return false;
  const received = Date.parse(item.reviewReceivedAt || "");
  const published = Date.parse(item.myLatestPublishedReviewAt || "");
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(received) && Number.isFinite(published) && Number.isFinite(timestamp) &&
    received > published && received <= timestamp;
}

// Only the host publisher supplies this in-memory proof; JSON approval requests
// cannot authorize another Review after an earlier same-Head publication.
export function createAutomaticReviewAssignmentProof(item, facts, now) {
  if (item?.kind !== "github.work-proposal-review" || facts?.headRefOid !== item.target?.version ||
      automaticReviewEligibility(facts, item.actor?.accountId, now) !== null ||
      !hasLaterIncomingAssignment(facts, item.actor?.accountId, now)) return null;
  const proof = Object.freeze({});
  assignmentProofs.set(proof, { id: item.id, approvalBindingDigest: item.approvalBindingDigest,
    receivedAt: Date.parse(facts.reviewReceivedAt) });
  return proof;
}

export function automaticReviewAssignmentSupersedes(previous, item, proof) {
  const stored = proof && assignmentProofs.get(proof);
  // A reuse settles a later Assign without creating a newer GitHub Review.
  // Its controlled execution time, not that old publication timestamp, is the
  // boundary for admitting yet another Assign. Same-Assign duplicates stay shut.
  let settledAt = Date.parse(previous.receipt?.createdAt || "");
  if (previous.action?.publishedReviewReuse) {
    if (!["applied", "already"].includes(previous.execution?.outcome)) return false;
    settledAt = Math.max(settledAt, Date.parse(previous.execution?.startedAt || ""));
  }
  return Boolean(stored && stored.id === item.id && stored.approvalBindingDigest === item.approvalBindingDigest &&
    previous.status === "completed" && Number.isFinite(settledAt) && stored.receivedAt > settledAt &&
    sameLogin(previous.actor?.accountId, item.actor?.accountId) &&
    previous.target?.resourceId?.toLowerCase() === item.target?.resourceId?.toLowerCase() &&
    previous.target?.version === item.target?.version);
}

// Live assignees authorize standing automatic work. Legacy projections without
// that list use their original assignment-event admission.
export function automaticReviewEligibility(item, account, now = new Date()) {
  if (!LOGIN.test(account || "") || item?.kind !== "pull_request") return "INVALID_TARGET";
  if (item.state?.toLowerCase() !== "open" || item.isDraft !== false) return "PR_NOT_READY";
  if (!LOGIN.test(item.author || "") || sameLogin(item.author, account)) return "SELF_AUTHORED";
  const reassigned = hasLaterIncomingAssignment(item, account, now);
  // Live assignment is sufficient in automatic mode. Older stored projections
  // without an assignee list retain their original admission fallback.
  if (Array.isArray(item.assignees)) {
    if (!item.assignees.some(login => sameLogin(login, account))) return "NO_CURRENT_INCOMING_REQUEST";
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.headRefOid || "")) return "HEAD_UNKNOWN";
    if (!reassigned && ["APPROVED", "CHANGES_REQUESTED"].includes(item.myReviewState) && item.myReviewCommitOid === item.headRefOid) return "HEAD_ALREADY_REVIEWED";
    if (!reassigned && item.myLatestPublishedReviewCommitOid === item.headRefOid) return "HEAD_ALREADY_REVIEWED";
    return null;
  }
  if (item.ciStatus && !["NONE", "SUCCESS", "FAILURE", "ERROR"].includes(item.ciStatus)) return "CI_NOT_READY";
  if (item.incomingReviewFactsAvailable !== true || !sameLogin(item.reviewRecipient, account) ||
      !LOGIN.test(item.reviewReceivedFrom || "") || sameLogin(item.reviewReceivedFrom, account) ||
      item.reviewReceivedVia !== "assignee" || !item.reviewRequestEventId) return "NO_CURRENT_INCOMING_REQUEST";
  const received = Date.parse(item.reviewReceivedAt || "");
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(received) || !Number.isFinite(timestamp) || received > timestamp || timestamp - received > DAY_MS) return "OUTSIDE_RECEIVED_WINDOW";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.headRefOid || "")) return "HEAD_UNKNOWN";
  if (!reassigned && ["APPROVED", "CHANGES_REQUESTED"].includes(item.myReviewState) && item.myReviewCommitOid === item.headRefOid) return "HEAD_ALREADY_REVIEWED";
  const published = Date.parse(item.myLatestPublishedReviewAt || "");
  if (Number.isFinite(published) && published >= received) return "ASSIGNMENT_ALREADY_REVIEWED";
  return null;
}

// The caller must supply a persisted ledger root, never a model decision or a
// timestamp copied from a proposed Review. The original root retains the first
// observation of its Assign even when later status/Head snapshots arrive.
export function automaticReviewWorkAdmission(root, inputRevision = root?.source?.activeRevision) {
  const source = root?.source;
  if (source?.kind !== "pull_request" || root.sourceQuarantine !== null || source.scope?.active !== true) return null;
  const event = source.current?.event;
  if (!event?.source || source.identity?.provider !== event.source.provider || source.identity?.scopeId !== event.source.scopeId) return null;
  const orchestratedReview = event.payload?.workType === "general" &&
    source.identity.targetRoleId === "orchestrator" && ["review", "rereview", "complete_review"].includes(event.payload.nextAction) &&
    event.payload.suggestedCapability === "pr-review" &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.current.headRefOid || "") &&
    event.payload.expectedHeadRefOid === source.current.headRefOid && event.payload.headRefOid === source.current.headRefOid;
  if (event.source.provider === "local-owner" && source.scope.kind === "owner_requested" &&
      event.eventType === "pull_request.owner_requested" && (event.payload?.workType === "pull_request" || orchestratedReview)) {
    return { kind: "owner_requested", admittedAt: root.createdAt };
  }
  const facts = event?.payload;
  if (event?.source.provider !== "github" || source.scope.kind !== "automatic" || facts?.relation !== "review_requested") return null;
  const original = root.event?.payload;
  const sameAssignment = original?.reviewRequestEventId === facts.reviewRequestEventId &&
    original?.reviewReceivedAt === facts.reviewReceivedAt;
  // New revisions retain each Assign identity. Legacy histories lack that
  // evidence, so only their current accepted snapshot can establish intake.
  const observedAt = sameAssignment ? root.createdAt : (
    source.revisions?.find(entry => entry.revision <= inputRevision && entry.disposition === "accepted" &&
      entry.incomingReview?.eventId === facts.reviewRequestEventId &&
      Date.parse(entry.incomingReview?.receivedAt) === Date.parse(facts.reviewReceivedAt)) ??
    source.revisions?.find(entry => entry.revision === inputRevision && entry.disposition === "accepted")
  )?.occurredAt;
  const admittedAt = Math.max(Date.parse(root.createdAt), Date.parse(observedAt));
  if (!Number.isFinite(admittedAt)) return null;
  return { kind: "assigned", admittedAt: new Date(admittedAt).toISOString(),
    reviewRequestEventId: facts.reviewRequestEventId, reviewReceivedAt: facts.reviewReceivedAt };
}

export function automaticReviewContinuationEligibility(item, account, now, admission) {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  const admittedAt = Date.parse(admission?.admittedAt);
  if (Array.isArray(item?.assignees) && ["assigned", "owner_requested"].includes(admission?.kind) &&
      Number.isFinite(timestamp) && Number.isFinite(admittedAt) && admittedAt <= timestamp) {
    return automaticReviewEligibility(item, account, now);
  }
  const receivedAt = Date.parse(item?.reviewReceivedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(admittedAt) || admittedAt > timestamp ||
      !Number.isFinite(receivedAt) || receivedAt > timestamp) return "INVALID_REVIEW_ADMISSION";
  if (admission.kind === "assigned") {
    if (admission.reviewRequestEventId !== item.reviewRequestEventId ||
        Date.parse(admission.reviewReceivedAt) !== receivedAt) return "REVIEW_ASSIGNMENT_CHANGED";
    return automaticReviewEligibility(item, account, new Date(admittedAt));
  }
  if (admission.kind === "owner_requested") {
    // A trusted explicit Review task can continue an older Assign. Live scope,
    // identity, CI, Head and already-published checks still apply unchanged.
    return automaticReviewEligibility(item, account, new Date(receivedAt));
  }
  return "INVALID_REVIEW_ADMISSION";
}

// Scheduling and execution must agree before waking an automatic Review role.
export function automaticReviewWorkEligibility(item, policy, now) {
  const event = item.source?.kind === "pull_request" ? item.source.current?.event : item.event;
  if (policy === null || item.currentTarget?.id !== "pr-engineer" ||
      event?.source?.provider !== "github" || event.payload?.relation !== "review_requested") return null;
  if (!policy.enabled) return "AUTOMATIC_REVIEW_DISABLED";
  const admission = automaticReviewWorkAdmission(item);
  const facts = { ...event.payload, kind: "pull_request" };
  return admission === null ? automaticReviewEligibility(facts, policy.account, now)
    : automaticReviewContinuationEligibility(facts, policy.account, now, admission);
}

export function automaticTestingOwner(item, ownersByProduct = {}) {
  const text = [item.title, ...(item.labels || []), item.gitTarget?.baseRefName, item.gitTarget?.headRefName, item.repo].filter(Boolean).join(" ");
  const bs = /\bB\s*\/\s*S\b|\bBS(?:[-_ ]|版)|\bweb\b|网页端|浏览器端|Picasso-ProductAndFE/iu.test(text);
  const qt = /\bQt\b|桌面版|客户端|\bVG[S]?#|VanGogh|OCT-Software/iu.test(text);
  const product = bs ? "bs" : qt ? "qt" : null;
  const login = product && ownersByProduct[product]?.find((owner) => LOGIN.test(owner || "") && !sameLogin(owner, item.currentUser) && !sameLogin(owner, item.author));
  return login ? { login, product } : null;
}

export function isAutomaticReviewExecution(item) {
  return item?.kind === "github.work-proposal-review" && /^auto-review-v1-[a-f0-9]{48}$/.test(item.execution?.requestId || "");
}
