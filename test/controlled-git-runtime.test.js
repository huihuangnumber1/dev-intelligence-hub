import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ControlledGitRuntimeError,
  createControlledGitRuntimeBundle,
} from "../src/controlled-git-runtime.js";
import { sameCodeExecutionSource } from "../src/domain/code-execution-source.js";

function pullRequestBinding(overrides = {}) {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/dashboard",
    baseRefName: "main",
    baseRefOid: "1".repeat(40),
    headRepository: "contributor/dashboard",
    headRefName: "fix/conflict",
    headRefOid: "2".repeat(40),
    ...(overrides.gitTarget || {}),
  };
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: gitTarget.baseRepository,
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/dashboard#42",
    workKey: "pr:acme/dashboard#42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: gitTarget.headRefOid,
    eventId: "github-event-pr-42",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
    gitTarget,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "gitTarget"),
    ),
  };
}

function preparationFor(inputBinding, overrides = {}) {
  return {
    schemaVersion: 1,
    preparationId: "5".repeat(64),
    status: "conflicted",
    baseCommitOid: inputBinding.gitTarget.baseRefOid,
    headCommitOid: inputBinding.gitTarget.headRefOid,
    mergeBaseOid: "6".repeat(40),
    resultTreeOid: "7".repeat(40),
    conflicts: [{ path: "src/app.js", mode: "100644" }],
    boundaryDigest: "8".repeat(64),
    evidenceDigest: "9".repeat(64),
    resultObjectDigest: "a".repeat(64),
    materialization: "full-tree",
    ...overrides,
  };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-git-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitCommand = path.join(
    root,
    process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git",
  );
  const baseMirrorRoot = path.join(root, "mirrors", "base.git");
  const headMirrorRoot = path.join(root, "mirrors", "head.git");
  await Promise.all([
    mkdir(path.dirname(gitCommand), { recursive: true }),
    mkdir(baseMirrorRoot, { recursive: true }),
    mkdir(headMirrorRoot, { recursive: true }),
  ]);
  await writeFile(gitCommand, "trusted fake git");
  if (process.platform !== "win32") await chmod(gitCommand, 0o755);
  const config = {
    enabled: true,
    gitCommand,
    preparationRoot: path.join(root, "preparations"),
    baseMirrorsByRepository: {
      "acme/dashboard": baseMirrorRoot,
    },
    headMirrorsByRepository: {
      "contributor/dashboard": headMirrorRoot,
    },
    ...overrides,
  };
  return { root, config };
}

function fakeService(preparation) {
  const calls = {
    inspect: [],
    verify: [],
    materialize: [],
    readSources: [],
    createCommit: [],
    findCommit: [],
    verifyCommit: [],
    publishCommit: [],
    recoverCommits: 0,
  };
  return {
    calls,
    async recoverControlledCommits() {
      calls.recoverCommits += 1;
      return { commits: 0, removedScratchDirectories: 0 };
    },
    async createControlledCommit(request) {
      calls.createCommit.push(request);
      return { evidenceId: "controlled-git-commit-created" };
    },
    async findControlledCommit(request) {
      calls.findCommit.push(request);
      return null;
    },
    async verifyControlledCommit(request) {
      calls.verifyCommit.push(request);
      return { evidenceId: request.evidenceId };
    },
    async readSealedControlledCommit(request) {
      return { evidenceId: request.evidenceId };
    },
    async publishControlledCommit(request) {
      calls.publishCommit.push(request);
      return { status: "stale" };
    },
    async inspectConflict(request) {
      calls.inspect.push(structuredClone(request));
      return structuredClone(preparation);
    },
    async readConflictInspection({ binding }) { return { schemaVersion: 1, preparationBinding: binding, conflicts: [] }; },
    async readConflictSources(request) { calls.readSources.push(request); return []; },
    async verifyConflictPreparation(request) {
      calls.verify.push(structuredClone(request));
      return structuredClone(request.binding);
    },
    async materializeConflictPreparationForCodeJob(request) {
      calls.materialize.push(structuredClone(request));
      return Object.freeze({ materialized: true });
    },
  };
}

test("trusted runtime budgets are bounded data and passed to the service without new ports", async (t) => {
  const setup = await fixture(t);
  const service = fakeService(preparationFor(pullRequestBinding()));
  const limits = { maxFiles: 10_000, maxBlobBytes: 20_000_000, maxTotalBytes: 150_000_000 };
  let actual;
  await createControlledGitRuntimeBundle(setup.config, { limits,
    controlledGitServiceFactory(config) { actual = config.limits; return service; } });
  assert.deepEqual(actual, limits);
  assert.notEqual(actual, limits);
  assert.equal(Object.isFrozen(actual), true);
  let getterCalls = 0;
  const accessor = { get maxFiles() { getterCalls += 1; return 100; } };
  for (const invalid of [accessor, new Proxy({}, {}), { timeoutMs: 1 }, { maxFiles: 0 },
    { maxFiles: Infinity }, { maxBlobBytes: 2_000_000, maxTotalBytes: 1_000_000 }]) {
    await assert.rejects(createControlledGitRuntimeBundle(setup.config, { limits: invalid }),
      error => error.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG");
  }
  assert.equal(getterCalls, 0);
});

test("controlled runtime accepts the UCRT64 native Git implementation", async (t) => {
  if (process.platform !== "win32") return;
  const setup = await fixture(t);
  setup.config.gitCommand = path.join(setup.root, "ucrt64", "bin", "git.exe");
  await mkdir(path.dirname(setup.config.gitCommand), { recursive: true });
  await writeFile(setup.config.gitCommand, "trusted UCRT64 Git executable\n");
  let called = false;
  await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory() {
      called = true;
      return fakeService(preparationFor(pullRequestBinding()));
    },
  });
  assert.equal(called, true);
});

test("one Controlled Git service is hidden behind frozen least-authority ports", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const service = fakeService(preparationFor(inputBinding));
  const factoryCalls = [];
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory(config) {
      factoryCalls.push(config);
      return service;
    },
  });

  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(Object.keys(bundle), [
    "commitBuilder",
    "materializer",
    "publisher",
    "verifier",
    "preparer",
    "sourceReader",
    "inspectionReader",
  ]);
  assert.equal(Object.isFrozen(bundle), true);
  assert.deepEqual(Object.keys(bundle.commitBuilder), ["create", "find", "verify", "readSealed"]);
  assert.deepEqual(Object.keys(bundle.materializer), ["materialize"]);
  assert.deepEqual(Object.keys(bundle.publisher), ["publish"]);
  assert.deepEqual(Object.keys(bundle.verifier), ["verify"]);
  assert.deepEqual(Object.keys(bundle.preparer), ["prepare"]);
  assert.deepEqual(Object.keys(bundle.sourceReader), ["read"]);
  assert.equal(Object.isFrozen(bundle.sourceReader), true);
  assert.equal(Object.isFrozen(bundle.materializer), true);
  assert.equal(Object.isFrozen(bundle.publisher), true);
  assert.equal(Object.isFrozen(bundle.verifier), true);
  assert.equal(Object.isFrozen(bundle.preparer), true);
  assert.equal(Object.isFrozen(bundle.commitBuilder), true);
  assert.equal("service" in bundle, false);
  assert.equal("controlledGitService" in bundle, false);
  assert.equal(service.calls.recoverCommits, 1);

  const executionSource = await bundle.preparer.prepare(inputBinding);
  assert.deepEqual(service.calls.inspect, [{
    gitTarget: inputBinding.gitTarget,
    baseMirrorRoot: setup.config.baseMirrorsByRepository["acme/dashboard"],
    headMirrorRoot:
      setup.config.headMirrorsByRepository["contributor/dashboard"],
  }]);
  assert.equal(service.calls.verify.length, 1);
  assert.equal(sameCodeExecutionSource(executionSource, {
    ...executionSource,
    inputBinding,
  }), true);
  assert.deepEqual(executionSource.writeScope, {
    mode: "exact_files",
    paths: ["src/app.js"],
  });
  assert.equal(Object.isFrozen(executionSource), true);
  assert.equal(Object.isFrozen(executionSource.preparationBinding), true);
  assert.deepEqual(await bundle.sourceReader.read(executionSource), { inputBinding,
    preparationBinding: executionSource.preparationBinding, documents: [] });
  assert.deepEqual(service.calls.readSources, [{ binding: executionSource.preparationBinding }]);

  await bundle.verifier.verify(executionSource.preparationBinding);
  await bundle.materializer.materialize({
    binding: executionSource.preparationBinding,
    targetRoot: path.join(setup.root, "target"),
    excludePaths: [],
  });
  assert.equal(service.calls.verify.length, 2);
  assert.equal(service.calls.materialize.length, 1);
  const commitRequest = Object.freeze({ marker: "create" });
  const findRequest = Object.freeze({ marker: "find" });
  const verifyRequest = Object.freeze({ evidenceId: "controlled-git-commit-id" });
  const publishRequest = Object.freeze({ marker: "publish" });
  await bundle.commitBuilder.create(commitRequest);
  await bundle.commitBuilder.find(findRequest);
  await bundle.commitBuilder.verify(verifyRequest);
  assert.deepEqual(await bundle.publisher.publish(publishRequest), {
    status: "stale",
  });
  assert.deepEqual(service.calls.createCommit, [commitRequest]);
  assert.deepEqual(service.calls.findCommit, [findRequest]);
  assert.deepEqual(service.calls.verifyCommit, [verifyRequest]);
  assert.deepEqual(service.calls.publishCommit, [publishRequest]);
});

test("same-repository PR resolves distinct trusted base and head mirrors", async (t) => {
  const setup = await fixture(t);
  setup.config.headMirrorsByRepository = {
    "acme/dashboard": path.join(
      setup.root,
      "mirrors",
      "same-repository-head.git",
    ),
  };
  await mkdir(setup.config.headMirrorsByRepository["acme/dashboard"], {
    recursive: true,
  });
  const inputBinding = pullRequestBinding({
    gitTarget: { headRepository: "acme/dashboard" },
  });
  const service = fakeService(preparationFor(inputBinding));
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });

  await bundle.preparer.prepare(inputBinding);

  assert.equal(
    service.calls.inspect[0].baseMirrorRoot,
    setup.config.baseMirrorsByRepository["acme/dashboard"],
  );
  assert.equal(
    service.calls.inspect[0].headMirrorRoot,
    setup.config.headMirrorsByRepository["acme/dashboard"],
  );
  assert.notEqual(
    service.calls.inspect[0].baseMirrorRoot,
    service.calls.inspect[0].headMirrorRoot,
  );
});

test("enabled runtime rejects incomplete, overlapping, accessor and incomplete-port configuration", async (t) => {
  const setup = await fixture(t);
  const cases = [
    { ...setup.config, headMirrorsByRepository: undefined },
    { ...setup.config, baseMirrorsByRepository: {} },
    {
      ...setup.config,
      headMirrorsByRepository: {
        "contributor/dashboard":
          setup.config.baseMirrorsByRepository["acme/dashboard"],
      },
    },
    {
      ...setup.config,
      baseMirrorsByRepository: {
        "acme/dashboard": path.join(setup.config.preparationRoot, "base.git"),
      },
    },
  ];
  for (const config of cases) {
    await assert.rejects(
      createControlledGitRuntimeBundle(config),
      (error) =>
        error instanceof ControlledGitRuntimeError &&
        error.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG",
    );
  }

  const accessor = { ...setup.config };
  Object.defineProperty(accessor, "headMirrorsByRepository", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    createControlledGitRuntimeBundle(accessor),
    (error) => error?.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG",
  );

  for (const missingMethod of [
    "recoverControlledCommits",
    "readConflictInspection",
    "createControlledCommit",
    "verifyControlledCommit",
    "publishControlledCommit",
  ]) {
    const inputBinding = pullRequestBinding();
    const service = fakeService(preparationFor(inputBinding));
    delete service[missingMethod];
    await assert.rejects(
      createControlledGitRuntimeBundle(setup.config, {
        controlledGitServiceFactory: () => service,
      }),
      (error) => error?.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG",
      missingMethod,
    );
  }
  await assert.rejects(
    createControlledGitRuntimeBundle(setup.config, {
      controlledGitServiceFactory: () => ({
        inspectConflict() {},
        materializeConflictPreparationForCodeJob() {},
      }),
    }),
    (error) => error?.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG",
  );

  let dependencyGetterCalls = 0;
  const dependencyAccessor = {};
  Object.defineProperty(dependencyAccessor, "mirrorInspector", {
    enumerable: true,
    get() {
      dependencyGetterCalls += 1;
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    createControlledGitRuntimeBundle(setup.config, dependencyAccessor),
    (error) => error?.code === "INVALID_CONTROLLED_GIT_RUNTIME_CONFIG",
  );
  assert.equal(dependencyGetterCalls, 0);
});

test("startup preflight rejects unavailable and linked trusted boundaries", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    createControlledGitRuntimeBundle({
      ...setup.config,
      gitCommand: path.join(setup.root, "missing", "git"),
    }),
    (error) => error?.code === "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
  );

  const linkedMirror = path.join(setup.root, "mirrors", "linked-base.git");
  try {
    await symlink(
      setup.config.baseMirrorsByRepository["acme/dashboard"],
      linkedMirror,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("platform does not permit directory links");
      return;
    }
    throw error;
  }
  await assert.rejects(
    createControlledGitRuntimeBundle({
      ...setup.config,
      baseMirrorsByRepository: { "acme/dashboard": linkedMirror },
    }),
    (error) => error?.code === "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
  );
});

test("startup preflight does not create preparation roots through linked ancestors", async (t) => {
  const setup = await fixture(t);
  const outsideRoot = await mkdtemp(
    path.join(tmpdir(), "controlled-git-runtime-outside-"),
  );
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const linkedAncestor = path.join(setup.root, "linked-preparations");
  const outsideLeaf = path.join(outsideRoot, "preparations");
  try {
    await symlink(
      outsideRoot,
      linkedAncestor,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("platform does not permit directory links");
      return;
    }
    throw error;
  }

  await assert.rejects(
    createControlledGitRuntimeBundle({
      ...setup.config,
      preparationRoot: path.join(linkedAncestor, "preparations"),
    }),
    (error) => error?.code === "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
  );
  await assert.rejects(
    lstat(outsideLeaf),
    (error) => error?.code === "ENOENT",
  );
});

test("inspection and dispatch reuse exact-binding sealed material with fresh verification", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const service = fakeService(preparationFor(inputBinding));
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });
  const inspection = await bundle.inspectionReader.read(inputBinding);
  const source = await bundle.preparer.prepare(structuredClone(inputBinding));
  assert.equal(service.calls.inspect.length, 1);
  assert.equal(service.calls.verify.length, 2);
  assert.deepEqual(source.preparationBinding, inspection.preparationBinding);
  assert.deepEqual(source.inputBinding, inputBinding);
  assert.equal(Object.isFrozen(source), true);
});

test("material reuse does not cross input, root, event, Head or Base bindings", async (t) => {
  const setup = await fixture(t);
  const input = pullRequestBinding();
  const service = fakeService(preparationFor(input));
  service.inspectConflict = async (request) => {
    service.calls.inspect.push(request);
    return preparationFor(pullRequestBinding({ gitTarget: request.gitTarget }));
  };
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });
  await bundle.preparer.prepare(input);
  for (const change of [
    { inputRevision: 4 }, { rootItemId: "another-root" }, { eventId: "another-event" },
    { gitTarget: { headRefOid: "b".repeat(40) } },
    { gitTarget: { baseRefOid: "c".repeat(40) } },
  ]) await bundle.preparer.prepare(pullRequestBinding(change));
  assert.equal(service.calls.inspect.length, 6);
  assert.equal(service.calls.verify.length, 6);
});

for (const failure of ["throw", "mismatch"]) {
  test(`cached material verification ${failure} rejects without rebuilding and evicts the binding`, async (t) => {
    const setup = await fixture(t);
    const input = pullRequestBinding();
    const service = fakeService(preparationFor(input));
    let broken = false;
    service.verifyConflictPreparation = async ({ binding }) => {
      if (broken && failure === "throw") throw Object.assign(new Error("damaged evidence"), {
        code: "CONTROLLED_GIT_PREPARATION_TAMPERED",
      });
      return broken ? { ...binding, evidenceDigest: "f".repeat(64) } : structuredClone(binding);
    };
    const bundle = await createControlledGitRuntimeBundle(setup.config, {
      controlledGitServiceFactory: () => service,
    });
    await bundle.preparer.prepare(input);
    broken = true;
    await assert.rejects(bundle.preparer.prepare(input), { code: failure === "throw"
      ? "CONTROLLED_GIT_PREPARATION_TAMPERED" : "CONFLICT_PREPARATION_VERIFICATION_MISMATCH" });
    assert.equal(service.calls.inspect.length, 1);
    broken = false;
    await bundle.preparer.prepare(input);
    assert.equal(service.calls.inspect.length, 2);
  });
}

test("cached material still fences input changes during asynchronous verification", async (t) => {
  const setup = await fixture(t);
  const input = pullRequestBinding();
  const service = fakeService(preparationFor(input));
  let started, release, blocked = false;
  const verifying = new Promise(resolve => { started = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  service.verifyConflictPreparation = async ({ binding }) => {
    if (blocked) {
      started();
      await resume;
    }
    return binding;
  };
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });
  await bundle.preparer.prepare(input);
  blocked = true;
  const pending = bundle.preparer.prepare(input);
  await verifying;
  input.headRevision += 1;
  release();
  await assert.rejects(pending, { code: "CONFLICT_PREPARATION_INPUT_CHANGED" });
  assert.equal(service.calls.inspect.length, 1);
});

test("sealed material reuse is bounded and cold after runtime restart", async (t) => {
  const setup = await fixture(t);
  const input = pullRequestBinding();
  const service = fakeService(preparationFor(input));
  const createBundle = () => createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });
  const bundle = await createBundle();
  for (let inputRevision = 1; inputRevision <= 33; inputRevision += 1) {
    await bundle.preparer.prepare(pullRequestBinding({ inputRevision }));
  }
  await bundle.preparer.prepare(pullRequestBinding({ inputRevision: 1 }));
  assert.equal(service.calls.inspect.length, 34);
  const restarted = await createBundle();
  await restarted.preparer.prepare(pullRequestBinding({ inputRevision: 1 }));
  assert.equal(service.calls.inspect.length, 35);
});

test("preparer rejects v1, unknown mirrors and clean results without fallback", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const service = fakeService(preparationFor(inputBinding));
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });
  const legacyBinding = { ...inputBinding, schemaVersion: 1 };
  delete legacyBinding.gitTarget;

  await assert.rejects(
    bundle.preparer.prepare(legacyBinding),
    (error) => error?.code === "INVALID_CONFLICT_PREPARATION_INPUT",
  );
  const unknownHead = pullRequestBinding({
    gitTarget: { headRepository: "unknown/dashboard" },
  });
  await assert.rejects(
    bundle.preparer.prepare(unknownHead),
    (error) => error?.code === "CONTROLLED_GIT_MIRROR_NOT_CONFIGURED",
  );
  assert.equal(service.calls.inspect.length, 0);

  const cleanService = fakeService(preparationFor(inputBinding, {
    status: "clean",
    conflicts: [],
  }));
  const cleanBundle = await createControlledGitRuntimeBundle(
    {
      ...setup.config,
      preparationRoot: path.join(setup.root, "clean-preparations"),
    },
    { controlledGitServiceFactory: () => cleanService },
  );
  await assert.rejects(
    cleanBundle.preparer.prepare(inputBinding),
    (error) => error?.code === "CONFLICT_PREPARATION_NOT_CONFLICTED",
  );
  assert.equal(cleanService.calls.verify.length, 0);
});

test("preparer fences input mutation across asynchronous inspection", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  let release;
  let inspected;
  const inspectionStarted = new Promise((resolve) => {
    inspected = resolve;
  });
  const service = fakeService(preparationFor(inputBinding));
  service.inspectConflict = async (request) => {
    service.calls.inspect.push(structuredClone(request));
    inspected();
    await new Promise((resolve) => {
      release = resolve;
    });
    return preparationFor(inputBinding);
  };
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });

  const preparing = bundle.preparer.prepare(inputBinding);
  await inspectionStarted;
  inputBinding.headRevision += 1;
  release();

  await assert.rejects(
    preparing,
    (error) => error?.code === "CONFLICT_PREPARATION_INPUT_CHANGED",
  );
  assert.equal(service.calls.verify.length, 0);
});

test("preparer rejects sealed verification mismatches", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const service = fakeService(preparationFor(inputBinding));
  service.verifyConflictPreparation = async (request) => ({
    ...structuredClone(request.binding),
    evidenceDigest: "f".repeat(64),
  });
  const bundle = await createControlledGitRuntimeBundle(setup.config, {
    controlledGitServiceFactory: () => service,
  });

  await assert.rejects(
    bundle.preparer.prepare(inputBinding),
    (error) =>
      error?.code === "CONFLICT_PREPARATION_VERIFICATION_MISMATCH",
  );
});
