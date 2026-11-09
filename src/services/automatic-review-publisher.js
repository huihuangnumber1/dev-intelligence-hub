import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { automaticReviewEligibility, automaticReviewContinuationEligibility, automaticTestingOwner,
  createAutomaticReviewAssignmentProof } from "../domain/automatic-review-policy.js";

// Only the composition root receives this port. Model output cannot grant
// automatic publication, choose arbitrary assignees, or execute other actions.
export class AutomaticReviewPublisher {
  constructor({ enabled = false, assignAfterReview = true, queue, github, confirmationInvalidator = null, reviewAdmissionReader = null, testingOwnersByProduct = {}, clock = () => new Date() }) {
    this.enabled = enabled === true;
    this.assignAfterReview = assignAfterReview !== false;
    this.queue = queue;
    this.github = github;
    this.testingOwners = structuredClone(testingOwnersByProduct);
    this.clock = clock;
    if (confirmationInvalidator !== null && typeof confirmationInvalidator.invalidate !== "function") throw new TypeError("confirmationInvalidator is invalid");
    this.invalidate = confirmationInvalidator?.invalidate.bind(confirmationInvalidator) ?? null;
    if (reviewAdmissionReader !== null && typeof reviewAdmissionReader?.read !== "function") throw new TypeError("reviewAdmissionReader is invalid");
    this.readAdmission = reviewAdmissionReader?.read.bind(reviewAdmissionReader) ?? null;
  }

  async eligible(facts, item) {
    if (facts.headRefOid !== item.target.version) return false;
    if (this.readAdmission === null) return automaticReviewEligibility(facts, item.actor.accountId, this.clock()) === null;
    const binding = (item.action ?? item.display?.payload?.action)?.inputBinding;
    const resourceId = `${binding?.repository}#${binding?.pullRequestNumber}`;
    if (binding?.schemaVersion !== 2 || resourceId !== item.target.resourceId || binding.headRefOid !== item.target.version ||
        binding.gitTarget?.sourceAccountId?.toLowerCase() !== item.actor.accountId.toLowerCase()) return false;
    let context;
    try { context = await this.readAdmission(binding); }
    catch { return false; }
    return isDeepStrictEqual(context?.inputBinding, binding) && context?.admission !== null &&
      automaticReviewContinuationEligibility(facts, item.actor.accountId, this.clock(), context?.admission) === null;
  }

  async publish(item, { publicationAllowed = true } = {}) {
    if (!this.enabled || item.kind !== "github.work-proposal-review" || item.status !== "pending") return item;
    const action = item.display?.payload?.action;
    if (action?.type !== "pull_request_review") return item;
    const match = /^([^#]+)#([1-9]\d*)$/.exec(item.target.resourceId);
    if (!match) return item;
    const facts = await this.github.readIncomingReviewRequest({ repository: match[1], number: Number(match[2]), account: item.actor.accountId });
    const reason = automaticReviewEligibility(facts, item.actor.accountId, this.clock());
    const headChanged = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(facts?.headRefOid || "") &&
      facts.headRefOid !== item.target.version;
    const revoked = facts?.kind === "pull_request" && facts.incomingReviewFactsAvailable === true &&
      (headChanged || reason === "HEAD_ALREADY_REVIEWED" ||
      (reason === "SELF_AUTHORED" && typeof facts.author === "string" &&
        facts.author.toLowerCase() === item.actor.accountId.toLowerCase()) ||
      (reason === "NO_CURRENT_INCOMING_REQUEST" && Array.isArray(facts.assignees)) ||
      (reason === "PR_NOT_READY" && (["closed", "merged"].includes(facts.state?.toLowerCase()) || facts.isDraft === true)));
    if (this.invalidate !== null && revoked) {
      try {
        return await this.invalidate(item.id, { requestedBy: item.requestedBy,
          approvalBindingDigest: item.approvalBindingDigest, reason: "authorization_changed" });
      } catch (error) {
        if (error?.code === "CONFIRMATION_NOT_INVALIDATABLE") return item;
        throw error;
      }
    }
    if (publicationAllowed !== true || !await this.eligible(facts, item)) return item;
    let reviewHandoff;
    if (this.assignAfterReview) {
      if (action.reviewEvent === "APPROVE") {
        const responsiblePerson = automaticTestingOwner(facts, this.testingOwners);
        if (!responsiblePerson) return item;
        reviewHandoff = { workType: "testing", responsiblePerson };
      } else {
        reviewHandoff = { workType: "assignment", responsiblePerson: null };
      }
    }
    const digest = createHash("sha256").update(item.id + ":" + item.approvalBindingDigest).digest("hex").slice(0, 48);
    return this.queue.approve(item.id, {
      requestId: `auto-review-v1-${digest}`,
      expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
      displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
      ...(reviewHandoff ? { reviewHandoff } : {}),
    }, createAutomaticReviewAssignmentProof(item, facts, this.clock()));
  }

  async verify(envelope) {
    if (!this.enabled || envelope.kind !== "github.work-proposal-review") return false;
    const match = /^([^#]+)#([1-9]\d*)$/.exec(envelope.target.resourceId);
    if (!match) return false;
    const facts = await this.github.readIncomingReviewRequest({ repository: match[1], number: Number(match[2]), account: envelope.actor.accountId });
    return this.eligible(facts, envelope);
  }
}
