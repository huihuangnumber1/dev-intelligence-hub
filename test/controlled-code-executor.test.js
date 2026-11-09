import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerSandboxError } from "../src/adapters/docker-test-sandbox.js";
import { WindowsFixedTestRunner, WindowsTestRunnerError } from "../src/adapters/windows-fixed-test-runner.js";
import { ConfiguredTestRunner } from "../src/adapters/configured-test-runner.js";
import { SettledVerificationRecoveryReader } from '../src/adapters/settled-verification-recovery-reader.js';
import { readonlyVerificationFixture } from './support/readonly-verification-fixture.js';
import { pullRequestExternalActionBinding } from './support/pull-request-external-action-fixture.js';
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { preparationSignal, throwIfPreparationAborted } from "../src/lib/preparation-cancellation.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeExecutionJournal } from "../src/services/code-execution-journal.js";
import {
  ControlledCodeExecutor,
  ControlledCodeExecutorError,
} from "../src/services/controlled-code-executor.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { startApplicationBackgroundWork } from "../src/server.js";

const profileImage =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const profileDefinitions = {
  "node-tests": {
    kind: "node-test",
    image: profileImage,
    timeoutMs: 30_000,
  },
};
const passedTap = [
  "TAP version 13",
  "ok 1 - runs a real assertion",
  "1..1",
  "# tests 1",
  "# suites 0",
  "# pass 1",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 5",
].join("\n");

function tapSummary({ tests, pass, fail = 0, cancelled = 0, skipped = 0, todo = 0 }) {
  return [
    "TAP version 13",
    `1..${tests}`,
    `# tests ${tests}`,
    "# suites 0",
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    "# duration_ms 5",
  ].join("\n");
}

class FakeSandbox {
  constructor({
    results = [],
    cleanupResults = [],
    profiles = profileDefinitions,
  } = {}) {
    this.results = [...results];
    this.cleanupResults = [...cleanupResults];
    this.profiles = profiles;
    this.calls = [];
    this.cleanupCalls = [];
  }

  getProfileFingerprint(profileId) {
    const profile = this.profiles[profileId];
    if (!profile) return null;
    return digestValue(profile);
  }

  async run(request) {
    this.calls.push(request);
    const next = this.results.shift() ?? sandboxResult();
    if (typeof next === "function") return next(request);
    if (next instanceof Error) throw next;
    return next;
  }

  async cleanup(request) {
    this.cleanupCalls.push(request);
    const next = this.cleanupResults.shift();
    if (typeof next === "function") return next(request);
    if (next instanceof Error) throw next;
    return next;
  }
}

class FailingStore {
  constructor(inner) {
    this.inner = inner;
    this.failNextWrite = false;
  }

  read(...args) {
    return this.inner.read(...args);
  }

  write(...args) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("state unavailable");
    }
    return this.inner.write(...args);
  }
}

class RecordingJournal {
  constructor(inner) {
    this.inner = inner;
    this.writeCalls = [];
  }

  readJson(...args) {
    return this.inner.readJson(...args);
  }

  writeJson(request) {
    this.writeCalls.push(request);
    return this.inner.writeJson(request);
  }
}

class FailingJournal extends RecordingJournal {
  constructor(inner, failingKind) {
    super(inner);
    this.failingKind = failingKind;
    this.failed = false;
  }

  writeJson(request) {
    if (this.failingKind && !this.failed && request.kind === this.failingKind) {
      this.failed = true;
      throw new Error("journal unavailable");
    }
    return super.writeJson(request);
  }
}

function sandboxResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: passedTap,
    stderr: "",
    durationMs: 5,
    imageId: `sha256:${"a".repeat(64)}`,
    profileFingerprint: digestValue(profileDefinitions["node-tests"]),
    timedOut: false,
    ...overrides,
  };
}

function windowsProfileResult(profile, request, overrides = {}) {
  const { imageId: _image, ...result } = sandboxResult();
  return { ...result, profileFingerprint: digestValue(profile), workspaceRevision: request.workspaceRevision,
    assetVersion: profile.asset.version, verificationKind: profile.kind === "windows-test" ? "test" : "build",
    runtimeIdentity: { schemaVersion: 1, kind: "windows-process", executionId: request.executionId,
      actionId: request.actionId, pid: 4321, processStartTimeUtcTicks: String(639013000000000000n), executableSha256: profile.nodeSha256 }, ...overrides };
}

test("Windows test proofs complete, survive restart, and retain native identity without image IDs", async (t) => {
  const profile = { kind: "windows-test", nodeExecutable: "C:/Program Files/nodejs/node.exe", nodeSha256: "d".repeat(64), timeoutMs: 30_000,
    asset: { schemaVersion: 1, title: "Native", description: "Fixed assertions", version: 2, source: "fixed" } };
  const profiles = { "node-tests": profile };
  const sandbox = new FakeSandbox({ profiles, results: [(request) => windowsProfileResult(profile, request)] });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor({ profiles });
  await executor.recover();
  const session = await executor.start(startRequest());
  const tested = await executor.perform(actionRequest(session, { type: "run_profile", actionId: "native-test", profileId: "node-tests" }));
  assert.equal((await setup.innerStore.read("code-executor-state")).schemaVersion, 3);
  assert.equal(tested.action.status, "succeeded");
  assert.equal(tested.result.testSummary.passed, 1);
  assert.equal(Object.hasOwn(tested.result, "imageId"), false);
  const completed = await executor.perform(actionRequest(session, { type: "complete", actionId: "complete-native" }));
  assert.equal(completed.session.status, "completed");
  const restarted = setup.createExecutor({ profiles }).executor;
  await restarted.recover();
  const changeSet = await restarted.exportCompletedChangeSet({ sessionId: session.id, completedActionId: "complete-native", expectedWorkspaceRevision: session.workspaceRevision });
  assert.equal(changeSet.passedProfiles[0].runtimeIdentity.pid, 4321);
  assert.equal(changeSet.passedProfiles[0].assetVersion, 2);
  const state = await setup.innerStore.read("code-executor-state");
  state.sessions[session.id].verifiedProfiles["node-tests"].runtimeIdentity.pid += 1;
  await setup.innerStore.write("code-executor-state", state);
  await assert.rejects(setup.createExecutor({ profiles }).executor.recover(), { code: "EXECUTOR_STATE_INVALID" });
});

test("Windows build proof remains distinct from unit test statistics", async (t) => {
  const profile = { kind: "windows-build", nodeExecutable: "C:/node.exe", nodeSha256: "d".repeat(64), timeoutMs: 30_000,
    asset: { schemaVersion: 1, title: "Build", description: "Fixed compilation", version: 1, source: "fixed" } };
  const profiles = { "node-tests": profile };
  const sandbox = new FakeSandbox({ profiles, results: [(request) => windowsProfileResult(profile, request, { stdout: "Compilation succeeded" })] });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor({ profiles });
  await executor.recover();
  const session = await executor.start(startRequest());
  const tested = await executor.perform(actionRequest(session, { type: "run_profile", actionId: "native-build", profileId: "node-tests" }));
  assert.equal(tested.action.status, "succeeded");
  assert.equal(tested.result.verificationKind, "build");
  assert.equal(Object.hasOwn(tested.result, "testSummary"), false);
});

for (const transientCleanupFailure of [false, true]) {
  test(`real Windows asset, broker, journal and executor produce a restartable completed proof (${transientCleanupFailure ? "transient cleanup failure" : "normal cleanup"})`, { skip: process.platform !== "win32" }, async (t) => {
    const setup = await fixture(t);
    await mkdir(path.join(setup.sourceRoot, "test"));
    await writeFile(path.join(setup.sourceRoot, "test", "value.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("product value",()=>assert.equal(2+2,4));');
    const profile = { kind: "windows-test", nodeExecutable: process.execPath,
      nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"), timeoutMs: 20_000,
      asset: { schemaVersion: 1, title: "Native integration", description: "Real assertions through the controlled executor", version: 1,
        source: 'import { spawnSync } from "node:child_process"; const r=spawnSync(process.execPath,["--test","--test-isolation=none","--test-reporter=tap","test/value.test.mjs"],{stdio:"inherit",env:process.env}); process.exitCode=r.status??1;' } };
    const profiles = { "node-tests": profile };
    const windowsRunner = new WindowsFixedTestRunner({ allowedWorkspaceRoot: setup.scratchRoot, runRoot: path.join(setup.root, "native-runs"), profiles });
    const cleanup = windowsRunner.cleanup.bind(windowsRunner);
    let cleanupCalls = 0, cleanupRequest;
    if (transientCleanupFailure) windowsRunner.cleanup = async request => {
      cleanupRequest = request;
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        const evidence = JSON.parse(await readFile(path.join(windowsRunner.executionDirectory(request.executionId, request.actionId), "result.json"), "utf8"));
        assert.equal(evidence.exitCode, 0);
        throw new WindowsTestRunnerError("SANDBOX_CLEANUP_FAILED", "Stopped profile cleanup is temporarily busy", { cleanupPending: true });
      }
      return cleanup(request);
    };
    const sandbox = new ConfiguredTestRunner({ windowsRunner, profiles });
    const { executor } = setup.createExecutor({ profiles, nextSandbox: sandbox });
    await executor.recover();
    const session = await executor.start(startRequest());
    try {
      const checked = await executor.perform(actionRequest(session, { type: "run_profile", actionId: "native-real-test", profileId: "node-tests" }));
      assert.equal(checked.action.status, "succeeded");
      assert.equal(checked.result.testSummary.passed, 1);
      const completed = await executor.perform(actionRequest(checked.session, { type: "complete", actionId: "native-real-complete" }));
      assert.equal(completed.session.status, "completed");
      const restarted = setup.createExecutor({ profiles, nextSandbox: sandbox }).executor;
      await restarted.recover();
      const exported = await restarted.exportCompletedChangeSet({ sessionId: session.id, completedActionId: "native-real-complete", expectedWorkspaceRevision: session.workspaceRevision });
      assert.equal(exported.passedProfiles[0].runtimeIdentity.executableSha256, profile.nodeSha256);
      if (transientCleanupFailure) assert.equal(cleanupCalls, 2);
    } finally {
      if (cleanupRequest) await cleanup(cleanupRequest);
    }
  });
}

test("Windows test proof rejects zero tests, mismatched workspace, and forged Docker identity", async (t) => {
  const profile = { kind: "windows-test", nodeExecutable: "C:/node.exe", nodeSha256: "d".repeat(64), timeoutMs: 30_000,
    asset: { schemaVersion: 1, title: "Native", description: "Fixed assertions", version: 1, source: "fixed" } };
  for (const [name, overrides, expectedCode] of [
    ["empty", { stdout: "compiled successfully" }, null],
    ["revision", { workspaceRevision: "e".repeat(64) }, "SANDBOX_RESULT_INVALID"],
    ["image", { imageId: `sha256:${"f".repeat(64)}` }, "SANDBOX_RESULT_INVALID"],
    ["asset", { assetVersion: 99 }, "SANDBOX_RESULT_INVALID"],
    ["kind", { verificationKind: "build" }, "SANDBOX_RESULT_INVALID"],
  ]) {
    const profiles = { "node-tests": profile };
    const sandbox = new FakeSandbox({ profiles, results: [(request) => windowsProfileResult(profile, request, overrides)] });
    const setup = await fixture(t, { sandbox });
    const { executor } = setup.createExecutor({ profiles });
    await executor.recover();
    const session = await executor.start(startRequest());
    const tested = await executor.perform(actionRequest(session, { type: "run_profile", actionId: `native-${name}`, profileId: "node-tests" }));
    assert.equal(tested.action.status, "failed");
    if (expectedCode) assert.equal(tested.action.error.code, expectedCode);
    const completion = await executor.perform(actionRequest(tested.session, { type: "complete", actionId: `complete-${name}` }));
    assert.equal(completion.result.error.code, "CHECKS_NOT_PASSED");
  }
});

test("schema v2 Docker completion proofs migrate without changing historical session evidence", async (t) => {
  const setup = await fixture(t);
  const { completed } = await createCompletedSessionWithRead(setup);
  const legacy = await setup.innerStore.read("code-executor-state");
  legacy.schemaVersion = 2;
  const originalSession = structuredClone(legacy.sessions[completed.session.id]);
  await setup.innerStore.write("code-executor-state", legacy);
  const restarted = setup.createExecutor().executor;
  await restarted.recover();
  const upgraded = await setup.innerStore.read("code-executor-state");
  assert.equal(upgraded.schemaVersion, 3);
  assert.deepEqual(upgraded.sessions[completed.session.id], originalSession);
  assert.equal(Object.hasOwn(upgraded.sessions[completed.session.id].verifiedProfiles["node-tests"], "runtimeIdentity"), false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function overrideBroker(broker, overrides) {
  return new Proxy(broker, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture(t, { sandbox = new FakeSandbox(), failingStore = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-code-executor-"));
  const sourceRoot = path.join(root, "source");
  const scratchRoot = path.join(root, "scratch");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, "src", "app.js"),
    "export const value = 1;\n",
  );
  const innerStore = new StateStore(path.join(root, "state"));
  const store = failingStore ? new FailingStore(innerStore) : innerStore;
  const journal = new CodeExecutionJournal({
    root: path.join(root, "execution-artifacts"),
  });
  let tick = 0;
  const clock = () =>
    new Date(Date.UTC(2026, 7, 1, 0, 0, tick++)).toISOString();
  const createBroker = () =>
    new CodeWorkspaceBroker({
      scratchRoot,
      workspaces: [
        {
          id: "dashboard",
          sourceRoot,
          writablePaths: ["src", "test"],
        },
      ],
    });
  const createExecutor = ({
    broker = createBroker(),
    nextSandbox = sandbox,
    nextJournal = journal,
    profiles = profileDefinitions,
    workspaceProfiles = { dashboard: ["node-tests"] },
    limits,
    nextClock = clock,
  } = {}) => ({
    broker,
    executor: new ControlledCodeExecutor({
      broker,
      sandbox: nextSandbox,
      store,
      journal: nextJournal,
      profileDefinitions: profiles,
      requiredProfilesByWorkspace: workspaceProfiles,
      clock: nextClock,
      ...(limits ? { limits } : {}),
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    sourceRoot,
    scratchRoot,
    store,
    innerStore,
    journal,
    sandbox,
    createBroker,
    createExecutor,
  };
}

function startRequest(overrides = {}) {
  return {
    sessionId: "session-one",
    workspaceId: "dashboard",
    requestedBy: { roleId: "pr-reviewer", workItemId: "repo#1" },
    inputBinding: null,
    ...overrides,
  };
}

function sessionRequest(sessionId, inputBinding = null) {
  return { sessionId, inputBinding };
}

function pullRequestBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "Example/Repository",
    pullRequestNumber: 17,
    rootItemId: "github:pr:Example/Repository#17",
    workKey: "pr:Example/Repository#17",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "a".repeat(40),
    eventId: "github-event-pr-17",
    eventDigest: "b".repeat(64),
    inputDigest: "c".repeat(64),
    ...overrides,
  };
}

function conflictExecutionSource() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "Example/Repository",
    baseRefName: "main",
    baseRefOid: "1".repeat(40),
    headRepository: "Contributor/Repository",
    headRefName: "fix/conflict",
    headRefOid: "a".repeat(40),
  };
  const inputBinding = pullRequestBinding({ schemaVersion: 2, gitTarget });
  return createConflictCodeExecutionSource({
    inputBinding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "2".repeat(64),
        status: "conflicted",
        baseCommitOid: gitTarget.baseRefOid,
        headCommitOid: gitTarget.headRefOid,
        mergeBaseOid: "3".repeat(40),
        resultTreeOid: "4".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "5".repeat(64),
        evidenceDigest: "6".repeat(64),
        resultObjectDigest: "7".repeat(64),
        materialization: "full-tree",
      },
      gitTarget,
    }),
  });
}

function actionRequest(session, action) {
  return {
    sessionId: session.id,
    action: {
      expectedWorkspaceRevision: session.workspaceRevision,
      ...action,
    },
  };
}

function cancellationRequest(session, overrides = {}) {
  return {
    sessionId: session.id,
    inputBinding: structuredClone(session.inputBinding),
    cancellationDigest: digestValue({
      kind: "cancel-code-session",
      sessionId: session.id,
    }),
    expectedWorkspaceRevision: session.workspaceRevision,
    expectedAction: null,
    ...overrides,
  };
}

function attemptExecutionIdFor(sessionId, number) {
  return `attempt-${digestValue({ number, sessionId }).slice(0, 24)}`;
}

function createDirectoryExecution(broker, request) {
  return broker.createExecution({ ...request, inputBinding: null });
}

function attemptFile(setup, sessionId, number, relativePath = "src/app.js") {
  return path.join(
    setup.scratchRoot,
    "dashboard",
    attemptExecutionIdFor(sessionId, number),
    ...relativePath.split("/"),
  );
}

function artifactFile(setup, reference) {
  return path.join(
    setup.root,
    "execution-artifacts",
    ...reference.path.split("/"),
  );
}

async function replaceArtifact(setup, reference, value) {
  const content = `${JSON.stringify(value)}\n`;
  await writeFile(artifactFile(setup, reference), content);
  reference.bytes = Buffer.byteLength(content);
  reference.sha256 = createHash("sha256").update(content).digest("hex");
}

async function createCompletedSessionWithRead(setup) {
  const first = setup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-completion",
      path: "src/app.js",
    }),
  );
  const failedCompletion = await first.executor.perform(
    actionRequest(read.session, {
      type: "complete",
      actionId: "complete-before-checks",
    }),
  );
  const checked = await first.executor.perform(
    actionRequest(failedCompletion.session, {
      type: "run_profile",
      actionId: "test-before-completion",
      profileId: "node-tests",
    }),
  );
  const completed = await first.executor.perform(
    actionRequest(checked.session, {
      type: "complete",
      actionId: "complete-after-checks",
    }),
  );
  assert.equal(completed.session.status, "completed");
  return { read, failedCompletion, completed };
}

test('terminal execution history does not exhaust active session capacity and its proof remains readable', async (t) => {
  const setup = await fixture(t);
  const { read, completed } = await createCompletedSessionWithRead(setup);
  const { executor } = setup.createExecutor({ limits: { maxSessions: 1 } });
  await executor.recover();
  const next = await executor.start(startRequest({ sessionId: 'session-two' }));
  assert.equal(next.status, 'active');
  const old = await executor.getActionResult({ sessionId: completed.session.id, actionId: read.action.id });
  assert.equal(old.action.id, read.action.id);
  assert.deepEqual(old.result, read.result);
  await assert.rejects(executor.start(startRequest({ sessionId: 'session-three' })), { code: 'SESSION_LIMIT' });
  assert.equal((await executor.start(startRequest({ sessionId: 'session-two' }))).id, next.id);
});

test('failed and cancelled sessions release capacity while interrupted sessions retain it', async (t) => {
  for (const status of ['failed', 'cancelled']) {
    const setup = await fixture(t);
    if (status === 'failed') {
      const broker = overrideBroker(setup.createBroker(), { async createExecution() { throw new Error('creation failed'); } });
      const { executor } = setup.createExecutor({ broker });
      await executor.recover();
      await assert.rejects(executor.start(startRequest()), { code: 'START_FAILED' });
    } else {
      const { executor } = setup.createExecutor();
      await executor.recover();
      const session = await executor.start(startRequest());
      await executor.reconcileCancellation(cancellationRequest(session));
    }
    const { executor } = setup.createExecutor({ limits: { maxSessions: 1 } });
    await executor.recover();
    assert.equal((await executor.start(startRequest({ sessionId: 'next' }))).status, 'active');
    const retained = await setup.innerStore.read('code-executor-state');
    assert.equal(retained.sessions['session-one'].status, status);
    const restarted = setup.createExecutor({ limits: { maxSessions: 1 } }).executor;
    await restarted.recover();
    assert.equal((await restarted.view({ sessionId: 'next' })).status, 'interrupted');
    await assert.rejects(restarted.start(startRequest({ sessionId: 'third' })), { code: 'SESSION_LIMIT' });
  }
});

test('concurrent new sessions cannot exceed active capacity', async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor({ limits: { maxSessions: 1 } });
  await executor.recover();
  const results = await Promise.allSettled(['a', 'b'].map(sessionId => executor.start(startRequest({ sessionId }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SESSION_LIMIT');
});

async function createCompletedSessionWithChanges(setup) {
  const first = setup.createExecutor();
  await first.executor.recover();
  const session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-changes",
      path: "src/app.js",
    }),
  );
  const modified = await first.executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "write-modified",
      path: "src/app.js",
      content: "export const value = 2;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  const created = await first.executor.perform(
    actionRequest(modified.session, {
      type: "write_text",
      actionId: "write-created",
      path: "test/new.js",
      content: "export const added = true;\n",
      expectedSha256: null,
    }),
  );
  const checked = await first.executor.perform(
    actionRequest(created.session, {
      type: "run_profile",
      actionId: "test-changes",
      profileId: "node-tests",
    }),
  );
  const completed = await first.executor.perform(
    actionRequest(checked.session, {
      type: "complete",
      actionId: "complete-changes",
    }),
  );
  return { completed, read };
}

function cleanupPendingError(message = "cleanup pending") {
  return new DockerSandboxError("SANDBOX_CLEANUP_FAILED", message, {
    details: { cleanupPending: true, containerName: "mydashboard-pending" },
  });
}

function hasCode(code) {
  return (error) =>
    error instanceof ControlledCodeExecutorError && error.code === code;
}

test("startup recovery gates creation and create is idempotent", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();

  await assert.rejects(executor.start(startRequest()), hasCode("EXECUTOR_NOT_READY"));
  await executor.recover();
  const created = await executor.start(startRequest());

  assert.equal(created.id, "session-one");
  assert.equal(created.status, "active");
  assert.equal(created.attempt.number, 1);
  assert.match(created.workspaceRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(created.requiredProfiles, ["node-tests"]);
  assert.equal(JSON.stringify(created).includes(setup.root), false);
  assert.deepEqual(await executor.start(startRequest()), created);
  await assert.rejects(
    executor.start(
      startRequest({
        requestedBy: { roleId: "developer", workItemId: "repo#1" },
      }),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
});

test("cancelled workspace preparation drains and remains resumable without losing confirmed writes", async t => {
  for (const phase of ["start", "resume"]) await t.test(phase, async t => {
    const setup = await fixture(t);
    let current = setup.createExecutor();
    await current.executor.recover();
    let prior = null;
    if (phase === "resume") {
      const initial = await current.executor.start(startRequest());
      const read = await current.executor.perform(actionRequest(initial, { type: "read_text", actionId: "cancel-read", path: "src/app.js" }));
      prior = (await current.executor.perform(actionRequest(read.session, { type: "write_text", actionId: "cancel-write", path: "src/app.js",
        content: "export const saved = true;\n", expectedSha256: read.result.sha256 }))).session;
      current = setup.createExecutor();
      await current.executor.recover();
    }
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const create = current.broker.createExecution.bind(current.broker);
    let received;
    current.broker.createExecution = async request => {
      received = preparationSignal();
      entered.resolve();
      await new Promise(resolve => {
        release.promise.then(resolve);
        if (received?.aborted) resolve();
        else received?.addEventListener("abort", resolve, { once: true });
      });
      throwIfPreparationAborted();
      return create(request);
    };
    const operation = phase === "start" ? current.executor.start(startRequest(), { signal: controller.signal }) :
      current.executor.resume(sessionRequest("session-one"), { signal: controller.signal });
    // Observe rejection immediately, including while asserting the plumbing.
    const settled = operation.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    try {
      assert.strictEqual(received, controller.signal);
      controller.abort(new Error("managed shutdown"));
    } finally { release.resolve(); }
    const outcome = await settled;
    assert.equal(outcome.error?.code, "CODE_PREPARATION_ABORTED");
    const interrupted = await current.executor.view({ sessionId: "session-one" });
    assert.equal(interrupted.status, "interrupted");
    if (prior) {
      assert.equal(interrupted.workspaceRevision, prior.workspaceRevision);
      assert.equal(interrupted.actions.find(action => action.id === "cancel-write").status, "succeeded");
    }
    assert.equal(current.broker.executions.size, 0, "the aborted owned attempt is disposed before returning");
    current.broker.createExecution = create;
    const resumed = await current.executor.resume(sessionRequest("session-one"));
    assert.equal(resumed.status, "active");
    const read = await current.executor.perform(actionRequest(resumed, { type: "read_text", actionId: "after-cancel", path: "src/app.js" }));
    assert.equal(read.result.content, prior ? "export const saved = true;\n" : "export const value = 1;\n");
  });
});

test("preparation abort never disguises persistence, cleanup or integrity failure as a safe interruption", async t => {
  for (const failure of ["persist", "cleanup", "integrity"]) await t.test(failure, async t => {
    const setup = await fixture(t, { failingStore: true });
    const current = setup.createExecutor(), controller = new AbortController();
    await current.executor.recover();
    const create = current.broker.createExecution.bind(current.broker);
    current.broker.createExecution = async request => {
      const result = await create(request);
      controller.abort();
      if (failure === "persist") setup.store.failNextWrite = true;
      if (failure === "cleanup") current.broker.discardExecution = async () => { throw new Error("scratch still locked"); };
      if (failure === "integrity") throw Object.assign(new Error("manifest was tampered"), { code: "GIT_SNAPSHOT_OBJECT_MISMATCH" });
      throwIfPreparationAborted();
      return result;
    };
    const outcome = await current.executor.start(startRequest(), { signal: controller.signal }).then(() => null, error => error);
    assert.ok(outcome);
    assert.notEqual(outcome.code, "CODE_PREPARATION_ABORTED");
    assert.notEqual((await current.executor.view({ sessionId: "session-one" })).status, "interrupted");
    if (failure !== "integrity") await assert.rejects(current.executor.resume(sessionRequest("session-one")), { code: "EXECUTION_FENCED" });
  });
});

test("resume cancellation stops the final workspace hash traversal instead of reading the remaining tree", async t => {
  const setup = await fixture(t);
  await writeFile(path.join(setup.sourceRoot, "src", "z-unneeded.js"), "must not be scanned after cancellation\n");
  const initial = setup.createExecutor(); await initial.executor.recover();
  await initial.executor.start(startRequest());
  const current = setup.createExecutor(); await current.executor.recover();
  const controller = new AbortController(), policy = current.broker.workspaces.get("dashboard").policy;
  const excluded = policy.isExcluded.bind(policy), revision = current.broker.getWorkspaceRevision.bind(current.broker);
  let hashing = false, unnecessary = 0;
  current.broker.getWorkspaceRevision = async request => { hashing = true; return revision(request); };
  policy.isExcluded = relative => {
    if (hashing && preparationSignal() === controller.signal) {
      if (relative === "src/app.js") controller.abort();
      if (controller.signal.aborted && relative === "src/z-unneeded.js") unnecessary++;
    }
    return excluded(relative);
  };
  await assert.rejects(current.executor.resume(sessionRequest("session-one"), { signal: controller.signal }), { code: "CODE_PREPARATION_ABORTED" });
  assert.equal(unnecessary, 0, "stop at a file boundary instead of hashing the remaining repository");
  assert.equal((await current.executor.view({ sessionId: "session-one" })).status, "interrupted");
  assert.equal(current.broker.executions.size, 0);
  const retried = await current.executor.resume(sessionRequest("session-one"));
  assert.equal(retried.status, "active");
});

test("background shutdown drains owned preparation and its scratch cleanup before completing", { timeout: 5_000 }, async t => {
  const setup = await fixture(t), current = setup.createExecutor();
  await current.executor.recover();
  const create = current.broker.createExecution.bind(current.broker), entered = deferred(), release = deferred();
  current.broker.createExecution = async request => {
    const result = await create(request), signal = preparationSignal();
    entered.resolve();
    await new Promise(resolve => { release.promise.then(resolve); signal?.addEventListener("abort", resolve, { once: true }); });
    throwIfPreparationAborted(); return result;
  };
  let launched = false;
  const background = startApplicationBackgroundWork({
    config: { refreshMinutes: 7, githubActions: { enabled: true, automaticOwnPrRepair: true } },
    refreshService: { refresh: async () => {} }, employeeRegistry: { schedules: () => [], runSelected: async () => {} },
    codeJobExecution: { async runCycle({ signal }, runOperation) {
      if (!launched) {
        launched = true;
        runOperation(async () => {
          try { return await current.executor.start(startRequest(), { signal }); }
          catch (error) { signal.throwIfAborted(); throw error; }
        }).catch(() => {});
      }
      return { scheduled: 1 };
    } },
  }, { setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {}, reportError() {} });
  try {
    await background.initialRefresh; await entered.promise;
    assert.equal(current.broker.executions.size, 1);
    await background.stop();
    assert.equal(current.broker.executions.size, 0);
    assert.equal((await current.executor.view({ sessionId: "session-one" })).status, "interrupted");
    assert.equal(background.drainStatus().activeTaskCount, 0);
  } finally { release.resolve(); await background.stop(); }
});

test("start persists the exact PR input binding and requires the broker to echo it", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const creationRequests = [];
  const broker = overrideBroker(baseBroker, {
    createExecution: async (request) => {
      creationRequests.push(structuredClone(request));
      const created = await createDirectoryExecution(baseBroker, request);
      return {
        ...created,
        inputBinding: structuredClone(request.inputBinding),
      };
    },
  });
  const { executor } = setup.createExecutor({ broker });
  const inputBinding = pullRequestBinding();
  await executor.recover();

  const created = await executor.start(startRequest({ inputBinding }));

  assert.deepEqual(created.inputBinding, inputBinding);
  assert.deepEqual(creationRequests, [
    {
      workspaceId: "dashboard",
      executionId: attemptExecutionIdFor("session-one", 1),
      inputBinding,
    },
  ]);
  const stored = await setup.innerStore.read("code-executor-state");
  assert.equal(stored.schemaVersion, 3);
  assert.deepEqual(stored.sessions[created.id].inputBinding, inputBinding);
  assert.equal(
    stored.sessions[created.id].requestDigest,
    digestValue({
      workspaceId: "dashboard",
      requestedBy: startRequest().requestedBy,
      inputBinding,
      requiredProfiles: stored.sessions[created.id].requiredProfiles,
    }),
  );
  assert.deepEqual(await executor.view({ sessionId: created.id }), created);
  await assert.rejects(
    executor.view(sessionRequest(created.id, inputBinding)),
    hasCode("INVALID_EXECUTION_REQUEST"),
  );
  assert.deepEqual(await executor.start(startRequest({ inputBinding })), created);
  await assert.rejects(
    executor.start(
      startRequest({
        inputBinding: pullRequestBinding({
          headRevision: 2,
          headRefOid: "d".repeat(40),
        }),
      }),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(creationRequests.length, 1);
});

test("start seals and forwards one conflict execution source in the durable session", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const creationRequests = [];
  const broker = overrideBroker(baseBroker, {
    createExecution: async (request) => {
      creationRequests.push(structuredClone(request));
      const created = await baseBroker.createExecution({
        workspaceId: request.workspaceId,
        executionId: request.executionId,
        inputBinding: null,
      });
      return {
        ...created,
        inputBinding: structuredClone(request.inputBinding),
        executionSource: structuredClone(request.executionSource),
      };
    },
  });
  const { executor } = setup.createExecutor({ broker });
  const executionSource = conflictExecutionSource();
  const inputBinding = executionSource.inputBinding;
  await executor.recover();

  const created = await executor.start(
    startRequest({ inputBinding, executionSource }),
  );

  assert.deepEqual(created.executionSource, executionSource);
  assert.deepEqual(creationRequests, [{
    workspaceId: "dashboard",
    executionId: attemptExecutionIdFor("session-one", 1),
    inputBinding,
    executionSource,
  }]);
  const stored = await setup.innerStore.read("code-executor-state");
  assert.deepEqual(
    stored.sessions[created.id].executionSource,
    executionSource,
  );
  assert.equal(
    stored.sessions[created.id].requestDigest,
    digestValue({
      workspaceId: "dashboard",
      requestedBy: startRequest().requestedBy,
      inputBinding,
      executionSource,
      requiredProfiles: stored.sessions[created.id].requiredProfiles,
    }),
  );
  await assert.rejects(
    executor.start(startRequest({ inputBinding })),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(creationRequests.length, 1);
});

test("non-null PR input bindings fail closed when the broker omits its echo", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const broker = overrideBroker(baseBroker, {
    createExecution: (request) => createDirectoryExecution(baseBroker, request),
  });
  const { executor } = setup.createExecutor({ broker });
  await executor.recover();

  await assert.rejects(
    executor.start(startRequest({ inputBinding: pullRequestBinding() })),
    hasCode("START_FAILED"),
  );
  const stored = await setup.innerStore.read("code-executor-state");
  assert.equal(stored.sessions["session-one"].status, "failed");
  assert.deepEqual(
    stored.sessions["session-one"].inputBinding,
    pullRequestBinding(),
  );
  await assert.rejects(
    access(attemptFile(setup, "session-one", 1)),
    (error) => error?.code === "ENOENT",
  );
});

test("persisted PR input bindings remain sealed by the session request digest", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const initial = setup.createExecutor({
    broker: overrideBroker(baseBroker, {
      createExecution: async (request) => ({
        ...(await createDirectoryExecution(baseBroker, request)),
        inputBinding: structuredClone(request.inputBinding),
      }),
    }),
  });
  await initial.executor.recover();
  const active = await initial.executor.start(
    startRequest({ inputBinding: pullRequestBinding() }),
  );
  const tampered = await setup.innerStore.read("code-executor-state");
  tampered.sessions[active.id].inputBinding = pullRequestBinding({
    headRevision: 2,
    headRefOid: "d".repeat(40),
  });
  await setup.innerStore.write("code-executor-state", tampered);

  const recovered = setup.createExecutor();
  await assert.rejects(
    recovered.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
});

test("resume rejects a changed PR binding before effects and forwards the persisted binding", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const initialBroker = setup.createBroker();
  const initial = setup.createExecutor({
    broker: overrideBroker(initialBroker, {
      createExecution: async (request) => ({
        ...(await createDirectoryExecution(initialBroker, request)),
        inputBinding: structuredClone(request.inputBinding),
      }),
    }),
  });
  await initial.executor.recover();
  const active = await initial.executor.start(startRequest({ inputBinding }));

  const recoverySandbox = new FakeSandbox();
  const resumeRequests = [];
  const resumeBaseBroker = setup.createBroker();
  const recovered = setup.createExecutor({
    nextSandbox: recoverySandbox,
    broker: overrideBroker(resumeBaseBroker, {
      createExecution: async (request) => {
        resumeRequests.push(structuredClone(request));
        return {
          ...(await createDirectoryExecution(resumeBaseBroker, request)),
          inputBinding: structuredClone(request.inputBinding),
        };
      },
    }),
  });
  await recovered.executor.recover();
  const cleanupCallsBeforeMismatch = recoverySandbox.cleanupCalls.length;

  await assert.rejects(
    recovered.executor.resume(
      sessionRequest(
        active.id,
        pullRequestBinding({ headRevision: 2, headRefOid: "d".repeat(40) }),
      ),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(resumeRequests.length, 0);
  assert.equal(recoverySandbox.cleanupCalls.length, cleanupCallsBeforeMismatch);

  const resumed = await recovered.executor.resume(
    sessionRequest(active.id, inputBinding),
  );
  assert.deepEqual(resumed.inputBinding, inputBinding);
  assert.deepEqual(resumeRequests, [
    {
      workspaceId: "dashboard",
      executionId: attemptExecutionIdFor(active.id, 2),
      inputBinding,
    },
  ]);
});

test("schema v1 sessions migrate to null binding and cannot be claimed by a PR", async (t) => {
  const setup = await fixture(t);
  const initial = setup.createExecutor();
  await initial.executor.recover();
  const active = await initial.executor.start(startRequest());
  const legacy = await setup.innerStore.read("code-executor-state");
  const legacySession = legacy.sessions[active.id];
  legacy.schemaVersion = 1;
  delete legacySession.inputBinding;
  delete legacySession.cancellation;
  legacySession.requestDigest = digestValue({
    workspaceId: legacySession.workspaceId,
    requestedBy: legacySession.requestedBy,
    requiredProfiles: legacySession.requiredProfiles,
  });
  await setup.innerStore.write("code-executor-state", legacy);

  const creationRequests = [];
  const baseBroker = setup.createBroker();
  const recovered = setup.createExecutor({
    broker: overrideBroker(baseBroker, {
      createExecution: async (request) => {
        creationRequests.push(structuredClone(request));
        return baseBroker.createExecution(request);
      },
    }),
  });
  await recovered.executor.recover();

  const migrated = await recovered.executor.view({ sessionId: active.id });
  assert.equal(migrated.status, "interrupted");
  assert.equal(migrated.inputBinding, null);
  const migratedState = await setup.innerStore.read("code-executor-state");
  assert.equal(migratedState.schemaVersion, 3);
  assert.equal(migratedState.sessions[active.id].inputBinding, null);
  assert.equal(
    migratedState.sessions[active.id].requestDigest,
    digestValue({
      workspaceId: legacySession.workspaceId,
      requestedBy: legacySession.requestedBy,
      inputBinding: null,
      requiredProfiles: legacySession.requiredProfiles,
    }),
  );
  assert.deepEqual(await recovered.executor.start(startRequest()), migrated);
  await assert.rejects(
    recovered.executor.start(
      startRequest({ inputBinding: pullRequestBinding() }),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    recovered.executor.resume(
      sessionRequest(active.id, pullRequestBinding()),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(creationRequests.length, 0);

  const resumed = await recovered.executor.resume(sessionRequest(active.id));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.inputBinding, null);
  assert.equal(creationRequests.length, 1);
  assert.equal(creationRequests[0].inputBinding, null);
});

test("schema v1 migration is durably persisted even without recovery mutations", async (t) => {
  const setup = await fixture(t);
  await setup.innerStore.write("code-executor-state", {
    schemaVersion: 1,
    revision: 7,
    sessions: {},
  });
  const recovered = setup.createExecutor();

  await recovered.executor.recover();

  const stored = await setup.innerStore.read("code-executor-state");
  assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.revision, 8);
  assert.deepEqual(stored.sessions, {});
});

test("schema v1 migration rejects a legacy identity whose digest no longer matches", async (t) => {
  const setup = await fixture(t);
  const initial = setup.createExecutor();
  await initial.executor.recover();
  const active = await initial.executor.start(startRequest());
  const legacy = await setup.innerStore.read("code-executor-state");
  const legacySession = legacy.sessions[active.id];
  legacy.schemaVersion = 1;
  delete legacySession.inputBinding;
  legacySession.requestDigest = digestValue({
    workspaceId: legacySession.workspaceId,
    requestedBy: legacySession.requestedBy,
    requiredProfiles: legacySession.requiredProfiles,
  });
  legacySession.requestedBy.workItemId = "repo#tampered";
  await setup.innerStore.write("code-executor-state", legacy);
  const recovered = setup.createExecutor();

  await assert.rejects(
    recovered.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
});

test('settled verification reader validates real executor projections and immutable action artifacts after restart', async t => {
  const sandbox = new FakeSandbox({ results: [new WindowsTestRunnerError('SANDBOX_START_FAILED', 'Windows test preparation was interrupted')] });
  const setup = await fixture(t, { sandbox });
  const { job } = readonlyVerificationFixture({ binding: pullRequestExternalActionBinding(), workspaceId: 'dashboard',
    requiredProfile: { id: 'node-tests', configDigest: sandbox.getProfileFingerprint('node-tests') } });
  const createBoundBroker = () => new CodeWorkspaceBroker({ scratchRoot: setup.scratchRoot,
    workspaces: [{ id: 'dashboard', sourceRoot: setup.sourceRoot, writablePaths: ['src'], gitBoundaryDigest: 'f'.repeat(64),
      gitExecutableIdentity: { gitCommand: path.join(setup.root, 'git.exe'), gitExecutableSha256: 'e'.repeat(64),
        gitExecutableBytes: 1, gitExecutableMode: 0o755, gitExecutableUid: 0, gitExecutableGid: 0 } }],
    gitSnapshotter: { async materialize({ targetRoot, headOid }) {
      const content = await readFile(path.join(setup.sourceRoot, 'src/app.js'));
      await mkdir(path.join(targetRoot, 'src'), { recursive: true });
      await writeFile(path.join(targetRoot, 'src/app.js'), content);
      return { headOid, fileCount: 1, totalBytes: content.length, modes: new Map([['src/app.js', '100644']]),
        baseline: new Map([['src/app.js', createHash('sha256').update(content).digest('hex')]]) };
    } } });
  const { executor } = setup.createExecutor({ broker: createBoundBroker() });
  await executor.recover();
  let session = await executor.start(startRequest({ sessionId: job.jobId, requestedBy: job.requestedBy, inputBinding: job.inputBinding }));
  session = (await executor.perform(actionRequest(session, { type: 'read_text', actionId: 'read-before-profile', path: 'src/app.js' }))).session;
  const failed = await executor.perform(actionRequest(session, { type: 'run_profile', actionId: 'interrupted-profile', profileId: 'node-tests' }));
  assert.equal(failed.action.status, 'failed');
  assert.equal(failed.result.error.code, 'SANDBOX_START_FAILED');
  const restarted = setup.createExecutor({ broker: createBoundBroker() }).executor;
  await restarted.recover();
  const reader = new SettledVerificationRecoveryReader({ executor: restarted,
    artifacts: { read: ref => setup.journal.readBytes(ref) },
    sandbox: { async readSettledPreparationFailure(request) { return { ...request,
      profileConfigDigest: sandbox.getProfileFingerprint(request.profileId), reason: 'preparation_interrupted_cleanup_confirmed' }; } } });
  const proof = await reader.read({ jobId: job.jobId, job });
  assert.equal(proof?.jobId, job.jobId);
  assert.equal(proof.workspaceRevision, failed.session.workspaceRevision);
  assert.equal(proof.actionId, failed.action.id);
  assert.equal(sandbox.calls.length, 1, 'reading recovery evidence never re-executes the failed profile');
  await writeFile(path.join(setup.root, 'execution-artifacts', job.jobId, failed.action.id, 'input.json'), '{}');
  assert.equal(await reader.read({ jobId: job.jobId, job }), null, 'audit tampering invalidates recovery');
});

test("only a trusted Windows prelaunch abort preserves unexecuted proof in the executor receipt", async t => {
  for (const trusted of [true, false]) await t.test(String(trusted), async t => {
    const details = { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false };
    const error = trusted
      ? new WindowsTestRunnerError("SANDBOX_ABORTED", "Windows fixed test was cancelled before launch", details)
      : new DockerSandboxError("SANDBOX_ABORTED", "Other runner was interrupted", details);
    const setup = await fixture(t, { sandbox: new FakeSandbox({ results: [error] }) });
    const { executor } = setup.createExecutor();
    await executor.recover();
    const session = await executor.start(startRequest());
    const response = await executor.perform(actionRequest(session, { type: "run_profile", actionId: "unstarted-test", profileId: "node-tests" }));
    assert.equal(response.action.status, "failed");
    assert.equal(response.session.status, "active");
    assert.equal(response.result.exitCode ?? null, null);
    assert.equal(response.result.error.details?.notExecuted, trusted ? true : undefined);
    assert.equal(response.result.error.details?.origin, trusted ? "windows_fixed_prelaunch" : undefined);
    const restarted = setup.createExecutor().executor;
    await restarted.recover();
    assert.deepEqual((await restarted.getActionResult({ sessionId: session.id, actionId: response.action.id })).result, response.result);
    if (trusted) {
      const valid = await setup.innerStore.read("code-executor-state");
      for (const variant of ["wrong-source", "cleanup", "false-proof", "extra-field", "write-action", "changed-workspace"]) {
        const changed = structuredClone(valid), stored = changed.sessions[session.id].actions.at(-1);
        if (variant === "wrong-source") stored.error.details.origin = "other";
        if (variant === "cleanup") stored.error.details.cleanupPending = true;
        if (variant === "false-proof") stored.error.details.notExecuted = false;
        if (variant === "extra-field") stored.error.details.extra = true;
        if (variant === "write-action") stored.type = "write_text";
        if (variant === "changed-workspace") stored.workspaceRevisionAfter = "f".repeat(64);
        await setup.innerStore.write("code-executor-state", changed);
        await assert.rejects(setup.createExecutor().executor.recover(), error => error.code === "EXECUTOR_STATE_INVALID", variant);
      }
    }
  });
});

test("writes, tests, and completion stay bound to an exact workspace revision", async (t) => {
  const sandbox = new FakeSandbox({
    results: [
      sandboxResult(),
      sandboxResult({ exitCode: 1, stdout: "", stderr: "assertion failed" }),
      sandboxResult(),
    ],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await executor.recover();
  let session = await executor.start(startRequest());

  const read = await executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-one",
      path: "src/app.js",
    }),
  );
  assert.equal(read.result.content, "export const value = 1;\n");
  assert.deepEqual(
    await executor.perform(
      actionRequest(session, {
        type: "read_text",
        actionId: "read-one",
        path: "src/app.js",
      }),
    ),
    read,
  );

  const firstWrite = await executor.perform(
    actionRequest(session, {
      type: "write_text",
      actionId: "write-one",
      path: "src/app.js",
      content: "export const value = 2;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  session = firstWrite.session;
  assert.equal(firstWrite.action.status, "succeeded");
  assert.notEqual(session.workspaceRevision, read.session.workspaceRevision);

  const firstCheck = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-one",
      profileId: "node-tests",
    }),
  );
  session = firstCheck.session;
  assert.equal(firstCheck.action.status, "succeeded");
  assert.equal(sandbox.calls[0].workspacePath.startsWith(setup.scratchRoot), true);
  assert.equal("command" in sandbox.calls[0], false);

  const secondWrite = await executor.perform(
    actionRequest(session, {
      type: "write_text",
      actionId: "write-two",
      path: "src/app.js",
      content: "export const value = 3;\n",
      expectedSha256: firstWrite.result.sha256,
    }),
  );
  session = secondWrite.session;
  const staleCompletion = await executor.perform(
    actionRequest(session, {
      type: "complete",
      actionId: "complete-stale",
    }),
  );
  assert.equal(staleCompletion.action.status, "failed");
  assert.equal(staleCompletion.result.error.code, "CHECKS_NOT_PASSED");
  assert.equal(staleCompletion.session.status, "active");

  const failedCheck = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-failed",
      profileId: "node-tests",
    }),
  );
  assert.equal(failedCheck.action.status, "failed");
  assert.equal(failedCheck.result.error.code, "TESTS_FAILED");
  assert.equal(failedCheck.result.stderr, "assertion failed");
  assert.equal(failedCheck.session.status, "active");

  const passedCheck = await executor.perform(
    actionRequest(failedCheck.session, {
      type: "run_profile",
      actionId: "test-fixed",
      profileId: "node-tests",
    }),
  );
  const completed = await executor.perform(
    actionRequest(passedCheck.session, {
      type: "complete",
      actionId: "complete-one",
    }),
  );
  assert.equal(completed.action.status, "succeeded");
  assert.equal(completed.session.status, "completed");
  assert.deepEqual(
    completed.result.modified.map((entry) => entry.path),
    ["src/app.js"],
  );
  assert.equal(
    await readFile(path.join(setup.sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("node-test proof requires an actual passing test in a complete TAP report", async (t) => {
  const cases = [
    { name: "zero tests", stdout: tapSummary({ tests: 0, pass: 0 }), passed: false, executed: 0 },
    { name: "all skipped", stdout: tapSummary({ tests: 2, pass: 0, skipped: 2 }), passed: false, executed: 0 },
    { name: "all todo", stdout: tapSummary({ tests: 1, pass: 0, todo: 1 }), passed: false, executed: 0 },
    { name: "missing summary", stdout: "TAP version 13\nok 1 - incomplete", passed: false },
    { name: "truncated summary", stdout: "TAP version 13\nok 1 - incomplete\n1..1\n# tests 1\n# pass 1", passed: false },
    { name: "one pass", stdout: passedTap, passed: true, executed: 1 },
    { name: "nested passes", stdout: "TAP version 13\n    ok 1 - nested\n    1..1\nok 1 - suite\n1..1\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0", passed: true, executed: 2 },
    { name: "one failure", stdout: tapSummary({ tests: 2, pass: 1, fail: 1 }), passed: false, executed: 2 },
  ];
  for (const entry of cases) {
    const sandbox = new FakeSandbox({
      results: [sandboxResult({ stdout: entry.stdout, stderr: "diagnostic output" })],
    });
    const setup = await fixture(t, { sandbox });
    const { executor } = setup.createExecutor();
    await executor.recover();
    const session = await executor.start(startRequest());
    const checked = await executor.perform(actionRequest(session, {
      type: "run_profile",
      actionId: "run-tests",
      profileId: "node-tests",
    }));
    assert.equal(checked.action.status, entry.passed ? "succeeded" : "failed", entry.name);
    if (entry.passed) {
      assert.equal(checked.result.testSummary.executed, entry.executed);
      const state = await setup.innerStore.read("code-executor-state");
      const auditedAction = state.sessions[session.id].actions.find((action) => action.id === "run-tests");
      const output = await setup.journal.readJson(auditedAction.outputArtifacts.output);
      assert.equal(output.testSummary.executed, entry.executed);
      const completed = await executor.perform(actionRequest(checked.session, {
        type: "complete",
        actionId: "complete-tests",
      }));
      assert.equal(completed.action.status, "succeeded", entry.name);
    } else {
      assert.equal(checked.result.error.code, "TESTS_FAILED", entry.name);
      if (entry.executed !== undefined) {
        assert.equal(checked.result.testSummary.executed, entry.executed);
      }
      const completion = await executor.perform(actionRequest(checked.session, {
        type: "complete",
        actionId: "complete-tests",
      }));
      assert.equal(completion.action.status, "failed", entry.name);
      assert.equal(completion.result.error.code, "CHECKS_NOT_PASSED", entry.name);
    }
  }
});

test("node-script proof still follows its fixed script exit code", async (t) => {
  const profiles = {
    "script-check": {
      kind: "node-script",
      image: profileImage,
      timeoutMs: 30_000,
      asset: {
        schemaVersion: 1,
        title: "Script",
        description: "Fixed script",
        version: 1,
        source: "process.exit(0);",
      },
    },
  };
  const sandbox = new FakeSandbox({
    profiles,
    results: [sandboxResult({
      stdout: "script passed without TAP",
      profileFingerprint: digestValue(profiles["script-check"]),
    })],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor({
    profiles,
    workspaceProfiles: { dashboard: ["script-check"] },
  });
  await executor.recover();
  const session = await executor.start(startRequest());
  const checked = await executor.perform(actionRequest(session, {
    type: "run_profile",
    actionId: "run-script",
    profileId: "script-check",
  }));
  assert.equal(checked.action.status, "succeeded");
  assert.equal(Object.hasOwn(checked.result, "testSummary"), false);
  const completed = await executor.perform(actionRequest(checked.session, {
    type: "complete",
    actionId: "complete-script",
  }));
  assert.equal(completed.action.status, "succeeded");

  const failedSandbox = new FakeSandbox({
    profiles,
    results: [sandboxResult({
      exitCode: 1,
      stdout: passedTap,
      profileFingerprint: digestValue(profiles["script-check"]),
    })],
  });
  const failedSetup = await fixture(t, { sandbox: failedSandbox });
  const failedExecutor = failedSetup.createExecutor({
    profiles,
    workspaceProfiles: { dashboard: ["script-check"] },
  }).executor;
  await failedExecutor.recover();
  const failedSession = await failedExecutor.start(startRequest());
  const failedCheck = await failedExecutor.perform(actionRequest(failedSession, {
    type: "run_profile",
    actionId: "run-script",
    profileId: "script-check",
  }));
  assert.equal(failedCheck.action.status, "failed");
});

test("completed change export rebuilds exact package material after scratch loss", async (t) => {
  const setup = await fixture(t);
  const first = setup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const sourceRevision = session.sourceRevision;
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-for-export",
      path: "src/app.js",
    }),
  );
  const firstWrite = await first.executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "write-export-first",
      path: "src/app.js",
      content: "export const value = 2;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  const finalWrite = await first.executor.perform(
    actionRequest(firstWrite.session, {
      type: "write_text",
      actionId: "write-export-final",
      path: "src/app.js",
      content: "export const value = 3;\n",
      expectedSha256: firstWrite.result.sha256,
    }),
  );
  const created = await first.executor.perform(
    actionRequest(finalWrite.session, {
      type: "write_text",
      actionId: "write-export-created",
      path: "test/new.js",
      content: "export const added = true;\n",
      expectedSha256: null,
    }),
  );
  const checked = await first.executor.perform(
    actionRequest(created.session, {
      type: "run_profile",
      actionId: "test-export",
      profileId: "node-tests",
    }),
  );
  const completed = await first.executor.perform(
    actionRequest(checked.session, {
      type: "complete",
      actionId: "complete-export",
    }),
  );
  const durable = await setup.innerStore.read("code-executor-state");
  const proofAction = durable.sessions[session.id].actions.find(
    ({ id }) => id === "test-export",
  );
  await rm(setup.scratchRoot, { recursive: true, force: true });

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const request = {
    sessionId: session.id,
    completedActionId: "complete-export",
    expectedWorkspaceRevision: completed.session.workspaceRevision,
  };
  const exported = await recovered.executor.exportCompletedChangeSet(request);

  assert.deepEqual(exported.workspace, {
    id: "dashboard",
    sourceRevision,
    workspaceRevision: completed.session.workspaceRevision,
  });
  assert.deepEqual(exported.modified.map(({ path }) => path), ["src/app.js"]);
  assert.equal(exported.modified[0].beforeSha256, read.result.sha256);
  assert.equal(
    exported.modified[0].content.toString("utf8"),
    "export const value = 3;\n",
  );
  assert.deepEqual(exported.created.map(({ path }) => path), ["test/new.js"]);
  assert.equal(
    exported.created[0].content.toString("utf8"),
    "export const added = true;\n",
  );
  assert.deepEqual(exported.deleted, []);
  assert.deepEqual(exported.passedProfiles, [
    {
      id: "node-tests",
      configDigest: digestValue(profileDefinitions["node-tests"]),
      workspaceRevision: completed.session.workspaceRevision,
      actionId: "test-export",
      attemptNumber: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      artifacts: structuredClone(proofAction.outputArtifacts),
    },
  ]);
  assert.equal(JSON.stringify(exported).includes(setup.root), false);

  exported.modified[0].content.fill(0);
  const repeated = await recovered.executor.exportCompletedChangeSet(request);
  assert.equal(
    repeated.modified[0].content.toString("utf8"),
    "export const value = 3;\n",
  );
  await assert.rejects(
    recovered.executor.exportCompletedChangeSet({
      ...request,
      completedActionId: "complete-other",
    }),
    hasCode("EXECUTION_BINDING_MISMATCH"),
  );
});

test("completed change export fences a manifest without audited content", async (t) => {
  const setup = await fixture(t);
  const { completed } = await createCompletedSessionWithRead(setup);
  const state = await setup.innerStore.read("code-executor-state");
  const session = state.sessions["session-one"];
  const completion = session.actions.at(-1);
  await replaceArtifact(setup, completion.outputArtifacts.manifest, {
    created: [{ path: "src/ghost.js", sha256: "f".repeat(64) }],
    modified: [],
    deleted: [],
  });
  await setup.innerStore.write("code-executor-state", state);
  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();

  await assert.rejects(
    recovered.executor.exportCompletedChangeSet({
      sessionId: session.id,
      completedActionId: completion.id,
      expectedWorkspaceRevision: completed.session.workspaceRevision,
    }),
    hasCode("EXECUTION_FENCED"),
  );
});

test("completed change export binds classification, baseline, and full write set", async (t) => {
  const cases = [
    {
      name: "classification",
      tamper(manifest) {
        const [modified] = manifest.modified;
        manifest.created.push({
          path: modified.path,
          sha256: modified.afterSha256,
        });
        manifest.modified = [];
      },
    },
    {
      name: "baseline",
      tamper(manifest) {
        manifest.modified[0].beforeSha256 = "f".repeat(64);
      },
    },
    {
      name: "complete set",
      tamper(manifest) {
        manifest.created = [];
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (child) => {
      const setup = await fixture(child);
      const { completed } = await createCompletedSessionWithChanges(setup);
      const state = await setup.innerStore.read("code-executor-state");
      const session = state.sessions["session-one"];
      const completion = session.actions.at(-1);
      const manifest = await setup.journal.readJson(
        completion.outputArtifacts.manifest,
      );
      scenario.tamper(manifest);
      await replaceArtifact(setup, completion.outputArtifacts.manifest, manifest);
      await setup.innerStore.write("code-executor-state", state);
      const recovered = setup.createExecutor({ broker: setup.createBroker() });
      await recovered.executor.recover();

      await assert.rejects(
        recovered.executor.exportCompletedChangeSet({
          sessionId: session.id,
          completedActionId: completion.id,
          expectedWorkspaceRevision: completed.session.workspaceRevision,
        }),
        hasCode("EXECUTION_FENCED"),
      );
    });
  }
});

test("action schemas and idempotency reject capability escalation", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());

  await assert.rejects(
    executor.perform({
      sessionId: session.id,
      action: {
        type: "run_profile",
        actionId: "raw-command",
        expectedWorkspaceRevision: session.workspaceRevision,
        profileId: "node-tests",
        command: "powershell.exe",
      },
    }),
    hasCode("INVALID_EXECUTION_REQUEST"),
  );
  const first = await executor.perform(
    actionRequest(session, {
      type: "list_files",
      actionId: "list-one",
      path: "",
    }),
  );
  assert.deepEqual(first.result, ["src/app.js"]);
  await assert.rejects(
    executor.perform(
      actionRequest(session, {
        type: "list_files",
        actionId: "list-one",
        path: "src",
      }),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
});

test("the running record is durable before a write side effect", async (t) => {
  const setup = await fixture(t, { failingStore: true });
  const { broker, executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const read = await executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-failure",
      path: "src/app.js",
    }),
  );
  setup.store.failNextWrite = true;

  await assert.rejects(
    executor.perform(
      actionRequest(read.session, {
        type: "write_text",
        actionId: "write-not-claimed",
        path: "src/app.js",
        content: "unsafe\n",
        expectedSha256: read.result.sha256,
      }),
    ),
    hasCode("STATE_WRITE_FAILED"),
  );
  const stored = await setup.innerStore.read("code-executor-state");
  assert.equal(
    stored.sessions[session.id].actions.some(
      (action) => action.id === "write-not-claimed",
    ),
    false,
  );
  const brokerExecutionId = stored.sessions[session.id].attempts.at(-1).executionId;
  assert.deepEqual(
    await broker.getChangeManifest({
      workspaceId: "dashboard",
      executionId: brokerExecutionId,
    }),
    { created: [], modified: [], deleted: [] },
  );
});

test("recovery interrupts unknown work and resumes confirmed writes", async (t) => {
  const pending = deferred();
  const firstSandbox = new FakeSandbox({ results: [() => pending.promise] });
  const setup = await fixture(t, { sandbox: firstSandbox });
  const first = setup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-for-replay",
      path: "src/app.js",
    }),
  );
  const write = await first.executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "write-for-replay",
      path: "src/app.js",
      content: "export const recovered = true;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  session = write.session;
  void first.executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-crashed",
      profileId: "node-tests",
    }),
  );

  let runningState;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    runningState = await setup.innerStore.read("code-executor-state");
    if (
      runningState.sessions[session.id].actions.some(
        (action) => action.id === "test-crashed" && action.status === "running",
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(
    runningState.sessions[session.id].actions.some(
      (action) => action.id === "test-crashed" && action.status === "running",
    ),
    true,
  );

  const recoverySandbox = new FakeSandbox();
  const recovered = setup.createExecutor({
    broker: setup.createBroker(),
    nextSandbox: recoverySandbox,
  });
  await recovered.executor.recover();
  const interrupted = await recovered.executor.view({ sessionId: session.id });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(
    interrupted.actions.find((action) => action.id === "test-crashed").status,
    "interrupted",
  );
  assert.equal(recoverySandbox.calls.length, 0);
  assert.equal(recoverySandbox.cleanupCalls.length, 1);

  const resumed = await recovered.executor.resume(sessionRequest(session.id));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.attempt.number, 2);
  assert.equal(resumed.workspaceRevision, session.workspaceRevision);
  const reread = await recovered.executor.perform(
    actionRequest(resumed, {
      type: "read_text",
      actionId: "read-after-resume",
      path: "src/app.js",
    }),
  );
  assert.equal(reread.result.content, "export const recovered = true;\n");
  assert.equal(recoverySandbox.calls.length, 0);
});

test("resume removes a newly materialized attempt when its source revision changed", async (t) => {
  const setup = await fixture(t);
  const initial = setup.createExecutor();
  await initial.executor.recover();
  const active = await initial.executor.start(startRequest());

  const recoveryBroker = setup.createBroker();
  const recovered = setup.createExecutor({ broker: recoveryBroker });
  await recovered.executor.recover();
  await writeFile(
    path.join(setup.sourceRoot, "src", "app.js"),
    "export const changed = true;\n",
  );

  await assert.rejects(
    recovered.executor.resume(sessionRequest(active.id)),
    hasCode("SOURCE_REVISION_CHANGED"),
  );
  await assert.rejects(
    access(attemptFile(setup, active.id, 2)),
  );
  const failed = await recovered.executor.view({ sessionId: active.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "SOURCE_REVISION_CHANGED");
});

test("failed source-mismatch disposal is retried before a restarted executor becomes ready", async (t) => {
  const setup = await fixture(t);
  const initial = setup.createExecutor();
  await initial.executor.recover();
  const active = await initial.executor.start(startRequest());
  const secondExecutionId = attemptExecutionIdFor(active.id, 2);

  const resumeBaseBroker = setup.createBroker();
  let mismatchDisposalFailed = false;
  const resumeBroker = overrideBroker(resumeBaseBroker, {
    discardExecution: async (request) => {
      if (
        request.executionId === secondExecutionId &&
        !mismatchDisposalFailed
      ) {
        mismatchDisposalFailed = true;
        throw new Error("workspace removal unavailable");
      }
      return resumeBaseBroker.discardExecution(request);
    },
  });
  const recovered = setup.createExecutor({ broker: resumeBroker });
  await recovered.executor.recover();
  await writeFile(
    path.join(setup.sourceRoot, "src", "app.js"),
    "export const changedAgain = true;\n",
  );

  await assert.rejects(
    recovered.executor.resume(sessionRequest(active.id)),
    hasCode("WORKSPACE_DISPOSAL_PENDING"),
  );
  await access(attemptFile(setup, active.id, 2));
  const preparing = await setup.innerStore.read("code-executor-state");
  assert.equal(preparing.sessions[active.id].status, "preparing");

  const cleanupBaseBroker = setup.createBroker();
  let recoveryDisposals = 0;
  const cleanupBroker = overrideBroker(cleanupBaseBroker, {
    discardExecution: async (request) => {
      if (request.executionId === secondExecutionId) {
        recoveryDisposals += 1;
        if (recoveryDisposals === 1) {
          throw new Error("workspace removal still unavailable");
        }
      }
      return cleanupBaseBroker.discardExecution(request);
    },
  });
  const restarted = setup.createExecutor({ broker: cleanupBroker });

  await assert.rejects(
    restarted.executor.recover(),
    hasCode("WORKSPACE_DISPOSAL_PENDING"),
  );
  await assert.rejects(
    restarted.executor.view({ sessionId: active.id }),
    hasCode("EXECUTOR_NOT_READY"),
  );
  await access(attemptFile(setup, active.id, 2));

  assert.deepEqual(await restarted.executor.recover(), {
    recovered: true,
    cleanupPending: 0,
  });
  await assert.rejects(
    access(attemptFile(setup, active.id, 2)),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(recoveryDisposals, 2);
  assert.equal(
    (await restarted.executor.view({ sessionId: active.id })).status,
    "interrupted",
  );
});

test("cleanup uncertainty fences resume", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();
  await executor.recover();
  await executor.start(startRequest());
  const state = await setup.innerStore.read("code-executor-state");
  const session = state.sessions["session-one"];
  const unknownInput = await setup.journal.writeJson({
    sessionId: "session-one",
    actionId: "test-unknown",
    kind: "input",
    value: {
      type: "run_profile",
      actionId: "test-unknown",
      expectedWorkspaceRevision: session.workspaceRevision,
      profileId: "node-tests",
    },
  });
  session.status = "running";
  session.attempts.at(-1).status = "running";
  session.actions.push({
    id: "test-unknown",
    type: "run_profile",
    requestDigest: "0".repeat(64),
    status: "running",
    attemptNumber: 1,
    inputArtifact: unknownInput,
    outputArtifacts: {},
    workspaceRevisionBefore: session.workspaceRevision,
    workspaceRevisionAfter: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
  await setup.innerStore.write("code-executor-state", state);

  const cleanupFailure = new DockerSandboxError(
    "SANDBOX_CLEANUP_FAILED",
    "cleanup pending",
    {
      details: { cleanupPending: true, containerName: "mydashboard-pending" },
    },
  );
  const recoverySandbox = new FakeSandbox({
    cleanupResults: [cleanupFailure, cleanupFailure],
  });
  const recovered = setup.createExecutor({
    broker: setup.createBroker(),
    nextSandbox: recoverySandbox,
  });
  await recovered.executor.recover();
  const interrupted = await recovered.executor.view({ sessionId: "session-one" });
  assert.equal(interrupted.cleanupPending, true);
  const cleanupCallsBeforeMismatch = recoverySandbox.cleanupCalls.length;
  await assert.rejects(
    recovered.executor.resume(
      sessionRequest("session-one", pullRequestBinding()),
    ),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(
    recoverySandbox.cleanupCalls.length,
    cleanupCallsBeforeMismatch,
  );
  await assert.rejects(
    recovered.executor.resume(sessionRequest("session-one")),
    hasCode("CLEANUP_PENDING"),
  );
  assert.equal(recoverySandbox.cleanupCalls.length, 2);
});

test("prototype-shaped IDs remain ordinary session and profile IDs", async (t) => {
  const profiles = {
    constructor: {
      kind: "node-test",
      image: profileImage,
      timeoutMs: 30_000,
    },
  };
  const sandbox = new FakeSandbox({
    profiles,
    results: [
      sandboxResult({ profileFingerprint: digestValue(profiles.constructor) }),
    ],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor({
    profiles,
    workspaceProfiles: { dashboard: ["constructor"] },
  });
  await executor.recover();

  let session = await executor.start(startRequest({ sessionId: "constructor" }));
  assert.equal(session.id, "constructor");
  const checked = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-constructor",
      profileId: "constructor",
    }),
  );
  session = checked.session;
  const completed = await executor.perform(
    actionRequest(session, {
      type: "complete",
      actionId: "complete-constructor",
    }),
  );
  assert.equal(completed.session.status, "completed");
});

test("recovery is startup-only and idempotent after the executor is ready", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();
  await executor.recover();
  const active = await executor.start(startRequest());

  const secondRecovery = await executor.recover();
  const unchanged = await executor.view({ sessionId: active.id });

  assert.deepEqual(secondRecovery, { recovered: false, alreadyReady: true });
  assert.equal(unchanged.status, "active");
  assert.equal(unchanged.attempt.number, 1);
});

test("completed recovery rejects a missing earlier non-profile input artifact", async (t) => {
  const setup = await fixture(t);
  await createCompletedSessionWithRead(setup);
  const state = await setup.innerStore.read("code-executor-state");
  const readAction = state.sessions["session-one"].actions.find(
    (action) => action.id === "read-before-completion",
  );
  await rm(artifactFile(setup, readAction.inputArtifact));

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await assert.rejects(
    recovered.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
  await assert.rejects(
    recovered.executor.view({ sessionId: "session-one" }),
    hasCode("EXECUTOR_NOT_READY"),
  );
});

test("completed recovery rejects a corrupt earlier non-profile result", async (t) => {
  const setup = await fixture(t);
  await createCompletedSessionWithRead(setup);
  const state = await setup.innerStore.read("code-executor-state");
  const readAction = state.sessions["session-one"].actions.find(
    (action) => action.id === "read-before-completion",
  );
  await replaceArtifact(setup, readAction.outputArtifacts.output, {
    path: "src/app.js",
    content: "semantically corrupt",
    sha256: "0".repeat(64),
    bytes: 999,
  });
  await setup.innerStore.write("code-executor-state", state);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await assert.rejects(
    recovered.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
});

test("recovery reports no pending cleanup after every fence is cleared", async (t) => {
  const initialSandbox = new FakeSandbox({
    results: [cleanupPendingError()],
  });
  const setup = await fixture(t, { sandbox: initialSandbox });
  const first = setup.createExecutor();
  await first.executor.recover();
  const session = await first.executor.start(startRequest());
  const interrupted = await first.executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-cleanup-success",
      profileId: "node-tests",
    }),
  );
  assert.equal(interrupted.session.cleanupPending, true);

  const recoverySandbox = new FakeSandbox();
  const recovered = setup.createExecutor({
    broker: setup.createBroker(),
    nextSandbox: recoverySandbox,
  });
  assert.deepEqual(await recovered.executor.recover(), {
    recovered: true,
    cleanupPending: 0,
  });
  assert.equal(
    (await recovered.executor.view({ sessionId: "session-one" })).cleanupPending,
    false,
  );
});

test("recovery reports only cleanup fences that remain after mixed results", async (t) => {
  const initialSandbox = new FakeSandbox({
    results: [cleanupPendingError("first"), cleanupPendingError("second")],
  });
  const setup = await fixture(t, { sandbox: initialSandbox });
  const first = setup.createExecutor();
  await first.executor.recover();
  for (const sessionId of ["session-one", "session-two"]) {
    const session = await first.executor.start(startRequest({ sessionId }));
    const interrupted = await first.executor.perform(
      actionRequest(session, {
        type: "run_profile",
        actionId: `test-${sessionId}`,
        profileId: "node-tests",
      }),
    );
    assert.equal(interrupted.session.cleanupPending, true);
  }

  const recoverySandbox = new FakeSandbox({
    cleanupResults: [undefined, cleanupPendingError("still pending")],
  });
  const recovered = setup.createExecutor({
    broker: setup.createBroker(),
    nextSandbox: recoverySandbox,
  });
  const recovery = await recovered.executor.recover();
  assert.deepEqual(recovery, { recovered: true, cleanupPending: 1 });
  assert.equal(
    (await recovered.executor.view({ sessionId: "session-one" })).cleanupPending,
    false,
  );
  assert.equal(
    (await recovered.executor.view({ sessionId: "session-two" })).cleanupPending,
    true,
  );
});

test("a recovered executor returns validated action result envelopes", async (t) => {
  const setup = await fixture(t);
  const { read, failedCompletion } = await createCompletedSessionWithRead(setup);
  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();

  const readEnvelope = await recovered.executor.getActionResult({
    sessionId: "session-one",
    actionId: "read-before-completion",
  });
  assert.deepEqual(Object.keys(readEnvelope).sort(), ["action", "result"]);
  assert.equal(readEnvelope.action.status, "succeeded");
  assert.deepEqual(readEnvelope.result, read.result);
  assert.equal(JSON.stringify(readEnvelope).includes(setup.root), false);
  assert.equal(JSON.stringify(readEnvelope).includes(setup.scratchRoot), false);

  const failedEnvelope = await recovered.executor.getActionResult({
    sessionId: "session-one",
    actionId: "complete-before-checks",
  });
  assert.equal(failedEnvelope.action.status, "failed");
  assert.deepEqual(failedEnvelope.result, failedCompletion.result);

  const originalArtifactDigest = readEnvelope.action.outputArtifacts.output.sha256;
  readEnvelope.action.outputArtifacts.output.sha256 = "0".repeat(64);
  readEnvelope.result.content = "mutated by caller";
  const reread = await recovered.executor.getActionResult({
    sessionId: "session-one",
    actionId: "read-before-completion",
  });
  assert.equal(reread.action.outputArtifacts.output.sha256, originalArtifactDigest);
  assert.equal(reread.result.content, "export const value = 1;\n");
});

test("action reconciliation is exact, audited, and never creates work", async (t) => {
  const setup = await fixture(t);
  const { read } = await createCompletedSessionWithRead(setup);
  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const exact = {
    sessionId: "session-one",
    action: {
      type: "read_text",
      actionId: "read-before-completion",
      expectedWorkspaceRevision: read.action.workspaceRevisionBefore,
      path: "src/app.js",
    },
  };

  const reconciled = await recovered.executor.reconcileAction(exact);
  assert.equal(reconciled.status, "terminal");
  assert.equal(reconciled.action.status, "succeeded");
  assert.deepEqual(reconciled.result, read.result);

  await assert.rejects(
    recovered.executor.reconcileAction({
      ...exact,
      action: { ...exact.action, path: "src/other.js" },
    }),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  const absent = await recovered.executor.reconcileAction({
    ...exact,
    action: { ...exact.action, actionId: "read-never-started" },
  });
  assert.equal(absent.status, "absent");
  assert.equal(absent.session.status, "completed");
});

test("action result access is exact, ready-gated, and terminal-only", async (t) => {
  const pending = deferred();
  const sandbox = new FakeSandbox({ results: [() => pending.promise] });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await assert.rejects(
    executor.getActionResult({
      sessionId: "session-one",
      actionId: "test-running-result",
    }),
    hasCode("EXECUTOR_NOT_READY"),
  );
  await executor.recover();
  const session = await executor.start(startRequest());

  await assert.rejects(
    executor.getActionResult({
      sessionId: session.id,
      actionId: "missing-action",
      hostPath: setup.scratchRoot,
    }),
    hasCode("INVALID_EXECUTION_REQUEST"),
  );
  await assert.rejects(
    executor.getActionResult({ sessionId: "missing-session", actionId: "action" }),
    hasCode("SESSION_NOT_FOUND"),
  );
  await assert.rejects(
    executor.getActionResult({ sessionId: session.id, actionId: "missing-action" }),
    hasCode("ACTION_NOT_FOUND"),
  );

  const running = executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-running-result",
      profileId: "node-tests",
    }),
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await setup.innerStore.read("code-executor-state");
    if (
      state.sessions[session.id].actions.some(
        (action) =>
          action.id === "test-running-result" && action.status === "running",
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await assert.rejects(
    executor.getActionResult({
      sessionId: session.id,
      actionId: "test-running-result",
    }),
    hasCode("EXECUTOR_ACTION_NOT_TERMINAL"),
  );
  pending.resolve(sandboxResult());
  await running;
});

test("actions are rejected before creating orphan input artifacts", async (t) => {
  const setup = await fixture(t);
  const recordingJournal = new RecordingJournal(setup.journal);
  const { executor } = setup.createExecutor({
    nextJournal: recordingJournal,
    limits: { maxSessions: 100, maxActionsPerSession: 1 },
  });
  await executor.recover();
  const session = await executor.start(startRequest());

  await assert.rejects(
    executor.perform({
      sessionId: session.id,
      action: {
        type: "list_files",
        actionId: "stale-action",
        expectedWorkspaceRevision: "0".repeat(64),
        path: "",
      },
    }),
    hasCode("WORKSPACE_REVISION_MISMATCH"),
  );
  assert.equal(recordingJournal.writeCalls.length, 0);

  const first = await executor.perform(
    actionRequest(session, {
      type: "list_files",
      actionId: "allowed-action",
      path: "",
    }),
  );
  assert.equal(first.action.status, "succeeded");
  const writesAfterAllowedAction = recordingJournal.writeCalls.length;
  await assert.rejects(
    executor.perform(
      actionRequest(first.session, {
        type: "list_files",
        actionId: "over-limit-action",
        path: "",
      }),
    ),
    hasCode("ACTION_LIMIT"),
  );
  assert.equal(recordingJournal.writeCalls.length, writesAfterAllowedAction);
});

test("concurrent retries share one in-flight action", async (t) => {
  const pending = deferred();
  const sandbox = new FakeSandbox({ results: [() => pending.promise] });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const request = actionRequest(session, {
    type: "run_profile",
    actionId: "same-flight",
    profileId: "node-tests",
  });

  const first = executor.perform(request);
  const second = executor.perform(request);
  assert.equal(first, second);
  for (let attempt = 0; attempt < 50 && sandbox.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(sandbox.calls.length, 1);
  pending.resolve(sandboxResult());
  const result = await first;
  assert.equal(result.action.status, "succeeded");
  assert.equal(sandbox.calls.length, 1);
});

test("a crash after workspace creation can resume as first materialization", async (t) => {
  const setup = await fixture(t, { failingStore: true });
  const baseBroker = setup.createBroker();
  let armFailure = true;
  const broker = overrideBroker(baseBroker, {
    createExecution: async (request) => {
      const created = await baseBroker.createExecution(request);
      if (armFailure) {
        armFailure = false;
        setup.store.failNextWrite = true;
      }
      return created;
    },
  });
  const first = setup.createExecutor({ broker });
  await first.executor.recover();
  await assert.rejects(first.executor.start(startRequest()), hasCode("STATE_WRITE_FAILED"));
  const preparing = await setup.innerStore.read("code-executor-state");
  assert.equal(preparing.sessions["session-one"].sourceRevision, null);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const resumed = await recovered.executor.resume(sessionRequest("session-one"));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.attempt.number, 2);
  assert.match(resumed.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(resumed.workspaceRevision, resumed.sourceRevision);
});

test("an uncertain write interrupts the session and is never replayed", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const broker = overrideBroker(baseBroker, {
    writeFile: async (request) => {
      await baseBroker.writeFile(request);
      throw new Error(`post-write failure at ${setup.scratchRoot}`);
    },
  });
  const first = setup.createExecutor({ broker });
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-unknown",
      path: "src/app.js",
    }),
  );
  session = read.session;
  const uncertain = await first.executor.perform(
    actionRequest(session, {
      type: "write_text",
      actionId: "write-unknown",
      path: "src/app.js",
      content: "export const uncertain = true;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  assert.equal(uncertain.action.status, "interrupted");
  assert.equal(uncertain.action.error.code, "RESULT_UNKNOWN");
  assert.equal(uncertain.session.status, "interrupted");
  assert.equal(JSON.stringify(uncertain).includes(setup.scratchRoot), false);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const resumed = await recovered.executor.resume(sessionRequest(session.id));
  const reread = await recovered.executor.perform(
    actionRequest(resumed, {
      type: "read_text",
      actionId: "read-after-unknown",
      path: "src/app.js",
    }),
  );
  assert.equal(reread.result.content, "export const value = 1;\n");
});

test("an unverified change racing completion is rejected and interrupts the session", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  const broker = overrideBroker(baseBroker, {
    sealExecution: async (request) => {
      await baseBroker.writeFile({
        workspaceId: request.workspaceId,
        executionId: request.executionId,
        path: "src/unverified.js",
        content: "export const unverified = true;\n",
        expectedSha256: null,
        expectedWorkspaceRevision: request.expectedWorkspaceRevision,
      });
      return baseBroker.sealExecution(request);
    },
  });
  const { executor } = setup.createExecutor({ broker });
  await executor.recover();
  let session = await executor.start(startRequest());
  const checked = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "test-before-race",
      profileId: "node-tests",
    }),
  );
  session = checked.session;
  const completion = await executor.perform(
    actionRequest(session, {
      type: "complete",
      actionId: "complete-racing-write",
    }),
  );

  assert.equal(completion.action.status, "interrupted");
  assert.equal(completion.action.error.code, "RESULT_UNKNOWN");
  assert.equal(completion.session.status, "interrupted");
  assert.notEqual(completion.session.status, "completed");
});

test("artifact persistence failure after a write requires restart recovery", async (t) => {
  const setup = await fixture(t);
  const failingJournal = new FailingJournal(setup.journal, null);
  const first = setup.createExecutor({ nextJournal: failingJournal });
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-journal-failure",
      path: "src/app.js",
    }),
  );
  session = read.session;
  failingJournal.failingKind = "output";
  await assert.rejects(
    first.executor.perform(
      actionRequest(session, {
        type: "write_text",
        actionId: "write-before-journal-failure",
        path: "src/app.js",
        content: "export const journalUnknown = true;\n",
        expectedSha256: read.result.sha256,
      }),
    ),
    hasCode("EXECUTION_FENCED"),
  );
  const uncertainState = await setup.innerStore.read("code-executor-state");
  assert.equal(
    uncertainState.sessions[session.id].actions.at(-1).status,
    "running",
  );

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const interrupted = await recovered.executor.view({ sessionId: session.id });
  assert.equal(interrupted.actions.at(-1).status, "interrupted");
  const resumed = await recovered.executor.resume(sessionRequest(session.id));
  const reread = await recovered.executor.perform(
    actionRequest(resumed, {
      type: "read_text",
      actionId: "read-after-journal-failure",
      path: "src/app.js",
    }),
  );
  assert.equal(reread.result.content, "export const value = 1;\n");
});

test("resume rejects a changed trusted profile configuration", async (t) => {
  const setup = await fixture(t);
  const first = setup.createExecutor();
  await first.executor.recover();
  await first.executor.start(startRequest());
  const state = await setup.innerStore.read("code-executor-state");
  const storedSession = state.sessions["session-one"];
  storedSession.status = "interrupted";
  storedSession.attempts.at(-1).status = "interrupted";
  storedSession.attempts.at(-1).finishedAt = new Date().toISOString();
  await setup.innerStore.write("code-executor-state", state);

  const changedProfiles = {
    "node-tests": { ...profileDefinitions["node-tests"], timeoutMs: 45_000 },
  };
  const recovered = setup.createExecutor({
    profiles: changedProfiles,
    nextSandbox: new FakeSandbox({ profiles: changedProfiles }),
  });
  await recovered.executor.recover();
  await assert.rejects(
    recovered.executor.resume(sessionRequest("session-one")),
    hasCode("PROFILE_CONFIG_CHANGED"),
  );
});

test("malformed sandbox proof cannot satisfy completion checks", async (t) => {
  const sandbox = new FakeSandbox({
    results: [sandboxResult({ imageId: undefined })],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const checked = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "malformed-proof",
      profileId: "node-tests",
    }),
  );
  assert.equal(checked.action.status, "failed");
  assert.equal(checked.action.error.code, "SANDBOX_RESULT_INVALID");
  const completion = await executor.perform(
    actionRequest(checked.session, {
      type: "complete",
      actionId: "complete-without-proof",
    }),
  );
  assert.equal(completion.action.status, "failed");
  assert.equal(completion.result.error.code, "CHECKS_NOT_PASSED");
});

test("a sandbox run cannot substitute a different profile fingerprint", async (t) => {
  const sandbox = new FakeSandbox({
    results: [sandboxResult({ profileFingerprint: "f".repeat(64) })],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const checked = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "substituted-profile",
      profileId: "node-tests",
    }),
  );

  assert.equal(checked.action.status, "failed");
  assert.equal(checked.action.error.code, "SANDBOX_PROFILE_MISMATCH");
  assert.equal(checked.session.status, "active");
});

test("recovery closes running replay records", async (t) => {
  const setup = await fixture(t);
  const first = setup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-replay-state",
      path: "src/app.js",
    }),
  );
  const write = await first.executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "write-replay-state",
      path: "src/app.js",
      content: "export const replaying = true;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  session = write.session;
  const state = await setup.innerStore.read("code-executor-state");
  const storedSession = state.sessions[session.id];
  const startedAt = new Date().toISOString();
  storedSession.attempts.at(-1).status = "interrupted";
  storedSession.attempts.at(-1).finishedAt = startedAt;
  storedSession.attempts.push({
    number: 2,
    executionId: `attempt-${digestValue({ number: 2, sessionId: session.id }).slice(0, 24)}`,
    status: "replaying",
    startedAt,
    finishedAt: null,
    replays: [
      {
        sourceActionId: "write-replay-state",
        status: "running",
        startedAt,
        finishedAt: null,
      },
    ],
  });
  storedSession.status = "replaying";
  await setup.innerStore.write("code-executor-state", state);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await recovered.executor.recover();
  const recoveredState = await setup.innerStore.read("code-executor-state");
  const replay = recoveredState.sessions[session.id].attempts.at(-1).replays[0];
  assert.equal(replay.status, "interrupted");
  assert.ok(replay.finishedAt);
});

test("persisted null and cross-action artifact references fail closed", async (t) => {
  const nullSetup = await fixture(t);
  await nullSetup.innerStore.write("code-executor-state", null);
  const nullExecutor = nullSetup.createExecutor().executor;
  await assert.rejects(nullExecutor.recover(), hasCode("EXECUTOR_STATE_INVALID"));

  const setup = await fixture(t);
  const first = setup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const read = await first.executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-owned-artifact",
      path: "src/app.js",
    }),
  );
  const write = await first.executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "write-owned-artifact",
      path: "src/app.js",
      content: "export const owned = true;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  session = write.session;
  const state = await setup.innerStore.read("code-executor-state");
  const storedAction = state.sessions[session.id].actions.find(
    (action) => action.id === "write-owned-artifact",
  );
  const input = await setup.journal.readJson(storedAction.inputArtifact);
  storedAction.inputArtifact = await setup.journal.writeJson({
    sessionId: "another-session",
    actionId: storedAction.id,
    kind: "input",
    value: input,
  });
  await setup.innerStore.write("code-executor-state", state);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await assert.rejects(recovered.executor.recover(), hasCode("EXECUTOR_STATE_INVALID"));
});

test("terminal sessions cannot contain running actions", async (t) => {
  const setup = await fixture(t);
  const first = setup.createExecutor();
  await first.executor.recover();
  const session = await first.executor.start(startRequest());
  await first.executor.perform(
    actionRequest(session, {
      type: "list_files",
      actionId: "terminal-running-action",
      path: "",
    }),
  );
  const state = await setup.innerStore.read("code-executor-state");
  const storedSession = state.sessions[session.id];
  const storedAction = storedSession.actions.at(-1);
  const finishedAt = new Date().toISOString();
  storedAction.status = "running";
  storedAction.workspaceRevisionAfter = null;
  storedAction.finishedAt = null;
  storedSession.status = "completed";
  storedSession.completedAt = finishedAt;
  storedSession.attempts.at(-1).status = "completed";
  storedSession.attempts.at(-1).finishedAt = finishedAt;
  await setup.innerStore.write("code-executor-state", state);

  const recovered = setup.createExecutor({ broker: setup.createBroker() });
  await assert.rejects(recovered.executor.recover(), hasCode("EXECUTOR_STATE_INVALID"));
});

test("a failed profile proof cannot be forged into a passing proof", async (t) => {
  const sandbox = new FakeSandbox({
    results: [sandboxResult({ exitCode: 1, stderr: "failed" })],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const failed = await executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "failed-proof",
      profileId: "node-tests",
    }),
  );
  assert.equal(failed.action.status, "failed");
  const state = await setup.innerStore.read("code-executor-state");
  state.sessions[session.id].verifiedProfiles["node-tests"].passed = true;
  await setup.innerStore.write("code-executor-state", state);

  await assert.rejects(
    executor.perform(
      actionRequest(failed.session, {
        type: "complete",
        actionId: "forged-completion",
      }),
    ),
    hasCode("EXECUTOR_STATE_INVALID"),
  );

  const fullyForgedState = await setup.innerStore.read("code-executor-state");
  const forgedAction = fullyForgedState.sessions[session.id].actions.find(
    (action) => action.id === "failed-proof",
  );
  forgedAction.status = "succeeded";
  forgedAction.error = null;
  await setup.innerStore.write("code-executor-state", fullyForgedState);
  const artifactChecked = await executor.perform(
    actionRequest(failed.session, {
      type: "complete",
      actionId: "forged-completion",
    }),
  );
  assert.equal(artifactChecked.action.status, "interrupted");
  assert.equal(artifactChecked.action.error.code, "RESULT_UNKNOWN");
  assert.equal(artifactChecked.session.status, "interrupted");
});

test("completed state requires semantic actions, proofs, and durable artifacts", async (t) => {
  const forgedSetup = await fixture(t);
  const forged = forgedSetup.createExecutor();
  await forged.executor.recover();
  const active = await forged.executor.start(startRequest());
  const forgedState = await forgedSetup.innerStore.read("code-executor-state");
  const forgedSession = forgedState.sessions[active.id];
  const completedAt = new Date().toISOString();
  forgedSession.status = "completed";
  forgedSession.completedAt = completedAt;
  forgedSession.attempts.at(-1).status = "completed";
  forgedSession.attempts.at(-1).finishedAt = completedAt;
  await forgedSetup.innerStore.write("code-executor-state", forgedState);
  const forgedRecovery = forgedSetup.createExecutor({
    broker: forgedSetup.createBroker(),
  });
  await assert.rejects(
    forgedRecovery.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );

  const missingSetup = await fixture(t);
  const first = missingSetup.createExecutor();
  await first.executor.recover();
  let session = await first.executor.start(startRequest());
  const checked = await first.executor.perform(
    actionRequest(session, {
      type: "run_profile",
      actionId: "durable-proof",
      profileId: "node-tests",
    }),
  );
  session = checked.session;
  const completed = await first.executor.perform(
    actionRequest(session, {
      type: "complete",
      actionId: "durable-completion",
    }),
  );
  assert.equal(completed.session.status, "completed");
  await rm(path.join(missingSetup.root, "execution-artifacts"), {
    recursive: true,
    force: true,
  });
  const missingRecovery = missingSetup.createExecutor({
    broker: missingSetup.createBroker(),
  });
  await assert.rejects(
    missingRecovery.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
});

test("persisted projections and cleanup fences reject unrelated fields and IDs", async (t) => {
  const projectionSetup = await fixture(t);
  const first = projectionSetup.createExecutor();
  await first.executor.recover();
  const session = await first.executor.start(startRequest());
  const projectionState = await projectionSetup.innerStore.read(
    "code-executor-state",
  );
  projectionState.sessions[session.id].requestedBy.hostPath =
    "D:\\private\\token.txt";
  await projectionSetup.innerStore.write(
    "code-executor-state",
    projectionState,
  );
  const projectionRecovery = projectionSetup.createExecutor({
    broker: projectionSetup.createBroker(),
  });
  await assert.rejects(
    projectionRecovery.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );

  const fenceSetup = await fixture(t);
  const fenceSandbox = new FakeSandbox();
  const initial = fenceSetup.createExecutor({ nextSandbox: fenceSandbox });
  await initial.executor.recover();
  await initial.executor.start(startRequest());
  const fenceState = await fenceSetup.innerStore.read("code-executor-state");
  const fencedSession = fenceState.sessions["session-one"];
  const interruptedAt = new Date().toISOString();
  fencedSession.status = "interrupted";
  fencedSession.attempts.at(-1).status = "interrupted";
  fencedSession.attempts.at(-1).finishedAt = interruptedAt;
  fencedSession.cleanupFence = {
    executionId: "unrelated-execution",
    actionId: "unrelated-action",
    containerName: null,
    since: interruptedAt,
    lastError: { code: "RESULT_UNKNOWN", message: "unknown" },
  };
  await fenceSetup.innerStore.write("code-executor-state", fenceState);
  const fenceRecovery = fenceSetup.createExecutor({
    broker: fenceSetup.createBroker(),
    nextSandbox: fenceSandbox,
  });
  await assert.rejects(
    fenceRecovery.executor.recover(),
    hasCode("EXECUTOR_STATE_INVALID"),
  );
  assert.equal(fenceSandbox.cleanupCalls.length, 0);
});

test("invalid clocks and broker creation results never corrupt persisted revisions", async (t) => {
  const clockSetup = await fixture(t);
  const invalidClock = clockSetup.createExecutor({
    nextClock: () => "not-a-date",
  });
  await invalidClock.executor.recover();
  await assert.rejects(
    invalidClock.executor.start(startRequest()),
    hasCode("INVALID_EXECUTOR_CONFIG"),
  );
  assert.equal(
    await clockSetup.innerStore.read("code-executor-state", null),
    null,
  );

  const brokerSetup = await fixture(t);
  const baseBroker = brokerSetup.createBroker();
  const invalidBroker = overrideBroker(baseBroker, {
    createExecution: async (request) => {
      await baseBroker.createExecution(request);
      return {
        workspaceId: request.workspaceId,
        executionId: request.executionId,
        sourceRevision: "bad",
        workspaceRevision: "bad",
      };
    },
  });
  const invalidCreation = brokerSetup.createExecutor({ broker: invalidBroker });
  await invalidCreation.executor.recover();
  await assert.rejects(
    invalidCreation.executor.start(startRequest()),
    hasCode("START_FAILED"),
  );
  const stored = await brokerSetup.innerStore.read("code-executor-state");
  assert.equal(stored.sessions["session-one"].status, "failed");
  assert.equal(stored.sessions["session-one"].sourceRevision, null);
  assert.equal(stored.sessions["session-one"].workspaceRevision, null);
  await assert.rejects(
    access(attemptFile(brokerSetup, "session-one", 1)),
    (error) => error?.code === "ENOENT",
  );
});

test("active cancellation discards its workspace and returns one stable proof", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const request = cancellationRequest(session);
  const executionId = attemptExecutionIdFor(session.id, 1);

  assert.equal(
    await readFile(attemptFile(setup, session.id, 1), "utf8"),
    "export const value = 1;\n",
  );
  const settled = await executor.reconcileCancellation(request);

  assert.equal(settled.status, "settled");
  assert.equal(settled.session.status, "cancelled");
  assert.equal(settled.session.attempt.status, "cancelled");
  assert.deepEqual(settled.proof, {
    schemaVersion: 1,
    kind: "controlled_execution_cancelled",
    sessionId: session.id,
    cancellationDigest: request.cancellationDigest,
    sourceRevision: session.sourceRevision,
    trustedWorkspaceRevision: session.workspaceRevision,
    actionResolution: null,
    sandboxCleanupConfirmed: true,
    discardedAttempts: [
      {
        attemptNumber: 1,
        executionId,
        disposition: "discarded",
      },
    ],
    settledAt: settled.proof.settledAt,
    proofDigest: settled.proof.proofDigest,
  });
  assert.match(settled.proof.proofDigest, /^[a-f0-9]{64}$/);
  assert.match(settled.proof.settledAt, /^2026-08-01T/);
  await assert.rejects(
    readFile(attemptFile(setup, session.id, 1)),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(
    await readFile(path.join(setup.sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );

  assert.deepEqual(await executor.reconcileCancellation(request), settled);
  await assert.rejects(
    executor.perform(
      actionRequest(settled.session, {
        type: "list_files",
        actionId: "list-after-cancel",
        path: "",
      }),
    ),
    hasCode("SESSION_NOT_ACTIVE"),
  );
  await assert.rejects(
    executor.resume(sessionRequest(session.id)),
    hasCode("SESSION_NOT_INTERRUPTED"),
  );
  await assert.rejects(
    executor.exportCompletedChangeSet({
      sessionId: session.id,
      completedActionId: "complete-after-cancel",
      expectedWorkspaceRevision: session.workspaceRevision,
    }),
    hasCode("EXECUTOR_SESSION_NOT_COMPLETED"),
  );
});

test("cancellation rejects a changed PR Head before discarding its workspace", async (t) => {
  const setup = await fixture(t);
  const inputBinding = pullRequestBinding();
  const baseBroker = setup.createBroker();
  let discardCalls = 0;
  const broker = overrideBroker(baseBroker, {
    createExecution: async (request) => ({
      ...(await createDirectoryExecution(baseBroker, request)),
      inputBinding: structuredClone(request.inputBinding),
    }),
    discardExecution: async (request) => {
      discardCalls += 1;
      return baseBroker.discardExecution(request);
    },
  });
  const { executor } = setup.createExecutor({ broker });
  await executor.recover();
  const session = await executor.start(startRequest({ inputBinding }));
  const request = cancellationRequest(session, {
    inputBinding: pullRequestBinding({
      headRevision: 2,
      headRefOid: "d".repeat(40),
    }),
  });

  await assert.rejects(
    executor.reconcileCancellation(request),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );

  assert.equal(discardCalls, 0);
  assert.equal(
    await readFile(attemptFile(setup, session.id, 1), "utf8"),
    "export const value = 1;\n",
  );
  assert.equal((await executor.view({ sessionId: session.id })).status, "active");
});

test("cancelling an unknown write never resumes or replays it", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  let createCalls = 0;
  let writeCalls = 0;
  const broker = overrideBroker(baseBroker, {
    createExecution: async (request) => {
      createCalls += 1;
      return baseBroker.createExecution(request);
    },
    writeFile: async (request) => {
      writeCalls += 1;
      await baseBroker.writeFile(request);
      throw new Error("write result was lost");
    },
  });
  const { executor } = setup.createExecutor({ broker });
  await executor.recover();
  const session = await executor.start(startRequest());
  const read = await executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-cancelled-write",
      path: "src/app.js",
    }),
  );
  const unknownAction = {
    type: "write_text",
    actionId: "unknown-write-to-cancel",
    expectedWorkspaceRevision: read.session.workspaceRevision,
    path: "src/app.js",
    content: "export const uncertain = true;\n",
    expectedSha256: read.result.sha256,
  };
  const interrupted = await executor.perform({
    sessionId: session.id,
    action: unknownAction,
  });

  assert.equal(interrupted.action.status, "interrupted");
  assert.equal(interrupted.action.error.code, "RESULT_UNKNOWN");
  assert.equal(interrupted.session.status, "interrupted");
  assert.equal(
    await readFile(attemptFile(setup, session.id, 1), "utf8"),
    "export const uncertain = true;\n",
  );
  const settled = await executor.reconcileCancellation(
    cancellationRequest(interrupted.session, {
      expectedWorkspaceRevision: unknownAction.expectedWorkspaceRevision,
      expectedAction: {
        actionId: unknownAction.actionId,
        actionDigest: digestValue(unknownAction),
      },
    }),
  );

  assert.equal(settled.session.status, "cancelled");
  assert.deepEqual(settled.proof.actionResolution, {
    actionId: unknownAction.actionId,
    actionDigest: digestValue(unknownAction),
    disposition: "discarded_unknown",
    workspaceRevisionBefore: unknownAction.expectedWorkspaceRevision,
    workspaceRevisionAfter: null,
  });
  assert.equal(settled.session.attempt.number, 1);
  assert.equal(createCalls, 1);
  assert.equal(writeCalls, 1);
  await assert.rejects(
    readFile(attemptFile(setup, session.id, 1)),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(
    await readFile(path.join(setup.sourceRoot, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("cancellation remains retryable until sandbox cleanup is confirmed", async (t) => {
  const sandbox = new FakeSandbox({
    results: [cleanupPendingError("profile cleanup uncertain")],
    cleanupResults: [cleanupPendingError("still cleaning"), undefined],
  });
  const setup = await fixture(t, { sandbox });
  const { executor } = setup.createExecutor({ limits: { maxSessions: 1 } });
  await executor.recover();
  const session = await executor.start(startRequest());
  const profileAction = {
    type: "run_profile",
    actionId: "profile-before-cancel",
    expectedWorkspaceRevision: session.workspaceRevision,
    profileId: "node-tests",
  };
  const interrupted = await executor.perform({
    sessionId: session.id,
    action: profileAction,
  });
  const request = cancellationRequest(interrupted.session, {
    expectedWorkspaceRevision: profileAction.expectedWorkspaceRevision,
    expectedAction: {
      actionId: profileAction.actionId,
      actionDigest: digestValue(profileAction),
    },
  });

  assert.equal(interrupted.session.status, "interrupted");
  assert.equal(interrupted.session.cleanupPending, true);
  await assert.rejects(
    executor.reconcileCancellation(request),
    hasCode("CLEANUP_PENDING"),
  );
  const pending = await executor.view({ sessionId: session.id });
  assert.equal(pending.status, "cancelling");
  assert.equal(pending.cleanupPending, true);
  await assert.rejects(executor.start(startRequest({ sessionId: "while-cleaning" })), { code: "SESSION_LIMIT" });
  assert.equal(sandbox.cleanupCalls.length, 1);
  assert.equal(
    await readFile(attemptFile(setup, session.id, 1), "utf8"),
    "export const value = 1;\n",
  );

  const settled = await executor.reconcileCancellation(request);
  assert.equal(settled.session.status, "cancelled");
  assert.equal(settled.session.cleanupPending, false);
  assert.equal(settled.proof.sandboxCleanupConfirmed, true);
  assert.equal(sandbox.cleanupCalls.length, 2);
  assert.equal((await executor.start(startRequest({ sessionId: "after-cleanup" }))).status, "active");
  await assert.rejects(
    readFile(attemptFile(setup, session.id, 1)),
    (error) => error?.code === "ENOENT",
  );
});

test("cancellation discards every workspace from a resumed session", async (t) => {
  const setup = await fixture(t);
  const baseBroker = setup.createBroker();
  let loseFirstWriteResult = true;
  const broker = overrideBroker(baseBroker, {
    writeFile: async (request) => {
      const result = await baseBroker.writeFile(request);
      if (loseFirstWriteResult) {
        loseFirstWriteResult = false;
        throw new Error("first attempt write result was lost");
      }
      return result;
    },
  });
  const { executor } = setup.createExecutor({ broker });
  await executor.recover();
  const session = await executor.start(startRequest());
  const read = await executor.perform(
    actionRequest(session, {
      type: "read_text",
      actionId: "read-before-multi-attempt",
      path: "src/app.js",
    }),
  );
  const interrupted = await executor.perform(
    actionRequest(read.session, {
      type: "write_text",
      actionId: "unknown-first-attempt",
      path: "src/app.js",
      content: "export const discarded = true;\n",
      expectedSha256: read.result.sha256,
    }),
  );
  assert.equal(interrupted.session.status, "interrupted");
  const resumed = await executor.resume(sessionRequest(session.id));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.attempt.number, 2);
  assert.equal(
    await readFile(attemptFile(setup, session.id, 1), "utf8"),
    "export const discarded = true;\n",
  );
  assert.equal(
    await readFile(attemptFile(setup, session.id, 2), "utf8"),
    "export const value = 1;\n",
  );

  const settled = await executor.reconcileCancellation(
    cancellationRequest(resumed),
  );
  assert.deepEqual(
    settled.proof.discardedAttempts,
    [1, 2].map((number) => ({
      attemptNumber: number,
      executionId: attemptExecutionIdFor(session.id, number),
      disposition: "discarded",
    })),
  );
  for (const number of [1, 2]) {
    await assert.rejects(
      readFile(attemptFile(setup, session.id, number)),
      (error) => error?.code === "ENOENT",
    );
  }
});

test("cancellation binds both its digest and the exact admitted action", async (t) => {
  const setup = await fixture(t);
  const { executor } = setup.createExecutor();
  await executor.recover();
  const session = await executor.start(startRequest());
  const readAction = {
    type: "read_text",
    actionId: "read-bound-to-cancel",
    expectedWorkspaceRevision: session.workspaceRevision,
    path: "src/app.js",
  };
  const read = await executor.perform({
    sessionId: session.id,
    action: readAction,
  });
  const request = cancellationRequest(read.session, {
    expectedWorkspaceRevision: readAction.expectedWorkspaceRevision,
    expectedAction: {
      actionId: readAction.actionId,
      actionDigest: digestValue(readAction),
    },
  });

  await assert.rejects(
    executor.reconcileCancellation({
      ...request,
      expectedAction: {
        ...request.expectedAction,
        actionDigest: "f".repeat(64),
      },
    }),
    hasCode("EXECUTION_BINDING_MISMATCH"),
  );
  const settled = await executor.reconcileCancellation(request);
  assert.equal(settled.session.status, "cancelled");
  await assert.rejects(
    executor.reconcileCancellation({
      ...request,
      cancellationDigest: "e".repeat(64),
    }),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
  await assert.rejects(
    executor.reconcileCancellation({
      ...request,
      expectedAction: {
        actionId: "different-action",
        actionDigest: digestValue({ action: "different" }),
      },
    }),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
});
