import { Worker } from 'bullmq';

const config = JSON.parse(process.argv[2]);
const releases = new Map();
const send = (type, detail = {}) => process.send?.({ type, ...detail });
const worker = new Worker(config.queue, async job => {
  send('started', { id: job.id, attempt: job.attemptsMade + 1, at: Date.now() });
  if (job.data.kind === 'hold' && !config.recover) {
    await new Promise(resolve => {
      releases.set(job.id, resolve);
      send('held', { id: job.id });
    });
  }
  if (job.data.kind === 'retry' && job.attemptsMade < job.data.failures) {
    throw new Error('Synthetic transient failure');
  }
  if (job.data.kind === 'effect') {
    const response = await fetch(config.effectUrl, {
      method: 'POST',
      headers: { 'idempotency-key': job.data.operationId },
      body: JSON.stringify({ synthetic: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Effect service returned ${response.status}`);
    return response.json();
  }
  return { marker: job.data.marker, synthetic: true };
}, {
  connection: config.connection,
  prefix: config.prefix,
  concurrency: 1,
  lockDuration: 800,
  stalledInterval: 200,
  maxStalledCount: 1,
});
worker.on('error', error => send('worker-error', { message: error.message }));
worker.on('stalled', id => send('stalled', { id }));
worker.on('completed', job => send('completed', { id: job.id }));
process.on('message', async message => {
  if (message.type === 'release') releases.get(message.id)?.();
  if (message.type === 'shutdown') {
    await worker.close();
    process.disconnect();
  }
});
await worker.waitUntilReady();
send('ready', { pid: process.pid });
