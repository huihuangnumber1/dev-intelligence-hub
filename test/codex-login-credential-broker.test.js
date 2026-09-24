import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createProductionCodexLoginCredentialBroker,
  createTestCodexLoginCredentialBroker,
} from "../src/adapters/codex-login-credential-broker.js";
import { createTestSupervisedCliBrainProvider } from "../src/adapters/supervised-cli-brain-provider.js";
import {
  createTestCodexLoginCredentialStore,
} from "../src/lib/codex-login-credential-store.js";
import {
  createTestSupervisedProcessRunner,
} from "../src/lib/supervised-process-runner.js";
import {
  prepareCleanupTreesByIdentity,
} from "../src/lib/private-directory-manager.js";

function brokerFailure(code) {
  return Object.assign(new Error(`fictional ${code} private detail`), { code });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
}

async function directoryIdentity(directory) {
  const resolved = await realpath(directory);
  const details = await lstat(resolved, { bigint: true });
  return Object.freeze({
    path: resolved,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

async function fixtureCleanupSession(roots) {
  let closed = false;
  return Object.freeze({
    async commit() {
      assert.equal(closed, false);
      closed = true;
      for (const identity of roots) {
        assert.deepEqual(await directoryIdentity(identity.path), identity);
        await rm(identity.path, { recursive: true, force: false });
      }
    },
    async close() { closed = true; },
  });
}

async function fixture(t, overrides = {}) {
  const root = overrides.root ??
    await mkdtemp(path.join(tmpdir(), "mydashboard-codex-broker-"));
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const probeRoot = path.join(root, "probe-root");
  const protectedRoot = path.join(root, "protected-root");
  const invocationPath = path.join(root, "provider-invocation");
  await mkdir(protectedRoot, { recursive: true });
  await mkdir(invocationPath, { recursive: true });
  const calls = {
    beginTask: [],
    stageTask: [],
    captureTask: [],
    stageProbe: [],
    locator: [],
    process: [],
    prepare: [],
    cleanup: [],
  };
  let snapshotSequence = 0;
  const store = overrides.storeFactory?.({ root, probeRoot, protectedRoot }) ??
    overrides.store ?? {
    async beginTask(options) {
      calls.beginTask.push(options);
      snapshotSequence += 1;
      return Object.freeze(Object.create(null, {
        sequence: { value: snapshotSequence },
      }));
    },
    async stageTask(options) { calls.stageTask.push(options); },
    async captureTask(options) { calls.captureTask.push(options); },
    async stageProbe(options) { calls.stageProbe.push(options); },
  };
  const descriptor = Object.freeze({
    command: path.join(root, "codex.exe"),
    prefixArgs: Object.freeze([]),
  });
  const commandLocator = overrides.commandLocator ?? {
    async resolve(kind, options) {
      calls.locator.push({ kind, options });
      return descriptor;
    },
  };
  const processRunner = overrides.processRunner ?? {
    async run(options) {
      calls.process.push(options);
      return {
        exitCode: 0,
        signal: null,
        stdout: "Logged in using ChatGPT\r\n",
        stderr: "",
        stdoutBytes: 27,
        stderrBytes: 0,
      };
    },
  };
  const privateDirectoryManager = overrides.privateDirectoryManager ?? {
    async prepare({ directory, signal, validateLocation }) {
      if (signal?.aborted) throw brokerFailure("ABORT_ERR");
      await validateLocation();
      await mkdir(directory, { recursive: false }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await validateLocation();
      const identity = await directoryIdentity(directory);
      calls.prepare.push(identity);
      return identity;
    },
  };
  const prepareCleanupTrees = overrides.prepareCleanupTrees ?? (async (roots, options) => {
    calls.cleanup.push({ roots, options });
    let closed = false;
    return Object.freeze({
      async commit() {
        assert.equal(closed, false);
        closed = true;
        for (const identity of roots) {
          assert.deepEqual(await directoryIdentity(identity.path), identity);
          await rm(identity.path, { recursive: true, force: false });
        }
      },
      async close() { closed = true; },
    });
  });
  let uuidSequence = overrides.uuidSequenceStart ?? 0;
  const broker = createTestCodexLoginCredentialBroker({
    probeRoot,
    protectedRoots: [protectedRoot],
  }, {
    store,
    commandLocator,
    processRunner,
    privateDirectoryManager,
    prepareCleanupTrees,
    randomUUID() {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    },
    ...(overrides.clock ? { clock: overrides.clock } : {}),
    ...(overrides.processId ? { processId: overrides.processId } : {}),
    ...(overrides.isProcessAlive
      ? { isProcessAlive: overrides.isProcessAlive }
      : {}),
    ...(overrides.statusTimeoutMs
      ? { statusTimeoutMs: overrides.statusTimeoutMs }
      : {}),
    ...(overrides.operationTimeoutMs
      ? { operationTimeoutMs: overrides.operationTimeoutMs }
      : {}),
  });
  return {
    broker,
    calls,
    descriptor,
    invocation: await directoryIdentity(invocationPath),
    probeRoot,
    root,
  };
}

test("a safely cancelled provider turn leaves the real shared broker available", async (t) => {
  const current = await fixture(t);
  const controller = new AbortController();
  let first = true;
  const provider = createTestSupervisedCliBrainProvider({
    id: "broker-recovery", cliKind: "codex-cli", credentialMode: "codex-login",
  }, {
    temporaryRoot: path.join(current.root, "provider-runs"),
    environment: {},
    commandLocator: { async resolve() { return current.descriptor; } },
    codexLoginCredentialBroker: current.broker,
    processRunner: { async run() {
      return { exitCode: 0, signal: null, stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.alloc(0) };
    } },
    codexResultReader: async () => {
      if (first) { first = false; controller.abort(); }
      return '{"ok":true}';
    },
  });
  const request = {
    model: "fixture-model", messages: [{ role: "user", content: "fixture" }],
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  };
  await assert.rejects(provider.generate({ ...request, signal: controller.signal }), { code: "STRUCTURED_PROVIDER_CANCELLED" });
  assert.equal(await provider.generate(request), '{"ok":true}');
  assert.equal(current.calls.captureTask.length, 2);
  await provider.close();
  await current.broker.close();
});

function realStoreHarness({ root, probeRoot, protectedRoot }) {
  const locations = {
    sourceFile: path.join(root, "host-codex", "auth.json"),
    mirrorRoot: path.join(root, "credential-mirror"),
    mirrorDirectory: path.join(root, "credential-mirror", "codex-login"),
    probeRoot,
  };
  const privateFiles = new Map();
  let source = Buffer.from("fictional-integrated-host-login-v1");
  let sourceFailure = null;
  const key = (directory, name) => {
    const directoryPath = typeof directory === "string"
      ? directory
      : directory.path;
    return `${directoryPath}\n${name}`;
  };
  const privateDirectoryManager = {
    async prepare({ directory, signal, validateLocation }) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      await validateLocation();
      await mkdir(directory, { recursive: true });
      await validateLocation();
      return directoryIdentity(directory);
    },
  };
  const filePort = {
    async readSource() {
      if (sourceFailure !== null) throw sourceFailure;
      return Buffer.from(source);
    },
    async readPrivate({ directory, name, required }) {
      const value = privateFiles.get(key(directory, name));
      if (value === undefined && required) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value === undefined ? null : Buffer.from(value);
    },
    async writeNewPrivate({ directory, name, bytes }) {
      const fileKey = key(directory, name);
      if (privateFiles.has(fileKey)) throw new Error("target exists");
      privateFiles.set(fileKey, Buffer.from(bytes));
    },
    async replacePrivate({ directory, name, bytes }) {
      const fileKey = key(directory, name);
      if (!privateFiles.has(fileKey)) throw new Error("target missing");
      privateFiles.set(fileKey, Buffer.from(bytes));
    },
    async removePrivate({ directory, name }) {
      privateFiles.delete(key(directory, name));
    },
  };
  const createStore = () => createTestCodexLoginCredentialStore({
    locations,
    protectedRoots: [protectedRoot],
    now: () => new Date("2026-08-11T08:30:00.000Z"),
  }, {
    async canonicalizePath(candidate) { return path.resolve(candidate); },
    filePort,
    privateDirectoryManager,
  });
  return {
    createStore,
    sourceBytes() { return Buffer.from(source); },
    setSource(bytes) {
      source = Buffer.from(bytes);
      sourceFailure = null;
    },
    failSource(code) {
      sourceFailure = Object.assign(new Error("fictional private source failure"), {
        code,
      });
    },
    privateBytes(directory, name = "auth.json") {
      const value = privateFiles.get(key(directory, name));
      return value === undefined ? undefined : Buffer.from(value);
    },
    setPrivate(directory, bytes, name = "auth.json") {
      privateFiles.set(key(directory, name), Buffer.from(bytes));
    },
    mirrorBytes() {
      return this.privateBytes(locations.mirrorDirectory, "credential.json");
    },
  };
}

test("FIFO admission removes a cancelled waiter without reordering later work", async (t) => {
  const current = await fixture(t);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const thirdController = new AbortController();
  const first = await current.broker.acquire({ signal: firstController.signal });
  const second = current.broker.acquire({ signal: secondController.signal });
  const third = current.broker.acquire({ signal: thirdController.signal });

  secondController.abort();
  await assert.rejects(second, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  assert.equal(current.calls.beginTask.length, 1);

  first.release({ safe: true });
  const thirdLease = await third;
  assert.equal(current.calls.beginTask.length, 2);
  assert.equal(current.calls.stageTask.length, 0);
  assert.equal(current.calls.process.length, 0);
  thirdLease.release({ safe: true });
  await current.broker.close();
});

test("a failed beginTask releases FIFO ownership for the next waiter", async (t) => {
  let attempts = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        attempts += 1;
        if (attempts === 1) {
          throw brokerFailure("CODEX_LOGIN_FILE_UNAVAILABLE");
        }
        return Object.freeze(Object.create(null));
      },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() {},
    },
  });

  const first = current.broker.acquire({ signal: new AbortController().signal });
  const second = current.broker.acquire({ signal: new AbortController().signal });
  await assert.rejects(first, {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const lease = await second;
  assert.equal(attempts, 2);
  lease.release({ safe: true });
  await current.broker.close();
});

test("a blocked beginTask permanently fences later admission", async (t) => {
  let attempts = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        attempts += 1;
        throw brokerFailure("CODEX_LOGIN_BROKER_BLOCKED");
      },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() {},
    },
  });

  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  assert.equal(attempts, 1, "a blocked credential store must not be called again");
  await current.broker.close();
});

test("a task lease stages and captures one isolated Codex home exactly once", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });

  const staged = await lease.stage({ invocation: current.invocation, signal });
  assert.equal(staged.codexHome, path.join(current.invocation.path, "codex-home"));
  assert.equal(current.calls.stageTask.length, 1);
  assert.equal(current.calls.stageTask[0].codexHome.path, staged.codexHome);
  assert.equal(Object.isFrozen(current.calls.stageTask[0].codexHome), true);
  await lease.capture({ signal });
  assert.equal(current.calls.captureTask.length, 1);
  assert.equal(
    current.calls.captureTask[0].codexHome,
    current.calls.stageTask[0].codexHome,
  );

  await assert.rejects(
    lease.stage({ invocation: current.invocation, signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(lease.capture({ signal }), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  lease.release({ safe: true });
  assert.throws(
    () => lease.release({ safe: true }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("an unsafe release permanently blocks queued and future task leases", async (t) => {
  const current = await fixture(t);
  const first = await current.broker.acquire({ signal: new AbortController().signal });
  const queued = current.broker.acquire({ signal: new AbortController().signal });

  first.release({ safe: false });
  await assert.rejects(queued, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("close rejects queued admission and waits for the active lease", async (t) => {
  const current = await fixture(t);
  const active = await current.broker.acquire({ signal: new AbortController().signal });
  const queued = current.broker.acquire({ signal: new AbortController().signal });
  const closeResult = deferred();
  void current.broker.close().then(closeResult.resolve, closeResult.reject);

  await assert.rejects(queued, { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
  const marker = Symbol("still waiting");
  assert.equal(await Promise.race([closeResult.promise, Promise.resolve(marker)]), marker);
  active.release({ safe: true });
  await closeResult.promise;
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("an aborted close reports a stable cleanup failure without force-releasing work", async (t) => {
  const current = await fixture(t);
  const active = await current.broker.acquire({ signal: new AbortController().signal });
  const controller = new AbortController();
  const closing = current.broker.close({ signal: controller.signal });
  controller.abort();
  await assert.rejects(closing, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  active.release({ safe: true });
  await current.broker.close();
});

test("readStatus runs only a bounded no-model login probe and removes its tree", async (t) => {
  const current = await fixture(t);
  const result = await current.broker.readStatus();

  assert.deepEqual(result, {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(current.calls.beginTask.length, 0);
  assert.equal(current.calls.stageProbe.length, 1);
  assert.deepEqual(current.calls.locator.map(({ kind }) => kind), ["codex-cli"]);
  assert.equal(current.calls.process.length, 1);
  const run = current.calls.process[0];
  assert.equal(run.executable, current.descriptor);
  assert.deepEqual(run.args, ["login", "status"]);
  assert.equal(run.input.length, 0);
  assert.equal(run.timeoutMs, 90_000);
  assert.equal(run.maxStdoutBytes <= 4_096, true);
  assert.equal(run.maxStderrBytes <= 4_096, true);
  assert.equal(path.isAbsolute(run.cwd), true);
  assert.equal(run.env.CODEX_HOME, current.calls.stageProbe[0].codexHome.path);
  assert.equal(run.env.HOME.startsWith(`${run.cwd}${path.sep}`), true);
  assert.equal(run.env.USERPROFILE, run.env.HOME);
  assert.equal(Object.hasOwn(run.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(run.env, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(run.env, "GITHUB_TOKEN"), false);
  assert.equal(Object.hasOwn(run.env, "NODE_OPTIONS"), false);
  assert.equal(current.calls.cleanup.length, 1);
  await assert.rejects(readFile(run.cwd), { code: "ENOENT" });
  await current.broker.close();
});

test("simultaneous readStatus callers share one isolated login probe", async (t) => {
  const probeStarted = deferred();
  const releaseProbe = deferred();
  let probes = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() { return Object.freeze(Object.create(null)); },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() {
        probes += 1;
        probeStarted.resolve();
        await releaseProbe.promise;
      },
    },
  });

  const first = current.broker.readStatus({
    signal: new AbortController().signal,
  });
  await probeStarted.promise;
  const second = current.broker.readStatus({
    signal: new AbortController().signal,
  });
  releaseProbe.resolve();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(({ state }) => state), ["available", "available"]);
  assert.equal(probes, 1);
  await current.broker.close();
});

test("readStatus accepts the exact Codex login status on stderr only", async (t) => {
  const current = await fixture(t, {
    processRunner: {
      async run() {
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "Logged in using ChatGPT\r\n",
        };
      },
    },
  });

  assert.equal((await current.broker.readStatus()).state, "available");
  await current.broker.close();
});

test("readStatus rejects otherwise valid status with additional stream output", async (t) => {
  for (const [stdout, stderr] of [
    ["Logged in using ChatGPT\n", "unexpected warning\n"],
    ["unexpected warning\n", "Logged in using ChatGPT\n"],
  ]) {
    await t.test(`${stdout.startsWith("Logged") ? "stderr" : "stdout"} extra`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() {
            return { exitCode: 0, signal: null, stdout, stderr };
          },
        },
      });

      assert.equal(
        (await current.broker.readStatus()).state,
        "file_login_unavailable",
      );
      await current.broker.close();
    });
  }
});

test("readStatus maps credential and CLI failures without leaking their detail", async (t) => {
  for (const [sourceCode, expectedState, locatorCalls] of [
    ["CODEX_LOGIN_FILE_UNAVAILABLE", "file_login_unavailable", 0],
    ["CODEX_LOGIN_SOURCE_UNSAFE", "unsafe_source", 0],
    ["CODEX_LOGIN_BROKER_BLOCKED", "broker_blocked", 0],
  ]) {
    await t.test(sourceCode, async (child) => {
      const current = await fixture(child, {
        store: {
          async beginTask() {},
          async stageTask() {},
          async captureTask() {},
          async stageProbe() { throw brokerFailure(sourceCode); },
        },
      });
      const status = await current.broker.readStatus();
      assert.equal(status.state, expectedState);
      assert.equal(status.cliAvailable, true);
      assert.equal(status.fileLoginAvailable, false);
      assert.equal(current.calls.locator.length, locatorCalls);
      assert.equal(JSON.stringify(status).includes("fictional"), false);
      await current.broker.close();
    });
  }

  await t.test("CLI unavailable", async (child) => {
    const current = await fixture(child, {
      commandLocator: {
        async resolve() {
          throw brokerFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
        },
      },
    });
    const status = await current.broker.readStatus();
    assert.deepEqual(status, {
      schemaVersion: 1,
      state: "cli_unavailable",
      cliAvailable: false,
      fileLoginAvailable: false,
    });
    assert.equal(current.calls.process.length, 0);
    await current.broker.close();
  });
});

test("cancelling an active readStatus probe cleans up without fencing later work", async (t) => {
  const probeStarted = deferred();
  const current = await fixture(t, {
    store: {
      async beginTask() { return Object.freeze(Object.create(null)); },
      async stageTask() {},
      async captureTask() {},
      async stageProbe({ signal }) {
        probeStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(brokerFailure("ABORT_ERR")), {
            once: true,
          });
        });
      },
    },
  });
  const controller = new AbortController();
  const status = current.broker.readStatus({ signal: controller.signal });
  await probeStarted.promise;
  controller.abort();
  await assert.rejects(status, { code: "STRUCTURED_PROVIDER_CANCELLED" });

  const lease = await current.broker.acquire({ signal: new AbortController().signal });
  lease.release({ safe: true });
  await current.broker.close();
});

test("checkAvailability uses a task snapshot, captures refresh, and makes no model call", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  await current.broker.checkAvailability({ signal });

  assert.equal(current.calls.beginTask.length, 1);
  assert.equal(current.calls.stageTask.length, 1);
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.captureTask.length, 1);
  assert.equal(current.calls.process.length, 1);
  assert.deepEqual(current.calls.process[0].args, ["login", "status"]);
  assert.equal(current.calls.cleanup.length, 1);
  await current.broker.close();
});

test("checkAvailability treats an admitted credential operation as busy, not unavailable", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });

  await current.broker.checkAvailability({ signal });

  assert.equal(current.calls.beginTask.length, 1);
  assert.equal(current.calls.stageTask.length, 0);
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.process.length, 0);
  lease.release({ safe: true });

  assert.equal((await current.broker.readStatus({ signal })).state, "available");
  assert.equal(current.calls.stageProbe.length, 1);
  assert.equal(current.calls.process.length, 1);
  await current.broker.close();
});

test("readStatus treats an admitted credential operation as available without queuing a probe", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });
  await lease.stage({ invocation: current.invocation, signal });

  const status = await current.broker.readStatus({ signal });

  assert.deepEqual(status, {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  assert.equal(current.calls.beginTask.length, 1);
  assert.equal(current.calls.stageTask.length, 1);
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.process.length, 0);
  lease.release({ safe: true });
  await current.broker.close();
});

test("readStatus waits for an un-staged active lease instead of reporting available", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });
  const status = current.broker.readStatus({ signal });
  const pending = Symbol("status is queued");

  assert.equal(
    await Promise.race([status, Promise.resolve(pending)]),
    pending,
  );
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.process.length, 0);

  lease.release({ safe: true });
  assert.deepEqual(await status, {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  assert.equal(current.calls.stageProbe.length, 1);
  assert.equal(current.calls.process.length, 1);
  await current.broker.close();
});

test("readStatus resolves queued subscribers when the active lease finishes staging", async (t) => {
  const current = await fixture(t);
  const signal = new AbortController().signal;
  const lease = await current.broker.acquire({ signal });
  const statuses = Promise.all([
    current.broker.readStatus({ signal }),
    current.broker.readStatus({ signal }),
  ]);
  const pending = Symbol("status is queued");

  assert.equal(
    await Promise.race([statuses, Promise.resolve(pending)]),
    pending,
  );
  await lease.stage({ invocation: current.invocation, signal });

  assert.deepEqual(
    await statuses,
    Array.from({ length: 2 }, () => ({
      schemaVersion: 1,
      state: "available",
      cliAvailable: true,
      fileLoginAvailable: true,
    })),
  );
  assert.equal(current.calls.stageProbe.length, 0);
  assert.equal(current.calls.process.length, 0);
  lease.release({ safe: true });
  await current.broker.close();
});

test("readStatus does not report available while beginTask is still failing", async (t) => {
  const beginStarted = deferred();
  const releaseBegin = deferred();
  let probes = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        beginStarted.resolve();
        await releaseBegin.promise;
        throw brokerFailure("CODEX_LOGIN_FILE_UNAVAILABLE");
      },
      async stageTask() {},
      async captureTask() {},
      async stageProbe() { probes += 1; },
    },
  });
  const signal = new AbortController().signal;
  const acquisition = current.broker.acquire({ signal });
  await beginStarted.promise;
  const status = current.broker.readStatus({ signal });
  const pending = Symbol("status is queued");

  assert.equal(
    await Promise.race([status, Promise.resolve(pending)]),
    pending,
  );
  releaseBegin.resolve();

  await assert.rejects(acquisition, {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  assert.equal((await status).state, "available");
  assert.equal(probes, 1);
  assert.equal(current.calls.process.length, 1);
  await current.broker.close();
});

test("checkAvailability fences future work when credential publication is unsafe", async (t) => {
  let beginCalls = 0;
  const current = await fixture(t, {
    store: {
      async beginTask() {
        beginCalls += 1;
        return Object.freeze(Object.create(null));
      },
      async stageTask() {},
      async captureTask() {
        throw brokerFailure("CODEX_LOGIN_BROKER_BLOCKED");
      },
      async stageProbe() {},
    },
  });

  await assert.rejects(
    current.broker.checkAvailability({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  assert.equal(beginCalls, 1);
  await current.broker.close();
});

test("cleanup failure takes precedence over cancellation and fences the broker", async (t) => {
  const processStarted = deferred();
  const current = await fixture(t, {
    processRunner: {
      async run({ signal }) {
        processStarted.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(brokerFailure("ABORT_ERR")), {
            once: true,
          });
        });
      },
    },
    async prepareCleanupTrees() {
      throw brokerFailure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
    },
  });
  const controller = new AbortController();
  const check = current.broker.checkAvailability({ signal: controller.signal });
  await processStarted.promise;
  controller.abort();
  await assert.rejects(check, { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  await assert.rejects(
    current.broker.acquire({ signal: new AbortController().signal }),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  await current.broker.close();
});

test("a status probe can finish cleanup after the former ten-second limit", {
  timeout: 20_000,
}, async (t) => {
  let cleanupSignal;
  const current = await fixture(t, {
    async prepareCleanupTrees(roots, { signal }) {
      cleanupSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      if (signal.aborted) throw brokerFailure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      return Object.freeze({
        async commit() {
          for (const identity of roots) {
            assert.deepEqual(await directoryIdentity(identity.path), identity);
            await rm(identity.path, { recursive: true, force: false });
          }
        },
        async close() {},
      });
    },
  });

  assert.equal((await current.broker.readStatus()).state, "available");
  assert.equal(cleanupSignal.aborted, false);
  const lease = await current.broker.acquire({ signal: new AbortController().signal });
  lease.release({ safe: true });
  await current.broker.close();
});

test("abort plus reap failure never captures or cleans and permanently fences admission", async (t) => {
  for (const operation of ["readStatus", "checkAvailability"]) {
    await t.test(operation, async (child) => {
      const processStarted = deferred();
      const current = await fixture(child, {
        processRunner: {
          async run({ signal }) {
            processStarted.resolve();
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
            });
            throw brokerFailure("STRUCTURED_PROVIDER_REAP_FAILED");
          },
        },
      });
      const controller = new AbortController();
      const result = current.broker[operation]({ signal: controller.signal });
      await processStarted.promise;
      controller.abort();

      if (operation === "readStatus") {
        await assert.rejects(result, {
          code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
        });
      } else {
        await assert.rejects(result, {
          code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
        });
      }
      assert.equal(current.calls.captureTask.length, 0);
      assert.equal(current.calls.cleanup.length, 0);
      await assert.rejects(
        current.broker.acquire({ signal: new AbortController().signal }),
        { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
      );
      await current.broker.close();
    });
  }
});

test("availability captures every safely reaped status attempt before reporting failure", async (t) => {
  for (const [name, processRunner, expectedCode] of [
    [
      "clean nonzero production-shaped rejection",
      { async run() { throw brokerFailure("STRUCTURED_PROVIDER_PROCESS_EXITED"); } },
      "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    ],
    [
      "generic supervised process failure",
      { async run() { throw brokerFailure("STRUCTURED_PROVIDER_PROCESS_FAILED"); } },
      "STRUCTURED_PROVIDER_UNAVAILABLE",
    ],
    [
      "timeout production-shaped rejection",
      { async run() { throw brokerFailure("STRUCTURED_PROVIDER_TIMEOUT"); } },
      "STRUCTURED_PROVIDER_TIMEOUT",
    ],
    [
      "wrong status text",
      {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: "Not logged in",
            stderr: "",
          };
        },
      },
      "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    ],
  ]) {
    await t.test(name, async (child) => {
      const events = [];
      const current = await fixture(child, {
        store: {
          async beginTask() {
            events.push("begin");
            return Object.freeze(Object.create(null));
          },
          async stageTask() { events.push("stage"); },
          async captureTask() { events.push("capture"); },
          async stageProbe() {},
        },
        processRunner: {
          async run(options) {
            events.push("run");
            return processRunner.run(options);
          },
        },
        async prepareCleanupTrees(roots, options) {
          events.push("cleanup");
          return fixtureCleanupSession(roots, options);
        },
      });

      await assert.rejects(
        current.broker.checkAvailability({
          signal: new AbortController().signal,
        }),
        { code: expectedCode },
      );
      assert.deepEqual(events, ["begin", "stage", "run", "capture", "cleanup"]);
      const next = await current.broker.acquire({
        signal: new AbortController().signal,
      });
      next.release({ safe: true });
      await current.broker.close();
    });
  }
});

test("real supervised runner distinguishes a clean nonzero status from stream failure", async (t) => {
  const descriptor = Object.freeze({
    command: process.execPath,
    prefixArgs: Object.freeze([]),
  });
  const directRunner = createTestSupervisedProcessRunner({
    descriptorMaterializer: async (value) => value,
    platform: process.platform,
  });
  const cleanNonzero = await fixture(t, {
    commandLocator: { async resolve() { return descriptor; } },
    processRunner: directRunner,
  });
  assert.equal(
    (await cleanNonzero.broker.readStatus()).state,
    "file_login_unavailable",
  );
  await cleanNonzero.broker.close();

  const privateCanary = "private-stream-failure-must-not-escape";
  const streamRunner = createTestSupervisedProcessRunner({
    descriptorMaterializer: async (value) => value,
    platform: "linux",
    treeTerminator: async () => ({ status: "completed" }),
    spawnImpl() {
      const child = new EventEmitter();
      child.pid = 424_242;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdout.on("error", () => {});
      queueMicrotask(() => {
        child.stdout.emit("error", new Error(privateCanary));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  const streamFailure = await fixture(t, {
    commandLocator: { async resolve() { return descriptor; } },
    processRunner: streamRunner,
  });
  const status = await streamFailure.broker.readStatus();
  assert.equal(status.state, "cli_unavailable");
  assert.equal(JSON.stringify(status).includes(privateCanary), false);
  await streamFailure.broker.close();
});

test("default readStatus budget includes bounded secure probe preparation", {
  timeout: 35_000,
}, async (t) => {
  const current = await fixture(t, {
    store: {
      async beginTask() { return Object.freeze(Object.create(null)); },
      async stageTask() {},
      async captureTask() {},
      async stageProbe({ signal }) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 31_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(brokerFailure("ABORT_ERR"));
          }, { once: true });
        });
      },
    },
  });

  assert.equal((await current.broker.readStatus()).state, "available");
  await current.broker.close();
});

test("default readStatus budget includes supervised CLI startup under host load", async (t) => {
  const current = await fixture(t, {
    processRunner: {
      async run({ timeoutMs }) {
        if (timeoutMs < 90_000) {
          throw brokerFailure("STRUCTURED_PROVIDER_TIMEOUT");
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: "Logged in using ChatGPT\n",
          stderr: "",
          stdoutBytes: 26,
          stderrBytes: 0,
        };
      },
    },
  });

  assert.equal((await current.broker.readStatus()).state, "available");
  await current.broker.close();
});

test("internal broker deadline is a timeout while caller abort remains cancellation", async (t) => {
  const statusStarted = deferred();
  const statusFixture = await fixture(t, {
    statusTimeoutMs: 5,
    operationTimeoutMs: 2_000,
    processRunner: {
      async run({ signal }) {
        statusStarted.resolve();
        await waitForAbort(signal);
        throw brokerFailure("STRUCTURED_PROVIDER_CANCELLED");
      },
    },
  });
  const statusResult = statusFixture.broker.readStatus();
  await statusStarted.promise;
  assert.equal((await statusResult).state, "cli_unavailable");
  await statusFixture.broker.close();

  const started = deferred();
  const current = await fixture(t, {
    statusTimeoutMs: 5,
    operationTimeoutMs: 2_000,
    processRunner: {
      async run({ signal }) {
        started.resolve();
        await waitForAbort(signal);
        throw brokerFailure("STRUCTURED_PROVIDER_CANCELLED");
      },
    },
  });

  const internalDeadline = current.broker.checkAvailability();
  await started.promise;
  await assert.rejects(internalDeadline, {
    code: "STRUCTURED_PROVIDER_TIMEOUT",
  });
  const afterTimeout = await current.broker.acquire({
    signal: new AbortController().signal,
  });
  afterTimeout.release({ safe: true });
  await current.broker.close();

  const callerStarted = deferred();
  const caller = await fixture(t, {
    statusTimeoutMs: 5,
    operationTimeoutMs: 5_000,
    processRunner: {
      async run({ signal }) {
        callerStarted.resolve();
        await waitForAbort(signal);
        throw brokerFailure("STRUCTURED_PROVIDER_CANCELLED");
      },
    },
  });
  const controller = new AbortController();
  const cancelled = caller.broker.checkAvailability({ signal: controller.signal });
  await callerStarted.promise;
  controller.abort();
  await assert.rejects(cancelled, {
    code: "STRUCTURED_PROVIDER_CANCELLED",
  });
  await caller.broker.close();
});

test("an operation deadline reached during credential capture cannot become success", async (t) => {
  const captureStarted = deferred();
  const releaseCapture = deferred();
  let operationSignal = null;
  const store = {
    async beginTask({ signal }) {
      operationSignal = signal;
      return Object.freeze({ sequence: 1 });
    },
    async stageTask() {},
    async captureTask() {
      captureStarted.resolve();
      await releaseCapture.promise;
    },
    async stageProbe() {},
  };
  const current = await fixture(t, {
    store,
    statusTimeoutMs: 5,
    operationTimeoutMs: 2_000,
  });

  const availability = current.broker.checkAvailability();
  await captureStarted.promise;
  await waitForAbort(operationSignal);
  releaseCapture.resolve();
  await assert.rejects(availability, {
    code: "STRUCTURED_PROVIDER_TIMEOUT",
  });
  await current.broker.close();
});

test("caller cancellation reached during mandatory cleanup cannot become success", async (t) => {
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const current = await fixture(t, {
    prepareCleanupTrees: async (roots) => {
      let closed = false;
      return Object.freeze({
        async commit() {
          assert.equal(closed, false);
          cleanupStarted.resolve();
          await releaseCleanup.promise;
          closed = true;
          for (const identity of roots) {
            assert.deepEqual(await directoryIdentity(identity.path), identity);
            await rm(identity.path, { recursive: true, force: false });
          }
        },
        async close() { closed = true; },
      });
    },
  });
  const controller = new AbortController();

  const status = current.broker.readStatus({ signal: controller.signal });
  await cleanupStarted.promise;
  controller.abort();
  releaseCleanup.resolve();
  await assert.rejects(status, {
    code: "STRUCTURED_PROVIDER_CANCELLED",
  });
  await current.broker.close();
});

test("broker composes with the real store across fresh, restart, logout, unsafe, and changed sources", async (t) => {
  let credentials;
  let refreshOnNextStatus = null;
  const observedCredentials = [];
  const processRunner = {
    async run({ env }) {
      const staged = credentials.privateBytes(env.CODEX_HOME);
      observedCredentials.push(staged);
      if (refreshOnNextStatus !== null) {
        credentials.setPrivate(env.CODEX_HOME, refreshOnNextStatus);
        refreshOnNextStatus = null;
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
      };
    },
  };
  const first = await fixture(t, {
    storeFactory(locations) {
      credentials = realStoreHarness(locations);
      return credentials.createStore();
    },
    processRunner,
  });

  const fresh = await first.broker.readStatus();
  assert.equal(fresh.state, "available");
  assert.deepEqual(observedCredentials.at(-1), credentials.sourceBytes());
  assert.equal(credentials.mirrorBytes(), undefined);

  const refreshed = Buffer.from("fictional-integrated-refreshed-login-v2");
  refreshOnNextStatus = refreshed;
  await first.broker.checkAvailability({
    signal: new AbortController().signal,
  });
  assert.notEqual(credentials.mirrorBytes(), undefined);
  await first.broker.close();

  const restarted = await fixture(t, {
    root: first.root,
    store: credentials.createStore(),
    processRunner,
    uuidSequenceStart: 100,
  });
  assert.equal((await restarted.broker.readStatus()).state, "available");
  assert.deepEqual(observedCredentials.at(-1), refreshed);

  credentials.failSource("ENOENT");
  assert.equal(
    (await restarted.broker.readStatus()).state,
    "file_login_unavailable",
  );
  credentials.setSource(Buffer.from("fictional-integrated-host-login-v1"));
  assert.equal((await restarted.broker.readStatus()).state, "available");

  credentials.failSource("CODEX_CREDENTIAL_SOURCE_UNSAFE");
  assert.equal((await restarted.broker.readStatus()).state, "unsafe_source");

  const changed = Buffer.from("fictional-integrated-host-login-v3");
  credentials.setSource(changed);
  assert.equal((await restarted.broker.readStatus()).state, "available");
  assert.deepEqual(observedCredentials.at(-1), changed);
  assert.equal(
    JSON.stringify(await restarted.broker.readStatus()).includes("fictional"),
    false,
  );
  await restarted.broker.close();
});

test("every probe has an owner marker before credentials reach the child", async (t) => {
  let marker;
  const current = await fixture(t, {
    processId: 4242,
    clock: () => Date.parse("2026-08-11T08:30:00.000Z"),
    processRunner: {
      async run({ cwd }) {
        marker = JSON.parse(await readFile(
          path.join(cwd, ".mydashboard-invocation.json"),
          "utf8",
        ));
        return {
          exitCode: 0,
          signal: null,
          stdout: "Logged in using ChatGPT\n",
          stderr: "",
        };
      },
    },
  });

  await current.broker.readStatus();

  assert.deepEqual(marker, {
    schemaVersion: 1,
    kind: "codex-login-probe",
    ownerPid: 4242,
    createdAt: "2026-08-11T08:30:00.000Z",
  });
  await current.broker.close();
});

test("partial probe creation is rolled back before admission remains usable", async (t) => {
  let failedDirectory = null;
  let failOnce = true;
  const manager = {
    async prepare({ directory, signal, validateLocation }) {
      await validateLocation();
      await mkdir(directory, { recursive: true });
      await validateLocation();
      if (failOnce && /^probe-[0-9a-f]/u.test(path.basename(directory))) {
        failOnce = false;
        failedDirectory = directory;
        throw brokerFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
      }
      return directoryIdentity(directory);
    },
  };
  const current = await fixture(t, { privateDirectoryManager: manager });

  assert.equal((await current.broker.readStatus()).state, "cli_unavailable");
  await assert.rejects(lstat(failedDirectory), { code: "ENOENT" });
  const lease = await current.broker.acquire({
    signal: new AbortController().signal,
  });
  lease.release({ safe: true });
  await current.broker.close();
});

test("a restarted broker scavenges only a stale dead-owner probe", async (t) => {
  const now = Date.parse("2026-08-11T08:30:00.000Z");
  const current = await fixture(t, {
    clock: () => now,
    processId: 2222,
    isProcessAlive: (pid) => pid !== 1111,
  });
  await mkdir(current.probeRoot, { recursive: true });
  const stale = path.join(
    current.probeRoot,
    "probe-00000000-0000-4000-8000-000000000999",
  );
  await mkdir(stale);
  await writeFile(
    path.join(stale, ".mydashboard-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "codex-login-probe",
      ownerPid: 1111,
      createdAt: "2026-08-09T08:29:59.000Z",
    }),
    "utf8",
  );
  await writeFile(path.join(stale, "auth.json"), "fictional stale login", "utf8");

  assert.equal((await current.broker.readStatus()).state, "available");

  await assert.rejects(lstat(stale), { code: "ENOENT" });
  await current.broker.close();
});

test("a restarted broker safely handles missing and partial owner markers", async (t) => {
  const now = Date.parse("2026-08-11T08:30:00.000Z");
  const staleAt = Date.parse("2026-08-09T08:29:59.000Z");
  const youngAt = Date.parse("2026-08-11T08:29:59.000Z");
  const current = await fixture(t, {
    clock: () => now,
    processId: 4444,
    isProcessAlive: (pid) => pid === 2222,
  });
  await mkdir(current.probeRoot, { recursive: true });
  const encodedName = (pid, createdAt, suffix) =>
    `probe-${pid}-${createdAt}-00000000-0000-4000-8000-${suffix}`;
  const staleMissing = path.join(
    current.probeRoot,
    encodedName(1111, staleAt, "00000000010a"),
  );
  const stalePartial = path.join(
    current.probeRoot,
    encodedName(1111, staleAt, "00000000010b"),
  );
  const staleLive = path.join(
    current.probeRoot,
    encodedName(2222, staleAt, "00000000010c"),
  );
  const youngDead = path.join(
    current.probeRoot,
    encodedName(3333, youngAt, "00000000010d"),
  );
  for (const directory of [staleMissing, stalePartial, staleLive, youngDead]) {
    await mkdir(directory);
  }
  await writeFile(
    path.join(stalePartial, ".mydashboard-invocation.json"),
    "{\"schemaVersion\":",
    "utf8",
  );

  assert.equal((await current.broker.readStatus()).state, "available");
  await assert.rejects(lstat(staleMissing), { code: "ENOENT" });
  await assert.rejects(lstat(stalePartial), { code: "ENOENT" });
  assert.equal((await lstat(staleLive)).isDirectory(), true);
  assert.equal((await lstat(youngDead)).isDirectory(), true);
  await current.broker.close();
});

test("probe scavenging accepts and batches the 128 and 129 entry boundaries", async (t) => {
  const now = Date.parse("2026-08-11T08:30:00.000Z");
  for (const count of [128, 129]) {
    await t.test(`${count} stale probes`, async (child) => {
      const current = await fixture(child, {
        clock: () => now,
        processId: 4444,
        isProcessAlive: () => false,
        uuidSequenceStart: count + 1,
        prepareCleanupTrees: async (roots, options) => {
          assert.equal(options.maximumEntriesPerRoot, 128);
          assert.ok(options.maximumEntries >= roots.length * 2);
          return fixtureCleanupSession(roots);
        },
      });
      await mkdir(current.probeRoot, { recursive: true });
      for (let index = 1; index <= count; index += 1) {
        const directory = path.join(
          current.probeRoot,
          `probe-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        await mkdir(directory);
        await writeFile(
          path.join(directory, ".mydashboard-invocation.json"),
          JSON.stringify({
            schemaVersion: 1,
            kind: "codex-login-probe",
            ownerPid: 1111,
            createdAt: "2026-08-09T08:29:59.000Z",
          }),
          "utf8",
        );
      }

      assert.equal((await current.broker.readStatus()).state, "available");
      for (let index = 1; index <= count; index += 1) {
        await assert.rejects(
          lstat(path.join(
            current.probeRoot,
            `probe-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          )),
          { code: "ENOENT" },
        );
      }
      await current.broker.close();
    });
  }
});

test("production cleanup accepts the 128 and 129 stale-probe boundaries", {
  skip: process.platform !== "win32" || process.arch !== "x64"
    ? "production cleanup is Windows x64 only"
    : false,
}, async (t) => {
  const now = Date.parse("2026-08-11T08:30:00.000Z");
  for (const count of [128, 129]) {
    await t.test(`${count} production-cleaned probes`, async (child) => {
      const current = await fixture(child, {
        clock: () => now,
        processId: 4444,
        isProcessAlive: () => false,
        uuidSequenceStart: count + 1,
        prepareCleanupTrees: prepareCleanupTreesByIdentity,
      });
      await mkdir(current.probeRoot, { recursive: true });
      for (let index = 1; index <= count; index += 1) {
        const directory = path.join(
          current.probeRoot,
          `probe-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        await mkdir(directory);
        await writeFile(
          path.join(directory, ".mydashboard-invocation.json"),
          JSON.stringify({
            schemaVersion: 1,
            kind: "codex-login-probe",
            ownerPid: 1111,
            createdAt: "2026-08-09T08:29:59.000Z",
          }),
          "utf8",
        );
      }

      assert.equal((await current.broker.readStatus()).state, "available");
      for (let index = 1; index <= count; index += 1) {
        await assert.rejects(
          lstat(path.join(
            current.probeRoot,
            `probe-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          )),
          { code: "ENOENT" },
        );
      }
      await current.broker.close();
    });
  }
});

test("test construction accepts production-shaped class ports", async (t) => {
  class Locator {
    async resolve() {
      throw brokerFailure("STRUCTURED_PROVIDER_UNAVAILABLE");
    }
  }
  class Runner {
    async run() {
      throw new Error("must not run");
    }
  }
  const current = await fixture(t, {
    commandLocator: new Locator(),
    processRunner: new Runner(),
  });
  const status = await current.broker.readStatus();
  assert.equal(status.state, "cli_unavailable");
  await current.broker.close();
});

test("production construction rejects replacement or forged authority", () => {
  assert.throws(
    () => createProductionCodexLoginCredentialBroker({}),
    /lexical composition grant/u,
  );
  assert.throws(
    () => createTestCodexLoginCredentialBroker({}, {}),
    /test dependencies are invalid/u,
  );
});
