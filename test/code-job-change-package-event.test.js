import assert from "node:assert/strict";
import test from "node:test";

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
  CodeJobChangePackageEventError,
  createCodeJobChangePackageEvent,
  normalizeCodeJobChangePackageEvent,
  reconstructCodeJobChangePackageEventForRecovery,
} from "../src/domain/code-job-change-package-event.js";

const WORKSPACE_REVISION = "4".repeat(64);

function pullRequestInputBinding(schemaVersion) {
  return {
    schemaVersion,
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
    ...(schemaVersion === 2
      ? {
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
        }
      : {}),
  };
}

function conflictExecutionSource(inputBinding, conflictPaths = ["src/app.js"]) {
  return createConflictCodeExecutionSource({
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
        conflicts: conflictPaths.map((path) => ({ path, mode: "100644" })),
        boundaryDigest: "9".repeat(64),
        evidenceDigest: "a".repeat(64),
        resultObjectDigest: "b".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: inputBinding.gitTarget,
    }),
  });
}

function completedJob({
  inputBindingVersion = null,
  grantSchemaVersion = 2,
  conflictPaths = ["src/app.js"],
  reviewRepair = false,
} = {}) {
  const inputBinding = grantSchemaVersion === 3
    ? pullRequestInputBinding(2)
    : inputBindingVersion === null
    ? null
    : pullRequestInputBinding(inputBindingVersion);
  const executionSource = grantSchemaVersion === 3
    ? reviewRepair ? createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: conflictPaths })
      : conflictExecutionSource(inputBinding, conflictPaths)
    : null;
  const grant = createCodeJobGrant({
    ...(grantSchemaVersion === 3
      ? { schemaVersion: 3, inputBinding, executionSource }
      : grantSchemaVersion === 2
      ? { schemaVersion: 2, inputBinding }
      : {}),
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: inputBinding === null
        ? "github:issue:acme/widgets#17"
        : "github:pr:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: grantSchemaVersion === 3 ? "modify" : "inspect",
    objective: grantSchemaVersion === 3
      ? "Resolve the sealed conflict"
      : "Inspect the retry race",
    acceptanceCriteria: grantSchemaVersion === 3
      ? ["The exact conflicted file is resolved"]
      : ["Report the root cause"],
    evidence: [],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [
      ...CODE_JOB_ACTIONS_BY_OPERATION[
        grantSchemaVersion === 3 ? "modify" : "inspect"
      ],
    ],
    writablePaths: grantSchemaVersion === 3 ? conflictPaths : [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  });
  const queued = createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant,
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
  const action = {
    type: "complete",
    actionId: "complete-action-1",
    expectedWorkspaceRevision: WORKSPACE_REVISION,
  };
  const observationDetail = {
    schemaVersion: 1,
    executor: { actionStatus: "succeeded" },
    result: { created: [], modified: [], deleted: [] },
  };
  const active = updateCodeJobLifecycle(queued, {
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
        detail: observationDetail,
        detailDigest: digestValue(observationDetail),
        recordedAt: "2026-08-02T06:01:00.000Z",
      }],
      result: null,
      pause: null,
      uncertainty: null,
      memoryProjection: null,
    },
  });
  const resultDetail = {
    schemaVersion: 1,
    outcome: "completed",
    completedActionId: action.actionId,
  };
  return updateCodeJobLifecycle(active, {
    status: "completed",
    revision: 3,
    updatedAt: "2026-08-02T06:02:00.000Z",
    execution: {
      ...active.execution,
      result: {
        kind: "completed",
        detail: resultDetail,
        detailDigest: digestValue(resultDetail),
        recordedAt: "2026-08-02T06:02:00.000Z",
      },
    },
  });
}

function eventContent(event) {
  const { eventId: _eventId, eventDigest: _eventDigest, ...content } = event;
  return content;
}

function persistedLegacyEvent(job) {
  const source = job.execution.memoryProjection ?? {
    sourceRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
  };
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
      completedActionId: "complete-action-1",
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

test("completed jobs produce a compact, digest-bound change-package event", () => {
  const job = completedJob();
  const event = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job,
  });

  assert.deepEqual(eventContent(event), {
    schemaVersion: 1,
    sequence: 1,
    previousDigest: null,
    job: { id: job.jobId, revision: job.revision, recordDigest: job.recordDigest },
    proposal: {
      id: job.proposal.proposalId,
      contentDigest: job.proposal.contentDigest,
    },
    grant: { digest: job.grant.grantDigest },
    exportRequest: {
      sessionId: job.execution.sessionId,
      completedActionId: "complete-action-1",
      expectedWorkspaceRevision: WORKSPACE_REVISION,
    },
  });
  assert.equal(event.eventDigest, digestValue(eventContent(event)));
  assert.equal(event.eventId, `code-job-change-package-event-${event.eventDigest}`);
  assert.deepEqual(normalizeCodeJobChangePackageEvent(event), event);
});

test("v2 PR and Issue eligibility stays strict while legacy jobs remain recovery-only", () => {
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: 1,
      previousDigest: null,
      job: completedJob({ inputBindingVersion: 1 }),
    }),
    (error) =>
      error instanceof CodeJobChangePackageEventError &&
      error.message.includes("旧版"),
  );
  assert.doesNotThrow(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ inputBindingVersion: 2 }),
  }));
  assert.doesNotThrow(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob(),
  }));
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: 1,
      previousDigest: null,
      job: completedJob({ grantSchemaVersion: 1 }),
    }),
    (error) =>
      error instanceof CodeJobChangePackageEventError &&
      error.message.includes("旧版"),
  );
});

test("schema v3 conflict jobs produce time-bound v3 events without changing ordinary events", () => {
  const conflictJob = completedJob({ grantSchemaVersion: 3 });
  const conflictEvent = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: conflictJob,
  });
  const ordinaryEvent = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ inputBindingVersion: 2 }),
  });

  assert.equal(conflictEvent.schemaVersion, 3);
  assert.deepEqual(
    conflictEvent.executionSource,
    conflictJob.grant.executionSource,
  );
  assert.notEqual(
    conflictEvent.executionSource,
    conflictJob.grant.executionSource,
  );
  assert.equal(conflictEvent.recordedAt, "2026-08-02T06:01:00.000Z");
  assert.equal(ordinaryEvent.schemaVersion, 1);
  assert.equal(Object.hasOwn(ordinaryEvent, "executionSource"), false);
  assert.deepEqual(normalizeCodeJobChangePackageEvent(conflictEvent), conflictEvent);
});

test("schema v3 review repair completion preserves the exact original PR source through restart recovery", () => {
  const job = completedJob({ grantSchemaVersion: 3, reviewRepair: true });
  const event = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job });
  assert.equal(event.executionSource.kind, "review_repair");
  assert.deepEqual(normalizeCodeJobChangePackageEvent(event), event);
  assert.deepEqual(reconstructCodeJobChangePackageEventForRecovery({ sequence: 1, previousDigest: null, job }, { expectedEventDigest: event.eventDigest }), event);
});

test("legacy conflict events remain readable but recovery never retimes them", () => {
  const job = completedJob({ grantSchemaVersion: 3 });
  const current = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job,
  });
  const legacyContent = eventContent(current);
  legacyContent.schemaVersion = 2;
  delete legacyContent.recordedAt;
  const eventDigest = digestValue(legacyContent);
  const legacy = {
    ...legacyContent,
    eventId: `code-job-change-package-event-${eventDigest}`,
    eventDigest,
  };

  assert.deepEqual(normalizeCodeJobChangePackageEvent(legacy), legacy);
  assert.deepEqual(
    reconstructCodeJobChangePackageEventForRecovery(
      { sequence: 1, previousDigest: null, job },
      { expectedEventDigest: legacy.eventDigest },
    ),
    legacy,
  );
  assert.notEqual(current.eventDigest, legacy.eventDigest);
  assert.equal(current.recordedAt, "2026-08-02T06:01:00.000Z");
});

test("schema v3 event source is mandatory and covered by the event digest", () => {
  const job = completedJob({ grantSchemaVersion: 3 });
  const event = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job,
  });

  const missing = structuredClone(event);
  delete missing.executionSource;
  assert.throws(
    () => normalizeCodeJobChangePackageEvent(missing),
    CodeJobChangePackageEventError,
  );

  const changed = structuredClone(event);
  changed.executionSource.preparationBinding.boundaryDigest = "e".repeat(64);
  assert.throws(
    () => normalizeCodeJobChangePackageEvent(changed),
    CodeJobChangePackageEventError,
  );

  const retimed = structuredClone(event);
  retimed.recordedAt = "2026-08-02T06:02:00.000Z";
  assert.throws(
    () => normalizeCodeJobChangePackageEvent(retimed),
    CodeJobChangePackageEventError,
  );
  const nonJsonTime = structuredClone(event);
  nonJsonTime.recordedAt = new Date(event.recordedAt);
  assert.throws(
    () => normalizeCodeJobChangePackageEvent(nonJsonTime),
    CodeJobChangePackageEventError,
  );

  let proxyTrapCalls = 0;
  const hostileSource = new Proxy(event.executionSource, {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(event.executionSource);
    },
  });
  assert.throws(
    () => normalizeCodeJobChangePackageEvent({
      ...event,
      executionSource: hostileSource,
    }),
    CodeJobChangePackageEventError,
  );
  assert.equal(proxyTrapCalls, 0);
});

test("schema v3 event recovery is deterministic and keeps its fixed source authority", () => {
  const completed = completedJob({ grantSchemaVersion: 3 });
  const original = createCodeJobChangePackageEvent({
    sequence: 2,
    previousDigest: "f".repeat(64),
    job: completed,
  });
  const memoryRecordDigest = "c".repeat(64);
  const projectedAt = "2026-08-02T06:03:00.000Z";
  const projected = updateCodeJobLifecycle(completed, {
    status: "completed",
    revision: 4,
    updatedAt: projectedAt,
    execution: {
      ...completed.execution,
      memoryProjection: {
        jobId: completed.jobId,
        sourceRecordDigest: completed.recordDigest,
        sourceRevision: completed.revision,
        sourceUpdatedAt: completed.updatedAt,
        memoryRecordId: `memory-${memoryRecordDigest}`,
        memoryRecordDigest,
        projectedAt,
      },
    },
  });

  assert.deepEqual(
    reconstructCodeJobChangePackageEventForRecovery({
      sequence: original.sequence,
      previousDigest: original.previousDigest,
      job: projected,
    }),
    original,
  );
});

test("schema v3 event envelope accommodates the maximum conflict-source path count", () => {
  const conflictPaths = Array.from({ length: 32 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return `conflict-${suffix}/${"\"".repeat(240)}/${"\"".repeat(240)}-${suffix}.js`;
  });
  const event = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ grantSchemaVersion: 3, conflictPaths }),
  });
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");

  assert.ok(bytes > 64 * 1024);
  assert.ok(bytes <= 96 * 1024);
  assert.deepEqual(normalizeCodeJobChangePackageEvent(event), event);
});

test("legacy event identities remain verifiable only for durable recovery", () => {
  const job = completedJob({ inputBindingVersion: 1 });
  const event = persistedLegacyEvent(job);
  assert.deepEqual(
    reconstructCodeJobChangePackageEventForRecovery({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      job,
    }),
    event,
  );
  assert.throws(
    () => createCodeJobChangePackageEvent({
      sequence: event.sequence,
      previousDigest: event.previousDigest,
      job,
    }),
    CodeJobChangePackageEventError,
  );
});

test("creation and normalization return detached DTOs", () => {
  const job = completedJob();
  const event = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job });
  job.proposal.proposalId = "mutated-source";
  assert.equal(event.proposal.id, "work-intent-proposal-1");

  const normalized = normalizeCodeJobChangePackageEvent(event);
  event.job.id = "mutated-event";
  event.exportRequest.completedActionId = "mutated-action";
  assert.notEqual(normalized.job.id, event.job.id);
  assert.equal(normalized.exportRequest.completedActionId, "complete-action-1");
});

test("a memory-projected job reproduces its original completion event", () => {
  const completed = completedJob();
  const original = createCodeJobChangePackageEvent({
    sequence: 2,
    previousDigest: "f".repeat(64),
    job: completed,
  });
  const memoryRecordDigest = "8".repeat(64);
  const projectedAt = "2026-08-02T06:03:00.000Z";
  const projected = updateCodeJobLifecycle(completed, {
    status: "completed",
    revision: 4,
    updatedAt: projectedAt,
    execution: {
      ...completed.execution,
      memoryProjection: {
        jobId: completed.jobId,
        sourceRecordDigest: completed.recordDigest,
        sourceRevision: completed.revision,
        sourceUpdatedAt: completed.updatedAt,
        memoryRecordId: `memory-${memoryRecordDigest}`,
        memoryRecordDigest,
        projectedAt,
      },
    },
  });

  assert.deepEqual(
    createCodeJobChangePackageEvent({
      sequence: original.sequence,
      previousDigest: original.previousDigest,
      job: projected,
    }),
    original,
  );
});

test("only completed jobs and a canonical digest chain are accepted", () => {
  const completed = completedJob();
  const queued = createQueuedCodeJob(
    {
      confirmationId: completed.approval.confirmationId,
      requestId: completed.approval.requestId,
      displayedPayloadDigest: completed.approval.displayedPayloadDigest,
      approvalBindingDigest: completed.approval.approvalBindingDigest,
      grant: completed.grant,
    },
    { sequence: 1, revision: 1, createdAt: completed.createdAt },
  );
  for (const input of [
    { sequence: 1, previousDigest: null, job: queued },
    { sequence: 1, previousDigest: "f".repeat(64), job: completed },
    { sequence: 2, previousDigest: null, job: completed },
  ]) {
    assert.throws(
      () => createCodeJobChangePackageEvent(input),
      (error) => error instanceof CodeJobChangePackageEventError,
    );
  }
});

test("accessors, sparse data, cycles, extra keys, and oversized values fail closed", () => {
  const job = completedJob();
  let getterCalls = 0;
  const accessor = Object.defineProperty(
    { previousDigest: null, job },
    "sequence",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    },
  );
  assert.throws(() => createCodeJobChangePackageEvent(accessor));
  assert.equal(getterCalls, 0);

  const sparseJob = structuredClone(job);
  sparseJob.execution.observations = new Array(1);
  assert.throws(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: sparseJob,
  }));

  const cyclicJob = structuredClone(job);
  cyclicJob.proposal = cyclicJob;
  assert.throws(() => createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: cyclicJob,
  }));

  const event = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job });
  assert.throws(() => normalizeCodeJobChangePackageEvent({ ...event, extra: true }));
  assert.throws(() => normalizeCodeJobChangePackageEvent({
    ...event,
    proposal: { ...event.proposal, id: "x".repeat(10_000) },
  }));

  let proxyTrapCalls = 0;
  const proxy = new Proxy(event, {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTrapCalls += 1;
      return Reflect.ownKeys(event);
    },
  });
  assert.throws(() => normalizeCodeJobChangePackageEvent(proxy));
  assert.equal(proxyTrapCalls, 0);
});
