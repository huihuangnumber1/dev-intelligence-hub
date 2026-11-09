import {
  deliveryEvidenceKindsForProposal,
  normalizeDeliveryEvidenceTarget,
} from "../domain/delivery-evidence-contract.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,190}[A-Za-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_DELIVERABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const CHANGE_PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const CODE_JOB_ID = /^code-job-[a-f0-9]{55}$/;
const WORK_PROPOSAL_RESULT_ID = /^work-proposal-result-[a-f0-9]{64}$/;
const SUPPORTED_KINDS = new Set([
  "change-package",
  "test-report",
  "review-report",
  "github-review",
]);
const MAXIMUM_CATALOG_ENTRIES = 20;
const CANDIDATE_PAGE_SIZE = 100;
const MAXIMUM_CANDIDATE_PAGES = 10;

export class DeliveryEvidenceServiceError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "DeliveryEvidenceServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message, options) {
  return new DeliveryEvidenceServiceError(
    "DELIVERY_EVIDENCE_INVALID",
    message,
    400,
    options,
  );
}

function bindOptionalPort(value, methods, name) {
  if (value === undefined || value === null) return null;
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

function ownObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function taskId(value) {
  if (
    typeof value !== "string" ||
    !SAFE_TASK_ID.test(value) ||
    Buffer.byteLength(value, "utf8") > 192
  ) {
    throw invalid("taskId is invalid");
  }
  return value;
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function roleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw invalid("roleId is invalid");
  }
  return value;
}

function contractDigest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid("contractDigest is invalid");
  }
  return value;
}

function deliverableId(value) {
  if (
    typeof value !== "string" ||
    !SAFE_DELIVERABLE_ID.test(value)
  ) {
    throw invalid("deliverableId is invalid");
  }
  return value;
}

function authority(input, { requireDeliverable }) {
  return {
    taskId: taskId(input.taskId),
    roleId: roleId(input.roleId),
    contractRevision: positiveRevision(
      input.contractRevision,
      "contractRevision",
    ),
    contractDigest: contractDigest(input.contractDigest),
    ...(requireDeliverable
      ? { deliverableId: deliverableId(input.deliverableId) }
      : {}),
  };
}

function limit(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_CATALOG_ENTRIES
  ) {
    throw invalid("limit is invalid");
  }
  return value;
}

function optionalSignal(value) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function" ||
    typeof value.throwIfAborted !== "function"
  ) {
    throw invalid("signal is invalid");
  }
  return value;
}

function evidenceRecord(value) {
  const record = ownObject(value, "evidence");
  if (
    Reflect.ownKeys(record).length !== 3 ||
    !Object.hasOwn(record, "kind") ||
    !Object.hasOwn(record, "referenceId") ||
    !Object.hasOwn(record, "contentDigest") ||
    !SUPPORTED_KINDS.has(record.kind) ||
    typeof record.referenceId !== "string" ||
    !record.referenceId ||
    Buffer.byteLength(record.referenceId, "utf8") > 512 ||
    !SHA256.test(record.contentDigest)
  ) {
    throw invalid("evidence is invalid");
  }
  return {
    kind: record.kind,
    referenceId: record.referenceId,
    contentDigest: record.contentDigest,
  };
}

function requestedWorkItem(value) {
  return value?.requestedBy?.workItemId;
}

function proposalSupportsEvidenceKind(proposal, evidenceKind) {
  const kind = proposal?.kind;
  const descriptor = kind === "code_action_proposal"
    ? { kind, operation: proposal?.payload?.operation }
    : { kind };
  return deliveryEvidenceKindsForProposal(descriptor).includes(evidenceKind);
}

function proposalTarget(proposal, expected, kind, deliverable = null) {
  if (expected.inputBinding !== undefined) {
    try {
      if (!samePullRequestExecutionBinding(proposal?.binding?.inputBinding, expected.inputBinding)) return null;
    } catch { return null; }
  }
  if (
    proposal?.requestedBy?.workItemId !== expected.taskId ||
    proposal.requestedBy.roleId !== expected.roleId ||
    !proposalSupportsEvidenceKind(proposal, kind)
  ) {
    return null;
  }
  let target;
  try {
    target = normalizeDeliveryEvidenceTarget(
      proposal?.binding?.evidenceTarget,
    );
  } catch {
    return null;
  }
  if (
    target.taskId !== expected.taskId ||
    target.roleId !== expected.roleId ||
    target.contractRevision !== expected.contractRevision ||
    target.contractDigest !== expected.contractDigest ||
    !target.deliverables.some(
      ({ deliverableId: candidate, kind: candidateKind }) =>
        candidateKind === kind &&
        (deliverable === null || candidate === deliverable),
    )
  ) {
    return null;
  }
  return target;
}

function checkAbort(signal) {
  signal?.throwIfAborted();
}

function descriptorKey({ deliverableId: id, evidence }) {
  return `${id}\u0000${evidence.kind}\u0000${evidence.referenceId}\u0000${evidence.contentDigest}`;
}

function compareEvidence(left, right) {
  const leftKey = descriptorKey(left);
  const rightKey = descriptorKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function uniqueEvidence(records) {
  const byKey = new Map();
  for (const record of records) {
    byKey.set(descriptorKey(record), record);
  }
  return [...byKey.values()].sort(compareEvidence);
}

function memoryDigest(job) {
  const recordId = job?.memoryProjection?.recordId;
  return typeof recordId === "string" && /^memory-[a-f0-9]{64}$/.test(recordId)
    ? recordId.slice("memory-".length)
    : null;
}

function testEvidence(job, expectedTaskId) {
  const contentDigest = memoryDigest(job);
  if (
    job?.operation !== "verify" ||
    job.status !== "completed" ||
    requestedWorkItem(job) !== expectedTaskId ||
    !CODE_JOB_ID.test(job.jobId) ||
    contentDigest === null
  ) {
    return null;
  }
  return {
    kind: "test-report",
    referenceId: job.jobId,
    contentDigest,
  };
}

function changePackageEvidence(source, expectedTaskId) {
  const job = source?.job;
  const receipt = source?.changePackage?.receipt;
  if (
    job?.operation !== "modify" ||
    job.status !== "completed" ||
    requestedWorkItem(job) !== expectedTaskId ||
    source?.changePackage?.status !== "ready" ||
    !CHANGE_PACKAGE_ID.test(receipt?.packageId) ||
    !SHA256.test(receipt?.packageDigest) ||
    receipt.packageId !== `change-package-${receipt.packageDigest}`
  ) {
    return null;
  }
  return {
    kind: "change-package",
    referenceId: receipt.packageId,
    contentDigest: receipt.packageDigest,
  };
}

function codeJobResultReference(result) {
  if (
    result?.kind !== "code_action_proposal" ||
    result.outcome !== "succeeded" ||
    !Array.isArray(result.evidence)
  ) {
    return null;
  }
  const codeJobs = result.evidence.filter(
    (entry) => typeof entry === "string" && entry.startsWith("code-job:"),
  );
  const statuses = result.evidence.filter(
    (entry) =>
      typeof entry === "string" && entry.startsWith("code-job-status:"),
  );
  const memories = result.evidence.filter(
    (entry) => typeof entry === "string" && entry.startsWith("memory:"),
  );
  const jobId = codeJobs[0]?.slice("code-job:".length);
  const status = statuses[0]?.slice("code-job-status:".length);
  const memoryRecordId = memories[0]?.slice("memory:".length);
  if (
    codeJobs.length !== 1 ||
    statuses.length !== 1 ||
    memories.length !== 1 ||
    !CODE_JOB_ID.test(jobId) ||
    status !== "completed" ||
    !/^memory-[a-f0-9]{64}$/.test(memoryRecordId)
  ) {
    return null;
  }
  return { jobId, status, memoryRecordId };
}

function codeJobMatchesResult(job, proposal, result, reference, expected) {
  return (
    reference !== null &&
    job?.jobId === reference.jobId &&
    job.status === reference.status &&
    job.memoryProjection?.recordId === reference.memoryRecordId &&
    job.proposalId === proposal?.proposalId &&
    job.proposalContentDigest === proposal?.contentDigest &&
    result?.proposalId === proposal?.proposalId &&
    result.proposalContentDigest === proposal?.contentDigest &&
    requestedWorkItem(result) === expected.taskId &&
    result.requestedBy?.roleId === expected.roleId &&
    requestedWorkItem(job) === expected.taskId &&
    job.requestedBy?.roleId === expected.roleId
  );
}

function reviewProposalResultMatches(proposal, result, expected) {
  return (
    proposal?.kind === "github_review_proposal" &&
    result?.kind === proposal.kind &&
    result.outcome === "succeeded" &&
    typeof proposal.proposalId === "string" &&
    SHA256.test(proposal.contentDigest) &&
    result.proposalId === proposal.proposalId &&
    result.proposalContentDigest === proposal.contentDigest &&
    requestedWorkItem(proposal) === expected.taskId &&
    proposal.requestedBy?.roleId === expected.roleId &&
    requestedWorkItem(result) === expected.taskId &&
    result.requestedBy?.roleId === expected.roleId &&
    WORK_PROPOSAL_RESULT_ID.test(result.resultId) &&
    SHA256.test(result.contentDigest) &&
    result.resultId === `work-proposal-result-${result.contentDigest}`
  );
}

function proposalEvidence(proposal, result, expected) {
  if (!reviewProposalResultMatches(proposal, result, expected)) {
    return [];
  }
  const common = {
    referenceId: result.resultId,
    contentDigest: result.contentDigest,
  };
  return [
    { kind: "review-report", ...common },
    { kind: "github-review", ...common },
  ];
}

function exactEvidence(left, right) {
  return left.kind === right.kind &&
    left.referenceId === right.referenceId &&
    left.contentDigest === right.contentDigest;
}

function evidenceDescriptor(proposal, expected, evidence) {
  const target = proposalTarget(proposal, expected, evidence.kind);
  if (target === null) return null;
  return {
    deliverableId: target.deliverables[0].deliverableId,
    evidence,
  };
}

function evidenceCandidatePage(value, beforeSequence) {
  const page = ownObject(value, "evidence candidate page");
  if (
    Reflect.ownKeys(page).length !== 2 ||
    !Object.hasOwn(page, "items") ||
    !Object.hasOwn(page, "nextBeforeSequence") ||
    !Array.isArray(page.items) ||
    page.items.length > CANDIDATE_PAGE_SIZE ||
    !(
      page.nextBeforeSequence === null ||
      (Number.isSafeInteger(page.nextBeforeSequence) &&
        page.nextBeforeSequence >= 1 &&
        page.nextBeforeSequence < beforeSequence)
    )
  ) {
    throw invalid("evidence candidate page is invalid");
  }
  const items = page.items.map((entry) => {
    const candidate = ownObject(entry, "evidence candidate");
    if (
      Reflect.ownKeys(candidate).length !== 2 ||
      !Object.hasOwn(candidate, "proposal") ||
      !Object.hasOwn(candidate, "result")
    ) {
      throw invalid("evidence candidate is invalid");
    }
    return candidate;
  });
  if (
    page.nextBeforeSequence !== null &&
    page.nextBeforeSequence !== items.at(-1)?.result?.sequence
  ) {
    throw invalid("evidence candidate cursor is invalid");
  }
  return { items, nextBeforeSequence: page.nextBeforeSequence };
}

export class DeliveryEvidenceService {
  #changePackages;
  #codeJobs;
  #proposalResults;
  #publicationAdoptions;

  constructor({ changePackageReader, codeJobReader, proposalResultReader, publicationAdoptionVerifier } = {}) {
    this.#changePackages = bindOptionalPort(
      changePackageReader,
      ["get"],
      "changePackageReader",
    );
    this.#codeJobs = bindOptionalPort(
      codeJobReader,
      ["readDeliveryEvidence"],
      "codeJobReader",
    );
    this.#proposalResults = bindOptionalPort(
      proposalResultReader,
      [
        "getResult",
        "getProposalForEvidence",
        "getResultForProposal",
        "listEvidenceCandidates",
      ],
      "proposalResultReader",
    );
    this.#publicationAdoptions = bindOptionalPort(publicationAdoptionVerifier, ["verifyProposal"], "publicationAdoptionVerifier");
    Object.freeze(this);
  }

  async #verifyAdoption(proposal, result, authority, signal) {
    if (!Object.hasOwn(proposal.payload, "publicationReuse")) return true;
    if (this.#publicationAdoptions === null) return false;
    checkAbort(signal);
    const verified = await this.#publicationAdoptions.verifyProposal({ proposal, result, authority,
      ...(signal === null ? {} : { signal }) });
    checkAbort(signal);
    return verified === true;
  }

  async listForTask(value) {
    const input = ownObject(value, "listForTask input");
    const expected = authority(input, { requireDeliverable: false });
    const maximum = limit(input.limit ?? MAXIMUM_CATALOG_ENTRIES);
    const signal = optionalSignal(input.signal);
    const kinds = input.kinds === undefined
      ? SUPPORTED_KINDS
      : new Set(input.kinds);
    if (
      kinds.size === 0 ||
      [...kinds].some((kind) => !SUPPORTED_KINDS.has(kind))
    ) {
      throw invalid("kinds is invalid");
    }
    checkAbort(signal);
    const records = await this.#listProposalEvidence(
      expected,
      kinds,
      maximum,
      signal,
    );
    checkAbort(signal);
    return Object.freeze(
      uniqueEvidence(records)
        .slice(0, maximum)
        .map(({ deliverableId: id, evidence }) =>
          Object.freeze({
            deliverableId: id,
            evidence: Object.freeze(evidence),
          })
        ),
    );
  }

  async verify(value) {
    const input = ownObject(value, "verify input");
    const expected = { ...authority(input, { requireDeliverable: true }),
      ...(input.inputBinding === undefined ? {} : { inputBinding: normalizePullRequestExecutionBinding(input.inputBinding) }) };
    const evidence = evidenceRecord(input.evidence);
    const signal = optionalSignal(input.signal);
    checkAbort(signal);
    let authoritative = null;
    if (evidence.kind === "change-package") {
      authoritative = await this.#verifyChangePackage(
        evidence,
        expected,
        signal,
      );
    } else if (evidence.kind === "test-report") {
      authoritative = await this.#verifyTestReport(
        evidence,
        expected,
        signal,
      );
    } else {
      authoritative = await this.#verifyProposalResult(
        evidence,
        expected,
        signal,
      );
    }
    checkAbort(signal);
    return authoritative !== null && exactEvidence(authoritative, evidence)
      ? authoritative
      : false;
  }

  async #listProposalEvidence(expected, kinds, maximum, signal) {
    if (this.#proposalResults === null) return [];
    const records = [];
    let beforeSequence = Number.MAX_SAFE_INTEGER;
    for (
      let pageNumber = 0;
      pageNumber < MAXIMUM_CANDIDATE_PAGES && records.length < maximum;
      pageNumber += 1
    ) {
      checkAbort(signal);
      const rawPage = await this.#proposalResults.listEvidenceCandidates({
        ...expected,
        kinds: [...kinds],
        beforeSequence,
        limit: CANDIDATE_PAGE_SIZE,
        ...(signal === null ? {} : { signal }),
      });
      checkAbort(signal);
      const page = evidenceCandidatePage(rawPage, beforeSequence);
      for (const candidate of page.items) {
        records.push(
          ...(await this.#evidenceForCandidate(
            candidate,
            expected,
            kinds,
            signal,
          )),
        );
        if (records.length >= maximum) break;
      }
      if (records.length >= maximum || page.nextBeforeSequence === null) break;
      if (pageNumber === MAXIMUM_CANDIDATE_PAGES - 1) {
        throw invalid("evidence candidate scan exceeded its bound");
      }
      beforeSequence = page.nextBeforeSequence;
    }
    return records;
  }

  async #evidenceForCandidate(candidate, expected, kinds, signal) {
    const { proposal, result } = candidate;
    let target;
    try {
      target = normalizeDeliveryEvidenceTarget(
        proposal?.binding?.evidenceTarget,
      );
    } catch {
      return [];
    }
    const [deliverable] = target.deliverables;
    if (
      !kinds.has(deliverable.kind) ||
      proposalTarget(proposal, expected, deliverable.kind) === null
    ) {
      return [];
    }
    if (proposal.kind === "github_review_proposal") {
      const evidence = proposalEvidence(proposal, result, expected).find(
        ({ kind }) => kind === deliverable.kind,
      );
      if (evidence === undefined || !await this.#verifyAdoption(proposal, result, expected, signal)) return [];
      const descriptor = evidenceDescriptor(proposal, expected, evidence);
      return descriptor === null ? [] : [descriptor];
    }
    if (this.#codeJobs === null || proposal.kind !== "code_action_proposal") {
      return [];
    }
    const reference = codeJobResultReference(result);
    if (reference === null) return [];
    const source = await this.#codeJobs.readDeliveryEvidence({
      jobId: reference.jobId,
      ...(signal === null ? {} : { signal }),
    });
    checkAbort(signal);
    if (!codeJobMatchesResult(source?.job, proposal, result, reference, expected)) {
      return [];
    }
    const evidence = deliverable.kind === "test-report"
      ? testEvidence(source.job, expected.taskId)
      : deliverable.kind === "change-package"
      ? changePackageEvidence(source, expected.taskId)
      : null;
    const descriptor = evidence === null
      ? null
      : evidenceDescriptor(proposal, expected, evidence);
    return descriptor === null ? [] : [descriptor];
  }

  async #verifyChangePackage(evidence, expected, signal) {
    if (
      this.#changePackages === null ||
      this.#codeJobs === null ||
      !CHANGE_PACKAGE_ID.test(evidence.referenceId)
    ) {
      return null;
    }
    let manifest;
    try {
      manifest = await this.#changePackages.get(
        evidence.referenceId,
        signal === null ? undefined : { signal },
      );
    } catch (error) {
      if (error?.code === "CHANGE_PACKAGE_NOT_FOUND") return null;
      throw error;
    }
    checkAbort(signal);
    if (
      manifest?.packageId !== evidence.referenceId ||
      manifest.packageDigest !== evidence.contentDigest ||
      !CODE_JOB_ID.test(manifest?.job?.id) ||
      typeof manifest?.proposal?.id !== "string" ||
      !SHA256.test(manifest?.proposal?.contentDigest) ||
      !SHA256.test(manifest?.grant?.digest)
    ) {
      return null;
    }
    const source = await this.#codeJobs.readDeliveryEvidence({
      jobId: manifest.job.id,
      ...(signal === null ? {} : { signal }),
    });
    checkAbort(signal);
    const proposal = await this.#proposalResults?.getProposalForEvidence(
      {
        proposalId: manifest.proposal.id,
        ...(signal === null ? {} : { signal }),
      },
    );
    checkAbort(signal);
    const result = proposal === undefined
      ? null
      : await this.#proposalResults?.getResultForProposal({
          proposalId: manifest.proposal.id,
          ...(signal === null ? {} : { signal }),
        });
    checkAbort(signal);
    const job = source?.job;
    const discovered = changePackageEvidence(source, expected.taskId);
    const resultReference = codeJobResultReference(result);
    if (
      discovered === null ||
      !exactEvidence(discovered, evidence) ||
      job?.proposalId !== manifest.proposal.id ||
      job?.proposalContentDigest !== manifest.proposal.contentDigest ||
      job?.grantDigest !== manifest.grant.digest ||
      proposal?.contentDigest !== manifest.proposal.contentDigest ||
      !codeJobMatchesResult(
        job,
        proposal,
        result,
        resultReference,
        expected,
      ) ||
      proposalTarget(
        proposal,
        expected,
        evidence.kind,
        expected.deliverableId,
      ) === null
    ) {
      return null;
    }
    return discovered;
  }

  async #verifyTestReport(evidence, expected, signal) {
    if (this.#codeJobs === null || !CODE_JOB_ID.test(evidence.referenceId)) {
      return null;
    }
    const source = await this.#codeJobs.readDeliveryEvidence({
      jobId: evidence.referenceId,
      ...(signal === null ? {} : { signal }),
    });
    checkAbort(signal);
    const job = source?.job;
    const proposal = await this.#proposalForJob(job, signal);
    const result = proposal === null
      ? null
      : await this.#proposalResults.getResultForProposal({
          proposalId: proposal.proposalId,
          ...(signal === null ? {} : { signal }),
        });
    checkAbort(signal);
    const resultReference = codeJobResultReference(result);
    if (
      !codeJobMatchesResult(
        job,
        proposal,
        result,
        resultReference,
        expected,
      ) ||
      proposalTarget(
        proposal,
        expected,
        evidence.kind,
        expected.deliverableId,
      ) === null
    ) {
      return null;
    }
    return testEvidence(job, expected.taskId);
  }

  async #verifyProposalResult(evidence, expected, signal) {
    if (
      this.#proposalResults === null ||
      !WORK_PROPOSAL_RESULT_ID.test(evidence.referenceId)
    ) {
      return null;
    }
    const result = await this.#proposalResults.getResult({
      resultId: evidence.referenceId,
      ...(signal === null ? {} : { signal }),
    });
    checkAbort(signal);
    const proposal = result === null
      ? null
      : await this.#proposalResults.getProposalForEvidence({
          proposalId: result.proposalId,
          ...(signal === null ? {} : { signal }),
        });
    checkAbort(signal);
    if (
      proposalTarget(
        proposal,
        expected,
        evidence.kind,
        expected.deliverableId,
      ) === null
    ) {
      return null;
    }
    const record = proposalEvidence(proposal, result, expected).find(
      ({ kind }) => kind === evidence.kind,
    ) ?? null;
    return record !== null && await this.#verifyAdoption(proposal, result, expected, signal) ? record : null;
  }

  async #proposalForJob(job, signal) {
    if (
      this.#proposalResults === null ||
      typeof job?.proposalId !== "string"
    ) {
      return null;
    }
    const proposal = await this.#proposalResults.getProposalForEvidence(
      {
        proposalId: job.proposalId,
        ...(signal === null ? {} : { signal }),
      },
    );
    checkAbort(signal);
    return proposal?.contentDigest === job.proposalContentDigest
      ? proposal
      : null;
  }
}
