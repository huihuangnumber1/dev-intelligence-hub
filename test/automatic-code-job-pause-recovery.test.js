import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticCodeJobPauseRecovery } from '../src/services/automatic-code-job-pause-recovery.js';
import { digestValue } from '../src/domain/code-executor-contract.js';
import { incompleteReadPauseReason } from '../src/services/code-job-read-recovery.js';
import { codeProtocolRecoveryFor, codeProtocolRecoveryMessages } from '../src/services/code-job-protocol-recovery.js';

function fixture() {
  const job = { jobId: 'job-1', sequence: 1, revision: 12, status: 'paused', createdAt: '2026-10-10T03:00:00Z',
    grant: { requestedBy: { roleId: 'developer' } }, execution: { pendingAction: null, actionAdmission: null, uncertainty: null,
      pause: { from: 'active', reason: '等待人工处理（STRUCTURED_PROVIDER_RESPONSE_INVALID）', at: '2026-10-10T03:01:01Z' } } };
  const proof = { runId: 'run-1', mode: 'active', active: false, pendingCommand: null, stopUnconfirmed: false,
    receipt: { runId: 'run-1', kind: 'code-job', taskId: job.jobId, roleId: 'developer', phase: 'failed', stopConfirmed: true,
      outcomeCode: 'STRUCTURED_PROVIDER_RESPONSE_INVALID', session: { transport: 'app-server' },
      modelStartedAt: '2026-10-10T03:00:30Z', finishedAt: '2026-10-10T03:01:00Z' } };
  const calls = []; let eligible = true;
  const jobs = {
    async listPaused() { return { items: job.status === 'paused' ? [structuredClone(job)] : [] }; },
    async getForWorker() { return structuredClone(job); },
    async resume(value) {
      calls.push(value);
      if (value.expectedRevision !== job.revision || job.status !== 'paused') throw Object.assign(new Error('changed'), { code: 'CODE_JOB_REVISION_CONFLICT' });
      job.status = 'active'; job.revision++; job.execution.pause = null;
    },
  };
  const taskRuns = { async get(kind, id) { assert.equal(kind, 'code-job'); assert.equal(id, job.jobId); return structuredClone(proof); } };
  const eligibility = { async canRecover() { return eligible; } };
  return { job, proof, jobs, taskRuns, eligibility, calls, setEligible(value) { eligible = value; },
    create: () => new AutomaticCodeJobPauseRecovery({ jobs, taskRuns, eligibility }) };
}

test('settled provider format pause automatically resumes the same checkpoint once across recovery restart', async () => {
  const f = fixture();
  const result = await f.create().runCycle();
  assert.equal(result.resumed, 1);
  assert.deepEqual(f.calls, [{ jobId: 'job-1', expectedRevision: 12 }]);
  assert.equal(f.job.status, 'active');
  assert.equal((await f.create().runCycle()).scanned, 0);
});

function busyPauseFixture() {
  const f = fixture();
  f.job.execution.pause.reason = '等待人工处理（STRUCTURED_PROVIDER_BUSY）';
  Object.assign(f.proof, { kind: 'code-job', taskId: f.job.jobId, roleId: 'developer' });
  Object.assign(f.proof.receipt, { outcomeCode: 'STRUCTURED_PROVIDER_BUSY',
    registeredAt: '2026-10-10T03:00:10Z', modelStartedAt: null, session: null,
    eventCount: 0, stopConfirmed: false });
  let held = false;
  const resume = f.jobs.resume;
  f.jobs.resume = value => { assert.equal(held, true, 'native entity exclusion must cover resume'); return resume(value); };
  f.eligibility.withNativeQuiescence = async (job, operation) => {
    assert.equal(job.jobId, f.job.jobId);
    held = true;
    try { return { executed: true, result: await operation() }; }
    finally { held = false; }
  };
  return f;
}

test('an unstarted busy pause resumes under certified native entity exclusion without rewriting its receipt', async () => {
  const f = busyPauseFixture(), before = structuredClone(f.proof);
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.deepEqual(f.calls, [{ jobId: 'job-1', expectedRevision: 12 }]);
  assert.deepEqual(f.proof, before);
  assert.equal((await f.create().runCycle()).scanned, 0);
});

test('busy pause recovery forwards cancellation to native entity inspection', async () => {
  const f = busyPauseFixture();
  const controller = new AbortController();
  f.eligibility.withNativeQuiescence = async (job, operation, { signal } = {}) => {
    assert.strictEqual(signal, controller.signal);
    controller.abort(new Error('native inspection cancelled'));
    signal.throwIfAborted();
  };
  await assert.rejects(f.create().runCycle({ signal: controller.signal }), /native inspection cancelled/);
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
  ['no certified native fence', f => { delete f.eligibility.withNativeQuiescence; }],
  ['native owner remains', f => { f.eligibility.withNativeQuiescence = async () => ({ executed: false }); }],
  ['model started', f => { f.proof.receipt.modelStartedAt = '2026-10-10T03:00:30Z'; }],
  ['native session exists', f => { f.proof.receipt.session = { transport: 'app-server' }; }],
  ['native event exists', f => { f.proof.receipt.eventCount = 1; }],
  ['wrong task', f => { f.proof.receipt.taskId = 'other'; }],
  ['wrong role', f => { f.proof.roleId = 'tester'; }],
  ['other run', f => { f.proof.receipt.runId = 'other'; }],
  ['registered before job', f => { f.proof.receipt.registeredAt = '2026-10-09T03:00:00Z'; }],
  ['finished after pause', f => { f.proof.receipt.finishedAt = '2026-10-10T03:02:00Z'; }],
  ['active model', f => { f.proof.active = true; }],
  ['owner pause', f => { f.proof.mode = 'paused'; }],
  ['owner command', f => { f.proof.pendingCommand = 'pause'; }],
  ['stop uncertainty', f => { f.proof.stopUnconfirmed = true; }],
  ['pending action', f => { f.job.execution.pendingAction = {}; }],
  ['admitted action', f => { f.job.execution.actionAdmission = {}; }],
  ['unknown action', f => { f.job.execution.uncertainty = {}; }],
  ['source revoked', f => { f.setEligible(false); }],
  ['source revoked inside fence', f => { let reads = 0;
    f.eligibility.canRecover = async () => ++reads === 1; }],
  ['owner command after authority recheck', f => { let reads = 0;
    f.eligibility.canRecover = async () => { if (++reads === 2) f.proof.pendingCommand = 'pause'; return true; }; }],
  ['checkpoint changed before fence', f => { const fence = f.eligibility.withNativeQuiescence;
    f.eligibility.withNativeQuiescence = (job, operation) => { f.job.revision++; return fence(job, operation); }; }],
  ['run changed before fence', f => { const fence = f.eligibility.withNativeQuiescence;
    f.eligibility.withNativeQuiescence = (job, operation) => {
      f.proof.runId = f.proof.receipt.runId = 'later'; return fence(job, operation); }; }],
]) test(`busy pause recovery preserves ${name}`, async () => {
  const f = busyPauseFixture(); change(f);
  assert.equal((await f.create().runCycle()).resumed, 0);
  assert.equal(f.calls.length, 0);
});

function preparedReadFixture() {
  const f = fixture();
  const action = { type: 'read_text', actionId: 'pending-read', path: 'src/app.js', expectedWorkspaceRevision: 'a'.repeat(64) };
  f.job.grant.allowedActions = ['read_text'];
  Object.assign(f.job.execution, { turn: 45, workspaceRevision: action.expectedWorkspaceRevision,
    pendingAction: { turn: 46, actionId: action.actionId, actionDigest: digestValue(action), action } });
  return f;
}

test('stopped protocol failure resumes a prepared read without clearing or replaying its checkpoint', async () => {
  const f = preparedReadFixture(), pending = structuredClone(f.job.execution.pendingAction);
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.deepEqual(f.job.execution.pendingAction, pending);
  assert.equal((await f.create().runCycle()).scanned, 0);
});

for (const [name, change] of [
  ['admitted read', f => { f.job.execution.actionAdmission = {}; }],
  ['uncertain read', f => { f.job.execution.uncertainty = {}; }],
  ['wrong digest', f => { f.job.execution.pendingAction.actionDigest = 'b'.repeat(64); }],
  ['wrong turn', f => { f.job.execution.pendingAction.turn++; }],
  ['wrong workspace', f => { f.job.execution.workspaceRevision = 'b'.repeat(64); }],
  ['action not allowed', f => { f.job.grant.allowedActions = []; }],
  ['missing stop', f => { f.proof.receipt.stopConfirmed = false; }],
  ['owner hold', f => { f.proof.pendingCommand = 'pause'; }],
  ['pending write', f => { f.job.execution.pendingAction.action.type = 'write_text'; }],
]) test(`protocol read recovery preserves ${name}`, async () => {
  const f = preparedReadFixture(); change(f);
  assert.equal((await f.create().runCycle()).resumed, 0);
  assert.equal(f.calls.length, 0);
});

function queuedPauseFixture() {
  const f = fixture();
  f.job.execution.pause.reason = '等待人工处理（STRUCTURED_PROVIDER_QUEUE_TIMEOUT）';
  Object.assign(f.proof, { kind: 'code-job', taskId: f.job.jobId, roleId: 'developer' });
  Object.assign(f.proof.receipt, { outcomeCode: 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT',
    registeredAt: '2026-10-10T03:00:10Z', modelStartedAt: null, session: null, eventCount: 0 });
  return f;
}

test('automatic queue timeout recovery resumes the existing job without inventing a model session', async () => {
  const f = queuedPauseFixture(), before = structuredClone(f.proof);
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.deepEqual(f.calls, [{ jobId: 'job-1', expectedRevision: 12 }]);
  assert.deepEqual(f.proof, before);
  assert.equal((await f.create().runCycle()).scanned, 0);
});

for (const [name, change] of [
  ['model started', f => { f.proof.receipt.modelStartedAt = '2026-10-10T03:00:30Z'; }],
  ['native session exists', f => { f.proof.receipt.session = { transport: 'app-server' }; }],
  ['native event exists', f => { f.proof.receipt.eventCount = 1; }],
  ['missing stop proof', f => { f.proof.receipt.stopConfirmed = false; }],
  ['other run', f => { f.proof.receipt.runId = 'other'; }],
  ['other task', f => { f.proof.taskId = 'other'; }],
  ['other role', f => { f.proof.roleId = 'tester'; }],
  ['registered before job', f => { f.proof.receipt.registeredAt = '2026-10-09T03:00:00Z'; }],
  ['finished after pause', f => { f.proof.receipt.finishedAt = '2026-10-10T03:02:00Z'; }],
  ['owner pause', f => { f.proof.mode = 'paused'; }],
  ['owner command', f => { f.proof.pendingCommand = 'pause'; }],
  ['pending action', f => { f.job.execution.pendingAction = {}; }],
  ['unknown action', f => { f.job.execution.uncertainty = {}; }],
  ['source revoked', f => { f.setEligible(false); }],
]) test(`queue timeout recovery preserves ${name}`, async () => {
  const f = queuedPauseFixture(); change(f);
  assert.equal((await f.create().runCycle()).resumed, 0);
  assert.equal(f.calls.length, 0);
});

test('a stopped native turn with an incomplete final decision resumes only its exact automatic checkpoint', async () => {
  const f = fixture();
  f.job.execution.pause.reason = '等待人工处理（CODE_BRAIN_COMPLETION_NOT_READY）';
  f.proof.receipt.outcomeCode = 'CODE_BRAIN_COMPLETION_NOT_READY';
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.create().runCycle()).resumed, 0);
});

test('incomplete source-page reading resumes automatically with fresh paging guidance after positive native stop', async () => {
  const f = fixture(), code = 'CODE_ARTIFACT_READ_INCOMPLETE';
  f.job.execution.pause.reason = `等待人工处理（${code}）`;
  f.proof.receipt.outcomeCode = code;
  Object.assign(f.proof, { kind: 'code-job', taskId: f.job.jobId, roleId: 'developer' });
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.equal(codeProtocolRecoveryFor(f.job, f.proof), code);
  assert.match(codeProtocolRecoveryMessages(code)[0].content, /read_source.*full audited source pages/);
  assert.match(codeProtocolRecoveryMessages(code)[0].content, /fullyRead=false/);
  assert.match(codeProtocolRecoveryMessages(code)[0].content, /read_text.*previews/);
  assert.match(codeProtocolRecoveryMessages(code)[0].content, /same invocation/);
  assert.equal((await f.create().runCycle()).resumed, 0);
});

test('incomplete source-page recovery retains user holds, pending actions and unknown executions', async t => {
  for (const [name, change] of [
    ['owner pause', f => { f.job.execution.pause.reason = '用户暂停'; }],
    ['manual mode', f => { f.setEligible(false); }],
    ['live model', f => { f.proof.active = true; }],
    ['unconfirmed stop', f => { f.proof.receipt.stopConfirmed = false; }],
    ['pending instruction', f => { f.proof.pendingCommand = 'pause'; }],
    ['pending action', f => { f.job.execution.pendingAction = {}; }],
    ['admitted action', f => { f.job.execution.actionAdmission = {}; }],
    ['unknown action', f => { f.job.execution.uncertainty = {}; }],
    ['other failure', f => { f.proof.receipt.outcomeCode = 'CODE_ARTIFACT_READ_INVALID'; }],
  ]) await t.test(name, async () => {
    const f = fixture();
    f.job.execution.pause.reason = '等待人工处理（CODE_ARTIFACT_READ_INCOMPLETE）';
    f.proof.receipt.outcomeCode = 'CODE_ARTIFACT_READ_INCOMPLETE';
    change(f);
    assert.equal((await f.create().runCycle()).resumed, 0);
    assert.equal(f.calls.length, 0);
  });
});

test('native completion recovery rejects mismatched failures, running actions and user holds', async t => {
  for (const change of [
    f => { f.proof.receipt.outcomeCode = 'STRUCTURED_PROVIDER_RESPONSE_INVALID'; },
    f => { f.proof.receipt.stopConfirmed = false; },
    f => { f.proof.active = true; },
    f => { f.proof.pendingCommand = 'pause'; },
    f => { f.job.execution.actionAdmission = {}; },
    f => { f.job.execution.pendingAction = {}; },
    f => { f.job.execution.uncertainty = {}; },
    f => { f.job.execution.pause.reason = '用户暂停'; },
  ]) await t.test(change.toString(), async () => {
    const f = fixture();
    f.job.execution.pause.reason = '等待人工处理（CODE_BRAIN_COMPLETION_NOT_READY）';
    f.proof.receipt.outcomeCode = 'CODE_BRAIN_COMPLETION_NOT_READY';
    change(f);
    assert.equal((await f.create().runCycle()).resumed, 0);
    assert.equal(f.calls.length, 0);
  });
});

function readPauseFixture() {
  const f = fixture();
  const action = { type: 'write_text', actionId: 'write-old', path: 'src/app.js', content: 'old candidate',
    expectedWorkspaceRevision: 'a'.repeat(64), expectedSha256: 'b'.repeat(64) };
  f.job.grant.operation = 'modify';
  Object.assign(f.job.execution, { turn: 4, workspaceRevision: action.expectedWorkspaceRevision,
    pendingAction: { turn: 5, actionId: action.actionId, actionDigest: digestValue(action), action } });
  f.job.execution.pause.reason = incompleteReadPauseReason(action.path);
  f.proof.receipt.registeredAt = '2026-10-10T03:00:20Z';
  f.proof.receipt.outcomeCode = 'STRUCTURED_PROVIDER_CANCELLED';
  f.eligibility.canRecover = async () => { assert.fail('a host read pause cannot use provider-format recovery'); };
  f.eligibility.canReplanUnstartedWrite = async () => true;
  return f;
}

test('a host incomplete-read pause resumes from an older stopped run without inventing a new Native failure', async () => {
  const f = readPauseFixture(), previous = structuredClone(f.proof);
  assert.equal((await f.create().runCycle()).resumed, 1);
  assert.equal(f.job.status, 'active');
  assert.equal(f.job.execution.pendingAction.actionId, 'write-old', 'resume alone does not approve or replay the old write');
  assert.deepEqual(f.proof, previous);
  assert.equal((await f.create().runCycle()).scanned, 0);
});

test('host incomplete-read recovery preserves manual holds, exact pending identity, source policy and unknown owners', async (t) => {
  for (const [name, change] of [
    ['owner reason', f => { f.job.execution.pause.reason = '用户暂停'; }],
    ['different file reason', f => { f.job.execution.pause.reason = incompleteReadPauseReason('src/other.js'); }],
    ['admitted action', f => { f.job.execution.actionAdmission = {}; }],
    ['unknown write', f => { f.job.execution.uncertainty = {}; }],
    ['tampered candidate', f => { f.job.execution.pendingAction.action.content = 'changed'; }],
    ['different workspace', f => { f.job.execution.workspaceRevision = 'd'.repeat(64); }],
    ['active model', f => { f.proof.active = true; }],
    ['owner command', f => { f.proof.pendingCommand = 'pause'; }],
    ['missing stop', f => { f.proof.receipt.stopConfirmed = false; }],
    ['later model', f => { f.proof.receipt.finishedAt = '2026-10-10T03:01:02Z'; }],
    ['source not authorized', f => { f.eligibility.canReplanUnstartedWrite = async () => false; }],
    ['source reader absent', f => { delete f.eligibility.canReplanUnstartedWrite; }],
    ['new run during policy read', f => { f.eligibility.canReplanUnstartedWrite = async () => {
      f.proof.runId = f.proof.receipt.runId = 'new-run'; return true;
    }; }],
  ]) await t.test(name, async () => {
    const f = readPauseFixture(); change(f);
    assert.equal((await f.create().runCycle()).resumed, 0);
    assert.equal(f.calls.length, 0);
  });
});

for (const [name, change] of [
  ['owner job pause', f => { f.job.execution.pause.reason = '用户从本地指挥中枢暂停代码任务'; }],
  ['owner task pause', f => { f.proof.mode = 'paused'; }],
  ['pending owner command', f => { f.proof.pendingCommand = 'pause'; }],
  ['active process', f => { f.proof.active = true; }],
  ['unconfirmed stop', f => { f.proof.stopUnconfirmed = true; }],
  ['missing stop certificate', f => { f.proof.receipt.stopConfirmed = false; }],
  ['unrelated run', f => { f.proof.receipt.runId = 'other-run'; }],
  ['unrelated task', f => { f.proof.receipt.taskId = 'other-job'; }],
  ['wrong role', f => { f.proof.receipt.roleId = 'tester'; }],
  ['other failure', f => { f.proof.receipt.outcomeCode = 'STRUCTURED_PROVIDER_TIMEOUT'; }],
  ['pending action', f => { f.job.execution.pendingAction = { action: { type: 'write_text' } }; }],
  ['admitted action', f => { f.job.execution.actionAdmission = { actionId: 'admitted' }; }],
  ['unknown result', f => { f.job.execution.uncertainty = { kind: 'unknown' }; }],
  ['late receipt', f => { f.proof.receipt.finishedAt = '2026-10-10T03:02:00Z'; }],
  ['pre-job receipt', f => { f.proof.receipt.modelStartedAt = '2026-10-09T03:00:00Z'; }],
  ['invalid eligibility', f => { f.setEligible(false); }],
]) test(`automatic recovery preserves ${name}`, async () => {
  const f = fixture(); change(f);
  assert.equal((await f.create().runCycle()).resumed, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.job.status, 'paused');
});

test('an owner pause or new run while eligibility is checked prevents recovery', async () => {
  for (const change of [f => { f.proof.mode = 'paused'; }, f => { f.proof.receipt.runId = f.proof.runId = 'new-run'; }]) {
    const f = fixture(); f.eligibility.canRecover = async () => { change(f); return true; };
    assert.equal((await f.create().runCycle()).resumed, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('job revision CAS preserves concurrent owner changes', async () => {
  const f = fixture(); f.eligibility.canRecover = async () => { f.job.revision++; f.job.execution.pause.reason = 'owner pause'; return true; };
  const result = await f.create().runCycle();
  assert.equal(result.failed, 1);
  assert.equal(result.outcomes[0].code, 'CODE_JOB_REVISION_CONFLICT');
  assert.equal(f.job.status, 'paused');
});
