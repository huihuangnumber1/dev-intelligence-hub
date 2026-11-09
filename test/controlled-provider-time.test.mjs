import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { controlledProviderTime, withinRealTime } from './support/controlled-provider-time.mjs';

test('the real watchdog expires while both virtual clocks remain frozen', { timeout: 1_000 }, async t => {
  const originalTimer = globalThis.setTimeout;
  const time = controlledProviderTime(t);
  try {
    await assert.rejects(withinRealTime(20, new Promise(() => {})), { code: 'TEST_REAL_WATCHDOG_TIMEOUT' });
    assert.equal(time.monotonicClock(), 10_000);
  } finally { assert.equal(time.restore(), true); }
  assert.equal(globalThis.setTimeout, originalTimer);
});

test('a pending phase responds to the real test signal and removes its abort listener', { timeout: 1_000 }, async t => {
  const controller = new AbortController();
  const time = controlledProviderTime({ mock: t.mock, signal: controller.signal });
  try {
    const waiting = time.phase('never-entered').waitFor(new Promise(() => {}));
    controller.abort();
    await assert.rejects(waiting, { code: 'TEST_PHASE_ABORTED' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { assert.equal(time.restore(), true); }
});
