import { createHash } from "node:crypto";
import { requiresBrainMaintenance } from "./brain-failure-recovery.js";

const REQUEST_TYPES = new Set([
  "ask_user",
  "clarify_requirement",
  "resolve_routing_gap",
]);
const ANSWER_TYPES = new Set(["text", "choice", "reject", "later"]);
const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const REQUEST_ID = /^attention-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CANONICAL_ENTRIES = 20_000;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_STRING_BYTES = 64 * 1024;

export class AttentionInboxError extends Error {
  constructor(code, message, statusCode = 400, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AttentionInboxError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function attentionError(code, message, statusCode = 400, options) {
  return new AttentionInboxError(code, message, statusCode, options);
}

function invalidRequest(message = "内部请示请求无效") {
  return attentionError("INVALID_ATTENTION_REQUEST", message);
}

function invalidResponse(message = "内部请示回答无效") {
  return attentionError("INVALID_ATTENTION_RESPONSE", message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function attentionDataEntries(value, error = invalidRequest()) {
  if (!isPlainObject(value)) throw error;
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function assertAttentionExactKeys(value, expected, error = invalidRequest()) {
  const keys = attentionDataEntries(value, error).map(([key]) => key);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

export function assertAttentionAllowedKeys(
  value,
  allowed,
  required,
  error = invalidRequest(),
) {
  const keys = attentionDataEntries(value, error).map(([key]) => key);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

export function boundedAttentionText(
  value,
  name,
  { minimumBytes = 1, maximumBytes = 256, pattern = null, error = invalidRequest() } = {},
) {
  if (typeof value !== "string" || INVALID_TEXT_CONTROL.test(value)) {
    throw error;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

export function safeAttentionInteger(
  value,
  name,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, error = invalidRequest() } = {},
) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw error;
  }
  return value;
}

export function attentionArrayValues(
  value,
  maximumLength,
  error = invalidRequest(),
) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes("length")
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function canonicalize(
  value,
  context = { depth: 0, entries: { count: 0 }, ancestors: new Set() },
) {
  context.entries.count += 1;
  if (
    context.entries.count > MAX_CANONICAL_ENTRIES ||
    context.depth > MAX_CANONICAL_DEPTH
  ) {
    throw invalidRequest("内部请示内容过大或嵌套过深");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return boundedAttentionText(value, "JSON string", {
      minimumBytes: 0,
      maximumBytes: MAX_CANONICAL_STRING_BYTES,
    });
  }
  if (value === null || typeof value !== "object" || context.ancestors.has(value)) {
    throw invalidRequest("内部请示内容必须是无环纯 JSON");
  }
  context.ancestors.add(value);
  const childContext = {
    depth: context.depth + 1,
    entries: context.entries,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      return attentionArrayValues(value, MAX_CANONICAL_ENTRIES).map((entry) =>
        canonicalize(entry, childContext),
      );
    }
    const result = {};
    for (const [key, entry] of attentionDataEntries(value).sort(
      ([left], [right]) => left.localeCompare(right, "en"),
    )) {
      if (Buffer.byteLength(key, "utf8") > 128) {
        throw invalidRequest("内部请示字段名过长");
      }
      result[key] = canonicalize(entry, childContext);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

export function cloneAttentionValue(value) {
  return canonicalize(value);
}

export function attentionDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function deepFreezeAttentionValue(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeAttentionValue(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreezeAttentionValue(entry);
  }
  return Object.freeze(value);
}

export function normalizeAttentionTimestamp(value, error = invalidRequest()) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw error;
  }
  return timestamp;
}

function normalizeProducer(value, error = invalidRequest()) {
  assertAttentionExactKeys(value, ["roleId", "workItemId"], error);
  return {
    roleId: boundedAttentionText(value.roleId, "producer.roleId", {
      maximumBytes: 128,
      pattern: SAFE_TOKEN,
      error,
    }),
    workItemId: boundedAttentionText(value.workItemId, "producer.workItemId", {
      maximumBytes: 256,
      error,
    }),
  };
}

function normalizeContext(value, error = invalidRequest()) {
  return attentionArrayValues(value, 20, error).map((entry) => {
    assertAttentionExactKeys(entry, ["label", "value"], error);
    return {
      label: boundedAttentionText(entry.label, "context.label", {
        maximumBytes: 128,
        error,
      }),
      value: boundedAttentionText(entry.value, "context.value", {
        minimumBytes: 0,
        maximumBytes: 2_048,
        error,
      }),
    };
  });
}

function normalizeChoices(value, error = invalidRequest()) {
  const choices = attentionArrayValues(value, 20, error).map((entry) => {
    assertAttentionAllowedKeys(
      entry,
      ["id", "label", "description"],
      ["id", "label"],
      error,
    );
    return {
      id: boundedAttentionText(entry.id, "choice.id", {
        maximumBytes: 128,
        pattern: SAFE_TOKEN,
        error,
      }),
      label: boundedAttentionText(entry.label, "choice.label", {
        maximumBytes: 256,
        error,
      }),
      ...(Object.hasOwn(entry, "description")
        ? {
            description: boundedAttentionText(
              entry.description,
              "choice.description",
              { minimumBytes: 0, maximumBytes: 1_024, error },
            ),
          }
        : {}),
    };
  });
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw error;
  }
  return choices;
}

export function normalizeAttentionRequest(value) {
  const error = invalidRequest();
  assertAttentionAllowedKeys(
    value,
    ["requestKey", "type", "producer", "question", "context", "choices", "recoveryCode"],
    ["requestKey", "type", "producer", "question"],
    error,
  );
  if (!REQUEST_TYPES.has(value.type)) throw error;
  if (Object.hasOwn(value, "recoveryCode") && value.recoveryCode !== null &&
      !requiresBrainMaintenance(value.recoveryCode)) throw error;
  const request = {
    requestKey: boundedAttentionText(value.requestKey, "requestKey", {
      maximumBytes: 128,
      pattern: SAFE_TOKEN,
      error,
    }),
    type: value.type,
    ...(Object.hasOwn(value, "recoveryCode") ? { recoveryCode: value.recoveryCode } : {}),
    producer: normalizeProducer(value.producer, error),
    question: boundedAttentionText(value.question, "question", {
      maximumBytes: 4_096,
      error,
    }),
    context: normalizeContext(
      Object.hasOwn(value, "context") ? value.context : [],
      error,
    ),
    choices: normalizeChoices(
      Object.hasOwn(value, "choices") ? value.choices : [],
      error,
    ),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
    throw error;
  }
  return request;
}

function normalizeAnswer(value, error) {
  if (!isPlainObject(value) || !ANSWER_TYPES.has(value.type)) throw error;
  switch (value.type) {
    case "text":
      assertAttentionExactKeys(value, ["type", "text"], error);
      return {
        type: "text",
        text: boundedAttentionText(value.text, "answer.text", {
          maximumBytes: 4_096,
          error,
        }),
      };
    case "choice":
      assertAttentionExactKeys(value, ["type", "choiceId"], error);
      return {
        type: "choice",
        choiceId: boundedAttentionText(value.choiceId, "answer.choiceId", {
          maximumBytes: 128,
          pattern: SAFE_TOKEN,
          error,
        }),
      };
    case "reject":
      assertAttentionExactKeys(value, ["type", "reason"], error);
      return {
        type: "reject",
        reason: boundedAttentionText(value.reason, "answer.reason", {
          minimumBytes: 0,
          maximumBytes: 1_024,
          error,
        }),
      };
    case "later":
      assertAttentionExactKeys(value, ["type"], error);
      return { type: "later" };
    default:
      throw error;
  }
}

export function normalizeAttentionAnswer(value) {
  return normalizeAnswer(value, invalidResponse());
}

export function normalizeAttentionBrowserResponse(value) {
  const error = invalidResponse();
  assertAttentionExactKeys(
    value,
    ["requestId", "expectedRevision", "contentDigest", "answer"],
    error,
  );
  return {
    requestId: boundedAttentionText(value.requestId, "requestId", {
      maximumBytes: 74,
      pattern: REQUEST_ID,
      error,
    }),
    expectedRevision: safeAttentionInteger(value.expectedRevision, "expectedRevision", {
      minimum: 1,
      error,
    }),
    contentDigest: boundedAttentionText(value.contentDigest, "contentDigest", {
      maximumBytes: 64,
      pattern: SHA256,
      error,
    }),
    answer: normalizeAnswer(value.answer, error),
  };
}

export function normalizeAttentionId(value, name = "requestId") {
  return boundedAttentionText(value, name, {
    maximumBytes: 74,
    pattern: REQUEST_ID,
  });
}

export function normalizeAttentionDigest(value, name = "contentDigest") {
  return boundedAttentionText(value, name, {
    maximumBytes: 64,
    pattern: SHA256,
  });
}
