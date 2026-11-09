import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackupService, BackupServiceError } from "../src/services/backup-service.js";
import { ownReviewFeedbackDigest } from "../src/adapters/github-own-review-feedback.js";
import {
  createOriginalRepairFeedbackArchiveRecord,
  createOriginalRepairFeedbackSnapshot,
  originalRepairFeedbackArchiveKey,
} from "../src/domain/original-repair-feedback.js";
import { DataDirectoryCheckpointService } from "../src/services/data-directory-checkpoint-service.js";
import { OperationalQuiescenceGate } from "../src/services/operational-quiescence-gate.js";
import {
  createProductionRestoreMigrationRegistry,
} from "../src/services/production-restore-migration-registry.js";

const NOW = "2026-08-07T09:00:00.000Z";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "active-data");
  const backups = path.join(root, "backups");
  await mkdir(path.join(source, "state"), { recursive: true });
  await mkdir(path.join(source, "artifacts", "package-a"), { recursive: true });
  const state = Buffer.from('{"revision":7}\n');
  const artifact = Buffer.from("sealed artifact\n");
  await writeFile(path.join(source, "state", "work-ledger.json"), state);
  await writeFile(path.join(source, "artifacts", "package-a", "blob"), artifact);
  const checkpoint = {
    token: "checkpoint-token-0001",
    stores: [{ name: "work-ledger", revision: 7, digest: digest(state) }],
    files: [
      {
        path: "state/work-ledger.json",
        kind: "mutable",
        bytes: state.length,
        sha256: digest(state),
      },
      {
        path: "artifacts/package-a/blob",
        kind: "immutable",
        bytes: artifact.length,
        sha256: digest(artifact),
      },
    ],
  };
  const calls = [];
  const quiescence =
    options.quiescenceFactory?.({ backups, calls, checkpoint }) ??
    options.quiescence ?? {
      async enter() {
        calls.push("enter");
        return structuredClone(checkpoint);
      },
      async leave(token) {
        calls.push(["leave", token]);
      },
    };
  const service = new BackupService({
    sourceDirectory: source,
    backupDirectory: backups,
    quiescence,
    migration: options.migration,
    canonicalization: options.canonicalization ?? (options.migration ? {
      async capture() {
        return {
          stores: structuredClone(checkpoint.stores),
          files: structuredClone(checkpoint.files),
        };
      },
    } : undefined),
    reconciliation: options.reconciliation ?? (options.migration ? {
      async reconcile() {
        return { ready: true, blockers: [] };
      },
    } : undefined),
    ...(options.directorySync ? { directorySync: options.directorySync } : {}),
    now: options.now ?? (() => new Date(NOW)),
  });
  return { root, source, backups, checkpoint, calls, service };
}

test("backup closes through one checkpoint, copies exact files, and verifies", async (t) => {
  const { service, calls } = await fixture(t);
  const created = await service.createBackup();

  assert.equal(created.manifest.backupId, path.basename(created.path));
  assert.deepEqual(calls, ["enter", ["leave", "checkpoint-token-0001"]]);
  assert.deepEqual((await readdir(created.path)).sort(), ["manifest.json", "payload"]);
  assert.equal(
    await readFile(path.join(created.path, "payload", "artifacts", "package-a", "blob"), "utf8"),
    "sealed artifact\n",
  );
  assert.deepEqual(
    (await service.verifyBackup(created.manifest.backupId)).manifest,
    created.manifest,
  );
});

test("real checkpoints back up and restore executor dotfiles and 300 immutable feedback archives", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-executor-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "data");
  await mkdir(source);
  const expected = new Map();
  for (let number = 1; number <= 300; number += 1) {
    const feedback = { changeRequests: [{ id: `review-${number}`, author: "reviewer", body: `Fix defect ${number}` }], threads: [] };
    const snapshot = createOriginalRepairFeedbackSnapshot({
      repository: "owner/project", number,
      context: { schemaVersion: 1, headRefOid: "a".repeat(40), reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
      provenance: { kind: "captured_before_repair", observedHeadRefOid: "a".repeat(40), observedAt: NOW },
    });
    expected.set(`${originalRepairFeedbackArchiveKey(snapshot.snapshotId)}.json`,
      Buffer.from(`${JSON.stringify(createOriginalRepairFeedbackArchiveRecord(snapshot))}\n`));
  }
  const runId = "b".repeat(64);
  for (const relative of [
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/.clang-tidy",
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/.gitattributes",
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/.gitignore",
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/Scripts/Test/.gitattributes",
    `code-executor/workspaces/.test-library/${"a".repeat(64)}/test.mjs`,
    `code-executor/windows-tests/${runId}/data/workspace/.github/workflows/test.yml`,
    `code-executor/windows-tests/${runId}/data/workspace/Packages/test/AC/Temp/.cache/result.bin`,
    `code-executor/windows-tests/${runId}/data/resources/test-assets/.config/settings.json`,
    `code-executor/windows-tests/${runId}/pending.json`,
  ]) expected.set(relative, Buffer.from(`durable bytes for ${relative}\n`));
  for (const [relative, bytes] of expected) {
    const target = path.join(source, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const gate = new OperationalQuiescenceGate();
  const checkpoint = new DataDirectoryCheckpointService({ sourceDirectory: source, gate });
  const service = new BackupService({
    sourceDirectory: source, backupDirectory: path.join(root, "backups"),
    quiescence: checkpoint, canonicalization: checkpoint, reconciliation: checkpoint,
    migration: createProductionRestoreMigrationRegistry(), now: () => new Date(NOW),
  });

  const created = await service.createBackup();
  assert.equal(created.manifest.checkpoint.stores.length, 300);
  assert.equal(created.manifest.totals.fileCount, expected.size);
  assert.deepEqual((await service.verifyBackup(created.manifest.backupId)).manifest, created.manifest);
  const restored = await service.restore({
    backupId: created.manifest.backupId, destinationDirectory: path.join(root, "restored"),
  });

  assert.equal(restored.ready, true);
  for (const [relative, bytes] of expected) {
    assert.deepEqual(await readFile(path.join(restored.path, ...relative.split("/"))), bytes);
  }
  assert.equal(gate.readStatus().mode, "open");
});

test("real checkpoints reject unknown hidden paths and executor links before backup writes", async (t) => {
  const current = await fixture(t);
  await writeFile(path.join(current.source, "checkpoint-state.json"), "{}\n");
  const gate = new OperationalQuiescenceGate();
  const checkpoint = new DataDirectoryCheckpointService({ sourceDirectory: current.source, gate });
  const service = new BackupService({
    sourceDirectory: current.source, backupDirectory: current.backups, quiescence: checkpoint,
  });
  const rejectedBeforeWrites = async (causeCode) => {
    await assert.rejects(() => service.createBackup(), (error) =>
      error.code === "BACKUP_QUIESCENCE_FAILED" && error.cause?.code === causeCode);
    await assert.rejects(lstat(current.backups), { code: "ENOENT" });
    assert.equal(gate.readStatus().mode, "open");
  };
  const unknown = path.join(current.source, ".unknown.json");
  await writeFile(unknown, "{}\n");
  await rejectedBeforeWrites("CHECKPOINT_PATH_INVALID");
  await rm(unknown);

  const execution = path.join(current.source, "code-executor", "workspaces", "oct-software", "attempt-1");
  await mkdir(execution, { recursive: true });
  const outside = path.join(current.root, "outside");
  await mkdir(outside);
  const sentinel = path.join(outside, "sentinel.txt");
  await writeFile(sentinel, "outside bytes\n");
  const alias = path.join(execution, ".github");
  await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await rejectedBeforeWrites("CHECKPOINT_PATH_INVALID");
  await rm(alias);
  await link(sentinel, path.join(execution, ".gitignore"));
  await rejectedBeforeWrites("CHECKPOINT_FILE_INVALID");
  assert.equal(await readFile(sentinel, "utf8"), "outside bytes\n");
});

test("corrupt executor manifest paths cannot create a restore candidate", async (t) => {
  const current = await fixture(t);
  const created = await current.service.createBackup();
  const manifestPath = path.join(created.path, "manifest.json");
  for (const unsafePath of [
    ".unknown.json",
    "code-executor/workspaces/oct-software/attempt-1/../.gitignore",
    "code-executor/workspaces/oct-software/attempt-1/.cache/file:stream",
    "code-executor/workspaces/oct-software/attempt-1/.cache/NUL.txt",
    `code-executor/windows-tests/${"a".repeat(64)}/data/control/.unknown`,
    `code-executor/workspaces/.test-library/${"a".repeat(64)}/unknown.mjs`,
  ]) {
    const corrupted = structuredClone(created.manifest);
    corrupted.files[0].path = unsafePath;
    await writeFile(manifestPath, JSON.stringify(corrupted));
    const destination = path.join(current.root, "unsafe-restore");
    await assert.rejects(current.service.restore({
      backupId: created.manifest.backupId, destinationDirectory: destination,
    }), { code: "BACKUP_CORRUPTED" });
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.equal((await readdir(current.root)).some((name) => name.startsWith(".restore-")), false);
  }
});

test("backup catalog is newest-first, bounded, and never exposes local paths", async (t) => {
  let now = new Date("2026-08-08T01:00:00.000Z");
  const { service, source, backups, checkpoint } = await fixture(t, {
    now: () => now,
  });
  const first = await service.createBackup();
  const nextState = Buffer.from('{"revision":8}\n');
  await writeFile(path.join(source, "state", "work-ledger.json"), nextState);
  checkpoint.stores[0].revision = 8;
  checkpoint.stores[0].digest = digest(nextState);
  checkpoint.files[0].bytes = nextState.length;
  checkpoint.files[0].sha256 = digest(nextState);
  now = new Date("2026-08-08T02:00:00.000Z");
  const second = await service.createBackup();

  const catalog = await service.listBackups();
  assert.deepEqual(catalog.items.map(({ backupId }) => backupId), [
    second.manifest.backupId,
    first.manifest.backupId,
  ]);
  assert.equal(catalog.items.every(({ status }) => status === "verified"), true);
  assert.equal(JSON.stringify(catalog).includes(source), false);
  assert.equal(JSON.stringify(catalog).includes(backups), false);
  assert.deepEqual(
    Object.keys(catalog.items[0]),
    ["backupId", "createdAt", "checkpointId", "fileCount", "totalBytes", "status"],
  );
});

test("status reads the bounded catalog and explicit verification refreshes corruption", async (t) => {
  const { service } = await fixture(t);
  const created = await service.createBackup();
  await writeFile(
    path.join(created.path, "payload", "state", "work-ledger.json"),
    "tampered after last verification\n",
  );

  const cached = await service.listBackups();
  assert.equal(cached.items[0].status, "verified");
  await assert.rejects(
    service.verifyBackup(created.manifest.backupId),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_CORRUPTED",
  );
  const refreshed = await service.listBackups();
  assert.equal(refreshed.items[0].status, "corrupted");
});

test("an invalid verification request cannot poison the bounded catalog", async (t) => {
  const { service } = await fixture(t);
  const created = await service.createBackup();

  await assert.rejects(service.verifyBackup("not-a-backup"), {
    code: "BACKUP_CORRUPTED",
  });
  const catalog = await service.listBackups();
  assert.deepEqual(catalog.items.map(({ backupId, status }) => ({ backupId, status })), [{
    backupId: created.manifest.backupId,
    status: "verified",
  }]);
});

test("backup and restore publications durably sync their parent directories", async (t) => {
  const synced = [];
  const current = await fixture(t, {
    directorySync: async (directory) => synced.push(path.resolve(directory)),
  });
  const created = await current.service.createBackup();
  assert.equal(synced.includes(path.resolve(current.backups)), true);

  const destination = path.join(current.root, "durably-restored");
  await current.service.restore({
    backupId: created.manifest.backupId,
    destinationDirectory: destination,
  });
  assert.equal(synced.includes(path.resolve(path.dirname(destination))), true);
});

test("backup is verified and released before authoritative publish", async (t) => {
  const current = await fixture(t, {
    quiescenceFactory: ({ backups, calls, checkpoint }) => ({
      async enter() {
        calls.push("enter");
        return structuredClone(checkpoint);
      },
      async leave(token) {
        calls.push(["leave", token]);
        const entries = await readdir(backups);
        assert.equal(entries.some((name) => name.startsWith("backup-")), false);
        assert.equal(entries.filter((name) => name.startsWith(".partial-")).length, 1);
      },
    }),
  });

  const created = await current.service.createBackup();

  assert.equal(path.basename(created.path), created.manifest.backupId);
  assert.deepEqual((await readdir(current.backups)).sort(), [
    ".backup-catalog-v1.json",
    created.manifest.backupId,
  ]);
});

test("checkpoint release failure leaves no authoritative or partial backup", async (t) => {
  const current = await fixture(t, {
    quiescenceFactory: ({ calls, checkpoint }) => ({
      async enter() {
        calls.push("enter");
        return structuredClone(checkpoint);
      },
      async leave(token) {
        calls.push(["leave", token]);
        throw new Error("release secret must not escape");
      },
    }),
  });

  await assert.rejects(
    current.service.createBackup(),
    (error) =>
      error instanceof BackupServiceError &&
      error.code === "BACKUP_RELEASE_FAILED" &&
      !JSON.stringify(error).includes("release secret"),
  );
  assert.deepEqual(await readdir(current.backups), []);
});

test("retry after a lost response reuses the verified content-addressed backup", async (t) => {
  let now = NOW;
  const current = await fixture(t, { now: () => new Date(now) });
  const first = await current.service.createBackup();
  now = "2026-08-07T09:05:00.000Z";

  const retried = await current.service.createBackup();

  assert.equal(retried.manifest.backupId, first.manifest.backupId);
  assert.deepEqual(retried.manifest, first.manifest);
  assert.equal(retried.path, first.path);
  assert.deepEqual((await readdir(current.backups)).sort(), [
    ".backup-catalog-v1.json",
    first.manifest.backupId,
  ]);
});

test("failed quiescence and changed checkpoint files produce no snapshot", async (t) => {
  const first = await fixture(t, {
    quiescence: {
      async enter() {
        throw new Error("writer would not drain");
      },
      async leave() {
        assert.fail("leave must not run without a checkpoint");
      },
    },
  });
  await assert.rejects(
    first.service.createBackup(),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_QUIESCENCE_FAILED",
  );
  await assert.rejects(readdir(first.backups), { code: "ENOENT" });

  const second = await fixture(t);
  await writeFile(path.join(second.source, "state", "work-ledger.json"), "changed\n");
  await assert.rejects(
    second.service.createBackup(),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_SOURCE_CHANGED",
  );
  assert.deepEqual(await readdir(second.backups), []);
  assert.equal(second.calls.at(-1)[0], "leave");

  const third = await fixture(t, {
    quiescenceFactory: ({ calls, checkpoint }) => ({
      async enter() {
        calls.push("enter");
        return { ...structuredClone(checkpoint), stores: [] };
      },
      async leave(token) {
        calls.push(["leave", token]);
      },
    }),
  });
  await assert.rejects(
    third.service.createBackup(),
    (error) =>
      error instanceof BackupServiceError &&
      error.code === "BACKUP_QUIESCENCE_INVALID",
  );
  assert.deepEqual(third.calls, ["enter", ["leave", "checkpoint-token-0001"]]);
  assert.deepEqual(await readdir(third.backups), []);
});

test("untrusted checkpoint and port proxies are rejected without executing traps", async (t) => {
  let checkpointTraps = 0;
  const current = await fixture(t, {
    quiescence: {
      async enter() {
        return new Proxy({}, {
          getPrototypeOf() {
            checkpointTraps += 1;
            throw new Error("checkpoint trap must not run");
          },
        });
      },
      async leave() {},
    },
  });
  await assert.rejects(
    current.service.createBackup(),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_QUIESCENCE_INVALID",
  );
  assert.equal(checkpointTraps, 0);

  let portTraps = 0;
  const port = {};
  Object.defineProperty(port, "enter", {
    get() {
      portTraps += 1;
      throw new Error("port accessor must not run");
    },
  });
  Object.defineProperty(port, "leave", { value() {} });
  assert.throws(
    () => new BackupService({
      sourceDirectory: current.source,
      backupDirectory: current.backups,
      quiescence: port,
    }),
    TypeError,
  );
  assert.equal(portTraps, 0);

  let optionTraps = 0;
  const options = new Proxy({}, {
    get() {
      optionTraps += 1;
      throw new Error("constructor option trap must not run");
    },
  });
  assert.throws(() => new BackupService(options), TypeError);
  assert.equal(optionTraps, 0);

  let restoreTraps = 0;
  assert.throws(
    () => current.service.restore(new Proxy({}, {
      get() {
        restoreTraps += 1;
        throw new Error("restore request trap must not run");
      },
    })),
    TypeError,
  );
  assert.equal(restoreTraps, 0);
});

test("tampering and undeclared payload files fail verification", async (t) => {
  const { service } = await fixture(t);
  const created = await service.createBackup();
  const payload = path.join(created.path, "payload", "state", "work-ledger.json");
  await writeFile(payload, "tampered\n");
  await assert.rejects(
    service.verifyBackup(created.manifest.backupId),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_CORRUPTED",
  );

  const fresh = await fixture(t);
  const other = await fresh.service.createBackup();
  await writeFile(path.join(other.path, "payload", "undeclared"), "x");
  await assert.rejects(
    fresh.service.verifyBackup(other.manifest.backupId),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_CORRUPTED",
  );
});

test("verification rejects a payload hard link even when its bytes still match", async (t) => {
  const { root, service } = await fixture(t);
  const created = await service.createBackup();
  const payload = path.join(created.path, "payload", "state", "work-ledger.json");
  const external = path.join(root, "external-hard-link-source");
  await writeFile(external, '{"revision":7}\n');
  await rm(payload);
  await link(external, payload);

  await assert.rejects(
    service.verifyBackup(created.manifest.backupId),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_CORRUPTED",
  );
});

test("verification bounds deeply nested undeclared payload traversal", async (t) => {
  const { service } = await fixture(t);
  const created = await service.createBackup();
  let directory = path.join(created.path, "payload");
  for (let index = 0; index < 140; index += 1) {
    directory = path.join(directory, `d${index}`);
    await mkdir(directory);
  }
  await writeFile(path.join(directory, "undeclared"), "x");

  await assert.rejects(
    service.verifyBackup(created.manifest.backupId),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_CORRUPTED",
  );
});

test("restore validates, migrates, reconciles read-only, and atomically publishes", async (t) => {
  const observed = [];
  const { root, service } = await fixture(t, {
    migration: {
      async migrate({ directory }) {
        observed.push(["migrate", directory]);
      },
    },
    reconciliation: {
      async reconcile({ directory, mode }) {
        observed.push(["reconcile", directory, mode]);
        return { ready: true, blockers: [] };
      },
    },
  });
  const created = await service.createBackup();
  const destination = path.join(root, "restored-data");
  const restored = await service.restore({
    backupId: created.manifest.backupId,
    destinationDirectory: destination,
  });

  assert.equal(restored.ready, true);
  assert.equal(restored.path, destination);
  assert.equal(
    await readFile(path.join(destination, "state", "work-ledger.json"), "utf8"),
    '{"revision":7}\n',
  );
  assert.equal(observed[0][0], "migrate");
  assert.deepEqual(observed[1], ["reconcile", observed[0][1], "read-only"]);
  assert.equal(observed[0][1].startsWith(path.dirname(destination)), true);
});

test("restore remains available when the active data directory was lost", async (t) => {
  const { root, source, service } = await fixture(t);
  const created = await service.createBackup();
  await rm(source, { recursive: true });
  const destination = path.join(root, "disaster-recovery-data");

  const restored = await service.restore({
    backupId: created.manifest.backupId,
    destinationDirectory: destination,
  });

  assert.equal(restored.ready, true);
  assert.equal(
    await readFile(path.join(destination, "state", "work-ledger.json"), "utf8"),
    '{"revision":7}\n',
  );
});

test("backup and restore exclude the external Codex login mirror from all recovery evidence", async (t) => {
  const current = await fixture(t);
  const sourceMachineHome = path.join(current.root, "source-machine-home");
  const mirrorDirectory = path.join(
    sourceMachineHome,
    ".mydashboard-cli-credentials-v1",
    "codex-login",
  );
  const sentinelName = "fictional-codex-mirror-sentinel.json";
  const sentinelBytes = Buffer.from("fictional-codex-mirror-bytes-never-backed-up");
  await mkdir(mirrorDirectory, { recursive: true });
  await writeFile(path.join(mirrorDirectory, sentinelName), sentinelBytes);

  const created = await current.service.createBackup();
  const payloadFiles = await readdir(path.join(created.path, "payload"), { recursive: true });
  const payloadBytes = Buffer.concat([
    await readFile(path.join(created.path, "payload", "state", "work-ledger.json")),
    await readFile(path.join(created.path, "payload", "artifacts", "package-a", "blob")),
  ]).toString("utf8");
  const catalog = await current.service.listBackups();
  const recoveryEvidence = JSON.stringify({
    manifest: created.manifest,
    payloadFiles,
    catalog,
  });
  assert.equal(recoveryEvidence.includes(sentinelName), false);
  assert.equal(recoveryEvidence.includes(sentinelBytes.toString("utf8")), false);
  assert.equal(recoveryEvidence.includes(mirrorDirectory), false);
  assert.equal(payloadBytes.includes(sentinelBytes.toString("utf8")), false);

  const destinationMachineHome = path.join(current.root, "destination-machine-home");
  await mkdir(destinationMachineHome);
  const restoredData = path.join(destinationMachineHome, "data");
  const restored = await current.service.restore({
    backupId: created.manifest.backupId,
    destinationDirectory: restoredData,
  });
  const restoredInventory = await readdir(restored.path, { recursive: true });
  const restoredBytes = Buffer.concat([
    await readFile(path.join(restored.path, "state", "work-ledger.json")),
    await readFile(path.join(restored.path, "artifacts", "package-a", "blob")),
  ]).toString("utf8");
  assert.equal(JSON.stringify(restoredInventory).includes(sentinelName), false);
  assert.equal(restoredBytes.includes(sentinelBytes.toString("utf8")), false);
  await assert.rejects(
    lstat(path.join(destinationMachineHome, ".mydashboard-cli-credentials-v1")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await readFile(path.join(mirrorDirectory, sentinelName)), sentinelBytes);
});

test("failed migration or reconciliation leaves no activated destination", async (t) => {
  for (const [port, code] of [
    [
      { migration: { async migrate() { throw new Error("bad migration"); } } },
      "BACKUP_MIGRATION_FAILED",
    ],
    [
      {
        reconciliation: {
          async reconcile() {
            return { ready: false, blockers: ["unknown action"] };
          },
        },
      },
      "BACKUP_RECONCILIATION_BLOCKED",
    ],
  ]) {
    await t.test(code, async (child) => {
      const current = await fixture(child, port);
      const created = await current.service.createBackup();
      const destination = path.join(current.root, `failed-${code}`);
      await assert.rejects(
        current.service.restore({
          backupId: created.manifest.backupId,
          destinationDirectory: destination,
        }),
        (error) => error instanceof BackupServiceError && error.code === code,
      );
      await assert.rejects(readdir(destination), { code: "ENOENT" });
      assert.equal(
        (await readdir(current.root)).some((name) =>
          name.startsWith(`.restore-${path.basename(destination)}-`)),
        false,
      );
    });
  }
});

test("a trusted owner failure preserves active bytes and removes the candidate", async (t) => {
  const current = await fixture(t, {
    migration: createProductionRestoreMigrationRegistry(),
  });
  const future = Buffer.from(
    `${JSON.stringify({ schemaVersion: 4, revision: 0, sessions: {} })}\n`,
  );
  const ownerPath = path.join(current.source, "code-executor-state.json");
  await writeFile(ownerPath, future);
  current.checkpoint.stores.push({
    name: "code-executor-state",
    revision: 0,
    digest: digest(future),
  });
  current.checkpoint.files.push({
    path: "code-executor-state.json",
    kind: "mutable",
    bytes: future.length,
    sha256: digest(future),
  });
  const created = await current.service.createBackup();
  const destination = path.join(current.root, "future-owner-restore");

  await assert.rejects(
    current.service.restore({
      backupId: created.manifest.backupId,
      destinationDirectory: destination,
    }),
    (error) =>
      error instanceof BackupServiceError &&
      error.code === "BACKUP_MIGRATION_FAILED" &&
      error.cause?.code === "RESTORE_SCHEMA_OWNER_FUTURE",
  );
  assert.deepEqual(await readFile(ownerPath), future);
  await assert.rejects(readdir(destination), { code: "ENOENT" });
  assert.equal(
    (await readdir(current.root)).some((name) =>
      name.startsWith(`.restore-${path.basename(destination)}-`)
    ),
    false,
  );
});

test("restore passively rejects an untrusted reconciliation result", async (t) => {
  let traps = 0;
  const secret = "reconciliation-secret-never-render";
  const current = await fixture(t, {
    reconciliation: {
      async reconcile() {
        return new Proxy({ secret }, {
          getPrototypeOf() {
            traps += 1;
            throw new Error(secret);
          },
        });
      },
    },
  });
  const created = await current.service.createBackup();

  await assert.rejects(
    current.service.restore({
      backupId: created.manifest.backupId,
      destinationDirectory: path.join(current.root, "untrusted-reconciliation"),
    }),
    (error) =>
      error instanceof BackupServiceError &&
      error.code === "BACKUP_RECONCILIATION_BLOCKED" &&
      !JSON.stringify(error).includes(secret),
  );
  assert.equal(traps, 0);
});

test("constructor and restore reject overlapping or existing targets", async (t) => {
  const current = await fixture(t);
  assert.throws(
    () => new BackupService({
      sourceDirectory: current.source,
      backupDirectory: path.join(current.source, "backups"),
      quiescence: { enter() {}, leave() {} },
    }),
    /must not overlap/,
  );
  const created = await current.service.createBackup();
  const destination = path.join(current.root, "already-there");
  await mkdir(destination);
  await writeFile(path.join(destination, "preserved"), "yes");
  await assert.rejects(
    current.service.restore({
      backupId: created.manifest.backupId,
      destinationDirectory: destination,
    }),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_DESTINATION_EXISTS",
  );
  assert.equal(await readFile(path.join(destination, "preserved"), "utf8"), "yes");
});

test("real-path aliases cannot bypass source or restore separation", async (t) => {
  const current = await fixture(t);
  const sourceAlias = path.join(current.root, "source-alias");
  await symlink(current.source, sourceAlias, process.platform === "win32" ? "junction" : "dir");
  const aliased = new BackupService({
    sourceDirectory: sourceAlias,
    backupDirectory: current.backups,
    quiescence: {
      async enter() {
        return structuredClone(current.checkpoint);
      },
      async leave() {},
    },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    aliased.createBackup(),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_SOURCE_INVALID",
  );

  const created = await current.service.createBackup();
  const parentAlias = path.join(current.root, "active-alias");
  await symlink(current.source, parentAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    current.service.restore({
      backupId: created.manifest.backupId,
      destinationDirectory: path.join(parentAlias, "restored"),
    }),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_DESTINATION_INVALID",
  );

  const externalBackups = path.join(current.root, "external-backups");
  const backupParentAlias = path.join(current.root, "backup-parent-alias");
  await mkdir(externalBackups);
  await symlink(
    externalBackups,
    backupParentAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const unsafeBackupDirectory = path.join(backupParentAlias, "must-not-be-created");
  const unsafeStorage = new BackupService({
    sourceDirectory: current.source,
    backupDirectory: unsafeBackupDirectory,
    quiescence: {
      async enter() {
        return structuredClone(current.checkpoint);
      },
      async leave() {},
    },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    unsafeStorage.createBackup(),
    (error) => error instanceof BackupServiceError && error.code === "BACKUP_STORAGE_INVALID",
  );
  await assert.rejects(lstat(path.join(externalBackups, "must-not-be-created")), {
    code: "ENOENT",
  });
});
