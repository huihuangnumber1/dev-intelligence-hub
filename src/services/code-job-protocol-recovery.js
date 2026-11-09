import { digestValue, normalizeActionRequest } from '../domain/code-executor-contract.js';

const CODES = new Set([
  "STRUCTURED_PROVIDER_RESPONSE_INVALID", "CODE_BRAIN_COMPLETION_NOT_READY", "CODE_BRAIN_RESPONSE_INVALID", "CODE_ARTIFACT_READ_INCOMPLETE",
]);

export const MODEL_QUEUE_TIMEOUT = 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT';

// A prepared read has no executor owner until admission. Keep its durable ID:
// the normal worker must reconcile it before deciding whether to execute it.
export function hasUnadmittedProtocolRead(job) {
  const execution = job?.execution, pending = execution?.pendingAction, action = pending?.action;
  if (execution?.actionAdmission !== null || execution.uncertainty !== null ||
      !['read_text', 'list_files', 'search_text'].includes(action?.type) ||
      !job.grant?.allowedActions?.includes(action.type) ||
      pending.turn !== execution.turn + 1 || pending.actionId !== action.actionId ||
      action.expectedWorkspaceRevision !== execution.workspaceRevision) return false;
  try {
    normalizeActionRequest({ sessionId: job.jobId, action });
    return pending.actionDigest === digestValue(action);
  } catch { return false; }
}

// Positive host stop evidence for a reservation that never admitted a model.
// Empty session metadata alone cannot authorize an automatic retry.
export function stoppedCodeJobQueueTimeout(job, run) {
  const receipt = run?.receipt;
  const times = [job?.createdAt, receipt?.registeredAt, receipt?.finishedAt].map(Date.parse);
  return run?.active === false && run.mode === 'active' && run.pendingCommand === null && run.stopUnconfirmed !== true &&
    run.kind === 'code-job' && run.taskId === job.jobId && run.roleId === job.grant.requestedBy.roleId &&
    typeof run.runId === 'string' && run.runId.length > 0 && receipt?.runId === run.runId &&
    receipt.kind === 'code-job' && receipt.taskId === job.jobId && receipt.roleId === run.roleId &&
    receipt.phase === 'failed' && receipt.outcomeCode === MODEL_QUEUE_TIMEOUT && receipt.stopConfirmed === true &&
    receipt.modelStartedAt === null && receipt.session === null && receipt.eventCount === 0 &&
    times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2];
}

export function isCodeProtocolRecoveryCode(code) { return CODES.has(code); }

// Advisory feedback only: the next invocation still owns a new capability and
// validates all actions against its current durable checkpoint.
export function codeProtocolRecoveryFor(job, run) {
  const receipt = run?.receipt;
  if (run?.active !== false || run.mode !== "active" || run.pendingCommand !== null || run.stopUnconfirmed === true ||
      run.kind !== "code-job" || run.taskId !== job.jobId || run.roleId !== job.grant.requestedBy.roleId ||
      receipt?.kind !== "code-job" || receipt.taskId !== job.jobId || receipt.roleId !== run.roleId ||
      receipt.runId !== run.runId || receipt.phase !== "failed" || !receipt.finishedAt || receipt.stopConfirmed !== true ||
      receipt.session?.transport !== "app-server" || !CODES.has(receipt.outcomeCode)) return null;
  return receipt.outcomeCode;
}

export function codeProtocolRecoveryMessages(code) {
  if (code === undefined) return [];
  if (!CODES.has(code)) throw new TypeError("protocolRecoveryCode is invalid");
  const readRecovery = code === "CODE_ARTIFACT_READ_INCOMPLETE"
    ? " For this failure, use get_state.sources as the completion checklist. For every entry with fullyRead=false, call read_source from offset 0 and follow nextOffset until null, echoing the returned sourceVersion on subsequent pages. read_text observations are previews and cannot satisfy this checklist, even when a preview appears complete. Read proofs must come from read_source in this same invocation; earlier conversations and earlier native runs cannot supply them. Refresh get_state afterward and continue reading until every current source has fullyRead=true. Then finish the task and required profiles before returning complete."
    : "";
  return [{ role: "system", content: `Previous host validation failed (${code}). This is a fresh continuous invocation, not a request to repeat its final answer. Call get_state and inspect the current checkpoint. Do not replay actions from the previous response or earlier tools. Use perform_action for allowed nonterminal actions such as read_text, write_text and run_profile; these are not final answers. Use read_source for full audited source pages. Return a final complete decision only after current reads and required checks are satisfied. A rejected final response is not evidence that its suggested action executed.${readRecovery}` }];
}
