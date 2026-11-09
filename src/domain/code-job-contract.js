import {
  digestValue,
  normalizeActionRequest,
} from "./code-executor-contract.js";
import { normalizeWorkspacePath } from "./code-execution-policy.js";
import { normalizeCodeCompletionReport } from "./structured-code-action-contract.js";
import {
  codeExecutionSourceAllowsWrite,
  codeExecutionSourceWritablePaths,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./code-execution-source.js";
import {
  projectNormalizedCodeJobForBrowser,
} from "./code-job-browser-projection.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import {
  CODE_JOB_STATUSES as SHARED_CODE_JOB_STATUSES,
} from "./code-job-vocabulary.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const SAFE_CONFIRMATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ACTION = /^[a-z](?:[a-z_]{0,62}[a-z])?$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MEMORY_RECORD_ID = /^memory-([a-f0-9]{64})$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const CONTROL_CHARACTER = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CODE_OPERATIONS = new Set(["inspect", "modify", "verify"]);
export const CODE_JOB_STATUSES = SHARED_CODE_JOB_STATUSES;
const JOB_STATUSES = new Set(CODE_JOB_STATUSES);
const TERMINAL_JOB_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);
const PAUSABLE_JOB_STATUSES = new Set(["queued", "starting", "active"]);
const CANCELLABLE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
]);
const OBSERVATION_STATUSES = new Set(["succeeded", "failed", "interrupted"]);
const MAX_OBSERVATIONS = 128;
const MAX_DETAIL_BYTES = 128 * 1024;
// Inline model replies keep their smaller transport bound. A trusted host
// edit may preserve a larger file while still fitting this durable limit.
export const CODE_JOB_MAXIMUM_ACTION_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_COLLECTION_SIZE = 10_000;

export const CODE_JOB_ACTIONS_BY_OPERATION = Object.freeze({
  inspect: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "run_profile",
    "complete",
  ]),
  modify: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "write_text",
    "run_profile",
    "complete",
  ]),
  verify: Object.freeze([
    "list_files",
    "read_text",
    "search_text",
    "run_profile",
    "complete",
  ]),
});

export class CodeJobError extends Error {
  constructor(code, message, statusCode = 400, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodeJobError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function codeJobError(code, message, statusCode = 400, options) {
  return new CodeJobError(code, message, statusCode, options);
}

function invalidGrant(message = "代码任务授权无效") {
  return codeJobError("INVALID_CODE_JOB_GRANT", message);
}

function invalidApproval(message = "代码任务批准绑定无效", options) {
  return codeJobError("INVALID_CODE_JOB_APPROVAL", message, 400, options);
}

function invalidJob(message = "代码任务记录无效") {
  return codeJobError("INVALID_CODE_JOB", message);
}

function plainDataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
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

function exactObject(value, expectedKeys, error) {
  const entries = plainDataEntries(value, error);
  if (
    entries.length !== expectedKeys.length ||
    expectedKeys.some((key) => !entries.some(([actual]) => actual === key))
  ) {
    throw error;
  }
  return new Map(entries);
}

function denseArray(value, maximumLength, error, minimumLength = 0) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function text(
  value,
  name,
  { minimumBytes = 1, maximumBytes = 256, pattern = null, error } = {},
) {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) throw error;
  const size = Buffer.byteLength(value, "utf8");
  if (
    size < minimumBytes ||
    size > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

function safeInteger(value, name, { minimum = 0, maximum, error }) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw error;
  }
  return value;
}

function sha256(value, name, error) {
  return text(value, name, {
    maximumBytes: 64,
    pattern: SHA256,
    error,
  });
}

function safeId(value, name, error) {
  return text(value, name, {
    maximumBytes: 64,
    pattern: SAFE_ID,
    error,
  });
}

function safeReference(value, name, maximumBytes, error) {
  return text(value, name, {
    maximumBytes,
    pattern: SAFE_REFERENCE,
    error,
  });
}

function normalizedRepository(value, error) {
  const repository = text(value, "repository", {
    maximumBytes: 140,
    pattern: REPOSITORY,
    error,
  });
  const [, owner, name] = repository.match(REPOSITORY);
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw error;
  }
  return repository;
}

function normalizeRequestedBy(value, error) {
  const entries = exactObject(value, ["roleId", "workItemId"], error);
  return {
    roleId: text(entries.get("roleId"), "requestedBy.roleId", {
      maximumBytes: 128,
      pattern: SAFE_ROLE_ID,
      error,
    }),
    workItemId: text(entries.get("workItemId"), "requestedBy.workItemId", {
      maximumBytes: 256,
      error,
    }),
  };
}

function normalizeSource(value, error) {
  const entries = exactObject(value, ["assignmentId", "eventId"], error);
  return {
    assignmentId: text(entries.get("assignmentId"), "source.assignmentId", {
      maximumBytes: 256,
      error,
    }),
    eventId: text(entries.get("eventId"), "source.eventId", {
      maximumBytes: 256,
      error,
    }),
  };
}

function normalizeSubject(value, error) {
  const entries = exactObject(value, ["id", "repository", "number"], error);
  return {
    id: text(entries.get("id"), "subject.id", {
      maximumBytes: 512,
      error,
    }),
    repository: normalizedRepository(entries.get("repository"), error),
    number: safeInteger(entries.get("number"), "subject.number", {
      minimum: 1,
      error,
    }),
  };
}

function normalizeStringList(
  value,
  name,
  { maximumLength, minimumLength = 0, maximumBytes, error },
) {
  return denseArray(value, maximumLength, error, minimumLength).map((entry) =>
    text(entry, name, { maximumBytes, error }),
  );
}

function normalizeAllowedActions(value, operation, error) {
  const expected = CODE_JOB_ACTIONS_BY_OPERATION[operation];
  const actual = denseArray(value, expected.length, error, expected.length).map(
    (entry) =>
      text(entry, "allowedActions", {
        maximumBytes: 64,
        pattern: SAFE_ACTION,
        error,
      }),
  );
  if (
    new Set(actual).size !== actual.length ||
    expected.some((action) => !actual.includes(action))
  ) {
    throw error;
  }
  return [...expected];
}

function normalizeRequiredProfiles(value, error) {
  const profiles = denseArray(value, 32, error, 1).map((entry) => {
    const fields = exactObject(entry, ["id", "configDigest"], error);
    return {
      id: safeId(fields.get("id"), "requiredProfiles.id", error),
      configDigest: sha256(
        fields.get("configDigest"),
        "requiredProfiles.configDigest",
        error,
      ),
    };
  });
  profiles.sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw error;
  return profiles;
}

function normalizeWritablePaths(value, operation, error) {
  const paths = denseArray(value, 64, error).map((entry) => {
    try {
      return normalizeWorkspacePath(entry);
    } catch {
      throw error;
    }
  });
  paths.sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(paths).size !== paths.length) throw error;
  if (operation === "modify" ? paths.length === 0 : paths.length !== 0) {
    throw error;
  }
  return paths;
}

const LEGACY_GRANT_KEYS = Object.freeze([
  "proposalId",
  "contentDigest",
  "policyVersion",
  "requestedBy",
  "source",
  "subject",
  "repository",
  "workspaceId",
  "workspaceAuthorityDigest",
  "operation",
  "objective",
  "acceptanceCriteria",
  "evidence",
  "summary",
  "reason",
  "allowedActions",
  "writablePaths",
  "requiredProfiles",
  "brainDigest",
]);
const GRANT_KEYS = Object.freeze([
  "schemaVersion",
  ...LEGACY_GRANT_KEYS,
  "inputBinding",
]);
const CONFLICT_GRANT_KEYS = Object.freeze([
  ...GRANT_KEYS,
  "executionSource",
]);
export const CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA = 1;
export const CODE_JOB_TASK_BRAIN_BINDING_SCHEMA = 2;
const TASK_GRANT_KEYS = Object.freeze([
  ...GRANT_KEYS,
  "brainBindingSchema",
]);
const TASK_CONFLICT_GRANT_KEYS = Object.freeze([
  ...CONFLICT_GRANT_KEYS,
  "brainBindingSchema",
]);

function grantKeys(value, error, { digest = false } = {}) {
  const actual = plainDataEntries(value, error).map(([key]) => key);
  const legacy = [
    ...LEGACY_GRANT_KEYS,
    ...(digest ? ["grantDigest"] : []),
  ];
  const current = [...GRANT_KEYS, ...(digest ? ["grantDigest"] : [])];
  const conflict = [
    ...CONFLICT_GRANT_KEYS,
    ...(digest ? ["grantDigest"] : []),
  ];
  const task = [
    ...TASK_GRANT_KEYS,
    ...(digest ? ["grantDigest"] : []),
  ];
  const taskConflict = [
    ...TASK_CONFLICT_GRANT_KEYS,
    ...(digest ? ["grantDigest"] : []),
  ];
  if (
    actual.length === legacy.length &&
    legacy.every((key) => actual.includes(key))
  ) {
    return LEGACY_GRANT_KEYS;
  }
  if (
    actual.length === current.length &&
    current.every((key) => actual.includes(key))
  ) {
    return GRANT_KEYS;
  }
  if (
    actual.length === conflict.length &&
    conflict.every((key) => actual.includes(key))
  ) {
    return CONFLICT_GRANT_KEYS;
  }
  if (
    actual.length === task.length &&
    task.every((key) => actual.includes(key))
  ) {
    return TASK_GRANT_KEYS;
  }
  if (
    actual.length === taskConflict.length &&
    taskConflict.every((key) => actual.includes(key))
  ) {
    return TASK_CONFLICT_GRANT_KEYS;
  }
  throw error;
}

function normalizeInputBinding(value, error) {
  if (value === null) return null;
  try {
    return normalizePullRequestExecutionBinding(value, error);
  } catch {
    throw error;
  }
}

function normalizeGrantContent(value, error) {
  const keys = grantKeys(value, error);
  const entries = exactObject(value, keys, error);
  const current = keys === GRANT_KEYS || keys === TASK_GRANT_KEYS;
  const conflict =
    keys === CONFLICT_GRANT_KEYS || keys === TASK_CONFLICT_GRANT_KEYS;
  const taskBrainBinding =
    keys === TASK_GRANT_KEYS || keys === TASK_CONFLICT_GRANT_KEYS;
  if (
    (current && entries.get("schemaVersion") !== 2) ||
    (conflict && entries.get("schemaVersion") !== 3) ||
    (taskBrainBinding &&
      entries.get("brainBindingSchema") !==
        CODE_JOB_TASK_BRAIN_BINDING_SCHEMA)
  ) {
    throw error;
  }
  const operation = entries.get("operation");
  if (!CODE_OPERATIONS.has(operation)) throw error;
  const repository = normalizedRepository(entries.get("repository"), error);
  const subject = normalizeSubject(entries.get("subject"), error);
  if (subject.repository !== repository) throw error;
  const content = {
    ...(keys === LEGACY_GRANT_KEYS
      ? {}
      : { schemaVersion: current ? 2 : 3 }),
    ...(taskBrainBinding
      ? { brainBindingSchema: CODE_JOB_TASK_BRAIN_BINDING_SCHEMA }
      : {}),
    proposalId: safeReference(
      entries.get("proposalId"),
      "proposalId",
      192,
      error,
    ),
    contentDigest: sha256(entries.get("contentDigest"), "contentDigest", error),
    policyVersion: safeInteger(entries.get("policyVersion"), "policyVersion", {
      minimum: 1,
      error,
    }),
    requestedBy: normalizeRequestedBy(entries.get("requestedBy"), error),
    source: normalizeSource(entries.get("source"), error),
    subject,
    repository,
    workspaceId: safeId(entries.get("workspaceId"), "workspaceId", error),
    workspaceAuthorityDigest: sha256(
      entries.get("workspaceAuthorityDigest"),
      "workspaceAuthorityDigest",
      error,
    ),
    operation,
    objective: text(entries.get("objective"), "objective", {
      maximumBytes: 4_096,
      error,
    }),
    acceptanceCriteria: normalizeStringList(
      entries.get("acceptanceCriteria"),
      "acceptanceCriteria",
      { maximumLength: 20, minimumLength: 1, maximumBytes: 2_048, error },
    ),
    evidence: normalizeStringList(entries.get("evidence"), "evidence", {
      maximumLength: 20,
      maximumBytes: 2_048,
      error,
    }),
    summary: text(entries.get("summary"), "summary", {
      maximumBytes: 2_048,
      error,
    }),
    reason: text(entries.get("reason"), "reason", {
      maximumBytes: 4_096,
      error,
    }),
    allowedActions: normalizeAllowedActions(
      entries.get("allowedActions"),
      operation,
      error,
    ),
    writablePaths: normalizeWritablePaths(
      entries.get("writablePaths"),
      operation,
      error,
    ),
    requiredProfiles: normalizeRequiredProfiles(
      entries.get("requiredProfiles"),
      error,
    ),
    brainDigest: sha256(entries.get("brainDigest"), "brainDigest", error),
  };
  if (keys !== LEGACY_GRANT_KEYS) {
    const inputBinding = normalizeInputBinding(
      entries.get("inputBinding"),
      error,
    );
    if (
      inputBinding !== null &&
      (inputBinding.repository !== content.repository ||
        inputBinding.pullRequestNumber !== content.subject.number ||
        inputBinding.eventId !== content.source.eventId)
    ) {
      throw error;
    }
    content.inputBinding = inputBinding;
  }
  if (conflict) {
    let executionSource;
    try {
      executionSource = normalizeCodeExecutionSource(
        entries.get("executionSource"),
        error,
      );
    } catch {
      throw error;
    }
    if (
      operation !== "modify" ||
      content.inputBinding === null ||
      !sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding: content.inputBinding,
      }) ||
      JSON.stringify(content.writablePaths) !==
        JSON.stringify(codeExecutionSourceWritablePaths(executionSource))
    ) {
      throw error;
    }
    content.executionSource = executionSource;
  }
  return content;
}

export function createCodeJobGrant(value) {
  const content = normalizeGrantContent(value, invalidGrant());
  return { ...content, grantDigest: digestValue(content) };
}

export function normalizeCodeJobGrant(value) {
  const error = invalidGrant();
  const keys = grantKeys(value, error, { digest: true });
  const entries = exactObject(value, [...keys, "grantDigest"], error);
  const content = normalizeGrantContent(
    Object.fromEntries(keys.map((key) => [key, entries.get(key)])),
    error,
  );
  const grantDigest = sha256(entries.get("grantDigest"), "grantDigest", error);
  if (grantDigest !== digestValue(content)) throw error;
  return { ...content, grantDigest };
}

export function normalizeApprovedCodeJobRequest(value) {
  const error = invalidApproval();
  const entries = exactObject(
    value,
    [
      "confirmationId",
      "requestId",
      "displayedPayloadDigest",
      "approvalBindingDigest",
      "grant",
    ],
    error,
  );
  let grant;
  try {
    grant = normalizeCodeJobGrant(entries.get("grant"));
  } catch (cause) {
    throw invalidApproval("代码任务批准中的授权无效", { cause });
  }
  return {
    confirmationId: text(entries.get("confirmationId"), "confirmationId", {
      maximumBytes: 128,
      pattern: SAFE_CONFIRMATION_ID,
      error,
    }),
    requestId: text(entries.get("requestId"), "requestId", {
      minimumBytes: 8,
      maximumBytes: 128,
      pattern: SAFE_CONFIRMATION_ID,
      error,
    }),
    displayedPayloadDigest: sha256(
      entries.get("displayedPayloadDigest"),
      "displayedPayloadDigest",
      error,
    ),
    approvalBindingDigest: sha256(
      entries.get("approvalBindingDigest"),
      "approvalBindingDigest",
      error,
    ),
    grant,
  };
}

export function codeJobIdForGrant(value) {
  const grant = normalizeCodeJobGrant(value);
  const digest = digestValue({
    proposalId: grant.proposalId,
    proposalContentDigest: grant.contentDigest,
    grantDigest: grant.grantDigest,
  });
  return `code-job-${digest.slice(0, 55)}`;
}

export function normalizeCodeJobTimestamp(value, error = invalidJob()) {
  let timestamp;
  try {
    timestamp = value instanceof Date ? value.toISOString() : value;
  } catch {
    throw error;
  }
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

function normalizeJsonValue(value, error, depth = 0, ancestors = new Set()) {
  if (depth > MAX_JSON_DEPTH) throw error;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) {
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) throw error;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = denseArray(value, MAX_JSON_COLLECTION_SIZE, error);
      return values.map((entry) =>
        normalizeJsonValue(entry, error, depth + 1, ancestors),
      );
    }
    const entries = plainDataEntries(value, error);
    if (entries.length > MAX_JSON_COLLECTION_SIZE) throw error;
    const normalized = {};
    for (const [key, entry] of entries.sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    )) {
      text(key, "detail.key", { maximumBytes: 128, error });
      normalized[key] = normalizeJsonValue(
        entry,
        error,
        depth + 1,
        ancestors,
      );
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeDetail(value, error) {
  const detail = normalizeJsonValue(value, error);
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_DETAIL_BYTES) {
    throw error;
  }
  return detail;
}

export function normalizeCodeJobCompletionReport(value, action, error = invalidJob()) {
  const fields = exactObject(value, ["actionId", "actionDigest", "workspaceRevision", "outcome", "evidence"], error);
  const actionId = safeId(fields.get("actionId"), "completionReport.actionId", error);
  const actionDigest = sha256(fields.get("actionDigest"), "completionReport.actionDigest", error);
  const workspaceRevision = sha256(fields.get("workspaceRevision"), "completionReport.workspaceRevision", error);
  const expectedDigest = digestValue(action);
  if (action.type !== "complete" || actionId !== action.actionId ||
      actionDigest !== expectedDigest || workspaceRevision !== action.expectedWorkspaceRevision) throw error;
  let report;
  try { report = normalizeCodeCompletionReport({ outcome: fields.get("outcome"), evidence: fields.get("evidence") }); }
  catch { throw error; }
  return { actionId, actionDigest, workspaceRevision, ...report };
}

function normalizePendingAction(value, sessionId, error) {
  if (value === null) return null;
  const fields = exactObject(
    value,
    ["turn", "actionId", "actionDigest", "action", "preparedAt",
      ...(Object.hasOwn(value ?? {}, "completionReport") ? ["completionReport"] : [])],
    error,
  );
  let action;
  try {
    action = normalizeActionRequest({
      sessionId,
      action: fields.get("action"),
    }).action;
  } catch {
    throw error;
  }
  if (
    Buffer.byteLength(JSON.stringify(action), "utf8") > CODE_JOB_MAXIMUM_ACTION_BYTES
  ) {
    throw error;
  }
  const actionId = safeId(fields.get("actionId"), "pendingAction.actionId", error);
  const actionDigest = sha256(
    fields.get("actionDigest"),
    "pendingAction.actionDigest",
    error,
  );
  if (action.actionId !== actionId || digestValue(action) !== actionDigest) {
    throw error;
  }
  return {
    turn: safeInteger(fields.get("turn"), "pendingAction.turn", {
      minimum: 1,
      maximum: MAX_OBSERVATIONS,
      error,
    }),
    actionId,
    actionDigest,
    action,
    ...(fields.has("completionReport") ? {
      completionReport: normalizeCodeJobCompletionReport(fields.get("completionReport"), action, error),
    } : {}),
    preparedAt: normalizeCodeJobTimestamp(fields.get("preparedAt"), error),
  };
}

function normalizeActionAdmission(value, pendingAction, revision, error) {
  if (value === null) return null;
  const fields = exactObject(
    value,
    ["actionId", "actionDigest", "epoch", "admittedAt"],
    error,
  );
  const actionId = safeId(
    fields.get("actionId"),
    "actionAdmission.actionId",
    error,
  );
  const actionDigest = sha256(
    fields.get("actionDigest"),
    "actionAdmission.actionDigest",
    error,
  );
  const epoch = safeInteger(fields.get("epoch"), "actionAdmission.epoch", {
    minimum: 1,
    maximum: revision,
    error,
  });
  if (
    pendingAction === null ||
    pendingAction.actionId !== actionId ||
    pendingAction.actionDigest !== actionDigest
  ) {
    throw error;
  }
  return {
    actionId,
    actionDigest,
    epoch,
    admittedAt: normalizeCodeJobTimestamp(fields.get("admittedAt"), error),
  };
}

function assertActionAllowedByGrant(action, grant, error) {
  if (!grant.allowedActions.includes(action.type)) throw error;
  if (action.type === "write_text") {
    let relativePath;
    try {
      relativePath = normalizeWorkspacePath(action.path);
    } catch {
      throw error;
    }
    const writable = grant.schemaVersion === 3
      ? codeExecutionSourceAllowsWrite(grant.executionSource, relativePath)
      : grant.writablePaths.some(
          (writablePath) =>
            relativePath === writablePath ||
            relativePath.startsWith(`${writablePath}/`),
        );
    if (!writable) {
      throw error;
    }
  }
  if (
    action.type === "run_profile" &&
    !grant.requiredProfiles.some(({ id }) => id === action.profileId)
  ) {
    throw error;
  }
}

function normalizeObservation(value, sessionId, grant, error) {
  const fields = exactObject(
    value,
    [
      "turn",
      "actionId",
      "actionType",
      "actionDigest",
      "action",
      "status",
      "workspaceRevision",
      "detail",
      "detailDigest",
      "recordedAt",
      ...(Object.hasOwn(value ?? {}, "completionReport") ? ["completionReport"] : []),
    ],
    error,
  );
  const status = fields.get("status");
  if (!OBSERVATION_STATUSES.has(status)) throw error;
  let action;
  try {
    action = normalizeActionRequest({
      sessionId,
      action: fields.get("action"),
    }).action;
  } catch {
    throw error;
  }
  if (
    Buffer.byteLength(JSON.stringify(action), "utf8") >
      CODE_JOB_MAXIMUM_ACTION_BYTES
  ) {
    throw error;
  }
  assertActionAllowedByGrant(action, grant, error);
  const detail = normalizeDetail(fields.get("detail"), error);
  const detailDigest = sha256(
    fields.get("detailDigest"),
    "observation.detailDigest",
    error,
  );
  if (digestValue(detail) !== detailDigest) throw error;
  const actionId = safeId(
    fields.get("actionId"),
    "observation.actionId",
    error,
  );
  const actionType = text(
    fields.get("actionType"),
    "observation.actionType",
    { maximumBytes: 64, pattern: SAFE_ACTION, error },
  );
  const actionDigest = sha256(
    fields.get("actionDigest"),
    "observation.actionDigest",
    error,
  );
  if (
    action.actionId !== actionId ||
    action.type !== actionType ||
    digestValue(action) !== actionDigest
  ) {
    throw error;
  }
  return {
    turn: safeInteger(fields.get("turn"), "observation.turn", {
      minimum: 1,
      maximum: MAX_OBSERVATIONS,
      error,
    }),
    actionId,
    actionType,
    actionDigest,
    action,
    ...(fields.has("completionReport") ? {
      completionReport: normalizeCodeJobCompletionReport(fields.get("completionReport"), action, error),
    } : {}),
    status,
    workspaceRevision: sha256(
      fields.get("workspaceRevision"),
      "observation.workspaceRevision",
      error,
    ),
    detail,
    detailDigest,
    recordedAt: normalizeCodeJobTimestamp(fields.get("recordedAt"), error),
  };
}

function normalizeCompletionDetail(value, grant, error) {
  if (!Object.hasOwn(value ?? {}, "completionReport")) return normalizeDetail(value, error);
  const detail = normalizeJsonValue(value, error);
  const report = normalizeCodeJobCompletionReport(detail.completionReport, {
    type: "complete", actionId: detail.completedActionId, expectedWorkspaceRevision: detail.workspaceRevision,
  }, error);
  if (detail.schemaVersion !== 1 || detail.outcome !== report.outcome) throw error;
  const hostDetail = { ...detail, outcome: grant.summary };
  delete hostDetail.completionReport;
  normalizeDetail(hostDetail, error);
  // A bounded model report has its own budget; it cannot enlarge the host
  // manifest/evidence budget or fail only after the executor has settled.
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_DETAIL_BYTES + 100 * 1024) throw error;
  return detail;
}

function normalizeTerminalResult(value, error, grant) {
  if (value === null) return null;
  const fields = exactObject(
    value,
    ["kind", "detail", "detailDigest", "recordedAt"],
    error,
  );
  const kind = fields.get("kind");
  if (!TERMINAL_JOB_STATUSES.has(kind)) throw error;
  const detail = kind === "completed" ? normalizeCompletionDetail(fields.get("detail"), grant, error)
    : normalizeDetail(fields.get("detail"), error);
  const detailDigest = sha256(
    fields.get("detailDigest"),
    "result.detailDigest",
    error,
  );
  if (digestValue(detail) !== detailDigest) throw error;
  return {
    kind,
    detail,
    detailDigest,
    recordedAt: normalizeCodeJobTimestamp(fields.get("recordedAt"), error),
  };
}

function normalizeCancellationSettlement(value, error) {
  if (value === null) return null;
  const fields = exactObject(
    value,
    [
      "kind",
      "sessionId",
      "cancellationDigest",
      "workspaceRevision",
      "proofDigest",
      "settledAt",
    ],
    error,
  );
  if (
    ![
      "controlled_execution_absent",
      "controlled_execution_cancelled",
    ].includes(fields.get("kind"))
  ) {
    throw error;
  }
  return {
    kind: fields.get("kind"),
    sessionId: safeId(
      fields.get("sessionId"),
      "cancellationSettlement.sessionId",
      error,
    ),
    cancellationDigest: sha256(
      fields.get("cancellationDigest"),
      "cancellationSettlement.cancellationDigest",
      error,
    ),
    workspaceRevision: fields.get("workspaceRevision") === null
      ? null
      : sha256(
        fields.get("workspaceRevision"),
        "cancellationSettlement.workspaceRevision",
        error,
      ),
    proofDigest: sha256(
      fields.get("proofDigest"),
      "cancellationSettlement.proofDigest",
      error,
    ),
    settledAt: normalizeCodeJobTimestamp(fields.get("settledAt"), error),
  };
}

function cancellationOrigin(result, error) {
  if (result?.kind !== "cancelled") throw error;
  const fields = exactObject(
    result.detail,
    ["schemaVersion", "outcome", "code", "message", "reason", "requestedFrom"],
    error,
  );
  const requestedFrom = fields.get("requestedFrom");
  if (
    fields.get("schemaVersion") !== 1 ||
    fields.get("outcome") !== "cancelled" ||
    fields.get("code") !== "CODE_JOB_CANCELLED" ||
    !CANCELLABLE_JOB_STATUSES.has(requestedFrom)
  ) {
    throw error;
  }
  text(fields.get("message"), "result.detail.message", {
    maximumBytes: 2_048,
    error,
  });
  text(fields.get("reason"), "result.detail.reason", {
    maximumBytes: 2_048,
    error,
  });
  return requestedFrom;
}

function normalizePause(value, error) {
  if (value === null) return null;
  const fields = exactObject(value, ["from", "reason", "at"], error);
  const from = fields.get("from");
  if (!PAUSABLE_JOB_STATUSES.has(from)) throw error;
  return {
    from,
    reason: text(fields.get("reason"), "pause.reason", {
      maximumBytes: 2_048,
      error,
    }),
    at: normalizeCodeJobTimestamp(fields.get("at"), error),
  };
}

function normalizeUncertainty(value, error) {
  if (value === null) return null;
  const fields = exactObject(value, ["from", "code", "message", "at"], error);
  const from = fields.get("from");
  if (!["active", "pausing"].includes(from)) throw error;
  return {
    from,
    code: text(fields.get("code"), "uncertainty.code", {
      maximumBytes: 128,
      pattern: SAFE_ERROR_CODE,
      error,
    }),
    message: text(fields.get("message"), "uncertainty.message", {
      maximumBytes: 2_048,
      error,
    }),
    at: normalizeCodeJobTimestamp(fields.get("at"), error),
  };
}

function normalizeMemoryProjection(value, jobId, error) {
  if (value === null) return null;
  const fields = exactObject(
    value,
    [
      "jobId",
      "sourceRecordDigest",
      "sourceRevision",
      "sourceUpdatedAt",
      "memoryRecordId",
      "memoryRecordDigest",
      "projectedAt",
    ],
    error,
  );
  const memoryRecordId = text(
    fields.get("memoryRecordId"),
    "memoryProjection.memoryRecordId",
    { maximumBytes: 71, pattern: MEMORY_RECORD_ID, error },
  );
  const memoryRecordDigest = sha256(
    fields.get("memoryRecordDigest"),
    "memoryProjection.memoryRecordDigest",
    error,
  );
  if (memoryRecordId !== `memory-${memoryRecordDigest}`) throw error;
  return {
    jobId: safeId(fields.get("jobId"), "memoryProjection.jobId", error),
    sourceRecordDigest: sha256(
      fields.get("sourceRecordDigest"),
      "memoryProjection.sourceRecordDigest",
      error,
    ),
    sourceRevision: safeInteger(
      fields.get("sourceRevision"),
      "memoryProjection.sourceRevision",
      { minimum: 1, error },
    ),
    sourceUpdatedAt: normalizeCodeJobTimestamp(
      fields.get("sourceUpdatedAt"),
      error,
    ),
    memoryRecordId,
    memoryRecordDigest,
    projectedAt: normalizeCodeJobTimestamp(fields.get("projectedAt"), error),
  };
}

export function codeJobTimeoutContinuationDelayMs(consecutiveNoProgress) {
  return 60_000 * 2 ** Math.max(0, consecutiveNoProgress - 1);
}

export function normalizeCodeJobTimeoutContinuation(value, error = invalidJob()) {
  const fields = exactObject(value, ["schemaVersion", "failedRunId", "errorCode", "failedAt", "recordedAt",
    "retryAfter", "progressFingerprint", "consecutiveNoProgress"], error);
  if (fields.get("schemaVersion") !== 1 ||
      !["STRUCTURED_PROVIDER_TIMEOUT", "STRUCTURED_PROVIDER_IDLE_TIMEOUT"].includes(fields.get("errorCode"))) throw error;
  const continuation = {
    schemaVersion: 1,
    failedRunId: safeId(fields.get("failedRunId"), "timeoutContinuation.failedRunId", error),
    errorCode: fields.get("errorCode"),
    failedAt: normalizeCodeJobTimestamp(fields.get("failedAt"), error),
    recordedAt: normalizeCodeJobTimestamp(fields.get("recordedAt"), error),
    retryAfter: normalizeCodeJobTimestamp(fields.get("retryAfter"), error),
    progressFingerprint: sha256(fields.get("progressFingerprint"), "timeoutContinuation.progressFingerprint", error),
    consecutiveNoProgress: safeInteger(fields.get("consecutiveNoProgress"), "timeoutContinuation.consecutiveNoProgress",
      { minimum: 0, maximum: 3, error }),
  };
  const delay = codeJobTimeoutContinuationDelayMs(continuation.consecutiveNoProgress);
  if (Date.parse(continuation.failedAt) > Date.parse(continuation.recordedAt) ||
      Date.parse(continuation.retryAfter) !== Date.parse(continuation.recordedAt) + delay) throw error;
  return continuation;
}

function emptyExecution() {
  return {
    sessionId: null,
    workspaceRevision: null,
    turn: 0,
    pendingAction: null,
    actionAdmission: null,
    observations: [],
    result: null,
    pause: null,
    uncertainty: null,
    cancellationSettlement: null,
    memoryProjection: null,
  };
}

function normalizeExecution(
  value,
  status,
  jobId,
  grant,
  revision,
  createdAt,
  updatedAt,
  error,
) {
  const executionEntries = plainDataEntries(value, error);
  const executionKeys = executionEntries.map(([key]) => key);
  const baseKeys = [
    "sessionId",
    "workspaceRevision",
    "turn",
    "pendingAction",
    "observations",
    "result",
    "pause",
  ];
  const memoryKeys = [...baseKeys, "memoryProjection"];
  const admissionKeys = [...memoryKeys, "actionAdmission"];
  const currentKeys = [...admissionKeys, "uncertainty"];
  const settlementKeys = [...currentKeys, "cancellationSettlement"];
  const hasTimeoutContinuation = executionKeys.includes("timeoutContinuation");
  const withoutMemory =
    executionKeys.length === baseKeys.length &&
    baseKeys.every((key) => executionKeys.includes(key));
  const withoutAdmission =
    executionKeys.length === memoryKeys.length &&
    memoryKeys.every((key) => executionKeys.includes(key));
  const withoutUncertainty =
    executionKeys.length === admissionKeys.length &&
    admissionKeys.every((key) => executionKeys.includes(key));
  const withoutSettlement =
    executionKeys.length === currentKeys.length &&
    currentKeys.every((key) => executionKeys.includes(key));
  const fields = exactObject(
    value,
    withoutMemory
      ? baseKeys
      : withoutAdmission
        ? memoryKeys
        : withoutUncertainty
          ? admissionKeys
          : withoutSettlement
            ? currentKeys
            : hasTimeoutContinuation ? [...settlementKeys, "timeoutContinuation"] : settlementKeys,
    error,
  );
  const sessionId = fields.get("sessionId") === null
    ? null
    : safeId(fields.get("sessionId"), "execution.sessionId", error);
  const workspaceRevision = fields.get("workspaceRevision") === null
    ? null
    : sha256(
      fields.get("workspaceRevision"),
      "execution.workspaceRevision",
      error,
    );
  const turn = safeInteger(fields.get("turn"), "execution.turn", {
    minimum: 0,
    maximum: MAX_OBSERVATIONS,
    error,
  });
  const observations = denseArray(
    fields.get("observations"),
    MAX_OBSERVATIONS,
    error,
  ).map((entry) => normalizeObservation(entry, sessionId, grant, error));
  const pendingAction = normalizePendingAction(
    fields.get("pendingAction"),
    sessionId,
    error,
  );
  if (pendingAction !== null) {
    assertActionAllowedByGrant(pendingAction.action, grant, error);
  }
  const legacyAdmittedPending =
    (withoutMemory || withoutAdmission) && pendingAction !== null;
  const actionAdmission = legacyAdmittedPending
    ? {
        actionId: pendingAction.actionId,
        actionDigest: pendingAction.actionDigest,
        epoch: revision,
        admittedAt: pendingAction.preparedAt,
      }
    : withoutMemory || withoutAdmission
      ? null
      : normalizeActionAdmission(
        fields.get("actionAdmission"),
        pendingAction,
        revision,
        error,
      );
  const result = normalizeTerminalResult(fields.get("result"), error, grant);
  if (result?.kind === "completed" &&
      digestValue(observations.at(-1)?.completionReport ?? null) !== digestValue(result.detail.completionReport ?? null)) throw error;
  const pause = normalizePause(fields.get("pause"), error);
  const uncertainty = legacyAdmittedPending
    ? {
        from: pause === null ? "active" : "pausing",
        code: "LEGACY_ACTION_RESULT_UNKNOWN",
        message: "Legacy pending action requires executor reconciliation",
        at: updatedAt,
      }
    : withoutMemory || withoutAdmission || withoutUncertainty
      ? status === "unknown"
        ? {
            from: "pausing",
            code: "LEGACY_ACTION_RESULT_UNKNOWN",
            message: pause?.reason ?? "Legacy unknown action requires reconciliation",
            at: pause?.at ?? updatedAt,
          }
        : null
      : normalizeUncertainty(fields.get("uncertainty"), error);
  const memoryProjection = withoutMemory
    ? null
    : normalizeMemoryProjection(fields.get("memoryProjection"), jobId, error);
  const cancellationSettlement =
    withoutMemory ||
    withoutAdmission ||
    withoutUncertainty ||
    withoutSettlement
      ? null
      : normalizeCancellationSettlement(
        fields.get("cancellationSettlement"),
        error,
      );
  const execution = {
    sessionId,
    workspaceRevision,
    turn,
    pendingAction,
    actionAdmission,
    observations,
    result,
    pause,
    uncertainty,
    cancellationSettlement,
    memoryProjection,
    ...(hasTimeoutContinuation ? { timeoutContinuation: normalizeCodeJobTimeoutContinuation(fields.get("timeoutContinuation"), error) } : {}),
  };

  if (
    (hasTimeoutContinuation && (sessionId === null || workspaceRevision === null ||
      Date.parse(execution.timeoutContinuation.failedAt) < Date.parse(createdAt) ||
      Date.parse(execution.timeoutContinuation.recordedAt) > Date.parse(updatedAt))) ||
    observations.length !== turn ||
    observations.some(
      ({ actionType }) => !grant.allowedActions.includes(actionType),
    ) ||
    observations.some((observation, index) => observation.turn !== index + 1) ||
    observations.some(
      (observation, index) =>
        index > 0 &&
        observation.action.expectedWorkspaceRevision !==
          observations[index - 1].workspaceRevision,
    ) ||
    new Set(observations.map(({ actionId }) => actionId)).size !==
      observations.length ||
    new Set(observations.map(({ actionDigest }) => actionDigest)).size !==
      observations.length ||
    (sessionId !== null && sessionId !== jobId) ||
    (workspaceRevision !== null && sessionId === null) ||
    (observations.length > 0 &&
      observations.at(-1).workspaceRevision !== workspaceRevision) ||
    (pendingAction !== null &&
      (pendingAction.turn !== turn + 1 ||
        observations.some(({ actionId }) => actionId === pendingAction.actionId) ||
        observations.some(
          ({ actionDigest }) => actionDigest === pendingAction.actionDigest,
        ) ||
        pendingAction.action.expectedWorkspaceRevision !== workspaceRevision)) ||
    (actionAdmission !== null &&
      (pendingAction === null ||
        Date.parse(actionAdmission.admittedAt) < Date.parse(createdAt) ||
        Date.parse(actionAdmission.admittedAt) > Date.parse(updatedAt))) ||
    observations.some(
      (observation, index) =>
        Date.parse(observation.recordedAt) < Date.parse(createdAt) ||
        Date.parse(observation.recordedAt) > Date.parse(updatedAt) ||
        (index > 0 &&
          Date.parse(observation.recordedAt) <
            Date.parse(observations[index - 1].recordedAt)),
    ) ||
    (pendingAction !== null &&
      (Date.parse(pendingAction.preparedAt) < Date.parse(createdAt) ||
        Date.parse(pendingAction.preparedAt) > Date.parse(updatedAt))) ||
    (result !== null &&
      (Date.parse(result.recordedAt) < Date.parse(createdAt) ||
        Date.parse(result.recordedAt) > Date.parse(updatedAt))) ||
    (pause !== null &&
      (Date.parse(pause.at) < Date.parse(createdAt) ||
        Date.parse(pause.at) > Date.parse(updatedAt))) ||
    (uncertainty !== null &&
      (Date.parse(uncertainty.at) < Date.parse(createdAt) ||
        Date.parse(uncertainty.at) > Date.parse(updatedAt))) ||
    (cancellationSettlement !== null &&
      (cancellationSettlement.sessionId !== jobId ||
        cancellationSettlement.cancellationDigest !== result?.detailDigest ||
        cancellationSettlement.workspaceRevision !== workspaceRevision ||
        Date.parse(cancellationSettlement.settledAt) <
          Date.parse(result?.recordedAt ?? createdAt) ||
        Date.parse(cancellationSettlement.settledAt) > Date.parse(updatedAt) ||
        status !== "cancelled")) ||
    (memoryProjection !== null &&
      (memoryProjection.jobId !== jobId ||
        Date.parse(memoryProjection.sourceUpdatedAt) < Date.parse(createdAt) ||
        Date.parse(memoryProjection.projectedAt) <
          Date.parse(memoryProjection.sourceUpdatedAt) ||
        Date.parse(memoryProjection.projectedAt) > Date.parse(updatedAt)))
  ) {
    throw error;
  }

  const isEmpty =
    sessionId === null &&
    workspaceRevision === null &&
    turn === 0 &&
    pendingAction === null &&
    actionAdmission === null &&
    observations.length === 0 &&
    result === null &&
    uncertainty === null &&
    memoryProjection === null;
  const reconcilingSessionStart =
    pause?.from === "starting" &&
    sessionId === jobId &&
    workspaceRevision === null &&
    turn === 0 &&
    pendingAction === null &&
    actionAdmission === null &&
    observations.length === 0;
  const reconcilingAction =
    pause?.from === "active" &&
    sessionId === jobId &&
    workspaceRevision !== null &&
    pendingAction !== null &&
    actionAdmission !== null;
  const cancellationFrom = ["cancelling", "cancelled"].includes(status)
    ? cancellationOrigin(result, error)
    : null;
  const cancellingFromStarting =
    cancellationFrom === "starting" &&
    sessionId === jobId &&
    workspaceRevision === null &&
    turn === 0 &&
    pendingAction === null &&
    actionAdmission === null &&
    observations.length === 0 &&
    uncertainty === null &&
    pause === null;
  const cancellingFromPausingStart =
    cancellationFrom === "pausing" &&
    sessionId === jobId &&
    workspaceRevision === null &&
    turn === 0 &&
    pendingAction === null &&
    actionAdmission === null &&
    observations.length === 0 &&
    uncertainty === null &&
    pause?.from === "starting";
  const cancellingFromActive =
    cancellationFrom === "active" &&
    sessionId === jobId &&
    workspaceRevision !== null &&
    pause === null &&
    uncertainty === null;
  const cancellingFromPausing =
    cancellationFrom === "pausing" &&
    sessionId === jobId &&
    workspaceRevision !== null &&
    pendingAction !== null &&
    actionAdmission !== null &&
    pause?.from === "active" &&
    uncertainty === null;
  const cancellingFromUnknown =
    cancellationFrom === "unknown" &&
    sessionId === jobId &&
    workspaceRevision !== null &&
    pendingAction !== null &&
    actionAdmission !== null &&
    uncertainty !== null &&
    ((uncertainty.from === "active" && pause === null) ||
      (uncertainty.from === "pausing" && pause?.from === "active"));
  const cancellingFromPaused =
    cancellationFrom === "paused" &&
    sessionId === jobId &&
    actionAdmission === null &&
    uncertainty === null &&
    ((pause?.from === "starting" &&
      workspaceRevision === null &&
      turn === 0 &&
      pendingAction === null &&
      observations.length === 0) ||
      (pause?.from === "active" && workspaceRevision !== null));
  const validCancellationReconciliation =
    cancellingFromStarting ||
    cancellingFromPausingStart ||
    cancellingFromActive ||
    cancellingFromPausing ||
    cancellingFromUnknown ||
    cancellingFromPaused;
  if (
    (status === "queued" && (!isEmpty || pause !== null)) ||
    (status === "starting" &&
      (sessionId !== jobId ||
        workspaceRevision !== null ||
        turn !== 0 ||
        pendingAction !== null ||
        actionAdmission !== null ||
        observations.length !== 0 ||
        result !== null ||
        pause !== null ||
        uncertainty !== null ||
        memoryProjection !== null)) ||
    (status === "active" &&
      (sessionId !== jobId ||
        workspaceRevision === null ||
        result !== null ||
        pause !== null ||
        uncertainty !== null ||
        memoryProjection !== null)) ||
    (status === "pausing" &&
      ((!reconcilingSessionStart && !reconcilingAction) ||
        result !== null ||
        uncertainty !== null ||
        memoryProjection !== null)) ||
    (status === "unknown" &&
      (sessionId !== jobId ||
        workspaceRevision === null ||
        pendingAction === null ||
        actionAdmission === null ||
        uncertainty === null ||
        result !== null ||
        memoryProjection !== null ||
        (uncertainty?.from === "active" && pause !== null) ||
        (uncertainty?.from === "pausing" && pause?.from !== "active"))) ||
    (status === "paused" &&
      (pause === null ||
        result !== null ||
        actionAdmission !== null ||
        uncertainty !== null ||
        memoryProjection !== null ||
        (pause?.from === "queued" && !isEmpty) ||
        (pause?.from === "starting" &&
          (sessionId !== jobId ||
            workspaceRevision !== null ||
            turn !== 0 ||
            pendingAction !== null ||
            observations.length !== 0)) ||
        (pause?.from === "active" &&
          (sessionId !== jobId || workspaceRevision === null)))) ||
    (status === "cancelling" &&
      (!validCancellationReconciliation ||
        cancellationSettlement !== null ||
        memoryProjection !== null)) ||
    (TERMINAL_JOB_STATUSES.has(status) &&
      (result?.kind !== status ||
        pause !== null ||
        uncertainty !== null ||
        pendingAction !== null ||
        actionAdmission !== null ||
        (status === "completed" &&
          (sessionId !== jobId ||
            workspaceRevision === null ||
            observations.at(-1)?.actionType !== "complete" ||
            observations.at(-1)?.status !== "succeeded"))))
  ) {
    throw error;
  }
  return execution;
}

const LEGACY_JOB_KEYS = Object.freeze([
  "jobId",
  "status",
  "sequence",
  "revision",
  "approval",
  "proposal",
  "grant",
  "createdAt",
  "updatedAt",
  "recordDigest",
]);
const JOB_KEYS = Object.freeze([
  ...LEGACY_JOB_KEYS.slice(0, -1),
  "execution",
  "recordDigest",
]);

function normalizeCodeJobBase(entries, error) {
  const approvalFields = exactObject(
    entries.get("approval"),
    [
      "confirmationId",
      "requestId",
      "displayedPayloadDigest",
      "approvalBindingDigest",
    ],
    error,
  );
  const proposalFields = exactObject(
    entries.get("proposal"),
    ["proposalId", "contentDigest"],
    error,
  );
  const grant = normalizeCodeJobGrant(entries.get("grant"));
  return {
    jobId: safeId(entries.get("jobId"), "jobId", error),
    status: entries.get("status"),
    sequence: safeInteger(entries.get("sequence"), "sequence", {
      minimum: 1,
      error,
    }),
    revision: safeInteger(entries.get("revision"), "revision", {
      minimum: 1,
      error,
    }),
    approval: {
      confirmationId: text(
        approvalFields.get("confirmationId"),
        "approval.confirmationId",
        { maximumBytes: 128, pattern: SAFE_CONFIRMATION_ID, error },
      ),
      requestId: text(approvalFields.get("requestId"), "approval.requestId", {
        minimumBytes: 8,
        maximumBytes: 128,
        pattern: SAFE_CONFIRMATION_ID,
        error,
      }),
      displayedPayloadDigest: sha256(
        approvalFields.get("displayedPayloadDigest"),
        "approval.displayedPayloadDigest",
        error,
      ),
      approvalBindingDigest: sha256(
        approvalFields.get("approvalBindingDigest"),
        "approval.approvalBindingDigest",
        error,
      ),
    },
    proposal: {
      proposalId: safeReference(
        proposalFields.get("proposalId"),
        "proposal.proposalId",
        192,
        error,
      ),
      contentDigest: sha256(
        proposalFields.get("contentDigest"),
        "proposal.contentDigest",
        error,
      ),
    },
    grant,
    createdAt: normalizeCodeJobTimestamp(entries.get("createdAt"), error),
    updatedAt: normalizeCodeJobTimestamp(entries.get("updatedAt"), error),
  };
}

function codeJobRecordDigestCandidates(content) {
  const candidates = [digestValue(content)];
  if (content.execution?.cancellationSettlement === null) {
    const {
      cancellationSettlement: _cancellationSettlement,
      ...legacyExecution
    } = content.execution;
    candidates.push(digestValue({ ...content, execution: legacyExecution }));
  }
  return candidates;
}

function assertCodeJobBindings(content, recordDigest, error) {
  if (
    !JOB_STATUSES.has(content.status) ||
    content.jobId !== codeJobIdForGrant(content.grant) ||
    content.proposal.proposalId !== content.grant.proposalId ||
    content.proposal.contentDigest !== content.grant.contentDigest ||
    Date.parse(content.updatedAt) < Date.parse(content.createdAt) ||
    !codeJobRecordDigestCandidates(content).includes(recordDigest)
  ) {
    throw error;
  }
}

function assertMemoryProjectionBinding(content, error) {
  const receipt = content.execution.memoryProjection;
  if (receipt === null) return;
  const sourceExecution = { ...content.execution, memoryProjection: null };
  const sourceContent = {
    ...content,
    revision: receipt.sourceRevision,
    updatedAt: receipt.sourceUpdatedAt,
    execution: sourceExecution,
  };
  const executionCandidates = [sourceExecution];
  if (sourceExecution.cancellationSettlement === null) {
    const {
      cancellationSettlement: _cancellationSettlement,
      ...withoutCancellationSettlement
    } = sourceExecution;
    executionCandidates.push(withoutCancellationSettlement);
  }
  if (sourceExecution.uncertainty === null) {
    for (const candidate of [...executionCandidates]) {
      const { uncertainty: _uncertainty, ...withoutUncertainty } = candidate;
      executionCandidates.push(withoutUncertainty);
    }
  }
  if (sourceExecution.actionAdmission === null) {
    for (const candidate of [...executionCandidates]) {
      const { actionAdmission: _actionAdmission, ...withoutAdmission } = candidate;
      executionCandidates.push(withoutAdmission);
    }
  }
  const sourceDigests = new Set(
    executionCandidates.map((execution) =>
      digestValue({ ...sourceContent, execution }),
    ),
  );
  if (
    !TERMINAL_JOB_STATUSES.has(content.status) ||
    content.revision <= receipt.sourceRevision ||
    content.updatedAt !== receipt.projectedAt ||
    !sourceDigests.has(receipt.sourceRecordDigest)
  ) {
    throw error;
  }
}

export function createQueuedCodeJob(
  value,
  { sequence, revision, createdAt } = {},
) {
  const approval = normalizeApprovedCodeJobRequest(value);
  const at = normalizeCodeJobTimestamp(createdAt);
  const content = {
    jobId: codeJobIdForGrant(approval.grant),
    status: "queued",
    sequence: safeInteger(sequence, "sequence", {
      minimum: 1,
      error: invalidJob(),
    }),
    revision: safeInteger(revision, "revision", {
      minimum: 1,
      error: invalidJob(),
    }),
    approval: {
      confirmationId: approval.confirmationId,
      requestId: approval.requestId,
      displayedPayloadDigest: approval.displayedPayloadDigest,
      approvalBindingDigest: approval.approvalBindingDigest,
    },
    proposal: {
      proposalId: approval.grant.proposalId,
      contentDigest: approval.grant.contentDigest,
    },
    grant: approval.grant,
    createdAt: at,
    updatedAt: at,
    execution: emptyExecution(),
  };
  return { ...content, recordDigest: digestValue(content) };
}

export function normalizeCodeJob(value) {
  const error = invalidJob();
  const keys = plainDataEntries(value, error).map(([key]) => key);
  const legacy =
    keys.length === LEGACY_JOB_KEYS.length &&
    LEGACY_JOB_KEYS.every((key) => keys.includes(key));
  const entries = exactObject(value, legacy ? LEGACY_JOB_KEYS : JOB_KEYS, error);
  const base = normalizeCodeJobBase(entries, error);
  const suppliedDigest = sha256(
    entries.get("recordDigest"),
    "recordDigest",
    error,
  );
  if (legacy) {
    if (
      base.status !== "queued" ||
      base.createdAt !== base.updatedAt
    ) {
      throw error;
    }
    assertCodeJobBindings(base, suppliedDigest, error);
    const upgraded = { ...base, execution: emptyExecution() };
    return { ...upgraded, recordDigest: digestValue(upgraded) };
  }
  const rawExecutionEntries = plainDataEntries(entries.get("execution"), error);
  const executionBaseKeys = [
    "sessionId",
    "workspaceRevision",
    "turn",
    "pendingAction",
    "observations",
    "result",
    "pause",
  ];
  const executionMemoryKeys = [...executionBaseKeys, "memoryProjection"];
  const executionAdmissionKeys = [...executionMemoryKeys, "actionAdmission"];
  const executionCurrentKeys = [...executionAdmissionKeys, "uncertainty"];
  const legacyWithoutMemory =
    rawExecutionEntries.length === executionBaseKeys.length &&
    executionBaseKeys.every((key) =>
      rawExecutionEntries.some(([actual]) => actual === key),
    );
  const legacyWithoutAdmission =
    rawExecutionEntries.length === executionMemoryKeys.length &&
    executionMemoryKeys.every((key) =>
      rawExecutionEntries.some(([actual]) => actual === key),
    );
  const legacyWithoutUncertainty =
    rawExecutionEntries.length === executionAdmissionKeys.length &&
    executionAdmissionKeys.every((key) =>
      rawExecutionEntries.some(([actual]) => actual === key),
    );
  const legacyWithoutSettlement =
    rawExecutionEntries.length === executionCurrentKeys.length &&
    executionCurrentKeys.every((key) =>
      rawExecutionEntries.some(([actual]) => actual === key),
    );
  const rawExecution = Object.fromEntries(rawExecutionEntries);
  const legacyAdmittedPending =
    (legacyWithoutMemory || legacyWithoutAdmission) &&
    rawExecution.pendingAction !== null;
  if (
    legacyAdmittedPending &&
    !["active", "pausing", "paused"].includes(base.status)
  ) {
    throw error;
  }
  const effectiveStatus = legacyAdmittedPending ? "unknown" : base.status;
  const content = {
    ...base,
    status: effectiveStatus,
    execution: normalizeExecution(
      entries.get("execution"),
      effectiveStatus,
      base.jobId,
      base.grant,
      base.revision,
      base.createdAt,
      base.updatedAt,
      error,
    ),
  };
  if (
    legacyWithoutMemory ||
    legacyWithoutAdmission ||
    legacyWithoutUncertainty ||
    legacyWithoutSettlement
  ) {
    const execution = { ...content.execution };
    delete execution.cancellationSettlement;
    if (
      legacyWithoutMemory ||
      legacyWithoutAdmission ||
      legacyWithoutUncertainty
    ) {
      delete execution.uncertainty;
    }
    if (legacyWithoutMemory || legacyWithoutAdmission) {
      delete execution.actionAdmission;
    }
    if (legacyWithoutMemory) delete execution.memoryProjection;
    const legacyContent = { ...base, execution };
    assertCodeJobBindings(legacyContent, suppliedDigest, error);
    assertMemoryProjectionBinding(content, error);
    return {
      ...content,
      recordDigest:
        legacyWithoutSettlement &&
        !legacyWithoutMemory &&
        !legacyWithoutAdmission &&
        !legacyWithoutUncertainty
          ? suppliedDigest
          : digestValue(content),
    };
  }
  assertCodeJobBindings(content, suppliedDigest, error);
  assertMemoryProjectionBinding(content, error);
  return { ...content, recordDigest: suppliedDigest };
}

export function updateCodeJobLifecycle(
  value,
  { status, revision, updatedAt, execution },
) {
  const current = normalizeCodeJob(value);
  const content = {
    ...current,
    status,
    revision: safeInteger(revision, "revision", {
      minimum: current.revision + 1,
      error: invalidJob(),
    }),
    updatedAt: normalizeCodeJobTimestamp(updatedAt),
    execution: cloneCodeJobValue(execution),
  };
  delete content.recordDigest;
  return normalizeCodeJob({ ...content, recordDigest: digestValue(content) });
}

export function createCodeJobDetail(value, { completionGrant = null } = {}) {
  const error = invalidJob("代码任务执行详情无效");
  return completionGrant === null ? normalizeDetail(value, error) : normalizeCompletionDetail(value, completionGrant, error);
}

export function isTerminalCodeJobStatus(value) {
  return TERMINAL_JOB_STATUSES.has(value);
}

export function isRetentionEligibleCodeJob(value) {
  const job = normalizeCodeJob(value);
  return (
    TERMINAL_JOB_STATUSES.has(job.status) &&
    job.execution.memoryProjection !== null
  );
}

export function projectCodeJobForBrowser(value) {
  return projectNormalizedCodeJobForBrowser(normalizeCodeJob(value));
}

export function cloneCodeJobValue(value) {
  return structuredClone(value);
}
