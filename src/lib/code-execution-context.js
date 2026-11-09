import { OperationQueue } from "./operation-queue.js";
import { beginCodeExecutionHostOperation, codeExecutionWatchdogSignal } from './code-execution-watchdog.js';

const contexts = new WeakMap();
const CALLBACKS = new Map([
  ["perform_action", "performAction"],
  ["edit_source", "editSource"],
  ["read_source", "readSource"],
  ["read_conflict_source", "readConflictSource"],
  ["get_state", "getState"],
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function stateFor(context) {
  const state = context && typeof context === "object" ? contexts.get(context) : null;
  if (!state) throw failure("CODE_EXECUTION_CONTEXT_INVALID");
  return state;
}

// A serialized model input cannot recreate this authority. Callbacks retain
// job ownership, workspace revision, audit and executor validation on the host.
export function createCodeExecutionContext({ performAction, editSource, readSource, readConflictSource, getState, close, progressFingerprint, sourceReadIdentity } = {}) {
  if ([performAction, readSource, getState].some((callback) => typeof callback !== "function") ||
      (editSource !== undefined && typeof editSource !== "function") ||
      (readConflictSource !== undefined && typeof readConflictSource !== "function") ||
      (close !== undefined && typeof close !== "function") ||
      (progressFingerprint !== undefined && typeof progressFingerprint !== 'function') ||
      (sourceReadIdentity !== undefined && typeof sourceReadIdentity !== 'function')) {
    throw failure("CODE_EXECUTION_CONTEXT_INVALID");
  }
  const context = Object.freeze({});
  contexts.set(context, {
    callbacks: { performAction, editSource, readSource, readConflictSource, getState, close, progressFingerprint, sourceReadIdentity },
    controller: new AbortController(), started: false, revoked: false,
    queue: new OperationQueue(), closing: null, removeParentAbort: null, pendingCallbacks: new Set(),
  });
  return context;
}

export function isCodeExecutionContext(value) {
  return value !== null && typeof value === "object" && contexts.has(value);
}

function assertActive(state) {
  if (state.revoked) throw failure("CODE_EXECUTION_SESSION_REVOKED");
}

export function revokeCodeExecutionContext(context, { abortActive = false } = {}) {
  const state = stateFor(context);
  state.revoked = true;
  if (abortActive && !state.controller.signal.aborted) {
    state.controller.abort(failure("CODE_EXECUTION_SESSION_REVOKED"));
  }
}

// Revocation denies admission before draining. A pause does not interrupt a
// write already admitted by the host; cancellation can explicitly abort it.
export function closeCodeExecutionContext(context) {
  const state = stateFor(context);
  revokeCodeExecutionContext(context);
  return state.closing ??= (async () => {
    try {
      await state.queue.tail;
      // A deadline can stop waiting for an uncooperative callback, but cannot
      // certify that its host action settled or release the workspace owner.
      if (state.pendingCallbacks.size) throw failure('CODE_EXECUTION_UNSETTLED');
      return await state.callbacks.close?.();
    } finally {
      state.removeParentAbort?.();
    }
  })();
}

export function beginCodeExecutionSession(context, { signal = null, watchdog = null } = {}) {
  const state = stateFor(context);
  assertActive(state);
  if (state.started) throw failure("CODE_EXECUTION_SESSION_ALREADY_STARTED");
  const watchdogSignal = watchdog === null ? null : codeExecutionWatchdogSignal(watchdog);
  state.started = true;
  const onAbort = () => revokeCodeExecutionContext(context, { abortActive: true });
  signal?.addEventListener("abort", onAbort, { once: true });
  watchdogSignal?.addEventListener('abort', onAbort, { once: true });
  state.removeParentAbort = () => { signal?.removeEventListener("abort", onAbort); watchdogSignal?.removeEventListener('abort', onAbort); };
  if (signal?.aborted || watchdogSignal?.aborted) onAbort();
  return Object.freeze({
    assertActive: () => assertActive(state),
    invoke(name, args) {
      try {
        assertActive(state);
        const callback = CALLBACKS.get(name);
        if (!callback || typeof state.callbacks[callback] !== "function") throw failure("CODE_EXECUTION_TOOL_NOT_ALLOWED");
        return state.queue.enqueue(async () => {
          assertActive(state);
          const finish = watchdog === null ? null : beginCodeExecutionHostOperation(watchdog, name, args);
          let removeAbort;
          const operation = Promise.resolve().then(async () => {
            const fingerprint = ['perform_action', 'edit_source'].includes(name) ? state.callbacks.progressFingerprint : null;
            const before = await fingerprint?.();
            // The trusted read can outlive cancellation or an idle deadline.
            // Re-check admission before starting the side-effecting callback.
            assertActive(state);
            state.controller.signal.throwIfAborted();
            const value = await state.callbacks[callback](args, { signal: state.controller.signal });
            const after = await fingerprint?.();
            const sourceIdentity = ['read_source', 'read_conflict_source'].includes(name) ? await state.callbacks.sourceReadIdentity?.() : null;
            return { value, before, after, sourceIdentity };
          });
          state.pendingCallbacks.add(operation);
          void operation.then(() => state.pendingCallbacks.delete(operation), () => state.pendingCallbacks.delete(operation));
          try {
            const aborted = watchdogSignal && new Promise((_, reject) => {
              const onWatchdogAbort = () => reject(watchdogSignal.reason);
              watchdogSignal.addEventListener('abort', onWatchdogAbort, { once: true });
              removeAbort = () => watchdogSignal.removeEventListener('abort', onWatchdogAbort);
              if (watchdogSignal.aborted) onWatchdogAbort();
            });
            const completed = await (aborted ? Promise.race([operation, aborted]) : operation);
            finish?.(!state.revoked && !state.controller.signal.aborted, completed.value, {
              before: completed.before, after: completed.after, sourceIdentity: completed.sourceIdentity,
            });
            return completed.value;
          } finally { removeAbort?.(); finish?.(false); }
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    revoke: (options) => revokeCodeExecutionContext(context, options),
    close: () => closeCodeExecutionContext(context),
  });
}
