import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticOwnPrHandoff } from '../src/services/automatic-own-pr-handoff.js';

function fixture() {
  const head = '1'.repeat(40);
  const binding = { schemaVersion: 2, kind: 'pull_request', repository: 'acme/repo', pullRequestNumber: 42,
    rootItemId: 'root', workKey: 'pr-work-42', inputRevision: 1, headRevision: 1, headRefOid: head,
    eventId: 'event', eventDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), gitTarget: { schemaVersion: 1,
      provider: 'github', sourceAccountId: 'me', baseRepository: 'acme/repo', baseRefName: 'main',
      baseRefOid: '2'.repeat(40), headRepository: 'acme/repo', headRefName: 'fix', headRefOid: head } };
  const root = { itemId: 'root', kind: 'source_root', status: 'completed', currentTarget: { type: 'role', id: 'developer' },
    source: { scope: { active: true } }, event: { eventType: 'pull_request.status', subject: { repository: 'acme/repo', number: 42 },
      payload: { relation: 'authored', author: 'me', headRefOid: head } } };
  root.decisionContext = { source: 'proposal', outcome: 'succeeded', referenceId: 'proposal', value: { kind: 'code_action_proposal', evidence: ['code-job:code-job-' + 'a'.repeat(55), 'code-job-status:completed', 'memory:receipt'] } };
  const job = { operation: 'verify', status: 'completed', terminalResult: { kind: 'completed' }, requestedBy: { roleId: 'developer', workItemId: 'root' }, proposalId: 'proposal', inputBinding: binding, memoryProjection: { recordId: 'receipt' } };
  const item = { kind: 'pull_request', repo: 'acme/repo', number: 42, author: 'me', currentUser: 'me', state: 'open', relation: 'authored',
    title: 'Qt report fix', headRefOid: head, gitTarget: binding.gitTarget, reviewDecision: 'CHANGES_REQUESTED' };
  const config = { githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: 'me' },
    trackedRepositories: ['acme/repo'], workCoordination: { policy: { reviewOwnersByProduct: { qt: ['reviewer'] }, testingOwnersByProduct: { qt: ['qa'] } } } };
  const facts = { state: 'open', isDraft: false, author: 'me', currentUser: 'me', repo: 'acme/repo', number: 42,
    headRefOid: head, reviewDecision: 'CHANGES_REQUESTED', assignees: ['me'],
    reviewDecisions: [{ author: 'reviewer', state: 'CHANGES_REQUESTED', reviewedHeadRefOid: '0'.repeat(40), submittedAt: '2026-10-20T01:00:00Z' }] };
  const saved = new Map(); const assignments = [];
  const ports = { store: { async read(key, fallback) { return structuredClone(saved.get(key) ?? fallback); },
    async write(key, value) { saved.set(key, structuredClone(value)); } },
    configurationReader: { async readActive() { return { configuration: config }; } },
    ledger: { async listItems() { return { items: [root], nextCursor: null }; },
      async readItemForReconciliation() { return root; },
      async readPullRequestExecutionContext() { return { inputBinding: binding, author: 'me' }; } },
    codeJobReader: { async get() { return structuredClone(job); } },
    bindingReader: { read: () => binding },
    roleStateReader: { async read() { return { enabled: true, paused: false }; } },
    github: { async readOwnPullRequestHandoff() { return structuredClone(facts); } },
    assignee: { async assignAssignee(request) { assignments.push(request); facts.assignees = [request.assigneeLogin]; return { status: 'applied', assigneeLogin: request.assigneeLogin }; } },
  };
  saved.set('snapshot', { sourceStatus: { githubPullRequests: { ok: true } }, items: [item] });
  return { root, job, binding, item, facts, config, ports, saved, assignments, service: new AutomaticOwnPrHandoff(ports) };
}

test('completed current own-PR work returns to the original reviewer and survives restart without duplicate assignment', async () => {
  const f = fixture();
  assert.equal((await f.service.runCycle()).assigned, 1);
  assert.equal(f.assignments[0].assigneeLogin, 'reviewer');
  assert.equal(f.assignments[0].expectedHeadOid, f.item.headRefOid);
  assert.equal(f.assignments[0].expectedAssigneeLogin, 'me');
  await new AutomaticOwnPrHandoff(f.ports).runCycle();
  assert.equal(f.assignments.length, 1);
});

test('only a human approval on the current Head moves the PR from reviewer to QA', async () => {
  const f = fixture(); await f.service.runCycle();
  f.item.reviewDecision = f.facts.reviewDecision = 'APPROVED';
  f.facts.reviewDecisions = [{ author: 'reviewer', state: 'APPROVED', reviewedHeadRefOid: '0'.repeat(40) }];
  await f.service.runCycle(); assert.equal(f.assignments.length, 1);
  f.facts.reviewDecisions[0].reviewedHeadRefOid = f.item.headRefOid;
  assert.equal((await f.service.runCycle()).assigned, 1);
  assert.equal(f.assignments[1].assigneeLogin, 'qa');
  assert.equal(f.assignments[1].expectedAssigneeLogin, 'reviewer');
});

for (const [name, mutate] of [
  ['other author', f => { f.facts.author = 'other'; }],
  ['changed Head', f => { f.facts.headRefOid = '9'.repeat(40); }],
  ['paused work', f => { f.root.status = 'paused'; }],
  ['closed PR', f => { f.facts.state = 'closed'; }],
  ['draft PR', f => { f.facts.isDraft = true; }],
  ['manual assignment', f => { f.facts.assignees = ['someone-else']; }],
  ['automation disabled', f => { f.config.githubActions.automaticOwnPrRepair = false; }],
]) {
  test(`own-PR handoff preserves ${name}`, async () => {
    const f = fixture(); mutate(f); await f.service.runCycle(); assert.equal(f.assignments.length, 0);
  });
}

test('a lost assignment acknowledgement is reconciled by reading the existing assignee', async () => {
  const f = fixture();
  f.ports.assignee.assignAssignee = async request => { f.assignments.push(request); f.facts.assignees = [request.assigneeLogin]; throw new Error('ACK lost'); };
  await f.service.runCycle();
  const result = await new AutomaticOwnPrHandoff(f.ports).runCycle();
  assert.equal(f.assignments.length, 1);
  assert.equal(result.already, 1);
});

for (const [name, mutate] of [
  ['no verify receipt', f => { f.root.decisionContext = null; }],
  ['failed verify', f => { f.job.status = 'failed'; }],
  ['old Head verify', f => { f.job.inputBinding = { ...f.binding, headRefOid: '9'.repeat(40) }; }],
  ['inspection only', f => { f.job.operation = 'inspect'; }],
  ['different job receipt', f => { f.job.proposalId = 'other'; }],
]) test(`completed work with ${name} does not hand off`, async () => {
  const f = fixture(); mutate(f); await f.service.runCycle(); assert.equal(f.assignments.length, 0);
});

test('approval revoked during QA preparation stops transfer', async () => {
  const f = fixture(); f.facts.reviewDecision = 'APPROVED';
  f.facts.reviewDecisions = [{ author: 'reviewer', state: 'APPROVED', reviewedHeadRefOid: f.item.headRefOid }];
  let reads = 0;
  f.ports.github.readOwnPullRequestHandoff = async () => { reads++; return { ...structuredClone(f.facts), ...(reads > 1 ? { reviewDecision: 'CHANGES_REQUESTED' } : {}) }; };
  await f.service.runCycle(); assert.equal(f.assignments.length, 0);
});

test('history scanning advances one page per cycle and resets a stale cursor', async () => {
  const f = fixture(); const queries = [];
  f.ports.ledger.listItems = async query => {
    queries.push(query);
    if (query.cursor === 'old-page') throw Object.assign(new Error('cursor changed'), { code: 'WORK_LEDGER_CURSOR_INVALID' });
    return { items: [], nextCursor: queries.length === 1 ? 'old-page' : null };
  };
  await f.service.runCycle(); assert.equal(queries.length, 1);
  await f.service.runCycle(); assert.equal(queries.length, 3);
  assert.equal(queries[1].cursor, 'old-page'); assert.equal(queries[2].cursor, undefined);
});

test('configuration change during preparation preserves current assignment', async () => {
  const f = fixture();
  f.ports.github.readOwnPullRequestHandoff = async () => { f.config.githubActions.automaticOwnPrRepair = false; return structuredClone(f.facts); };
  await f.service.runCycle(); assert.equal(f.assignments.length, 0);
});
