import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { digestValue } from "../domain/code-executor-contract.js";
import { normalizeCodeJobCompletionReport } from "../domain/code-job-contract.js";
import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";
import { codeExecutionSourceAllowsWrite } from "../domain/code-execution-source.js";
import { projectTestSummary } from "../domain/test-result-summary.js";
import { requiresBrainOperatorPause } from "../domain/brain-failure-recovery.js";
import { hasCompleteCodeRead, isCodeReadContext } from "../lib/code-read-context.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const EXECUTOR_TERMINAL_ACTIONS = new Set([
  "succeeded",
  "failed",
  "interrupted",
]);
const AUTHORITY_ERROR_CODES = new Set(["INVALID_CODE_JOB_AUTHORITY"]);
const FENCING_EXECUTOR_CODES = new Set([
  "CODE_REVIEW_REPAIR_CONTEXT_STALE",
  "CODE_JOB_AUTHORITY_PROTOCOL_ERROR",
  "CODE_JOB_ADMISSION_MISSING",
  "CODE_JOB_AUDIT_RESULT_INVALID",
  "CODE_JOB_EXECUTOR_RESULT_INVALID",
  "CODE_JOB_PENDING_ACTION_MISSING",
  "CODE_JOB_SESSION_BINDING_INVALID",
  "CODE_JOB_SESSION_DIVERGED",
  "CODE_JOB_SESSION_NOT_ACTIVE",
  "CODE_JOB_WORKSPACE_DIVERGED",
  "EXECUTOR_STATE_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "SESSION_NOT_FOUND",
  "WORKSPACE_NOT_CONFIGURED",
  "PROFILE_CONFIG_CHANGED",
  "SOURCE_REVISION_CHANGED",
  "REPLAY_ARTIFACT_INVALID",
  "REPLAY_DIVERGED",
]);
const RESTART_REQUIRED_CODES = new Set([
  "EXECUTION_FENCED",
  "RUNTIME_RESTART_REQUIRED",
]);
const DETERMINISTIC_FAILURE_CODES = new Set([
  "CODE_BRAIN_CONTEXT_TOO_LARGE",
  "CODE_BRAIN_CONTEXT_UNFIT",
]);
const OPERATOR_PAUSE_CODES = new Set([
  "CODE_ARTIFACT_READ_INCOMPLETE",
  "CODE_ARTIFACT_READ_INVALID",
  "CODE_REVIEW_REPAIR_CONTEXT_NOT_CONFIGURED",
  "CODE_BRAIN_ACTION_NOT_PERMITTED",
  "CODE_BRAIN_CHECKS_ALREADY_PASSED",
  "CODE_BRAIN_COMPLETION_NOT_READY",
  "CODE_BRAIN_INCOMPLETE_READ",
  "CODE_BRAIN_PATH_INVALID",
  "CODE_BRAIN_ROLE_NOT_CONFIGURED",
  "CODE_TASK_BRAIN_NOT_CONFIGURED",
  "CODE_BRAIN_RESPONSE_INVALID",
  "CODE_BRAIN_WRITE_NOT_PERMITTED",
]);
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const VERIFICATION_ENVIRONMENT_ERRORS = new Set([
  "SANDBOX_UNAVAILABLE",
  "SANDBOX_START_FAILED",
  "SANDBOX_IMAGE_UNAVAILABLE",
  "SANDBOX_PROFILE_NOT_FOUND",
  "INVALID_SANDBOX_CONFIG",
]);

export class CodeJobWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodeJobWorkerError";
    this.code = code;
  }
}

export function workerError(code, message, options) {
  return new CodeJobWorkerError(code, message, options);
}

export function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function normalizeCycleOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !["limit", "roleId", "signal"].includes(key))
  ) {
    throw new TypeError("code job worker options are invalid");
  }
  const roleId = value.roleId ?? null;
  if (
    roleId !== null &&
    (typeof roleId !== "string" || !SAFE_ROLE_ID.test(roleId))
  ) {
    throw new TypeError("code job worker roleId is invalid");
  }
  return {
    limit: positiveInteger(value.limit ?? 10, "code job worker limit", 100),
    roleId,
    signal: normalizeAbortSignal(value.signal ?? null),
  };
}

export function selectCycleCandidates(
  reconcilable,
  runnable,
  limit,
  preferReconcilable,
) {
  const selected = [];
  let reconciliationIndex = 0;
  let runnableIndex = 0;
  let preferReconciliation = preferReconcilable;
  while (
    selected.length < limit &&
    (reconciliationIndex < reconcilable.length || runnableIndex < runnable.length)
  ) {
    const canReconcile = reconciliationIndex < reconcilable.length;
    const canRun = runnableIndex < runnable.length;
    if ((preferReconciliation && canReconcile) || !canRun) {
      selected.push(reconcilable[reconciliationIndex]);
      reconciliationIndex += 1;
    } else {
      selected.push(runnable[runnableIndex]);
      runnableIndex += 1;
    }
    if (canReconcile && canRun) {
      preferReconciliation = !preferReconciliation;
    }
  }
  return { selected, preferReconcilable: preferReconciliation };
}

function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function cleanText(value, maximumBytes) {
  const clean = String(value ?? "").replace(INVALID_CONTROL, " ");
  const encoded = Buffer.from(clean, "utf8");
  if (encoded.length <= maximumBytes) return clean;
  return encoded
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

export function safeErrorCode(error, fallback = "CODE_JOB_WORKER_FAILED") {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : fallback;
}

export function requiresOperatorPause(code) {
  return OPERATOR_PAUSE_CODES.has(code) || requiresBrainOperatorPause(code);
}

export function isAuthorityErrorCode(code) {
  return AUTHORITY_ERROR_CODES.has(code);
}

export function isFencingExecutorCode(code) {
  return FENCING_EXECUTOR_CODES.has(code);
}

export function isRestartRequiredCode(code) {
  return RESTART_REQUIRED_CODES.has(code);
}

export function isDeterministicFailureCode(code) {
  return DETERMINISTIC_FAILURE_CODES.has(code);
}

export function sameValue(left, right) {
  try {
    return digestValue(left) === digestValue(right);
  } catch {
    return false;
  }
}

function normalizeSemanticPath(value, { allowRoot = false } = {}) {
  try {
    return normalizeWorkspacePath(value, { allowRoot });
  } catch (cause) {
    throw workerError("CODE_BRAIN_PATH_INVALID", "Code brain selected an unsafe path", {
      cause,
    });
  }
}

function compactManifestEntry(entry, kind) {
  const result = { path: cleanText(entry?.path, 1_024) };
  if (kind === "modified") {
    if (isSha256(entry?.beforeSha256)) result.beforeSha256 = entry.beforeSha256;
    if (isSha256(entry?.afterSha256)) result.afterSha256 = entry.afterSha256;
  } else if (isSha256(entry?.sha256)) {
    result.sha256 = entry.sha256;
  }
  return result;
}

function unstartedWindowsProfile(result) {
  const error = result?.error, details = error?.details;
  return error?.code === "SANDBOX_ABORTED" && details?.origin === "windows_fixed_prelaunch" &&
    details.notExecuted === true && details.cleanupPending === false && Object.keys(details).length === 3 &&
    result.exitCode == null && result.timedOut !== true && !result.stdout && !result.stderr &&
    result.testSummary == null && result.runtimeIdentity == null;
}

function compactExecutorResult(action, result) {
  const error = result?.error
    ? {
        code: safeErrorCode(result.error, "ACTION_FAILED"),
        message: cleanText(result.error.message, 2_048),
        ...(action.type === "run_profile" && unstartedWindowsProfile(result)
          ? { details: { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false } } : {}),
      }
    : null;
  if (action.type === "list_files") {
    const files = Array.isArray(result) ? result : [];
    return {
      files: files.slice(0, 500).map((entry) => cleanText(entry, 1_024)),
      truncated: files.length > 500,
      error,
    };
  }
  if (action.type === "read_text") {
    const content = cleanText(result?.content, 64 * 1_024);
    return {
      path: cleanText(result?.path ?? action.path, 1_024),
      content,
      sha256: isSha256(result?.sha256) ? result.sha256 : null,
      bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : 0,
      truncated:
        result?.truncated === true || content !== String(result?.content ?? ""),
      error,
    };
  }
  if (action.type === "search_text") {
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    return {
      matches: matches.slice(0, 200).map((entry) => ({
        path: cleanText(entry?.path, 1_024),
        line: Number.isSafeInteger(entry?.line) ? entry.line : 0,
        column: Number.isSafeInteger(entry?.column) ? entry.column : 0,
        text: cleanText(entry?.text, 2_048),
      })),
      truncated: result?.truncated === true || matches.length > 200,
      error,
    };
  }
  if (action.type === "write_text") {
    return {
      path: cleanText(result?.path ?? action.path, 1_024),
      sha256: isSha256(result?.sha256) ? result.sha256 : null,
      bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : 0,
      error,
    };
  }
  if (action.type === "run_profile") {
    return {
      exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
      signal: result?.signal == null ? null : cleanText(result.signal, 64),
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
      timedOut: result?.timedOut === true,
      stdout: cleanText(result?.stdout, 16 * 1_024),
      stderr: cleanText(result?.stderr, 16 * 1_024),
      ...projectTestSummary(result?.testSummary),
      error,
    };
  }
  const manifest = result && typeof result === "object" ? result : {};
  const compacted = {};
  for (const kind of ["created", "modified", "deleted"]) {
    const entries = Array.isArray(manifest[kind]) ? manifest[kind] : [];
    compacted[kind] = entries
      .slice(0, 200)
      .map((entry) => compactManifestEntry(entry, kind));
    compacted[`${kind}Count`] = entries.length;
  }
  compacted.truncated = ["created", "modified", "deleted"].some(
    (kind) => compacted[`${kind}Count`] > compacted[kind].length,
  );
  compacted.manifestDigest = digestValue(manifest);
  compacted.error = error;
  return compacted;
}

export function observationDetail(action, response, result) {
  return {
    schemaVersion: 1,
    executor: {
      sessionStatus: response.session.status,
      sessionAttemptNumber: response.session.attempt.number,
      actionStatus: response.action.status,
      actionAttemptNumber: response.action.attemptNumber,
    },
    result: compactExecutorResult(action, result),
  };
}

export function trustedObservationAction(observation) {
  const action = observation?.action;
  if (
    !action ||
    typeof action !== "object" ||
    Array.isArray(action) ||
    action.type !== observation.actionType ||
    action.actionId !== observation.actionId ||
    digestValue(action) !== observation.actionDigest
  ) {
    throw workerError(
      "CODE_JOB_OBSERVATION_INVALID",
      "Persisted code job observation is not bound to its trusted action",
    );
  }
  return action;
}

export function modelObservation(observation) {
  const action = trustedObservationAction(observation);
  const result = observation.detail.result ?? {};
  let detail;
  if (action.type === "list_files") {
    detail = { path: action.path, ...result };
  } else if (action.type === "read_text") {
    const content = cleanText(result.content, 24 * 1_024);
    detail = {
      path: action.path,
      content,
      truncated: result.truncated === true || content !== result.content,
      error: result.error ?? null,
    };
  } else if (action.type === "search_text") {
    detail = {
      path: action.path,
      query: action.query,
      matches: Array.isArray(result.matches) ? result.matches.slice(0, 100) : [],
      truncated: result.truncated === true,
      error: result.error ?? null,
    };
  } else if (action.type === "write_text") {
    detail = {
      path: action.path,
      bytes: result.bytes ?? 0,
      error: result.error ?? null,
      ...(observation.detail.origin === 'host_pre_execution_rejection' && observation.detail.notExecuted === true
        ? { notExecuted: true } : {}),
    };
  } else if (action.type === "run_profile") {
    detail = {
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs ?? 0,
      timedOut: result.timedOut === true,
      stdout: cleanText(result.stdout, 8 * 1_024),
      stderr: cleanText(result.stderr, 8 * 1_024),
      ...projectTestSummary(result.testSummary),
      error: result.error ?? null,
    };
  } else {
    detail = {
      created: (result.created ?? []).map(({ path }) => ({ path })),
      modified: (result.modified ?? []).map(({ path }) => ({ path })),
      deleted: (result.deleted ?? []).map(({ path }) => ({ path })),
      truncated: result.truncated === true,
      error: result.error ?? null,
    };
  }
  return {
    actionType: observation.actionType,
    status: observation.status === "succeeded" ? "succeeded" : "failed",
    detail: cleanText(JSON.stringify(detail), 30 * 1_024),
  };
}

export function assertSessionBinding(job, session) {
  const expectedProfiles = job.grant.requiredProfiles.map(({ id }) => id).sort();
  const actualProfiles = Array.isArray(session?.requiredProfiles)
    ? [...session.requiredProfiles].sort()
    : [];
  if (
    session?.id !== job.jobId ||
    session.workspaceId !== job.grant.workspaceId ||
    !sameValue(session.requestedBy, job.grant.requestedBy) ||
    !sameValue(actualProfiles, expectedProfiles) ||
    !isSha256(session.workspaceRevision) ||
    !Number.isSafeInteger(session.attempt?.number) ||
    session.attempt.number < 1
  ) {
    throw workerError(
      "CODE_JOB_SESSION_BINDING_INVALID",
      "Controlled executor session does not match the sealed code job",
    );
  }
  return session;
}

export function successfulProfiles(job, session) {
  const result = new Set();
  for (const observation of job.execution.observations) {
    if (
      observation.actionType !== "run_profile" ||
      observation.status !== "succeeded" ||
      observation.workspaceRevision !== session.workspaceRevision
    ) {
      continue;
    }
    const action = trustedObservationAction(observation);
    if (
      observation.detail?.executor?.actionAttemptNumber === session.attempt.number &&
      job.grant.requiredProfiles.some(({ id }) => id === action.profileId)
    ) {
      result.add(action.profileId);
    }
  }
  return result;
}

export function verificationFailure(job) {
  const latestProfiles = new Set();
  let action;
  const observation = job.execution.observations.findLast((entry) => {
    if (entry.actionType !== "run_profile" ||
        entry.workspaceRevision !== job.execution.workspaceRevision) return false;
    const candidate = trustedObservationAction(entry);
    // An unstarted attempt cannot pass the profile or hide an earlier failure.
    if (entry.status === "failed" && candidate.expectedWorkspaceRevision === entry.workspaceRevision &&
        job.grant.requiredProfiles.some(({ id }) => id === candidate.profileId) && unstartedWindowsProfile(entry.detail?.result)) return false;
    if (latestProfiles.has(candidate.profileId)) return false;
    latestProfiles.add(candidate.profileId);
    if (entry.status !== "failed") return false;
    // Code changes can repair failed assertions, but cannot repair the host's
    // sandbox or fixed profile configuration by asking the model again.
    if (job.grant.operation !== "verify" &&
        !VERIFICATION_ENVIRONMENT_ERRORS.has(safeErrorCode(entry.detail?.result?.error, "ACTION_FAILED"))) return false;
    action = candidate;
    return true;
  });
  if (!observation) return null;
  if (
    action.expectedWorkspaceRevision !== observation.workspaceRevision ||
    !job.grant.requiredProfiles.some(({ id }) => id === action.profileId)
  ) {
    throw workerError(
      "CODE_JOB_EXECUTOR_RESULT_INVALID",
      "Failed verification observation does not match its sealed profile and workspace",
    );
  }
  const result = observation.detail?.result ?? {};
  const errorCode = safeErrorCode(result.error, "ACTION_FAILED");
  const reference = `测试配置 ${cleanText(action.profileId, 128)}（动作 ${action.actionId}，工作区 ${observation.workspaceRevision}）`;
  if (result.timedOut === true || errorCode === "SANDBOX_TIMEOUT") {
    return {
      code: "CODE_JOB_VERIFICATION_TIMEOUT",
      message: `${reference}执行超时。请检查执行日志、运行耗时和超时配置后重新发起验证。`,
    };
  }
  if (VERIFICATION_ENVIRONMENT_ERRORS.has(errorCode)) {
    return {
      code: "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      message: `${reference}的测试环境不可用（${errorCode}）。请恢复沙箱、镜像或测试配置后重新发起验证。`,
    };
  }
  const verificationFailed = errorCode === "TESTS_FAILED" ||
    (Number.isSafeInteger(result.exitCode) && result.exitCode !== 0);
  return {
    code: verificationFailed ? "CODE_JOB_VERIFICATION_FAILED" : "CODE_JOB_VERIFICATION_UNKNOWN",
    message: `${reference}验证未通过（${errorCode}${Number.isSafeInteger(result.exitCode) ? `，退出码 ${result.exitCode}` : ""}），失败原因尚未确认。请检查测试日志、依赖和运行环境，处理后重新发起验证。`,
  };
}

export function incompleteReadMessage(path) {
  return `无法覆盖 ${cleanText(path, 1_024)}：当前模型上下文未包含该文件的完整读取结果，请完整读取文件或调整任务范围后重试`;
}

function incompleteReadError(path) {
  return workerError(
    "CODE_BRAIN_INCOMPLETE_READ",
    incompleteReadMessage(path),
  );
}

function expectedWriteSha(job, path, workspaceRevision, visibleObservations, codeReadContext) {
  for (let index = job.execution.observations.length - 1; index >= 0; index -= 1) {
    const observation = job.execution.observations[index];
    if (
      observation.status !== "succeeded" ||
      observation.workspaceRevision !== workspaceRevision ||
      observation.actionType !== "read_text"
    ) {
      continue;
    }
    const action = trustedObservationAction(observation);
    if (action.path !== path) continue;
    const result = observation.detail?.result;
    if (isCodeReadContext(codeReadContext)) {
      if (action.expectedWorkspaceRevision === workspaceRevision && isSha256(result?.sha256) && hasCompleteCodeRead(codeReadContext, {
        jobId: job.jobId, workspaceRevision, actionId: action.actionId, path, sha256: result.sha256,
      })) return result.sha256;
      // The directory may repack previews while adding the document manifest.
      // Only actual native reads prove what that invocation could see.
      throw incompleteReadError(path);
    }
    const visible = visibleObservations.some((entry) => {
      if (entry.actionType !== "read_text" || entry.status !== "succeeded") return false;
      try {
        const detail = JSON.parse(entry.detail);
        return detail?.compacted !== true && detail?.path === path &&
          detail.content === result?.content && detail.truncated === false &&
          detail.error == null;
      } catch {
        return false;
      }
    });
    if (
      !isSha256(result?.sha256) || typeof result.content !== "string" ||
      result.truncated !== false || result.error != null || !visible
    ) {
      throw incompleteReadError(path);
    }
    return result.sha256;
  }
  return null;
}

export function assertPreparedWriteRead(job, session, action, visibleObservations, codeReadContext) {
  if (action.type !== "write_text" || action.expectedSha256 === null) return;
  if (expectedWriteSha(job, action.path, session.workspaceRevision, visibleObservations, codeReadContext) !== action.expectedSha256) {
    throw incompleteReadError(action.path);
  }
}

function actionId(job, semanticAction) {
  const digest = digestValue({
    schemaVersion: 1,
    jobId: job.jobId,
    turn: job.execution.turn + 1,
    semanticAction,
  });
  return `action-${digest.slice(0, 55)}`;
}

export function bindTrustedAction(job, session, semanticAction, remainingProfiles, visibleObservations = [], codeReadContext) {
  if (!job.grant.allowedActions.includes(semanticAction.type)) {
    throw workerError(
      "CODE_BRAIN_ACTION_NOT_PERMITTED",
      "Code brain selected an action outside the sealed grant",
    );
  }
  const common = {
    type: semanticAction.type,
    actionId: actionId(job, semanticAction),
    expectedWorkspaceRevision: session.workspaceRevision,
  };
  if (semanticAction.type === "list_files") {
    return {
      ...common,
      path: normalizeSemanticPath(semanticAction.path, { allowRoot: true }),
    };
  }
  if (semanticAction.type === "read_text") {
    return { ...common, path: normalizeSemanticPath(semanticAction.path) };
  }
  if (semanticAction.type === "search_text") {
    return {
      ...common,
      path: normalizeSemanticPath(semanticAction.path, { allowRoot: true }),
      query: semanticAction.query,
    };
  }
  if (semanticAction.type === "write_text") {
    const path = normalizeSemanticPath(semanticAction.path);
    const writable = job.grant.schemaVersion === 3
      ? codeExecutionSourceAllowsWrite(job.grant.executionSource, path)
      : job.grant.writablePaths.some(
          (candidate) => path === candidate || path.startsWith(`${candidate}/`),
        );
    if (!writable) {
      throw workerError(
        "CODE_BRAIN_WRITE_NOT_PERMITTED",
        "Code brain selected a path outside the sealed write scope",
      );
    }
    return {
      ...common,
      path,
      content: semanticAction.content,
      expectedSha256: expectedWriteSha(
        job,
        path,
        session.workspaceRevision,
        visibleObservations,
        codeReadContext,
      ),
    };
  }
  if (semanticAction.type === "run_profile") {
    if (remainingProfiles.length === 0) {
      throw workerError(
        "CODE_BRAIN_CHECKS_ALREADY_PASSED",
        "No trusted test profile remains",
      );
    }
    return { ...common, profileId: remainingProfiles[0].id };
  }
  if (remainingProfiles.length !== 0) {
    throw workerError(
      "CODE_BRAIN_COMPLETION_NOT_READY",
      "Required trusted checks have not passed",
    );
  }
  return common;
}

export function completionReportForAction(action, semanticAction) {
  return action.type === "complete" ? { completionReport: normalizeCodeJobCompletionReport({
    actionId: action.actionId, actionDigest: digestValue(action), workspaceRevision: action.expectedWorkspaceRevision,
    outcome: semanticAction.outcome, evidence: semanticAction.evidence,
  }, action) } : {};
}

export function terminalResult(job, action, detail, workspaceRevision, completionReport) {
  const result = detail?.result ?? {};
  const report = completionReport === undefined ? null : normalizeCodeJobCompletionReport(completionReport, action);
  return {
    schemaVersion: 1,
    outcome: report?.outcome ?? job.grant.summary,
    evidence: [...job.grant.evidence],
    ...(report === null ? {} : { completionReport: report }),
    checks: job.grant.requiredProfiles.map(({ id }) => id),
    workspaceRevision,
    manifest: result,
    completedActionId: action.actionId,
  };
}

export function normalizeActionResponse(pending, response) {
  if (
    !response ||
    typeof response !== "object" ||
    response.action?.id !== pending.actionId ||
    response.action.type !== pending.action.type ||
    response.action.workspaceRevisionBefore !==
      pending.action.expectedWorkspaceRevision ||
    !EXECUTOR_TERMINAL_ACTIONS.has(response.action.status) ||
    !isSha256(response.session?.workspaceRevision)
  ) {
    throw workerError(
      "CODE_JOB_EXECUTOR_RESULT_INVALID",
      "Controlled executor returned an invalid action result",
    );
  }
  return response;
}
