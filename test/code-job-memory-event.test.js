import assert from "node:assert/strict";
import test from "node:test";
import { ciRepairSource } from './support/ci-repair-fixture.js';
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
  updateCodeJobLifecycle,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  classifyCodeJobMemoryEvent,
  codeJobMemorySourceId,
  createCodeJobMemoryEvent,
  memoryRecordForCodeJobEvent,
  normalizeCodeJobMemoryEvent,
} from "../src/domain/code-job-memory-event.js";
import {
  MAX_MEMORY_RECORD_CONTENT_BYTES,
  normalizeMemoryRecord,
} from "../src/domain/memory-record.js";

const WORKSPACE_REVISION = "4".repeat(64);
const FILE_BEFORE = "5".repeat(64);
const FILE_AFTER = "6".repeat(64);
const HEAD_REF_OID = "1".repeat(40);

for (const sourceKind of ['review_repair', 'ci_repair']) test(`${sourceKind} memory retains source authority without invented conflict preparation`, () => {
  const binding = conflictInputBinding();
  const source = sourceKind === 'ci_repair' ? ciRepairSource(binding, ['src', 'test', 'docs'])
    : createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src", "test", "docs"] });
  const job = observedJob(binding, { operation: "modify", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src", "test", "docs"], executionSource: source });
  const event = createCodeJobMemoryEvent({ sequence: 1, previousDigest: null, job, kind: "observation" });
  const normalized = normalizeCodeJobMemoryEvent(event);
  const snapshot = JSON.parse(normalized.memoryRecord.content);
  assert.equal(snapshot.executionSource.kind, sourceKind);
  assert.equal(Object.hasOwn(snapshot.executionSource, "preparationId"), false);
  assert.deepEqual(snapshot.executionSource.writablePathSamples, ["docs", "src", "test"]);
  assert.equal(JSON.stringify(normalized).includes("conflict-preparation:undefined"), false);
  assert.ok(normalized.memoryRecord.tags.includes(sourceKind === 'ci_repair' ? 'ci-repair' : 'review-repair'));
});

function inputBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "github:acme/widgets:pull-request:17",
    workKey: "github:acme/widgets:pull-request:17",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: HEAD_REF_OID,
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
  };
}

function conflictInputBinding() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/widgets",
    baseRefName: "main",
    baseRefOid: "7".repeat(40),
    headRepository: "contributor/widgets",
    headRefName: "fix/conflict",
    headRefOid: HEAD_REF_OID,
  };
  return { ...inputBinding(), schemaVersion: 2, gitTarget };
}

function conflictExecutionSource(
  binding,
  conflicts = [{ path: "src/app.js", mode: "100644" }],
) {
  return createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "8".repeat(64),
        status: "conflicted",
        baseCommitOid: binding.gitTarget.baseRefOid,
        headCommitOid: binding.gitTarget.headRefOid,
        mergeBaseOid: "9".repeat(40),
        resultTreeOid: "a".repeat(40),
        conflicts,
        boundaryDigest: "b".repeat(64),
        evidenceDigest: "c".repeat(64),
        resultObjectDigest: "d".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: binding.gitTarget,
    }),
  });
}

function grant(binding, overrides = {}) {
  const content = {
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Never project this prompt or C:\\private\\source.js",
    acceptanceCriteria: ["Never project raw file content"],
    evidence: ["token=super-secret"],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  };
  const next = { ...content, ...overrides };
  return createCodeJobGrant(
    binding === undefined
      ? next
      : {
          schemaVersion: Object.hasOwn(next, "executionSource") ? 3 : 2,
          ...next,
          inputBinding: binding,
        },
  );
}

function queuedJob(binding, grantOverrides = {}) {
  return createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant: grant(binding, grantOverrides),
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
}

function observedJob(binding, grantOverrides = {}) {
  const queued = queuedJob(binding, grantOverrides);
  const action = {
    type: "complete",
    actionId: "complete-action-1",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
  };
  const detail = {
    schemaVersion: 1,
    executor: { actionStatus: "succeeded" },
    result: {
      created: [],
      modified: [{
        path: "src/app.js",
        beforeSha256: FILE_BEFORE,
        afterSha256: FILE_AFTER,
      }],
      deleted: [],
      content: "raw file content must not escape",
      stdout: "token=from-stdout",
      stderr: "C:\\private\\stderr.log",
    },
  };
  return updateCodeJobLifecycle(queued, {
    status: "active",
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      sessionId: queued.jobId,
      workspaceRevision: WORKSPACE_REVISION,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [{
        turn: 1,
        actionId: action.actionId,
        actionType: action.type,
        actionDigest: digestValue(action),
        action,
        status: "succeeded",
        workspaceRevision: WORKSPACE_REVISION,
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      }],
      result: null,
      pause: null,
      uncertainty: null,
      memoryProjection: null,
    },
  });
}

function completedJob(binding, grantOverrides = {}) {
  const active = observedJob(binding, grantOverrides);
  const detail = {
    schemaVersion: 1,
    outcome: "fixed",
    evidence: ["token=terminal-secret", "C:\\private\\proof.txt"],
    checks: ["node-tests"],
    workspaceRevision: WORKSPACE_REVISION,
    manifest: {
      created: [],
      modified: [{
        path: "src/app.js",
        beforeSha256: FILE_BEFORE,
        afterSha256: FILE_AFTER,
      }],
      deleted: [],
    },
    completedActionId: "complete-action-1",
    content: "raw read content",
    stdout: "raw stdout",
    stderr: "raw stderr",
  };
  return updateCodeJobLifecycle(active, {
    status: "completed",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      result: {
        kind: "completed",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function pausedJob() {
  const queued = queuedJob();
  return updateCodeJobLifecycle(queued, {
    status: "paused",
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      ...queued.execution,
      pause: {
        from: "queued",
        reason: "Waiting for owner guidance at C:\\private\\notes.txt",
        at: "2026-08-02T06:01:00.000Z",
      },
    },
  });
}

function resumedJob() {
  const paused = pausedJob();
  return updateCodeJobLifecycle(paused, {
    status: "queued",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: { ...paused.execution, pause: null },
  });
}

function unknownJob() {
  const active = observedJob();
  const action = {
    type: "list_files",
    actionId: "list-action-2",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
    path: ".",
  };
  return updateCodeJobLifecycle(active, {
    status: "unknown",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      pendingAction: {
        turn: 2,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-02T06:02:00.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest: digestValue(action),
        epoch: 3,
        admittedAt: "2026-08-02T06:02:00.000Z",
      },
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "Executor result at C:\\private\\workspace is unknown",
        at: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function reconciledJob() {
  const unknown = unknownJob();
  const pending = unknown.execution.pendingAction;
  const detail = {
    schemaVersion: 1,
    executor: { actionStatus: "interrupted" },
    result: { files: [], stdout: "raw recovery output" },
  };
  return updateCodeJobLifecycle(unknown, {
    status: "active",
    revision: 4,
    updatedAt: "2026-08-02T06:03:00.000Z",
    execution: {
      ...unknown.execution,
      turn: 2,
      pendingAction: null,
      actionAdmission: null,
      uncertainty: null,
      observations: [
        ...unknown.execution.observations,
        {
          turn: 2,
          actionId: pending.actionId,
          actionType: pending.action.type,
          actionDigest: pending.actionDigest,
          action: pending.action,
          status: "interrupted",
          workspaceRevision: WORKSPACE_REVISION,
          detail,
          detailDigest: digestValue(detail),
          recordedAt: "2026-08-02T06:03:00.000Z",
        },
      ],
    },
  });
}

function terminalJob(kind) {
  const queued = queuedJob();
  const detail = {
    schemaVersion: 1,
    code: kind === "failed" ? "CODE_JOB_FAILED" : "CODE_JOB_FENCED",
    message: `Do not expose token=${kind}`,
  };
  return updateCodeJobLifecycle(queued, {
    status: kind,
    revision: 2,
    updatedAt: "2026-08-02T06:01:00.000Z",
    execution: {
      ...queued.execution,
      result: {
        kind,
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      },
    },
  });
}

function cancellingJob() {
  const unknown = unknownJob();
  const detail = {
    schemaVersion: 1,
    outcome: "cancelled",
    code: "CODE_JOB_CANCELLED",
    message: "代码任务已按用户请求取消",
    reason: "用户不再需要这项任务",
    requestedFrom: "unknown",
  };
  return updateCodeJobLifecycle(unknown, {
    status: "cancelling",
    revision: 4,
    updatedAt: "2026-08-02T06:03:00.000Z",
    execution: {
      ...unknown.execution,
      result: {
        kind: "cancelled",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:03:00.000Z",
      },
    },
  });
}

function cancelledJob() {
  const cancelling = cancellingJob();
  return updateCodeJobLifecycle(cancelling, {
    status: "cancelled",
    revision: 5,
    updatedAt: "2026-08-02T06:04:00.000Z",
    execution: {
      ...cancelling.execution,
      pendingAction: null,
      actionAdmission: null,
      pause: null,
      uncertainty: null,
    },
  });
}

test("creates a content-addressed safe Code Job memory event", () => {
  const job = completedJob();
  const event = createCodeJobMemoryEvent({
    sequence: 2,
    previousDigest: "f".repeat(64),
    job,
    kind: "completed",
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.jobId, job.jobId);
  assert.equal(event.jobRevision, job.revision);
  assert.equal(event.sourceRecordDigest, job.recordDigest);
  assert.equal(event.eventId, `code-job-memory-event-${event.eventDigest}`);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);

  const rawRecord = memoryRecordForCodeJobEvent(event);
  assert.deepEqual(Object.keys(rawRecord), [
    "schemaVersion",
    "source",
    "occurredAt",
    "roleId",
    "repository",
    "eventType",
    "title",
    "summary",
    "content",
    "evidence",
    "tags",
    "sourceUrl",
    "subjectNumber",
  ]);
  assert.equal(
    rawRecord.source.id,
    codeJobMemorySourceId(job.jobId, job.recordDigest),
  );
  assert.equal(rawRecord.source.kind, "code_job");
  assert.doesNotThrow(() => normalizeMemoryRecord(rawRecord));
  const serialized = JSON.stringify(rawRecord);
  for (const forbidden of [
    "Never project this prompt",
    "super-secret",
    "terminal-secret",
    "raw read content",
    "raw stdout",
    "raw stderr",
    "C:\\\\private",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /src\/app\.js/);
  assert.match(serialized, /node-tests/);
  assert.match(serialized, new RegExp(job.execution.result.detailDigest));
});

test("conflict Code Job memory preserves a searchable sealed source summary", () => {
  const binding = conflictInputBinding();
  const executionSource = conflictExecutionSource(binding);
  const job = observedJob(binding, {
    operation: "modify",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src/app.js"],
    executionSource,
  });
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job,
    kind: "observation",
  });
  const record = memoryRecordForCodeJobEvent(event);
  const snapshot = JSON.parse(record.content);

  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(snapshot.executionSource, {
    kind: "conflict_preparation",
    preparationId: executionSource.preparationBinding.preparationId,
    resultTreeOid: executionSource.preparationBinding.resultTreeOid,
    boundaryDigest: executionSource.preparationBinding.boundaryDigest,
    evidenceDigest: executionSource.preparationBinding.evidenceDigest,
    resultObjectDigest: executionSource.preparationBinding.resultObjectDigest,
    writablePathCount: 1,
    writablePathsDigest: digestValue(["src/app.js"]),
    writablePathSamples: ["src/app.js"],
    writablePathsTruncated: false,
  });
  assert.equal(record.tags.includes("conflict-preparation"), true);
  assert.equal(
    record.evidence.includes(
      `conflict-preparation:${executionSource.preparationBinding.preparationId}`,
    ),
    true,
  );
  assert.equal(record.evidence.includes("conflict-path:src/app.js"), true);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);
});

test("large conflict summaries preserve lifecycle evidence before sampled paths", () => {
  const binding = conflictInputBinding();
  const conflicts = Array.from({ length: 32 }, (_, index) => ({
    path: `src/conflict-${String(index).padStart(2, "0")}.js`,
    mode: "100644",
  }));
  const executionSource = conflictExecutionSource(binding, conflicts);
  const job = completedJob(binding, {
    operation: "modify",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: conflicts.map(({ path: relativePath }) => relativePath),
    executionSource,
  });
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job,
    kind: "completed",
  });
  const record = memoryRecordForCodeJobEvent(event);
  const snapshot = JSON.parse(record.content);

  assert.equal(record.evidence.length <= 20, true);
  assert.equal(
    record.evidence.includes(
      `observation-detail:${snapshot.latestObservation.detailDigest}`,
    ),
    true,
  );
  assert.equal(
    record.evidence.includes(`terminal-detail:${snapshot.terminal.detailDigest}`),
    true,
  );
  assert.equal(snapshot.executionSource.writablePathCount, 32);
  assert.equal(snapshot.executionSource.writablePathSamples.length, 8);
  assert.equal(snapshot.executionSource.writablePathsTruncated, true);
});

test("maximum conflict paths and terminal manifest remain within memory limits", () => {
  const binding = conflictInputBinding();
  const conflicts = Array.from({ length: 32 }, (_, index) => ({
    path: `src/${String(index).padStart(2, "0")}-${"a".repeat(236)}/${"b".repeat(240)}.js`,
    mode: "100644",
  }));
  const executionSource = conflictExecutionSource(binding, conflicts);
  const active = observedJob(binding, {
    operation: "modify",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: conflicts.map(({ path: relativePath }) => relativePath),
    executionSource,
  });
  const detail = {
    schemaVersion: 1,
    outcome: "fixed",
    evidence: [],
    checks: ["node-tests"],
    workspaceRevision: WORKSPACE_REVISION,
    manifest: {
      created: [],
      modified: conflicts.slice(0, 20).map(({ path: relativePath }) => ({
        path: relativePath,
        beforeSha256: FILE_BEFORE,
        afterSha256: FILE_AFTER,
      })),
      deleted: [],
    },
    completedActionId: "complete-action-1",
  };
  const completed = updateCodeJobLifecycle(active, {
    status: "completed",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      result: {
        kind: "completed",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-02T06:02:00.000Z",
      },
    },
  });

  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job: completed,
    kind: "completed",
  });
  assert.doesNotThrow(() => normalizeCodeJobMemoryEvent(event));
  assert.equal(
    Buffer.byteLength(event.memoryRecord.content, "utf8") <=
      MAX_MEMORY_RECORD_CONTENT_BYTES,
    true,
  );
});

test("normalization rejects extra fields, accessors, cycles, and digest tampering", () => {
  const input = {
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
    kind: "completed",
  };
  const event = createCodeJobMemoryEvent(input);

  assert.throws(
    () => createCodeJobMemoryEvent({ ...input, extra: true }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  const inputAccessor = { ...input };
  Object.defineProperty(inputAccessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("input getter must not run");
    },
  });
  assert.throws(
    () => createCodeJobMemoryEvent(inputAccessor),
    (error) =>
      error?.code === "INVALID_CODE_JOB_MEMORY_EVENT" &&
      !/input getter must not run/.test(error.message),
  );

  assert.throws(
    () => normalizeCodeJobMemoryEvent({ ...event, extra: true }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  const accessor = { ...event };
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  assert.throws(
    () => normalizeCodeJobMemoryEvent(accessor),
    (error) =>
      error?.code === "INVALID_CODE_JOB_MEMORY_EVENT" &&
      !/getter must not run/.test(error.message),
  );
  const cyclicRecord = { ...event.memoryRecord };
  cyclicRecord.source = cyclicRecord;
  assert.throws(
    () => normalizeCodeJobMemoryEvent({ ...event, memoryRecord: cyclicRecord }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
  assert.throws(
    () => normalizeCodeJobMemoryEvent({
      ...event,
      memoryRecord: { ...event.memoryRecord, summary: "forged summary" },
    }),
    (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
  );
});

test("v2 memory events preserve exact PR Head evidence and reject binding tampering", () => {
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(inputBinding()),
    kind: "completed",
  });
  const record = memoryRecordForCodeJobEvent(event);
  const snapshot = JSON.parse(record.content);

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.repository, "acme/widgets");
  assert.equal(snapshot.subjectNumber, 17);
  assert.deepEqual(snapshot.inputBinding, inputBinding());
  assert.equal(snapshot.inputBinding.headRefOid, HEAD_REF_OID);
  assert.equal(record.evidence.includes(`pr-head:${HEAD_REF_OID}`), true);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);

  const headTampered = structuredClone(event);
  const headSnapshot = JSON.parse(headTampered.memoryRecord.content);
  headSnapshot.inputBinding.headRefOid = "7".repeat(40);
  headTampered.memoryRecord.content = JSON.stringify(headSnapshot);

  const repositoryMismatch = structuredClone(event);
  const repositorySnapshot = JSON.parse(repositoryMismatch.memoryRecord.content);
  repositorySnapshot.inputBinding.repository = "acme/other";
  repositoryMismatch.memoryRecord.content = JSON.stringify(repositorySnapshot);

  const pullRequestMismatch = structuredClone(event);
  const pullRequestSnapshot = JSON.parse(pullRequestMismatch.memoryRecord.content);
  pullRequestSnapshot.inputBinding.pullRequestNumber = 18;
  pullRequestMismatch.memoryRecord.content = JSON.stringify(pullRequestSnapshot);

  for (const candidate of [
    headTampered,
    repositoryMismatch,
    pullRequestMismatch,
  ]) {
    assert.throws(
      () => normalizeCodeJobMemoryEvent(candidate),
      (error) => error?.code === "INVALID_CODE_JOB_MEMORY_EVENT",
    );
  }
});

test("legacy memory events remain readable without an input binding", () => {
  const event = createCodeJobMemoryEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
    kind: "completed",
  });
  const snapshot = JSON.parse(memoryRecordForCodeJobEvent(event).content);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(Object.hasOwn(snapshot, "inputBinding"), false);
  assert.deepEqual(normalizeCodeJobMemoryEvent(event), event);
});

test("classifies significant lifecycle changes without looping on projection ack", () => {
  const queued = queuedJob();
  const active = observedJob();
  const completed = completedJob();

  assert.equal(classifyCodeJobMemoryEvent(null, queued), null);
  assert.equal(classifyCodeJobMemoryEvent(null, active), "observation");
  assert.equal(classifyCodeJobMemoryEvent(queued, active), "observation");
  assert.equal(classifyCodeJobMemoryEvent(active, completed), "completed");
  assert.equal(classifyCodeJobMemoryEvent(null, completed), "completed");
  assert.equal(classifyCodeJobMemoryEvent(completed, completed), null);
});

test("classifies and creates every supported lifecycle event kind", () => {
  const queued = queuedJob();
  const active = observedJob();
  const paused = pausedJob();
  const resumed = resumedJob();
  const unknown = unknownJob();
  const reconciled = reconciledJob();
  const failed = terminalJob("failed");
  const fenced = terminalJob("fenced");
  const cancelling = cancellingJob();
  const cancelled = cancelledJob();
  const cases = [
    [null, active, "observation"],
    [queued, paused, "paused"],
    [paused, resumed, "resumed"],
    [active, unknown, "unknown"],
    [unknown, reconciled, "reconciled"],
    [unknown, cancelling, "cancelling"],
    [cancelling, cancelled, "cancelled"],
    [queued, failed, "failed"],
    [queued, fenced, "fenced"],
  ];

  for (const [previous, next, kind] of cases) {
    assert.equal(classifyCodeJobMemoryEvent(previous, next), kind);
    const event = createCodeJobMemoryEvent({
      sequence: 1,
      previousDigest: null,
      job: next,
      kind,
    });
    assert.equal(event.kind, kind);
    assert.doesNotThrow(() => normalizeCodeJobMemoryEvent(event));
    if (kind === "cancelling") {
      assert.equal(JSON.parse(event.memoryRecord.content).terminal, null);
    }
    if (kind === "cancelled") {
      assert.equal(event.occurredAt, "2026-08-02T06:04:00.000Z");
      assert.equal(
        JSON.parse(event.memoryRecord.content).terminal.recordedAt,
        "2026-08-02T06:04:00.000Z",
      );
    }
  }
});
