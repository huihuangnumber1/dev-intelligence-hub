import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { observePrivateDirectoryHelpers, HELPER_DIAGNOSTIC_LIMITS } from './support/private-directory-helper-diagnostics.mjs';
function fakeTransport(t) {
  const children = [], originalCalls = [];
  const original = childProcess.execFile;
  const base = (...args) => {
    originalCalls.push(args);
    const child = new EventEmitter(); child.pid = 100 + children.length; children.push(child); return child;
  };
  childProcess.execFile = base;
  syncBuiltinESMExports();
  const args = ['-EncodedCommand', Buffer.from('$env:MYDASHBOARD_PRIVATE_PATH; $acl = Get-Acl -LiteralPath private-path SID-private', 'utf16le').toString('base64')];
  const invoke = (signal, callback = () => {}) => childProcess.execFile('private-command', args, { signal }, callback);
  return { children, originalCalls, invoke, finish() { if (childProcess.execFile === base) childProcess.execFile = original; syncBuiltinESMExports(); } };
}

test('diagnostic sink failure preserves the exact operation error, byte cap, calls and listener cleanup', async t => {
  const fake = fakeTransport(t), error = new Error('private original failure');
  let sinkCalls = 0;
  const diagnostics = observePrivateDirectoryHelpers(t, { sink() { sinkCalls++; throw new Error('private sink failure'); } });
  try {
    await assert.rejects(diagnostics.run(async () => {
      for (let i = 0; i < 12; i++) {
        const child = fake.invoke(); child.emit('spawn'); child.emit('exit', 0, null); child.emit('close', 0, null);
      }
      throw error;
    }), value => value === error);
    const sample = diagnostics.finish();
    assert.equal(fake.originalCalls.length, 12);
    assert.equal(sample.helpers.length, HELPER_DIAGNOSTIC_LIMITS.helpers);
    assert.equal(sample.omittedHelpers, 4);
    assert.equal(sample.sinkFailed, true); assert.equal(sinkCalls, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(sample)) <= HELPER_DIAGNOSTIC_LIMITS.bytes);
    for (const value of ['private-command', 'private-path', 'SID-private', 'private original', 'private sink']) assert.equal(JSON.stringify(sample).includes(value), false);
    for (const child of fake.children) for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
    diagnostics.finish(); assert.equal(sinkCalls, 1);
  } finally { diagnostics.finish(); fake.finish(); }
});

test('diagnostic missing exit or close stays unknown and all listeners detach at the test boundary', async t => {
  const fake = fakeTransport(t), controller = new AbortController();
  const diagnostics = observePrivateDirectoryHelpers(t, { sink() { assert.fail('No failing operation'); } });
  try {
    const child = fake.invoke(controller.signal); child.emit('spawn');
    const sample = diagnostics.finish();
    assert.deepEqual(sample.helpers[0].missingEvents, ['exit', 'close']);
    assert.equal(sample.helpers[0].exitMs, null); assert.equal(sample.helpers[0].closeMs, null);
    for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(); child.emit('exit', 0, null); child.emit('close', 0, null);
    assert.equal(diagnostics.snapshot().helpers[0].abortMs, null);
    assert.equal(diagnostics.snapshot().helpers[0].closeMs, null, 'late events do not manufacture a stop observation');
  } finally { diagnostics.finish(); fake.finish(); }
});

test('diagnostic abort and error observers remove themselves and preserve transport callback and return identity', async t => {
  const fake = fakeTransport(t), controller = new AbortController(), callback = () => {};
  let emitted = 0;
  const diagnostics = observePrivateDirectoryHelpers(t, { sink() { emitted++; } });
  try {
    const child = fake.invoke(controller.signal, callback);
    assert.equal(child, fake.children[0]);
    assert.equal(fake.originalCalls[0].at(-1), callback);
    assert.equal(fake.originalCalls[0][2].signal, controller.signal);
    child.emit('spawn'); controller.abort(new Error('private reason'));
    child.emit('error', Object.assign(new Error('private child stderr'), { code: 'ABORT_ERR' }));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(child.listenerCount('error'), 0);
    child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
    await diagnostics.settled();
    const sample = diagnostics.finish();
    assert.equal(sample.helpers[0].abortKind, 'cancelled');
    assert.equal(sample.helpers[0].childError, 'ABORT_ERR');
    assert.deepEqual(sample.helpers[0].missingEvents, []);
    assert.equal(JSON.stringify(sample).includes('private reason'), false);
    assert.equal(JSON.stringify(sample).includes('private child'), false);
    assert.equal(emitted, 0);
    for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
  } finally { diagnostics.finish(); fake.finish(); }
});

test('diagnostic automatic test-end cleanup emits once and a throwing sink cannot change the outcome', async t => {
  const original = childProcess.execFile, controller = new AbortController();
  let fake, diagnostics, emitted = 0;
  await t.test('fixture operation fails as expected', async child => {
    fake = fakeTransport(child);
    diagnostics = observePrivateDirectoryHelpers(child, { sink() { emitted++; throw new Error('private sink failure'); } });
    child.after(() => fake.finish());
    const error = new Error('private operation failure');
    await assert.rejects(diagnostics.run(async () => { fake.invoke(controller.signal).emit('spawn'); throw error; }), value => value === error);
  });
  assert.equal(emitted, 1);
  assert.equal(childProcess.execFile, original);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  for (const event of ['spawn', 'error', 'exit', 'close']) assert.equal(fake.children[0].listenerCount(event), 0);
  assert.equal(diagnostics.finish().sinkFailed, true);
  assert.equal(emitted, 1);
});
