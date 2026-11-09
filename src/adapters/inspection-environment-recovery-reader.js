import { isDeepStrictEqual } from 'node:util';
import { normalizeCodeJobBrowserProjection } from '../domain/code-job-browser-projection.js';
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../domain/code-job-contract.js';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { encodeInspectionEnvironmentEvidence, INSPECTION_ENVIRONMENT_PROOF_REASON } from '../domain/inspection-environment-recovery-evidence.js';
import { attemptExecutionId } from '../services/controlled-code-executor.js';

const ACTIONS = new Set(CODE_JOB_ACTIONS_BY_OPERATION.inspect);
const unavailable = error => error?.code === 'SANDBOX_UNAVAILABLE' && error.message === 'Docker sandbox is unavailable';

// Evidence for a fresh decision after Docker recovery. Never runs a test or
// changes the old job/session; this error is raised before Docker can run.
export class InspectionEnvironmentRecoveryReader {
  constructor({ executor, artifacts, sandbox }) {
    this.executor = executor;
    this.artifacts = artifacts;
    this.sandbox = sandbox;
  }

  async read({ jobId, job: value }) {
    try {
      const job = normalizeCodeJobBrowserProjection(value);
      if (job.jobId !== jobId || job.status !== 'failed' || job.operation !== 'inspect' || job.writablePaths.length !== 0 ||
          job.inputBinding?.schemaVersion !== 2 || job.observationCount !== 1 || job.turn !== 1 ||
          job.allowedActions.some(action => !ACTIONS.has(action))) return null;
      const session = await this.executor.view({ sessionId: jobId });
      // The worker fails the job while its executor stays idle/active. Managed
      // restart interrupts that session and retains the same audited action.
      if (session.id !== jobId || !['active', 'interrupted'].includes(session.status) || session.cleanupPending !== false ||
          session.workspaceId !== job.workspaceId || !isDeepStrictEqual(session.requestedBy, job.requestedBy) ||
          !samePullRequestExecutionBinding(session.inputBinding, job.inputBinding) ||
          !/^[a-f0-9]{64}$/u.test(session.workspaceRevision ?? '') || session.actions?.length !== 1) return null;
      const action = session.actions[0];
      if (action.type !== 'run_profile' || action.status !== 'failed' || !unavailable(action.error) ||
          action.error.details?.cleanupPending === true || action.attemptNumber !== session.attempt?.number ||
          action.workspaceRevisionBefore !== session.workspaceRevision || action.workspaceRevisionAfter !== session.workspaceRevision) return null;
      const audited = await this.executor.getActionResult({ sessionId: jobId, actionId: action.id });
      if (!isDeepStrictEqual(audited.action, action) || !unavailable(audited.result?.error)) return null;
      const input = JSON.parse((await this.artifacts.read({ path: `${jobId}/${action.id}/input.json`,
        sha256: action.inputArtifact?.sha256, bytes: action.inputArtifact?.bytes })).toString('utf8'));
      if (input.type !== 'run_profile' || input.actionId !== action.id || input.expectedWorkspaceRevision !== session.workspaceRevision ||
          !job.requiredProfiles.includes(input.profileId) || !session.requiredProfiles.includes(input.profileId)) return null;
      const ready = await this.sandbox.readProfileReadiness({ profileId: input.profileId });
      if (ready?.schemaVersion !== 1 || ready.profileId !== input.profileId ||
          !isDeepStrictEqual(await this.executor.view({ sessionId: jobId }), session)) return null;
      const proof = { schemaVersion: 1, reason: INSPECTION_ENVIRONMENT_PROOF_REASON, jobId, grantDigest: job.grantDigest,
        inputBinding: structuredClone(job.inputBinding), headRefOid: job.inputBinding.headRefOid,
        actionId: action.id, executionId: attemptExecutionId(jobId, action.attemptNumber),
        profileId: input.profileId, profileConfigDigest: ready.profileConfigDigest,
        workspaceRevision: session.workspaceRevision, imageId: ready.imageId };
      encodeInspectionEnvironmentEvidence(proof);
      return proof;
    } catch {
      return null;
    }
  }
}
