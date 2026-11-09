import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
  normalizeCodeJobGrant,
  normalizeCodeJob,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { createChangePackage } from "../src/domain/change-package-contract.js";
import { createCodeJobChangePackageEvent } from "../src/domain/code-job-change-package-event.js";
import {
  createCodeJobMemoryEvent,
  memoryRecordForCodeJobEvent,
} from "../src/domain/code-job-memory-event.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { projectArchivedCodeJobForBrowser } from "../src/domain/code-job-browser-projection.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
  normalizeCodeJobArchiveIndexRecord,
  normalizeCodeJobArchiveTombstoneRecord,
} from "../src/services/code-job-store.js";

class MemoryStore {
  constructor(value = null) {
    this.values = new Map();
    if (value !== null) {
      this.values.set(CODE_JOB_STATE_KEY, structuredClone(value));
    }
    this.writeCount = 0;
    this.writeThenFailAt = null;
    this.lastWriteName = null;
  }

  get value() {
    const value = this.values.get(CODE_JOB_STATE_KEY);
    return value === undefined ? null : value;
  }

  set value(value) {
    if (value === null) {
      this.values.delete(CODE_JOB_STATE_KEY);
      return;
    }
    this.values.set(CODE_JOB_STATE_KEY, structuredClone(value));
  }

  async read(name, fallback) {
    const value = this.values.get(name);
    return structuredClone(value === undefined ? fallback : value);
  }

  async write(name, value) {
    this.writeCount += 1;
    this.lastWriteName = name;
    this.values.set(name, structuredClone(value));
    if (this.writeCount === this.writeThenFailAt) {
      throw new Error("disk acknowledgement unavailable");
    }
  }
}

class VersionedMemoryStore extends MemoryStore {
  constructor(value = null) {
    super(value);
    this.contentVersions = new Map();
    this.codeJobReadCount = 0;
    this.versionedReadCount = 0;
  }

  async read(name, fallback) {
    if (name === CODE_JOB_STATE_KEY) this.codeJobReadCount += 1;
    return super.read(name, fallback);
  }

  async readVersioned(name, fallback, { ifVersion } = {}) {
    this.versionedReadCount += 1;
    const value = this.values.get(name);
    const serialized = value === undefined ? null : JSON.stringify(value);
    let current = this.contentVersions.get(name);
    if (!current || current.serialized !== serialized) {
      current = { serialized, version: Object.freeze({}) };
      this.contentVersions.set(name, current);
    }
    return ifVersion === current.version
      ? { changed: false, version: current.version }
      : { changed: true, version: current.version,
          value: structuredClone(value === undefined ? fallback : value) };
  }

  async write(name, value) {
    const hadVersion = this.contentVersions.has(name);
    await super.write(name, value);
    if (!hadVersion) return undefined;
    const version = Object.freeze({});
    this.contentVersions.set(name, { serialized: JSON.stringify(value), version });
    return version;
  }
}

class ExclusiveLease {
  constructor() {
    this.runCount = 0;
  }

  run(operation) {
    this.runCount += 1;
    return operation();
  }
}

function manualClock(initial = "2026-08-02T06:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function grantInput(overrides = {}) {
  return {
    schemaVersion: 2,
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:issue:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    inputBinding: null,
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Find the retry race without changing source files.",
    acceptanceCriteria: ["The race is identified with file evidence."],
    evidence: ["CI intermittently reports a stale revision."],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
    ...overrides,
  };
}

function legacyPullRequestInputBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "work-1",
    workKey: "pull-request-acme-widgets-17",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "1".repeat(40),
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
  };
}

function conflictPullRequestInputBinding() {
  return {
    ...legacyPullRequestInputBinding(),
    schemaVersion: 2,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/widgets",
      baseRefName: "main",
      baseRefOid: "5".repeat(40),
      headRepository: "contributor/widgets",
      headRefName: "fix/retry-race",
      headRefOid: "1".repeat(40),
    },
  };
}

function conflictGrant() {
  const inputBinding = conflictPullRequestInputBinding();
  const executionSource = createConflictCodeExecutionSource({
    inputBinding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "6".repeat(64),
        status: "conflicted",
        baseCommitOid: inputBinding.gitTarget.baseRefOid,
        headCommitOid: inputBinding.gitTarget.headRefOid,
        mergeBaseOid: "7".repeat(40),
        resultTreeOid: "8".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "9".repeat(64),
        evidenceDigest: "a".repeat(64),
        resultObjectDigest: "b".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: inputBinding.gitTarget,
    }),
  });
  return grant({
    schemaVersion: 3,
    inputBinding,
    executionSource,
    subject: {
      id: "github:pr:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    operation: "modify",
    objective: "Resolve the exact sealed conflict.",
    acceptanceCriteria: ["The conflicted file passes its fixed profile."],
    summary: "Resolve one sealed conflict",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src/app.js"],
  });
}

function grant(overrides = {}) {
  return createCodeJobGrant(grantInput(overrides));
}

function approval(overrides = {}) {
  return {
    confirmationId: "confirmation-code-job-approval-1",
    requestId: "approval-request-0001",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant: grant(),
    ...overrides,
  };
}

function memoryProjection(job, digest = "9".repeat(64)) {
  return {
    jobId: job.jobId,
    expectedRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
    memoryRecordId: `memory-${digest}`,
    memoryRecordDigest: digest,
  };
}

function memoryAcknowledgement(event, overrides = {}) {
  const record = normalizeMemoryRecord(memoryRecordForCodeJobEvent(event));
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    jobId: event.jobId,
    sourceRecordDigest: event.sourceRecordDigest,
    memoryRecordId: record.recordId,
    memoryRecordDigest: record.contentDigest,
    ...overrides,
  };
}

function legacyJobWithoutCancellationSettlement(job) {
  const content = structuredClone(job);
  delete content.recordDigest;
  delete content.execution.cancellationSettlement;
  return { ...content, recordDigest: digestValue(content) };
}

function compactionRequest(
  store,
  { compactionId = "code-job-compaction-test", targetThroughSequence } = {},
) {
  return {
    compactionId,
    expectedRevision: store.value.revision,
    targetThroughSequence,
    preArchiveDigest: store.value.archive.digest,
  };
}

function executorCancellationProof(
  job,
  {
    kind = "controlled_execution_cancelled",
    workspaceRevision = job.execution.workspaceRevision,
    disposition = "discarded_unknown",
    settledAt = job.updatedAt,
  } = {},
) {
  const pending = job.execution.pendingAction;
  const actionResolution = pending === null
    ? null
    : {
        actionId: pending.actionId,
        actionDigest: pending.actionDigest,
        disposition,
        workspaceRevisionBefore: pending.action.expectedWorkspaceRevision,
        workspaceRevisionAfter: disposition.startsWith("audited_")
          ? workspaceRevision
          : null,
      };
  const proof = {
    schemaVersion: 1,
    kind,
    sessionId: job.jobId,
    cancellationDigest: job.execution.result.detailDigest,
    sourceRevision: workspaceRevision === null ? null : "6".repeat(64),
    trustedWorkspaceRevision: workspaceRevision,
    actionResolution,
    sandboxCleanupConfirmed: true,
    discardedAttempts: kind === "controlled_execution_absent"
      ? []
      : [{
          attemptNumber: 1,
          executionId: "attempt-cancel-proof",
          disposition: "discarded",
        }],
    settledAt,
  };
  return { ...proof, proofDigest: digestValue(proof) };
}

async function readyStore({
  store = new MemoryStore(),
  time = manualClock(),
  limits,
  memoryReceiptVerifier = {
    async verify(value) {
      return { ...structuredClone(value), persisted: true };
    },
  },
  changePackageReader = null,
  operationQueue = new OperationQueue(),
} = {}) {
  const exclusiveLease = new ExclusiveLease();
  const jobs = new CodeJobStore({
    store,
    exclusiveLease,
    operationQueue,
    clock: time.clock,
    memoryReceiptVerifier,
    changePackageReader,
    ...(limits ? { limits } : {}),
  });
  await jobs.recover();
  return { jobs, store, time, exclusiveLease };
}

for (const escaped of [false, true]) test(`completion reports survive archive with exact binding and escaped bounds ${escaped}`, async () => {
  const f = await readyStore();
  const hostGrant = grant(escaped ? { evidence: Array.from({ length: 20 }, (_, i) => `${i}` + '"'.repeat(2040)) } : {});
  const created = await f.jobs.createApprovedJob(approval({ grant: hostGrant }));
  const starting = await f.jobs.claimStarting({ jobId: created.job.jobId, expectedRevision: created.job.revision });
  const active = await f.jobs.activate({ jobId: created.job.jobId, expectedRevision: starting.job.revision,
    workspaceRevision: '4'.repeat(64) });
  const action = { type: 'complete', actionId: 'completion-report-action', expectedWorkspaceRevision: '4'.repeat(64) };
  const report = { actionId: action.actionId, actionDigest: digestValue(action), workspaceRevision: action.expectedWorkspaceRevision,
    outcome: escaped ? '"'.repeat(4096) : 'Inspection findings and remaining verification.',
    evidence: escaped ? Array.from({ length: 20 }, (_, i) => `${i}` + '"'.repeat(2040)) : ['model evidence only'] };
  for (const [key, value] of [['actionId', 'other-action'], ['actionDigest', '0'.repeat(64)],
    ['workspaceRevision', '0'.repeat(64)], ['outcome', ''], ['evidence', ['duplicate', 'duplicate']]]) {
    await assert.rejects(f.jobs.prepareAction({ jobId: active.job.jobId, expectedRevision: active.job.revision,
      action, completionReport: { ...report, [key]: value } }), { code: 'INVALID_CODE_JOB_MUTATION' });
  }
  const prepared = await f.jobs.prepareAction({ jobId: active.job.jobId, expectedRevision: active.job.revision,
    action, completionReport: report });
  const persisted = normalizeCodeJob(f.store.value.jobs[0]);
  assert.deepEqual(persisted.execution.pendingAction.completionReport, report);
  await assert.rejects(f.jobs.prepareAction({ jobId: active.job.jobId, expectedRevision: prepared.job.revision,
    action, completionReport: { ...report, outcome: 'substituted report' } }), { code: 'CODE_JOB_TRANSITION_CONFLICT' });
  const observed = await f.jobs.recordObservation({ jobId: active.job.jobId, expectedRevision: prepared.job.revision,
    actionId: action.actionId, status: 'succeeded', workspaceRevision: action.expectedWorkspaceRevision,
    detail: { result: { created: [], modified: [], deleted: [] } } });
  assert.deepEqual(normalizeCodeJob(f.store.value.jobs[0]).execution.observations[0].completionReport, report);
  const recovered = await readyStore({ store: f.store, time: f.time });
  let current = await recovered.jobs.getForWorker(active.job.jobId);
  assert.deepEqual(current.execution.observations[0].completionReport, report);
  if (current.status === 'paused') current = (await recovered.jobs.resume({ jobId: current.jobId, expectedRevision: current.revision })).job;
  const manifest = { created: [], modified: [], deleted: [] };
  if (escaped) {
    while (Buffer.byteLength(JSON.stringify({ evidence: hostGrant.evidence, manifest })) < 120 * 1024) {
      manifest.created.push({ path: `src/${'x'.repeat(500)}${manifest.created.length}.js`, sha256: 'a'.repeat(64) });
    }
  }
  const terminalDetail = { schemaVersion: 1, outcome: report.outcome, evidence: hostGrant.evidence, completionReport: report,
      workspaceRevision: action.expectedWorkspaceRevision, completedActionId: action.actionId,
      checks: ['node-tests'], manifest };
  const withoutReport = { ...terminalDetail };
  delete withoutReport.completionReport;
  await assert.rejects(recovered.jobs.complete({ jobId: current.jobId, expectedRevision: current.revision,
    result: withoutReport }), { code: 'INVALID_CODE_JOB' });
  const completed = await recovered.jobs.complete({ jobId: current.jobId, expectedRevision: current.revision,
    result: terminalDetail });
  assert.equal((await recovered.jobs.getDetail({ jobId: current.jobId })).terminalDetail.outcome, report.outcome);
  const batch = await recovered.jobs.readMemoryProjectionBatch({ limit: 10 });
  for (const event of batch.items) await recovered.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  await recovered.jobs.compactTerminalPrefix(compactionRequest(f.store, { targetThroughSequence: completed.job.sequence }));
  const archived = await recovered.jobs.getDetail({ jobId: current.jobId });
  assert.equal(archived.archived, true);
  assert.equal(archived.terminalDetail.outcome, report.outcome);
  assert.deepEqual(archived.terminalDetail.completionReport.evidence, report.evidence);
  if (!escaped) {
    const storageKey = `code-job-tombstone-record-${current.jobId}`;
    const original = await f.store.read(storageKey, null);
    for (const replacement of [{ actionId: '../invalid' }, { workspaceRevision: 'not-a-sha256' },
      { actionId: 123, workspaceRevision: 456 }]) {
      const changed = structuredClone(original);
      Object.assign(changed.outcome.completionReport, replacement);
      const bad = changed.outcome.completionReport;
      bad.actionDigest = digestValue({ type: 'complete', actionId: bad.actionId, expectedWorkspaceRevision: bad.workspaceRevision });
      const sealed = resealArchiveFixture(changed, f.store.value.archiveIndex[0]);
      assert.throws(() => normalizeCodeJobArchiveTombstoneRecord(sealed.tombstone, { storageKey, manifest: sealed.manifest }),
        { code: 'CODE_JOB_ARCHIVE_CORRUPTED' });
    }
  }
  const reopened = await readyStore({ store: f.store, time: f.time });
  assert.deepEqual((await reopened.jobs.getDetail({ jobId: current.jobId })).terminalDetail, archived.terminalDetail);
});

test("unchanged versioned code jobs reuse certified state without reading and validating history again", async () => {
  const store = new VersionedMemoryStore();
  const fixture = await readyStore({ store });
  const created = await fixture.jobs.createApprovedJob(approval());
  const certified = fixture.jobs.state;
  const repeated = await fixture.jobs.createApprovedJob(approval());
  assert.equal(repeated.status, "already");
  assert.equal(store.codeJobReadCount, 0);
  assert.equal(store.versionedReadCount, 3);
  assert.equal(fixture.jobs.state, certified);
  assert.ok(Object.isFrozen(certified.jobs[0].execution));
  created.job.status = "fenced";
  assert.notEqual(fixture.jobs.state.jobs[0].status, created.job.status);
});

test("a code job mutation preserves certified unchanged history while newly changed jobs are validated", async () => {
  const fixture = await readyStore({ store: new VersionedMemoryStore() });
  await fixture.jobs.createApprovedJob(approval());
  const first = fixture.jobs.state.jobs[0];
  const otherGrant = grant({ proposalId: "work-intent-proposal-cache-2", contentDigest: "d".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-cache-2" },
    source: { assignmentId: "assignment-cache-2", eventId: "event-cache-2" } });
  await fixture.jobs.createApprovedJob(approval({ confirmationId: "confirmation-cache-2",
    requestId: "request-cache-2", displayedPayloadDigest: "2".repeat(64),
    approvalBindingDigest: "3".repeat(64), grant: otherGrant }));
  assert.equal(fixture.jobs.state.jobs[0], first);
  assert.ok(Object.isFrozen(first.grant));
  assert.throws(() => { first.grant.objective = "forged"; }, TypeError);
});

test("changed versioned code job bytes are fully validated before cached state can be reused", async () => {
  const store = new VersionedMemoryStore();
  const fixture = await readyStore({ store });
  await fixture.jobs.createApprovedJob(approval());
  const changed = structuredClone(store.value);
  changed.jobs[0].grant.objective = "A forged grant has the same job and state revisions.";
  Object.freeze(changed.jobs[0]);
  store.value = changed;
  await assert.rejects(fixture.jobs.createApprovedJob(approval()), { code: "CODE_JOB_STATE_CORRUPTED" });
});

test("a versioned write with a lost acknowledgement is reread before another job is admitted", async () => {
  const store = new VersionedMemoryStore();
  const fixture = await readyStore({ store });
  store.writeThenFailAt = 1;
  await assert.rejects(fixture.jobs.createApprovedJob(approval()), /disk acknowledgement unavailable/);
  const observed = await fixture.jobs.createApprovedJob(approval());
  assert.equal(observed.status, "already");
  assert.equal(store.value.jobs.length, 1);
  assert.equal(store.writeCount, 1);
});

test("another writer's changed valid version is adopted before a later mutation", async () => {
  const store = new VersionedMemoryStore();
  const first = await readyStore({ store });
  const created = await first.jobs.createApprovedJob(approval());
  const other = await readyStore({ store });
  await other.jobs.pause({ jobId: created.job.jobId, expectedRevision: created.job.revision, reason: "Owner paused" });
  const outcome = await first.jobs.createApprovedJob(approval());
  assert.equal(outcome.status, "already");
  assert.equal(first.jobs.state.jobs[0].status, "paused");
  assert.equal(first.jobs.state.revision, store.value.revision);
});

test("changed version tokens cannot hide rollback, missing state, or a forged unchanged result", async (t) => {
  for (const kind of ["rollback", "missing", "forged version"]) await t.test(kind, async () => {
    const store = new VersionedMemoryStore();
    const fixture = await readyStore({ store });
    const created = await fixture.jobs.createApprovedJob(approval());
    const previous = structuredClone(store.value);
    await fixture.jobs.pause({ jobId: created.job.jobId, expectedRevision: created.job.revision, reason: "Owner paused" });
    if (kind === "rollback") store.value = previous;
    if (kind === "missing") store.value = null;
    if (kind === "forged version") store.readVersioned = async () => ({ changed: false, version: Object.freeze({}) });
    await assert.rejects(fixture.jobs.createApprovedJob(approval()), {
      code: kind === "forged version" ? "CODE_JOB_STATE_CORRUPTED" : "CODE_JOB_STATE_ROLLBACK",
    });
    await assert.rejects(fixture.jobs.get(created.job.jobId), { code: "CODE_JOB_STORE_NOT_READY" });
  });
});

test("a write without an opaque committed version forces a fresh durable read", async () => {
  const store = new VersionedMemoryStore();
  const write = store.write.bind(store);
  store.write = async (...args) => { await write(...args); };
  const fixture = await readyStore({ store });
  await fixture.jobs.createApprovedJob(approval());
  const written = fixture.jobs.state;
  assert.equal((await fixture.jobs.createApprovedJob(approval())).status, "already");
  assert.notEqual(fixture.jobs.state, written);
});

test("a valid same-revision fork and replacement of the public state reference remain fail closed", async (t) => {
  for (const kind of ["durable fork", "public state replacement"]) await t.test(kind, async () => {
    const store = new VersionedMemoryStore();
    const fixture = await readyStore({ store });
    await fixture.jobs.createApprovedJob(approval());
    const changed = structuredClone(store.value);
    const job = changed.jobs[0];
    job.updatedAt = "2026-08-02T06:00:01.000Z";
    delete job.recordDigest;
    job.recordDigest = digestValue(job);
    if (kind === "durable fork") store.value = changed;
    else fixture.jobs.state = changed;
    await assert.rejects(fixture.jobs.createApprovedJob(approval()), { code: "CODE_JOB_STATE_FORKED" });
  });
});

async function activeTimeoutStore() {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const starting = await fixture.jobs.claimStarting({ jobId: created.job.jobId, expectedRevision: created.job.revision });
  const activated = await fixture.jobs.activate({ jobId: starting.job.jobId, expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64) });
  return { ...fixture, active: activated.job };
}

function timeoutMutation(job, overrides = {}) {
  return { jobId: job.jobId, expectedRevision: job.revision, failedRunId: "native-timeout-run-1",
    errorCode: "STRUCTURED_PROVIDER_TIMEOUT", failedAt: job.updatedAt,
    progressFingerprint: "6".repeat(64), baselineProgressFingerprint: "6".repeat(64), ...overrides };
}

test("timeout continuation is optional and old execution records retain their exact digest and shape", async () => {
  const fixture = await activeTimeoutStore();
  assert.equal(Object.hasOwn(fixture.active.execution, "timeoutContinuation"), false);
  assert.deepEqual(normalizeCodeJob(fixture.active), fixture.active);
  const writes = fixture.store.writeCount;
  const recovered = await readyStore({ store: fixture.store, time: fixture.time });
  assert.deepEqual(await recovered.jobs.getForWorker(fixture.active.jobId), fixture.active);
  assert.equal(fixture.store.writeCount, writes);
});

test("timeout continuation CAS stores strict metadata, applies backoff and retains owner lifecycle authority", async (t) => {
  for (const terminal of ["cancel", "fence"]) await t.test(terminal, async () => {
    const fixture = await activeTimeoutStore();
    let current = (await fixture.jobs.recordTimeoutContinuation(timeoutMutation(fixture.active))).job;
    const checkpoint = structuredClone(current.execution.timeoutContinuation);
    assert.equal(checkpoint.consecutiveNoProgress, 1);
    assert.equal((await fixture.jobs.listRunnable()).items.length, 0);
    fixture.time.advance(60_000);
    assert.equal((await fixture.jobs.listRunnable()).items.length, 1);
    const again = await fixture.jobs.recordTimeoutContinuation(timeoutMutation(current));
    assert.equal(again.status, "already");
    current = (await fixture.jobs.pause({ jobId: current.jobId, expectedRevision: current.revision, reason: "owner hold" })).job;
    assert.deepEqual(current.execution.timeoutContinuation, checkpoint);
    await assert.rejects(fixture.jobs.recordTimeoutContinuation(timeoutMutation(current, { failedRunId: "wrongly-adopt-paused" })),
      { code: "CODE_JOB_TRANSITION_CONFLICT" });
    current = (await fixture.jobs.resume({ jobId: current.jobId, expectedRevision: current.revision })).job;
    assert.deepEqual(current.execution.timeoutContinuation, checkpoint);
    current = (await fixture.jobs.recordTimeoutContinuation(timeoutMutation(current, { failedRunId: "native-timeout-run-2" }))).job;
    assert.equal(current.execution.timeoutContinuation.consecutiveNoProgress, 2, "manual resume does not reset progress budget");
    const lastCheckpoint = structuredClone(current.execution.timeoutContinuation);
    if (terminal === "cancel") {
      current = (await fixture.jobs.cancel({ jobId: current.jobId, expectedRevision: current.revision, reason: "owner cancelled" })).job;
      current = (await fixture.jobs.finalizeCancellation({ jobId: current.jobId, expectedRevision: current.revision,
        settlement: executorCancellationProof(current) })).job;
      assert.equal(current.status, "cancelled");
    } else {
      current = (await fixture.jobs.fence({ jobId: current.jobId, expectedRevision: current.revision,
        result: { code: "INVALID_CODE_JOB_AUTHORITY", message: "owner authority changed" } })).job;
      assert.equal(current.status, "fenced");
    }
    assert.deepEqual(current.execution.timeoutContinuation, lastCheckpoint);
    assert.deepEqual(normalizeCodeJob(current), current);
    const recovered = await readyStore({ store: fixture.store, time: fixture.time });
    assert.deepEqual(await recovered.jobs.getForWorker(current.jobId), current);
  });
});

test("timeout continuation metadata rejects unsupported, malformed and rebound persisted records", async (t) => {
  const fixture = await activeTimeoutStore();
  const current = (await fixture.jobs.recordTimeoutContinuation(timeoutMutation(fixture.active))).job;
  const badMutations = [
    ["extra key", metadata => { metadata.unknownPolicy = true; }],
    ["null", (_metadata, execution) => { execution.timeoutContinuation = null; }],
    ["unsupported failure", metadata => { metadata.errorCode = "STRUCTURED_PROVIDER_CLEANUP_FAILED"; }],
    ["negative budget", metadata => { metadata.consecutiveNoProgress = -1; }],
    ["unbounded budget", metadata => { metadata.consecutiveNoProgress = 4; }],
    ["fingerprint missing", metadata => { delete metadata.progressFingerprint; }],
    ["arbitrary retry time", metadata => { metadata.retryAfter = "2099-01-01T00:00:00.000Z"; }],
    ["failure before creation", metadata => { metadata.failedAt = "2000-01-01T00:00:00.000Z"; }],
    ["session absent", (_metadata, execution) => { execution.sessionId = null; }],
  ];
  for (const [name, mutate] of badMutations) await t.test(name, () => {
    const corrupted = structuredClone(current);
    mutate(corrupted.execution.timeoutContinuation, corrupted.execution);
    delete corrupted.recordDigest;
    corrupted.recordDigest = digestValue(corrupted);
    assert.throws(() => normalizeCodeJob(corrupted), { code: "INVALID_CODE_JOB" });
  });
  const writes = fixture.store.writeCount;
  await assert.rejects(fixture.jobs.recordTimeoutContinuation(timeoutMutation(current,
    { failedRunId: "native-timeout-unsupported", errorCode: "STRUCTURED_PROVIDER_REAP_FAILED" })),
    { code: "INVALID_CODE_JOB_MUTATION" });
  assert.equal(fixture.store.writeCount, writes);
});

async function completedDeliveryFixture(options = {}) {
  const {
    jobApproval = approval(),
    changePackageDelivery = true,
    ...storeOptions
  } = options;
  const fixture = await readyStore(storeOptions);
  const created = await fixture.jobs.createApprovedJob(jobApproval);
  const starting = await fixture.jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const workspaceRevision = "4".repeat(64);
  const active = await fixture.jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision,
  });
  const actionId = "complete-change-package";
  const prepared = await fixture.jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId,
      expectedWorkspaceRevision: workspaceRevision,
    },
  });
  const detail = { created: [], modified: [], deleted: [] };
  const observed = await fixture.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId,
    status: "succeeded",
    workspaceRevision,
    detail,
  });
  const result = { summary: "Change package ready", manifest: detail };
  const completed = await fixture.jobs.complete({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
    result,
    ...(changePackageDelivery ? { changePackageDelivery: true } : {}),
  });
  return {
    ...fixture,
    completed,
    observed,
    result,
    workspaceRevision,
    actionId,
  };
}

async function appendCompletedDelivery(
  jobs,
  jobApproval,
  actionId,
  workspaceRevision = "4".repeat(64),
) {
  const created = await jobs.createApprovedJob(jobApproval);
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision,
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId,
      expectedWorkspaceRevision: workspaceRevision,
    },
  });
  const detail = { created: [], modified: [], deleted: [] };
  const observed = await jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId,
    status: "succeeded",
    workspaceRevision,
    detail,
  });
  return jobs.complete({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
    result: { summary: `${actionId} ready`, manifest: detail },
    changePackageDelivery: true,
  });
}

function changePackageForEvent(event, overrides = {}) {
  const draft = {
    job: event.job,
    proposal: event.proposal,
    grant: event.grant,
    workspace: {
      id: "widgets-local",
      sourceRevision: "3".repeat(64),
      workspaceRevision: event.exportRequest.expectedWorkspaceRevision,
    },
    passedProfiles: [{
      id: "node-tests",
      configDigest: "b".repeat(64),
      workspaceRevision: event.exportRequest.expectedWorkspaceRevision,
      actionId: "run-node-tests",
      attemptNumber: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      artifacts: {
        output: { path: "proof/output.json", sha256: "5".repeat(64), bytes: 1 },
        stdout: { path: "proof/stdout.json", sha256: "6".repeat(64), bytes: 1 },
        stderr: { path: "proof/stderr.json", sha256: "7".repeat(64), bytes: 1 },
      },
    }],
    created: [],
    modified: [],
    deleted: [],
  };
  return createChangePackage({ ...draft, ...overrides }).manifest;
}

function changePackageAcknowledgement(event, manifest, overrides = {}) {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    jobId: event.job.id,
    sourceRecordDigest: event.job.recordDigest,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    ...overrides,
  };
}

function controlledCommitReceipt(event, manifest) {
  const executionSourceDigest = digestValue(event.executionSource);
  const binding = {
    schemaVersion: 1,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    executionSourceDigest,
    recordedAt: event.recordedAt,
  };
  const bindingDigest = digestValue(binding);
  const evidenceDigest = "a".repeat(64);
  const content = {
    schemaVersion: 1,
    kind: "change_package_controlled_commit",
    deliveryId: `change-package-controlled-commit-${bindingDigest}`,
    bindingDigest,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    executionSourceDigest,
    recordedAt: event.recordedAt,
    evidenceId: `controlled-git-commit-${evidenceDigest}`,
    evidenceDigest,
    commitOid: "b".repeat(40),
  };
  const receiptDigest = digestValue(content);
  return {
    ...content,
    receiptDigest,
    receiptId: `change-package-controlled-commit-receipt-${receiptDigest}`,
  };
}

function persistedLegacyChangePackageEvent(job) {
  const source = job.execution.memoryProjection ?? {
    sourceRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
  };
  const completion = job.execution.observations.findLast(
    ({ actionType, status }) => actionType === "complete" && status === "succeeded",
  );
  const content = {
    schemaVersion: 1,
    sequence: 1,
    previousDigest: null,
    job: {
      id: job.jobId,
      revision: source.sourceRevision,
      recordDigest: source.sourceRecordDigest,
    },
    proposal: {
      id: job.proposal.proposalId,
      contentDigest: job.proposal.contentDigest,
    },
    grant: { digest: job.grant.grantDigest },
    exportRequest: {
      sessionId: job.execution.sessionId,
      completedActionId: completion.actionId,
      expectedWorkspaceRevision: job.execution.workspaceRevision,
    },
  };
  const eventDigest = digestValue(content);
  return {
    ...content,
    eventId: `code-job-change-package-event-${eventDigest}`,
    eventDigest,
  };
}

async function preparedActionFixture(actionId) {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const starting = await fixture.jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await fixture.jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await fixture.jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "list_files",
      actionId,
      expectedWorkspaceRevision: "4".repeat(64),
      path: "",
    },
  });
  return { ...fixture, created, prepared };
}

test("grant sealing is canonical, deterministic, and enforces the operation matrix", () => {
  const first = grant({
    allowedActions: [
      "complete",
      "run_profile",
      "search_text",
      "read_text",
      "list_files",
    ],
    requiredProfiles: [
      { id: "typecheck", configDigest: "f".repeat(64) },
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
  });
  const second = grant({
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
      { id: "typecheck", configDigest: "f".repeat(64) },
    ],
  });

  assert.deepEqual(first.allowedActions, CODE_JOB_ACTIONS_BY_OPERATION.inspect);
  assert.deepEqual(
    first.requiredProfiles.map(({ id }) => id),
    ["node-tests", "typecheck"],
  );
  assert.equal(first.grantDigest, second.grantDigest);
  assert.equal(codeJobIdForGrant(first), codeJobIdForGrant(second));
  assert.equal(codeJobIdForGrant(first).length, 64);
  assert.match(codeJobIdForGrant(first), /^code-job-[a-f0-9]{55}$/);

  assert.throws(
    () =>
      grant({
        allowedActions: [
          ...CODE_JOB_ACTIONS_BY_OPERATION.inspect,
          "write_text",
        ],
      }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
  assert.throws(
    () =>
      grant({
        operation: "modify",
        allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
        writablePaths: [],
      }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
  assert.throws(
    () => normalizeCodeJobGrant({ ...first, grantDigest: "0".repeat(64) }),
    (error) => error.code === "INVALID_CODE_JOB_GRANT",
  );
});

test("createApprovedJob persists one queued job with all four digest bindings", async () => {
  const { jobs, store, exclusiveLease } = await readyStore();
  const request = approval();
  const created = await jobs.createApprovedJob(request);

  assert.equal(created.status, "applied");
  assert.equal(created.receipt.id, codeJobIdForGrant(request.grant));
  assert.equal(created.receipt.id.length, 64);
  assert.equal(created.job.status, "queued");
  assert.equal(store.lastWriteName, CODE_JOB_STATE_KEY);
  assert.equal(store.writeCount, 1);
  assert.equal(exclusiveLease.runCount, 2);

  const durable = store.value.jobs[0];
  assert.equal(durable.status, "queued");
  assert.equal(
    durable.approval.displayedPayloadDigest,
    request.displayedPayloadDigest,
  );
  assert.equal(
    durable.approval.approvalBindingDigest,
    request.approvalBindingDigest,
  );
  assert.equal(durable.proposal.contentDigest, request.grant.contentDigest);
  assert.equal(durable.grant.grantDigest, request.grant.grantDigest);
  assert.match(durable.recordDigest, /^[a-f0-9]{64}$/);
});

test("durable writes preserve bounded host-composed large files through observation and restart", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval({ grant: grant({ operation: "modify",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ["src"] }) }));
  const starting = await fixture.jobs.claimStarting({ jobId: created.job.jobId, expectedRevision: created.job.revision });
  const active = await fixture.jobs.activate({ jobId: created.job.jobId, expectedRevision: starting.job.revision, workspaceRevision: "4".repeat(64) });
  const content = "preserve this large source line\n".repeat(5_000);
  assert.ok(content.length > 128 * 1024);
  const action = { type: "write_text", actionId: "large-host-write", path: "src/large.cpp", content,
    expectedSha256: "3".repeat(64), expectedWorkspaceRevision: "4".repeat(64) };
  const prepared = await fixture.jobs.prepareAction({ jobId: active.job.jobId, expectedRevision: active.job.revision, action });
  const reopened = await readyStore({ store: fixture.store, time: fixture.time });
  const persisted = await reopened.jobs.getForWorker(active.job.jobId);
  assert.equal(persisted.execution.pendingAction.action.content, content);
  const observed = await reopened.jobs.recordObservation({ jobId: persisted.jobId, expectedRevision: persisted.revision,
    actionId: action.actionId, status: "succeeded", workspaceRevision: "5".repeat(64), detail: { result: { bytes: content.length } } });
  assert.equal(observed.job.execution.observations[0].action.content, content);
  assert.deepEqual(normalizeCodeJob(observed.job), observed.job);
  const writes = fixture.store.writeCount;
  await assert.rejects(reopened.jobs.prepareAction({ jobId: observed.job.jobId, expectedRevision: observed.job.revision,
    action: { ...action, actionId: "too-large-host-write", expectedWorkspaceRevision: "5".repeat(64), content: "x".repeat(1024 * 1024 + 1) } }),
  { code: "CODE_JOB_ACTION_TOO_LARGE" });
  assert.equal(fixture.store.writeCount, writes);
  assert.ok(prepared.job.execution.pendingAction);
});

test("live job detail paginates revision-bound sanitized observations", async () => {
  const fixture = await readyStore();
  const request = approval({
    grant: grant({
      operation: "modify",
      objective: "Update one file without exposing its contents in the UI.",
      allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
      writablePaths: ["src"],
    }),
  });
  const created = await fixture.jobs.createApprovedJob(request);
  const starting = await fixture.jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  let current = await fixture.jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  current = await fixture.jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: current.job.revision,
    action: {
      type: "write_text",
      actionId: "write-secret-file",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/secret.js",
      content: "TOP_SECRET_WRITE_CONTENT",
      expectedSha256: "3".repeat(64),
    },
  });
  current = await fixture.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: current.job.revision,
    actionId: "write-secret-file",
    status: "succeeded",
    workspaceRevision: "5".repeat(64),
    detail: {
      result: {
        path: "src/secret.js",
        content: "TOP_SECRET_OBSERVATION_CONTENT",
        Content: "TOP_SECRET_CASE_VARIANT",
        expectedSha256: "3".repeat(64),
        EXPECTEDSHA256: "2".repeat(64),
        absolutePath: "D:/private/checkout/src/secret.js",
        device: "private-volume-7",
        bytes: 24,
      },
    },
  });
  current = await fixture.jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: current.job.revision,
    action: {
      type: "read_text",
      actionId: "read-secret-file",
      expectedWorkspaceRevision: "5".repeat(64),
      path: "src/secret.js",
    },
  });
  current = await fixture.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: current.job.revision,
    actionId: "read-secret-file",
    status: "succeeded",
    workspaceRevision: "5".repeat(64),
    detail: {
      result: {
        path: "src/secret.js",
        content: "TOP_SECRET_READ_CONTENT",
        sha256: "5".repeat(64),
      },
    },
  });

  const first = await fixture.jobs.getDetail({
    jobId: created.job.jobId,
    limit: 1,
  });
  assert.equal(first.archived, false);
  assert.equal(first.historyAvailable, true);
  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].actionType, "write_text");
  assert.match(first.observations[0].actionDigest, /^[a-f0-9]{64}$/);
  assert.match(first.observations[0].detailDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.observations[0].detail, {
    schemaVersion: 1,
    executor: null,
    result: {
      path: "src/secret.js",
      sha256: null,
      bytes: 24,
      error: null,
    },
  });
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(first.changePackage, {
    status: "none",
    receipt: null,
  });
  assert.equal(first.terminalDetail, null);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("TOP_SECRET"), false);
  assert.equal(serialized.includes("expectedSha256"), false);
  assert.equal(serialized.includes("absolutePath"), false);
  assert.equal(serialized.includes("D:/private"), false);
  assert.equal(serialized.includes("private-volume"), false);
  assert.equal(serialized.includes("src/secret.js"), true);

  const second = await fixture.jobs.getDetail({
    jobId: created.job.jobId,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.observations.map(({ turn }) => turn), [2]);
  assert.equal(second.nextCursor, null);

  await fixture.jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: current.job.revision,
    reason: "Make the previous detail cursor stale",
  });
  await assert.rejects(
    fixture.jobs.getDetail({
      jobId: created.job.jobId,
      limit: 1,
      cursor: first.nextCursor,
    }),
    (error) => error.code === "CODE_JOB_DETAIL_CURSOR_STALE",
  );
  assert.throws(
    () => fixture.jobs.getDetail({ jobId: created.job.jobId, limit: 21 }),
    (error) => error.code === "INVALID_CODE_JOB_QUERY",
  );
  assert.equal(
    await fixture.jobs.getDetail({ jobId: `code-job-${"f".repeat(55)}` }),
    null,
  );
});

test("approval retries with a new requestId converge on the same durable job", async () => {
  const { jobs, store } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const repeated = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-0002" }),
  );

  assert.equal(repeated.status, "already");
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.equal(repeated.job.jobId, first.job.jobId);
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
  assert.equal(store.value.jobs[0].approval.requestId, "approval-request-0001");
});

test("same proposal fails closed when approval or grant binding differs", async () => {
  const { jobs, store } = await readyStore();
  await jobs.createApprovedJob(approval());

  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-0002",
        approvalBindingDigest: "f".repeat(64),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-0003",
        grant: grant({ summary: "A different authorized task" }),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
});

test("get and list return newest browser-safe copies", async () => {
  const { jobs } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
    subject: {
      id: "github:acme/widgets:pull-request:18",
      repository: "acme/widgets",
      number: 18,
    },
  });
  const second = await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: secondGrant,
    }),
  );

  const newest = await jobs.list({
    limit: "1",
    order: "newest",
    status: "queued",
  });
  assert.equal(newest.revision, 2);
  assert.equal(newest.total, 2);
  assert.equal(newest.items[0].jobId, second.job.jobId);
  assert.equal(newest.nextCursor, second.job.jobId);
  assert.equal(first.job.createdAt, second.job.createdAt);
  const older = await jobs.list({
    limit: "1",
    order: "newest",
    cursor: newest.nextCursor,
  });
  assert.equal(older.items[0].jobId, first.job.jobId);
  assert.equal(older.nextCursor, null);
  assert.equal((await jobs.listNewest()).items[1].jobId, first.job.jobId);

  const found = await jobs.get(first.job.jobId);
  assert.equal(found.jobId, first.job.jobId);
  assert.equal(found.requiredProfiles[0], "node-tests");
  assert.deepEqual(Object.keys(found), [
    "jobId",
    "status",
    "revision",
    "proposalId",
    "proposalContentDigest",
    "grantDigest",
    "requestedBy",
    "subject",
    "repository",
    "workspaceId",
    "inputBinding",
    "operation",
    "objective",
    "acceptanceCriteria",
    "evidence",
    "summary",
    "reason",
    "allowedActions",
    "writablePaths",
    "requiredProfiles",
    "turn",
    "pendingActionType",
    "observationCount",
    "latestObservation",
    "terminalResult",
    "memoryProjection",
    "pause",
    "uncertainty",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal("approval" in found, false);
  assert.equal("requestId" in found, false);
  assert.equal("recordDigest" in found, false);
  assert.equal("brainDigest" in found, false);
  assert.equal(JSON.stringify(found).includes("configDigest"), false);
  found.acceptanceCriteria[0] = "tampered in browser";
  assert.notEqual(
    (await jobs.get(first.job.jobId)).acceptanceCriteria[0],
    "tampered in browser",
  );
  assert.equal(await jobs.get(`code-job-${"f".repeat(55)}`), null);
});

test("worker candidate cursors rotate bounded runnable work without starvation", async () => {
  const { jobs } = await readyStore();
  const created = [];
  for (const index of [1, 2, 3]) {
    const sealedGrant = grant({
      proposalId: `work-intent-cursor-${index}`,
      contentDigest: String(index).repeat(64),
      requestedBy: { roleId: "developer", workItemId: `cursor-work-${index}` },
      source: {
        assignmentId: `cursor-assignment-${index}`,
        eventId: `cursor-event-${index}`,
      },
      subject: {
        id: `github:acme/widgets:pull-request:${20 + index}`,
        repository: "acme/widgets",
        number: 20 + index,
      },
      summary: `Inspect retry race ${index}`,
    });
    const result = await jobs.createApprovedJob(
      approval({
        confirmationId: `confirmation-code-job-cursor-${index}`,
        requestId: `cursor-approval-request-${index}`,
        displayedPayloadDigest: String(index + 3).repeat(64),
        approvalBindingDigest: String(index + 6).repeat(64),
        grant: sealedGrant,
      }),
    );
    created.push(await jobs.getForWorker(result.job.jobId));
  }

  const middle = await jobs.listRunnable({
    limit: 2,
    afterSequence: created[0].sequence,
  });
  assert.deepEqual(
    middle.items.map(({ sequence }) => sequence),
    [created[1].sequence, created[2].sequence],
  );
  const wrapped = await jobs.listRunnable({
    limit: 2,
    afterSequence: created[2].sequence,
  });
  assert.deepEqual(
    wrapped.items.map(({ sequence }) => sequence),
    [created[0].sequence, created[1].sequence],
  );
  assert.throws(
    () => jobs.listRunnable({ afterSequence: -1 }),
    (error) => error.code === "INVALID_CODE_JOB_QUERY",
  );
  for (const job of created) await jobs.pause({ jobId: job.jobId, expectedRevision: job.revision, reason: 'owner pause' });
  const paused = await jobs.listPaused({ limit: 2, afterSequence: created[2].sequence });
  assert.deepEqual(paused.items.map(job => job.sequence), [created[0].sequence, created[1].sequence]);
  assert.ok(paused.items.every(job => job.status === 'paused'));
  paused.items[0].grant.objective = 'mutated projection';
  assert.notEqual((await jobs.getForWorker(created[0].jobId)).grant.objective, 'mutated projection');
  assert.equal((await jobs.listPaused({ roleId: 'tester' })).items.length, 0);
});

test("durable state recovers and rejects tampering before serving queries", async () => {
  const store = new MemoryStore();
  const first = await readyStore({ store });
  const created = await first.jobs.createApprovedJob(approval());
  const recovered = await readyStore({ store });
  assert.equal((await recovered.jobs.get(created.job.jobId)).status, "queued");

  store.value.jobs[0].grant.grantDigest = "0".repeat(64);
  await assert.rejects(
    recovered.jobs.createApprovedJob(approval()),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  await assert.rejects(
    recovered.jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
  const broken = new CodeJobStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("append sequence detects deleted approvals and forged revision gaps", async () => {
  const source = new MemoryStore();
  const { jobs } = await readyStore({ store: source });
  await jobs.createApprovedJob(approval());
  await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: grant({
        proposalId: "work-intent-proposal-2",
        contentDigest: "1".repeat(64),
        requestedBy: { roleId: "tester", workItemId: "work-2" },
        source: { assignmentId: "assignment-2", eventId: "event-2" },
      }),
    }),
  );

  const withoutFirst = structuredClone(source.value);
  withoutFirst.jobs.shift();
  withoutFirst.nextJobSequence = 2;
  const withoutLatest = structuredClone(source.value);
  withoutLatest.jobs.pop();
  withoutLatest.nextJobSequence = 2;
  const forgedEmpty = {
    schemaVersion: 1,
    revision: 5,
    nextJobSequence: 1,
    jobs: [],
  };
  for (const value of [withoutFirst, withoutLatest, forgedEmpty]) {
    await assert.rejects(
      readyStore({ store: new MemoryStore(value) }),
      (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
    );
  }
});

test("failed or rolled-back repeated recovery leaves the store unavailable", async () => {
  const durable = new MemoryStore();
  const { jobs } = await readyStore({ store: durable });
  await jobs.createApprovedJob(approval());

  durable.value = { invalid: true };
  await assert.rejects(
    jobs.recover(),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  await assert.rejects(
    jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );

  durable.value = {
    schemaVersion: 1,
    revision: 0,
    nextJobSequence: 1,
    jobs: [],
  };
  await assert.rejects(
    jobs.recover(),
    (error) => error.code === "CODE_JOB_STATE_ROLLBACK",
  );
  await assert.rejects(
    jobs.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
});

test("a persisted job is returned as already after write acknowledgement loss", async () => {
  const store = new MemoryStore();
  const { jobs } = await readyStore({ store });
  store.writeThenFailAt = 1;

  await assert.rejects(
    jobs.createApprovedJob(approval()),
    /disk acknowledgement unavailable/,
  );
  assert.equal(store.value.jobs.length, 1);
  const recovered = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-0002" }),
  );
  assert.equal(recovered.status, "already");
  assert.equal(store.writeCount, 1);
  assert.equal(
    (await jobs.reconcileApprovedJob(
      approval({ requestId: "approval-request-0003" }),
    )).status,
    "already",
  );
});

test("approval reconciliation distinguishes exact absence from conflicts", async () => {
  const { jobs } = await readyStore();
  assert.deepEqual(await jobs.reconcileApprovedJob(approval()), {
    status: "absent",
  });
  await jobs.createApprovedJob(approval());
  await assert.rejects(
    jobs.reconcileApprovedJob(
      approval({ approvalBindingDigest: "f".repeat(64) }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
});

test("concurrent exact approvals serialize through the injected queue and lease", async () => {
  const { jobs, store } = await readyStore();
  const results = await Promise.all([
    jobs.createApprovedJob(approval()),
    jobs.createApprovedJob(approval({ requestId: "approval-request-0002" })),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["already", "applied"],
  );
  assert.equal(store.writeCount, 1);
  assert.equal(store.value.jobs.length, 1);
});

test("capacity and lifecycle guards do not mutate accepted durable state", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 1 } });
  await jobs.createApprovedJob(approval());
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
  });
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        confirmationId: "confirmation-code-job-approval-2",
        requestId: "approval-request-0002",
        displayedPayloadDigest: "2".repeat(64),
        approvalBindingDigest: "3".repeat(64),
        grant: secondGrant,
      }),
    ),
    (error) => error.code === "CODE_JOB_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.jobs.length, 1);

  const cold = new CodeJobStore({
    store: new MemoryStore(),
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    cold.list(),
    (error) => error.code === "CODE_JOB_STORE_NOT_READY",
  );
  assert.throws(
    () =>
      new CodeJobStore({
        store: new MemoryStore(),
        exclusiveLease: new ExclusiveLease(),
      }),
    /operationQueue is invalid/,
  );
});

test("worker lifecycle persists deterministic session, pending action, and observations", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;

  const starting = await jobs.claimStarting({
    jobId,
    expectedRevision: created.job.revision,
  });
  assert.equal(starting.status, "applied");
  assert.equal(starting.job.status, "starting");
  assert.equal(starting.job.execution.sessionId, jobId);
  assert.equal(
    (await jobs.claimStarting({ jobId, expectedRevision: 1 })).status,
    "already",
  );

  const initialWorkspaceRevision = "4".repeat(64);
  const active = await jobs.activate({
    jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: initialWorkspaceRevision,
  });
  assert.equal(active.job.status, "active");
  await assert.rejects(
    jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action: {
        type: "write_text",
        actionId: "unauthorized-write",
        expectedWorkspaceRevision: initialWorkspaceRevision,
        path: "src/index.js",
        content: "not authorized",
        expectedSha256: null,
      },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  await assert.rejects(
    jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action: {
        type: "run_profile",
        actionId: "unknown-profile",
        expectedWorkspaceRevision: initialWorkspaceRevision,
        profileId: "untrusted-check",
      },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const action = {
    type: "list_files",
    actionId: "turn-1-list",
    expectedWorkspaceRevision: initialWorkspaceRevision,
    path: "",
  };
  const prepared = await jobs.prepareAction({
    jobId,
    expectedRevision: active.job.revision,
    action,
  });
  assert.equal(prepared.job.execution.pendingAction.actionId, "turn-1-list");
  assert.deepEqual(prepared.job.execution.pendingAction.action, action);
  assert.equal(
    (await jobs.prepareAction({
      jobId,
      expectedRevision: active.job.revision,
      action,
    })).status,
    "already",
  );

  const workerSnapshot = await jobs.getForWorker(jobId);
  assert.equal(workerSnapshot.grant.grantDigest, approval().grant.grantDigest);
  assert.equal(workerSnapshot.execution.pendingAction.actionId, "turn-1-list");
  const observed = await jobs.recordObservation({
    jobId,
    expectedRevision: prepared.job.revision,
    actionId: action.actionId,
    status: "succeeded",
    workspaceRevision: initialWorkspaceRevision,
    detail: { files: ["src/index.js"], truncated: false },
  });
  assert.equal(observed.job.execution.turn, 1);
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.observations[0].actionType, "list_files");
  assert.equal(observed.job.execution.observations[0].status, "succeeded");
  assert.match(
    observed.job.execution.observations[0].detailDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    (await jobs.recordObservation({
      jobId,
      expectedRevision: prepared.job.revision,
      actionId: action.actionId,
      status: "succeeded",
      workspaceRevision: initialWorkspaceRevision,
      detail: { truncated: false, files: ["src/index.js"] },
    })).status,
    "already",
  );

  const browser = await jobs.get(jobId);
  assert.equal(browser.turn, 1);
  assert.equal(browser.observationCount, 1);
  assert.equal(browser.latestObservation.actionType, "list_files");
  assert.equal("execution" in browser, false);
  assert.equal(JSON.stringify(browser).includes("turn-1-list"), false);
  assert.equal(store.value.jobs[0].execution.observations.length, 1);
});

test("lifecycle CAS rejects stale divergence and acknowledgement loss retries converge", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const jobId = created.job.jobId;
  store.writeThenFailAt = 2;

  await assert.rejects(
    jobs.claimStarting({ jobId, expectedRevision: created.job.revision }),
    /disk acknowledgement unavailable/,
  );
  const reconciled = await jobs.claimStarting({
    jobId,
    expectedRevision: created.job.revision,
  });
  assert.equal(reconciled.status, "already");
  assert.equal(reconciled.job.status, "starting");

  await assert.rejects(
    jobs.activate({
      jobId,
      expectedRevision: created.job.revision,
      workspaceRevision: "4".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_REVISION_CONFLICT",
  );
  const active = await jobs.activate({
    jobId,
    expectedRevision: reconciled.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  await assert.rejects(
    jobs.activate({
      jobId,
      expectedRevision: active.job.revision,
      workspaceRevision: "5".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
});

test("pause and resume preserve a prepared trusted action for exact retry", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const paused = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    reason: "等待用户检查执行上下文",
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.pause.from, "active");
  assert.equal(paused.job.execution.pendingAction.actionId, "turn-1-read");
  assert.equal((await jobs.listRunnable()).items.length, 0);

  const resumed = await jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: paused.job.revision,
  });
  assert.equal(resumed.job.status, "active");
  assert.equal(resumed.job.execution.pendingAction.actionId, "turn-1-read");
  assert.equal((await jobs.listRunnable()).items[0].jobId, created.job.jobId);
  assert.equal(
    (await jobs.listRunnable({ roleId: "developer", limit: 1 })).items[0]
      .jobId,
    created.job.jobId,
  );
  assert.equal((await jobs.listRunnable({ roleId: "tester" })).items.length, 0);
  assert.throws(
    () => jobs.listRunnable({ roleId: "Developer" }),
    (error) => error.code === "INVALID_CODE_JOB_QUERY",
  );
  assert.equal(
    (await jobs.resume({
      jobId: created.job.jobId,
      expectedRevision: paused.job.revision,
    })).status,
    "already",
  );
});

test("an admitted action keeps pause in pausing until its result is recorded", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-admitted-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  assert.equal(
    admitted.job.execution.actionAdmission.epoch,
    admitted.job.revision,
  );

  const pausing = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    reason: "等待已入场动作安全结束",
  });
  assert.equal(pausing.job.status, "pausing");
  assert.equal(pausing.job.execution.pause.from, "active");
  assert.equal((await jobs.listRunnable()).items[0].status, "pausing");
  await assert.rejects(
    jobs.resume({
      jobId: created.job.jobId,
      expectedRevision: pausing.job.revision,
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );

  const recovered = await readyStore({ store });
  const recoveredPausing = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(recoveredPausing.status, "pausing");
  assert.deepEqual(
    recoveredPausing.execution.actionAdmission,
    pausing.job.execution.actionAdmission,
  );
  assert.equal(
    (await recovered.jobs.listRunnable()).items[0].status,
    "pausing",
  );

  const observed = await recovered.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: recoveredPausing.revision,
    actionId: pending.actionId,
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: {
      result: {
        path: "src/index.js",
        content: "export const value = 1;\n",
      },
    },
  });
  assert.equal(observed.job.status, "paused");
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.actionAdmission, null);
  assert.equal(observed.job.execution.turn, 1);

  const resumed = await recovered.jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
  });
  assert.equal(resumed.job.status, "active");
});

test("an admitted action cannot be failed or fenced before reconciliation", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-terminal-guard",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });

  for (const finish of ["fail", "fence"]) {
    await assert.rejects(
      jobs[finish]({
        jobId: created.job.jobId,
        expectedRevision: admitted.job.revision,
        result: { code: "UNSAFE_TERMINAL_TRANSITION" },
      }),
      (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
    );
  }
  const unchanged = await jobs.getForWorker(created.job.jobId);
  assert.equal(unchanged.status, "active");
  assert.equal(unchanged.execution.pendingAction.actionId, pending.actionId);
  assert.equal(
    unchanged.execution.actionAdmission.actionDigest,
    pending.actionDigest,
  );
});

test("cancellation is durable, idempotent, and archived only after memory receipt", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const request = {
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    reason: "用户取消不再需要的检查任务",
  };

  const cancelled = await jobs.cancel(request);
  assert.equal(cancelled.status, "applied");
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.execution.result.kind, "cancelled");
  assert.deepEqual(cancelled.job.execution.result.detail, {
    schemaVersion: 1,
    outcome: "cancelled",
    code: "CODE_JOB_CANCELLED",
    message: "代码任务已按用户请求取消",
    reason: request.reason,
    requestedFrom: "queued",
  });
  assert.equal((await jobs.listRunnable()).items.length, 0);

  const retry = await jobs.cancel(request);
  assert.equal(retry.status, "already");
  assert.equal(retry.job.recordDigest, cancelled.job.recordDigest);
  await assert.rejects(
    jobs.cancel({ ...request, reason: "不同的取消原因" }),
    { code: "CODE_JOB_TRANSITION_CONFLICT" },
  );
  await assert.rejects(
    jobs.fail({
      jobId: cancelled.job.jobId,
      expectedRevision: cancelled.job.revision,
      result: { code: "LATE_FAILURE", message: "must not overwrite cancel" },
    }),
    { code: "CODE_JOB_TRANSITION_CONFLICT" },
  );

  await assert.rejects(
    jobs.compactTerminalPrefix(compactionRequest(store, {
      targetThroughSequence: cancelled.job.sequence,
    })),
    { code: "CODE_JOB_RETENTION_BLOCKED" },
  );
  const batch = await jobs.readMemoryProjectionBatch({ limit: 10 });
  assert.equal(batch.items.at(-1).kind, "cancelled");
  await jobs.acknowledgeMemoryProjection(
    memoryAcknowledgement(batch.items.at(-1)),
  );
  const compacted = await jobs.compactTerminalPrefix(compactionRequest(store, {
    targetThroughSequence: cancelled.job.sequence,
  }));
  assert.equal(compacted.status, "applied");
  assert.equal((await jobs.get(cancelled.job.jobId)).status, "cancelled");
});

test("session-start cancellation preserves request time and projects its real terminal time", async () => {
  const { jobs, store, time } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  time.advance(1_000);
  const cancelling = await jobs.cancel({
    jobId: starting.job.jobId,
    expectedRevision: starting.job.revision,
    reason: "用户停止已入场的启动流程",
  });

  assert.equal(cancelling.job.status, "cancelling");
  assert.equal(cancelling.job.execution.result.detail.requestedFrom, "starting");
  assert.equal((await jobs.listRunnable()).items[0].status, "cancelling");
  const intent = structuredClone(cancelling.job.execution.result);
  time.advance(60_000);
  const workspaceRevision = "8".repeat(64);
  const settlement = executorCancellationProof(cancelling.job, {
    workspaceRevision,
    settledAt: time.clock().toISOString(),
  });
  const cancelled = await jobs.finalizeCancellation({
    jobId: cancelling.job.jobId,
    expectedRevision: cancelling.job.revision,
    settlement,
  });
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.execution.workspaceRevision, workspaceRevision);
  assert.deepEqual(cancelled.job.execution.result, intent);
  assert.notEqual(cancelled.job.updatedAt, intent.recordedAt);
  assert.equal(
    (await jobs.get(cancelled.job.jobId)).terminalResult.recordedAt,
    cancelled.job.updatedAt,
  );
  const retry = await jobs.finalizeCancellation({
    jobId: cancelling.job.jobId,
    expectedRevision: cancelling.job.revision,
    settlement,
  });
  assert.equal(retry.status, "already");
  const events = (await jobs.readMemoryProjectionBatch({ limit: 10 })).items;
  const cancellingEvent = events.find(({ kind }) => kind === "cancelling");
  const cancelledEvent = events.find(({ kind }) => kind === "cancelled");
  assert.equal(cancellingEvent.occurredAt, intent.recordedAt);
  assert.equal(cancelledEvent.occurredAt, cancelled.job.updatedAt);
  assert.equal(
    JSON.parse(cancelledEvent.memoryRecord.content).terminal.recordedAt,
    cancelled.job.updatedAt,
  );
  for (const event of events) {
    time.advance(1_000);
    await jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  }
  assert.equal(
    (await jobs.get(cancelled.job.jobId)).terminalResult.recordedAt,
    cancelled.job.updatedAt,
  );
  await jobs.compactTerminalPrefix(compactionRequest(store, {
    targetThroughSequence: cancelled.job.sequence,
  }));
  assert.equal(
    (await jobs.get(cancelled.job.jobId)).terminalResult.recordedAt,
    cancelled.job.updatedAt,
  );
});

test("admitted and uncertain cancellations require an exact cleanup settlement", async () => {
  for (const uncertain of [false, true]) {
    const fixture = await readyStore();
    const created = await fixture.jobs.createApprovedJob(approval({
      requestId: uncertain ? "approval-request-unknown" : "approval-request-active",
    }));
    const starting = await fixture.jobs.claimStarting({
      jobId: created.job.jobId,
      expectedRevision: created.job.revision,
    });
    const workspaceRevision = "7".repeat(64);
    const active = await fixture.jobs.activate({
      jobId: created.job.jobId,
      expectedRevision: starting.job.revision,
      workspaceRevision,
    });
    const prepared = await fixture.jobs.prepareAction({
      jobId: created.job.jobId,
      expectedRevision: active.job.revision,
      action: {
        type: "list_files",
        actionId: "cancel-admitted-action",
        expectedWorkspaceRevision: workspaceRevision,
        path: ".",
      },
    });
    const pending = prepared.job.execution.pendingAction;
    const admitted = await fixture.jobs.admitAction({
      jobId: created.job.jobId,
      expectedRevision: prepared.job.revision,
      actionId: pending.actionId,
      actionDigest: pending.actionDigest,
    });
    const source = uncertain
      ? await fixture.jobs.markActionUnknown({
          jobId: created.job.jobId,
          expectedRevision: admitted.job.revision,
          actionId: pending.actionId,
          actionDigest: pending.actionDigest,
          epoch: admitted.job.execution.actionAdmission.epoch,
          code: "ACTION_RESULT_UNKNOWN",
          message: "等待执行器核验",
        })
      : admitted;
    const cancelling = await fixture.jobs.cancel({
      jobId: created.job.jobId,
      expectedRevision: source.job.revision,
      reason: "用户要求停止在途动作",
    });
    assert.equal(cancelling.job.status, "cancelling");
    assert.equal(cancelling.job.execution.result.detail.requestedFrom,
      uncertain ? "unknown" : "active");

    const admission = cancelling.job.execution.actionAdmission;
    await assert.rejects(
      fixture.jobs.recordObservation({
      jobId: created.job.jobId,
      expectedRevision: cancelling.job.revision,
      actionId: pending.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch,
      status: uncertain ? "failed" : "succeeded",
      workspaceRevision,
      detail: { reconciled: true },
      }),
      { code: "CODE_JOB_TRANSITION_CONFLICT" },
    );
    const settlement = executorCancellationProof(cancelling.job);
    await assert.rejects(
      async () => fixture.jobs.finalizeCancellation({
        jobId: created.job.jobId,
        expectedRevision: cancelling.job.revision,
        settlement: {
          ...settlement,
          actionResolution: {
            ...settlement.actionResolution,
            actionDigest: "0".repeat(64),
          },
        },
      }),
      { code: "INVALID_CODE_JOB_MUTATION" },
    );
    const cancelled = await fixture.jobs.finalizeCancellation({
      jobId: created.job.jobId,
      expectedRevision: cancelling.job.revision,
      settlement,
    });
    assert.equal(cancelled.job.status, "cancelled");
    assert.equal(cancelled.job.execution.observations.length, 0);
    assert.equal(cancelled.job.execution.pendingAction, null);
    assert.equal(cancelled.job.execution.actionAdmission, null);
    assert.equal(cancelled.job.execution.uncertainty, null);
    assert.equal(cancelled.job.execution.pause, null);
    assert.equal(
      cancelled.job.execution.cancellationSettlement.proofDigest,
      settlement.proofDigest,
    );
  }
});

test("an absent uncertain action returns to its requested pause before re-admission", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-absent-retry",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  const firstEpoch = admitted.job.execution.actionAdmission.epoch;
  const pausing = await jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    reason: "确认动作没有进入执行器",
  });
  const unknown = await jobs.markActionUnknown({
    jobId: created.job.jobId,
    expectedRevision: pausing.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: firstEpoch,
    code: "EXECUTOR_RECEIPT_UNKNOWN",
    message: "执行器结果待对账",
  });
  assert.equal(unknown.job.status, "unknown");
  assert.equal(unknown.job.execution.pause.reason, "确认动作没有进入执行器");
  assert.deepEqual(unknown.job.execution.uncertainty, {
    from: "pausing",
    code: "EXECUTOR_RECEIPT_UNKNOWN",
    message: "执行器结果待对账",
    at: unknown.job.updatedAt,
  });

  const paused = await jobs.acknowledgeAbsentAction({
    jobId: created.job.jobId,
    expectedRevision: unknown.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: firstEpoch,
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.actionAdmission, null);
  assert.equal(paused.job.execution.uncertainty, null);
  assert.equal(paused.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal((await jobs.listRunnable()).items.length, 0);

  const resumed = await jobs.resume({
    jobId: created.job.jobId,
    expectedRevision: paused.job.revision,
  });
  const readmitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: resumed.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  assert.equal(readmitted.job.status, "active");
  assert.ok(readmitted.job.execution.actionAdmission.epoch > firstEpoch);
});

test("an uncertain admitted action is durable and isolated from normal runnable work", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "read_text",
      actionId: "turn-1-unknown-read",
      expectedWorkspaceRevision: "4".repeat(64),
      path: "src/index.js",
    },
  });
  const pending = prepared.job.execution.pendingAction;
  const admitted = await jobs.admitAction({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  const admission = admitted.job.execution.actionAdmission;
  const unknown = await jobs.markActionUnknown({
    jobId: created.job.jobId,
    expectedRevision: admitted.job.revision,
    actionId: admission.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
    code: "EXECUTION_FENCED",
    message: "执行结果待对账",
  });
  assert.equal(unknown.job.status, "unknown");
  assert.equal(unknown.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal(unknown.job.execution.pause, null);
  assert.deepEqual(unknown.job.execution.uncertainty, {
    from: "active",
    code: "EXECUTION_FENCED",
    message: "执行结果待对账",
    at: unknown.job.updatedAt,
  });
  assert.equal((await jobs.listRunnable()).items.length, 0);
  assert.equal((await jobs.listReconcilable()).items[0].jobId, created.job.jobId);
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.uncertainty, unknown.job.execution.uncertainty);
  assert.equal(browser.pause, null);

  const recovered = await readyStore({ store });
  const durable = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(durable.status, "unknown");
  assert.deepEqual(
    durable.execution.uncertainty,
    unknown.job.execution.uncertainty,
  );
  assert.equal((await recovered.jobs.listRunnable()).items.length, 0);
  assert.equal((await recovered.jobs.listReconcilable()).items.length, 1);

  await assert.rejects(
    recovered.jobs.recordObservation({
      jobId: created.job.jobId,
      expectedRevision: durable.revision,
      actionId: pending.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch + 1,
      status: "succeeded",
      workspaceRevision: "4".repeat(64),
      detail: { result: { path: "src/index.js", content: "stale\n" } },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );

  const observed = await recovered.jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: durable.revision,
    actionId: pending.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { result: { path: "src/index.js", content: "safe\n" } },
  });
  assert.equal(observed.job.status, "active");
  assert.equal(observed.job.execution.pendingAction, null);
  assert.equal(observed.job.execution.actionAdmission, null);
  assert.equal(observed.job.execution.uncertainty, null);
  assert.equal((await recovered.jobs.listReconcilable()).items.length, 0);
});

test("starting session admission pauses only after absence or activation is reconciled", async () => {
  const absentFixture = await readyStore();
  const absentCreated = await absentFixture.jobs.createApprovedJob(approval());
  const absentStarting = await absentFixture.jobs.claimStarting({
    jobId: absentCreated.job.jobId,
    expectedRevision: absentCreated.job.revision,
  });
  const pausingAbsent = await absentFixture.jobs.pause({
    jobId: absentCreated.job.jobId,
    expectedRevision: absentStarting.job.revision,
    reason: "暂停工作区创建",
  });
  assert.equal(pausingAbsent.job.status, "pausing");
  assert.equal(pausingAbsent.job.execution.pause.from, "starting");
  const absent = await absentFixture.jobs.acknowledgeAbsentSession({
    jobId: absentCreated.job.jobId,
    expectedRevision: pausingAbsent.job.revision,
  });
  assert.equal(absent.job.status, "paused");
  assert.equal(absent.job.execution.pause.from, "starting");
  assert.equal(absent.job.execution.workspaceRevision, null);
  assert.equal(
    (await absentFixture.jobs.resume({
      jobId: absent.job.jobId,
      expectedRevision: absent.job.revision,
    })).job.status,
    "starting",
  );

  const activeFixture = await readyStore();
  const activeCreated = await activeFixture.jobs.createApprovedJob(
    approval({ requestId: "approval-request-start-active" }),
  );
  const activeStarting = await activeFixture.jobs.claimStarting({
    jobId: activeCreated.job.jobId,
    expectedRevision: activeCreated.job.revision,
  });
  const pausingActive = await activeFixture.jobs.pause({
    jobId: activeCreated.job.jobId,
    expectedRevision: activeStarting.job.revision,
    reason: "等待工作区创建完成",
  });
  const activated = await activeFixture.jobs.acknowledgeStartedSession({
    jobId: activeCreated.job.jobId,
    expectedRevision: pausingActive.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  assert.equal(activated.job.status, "paused");
  assert.equal(activated.job.execution.pause.from, "active");
  assert.equal(activated.job.execution.workspaceRevision, "4".repeat(64));
  assert.equal(
    (await activeFixture.jobs.resume({
      jobId: activated.job.jobId,
      expectedRevision: activated.job.revision,
    })).job.status,
    "active",
  );
});

test("schema v5 explicit null admission remains prepared but not admitted", async () => {
  const fixture = await preparedActionFixture("v5-prepared-action");
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 5;
  delete legacy.memoryProjection;
  delete legacy.changePackageDelivery;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const {
      uncertainty: _uncertainty,
      cancellationSettlement: _cancellationSettlement,
      ...execution
    } = jobValue.execution;
    const content = { ...jobValue, execution };
    delete content.recordDigest;
    return { ...content, recordDigest: digestValue(content) };
  });
  const store = new MemoryStore(legacy);
  const recovered = await readyStore({ store });

  const pending = await recovered.jobs.getForWorker(fixture.created.job.jobId);
  assert.equal(pending.status, "active");
  assert.equal(pending.execution.actionAdmission, null);
  assert.equal(pending.execution.uncertainty, null);
  await recovered.jobs.pause({
    jobId: pending.jobId,
    expectedRevision: pending.revision,
    reason: "迁移后暂停",
  });
  assert.equal(store.value.schemaVersion, 8);
});

test("schema v2 and v3 outer states recover and write back as v8", async (t) => {
  for (const schemaVersion of [2, 3]) {
    await t.test(`schema v${schemaVersion}`, async () => {
      const fixture = await readyStore();
      const created = await fixture.jobs.createApprovedJob(approval());
      const legacy = structuredClone(fixture.store.value);
      legacy.schemaVersion = schemaVersion;
      delete legacy.memoryProjection;
      delete legacy.changePackageDelivery;
      delete legacy.lastCompaction;
      if (schemaVersion === 2) delete legacy.archiveIndex;
      legacy.jobs = legacy.jobs.map((jobValue) => {
        if (schemaVersion === 2) {
          const { execution: _execution, recordDigest: _recordDigest, ...content } =
            jobValue;
          return { ...content, recordDigest: digestValue(content) };
        }
        const {
          memoryProjection: _memoryProjection,
          actionAdmission: _actionAdmission,
          uncertainty: _uncertainty,
          cancellationSettlement: _cancellationSettlement,
          ...execution
        } = jobValue.execution;
        const content = { ...jobValue, execution };
        delete content.recordDigest;
        return { ...content, recordDigest: digestValue(content) };
      });
      const store = new MemoryStore(legacy);
      const recovered = await readyStore({ store });

      const pending = await recovered.jobs.getForWorker(created.job.jobId);
      assert.equal(pending.status, "queued");
      await recovered.jobs.pause({
        jobId: pending.jobId,
        expectedRevision: pending.revision,
        reason: `升级 schema v${schemaVersion}`,
      });

      assert.equal(store.value.schemaVersion, 8);
      assert.ok(Array.isArray(store.value.archiveIndex));
      assert.equal(Object.hasOwn(store.value, "lastCompaction"), true);
    });
  }
});

test("schema v7 recovery starts package delivery empty and writes back as v8", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 7;
  delete legacy.changePackageDelivery;
  const store = new MemoryStore(legacy);
  const recovered = await readyStore({ store });

  assert.deepEqual(await recovered.jobs.readChangePackageDeliveryBatch(), {
    cursor: 0,
    highWatermark: 0,
    items: [],
  });
  assert.equal(store.value.schemaVersion, 7);
  await recovered.jobs.pause({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    reason: "升级 schema v7",
  });
  assert.equal(store.value.schemaVersion, 8);
});

test("schema v8 jobs without cancellation settlement retain durable outbox bindings", async (t) => {
  async function legacyCompletedState({ delivered }) {
    let manifest = null;
    const fixture = await completedDeliveryFixture({
      changePackageReader: {
        async get(packageId) {
          assert.equal(packageId, manifest.packageId);
          return structuredClone(manifest);
        },
      },
    });
    let memoryBatch = await fixture.jobs.readMemoryProjectionBatch();
    while (memoryBatch.items[0]?.kind !== "completed") {
      await fixture.jobs.acknowledgeMemoryProjection(
        memoryAcknowledgement(memoryBatch.items[0]),
      );
      memoryBatch = await fixture.jobs.readMemoryProjectionBatch();
    }
    assert.equal(memoryBatch.items.length, 1);

    const [packageEvent] = (
      await fixture.jobs.readChangePackageDeliveryBatch()
    ).items;
    manifest = changePackageForEvent(packageEvent);
    if (delivered) {
      await fixture.jobs.acknowledgeChangePackageDelivery(
        changePackageAcknowledgement(packageEvent, manifest),
      );
    }

    const state = structuredClone(fixture.store.value);
    const legacyJob = legacyJobWithoutCancellationSettlement(state.jobs[0]);
    state.jobs = [legacyJob];

    const previousMemoryEvent = state.memoryProjection.pending[0];
    const memoryEvent = createCodeJobMemoryEvent({
      sequence: previousMemoryEvent.sequence,
      previousDigest: previousMemoryEvent.previousDigest,
      job: legacyJob,
      kind: previousMemoryEvent.kind,
    });
    state.memoryProjection.pending = [memoryEvent];

    const previousPackageEvent = delivered
      ? state.changePackageDelivery.delivered[0]
      : state.changePackageDelivery.pending[0];
    const packageSequence = delivered
      ? previousPackageEvent.receipt.sequence
      : previousPackageEvent.sequence;
    const packagePreviousDigest = previousPackageEvent.previousDigest;
    const rebuiltPackageEvent = createCodeJobChangePackageEvent({
      sequence: packageSequence,
      previousDigest: packagePreviousDigest,
      job: legacyJob,
    });
    manifest = changePackageForEvent(rebuiltPackageEvent);
    if (delivered) {
      state.changePackageDelivery.delivered[0] = {
        previousDigest: packagePreviousDigest,
        receipt: {
          ...previousPackageEvent.receipt,
          eventId: rebuiltPackageEvent.eventId,
          eventDigest: rebuiltPackageEvent.eventDigest,
          jobId: rebuiltPackageEvent.job.id,
          sourceRecordDigest: rebuiltPackageEvent.job.recordDigest,
          packageId: manifest.packageId,
          packageDigest: manifest.packageDigest,
        },
      };
      state.changePackageDelivery.checkpointDigest =
        rebuiltPackageEvent.eventDigest;
    } else {
      state.changePackageDelivery.pending = [rebuiltPackageEvent];
    }
    return {
      state,
      memoryEvent,
      packageEvent: rebuiltPackageEvent,
      manifest,
      changePackageReader: {
        async get(packageId) {
          assert.equal(packageId, manifest.packageId);
          return structuredClone(manifest);
        },
      },
    };
  }

  await t.test("pending terminal memory and package events", async () => {
    const legacy = await legacyCompletedState({ delivered: false });
    const store = new MemoryStore(legacy.state);
    const recovered = await readyStore({
      store,
      changePackageReader: legacy.changePackageReader,
    });

    assert.deepEqual(
      (await recovered.jobs.readMemoryProjectionBatch()).items,
      [legacy.memoryEvent],
    );
    assert.deepEqual(
      (await recovered.jobs.readChangePackageDeliveryBatch()).items,
      [legacy.packageEvent],
    );
    await recovered.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(legacy.memoryEvent),
    );
    assert.equal(
      (await recovered.jobs.getForWorker(legacy.memoryEvent.jobId))
        .execution.memoryProjection.sourceRecordDigest,
      legacy.memoryEvent.sourceRecordDigest,
    );
    assert.equal(
      (await recovered.jobs.acknowledgeChangePackageDelivery(
        changePackageAcknowledgement(
          legacy.packageEvent,
          legacy.manifest,
        ),
      )).status,
      "applied",
    );
  });

  await t.test("delivered package receipt", async () => {
    const legacy = await legacyCompletedState({ delivered: true });
    const store = new MemoryStore(legacy.state);
    const recovered = await readyStore({ store });
    const deliveredReceipt = store.value.changePackageDelivery.delivered[0]
      .receipt;
    const {
      deliveredAt: _deliveredAt,
      ...acknowledgement
    } = deliveredReceipt;

    assert.deepEqual(await recovered.jobs.readChangePackageDeliveryBatch(), {
      cursor: 1,
      highWatermark: 1,
      items: [],
    });
    assert.equal(
      (await recovered.jobs.acknowledgeChangePackageDelivery(acknowledgement))
        .status,
      "already",
    );
    await recovered.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(legacy.memoryEvent),
    );
    const restarted = await readyStore({ store });
    assert.equal(
      (await restarted.jobs.getForWorker(legacy.memoryEvent.jobId))
        .execution.memoryProjection.sourceRecordDigest,
      legacy.memoryEvent.sourceRecordDigest,
    );
  });
});

test("schema v8 legacy PR package deliveries survive pending and delivered restarts", async (t) => {
  async function legacyDeliveryState({ delivered }) {
    const jobApproval = approval({
      grant: grant({
        subject: {
          id: "github:pr:acme/widgets#17",
          repository: "acme/widgets",
          number: 17,
        },
        inputBinding: legacyPullRequestInputBinding(),
      }),
    });
    const fixture = await completedDeliveryFixture({
      jobApproval,
      changePackageDelivery: false,
    });
    assert.deepEqual(await fixture.jobs.readChangePackageDeliveryBatch(), {
      cursor: 0,
      highWatermark: 0,
      items: [],
    });

    const event = persistedLegacyChangePackageEvent(fixture.completed.job);
    const manifest = changePackageForEvent(event);
    const acknowledgement = changePackageAcknowledgement(event, manifest);
    const state = structuredClone(fixture.store.value);
    state.changePackageDelivery = {
      revision: state.revision,
      nextSequence: 2,
      cursor: delivered ? 1 : 0,
      checkpointDigest: delivered ? event.eventDigest : null,
      pending: delivered ? [] : [event],
      delivered: delivered
        ? [{
            previousDigest: event.previousDigest,
            receipt: {
              ...acknowledgement,
              deliveredAt: fixture.completed.job.updatedAt,
            },
          }]
        : [],
    };
    return {
      state,
      event,
      acknowledgement,
      changePackageReader: {
        async get(packageId) {
          assert.equal(packageId, manifest.packageId);
          return structuredClone(manifest);
        },
      },
    };
  }

  await t.test("pending event resumes its existing delivery", async () => {
    const legacy = await legacyDeliveryState({ delivered: false });
    const store = new MemoryStore(legacy.state);
    const recovered = await readyStore({
      store,
      changePackageReader: legacy.changePackageReader,
    });

    assert.deepEqual(
      (await recovered.jobs.readChangePackageDeliveryBatch()).items,
      [legacy.event],
    );
    assert.equal(
      (await recovered.jobs.acknowledgeChangePackageDelivery(
        legacy.acknowledgement,
      )).status,
      "applied",
    );
    const restarted = await readyStore({ store });
    assert.deepEqual(await restarted.jobs.readChangePackageDeliveryBatch(), {
      cursor: 1,
      highWatermark: 1,
      items: [],
    });
    assert.equal(
      (await restarted.jobs.acknowledgeChangePackageDelivery(
        legacy.acknowledgement,
      )).status,
      "already",
    );
  });

  await t.test("delivered receipt remains idempotent after restart", async () => {
    const legacy = await legacyDeliveryState({ delivered: true });
    const store = new MemoryStore(legacy.state);
    const recovered = await readyStore({ store });

    assert.equal(
      (await recovered.jobs.acknowledgeChangePackageDelivery(
        legacy.acknowledgement,
      )).status,
      "already",
    );
    const restarted = await readyStore({ store });
    assert.deepEqual(await restarted.jobs.readChangePackageDeliveryBatch(), {
      cursor: 1,
      highWatermark: 1,
      items: [],
    });
  });
});

test("schema v6 recovery deterministically seeds current meaningful memory events", async (t) => {
  const scenarios = [
    ["observation", async () => {
      const fixture = await preparedActionFixture("legacy-current-observation");
      await fixture.jobs.recordObservation({
        jobId: fixture.created.job.jobId,
        expectedRevision: fixture.prepared.job.revision,
        actionId: "legacy-current-observation",
        status: "succeeded",
        workspaceRevision: "4".repeat(64),
        detail: { files: [] },
      });
      return fixture;
    }],
    ["paused", async () => {
      const fixture = await readyStore();
      const created = await fixture.jobs.createApprovedJob(approval());
      await fixture.jobs.pause({
        jobId: created.job.jobId,
        expectedRevision: created.job.revision,
        reason: "迁移暂停状态",
      });
      return fixture;
    }],
    ["unknown", async () => {
      const fixture = await preparedActionFixture("legacy-current-unknown");
      const pending = fixture.prepared.job.execution.pendingAction;
      const admitted = await fixture.jobs.admitAction({
        jobId: fixture.created.job.jobId,
        expectedRevision: fixture.prepared.job.revision,
        actionId: pending.actionId,
        actionDigest: pending.actionDigest,
      });
      await fixture.jobs.markActionUnknown({
        jobId: fixture.created.job.jobId,
        expectedRevision: admitted.job.revision,
        actionId: pending.actionId,
        actionDigest: pending.actionDigest,
        epoch: admitted.job.execution.actionAdmission.epoch,
        code: "LEGACY_UNKNOWN",
        message: "迁移未知状态",
      });
      return fixture;
    }],
    ["failed", async () => {
      const fixture = await readyStore();
      const created = await fixture.jobs.createApprovedJob(approval());
      await fixture.jobs.fail({
        jobId: created.job.jobId,
        expectedRevision: created.job.revision,
        result: { code: "LEGACY_TERMINAL" },
      });
      return fixture;
    }],
  ];

  for (const [kind, createFixture] of scenarios) {
    await t.test(kind, async () => {
      const fixture = await createFixture();
      const [original] = (
        await fixture.jobs.readMemoryProjectionBatch({ limit: 100 })
      ).items.filter((event) => event.kind === kind);
      const legacy = structuredClone(fixture.store.value);
      legacy.schemaVersion = 6;
      delete legacy.memoryProjection;
      delete legacy.changePackageDelivery;
      const store = new MemoryStore(legacy);
      const recovered = await readyStore({ store });
      const batch = await recovered.jobs.readMemoryProjectionBatch();

      assert.equal(batch.items.length, 1);
      assert.equal(batch.items[0].kind, kind);
      assert.equal(batch.items[0].eventDigest, original.eventDigest);
      assert.equal(store.value.schemaVersion, 6);
      if (kind === "failed") {
        await recovered.jobs.acknowledgeMemoryProjection(
          memoryAcknowledgement(batch.items[0]),
        );
        assert.equal(store.value.schemaVersion, 8);
      }
    });
  }
});

test("schema v6 does not replay a terminal event that already has a memory receipt", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const failed = await fixture.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "LEGACY_ALREADY_PROJECTED" },
  });
  await fixture.jobs.markMemoryProjected(memoryProjection(failed.job));
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 6;
  delete legacy.memoryProjection;
  delete legacy.changePackageDelivery;

  const recovered = await readyStore({ store: new MemoryStore(legacy) });
  assert.deepEqual(await recovered.jobs.readMemoryProjectionBatch(), {
    cursor: 0,
    highWatermark: 0,
    items: [],
  });
});

test("memory projection chain corruption is rejected before queries are served", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  await fixture.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "TAMPER_PROOF" },
  });
  const tampered = structuredClone(fixture.store.value);
  tampered.memoryProjection.pending[0].sourceRecordDigest = "0".repeat(64);

  await assert.rejects(
    readyStore({ store: new MemoryStore(tampered) }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  const [ownEvent] = (
    await fixture.jobs.readMemoryProjectionBatch()
  ).items;
  await fixture.jobs.acknowledgeMemoryProjection(
    memoryAcknowledgement(ownEvent),
  );

  const foreign = await readyStore();
  const foreignGrant = grant({
    proposalId: "work-intent-proposal-foreign-checkpoint",
    contentDigest: "4".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-foreign-checkpoint" },
    source: {
      assignmentId: "assignment-foreign-checkpoint",
      eventId: "event-foreign-checkpoint",
    },
  });
  const foreignCreated = await foreign.jobs.createApprovedJob(approval({
    confirmationId: "confirmation-code-job-foreign-checkpoint",
    requestId: "approval-request-foreign-checkpoint",
    displayedPayloadDigest: "5".repeat(64),
    approvalBindingDigest: "6".repeat(64),
    grant: foreignGrant,
  }));
  await foreign.jobs.fail({
    jobId: foreignCreated.job.jobId,
    expectedRevision: foreignCreated.job.revision,
    result: { code: "FOREIGN_CHECKPOINT" },
  });
  const [foreignEvent] = (
    await foreign.jobs.readMemoryProjectionBatch()
  ).items;
  const foreignCheckpoint = structuredClone(fixture.store.value);
  foreignCheckpoint.memoryProjection.checkpointDigest =
    foreignEvent.eventDigest;
  foreignCheckpoint.memoryProjection.lastAcknowledgement = {
    event: foreignEvent,
    receipt: memoryAcknowledgement(foreignEvent),
  };
  await assert.rejects(
    readyStore({ store: new MemoryStore(foreignCheckpoint) }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("an accepted memory checkpoint cannot be replaced by a higher-revision fork", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  await fixture.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "CHECKPOINTED" },
  });
  const beforeAcknowledgement = structuredClone(fixture.store.value);
  const [event] = (await fixture.jobs.readMemoryProjectionBatch()).items;
  await fixture.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));

  const forkStore = new MemoryStore(beforeAcknowledgement);
  const fork = await readyStore({ store: forkStore });
  const forkGrant = grant({
    proposalId: "work-intent-proposal-fork",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-fork" },
    source: { assignmentId: "assignment-fork", eventId: "event-fork" },
  });
  const forkCreated = await fork.jobs.createApprovedJob(approval({
    confirmationId: "confirmation-code-job-fork",
    requestId: "approval-request-fork",
    displayedPayloadDigest: "2".repeat(64),
    approvalBindingDigest: "3".repeat(64),
    grant: forkGrant,
  }));
  await fork.jobs.pause({
    jobId: forkCreated.job.jobId,
    expectedRevision: forkCreated.job.revision,
    reason: "形成更高修订的投影分叉",
  });
  fixture.store.value = forkStore.value;

  await assert.rejects(
    fixture.jobs.createApprovedJob(approval({ requestId: "approval-request-retry" })),
    (error) => error.code === "CODE_JOB_MEMORY_FORKED",
  );
});

test("legacy pending actions migrate to explicit admitted uncertainty", async () => {
  const fixture = await preparedActionFixture("legacy-pending-action");
  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 4;
  delete legacy.memoryProjection;
  delete legacy.changePackageDelivery;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const {
      actionAdmission: _actionAdmission,
      uncertainty: _uncertainty,
      cancellationSettlement: _cancellationSettlement,
      ...execution
    } = jobValue.execution;
    const content = { ...jobValue, execution };
    delete content.recordDigest;
    return { ...content, recordDigest: digestValue(content) };
  });
  const store = new MemoryStore(legacy);
  const recovered = await readyStore({ store });

  const uncertain = await recovered.jobs.getForWorker(
    fixture.created.job.jobId,
  );
  const pending = uncertain.execution.pendingAction;
  const admission = uncertain.execution.actionAdmission;
  assert.equal(uncertain.status, "unknown");
  assert.deepEqual(admission, {
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch: uncertain.revision,
    admittedAt: pending.preparedAt,
  });
  assert.deepEqual(uncertain.execution.uncertainty, {
    from: "active",
    code: "LEGACY_ACTION_RESULT_UNKNOWN",
    message: "Legacy pending action requires executor reconciliation",
    at: uncertain.updatedAt,
  });
  assert.equal(uncertain.execution.pause, null);

  const browser = await recovered.jobs.get(uncertain.jobId);
  assert.deepEqual(browser.uncertainty, uncertain.execution.uncertainty);
  const pausingUnknown = await recovered.jobs.pause({
    jobId: uncertain.jobId,
    expectedRevision: uncertain.revision,
    reason: "迁移后等待人工核验",
  });
  assert.equal(pausingUnknown.job.status, "unknown");
  assert.equal(pausingUnknown.job.execution.uncertainty.from, "pausing");
  assert.equal(
    pausingUnknown.job.execution.uncertainty.code,
    "LEGACY_ACTION_RESULT_UNKNOWN",
  );
  assert.equal(pausingUnknown.job.execution.pause.reason, "迁移后等待人工核验");

  const paused = await recovered.jobs.acknowledgeAbsentAction({
    jobId: uncertain.jobId,
    expectedRevision: pausingUnknown.job.revision,
    actionId: admission.actionId,
    actionDigest: admission.actionDigest,
    epoch: admission.epoch,
  });
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.execution.uncertainty, null);
  assert.equal(paused.job.execution.actionAdmission, null);
  assert.equal(paused.job.execution.pendingAction.actionId, pending.actionId);
  assert.equal(store.value.schemaVersion, 8);
});

test("terminal transitions are sealed, idempotent, and browser-safe", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const starting = await jobs.claimStarting({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
  });
  const active = await jobs.activate({
    jobId: created.job.jobId,
    expectedRevision: starting.job.revision,
    workspaceRevision: "4".repeat(64),
  });
  const result = {
    summary: "Inspection completed",
    manifest: { workspaceRevision: "4".repeat(64), checks: ["node-tests"] },
  };
  await assert.rejects(
    jobs.complete({
      jobId: created.job.jobId,
      expectedRevision: active.job.revision,
      result,
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const prepared = await jobs.prepareAction({
    jobId: created.job.jobId,
    expectedRevision: active.job.revision,
    action: {
      type: "complete",
      actionId: "turn-1-complete",
      expectedWorkspaceRevision: "4".repeat(64),
    },
  });
  const observed = await jobs.recordObservation({
    jobId: created.job.jobId,
    expectedRevision: prepared.job.revision,
    actionId: "turn-1-complete",
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: result.manifest,
  });
  const completed = await jobs.complete({
    jobId: created.job.jobId,
    expectedRevision: observed.job.revision,
    result,
  });
  assert.equal(completed.job.status, "completed");
  assert.deepEqual(completed.job.execution.result.detail, result);
  assert.equal(
    (await jobs.complete({
      jobId: created.job.jobId,
      expectedRevision: observed.job.revision,
      result: { manifest: result.manifest, summary: result.summary },
    })).status,
    "already",
  );
  await assert.rejects(
    jobs.fail({
      jobId: created.job.jobId,
      expectedRevision: completed.job.revision,
      result: { code: "LATE_FAILURE" },
    }),
    (error) => error.code === "CODE_JOB_TRANSITION_CONFLICT",
  );
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.terminalResult, {
    kind: "completed",
    recordedAt: completed.job.execution.result.recordedAt,
  });
  assert.equal(JSON.stringify(browser).includes("Inspection completed"), false);
});

test("completed package delivery intent is atomic, durable, and idempotent", async () => {
  const fixture = await completedDeliveryFixture();
  const batch = await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 });

  assert.equal(fixture.store.value.schemaVersion, 8);
  assert.equal(batch.cursor, 0);
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items.length, 1);
  assert.deepEqual(batch.items[0].job, {
    id: fixture.completed.job.jobId,
    revision: fixture.completed.job.revision,
    recordDigest: fixture.completed.job.recordDigest,
  });
  assert.deepEqual(batch.items[0].proposal, {
    id: fixture.completed.job.proposal.proposalId,
    contentDigest: fixture.completed.job.proposal.contentDigest,
  });
  assert.deepEqual(batch.items[0].grant, {
    digest: fixture.completed.job.grant.grantDigest,
  });
  assert.deepEqual(batch.items[0].exportRequest, {
    sessionId: fixture.completed.job.jobId,
    completedActionId: fixture.actionId,
    expectedWorkspaceRevision: fixture.workspaceRevision,
  });

  const writeCount = fixture.store.writeCount;
  const repeated = await fixture.jobs.complete({
    jobId: fixture.completed.job.jobId,
    expectedRevision: fixture.observed.job.revision,
    result: fixture.result,
    changePackageDelivery: true,
  });
  assert.equal(repeated.status, "already");
  assert.equal(fixture.store.writeCount, writeCount);
  assert.equal(
    (await fixture.jobs.readChangePackageDeliveryBatch()).items.length,
    1,
  );

  const recovered = await readyStore({ store: fixture.store });
  assert.deepEqual(
    await recovered.jobs.readChangePackageDeliveryBatch({ limit: 10 }),
    batch,
  );
});

test("schema v3 conflict package delivery is self-contained, recoverable, and idempotent", async () => {
  const fixture = await completedDeliveryFixture({
    jobApproval: approval({ grant: conflictGrant() }),
  });
  const batch = await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 });
  const [event] = batch.items;

  assert.equal(event.schemaVersion, 3);
  assert.equal(
    event.recordedAt,
    fixture.completed.job.execution.observations.at(-1).recordedAt,
  );
  assert.deepEqual(
    event.executionSource,
    fixture.completed.job.grant.executionSource,
  );
  const writeCount = fixture.store.writeCount;
  assert.equal((await fixture.jobs.complete({
    jobId: fixture.completed.job.jobId,
    expectedRevision: fixture.observed.job.revision,
    result: fixture.result,
    changePackageDelivery: true,
  })).status, "already");
  assert.equal(fixture.store.writeCount, writeCount);

  const recovered = await readyStore({ store: fixture.store });
  assert.deepEqual(
    await recovered.jobs.readChangePackageDeliveryBatch({ limit: 10 }),
    batch,
  );
});

test("an unchanged head repair records package-only delivery without a commit and survives restart", async () => {
  const { inputBinding, subject } = conflictGrant();
  const repair = grant({ schemaVersion: 3, inputBinding, subject, operation: "modify",
    executionSource: createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: ["src"] }),
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ["src"] });
  let manifest;
  const fixture = await completedDeliveryFixture({ jobApproval: approval({ grant: repair }),
    changePackageReader: { async get() { return structuredClone(manifest); } } });
  const [event] = (await fixture.jobs.readChangePackageDeliveryBatch({ limit: 1 })).items;
  const revision = event.exportRequest.expectedWorkspaceRevision;
  manifest = changePackageForEvent(event, { workspace: { id: "widgets-local", sourceRevision: revision, workspaceRevision: revision } });
  const request = changePackageAcknowledgement(event, manifest, { noChanges: true });
  assert.throws(() => fixture.jobs.acknowledgeChangePackageDelivery({ ...request, noChanges: false }), { code: "INVALID_CODE_JOB_MUTATION" });
  assert.throws(() => fixture.jobs.acknowledgeChangePackageDelivery({ ...request, controlledCommit: {} }), { code: "INVALID_CODE_JOB_MUTATION" });
  assert.equal((await fixture.jobs.acknowledgeChangePackageDelivery(request)).status, "applied");
  const detail = await fixture.jobs.getDetail({ jobId: fixture.completed.job.jobId });
  assert.equal(detail.changePackage.receipt.noChanges, true);
  assert.equal(detail.changePackage.receipt.controlledCommit, undefined);
  const recovered = await readyStore({ store: fixture.store,
    changePackageReader: { async get() { return structuredClone(manifest); } } });
  assert.equal((await recovered.jobs.acknowledgeChangePackageDelivery(request)).status, "already");
});

for (const variation of ["changed", "revision", "conflict"]) {
  test(`package-only delivery cannot waive commit proof for ${variation}`, async () => {
    const conflict = conflictGrant();
    const repair = variation === "conflict" ? conflict : grant({ schemaVersion: 3, inputBinding: conflict.inputBinding,
      subject: conflict.subject, operation: "modify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify], writablePaths: ["src"],
      executionSource: createReviewRepairCodeExecutionSource({ inputBinding: conflict.inputBinding, writablePaths: ["src"] }) });
    let manifest;
    const fixture = await completedDeliveryFixture({ jobApproval: approval({ grant: repair }),
      changePackageReader: { async get() { return structuredClone(manifest); } } });
    const [event] = (await fixture.jobs.readChangePackageDeliveryBatch({ limit: 1 })).items;
    const revision = event.exportRequest.expectedWorkspaceRevision;
    manifest = changePackageForEvent(event, {
      workspace: { id: "widgets-local", sourceRevision: variation === "revision" ? "3".repeat(64) : revision, workspaceRevision: revision },
      ...(variation === "changed" ? { created: [{ path: "src/new.js", content: Buffer.from("changed\n") }] } : {}),
    });
    await assert.rejects(fixture.jobs.acknowledgeChangePackageDelivery(changePackageAcknowledgement(event, manifest, { noChanges: true })),
      { code: "CODE_JOB_CHANGE_PACKAGE_BINDING_CONFLICT" });
    assert.equal((await fixture.jobs.readChangePackageDeliveryBatch()).cursor, 0);
  });
}

test("schema v3 delivery requires and retains exact controlled commit evidence", async () => {
  let manifest;
  const fixture = await completedDeliveryFixture({
    jobApproval: approval({ grant: conflictGrant() }),
    changePackageReader: {
      async get() { return structuredClone(manifest); },
    },
  });
  const [event] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 1 })
  ).items;
  manifest = changePackageForEvent(event);
  const base = changePackageAcknowledgement(event, manifest);

  await assert.rejects(
    fixture.jobs.acknowledgeChangePackageDelivery(base),
    (error) => error.code === "CODE_JOB_CHANGE_PACKAGE_BINDING_CONFLICT",
  );
  const controlledCommit = controlledCommitReceipt(event, manifest);
  assert.equal((await fixture.jobs.acknowledgeChangePackageDelivery({
    ...base,
    controlledCommit,
  })).status, "applied");
  assert.deepEqual(
    fixture.store.value.changePackageDelivery.delivered[0].receipt
      .controlledCommit,
    controlledCommit,
  );
  assert.deepEqual(
    (await fixture.jobs.getDetail({ jobId: fixture.completed.job.jobId }))
      .changePackage.receipt.controlledCommit,
    {
      receiptId: controlledCommit.receiptId,
      receiptDigest: controlledCommit.receiptDigest,
      evidenceId: controlledCommit.evidenceId,
      evidenceDigest: controlledCommit.evidenceDigest,
      commitOid: controlledCommit.commitOid,
    },
  );
  const recovered = await readyStore({
    store: fixture.store,
    changePackageReader: {
      async get() { return structuredClone(manifest); },
    },
  });
  assert.equal((await recovered.jobs.acknowledgeChangePackageDelivery({
    ...base,
    controlledCommit,
  })).status, "already");
});

test("schema v3 recovery rejects a self-consistent event bound to another conflict source", async () => {
  const fixture = await completedDeliveryFixture({
    jobApproval: approval({ grant: conflictGrant() }),
  });
  const tampered = structuredClone(fixture.store.value);
  const event = tampered.changePackageDelivery.pending[0];
  event.executionSource.preparationBinding.boundaryDigest = "e".repeat(64);
  const { eventId: _eventId, eventDigest: _eventDigest, ...content } = event;
  event.eventDigest = digestValue(content);
  event.eventId = `code-job-change-package-event-${event.eventDigest}`;
  const tamperedStore = new MemoryStore(tampered);
  let packageReads = 0;

  await assert.rejects(
    readyStore({
      store: tamperedStore,
      changePackageReader: {
        async get() {
          packageReads += 1;
          throw new Error("must not inspect packages for a mismatched source");
        },
      },
    }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
  assert.equal(packageReads, 0);
  assert.equal(tamperedStore.writeCount, 0);
});

test("package delivery chain corruption is rejected before work is served", async () => {
  const fixture = await completedDeliveryFixture();
  const tampered = structuredClone(fixture.store.value);
  tampered.changePackageDelivery.pending[0].eventDigest = "0".repeat(64);

  await assert.rejects(
    readyStore({ store: new MemoryStore(tampered) }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("package delivery acknowledgements verify immutable packages and survive lost responses", async () => {
  let manifest = null;
  const changePackageReader = {
    async get(packageId) {
      assert.equal(packageId, manifest.packageId);
      return structuredClone(manifest);
    },
  };
  const fixture = await completedDeliveryFixture({ changePackageReader });
  const [event] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  manifest = changePackageForEvent(event);
  const acknowledgement = changePackageAcknowledgement(event, manifest);

  await assert.rejects(
    fixture.jobs.acknowledgeChangePackageDelivery({
      ...acknowledgement,
      sourceRecordDigest: "0".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_CHANGE_PACKAGE_BINDING_CONFLICT",
  );
  fixture.store.writeThenFailAt = fixture.store.writeCount + 1;
  await assert.rejects(
    fixture.jobs.acknowledgeChangePackageDelivery(acknowledgement),
    /disk acknowledgement unavailable/,
  );
  const repeated = await fixture.jobs.acknowledgeChangePackageDelivery(
    acknowledgement,
  );
  assert.deepEqual(repeated, {
    status: "already",
    cursor: 1,
    highWatermark: 1,
  });
  assert.deepEqual(await fixture.jobs.readChangePackageDeliveryBatch(), {
    cursor: 1,
    highWatermark: 1,
    items: [],
  });
});

test("any retained package acknowledgement stays idempotent after later progress", async () => {
  const manifests = new Map();
  const fixture = await completedDeliveryFixture({
    changePackageReader: {
      async get(packageId) {
        return structuredClone(manifests.get(packageId));
      },
    },
  });
  const [firstEvent] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  const firstManifest = changePackageForEvent(firstEvent);
  manifests.set(firstManifest.packageId, firstManifest);
  const firstAcknowledgement = changePackageAcknowledgement(
    firstEvent,
    firstManifest,
  );
  await fixture.jobs.acknowledgeChangePackageDelivery(firstAcknowledgement);

  const secondGrant = grant({
    proposalId: "work-intent-proposal-package-second",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-package-second" },
    source: {
      assignmentId: "assignment-package-second",
      eventId: "event-package-second",
    },
  });
  await appendCompletedDelivery(
    fixture.jobs,
    approval({
      confirmationId: "confirmation-code-job-package-second",
      requestId: "approval-request-package-second",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: secondGrant,
    }),
    "complete-change-package-second",
  );
  const [secondEvent] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  const secondManifest = changePackageForEvent(secondEvent);
  manifests.set(secondManifest.packageId, secondManifest);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(secondEvent, secondManifest),
  );

  assert.deepEqual(
    Object.keys(fixture.store.value.changePackageDelivery.delivered[0]),
    ["previousDigest", "receipt"],
  );
  assert.deepEqual(
    await fixture.jobs.acknowledgeChangePackageDelivery(firstAcknowledgement),
    { status: "already", cursor: 2, highWatermark: 2 },
  );
});

test("package delivery remains pending when the immutable package is wrong or unavailable", async () => {
  let manifest = null;
  let readerFailure = null;
  const fixture = await completedDeliveryFixture({
    changePackageReader: {
      async get() {
        if (readerFailure !== null) throw readerFailure;
        return structuredClone(manifest);
      },
    },
  });
  const [event] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  manifest = changePackageForEvent(event, {
    workspace: {
      id: "foreign-local",
      sourceRevision: "3".repeat(64),
      workspaceRevision: event.exportRequest.expectedWorkspaceRevision,
    },
  });
  await assert.rejects(
    fixture.jobs.acknowledgeChangePackageDelivery(
      changePackageAcknowledgement(event, manifest),
    ),
    (error) => error.code === "CODE_JOB_CHANGE_PACKAGE_BINDING_CONFLICT",
  );

  manifest = changePackageForEvent(event);
  const acknowledgement = changePackageAcknowledgement(event, manifest);
  readerFailure = new Error("package store unavailable");
  await assert.rejects(
    fixture.jobs.acknowledgeChangePackageDelivery(acknowledgement),
    (error) => error.code === "CODE_JOB_CHANGE_PACKAGE_RECEIPT_UNVERIFIED",
  );
  assert.equal(
    (await fixture.jobs.readChangePackageDeliveryBatch()).items.length,
    1,
  );

  readerFailure = null;
  assert.equal(
    (await fixture.jobs.acknowledgeChangePackageDelivery(acknowledgement)).status,
    "applied",
  );
});

test("an accepted package checkpoint rejects a higher-revision delivery fork", async () => {
  let manifest = null;
  const changePackageReader = {
    async get() {
      return structuredClone(manifest);
    },
  };
  const fixture = await completedDeliveryFixture({ changePackageReader });
  const beforeAcknowledgement = structuredClone(fixture.store.value);
  const [event] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  manifest = changePackageForEvent(event);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(event, manifest),
  );

  const forkStore = new MemoryStore(beforeAcknowledgement);
  const fork = await readyStore({ store: forkStore, changePackageReader });
  const forkGrant = grant({
    proposalId: "work-intent-proposal-package-fork",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-package-fork" },
    source: {
      assignmentId: "assignment-package-fork",
      eventId: "event-package-fork",
    },
  });
  const forkCreated = await fork.jobs.createApprovedJob(approval({
    confirmationId: "confirmation-code-job-package-fork",
    requestId: "approval-request-package-fork",
    displayedPayloadDigest: "2".repeat(64),
    approvalBindingDigest: "3".repeat(64),
    grant: forkGrant,
  }));
  await fork.jobs.pause({
    jobId: forkCreated.job.jobId,
    expectedRevision: forkCreated.job.revision,
    reason: "形成更高修订的变更包投递分叉",
  });
  fixture.store.value = forkStore.value;

  await assert.rejects(
    fixture.jobs.createApprovedJob(
      approval({ requestId: "approval-request-package-fork-retry" }),
    ),
    (error) => error.code === "CODE_JOB_CHANGE_PACKAGE_FORKED",
  );
});

test("a completed job cannot be archived before its package delivery receipt", async () => {
  let manifest = null;
  const fixture = await completedDeliveryFixture({
    changePackageReader: {
      async get() {
        return structuredClone(manifest);
      },
    },
  });
  const memoryEvents = await fixture.jobs.readMemoryProjectionBatch({ limit: 10 });
  for (const event of memoryEvents.items) {
    await fixture.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(event),
    );
  }
  await assert.rejects(
    fixture.jobs.compactTerminalPrefix(
      compactionRequest(fixture.store, {
        compactionId: "package-delivery-pending",
        targetThroughSequence: fixture.completed.job.sequence,
      }),
    ),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );

  const [delivery] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  manifest = changePackageForEvent(delivery);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(delivery, manifest),
  );
  const compacted = await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "package-delivery-complete",
      targetThroughSequence: fixture.completed.job.sequence,
    }),
  );
  assert.equal(compacted.status, "applied");
  assert.equal(compacted.receipt.archived, 1);
});

test("pure archive adapters bind immutable records to their keys and manifest", async () => {
  let packageManifest = null;
  const fixture = await completedDeliveryFixture({
    changePackageReader: {
      async get() {
        return structuredClone(packageManifest);
      },
    },
  });
  const memoryEvents = await fixture.jobs.readMemoryProjectionBatch({
    limit: 10,
  });
  for (const event of memoryEvents.items) {
    await fixture.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(event),
    );
  }
  const [delivery] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  packageManifest = changePackageForEvent(delivery);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(delivery, packageManifest),
  );
  await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "pure-archive-adapter-fixture",
      targetThroughSequence: fixture.completed.job.sequence,
    }),
  );

  const [archiveManifest] = fixture.store.value.archiveIndex;
  const tombstoneKey = `code-job-tombstone-record-${archiveManifest.jobId}`;
  const rawTombstone = await fixture.store.read(tombstoneKey, null);
  const tombstoneBytes = JSON.stringify(rawTombstone);
  const normalizedTombstone = normalizeCodeJobArchiveTombstoneRecord(
    rawTombstone,
    { storageKey: tombstoneKey, manifest: archiveManifest },
  );
  assert.deepEqual(normalizedTombstone.tombstone, rawTombstone);
  assert.deepEqual(
    Object.keys(normalizedTombstone.bindings),
    ["job", "proposal", "confirmation", "approval"],
  );
  assert.equal(JSON.stringify(rawTombstone), tombstoneBytes);

  const indexKeys = [...fixture.store.values.keys()]
    .filter((key) => key.startsWith("code-job-tombstone-index-"))
    .sort();
  assert.equal(indexKeys.length, 4);
  const kinds = [];
  for (const storageKey of indexKeys) {
    const rawIndex = await fixture.store.read(storageKey, null);
    const indexBytes = JSON.stringify(rawIndex);
    const normalized = normalizeCodeJobArchiveIndexRecord(rawIndex, {
      storageKey,
      tombstone: normalizedTombstone.tombstone,
    });
    kinds.push(normalized.kind);
    assert.deepEqual(normalized.index, rawIndex);
    assert.equal(JSON.stringify(rawIndex), indexBytes);
  }
  assert.deepEqual(kinds.sort(), [
    "approval",
    "confirmation",
    "job",
    "proposal",
  ]);

  assert.throws(
    () =>
      normalizeCodeJobArchiveTombstoneRecord(rawTombstone, {
        storageKey: `${tombstoneKey}-wrong`,
        manifest: archiveManifest,
    }),
    (error) => error?.code === "CODE_JOB_ARCHIVE_CORRUPTED",
  );
  const firstRawIndex = await fixture.store.read(indexKeys[0], null);
  assert.throws(
    () =>
      normalizeCodeJobArchiveIndexRecord(
        firstRawIndex,
        {
          storageKey: `${indexKeys[0]}0`,
          tombstone: normalizedTombstone.tombstone,
        },
      ),
    (error) => error?.code === "CODE_JOB_ARCHIVE_CORRUPTED",
  );
});

test("archived package delivery remains bound to the exact completed job version", async () => {
  let manifest = null;
  const changePackageReader = {
    async get() {
      return structuredClone(manifest);
    },
  };
  const fixture = await completedDeliveryFixture({ changePackageReader });
  const memoryEvents = await fixture.jobs.readMemoryProjectionBatch({ limit: 100 });
  for (const event of memoryEvents.items) {
    await fixture.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  }
  const [delivery] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 10 })
  ).items;
  manifest = changePackageForEvent(delivery);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(delivery, manifest),
  );
  await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "package-delivery-archive-binding",
      targetThroughSequence: fixture.completed.job.sequence,
    }),
  );
  await readyStore({ store: fixture.store, changePackageReader });
  const durable = structuredClone(fixture.store.value);

  const forgedContent = {
    schemaVersion: delivery.schemaVersion,
    sequence: delivery.sequence,
    previousDigest: delivery.previousDigest,
    job: delivery.job,
    proposal: delivery.proposal,
    grant: delivery.grant,
    exportRequest: {
      ...delivery.exportRequest,
      expectedWorkspaceRevision: "8".repeat(64),
    },
  };
  const forgedDigest = digestValue(forgedContent);
  const rebound = structuredClone(durable);
  rebound.changePackageDelivery.delivered[0].receipt.eventId =
    `code-job-change-package-event-${forgedDigest}`;
  rebound.changePackageDelivery.delivered[0].receipt.eventDigest = forgedDigest;
  rebound.changePackageDelivery.checkpointDigest = forgedDigest;
  const truncated = structuredClone(durable);
  truncated.changePackageDelivery = {
    revision: 0,
    nextSequence: 1,
    cursor: 0,
    checkpointDigest: null,
    pending: [],
    delivered: [],
  };

  for (const tampered of [rebound, truncated]) {
    fixture.store.value = tampered;
    await assert.rejects(
      readyStore({ store: fixture.store, changePackageReader }),
      (error) => error.code === "CODE_JOB_ARCHIVE_CORRUPTED",
    );
  }
});

test("job detail reports authoritative pending, ready, and archived package delivery", async () => {
  let manifest = null;
  const fixture = await completedDeliveryFixture({
    changePackageReader: {
      async get() {
        return structuredClone(manifest);
      },
    },
  });
  const pending = await fixture.jobs.getDetail({
    jobId: fixture.completed.job.jobId,
  });
  assert.deepEqual(pending.changePackage, {
    status: "pending",
    receipt: null,
  });
  assert.deepEqual(pending.terminalDetail, fixture.result);

  const [event] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 1 })
  ).items;
  manifest = changePackageForEvent(event);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(event, manifest),
  );
  const ready = await fixture.jobs.getDetail({
    jobId: fixture.completed.job.jobId,
  });
  assert.deepEqual(ready.changePackage, {
    status: "ready",
    receipt: {
      packageId: manifest.packageId,
      packageDigest: manifest.packageDigest,
      deliveredAt:
        fixture.store.value.changePackageDelivery.delivered[0].receipt.deliveredAt,
    },
  });

  const memoryEvents = await fixture.jobs.readMemoryProjectionBatch({ limit: 20 });
  for (const memoryEvent of memoryEvents.items) {
    await fixture.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(memoryEvent),
    );
  }
  await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "job-detail-archive",
      targetThroughSequence: fixture.completed.job.sequence,
    }),
  );
  const archived = await fixture.jobs.getDetail({
    jobId: fixture.completed.job.jobId,
  });
  assert.equal(archived.archived, true);
  assert.equal(archived.historyAvailable, false);
  assert.deepEqual(archived.observations, []);
  assert.equal(archived.nextCursor, null);
  assert.equal(archived.terminalDetail, null);
  assert.deepEqual(archived.changePackage, ready.changePackage);
  assert.deepEqual(archived.job.evidence, fixture.completed.job.grant.evidence);
});

test("delivery evidence exact reads survive compaction and abort archive I/O without entering the mutation queue", async () => {
  const queued = new OperationQueue();
  const operationQueue = {
    count: 0,
    enqueue(operation) {
      this.count += 1;
      return queued.enqueue(operation);
    },
  };
  let manifest = null;
  const changePackageReader = {
    async get() {
      return structuredClone(manifest);
    },
  };
  const fixture = await completedDeliveryFixture({
    operationQueue,
    changePackageReader,
  });
  const [delivery] = (
    await fixture.jobs.readChangePackageDeliveryBatch({ limit: 1 })
  ).items;
  manifest = changePackageForEvent(delivery);
  await fixture.jobs.acknowledgeChangePackageDelivery(
    changePackageAcknowledgement(delivery, manifest),
  );
  const memoryEvents = await fixture.jobs.readMemoryProjectionBatch({ limit: 20 });
  for (const event of memoryEvents.items) {
    await fixture.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  }

  const countBeforeLiveRead = operationQueue.count;
  const live = await fixture.jobs.readDeliveryEvidence({
    jobId: fixture.completed.job.jobId,
  });
  assert.equal(operationQueue.count, countBeforeLiveRead);
  assert.equal(live.archived, false);
  assert.equal(live.job.status, "completed");
  assert.match(live.job.memoryProjection.recordId, /^memory-[a-f0-9]{64}$/);
  assert.equal(live.changePackage.status, "ready");

  await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "delivery-evidence-exact-archive",
      targetThroughSequence: fixture.completed.job.sequence,
    }),
  );
  const countBeforeArchiveRead = operationQueue.count;
  const archived = await fixture.jobs.readDeliveryEvidence({
    jobId: fixture.completed.job.jobId,
  });
  assert.equal(operationQueue.count, countBeforeArchiveRead);
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.job, live.job);
  assert.deepEqual(archived.changePackage, live.changePackage);

  const recovered = await readyStore({
    store: fixture.store,
    changePackageReader,
  });
  assert.deepEqual(
    await recovered.jobs.readDeliveryEvidence({
      jobId: fixture.completed.job.jobId,
    }),
    archived,
  );

  const originalRead = fixture.store.read.bind(fixture.store);
  let receivedSignal = null;
  fixture.store.read = async (name, fallback, options) => {
    if (name.includes("code-job-tombstone-index")) {
      receivedSignal = options?.signal ?? null;
      return new Promise(() => {});
    }
    return originalRead(name, fallback, options);
  };
  const controller = new AbortController();
  const pending = fixture.jobs.readDeliveryEvidence({
    jobId: fixture.completed.job.jobId,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
  fixture.store.read = originalRead;
  assert.deepEqual(
    await fixture.jobs.readDeliveryEvidence({
      jobId: fixture.completed.job.jobId,
    }),
    archived,
  );
});

test("meaningful lifecycle changes append one ordered durable memory event", async () => {
  const fixture = await preparedActionFixture("memory-stream-observation");
  const observed = await fixture.jobs.recordObservation({
    jobId: fixture.created.job.jobId,
    expectedRevision: fixture.prepared.job.revision,
    actionId: "memory-stream-observation",
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { files: ["src/index.js"] },
  });
  const paused = await fixture.jobs.pause({
    jobId: observed.job.jobId,
    expectedRevision: observed.job.revision,
    reason: "等待记忆投影测试",
  });
  const resumed = await fixture.jobs.resume({
    jobId: paused.job.jobId,
    expectedRevision: paused.job.revision,
  });
  await fixture.jobs.fail({
    jobId: resumed.job.jobId,
    expectedRevision: resumed.job.revision,
    result: { code: "MEMORY_STREAM_TEST_DONE" },
  });

  const batch = await fixture.jobs.readMemoryProjectionBatch({ limit: 10 });
  assert.equal(batch.cursor, 0);
  assert.equal(batch.highWatermark, 4);
  assert.deepEqual(batch.items.map(({ kind }) => kind), [
    "observation",
    "paused",
    "resumed",
    "failed",
  ]);
  assert.deepEqual(batch.items.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.equal(batch.items[0].previousDigest, null);
  assert.equal(batch.items[1].previousDigest, batch.items[0].eventDigest);
  assert.equal(fixture.store.value.schemaVersion, 8);

  const repeated = await fixture.jobs.recordObservation({
    jobId: fixture.created.job.jobId,
    expectedRevision: fixture.prepared.job.revision,
    actionId: "memory-stream-observation",
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { files: ["src/index.js"] },
  });
  assert.equal(repeated.status, "already");
  assert.equal(
    (await fixture.jobs.readMemoryProjectionBatch({ limit: 10 })).highWatermark,
    4,
  );
});

test("unknown action recovery emits one unknown event and one reconciled event", async () => {
  const fixture = await preparedActionFixture("memory-unknown-action");
  const pending = fixture.prepared.job.execution.pendingAction;
  const admitted = await fixture.jobs.admitAction({
    jobId: fixture.created.job.jobId,
    expectedRevision: fixture.prepared.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
  });
  const epoch = admitted.job.execution.actionAdmission.epoch;
  const unknown = await fixture.jobs.markActionUnknown({
    jobId: fixture.created.job.jobId,
    expectedRevision: admitted.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch,
    code: "RESULT_UNKNOWN",
    message: "执行结果需要可信对账",
  });
  assert.equal(
    (await fixture.jobs.markActionUnknown({
      jobId: fixture.created.job.jobId,
      expectedRevision: admitted.job.revision,
      actionId: pending.actionId,
      actionDigest: pending.actionDigest,
      epoch,
      code: "RESULT_UNKNOWN",
      message: "执行结果需要可信对账",
    })).status,
    "already",
  );
  await fixture.jobs.recordObservation({
    jobId: fixture.created.job.jobId,
    expectedRevision: unknown.job.revision,
    actionId: pending.actionId,
    actionDigest: pending.actionDigest,
    epoch,
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { files: [] },
  });

  const batch = await fixture.jobs.readMemoryProjectionBatch();
  assert.deepEqual(batch.items.map(({ kind }) => kind), [
    "unknown",
    "reconciled",
  ]);
});

test("memory acknowledgements are receipt-verified, prefix ordered, and terminally atomic", async () => {
  const fixture = await preparedActionFixture("memory-prefix-observation");
  const observed = await fixture.jobs.recordObservation({
    jobId: fixture.created.job.jobId,
    expectedRevision: fixture.prepared.job.revision,
    actionId: "memory-prefix-observation",
    status: "succeeded",
    workspaceRevision: "4".repeat(64),
    detail: { files: ["README.md"] },
  });
  const paused = await fixture.jobs.pause({
    jobId: observed.job.jobId,
    expectedRevision: observed.job.revision,
    reason: "验证投影前缀",
  });
  const resumed = await fixture.jobs.resume({
    jobId: paused.job.jobId,
    expectedRevision: paused.job.revision,
  });
  const failed = await fixture.jobs.fail({
    jobId: resumed.job.jobId,
    expectedRevision: resumed.job.revision,
    result: { code: "PREFIX_TEST_DONE" },
  });
  const { items } = await fixture.jobs.readMemoryProjectionBatch({ limit: 10 });

  await assert.rejects(
    fixture.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(items[1])),
    (error) => error.code === "CODE_JOB_MEMORY_ORDER_CONFLICT",
  );
  await assert.rejects(
    fixture.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(items[0], {
      sourceRecordDigest: "0".repeat(64),
    })),
    (error) => error.code === "CODE_JOB_MEMORY_BINDING_CONFLICT",
  );

  const firstRequest = memoryAcknowledgement(items[0]);
  const first = await fixture.jobs.acknowledgeMemoryProjection(firstRequest);
  assert.deepEqual(first, { status: "applied", cursor: 1, highWatermark: 4 });
  assert.equal(
    (await fixture.jobs.getForWorker(failed.job.jobId)).execution.memoryProjection,
    null,
  );
  assert.equal(
    (await fixture.jobs.acknowledgeMemoryProjection(firstRequest)).status,
    "already",
  );
  for (const event of items.slice(1)) {
    await fixture.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(event),
    );
  }

  const projected = await fixture.jobs.getForWorker(failed.job.jobId);
  const terminalRecord = normalizeMemoryRecord(
    memoryRecordForCodeJobEvent(items.at(-1)),
  );
  assert.equal(projected.execution.memoryProjection.sourceRevision, failed.job.revision);
  assert.equal(
    projected.execution.memoryProjection.sourceRecordDigest,
    failed.job.recordDigest,
  );
  assert.equal(
    projected.execution.memoryProjection.memoryRecordId,
    terminalRecord.recordId,
  );
  assert.ok(projected.revision > failed.job.revision + 1);
  assert.deepEqual(await fixture.jobs.readMemoryProjectionBatch(), {
    cursor: 4,
    highWatermark: 4,
    items: [],
  });

  const forged = structuredClone(fixture.store.value);
  const { recordDigest: _recordDigest, ...forgedContent } = forged.jobs[0];
  forgedContent.execution.memoryProjection.sourceRecordDigest = "0".repeat(64);
  forged.jobs[0] = {
    ...forgedContent,
    recordDigest: digestValue(forgedContent),
  };
  await assert.rejects(
    readyStore({ store: new MemoryStore(forged) }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );

  const compacted = await fixture.jobs.compactTerminalPrefix(
    compactionRequest(fixture.store, {
      compactionId: "memory-revision-gap-compaction",
      targetThroughSequence: projected.sequence,
    }),
  );
  assert.equal(compacted.status, "applied");
  const recoveredArchive = await readyStore({ store: fixture.store });
  assert.equal(
    (await recoveredArchive.jobs.get(projected.jobId)).status,
    "failed",
  );
});

test("a persisted memory acknowledgement returns already after write acknowledgement loss", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  await jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "ACK_LOSS" },
  });
  const [event] = (await jobs.readMemoryProjectionBatch()).items;
  const request = memoryAcknowledgement(event);
  store.writeThenFailAt = store.writeCount + 1;

  await assert.rejects(
    jobs.acknowledgeMemoryProjection(request),
    /disk acknowledgement unavailable/,
  );
  const retry = await jobs.acknowledgeMemoryProjection(request);
  assert.deepEqual(retry, { status: "already", cursor: 1, highWatermark: 1 });
  assert.equal(store.value.memoryProjection.pending.length, 0);
  assert.notEqual(store.value.jobs[0].execution.memoryProjection, null);

  const tampered = structuredClone(store.value);
  tampered.memoryProjection.lastAcknowledgement.receipt.sourceRecordDigest =
    "0".repeat(64);
  await assert.rejects(
    readyStore({ store: new MemoryStore(tampered) }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("an unverified memory receipt leaves the terminal event pending for retry", async () => {
  const store = new MemoryStore();
  const unavailable = await readyStore({
    store,
    memoryReceiptVerifier: {
      verify() {
        throw new Error("memory journal unavailable");
      },
    },
  });
  const created = await unavailable.jobs.createApprovedJob(approval());
  await unavailable.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "MEMORY_UNAVAILABLE" },
  });
  const [event] = (await unavailable.jobs.readMemoryProjectionBatch()).items;

  await assert.rejects(
    unavailable.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event)),
    (error) => error.code === "CODE_JOB_MEMORY_RECEIPT_UNVERIFIED",
  );
  assert.equal(store.value.memoryProjection.cursor, 0);
  assert.equal(store.value.memoryProjection.pending.length, 1);
  assert.equal(store.value.jobs[0].execution.memoryProjection, null);

  const recovered = await readyStore({ store });
  assert.equal(
    (await recovered.jobs.acknowledgeMemoryProjection(
      memoryAcknowledgement(event),
    )).status,
    "applied",
  );
});

test("action admission reserves enough durable space for its later observation event", async () => {
  const fixture = await preparedActionFixture("memory-headroom-action");
  const durable = structuredClone(fixture.store.value);
  const maximumStateBytes =
    Buffer.byteLength(JSON.stringify(durable), "utf8") + 320 * 1024 - 1;
  const constrainedStore = new MemoryStore(durable);
  const constrained = await readyStore({
    store: constrainedStore,
    limits: { maximumStateBytes },
  });
  const pending = fixture.prepared.job.execution.pendingAction;

  await assert.rejects(
    constrained.jobs.admitAction({
      jobId: fixture.created.job.jobId,
      expectedRevision: fixture.prepared.job.revision,
      actionId: pending.actionId,
      actionDigest: pending.actionDigest,
    }),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );
  assert.equal(
    constrainedStore.value.jobs[0].execution.actionAdmission,
    null,
  );
});

async function pinnedHistoryFixture({ projected = true } = {}) {
  const f = await readyStore();
  const first = (await f.jobs.createApprovedJob(approval())).job;
  const paused = (await f.jobs.pause({ jobId: first.jobId, expectedRevision: first.revision, reason: 'owner hold' })).job;
  const create = index => f.jobs.createApprovedJob(approval({ confirmationId: `confirmation-history-${index}`,
    displayedPayloadDigest: String(index).repeat(64), approvalBindingDigest: String(index + 3).repeat(64),
    requestId: `request-history-${index}`, grant: grant({ proposalId: `proposal-history-${index}`,
      contentDigest: String(index).repeat(64), requestedBy: { roleId: 'developer', workItemId: `work-history-${index}` },
      source: { assignmentId: `assignment-history-${index}`, eventId: `event-history-${index}` } }) }));
  const history = (await create(2)).job;
  await f.jobs.fail({ jobId: history.jobId, expectedRevision: history.revision,
    result: { code: 'HISTORICAL_FAILURE', detail: 'x'.repeat(96 * 1024) } });
  if (projected) for (const event of (await f.jobs.readMemoryProjectionBatch({ limit: 100 })).items) {
    await f.jobs.acknowledgeMemoryProjection(memoryAcknowledgement(event));
  }
  const third = (await create(3)).job;
  const starting = (await f.jobs.claimStarting({ jobId: third.jobId, expectedRevision: third.revision })).job;
  const active = (await f.jobs.activate({ jobId: third.jobId, expectedRevision: starting.revision, workspaceRevision: '4'.repeat(64) })).job;
  const prepared = (await f.jobs.prepareAction({ jobId: third.jobId, expectedRevision: active.revision,
    action: { type: 'read_text', actionId: 'read-after-pinned-history', path: 'src/app.js', expectedWorkspaceRevision: '4'.repeat(64) } })).job;
  return { ...f, paused, prepared, historyId: history.jobId };
}

test('a user-held prefix cannot let projected terminal history consume active action headroom', async () => {
  const f = await pinnedHistoryFixture(), before = structuredClone(f.store.value);
  const maximumStateBytes = Buffer.byteLength(JSON.stringify(before), 'utf8') + 250 * 1024;
  const limits = { maximumStateBytes, maximumJobs: 2 };
  const constrained = await readyStore({ store: f.store, time: f.time, limits });
  const pending = f.prepared.execution.pendingAction;
  const admitted = await constrained.jobs.admitAction({ jobId: f.prepared.jobId, expectedRevision: f.prepared.revision,
    actionId: pending.actionId, actionDigest: pending.actionDigest });
  assert.equal(admitted.status, 'applied');
  assert.deepEqual(await constrained.jobs.getForWorker(f.paused.jobId), f.paused);
  assert.deepEqual(await constrained.jobs.getForWorker(f.historyId), before.jobs.find(job => job.jobId === f.historyId));
  const recovered = await readyStore({ store: f.store, time: f.time, limits });
  assert.equal((await recovered.jobs.getForWorker(f.prepared.jobId)).execution.actionAdmission.actionId, pending.actionId);
  assert.equal(f.store.value.archive.throughSequence, 0);
});

test('restart accepts bounded retained history above the live byte budget without rewriting it', async () => {
  const f = await pinnedHistoryFixture(), before = structuredClone(f.store.value);
  const limits = { maximumStateBytes: Buffer.byteLength(JSON.stringify(before), 'utf8') - 50 * 1024 };
  const recovered = await readyStore({ store: f.store, time: f.time, limits });
  assert.deepEqual(await recovered.jobs.getForWorker(f.historyId), before.jobs.find(job => job.jobId === f.historyId));
  assert.deepEqual(f.store.value, before);
  await assert.rejects(readyStore({ store: f.store, time: f.time, limits: { ...limits, maximumArchiveBytes: 1 } }),
    { code: 'CODE_JOB_STATE_CORRUPTED' });
});

for (const projected of [false, true]) test(`pinned history cannot bypass unprojected work or exhausted historical storage: projected=${projected}`, async () => {
  const f = await pinnedHistoryFixture({ projected });
  const limits = { maximumStateBytes: Buffer.byteLength(JSON.stringify(f.store.value), 'utf8') + 250 * 1024,
    ...(projected ? { maximumArchiveBytes: 1 } : {}) };
  const constrained = await readyStore({ store: f.store, time: f.time, limits });
  const pending = f.prepared.execution.pendingAction;
  await assert.rejects(constrained.jobs.admitAction({ jobId: f.prepared.jobId, expectedRevision: f.prepared.revision,
    actionId: pending.actionId, actionDigest: pending.actionDigest }), { code: 'CODE_JOB_RETENTION_BLOCKED' });
  assert.equal((await constrained.jobs.getForWorker(f.prepared.jobId)).execution.actionAdmission, null);
});

test("memory projection receipt is exact, CAS-bound, and idempotent after acknowledgement loss", async () => {
  const { jobs, store } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const failed = await jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "BRAIN_UNAVAILABLE" },
  });
  const request = memoryProjection(failed.job);
  assert.throws(
    () =>
      jobs.markMemoryProjected({
        ...request,
        memoryRecordId: `memory-${"8".repeat(64)}`,
      }),
    (error) => error.code === "INVALID_CODE_JOB_MUTATION",
  );
  store.writeThenFailAt = store.writeCount + 1;
  await assert.rejects(
    jobs.markMemoryProjected(request),
    /disk acknowledgement unavailable/,
  );
  const repeated = await jobs.markMemoryProjected(request);
  assert.equal(repeated.status, "already");
  assert.equal(
    repeated.job.execution.memoryProjection.sourceRecordDigest,
    failed.job.recordDigest,
  );
  assert.equal(
    repeated.job.execution.memoryProjection.sourceRevision,
    failed.job.revision,
  );
  assert.equal(
    repeated.job.execution.memoryProjection.memoryRecordId,
    request.memoryRecordId,
  );
  await assert.rejects(
    jobs.markMemoryProjected({
      ...request,
      memoryRecordId: `memory-${"8".repeat(64)}`,
      memoryRecordDigest: "8".repeat(64),
    }),
    (error) => error.code === "CODE_JOB_MEMORY_BINDING_CONFLICT",
  );
  const browser = await jobs.get(created.job.jobId);
  assert.deepEqual(browser.memoryProjection, {
    recordId: request.memoryRecordId,
    projectedAt: repeated.job.execution.memoryProjection.projectedAt,
  });
  assert.equal(JSON.stringify(browser).includes(failed.job.recordDigest), false);
});

test("schema v5 terminal digest and memory receipt recover without uncertainty", async () => {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval());
  const failed = await fixture.jobs.fail({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code: "LEGACY_MEMORY_SOURCE" },
  });
  await fixture.jobs.markMemoryProjected(memoryProjection(failed.job));

  const legacy = structuredClone(fixture.store.value);
  legacy.schemaVersion = 5;
  delete legacy.memoryProjection;
  delete legacy.changePackageDelivery;
  legacy.jobs = legacy.jobs.map((jobValue) => {
    const { recordDigest: _recordDigest, ...projectedContent } = jobValue;
    const receipt = projectedContent.execution.memoryProjection;
    const {
      uncertainty: _sourceUncertainty,
      cancellationSettlement: _sourceCancellationSettlement,
      ...sourceExecution
    } = {
      ...projectedContent.execution,
      memoryProjection: null,
    };
    const oldSourceContent = {
      ...projectedContent,
      revision: receipt.sourceRevision,
      updatedAt: receipt.sourceUpdatedAt,
      execution: sourceExecution,
    };
    const oldSourceRecordDigest = digestValue(oldSourceContent);
    const {
      uncertainty: _projectedUncertainty,
      cancellationSettlement: _projectedCancellationSettlement,
      ...projectedExecution
    } = projectedContent.execution;
    projectedExecution.memoryProjection = {
      ...projectedExecution.memoryProjection,
      sourceRecordDigest: oldSourceRecordDigest,
    };
    const oldProjectedContent = {
      ...projectedContent,
      execution: projectedExecution,
    };
    return {
      ...oldProjectedContent,
      recordDigest: digestValue(oldProjectedContent),
    };
  });

  const legacyReceipt = structuredClone(
    legacy.jobs[0].execution.memoryProjection,
  );
  const recovered = await readyStore({ store: new MemoryStore(legacy) });
  const terminal = await recovered.jobs.getForWorker(created.job.jobId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.execution.uncertainty, null);
  assert.deepEqual(
    terminal.execution.memoryProjection,
    legacyReceipt,
  );
  assert.notEqual(terminal.recordDigest, legacy.jobs[0].recordDigest);
});

test("unprojected terminal work cannot be compacted or silently evicted for capacity", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 1 } });
  const first = await jobs.createApprovedJob(approval());
  const failed = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    result: { code: "STOPPED_BEFORE_MEMORY" },
  });
  await assert.rejects(
    jobs.compactTerminalPrefix(
      compactionRequest(store, { targetThroughSequence: failed.job.sequence }),
    ),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );
  assert.equal(store.value.archive.throughSequence, 0);
  const secondRequest = approval({
    confirmationId: "confirmation-code-job-approval-2",
    requestId: "approval-request-0002",
    displayedPayloadDigest: "2".repeat(64),
    approvalBindingDigest: "3".repeat(64),
    grant: grant({
      proposalId: "work-intent-proposal-2",
      contentDigest: "1".repeat(64),
      requestedBy: { roleId: "tester", workItemId: "work-2" },
      source: { assignmentId: "assignment-2", eventId: "event-2" },
    }),
  });
  await assert.rejects(
    jobs.createApprovedJob(secondRequest),
    (error) => error.code === "CODE_JOB_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.jobs[0].jobId, first.job.jobId);
  const projected = await jobs.markMemoryProjected(memoryProjection(failed.job));
  assert.equal(projected.status, "applied");
  assert.equal((await jobs.createApprovedJob(secondRequest)).status, "applied");
  assert.equal(store.value.archive.throughSequence, 1);
});

test("terminal prefix retention frees capacity and seals archive continuity", async () => {
  const { jobs, store } = await readyStore({ limits: { maximumJobs: 2 } });
  const first = await jobs.createApprovedJob(approval());
  const failedFirst = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    result: { code: "BRAIN_UNAVAILABLE", summary: "Could not start" },
  });
  await jobs.markMemoryProjected(memoryProjection(failedFirst.job));
  const liveFirst = await jobs.get(first.job.jobId);
  const secondGrant = grant({
    proposalId: "work-intent-proposal-2",
    contentDigest: "1".repeat(64),
    requestedBy: { roleId: "developer", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
  });
  await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-2",
      requestId: "approval-request-0002",
      displayedPayloadDigest: "2".repeat(64),
      approvalBindingDigest: "3".repeat(64),
      grant: secondGrant,
    }),
  );
  const thirdGrant = grant({
    proposalId: "work-intent-proposal-3",
    contentDigest: "6".repeat(64),
    requestedBy: { roleId: "tester", workItemId: "work-3" },
    source: { assignmentId: "assignment-3", eventId: "event-3" },
  });
  const third = await jobs.createApprovedJob(
    approval({
      confirmationId: "confirmation-code-job-approval-3",
      requestId: "approval-request-0003",
      displayedPayloadDigest: "7".repeat(64),
      approvalBindingDigest: "8".repeat(64),
      grant: thirdGrant,
    }),
  );

  assert.equal(third.status, "applied");
  assert.equal(store.value.jobs.length, 2);
  assert.deepEqual(store.value.jobs.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(store.value.archive.throughSequence, 1);
  assert.equal(store.value.archive.jobCount, 1);
  assert.match(store.value.archive.digest, /^[a-f0-9]{64}$/);
  const archivedFirst = await jobs.get(first.job.jobId);
  assert.equal(archivedFirst.status, "failed");
  assert.equal(archivedFirst.uncertainty, null);
  assert.deepEqual(archivedFirst, liveFirst);
  const archivedRetry = await jobs.createApprovedJob(
    approval({ requestId: "approval-request-archived-retry" }),
  );
  assert.equal(archivedRetry.status, "already");
  assert.equal(archivedRetry.job.status, "failed");
  assert.equal(
    (await jobs.reconcileApprovedJob(
      approval({ requestId: "approval-request-archived-reconcile" }),
    )).status,
    "already",
  );
  await assert.rejects(
    jobs.createApprovedJob(
      approval({
        requestId: "approval-request-archived-conflict",
        approvalBindingDigest: "0".repeat(64),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  await assert.rejects(
    jobs.reconcileApprovedJob(
      approval({
        requestId: "approval-request-archived-grant-conflict",
        grant: grant({ summary: "Changed after archive" }),
      }),
    ),
    (error) => error.code === "CODE_JOB_BINDING_CONFLICT",
  );
  assert.equal(store.value.jobs.length, 2);
  const recovered = await readyStore({
    store,
    limits: { maximumJobs: 2 },
  });
  assert.equal((await recovered.jobs.list()).archive.throughSequence, 1);

  const tampered = structuredClone(store.value);
  tampered.archive.digest = "0".repeat(64);
  await assert.rejects(
    readyStore({
      store: new MemoryStore(tampered),
      limits: { maximumJobs: 2 },
    }),
    (error) => error.code === "CODE_JOB_STATE_CORRUPTED",
  );
});

test("a queued job can fail closed as fenced without creating an executor session", async () => {
  const { jobs } = await readyStore();
  const created = await jobs.createApprovedJob(approval());
  const fenced = await jobs.fence({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: {
      code: "AUTHORITY_CHANGED",
      summary: "Workspace authority changed before start",
    },
  });
  assert.equal(fenced.job.status, "fenced");
  assert.equal(fenced.job.execution.sessionId, null);
  assert.equal(fenced.job.execution.result.kind, "fenced");
  assert.equal((await jobs.list({ status: "fenced" })).total, 1);
  assert.equal((await jobs.listRunnable()).items.length, 0);
});

test("explicit compaction archives only a terminal prefix, never paused work", async () => {
  const { jobs, store } = await readyStore();
  const first = await jobs.createApprovedJob(approval());
  const paused = await jobs.pause({
    jobId: first.job.jobId,
    expectedRevision: first.job.revision,
    reason: "用户暂停",
  });
  await assert.rejects(
    jobs.compactTerminalPrefix(
      compactionRequest(store, { targetThroughSequence: paused.job.sequence }),
    ),
    (error) => error.code === "CODE_JOB_RETENTION_BLOCKED",
  );
  assert.equal(store.value.archive.throughSequence, 0);

  const resumed = await jobs.resume({
    jobId: first.job.jobId,
    expectedRevision: paused.job.revision,
  });
  const failed = await jobs.fail({
    jobId: first.job.jobId,
    expectedRevision: resumed.job.revision,
    result: { code: "STOPPED" },
  });
  const projected = await jobs.markMemoryProjected(memoryProjection(failed.job));
  const compacted = await jobs.compactTerminalPrefix(
    compactionRequest(store, {
      compactionId: "code-job-compaction-projected",
      targetThroughSequence: projected.job.sequence,
    }),
  );
  assert.equal(compacted.status, "applied");
  assert.equal(compacted.receipt.archived, 1);
  assert.equal(compacted.receipt.targetThroughSequence, 1);
  assert.equal((await jobs.list()).archive.throughSequence, 1);
  assert.equal((await jobs.list()).total, 0);
});

async function archivedVerificationFixture(code, {
  operation = "verify",
  terminalMethod = "fail",
} = {}) {
  const fixture = await readyStore();
  const created = await fixture.jobs.createApprovedJob(approval({
    grant: grant({
      operation,
      requestedBy: { roleId: "tester", workItemId: "work-1" },
      allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[operation]],
    }),
  }));
  const failed = await fixture.jobs[terminalMethod]({
    jobId: created.job.jobId,
    expectedRevision: created.job.revision,
    result: { code, summary: "Private detail C:\\private\\test-output.log" },
  });
  await fixture.jobs.markMemoryProjected(memoryProjection(failed.job));
  const live = await fixture.jobs.get(created.job.jobId);
  await fixture.jobs.compactTerminalPrefix(compactionRequest(fixture.store, {
    targetThroughSequence: failed.job.sequence,
  }));
  const manifest = fixture.store.value.archiveIndex[0];
  const storageKey = `code-job-tombstone-record-${manifest.jobId}`;
  return {
    ...fixture,
    live,
    manifest,
    storageKey,
    tombstone: await fixture.store.read(storageKey, null),
  };
}

function resealArchiveFixture(tombstone, originalManifest) {
  const { tombstoneDigest: ignoredTombstoneDigest, ...content } = tombstone;
  const sealed = { ...content, tombstoneDigest: digestValue(content) };
  const { manifestDigest: ignoredManifestDigest, ...manifestContent } = originalManifest;
  const changedManifest = { ...manifestContent, tombstoneDigest: sealed.tombstoneDigest };
  return {
    tombstone: sealed,
    manifest: { ...changedManifest, manifestDigest: digestValue(changedManifest) },
  };
}

test("verification outcome survives compaction and restart without private terminal detail", async (t) => {
  for (const code of [
    "CODE_JOB_VERIFICATION_FAILED",
    "CODE_JOB_VERIFICATION_TIMEOUT",
    "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE",
    "CODE_JOB_VERIFICATION_UNKNOWN",
  ]) {
    await t.test(code, async () => {
      const fixture = await archivedVerificationFixture(code);
      assert.equal(fixture.live.verificationOutcome, code);
      assert.equal(fixture.tombstone.schemaVersion, 3);
      assert.equal(fixture.tombstone.outcome.verificationOutcome, code);
      assert.doesNotMatch(JSON.stringify(fixture.tombstone), /Private detail|private\\\\test-output/);
      assert.deepEqual(await fixture.jobs.get(fixture.live.jobId), fixture.live);
      const recovered = await readyStore({ store: fixture.store });
      assert.deepEqual(await recovered.jobs.get(fixture.live.jobId), fixture.live);
    });
  }
});

test("legacy tombstones remain readable without a verification outcome", async () => {
  const fixture = await archivedVerificationFixture("CODE_JOB_VERIFICATION_FAILED");
  for (const schemaVersion of [1, 2]) {
    const legacy = structuredClone(fixture.tombstone);
    legacy.schemaVersion = schemaVersion;
    delete legacy.outcome.verificationOutcome;
    if (schemaVersion === 1) delete legacy.outcome.changePackageDelivery;
    const sealed = resealArchiveFixture(legacy, fixture.manifest);
    const normalized = normalizeCodeJobArchiveTombstoneRecord(sealed.tombstone, {
      storageKey: fixture.storageKey,
      manifest: sealed.manifest,
    });
    assert.equal(Object.hasOwn(projectArchivedCodeJobForBrowser(normalized.tombstone), "verificationOutcome"), false);
  }
});

test("archived verification outcome is digest-bound and restricted to failed verify jobs", async () => {
  const fixture = await archivedVerificationFixture("CODE_JOB_VERIFICATION_FAILED");
  const changed = structuredClone(fixture.tombstone);
  changed.outcome.verificationOutcome = "CODE_JOB_VERIFICATION_TIMEOUT";
  assert.throws(() => normalizeCodeJobArchiveTombstoneRecord(changed, {
    storageKey: fixture.storageKey,
    manifest: fixture.manifest,
  }), { code: "CODE_JOB_ARCHIVE_CORRUPTED" });

  for (const invalid of ["UNKNOWN_PRIVATE_CODE", { code: "CODE_JOB_VERIFICATION_FAILED" }]) {
    const forged = structuredClone(fixture.tombstone);
    forged.outcome.verificationOutcome = invalid;
    const sealed = resealArchiveFixture(forged, fixture.manifest);
    assert.throws(() => normalizeCodeJobArchiveTombstoneRecord(sealed.tombstone, {
      storageKey: fixture.storageKey,
      manifest: sealed.manifest,
    }), { code: "CODE_JOB_ARCHIVE_CORRUPTED" });
  }

  for (const options of [{ operation: "inspect" }, { terminalMethod: "fence" }]) {
    const other = await archivedVerificationFixture("CODE_JOB_VERIFICATION_FAILED", options);
    assert.equal(other.tombstone.outcome.verificationOutcome, null);
    assert.equal(Object.hasOwn(await other.jobs.get(other.live.jobId), "verificationOutcome"), false);
    const forged = structuredClone(other.tombstone);
    forged.outcome.verificationOutcome = "CODE_JOB_VERIFICATION_FAILED";
    const sealed = resealArchiveFixture(forged, other.manifest);
    assert.throws(() => normalizeCodeJobArchiveTombstoneRecord(sealed.tombstone, {
      storageKey: other.storageKey,
      manifest: sealed.manifest,
    }), { code: "CODE_JOB_ARCHIVE_CORRUPTED" });
  }
});
