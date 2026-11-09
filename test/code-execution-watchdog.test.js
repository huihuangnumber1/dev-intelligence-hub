import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodeExecutionWatchdog, codeExecutionWatchdogSignal, startCodeExecutionTurn,
  reportCodeExecutionActivity, beginCodeExecutionHostOperation, closeCodeExecutionWatchdog } from '../src/lib/code-execution-watchdog.js';

const MINUTE = 60_000;
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 120_000, ...options });
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  return { watchdog, signal: codeExecutionWatchdogSignal(watchdog), tick: ms => t.mock.timers.tick(ms) };
}

test('watchdog authority is opaque, process private and cannot be forged or serialized', t => {
  const f = fixture(t);
  assert.equal(JSON.stringify(f.watchdog), '{}');
  assert.ok(Object.isFrozen(f.watchdog));
  for (const value of [{}, structuredClone(f.watchdog), null, { idleMs: 86_400_000 }]) {
    assert.throws(() => codeExecutionWatchdogSignal(value), /watchdog is invalid/);
  }
  assert.throws(() => createCodeExecutionWatchdog({ startupMs: 1000, idleMs: 1000 }), /inactivity bound is invalid/);
});

test('bootstrap still has a bounded deadline; current-turn silence has a distinct inactivity failure', t => {
  const f = fixture(t);
  f.tick(120_000);
  assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_TIMEOUT');
  const running = createCodeExecutionWatchdog({ startupMs: 1000 });
  startCodeExecutionTurn(running);
  f.tick(15 * MINUTE - 1);
  assert.equal(codeExecutionWatchdogSignal(running).aborted, false);
  f.tick(1);
  assert.equal(codeExecutionWatchdogSignal(running).reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  closeCodeExecutionWatchdog(running);
});

test('a configured inactivity allowance above fifteen minutes is preserved', t => {
  const f = fixture(t, { idleMs: 60 * MINUTE });
  startCodeExecutionTurn(f.watchdog);
  f.tick(59 * MINUTE); assert.equal(f.signal.aborted, false);
  f.tick(MINUTE); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

test('useful progress can continue for more than ten hours without a task wall-clock cap', t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  for (let index = 0; index < 61; index++) {
    f.tick(10 * MINUTE); reportCodeExecutionActivity(f.watchdog);
    assert.equal(f.signal.aborted, false);
  }
});

test('an admitted fixed profile has its own budget even if model inactivity elapses while it runs', t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  f.tick(14 * MINUTE);
  const finish = beginCodeExecutionHostOperation(f.watchdog, 'perform_action', { decision: { action: { type: 'run_profile' } } });
  f.tick(10 * MINUTE); assert.equal(f.signal.aborted, false);
  finish(true, { result: 'passed' }, { before: '0'.repeat(64), after: '1'.repeat(64) });
  f.tick(14 * MINUTE); assert.equal(f.signal.aborted, false);
  f.tick(MINUTE); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

for (const name of ['get_state', 'read_source', 'perform_action']) test(`a hung ${name} callback cannot keep the model alive`, t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  beginCodeExecutionHostOperation(f.watchdog, name, {});
  f.tick(30 * MINUTE);
  assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

test('even an admitted fixed profile cannot run forever through native keepalive events', t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  beginCodeExecutionHostOperation(f.watchdog, 'perform_action', { decision: { action: { type: 'run_profile' } } });
  for (let index = 0; index < 39; index++) { f.tick(MINUTE); reportCodeExecutionActivity(f.watchdog); }
  assert.equal(f.signal.aborted, false);
  f.tick(MINUTE);
  assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

test('state polling never renews or suspends model inactivity', t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  for (let index = 0; index < 14; index++) {
    f.tick(MINUTE);
    beginCodeExecutionHostOperation(f.watchdog, 'get_state', {})(true, { revision: index });
  }
  const finish = beginCodeExecutionHostOperation(f.watchdog, 'get_state', {});
  f.tick(MINUTE);
  assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT'); finish(true, {});
});

for (const name of ['read_source', 'perform_action']) test(`identical ${name} results cannot extend inactivity indefinitely`, t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  const args = { path: 'src/fixed.cpp', offset: 0 }, result = { path: 'src/fixed.cpp', offset: 0, text: 'same content', sourceVersion: 'same-version' };
  beginCodeExecutionHostOperation(f.watchdog, name, args)(true, result);
  for (let index = 0; index < 14; index++) {
    f.tick(MINUTE);
    beginCodeExecutionHostOperation(f.watchdog, name, args)(true, result);
  }
  const finish = beginCodeExecutionHostOperation(f.watchdog, name, args);
  f.tick(MINUTE);
  finish(true, result);
  assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

test('a rejected tool operation does not create progress or replace its error with a timeout', t => {
  const f = fixture(t); startCodeExecutionTurn(f.watchdog);
  f.tick(14 * MINUTE);
  beginCodeExecutionHostOperation(f.watchdog, 'read_source', { path: 'missing' })(false);
  assert.equal(f.signal.aborted, false);
  f.tick(MINUTE); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});
