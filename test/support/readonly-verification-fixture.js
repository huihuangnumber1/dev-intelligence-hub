import { createCodeJobGrant, createQueuedCodeJob, CODE_JOB_ACTIONS_BY_OPERATION } from '../../src/domain/code-job-contract.js';
import { projectNormalizedCodeJobForBrowser } from '../../src/domain/code-job-browser-projection.js';

export function readonlyVerificationFixture({ binding, workspaceId = 'repo', requiredProfile = { id: 'tests', configDigest: 'b'.repeat(64) } }) {
  const grant = createCodeJobGrant({ schemaVersion: 2, proposalId: 'proposal-verify', contentDigest: 'a'.repeat(64),
    policyVersion: 1, requestedBy: { roleId: 'developer', workItemId: binding.rootItemId },
    source: { assignmentId: 'assignment-verify', eventId: binding.eventId },
    subject: { id: `github:pr:${binding.repository}#${binding.pullRequestNumber}`, repository: binding.repository, number: binding.pullRequestNumber },
    repository: binding.repository, workspaceId, inputBinding: binding, workspaceAuthorityDigest: '9'.repeat(64),
    operation: 'verify', objective: 'Verify the outstanding review feedback', acceptanceCriteria: ['Run configured tests'],
    evidence: ['review-feedback'], summary: 'Verify feedback', reason: 'Requested changes',
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.verify], writablePaths: [],
    requiredProfiles: [requiredProfile], brainDigest: 'c'.repeat(64) });
  const raw = structuredClone(createQueuedCodeJob({ confirmationId: 'confirmation-verify', requestId: 'request-verify-0001',
    grant, displayedPayloadDigest: 'd'.repeat(64), approvalBindingDigest: 'e'.repeat(64) },
    { sequence: 1, revision: 1, createdAt: '2026-08-02T06:00:00.000Z' }));
  Object.assign(raw, { status: 'failed', updatedAt: '2026-08-02T06:01:00.000Z' });
  raw.execution.turn = 2;
  raw.execution.workspaceRevision = '7'.repeat(64);
  raw.execution.observations = [{ actionType: 'read_text', status: 'succeeded', recordedAt: raw.updatedAt },
    { actionType: 'run_profile', status: 'failed', recordedAt: raw.updatedAt }];
  raw.execution.result = { kind: 'failed', detail: { code: 'CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE', message: 'Preparation interrupted' }, recordedAt: raw.updatedAt };
  raw.execution.memoryProjection = { memoryRecordId: `memory-${'f'.repeat(64)}`, projectedAt: raw.updatedAt };
  const job = projectNormalizedCodeJobForBrowser(raw);
  const detail = { job, observations: raw.execution.observations, terminalDetail: raw.execution.result.detail,
    historyAvailable: true, nextCursor: null };
  return { grant, raw, job, detail };
}
