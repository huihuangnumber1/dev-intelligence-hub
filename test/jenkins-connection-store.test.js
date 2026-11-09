import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JenkinsConnectionStore } from '../src/services/jenkins-connection-store.js';
import { WindowsDpapi } from '../src/lib/windows-dpapi.js';

const input = { repository: 'acme/repo', buildUrl: 'http://jenkins.example/job/QuickTest/123/', username: 'fixture-user', password: 'fixture-private-password' };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jenkins-credentials-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'jenkins-credentials-v1');
  const key = randomBytes(32); let decrypts = 0;
  const protector = {
    async protect(bytes, entropy) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(entropy);
      const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async unprotect(bytes, entropy) {
      decrypts++; const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(entropy); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
  const options = { directory, projectDigest: 'a'.repeat(64), protector, privateDirectoryManager: { async prepare({ directory, validateLocation }) {
    validateLocation(); await mkdir(directory, { recursive: true }); const stat = await lstat(directory, { bigint: true });
    return { path: directory, device: stat.dev.toString(), inode: stat.ino.toString() };
  } } };
  return { root, directory, options, create: () => new JenkinsConnectionStore(options), decrypts: () => decrypts };
}

test('connection survives restart with ciphertext only and public status never includes a password', async t => {
  const f = await fixture(t), store = f.create();
  assert.deepEqual(await store.status(), { configured: false });
  const status = await store.set(input);
  assert.equal(status.configured, true); assert.equal('password' in status, false);
  const bytes = await readFile(path.join(f.directory, 'connection.json'), 'utf8');
  assert.ok(!bytes.includes(input.password));
  assert.ok(!bytes.includes(Buffer.from(input.password).toString('base64')));
  const restarted = f.create();
  const request = { repository: input.repository, buildUrl: input.buildUrl.replace('123/', '124/') };
  assert.equal((await restarted.acquire(request)).password, input.password);
  await restarted.acquire(request);
  assert.equal(f.decrypts(), 1, 'cached secrets avoid repeated decryption subprocesses');
});

test('repository, origin and job restrictions apply before any credential is decrypted', async t => {
  const f = await fixture(t), store = f.create(); await store.set(input);
  for (const request of [{ repository: 'other/repo', buildUrl: input.buildUrl },
    { repository: input.repository, buildUrl: 'http://other.example/job/QuickTest/123/' },
    { repository: input.repository, buildUrl: 'http://jenkins.example/job/Secret/123/' }]) {
    await assert.rejects(store.acquire(request), { code: 'JENKINS_CONNECTION_UNAVAILABLE' });
  }
  assert.equal(f.decrypts(), 0);
});

test('tampered ciphertext or a different project cannot return a cached credential', async t => {
  const f = await fixture(t), store = f.create(); await store.set(input);
  await store.acquire(input);
  const file = path.join(f.directory, 'connection.json'), record = JSON.parse(await readFile(file, 'utf8'));
  record.ciphertext = Buffer.alloc(100, 1).toString('base64'); await writeFile(file, JSON.stringify(record));
  await assert.rejects(store.acquire(input), { code: 'JENKINS_CONNECTION_UNAVAILABLE' });
  await assert.rejects(new JenkinsConnectionStore({ ...f.options, projectDigest: 'b'.repeat(64) }).acquire(input), { code: 'JENKINS_CONNECTION_UNAVAILABLE' });
});

test('real Windows DPAPI protects and authenticates fixture credentials using only helper pipes', { skip: process.platform !== 'win32' }, async () => {
  const protector = new WindowsDpapi(), plain = Buffer.from('fixture-password-not-a-real-credential'), entropy = randomBytes(32);
  const cipher = await protector.protect(plain, entropy);
  assert.ok(!cipher.includes(plain));
  assert.deepEqual(await protector.unprotect(cipher, entropy), plain);
  await assert.rejects(protector.unprotect(cipher, randomBytes(32)), { code: 'DPAPI_OPERATION_FAILED' });
});
