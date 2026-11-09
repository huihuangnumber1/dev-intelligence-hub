import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackupManifest } from "../src/domain/backup-manifest.js";
import { createOperationsRuntime } from "../src/operations-runtime.js";
import {
  OperationalQuiescenceGate,
} from "../src/services/operational-quiescence-gate.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  await mkdir(dataDirectory);
  await writeFile(
    path.join(dataDirectory, "work-ledger.json"),
    `${JSON.stringify({ revision: 7, items: [] })}\n`,
    "utf8",
  );
  return { root, dataDirectory, backupDirectory };
}

function manifestFor(name, bytes) {
  return createBackupManifest({
    createdAt: "2026-08-08T08:00:00.000Z",
    stores: [{ name: "fixture", revision: 0, digest: "0".repeat(64) }],
    files: [{
      path: name,
      kind: "mutable",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  });
}

test("operations runtime joins checkpoint, backup, restore, and readiness", async (t) => {
  const paths = await fixture(t);
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
  });

  assert.deepEqual(runtime.liveness(), { schemaVersion: 1, live: true });
  const readiness = await runtime.readiness();
  assert.deepEqual(readiness.recoveryBlockers, []);
  assert.deepEqual(readiness.unknownExternalActions, []);
  assert.deepEqual(readiness.probeFailures, []);
  const created = await runtime.backup.createBackup();
  assert.match(created.manifest.backupId, /^backup-[a-f0-9]{64}$/u);
  const browserStatus = await runtime.browser.readStatus();
  assert.equal(browserStatus.backups.items.length, 1);
  assert.equal(JSON.stringify(browserStatus).includes(paths.root), false);

  await writeFile(
    path.join(paths.dataDirectory, "work-ledger.json"),
    `${JSON.stringify({ revision: 8, items: [{ id: "later" }] })}\n`,
    "utf8",
  );
  const destination = path.join(paths.root, "restored-data");
  const restored = await runtime.backup.restore({
    backupId: created.manifest.backupId,
    destinationDirectory: destination,
  });
  assert.equal(restored.ready, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(destination, "work-ledger.json"), "utf8")),
    { revision: 7, items: [] },
  );
});

test("browser status exposes only the bounded PR discovery projection", async (t) => {
  const paths = await fixture(t);
  const effectiveUpdatedWindow = Object.freeze({
    mode: "rolling",
    days: 7,
    refreshStartedAt: "2026-08-13T01:02:03.004Z",
    fromInclusive: "2026-08-06T01:02:03.004Z",
  });
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
    snapshotReader: {
      async read(name) {
        assert.equal(name, "snapshot");
        return {
          refreshedAt: "2026-08-13T01:02:03.004Z",
          sourceStatus: {
            githubPullRequests: {
              ok: true,
              enabled: true,
              stale: false,
              complete: true,
              effectiveUpdatedWindow,
              secret: "must-not-leak",
            },
          },
          items: [{ token: "must-not-leak" }],
        };
      },
    },
  });

  const status = await runtime.browser.readStatus();
  assert.deepEqual(status.pullRequestDiscovery, {
    available: true,
    enabled: true,
    refreshedAt: "2026-08-13T01:02:03.004Z",
    complete: true,
    stale: false,
    effectiveUpdatedWindow,
  });
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.equal(Object.isFrozen(status.pullRequestDiscovery), true);
});

test("system status stays available when the optional snapshot projection is unreadable", async (t) => {
  const paths = await fixture(t);
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
    snapshotReader: {
      async read() {
        throw new Error("corrupt snapshot");
      },
    },
  });

  const status = await runtime.browser.readStatus();
  assert.deepEqual(status.pullRequestDiscovery, {
    available: false,
    enabled: false,
    refreshedAt: "",
    complete: false,
    stale: true,
    effectiveUpdatedWindow: null,
  });
  assert.equal(status.liveness.live, true);
});

test("operations runtime does not expose a trusted-registry replacement seam", async (t) => {
  const paths = await fixture(t);

  assert.throws(
    () => createOperationsRuntime({
      dataDirectory: paths.dataDirectory,
      backupDirectory: paths.backupDirectory,
    }, {
      testRestoreMigrationRegistryFactory: () => ({
        async migrate() {},
      }),
    }),
    /plain record/u,
  );
});

test("browser backup creation returns only a bounded manifest projection", async (t) => {
  const paths = await fixture(t);
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
  });

  const result = await runtime.browser.createBackup();
  assert.deepEqual(Object.keys(result), [
    "backupId",
    "createdAt",
    "checkpointId",
    "fileCount",
    "totalBytes",
  ]);
  assert.equal(JSON.stringify(result).includes(paths.root), false);
  assert.ok(Object.isFrozen(result));
});

test("operations readiness reports only bounded external action kinds", async (t) => {
  const paths = await fixture(t);
  let calls = 0;
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
    externalActionStatus: {
      async readRecoveryStatus() {
        calls += 1;
        return { kinds: ["github.pull-request-merge"] };
      },
    },
  });

  const readiness = await runtime.readiness();
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.unknownExternalActions, [{
    probeId: "external_actions",
    actionType: "github.pull-request-merge",
  }]);
  assert.equal(calls, 1);
});

test("backup admission closes before draining and rejects crossing writes", async (t) => {
  const paths = await fixture(t);
  let enterOptions;
  let release;
  let checkpointStarted;
  const active = new Promise((resolve) => {
    release = resolve;
  });
  const entering = new Promise((resolve) => {
    checkpointStarted = resolve;
  });
  const runtime = createOperationsRuntime(
    {
      dataDirectory: paths.dataDirectory,
      backupDirectory: paths.backupDirectory,
    },
    {
      checkpointServiceFactory(options) {
        enterOptions = options;
        return {
          async enter() {
            checkpointStarted();
            const token = await options.gate.enter();
            return {
              token,
              stores: [{ name: "work-ledger", revision: 7, digest: "a".repeat(64) }],
              files: [{
                path: "work-ledger.json",
                kind: "mutable",
                bytes: Buffer.byteLength(`${JSON.stringify({ revision: 7, items: [] })}\n`),
                sha256: "0".repeat(64),
              }],
            };
          },
          leave: (token) => options.gate.leave(token),
          capture: async () => ({
            stores: structuredClone(checkpoint.stores),
            files: structuredClone(checkpoint.files),
          }),
          reconcile: async () => ({ ready: true, blockers: [] }),
          capacity: async () => ({ warnings: [] }),
          recovery: () => ({ blockerCodes: [] }),
        };
      },
    },
  );
  const admitted = runtime.admission.run(() => active);
  const backup = runtime.backup.createBackup();
  await entering;
  assert.equal(enterOptions.gate.readStatus().mode, "closing");
  await assert.rejects(() => runtime.admission.run(async () => {}), {
    code: "SYSTEM_QUIESCING",
  });
  release();
  await admitted;
  await assert.rejects(backup, { code: "BACKUP_SOURCE_CHANGED" });
  assert.equal(enterOptions.gate.readStatus().mode, "open");
});

test("system status remains readable while a backup is draining admitted work", async (t) => {
  const paths = await fixture(t);
  let releaseOperation;
  const activeOperation = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
  });
  const admitted = runtime.admission.run(() => activeOperation);
  const backup = runtime.backup.createBackup();

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (runtime.maintenance.readStatus().mode === "closing") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const status = await Promise.race([
      runtime.browser.readStatus(),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);
    assert.notEqual(status, "timed-out");
    assert.deepEqual(status.maintenance, {
      mode: "closing",
      activeOperations: 1,
    });
  } finally {
    releaseOperation();
    await Promise.allSettled([admitted, backup]);
  }
});

test("a quiescence timeout publishes no complete or partial backup", async (t) => {
  const paths = await fixture(t);
  let releaseOperation;
  const activeOperation = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  const runtime = createOperationsRuntime(
    {
      dataDirectory: paths.dataDirectory,
      backupDirectory: paths.backupDirectory,
    },
    {
      quiescenceGateFactory: () =>
        new OperationalQuiescenceGate({ drainTimeoutMs: 20 }),
    },
  );
  const admitted = runtime.admission.run(() => activeOperation);

  try {
    await assert.rejects(runtime.backup.createBackup(), {
      code: "BACKUP_QUIESCENCE_FAILED",
    });
    assert.deepEqual(await runtime.backup.listBackups(), {
      items: [],
      incompleteCount: 0,
      unrecognizedCount: 0,
    });
    assert.equal(runtime.maintenance.readStatus().mode, "open");
  } finally {
    releaseOperation();
    await admitted;
  }
});

test("production reconciliation binds a non-noop migration to migrated facts", async (t) => {
  const paths = await fixture(t);
  await writeFile(
    path.join(paths.dataDirectory, "code-executor-state.json"),
    `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
    "utf8",
  );
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
    migration: {
      async migrate({ directory }) {
        await writeFile(
          path.join(directory, "code-executor-state.json"),
          `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
          "utf8",
        );
      },
    },
  });
  const backup = await runtime.backup.createBackup();
  const destination = path.join(paths.root, "migrated-data");

  const restored = await runtime.backup.restore({
    backupId: backup.manifest.backupId,
    destinationDirectory: destination,
  });

  assert.equal(restored.ready, true);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(destination, "code-executor-state.json"),
        "utf8",
      ),
    ),
    { schemaVersion: 3, revision: 0, sessions: {} },
  );
});

test("operations runtime makes the trusted restore pass unavoidable around extensions", async (t) => {
  const paths = await fixture(t);
  const candidate = path.join(paths.root, "candidate");
  await mkdir(candidate);
  const ownerName = "code-executor-state.json";
  const legacyBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
    "utf8",
  );
  await writeFile(path.join(candidate, ownerName), legacyBytes);
  const observedVersions = [];
  let migration;
  createOperationsRuntime(
    {
      dataDirectory: paths.dataDirectory,
      backupDirectory: paths.backupDirectory,
      migration: {
        async migrate({ directory }) {
          observedVersions.push(JSON.parse(
            await readFile(path.join(directory, ownerName), "utf8"),
          ).schemaVersion);
          await writeFile(path.join(directory, ownerName), legacyBytes);
        },
      },
    },
    {
      backupServiceFactory(options) {
        migration = options.migration;
        return {
          async createBackup() {},
          async verifyBackup() {},
          async listBackups() {
            return { items: [], incompleteCount: 0, unrecognizedCount: 0 };
          },
          async restore() {},
        };
      },
    },
  );

  await migration.migrate({
    directory: candidate,
    manifest: manifestFor(ownerName, legacyBytes),
  });
  assert.deepEqual(observedVersions, [3]);
  assert.equal(
    JSON.parse(await readFile(path.join(candidate, ownerName), "utf8"))
      .schemaVersion,
    3,
  );
});

test("the post-extension trusted pass rejects a future known owner", async (t) => {
  const paths = await fixture(t);
  const ownerPath = path.join(paths.dataDirectory, "code-executor-state.json");
  await writeFile(
    ownerPath,
    `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
    "utf8",
  );
  const runtime = createOperationsRuntime({
    dataDirectory: paths.dataDirectory,
    backupDirectory: paths.backupDirectory,
    migration: {
      async migrate({ directory }) {
        await writeFile(
          path.join(directory, "code-executor-state.json"),
          `${JSON.stringify({ schemaVersion: 4, revision: 0, sessions: {} })}\n`,
          "utf8",
        );
      },
    },
  });
  const backup = await runtime.backup.createBackup();
  const destination = path.join(paths.root, "future-extension-destination");

  await assert.rejects(
    runtime.backup.restore({
      backupId: backup.manifest.backupId,
      destinationDirectory: destination,
    }),
    (error) =>
      error?.code === "BACKUP_MIGRATION_FAILED" &&
      error.cause?.code === "RESTORE_SCHEMA_OWNER_FUTURE",
  );
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), {
    schemaVersion: 1,
    revision: 0,
    sessions: {},
  });
  await assert.rejects(readFile(
    path.join(destination, "code-executor-state.json"),
    "utf8",
  ), { code: "ENOENT" });
});
