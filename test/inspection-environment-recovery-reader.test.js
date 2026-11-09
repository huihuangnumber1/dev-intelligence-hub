import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InspectionEnvironmentRecoveryReader } from '../src/adapters/inspection-environment-recovery-reader.js';
import { DockerSandboxError } from '../src/adapters/docker-test-sandbox.js';
import { digestValue } from '../src/domain/code-executor-contract.js';
import { StateStore } from '../src/lib/state-store.js';
import { CodeExecutionJournal } from '../src/services/code-execution-journal.js';
import { ControlledCodeExecutor } from '../src/services/controlled-code-executor.js';
import { CodeWorkspaceBroker } from '../src/services/code-workspace-broker.js';
import { INSPECTION_ENVIRONMENT_PROOF_REASON } from '../src/domain/inspection-environment-recovery-evidence.js';
import { readonlyVerificationFixture } from './support/readonly-verification-fixture.js';
import { pullRequestExternalActionBinding } from './support/pull-request-external-action-fixture.js';

function fixture() {
  const { job } = readonlyVerificationFixture({ binding: pullRequestExternalActionBinding() });
  Object.assign(job, { operation: 'inspect', turn: 1, observationCount: 1 });
  delete job.verificationOutcome;
  const revision = '7'.repeat(64);
  const action = { id: 'action-profile', type: 'run_profile', status: 'failed', attemptNumber: 1,
    workspaceRevisionBefore: revision, workspaceRevisionAfter: revision,
    error: { code: 'SANDBOX_UNAVAILABLE', message: 'Docker sandbox is unavailable' },
    inputArtifact: { sha256: 'a'.repeat(64), bytes: 100 } };
  const session = { id: job.jobId, status: 'active', cleanupPending: false, revision: 4,
    workspaceId: job.workspaceId, workspaceRevision: revision, requestedBy: job.requestedBy,
    inputBinding: job.inputBinding, attempt: { number: 1, status: 'active' }, requiredProfiles: ['tests'], actions: [action] };
  const input = { type: 'run_profile', actionId: action.id, profileId: 'tests', expectedWorkspaceRevision: revision };
  const ready = { schemaVersion: 1, profileId: 'tests', profileConfigDigest: 'b'.repeat(64), imageId: `sha256:${'c'.repeat(64)}` };
  const calls = [];
  let unavailable = false, afterProbe = () => {};
  const reader = new InspectionEnvironmentRecoveryReader({
    executor: { async view() { return structuredClone(session); }, async getActionResult(request) {
      calls.push(['audit', request]); return { action: structuredClone(action), result: { error: structuredClone(action.error) } };
    } },
    artifacts: { async read(request) { calls.push(['input', request]); return Buffer.from(JSON.stringify(input)); } },
    sandbox: { async readProfileReadiness(request) {
      calls.push(['probe', request]); afterProbe(); if (unavailable) throw new Error('still unavailable'); return structuredClone(ready);
    } },
  });
  return { reader, job, session, action, input, ready, calls,
    setUnavailable() { unavailable = true; }, setAfterProbe(fn) { afterProbe = fn; } };
}

test('a trusted first-action Docker failure plus fresh exact-profile readiness proves effective change without replay', async () => {
  const f = fixture(), before = structuredClone({ job: f.job, session: f.session });
  const proof = await f.reader.read({ jobId: f.job.jobId, job: f.job });
  assert.equal(proof.reason, INSPECTION_ENVIRONMENT_PROOF_REASON);
  assert.equal(proof.actionId, f.action.id);
  assert.equal(proof.profileId, 'tests');
  assert.equal(proof.profileConfigDigest, f.ready.profileConfigDigest);
  assert.equal(proof.imageId, f.ready.imageId);
  assert.deepEqual(f.calls.map(call => call[0]), ['audit', 'input', 'probe']);
  assert.deepEqual(f.calls.at(-1)[1], { profileId: 'tests' });
  assert.deepEqual({ job: f.job, session: f.session }, before);
});

for (const [scenario, change] of [
  ['still-unavailable', f => f.setUnavailable()],
  ['missing-image', f => { f.ready.imageId = null; }],
  ['different-audited-input', f => { f.input.actionId = 'another-action'; }],
  ['unrequired-profile', f => { f.input.profileId = 'other-profile'; }],
  ['different-probed-profile', f => { f.ready.profileId = 'other-profile'; }],
  ['another-prior-action', f => { f.session.actions.unshift({ type: 'read_text', status: 'succeeded' }); }],
  ['cleanup-pending', f => { f.session.cleanupPending = true; }],
  ['cancelled-session', f => { f.session.status = 'cancelled'; }],
  ['paused-session', f => { f.session.status = 'paused'; }],
  ['unknown-session', f => { f.session.status = 'unknown'; }],
  ['other-sandbox-error', f => { f.action.error.message = 'Windows is unavailable'; }],
  ['session-race', f => f.setAfterProbe(() => { f.session.revision += 1; })],
]) test(`inspection environment proof rejects ${scenario}`, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.reader.read({ jobId: f.job.jobId, job: f.job }), null);
});

test('actual executor restart retains audited Docker prestart evidence without resuming its interrupted session', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'inspection-environment-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, 'app.js'), 'export const value = 1;\n');
  const { job } = fixture();
  const profile = { kind: 'node-test', timeoutMs: 30_000,
    image: `node:22-alpine@sha256:${'c'.repeat(64)}` };
  const store = new StateStore(path.join(root, 'state'));
  const journal = new CodeExecutionJournal({ root: path.join(root, 'artifacts') });
  let runs = 0, snapshots = 0, probes = 0;
  const sandbox = {
    getProfileFingerprint: () => digestValue(profile),
    async run() { runs += 1; throw new DockerSandboxError('SANDBOX_UNAVAILABLE', 'Docker sandbox is unavailable'); },
    async cleanup() { assert.fail('a prestart failure has no container to clean up'); },
    async readProfileReadiness({ profileId }) {
      probes += 1;
      return { schemaVersion: 1, profileId, profileConfigDigest: digestValue(profile), imageId: `sha256:${'c'.repeat(64)}` };
    },
  };
  const createExecutor = () => {
    const directoryBroker = new CodeWorkspaceBroker({ scratchRoot: path.join(root, 'scratch'),
      workspaces: [{ id: job.workspaceId, sourceRoot, writablePaths: ['app.js'] }] });
    const broker = new Proxy(directoryBroker, { get(target, property) {
      if (property === 'createExecution') return async request => {
        snapshots += 1;
        return { ...await target.createExecution({ ...request, inputBinding: null }), inputBinding: request.inputBinding };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new ControlledCodeExecutor({ broker, sandbox, store, journal,
      profileDefinitions: { tests: profile }, requiredProfilesByWorkspace: { [job.workspaceId]: ['tests'] } });
  };
  const original = createExecutor();
  await original.recover();
  const session = await original.start({ sessionId: job.jobId, workspaceId: job.workspaceId,
    requestedBy: job.requestedBy, inputBinding: job.inputBinding });
  const failed = await original.perform({ sessionId: job.jobId, action: {
    type: 'run_profile', actionId: 'action-profile', expectedWorkspaceRevision: session.workspaceRevision, profileId: 'tests' } });
  assert.equal(failed.session.status, 'active');
  assert.equal(failed.action.status, 'failed');
  const auditedBefore = await original.getActionResult({ sessionId: job.jobId, actionId: 'action-profile' });

  const restarted = createExecutor();
  assert.deepEqual(await restarted.recover(), { recovered: true, cleanupPending: 0 });
  const interrupted = await restarted.view({ sessionId: job.jobId });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.attempt.status, 'interrupted');
  const stateBeforeRead = await store.read('code-executor-state');
  const reader = new InspectionEnvironmentRecoveryReader({ executor: restarted,
    artifacts: { read: journal.readBytes.bind(journal) }, sandbox });
  const proof = await reader.read({ jobId: job.jobId, job });
  assert.equal(proof?.reason, INSPECTION_ENVIRONMENT_PROOF_REASON);
  assert.equal(proof.workspaceRevision, session.workspaceRevision);
  assert.deepEqual(await restarted.getActionResult({ sessionId: job.jobId, actionId: 'action-profile' }), auditedBefore);
  assert.deepEqual(await store.read('code-executor-state'), stateBeforeRead, 'reading proof cannot resume or rewrite the session');
  assert.equal(runs, 1);
  assert.equal(snapshots, 1);
  assert.equal(probes, 1);
});
