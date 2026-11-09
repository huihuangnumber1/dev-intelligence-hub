import { isDeepStrictEqual, types as utilTypes } from "node:util";

import {
  conflictPreparationBindingMatchesPullRequest,
  conflictPreparationWritablePaths,
  normalizeConflictPreparationBinding,
} from "./conflict-preparation-binding.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import { CodeExecutionPolicy, normalizeWorkspacePath } from "./code-execution-policy.js";
import { normalizeCiRepairEvidence } from "./ci-repair-evidence.js";

const SOURCE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "inputBinding",
  "preparationBinding",
  "writeScope",
]);
const REVIEW_REPAIR_KEYS = Object.freeze([
  "schemaVersion", "kind", "inputBinding", "writeScope",
]);
const CI_REPAIR_KEYS = Object.freeze([...REVIEW_REPAIR_KEYS, "ciEvidence"]);

export function isHeadRepairExecutionSource(value) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  return ['review_repair', 'ci_repair'].includes(Object.getOwnPropertyDescriptor(value, 'kind')?.value);
}
const WRITE_SCOPE_KEYS = Object.freeze(["mode", "paths"]);
const MAX_EXECUTION_PATH_BYTES = 512;
const MAX_EXECUTION_SEGMENT_BYTES = 255;
const CONTROL_CHARACTER = /\p{Cc}/u;

export class CodeExecutionSourceError extends Error {
  constructor(message = "代码执行来源无效", cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodeExecutionSourceError";
    this.code = "INVALID_CODE_EXECUTION_SOURCE";
  }
}

function invalid(message, cause) {
  return new CodeExecutionSourceError(message, cause);
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const result = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    result.push([key, descriptor.value]);
  }
  return result;
}

function exact(value, keys, error) {
  const entries = dataEntries(value, error);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !entries.some(([actual]) => actual === key))
  ) {
    throw error;
  }
  return new Map(entries);
}

function exactStringArray(value, expected, error) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expected.length ||
    Reflect.ownKeys(value).some((key) =>
      key !== "length" &&
      (!/^\d+$/u.test(String(key)) || Number(key) >= value.length)
    )
  ) {
    throw error;
  }
  return expected.map((expectedPath, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      descriptor.value !== expectedPath
    ) {
      throw error;
    }
    return expectedPath;
  });
}

function normalizeReviewPaths(value, error) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
      value.length < 1 || value.length > 64) throw error;
  if (Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) throw error;
  const values = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    return descriptor.value;
  });
  const paths = values.map((entry) => {
    const normalized = normalizeWorkspacePath(entry);
    if (normalized !== entry || CONTROL_CHARACTER.test(entry) ||
        Buffer.byteLength(entry, "utf8") > MAX_EXECUTION_PATH_BYTES ||
        entry.split("/").some((segment) =>
          Buffer.byteLength(segment, "utf8") > MAX_EXECUTION_SEGMENT_BYTES)) {
      throw error;
    }
    return normalized;
  });
  if (new Set(paths).size !== paths.length) throw error;
  const policy = new CodeExecutionPolicy({ writablePaths: paths });
  for (const entry of paths) policy.assertWritable(entry);
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

function normalize(value, error) {
  const kind = new Map(dataEntries(value, error)).get("kind");
  const source = exact(value, kind === "ci_repair" ? CI_REPAIR_KEYS : kind === "review_repair" ? REVIEW_REPAIR_KEYS : SOURCE_KEYS, error);
  if (
    source.get("schemaVersion") !== 1 ||
    !["conflict_preparation", "review_repair", "ci_repair"].includes(kind)
  ) {
    throw error;
  }

  const inputBinding = normalizePullRequestExecutionBinding(
    source.get("inputBinding"),
    error,
  );
  if (inputBinding.schemaVersion !== 2) throw error;
  if (isHeadRepairExecutionSource(value)) {
    const scope = exact(source.get("writeScope"), WRITE_SCOPE_KEYS, error);
    if (scope.get("mode") !== "configured_paths") throw error;
    const ciEvidence = kind === 'ci_repair' ? normalizeCiRepairEvidence(source.get('ciEvidence')) : null;
    if (ciEvidence && (ciEvidence.repository !== inputBinding.repository || ciEvidence.number !== inputBinding.pullRequestNumber ||
        ciEvidence.headRefOid !== inputBinding.headRefOid || ciEvidence.headRefName !== inputBinding.gitTarget.headRefName)) throw error;
    return {
      schemaVersion: 1,
      kind,
      inputBinding,
      ...(ciEvidence === null ? {} : { ciEvidence }),
      writeScope: { mode: "configured_paths", paths: normalizeReviewPaths(scope.get("paths"), error) },
    };
  }
  const preparationBinding = normalizeConflictPreparationBinding(
    source.get("preparationBinding"),
    error,
  );
  if (
    !conflictPreparationBindingMatchesPullRequest(
      preparationBinding,
      inputBinding,
    )
  ) {
    throw error;
  }

  const expectedPaths = conflictPreparationWritablePaths(preparationBinding);
  if (
    expectedPaths.some(
      (relativePath) =>
        Buffer.byteLength(relativePath, "utf8") > MAX_EXECUTION_PATH_BYTES ||
        CONTROL_CHARACTER.test(relativePath) ||
        relativePath.split("/").some(
          (segment) =>
            Buffer.byteLength(segment, "utf8") > MAX_EXECUTION_SEGMENT_BYTES,
        ),
    )
  ) {
    throw error;
  }
  const writeScope = exact(
    source.get("writeScope"),
    WRITE_SCOPE_KEYS,
    error,
  );
  if (writeScope.get("mode") !== "exact_files") throw error;
  const paths = exactStringArray(
    writeScope.get("paths"),
    expectedPaths,
    error,
  );

  return {
    schemaVersion: 1,
    kind: "conflict_preparation",
    inputBinding,
    preparationBinding,
    writeScope: { mode: "exact_files", paths },
  };
}

export function createReviewRepairCodeExecutionSource(value) {
  const error = invalid();
  const fields = exact(value, ["inputBinding", "writablePaths"], error);
  return normalizeCodeExecutionSource({
    schemaVersion: 1,
    kind: "review_repair",
    inputBinding: fields.get("inputBinding"),
    writeScope: { mode: "configured_paths", paths: fields.get("writablePaths") },
  }, error);
}

export function createCiRepairCodeExecutionSource(value) {
  const error = invalid();
  const fields = exact(value, ["inputBinding", "writablePaths", "ciEvidence"], error);
  return normalizeCodeExecutionSource({ schemaVersion: 1, kind: "ci_repair", inputBinding: fields.get("inputBinding"),
    ciEvidence: fields.get("ciEvidence"), writeScope: { mode: "configured_paths", paths: fields.get("writablePaths") } }, error);
}

export function normalizeCodeExecutionSource(
  value,
  error = invalid(),
) {
  try {
    return normalize(value, error);
  } catch (cause) {
    if (cause === error) throw error;
    throw error;
  }
}

export function createConflictCodeExecutionSource(value) {
  const error = invalid();
  let entries;
  try {
    entries = exact(value, ["inputBinding", "preparationBinding"], error);
  } catch (cause) {
    if (cause === error) throw error;
    throw invalid(undefined, cause);
  }
  let preparationBinding;
  try {
    preparationBinding = normalizeConflictPreparationBinding(
      entries.get("preparationBinding"),
      error,
    );
  } catch {
    throw error;
  }
  return normalizeCodeExecutionSource(
    {
      schemaVersion: 1,
      kind: "conflict_preparation",
      inputBinding: entries.get("inputBinding"),
      preparationBinding,
      writeScope: {
        mode: "exact_files",
        paths: conflictPreparationWritablePaths(preparationBinding),
      },
    },
    error,
  );
}

export function sameCodeExecutionSource(left, right) {
  try {
    // Storage uses JSON number semantics (-0 becomes 0), while object key order
    // can change during canonical proposal persistence. Validate before cloning.
    const storedLeft = JSON.parse(JSON.stringify(normalizeCodeExecutionSource(left)));
    const storedRight = JSON.parse(JSON.stringify(normalizeCodeExecutionSource(right)));
    return isDeepStrictEqual(storedLeft, storedRight);
  } catch {
    return false;
  }
}

export function codeExecutionSourceWritablePaths(value) {
  return [...normalizeCodeExecutionSource(value).writeScope.paths];
}

export function codeExecutionSourceAllowsWrite(value, path) {
  const { writeScope } = normalizeCodeExecutionSource(value);
  const relativePath = normalizeWorkspacePath(path);
  if (writeScope.mode === "exact_files") {
    return writeScope.paths.includes(relativePath);
  }
  const policy = new CodeExecutionPolicy({ writablePaths: writeScope.paths });
  try {
    policy.assertWritable(relativePath);
    return true;
  } catch {
    return false;
  }
}
