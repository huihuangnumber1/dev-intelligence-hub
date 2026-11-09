import assert from 'node:assert/strict';
import timers from 'node:timers';

// Capture trusted builtin functions during module evaluation, before any test
// installs MockTimers. Neither the watchdog nor its disposal uses globals.
const REAL_SET_TIMEOUT = timers.setTimeout;
const REAL_CLEAR_TIMEOUT = timers.clearTimeout;
export const CONTROLLED_PROVIDER_TEST_TIMEOUT_MS = 10_000;

export async function withinRealTime(milliseconds, promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = REAL_SET_TIMEOUT(() => reject(Object.assign(
        new Error('Provider fixture exceeded its real watchdog'),
        { code: 'TEST_REAL_WATCHDOG_TIMEOUT' },
      )), milliseconds);
    })]);
  } finally { REAL_CLEAR_TIMEOUT(timer); }
}

// For stub-runner lifecycle tests, never use admission/preparation wall time
// to decide whether a later cancellation or recovery phase was exercised.
// Real process/ACL supervision tests keep their real clocks and termination.
export function controlledProviderTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let milliseconds = 10_000;
  return Object.freeze({
    monotonicClock: () => milliseconds,
    advance(amount) {
      assert.ok(Number.isSafeInteger(amount) && amount >= 0);
      milliseconds += amount;
      t.mock.timers.tick(amount);
    },
    restore() {
      t.mock.timers.reset();
      return globalThis.setTimeout === REAL_SET_TIMEOUT;
    },
    phase(name) {
      let enter;
      const entered = new Promise(resolve => { enter = resolve; });
      return Object.freeze({
        enter,
        async waitFor(outcome) {
          const tooEarly = () => assert.fail(`Provider settled before fixture phase: ${name}`);
          let onAbort;
          const aborted = new Promise((_, reject) => {
            onAbort = () => reject(Object.assign(new Error('Provider fixture phase was aborted'), { code: 'TEST_PHASE_ABORTED' }));
            t.signal.addEventListener('abort', onAbort, { once: true });
            if (t.signal.aborted) onAbort();
          });
          try {
            return await withinRealTime(CONTROLLED_PROVIDER_TEST_TIMEOUT_MS,
              Promise.race([entered, Promise.resolve(outcome).then(tooEarly, tooEarly), aborted]));
          } finally { t.signal.removeEventListener('abort', onAbort); }
        },
      });
    },
  });
}
