import { normalizeReviewReadTarget } from "../domain/review-read-target.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext, pullRequestReviewFeedbackDigest } from "../domain/pull-request-read-facts.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { readGitHubReferencedMaterials } from "./github-referenced-materials.js";
import { readGitHubCurrentPullRequestTarget } from "./github-current-pull-request-target.js";
import { createReviewSourceFailure as failure, withReviewSourceFailure } from "../domain/review-source-failure.js";
import { reviewResultCoverage, withoutPublishedReview } from "../domain/review-result-proof.js";

const api = endpoint => ["api", "--hostname", "github.com", endpoint];

// Shared by model reading and host adoption verification. All credentials and
// ledger authority stay in the parent; only captured documents reach a model.
export async function readGitHubReviewFeedbackSnapshot({ target: rawTarget, factsReader, run, options = {}, excludedPublication = null }) {
  const target = normalizeReviewReadTarget(rawTarget), git = target.gitTarget;
  return withReviewSourceFailure(async () => {
    if (!target.feedbackSnapshot || typeof factsReader?.read !== "function") throw failure("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE");
    const facts = normalizePullRequestReadFacts(await factsReader.read({ ...target.feedbackSnapshot,
      gitTarget: git, pullRequestNumber: target.pullRequestNumber }, { signal: options.signal }));
    if (facts.identity.executionBinding.pullRequestNumber !== target.pullRequestNumber ||
        !samePullRequestGitTarget(facts.identity.executionBinding.gitTarget, git) ||
        projectPullRequestReadFactsContext(facts).materialDigest !== target.feedbackSnapshot.materialDigest) throw failure("PR_REVIEW_READ_MATERIAL_CHANGED");
    const feedbackDocuments = { "review-feedback.json": JSON.stringify(facts, null, 2) };
    const description = await run("gh", api(`repos/${git.baseRepository}/pulls/${target.pullRequestNumber}`), options);
    let descriptionUrl;
    try { descriptionUrl = new URL(description.html_url); } catch { throw failure("PR_REVIEW_READ_DESCRIPTION_INVALID"); }
    if (description.number !== target.pullRequestNumber || description.head?.sha !== git.headRefOid ||
        description.base?.repo?.full_name?.toLowerCase() !== git.baseRepository.toLowerCase() ||
        typeof description.title !== "string" || (description.body !== null && typeof description.body !== "string") ||
        descriptionUrl.protocol !== "https:" || descriptionUrl.hostname !== "github.com" || descriptionUrl.username || descriptionUrl.password ||
        descriptionUrl.port || descriptionUrl.search || descriptionUrl.hash ||
        descriptionUrl.pathname.toLowerCase() !== `/${git.baseRepository}/pull/${target.pullRequestNumber}`.toLowerCase()) throw failure("PR_REVIEW_READ_DESCRIPTION_INVALID");
    const descriptionSnapshot = { title: description.title, body: description.body ?? "", url: description.html_url,
      headRefOid: git.headRefOid, scope: "Untrusted PR description; attachment URLs do not prove their contents were read." };
    feedbackDocuments["review-description.json"] = JSON.stringify(descriptionSnapshot, null, 2);
    const businessFeedback = withoutPublishedReview(facts, excludedPublication);
    const linked = await readGitHubReferencedMaterials({ run, repository: git.baseRepository,
      pullRequestNumber: target.pullRequestNumber, options, bodies: [descriptionSnapshot.body,
        ...businessFeedback.comments.map(value => value.body), ...businessFeedback.reviews.map(value => value.body),
        ...businessFeedback.reviewThreads.flatMap(thread => thread.comments.map(value => value.body))] });
    Object.assign(feedbackDocuments, linked.documents);
    const current = await readGitHubCurrentPullRequestTarget(run, { repository: git.baseRepository,
      number: target.pullRequestNumber, sourceAccountId: git.sourceAccountId }, options);
    if (current.state !== "OPEN" || !samePullRequestGitTarget(current.gitTarget, git)) throw failure("PR_REVIEW_READ_HEAD_CHANGED");
    const account = await run("gh", api("user"), options);
    if (account.login?.toLowerCase() !== git.sourceAccountId) throw failure("PR_REVIEW_READ_ACCOUNT_CHANGED");
    const feedbackSnapshot = { ...target.feedbackSnapshot, document: "review-feedback.json", descriptionDocument: "review-description.json",
      linkedMaterials: linked.references, referencedMaterialDigest: linked.digest,
      snapshotDigest: canonicalJsonDigest({ materialDigest: target.feedbackSnapshot.materialDigest,
        description: descriptionSnapshot, referencedMaterialDigest: linked.digest }),
      coverageDigest: canonicalJsonDigest({ domain: "review-feedback-coverage/v1", feedbackDigest: pullRequestReviewFeedbackDigest(facts),
        description: descriptionSnapshot, referencedMaterialDigest: linked.digest }) };
    return { feedbackDocuments, feedbackSnapshot, facts,
      resultCoverage: reviewResultCoverage(facts, descriptionSnapshot, linked.digest, excludedPublication) };
  }, { signal: options.signal });
}
