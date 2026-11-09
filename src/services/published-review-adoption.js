import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeConfirmationState } from "../domain/confirmation-contract.js";
import { historicalGitHubReviewConfirmationPlans } from "../domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal, normalizeWorkProposalResult, cloneWorkProposalValue, assertWorkProposalExactKeys, workProposalArrayValues } from "../domain/work-proposal-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext, pullRequestReviewFeedbackDigest } from "../domain/pull-request-read-facts.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizeReviewReadProof } from "../domain/review-result-proof.js";

const same = (left, right) => canonicalJsonDigest(left) === canonicalJsonDigest(right);

// Historical publication proof, not authority to act on a current PR or a new
// task. Consumers must separately bind and verify current coverage and target.
export function verifyReviewPublicationSource({ proposal: stored, result: storedResult, confirmationSnapshot } = {}) {
  try {
    const { contentDigest, ...content } = stored;
    const proposal = normalizeBoundWorkProposal(content);
    if (proposal.contentDigest !== contentDigest || proposal.kind !== "github_review_proposal") return null;
    const result = normalizeWorkProposalResult(storedResult);
    if (result.kind !== proposal.kind || result.outcome !== "succeeded" ||
        result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
        !same(result.requestedBy, proposal.requestedBy)) return null;
    const inputBinding = normalizePullRequestExecutionBinding(proposal.binding.inputBinding);
    if (inputBinding.schemaVersion !== 2) return null;
    const item = normalizeConfirmationState({ schemaVersion: 1, revision: confirmationSnapshot.queueRevision,
      items: [confirmationSnapshot.item] }).items[0];
    if (item.status !== "completed" || item.receipt === null || !/^[1-9][0-9]*$/.test(item.receipt.id) ||
        item.actor.accountId.toLowerCase() !== inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
        result.evidence.filter(value => value.startsWith("confirmation:")).length !== 1 ||
        !result.evidence.includes(`confirmation:${item.id}`) ||
        Date.parse(result.at) < Date.parse(item.receipt.createdAt)) return null;
    const matches = historicalGitHubReviewConfirmationPlans(proposal, item.actor.accountId).some(plan =>
      Object.keys(plan).every(key => Object.hasOwn(item, key) && same(item[key], plan[key])));
    if (!matches) return null;
    return Object.freeze({ producerTaskId: proposal.requestedBy.workItemId, producerRoleId: proposal.requestedBy.roleId,
      proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest,
      resultId: result.resultId, resultDigest: result.contentDigest,
      confirmationId: item.id, approvalBindingDigest: item.approvalBindingDigest,
      inputBinding: structuredClone(inputBinding), actorAccountId: item.actor.accountId,
      receipt: structuredClone(item.receipt), publishedVerdict: ({ APPROVE: "approve", REQUEST_CHANGES: "request_changes", COMMENT: "comment" })[item.action.reviewEvent],
      publishedBodyDigest: canonicalJsonDigest(item.action.body), publishedBody: item.action.body });
  } catch {
    return null;
  }
}


const reviewStates = { approve: "APPROVED", request_changes: "CHANGES_REQUESTED", comment: "COMMENTED" };
const timestampAfter = (value, at) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > at;

function publicationCandidateId(content) {
  const { materialDigest: _snapshot, ...coverage } = content.coverage;
  return `review-publication-candidate-${canonicalJsonDigest({ ...content, coverage })}`;
}

// A candidate is not accepted evidence. A current reviewer must explicitly
// assess coverage and propose adoption before the host can issue a receipt.
export function createReviewPublicationCandidate({ source: sourceRecords, target, facts: readFacts, allowHistoricalResult = false } = {}) {
  try {
    const source = verifyReviewPublicationSource(sourceRecords);
    if (source === null) return null;
    const inputBinding = normalizePullRequestExecutionBinding(target.inputBinding);
    const settlement = target.automaticSettlement;
    const evidenceTarget = settlement ? null : normalizeDeliveryEvidenceTarget(target.evidenceTarget);
    if (inputBinding.schemaVersion !== 2 || (settlement
      ? settlement.kind !== "automatic_review_settlement" || settlement.taskId !== inputBinding.rootItemId ||
        typeof settlement.assignmentId !== "string" || !Number.isSafeInteger(settlement.authorityEpoch) || settlement.authorityEpoch < 1
      : evidenceTarget.deliverables.length !== 1 || !["github-review", "review-report"].includes(evidenceTarget.deliverables[0].kind) || evidenceTarget.roleId !== "pr-engineer") ||
        inputBinding.repository !== source.inputBinding.repository ||
        inputBinding.pullRequestNumber !== source.inputBinding.pullRequestNumber ||
        !samePullRequestGitTarget(inputBinding.gitTarget, source.inputBinding.gitTarget)) return null;
    const facts = normalizePullRequestReadFacts(readFacts);
    if (!samePullRequestExecutionBinding(facts.identity.executionBinding, inputBinding)) return null;
    const materialDigest = projectPullRequestReadFactsContext(facts).materialDigest;
    if (typeof materialDigest !== "string") return null;
    const publicationAt = Date.parse(source.receipt.createdAt);
    const requestedAt = Date.parse(target.requestedAt);
    if (!Number.isFinite(requestedAt) || (!allowHistoricalResult && publicationAt < requestedAt) || Date.parse(facts.observedAt) < publicationAt) return null;
    const urlMatches = review => {
      const url = new URL(review.url);
      return url.protocol === "https:" && url.hostname === "github.com" && url.search === "" &&
        url.pathname.toLowerCase() === `/${inputBinding.repository}/pull/${inputBinding.pullRequestNumber}`.toLowerCase() &&
        url.hash === `#pullrequestreview-${source.receipt.id}`;
    };
    const reviews = facts.reviews.filter(review => review.author?.toLowerCase() === source.actorAccountId.toLowerCase());
    const matches = reviews.filter(urlMatches);
    if (matches.length !== 1) return null;
    const review = matches[0];
    if (review.commitOid !== inputBinding.headRefOid || review.state !== reviewStates[source.publishedVerdict] ||
        Date.parse(review.submittedAt) !== publicationAt || review.bodyTruncated ||
        review.body.replace(/\n\n<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u, "") !== source.publishedBody) return null;
    const comments = [...facts.comments, ...facts.reviewThreads.flatMap(thread => thread.comments)];
    if (comments.some(comment => timestampAfter(comment.createdAt, publicationAt) || timestampAfter(comment.updatedAt, publicationAt)) ||
        facts.reviews.some(other => other.id !== review.id && (timestampAfter(other.submittedAt, publicationAt) ||
          (other.author?.toLowerCase() === source.actorAccountId.toLowerCase() && Date.parse(other.submittedAt) === publicationAt)))) return null;
    const content = { schemaVersion: 1, policy: "current_review_adopts_verified_publication/v1", source,
      target: { inputBinding, ...(settlement ? { automaticSettlement: structuredClone(settlement) } : { evidenceTarget }), requestedAt: target.requestedAt },
      coverage: { materialDigest, feedbackDigest: pullRequestReviewFeedbackDigest(facts), reviewNodeId: review.id, publishedReviewUrl: review.url,
        publishedBodyDigest: canonicalJsonDigest(review.body), requiresCurrentReview: true } };
    return { ...structuredClone(content), candidateId: publicationCandidateId(content),
      materialDigest, requiresCurrentReview: true, observedAt: facts.observedAt };
  } catch {
    return null;
  }
}


const ADOPTION_STATE_KEY = "review-publication-adoptions";
const ADOPTION_POLICY = "current_review_adopts_verified_publication/v1";
const adoptionError = (message, code = "REVIEW_PUBLICATION_ADOPTION_INVALID") => Object.assign(new Error(message), { code });
const validInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function candidateContent(candidate) {
  const value = cloneWorkProposalValue(candidate);
  const keys = ["schemaVersion", "policy", "source", "target", "coverage", "candidateId", "materialDigest", "requiresCurrentReview", "observedAt"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.policy !== ADOPTION_POLICY || value.requiresCurrentReview !== true ||
      value.materialDigest !== value.coverage.materialDigest || !validInstant(value.observedAt)) throw adoptionError("Invalid publication candidate");
  const { candidateId, materialDigest: _digest, requiresCurrentReview: _review, observedAt: _at, ...content } = value;
  if (candidateId !== publicationCandidateId(content)) throw adoptionError("Publication candidate digest changed");
  return content;
}

export function createReviewPublicationAdoption({ candidate, proposal: stored, adoptedAt, coverageDigest } = {}) {
  try {
    const content = candidateContent(candidate);
    const { contentDigest, ...raw } = stored;
    const proposal = normalizeBoundWorkProposal(raw);
    const target = content.target;
    if (!validInstant(adoptedAt) || typeof coverageDigest !== "string" || !/^[a-f0-9]{64}$/.test(coverageDigest) ||
        proposal.contentDigest !== contentDigest || proposal.kind !== "github_review_proposal" ||
        !same(proposal.binding.inputBinding, target.inputBinding) || !same(proposal.binding.evidenceTarget, target.evidenceTarget) ||
        proposal.requestedBy.workItemId !== target.evidenceTarget.taskId || proposal.requestedBy.roleId !== target.evidenceTarget.roleId ||
        proposal.binding.headRefOid !== target.inputBinding.headRefOid || proposal.binding.repository !== target.inputBinding.repository ||
        proposal.binding.pullRequestNumber !== target.inputBinding.pullRequestNumber ||
        proposal.source.eventId !== target.inputBinding.eventId || proposal.binding.eventId !== target.inputBinding.eventId ||
        proposal.payload.verdict !== content.source.publishedVerdict || typeof proposal.payload.body !== "string" || !proposal.payload.body.trim() ||
        !same(proposal.payload.publicationReuse, { candidateId: candidate.candidateId, materialDigest: candidate.materialDigest, coverageDigest,
          ...(proposal.payload.publicationReuse?.readProofId ? { readProofId: proposal.payload.publicationReuse.readProofId } : {}) })) return null;
    const receipt = { ...content, outcome: "adopted_existing_review", candidateId: candidate.candidateId,
      assessment: { proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest, roleId: proposal.requestedBy.roleId,
        verdict: proposal.payload.verdict, coverageNote: proposal.payload.body, coverageNoteDigest: canonicalJsonDigest(proposal.payload.body), coverageDigest,
        ...(proposal.payload.publicationReuse.readProofId ? { readProofId: proposal.payload.publicationReuse.readProofId } : {}) } };
    return { ...structuredClone(receipt), adoptedAt, adoptionId: `review-publication-adoption-${canonicalJsonDigest(receipt)}` };
  } catch { return null; }
}

function normalizedAdoption(value) {
  const receipt = cloneWorkProposalValue(value);
  const keys = ["schemaVersion", "policy", "source", "target", "coverage", "outcome", "candidateId", "assessment", "adoptedAt", "adoptionId"];
  if (Object.keys(receipt).length !== keys.length || keys.some(key => !Object.hasOwn(receipt, key)) ||
      receipt.schemaVersion !== 1 || receipt.policy !== ADOPTION_POLICY || receipt.outcome !== "adopted_existing_review" ||
      !validInstant(receipt.adoptedAt)) throw adoptionError("Invalid publication adoption receipt");
  const core = { schemaVersion: receipt.schemaVersion, policy: receipt.policy, source: receipt.source, target: receipt.target, coverage: receipt.coverage };
  if (receipt.candidateId !== publicationCandidateId(core) ||
      !/^[a-f0-9]{64}$/.test(receipt.coverage.feedbackDigest) ||
      typeof receipt.assessment.coverageDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.assessment.coverageDigest) ||
      receipt.assessment.coverageNoteDigest !== canonicalJsonDigest(receipt.assessment.coverageNote)) throw adoptionError("Adoption source or coverage changed");
  normalizePullRequestExecutionBinding(receipt.target.inputBinding);
  normalizeDeliveryEvidenceTarget(receipt.target.evidenceTarget);
  const { adoptionId, adoptedAt: _at, ...content } = receipt;
  if (adoptionId !== `review-publication-adoption-${canonicalJsonDigest(content)}`) throw adoptionError("Publication adoption digest changed");
  return receipt;
}

export function verifyReviewPublicationAdoption({ receipt, candidate, proposal, coverageDigest } = {}) {
  try {
    const normalized = normalizedAdoption(receipt);
    if (normalized.assessment.coverageDigest !== coverageDigest || normalized.candidateId !== candidate.candidateId) return false;
    // CI-only observations may change the raw material hash after adoption. The
    // retained assessment still binds that original hash; current feedback and
    // linked-material coverage must remain identical.
    const retainedCandidate = { ...candidate, materialDigest: normalized.coverage.materialDigest,
      coverage: { ...candidate.coverage, materialDigest: normalized.coverage.materialDigest } };
    const expected = createReviewPublicationAdoption({ candidate: retainedCandidate, proposal, adoptedAt: normalized.adoptedAt, coverageDigest });
    return expected !== null && same(normalized, expected);
  } catch { return false; }
}

// The store retains immutable receipts, never execution grants. The host service
// must reverify source, current target and coverage before creating or accepting one.
export class ReviewPublicationAdoptionStore {
  #store;
  #queue = new OperationQueue();
  constructor({ store } = {}) {
    if (typeof store?.read !== "function" || typeof store?.write !== "function") throw new TypeError("Invalid adoption store");
    this.#store = store;
  }
  async #state() {
    try {
      const state = await this.#store.read(ADOPTION_STATE_KEY, { schemaVersion: 1, records: [] });
      assertWorkProposalExactKeys(state, ["schemaVersion", "records", ...(Object.hasOwn(state, "readProofs") ? ["readProofs"] : [])]);
      if (state.schemaVersion !== 1) throw new Error();
      const records = workProposalArrayValues(state.records, 1000).map(normalizedAdoption);
      if (new Set(records.map(record => record.adoptionId)).size !== records.length) throw new Error();
      return { schemaVersion: 1, records, ...(Object.hasOwn(state, "readProofs") ? { readProofs: state.readProofs } : {}) };
    } catch (cause) { throw adoptionError("Publication adoption state is corrupted", "REVIEW_PUBLICATION_ADOPTION_CORRUPTED"); }
  }
  async recover() { return { records: (await this.#state()).records.length }; }
  async readProofs() {
    const state = await this.#state();
    try {
      return { records: workProposalArrayValues(state.readProofs ?? [], 1000).map(normalizeReviewReadProof), diagnostic: null };
    } catch { return { records: [], diagnostic: "REVIEW_READ_PROOF_UNAVAILABLE" }; }
  }
  recordReadProof(value) {
    return this.#queue.enqueue(async () => {
      try {
        const proof = normalizeReviewReadProof(value), state = await this.#state();
        const proofs = workProposalArrayValues(state.readProofs ?? [], 1000).map(normalizeReviewReadProof);
        if (proofs.some(record => record.readProofId === proof.readProofId)) return { recorded: true };
        if (proofs.length >= 1000) return { recorded: false, diagnostic: "REVIEW_READ_PROOF_CAPACITY" };
        await this.#store.write(ADOPTION_STATE_KEY, { ...state, readProofs: [...proofs, proof] });
        return { recorded: true };
      } catch { return { recorded: false, diagnostic: "REVIEW_READ_PROOF_UNAVAILABLE" }; }
    });
  }
  async get(adoptionId) {
    if (!/^review-publication-adoption-[a-f0-9]{64}$/.test(adoptionId ?? "")) throw adoptionError("Invalid adoption reference");
    return structuredClone((await this.#state()).records.find(record => record.adoptionId === adoptionId) ?? null);
  }
  async getForProposal({ proposalId, proposalDigest }) {
    if (typeof proposalId !== "string" || typeof proposalDigest !== "string" || !/^[a-f0-9]{64}$/.test(proposalDigest)) throw adoptionError("Invalid adoption proposal");
    const matches = (await this.#state()).records.filter(record => record.assessment.proposalId === proposalId && record.assessment.proposalDigest === proposalDigest);
    if (matches.length > 1) throw adoptionError("Ambiguous adoption proposal", "REVIEW_PUBLICATION_ADOPTION_CORRUPTED");
    return structuredClone(matches[0] ?? null);
  }
  record(value) {
    return this.#queue.enqueue(async () => {
      let receipt;
      try { receipt = normalizedAdoption(value); } catch { throw adoptionError("Invalid publication adoption receipt"); }
      const state = await this.#state();
      const existing = state.records.find(record => record.adoptionId === receipt.adoptionId);
      if (existing) return structuredClone(existing);
      if (state.records.length >= 1000) throw adoptionError("Publication adoption storage is full", "REVIEW_PUBLICATION_ADOPTION_CAPACITY");
      await this.#store.write(ADOPTION_STATE_KEY, { ...state, records: [...state.records, receipt] });
      return structuredClone(receipt);
    });
  }
}
