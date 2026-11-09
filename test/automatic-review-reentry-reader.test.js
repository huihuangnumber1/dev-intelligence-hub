import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticReviewReentryReader } from '../src/services/automatic-review-reentry-reader.js';
import { normalizeWorkflowEvent } from '../src/domain/workflow-events.js';

function fixture(options = {}) {
  const target = { schemaVersion: 1, provider: 'github', sourceAccountId: 'reviewer',
    baseRepository: 'acme/repo', baseRefName: 'main', baseRefOid: 'd'.repeat(40),
    headRepository: 'acme/repo', headRefName: 'fix/report', headRefOid: 'a'.repeat(40) };
  const previous = normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.left_scope',
    occurredAt: '2026-10-22T01:00:00.000Z', source: { provider: 'github', scopeId: 'github-dashboard' },
    subject: { id: 'github:pr:acme/repo#24823', repository: 'acme/repo', number: 24823 },
    payload: { title: 'Review report', headRefOid: target.headRefOid, gitTargetAvailable: true, gitTarget: target } });
  const item = { itemId: 'old-review', kind: 'source_root', status: 'blocked', statusReason: 'pr_source_left_scope',
    currentTarget: { type: 'role', id: 'pr-engineer' }, ownerId: null, leaseId: null, activeIntentId: null,
    sourceQuarantine: null, graph: { deliveries: [] }, source: { scope: { kind: 'automatic', active: false },
      pendingRevision: null, current: { event: structuredClone(previous), headRefOid: target.headRefOid },
      revisions: [{ occurredAt: previous.occurredAt }] } };
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.observed',
    occurredAt: '2026-10-26T03:00:00.000Z', source: previous.source, subject: previous.subject,
    payload: { title: 'Review report', state: 'open', isDraft: false, author: 'author', assignees: ['reviewer'],
      relation: 'review_requested', nextAction: 'rereview', headRefOid: 'b'.repeat(40), gitTargetAvailable: true,
      gitTarget: { ...target, headRefOid: 'b'.repeat(40) } } });
  let latest;
  const reader = new AutomaticReviewReentryReader({ account: 'reviewer', ...options, ledger: {
    async listItems() { return { items: [structuredClone(item)], nextCursor: null }; },
    async readItemForReconciliation() { return structuredClone(latest ?? item); },
    async canReconnectOwnPullRequest() { return true; },
  } });
  return { item, event: structuredClone(event), reader, changedDuringRead() { latest = { ...item, status: 'paused' }; } };
}

test('returning review emits a causal update before scope reentry without modifying the root', async () => {
  const f = fixture(), before = structuredClone(f.item);
  const events = await f.reader.read({ events: [f.event] });
  assert.deepEqual(events.map(x => x.eventType), ['pull_request.updated', 'pull_request.created']);
  assert.equal(events[0].payload.previousHeadRefOid, 'a'.repeat(40));
  assert.equal(events[0].payload.headRefOid, 'b'.repeat(40));
  assert.deepEqual(events[0].payload.changedFields, ['headRefOid']);
  assert.deepEqual(events[1].payload.gitTarget, f.event.payload.gitTarget);
  assert.deepEqual(f.item, before);
});

function authoredFixture({ automaticOwnPrRepair = true, facts = null } = {}) {
  let observed;
  const f = fixture({ automaticReview: false, automaticOwnPrRepair,
    github: { async readPullRequestRoleHandoffFacts(request) {
      observed = request;
      return facts ?? { state: 'open', isDraft: false, author: 'reviewer',
        assignees: ['reviewer'], gitTarget: structuredClone(f.event.payload.gitTarget) };
    } } });
  Object.assign(f.event.payload, { author: 'reviewer', relation: 'authored', actionState: 'action_now', nextAction: 'resolve_conflict' });
  return { ...f, observed: () => observed };
}

test('automatic own conflict recovery reconnects a former review provenance through ordinary causal events', async () => {
  const f = authoredFixture(), before = structuredClone(f.item);
  const events = await f.reader.read({ events: [f.event] });
  assert.deepEqual(events.map(event => event.eventType), ['pull_request.updated', 'pull_request.created']);
  assert.equal(events[0].payload.previousHeadRefOid, 'a'.repeat(40));
  assert.equal(events[0].payload.headRefOid, 'b'.repeat(40));
  assert.equal(events[0].payload.relation, 'authored');
  assert.deepEqual(f.observed(), { repository: 'acme/repo', number: 24823, account: 'reviewer' });
  assert.deepEqual(f.item, before);
});

for (const variant of ['disabled', 'closed', 'draft', 'other-author', 'changed-target', 'changed-assignees', 'other-action', 'concurrent-pause']) {
  test(`own conflict recovery preserves current remote facts and controls (${variant})`, async () => {
    const f = authoredFixture({ automaticOwnPrRepair: variant !== 'disabled' });
    if (variant === 'other-action') f.event.payload.nextAction = 'wait_author';
    if (variant === 'closed' || variant === 'draft' || variant === 'other-author' || variant === 'changed-target' || variant === 'changed-assignees') {
      const facts = { state: 'open', isDraft: false, author: 'reviewer', assignees: ['reviewer'],
        gitTarget: structuredClone(f.event.payload.gitTarget) };
      if (variant === 'closed') facts.state = 'closed';
      if (variant === 'draft') facts.isDraft = true;
      if (variant === 'other-author') facts.author = 'somebody';
      if (variant === 'changed-target') facts.gitTarget.headRefOid = 'c'.repeat(40);
      if (variant === 'changed-assignees') facts.assignees = ['someone'];
      f.reader.github = { async readPullRequestRoleHandoffFacts() { return facts; } };
    }
    if (variant === 'concurrent-pause') f.changedDuringRead();
    assert.deepEqual(await f.reader.read({ events: [f.event] }), []);
  });
}

function historicalScopeExit(f) {
  const lifecycle = { ...f.item.source.revisions[0], eventId: f.item.source.current.event.eventId,
    revision: 1, disposition: 'accepted', authorityEpochChanged: true };
  f.item.source.scope.lastLifecycleEventId = lifecycle.eventId;
  f.item.source.activeRevision = 2;
  f.item.source.revisions = [lifecycle, { revision: 2, occurredAt: '2026-10-24T01:00:00.000Z' }];
  f.item.source.current.event.eventType = 'pull_request.status';
  return lifecycle;
}

test('a later accepted status input does not hide the durable scope exit from automatic review recovery', async () => {
  const f = fixture();
  historicalScopeExit(f);
  const events = await f.reader.read({ events: [f.event] });
  assert.deepEqual(events.map(event => event.eventType), ['pull_request.updated', 'pull_request.created']);
  assert.equal(events[0].payload.previousHeadRefOid, f.item.source.current.headRefOid);
});

for (const variant of ['missing-binding', 'wrong-event', 'not-accepted', 'no-authority-change', 'not-historical']) {
  test(`historical review scope recovery requires the durable lifecycle binding (${variant})`, async () => {
    const f = fixture(), lifecycle = historicalScopeExit(f);
    if (variant === 'missing-binding') delete f.item.source.scope.lastLifecycleEventId;
    if (variant === 'wrong-event') f.item.source.scope.lastLifecycleEventId = 'another-event';
    if (variant === 'not-accepted') lifecycle.disposition = 'ignored_unproven_head';
    if (variant === 'no-authority-change') lifecycle.authorityEpochChanged = false;
    if (variant === 'not-historical') lifecycle.revision = f.item.source.activeRevision;
    assert.deepEqual(await f.reader.read({ events: [f.event] }), []);
  });
}

for (const [key, value] of [['baseRefName', 'release'], ['headRefName', 'renamed-fix'], ['headRepository', 'author/fork']]) {
  test(`a returning review binds the current target after a legitimate ${key} change`, async () => {
    const f = fixture();
    f.event.payload.gitTarget[key] = value;
    const events = await f.reader.read({ events: [f.event] });
    assert.equal(events.length, 2);
    assert.deepEqual(events[1].payload.gitTarget, f.event.payload.gitTarget);
  });
}

for (const variant of ['paused', 'cancelled', 'owner', 'lease', 'intent', 'quarantine', 'deliveries', 'pending',
  'owner-request', 'active', 'not-exit', 'same-head', 'closed', 'draft', 'self', 'unassigned', 'scope', 'account',
  'repository', 'number', 'unavailable-target', 'stale', 'newer-observation', 'concurrent-pause']) {
  for (const own of [false, true]) test(`${own ? 'own conflict' : 'review'} reentry preserves controls and fresh target evidence (${variant})`, async () => {
    const f = own ? authoredFixture() : fixture(), { item, event } = f;
    if (variant === 'paused' || variant === 'cancelled') item.status = variant;
    if (variant === 'owner') item.ownerId = 'owner';
    if (variant === 'lease') item.leaseId = 'lease';
    if (variant === 'intent') item.activeIntentId = 'intent';
    if (variant === 'quarantine') item.sourceQuarantine = {};
    if (variant === 'deliveries') item.graph.deliveries.push({});
    if (variant === 'pending') item.source.pendingRevision = 3;
    if (variant === 'owner-request') item.source.scope.kind = 'owner_requested';
    if (variant === 'active') item.source.scope.active = true;
    if (variant === 'not-exit') item.source.current.event.eventType = 'pull_request.updated';
    if (variant === 'same-head') event.payload.headRefOid = item.source.current.headRefOid;
    if (variant === 'closed') event.payload.state = 'closed';
    if (variant === 'draft') event.payload.isDraft = true;
    if (variant === 'self') event.payload.author = own ? 'somebody-else' : 'reviewer';
    if (variant === 'unassigned') event.payload.assignees = [];
    if (variant === 'scope') event.source.scopeId = 'other-scope';
    if (variant === 'account') event.payload.gitTarget.sourceAccountId = 'other-reviewer';
    if (variant === 'repository') event.subject.repository = 'other/repo';
    if (variant === 'number') event.subject.number = 99;
    if (variant === 'unavailable-target') { delete event.payload.gitTarget; event.payload.gitTargetAvailable = false; }
    if (variant === 'stale') event.occurredAt = '2026-10-21T01:00:00.000Z';
    if (variant === 'newer-observation') item.source.revisions.push({ occurredAt: '2026-10-26T04:00:00.000Z' });
    if (variant === 'concurrent-pause') f.changedDuringRead();
    assert.deepEqual(await f.reader.read({ events: [event] }), []);
  });
}

for (const variant of ['missing-remote', 'remote-failure', 'missing-causal-reader', 'causal-proof-unavailable']) {
  test(`own conflict reentry requires remote and retained causal proof (${variant})`, async () => {
    const f = authoredFixture();
    if (variant === 'missing-remote') f.reader.github = null;
    if (variant === 'remote-failure') f.reader.github = { async readPullRequestRoleHandoffFacts() { throw new Error('not available'); } };
    if (variant === 'missing-causal-reader') delete f.reader.ledger.canReconnectOwnPullRequest;
    if (variant === 'causal-proof-unavailable') f.reader.ledger.canReconnectOwnPullRequest = async () => false;
    assert.deepEqual(await f.reader.read({ events: [f.event] }), []);
  });
}
