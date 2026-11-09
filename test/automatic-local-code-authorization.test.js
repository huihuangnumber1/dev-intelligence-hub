import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticLocalCodeAuthorization } from '../src/services/automatic-local-code-authorization.js';
import { digestValue } from '../src/domain/code-executor-contract.js';
import { CODE_JOB_ACTIONS_BY_OPERATION } from '../src/domain/code-job-contract.js';

function fixture(role = 'developer', operation = 'modify') {
  const binding = { schemaVersion: 2, kind: 'pull_request', repository: 'acme/repo', pullRequestNumber: 42,
    rootItemId: 'root', workKey: 'pr-work-42', inputRevision: 1, headRevision: 1,
    headRefOid: '1'.repeat(40), eventId: 'event', eventDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
    gitTarget: { schemaVersion: 1, provider: 'github', sourceAccountId: 'me', baseRepository: 'acme/repo',
      baseRefName: 'main', baseRefOid: '2'.repeat(40), headRepository: 'acme/repo', headRefName: 'fix', headRefOid: '1'.repeat(40) } };
  const grant = { inputBinding: binding, operation, allowedActions: ['read_text', 'complete'], requiredProfiles: ['fixed'] };
  const item = { id: 'confirmation-42', kind: 'local.code-job-create', status: 'pending', queueRevision: 3, itemRevision: 1,
    approvalBindingDigest: 'a'.repeat(64), displayedPayloadDigest: 'b'.repeat(64), requestedBy: { roleId: role, workItemId: 'root' },
    display: { payload: { action: { grant } } } };
  const config = { githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: 'me' }, trackedRepositories: ['acme/repo'] };
  const root = { status: 'waiting_external', currentTarget: { type: 'role', id: role }, source: { scope: { active: true } },
    event: { eventType: 'pull_request.status', payload: { relation: 'authored', nextAction: 'wait_review' } } };
  const facts = { state: 'open', isDraft: false, author: 'me', headRefOid: binding.headRefOid, baseRefOid: binding.gitTarget.baseRefOid };
  const roleState = { enabled: true, paused: false };
  const calls = [];
  const ports = { specialized: { async approveCodeJob(value) { return value; } },
    configurationReader: { async readActive() { return { configuration: config }; } },
    ledger: { async readPullRequestExecutionContext() { return { inputBinding: binding, author: facts.author }; },
      async readItemForReconciliation() { return root; } },
    github: { async readPullRequestLocalWorkFacts() { return facts; } },
    confirmations: { async approve(id, request) { calls.push({ id, request }); return { ...item, status: 'completed' }; },
      async invalidate(id, request) { assert.equal(id, item.id); assert.equal(request.reason, 'authorization_changed');
        assert.deepEqual(request.requestedBy, item.requestedBy); assert.equal(request.approvalBindingDigest, item.approvalBindingDigest);
        return { ...item, status: 'stale' }; } },
    grantVerifier: { async verify(value) { return value; } }, objectSync: { async prepare() {} },
    roleStateReader: { async read() { return roleState; } } };
  return { config, root, facts, roleState, ports, item, grant, calls, service: new AutomaticLocalCodeAuthorization(ports) };
}

function readRecoveryFixture(sourceKind = null) {
  const f = fixture(), workControls = new Map();
  const grant = { ...f.grant, requestedBy: f.item.requestedBy };
  if (sourceKind) grant.executionSource = { kind: sourceKind, inputBinding: grant.inputBinding };
  const action = { type: 'write_text', path: 'src/app.js', content: 'old', actionId: 'write-old',
    expectedWorkspaceRevision: 'a'.repeat(64), expectedSha256: 'b'.repeat(64) };
  const job = { jobId: 'job-write', status: 'active', createdAt: '2026-10-10T03:00:00Z', grant,
    execution: { turn: 1, workspaceRevision: action.expectedWorkspaceRevision, actionAdmission: null, uncertainty: null,
      pendingAction: { turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action } } };
  const proof = { runId: 'old-run', mode: 'active', active: false, pendingCommand: null, stopUnconfirmed: false,
    receipt: { runId: 'old-run', kind: 'code-job', taskId: job.jobId, roleId: 'developer', phase: 'failed', stopConfirmed: true,
      registeredAt: '2026-10-10T03:00:10Z', modelStartedAt: '2026-10-10T03:00:20Z', finishedAt: '2026-10-10T03:00:30Z' } };
  let specialized = true, sourceCalls = 0;
  f.ports.specialized.canReplanUnstartedWrite = async value => { sourceCalls += 1; assert.equal(value, job); return specialized; };
  const service = new AutomaticLocalCodeAuthorization({ ...f.ports, clock: () => new Date('2026-10-10T03:01:00Z'),
    taskRuns: { async get(kind, id) { if (kind === 'code-job') return structuredClone(proof);
      if (workControls.has(id)) return workControls.get(id);
      throw Object.assign(new Error('no hold'), { code: 'TASK_RUN_NOT_FOUND' }); } } });
  return { ...f, service, job, proof, workControls, sourceCalls: () => sourceCalls,
    setSourceEligible: value => { specialized = value; } };
}

test('native repair protocol recovery uses dedicated CI and Review authority without publishing', async () => {
  for (const kind of ['ci_repair', 'review_repair']) {
    const f = readRecoveryFixture(kind);
    f.job.status = 'paused';
    f.job.execution.pendingAction = null;
    f.job.execution.pause = { from: 'active', reason: '等待人工处理（CODE_BRAIN_COMPLETION_NOT_READY）', at: '2026-10-10T03:01:00Z' };
    f.ports.specialized.canRecoverPausedCodeJob = value => f.ports.specialized.canReplanUnstartedWrite(value);
    assert.equal(await f.service.canRecoverPausedCodeJob(f.job), true);
    assert.equal(f.sourceCalls(), 1);
    assert.equal(f.calls.length, 0);
  }
});

test('conflict protocol recovery uses its dedicated source with a prepared unadmitted read', async () => {
  const f = readRecoveryFixture('conflict_preparation');
  const action = { type: 'read_text', actionId: 'pending-read', path: 'src/app.js', expectedWorkspaceRevision: f.job.execution.workspaceRevision };
  f.job.status = 'paused';
  f.job.execution.pendingAction = { turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action };
  f.job.execution.pause = { from: 'active', reason: '等待人工处理（STRUCTURED_PROVIDER_RESPONSE_INVALID）', at: '2026-10-10T03:01:00Z' };
  f.ports.specialized.canRecoverPausedCodeJob = value => f.ports.specialized.canReplanUnstartedWrite(value);
  assert.equal(await f.service.canRecoverPausedCodeJob(f.job), true);
  f.setSourceEligible(false);
  assert.equal(await f.service.canRecoverPausedCodeJob(f.job), false);
  assert.equal(f.calls.length, 0);
});

test('conflict queue recovery still requires the exact dedicated source and current work controls', async () => {
  const f = readRecoveryFixture('conflict_preparation');
  f.job.status = 'paused'; f.job.execution.pendingAction = null;
  f.job.execution.pause = { from: 'active', reason: '等待人工处理（STRUCTURED_PROVIDER_QUEUE_TIMEOUT）', at: '2026-10-10T03:01:00Z' };
  f.ports.specialized.canRecoverPausedCodeJob = value => f.ports.specialized.canReplanUnstartedWrite(value);
  assert.equal(await f.service.canRecoverPausedCodeJob(f.job), true);
  assert.equal(f.sourceCalls(), 1);
  assert.equal(f.calls.length, 0);
  f.setSourceEligible(false);
  assert.equal(await f.service.canRecoverPausedCodeJob(f.job), false);
  f.setSourceEligible(true);
  f.workControls.set('root', { mode: 'paused', pendingCommand: null, stopUnconfirmed: false });
  assert.equal(await f.service.canRecoverPausedCodeJob(f.job), false);
});

test('native CI recovery preserves source authority, owner holds and admitted operations', async t => {
  for (const [name, change] of [
    ['disabled', f => { f.config.githubActions.automaticOwnPrRepair = false; }],
    ['role paused', f => { f.roleState.paused = true; }],
    ['task paused', f => { f.root.status = 'paused'; }],
    ['scope left', f => { f.root.source.scope.active = false; }],
    ['source not current', f => { f.setSourceEligible(false); }],
    ['source reader missing', f => { delete f.ports.specialized.canRecoverPausedCodeJob; }],
    ['owner command', f => { f.workControls.set('root', { mode: 'active', pendingCommand: 'pause', stopUnconfirmed: false }); }],
    ['owner task paused', f => { f.workControls.set('root', { mode: 'paused', pendingCommand: null, stopUnconfirmed: false }); }],
    ['admitted action', f => { f.job.execution.actionAdmission = {}; }],
    ['pending action', f => { f.job.execution.pendingAction = {}; }],
    ['unknown outcome', f => { f.job.execution.uncertainty = {}; }],
    ['manual job pause', f => { f.job.execution.pause.reason = '用户暂停'; }],
  ]) await t.test(name, async () => {
    const f = readRecoveryFixture('ci_repair');
    f.job.status = 'paused'; f.job.execution.pendingAction = null;
    f.job.execution.pause = { from: 'active', reason: '等待人工处理（CODE_BRAIN_COMPLETION_NOT_READY）', at: '2026-10-10T03:01:00Z' };
    f.ports.specialized.canRecoverPausedCodeJob = value => f.ports.specialized.canReplanUnstartedWrite(value);
    change(f);
    assert.equal(await f.service.canRecoverPausedCodeJob(f.job), false);
    assert.equal(f.calls.length, 0);
  });
});

test('unstarted overwrite recovery keeps generic authorization and dedicated repair provenance separate', async () => {
  const generic = readRecoveryFixture();
  assert.equal(await generic.service.canReplanUnstartedWrite(generic.job), true);
  assert.equal(generic.sourceCalls(), 0);
  for (const source of ['conflict_preparation', 'review_repair', 'ci_repair']) {
    const f = readRecoveryFixture(source);
    f.root.status = 'blocked';
    assert.equal(await f.service.canReplanUnstartedWrite(f.job), true, 'a legacy source task may be blocked while its exact repair remains authorized');
    assert.equal(await f.service.canRecoverPausedCodeJob(f.job), false, 'generic recovery must still exclude source-bearing jobs');
    f.setSourceEligible(false);
    assert.equal(await f.service.canReplanUnstartedWrite(f.job), false);
  }
});

test('automatic overwrite replanning preserves owner holds, model ownership and current source scope', async (t) => {
  for (const source of [null, 'conflict_preparation']) for (const [name, change] of [
    ['manual mode', f => { f.config.githubActions.automaticOwnPrRepair = false; }],
    ['role pause', f => { f.roleState.paused = true; }],
    ['task pause', f => { f.root.status = 'paused'; }],
    ['task completed', f => { f.root.status = 'completed'; }],
    ['scope revoked', f => { f.root.source.scope.active = false; }],
    ['role changed', f => { f.root.currentTarget.id = 'tester'; }],
    ['active Native', f => { f.proof.active = true; }],
    ['unknown stop', f => { f.proof.receipt.stopConfirmed = false; }],
    ['owner job command', f => { f.proof.pendingCommand = 'pause'; }],
    ['owner work hold', f => { f.workControls.set('root', { mode: 'paused', pendingCommand: null, stopUnconfirmed: false }); }],
    ['owner work command', f => { f.workControls.set('root', { mode: 'active', pendingCommand: 'cancel', stopUnconfirmed: true }); }],
  ]) await t.test(`${source ?? 'generic'}: ${name}`, async () => {
    const f = readRecoveryFixture(source); change(f);
    assert.equal(await f.service.canReplanUnstartedWrite(f.job), false);
    assert.equal(f.calls.length, 0, 'eligibility cannot publish or approve');
  });
});

test('source replanning distinguishes obsolete technical blockers from explicit root and child rejection', async (t) => {
  for (const target of ['root', 'child']) for (const reason of ['proposal_stale', 'attention_rejected', 'proposal_rejected']) {
    await t.test(`${target}: ${reason}`, async () => {
      const f = readRecoveryFixture('conflict_preparation');
      const child = structuredClone(f.root);
      f.job.grant.requestedBy = { roleId: 'developer', workItemId: 'child' };
      f.ports.ledger.readItemForReconciliation = async ({ itemId }) => itemId === 'root' ? f.root : child;
      const changed = target === 'root' ? f.root : child;
      changed.status = 'blocked'; changed.statusReason = reason;
      assert.equal(await f.service.canReplanUnstartedWrite(f.job), reason === 'proposal_stale');
      assert.equal(f.calls.length, 0);
    });
  }
});

for (const [role, operation] of [['developer', 'modify'], ['developer', 'inspect'], ['developer', 'verify'], ['tester', 'inspect'], ['tester', 'verify']]) {
  test(`automatic own-PR routine ${role} ${operation} uses the existing grant without user confirmation`, async () => {
    const f = fixture(role, operation);
    assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].request.requestId, /^auto-own-pr-repair-v1-/);
    assert.equal(Object.hasOwn(f.grant, 'executionSource'), false, 'local authorization never fabricates publication provenance');
  });
  test(`paused routine ${role} ${operation} rechecks the existing automatic local authority`, async () => {
    const f = fixture(role, operation);
    const job = { grant: { ...f.grant, requestedBy: f.item.requestedBy } };
    assert.equal(await f.service.canRecoverPausedCodeJob(job), true);
    assert.equal(f.calls.length, 0, 'recovery eligibility neither approves nor creates a task');
    f.config.githubActions.automaticOwnPrRepair = false;
    assert.equal(await f.service.canRecoverPausedCodeJob(job), false);
  });
}

for (const [name, mutate] of [
  ['disabled automation', f => { f.config.githubActions.automaticOwnPrRepair = false; }],
  ['external author', f => { f.facts.author = 'other'; }],
  ['changed Head', f => { f.facts.headRefOid = '9'.repeat(40); }],
  ['changed Base', f => { f.facts.baseRefOid = '9'.repeat(40); }],
  ['closed PR', f => { f.facts.state = 'closed'; }],
  ['paused task', f => { f.root.status = 'paused'; }],
  ['paused role', f => { f.roleState.paused = true; }],
  ['revoked scope', f => { f.root.source.scope.active = false; }],
  ['changed role', f => { f.root.currentTarget.id = 'orchestrator'; }],
  ['revoked grant', f => { f.ports.grantVerifier.verify = async () => { throw Object.assign(new Error('revoked'), { code: 'INVALID_CODE_JOB_AUTHORITY' }); }; }],
]) {
  test(`automatic local authorization preserves ${name}`, async () => {
    const f = fixture(); mutate(f);
    assert.equal((await f.service.approveCodeJob(f.item)).status, ['changed Head', 'changed Base', 'closed PR'].includes(name) ? 'stale' : 'pending');
    assert.equal(f.calls.length, 0);
    assert.equal(await f.service.canRecoverPausedCodeJob({ grant: { ...f.grant, requestedBy: f.item.requestedBy } }), false);
  });
}

test('automatic local work accepts an authored Draft and trusted owner intake without a legacy relation tag', async () => {
  for (const operation of ['inspect', 'modify', 'verify']) {
    const f = fixture('developer', operation);
    f.root.event = { eventType: 'pull_request.owner_requested', payload: { workType: 'general' } };
    f.facts.isDraft = true;
    assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
    assert.equal(f.calls.length, 1);
  }
});

test('an existing trusted owner-requested local task does not ask again based on PR authorship', async () => {
  const f = fixture('tester', 'verify');
  f.facts.author = 'other';
  f.root.source.scope.kind = 'owner_requested';
  f.root.source.identity = { provider: 'local-owner' };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('tester cannot modify; stale and rejected authorizations cannot be revived', async () => {
  const f = fixture('tester', 'modify');
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
  for (const status of ['stale', 'rejected', 'failed']) {
    f.item.status = status;
    assert.equal((await f.service.approveCodeJob(f.item)).status, status);
  }
  assert.equal(f.calls.length, 0);
});

test('legacy owner-requested work with no author uses observed PR identity and retires an obsolete Base', async () => {
  const f = fixture('tester', 'verify');
  f.root.source.scope.kind = 'owner_requested';
  f.root.source.identity = { provider: 'local-owner' };
  f.ports.ledger.readPullRequestExecutionContext = async () => ({ inputBinding: f.grant.inputBinding, author: null });
  f.facts.author = 'contributor';
  const observed = f.ports.github.readPullRequestLocalWorkFacts;
  f.ports.github.readPullRequestLocalWorkFacts = async request => {
    assert.equal(request.authorAccountId, null);
    return observed(request);
  };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
  f.calls.length = 0;
  f.facts.baseRefOid = '9'.repeat(40);
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'stale');
  assert.equal(f.calls.length, 0);
  f.root.source.scope.kind = 'automatic';
  f.ports.github.readPullRequestLocalWorkFacts = async () => assert.fail('untrusted authorless intake cannot read for authorization');
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
});

function internalReviewFixture(operation = 'inspect') {
  const f = fixture('developer', operation), binding = f.grant.inputBinding;
  f.grant.writablePaths = [];
  f.grant.allowedActions = [...CODE_JOB_ACTIONS_BY_OPERATION[operation]];
  const event = { eventType: 'pull_request.internal_review_requested', source: { provider: 'internal-review-repair' },
    payload: { internalReview: { kind: 'own_pr_ci_repair', headRefOid: binding.headRefOid,
      feedbackDigest: 'c'.repeat(64), publicationConfirmationId: 'published-repair', controlledCommitEvidenceId: 'sealed-repair' } } };
  f.root.kind = 'source_root';
  Object.assign(f.root.source, { kind: 'pull_request', scope: { kind: 'internal_review', active: true },
    identity: { provider: 'internal-review-repair' }, current: { event } });
  f.ports.ledger.readPullRequestExecutionContext = async () => ({ inputBinding: binding, author: null });
  return f;
}

for (const operation of ['inspect', 'verify']) {
  test(`own repair internal-review ${operation} observes the missing author before automatic authorization`, async () => {
    const f = internalReviewFixture(operation);
    let reads = 0;
    f.ports.github.readPullRequestLocalWorkFacts = async request => {
      reads++;
      assert.equal(request.authorAccountId, null);
      assert.equal(request.account, 'me');
      return f.facts;
    };
    assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
    assert.equal(reads, 2, 'current author and Head/Base are checked again after object preparation');
    assert.equal(f.calls.length, 1);
    assert.equal(Object.hasOwn(f.grant, 'executionSource'), false);
  });
}

test('authorless internal review remains scoped to read-only own repair and current observed ownership', async t => {
  for (const [name, change, expected = 'pending'] of [
    ['modification', f => { f.grant.operation = 'modify'; }],
    ['writable paths', f => { f.grant.writablePaths = ['src/app.js']; }],
    ['write action', f => { f.grant.allowedActions.push('write_text'); }],
    ['ordinary automatic scope', f => { f.root.source.scope.kind = 'automatic'; }],
    ['wrong source provider', f => { f.root.source.identity.provider = 'github'; }],
    ['wrong event', f => { f.root.source.current.event.eventType = 'pull_request.updated'; }],
    ['wrong event provider', f => { f.root.source.current.event.source.provider = 'github'; }],
    ['old repair Head', f => { f.root.source.current.event.payload.internalReview.headRefOid = '9'.repeat(40); }],
    ['invalid repair provenance', f => { delete f.root.source.current.event.payload.internalReview.controlledCommitEvidenceId; }],
    ['another current author', f => { f.facts.author = 'contributor'; }, 'stale'],
    ['changed Base', f => { f.facts.baseRefOid = '9'.repeat(40); }, 'stale'],
  ]) await t.test(name, async () => {
    const f = internalReviewFixture(); change(f);
    assert.equal((await f.service.approveCodeJob(f.item)).status, expected);
    assert.equal(f.calls.length, 0);
  });
});

test('internal review rechecks ownership after preparation instead of approving a newly changed target', async () => {
  const f = internalReviewFixture();
  f.ports.objectSync.prepare = async () => { f.facts.author = 'contributor'; };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'stale');
  assert.equal(f.calls.length, 0);
});

test('unknown facts defer; authority is checked again after object preparation', async () => {
  const f = fixture();
  f.ports.github.readPullRequestLocalWorkFacts = async () => { throw new Error('offline'); };
  await assert.rejects(f.service.approveCodeJob(f.item), /offline/);
  assert.equal(f.calls.length, 0);
  f.ports.github.readPullRequestLocalWorkFacts = async () => f.facts;
  f.ports.objectSync.prepare = async () => { f.roleState.paused = true; };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
  assert.equal(f.calls.length, 0);
});

test('a target change after preparation invalidates the old grant without approval', async () => {
  const f = fixture();
  f.ports.objectSync.prepare = async () => { f.facts.baseRefOid = '9'.repeat(40); };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'stale');
  assert.equal(f.calls.length, 0);
});
