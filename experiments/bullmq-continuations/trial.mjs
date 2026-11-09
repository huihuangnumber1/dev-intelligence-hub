import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Queue, QueueEvents } from 'bullmq';

const exec = promisify(execFile);
const runId = randomUUID();
const container = `bullmq-trial-${runId}`;
const prefix = `trial-${runId}`;
const image = 'redis:7.4.2-alpine@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952';
const children = [];
const queues = [];
const events = [];
const observations = [];
const cleanupErrors = [];
let connection;
let service;
let failed = false;

async function docker(...args) {
  return (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

// Retain observations before subscribing: a fast IPC/event cannot outrun its assertion.
function mailbox(emitter, event) {
  const history = [];
  emitter.on(event, value => history.push(value));
  return {
    history,
    wait(predicate, label, timeout = 12_000) {
      const existing = history.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off(event, listener);
          reject(new Error(`Timed out: ${label}; observed ${JSON.stringify(history)}`));
        }, timeout);
        function listener(value) {
          if (!predicate(value)) return;
          clearTimeout(timer);
          emitter.off(event, listener);
          resolve(value);
        }
        emitter.on(event, listener);
      });
    },
  };
}

async function queue(name) {
  const q = new Queue(name, { connection, prefix });
  const event = new QueueEvents(name, { connection, prefix });
  queues.push(q);
  events.push(event);
  await Promise.all([q.waitUntilReady(), event.waitUntilReady()]);
  return { q, event };
}

async function worker(q, extra = {}) {
  const child = fork(new URL('./worker.mjs', import.meta.url), [JSON.stringify({
    queue: q.name, connection, prefix, ...extra,
  })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.output = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  child.messages = mailbox(child, 'message');
  children.push(child);
  await child.messages.wait(message => message.type === 'ready', 'worker ready');
  return child;
}

async function stop(child, crash = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (crash) child.kill('SIGKILL');
  else child.send({ type: 'shutdown' });
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error(`Worker did not exit: ${child.output}`)), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (!crash) assert.equal(child.exitCode, 0, child.output);
}

function completion(job, event) {
  return job.waitUntilFinished(event, 12_000);
}

function passed(scenario, detail) {
  observations.push({ scenario, passed: true, ...detail });
  console.log(JSON.stringify(observations.at(-1)));
}

async function effectService() {
  const commits = new EventEmitter();
  const committed = mailbox(commits, 'commit');
  const records = new Map();
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      const operationId = request.headers['idempotency-key'];
      assert.equal(request.method, 'POST');
      assert.equal(typeof operationId, 'string');
      const existing = records.get(operationId);
      if (existing) {
        existing.requests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(existing.receipt));
        return;
      }
      const receipt = { operationId, effectNumber: records.size + 1 };
      records.set(operationId, { requests: 1, receipt });
      commits.emit('commit', { operationId });
      // Commit is real; deliberately lose the first acknowledgement. The controller
      // kills the worker only after this server-side handshake.
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, records, committed, url: `http://127.0.0.1:${server.address().port}/effect` };
}

try {
  await docker('version', '--format', '{{.Server.Version}}');
  await docker('run', '-d', '--name', container, '--label', `bullmq-trial=${runId}`,
    '--publish', '127.0.0.1::6379', image, 'redis-server',
    '--appendonly', 'yes', '--appendfsync', 'always', '--maxmemory-policy', 'noeviction');
  const published = JSON.parse(await docker('inspect', container, '--format', '{{json .NetworkSettings.Ports}}'));
  const endpoint = published['6379/tcp'][0];
  assert.equal(endpoint.HostIp, '127.0.0.1');
  connection = { host: '127.0.0.1', port: Number(endpoint.HostPort), db: 0, maxRetriesPerRequest: null };
  const readyDeadline = Date.now() + 10_000;
  while (true) {
    try {
      if (await docker('exec', container, 'redis-cli', 'ping') === 'PONG') break;
    } catch (error) {
      if (Date.now() >= readyDeadline) throw error;
    }
    assert.ok(Date.now() < readyDeadline, 'Redis readiness deadline');
    await delay(50);
  }
  const redisVersion = await docker('exec', container, 'redis-server', '--version');
  console.log(JSON.stringify({ runId, node: process.version, bullmq: '6.3.19', ioredis: '6.0.0', redisVersion, image, endpoint }));

  // Persisted queued intent is read through a fresh producer after the old worker
  // and original producer are gone. Global pause makes the restart causal.
  {
    const { q, event } = await queue('restart');
    await q.pause();
    const first = await worker(q);
    const job = await q.add('continue-role', { marker: runId, kind: 'echo', synthetic: true });
    assert.equal(await job.getState(), 'waiting');
    await stop(first, true);
    await q.close();
    const { q: reopened } = await queue('restart');
    const persisted = await reopened.getJob(job.id);
    assert.equal(persisted.data.marker, runId);
    assert.equal(await persisted.getState(), 'waiting');
    const replacement = await worker(reopened);
    const done = completion(persisted, event);
    await reopened.resume();
    assert.deepEqual(await done, { marker: runId, synthetic: true });
    await stop(replacement);
    passed('queued intent survives worker/producer restart', { jobId: job.id, marker: runId });
  }

  {
    const { q, event } = await queue('dedup');
    const child = await worker(q);
    const original = await q.add('continue-role', { kind: 'hold', marker: 'original' },
      { jobId: 'first', deduplication: { id: 'same-role-intent' } });
    await child.messages.wait(message => message.type === 'held' && message.id === original.id, 'original active');
    assert.equal(await original.getState(), 'active');
    const duplicate = await q.add('continue-role', { kind: 'echo', marker: 'duplicate' },
      { jobId: 'second', deduplication: { id: 'same-role-intent' } });
    assert.equal(duplicate.id, original.id);
    assert.equal(await q.getJob('second'), undefined);
    const counts = await q.getJobCounts('active', 'waiting');
    assert.deepEqual(counts, { active: 1, waiting: 0 });
    const done = completion(original, event);
    child.send({ type: 'release', id: original.id });
    assert.equal((await done).marker, 'original');
    await stop(child);
    assert.equal(child.messages.history.filter(message => message.type === 'started').length, 1);
    passed('duplicate suppressed while active', { original: original.id, returnedId: duplicate.id, counts });
  }

  {
    const { q, event } = await queue('retry');
    const child = await worker(q);
    const options = { attempts: 3, backoff: { type: 'fixed', delay: 250 } };
    const transient = await q.add('continue-role', { kind: 'retry', failures: 2, marker: 'retried' }, options);
    assert.equal((await completion(transient, event)).marker, 'retried');
    const exhausted = await q.add('continue-role', { kind: 'retry', failures: 99 }, options);
    await assert.rejects(completion(exhausted, event), /Synthetic transient failure/);
    assert.equal(await exhausted.getState(), 'failed');
    assert.equal((await q.getJob(exhausted.id)).attemptsMade, 3);
    await stop(child);
    const timings = [];
    for (const job of [transient, exhausted]) {
      const starts = child.messages.history.filter(message => message.type === 'started' && message.id === job.id);
      assert.deepEqual(starts.map(start => start.attempt), [1, 2, 3]);
      const intervals = starts.slice(1).map((start, index) => start.at - starts[index].at);
      intervals.forEach(interval => assert.ok(interval >= 235 && interval < 12_000, `retry delay ${interval}`));
      timings.push({ jobId: job.id, intervals });
    }
    passed('fixed backoff and bounded retries', { attempts: 3, backoffMs: 250, timings });
  }

  {
    const { q, event } = await queue('stalled');
    const lost = await worker(q);
    const job = await q.add('continue-role', { kind: 'hold', marker: 'recovered' });
    await lost.messages.wait(message => message.type === 'held' && message.id === job.id, 'lost worker holding lock');
    await stop(lost, true);
    assert.equal(await job.getState(), 'active');
    const replacement = await worker(q, { recover: true });
    assert.equal((await completion(job, event)).marker, 'recovered');
    await replacement.messages.wait(message => message.type === 'stalled' && message.id === job.id, 'stalled event');
    const persisted = await q.getJob(job.id);
    assert.equal(persisted.stalledCounter, 1);
    await stop(replacement);
    passed('hard worker loss recovered by stalled detection', { jobId: job.id, stalledCounter: persisted.stalledCounter });
  }

  {
    const slow = await queue('role-slow');
    const fast = await queue('role-fast');
    const slowWorker = await worker(slow.q);
    const fastWorker = await worker(fast.q);
    const blocked = await slow.q.add('continue-role', { kind: 'hold', marker: 'slow' });
    await slowWorker.messages.wait(message => message.type === 'held' && message.id === blocked.id, 'slow role held');
    const quick = await fast.q.add('continue-role', { kind: 'echo', marker: 'fast' });
    assert.equal((await completion(quick, fast.event)).marker, 'fast');
    assert.equal(await blocked.getState(), 'active');
    const done = completion(blocked, slow.event);
    slowWorker.send({ type: 'release', id: blocked.id });
    assert.equal((await done).marker, 'slow');
    await Promise.all([stop(slowWorker), stop(fastWorker)]);
    passed('slow role isolated by separate queue/process', { fastCompletedWhileSlowActive: true });
  }

  {
    service = await effectService();
    const { q, event } = await queue('effect');
    const lost = await worker(q, { effectUrl: service.url });
    const operationId = `synthetic-effect-${runId}`;
    const job = await q.add('continue-role', { kind: 'effect', operationId });
    await service.committed.wait(commit => commit.operationId === operationId, 'external effect committed without acknowledgement');
    assert.equal(service.records.size, 1);
    assert.equal(service.records.get(operationId).requests, 1);
    assert.equal(await job.getState(), 'active');
    await stop(lost, true);
    const replacement = await worker(q, { effectUrl: service.url });
    const receipt = await completion(job, event);
    await replacement.messages.wait(message => message.type === 'stalled' && message.id === job.id, 'effect job stalled event');
    assert.deepEqual(receipt, { operationId, effectNumber: 1 });
    assert.equal(service.records.get(operationId).requests, 2);
    assert.equal(service.records.size, 1);
    assert.equal((await q.getJob(job.id)).stalledCounter, 1);
    await stop(replacement);
    passed('idempotent external effect after crash before acknowledgement', {
      requests: service.records.get(operationId).requests, effects: service.records.size, receipt,
    });
  }
  for (const child of children) {
    assert.deepEqual(child.messages.history.filter(message => message.type === 'worker-error'), [], child.output);
  }
  assert.equal(observations.length, 6);
} catch (error) {
  failed = true;
  console.error(error.stack);
} finally {
  for (const child of children) {
    try { await stop(child, true); } catch (error) { cleanupErrors.push(error.message); }
  }
  for (const client of [...events, ...queues]) {
    try { await client.close(); } catch (error) { cleanupErrors.push(error.message); }
  }
  if (service) {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
  }
  try {
    const owner = await docker('inspect', container, '--format', '{{index .Config.Labels "bullmq-trial"}}');
    assert.equal(owner, runId, 'cleanup requires exact ownership label');
    await docker('rm', '-f', '-v', container);
    const remaining = await docker('ps', '-aq', '--filter', `label=bullmq-trial=${runId}`);
    assert.equal(remaining, '', 'owned container removed');
  } catch (error) {
    cleanupErrors.push(error.message);
  }
  console.log(JSON.stringify({ cleanup: cleanupErrors.length ? 'FAILED' : 'passed', cleanupErrors,
    workersExited: children.every(child => child.exitCode !== null || child.signalCode !== null),
    passedScenarios: observations.length }));
  if (failed || cleanupErrors.length) process.exitCode = 1;
}
