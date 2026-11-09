import {
  CODE_JOB_STATUSES,
  normalizeCodeJob,
} from "./code-job-contract.js";
import { codeJobTerminalLifecycleAt } from "./code-job-terminal-time.js";
import {
  codeExecutionSourceWritablePaths,
  isHeadRepairExecutionSource,
  normalizeCodeExecutionSource,
} from "./code-execution-source.js";
import { digestValue } from "./code-executor-contract.js";
import { normalizeMemoryRecord } from "./memory-record.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const EVENT_KINDS = new Set([
  "observation",
  "paused",
  "unknown",
  "reconciled",
  "resumed",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);
const TERMINAL_KINDS = new Set([
  "cancelled",
  "completed",
  "failed",
  "fenced",
]);
const OPERATIONS = new Set(["inspect", "modify", "verify"]);
const JOB_STATUS_SET = new Set(CODE_JOB_STATUSES);
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_MANIFEST_ENTRIES = 20;
const MAX_EVIDENCE_DIGESTS = 12;
const MAX_EXECUTION_SOURCE_PATH_SAMPLES = 8;

export class CodeJobMemoryEventError extends Error {
  constructor(message = "代码任务记忆事件无效", options) {
    super(message, options);
    this.name = "CodeJobMemoryEventError";
    this.code = "INVALID_CODE_JOB_MEMORY_EVENT";
    this.statusCode = 400;
  }
}

function invalid(message, cause) {
  return new CodeJobMemoryEventError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function dataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name) {
  const entries = dataEntries(value, name);
  const fields = new Map(entries);
  if (
    entries.length !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} 字段无效`);
  }
  return fields;
}

function denseArray(value, maximumLength, name) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function digest(value, name) {
  return text(value, name, 64, SHA256);
}

function timestamp(value, name) {
  const result = text(value, name, 64);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    throw invalid(`${name} 无效`);
  }
  return result;
}

function optionalDigest(value, name) {
  return value === null ? null : digest(value, name);
}

function rawMemoryRecord(value) {
  const normalized = normalizeMemoryRecord(value);
  return structuredClone({
    schemaVersion: normalized.schemaVersion,
    source: normalized.source,
    occurredAt: normalized.occurredAt,
    roleId: normalized.roleId,
    repository: normalized.repository,
    eventType: normalized.eventType,
    title: normalized.title,
    summary: normalized.summary,
    content: normalized.content,
    evidence: normalized.evidence,
    tags: normalized.tags,
    sourceUrl: normalized.sourceUrl,
    subjectNumber: normalized.subjectNumber,
  });
}

function safeDigest(value) {
  return digestValue(value);
}

function safeManifestPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    CONTROL_CHARACTER.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

function arrayValuesOrNull(value, maximumLength = 10_000) {
  try {
    return denseArray(value, maximumLength, "安全摘要数组");
  } catch {
    return null;
  }
}

function dataFieldsOrNull(value) {
  try {
    return new Map(dataEntries(value, "安全摘要对象"));
  } catch {
    return null;
  }
}

function safeManifestEntry(value, kind) {
  const fields = dataFieldsOrNull(value);
  if (fields === null) return null;
  const path = safeManifestPath(fields.get("path"));
  if (path === null) return null;
  const sha256 = SHA256.test(fields.get("sha256")) ? fields.get("sha256") : null;
  const beforeSha256 = SHA256.test(fields.get("beforeSha256"))
    ? fields.get("beforeSha256")
    : null;
  const afterSha256 = SHA256.test(fields.get("afterSha256"))
    ? fields.get("afterSha256")
    : null;
  if (
    (kind === "modified" && (beforeSha256 === null || afterSha256 === null)) ||
    (kind !== "modified" && sha256 === null)
  ) {
    return null;
  }
  return {
    kind,
    path,
    pathDigest: safeDigest(path),
    sha256: kind === "modified" ? null : sha256,
    beforeSha256: kind === "modified" ? beforeSha256 : null,
    afterSha256: kind === "modified" ? afterSha256 : null,
  };
}

function safeManifest(value) {
  const fields = dataFieldsOrNull(value);
  if (fields === null) return null;
  const groups = [];
  for (const kind of ["created", "modified", "deleted"]) {
    const values = arrayValuesOrNull(fields.get(kind));
    if (values === null) return null;
    groups.push([kind, values.map((entry) => safeManifestEntry(entry, kind)).filter(Boolean)]);
  }
  const counts = Object.fromEntries(groups.map(([kind, values]) => [kind, values.length]));
  const entries = groups.flatMap(([, values]) => values).slice(0, MAX_MANIFEST_ENTRIES);
  return {
    createdCount: counts.created,
    modifiedCount: counts.modified,
    deletedCount: counts.deleted,
    entries,
    truncated: counts.created + counts.modified + counts.deleted > entries.length,
  };
}

function safeChecks(value) {
  const entries = arrayValuesOrNull(value, 64);
  if (entries === null) return [];
  return [...new Set(entries.filter(
    (entry) =>
      typeof entry === "string" &&
      Buffer.byteLength(entry, "utf8") <= 128 &&
      SAFE_TOKEN.test(entry),
  ))].slice(0, 20);
}

function evidenceSummary(value) {
  const entries = arrayValuesOrNull(value, 128);
  if (entries === null) return { count: 0, digests: [] };
  const strings = entries.filter((entry) => typeof entry === "string");
  return {
    count: strings.length,
    digests: [...new Set(strings.map(safeDigest))].slice(
      0,
      MAX_EVIDENCE_DIGESTS,
    ),
  };
}

function latestObservation(job) {
  const observation = job.execution.observations.at(-1);
  if (observation === undefined) return null;
  return {
    turn: observation.turn,
    actionType: observation.actionType,
    status: observation.status,
    workspaceRevision: observation.workspaceRevision,
    actionDigest: observation.actionDigest,
    detailDigest: observation.detailDigest,
    recordedAt: observation.recordedAt,
  };
}

function pauseSummary(job) {
  const pause = job.execution.pause;
  return pause === null
    ? null
    : {
        from: pause.from,
        at: pause.at,
        reasonDigest: safeDigest(pause.reason),
      };
}

function uncertaintySummary(job) {
  const uncertainty = job.execution.uncertainty;
  return uncertainty === null
    ? null
    : {
        from: uncertainty.from,
        code: uncertainty.code,
        at: uncertainty.at,
        messageDigest: safeDigest(uncertainty.message),
      };
}

function terminalSummary(job) {
  if (!TERMINAL_KINDS.has(job.status)) return null;
  const result = job.execution.result;
  if (result === null) return null;
  const detail = dataFieldsOrNull(result.detail);
  const errorCode = detail !== null && SAFE_ERROR_CODE.test(detail.get("code"))
    ? detail.get("code")
    : null;
  const workspaceRevision = detail !== null && SHA256.test(detail.get("workspaceRevision"))
    ? detail.get("workspaceRevision")
    : job.execution.workspaceRevision;
  return {
    kind: result.kind,
    recordedAt: codeJobTerminalLifecycleAt(job),
    detailDigest: result.detailDigest,
    errorCode,
    workspaceRevision,
    evidence: evidenceSummary(detail?.get("evidence")),
    checks: safeChecks(detail?.get("checks")),
    manifest: safeManifest(detail?.get("manifest")),
  };
}

function executionSourceSummary(value) {
  const source = normalizeCodeExecutionSource(value);
  const binding = source.preparationBinding;
  const writablePaths = codeExecutionSourceWritablePaths(source).sort((left, right) => left.localeCompare(right, "en"));
  return {
    kind: source.kind,
    ...(isHeadRepairExecutionSource(source) ? { sourceDigest: safeDigest(source) } : {
    preparationId: binding.preparationId,
    resultTreeOid: binding.resultTreeOid,
    boundaryDigest: binding.boundaryDigest,
    evidenceDigest: binding.evidenceDigest,
    resultObjectDigest: binding.resultObjectDigest,
    }),
    writablePathCount: writablePaths.length,
    writablePathsDigest: safeDigest(writablePaths),
    writablePathSamples: writablePaths.slice(
      0,
      MAX_EXECUTION_SOURCE_PATH_SAMPLES,
    ),
    writablePathsTruncated:
      writablePaths.length > MAX_EXECUTION_SOURCE_PATH_SAMPLES,
  };
}

function safeSnapshot(job, kind) {
  const currentGrant = Object.hasOwn(job.grant, "inputBinding");
  const conflictGrant = Object.hasOwn(job.grant, "executionSource");
  return {
    schemaVersion: conflictGrant ? 3 : currentGrant ? 2 : 1,
    jobId: job.jobId,
    jobRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
    kind,
    status: job.status,
    roleId: job.grant.requestedBy.roleId,
    repository: job.grant.repository,
    subjectNumber: job.grant.subject.number,
    ...(currentGrant ? { inputBinding: job.grant.inputBinding } : {}),
    ...(conflictGrant
      ? { executionSource: executionSourceSummary(job.grant.executionSource) }
      : {}),
    operation: job.grant.operation,
    turn: job.execution.turn,
    workspaceRevision: job.execution.workspaceRevision,
    latestObservation: latestObservation(job),
    pause: pauseSummary(job),
    uncertainty: uncertaintySummary(job),
    terminal: terminalSummary(job),
  };
}

const TITLES = Object.freeze({
  observation: "代码任务进展",
  paused: "代码任务已暂停",
  unknown: "代码任务结果待核验",
  reconciled: "代码任务已完成对账",
  resumed: "代码任务已恢复",
  cancelling: "代码任务正在取消",
  cancelled: "代码任务已取消",
  completed: "代码任务已完成",
  failed: "代码任务失败",
  fenced: "代码任务已隔离",
});

function memoryEvidence(snapshot) {
  const values = [`source-record:${snapshot.sourceRecordDigest}`];
  if (snapshot.inputBinding !== undefined && snapshot.inputBinding !== null) {
    values.push(`pr-head:${snapshot.inputBinding.headRefOid}`);
  }
  if (snapshot.executionSource !== undefined) {
    values.push(
      isHeadRepairExecutionSource(snapshot.executionSource)
        ? `${snapshot.executionSource.kind === 'ci_repair' ? 'ci-repair' : 'review-repair'}:${snapshot.executionSource.sourceDigest}`
        : `conflict-preparation:${snapshot.executionSource.preparationId}`,
    );
  }
  if (snapshot.latestObservation !== null) {
    values.push(`observation-detail:${snapshot.latestObservation.detailDigest}`);
  }
  if (snapshot.terminal !== null) {
    values.push(`terminal-detail:${snapshot.terminal.detailDigest}`);
    values.push(...snapshot.terminal.evidence.digests.map(
      (value) => `terminal-evidence:${value}`,
    ));
    values.push(...snapshot.terminal.checks.map((value) => `check:${value}`));
  }
  if (snapshot.executionSource !== undefined) {
    values.push(...snapshot.executionSource.writablePathSamples.map(
      (relativePath) => `${isHeadRepairExecutionSource(snapshot.executionSource) ? (snapshot.executionSource.kind === 'ci_repair' ? 'ci-repair-path' : 'review-repair-path') : "conflict-path"}:${relativePath}`,
    ));
  }
  return [...new Set(values)].slice(0, 20);
}

function memoryRecordFromSnapshot(event, snapshot) {
  return {
    schemaVersion: 1,
    source: {
      kind: "code_job",
      id: codeJobMemorySourceId(event.jobId, event.sourceRecordDigest),
    },
    occurredAt: event.occurredAt,
    roleId: snapshot.roleId,
    repository: snapshot.repository,
    eventType: `code_job.${event.kind}`,
    title: TITLES[event.kind],
    summary: `${TITLES[event.kind]} · 状态 ${snapshot.status} · 动作 ${snapshot.turn} · 修订 ${event.jobRevision}`,
    content: JSON.stringify(snapshot),
    evidence: memoryEvidence(snapshot),
    tags: [...new Set([
      "code-job",
      event.kind,
      snapshot.status,
      snapshot.operation,
      ...(snapshot.executionSource === undefined
        ? []
        : [isHeadRepairExecutionSource(snapshot.executionSource) ? (snapshot.executionSource.kind === 'ci_repair' ? 'ci-repair' : 'review-repair') : "conflict-preparation"]),
    ])],
    sourceUrl: null,
    subjectNumber: snapshot.subjectNumber,
  };
}

function assertKindMatchesStatus(kind, status, observation) {
  if (
    (TERMINAL_KINDS.has(kind) && status !== kind) ||
    (kind === "cancelling" && status !== "cancelling") ||
    (kind === "paused" && status !== "paused") ||
    (kind === "unknown" && status !== "unknown") ||
    (kind === "reconciled" && !["active", "paused"].includes(status)) ||
    (kind === "resumed" && !["queued", "starting", "active"].includes(status)) ||
    (kind === "observation" && (status !== "active" || observation === null))
  ) {
    throw invalid("代码任务记忆事件类型与状态不一致");
  }
}

function normalizeObservationSummary(value) {
  if (value === null) return null;
  const fields = exact(
    value,
    [
      "turn",
      "actionType",
      "status",
      "workspaceRevision",
      "actionDigest",
      "detailDigest",
      "recordedAt",
    ],
    "latestObservation",
  );
  const status = fields.get("status");
  if (!["succeeded", "failed", "interrupted"].includes(status)) {
    throw invalid("latestObservation.status 无效");
  }
  return {
    turn: integer(fields.get("turn"), "latestObservation.turn", 1),
    actionType: text(fields.get("actionType"), "latestObservation.actionType", 64, SAFE_TOKEN),
    status,
    workspaceRevision: digest(fields.get("workspaceRevision"), "latestObservation.workspaceRevision"),
    actionDigest: digest(fields.get("actionDigest"), "latestObservation.actionDigest"),
    detailDigest: digest(fields.get("detailDigest"), "latestObservation.detailDigest"),
    recordedAt: timestamp(fields.get("recordedAt"), "latestObservation.recordedAt"),
  };
}

function normalizePauseSummary(value) {
  if (value === null) return null;
  const fields = exact(value, ["from", "at", "reasonDigest"], "pause");
  const from = fields.get("from");
  if (!["queued", "starting", "active"].includes(from)) {
    throw invalid("pause.from 无效");
  }
  return {
    from,
    at: timestamp(fields.get("at"), "pause.at"),
    reasonDigest: digest(fields.get("reasonDigest"), "pause.reasonDigest"),
  };
}

function normalizeUncertaintySummary(value) {
  if (value === null) return null;
  const fields = exact(
    value,
    ["from", "code", "at", "messageDigest"],
    "uncertainty",
  );
  const from = fields.get("from");
  if (!["active", "pausing"].includes(from)) {
    throw invalid("uncertainty.from 无效");
  }
  return {
    from,
    code: text(fields.get("code"), "uncertainty.code", 128, SAFE_ERROR_CODE),
    at: timestamp(fields.get("at"), "uncertainty.at"),
    messageDigest: digest(fields.get("messageDigest"), "uncertainty.messageDigest"),
  };
}

function normalizeEvidenceSummary(value) {
  const fields = exact(value, ["count", "digests"], "terminal.evidence");
  const digests = denseArray(fields.get("digests"), MAX_EVIDENCE_DIGESTS, "terminal.evidence.digests")
    .map((entry) => digest(entry, "terminal.evidence.digest"));
  const count = integer(fields.get("count"), "terminal.evidence.count");
  if (count < digests.length || new Set(digests).size !== digests.length) {
    throw invalid("terminal.evidence 无效");
  }
  return { count, digests };
}

function normalizeManifestEntry(value) {
  const fields = exact(
    value,
    ["kind", "path", "pathDigest", "sha256", "beforeSha256", "afterSha256"],
    "terminal.manifest.entries[]",
  );
  const kind = fields.get("kind");
  if (!["created", "modified", "deleted"].includes(kind)) {
    throw invalid("terminal.manifest.entries[].kind 无效");
  }
  const path = safeManifestPath(fields.get("path"));
  if (path === null || fields.get("pathDigest") !== safeDigest(path)) {
    throw invalid("terminal.manifest.entries[].path 无效");
  }
  const sha256 = optionalDigest(fields.get("sha256"), "terminal.manifest.entries[].sha256");
  const beforeSha256 = optionalDigest(
    fields.get("beforeSha256"),
    "terminal.manifest.entries[].beforeSha256",
  );
  const afterSha256 = optionalDigest(
    fields.get("afterSha256"),
    "terminal.manifest.entries[].afterSha256",
  );
  if (
    (kind === "modified" && (sha256 !== null || beforeSha256 === null || afterSha256 === null)) ||
    (kind !== "modified" && (sha256 === null || beforeSha256 !== null || afterSha256 !== null))
  ) {
    throw invalid("terminal.manifest.entries[] 摘要无效");
  }
  return { kind, path, pathDigest: fields.get("pathDigest"), sha256, beforeSha256, afterSha256 };
}

function normalizeManifestSummary(value) {
  if (value === null) return null;
  const fields = exact(
    value,
    ["createdCount", "modifiedCount", "deletedCount", "entries", "truncated"],
    "terminal.manifest",
  );
  const result = {
    createdCount: integer(fields.get("createdCount"), "terminal.manifest.createdCount"),
    modifiedCount: integer(fields.get("modifiedCount"), "terminal.manifest.modifiedCount"),
    deletedCount: integer(fields.get("deletedCount"), "terminal.manifest.deletedCount"),
    entries: denseArray(fields.get("entries"), MAX_MANIFEST_ENTRIES, "terminal.manifest.entries")
      .map(normalizeManifestEntry),
    truncated: fields.get("truncated"),
  };
  if (typeof result.truncated !== "boolean") {
    throw invalid("terminal.manifest.truncated 无效");
  }
  const total = result.createdCount + result.modifiedCount + result.deletedCount;
  const actual = Object.fromEntries(
    ["created", "modified", "deleted"].map((kind) => [
      kind,
      result.entries.filter((entry) => entry.kind === kind).length,
    ]),
  );
  if (
    actual.created > result.createdCount ||
    actual.modified > result.modifiedCount ||
    actual.deleted > result.deletedCount ||
    result.truncated !== (total > result.entries.length)
  ) {
    throw invalid("terminal.manifest 计数无效");
  }
  return result;
}

function normalizeTerminalSummary(value) {
  if (value === null) return null;
  const fields = exact(
    value,
    [
      "kind",
      "recordedAt",
      "detailDigest",
      "errorCode",
      "workspaceRevision",
      "evidence",
      "checks",
      "manifest",
    ],
    "terminal",
  );
  const kind = fields.get("kind");
  if (!TERMINAL_KINDS.has(kind)) throw invalid("terminal.kind 无效");
  const errorCode = fields.get("errorCode") === null
    ? null
    : text(fields.get("errorCode"), "terminal.errorCode", 128, SAFE_ERROR_CODE);
  const checks = denseArray(fields.get("checks"), 20, "terminal.checks")
    .map((entry) => text(entry, "terminal.checks[]", 128, SAFE_TOKEN));
  if (new Set(checks).size !== checks.length) throw invalid("terminal.checks 重复");
  return {
    kind,
    recordedAt: timestamp(fields.get("recordedAt"), "terminal.recordedAt"),
    detailDigest: digest(fields.get("detailDigest"), "terminal.detailDigest"),
    errorCode,
    workspaceRevision: optionalDigest(fields.get("workspaceRevision"), "terminal.workspaceRevision"),
    evidence: normalizeEvidenceSummary(fields.get("evidence")),
    checks,
    manifest: normalizeManifestSummary(fields.get("manifest")),
  };
}

function normalizeExecutionSourceSummary(value) {
  const reviewRepair = ['review_repair', 'ci_repair'].includes(dataFieldsOrNull(value)?.get("kind"));
  const fields = exact(
    value,
    [
      "kind",
      ...(reviewRepair ? ["sourceDigest"] : [
      "preparationId",
      "resultTreeOid",
      "boundaryDigest",
      "evidenceDigest",
      "resultObjectDigest",
      ]),
      "writablePathCount",
      "writablePathsDigest",
      "writablePathSamples",
      "writablePathsTruncated",
    ],
    "executionSource",
  );
  if (!["conflict_preparation", "review_repair", "ci_repair"].includes(fields.get("kind"))) {
    throw invalid("executionSource.kind 无效");
  }
  const resultTreeOid = reviewRepair ? null : text(
    fields.get("resultTreeOid"),
    "executionSource.resultTreeOid",
    64,
    GIT_OID,
  );
  const writablePathCount = integer(
    fields.get("writablePathCount"),
    "executionSource.writablePathCount",
    1,
  );
  if (writablePathCount > (reviewRepair ? 64 : 32)) {
    throw invalid("executionSource.writablePathCount 无效");
  }
  const writablePathSamples = denseArray(
    fields.get("writablePathSamples"),
    MAX_EXECUTION_SOURCE_PATH_SAMPLES,
    "executionSource.writablePathSamples",
  ).map((entry) => {
    const relativePath = safeManifestPath(entry);
    if (relativePath === null) {
      throw invalid("executionSource.writablePathSamples[] 无效");
    }
    return relativePath;
  });
  const portablePaths = writablePathSamples.map((entry) =>
    entry.toLowerCase(),
  );
  const writablePathsTruncated = fields.get("writablePathsTruncated");
  const writablePathsDigest = digest(
    fields.get("writablePathsDigest"),
    "executionSource.writablePathsDigest",
  );
  const expectedSampleCount = Math.min(
    writablePathCount,
    MAX_EXECUTION_SOURCE_PATH_SAMPLES,
  );
  if (
    writablePathSamples.length !== expectedSampleCount ||
    typeof writablePathsTruncated !== "boolean" ||
    writablePathsTruncated !== (writablePathCount > expectedSampleCount) ||
    new Set(portablePaths).size !== writablePathSamples.length ||
    writablePathSamples.some(
      (entry, index) => index > 0 &&
        writablePathSamples[index - 1].localeCompare(entry, "en") >= 0,
    ) ||
    (!writablePathsTruncated &&
      writablePathsDigest !== safeDigest(writablePathSamples))
  ) {
    throw invalid("executionSource.writablePathSamples 无效");
  }
  return {
    kind: fields.get("kind"),
    ...(reviewRepair ? { sourceDigest: digest(fields.get("sourceDigest"), "executionSource.sourceDigest") } : {
    preparationId: digest(
      fields.get("preparationId"),
      "executionSource.preparationId",
    ),
    resultTreeOid,
    boundaryDigest: digest(
      fields.get("boundaryDigest"),
      "executionSource.boundaryDigest",
    ),
    evidenceDigest: digest(
      fields.get("evidenceDigest"),
      "executionSource.evidenceDigest",
    ),
    resultObjectDigest: digest(
      fields.get("resultObjectDigest"),
      "executionSource.resultObjectDigest",
    ),
    }),
    writablePathCount,
    writablePathsDigest,
    writablePathSamples,
    writablePathsTruncated,
  };
}

function normalizeSnapshot(value) {
  const rawFields = dataFieldsOrNull(value);
  const schemaVersion = rawFields?.get("schemaVersion");
  const current = [2, 3].includes(schemaVersion);
  const conflict = schemaVersion === 3;
  const fields = exact(
    value,
    [
      "schemaVersion",
      "jobId",
      "jobRevision",
      "sourceRecordDigest",
      "kind",
      "status",
      "roleId",
      "repository",
      "subjectNumber",
      ...(current ? ["inputBinding"] : []),
      ...(conflict ? ["executionSource"] : []),
      "operation",
      "turn",
      "workspaceRevision",
      "latestObservation",
      "pause",
      "uncertainty",
      "terminal",
    ],
    "memoryRecord.content",
  );
  if (![1, 2, 3].includes(fields.get("schemaVersion"))) {
    throw invalid("memoryRecord.content.schemaVersion 无效");
  }
  const kind = fields.get("kind");
  const status = fields.get("status");
  const operation = fields.get("operation");
  if (!EVENT_KINDS.has(kind) || !JOB_STATUS_SET.has(status) || !OPERATIONS.has(operation)) {
    throw invalid("memoryRecord.content 枚举值无效");
  }
  const latest = normalizeObservationSummary(fields.get("latestObservation"));
  assertKindMatchesStatus(kind, status, latest);
  const terminal = normalizeTerminalSummary(fields.get("terminal"));
  if ((TERMINAL_KINDS.has(status) && terminal?.kind !== status) || (!TERMINAL_KINDS.has(status) && terminal !== null)) {
    throw invalid("memoryRecord.content.terminal 与状态不一致");
  }
  let inputBinding;
  if (current) {
    if (fields.get("inputBinding") === null) {
      inputBinding = null;
    } else {
      try {
        inputBinding = normalizePullRequestExecutionBinding(
          fields.get("inputBinding"),
        );
      } catch {
        throw invalid("memoryRecord.content.inputBinding 无效");
      }
    }
  }
  const executionSource = conflict
    ? normalizeExecutionSourceSummary(fields.get("executionSource"))
    : undefined;
  const normalized = {
    schemaVersion: conflict ? 3 : current ? 2 : 1,
    jobId: text(fields.get("jobId"), "memoryRecord.content.jobId", 64, SAFE_JOB_ID),
    jobRevision: integer(fields.get("jobRevision"), "memoryRecord.content.jobRevision", 1),
    sourceRecordDigest: digest(fields.get("sourceRecordDigest"), "memoryRecord.content.sourceRecordDigest"),
    kind,
    status,
    roleId: text(fields.get("roleId"), "memoryRecord.content.roleId", 128, SAFE_TOKEN),
    repository: text(fields.get("repository"), "memoryRecord.content.repository", 256),
    subjectNumber: integer(fields.get("subjectNumber"), "memoryRecord.content.subjectNumber", 1),
    ...(current ? { inputBinding } : {}),
    ...(conflict ? { executionSource } : {}),
    operation,
    turn: integer(fields.get("turn"), "memoryRecord.content.turn"),
    workspaceRevision: optionalDigest(fields.get("workspaceRevision"), "memoryRecord.content.workspaceRevision"),
    latestObservation: latest,
    pause: normalizePauseSummary(fields.get("pause")),
    uncertainty: normalizeUncertaintySummary(fields.get("uncertainty")),
    terminal,
  };
  if (
    inputBinding !== undefined &&
    inputBinding !== null &&
    (inputBinding.repository !== normalized.repository ||
      inputBinding.pullRequestNumber !== normalized.subjectNumber)
  ) {
    throw invalid("memoryRecord.content.inputBinding 与任务不匹配");
  }
  if (
    conflict &&
    (inputBinding === null || normalized.operation !== "modify")
  ) {
    throw invalid("memoryRecord.content.executionSource 与任务不匹配");
  }
  return normalized;
}

function snapshotFromRecord(record) {
  let parsed;
  try {
    parsed = JSON.parse(record.content);
  } catch (cause) {
    throw invalid("memoryRecord.content 无效", cause);
  }
  const snapshot = normalizeSnapshot(parsed);
  if (record.content !== JSON.stringify(snapshot)) {
    throw invalid("memoryRecord.content 不是规范格式");
  }
  return snapshot;
}

function eventCore(value) {
  return {
    schemaVersion: 1,
    sequence: value.sequence,
    previousDigest: value.previousDigest,
    jobId: value.jobId,
    jobRevision: value.jobRevision,
    sourceRecordDigest: value.sourceRecordDigest,
    kind: value.kind,
    occurredAt: value.occurredAt,
    memoryRecord: value.memoryRecord,
  };
}

function normalizeEventFields(value) {
  const fields = exact(
    value,
    [
      "schemaVersion",
      "sequence",
      "eventId",
      "eventDigest",
      "previousDigest",
      "jobId",
      "jobRevision",
      "sourceRecordDigest",
      "kind",
      "occurredAt",
      "memoryRecord",
    ],
    "code job memory event",
  );
  if (fields.get("schemaVersion") !== 1) throw invalid("schemaVersion 无效");
  const sequence = integer(fields.get("sequence"), "sequence", 1);
  const previousDigest = fields.get("previousDigest") === null
    ? null
    : digest(fields.get("previousDigest"), "previousDigest");
  if ((sequence === 1) !== (previousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const kind = fields.get("kind");
  if (!EVENT_KINDS.has(kind)) throw invalid("kind 无效");
  let memoryRecord;
  try {
    memoryRecord = rawMemoryRecord(fields.get("memoryRecord"));
  } catch (cause) {
    throw invalid("memoryRecord 无效", cause);
  }
  return {
    schemaVersion: 1,
    sequence,
    eventId: text(fields.get("eventId"), "eventId", 96),
    eventDigest: digest(fields.get("eventDigest"), "eventDigest"),
    previousDigest,
    jobId: text(fields.get("jobId"), "jobId", 64, SAFE_JOB_ID),
    jobRevision: integer(fields.get("jobRevision"), "jobRevision", 1),
    sourceRecordDigest: digest(fields.get("sourceRecordDigest"), "sourceRecordDigest"),
    kind,
    occurredAt: timestamp(fields.get("occurredAt"), "occurredAt"),
    memoryRecord,
  };
}

export function codeJobMemorySourceId(jobId, sourceRecordDigest) {
  return `code-job:${text(jobId, "jobId", 64, SAFE_JOB_ID)}:${digest(
    sourceRecordDigest,
    "sourceRecordDigest",
  )}`;
}

export function createCodeJobMemoryEvent(value) {
  const fields = exact(
    value,
    ["sequence", "previousDigest", "job", "kind"],
    "code job memory event input",
  );
  let job;
  try {
    job = normalizeCodeJob(fields.get("job"));
  } catch (cause) {
    throw invalid("代码任务记录无效", cause);
  }
  const normalizedSequence = integer(fields.get("sequence"), "sequence", 1);
  const previousDigest = fields.get("previousDigest");
  const normalizedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, "previousDigest");
  if ((normalizedSequence === 1) !== (normalizedPreviousDigest === null)) {
    throw invalid("previousDigest 与 sequence 不一致");
  }
  const kind = fields.get("kind");
  if (!EVENT_KINDS.has(kind)) throw invalid("kind 无效");
  const snapshot = safeSnapshot(job, kind);
  assertKindMatchesStatus(kind, snapshot.status, snapshot.latestObservation);
  const memoryRecord = rawMemoryRecord(memoryRecordFromSnapshot(
    {
      jobId: job.jobId,
      jobRevision: job.revision,
      sourceRecordDigest: job.recordDigest,
      kind,
      occurredAt: job.updatedAt,
    },
    snapshot,
  ));
  const core = eventCore({
    sequence: normalizedSequence,
    previousDigest: normalizedPreviousDigest,
    jobId: job.jobId,
    jobRevision: job.revision,
    sourceRecordDigest: job.recordDigest,
    kind,
    occurredAt: job.updatedAt,
    memoryRecord,
  });
  const eventDigest = safeDigest(core);
  return {
    ...core,
    eventId: `code-job-memory-event-${eventDigest}`,
    eventDigest,
  };
}

export function normalizeCodeJobMemoryEvent(value) {
  let event;
  try {
    event = normalizeEventFields(value);
    const snapshot = snapshotFromRecord(event.memoryRecord);
    if (
      snapshot.jobId !== event.jobId ||
      snapshot.jobRevision !== event.jobRevision ||
      snapshot.sourceRecordDigest !== event.sourceRecordDigest ||
      snapshot.kind !== event.kind
    ) {
      throw invalid("记忆记录与事件来源不一致");
    }
    const expectedRecord = rawMemoryRecord(memoryRecordFromSnapshot(event, snapshot));
    if (safeDigest(expectedRecord) !== safeDigest(event.memoryRecord)) {
      throw invalid("记忆记录安全摘要不一致");
    }
    const eventDigest = safeDigest(eventCore(event));
    if (
      event.eventDigest !== eventDigest ||
      event.eventId !== `code-job-memory-event-${eventDigest}`
    ) {
      throw invalid("事件摘要不一致");
    }
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) {
      throw invalid("代码任务记忆事件过大");
    }
    return event;
  } catch (error) {
    if (error instanceof CodeJobMemoryEventError) throw error;
    throw invalid(undefined, error);
  }
}

export function memoryRecordForCodeJobEvent(value) {
  return structuredClone(normalizeCodeJobMemoryEvent(value).memoryRecord);
}

export function classifyCodeJobMemoryEvent(previousValue, nextValue) {
  let next;
  let previous;
  try {
    next = normalizeCodeJob(nextValue);
    previous = previousValue === null ? null : normalizeCodeJob(previousValue);
  } catch (cause) {
    throw invalid("代码任务生命周期无效", cause);
  }
  if (previous === null) {
    if (next.execution.memoryProjection !== null) return null;
    if (TERMINAL_KINDS.has(next.status)) return next.status;
    if (next.status === "cancelling") return "cancelling";
    if (next.status === "unknown") return "unknown";
    if (next.status === "paused") return "paused";
    return next.status === "active" && next.execution.observations.length > 0
      ? "observation"
      : null;
  }
  if (previous.jobId !== next.jobId) {
    throw invalid("代码任务生命周期身份不一致");
  }
  if (previous.recordDigest === next.recordDigest) return null;
  if (
    next.revision <= previous.revision ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
    next.execution.observations.length < previous.execution.observations.length
  ) {
    throw invalid("代码任务生命周期不是单调迁移");
  }
  if (TERMINAL_KINDS.has(next.status) && previous.status !== next.status) {
    return next.status;
  }
  if (next.status === "cancelling" && previous.status !== "cancelling") {
    return "cancelling";
  }
  if (previous.status === "unknown" && next.status !== "unknown") {
    return "reconciled";
  }
  if (previous.status === "paused" && next.status !== "paused") {
    return "resumed";
  }
  if (next.status === "unknown" && previous.status !== "unknown") {
    return "unknown";
  }
  if (next.status === "paused" && previous.status !== "paused") {
    return "paused";
  }
  if (next.execution.observations.length > previous.execution.observations.length) {
    return "observation";
  }
  return null;
}
