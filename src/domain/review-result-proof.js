import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext } from "./pull-request-read-facts.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

export const STANDARD_REVIEW_PURPOSE = "standard_current_pr_code_review/v1";
const HASH = /^[a-f0-9]{64}$/;
const same = (a, b) => canonicalJsonDigest(a) === canonicalJsonDigest(b);

export function normalizePublishedReviewReuse(value) {
  const raw = structuredClone(value);
  const reuse = raw?.publicationReuse;
  if (!raw || Object.keys(raw).length !== 3 || !/^work-intent-[a-f0-9]{64}$/.test(raw.proposalId) ||
      !HASH.test(raw.proposalDigest) || !reuse || Object.keys(reuse).length !== 4 ||
      !/^review-publication-candidate-[a-f0-9]{64}$/.test(reuse.candidateId) ||
      !/^review-read-proof-[a-f0-9]{64}$/.test(reuse.readProofId) || !HASH.test(reuse.materialDigest) || !HASH.test(reuse.coverageDigest)) {
    throw new TypeError("Invalid published Review reuse reference");
  }
  return raw;
}

// This classifies only the existing typed external-review route. Task prose and
// acceptance criteria remain separate obligations for the current employee.
export function standardReviewPurpose(event) {
  if (event?.payload?.reviewPurpose !== undefined && event.payload.reviewPurpose !== STANDARD_REVIEW_PURPOSE) return null;
  if (event?.source?.provider === "github" && event.eventType?.startsWith("pull_request.") &&
      event.payload?.relation === "review_requested") return STANDARD_REVIEW_PURPOSE;
  if (event?.source?.provider === "local-owner" && event.eventType === "pull_request.owner_requested" &&
      ((event.payload?.workType === "pull_request" && event.payload.reviewPurpose === STANDARD_REVIEW_PURPOSE) || (event.payload?.workType === "general" &&
        event.payload.suggestedCapability === "pr-review" && ["review", "rereview", "complete_review"].includes(event.payload.nextAction)))) return STANDARD_REVIEW_PURPOSE;
  return null;
}

export function withoutPublishedReview(facts, publication = null) {
  if (publication === null) return facts;
  const matches = facts.reviews.filter(review => {
    let url; try { url = new URL(review.url); } catch { return false; }
    return url.hash === `#pullrequestreview-${publication.receipt.id}` &&
      url.hostname === "github.com" && review.author.toLowerCase() === publication.actorAccountId.toLowerCase() &&
      review.commitOid === publication.inputBinding.headRefOid &&
      Date.parse(review.submittedAt) === Date.parse(publication.receipt.createdAt) && !review.bodyTruncated &&
      review.body.replace(/\n\n<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u, "") === publication.publishedBody;
  });
  if (matches.length !== 1) throw new TypeError("Verified publication is not present in current feedback");
  return { ...facts, reviews: facts.reviews.filter(review => review !== matches[0]) };
}

export function reviewResultCoverage(factsValue, description, referencedMaterialDigest, publication = null) {
  const facts = normalizePullRequestReadFacts(factsValue);
  if (!projectPullRequestReadFactsContext(facts).materialDigest || !HASH.test(referencedMaterialDigest)) throw new TypeError("Incomplete review coverage");
  const current = withoutPublishedReview(facts, publication);
  // Roll-up reviewDecision and task identity change after publication/transfer.
  // Complete individual feedback records, including edits, remain authoritative.
  return { schemaVersion: 1, checksDigest: canonicalJsonDigest(facts.checks),
    feedbackDigest: canonicalJsonDigest({ comments: current.comments, reviews: current.reviews, reviewThreads: current.reviewThreads }),
    descriptionDigest: canonicalJsonDigest(description), referencedMaterialDigest };
}

export function createReviewReadProof({ task, intent, coverage, policyDigest, observedAt }) {
  if (task?.roleId !== "pr-engineer" || standardReviewPurpose(task.event) === null ||
      intent?.type !== "propose_github_review" || intent.publicationReuse ||
      !["approve", "request_changes", "comment"].includes(intent.verdict) || typeof intent.body !== "string" || !intent.body.trim() ||
      !HASH.test(policyDigest) || coverage?.schemaVersion !== 1 ||
      ![coverage.feedbackDigest, coverage.descriptionDigest, coverage.referencedMaterialDigest, coverage.checksDigest].every(v => HASH.test(v)) ||
      !Number.isFinite(Date.parse(observedAt))) return null;
  const content = { schemaVersion: 1, purpose: STANDARD_REVIEW_PURPOSE, producerTaskId: task.taskId,
    inputBinding: normalizePullRequestExecutionBinding(task.inputBinding), verdict: intent.verdict,
    bodyDigest: canonicalJsonDigest(intent.body), coverage: structuredClone(coverage), policyDigest, observedAt };
  return { ...content, readProofId: `review-read-proof-${canonicalJsonDigest(content)}` };
}

export function normalizeReviewReadProof(value) {
  const { readProofId, ...content } = structuredClone(value);
  const keys = ["schemaVersion", "purpose", "producerTaskId", "inputBinding", "verdict", "bodyDigest", "coverage", "policyDigest", "observedAt"];
  if (Object.keys(content).length !== keys.length || keys.some(key => !Object.hasOwn(content, key)) ||
      typeof content.producerTaskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,191}$/.test(content.producerTaskId) ||
      !["approve", "request_changes", "comment"].includes(content.verdict) ||
      content.schemaVersion !== 1 || content.purpose !== STANDARD_REVIEW_PURPOSE ||
      readProofId !== `review-read-proof-${canonicalJsonDigest(content)}` || !HASH.test(content.bodyDigest) ||
      !HASH.test(content.policyDigest) || content.coverage?.schemaVersion !== 1 ||
      ![content.coverage.feedbackDigest, content.coverage.descriptionDigest, content.coverage.referencedMaterialDigest, content.coverage.checksDigest].every(v => HASH.test(v)) ||
      !Number.isFinite(Date.parse(content.observedAt)) || Object.keys(content.coverage).length !== 5) throw new TypeError("Invalid review read proof");
  if (normalizePullRequestExecutionBinding(content.inputBinding).schemaVersion !== 2) throw new TypeError("Invalid review proof input");
  return { ...content, readProofId };
}

export function matchesReviewReadProof(proofValue, source, task, coverage, policyDigest) {
  try {
    const proof = normalizeReviewReadProof(proofValue);
    return standardReviewPurpose(task.event) === proof.purpose && proof.producerTaskId === source.producerTaskId &&
      samePullRequestExecutionBinding(proof.inputBinding, source.inputBinding) &&
      proof.verdict === source.publishedVerdict && proof.bodyDigest === canonicalJsonDigest(source.publishedBody) &&
      Date.parse(proof.observedAt) <= Date.parse(source.receipt.createdAt) &&
      proof.policyDigest === policyDigest && same(proof.coverage, coverage);
  } catch { return false; }
}
