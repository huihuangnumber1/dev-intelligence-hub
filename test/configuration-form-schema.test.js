import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIGURATION_FORM_SCHEMA,
  configurationCollectionDescriptor,
  configurationFieldDescriptor,
  configurationSlotDescriptor,
  configurationStructureTemplate,
} from "../public/configuration-form-schema.js";
import { normalizeConfigurationDocument } from "../src/domain/configuration-contract.js";

const configurationText = await readFile(
  new URL("../config.example.json", import.meta.url),
  "utf8",
);

function extendedConfiguration() {
  const configuration = JSON.parse(configurationText);
  configuration.codeExecutor = {
    enabled: false,
    gitCommand: "C:/Program Files/Git/mingw64/bin/git.exe",
    gitTimeoutMs: 30_000,
    docker: {
      executable: "docker",
      host: "npipe:////./pipe/docker_engine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "C:/workspace/dashboard",
        gitHeadSnapshot: true,
        writablePaths: ["public"],
        excludePaths: ["node_modules"],
      },
    ],
    profiles: {
      "node-contract": {
        kind: "node-test",
        image: `node:22-alpine@sha256:${"0".repeat(64)}`,
        timeoutMs: 120_000,
      },
    },
    requiredProfilesByWorkspace: {
      dashboard: ["node-contract"],
    },
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: {
        "acme/command-center": "D:/mirrors/oct-base.git",
      },
      headMirrorsByRepository: {
        "acme/command-center": "D:/mirrors/oct-head.git",
      },
    },
  };
  configuration.githubActions.networkEnv = {
    HTTPS_PROXY: "http://127.0.0.1:7890",
  };
  configuration.workCoordination.policy.workspaceByRepository = {
    "acme/command-center": "dashboard",
  };
  return normalizeConfigurationDocument(configuration);
}

function visit(value, path, visitor) {
  visitor(value, path);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, [...path, index], visitor));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    visit(entry, [...path, key], visitor);
  }
}

test("declarative schema describes every primitive field in a normalized configuration", () => {
  const configuration = extendedConfiguration();
  const primitives = [];
  visit(configuration, [], (value, path) => {
    if (value === null || typeof value !== "object") primitives.push([value, path]);
  });

  for (const [value, path] of primitives) {
    const descriptor = configurationFieldDescriptor(path, value);
    assert.ok(descriptor, `missing field descriptor for ${path.join(".")}`);
    assert.match(descriptor.label, /\S/);
    assert.ok(
      ["text", "number", "checkbox", "select", "env-reference", "scalar"].includes(
        descriptor.control,
      ),
      `unsupported control for ${path.join(".")}`,
    );
  }
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.groups), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.fields), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.collections), true);
});

test("every supported array and mapping exposes add, remove, replace and a safe template", () => {
  const configuration = extendedConfiguration();
  const collectionPaths = [];
  visit(configuration, [], (value, path) => {
    if (Array.isArray(value)) collectionPaths.push([path, value]);
  });
  for (const path of [
    ["brainProviders"],
    ["employees", "roles"],
    ["codeExecutor", "profiles"],
    ["codeExecutor", "requiredProfilesByWorkspace"],
    ["codeExecutor", "conflictPreparation", "baseMirrorsByRepository"],
    ["codeExecutor", "conflictPreparation", "headMirrorsByRepository"],
    ["githubActions", "networkEnv"],
    ["workCoordination", "policy", "capabilityRoles"],
    ["workCoordination", "policy", "codeOperationsByRole"],
    ["workCoordination", "policy", "workspaceByRepository"],
  ]) {
    let value = configuration;
    for (const segment of path) value = value[segment];
    collectionPaths.push([path, value]);
  }

  for (const [path, value] of collectionPaths) {
    const descriptor = configurationCollectionDescriptor(path, value);
    assert.ok(descriptor, `missing collection descriptor for ${path.join(".")}`);
    assert.deepEqual(descriptor.operations, ["add", "remove", "replace"]);
    const template = configurationStructureTemplate(path);
    assert.equal(template.kind, Array.isArray(value) ? "array" : "map");
    assert.equal(typeof template.value === "string" && /^[\[{]/.test(template.value), false);
  }
});

test("conflict preparation exposes an optional structured form instead of raw JSON", () => {
  const slot = configurationSlotDescriptor([
    "codeExecutor",
    "conflictPreparation",
  ]);
  assert.equal(slot.optional, true);
  assert.deepEqual(slot.operations, ["add", "remove", "replace"]);
  assert.deepEqual(
    configurationStructureTemplate([
      "codeExecutor",
      "conflictPreparation",
    ]).value,
    { enabled: false },
  );

  for (const name of [
    "baseMirrorsByRepository",
    "headMirrorsByRepository",
  ]) {
    const path = ["codeExecutor", "conflictPreparation", name];
    const descriptor = configurationCollectionDescriptor(path, {});
    assert.equal(descriptor.kind, "map");
    assert.equal(descriptor.keyFormat, "controlled-git-repository");
    assert.equal(descriptor.minimum, 1);
    assert.equal(descriptor.maximum, 1_000);
    assert.deepEqual(configurationStructureTemplate(path), {
      kind: "map",
      key: "owner/repository",
      value: "C:/path/to/repository.git",
    });
    const mirror = configurationFieldDescriptor(
      [...path, "acme/command-center"],
      "D:/mirrors/oct.git",
    );
    assert.equal(mirror.control, "text");
    assert.equal(mirror.format, "absolute-local-path");
  }
});

test("Issue automatic processing window is adjustable in the structured form", () => {
  const path = ["githubRead", "issueActiveWindowDays"];
  const slot = configurationSlotDescriptor(path);
  assert.equal(slot.optional, true);
  assert.deepEqual(slot.operations, ["add", "remove", "replace"]);
  assert.deepEqual(configurationStructureTemplate(path), {
    kind: "slot",
    value: 14,
  });
  assert.deepEqual(
    {
      label: configurationFieldDescriptor(path, 14).label,
      control: configurationFieldDescriptor(path, 14).control,
      kind: configurationFieldDescriptor(path, 14).kind,
      minimum: configurationFieldDescriptor(path, 14).minimum,
      maximum: configurationFieldDescriptor(path, 14).maximum,
    },
    {
      label: "Issue 自动处理最近天数",
      control: "number",
      kind: "integer",
      minimum: 1,
      maximum: 3_650,
    },
  );
});

test("schema identifies enum, numeric, boolean and environment-reference controls centrally", () => {
  const providerKind = configurationFieldDescriptor(
    ["brainProviders", "ollama", "kind"],
    "ollama",
  );
  assert.equal(providerKind.control, "text");
  assert.equal(providerKind.readOnly, true);
  assert.equal(Object.hasOwn(providerKind, "options"), false);
  assert.deepEqual(
    configurationFieldDescriptor(
      ["workflowRouting", "rules", 0, "targets", 0, "type"],
      "role",
    ).options,
    ["role", "person", "node"],
  );
  assert.equal(
    configurationFieldDescriptor(["githubActions", "tokenEnv"], "TOKEN_ENV")
      .control,
    "env-reference",
  );
  assert.equal(configurationFieldDescriptor(["port"], 4173).minimum, 1);
  assert.equal(configurationFieldDescriptor(["port"], 4173).maximum, 65_535);
  const providerTimeout = configurationFieldDescriptor(
    ["brainProviders", "legacy", "timeoutMs"],
    180_000,
  );
  assert.equal(providerTimeout.minimum, 1);
  assert.equal(providerTimeout.maximum, 3_600_000);
  const providerResponseLimit = configurationFieldDescriptor(
    ["brainProviders", "legacy", "maxResponseBytes"],
    2 * 1024 * 1024,
  );
  assert.equal(providerResponseLimit.minimum, 1);
  assert.equal(providerResponseLimit.maximum, 2 * 1024 * 1024);
  assert.equal(
    configurationFieldDescriptor(["memory", "enabled"], true).control,
    "checkbox",
  );
  const gitCommand = configurationFieldDescriptor(
    ["codeExecutor", "gitCommand"],
    "C:/Program Files/Git/mingw64/bin/git.exe",
  );
  assert.equal(gitCommand.control, "text");
  assert.equal(gitCommand.kind, "text");
  assert.equal(gitCommand.maximumBytes, 4_096);
  const gitTimeout = configurationFieldDescriptor(
    ["codeExecutor", "gitTimeoutMs"],
    30_000,
  );
  assert.equal(gitTimeout.control, "number");
  assert.equal(gitTimeout.kind, "integer");
  assert.equal(gitTimeout.minimum, 1);
  assert.equal(gitTimeout.maximum, 60_000);
  const gitHeadSnapshot = configurationFieldDescriptor(
    ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
    true,
  );
  assert.equal(gitHeadSnapshot.control, "checkbox");
  assert.equal(gitHeadSnapshot.kind, "boolean");
});

test("GitHub PR external actions use an optional structured allow-list", () => {
  const path = ["githubActions", "enabledActions"];
  const collection = configurationCollectionDescriptor(path);
  assert.equal(collection.kind, "array");
  assert.equal(collection.optional, true);
  assert.equal(collection.maximum, 5);
  assert.equal(collection.uniqueBy, "value");
  assert.deepEqual(collection.operations, ["add", "remove", "replace"]);
  assert.deepEqual(configurationStructureTemplate(path), {
    kind: "array",
    value: "review",
  });
  assert.deepEqual(
    configurationFieldDescriptor([...path, 0], "review").options,
    ["comment", "review", "update_branch", "push", "merge"],
  );
});

test("PR discovery window exposes explicit rolling and fixed structured choices", () => {
  const path = ["githubRead", "pullRequestUpdatedWindow"];
  const slot = configurationSlotDescriptor(path);
  assert.equal(slot.optional, true);
  assert.deepEqual(slot.operations, ["add", "remove", "replace"]);
  assert.deepEqual(configurationStructureTemplate(path), {
    kind: "slot",
    value: { mode: "rolling", days: 7 },
  });
  assert.deepEqual(
    configurationFieldDescriptor([...path, "mode"], "rolling").options,
    ["rolling", "fixed"],
  );
  const days = configurationFieldDescriptor([...path, "days"], 7);
  assert.equal(days.minimum, 1);
  assert.equal(days.maximum, 3_650);
});

test("GitHub credential mode exposes the approved selector and shared timeout range", () => {
  const descriptor = configurationFieldDescriptor(
    ["githubActions", "credentialMode"],
    "gh-login",
  );
  assert.equal(descriptor.control, "select");
  assert.deepEqual(descriptor.options, ["gh-login", "token-env"]);
  assert.deepEqual(descriptor.optionLabels, {
    "gh-login": "GitHub CLI 当前登录（推荐）",
    "token-env": "环境变量 Token（兼容）",
  });
  assert.deepEqual(
    configurationStructureTemplate(["githubActions", "credentialMode"]),
    { kind: "slot", value: "gh-login" },
  );
  const timeout = configurationFieldDescriptor(
    ["githubActions", "timeoutMs"],
    60_000,
  );
  assert.equal(timeout.minimum, 1_000);
  assert.equal(timeout.maximum, 600_000);
});

test("Git Head snapshot fields expose safe scalar templates for old configurations", () => {
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "gitCommand"]),
    {
      kind: "slot",
      value: "C:/Program Files/Git/mingw64/bin/git.exe",
    },
  );
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "gitTimeoutMs"]),
    { kind: "slot", value: 30_000 },
  );
  assert.deepEqual(
    configurationStructureTemplate([
      "codeExecutor",
      "workspaces",
      0,
      "gitHeadSnapshot",
    ]),
    { kind: "slot", value: true },
  );
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "workspaces"]).value,
    {
      id: "workspace-id",
      sourceRoot: ".",
      gitHeadSnapshot: false,
      writablePaths: [],
      excludePaths: [],
    },
  );
});

test("test library profiles expose a dedicated script template and source editor", () => {
  const template = configurationStructureTemplate(
    ["codeExecutor", "profiles"],
    "node-script",
  );
  assert.equal(template.value.kind, "node-script");
  assert.equal(template.value.asset.schemaVersion, 1);
  assert.equal(template.value.asset.version, 1);
  assert.match(template.value.asset.source, /throw new Error/u);
  assert.match(template.value.asset.source, /before activation/u);

  const kind = configurationFieldDescriptor(
    ["codeExecutor", "profiles", "reusable-smoke", "kind"],
    "node-script",
  );
  assert.deepEqual(kind.options, ["node-test", "node-script", "windows-test", "windows-build"]);
  const source = configurationFieldDescriptor(
    [
      "codeExecutor",
      "profiles",
      "reusable-smoke",
      "asset",
      "source",
    ],
    "console.log('ok');",
  );
  assert.equal(source.control, "textarea");
  assert.equal(source.maximumBytes, 65_536);
});

test("Windows fixed resources expose a bounded optional collection and editable fields", () => {
  const path = ["codeExecutor", "profiles", "native", "resources"];
  const collection = configurationCollectionDescriptor(path);
  assert.equal(collection.kind, "array");
  assert.equal(collection.optional, true);
  assert.equal(collection.maximum, 16);
  assert.equal(collection.uniqueBy, "name");
  const template = configurationStructureTemplate(path);
  assert.deepEqual(template.value, { name: "resource", sourcePath: "C:/path/to/resource", sha256: "0".repeat(64), kind: "file" });
  for (const [field, format, maximumBytes] of [["name", "resource-name", 64], ["sourcePath", "windows-absolute-path", 4096], ["sha256", "sha256", 64]]) {
    const descriptor = configurationFieldDescriptor([...path, 0, field], template.value[field]);
    assert.equal(descriptor.format, format);
    assert.equal(descriptor.maximumBytes, maximumBytes);
    assert.notEqual(descriptor.readOnly, true);
  }
  assert.deepEqual(configurationFieldDescriptor([...path, 0, "kind"], "file").options, ["file", "directory"]);
  for (const kind of ["windows-test", "windows-build", "node-script"]) {
    assert.equal(Object.hasOwn(configurationStructureTemplate(["codeExecutor", "profiles"], kind).value, "resources"), false);
  }
});

test("own PR repair exposes a disabled checkbox template and scoped help", () => {
  const path = ["githubActions", "automaticOwnPrRepair"];
  const field = configurationFieldDescriptor(path, false);
  assert.equal(field.label, "自动修复我的 PR");
  assert.equal(field.control, "checkbox");
  assert.equal(field.kind, "boolean");
  assert.match(field.help, /开发工程师/u);
  assert.match(field.help, /无需逐项确认/u);
  assert.match(field.help, /原 PR/u);
  assert.match(field.help, /合并/u);
  assert.deepEqual(configurationSlotDescriptor(path).operations, ["add", "remove", "replace"]);
  assert.deepEqual(configurationStructureTemplate(path), { kind: "slot", value: false });
});

test("profile form fields use the sandbox ID boundary", () => {
  const profiles = configurationCollectionDescriptor(["codeExecutor", "profiles"]);
  assert.equal(profiles.keyFormat, "profile-id");
  const binding = configurationFieldDescriptor(
    ["codeExecutor", "requiredProfilesByWorkspace", "dashboard", 0],
    "node-contract",
  );
  assert.equal(binding.format, "profile-id");
  assert.equal(binding.maximumBytes, 64);
});

test("router-backed brain references declare a dynamic provider option source", () => {
  for (const path of [
    ["employees", "roles", "developer", "brain", "provider"],
    ["employees", "roles", "developer", "taskBrain", "provider"],
    ["memory", "answering", "brain", "provider"],
    ["memory", "answering", "localBrain", "provider"],
  ]) {
    const descriptor = configurationFieldDescriptor(path, "remote.openai");
    assert.equal(descriptor.control, "select", path.join("."));
    assert.equal(descriptor.optionsFrom, "brainProviders", path.join("."));
    assert.equal(Object.hasOwn(descriptor, "options"), false, path.join("."));
    assert.equal(descriptor.format, "safe-id", path.join("."));
  }
  for (const path of [
    ["brain", "provider"],
    ["employees", "prReviewer", "brain", "provider"],
  ]) {
    const descriptor = configurationFieldDescriptor(path, "ollama");
    assert.deepEqual(descriptor.options, ["ollama"], path.join("."));
    assert.equal(Object.hasOwn(descriptor, "optionsFrom"), false, path.join("."));
  }
});

test("task brains expose an optional assigned-brain form", () => {
  const path = ["employees", "roles", "developer", "taskBrain"];
  const slot = configurationSlotDescriptor(path);
  assert.equal(slot.optional, true);
  assert.deepEqual(slot.operations, ["add", "remove", "replace"]);
  assert.deepEqual(configurationStructureTemplate(path).value, {
    provider: "ollama",
    model: "qwen3.5:9b",
    remoteData: { requirements: false, code: false, memory: false },
  });
  assert.equal(
    configurationFieldDescriptor([...path, "provider"], "ollama").optionsFrom,
    "brainProviders",
  );
  const model = configurationFieldDescriptor([...path, "model"], "qwen3.5:9b");
  assert.equal(model.control, "text");
  assert.equal(model.maximumBytes, 256);
  assert.equal(
    configurationFieldDescriptor([...path, "remoteData", "code"], false)
      .control,
    "checkbox",
  );
});

test("new provider template is a complete openai-compatible provider", () => {
  const template = configurationStructureTemplate(["brainProviders"]).value;
  assert.equal(template.kind, "openai-compatible");
  assert.equal(template.apiKeyEnv, "MYDASHBOARD_MODEL_API_KEY");
  assert.equal(template.protocol, "chat-completions");
  assert.equal(template.responseFormat, "json-schema");
  assert.equal(template.remote, true);
  assert.equal(Object.hasOwn(template, "contextTokens"), false);
});

test("provider variants expose complete Responses and Ollama forms without stale fields", () => {
  assert.equal(
    configurationFieldDescriptor(["brainProviders", "codex", "kind"], "openai-compatible")
      .readOnly,
    true,
  );
  const responses = configurationStructureTemplate(
    ["brainProviders"],
    "openai-responses",
  );
  assert.equal(responses.key, "codex-api");
  assert.deepEqual(responses.value, {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  });
  assert.equal(Object.hasOwn(responses.value, "contextTokens"), false);
  assert.deepEqual(
    configurationFieldDescriptor(
      ["brainProviders", "codex", "protocol"],
      "responses",
    ).options,
    ["chat-completions", "responses"],
  );
  const responseFormat = configurationFieldDescriptor(
    ["brainProviders", "codex", "responseFormat"],
    "json-schema",
  );
  assert.equal(responseFormat.label, "结构化输出模式");
  assert.equal(responseFormat.control, "select");
  assert.deepEqual(responseFormat.options, ["json-schema", "json-object"]);

  const ollama = configurationStructureTemplate(["brainProviders"], "ollama");
  assert.equal(ollama.value.kind, "ollama");
  assert.equal(ollama.value.baseUrl, "http://127.0.0.1:11434");
  assert.equal(Object.hasOwn(ollama.value, "executable"), false);
  assert.throws(
    () => configurationStructureTemplate(["brainProviders"], "missing"),
    /variant is unavailable/i,
  );
});

test("provider variants expose fixed supervised Codex and Claude CLI forms", () => {
  const collection = configurationCollectionDescriptor(["brainProviders"], {});
  const variants = new Map(
    collection.additionalTemplates.map(({ id, label }) => [id, label]),
  );
  assert.equal(variants.get("codex-cli"), "Codex CLI（单任务受监管）");
  assert.equal(variants.get("claude-cli"), "Claude CLI（单任务受监管）");

  for (const [kind, credentialMode] of [
    ["codex-cli", "codex-login"],
    ["claude-cli", "api-key"],
  ]) {
    const template = configurationStructureTemplate(["brainProviders"], kind);
    assert.equal(template.key, kind);
    assert.deepEqual(template.value, {
      kind,
      credentialMode,
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    });
    for (const field of [
      "baseUrl",
      "apiKeyEnv",
      "protocol",
      "responseFormat",
      "contextTokens",
      "executable",
      "args",
    ]) {
      assert.equal(Object.hasOwn(template.value, field), false, `${kind}.${field}`);
    }
  }

  const descriptor = configurationFieldDescriptor(
    ["brainProviders", "codex-cli", "credentialMode"],
    "codex-login",
    { providerKind: "codex-cli" },
  );
  assert.deepEqual(descriptor.options, ["codex-login", "codex-native-login", "api-key"]);
  assert.equal(descriptor.optionLabels["codex-login"], "Codex 受管登录（兼容）");
  assert.equal(descriptor.optionLabels["codex-native-login"], "Codex 原生登录（会话由 CLI 保存）");
  assert.equal(descriptor.optionLabels["api-key"], "环境变量 API Key");
  assert.match(descriptor.help, /CODEX_HOME/);
  assert.match(descriptor.help, /不自动切换/);

  const claudeDescriptor = configurationFieldDescriptor(
    ["brainProviders", "claude-cli", "credentialMode"],
    "api-key",
    { providerKind: "claude-cli" },
  );
  assert.deepEqual(claudeDescriptor.options, ["api-key"]);

  const legacySlot = configurationSlotDescriptor(
    ["brainProviders", "legacy-cli", "credentialMode"],
    { providerKind: "codex-cli" },
  );
  assert.equal(legacySlot.optional, true);
  assert.equal(legacySlot.template, "provider-credential-mode");
  assert.equal(
    configurationSlotDescriptor(
      ["brainProviders", "remote", "credentialMode"],
      { providerKind: "openai-compatible" },
    ),
    null,
  );
});

test("CLI provider field descriptors expose their exact bounded ranges", () => {
  for (const providerKind of ["codex-cli", "claude-cli"]) {
    const context = { providerKind };
    assert.deepEqual(
      {
        minimum: configurationFieldDescriptor(
          ["brainProviders", "employee-cli", "timeoutMs"],
          300_000,
          context,
        ).minimum,
        maximum: configurationFieldDescriptor(
          ["brainProviders", "employee-cli", "timeoutMs"],
          300_000,
          context,
        ).maximum,
      },
      { minimum: 1_000, maximum: 3_600_000 },
    );
    for (const field of ["maxResponseBytes", "maxRequestBytes"]) {
      const descriptor = configurationFieldDescriptor(
        ["brainProviders", "employee-cli", field],
        131_072,
        context,
      );
      assert.equal(descriptor.minimum, 1_024, `${providerKind}.${field}`);
      assert.equal(descriptor.maximum, 1_048_576, `${providerKind}.${field}`);
    }
  }

  const legacy = configurationFieldDescriptor(
    ["brainProviders", "legacy", "maxResponseBytes"],
    2 * 1024 * 1024,
    { providerKind: "openai-compatible" },
  );
  assert.equal(legacy.minimum, 1);
  assert.equal(legacy.maximum, 2 * 1024 * 1024);
});

test("schema public path boundary rejects accessors, prototypes and oversized paths", () => {
  let getterCalled = false;
  const path = [];
  Object.defineProperty(path, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "port";
    },
  });
  path.length = 1;
  assert.throws(() => configurationFieldDescriptor(path, 4173), /data|dense/i);
  assert.equal(getterCalled, false);
  assert.throws(
    () => configurationFieldDescriptor(Object.assign(Object.create(null), { 0: "port", length: 1 }), 4173),
    /array/i,
  );
  assert.throws(
    () => configurationFieldDescriptor(Array.from({ length: 33 }, () => "x"), "x"),
    /path|limit/i,
  );

  let collectionGetterCalled = false;
  const collection = {};
  Object.defineProperty(collection, "unsafe", {
    enumerable: true,
    get() {
      collectionGetterCalled = true;
      return {};
    },
  });
  assert.throws(
    () => configurationCollectionDescriptor(["brainProviders"], collection),
    /data properties/i,
  );
  assert.equal(collectionGetterCalled, false);
});
