import test from 'node:test';
import assert from 'node:assert/strict';
import { CiRepairContextReader } from '../src/services/ci-repair-context-reader.js';
import { createPullRequestReadFacts, createPullRequestReadIdentity } from '../src/domain/pull-request-read-facts.js';
import { normalizeWorkflowEvent } from '../src/domain/workflow-events.js';
import { createPullRequestExecutionBinding } from '../src/domain/pull-request-execution-binding.js';
import { JenkinsCiDiagnostics } from '../src/services/jenkins-ci-diagnostics.js';
import { normalizeCiRepairEvidence } from '../src/domain/ci-repair-evidence.js';
import { createOwnerPullRequestEvent } from '../src/domain/owner-work-request.js';

function fixture({ ownerRequested = false, internalReview = null } = {}) {
  const target = { schemaVersion: 1, provider: 'github', sourceAccountId: 'me', baseRepository: 'acme/repo',
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRepository: 'acme/repo', headRefName: 'fix/ci', headRefOid: 'b'.repeat(40) };
  const event = internalReview ? createOwnerPullRequestEvent({ schemaVersion: 7,
    requestId: '123e4567-e89b-42d3-a456-426614174000', workType: 'pull_request', priority: 'high', title: 'Review repaired CI',
    description: 'Continue the published repair', acceptanceCriteria: ['Retain publication provenance'],
    pullRequest: { repository: 'acme/repo', number: 42 }, internalReview: { kind: internalReview,
      headRefOid: target.headRefOid, feedbackDigest: 'c'.repeat(64), publicationConfirmationId: 'confirmed-push', controlledCommitEvidenceId: 'verified-commit' } },
    { repository: 'acme/repo', number: 42, title: 'Repair', state: 'open', gitTarget: target }, '2026-10-23T10:00:00.000Z')
    : normalizeWorkflowEvent({ schemaVersion: 1, eventType: ownerRequested ? 'pull_request.owner_requested' : 'pull_request.updated', occurredAt: '2026-10-23T10:00:00.000Z',
    source: ownerRequested ? { provider: 'local-owner', scopeId: 'owner-request:123e4567-e89b-42d3-a456-426614174000' }
      : { provider: 'github', scopeId: 'github-dashboard' }, subject: { id: 'acme/repo#42', repository: 'acme/repo', number: 42 },
    payload: { ...(ownerRequested ? { workType: 'general', suggestedCapability: 'development', expectedHeadRefOid: target.headRefOid } : { relation: 'authored' }), nextAction: 'fix_ci', headRefOid: target.headRefOid, gitTargetAvailable: true, gitTarget: target } });
  const inputBinding = createPullRequestExecutionBinding({ event, sourceBinding: { kind: 'pull_request', rootItemId: 'work-ci', workKey: 'ci-repair',
    inputRevision: 1, headRevision: 1, headRefOid: target.headRefOid, eventId: event.eventId, eventDigest: event.contentDigest, inputDigest: 'f'.repeat(64) } });
  const identity = createPullRequestReadIdentity({ executionBinding: inputBinding, event });
  const live = { state: 'open', author: 'me', isDraft: true, headRefOid: target.headRefOid, baseRefOid: target.baseRefOid, mergeStateStatus: 'CLEAN' };
  const factsInput = { identity, observedAt: '2026-10-23T10:00:00.000Z', reviewDecision: 'NONE', comments: [], reviews: [], reviewThreads: [],
    checks: [{ kind: 'status_context', name: 'QuickTest', url: 'http://ci.example/job/QuickTest/12/', status: 'COMPLETED', conclusion: 'FAILURE',
      startedAt: null, completedAt: null, requirement: 'required' }],
    truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } };
  const calls = [];
  const github = { async readPullRequestLocalWorkFacts(request) { calls.push('target'); assert.equal(request.authorAccountId, 'me'); return structuredClone(live); },
    async loadPullRequestFacts(request) { calls.push('checks'); assert.deepEqual(request, { executionBinding: inputBinding, event }); return createPullRequestReadFacts(factsInput); } };
  const diagnostics = { async read(request) { calls.push('diagnostics'); assert.equal(request.checks[0].url, factsInput.checks[0].url); return null; } };
  return { input: { inputBinding, event }, live, factsInput, calls, github, diagnostics,
    reader: () => new CiRepairContextReader({ github, diagnostics }) };
}

test('host CI evidence uses current GitHub checks and exact target even for an owned draft PR', async () => {
  const f = fixture(), value = await f.reader().read(f.input);
  assert.equal(value.ciEvidence.checks[0].conclusion, 'FAILURE');
  assert.equal(value.ciEvidence.headRefOid, f.input.inputBinding.headRefOid);
  assert.deepEqual(f.calls, ['target', 'checks', 'diagnostics', 'target']);
});

test('complete Jenkins material evidence survives host CI capture and immutable evidence normalization', async () => {
  const f = fixture({ ownerRequested: true });
  const diagnostics = new JenkinsCiDiagnostics({
    credentialSource: { async acquire() { return { username: 'fixture', password: 'fixture', version: 'v1' }; } },
    fetchImpl: async url => new Response(url.endsWith('api/json')
      ? JSON.stringify({ number: 12, building: false, result: 'FAILURE' })
      : `HEAD is now at ${'b'.repeat(11)} base\n[INFO] Branch: fix/ci  SHA: ${'b'.repeat(40)}\n` +
        '[ RUN      ] CodeTest.Includes\nmissing include\n[  FAILED  ] CodeTest.Includes (1 ms)\nFinished: FAILURE'),
  });
  const reader = new CiRepairContextReader({ github: f.github, diagnostics });
  const { ciEvidence } = await reader.read(f.input);
  assert.match(ciEvidence.diagnostics[0].materialDigest, /^[a-f0-9]{64}$/u);
  assert.equal(ciEvidence.diagnostics[0].state, 'available');
  assert.deepEqual(normalizeCiRepairEvidence(ciEvidence), ciEvidence);
});

test('an explicit owner CI request reads fresh own-author checks without inventing an authored event', async () => {
  const f = fixture({ ownerRequested: true }), original = structuredClone(f.input.event);
  const value = await f.reader().read(f.input);
  assert.equal(value?.facts.author, 'me');
  assert.equal(value?.ciEvidence.checks[0].conclusion, 'FAILURE');
  assert.deepEqual(f.input.event, original);
  assert.equal(Object.hasOwn(f.input.event.payload, 'relation'), false);
  for (const field of ['author', 'headRefOid', 'baseRefOid']) {
    const other = fixture({ ownerRequested: true }); other.live[field] = field === 'author' ? 'other' : 'c'.repeat(40);
    assert.equal(await other.reader().read(other.input), null, field);
  }
});

test('wrong author, changed Head/Base, merge conflict, success or incomplete checks do not authorize CI repair', async () => {
  for (const ownerRequested of [false, true]) {
  for (const mutate of [f => { f.live.author = 'other'; }, f => { f.live.headRefOid = 'd'.repeat(40); },
    f => { f.live.baseRefOid = 'd'.repeat(40); }, f => { f.live.mergeStateStatus = 'DIRTY'; },
    f => { f.factsInput.checks[0].conclusion = 'SUCCESS'; }, f => { f.factsInput.truncation.checks = true; }]) {
    const f = fixture({ ownerRequested }); mutate(f); assert.equal(await f.reader().read(f.input), null);
  }
  }
});

test('host-issued CI review feedback captures only fresh failing checks on its exact published target', async () => {
  const f = fixture({ internalReview: 'own_pr_ci_repair' });
  assert.equal((await f.reader().read(f.input))?.ciEvidence.headRefOid, f.input.inputBinding.headRefOid);
  const review = fixture({ internalReview: 'own_pr_repair' });
  assert.equal(await review.reader().read(review.input), null);
  for (const field of ['author', 'headRefOid', 'baseRefOid']) {
    const changed = fixture({ internalReview: 'own_pr_ci_repair' });
    changed.live[field] = field === 'author' ? 'other' : 'd'.repeat(40);
    assert.equal(await changed.reader().read(changed.input), null);
  }
  const success = fixture({ internalReview: 'own_pr_ci_repair' }); success.factsInput.checks[0].conclusion = 'SUCCESS';
  assert.equal(await success.reader().read(success.input), null);
});

test('target changes during diagnostic reading and adapter failures cannot become CI provenance', async () => {
  const f = fixture(); f.diagnostics.read = async () => { f.live.headRefOid = 'd'.repeat(40); return null; };
  assert.equal(await f.reader().read(f.input), null);
  const broken = fixture(); broken.github.loadPullRequestFacts = async () => { throw new Error('private adapter detail'); };
  await assert.rejects(broken.reader().read(broken.input), error => error.code === 'CODE_CI_REPAIR_CONTEXT_UNAVAILABLE' && !error.message.includes('private'));
});

test('caller cancellation is preserved before any CI network read', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.reader().read(f.input, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(f.calls, []);
});
