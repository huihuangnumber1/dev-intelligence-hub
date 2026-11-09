import { normalizeBoundWorkProposal, normalizeWorkProposalResult, WORK_PROPOSAL_TERMINAL_STATUSES } from "../domain/work-proposal-contract.js";
import { historicalGitHubReviewConfirmationPlans } from "../domain/github-review-proposal-confirmation.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext } from "../domain/pull-request-read-facts.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { createProposalDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import { requiredReviewDeliverables } from "../domain/pr-review-work-policy.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { createWorkIntentDispatchBinding } from "../domain/work-intent-dispatch-binding.js";
import { createReviewPublicationCandidate, createReviewPublicationAdoption, verifyReviewPublicationAdoption } from "./published-review-adoption.js";
import { createReviewReadProof, matchesReviewReadProof, standardReviewPurpose } from "../domain/review-result-proof.js";
import { consumeCompletedReviewRead } from "../adapters/github-review-reader.js";

const failure = code => Object.assign(new Error(code), { code });
const same = (left, right) => canonicalJsonDigest(left) === canonicalJsonDigest(right);
const held = status => ["paused", "cancelled", "superseded"].includes(status);
const check = signal => signal?.throwIfAborted();

function activeReviewProposal(item, row, inputBinding) {
  if (item.activeIntentId === null || row?.intentId !== item.activeIntentId) return null;
  if (row.itemId !== item.itemId || row.intent?.type !== "propose_github_review" ||
      !["dispatching", "delivered"].includes(row.status) || row.inputDigest !== item.inputDigest) return null;
  try {
    const bound = row.dispatchBinding?.boundIntent;
    if (!bound || createWorkIntentDispatchBinding(bound).bindingDigest !== row.dispatchBinding.bindingDigest) return null;
    const { intentId, ...content } = bound;
    const proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...content });
    if (proposal.kind !== "github_review_proposal" || proposal.requestedBy.workItemId !== item.itemId ||
        proposal.requestedBy.roleId !== item.currentTarget.id || proposal.source.assignmentId !== item.assignmentId ||
        proposal.source.eventId !== currentWorkItemEvent(item).eventId ||
        !samePullRequestExecutionBinding(proposal.binding.inputBinding, inputBinding)) return null;
    if (row.status === "delivered" && (row.outcome?.status !== "delivered" ||
        row.outcome.details?.downstreamRef !== proposal.proposalId ||
        row.outcome.details?.proposalDigest !== proposal.contentDigest)) return null;
    return { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest };
  } catch { return null; }
}

const ownsProposal = (task, proposal) => task.activeProposal?.proposalId === proposal.proposalId &&
  task.activeProposal.contentDigest === proposal.contentDigest;

export function createReviewAdoptionTaskReader(ledger) {
  if (typeof ledger?.readReviewAdoptionContext !== "function") throw new TypeError("Invalid Review adoption ledger reader");
  return Object.freeze({ async read({ taskId }) {
    const { item, root, activeDispatch } = await ledger.readReviewAdoptionContext({ itemId: taskId }) ?? {};
    if (!item || item.sourceQuarantine !== null || item.currentTarget?.type !== "role") return null;
    const inputBinding = currentWorkItemExecutionBinding(item);
    if (inputBinding === null) return null;
    if (!root || root.sourceQuarantine !== null || root.source?.scope?.active !== true) return null;
    return { taskId: item.itemId, revision: item.revision, roleId: item.currentTarget.id, status: item.status,
      activeIntentId: item.activeIntentId, activeProposal: activeReviewProposal(item, activeDispatch, inputBinding),
      rootStatus: root.status, inputBinding, event: currentWorkItemEvent(item),
      acceptanceContract: structuredClone(item.graph?.acceptanceContracts?.at(-1) ?? null), requestedAt: root.createdAt,
      ...(item.itemId === root.itemId && item.kind === "source_root" && root.source.scope.kind === "automatic" &&
          root.source.identity.targetRoleId === "pr-engineer" && currentWorkItemEvent(item).payload?.relation === "review_requested"
        ? { automaticSettlement: { kind: "automatic_review_settlement", taskId: item.itemId, assignmentId: item.assignmentId,
          authorityEpoch: root.source.authorityEpoch } } : {}) };
  } });
}

// This service owns only local adoption receipts. It has no GitHub write port.
export class ReviewPublicationReuseService {
  #ports;
  #proofDiagnostic = null;
  constructor({ taskReader, factsReader, publicationSourceReader, confirmationReader, materialsReader, receiptStore, inputAuthorityVerifier, policyReader = null, clock = () => new Date() }) {
    for (const [port, methods] of [[taskReader, ["read"]], [factsReader, ["get"]],
      [publicationSourceReader, ["listReviewPublicationSources"]], [confirmationReader, ["readSettlements"]],
      [materialsReader, ["read"]], [receiptStore, ["getForProposal", "record"]], [inputAuthorityVerifier, ["verify"]]]) {
      if (methods.some(method => typeof port?.[method] !== "function")) throw new TypeError("Invalid Review reuse port");
    }
    this.#ports = { taskReader, factsReader, publicationSourceReader, confirmationReader, materialsReader, receiptStore, inputAuthorityVerifier, policyReader, clock };
  }
  async recordReviewCoverage(receipt) {
    try {
      const value = consumeCompletedReviewRead(receipt);
      if (value === null) return;
      const task = await this.#task(value.taskId, null);
      if (!samePullRequestExecutionBinding(task.inputBinding, value.inputBinding)) return;
      const proof = createReviewReadProof({ ...value, task });
      if (proof === null || typeof this.#ports.receiptStore.recordReadProof !== "function") return;
      const result = await this.#ports.receiptStore.recordReadProof(proof);
      this.#proofDiagnostic = result.diagnostic ?? null;
      return result;
    } catch { this.#proofDiagnostic = "REVIEW_READ_PROOF_UNAVAILABLE"; }
  }
  async #verifiedResult(task, candidate, signal) {
    if (standardReviewPurpose(task.event) === null || typeof this.#ports.policyReader !== "function" ||
        typeof this.#ports.receiptStore.readProofs !== "function") return null;
    try {
      const stored = await this.#ports.receiptStore.readProofs();
      this.#proofDiagnostic = stored.diagnostic ?? this.#proofDiagnostic;
      const possible = stored.records.filter(proof => proof.producerTaskId === candidate.source.producerTaskId &&
        samePullRequestExecutionBinding(proof.inputBinding, candidate.source.inputBinding) &&
        proof.bodyDigest === canonicalJsonDigest(candidate.source.publishedBody) && proof.verdict === candidate.source.publishedVerdict);
      if (possible.length === 0) return null;
      const policyDigest = await this.#ports.policyReader();
      const material = await this.#ports.materialsReader.read({ taskId: task.taskId, gitTarget: task.inputBinding.gitTarget,
        pullRequestNumber: task.inputBinding.pullRequestNumber, excludedPublication: candidate.source }, { signal });
      check(signal);
      const matches = possible.filter(proof => matchesReviewReadProof(proof, candidate.source, task, material.resultCoverage, policyDigest));
      // Ambiguous producer coverage is not an optimization proof.
      if (matches.length !== 1) return null;
      return { readProofId: matches[0].readProofId, coverageDigest: material.feedbackSnapshot.coverageDigest,
        candidateId: candidate.candidateId, materialDigest: candidate.materialDigest,
        ...(candidate.target.evidenceTarget ? { deliverableId: candidate.target.evidenceTarget.deliverables[0].deliverableId } : {}),
        ...(candidate.target.automaticSettlement ? { automaticSettlement: candidate.target.automaticSettlement } : {}),
        verdict: candidate.source.publishedVerdict, reviewUrl: candidate.coverage.publishedReviewUrl,
        purpose: matches[0].purpose };
    } catch (error) {
      check(signal);
      if (error?.code === "REVIEW_PUBLICATION_ADOPTION_CORRUPTED") throw error;
      this.#proofDiagnostic = "REVIEW_READ_PROOF_UNAVAILABLE";
      return null;
    }
  }
  async #task(taskId, signal) {
    check(signal);
    const task = await this.#ports.taskReader.read({ taskId });
    check(signal);
    if (!task || task.taskId !== taskId || task.roleId !== "pr-engineer" || held(task.status) || held(task.rootStatus) || task.acceptanceContract === null) {
      throw failure("REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE");
    }
    const current = await this.#ports.inputAuthorityVerifier.verify(task.inputBinding);
    check(signal);
    if (!samePullRequestExecutionBinding(current, task.inputBinding)) throw failure("REVIEW_PUBLICATION_REUSE_INPUT_CHANGED");
    return task;
  }
  #target(task, deliverableId) {
    try {
      if (task.automaticSettlement) return { inputBinding: task.inputBinding, requestedAt: task.requestedAt,
        automaticSettlement: task.automaticSettlement };
      return { inputBinding: task.inputBinding, requestedAt: task.requestedAt,
        evidenceTarget: createProposalDeliveryEvidenceTarget({ taskId: task.taskId, roleId: task.roleId,
          acceptanceContract: task.acceptanceContract, proposal: { kind: "github_review_proposal" }, deliverableId }) };
    } catch { throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED"); }
  }
  #settlementIds(row, task) {
    const ids = new Set((row.result?.evidence ?? []).filter(value => value.startsWith("confirmation:")).map(value => value.slice("confirmation:".length)));
    if (row.downstreamRef) ids.add(row.downstreamRef);
    try { for (const plan of historicalGitHubReviewConfirmationPlans(row.proposal, task.inputBinding.gitTarget.sourceAccountId)) ids.add(plan.id); } catch { /* Invalid historical payloads cannot form adoption sources. */ }
    return [...ids];
  }
  async #candidates(task, facts, signal) {
    const scan = await this.#ports.publicationSourceReader.listReviewPublicationSources({ inputBinding: task.inputBinding, limit: 100,
      ...(signal === null ? {} : { signal }) });
    check(signal);
    if (scan?.complete !== true || !Array.isArray(scan.items)) throw failure("REVIEW_PUBLICATION_REUSE_SOURCE_INCOMPLETE");
    const rows = scan.items.filter(row => !row.proposal?.payload?.publicationReuse);
    if (rows.some(row => !WORK_PROPOSAL_TERMINAL_STATUSES.includes(row.status) || row.status === "unknown")) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
    const rowsWithIds = rows.map(row => ({ row, ids: this.#settlementIds(row, task) }));
    const confirmationIds = [...new Set(rowsWithIds.flatMap(value => value.ids))];
    const snapshot = confirmationIds.length === 0 ? { items: [] } :
      await this.#ports.confirmationReader.readSettlements({ confirmationIds });
    check(signal);
    const settlements = new Map(snapshot.items.map(item => [item.id, { queueRevision: snapshot.queueRevision, item }]));
    const candidates = [];
    for (const { row, ids } of rowsWithIds) {
      if (ids.map(id => settlements.get(id)).some(value => value && (["pending", "executing"].includes(value.item.status) ||
          value.item.failure?.outcome === "unknown" || value.item.execution?.outcome === "unknown" || value.item.failure?.retryable === true ||
          (value.item.status === "completed" && row.status !== "succeeded")))) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      if (row.status !== "succeeded") continue;
      if (row.result?.outcome !== "succeeded") throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      const references = row.result.evidence.filter(value => value.startsWith("confirmation:"));
      if (references.length !== 1) continue;
      const confirmationSnapshot = settlements.get(references[0].slice("confirmation:".length));
      if (confirmationSnapshot == null) throw failure("REVIEW_PUBLICATION_REUSE_UNSETTLED_SOURCE");
      for (const deliverable of task.automaticSettlement ? [{ deliverableId: null }] : requiredReviewDeliverables(task.acceptanceContract)) {
        const candidate = createReviewPublicationCandidate({ source: { proposal: row.proposal, result: row.result, confirmationSnapshot },
          target: this.#target(task, deliverable.deliverableId), facts, allowHistoricalResult: true });
        if (candidate !== null) candidates.push(candidate);
      }
    }
    return candidates;
  }
  async listCandidates({ taskId, materialDigest }, { signal = null } = {}) {
    const task = await this.#task(taskId, signal);
    const facts = normalizePullRequestReadFacts(await this.#ports.factsReader.get({ executionBinding: task.inputBinding, event: task.event }));
    if (projectPullRequestReadFactsContext(facts).materialDigest !== materialDigest) throw failure("REVIEW_PUBLICATION_REUSE_MATERIAL_CHANGED");
    const candidates = await this.#candidates(task, facts, signal);
    let verifiedResult = null;
    const eligible = [];
    for (const candidate of candidates) {
      const verified = await this.#verifiedResult(task, candidate, signal);
      if (verified && !verifiedResult) verifiedResult = verified;
      if (verified || (!candidate.target.automaticSettlement && Date.parse(candidate.source.receipt.createdAt) >= Date.parse(task.requestedAt))) eligible.push(candidate);
    }
    return { complete: true, ...(verifiedResult ? { verifiedResult } : {}),
      ...(this.#proofDiagnostic ? { diagnostic: this.#proofDiagnostic } : {}),
      candidates: eligible.map(value => ({ candidateId: value.candidateId, materialDigest: value.materialDigest,
      ...(value.target.evidenceTarget ? { deliverableId: value.target.evidenceTarget.deliverables[0].deliverableId } : {}), verdict: value.source.publishedVerdict,
      reviewUrl: value.coverage.publishedReviewUrl, publishedAt: value.source.receipt.createdAt, requiresCurrentReview: true })) };
  }
  #proposal(value) {
    const { contentDigest, ...content } = value;
    const proposal = normalizeBoundWorkProposal(content);
    if (proposal.contentDigest !== contentDigest || proposal.kind !== "github_review_proposal" || !proposal.payload.publicationReuse) throw failure("REVIEW_PUBLICATION_REUSE_INVALID");
    return proposal;
  }
  async #assessment(proposal, signal) {
    const task = await this.#task(proposal.requestedBy.workItemId, signal);
    if (!samePullRequestExecutionBinding(task.inputBinding, proposal.binding.inputBinding) ||
        (task.automaticSettlement ? proposal.binding.evidenceTarget !== undefined :
          !same(this.#target(task, proposal.binding.evidenceTarget?.deliverables?.[0]?.deliverableId).evidenceTarget, proposal.binding.evidenceTarget))) throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED");
    const material = await this.#ports.materialsReader.read({ taskId: task.taskId, gitTarget: task.inputBinding.gitTarget,
      pullRequestNumber: task.inputBinding.pullRequestNumber }, { signal });
    check(signal);
    const facts = normalizePullRequestReadFacts(material.facts);
    if (!samePullRequestExecutionBinding(facts.identity.executionBinding, task.inputBinding)) throw failure("REVIEW_PUBLICATION_REUSE_INPUT_CHANGED");
    const candidates = (await this.#candidates(task, facts, signal)).filter(value => value.candidateId === proposal.payload.publicationReuse.candidateId);
    if (candidates.length !== 1) throw failure("REVIEW_PUBLICATION_REUSE_CANDIDATE_STALE");
    if (!proposal.payload.publicationReuse.readProofId && (task.automaticSettlement ||
        Date.parse(candidates[0].source.receipt.createdAt) < Date.parse(task.requestedAt))) throw failure("REVIEW_PUBLICATION_REUSE_PROOF_UNAVAILABLE");
    let verifiedResult = null;
    if (proposal.payload.publicationReuse.readProofId) {
      const verified = await this.#verifiedResult(task, candidates[0], signal);
      if (!verified || verified.readProofId !== proposal.payload.publicationReuse.readProofId ||
          verified.coverageDigest !== proposal.payload.publicationReuse.coverageDigest) throw failure("REVIEW_PUBLICATION_REUSE_PROOF_UNAVAILABLE");
      verifiedResult = verified;
    }
    const coverageDigest = verifiedResult?.coverageDigest ?? material.feedbackSnapshot.coverageDigest;
    if (proposal.payload.publicationReuse.coverageDigest !== coverageDigest) throw failure("REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED");
    return { task, candidate: candidates[0], coverageDigest };
  }
  async handle({ proposal: value }, { signal = null } = {}) {
    const proposal = this.#proposal(value);
    const assessment = await this.#assessment(proposal, signal);
    if (!["dispatch_pending", "waiting_external"].includes(assessment.task.status) || !ownsProposal(assessment.task, proposal)) throw failure("REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE");
    if (assessment.task.automaticSettlement) return { automaticSettlement: assessment.task.automaticSettlement };
    let receipt = await this.#ports.receiptStore.getForProposal({ proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest });
    if (receipt !== null) {
      if (!verifyReviewPublicationAdoption({ ...assessment, receipt, proposal })) throw failure("REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED");
    } else {
      receipt = createReviewPublicationAdoption({ ...assessment, proposal, adoptedAt: new Date(this.#ports.clock()).toISOString() });
      if (receipt === null) throw failure("REVIEW_PUBLICATION_REUSE_MATERIAL_CHANGED");
      receipt = await this.#ports.receiptStore.record(receipt);
    }
    const current = await this.#task(assessment.task.taskId, signal);
    if (!ownsProposal(current, proposal) || !same(this.#target(current, receipt.target.evidenceTarget.deliverables[0].deliverableId).evidenceTarget, receipt.target.evidenceTarget)) throw failure("REVIEW_PUBLICATION_REUSE_TARGET_CHANGED");
    return { status: "succeeded", summary: "已核实并采用既有 GitHub Review；未重复发布",
      evidence: [`adoption:${receipt.adoptionId}`, `confirmation:${receipt.source.confirmationId}`, `github-review:${receipt.source.receipt.id}`] };
  }
  async verifyAutomaticSettlement(envelope, { signal = null } = {}) {
    try {
      const reuse = envelope.action.publishedReviewReuse;
      const scan = await this.#ports.publicationSourceReader.listReviewPublicationSources({ inputBinding: envelope.action.inputBinding, limit: 100, ...(signal ? { signal } : {}) });
      if (scan?.complete !== true) return null;
      const rows = scan.items.filter(row => row.proposal.proposalId === reuse.proposalId && row.proposal.contentDigest === reuse.proposalDigest);
      if (rows.length !== 1) return null;
      const proposal = this.#proposal(rows[0].proposal);
      if (!samePullRequestExecutionBinding(envelope.action.inputBinding, proposal.binding.inputBinding) ||
          !same(proposal.requestedBy, envelope.requestedBy) || !same(proposal.payload.publicationReuse, reuse.publicationReuse) ||
          proposal.payload.body !== envelope.action.body || ({approve:"APPROVE",request_changes:"REQUEST_CHANGES",comment:"COMMENT"})[proposal.payload.verdict] !== envelope.action.reviewEvent) return null;
      const assessed = await this.#assessment(proposal, signal);
      if (!assessed.task.automaticSettlement || !ownsProposal(assessed.task, proposal)) return null;
      return assessed.candidate.source.receipt;
    } catch { return null; }
  }
  async verifyProposal({ proposal: value, result: rawResult, authority, signal = null }) {
    const proposal = this.#proposal(value), result = normalizeWorkProposalResult(rawResult);
    if (result.outcome !== "succeeded" || result.proposalId !== proposal.proposalId || result.proposalContentDigest !== proposal.contentDigest ||
        !same(result.requestedBy, proposal.requestedBy)) return false;
    if (authority && (authority.taskId !== proposal.requestedBy.workItemId || authority.roleId !== proposal.requestedBy.roleId ||
        authority.contractRevision !== proposal.binding.evidenceTarget.contractRevision || authority.contractDigest !== proposal.binding.evidenceTarget.contractDigest)) return false;
    const receipt = await this.#ports.receiptStore.getForProposal({ proposalId: proposal.proposalId, proposalDigest: proposal.contentDigest });
    if (receipt === null || result.evidence.filter(value => value.startsWith("adoption:")).length !== 1 || !result.evidence.includes(`adoption:${receipt.adoptionId}`)) return false;
    try {
      const assessment = await this.#assessment(proposal, signal);
      return verifyReviewPublicationAdoption({ ...assessment, receipt, proposal });
    } catch (error) {
      check(signal);
      if (["REVIEW_PUBLICATION_REUSE_TASK_UNAVAILABLE", "REVIEW_PUBLICATION_REUSE_INPUT_CHANGED", "REVIEW_PUBLICATION_REUSE_TARGET_CHANGED",
        "REVIEW_PUBLICATION_REUSE_CANDIDATE_STALE", "REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED"].includes(error.code)) return false;
      throw error;
    }
  }
}
