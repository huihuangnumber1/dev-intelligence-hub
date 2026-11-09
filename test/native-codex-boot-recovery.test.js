import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { reconcileNativeBootRecovery } from '../src/adapters/native-codex-boot-recovery.js';
import { readUnknownNativeInvocations } from '../src/adapters/native-codex-marker-identity.js';

const prefix = `active-${'a'.repeat(64)}`;
const oldBoot = { schemaVersion: 1, machineDigest: 'b'.repeat(64), startedAt: '2026-10-31T00:00:00.000Z', recordId: 10, uptimeMs: 300_000_000 };
const newBoot = { ...oldBoot, startedAt: '2026-11-05T00:00:00.000Z', recordId: 20, uptimeMs: 120_000 };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-boot-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let now = Date.parse('2026-11-04T10:00:00Z');
  const invocation = `invocation-${randomUUID()}`;
  await mkdir(path.join(root, invocation));
  const marker = path.join(root, `${prefix}-${randomUUID()}.json`);
  const bytes = JSON.stringify({ schemaVersion: 2, invocation, createdAt: now - 60_000, entity: 'c'.repeat(64) });
  await writeFile(marker, bytes);
  const run = async (bootIdentity, overrides = {}) => reconcileNativeBootRecovery({
    root, prefix, entries: await readUnknownNativeInvocations({ root, prefix, clock: () => now }),
    bootIdentity, clock: () => now, ...overrides,
  });
  return { root, marker, bytes, run, advance: () => { now = Date.parse('2026-11-05T00:02:00Z'); } };
}

test('same Windows boot only seals unknown markers and never frees them', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(oldBoot)).recovered.length, 0);
  const files = await readdir(f.root);
  const snapshot = files.find(name => name.startsWith('boot-quarantine-'));
  assert.ok(snapshot);
  const before = await readFile(path.join(f.root, snapshot), 'utf8');
  assert.equal((await f.run(oldBoot)).recovered.length, 0);
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
  assert.equal(await readFile(path.join(f.root, snapshot), 'utf8'), before);
});

test('a sealed same-machine new Windows boot archives original bytes with a separate receipt', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  f.advance();
  const result = await f.run(newBoot);
  assert.equal(result.recovered.length, 1);
  const recovered = result.recovered[0];
  assert.equal(await readFile(recovered.archive, 'utf8'), f.bytes);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  const receipt = JSON.parse(await readFile(recovered.receipt, 'utf8'));
  assert.equal(receipt.reason, 'windows_boot_changed_after_quarantine');
  assert.equal(receipt.previousBoot.startedAt, oldBoot.startedAt);
  assert.equal(receipt.currentBoot.startedAt, newBoot.startedAt);
  assert.equal(Object.hasOwn(receipt, 'stopConfirmed'), false);
  assert.equal((await f.run(newBoot)).recovered.length, 1);
});

for (const [name, boot] of Object.entries({
  'wall-clock correction in the same boot': { ...newBoot, uptimeMs: oldBoot.uptimeMs + 1000 },
  'a changed log record without a new boot time': { ...newBoot, startedAt: oldBoot.startedAt },
  'a reused log record': { ...newBoot, recordId: oldBoot.recordId },
  'an uptime too close to the sealed uptime': { ...newBoot, uptimeMs: oldBoot.uptimeMs - 500 },
  'a boot predating the seal': { ...newBoot, startedAt: '2026-11-04T09:59:00.000Z' },
})) {
  test(`${name} cannot release a quarantined invocation`, async t => {
    const f = await fixture(t);
    await f.run(oldBoot);
    f.advance();
    assert.equal((await f.run(boot)).recovered.length, 0);
    assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
  });
}

test('a different machine leaves an existing quarantine blocked', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  f.advance();
  await assert.rejects(f.run({ ...newBoot, machineDigest: 'd'.repeat(64) }), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
});

test('changed marker bytes cannot borrow a previous boot seal', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  await writeFile(f.marker, `${f.bytes}\n`);
  f.advance();
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(f.marker, 'utf8'), `${f.bytes}\n`);
});

test('a missing sealed marker cannot be dropped and later resealed with different bytes', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  const name = (await readdir(f.root)).find(value => value.startsWith('boot-quarantine-'));
  const snapshot = path.join(f.root, name);
  const sealed = await readFile(snapshot, 'utf8');
  await rename(f.marker, `${f.marker}.missing`);
  await assert.rejects(f.run(oldBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(snapshot, 'utf8'), sealed);
  await writeFile(f.marker, `${f.bytes}\n`);
  await assert.rejects(f.run(oldBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  f.advance();
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
});

test('a crash after the receipt but before archive resumes the same bound recovery', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  f.advance();
  await assert.rejects(f.run(newBoot, { renameMarker: async () => { throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); } }), { code: 'EIO' });
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
  const before = (await readdir(f.root)).filter(name => name.startsWith('boot-recovery-'));
  assert.equal(before.length, 1);
  assert.equal((await f.run(newBoot, { renameMarker: rename })).recovered.length, 1);
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('boot-recovery-')), before);
});

test('a lost archive acknowledgement is recovered from the bound receipt and original archived bytes', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  f.advance();
  await assert.rejects(f.run(newBoot, { renameMarker: async (...args) => {
    await rename(...args);
    throw Object.assign(new Error('lost rename acknowledgement'), { code: 'EIO' });
  } }), { code: 'EIO' });
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  const recovered = await f.run(newBoot);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(await readFile(recovered.recovered[0].archive, 'utf8'), f.bytes);
});

test('corrupt quarantine records are rejected without overwriting or resealing them', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  const name = (await readdir(f.root)).find(value => value.startsWith('boot-quarantine-'));
  const file = path.join(f.root, name);
  await writeFile(file, '{"schemaVersion":1,"schemaVersion":2}');
  f.advance();
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(file, 'utf8'), '{"schemaVersion":1,"schemaVersion":2}');
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
});

for (const bytes of ['null', 'false', '0', '""']) {
  for (const kind of ['quarantine', 'receipt']) test(`invalid ${kind} JSON ${bytes} is preserved`, async t => {
    const f = await fixture(t);
    await f.run(oldBoot);
    if (kind === 'receipt') {
      f.advance();
      await assert.rejects(f.run(newBoot, { renameMarker: async () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); } }), { code: 'EIO' });
    }
    const name = (await readdir(f.root)).find(value => value.startsWith(kind === 'quarantine' ? 'boot-quarantine-' : 'boot-recovery-'));
    const file = path.join(f.root, name);
    await writeFile(file, bytes);
    f.advance();
    await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
  });
}

test('a receipt bound to a different marker cannot authorize archive', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  f.advance();
  await assert.rejects(f.run(newBoot, { renameMarker: async () => { throw Object.assign(new Error('stop'), { code: 'EIO' }); } }), { code: 'EIO' });
  const name = (await readdir(f.root)).find(value => value.startsWith('boot-recovery-'));
  const file = path.join(f.root, name);
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  receipt.marker.digest = 'd'.repeat(64);
  await writeFile(file, JSON.stringify(receipt));
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
});

test('an existing archive file is preserved and does not remove the active marker', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  await mkdir(path.join(f.root, 'recovered-invocations'));
  const archive = path.join(f.root, 'recovered-invocations', path.basename(f.marker));
  await writeFile(archive, 'owner data');
  f.advance();
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(archive, 'utf8'), 'owner data');
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
});

test('recovery rejects an archive directory junction instead of following it', async t => {
  const f = await fixture(t);
  await f.run(oldBoot);
  const outside = path.join(f.root, 'owner-directory');
  await mkdir(outside);
  await writeFile(path.join(outside, 'owner.txt'), 'owner data');
  try { await symlink(outside, path.join(f.root, 'recovered-invocations'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('directory links unavailable'); return; } throw error; }
  f.advance();
  await assert.rejects(f.run(newBoot), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
  assert.equal(await readFile(path.join(outside, 'owner.txt'), 'utf8'), 'owner data');
  assert.equal(await readFile(f.marker, 'utf8'), f.bytes);
});
