import path from "node:path";

import { OllamaStructuredProvider } from "../adapters/ollama-structured-provider.js";
import { OpenAiCompatibleProvider } from "../adapters/openai-compatible-provider.js";
import {
  createProductionSupervisedCliBrainProvider,
} from "../adapters/supervised-cli-brain-provider.js";
import { ProductionCliCompositionGrant } from "../composition-root.js";
import { BrainRouter } from "./brain-router.js";
import { ConfiguredRoleEmployee } from "./configured-role-employee.js";

const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const PROVIDER_KEYS = new Set([
  "kind",
  "baseUrl",
  "apiKeyEnv",
  "protocol",
  "responseFormat",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "contextTokens",
  "credentialMode",
  "maxConcurrentTurns",
  "remote",
]);
const PROVIDER_LIMIT_KEYS = Object.freeze([
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
]);
const CLI_PROVIDER_KEYS = new Set([
  "kind",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "credentialMode",
  "maxConcurrentTurns",
  "remote",
]);
const ROLE_KEYS = new Set([
  "name",
  "mission",
  "enabled",
  "scheduleMinutes",
  "initialPaused",
  "workerId",
  "permissions",
  "brain",
  "taskBrain",
]);
const CONFIGURED_CONSTRUCTION_CLEANUPS = new WeakMap();
const CONFIGURED_CONSTRUCTION_CLEANUP_OWNERS = new WeakSet();

function hasObjectIdentity(value) {
  return value !== null &&
    (typeof value === "object" || typeof value === "function");
}

function createCloseLifecycle(failureMessage) {
  const owners = new Map();
  const runtimes = [];
  const closedRuntimes = new Set();
  const failures = [];
  let closeAttempt = null;
  let lastFailure = null;

  const close = () => {
    if (closeAttempt) return closeAttempt;
    const attempt = (async () => {
      const attemptFailures = [];
      for (let index = runtimes.length - 1; index >= 0; index -= 1) {
        const runtime = runtimes[index];
        if (closedRuntimes.has(runtime)) continue;
        try {
          await runtime.close();
          closedRuntimes.add(runtime);
        } catch (error) {
          failures.push(error);
          attemptFailures.push(error);
        }
      }
      lastFailure = attemptFailures.length === 1
        ? attemptFailures[0]
        : attemptFailures.length > 1
          ? new AggregateError(attemptFailures, failureMessage)
          : null;
      if (lastFailure) throw lastFailure;
    })();
    closeAttempt = attempt;
    void attempt.then(
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
    );
    return attempt;
  };

  return Object.freeze({
    admit(owner) {
      const existingRuntime = owners.get(owner);
      if (existingRuntime) return existingRuntime;
      const closeCapability = owner?.close;
      const runtime = typeof closeCapability === "function"
        ? Object.freeze({
            owner,
            close: closeCapability.bind(owner),
          })
        : null;
      owners.set(owner, runtime);
      if (runtime) runtimes.push(runtime);
      return runtime;
    },
    close,
    readStatus() {
      const pendingRuntimes = runtimes
        .filter((runtime) => !closedRuntimes.has(runtime)).length;
      return Object.freeze({
        acquiredRuntimes: runtimes.length,
        pendingRuntimes,
        complete: pendingRuntimes === 0,
        failure: lastFailure,
        failures: Object.freeze([...failures]),
      });
    },
  });
}

function retainConfiguredConstructionCleanup(
  constructionCleanupOwner,
  lifecycle,
) {
  if (lifecycle.readStatus().acquiredRuntimes === 0) return;
  const cleanup = Object.freeze({
    close: lifecycle.close,
    readStatus: lifecycle.readStatus,
  });
  if (constructionCleanupOwner) {
    const pendingCleanups = CONFIGURED_CONSTRUCTION_CLEANUPS.get(
      constructionCleanupOwner,
    );
    if (pendingCleanups) pendingCleanups.push(cleanup);
    else CONFIGURED_CONSTRUCTION_CLEANUPS.set(
      constructionCleanupOwner,
      [cleanup],
    );
  }
  const cleanupAttempt = lifecycle.close();
  void cleanupAttempt.catch(() => {});
}

export function readConfiguredConstructionCleanup(constructionCleanupOwner) {
  if (
    !hasObjectIdentity(constructionCleanupOwner) ||
    !CONFIGURED_CONSTRUCTION_CLEANUP_OWNERS.has(constructionCleanupOwner)
  ) {
    return null;
  }
  const pendingCleanups = CONFIGURED_CONSTRUCTION_CLEANUPS.get(
    constructionCleanupOwner,
  );
  if (!pendingCleanups) return null;
  const cleanup = pendingCleanups.shift() ?? null;
  if (pendingCleanups.length === 0) {
    CONFIGURED_CONSTRUCTION_CLEANUPS.delete(constructionCleanupOwner);
  }
  return cleanup;
}

export function createConfiguredConstructionCleanupOwner() {
  const owner = Object.freeze({});
  CONFIGURED_CONSTRUCTION_CLEANUP_OWNERS.add(owner);
  return owner;
}

function configuredConstructionCleanupOwner(value) {
  if (value === undefined) return null;
  if (
    !hasObjectIdentity(value) ||
    !CONFIGURED_CONSTRUCTION_CLEANUP_OWNERS.has(value)
  ) {
    throw new TypeError("configured construction cleanup owner is invalid");
  }
  return value;
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactConfig(value, allowed, name) {
  const entries = dataEntries(value, name);
  if (entries.some(([key]) => !allowed.has(key))) {
    throw new TypeError(`${name} contains an unknown field`);
  }
  return Object.fromEntries(entries);
}

function selectOptions(config, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
}

function configuredProvidersCanAcquireCleanup(value) {
  let canAcquireCleanup = false;
  for (const [id, rawConfig] of dataEntries(value, "brainProviders")) {
    const name = `brainProviders.${id}`;
    const config = exactConfig(rawConfig, PROVIDER_KEYS, name);
    declaredRemote(config, name);
    if (["ollama", "openai-compatible"].includes(config.kind)) continue;
    if (["codex-cli", "claude-cli"].includes(config.kind)) {
      if (Object.keys(config).some((key) => !CLI_PROVIDER_KEYS.has(key))) {
        throw new TypeError(
          `${name} contains a field unsupported by CLI providers`,
        );
      }
      canAcquireCleanup = true;
      continue;
    }
    throw new TypeError(
      `brain provider kind is unsupported: ${String(config.kind)}`,
    );
  }
  return canAcquireCleanup;
}

function testSupervisedCliRuntimeFacts(dependencies) {
  const protectedRoots = dependencies.supervisedCliProtectedRoots ?? [];
  const codexLoginCredentialBroker =
    dependencies.codexLoginCredentialBroker ?? null;
  if (
    !Array.isArray(protectedRoots) ||
    protectedRoots.some(
      (entry) => typeof entry !== "string" || !path.isAbsolute(entry),
    )
  ) {
    throw new TypeError("supervised CLI protected roots are invalid");
  }
  if (
    codexLoginCredentialBroker !== null &&
    (typeof codexLoginCredentialBroker !== "object" ||
      typeof codexLoginCredentialBroker.acquire !== "function" ||
      typeof codexLoginCredentialBroker.checkAvailability !== "function")
  ) {
    throw new TypeError("Codex login credential broker is invalid");
  }
  return Object.freeze({
    protectedRoots: Object.freeze([...protectedRoots]),
    ...(codexLoginCredentialBroker === null
      ? {}
      : { codexLoginCredentialBroker }),
  });
}

function productionSupervisedCliCapability(dependencies) {
  if (Object.hasOwn(dependencies, "supervisedCliProtectedRoots")) {
    throw new TypeError("production supervised CLI protected roots are invalid");
  }
  if (Object.hasOwn(dependencies, "supervisedCliCompositionCapability")) {
    throw new TypeError(
      "Production configured routing does not accept public composition authority",
    );
  }
  const symbols = Object.getOwnPropertySymbols(dependencies);
  if (
    symbols.length !== 1 ||
    !ProductionCliCompositionGrant.is(dependencies[symbols[0]])
  ) {
    throw new TypeError(
      "Production supervised CLI composition authority is invalid",
    );
  }
  return dependencies[symbols[0]];
}

function productionSupervisedCliProviderFactory(options, capability) {
  return createProductionSupervisedCliBrainProvider(options, capability);
}

function declaredRemote(config, name) {
  if (config.remote !== undefined && typeof config.remote !== "boolean") {
    throw new TypeError(`${name}.remote is invalid`);
  }
  return config.remote === true;
}

function providerWithBoundary(provider, remote, lifecycle, sessionIsolationKey = null) {
  const runtime = lifecycle.admit(provider);
  const attemptDescriptor = Object.getOwnPropertyDescriptor(
    provider,
    "singleAttempt",
  );
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
    provider,
    "supportsEntitySessions",
  );
  const reviewReadingDescriptor = Object.getOwnPropertyDescriptor(
    provider,
    "supportsReviewReading",
  );
  const nativeReviewSkillsDescriptor = Object.getOwnPropertyDescriptor(provider, "supportsNativeReviewSkills");
  const codeReadingDescriptor = Object.getOwnPropertyDescriptor(provider, "supportsCodeReading");
  const codeExecutionDescriptor = Object.getOwnPropertyDescriptor(provider, "supportsCodeExecution");
  if (codeExecutionDescriptor && (!("value" in codeExecutionDescriptor) || typeof codeExecutionDescriptor.value !== "boolean")) {
    throw new TypeError("brain provider code execution support is invalid");
  }
  if (codeReadingDescriptor && (!("value" in codeReadingDescriptor) || typeof codeReadingDescriptor.value !== "boolean")) {
    throw new TypeError("brain provider code reading support is invalid");
  }
  if (nativeReviewSkillsDescriptor && (!("value" in nativeReviewSkillsDescriptor) || typeof nativeReviewSkillsDescriptor.value !== "boolean")) {
    throw new TypeError("brain provider native review skill support is invalid");
  }
  const availability = provider.checkAvailability;
  const admission=provider.withAdmission;
  const quiescence=provider.withEntityQuiescence;
  if(quiescence!==undefined && typeof quiescence!=='function')throw new TypeError('brain provider quiescence is invalid');
  if(admission!==undefined && typeof admission!=='function')throw new TypeError('brain provider admission is invalid');
  if (
    attemptDescriptor &&
    (!("value" in attemptDescriptor) ||
      typeof attemptDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider singleAttempt is invalid");
  }
  if (availability !== undefined && typeof availability !== "function") {
    throw new TypeError("brain provider availability is invalid");
  }
  if (
    sessionDescriptor &&
    (!("value" in sessionDescriptor) ||
      typeof sessionDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider entity session support is invalid");
  }
  if (
    reviewReadingDescriptor &&
    (!("value" in reviewReadingDescriptor) ||
      typeof reviewReadingDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider review reading support is invalid");
  }
  const boundary = Object.freeze({
    id: provider.id,
    remote: provider.remote || remote,
    ...(attemptDescriptor?.value === true ? { singleAttempt: true } : {}),
    ...(sessionDescriptor?.value === true
      ? { supportsEntitySessions: true, sessionIsolationKey }
      : {}),
    ...(reviewReadingDescriptor?.value === true
      ? { supportsReviewReading: true }
      : {}),
    ...(nativeReviewSkillsDescriptor?.value === true ? { supportsNativeReviewSkills: true } : {}),
    ...(codeReadingDescriptor?.value === true ? { supportsCodeReading: true } : {}),
    ...(codeExecutionDescriptor?.value === true ? { supportsCodeExecution: true } : {}),
    generate: provider.generate.bind(provider),
    ...(admission ? {withAdmission:admission.bind(provider)} : {}),
    ...(quiescence ? {withEntityQuiescence:quiescence.bind(provider)} : {}),
    ...(availability
      ? { checkAvailability: availability.bind(provider) }
      : {}),
    ...(runtime ? { close: runtime.close } : {}),
  });
  return boundary;
}

function providerOptions(
  id,
  value,
  dependencies,
  supervisedCliProviderFactory,
  cliRuntimeFacts,
  lifecycle,
) {
  const name = `brainProviders.${id}`;
  const config = exactConfig(value, PROVIDER_KEYS, name);
  if(config.maxConcurrentTurns!==undefined && (config.kind!=='codex-cli' || config.credentialMode!=='codex-native-login'))throw new TypeError(`${name}.maxConcurrentTurns requires native Codex login`);
  const remote = declaredRemote(config, name);
  const common = {
    ...selectOptions(config, PROVIDER_LIMIT_KEYS),
    id,
  };
  if (config.kind === "ollama") {
    return providerWithBoundary(
      new OllamaStructuredProvider({
        ...common,
        ...selectOptions(config, ["baseUrl", "contextTokens"]),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      remote,
      lifecycle,
    );
  }
  if (config.kind === "openai-compatible") {
    return providerWithBoundary(
      new OpenAiCompatibleProvider({
        ...common,
        ...selectOptions(config, [
          "baseUrl",
          "apiKeyEnv",
          "protocol",
          "responseFormat",
        ]),
        environment: dependencies.environment ?? process.env,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      }),
      remote,
      lifecycle,
    );
  }
  if (["codex-cli", "claude-cli"].includes(config.kind)) {
    if (Object.keys(config).some((key) => !CLI_PROVIDER_KEYS.has(key))) {
      throw new TypeError(`${name} contains a field unsupported by CLI providers`);
    }
    return providerWithBoundary(
      supervisedCliProviderFactory({
        ...common,
        cliKind: config.kind,
        ...selectOptions(config, ["credentialMode","maxConcurrentTurns"]),
      }, cliRuntimeFacts(dependencies)),
      remote,
      lifecycle,
      `${config.kind}:${config.credentialMode ?? "api-key"}`,
    );
  }
  throw new TypeError(
    `brain provider kind is unsupported: ${String(config.kind)}`,
  );
}

function createProviders(
  value,
  dependencies,
  supervisedCliProviderFactory,
  cliRuntimeFacts,
  lifecycle,
) {
  return dataEntries(value, "brainProviders").map(([id, config]) =>
    providerOptions(
      id,
      config,
      dependencies,
      supervisedCliProviderFactory,
      cliRuntimeFacts,
      lifecycle,
    ),
  );
}

function configuredBrainRouter(
  {
    brainProviders = {},
    dependencies = {},
    constructionCleanupOwner: rawConstructionCleanupOwner,
  } = {},
  supervisedCliProviderFactory,
  cliRuntimeFacts,
  { requireConstructionCleanupOwner = false } = {},
) {
  const constructionCleanupOwner = configuredConstructionCleanupOwner(
    rawConstructionCleanupOwner,
  );
  if (
    requireConstructionCleanupOwner &&
    constructionCleanupOwner === null &&
    configuredProvidersCanAcquireCleanup(brainProviders)
  ) {
    throw new TypeError(
      "Configured CLI construction requires a construction cleanup owner",
    );
  }
  const lifecycle = createCloseLifecycle(
    "Configured brain provider cleanup failed",
  );
  try {
    const providers = createProviders(
      brainProviders,
      dependencies,
      supervisedCliProviderFactory,
      cliRuntimeFacts,
      lifecycle,
    );
    const router = new BrainRouter({ providers });
    return Object.freeze({
      generate: router.generate.bind(router),
      checkAvailability: router.checkAvailability.bind(router),
      withAdmission:router.withAdmission.bind(router),
      withEntityQuiescence:router.withEntityQuiescence.bind(router),
      describe: router.describe.bind(router),
      close: lifecycle.close,
    });
  } catch (error) {
    retainConfiguredConstructionCleanup(constructionCleanupOwner, lifecycle);
    throw error;
  }
}

function testCliProviderFactory(value) {
  const dependencies = exactConfig(
    value,
    new Set(["supervisedCliProviderFactory"]),
    "configured brain router test dependencies",
  );
  if (typeof dependencies.supervisedCliProviderFactory !== "function") {
    throw new TypeError(
      "configured brain router test CLI provider factory is invalid",
    );
  }
  return dependencies.supervisedCliProviderFactory;
}

export function createConfiguredBrainRouter(options = {}) {
  if (arguments.length > 1) {
    throw new TypeError(
      "Production configured brain routing does not accept replacement CLI provider factories",
    );
  }
  return configuredBrainRouter(
    options,
    productionSupervisedCliProviderFactory,
    productionSupervisedCliCapability,
    { requireConstructionCleanupOwner: true },
  );
}

export function createTestConfiguredBrainRouter(
  options = {},
  testDependencies = {},
) {
  return configuredBrainRouter(
    options,
    testCliProviderFactory(testDependencies),
    testSupervisedCliRuntimeFacts,
  );
}

function roleOptions(id, value) {
  if (!SAFE_ROLE_ID.test(id) || id === "pr-reviewer") {
    throw new TypeError(`configured role id is invalid: ${id}`);
  }
  const config = exactConfig(value, ROLE_KEYS, `employees.roles.${id}`);
  if (typeof config.initialPaused !== "boolean") {
    throw new TypeError(`employees.roles.${id}.initialPaused is invalid`);
  }
  return config;
}

function configuredWorkforce({
  brainProviders = {},
  roles = {},
  store,
  onRun = async () => {},
  waitForModelCapacity = false,
  clock,
  actionAdmissionGate,
  dependencies = {},
  constructionCleanupOwner: rawConstructionCleanupOwner,
} = {}, brainRouterFactory) {
  if (typeof onRun !== "function") throw new TypeError("onRun is invalid");
  if (typeof waitForModelCapacity !== "boolean") throw new TypeError("waitForModelCapacity is invalid");
  const constructionCleanupOwner = configuredConstructionCleanupOwner(
    rawConstructionCleanupOwner,
  );
  let brainRouter = null;
  try {
    brainRouter = brainRouterFactory({
      brainProviders,
      dependencies,
      ...(constructionCleanupOwner === null
        ? {}
        : { constructionCleanupOwner }),
    });
    const employees = [];
    const workers = [];
    for (const [id, rawConfig] of dataEntries(roles, "employees.roles")) {
      const config = roleOptions(id, rawConfig);
      const employee = new ConfiguredRoleEmployee({
        waitForModelCapacity,
        definition: {
          id,
          name: config.name,
          mission: config.mission,
          enabled: config.enabled,
          scheduleMinutes: config.scheduleMinutes,
        },
        permissions: config.permissions,
        brain: config.brain,
        ...(Object.hasOwn(config, "taskBrain")
          ? { taskBrain: config.taskBrain }
          : {}),
        brainRouter,
        ...(actionAdmissionGate === undefined
          ? {}
          : { actionAdmissionGate }),
        store,
        initialPaused: config.initialPaused,
        ...(config.workerId ? { workerId: config.workerId } : {}),
        ...(clock ? { clock } : {}),
        onRun: (input) => onRun(input),
      });
      employees.push(employee);
      workers.push(employee.asRoleWorker());
    }
    return Object.freeze({
      employees: Object.freeze([...employees]),
      workers: Object.freeze([...workers]),
      close: brainRouter.close,
    });
  } catch (error) {
    if (brainRouter !== null) {
      const lifecycle = createCloseLifecycle(
        "Configured workforce cleanup failed",
      );
      lifecycle.admit(brainRouter);
      retainConfiguredConstructionCleanup(constructionCleanupOwner, lifecycle);
    }
    throw error;
  }
}

export function createConfiguredWorkforce(options = {}) {
  if (arguments.length > 1) {
    throw new TypeError(
      "Production configured workforce does not accept replacement CLI provider factories",
    );
  }
  return configuredWorkforce(options, (routerOptions) =>
    configuredBrainRouter(
      routerOptions,
      productionSupervisedCliProviderFactory,
      productionSupervisedCliCapability,
      { requireConstructionCleanupOwner: true },
    ));
}

export function createTestConfiguredWorkforce(
  options = {},
  testDependencies = {},
) {
  const supervisedCliProviderFactory = testCliProviderFactory(testDependencies);
  return configuredWorkforce(options, (routerOptions) =>
    configuredBrainRouter(
      routerOptions,
      supervisedCliProviderFactory,
      testSupervisedCliRuntimeFacts,
    ),
  );
}
