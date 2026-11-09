import { AsyncLocalStorage } from "node:async_hooks";

const cancellation = new AsyncLocalStorage();

export class PreparationAbortedError extends Error {
  constructor() {
    super("Controlled workspace preparation was interrupted");
    this.code = "CODE_PREPARATION_ABORTED";
  }
}

// Runtime cancellation is scoped to one queued preparation, never persisted as
// job authority. In particular it must not spill into another session or cleanup.
export const preparationSignal = () => cancellation.getStore() ?? null;
export const isPreparationAbort = error => error instanceof PreparationAbortedError;
export function throwIfPreparationAborted() {
  if (preparationSignal()?.aborted) throw new PreparationAbortedError();
}
export function withPreparationCancellation(signal, operation) {
  return cancellation.run(signal, () => { throwIfPreparationAborted(); return operation(); });
}
export const withoutPreparationCancellation = operation => cancellation.run(null, operation);

// Only the caller's freshly spawned child is eligible for cancellation. Its
// existing exit/stdio callback still owns settlement; this never rejects early.
export function watchPreparationProcess(child) {
  const signal = preparationSignal();
  let requested = false;
  const abort = () => {
    if (!Number.isSafeInteger(child.pid) || child.killed || child.exitCode !== null || child.signalCode !== null) return;
    try { requested = child.kill("SIGKILL") === true; } catch { /* The owned command's exit/timeout must still settle. */ }
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return () => { signal?.removeEventListener("abort", abort); return requested; };
}
