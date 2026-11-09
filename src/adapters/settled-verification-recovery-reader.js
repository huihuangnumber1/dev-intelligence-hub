import { isDeepStrictEqual } from 'node:util';
import { normalizeCodeJobBrowserProjection } from '../domain/code-job-browser-projection.js';
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../domain/code-job-contract.js';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { attemptExecutionId } from '../services/controlled-code-executor.js';

const READONLY_ACTIONS = new Set(CODE_JOB_ACTIONS_BY_OPERATION.verify);
const REASON = 'preparation_interrupted_cleanup_confirmed';

// This is evidence for a fresh decision, never a retry or a successful result
// for the old job. Both its immutable audit and owned runtime cleanup must agree.
export class SettledVerificationRecoveryReader {
  constructor({ executor, artifacts, sandbox }) {
    if (typeof executor?.view !== 'function' || typeof executor.getActionResult !== 'function' ||
        typeof artifacts?.read !== 'function' || typeof sandbox?.readSettledPreparationFailure !== 'function') {
      throw new TypeError('Settled verification recovery readers are unavailable');
    }
    this.executor = Object.freeze({ view: executor.view.bind(executor), getActionResult: executor.getActionResult.bind(executor) });
    this.artifacts = Object.freeze({ read: artifacts.read.bind(artifacts) });
    this.sandbox = Object.freeze({ readSettledPreparationFailure: sandbox.readSettledPreparationFailure.bind(sandbox) });
  }

  async read({ jobId, job: value }) {
    try {
      const job = normalizeCodeJobBrowserProjection(value);
      if (job.jobId !== jobId || job.status !== 'failed' || job.operation !== 'verify' || job.writablePaths.length !== 0 ||
          job.inputBinding?.schemaVersion !== 2 || job.memoryProjection === null ||
          job.allowedActions.some(action => !READONLY_ACTIONS.has(action))) return null;
      const session = await this.executor.view({ sessionId: jobId });
      if (session.id !== jobId || !['failed', 'interrupted'].includes(session.status) || session.cleanupPending !== false ||
          session.workspaceId !== job.workspaceId || !isDeepStrictEqual(session.requestedBy, job.requestedBy) ||
          !samePullRequestExecutionBinding(session.inputBinding, job.inputBinding) ||
          !/^[a-f0-9]{64}$/u.test(session.workspaceRevision ?? '') ||
          !Array.isArray(session.actions) || session.actions.length !== job.observationCount || session.actions.length > 20 ||
          session.actions.some(action => !READONLY_ACTIONS.has(action.type) || !['succeeded', 'failed'].includes(action.status))) return null;
      const action = session.actions.at(-1);
      if (action?.type !== 'run_profile' || action.status !== 'failed' || action.error?.code !== 'SANDBOX_START_FAILED' ||
          action.attemptNumber !== session.attempt?.number ||
          action.workspaceRevisionBefore !== session.workspaceRevision || action.workspaceRevisionAfter !== session.workspaceRevision) return null;
      const audited = await Promise.allSettled(session.actions.map(entry =>
        this.executor.getActionResult({ sessionId: jobId, actionId: entry.id })));
      if (audited.some((entry, index) => entry.status !== 'fulfilled' || !isDeepStrictEqual(entry.value.action, session.actions[index]))) return null;
      const result = audited.at(-1).value.result;
      if (result?.error?.code !== 'SANDBOX_START_FAILED' || result.error.message !== 'Windows test preparation was interrupted') return null;
      const input = JSON.parse((await this.artifacts.read({ path: `${jobId}/${action.id}/input.json`,
        sha256: action.inputArtifact?.sha256, bytes: action.inputArtifact?.bytes })).toString('utf8'));
      if (input.type !== 'run_profile' || input.actionId !== action.id || input.expectedWorkspaceRevision !== session.workspaceRevision ||
          !job.requiredProfiles.includes(input.profileId)) return null;
      const executionId = attemptExecutionId(jobId, action.attemptNumber);
      const cleanup = await this.sandbox.readSettledPreparationFailure({ executionId, actionId: action.id, profileId: input.profileId });
      if (cleanup?.reason !== REASON || cleanup.executionId !== executionId || cleanup.actionId !== action.id ||
          cleanup.profileId !== input.profileId || !/^[a-f0-9]{64}$/u.test(cleanup.profileConfigDigest ?? '') ||
          !isDeepStrictEqual(await this.executor.view({ sessionId: jobId }), session)) return null;
      return Object.freeze({ schemaVersion: 1, jobId, grantDigest: job.grantDigest,
        inputBinding: structuredClone(job.inputBinding), actionId: action.id, executionId,
        profileId: input.profileId, profileConfigDigest: cleanup.profileConfigDigest,
        workspaceRevision: session.workspaceRevision, reason: REASON });
    } catch {
      return null;
    }
  }
}
