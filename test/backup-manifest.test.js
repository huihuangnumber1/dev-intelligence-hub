import assert from "node:assert/strict";
import test from "node:test";

import {
  BackupManifestError,
  createBackupManifest,
  normalizeBackupManifest,
} from "../src/domain/backup-manifest.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const CREATED_AT = "2026-08-07T08:00:00.000Z";

function input() {
  return {
    createdAt: CREATED_AT,
    stores: [
      { name: "work-ledger", revision: 19, digest: B },
      { name: "attention-inbox", revision: 7, digest: A },
    ],
    files: [
      {
        path: "artifacts/packages/package-a/manifest.json",
        kind: "immutable",
        bytes: 13,
        sha256: B,
      },
      {
        path: "state/work-ledger.json",
        kind: "mutable",
        bytes: 42,
        sha256: A,
      },
    ],
  };
}

test("backup manifests are content-addressed, ordered, frozen, and round-trip", () => {
  const first = createBackupManifest(input());
  const reversed = input();
  reversed.stores.reverse();
  reversed.files.reverse();
  const second = createBackupManifest(reversed);

  assert.deepEqual(second, first);
  assert.match(first.checkpoint.checkpointId, /^backup-checkpoint-[a-f0-9]{64}$/);
  assert.match(first.backupId, /^backup-[a-f0-9]{64}$/);
  assert.deepEqual(first.totals, { fileCount: 2, totalBytes: 55 });
  assert.deepEqual(
    first.checkpoint.stores.map(({ name }) => name),
    ["attention-inbox", "work-ledger"],
  );
  assert.deepEqual(
    first.files.map(({ path }) => path),
    ["artifacts/packages/package-a/manifest.json", "state/work-ledger.json"],
  );
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.files));
  assert.ok(Object.isFrozen(first.files[0]));
  assert.deepEqual(normalizeBackupManifest(structuredClone(first)), first);
});

test("backup identity is stable across retry timestamps for the same checkpoint", () => {
  const first = createBackupManifest(input());
  const retried = input();
  retried.createdAt = "2026-08-07T08:05:00.000Z";

  const second = createBackupManifest(retried);

  assert.equal(second.backupId, first.backupId);
  assert.notEqual(second.contentDigest, first.contentDigest);
});

test("declared executor source and generated library paths round-trip", () => {
  const value = input();
  const paths = [
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/.clang-tidy",
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/Scripts/Test/.gitattributes",
    "code-executor/workspaces/oct-software/attempt-30c09b252b4f648c638239b9/.github/workflows/check.yml",
    `code-executor/workspaces/.test-library/${A}/test.mjs`,
    `code-executor/windows-tests/${A}/data/workspace/.gitignore`,
    `code-executor/windows-tests/${A}/data/workspace/Packages/test/AC/Temp/.cache/result.bin`,
    `code-executor/windows-tests/${A}/data/resources/test-assets/.config/settings.json`,
  ];
  value.files = paths.map((path) => ({ path, kind: "mutable", bytes: 1, sha256: A }));

  const manifest = createBackupManifest(value);

  assert.deepEqual(manifest.files.map(({ path }) => path), [...paths].sort());
  assert.deepEqual(normalizeBackupManifest(structuredClone(manifest)), manifest);
});

test("manifest store capacity follows the bounded durable file inventory", () => {
  const value = input();
  value.stores = Array.from({ length: 300 }, (_, index) => ({
    name: `original-repair-feedback-record-${index.toString(16).padStart(64, "0")}`,
    revision: 0,
    digest: A,
  }));
  value.files = value.stores.map(({ name }) => ({
    path: `${name}.json`, kind: "mutable", bytes: 1, sha256: A,
  }));

  const manifest = createBackupManifest(value);

  assert.equal(manifest.checkpoint.stores.length, 300);
  assert.equal(manifest.totals.fileCount, 300);
  assert.deepEqual(normalizeBackupManifest(structuredClone(manifest)), manifest);
  value.stores = Array(100_001).fill(value.stores[0]);
  assert.throws(() => createBackupManifest(value), BackupManifestError);
  value.stores = Array(100_000).fill({ name: "a".repeat(126), revision: 0, digest: A });
  assert.throws(() => createBackupManifest(value), {
    code: "INVALID_BACKUP_MANIFEST", message: "备份清单超出容量限制",
  });
  value.stores = input().stores;
  value.files = Array(100_001).fill(value.files[0]);
  assert.throws(() => createBackupManifest(value), BackupManifestError);
});

test("manifest validation rejects tampering and non-canonical derived fields", () => {
  const manifest = structuredClone(createBackupManifest(input()));
  const cases = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.files[0].bytes += 1; },
    (value) => { value.files.reverse(); },
    (value) => { value.checkpoint.stores.reverse(); },
    (value) => { value.totals.totalBytes += 1; },
    (value) => { value.contentDigest = "c".repeat(64); },
    (value) => { value.backupId = `backup-${"d".repeat(64)}`; },
    (value) => { value.extra = true; },
  ];

  for (const mutate of cases) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(
      () => normalizeBackupManifest(candidate),
      (error) => error instanceof BackupManifestError && error.code === "INVALID_BACKUP_MANIFEST",
    );
  }
});

test("manifest creation rejects unsafe paths, collisions, and invalid checkpoint facts", () => {
  const unsafePaths = [
    "../secret.txt",
    "/absolute.json",
    "C:/private.json",
    "state\\private.json",
    "state//double.json",
    "state/./dot.json",
    "state/.hidden.json",
    "state/trailing. ",
    "state/NUL",
    "state/file:stream",
    "state/question?.json",
    "state/pipe|name.json",
    "state/quoted\"name.json",
    "state/star*.json",
    "state/less<name.json",
    "state/greater>name.json",
    ".unknown.json",
    "code-executor/.unknown/config.json",
    "code-executor/artifacts/.gitignore",
    "code-executor/workspaces/.unknown/test.mjs",
    "code-executor/workspaces/oct-software/.unknown/.gitignore",
    "code-executor/workspaces/oct-software/attempt-1/../.gitignore",
    "code-executor/workspaces/oct-software/attempt-1/./.gitignore",
    "code-executor/workspaces/oct-software/attempt-1/.gitignore:stream",
    "code-executor/workspaces/oct-software/attempt-1/.cache/NUL.txt",
    "code-executor/workspaces/oct-software/attempt-1/.cache/COM1",
    "code-executor/workspaces/oct-software/attempt-1/.cache/control\u0001.txt",
    `code-executor/workspaces/.test-library/${A}/unknown.mjs`,
    "code-executor/workspaces/.test-library/not-a-fingerprint/test.mjs",
    `code-executor/windows-tests/${A}/.unknown/file`,
    `code-executor/windows-tests/${A}/data/control/.unknown`,
    `code-executor/windows-tests/${A}/data/resources/.unknown/file`,
    "code-executor/windows-tests/not-a-fingerprint/data/workspace/.gitignore",
  ];
  for (const path of unsafePaths) {
    const value = input();
    value.files[0].path = path;
    assert.throws(() => createBackupManifest(value), BackupManifestError);
  }

  const collision = input();
  collision.files[1].path = collision.files[0].path.toUpperCase();
  assert.throws(() => createBackupManifest(collision), BackupManifestError);

  const duplicateStore = input();
  duplicateStore.stores[1].name = "WORK-LEDGER";
  assert.throws(() => createBackupManifest(duplicateStore), BackupManifestError);

  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = input();
    value.stores[0].revision = revision;
    assert.throws(() => createBackupManifest(value), BackupManifestError);
  }
});

test("manifest input is bounded before hashing", () => {
  const tooLarge = input();
  tooLarge.files[0].bytes = 4 * 1024 * 1024 * 1024 + 1;
  assert.throws(() => createBackupManifest(tooLarge), BackupManifestError);

  const accessor = input();
  Object.defineProperty(accessor.files[0], "bytes", {
    enumerable: true,
    get() {
      throw new Error("must not invoke accessors");
    },
  });
  assert.throws(
    () => createBackupManifest(accessor),
    (error) => error instanceof BackupManifestError,
  );

  const oversizedManifest = input();
  oversizedManifest.files = Array.from({ length: 8_000 }, (_, index) => ({
    path: `state/${String(index).padStart(4, "0")}-${"界".repeat(700)}`,
    kind: "mutable",
    bytes: 0,
    sha256: A,
  }));
  assert.throws(
    () => createBackupManifest(oversizedManifest),
    (error) => error instanceof BackupManifestError,
  );
});

test("manifest validation rejects proxies without executing traps", () => {
  let traps = 0;
  const proxiedFile = new Proxy(input().files[0], {
    getPrototypeOf() {
      traps += 1;
      throw new Error("must not execute proxy traps");
    },
  });
  const value = input();
  value.files[0] = proxiedFile;

  assert.throws(
    () => createBackupManifest(value),
    (error) => error instanceof BackupManifestError,
  );
  assert.equal(traps, 0);
});
