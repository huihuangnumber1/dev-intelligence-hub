import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangePackageError,
  createChangePackage,
  normalizeChangePackageManifest,
} from "../src/domain/change-package-contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function artifact(kind) {
  return {
    path: `session-1/test-action/${kind}.json`,
    sha256: SHA_D,
    bytes: 12,
  };
}

function draft(overrides = {}) {
  return {
    job: { id: "code-job-1", revision: 7, recordDigest: SHA_A },
    proposal: { id: "proposal-1", contentDigest: SHA_B },
    grant: { digest: SHA_C },
    workspace: {
      id: "workspace-1",
      sourceRevision: SHA_A,
      workspaceRevision: SHA_B,
    },
    passedProfiles: [
      {
        id: "node-tests",
        configDigest: SHA_C,
        workspaceRevision: SHA_B,
        actionId: "test-action",
        attemptNumber: 2,
        imageId: "sha256:node-test-image",
        artifacts: {
          output: artifact("output"),
          stdout: artifact("stdout"),
          stderr: artifact("stderr"),
        },
      },
    ],
    created: [
      { path: "src/z.js", content: Buffer.from("z\n") },
      { path: "src/new.js", content: Buffer.from("export default 1;\n") },
    ],
    modified: [
      {
        path: "src/app.js",
        beforeSha256: SHA_D,
        content: Buffer.from("export default 2;\n"),
      },
    ],
    deleted: [{ path: "src/old.js", beforeSha256: SHA_C }],
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => error instanceof ChangePackageError && error.code === code;
}

test("Windows package proof retains native process identity and rejects mixed identities", () => {
  const value = draft();
  const profile = value.passedProfiles[0];
  delete profile.imageId;
  Object.assign(profile, { runtimeIdentity: { schemaVersion: 1, kind: "windows-process", executionId: "session-1-attempt-2", actionId: profile.actionId,
    pid: 3456, processStartTimeUtcTicks: String(639013000000000000n), executableSha256: SHA_D }, assetVersion: 3, verificationKind: "test" });
  const { manifest } = createChangePackage(value);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(normalizeChangePackageManifest(manifest), manifest);
  assert.equal(Object.hasOwn(manifest.passedProfiles[0], "imageId"), false);
  assert.equal(manifest.passedProfiles[0].runtimeIdentity.pid, 3456);
  assert.throws(() => createChangePackage({ ...value, passedProfiles: [{ ...profile, imageId: "fake" }] }), hasCode("INVALID_CHANGE_PACKAGE"));
  assert.throws(() => createChangePackage({ ...value, passedProfiles: [{ ...profile, runtimeIdentity: { ...profile.runtimeIdentity, actionId: "other" } }] }), hasCode("INVALID_CHANGE_PACKAGE"));
});

test("a package is deterministic, content addressed, and fully bound", () => {
  const first = createChangePackage(draft());
  const repeated = createChangePackage({
    ...draft(),
    created: [...draft().created].reverse(),
  });

  assert.equal(first.manifest.packageId, `change-package-${first.manifest.packageDigest}`);
  assert.match(first.manifest.packageDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.manifest, repeated.manifest);
  assert.deepEqual(
    first.manifest.changes.created.map(({ path }) => path),
    ["src/new.js", "src/z.js"],
  );
  assert.deepEqual(
    first.manifest.changes.modified[0],
    {
      path: "src/app.js",
      beforeSha256: SHA_D,
      blob: {
        sha256: first.blobs.find(({ content }) =>
          content.equals(Buffer.from("export default 2;\n")),
        ).sha256,
        bytes: 18,
      },
    },
  );
  assert.deepEqual(normalizeChangePackageManifest(first.manifest), first.manifest);
  assert.equal(first.blobs.length, 3);
  assert.ok(Object.isFrozen(first.manifest));
});

test("manifest validation rejects tampering, extra fields, accessors, and cycles", () => {
  const { manifest } = createChangePackage(draft());
  assert.throws(
    () => normalizeChangePackageManifest({ ...manifest, packageDigest: SHA_D }),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
  assert.throws(
    () => normalizeChangePackageManifest({ ...manifest, extra: true }),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );

  const accessor = { ...draft().created[0] };
  Object.defineProperty(accessor, "path", { enumerable: true, get: () => "src/x.js" });
  assert.throws(
    () => createChangePackage(draft({ created: [accessor] })),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );

  const circular = [];
  circular.push(circular);
  assert.throws(
    () => createChangePackage(draft({ passedProfiles: circular })),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
});

test("paths, duplicate changes, evidence bindings, counts, and bytes fail closed", () => {
  for (const path of [
    "/src/app.js",
    "C:/src/app.js",
    "../app.js",
    "src/../app.js",
    "src\\app.js",
    "src/name:stream",
    "src/trailing.",
    "src/CON",
  ]) {
    assert.throws(
      () => createChangePackage(draft({ created: [{ path, content: Buffer.from("x") }] })),
      hasCode("INVALID_CHANGE_PACKAGE"),
    );
  }
  assert.throws(
    () =>
      createChangePackage(
        draft({ created: [{ path: "src/app.js", content: Buffer.from("x") }] }),
      ),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
  assert.throws(
    () =>
      createChangePackage(
        draft({
          passedProfiles: [
            { ...draft().passedProfiles[0], workspaceRevision: SHA_A },
          ],
        }),
      ),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
  assert.throws(
    () => createChangePackage(draft(), { limits: { maxFiles: 2 } }),
    hasCode("CHANGE_PACKAGE_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => createChangePackage(draft(), { limits: { maxBlobBytes: 8 } }),
    hasCode("CHANGE_PACKAGE_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => createChangePackage(draft(), { limits: { maxTotalBlobBytes: 24 } }),
    hasCode("CHANGE_PACKAGE_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => createChangePackage(draft(), { limits: { maxEvidenceBytes: 8 } }),
    hasCode("CHANGE_PACKAGE_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => createChangePackage(draft({
      job: { ...draft().job, revision: 0 },
    })),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
  assert.throws(
    () => createChangePackage(draft({
      created: [{ path: "src/App.js", content: Buffer.from("new") }],
      modified: [{
        path: "src/app.js",
        beforeSha256: SHA_A,
        content: Buffer.from("changed"),
      }],
      deleted: [],
    })),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
  assert.throws(
    () => createChangePackage(draft({
      created: [{ path: "src/e\u0301.js", content: Buffer.from("x") }],
      modified: [],
      deleted: [],
    })),
    hasCode("INVALID_CHANGE_PACKAGE"),
  );
});

test("empty files and exact serialized manifest limits are supported", () => {
  const input = draft({
    created: [{ path: "src/empty.js", content: Buffer.alloc(0) }],
    modified: [],
    deleted: [],
  });
  const empty = createChangePackage(input);
  assert.deepEqual(empty.manifest.changes.created[0].blob, {
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    bytes: 0,
  });

  const serializedBytes = Buffer.byteLength(
    `${JSON.stringify(empty.manifest)}\n`,
    "utf8",
  );
  assert.doesNotThrow(() => createChangePackage(input, {
    limits: { maxManifestBytes: serializedBytes },
  }));
  assert.throws(
    () => createChangePackage(input, {
      limits: { maxManifestBytes: serializedBytes - 1 },
    }),
    hasCode("CHANGE_PACKAGE_LIMIT_EXCEEDED"),
  );
});
