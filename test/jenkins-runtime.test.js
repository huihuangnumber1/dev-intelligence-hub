import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createJenkinsRuntime } from '../src/jenkins-runtime.js';
import { projectIdentityDigest } from '../src/lib/project-identity.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const input = { repository: 'acme/repo', buildUrl: 'http://jenkins.example/job/Test/1/', username: 'fixture-user', password: 'fixture-secret' };
const privateRuntimeDirectory = path.join(os.tmpdir(), 'jenkins-runtime-test', projectIdentityDigest({ projectRoot }));

test('connection verifies the actual Basic-auth build endpoint before persisting a credential', async () => {
  const order = [];
  const runtime = createJenkinsRuntime({ projectRoot, privateRuntimeDirectory,
    connectionStore: { async status() { return { configured: false }; }, async set(value) { order.push('persist'); assert.deepEqual(value, input); return { configured: true, username: value.username }; }, async acquire() {} },
    fetchImpl: async (url, options) => {
      order.push('probe'); assert.equal(url, `${input.buildUrl}api/json`); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`);
      return new Response(JSON.stringify({ number: 1, building: false }));
    },
  });
  assert.equal(Object.isFrozen(runtime.connection), true);
  const result = await runtime.connection.connect(input);
  assert.deepEqual(order, ['probe', 'persist']); assert.equal(result.state, 'available'); assert.ok(!JSON.stringify(result).includes(input.password));
});

test('failed authentication or redirected build never replaces a working stored connection', async () => {
  for (const status of [403, 302]) {
    let saves = 0;
    const runtime = createJenkinsRuntime({ projectRoot, privateRuntimeDirectory,
      connectionStore: { async status() {}, async set() { saves++; }, async acquire() {} },
      fetchImpl: async () => new Response('not an authorized build', { status, headers: { Location: 'http://other.example/' } }),
    });
    await assert.rejects(runtime.connection.connect(input), error => error.statusCode === 400 && !error.message.includes(input.password));
    assert.equal(saves, 0);
  }
});

test('Jenkins is optional when no matching project-private runtime is available', () => {
  assert.equal(createJenkinsRuntime({ projectRoot, privateRuntimeDirectory: null }), null);
  assert.equal(createJenkinsRuntime({ projectRoot, privateRuntimeDirectory: path.join(os.tmpdir(), 'unrelated') }), null);
});
