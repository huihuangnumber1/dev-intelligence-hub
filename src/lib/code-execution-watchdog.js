// Host-only authority shared by the provider, native supervisor and tool
// callbacks. Neither serialized input nor native protocol output can create it.
const watchdogs = new WeakMap();
const MODEL_IDLE_MS = 15 * 60_000;
// A callback includes several 60s GitHub authority checks, complete paginated
// repair feedback and audit I/O. This is an independent host hang bound, not a
// task/turn deadline; fixed profiles keep their own ten-minute executor limit.
const HOST_CALLBACK_MS = 30 * 60_000;
const PROFILE_CALLBACK_MS = HOST_CALLBACK_MS + 10 * 60_000;

function failure(code) { return Object.assign(new Error(code), { code, statusCode: 504 }); }
function stateFor(watchdog) {
  const state = watchdog && typeof watchdog === 'object' ? watchdogs.get(watchdog) : null;
  if (!state) throw new TypeError('Code execution watchdog is invalid');
  return state;
}
function armIdle(state, timeoutMs, code = 'STRUCTURED_PROVIDER_IDLE_TIMEOUT') {
  clearTimeout(state.idleTimer);
  state.idleExpired = false;
  if (!state.closed && !state.controller.signal.aborted) {
    state.idleTimer = setTimeout(() => {
      if (state.running && state.hostUseful) state.idleExpired = true;
      else state.controller.abort(failure(code));
    }, timeoutMs);
  }
}

function consumeSourceRange(state, page, identity) {
  if (typeof identity?.path !== 'string' || !identity.path || !/^[a-f0-9]{64}$/u.test(identity.sha256) ||
      !Number.isSafeInteger(identity.totalLength) || identity.totalLength < 0 || page?.path !== identity.path ||
      page.totalLength !== identity.totalLength || !Number.isSafeInteger(page.offset) || page.offset < 0 ||
      typeof page.text !== 'string') return false;
  const end = page.offset + page.text.length;
  if (end > identity.totalLength || (page.nextOffset === null ? end !== identity.totalLength :
    !Number.isSafeInteger(page.nextOffset) || page.nextOffset !== end || end >= identity.totalLength)) return false;
  // Identity is supplied only by the opaque host callback after audited source
  // validation. MCP arguments, sourceVersion and page framing supply no SHA.
  const key = JSON.stringify([identity.path, identity.sha256]);
  const consumed = state.sourceReads.get(key) ?? { totalLength: identity.totalLength, ranges: [], emptyRead: false };
  if (consumed.totalLength !== identity.totalLength) return false;
  state.sourceReads.set(key, consumed);
  if (identity.totalLength === 0) {
    const fresh = !consumed.emptyRead; consumed.emptyRead = true; return fresh;
  }
  if (end <= page.offset) return false;
  const ranges = consumed.ranges;
  // Same interval merge as the audited reader, with an independent semantic
  // lifetime: a new audit ID must never reset knowledge of unchanged content.
  let start = page.offset, through = end, insertion = 0;
  while (insertion < ranges.length && ranges[insertion][1] < start) insertion++;
  if (ranges[insertion]?.[0] <= start && ranges[insertion][1] >= through) return false;
  let next = insertion;
  while (next < ranges.length && ranges[next][0] <= through) {
    start = Math.min(start, ranges[next][0]); through = Math.max(through, ranges[next][1]); next++;
  }
  ranges.splice(insertion, next - insertion, [start, through]);
  return true;
}

export function createCodeExecutionWatchdog({ startupMs, idleMs = MODEL_IDLE_MS }) {
  if (!Number.isSafeInteger(startupMs) || startupMs < 1 || startupMs > 3_600_000) throw new TypeError('Code execution startup bound is invalid');
  if (!Number.isSafeInteger(idleMs) || idleMs < MODEL_IDLE_MS || idleMs > 3_600_000) throw new TypeError('Code execution inactivity bound is invalid');
  const watchdog = Object.freeze({});
  const state = { controller: new AbortController(), idleTimer: null, hostTimer: null, idleMs, running: false, closed: false, hostActive: false, hostUseful: false, idleExpired: false, completedOperations: new Set(), sourceReads: new Map() };
  watchdogs.set(watchdog, state);
  armIdle(state, startupMs, 'STRUCTURED_PROVIDER_TIMEOUT');
  return watchdog;
}

export function codeExecutionWatchdogSignal(watchdog) { return stateFor(watchdog).controller.signal; }

export function startCodeExecutionTurn(watchdog) {
  const state = stateFor(watchdog);
  state.controller.signal.throwIfAborted();
  if (state.running || state.closed) throw new TypeError('Code execution turn already started');
  state.running = true;
  armIdle(state, state.idleMs);
}

export function reportCodeExecutionActivity(watchdog) {
  const state = stateFor(watchdog);
  if (state.running && !state.hostActive) armIdle(state, state.idleMs);
}

export function beginCodeExecutionHostOperation(watchdog, name, args) {
  const state = stateFor(watchdog);
  state.controller.signal.throwIfAborted();
  if (state.closed || state.hostActive || !['perform_action', 'edit_source', 'read_source', 'read_conflict_source', 'get_state'].includes(name)) throw new TypeError('Code execution host operation is invalid');
  state.hostActive = true;
  // Polling never suspends or refreshes model inactivity. The callback still
  // has its own bound so an unresponsive store cannot mask a hang.
  const useful = name !== 'get_state';
  state.hostUseful = useful;
  const bound = name === 'perform_action' && args?.decision?.action?.type === 'run_profile' ? PROFILE_CALLBACK_MS : HOST_CALLBACK_MS;
  state.hostTimer = setTimeout(() => state.controller.abort(failure('STRUCTURED_PROVIDER_IDLE_TIMEOUT')), bound);
  let finished = false;
  return (succeeded, result, progress) => {
    if (finished) return;
    finished = true;
    clearTimeout(state.hostTimer);
    state.hostActive = false;
    state.hostUseful = false;
    if (useful && state.running) {
      let fresh = false;
      if (succeeded) {
        try {
          if (['read_source', 'read_conflict_source'].includes(name)) {
            fresh = consumeSourceRange(state, result, progress?.sourceIdentity);
          } else if (['perform_action', 'edit_source'].includes(name) && /^[a-f0-9]{64}$/u.test(progress?.before) && /^[a-f0-9]{64}$/u.test(progress?.after)) {
            state.completedOperations.add(progress.before);
            fresh = progress.before !== progress.after && !state.completedOperations.has(progress.after);
            state.completedOperations.add(progress.after);
          }
        } catch { /* Invalid host proof supplies no consumable progress. */ }
      }
      if (fresh) armIdle(state, state.idleMs);
      else if (state.idleExpired) state.controller.abort(failure('STRUCTURED_PROVIDER_IDLE_TIMEOUT'));
    }
  };
}

export function closeCodeExecutionWatchdog(watchdog) {
  const state = stateFor(watchdog);
  state.closed = true;
  clearTimeout(state.idleTimer); clearTimeout(state.hostTimer);
}
