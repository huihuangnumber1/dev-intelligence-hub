import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";

export function approveOwnPrAction(confirmations, item) {
  const digest = createHash("sha256").update(item.id + ":" + item.approvalBindingDigest).digest("hex");
  return confirmations.approve(item.id, {
    requestId: `auto-own-pr-repair-v1-${digest.slice(0, 48)}`,
    expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
  });
}

const MAX_PUSH_RETRIES = 3;
export function validateOwnPrPushRetry(value) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value?.attempt) || value.attempt < 1 || value.attempt > MAX_PUSH_RETRIES ||
      !Number.isSafeInteger(value.itemRevision) || value.itemRevision < 1) throw new Error("自动推送重试记录无效");
}

export function planOwnPrPushRetry(record, item) {
  if (item.kind !== "github.pull-request-push" || item.status !== "failed" || item.failure?.outcome !== "absent" ||
      item.failure.retryable !== true || !["GITHUB_TIMEOUT", "GITHUB_UNAVAILABLE"].includes(item.failure.code)) return null;
  const previous = record.pushRetry;
  if (previous?.itemRevision === item.itemRevision) return previous;
  if ((previous?.attempt ?? 0) >= MAX_PUSH_RETRIES) return null;
  return { attempt: (previous?.attempt ?? 0) + 1, itemRevision: item.itemRevision };
}

export function retryOwnPrPush(confirmations, item, retry) {
  const digest = createHash("sha256").update(`${item.id}:${item.approvalBindingDigest}:retry:${retry.itemRevision}`).digest("hex");
  return confirmations.retry(item.id, {
    requestId: `auto-own-pr-repair-v1-${digest.slice(0, 48)}`,
    expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
  });
}

export function repairCommitMatchesJob({ evidence, receipt, record, grant, sourceKind, requireProfiles = false }) {
  return evidence.evidenceDigest === receipt.evidenceDigest && evidence.commit.oid === receipt.commitOid &&
    (sourceKind !== 'ci_repair' || (record.feedbackDigest === grant.executionSource?.ciEvidence?.contentDigest &&
      record.ciTriggerDigest === grant.executionSource.ciEvidence.triggerDigest)) &&
    evidence.package.job.id === record.jobId && evidence.executionSource.kind === sourceKind &&
    codeJobIdForGrant(grant) === record.jobId && evidence.package.grant.digest === grant.grantDigest &&
    evidence.package.proposal.id === grant.proposalId && evidence.package.proposal.contentDigest === grant.contentDigest &&
    evidence.workspace.id === grant.workspaceId && isDeepStrictEqual(evidence.executionSource, grant.executionSource) &&
    (!requireProfiles || grant.requiredProfiles.length > 0) && evidence.tests.profiles.length === grant.requiredProfiles.length &&
    grant.requiredProfiles.every(required => evidence.tests.profiles.some(profile => profile.id === required.id &&
      profile.configDigest === required.configDigest && profile.workspaceRevision === evidence.workspace.workspaceRevision)) &&
    samePullRequestExecutionBinding(evidence.executionSource.inputBinding, record.inputBinding);
}
