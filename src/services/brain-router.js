import { createHash } from "node:crypto";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { admissionEntityKeyForRequest, normalizeAdmissionEntityKey } from "../lib/model-admission-identity.js";
import { normalizeSessionKey } from "../lib/session-key.js";
import { isCodeReadContext } from "../lib/code-read-context.js";
import { isCodeExecutionContext } from "../lib/code-execution-context.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const DATA_CLASSES = Object.freeze(["requirements", "code", "memory"]);
const EXTENDED_DATA_CLASSES = Object.freeze([...DATA_CLASSES, "dingtalk"]);
const REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export class BrainRouterError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "BrainRouterError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function routerError(code, message, statusCode) {
  return new BrainRouterError(code, message, statusCode);
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

function exactData(value, keys, name) {
  const entries = dataEntries(value, name);
  const actual = new Set(entries.map(([key]) => key));
  if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(entries);
}

function safeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeModel(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new TypeError("brain.model is invalid");
  }
  return value;
}

function normalizeRemoteData(value) {
  const entries = dataEntries(value, "brain.remoteData");
  const keys = new Set(entries.map(([key]) => key));
  const isLegacyShape = DATA_CLASSES.length === keys.size && DATA_CLASSES.every((key) => keys.has(key));
  const isExtendedShape = EXTENDED_DATA_CLASSES.length === keys.size && EXTENDED_DATA_CLASSES.every((key) => keys.has(key));
  if (!isLegacyShape && !isExtendedShape) {
    throw new TypeError("brain.remoteData is invalid");
  }
  const normalized = {
    ...Object.fromEntries(entries),
    dingtalk: isExtendedShape ? Object.fromEntries(entries).dingtalk : false,
  };
  if (EXTENDED_DATA_CLASSES.some((name) => typeof normalized[name] !== "boolean")) {
    throw new TypeError("brain.remoteData is invalid");
  }
  return Object.freeze(
    Object.fromEntries(EXTENDED_DATA_CLASSES.map((name) => [name, normalized[name]])),
  );
}

export function normalizeBrainConfig(value) {
  const entries = dataEntries(value, "brain");
  const actual = new Set(entries.map(([key]) => key));
  const required = ["provider", "model", "remoteData"];
  const allowed = new Set([...required, "reasoningEffort"]);
  if (
    required.some((key) => !actual.has(key)) ||
    [...actual].some((key) => !allowed.has(key))
  ) {
    throw new TypeError("brain is invalid");
  }
  const config = Object.fromEntries(entries);
  if (
    Object.hasOwn(config, "reasoningEffort") &&
    !REASONING_EFFORTS.has(config.reasoningEffort)
  ) {
    throw new TypeError("brain.reasoningEffort is invalid");
  }
  return Object.freeze({
    provider: safeId(config.provider, "brain.provider"),
    model: safeModel(config.model),
    ...(Object.hasOwn(config, "reasoningEffort")
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    remoteData: normalizeRemoteData(config.remoteData),
  });
}

function normalizeDataClasses(value = []) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    value.some((entry) => !EXTENDED_DATA_CLASSES.includes(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("dataClasses are invalid");
  }
  return [...value];
}

function normalizeProvider(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("brain provider is invalid");
  }
  const id = safeId(value.id, "provider.id");
  if (
    typeof value.remote !== "boolean" ||
    typeof value.generate !== "function"
  ) {
    throw new TypeError("brain provider is invalid");
  }
  const attemptDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "singleAttempt",
  );
  const availability = value.checkAvailability;
  const admission = value.withAdmission;
  const quiescence = value.withEntityQuiescence;
  if (quiescence !== undefined && typeof quiescence !== 'function') throw new TypeError('brain provider quiescence is invalid');
  if (admission !== undefined && typeof admission !== 'function') throw new TypeError('brain provider admission is invalid');
  if (
    attemptDescriptor &&
    (!("value" in attemptDescriptor) ||
      typeof attemptDescriptor.value !== "boolean")
  ) {
    throw new TypeError("brain provider is invalid");
  }
  if (availability !== undefined && typeof availability !== "function") {
    throw new TypeError("brain provider is invalid");
  }
  if (
    value.supportsEntitySessions !== undefined &&
    typeof value.supportsEntitySessions !== "boolean"
  ) {
    throw new TypeError("brain provider is invalid");
  }
  if (
    value.supportsEntitySessions === true &&
    (typeof value.sessionIsolationKey !== "string" ||
      !value.sessionIsolationKey.trim() ||
      INVALID_CONTROL.test(value.sessionIsolationKey) ||
      Buffer.byteLength(value.sessionIsolationKey, "utf8") > 128)
  ) {
    throw new TypeError("brain provider session isolation key is invalid");
  }
  return Object.freeze({
    id,
    remote: value.remote,
    singleAttempt: attemptDescriptor?.value === true,
    supportsEntitySessions: value.supportsEntitySessions === true,
    supportsReviewReading: value.supportsReviewReading === true,
    supportsCodeReading: value.supportsCodeReading === true,
    supportsCodeExecution: value.supportsCodeExecution === true,
    supportsNativeReviewSkills: value.supportsNativeReviewSkills === true,
    ...(value.supportsEntitySessions === true
      ? { sessionIsolationKey: value.sessionIsolationKey }
      : {}),
    generate: value.generate.bind(value),
    ...(admission ? {withAdmission:admission.bind(value)} : {}),
    ...(quiescence ? {withEntityQuiescence:quiescence.bind(value)} : {}),
    ...(availability
      ? { checkAvailability: availability.bind(value) }
      : {}),
  });
}

function authorizedSessionKey(entityKey, provider, brain, dataClasses) {
  // Every turn under this key has the same authorization and classified input
  // set. Thus the union of all prior turns' classes remains authorized. A
  // versioned key also leaves older, unattested entity archives untouched.
  const scope = JSON.stringify([
    normalizeSessionKey(entityKey),
    provider.id,
    provider.sessionIsolationKey,
    brain.model,
    brain.reasoningEffort ?? null,
    provider.remote,
    DATA_CLASSES.map((name) => brain.remoteData[name]),
    EXTENDED_DATA_CLASSES.filter((name) => dataClasses.includes(name)),
  ]);
  return `auth-v2:${createHash("sha256").update(scope, "utf8").digest("hex")}`;
}

function frozenDescription(provider, brain) {
  return Object.freeze({
    provider: provider.id,
    model: brain.model,
    ...(brain.reasoningEffort
      ? { reasoningEffort: brain.reasoningEffort }
      : {}),
    remote: provider.remote,
    remoteData: Object.freeze({
      requirements: brain.remoteData.requirements,
      code: brain.remoteData.code,
      memory: brain.remoteData.memory,
      ...(brain.remoteData.dingtalk ? { dingtalk: true } : {}),
    }),
    ...(provider.singleAttempt ? { singleAttempt: true } : {}),
    ...(provider.supportsReviewReading ? { supportsReviewReading: true } : {}),
    ...(provider.supportsCodeReading ? { supportsCodeReading: true } : {}),
    ...(provider.supportsCodeExecution ? { supportsCodeExecution: true } : {}),
    ...(provider.supportsNativeReviewSkills ? { supportsNativeReviewSkills: true } : {}),
  });
}

export class BrainRouter {
  #providers;

  constructor({ providers = [] } = {}) {
    if (
      !Array.isArray(providers) ||
      Object.getPrototypeOf(providers) !== Array.prototype
    ) {
      throw new TypeError("providers are invalid");
    }
    this.#providers = new Map();
    for (const value of providers) {
      const provider = normalizeProvider(value);
      if (this.#providers.has(provider.id)) {
        throw new TypeError(`brain provider is duplicated: ${provider.id}`);
      }
      this.#providers.set(provider.id, provider);
    }
    Object.freeze(this);
  }

  async generate({
    brain: brainValue,
    messages,
    schema,
    dataClasses = [],
    sessionKey: sessionKeyValue = null,
    admissionEntityKey: admissionEntityKeyValue = null,
    signal = null,
    reviewTarget = null,
    codeReadContext = null,
    codeExecutionContext = null,
  } = {}) {
    const brain = normalizeBrainConfig(brainValue);
    const provider = this.#provider(brain.provider);
    const classes = normalizeDataClasses(dataClasses);
    if (reviewTarget !== null && !classes.includes("code")) {
      throw routerError("REMOTE_DATA_CLASSIFICATION_REQUIRED", "PR reading requires code classification", 403);
    }
    if (codeReadContext !== null &&
        (!isCodeReadContext(codeReadContext) || !classes.includes("code"))) {
      throw routerError("REMOTE_DATA_CLASSIFICATION_REQUIRED", "Code reading requires trusted code classification", 403);
    }
    if (codeExecutionContext !== null &&
        (!isCodeExecutionContext(codeExecutionContext) || !classes.includes("code") || reviewTarget !== null || codeReadContext !== null)) {
      throw routerError("REMOTE_DATA_CLASSIFICATION_REQUIRED", "Code execution requires a trusted isolated code context", 403);
    }
    if (codeReadContext !== null && !provider.supportsCodeReading) {
      throw routerError("CODE_READING_UNAVAILABLE", "Brain does not support controlled code reading", 503);
    }
    if (codeExecutionContext !== null && !provider.supportsCodeExecution) {
      throw routerError("CODE_EXECUTION_UNAVAILABLE", "Brain does not support continuous controlled code execution", 503);
    }
    const requestSignal = normalizeAbortSignal(signal);
    if (requestSignal?.aborted) {
      throw routerError(
        "BRAIN_REQUEST_CANCELLED",
        "Brain request was cancelled",
        499,
      );
    }
    if (provider.remote) {
      if (classes.length === 0) {
        throw routerError(
          "REMOTE_DATA_CLASSIFICATION_REQUIRED",
          "Remote brain requires explicit data classification",
          403,
        );
      }
      const denied = classes.find((name) => brain.remoteData[name] !== true);
      if (denied) {
        throw routerError(
          "REMOTE_DATA_NOT_AUTHORIZED",
          `Remote brain is not authorized for ${denied} data`,
          403,
        );
      }
    }
    const admissionEntityKey = provider.withAdmission ? admissionEntityKeyForRequest({
      admissionEntityKey: admissionEntityKeyValue, sessionKey: sessionKeyValue, reviewTarget,
    }) : null;
    return provider.generate({
      model: brain.model,
      ...(brain.reasoningEffort
        ? { reasoningEffort: brain.reasoningEffort }
        : {}),
      messages,
      schema,
      ...(reviewTarget !== null && provider.supportsReviewReading ? { reviewTarget } : {}),
      ...(codeReadContext === null ? {} : { codeReadContext }),
      ...(codeExecutionContext === null ? {} : { codeExecutionContext }),
      ...(admissionEntityKey === null ? {} : { admissionEntityKey }),
      ...(sessionKeyValue === null || !provider.supportsEntitySessions
        ? {}
        : { sessionKey: authorizedSessionKey(sessionKeyValue, provider, brain, classes) }),
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
  }

  async checkAvailability(brainValue, { signal = null } = {}) {
    const brain = normalizeBrainConfig(brainValue);
    const provider = this.#provider(brain.provider);
    const requestSignal = normalizeAbortSignal(signal);
    if (requestSignal?.aborted) {
      throw routerError(
        "BRAIN_REQUEST_CANCELLED",
        "Brain request was cancelled",
        499,
      );
    }
    if (typeof provider.checkAvailability !== "function") return;
    await provider.checkAvailability({
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
  }

  async withAdmission(brainValue, {entityKey, signal = null, waitForCapacity = false} = {}, operation) {
    const brain = normalizeBrainConfig(brainValue);
    const provider = this.#provider(brain.provider);
    const requestSignal = normalizeAbortSignal(signal);
    requestSignal?.throwIfAborted();
    if (typeof operation !== 'function') throw new TypeError('admission operation is invalid');
    if (typeof waitForCapacity !== 'boolean') throw new TypeError('admission wait option is invalid');
    return provider.withAdmission ? provider.withAdmission({entityKey:normalizeAdmissionEntityKey(entityKey),signal:requestSignal,
      ...(waitForCapacity ? {waitForCapacity:true} : {})},operation) : operation();
  }

  async withEntityQuiescence(brainValue, { entityKey, signal = null } = {}, operation) {
    const brain = normalizeBrainConfig(brainValue), provider = this.#provider(brain.provider);
    const requestSignal = normalizeAbortSignal(signal);
    requestSignal?.throwIfAborted();
    if (typeof operation !== 'function') throw new TypeError('quiescence operation is invalid');
    return provider.withEntityQuiescence
      ? provider.withEntityQuiescence({ entityKey: normalizeAdmissionEntityKey(entityKey), signal: requestSignal }, operation)
      : { executed: false };
  }

  describe(brainValue) {
    const brain = normalizeBrainConfig(brainValue);
    return frozenDescription(this.#provider(brain.provider), brain);
  }

  #provider(id) {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw routerError(
        "BRAIN_PROVIDER_NOT_CONFIGURED",
        "Configured brain provider is unavailable",
        503,
      );
    }
    return provider;
  }
}
