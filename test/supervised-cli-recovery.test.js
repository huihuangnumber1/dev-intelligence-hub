import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, truncate } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createTestSupervisedCliBrainProvider } from "../src/adapters/supervised-cli-brain-provider.js";
import { createTestSupervisedProcessRunner } from "../src/lib/supervised-process-runner.js";
import { CodexCliSessionStore } from "../src/adapters/codex-cli-session-store.js";
import { controlledProviderTime, withinRealTime, CONTROLLED_PROVIDER_TEST_TIMEOUT_MS } from './support/controlled-provider-time.mjs';

const success = () => ({ exitCode: 0, signal: null, stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.alloc(0) });
const failure = (code = "STRUCTURED_PROVIDER_PROCESS_FAILED") => Object.assign(new Error("fixture failure"), { code });
const request = (extra = {}) => ({
  model: "fixture-model",
  messages: [{ role: "user", content: "fixture request" }],
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  ...extra,
});
const descriptor = { command: path.join(path.parse(process.cwd()).root, "fixture-codex.exe"), prefixArgs: [] };

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "supervised-cli-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let brokerBlocked = false;
  const broker = {
    async readStatus() { return { state: "available", cliAvailable: true, fileLoginAvailable: true }; },
    async acquire() {
      if (brokerBlocked) throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
      return {
        async stage({ invocation }) {
          const codexHome = path.join(invocation.path, "codex-home");
          await mkdir(codexHome);
          return { codexHome };
        },
        async capture() { events.push("credential-captured"); },
        release({ safe }) { events.push(`release:${safe}`); brokerBlocked ||= !safe; },
      };
    },
  };
  const temporaryRoot = path.join(root, "runtime");
  const provider = createTestSupervisedCliBrainProvider({
    id: "recovery-test", cliKind: "codex-cli", credentialMode: "codex-login", timeoutMs: 1_000,
  }, {
    environment: {}, temporaryRoot, commandLocator: { async resolve() { return descriptor; } },
    codexLoginCredentialBroker: broker,
    processRunner: { async run() { events.push("process-reaped"); return success(); } },
    codexResultReader: async () => '{"ok":true}',
    ...overrides,
  });
  return { provider, events, temporaryRoot };
}

for (const deadlineFirst of [false, true]) {
test(deadlineFirst
  ? "recovery times out before a result-reader cancellation can be requested"
  : "recovery cleans a safely reaped cancelled turn before admitting another login turn", { timeout: CONTROLLED_PROVIDER_TEST_TIMEOUT_MS }, async (t) => {
  // Fixture preparation and capture can exceed a second under parallel load.
  // Own both clocks so cancellation follows observed runner settlement/result entry,
  // independently of parallel-suite disk latency. Exercise the opposite order too.
  const time = controlledProviderTime(t);
  const resultRead = time.phase('result-reader');
  const controller = new AbortController();
  let activeController = controller;
  let generation;
  t.after(async () => {
    try {
      activeController.abort(); time.advance(1_000);
      await withinRealTime(3_000, generation?.catch(() => {}));
    } finally { time.restore(); }
  });
  let first = true;
  let resultReads = 0;
  const current = await fixture(t, {
    monotonicClock: time.monotonicClock,
    processRunner: { async run() {
      current.events.push("process-reaped");
      if (first && deadlineFirst) {
        first = false;
        time.advance(1_001);
      }
      return success();
    } },
    codexResultReader: async () => {
      resultReads += 1;
      if (first) {
        first = false;
        assert.deepEqual(current.events, ["process-reaped", "credential-captured"]);
        resultRead.enter();
        controller.abort();
      }
      return '{"ok":true}';
    },
  });
  generation = current.provider.generate(request({ signal: controller.signal }));
  const rejected = assert.rejects(generation, {
    code: deadlineFirst ? "STRUCTURED_PROVIDER_TIMEOUT" : "STRUCTURED_PROVIDER_CANCELLED",
  });
  if (!deadlineFirst) await resultRead.waitFor(rejected);
  await rejected;
  assert.equal(controller.signal.aborted, !deadlineFirst);
  assert.equal(resultReads, deadlineFirst ? 0 : 1);
  assert.deepEqual(current.events, ["process-reaped", "credential-captured", "release:true"]);
  assert.deepEqual(await readdir(current.temporaryRoot), []);
  activeController = new AbortController();
  generation = current.provider.generate(request({ signal: activeController.signal }));
  assert.equal(await generation, '{"ok":true}');
});
}

test("recovery waits for actual runner settlement after cancellation", { timeout: CONTROLLED_PROVIDER_TEST_TIMEOUT_MS }, async (t) => {
  const time = controlledProviderTime(t);
  const controller = new AbortController();
  const started = time.phase('runner-started');
  let rejectRunner;
  let outcome;
  t.after(async () => {
    try {
      controller.abort(); rejectRunner?.(failure('STRUCTURED_PROVIDER_CANCELLED')); time.advance(1_000);
      await withinRealTime(3_000, outcome);
    } finally { time.restore(); }
  });
  const current = await fixture(t, {
    monotonicClock: time.monotonicClock,
    processRunner: { run() { started.enter(); return new Promise((_, reject) => { rejectRunner = reject; }); } },
  });
  let publicSettled = false;
  outcome = current.provider.generate(request({ signal: controller.signal })).catch((error) => { publicSettled = true; return error; });
  await started.waitFor(outcome);
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publicSettled, false);
  assert.deepEqual(current.events, []);
  rejectRunner(failure("STRUCTURED_PROVIDER_CANCELLED"));
  assert.equal((await outcome).code, "STRUCTURED_PROVIDER_CANCELLED");
  assert.deepEqual(current.events, ["credential-captured", "release:true"]);
});

test("recovery preserves timeout after a safe exit and permits the next turn", async (t) => {
  let monotonicTime = 10_000;
  let first = true;
  const current = await fixture(t, {
    monotonicClock: () => monotonicTime,
    processRunner: { async run() {
      if (first) { first = false; monotonicTime += 1_001; }
      return success();
    } },
  });
  await assert.rejects(current.provider.generate(request()), { code: "STRUCTURED_PROVIDER_TIMEOUT" });
  assert.deepEqual(current.events, ["credential-captured", "release:true"]);
  assert.equal(await current.provider.generate(request()), '{"ok":true}');
});

test("recovery captures the bound session after a safely reaped nonzero exit", async (t) => {
  const captures = [];
  const current = await fixture(t, {
    processRunner: { async run() { throw failure(); } },
    codexSessionStore: {
      async stage() { return { sessionId: "existing-thread" }; },
      async capture(value) { captures.push(value.sessionId); },
    },
  });
  await assert.rejects(current.provider.generate(request({ sessionKey: "github:issue:owner/repo#1" })), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  assert.deepEqual(captures, ["existing-thread"]);
  assert.deepEqual(current.events, ["credential-captured", "release:true"]);
});

test("retained session recovery diagnostics survive a later credential deadline", async (t) => {
  let monotonicTime = 10_000;
  const current = await fixture(t, {
    monotonicClock: () => monotonicTime,
    processRunner: { async run() { throw failure(); } },
    codexSessionStore: {
      async stage() { return { sessionId: "existing-thread" }; },
      async capture() { monotonicTime += 1_001; throw failure("STRUCTURED_PROVIDER_TIMEOUT"); },
    },
  });
  await assert.rejects(current.provider.generate(request({ sessionKey: "github:issue:owner/repo#1" })), {
    code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
  });
  assert.deepEqual(current.events, ["release:false"]);
  assert.equal((await readdir(current.temporaryRoot)).length, 1);
});

for (const legacyMarker of [false, true]) {
test(`a cold provider preserves a dead invocation's unarchived session (legacy marker: ${legacyMarker})`, async (t) => {
  const createdAt = Date.parse("2026-09-01T00:00:00Z");
  const current = await fixture(t, {
    clock: () => createdAt,
    processRunner: { async run(value) {
      const sessions = path.join(value.env.CODEX_HOME, "sessions");
      await mkdir(sessions);
      await writeFile(path.join(sessions, "rollout-unknown.jsonl"), "only copy of task progress");
      throw failure();
    } },
    codexSessionStore: { async stage() { return { sessionId: null }; }, async capture() { assert.fail("no trusted thread id"); } },
  });
  const input = request({ sessionKey: "github:issue:owner/repo#3" });
  await assert.rejects(current.provider.generate(input), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  const [invocation] = await readdir(current.temporaryRoot);
  if (legacyMarker) {
    await writeFile(path.join(current.temporaryRoot, invocation, ".mydashboard-invocation.json"), JSON.stringify({
      schemaVersion: 1, kind: "codex-cli", ownerPid: process.pid, createdAt: new Date(createdAt).toISOString(),
    }));
  }
  // A fresh module has no in-memory root fences, just as after a service restart.
  const cold = await import(`../src/adapters/supervised-cli-brain-provider.js?cold-recovery=${Date.now()}`);
  let runs = 0;
  const provider = cold.createTestSupervisedCliBrainProvider({
    id: "cold-recovery", cliKind: "codex-cli", credentialMode: "codex-login", timeoutMs: 1_000,
  }, {
    environment: {}, temporaryRoot: current.temporaryRoot,
    commandLocator: { async resolve() { return descriptor; } },
    codexLoginCredentialBroker: { async readStatus() { return { state: "available", cliAvailable: true, fileLoginAvailable: true }; }, async acquire() {
      return { async stage({ invocation }) { const codexHome = path.join(invocation.path, "codex-home"); await mkdir(codexHome); return { codexHome }; }, async capture() {}, release() {} };
    } },
    clock: () => createdAt + 48 * 60 * 60 * 1_000,
    isProcessAlive: () => false,
    processRunner: { async run() { runs++; return success(); } },
    codexResultReader: async () => '{"ok":true}',
    codexSessionStore: { async stage() { return { sessionId: null }; }, async capture() {} },
  });
  await assert.rejects(provider.generate(input), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(runs, 0);
  assert.equal(await readFile(path.join(current.temporaryRoot, invocation, "codex-home", "sessions", "rollout-unknown.jsonl"), "utf8"), "only copy of task progress");
});
}

test("recovery captures the first failed thread from private supervised output", async (t) => {
  const captures = [];
  let calls = 0;
  let processError;
  const runner = createTestSupervisedProcessRunner({
    platform: "linux", descriptorMaterializer: async (value) => value,
    treeTerminator: async () => {},
    spawnImpl() {
      const child = new EventEmitter();
      child.pid = 424242;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on("finish", () => {
        child.stdout.write('{"type":"thread.started","thread_id":"first-failed-thread"}\n{"type":"item.started"');
        child.stderr.write("private-stderr-must-not-leak");
        child.emit("close", 1, null);
      });
      return child;
    },
  });
  const current = await fixture(t, {
    processRunner: { async run(value) {
      if (calls++ > 0) assert.equal(value.args[value.args.indexOf("resume") + 1], "first-failed-thread");
      try { return await runner.run(value); } catch (error) { processError = error; throw error; }
    } },
    codexSessionStore: { async stage() { return { sessionId: captures.at(-1) ?? null }; }, async capture(value) { captures.push(value.sessionId); } },
  });
  await assert.rejects(current.provider.generate(request({ sessionKey: "github:pull_request:owner/repo#1" })), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  assert.deepEqual(captures, ["first-failed-thread"]);
  assert.equal(JSON.stringify(processError).includes("first-failed-thread"), false);
  assert.equal(Object.getOwnPropertyNames(processError).includes("stdout"), false);
  assert.equal(Object.getOwnPropertyNames(processError).includes("stderr"), false);
  assert.deepEqual(current.events, ["credential-captured", "release:true"]);
  await assert.rejects(current.provider.generate(request({ sessionKey: "github:pull_request:owner/repo#1" })), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  assert.deepEqual(captures, ["first-failed-thread", "first-failed-thread"]);
});

test("recovery leaves an ordinary pre-session startup failure recoverable", async (t) => {
  const current = await fixture(t, {
    processRunner: { async run() { throw failure(); } },
    codexSessionStore: { async stage() { return { sessionId: null }; }, async capture() { assert.fail("no session exists"); } },
  });
  const input = request({ sessionKey: "github:issue:owner/repo#2" });
  await assert.rejects(current.provider.generate(input), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  await assert.rejects(current.provider.generate(input), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
  assert.deepEqual(await readdir(current.temporaryRoot), []);
});

test("recovery preserves an unidentified first-turn rollout with an explicit diagnostic", async (t) => {
  let invocationPath;
  const current = await fixture(t, {
    processRunner: { async run(value) {
      invocationPath = value.cwd;
      const sessions = path.join(value.env.CODEX_HOME, "sessions");
      await mkdir(sessions);
      await writeFile(path.join(sessions, "rollout-unknown.jsonl"), "fixture progress");
      throw failure();
    } },
    codexSessionStore: { async stage() { return { sessionId: null }; }, async capture() { assert.fail("no trusted thread id"); } },
  });
  await assert.rejects(current.provider.generate(request({ sessionKey: "github:issue:owner/repo#3" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.ok((await readdir(invocationPath)).includes("codex-home"));
});

for (const transientMiB of [20, 65]) {
test(`archived session bytes have a separate allowance from ${transientMiB} MiB of transient state`, async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "recovery-size-store-"));
  t.after(() => rm(storeRoot, { recursive: true, force: true }));
  const store = new CodexCliSessionStore({ root: storeRoot });
  const current = await fixture(t, {
    codexSessionStore: store,
    processRunner: { async run(value) {
      const sessions = path.join(value.env.CODEX_HOME, "sessions");
      await mkdir(sessions);
      const rollout = path.join(sessions, "rollout-large-thread.jsonl");
      await writeFile(rollout, "");
      await truncate(rollout, 50 * 1024 * 1024);
      const sqlite = path.join(value.env.CODEX_HOME, "state_5.sqlite");
      await writeFile(sqlite, "");
      await truncate(sqlite, transientMiB * 1024 * 1024);
      return { ...success(), stdoutBytes: Buffer.from('{"type":"thread.started","thread_id":"large-thread"}\n') };
    } },
  });
  const input = request({ sessionKey: "github:issue:owner/repo#1" });
  if (transientMiB === 20) {
    assert.equal(await current.provider.generate(input), '{"ok":true}');
    assert.deepEqual(await readdir(current.temporaryRoot), []);
  } else {
    await assert.rejects(current.provider.generate(input), { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
    assert.equal((await readdir(current.temporaryRoot)).length, 1);
  }
  const [entry] = await readdir(storeRoot);
  assert.equal((await fileSystem.stat(path.join(storeRoot, entry, "profile", "sessions", "rollout-large-thread.jsonl"))).size, 50 * 1024 * 1024);
});
}

for (const state of ["intact", "missing", "changed", "wrong-binding", "live-owner"]) {
test(`cold recovery verifies a completed capture before removing residue (${state})`, async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "recovery-proof-store-"));
  t.after(() => rm(storeRoot, { recursive: true, force: true }));
  const store = new CodexCliSessionStore({ root: storeRoot });
  const current = await fixture(t, {
    codexSessionStore: store,
    cleanupFileSystem: { ...fileSystem, async unlink() { throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); } },
    processRunner: { async run(value) {
      const sessions = path.join(value.env.CODEX_HOME, "sessions");
      await mkdir(sessions);
      await writeFile(path.join(sessions, "rollout-saved-thread.jsonl"), "saved history");
      return { ...success(), stdoutBytes: Buffer.from('{"type":"thread.started","thread_id":"saved-thread"}\n') };
    } },
  });
  const input = request({ sessionKey: "github:issue:owner/repo#1" });
  await assert.rejects(current.provider.generate(input), { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  const [residue] = await readdir(current.temporaryRoot);
  const receipt = JSON.parse(await readFile(path.join(current.temporaryRoot, residue, ".mydashboard-session-capture.json"), "utf8"));
  assert.equal(receipt.sessionKey, input.sessionKey);
  if (state === "missing") await rm(storeRoot, { recursive: true, force: true });
  if (state === "changed") {
    const [entry] = await readdir(storeRoot);
    await writeFile(path.join(storeRoot, entry, "profile", "sessions", "rollout-saved-thread.jsonl"), "different history");
  }
  if (state === "wrong-binding") {
    await writeFile(path.join(current.temporaryRoot, residue, ".mydashboard-session-capture.json"), JSON.stringify({ ...receipt, sessionKey: "github:issue:owner/repo#99" }));
  }
  const cold = await import(`../src/adapters/supervised-cli-brain-provider.js?capture-proof=${Date.now()}-${state}`);
  let runs = 0;
  const provider = cold.createTestSupervisedCliBrainProvider({
    id: "cold-proof", cliKind: "codex-cli", credentialMode: "api-key", timeoutMs: 2_000,
  }, {
    environment: { OPENAI_API_KEY: "fixture" }, temporaryRoot: current.temporaryRoot,
    commandLocator: { async resolve() { return descriptor; } },
    isProcessAlive: () => state === "live-owner",
    processRunner: { async run() { runs++; return success(); } },
    codexResultReader: async () => '{"ok":true}',
    codexSessionStore: store,
  });
  if (state === "intact") {
    assert.equal(await provider.generate(request()), '{"ok":true}');
    assert.equal(runs, 1);
    assert.deepEqual(await readdir(current.temporaryRoot), []);
  } else {
    await assert.rejects(provider.generate(request()), { code: state === "live-owner" ? "STRUCTURED_PROVIDER_CLEANUP_FAILED" : "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
    assert.equal(runs, 0);
    assert.equal(await readFile(path.join(current.temporaryRoot, residue, "codex-home", "sessions", "rollout-saved-thread.jsonl"), "utf8"), "saved history");
  }
});
}
