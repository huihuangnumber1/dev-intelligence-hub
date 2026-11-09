import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
  updateCodeJobLifecycle,
} from "../src/domain/code-job-contract.js";
import { createChangePackage } from "../src/domain/change-package-contract.js";
import { createCodeJobChangePackageEvent } from "../src/domain/code-job-change-package-event.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  CodeJobChangePackageDispatcher,
  CodeJobChangePackageDispatcherError,
} from "../src/services/code-job-change-package-dispatcher.js";

const WORKSPACE_REVISION = "4".repeat(64);
const SOURCE_REVISION = "5".repeat(64);

function conflictAuthority() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/widgets",
    baseRefName: "main",
    baseRefOid: "6".repeat(40),
    headRepository: "contributor/widgets",
    headRefName: "fix/retry-race",
    headRefOid: "1".repeat(40),
  };
  const inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "work-1",
    workKey: "pull-request-acme-widgets-17",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: gitTarget.headRefOid,
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    gitTarget,
  };
  const executionSource = createConflictCodeExecutionSource({
    inputBinding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "7".repeat(64),
        status: "conflicted",
        baseCommitOid: gitTarget.baseRefOid,
        headCommitOid: gitTarget.headRefOid,
        mergeBaseOid: "8".repeat(40),
        resultTreeOid: "9".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "a".repeat(64),
        evidenceDigest: "b".repeat(64),
        resultObjectDigest: "c".repeat(64),
        materialization: "full-tree",
      },
      gitTarget,
    }),
  });
  return { inputBinding, executionSource };
}

function completedJob({ conflict = false, repair = false } = {}) {
  const authority = conflict || repair ? conflictAuthority() : null;
  if (repair) authority.executionSource = createReviewRepairCodeExecutionSource({ inputBinding: authority.inputBinding, writablePaths: ["src"] });
  const grant = createCodeJobGrant({
    schemaVersion: authority ? 3 : 2,
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: authority
        ? "github:pr:acme/widgets#17"
        : "github:issue:acme/widgets#17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    inputBinding: authority?.inputBinding ?? null,
    ...(authority === null
      ? {}
      : { executionSource: authority.executionSource }),
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "modify",
    objective: "Fix the retry race",
    acceptanceCriteria: ["The scoped test passes"],
    evidence: [],
    summary: "Fix the retry race",
    reason: "A trusted workflow event requested the change.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: conflict ? ["src/app.js"] : ["src"],
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
  const resultDetail = { schemaVersion: 1, completedActionId: action.actionId };
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

function events(count = 1) {
  const job = completedJob();
  const result = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    result.push(createCodeJobChangePackageEvent({
      sequence,
      previousDigest: result.at(-1)?.eventDigest ?? null,
      job,
    }));
  }
  return result;
}

function exportedChangeSet() {
  return {
    workspace: {
      id: "widgets-local",
      sourceRevision: SOURCE_REVISION,
      workspaceRevision: WORKSPACE_REVISION,
    },
    passedProfiles: [{
      id: "node-tests",
      configDigest: "b".repeat(64),
      workspaceRevision: WORKSPACE_REVISION,
      actionId: "test-action-1",
      attemptNumber: 1,
      imageId: `sha256:${"6".repeat(64)}`,
      artifacts: {
        output: { path: "proof/output.json", sha256: "7".repeat(64), bytes: 10 },
        stdout: { path: "proof/stdout.json", sha256: "8".repeat(64), bytes: 11 },
        stderr: { path: "proof/stderr.json", sha256: "9".repeat(64), bytes: 12 },
      },
    }],
    created: [{ path: "src/new.js", content: Buffer.from("export const added = true;\n") }],
    modified: [],
    deleted: [],
  };
}

function sourceFor(sourceEvents, override = {}) {
  const state = { cursor: 0, reads: [], acknowledgements: [] };
  const source = {
    marker: "source-receiver",
    async readBatch(options) {
      assert.equal(this.marker, "source-receiver");
      state.reads.push(options);
      return {
        cursor: state.cursor,
        highWatermark: sourceEvents.length,
        items: sourceEvents.slice(state.cursor, state.cursor + options.limit),
      };
    },
    async ack(request) {
      assert.equal(this.marker, "source-receiver");
      state.acknowledgements.push(request);
      state.cursor = request.sequence;
      return {
        status: "applied",
        cursor: state.cursor,
        highWatermark: sourceEvents.length,
      };
    },
    ...override,
  };
  return { source, state };
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
  const evidenceDigest = "d".repeat(64);
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
    commitOid: "e".repeat(40),
  };
  const receiptDigest = digestValue(content);
  return {
    ...content,
    receiptDigest,
    receiptId: `change-package-controlled-commit-receipt-${receiptDigest}`,
  };
}

function fixture(sourceEvents = events(1), overrides = {}) {
  const source = sourceFor(sourceEvents, overrides.source);
  const state = { exports: [], drafts: [], controlledCommits: [], order: [] };
  const completedChangeExporter = overrides.completedChangeExporter ?? {
    marker: "exporter-receiver",
    async export(request) {
      assert.equal(this.marker, "exporter-receiver");
      state.order.push("export");
      state.exports.push(request);
      return exportedChangeSet();
    },
  };
  const packageProducer = overrides.packageProducer ?? {
    marker: "producer-receiver",
    async create(draft) {
      assert.equal(this.marker, "producer-receiver");
      state.order.push("create");
      state.drafts.push(draft);
      return createChangePackage(draft).manifest;
    },
  };
  const originalAck = source.source.ack;
  source.source.ack = async function ack(request) {
    state.order.push("ack");
    return Reflect.apply(originalAck, this, [request]);
  };
  return {
    sourceEvents,
    source,
    state,
    dispatcher: new CodeJobChangePackageDispatcher({
      deliverySource: source.source,
      completedChangeExporter,
      packageProducer,
      ...(overrides.controlledCommitDelivery === undefined
        ? {}
        : { controlledCommitDelivery: overrides.controlledCommitDelivery }),
    }),
  };
}

test("dispatcher exports, creates, and acknowledges each event serially", async () => {
  const setup = fixture(events(2));
  const result = await setup.dispatcher.runCycle({ limit: 2 });

  assert.deepEqual(result, {
    observed: 2,
    created: 2,
    acknowledged: 2,
    cursor: 2,
    highWatermark: 2,
    pending: 0,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(setup.source.state.reads, [{ limit: 2 }]);
  assert.deepEqual(setup.state.order, ["export", "create", "ack", "export", "create", "ack"]);
  for (let index = 0; index < setup.sourceEvents.length; index += 1) {
    const event = setup.sourceEvents[index];
    const draft = setup.state.drafts[index];
    const manifest = createChangePackage(draft).manifest;
    assert.deepEqual(setup.state.exports[index], event.exportRequest);
    assert.deepEqual(draft.job, event.job);
    assert.deepEqual(draft.proposal, event.proposal);
    assert.deepEqual(draft.grant, event.grant);
    assert.deepEqual(setup.source.state.acknowledgements[index], {
      sequence: event.sequence,
      eventId: event.eventId,
      eventDigest: event.eventDigest,
      jobId: event.job.id,
      sourceRecordDigest: event.job.recordDigest,
      packageId: manifest.packageId,
      packageDigest: manifest.packageDigest,
    });
  }
});

test("an unchanged repair package does not block the following real controlled commit", async () => {
  const first = createCodeJobChangePackageEvent({ sequence: 1, previousDigest: null, job: completedJob({ repair: true }) });
  const second = createCodeJobChangePackageEvent({ sequence: 2, previousDigest: first.eventDigest, job: completedJob({ conflict: true }) });
  let setup, commits = 0;
  setup = fixture([first, second], {
    completedChangeExporter: { async export(request) {
      const changes = exportedChangeSet();
      return request.sessionId === first.exportRequest.sessionId
        ? { ...changes, workspace: { ...changes.workspace, sourceRevision: WORKSPACE_REVISION }, created: [], modified: [], deleted: [] }
        : changes;
    } },
    controlledCommitDelivery: { async deliver(request) {
      commits++;
      assert.equal(request.eventId, second.eventId);
      return controlledCommitReceipt(second, createChangePackage(setup.state.drafts[1]).manifest);
    } },
  });
  const result = await setup.dispatcher.runCycle();
  assert.equal(result.acknowledged, 2);
  assert.equal(result.unchanged, 1);
  assert.equal(result.pending, 0);
  assert.equal(commits, 1);
  assert.equal(setup.source.state.acknowledgements[0].noChanges, true);
  assert.equal(setup.source.state.acknowledgements[0].controlledCommit, undefined);
  assert.ok(setup.source.state.acknowledgements[1].controlledCommit);
});

test("dispatcher commits a schema v3 event before ack while keeping source and Git authority narrow", async () => {
  const event = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ conflict: true }),
  });
  let setup;
  const controlledCommitDelivery = {
    async deliver(request) {
      setup.state.order.push("commit");
      setup.state.controlledCommits.push(request);
      return controlledCommitReceipt(
        event,
        createChangePackage(setup.state.drafts[0]).manifest,
      );
    },
  };
  setup = fixture([event], { controlledCommitDelivery });

  const result = await setup.dispatcher.runCycle();

  assert.equal(result.acknowledged, 1);
  assert.equal(event.schemaVersion, 3);
  assert.deepEqual(setup.state.exports, [event.exportRequest]);
  assert.deepEqual(setup.state.drafts[0].grant, { digest: event.grant.digest });
  assert.equal(
    JSON.stringify(setup.state.drafts[0]).includes("executionSource"),
    false,
  );
  const manifest = createChangePackage(setup.state.drafts[0]).manifest;
  assert.deepEqual(setup.state.order, ["export", "create", "commit", "ack"]);
  assert.deepEqual(setup.state.controlledCommits, [{
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    executionSource: event.executionSource,
    recordedAt: "2026-08-02T06:01:00.000Z",
  }]);
  assert.deepEqual(
    setup.source.state.acknowledgements[0].controlledCommit,
    controlledCommitReceipt(event, manifest),
  );
});

test("dispatcher reads but never delivers a legacy conflict event without stable commit time", async () => {
  const current = createCodeJobChangePackageEvent({
    sequence: 1,
    previousDigest: null,
    job: completedJob({ conflict: true }),
  });
  const {
    eventId: _eventId,
    eventDigest: _eventDigest,
    recordedAt: _recordedAt,
    ...legacyContent
  } = current;
  legacyContent.schemaVersion = 2;
  const eventDigest = digestValue(legacyContent);
  const legacy = {
    ...legacyContent,
    eventId: `code-job-change-package-event-${eventDigest}`,
    eventDigest,
  };
  const setup = fixture([legacy]);

  await assert.rejects(
    setup.dispatcher.runCycle(),
    (error) => error?.code === "CODE_JOB_CONTROLLED_COMMIT_EVENT_LEGACY",
  );
  assert.equal(setup.state.exports.length, 0);
  assert.equal(setup.source.state.cursor, 0);
});

test("lost create and ack responses converge through idempotent replay", async (t) => {
  await t.test("create response", async () => {
    const sourceEvents = events(1);
    const stored = new Map();
    let first = true;
    let calls = 0;
    const failure = new Error("package create acknowledgement was lost");
    const setup = fixture(sourceEvents, {
      packageProducer: {
        async create(draft) {
          calls += 1;
          const manifest = createChangePackage(draft).manifest;
          stored.set(manifest.packageId, manifest);
          if (first) {
            first = false;
            throw failure;
          }
          return stored.get(manifest.packageId);
        },
      },
    });
    await assert.rejects(setup.dispatcher.runCycle(), (error) => error === failure);
    assert.equal(setup.source.state.cursor, 0);
    assert.equal(stored.size, 1);
    assert.deepEqual(await setup.dispatcher.runCycle(), {
      observed: 1,
      created: 1,
      acknowledged: 1,
      cursor: 1,
      highWatermark: 1,
      pending: 0,
    });
    assert.equal(calls, 2);
  });

  await t.test("ack response", async () => {
    const sourceEvents = events(1);
    let first = true;
    const failure = new Error("source acknowledgement was lost");
    let state;
    const setup = fixture(sourceEvents, {
      source: {
        async ack(request) {
          state.cursor = request.sequence;
          state.acknowledgements.push(request);
          if (first) {
            first = false;
            throw failure;
          }
          return { status: "already", cursor: state.cursor, highWatermark: 1 };
        },
      },
    });
    state = setup.source.state;
    await assert.rejects(setup.dispatcher.runCycle(), (error) => error === failure);
    assert.equal(state.cursor, 1);
    assert.deepEqual(await setup.dispatcher.runCycle(), {
      observed: 0,
      created: 0,
      acknowledged: 0,
      cursor: 1,
      highWatermark: 1,
      pending: 0,
    });
    assert.equal(setup.state.drafts.length, 1);
  });
});

test("every inbound protocol is validated before progress is acknowledged", async (t) => {
  const sourceEvents = events(1);
  await t.test("source batch", async () => {
    const setup = fixture(sourceEvents, {
      source: {
        async readBatch() {
          return { cursor: 0, highWatermark: 1, items: sourceEvents, extra: true };
        },
      },
    });
    await assert.rejects(
      setup.dispatcher.runCycle(),
      (error) => error instanceof CodeJobChangePackageDispatcherError,
    );
  });

  await t.test("source chain", async () => {
    const first = sourceEvents[0];
    const second = createCodeJobChangePackageEvent({
      sequence: 2,
      previousDigest: "f".repeat(64),
      job: completedJob(),
    });
    const setup = fixture([first, second]);
    await assert.rejects(
      setup.dispatcher.runCycle(),
      (error) => error instanceof CodeJobChangePackageDispatcherError,
    );
    assert.equal(setup.state.exports.length, 0);
  });

  await t.test("exported change set", async () => {
    let createCalls = 0;
    const setup = fixture(sourceEvents, {
      completedChangeExporter: { async export() { return { created: [] }; } },
      packageProducer: { async create() { createCalls += 1; } },
    });
    await assert.rejects(setup.dispatcher.runCycle());
    assert.equal(createCalls, 0);
  });

  await t.test("hostile exported DTOs", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty(
      {
        passedProfiles: exportedChangeSet().passedProfiles,
        created: [],
        modified: [],
        deleted: [],
      },
      "workspace",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return exportedChangeSet().workspace;
        },
      },
    );
    const sparse = exportedChangeSet();
    sparse.created = new Array(1);
    const cyclic = exportedChangeSet();
    cyclic.workspace = cyclic;
    const oversized = exportedChangeSet();
    oversized.created[0].content = Buffer.alloc(1_000_001);
    for (const exported of [accessor, sparse, cyclic, oversized]) {
      let createCalls = 0;
      const setup = fixture(sourceEvents, {
        completedChangeExporter: { async export() { return exported; } },
        packageProducer: { async create() { createCalls += 1; } },
      });
      await assert.rejects(setup.dispatcher.runCycle());
      assert.equal(createCalls, 0);
    }
    assert.equal(getterCalls, 0);
  });

  await t.test("package manifest binding", async () => {
    const setup = fixture(sourceEvents, {
      packageProducer: {
        async create(draft) {
          return createChangePackage({
            ...draft,
            job: { ...draft.job, id: "code-job-substituted" },
          }).manifest;
        },
      },
    });
    await assert.rejects(
      setup.dispatcher.runCycle(),
      (error) => error instanceof CodeJobChangePackageDispatcherError,
    );
    assert.equal(setup.source.state.cursor, 0);
  });

  await t.test("ack receipt", async () => {
    const setup = fixture(sourceEvents, {
      source: {
        async ack(request) {
          return { status: "applied", cursor: request.sequence, highWatermark: 0 };
        },
      },
    });
    await assert.rejects(
      setup.dispatcher.runCycle(),
      (error) => error instanceof CodeJobChangePackageDispatcherError,
    );
  });
});

test("cycles coalesce, options are strict, and method accessors are never invoked", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const dispatcher = new CodeJobChangePackageDispatcher({
    deliverySource: {
      async readBatch({ limit }) {
        reads += 1;
        await waiting;
        return { cursor: 0, highWatermark: 0, items: [] };
      },
      async ack() {},
    },
    completedChangeExporter: { async export() {} },
    packageProducer: { async create() {} },
  });
  const first = dispatcher.runCycle();
  const second = dispatcher.runCycle({ limit: 1 });
  assert.strictEqual(second, first);
  release();
  assert.deepEqual(await first, {
    observed: 0,
    created: 0,
    acknowledged: 0,
    cursor: 0,
    highWatermark: 0,
    pending: 0,
  });
  assert.equal(reads, 1);
  assert.throws(() => dispatcher.runCycle({ limit: 0 }), /limit/);
  assert.throws(() => dispatcher.runCycle({ limit: 101 }), /limit/);
  assert.throws(() => dispatcher.runCycle({ extra: true }), /options/);

  let getterCalls = 0;
  const accessorPort = Object.defineProperty(
    { async ack() {} },
    "readBatch",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => {};
      },
    },
  );
  assert.throws(() => new CodeJobChangePackageDispatcher({
    deliverySource: accessorPort,
    completedChangeExporter: { async export() {} },
    packageProducer: { async create() {} },
  }));
  assert.equal(getterCalls, 0);
});
