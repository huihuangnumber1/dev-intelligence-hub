import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSafeDisabledConfiguration,
  mergeConfig,
} from "../src/lib/config.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test("local provider settings merge without erasing base defaults", () => {
  const result = mergeConfig(
    {
      dingtalk: { enabled: true, maxNotificationsPerRun: 5 },
      brain: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        contextTokens: 8192,
      },
      prResponsibility: { historicalAfterDays: 60 },
      employees: {
        prReviewer: {
          enabled: true,
          maxJobsPerTick: 2,
          brain: { timeoutMs: 45_000 },
        },
      },
    },
    {
      dingtalk: { enabled: false },
      brain: { model: "another-model" },
      prResponsibility: { historicalAfterDays: 30 },
      employees: {
        prReviewer: {
          maxJobsPerTick: 1,
          brain: { model: "employee-model" },
        },
      },
    },
  );

  assert.deepEqual(result.dingtalk, {
    enabled: false,
    maxNotificationsPerRun: 5,
  });
  assert.equal(result.brain.enabled, true);
  assert.equal(result.brain.model, "another-model");
  assert.equal(result.brain.contextTokens, 8192);
  assert.equal(result.prResponsibility.historicalAfterDays, 30);
  assert.deepEqual(result.employees.prReviewer, {
    enabled: true,
    maxJobsPerTick: 1,
    brain: { timeoutMs: 45_000, model: "employee-model" },
  });
});

test("GitHub-read overrides deep merge without inventing or deleting a PR window", () => {
  const rolling = { mode: "rolling", days: 7 };
  const base = {
    githubRead: { enabled: true, pullRequestUpdatedWindow: rolling },
  };

  assert.deepEqual(mergeConfig(base, { githubRead: { enabled: false } }).githubRead, {
    enabled: false,
    pullRequestUpdatedWindow: rolling,
  });
  assert.deepEqual(
    mergeConfig(base, {
      githubRead: {
        pullRequestUpdatedWindow: { mode: "rolling", days: 30 },
      },
    }).githubRead,
    {
      enabled: true,
      pullRequestUpdatedWindow: { mode: "rolling", days: 30 },
    },
  );
  assert.equal(Object.hasOwn(mergeConfig({}, {}), "githubRead"), false);
});

test("configured brains and role permissions merge independently by id", () => {
  const result = mergeConfig(
    {
      brainProviders: {
        ollama: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          timeoutMs: 45_000,
        },
      },
      employees: {
        roles: {
          developer: {
            name: "开发工程师",
            enabled: true,
            permissions: { allowedIntents: ["ask_user", "complete"] },
            brain: {
              provider: "ollama",
              model: "qwen3.5:9b",
              remoteData: {
                requirements: false,
                code: false,
                memory: false,
              },
            },
          },
        },
      },
    },
    {
      brainProviders: { ollama: { timeoutMs: 60_000 } },
      employees: {
        roles: {
          developer: {
            brain: { remoteData: { memory: true } },
          },
          tester: { name: "测试工程师" },
        },
      },
    },
  );

  assert.deepEqual(result.brainProviders.ollama, {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 60_000,
  });
  assert.deepEqual(result.employees.roles.developer, {
    name: "开发工程师",
    enabled: true,
    permissions: { allowedIntents: ["ask_user", "complete"] },
    brain: {
      provider: "ollama",
      model: "qwen3.5:9b",
      remoteData: {
        requirements: false,
        code: false,
        memory: true,
      },
    },
  });
  assert.deepEqual(result.employees.roles.tester, { name: "测试工程师" });
});

test("role task brain overrides merge independently from the routine brain", () => {
  const result = mergeConfig(
    {
      employees: {
        roles: {
          developer: {
            brain: {
              provider: "ollama",
              model: "routine-model",
              remoteData: { requirements: false, code: false, memory: false },
            },
            taskBrain: {
              provider: "remote-coder",
              model: "task-model",
              remoteData: { requirements: true, code: true, memory: false },
            },
          },
        },
      },
    },
    {
      employees: {
        roles: {
          developer: {
            brain: { model: "routine-model-v2" },
            taskBrain: {
              model: "task-model-v2",
              remoteData: { memory: true },
            },
          },
        },
      },
    },
  );

  assert.equal(result.employees.roles.developer.brain.model, "routine-model-v2");
  assert.deepEqual(result.employees.roles.developer.taskBrain, {
    provider: "remote-coder",
    model: "task-model-v2",
    remoteData: { requirements: true, code: true, memory: true },
  });
});

test("GitHub action settings merge without storing a credential value", () => {
  const result = mergeConfig(
    {
      githubActions: {
        enabled: false,
        actorAccountId: "",
        tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
        networkEnv: { NO_PROXY: "github.com" },
      },
    },
    {
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
        ghCommand: "C:\\Program Files\\GitHub CLI\\gh.exe",
        networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
      },
    },
  );

  assert.deepEqual(result.githubActions, {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    ghCommand: "C:\\Program Files\\GitHub CLI\\gh.exe",
    networkEnv: {
      NO_PROXY: "github.com",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    },
  });
  assert.equal("token" in result.githubActions, false);
});

test("workflow routing is replaced as one versioned definition", () => {
  const base = {
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [{ id: "base-rule" }],
    },
  };
  const localDefinition = {
    schemaVersion: 1,
    enabled: false,
    maxHops: 4,
    rules: [],
  };

  const result = mergeConfig(base, { workflowRouting: localDefinition });

  assert.deepEqual(result.workflowRouting, localDefinition);
  assert.equal(result.workflowRouting.rules.some((rule) => rule.id === "base-rule"), false);
});

test("code executor settings merge nested sections independently", () => {
  const baseWorkspaces = [
    { id: "dashboard", sourceRoot: "dashboard" },
  ];
  const localWorkspaces = [
    { id: "product", sourceRoot: "product" },
  ];
  const result = mergeConfig(
    {
      codeExecutor: {
        enabled: false,
        docker: {
          executable: "base-docker",
          host: "npipe:////./pipe/dockerDesktopLinuxEngine",
        },
        workspaces: baseWorkspaces,
        profiles: {
          "node-tests": { kind: "node-test", timeoutMs: 30_000 },
          "fast-tests": { kind: "node-test", timeoutMs: 10_000 },
        },
        requiredProfilesByWorkspace: {
          dashboard: ["node-tests"],
          product: ["fast-tests"],
        },
        brokerLimits: { maxFiles: 5_000, maxFileBytes: 2_000_000 },
        executorLimits: { maxSessions: 10, maxActionsPerSession: 100 },
        maxArtifactBytes: 1_000_000,
      },
    },
    {
      codeExecutor: {
        enabled: true,
        docker: { executable: "podman" },
        workspaces: localWorkspaces,
        profiles: {
          "fast-tests": { kind: "node-test", timeoutMs: 15_000 },
        },
        requiredProfilesByWorkspace: { product: ["fast-tests"] },
        brokerLimits: { maxFiles: 4_000 },
        executorLimits: { maxSessions: 20 },
        maxArtifactBytes: 2_000_000,
      },
    },
  );

  assert.deepEqual(result.codeExecutor, {
    enabled: true,
    docker: {
      executable: "podman",
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: localWorkspaces,
    profiles: {
      "node-tests": { kind: "node-test", timeoutMs: 30_000 },
      "fast-tests": { kind: "node-test", timeoutMs: 15_000 },
    },
    requiredProfilesByWorkspace: {
      product: ["fast-tests"],
    },
    brokerLimits: { maxFiles: 4_000, maxFileBytes: 2_000_000 },
    executorLimits: { maxSessions: 20, maxActionsPerSession: 100 },
    maxArtifactBytes: 2_000_000,
  });
  assert.strictEqual(result.codeExecutor.workspaces, localWorkspaces);
});

test("replacing workspaces also replaces their profile bindings", () => {
  const result = mergeConfig(
    {
      codeExecutor: {
        workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
        requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
      },
    },
    {
      codeExecutor: {
        workspaces: [{ id: "product", sourceRoot: "product" }],
      },
    },
  );

  assert.deepEqual(result.codeExecutor.requiredProfilesByWorkspace, {});
});

test("code executor overrides preserve unspecified base defaults", () => {
  const base = {
    codeExecutor: {
      enabled: false,
      docker: {
        executable: "docker",
        host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      },
      workspaces: [{ id: "dashboard", sourceRoot: "base-path" }],
      profiles: { "node-tests": { timeoutMs: 30_000 } },
      requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
      brokerLimits: { maxFiles: 2_000 },
      executorLimits: { maxSessions: 10 },
      maxArtifactBytes: 1_000_000,
    },
  };

  assert.deepEqual(
    mergeConfig(base, { codeExecutor: { enabled: true } }).codeExecutor,
    {
      ...base.codeExecutor,
      enabled: true,
    },
  );
});

test("conflict preparation overlays repository mirrors without erasing base entries", () => {
  const result = mergeConfig(
    {
      codeExecutor: {
        enabled: false,
        conflictPreparation: {
          enabled: true,
          baseMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-base.git",
          },
          headMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-head.git",
          },
        },
      },
    },
    {
      codeExecutor: {
        conflictPreparation: {
          baseMirrorsByRepository: {
            "acme/dashboard": "D:/mirrors/dashboard-base.git",
          },
          headMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/replacement-head.git",
          },
        },
      },
    },
  );

  assert.deepEqual(result.codeExecutor.conflictPreparation, {
    enabled: true,
    baseMirrorsByRepository: {
      "acme/command-center": "D:/mirrors/command-center-base.git",
      "acme/dashboard": "D:/mirrors/dashboard-base.git",
    },
    headMirrorsByRepository: {
      "acme/command-center": "D:/mirrors/replacement-head.git",
    },
  });
});

test("conflict preparation repository overrides are case insensitive", () => {
  const result = mergeConfig(
    {
      codeExecutor: {
        enabled: false,
        conflictPreparation: {
          enabled: true,
          baseMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-base.git",
          },
          headMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-head.git",
          },
        },
      },
    },
    {
      codeExecutor: {
        conflictPreparation: {
          baseMirrorsByRepository: {
            "ACME/COMMAND-CENTER": "D:/local/command-center-base.git",
          },
          headMirrorsByRepository: {
            "ACME/COMMAND-CENTER": "D:/local/command-center-head.git",
          },
        },
      },
    },
  );

  assert.deepEqual(result.codeExecutor.conflictPreparation, {
    enabled: true,
    baseMirrorsByRepository: {
      "ACME/COMMAND-CENTER": "D:/local/command-center-base.git",
    },
    headMirrorsByRepository: {
      "ACME/COMMAND-CENTER": "D:/local/command-center-head.git",
    },
  });
});

test("conflict preparation rejects case-only duplicates within either layer", () => {
  const duplicateMirrors = {
    "acme/command-center": "D:/mirrors/command-center-base.git",
    "ACME/COMMAND-CENTER": "D:/mirrors/other-base.git",
  };
  for (const [baseMirrors, localMirrors] of [
    [duplicateMirrors, {}],
    [{}, duplicateMirrors],
  ]) {
    assert.throws(
      () =>
        mergeConfig(
          {
            codeExecutor: {
              conflictPreparation: {
                enabled: true,
                baseMirrorsByRepository: baseMirrors,
              },
            },
          },
          {
            codeExecutor: {
              conflictPreparation: {
                baseMirrorsByRepository: localMirrors,
              },
            },
          },
        ),
      /case-insensitive duplicate names/,
    );
  }
});

test("disabling conflict preparation clears inherited privileged mirror fields", () => {
  const result = mergeConfig(
    {
      codeExecutor: {
        conflictPreparation: {
          enabled: true,
          baseMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-base.git",
          },
          headMirrorsByRepository: {
            "acme/command-center": "D:/mirrors/command-center-head.git",
          },
        },
      },
    },
    { codeExecutor: { conflictPreparation: { enabled: false } } },
  );

  assert.deepEqual(result.codeExecutor.conflictPreparation, { enabled: false });
  assert.equal(
    Object.hasOwn(mergeConfig({ codeExecutor: { enabled: false } }, {}).codeExecutor, "conflictPreparation"),
    false,
  );
});

test("change package overrides preserve local runtime defaults", () => {
  assert.deepEqual(
    mergeConfig(
      {
        changePackages: {
          enabled: false,
          gitTimeoutMs: 15_000,
        },
      },
      {
        changePackages: {
          enabled: true,
          gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
        },
      },
    ).changePackages,
    {
      enabled: true,
      gitTimeoutMs: 15_000,
      gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    },
  );
});

test("work coordination overrides merge trusted policy maps without losing defaults", () => {
  const result = mergeConfig(
    {
      workCoordination: {
        enabled: true,
        workLimit: 20,
        policy: {
          version: 1,
          capabilityRoles: {
            requirements: "requirements-analyst",
            testing: "tester",
          },
          githubReviewRoles: ["pr-reviewer"],
          workspaceByRepository: {
            "acme/base": "base-workspace",
          },
          codeOperationsByRole: {
            developer: ["inspect", "modify", "verify"],
          },
        },
      },
    },
    {
      workCoordination: {
        workLimit: 5,
        policy: {
          capabilityRoles: { testing: "qa-specialist" },
          workspaceByRepository: {
            "acme/local": "local-workspace",
          },
          codeOperationsByRole: {
            tester: ["inspect", "verify"],
          },
        },
      },
    },
  );

  assert.deepEqual(result.workCoordination, {
    enabled: true,
    workLimit: 5,
    policy: {
      version: 1,
      capabilityRoles: {
        requirements: "requirements-analyst",
        testing: "qa-specialist",
      },
      githubReviewRoles: ["pr-reviewer"],
      workspaceByRepository: {
        "acme/base": "base-workspace",
        "acme/local": "local-workspace",
      },
      codeOperationsByRole: {
        developer: ["inspect", "modify", "verify"],
        tester: ["inspect", "verify"],
      },
    },
  });
});

test("memory overrides preserve local capacity defaults", () => {
  const result = mergeConfig(
    {
      memory: {
        enabled: true,
        maximumRecords: 20_000,
        maximumStateBytes: 64 * 1024 * 1024,
      },
    },
    { memory: { maximumRecords: 5_000 } },
  );

  assert.deepEqual(result.memory, {
    enabled: true,
    maximumRecords: 5_000,
    maximumStateBytes: 64 * 1024 * 1024,
  });
});

test("memory answer and import overrides preserve independent safe defaults", () => {
  const result = mergeConfig(
    {
      memory: {
        enabled: true,
        imports: { localSessions: false, git: false },
        answering: {
          enabled: true,
          maximumRecords: 12,
          brain: {
            provider: "ollama",
            model: "base-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
          localBrain: {
            provider: "ollama",
            model: "local-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
      },
    },
    {
      memory: {
        imports: { git: true },
        answering: {
          brain: { model: "remote-model", remoteData: { memory: true } },
        },
      },
    },
  );

  assert.deepEqual(result.memory.imports, {
    localSessions: false,
    git: true,
  });
  assert.deepEqual(result.memory.answering.brain, {
    provider: "ollama",
    model: "remote-model",
    remoteData: { requirements: false, code: false, memory: true },
  });
  assert.deepEqual(result.memory.answering.localBrain, {
    provider: "ollama",
    model: "local-model",
    remoteData: { requirements: false, code: false, memory: false },
  });
  assert.equal(result.memory.answering.maximumRecords, 12);
});

test("the unified memory master switch preserves but does not activate child choices", () => {
  const result = mergeConfig(
    {
      memory: {
        enabled: true,
        answering: { enabled: true },
        imports: { localSessions: true, git: true },
      },
    },
    { memory: { enabled: false } },
  );

  assert.equal(result.memory.enabled, false);
  assert.equal(result.memory.answering.enabled, true);
  assert.deepEqual(result.memory.imports, {
    localSessions: true,
    git: true,
  });
});

test("safe configuration disables conflict preparation without adding it to legacy documents", async () => {
  const configPath = path.resolve(testDirectory, "../config.example.json");
  const legacy = JSON.parse(await readFile(configPath, "utf8"));
  const legacySafe = createSafeDisabledConfiguration(legacy);
  assert.equal(
    Object.hasOwn(legacySafe.codeExecutor, "conflictPreparation"),
    false,
  );

  const configured = structuredClone(legacy);
  configured.codeExecutor = {
    enabled: false,
    gitCommand: process.platform === "win32"
      ? "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
      : "/usr/bin/git",
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: {
        "acme/command-center": process.platform === "win32"
          ? "D:\\mirrors\\base.git"
          : "/var/lib/mirrors/base.git",
      },
      headMirrorsByRepository: {
        "acme/command-center": process.platform === "win32"
          ? "D:\\mirrors\\head.git"
          : "/var/lib/mirrors/head.git",
      },
    },
  };

  assert.deepEqual(
    createSafeDisabledConfiguration(configured).codeExecutor.conflictPreparation,
    { enabled: false },
  );
});

test("safe configuration explicitly disables optional memory imports", async () => {
  const configPath = path.resolve(testDirectory, "../config.example.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  delete config.memory.imports;

  const safe = createSafeDisabledConfiguration(config);

  assert.deepEqual(safe.memory.imports, {
    localSessions: false,
    git: false,
  });
});

test("committed privileged capabilities are disabled and secret-free", async () => {
  const configPath = path.resolve(testDirectory, "../config.example.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.deepEqual(config.codeExecutor, { enabled: false });
  assert.deepEqual(config.changePackages, { enabled: false });
  assert.deepEqual(config.githubActions, {
    enabled: false,
    automaticReview: true,
    assignAfterAutomaticReview: true,
    automaticOwnPrRepair: false,
    credentialMode: "gh-login",
    enabledActions: [],
  });
  assert.deepEqual(config.githubRead, {
    enabled: false,
    issueActiveWindowDays: 14,
  });
  assert.equal(config.memory.enabled, false);
  assert.deepEqual(config.memory.imports, {
    localSessions: false,
    git: false,
  });
  const absolutePaths = Object.values(config.codeExecutor).filter(
    (value) =>
      typeof value === "string" &&
      (path.isAbsolute(value) ||
        path.posix.isAbsolute(value) ||
        path.win32.isAbsolute(value)),
  );
  assert.deepEqual(absolutePaths, []);
  assert.equal(JSON.stringify(config.githubActions).toLowerCase().includes("token"), false);
});

test("published safe configuration predefines only paused generic roles", async () => {
  const configPath = path.resolve(testDirectory, "../config.example.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.deepEqual(Object.keys(config.employees.roles), [
    "pr-engineer",
    "orchestrator",
    "requirements-analyst",
    "developer",
    "tester",
  ]);
  assert.equal(
    Object.values(config.employees.roles).every(
      ({ initialPaused }) => initialPaused === true,
    ),
    true,
  );
  assert.deepEqual(config.trackedRepositories, []);
  assert.equal(config.workflowRouting.enabled, false);
  assert.equal(
    config.workflowRouting.rules.find(
      ({ id }) => id === "local-owner-triage",
    ).targets[0].id,
    "local-user",
  );
  assert.deepEqual(config.workCoordination.policy.capabilityRoles, {
    coordination: "orchestrator",
    requirements: "requirements-analyst",
    "pr-review": "pr-engineer",
    development: "developer",
    testing: "tester",
  });
});
