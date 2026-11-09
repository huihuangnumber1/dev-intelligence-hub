import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexCliSessionStore } from "../src/adapters/codex-cli-session-store.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { createCodeReadContext } from "../src/lib/code-read-context.js";
import { createCodeExecutionContext } from "../src/lib/code-execution-context.js";

const BRAIN = Object.freeze({
  provider: "codex",
  model: "bounded-model",
  remoteData: Object.freeze({
    requirements: true,
    code: true,
    memory: false,
  }),
});

test("quiescence requires a provider witness and canonicalizes the same PR identity as generation", async () => {
  const unsupported = new BrainRouter({ providers: [provider()] });
  assert.deepEqual(await unsupported.withEntityQuiescence(BRAIN, { entityKey: 'github:pull_request:Owner/Repo#42' },
    () => assert.fail('unsupported provider cannot certify a stop')), { executed: false });
  const router = new BrainRouter({ providers: [provider({ async withEntityQuiescence(request, operation) {
    assert.equal(request.entityKey, 'github:pull_request:owner/repo#42');
    return { executed: true, result: await operation() };
  } })] });
  assert.deepEqual(await router.withEntityQuiescence(BRAIN, { entityKey: 'github:pull_request:Owner/Repo#42' },
    () => 'host-cleanup'), { executed: true, result: 'host-cleanup' });
});

test("BrainRouter shares scheduling identity across authorization scopes without merging sessions", async () => {
  const calls = [], reservations = [];
  const router = new BrainRouter({ providers: [provider({ supportsEntitySessions: true,
    sessionIsolationKey: "native:login", supportsReviewReading: true,
    async withAdmission(request, operation) { reservations.push(request.entityKey); return operation(); },
    async generate(request) { calls.push(request); return '{"ok":true}'; },
  })] });
  const sessionKey = "github:pull_request:Owner/Repo#42";
  const request = { sessionKey, messages: [], schema: { type: "object" }, dataClasses: ["code"] };
  await router.withAdmission(BRAIN, { entityKey: sessionKey }, () => router.generate({ ...request, brain: BRAIN }));
  await router.generate({ ...request, brain: { ...BRAIN, model: "different-model" } });
  await router.generate({ ...request, brain: { ...BRAIN, remoteData: { ...BRAIN.remoteData, memory: true } } });
  await router.generate({ ...request, brain: BRAIN, dataClasses: ["requirements", "code"] });
  assert.deepEqual(reservations, ["github:pull_request:owner/repo#42"]);
  assert.equal(calls.every(call => call.admissionEntityKey === reservations[0]), true);
  assert.equal(new Set(calls.map(call => call.sessionKey)).size, 4);
  assert.equal(calls.every(call => /^auth-v2:[a-f0-9]{64}$/u.test(call.sessionKey)), true);
});

function provider(overrides = {}) {
  return {
    id: "codex",
    remote: true,
    async generate() { return '{"ok":true}'; },
    ...overrides,
  };
}

test("BrainRouter preserves and invokes an optional provider availability check", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability({ signal }) {
        calls.push(signal);
      },
    })],
  });
  const controller = new AbortController();

  await router.checkAvailability(BRAIN, { signal: controller.signal });

  assert.deepEqual(calls, [controller.signal]);
});

test("BrainRouter forwards an assigned reasoning effort to the provider", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });
  const brain = {
    ...BRAIN,
    reasoningEffort: "high",
  };

  await router.generate({
    brain,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, "high");
});

test("BrainRouter forwards an entity session key to the provider", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      supportsEntitySessions: true,
      sessionIsolationKey: "codex-cli:api-key",
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:pull_request:example/software#24256",
  });

  assert.match(calls[0].sessionKey, /^auth-v2:[a-f0-9]{64}$/u);
  assert.notEqual(calls[0].sessionKey, "github:pull_request:example/software#24256");
});

test("BrainRouter partitions persistent history by provider, credential mode, policy and cumulative request classes", async () => {
  const calls = [];
  const makeProvider = (id, isolationKey) => ({
    ...provider(),
    id,
    supportsEntitySessions: true,
    sessionIsolationKey: isolationKey,
    async generate(request) {
      calls.push({ id, isolationKey, sessionKey: request.sessionKey });
      return '{"ok":true}';
    },
  });
  const router = new BrainRouter({ providers: [
    makeProvider("codex", "codex-cli:api-key"),
    makeProvider("other", "codex-cli:codex-login"),
  ] });
  const entity = "github:issue:example/product#12953";
  const request = (brain, dataClasses) => router.generate({
    brain,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses,
    sessionKey: entity,
  });
  const enabled = { ...BRAIN, remoteData: { requirements: true, code: true, memory: true } };
  await request(enabled, ["requirements", "memory"]);
  await request(enabled, ["memory", "requirements"]);
  await request(BRAIN, ["requirements"]);
  await request(enabled, ["requirements"]);
  await request({ ...enabled, provider: "other" }, ["requirements", "memory"]);
  assert.equal(calls[0].sessionKey, calls[1].sessionKey);
  for (const index of [2, 3, 4]) assert.notEqual(calls[index].sessionKey, calls[0].sessionKey);
  assert.notEqual(calls[2].sessionKey, calls[3].sessionKey);
  assert.notEqual(calls[3].sessionKey, calls[4].sessionKey);
  assert.equal(calls.every(({ sessionKey }) => sessionKey !== entity), true);
});

test("BrainRouter separates credential modes even when the configured provider ID is unchanged", async () => {
  const keys = [];
  const makeRouter = (sessionIsolationKey) => new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
    sessionIsolationKey,
    async generate({ sessionKey }) { keys.push(sessionKey); return '{"ok":true}'; },
  })] });
  const request = (router) => router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:issue:example/product#12953",
  });
  await request(makeRouter("codex-cli:api-key"));
  await request(makeRouter("codex-cli:codex-login"));
  assert.notEqual(keys[0], keys[1]);
});

test("BrainRouter leaves an unattested legacy CLI archive byte-for-byte intact", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "brain-router-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "store");
  const oldHome = path.join(directory, "old-home");
  const newHome = path.join(directory, "new-home");
  const legacyKey = "github:issue:example/product#12953";
  await mkdir(path.join(oldHome, "sessions"), { recursive: true });
  await writeFile(path.join(oldHome, "sessions", "rollout-legacy-id.jsonl"), "legacy memory history\n");
  const store = new CodexCliSessionStore({ root });
  await store.capture({ sessionKey: legacyKey, sessionId: "legacy-id", codexHome: oldHome });
  const [oldEntry] = await readdir(root);
  const oldRollout = path.join(root, oldEntry, "profile", "sessions", "rollout-legacy-id.jsonl");
  const oldMetadata = path.join(root, oldEntry, "metadata.json");
  const originalBytes = await Promise.all([readFile(oldRollout), readFile(oldMetadata)]);
  const stages = [];
  const router = new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
    sessionIsolationKey: "codex-cli:api-key",
    async generate({ sessionKey }) {
      stages.push(await store.stage({ sessionKey, codexHome: newHome }));
      return '{"ok":true}';
    },
  })] });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: legacyKey,
  });

  assert.deepEqual(stages, [{ sessionId: null }]);
  assert.deepEqual(await readFile(oldRollout), originalBytes[0]);
  assert.deepEqual(await readFile(oldMetadata), originalBytes[1]);
  assert.deepEqual(await readdir(root), [oldEntry]);
});

test("BrainRouter requires an explicit isolation scope for persistent providers", () => {
  assert.throws(() => new BrainRouter({ providers: [provider({
    supportsEntitySessions: true,
  })] }), /session isolation key is invalid/u);
});

test("BrainRouter keeps non-session providers stateless for entity work", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [provider({
      async generate(request) {
        calls.push(request);
        return '{"ok":true}';
      },
    })],
  });

  await router.generate({
    brain: BRAIN,
    messages: [{ role: "user", content: "Return JSON." }],
    schema: { type: "object" },
    dataClasses: ["requirements"],
    sessionKey: "github:issue:example/product#12953",
  });

  assert.equal(Object.hasOwn(calls[0], "sessionKey"), false);
});

test("BrainRouter preserves prototype-defined availability", async () => {
  let calls = 0;
  class Provider {
    constructor() {
      this.id = "codex";
      this.remote = true;
    }

    async generate() { return '{"ok":true}'; }

    async checkAvailability() { calls += 1; }
  }
  const router = new BrainRouter({ providers: [new Provider()] });
  await router.checkAvailability(BRAIN);
  assert.equal(calls, 1);
});

test("BrainRouter treats a provider without an availability check as available", async () => {
  const router = new BrainRouter({ providers: [provider()] });
  assert.equal(await router.checkAvailability(BRAIN), undefined);
});

test("BrainRouter rejects cancellation before invoking provider availability", async () => {
  let calls = 0;
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability() { calls += 1; },
    })],
  });
  const controller = new AbortController();
  controller.abort(new Error("private reason"));

  await assert.rejects(
    router.checkAvailability(BRAIN, { signal: controller.signal }),
    (error) => error?.code === "BRAIN_REQUEST_CANCELLED" &&
      !error.message.includes("private reason"),
  );
  assert.equal(calls, 0);
});

test("BrainRouter propagates a stable provider availability failure", async () => {
  const expected = Object.assign(new Error("credential unavailable"), {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const router = new BrainRouter({
    providers: [provider({
      async checkAvailability() { throw expected; },
    })],
  });

  await assert.rejects(router.checkAvailability(BRAIN), (error) => error === expected);
});


test("PR read access requires code authorization and is forwarded only to a capable provider", async () => {
  const requests = [];
  const router = new BrainRouter({ providers: [provider({ supportsReviewReading: true, async generate(request) { requests.push(request); return '{"ok":true}'; } })] });
  const reviewTarget = { pullRequestNumber: 42 };
  const request = { brain: BRAIN, messages: [], schema: { type: "object" }, reviewTarget };
  await assert.rejects(router.generate({ ...request, dataClasses: ["requirements"] }), { code: "REMOTE_DATA_CLASSIFICATION_REQUIRED" });
  await assert.rejects(router.generate({ ...request, brain: { ...BRAIN, remoteData: { ...BRAIN.remoteData, code: false } }, dataClasses: ["code"] }), { code: "REMOTE_DATA_NOT_AUTHORIZED" });
  assert.equal(requests.length, 0);
  await router.generate({ ...request, dataClasses: ["code"] });
  assert.deepEqual(requests[0].reviewTarget, reviewTarget);
  assert.equal(router.describe(BRAIN).supportsReviewReading, true);
});

test("opaque controlled code reading preserves authorization, capability identity and provider support", async () => {
  const context = createCodeReadContext({ jobId: "job-one", workspaceRevision: "a".repeat(64), documents: [] });
  const calls = [];
  const router = new BrainRouter({ providers: [provider({ supportsCodeReading: true, async generate(value) { calls.push(value); return '{"ok":true}'; } })] });
  const request = { brain: BRAIN, messages: [], schema: { type: "object" }, codeReadContext: context };
  await assert.rejects(router.generate({ ...request, dataClasses: ["requirements"] }), { code: "REMOTE_DATA_CLASSIFICATION_REQUIRED" });
  await assert.rejects(router.generate({ ...request, brain: { ...BRAIN, remoteData: { ...BRAIN.remoteData, code: false } }, dataClasses: ["code"] }), { code: "REMOTE_DATA_NOT_AUTHORIZED" });
  await assert.rejects(router.generate({ ...request, codeReadContext: structuredClone(context), dataClasses: ["code"] }), { code: "REMOTE_DATA_CLASSIFICATION_REQUIRED" });
  const unsupported = new BrainRouter({ providers: [provider()] });
  await assert.rejects(unsupported.generate({ ...request, dataClasses: ["code"] }), { code: "CODE_READING_UNAVAILABLE" });
  assert.equal(calls.length, 0);
  await router.generate({ ...request, dataClasses: ["code"] });
  assert.equal(calls[0].codeReadContext, context);
  assert.equal(router.describe(BRAIN).supportsCodeReading, true);
});

test("continuous code execution preserves opaque authority and never leaks into review or unsupported providers", async () => {
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {} });
  const calls = [];
  const router = new BrainRouter({ providers: [provider({ supportsCodeExecution: true,
    async generate(value) { calls.push(value); return '{"ok":true}'; } })] });
  const request = { brain: BRAIN, messages: [], schema: { type: "object" }, codeExecutionContext: context };
  for (const overrides of [
    { dataClasses: ["requirements"] },
    { dataClasses: ["code"], codeExecutionContext: structuredClone(context) },
    { dataClasses: ["code"], reviewTarget: { pullRequestNumber: 42 } },
    { dataClasses: ["code"], codeReadContext: createCodeReadContext({ jobId: "job", workspaceRevision: "a".repeat(64), documents: [] }) },
  ]) await assert.rejects(router.generate({ ...request, ...overrides }), { code: "REMOTE_DATA_CLASSIFICATION_REQUIRED" });
  await assert.rejects(router.generate({ ...request, dataClasses: ["code"], brain: { ...BRAIN, remoteData: { ...BRAIN.remoteData, code: false } } }), { code: "REMOTE_DATA_NOT_AUTHORIZED" });
  await assert.rejects(new BrainRouter({ providers: [provider()] }).generate({ ...request, dataClasses: ["code"] }), { code: "CODE_EXECUTION_UNAVAILABLE" });
  assert.equal(calls.length, 0);
  await router.generate({ ...request, dataClasses: ["code"] });
  assert.equal(calls[0].codeExecutionContext, context);
  assert.equal(router.describe(BRAIN).supportsCodeExecution, true);
  assert.equal(Object.hasOwn(calls[0], "reviewTarget"), false);
});
