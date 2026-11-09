export const INCOMING_REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url title state isDraft author{login} headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}} baseRefName headRefName labels(first:100){nodes{name}} assignees(first:100){nodes{login}} reviewRequests(first:100){nodes{requestedReviewer{... on User{login}}}} reviews(last:100){nodes{author{login} state submittedAt commit{oid}}} timelineItems(last:100,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT,REVIEW_REQUESTED_EVENT,REVIEW_REQUEST_REMOVED_EVENT]){nodes{__typename ... on AssignedEvent{id createdAt actor{login} assignee{... on User{login}}} ... on UnassignedEvent{id createdAt actor{login} assignee{... on User{login}}} ... on ReviewRequestedEvent{id createdAt actor{login} requestedReviewer{... on User{login}}} ... on ReviewRequestRemovedEvent{id createdAt actor{login} requestedReviewer{... on User{login}}}}}}}}`;

export function projectIncomingReview(pr, account) {
  const same = (login) => typeof login === "string" && login.toLowerCase() === account.toLowerCase();
  if (!pr || !Array.isArray(pr.timelineItems?.nodes) || !Array.isArray(pr.assignees?.nodes) || !Array.isArray(pr.reviews?.nodes)) throw new Error("GitHub incoming Review facts are incomplete");
  const events = pr.timelineItems.nodes.filter((event) => event &&
    ["AssignedEvent", "UnassignedEvent"].includes(event.__typename) && same(event.assignee?.login))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latest = events[0];
  // An outstanding Request review must not reopen a cycle after unassignment.
  const received = pr.assignees.nodes.some((user) => same(user?.login)) &&
    latest?.__typename === "AssignedEvent" ? latest : null;
  const latestPublishedReview = pr.reviews.nodes.filter((review) =>
    same(review?.author?.login) && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state) &&
    Number.isFinite(Date.parse(review.submittedAt)))
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
  return {
    incomingReviewFactsAvailable: true,
    reviewRecipient: received ? account : null,
    reviewReceivedAt: received?.createdAt || null,
    reviewReceivedFrom: received?.actor?.login || null,
    reviewReceivedVia: received ? "assignee" : null,
    reviewRequestEventId: received?.id || null,
    myLatestPublishedReviewAt: latestPublishedReview?.submittedAt || null,
    myLatestPublishedReviewState: latestPublishedReview?.state || "",
    myLatestPublishedReviewCommitOid: latestPublishedReview?.commit?.oid || "",
  };
}
