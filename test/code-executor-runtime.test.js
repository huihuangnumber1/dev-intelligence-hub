import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodeExecutorRuntimeError,
  createCodeExecutorRuntime,
} from "../src/code-executor-runtime.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { mergeConfig } from "../src/lib/config.js";
import { StateStore } from "../src/lib/state-store.js";
import { ControlledGitService } from "../src/services/controlled-git-service.js";

const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

test("Windows-only production composition needs no Docker service or configuration", { skip: process.platform !== "win32" }, async (t) => {
  const value = await fixture(t);
  const config = enabledConfig(value.root);
  delete config.docker;
  config.profiles = { native: {
    kind: "windows-test", nodeExecutable: process.execPath,
    nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
    timeoutMs: 30_000,
    asset: { schemaVersion: 1, title: "Windows tests", description: "Real assertions", version: 1, source: "import assert from 'node:assert/strict'; assert.equal(1,1); console.log('# tests 1\\n# pass 1\\n# fail 0');" },
  } };
  config.requiredProfilesByWorkspace = { dashboard: ["native"] };
  const runtime = await createCodeExecutorRuntime(config, { sourceBaseRoot: value.sourceBaseRoot, runtimeRoot: value.runtimeRoot, store: value.store });
  assert.equal(runtime.sandbox.dockerRunner, null);
  assert.match(runtime.sandbox.getProfileFingerprint("native"), /^[a-f0-9]{64}$/);
  assert.equal(typeof runtime.settledVerificationReader.read, 'function');
  assert.equal(await runtime.settledVerificationReader.read({ jobId: 'missing', job: {} }), null);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "code-executor-runtime-"));
  const sourceBaseRoot = path.join(root, "sources");
  await mkdir(path.join(sourceBaseRoot, "dashboard", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(sourceBaseRoot, "dashboard", "src", "app.js"),
    "export const value = 1;\n",
  );
  await mkdir(path.join(sourceBaseRoot, "product", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(sourceBaseRoot, "product", "src", "app.js"),
    "export const product = true;\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    runtimeRoot: path.join(root, "runtime"),
    sourceBaseRoot,
    store: new StateStore(path.join(root, "state")),
  };
}

function enabledConfig(root) {
  return {
    enabled: true,
    docker: {
      executable: path.join(root, "docker.exe"),
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        writablePaths: ["src"],
      },
    ],
    profiles: {
      "node-tests": { kind: "node-test", image, timeoutMs: 30_000 },
    },
    requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
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
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        resultObjectDigest: "a".repeat(64),
        materialization: "full-tree",
      },
      gitTarget,
    }),
  });
}

function fakeConflictMaterializer(content = "<<<<<<< base\n=======\n>>>>>>> head\n") {
  const calls = [];
  return {
    calls,
    async materialize(request) {
      calls.push(structuredClone(request));
      const value = Buffer.from(content);
      const relativePath = "src/app.js";
      const target = path.join(request.targetRoot, "src", "app.js");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value);
      return {
        schemaVersion: 2,
        preparationId: request.binding.preparationId,
        binding: structuredClone(request.binding),
        targetRoot: request.targetRoot,
        materialization: "full-tree",
        excludePaths: [...request.excludePaths],
        files: [{
          path: relativePath,
          sha256: createHash("sha256").update(value).digest("hex"),
          mode: "100644",
          bytes: value.length,
        }],
        fileCount: 1,
        totalBytes: value.length,
        resultTreeOid: request.binding.resultTreeOid,
        evidenceDigest: request.binding.evidenceDigest,
        resultObjectDigest: request.binding.resultObjectDigest,
        residual: null,
      };
    },
  };
}

async function productionConflictGitConfig(setup) {
  const gitCommand = path.join(
    setup.root,
    process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git",
  );
  const baseMirrorRoot = path.join(setup.root, "mirrors", "base.git");
  const headMirrorRoot = path.join(setup.root, "mirrors", "head.git");
  await Promise.all([
    mkdir(path.dirname(gitCommand), { recursive: true }),
    mkdir(baseMirrorRoot, { recursive: true }),
    mkdir(headMirrorRoot, { recursive: true }),
  ]);
  await writeFile(gitCommand, "trusted fake git");
  if (process.platform !== "win32") await chmod(gitCommand, 0o755);
  return {
    gitCommand,
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: { "acme/dashboard": baseMirrorRoot },
      headMirrorsByRepository: {
        "contributor/dashboard": headMirrorRoot,
      },
    },
  };
}

function fakeGitSnapshotter(sourceRoot, {
  gitCommand = path.resolve(sourceRoot, "..", "..", "git.exe"),
  gitExecutableSha256 = "e".repeat(64),
  gitExecutableBytes = 1,
  gitExecutableMode = 0o755,
  gitExecutableUid = 0,
  gitExecutableGid = 0,
  boundaryDigest = "a".repeat(64),
  objectFormat = "sha1",
  content = "export const value = 'fixed-head';\n",
  preflightError = null,
  extraBoundary = {},
} = {}) {
  const calls = { preflight: [], materialize: [] };
  return {
    calls,
    async preflight(request) {
      calls.preflight.push(structuredClone(request));
      if (preflightError) throw preflightError;
      return {
        schemaVersion: 1,
        gitCommand,
        gitExecutableSha256,
        gitExecutableBytes,
        gitExecutableMode,
        gitExecutableUid,
        gitExecutableGid,
        canonicalRoot: path.resolve(sourceRoot),
        absoluteGitDir: path.resolve(sourceRoot, ".git"),
        commonDir: path.resolve(sourceRoot, ".git"),
        objectDirectory: path.resolve(sourceRoot, ".git", "objects"),
        objectFormat,
        oidLength: objectFormat === "sha1" ? 40 : 64,
        boundaryDigest,
        ...extraBoundary,
      };
    },
    async materialize(request) {
      calls.materialize.push(structuredClone(request));
      const value = Buffer.from(content);
      const relativePath = "src/app.js";
      const target = path.join(request.targetRoot, "src", "app.js");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value);
      return {
        headOid: request.headOid,
        baseline: new Map([
          [
            relativePath,
            createHash("sha256").update(value).digest("hex"),
          ],
        ]),
        modes: new Map([[relativePath, "100644"]]),
        fileCount: 1,
        totalBytes: value.length,
      };
    },
  };
}

test("disabled runtime constructs nothing", async (t) => {
  const setup = await fixture(t);

  assert.equal(
    await createCodeExecutorRuntime(
      { enabled: false },
      { runtimeRoot: setup.runtimeRoot },
    ),
    null,
  );
  await assert.rejects(access(setup.runtimeRoot), (error) => error.code === "ENOENT");
});

test("enabled runtime resolves local workspaces and recovers before use", async (t) => {
  const setup = await fixture(t);
  const runtime = await createCodeExecutorRuntime(enabledConfig(setup.root), {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
  });

  assert.deepEqual(runtime.recovery, { recovered: true, cleanupPending: 0 });
  assert.deepEqual(runtime.authority, {
    workspaces: [
      {
        id: "dashboard",
        capabilities: ["directory_snapshot"],
        writablePaths: ["src"],
        excludePaths: [],
        requiredProfiles: [
          {
            id: "node-tests",
            configDigest: runtime.sandbox.getProfileFingerprint("node-tests"),
          },
        ],
        authorityDigest: runtime.authority.workspaces[0].authorityDigest,
      },
    ],
  });
  assert.match(
    runtime.authority.workspaces[0].authorityDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(Object.isFrozen(runtime.authority.workspaces[0]), true);
  assert.deepEqual(runtime.inspectAuthorityForWritablePaths({ workspaceId: "dashboard", writablePaths: ["src"] }), runtime.authority);
  assert.throws(() => runtime.inspectAuthorityForWritablePaths({ workspaceId: "dashboard", writablePaths: ["extra"] }),
    { code: "INVALID_CODE_EXECUTOR_CONFIG" });
  assert.throws(() => runtime.inspectAuthorityForWritablePaths({ workspaceId: "dashboard", writablePaths: ["src", "src"] }),
    { code: "INVALID_CODE_EXECUTOR_CONFIG" });
  assert.deepEqual(runtime.changePackageTargets, [
    {
      workspaceId: "dashboard",
      sourceRoot: path.join(setup.sourceBaseRoot, "dashboard"),
      targetAuthorityDigest: runtime.authority.workspaces[0].authorityDigest,
      writablePaths: ["src"],
      excludePaths: [],
    },
  ]);
  assert.equal(Object.isFrozen(runtime.changePackageTargets), true);
  assert.equal(Object.isFrozen(runtime.changePackageTargets[0]), true);
  assert.deepEqual(Object.keys(runtime.completedChangeExporter), ["export"]);
  assert.equal(Object.isFrozen(runtime.completedChangeExporter), true);
  assert.deepEqual(Object.keys(runtime.auditArtifactReader), ["read"]);
  assert.equal(Object.isFrozen(runtime.auditArtifactReader), true);
  const artifactRef = await runtime.journal.writeJson({
    sessionId: "runtime-session",
    actionId: "runtime-proof",
    kind: "output",
    value: { passed: true },
  });
  assert.deepEqual(
    await runtime.auditArtifactReader.read(artifactRef),
    Buffer.from('{"passed":true}\n'),
  );
  const session = await runtime.executor.start({
    sessionId: "runtime-session",
    workspaceId: "dashboard",
    requestedBy: { roleId: "r".repeat(65), workItemId: "dashboard#unit4" },
    inputBinding: null,
  });
  const read = await runtime.executor.perform({
    sessionId: session.id,
    action: {
      type: "read_text",
      actionId: "read-runtime-source",
      expectedWorkspaceRevision: session.workspaceRevision,
      path: "src/app.js",
    },
  });

  assert.equal(read.result.content, "export const value = 1;\n");
  assert.equal(read.session.status, "active");
  await assert.rejects(
    runtime.completedChangeExporter.export({
      sessionId: session.id,
      completedActionId: "complete-runtime-session",
      expectedWorkspaceRevision: session.workspaceRevision,
    }),
    (error) => error.code === "EXECUTOR_SESSION_NOT_COMPLETED",
  );
});

test("conflict capability is published only with its trusted materializer", async (t) => {
  const setup = await fixture(t);
  const materializer = fakeConflictMaterializer();
  const runtime = await createCodeExecutorRuntime(enabledConfig(setup.root), {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
    conflictMaterializer: materializer,
  });
  const executionSource = conflictExecutionSource();

  assert.deepEqual(runtime.authority.workspaces[0].capabilities, [
    "directory_snapshot",
    "conflict_preparation_snapshot",
  ]);
  assert.equal(runtime.conflictPreparationVerifier, null);
  assert.equal(runtime.conflictExecutionSourcePreparer, null);
  assert.equal(runtime.controlledCommitBuilder, null);
  assert.equal(runtime.controlledCommitPublisher, null);
  const execution = await runtime.broker.createExecution({
    workspaceId: "dashboard",
    executionId: "conflict-runtime-run",
    inputBinding: executionSource.inputBinding,
    executionSource,
  });
  assert.deepEqual(execution.executionSource, executionSource);
  assert.deepEqual(materializer.calls[0].excludePaths, []);
  assert.equal(
    (await runtime.broker.readFile({ ...execution, path: "src/app.js" })).content,
    "<<<<<<< base\n=======\n>>>>>>> head\n",
  );

  await assert.rejects(
    createCodeExecutorRuntime(enabledConfig(setup.root), {
      runtimeRoot: path.join(setup.root, "injected-runtime"),
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      conflictMaterializer: materializer,
      broker: {},
    }),
    (error) => error?.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
});

test("configured Controlled Git exposes only frozen production ports", async (t) => {
  const setup = await fixture(t);
  const config = enabledConfig(setup.root);
  Object.assign(config, await productionConflictGitConfig(setup));

  config.brokerLimits = { maxFiles: 10_000, maxDirectories: 11_000, maxFileBytes: 20_000_000, maxTotalBytes: 150_000_000 };
  let actualLimits;
  const runtime = await createCodeExecutorRuntime(config, {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
    controlledGitDependencies: { controlledGitServiceFactory(settings) {
      actualLimits = settings.limits;
      return new ControlledGitService(settings);
    } },
  });

  assert.deepEqual(actualLimits, { maxFiles: 10_000, maxDirectories: 11_000, maxBlobBytes: 20_000_000, maxTotalBytes: 150_000_000 });
  await assert.rejects(createCodeExecutorRuntime(config, {
    runtimeRoot: setup.runtimeRoot, sourceBaseRoot: setup.sourceBaseRoot, store: setup.store,
    controlledGitDependencies: { limits: { maxTotalBytes: 999_999_999 } },
  }), error => error.code === "INVALID_CODE_EXECUTOR_CONFIG");

  assert.deepEqual(runtime.authority.workspaces[0].capabilities, [
    "directory_snapshot",
    "conflict_preparation_snapshot",
  ]);
  assert.deepEqual(Object.keys(runtime.conflictPreparationVerifier), [
    "verify",
  ]);
  assert.deepEqual(Object.keys(runtime.conflictExecutionSourcePreparer), [
    "prepare",
  ]);
  assert.deepEqual(Object.keys(runtime.controlledCommitBuilder), [
    "create",
    "find",
    "verify",
    "readSealed",
  ]);
  assert.deepEqual(Object.keys(runtime.controlledCommitPublisher), ["publish"]);
  assert.equal(Object.isFrozen(runtime.conflictPreparationVerifier), true);
  assert.equal(Object.isFrozen(runtime.conflictExecutionSourcePreparer), true);
  assert.equal(Object.isFrozen(runtime.controlledCommitBuilder), true);
  assert.equal(Object.isFrozen(runtime.controlledCommitPublisher), true);
  assert.equal("controlledGitService" in runtime, false);
  assert.equal("controlledGitRuntime" in runtime, false);
  await access(path.join(setup.runtimeRoot, "conflict-preparations"));
});

test("configured Controlled Git fails closed before publishing partial authority", async (t) => {
  const setup = await fixture(t);
  const controlledGit = await productionConflictGitConfig(setup);
  const incomplete = enabledConfig(setup.root);
  incomplete.gitCommand = controlledGit.gitCommand;
  incomplete.conflictPreparation = {
    enabled: true,
    baseMirrorsByRepository:
      controlledGit.conflictPreparation.baseMirrorsByRepository,
  };

  await assert.rejects(
    createCodeExecutorRuntime(incomplete, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error?.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  await assert.rejects(access(setup.runtimeRoot), (error) => error.code === "ENOENT");

  const configured = enabledConfig(setup.root);
  Object.assign(configured, controlledGit);
  await assert.rejects(
    createCodeExecutorRuntime(configured, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      conflictMaterializer: fakeConflictMaterializer(),
    }),
    (error) => error?.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  await assert.rejects(access(setup.runtimeRoot), (error) => error.code === "ENOENT");
});

test("Git Head capability is advertised only after preflight and executes the sealed PR Head", async (t) => {
  const setup = await fixture(t);
  const config = enabledConfig(setup.root);
  config.gitCommand = path.join(setup.root, "git.exe");
  config.gitTimeoutMs = 12_345;
  config.workspaces[0].gitHeadSnapshot = true;
  const sourceRoot = path.join(setup.sourceBaseRoot, "dashboard");
  const gitSnapshotter = fakeGitSnapshotter(sourceRoot);

  const runtime = await createCodeExecutorRuntime(config, {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
    gitSnapshotter,
  });

  assert.deepEqual(gitSnapshotter.calls.preflight, [{ sourceRoot }]);
  assert.deepEqual(runtime.authority.workspaces[0].capabilities, [
    "directory_snapshot",
    "git_head_snapshot",
  ]);
  const inputBinding = pullRequestBinding();
  const session = await runtime.executor.start({
    sessionId: "git-head-session",
    workspaceId: "dashboard",
    requestedBy: { roleId: "developer", workItemId: "dashboard#pr42" },
    inputBinding,
  });
  assert.deepEqual(session.inputBinding, inputBinding);
  const read = await runtime.executor.perform({
    sessionId: session.id,
    action: {
      type: "read_text",
      actionId: "read-fixed-head-source",
      expectedWorkspaceRevision: session.workspaceRevision,
      path: "src/app.js",
    },
  });
  assert.equal(read.result.content, "export const value = 'fixed-head';\n");
  assert.equal(gitSnapshotter.calls.materialize.length, 1);
  assert.deepEqual(
    {
      sourceRoot: gitSnapshotter.calls.materialize[0].sourceRoot,
      headOid: gitSnapshotter.calls.materialize[0].headOid,
      excludePaths: gitSnapshotter.calls.materialize[0].excludePaths,
      expectedBoundaryDigest:
        gitSnapshotter.calls.materialize[0].expectedBoundaryDigest,
      expectedGitCommand:
        gitSnapshotter.calls.materialize[0].expectedGitCommand,
      expectedGitExecutableSha256:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableSha256,
      expectedGitExecutableBytes:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableBytes,
      expectedGitExecutableMode:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableMode,
      expectedGitExecutableUid:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableUid,
      expectedGitExecutableGid:
        gitSnapshotter.calls.materialize[0].expectedGitExecutableGid,
    },
    {
      sourceRoot,
      headOid: inputBinding.headRefOid,
      excludePaths: [],
      expectedBoundaryDigest: "a".repeat(64),
      expectedGitCommand: path.join(setup.root, "git.exe"),
      expectedGitExecutableSha256: "e".repeat(64),
      expectedGitExecutableBytes: 1,
      expectedGitExecutableMode: 0o755,
      expectedGitExecutableUid: 0,
      expectedGitExecutableGid: 0,
    },
  );
});

test("explicit Git Head configuration fails startup on missing authority or preflight failure", async (t) => {
  const setup = await fixture(t);
  const optIn = enabledConfig(setup.root);
  optIn.workspaces[0].gitHeadSnapshot = true;

  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );

  optIn.gitCommand = path.join(setup.root, "git.exe");
  const preflightFailure = fakeGitSnapshotter(
    path.join(setup.sourceBaseRoot, "dashboard"),
    { preflightError: Object.assign(new Error("not a repository"), {
      code: "GIT_SNAPSHOT_ROOT_MISMATCH",
    }) },
  );
  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: preflightFailure,
    }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "GIT_HEAD_SNAPSHOT_PREFLIGHT_FAILED",
  );

  const invalidReceipt = fakeGitSnapshotter(
    path.join(setup.sourceBaseRoot, "dashboard"),
    { extraBoundary: { widened: true } },
  );
  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: invalidReceipt,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );

  await assert.rejects(
    createCodeExecutorRuntime(optIn, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
      gitSnapshotter: fakeGitSnapshotter(
        path.join(setup.sourceBaseRoot, "dashboard"),
      ),
      broker: {},
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
});

test("Git snapshot command, boundary, format, and capability are sealed into workspace authority", async (t) => {
  const setup = await fixture(t);
  const sourceRoot = path.join(setup.sourceBaseRoot, "dashboard");
  const create = (suffix, {
    command = `git-${suffix}.exe`,
    gitExecutableSha256 = "e".repeat(64),
    gitExecutableMode = 0o755,
    boundaryDigest = "a".repeat(64),
    objectFormat = "sha1",
    enabled = true,
  } = {}) => {
    const config = enabledConfig(setup.root);
    if (enabled) {
      config.gitCommand = path.join(setup.root, command);
      config.workspaces[0].gitHeadSnapshot = true;
    }
    return createCodeExecutorRuntime(config, {
      runtimeRoot: path.join(setup.root, `runtime-git-${suffix}`),
      sourceBaseRoot: setup.sourceBaseRoot,
      store: new StateStore(path.join(setup.root, `state-git-${suffix}`)),
      ...(enabled
        ? {
            gitSnapshotter: fakeGitSnapshotter(sourceRoot, {
              gitCommand: path.join(setup.root, command),
              gitExecutableSha256,
              gitExecutableMode,
              boundaryDigest,
              objectFormat,
            }),
          }
        : {}),
    });
  };

  const [base, command, executable, executableMode, boundary, format, directory] = await Promise.all([
    create("base", { command: "git.exe" }),
    create("command", { command: "git-other.exe" }),
    create("executable", {
      command: "git.exe",
      gitExecutableSha256: "f".repeat(64),
    }),
    create("executable-mode", {
      command: "git.exe",
      gitExecutableMode: 0o555,
    }),
    create("boundary", { command: "git.exe", boundaryDigest: "b".repeat(64) }),
    create("format", { command: "git.exe", objectFormat: "sha256" }),
    create("directory", { enabled: false }),
  ]);
  const digest = (runtime) => runtime.authority.workspaces[0].authorityDigest;

  assert.notEqual(digest(base), digest(command));
  assert.notEqual(digest(base), digest(executable));
  assert.notEqual(digest(base), digest(executableMode));
  assert.notEqual(digest(base), digest(boundary));
  assert.notEqual(digest(base), digest(format));
  assert.notEqual(digest(base), digest(directory));
  assert.deepEqual(directory.authority.workspaces[0].capabilities, [
    "directory_snapshot",
  ]);
});

test("workspace authority binds source, exclusions, writes, and fixed profiles", async (t) => {
  const setup = await fixture(t);
  const makeRuntime = (config, suffix) =>
    createCodeExecutorRuntime(config, {
      runtimeRoot: path.join(setup.root, `runtime-${suffix}`),
      sourceBaseRoot: setup.sourceBaseRoot,
      store: new StateStore(path.join(setup.root, `state-${suffix}`)),
    });
  const base = enabledConfig(setup.root);
  const first = await makeRuntime(base, "base");
  const changedSource = structuredClone(base);
  changedSource.workspaces[0].sourceRoot = "product";
  const second = await makeRuntime(changedSource, "source");
  const changedExclusions = structuredClone(base);
  changedExclusions.workspaces[0].excludePaths = ["src/private"];
  const third = await makeRuntime(changedExclusions, "exclude");
  const addedWrites = structuredClone(base);
  addedWrites.workspaces[0].writablePaths.push("docs/one.cpp");
  const fourth = await makeRuntime(addedWrites, "added-writes");
  assert.notEqual(first.authority.workspaces[0].authorityDigest, fourth.authority.workspaces[0].authorityDigest);
  assert.deepEqual(fourth.inspectAuthorityForWritablePaths({ workspaceId: "dashboard", writablePaths: ["src"] }),
    first.authority);

  assert.notEqual(
    first.authority.workspaces[0].authorityDigest,
    second.authority.workspaces[0].authorityDigest,
  );
  assert.notEqual(
    first.authority.workspaces[0].authorityDigest,
    third.authority.workspaces[0].authorityDigest,
  );
});

test("invalid runtime state fails startup instead of exposing the executor", async (t) => {
  const setup = await fixture(t);
  await setup.store.write("code-executor-state", { invalid: true });

  await assert.rejects(
    createCodeExecutorRuntime(enabledConfig(setup.root), {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "EXECUTOR_STATE_INVALID",
  );
});

test("a local workspace replacement remains runnable after config merge", async (t) => {
  const setup = await fixture(t);
  const merged = mergeConfig(
    { codeExecutor: enabledConfig(setup.root) },
    {
      codeExecutor: {
        workspaces: [
          {
            id: "product",
            sourceRoot: "product",
            writablePaths: ["src"],
          },
        ],
        requiredProfilesByWorkspace: { product: ["node-tests"] },
      },
    },
  ).codeExecutor;

  const runtime = await createCodeExecutorRuntime(merged, {
    runtimeRoot: setup.runtimeRoot,
    sourceBaseRoot: setup.sourceBaseRoot,
    store: setup.store,
  });
  const session = await runtime.executor.start({
    sessionId: "product-session",
    workspaceId: "product",
    requestedBy: { roleId: "developer", workItemId: "product#unit4" },
    inputBinding: null,
  });

  assert.equal(session.workspaceId, "product");
});

test("enabled runtime rejects incomplete and unsafe composition config", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    createCodeExecutorRuntime({ enabled: true }),
    (error) =>
      error instanceof CodeExecutorRuntimeError &&
      error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  const unboundWorkspace = enabledConfig(setup.root);
  unboundWorkspace.requiredProfilesByWorkspace = {};
  await assert.rejects(
    createCodeExecutorRuntime(unboundWorkspace, {
      runtimeRoot: setup.runtimeRoot,
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
  await assert.rejects(
    createCodeExecutorRuntime(enabledConfig(setup.root), {
      runtimeRoot: "relative-runtime",
      sourceBaseRoot: setup.sourceBaseRoot,
      store: setup.store,
    }),
    (error) => error.code === "INVALID_CODE_EXECUTOR_CONFIG",
  );
});
