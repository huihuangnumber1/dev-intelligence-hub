import {
  configurationCollectionDescriptor,
  configurationFieldDescriptor,
  configurationSlotDescriptor,
  deepFreeze,
} from "./configuration-form-schema.js";
import { validatePullRequestUpdatedWindowFormValue } from "./pull-request-updated-window-form.js";

export { CONFIGURATION_FORM_GROUPS } from "./configuration-form-schema.js";

const FORM_STATE_SCHEMA_VERSION = 2;
const BUILT_FORM_STATES = new WeakSet();
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SAFE_GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ID_INSENSITIVE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONTROLLED_GIT_REPOSITORY =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const SAFE_CONDITION_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_VALUE =
  /(?:^|\s)(?:bearer\s+|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const URL_USERINFO = /:\/\/[^/@\s:]+:[^/@\s]+@/;
const WINDOWS_GIT_WRAPPER = /\/(?:cmd|bin)\/git\.exe$/i;
const WINDOWS_GIT_IMPLEMENTATION = /\/mingw(?:32|64)\/bin\/git\.exe$/i;
const EDIT_KINDS = new Set(["text", "integer", "number", "boolean", "scalar"]);
const ENTITY_KINDS = new Set(["provider", "role", "workspace", "profile"]);
const STRUCTURE_OPERATIONS = new Set(["add", "remove", "replace"]);
const CONDITION_OPERATORS = new Set([
  "all",
  "any",
  "not",
  "equals",
  "oneOf",
  "hasAny",
  "hasAll",
  "globAny",
  "globAll",
  "atLeast",
]);

export const CONFIGURATION_FORM_LIMITS = deepFreeze({
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

export class ConfigurationFormError extends Error {
  constructor(code, message, { path = "configuration" } = {}) {
    super(message);
    this.name = "ConfigurationFormError";
    this.code = code;
    this.path = path;
  }
}

function formError(code, message, path) {
  return new ConfigurationFormError(code, message, { path });
}

function cloneContext() {
  return {
    ancestors: new Set(),
    seen: new WeakSet(),
    nodes: 0,
    bytes: 0,
  };
}

function consumeCloneBudget(context, path, { nodes = 0, bytes = 0 } = {}) {
  context.nodes += nodes;
  context.bytes += bytes;
  if (
    context.nodes > CONFIGURATION_FORM_LIMITS.maxCloneNodes ||
    context.bytes > CONFIGURATION_FORM_LIMITS.maxDocumentBytes
  ) {
    throw formError("FORM_LIMIT_EXCEEDED", `${path} exceeds form clone limit`, path);
  }
}

function jsonBytes(value) {
  return byteLength(JSON.stringify(value));
}

function cloneSafeData(value, path, context, depth) {
  if (depth > CONFIGURATION_FORM_LIMITS.maxDepth) {
    throw formError("FORM_LIMIT_EXCEEDED", "configuration depth exceeds form limit", path);
  }
  if (value === null || typeof value === "boolean") {
    consumeCloneBudget(context, path, { nodes: 1, bytes: jsonBytes(value) });
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw formError("INVALID_FORM_DATA", `${path} must contain a finite number`, path);
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    consumeCloneBudget(context, path, { nodes: 1, bytes: jsonBytes(normalized) });
    return normalized;
  }
  if (typeof value === "string") {
    if (byteLength(value) > CONFIGURATION_FORM_LIMITS.maxTextBytes) {
      throw formError("FORM_LIMIT_EXCEEDED", `${path} text exceeds form limit`, path);
    }
    consumeCloneBudget(context, path, { nodes: 1, bytes: jsonBytes(value) });
    return value;
  }
  if (typeof value !== "object") {
    throw formError("INVALID_FORM_DATA", `${path} contains unsupported data`, path);
  }
  if (context.ancestors.has(value)) {
    throw formError("INVALID_FORM_DATA", `${path} contains a cycle`, path);
  }
  if (context.seen.has(value)) {
    throw formError("INVALID_FORM_DATA", `${path} contains a shared object reference`, path);
  }
  context.seen.add(value);
  context.ancestors.add(value);
  consumeCloneBudget(context, path, { nodes: 1, bytes: 2 });
  try {
    if (Array.isArray(value)) return cloneSafeArray(value, path, context, depth);
    return cloneSafeObject(value, path, context, depth);
  } finally {
    context.ancestors.delete(value);
  }
}

function cloneSafeArray(value, path, context, depth) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw formError("INVALID_FORM_DATA", `${path} must be a plain dense array`, path);
  }
  if (value.length > CONFIGURATION_FORM_LIMITS.maxArrayItems) {
    throw formError("FORM_LIMIT_EXCEEDED", `${path} array exceeds form limit`, path);
  }
  const keys = Reflect.ownKeys(value);
  const keySet = new Set(keys);
  if (
    keys.length !== value.length + 1 ||
    !keySet.has("length") ||
    Array.from({ length: value.length }, (_, index) => `${index}`).some(
      (key) => !keySet.has(key),
    )
  ) {
    throw formError("INVALID_FORM_DATA", `${path} must be a plain dense array`, path);
  }
  const clone = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) consumeCloneBudget(context, path, { bytes: 1 });
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw formError("INVALID_FORM_DATA", `${path} must contain data properties`, path);
    }
    clone.push(
      cloneSafeData(descriptor.value, `${path}[${index}]`, context, depth + 1),
    );
  }
  return clone;
}

function cloneSafeObject(value, path, context, depth) {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw formError("INVALID_FORM_DATA", `${path} must be a plain object`, path);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > CONFIGURATION_FORM_LIMITS.maxObjectFields) {
    throw formError("FORM_LIMIT_EXCEEDED", `${path} object exceeds form limit`, path);
  }
  const clone = {};
  for (const [index, key] of keys.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw formError("INVALID_FORM_DATA", `${path} contains a dangerous key`, path);
    }
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw formError("INVALID_FORM_DATA", `${path} must contain data properties`, path);
    }
    consumeCloneBudget(context, path, {
      bytes: jsonBytes(key) + 1 + (index > 0 ? 1 : 0),
    });
    clone[key] = cloneSafeData(
      descriptor.value,
      `${path}.${key}`,
      context,
      depth + 1,
    );
  }
  return clone;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function cloneConfiguration(value) {
  const clone = cloneSafeData(value, "configuration", cloneContext(), 0);
  if (byteLength(JSON.stringify(clone)) > CONFIGURATION_FORM_LIMITS.maxDocumentBytes) {
    throw formError(
      "FORM_LIMIT_EXCEEDED",
      "configuration document exceeds form limit",
      "configuration",
    );
  }
  return clone;
}

function requireRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw formError("UNSUPPORTED_CONFIGURATION_SCHEMA", `${path} must be an object`, path);
  }
  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw formError("UNSUPPORTED_CONFIGURATION_SCHEMA", `${path} must be an array`, path);
  }
  return value;
}

function assertFields(value, path, allowed, required = []) {
  requireRecord(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw formError(
        "UNSUPPORTED_CONFIGURATION_SCHEMA",
        `unsupported configuration field ${path}.${key}`,
        `${path}.${key}`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw formError(
        "UNSUPPORTED_CONFIGURATION_SCHEMA",
        `unsupported configuration schema: missing ${path}.${key}`,
        `${path}.${key}`,
      );
    }
  }
  return value;
}

function assertNamedMap(value, path, validateEntry) {
  requireRecord(value, path);
  for (const [id, entry] of Object.entries(value)) validateEntry(entry, `${path}.${id}`, id);
}

const LEGACY_BRAIN_FIELDS = [
  "enabled",
  "provider",
  "model",
  "baseUrl",
  "timeoutMs",
  "numCtx",
  "contextTokens",
  "maxAssessmentsPerRefresh",
  "primaryBrain",
  "allowRemoteDingTalkSummary",
];
const CLI_PROVIDER_KINDS = new Set(["codex-cli", "claude-cli"]);
const CLI_PROVIDER_FORBIDDEN_FIELDS = [
  "baseUrl",
  "apiKeyEnv",
  "protocol",
  "responseFormat",
  "contextTokens",
];
function assertLegacyBrain(value, path, { partial = false } = {}) {
  const globalBrain = path === "configuration.brain";
  assertFields(
    value,
    path,
    globalBrain ? LEGACY_BRAIN_FIELDS : LEGACY_BRAIN_FIELDS.filter((name) => !["primaryBrain", "allowRemoteDingTalkSummary"].includes(name)),
    partial ? [] : ["enabled", "provider", "model", "baseUrl"],
  );
  if (globalBrain) {
    if (Object.hasOwn(value, "allowRemoteDingTalkSummary") && typeof value.allowRemoteDingTalkSummary !== "boolean") throw new TypeError(`${path}.allowRemoteDingTalkSummary must be boolean`);
    if (value.primaryBrain) assertAssignedBrain(value.primaryBrain, `${path}.primaryBrain`, { allowDingTalk: true });
  }
}

function assertAssignedBrain(value, path, { allowDingTalk = false } = {}) {
  assertFields(value, path, ["provider", "model", "reasoningEffort", "remoteData"], [
    "provider",
    "model",
    "remoteData",
  ]);
  const remoteFields = allowDingTalk ? ["requirements", "code", "memory", "dingtalk"] : ["requirements", "code", "memory"];
  assertFields(
    value.remoteData,
    `${path}.remoteData`,
    remoteFields,
    ["requirements", "code", "memory"],
  );
}

function assertProvider(value, path) {
  assertFields(
    value,
    path,
    [
      "kind",
      "baseUrl",
      "apiKeyEnv",
      "credentialMode",
      "maxConcurrentTurns",
      "protocol",
      "responseFormat",
      "timeoutMs",
      "maxResponseBytes",
      "maxRequestBytes",
      "contextTokens",
      "remote",
    ],
    ["kind"],
  );
  if (
    !["ollama", "openai-compatible", ...CLI_PROVIDER_KINDS].includes(
      value.kind,
    )
  ) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `unsupported brain provider kind ${value.kind}`,
      `${path}.kind`,
    );
  }
  if (CLI_PROVIDER_KINDS.has(value.kind)) {
    if (value.remote !== true) {
      throw formError(
        "UNSUPPORTED_CONFIGURATION_SCHEMA",
        `${path}.remote must explicitly classify CLI model processing as remote`,
        `${path}.remote`,
      );
    }
    const forbidden = CLI_PROVIDER_FORBIDDEN_FIELDS.find((name) =>
      Object.hasOwn(value, name),
    );
    if (forbidden) {
      throw formError(
        "UNSUPPORTED_CONFIGURATION_SCHEMA",
        `${path}.${forbidden} is unavailable for supervised CLI providers`,
        `${path}.${forbidden}`,
      );
    }
  }
  const isCli = CLI_PROVIDER_KINDS.has(value.kind);
  const credentialMode = value.credentialMode ?? "api-key";
  const invalidCredentialMode =
    !["api-key", "codex-login", "codex-native-login"].includes(credentialMode) ||
    (value.kind === "claude-cli" && credentialMode !== "api-key") ||
    (!isCli && Object.hasOwn(value, "credentialMode"));
  if (invalidCredentialMode) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `${path}.credentialMode is unavailable for this provider`,
      `${path}.credentialMode`,
    );
  }
  if (Object.hasOwn(value, "maxConcurrentTurns") &&
      (value.kind !== "codex-cli" || credentialMode !== "codex-native-login")) {
    throw formError("UNSUPPORTED_CONFIGURATION_SCHEMA", "并发容量仅用于原生 Codex 登录", `${path}.maxConcurrentTurns`);
  }
  if (isCli) return;
  const required = ["baseUrl"];
  if (required.some((name) => !Object.hasOwn(value, name))) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `unsupported configuration schema: incomplete provider ${path}`,
      path,
    );
  }
}

function assertRole(value, path) {
  assertFields(
    value,
    path,
    [
      "name",
      "mission",
      "enabled",
      "scheduleMinutes",
      "initialPaused",
      "workerId",
      "permissions",
      "brain",
      "taskBrain",
    ],
    [
      "name",
      "mission",
      "enabled",
      "scheduleMinutes",
      "initialPaused",
      "permissions",
      "brain",
    ],
  );
  assertFields(value.permissions, `${path}.permissions`, ["allowedIntents"], [
    "allowedIntents",
  ]);
  requireArray(value.permissions.allowedIntents, `${path}.permissions.allowedIntents`);
  assertAssignedBrain(value.brain, `${path}.brain`);
  if (Object.hasOwn(value, "taskBrain")) {
    assertAssignedBrain(value.taskBrain, `${path}.taskBrain`);
  }
}

function assertEmployees(value, path) {
  assertFields(value, path, ["prReviewer", "roles"], ["prReviewer", "roles"]);
  const reviewerPath = `${path}.prReviewer`;
  assertFields(
    value.prReviewer,
    reviewerPath,
    [
      "enabled",
      "name",
      "initialPaused",
      "policyVersion",
      "tickMinutes",
      "maxJobsPerTick",
      "maxAttempts",
      "retryMinutes",
      "maxPatchCharacters",
      "memoryLimit",
      "memoryOutboxLimit",
      "jobLimit",
      "allowRemoteCodeContext",
      "brain",
      "primaryBrain",
    ],
    [
      "enabled",
      "name",
      "initialPaused",
      "policyVersion",
      "tickMinutes",
      "maxJobsPerTick",
      "maxAttempts",
      "retryMinutes",
      "maxPatchCharacters",
      "memoryLimit",
      "memoryOutboxLimit",
      "jobLimit",
      "allowRemoteCodeContext",
      "brain",
    ],
  );
  requireArray(value.prReviewer.retryMinutes, `${reviewerPath}.retryMinutes`);
  assertLegacyBrain(value.prReviewer.brain, `${reviewerPath}.brain`, { partial: true });
  if (value.prReviewer.primaryBrain) assertAssignedBrain(value.prReviewer.primaryBrain, `${reviewerPath}.primaryBrain`);
  assertNamedMap(value.roles, `${path}.roles`, assertRole);
}

function assertCodeExecutor(value, path) {
  assertFields(value, path, [
    "enabled",
    "docker",
    "workspaces",
    "profiles",
    "requiredProfilesByWorkspace",
    "brokerLimits",
    "executorLimits",
    "maxArtifactBytes",
    "gitCommand",
    "gitTimeoutMs",
    "conflictPreparation",
  ], ["enabled"]);
  if (value.conflictPreparation) {
    const conflictPath = `${path}.conflictPreparation`;
    const allowed = [
      "enabled",
      "baseMirrorsByRepository",
      "headMirrorsByRepository",
    ];
    assertFields(
      value.conflictPreparation,
      conflictPath,
      value.conflictPreparation.enabled === false ? ["enabled"] : allowed,
      value.conflictPreparation.enabled === false ? ["enabled"] : allowed,
    );
    if (value.conflictPreparation.enabled !== false) {
      for (const name of [
        "baseMirrorsByRepository",
        "headMirrorsByRepository",
      ]) {
        assertNamedMap(
          value.conflictPreparation[name],
          `${conflictPath}.${name}`,
          () => {},
        );
      }
    }
  }
  if (value.docker) {
    assertFields(value.docker, `${path}.docker`, ["executable", "host"], [
      "executable",
      "host",
    ]);
  }
  if (value.workspaces) {
    requireArray(value.workspaces, `${path}.workspaces`);
    value.workspaces.forEach((workspace, index) =>
      assertFields(
        workspace,
        `${path}.workspaces[${index}]`,
        ["id", "sourceRoot", "gitHeadSnapshot", "writablePaths", "excludePaths"],
        ["id", "sourceRoot"],
      ),
    );
    for (const [index, workspace] of value.workspaces.entries()) {
      if (workspace.writablePaths) {
        requireArray(workspace.writablePaths, `${path}.workspaces[${index}].writablePaths`);
      }
      if (workspace.excludePaths) {
        requireArray(workspace.excludePaths, `${path}.workspaces[${index}].excludePaths`);
      }
    }
  }
  if (value.profiles) {
    assertNamedMap(value.profiles, `${path}.profiles`, (profile, profilePath) => {
      const isScript = profile.kind === "node-script";
      const isWindows = ["windows-test", "windows-build"].includes(profile.kind);
      const fields = ["kind", "timeoutMs", ...(isWindows ? ["nodeExecutable", "nodeSha256"] : ["image"]), ...(isScript || isWindows ? ["asset"] : [])];
      assertFields(
        profile,
        profilePath,
        [...fields, ...(isWindows ? ["resources"] : [])],
        fields,
      );
      if (!["node-test", "node-script", "windows-test", "windows-build"].includes(profile.kind)) {
        throw formError(
          "UNSUPPORTED_CONFIGURATION_SCHEMA",
          `unsupported execution profile kind ${profile.kind}`,
          `${profilePath}.kind`,
        );
      }
      if (isScript || isWindows) {
        assertFields(
          profile.asset,
          `${profilePath}.asset`,
          ["schemaVersion", "title", "description", "version", "source"],
          ["schemaVersion", "title", "description", "version", "source"],
        );
      }
      if (isWindows && Object.hasOwn(profile, "resources")) {
        requireArray(profile.resources, `${profilePath}.resources`);
        profile.resources.forEach((resource, index) =>
          assertFields(
            resource,
            `${profilePath}.resources[${index}]`,
            ["name", "sourcePath", "sha256", "kind"],
            ["name", "sourcePath", "sha256", "kind"],
          ),
        );
      }
    });
  }
  if (value.requiredProfilesByWorkspace) {
    assertNamedMap(
      value.requiredProfilesByWorkspace,
      `${path}.requiredProfilesByWorkspace`,
      (profiles, profilesPath) => requireArray(profiles, profilesPath),
    );
  }
  if (value.brokerLimits) {
    assertFields(value.brokerLimits, `${path}.brokerLimits`, [
      "maxFiles",
      "maxDirectories",
      "maxFileBytes",
      "maxTotalBytes",
      "maxSearchMatches",
      "maxWriteBytes",
    ]);
  }
  if (value.executorLimits) {
    assertFields(value.executorLimits, `${path}.executorLimits`, [
      "maxSessions",
      "maxActionsPerSession",
    ]);
  }
}

function assertCondition(value, path) {
  requireRecord(value, path);
  if (!CONDITION_OPERATORS.has(value.op)) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `unsupported routing condition operator ${value.op}`,
      `${path}.op`,
    );
  }
  if (["all", "any"].includes(value.op)) {
    assertFields(value, path, ["op", "conditions"], ["op", "conditions"]);
    requireArray(value.conditions, `${path}.conditions`);
    value.conditions.forEach((condition, index) =>
      assertCondition(condition, `${path}.conditions[${index}]`),
    );
    return;
  }
  if (value.op === "not") {
    assertFields(value, path, ["op", "condition"], ["op", "condition"]);
    assertCondition(value.condition, `${path}.condition`);
    return;
  }
  if (["equals", "atLeast"].includes(value.op)) {
    assertFields(value, path, ["op", "path", "value"], ["op", "path", "value"]);
    return;
  }
  if (["oneOf", "hasAny", "hasAll"].includes(value.op)) {
    assertFields(value, path, ["op", "path", "values"], ["op", "path", "values"]);
    requireArray(value.values, `${path}.values`);
    return;
  }
  assertFields(value, path, ["op", "path", "patterns"], ["op", "path", "patterns"]);
  requireArray(value.patterns, `${path}.patterns`);
}

function assertWorkflowRouting(value, path) {
  assertFields(value, path, ["schemaVersion", "enabled", "maxHops", "rules"], [
    "schemaVersion",
    "enabled",
    "maxHops",
    "rules",
  ]);
  if (value.schemaVersion !== 1) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `unsupported workflow routing schema version ${value.schemaVersion}`,
      `${path}.schemaVersion`,
    );
  }
  requireArray(value.rules, `${path}.rules`);
  value.rules.forEach((rule, index) => {
    const rulePath = `${path}.rules[${index}]`;
    assertFields(
      rule,
      rulePath,
      ["id", "source", "enabled", "priority", "fallback", "condition", "targets", "onMatch"],
      ["id", "source", "enabled", "priority", "fallback", "condition", "targets", "onMatch"],
    );
    if (rule.condition !== null) assertCondition(rule.condition, `${rulePath}.condition`);
    requireArray(rule.targets, `${rulePath}.targets`);
    rule.targets.forEach((target, targetIndex) =>
      assertFields(
        target,
        `${rulePath}.targets[${targetIndex}]`,
        ["type", "id"],
        ["type", "id"],
      ),
    );
  });
}

function assertWorkCoordination(value, path) {
  const numericFields = [
    "tickSeconds",
    "intakeLimit",
    "workLimit",
    "dispatchLimit",
    "attentionLimit",
    "proposalLimit",
    "conditionLimit",
    "codeJobLimit",
    "codeJobMemoryLimit",
    "leaseDurationMs",
    "resolveTimeoutMs",
    "decisionTimeoutMs",
    "maxAttempts",
    "retryBaseMs",
    "retryMaxMs",
    "factMaximumAgeMs",
    "codeJobMaximumTurns",
    "codeJobObservationLimit",
  ];
  assertFields(value, path, ["enabled", ...numericFields, "policy"], ["enabled", "policy"]);
  const policyPath = `${path}.policy`;
  assertFields(
    value.policy,
    policyPath,
    [
      "version",
      "capabilityRoles",
      "githubReviewRoles",
      "codeActionRoles",
      "configurationChangeRoles",
      "codeOperationsByRole",
      "reviewOwnersByProduct",
      "testingOwnersByProduct",
      "workspaceByRepository",
    ],
    [
      "version",
      "capabilityRoles",
      "githubReviewRoles",
      "codeActionRoles",
      "codeOperationsByRole",
      "workspaceByRepository",
    ],
  );
  for (const name of ["capabilityRoles", "codeOperationsByRole", "workspaceByRepository"]) {
    requireRecord(value.policy[name], `${policyPath}.${name}`);
  }
  if (Object.hasOwn(value.policy, "testingOwnersByProduct")) {
    requireRecord(
      value.policy.testingOwnersByProduct,
      `${policyPath}.testingOwnersByProduct`,
    );
    for (const [product, owners] of Object.entries(value.policy.testingOwnersByProduct)) {
      requireArray(owners, `${policyPath}.testingOwnersByProduct.${product}`);
    }
  }
  if (Object.hasOwn(value.policy, "reviewOwnersByProduct")) {
    requireRecord(
      value.policy.reviewOwnersByProduct,
      `${policyPath}.reviewOwnersByProduct`,
    );
    for (const [product, owners] of Object.entries(value.policy.reviewOwnersByProduct)) {
      requireArray(owners, `${policyPath}.reviewOwnersByProduct.${product}`);
    }
  }
  requireArray(value.policy.githubReviewRoles, `${policyPath}.githubReviewRoles`);
  requireArray(value.policy.codeActionRoles, `${policyPath}.codeActionRoles`);
  if (Object.hasOwn(value.policy, "configurationChangeRoles")) {
    requireArray(
      value.policy.configurationChangeRoles,
      `${policyPath}.configurationChangeRoles`,
    );
  }
  for (const [roleId, operations] of Object.entries(value.policy.codeOperationsByRole)) {
    requireArray(operations, `${policyPath}.codeOperationsByRole.${roleId}`);
  }
}

function assertMemory(value, path) {
  assertFields(value, path, ["enabled", "maximumRecords", "maximumStateBytes", "imports", "answering"], [
    "enabled",
  ]);
  if (value.imports) {
    assertFields(value.imports, `${path}.imports`, ["localSessions", "git"], [
      "localSessions",
      "git",
    ]);
  }
  if (value.answering) {
    const answeringPath = `${path}.answering`;
    assertFields(
      value.answering,
      answeringPath,
      [
        "enabled",
        "maximumRecords",
        "maximumContextBytes",
        "maximumConcurrent",
        "brain",
        "localBrain",
      ],
      ["enabled"],
    );
    if (value.answering.brain) assertAssignedBrain(value.answering.brain, `${answeringPath}.brain`);
    if (value.answering.localBrain) {
      assertAssignedBrain(value.answering.localBrain, `${answeringPath}.localBrain`);
    }
  }
}

function assertSupportedConfigurationShape(value) {
  const topLevelFields = [
    "port",
    "refreshMinutes",
    "browserPollSeconds",
    "githubLogin",
    "githubRead",
    "trackedRepositories",
    "prResponsibility",
    "codeExecutor",
    "changePackages",
    "githubActions",
    "workflowRouting",
    "workCoordination",
    "memory",
    "brain",
    "brainProviders",
    "employees",
    "dingtalk",
  ];
  assertFields(value, "configuration", topLevelFields, topLevelFields);
  requireArray(value.trackedRepositories, "configuration.trackedRepositories");
  assertFields(
    value.githubRead,
    "configuration.githubRead",
    ["enabled", "pullRequestUpdatedWindow", "issueActiveWindowDays"],
    ["enabled"],
  );
  if (Object.hasOwn(value.githubRead, "pullRequestUpdatedWindow")) {
    try {
      validatePullRequestUpdatedWindowFormValue(
        value.githubRead.pullRequestUpdatedWindow,
      );
    } catch (error) {
      throw formError(
        "UNSUPPORTED_CONFIGURATION_SCHEMA",
        error.message,
        "configuration.githubRead.pullRequestUpdatedWindow",
      );
    }
  }
  assertFields(
    value.prResponsibility,
    "configuration.prResponsibility",
    ["historicalAfterDays"],
    ["historicalAfterDays"],
  );
  assertCodeExecutor(value.codeExecutor, "configuration.codeExecutor");
  assertFields(
    value.changePackages,
    "configuration.changePackages",
    ["enabled", "gitCommand", "gitTimeoutMs"],
    ["enabled"],
  );
  assertFields(
    value.githubActions,
    "configuration.githubActions",
    ["enabled", "credentialMode", "actorAccountId", "tokenEnv", "ghCommand", "networkEnv", "timeoutMs", "enabledActions", "automaticReview", "assignAfterAutomaticReview", "automaticOwnPrRepair"],
    ["enabled"],
  );
  if (Object.hasOwn(value.githubActions, "enabledActions")) {
    requireArray(
      value.githubActions.enabledActions,
      "configuration.githubActions.enabledActions",
    );
  }
  if (value.githubActions.networkEnv) {
    assertFields(value.githubActions.networkEnv, "configuration.githubActions.networkEnv", [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]);
  }
  assertWorkflowRouting(value.workflowRouting, "configuration.workflowRouting");
  assertWorkCoordination(value.workCoordination, "configuration.workCoordination");
  assertMemory(value.memory, "configuration.memory");
  assertLegacyBrain(value.brain, "configuration.brain");
  assertNamedMap(value.brainProviders, "configuration.brainProviders", assertProvider);
  assertEmployees(value.employees, "configuration.employees");
  assertFields(
    value.dingtalk,
    "configuration.dingtalk",
    ["enabled", "selfUserId", "notifyMinimumScore", "maxNotificationsPerRun", "mailEnabled"],
    ["enabled", "selfUserId", "notifyMinimumScore", "maxNotificationsPerRun"],
  );
}

function configurationForForm(value) {
  const document = cloneConfiguration(value);
  // Persisted pre-boundary documents omit this field. The runtime interprets
  // omission as enabled; the form makes that effective value explicit without
  // rewriting the durable content-addressed history during reads.
  if (!Object.hasOwn(document, "githubRead")) {
    document.githubRead = { enabled: true };
  }
  return document;
}

function envReferencePaths(configuration) {
  const paths = [];
  for (const [providerId, provider] of Object.entries(configuration.brainProviders)) {
    if (Object.hasOwn(provider, "apiKeyEnv")) {
      paths.push(["brainProviders", providerId, "apiKeyEnv"]);
    }
  }
  if (Object.hasOwn(configuration.githubActions, "tokenEnv")) {
    paths.push(["githubActions", "tokenEnv"]);
  }
  return paths;
}

function pathText(path) {
  return path.map((segment) => `${segment}`).join(".");
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      DANGEROUS_KEYS.has(`${segment}`) ||
      !Object.hasOwn(current, segment)
    ) {
      throw formError("UNKNOWN_FORM_FIELD", `unknown configuration field ${pathText(path)}`, pathText(path));
    }
    current = current[segment];
  }
  return current;
}

function visitPrimitiveFields(value, path, visitor) {
  if (value === null || typeof value !== "object") {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitPrimitiveFields(entry, [...path, index], visitor),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    visitPrimitiveFields(entry, [...path, key], visitor);
  }
}

function validEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    return false;
  }
  const host = endpoint.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  return loopback || endpoint.protocol === "https:";
}

function validWorkspacePath(value) {
  if (!value || /^[\\/]/.test(value) || /^[a-z]:/i.test(value)) return false;
  return value
    .replaceAll("\\", "/")
    .split("/")
    .every(
      (segment) =>
        segment &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes(":") &&
        !/[. ]$/.test(segment) &&
        !WINDOWS_DEVICE_NAME.test(segment),
    );
}

function validAbsoluteLocalPath(value) {
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("//") &&
    (/^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("/"))
  );
}

function validWindowsAbsolutePath(value) {
  return (
    /^[A-Za-z]:[\\/]/u.test(value) &&
    !value.slice(2).includes(":") &&
    !/["\p{Cc}]/u.test(value)
  );
}

function validControlledGitRepository(value) {
  const match = value.match(CONTROLLED_GIT_REPOSITORY);
  if (!match) return false;
  const [, owner, repository] = match;
  return (
    !owner.includes("--") &&
    !repository.includes("..") &&
    !repository.startsWith(".") &&
    !repository.endsWith(".")
  );
}

function validConditionPath(value) {
  return (
    byteLength(value) <= 512 &&
    value.split(".").length <= 16 &&
    value
      .split(".")
      .every(
        (segment) =>
          SAFE_CONDITION_PATH_SEGMENT.test(segment) &&
          !DANGEROUS_KEYS.has(segment),
      )
  );
}

function validFieldFormat(value, format) {
  if (!format) return true;
  if (typeof value !== "string") return false;
  const validators = {
    environment: (entry) => SAFE_ENV_NAME.test(entry),
    "github-login": (entry) => SAFE_GITHUB_LOGIN.test(entry),
    repository: (entry) => SAFE_REPOSITORY.test(entry),
    "controlled-git-repository": validControlledGitRepository,
    "safe-id": (entry) => SAFE_ID.test(entry),
    "profile-id": (entry) => SAFE_PROFILE_ID.test(entry),
    "resource-name": (entry) => SAFE_PROFILE_ID.test(entry),
    sha256: (entry) => /^[a-f0-9]{64}$/u.test(entry),
    "safe-id-insensitive": (entry) => SAFE_ID_INSENSITIVE.test(entry),
    "role-id": (entry) => SAFE_ROLE_ID.test(entry),
    "workspace-id": (entry) => SAFE_WORKSPACE_ID.test(entry),
    "pinned-image": (entry) => PINNED_IMAGE.test(entry),
    endpoint: validEndpoint,
    "docker-host": (entry) => entry.startsWith("npipe://") || entry.startsWith("unix://"),
    "condition-path": validConditionPath,
    "workspace-path": validWorkspacePath,
    "absolute-local-path": validAbsoluteLocalPath,
    "windows-absolute-path": validWindowsAbsolutePath,
  };
  return validators[format]?.(value) ?? false;
}

function descriptorAcceptsValue(descriptor, value, configuration) {
  if (descriptor.kind === "integer" && !Number.isSafeInteger(value)) return false;
  if (descriptor.kind === "number" && !Number.isFinite(value)) return false;
  if (descriptor.kind === "boolean" && typeof value !== "boolean") return false;
  if (descriptor.kind === "text" && typeof value !== "string") return false;
  if (
    descriptor.kind === "scalar" &&
    !(
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
  ) {
    return false;
  }
  if (
    typeof value === "number" &&
    ((descriptor.minimum !== undefined && value < descriptor.minimum) ||
      (descriptor.maximum !== undefined && value > descriptor.maximum))
  ) {
    return false;
  }
  if (
    descriptor.options &&
    !descriptor.options.some((option) => Object.is(option, value))
  ) {
    return false;
  }
  if (typeof value === "string") {
    const actorMayBeEmpty =
      descriptor.path.join(".") === "githubActions.actorAccountId" &&
      configuration.githubActions.enabled === false;
    if (
      (!actorMayBeEmpty && descriptor.kind === "text" && !value.trim()) ||
      byteLength(value) >
        (descriptor.maximumBytes ?? CONFIGURATION_FORM_LIMITS.maxTextBytes) ||
      INVALID_TEXT_CONTROL.test(value) ||
      SECRET_VALUE.test(value) ||
      URL_USERINFO.test(value) ||
      !validFieldFormat(value, descriptor.format)
    ) {
      return false;
    }
  }
  return true;
}

function editableScalarIssues(configuration) {
  const issues = [];
  visitPrimitiveFields(configuration, [], (value, path) => {
    const providerKind =
      path[0] === "brainProviders" && path.length >= 3
        ? configuration.brainProviders[path[1]]?.kind
        : null;
    const descriptor = configurationFieldDescriptor(
      path,
      value,
      providerKind ? { providerKind } : null,
    );
    if (descriptor.format === "environment") return;
    if (descriptorAcceptsValue(descriptor, value, configuration)) return;
    const integer = descriptor.kind === "integer";
    issues.push(
      issue(
        path,
        integer ? "INVALID_CONFIGURATION_INTEGER" : "INVALID_CONFIGURATION_TEXT",
        integer && descriptor.minimum !== undefined
          ? `请输入 ${descriptor.minimum} 到 ${descriptor.maximum} 之间的整数。`
          : "请输入符合配置约束的值。",
      ),
    );
  });
  return issues;
}

function collectionEntryIdentity(entry, strategy) {
  if (strategy === "id") return entry?.id;
  if (strategy === "name") return entry?.name;
  if (strategy === "type-id") return `${entry?.type}:${entry?.id}`;
  if (strategy === "typed-value") return `${typeof entry}:${JSON.stringify(entry)}`;
  return `${typeof entry}:${JSON.stringify(entry)}`;
}

function collectionConfigurationIssues(configuration) {
  const issues = [];
  function visit(value, path) {
    if (value === null || typeof value !== "object") return;
    const descriptor = path.length
      ? configurationCollectionDescriptor(path, value)
      : null;
    if (descriptor) {
      const size = Array.isArray(value) ? value.length : Object.keys(value).length;
      if (
        (descriptor.minimum !== undefined && size < descriptor.minimum) ||
        (descriptor.maximum !== undefined && size > descriptor.maximum)
      ) {
        issues.push(
          issue(path, "INVALID_CONFIGURATION_COLLECTION", "集合条目数量不符合配置约束。"),
        );
      }
      if (descriptor.kind === "array" && descriptor.uniqueBy) {
        const identities = value.map((entry) =>
          collectionEntryIdentity(entry, descriptor.uniqueBy),
        );
        if (new Set(identities).size !== identities.length) {
          issues.push(
            issue(path, "DUPLICATE_CONFIGURATION_ENTRY", "集合中不能包含重复条目。"),
          );
        }
      }
      if (descriptor.kind === "map") {
        const portableKeys = new Set();
        for (const key of Object.keys(value)) {
          if (
            (descriptor.keyOptions && !descriptor.keyOptions.includes(key)) ||
            (descriptor.keyFormat && !validFieldFormat(key, descriptor.keyFormat)) ||
            (pathText(path) === "employees.roles" && key === "pr-reviewer")
          ) {
            issues.push(
              issue([...path, key], "INVALID_CONFIGURATION_KEY", "映射键不符合配置约束。"),
            );
          }
          if (descriptor.keyFormat === "controlled-git-repository") {
            const portableKey = key.toLowerCase();
            if (portableKeys.has(portableKey)) {
              issues.push(
                issue(
                  path,
                  "DUPLICATE_CONFIGURATION_ENTRY",
                  "同一仓库不能以不同大小写重复配置。",
                ),
              );
            }
            portableKeys.add(portableKey);
          }
        }
      }
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key]);
  }
  visit(configuration, []);
  return issues;
}

function referenceIssue(path, label) {
  return issue(path, "UNKNOWN_CONFIGURATION_REFERENCE", `${label}引用了不存在的配置实体。`);
}

function configurationReferenceIssues(configuration) {
  const issues = [];
  const providers = new Set(Object.keys(configuration.brainProviders));
  const roles = new Set(Object.keys(configuration.employees.roles));
  roles.add("pr-reviewer");
  const workspaces = new Set(
    (configuration.codeExecutor.workspaces || []).map(({ id }) => id),
  );
  const profiles = new Set(Object.keys(configuration.codeExecutor.profiles || {}));
  const providerFields = [
    [["brain", "provider"], configuration.brain.provider],
    ...(configuration.employees.prReviewer.primaryBrain ? [[
      ["employees", "prReviewer", "primaryBrain", "provider"], configuration.employees.prReviewer.primaryBrain.provider,
    ]] : []),
    ...Object.entries(configuration.employees.roles).flatMap(([id, role]) => [
      [
        ["employees", "roles", id, "brain", "provider"],
        role.brain.provider,
      ],
      ...(role.taskBrain
        ? [[
            ["employees", "roles", id, "taskBrain", "provider"],
            role.taskBrain.provider,
          ]]
        : []),
    ]),
  ];
  if (Object.hasOwn(configuration.employees.prReviewer.brain, "provider")) {
    providerFields.push([
      ["employees", "prReviewer", "brain", "provider"],
      configuration.employees.prReviewer.brain.provider,
    ]);
  }
  for (const name of ["brain", "localBrain"]) {
    const assigned = configuration.memory.answering?.[name];
    if (assigned) {
      providerFields.push([
        ["memory", "answering", name, "provider"],
        assigned.provider,
      ]);
    }
  }
  for (const [path, provider] of providerFields) {
    if (!providers.has(provider)) issues.push(referenceIssue(path, "Provider "));
  }
  configuration.workflowRouting.rules.forEach((rule, ruleIndex) => {
    rule.targets.forEach((target, targetIndex) => {
      if (target.type === "role" && !roles.has(target.id)) {
        issues.push(
          referenceIssue(
            ["workflowRouting", "rules", ruleIndex, "targets", targetIndex, "id"],
            "岗位 ",
          ),
        );
      }
    });
  });
  const policy = configuration.workCoordination.policy;
  for (const [capability, roleId] of Object.entries(policy.capabilityRoles)) {
    if (!roles.has(roleId)) {
      issues.push(
        referenceIssue(
          ["workCoordination", "policy", "capabilityRoles", capability],
          "岗位 ",
        ),
      );
    }
  }
  for (const list of [
    "githubReviewRoles",
    "codeActionRoles",
    "configurationChangeRoles",
  ]) {
    (policy[list] || []).forEach((roleId, index) => {
      if (!roles.has(roleId)) {
        issues.push(referenceIssue(["workCoordination", "policy", list, index], "岗位 "));
      }
    });
  }
  const codeRoles = new Set(policy.codeActionRoles);
  for (const roleId of Object.keys(policy.codeOperationsByRole)) {
    if (!codeRoles.has(roleId)) {
      issues.push(
        referenceIssue(
          ["workCoordination", "policy", "codeOperationsByRole", roleId],
          "代码动作岗位 ",
        ),
      );
    }
  }
  for (const [repository, workspaceId] of Object.entries(policy.workspaceByRepository)) {
    if (!workspaces.has(workspaceId)) {
      issues.push(
        referenceIssue(
          ["workCoordination", "policy", "workspaceByRepository", repository],
          "工作区 ",
        ),
      );
    }
  }
  for (const [workspaceId, requiredProfiles] of Object.entries(
    configuration.codeExecutor.requiredProfilesByWorkspace || {},
  )) {
    if (!workspaces.has(workspaceId)) {
      issues.push(
        referenceIssue(
          ["codeExecutor", "requiredProfilesByWorkspace", workspaceId],
          "工作区 ",
        ),
      );
    }
    requiredProfiles.forEach((profileId, index) => {
      if (!profiles.has(profileId)) {
        issues.push(
          referenceIssue(
            ["codeExecutor", "requiredProfilesByWorkspace", workspaceId, index],
            "Profile ",
          ),
        );
      }
    });
  }
  return issues;
}

function providerConfigurationIssues(configuration) {
  const issues = [];
  for (const [id, provider] of Object.entries(configuration.brainProviders)) {
    const path = ["brainProviders", id];
    const isCli = CLI_PROVIDER_KINDS.has(provider.kind);
    const hasCredentialReference = Object.hasOwn(provider, "apiKeyEnv");
    const hasProtocol = Object.hasOwn(provider, "protocol");
    const hasResponseFormat = Object.hasOwn(provider, "responseFormat");
    const credentialMode = provider.credentialMode ?? "api-key";
    const invalidCredentialMode =
      !["api-key", "codex-login", "codex-native-login"].includes(credentialMode) ||
      (provider.kind === "claude-cli" && credentialMode !== "api-key") ||
      (!isCli && Object.hasOwn(provider, "credentialMode"));
    if (
      (isCli && provider.remote !== true) ||
      (isCli && CLI_PROVIDER_FORBIDDEN_FIELDS.some((name) => Object.hasOwn(provider, name))) ||
      (!isCli && provider.kind === "openai-compatible" && !hasCredentialReference) ||
      (!isCli && provider.kind === "ollama" && hasCredentialReference) ||
      (!isCli && provider.kind === "openai-compatible" && Object.hasOwn(provider, "contextTokens")) ||
      (!isCli && provider.kind === "ollama" && hasProtocol) ||
      (!isCli && provider.kind === "ollama" && hasResponseFormat) ||
      (!isCli && hasProtocol && !["chat-completions", "responses"].includes(provider.protocol)) ||
      (!isCli && hasResponseFormat && !["json-schema", "json-object"].includes(provider.responseFormat)) ||
      (!isCli && provider.protocol === "responses" && provider.responseFormat === "json-object") ||
      invalidCredentialMode
    ) {
      issues.push(issue(path, "INVALID_PROVIDER_CONFIGURATION", "Provider 字段组合无效。"));
    }
    const limits = !hasProtocol
        ? {
            timeoutMs: [1, 2 * 1024 * 1024],
            maxResponseBytes: [1, 2 * 1024 * 1024],
            maxRequestBytes: [1, 2 * 1024 * 1024],
          }
        : provider.protocol === "responses"
          ? {
              timeoutMs: [1_000, 3_600_000],
              maxResponseBytes: [1_024, 1024 * 1024],
              maxRequestBytes: [1_024, 1024 * 1024],
            }
          : {
              timeoutMs: [10, 120_000],
              maxResponseBytes: [1_024, 1024 * 1024],
              maxRequestBytes: [1_024, 2 * 1024 * 1024],
            };
    for (const [name, [minimum, maximum]] of Object.entries(
      isCli ? {} : limits,
    )) {
      if (
        Object.hasOwn(provider, name) &&
        (
          !Number.isSafeInteger(provider[name]) ||
          provider[name] < minimum ||
          provider[name] > maximum
        )
      ) {
        issues.push(
          issue(
            [...path, name],
            "INVALID_PROVIDER_CONFIGURATION",
            `请输入 ${minimum} 到 ${maximum} 之间的整数。`,
          ),
        );
      }
    }
    if (!isCli && provider.remote === false) {
      try {
        const endpoint = new URL(provider.baseUrl);
        if (
          !["localhost", "::1", "[::1]"].includes(endpoint.hostname.toLowerCase()) &&
          !/^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname)
        ) {
          issues.push(issue([...path, "remote"], "INVALID_PROVIDER_CONFIGURATION", "远程端点不能标记为本地。"));
        }
      } catch {
        // The field-level endpoint issue is more precise.
      }
    }
  }
  return issues;
}

function providerContext(document, path) {
  if (path[0] !== "brainProviders" || path.length < 3) return null;
  const provider = document.brainProviders[path[1]];
  return provider ? { providerKind: provider.kind } : null;
}

function conditionConfigurationIssues(condition, path, context, depth = 1) {
  const issues = [];
  if (condition === null || typeof condition !== "object") return issues;
  context.nodes += 1;
  if (context.nodes > 128 || depth > 8) {
    issues.push(issue(path, "INVALID_ROUTING_CONDITION", "路由条件超过复杂度上限。"));
    return issues;
  }
  if (["all", "any"].includes(condition.op)) {
    for (const [index, child] of condition.conditions.entries()) {
      issues.push(
        ...conditionConfigurationIssues(
          child,
          [...path, "conditions", index],
          context,
          depth + 1,
        ),
      );
    }
  } else if (condition.op === "not") {
    issues.push(
      ...conditionConfigurationIssues(
        condition.condition,
        [...path, "condition"],
        context,
        depth + 1,
      ),
    );
  } else if (condition.op === "atLeast" && typeof condition.value !== "number") {
    issues.push(issue([...path, "value"], "INVALID_ROUTING_CONDITION", "atLeast 需要数字。"));
  } else if (
    ["hasAny", "hasAll"].includes(condition.op) &&
    condition.values.some((value) => typeof value !== "string")
  ) {
    issues.push(issue([...path, "values"], "INVALID_ROUTING_CONDITION", "该操作符只接受文本值。"));
  }
  if (["globAny", "globAll"].includes(condition.op)) {
    context.globBudget.patterns += condition.patterns.length;
    context.globBudget.patternBytes += condition.patterns.reduce(
      (total, pattern) => total + byteLength(pattern),
      0,
    );
    if (
      context.globBudget.patterns > 32 ||
      context.globBudget.patternBytes > 2 * 1_024
    ) {
      issues.push(issue([...path, "patterns"], "INVALID_ROUTING_CONDITION", "Glob 模式超过总预算。"));
    }
  }
  return issues;
}

function workflowGraphIssues(workflowRouting) {
  const issues = [];
  if (byteLength(JSON.stringify(workflowRouting)) > 128 * 1_024) {
    issues.push(issue(["workflowRouting"], "INVALID_ROUTING_GRAPH", "路由配置超过容量上限。"));
  }
  const graph = new Map();
  for (const rule of workflowRouting.rules) {
    if (!graph.has(rule.source)) graph.set(rule.source, new Set());
    for (const target of rule.targets) {
      if (target.type === "node") graph.get(rule.source).add(target.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  function visit(node) {
    if (visiting.has(node)) {
      cycle = true;
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of graph.get(node) || []) visit(child);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
  if (cycle) {
    issues.push(issue(["workflowRouting", "rules"], "INVALID_ROUTING_GRAPH", "路由节点不能形成循环。"));
    return issues;
  }
  const longest = new Map();
  function longestPath(node) {
    if (longest.has(node)) return longest.get(node);
    let length = 0;
    for (const child of graph.get(node) || []) {
      length = Math.max(length, 1 + longestPath(child));
    }
    longest.set(node, length);
    return length;
  }
  if ([...graph.keys()].some((node) => longestPath(node) > workflowRouting.maxHops)) {
    issues.push(issue(["workflowRouting", "maxHops"], "INVALID_ROUTING_GRAPH", "路由链超过最大跳数。"));
  }
  return issues;
}

function configurationRelationshipIssues(configuration) {
  const issues = [
    ...configurationReferenceIssues(configuration),
    ...providerConfigurationIssues(configuration),
    ...workflowGraphIssues(configuration.workflowRouting),
  ];
  const configurationChangeRoles =
    configuration.workCoordination.policy.configurationChangeRoles || [];
  const configuredChangeRoles = new Set(configurationChangeRoles);
  configurationChangeRoles.forEach((roleId, index) => {
    if (roleId === "pr-reviewer") {
      issues.push(
        issue(
          [
            "workCoordination",
            "policy",
            "configurationChangeRoles",
            index,
          ],
          "INVALID_CONFIGURATION_CHANGE_AUTHORITY",
          "配置变更提案只能授权给显式配置的岗位。",
        ),
      );
    }
  });
  for (const [roleId, role] of Object.entries(configuration.employees.roles)) {
    const permitted = role.permissions.allowedIntents.includes(
      "propose_configuration_change",
    );
    if (permitted === configuredChangeRoles.has(roleId)) continue;
    issues.push(
      issue(
        permitted
          ? ["workCoordination", "policy", "configurationChangeRoles"]
          : [
              "employees",
              "roles",
              roleId,
              "permissions",
              "allowedIntents",
            ],
        "MISMATCHED_CONFIGURATION_CHANGE_AUTHORITY",
        "岗位意图权限必须与配置变更提案岗位完全一致。",
      ),
    );
  }
  if (
    configuration.codeExecutor.enabled &&
    ((!configuration.codeExecutor.docker &&
      Object.values(configuration.codeExecutor.profiles || {}).some(
        (profile) => !["windows-test", "windows-build"].includes(profile.kind),
      )) ||
      !configuration.codeExecutor.workspaces?.length ||
      !Object.keys(configuration.codeExecutor.profiles || {}).length ||
      !configuration.codeExecutor.requiredProfilesByWorkspace)
  ) {
    issues.push(issue(["codeExecutor"], "INCOMPLETE_CONFIGURATION", "启用执行器前需完成边界配置。"));
  }
  if (
    configuration.codeExecutor.enabled &&
    (configuration.codeExecutor.workspaces || []).some(
      ({ id }) =>
        !Object.hasOwn(
          configuration.codeExecutor.requiredProfilesByWorkspace || {},
          id,
        ),
    )
  ) {
    issues.push(issue(["codeExecutor", "requiredProfilesByWorkspace"], "INCOMPLETE_CONFIGURATION", "每个工作区都需要 Profile 绑定。"));
  }
  if (
    ((configuration.codeExecutor.workspaces || []).some(
      (workspace) => workspace.gitHeadSnapshot === true,
    ) || configuration.codeExecutor.conflictPreparation?.enabled === true) &&
    !configuration.codeExecutor.gitCommand
  ) {
    issues.push(issue(["codeExecutor", "gitCommand"], "INCOMPLETE_CONFIGURATION", "启用 Git Head 固定快照或冲突准备前需要配置固定 Git 命令。"));
  }
  const gitCommand = configuration.codeExecutor.gitCommand;
  const normalizedGitCommand = typeof gitCommand === "string"
    ? gitCommand.replaceAll("\\", "/")
    : "";
  const gitCommandIsAbsolute =
    /^[A-Za-z]:\//u.test(normalizedGitCommand) ||
    (normalizedGitCommand.startsWith("/") &&
      !normalizedGitCommand.startsWith("//"));
  if (
    ((configuration.codeExecutor.workspaces || []).some(
      (workspace) => workspace.gitHeadSnapshot === true,
    ) || configuration.codeExecutor.conflictPreparation?.enabled === true) &&
    normalizedGitCommand &&
    !gitCommandIsAbsolute
  ) {
    issues.push(issue(
      ["codeExecutor", "gitCommand"],
      "RELATIVE_GIT_COMMAND",
      "Git 命令必须填写本机绝对路径。",
    ));
  }
  if (
    ((configuration.codeExecutor.workspaces || []).some(
      (workspace) => workspace.gitHeadSnapshot === true,
    ) || configuration.codeExecutor.conflictPreparation?.enabled === true) &&
    WINDOWS_GIT_WRAPPER.test(normalizedGitCommand) &&
    !WINDOWS_GIT_IMPLEMENTATION.test(normalizedGitCommand)
  ) {
    issues.push(issue(
      ["codeExecutor", "gitCommand"],
      "UNSAFE_GIT_WRAPPER",
      "Windows Git 需直接选择 mingw64/bin/git.exe，不能使用 cmd/bin 包装器。",
    ));
  }
  if (configuration.changePackages.enabled && !configuration.changePackages.gitCommand) {
    issues.push(issue(["changePackages", "gitCommand"], "INCOMPLETE_CONFIGURATION", "启用后需要固定 Git 命令。"));
  }
  const credentialMode = configuration.githubActions.credentialMode ?? "token-env";
  if (!["gh-login", "token-env"].includes(credentialMode)) {
    issues.push(issue(["githubActions", "credentialMode"], "INVALID_CREDENTIAL_MODE", "请选择受支持的 GitHub 凭据来源。"));
  }
  if (
    configuration.githubActions.enabled &&
    ["actorAccountId", "ghCommand"].some(
      (name) => !Object.hasOwn(configuration.githubActions, name),
    )
  ) {
    issues.push(issue(["githubActions"], "INCOMPLETE_CONFIGURATION", "启用后需要账号和固定 GitHub CLI 命令。"));
  }
  if (
    configuration.githubActions.enabled &&
    credentialMode === "token-env" &&
    !Object.hasOwn(configuration.githubActions, "tokenEnv")
  ) {
    issues.push(issue(["githubActions", "tokenEnv"], "INCOMPLETE_CONFIGURATION", "环境变量 Token 模式需要 Token 环境变量名。"));
  }
  if (
    configuration.memory.answering?.enabled &&
    ["brain", "localBrain"].some(
      (name) => !Object.hasOwn(configuration.memory.answering, name),
    )
  ) {
    issues.push(issue(["memory", "answering"], "INCOMPLETE_CONFIGURATION", "启用后需要回答大脑。"));
  }
  const globBudget = { patterns: 0, patternBytes: 0 };
  configuration.workflowRouting.rules.forEach((rule, index) => {
    if (rule.fallback !== (rule.condition === null)) {
      issues.push(issue(["workflowRouting", "rules", index, "condition"], "INVALID_ROUTING_CONDITION", "兜底状态与条件不一致。"));
    }
    if (rule.condition) {
      issues.push(
        ...conditionConfigurationIssues(
          rule.condition,
          ["workflowRouting", "rules", index, "condition"],
          { nodes: 0, globBudget },
        ),
      );
    }
  });
  return issues;
}

function assertEditableScalarConfiguration(configuration) {
  const [first] = [
    ...editableScalarIssues(configuration),
    ...collectionConfigurationIssues(configuration),
    ...configurationRelationshipIssues(configuration),
  ];
  if (first) {
    throw formError(
      "UNSUPPORTED_CONFIGURATION_SCHEMA",
      `${first.path} does not satisfy the authoritative configuration constraint`,
      first.path,
    );
  }
}

function assertEnvironmentReferences(configuration) {
  for (const path of envReferencePaths(configuration)) {
    const value = valueAtPath(configuration, path);
    if (typeof value !== "string" || !SAFE_ENV_NAME.test(value)) {
      throw formError(
        "INVALID_ENV_REFERENCE",
        `${pathText(path)} must contain an environment variable name`,
        pathText(path),
      );
    }
  }
}

function cloneBinding(value) {
  if (value === null || value === undefined) return null;
  const binding = cloneSafeData(value, "binding", cloneContext(), 0);
  assertFields(
    binding,
    "binding",
    [
      "expectedStateRevision",
      "expectedActiveVersion",
      "draftId",
      "draftRevision",
      "targetVersion",
    ],
  );
  return binding;
}

function buildFormState({
  baseDocument,
  binding,
  edits = [],
  entityOperations = [],
}) {
  const state = deepFreeze({
    schemaVersion: FORM_STATE_SCHEMA_VERSION,
    baseDocument,
    binding,
    edits,
    entityOperations,
    dirty: edits.length > 0 || entityOperations.length > 0,
  });
  BUILT_FORM_STATES.add(state);
  return state;
}

export function createConfigurationFormState(configuration, binding = null) {
  const document = configurationForForm(configuration);
  assertSupportedConfigurationShape(document);
  assertEditableScalarConfiguration(document);
  assertEnvironmentReferences(document);
  return buildFormState({
    baseDocument: document,
    binding: cloneBinding(binding),
  });
}

function shallowDataRecord(value, path, allowed, required) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw formError("UNSUPPORTED_FORM_STATE", `${path} must be a plain object`, path);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > CONFIGURATION_FORM_LIMITS.maxObjectFields) {
    throw formError("FORM_LIMIT_EXCEEDED", `${path} object exceeds form limit`, path);
  }
  const allowedSet = new Set(allowed);
  const snapshot = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw formError("INVALID_FORM_DATA", `${path} contains a dangerous key`, path);
    }
    if (!allowedSet.has(key)) {
      throw formError("UNSUPPORTED_FORM_STATE", `unsupported ${path} field ${key}`, `${path}.${key}`);
    }
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw formError("INVALID_FORM_DATA", `${path} must contain data properties`, path);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) {
      throw formError("UNSUPPORTED_FORM_STATE", `${path} is missing ${key}`, `${path}.${key}`);
    }
  }
  return snapshot;
}

function normalizeEditPath(path) {
  const clonedPath = cloneSafeData(path, "path", cloneContext(), 0);
  if (!Array.isArray(clonedPath) || clonedPath.length === 0) {
    throw formError("INVALID_FORM_PATH", "configuration form path is required", "path");
  }
  if (clonedPath.length > CONFIGURATION_FORM_LIMITS.maxPathSegments) {
    throw formError("FORM_LIMIT_EXCEEDED", "configuration form path exceeds limit", "path");
  }
  return clonedPath.map((segment) => {
    if (
      !(typeof segment === "string" || Number.isSafeInteger(segment)) ||
      `${segment}`.length === 0 ||
      DANGEROUS_KEYS.has(`${segment}`)
    ) {
      throw formError("INVALID_FORM_PATH", "configuration form path is unsafe", "path");
    }
    return `${segment}`;
  });
}

export function configurationFormPathKey(path) {
  return JSON.stringify(normalizeEditPath(path));
}

function assertKindMatchesValue(kind, current, path) {
  const matches = {
    text: typeof current === "string",
    integer: Number.isSafeInteger(current),
    number: typeof current === "number" && Number.isFinite(current),
    boolean: typeof current === "boolean",
    scalar:
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current)),
  }[kind];
  if (!matches) {
    throw formError("INVALID_FORM_EDIT", `${path} does not accept ${kind} edits`, path);
  }
}

function normalizeFormEdit(value, editDocument, seenPaths, index, fallbackDocument = null) {
  const path = `state.edits[${index}]`;
  assertFields(value, path, ["path", "kind", "rawValue"], [
    "path",
    "kind",
    "rawValue",
  ]);
  const normalizedPath = normalizeEditPath(value.path);
  const displayPath = pathText(normalizedPath);
  if (!EDIT_KINDS.has(value.kind)) {
    throw formError(
      "INVALID_FORM_EDIT",
      `unsupported form edit kind ${value.kind}`,
      `${path}.kind`,
    );
  }
  const currentField =
    descriptorAtPath(editDocument, normalizedPath) ||
    (fallbackDocument && descriptorAtPath(fallbackDocument, normalizedPath));
  if (!currentField) {
    throw formError(
      "UNKNOWN_FORM_FIELD",
      `unknown configuration field ${displayPath}`,
      displayPath,
    );
  }
  const current = currentField.value;
  if (configurationFieldDescriptor(normalizedPath, current).readOnly) {
    throw formError(
      "INVALID_FORM_EDIT",
      `${displayPath} is read-only`,
      displayPath,
    );
  }
  assertKindMatchesValue(value.kind, current, displayPath);
  if (value.kind === "boolean") {
    if (typeof value.rawValue !== "boolean") {
      throw formError("INVALID_FORM_EDIT", `${displayPath} expects a boolean`, displayPath);
    }
  } else if (typeof value.rawValue !== "string") {
    throw formError("INVALID_FORM_EDIT", `${displayPath} expects text input`, displayPath);
  }
  if (
    typeof value.rawValue === "string" &&
    byteLength(value.rawValue) > CONFIGURATION_FORM_LIMITS.maxTextBytes
  ) {
    throw formError("FORM_LIMIT_EXCEEDED", `${displayPath} text exceeds form limit`, displayPath);
  }
  const key = configurationFormPathKey(normalizedPath);
  if (seenPaths.has(key)) {
    throw formError(
      "INVALID_FORM_EDIT",
      `duplicate configuration form edit path ${displayPath}`,
      displayPath,
    );
  }
  seenPaths.add(key);
  return deepFreeze({
    path: normalizedPath,
    kind: value.kind,
    rawValue: value.rawValue,
  });
}

function normalizeLegacyEntityOperation(value, seenOperations, index) {
  const path = `state.entityOperations[${index}]`;
  assertFields(value, path, ["operation", "kind", "id"], [
    "operation",
    "kind",
    "id",
  ]);
  if (
    value.operation !== "remove" ||
    !ENTITY_KINDS.has(value.kind) ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${path} is invalid`,
      path,
    );
  }
  const key = JSON.stringify([value.operation, value.kind, value.id]);
  if (seenOperations.has(key)) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${path} duplicates an earlier entity operation`,
      path,
    );
  }
  seenOperations.add(key);
  return deepFreeze({
    operation: value.operation,
    kind: value.kind,
    id: value.id,
  });
}

function secretField(name) {
  if (/(?:Env|Ref)$/.test(name)) return false;
  const normalized = name.replaceAll(/[-_]/g, "").toLowerCase();
  if (normalized.endsWith("tokens")) return false;
  return /(?:token|apikey|password|passwd|secret|credential|privatekey|accesskey|authorization)$/.test(
    normalized,
  );
}

function assertNoCredentialValues(value, path = "operation.value", field = "") {
  if (typeof value === "string") {
    if (
      SECRET_VALUE.test(value) ||
      URL_USERINFO.test(value) ||
      (/(?:Env|Ref)$/.test(field) && !SAFE_ENV_NAME.test(value))
    ) {
      throw formError(
        "INVALID_CREDENTIAL_VALUE",
        `${path} must contain only a safe environment variable reference`,
        path,
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoCredentialValues(entry, `${path}[${index}]`),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (secretField(key)) {
      throw formError(
        "INVALID_CREDENTIAL_VALUE",
        `${path}.${key} cannot contain a credential value`,
        `${path}.${key}`,
      );
    }
    assertNoCredentialValues(entry, `${path}.${key}`, key);
  }
}

function normalizeStructureOperation(value, seenOperations, index, document = null) {
  if (Object.hasOwn(value, "kind") || Object.hasOwn(value, "id")) {
    return normalizeLegacyEntityOperation(value, seenOperations, index);
  }
  const operationPath = `state.entityOperations[${index}]`;
  assertFields(
    value,
    operationPath,
    ["operation", "path", "key", "index", "value"],
    ["operation", "path"],
  );
  if (!STRUCTURE_OPERATIONS.has(value.operation)) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${operationPath} uses an unsupported structure operation`,
      operationPath,
    );
  }
  const path = normalizeEditPath(value.path);
  const collection = configurationCollectionDescriptor(path);
  const slot = collection
    ? null
    : configurationSlotDescriptor(path, document ? providerContext(document, path) : null);
  if (!collection && !slot) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${pathText(path)} is not an editable collection in the operation allowlist`,
      pathText(path),
    );
  }
  const hasKey = Object.hasOwn(value, "key");
  const hasIndex = Object.hasOwn(value, "index");
  const hasValue = Object.hasOwn(value, "value");
  const needsValue = value.operation !== "remove";
  if (hasValue !== needsValue) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${operationPath} must ${needsValue ? "include" : "omit"} value`,
      operationPath,
    );
  }
  if (
    collection?.kind === "map" &&
    (!hasKey || hasIndex || typeof value.key !== "string" || !value.key)
  ) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${operationPath} requires a map key`,
      operationPath,
    );
  }
  if (
    collection?.kind === "array" &&
    (hasKey ||
      (value.operation !== "add" && !hasIndex) ||
      (hasIndex && (!Number.isSafeInteger(value.index) || value.index < 0)))
  ) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${operationPath} requires a safe array index`,
      operationPath,
    );
  }
  if (
    slot &&
    (hasKey ||
      hasIndex ||
      !slot.operations.includes(value.operation) ||
      (value.operation === "add" && !slot.nullable && !slot.optional))
  ) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${operationPath} does not support that slot operation`,
      operationPath,
    );
  }
  if (hasKey) {
    if (
      byteLength(value.key) > 4_096 ||
      DANGEROUS_KEYS.has(value.key) ||
      INVALID_TEXT_CONTROL.test(value.key) ||
      (collection.keyOptions && !collection.keyOptions.includes(value.key)) ||
      (collection.keyFormat && !validFieldFormat(value.key, collection.keyFormat))
    ) {
      throw formError(
        "INVALID_ENTITY_OPERATION",
        `${operationPath} contains an unsafe map key`,
        operationPath,
      );
    }
  }
  const clonedValue = hasValue
    ? cloneSafeData(
        value.value,
        `${operationPath}.value`,
        cloneContext(),
        0,
      )
    : undefined;
  if (hasValue) assertNoCredentialValues(clonedValue, `${operationPath}.value`);
  return deepFreeze({
    operation: value.operation,
    path,
    ...(hasKey ? { key: value.key } : {}),
    ...(hasIndex ? { index: value.index } : {}),
    ...(hasValue ? { value: clonedValue } : {}),
  });
}

function descriptorAtPath(document, path) {
  let current = document;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    current = descriptor.value;
  }
  return { value: current };
}

function pathHasPrefix(path, prefix) {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

function structureTarget(document, operation) {
  const descriptor = configurationCollectionDescriptor(operation.path);
  if (!descriptor) return null;
  const existing = descriptorAtPath(document, operation.path);
  if (existing) return { descriptor, value: existing.value };
  if (!descriptor.optional || operation.operation !== "add") {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `${pathText(operation.path)} does not exist`,
      pathText(operation.path),
    );
  }
  const parentPath = operation.path.slice(0, -1);
  const parent = valueAtPath(document, parentPath);
  const key = operation.path.at(-1);
  const value = descriptor.kind === "array" ? [] : {};
  Object.defineProperty(parent, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return { descriptor, value };
}

function applyStructureOperation(document, operation) {
  if (Object.hasOwn(operation, "kind")) {
    if (!removeEntityFromDocument(document, operation.kind, operation.id)) {
      throw formError(
        "INVALID_ENTITY_OPERATION",
        `entity ${operation.kind}:${operation.id} does not exist`,
        "entityOperations",
      );
    }
    return;
  }
  const target = structureTarget(document, operation);
  if (!target) {
    const slot = configurationSlotDescriptor(
      operation.path,
      providerContext(document, operation.path),
    );
    if (!slot) {
      throw formError(
        "INVALID_ENTITY_OPERATION",
        `${pathText(operation.path)} is not in the structure operation allowlist`,
        pathText(operation.path),
      );
    }
    const existing = descriptorAtPath(document, operation.path);
    if (operation.operation === "add") {
      if (existing && (!slot.nullable || existing.value !== null)) {
        throw formError("INVALID_ENTITY_OPERATION", "configuration slot already exists", pathText(operation.path));
      }
      if (!existing) {
        if (!slot.optional) {
          throw formError("INVALID_ENTITY_OPERATION", "configuration slot does not exist", pathText(operation.path));
        }
        const parent = valueAtPath(document, operation.path.slice(0, -1));
        Object.defineProperty(parent, operation.path.at(-1), {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cloneSafeData(operation.value, "operation.value", cloneContext(), 0),
        });
        return;
      }
    } else if (!existing) {
      throw formError("INVALID_ENTITY_OPERATION", "configuration slot does not exist", pathText(operation.path));
    }
    if (operation.operation === "remove") {
      if (slot.optional) {
        const parent = valueAtPath(document, operation.path.slice(0, -1));
        delete parent[operation.path.at(-1)];
        return;
      }
      if (!slot.nullable) {
        throw formError("INVALID_ENTITY_OPERATION", "configuration slot is required", pathText(operation.path));
      }
      setValueAtPath(document, operation.path, null);
      return;
    }
    setValueAtPath(document, operation.path, cloneSafeData(operation.value, "operation.value", cloneContext(), 0));
    return;
  }
  const { descriptor, value } = target;
  if (descriptor.kind === "array") {
    const index = operation.index ?? value.length;
    if (
      index > value.length ||
      (operation.operation !== "add" && index >= value.length)
    ) {
      throw formError("INVALID_ENTITY_OPERATION", "array operation index is out of range", pathText(operation.path));
    }
    if (operation.operation === "add") {
      value.splice(index, 0, cloneSafeData(operation.value, "operation.value", cloneContext(), 0));
    } else if (operation.operation === "replace") {
      value.splice(index, 1, cloneSafeData(operation.value, "operation.value", cloneContext(), 0));
    } else {
      value.splice(index, 1);
    }
    return;
  }
  const exists = Object.hasOwn(value, operation.key);
  if ((operation.operation === "add" && exists) || (operation.operation !== "add" && !exists)) {
    throw formError(
      "INVALID_ENTITY_OPERATION",
      `map entry ${operation.key} ${exists ? "already exists" : "does not exist"}`,
      pathText(operation.path),
    );
  }
  if (operation.operation === "remove") {
    delete value[operation.key];
  } else {
    Object.defineProperty(value, operation.key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneSafeData(operation.value, "operation.value", cloneContext(), 0),
    });
  }
}

function documentWithStructureOperations(baseDocument, operations) {
  const document = cloneConfiguration(baseDocument);
  for (const operation of operations) applyStructureOperation(document, operation);
  cloneConfiguration(document);
  return document;
}

function normalizeFormState(state) {
  if (
    state !== null &&
    typeof state === "object" &&
    BUILT_FORM_STATES.has(state)
  ) {
    return state;
  }
  const snapshot = shallowDataRecord(
    state,
    "state",
    [
      "schemaVersion",
      "baseDocument",
      "binding",
      "edits",
      "entityOperations",
      "dirty",
    ],
    [
      "schemaVersion",
      "baseDocument",
      "binding",
      "edits",
      "entityOperations",
      "dirty",
    ],
  );
  if (snapshot.schemaVersion !== FORM_STATE_SCHEMA_VERSION) {
    throw formError(
      "UNSUPPORTED_FORM_STATE",
      "unsupported configuration form state",
      "state.schemaVersion",
    );
  }
  if (typeof snapshot.dirty !== "boolean") {
    throw formError("UNSUPPORTED_FORM_STATE", "state.dirty must be boolean", "state.dirty");
  }
  const baseDocument = cloneConfiguration(snapshot.baseDocument);
  assertSupportedConfigurationShape(baseDocument);
  assertEditableScalarConfiguration(baseDocument);
  assertEnvironmentReferences(baseDocument);
  const clonedOperations = cloneSafeData(
    snapshot.entityOperations,
    "state.entityOperations",
    cloneContext(),
    0,
  );
  if (
    !Array.isArray(clonedOperations) ||
    clonedOperations.length > CONFIGURATION_FORM_LIMITS.maxEntityOperations
  ) {
    throw formError(
      "FORM_LIMIT_EXCEEDED",
      "configuration entity operation count exceeds limit",
      "entityOperations",
    );
  }
  const seenOperations = new Set();
  const structureDocument = cloneConfiguration(baseDocument);
  const entityOperations = clonedOperations.map((operation, index) => {
    const normalized = normalizeStructureOperation(
      operation,
      seenOperations,
      index,
      structureDocument,
    );
    applyStructureOperation(structureDocument, normalized);
    return normalized;
  });
  cloneConfiguration(structureDocument);
  const clonedEdits = cloneSafeData(snapshot.edits, "state.edits", cloneContext(), 0);
  if (!Array.isArray(clonedEdits) || clonedEdits.length > CONFIGURATION_FORM_LIMITS.maxEdits) {
    throw formError("FORM_LIMIT_EXCEEDED", "configuration form edit count exceeds limit", "edits");
  }
  const seenPaths = new Set();
  const edits = clonedEdits.map((edit, index) =>
    normalizeFormEdit(edit, structureDocument, seenPaths, index, baseDocument),
  );
  if (snapshot.dirty !== (edits.length > 0 || entityOperations.length > 0)) {
    throw formError(
      "UNSUPPORTED_FORM_STATE",
      "state dirty flag does not match its pending changes",
      "state.dirty",
    );
  }
  return buildFormState({
    baseDocument,
    binding: cloneBinding(snapshot.binding),
    edits,
    entityOperations,
  });
}

function githubCredentialModeTokenOperation(structureDocument, edit) {
  if (
    edit.path.length !== 2 ||
    edit.path[0] !== "githubActions" ||
    edit.path[1] !== "credentialMode" ||
    !["gh-login", "token-env"].includes(edit.rawValue)
  ) {
    return null;
  }
  const path = ["githubActions", "tokenEnv"];
  const hasTokenEnv = descriptorAtPath(structureDocument, path) !== null;
  if (edit.rawValue === "gh-login" && hasTokenEnv) {
    return { operation: "remove", path };
  }
  if (edit.rawValue === "token-env" && !hasTokenEnv) {
    return {
      operation: "add",
      path,
      value: "MYDASHBOARD_GITHUB_TOKEN",
    };
  }
  return null;
}

export function setConfigurationFormField(state, input) {
  const snapshot = normalizeFormState(state);
  const editInput = shallowDataRecord(
    input,
    "edit",
    ["path", "kind", "rawValue"],
    ["path", "kind", "rawValue"],
  );
  const { path, kind, rawValue } = editInput;
  if (!EDIT_KINDS.has(kind)) {
    throw formError("INVALID_FORM_EDIT", `unsupported form edit kind ${kind}`, "kind");
  }
  const normalizedPath = normalizeEditPath(path);
  const displayPath = pathText(normalizedPath);
  const structureDocument = documentWithStructureOperations(
    snapshot.baseDocument,
    snapshot.entityOperations,
  );
  const currentField =
    descriptorAtPath(structureDocument, normalizedPath) ||
    descriptorAtPath(snapshot.baseDocument, normalizedPath);
  if (!currentField) {
    throw formError(
      "UNKNOWN_FORM_FIELD",
      `unknown configuration field ${displayPath}`,
      displayPath,
    );
  }
  const current = currentField.value;
  if (configurationFieldDescriptor(normalizedPath, current).readOnly) {
    throw formError(
      "INVALID_FORM_EDIT",
      `${displayPath} is read-only`,
      displayPath,
    );
  }
  assertKindMatchesValue(kind, current, displayPath);
  if (kind === "boolean") {
    if (typeof rawValue !== "boolean") {
      throw formError("INVALID_FORM_EDIT", `${displayPath} expects a boolean`, displayPath);
    }
  } else if (typeof rawValue !== "string") {
    throw formError("INVALID_FORM_EDIT", `${displayPath} expects text input`, displayPath);
  }
  if (typeof rawValue === "string" && byteLength(rawValue) > CONFIGURATION_FORM_LIMITS.maxTextBytes) {
    throw formError("FORM_LIMIT_EXCEEDED", `${displayPath} text exceeds form limit`, displayPath);
  }
  const edit = deepFreeze({ path: normalizedPath, kind, rawValue });
  const editKey = configurationFormPathKey(normalizedPath);
  const existingIndex = snapshot.edits.findIndex(
    (entry) => configurationFormPathKey(entry.path) === editKey,
  );
  const edits = snapshot.edits.slice();
  if (existingIndex === -1) {
    if (edits.length >= CONFIGURATION_FORM_LIMITS.maxEdits) {
      throw formError("FORM_LIMIT_EXCEEDED", "configuration form edit count exceeds limit", "edits");
    }
    edits.push(edit);
  } else {
    edits[existingIndex] = edit;
  }
  const tokenOperationInput = githubCredentialModeTokenOperation(
    structureDocument,
    edit,
  );
  const entityOperations = snapshot.entityOperations.slice();
  if (tokenOperationInput) {
    if (entityOperations.length >= CONFIGURATION_FORM_LIMITS.maxEntityOperations) {
      throw formError(
        "FORM_LIMIT_EXCEEDED",
        "configuration entity operation count exceeds limit",
        "entityOperations",
      );
    }
    const operation = normalizeStructureOperation(
      tokenOperationInput,
      new Set(),
      entityOperations.length,
      structureDocument,
    );
    applyStructureOperation(structureDocument, operation);
    entityOperations.push(operation);
  }
  return buildFormState({
    baseDocument: snapshot.baseDocument,
    binding: snapshot.binding,
    edits,
    entityOperations,
  });
}

function resourceEditsAfterStructureOperation(edits, operation, document) {
  if (
    operation.path.length !== 4 ||
    operation.path[0] !== "codeExecutor" ||
    operation.path[1] !== "profiles" ||
    operation.path[3] !== "resources"
  ) return edits;
  const index = operation.index ?? descriptorAtPath(document, operation.path)?.value.length ?? 0;
  return edits.flatMap((edit) => {
    if (!pathHasPrefix(edit.path, operation.path)) return [edit];
    const entryIndex = Number(edit.path[operation.path.length]);
    if (operation.operation !== "add" && entryIndex === index) return [];
    const shift = operation.operation === "add" && entryIndex >= index
      ? 1
      : operation.operation === "remove" && entryIndex > index ? -1 : 0;
    if (shift === 0) return [edit];
    const path = edit.path.slice();
    path[operation.path.length] = `${entryIndex + shift}`;
    return [{ ...edit, path }];
  });
}

export function applyConfigurationStructureOperation(state, input) {
  const snapshot = normalizeFormState(state);
  if (
    snapshot.entityOperations.length >=
    CONFIGURATION_FORM_LIMITS.maxEntityOperations
  ) {
    throw formError(
      "FORM_LIMIT_EXCEEDED",
      "configuration structure operation count exceeds limit",
      "entityOperations",
    );
  }
  const operationInput = shallowDataRecord(
    input,
    "operation",
    ["operation", "path", "key", "index", "value"],
    ["operation", "path"],
  );
  const document = documentWithStructureOperations(
    snapshot.baseDocument,
    snapshot.entityOperations,
  );
  const operation = normalizeStructureOperation(
    operationInput,
    new Set(),
    snapshot.entityOperations.length,
    document,
  );
  const retainedEdits = resourceEditsAfterStructureOperation(snapshot.edits, operation, document);
  applyStructureOperation(document, operation);
  cloneConfiguration(document);
  const resetsSlot =
    ["remove", "replace"].includes(operation.operation) &&
    !Object.hasOwn(operation, "key") &&
    !Object.hasOwn(operation, "index");
  const edits = retainedEdits.filter(
    (edit) =>
      !(resetsSlot && pathHasPrefix(edit.path, operation.path)) &&
      (descriptorAtPath(document, edit.path) ||
        descriptorAtPath(snapshot.baseDocument, edit.path)),
  );
  return buildFormState({
    baseDocument: snapshot.baseDocument,
    binding: snapshot.binding,
    edits,
    entityOperations: [...snapshot.entityOperations, operation],
  });
}

export function resetConfigurationFormState(state) {
  const snapshot = normalizeFormState(state);
  return buildFormState({
    baseDocument: snapshot.baseDocument,
    binding: snapshot.binding,
  });
}

function integerEdit(edit, issues) {
  if (edit.rawValue === "") {
    issues.push(issue(edit.path, "INCOMPLETE_INTEGER", "请输入整数。"));
    return undefined;
  }
  if (!/^-?(?:0|[1-9]\d*)$/.test(edit.rawValue)) {
    issues.push(issue(edit.path, "INVALID_INTEGER", "请输入有效整数。"));
    return undefined;
  }
  const value = Number(edit.rawValue);
  if (!Number.isSafeInteger(value)) {
    issues.push(issue(edit.path, "INVALID_INTEGER", "整数超出安全范围。"));
    return undefined;
  }
  return value;
}

function numberEdit(edit, issues) {
  if (edit.rawValue === "") {
    issues.push(issue(edit.path, "INCOMPLETE_NUMBER", "请输入数字。"));
    return undefined;
  }
  const value = Number(edit.rawValue);
  if (!Number.isFinite(value)) {
    issues.push(issue(edit.path, "INVALID_NUMBER", "请输入有效数字。"));
    return undefined;
  }
  return Object.is(value, -0) ? 0 : value;
}

function scalarEdit(edit, issues) {
  if (edit.rawValue === "") {
    issues.push(issue(edit.path, "INCOMPLETE_SCALAR", "请选择值类型并填写值。"));
    return undefined;
  }
  try {
    const parsed = JSON.parse(edit.rawValue);
    if (
      parsed === null ||
      typeof parsed === "string" ||
      typeof parsed === "boolean" ||
      (typeof parsed === "number" && Number.isFinite(parsed))
    ) {
      return parsed;
    }
  } catch {
    // A scalar edit is reported as a bounded field issue below.
  }
  issues.push(issue(edit.path, "INVALID_SCALAR", "请输入字符串、数字、布尔值或 null。"));
  return undefined;
}

function issue(path, code, message) {
  return { path: pathText(path), code, message };
}

function editValue(edit, issues) {
  if (edit.kind === "text" || edit.kind === "boolean") return edit.rawValue;
  if (edit.kind === "integer") return integerEdit(edit, issues);
  if (edit.kind === "number") return numberEdit(edit, issues);
  return scalarEdit(edit, issues);
}

function setValueAtPath(document, path, value) {
  let parent = document;
  for (const segment of path.slice(0, -1)) {
    if (DANGEROUS_KEYS.has(segment)) {
      throw formError("INVALID_FORM_PATH", "configuration form path is unsafe", pathText(path));
    }
    const descriptor = Object.getOwnPropertyDescriptor(parent, segment);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw formError(
        "UNKNOWN_FORM_FIELD",
        `unknown configuration field ${pathText(path)}`,
        pathText(path),
      );
    }
    parent = descriptor.value;
  }
  const field = path.at(-1);
  if (DANGEROUS_KEYS.has(field)) {
    throw formError("INVALID_FORM_PATH", "configuration form path is unsafe", pathText(path));
  }
  const descriptor = Object.getOwnPropertyDescriptor(parent, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw formError(
      "UNKNOWN_FORM_FIELD",
      `unknown configuration field ${pathText(path)}`,
      pathText(path),
    );
  }
  Object.defineProperty(parent, field, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function invalidEnvironmentIssues(configuration) {
  return envReferencePaths(configuration)
    .filter((path) => {
      const value = valueAtPath(configuration, path);
      return typeof value !== "string" || !SAFE_ENV_NAME.test(value);
    })
    .map((path) =>
      issue(
        path,
        "INVALID_ENV_REFERENCE",
        "这里只能填写环境变量名称，不能填写凭据值。",
      ),
    );
}

function presentationRawValue(state, edit, materializedDocument) {
  if (
    typeof edit.rawValue === "string" &&
    (SECRET_VALUE.test(edit.rawValue) || URL_USERINFO.test(edit.rawValue))
  ) {
    return descriptorAtPath(state.baseDocument, edit.path)?.value ??
      descriptorAtPath(materializedDocument, edit.path)?.value ??
      "";
  }
  return edit.rawValue;
}

function buildPresentationDocument(state, materializedDocument) {
  const presentation = cloneConfiguration(materializedDocument);
  for (const edit of state.edits) {
    if (!descriptorAtPath(presentation, edit.path)) continue;
    setValueAtPath(
      presentation,
      edit.path,
      presentationRawValue(state, edit, materializedDocument),
    );
  }
  return presentation;
}

function removedEntityForOperation(document, operation) {
  if (Object.hasOwn(operation, "kind")) {
    return { kind: operation.kind, id: operation.id };
  }
  if (!["remove", "replace"].includes(operation.operation)) return null;
  const pathKey = configurationFormPathKey(operation.path);
  const mapKinds = new Map([
    [configurationFormPathKey(["brainProviders"]), "provider"],
    [configurationFormPathKey(["employees", "roles"]), "role"],
    [configurationFormPathKey(["codeExecutor", "profiles"]), "profile"],
  ]);
  if (mapKinds.has(pathKey)) {
    return { kind: mapKinds.get(pathKey), id: operation.key };
  }
  if (pathKey === configurationFormPathKey(["codeExecutor", "workspaces"])) {
    const workspace = descriptorAtPath(document, operation.path)?.value?.[operation.index];
    return workspace && typeof workspace.id === "string"
      ? { kind: "workspace", id: workspace.id }
      : null;
  }
  return null;
}

function entityExists(configuration, { kind, id }) {
  if (kind === "provider") return Object.hasOwn(configuration.brainProviders, id);
  if (kind === "role") return Object.hasOwn(configuration.employees.roles, id);
  if (kind === "profile") {
    return Object.hasOwn(configuration.codeExecutor.profiles || {}, id);
  }
  return (configuration.codeExecutor.workspaces || []).some(
    (workspace) => workspace.id === id,
  );
}

function applyPendingStructureOperations(document, operations) {
  const removedEntities = [];
  for (const [operationIndex, operation] of operations.entries()) {
    const removed = removedEntityForOperation(document, operation);
    applyStructureOperation(document, operation);
    if (removed) removedEntities.push({ identity: removed, operationIndex });
  }
  return removedEntities;
}

function removedEntityIssues(configuration, removedEntities) {
  const issues = [];
  for (const { identity, operationIndex } of removedEntities) {
    if (entityExists(configuration, identity)) continue;
    const references = collectConfigurationReferences(configuration, identity);
    if (references.length > 0) {
      issues.push({
        path: `entityOperations[${operationIndex}]`,
        code: "ENTITY_REFERENCED",
        message: "实体重新被配置引用，请先移除引用。",
      });
    }
  }
  return issues;
}

function materializeConfigurationFormState(state) {
  const document = cloneConfiguration(state.baseDocument);
  const issues = [];
  const removedEntities = applyPendingStructureOperations(
    document,
    state.entityOperations,
  );
  for (const edit of state.edits) {
    if (!descriptorAtPath(document, edit.path)) continue;
    const value = editValue(edit, issues);
    if (value !== undefined) setValueAtPath(document, edit.path, value);
  }
  if (document.githubActions.credentialMode === "gh-login") {
    delete document.githubActions.tokenEnv;
  }
  let supportedStructure = true;
  try {
    assertSupportedConfigurationShape(document);
  } catch (error) {
    if (!(error instanceof ConfigurationFormError)) throw error;
    supportedStructure = false;
    issues.push({
      path: error.path,
      code: "INVALID_CONFIGURATION_STRUCTURE",
      message: error.message,
    });
  }
  issues.push(...editableScalarIssues(document));
  issues.push(...collectionConfigurationIssues(document));
  if (supportedStructure) {
    issues.push(...configurationRelationshipIssues(document));
  }
  issues.push(...invalidEnvironmentIssues(document));
  issues.push(...removedEntityIssues(document, removedEntities));
  const presentation = buildPresentationDocument(state, document);
  if (issues.length > 0) {
    return deepFreeze({
      ok: false,
      issues,
      baseDocument: state.baseDocument,
      presentation: { configuration: presentation },
    });
  }
  return deepFreeze({ ok: true, configuration: document, issues: [] });
}

export function configurationDocumentFromForm(state) {
  return materializeConfigurationFormState(normalizeFormState(state));
}

function addReference(references, path, kind) {
  if (references.length >= CONFIGURATION_FORM_LIMITS.maxReferences) {
    throw formError("FORM_LIMIT_EXCEEDED", "configuration reference count exceeds limit", path);
  }
  references.push({ path, kind });
}

function providerReferences(configuration, id, references) {
  if (configuration.brain.provider === id) {
    addReference(references, "brain.provider", "default_brain");
  }
  if (configuration.employees.prReviewer.brain.provider === id) {
    addReference(references, "employees.prReviewer.brain.provider", "employee_brain");
  }
  if (configuration.employees.prReviewer.primaryBrain?.provider === id) {
    addReference(references, "employees.prReviewer.primaryBrain.provider", "employee_primary_brain");
  }
  for (const [roleId, roleValue] of Object.entries(configuration.employees.roles)) {
    if (roleValue.brain.provider === id) {
      addReference(references, `employees.roles.${roleId}.brain.provider`, "employee_brain");
    }
    if (roleValue.taskBrain?.provider === id) {
      addReference(
        references,
        `employees.roles.${roleId}.taskBrain.provider`,
        "employee_task_brain",
      );
    }
  }
  for (const name of ["brain", "localBrain"]) {
    if (configuration.memory.answering?.[name]?.provider === id) {
      addReference(references, `memory.answering.${name}.provider`, "memory_brain");
    }
  }
}

function roleReferences(configuration, id, references) {
  configuration.workflowRouting.rules.forEach((rule, ruleIndex) => {
    rule.targets.forEach((target, targetIndex) => {
      if (target.type === "role" && target.id === id) {
        addReference(
          references,
          `workflowRouting.rules[${ruleIndex}].targets[${targetIndex}].id`,
          "routing_target",
        );
      }
    });
  });
  for (const [capability, roleId] of Object.entries(
    configuration.workCoordination.policy.capabilityRoles,
  )) {
    if (roleId === id) {
      addReference(
        references,
        `workCoordination.policy.capabilityRoles.${capability}`,
        "capability_role",
      );
    }
  }
  for (const listName of [
    "githubReviewRoles",
    "codeActionRoles",
    "configurationChangeRoles",
  ]) {
    (configuration.workCoordination.policy[listName] || []).forEach((roleId, index) => {
      if (roleId === id) {
        addReference(
          references,
          `workCoordination.policy.${listName}[${index}]`,
          "policy_role",
        );
      }
    });
  }
  if (Object.hasOwn(configuration.workCoordination.policy.codeOperationsByRole, id)) {
    addReference(
      references,
      `workCoordination.policy.codeOperationsByRole.${id}`,
      "code_operations_role",
    );
  }
}

function workspaceReferences(configuration, id, references) {
  if (Object.hasOwn(configuration.codeExecutor.requiredProfilesByWorkspace || {}, id)) {
    addReference(
      references,
      `codeExecutor.requiredProfilesByWorkspace.${id}`,
      "required_profiles_workspace",
    );
  }
  for (const [repository, workspaceId] of Object.entries(
    configuration.workCoordination.policy.workspaceByRepository,
  )) {
    if (workspaceId === id) {
      addReference(
        references,
        `workCoordination.policy.workspaceByRepository.${repository}`,
        "repository_workspace",
      );
    }
  }
}

function profileReferences(configuration, id, references) {
  for (const [workspaceId, profileIds] of Object.entries(
    configuration.codeExecutor.requiredProfilesByWorkspace || {},
  )) {
    profileIds.forEach((profileId, index) => {
      if (profileId === id) {
        addReference(
          references,
          `codeExecutor.requiredProfilesByWorkspace.${workspaceId}[${index}]`,
          "required_profile",
        );
      }
    });
  }
}

function normalizeEntityIdentity(value) {
  const identity = shallowDataRecord(value, "entity", ["kind", "id"], [
    "kind",
    "id",
  ]);
  if (!ENTITY_KINDS.has(identity.kind) || typeof identity.id !== "string" || !identity.id) {
    throw formError("INVALID_ENTITY", "configuration entity identity is invalid", "entity");
  }
  return identity;
}

function collectConfigurationReferences(configuration, { kind, id }) {
  const references = [];
  const collectors = {
    provider: providerReferences,
    role: roleReferences,
    workspace: workspaceReferences,
    profile: profileReferences,
  };
  collectors[kind](configuration, id, references);
  references.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return references;
}

export function configurationReferences(configuration, input) {
  const { kind, id } = normalizeEntityIdentity(input);
  const document = configurationForForm(configuration);
  assertSupportedConfigurationShape(document);
  return deepFreeze(collectConfigurationReferences(document, { kind, id }));
}

function removeEntityFromDocument(document, kind, id) {
  if (kind === "provider") {
    if (!Object.hasOwn(document.brainProviders, id)) return false;
    delete document.brainProviders[id];
    return true;
  }
  if (kind === "role") {
    if (!Object.hasOwn(document.employees.roles, id)) return false;
    delete document.employees.roles[id];
    return true;
  }
  if (kind === "profile") {
    if (!Object.hasOwn(document.codeExecutor.profiles || {}, id)) return false;
    delete document.codeExecutor.profiles[id];
    return true;
  }
  const index = (document.codeExecutor.workspaces || []).findIndex(
    (workspace) => workspace.id === id,
  );
  if (index === -1) return false;
  document.codeExecutor.workspaces.splice(index, 1);
  return true;
}

export function removeConfigurationEntity(state, input) {
  const snapshot = normalizeFormState(state);
  const { kind, id } = normalizeEntityIdentity(input);
  const materialized = materializeConfigurationFormState(snapshot);
  if (!materialized.ok) {
    return deepFreeze({
      removed: false,
      reason: "invalid_form",
      references: [],
      issues: materialized.issues,
      state: snapshot,
    });
  }
  const references = collectConfigurationReferences(materialized.configuration, {
    kind,
    id,
  });
  if (references.length > 0) {
    return deepFreeze({
      removed: false,
      reason: "referenced",
      references,
      issues: [],
      state: snapshot,
    });
  }
  const document = cloneConfiguration(materialized.configuration);
  if (!removeEntityFromDocument(document, kind, id)) {
    return deepFreeze({
      removed: false,
      reason: "not_found",
      references: [],
      issues: [],
      state: snapshot,
    });
  }
  if (
    snapshot.entityOperations.length >=
    CONFIGURATION_FORM_LIMITS.maxEntityOperations
  ) {
    throw formError(
      "FORM_LIMIT_EXCEEDED",
      "configuration entity operation count exceeds limit",
      "entityOperations",
    );
  }
  const operation = deepFreeze({ operation: "remove", kind, id });
  return deepFreeze({
    removed: true,
    reason: null,
    references: [],
    issues: [],
    state: buildFormState({
      baseDocument: snapshot.baseDocument,
      binding: snapshot.binding,
      edits: snapshot.edits,
      entityOperations: [...snapshot.entityOperations, operation],
    }),
  });
}
