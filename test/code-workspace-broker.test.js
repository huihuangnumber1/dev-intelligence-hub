import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { withPreparationCancellation, preparationSignal } from "../src/lib/preparation-cancellation.js";

async function fixture(t, {
  files = { "src/app.js": "export const value = 1;\n" },
  writablePaths = ["src", "test", "docs", "README.md"],
  limits = {},
  excludePaths = [],
  gitSnapshotter = null,
  conflictMaterializer = null,
  gitBoundaryDigest = null,
  gitExecutableIdentity = undefined,
  removeDirectory = undefined,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "code-workspace-broker-"));
  const sourceRoot = path.join(root, "source");
  const scratchRoot = path.join(root, "scratch");
  await mkdir(sourceRoot);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(sourceRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  const sealedGitExecutableIdentity = gitExecutableIdentity === undefined
    ? gitBoundaryDigest === null
      ? null
      : {
          gitCommand: path.join(root, "git.exe"),
          gitExecutableSha256: "e".repeat(64),
          gitExecutableBytes: 1,
          gitExecutableMode: 0o755,
          gitExecutableUid: 0,
          gitExecutableGid: 0,
        }
    : gitExecutableIdentity;
  return {
    root,
    sourceRoot,
    scratchRoot,
    broker: new CodeWorkspaceBroker({
      scratchRoot,
      limits,
      gitSnapshotter,
      conflictMaterializer,
      ...(removeDirectory === undefined ? {} : { removeDirectory }),
      workspaces: [{
        id: "dashboard",
        sourceRoot,
        writablePaths,
        excludePaths,
        gitBoundaryDigest,
        gitExecutableIdentity: sealedGitExecutableIdentity,
      }],
    }),
  };
}

function pullRequestBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/dashboard#42",
    workKey: "pr:acme/dashboard#42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: "1".repeat(40),
    eventId: "github-event-pr-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    ...overrides,
  };
}

function conflictExecutionSource() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/dashboard",
    baseRefName: "main",
    baseRefOid: "4".repeat(40),
    headRepository: "contributor/dashboard",
    headRefName: "fix/conflict",
    headRefOid: "1".repeat(40),
  };
  const inputBinding = pullRequestBinding({ schemaVersion: 2, gitTarget });
  return createConflictCodeExecutionSource({
    inputBinding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "5".repeat(64),
        status: "conflicted",
        baseCommitOid: gitTarget.baseRefOid,
        headCommitOid: gitTarget.headRefOid,
        mergeBaseOid: "6".repeat(40),
        resultTreeOid: "7".repeat(40),
        conflicts: [{ path: "src/value.js", mode: "100644" }],
        boundaryDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        resultObjectDigest: "a".repeat(64),
        materialization: "full-tree",
      },
      gitTarget,
    }),
  });
}

function fixedConflictMaterializer(files, { receiptOverrides = {} } = {}) {
  const calls = [];
  return {
    calls,
    async materialize(request) {
      calls.push(structuredClone(request));
      let totalBytes = 0;
      const receiptFiles = [];
      for (const [relativePath, content] of Object.entries(files).sort()) {
        if (
          request.excludePaths.some(
            (excluded) =>
              relativePath === excluded ||
              relativePath.startsWith(`${excluded}/`),
          )
        ) {
          continue;
        }
        const value = Buffer.from(content);
        const target = path.join(request.targetRoot, ...relativePath.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, value, { mode: 0o644 });
        totalBytes += value.length;
        receiptFiles.push({
          path: relativePath,
          sha256: digest(value),
          mode: "100644",
          bytes: value.length,
        });
      }
      return {
        schemaVersion: 2,
        preparationId: request.binding.preparationId,
        binding: structuredClone(request.binding),
        targetRoot: request.targetRoot,
        materialization: "full-tree",
        excludePaths: [...request.excludePaths],
        files: receiptFiles,
        fileCount: receiptFiles.length,
        totalBytes,
        resultTreeOid: request.binding.resultTreeOid,
        evidenceDigest: request.binding.evidenceDigest,
        resultObjectDigest: request.binding.resultObjectDigest,
        residual: null,
        ...receiptOverrides,
      };
    },
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixedSnapshotter(files, { headOid = "1".repeat(40), failure = null } = {}) {
  const calls = [];
  return {
    calls,
    async materialize(request) {
      calls.push(structuredClone(request));
      const entries = Object.entries(files).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const baseline = new Map();
      const modes = new Map();
      let totalBytes = 0;
      for (const [relativePath, content] of entries) {
        const value = Buffer.from(content);
        const target = path.join(
          request.targetRoot,
          ...relativePath.split("/"),
        );
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, value);
        baseline.set(relativePath, digest(value));
        modes.set(relativePath, "100644");
        totalBytes += value.length;
        if (failure) throw Object.assign(new Error("snapshot failed"), failure);
      }
      return {
        headOid,
        baseline,
        modes,
        fileCount: baseline.size,
        totalBytes,
      };
    },
  };
}

test("unknown workspaces are rejected with a stable error code", async () => {
  const broker = new CodeWorkspaceBroker({ workspaces: [] });

  await assert.rejects(
    broker.createExecution({ workspaceId: "missing" }),
    (error) => error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("workspace storage cannot overlap a trusted source in either direction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "code-workspace-overlap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);

  assert.throws(
    () => new CodeWorkspaceBroker({
      scratchRoot: path.join(sourceRoot, "scratch"),
      workspaces: [{ id: "dashboard", sourceRoot }],
    }),
    { code: "INVALID_WORKSPACE_CONFIG" },
  );

  const scratchRoot = path.join(root, "scratch");
  const nestedSource = path.join(scratchRoot, "source");
  await mkdir(nestedSource, { recursive: true });
  assert.throws(
    () => new CodeWorkspaceBroker({
      scratchRoot,
      workspaces: [{ id: "nested", sourceRoot: nestedSource }],
    }),
    { code: "INVALID_WORKSPACE_CONFIG" },
  );
});

test("a Git boundary digest cannot be registered without its sealed executable identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "code-workspace-git-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot);
  const gitSnapshotter = fixedSnapshotter({});

  assert.throws(
    () => new CodeWorkspaceBroker({
      scratchRoot: path.join(root, "scratch"),
      gitSnapshotter,
      workspaces: [{
        id: "dashboard",
        sourceRoot,
        gitBoundaryDigest: "a".repeat(64),
      }],
    }),
    { code: "INVALID_WORKSPACE_CONFIG" },
  );
});

test("a sanitized copy supports bounded edits and reports changes without touching source", async (t) => {
  const original = "export const value = 1;\n";
  const { broker, sourceRoot } = await fixture(t, {
    files: {
      "src/app.js": original,
      "test/app.test.js": "test('old', () => {});\n",
      "README.md": "# Dashboard\n",
      ".git/config": "secret",
      "data/state.json": "{}",
      ".env": "TOKEN=secret",
      "src/certificate.pem": "secret",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "run-one",
  });

  assert.equal(execution.workspaceId, "dashboard");
  assert.equal(execution.executionId, "run-one");
  assert.equal(execution.inputBinding, null);
  assert.match(execution.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(execution.workspaceRevision, execution.sourceRevision);
  assert.equal(
    await broker.getSandboxWorkspacePath(execution),
    await realpath(path.join(broker.scratchRoot, "dashboard", "run-one")),
  );
  assert.deepEqual(await broker.listFiles(execution), [
    "README.md",
    "src/app.js",
    "test/app.test.js",
  ]);
  const app = await broker.readFile({ ...execution, path: "src\\app.js" });
  const written = await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: app.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  assert.equal(written.beforeWorkspaceRevision, execution.workspaceRevision);
  assert.notEqual(written.workspaceRevision, execution.workspaceRevision);
  await broker.writeFile({
    ...execution,
    path: "docs/notes.md",
    content: "value = 2\n",
    expectedSha256: null,
  });
  const oldTest = await broker.readFile({ ...execution, path: "test/app.test.js" });
  await broker.deleteFile({
    ...execution,
    path: "test/app.test.js",
    expectedSha256: oldTest.sha256,
  });

  const search = await broker.searchText({ ...execution, query: "value = 2" });
  const manifest = await broker.getChangeManifest(execution);
  assert.deepEqual(search.matches.map((match) => match.path), [
    "docs/notes.md",
    "src/app.js",
  ]);
  assert.deepEqual(manifest.created.map((entry) => entry.path), ["docs/notes.md"]);
  assert.deepEqual(manifest.modified.map((entry) => entry.path), ["src/app.js"]);
  assert.deepEqual(manifest.deleted.map((entry) => entry.path), ["test/app.test.js"]);
  assert.equal(await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"), original);
  assert.equal(await readFile(path.join(sourceRoot, "test", "app.test.js"), "utf8"), "test('old', () => {});\n");
  await assert.rejects(access(path.join(sourceRoot, "docs", "notes.md")));
});

test("UTF-8 BOM reads preserve content bytes and hash through an unchanged write", async (t) => {
  const original = Buffer.from("\ufeff// 采集上下文\r\nexport const value = 1;\r\n", "utf8");
  const { broker, sourceRoot } = await fixture(t, {
    files: { "src/app.js": original },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "bom-run",
  });
  const current = await broker.readFile({ ...execution, path: "src/app.js" });

  assert.equal(current.content, original.toString("utf8"));
  assert.equal(Buffer.byteLength(current.content, "utf8"), current.bytes);
  assert.equal(current.bytes, original.length);
  assert.equal(current.sha256, createHash("sha256").update(original).digest("hex"));

  const written = await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: current.content,
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  assert.equal(written.workspaceRevision, execution.workspaceRevision);
  assert.deepEqual(
    await readFile(path.join(await broker.getSandboxWorkspacePath(execution), "src", "app.js")),
    original,
  );
  assert.deepEqual(await readFile(path.join(sourceRoot, "src", "app.js")), original);
  const manifest = await broker.getChangeManifest(execution);
  assert.deepEqual(manifest.modified, []);
});

test("text reads still reject malformed UTF-8 and NUL bytes after a BOM", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/invalid.cpp": Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]),
      "src/binary.cpp": Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x00, 0x62]),
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "invalid-text-run",
  });
  for (const file of ["src/invalid.cpp", "src/binary.cpp"]) {
    await assert.rejects(
      broker.readFile({ ...execution, path: file }),
      (error) => error.code === "TEXT_REQUIRED",
    );
  }
});

test("a PR-bound execution materializes only its sealed Git Head and echoes a detached binding", async (t) => {
  const boundaryDigest = "f".repeat(64);
  const snapshotter = fixedSnapshotter({
    "README.md": "fixed Head\n",
    "src/app.js": "export const value = 'fixed-head';\n",
  });
  const { broker, sourceRoot } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 'dirty-checkout';\n",
      "untracked.txt": "must not be copied\n",
    },
    excludePaths: ["private"],
    gitSnapshotter: snapshotter,
    gitBoundaryDigest: boundaryDigest,
  });
  const inputBinding = pullRequestBinding();

  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "git-head-run",
    inputBinding,
  });

  assert.deepEqual(execution.inputBinding, inputBinding);
  assert.notStrictEqual(execution.inputBinding, inputBinding);
  inputBinding.repository = "acme/changed";
  assert.equal(execution.inputBinding.repository, "acme/dashboard");
  assert.equal(
    (await broker.readFile({ ...execution, path: "src/app.js" })).content,
    "export const value = 'fixed-head';\n",
  );
  assert.deepEqual(await broker.listFiles(execution), [
    "README.md",
    "src/app.js",
  ]);
  await assert.rejects(
    broker.readFile({ ...execution, path: "untracked.txt" }),
    (error) => error.code === "FILE_NOT_FOUND",
  );
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 'dirty-checkout';\n",
  );
  assert.deepEqual(snapshotter.calls, [
    {
      sourceRoot: path.resolve(sourceRoot),
      targetRoot: await broker.getSandboxWorkspacePath(execution),
      headOid: "1".repeat(40),
      excludePaths: ["private"],
      expectedBoundaryDigest: boundaryDigest,
      expectedGitCommand: path.join(path.dirname(sourceRoot), "git.exe"),
      expectedGitExecutableSha256: "e".repeat(64),
      expectedGitExecutableBytes: 1,
      expectedGitExecutableMode: 0o755,
      expectedGitExecutableUid: 0,
      expectedGitExecutableGid: 0,
    },
  ]);
});

test("review repair snapshots the Head and permits configured descendants without conflict materialization", async (t) => {
  const snapshotter = fixedSnapshotter({ "src/app.js": "original Head\n" });
  let conflictCalls = 0;
  const { broker, sourceRoot } = await fixture(t, { gitSnapshotter: snapshotter,
    gitBoundaryDigest: "f".repeat(64), writablePaths: ["src", "test"],
    conflictMaterializer: { materialize() { conflictCalls += 1; throw new Error("wrong port"); } },
  });
  const inputBinding = conflictExecutionSource().inputBinding;
  const executionSource = createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: ["src", "test"] });
  const execution = await broker.createExecution({ workspaceId: "dashboard", executionId: "review-repair", inputBinding, executionSource });
  assert.equal(snapshotter.calls.length, 1);
  assert.equal(conflictCalls, 0);
  const current = await broker.readFile({ ...execution, path: "src/app.js" });
  await broker.writeFile({ ...execution, path: "src/app.js", content: "fixed Head\n", expectedSha256: current.sha256 });
  await broker.writeFile({ ...execution, path: "test/review.test.js", content: "regression\n", expectedSha256: null });
  assert.equal(await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"), "export const value = 1;\n");
  await assert.rejects(broker.createExecution({ workspaceId: "dashboard", executionId: "wrong-scope", inputBinding,
    executionSource: createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: ["src"] }) }),
    (error) => error.code === "INVALID_EXECUTION_REQUEST");
});

test("a conflict execution uses only its bound materializer and exact-file write scope", async (t) => {
  const executionSource = conflictExecutionSource();
  const materializer = fixedConflictMaterializer({
    "README.md": "# prepared\n",
    "src/other.js": "export const other = 1;\n",
    "src/value.js": "<<<<<<< base\nold\n=======\nnew\n>>>>>>> head\n",
  });
  const snapshotter = fixedSnapshotter({ "src/wrong.js": "wrong\n" });
  const { broker, scratchRoot } = await fixture(t, {
    files: { "src/source-only.js": "must not be copied\n" },
    writablePaths: ["src"],
    conflictMaterializer: materializer,
    gitSnapshotter: snapshotter,
  });

  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "conflict-run",
    inputBinding: executionSource.inputBinding,
    executionSource,
  });

  assert.deepEqual(execution.executionSource, executionSource);
  assert.deepEqual(materializer.calls, [{
    binding: executionSource.preparationBinding,
    targetRoot: path.join(scratchRoot, "dashboard", "conflict-run"),
    excludePaths: [],
  }]);
  assert.equal(snapshotter.calls.length, 0);
  assert.deepEqual(await broker.listFiles(execution), [
    "README.md",
    "src/other.js",
    "src/value.js",
  ]);

  const current = await broker.readFile({ ...execution, path: "src/value.js" });
  const written = await broker.writeFile({
    ...execution,
    path: "src/value.js",
    content: "export const value = 'resolved';\n",
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  for (const candidate of [
    "src/other.js",
    "src/value.js/child.js",
    "src/Value.js",
  ]) {
    await assert.rejects(
      broker.writeFile({
        ...execution,
        path: candidate,
        content: "forbidden\n",
        expectedSha256: null,
        expectedWorkspaceRevision: written.workspaceRevision,
      }),
      (error) => error.code === "WRITE_NOT_ALLOWED",
    );
  }
  assert.equal(
    await readFile(
      path.join(scratchRoot, "dashboard", "conflict-run", "src", "value.js"),
      "utf8",
    ),
    "export const value = 'resolved';\n",
  );

  await assert.rejects(
    broker.createExecution({
      workspaceId: "dashboard",
      executionId: "unknown-field-run",
      inputBinding: executionSource.inputBinding,
      executionSource,
      preparationId: executionSource.preparationBinding.preparationId,
    }),
    (error) => error.code === "INVALID_EXECUTION_REQUEST",
  );
  assert.equal(materializer.calls.length, 1);
});

test("cancelled Git and sealed conflict preparation cleans the actual owned tree before rejecting", async t => {
  for (const kind of ["head", "conflict", "uncertain-cleanup"]) await t.test(kind, async t => {
    const controller = new AbortController(), source = conflictExecutionSource();
    const materializer = kind === "head" ? fixedSnapshotter({ "src/app.js": "prepared\n" }) :
      fixedConflictMaterializer({ "src/value.js": "prepared\n" });
    const materialize = materializer.materialize.bind(materializer);
    materializer.materialize = async request => { const receipt = await materialize(request); controller.abort(); return receipt; };
    let cleanup = false;
    const { broker, scratchRoot, sourceRoot } = await fixture(t, { files: { "src/original.js": "untouched\n" },
      writablePaths: ["src"], ...(kind === "head" ? { gitSnapshotter: materializer, gitBoundaryDigest: "f".repeat(64) } : { conflictMaterializer: materializer }),
      removeDirectory: async (...args) => {
        cleanup = true;
        assert.equal(preparationSignal(), null, "abort cannot cancel owned cleanup");
        if (kind === "uncertain-cleanup") throw new Error("locked scratch file");
        return rm(...args);
      } });
    await assert.rejects(withPreparationCancellation(controller.signal, () => broker.createExecution({ workspaceId: "dashboard", executionId: "aborted",
      inputBinding: source.inputBinding, ...(kind === "head" ? {} : { executionSource: source }) })),
      { code: kind === "uncertain-cleanup" ? "EXECUTION_STORAGE_UNAVAILABLE" : "CODE_PREPARATION_ABORTED" });
    assert.equal(cleanup, true);
    assert.equal(broker.executions.size, 0);
    if (kind !== "uncertain-cleanup") await assert.rejects(access(path.join(scratchRoot, "dashboard", "aborted")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(sourceRoot, "src", "original.js"), "utf8"), "untouched\n");
  });
});

test("conflict receipt evidence rejects same-size content replacement", async (t) => {
  const executionSource = conflictExecutionSource();
  const trusted = fixedConflictMaterializer({
    "src/value.js": "trusted\n",
  });
  const materializer = {
    async materialize(request) {
      const receipt = await trusted.materialize(request);
      await writeFile(
        path.join(request.targetRoot, "src", "value.js"),
        "forged!\n",
      );
      return receipt;
    },
  };
  const { broker, scratchRoot } = await fixture(t, {
    writablePaths: ["src"],
    conflictMaterializer: materializer,
  });

  await assert.rejects(
    broker.createExecution({
      workspaceId: "dashboard",
      executionId: "tampered-conflict-run",
      inputBinding: executionSource.inputBinding,
      executionSource,
    }),
    (error) => error.code === "CONFLICT_PREPARATION_RESULT_INVALID",
  );
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "tampered-conflict-run")),
    (error) => error?.code === "ENOENT",
  );
});

test("conflict materialization excludes workspace-private paths before writing", async (t) => {
  const executionSource = conflictExecutionSource();
  const materializer = fixedConflictMaterializer({
    "private/secret.txt": "never materialize\n",
    "src/value.js": "conflict\n",
  });
  const { broker, scratchRoot } = await fixture(t, {
    writablePaths: ["src"],
    excludePaths: ["private"],
    conflictMaterializer: materializer,
  });

  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "excluded-conflict-run",
    inputBinding: executionSource.inputBinding,
    executionSource,
  });

  assert.deepEqual(materializer.calls[0].excludePaths, ["private"]);
  assert.deepEqual(await broker.listFiles(execution), ["src/value.js"]);
  await assert.rejects(
    access(
      path.join(
        scratchRoot,
        "dashboard",
        "excluded-conflict-run",
        "private",
        "secret.txt",
      ),
    ),
    (error) => error?.code === "ENOENT",
  );
});

test("invalid conflict materialization receipts are cleaned before registration", async (t) => {
  const executionSource = conflictExecutionSource();
  const materializer = fixedConflictMaterializer(
    { "src/value.js": "conflict\n" },
    { receiptOverrides: { resultObjectDigest: "b".repeat(64) } },
  );
  const { broker, scratchRoot } = await fixture(t, {
    writablePaths: ["src"],
    conflictMaterializer: materializer,
  });

  await assert.rejects(
    broker.createExecution({
      workspaceId: "dashboard",
      executionId: "bad-conflict-run",
      inputBinding: executionSource.inputBinding,
      executionSource,
    }),
    (error) => error.code === "CONFLICT_PREPARATION_RESULT_INVALID",
  );
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "bad-conflict-run")),
  );
});

test("PR bindings fail before source copy when Git Head snapshot is unavailable", async (t) => {
  const { broker, scratchRoot } = await fixture(t, {
    files: { "src/app.js": "directory fallback must not run\n" },
  });

  await assert.rejects(
    broker.createExecution({
      workspaceId: "dashboard",
      executionId: "git-unavailable-run",
      inputBinding: pullRequestBinding(),
    }),
    (error) => error.code === "GIT_HEAD_SNAPSHOT_UNAVAILABLE",
  );
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "git-unavailable-run")),
    (error) => error.code === "ENOENT",
  );
});

test("Git snapshot errors and invalid receipts clean partial output without directory fallback", async (t) => {
  const boundaryDigest = "e".repeat(64);
  const scenarios = [
    {
      name: "materialization-failure",
      snapshotter: fixedSnapshotter(
        { "partial.txt": "partial\n" },
        { failure: { code: "GIT_SNAPSHOT_OBJECT_MISMATCH" } },
      ),
      code: "GIT_SNAPSHOT_OBJECT_MISMATCH",
    },
    {
      name: "Head-mismatch",
      snapshotter: fixedSnapshotter(
        { "src/app.js": "wrong Head\n" },
        { headOid: "4".repeat(40) },
      ),
      code: "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
    },
  ];

  for (const scenario of scenarios) {
    const current = await fixture(t, {
      files: { "src/app.js": "directory fallback must not run\n" },
      gitSnapshotter: scenario.snapshotter,
      gitBoundaryDigest: boundaryDigest,
    });
    await assert.rejects(
      current.broker.createExecution({
        workspaceId: "dashboard",
        executionId: `${scenario.name}-run`.toLowerCase(),
        inputBinding: pullRequestBinding(),
      }),
      (error) => error.code === scenario.code,
    );
    await assert.rejects(
      access(
        path.join(
          current.scratchRoot,
          "dashboard",
          `${scenario.name}-run`.toLowerCase(),
        ),
      ),
      (error) => error.code === "ENOENT",
    );
  }
});

test("broker rejects malformed PR bindings and Git snapshot receipts without invoking accessors", async (t) => {
  const snapshotter = fixedSnapshotter({ "src/app.js": "fixed\n" });
  const { broker } = await fixture(t, {
    gitSnapshotter: snapshotter,
    gitBoundaryDigest: "d".repeat(64),
  });
  let getterCalls = 0;
  const accessor = pullRequestBinding();
  Object.defineProperty(accessor, "headRefOid", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "1".repeat(40);
    },
  });

  for (const inputBinding of [
    accessor,
    pullRequestBinding({ headRefOid: "A".repeat(40) }),
    { ...pullRequestBinding(), extra: true },
  ]) {
    await assert.rejects(
      broker.createExecution({
        workspaceId: "dashboard",
        executionId: `invalid-binding-${snapshotter.calls.length}`,
        inputBinding,
      }),
      (error) => error.code === "INVALID_EXECUTION_INPUT_BINDING",
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(snapshotter.calls.length, 0);

  const badReceiptSnapshotter = {
    async materialize(request) {
      await writeFile(path.join(request.targetRoot, "file.txt"), "content");
      return {
        headOid: request.headOid,
        baseline: new Map([["file.txt", "0".repeat(64)]]),
        modes: new Map([["file.txt", "100644"]]),
        fileCount: 2,
        totalBytes: 7,
      };
    },
  };
  const invalidReceipt = await fixture(t, {
    gitSnapshotter: badReceiptSnapshotter,
    gitBoundaryDigest: "c".repeat(64),
  });
  await assert.rejects(
    invalidReceipt.broker.createExecution({
      workspaceId: "dashboard",
      executionId: "invalid-receipt-run",
      inputBinding: pullRequestBinding(),
    }),
    (error) => error.code === "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
  );
});

test("broker independently audits every Git snapshot file against its receipt", async (t) => {
  const sealed = Buffer.from("sealed Head\n");
  const dirty = Buffer.from("different bytes\n");
  const cases = [
    {
      name: "extra-file",
      files: [["src/extra.js", sealed]],
      baseline: new Map(),
      fileCount: 0,
      totalBytes: 0,
    },
    {
      name: "wrong-content",
      files: [["src/app.js", dirty]],
      baseline: new Map([["src/app.js", digest(sealed)]]),
      fileCount: 1,
      totalBytes: dirty.length,
    },
    {
      name: "wrong-total",
      files: [["src/app.js", sealed]],
      baseline: new Map([["src/app.js", digest(sealed)]]),
      fileCount: 1,
      totalBytes: sealed.length + 1,
    },
    {
      name: "excluded-extra",
      files: [["private/secret.txt", sealed]],
      baseline: new Map(),
      fileCount: 0,
      totalBytes: 0,
      excludePaths: ["private"],
    },
    {
      name: "extra-empty-directory",
      files: [],
      directories: ["empty/generated"],
      baseline: new Map(),
      fileCount: 0,
      totalBytes: 0,
    },
  ];

  for (const current of cases) {
    const snapshotter = {
      async materialize(request) {
        for (const relativePath of current.directories ?? []) {
          await mkdir(
            path.join(request.targetRoot, ...relativePath.split("/")),
            { recursive: true },
          );
        }
        for (const [relativePath, value] of current.files) {
          const target = path.join(
            request.targetRoot,
            ...relativePath.split("/"),
          );
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, value);
        }
        return {
          headOid: request.headOid,
          baseline: new Map(current.baseline),
          modes: new Map(
            [...current.baseline.keys()].map((relativePath) => [
              relativePath,
              "100644",
            ]),
          ),
          fileCount: current.fileCount,
          totalBytes: current.totalBytes,
        };
      },
    };
    const setup = await fixture(t, {
      gitSnapshotter: snapshotter,
      gitBoundaryDigest: "9".repeat(64),
      excludePaths: current.excludePaths ?? [],
    });
    const executionId = `audit-${current.name}`;

    await assert.rejects(
      setup.broker.createExecution({
        workspaceId: "dashboard",
        executionId,
        inputBinding: pullRequestBinding(),
      }),
      { code: "GIT_HEAD_SNAPSHOT_RESULT_INVALID" },
    );
    await assert.rejects(
      access(path.join(setup.scratchRoot, "dashboard", executionId)),
      { code: "ENOENT" },
    );
  }
});

test(
  "broker rejects a Git executable-mode receipt that differs from the POSIX materialization",
  { skip: process.platform === "win32" ? "NTFS does not represent Git executable bits" : false },
  async (t) => {
    const content = Buffer.from("#!/bin/sh\nexit 0\n");
    const snapshotter = {
      async materialize(request) {
        const target = path.join(request.targetRoot, "script.sh");
        await writeFile(target, content);
        await chmod(target, 0o644);
        return {
          headOid: request.headOid,
          baseline: new Map([["script.sh", digest(content)]]),
          modes: new Map([["script.sh", "100755"]]),
          fileCount: 1,
          totalBytes: content.length,
        };
      },
    };
    const setup = await fixture(t, {
      gitSnapshotter: snapshotter,
      gitBoundaryDigest: "8".repeat(64),
    });

    await assert.rejects(
      setup.broker.createExecution({
        workspaceId: "dashboard",
        executionId: "mode-mismatch",
        inputBinding: pullRequestBinding(),
      }),
      { code: "GIT_HEAD_SNAPSHOT_RESULT_INVALID" },
    );
  },
);

test(
  "a failed cleanup is explicit and the orphan remains safely discardable",
  async (t) => {
    let cleanupLocked = true;
    const removeDirectory = async (target, options) => {
      if (cleanupLocked) {
        throw Object.assign(new Error("directory is locked"), {
          code: "EBUSY",
        });
      }
      return rm(target, options);
    };
    const snapshotter = {
      async materialize(request) {
        await writeFile(path.join(request.targetRoot, "partial.txt"), "partial");
        throw Object.assign(new Error("materialization failed"), {
          code: "GIT_SNAPSHOT_FAILED",
        });
      },
    };
    const setup = await fixture(t, {
      gitSnapshotter: snapshotter,
      gitBoundaryDigest: "7".repeat(64),
      removeDirectory,
    });
    const executionId = "locked-cleanup";
    const executionRoot = path.join(
      setup.scratchRoot,
      "dashboard",
      executionId,
    );
    await assert.rejects(
      setup.broker.createExecution({
        workspaceId: "dashboard",
        executionId,
        inputBinding: pullRequestBinding(),
      }),
      (error) =>
        error.code === "EXECUTION_STORAGE_UNAVAILABLE" &&
        error.cause?.code === "EBUSY",
    );
    await access(executionRoot);

    cleanupLocked = false;
    await setup.broker.discardExecution({
      workspaceId: "dashboard",
      executionId,
    });
    await assert.rejects(access(executionRoot), { code: "ENOENT" });
  },
);

test("discard waits for queued work and removes only the requested execution", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const discardedExecution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "discarded-run",
  });
  const siblingExecution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "sibling-run",
  });
  const discardedRoot = path.join(scratchRoot, "dashboard", "discarded-run");

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(
    discardedExecution,
    async () => {
      markLocked();
      await release;
    },
  );
  await locked;

  let discardFinished = false;
  const discarding = broker.discardExecution(discardedExecution).then((result) => {
    discardFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discardFinished, false);
  await access(discardedRoot);

  releaseLock();
  await holdingLock;
  assert.deepEqual(await discarding, {
    workspaceId: "dashboard",
    executionId: "discarded-run",
    discarded: true,
  });
  await assert.rejects(access(discardedRoot));
  await assert.rejects(
    broker.listFiles(discardedExecution),
    (error) => error.code === "EXECUTION_NOT_FOUND",
  );
  assert.deepEqual(await broker.listFiles(siblingExecution), ["src/app.js"]);
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("discard is idempotent and removes executions not indexed after restart", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "restart-run",
  });
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot,
        writablePaths: ["src"],
      },
    ],
  });

  const expected = {
    workspaceId: "dashboard",
    executionId: "restart-run",
    discarded: true,
  };
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "restart-run")),
  );
});

test("discard after restart does not require the old workspace registration", async (t) => {
  const { broker, scratchRoot, sourceRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "removed-workspace-run",
  });
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [],
  });
  const expected = {
    workspaceId: "dashboard",
    executionId: "removed-workspace-run",
    discarded: true,
  };

  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  assert.deepEqual(await restartedBroker.discardExecution(execution), expected);
  await assert.rejects(
    access(path.join(scratchRoot, "dashboard", "removed-workspace-run")),
  );
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("discard rejects escaping identifiers and symlinked storage roots", async (t) => {
  const { broker, root, scratchRoot, sourceRoot } = await fixture(t);
  const outsideRoot = path.join(root, "outside");
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, "keep.txt"), "keep");

  await assert.rejects(
    broker.discardExecution({
      workspaceId: "dashboard",
      executionId: "../outside",
    }),
    (error) => error.code === "INVALID_EXECUTION_ID",
  );

  const workspaceScratch = path.join(scratchRoot, "dashboard");
  await mkdir(workspaceScratch, { recursive: true });
  try {
    await symlink(
      outsideRoot,
      path.join(workspaceScratch, "linked-run"),
      "junction",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const restartedBroker = new CodeWorkspaceBroker({
    scratchRoot,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot,
        writablePaths: ["src"],
      },
    ],
  });

  await assert.rejects(
    restartedBroker.discardExecution({
      workspaceId: "dashboard",
      executionId: "linked-run",
    }),
    (error) => error.code === "SYMLINK_REJECTED",
  );
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");

  await rm(workspaceScratch, { recursive: true, force: true });
  await symlink(outsideRoot, workspaceScratch, "junction");
  await assert.rejects(
    restartedBroker.discardExecution({
      workspaceId: "dashboard",
      executionId: "escaped-run",
    }),
    (error) => error.code === "SYMLINK_REJECTED",
  );
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");
});

test("discard unlinks nested symlinks without following them", async (t) => {
  const { broker, root, scratchRoot } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "nested-link-run",
  });
  const outsideRoot = path.join(root, "outside-nested");
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, "keep.txt"), "keep");
  const executionRoot = path.join(
    scratchRoot,
    "dashboard",
    "nested-link-run",
  );
  try {
    await symlink(
      outsideRoot,
      path.join(executionRoot, "linked-outside"),
      "junction",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }

  await broker.discardExecution(execution);

  await assert.rejects(access(executionRoot));
  assert.equal(await readFile(path.join(outsideRoot, "keep.txt"), "utf8"), "keep");
});

test("workspace revisions guard writes and stay locked during sandbox work", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "revision-run",
  });
  const current = await broker.readFile({ ...execution, path: "src/app.js" });
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "stale\n",
      expectedSha256: current.sha256,
      expectedWorkspaceRevision: "0".repeat(64),
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const checking = broker.withLockedExecution(execution, async (context) => {
    assert.equal(context.workspaceRevision, execution.workspaceRevision);
    assert.equal(path.isAbsolute(context.workspacePath), true);
    markLocked();
    await release;
    return "checked";
  });
  await locked;
  let writeFinished = false;
  const writing = broker
    .writeFile({
      ...execution,
      path: "src/app.js",
      content: "updated\n",
      expectedSha256: current.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    })
    .then((result) => {
      writeFinished = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeFinished, false);
  releaseLock();

  const checked = await checking;
  assert.equal(checked.result, "checked");
  assert.equal(checked.beforeWorkspaceRevision, execution.workspaceRevision);
  assert.equal(checked.afterWorkspaceRevision, execution.workspaceRevision);
  const write = await writing;
  assert.notEqual(write.workspaceRevision, execution.workspaceRevision);

  const sandboxFailure = Object.assign(new Error("sandbox stopped"), {
    code: "SANDBOX_TIMEOUT",
    details: { cleanupPending: true },
  });
  await assert.rejects(
    broker.withLockedExecution(execution, async () => {
      throw sandboxFailure;
    }),
    (error) => error === sandboxFailure,
  );
});

test("version-guarded reads wait for queued mutations and reject stale snapshots", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "guarded-read-run",
  });
  const expectedRevision = {
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  };
  assert.deepEqual(await broker.listFiles(expectedRevision), ["src/app.js"]);
  const current = await broker.readFile({
    ...expectedRevision,
    path: "src/app.js",
  });
  assert.equal(
    (await broker.searchText({ ...expectedRevision, query: "value" })).matches
      .length,
    1,
  );
  assert.deepEqual(await broker.getChangeManifest(expectedRevision), {
    created: [],
    modified: [],
    deleted: [],
  });

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const writing = broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  let settledCount = 0;
  const staleRevision = expectedRevision;
  const guardedReads = [
    broker.listFiles(staleRevision),
    broker.readFile({ ...staleRevision, path: "src/app.js" }),
    broker.searchText({ ...staleRevision, query: "value" }),
    broker.getChangeManifest(staleRevision),
  ].map((operation) =>
    operation.then(
      (value) => {
        settledCount += 1;
        return { value };
      },
      (error) => {
        settledCount += 1;
        return { error };
      },
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  const settledWhileLocked = settledCount;
  releaseLock();
  await holdingLock;
  await writing;
  const results = await Promise.all(guardedReads);

  assert.equal(settledWhileLocked, 0);
  for (const result of results) {
    assert.equal(result.error?.code, "WORKSPACE_REVISION_MISMATCH");
  }
});

test("guarded reads reuse cached revisions while sealing scans scratch integrity", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/other.js": "export const other = 1;\n",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "cached-read-run",
  });
  const guardedRevision = {
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  };

  const scratchPath = await broker.getSandboxWorkspacePath(execution);
  await writeFile(
    path.join(scratchPath, "src", "other.js"),
    "export const other = 2;\n",
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await broker.listFiles(guardedRevision), [
      "src/app.js",
      "src/other.js",
    ]);
    assert.equal(
      (
        await broker.readFile({
          ...guardedRevision,
          path: "src/app.js",
        })
      ).content,
      "export const value = 1;\n",
    );
    assert.deepEqual(
      (
        await broker.searchText({
          ...guardedRevision,
          query: "value",
        })
      ).matches.map((match) => match.path),
      ["src/app.js"],
    );
  }
  await assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
});

test("successful writes and deletes atomically advance cached revision guards", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/old.js": "old\n",
    },
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "cached-mutation-run",
  });
  const app = await broker.readFile({ ...execution, path: "src/app.js" });
  const old = await broker.readFile({ ...execution, path: "src/old.js" });

  const written = await broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: app.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const deleted = await broker.deleteFile({
    ...execution,
    path: "src/old.js",
    expectedSha256: old.sha256,
    expectedWorkspaceRevision: written.workspaceRevision,
  });

  assert.equal(deleted.beforeWorkspaceRevision, written.workspaceRevision);
  assert.notEqual(deleted.workspaceRevision, written.workspaceRevision);
  await assert.rejects(
    broker.readFile({
      ...execution,
      path: "src/app.js",
      expectedWorkspaceRevision: written.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
  assert.equal(
    (
      await broker.readFile({
        ...execution,
        path: "src/app.js",
        expectedWorkspaceRevision: deleted.workspaceRevision,
      })
    ).content,
    "export const value = 2;\n",
  );
  assert.equal(await broker.getWorkspaceRevision(execution), deleted.workspaceRevision);
});

test("sealing snapshots changes and rejects mutations queued behind it", async (t) => {
  const { broker } = await fixture(t, {
    files: {
      "src/app.js": "export const value = 1;\n",
      "src/old.js": "old\n",
    },
    writablePaths: ["src"],
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "seal-first-run",
  });
  const app = await broker.readFile({ ...execution, path: "src/app.js" });
  const old = await broker.readFile({ ...execution, path: "src/old.js" });

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const sealing = broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const writingRejected = assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "export const value = 2;\n",
      expectedSha256: app.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "EXECUTION_SEALED",
  );
  const deletingRejected = assert.rejects(
    broker.deleteFile({
      ...execution,
      path: "src/old.js",
      expectedSha256: old.sha256,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "EXECUTION_SEALED",
  );

  releaseLock();
  await holdingLock;
  const sealed = await sealing;
  await Promise.all([writingRejected, deletingRejected]);

  assert.equal(sealed.workspaceRevision, execution.workspaceRevision);
  assert.deepEqual(sealed.manifest, {
    created: [],
    modified: [],
    deleted: [],
  });
  sealed.manifest.created.push({ path: "caller-mutation" });
  const repeated = await broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  assert.deepEqual(repeated.manifest, {
    created: [],
    modified: [],
    deleted: [],
  });
  await assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: "0".repeat(64),
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );
});

test("a mutation queued before sealing wins and makes the stale seal fail", async (t) => {
  const { broker } = await fixture(t);
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "write-first-run",
  });
  const current = await broker.readFile({ ...execution, path: "src/app.js" });
  await assert.rejects(
    broker.sealExecution(execution),
    (error) => error.code === "EXPECTED_WORKSPACE_REVISION_REQUIRED",
  );

  let releaseLock;
  let markLocked;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holdingLock = broker.withLockedExecution(execution, async () => {
    markLocked();
    await release;
  });
  await locked;

  const writing = broker.writeFile({
    ...execution,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedSha256: current.sha256,
    expectedWorkspaceRevision: execution.workspaceRevision,
  });
  const staleSealRejected = assert.rejects(
    broker.sealExecution({
      ...execution,
      expectedWorkspaceRevision: execution.workspaceRevision,
    }),
    (error) => error.code === "WORKSPACE_REVISION_MISMATCH",
  );

  releaseLock();
  await holdingLock;
  const written = await writing;
  await staleSealRejected;

  const sealed = await broker.sealExecution({
    ...execution,
    expectedWorkspaceRevision: written.workspaceRevision,
  });
  assert.equal(sealed.workspaceRevision, written.workspaceRevision);
  assert.deepEqual(sealed.manifest.modified.map((entry) => entry.path), [
    "src/app.js",
  ]);
});

test("paths, secrets, write scope, and optimistic versions are enforced", async (t) => {
  const { broker, sourceRoot } = await fixture(t, {
    files: {
      "src/app.js": "old\n",
      "README.md": "read only\n",
      ".env.local": "TOKEN=secret",
    },
    writablePaths: ["src"],
  });
  const execution = await broker.createExecution({
    workspaceId: "dashboard",
    executionId: "secure-run",
  });

  await assert.rejects(
    broker.readFile({ ...execution, path: "../source/.env.local" }),
    (error) => error.code === "INVALID_PATH" && !error.message.includes(sourceRoot),
  );
  await assert.rejects(
    broker.readFile({ ...execution, path: ".env.local" }),
    (error) => error.code === "PATH_EXCLUDED",
  );
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "README.md",
      content: "changed",
      expectedSha256: null,
      writablePaths: ["README.md"],
    }),
    (error) => error.code === "WRITE_NOT_ALLOWED",
  );
  await assert.rejects(
    broker.writeFile({
      ...execution,
      path: "src/app.js",
      content: "changed",
      expectedSha256: "0".repeat(64),
    }),
    (error) => error.code === "SHA256_MISMATCH",
  );
  assert.equal(
    (await broker.readFile({ ...execution, path: "src/app.js" })).content,
    "old\n",
  );
});

test("source symlinks and junctions are rejected", async (t) => {
  const { broker, sourceRoot, root } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  try {
    await symlink(outside, path.join(sourceRoot, "linked"), "junction");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    broker.createExecution({ workspaceId: "dashboard", executionId: "linked-run" }),
    (error) => error.code === "SYMLINK_REJECTED" && !error.message.includes(root),
  );
});

test("file count, file size, search matches, and write bytes are bounded", async (t) => {
  const countFixture = await fixture(t, {
    files: { "src/a.js": "a", "src/b.js": "b" },
    limits: { maxFiles: 1 },
  });
  await assert.rejects(
    countFixture.broker.createExecution({ workspaceId: "dashboard", executionId: "count-run" }),
    (error) => error.code === "FILE_COUNT_LIMIT",
  );

  const sizeFixture = await fixture(t, {
    files: { "src/a.js": "12345" },
    limits: { maxFileBytes: 4 },
  });
  await assert.rejects(
    sizeFixture.broker.createExecution({ workspaceId: "dashboard", executionId: "size-run" }),
    (error) => error.code === "FILE_SIZE_LIMIT",
  );

  const bounded = await fixture(t, {
    files: { "src/a.js": "hit hit hit\n" },
    limits: { maxSearchMatches: 2, maxWriteBytes: 4 },
  });
  const execution = await bounded.broker.createExecution({
    workspaceId: "dashboard",
    executionId: "bounded-run",
  });
  assert.deepEqual(
    await bounded.broker.searchText({ ...execution, query: "hit" }),
    {
      matches: [
        { path: "src/a.js", line: 1, column: 1, text: "hit hit hit" },
        { path: "src/a.js", line: 1, column: 5, text: "hit hit hit" },
      ],
      truncated: true,
    },
  );
  const current = await bounded.broker.readFile({ ...execution, path: "src/a.js" });
  await assert.rejects(
    bounded.broker.writeFile({
      ...execution,
      path: "src/a.js",
      content: "12345",
      expectedSha256: current.sha256,
    }),
    (error) => error.code === "WRITE_SIZE_LIMIT",
  );
});
