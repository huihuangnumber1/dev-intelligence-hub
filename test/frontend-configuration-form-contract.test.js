import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyConfigurationStructureOperation,
  CONFIGURATION_FORM_GROUPS,
  configurationDocumentFromForm,
  createConfigurationFormState,
  setConfigurationFormField,
} from "../public/configuration-form-support.js";
import { renderConfigurationSettingsSkeleton } from "../public/settings-view.js";

const [supportSource, settingsSource, currentConfigurationText] = await Promise.all([
  readFile(new URL("../public/configuration-form-support.js", import.meta.url), "utf8"),
  readFile(new URL("../public/settings-view.js", import.meta.url), "utf8"),
  readFile(new URL("../config.example.json", import.meta.url), "utf8"),
]);

function configurationWithCredentialReferences() {
  const configuration = JSON.parse(currentConfigurationText);
  configuration.brainProviders["remote.openai"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example.invalid/v1",
    apiKeyEnv: "MYDASHBOARD_OPENAI_API_KEY",
    remote: true,
  };
  delete configuration.githubActions.credentialMode;
  configuration.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN";
  return configuration;
}

function configurationWithLegacyCodeWorkspace() {
  const configuration = configurationWithCredentialReferences();
  configuration.codeExecutor.workspaces = [
    {
      id: "dashboard",
      sourceRoot: "C:/workspace/dashboard",
      writablePaths: ["src", "public", "test"],
      excludePaths: [".git", "node_modules"],
    },
  ];
  return configuration;
}

function configurationWithResponsesProvider() {
  const configuration = configurationWithCredentialReferences();
  configuration.brainProviders.codex = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  return configuration;
}

function configurationWithCliProvider() {
  const configuration = configurationWithCredentialReferences();
  configuration.brainProviders["employee-cli"] = {
    kind: "codex-cli",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  return configuration;
}

function configurationWithScalarConditions() {
  const configuration = configurationWithCredentialReferences();
  configuration.workflowRouting.rules[0].fallback = false;
  configuration.workflowRouting.rules[0].condition = {
    op: "oneOf",
    path: "payload.value",
    values: [null, "plain text", 1.5, true],
  };
  return configuration;
}

function configurationWithRemoteBrains() {
  const configuration = configurationWithCredentialReferences();
  configuration.employees.prReviewer.brain = {
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434",
  };
  configuration.employees.roles.developer.brain.provider = "remote.openai";
  configuration.employees.roles.developer.brain.model = "gpt-5-mini";
  configuration.memory.answering.brain = structuredClone(
    configuration.employees.roles.developer.brain,
  );
  configuration.memory.answering.localBrain = structuredClone(
    configuration.employees.roles.developer.brain,
  );
  configuration.memory.answering.brain.provider = "remote.openai";
  configuration.memory.answering.brain.model = "gpt-5-mini";
  configuration.memory.answering.localBrain.provider = "remote.openai";
  configuration.memory.answering.localBrain.model = "gpt-5-mini";
  return configuration;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function machinePaths(markup, attribute) {
  const pattern = new RegExp(`${attribute}="([^"]*)"`, "g");
  return [...markup.matchAll(pattern)].map((match) =>
    JSON.parse(decodeHtmlAttribute(match[1])),
  );
}

test("Windows profile resources can be added when absent and edited as structured fields", () => {
  const configuration = configurationWithCredentialReferences();
  configuration.codeExecutor = {
    enabled: true,
    workspaces: [{ id: "dashboard", sourceRoot: "D:/workspace" }],
    requiredProfilesByWorkspace: { dashboard: ["native"] },
    profiles: { native: {
      kind: "windows-test", nodeExecutable: "C:/Program Files/nodejs/node.exe", nodeSha256: "a".repeat(64), timeoutMs: 30_000,
      asset: { schemaVersion: 1, title: "Native checks", description: "Native assertions", version: 1, source: "console.log('ok');" },
    } },
  };
  const initial = createConfigurationFormState(configuration);
  const markup = renderConfigurationSettingsSkeleton({ state: initial });
  const path = ["codeExecutor", "profiles", "native", "resources"];
  assert.equal(machinePaths(markup, "data-configuration-collection").some((value) => JSON.stringify(value) === JSON.stringify(path)), true);
  assert.match(markup, /新增固定资源/u);
  assert.equal(Object.hasOwn(configurationDocumentFromForm(initial).configuration.codeExecutor.profiles.native, "resources"), false);
  const state = applyConfigurationStructureOperation(initial, {
    operation: "add", path, value: { name: "fixture", sourcePath: "D:/fixtures", sha256: "c".repeat(64), kind: "directory" },
  });
  const edited = renderConfigurationSettingsSkeleton({ state });
  for (const field of ["name", "sourcePath", "sha256", "kind"]) controlForPath(edited, [...path, 0, field]);
  assert.match(selectForPath(edited, [...path, 0, "kind"]), /<option value="directory" selected>/u);
  assert.equal(configurationDocumentFromForm(state).ok, true);

  const containerConfiguration = configurationWithCredentialReferences();
  containerConfiguration.codeExecutor.profiles = { container: { kind: "node-script", image: `node@sha256:${"e".repeat(64)}`, timeoutMs: 30_000, asset: configuration.codeExecutor.profiles.native.asset } };
  containerConfiguration.codeExecutor.enabled = false;
  delete containerConfiguration.codeExecutor.requiredProfilesByWorkspace;
  const containerMarkup = renderConfigurationSettingsSkeleton({ state: createConfigurationFormState(containerConfiguration) });
  assert.equal(machinePaths(containerMarkup, "data-configuration-collection").some((value) => value.at(-1) === "resources"), false);
});

test("own PR repair checkbox renders its scope with accessible help", () => {
  const configuration = configurationWithCredentialReferences();
  configuration.githubActions.automaticOwnPrRepair = false;
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configuration),
  });
  assert.match(markup, /自动修复我的 PR/u);
  const ownRepairControl = [...markup.matchAll(/<input[^>]+>/g)]
    .map(([control]) => control)
    .find((control) => control.includes("data-configuration-field=") && control.includes("automaticOwnPrRepair"));
  assert.ok(ownRepairControl);
  assert.match(ownRepairControl, /type="checkbox"/);
  assert.doesNotMatch(ownRepairControl, / checked/);
  const helpId = ownRepairControl.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(helpId);
  assert.match(markup, new RegExp(`id="${helpId}"[^>]*>[^<]*无需逐项确认`));
});

function primitivePaths(value, path = [], result = []) {
  if (value === null || typeof value !== "object") {
    result.push(path);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => primitivePaths(entry, [...path, index], result));
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    primitivePaths(entry, [...path, key], result);
  }
  return result;
}

test("settings skeleton exposes every structured configuration group", () => {
  const state = createConfigurationFormState(configurationWithCredentialReferences());
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /<form[^>]+data-configuration-structured-form/);
  for (const group of CONFIGURATION_FORM_GROUPS) {
    assert.match(markup, new RegExp(`data-configuration-group="${group.id}"`));
    assert.match(markup, new RegExp(`<legend>${group.label}</legend>`));
  }
  assert.equal(
    (markup.match(/<fieldset/g) || []).length,
    CONFIGURATION_FORM_GROUPS.length,
  );
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_GROUPS), true);
  assert.equal(CONFIGURATION_FORM_GROUPS.every(Object.isFrozen), true);
});

test("settings skeleton is structured and never falls back to a whole-document JSON editor", () => {
  const state = createConfigurationFormState(configurationWithCredentialReferences());
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.doesNotMatch(
    markup,
    /<textarea[^>]+(?:id|name)=["']configuration-document["']/i,
  );
  assert.doesNotMatch(markup, /type=["']password/i);
  assert.doesNotMatch(settingsSource, /JSON\.stringify|JSON\.parse/);
  assert.doesNotMatch(supportSource, /eval\s*\(|new Function\s*\(/);
  const fields = machinePaths(markup, "data-configuration-field");
  const collections = machinePaths(markup, "data-configuration-collection");
  assert.deepEqual(fields.find((path) => path.length === 1 && path[0] === "port"), [
    "port",
  ]);
  for (const expected of [
    ["trackedRepositories"],
    ["employees", "roles"],
    ["workflowRouting", "rules"],
    ["codeExecutor", "workspaces"],
  ]) {
    assert.equal(
      collections.some((path) => JSON.stringify(path) === JSON.stringify(expected)),
      true,
      `missing encoded collection path ${expected.join(".")}`,
    );
  }
});

test("PR discovery window UI preserves unlimited mode and restores fixed local dates", () => {
  const legacy = configurationWithCredentialReferences();
  let markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(legacy),
  });
  assert.match(markup, /自动发现 PR 更新时间/);
  assert.match(markup, /不限时间（兼容模式）/);
  assert.match(markup, /value="7"[^>]+data-configuration-pr-window-days/);
  assert.match(markup, /最近 7 天（推荐）/);
  assert.match(markup, /data-configuration-pr-window-apply/);
  assert.equal(
    Object.hasOwn(legacy.githubRead, "pullRequestUpdatedWindow"),
    false,
  );

  const fixed = configurationWithCredentialReferences();
  fixed.githubRead.pullRequestUpdatedWindow = {
    mode: "fixed",
    fromInclusive: "2026-03-08T05:00:00.000Z",
    untilExclusive: "2026-03-10T04:00:00.000Z",
    timeZone: "America/New_York",
  };
  markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(fixed),
  });
  assert.match(markup, /value="20260308"[^>]+data-configuration-pr-window-from/);
  assert.match(markup, /value="20260309"[^>]+data-configuration-pr-window-through/);
  assert.match(markup, /value="America\/New_York"[^>]+data-configuration-pr-window-time-zone/);
  assert.match(
    markup,
    /2026-03-08T05:00:00\.000Z ≤ updatedAt &lt; 2026-03-10T04:00:00\.000Z/,
  );
  assert.match(markup, /首尾日期都包含/);
});

test("old code workspaces expose structured Git Head setup and native controls", () => {
  let state = createConfigurationFormState(configurationWithLegacyCodeWorkspace());
  let markup = renderConfigurationSettingsSkeleton({ state });
  const templatePaths = machinePaths(markup, "data-configuration-template-field");
  for (const expected of [
    ["codeExecutor", "gitCommand"],
    ["codeExecutor", "gitTimeoutMs"],
    ["codeExecutor", "workspaces", "0", "gitHeadSnapshot"],
  ]) {
    assert.equal(
      templatePaths.some(
        (path) => JSON.stringify(path) === JSON.stringify(expected),
      ),
      true,
      `missing structured add control for ${expected.join(".")}`,
    );
  }
  assert.doesNotMatch(
    markup,
    /<textarea[^>]+(?:id|name)=["']configuration-document["']/i,
  );

  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "gitCommand"],
    value: "C:/Program Files/Git/mingw64/bin/git.exe",
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "gitTimeoutMs"],
    value: 30_000,
  });
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
    value: true,
  });
  markup = renderConfigurationSettingsSkeleton({ state });

  const command = controlForPath(markup, ["codeExecutor", "gitCommand"]);
  assert.match(command, /type="text"/);
  assert.match(command, /data-configuration-edit-kind="text"/);
  const timeout = controlForPath(markup, ["codeExecutor", "gitTimeoutMs"]);
  assert.match(timeout, /type="number"/);
  assert.match(timeout, / min="1"/);
  assert.match(timeout, / max="60000"/);
  assert.match(timeout, / step="1"/);
  const snapshot = controlForPath(markup, [
    "codeExecutor",
    "workspaces",
    0,
    "gitHeadSnapshot",
  ]);
  assert.match(snapshot, /type="checkbox"/);
  assert.match(snapshot, / checked(?:\s|>)/);
  assert.doesNotMatch(
    markup,
    /<textarea[^>]+(?:id|name)=["']configuration-document["']/i,
  );
});

test("settings skeleton overlays valid edits and preserves invalid raw input", () => {
  let state = createConfigurationFormState(configurationWithCredentialReferences());
  state = setConfigurationFormField(state, {
    path: ["githubLogin"],
    kind: "text",
    rawValue: "local-owner-next",
  });
  state = setConfigurationFormField(state, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });

  const markup = renderConfigurationSettingsSkeleton({ state });
  assert.match(
    markup,
    /value="local-owner-next" data-configuration-field="\[&quot;githubLogin&quot;\]"/,
  );
  assert.match(
    markup,
    /value="" data-configuration-field="\[&quot;refreshMinutes&quot;\]"/,
  );
});

test("CLI provider controls and templates render exact process limits", () => {
  const configured = configurationWithCliProvider();
  configured.brainProviders["employee-cli"].credentialMode = "codex-login";
  const state = createConfigurationFormState(configured);
  const markup = renderConfigurationSettingsSkeleton({ state });

  const timeout = controlForPath(markup, [
    "brainProviders",
    "employee-cli",
    "timeoutMs",
  ]);
  assert.match(timeout, / min="1000"/);
  assert.match(timeout, / max="3600000"/);

  for (const field of ["maxResponseBytes", "maxRequestBytes"]) {
    const control = controlForPath(markup, [
      "brainProviders",
      "employee-cli",
      field,
    ]);
    assert.match(control, / min="1024"/, field);
    assert.match(control, / max="1048576"/, field);
  }

  const templateTimeout = templateControlForPath(markup, [
    "brainProviders",
    "codex-cli",
    "timeoutMs",
  ]);
  assert.match(templateTimeout, / min="1000"/);
  assert.match(templateTimeout, / max="3600000"/);

  assert.match(markup, /<option value="codex-login" selected>Codex 受管登录（兼容）<\/option>/);
  assert.match(markup, /<option value="codex-native-login">Codex 原生登录（会话由 CLI 保存）<\/option>/);
  assert.match(markup, /<option value="api-key">环境变量 API Key<\/option>/);
  assert.match(
    markup,
    /data-configuration-template-field="\[&quot;brainProviders&quot;,&quot;codex-cli&quot;,&quot;credentialMode&quot;\]" data-configuration-edit-kind="text"><option value="codex-login" selected>Codex 受管登录（兼容）<\/option><option value="codex-native-login">Codex 原生登录（会话由 CLI 保存）<\/option><option value="api-key">环境变量 API Key<\/option>/,
  );

  const native = configurationWithCliProvider();
  native.brainProviders["employee-cli"].credentialMode = "codex-native-login";
  const nativeMarkup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(native),
  });
  assert.match(nativeMarkup, /<option value="codex-native-login" selected>Codex 原生登录（会话由 CLI 保存）<\/option>/);
  assert.match(nativeMarkup, /CODEX_HOME/);

  const legacy = configurationWithCliProvider();
  legacy.brainProviders["employee-cli"].credentialMode = undefined;
  delete legacy.brainProviders["employee-cli"].credentialMode;
  const legacyMarkup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(legacy),
  });
  assert.match(legacyMarkup, /新增认证方式/);
  assert.doesNotMatch(
    legacyMarkup,
    /data-configuration-field="\[&quot;brainProviders&quot;,&quot;employee-cli&quot;,&quot;credentialMode&quot;\]"/,
  );
});

test("credential controls render only environment variable names and explain the boundary", () => {
  const configuration = configurationWithCredentialReferences();
  const state = createConfigurationFormState(configuration);
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /MYDASHBOARD_OPENAI_API_KEY/);
  assert.match(markup, /MYDASHBOARD_GITHUB_TOKEN/);
  assert.match(markup, /只填写环境变量名，不填写密钥值/);
  assert.match(markup, /autocomplete="off"/);
  assert.match(markup, /data-configuration-value-kind="env-reference"/);
  assert.doesNotMatch(markup, /process\.env/);

  const providerPath = machinePaths(markup, "data-configuration-field").find(
    (path) => path[0] === "brainProviders" && path.at(-1) === "apiKeyEnv",
  );
  assert.deepEqual(providerPath, ["brainProviders", "remote.openai", "apiKeyEnv"]);
  assert.notDeepEqual(providerPath, [
    "brainProviders",
    "remote",
    "openai",
    "apiKeyEnv",
  ]);
});

test("GitHub credential mode conditionally removes the Token environment field", () => {
  const configuration = configurationWithCredentialReferences();
  configuration.githubActions.enabled = true;
  configuration.githubActions.actorAccountId = "runtime-user";
  configuration.githubActions.ghCommand = process.execPath;
  let state = createConfigurationFormState(configuration);
  state = applyConfigurationStructureOperation(state, {
    operation: "add",
    path: ["githubActions", "credentialMode"],
    value: "gh-login",
  });

  const markup = renderConfigurationSettingsSkeleton({ state });
  assert.match(markup, /GitHub CLI 当前登录（推荐）/);
  assert.match(markup, /环境变量 Token（兼容）/);
  assert.doesNotMatch(markup, /GitHub Token 环境变量/);
});

test("all interpolated configuration values are HTML escaped", () => {
  const configuration = configurationWithCredentialReferences();
  configuration.employees.roles.developer.mission = '<img src=x onerror="alert(1)">';
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configuration),
  });

  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("settings renderer does not invoke an accessor supplied at its public boundary", () => {
  let getterCalled = false;
  const options = {};
  Object.defineProperty(options, "state", {
    enumerable: true,
    get() {
      getterCalled = true;
      return createConfigurationFormState(configurationWithCredentialReferences());
    },
  });

  assert.throws(() => renderConfigurationSettingsSkeleton(options), /data property/i);
  assert.equal(getterCalled, false);
});

test("settings renderer exposes a native control for every primitive without count skeletons", () => {
  const configuration = configurationWithCredentialReferences();
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configuration),
  });
  const fields = machinePaths(markup, "data-configuration-field");
  const keys = new Set(fields.map((path) => JSON.stringify(path)));

  for (const path of primitivePaths(configuration)) {
    assert.equal(
      keys.has(JSON.stringify(path.map((segment) => `${segment}`))),
      true,
      `missing ${path.join(".")}`,
    );
  }
  assert.match(markup, /<input[^>]+type="text"/);
  assert.match(markup, /<input[^>]+type="number"/);
  assert.match(markup, /<input[^>]+type="checkbox"/);
  assert.match(markup, /<select[^>]+data-configuration-field/);
  assert.match(markup, /data-configuration-value-kind="env-reference"/);
  assert.doesNotMatch(markup, />\d+ 项</);
  assert.match(markup, /data-configuration-node=/);
});

test("every rendered collection has named add, remove and replace controls", () => {
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configurationWithCredentialReferences()),
  });
  const collections = machinePaths(markup, "data-configuration-collection");
  assert.ok(collections.length > 0);
  for (const path of collections) {
    const encoded = escapeRegExp(configurationFormPathAttribute(path));
    assert.match(markup, new RegExp(`data-configuration-operation="add"[^>]*data-configuration-path="${encoded}"|data-configuration-path="${encoded}"[^>]*data-configuration-operation="add"`));
  }
  assert.match(markup, /<button[^>]+data-configuration-operation="remove"[^>]*>\s*删除/);
  assert.match(markup, /<button[^>]+data-configuration-operation="replace"[^>]*>\s*替换/);
  assert.match(markup, /data-configuration-template-value-root=/);
  assert.match(markup, /data-configuration-replace-template(?:[ >])/);
  assert.doesNotMatch(markup, /aria-label=""/);
});

test("provider creation offers a complete Responses form instead of raw JSON", () => {
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configurationWithCredentialReferences()),
  });
  const responsesTemplate = markup.match(
    /<details[^>]+data-configuration-template-variant="openai-responses"[\s\S]*?<\/details>/,
  )?.[0];

  assert.ok(responsesTemplate);
  assert.match(responsesTemplate, /<summary>新增Responses \/ Codex API 大脑<\/summary>/);
  assert.match(responsesTemplate, /value="codex-api" data-configuration-template-key/);
  for (const field of [
    "kind",
    "baseUrl",
    "apiKeyEnv",
    "protocol",
    "responseFormat",
    "remote",
    "timeoutMs",
    "maxResponseBytes",
    "maxRequestBytes",
  ]) {
    assert.match(
      responsesTemplate,
      new RegExp(`data-configuration-template-field="[^\"]*${field}[^\"]*"`),
      field,
    );
  }
  assert.doesNotMatch(responsesTemplate, /contextTokens/);
  assert.match(responsesTemplate, /data-configuration-template-variant="openai-responses"/);
  const kindControl = templateControlForPath(responsesTemplate, [
    "brainProviders",
    "codex-api",
    "kind",
  ]);
  assert.match(kindControl, / readonly(?:\s|>)/);
  assert.match(kindControl, / aria-readonly="true"/);
  assert.match(responsesTemplate, /<option value="responses" selected>/);
  assert.match(responsesTemplate, /<option value="json-schema" selected>/);
});

test("invalid fields expose inline accessible errors while submit and status remain available", () => {
  let state = createConfigurationFormState(configurationWithCredentialReferences());
  state = setConfigurationFormField(state, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /aria-describedby="configuration-error-/);
  assert.match(markup, /data-configuration-first-invalid/);
  assert.match(markup, /role="status"[^>]+aria-live="polite"/);
  assert.match(markup, /<button type="submit"(?![^>]*disabled)/);
  assert.match(markup, /请输入整数/);
});

test("existing provider identity controls are readonly in markup and form edits", () => {
  const state = createConfigurationFormState(configurationWithResponsesProvider());
  const markup = renderConfigurationSettingsSkeleton({ state });
  const readonlyPaths = [
    ["brainProviders", "ollama", "kind"],
    ["brainProviders", "codex", "kind"],
  ];

  for (const path of readonlyPaths) {
    const control = controlForPath(markup, path);
    assert.match(control, / readonly(?:\s|>)/, path.join("."));
    assert.match(control, / aria-readonly="true"/, path.join("."));
    assert.throws(
      () =>
        setConfigurationFormField(state, {
          path,
          kind: "text",
          rawValue: "attempted-change",
        }),
      (error) => {
        assert.equal(error.code, "INVALID_FORM_EDIT");
        assert.equal(error.path, path.join("."));
        return true;
      },
    );
  }
});

test("scalar condition controls declare lossless controller edit kinds", () => {
  let state = createConfigurationFormState(configurationWithScalarConditions());
  const cases = [
    { index: 0, kind: "scalar", rawValue: "null", expected: null },
    { index: 1, kind: "text", rawValue: "next text", expected: "next text" },
    { index: 2, kind: "number", rawValue: "2.75", expected: 2.75 },
    { index: 3, kind: "boolean", rawValue: false, expected: false },
  ];
  const markup = renderConfigurationSettingsSkeleton({ state });

  for (const entry of cases) {
    const path = [
      "workflowRouting",
      "rules",
      0,
      "condition",
      "values",
      entry.index,
    ];
    const control = controlForPath(markup, path);
    assert.match(
      control,
      new RegExp(`data-configuration-edit-kind="${entry.kind}"`),
      path.join("."),
    );
    state = setConfigurationFormField(state, {
      path,
      kind: entry.kind,
      rawValue: entry.rawValue,
    });
  }

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.configuration.workflowRouting.rules[0].condition.values,
    cases.map(({ expected }) => expected),
  );
  assert.match(markup, /data-configuration-template-scalar-type/);
  for (const type of ["null", "string", "number", "boolean"]) {
    assert.match(markup, new RegExp(`<option value="${type}"`));
  }
  assert.match(markup, /data-configuration-template-scalar-value/);
});

test("router-backed brain references render accessible configured provider selects", () => {
  const configuration = configurationWithRemoteBrains();
  const initial = createConfigurationFormState(configuration);
  assert.equal(configurationDocumentFromForm(initial).ok, true);
  const markup = renderConfigurationSettingsSkeleton({ state: initial });
  const paths = [
    ["employees", "roles", "developer", "brain", "provider"],
    ["memory", "answering", "brain", "provider"],
    ["memory", "answering", "localBrain", "provider"],
  ];

  for (const path of paths) {
    const select = selectForPath(markup, path);
    assert.match(select, /<option value="ollama">ollama<\/option>/);
    assert.match(
      select,
      /<option value="remote\.openai" selected>remote\.openai<\/option>/,
    );
    assert.match(select, /name="\[&quot;/);
    assert.match(
      markup,
      new RegExp(`<label[^>]+for="${escapeRegExp(controlId(path))}"`),
    );
  }

  const invalid = setConfigurationFormField(initial, {
    path: ["employees", "roles", "developer", "brain", "provider"],
    kind: "text",
    rawValue: "missing-provider",
  });
  const invalidMarkup = renderConfigurationSettingsSkeleton({ state: invalid });
  assert.match(
    selectForPath(invalidMarkup, ["employees", "roles", "developer", "brain", "provider"]),
    /<option value="missing-provider" selected data-configuration-invalid-option>无效：missing-provider<\/option>/,
  );

  for (const path of [
    ["brain", "provider"],
    ["employees", "prReviewer", "brain", "provider"],
  ]) {
    controlForPath(markup, path);
    const select = selectForPath(markup, path);
    assert.match(select, /<option value="ollama" selected>ollama<\/option>/);
    assert.doesNotMatch(select, /remote\.openai/);
  }
});

function configurationFormPathAttribute(path) {
  return JSON.stringify(path)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function controlForPath(markup, path) {
  const encoded = escapeRegExp(configurationFormPathAttribute(path.map(String)));
  const match = markup.match(
    new RegExp(`<(?:input|select)[^>]*data-configuration-field="${encoded}"[^>]*>`),
  );
  assert.ok(match, `missing control for ${path.join(".")}`);
  return match[0];
}

function templateControlForPath(markup, path) {
  const encoded = escapeRegExp(configurationFormPathAttribute(path.map(String)));
  const match = markup.match(
    new RegExp(`<input[^>]*data-configuration-template-field="${encoded}"[^>]*>`),
  );
  assert.ok(match, `missing template control for ${path.join(".")}`);
  return match[0];
}

function selectForPath(markup, path) {
  const encoded = escapeRegExp(configurationFormPathAttribute(path.map(String)));
  const match = markup.match(
    new RegExp(`<select[^>]*data-configuration-field="${encoded}"[^>]*>[\\s\\S]*?<\\/select>`),
  );
  assert.ok(match, `missing select for ${path.join(".")}`);
  return match[0];
}

function controlId(path) {
  return `configuration-field-${encodeURIComponent(JSON.stringify(path.map(String))).replaceAll("%", "_")}`;
}
