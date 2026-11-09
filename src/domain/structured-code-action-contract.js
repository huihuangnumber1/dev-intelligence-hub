const DEFAULT_MAXIMUM_BYTES = 128 * 1024;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PATH_TEXT_PATTERN = "^[^\\u0000-\\u001f\\u007f]*$";
const VALID_TEXT_PATTERN =
  "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$";
const NONEMPTY_TEXT_PATTERN =
  "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*" +
  "[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]" +
  "[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$";

export const CODE_BRAIN_ACTION_TYPES = Object.freeze([
  "list_files",
  "read_text",
  "search_text",
  "write_text",
  "run_profile",
  "complete",
]);

export class StructuredCodeActionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "StructuredCodeActionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function contractError(code, message, statusCode) {
  return new StructuredCodeActionError(code, message, statusCode);
}

function stringSchema(maxLength, { minimum = 1, pattern } = {}) {
  return {
    type: "string",
    minLength: minimum,
    maxLength,
    pattern: pattern ?? NONEMPTY_TEXT_PATTERN,
  };
}

function actionSchema(type, fields = {}) {
  const properties = { type: { type: "string", const: type }, ...fields };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const pathSchema = stringSchema(1_024, {
  minimum: 0,
  pattern: PATH_TEXT_PATTERN,
});
const evidenceSchema = {
  type: "array",
  maxItems: 20,
  uniqueItems: true,
  items: stringSchema(2_048),
};

export const CODE_ACTION_DECISION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "confidence", "summary", "reason", "action"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: stringSchema(4_096),
    reason: stringSchema(4_096),
    action: {
      oneOf: [
        actionSchema("list_files", { path: pathSchema }),
        actionSchema("read_text", { path: stringSchema(1_024) }),
        actionSchema("search_text", {
          path: pathSchema,
          query: stringSchema(4_096),
        }),
        actionSchema("write_text", {
          path: stringSchema(1_024),
          content: stringSchema(96 * 1_024, {
            minimum: 0,
            pattern: VALID_TEXT_PATTERN,
          }),
        }),
        actionSchema("run_profile"),
        actionSchema("complete", {
          outcome: stringSchema(4_096),
          evidence: evidenceSchema,
        }),
      ],
    },
  },
});

function exactObject(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return value;
}

function boundedText(value, maximumBytes, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    INVALID_TEXT_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return value;
}

function boundedPath(value, { allowEmpty = false } = {}) {
  const path = boundedText(value, 1_024, { allowEmpty });
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return path;
}

function safeInteger(value, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return value;
}

function evidence(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 20 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  const result = value.map((entry) => boundedText(entry, 2_048));
  if (new Set(result).size !== result.length) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return result;
}

function normalizeAction(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  const type =
    typeDescriptor?.enumerable && "value" in typeDescriptor
      ? typeDescriptor.value
      : null;
  if (!CODE_BRAIN_ACTION_TYPES.includes(type)) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  if (type === "list_files" || type === "read_text") {
    exactObject(value, ["type", "path"]);
    return {
      type,
      path: boundedPath(value.path, {
        allowEmpty: type === "list_files",
      }),
    };
  }
  if (type === "search_text") {
    exactObject(value, ["type", "path", "query"]);
    return {
      type,
      path: boundedPath(value.path, { allowEmpty: true }),
      query: boundedText(value.query, 4_096),
    };
  }
  if (type === "write_text") {
    exactObject(value, ["type", "path", "content"]);
    return {
      type,
      path: boundedPath(value.path),
      content: boundedText(value.content, 96 * 1_024, { allowEmpty: true }),
    };
  }
  if (type === "run_profile") {
    exactObject(value, ["type"]);
    return { type };
  }
  exactObject(value, ["type", "outcome", "evidence"]);
  return {
    type,
    ...normalizeCodeCompletionReport({ outcome: value.outcome, evidence: value.evidence }),
  };
}

export function normalizeCodeCompletionReport(value) {
  exactObject(value, ["outcome", "evidence"]);
  return { outcome: boundedText(value.outcome, 4_096), evidence: evidence(value.evidence) };
}

export function normalizeStructuredCodeActionDecision(value) {
  exactObject(value, [
    "schemaVersion",
    "confidence",
    "summary",
    "reason",
    "action",
  ]);
  if (value.schemaVersion !== 1) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return {
    schemaVersion: 1,
    confidence: safeInteger(value.confidence, 0, 100),
    summary: boundedText(value.summary, 4_096),
    reason: boundedText(value.reason, 4_096),
    action: normalizeAction(value.action),
  };
}

function maximumBytesFrom(value = {}) {
  exactObject(value, Object.hasOwn(value, "maximumBytes") ? ["maximumBytes"] : []);
  const maximumBytes = value.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new TypeError("maximumBytes is outside the supported range");
  }
  return maximumBytes;
}

export function parseStructuredCodeActionDecision(text, options = {}) {
  const maximumBytes = maximumBytesFrom(options);
  if (typeof text !== "string") {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw contractError(
      "STRUCTURED_CODE_ACTION_TOO_LARGE",
      "Structured code action exceeds the configured limit",
      413,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw contractError(
      "STRUCTURED_CODE_ACTION_INVALID",
      "Structured code action is invalid",
    );
  }
  return normalizeStructuredCodeActionDecision(value);
}
