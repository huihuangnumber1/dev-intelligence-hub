import { createHash } from "node:crypto";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const WORK_LEDGER_TARGET_TYPES = new Set(["role", "person", "node"]);
export const WORK_LEDGER_STATUSES = new Set([
  "queued",
  "paused",
  "working",
  "dispatch_pending",
  "waiting_user",
  "waiting_condition",
  "waiting_external",
  "retry_wait",
  "completed",
  "superseded",
  "blocked",
  "cancelled",
]);
export const WORK_LEDGER_OUTBOX_STATUSES = new Set([
  "pending",
  "dispatching",
  "delivered",
  "failed",
]);
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function workLedgerError(code, message, statusCode = 400, options = {}) {
  return Object.assign(
    new Error(message, options.cause ? { cause: options.cause } : undefined),
    { code, statusCode },
  );
}

export function isPlainLedgerObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function ledgerDataEntries(value) {
  if (!isPlainLedgerObject(value)) return null;
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function hasExactLedgerKeys(value, expectedKeys) {
  const entries = ledgerDataEntries(value);
  if (!entries || entries.length !== expectedKeys.length) return false;
  const keys = new Set(entries.map(([key]) => key));
  return expectedKeys.every((key) => keys.has(key));
}

export function canonicalLedgerValue(
  value,
  {
    maximumEntries = 20_000,
    maximumDepth = 32,
    maximumStringBytes = 128 * 1024,
    errorCode = "WORK_LEDGER_VALUE_INVALID",
  } = {},
) {
  const budget = { entries: 0 };
  const ancestors = new Set();

  const invalid = (message) => workLedgerError(errorCode, message);
  const visit = (entry, depth) => {
    budget.entries += 1;
    if (budget.entries > maximumEntries || depth > maximumDepth) {
      throw invalid("工作台账数据超过安全结构上限");
    }
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > maximumStringBytes) {
        throw invalid("工作台账字符串超过安全字节上限");
      }
      return entry;
    }
    if (typeof entry !== "object" || ancestors.has(entry)) {
      throw invalid("工作台账数据必须是无环纯 JSON");
    }

    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (
          Object.getPrototypeOf(entry) !== Array.prototype ||
          Reflect.ownKeys(entry).length !== entry.length + 1
        ) {
          throw invalid("工作台账数组必须连续且不含额外字段");
        }
        const result = [];
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, `${index}`);
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw invalid("工作台账数组不能包含访问器");
          }
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }

      const entries = ledgerDataEntries(entry);
      if (!entries) throw invalid("工作台账对象必须是纯数据对象");
      const result = {};
      for (const [key, child] of entries.sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      )) {
        if (
          DANGEROUS_KEYS.has(key) ||
          CONTROL_CHARACTERS.test(key) ||
          Buffer.byteLength(key, "utf8") > 256
        ) {
          throw invalid("工作台账对象包含危险字段");
        }
        result[key] = visit(child, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(entry);
    }
  };

  try {
    return visit(value, 0);
  } catch (error) {
    if (error?.code) throw error;
    throw invalid("工作台账数据无法安全读取");
  }
}

export function ledgerDigest(value, options) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalLedgerValue(value, options)), "utf8")
    .digest("hex");
}

export function contentAddressedLedgerRecord(idName, prefix, content) {
  const normalized = canonicalLedgerValue(content);
  const contentDigest = ledgerDigest(normalized);
  return {
    [idName]: `${prefix}-${contentDigest}`,
    contentDigest,
    ...normalized,
  };
}

export function cloneLedgerValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function boundedLedgerString(value, name, maximumBytes = 256) {
  return boundedLedgerTextValue(value, name, maximumBytes, CONTROL_CHARACTERS);
}

// Task prose uses the same whitespace contract as orchestration intents.
export function boundedLedgerText(value, name, maximumBytes) {
  return boundedLedgerTextValue(value, name, maximumBytes, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
}

function boundedLedgerTextValue(value, name, maximumBytes, invalidControl) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    invalidControl.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw workLedgerError("WORK_LEDGER_VALUE_INVALID", `${name} 无效`);
  }
  return value;
}

export function normalizeLedgerTimestamp(value, name = "timestamp") {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw workLedgerError("WORK_LEDGER_CLOCK_INVALID", `${name} 无效`, 500);
  }
  return timestamp;
}

export function normalizeLedgerTarget(value) {
  if (
    !hasExactLedgerKeys(value, ["type", "id"]) ||
    !WORK_LEDGER_TARGET_TYPES.has(value.type)
  ) {
    throw workLedgerError("WORK_LEDGER_TARGET_INVALID", "工作分派目标无效");
  }
  return {
    type: value.type,
    id: boundedLedgerString(value.id, "target.id", 128),
  };
}

export function prettySerializedLedgerBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function validatePositiveLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

export function normalizeOptionalLedgerReason(value, name = "reason") {
  return value === null || value === undefined
    ? null
    : boundedLedgerString(value, name, 2_000);
}
