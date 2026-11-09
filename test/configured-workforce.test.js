import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as configuredWorkforceApi from "../src/services/configured-workforce.js";
import { createCodeExecutionContext } from "../src/lib/code-execution-context.js";
import {
  createConfiguredBrainRouter,
  createConfiguredWorkforce,
  readConfiguredConstructionCleanup,
  createTestConfiguredBrainRouter,
  createTestConfiguredWorkforce,
} from "../src/services/configured-workforce.js";

function issueConstructionCleanupOwner() {
  const issue = configuredWorkforceApi.createConfiguredConstructionCleanupOwner;
  assert.equal(
    typeof issue,
    "function",
    "configured cleanup ownership must have a public issuer",
  );
  return issue();
}

function createOwnedTestConfiguredBrainRouter(options, dependencies) {
  return createTestConfiguredBrainRouter({
    constructionCleanupOwner: issueConstructionCleanupOwner(),
    ...options,
  }, dependencies);
}

function createOwnedTestConfiguredWorkforce(options, dependencies) {
  return createTestConfiguredWorkforce({
    constructionCleanupOwner: issueConstructionCleanupOwner(),
    ...options,
  }, dependencies);
}

const SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
});
const MESSAGES = Object.freeze([
  Object.freeze({ role: "system", content: "Return JSON." }),
  Object.freeze({ role: "user", content: "{}" }),
]);

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
  };
}

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function role(model, initialPaused = false) {
  return {
    name: "岗位",
    mission: "主动判断并推动工作",
    enabled: true,
    scheduleMinutes: 5,
    initialPaused,
    permissions: { allowedIntents: ["ask_user", "complete"] },
    brain: {
      provider: "ollama",
      model,
      remoteData: { requirements: false, code: false, memory: false },
    },
  };
}

function assignedTask(eventType, suffix = "1") {
  const assignmentId = `assignment-${suffix}`;
  return {
    itemId: `work-item-${suffix}`,
    kind: "assignment",
    assignmentId,
    assignment: {
      assignmentId,
      target: { type: "role", id: "developer" },
    },
    event: { eventType },
  };
}

test("workforce enables fair model waiting only when the host opts into automatic work", async () => {
  for (const waitForModelCapacity of [false, true]) {
    const calls = [];
    const selected = role("test-model"); selected.brain.provider = "cli";
    const workforce = createOwnedTestConfiguredWorkforce({
      waitForModelCapacity, brainProviders: { cli: { kind: "codex-cli", credentialMode: "codex-native-login" } },
      roles: { analyst: selected }, store: new MemoryStore(),
    }, { supervisedCliProviderFactory(options) { return {
      id: options.id, remote: true, singleAttempt: true,
      async generate() { assert.fail("admission alone must not launch a model"); },
      withAdmission(request, operation) { calls.push(request); return operation(); },
    }; } });
    let entered = 0;
    await workforce.workers[0].withDecisionAdmission({ item: { itemId: "work-42" } }, async () => { entered += 1; });
    assert.equal(entered, 1);
    assert.equal(calls[0].waitForCapacity === true, waitForModelCapacity);
    await workforce.close();
  }
});

test("workforce builds independently controlled roles over one local provider", async () => {
  const calls = [];
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    roles: {
      orchestrator: role("qwen3.5:9b"),
      developer: role("code-model", true),
    },
    store: new MemoryStore(),
    onRun: async (input) => calls.push(input),
  });

  assert.deepEqual(workforce.employees.map(({ id }) => id), [
    "orchestrator",
    "developer",
  ]);
  assert.deepEqual(workforce.workers.map(({ roleId }) => roleId), [
    "orchestrator",
    "developer",
  ]);
  await workforce.employees[0].run({ trigger: "manual" });
  assert.equal(calls[0].roleId, "orchestrator");
  assert.equal((await workforce.employees[1].roleView()).paused, true);
  assert.equal(Object.isFrozen(workforce.employees), true);
  assert.equal(Object.isFrozen(workforce.workers), true);
});

test("workforce preserves an optional high-capability task brain separately", async () => {
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
      "task-brain": {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11435",
        remote: true,
      },
    },
    roles: {
      developer: {
        ...role("routine-model"),
        taskBrain: {
          provider: "task-brain",
          model: "high-capability-model",
          remoteData: { requirements: true, code: true, memory: false },
        },
      },
      tester: role("test-model"),
    },
    store: new MemoryStore(),
  });

  const developer = await workforce.employees[0].roleView();
  assert.equal(developer.brain.model, "routine-model");
  assert.deepEqual(developer.taskBrain, {
    provider: "task-brain",
    model: "high-capability-model",
    remote: true,
    remoteData: { requirements: true, code: true, memory: false, dingtalk: false },
  });
  assert.equal(
    Object.hasOwn(await workforce.employees[1].roleView(), "taskBrain"),
    false,
  );

  assert.throws(
    () =>
      createConfiguredWorkforce({
        brainProviders: {
          ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
        },
        roles: {
          developer: {
            ...role("routine-model"),
            taskBrain: {
              provider: "missing",
              model: "high-capability-model",
              remoteData: { requirements: true, code: true, memory: false },
            },
          },
        },
        store: new MemoryStore(),
      }),
    /provider is unavailable/i,
  );
});

test("workforce forwards one run-only admission gate to every role brain", async () => {
  const blocked = Object.assign(new Error("runtime cutover"), {
    code: "RUNTIME_RESTART_REQUIRED",
  });
  let admissions = 0;
  let fetchCalls = 0;
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    roles: {
      orchestrator: role("qwen3.5:9b"),
      developer: role("code-model"),
    },
    store: new MemoryStore(),
    actionAdmissionGate: {
      run() {
        admissions += 1;
        throw blocked;
      },
    },
    dependencies: {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("blocked requests must not reach the provider");
      },
    },
  });

  for (const worker of workforce.workers) {
    await assert.rejects(
      worker.decide({ item: { event: { eventType: "issue.updated" } } }),
      (error) => error === blocked,
    );
  }

  assert.equal(admissions, 2);
  assert.equal(fetchCalls, 0);
});

test("workforce rejects unknown provider fields and the legacy PR role", () => {
  assert.throws(
    () =>
      createConfiguredWorkforce({
        brainProviders: { ollama: { kind: "ollama", token: "secret" } },
        roles: {},
        store: new MemoryStore(),
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      createConfiguredWorkforce({
        brainProviders: {},
        roles: { "pr-reviewer": role("qwen") },
        store: new MemoryStore(),
      }),
    /role id/,
  );
});

test("provider options are isolated by adapter kind", () => {
  assert.doesNotThrow(() =>
    createConfiguredWorkforce({
      brainProviders: {
        local: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          apiKeyEnv: "UNUSED_LOCAL_TOKEN",
        },
        remote: {
          kind: "openai-compatible",
          baseUrl: "https://models.example/v1",
          apiKeyEnv: "MODEL_TOKEN",
          contextTokens: 16_384,
        },
      },
      roles: {},
      store: new MemoryStore(),
      dependencies: {
        environment: { MODEL_TOKEN: "token" },
        fetch: async () => {
          throw new Error("provider construction must not call fetch");
        },
      },
    }),
  );
});

test("configured supervised CLIs stay remote and declare one process attempt", async () => {
  for (const kind of ["codex-cli", "claude-cli"]) {
    const router = createOwnedTestConfiguredBrainRouter(
      {
        brainProviders: {
          cli: { kind, remote: false },
        },
      },
      {
        supervisedCliProviderFactory(options) {
          return {
            id: options.id,
            remote: true,
            singleAttempt: true,
            async generate() { return '{"ok":true}'; },
          };
        },
      },
    );
    const configuredBrain = {
      provider: "cli",
      model: kind === "codex-cli" ? "gpt-5.6-codex" : "claude-opus-4-6",
      remoteData: { requirements: false, code: false, memory: false },
    };

    assert.deepEqual(router.describe(configuredBrain), {
      provider: "cli",
      model: configuredBrain.model,
      remote: true,
      remoteData: { requirements: false, code: false, memory: false },
      singleAttempt: true,
    });
    await assert.rejects(
      router.generate({
        brain: configuredBrain,
        messages: MESSAGES,
        schema: SCHEMA,
        dataClasses: ["requirements"],
      }),
      (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
    );
  }
});

test("configured routing carries explicit continuous execution support and opaque identity", async () => {
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {} });
  let received;
  const router = createOwnedTestConfiguredBrainRouter({ brainProviders: { cli: { kind: "codex-cli" } } }, {
    supervisedCliProviderFactory(options) {
      return { id: options.id, remote: true, supportsCodeExecution: true,
        async generate(value) { received = value; return '{"ok":true}'; } };
    },
  });
  const brain = { provider: "cli", model: "gpt-6.1-sol", remoteData: { requirements: true, code: true, memory: false } };
  assert.equal(router.describe(brain).supportsCodeExecution, true);
  await router.generate({ brain, messages: MESSAGES, schema: SCHEMA, dataClasses: ["code"], codeExecutionContext: context });
  assert.equal(received.codeExecutionContext, context);
  await router.close();
});

test("configured routing rejects execution-support accessors without invoking them", () => {
  let reads = 0;
  assert.throws(() => createOwnedTestConfiguredBrainRouter({ brainProviders: { cli: { kind: "codex-cli" } } }, {
    supervisedCliProviderFactory(options) {
      return { id: options.id, remote: true, get supportsCodeExecution() { reads++; return true; }, async generate() {} };
    },
  }), /code execution support is invalid/);
  assert.equal(reads, 0);
});

test("configured routing forwards credential mode and provider availability", async () => {
  const availabilityCalls = [];
  let receivedOptions = null;
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        cli: {
          kind: "codex-cli",
          credentialMode: "codex-login",
          remote: true,
        },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        receivedOptions = options;
        return {
          id: options.id,
          remote: true,
          singleAttempt: true,
          async checkAvailability(request) { availabilityCalls.push(request); },
          async generate() { return '{"ok":true}'; },
        };
      },
    },
  );
  const brain = {
    provider: "cli",
    model: "gpt-5.6-codex",
    remoteData: { requirements: true, code: true, memory: false },
  };
  const controller = new AbortController();

  await router.checkAvailability(brain, { signal: controller.signal });

  assert.equal(receivedOptions.credentialMode, "codex-login");
  assert.deepEqual(availabilityCalls, [{ signal: controller.signal }]);
});

test("configured Codex routing preserves stable entity sessions", async () => {
  const calls = [];
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        cli: { kind: "codex-cli", remote: true },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        return {
          id: options.id,
          remote: true,
          singleAttempt: true,
          supportsEntitySessions: true,
          async generate(request) {
            calls.push(request);
            return '{"ok":true}';
          },
        };
      },
    },
  );
  const sessionKey = "github:issue:example/product#12953";

  await router.generate({
    brain: {
      provider: "cli",
      model: "gpt-5.6-sol",
      remoteData: { requirements: true, code: false, memory: false },
    },
    messages: MESSAGES,
    schema: SCHEMA,
    dataClasses: ["requirements"],
    sessionKey,
  });

  assert.match(calls[0].sessionKey, /^auth-v2:[a-f0-9]{64}$/u);
  assert.notEqual(calls[0].sessionKey, sessionKey);
});

test("configured routing forwards only explicit review reading support", async () => {
  for (const supported of [undefined, false, true]) {
    const router = createOwnedTestConfiguredBrainRouter(
      { brainProviders: { cli: { kind: "codex-cli" } } },
      {
        supervisedCliProviderFactory(options) {
          return {
            id: options.id,
            remote: true,
            ...(supported === undefined ? {} : { supportsReviewReading: supported }),
            async generate() { return '{"ok":true}'; },
          };
        },
      },
    );
    const view = router.describe({
      provider: "cli",
      model: "gpt-6.1-sol",
      remoteData: { requirements: true, code: true, memory: false },
    });
    assert.equal(Object.hasOwn(view, "supportsReviewReading"), supported === true);
    if (supported === true) assert.equal(view.supportsReviewReading, true);
    await router.close();
  }
});

test("configured routing rejects invalid review reading declarations without invoking accessors", () => {
  let getterCalls = 0;
  for (const descriptor of [
    { value: "true" },
    { value: undefined },
    { get() { getterCalls += 1; return true; } },
  ]) {
    assert.throws(
      () => createOwnedTestConfiguredBrainRouter(
        { brainProviders: { cli: { kind: "codex-cli" } } },
        {
          supervisedCliProviderFactory(options) {
            const provider = {
              id: options.id,
              remote: true,
              async generate() { return '{"ok":true}'; },
            };
            Object.defineProperty(provider, "supportsReviewReading", descriptor);
            return provider;
          },
        },
      ),
      { name: "TypeError", message: "brain provider review reading support is invalid" },
    );
  }
  assert.equal(getterCalls, 0);
});

test("configured routing preserves prototype-defined provider availability", async () => {
  let availabilityCalls = 0;
  class CliProvider {
    constructor(id) {
      this.id = id;
      this.remote = true;
      this.singleAttempt = true;
    }

    async checkAvailability() { availabilityCalls += 1; }

    async generate() { return '{"ok":true}'; }
  }
  const router = createOwnedTestConfiguredBrainRouter(
    { brainProviders: { cli: { kind: "codex-cli" } } },
    {
      supervisedCliProviderFactory(options) {
        return new CliProvider(options.id);
      },
    },
  );

  await router.checkAvailability({
    provider: "cli",
    model: "gpt-5.6-codex",
    remoteData: { requirements: true, code: true, memory: false },
  });

  assert.equal(availabilityCalls, 1);
});

test("all configured Codex providers receive the same credential broker fact", () => {
  const broker = Object.freeze({
    async acquire() {},
    async checkAvailability() {},
  });
  const received = [];
  createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        first: { kind: "codex-cli", credentialMode: "codex-login" },
        second: { kind: "codex-cli", credentialMode: "codex-login" },
      },
      dependencies: {
        supervisedCliProtectedRoots: [path.join(process.cwd(), "data")],
        codexLoginCredentialBroker: broker,
      },
    },
    {
      supervisedCliProviderFactory(options, runtimeFacts) {
        received.push({ options, runtimeFacts });
        return {
          id: options.id,
          remote: true,
          singleAttempt: true,
          async checkAvailability() {},
          async generate() { return '{"ok":true}'; },
        };
      },
    },
  );

  assert.equal(received.length, 2);
  assert.equal(received[0].runtimeFacts.codexLoginCredentialBroker, broker);
  assert.equal(received[1].runtimeFacts.codexLoginCredentialBroker, broker);
});

test("production configured CLI routing fails closed without lexical composition authority", () => {
  for (const kind of ["codex-cli", "claude-cli"]) {
    assert.throws(
      () => createConfiguredBrainRouter({
        constructionCleanupOwner: issueConstructionCleanupOwner(),
        brainProviders: { cli: { kind } },
      }),
      /composition grant|composition authority/i,
    );
  }
});

test("configured routing forwards only code-owned protected roots to supervised CLI construction", () => {
  const protectedRoots = [
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "workspace"),
  ];
  let receivedRuntimeFacts = null;
  createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        cli: { kind: "codex-cli" },
      },
      dependencies: { supervisedCliProtectedRoots: protectedRoots },
    },
    {
      supervisedCliProviderFactory(options, runtimeFacts) {
        receivedRuntimeFacts = runtimeFacts;
        return {
          id: options.id,
          remote: true,
          singleAttempt: true,
          async generate() {
            return '{"ok":true}';
          },
        };
      },
    },
  );

  assert.deepEqual(receivedRuntimeFacts, { protectedRoots });
});

test("configured router fails closed before a CLI owner is acquired without a cleanup token", () => {
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    getOwnPropertyDescriptor() {
      dependencyReads += 1;
      return undefined;
    },
    ownKeys() {
      dependencyReads += 1;
      return [];
    },
  });

  assert.throws(
    () => createConfiguredBrainRouter({
      brainProviders: { cli: { kind: "codex-cli" } },
      dependencies,
    }),
    /construction cleanup owner/i,
  );
  assert.equal(dependencyReads, 0);
});

test("configured workforce fails closed before a CLI owner is acquired without a cleanup token", () => {
  let dependencyReads = 0;
  const dependencies = new Proxy({}, {
    getOwnPropertyDescriptor() {
      dependencyReads += 1;
      return undefined;
    },
    ownKeys() {
      dependencyReads += 1;
      return [];
    },
  });

  assert.throws(
    () => createConfiguredWorkforce({
      brainProviders: { cli: { kind: "codex-cli" } },
      roles: {},
      store: new MemoryStore(),
      dependencies,
    }),
    /construction cleanup owner/i,
  );
  assert.equal(dependencyReads, 0);
});

test("configured cleanup ownership rejects a forged token before acquisition", () => {
  const issuedOwner = issueConstructionCleanupOwner();
  assert.equal(Object.isFrozen(issuedOwner), true);
  let factoryCalls = 0;

  assert.throws(
    () => createTestConfiguredBrainRouter(
      {
        constructionCleanupOwner: Object.freeze({}),
        brainProviders: { cli: { kind: "codex-cli" } },
      },
      {
        supervisedCliProviderFactory() {
          factoryCalls += 1;
          throw new Error("factory must not run");
        },
      },
    ),
    /construction cleanup owner.*invalid/i,
  );
  assert.equal(factoryCalls, 0);
});

test("configured router captures a shared owner's one-shot close accessor once", async () => {
  let closeReads = 0;
  let closeCalls = 0;
  const sharedOwner = {
    id: "unset",
    remote: true,
    singleAttempt: true,
    async generate() {
      return '{"ok":true}';
    },
    get close() {
      closeReads += 1;
      if (closeReads > 1) {
        throw new Error("shared owner close accessor was read again");
      }
      return async function closeSharedOwner() {
        assert.strictEqual(this, sharedOwner);
        closeCalls += 1;
      };
    },
  };
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        "shared-first": { kind: "codex-cli" },
        "shared-second": { kind: "claude-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        sharedOwner.id = options.id;
        return sharedOwner;
      },
    },
  );

  await router.close();

  assert.equal(closeReads, 1);
  assert.equal(closeCalls, 1);
});

test("configured router cleanup survives a later factory deleting an acquired close", async () => {
  const closeSequence = [];
  const firstOwner = providerOwner("first", null, new Map(), closeSequence);
  const ownerWithoutClose = {
    id: "second",
    remote: true,
    singleAttempt: true,
    async generate() {
      return '{"ok":true}';
    },
  };
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        first: { kind: "codex-cli" },
        second: { kind: "claude-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        if (options.id === "first") {
          firstOwner.id = options.id;
          return firstOwner;
        }
        delete firstOwner.close;
        return ownerWithoutClose;
      },
    },
  );

  await router.close();

  assert.deepEqual(closeSequence, ["first"]);
});

test("configured router retains primitive-failure cleanup by construction ownership", async () => {
  const constructionFailure = Symbol("primitive construction failure");
  const cleanupFailure = new Error("primitive failure owner cleanup failed once");
  const constructionCleanupOwner = issueConstructionCleanupOwner();
  const attempts = new Map();
  const closeSequence = [];
  const firstOwner = providerOwner(
    "first",
    cleanupFailure,
    attempts,
    closeSequence,
  );
  let failure = null;

  try {
    createOwnedTestConfiguredBrainRouter(
      {
        constructionCleanupOwner,
        brainProviders: {
          first: { kind: "codex-cli" },
          second: { kind: "claude-cli" },
        },
      },
      {
        supervisedCliProviderFactory(options) {
          if (options.id === "second") throw constructionFailure;
          firstOwner.id = options.id;
          return firstOwner;
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.strictEqual(failure, constructionFailure);
  const cleanup = constructionCleanupFor(constructionCleanupOwner);
  await assert.rejects(cleanup.close(), (error) => error === cleanupFailure);
  assert.deepEqual(closeSequence, ["first"]);
  assert.strictEqual(cleanup.readStatus().failure, cleanupFailure);
  assert.deepEqual(cleanup.readStatus().failures, [cleanupFailure]);
  await cleanup.close();
  assert.deepEqual(closeSequence, ["first", "first"]);
  assert.equal(cleanup.readStatus().complete, true);
});

test("configured router queues distinct cleanups when one Error identity is reused", async () => {
  const constructionFailure = new Error("reused construction failure");
  const cleanupFailures = [
    new Error("first construction cleanup failed once"),
    new Error("second construction cleanup failed once"),
  ];
  const attempts = new Map();
  const closeSequence = [];

  const constructionCleanupOwner = issueConstructionCleanupOwner();
  for (const [index, key] of ["first", "second"].entries()) {
    const owner = providerOwner(
      key,
      cleanupFailures[index],
      attempts,
      closeSequence,
    );
    let failure = null;
    try {
      createOwnedTestConfiguredBrainRouter(
        {
          constructionCleanupOwner,
          brainProviders: {
            acquired: { kind: "codex-cli" },
            failing: { kind: "claude-cli" },
          },
        },
        {
          supervisedCliProviderFactory(options) {
            if (options.id === "failing") throw constructionFailure;
            owner.id = options.id;
            return owner;
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.strictEqual(failure, constructionFailure);
  }
  await new Promise((resolve) => setImmediate(resolve));

  const firstCleanup = constructionCleanupFor(constructionCleanupOwner);
  const secondCleanup = constructionCleanupFor(constructionCleanupOwner);
  assert.equal(readConfiguredConstructionCleanup(constructionCleanupOwner), null);
  assert.strictEqual(firstCleanup.readStatus().failure, cleanupFailures[0]);
  assert.deepEqual(firstCleanup.readStatus().failures, [cleanupFailures[0]]);
  assert.strictEqual(secondCleanup.readStatus().failure, cleanupFailures[1]);
  assert.deepEqual(secondCleanup.readStatus().failures, [cleanupFailures[1]]);
  assert.deepEqual(closeSequence, ["first", "second"]);

  await secondCleanup.close();
  await firstCleanup.close();
  assert.deepEqual(closeSequence, ["first", "second", "second", "first"]);
  assert.equal(firstCleanup.readStatus().complete, true);
  assert.equal(secondCleanup.readStatus().complete, true);
});

test("reused Error failures retain cleanup under independent issued owners", async () => {
  const constructionFailure = new Error("shared construction failure identity");
  const constructionCleanupOwners = [
    issueConstructionCleanupOwner(),
    issueConstructionCleanupOwner(),
  ];
  const cleanupFailures = [
    new Error("first independent cleanup failed once"),
    new Error("second independent cleanup failed once"),
  ];
  const attempts = [0, 0];

  for (const [index, constructionCleanupOwner] of
    constructionCleanupOwners.entries()) {
    assert.throws(
      () => createOwnedTestConfiguredBrainRouter(
        {
          constructionCleanupOwner,
          brainProviders: {
            acquired: { kind: "codex-cli" },
            failing: { kind: "claude-cli" },
          },
        },
        {
          supervisedCliProviderFactory(options) {
            if (options.id === "failing") throw constructionFailure;
            return {
              id: options.id,
              remote: true,
              singleAttempt: true,
              async generate() { return '{"ok":true}'; },
              async close() {
                attempts[index] += 1;
                if (attempts[index] === 1) throw cleanupFailures[index];
              },
            };
          },
        },
      ),
      (error) => error === constructionFailure,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));

  const cleanups = constructionCleanupOwners.map(constructionCleanupFor);
  assert.notStrictEqual(cleanups[0], cleanups[1]);
  assert.strictEqual(cleanups[0].readStatus().failure, cleanupFailures[0]);
  assert.strictEqual(cleanups[1].readStatus().failure, cleanupFailures[1]);
  await cleanups[1].close();
  await cleanups[0].close();
  assert.deepEqual(attempts, [2, 2]);
});

test("configured router admits a closable provider before singleAttempt validation", async () => {
  const cleanupFailure = new Error("invalid provider cleanup failed once");
  const constructionCleanupOwner = issueConstructionCleanupOwner();
  const attempts = new Map();
  const closeSequence = [];
  const owner = providerOwner(
    "invalid",
    cleanupFailure,
    attempts,
    closeSequence,
  );
  Object.defineProperty(owner, "singleAttempt", {
    configurable: true,
    enumerable: true,
    get() {
      return true;
    },
  });
  let failure = null;

  try {
    createOwnedTestConfiguredBrainRouter(
      {
        constructionCleanupOwner,
        brainProviders: { invalid: { kind: "codex-cli" } },
      },
      {
        supervisedCliProviderFactory(options) {
          owner.id = options.id;
          return owner;
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof TypeError);
  assert.match(failure.message, /singleAttempt is invalid/u);
  assert.notStrictEqual(failure, cleanupFailure);
  const cleanup = constructionCleanupFor(constructionCleanupOwner);
  await assert.rejects(cleanup.close(), (error) => error === cleanupFailure);
  assert.deepEqual(closeSequence, ["invalid"]);
  await cleanup.close();
  assert.deepEqual(closeSequence, ["invalid", "invalid"]);
  assert.equal(cleanup.readStatus().complete, true);
});

test("configured router captures the first later callable close once", async () => {
  let closeCapability;
  let closeReads = 0;
  let capturedCloseCalls = 0;
  let replacementCloseCalls = 0;
  const sharedOwner = {
    id: "unset",
    remote: true,
    singleAttempt: true,
    async generate() {
      return '{"ok":true}';
    },
    get close() {
      closeReads += 1;
      return closeCapability;
    },
  };
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        "before-close": { kind: "codex-cli" },
        "after-close": { kind: "claude-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        sharedOwner.id = options.id;
        if (options.id === "after-close") {
          closeCapability = async function closeCapturedOwner() {
            assert.strictEqual(this, sharedOwner);
            capturedCloseCalls += 1;
          };
        }
        return sharedOwner;
      },
    },
  );
  closeCapability = async () => {
    replacementCloseCalls += 1;
  };

  await router.close();
  await router.close();

  assert.equal(closeReads, 2);
  assert.equal(capturedCloseCalls, 1);
  assert.equal(replacementCloseCalls, 0);
});

function constructionCleanupFor(constructionCleanupOwner) {
  const cleanup = readConfiguredConstructionCleanup(constructionCleanupOwner);
  assert.ok(cleanup, "configured construction cleanup lifecycle is missing");
  return cleanup;
}

test("configured router retains retryable cleanup when a later provider factory fails", async () => {
  const constructionFailure = new Error("later provider factory failed");
  const cleanupFailure = new Error("first owner cleanup failed once");
  const constructionCleanupOwner = issueConstructionCleanupOwner();
  const attempts = new Map();
  const closeSequence = [];
  const firstOwner = providerOwner(
    "first",
    cleanupFailure,
    attempts,
    closeSequence,
  );
  let failure = null;

  try {
    createOwnedTestConfiguredBrainRouter(
      {
        constructionCleanupOwner,
        brainProviders: {
          first: { kind: "codex-cli" },
          second: { kind: "claude-cli" },
        },
      },
      {
        supervisedCliProviderFactory(options) {
          if (options.id === "second") throw constructionFailure;
          firstOwner.id = options.id;
          return firstOwner;
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.strictEqual(failure, constructionFailure);
  const cleanup = constructionCleanupFor(constructionCleanupOwner);
  await assert.rejects(cleanup.close(), (error) => error === cleanupFailure);
  assert.deepEqual(closeSequence, ["first"]);
  assert.strictEqual(cleanup.readStatus().failure, cleanupFailure);
  await cleanup.close();
  assert.deepEqual(closeSequence, ["first", "first"]);
  assert.equal(cleanup.readStatus().complete, true);
});

test("configured router retains reverse retryable cleanup when router construction fails", async () => {
  const constructionFailurePattern = /brain provider is duplicated/u;
  const cleanupFailure = new Error("second owner cleanup failed once");
  const constructionCleanupOwner = issueConstructionCleanupOwner();
  const attempts = new Map();
  const closeSequence = [];
  const firstOwner = providerOwner("first", null, attempts, closeSequence);
  const secondOwner = providerOwner(
    "second",
    cleanupFailure,
    attempts,
    closeSequence,
  );
  let failure = null;

  try {
    createOwnedTestConfiguredBrainRouter(
      {
        constructionCleanupOwner,
        brainProviders: {
          first: { kind: "codex-cli" },
          second: { kind: "claude-cli" },
        },
      },
      {
        supervisedCliProviderFactory(options) {
          const owner = options.id === "first" ? firstOwner : secondOwner;
          owner.id = "duplicate";
          return owner;
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.match(failure?.message, constructionFailurePattern);
  const cleanup = constructionCleanupFor(constructionCleanupOwner);
  await assert.rejects(cleanup.close(), (error) => error === cleanupFailure);
  assert.deepEqual(closeSequence, ["second", "first"]);
  await cleanup.close();
  assert.deepEqual(closeSequence, ["second", "first", "second"]);
  assert.equal(cleanup.readStatus().complete, true);
});

test("configured workforce retains router cleanup when role construction fails", async () => {
  const constructionFailure = new Error("role construction failed");
  const cleanupFailure = new Error("workforce owner cleanup failed once");
  const constructionCleanupOwner = issueConstructionCleanupOwner();
  const attempts = new Map();
  const closeSequence = [];
  const owner = providerOwner("provider", cleanupFailure, attempts, closeSequence);
  const invalidRole = new Proxy({}, {
    ownKeys() {
      throw constructionFailure;
    },
  });
  let failure = null;

  try {
    createOwnedTestConfiguredWorkforce(
      {
        constructionCleanupOwner,
        brainProviders: { cli: { kind: "codex-cli" } },
        roles: { developer: invalidRole },
        store: new MemoryStore(),
      },
      {
        supervisedCliProviderFactory(options) {
          owner.id = options.id;
          return owner;
        },
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.strictEqual(failure, constructionFailure);
  const cleanup = constructionCleanupFor(constructionCleanupOwner);
  await assert.rejects(cleanup.close(), (error) => error === cleanupFailure);
  assert.deepEqual(closeSequence, ["provider"]);
  await cleanup.close();
  assert.deepEqual(closeSequence, ["provider", "provider"]);
  assert.equal(cleanup.readStatus().complete, true);
});

test("configured router close preserves every provider failure and retries only unresolved providers", async () => {
  const failures = new Map([
    ["first", new Error("first provider close failed")],
    ["third", new Error("third provider close failed")],
  ]);
  const attempts = new Map();
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        first: { kind: "codex-cli" },
        second: { kind: "codex-cli" },
        third: { kind: "codex-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        return {
          id: options.id,
          remote: true,
          singleAttempt: true,
          async generate() {
            return '{"ok":true}';
          },
          async close() {
            const count = (attempts.get(options.id) ?? 0) + 1;
            attempts.set(options.id, count);
            if (count === 1 && failures.has(options.id)) {
              throw failures.get(options.id);
            }
          },
        };
      },
    },
  );

  const firstClose = router.close();
  assert.strictEqual(router.close(), firstClose);
  const aggregate = await firstClose.then(
    () => null,
    (error) => error,
  );
  assert.ok(aggregate instanceof AggregateError);
  assert.deepEqual(
    new Set(aggregate.errors),
    new Set(failures.values()),
  );
  assert.deepEqual(Object.fromEntries(attempts), {
    first: 1,
    second: 1,
    third: 1,
  });

  const retry = router.close();
  assert.strictEqual(router.close(), retry);
  await retry;
  await router.close();
  assert.deepEqual(Object.fromEntries(attempts), {
    first: 2,
    second: 1,
    third: 2,
  });
});

test("configured router and workforce close each shared provider owner once", async () => {
  const subjects = [
    (options, dependencies) =>
      createOwnedTestConfiguredBrainRouter(options, dependencies),
    (options, dependencies) =>
      createOwnedTestConfiguredWorkforce(
        { ...options, roles: {}, store: new MemoryStore() },
        dependencies,
      ),
  ];

  for (const createSubject of subjects) {
    let closeCalls = 0;
    const sharedOwner = {
      id: "unset",
      remote: true,
      singleAttempt: true,
      async generate() {
        return '{"ok":true}';
      },
      async close() {
        closeCalls += 1;
      },
    };
    const ownerWithoutClose = {
      id: "unset",
      remote: true,
      singleAttempt: true,
      async generate() {
        return '{"ok":true}';
      },
    };
    const subject = createSubject(
      {
        brainProviders: {
          "shared-first": { kind: "codex-cli" },
          "shared-second": { kind: "claude-cli" },
          "no-close": { kind: "codex-cli" },
        },
      },
      {
        supervisedCliProviderFactory(options) {
          const owner = options.id === "no-close"
            ? ownerWithoutClose
            : sharedOwner;
          owner.id = options.id;
          return owner;
        },
      },
    );

    const firstClose = subject.close();
    assert.strictEqual(subject.close(), firstClose);
    await firstClose;
    await subject.close();
    assert.equal(closeCalls, 1);
  }
});

test("configured router retries failed unique owners and aggregates distinct failures", async () => {
  const sharedFailure = new Error("shared owner close failed");
  const distinctFailure = new Error("distinct owner close failed");
  const attempts = new Map();
  const closeSequence = [];
  const sharedOwner = providerOwner(
    "shared",
    sharedFailure,
    attempts,
    closeSequence,
  );
  const successfulOwner = providerOwner(
    "successful",
    null,
    attempts,
    closeSequence,
  );
  const distinctOwner = providerOwner(
    "distinct",
    distinctFailure,
    attempts,
    closeSequence,
  );
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        "shared-first": { kind: "codex-cli" },
        successful: { kind: "codex-cli" },
        "shared-second": { kind: "claude-cli" },
        distinct: { kind: "claude-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        const owner = options.id.startsWith("shared-")
          ? sharedOwner
          : options.id === "successful"
            ? successfulOwner
            : distinctOwner;
        owner.id = options.id;
        return owner;
      },
    },
  );

  const aggregate = await router.close().then(
    () => null,
    (error) => error,
  );
  assert.ok(aggregate instanceof AggregateError);
  assert.deepEqual(
    new Set(aggregate.errors),
    new Set([sharedFailure, distinctFailure]),
  );
  assert.deepEqual(Object.fromEntries(attempts), {
    distinct: 1,
    shared: 1,
    successful: 1,
  });
  assert.deepEqual(closeSequence, ["distinct", "successful", "shared"]);

  const retry = router.close();
  assert.strictEqual(router.close(), retry);
  await retry;
  await router.close();
  assert.deepEqual(Object.fromEntries(attempts), {
    distinct: 2,
    shared: 2,
    successful: 1,
  });
  assert.deepEqual(closeSequence, [
    "distinct",
    "successful",
    "shared",
    "distinct",
    "shared",
  ]);
});

test("configured router preserves a shared owner's single raw close failure", async () => {
  const closeFailure = new Error("one shared owner close failed");
  const attempts = new Map();
  const sharedOwner = providerOwner("shared", closeFailure, attempts);
  const router = createOwnedTestConfiguredBrainRouter(
    {
      brainProviders: {
        "shared-first": { kind: "codex-cli" },
        "shared-second": { kind: "claude-cli" },
      },
    },
    {
      supervisedCliProviderFactory(options) {
        sharedOwner.id = options.id;
        return sharedOwner;
      },
    },
  );

  await assert.rejects(router.close(), (error) => error === closeFailure);
  assert.equal(attempts.get("shared"), 1);
  await router.close();
  assert.equal(attempts.get("shared"), 2);
});

function providerOwner(key, firstFailure, attempts, closeSequence = null) {
  return {
    id: "unset",
    remote: true,
    singleAttempt: true,
    async generate() {
      return '{"ok":true}';
    },
    async close() {
      closeSequence?.push(key);
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (count === 1 && firstFailure) throw firstFailure;
    },
  };
}

test("production configured routing rejects a caller-supplied protected-root field", () => {
  assert.throws(
    () => createConfiguredBrainRouter({
      constructionCleanupOwner: issueConstructionCleanupOwner(),
      brainProviders: {
        cli: { kind: "codex-cli" },
      },
      dependencies: {
        supervisedCliProtectedRoots: [path.join(process.cwd(), "replacement")],
      },
    }),
    /protected roots|dependencies.*invalid/i,
  );
});

test("production configured routing rejects every public composition-authority field", () => {
  assert.throws(
    () => createConfiguredBrainRouter({
      constructionCleanupOwner: issueConstructionCleanupOwner(),
      brainProviders: {
        cli: { kind: "codex-cli" },
      },
      dependencies: {
        supervisedCliCompositionCapability: Object.freeze({
          protectedRoots: Object.freeze([process.cwd()]),
        }),
      },
    }),
    /production configured routing does not accept public composition authority/i,
  );
});

test("ordinary shipped imports cannot mint, decode, or route production composition authority", async () => {
  const shippedModules = await Promise.all([
    import("../src/adapters/supervised-cli-brain-provider.js"),
    import("../src/lib/private-directory-manager.js"),
    import("../src/services/configured-workforce.js"),
    import("../src/composition-root.js"),
  ]);
  for (const shipped of shippedModules) {
    for (const name of [
      "createSupervisedCliCompositionCapability",
      "createCompositionSupervisedCliBrainProvider",
      "issueSupervisedCliCompositionAuthority",
      "readSupervisedCliCompositionAuthority",
      "SUPERVISED_CLI_COMPOSITION_AUTHORITY",
    ]) {
      assert.equal(shipped[name], undefined, name);
    }
  }
  const Grant = shippedModules[3].ProductionCliCompositionGrant;
  assert.equal(typeof Grant, "function");
  assert.equal(Object.isFrozen(Grant), true);
  assert.equal(Object.isFrozen(Grant.prototype), true);
  assert.throws(
    () => new Grant(Object.freeze({}), [process.cwd()]),
    /cannot be constructed/i,
  );
  const forgedGrant = Object.create(Grant.prototype);
  assert.deepEqual(Reflect.ownKeys(forgedGrant), []);
  assert.throws(
    () => createConfiguredBrainRouter({
      constructionCleanupOwner: issueConstructionCleanupOwner(),
      brainProviders: { cli: { kind: "codex-cli" } },
      dependencies: {
        [Symbol("forged-supervised-cli-authority")]: forgedGrant,
      },
    }),
    /composition authority|dependencies.*invalid/i,
  );
});

test("configured supervised CLIs reject adapter fields and command controls", () => {
  assert.throws(
    () => createConfiguredBrainRouter({
      brainProviders: {
        cli: {
          kind: "codex-cli",
          baseUrl: "https://models.example/v1",
          remote: true,
        },
      },
    }),
    /unsupported by CLI providers/,
  );
  assert.throws(
    () => createConfiguredBrainRouter({
      brainProviders: {
        cli: {
          kind: "claude-cli",
          executable: "claude --dangerously-skip-permissions",
          remote: true,
        },
      },
    }),
    /unknown field/,
  );
});

test("a loopback gateway declared remote enforces memory authorization before fetch", async () => {
  const calls = [];
  const router = createConfiguredBrainRouter({
    brainProviders: {
      gateway: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        remote: true,
      },
    },
    dependencies: {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return textResponse({ message: { content: '{"ok":true}' } });
      },
    },
  });
  const deniedBrain = {
    provider: "gateway",
    model: "local-gateway-model",
    remoteData: { requirements: false, code: false, memory: false },
  };

  await assert.rejects(
    router.generate({
      brain: deniedBrain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(router.describe(deniedBrain), {
    provider: "gateway",
    model: "local-gateway-model",
    remote: true,
    remoteData: { requirements: false, code: false, memory: false },
  });

  assert.equal(
    await router.generate({
      brain: {
        ...deniedBrain,
        remoteData: { requirements: false, code: false, memory: true },
      },
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    '{"ok":true}',
  );
  assert.equal(calls.length, 1);
});

test("a non-loopback provider cannot be downgraded by remote false", async () => {
  let fetchCalls = 0;
  const router = createConfiguredBrainRouter({
    brainProviders: {
      hosted: {
        kind: "ollama",
        baseUrl: "https://models.example/v1",
        remote: false,
      },
    },
    dependencies: {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("denied data must not reach fetch");
      },
    },
  });
  const brain = {
    provider: "hosted",
    model: "hosted-model",
    remoteData: { requirements: false, code: false, memory: false },
  };

  assert.equal(router.describe(brain).remote, true);
  await assert.rejects(
    router.generate({
      brain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["memory"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(fetchCalls, 0);
});

test("a dotted Responses provider is remote and denied data never starts fetch", async () => {
  let fetchCalls = 0;
  const router = createConfiguredBrainRouter({
    brainProviders: {
      "company.codex_api": {
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        protocol: "responses",
        remote: false,
      },
    },
    dependencies: {
      fetch: async (url, options) => {
        fetchCalls += 1;
        assert.equal(url, "https://api.openai.com/v1/responses");
        const body = JSON.parse(options.body);
        assert.deepEqual(body.tools, []);
        assert.equal(body.tool_choice, "none");
        return textResponse({
          object: "response",
          status: "completed",
          error: null,
          incomplete_details: null,
          output: [{
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          }],
        });
      },
      environment: {
        OPENAI_API_KEY: "fixture-key",
      },
    },
  });
  const brain = {
    provider: "company.codex_api",
    model: "gpt-5.2-codex",
    remoteData: { requirements: true, code: false, memory: false },
  };

  assert.equal(router.describe(brain).remote, true);
  await assert.rejects(
    router.generate({
      brain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["requirements", "code"],
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(
    await router.generate({
      brain: {
        ...brain,
        remoteData: { requirements: true, code: true, memory: false },
      },
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["requirements", "code"],
    }),
    '{"ok":true}',
  );
  assert.equal(fetchCalls, 1);
});

test("configured workforce forwards chat json-object response format", async () => {
  const calls = [];
  const router = createConfiguredBrainRouter({
    brainProviders: {
      "company.ark": {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "ARK_API_KEY",
        protocol: "chat-completions",
        responseFormat: "json-object",
        remote: true,
      },
    },
    dependencies: {
      environment: { ARK_API_KEY: "fixture-key" },
      fetch: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return textResponse({
          choices: [{ message: { content: '{"ok":true}' } }],
        });
      },
    },
  });
  const brain = {
    provider: "company.ark",
    model: "ark-code-latest",
    remoteData: { requirements: true, code: false, memory: false },
  };

  assert.equal(
    await router.generate({
      brain,
      messages: MESSAGES,
      schema: SCHEMA,
      dataClasses: ["requirements"],
    }),
    '{"ok":true}',
  );
  assert.equal(calls[0].url, "https://models.example/v1/chat/completions");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(calls[0].body.response_format, "json_schema"), false);
});

test("provider remote declarations are optional booleans only", () => {
  assert.equal(
    createConfiguredBrainRouter({
      brainProviders: {
        local: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        },
      },
    }).describe({
      provider: "local",
      model: "local-model",
      remoteData: { requirements: false, code: false, memory: false },
    }).remote,
    false,
  );
  assert.throws(
    () =>
      createConfiguredBrainRouter({
        brainProviders: {
          invalid: { kind: "ollama", remote: "yes" },
        },
      }),
    /brainProviders\.invalid\.remote is invalid/,
  );
});

test("remote providers read credentials only from the injected environment", async () => {
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      remote: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
      },
    },
    roles: {
      developer: {
        ...role("smart-model"),
        brain: {
          provider: "remote",
          model: "smart-model",
          remoteData: { requirements: true, code: false, memory: false },
        },
      },
    },
    store: new MemoryStore(),
    dependencies: {
      environment: { MODEL_TOKEN: "secret-token" },
      fetch: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  schemaVersion: 1,
                  confidence: 90,
                  summary: "完成",
                  intent: {
                    schemaVersion: 1,
                    type: "complete",
                    summary: "完成",
                    reason: "证据充分",
                    outcome: "done",
                    evidence: [],
                  },
                }),
              },
            }],
          });
        },
      }),
    },
  });

  await assert.rejects(
    workforce.workers[0].decide({
      item: { event: { eventType: "pull_request.updated" } },
      trigger: "assigned",
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
});

test("remote task-brain code denial stops before every provider call", async () => {
  let fetchCalls = 0;
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
      remote: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
      },
    },
    roles: {
      developer: {
        ...role("routine-model"),
        taskBrain: {
          provider: "remote",
          model: "task-model",
          remoteData: { requirements: true, code: false, memory: false },
        },
      },
    },
    store: new MemoryStore(),
    dependencies: {
      environment: { MODEL_TOKEN: "secret-token" },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("authorization denial must block before fetch");
      },
    },
  });

  await assert.rejects(
    workforce.workers[0].decide({
      item: assignedTask("pull_request.updated", "remote-denial"),
      trigger: "assigned",
    }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(fetchCalls, 0);
});

test("workforce starts without a task credential and fails before remote egress", async () => {
  let fetchCalls = 0;
  const workforce = createConfiguredWorkforce({
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
      remote: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
      },
    },
    roles: {
      developer: {
        ...role("routine-model"),
        taskBrain: {
          provider: "remote",
          model: "task-model",
          remoteData: { requirements: true, code: true, memory: false },
        },
      },
    },
    store: new MemoryStore(),
    dependencies: {
      environment: {},
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("missing credentials must block before fetch");
      },
    },
  });

  await assert.rejects(
    workforce.workers[0].decide({
      item: assignedTask("pull_request.updated", "missing-credential"),
      trigger: "assigned",
    }),
    (error) => error.code === "BRAIN_CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(fetchCalls, 0);
});
