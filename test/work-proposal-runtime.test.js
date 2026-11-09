import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function configurationBinding(version) {
  return {
    version,
    configurationDigest: String(version).repeat(64),
  };
}

function readyGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(configurationBinding(1));
  return gate;
}

function cutoverToVersion(gate, version) {
  return gate.cutover((control) => {
    control.commit(configurationBinding(version));
  });
}

async function settlesBefore(promise, durationMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class BlockingStore extends MemoryStore {
  constructor() {
    super();
    this.started = deferred();
    this.release = deferred();
    this.writeCount = 0;
  }

  async write(name, value) {
    this.writeCount += 1;
    if (this.writeCount === 1) {
      this.started.resolve();
      await this.release.promise;
    }
    await super.write(name, value);
  }
}

class SelectiveBlockingStore extends MemoryStore {
  constructor() {
    super();
    this.started = deferred();
    this.release = deferred();
    this.blocking = false;
  }

  blockNextWrite() {
    this.blocking = true;
  }

  async write(name, value) {
    if (this.blocking) {
      this.blocking = false;
      this.started.resolve();
      await this.release.promise;
    }
    await super.write(name, value);
  }
}

class Guard {
  constructor(options) {
    this.options = options;
    this.acquired = false;
    this.closed = false;
  }

  async acquire() {
    this.acquired = true;
  }

  run(operation) {
    assert.equal(this.acquired, true);
    return operation();
  }

  async close() {
    this.closed = true;
  }
}

function proposal() {
  return {
    proposalId: "work-intent-proposal-1",
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    binding: { repository: "acme/widgets", pullRequestNumber: 42 },
    payload: { verdict: "comment", body: "Please add a test." },
  };
}

function runnerScopes() {
  return [
    {
      runnerId: "github-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
    {
      runnerId: "code-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer"],
    },
  ];
}

function scopedAdvanceRequest(claim, transition) {
  return {
    proposalId: claim.proposal.proposalId,
    contentDigest: claim.proposal.contentDigest,
    expectedRevision: claim.revision,
    leaseId: claim.lease.leaseId,
    transition,
  };
}

test("runtime owns one guard and exposes only least-authority frozen ports", async () => {
  let guard;
  const runtime = await createWorkProposalRuntime({
    store: new MemoryStore(),
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    idFactory: () => "lease-1",
    runnerScopes: runnerScopes(),
    createGuard(options) {
      guard = new Guard(options);
      return guard;
    },
  });

  assert.deepEqual(Object.keys(runtime).sort(), [
    "close",
    "consumer",
    "evidenceReader",
    "producer",
    "runners",
  ]);
  assert.deepEqual(Object.keys(runtime.producer), ["create"]);
  assert.deepEqual(Object.keys(runtime.runners).sort(), ["code-runner", "github-runner"]);
  assert.deepEqual(Object.keys(runtime.runners["github-runner"]).sort(), ["advance", "claim"]);
  assert.deepEqual(Object.keys(runtime.consumer), ["readResultBatch"]);
  assert.deepEqual(Object.keys(runtime.evidenceReader).sort(), [
    "getProposalForEvidence",
    "getResult",
    "getResultForProposal",
    "listEvidenceCandidates",
    "listReviewPublicationSources",
  ]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.producer), true);
  assert.equal(Object.isFrozen(runtime.runners), true);
  assert.equal(Object.isFrozen(runtime.runners["github-runner"]), true);
  assert.equal(Object.isFrozen(runtime.consumer), true);
  assert.equal(Object.isFrozen(runtime.evidenceReader), true);
  assert.equal(guard.options.name, "mydashboard-work-proposal-v1");

  assert.equal((await runtime.producer.create(proposal())).status, "pending_delivery");
  assert.equal(
    await runtime.runners["code-runner"].claim({ leaseDurationMs: 30_000 }),
    null,
  );
  const claim = await runtime.runners["github-runner"].claim({
    leaseDurationMs: 30_000,
  });
  assert.equal(claim.proposal.proposalId, proposal().proposalId);
  await assert.rejects(
    runtime.runners["code-runner"].advance(
      scopedAdvanceRequest(claim, {
        status: "failed",
        summary: "unauthorized",
        evidence: [],
      }),
    ),
    (error) => error.code === "WORK_PROPOSAL_RUNNER_FORBIDDEN",
  );
  await assert.rejects(
    runtime.runners["github-runner"].claim({
      runnerId: "code-runner",
      leaseDurationMs: 30_000,
    }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
  );
  assert.equal((await runtime.consumer.readResultBatch()).highWatermark, 0);

  await runtime.close();
  await runtime.close();
  assert.equal(guard.closed, true);
  await assert.rejects(
    runtime.producer.create(proposal()),
    (error) => error.code === "WORK_PROPOSAL_RUNTIME_CLOSED",
  );
});

test("runtime drains every accepted proposal operation before closing its guard", async () => {
  const store = new BlockingStore();
  let guard;
  const runtime = await createWorkProposalRuntime({
    store,
    createGuard(options) {
      guard = new Guard(options);
      return guard;
    },
  });
  const first = runtime.producer.create(proposal());
  await store.started.promise;
  const second = runtime.producer.create({
    ...proposal(),
    proposalId: "work-intent-proposal-2",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-2" },
  });
  const closing = runtime.close();

  assert.equal(guard.closed, false);
  store.release.resolve();
  await Promise.all([first, second, closing]);

  assert.equal(guard.closed, true);
  assert.equal(store.value.proposals.length, 2);
});

test("configuration-first proposal admission rejects a claim without mutation", async () => {
  const store = new MemoryStore();
  const gate = readyGate();
  let leaseIds = 0;
  const runtime = await createWorkProposalRuntime({
    store,
    runnerScopes: runnerScopes(),
    actionAdmissionGate: gate,
    idFactory() {
      leaseIds += 1;
      return `lease-${leaseIds}`;
    },
    createGuard: (options) => new Guard(options),
  });
  await runtime.producer.create(proposal());
  const before = structuredClone(store.value);
  await cutoverToVersion(gate, 2);

  await assert.rejects(
    runtime.runners["github-runner"].claim({ leaseDurationMs: 30_000 }),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(leaseIds, 0);
  assert.deepEqual(store.value, before);
  await runtime.close();
});

test("an admitted proposal claim releases cutover and can advance after restart is required", async () => {
  const store = new SelectiveBlockingStore();
  const gate = readyGate();
  const runtime = await createWorkProposalRuntime({
    store,
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    idFactory: () => "lease-admitted-before-cutover",
    runnerScopes: runnerScopes(),
    actionAdmissionGate: gate,
    createGuard: (options) => new Guard(options),
  });
  await runtime.producer.create(proposal());
  store.blockNextWrite();

  const claimPromise = runtime.runners["github-runner"].claim({
    leaseDurationMs: 30_000,
  });
  await store.started.promise;
  const cutover = cutoverToVersion(gate, 2);
  const cutoverFinishedBeforeClaim = await settlesBefore(cutover);
  store.release.resolve();
  const claim = await claimPromise;
  await cutover;

  assert.equal(cutoverFinishedBeforeClaim, true);
  assert.equal(claim.proposal.proposalId, proposal().proposalId);
  const advanced = await runtime.runners["github-runner"].advance(
    scopedAdvanceRequest(claim, {
      status: "failed",
      summary: "已安全收尾",
      evidence: [],
    }),
  );
  assert.equal(advanced.status, "failed");
  await runtime.producer.create({
    ...proposal(),
    proposalId: "work-intent-proposal-after-cutover",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-after-cutover" },
  });
  await assert.rejects(
    runtime.runners["github-runner"].claim({ leaseDurationMs: 30_000 }),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  await runtime.close();
});

test("runtime rejects an explicitly invalid action admission gate", async () => {
  for (const actionAdmissionGate of [null, {}]) {
    await assert.rejects(
      createWorkProposalRuntime({
        store: new MemoryStore(),
        actionAdmissionGate,
        createGuard: (options) => new Guard(options),
      }),
      /actionAdmissionGate/,
    );
  }
});

test("runtime closes its guard when durable recovery is corrupt", async () => {
  let guard;
  await assert.rejects(
    createWorkProposalRuntime({
      store: new MemoryStore({ schemaVersion: 1, revision: "bad" }),
      createGuard(options) {
        guard = new Guard(options);
        return guard;
      },
    }),
    (error) => error.code === "WORK_PROPOSAL_STATE_CORRUPTED",
  );
  assert.equal(guard.closed, true);
});
