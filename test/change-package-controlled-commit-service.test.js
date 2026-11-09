import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { normalizeChangePackageControlledCommitRequest } from "../src/domain/change-package-controlled-commit.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  createControlledCommitEvidence,
  createControlledCommitMessage,
} from "../src/domain/controlled-commit-evidence.js";
import { ChangePackageControlledCommitService } from "../src/services/change-package-controlled-commit-service.js";

const RECORDED_AT = "2026-08-08T06:07:08.901Z";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function source() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "1".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "2".repeat(40),
  };
  const inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/repo#42",
    workKey: "pr:acme/repo#42",
    inputRevision: 3,
    headRevision: 5,
    headRefOid: gitTarget.headRefOid,
    eventId: "github-event-42",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
    gitTarget,
  };
  const preparationBinding = createConflictPreparationBinding({
    gitTarget,
    preparation: {
      schemaVersion: 1,
      preparationId: "5".repeat(64),
      status: "conflicted",
      baseCommitOid: gitTarget.baseRefOid,
      headCommitOid: gitTarget.headRefOid,
      mergeBaseOid: "3".repeat(40),
      resultTreeOid: "4".repeat(40),
      conflicts: [{ path: "src/conflict.js", mode: "100644" }],
      boundaryDigest: "6".repeat(64),
      evidenceDigest: "7".repeat(64),
      resultObjectDigest: "8".repeat(64),
      materialization: "full-tree",
    },
  });
  return createConflictCodeExecutionSource({ inputBinding, preparationBinding });
}

function profile(workspaceRevision) {
  const artifact = (kind, marker) => ({
    path: `proof/${kind}.json`,
    sha256: marker.repeat(64),
    bytes: 12,
  });
  return {
    id: "node-tests",
    configDigest: "9".repeat(64),
    workspaceRevision,
    actionId: "action-tests",
    attemptNumber: 1,
    imageId: "sha256:test-image",
    artifacts: {
      output: artifact("output", "a"),
      stdout: artifact("stdout", "b"),
      stderr: artifact("stderr", "c"),
    },
  };
}

function changePackage(executionSource) {
  const workspaceRevision = "d".repeat(64);
  return createChangePackage({
    job: { id: "code-job-1", revision: 7, recordDigest: "e".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "f".repeat(64) },
    grant: { digest: "0".repeat(64) },
    workspace: {
      id: "workspace-1",
      sourceRevision: "1".repeat(64),
      workspaceRevision,
    },
    passedProfiles: [profile(workspaceRevision)],
    created: [],
    modified: [{
      path: executionSource.writeScope.paths[0],
      beforeSha256: "2".repeat(64),
      content: Buffer.from("resolved conflict\n", "utf8"),
    }],
    deleted: [],
  });
}

function evidenceFor(executionSource, manifest) {
  const finalTreeOid = "6".repeat(40);
  const timestamp = Math.floor(Date.parse(RECORDED_AT) / 1_000);
  const identity = {
    name: "MyDashboard PR Engineer",
    email: "pr-engineer@mydashboard.local",
    timestamp,
    timezone: "+0000",
  };
  return createControlledCommitEvidence({
    executionSource,
    manifest,
    resolution: {
      resolvedPaths: [...executionSource.writeScope.paths],
      finalTreeOid,
    },
    commit: {
      objectFormat: "sha1",
      oid: "7".repeat(40),
      treeOid: finalTreeOid,
      parents: [
        executionSource.inputBinding.gitTarget.headRefOid,
        executionSource.inputBinding.gitTarget.baseRefOid,
      ],
      author: { ...identity },
      committer: { ...identity },
      messageDigest: sha256(createControlledCommitMessage({
        executionSource,
        manifest,
      })),
      objectSetDigest: "8".repeat(64),
    },
    createdAt: RECORDED_AT,
  });
}

function requestFor(executionSource, manifest) {
  const eventDigest = "9".repeat(64);
  return {
    eventId: `code-job-change-package-event-${eventDigest}`,
    eventDigest,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    executionSource,
    recordedAt: RECORDED_AT,
  };
}

class MemoryStore {
  value = null;
  loseWriteResponse = false;

  async read(_key, fallback) {
    return this.value === null ? structuredClone(fallback) : structuredClone(this.value);
  }

  async write(_key, value) {
    this.value = structuredClone(value);
    if (this.loseWriteResponse) {
      this.loseWriteResponse = false;
      throw new Error("state write response lost");
    }
  }
}

function builderFor(evidence, behavior = {}) {
  const state = {
    sealed: null,
    createCalls: 0,
    findCalls: 0,
    verifyCalls: 0,
    createRequests: [],
    loseCreateResponse: behavior.loseCreateResponse ?? false,
    loseVerifyResponse: behavior.loseVerifyResponse ?? false,
  };
  return {
    state,
    port: {
      async find() {
        state.findCalls += 1;
        return state.sealed === null ? null : structuredClone(state.sealed);
      },
      async create(request) {
        state.createCalls += 1;
        state.createRequests.push(request);
        state.sealed = evidence;
        if (state.loseCreateResponse) {
          state.loseCreateResponse = false;
          throw new Error("builder create response lost");
        }
        return structuredClone(evidence);
      },
      async verify({ evidenceId }) {
        state.verifyCalls += 1;
        assert.equal(evidenceId, evidence.evidenceId);
        if (state.loseVerifyResponse) {
          state.loseVerifyResponse = false;
          throw new Error("builder verify response lost");
        }
        return structuredClone(evidence);
      },
    },
  };
}

function fixture({ behavior, store = new MemoryStore() } = {}) {
  const executionSource = source();
  const sealedPackage = changePackage(executionSource);
  const evidence = evidenceFor(executionSource, sealedPackage.manifest);
  const blobs = new Map(
    sealedPackage.blobs.map((blob) => [blob.sha256, blob.content]),
  );
  const packageReader = {
    reads: 0,
    async get(packageId) {
      assert.equal(packageId, sealedPackage.manifest.packageId);
      return structuredClone(sealedPackage.manifest);
    },
    async readFile({ packageId, path }) {
      assert.equal(packageId, sealedPackage.manifest.packageId);
      const change = sealedPackage.manifest.changes.modified.find(
        (entry) => entry.path === path,
      );
      this.reads += 1;
      return Buffer.from(blobs.get(change.blob.sha256));
    },
  };
  const builder = builderFor(evidence, behavior);
  const service = new ChangePackageControlledCommitService({
    packageReader,
    controlledCommitBuilder: builder.port,
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
    operationQueue: { async enqueue(operation) { return operation(); } },
  });
  return {
    service,
    store,
    builder,
    packageReader,
    request: requestFor(executionSource, sealedPackage.manifest),
    evidence,
  };
}

for (const existingIntent of [false, true]) {
  test(`empty repair packages neither create a commit intent nor prevent restart (${existingIntent})`, async () => {
    const executionSource = createReviewRepairCodeExecutionSource({ inputBinding: source().inputBinding, writablePaths: ["src"] });
    const manifest = createChangePackage({ job: { id: "code-job-empty", revision: 1, recordDigest: "e".repeat(64) },
      proposal: { id: "proposal-empty", contentDigest: "f".repeat(64) }, grant: { digest: "0".repeat(64) },
      workspace: { id: "workspace-empty", sourceRevision: "d".repeat(64), workspaceRevision: "d".repeat(64) },
      passedProfiles: [profile("d".repeat(64))], created: [], modified: [], deleted: [] }).manifest;
    const request = requestFor(executionSource, manifest);
    const store = new MemoryStore();
    if (existingIntent) store.value = { schemaVersion: 1, revision: 1,
      deliveries: [{ request, status: "intent", evidenceId: null, receipt: null }] };
    const original = structuredClone(store.value);
    let lookups = 0;
    const service = new ChangePackageControlledCommitService({ store,
      packageReader: { async get() { return manifest; }, async readFile() { assert.fail("no blobs to read"); } },
      controlledCommitBuilder: { async find() { lookups++; createControlledCommitMessage({ executionSource, manifest }); },
        async create() { assert.fail("no empty commit"); }, async verify() { assert.fail("no evidence exists"); } },
      exclusiveLease: { async run(fn) { return fn(); } } });
    assert.deepEqual(await service.recover(), existingIntent ? {
      deliveries: 1, committed: 0, pending: 1,
      emptyChangeDeliveryIds: [normalizeChangePackageControlledCommitRequest(request).deliveryId],
    } : { deliveries: 0, committed: 0, pending: 0 });
    await assert.rejects(service.delivery().deliver(request), { code: "CONTROLLED_COMMIT_DELIVERY_NO_CHANGES" });
    assert.equal(lookups, 0);
    assert.deepEqual(store.value, original);
  });
}

test("delivery loads sealed blobs internally, verifies evidence, and reuses its durable receipt", async () => {
  const setup = fixture();
  assert.deepEqual(await setup.service.recover(), {
    deliveries: 0,
    committed: 0,
    pending: 0,
  });

  const receipt = await setup.service.delivery().deliver(setup.request);
  assert.equal(receipt.evidenceId, setup.evidence.evidenceId);
  assert.equal(receipt.evidenceDigest, setup.evidence.evidenceDigest);
  assert.equal(receipt.commitOid, setup.evidence.commit.oid);
  assert.equal(receipt.recordedAt, RECORDED_AT);
  assert.equal(setup.builder.state.createCalls, 1);
  assert.equal(
    setup.builder.state.createRequests[0].createdAt,
    RECORDED_AT,
  );
  assert.deepEqual(
    Object.keys(setup.builder.state.createRequests[0]).sort(),
    ["blobs", "createdAt", "executionSource", "manifest"].sort(),
  );
  assert.equal(setup.packageReader.reads, 1);
  assert.equal(setup.store.value.deliveries[0].status, "committed");

  assert.deepEqual(await setup.service.delivery().deliver(setup.request), receipt);
  assert.equal(setup.builder.state.createCalls, 1);
  assert.equal(setup.packageReader.reads, 1);
  assert.ok(setup.builder.state.verifyCalls >= 2);
});

test("a lost create response is found in the sealed builder store without rebuilding", async () => {
  const setup = fixture({ behavior: { loseCreateResponse: true } });
  await setup.service.recover();

  const receipt = await setup.service.delivery().deliver(setup.request);
  assert.equal(receipt.evidenceId, setup.evidence.evidenceId);
  assert.equal(setup.builder.state.createCalls, 1);
  assert.equal(setup.builder.state.findCalls, 2);
  assert.equal(setup.store.value.deliveries[0].status, "committed");
});

test("a lost verify response resumes from persisted evidenceId after restart", async () => {
  const store = new MemoryStore();
  const setup = fixture({
    store,
    behavior: { loseVerifyResponse: true },
  });
  await setup.service.recover();
  await assert.rejects(
    setup.service.delivery().deliver(setup.request),
    /verify response lost/,
  );
  assert.equal(store.value.deliveries[0].status, "evidence");
  assert.equal(store.value.deliveries[0].evidenceId, setup.evidence.evidenceId);

  const restarted = new ChangePackageControlledCommitService({
    packageReader: setup.packageReader,
    controlledCommitBuilder: setup.builder.port,
    store,
    exclusiveLease: { async run(operation) { return operation(); } },
    operationQueue: { async enqueue(operation) { return operation(); } },
  });
  assert.deepEqual(await restarted.recover(), {
    deliveries: 1,
    committed: 1,
    pending: 0,
  });
  const receipt = await restarted.delivery().deliver(setup.request);
  assert.equal(receipt.evidenceId, setup.evidence.evidenceId);
  assert.equal(setup.builder.state.createCalls, 1);
});

test("a persisted state write acknowledgement loss converges without duplicate commit", async () => {
  const setup = fixture();
  await setup.service.recover();
  setup.store.loseWriteResponse = true;

  const receipt = await setup.service.delivery().deliver(setup.request);
  assert.equal(receipt.evidenceId, setup.evidence.evidenceId);
  assert.equal(setup.builder.state.createCalls, 1);
  assert.equal(setup.store.value.deliveries[0].status, "committed");
});

test("recovery fails closed before serving a tampered durable receipt", async () => {
  const setup = fixture();
  await setup.service.recover();
  await setup.service.delivery().deliver(setup.request);
  setup.store.value.deliveries[0].receipt.commitOid = "f".repeat(40);
  const restarted = new ChangePackageControlledCommitService({
    packageReader: setup.packageReader,
    controlledCommitBuilder: setup.builder.port,
    store: setup.store,
    exclusiveLease: { async run(operation) { return operation(); } },
    operationQueue: { async enqueue(operation) { return operation(); } },
  });

  await assert.rejects(
    restarted.recover(),
    (error) => error?.code === "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
  );
  await assert.rejects(
    restarted.delivery().deliver(setup.request),
    (error) => error?.code === "CONTROLLED_COMMIT_DELIVERY_NOT_READY",
  );
  assert.equal(setup.builder.state.createCalls, 1);
});

test("sealed historical delivery recovery defers Git verification and cannot authorize delivery", async () => {
  const setup = fixture();
  await setup.service.recover();
  await setup.service.delivery().deliver(setup.request);
  const stored = structuredClone(setup.store.value);
  const verifyCalls = setup.builder.state.verifyCalls;
  let reads = 0;
  setup.builder.port.readSealed = async () => { reads++; return structuredClone(setup.evidence); };
  setup.builder.port.verify = async () => { throw Object.assign(new Error("current preparation unavailable"), { code: "CONTROLLED_GIT_BOUNDARY_CHANGED" }); };
  const restarted = new ChangePackageControlledCommitService({
    packageReader: setup.packageReader, controlledCommitBuilder: setup.builder.port,
    store: setup.store, exclusiveLease: { async run(operation) { return operation(); } },
  });
  assert.deepEqual(await restarted.recover(), { deliveries: 1, committed: 1, pending: 0 });
  assert.equal(reads, 1);
  assert.equal(setup.builder.state.verifyCalls, verifyCalls);
  assert.deepEqual(setup.store.value, stored);
  await assert.rejects(restarted.delivery().deliver(setup.request), { code: "CONTROLLED_GIT_BOUNDARY_CHANGED" });
  setup.store.value.deliveries[0].receipt.commitOid = "f".repeat(40);
  await assert.rejects(restarted.recover(), { code: "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED" });
});

test("stale preparation history does not block recovery or authorize delivery", async () => {
  const setup = fixture();
  await setup.service.recover();
  const receipt = await setup.service.delivery().deliver(setup.request);
  const stored = structuredClone(setup.store.value);
  const verify = setup.builder.port.verify;
  setup.builder.port.verify = async () => {
    throw Object.assign(new Error("preparation changed"), { code: "CONTROLLED_GIT_BOUNDARY_CHANGED" });
  };
  const restarted = new ChangePackageControlledCommitService({
    packageReader: setup.packageReader, controlledCommitBuilder: setup.builder.port,
    store: setup.store, exclusiveLease: { async run(operation) { return operation(); } },
  });
  assert.deepEqual(await restarted.recover(), {
    deliveries: 1, committed: 0, pending: 1, stalePreparationDeliveryIds: [receipt.deliveryId],
  });
  assert.deepEqual(setup.store.value, stored);
  await assert.rejects(restarted.delivery().deliver(setup.request), { code: "CONTROLLED_GIT_BOUNDARY_CHANGED" });
  assert.equal(setup.builder.state.createCalls, 1);
  setup.store.value.deliveries[0].receipt.commitOid = "f".repeat(40);
  await assert.rejects(restarted.recover(), { code: "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED" });
  setup.store.value = structuredClone(stored);
  setup.builder.port.verify = verify;
  // The recovered service captured its verification port; a fresh runtime
  // must verify again before it can return the historical receipt.
  const current = new ChangePackageControlledCommitService({
    packageReader: setup.packageReader, controlledCommitBuilder: setup.builder.port,
    store: setup.store, exclusiveLease: { async run(operation) { return operation(); } },
  });
  await current.recover();
  assert.deepEqual(await current.delivery().deliver(setup.request), receipt);
});
