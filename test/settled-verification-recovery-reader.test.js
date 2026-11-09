import assert from 'node:assert/strict';
import test from 'node:test';
import { SettledVerificationRecoveryReader } from '../src/adapters/settled-verification-recovery-reader.js';
import { attemptExecutionId } from '../src/services/controlled-code-executor.js';
import { pullRequestExternalActionBinding } from './support/pull-request-external-action-fixture.js';
import { readonlyVerificationFixture } from './support/readonly-verification-fixture.js';

function fixture() {
  const { job } = readonlyVerificationFixture({ binding: pullRequestExternalActionBinding() });
  const revision = '7'.repeat(64);
  const session = { id: job.jobId, status: 'interrupted', cleanupPending: false, revision: 4,
    workspaceId: job.workspaceId, workspaceRevision: revision, requestedBy: job.requestedBy,
    inputBinding: job.inputBinding, attempt: { number: 1, status: 'interrupted' },
    actions: [{ id: 'action-read', type: 'read_text', status: 'succeeded', attemptNumber: 1 },
      { id: 'action-profile', type: 'run_profile', status: 'failed', attemptNumber: 1,
        workspaceRevisionBefore: revision, workspaceRevisionAfter: revision,
        error: { code: 'SANDBOX_START_FAILED' }, inputArtifact: { path: 'profile-input' } }] };
  const input = { type: 'run_profile', actionId: 'action-profile', profileId: 'tests', expectedWorkspaceRevision: revision };
  const failure = { error: { code: 'SANDBOX_START_FAILED', message: 'Windows test preparation was interrupted' } };
  const cleanup = { executionId: attemptExecutionId(job.jobId, 1), actionId: 'action-profile', profileId: 'tests',
    profileConfigDigest: 'b'.repeat(64), reason: 'preparation_interrupted_cleanup_confirmed' };
  const calls = [];
  let afterAudit = () => {}, cleanupAvailable = true;
  const reader = new SettledVerificationRecoveryReader({
    executor: { async view() { return structuredClone(session); }, async getActionResult({ actionId }) {
      calls.push(actionId); afterAudit();
      return { action: structuredClone(session.actions.find(action => action.id === actionId)),
        result: actionId === 'action-profile' ? structuredClone(failure) : { text: 'Never expose inspected code' } };
    } },
    artifacts: { async read() { return Buffer.from(JSON.stringify(input)); } },
    sandbox: { async readSettledPreparationFailure() { return cleanupAvailable ? structuredClone(cleanup) : null; } },
  });
  return { reader, job, session, input, failure, cleanup, calls,
    setAfterAudit(value) { afterAudit = value; }, setCleanupAvailable(value) { cleanupAvailable = value; } };
}

test('settled verification evidence binds audited readonly actions, original target and confirmed native cleanup', async () => {
  const f = fixture();
  const result = await f.reader.read({ jobId: f.job.jobId, job: f.job });
  assert.deepEqual(result, { schemaVersion: 1, jobId: f.job.jobId, grantDigest: f.job.grantDigest,
    inputBinding: f.job.inputBinding, actionId: f.cleanup.actionId, executionId: f.cleanup.executionId,
    profileId: 'tests', profileConfigDigest: 'b'.repeat(64), workspaceRevision: f.session.workspaceRevision,
    reason: 'preparation_interrupted_cleanup_confirmed' });
  assert.deepEqual(f.calls, ['action-read', 'action-profile']);
  assert.equal(JSON.stringify(result).includes('Never expose'), false);
});

for (const scenario of ['modify', 'job-running', 'binding', 'requester', 'session-active', 'cleanup-pending', 'missing-history',
  'write-action', 'running-action', 'profile-action', 'workspace', 'error', 'input-action', 'input-profile', 'input-workspace',
  'cleanup-unavailable', 'cleanup-action', 'cleanup-execution', 'cleanup-profile', 'cleanup-digest', 'audit-changed']) {
  test(`settled verification evidence rejects ${scenario}`, async () => {
    const f = fixture();
    if (scenario === 'modify') f.job.operation = 'modify';
    if (scenario === 'job-running') f.job.status = 'active';
    if (scenario === 'binding') f.session.inputBinding = { ...f.job.inputBinding, rootItemId: 'different-root' };
    if (scenario === 'requester') f.session.requestedBy = { ...f.job.requestedBy, workItemId: 'different-root' };
    if (scenario === 'session-active') f.session.status = 'active';
    if (scenario === 'cleanup-pending') f.session.cleanupPending = true;
    if (scenario === 'missing-history') f.session.actions.shift();
    if (scenario === 'write-action') f.session.actions[0].type = 'write_text';
    if (scenario === 'running-action') f.session.actions[0].status = 'running';
    if (scenario === 'profile-action') f.session.actions.at(-1).type = 'read_text';
    if (scenario === 'workspace') f.session.actions.at(-1).workspaceRevisionAfter = '8'.repeat(64);
    if (scenario === 'error') f.failure.error.code = 'SANDBOX_ABORTED';
    if (scenario === 'input-action') f.input.actionId = 'another-action';
    if (scenario === 'input-profile') f.input.profileId = 'another-profile';
    if (scenario === 'input-workspace') f.input.expectedWorkspaceRevision = '8'.repeat(64);
    if (scenario === 'cleanup-unavailable') f.setCleanupAvailable(false);
    if (scenario === 'cleanup-action') f.cleanup.actionId = 'another-action';
    if (scenario === 'cleanup-execution') f.cleanup.executionId = 'another-execution';
    if (scenario === 'cleanup-profile') f.cleanup.profileId = 'another-profile';
    if (scenario === 'cleanup-digest') f.cleanup.profileConfigDigest = 'invalid';
    if (scenario === 'audit-changed') f.setAfterAudit(() => { f.session.revision += 1; });
    assert.equal(await f.reader.read({ jobId: f.job.jobId, job: f.job }), null);
  });
}
