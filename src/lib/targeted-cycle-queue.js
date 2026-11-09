import { normalizeAbortSignal } from './structured-provider-request.js';

function waitForSettlement(owner, signal) {
  signal?.throwIfAborted();
  if (owner.settled) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      owner.waiters.delete(onSettled);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const onSettled = () => finish(resolve);
    signal?.addEventListener('abort', onAbort, { once: true });
    owner.waiters.add(onSettled);
  });
}

// A target cannot borrow an unrelated cycle's acknowledgement. Wait for its
// actual owner to settle, without cancelling that owner or racing active work.
export class TargetedCycleQueue {
  #pending = new Map();
  #owners = new WeakMap();

  #owner(operation) {
    let owner = this.#owners.get(operation);
    if (!owner) {
      owner = { settled: false, waiters: new Set() };
      this.#owners.set(operation, owner);
      const onSettled = () => {
        owner.settled = true;
        for (const done of owner.waiters) done();
        owner.waiters.clear();
      };
      Promise.resolve(operation).then(onSettled, onSettled);
    }
    return owner;
  }

  run(key, { signal = null, current, execute }) {
    signal = normalizeAbortSignal(signal);
    signal?.throwIfAborted();
    if (this.#pending.has(key)) return this.#pending.get(key);
    if (this.#pending.size >= 32) {
      throw Object.assign(new Error('Targeted work queue is full'), { code: 'WORK_TARGET_QUEUE_FULL' });
    }
    const operation = Promise.resolve().then(async () => {
      signal?.throwIfAborted();
      let running;
      while ((running = current())) await waitForSettlement(this.#owner(running), signal);
      signal?.throwIfAborted();
      return execute();
    });
    const tracked = operation.finally(() => {
      if (this.#pending.get(key) === tracked) this.#pending.delete(key);
    });
    this.#pending.set(key, tracked);
    return tracked;
  }
}
