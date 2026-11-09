# BullMQ role continuation experiment

An optional integration experiment for durable queued role intent. It runs real BullMQ workers as native Node child processes against one disposable Redis container. It does not import the dashboard, change its scheduler, or join its default tests. All job data and HTTP effects are synthetic. No GitHub API, credentials, PRs, or production data are used.

## Run manually

Requires Node 22 or newer, npm, and an already running Docker daemon that supports Linux containers. Run from this directory, using PowerShell on Windows:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run trial
```

On other shells use `npm` in place of `npm.cmd`. A cold run downloads the pinned Redis image. The script prints JSON evidence and exits with code 0 only after every scenario and cleanup succeeds. It owns its container automatically; do not point it at an existing Redis instance. No global package installation is needed.

Versions were resolved from actual npm metadata: [BullMQ 6.3.19](https://registry.npmjs.org/bullmq/6.3.19) and [ioredis 6.0.0](https://registry.npmjs.org/ioredis/6.0.0). Both are exact dependencies in this private package and all transitive packages are locked. BullMQ v6 declares ioredis as an optional peer, so this experiment installs it explicitly. Redis is `7.4.2-alpine`, pinned to the official image digest `sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952`.

## Observed scenarios

| Scenario | Assertion against actual behavior |
| --- | --- |
| Queued intent survives worker/producer restart | Pause queue, enqueue a unique marker, kill the original worker, close the producer, reopen it, read the same waiting payload from Redis, then start a replacement and complete it. |
| Duplicate suppression while active | Hold the original processor using IPC, add a different job ID with the same deduplication ID, observe that BullMQ returns the original ID, the duplicate ID does not exist, only one job is active, and only one processor invocation occurs. |
| Retry with bounded backoff | Observe three actual invocations after transient errors, with fixed 250 ms backoff. A separate always-failing job reaches failed state after exactly three attempts. Both completion and retry timestamps are checked. |
| Worker loss / stalled recovery | Kill a worker while its held job is active. A replacement must emit the stalled event and complete that same job; Redis must record exactly one stalled recovery. |
| Slow role isolation | Hold one role's processor in a separate queue/process. Another role completes before the held role is released, while the first job remains active. |
| Idempotent effect after lost acknowledgement | A loopback HTTP service commits an effect but holds its response. After the server-side commit handshake, kill the worker. Stalled recovery sends the same operation ID again; the service returns its existing receipt. Assert two real HTTP requests, one committed effect, and a completed queue job. |

IPC handshakes determine when jobs are held or killed. Queue completion uses BullMQ events with 12-second deadlines, rather than a fixed sleep. Only Redis startup readiness polls with a short delay. The fixed retry intervals may exceed 250 ms because execution is scheduled; assertions allow scheduling overhead while imposing a deadline.

The experiment intentionally uses short lock durations (800 ms) and stalled intervals (200 ms), with `maxStalledCount: 1`. These are test settings, not proposed production settings.

## Isolation and cleanup

Every run generates a UUID for its container name, ownership label, and queue prefix. Redis publishes only to `127.0.0.1` on a Docker-assigned port; the client explicitly uses that endpoint and DB 0. The HTTP service also binds only to loopback. No existing queues are opened or cleared.

The `finally` block kills any remaining owned worker processes, closes queue/event clients and HTTP connections, checks the exact container ownership label, removes only that container and its anonymous volumes, and verifies no container with that run's label remains. It never runs Redis `FLUSHDB`, deletes other queues, or reconfigures Docker. Cached image layers and this directory's ignored `node_modules` remain available for another run. A forced termination of the controller itself cannot run `finally`; use the printed run ID to identify any orphaned experiment container before removing it.

## Local result and adoption decision

On 2026-10-21, the focused trial passed all six scenarios on Windows with native Node v24.13.0, Docker Engine 29.2.1, BullMQ 6.3.19, ioredis 6.0.0, and Redis 7.4.2. Cleanup reported `passed`, all workers exited, and a separate Docker label query found no experiment containers. No production build or root test suite was run for this isolated experiment.

This supports a further design discussion, not production adoption. BullMQ recovered queued intent and retried work, but effect idempotency came from the simulated destination's stable operation ID and receipt storage. BullMQ did not make the external effect exactly once. The service stores receipts in memory for this experiment; production needs a durable destination-side idempotency/reconciliation contract.

Redis uses AOF with `appendfsync always` in the disposable container. The trial tests worker/producer restart, not Redis restart, host failure, failover, or disk loss. Slow-role isolation covers separate queues/processes and a held asynchronous job, not CPU saturation or resource quotas. Application-state/enqueue atomicity, scheduler migration, credentials, monitoring, deployment, real external APIs, and production throughput remain untested and unimplemented. Keep the current production scheduler until a separately approved design covers these contracts.

## Official references used

- [Deduplication](https://docs.bullmq.io/guide/jobs/deduplication): simple deduplication covers incomplete work; it is not an external side-effect guarantee.
- [Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs): attempts and fixed backoff provide the bounded retry policy exercised here.
- [Stalled jobs](https://docs.bullmq.io/guide/jobs/stalled): lost locks permit stalled recovery; recovery can cause another processor invocation.
- [Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): retry-safe application effects remain an application responsibility.
- [Connections](https://docs.bullmq.io/guide/connections): Redis connection/client and blocking worker requirements.
- [Parallelism and concurrency](https://docs.bullmq.io/guide/parallelism-and-concurrency): worker/process concurrency context.
