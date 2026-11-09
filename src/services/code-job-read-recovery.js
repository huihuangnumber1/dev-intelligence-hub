import { digestValue } from '../domain/code-executor-contract.js';
import { cleanText, incompleteReadMessage } from './code-job-worker-policy.js';

export const INCOMPLETE_READ_CODE = 'CODE_BRAIN_INCOMPLETE_READ';

export function pendingOverwriteRecoveryCandidate(job) {
  const pending = job?.execution?.pendingAction, action = pending?.action;
  if (job?.grant?.operation !== 'modify' || action?.type !== 'write_text' ||
      typeof action.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(action.expectedSha256) ||
      action.expectedWorkspaceRevision !== job.execution.workspaceRevision ||
      pending.turn !== job.execution.turn + 1 || pending.actionId !== action.actionId ||
      job.execution.actionAdmission !== null || job.execution.uncertainty !== null) return null;
  try { return pending.actionDigest === digestValue(action) ? pending : null; } catch { return null; }
}

export const incompleteReadPauseReason = path =>
  `等待人工处理（${INCOMPLETE_READ_CODE}）：${cleanText(incompleteReadMessage(path), 1_536)}`;

export function hasIncompleteReadPause(job) {
  const pending = pendingOverwriteRecoveryCandidate(job);
  return pending !== null && job.status === 'paused' && job.execution.pause?.from === 'active' &&
    job.execution.pause.reason === incompleteReadPauseReason(pending.action.path);
}

// A host read guard does not produce a new Native failure receipt. Only use
// the earlier receipt to prove that its model owner has actually stopped.
export function stoppedCodeJobRun(proof, job, before) {
  const receipt = proof?.receipt;
  const times = [job.createdAt, receipt?.registeredAt, receipt?.modelStartedAt, receipt?.finishedAt, before].map(Date.parse);
  return proof?.mode === 'active' && proof.active === false && proof.pendingCommand === null &&
    proof.stopUnconfirmed !== true && typeof proof.runId === 'string' && proof.runId.length > 0 &&
    proof.runId === receipt?.runId && receipt?.kind === 'code-job' && receipt.taskId === job.jobId &&
    receipt.roleId === job.grant.requestedBy.roleId && ['completed', 'failed'].includes(receipt.phase) &&
    receipt.stopConfirmed === true && times.every(Number.isFinite) &&
    times.every((time, index) => index === 0 || times[index - 1] <= time);
}
