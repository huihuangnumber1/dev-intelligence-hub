import assert from "node:assert/strict";
import test from "node:test";
import { planIntentStage, planIntentAcknowledgement, planIntentClaim } from "../src/services/work-ledger-outbox-commands.js";
import { workGraphMemoryRecordReceipt } from "../src/domain/work-graph-memory-event.js";
import {
  assertWorkLedgerGraphClaimable,
  assertWorkLedgerGraphCompletable,
  createDefaultWorkGraphMetadata,
  projectWorkLedgerGraphSnapshot,
  validateWorkLedgerGraphTransition,
  workLedgerStatusToGraphStatus,
} from "../src/services/work-ledger-graph.js";
import {
  createAssignmentWorkItem,
  createGapAlertWorkItem,
} from "../src/services/work-ledger-records.js";
import {
  emptyWorkLedgerState,
  normalizeWorkLedgerLimits,
  normalizeWorkLedgerPersistedState,
  WORK_LEDGER_STATE_SCHEMA_VERSION,
} from "../src/services/work-ledger-state.js";
import {
  acknowledgeWorkGraphMemoryProjectionBatch,
  migrateWorkGraphMemoryProjection,
} from "../src/services/work-ledger-graph-memory.js";

const CREATED_AT = "2026-08-03T01:00:00.000Z";

function assignment(sequence, target = { type: "role", id: "pr-reviewer" }) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: `workflow-event-${sequence}`,
      target,
      reason: `route-${sequence}`,
      createdAt: CREATED_AT,
    },
    event: {
      schemaVersion: 1,
      eventId: `workflow-event-${sequence}`,
      eventType: "pull_request.created",
      occurredAt: CREATED_AT,
      subject: { id: `subject-${sequence}` },
      payload: { number: sequence },
    },
  };
}

function stateWithItems(items) {
  const state = emptyWorkLedgerState();
  state.revision = Math.max(1, ...items.map(({ revision }) => revision));
  state.items = items;
  state.intakeCursor = Math.max(
    0,
    ...items.map(({ sourceSequence }) => sourceSequence),
  );
  state.sourceHighWatermark = state.intakeCursor;
  state.graphMemoryProjection = migrateWorkGraphMemoryProjection(
    items,
    state.revision,
    normalizeWorkLedgerLimits(),
  );
  return state;
}

test("complete is rejected before staging or acknowledging an undelivered required report", () => {
  const item = createAssignmentWorkItem(assignment(1), CREATED_AT);
  Object.assign(item, { status: "working", ownerId: "employee-pr-reviewer", leaseId: "work-lease", leaseUntil: "2026-08-03T01:10:00.000Z" });
  const state = stateWithItems([item]);
  const input = { itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: item.ownerId, roleId: "pr-reviewer", intent: { schemaVersion: 1, type: "complete",
      summary: "Diagnosis complete", reason: "Inspected", outcome: "done", evidence: [] } };
  // Create the historical complete before its missing delivery is considered.
  const staged = planIntentStage({ state, input, clock: () => CREATED_AT });
  const expected = { deliverableId: "diagnosis", kind: "text-report", description: "Diagnosis report", required: true };
  item.graph.acceptanceContracts[0].expectedDeliverables = [expected];
  const before = structuredClone(state);
  assert.throws(() => planIntentStage({ state, input, clock: () => CREATED_AT }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  assert.deepEqual(state, before);

  const legacy = { ...state, ...staged.patch };
  legacy.revision += 1;
  legacy.items[0].graph.acceptanceContracts[0].expectedDeliverables = [expected];
  const claimed = planIntentClaim({ state: legacy, input: { intentId: staged.result.outbox.intentId,
    expectedRevision: staged.result.outbox.revision, dispatcherId: "dispatcher", leaseDurationMs: 30_000 },
    clock: () => CREATED_AT, newLeaseId: () => "dispatch-lease" });
  Object.assign(legacy, claimed.patch);
  legacy.revision += 1;
  const ack = { intentId: claimed.result.intentId, expectedRevision: claimed.result.revision,
    dispatchLeaseId: claimed.result.dispatchLeaseId, itemExpectedRevision: legacy.items[0].revision,
    actorId: "dispatcher", outcome: "delivered", nextStatus: "completed", details: {} };
  assert.throws(() => planIntentAcknowledgement({ state: legacy, input: ack, clock: () => CREATED_AT }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  legacy.items[0].graph.deliveries = [graphDelivery({ deliverableId: "diagnosis", status: "accepted" })];
  assert.equal(planIntentAcknowledgement({ state: legacy, input: ack, clock: () => CREATED_AT }).result.item.status, "completed");
});

function corrupted(error) {
  return error.code === "WORK_LEDGER_STATE_CORRUPTED";
}

function graphDelivery({
  deliverableId = "review-report",
  revision = 1,
  status = "submitted",
  summary = "Review evidence",
  contentDigest = "a".repeat(64),
  recordedAt = CREATED_AT,
} = {}) {
  return {
    deliverableId,
    revision,
    contractRevision: 1,
    status,
    summary,
    evidence: [
      {
        kind: "artifact",
        referenceId: `artifact-${deliverableId}`,
        contentDigest,
      },
    ],
    recordedAt,
  };
}

function stateWithDeliveryHistory(deliveries, {
  status = "queued",
  statusReason = null,
} = {}) {
  const item = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const deliverableIds = [...new Set(
    deliveries.map(({ deliverableId }) => deliverableId),
  )];
  item.revision = deliveries.length + 1;
  item.status = status;
  item.statusReason = statusReason;
  item.graph.acceptanceContracts[0].expectedDeliverables = deliverableIds.map(
    (deliverableId) => ({
      deliverableId,
      kind: "review-report",
      description: `Evidence for ${deliverableId}`,
      required: true,
    }),
  );
  item.graph.deliveries = deliveries;
  return stateWithItems([item]);
}

test("new ledger items carry minimal graph metadata and project without a second state source", () => {
  const queued = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const blocked = createGapAlertWorkItem(
    { expectedSequence: 2, actualSequence: 4, reason: "source_retention" },
    CREATED_AT,
  );
  const snapshot = projectWorkLedgerGraphSnapshot(
    stateWithItems([queued, blocked]),
  );
  const byId = new Map(snapshot.tasks.map((task) => [task.taskId, task]));

  assert.equal(snapshot.graphId, "work-ledger");
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(queued.graph, createDefaultWorkGraphMetadata(CREATED_AT));
  assert.deepEqual(blocked.graph, createDefaultWorkGraphMetadata(CREATED_AT));
  assert.equal(
    Object.hasOwn(byId.get(queued.itemId).acceptanceContracts[0], "recordedAt"),
    false,
  );
  assert.equal(byId.get(queued.itemId).status, "pending");
  assert.equal(byId.get(blocked.itemId).status, "in_progress");
  assert.deepEqual(byId.get(queued.itemId).responsibility, queued.currentTarget);
});

test("every ledger status has an explicit graph projection", () => {
  const expected = new Map([
    ["queued", "pending"],
    ["paused", "paused"],
    ["working", "in_progress"],
    ["dispatch_pending", "in_progress"],
    ["waiting_user", "in_progress"],
    ["waiting_condition", "in_progress"],
    ["waiting_external", "in_progress"],
    ["retry_wait", "in_progress"],
    ["completed", "completed"],
    ["superseded", "superseded"],
    ["blocked", "in_progress"],
    ["cancelled", "cancelled"],
  ]);

  for (const [status, graphStatus] of expected) {
    assert.equal(workLedgerStatusToGraphStatus(status), graphStatus);
  }
  assert.throws(
    () => workLedgerStatusToGraphStatus("invented"),
    (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
  );
  assert.throws(
    () => workLedgerStatusToGraphStatus({ toString: () => "queued" }),
    (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
  );
});

test("superseded ledger prerequisites no longer block claim or completion", () => {
  const parent = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const dependency = createAssignmentWorkItem(assignment(2), CREATED_AT);
  const child = createAssignmentWorkItem(assignment(3), CREATED_AT);
  parent.graph.dependsOnItemIds = [dependency.itemId];
  dependency.revision = 2;
  dependency.status = "superseded";
  child.revision = 2;
  child.status = "superseded";
  child.graph.parentItemId = parent.itemId;
  const state = stateWithItems([parent, dependency, child]);

  assert.doesNotThrow(() =>
    assertWorkLedgerGraphClaimable(state, parent.itemId)
  );
  assert.doesNotThrow(() =>
    assertWorkLedgerGraphCompletable(state, parent.itemId)
  );
});

test("ledger graph revisions and recoverable statuses follow the ledger CAS", () => {
  const empty = emptyWorkLedgerState();
  const queued = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const first = stateWithItems([queued]);

  assert.equal(projectWorkLedgerGraphSnapshot(empty).revision, 0);
  assert.equal(projectWorkLedgerGraphSnapshot(first).revision, 1);
  assert.doesNotThrow(() => validateWorkLedgerGraphTransition(empty, first));

  const active = structuredClone(first);
  active.revision = 2;
  active.items[0].revision = 2;
  active.items[0].status = "working";
  assert.doesNotThrow(() => validateWorkLedgerGraphTransition(first, active));

  for (const status of ["waiting_user", "retry_wait", "blocked"]) {
    const waiting = structuredClone(active);
    waiting.revision = 3;
    waiting.items[0].revision = 3;
    waiting.items[0].status = status;
    assert.doesNotThrow(() =>
      validateWorkLedgerGraphTransition(active, waiting),
    );

    const requeued = structuredClone(waiting);
    requeued.revision = 4;
    requeued.items[0].revision = 4;
    requeued.items[0].status = "queued";
    assert.doesNotThrow(() =>
      validateWorkLedgerGraphTransition(waiting, requeued),
    );
  }
});

test("schema v2 composes graph and identity migrations without changing ledger facts", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 2;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(migrated, current);
  assert.deepEqual(legacy, callerSnapshot);
});

test("schema v3 migrates identically to the current schema before graph tasks are admitted", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 3;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
    for (const contract of item.graph.acceptanceContracts) {
      delete contract.recordedAt;
    }
  }
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(migrated, current);
  assert.deepEqual(legacy, callerSnapshot);
});

test("schema v4 backfills graph history timestamps without mutating the caller", () => {
  const current = stateWithDeliveryHistory([
    graphDelivery(),
    graphDelivery({ revision: 2, status: "accepted" }),
  ], { statusReason: "delivery_accepted" });
  current.items[0].updatedAt = "2026-08-03T02:00:00.000Z";
  const legacy = structuredClone(current);
  legacy.schemaVersion = 4;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
    for (const contract of item.graph.acceptanceContracts) {
      delete contract.recordedAt;
    }
    for (const delivery of item.graph.deliveries) {
      delete delivery.recordedAt;
    }
  }
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.deepEqual(legacy, callerSnapshot);
  assert.deepEqual(
    migrated.items[0].graph.acceptanceContracts.map(({ recordedAt }) =>
      recordedAt
    ),
    [CREATED_AT],
  );
  assert.deepEqual(
    migrated.items[0].graph.deliveries.map(({ recordedAt }) => recordedAt),
    [CREATED_AT, CREATED_AT],
  );
});

test("schema v5 seeds a deterministic durable graph memory backlog", () => {
  const current = normalizeWorkLedgerPersistedState(stateWithDeliveryHistory([
    graphDelivery(),
    graphDelivery({ revision: 2, status: "accepted" }),
  ], { statusReason: "delivery_accepted" }));
  const legacy = structuredClone(current);
  legacy.schemaVersion = 5;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
  }
  const callerSnapshot = structuredClone(legacy);

  const migrated = normalizeWorkLedgerPersistedState(legacy);

  assert.deepEqual(migrated, current);
  assert.deepEqual(legacy, callerSnapshot);
  assert.deepEqual(
    migrated.graphMemoryProjection.pending.map(({ kind }) => kind),
    ["acceptance_contract", "delivery_submitted", "delivery_accepted"],
  );
});

test("schema v5 graph memory migration fails closed when event budget is exhausted", () => {
  const current = stateWithItems([
    createAssignmentWorkItem(assignment(1), CREATED_AT),
  ]);
  const legacy = structuredClone(current);
  legacy.schemaVersion = 5;
  delete legacy.graphMemoryProjection;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
  }
  const callerSnapshot = structuredClone(legacy);

  assert.throws(
    () => normalizeWorkLedgerPersistedState(legacy, {
      graphMemoryEventByteBudget: 1,
    }),
    corrupted,
  );
  assert.deepEqual(legacy, callerSnapshot);
});

test("schema v6 adds graph source integrity without rewriting its event queue", () => {
  const seeded = normalizeWorkLedgerPersistedState(stateWithDeliveryHistory([
    graphDelivery(),
    graphDelivery({ revision: 2, status: "accepted" }),
  ], { statusReason: "delivery_accepted" }));
  const acknowledged = acknowledgeWorkGraphMemoryProjectionBatch(
    seeded.graphMemoryProjection,
    {
      receipts: seeded.graphMemoryProjection.pending
        .slice(0, 2)
        .map(workGraphMemoryRecordReceipt),
    },
    seeded.revision + 1,
  );
  const current = normalizeWorkLedgerPersistedState({
    ...seeded,
    revision: seeded.revision + 1,
    graphMemoryProjection: acknowledged.projection,
  });
  const legacy = structuredClone(current);
  legacy.schemaVersion = 6;
  delete legacy.graphMemoryProjection.sourceHistoryDigest;
  for (const item of legacy.items) {
    delete item.source;
    delete item.sourceQuarantine;
  }
  const legacyProjection = structuredClone(legacy.graphMemoryProjection);

  const migrated = normalizeWorkLedgerPersistedState(legacy);
  const { sourceHistoryDigest, ...projection } = migrated.graphMemoryProjection;

  assert.equal(migrated.schemaVersion, WORK_LEDGER_STATE_SCHEMA_VERSION);
  assert.match(sourceHistoryDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(projection, legacyProjection);
});

test("graph memory projection recovery rejects forged events and checkpoints", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const forgedEvent = structuredClone(current);
  forgedEvent.graphMemoryProjection.pending[0].memoryRecord.title = "forged";
  assert.throws(
    () => normalizeWorkLedgerPersistedState(forgedEvent),
    corrupted,
  );

  const skipped = structuredClone(current);
  skipped.graphMemoryProjection.cursor = 1;
  skipped.graphMemoryProjection.pending = [];
  assert.throws(
    () => normalizeWorkLedgerPersistedState(skipped),
    corrupted,
  );

  const forgedHistoryDigest = structuredClone(current);
  forgedHistoryDigest.graphMemoryProjection.sourceHistoryDigest = "0".repeat(64);
  assert.throws(
    () => normalizeWorkLedgerPersistedState(forgedHistoryDigest),
    corrupted,
  );
});

test("recovery rejects rewrites to older fully acknowledged graph history", () => {
  const current = normalizeWorkLedgerPersistedState(stateWithDeliveryHistory([
    graphDelivery(),
    graphDelivery({ revision: 2, status: "accepted" }),
  ], { statusReason: "delivery_accepted" }));
  const acknowledgement = acknowledgeWorkGraphMemoryProjectionBatch(
    current.graphMemoryProjection,
    {
      receipts: current.graphMemoryProjection.pending.map(
        workGraphMemoryRecordReceipt,
      ),
    },
    current.revision + 1,
  );
  const acknowledged = normalizeWorkLedgerPersistedState({
    ...current,
    revision: current.revision + 1,
    graphMemoryProjection: acknowledgement.projection,
  });
  const rewritten = structuredClone(acknowledged);
  rewritten.items[0].graph.deliveries[0].summary = "rewritten history";

  assert.throws(
    () => normalizeWorkLedgerPersistedState(rewritten),
    corrupted,
  );
});

test("schema v2 preserves responsibility IDs accepted by the existing ledger", () => {
  for (const target of [
    { type: "role", id: "审查员" },
    { type: "person", id: "alice@example.com" },
    { type: "node", id: "PR review node" },
  ]) {
    const current = stateWithItems([
      createAssignmentWorkItem(assignment(1, target), CREATED_AT),
    ]);
    current.schemaVersion = 2;
    delete current.graphMemoryProjection;
    for (const item of current.items) {
      delete item.graph;
      delete item.source;
      delete item.sourceQuarantine;
    }

    assert.deepEqual(
      normalizeWorkLedgerPersistedState(current).items[0].currentTarget,
      target,
    );
  }
});

test("schema v1 composes both migrations and initializes both later checkpoints", () => {
  const current = normalizeWorkLedgerPersistedState(
    stateWithItems([createAssignmentWorkItem(assignment(1), CREATED_AT)]),
  );
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.graphMemoryProjection;
  delete legacy.proposalCursor;
  delete legacy.proposalHighWatermark;
  for (const item of legacy.items) {
    delete item.graph;
    delete item.source;
    delete item.sourceQuarantine;
  }

  assert.deepEqual(normalizeWorkLedgerPersistedState(legacy), current);
});

test("delivery recovery accepts only a pending submission or its bound decision", async (t) => {
  const submitted = graphDelivery();

  await t.test("one pending submission", () => {
    const state = stateWithDeliveryHistory([submitted], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });

    assert.doesNotThrow(() => normalizeWorkLedgerPersistedState(state));
  });

  await t.test("one evidence-bound decision", () => {
    const accepted = graphDelivery({ revision: 2, status: "accepted" });
    const state = stateWithDeliveryHistory([submitted, accepted], {
      statusReason: "delivery_accepted",
    });

    assert.doesNotThrow(() => normalizeWorkLedgerPersistedState(state));
  });
});

test("delivery recovery rejects ambiguous or evidence-rewritten histories", async (t) => {
  await t.test("two pending submissions", () => {
    const state = stateWithDeliveryHistory([
      graphDelivery(),
      graphDelivery({
        deliverableId: "test-report",
        revision: 2,
      }),
    ], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("decision evidence differs from its submission", () => {
    const state = stateWithDeliveryHistory([
      graphDelivery(),
      graphDelivery({
        revision: 2,
        status: "accepted",
        contentDigest: "b".repeat(64),
      }),
    ], {
      statusReason: "delivery_accepted",
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("pending submission without the waiting state", () => {
    const state = stateWithDeliveryHistory([graphDelivery()]);

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("accepted deliverable resubmitted under the same contract", () => {
    const state = stateWithDeliveryHistory([
      graphDelivery(),
      graphDelivery({ revision: 2, status: "accepted" }),
      graphDelivery({ revision: 3 }),
      graphDelivery({ revision: 4, status: "rejected" }),
    ], {
      statusReason: "delivery_rejected",
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("pending submission bound to an obsolete contract", () => {
    const state = stateWithDeliveryHistory([graphDelivery()], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });
    const firstContract = state.items[0].graph.acceptanceContracts[0];
    state.items[0].graph.acceptanceContracts.push({
      ...structuredClone(firstContract),
      revision: 2,
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });
});

test("graph history timestamps are immutable, canonical, and causally ordered", async (t) => {
  await t.test("missing timestamp", () => {
    const state = stateWithDeliveryHistory([graphDelivery()], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });
    delete state.items[0].graph.deliveries[0].recordedAt;

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("timestamp before its contract", () => {
    const state = stateWithDeliveryHistory([
      graphDelivery({ recordedAt: "2026-08-03T00:59:59.000Z" }),
    ], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("timestamp after item update", () => {
    const state = stateWithDeliveryHistory([
      graphDelivery({ recordedAt: "2026-08-03T01:00:01.000Z" }),
    ], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("transition rewrites a stored timestamp", () => {
    const previous = stateWithDeliveryHistory([graphDelivery()], {
      status: "waiting_external",
      statusReason: "delivery_submitted",
    });
    const next = structuredClone(previous);
    next.revision += 1;
    next.items[0].revision += 1;
    next.items[0].graph.deliveries[0].recordedAt =
      "2026-08-03T01:00:01.000Z";
    next.items[0].updatedAt = "2026-08-03T01:00:01.000Z";

    assert.throws(
      () => validateWorkLedgerGraphTransition(previous, next),
      (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    );
  });
});

test("dangling and cyclic embedded graph relationships make recovery fail closed", async (t) => {
  const first = createAssignmentWorkItem(assignment(1), CREATED_AT);
  const second = createAssignmentWorkItem(assignment(2), CREATED_AT);

  await t.test("dangling parent", () => {
    const state = stateWithItems([first]);
    state.items[0].graph.parentItemId = "missing-item";
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("parent cycle", () => {
    const state = stateWithItems([
      structuredClone(first),
      structuredClone(second),
    ]);
    state.items[0].graph.parentItemId = state.items[1].itemId;
    state.items[1].graph.parentItemId = state.items[0].itemId;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });
});

test("graph metadata is an exact versioned object", async (t) => {
  const item = createAssignmentWorkItem(assignment(1), CREATED_AT);

  await t.test("extra field", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.items[0].graph.typo = true;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("missing field", () => {
    const state = stateWithItems([structuredClone(item)]);
    delete state.items[0].graph.deliveries;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("accessor field", () => {
    let invoked = false;
    const state = stateWithItems([structuredClone(item)]);
    Object.defineProperty(state.items[0].graph, "deliveries", {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    assert.equal(invoked, false);
  });

  await t.test("mixed schema v2 item", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.schemaVersion = 2;
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });

  await t.test("graph collection cap", () => {
    const state = stateWithItems([structuredClone(item)]);
    state.items[0].graph.deliveries = Array.from({ length: 257 }, () => null);
    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
  });
});

test("ledger recovery rejects sparse arrays and accessors without invoking them", async (t) => {
  for (const collection of ["items", "timeline", "outbox"]) {
    await t.test(`sparse ${collection} array`, () => {
      const state = emptyWorkLedgerState();
      state[collection] = new Array(1);
      assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    });

    await t.test(`${collection} array accessor`, () => {
      let invoked = false;
      const entries = [];
      Object.defineProperty(entries, "0", {
        enumerable: true,
        get() {
          invoked = true;
          return null;
        },
      });
      const state = emptyWorkLedgerState();
      state[collection] = entries;

      assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
      assert.equal(invoked, false);
    });
  }

  await t.test("schema v2 item array accessor", () => {
    let invoked = false;
    const items = [];
    Object.defineProperty(items, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return createAssignmentWorkItem(assignment(1), CREATED_AT);
      },
    });
    const state = emptyWorkLedgerState();
    state.schemaVersion = 2;
    state.items = items;

    assert.throws(() => normalizeWorkLedgerPersistedState(state), corrupted);
    assert.equal(invoked, false);
  });

  await t.test("item object accessor in graph projection", () => {
    let invoked = false;
    const item = createAssignmentWorkItem(assignment(1), CREATED_AT);
    Object.defineProperty(item, "status", {
      enumerable: true,
      get() {
        invoked = true;
        return "queued";
      },
    });

    assert.throws(
      () => projectWorkLedgerGraphSnapshot({ revision: 1, items: [item] }),
      (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    );
    assert.equal(invoked, false);
  });

  await t.test("revision coercion in graph projection", () => {
    let invoked = false;
    const revision = {
      valueOf() {
        invoked = true;
        return 1;
      },
    };

    assert.throws(
      () => projectWorkLedgerGraphSnapshot({ revision, items: [] }),
      (error) => error.code === "WORK_LEDGER_GRAPH_PROJECTION_INVALID",
    );
    assert.equal(invoked, false);
  });
});
