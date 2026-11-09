import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from '../../src/lib/private-directory-manager.js';
import { observePrivateDirectoryHelpers } from '../support/private-directory-helper-diagnostics.mjs';

async function probe(t, cancelAtSpawn) {
  const parent = await mkdtemp(path.join(tmpdir(), 'acl-abort-diagnostic-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'runtime'), controller = new AbortController();
  const original = childProcess.execFile;
  const actualChildren = [];
  let helperFailure = null;
  const outer = function (...args) {
    const callback = args.at(-1);
    const child = Reflect.apply(original, this, [...args.slice(0, -1), function (...result) {
      helperFailure = result[0];
      return Reflect.apply(callback, this, result);
    }]);
    actualChildren.push(child);
    if (cancelAtSpawn) child.once('spawn', () => queueMicrotask(() => controller.abort()));
    return child;
  };
  childProcess.execFile = outer;
  syncBuiltinESMExports();
  const emitted = [];
  const diagnostics = observePrivateDirectoryHelpers(t, { sink: value => { emitted.push(value); t.diagnostic(value); } });
  try {
    await diagnostics.run(() => assert.rejects(PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare({ directory: root,
      signal: cancelAtSpawn ? controller.signal : AbortSignal.timeout(10_000), validateLocation: async () => {} }),
    error => helperFailure ? error === helperFailure && error.code === 'ABORT_ERR'
      : error.code === 'STRUCTURED_PROVIDER_UNAVAILABLE'));
    await diagnostics.settled();
    const sample = diagnostics.finish();
    assert.equal(sample.helpers.length, 1);
    const record = sample.helpers[0];
    assert.equal(record.phase, 'acl-read');
    assert.equal(record.pid, actualChildren[0].pid);
    assert.deepEqual(record.missingEvents, []);
    assert.ok(record.launchMs <= record.spawnMs && record.spawnMs <= record.exitMs && record.exitMs <= record.closeMs);
    assert.equal(record.abortKind, cancelAtSpawn ? 'cancelled' : helperFailure ? 'timeout' : null);
    assert.equal(record.childError, helperFailure ? 'ABORT_ERR' : null);
    assert.ok(record.closeLoad.rssBytes > 0 && record.closeLoad.hostFreeBytes > 0);
    assert.equal(emitted.length, 0, 'successful assertions produce no diagnostic output');
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    if (process.env.DIH_TEST_HELPER_DIAGNOSTIC_SAMPLES === '1') t.diagnostic(JSON.stringify({ observedOutcome: helperFailure ? record.abortKind : 'normal-completed', ...sample }));
  } finally {
    diagnostics.finish(); if (childProcess.execFile === outer) childProcess.execFile = original; syncBuiltinESMExports();
  }
}

test('diagnostic real ACL helper cancellation after spawn fails closed and confirms child exit', { timeout: 15_000 }, t => probe(t, true));
test('diagnostic ordinary ACL helper retains its refusal and records real child exit without changing ACL', { timeout: 15_000 }, t => probe(t, false));
