import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { normalizeCodeJobBrowserProjection } from "../domain/code-job-browser-projection.js";
import { cloneWorkProposalValue, normalizeWorkProposalDigest, workProposalError } from "../domain/work-proposal-contract.js";

function sameValue(left, right) {
  try {
    return JSON.stringify(cloneWorkProposalValue(left)) === JSON.stringify(cloneWorkProposalValue(right));
  } catch {
    return false;
  }
}

export function normalizeCodeJobConfirmationResult(value, grant, receipt) {
  const error = workProposalError("INVALID_CODE_JOB_RESULT", "代码任务结果无效");
  const job = normalizeCodeJobBrowserProjection(value, error);
  const expectedJobId = codeJobIdForGrant(grant);
  const expected = {
    requestedBy: grant.requestedBy,
    subject: grant.subject,
    ...(Object.hasOwn(grant, "inputBinding")
      ? { inputBinding: grant.inputBinding }
      : {}),
    ...(Object.hasOwn(grant, "executionSource")
      ? { executionSource: grant.executionSource }
      : {}),
    acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence,
    allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths,
    requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, job[key]]),
  );
  if (
    job.jobId !== expectedJobId ||
    receipt.id !== expectedJobId ||
    job.proposalId !== grant.proposalId ||
    normalizeWorkProposalDigest(job.proposalContentDigest, error) !==
      grant.contentDigest ||
    normalizeWorkProposalDigest(job.grantDigest, error) !== grant.grantDigest ||
    job.repository !== grant.repository ||
    job.workspaceId !== grant.workspaceId ||
    job.operation !== grant.operation ||
    job.objective !== grant.objective ||
    job.summary !== grant.summary ||
    job.reason !== grant.reason ||
    !sameValue(actual, expected) ||
    job.createdAt !== receipt.createdAt ||
    (job.pendingActionType !== null &&
      !grant.allowedActions.includes(job.pendingActionType))
  ) {
    throw error;
  }
  return job;
}
