import test from 'node:test';
import assert from 'node:assert/strict';
import { createCiRepairEvidence, normalizeCiRepairEvidence } from '../src/domain/ci-repair-evidence.js';
import { createOriginalCiRepairFeedbackSnapshot, normalizeOriginalRepairFeedbackSnapshot,
  createOriginalRepairFeedbackArchiveRecord, normalizeOriginalRepairFeedbackArchiveRecord } from '../src/domain/original-repair-feedback.js';
import { normalizeInternalReviewMetadata } from '../src/domain/internal-repair-review.js';

const input = () => ({ schemaVersion: 1, repository: 'acme/repo', number: 42,
  headRefOid: 'a'.repeat(40), headRefName: 'fix/ci',
  checks: [{ kind: 'status_context', name: 'QuickTest', url: 'https://ci.example/job/QuickTest/12/', conclusion: 'FAILURE' }], diagnostics: [] });
function report() {
  const value = input();
  return { check: 'QuickTest', schemaVersion: 1, repository: value.repository, headRefOid: value.headRefOid,
    buildUrl: value.checks[0].url, buildNumber: 12, state: 'available', result: 'FAILURE', untrustedEvidence: true,
    checkout: { matched: true, sha: value.headRefOid, branch: value.headRefName },
    failures: [{ name: 'CodeTest.MiscCheck', text: 'actual failed check', truncated: false }], observedAt: '2026-10-23T10:00:00.000Z', contentDigest: 'b'.repeat(64) };
}

test('CI evidence keeps immutable failing checks and diagnosis while excluding observation times from identity', () => {
  const value = input(); value.diagnostics = [report()];
  const before = createCiRepairEvidence(value);
  value.diagnostics[0].observedAt = '2026-10-23T11:00:00.000Z';
  value.diagnostics[0].contentDigest = 'c'.repeat(64);
  assert.deepEqual(createCiRepairEvidence(value), before);
  assert.deepEqual(normalizeCiRepairEvidence(before), before);
  value.diagnostics[0].failures[0].text = 'different failed check';
  assert.notEqual(createCiRepairEvidence(value).contentDigest, before.contentDigest);
  assert.equal(createCiRepairEvidence(value).triggerDigest, before.triggerDigest);
  value.diagnostics = [];
  assert.equal(createCiRepairEvidence(value).triggerDigest, before.triggerDigest);
  assert.equal(before.diagnostics[0].failures[0].text, 'actual failed check');
});

test('CI evidence rejects a successful trigger, credentials in URLs, wrong checkout or unrelated diagnostic', () => {
  for (const change of [v => { v.checks = []; }, v => { v.checks[0].conclusion = 'SUCCESS'; },
    v => { v.checks[0].url = 'https://user:password@ci.example/job/QuickTest/12/'; },
    v => { v.diagnostics[0].checkout.sha = 'b'.repeat(40); }, v => { v.diagnostics[0].checkout.branch = 'other'; },
    v => { v.diagnostics[0].check = 'unrelated'; }, v => { v.diagnostics[0].buildUrl = 'https://other.example/job/QuickTest/12/'; },
    v => { v.diagnostics[0].password = 'must never enter source'; }]) {
    const value = input(); value.diagnostics = [report()]; change(value);
    assert.throws(() => createCiRepairEvidence(value), { code: 'CI_REPAIR_EVIDENCE_INVALID' });
  }
});

test('complete log material digest is optional for legacy archives and strictly validated when present', () => {
  const value = input(); value.diagnostics = [report()];
  const legacy = createCiRepairEvidence(value);
  assert.deepEqual(normalizeCiRepairEvidence(legacy), legacy);
  value.diagnostics[0].materialDigest = 'd'.repeat(64);
  const current = createCiRepairEvidence(value);
  assert.equal(current.diagnostics[0].materialDigest, 'd'.repeat(64));
  assert.deepEqual(normalizeCiRepairEvidence(current), current);
  assert.notEqual(current.contentDigest, legacy.contentDigest);
  assert.equal(current.triggerDigest, legacy.triggerDigest);
  for (const invalidDigest of [null, [], ['d'.repeat(64)], {}, 12, 'not-a-digest', 'D'.repeat(64)]) {
    value.diagnostics[0].materialDigest = invalidDigest;
    assert.throws(() => createCiRepairEvidence(value), { code: 'CI_REPAIR_EVIDENCE_INVALID' });
  }
});

test('CI evidence rejects tampering, oversized logs and accessors without evaluating them', () => {
  const value = input(), evidence = createCiRepairEvidence(value);
  evidence.checks[0].name = 'tampered';
  assert.throws(() => normalizeCiRepairEvidence(evidence));
  value.diagnostics = [report()]; value.diagnostics[0].failures[0].text = 'x'.repeat(17 * 1024);
  assert.throws(() => createCiRepairEvidence(value));
  const poisoned = input(); let calls = 0;
  Object.defineProperty(poisoned, 'checks', { enumerable: true, get() { calls++; return []; } });
  assert.throws(() => createCiRepairEvidence(poisoned)); assert.equal(calls, 0);
});

test('check and object ordering do not create new CI repair identity', () => {
  const value = input(); value.checks.push({ conclusion: 'ERROR', url: null, name: 'Build', kind: 'check_run' });
  const before = createCiRepairEvidence(value);
  value.checks = value.checks.reverse().map(check => Object.fromEntries(Object.entries(check).reverse()));
  assert.equal(createCiRepairEvidence(value).contentDigest, before.contentDigest);
});

test('CI feedback reuses immutable repair archives without manufacturing external reviews', () => {
  const ciEvidence = createCiRepairEvidence(input());
  const snapshot = createOriginalCiRepairFeedbackSnapshot({ repository: ciEvidence.repository, number: ciEvidence.number, ciEvidence,
    provenance: { kind: 'captured_before_ci_repair', observedHeadRefOid: ciEvidence.headRefOid, observedAt: '2026-10-23T10:00:00.000Z' } });
  assert.deepEqual(normalizeOriginalRepairFeedbackSnapshot(snapshot), snapshot);
  const archived = createOriginalRepairFeedbackArchiveRecord(snapshot);
  assert.deepEqual(normalizeOriginalRepairFeedbackArchiveRecord(archived), archived);
  assert.equal(snapshot.feedbackDigest, ciEvidence.contentDigest);
  assert.equal(Object.hasOwn(snapshot, 'feedback'), false);
  assert.ok(Object.isFrozen(snapshot.ciEvidence.checks));
  assert.equal(normalizeInternalReviewMetadata({ kind: 'own_pr_ci_repair', headRefOid: 'c'.repeat(40), feedbackDigest: snapshot.feedbackDigest,
    publicationConfirmationId: 'confirmed-ci-push', controlledCommitEvidenceId: 'controlled-ci-commit' }).kind, 'own_pr_ci_repair');
});
