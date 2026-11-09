import assert from "node:assert/strict";
import path from "node:path";
import { StateStore } from "../src/lib/state-store.js";
import test from "node:test";
import { createDeliveryEvidenceTarget } from "../src/domain/delivery-evidence-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  WORK_PROPOSAL_STATE_KEY,
  WorkProposalStore,
} from "../src/services/work-proposal-store.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value === null ? null : structuredClone(value);
    this.writeCount = 0;
    this.writeThenFailAt = null;
    this.lastWriteName = null;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(name, value) {
    this.writeCount += 1;
    this.lastWriteName = name;
    this.value = structuredClone(value);
    if (this.writeCount === this.writeThenFailAt) {
      throw new Error("disk acknowledgement unavailable");
    }
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

function manualClock(initial = "2026-08-02T03:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) {
      now += milliseconds;
    },
    at(milliseconds) {
      return new Date(now + milliseconds).toISOString();
    },
  };
}

function proposal(overrides = {}) {
  return {
    proposalId: "work-intent-proposal-1",
    policyVersion: 1,
    kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    binding: { repository: "acme/widgets", workspaceId: "widgets-local" },
    payload: { operation: "inspect", objective: "Find the retry path" },
    ...overrides,
  };
}

async function readyStore({
  store = new MemoryStore(),
  time = manualClock(),
  limits,
  operationQueue = new OperationQueue(),
} = {}) {
  let id = 0;
  const exclusiveLease = new ExclusiveLease();
  const proposals = new WorkProposalStore({
    store,
    exclusiveLease,
    operationQueue,
    clock: time.clock,
    idFactory: () => `lease-${++id}`,
    ...(limits ? { limits } : {}),
  });
  await proposals.recover();
  return { proposals, store, time, exclusiveLease };
}

function advanceRequest(claim, transition) {
  return {
    proposalId: claim.proposal.proposalId,
    contentDigest: claim.proposal.contentDigest,
    expectedRevision: claim.revision,
    runnerId: claim.lease.runnerId,
    leaseId: claim.lease.leaseId,
    transition,
  };
}

function runnerScope(runnerId, overrides = {}) {
  return {
    runnerId,
    allowedKinds: ["code_action_proposal"],
    allowedRoleIds: ["developer"],
    ...overrides,
  };
}

function claimAs(proposals, request, scope = runnerScope(request.runnerId)) {
  return proposals.claim(request, scope);
}

function advanceAs(proposals, request, scope = runnerScope(request.runnerId)) {
  return proposals.advance(request, scope);
}

test("create persists before returning and is idempotent by ID and digest", async () => {
  const { proposals, store, exclusiveLease } = await readyStore();
  const created = await proposals.create(proposal());
  const repeated = await proposals.create(
    proposal({
      binding: { workspaceId: "widgets-local", repository: "acme/widgets" },
    }),
  );

  assert.equal(store.lastWriteName, WORK_PROPOSAL_STATE_KEY);
  assert.equal(store.writeCount, 1);
  assert.equal(exclusiveLease.runCount, 3);
  assert.deepEqual(repeated, created);
  assert.equal(store.value.proposals[0].status, "pending_delivery");
  assert.equal(store.value.proposals[0].proposal.contentDigest, created.contentDigest);

  await assert.rejects(
    proposals.create(
      proposal({ payload: { operation: "verify", objective: "Run tests" } }),
    ),
    (error) => error.code === "WORK_PROPOSAL_ID_CONFLICT",
  );
  assert.equal(store.writeCount, 1);
});

test("a runner can exclude proposals already handled in the same cycle", async () => {
  const { proposals } = await readyStore();
  await proposals.create(proposal());
  await proposals.create(proposal({
    proposalId: "work-intent-proposal-2",
    requestedBy: { roleId: "developer", workItemId: "work-2" },
    source: { assignmentId: "assignment-2", eventId: "event-2" },
  }));

  const claimed = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
    excludeProposalIds: ["work-intent-proposal-1"],
  });

  assert.equal(claimed.proposal.proposalId, "work-intent-proposal-2");
});

test("runner claims with a lease, binds one downstream, and emits unknown once", async () => {
  const { proposals, time } = await readyStore();
  await proposals.create(proposal());
  const firstClaim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  assert.equal(firstClaim.status, "pending_delivery");
  assert.equal(firstClaim.attempt, 1);

  const running = await advanceAs(
    proposals,
    advanceRequest(firstClaim, {
      status: "running",
      downstreamRef: "code-session-1",
      nextAttemptAt: time.at(5_000),
    }),
  );
  assert.equal(running.status, "running");
  assert.equal(running.downstreamRef, "code-session-1");
  assert.equal(
    await claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    null,
  );

  time.advance(5_000);
  const secondClaim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(secondClaim, {
        status: "running",
        downstreamRef: "different-code-session",
        nextAttemptAt: time.at(5_000),
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_DOWNSTREAM_CONFLICT",
  );
  const terminal = await advanceAs(
    proposals,
    advanceRequest(secondClaim, {
      status: "unknown",
      summary: "The code session outcome is not authoritative.",
      evidence: ["session audit reconciliation failed"],
    }),
  );
  assert.equal(terminal.status, "unknown");
  assert.match(terminal.resultId, /^work-proposal-result-[a-f0-9]{64}$/);
  assert.equal(
    await claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    null,
  );

  const batch = await proposals.readResultBatch();
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.nextSequence, 1);
  assert.equal(batch.oldestAvailableSequence, 1);
  assert.equal(batch.items[0].outcome, "unknown");
  assert.equal(batch.items[0].downstreamRef, "code-session-1");
});

test("retry time and expired leases bound which runner may advance", async () => {
  const { proposals, time } = await readyStore();
  await proposals.create(proposal());
  const original = await claimAs(proposals, {
    runnerId: "runner-a",
    leaseDurationMs: 1_000,
  });
  time.advance(1_000);
  const reclaimed = await claimAs(proposals, {
    runnerId: "runner-b",
    leaseDurationMs: 30_000,
  });
  assert.equal(reclaimed.attempt, 2);
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(original, {
        status: "failed",
        summary: "old runner",
        evidence: [],
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_REVISION_CONFLICT",
  );

  await advanceAs(
    proposals,
    advanceRequest(reclaimed, {
      status: "waiting_retry",
      reason: "downstream temporarily unavailable",
      nextAttemptAt: time.at(10_000),
    }),
  );
  assert.equal(
    await claimAs(proposals, { runnerId: "runner-c", leaseDurationMs: 30_000 }),
    null,
  );
  time.advance(10_000);
  assert.equal(
    (await claimAs(proposals, { runnerId: "runner-c", leaseDurationMs: 30_000 }))
      .attempt,
    3,
  );
});

test("an acknowledged durable advance is recovered idempotently after a lost write response", async () => {
  const store = new MemoryStore();
  const { proposals, time } = await readyStore({ store });
  await proposals.create(proposal());
  const claim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  const request = advanceRequest(claim, {
    status: "running",
    downstreamRef: "code-session-1",
    nextAttemptAt: time.at(5_000),
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(proposals, request),
    /disk acknowledgement unavailable/,
  );
  assert.equal(store.value.proposals[0].status, "running");

  const recovered = await advanceAs(proposals, request);
  assert.equal(recovered.status, "running");
  assert.equal(store.writeCount, 3);
});

test("a durable claim is returned to the same scoped runner after its acknowledgement is lost", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({ store });
  await proposals.create(proposal());
  store.writeThenFailAt = 2;

  await assert.rejects(
    claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    /disk acknowledgement unavailable/,
  );
  const recovered = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });

  assert.equal(recovered.lease.leaseId, store.value.proposals[0].leaseId);
  assert.equal(recovered.revision, store.value.proposals[0].revision);
  assert.equal(store.writeCount, 2);
});

test("an exact advance retry keeps its original receipt after a later reclaim", async () => {
  const store = new MemoryStore();
  const { proposals, time } = await readyStore({ store });
  await proposals.create(proposal());
  const firstClaim = await claimAs(proposals, {
    runnerId: "runner-a",
    leaseDurationMs: 30_000,
  });
  const request = advanceRequest(firstClaim, {
    status: "running",
    downstreamRef: "code-session-1",
    nextAttemptAt: time.at(1_000),
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(proposals, request),
    /disk acknowledgement unavailable/,
  );
  const originalReceipt = structuredClone(store.value.proposals[0].lastAdvance.receipt);

  time.advance(1_000);
  await claimAs(proposals, { runnerId: "runner-b", leaseDurationMs: 30_000 });
  const recovered = await advanceAs(proposals, request);

  assert.deepEqual(recovered, originalReceipt);
  assert.equal(store.writeCount, 4);
});

test("a terminal write acknowledgement loss is visible to result consumers", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({ store });
  await proposals.create(proposal());
  const claim = await claimAs(proposals, {
    runnerId: "code-runner",
    leaseDurationMs: 30_000,
  });
  store.writeThenFailAt = 3;
  await assert.rejects(
    advanceAs(
      proposals,
      advanceRequest(claim, {
        status: "failed",
        summary: "failed deterministically",
        evidence: [],
      }),
    ),
    /disk acknowledgement unavailable/,
  );

  const batch = await proposals.readResultBatch();
  assert.equal(batch.highWatermark, 1);
  assert.equal(batch.items[0].outcome, "failed");
});

test("result batches are monotonic, bounded, and reject future cursors", async () => {
  const { proposals } = await readyStore();
  for (let index = 1; index <= 2; index += 1) {
    await proposals.create(
      proposal({
        proposalId: `work-intent-proposal-${index}`,
        requestedBy: { roleId: "developer", workItemId: `work-${index}` },
      }),
    );
    const claim = await claimAs(proposals, {
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    });
    await advanceAs(
      proposals,
      advanceRequest(claim, {
        status: "failed",
        summary: `proposal ${index} failed deterministically`,
        evidence: [],
      }),
    );
  }

  const first = await proposals.readResultBatch({ limit: 1 });
  const second = await proposals.readResultBatch({
    afterSequence: first.nextSequence,
    limit: 1,
  });
  assert.equal(first.items[0].sequence, 1);
  assert.equal(first.highWatermark, 2);
  assert.equal(second.items[0].sequence, 2);
  assert.equal(second.nextSequence, 2);

  await assert.rejects(
    proposals.readResultBatch({ afterSequence: 3 }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RESULT_CURSOR",
  );
});

test("capacity failures preserve prior state and corrupt recovery fails closed", async () => {
  const store = new MemoryStore();
  const { proposals } = await readyStore({
    store,
    limits: { maximumProposals: 1 },
  });
  await proposals.create(proposal());
  await assert.rejects(
    proposals.create(proposal({ proposalId: "work-intent-proposal-2" })),
    (error) => error.code === "WORK_PROPOSAL_CAPACITY_EXCEEDED",
  );
  assert.equal(store.value.proposals.length, 1);

  store.value.proposals[0].attempt = 99;
  await assert.rejects(
    claimAs(proposals, { runnerId: "code-runner", leaseDurationMs: 30_000 }),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
  await assert.rejects(
    proposals.readResultBatch(),
    (error) => error.code === "WORK_PROPOSAL_STORE_NOT_READY",
  );
  const broken = new WorkProposalStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
});

test("authority-filtered evidence snapshots apply filters before limit without entering the mutation queue", async () => {
  const operationQueue = {
    count: 0,
    enqueue(operation) {
      this.count += 1;
      return Promise.resolve().then(operation);
    },
  };
  const { proposals } = await readyStore({ operationQueue });
  const contract = {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "tested", description: "测试通过" },
    ],
    expectedDeliverables: [{
      deliverableId: "verification",
      kind: "test-report",
      description: "测试报告",
      required: true,
    }],
  };
  const currentTarget = createDeliveryEvidenceTarget({
    taskId: "work-1",
    roleId: "developer",
    acceptanceContract: contract,
    deliverableId: "verification",
  });
  const staleTarget = createDeliveryEvidenceTarget({
    taskId: "work-1",
    roleId: "developer",
    acceptanceContract: { ...contract, revision: 2 },
    deliverableId: "verification",
  });
  const complete = async (
    proposalId,
    evidenceTarget,
    outcome = "succeeded",
  ) => {
    await proposals.create(proposal({
      proposalId,
      binding: {
        repository: "acme/widgets",
        workspaceId: "widgets-local",
        evidenceTarget,
      },
      payload: { operation: "verify", objective: "Run delivery tests" },
    }));
    const claim = await claimAs(proposals, {
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    });
    await advanceAs(
      proposals,
      advanceRequest(claim, {
        status: outcome,
        summary: `${proposalId} terminal`,
        evidence: [],
      }),
    );
  };
  await complete("current-proposal", currentTarget);
  for (let index = 0; index < 5; index += 1) {
    await complete(`stale-proposal-${index}`, staleTarget);
  }
  await complete("failed-current-proposal", currentTarget, "failed");
  const queueCountBeforeReads = operationQueue.count;

  const page = proposals.listEvidenceCandidates({
    taskId: currentTarget.taskId,
    roleId: currentTarget.roleId,
    contractRevision: currentTarget.contractRevision,
    contractDigest: currentTarget.contractDigest,
    kinds: ["test-report"],
    limit: 1,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].proposal.proposalId, "current-proposal");
  assert.equal(page.nextBeforeSequence, null);
  const result = proposals.getResultForProposal({
    proposalId: "current-proposal",
  });
  assert.equal(result.proposalId, "current-proposal");
  assert.deepEqual(
    proposals.getResult({ resultId: result.resultId }),
    result,
  );
  assert.equal(
    proposals.getProposalForEvidence({ proposalId: "current-proposal" })
      .proposalId,
    "current-proposal",
  );
  assert.equal(operationQueue.count, queueCountBeforeReads);

  await complete("newer-current-proposal", currentTarget);
  const newestPage = proposals.listEvidenceCandidates({
    taskId: currentTarget.taskId,
    roleId: currentTarget.roleId,
    contractRevision: currentTarget.contractRevision,
    contractDigest: currentTarget.contractDigest,
    kinds: ["test-report"],
    limit: 1,
  });
  assert.equal(
    newestPage.items[0].proposal.proposalId,
    "newer-current-proposal",
  );
  assert.equal(
    newestPage.nextBeforeSequence,
    newestPage.items[0].result.sequence,
  );
  const olderPage = proposals.listEvidenceCandidates({
    taskId: currentTarget.taskId,
    roleId: currentTarget.roleId,
    contractRevision: currentTarget.contractRevision,
    contractDigest: currentTarget.contractDigest,
    kinds: ["test-report"],
    limit: 1,
    beforeSequence: newestPage.nextBeforeSequence,
  });
  assert.equal(olderPage.items[0].proposal.proposalId, "current-proposal");
  assert.equal(olderPage.nextBeforeSequence, null);

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => proposals.listEvidenceCandidates({
      taskId: currentTarget.taskId,
      roleId: currentTarget.roleId,
      contractRevision: currentTarget.contractRevision,
      contractDigest: currentTarget.contractDigest,
      kinds: ["test-report"],
      limit: 1,
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
});

test("evidence candidates exclude action-incompatible code deliverables", async () => {
  const { proposals } = await readyStore();
  const contract = {
    revision: 5,
    acceptanceCriteria: [
      { criterionId: "delivered", description: "动作生成匹配的交付物" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "代码变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "测试报告",
        required: true,
      },
    ],
  };
  const targetFor = (deliverableId) => createDeliveryEvidenceTarget({
    taskId: "work-1",
    roleId: "developer",
    acceptanceContract: contract,
    deliverableId,
  });
  const complete = async (proposalId, operation, evidenceTarget) => {
    await proposals.create(proposal({
      proposalId,
      binding: {
        repository: "acme/widgets",
        workspaceId: "widgets-local",
        evidenceTarget,
      },
      payload: { operation, objective: "Produce authoritative evidence" },
    }));
    const claim = await claimAs(proposals, {
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    });
    await advanceAs(
      proposals,
      advanceRequest(claim, {
        status: "succeeded",
        summary: `${proposalId} terminal`,
        evidence: [],
      }),
    );
  };
  const changeTarget = targetFor("implementation");
  const testTarget = targetFor("verification");
  await complete("valid-modify", "modify", changeTarget);
  await complete("invalid-modify-test", "modify", testTarget);
  await complete("valid-verify", "verify", testTarget);
  await complete("invalid-verify-change", "verify", changeTarget);

  const page = proposals.listEvidenceCandidates({
    taskId: changeTarget.taskId,
    roleId: changeTarget.roleId,
    contractRevision: changeTarget.contractRevision,
    contractDigest: changeTarget.contractDigest,
    kinds: ["change-package", "test-report"],
    limit: 10,
  });

  assert.deepEqual(
    page.items.map(({ proposal: candidate }) => candidate.proposalId),
    ["valid-verify", "valid-modify"],
  );
  assert.equal(page.nextBeforeSequence, null);
});


function versionedProposalFixture() {
  const files = new Map();
  const directory = "work-proposal-versioned-fixture";
  const target = path.join(directory, WORK_PROPOSAL_STATE_KEY + ".json");
  let reads = 0;
  const fileSystem = {
    async mkdir() {},
    async readFile(file) {
      reads += 1;
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, content) { files.set(file, content); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async rm(file) { files.delete(file); },
  };
  const store = new StateStore(directory, { fileSystem });
  const versionedReads = [];
  const readVersioned = store.readVersioned.bind(store);
  store.readVersioned = async (name, fallback, options) => {
    const result = await readVersioned(name, fallback, options);
    versionedReads.push({ ifVersion: options?.ifVersion, changed: result.changed });
    return result;
  };
  return { store, files, target, versionedReads, readCount: () => reads };
}

async function readyVersionedProposals() {
  const fixture = versionedProposalFixture();
  const context = await readyStore({ store: fixture.store });
  await context.proposals.create(proposal());
  return { ...context, ...fixture };
}

test("unchanged versioned claims keep fresh reads and detached output", async () => {
  const { proposals, versionedReads, readCount } = await readyVersionedProposals();
  const request = { runnerId: "runner-1", leaseDurationMs: 60_000 };
  const first = await claimAs(proposals, request);
  const before = readCount();
  first.proposal.payload.objective = "caller mutation";
  const repeated = await claimAs(proposals, request);
  assert.equal(readCount() - before, 1);
  assert.equal(versionedReads.at(-1)?.changed, false);
  assert.equal(repeated.proposal.payload.objective, proposal().payload.objective);
  assert.equal(Object.isFrozen(repeated.proposal), false);
  proposals.state.proposals[0].proposal.payload.objective = "public mutation";
  await assert.rejects(claimAs(proposals, request), { code: "WORK_PROPOSAL_STATE_FORKED" });
  assert.equal(proposals.ready, false);
});

test("fresh versioned reads still reject changed durable corruption and forks", async (t) => {
  const cases = [
    ["digest", (state) => { state.proposals[0].recordDigest = "0".repeat(64); }, "WORK_PROPOSAL_STATE_CORRUPTED"],
    ["fork", (state) => { state.proposals.reverse(); }, "WORK_PROPOSAL_STATE_FORKED"],
    ["rollback", (state) => Object.assign(state, { revision: 0, nextResultSequence: 1, proposals: [], results: [] }), "WORK_PROPOSAL_STATE_ROLLBACK"],
    ["deletion", null, "WORK_PROPOSAL_STATE_ROLLBACK"],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const { proposals, files, target } = await readyVersionedProposals();
    await proposals.create(proposal({ proposalId: "work-intent-proposal-2" }));
    if (mutate === null) files.delete(target);
    else { const state = JSON.parse(files.get(target)); mutate(state); files.set(target, JSON.stringify(state)); }
    await assert.rejects(claimAs(proposals, { runnerId: "runner-1", leaseDurationMs: 60_000 }), { code });
    assert.equal(proposals.ready, false);
  });
});

test("lost versioned write ACK forces fresh recovery and remains idempotent", async () => {
  const { proposals, store, versionedReads } = await readyVersionedProposals();
  const write = store.write.bind(store);
  store.write = async (...args) => {
    const version = await write(...args);
    store.write = write;
    throw new Error("lost versioned ACK");
  };
  const next = proposal({ proposalId: "work-intent-proposal-2" });
  await assert.rejects(proposals.create(next), { message: "lost versioned ACK" });
  assert.equal(proposals.ready, true);
  assert.equal(versionedReads.at(-1)?.changed, true);
  assert.equal(versionedReads.at(-1)?.ifVersion, undefined);
  const revision = proposals.state.revision;
  assert.equal((await proposals.create(next)).revision, revision);
  assert.equal(proposals.state.revision, revision);
});

test("missing write version invalidates pairing until a fresh validation", async () => {
  const { proposals, store, versionedReads } = await readyVersionedProposals();
  const write = store.write.bind(store);
  store.write = async (...args) => { await write(...args); };
  await proposals.create(proposal({ proposalId: "work-intent-proposal-2" }));
  const request = { runnerId: "runner-1", leaseDurationMs: 60_000 };
  await claimAs(proposals, request);
  assert.equal(versionedReads.at(-1)?.changed, true);
  await claimAs(proposals, request);
  assert.equal(versionedReads.at(-1)?.changed, true);
  await claimAs(proposals, request);
  assert.equal(versionedReads.at(-1)?.changed, false);
});

test("replacement mutable limits cannot retain cached validation", async () => {
  const { proposals } = await readyVersionedProposals();
  await proposals.create(proposal({ proposalId: "work-intent-proposal-2" }));
  const request = { runnerId: "runner-1", leaseDurationMs: 60_000 };
  await claimAs(proposals, request);
  proposals.limits = { ...proposals.limits };
  await claimAs(proposals, request);
  proposals.limits.maximumProposals = 1;
  await assert.rejects(claimAs(proposals, request), { code: "WORK_PROPOSAL_STATE_CORRUPTED" });
  assert.equal(proposals.ready, false);
});

test("invalid version responses fail closed", async () => {
  const { proposals, store } = await readyVersionedProposals();
  store.readVersioned = async () => ({ changed: false, version: Object.freeze({}) });
  await assert.rejects(claimAs(proposals, { runnerId: "runner-1", leaseDurationMs: 60_000 }), { code: "WORK_PROPOSAL_STATE_CORRUPTED" });
  assert.equal(proposals.ready, false);
});
