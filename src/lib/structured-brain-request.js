import { types as utilTypes } from "node:util";

import { normalizeSessionKey } from "./session-key.js";
import { normalizeReviewReadTarget } from "../domain/review-read-target.js";
import { isCodeReadContext } from "./code-read-context.js";
import { isCodeExecutionContext } from "./code-execution-context.js";
import { normalizeAdmissionEntityKey } from "./model-admission-identity.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 16;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_MODEL_BYTES = 256;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 20_000;
const MAX_SCHEMA_KEYS = 20_000;
const MAX_SCHEMA_STRING_BYTES = 1024 * 1024;
const MAX_CONTAINER_KEYS = 4_096;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const INVALID_MESSAGE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
const REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export class StructuredBrainRequestError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "StructuredBrainRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requestTooLargeError() {
  return new StructuredBrainRequestError(
    "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
    "Structured provider request exceeds the configured limit",
    413,
  );
}

function exactDataObject(value, expectedKeys, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(message);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(message);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(message);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function readStructuredBrainGenerateInput(rawRequest) {
  if (
    rawRequest === null ||
    typeof rawRequest !== "object" ||
    Array.isArray(rawRequest) ||
    utilTypes.isProxy(rawRequest) ||
    Object.getPrototypeOf(rawRequest) !== Object.prototype
  ) {
    throw new TypeError("structured request is invalid");
  }
  const keys = Reflect.ownKeys(rawRequest);
  const required = ["model", "messages", "schema"];
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) =>
      typeof key !== "string" ||
      ![...required, "reasoningEffort", "sessionKey", "admissionEntityKey", "signal", "reviewTarget", "codeReadContext", "codeExecutionContext"].includes(key)
    ) ||
    keys.length > required.length + 7
  ) {
    throw new TypeError("structured request is invalid");
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(rawRequest, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("structured request is invalid");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze({
    model: result.model,
    reasoningEffort: result.reasoningEffort ?? null,
    sessionKey: result.sessionKey ?? null,
    admissionEntityKey: result.admissionEntityKey ?? null,
    messages: result.messages,
    schema: result.schema,
    signal: result.signal ?? null,
    reviewTarget: result.reviewTarget ?? null,
    codeReadContext: result.codeReadContext ?? null,
    codeExecutionContext: result.codeExecutionContext ?? null,
  });
}

function maximumRequestBytes(options) {
  const normalized = exactDataObject(
    options,
    ["maxRequestBytes"],
    "structured request options are invalid",
  );
  if (
    !Number.isSafeInteger(normalized.maxRequestBytes) ||
    normalized.maxRequestBytes < 1 ||
    normalized.maxRequestBytes > MAX_REQUEST_BYTES
  ) {
    throw new TypeError("maxRequestBytes is outside the supported range");
  }
  return normalized.maxRequestBytes;
}

function safeText(value, name, maximumBytes, invalidControl = INVALID_CONTROL) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    invalidControl.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeMessages(value) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > MAX_MESSAGES
  ) {
    throw new TypeError("messages are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError("messages are invalid");
  }
  const messages = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!entry?.enumerable || !("value" in entry)) {
      throw new TypeError("messages are invalid");
    }
    const message = exactDataObject(
      entry.value,
      ["role", "content"],
      "messages are invalid",
    );
    if (!MESSAGE_ROLES.has(message.role)) {
      throw new TypeError("messages are invalid");
    }
    messages.push({
      role: message.role,
      content: safeText(
        message.content, "message.content", MAX_MESSAGE_BYTES, INVALID_MESSAGE_CONTROL,
      ),
    });
  }
  return messages;
}

function schemaBudget() {
  return {
    nodes: MAX_SCHEMA_NODES,
    keys: MAX_SCHEMA_KEYS,
    stringBytes: MAX_SCHEMA_STRING_BYTES,
  };
}

function consumeSchemaBudget(budget, { keys = 0, stringBytes = 0 } = {}) {
  budget.nodes -= 1;
  budget.keys -= keys;
  budget.stringBytes -= stringBytes;
  if (budget.nodes < 0 || budget.keys < 0 || budget.stringBytes < 0) {
    throw new TypeError("schema is invalid");
  }
}

function cloneSchemaData(
  value,
  depth = 0,
  budget = schemaBudget(),
  ancestors = new Set(),
) {
  if (depth > MAX_SCHEMA_DEPTH) throw new TypeError("schema is invalid");
  if (value === null || typeof value === "boolean") {
    consumeSchemaBudget(budget);
    return value;
  }
  if (typeof value === "string") {
    consumeSchemaBudget(budget, {
      stringBytes: Buffer.byteLength(value, "utf8"),
    });
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("schema is invalid");
    consumeSchemaBudget(budget);
    return value;
  }
  if (
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    ancestors.has(value)
  ) {
    throw new TypeError("schema is invalid");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_CONTAINER_KEYS
      ) {
        throw new TypeError("schema is invalid");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw new TypeError("schema is invalid");
      }
      consumeSchemaBudget(budget, { keys: value.length });
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("schema is invalid");
        }
        result.push(
          cloneSchemaData(descriptor.value, depth + 1, budget, ancestors),
        );
      }
      return result;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("schema is invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_CONTAINER_KEYS) {
      throw new TypeError("schema is invalid");
    }
    let keyBytes = 0;
    for (const key of keys) {
      if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
        throw new TypeError("schema is invalid");
      }
      keyBytes += Buffer.byteLength(key, "utf8");
      if (keyBytes > MAX_SCHEMA_STRING_BYTES) {
        throw new TypeError("schema is invalid");
      }
    }
    consumeSchemaBudget(budget, { keys: keys.length, stringBytes: keyBytes });
    const entries = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("schema is invalid");
      }
      entries.push([
        key,
        cloneSchemaData(descriptor.value, depth + 1, budget, ancestors),
      ]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeSchema(value) {
  const normalized = cloneSchemaData(value);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    throw new TypeError("schema is invalid");
  }
  return normalized;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeStructuredBrainRequest(rawRequest, options) {
  const maxRequestBytes = maximumRequestBytes(options);
  const hasOwnPlainDataField = (key) =>
    rawRequest !== null &&
    typeof rawRequest === "object" &&
    !Array.isArray(rawRequest) &&
    !utilTypes.isProxy(rawRequest) &&
    Object.getPrototypeOf(rawRequest) === Object.prototype &&
    Object.hasOwn(rawRequest, key);
  const hasReasoningEffort = hasOwnPlainDataField("reasoningEffort");
  const hasSessionKey = hasOwnPlainDataField("sessionKey");
  const hasAdmissionEntityKey = hasOwnPlainDataField("admissionEntityKey");
  const hasReviewTarget = hasOwnPlainDataField("reviewTarget");
  const hasCodeReadContext = hasOwnPlainDataField("codeReadContext");
  const hasCodeExecutionContext = hasOwnPlainDataField("codeExecutionContext");
  const request = exactDataObject(
    rawRequest,
    [
      "model",
      ...(hasReasoningEffort ? ["reasoningEffort"] : []),
      ...(hasSessionKey ? ["sessionKey"] : []),
      ...(hasAdmissionEntityKey ? ["admissionEntityKey"] : []),
      ...(hasReviewTarget ? ["reviewTarget"] : []),
      ...(hasCodeReadContext ? ["codeReadContext"] : []),
      ...(hasCodeExecutionContext ? ["codeExecutionContext"] : []),
      "messages",
      "schema",
    ],
    "structured request is invalid",
  );
  if (
    hasReasoningEffort &&
    !REASONING_EFFORTS.has(request.reasoningEffort)
  ) {
    throw new TypeError("reasoningEffort is invalid");
  }
  if (hasCodeReadContext && (!isCodeReadContext(request.codeReadContext) || hasReviewTarget)) {
    throw new TypeError("codeReadContext is invalid");
  }
  if (hasCodeExecutionContext && (!isCodeExecutionContext(request.codeExecutionContext) || hasReviewTarget || hasCodeReadContext)) {
    throw new TypeError("codeExecutionContext is invalid");
  }
  const normalized = {
    model: safeText(request.model, "model", MAX_MODEL_BYTES),
    ...(hasReasoningEffort
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
    ...(hasSessionKey
      ? { sessionKey: normalizeSessionKey(request.sessionKey) }
      : {}),
    ...(hasAdmissionEntityKey ? { admissionEntityKey: normalizeAdmissionEntityKey(request.admissionEntityKey) } : {}),
    messages: normalizeMessages(request.messages),
    ...(hasReviewTarget ? { reviewTarget: normalizeReviewReadTarget(request.reviewTarget) } : {}),
    ...(hasCodeReadContext ? { codeReadContext: request.codeReadContext } : {}),
    ...(hasCodeExecutionContext ? { codeExecutionContext: request.codeExecutionContext } : {}),
    schema: normalizeSchema(request.schema),
  };
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8") > maxRequestBytes
  ) {
    throw requestTooLargeError();
  }
  return deepFreeze(normalized);
}
