import { createHash } from "node:crypto";
import { withPreparationCancellation, withoutPreparationCancellation, throwIfPreparationAborted,
  isPreparationAbort } from "../lib/preparation-cancellation.js";
import {
  ControlledCodeExecutorError,
  digestValue,
  normalizeActionRequest,
  normalizeResumeRequest,
  normalizeRuntimeOptions,
  normalizeStartRequest,
} from "../domain/code-executor-contract.js";
import { CodeExecutionError } from "../domain/code-execution-policy.js";
import {
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "../domain/code-execution-source.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { DockerSandboxError } from "../adapters/docker-test-sandbox.js";
import { WindowsTestRunnerError } from "../adapters/windows-fixed-test-runner.js";
import { executionIdentityKeys, executionIdentityFields, isExecutionIdentityProof } from "../domain/test-runtime-identity.js";
import { isWindowsTestProfile } from "../domain/windows-test-profile.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { CodeExecutionJournalError } from "./code-execution-journal.js";

export { ControlledCodeExecutorError };

const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 3;
export const CONTROLLED_CODE_EXECUTOR_STATE_KEY = "code-executor-state";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MISSING_STATE = Object.freeze({ missing: true });
const RECOVERABLE_STATUSES = new Set([
  "preparing",
  "active",
  "running",
  "replaying",
  "completing",
]);
const SESSION_STATUSES = new Set([
  ...RECOVERABLE_STATUSES,
  "interrupted",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
const ACTION_STATUSES = new Set([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const ACTION_TYPES = new Set([
  "list_files",
  "read_text",
  "search_text",
  "write_text",
  "run_profile",
  "complete",
]);
const REPLAY_STATUSES = new Set([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const ARTIFACT_KINDS = new Set([
  "input",
  "output",
  "manifest",
  "stdout",
  "stderr",
]);
const ERROR_DETAIL_KEYS = new Set([
  "exitCode",
  "signal",
  "durationMs",
  "truncated",
  "cleanupPending",
  "containerName",
]);
const SESSION_STATE_KEYS = Object.freeze([
  "id",
  "workspaceId",
  "requestedBy",
  "inputBinding",
  "requestDigest",
  "status",
  "revision",
  "sourceRevision",
  "workspaceRevision",
  "requiredProfiles",
  "verifiedProfiles",
  "actions",
  "attempts",
  "events",
  "nextSequence",
  "cleanupFence",
  "cancellation",
  "createdAt",
  "updatedAt",
  "completedAt",
  "error",
]);
const LEGACY_SESSION_STATE_KEYS = Object.freeze(
  SESSION_STATE_KEYS.filter((key) => key !== "inputBinding"),
);
const CONFLICT_SESSION_STATE_KEYS = Object.freeze([
  ...SESSION_STATE_KEYS,
  "executionSource",
]);

function executorError(code, message) {
  return new ControlledCodeExecutorError(code, message);
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actualKeys.length === expected.length &&
    expected.every((key, index) => key === actualKeys[index])
  );
}

function hasOnlyKeys(value, allowedKeys) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function isInputBinding(value) {
  if (value === null) return true;
  try {
    const normalized = normalizePullRequestExecutionBinding(value);
    return GIT_OID.test(normalized.headRefOid);
  } catch {
    return false;
  }
}

function sameInputBinding(left, right) {
  if (left === null || right === null) return left === right;
  try {
    return samePullRequestExecutionBinding(left, right);
  } catch {
    return false;
  }
}

function isExecutionSource(value) {
  try {
    normalizeCodeExecutionSource(value);
    return true;
  } catch {
    return false;
  }
}

function sameExecutionSource(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return sameCodeExecutionSource(left, right);
}

function sessionRequestDigest({
  workspaceId,
  requestedBy,
  inputBinding,
  executionSource,
  requiredProfiles,
}) {
  return digestValue({
    workspaceId,
    requestedBy,
    inputBinding,
    ...(executionSource === undefined ? {} : { executionSource }),
    requiredProfiles,
  });
}

function legacySessionRequestDigest({
  workspaceId,
  requestedBy,
  requiredProfiles,
}) {
  return digestValue({ workspaceId, requestedBy, requiredProfiles });
}

function assertSessionInputBinding(session, inputBinding, executionSource) {
  const sessionSource = Object.hasOwn(session, "executionSource")
    ? session.executionSource
    : undefined;
  if (
    !sameInputBinding(session.inputBinding, inputBinding) ||
    !sameExecutionSource(sessionSource, executionSource)
  ) {
    throw executorError(
      "IDEMPOTENCY_CONFLICT",
      "代码执行会话已绑定到不同的输入",
    );
  }
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, sessions: {} };
}

function invalidState() {
  throw executorError("EXECUTOR_STATE_INVALID", "代码执行状态无效");
}

function isTimestamp(value, { nullable = false } = {}) {
  return (
    (nullable && value === null) ||
    (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)))
  );
}

function isRevision(value, { nullable = false } = {}) {
  return (nullable && value === null) || (typeof value === "string" && SHA256.test(value));
}

function isRecordedError(value, { nullable = true } = {}) {
  if (nullable && value === null) return true;
  if (
    !hasOnlyKeys(value, new Set(["code", "message", "details"])) ||
    !Object.hasOwn(value, "code") ||
    !Object.hasOwn(value, "message") ||
    typeof value.code !== "string" ||
    !/^[A-Z0-9_]+$/.test(value.code) ||
    typeof value.message !== "string" ||
    value.message.length < 1
  ) {
    return false;
  }
  if (!Object.hasOwn(value, "details")) return true;
  if (Object.hasOwn(value.details ?? {}, "origin") || Object.hasOwn(value.details ?? {}, "notExecuted")) {
    return value.code === "SANDBOX_ABORTED" && hasExactKeys(value.details, ["origin", "notExecuted", "cleanupPending"]) &&
      value.details.origin === "windows_fixed_prelaunch" && value.details.notExecuted === true && value.details.cleanupPending === false;
  }
  if (!hasOnlyKeys(value.details, ERROR_DETAIL_KEYS)) return false;
  return Object.entries(value.details).every(([key, entry]) => {
    if (["cleanupPending", "truncated"].includes(key)) {
      return typeof entry === "boolean";
    }
    if (key === "durationMs") {
      return Number.isFinite(entry) && entry >= 0;
    }
    if (key === "exitCode") {
      return entry === null || Number.isSafeInteger(entry);
    }
    if (key === "signal") {
      return entry === null || (typeof entry === "string" && entry.length <= 64);
    }
    if (key === "containerName") {
      return entry === null ||
        (typeof entry === "string" && SAFE_CONTAINER_NAME.test(entry));
    }
    return false;
  });
}

function isArtifactReference(value, sessionId, actionId, kind) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).sort().join(",") === "bytes,path,sha256" &&
    value.path === `${sessionId}/${actionId}/${kind}.json` &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0
  );
}

function validateAttempt(sessionId, attempt, expectedNumber, actionIds) {
  if (
    !hasExactKeys(attempt, [
      "number",
      "executionId",
      "status",
      "startedAt",
      "finishedAt",
      "replays",
    ]) ||
    attempt.number !== expectedNumber ||
    attempt.executionId !== attemptExecutionId(sessionId, expectedNumber) ||
    !SESSION_STATUSES.has(attempt.status) ||
    !isTimestamp(attempt.startedAt) ||
    !isTimestamp(attempt.finishedAt, { nullable: true }) ||
    !Array.isArray(attempt.replays)
  ) {
    invalidState();
  }
  for (const replay of attempt.replays) {
    const replayKeys = isPlainRecord(replay) && Object.hasOwn(replay, "error")
      ? ["sourceActionId", "status", "startedAt", "finishedAt", "error"]
      : ["sourceActionId", "status", "startedAt", "finishedAt"];
    if (
      !hasExactKeys(replay, replayKeys) ||
      !SAFE_ID.test(replay.sourceActionId) ||
      !actionIds.has(replay.sourceActionId) ||
      !REPLAY_STATUSES.has(replay.status) ||
      !isTimestamp(replay.startedAt) ||
      !isTimestamp(replay.finishedAt, { nullable: true }) ||
      (Object.hasOwn(replay, "error") && !isRecordedError(replay.error))
    ) {
      invalidState();
    }
  }
}

function validateAction(sessionId, action, attemptCount) {
  if (
    !hasExactKeys(action, [
      "id",
      "type",
      "requestDigest",
      "status",
      "attemptNumber",
      "inputArtifact",
      "outputArtifacts",
      "workspaceRevisionBefore",
      "workspaceRevisionAfter",
      "startedAt",
      "finishedAt",
      "error",
    ]) ||
    !SAFE_ID.test(action.id) ||
    !ACTION_TYPES.has(action.type) ||
    typeof action.requestDigest !== "string" ||
    !SHA256.test(action.requestDigest) ||
    !ACTION_STATUSES.has(action.status) ||
    !Number.isSafeInteger(action.attemptNumber) ||
    action.attemptNumber < 1 ||
    action.attemptNumber > attemptCount ||
    !isArtifactReference(action.inputArtifact, sessionId, action.id, "input") ||
    !isPlainRecord(action.outputArtifacts) ||
    !isRevision(action.workspaceRevisionBefore) ||
    !isRevision(action.workspaceRevisionAfter, { nullable: true }) ||
    !isTimestamp(action.startedAt) ||
    !isTimestamp(action.finishedAt, { nullable: true }) ||
    !isRecordedError(action.error)
  ) {
    invalidState();
  }
  if (action.error?.details?.notExecuted === true && (action.type !== "run_profile" || action.status !== "failed" ||
      action.workspaceRevisionAfter !== action.workspaceRevisionBefore)) invalidState();
  for (const [kind, reference] of Object.entries(action.outputArtifacts)) {
    if (
      !ARTIFACT_KINDS.has(kind) ||
      kind === "input" ||
      !isArtifactReference(reference, sessionId, action.id, kind)
    ) {
      invalidState();
    }
  }
  if (
    action.status === "running" &&
    (action.finishedAt !== null || action.workspaceRevisionAfter !== null)
  ) {
    invalidState();
  }
  if (
    action.status !== "running" &&
    (!isTimestamp(action.finishedAt) ||
      (action.status === "succeeded" && action.error !== null) ||
      (action.status !== "succeeded" && !isRecordedError(action.error, { nullable: false })))
  ) {
    invalidState();
  }
}

function validateProfileState(session) {
  if (!Array.isArray(session.requiredProfiles) || session.requiredProfiles.length < 1) {
    invalidState();
  }
  const profileIds = new Set();
  for (const profile of session.requiredProfiles) {
    if (
      !hasExactKeys(profile, ["id", "configDigest"]) ||
      !SAFE_ID.test(profile.id) ||
      profileIds.has(profile.id) ||
      typeof profile.configDigest !== "string" ||
      !SHA256.test(profile.configDigest)
    ) {
      invalidState();
    }
    profileIds.add(profile.id);
  }
  if (!isPlainRecord(session.verifiedProfiles)) invalidState();
  for (const [profileId, proof] of Object.entries(session.verifiedProfiles)) {
    if (
      !profileIds.has(profileId) ||
      !hasExactKeys(proof, [
        "passed",
        "actionId",
        "attemptNumber",
        "workspaceRevision",
        "configDigest",
        ...executionIdentityKeys(proof),
      ]) ||
      typeof proof.passed !== "boolean" ||
      !SAFE_ID.test(proof.actionId) ||
      !Number.isSafeInteger(proof.attemptNumber) ||
      proof.attemptNumber < 1 ||
      !isRevision(proof.workspaceRevision) ||
      !isRevision(proof.configDigest) ||
      !isExecutionIdentityProof(proof) ||
      (proof.runtimeIdentity && (proof.runtimeIdentity.actionId !== proof.actionId || proof.runtimeIdentity.executionId !== attemptExecutionId(session.id, proof.attemptNumber)))
    ) {
      invalidState();
    }
  }
}

function validateSession(sessionId, session) {
  const hasExecutionSource = isPlainRecord(session) &&
    Object.hasOwn(session, "executionSource");
  if (
    !SAFE_ID.test(sessionId) ||
    !hasExactKeys(
      session,
      hasExecutionSource ? CONFLICT_SESSION_STATE_KEYS : SESSION_STATE_KEYS,
    ) ||
    session.id !== sessionId ||
    !SAFE_ID.test(session.workspaceId) ||
    !hasExactKeys(session.requestedBy, ["roleId", "workItemId"]) ||
    !SAFE_ROLE_ID.test(session.requestedBy.roleId) ||
    !(
      session.requestedBy.workItemId === null ||
      (typeof session.requestedBy.workItemId === "string" &&
        session.requestedBy.workItemId.length > 0 &&
        session.requestedBy.workItemId.length <= 256 &&
        !CONTROL_CHARACTER.test(session.requestedBy.workItemId))
    ) ||
    !isInputBinding(session.inputBinding) ||
    (hasExecutionSource &&
      (!isExecutionSource(session.executionSource) ||
        session.inputBinding === null ||
        !sameCodeExecutionSource(session.executionSource, {
          ...session.executionSource,
          inputBinding: session.inputBinding,
        }))) ||
    typeof session.requestDigest !== "string" ||
    !SHA256.test(session.requestDigest) ||
    !SESSION_STATUSES.has(session.status) ||
    !Number.isSafeInteger(session.revision) ||
    session.revision < 0 ||
    !isRevision(session.sourceRevision, { nullable: true }) ||
    !isRevision(session.workspaceRevision, { nullable: true }) ||
    !Array.isArray(session.actions) ||
    !Array.isArray(session.attempts) ||
    session.attempts.length < 1 ||
    !Array.isArray(session.events) ||
    !Number.isSafeInteger(session.nextSequence) ||
    session.nextSequence < 1 ||
    !isTimestamp(session.createdAt) ||
    !isTimestamp(session.updatedAt) ||
    !isTimestamp(session.completedAt, { nullable: true }) ||
    !isRecordedError(session.error)
  ) {
    invalidState();
  }
  if (
    (session.sourceRevision === null) !== (session.workspaceRevision === null) ||
    (session.sourceRevision === null && session.actions.length > 0)
  ) {
    invalidState();
  }
  validateProfileState(session);
  if (session.requestDigest !== sessionRequestDigest(session)) invalidState();
  const actionIds = new Set();
  for (const action of session.actions) {
    validateAction(sessionId, action, session.attempts.length);
    if (actionIds.has(action.id)) invalidState();
    actionIds.add(action.id);
  }
  session.attempts.forEach((attempt, index) =>
    validateAttempt(sessionId, attempt, index + 1, actionIds),
  );
  const activeAttempt = currentAttempt(session);
  if (activeAttempt.status !== session.status) invalidState();
  for (const historicalAttempt of session.attempts.slice(0, -1)) {
    if (
      RECOVERABLE_STATUSES.has(historicalAttempt.status) ||
      historicalAttempt.replays.some((replay) => replay.status === "running")
    ) {
      invalidState();
    }
  }
  const runningActions = session.actions.filter(
    (action) => action.status === "running",
  );
  const runningReplays = activeAttempt.replays.filter(
    (replay) => replay.status === "running",
  );
  if (
    runningActions.some(
      (action) => action.attemptNumber !== activeAttempt.number,
    ) ||
    (session.status === "running" &&
      (runningActions.length !== 1 || runningActions[0].type === "complete")) ||
    (session.status === "completing" &&
      (runningActions.length !== 1 || runningActions[0].type !== "complete")) ||
    (session.status === "replaying" &&
      (runningActions.length !== 0 || runningReplays.length > 1)) ||
    (!["running", "completing"].includes(session.status) &&
      runningActions.length !== 0) ||
    (session.status !== "replaying" && runningReplays.length !== 0)
  ) {
    invalidState();
  }
  for (const [profileId, proof] of Object.entries(session.verifiedProfiles)) {
    const proofAction = session.actions.find(
      (action) => action.id === proof.actionId,
    );
    const requiredProfile = session.requiredProfiles.find(
      (profile) => profile.id === profileId,
    );
    if (
      !proofAction ||
      !requiredProfile ||
      proofAction.type !== "run_profile" ||
      proofAction.attemptNumber !== proof.attemptNumber ||
      proofAction.workspaceRevisionAfter !== proof.workspaceRevision ||
      proof.configDigest !== requiredProfile.configDigest ||
      (proof.passed && proofAction.status !== "succeeded") ||
      (!proof.passed && proofAction.status !== "failed")
    ) {
      invalidState();
    }
  }
  let expectedSequence = 1;
  for (const event of session.events) {
    const eventKeys = isPlainRecord(event) && Object.hasOwn(event, "actionId")
      ? ["sequence", "type", "at", "attemptNumber", "actionId"]
      : ["sequence", "type", "at", "attemptNumber"];
    if (
      !hasExactKeys(event, eventKeys) ||
      event.sequence !== expectedSequence ||
      typeof event.type !== "string" ||
      event.type.length < 1 ||
      !isTimestamp(event.at) ||
      !Number.isSafeInteger(event.attemptNumber) ||
      event.attemptNumber < 1 ||
      event.attemptNumber > session.attempts.length ||
      (Object.hasOwn(event, "actionId") && !SAFE_ID.test(event.actionId))
    ) {
      invalidState();
    }
    expectedSequence += 1;
  }
  if (session.nextSequence !== expectedSequence) invalidState();
  if (session.cleanupFence !== null) {
    const fence = session.cleanupFence;
    const fencedAction = session.actions.find(
      (action) => action.id === fence.actionId,
    );
    const fencedAttempt = fencedAction
      ? session.attempts[fencedAction.attemptNumber - 1]
      : null;
    if (
      !hasExactKeys(fence, [
        "executionId",
        "actionId",
        "containerName",
        "since",
        "lastError",
      ]) ||
      !SAFE_ID.test(fence.executionId) ||
      !SAFE_ID.test(fence.actionId) ||
      !(
        fence.containerName === null ||
        (typeof fence.containerName === "string" &&
          SAFE_CONTAINER_NAME.test(fence.containerName))
      ) ||
      !isTimestamp(fence.since) ||
      !isRecordedError(fence.lastError, { nullable: false }) ||
      !fencedAction ||
      fencedAction.type !== "run_profile" ||
      fencedAction.status !== "interrupted" ||
      fencedAttempt?.executionId !== fence.executionId
    ) {
      invalidState();
    }
  }
  if (session.cancellation !== null) {
    const cancellation = session.cancellation;
    if (
      !hasExactKeys(cancellation, [
        "digest",
        "expectedWorkspaceRevision",
        "expectedAction",
        "startedAt",
        "settledAt",
      ]) ||
      !isRevision(cancellation.digest) ||
      !isRevision(cancellation.expectedWorkspaceRevision, { nullable: true }) ||
      !isTimestamp(cancellation.startedAt) ||
      !isTimestamp(cancellation.settledAt, { nullable: true }) ||
      !(
        cancellation.expectedAction === null ||
        (hasExactKeys(cancellation.expectedAction, [
          "actionId",
          "actionDigest",
        ]) &&
          SAFE_ID.test(cancellation.expectedAction.actionId) &&
          isRevision(cancellation.expectedAction.actionDigest))
      )
    ) {
      invalidState();
    }
  }
  if (session.status === "completed" && !isTimestamp(session.completedAt)) {
    invalidState();
  }
  if (session.status === "completed") {
    const completedActions = session.actions.filter(
      (action) => action.type === "complete" && action.status === "succeeded",
    );
    const completedAction = completedActions[0];
    const completeOutputKeys = completedAction
      ? Object.keys(completedAction.outputArtifacts)
      : [];
    if (
      completedActions.length !== 1 ||
      session.actions.at(-1) !== completedAction ||
      completedAction.attemptNumber !== activeAttempt.number ||
      completedAction.workspaceRevisionBefore !== session.workspaceRevision ||
      completedAction.workspaceRevisionAfter !== session.workspaceRevision ||
      completeOutputKeys.length !== 1 ||
      completeOutputKeys[0] !== "manifest" ||
      completedAction.finishedAt !== session.completedAt ||
      Object.keys(session.verifiedProfiles).length !==
        session.requiredProfiles.length ||
      session.requiredProfiles.some((profile) => {
        const proof = Object.hasOwn(session.verifiedProfiles, profile.id)
          ? session.verifiedProfiles[profile.id]
          : null;
        return (
          !proof?.passed ||
          proof.attemptNumber !== activeAttempt.number ||
          proof.workspaceRevision !== session.workspaceRevision ||
          proof.configDigest !== profile.configDigest
        );
      })
    ) {
      invalidState();
    }
  }
  if (
    (session.status !== "completed" && session.completedAt !== null) ||
    (session.status === "failed" && !isRecordedError(session.error, { nullable: false })) ||
    (session.status !== "failed" && session.error !== null) ||
    (session.cleanupFence !== null &&
      !["interrupted", "cancelling"].includes(session.status)) ||
    (["cancelling", "cancelled"].includes(session.status) !==
      (session.cancellation !== null)) ||
    (session.status === "cancelling" &&
      session.cancellation?.settledAt !== null) ||
    (session.status === "cancelled" &&
      (!isTimestamp(session.cancellation?.settledAt) ||
        session.cleanupFence !== null))
  ) {
    invalidState();
  }
}

function upgradeLegacyState(value) {
  if (isPlainRecord(value) && [1, 2].includes(value.schemaVersion) && isPlainRecord(value.sessions)) {
    if (Object.values(value.sessions).some((session) => isPlainRecord(session?.verifiedProfiles) &&
      Object.values(session.verifiedProfiles).some((proof) => Object.hasOwn(proof ?? {}, "runtimeIdentity")))) return value;
    if (value.schemaVersion === 2) { value.schemaVersion = SCHEMA_VERSION; return value; }
  }
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== LEGACY_SCHEMA_VERSION ||
    !isPlainRecord(value.sessions)
  ) {
    return value;
  }
  for (const session of Object.values(value.sessions)) {
    if (!isPlainRecord(session)) return value;
    if (!Object.hasOwn(session, "cancellation")) {
      session.cancellation = null;
    }
    if (
      !hasExactKeys(session, LEGACY_SESSION_STATE_KEYS) ||
      typeof session.requestDigest !== "string" ||
      !SHA256.test(session.requestDigest) ||
      session.requestDigest !== legacySessionRequestDigest(session)
    ) {
      return value;
    }
    session.inputBinding = null;
    try {
      session.requestDigest = sessionRequestDigest(session);
    } catch {
      return value;
    }
  }
  value.schemaVersion = SCHEMA_VERSION;
  return value;
}

function validateState(value) {
  if (
    !hasExactKeys(value, ["schemaVersion", "revision", "sessions"]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !isPlainRecord(value.sessions)
  ) {
    invalidState();
  }
  for (const [sessionId, session] of Object.entries(value.sessions)) {
    validateSession(sessionId, session);
  }
  return value;
}

export function normalizeControlledCodeExecutorState(value) {
  let candidate;
  try {
    candidate = structuredClone(value);
  } catch {
    invalidState();
  }
  return validateState(upgradeLegacyState(candidate));
}

function validateDependency(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw executorError("INVALID_EXECUTOR_CONFIG", `${label} 配置无效`);
  }
  return value;
}

function normalizeViewRequest(value) {
  if (!isPlainRecord(value)) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "sessionId");
  if (
    keys.length !== 1 ||
    keys[0] !== "sessionId" ||
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !SAFE_ID.test(descriptor.value)
  ) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  return { sessionId: descriptor.value };
}

function normalizeActionResultRequest(value) {
  if (!isPlainRecord(value)) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const expectedKeys = ["sessionId", "actionId"];
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const normalized = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !SAFE_ID.test(descriptor.value)
    ) {
      throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function normalizeCompletedChangeExportRequest(value) {
  if (!isPlainRecord(value)) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const expectedKeys = [
    "sessionId",
    "completedActionId",
    "expectedWorkspaceRevision",
  ];
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const normalized = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const valid = key === "expectedWorkspaceRevision" ? SHA256 : SAFE_ID;
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !valid.test(descriptor.value)
    ) {
      throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function normalizeCancellationRequest(value) {
  if (!isPlainRecord(value)) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  const hasExecutionSource = Object.hasOwn(value, "executionSource");
  const expectedKeys = [
    "sessionId",
    "inputBinding",
    ...(hasExecutionSource ? ["executionSource"] : []),
    "cancellationDigest",
    "expectedWorkspaceRevision",
    "expectedAction",
  ];
  if (!hasExactKeys(value, expectedKeys)) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  if (
    typeof value.sessionId !== "string" ||
    !SAFE_ID.test(value.sessionId) ||
    !isInputBinding(value.inputBinding) ||
    !isRevision(value.cancellationDigest) ||
    !isRevision(value.expectedWorkspaceRevision, { nullable: true })
  ) {
    throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
  }
  let expectedAction = null;
  if (value.expectedAction !== null) {
    if (
      !hasExactKeys(value.expectedAction, ["actionId", "actionDigest"]) ||
      typeof value.expectedAction.actionId !== "string" ||
      !SAFE_ID.test(value.expectedAction.actionId) ||
      !isRevision(value.expectedAction.actionDigest)
    ) {
      throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
    }
    expectedAction = {
      actionId: value.expectedAction.actionId,
      actionDigest: value.expectedAction.actionDigest,
    };
  }
  const inputBinding = value.inputBinding === null
    ? null
    : normalizePullRequestExecutionBinding(value.inputBinding);
  let executionSource;
  if (hasExecutionSource) {
    try {
      executionSource = normalizeCodeExecutionSource(value.executionSource);
    } catch {
      throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
    }
    if (
      inputBinding === null ||
      !sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding,
      })
    ) {
      throw executorError("INVALID_EXECUTION_REQUEST", "代码执行请求无效");
    }
  }
  return {
    sessionId: value.sessionId,
    inputBinding,
    ...(hasExecutionSource ? { executionSource } : {}),
    cancellationDigest: value.cancellationDigest,
    expectedWorkspaceRevision: value.expectedWorkspaceRevision,
    expectedAction,
  };
}

function contentSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageArtifact(ref) {
  return { path: ref.path, sha256: ref.sha256, bytes: ref.bytes };
}

function compareChangePath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function canonicalChangeManifest(value) {
  return {
    created: [...value.created].sort(compareChangePath),
    modified: [...value.modified].sort(compareChangePath),
    deleted: [...value.deleted].sort(compareChangePath),
  };
}

function normalizeLimits(limits = {}) {
  const normalized = {
    maxSessions: limits.maxSessions ?? 100,
    maxActionsPerSession: limits.maxActionsPerSession ?? 200,
  };
  if (
    !Number.isSafeInteger(normalized.maxSessions) ||
    normalized.maxSessions < 1 ||
    !Number.isSafeInteger(normalized.maxActionsPerSession) ||
    normalized.maxActionsPerSession < 1
  ) {
    throw executorError("INVALID_EXECUTOR_CONFIG", "代码执行限制无效");
  }
  return Object.freeze(normalized);
}

function normalizeProfileConfiguration(
  profileDefinitions,
  requiredProfilesByWorkspace,
) {
  if (
    !isPlainRecord(profileDefinitions) ||
    !isPlainRecord(requiredProfilesByWorkspace)
  ) {
    throw executorError("INVALID_EXECUTOR_CONFIG", "测试配置无效");
  }
  const profiles = new Map();
  for (const [profileId, definition] of Object.entries(profileDefinitions)) {
    if (!SAFE_ID.test(profileId) || !isPlainRecord(definition)) {
      throw executorError("INVALID_EXECUTOR_CONFIG", "测试配置无效");
    }
    profiles.set(profileId, {
      id: profileId,
      configDigest: digestValue(definition),
    });
  }
  const byWorkspace = new Map();
  for (const [workspaceId, profileIds] of Object.entries(
    requiredProfilesByWorkspace,
  )) {
    if (
      !SAFE_ID.test(workspaceId) ||
      !Array.isArray(profileIds) ||
      profileIds.length < 1 ||
      new Set(profileIds).size !== profileIds.length
    ) {
      throw executorError("INVALID_EXECUTOR_CONFIG", "工作区测试配置无效");
    }
    const required = profileIds.map((profileId) => {
      const profile = profiles.get(profileId);
      if (!profile) {
        throw executorError("INVALID_EXECUTOR_CONFIG", "工作区测试配置无效");
      }
      return { ...profile };
    });
    byWorkspace.set(workspaceId, required);
  }
  return byWorkspace;
}

export function attemptExecutionId(sessionId, number) {
  const digest = digestValue({ number, sessionId }).slice(0, 24);
  return `attempt-${digest}`;
}

function currentAttempt(session) {
  return session.attempts.at(-1);
}

function appendEvent(session, type, at, actionId = null) {
  const sequence = Number.isSafeInteger(session.nextSequence)
    ? session.nextSequence
    : session.events.length + 1;
  session.events.push({
    sequence,
    type,
    at,
    attemptNumber: currentAttempt(session).number,
    ...(actionId ? { actionId } : {}),
  });
  session.nextSequence = sequence + 1;
}

function touchSession(session, at) {
  session.revision = Number.isSafeInteger(session.revision)
    ? session.revision + 1
    : 1;
  session.updatedAt = at;
}

function sameCleanupFence(current, expected) {
  return Boolean(
    current &&
      current.executionId === expected.executionId &&
      current.actionId === expected.actionId,
  );
}

function sameCancellationRequest(cancellation, request) {
  const sameExpectedAction =
    cancellation?.expectedAction === null && request.expectedAction === null
      ? true
      : cancellation?.expectedAction !== null &&
        request.expectedAction !== null &&
        cancellation?.expectedAction.actionId === request.expectedAction.actionId &&
        cancellation.expectedAction.actionDigest ===
          request.expectedAction.actionDigest;
  return Boolean(
    cancellation &&
      cancellation.digest === request.cancellationDigest &&
      cancellation.expectedWorkspaceRevision ===
        request.expectedWorkspaceRevision &&
      sameExpectedAction,
  );
}

function cancellationActionResolution(session) {
  const expected = session.cancellation.expectedAction;
  if (expected === null) return null;
  const action = session.actions.find(({ id }) => id === expected.actionId);
  if (!action) {
    return {
      actionId: expected.actionId,
      actionDigest: expected.actionDigest,
      disposition: "absent",
      workspaceRevisionBefore: session.cancellation.expectedWorkspaceRevision,
      workspaceRevisionAfter: null,
    };
  }
  const dispositions = {
    succeeded: "audited_succeeded",
    failed: "audited_failed",
    interrupted: "discarded_unknown",
  };
  return {
    actionId: action.id,
    actionDigest: action.requestDigest,
    disposition: dispositions[action.status],
    workspaceRevisionBefore: action.workspaceRevisionBefore,
    workspaceRevisionAfter: action.workspaceRevisionAfter,
  };
}

function projectCancellationProof(session) {
  const proof = {
    schemaVersion: 1,
    kind: "controlled_execution_cancelled",
    sessionId: session.id,
    cancellationDigest: session.cancellation.digest,
    sourceRevision: session.sourceRevision,
    trustedWorkspaceRevision: session.workspaceRevision,
    actionResolution: cancellationActionResolution(session),
    sandboxCleanupConfirmed: session.cleanupFence === null,
    discardedAttempts: session.attempts.map((attempt) => ({
      attemptNumber: attempt.number,
      executionId: attempt.executionId,
      disposition: "discarded",
    })),
    settledAt: session.cancellation.settledAt,
  };
  return { ...proof, proofDigest: digestValue(proof) };
}

function projectAbsentCancellationProof(request, settledAt) {
  const proof = {
    schemaVersion: 1,
    kind: "controlled_execution_absent",
    sessionId: request.sessionId,
    cancellationDigest: request.cancellationDigest,
    sourceRevision: null,
    trustedWorkspaceRevision: null,
    actionResolution: null,
    sandboxCleanupConfirmed: true,
    discardedAttempts: [],
    settledAt,
  };
  return { ...proof, proofDigest: digestValue(proof) };
}

function safeRecordedError(error, fallbackCode = "ACTION_FAILED") {
  const trustedError =
    error instanceof ControlledCodeExecutorError ||
    error instanceof CodeExecutionError ||
    error instanceof DockerSandboxError ||
    error instanceof WindowsTestRunnerError ||
    error instanceof CodeExecutionJournalError;
  const code =
    trustedError &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : fallbackCode;
  const recorded = {
    code,
    message: trustedError ? String(error.message) : "受控操作失败",
  };
  const details = {};
  for (const key of [
    "exitCode",
    "signal",
    "durationMs",
    "truncated",
    "cleanupPending",
    "containerName",
  ]) {
    const value = trustedError ? error?.details?.[key] : undefined;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      Number.isFinite(value) ||
      value === null
    ) {
      details[key] = value;
    }
  }
  if (Object.keys(details).length) recorded.details = details;
  if (error instanceof WindowsTestRunnerError && error.code === "SANDBOX_ABORTED" &&
      error.details?.origin === "windows_fixed_prelaunch" && error.details.notExecuted === true && error.details.cleanupPending === false &&
      Object.keys(error.details).length === 3) {
    recorded.details = { ...details, origin: "windows_fixed_prelaunch", notExecuted: true };
  }
  return recorded;
}

function publicArtifact(ref) {
  if (!ref) return null;
  return { sha256: ref.sha256, bytes: ref.bytes };
}

function projectRecordedError(error) {
  if (!error) return null;
  const projected = { code: error.code, message: error.message };
  if (error.details) {
    projected.details = Object.fromEntries(
      Object.entries(error.details).filter(([key]) => ERROR_DETAIL_KEYS.has(key)),
    );
  }
  return projected;
}

function projectEvent(event) {
  return {
    sequence: event.sequence,
    type: event.type,
    at: event.at,
    attemptNumber: event.attemptNumber,
    ...(event.actionId ? { actionId: event.actionId } : {}),
  };
}

function validateSandboxResult(value, expectedProfileFingerprint) {
  if (
    !isPlainRecord(value) ||
    !Number.isSafeInteger(value.exitCode) ||
    !(
      value.signal === null ||
      (typeof value.signal === "string" && value.signal.length <= 64)
    ) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !isExecutionIdentityProof(value) ||
    typeof value.profileFingerprint !== "string" ||
    !SHA256.test(value.profileFingerprint) ||
    typeof value.timedOut !== "boolean"
  ) {
    throw executorError("SANDBOX_RESULT_INVALID", "沙箱返回结果无效");
  }
  if (value.profileFingerprint !== expectedProfileFingerprint) {
    throw executorError(
      "SANDBOX_PROFILE_MISMATCH",
      "沙箱执行的测试配置与可信配置不一致",
    );
  }
  return value;
}

function nodeTestSummary(stdout) {
  const lines = stdout.split(/\r?\n/u);
  if (lines[0] !== "TAP version 13") return null;
  const plans = lines.flatMap((line, index) =>
    /^1\.\.(\d+)$/u.test(line) ? [index] : [],
  );
  if (plans.length !== 1) return null;
  const planIndex = plans[0];
  const rootPlan = Number(lines[planIndex].slice(3));
  if (!Number.isSafeInteger(rootPlan)) return null;
  const counts = {};
  const labels = {
    tests: "total",
    pass: "passed",
    fail: "failed",
    cancelled: "cancelled",
    skipped: "skipped",
    todo: "todo",
  };
  for (const line of lines.slice(planIndex + 1)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (!match) continue;
    const name = labels[match[1]];
    const count = Number(match[2]);
    if (Object.hasOwn(counts, name) || !Number.isSafeInteger(count)) return null;
    counts[name] = count;
  }
  if (
    Object.keys(counts).length !== 6 ||
    counts.total < rootPlan ||
    counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo !== counts.total
  ) {
    return null;
  }
  return { ...counts, executed: counts.passed + counts.failed };
}

function isNodeTestSummary(value) {
  return hasExactKeys(value, [
    "total", "passed", "failed", "cancelled", "skipped", "todo", "executed",
  ]) &&
    ["total", "passed", "failed", "cancelled", "skipped", "todo", "executed"]
      .every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.executed === value.passed + value.failed &&
    value.total === value.executed + value.cancelled + value.skipped + value.todo;
}

function validateExecutionCreation(
  value,
  reference,
) {
  const { workspaceId, executionId, inputBinding } = reference;
  const expectsExecutionSource = Object.hasOwn(reference, "executionSource");
  const echoesBinding =
    isPlainRecord(value) && Object.hasOwn(value, "inputBinding");
  const echoesExecutionSource =
    isPlainRecord(value) && Object.hasOwn(value, "executionSource");
  const expectedKeys = [
    "workspaceId",
    "executionId",
    "sourceRevision",
    "workspaceRevision",
    ...(echoesBinding ? ["inputBinding"] : []),
    ...(echoesExecutionSource ? ["executionSource"] : []),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.workspaceId !== workspaceId ||
    value.executionId !== executionId ||
    !isRevision(value.sourceRevision) ||
    !isRevision(value.workspaceRevision) ||
    value.sourceRevision !== value.workspaceRevision ||
    (inputBinding === null
      ? echoesBinding && value.inputBinding !== null
      : !echoesBinding || !sameInputBinding(value.inputBinding, inputBinding)) ||
    (expectsExecutionSource !== echoesExecutionSource) ||
    (expectsExecutionSource &&
      !sameExecutionSource(
        value.executionSource,
        reference.executionSource,
      ))
  ) {
    throw executorError(
      "EXECUTION_RESULT_INVALID",
      "工作区 Broker 返回了无效的副本信息",
    );
  }
  return value;
}

function validateWriteResult(value, action) {
  if (
    !hasExactKeys(value, [
      "path",
      "sha256",
      "bytes",
      "beforeWorkspaceRevision",
      "workspaceRevision",
    ]) ||
    !isManifestPath(value.path) ||
    !isRevision(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.beforeWorkspaceRevision !== action.expectedWorkspaceRevision ||
    !isRevision(value.workspaceRevision)
  ) {
    throw executorError(
      "EXECUTION_RESULT_INVALID",
      "工作区 Broker 返回了无效的写入结果",
    );
  }
  return value;
}

function isManifestPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validateManifestEntry(entry, keys) {
  return (
    hasExactKeys(entry, keys) &&
    isManifestPath(entry.path) &&
    keys
      .filter((key) => key !== "path")
      .every((key) => typeof entry[key] === "string" && SHA256.test(entry[key]))
  );
}

function validateChangeManifest(value) {
  if (
    !hasExactKeys(value, ["created", "modified", "deleted"]) ||
    !Array.isArray(value.created) ||
    !Array.isArray(value.modified) ||
    !Array.isArray(value.deleted) ||
    !value.created.every((entry) =>
      validateManifestEntry(entry, ["path", "sha256"]),
    ) ||
    !value.modified.every((entry) =>
      validateManifestEntry(entry, [
        "path",
        "beforeSha256",
        "afterSha256",
      ]),
    ) ||
    !value.deleted.every((entry) =>
      validateManifestEntry(entry, ["path", "sha256"]),
    )
  ) {
    throw executorError("EXECUTION_RESULT_INVALID", "代码变更清单无效");
  }
  return value;
}

function validateFileList(value) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !isManifestPath(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw executorError("EXECUTION_RESULT_INVALID", "工作区文件列表无效");
  }
  return value;
}

function validateReadResult(value) {
  if (
    !hasExactKeys(value, ["path", "content", "sha256", "bytes"]) ||
    !isManifestPath(value.path) ||
    typeof value.content !== "string" ||
    !isRevision(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    Buffer.byteLength(value.content, "utf8") !== value.bytes
  ) {
    throw executorError("EXECUTION_RESULT_INVALID", "工作区文件读取结果无效");
  }
  return value;
}

function validateSearchResult(value) {
  if (
    !hasExactKeys(value, ["matches", "truncated"]) ||
    !Array.isArray(value.matches) ||
    typeof value.truncated !== "boolean" ||
    value.matches.some(
      (match) =>
        !hasExactKeys(match, ["path", "line", "column", "text"]) ||
        !isManifestPath(match.path) ||
        !Number.isSafeInteger(match.line) ||
        match.line < 1 ||
        !Number.isSafeInteger(match.column) ||
        match.column < 1 ||
        typeof match.text !== "string",
    )
  ) {
    throw executorError("EXECUTION_RESULT_INVALID", "工作区搜索结果无效");
  }
  return value;
}

function validateSandboxProofArtifact(value, expectedFingerprint) {
  if (
    !hasExactKeys(value, [
      "exitCode",
      "signal",
      "durationMs",
      ...executionIdentityKeys(value),
      ...(Object.hasOwn(value || {}, "runtimeIdentity") ? ["workspaceRevision"] : []),
      "profileFingerprint",
      "timedOut",
      ...(Object.hasOwn(value || {}, "testSummary") ? ["testSummary"] : []),
    ]) ||
    value.exitCode !== 0 ||
    !(
      value.signal === null ||
      (typeof value.signal === "string" && value.signal.length <= 64)
    ) ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !isExecutionIdentityProof(value) ||
    (Object.hasOwn(value || {}, "runtimeIdentity") && !isRevision(value.workspaceRevision)) ||
    value.profileFingerprint !== expectedFingerprint ||
    value.timedOut !== false ||
    (Object.hasOwn(value, "testSummary") && !isNodeTestSummary(value.testSummary))
  ) {
    throw executorError("EXECUTOR_STATE_INVALID", "测试证明审计产物无效");
  }
  return value;
}

function invalidPersistedActionResult() {
  throw executorError("EXECUTION_RESULT_INVALID", "动作审计结果无效");
}

function assertArtifactKinds(action, expectedKinds) {
  const actualKinds = Object.keys(action.outputArtifacts).sort();
  const expected = [...expectedKinds].sort();
  if (
    actualKinds.length !== expected.length ||
    expected.some((kind, index) => kind !== actualKinds[index])
  ) {
    invalidPersistedActionResult();
  }
}

function recordedErrorsMatch(left, right) {
  return (
    isRecordedError(left, { nullable: false }) &&
    isRecordedError(right, { nullable: false }) &&
    digestValue(left) === digestValue(right)
  );
}

function profileFingerprintForInput(session, input) {
  const profile = session.requiredProfiles.find(
    (candidate) => candidate.id === input.profileId,
  );
  if (!profile) invalidPersistedActionResult();
  return profile.configDigest;
}

function validateGenericFailureResult(action, result, { streams = false } = {}) {
  if (streams) {
    const artifactKinds = Object.keys(action.outputArtifacts);
    if (
      !artifactKinds.includes("output") ||
      artifactKinds.some(
        (kind) => !["output", "stdout", "stderr"].includes(kind),
      ) ||
      !hasExactKeys(result, ["error", "stdout", "stderr"]) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      invalidPersistedActionResult();
    }
  } else {
    assertArtifactKinds(action, ["output"]);
    if (!hasExactKeys(result, ["error"])) invalidPersistedActionResult();
  }
  if (!recordedErrorsMatch(result.error, action.error)) {
    invalidPersistedActionResult();
  }
  return result;
}

function validateSucceededActionResult(session, action, input, result) {
  if (action.type === "list_files") {
    assertArtifactKinds(action, ["output"]);
    return validateFileList(result);
  }
  if (action.type === "read_text") {
    assertArtifactKinds(action, ["output"]);
    return validateReadResult(result);
  }
  if (action.type === "search_text") {
    assertArtifactKinds(action, ["output"]);
    return validateSearchResult(result);
  }
  if (action.type === "write_text") {
    assertArtifactKinds(action, ["output"]);
    if (!hasExactKeys(result, ["path", "sha256", "bytes"])) {
      invalidPersistedActionResult();
    }
    validateWriteResult(
      {
        ...result,
        beforeWorkspaceRevision: action.workspaceRevisionBefore,
        workspaceRevision: action.workspaceRevisionAfter,
      },
      { expectedWorkspaceRevision: action.workspaceRevisionBefore },
    );
    return result;
  }
  if (action.type === "run_profile") {
    assertArtifactKinds(action, ["output", "stdout", "stderr"]);
    if (
      !hasExactKeys(result, [
        "exitCode",
        "signal",
        "durationMs",
        ...executionIdentityKeys(result),
        ...(Object.hasOwn(result || {}, "runtimeIdentity") ? ["workspaceRevision"] : []),
        "profileFingerprint",
        "timedOut",
        "stdout",
        "stderr",
        ...(Object.hasOwn(result || {}, "testSummary") ? ["testSummary"] : []),
      ]) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      (Object.hasOwn(result, "testSummary") &&
        digestValue(result.testSummary) !== digestValue(nodeTestSummary(result.stdout)))
    ) {
      invalidPersistedActionResult();
    }
    const { stdout: _stdout, stderr: _stderr, ...proof } = result;
    validateSandboxProofArtifact(
      proof,
      profileFingerprintForInput(session, input),
    );
    return result;
  }
  if (action.type === "complete") {
    assertArtifactKinds(action, ["manifest"]);
    return validateChangeManifest(result);
  }
  invalidPersistedActionResult();
}

function validateFailedActionResult(session, action, input, result) {
  if (
    action.type === "run_profile" &&
    hasExactKeys(result, [
      "exitCode",
      "signal",
      "durationMs",
      ...executionIdentityKeys(result),
      ...(Object.hasOwn(result || {}, "runtimeIdentity") ? ["workspaceRevision"] : []),
      "profileFingerprint",
      "timedOut",
      "error",
      "stdout",
      "stderr",
      ...(Object.hasOwn(result || {}, "testSummary") ? ["testSummary"] : []),
    ])
  ) {
    assertArtifactKinds(action, ["output", "stdout", "stderr"]);
    if (
      !recordedErrorsMatch(result.error, action.error) ||
      (Object.hasOwn(result, "testSummary") &&
        digestValue(result.testSummary) !== digestValue(nodeTestSummary(result.stdout)))
    ) {
      invalidPersistedActionResult();
    }
    validateSandboxResult(
      result,
      profileFingerprintForInput(session, input),
    );
    return result;
  }
  return validateGenericFailureResult(action, result, {
    streams: action.type === "run_profile",
  });
}

function validatePersistedActionResult(session, action, input, result) {
  if (action.status === "succeeded") {
    return validateSucceededActionResult(session, action, input, result);
  }
  if (action.status === "failed") {
    return validateFailedActionResult(session, action, input, result);
  }
  if (action.status === "interrupted") {
    if (Object.keys(action.outputArtifacts).length === 0) {
      if (
        !hasExactKeys(result, ["error"]) ||
        !recordedErrorsMatch(result.error, action.error)
      ) {
        invalidPersistedActionResult();
      }
      return result;
    }
    return validateGenericFailureResult(action, result, {
      streams: action.type === "run_profile",
    });
  }
  invalidPersistedActionResult();
}

function projectAction(action) {
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    attemptNumber: action.attemptNumber,
    workspaceRevisionBefore: action.workspaceRevisionBefore,
    workspaceRevisionAfter: action.workspaceRevisionAfter,
    inputArtifact: publicArtifact(action.inputArtifact),
    outputArtifacts: Object.fromEntries(
      Object.entries(action.outputArtifacts || {}).map(([kind, ref]) => [
        kind,
        publicArtifact(ref),
      ]),
    ),
    startedAt: action.startedAt,
    finishedAt: action.finishedAt,
    error: projectRecordedError(action.error),
  };
}

function projectSession(session) {
  const attempt = currentAttempt(session);
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    requestedBy: {
      roleId: session.requestedBy.roleId,
      workItemId: session.requestedBy.workItemId,
    },
    inputBinding: structuredClone(session.inputBinding),
    ...(Object.hasOwn(session, "executionSource")
      ? { executionSource: structuredClone(session.executionSource) }
      : {}),
    status: session.status,
    revision: session.revision,
    sourceRevision: session.sourceRevision,
    workspaceRevision: session.workspaceRevision,
    requiredProfiles: session.requiredProfiles.map((profile) => profile.id),
    attempt: { number: attempt.number, status: attempt.status },
    cleanupPending: Boolean(session.cleanupFence),
    actions: session.actions.map(projectAction),
    events: session.events.map(projectEvent),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    error: projectRecordedError(session.error),
  };
}

export class ControlledCodeExecutor {
  constructor({
    broker,
    sandbox,
    store,
    journal,
    profileDefinitions = {},
    requiredProfilesByWorkspace = {},
    stateKey = "code-executor-state",
    stateQueue = new OperationQueue(),
    clock = () => new Date().toISOString(),
    limits = {},
  }) {
    this.broker = validateDependency(
      broker,
      [
        "createExecution",
        "listFiles",
        "readFile",
        "searchText",
        "writeFile",
        "getWorkspaceRevision",
        "sealExecution",
        "withLockedExecution",
        "discardExecution",
      ],
      "工作区 Broker",
    );
    this.sandbox = validateDependency(sandbox, ["run", "cleanup"], "沙箱");
    this.store = validateDependency(store, ["read", "write"], "状态存储");
    this.journal = validateDependency(
      journal,
      ["writeJson", "readJson"],
      "审计存储",
    );
    if (typeof stateKey !== "string" || !SAFE_ID.test(stateKey)) {
      throw executorError("INVALID_EXECUTOR_CONFIG", "状态键无效");
    }
    if (!stateQueue || typeof stateQueue.enqueue !== "function") {
      throw executorError("INVALID_EXECUTOR_CONFIG", "状态队列无效");
    }
    if (typeof clock !== "function") {
      throw executorError("INVALID_EXECUTOR_CONFIG", "时钟无效");
    }
    this.requiredProfiles = normalizeProfileConfiguration(
      profileDefinitions,
      requiredProfilesByWorkspace,
    );
    this.profileKinds = new Map(
      Object.entries(profileDefinitions).map(([id, definition]) => [id, definition.kind]),
    );
    this.profileDefinitions = structuredClone(profileDefinitions);
    validateDependency(
      sandbox,
      ["getProfileFingerprint"],
      "沙箱测试指纹",
    );
    for (const requiredProfiles of this.requiredProfiles.values()) {
      for (const profile of requiredProfiles) {
        if (sandbox.getProfileFingerprint(profile.id) !== profile.configDigest) {
          throw executorError(
            "INVALID_EXECUTOR_CONFIG",
            "执行器测试配置与沙箱配置不一致",
          );
        }
      }
    }
    this.stateKey = stateKey;
    this.stateQueue = stateQueue;
    this.clock = clock;
    this.limits = normalizeLimits(limits);
    this.sessionQueues = new Map();
    this.inFlightActions = new Map();
    this.runtimeFences = new Set();
    this.ready = false;
    this.recovery = null;
  }

  async recover() {
    if (this.ready) return { recovered: false, alreadyReady: true };
    if (this.recovery) return this.recovery;
    this.ready = false;
    const recovery = this.#recover()
      .then((result) => {
        this.runtimeFences.clear();
        this.ready = true;
        return result;
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null;
      });
    this.recovery = recovery;
    return recovery;
  }

  start(request, options = {}) {
    let normalized;
    let runtime;
    try {
      normalized = normalizeStartRequest(request);
      runtime = normalizeRuntimeOptions(options);
      this.#assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#queueForSession(normalized.sessionId).enqueue(() =>
      withPreparationCancellation(runtime.signal, () => this.#start(normalized)),
    );
  }

  perform(request, options = {}) {
    let normalized;
    let runtime;
    try {
      normalized = normalizeActionRequest(request);
      runtime = normalizeRuntimeOptions(options);
      this.#assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    const digest = digestValue(normalized.action);
    const key = `${normalized.sessionId}:${normalized.action.actionId}`;
    const existing = this.inFlightActions.get(key);
    if (existing) {
      return existing.digest === digest
        ? existing.promise
        : Promise.reject(
            executorError(
              "IDEMPOTENCY_CONFLICT",
              "actionId 已用于不同的受控操作",
            ),
          );
    }
    const operation = this.#queueForSession(normalized.sessionId).enqueue(() =>
      this.#perform(normalized, runtime.signal, digest),
    );
    const tracked = operation.finally(() => {
      if (this.inFlightActions.get(key)?.promise === tracked) {
        this.inFlightActions.delete(key);
      }
    });
    this.inFlightActions.set(key, { digest, promise: tracked });
    return tracked;
  }

  async view(request) {
    const { sessionId } = normalizeViewRequest(request);
    this.#assertReady();
    return this.#readProjectedSession(sessionId);
  }

  async getActionResult(request) {
    const { sessionId, actionId } = normalizeActionResultRequest(request);
    this.#assertReady();
    const snapshot = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, sessionId);
      const action = session.actions.find((entry) => entry.id === actionId);
      if (!action) {
        throw executorError("ACTION_NOT_FOUND", "代码执行动作不存在");
      }
      if (!["succeeded", "failed"].includes(action.status)) {
        throw executorError(
          "EXECUTOR_ACTION_NOT_TERMINAL",
          "代码执行动作尚无可确认结果",
        );
      }
      return {
        session: structuredClone(session),
        action: structuredClone(action),
      };
    });
    try {
      const result = await this.#readValidatedActionResult(
        snapshot.session,
        snapshot.action,
      );
      return structuredClone({
        action: projectAction(snapshot.action),
        result,
      });
    } catch {
      this.runtimeFences.add(sessionId);
      throw executorError("EXECUTION_FENCED", "审计产物完整性校验失败");
    }
  }

  exportCompletedChangeSet(value) {
    let request;
    try {
      request = normalizeCompletedChangeExportRequest(value);
      this.#assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#queueForSession(request.sessionId).enqueue(() =>
      this.#exportCompletedChangeSet(request),
    );
  }

  async #exportCompletedChangeSet(request) {
    this.#assertRuntimeAvailable(request.sessionId);
    const session = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return structuredClone(this.#requireSession(state, request.sessionId));
    });
    if (session.status !== "completed") {
      throw executorError(
        "EXECUTOR_SESSION_NOT_COMPLETED",
        "代码执行会话尚未完成",
      );
    }
    const completedAction = session.actions.at(-1);
    if (
      completedAction?.id !== request.completedActionId ||
      completedAction.type !== "complete" ||
      completedAction.status !== "succeeded" ||
      completedAction.workspaceRevisionAfter !==
        request.expectedWorkspaceRevision ||
      session.workspaceRevision !== request.expectedWorkspaceRevision
    ) {
      throw executorError(
        "EXECUTION_BINDING_MISMATCH",
        "完成会话与 change package 导出请求不匹配",
      );
    }
    try {
      return await this.#buildCompletedChangeSet(session, completedAction);
    } catch {
      this.runtimeFences.add(request.sessionId);
      throw executorError(
        "EXECUTION_FENCED",
        "完成会话无法通过 change package 审计",
      );
    }
  }

  async reconcileAction(request) {
    const normalized = normalizeActionRequest(request);
    this.#assertReady();
    this.#assertRuntimeAvailable(normalized.sessionId);
    const requestDigest = digestValue(normalized.action);
    const snapshot = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, normalized.sessionId);
      const action = session.actions.find(
        (entry) => entry.id === normalized.action.actionId,
      );
      if (!action) {
        return {
          status: "absent",
          session: projectSession(session),
        };
      }
      if (action.requestDigest !== requestDigest) {
        throw executorError(
          "IDEMPOTENCY_CONFLICT",
          "actionId 已用于不同的受控操作",
        );
      }
      return {
        status: action.status === "running" ? "running" : "terminal",
        session: structuredClone(session),
        action: structuredClone(action),
      };
    });
    if (snapshot.status === "absent") return snapshot;
    try {
      const auditedInput = await this.#readAuditedActionInput(
        normalized.sessionId,
        snapshot.action,
      );
      if (digestValue(auditedInput) !== requestDigest) {
        throw executorError(
          "EXECUTION_AUDIT_INVALID",
          "动作输入审计产物与对账请求不匹配",
        );
      }
      if (snapshot.status === "running") {
        return {
          status: "running",
          session: projectSession(snapshot.session),
          action: projectAction(snapshot.action),
        };
      }
      const result = ["succeeded", "failed"].includes(snapshot.action.status)
        ? await this.#readValidatedActionResult(
            snapshot.session,
            snapshot.action,
          )
        : { error: snapshot.action.error };
      return structuredClone({
        status: "terminal",
        session: projectSession(snapshot.session),
        action: projectAction(snapshot.action),
        result,
      });
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_CONFLICT") throw error;
      this.runtimeFences.add(normalized.sessionId);
      throw executorError("EXECUTION_FENCED", "审计产物完整性校验失败");
    }
  }

  async list() {
    this.#assertReady();
    return this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return Object.values(state.sessions)
        .map(projectSession)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }

  resume(request, options = {}) {
    let normalized;
    let runtime;
    try {
      normalized = normalizeResumeRequest(request);
      runtime = normalizeRuntimeOptions(options);
      this.#assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#queueForSession(normalized.sessionId).enqueue(() =>
      withPreparationCancellation(runtime.signal, () => this.#resume(normalized)),
    );
  }

  reconcileCancellation(value) {
    let request;
    try {
      request = normalizeCancellationRequest(value);
      this.#assertReady();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#queueForSession(request.sessionId).enqueue(() =>
      this.#reconcileCancellation(request),
    );
  }

  #assertReady() {
    if (!this.ready) {
      throw executorError(
        "EXECUTOR_NOT_READY",
        "代码执行器完成恢复前不可接收工作",
      );
    }
  }

  #assertRuntimeAvailable(sessionId) {
    if (this.runtimeFences.has(sessionId)) {
      throw executorError(
        "EXECUTION_FENCED",
        "执行结果不确定，必须恢复后才能继续",
      );
    }
  }

  #queueForSession(sessionId) {
    let queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      queue = new OperationQueue();
      this.sessionQueues.set(sessionId, queue);
    }
    return queue;
  }

  #now() {
    const value = this.clock();
    if (!isTimestamp(value)) {
      throw executorError("INVALID_EXECUTOR_CONFIG", "时钟返回值无效");
    }
    return value;
  }

  async #readState({ persistLegacyUpgrade = false } = {}) {
    let stored;
    try {
      stored = await this.store.read(this.stateKey, MISSING_STATE);
    } catch {
      throw executorError("STATE_READ_FAILED", "无法读取代码执行状态");
    }
    if (stored === MISSING_STATE) return emptyState();
    const legacy = isPlainRecord(stored) &&
      [LEGACY_SCHEMA_VERSION, 2].includes(stored.schemaVersion);
    const state = validateState(upgradeLegacyState(stored));
    if (legacy && persistLegacyUpgrade) await this.#writeState(state);
    return state;
  }

  async #writeState(state) {
    state.revision += 1;
    try {
      await this.store.write(this.stateKey, state);
    } catch {
      state.revision -= 1;
      throw executorError("STATE_WRITE_FAILED", "无法保存代码执行状态");
    }
  }

  #mutateState(mutator) {
    return this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const outcome = mutator(state) || {};
      if (outcome.changed !== false) await this.#writeState(state);
      return outcome.value;
    });
  }

  #requireSession(state, sessionId) {
    if (!Object.hasOwn(state.sessions, sessionId)) {
      throw executorError("SESSION_NOT_FOUND", "代码执行会话不存在");
    }
    return state.sessions[sessionId];
  }

  async #readProjectedSession(sessionId) {
    return this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return projectSession(this.#requireSession(state, sessionId));
    });
  }

  async #start(request) {
    this.#assertRuntimeAvailable(request.sessionId);
    const requiredProfiles = this.requiredProfiles.get(request.workspaceId);
    if (!requiredProfiles) {
      throw executorError(
        "WORKSPACE_NOT_CONFIGURED",
        "工作区未配置可信测试方案",
      );
    }
    const requestDigest = sessionRequestDigest({
      workspaceId: request.workspaceId,
      requestedBy: request.requestedBy,
      inputBinding: request.inputBinding,
      ...(Object.hasOwn(request, "executionSource")
        ? { executionSource: request.executionSource }
        : {}),
      requiredProfiles,
    });
    const claimed = await this.#mutateState((state) => {
      const existing = Object.hasOwn(state.sessions, request.sessionId)
        ? state.sessions[request.sessionId]
        : null;
      if (existing !== null) {
        if (existing.requestDigest !== requestDigest) {
          throw executorError(
            "IDEMPOTENCY_CONFLICT",
            "sessionId 已用于不同的代码执行请求",
          );
        }
        return { changed: false, value: { existing: true } };
      }
      const occupied = Object.values(state.sessions).filter(session =>
        !["completed", "failed", "cancelled"].includes(session.status) || session.cleanupFence !== null);
      if (occupied.length >= this.limits.maxSessions) {
        throw executorError("SESSION_LIMIT", "代码执行会话数量已达上限");
      }
      const at = this.#now();
      const executionId = attemptExecutionId(request.sessionId, 1);
      const session = {
        id: request.sessionId,
        workspaceId: request.workspaceId,
        requestedBy: request.requestedBy,
        inputBinding: structuredClone(request.inputBinding),
        ...(Object.hasOwn(request, "executionSource")
          ? { executionSource: structuredClone(request.executionSource) }
          : {}),
        requestDigest,
        status: "preparing",
        revision: 0,
        sourceRevision: null,
        workspaceRevision: null,
        requiredProfiles: requiredProfiles.map((profile) => ({ ...profile })),
        verifiedProfiles: {},
        actions: [],
        attempts: [
          {
            number: 1,
            executionId,
            status: "preparing",
            startedAt: at,
            finishedAt: null,
            replays: [],
          },
        ],
        events: [],
        nextSequence: 1,
        cleanupFence: null,
        cancellation: null,
        createdAt: at,
        updatedAt: at,
        completedAt: null,
        error: null,
      };
      appendEvent(session, "session_preparing", at);
      touchSession(session, at);
      state.sessions[session.id] = session;
      return {
        value: { existing: false, executionId },
      };
    });
    if (claimed.existing) return this.#readProjectedSession(request.sessionId);

    let created;
    try {
      const reference = {
        workspaceId: request.workspaceId,
        executionId: claimed.executionId,
        inputBinding: structuredClone(request.inputBinding),
        ...(Object.hasOwn(request, "executionSource")
          ? { executionSource: structuredClone(request.executionSource) }
          : {}),
      };
      created = validateExecutionCreation(
        await this.broker.createExecution(reference),
        reference,
      );
      throwIfPreparationAborted();
    } catch (error) {
      if (isPreparationAbort(error)) return this.#abortPreparation(request.sessionId, claimed.executionId, error);
      await this.#discardWorkspaceAttempt({
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        executionId: claimed.executionId,
        message: "启动失败后的隔离工作区清理尚未确认",
      });
      try {
        await this.#markSessionFailed(request.sessionId, error, "START_FAILED", {
          executionId: claimed.executionId,
          statuses: ["preparing"],
        });
      } catch (stateError) {
        this.runtimeFences.add(request.sessionId);
        throw stateError;
      }
      throw executorError("START_FAILED", "无法创建受控代码副本");
    }
    try {
      await this.#mutateState((state) => {
        throwIfPreparationAborted();
        const session = this.#requireSession(state, request.sessionId);
        const attempt = currentAttempt(session);
        if (
          session.status !== "preparing" ||
          attempt.executionId !== claimed.executionId ||
          attempt.status !== "preparing"
        ) {
          throw executorError(
            "EXECUTION_FENCED",
            "执行生命周期已变化，旧启动结果不能提交",
          );
        }
        const at = this.#now();
        session.sourceRevision = created.sourceRevision;
        session.workspaceRevision = created.workspaceRevision;
        session.status = "active";
        attempt.status = "active";
        appendEvent(session, "session_active", at);
        touchSession(session, at);
        return {};
      });
    } catch (error) {
      if (isPreparationAbort(error)) return this.#abortPreparation(request.sessionId, claimed.executionId, error);
      this.runtimeFences.add(request.sessionId);
      await this.#discardWorkspaceAttempt({
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        executionId: claimed.executionId,
        message: "未确认启动结果的隔离工作区清理尚未确认",
      });
      throw error;
    }
    return this.#readProjectedSession(request.sessionId);
  }

  async #abortPreparation(sessionId, executionId, error) {
    return withoutPreparationCancellation(async () => {
      await this.#discardWorkspaceAttempt({ sessionId,
        workspaceId: (await this.#readProjectedSession(sessionId)).workspaceId, executionId,
        message: "中断准备后的隔离工作区清理尚未确认" });
      try {
        await this.#mutateState(state => {
          const session = this.#requireSession(state, sessionId), attempt = currentAttempt(session);
          if (attempt.executionId !== executionId || !["preparing", "replaying"].includes(session.status)) {
            throw executorError("EXECUTION_FENCED", "准备生命周期已变化，中断结果不能提交");
          }
          const at = this.#now();
          session.status = "interrupted";
          attempt.status = "interrupted";
          attempt.finishedAt = at;
          for (const replay of attempt.replays) if (replay.status === "running") {
            replay.status = "interrupted"; replay.finishedAt = at;
            replay.error = { code: "RESULT_UNKNOWN", message: "准备中断，恢复副本已清理" };
            appendEvent(session, "replay_interrupted", at, replay.sourceActionId);
          }
          appendEvent(session, "session_interrupted", at);
          touchSession(session, at);
          return {};
        });
      } catch (stateError) { this.runtimeFences.add(sessionId); throw stateError; }
      throw error;
    });
  }

  async #markSessionFailed(
    sessionId,
    error,
    fallbackCode,
    { executionId = null, statuses = null } = {},
  ) {
    await this.#mutateState((state) => {
      const session = this.#requireSession(state, sessionId);
      const attempt = currentAttempt(session);
      if (
        (executionId !== null && attempt.executionId !== executionId) ||
        (statuses !== null && !statuses.includes(session.status))
      ) {
        throw executorError(
          "EXECUTION_FENCED",
          "执行生命周期已变化，旧失败结果不能提交",
        );
      }
      const at = this.#now();
      session.status = "failed";
      session.error = safeRecordedError(error, fallbackCode);
      attempt.status = "failed";
      attempt.finishedAt = at;
      for (const replay of attempt.replays) {
        if (replay.status !== "running") continue;
        replay.status = "failed";
        replay.finishedAt = at;
        replay.error = safeRecordedError(error, fallbackCode);
        appendEvent(session, "replay_failed", at, replay.sourceActionId);
      }
      appendEvent(session, "session_failed", at);
      touchSession(session, at);
      return {};
    });
  }

  async #discardWorkspaceAttempt({
    sessionId,
    workspaceId,
    executionId,
    message,
  }) {
    try {
      await withoutPreparationCancellation(() => this.broker.discardExecution({ workspaceId, executionId }));
    } catch {
      this.runtimeFences.add(sessionId);
      throw executorError("WORKSPACE_DISPOSAL_PENDING", message);
    }
  }

  #assertProfileConfiguration(session) {
    const configured = this.requiredProfiles.get(session.workspaceId);
    if (
      !configured ||
      digestValue(configured) !== digestValue(session.requiredProfiles)
    ) {
      throw executorError(
        "PROFILE_CONFIG_CHANGED",
        "可信测试配置已经变化，请创建新的代码执行会话",
      );
    }
  }

  #assertActionEligible(session, action) {
    if (session.cleanupFence) {
      throw executorError("CLEANUP_PENDING", "残留容器清理完成前不可继续");
    }
    if (session.status !== "active") {
      throw executorError("SESSION_NOT_ACTIVE", "代码执行会话当前不可执行动作");
    }
    if (session.actions.length >= this.limits.maxActionsPerSession) {
      throw executorError("ACTION_LIMIT", "代码执行动作数量已达上限");
    }
    if (action.expectedWorkspaceRevision !== session.workspaceRevision) {
      throw executorError(
        "WORKSPACE_REVISION_MISMATCH",
        "工作区版本已发生变化",
      );
    }
    if (action.type === "run_profile" || action.type === "complete") {
      this.#assertProfileConfiguration(session);
    }
    if (
      action.type === "run_profile" &&
      !session.requiredProfiles.some((profile) => profile.id === action.profileId)
    ) {
      throw executorError("PROFILE_NOT_ALLOWED", "测试方案未获授权");
    }
  }

  async #perform(request, signal, requestDigest) {
    const { sessionId, action } = request;
    this.#assertRuntimeAvailable(sessionId);
    const recorded = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, sessionId);
      const existing =
        session.actions.find((entry) => entry.id === action.actionId) || null;
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw executorError(
            "IDEMPOTENCY_CONFLICT",
            "actionId 已用于不同的受控操作",
          );
        }
        return existing;
      }
      this.#assertActionEligible(session, action);
      return null;
    });
    if (recorded) {
      return this.#actionResponse(sessionId, action.actionId);
    }
    let inputArtifact;
    try {
      inputArtifact = await this.journal.writeJson({
        sessionId,
        actionId: action.actionId,
        kind: "input",
        value: action,
      });
    } catch (error) {
      if (error?.code === "ARTIFACT_CONFLICT") {
        throw executorError(
          "IDEMPOTENCY_CONFLICT",
          "actionId 已存在不同的审计输入",
        );
      }
      throw error;
    }
    let claim;
    try {
      claim = await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        const existing = session.actions.find(
          (entry) => entry.id === action.actionId,
        );
        if (existing) {
          if (existing.requestDigest !== requestDigest) {
            throw executorError(
              "IDEMPOTENCY_CONFLICT",
              "actionId 已用于不同的受控操作",
            );
          }
          return { changed: false, value: { existing: true } };
        }
        this.#assertActionEligible(session, action);
        const at = this.#now();
        session.actions.push({
          id: action.actionId,
          type: action.type,
          requestDigest,
          status: "running",
          attemptNumber: currentAttempt(session).number,
          inputArtifact,
          outputArtifacts: {},
          workspaceRevisionBefore: session.workspaceRevision,
          workspaceRevisionAfter: null,
          startedAt: at,
          finishedAt: null,
          error: null,
        });
        session.status =
          action.type === "complete" ? "completing" : "running";
        currentAttempt(session).status = session.status;
        appendEvent(session, "action_running", at, action.actionId);
        touchSession(session, at);
        return {
          value: {
            existing: false,
            context: {
              sessionId: session.id,
              workspaceId: session.workspaceId,
              executionId: currentAttempt(session).executionId,
              attemptNumber: currentAttempt(session).number,
              workspaceRevision: session.workspaceRevision,
              requiredProfiles: structuredClone(session.requiredProfiles),
              verifiedProfiles: structuredClone(session.verifiedProfiles),
              actions: structuredClone(session.actions),
            },
          },
        };
      });
    } catch (error) {
      this.runtimeFences.add(sessionId);
      throw error;
    }
    if (claim.existing) return this.#actionResponse(sessionId, action.actionId);

    let outcome;
    try {
      outcome = await this.#executeAction(claim.context, action, signal);
    } catch (error) {
      return this.#finalizeActionFailure(sessionId, action, error);
    }

    let artifacts;
    try {
      artifacts = await this.#writeResultArtifacts(sessionId, action, outcome);
    } catch {
      this.runtimeFences.add(sessionId);
      throw executorError(
        "EXECUTION_FENCED",
        "动作已执行但审计产物未能持久化",
      );
    }
    try {
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        const storedAction = session.actions.find(
          (entry) => entry.id === action.actionId,
        );
        if (!storedAction || storedAction.status !== "running") {
          throw executorError("EXECUTOR_STATE_INVALID", "动作状态无效");
        }
        const at = this.#now();
        storedAction.status = outcome.succeeded ? "succeeded" : "failed";
        storedAction.outputArtifacts = artifacts;
        storedAction.workspaceRevisionAfter = outcome.workspaceRevision;
        storedAction.finishedAt = at;
        storedAction.error = outcome.error || null;
        session.workspaceRevision = outcome.workspaceRevision;
        if (action.type === "run_profile") {
          const profile = session.requiredProfiles.find(
            (candidate) => candidate.id === action.profileId,
          );
          session.verifiedProfiles[action.profileId] = {
            passed: outcome.succeeded,
            actionId: action.actionId,
            attemptNumber: storedAction.attemptNumber,
            workspaceRevision: outcome.workspaceRevision,
            configDigest: profile.configDigest,
            ...executionIdentityFields(outcome.profileResult),
          };
        }
        if (action.type === "complete" && outcome.succeeded) {
          session.status = "completed";
          session.completedAt = at;
          currentAttempt(session).status = "completed";
          currentAttempt(session).finishedAt = at;
        } else {
          session.status = "active";
          currentAttempt(session).status = "active";
        }
        appendEvent(
          session,
          outcome.succeeded ? "action_succeeded" : "action_failed",
          at,
          action.actionId,
        );
        touchSession(session, at);
        return {};
      });
    } catch (error) {
      this.runtimeFences.add(sessionId);
      throw error;
    }
    return this.#actionResponse(sessionId, action.actionId);
  }

  async #executeAction(context, action, signal) {
    const reference = {
      workspaceId: context.workspaceId,
      executionId: context.executionId,
    };
    if (action.type === "write_text") {
      const result = validateWriteResult(
        await this.broker.writeFile({
          ...reference,
          path: action.path,
          content: action.content,
          expectedSha256: action.expectedSha256,
          expectedWorkspaceRevision: action.expectedWorkspaceRevision,
        }),
        action,
      );
      return {
        succeeded: true,
        workspaceRevision: result.workspaceRevision,
        result: {
          path: result.path,
          sha256: result.sha256,
          bytes: result.bytes,
        },
      };
    }
    if (action.type === "run_profile") {
      const profile = context.requiredProfiles.find(
        (candidate) => candidate.id === action.profileId,
      );
      const locked = await this.broker.withLockedExecution(
        reference,
        async ({ workspacePath, workspaceRevision }) => {
          if (workspaceRevision !== action.expectedWorkspaceRevision) {
            throw executorError(
              "WORKSPACE_REVISION_MISMATCH",
              "工作区版本已发生变化",
            );
          }
          return this.sandbox.run({
            profileId: action.profileId,
            workspacePath,
            executionId: context.executionId,
            actionId: action.actionId,
            signal,
            ...(isWindowsTestProfile(this.profileDefinitions[action.profileId]) ? { workspaceRevision } : {}),
          });
        },
      );
      if (
        !hasExactKeys(locked, [
          "result",
          "beforeWorkspaceRevision",
          "afterWorkspaceRevision",
        ]) ||
        !isRevision(locked.beforeWorkspaceRevision) ||
        !isRevision(locked.afterWorkspaceRevision) ||
        locked.beforeWorkspaceRevision !== action.expectedWorkspaceRevision ||
        locked.afterWorkspaceRevision !== locked.beforeWorkspaceRevision
      ) {
        throw executorError(
          "WORKSPACE_CHANGED_DURING_TEST",
          "测试期间工作区发生变化",
        );
      }
      const result = validateSandboxResult(
        locked.result,
        profile.configDigest,
      );
      const definition = this.profileDefinitions[action.profileId];
      if (isWindowsTestProfile(definition) ? (
        !result.runtimeIdentity || result.workspaceRevision !== action.expectedWorkspaceRevision ||
        result.assetVersion !== definition.asset.version || result.verificationKind !== (definition.kind === "windows-test" ? "test" : "build") ||
        result.runtimeIdentity.executionId !== context.executionId || result.runtimeIdentity.actionId !== action.actionId ||
        result.runtimeIdentity.executableSha256 !== definition.nodeSha256
      ) : Object.hasOwn(result, "runtimeIdentity")) {
        throw executorError("SANDBOX_RESULT_INVALID", "测试执行身份或源码版本绑定无效");
      }
      const requiresTestCount = ["node-test", "windows-test"].includes(definition.kind);
      const summary = requiresTestCount
        ? nodeTestSummary(result.stdout)
        : null;
      const succeeded = result.exitCode === 0 && (
        !requiresTestCount ||
        (summary !== null && summary.passed > 0 && summary.failed === 0 && summary.cancelled === 0)
      );
      const auditedResult = {
        ...result,
        ...(summary === null ? {} : { testSummary: summary }),
      };
      return {
        succeeded,
        workspaceRevision: locked.afterWorkspaceRevision,
        profileResult: auditedResult,
        error: succeeded
          ? null
          : { code: "TESTS_FAILED", message: "测试未通过或缺少有效通过用例" },
        result: succeeded
          ? auditedResult
          : {
              ...auditedResult,
              error: { code: "TESTS_FAILED", message: "测试未通过或缺少有效通过用例" },
            },
      };
    }
    if (action.type === "list_files") {
      const files = await this.broker.listFiles({
        ...reference,
        path: action.path,
        expectedWorkspaceRevision: action.expectedWorkspaceRevision,
      });
      return {
        succeeded: true,
        workspaceRevision: action.expectedWorkspaceRevision,
        result: validateFileList(files),
      };
    }
    if (action.type === "read_text") {
      const file = await this.broker.readFile({
        ...reference,
        path: action.path,
        expectedWorkspaceRevision: action.expectedWorkspaceRevision,
      });
      return {
        succeeded: true,
        workspaceRevision: action.expectedWorkspaceRevision,
        result: validateReadResult(file),
      };
    }
    if (action.type === "search_text") {
      const search = await this.broker.searchText({
        ...reference,
        path: action.path,
        query: action.query,
        expectedWorkspaceRevision: action.expectedWorkspaceRevision,
      });
      return {
        succeeded: true,
        workspaceRevision: action.expectedWorkspaceRevision,
        result: validateSearchResult(search),
      };
    }
    if (action.type === "complete") {
      await this.#assertCompletionChecks(
        context,
        action.expectedWorkspaceRevision,
      );
      const sealed = await this.broker.sealExecution({
        ...reference,
        expectedWorkspaceRevision: action.expectedWorkspaceRevision,
      });
      if (
        !hasExactKeys(sealed, ["workspaceRevision", "manifest"]) ||
        sealed.workspaceRevision !== action.expectedWorkspaceRevision
      ) {
        throw executorError(
          "EXECUTION_RESULT_INVALID",
          "工作区 Broker 返回了无效的封存结果",
        );
      }
      return {
        succeeded: true,
        workspaceRevision: sealed.workspaceRevision,
        result: validateChangeManifest(sealed.manifest),
      };
    }
    throw executorError("INVALID_EXECUTION_REQUEST", "动作类型无效");
  }

  async #assertCompletionChecks(context, workspaceRevision) {
    for (const profile of context.requiredProfiles) {
      const proof = Object.hasOwn(context.verifiedProfiles, profile.id)
        ? context.verifiedProfiles[profile.id]
        : null;
      if (
        !proof?.passed ||
        proof.attemptNumber !== context.attemptNumber ||
        proof.workspaceRevision !== workspaceRevision ||
        proof.configDigest !== profile.configDigest ||
        !isExecutionIdentityProof(proof)
      ) {
        throw executorError("CHECKS_NOT_PASSED", "当前代码版本尚未通过全部测试");
      }
      await this.#validateProfileProofArtifacts(context, profile, proof);
    }
  }

  async #readAuditedActionInput(sessionId, action) {
    let storedInput;
    try {
      storedInput = await this.journal.readJson(action.inputArtifact);
    } catch {
      throw executorError(
        "EXECUTION_AUDIT_INVALID",
        "动作输入审计产物缺失或损坏",
      );
    }
    let input;
    try {
      input = normalizeActionRequest({ sessionId, action: storedInput }).action;
    } catch {
      throw executorError("EXECUTION_AUDIT_INVALID", "动作输入审计产物无效");
    }
    if (
      input.actionId !== action.id ||
      input.type !== action.type ||
      input.expectedWorkspaceRevision !== action.workspaceRevisionBefore ||
      digestValue(input) !== action.requestDigest
    ) {
      throw executorError("EXECUTION_AUDIT_INVALID", "动作输入审计产物不匹配");
    }
    return input;
  }

  async #validateProfileProofArtifacts(context, profile, proof) {
    const action = context.actions.find((candidate) => candidate.id === proof.actionId);
    if (
      !action ||
      action.type !== "run_profile" ||
      action.status !== "succeeded" ||
      action.attemptNumber !== context.attemptNumber ||
      action.workspaceRevisionAfter !== proof.workspaceRevision ||
      Object.keys(action.outputArtifacts).sort().join(",") !==
        "output,stderr,stdout"
    ) {
      throw executorError("EXECUTION_AUDIT_INVALID", "测试证明状态无效");
    }
    const input = await this.#readAuditedActionInput(context.sessionId, action);
    if (input.profileId !== profile.id) {
      throw executorError("EXECUTION_AUDIT_INVALID", "测试证明配置不匹配");
    }
    let output;
    let stdout;
    let stderr;
    try {
      [output, stdout, stderr] = await Promise.all([
        this.journal.readJson(action.outputArtifacts.output),
        this.journal.readJson(action.outputArtifacts.stdout),
        this.journal.readJson(action.outputArtifacts.stderr),
      ]);
    } catch {
      throw executorError(
        "EXECUTION_AUDIT_INVALID",
        "测试证明审计产物缺失或损坏",
      );
    }
    if (typeof stdout !== "string" || typeof stderr !== "string") {
      throw executorError("EXECUTION_AUDIT_INVALID", "测试输出审计产物无效");
    }
    let validatedOutput;
    try {
      validatedOutput = validateSandboxProofArtifact(
        output,
        profile.configDigest,
      );
    } catch {
      throw executorError("EXECUTION_AUDIT_INVALID", "测试证明审计产物无效");
    }
    if (digestValue(executionIdentityFields(validatedOutput)) !== digestValue(executionIdentityFields(proof)) ||
      (proof.runtimeIdentity && (validatedOutput.workspaceRevision !== proof.workspaceRevision || proof.runtimeIdentity.actionId !== proof.actionId ||
        proof.runtimeIdentity.executionId !== attemptExecutionId(context.sessionId, proof.attemptNumber)))) {
      throw executorError("EXECUTION_AUDIT_INVALID", "测试执行身份或源码版本证明不匹配");
    }
    if (["node-test", "windows-test"].includes(this.profileKinds.get(profile.id))) {
      const summary = nodeTestSummary(stdout);
      if (
        summary === null ||
        summary.passed < 1 ||
        summary.failed !== 0 ||
        summary.cancelled !== 0 ||
        !isNodeTestSummary(validatedOutput.testSummary) ||
        digestValue(validatedOutput.testSummary) !== digestValue(summary)
      ) {
        throw executorError("EXECUTION_AUDIT_INVALID", "有效测试数证明无效");
      }
    }
  }

  async #writeResultArtifacts(sessionId, action, outcome) {
    if (action.type === "run_profile") {
      const result = outcome.result;
      const [stdout, stderr, output] = await Promise.all([
        this.journal.writeJson({
          sessionId,
          actionId: action.actionId,
          kind: "stdout",
          value: result.stdout || "",
        }),
        this.journal.writeJson({
          sessionId,
          actionId: action.actionId,
          kind: "stderr",
          value: result.stderr || "",
        }),
        this.journal.writeJson({
          sessionId,
          actionId: action.actionId,
          kind: "output",
          value: {
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            ...executionIdentityFields(result),
            ...(result.runtimeIdentity ? { workspaceRevision: result.workspaceRevision } : {}),
            profileFingerprint: result.profileFingerprint,
            timedOut: Boolean(result.timedOut),
            ...(result.testSummary ? { testSummary: result.testSummary } : {}),
            ...(result.error ? { error: result.error } : {}),
          },
        }),
      ]);
      return { output, stdout, stderr };
    }
    if (action.type === "complete") {
      return {
        manifest: await this.journal.writeJson({
          sessionId,
          actionId: action.actionId,
          kind: "manifest",
          value: outcome.result,
        }),
      };
    }
    return {
      output: await this.journal.writeJson({
        sessionId,
        actionId: action.actionId,
        kind: "output",
        value: outcome.result,
      }),
    };
  }

  async #finalizeActionFailure(sessionId, action, error) {
    const resultUnknown =
      action.type === "write_text" ||
      error?.code === "WORKSPACE_CHANGED_DURING_TEST" ||
      error?.code === "WORKSPACE_REVISION_MISMATCH" ||
      error?.code === "EXECUTION_SEALED" ||
      (action.type === "complete" &&
        ["EXECUTION_RESULT_INVALID", "EXECUTION_AUDIT_INVALID"].includes(
          error?.code,
        ));
    const recorded = resultUnknown
      ? {
          code: "RESULT_UNKNOWN",
          message: "动作可能已经产生副作用，结果无法确认",
          ...(error instanceof DockerSandboxError &&
          error.details?.cleanupPending
            ? {
                details: {
                  cleanupPending: true,
                  ...(typeof error.details.containerName === "string"
                    ? { containerName: error.details.containerName }
                    : {}),
                },
              }
            : {}),
        }
      : safeRecordedError(error);
    let artifacts;
    try {
      artifacts = await this.#writeFailureArtifacts(
        sessionId,
        action.actionId,
        recorded,
        error,
      );
    } catch {
      this.runtimeFences.add(sessionId);
      throw executorError(
        "EXECUTION_FENCED",
        "动作失败但审计产物未能持久化",
      );
    }
    const cleanupPending = Boolean(recorded.details?.cleanupPending);
    const interrupted = resultUnknown || cleanupPending;
    try {
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        const storedAction = session.actions.find(
          (entry) => entry.id === action.actionId,
        );
        if (!storedAction || storedAction.status !== "running") {
          throw executorError("EXECUTOR_STATE_INVALID", "动作状态无效");
        }
        const at = this.#now();
        storedAction.status = interrupted ? "interrupted" : "failed";
        storedAction.outputArtifacts = artifacts;
        storedAction.workspaceRevisionAfter = interrupted
          ? null
          : session.workspaceRevision;
        storedAction.finishedAt = at;
        storedAction.error = recorded;
        if (interrupted) {
          session.status = "interrupted";
          currentAttempt(session).status = "interrupted";
          currentAttempt(session).finishedAt = at;
        }
        if (cleanupPending) {
          session.cleanupFence = {
            executionId: currentAttempt(session).executionId,
            actionId: action.actionId,
            containerName: recorded.details?.containerName || null,
            since: at,
            lastError: recorded,
          };
        } else if (!interrupted) {
          session.status = "active";
          currentAttempt(session).status = "active";
        }
        appendEvent(
          session,
          interrupted ? "action_interrupted" : "action_failed",
          at,
          action.actionId,
        );
        touchSession(session, at);
        return {};
      });
    } catch (stateError) {
      this.runtimeFences.add(sessionId);
      throw stateError;
    }
    return this.#actionResponse(sessionId, action.actionId);
  }

  async #writeFailureArtifacts(sessionId, actionId, recorded, error) {
    const output = await this.journal.writeJson({
      sessionId,
      actionId,
      kind: "output",
      value: { error: recorded },
    });
    const artifacts = { output };
    if (typeof error?.details?.stdout === "string") {
      artifacts.stdout = await this.journal.writeJson({
        sessionId,
        actionId,
        kind: "stdout",
        value: error.details.stdout,
      });
    }
    if (typeof error?.details?.stderr === "string") {
      artifacts.stderr = await this.journal.writeJson({
        sessionId,
        actionId,
        kind: "stderr",
        value: error.details.stderr,
      });
    }
    return artifacts;
  }

  async #actionResponse(sessionId, actionId) {
    const snapshot = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, sessionId);
      const action = session.actions.find((entry) => entry.id === actionId);
      if (!action) {
        throw executorError("ACTION_NOT_FOUND", "代码执行动作不存在");
      }
      return { session: projectSession(session), action: projectAction(action), raw: action };
    });
    try {
      return {
        session: snapshot.session,
        action: snapshot.action,
        result: await this.#readActionResult(snapshot.raw),
      };
    } catch (error) {
      this.runtimeFences.add(sessionId);
      throw executorError("EXECUTION_FENCED", "审计产物完整性校验失败");
    }
  }

  async #readActionResult(action) {
    if (action.outputArtifacts?.manifest) {
      return this.journal.readJson(action.outputArtifacts.manifest);
    }
    if (!action.outputArtifacts?.output) {
      return action.status === "interrupted"
        ? { error: action.error }
        : null;
    }
    const output = await this.journal.readJson(action.outputArtifacts.output);
    if (action.type !== "run_profile") return output;
    return {
      ...output,
      stdout: action.outputArtifacts.stdout
        ? await this.journal.readJson(action.outputArtifacts.stdout)
        : "",
      stderr: action.outputArtifacts.stderr
        ? await this.journal.readJson(action.outputArtifacts.stderr)
        : "",
    };
  }

  async #readValidatedActionResult(session, action) {
    const input = await this.#readAuditedActionInput(session.id, action);
    const result = await this.#readActionResult(action);
    return validatePersistedActionResult(session, action, input, result);
  }

  async #validateCompletedSessionArtifacts(session) {
    const attempt = currentAttempt(session);
    const context = {
      sessionId: session.id,
      attemptNumber: attempt.number,
      requiredProfiles: session.requiredProfiles,
      verifiedProfiles: session.verifiedProfiles,
      actions: session.actions,
    };
    try {
      for (const action of session.actions) {
        await this.#readValidatedActionResult(session, action);
      }
      await this.#assertCompletionChecks(context, session.workspaceRevision);
      const completedAction = session.actions.at(-1);
      const input = await this.#readAuditedActionInput(
        session.id,
        completedAction,
      );
      if (input.type !== "complete") {
        throw executorError(
          "EXECUTION_AUDIT_INVALID",
          "完成动作审计产物无效",
        );
      }
      const manifest = await this.journal.readJson(
        completedAction.outputArtifacts.manifest,
      );
      validateChangeManifest(manifest);
    } catch {
      throw executorError(
        "EXECUTOR_STATE_INVALID",
        "已完成会话的审计证明缺失或损坏",
      );
    }
  }

  async #buildCompletedChangeSet(session, completedAction) {
    await this.#validateCompletedSessionArtifacts(session);
    const manifest = await this.#readValidatedActionResult(
      session,
      completedAction,
    );
    if (manifest.deleted.length > 0) {
      throw executorError(
        "EXECUTION_AUDIT_INVALID",
        "当前执行器没有经过审计的删除动作",
      );
    }

    const writes = new Map();
    for (const action of session.actions) {
      if (action.type !== "write_text" || action.status !== "succeeded") {
        continue;
      }
      const [input, result] = await Promise.all([
        this.#readAuditedActionInput(session.id, action),
        this.#readValidatedActionResult(session, action),
      ]);
      const content = Buffer.from(input.content, "utf8");
      const sha256 = contentSha256(content);
      if (
        result.path !== input.path ||
        result.sha256 !== sha256 ||
        result.bytes !== content.length
      ) {
        throw executorError(
          "EXECUTION_AUDIT_INVALID",
          "写入动作内容与审计结果不匹配",
        );
      }
      const previous = writes.get(input.path);
      if (previous && input.expectedSha256 !== previous.sha256) {
        throw executorError(
          "EXECUTION_AUDIT_INVALID",
          "同一文件的写入审计链不连续",
        );
      }
      writes.set(input.path, {
        beforeSha256: previous
          ? previous.beforeSha256
          : input.expectedSha256,
        content,
        sha256,
      });
    }

    const auditedManifest = { created: [], modified: [], deleted: [] };
    const created = [];
    const modified = [];
    for (const [path, write] of writes) {
      if (write.beforeSha256 === null) {
        auditedManifest.created.push({ path, sha256: write.sha256 });
        created.push({ path, content: Buffer.from(write.content) });
      } else if (write.beforeSha256 !== write.sha256) {
        auditedManifest.modified.push({
          path,
          beforeSha256: write.beforeSha256,
          afterSha256: write.sha256,
        });
        modified.push({
          path,
          beforeSha256: write.beforeSha256,
          content: Buffer.from(write.content),
        });
      }
    }
    if (
      digestValue(canonicalChangeManifest(auditedManifest)) !==
      digestValue(canonicalChangeManifest(manifest))
    ) {
      throw executorError(
        "EXECUTION_AUDIT_INVALID",
        "变更清单与完整写入审计链不匹配",
      );
    }
    created.sort(compareChangePath);
    modified.sort(compareChangePath);
    const passedProfiles = session.requiredProfiles.map((profile) => {
      const proof = session.verifiedProfiles[profile.id];
      const action = session.actions.find(({ id }) => id === proof.actionId);
      return {
        id: profile.id,
        configDigest: profile.configDigest,
        workspaceRevision: proof.workspaceRevision,
        actionId: proof.actionId,
        attemptNumber: proof.attemptNumber,
        ...executionIdentityFields(proof),
        artifacts: {
          output: packageArtifact(action.outputArtifacts.output),
          stdout: packageArtifact(action.outputArtifacts.stdout),
          stderr: packageArtifact(action.outputArtifacts.stderr),
        },
      };
    });
    return {
      workspace: {
        id: session.workspaceId,
        sourceRevision: session.sourceRevision,
        workspaceRevision: session.workspaceRevision,
      },
      passedProfiles,
      created,
      modified,
      deleted: [],
    };
  }

  async #validateRecoveryArtifacts() {
    const completedSessions = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return Object.values(state.sessions).filter(
        (session) => session.status === "completed",
      );
    });
    for (const session of completedSessions) {
      await this.#validateCompletedSessionArtifacts(session);
    }
  }

  #assertCancellationBinding(session, request) {
    const expectedRevision = request.expectedWorkspaceRevision;
    const expectedAction = request.expectedAction;
    if (expectedAction === null) {
      if (
        expectedRevision !== null &&
        session.workspaceRevision !== expectedRevision
      ) {
        throw executorError(
          "EXECUTION_BINDING_MISMATCH",
          "取消请求与可信工作区版本不匹配",
        );
      }
      return;
    }
    if (expectedRevision === null) {
      throw executorError(
        "EXECUTION_BINDING_MISMATCH",
        "取消动作缺少可信工作区版本",
      );
    }
    const action = session.actions.find(
      ({ id }) => id === expectedAction.actionId,
    );
    if (!action) {
      if (session.workspaceRevision !== expectedRevision) {
        throw executorError(
          "EXECUTION_BINDING_MISMATCH",
          "缺失动作对应的工作区版本已经变化",
        );
      }
      return;
    }
    if (
      action.requestDigest !== expectedAction.actionDigest ||
      action.workspaceRevisionBefore !== expectedRevision ||
      action.status === "running"
    ) {
      throw executorError(
        "EXECUTION_BINDING_MISMATCH",
        "取消请求与受控动作不匹配",
      );
    }
    const resultingRevision =
      action.workspaceRevisionAfter ?? action.workspaceRevisionBefore;
    if (session.workspaceRevision !== resultingRevision) {
      throw executorError(
        "EXECUTION_BINDING_MISMATCH",
        "取消动作的工作区版本链无效",
      );
    }
  }

  async #reconcileCancellation(request) {
    this.#assertRuntimeAvailable(request.sessionId);
    const sessionExists = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return Object.hasOwn(state.sessions, request.sessionId);
    });
    if (!sessionExists) {
      if (
        request.expectedWorkspaceRevision !== null ||
        request.expectedAction !== null
      ) {
        throw executorError(
          "SESSION_NOT_FOUND",
          "代码执行会话不存在，无法证明已有执行副本已清理",
        );
      }
      return {
        status: "settled",
        session: null,
        proof: projectAbsentCancellationProof(request, this.#now()),
      };
    }
    const claimed = await this.#mutateState((state) => {
      const session = this.#requireSession(state, request.sessionId);
      assertSessionInputBinding(
        session,
        request.inputBinding,
        request.executionSource,
      );
      if (session.cancellation !== null) {
        if (!sameCancellationRequest(session.cancellation, request)) {
          throw executorError(
            "IDEMPOTENCY_CONFLICT",
            "代码执行会话已绑定不同的取消请求",
          );
        }
        if (!["cancelling", "cancelled"].includes(session.status)) {
          throw executorError("EXECUTOR_STATE_INVALID", "取消状态无效");
        }
        return {
          changed: false,
          value: { settled: session.status === "cancelled" },
        };
      }
      this.#assertCancellationBinding(session, request);
      const runningAction = session.actions.find(
        ({ status }) => status === "running",
      );
      const runningReplay = currentAttempt(session).replays.find(
        ({ status }) => status === "running",
      );
      if (runningAction || runningReplay) {
        throw executorError(
          "CANCELLATION_PENDING",
          "受控操作尚未静默，取消清理需要稍后重试",
        );
      }
      const at = this.#now();
      session.status = "cancelling";
      currentAttempt(session).status = "cancelling";
      currentAttempt(session).finishedAt ??= at;
      session.completedAt = null;
      session.error = null;
      session.cancellation = {
        digest: request.cancellationDigest,
        expectedWorkspaceRevision: request.expectedWorkspaceRevision,
        expectedAction: request.expectedAction,
        startedAt: at,
        settledAt: null,
      };
      appendEvent(session, "cancellation_started", at);
      touchSession(session, at);
      return { value: { settled: false } };
    });

    if (claimed.settled) {
      const session = await this.stateQueue.enqueue(async () => {
        const state = await this.#readState();
        return structuredClone(this.#requireSession(state, request.sessionId));
      });
      return structuredClone({
        status: "settled",
        session: projectSession(session),
        proof: projectCancellationProof(session),
      });
    }

    const fence = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, request.sessionId);
      if (!sameCancellationRequest(session.cancellation, request)) {
        throw executorError("EXECUTION_FENCED", "取消清理已被其他请求替代");
      }
      return session.cleanupFence === null
        ? null
        : structuredClone(session.cleanupFence);
    });
    if (fence !== null) {
      try {
        await this.sandbox.cleanup({
          executionId: fence.executionId,
          actionId: fence.actionId,
        });
      } catch (error) {
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, request.sessionId);
          if (
            !sameCancellationRequest(session.cancellation, request) ||
            !sameCleanupFence(session.cleanupFence, fence)
          ) {
            return { changed: false };
          }
          const at = this.#now();
          session.cleanupFence.lastError = safeRecordedError(
            error,
            "SANDBOX_CLEANUP_FAILED",
          );
          appendEvent(session, "cleanup_pending", at, fence.actionId);
          touchSession(session, at);
          return {};
        });
        throw executorError("CLEANUP_PENDING", "残留容器清理尚未确认");
      }
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, request.sessionId);
        if (
          !sameCancellationRequest(session.cancellation, request) ||
          !sameCleanupFence(session.cleanupFence, fence)
        ) {
          throw executorError("EXECUTION_FENCED", "取消清理状态已经变化");
        }
        const at = this.#now();
        session.cleanupFence = null;
        appendEvent(session, "cleanup_confirmed", at, fence.actionId);
        touchSession(session, at);
        return {};
      });
    }

    const attempts = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, request.sessionId);
      if (
        session.status !== "cancelling" ||
        !sameCancellationRequest(session.cancellation, request) ||
        session.cleanupFence !== null
      ) {
        throw executorError("EXECUTION_FENCED", "取消清理状态已经变化");
      }
      return {
        workspaceId: session.workspaceId,
        attempts: session.attempts.map(({ number, executionId }) => ({
          number,
          executionId,
        })),
      };
    });
    try {
      for (const attempt of attempts.attempts) {
        await this.broker.discardExecution({
          workspaceId: attempts.workspaceId,
          executionId: attempt.executionId,
        });
      }
    } catch {
      throw executorError(
        "WORKSPACE_DISPOSAL_PENDING",
        "隔离工作区清理尚未确认",
      );
    }

    const settled = await this.#mutateState((state) => {
      const session = this.#requireSession(state, request.sessionId);
      if (
        session.status !== "cancelling" ||
        !sameCancellationRequest(session.cancellation, request) ||
        session.cleanupFence !== null
      ) {
        throw executorError("EXECUTION_FENCED", "取消结算状态已经变化");
      }
      const at = this.#now();
      session.status = "cancelled";
      currentAttempt(session).status = "cancelled";
      currentAttempt(session).finishedAt = at;
      session.cancellation.settledAt = at;
      appendEvent(session, "cancellation_settled", at);
      touchSession(session, at);
      return { value: structuredClone(session) };
    });
    return structuredClone({
      status: "settled",
      session: projectSession(settled),
      proof: projectCancellationProof(settled),
    });
  }

  async #recover() {
    await this.stateQueue.enqueue(() =>
      this.#readState({ persistLegacyUpgrade: true }),
    );
    await this.#validateRecoveryArtifacts();
    const recoveryWork = await this.#mutateState((state) => {
      let changed = false;
      const sandboxFences = [];
      const workspaces = [];
      for (const session of Object.values(state.sessions)) {
        const runningActions = session.actions.filter(
          (action) => action.status === "running",
        );
        const runningReplays = currentAttempt(session).replays.filter(
          (replay) => replay.status === "running",
        );
        const requiresInterruption =
          RECOVERABLE_STATUSES.has(session.status) ||
          runningActions.length ||
          runningReplays.length;
        const requiresWorkspaceDisposal =
          requiresInterruption ||
          session.status === "interrupted" ||
          session.status === "failed";
        if (requiresInterruption) {
          const at = this.#now();
          session.status = "interrupted";
          currentAttempt(session).status = "interrupted";
          currentAttempt(session).finishedAt = at;
          for (const action of runningActions) {
            action.status = "interrupted";
            action.finishedAt = at;
            action.workspaceRevisionAfter = null;
            action.error = {
              code: "RESULT_UNKNOWN",
              message: "进程中断，动作结果未知",
            };
            if (action.type === "run_profile") {
              session.cleanupFence = {
                executionId: currentAttempt(session).executionId,
                actionId: action.id,
                containerName: null,
                since: at,
                lastError: action.error,
              };
            }
          }
          for (const replay of runningReplays) {
            replay.status = "interrupted";
            replay.finishedAt = at;
            replay.error = {
              code: "RESULT_UNKNOWN",
              message: "进程中断，恢复写入结果未知",
            };
            appendEvent(
              session,
              "replay_interrupted",
              at,
              replay.sourceActionId,
            );
          }
          appendEvent(session, "session_interrupted", at);
          touchSession(session, at);
          changed = true;
        }
        if (requiresWorkspaceDisposal) {
          for (const attempt of session.attempts) {
            workspaces.push({
              sessionId: session.id,
              workspaceId: session.workspaceId,
              executionId: attempt.executionId,
            });
          }
        }
        if (session.cleanupFence) {
          sandboxFences.push({
            sessionId: session.id,
            ...session.cleanupFence,
          });
        }
      }
      return { changed, value: { sandboxFences, workspaces } };
    });

    let workspaceDisposalError = null;
    for (const workspace of recoveryWork.workspaces) {
      try {
        await this.broker.discardExecution({
          workspaceId: workspace.workspaceId,
          executionId: workspace.executionId,
        });
      } catch (error) {
        workspaceDisposalError ??= error;
        this.runtimeFences.add(workspace.sessionId);
      }
    }

    for (const fence of recoveryWork.sandboxFences) {
      try {
        await this.sandbox.cleanup({
          executionId: fence.executionId,
          actionId: fence.actionId,
        });
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, fence.sessionId);
          if (!sameCleanupFence(session.cleanupFence, fence)) {
            return { changed: false };
          }
          const at = this.#now();
          session.cleanupFence = null;
          appendEvent(session, "cleanup_confirmed", at, fence.actionId);
          touchSession(session, at);
          return {};
        });
      } catch (error) {
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, fence.sessionId);
          if (!sameCleanupFence(session.cleanupFence, fence)) {
            return { changed: false };
          }
          const at = this.#now();
          session.cleanupFence = {
            ...session.cleanupFence,
            lastError: safeRecordedError(error, "SANDBOX_CLEANUP_FAILED"),
          };
          appendEvent(session, "cleanup_pending", at, fence.actionId);
          touchSession(session, at);
          return {};
        });
      }
    }
    if (workspaceDisposalError !== null) {
      throw executorError(
        "WORKSPACE_DISPOSAL_PENDING",
        "中断执行的隔离工作区清理尚未确认",
      );
    }
    const cleanupPending = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      return Object.values(state.sessions).filter(
        (session) => session.cleanupFence !== null,
      ).length;
    });
    return { recovered: true, cleanupPending };
  }

  async #resume({ sessionId, inputBinding, executionSource }) {
    let fence = await this.stateQueue.enqueue(async () => {
      const state = await this.#readState();
      const session = this.#requireSession(state, sessionId);
      assertSessionInputBinding(session, inputBinding, executionSource);
      return structuredClone(session.cleanupFence);
    });
    this.#assertRuntimeAvailable(sessionId);
    if (fence) {
      try {
        await this.sandbox.cleanup({
          executionId: fence.executionId,
          actionId: fence.actionId,
        });
      } catch (error) {
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, sessionId);
          if (!sameCleanupFence(session.cleanupFence, fence)) {
            return { changed: false };
          }
          session.cleanupFence.lastError = safeRecordedError(
            error,
            "SANDBOX_CLEANUP_FAILED",
          );
          touchSession(session, this.#now());
          return {};
        });
        throw executorError("CLEANUP_PENDING", "残留容器清理尚未确认");
      }
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        if (!sameCleanupFence(session.cleanupFence, fence)) {
          return { changed: false };
        }
        session.cleanupFence = null;
        touchSession(session, this.#now());
        return {};
      });
      fence = null;
    }

    const prepared = await this.#mutateState((state) => {
      const session = this.#requireSession(state, sessionId);
      assertSessionInputBinding(session, inputBinding, executionSource);
      if (session.status !== "interrupted") {
        throw executorError("SESSION_NOT_INTERRUPTED", "只有中断会话可以恢复");
      }
      this.#assertProfileConfiguration(session);
      const at = this.#now();
      const number = currentAttempt(session).number + 1;
      const executionId = attemptExecutionId(session.id, number);
      const writes = session.actions
        .filter(
          (action) =>
            action.type === "write_text" && action.status === "succeeded",
        )
        .map((action) => ({
          id: action.id,
          requestDigest: action.requestDigest,
          inputArtifact: action.inputArtifact,
          workspaceRevisionBefore: action.workspaceRevisionBefore,
          workspaceRevisionAfter: action.workspaceRevisionAfter,
        }));
      let expectedRevision = session.sourceRevision;
      for (const write of writes) {
        if (
          write.inputArtifact.path !==
            `${session.id}/${write.id}/input.json` ||
          write.workspaceRevisionBefore !== expectedRevision ||
          !isRevision(write.workspaceRevisionAfter)
        ) {
          throw executorError(
            "EXECUTOR_STATE_INVALID",
            "确认写入的版本链无效",
          );
        }
        expectedRevision = write.workspaceRevisionAfter;
      }
      if (expectedRevision !== session.workspaceRevision) {
        throw executorError(
          "EXECUTOR_STATE_INVALID",
          "确认写入的目标版本无效",
        );
      }
      session.attempts.push({
        number,
        executionId,
        status: "preparing",
        startedAt: at,
        finishedAt: null,
        replays: [],
      });
      session.status = "preparing";
      session.verifiedProfiles = {};
      appendEvent(session, "resume_preparing", at);
      touchSession(session, at);
      return {
        value: {
          workspaceId: session.workspaceId,
          executionId,
          inputBinding: structuredClone(session.inputBinding),
          ...(Object.hasOwn(session, "executionSource")
            ? { executionSource: structuredClone(session.executionSource) }
            : {}),
          number,
          sourceRevision: session.sourceRevision,
          targetWorkspaceRevision: session.workspaceRevision,
          writes,
        },
      };
    });

    let created;
    try {
      const reference = {
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        inputBinding: structuredClone(prepared.inputBinding),
        ...(Object.hasOwn(prepared, "executionSource")
          ? { executionSource: structuredClone(prepared.executionSource) }
          : {}),
      };
      created = validateExecutionCreation(
        await this.broker.createExecution(reference),
        reference,
      );
      throwIfPreparationAborted();
    } catch (error) {
      if (isPreparationAbort(error)) return this.#abortPreparation(sessionId, prepared.executionId, error);
      await this.#discardWorkspaceAttempt({
        sessionId,
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        message: "恢复创建失败后的隔离工作区清理尚未确认",
      });
      try {
        await this.#markSessionFailed(sessionId, error, "RESUME_FAILED", {
          executionId: prepared.executionId,
          statuses: ["preparing"],
        });
      } catch (stateError) {
        this.runtimeFences.add(sessionId);
        throw stateError;
      }
      throw executorError("RESUME_FAILED", "无法创建新的恢复副本");
    }
    if (prepared.sourceRevision === null) {
      if (
        prepared.writes.length !== 0 ||
        prepared.targetWorkspaceRevision !== null
      ) {
        await this.#discardWorkspaceAttempt({
          sessionId,
          workspaceId: prepared.workspaceId,
          executionId: prepared.executionId,
          message: "无效首次恢复副本的清理尚未确认",
        });
        throw executorError("EXECUTOR_STATE_INVALID", "首次恢复状态无效");
      }
      prepared.sourceRevision = created.sourceRevision;
      prepared.targetWorkspaceRevision = created.workspaceRevision;
      try {
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, sessionId);
          const attempt = currentAttempt(session);
          if (
            session.status !== "preparing" ||
            attempt.executionId !== prepared.executionId ||
            attempt.status !== "preparing" ||
            session.sourceRevision !== null ||
            session.workspaceRevision !== null
          ) {
            throw executorError(
              "EXECUTION_FENCED",
              "执行生命周期已变化，恢复副本不能接管",
            );
          }
          session.sourceRevision = created.sourceRevision;
          session.workspaceRevision = created.workspaceRevision;
          touchSession(session, this.#now());
          return {};
        });
      } catch (error) {
        this.runtimeFences.add(sessionId);
        await this.#discardWorkspaceAttempt({
          sessionId,
          workspaceId: prepared.workspaceId,
          executionId: prepared.executionId,
          message: "未确认恢复结果的隔离工作区清理尚未确认",
        });
        throw error;
      }
    } else if (created.sourceRevision !== prepared.sourceRevision) {
      await this.#discardWorkspaceAttempt({
        sessionId,
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        message: "来源不一致的恢复副本尚未确认清理",
      });
      try {
        await this.#markSessionFailed(
          sessionId,
          executorError("SOURCE_REVISION_CHANGED", "可信源工作区已经变化"),
          "SOURCE_REVISION_CHANGED",
          {
            executionId: prepared.executionId,
            statuses: ["preparing"],
          },
        );
      } catch (error) {
        this.runtimeFences.add(sessionId);
        throw error;
      }
      throw executorError("SOURCE_REVISION_CHANGED", "可信源工作区已经变化");
    }

    try {
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        const attempt = currentAttempt(session);
        if (
          session.status !== "preparing" ||
          attempt.executionId !== prepared.executionId ||
          attempt.status !== "preparing"
        ) {
          throw executorError(
            "EXECUTION_FENCED",
            "执行生命周期已变化，恢复不能继续",
          );
        }
        const at = this.#now();
        session.status = "replaying";
        attempt.status = "replaying";
        appendEvent(session, "resume_replaying", at);
        touchSession(session, at);
        return {};
      });
    } catch (error) {
      this.runtimeFences.add(sessionId);
      await this.#discardWorkspaceAttempt({
        sessionId,
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        message: "未确认回放状态的隔离工作区清理尚未确认",
      });
      throw error;
    }

    try {
      for (const write of prepared.writes) {
        throwIfPreparationAborted();
        const storedInput = await this.journal.readJson(write.inputArtifact);
        let action;
        try {
          action = normalizeActionRequest({
            sessionId,
            action: storedInput,
          }).action;
        } catch {
          throw executorError("REPLAY_ARTIFACT_INVALID", "写入审计产物无效");
        }
        if (
          action.type !== "write_text" ||
          action.actionId !== write.id ||
          action.expectedWorkspaceRevision !== write.workspaceRevisionBefore ||
          digestValue(action) !== write.requestDigest ||
          write.inputArtifact.path !== `${sessionId}/${write.id}/input.json`
        ) {
          throw executorError("REPLAY_ARTIFACT_INVALID", "写入审计产物无效");
        }
        await this.#mutateState((state) => {
          const session = this.#requireSession(state, sessionId);
          const attempt = currentAttempt(session);
          if (
            session.status !== "replaying" ||
            attempt.executionId !== prepared.executionId ||
            attempt.status !== "replaying"
          ) {
            throw executorError(
              "EXECUTION_FENCED",
              "执行生命周期已变化，恢复写入不能开始",
            );
          }
          const at = this.#now();
          attempt.replays.push({
            sourceActionId: write.id,
            status: "running",
            startedAt: at,
            finishedAt: null,
          });
          appendEvent(session, "replay_running", at, write.id);
          touchSession(session, at);
          return {};
        });
        const result = validateWriteResult(
          await this.broker.writeFile({
            workspaceId: prepared.workspaceId,
            executionId: prepared.executionId,
            path: action.path,
            content: action.content,
            expectedSha256: action.expectedSha256,
            expectedWorkspaceRevision: write.workspaceRevisionBefore,
          }),
          action,
        );
        if (
          result.beforeWorkspaceRevision !== write.workspaceRevisionBefore ||
          result.workspaceRevision !== write.workspaceRevisionAfter
        ) {
          throw executorError("REPLAY_DIVERGED", "恢复写入结果不一致");
        }
        try {
          await this.#mutateState((state) => {
            const session = this.#requireSession(state, sessionId);
            const attempt = currentAttempt(session);
            if (
              session.status !== "replaying" ||
              attempt.executionId !== prepared.executionId ||
              attempt.status !== "replaying"
            ) {
              throw executorError(
                "EXECUTION_FENCED",
                "执行生命周期已变化，恢复写入结果不能提交",
              );
            }
            const at = this.#now();
            const replay = attempt.replays.at(-1);
            if (
              replay?.sourceActionId !== write.id ||
              replay.status !== "running"
            ) {
              throw executorError("EXECUTOR_STATE_INVALID", "恢复写入状态无效");
            }
            replay.status = "succeeded";
            replay.finishedAt = at;
            appendEvent(session, "replay_succeeded", at, write.id);
            touchSession(session, at);
            return {};
          });
        } catch (error) {
          throw error;
        }
      }
      throwIfPreparationAborted();
      const revision = await this.broker.getWorkspaceRevision({
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
      });
      if (revision !== prepared.targetWorkspaceRevision) {
        throw executorError("REPLAY_DIVERGED", "恢复后的工作区版本不一致");
      }
      throwIfPreparationAborted();
    } catch (error) {
      if (this.runtimeFences.has(sessionId)) throw error;
      if (isPreparationAbort(error)) return this.#abortPreparation(sessionId, prepared.executionId, error);
      await this.#discardWorkspaceAttempt({
        sessionId,
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        message: "回放失败后的隔离工作区清理尚未确认",
      });
      try {
        await this.#markSessionFailed(sessionId, error, "REPLAY_FAILED", {
          executionId: prepared.executionId,
          statuses: ["replaying"],
        });
      } catch (stateError) {
        this.runtimeFences.add(sessionId);
        throw stateError;
      }
      throw executorError(
        error instanceof ControlledCodeExecutorError ? error.code : "REPLAY_FAILED",
        "无法安全重建代码执行副本",
      );
    }

    try {
      await this.#mutateState((state) => {
        const session = this.#requireSession(state, sessionId);
        const attempt = currentAttempt(session);
        if (
          session.status !== "replaying" ||
          attempt.executionId !== prepared.executionId ||
          attempt.status !== "replaying"
        ) {
          throw executorError(
            "EXECUTION_FENCED",
            "执行生命周期已变化，恢复结果不能提交",
          );
        }
        throwIfPreparationAborted();
        const at = this.#now();
        session.status = "active";
        attempt.status = "active";
        appendEvent(session, "resume_active", at);
        touchSession(session, at);
        return {};
      });
    } catch (error) {
      if (isPreparationAbort(error)) return this.#abortPreparation(sessionId, prepared.executionId, error);
      this.runtimeFences.add(sessionId);
      await this.#discardWorkspaceAttempt({
        sessionId,
        workspaceId: prepared.workspaceId,
        executionId: prepared.executionId,
        message: "未确认恢复完成结果的隔离工作区清理尚未确认",
      });
      throw error;
    }
    return this.#readProjectedSession(sessionId);
  }
}
