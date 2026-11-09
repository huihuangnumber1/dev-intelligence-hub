import assert from 'node:assert/strict';
import test from 'node:test';
import { TargetedCycleQueue } from '../src/lib/targeted-cycle-queue.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('target ownership remains live until its actual operation settles after cancellation', async () => {
  const queue = new TargetedCycleQueue(), execution = deferred(), started = deferred(), abort = new AbortController();
  let finished = false;
  const target = queue.run('target', { signal: abort.signal, current: () => null,
    execute() { started.resolve(); return execution.promise; } });
  target.finally(() => { finished = true; });
  await started.promise;
  abort.abort(new Error('stop requested'));
  await tick(); assert.equal(finished, false, 'an abort request is not proof that owned work stopped');
  execution.resolve('stopped');
  assert.equal(await target, 'stopped');
});

test('different targets serialize behind the actual owner and retain their own acknowledgements', async () => {
  const queue = new TargetedCycleQueue(), old = deferred(), one = deferred(), oneStarted = deferred();
  let active = old.promise;
  const calls = [];
  const first = queue.run('one', { current: () => active, execute() {
    calls.push('one'); active = one.promise.finally(() => { active = null; }); oneStarted.resolve(); return active;
  } });
  const second = queue.run('two', { current: () => active, execute() { calls.push('two'); return 'two-result'; } });
  assert.notEqual(first, second);
  await tick(); assert.deepEqual(calls, []);
  active = null; old.resolve(); await oneStarted.promise;
  await tick(); assert.deepEqual(calls, ['one']);
  one.resolve('one-result');
  assert.deepEqual(await Promise.all([first, second]), ['one-result', 'two-result']);
  assert.deepEqual(calls, ['one', 'two']);
});

test('pending targets are bounded and cancellation clears queued work without starting it later', async () => {
  const queue = new TargetedCycleQueue(), old = deferred(), abort = new AbortController();
  let calls = 0;
  const request = key => queue.run(key, { signal: abort.signal, current: () => old.promise, execute() { calls += 1; } });
  const waiting = Array.from({ length: 32 }, (_, index) => request(String(index)));
  const outcomes = Promise.allSettled(waiting);
  assert.throws(() => request('overflow'), { code: 'WORK_TARGET_QUEUE_FULL' });
  abort.abort(new Error('queued stop'));
  assert.equal((await outcomes).filter(x => x.status === 'rejected').length, 32);
  old.resolve(); await tick(); assert.equal(calls, 0);
  assert.equal(await queue.run('fresh', { current: () => null, execute: () => 'fresh' }), 'fresh');
});

test('repeated cancelled targets share one removable settlement subscription per long-lived owner', async () => {
  const queue = new TargetedCycleQueue(), owner = deferred();
  let subscriptions = 0;
  const originalThen = owner.promise.then.bind(owner.promise);
  owner.promise.then = (...args) => { subscriptions += 1; return originalThen(...args); };
  for (let wave = 0; wave < 3; wave += 1) {
    const abort = new AbortController();
    const target = queue.run('target', { signal: abort.signal, current: () => owner.promise,
      execute() { assert.fail('a cancelled target must not execute'); } });
    const rejected = assert.rejects(target, /cancelled/);
    await tick(); abort.abort(new Error('cancelled')); await rejected;
  }
  assert.equal(subscriptions, 1, 'cancelled waves must not keep adding reactions to the same owner');
  owner.resolve(); await tick();
});
