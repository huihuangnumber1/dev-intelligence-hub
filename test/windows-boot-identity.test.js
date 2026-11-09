import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWindowsBootIdentity, readWindowsBootIdentity } from '../src/lib/windows-boot-identity.js';

const valid = { schemaVersion: 1, machineDigest: 'a'.repeat(64), startedAt: '2026-10-31T00:00:00.000Z', recordId: 10, uptimeMs: 10000 };
const now = Date.parse('2026-11-04T00:00:00Z');

test('boot identity accepts only bounded canonical kernel and machine fields', () => {
  assert.deepEqual(normalizeWindowsBootIdentity(valid, now), valid);
  for (const value of [null, [], { ...valid, unexpected: true }, { ...valid, schemaVersion: 2 },
    { ...valid, machineDigest: 'not-a-digest' }, { ...valid, recordId: 0 }, { ...valid, recordId: 1.5 },
    { ...valid, uptimeMs: -1 }, { ...valid, uptimeMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, startedAt: '2026-10-31' }, { ...valid, startedAt: '2026-11-05T00:00:00.000Z' }]) {
    assert.equal(normalizeWindowsBootIdentity(value, now), null);
  }
});

test('real Windows boot identity has a stable epoch and a live uptime counter', { skip: process.platform !== 'win32' }, async t => {
  const first = await readWindowsBootIdentity();
  if (!first) { t.skip('kernel event, WMI, or machine identity unavailable'); return; }
  const second = await readWindowsBootIdentity();
  assert.equal(first.machineDigest, second.machineDigest);
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(first.recordId, second.recordId);
  assert.ok(second.uptimeMs >= first.uptimeMs);
  assert.deepEqual(normalizeWindowsBootIdentity(first), first);
});
