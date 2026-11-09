import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ConfigurationContractError,
  configurationDocumentDigest,
  configurationDocumentImpact,
  normalizeConfigurationDocument,
} from "../src/domain/configuration-contract.js";
import {
  configurationDocumentFromForm,
  createConfigurationFormState,
  setConfigurationFormField,
} from "../public/configuration-form-support.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedDocument = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);
const LEGACY_GITHUB_CREDENTIAL_DIGEST =
  "c4a21c30ce1dd42089c12f4e10f2aeb4db6c093a30b8d4ac56dc80f15dd00c39";

function document() {
  return structuredClone(committedDocument);
}

test("global DingTalk digest brain requires only explicit DingTalk remote authority", () => {
  const before = document();
  const configured = document();
  configured.brainProviders["digest-luna"] = { kind: "codex-cli", credentialMode: "codex-native-login", remote: true };
  configured.brain.primaryBrain = {
    provider: "digest-luna", model: "gpt-6-luna", reasoningEffort: "medium",
    remoteData: { requirements: false, code: false, memory: false, dingtalk: true },
  };
  configured.brain.allowRemoteDingTalkSummary = true;
  const normalized = normalizeConfigurationDocument(configured);
  assert.deepEqual(normalized.brain.primaryBrain, configured.brain.primaryBrain);
  assert.equal(normalized.brain.allowRemoteDingTalkSummary, true);
  const form = configurationDocumentFromForm(createConfigurationFormState(normalized));
  assert.equal(form.ok, true);
  assert.deepEqual(form.configuration.brain.primaryBrain, configured.brain.primaryBrain);
  const impact = configurationDocumentImpact(before, configured);
  assert.ok(impact.authority_expansion.includes("brain.allowRemoteDingTalkSummary"));
  assert.ok(impact.authority_expansion.includes("brain.primaryBrain"));
  assert.ok(impact.restart_required.includes("brain.primaryBrain"));
  for (const mutate of [
    (value) => { value.brain.allowRemoteDingTalkSummary = false; },
    (value) => { value.brain.primaryBrain.remoteData.code = true; },
    (value) => { value.brain.primaryBrain.remoteData.dingtalk = false; },
  ]) {
    const invalid = structuredClone(configured); mutate(invalid);
    assert.throws(() => normalizeConfigurationDocument(invalid));
  }
});

test("PR promoter primary brain is optional, explicit, versioned and preserved by form round trips", () => {
  const old = document();
  const oldDigest = configurationDocumentDigest(old);
  const configured = structuredClone(old);
  configured.brainProviders["promoter-codex"] = { kind: "codex-cli", credentialMode: "codex-native-login", remote: true };
  configured.employees.prReviewer.allowRemoteCodeContext = true;
  configured.employees.prReviewer.primaryBrain = { provider: "promoter-codex", model: "gpt-5.6-luna", reasoningEffort: "medium",
    remoteData: { requirements: true, code: true, memory: false } };
  const normalized = normalizeConfigurationDocument(configured);
  assert.deepEqual(normalized.employees.prReviewer.primaryBrain, configured.employees.prReviewer.primaryBrain);
  const form = configurationDocumentFromForm(createConfigurationFormState(normalized));
  assert.equal(form.ok, true);
  assert.deepEqual(form.configuration.employees.prReviewer.primaryBrain, configured.employees.prReviewer.primaryBrain);
  const impact = configurationDocumentImpact(old, configured);
  assert.ok(impact.restart_required.includes("employees.prReviewer.primaryBrain"));
  assert.ok(impact.authority_expansion.includes("employees.prReviewer.primaryBrain"));
  assert.equal(configurationDocumentDigest(old), oldDigest);
  assert.equal(Object.hasOwn(normalizeConfigurationDocument(old).employees.prReviewer, "primaryBrain"), false);
  for (const mutate of [
    (value) => { value.employees.prReviewer.primaryBrain.provider = "missing"; },
    (value) => { value.employees.prReviewer.allowRemoteCodeContext = false; },
    (value) => { value.employees.prReviewer.primaryBrain.remoteData.code = false; },
    (value) => { value.employees.prReviewer.primaryBrain.remoteData.requirements = false; },
  ]) {
    const invalid = structuredClone(configured); mutate(invalid);
    assert.throws(() => normalizeConfigurationDocument(invalid));
  }
});

test("mail summary is opt in without rewriting historical configuration digests", () => {
  const old = document();
  const before = configurationDocumentDigest(old);
  assert.equal(Object.hasOwn(normalizeConfigurationDocument(old).dingtalk, "mailEnabled"), false);
  const enabled = structuredClone(old);
  enabled.dingtalk.mailEnabled = true;
  assert.equal(normalizeConfigurationDocument(enabled).dingtalk.mailEnabled, true);
  assert.notEqual(configurationDocumentDigest(enabled), before);
  assert.ok(configurationDocumentImpact(old, enabled).restart_required.includes("dingtalk.mailEnabled"));
  assert.ok(configurationDocumentImpact(old, enabled).authority_expansion.includes("dingtalk.mailEnabled"));
  delete enabled.dingtalk.mailEnabled;
  assert.equal(configurationDocumentDigest(enabled), before);
  enabled.dingtalk.mailEnabled = "true";
  assert.throws(() => normalizeConfigurationDocument(enabled));
});

function legacyGithubCredentialDocument() {
  const value = document();
  delete value.githubActions.credentialMode;
  delete value.githubActions.automaticReview;
  delete value.githubActions.assignAfterAutomaticReview;
  delete value.githubActions.automaticOwnPrRepair;
  return value;
}

function trustedGitCommand() {
  return process.platform === "win32"
    ? "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
    : "/usr/bin/git";
}

function mirrorPath(name) {
  return process.platform === "win32"
    ? `D:\\mirrors\\${name}.git`
    : `/var/lib/mirrors/${name}.git`;
}

function conflictPreparationDocument() {
  const value = document();
  value.codeExecutor = {
    enabled: false,
    gitCommand: trustedGitCommand(),
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: {
        "acme/command-center": mirrorPath("oct-base"),
      },
      headMirrorsByRepository: {
        "acme/command-center": mirrorPath("oct-head"),
      },
    },
  };
  return value;
}

function assertInvalid(value) {
  assert.throws(
    () => normalizeConfigurationDocument(value),
    (error) =>
      error instanceof ConfigurationContractError &&
      error.code === "INVALID_CONFIGURATION_DOCUMENT" &&
      error.statusCode === 400,
  );
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

test("the committed complete configuration normalizes into an independent deep-frozen document", () => {
  const input = document();
  const normalized = normalizeConfigurationDocument(input);

  assert.deepEqual(normalized, committedDocument);
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.employees, input.employees);
  assertDeepFrozen(normalized);

  input.employees.roles.developer.brain.model = "mutated-after-validation";
  assert.equal(normalized.employees.roles.developer.brain.model, "qwen3.5:9b");
});

test("the canonical digest is stable across object insertion order", () => {
  const forward = document();
  const reversed = reverseObjectKeys(forward);

  const first = configurationDocumentDigest(forward);
  const second = configurationDocumentDigest(reversed);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
});

test("pre-boundary documents preserve their content-addressed shape", () => {
  const legacy = document();
  delete legacy.githubRead;

  const normalized = normalizeConfigurationDocument(legacy);
  assert.equal(Object.hasOwn(normalized, "githubRead"), false);
  assert.deepEqual(normalized, legacy);
  assert.equal(configurationDocumentDigest(legacy), configurationDocumentDigest(normalized));
});

test("the legacy GitHub-read default is classified by effective authority", () => {
  const legacy = document();
  delete legacy.githubRead;
  const disabled = structuredClone(legacy);
  disabled.githubRead = { enabled: false };

  const tightening = configurationDocumentImpact(legacy, disabled);
  assert.deepEqual(tightening.security_tightening, ["githubRead"]);
  assert.deepEqual(tightening.authority_expansion, []);
  assert.deepEqual(tightening.restart_required, ["githubRead"]);

  const restored = configurationDocumentImpact(disabled, legacy);
  assert.deepEqual(restored.security_tightening, []);
  assert.deepEqual(restored.authority_expansion, ["githubRead"]);
});

test("GitHub-read window omission remains omitted while rolling windows are exact", () => {
  const legacy = document();
  const normalizedLegacy = normalizeConfigurationDocument(legacy);
  assert.equal(
    Object.hasOwn(normalizedLegacy.githubRead, "pullRequestUpdatedWindow"),
    false,
  );
  assert.equal(configurationDocumentDigest(normalizedLegacy), configurationDocumentDigest(legacy));

  for (const days of [1, 7, 3_650]) {
    const configured = document();
    configured.githubRead.pullRequestUpdatedWindow = { mode: "rolling", days };
    assert.deepEqual(
      normalizeConfigurationDocument(configured).githubRead.pullRequestUpdatedWindow,
      { mode: "rolling", days },
    );
  }

  for (const invalidWindow of [
    { mode: "rolling", days: 0 },
    { mode: "rolling", days: 3_651 },
    { mode: "rolling", days: 1.5 },
    { mode: "rolling", days: 7, unexpected: true },
    { mode: "unknown", days: 7 },
  ]) {
    const invalid = document();
    invalid.githubRead.pullRequestUpdatedWindow = invalidWindow;
    assertInvalid(invalid);
  }

  const accessor = document();
  let getterCalls = 0;
  accessor.githubRead.pullRequestUpdatedWindow = { mode: "rolling", days: 7 };
  Object.defineProperty(accessor.githubRead.pullRequestUpdatedWindow, "days", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 7;
    },
  });
  assertInvalid(accessor);
  assert.equal(getterCalls, 0);

  const abnormalPrototype = document();
  abnormalPrototype.githubRead.pullRequestUpdatedWindow = Object.assign(
    Object.create(null),
    { mode: "rolling", days: 7 },
  );
  assertInvalid(abnormalPrototype);

  const proxied = document();
  let proxyTrapCalls = 0;
  proxied.githubRead.pullRequestUpdatedWindow = new Proxy(
    { mode: "rolling", days: 7 },
    {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("configuration must not inspect a proxy");
      },
    },
  );
  assertInvalid(proxied);
  assert.equal(proxyTrapCalls, 0);
});

test("Issue active window is optional, bounded, and classified by authority", () => {
  const legacy = document();
  delete legacy.githubRead.issueActiveWindowDays;
  const defaulted = normalizeConfigurationDocument(legacy);
  assert.equal(
    Object.hasOwn(defaulted.githubRead, "issueActiveWindowDays"),
    false,
  );

  const configured = document();
  assert.equal(
    normalizeConfigurationDocument(configured).githubRead.issueActiveWindowDays,
    14,
  );
  assert.deepEqual(
    configurationDocumentImpact(legacy, configured).authority_expansion,
    [],
  );

  for (const invalidDays of [0, -1, 3_651, 14.5, "14"]) {
    const invalid = document();
    invalid.githubRead.issueActiveWindowDays = invalidDays;
    assertInvalid(invalid);
  }

  const narrower = structuredClone(configured);
  narrower.githubRead.issueActiveWindowDays = 7;
  assert.deepEqual(
    configurationDocumentImpact(configured, narrower).security_tightening,
    ["githubRead.issueActiveWindowDays"],
  );

  const wider = structuredClone(configured);
  wider.githubRead.issueActiveWindowDays = 30;
  assert.deepEqual(
    configurationDocumentImpact(configured, wider).authority_expansion,
    ["githubRead.issueActiveWindowDays"],
  );
});

test("fixed GitHub-read windows require canonical UTC local midnights across DST", () => {
  const configured = document();
  configured.githubRead.pullRequestUpdatedWindow = {
    mode: "fixed",
    fromInclusive: "2026-03-08T05:00:00.000Z",
    untilExclusive: "2026-03-10T04:00:00.000Z",
    timeZone: "America/New_York",
  };
  assert.deepEqual(
    normalizeConfigurationDocument(configured).githubRead.pullRequestUpdatedWindow,
    configured.githubRead.pullRequestUpdatedWindow,
  );

  const nonHourOffset = document();
  nonHourOffset.githubRead.pullRequestUpdatedWindow = {
    mode: "fixed",
    fromInclusive: "2026-08-01T18:15:00.000Z",
    untilExclusive: "2026-08-03T18:15:00.000Z",
    timeZone: "Asia/Kathmandu",
  };
  assert.deepEqual(
    normalizeConfigurationDocument(nonHourOffset).githubRead.pullRequestUpdatedWindow,
    nonHourOffset.githubRead.pullRequestUpdatedWindow,
  );

  for (const invalidWindow of [
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
    },
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00.000Z",
      untilExclusive: "2026-03-08T05:00:00.000Z",
      timeZone: "America/New_York",
    },
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T06:00:00.000Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
    },
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00.000Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "Not/A_Zone",
    },
    {
      mode: "fixed",
      fromInclusive: "2026-03-08T05:00:00.000Z",
      untilExclusive: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
      unexpected: true,
    },
    {
      mode: "fixed",
      fromInclusive: "2000-10-29T04:00:00.000Z",
      untilExclusive: "2000-10-30T05:00:00.000Z",
      timeZone: "America/Havana",
    },
  ]) {
    const invalid = document();
    invalid.githubRead.pullRequestUpdatedWindow = invalidWindow;
    assertInvalid(invalid);
  }
});

test("GitHub-read window impact follows discovery-set containment", () => {
  const path = "githubRead.pullRequestUpdatedWindow";
  const withWindow = (window) => {
    const value = document();
    if (window !== undefined) value.githubRead.pullRequestUpdatedWindow = window;
    return value;
  };
  const rolling7 = { mode: "rolling", days: 7 };
  const rolling30 = { mode: "rolling", days: 30 };
  const fixedWide = {
    mode: "fixed",
    fromInclusive: "2026-03-08T05:00:00.000Z",
    untilExclusive: "2026-03-12T04:00:00.000Z",
    timeZone: "America/New_York",
  };
  const fixedNarrow = {
    ...fixedWide,
    fromInclusive: "2026-03-09T04:00:00.000Z",
    untilExclusive: "2026-03-11T04:00:00.000Z",
  };
  const fixedShifted = {
    ...fixedWide,
    fromInclusive: "2026-03-10T04:00:00.000Z",
    untilExclusive: "2026-03-14T04:00:00.000Z",
  };

  const expectDirection = (before, after, tightening, expansion) => {
    const impact = configurationDocumentImpact(withWindow(before), withWindow(after));
    assert.deepEqual(impact.security_tightening, tightening ? [path] : []);
    assert.deepEqual(impact.authority_expansion, expansion ? [path] : []);
    assert.deepEqual(impact.restart_required, [path]);
  };

  expectDirection(undefined, rolling7, true, false);
  expectDirection(rolling7, undefined, false, true);
  expectDirection(rolling30, rolling7, true, false);
  expectDirection(rolling7, rolling30, false, true);
  expectDirection(fixedWide, fixedNarrow, true, false);
  expectDirection(fixedNarrow, fixedWide, false, true);
  expectDirection(fixedWide, fixedShifted, true, true);
  expectDirection(rolling7, fixedWide, true, true);

  const sameBoundariesNewZone = {
    ...fixedWide,
    timeZone: "America/Toronto",
  };
  expectDirection(fixedWide, sameBoundariesNewZone, false, false);
});

test("unknown and dangerous fields are rejected even below a disabled feature", () => {
  const unknown = document();
  unknown.codeExecutor.unrestrictedShell = true;
  assertInvalid(unknown);

  const dangerous = document();
  Object.defineProperty(dangerous.codeExecutor, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  assertInvalid(dangerous);
});

test("role task brains are optional exact assigned brains without legacy backfill", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(legacy.employees.roles.developer, "taskBrain"),
    false,
  );

  const configured = document();
  configured.employees.roles.developer.taskBrain = {
    provider: "codex-local-cli",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    remoteData: { requirements: true, code: true, memory: false },
  };
  const normalized = normalizeConfigurationDocument(configured);
  assert.deepEqual(
    normalized.employees.roles.developer.taskBrain,
    configured.employees.roles.developer.taskBrain,
  );
  assertDeepFrozen(normalized.employees.roles.developer.taskBrain);

  const unknownField = structuredClone(configured);
  unknownField.employees.roles.developer.taskBrain.temperature = 0.2;
  assertInvalid(unknownField);

  const incomplete = structuredClone(configured);
  delete incomplete.employees.roles.developer.taskBrain.remoteData;
  assertInvalid(incomplete);

  const invalidReasoningEffort = structuredClone(configured);
  invalidReasoningEffort.employees.roles.developer.taskBrain.reasoningEffort =
    "maximum";
  assertInvalid(invalidReasoningEffort);

  const unknownProvider = structuredClone(configured);
  unknownProvider.employees.roles.developer.taskBrain.provider = "missing";
  assertInvalid(unknownProvider);
});

test("configuration change authority requires the same explicit role permission and policy", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(
      legacy.workCoordination.policy,
      "configurationChangeRoles",
    ),
    false,
  );

  const configured = document();
  configured.employees.roles.developer.permissions.allowedIntents.push(
    "propose_configuration_change",
  );
  configured.workCoordination.policy.configurationChangeRoles = ["developer"];
  assert.deepEqual(
    normalizeConfigurationDocument(configured).workCoordination.policy
      .configurationChangeRoles,
    ["developer"],
  );

  const missingPolicy = document();
  missingPolicy.employees.roles.developer.permissions.allowedIntents.push(
    "propose_configuration_change",
  );
  assertInvalid(missingPolicy);

  const missingPermission = document();
  missingPermission.workCoordination.policy.configurationChangeRoles = [
    "developer",
  ];
  assertInvalid(missingPermission);

  const legacyReviewer = document();
  legacyReviewer.workCoordination.policy.configurationChangeRoles = [
    "pr-reviewer",
  ];
  assertInvalid(legacyReviewer);
});

test("work coordination accepts configurable external reviewers by product", () => {
  const configured = document();
  configured.workCoordination.policy.reviewOwnersByProduct = {
    qt: ["qt-reviewer"],
    bs: ["bs-reviewer-primary", "bs-reviewer-secondary"],
  };

  assert.deepEqual(
    normalizeConfigurationDocument(configured).workCoordination.policy
      .reviewOwnersByProduct,
    configured.workCoordination.policy.reviewOwnersByProduct,
  );

  const invalid = structuredClone(configured);
  invalid.workCoordination.policy.reviewOwnersByProduct.qt = ["bad login"];
  assertInvalid(invalid);
});

test("Git Head snapshot configuration is opt-in and preserves legacy workspaces", () => {
  const legacy = document();
  legacy.codeExecutor = {
    enabled: false,
    workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
  };
  assert.deepEqual(normalizeConfigurationDocument(legacy).codeExecutor, {
    enabled: false,
    workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
  });

  const optedIn = structuredClone(legacy);
  optedIn.codeExecutor.gitCommand =
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
  optedIn.codeExecutor.gitTimeoutMs = 30_000;
  optedIn.codeExecutor.workspaces[0].gitHeadSnapshot = true;

  assert.deepEqual(normalizeConfigurationDocument(optedIn).codeExecutor, {
    enabled: false,
    gitCommand: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    gitTimeoutMs: 30_000,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
      },
    ],
  });
});

test("Git Head snapshot workspaces require a bounded Git configuration", () => {
  const missingCommand = document();
  missingCommand.codeExecutor = {
    enabled: false,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
      },
    ],
  };
  assertInvalid(missingCommand);

  for (const timeout of [1, 60_000]) {
    const boundary = document();
    boundary.codeExecutor.gitTimeoutMs = timeout;
    assert.equal(
      normalizeConfigurationDocument(boundary).codeExecutor.gitTimeoutMs,
      timeout,
    );
  }

  for (const timeout of [0, 60_001, 1.5]) {
    const invalidTimeout = document();
    invalidTimeout.codeExecutor.gitTimeoutMs = timeout;
    assertInvalid(invalidTimeout);
  }

  const blankCommand = document();
  blankCommand.codeExecutor.gitCommand = "   ";
  assertInvalid(blankCommand);

  const invalidFlag = structuredClone(missingCommand);
  invalidFlag.codeExecutor.gitCommand = "git";
  invalidFlag.codeExecutor.workspaces[0].gitHeadSnapshot = "true";
  assertInvalid(invalidFlag);

  const relativeCommand = structuredClone(missingCommand);
  relativeCommand.codeExecutor.gitCommand = "tools/mingw64/bin/git.exe";
  assertInvalid(relativeCommand);
});

test("Windows Git Head snapshots accept the UCRT64 native implementation", () => {
  if (process.platform !== "win32") return;
  const configuration = document();
  configuration.codeExecutor = {
    enabled: false,
    gitCommand: "C:/Program Files/Git/ucrt64/bin/git.exe",
    workspaces: [{ id: "dashboard", sourceRoot: "dashboard", gitHeadSnapshot: true }],
  };
  assert.equal(normalizeConfigurationDocument(configuration).codeExecutor.gitCommand,
    configuration.codeExecutor.gitCommand);
});

test("Windows Git Head snapshots reject wrapper executables before activation", () => {
  if (process.platform !== "win32") return;
  const wrapper = document();
  wrapper.codeExecutor = {
    enabled: false,
    gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    workspaces: [{
      id: "dashboard",
      sourceRoot: "dashboard",
      gitHeadSnapshot: true,
    }],
  };
  assert.throws(
    () => normalizeConfigurationDocument(wrapper),
    (error) =>
      error instanceof ConfigurationContractError &&
      error.code === "INVALID_CONFIGURATION_DOCUMENT" &&
      error.message.startsWith("codeExecutor.gitCommand "),
  );

});

test("conflict preparation is opt-in and preserves the legacy code executor shape", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(legacy.codeExecutor, "conflictPreparation"),
    false,
  );

  const disabled = document();
  disabled.codeExecutor.conflictPreparation = { enabled: false };
  assert.deepEqual(
    normalizeConfigurationDocument(disabled).codeExecutor.conflictPreparation,
    { enabled: false },
  );

  const enabled = normalizeConfigurationDocument(conflictPreparationDocument());
  assert.deepEqual(enabled.codeExecutor.conflictPreparation, {
    enabled: true,
    baseMirrorsByRepository: {
      "acme/command-center": mirrorPath("oct-base"),
    },
    headMirrorsByRepository: {
      "acme/command-center": mirrorPath("oct-head"),
    },
  });
  assertDeepFrozen(enabled.codeExecutor.conflictPreparation);
});

test("conflict preparation uses exact enabled and disabled shapes", () => {
  const staleDisabled = document();
  staleDisabled.codeExecutor.conflictPreparation = {
    enabled: false,
    baseMirrorsByRepository: {},
  };
  assertInvalid(staleDisabled);

  for (const name of [
    "baseMirrorsByRepository",
    "headMirrorsByRepository",
  ]) {
    const missing = conflictPreparationDocument();
    delete missing.codeExecutor.conflictPreparation[name];
    assertInvalid(missing);

    const empty = conflictPreparationDocument();
    empty.codeExecutor.conflictPreparation[name] = {};
    assertInvalid(empty);
  }
});

test("conflict preparation accepts only canonical repository keys and local absolute mirrors", () => {
  const duplicate = conflictPreparationDocument();
  duplicate.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "ACME/COMMAND-CENTER"
  ] = mirrorPath("duplicate");
  assertInvalid(duplicate);

  for (const repository of ["owner-/repository", "bad--owner/repository", "owner/.repo", "owner/repo..git"]) {
    const invalidRepository = conflictPreparationDocument();
    invalidRepository.codeExecutor.conflictPreparation.baseMirrorsByRepository = {
      [repository]: mirrorPath("invalid-repository"),
    };
    assertInvalid(invalidRepository);
  }

  for (const mirror of ["relative/repository.git", "//server/share/repository.git"]) {
    const invalidMirror = conflictPreparationDocument();
    invalidMirror.codeExecutor.conflictPreparation.baseMirrorsByRepository[
      "acme/command-center"
    ] = mirror;
    assertInvalid(invalidMirror);
  }
});

test("conflict preparation requires the same trusted Git implementation as snapshots", () => {
  const missing = conflictPreparationDocument();
  delete missing.codeExecutor.gitCommand;
  assertInvalid(missing);

  const relative = conflictPreparationDocument();
  relative.codeExecutor.gitCommand = "tools/mingw64/bin/git.exe";
  assertInvalid(relative);

  if (process.platform === "win32") {
    const wrapper = conflictPreparationDocument();
    wrapper.codeExecutor.gitCommand = "C:\\Program Files\\Git\\cmd\\git.exe";
    assertInvalid(wrapper);
  }
});

test("Git Head snapshot fields retain strict data-only boundaries", () => {
  const extra = document();
  extra.codeExecutor = {
    enabled: false,
    gitCommand: "git",
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
        gitRevision: "HEAD",
      },
    ],
  };
  assertInvalid(extra);

  for (const accessorPath of ["gitCommand", "gitHeadSnapshot"]) {
    const accessor = document();
    accessor.codeExecutor = {
      enabled: false,
      gitCommand: "git",
      workspaces: [
        {
          id: "dashboard",
          sourceRoot: "dashboard",
          gitHeadSnapshot: true,
        },
      ],
    };
    const target =
      accessorPath === "gitCommand"
        ? accessor.codeExecutor
        : accessor.codeExecutor.workspaces[0];
    let getterCalls = 0;
    Object.defineProperty(target, accessorPath, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return accessorPath === "gitCommand" ? "git" : true;
      },
    });

    assertInvalid(accessor);
    assert.equal(getterCalls, 0);
  }
});

test("versioned code executor profiles accept reusable Node script assets", () => {
  const value = document();
  value.codeExecutor = {
    enabled: true,
    docker: {
      executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: [{ id: "dashboard", sourceRoot: "." }],
    profiles: {
      "reusable-smoke": {
        kind: "node-script",
        image: `node:22-alpine@sha256:${"a".repeat(64)}`,
        timeoutMs: 30_000,
        asset: {
          schemaVersion: 1,
          title: "Reusable smoke test",
          description: "Checks a stable cross-PR invariant.",
          version: 4,
          source: 'console.log("ok");',
        },
      },
    },
    requiredProfilesByWorkspace: { dashboard: ["reusable-smoke"] },
  };

  const normalized = normalizeConfigurationDocument(value);
  assert.deepEqual(
    normalized.codeExecutor.profiles["reusable-smoke"].asset,
    value.codeExecutor.profiles["reusable-smoke"].asset,
  );
});

test("Windows fixed profiles bind native executable and asset versions without Docker configuration", () => {
  const value = document();
  value.codeExecutor = { enabled: true, workspaces: [{ id: "dashboard", sourceRoot: "." }],
    profiles: { native: { kind: "windows-test", nodeExecutable: "C:/Program Files/nodejs/node.exe", nodeSha256: "a".repeat(64), timeoutMs: 30_000,
      asset: { schemaVersion: 1, title: "Native tests", description: "Fixed product assertions", version: 1, source: "fixed" } } },
    requiredProfilesByWorkspace: { dashboard: ["native"] } };
  assert.deepEqual(normalizeConfigurationDocument(value).codeExecutor.profiles, value.codeExecutor.profiles);
  const unpinned = structuredClone(value);
  delete unpinned.codeExecutor.profiles.native.nodeSha256;
  assertInvalid(unpinned);
});

test("own PR repair is an optional strict boolean and preserves legacy documents", () => {
  const legacy = document();
  delete legacy.githubActions.automaticOwnPrRepair;
  const normalized = normalizeConfigurationDocument(legacy);
  assert.equal(Object.hasOwn(normalized.githubActions, "automaticOwnPrRepair"), false);
  assert.equal(configurationDocumentDigest(normalized), configurationDocumentDigest(legacy));

  for (const enabled of [true, false]) {
    const configured = structuredClone(legacy);
    configured.githubActions.automaticOwnPrRepair = enabled;
    assert.equal(normalizeConfigurationDocument(configured).githubActions.automaticOwnPrRepair, enabled);
  }
  for (const value of ["true", 1, null, {}, []]) {
    const invalid = structuredClone(legacy);
    invalid.githubActions.automaticOwnPrRepair = value;
    assertInvalid(invalid);
  }
});

test("own PR repair enabling expands authority and disabling or removal tightens it", () => {
  const path = "githubActions.automaticOwnPrRepair";
  const withSetting = (value) => {
    const configuration = document();
    if (value === undefined) delete configuration.githubActions.automaticOwnPrRepair;
    else configuration.githubActions.automaticOwnPrRepair = value;
    return configuration;
  };
  for (const [before, after, tightening, expansion] of [
    [undefined, true, false, true],
    [false, true, false, true],
    [true, false, true, false],
    [true, undefined, true, false],
    [undefined, false, false, false],
    [false, undefined, false, false],
  ]) {
    const impact = configurationDocumentImpact(withSetting(before), withSetting(after));
    assert.deepEqual(impact.security_tightening, tightening ? [path] : []);
    assert.deepEqual(impact.authority_expansion, expansion ? [path] : []);
    assert.deepEqual(impact.restart_required, [path]);
  }
});

test("executor profile IDs and bindings match the sandbox ID boundary", () => {
  const valid = () => {
    const value = document();
    value.codeExecutor = {
      enabled: true,
      docker: {
        executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      },
      workspaces: [{ id: "dashboard", sourceRoot: "." }],
      profiles: {
        "node-test": {
          kind: "node-test",
          image: `node:22-alpine@sha256:${"a".repeat(64)}`,
          timeoutMs: 30_000,
        },
      },
      requiredProfilesByWorkspace: { dashboard: ["node-test"] },
    };
    return value;
  };

  for (const profileId of ["node_test", "node.test", "a".repeat(65)]) {
    const value = valid();
    value.codeExecutor.profiles = {
      [profileId]: value.codeExecutor.profiles["node-test"],
    };
    value.codeExecutor.requiredProfilesByWorkspace.dashboard = [profileId];
    assertInvalid(value);

    const invalidBinding = valid();
    invalidBinding.codeExecutor.requiredProfilesByWorkspace.dashboard = [profileId];
    assertInvalid(invalidBinding);
  }

  const boundary = valid();
  const longestId = "a".repeat(64);
  boundary.codeExecutor.profiles = {
    [longestId]: boundary.codeExecutor.profiles["node-test"],
  };
  boundary.codeExecutor.requiredProfilesByWorkspace.dashboard = [longestId];
  assert.deepEqual(
    normalizeConfigurationDocument(boundary).codeExecutor.requiredProfilesByWorkspace,
    { dashboard: [longestId] },
  );
});

test("reusable test assets reject unversioned, empty, oversized, or extra content", () => {
  const valid = () => {
    const value = document();
    value.codeExecutor = {
      enabled: true,
      docker: {
        executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      },
      workspaces: [{ id: "dashboard", sourceRoot: "." }],
      profiles: {
        "reusable-smoke": {
          kind: "node-script",
          image: `node:22-alpine@sha256:${"a".repeat(64)}`,
          timeoutMs: 30_000,
          asset: {
            schemaVersion: 1,
            title: "Reusable smoke test",
            description: "Checks a stable cross-PR invariant.",
            version: 1,
            source: 'console.log("ok");',
          },
        },
      },
      requiredProfilesByWorkspace: { dashboard: ["reusable-smoke"] },
    };
    return value;
  };

  for (const mutate of [
    (asset) => { delete asset.version; },
    (asset) => { asset.source = ""; },
    (asset) => { asset.source = "x".repeat(65_537); },
    (asset) => { asset.command = "powershell.exe"; },
  ]) {
    const value = valid();
    mutate(value.codeExecutor.profiles["reusable-smoke"].asset);
    assertInvalid(value);
  }
});

test("accessors, symbols, and abnormal prototypes are rejected without invoking them", () => {
  const accessor = document();
  let getterCalls = 0;
  Object.defineProperty(accessor.employees.roles.developer.brain, "model", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  assertInvalid(accessor);
  assert.equal(getterCalls, 0);

  const symbol = document();
  symbol.memory[Symbol("hidden")] = true;
  assertInvalid(symbol);

  const abnormalPrototype = document();
  abnormalPrototype.memory.imports = Object.assign(Object.create(null), {
    localSessions: false,
    git: false,
  });
  assertInvalid(abnormalPrototype);
});

test("sparse, decorated, and cyclic configuration values are rejected", () => {
  const sparse = document();
  sparse.trackedRepositories = new Array(2);
  sparse.trackedRepositories[1] = "acme/product";
  assertInvalid(sparse);

  const decorated = document();
  decorated.employees.roles.developer.permissions.allowedIntents.extra = true;
  assertInvalid(decorated);

  const cyclic = document();
  cyclic.employees.roles.developer.brain.remoteData = cyclic;
  assertInvalid(cyclic);

  const nullMap = document();
  nullMap.brainProviders = null;
  assertInvalid(nullMap);
});

test("actual credentials are rejected while bounded environment references remain persistable", () => {
  for (const [field, value] of [
    ["token", "ghp_not-a-real-token"],
    ["apiKey", "sk-not-a-real-key"],
    ["password", "not-a-real-password"],
    ["privateKey", "-----BEGIN PRIVATE KEY-----"],
  ]) {
    const unsafe = document();
    unsafe.brainProviders.ollama[field] = value;
    assertInvalid(unsafe);
  }

  const referenced = document();
  referenced.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    timeoutMs: 60_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
    remote: true,
  };
  referenced.githubActions = {
    enabled: false,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
  };

  const normalized = normalizeConfigurationDocument(referenced);
  assert.equal(
    normalized.brainProviders["remote-smart"].apiKeyEnv,
    "MYDASHBOARD_MODEL_TOKEN",
  );
  assert.equal(
    normalized.githubActions.tokenEnv,
    "MYDASHBOARD_GITHUB_TOKEN",
  );
  assert.equal(JSON.stringify(normalized).includes("not-a-real"), false);
});

test("GitHub PR external actions require an explicit unique allow-list", () => {
  const configured = document();
  configured.githubActions = {
    enabled: true,
    actorAccountId: "runtime-user",
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["comment", "review", "update_branch", "merge"],
  };

  assert.deepEqual(
    normalizeConfigurationDocument(configured).githubActions.enabledActions,
    ["comment", "review", "update_branch", "merge"],
  );

  for (const enabledActions of [
    ["comment", "comment"],
    ["delete_branch"],
    "comment",
  ]) {
    const invalid = structuredClone(configured);
    invalid.githubActions.enabledActions = enabledActions;
    assertInvalid(invalid);
  }

  assert.equal(
    Object.hasOwn(
      normalizeConfigurationDocument((() => {
        const legacy = document();
        delete legacy.githubActions.enabledActions;
        return legacy;
      })()).githubActions,
      "enabledActions",
    ),
    false,
  );
});

test("GitHub credential modes preserve legacy shape and enforce mode-specific references", () => {
  const legacy = legacyGithubCredentialDocument();
  const legacyNormalized = normalizeConfigurationDocument(legacy);
  assert.equal(Object.hasOwn(legacyNormalized.githubActions, "credentialMode"), false);
  assert.equal(configurationDocumentDigest(legacy), LEGACY_GITHUB_CREDENTIAL_DIGEST);

  const unrelatedEdit = configurationDocumentFromForm(
    setConfigurationFormField(createConfigurationFormState(legacy), {
      path: ["refreshMinutes"],
      kind: "integer",
      rawValue: "11",
    }),
  );
  const expectedUnrelatedEdit = structuredClone(legacy);
  expectedUnrelatedEdit.refreshMinutes = 11;
  assert.equal(unrelatedEdit.ok, true);
  assert.equal(
    Object.hasOwn(unrelatedEdit.configuration.githubActions, "credentialMode"),
    false,
  );
  assert.equal(
    configurationDocumentDigest(unrelatedEdit.configuration),
    configurationDocumentDigest(expectedUnrelatedEdit),
  );

  const ghLogin = structuredClone(legacy);
  ghLogin.githubActions = {
    enabled: true,
    credentialMode: "gh-login",
    actorAccountId: "runtime-user",
    ghCommand: process.execPath,
    timeoutMs: 600_000,
  };
  assert.deepEqual(normalizeConfigurationDocument(ghLogin).githubActions, {
    enabled: true,
    credentialMode: "gh-login",
    actorAccountId: "runtime-user",
    ghCommand: process.execPath,
    timeoutMs: 600_000,
  });

  for (const mutate of [
    (value) => { value.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN"; },
    (value) => { value.githubActions.credentialMode = "token-env"; },
    (value) => { value.githubActions.ghCommand = "relative/gh"; },
    (value) => { value.githubActions.timeoutMs = 999; },
    (value) => { value.githubActions.timeoutMs = 600_001; },
  ]) {
    const invalid = structuredClone(ghLogin);
    mutate(invalid);
    assertInvalid(invalid);
  }

  const tokenEnv = structuredClone(ghLogin);
  tokenEnv.githubActions.credentialMode = "token-env";
  tokenEnv.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN";
  assert.equal(
    normalizeConfigurationDocument(tokenEnv).githubActions.credentialMode,
    "token-env",
  );
});

test("GitHub credential mode changes are security-sensitive and restart-required", () => {
  const before = legacyGithubCredentialDocument();
  before.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN";
  const after = structuredClone(before);
  after.githubActions.credentialMode = "gh-login";
  delete after.githubActions.tokenEnv;

  const impact = configurationDocumentImpact(before, after);
  assert.deepEqual(impact.security_tightening, ["githubActions.credentialMode"]);
  assert.deepEqual(impact.authority_expansion, ["githubActions.credentialMode"]);
  assert.deepEqual(impact.restart_required, [
    "githubActions.credentialMode",
    "githubActions.tokenEnv",
  ]);
});

test("GitHub PR action capability changes are authority changes requiring restart", () => {
  const legacy = document();
  delete legacy.githubActions.enabledActions;
  const enabled = structuredClone(legacy);
  enabled.githubActions.enabledActions = ["comment", "merge"];
  const expansion = configurationDocumentImpact(legacy, enabled);
  assert.deepEqual(expansion.authority_expansion, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(expansion.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(expansion.restart_required, [
    "githubActions.enabledActions",
  ]);

  const tightened = structuredClone(enabled);
  tightened.githubActions.enabledActions = ["comment"];
  const removal = configurationDocumentImpact(enabled, tightened);
  assert.deepEqual(removal.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(removal.authority_expansion, []);
  assert.deepEqual(removal.restart_required, [
    "githubActions.enabledActions",
  ]);

  const explicitlyDisabled = structuredClone(legacy);
  explicitlyDisabled.githubActions.enabledActions = [];
  const legacyDisabled = configurationDocumentImpact(
    legacy,
    explicitlyDisabled,
  );
  assert.deepEqual(legacyDisabled.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(legacyDisabled.authority_expansion, []);

  const legacyRestored = configurationDocumentImpact(
    explicitlyDisabled,
    legacy,
  );
  assert.deepEqual(legacyRestored.security_tightening, []);
  assert.deepEqual(legacyRestored.authority_expansion, [
    "githubActions.enabledActions",
  ]);
});

test("role brains, routing targets, and trusted policies must reference declared configuration", () => {
  const missingProvider = document();
  missingProvider.employees.roles.developer.brain.provider = "missing-provider";
  assertInvalid(missingProvider);

  const missingRole = document();
  missingRole.workflowRouting.rules[0].targets[0].id = "missing-role";
  assertInvalid(missingRole);

  const untrustedCodeRole = document();
  untrustedCodeRole.workCoordination.policy.codeOperationsByRole.orchestrator = [
    "modify",
  ];
  assertInvalid(untrustedCodeRole);
});

test("legacy brains stay on Ollama while routed role and memory brains accept remote providers", () => {
  for (const mutate of [
    (value) => {
      value.brain.provider = "remote-smart";
    },
    (value) => {
      value.employees.prReviewer.brain.provider = "remote-smart";
    },
  ]) {
    const legacy = document();
    legacy.brainProviders["remote-smart"] = {
      kind: "openai-compatible",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
      remote: true,
    };
    mutate(legacy);
    assertInvalid(legacy);
  }

  const routed = document();
  routed.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    remote: true,
  };
  routed.employees.roles.developer.brain.provider = "remote-smart";
  routed.memory.answering.brain = structuredClone(
    routed.employees.roles.developer.brain,
  );
  routed.memory.answering.brain.provider = "remote-smart";
  const normalized = normalizeConfigurationDocument(routed);
  assert.equal(normalized.employees.roles.developer.brain.provider, "remote-smart");
  assert.equal(normalized.memory.answering.brain.provider, "remote-smart");
});

test("Responses providers use explicit credential references and stricter request limits", () => {
  const value = document();
  value.brainProviders["company.codex_api"] = {
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
  value.employees.roles.developer.brain.provider = "company.codex_api";
  const normalized = normalizeConfigurationDocument(value);

  assert.deepEqual(
    normalized.brainProviders["company.codex_api"],
    value.brainProviders["company.codex_api"],
  );
  assert.equal(
    normalized.employees.roles.developer.brain.provider,
    "company.codex_api",
  );

  for (const mutate of [
    (provider) => { provider.remote = false; },
    (provider) => { delete provider.apiKeyEnv; },
    (provider) => { provider.protocol = "agents"; },
    (provider) => { provider.responseFormat = "json-object"; },
    (provider) => { provider.responseFormat = "markdown"; },
    (provider) => { provider.maxRequestBytes = 1024 * 1024 + 1; },
    (provider) => { provider.contextTokens = 16_384; },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid.brainProviders["company.codex_api"]);
    assertInvalid(invalid);
  }

  const ollamaProtocol = document();
  ollamaProtocol.brainProviders.ollama.protocol = "responses";
  assertInvalid(ollamaProtocol);

  const ollamaResponseFormat = document();
  ollamaResponseFormat.brainProviders.ollama.responseFormat = "json-schema";
  assertInvalid(ollamaResponseFormat);
});

test("supervised CLI providers are closed remote-only brain identities", () => {
  for (const kind of ["codex-cli", "claude-cli"]) {
    const value = document();
    value.brainProviders[kind] = {
      kind,
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    };
    value.employees.roles.orchestrator.brain.provider = kind;

    const normalized = normalizeConfigurationDocument(value);
    assert.deepEqual(normalized.brainProviders[kind], value.brainProviders[kind]);
    assert.equal(normalized.employees.roles.orchestrator.brain.provider, kind);
  }
});

test("native Codex capacity is bounded, persistent, consistent and classified for restart", () => {
  const before = document();
  before.brainProviders.native = { kind: "codex-cli", credentialMode: "codex-native-login", remote: true };
  const after = structuredClone(before);
  after.brainProviders.native.maxConcurrentTurns = 2;
  assert.equal(normalizeConfigurationDocument(after).brainProviders.native.maxConcurrentTurns, 2);
  const field = "brainProviders.native.maxConcurrentTurns";
  assert.ok(configurationDocumentImpact(before, after).restart_required.includes(field));
  assert.ok(configurationDocumentImpact(before, after).authority_expansion.includes(field));
  assert.ok(configurationDocumentImpact(after, before).security_tightening.includes(field));
  for (const value of [0, 5, 1.5, "2"]) {
    const invalid = structuredClone(after); invalid.brainProviders.native.maxConcurrentTurns = value; assertInvalid(invalid);
  }
  for (const credentialMode of ["api-key", "codex-login"]) {
    const invalid = structuredClone(after); invalid.brainProviders.native.credentialMode = credentialMode; assertInvalid(invalid);
  }
  const inconsistent = structuredClone(after);
  inconsistent.brainProviders.second = structuredClone(before.brainProviders.native);
  assertInvalid(inconsistent);
  const remote = document(); remote.brainProviders.ollama.maxConcurrentTurns = 2; assertInvalid(remote);
});

test("CLI provider credential modes remain optional legacy configuration and classify authority", () => {
  const legacy = document();
  legacy.brainProviders.cli = { kind: "codex-cli", remote: true };
  assert.equal(
    Object.hasOwn(normalizeConfigurationDocument(legacy).brainProviders.cli, "credentialMode"),
    false,
  );

  for (const credentialMode of ["api-key", "codex-login", "codex-native-login"]) {
    const configured = structuredClone(legacy);
    configured.brainProviders.cli.credentialMode = credentialMode;
    assert.equal(
      normalizeConfigurationDocument(configured).brainProviders.cli.credentialMode,
      credentialMode,
    );
  }

  const login = structuredClone(legacy);
  login.brainProviders.cli.credentialMode = "codex-login";
  assert.deepEqual(configurationDocumentImpact(legacy, login).authority_expansion, [
    "brainProviders.cli.credentialMode",
  ]);
  assert.deepEqual(configurationDocumentImpact(legacy, login).restart_required, [
    "brainProviders.cli.credentialMode",
  ]);

  for (const credentialMode of ["codex-login", "codex-native-login"]) {
    const claude = structuredClone(legacy);
    claude.brainProviders.cli = { kind: "claude-cli", remote: true, credentialMode };
    assertInvalid(claude);
  }

  const nativeLogin = structuredClone(login);
  nativeLogin.brainProviders.cli.credentialMode = "codex-native-login";
  assert.deepEqual(configurationDocumentImpact(login, nativeLogin).restart_required, [
    "brainProviders.cli.credentialMode",
  ]);
  assert.deepEqual(configurationDocumentImpact(login, nativeLogin).authority_expansion, [
    "brainProviders.cli.credentialMode",
  ]);

  for (const provider of ["ollama", "openai-compatible"]) {
    const nonCli = document();
    const providerId = provider === "ollama" ? "ollama" : "openai";
    if (provider === "openai-compatible") {
      nonCli.brainProviders[providerId] = {
        kind: provider,
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        remote: true,
        credentialMode: "api-key",
      };
    } else {
      nonCli.brainProviders[providerId].credentialMode = "api-key";
    }
    assertInvalid(nonCli);
  }
});

test("supervised CLI provider configuration cannot widen process authority", () => {
  const cases = [
    {
      name: "missing remote classification",
      mutate(provider) { delete provider.remote; },
      path: "brainProviders.codex-cli.remote",
    },
    {
      name: "local classification",
      mutate(provider) { provider.remote = false; },
      path: "brainProviders.codex-cli.remote",
    },
    {
      name: "model endpoint",
      mutate(provider) { provider.baseUrl = "https://models.example/v1"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "credential reference",
      mutate(provider) { provider.apiKeyEnv = "OPENAI_API_KEY"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "wire protocol",
      mutate(provider) { provider.protocol = "responses"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "response format",
      mutate(provider) { provider.responseFormat = "json-schema"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "context window",
      mutate(provider) { provider.contextTokens = 16_384; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "executable",
      mutate(provider) { provider.executable = "codex"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "arguments",
      mutate(provider) { provider.args = ["--dangerously-bypass-approvals-and-sandbox"]; },
      path: "brainProviders.codex-cli",
    },
  ];

  for (const { name, mutate, path } of cases) {
    const value = document();
    value.brainProviders["codex-cli"] = {
      kind: "codex-cli",
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    };
    mutate(value.brainProviders["codex-cli"]);
    assert.throws(
      () => normalizeConfigurationDocument(value),
      (error) =>
        error instanceof ConfigurationContractError &&
        error.message.includes(path),
      name,
    );
  }

  for (const [field, value] of [
    ["timeoutMs", 999],
    ["timeoutMs", 3_600_001],
    ["maxResponseBytes", 1_023],
    ["maxResponseBytes", 1_048_577],
    ["maxRequestBytes", 1_023],
    ["maxRequestBytes", 1_048_577],
  ]) {
    const invalid = document();
    invalid.brainProviders["claude-cli"] = {
      kind: "claude-cli",
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
      [field]: value,
    };
    assertInvalid(invalid);
  }
});

test("providers without protocol preserve legacy numeric configuration ranges", () => {
  const value = document();
  value.brainProviders["legacy.remote"] = {
    kind: "openai-compatible",
    baseUrl: "https://legacy.example/v1",
    apiKeyEnv: "LEGACY_MODEL_TOKEN",
    remote: true,
    timeoutMs: 180_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 1,
  };

  const normalized = normalizeConfigurationDocument(value);
  assert.deepEqual(
    normalized.brainProviders["legacy.remote"],
    value.brainProviders["legacy.remote"],
  );

  const explicitChat = structuredClone(value);
  explicitChat.brainProviders["legacy.remote"].protocol = "chat-completions";
  assertInvalid(explicitChat);
});

test("change package activation requires the code executor it composes with", () => {
  const invalid = document();
  invalid.changePackages = {
    enabled: true,
    gitCommand: trustedGitCommand(),
  };
  invalid.codeExecutor = { enabled: false };

  assertInvalid(invalid);
});

test("provider protocol changes require new authority and restart", () => {
  const before = document();
  before.brainProviders["company.codex_api"] = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "chat-completions",
    remote: true,
    timeoutMs: 120_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  before.employees.roles.developer.brain.provider = "company.codex_api";
  const after = structuredClone(before);
  after.brainProviders["company.codex_api"].protocol = "responses";

  const impact = configurationDocumentImpact(before, after);

  assert.deepEqual(impact.security_tightening, [
    "brainProviders.company.codex_api.protocol",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "brainProviders.company.codex_api.protocol",
  ]);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, [
    "brainProviders.company.codex_api.protocol",
  ]);
});

test("provider response format changes require new authority and restart", () => {
  const before = document();
  before.brainProviders["company.ark_coding"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "ARK_API_KEY",
    protocol: "chat-completions",
    responseFormat: "json-schema",
    remote: true,
  };
  before.employees.roles.developer.brain.provider = "company.ark_coding";
  const after = structuredClone(before);
  after.brainProviders["company.ark_coding"].responseFormat = "json-object";

  const impact = configurationDocumentImpact(before, after);

  assert.deepEqual(impact.security_tightening, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
});

test("impact classifies security tightening and authority expansion directionally", () => {
  const permitted = document();
  permitted.employees.roles.developer.brain.remoteData.code = true;
  permitted.employees.roles.developer.permissions.allowedIntents.push(
    "orchestrate",
  );

  const tightened = configurationDocumentImpact(permitted, document());
  assert.deepEqual(tightened.authority_expansion, []);
  assert.deepEqual(tightened.security_tightening, [
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.permissions.allowedIntents",
  ]);

  const expanded = configurationDocumentImpact(document(), permitted);
  assert.deepEqual(expanded.security_tightening, []);
  assert.deepEqual(expanded.authority_expansion, [
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.permissions.allowedIntents",
  ]);
  assertDeepFrozen(expanded);
});

test("impact treats provider identity and repository scope changes as authority changes", () => {
  const expandedDocument = document();
  expandedDocument.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    timeoutMs: 60_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
    remote: true,
  };
  expandedDocument.employees.roles.developer.brain.provider = "remote-smart";
  expandedDocument.trackedRepositories.push("acme/new-product");

  const expanded = configurationDocumentImpact(document(), expandedDocument);
  assert.deepEqual(expanded.security_tightening, [
    "employees.roles.developer.brain.provider",
  ]);
  assert.deepEqual(expanded.authority_expansion, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);
  assert.deepEqual(expanded.restart_required, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);

  const tightened = configurationDocumentImpact(expandedDocument, document());
  assert.deepEqual(tightened.security_tightening, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);
  assert.deepEqual(tightened.authority_expansion, [
    "employees.roles.developer.brain.provider",
  ]);
});

test("task brain authority changes invalidate precisely and require runtime restart", () => {
  const configured = document();
  configured.employees.roles.developer.taskBrain = {
    provider: "ollama",
    model: "qwen3.5:task",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const addition = configurationDocumentImpact(document(), configured);
  assert.deepEqual(addition.security_tightening, []);
  assert.deepEqual(addition.authority_expansion, [
    "employees.roles.developer.taskBrain",
  ]);
  assert.deepEqual(addition.restart_required, [
    "employees.roles.developer.taskBrain",
  ]);

  const changedModel = structuredClone(configured);
  changedModel.employees.roles.developer.taskBrain.model = "qwen3.5:task-v2";
  const replacement = configurationDocumentImpact(configured, changedModel);
  const modelPath = "employees.roles.developer.taskBrain.model";
  assert.deepEqual(replacement.security_tightening, []);
  assert.deepEqual(replacement.authority_expansion, []);
  assert.deepEqual(replacement.benign_claim_change, [modelPath]);
  assert.deepEqual(replacement.restart_required, [modelPath]);

  const expandedData = structuredClone(configured);
  expandedData.employees.roles.developer.taskBrain.remoteData.code = true;
  const dataExpansion = configurationDocumentImpact(configured, expandedData);
  const dataPath = "employees.roles.developer.taskBrain.remoteData.code";
  assert.deepEqual(dataExpansion.security_tightening, []);
  assert.deepEqual(dataExpansion.authority_expansion, [dataPath]);
  assert.deepEqual(dataExpansion.restart_required, [dataPath]);

  const removed = configurationDocumentImpact(configured, document());
  assert.deepEqual(removed.security_tightening, [
    "employees.roles.developer.taskBrain",
  ]);
  assert.deepEqual(removed.authority_expansion, []);
  assert.deepEqual(removed.restart_required, [
    "employees.roles.developer.taskBrain",
  ]);
});

test("conflict preparation changes invalidate authority and restart classifications precisely", () => {
  const enabled = conflictPreparationDocument();
  const activation = configurationDocumentImpact(document(), enabled);

  assert.equal(
    activation.authority_expansion.includes(
      "codeExecutor.conflictPreparation",
    ),
    true,
  );
  assert.equal(
    activation.restart_required.includes("codeExecutor.conflictPreparation"),
    true,
  );
  assert.equal(
    activation.restart_required.includes("codeExecutor.gitCommand"),
    true,
  );

  const changedMirror = structuredClone(enabled);
  changedMirror.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "acme/command-center"
  ] = mirrorPath("replacement-base");
  const replacement = configurationDocumentImpact(enabled, changedMirror);
  const changedPath =
    "codeExecutor.conflictPreparation.baseMirrorsByRepository.acme/command-center";
  assert.equal(replacement.security_tightening.includes(changedPath), true);
  assert.equal(replacement.authority_expansion.includes(changedPath), true);
  assert.equal(replacement.restart_required.includes(changedPath), true);
});

test("impact separates semantic claim changes while reporting actual restart needs", () => {
  const changed = document();
  changed.port += 1;
  changed.employees.roles.developer.brain.model = "qwen3.5:small";
  changed.employees.roles.developer.mission = "实现已验收需求并报告证据。";

  const impact = configurationDocumentImpact(document(), changed);

  assert.equal(impact.changed, true);
  assert.notEqual(impact.beforeDigest, impact.afterDigest);
  assert.deepEqual(impact.security_tightening, []);
  assert.deepEqual(impact.authority_expansion, []);
  assert.deepEqual(impact.benign_claim_change, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
  ]);
  assert.deepEqual(impact.restart_required, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
    "port",
  ]);
});

test("every changed path is reported as restart-required while runtime composition is immutable", () => {
  const changed = document();
  changed.refreshMinutes += 1;
  changed.employees.roles.developer.brain.model = "qwen3.5:replacement";
  changed.employees.roles.developer.mission = "Use the replacement mission.";
  changed.employees.roles.developer.brain.remoteData.code = true;

  const impact = configurationDocumentImpact(document(), changed);

  assert.deepEqual(impact.restart_required, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.mission",
    "refreshMinutes",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "employees.roles.developer.brain.remoteData.code",
  ]);
  assert.deepEqual(impact.benign_claim_change, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
    "refreshMinutes",
  ]);
});

test("identical documents have no impact and expose immutable empty classifications", () => {
  const impact = configurationDocumentImpact(document(), reverseObjectKeys(document()));

  assert.equal(impact.changed, false);
  assert.equal(impact.beforeDigest, impact.afterDigest);
  assert.deepEqual(impact.security_tightening, []);
  assert.deepEqual(impact.authority_expansion, []);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, []);
  assertDeepFrozen(impact);
});
