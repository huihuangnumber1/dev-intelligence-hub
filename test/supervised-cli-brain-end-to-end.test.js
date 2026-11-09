import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import {
  createTestSupervisedCliBrainProvider,
} from "../src/adapters/supervised-cli-brain-provider.js";
import { createTestSupervisedProcessRunner } from "../src/lib/supervised-process-runner.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeJobBrainDirectory } from "../src/services/code-job-brain-directory.js";
import {
  createConfiguredBrainRouter,
  createTestConfiguredBrainRouter,
  createTestConfiguredWorkforce,
} from "../src/services/configured-workforce.js";

const FIXTURE_SOURCE = fileURLToPath(
  new URL("./fixtures/fake-structured-cli.mjs", import.meta.url),
);
const ISOLATION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok", "fixture"],
  properties: {
    ok: { type: "boolean" },
    fixture: { type: "object" },
  },
});

class TestGuard {
  async acquire() {}

  run(operation) {
    return operation();
  }

  async close() {}
}

function guardFactory() {
  return new TestGuard();
}

async function createCliHarness(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryRoot = path.join(root, "binary");
  const temporaryRoot = path.join(root, "runtime");
  await mkdir(binaryRoot, { recursive: true });
  const fixtureExecutable = path.join(binaryRoot, "fake-structured-cli.mjs");
  await copyFile(FIXTURE_SOURCE, fixtureExecutable);

  const invocations = [];
  const codexSessionStore = persistentCodexSessionStore();
  const processRunner = createTestSupervisedProcessRunner({
    descriptorMaterializer: async (descriptor) => descriptor,
  });
  const recordingRunner = Object.freeze({
    async run(request) {
      invocations.push(Object.freeze({
        cwd: request.cwd,
        args: Object.freeze([...request.args]),
        environmentKeys: Object.freeze(Object.keys(request.env).sort()),
      }));
      return processRunner.run(request);
    },
  });
  const commandLocator = Object.freeze({
    async resolve(kind) {
      return Object.freeze({
        command: process.execPath,
        prefixArgs: Object.freeze([fixtureExecutable, kind]),
      });
    },
  });
  const environment = Object.freeze({
    OPENAI_API_KEY: "fixture-openai-credential",
    ANTHROPIC_API_KEY: "fixture-anthropic-credential",
    PATH: "HOST_PATH_MUST_NOT_ESCAPE",
    GH_TOKEN: "HOST_GITHUB_TOKEN_MUST_NOT_ESCAPE",
    GITHUB_TOKEN: "HOST_GITHUB_TOKEN_MUST_NOT_ESCAPE",
    GIT_CONFIG_COUNT: "1",
    SSH_AUTH_SOCK: "HOST_SSH_AGENT_MUST_NOT_ESCAPE",
    NODE_OPTIONS: "--require=host-hook.js",
    USERPROFILE: "HOST_PROFILE_MUST_NOT_ESCAPE",
  });
  const supervisedCliProviderFactory = (options, runtimeFacts = {}) =>
    createTestSupervisedCliBrainProvider(options, {
      processRunner: recordingRunner,
      commandLocator,
      environment,
      temporaryRoot,
      codexSessionStore,
      ...(runtimeFacts.codexLoginCredentialBroker
        ? {
            codexLoginCredentialBroker:
              runtimeFacts.codexLoginCredentialBroker,
          }
        : {}),
    });

  return {
    invocations,
    temporaryRoot,
    codexSessionStore,
    supervisedCliProviderFactory,
  };
}

function persistentCodexSessionStore() {
  const sessions = new Map();
  const stages = [];
  const captures = [];
  return Object.freeze({
    async stage({ sessionKey }) {
      stages.push(sessionKey);
      return Object.freeze({ sessionId: sessions.get(sessionKey) ?? null });
    },
    async capture({ sessionKey, sessionId }) {
      sessions.set(sessionKey, sessionId);
      captures.push(Object.freeze({ sessionKey, sessionId }));
    },
    view() {
      return Object.freeze({
        sessions: Object.freeze(
          [...sessions.entries()].map(([sessionKey, sessionId]) =>
            Object.freeze({ sessionKey, sessionId })
          ),
        ),
        stages: Object.freeze([...stages]),
        captures: Object.freeze([...captures]),
      });
    },
  });
}

function persistentLoginBroker() {
  const refreshed = Buffer.from("fictional-refreshed-login-v1");
  let credential = Buffer.from("fictional-initial-login-v1");
  let captures = 0;
  let safeReleases = 0;
  return Object.freeze({
    async acquire() {
      let codexHome = null;
      return Object.freeze({
        async stage({ invocation }) {
          codexHome = path.join(invocation.path, "codex-home");
          await mkdir(codexHome);
          await writeFile(path.join(codexHome, "auth.json"), credential);
          return Object.freeze({ codexHome });
        },
        async capture() {
          credential = await readFile(path.join(codexHome, "auth.json"));
          captures += 1;
        },
        release({ safe }) {
          if (safe) safeReleases += 1;
        },
      });
    },
    async readStatus() {
      return Object.freeze({
        schemaVersion: 1,
        state: "available",
        cliAvailable: true,
        fileLoginAvailable: true,
      });
    },
    view() {
      return Object.freeze({
        captures,
        safeReleases,
        refreshed: credential.equals(refreshed),
      });
    },
  });
}

function providerConfig(kind) {
  return {
    kind,
    remote: true,
    timeoutMs: 30_000,
    maxResponseBytes: 128 * 1024,
    maxRequestBytes: 256 * 1024,
  };
}

function brain(provider, model) {
  return {
    provider,
    model,
    remoteData: { requirements: true, code: true, memory: true },
  };
}

function testRouter(harness, kind, id = "fixture-cli") {
  return createTestConfiguredBrainRouter(
    { brainProviders: { [id]: providerConfig(kind) } },
    {
      supervisedCliProviderFactory:
        harness.supervisedCliProviderFactory,
    },
  );
}

function isolationRequest(kind) {
  return {
    brain: brain(
      "fixture-cli",
      kind === "codex-cli" ? "gpt-5.6-codex" : "claude-opus-4-6",
    ),
    messages: [
      { role: "system", content: "Return the fixture JSON." },
      { role: "user", content: "Inspect only the isolated invocation." },
    ],
    schema: ISOLATION_SCHEMA,
    dataClasses: ["requirements"],
  };
}

test("both supervised CLI strategies run one real isolated child and remove its cwd", async (t) => {
  const harness = await createCliHarness(t, "supervised-cli-process-e2e");
  const invocationDirectories = new Set();

  for (const kind of ["codex-cli", "claude-cli"]) {
    const before = harness.invocations.length;
    const result = JSON.parse(
      await testRouter(harness, kind).generate(isolationRequest(kind)),
    );
    assert.equal(harness.invocations.length, before + 1);
    assert.equal(result.ok, true);
    assert.equal(result.fixture.kind, kind);
    assert.equal(result.fixture.profileRootsInsideCwd, true);
    assert.deepEqual(result.fixture.forbiddenEnvironmentPresent, []);
    assert.equal(result.fixture.hostRepositoryVisible, false);
    assert.equal(result.fixture.persistentSessionRequested, false);
    assert.notEqual(path.resolve(result.fixture.cwd), path.resolve(process.cwd()));
    invocationDirectories.add(path.resolve(result.fixture.cwd));
    await assert.rejects(lstat(result.fixture.cwd), { code: "ENOENT" });
  }

  assert.equal(invocationDirectories.size, 2);
  assert.deepEqual(await readdir(harness.temporaryRoot), []);
});

test("malformed CLI output starts exactly one child and never starts a correction process", async (t) => {
  const harness = await createCliHarness(t, "supervised-cli-malformed-e2e");

  for (const kind of ["codex-cli", "claude-cli"]) {
    const router = testRouter(harness, kind);
    const request = isolationRequest(kind);
    request.messages[1] = {
      role: "user",
      content: "FIXTURE_MALFORMED_RESULT",
    };
    const before = harness.invocations.length;
    await assert.rejects(
      router.generate(request),
      (error) => error?.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    );
    assert.equal(harness.invocations.length, before + 1);
  }
  assert.deepEqual(await readdir(harness.temporaryRoot), []);
});

test("Codex login refresh survives a second invocation and reconstructed provider", async (t) => {
  const harness = await createCliHarness(t, "supervised-cli-login-e2e");
  const broker = persistentLoginBroker();
  const options = {
    id: "codex-login-fixture",
    cliKind: "codex-cli",
    credentialMode: "codex-login",
    timeoutMs: 30_000,
    maxResponseBytes: 128 * 1024,
    maxRequestBytes: 256 * 1024,
  };
  const request = {
    model: "gpt-5.6-codex",
    messages: [
      { role: "system", content: "Return the fixture JSON." },
      {
        role: "user",
        content: "FIXTURE_REQUIRE_CODEX_LOGIN FIXTURE_REFRESH_CODEX_LOGIN",
      },
    ],
    schema: ISOLATION_SCHEMA,
  };

  const firstProvider = harness.supervisedCliProviderFactory(options, {
    codexLoginCredentialBroker: broker,
  });
  const first = JSON.parse(await firstProvider.generate(request));

  assert.equal(first.fixture.authVisible, true);
  assert.equal(first.fixture.codexHomeInsideCwd, true);
  assert.equal(broker.view().refreshed, true);
  assert.deepEqual(
    harness.invocations.at(-1).environmentKeys.includes("OPENAI_API_KEY"),
    false,
  );

  const reconstructedProvider = harness.supervisedCliProviderFactory(options, {
    codexLoginCredentialBroker: broker,
  });
  request.messages[1] = {
    role: "user",
    content: "FIXTURE_REQUIRE_CODEX_LOGIN",
  };
  const second = JSON.parse(await reconstructedProvider.generate(request));

  assert.equal(second.fixture.authVisible, true);
  assert.equal(second.fixture.codexHomeInsideCwd, true);
  assert.deepEqual(broker.view(), {
    captures: 2,
    safeReleases: 2,
    refreshed: true,
  });
  assert.deepEqual(await readdir(harness.temporaryRoot), []);
});

function codeDecisionInput(objective, allowedActions = ["read_text"]) {
  return {
    roleId: "developer",
    task: {
      operation: "modify",
      repository: "fixture/repository",
      objective,
      acceptanceCriteria: ["The bounded fixture is validated."],
      evidence: ["One local source file needs inspection."],
    },
    capabilities: {
      allowedActions,
      writablePaths: ["src"],
      requiredProfilesRemaining: 1,
    },
    turn: 1,
    observations: [],
  };
}

test("a Claude CLI Code Job turn is parsed locally and a disallowed action gets no retry", async (t) => {
  const harness = await createCliHarness(t, "supervised-cli-code-job-e2e");
  const router = testRouter(harness, "claude-cli", "claude-task");
  const directory = new CodeJobBrainDirectory({
    brainRouter: router,
    roles: {
      developer: {
        taskBrain: brain("claude-task", "claude-opus-4-6"),
      },
    },
  });
  let authorizations = 0;
  const authorization = {
    async beforeGenerate() {
      authorizations += 1;
    },
  };

  const beforeValid = harness.invocations.length;
  const valid = await directory.decide(
    codeDecisionInput("Inspect the source fixture."),
    authorization,
  );
  assert.deepEqual(valid.action, { type: "read_text", path: "src/app.js" });
  assert.equal(harness.invocations.length, beforeValid + 1);

  const beforeRejected = harness.invocations.length;
  await assert.rejects(
    directory.decide(
      codeDecisionInput("FIXTURE_DISALLOWED_ACTION"),
      authorization,
    ),
    (error) =>
      error?.code === "CODE_BRAIN_RESPONSE_INVALID" &&
      error.cause?.code === "CODE_BRAIN_ACTION_NOT_PERMITTED",
  );
  assert.equal(harness.invocations.length, beforeRejected + 1);
  assert.equal(authorizations, 2);
  assert.deepEqual(await readdir(harness.temporaryRoot), []);
});

function role(name, model, workerId = undefined) {
  return {
    name,
    mission: `${name} completes one bounded fixture task.`,
    enabled: true,
    scheduleMinutes: 0,
    initialPaused: false,
    ...(workerId === undefined ? {} : { workerId }),
    permissions: { allowedIntents: ["complete"] },
    brain: brain("codex-local-cli", model),
  };
}

function applicationConfig() {
  return {
    port: 4173,
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor: { enabled: false },
    changePackages: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [{
        id: "fixture-issue-to-orchestrator",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: { op: "equals", path: "eventType", value: "issue.created" },
        targets: [{ type: "role", id: "orchestrator" }],
        onMatch: "stop",
      }],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 10,
      workLimit: 10,
      dispatchLimit: 10,
      attentionLimit: 10,
      proposalLimit: 10,
      conditionLimit: 10,
      codeJobLimit: 10,
      codeJobMemoryLimit: 10,
      leaseDurationMs: 60_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: {
          requirements: "requirements-analyst",
          development: "developer",
          testing: "tester",
        },
        githubReviewRoles: [],
        codeActionRoles: [],
        codeOperationsByRole: {},
        workspaceByRepository: {},
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 2_000,
      maximumStateBytes: 16 * 1024 * 1024,
    },
    brainProviders: {
      "codex-local-cli": providerConfig("codex-cli"),
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        orchestrator: role(
          "Fixture orchestrator",
          "gpt-5.6-codex",
          "employee-orchestrator",
        ),
        "requirements-analyst": role("Fixture requirements", "gpt-5.6-codex"),
        developer: role("Fixture developer", "gpt-5.6-codex"),
        tester: role("Fixture tester", "gpt-5.6-codex"),
      },
    },
  };
}

function issueEvent(occurredAt) {
  return {
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt,
    source: { provider: "github", scopeId: "supervised-cli-fixture" },
    subject: {
      id: "github:issue:fixture/repository#42",
      repository: "fixture/repository",
      number: 42,
    },
    payload: {
      number: 42,
      title: "Supervised CLI fixture issue",
      description: "Prove one isolated CLI decision survives local restart.",
      state: "OPEN",
      labels: ["fixture"],
    },
  };
}

test("a production-composed orchestrator decision persists in ledger and memory across restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "supervised-cli-composition-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await createCliHarness(t, "supervised-cli-composition-process");
  const stateRoot = path.join(root, "state");
  const session = Object.freeze({
    sessionId: "fixture-session",
  });
  let now = Date.parse("2026-08-09T01:00:00.000Z");
  const clock = () => new Date(now);
  const create = () => createApplication({
    config: applicationConfig(),
    versionedConfiguration: false,
    externalActions: false,
    store: new StateStore(stateRoot),
    operationsRuntimeFactory: () => Object.freeze({}),
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    codeJobRuntimeDependencies: {
      dataDirectory: path.join(root, "code-jobs"),
      createGuard: guardFactory,
      clock,
    },
    memoryRuntimeDependencies: { createGuard: guardFactory },
    prEngineerExclusiveGuardFactory: guardFactory,
    workCoordinationDependencies: { clock },
    configuredWorkforceFactory: (options) =>
      createTestConfiguredWorkforce(options, {
        supervisedCliProviderFactory:
          harness.supervisedCliProviderFactory,
      }),
  });

  let application = await create();
  try {
    const event = issueEvent(clock().toISOString());
    const routed = await application.workflowRouting.ingest({ event });
    assert.deepEqual(routed.assignments.map(({ target }) => target), [
      { type: "role", id: "orchestrator" },
    ]);
    await application.workCoordination.runCycle({
      trigger: "supervised-cli:e2e",
      includeWork: true,
      roleId: "orchestrator",
    });
    now += 60_000;

    const ledger = await application.workLedgerView.listItems({ limit: 10 });
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].status, "completed");
    assert.equal(harness.invocations.length, 1);
    assert.equal(harness.invocations[0].args.includes("--ephemeral"), false);
    assert.equal(harness.invocations[0].args.includes("--json"), true);
    assert.equal(harness.invocations[0].args.includes("resume"), false);
    const sessionView = harness.codexSessionStore.view();
    assert.match(sessionView.stages[0], /^auth-v2:[a-f0-9]{64}$/u);
    assert.deepEqual(sessionView, {
      sessions: [{ ...session, sessionKey: sessionView.stages[0] }],
      stages: [sessionView.stages[0]],
      captures: [{ ...session, sessionKey: sessionView.stages[0] }],
    });
    await application.memoryProjector.runCycle();
    const memory = await application.memorySearch.search({
      q: "Supervised CLI fixture issue",
      limit: 20,
    });
    assert.equal(memory.items.some(({ source }) => source.kind === "work-item"), true);
  } finally {
    await application.close();
  }

  const invocationsBeforeRestart = harness.invocations.length;
  application = await create();
  try {
    const ledger = await application.workLedgerView.listItems({ limit: 10 });
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].status, "completed");
    const memory = await application.memorySearch.search({
      q: "Supervised CLI fixture issue",
      limit: 20,
    });
    assert.equal(memory.items.some(({ source }) => source.kind === "work-item"), true);
    assert.equal(harness.invocations.length, invocationsBeforeRestart);
    const sessionView = harness.codexSessionStore.view();
    assert.match(sessionView.stages[0], /^auth-v2:[a-f0-9]{64}$/u);
    assert.deepEqual(sessionView, {
      sessions: [{ ...session, sessionKey: sessionView.stages[0] }],
      stages: [sessionView.stages[0]],
      captures: [{ ...session, sessionKey: sessionView.stages[0] }],
    });
  } finally {
    await application.close();
  }
});

test("production configured routing refuses replacement CLI provider factories", () => {
  assert.throws(
    () => createConfiguredBrainRouter(
      { brainProviders: {} },
      { supervisedCliProviderFactory() {} },
    ),
    /does not accept replacement CLI provider factories/i,
  );
});
