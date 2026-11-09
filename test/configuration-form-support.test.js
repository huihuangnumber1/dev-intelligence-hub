import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfigurationStructureOperation,
  CONFIGURATION_FORM_LIMITS,
  configurationDocumentFromForm,
  configurationFormPathKey,
  configurationReferences,
  createConfigurationFormState,
  removeConfigurationEntity,
  resetConfigurationFormState,
  setConfigurationFormField,
} from "../public/configuration-form-support.js";
import { normalizeConfigurationDocument } from "../src/domain/configuration-contract.js";
import {
  configurationFieldDescriptor,
  configurationStructureTemplate,
} from "../public/configuration-form-schema.js";

function assignedBrain(provider = "ollama", model = "qwen3.5:9b") {
  return {
    provider,
    model,
    remoteData: {
      requirements: false,
      code: false,
      memory: false,
    },
  };
}

function role(name, brain = assignedBrain()) {
  const workerId = `employee-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return {
    name,
    mission: `${name} 的测试使命`,
    enabled: true,
    scheduleMinutes: 3,
    initialPaused: true,
    workerId,
    permissions: {
      allowedIntents: ["ask_user", "handoff", "complete"],
    },
    brain,
  };
}

function representativeConfiguration() {
  return normalizeConfigurationDocument({
    port: 4173,
    refreshMinutes: 10,
    browserPollSeconds: 60,
    githubLogin: "local-owner",
    githubRead: { enabled: true, issueActiveWindowDays: 14 },
    trackedRepositories: ["acme/command-center", "acme/product"],
    prResponsibility: { historicalAfterDays: 60 },
    codeExecutor: {
      enabled: true,
      docker: {
        executable: "docker.exe",
        host: "npipe:////./pipe/docker_engine",
      },
      workspaces: [
        {
          id: "command-center",
          sourceRoot: "D:/code/command-center",
          writablePaths: ["Source", "Tests"],
          excludePaths: [".git", "Build"],
        },
        {
          id: "dashboard",
          sourceRoot: "C:/workspace/dashboard",
          writablePaths: ["public", "src", "test"],
          excludePaths: [".git", "data"],
        },
      ],
      profiles: {
        "node-unit": {
          kind: "node-test",
          image: `node@sha256:${"a".repeat(64)}`,
          timeoutMs: 120_000,
        },
        "node-contract": {
          kind: "node-test",
          image: `node@sha256:${"b".repeat(64)}`,
          timeoutMs: 180_000,
        },
      },
      requiredProfilesByWorkspace: {
        "command-center": ["node-contract"],
        dashboard: ["node-unit", "node-contract"],
      },
      brokerLimits: {
        maxFiles: 100,
        maxDirectories: 100,
        maxFileBytes: 1_048_576,
        maxTotalBytes: 8_388_608,
        maxSearchMatches: 2_000,
        maxWriteBytes: 1_048_576,
      },
      executorLimits: { maxSessions: 4, maxActionsPerSession: 100 },
      maxArtifactBytes: 16_777_216,
    },
    changePackages: {
      enabled: true,
      gitCommand: "git.exe",
      gitTimeoutMs: 30_000,
    },
    githubActions: {
      enabled: true,
      actorAccountId: "local-owner",
      tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
      ghCommand: "C:/Program Files/GitHub CLI/gh.exe",
      networkEnv: {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "127.0.0.1,localhost",
      },
      timeoutMs: 120_000,
    },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [
        {
          id: "all-condition-kinds",
          source: "root",
          enabled: true,
          priority: 100,
          fallback: false,
          condition: {
            op: "all",
            conditions: [
              {
                op: "any",
                conditions: [
                  { op: "equals", path: "eventType", value: "pull_request.updated" },
                  { op: "atLeast", path: "payload.riskScore", value: 5 },
                ],
              },
              {
                op: "not",
                condition: { op: "equals", path: "payload.draft", value: true },
              },
              {
                op: "oneOf",
                path: "payload.state",
                values: ["open", "reopened", null, false, 1],
              },
              { op: "hasAny", path: "payload.labels", values: ["review", "risk:high"] },
              { op: "hasAll", path: "payload.labels", values: ["backend"] },
              { op: "globAny", path: "payload.files", patterns: ["Source/**"] },
              { op: "globAll", path: "payload.files", patterns: ["**/*.cpp"] },
            ],
          },
          targets: [
            { type: "role", id: "pr-engineer" },
            { type: "node", id: "verification" },
          ],
          onMatch: "continue",
        },
        {
          id: "fallback-owner",
          source: "root",
          enabled: true,
          priority: 0,
          fallback: true,
          condition: null,
          targets: [{ type: "person", id: "local-owner" }],
          onMatch: "stop",
        },
      ],
    },
    workCoordination: {
      enabled: true,
      tickSeconds: 30,
      intakeLimit: 100,
      workLimit: 20,
      dispatchLimit: 50,
      attentionLimit: 50,
      proposalLimit: 50,
      conditionLimit: 50,
      codeJobLimit: 10,
      codeJobMemoryLimit: 50,
      leaseDurationMs: 180_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 150_000,
      maxAttempts: 3,
      retryBaseMs: 30_000,
      retryMaxMs: 900_000,
      factMaximumAgeMs: 900_000,
      codeJobMaximumTurns: 20,
      codeJobObservationLimit: 50,
      policy: {
        version: 2,
        capabilityRoles: {
          coordination: "orchestrator",
          requirements: "requirements-analyst",
          "pr-review": "pr-engineer",
          development: "developer",
          testing: "tester",
        },
        githubReviewRoles: ["pr-engineer"],
        codeActionRoles: ["developer", "tester"],
        codeOperationsByRole: {
          developer: ["inspect", "modify", "verify"],
          tester: ["inspect", "verify"],
        },
        workspaceByRepository: {
          "acme/command-center": "command-center",
          "acme/product": "dashboard",
        },
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 20_000,
      maximumStateBytes: 67_108_864,
      imports: { localSessions: true, git: true },
      answering: {
        enabled: true,
        maximumRecords: 12,
        maximumContextBytes: 114_688,
        maximumConcurrent: 1,
        brain: assignedBrain("remote-openai", "gpt-5-mini"),
        localBrain: assignedBrain(),
      },
    },
    brain: {
      enabled: true,
      provider: "ollama",
      model: "qwen3.5:9b",
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 45_000,
      numCtx: 8_192,
      contextTokens: 8_192,
      maxAssessmentsPerRefresh: 3,
    },
    brainProviders: {
      ollama: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 120_000,
        maxResponseBytes: 131_072,
        maxRequestBytes: 262_144,
        contextTokens: 8_192,
        remote: false,
      },
      "remote-openai": {
        kind: "openai-compatible",
        baseUrl: "https://models.example.invalid/v1",
        apiKeyEnv: "MYDASHBOARD_OPENAI_API_KEY",
        timeoutMs: 120_000,
        maxResponseBytes: 131_072,
        maxRequestBytes: 262_144,
        remote: true,
      },
      unused: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11435",
        contextTokens: 4_096,
        remote: false,
      },
    },
    employees: {
      prReviewer: {
        enabled: true,
        name: "PR 推进员工",
        initialPaused: true,
        policyVersion: 1,
        tickMinutes: 2,
        maxJobsPerTick: 2,
        maxAttempts: 3,
        retryMinutes: [1, 5, 30],
        maxPatchCharacters: 24_000,
        memoryLimit: 1_000,
        memoryOutboxLimit: 100,
        jobLimit: 500,
        allowRemoteCodeContext: false,
        brain: {
          model: "qwen3.5:9b",
          timeoutMs: 45_000,
          numCtx: 8_192,
          contextTokens: 8_192,
          maxAssessmentsPerRefresh: 3,
        },
      },
      roles: {
        "pr-engineer": role(
          "PR Engineer",
          assignedBrain("remote-openai", "gpt-5-mini"),
        ),
        orchestrator: role("Orchestrator"),
        "requirements-analyst": role("Requirements"),
        developer: role("Developer"),
        tester: role("Tester"),
        unused: role("Unused"),
      },
    },
    dingtalk: {
      enabled: true,
      selfUserId: "synthetic-self-user",
      notifyMinimumScore: 80,
      maxNotificationsPerRun: 5,
    },
  });
}

test("Windows fixed assets round-trip through the structured form without Docker identity", () => {
  const config = structuredClone(representativeConfiguration());
  config.codeExecutor.profiles.native = {
    kind: "windows-test", nodeExecutable: "C:/Program Files/nodejs/node.exe",
    nodeSha256: "a".repeat(64), timeoutMs: 30_000,
    asset: { schemaVersion: 1, title: "Native regression", description: "Production assertions", version: 1, source: "throw new Error('configure assertions');" },
  };
  const state = createConfigurationFormState(config);
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.codeExecutor.profiles.native, config.codeExecutor.profiles.native);
  assert.equal(Object.hasOwn(result.configuration.codeExecutor.profiles.native, "image"), false);
});

function windowsOnlyConfiguration({ resources } = {}) {
  const configuration = structuredClone(representativeConfiguration());
  const profile = structuredClone(configurationStructureTemplate(["codeExecutor", "profiles"], "windows-test").value);
  if (resources !== undefined) profile.resources = resources;
  configuration.codeExecutor.profiles = { native: profile };
  configuration.codeExecutor.requiredProfilesByWorkspace = Object.fromEntries(
    configuration.codeExecutor.workspaces.map(({ id }) => [id, ["native"]]),
  );
  delete configuration.codeExecutor.docker;
  return configuration;
}

function windowsResource(overrides = {}) {
  return { name: "test-data", sourcePath: "D:/test assets/data", sha256: "b".repeat(64), kind: "directory", ...overrides };
}

test("enabled Windows-only configuration round-trips without Docker and without adding resources", () => {
  const configuration = windowsOnlyConfiguration();
  configuration.codeExecutor.profiles.build = configurationStructureTemplate(["codeExecutor", "profiles"], "windows-build").value;
  assert.doesNotThrow(() => normalizeConfigurationDocument(configuration));
  const result = configurationDocumentFromForm(createConfigurationFormState(configuration));
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, configuration);
  for (const profile of Object.values(result.configuration.codeExecutor.profiles)) {
    assert.equal(Object.hasOwn(profile, "resources"), false);
  }
});

test("enabled mixed Windows and container profiles still require Docker", () => {
  const configuration = windowsOnlyConfiguration();
  configuration.codeExecutor.profiles.container = configurationStructureTemplate(["codeExecutor", "profiles"]).value;
  assert.throws(() => normalizeConfigurationDocument(configuration), /Docker/u);
  assert.throws(() => createConfigurationFormState(configuration), /authoritative configuration constraint/iu);
});

test("Windows resource configuration supports unchanged, add, edit and delete round-trips", () => {
  const configuration = windowsOnlyConfiguration({ resources: [windowsResource()] });
  const initial = createConfigurationFormState(configuration);
  assert.deepEqual(configurationDocumentFromForm(initial).configuration, configuration);
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add", path: ["codeExecutor", "profiles", "native", "resources"],
    value: windowsResource({ name: "settings", sourcePath: "C:\\test assets\\settings.json", kind: "file", sha256: "c".repeat(64) }),
  });
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "profiles", "native", "resources", 1, "sourcePath"], kind: "text", rawValue: "D:/fixtures/settings.json",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "remove", path: ["codeExecutor", "profiles", "native", "resources"], index: 0,
  });
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.codeExecutor.profiles.native.resources, [
    windowsResource({ name: "settings", sourcePath: "D:/fixtures/settings.json", kind: "file", sha256: "c".repeat(64) }),
  ]);
  assert.deepEqual(normalizeConfigurationDocument(result.configuration).codeExecutor.profiles.native, result.configuration.codeExecutor.profiles.native);

  const absent = createConfigurationFormState(windowsOnlyConfiguration());
  const added = applyConfigurationStructureOperation(absent, {
    operation: "add", path: ["codeExecutor", "profiles", "native", "resources"],
    value: configurationStructureTemplate(["codeExecutor", "profiles", "native", "resources"]).value,
  });
  assert.equal(configurationDocumentFromForm(added).ok, true);
  assert.equal(Object.hasOwn(configurationDocumentFromForm(absent).configuration.codeExecutor.profiles.native, "resources"), false);
});

test("resource insertion, replacement and deletion keep edits attached to the intended resource", () => {
  const path = ["codeExecutor", "profiles", "native", "resources"];
  let state = createConfigurationFormState(windowsOnlyConfiguration({ resources: [windowsResource({ name: "original" })] }));
  state = setConfigurationFormField(state, { path: [...path, 0, "sourcePath"], kind: "text", rawValue: "D:/edited/original" });
  state = applyConfigurationStructureOperation(state, { operation: "add", path, index: 0, value: windowsResource({ name: "inserted" }) });
  let resources = configurationDocumentFromForm(state).configuration.codeExecutor.profiles.native.resources;
  assert.equal(resources[0].sourcePath, "D:/test assets/data");
  assert.equal(resources[1].sourcePath, "D:/edited/original");
  state = applyConfigurationStructureOperation(state, { operation: "replace", path, index: 1, value: windowsResource({ name: "replacement" }) });
  resources = configurationDocumentFromForm(state).configuration.codeExecutor.profiles.native.resources;
  assert.equal(resources[1].sourcePath, "D:/test assets/data");
  state = setConfigurationFormField(state, { path: [...path, 0, "sourcePath"], kind: "text", rawValue: "D:/edited/inserted" });
  state = applyConfigurationStructureOperation(state, { operation: "remove", path, index: 0 });
  resources = configurationDocumentFromForm(state).configuration.codeExecutor.profiles.native.resources;
  assert.deepEqual(resources, [windowsResource({ name: "replacement" })]);
});

test("Windows resource form validation matches resource boundaries and unique names", () => {
  const invalidResources = [
    [windowsResource({ name: "Unsafe_name" })],
    [windowsResource({ name: "a".repeat(65) })],
    [windowsResource({ sourcePath: "relative/data" })],
    [windowsResource({ sourcePath: "C:relative/data" })],
    [windowsResource({ sourcePath: 'C:/data/"quoted"' })],
    [windowsResource({ sha256: "g".repeat(64) })],
    [windowsResource({ sha256: "a".repeat(63) })],
    [windowsResource({ kind: "executable" })],
    [windowsResource(), windowsResource({ sourcePath: "D:/other" })],
    Array.from({ length: 17 }, (_, index) => windowsResource({ name: `data-${index}` })),
    [windowsResource({ command: "run" })],
  ];
  for (const resources of invalidResources) {
    const configuration = windowsOnlyConfiguration({ resources });
    assert.throws(() => normalizeConfigurationDocument(configuration));
    assert.throws(() => createConfigurationFormState(configuration));
  }
  const sixteen = windowsOnlyConfiguration({ resources: Array.from({ length: 16 }, (_, index) => windowsResource({ name: `data-${index}` })) });
  assert.equal(configurationDocumentFromForm(createConfigurationFormState(sixteen)).ok, true);
  const initial = createConfigurationFormState(windowsOnlyConfiguration({ resources: [windowsResource()] }));
  for (const [field, rawValue] of [["name", "Unsafe_name"], ["sourcePath", "relative/path"], ["sha256", "bad"], ["kind", "executable"]]) {
    const state = setConfigurationFormField(initial, { path: ["codeExecutor", "profiles", "native", "resources", 0, field], kind: "text", rawValue });
    assert.equal(configurationDocumentFromForm(state).ok, false, field);
  }
  const duplicate = applyConfigurationStructureOperation(initial, {
    operation: "add", path: ["codeExecutor", "profiles", "native", "resources"], value: windowsResource({ sourcePath: "D:/other" }),
  });
  assert.equal(configurationDocumentFromForm(duplicate).issues.some(({ code }) => code === "DUPLICATE_CONFIGURATION_ENTRY"), true);
});

test("Windows resource source paths match backend validation for additions and edits", async (t) => {
  const cases = [
    { sourcePath: "D:/fixtures", valid: true },
    { sourcePath: "c:\\test assets\\fixtures", valid: true },
    { sourcePath: "d:/fixtures\\settings.json", valid: true },
    { sourcePath: "C:/", valid: true },
    { sourcePath: "d:\\", valid: true },
    { sourcePath: "//server/share/fixtures", valid: false },
    { sourcePath: "\\\\server\\share\\fixtures", valid: false },
    { sourcePath: "/fixtures", valid: false },
    { sourcePath: "\\fixtures", valid: false },
    { sourcePath: "D:/fixtures:stream", valid: false },
    { sourcePath: "D:fixtures", valid: false },
    { sourcePath: 'D:/fixtures/"quoted"', valid: false },
    { sourcePath: "D:/fixtures/\u0001control", valid: false },
  ];
  const resourcesPath = ["codeExecutor", "profiles", "native", "resources"];
  const sourcePathField = [...resourcesPath, 0, "sourcePath"];
  for (const kind of ["windows-test", "windows-build"]) {
    const configuration = windowsOnlyConfiguration({ resources: [windowsResource()] });
    configuration.codeExecutor.profiles.native.kind = kind;
    const initial = createConfigurationFormState(configuration);
    for (const { sourcePath, valid } of cases) {
      await t.test(`${kind}: ${JSON.stringify(sourcePath)}`, () => {
        const candidate = structuredClone(configuration);
        candidate.codeExecutor.profiles.native.resources[0].sourcePath = sourcePath;
        if (valid) assert.doesNotThrow(() => normalizeConfigurationDocument(candidate));
        else assert.throws(() => normalizeConfigurationDocument(candidate), { name: "ConfigurationContractError" });

        const edited = setConfigurationFormField(initial, { path: sourcePathField, kind: "text", rawValue: sourcePath });
        const added = applyConfigurationStructureOperation(initial, {
          operation: "add", path: resourcesPath, value: windowsResource({ name: "added", sourcePath }),
        });
        for (const state of [edited, added]) {
          const result = configurationDocumentFromForm(state);
          assert.equal(result.ok, valid);
          if (valid) assert.doesNotThrow(() => normalizeConfigurationDocument(result.configuration));
          else assert.equal(result.issues.some(({ path, code }) => path.endsWith(".sourcePath") && code === "INVALID_CONFIGURATION_TEXT"), true);
        }
        if (valid) assert.doesNotThrow(() => createConfigurationFormState(candidate));
        else assert.throws(() => createConfigurationFormState(candidate), /authoritative configuration constraint/u);
      });
    }
  }
});

function configurationWithGitHeadSnapshot() {
  const configuration = structuredClone(representativeConfiguration());
  configuration.codeExecutor.gitCommand =
    "C:/Program Files/Git/mingw64/bin/git.exe";
  configuration.codeExecutor.gitTimeoutMs = 30_000;
  configuration.codeExecutor.workspaces[0].gitHeadSnapshot = true;
  configuration.codeExecutor.workspaces[1].gitHeadSnapshot = false;
  return configuration;
}

function conflictPreparationFormState({ withGitCommand = true } = {}) {
  let state = createConfigurationFormState(representativeConfiguration());
  if (withGitCommand) {
    state = applyConfigurationStructureOperation(state, {
      operation: "add",
      path: ["codeExecutor", "gitCommand"],
      value: configurationStructureTemplate([
        "codeExecutor",
        "gitCommand",
      ]).value,
    });
  }
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "conflictPreparation"],
    value: configurationStructureTemplate([
      "codeExecutor",
      "conflictPreparation",
    ]).value,
  });
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "conflictPreparation", "enabled"],
    kind: "boolean",
    rawValue: true,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: [
      "codeExecutor",
      "conflictPreparation",
      "baseMirrorsByRepository",
    ],
    key: "acme/command-center",
    value: "D:/mirrors/oct-base.git",
  });
  return applyConfigurationStructureOperation(state, {
    operation: "add",
    path: [
      "codeExecutor",
      "conflictPreparation",
      "headMirrorsByRepository",
    ],
    key: "acme/command-center",
    value: "D:/mirrors/oct-head.git",
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("a complete supported configuration round-trips without losing fields", () => {
  const configuration = representativeConfiguration();
  const state = createConfigurationFormState(configuration, {
    expectedStateRevision: 12,
    expectedActiveVersion: 4,
    draftId: "draft-4",
    draftRevision: 2,
    targetVersion: null,
  });
  const result = configurationDocumentFromForm(state);

  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, configuration);
  assert.notStrictEqual(result.configuration, configuration);
  assertDeepFrozen(state);
  assertDeepFrozen(result);
});

test("a pre-boundary configuration is editable with its effective GitHub-read default", () => {
  const configuration = structuredClone(representativeConfiguration());
  delete configuration.githubRead;

  const state = createConfigurationFormState(configuration);
  const result = configurationDocumentFromForm(state);

  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.githubRead, { enabled: true });
});

test("PR discovery windows round-trip explicitly without drifting legacy unlimited configs", () => {
  const path = ["githubRead", "pullRequestUpdatedWindow"];
  const legacy = createConfigurationFormState(representativeConfiguration());
  assert.equal(
    Object.hasOwn(
      configurationDocumentFromForm(legacy).configuration.githubRead,
      "pullRequestUpdatedWindow",
    ),
    false,
  );
  const unrelated = setConfigurationFormField(legacy, {
    path: ["browserPollSeconds"],
    kind: "integer",
    rawValue: "61",
  });
  assert.equal(
    Object.hasOwn(
      configurationDocumentFromForm(unrelated).configuration.githubRead,
      "pullRequestUpdatedWindow",
    ),
    false,
  );

  const rolling = applyConfigurationStructureOperation(legacy, {
    operation: "add",
    path,
    value: { mode: "rolling", days: 7 },
  });
  assert.deepEqual(
    configurationDocumentFromForm(rolling).configuration.githubRead.pullRequestUpdatedWindow,
    { mode: "rolling", days: 7 },
  );

  const fixedValue = {
    mode: "fixed",
    fromInclusive: "2026-03-08T05:00:00.000Z",
    untilExclusive: "2026-03-10T04:00:00.000Z",
    timeZone: "America/New_York",
  };
  const fixed = applyConfigurationStructureOperation(rolling, {
    operation: "replace",
    path,
    value: fixedValue,
  });
  assert.deepEqual(
    configurationDocumentFromForm(fixed).configuration.githubRead.pullRequestUpdatedWindow,
    fixedValue,
  );

  const removed = applyConfigurationStructureOperation(fixed, {
    operation: "remove",
    path,
  });
  assert.equal(
    Object.hasOwn(
      configurationDocumentFromForm(removed).configuration.githubRead,
      "pullRequestUpdatedWindow",
    ),
    false,
  );
});

test("Issue automatic work window round-trips and remains directly editable", () => {
  const path = ["githubRead", "issueActiveWindowDays"];
  const initial = createConfigurationFormState(representativeConfiguration());

  assert.equal(
    configurationDocumentFromForm(initial).configuration.githubRead.issueActiveWindowDays,
    14,
  );

  const changed = setConfigurationFormField(initial, {
    path,
    kind: "integer",
    rawValue: "21",
  });
  const result = configurationDocumentFromForm(changed);

  assert.equal(result.ok, true);
  assert.equal(result.configuration.githubRead.issueActiveWindowDays, 21);
});

test("Git Head snapshot scalar fields round-trip and remain directly editable", () => {
  const configuration = configurationWithGitHeadSnapshot();
  let state = createConfigurationFormState(configuration);
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "gitCommand"],
    kind: "text",
    rawValue: "D:/Tools/Git/mingw64/bin/git.exe",
  });
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "gitTimeoutMs"],
    kind: "integer",
    rawValue: "45000",
  });
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "workspaces", 1, "gitHeadSnapshot"],
    kind: "boolean",
    rawValue: true,
  });

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.codeExecutor.gitCommand,
    "D:/Tools/Git/mingw64/bin/git.exe",
  );
  assert.equal(result.configuration.codeExecutor.gitTimeoutMs, 45_000);
  assert.equal(
    result.configuration.codeExecutor.workspaces[1].gitHeadSnapshot,
    true,
  );
  assert.deepEqual(
    normalizeConfigurationDocument(result.configuration),
    result.configuration,
  );
});

test("old configurations can add and remove Git Head snapshot fields without JSON", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["codeExecutor", "gitCommand"],
    value: configurationStructureTemplate(["codeExecutor", "gitCommand"]).value,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "gitTimeoutMs"],
    value: configurationStructureTemplate(["codeExecutor", "gitTimeoutMs"]).value,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
    value: configurationStructureTemplate([
      "codeExecutor",
      "workspaces",
      0,
      "gitHeadSnapshot",
    ]).value,
  });

  let result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.codeExecutor.gitCommand,
    "C:/Program Files/Git/mingw64/bin/git.exe",
  );
  assert.equal(result.configuration.codeExecutor.gitTimeoutMs, 30_000);
  assert.equal(
    result.configuration.codeExecutor.workspaces[0].gitHeadSnapshot,
    true,
  );
  assert.equal(Object.hasOwn(initial.baseDocument.codeExecutor, "gitCommand"), false);

  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["codeExecutor", "gitCommand"],
  });
  result = configurationDocumentFromForm(state);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some(
      ({ path, code }) =>
        path === "codeExecutor.gitCommand" && code === "INCOMPLETE_CONFIGURATION",
    ),
    true,
  );

  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
  });
  result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.configuration.codeExecutor, "gitCommand"), false);
  assert.equal(
    Object.hasOwn(
      result.configuration.codeExecutor.workspaces[0],
      "gitHeadSnapshot",
    ),
    false,
  );
});

test("old configurations can build and disable conflict preparation without JSON", () => {
  const initial = conflictPreparationFormState();
  const configured = configurationDocumentFromForm(initial);
  assert.equal(configured.ok, true);
  assert.deepEqual(configured.configuration.codeExecutor.conflictPreparation, {
    enabled: true,
    baseMirrorsByRepository: {
      "acme/command-center": "D:/mirrors/oct-base.git",
    },
    headMirrorsByRepository: {
      "acme/command-center": "D:/mirrors/oct-head.git",
    },
  });
  assert.doesNotThrow(() =>
    normalizeConfigurationDocument(configured.configuration),
  );

  const staleDisabled = setConfigurationFormField(initial, {
    path: ["codeExecutor", "conflictPreparation", "enabled"],
    kind: "boolean",
    rawValue: false,
  });
  assert.equal(configurationDocumentFromForm(staleDisabled).ok, false);

  const safelyDisabled = applyConfigurationStructureOperation(initial, {
    operation: "replace",
    path: ["codeExecutor", "conflictPreparation"],
    value: configurationStructureTemplate([
      "codeExecutor",
      "conflictPreparation",
    ]).value,
  });
  const disabled = configurationDocumentFromForm(safelyDisabled);
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.configuration.codeExecutor.conflictPreparation, {
    enabled: false,
  });
});

test("conflict preparation form validates repository identity, mirror paths, and Git coupling", () => {
  const missingGit = configurationDocumentFromForm(
    conflictPreparationFormState({ withGitCommand: false }),
  );
  assert.equal(missingGit.ok, false);
  assert.equal(
    missingGit.issues.some(
      ({ path, code }) =>
        path === "codeExecutor.gitCommand" &&
        code === "INCOMPLETE_CONFIGURATION",
    ),
    true,
  );

  const initial = conflictPreparationFormState();
  const duplicate = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: [
      "codeExecutor",
      "conflictPreparation",
      "baseMirrorsByRepository",
    ],
    key: "ACME/COMMAND-CENTER",
    value: "D:/mirrors/duplicate.git",
  });
  assert.equal(
    configurationDocumentFromForm(duplicate).issues.some(
      ({ path, code }) =>
        path ===
          "codeExecutor.conflictPreparation.baseMirrorsByRepository" &&
        code === "DUPLICATE_CONFIGURATION_ENTRY",
    ),
    true,
  );

  for (const value of ["relative/mirror.git", "//server/share/mirror.git"]) {
    const invalidMirror = applyConfigurationStructureOperation(initial, {
      operation: "replace",
      path: [
        "codeExecutor",
        "conflictPreparation",
        "baseMirrorsByRepository",
      ],
      key: "acme/command-center",
      value,
    });
    assert.equal(
      configurationDocumentFromForm(invalidMirror).issues.some(
        ({ path, code }) =>
          path ===
            "codeExecutor.conflictPreparation.baseMirrorsByRepository.acme/command-center" &&
          code === "INVALID_CONFIGURATION_TEXT",
      ),
      true,
    );
  }

  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: [
          "codeExecutor",
          "conflictPreparation",
          "headMirrorsByRepository",
        ],
        key: "owner/.repository",
        value: "D:/mirrors/invalid.git",
      }),
    /unsafe map key/i,
  );
});

test("Git Head snapshot structure operations keep exact paths and scalar types", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["codeExecutor", "workspaces", 0, "futureSnapshot"],
        value: true,
      }),
    /allowlist|editable collection/i,
  );

  const withCommand = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["codeExecutor", "gitCommand"],
    value: "C:/Program Files/Git/mingw64/bin/git.exe",
  });
  assert.throws(
    () =>
      applyConfigurationStructureOperation(withCommand, {
        operation: "add",
        path: ["codeExecutor", "gitCommand"],
        value: "D:/Git/bin/git.exe",
      }),
    /already exists/i,
  );

  const wrongType = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
    value: "true",
  });
  const invalid = configurationDocumentFromForm(wrongType);
  assert.equal(invalid.ok, false);
  assert.equal(
    invalid.issues.some(
      ({ path }) =>
        path === "codeExecutor.workspaces.0.gitHeadSnapshot",
    ),
    true,
  );

  let edited = createConfigurationFormState(configurationWithGitHeadSnapshot());
  edited = setConfigurationFormField(edited, {
    path: ["codeExecutor", "gitCommand"],
    kind: "text",
    rawValue: "D:/Edited/Git/mingw64/bin/git.exe",
  });
  edited = applyConfigurationStructureOperation(edited, {
    operation: "remove",
    path: ["codeExecutor", "gitCommand"],
  });
  assert.equal(edited.edits.length, 0);
  edited = applyConfigurationStructureOperation(edited, {
    operation: "add",
    path: ["codeExecutor", "gitCommand"],
    value: "D:/Readded/Git/mingw64/bin/git.exe",
  });
  assert.equal(
    configurationDocumentFromForm(edited).configuration.codeExecutor.gitCommand,
    "D:/Readded/Git/mingw64/bin/git.exe",
  );

  let replaced = createConfigurationFormState(configurationWithGitHeadSnapshot());
  replaced = setConfigurationFormField(replaced, {
    path: ["codeExecutor", "gitCommand"],
    kind: "text",
    rawValue: "D:/Edited/Git/mingw64/bin/git.exe",
  });
  replaced = applyConfigurationStructureOperation(replaced, {
    operation: "replace",
    path: ["codeExecutor", "gitCommand"],
    value: "D:/Replaced/Git/mingw64/bin/git.exe",
  });
  assert.equal(replaced.edits.length, 0);
  assert.equal(
    configurationDocumentFromForm(replaced).configuration.codeExecutor.gitCommand,
    "D:/Replaced/Git/mingw64/bin/git.exe",
  );
});

test("Git Head snapshot form rejects the Git for Windows wrapper path", () => {
  let state = createConfigurationFormState(configurationWithGitHeadSnapshot());
  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "gitCommand"],
    kind: "text",
    rawValue: "C:/Program Files/Git/cmd/git.exe",
  });

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some(
      ({ path, code }) =>
        path === "codeExecutor.gitCommand" && code === "UNSAFE_GIT_WRAPPER",
    ),
    true,
  );

  state = setConfigurationFormField(state, {
    path: ["codeExecutor", "gitCommand"],
    kind: "text",
    rawValue: "tools/mingw64/bin/git.exe",
  });
  const relative = configurationDocumentFromForm(state);
  assert.equal(relative.ok, false);
  assert.equal(
    relative.issues.some(
      ({ path, code }) =>
        path === "codeExecutor.gitCommand" && code === "RELATIVE_GIT_COMMAND",
    ),
    true,
  );
});

test("form saves reject remote legacy brains but accept remote role and memory brains", () => {
  const configuration = representativeConfiguration();
  let state = createConfigurationFormState(configuration);
  state = setConfigurationFormField(state, {
    path: ["brain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  assert.equal(configurationDocumentFromForm(state).ok, false);

  state = createConfigurationFormState(configuration);
  state = setConfigurationFormField(state, {
    path: ["employees", "roles", "developer", "brain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  state = setConfigurationFormField(state, {
    path: ["memory", "answering", "localBrain", "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.employees.roles.developer.brain.provider,
    "remote-openai",
  );
  assert.equal(result.configuration.memory.answering.localBrain.provider, "remote-openai");
});

test("task brains can be added, edited, removed, and reference-protected without JSON", () => {
  const path = ["employees", "roles", "developer", "taskBrain"];
  const initial = createConfigurationFormState(representativeConfiguration());
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path,
    value: configurationStructureTemplate(path).value,
  });
  state = setConfigurationFormField(state, {
    path: [...path, "provider"],
    kind: "text",
    rawValue: "remote-openai",
  });
  state = setConfigurationFormField(state, {
    path: [...path, "model"],
    kind: "text",
    rawValue: "high-capability-code-model",
  });

  const configured = configurationDocumentFromForm(state);
  assert.equal(configured.ok, true);
  assert.deepEqual(
    configured.configuration.employees.roles.developer.taskBrain,
    {
      provider: "remote-openai",
      model: "high-capability-code-model",
      remoteData: { requirements: false, code: false, memory: false },
    },
  );
  assert.doesNotThrow(() =>
    normalizeConfigurationDocument(configured.configuration),
  );
  assert.deepEqual(
    configurationReferences(configured.configuration, {
      kind: "provider",
      id: "remote-openai",
    })
      .map(({ path: referencePath }) => referencePath)
      .filter((referencePath) => referencePath.includes("taskBrain")),
    ["employees.roles.developer.taskBrain.provider"],
  );
  assert.equal(
    removeConfigurationEntity(state, {
      kind: "provider",
      id: "remote-openai",
    }).reason,
    "referenced",
  );

  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path,
  });
  const removed = configurationDocumentFromForm(state);
  assert.equal(removed.ok, true);
  assert.equal(
    Object.hasOwn(removed.configuration.employees.roles.developer, "taskBrain"),
    false,
  );
  assert.equal(
    Object.hasOwn(initial.baseDocument.employees.roles.developer, "taskBrain"),
    false,
  );
});

test("task brain forms reject unknown providers and non-assigned-brain shapes", () => {
  const path = ["employees", "roles", "developer", "taskBrain"];
  const initial = createConfigurationFormState(representativeConfiguration());
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path,
    value: configurationStructureTemplate(path).value,
  });
  state = setConfigurationFormField(state, {
    path: [...path, "provider"],
    kind: "text",
    rawValue: "missing-provider",
  });
  const unknown = configurationDocumentFromForm(state);
  assert.equal(unknown.ok, false);
  assert.equal(
    unknown.issues.some(
      ({ path: issuePath, code }) =>
        issuePath === "employees.roles.developer.taskBrain.provider" &&
        code === "UNKNOWN_CONFIGURATION_REFERENCE",
    ),
    true,
  );

  const malformed = structuredClone(representativeConfiguration());
  malformed.employees.roles.developer.taskBrain = { enabled: true };
  assert.throws(
    () => createConfigurationFormState(malformed),
    /taskBrain|unknown field|schema/i,
  );
});

test("unknown schemas and unknown nested fields fail closed", () => {
  const configuration = structuredClone(representativeConfiguration());
  configuration.unrecognized = true;
  assert.throws(
    () => createConfigurationFormState(configuration),
    /unsupported configuration field.*unrecognized/i,
  );

  const nested = structuredClone(representativeConfiguration());
  nested.brainProviders.ollama.futureCapability = true;
  assert.throws(
    () => createConfigurationFormState(nested),
    /unsupported configuration field.*futureCapability/i,
  );

  const routing = structuredClone(representativeConfiguration());
  routing.workflowRouting.schemaVersion = 2;
  assert.throws(
    () => createConfigurationFormState(routing),
    /unsupported workflow routing schema version/i,
  );
});

test("dangerous keys, accessors, hostile prototypes, and sparse arrays are rejected", () => {
  const prototypePollution = structuredClone(representativeConfiguration());
  Object.defineProperty(prototypePollution.brainProviders, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  assert.throws(() => createConfigurationFormState(prototypePollution), /dangerous key/i);
  assert.equal({}.polluted, undefined);

  const accessor = structuredClone(representativeConfiguration());
  Object.defineProperty(accessor, "port", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(() => createConfigurationFormState(accessor), /data properties/i);

  const arrayAccessor = structuredClone(representativeConfiguration());
  let arrayAccessorCalled = false;
  Object.defineProperty(arrayAccessor.trackedRepositories, "0", {
    enumerable: true,
    get() {
      arrayAccessorCalled = true;
      return "acme/command-center";
    },
  });
  assert.throws(() => createConfigurationFormState(arrayAccessor), /data properties/i);
  assert.equal(arrayAccessorCalled, false);

  const hostilePrototype = structuredClone(representativeConfiguration());
  Object.setPrototypeOf(hostilePrototype.memory, { inherited: true });
  assert.throws(() => createConfigurationFormState(hostilePrototype), /plain object/i);

  const sparse = structuredClone(representativeConfiguration());
  sparse.trackedRepositories = new Array(2);
  sparse.trackedRepositories[1] = "acme/command-center";
  assert.throws(() => createConfigurationFormState(sparse), /dense array/i);
});

test("shared object aliases and cumulative clone budgets fail before expansion", () => {
  const aliased = structuredClone(representativeConfiguration());
  const sharedImportPolicy = { enabled: true };
  aliased.memory.imports = {
    localSessions: sharedImportPolicy,
    git: sharedImportPolicy,
  };
  assert.throws(
    () => createConfigurationFormState(aliased),
    /shared object reference|alias/i,
  );

  const oversized = structuredClone(representativeConfiguration());
  const repositories = Array.from(
    { length: 34 },
    () => "x".repeat(CONFIGURATION_FORM_LIMITS.maxTextBytes),
  );
  let lateAccessorCalled = false;
  Object.defineProperty(repositories, "33", {
    enumerable: true,
    get() {
      lateAccessorCalled = true;
      throw new Error("clone must stop before this entry");
    },
  });
  oversized.trackedRepositories = repositories;
  assert.throws(
    () => createConfigurationFormState(oversized),
    (error) => error?.code === "FORM_LIMIT_EXCEEDED",
  );
  assert.equal(lateAccessorCalled, false);
});

test("temporary incomplete scalar edits are representable and do not mutate prior state", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const incomplete = setConfigurationFormField(initial, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });

  assert.equal(initial.edits.length, 0);
  assert.equal(incomplete.edits.length, 1);
  assert.equal(configurationDocumentFromForm(incomplete).ok, false);
  assert.deepEqual(configurationDocumentFromForm(incomplete).issues, [
    {
      path: "refreshMinutes",
      code: "INCOMPLETE_INTEGER",
      message: "请输入整数。",
    },
  ]);

  const completed = setConfigurationFormField(incomplete, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "15",
  });
  const result = configurationDocumentFromForm(completed);
  assert.equal(result.ok, true);
  assert.equal(result.configuration.refreshMinutes, 15);
  assert.equal(initial.baseDocument.refreshMinutes, 10);
  assertDeepFrozen(completed);
});

test("current editable scalar constraints match the authoritative configuration contract", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  const cases = [
    { path: ["port"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["refreshMinutes"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["browserPollSeconds"], kind: "integer", rawValue: "0", value: 0 },
    { path: ["githubLogin"], kind: "text", rawValue: "invalid login", value: "invalid login" },
    {
      path: ["prResponsibility", "historicalAfterDays"],
      kind: "integer",
      rawValue: "-1",
      value: -1,
    },
    {
      path: ["workflowRouting", "maxHops"],
      kind: "integer",
      rawValue: "33",
      value: 33,
    },
    {
      path: ["changePackages", "gitCommand"],
      kind: "text",
      rawValue: "",
      value: "",
    },
    {
      path: ["githubActions", "actorAccountId"],
      kind: "text",
      rawValue: "invalid login",
      value: "invalid login",
    },
    {
      path: ["workCoordination", "tickSeconds"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["memory", "maximumRecords"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["memory", "answering", "maximumRecords"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
    {
      path: ["dingtalk", "selfUserId"],
      kind: "text",
      rawValue: "",
      value: "",
    },
    {
      path: ["dingtalk", "notifyMinimumScore"],
      kind: "integer",
      rawValue: "101",
      value: 101,
    },
    {
      path: ["dingtalk", "maxNotificationsPerRun"],
      kind: "integer",
      rawValue: "0",
      value: 0,
    },
  ];

  for (const entry of cases) {
    const { value, ...edit } = entry;
    const edited = setConfigurationFormField(initial, edit);
    const result = configurationDocumentFromForm(edited);
    const displayPath = entry.path.join(".");
    assert.equal(result.ok, false, `${displayPath} must not be marked valid`);
    assert.equal(
      result.issues.some(({ path }) => path === displayPath),
      true,
      `${displayPath} must return a field issue`,
    );

    const canonicalCandidate = structuredClone(configuration);
    let parent = canonicalCandidate;
    for (const segment of entry.path.slice(0, -1)) parent = parent[segment];
    parent[entry.path.at(-1)] = value;
    assert.throws(
      () => normalizeConfigurationDocument(canonicalCandidate),
      undefined,
      `${displayPath} must remain aligned with the authoritative validator`,
    );
  }

  const wrongType = structuredClone(configuration);
  wrongType.port = "4173";
  assert.throws(() => createConfigurationFormState(wrongType), /port/i);
});

test("path identity preserves dotted entity ids without conflating segment boundaries", () => {
  const dottedEntity = ["brainProviders", "provider.with.dot"];
  const nestedFields = ["brainProviders", "provider", "with", "dot"];

  assert.equal(
    dottedEntity.join("."),
    nestedFields.join("."),
    "the old display-path key collides",
  );
  assert.notEqual(
    configurationFormPathKey(dottedEntity),
    configurationFormPathKey(nestedFields),
  );
  assert.equal(
    configurationFormPathKey(["workflowRouting", "rules", 0, "priority"]),
    configurationFormPathKey(["workflowRouting", "rules", "0", "priority"]),
    "numeric and string array indices address the same JavaScript property",
  );
});

test("forged form edits fail closed without polluting prototypes or invoking getters", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const pollutionKey = "__mydashboard_configuration_form_polluted__";
  const dangerous = {
    ...initial,
    edits: [
      {
        path: ["__proto__", pollutionKey],
        kind: "text",
        rawValue: "polluted",
      },
    ],
    dirty: true,
  };

  try {
    assert.throws(
      () => configurationDocumentFromForm(dangerous),
      /unsafe|dangerous/i,
    );
    assert.equal(Object.prototype[pollutionKey], undefined);
    assert.equal({}[pollutionKey], undefined);
  } finally {
    delete Object.prototype[pollutionKey];
  }

  let getterCalled = false;
  const getterEdit = {
    path: ["refreshMinutes"],
    kind: "integer",
  };
  Object.defineProperty(getterEdit, "rawValue", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "15";
    },
  });
  const accessor = { ...initial, edits: [getterEdit], dirty: true };
  assert.throws(() => configurationDocumentFromForm(accessor), /data properties/i);
  assert.equal(getterCalled, false);

  let directEditGetterCalled = false;
  const directEdit = {
    path: ["refreshMinutes"],
    kind: "integer",
  };
  Object.defineProperty(directEdit, "rawValue", {
    enumerable: true,
    get() {
      directEditGetterCalled = true;
      return "15";
    },
  });
  assert.throws(() => setConfigurationFormField(initial, directEdit), /data properties/i);
  assert.equal(directEditGetterCalled, false);

  let identityGetterCalled = false;
  const identity = { kind: "provider" };
  Object.defineProperty(identity, "id", {
    enumerable: true,
    get() {
      identityGetterCalled = true;
      return "unused";
    },
  });
  assert.throws(
    () => configurationReferences(initial.baseDocument, identity),
    /data properties/i,
  );
  assert.equal(identityGetterCalled, false);
});

test("forged unknown edit paths, kinds, raw values, and duplicate paths are rejected", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const editState = (edit, edits = [edit]) => ({
    ...initial,
    edits,
    dirty: true,
  });

  assert.throws(
    () =>
      setConfigurationFormField(initial, {
        path: ["brainProviders", "ollama", "kind"],
        kind: "text",
        rawValue: "openai-compatible",
      }),
    /read-only/i,
  );
  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["unknownField"], kind: "text", rawValue: "value" }),
      ),
    /unknown configuration field/i,
  );
  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["refreshMinutes"], kind: "command", rawValue: "15" }),
      ),
    /unsupported form edit kind/i,
  );
  assert.throws(
    () =>
      configurationDocumentFromForm(
        editState({ path: ["refreshMinutes"], kind: "integer", rawValue: { value: "15" } }),
      ),
    /expects text input/i,
  );
  assert.throws(
    () =>
      removeConfigurationEntity(
        editState({ path: ["refreshMinutes"], kind: "integer", rawValue: "15" }, [
          { path: ["refreshMinutes"], kind: "integer", rawValue: "15" },
          { path: ["refreshMinutes"], kind: "integer", rawValue: "20" },
        ]),
        { kind: "provider", id: "unused" },
      ),
    /duplicate configuration form edit path/i,
  );
});

test("credential controls accept environment references but never secret values", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const invalid = setConfigurationFormField(initial, {
    path: ["brainProviders", "remote-openai", "apiKeyEnv"],
    kind: "text",
    rawValue: "sk-secret-value",
  });
  const rejected = configurationDocumentFromForm(invalid);
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.issues, [
    {
      path: "brainProviders.remote-openai.apiKeyEnv",
      code: "INVALID_ENV_REFERENCE",
      message: "这里只能填写环境变量名称，不能填写凭据值。",
    },
  ]);
  assert.equal(
    JSON.stringify(rejected).includes("sk-secret-value"),
    false,
    "validation DTO must not echo a rejected credential value",
  );

  const valid = setConfigurationFormField(initial, {
    path: ["githubActions", "tokenEnv"],
    kind: "text",
    rawValue: "MYDASHBOARD_GITHUB_TOKEN_NEXT",
  });
  assert.equal(
    configurationDocumentFromForm(valid).configuration.githubActions.tokenEnv,
    "MYDASHBOARD_GITHUB_TOKEN_NEXT",
  );

  for (const mutate of [
    (configuration) => {
      configuration.githubActions.tokenEnv = ["MYDASHBOARD_GITHUB_TOKEN"];
    },
    (configuration) => {
      configuration.brainProviders["remote-openai"].apiKeyEnv = [
        "MYDASHBOARD_OPENAI_API_KEY",
      ];
    },
  ]) {
    const wrongType = structuredClone(representativeConfiguration());
    mutate(wrongType);
    assert.throws(
      () => createConfigurationFormState(wrongType),
      /environment variable name/i,
    );
  }
});

test("GitHub credential mode removes tokenEnv for CLI login and restores it for token mode", () => {
  const configuration = structuredClone(representativeConfiguration());
  configuration.githubActions.enabled = true;
  configuration.githubActions.actorAccountId = "runtime-user";
  configuration.githubActions.ghCommand = process.execPath;
  configuration.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN";

  let state = createConfigurationFormState(configuration);
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["githubActions", "credentialMode"],
    value: "gh-login",
  });
  const cliLogin = configurationDocumentFromForm(state);
  assert.equal(cliLogin.ok, true);
  assert.equal(cliLogin.configuration.githubActions.credentialMode, "gh-login");
  assert.equal(Object.hasOwn(cliLogin.configuration.githubActions, "tokenEnv"), false);

  state = setConfigurationFormField(state, {
    path: ["githubActions", "credentialMode"],
    kind: "text",
    rawValue: "token-env",
  });
  const tokenEnv = configurationDocumentFromForm(state);
  assert.equal(tokenEnv.ok, true);
  assert.equal(tokenEnv.configuration.githubActions.tokenEnv, "MYDASHBOARD_GITHUB_TOKEN");
});

test("reference graph blocks deleting providers, roles, workspaces, and profiles in use", () => {
  const configuration = representativeConfiguration();
  const state = createConfigurationFormState(configuration);

  assert.deepEqual(
    configurationReferences(configuration, { kind: "provider", id: "remote-openai" })
      .map(({ path }) => path),
    [
      "employees.roles.pr-engineer.brain.provider",
      "memory.answering.brain.provider",
    ],
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "provider", id: "remote-openai" })
      .reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "role", id: "developer" }).reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "workspace", id: "command-center" })
      .reason,
    "referenced",
  );
  assert.equal(
    removeConfigurationEntity(state, { kind: "profile", id: "node-contract" })
      .reason,
    "referenced",
  );

  const editedState = setConfigurationFormField(state, {
    path: ["githubLogin"],
    kind: "text",
    rawValue: "local-owner-next",
  });
  const removedProvider = removeConfigurationEntity(editedState, {
    kind: "provider",
    id: "unused",
  });
  assert.equal(removedProvider.removed, true);
  assert.equal(removedProvider.state.dirty, true);
  assert.equal(removedProvider.state.edits.length, 1);
  assert.deepEqual(removedProvider.state.entityOperations, [
    { operation: "remove", kind: "provider", id: "unused" },
  ]);
  assert.equal(
    "unused" in removedProvider.state.baseDocument.brainProviders,
    true,
    "persistent baseline remains unchanged until the draft is saved",
  );
  assert.equal(
    removedProvider.state.baseDocument.githubLogin,
    configuration.githubLogin,
  );
  const removedDocument = configurationDocumentFromForm(removedProvider.state);
  assert.equal(removedDocument.ok, true);
  assert.equal("unused" in removedDocument.configuration.brainProviders, false);
  assert.equal(removedDocument.configuration.githubLogin, "local-owner-next");
  assert.equal("unused" in state.baseDocument.brainProviders, true);

  const removedRole = removeConfigurationEntity(state, {
    kind: "role",
    id: "unused",
  });
  assert.equal(removedRole.removed, true);
  assert.equal("unused" in removedRole.state.baseDocument.employees.roles, true);
  assert.equal(
    "unused" in configurationDocumentFromForm(removedRole.state).configuration.employees.roles,
    false,
  );
  assertDeepFrozen(removedRole);

  const dottedConfiguration = structuredClone(configuration);
  dottedConfiguration.brainProviders["unused.with.dot"] = structuredClone(
    dottedConfiguration.brainProviders.unused,
  );
  const dottedState = createConfigurationFormState(dottedConfiguration);
  const dottedRemoval = removeConfigurationEntity(dottedState, {
    kind: "provider",
    id: "unused.with.dot",
  });
  assert.equal(dottedRemoval.removed, true);
  assert.equal(
    Object.hasOwn(dottedRemoval.state.baseDocument.brainProviders, "unused.with.dot"),
    true,
  );
  const dottedDocument = configurationDocumentFromForm(dottedRemoval.state).configuration;
  assert.equal(Object.hasOwn(dottedDocument.brainProviders, "unused.with.dot"), false);
  assert.equal(
    Object.hasOwn(dottedDocument.brainProviders, "unused"),
    true,
    "entity deletion uses the exact id rather than its display path",
  );
});

test("form DTO boundaries have explicit immutable limits", () => {
  assert.deepEqual(CONFIGURATION_FORM_LIMITS, {
    maxDocumentBytes: 2 * 1024 * 1024,
    maxDepth: 32,
    maxArrayItems: 4_096,
    maxObjectFields: 4_096,
    maxCloneNodes: 100_000,
    maxPathSegments: 32,
    maxEdits: 4_096,
    maxEntityOperations: 4_096,
    maxReferences: 4_096,
    maxTextBytes: 64 * 1024,
  });
  assertDeepFrozen(CONFIGURATION_FORM_LIMITS);

  const state = createConfigurationFormState(representativeConfiguration());
  assert.throws(
    () =>
      setConfigurationFormField(state, {
        path: Array.from({ length: CONFIGURATION_FORM_LIMITS.maxPathSegments + 1 }, () => "x"),
        kind: "text",
        rawValue: "value",
      }),
    /path exceeds/i,
  );
});

test("structured array operations preserve baseline and retain a dirty audit trail", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["trackedRepositories"],
    value: "acme/new-product",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["trackedRepositories"],
    index: 2,
    value: "acme/renamed-product",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["trackedRepositories"],
    index: 2,
  });

  assert.deepEqual(state.baseDocument.trackedRepositories, configuration.trackedRepositories);
  assert.equal(state.entityOperations.length, 3);
  assert.equal(state.dirty, true, "net-zero structural changes remain auditable and dirty");
  assert.deepEqual(
    configurationDocumentFromForm(state).configuration.trackedRepositories,
    configuration.trackedRepositories,
  );

  const reset = resetConfigurationFormState(state);
  assert.equal(reset.dirty, false);
  assert.deepEqual(reset.edits, []);
  assert.deepEqual(reset.entityOperations, []);
  assert.deepEqual(reset.baseDocument, initial.baseDocument);
  assert.deepEqual(reset.binding, initial.binding);
});

test("structured map operations add, replace and remove entries without raw JSON", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const provider = {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    remote: false,
    contextTokens: 8_192,
  };
  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders"],
    key: "temporary",
    value: provider,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["brainProviders"],
    key: "temporary",
    value: { ...provider, timeoutMs: 60_000 },
  });
  let materialized = configurationDocumentFromForm(state);
  assert.equal(materialized.ok, true);
  assert.equal(materialized.configuration.brainProviders.temporary.timeoutMs, 60_000);

  state = applyConfigurationStructureOperation(state, {
    operation: "remove",
    path: ["brainProviders"],
    key: "temporary",
  });
  materialized = configurationDocumentFromForm(state);
  assert.equal(materialized.ok, true);
  assert.equal(Object.hasOwn(materialized.configuration.brainProviders, "temporary"), false);
  assert.equal(state.dirty, true);
  assert.equal(state.entityOperations.length, 3);

  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brainProviders"],
        key: "raw-json",
        rawValue: '{"kind":"ollama"}',
      }),
    /unsupported|unknown|value/i,
  );
});

test("structured operations cover routing, roles, policies and profile bindings", () => {
  const configuration = structuredClone(representativeConfiguration());
  let state = createConfigurationFormState(configuration);
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["employees", "roles", "developer", "permissions", "allowedIntents"],
    value: "orchestrate",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["workflowRouting", "rules", 0, "targets"],
    index: 0,
    value: { type: "role", id: "developer" },
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["workflowRouting", "rules", 0, "condition"],
    value: { op: "equals", path: "eventType", value: "pull_request.updated" },
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["workCoordination", "policy", "workspaceByRepository"],
    key: "acme/new-product",
    value: "command-center",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "replace",
    path: ["codeExecutor", "requiredProfilesByWorkspace"],
    key: "command-center",
    value: ["node-contract", "node-unit"],
  });

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(
    result.configuration.employees.roles.developer.permissions.allowedIntents.includes(
      "orchestrate",
    ),
    true,
  );
  assert.deepEqual(result.configuration.workflowRouting.rules[0].targets[0], {
    type: "role",
    id: "developer",
  });
  assert.equal(result.configuration.workflowRouting.rules[0].condition.op, "equals");
  assert.equal(
    result.configuration.workCoordination.policy.workspaceByRepository[
      "acme/new-product"
    ],
    "command-center",
  );
  assert.deepEqual(
    result.configuration.codeExecutor.requiredProfilesByWorkspace["command-center"],
    ["node-contract", "node-unit"],
  );
});

test("structured configuration preserves reusable Node script assets", () => {
  const configuration = structuredClone(representativeConfiguration());
  configuration.codeExecutor.profiles["reusable-smoke"] = {
    kind: "node-script",
    image: `node@sha256:${"c".repeat(64)}`,
    timeoutMs: 60_000,
    asset: {
      schemaVersion: 1,
      title: "Reusable smoke test",
      description: "A stable assertion shared by future pull requests.",
      version: 2,
      source: 'console.log("ok");',
    },
  };
  configuration.codeExecutor.requiredProfilesByWorkspace.dashboard.push(
    "reusable-smoke",
  );

  const result = configurationDocumentFromForm(
    createConfigurationFormState(configuration),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.configuration.codeExecutor.profiles["reusable-smoke"],
    configuration.codeExecutor.profiles["reusable-smoke"],
  );
});

test("configuration-change proposal authority is configured structurally and must match role intent permission", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  assert.equal(
    Object.hasOwn(
      initial.baseDocument.workCoordination.policy,
      "configurationChangeRoles",
    ),
    false,
    "legacy configurations remain valid without widening authority",
  );

  let state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: [
      "employees",
      "roles",
      "developer",
      "permissions",
      "allowedIntents",
    ],
    value: "propose_configuration_change",
  });
  const incomplete = configurationDocumentFromForm(state);
  assert.equal(incomplete.ok, false);
  assert.equal(
    incomplete.issues.some(
      ({ code }) => code === "MISMATCHED_CONFIGURATION_CHANGE_AUTHORITY",
    ),
    true,
  );

  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["workCoordination", "policy", "configurationChangeRoles"],
    value: "developer",
  });
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.configuration.workCoordination.policy.configurationChangeRoles,
    ["developer"],
  );
  assert.equal(
    result.configuration.employees.roles.developer.permissions.allowedIntents.includes(
      "propose_configuration_change",
    ),
    true,
  );
  assert.deepEqual(
    normalizeConfigurationDocument(result.configuration),
    result.configuration,
  );
  assert.equal(
    configurationFieldDescriptor(
      [
        "employees",
        "roles",
        "developer",
        "permissions",
        "allowedIntents",
        3,
      ],
      "propose_configuration_change",
    ).options.includes("propose_configuration_change"),
    true,
  );
  assert.equal(
    configurationReferences(result.configuration, {
      kind: "role",
      id: "developer",
    }).some(
      ({ path }) =>
        path === "workCoordination.policy.configurationChangeRoles[0]",
    ),
    true,
  );
});

test("built-in PR reviewer cannot receive configuration-change proposal authority", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["workCoordination", "policy", "configurationChangeRoles"],
    value: "pr-reviewer",
  });
  const result = configurationDocumentFromForm(state);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some(
      ({ code }) => code === "INVALID_CONFIGURATION_CHANGE_AUTHORITY",
    ),
    true,
  );
});

test("PR external action capabilities can be configured without editing JSON", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let edited = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["githubActions", "enabledActions"],
    value: "comment",
  });
  edited = applyConfigurationStructureOperation(edited, {
    operation: "add",
    path: ["githubActions", "enabledActions"],
    value: "merge",
  });

  const result = configurationDocumentFromForm(edited);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.githubActions.enabledActions, [
    "comment",
    "merge",
  ]);

  const unknown = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["githubActions", "enabledActions"],
    value: "delete_branch",
  });
  assert.equal(configurationDocumentFromForm(unknown).ok, false);
});

test("mail summary can be added, toggled and removed without altering other settings", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  const path = ["dingtalk", "mailEnabled"];
  const added = applyConfigurationStructureOperation(initial, { operation: "add", path, value: false });
  const enabled = setConfigurationFormField(added, { path, kind: "boolean", rawValue: true });
  assert.equal(configurationDocumentFromForm(enabled).configuration.dingtalk.mailEnabled, true);
  const disabled = setConfigurationFormField(enabled, { path, kind: "boolean", rawValue: false });
  assert.equal(configurationDocumentFromForm(disabled).configuration.dingtalk.mailEnabled, false);
  const removed = applyConfigurationStructureOperation(disabled, { operation: "remove", path });
  assert.deepEqual(configurationDocumentFromForm(removed).configuration, configuration);
  assert.equal(configurationFieldDescriptor(path, false).control, "checkbox");
});

test("own PR repair can be added, toggled and removed without granting generic push", () => {
  const configuration = structuredClone(representativeConfiguration());
  delete configuration.githubActions.automaticOwnPrRepair;
  const initial = createConfigurationFormState(configuration);
  const path = ["githubActions", "automaticOwnPrRepair"];
  const added = applyConfigurationStructureOperation(initial, {
    operation: "add", path, value: false,
  });
  const replaced = applyConfigurationStructureOperation(added, {
    operation: "replace", path, value: true,
  });
  const enabled = configurationDocumentFromForm(replaced);
  assert.equal(enabled.ok, true);
  assert.equal(normalizeConfigurationDocument(enabled.configuration).githubActions.automaticOwnPrRepair, true);
  assert.deepEqual(enabled.configuration.githubActions.enabledActions, configuration.githubActions.enabledActions);

  const toggled = setConfigurationFormField(replaced, {
    path, kind: "boolean", rawValue: false,
  });
  assert.equal(configurationDocumentFromForm(toggled).configuration.githubActions.automaticOwnPrRepair, false);
  const removed = applyConfigurationStructureOperation(toggled, { operation: "remove", path });
  const restored = configurationDocumentFromForm(removed);
  assert.equal(restored.ok, true);
  assert.deepEqual(normalizeConfigurationDocument(restored.configuration), configuration);
});

test("structured operation boundary rejects getters, aliases, prototypes and disallowed paths", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let getterCalled = false;
  const input = {
    operation: "add",
    path: ["trackedRepositories"],
  };
  Object.defineProperty(input, "value", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "acme/unsafe";
    },
  });
  assert.throws(() => applyConfigurationStructureOperation(initial, input), /data properties/i);
  assert.equal(getterCalled, false);

  const shared = { type: "role", id: "developer" };
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["workflowRouting", "rules"],
        value: {
          id: "aliased",
          source: "root",
          enabled: false,
          priority: 0,
          fallback: false,
          condition: { op: "equals", path: "eventType", value: "test" },
          targets: [shared, shared],
          onMatch: "stop",
        },
      }),
    /shared object reference/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brain"],
        key: "provider",
        value: "unsafe",
      }),
    /not an editable collection|allowlist/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["trackedRepositories"],
        value: Object.create(null),
      }),
    /plain object/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["brainProviders"],
        key: "remote-secret",
        value: {
          kind: "openai-compatible",
          baseUrl: "https://models.example.invalid/v1",
          apiKeyEnv: "sk-secret-value",
          remote: true,
        },
      }),
    /environment variable reference|credential/i,
  );
  assert.throws(
    () =>
      applyConfigurationStructureOperation(initial, {
        operation: "add",
        path: ["trackedRepositories"],
        value: "x".repeat(CONFIGURATION_FORM_LIMITS.maxTextBytes + 1),
      }),
    /form limit/i,
  );
});

test("provider, role, workspace and profile support add, replace and remove", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  let state = initial;
  const cases = [
    {
      path: ["brainProviders"],
      key: "temporary-provider",
      value: configurationStructureTemplate(["brainProviders"]).value,
      replacement(value) {
        return { ...structuredClone(value), timeoutMs: 60_000 };
      },
    },
    {
      path: ["employees", "roles"],
      key: "temporary-role",
      value: configurationStructureTemplate(["employees", "roles"]).value,
      replacement(value) {
        return { ...structuredClone(value), name: "临时岗位（已修改）" };
      },
    },
    {
      path: ["codeExecutor", "workspaces"],
      index: initial.baseDocument.codeExecutor.workspaces.length,
      value: configurationStructureTemplate(["codeExecutor", "workspaces"]).value,
      replacement(value) {
        return { ...structuredClone(value), sourceRoot: "D:/temporary" };
      },
    },
    {
      path: ["codeExecutor", "profiles"],
      key: "temporary-profile",
      value: configurationStructureTemplate(["codeExecutor", "profiles"]).value,
      replacement(value) {
        return { ...structuredClone(value), timeoutMs: 90_000 };
      },
    },
  ];

  for (const entry of cases) {
    const identity = Object.hasOwn(entry, "key")
      ? { key: entry.key }
      : { index: entry.index };
    state = applyConfigurationStructureOperation(state, {
      operation: "add",
      path: entry.path,
      ...identity,
      value: entry.value,
    });
    state = applyConfigurationStructureOperation(state, {
      operation: "replace",
      path: entry.path,
      ...identity,
      value: entry.replacement(entry.value),
    });
    state = applyConfigurationStructureOperation(state, {
      operation: "remove",
      path: entry.path,
      ...identity,
    });
  }

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, initial.baseDocument);
  assert.equal(state.entityOperations.length, cases.length * 3);
  assert.equal(state.dirty, true);
});

test("profile form rejects IDs outside the sandbox boundary", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  for (const id of ["node_test", "node.test", "a".repeat(65)]) {
    assert.throws(() => applyConfigurationStructureOperation(initial, {
      operation: "add",
      path: ["codeExecutor", "profiles"],
      key: id,
      value: configurationStructureTemplate(["codeExecutor", "profiles"]).value,
    }));
    const edited = setConfigurationFormField(initial, {
      path: ["codeExecutor", "requiredProfilesByWorkspace", "dashboard", 0],
      kind: "text",
      rawValue: id,
    });
    const result = configurationDocumentFromForm(edited);
    assert.equal(result.ok, false);
    assert.equal(
      result.issues.some((issue) => issue.path?.includes("requiredProfilesByWorkspace")),
      true,
      JSON.stringify(result.issues),
    );
  }
});

test("the Responses provider variant materializes as a closed structured configuration", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const template = configurationStructureTemplate(
    ["brainProviders"],
    "openai-responses",
  );
  const state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders"],
    key: template.key,
    value: template.value,
  });
  const result = configurationDocumentFromForm(state);

  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration.brainProviders[template.key], template.value);
  assert.doesNotThrow(() => normalizeConfigurationDocument(result.configuration));

  const invalidState = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders"],
    key: "unsafe-responses",
    value: { ...template.value, maxRequestBytes: 1024 * 1024 + 1 },
  });
  const invalidResult = configurationDocumentFromForm(invalidState);
  assert.equal(invalidResult.ok, false);
  assert.match(JSON.stringify(invalidResult.issues), /1048576|整数/i);

  const incompatibleState = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders"],
    key: "unsafe-json-object",
    value: { ...template.value, responseFormat: "json-object" },
  });
  const incompatibleResult = configurationDocumentFromForm(incompatibleState);
  assert.equal(incompatibleResult.ok, false);
  assert.match(
    JSON.stringify(incompatibleResult.issues),
    /INVALID_PROVIDER_CONFIGURATION/,
  );
});

test("supervised CLI providers round-trip through the structured form", () => {
  for (const kind of ["codex-cli", "claude-cli"]) {
    const configuration = structuredClone(representativeConfiguration());
    configuration.brainProviders[kind] = {
      kind,
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    };
    configuration.employees.roles.orchestrator.brain.provider = kind;

    const result = configurationDocumentFromForm(
      createConfigurationFormState(configuration),
    );
    assert.equal(result.ok, true, kind);
    assert.deepEqual(result.configuration.brainProviders[kind], configuration.brainProviders[kind]);
    assert.equal(result.configuration.employees.roles.orchestrator.brain.provider, kind);
    assert.doesNotThrow(() => normalizeConfigurationDocument(result.configuration));
  }
});

test("CLI credential mode is added structurally without rewriting legacy providers", () => {
  const configuration = structuredClone(representativeConfiguration());
  configuration.brainProviders["legacy-cli"] = {
    kind: "codex-cli",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  const initial = createConfigurationFormState(configuration);
  assert.equal(
    Object.hasOwn(initial.baseDocument.brainProviders["legacy-cli"], "credentialMode"),
    false,
  );

  const state = applyConfigurationStructureOperation(initial, {
    operation: "add",
    path: ["brainProviders", "legacy-cli", "credentialMode"],
    value: "api-key",
  });
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.equal(result.configuration.brainProviders["legacy-cli"].credentialMode, "api-key");

  const nativeState = setConfigurationFormField(state, {
    path: ["brainProviders", "legacy-cli", "credentialMode"],
    kind: "text",
    rawValue: "codex-native-login",
  });
  const native = configurationDocumentFromForm(nativeState);
  assert.equal(native.ok, true);
  assert.equal(native.configuration.brainProviders["legacy-cli"].credentialMode, "codex-native-login");
  assert.doesNotThrow(() => normalizeConfigurationDocument(native.configuration));
  assert.equal(
    Object.hasOwn(configurationDocumentFromForm(initial).configuration.brainProviders["legacy-cli"], "credentialMode"),
    false,
  );

  for (const [kind, credentialMode] of [
    ["codex-cli", "unsupported"],
    ["claude-cli", "codex-login"],
    ["claude-cli", "codex-native-login"],
    ["ollama", "api-key"],
  ]) {
    const invalid = structuredClone(configuration);
    invalid.brainProviders["legacy-cli"] = {
      kind,
      ...(kind === "ollama"
        ? { baseUrl: "http://127.0.0.1:11434", remote: false }
        : { remote: true }),
      credentialMode,
    };
    assert.throws(
      () => createConfigurationFormState(invalid),
      (error) => error?.code === "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `${kind}.${credentialMode}`,
    );
  }
});

test("each invalid supervised CLI numeric field produces one form issue", () => {
  for (const [providerId, field, value] of [
    ["invalid-cli-timeout", "timeoutMs", 999],
    ["invalid-cli-response", "maxResponseBytes", 1_023],
    ["invalid-cli-request", "maxRequestBytes", 1024 * 1024 + 1],
  ]) {
    const initial = createConfigurationFormState(representativeConfiguration());
    const state = applyConfigurationStructureOperation(initial, {
      operation: "add",
      path: ["brainProviders"],
      key: providerId,
      value: {
        kind: "codex-cli",
        remote: true,
        timeoutMs: 300_000,
        maxResponseBytes: 131_072,
        maxRequestBytes: 262_144,
        [field]: value,
      },
    });

    const result = configurationDocumentFromForm(state);
    const matching = result.issues.filter(
      (entry) => entry.path === `brainProviders.${providerId}.${field}`,
    );
    assert.equal(result.ok, false, field);
    assert.equal(matching.length, 1, field);
    assert.equal(matching[0].code, "INVALID_CONFIGURATION_INTEGER", field);
  }
});

test("supervised CLI provider forms reject authority-bearing fields", () => {
  const cases = [
    ["remote", (provider) => { delete provider.remote; }],
    ["remote", (provider) => { provider.remote = false; }],
    ["baseUrl", (provider) => { provider.baseUrl = "https://models.example/v1"; }],
    ["apiKeyEnv", (provider) => { provider.apiKeyEnv = "OPENAI_API_KEY"; }],
    ["protocol", (provider) => { provider.protocol = "responses"; }],
    ["responseFormat", (provider) => { provider.responseFormat = "json-schema"; }],
    ["contextTokens", (provider) => { provider.contextTokens = 16_384; }],
    ["executable", (provider) => { provider.executable = "claude"; }],
    ["args", (provider) => { provider.args = ["--dangerously-skip-permissions"]; }],
  ];

  for (const [field, mutate] of cases) {
    const configuration = structuredClone(representativeConfiguration());
    configuration.brainProviders["claude-cli"] = {
      kind: "claude-cli",
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    };
    mutate(configuration.brainProviders["claude-cli"]);
    assert.throws(
      () => createConfigurationFormState(configuration),
      (error) =>
        error?.path?.includes("brainProviders.claude-cli") &&
        error.message.includes("brainProviders.claude-cli"),
      field,
    );
  }
});

test("provider forms preserve legacy limits when protocol is omitted", () => {
  const configuration = structuredClone(representativeConfiguration());
  Object.assign(configuration.brainProviders["remote-openai"], {
    timeoutMs: 180_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 1,
  });

  const result = configurationDocumentFromForm(
    createConfigurationFormState(configuration),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.configuration.brainProviders["remote-openai"],
    configuration.brainProviders["remote-openai"],
  );
  assert.doesNotThrow(() => normalizeConfigurationDocument(result.configuration));

  configuration.brainProviders["remote-openai"].protocol = "chat-completions";
  assert.throws(
    () => createConfigurationFormState(configuration),
    /authoritative configuration constraint/i,
  );
});

test("every primitive field can round-trip through its declarative edit kind", () => {
  const configuration = representativeConfiguration();
  let state = createConfigurationFormState(configuration);

  function visit(value, path) {
    if (value === null || typeof value !== "object") {
      const descriptor = configurationFieldDescriptor(path, value);
      if (descriptor.readOnly) return;
      const rawValue =
        descriptor.kind === "boolean"
          ? value
          : descriptor.kind === "scalar"
            ? JSON.stringify(value)
            : `${value}`;
      state = setConfigurationFormField(state, {
        path,
        kind: descriptor.kind,
        rawValue,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key]);
  }

  visit(configuration, []);
  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, configuration);
});

test("declarative field constraints reject canonical-invalid values across every group", () => {
  const configuration = representativeConfiguration();
  const initial = createConfigurationFormState(configuration);
  const cases = [
    { path: ["codeExecutor", "docker", "host"], kind: "text", rawValue: "https://docker.invalid", value: "https://docker.invalid" },
    { path: ["codeExecutor", "workspaces", 0, "id"], kind: "text", rawValue: "Unsafe_ID", value: "Unsafe_ID" },
    { path: ["codeExecutor", "profiles", "node-unit", "image"], kind: "text", rawValue: "node:latest", value: "node:latest" },
    { path: ["brainProviders", "ollama", "timeoutMs"], kind: "integer", rawValue: `${2 * 1_024 * 1_024 + 1}`, value: 2 * 1_024 * 1_024 + 1 },
    { path: ["employees", "roles", "developer", "mission"], kind: "text", rawValue: "x".repeat(4_097), value: "x".repeat(4_097) },
    { path: ["employees", "roles", "developer", "permissions", "allowedIntents", 0], kind: "text", rawValue: "unknown_intent", value: "unknown_intent" },
    { path: ["workflowRouting", "rules", 0, "priority"], kind: "integer", rawValue: "10001", value: 10_001 },
    { path: ["workflowRouting", "rules", 0, "condition", "conditions", 0, "conditions", 0, "path"], kind: "text", rawValue: "payload.__proto__", value: "payload.__proto__" },
    { path: ["workCoordination", "policy", "codeOperationsByRole", "developer", 0], kind: "text", rawValue: "execute", value: "execute" },
    { path: ["memory", "answering", "maximumConcurrent"], kind: "integer", rawValue: "17", value: 17 },
    { path: ["dingtalk", "selfUserId"], kind: "text", rawValue: "", value: "" },
  ];

  for (const entry of cases) {
    const { value, ...edit } = entry;
    const result = configurationDocumentFromForm(
      setConfigurationFormField(initial, edit),
    );
    assert.equal(result.ok, false, `${entry.path.join(".")} must fail in the form`);

    const canonical = structuredClone(configuration);
    let parent = canonical;
    for (const segment of entry.path.slice(0, -1)) parent = parent[segment];
    parent[entry.path.at(-1)] = value;
    assert.throws(
      () => normalizeConfigurationDocument(canonical),
      undefined,
      `${entry.path.join(".")} must fail in the canonical contract`,
    );
  }
});

test("generic structural deletion is reference-safe and delete plus recreate stays dirty", () => {
  const initial = createConfigurationFormState(representativeConfiguration());
  const provider = structuredClone(initial.baseDocument.brainProviders.ollama);
  const removed = applyConfigurationStructureOperation(initial, {
    operation: "remove",
    path: ["brainProviders"],
    key: "ollama",
  });
  const blocked = configurationDocumentFromForm(removed);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issues.some(({ code }) => code === "ENTITY_REFERENCED"), true);

  const recreated = applyConfigurationStructureOperation(removed, {
    operation: "add",
    path: ["brainProviders"],
    key: "ollama",
    value: provider,
  });
  const restored = configurationDocumentFromForm(recreated);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.configuration, initial.baseDocument);
  assert.equal(recreated.dirty, true);
  assert.equal(recreated.entityOperations.length, 2);
});
