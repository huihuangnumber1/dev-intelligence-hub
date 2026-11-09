import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from 'node:crypto';
import {
  beginCodeExecutionSession, closeCodeExecutionContext, createCodeExecutionContext,
  isCodeExecutionContext, revokeCodeExecutionContext,
} from "../src/lib/code-execution-context.js";
import { createCodeExecutionWatchdog, codeExecutionWatchdogSignal, startCodeExecutionTurn, closeCodeExecutionWatchdog } from '../src/lib/code-execution-watchdog.js';
import { pageCodeReadText } from '../src/lib/code-read-context.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  return createCodeExecutionContext({ performAction: async (args) => args,
    readSource: async (args) => args, getState: async () => ({ revision: 1 }), ...overrides });
}

function auditedSourceFixture(t, { content = 'x'.repeat(500), identity = 'valid' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let version = 0;
  const callbacks = { readSource: async ({ offset, length }) => ({
    ...pageCodeReadText(content, { path: 'src/file.cpp' }, offset, length), sourceVersion: `audit-${++version}`,
    // Source result metadata is deliberately not proof authority.
    sha256: createHash('sha256').update(String(version)).digest('hex'),
  }) };
  if (identity !== 'missing') callbacks.sourceReadIdentity = () => ({ path: identity === 'wrong-path' ? 'src/other.cpp' : 'src/file.cpp',
    totalLength: content.length + (identity === 'wrong-length' ? 1 : 0),
    sha256: identity === 'malformed' ? 'not-a-sha' : createHash('sha256').update(content).digest('hex') });
  const session = beginCodeExecutionSession(fixture(callbacks), { watchdog });
  return { session, signal: codeExecutionWatchdogSignal(watchdog), tick: minutes => t.mock.timers.tick(minutes * 60_000),
    read: (offset, length) => session.invoke('read_source', { path: 'src/file.cpp', offset, length }),
    setContent: value => { content = value; } };
}

test("execution authority is an opaque process-private capability", async () => {
  const context = fixture();
  assert.ok(isCodeExecutionContext(context));
  assert.ok(Object.isFrozen(context));
  assert.equal(JSON.stringify(context), "{}");
  assert.equal(isCodeExecutionContext(structuredClone(context)), false);
  assert.equal(isCodeExecutionContext(null), false);
  assert.throws(() => beginCodeExecutionSession({}), { code: "CODE_EXECUTION_CONTEXT_INVALID" });
  assert.throws(() => createCodeExecutionContext({}), { code: "CODE_EXECUTION_CONTEXT_INVALID" });
  assert.throws(() => fixture({ sourceReadIdentity: { sha256: 'a'.repeat(64) } }), { code: 'CODE_EXECUTION_CONTEXT_INVALID' });
  await closeCodeExecutionContext(context);
});

test("each capability has one session lifetime and closes its host exactly once", async () => {
  let closes = 0;
  const receipt = { settled: true };
  const context = fixture({ close: async () => { closes += 1; return receipt; } });
  const session = beginCodeExecutionSession(context);
  assert.throws(() => beginCodeExecutionSession(context), { code: "CODE_EXECUTION_SESSION_ALREADY_STARTED" });
  assert.deepEqual(await session.invoke("get_state", {}), { revision: 1 });
  assert.deepEqual(await Promise.all([session.close(), closeCodeExecutionContext(context), session.close()]), [receipt, receipt, receipt]);
  assert.equal(closes, 1);
  assert.throws(() => beginCodeExecutionSession(context), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  await assert.rejects(session.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  const unopened = fixture({ close: async () => { closes += 1; } });
  await closeCodeExecutionContext(unopened);
  assert.equal(closes, 2);
  assert.throws(() => beginCodeExecutionSession(unopened), { code: "CODE_EXECUTION_SESSION_REVOKED" });
});

test("host callbacks serialize, including read and state calls after a failed action", async () => {
  const entered = deferred(), release = deferred(), calls = [];
  const context = fixture({ performAction: async () => {
    calls.push("action-start"); entered.resolve(); await release.promise;
    calls.push("action-end"); throw new Error("host failure");
  }, readSource: async () => { calls.push("read"); return "source"; },
  getState: async () => { calls.push("state"); return "state"; } });
  const session = beginCodeExecutionSession(context);
  const first = session.invoke("perform_action", {});
  const failure = assert.rejects(first, /host failure/);
  await entered.promise;
  const read = session.invoke("read_source", {}), state = session.invoke("get_state", {});
  assert.deepEqual(calls, ["action-start"]);
  release.resolve();
  await failure;
  assert.equal(await read, "source");
  assert.equal(await state, "state");
  assert.deepEqual(calls, ["action-start", "action-end", "read", "state"]);
  await session.close();
});

test("ordinary revoke denies queued work and close drains an active callback without aborting it", async () => {
  const entered = deferred(), release = deferred();
  let callbackSignal, closes = 0, stateCalls = 0, closed = false;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return { audited: true };
  }, getState: async () => { stateCalls += 1; }, close: async () => { closes += 1; } });
  const session = beginCodeExecutionSession(context);
  const active = session.invoke("perform_action", {});
  await entered.promise;
  const queued = assert.rejects(session.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  revokeCodeExecutionContext(context);
  assert.equal(callbackSignal.aborted, false);
  assert.throws(() => session.assertActive(), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  const closing = session.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(closes, 0);
  release.resolve();
  assert.deepEqual(await active, { audited: true });
  await Promise.all([queued, closing]);
  assert.equal(stateCalls, 0);
  assert.equal(closes, 1);
});

test("parent cancellation aborts the active callback but close still waits for settlement", async () => {
  const parent = new AbortController(), entered = deferred(), release = deferred();
  let callbackSignal, closed = false;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return "settled";
  } });
  const session = beginCodeExecutionSession(context, { signal: parent.signal });
  const active = session.invoke("perform_action", {});
  await entered.promise;
  parent.abort();
  assert.equal(callbackSignal.aborted, true);
  const closing = session.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await active, "settled");
  await closing;
});

test("explicit active cancellation and an already aborted parent close admissions", async () => {
  const entered = deferred(), release = deferred();
  let callbackSignal;
  const context = fixture({ performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise;
  } });
  const session = beginCodeExecutionSession(context);
  const active = session.invoke("perform_action", {});
  await entered.promise;
  session.revoke({ abortActive: true });
  assert.ok(callbackSignal.aborted);
  release.resolve(); await active; await session.close();
  const parent = new AbortController(); parent.abort();
  const already = beginCodeExecutionSession(fixture(), { signal: parent.signal });
  await assert.rejects(already.invoke("get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  await already.close();
});

test("only the three host callbacks are invokable", async () => {
  const session = beginCodeExecutionSession(fixture());
  for (const name of ["complete", "shell", "close", "constructor", "toString"]) {
    await assert.rejects(session.invoke(name, {}), { code: "CODE_EXECUTION_TOOL_NOT_ALLOWED" });
  }
  await session.close();
});

test("a failing host close remains a failing receipt without executing twice", async () => {
  let closes = 0;
  const context = fixture({ close: async () => { closes += 1; throw new Error("cannot settle host"); } });
  await assert.rejects(closeCodeExecutionContext(context), /cannot settle host/);
  await assert.rejects(closeCodeExecutionContext(context), /cannot settle host/);
  assert.equal(closes, 1);
});

test('an uncooperative host callback times out without certifying drain or invoking host close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const entered = deferred(), release = deferred(); let signal, closes = 0;
  const context = fixture({ performAction: async (_args, options) => {
    signal = options.signal; entered.resolve(); await release.promise; return { settled: true };
  }, close: async () => { closes++; return { settled: true }; } });
  const session = beginCodeExecutionSession(context, { watchdog });
  const action = session.invoke('perform_action', { decision: { action: { type: 'run_profile' } } });
  const rejected = assert.rejects(action, { code: 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' });
  await entered.promise;
  t.mock.timers.tick(40 * 60_000); await rejected;
  assert.equal(signal.aborted, true);
  await assert.rejects(session.close(), { code: 'CODE_EXECUTION_UNSETTLED' });
  assert.equal(closes, 0);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(session.invoke('get_state', {}), { code: 'CODE_EXECUTION_SESSION_REVOKED' });
});

test('an ordinary rejected host callback retains its own error under inactivity supervision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const session = beginCodeExecutionSession(fixture({ readSource: async () => { throw Object.assign(new Error('bad source'), { code: 'CODE_READ_DOCUMENT_NOT_FOUND' }); } }), { watchdog });
  await assert.rejects(session.invoke('read_source', { path: 'missing' }), { code: 'CODE_READ_DOCUMENT_NOT_FOUND' });
  assert.deepEqual(await session.invoke('get_state', {}), { revision: 1 });
  await session.close();
});

test('slow but valid authority and audit work can exceed sixty seconds before settling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const entered = deferred(), release = deferred(); let materialProgress = 0, signal;
  const session = beginCodeExecutionSession(fixture({ progressFingerprint: async () => String(materialProgress).repeat(64),
    performAction: async (_args, options) => { signal = options.signal; entered.resolve(); await release.promise; materialProgress = 1; return { audited: true }; } }), { watchdog });
  const running = session.invoke('perform_action', { decision: { action: { type: 'read_text', path: 'src/large.cpp' } } });
  await entered.promise;
  t.mock.timers.tick(20 * 60_000);
  assert.equal(signal.aborted, false, 'host authority overhead is independently bounded and can outlast model silence');
  release.resolve(); assert.deepEqual(await running, { audited: true });
  assert.equal(codeExecutionWatchdogSignal(watchdog).aborted, false);
  await session.close();
});

test('changing action IDs, rationale and clocks cannot turn a first or repeated no-op into progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let calls = 0;
  const session = beginCodeExecutionSession(fixture({ progressFingerprint: async () => 'a'.repeat(64),
    performAction: async () => ({ turn: ++calls, actionId: `action-${calls}`, updatedAt: `${calls}`, result: 'same bytes' }) }), { watchdog });
  for (let index = 0; index < 15; index++) {
    t.mock.timers.tick(60_000 - 1);
    await session.invoke('perform_action', { decision: { summary: `new rationale ${index}`, action: { type: 'read_text', path: 'src/unchanged.cpp' } } });
  }
  t.mock.timers.tick(15);
  assert.equal(codeExecutionWatchdogSignal(watchdog).reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await session.close();
});

test('identical source bytes with new source versions and request metadata do not renew inactivity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let version = 0;
  const session = beginCodeExecutionSession(fixture({ sourceReadIdentity: () => ({ path: 'src/unchanged.cpp', totalLength: 10,
    sha256: createHash('sha256').update('same bytes').digest('hex') }), readSource: async () => ({ path: 'src/unchanged.cpp', offset: 0, nextOffset: null,
    totalLength: 10, text: 'same bytes', sourceVersion: `audit-${++version}`, timestamp: version }) }), { watchdog });
  await session.invoke('read_source', { path: 'src/unchanged.cpp', offset: 0 });
  for (let index = 0; index < 14; index++) {
    t.mock.timers.tick(60_000);
    await session.invoke('read_source', { path: 'src/unchanged.cpp', offset: 0, sourceVersion: `audit-${version}` });
  }
  t.mock.timers.tick(60_000);
  assert.equal(codeExecutionWatchdogSignal(watchdog).reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await session.close();
});

test('a delayed progress read cannot start an action after watchdog revocation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const entered = deferred(), release = deferred(); let actions = 0;
  const session = beginCodeExecutionSession(fixture({ progressFingerprint: async () => {
    entered.resolve(); await release.promise; return 'a'.repeat(64);
  }, performAction: async () => { actions++; } }), { watchdog });
  const running = session.invoke('perform_action', { decision: { action: { type: 'write_text', path: 'src/file.cpp', content: 'x' } } });
  const rejected = assert.rejects(running, { code: 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' });
  await entered.promise; t.mock.timers.tick(30 * 60_000); await rejected;
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0); await session.close();
});

test('new non-overlapping source ranges renew activity with trusted content identity', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 100); f.tick(14); await f.read(100, 100);
  f.tick(14); assert.equal(f.signal.aborted, false);
  f.tick(1); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('known overlapping ranges cannot renew activity by changing page boundaries or audit nonce', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 300); f.tick(10); await f.read(50, 200);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('partially overlapping reads renew only when their union includes new source bytes', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 100); f.tick(10); await f.read(50, 100);
  f.tick(10); assert.equal(f.signal.aborted, false); await f.read(125, 75);
  f.tick(10); await f.read(0, 200);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('a bridge read merges disjoint consumed ranges without granting later reframing progress', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 100); await f.read(200, 100);
  f.tick(10); await f.read(50, 200);
  f.tick(10); assert.equal(f.signal.aborted, false); await f.read(0, 300);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('changed audited content can renew at the same path and range', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 500); f.tick(10); f.setContent('y'.repeat(500)); await f.read(0, 500);
  f.tick(10); assert.equal(f.signal.aborted, false);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

for (const identity of ['missing', 'malformed', 'wrong-path', 'wrong-length']) test(`${identity} host source proof cannot be replaced by model or tool-result SHA metadata`, async t => {
  const f = auditedSourceFixture(t, { identity });
  await f.read(0, 100); f.tick(10);
  await f.session.invoke('read_source', { path: 'src/file.cpp', offset: 100, length: 100, sha256: 'a'.repeat(64) });
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('source coverage uses reader UTF-16 ranges without recounting an emoji through new framing', async t => {
  const f = auditedSourceFixture(t, { content: '🙂'.repeat(250) });
  assert.equal((await f.read(0, 1)).text.length, 2);
  f.tick(10); await f.read(2, 1);
  f.tick(10); assert.equal(f.signal.aborted, false); await f.read(0, 3);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('returning to already consumed content cannot reset coverage with a new audit identity', async t => {
  const f = auditedSourceFixture(t);
  await f.read(0, 500); f.tick(10); f.setContent('y'.repeat(500)); await f.read(0, 500);
  f.tick(10); f.setContent('x'.repeat(500)); await f.read(100, 100);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('an empty audited file is consumed once despite new source-version metadata', async t => {
  const f = auditedSourceFixture(t, { content: '' });
  await f.read(0, 100); f.tick(10); await f.read(0, 200);
  f.tick(5); assert.equal(f.signal.reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await f.session.close();
});

test('a late source identity callback cannot renew activity after owner cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const entered = deferred(), release = deferred(), parent = new AbortController();
  const session = beginCodeExecutionSession(fixture({
    readSource: async () => ({ path: 'src/file.cpp', offset: 0, nextOffset: null, totalLength: 1, text: 'x' }),
    sourceReadIdentity: async () => { entered.resolve(); await release.promise;
      return { path: 'src/file.cpp', totalLength: 1, sha256: createHash('sha256').update('x').digest('hex') }; },
  }), { watchdog, signal: parent.signal });
  t.mock.timers.tick(14 * 60_000);
  const reading = session.invoke('read_source', { path: 'src/file.cpp', offset: 0 });
  await entered.promise; parent.abort(); release.resolve(); await reading;
  t.mock.timers.tick(60_000);
  assert.equal(codeExecutionWatchdogSignal(watchdog).reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
  await assert.rejects(session.invoke('read_source', {}), { code: 'CODE_EXECUTION_SESSION_REVOKED' });
  await session.close();
});

test('an uncooperative source identity callback retains the host deadline and unsettled drain gate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  const entered = deferred(), release = deferred(); let closes = 0;
  const session = beginCodeExecutionSession(fixture({
    readSource: async () => ({ path: 'src/file.cpp', offset: 0, nextOffset: null, totalLength: 1, text: 'x' }),
    sourceReadIdentity: async () => { entered.resolve(); await release.promise;
      return { path: 'src/file.cpp', totalLength: 1, sha256: createHash('sha256').update('x').digest('hex') }; },
    close: async () => { closes++; return { settled: true }; },
  }), { watchdog });
  const reading = session.invoke('read_source', { path: 'src/file.cpp', offset: 0 });
  const rejected = assert.rejects(reading, { code: 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' });
  await entered.promise; t.mock.timers.tick(30 * 60_000); await rejected;
  await assert.rejects(session.close(), { code: 'CODE_EXECUTION_UNSETTLED' });
  assert.equal(closes, 0);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(session.invoke('read_source', {}), { code: 'CODE_EXECUTION_SESSION_REVOKED' });
});
