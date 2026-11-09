import path from "node:path";
import { isAutomaticReviewExecution } from "../domain/automatic-review-policy.js";
import { types as utilTypes } from "node:util";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { currentPullRequestTargetArgs, projectGitHubCurrentPullRequestTarget } from "./github-current-pull-request-target.js";
import {
  GitHubCredentialSourceError,
} from "../lib/github-credential-source.js";
import {
  ManagedProcess,
  ManagedProcessError,
  ManagedProcessRunner,
} from "../lib/managed-process.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)$/;
const REPOSITORY_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/;
const REVIEW_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const REVIEW_STATES = Object.freeze({
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
});
const MARKER_PREFIX = "mydashboard-action:v1";
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const GITHUB_TOKEN = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const CHILD_ENV_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
]);
const NETWORK_ENV_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

class GitHubActionError extends Error {
  constructor(code, trust) {
    super(code);
    this.name = "GitHubActionError";
    this.code = code;
    this.trust = trust;
  }
}

function actionError(code, trust = null) {
  return new GitHubActionError(code, trust);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactObject(value, keys) {
  if (!isPlainObject(value)) throw actionError("INVALID_GITHUB_ACTION", "trusted");
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") throw actionError("INVALID_GITHUB_ACTION", "trusted");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw actionError("INVALID_GITHUB_ACTION", "trusted");
    }
  }
  return value;
}

function exactString(value, pattern, maximumBytes = 256) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    !pattern.test(value)
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  return value;
}

function actionBody(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 8 * 1024
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  return value;
}

function parseTarget(value) {
  exactObject(value, ["provider", "resourceId", "version"]);
  if (value.provider !== "github") {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  const match = exactString(value.resourceId, REPOSITORY, 256).match(REPOSITORY);
  const number = Number(match[3]);
  if (
    !Number.isSafeInteger(number) ||
    match[1].includes("--") ||
    match[2].includes("..") ||
    match[2].startsWith(".") ||
    match[2].endsWith(".")
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  return {
    provider: "github",
    resourceId: value.resourceId,
    version: exactString(value.version, SHA, 64),
    repo: `${match[1]}/${match[2]}`,
    number,
  };
}

function normalizeAssigneeRequest(value) {
  exactObject(value, [
    "actorAccountId",
    "repository",
    "pullRequestNumber",
    "assigneeLogin",
    ...(Object.hasOwn(value, "expectedHeadOid") ? ["expectedHeadOid"] : []),
    ...(Object.hasOwn(value, "expectedAssigneeLogin") ? ["expectedAssigneeLogin"] : []),
  ]);
  const actorAccountId = exactString(value.actorAccountId, GITHUB_LOGIN, 39);
  const assigneeLogin = exactString(value.assigneeLogin, GITHUB_LOGIN, 39);
  const repository = exactString(value.repository, REPOSITORY_NAME, 140);
  const match = repository.match(REPOSITORY_NAME);
  if (
    match[1].includes("--") ||
    match[2].includes("..") ||
    match[2].startsWith(".") ||
    match[2].endsWith(".") ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber < 1
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  return Object.freeze({
    actor: Object.freeze({ accountId: actorAccountId }),
    repository,
    pullRequestNumber: value.pullRequestNumber,
    assigneeLogin,
    ...(Object.hasOwn(value, "expectedHeadOid") ? { expectedHeadOid: exactString(value.expectedHeadOid, SHA, 64) } : {}),
    ...(Object.hasOwn(value, "expectedAssigneeLogin") ? { expectedAssigneeLogin: exactString(value.expectedAssigneeLogin, GITHUB_LOGIN, 39) } : {}),
  });
}

function normalizeAction(kind, value, { allowLegacyWorkProposal = false } = {}) {
  if (kind === "github.pull-request-review") {
    exactObject(value, ["type", "reviewEvent", "body"]);
    if (
      value.type !== "pull_request_review" ||
      !REVIEW_EVENTS.has(value.reviewEvent)
    ) {
      throw actionError("INVALID_GITHUB_ACTION", "trusted");
    }
    return {
      type: "pull_request_review",
      reviewEvent: value.reviewEvent,
      body: actionBody(value.body),
    };
  }
  if (kind === "github.work-proposal-review") {
    if (allowLegacyWorkProposal && !Object.hasOwn(value, "inputBinding")) {
      exactObject(value, ["type", "reviewEvent", "body"]);
      if (
        value.type !== "pull_request_review" ||
        !REVIEW_EVENTS.has(value.reviewEvent)
      ) {
        throw actionError("INVALID_GITHUB_ACTION", "trusted");
      }
      return {
        type: "pull_request_review",
        reviewEvent: value.reviewEvent,
        body: actionBody(value.body),
      };
    }
    exactObject(value, ["type", "reviewEvent", "body", "inputBinding"]);
    if (
      value.type !== "pull_request_review" ||
      !REVIEW_EVENTS.has(value.reviewEvent)
    ) {
      throw actionError("INVALID_GITHUB_ACTION", "trusted");
    }
    let inputBinding;
    try {
      inputBinding = normalizePullRequestExecutionBinding(
        value.inputBinding,
        actionError("INVALID_GITHUB_ACTION", "trusted"),
      );
    } catch {
      throw actionError("INVALID_GITHUB_ACTION", "trusted");
    }
    if (inputBinding.schemaVersion !== 2) {
      throw actionError("INVALID_GITHUB_ACTION", "trusted");
    }
    return {
      type: "pull_request_review",
      reviewEvent: value.reviewEvent,
      body: actionBody(value.body),
      inputBinding,
    };
  }
  throw actionError("INVALID_GITHUB_ACTION", "trusted");
}

function normalizeEnvelope(value, { allowLegacyWorkProposal = false } = {}) {
  exactObject(value, [
    "schemaVersion",
    "id",
    "idempotencyKey",
    "kind",
    "requestedBy",
    "actor",
    "target",
    "action",
    "displayedPayloadDigest",
    "approvalBindingDigest",
    "execution",
  ]);
  if (value.schemaVersion !== 1) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  const id = exactString(value.id, SAFE_ID, 128);
  const kind = exactString(value.kind, SAFE_ID, 128);
  exactObject(value.requestedBy, ["roleId", "workItemId"]);
  const requestedBy = {
    roleId: exactString(value.requestedBy.roleId, SAFE_ID, 128),
    workItemId: exactString(value.requestedBy.workItemId, /^[^\u0000-\u001f\u007f]{1,256}$/, 256),
  };
  exactObject(value.actor, ["provider", "accountId"]);
  if (value.actor.provider !== "github") {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  const actor = {
    provider: "github",
    accountId: exactString(value.actor.accountId, GITHUB_LOGIN, 39),
  };
  const target = parseTarget(value.target);
  const action = normalizeAction(kind, value.action, {
    allowLegacyWorkProposal,
  });
  if (
    action.inputBinding &&
    (action.inputBinding.repository !== target.repo ||
      action.inputBinding.pullRequestNumber !== target.number ||
      action.inputBinding.headRefOid !== target.version ||
      action.inputBinding.gitTarget.sourceAccountId.toLowerCase() !==
        actor.accountId.toLowerCase())
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  const displayedPayloadDigest = exactString(
    value.displayedPayloadDigest,
    SHA256,
    64,
  );
  const approvalBindingDigest = exactString(
    value.approvalBindingDigest,
    SHA256,
    64,
  );
  if (value.idempotencyKey !== `confirmation-${approvalBindingDigest}`) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  exactObject(value.execution, ["requestId", "attempt", "startedAt"]);
  if (
    !Number.isSafeInteger(value.execution.attempt) ||
    value.execution.attempt < 1 ||
    typeof value.execution.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.execution.startedAt))
  ) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  const execution = {
    requestId: exactString(value.execution.requestId, REQUEST_ID, 128),
    attempt: value.execution.attempt,
    startedAt: new Date(value.execution.startedAt).toISOString(),
  };
  if (execution.startedAt !== value.execution.startedAt) {
    throw actionError("INVALID_GITHUB_ACTION", "trusted");
  }
  return {
    schemaVersion: 1,
    id,
    idempotencyKey: value.idempotencyKey,
    kind,
    requestedBy,
    actor,
    target,
    action,
    displayedPayloadDigest,
    approvalBindingDigest,
    execution,
  };
}

function markerForEnvelope(envelope) {
  const digest = digestValue({
    schemaVersion: 1,
    idempotencyKey: envelope.idempotencyKey,
    kind: envelope.kind,
    actor: envelope.actor,
    target: {
      provider: envelope.target.provider,
      resourceId: envelope.target.resourceId,
      version: envelope.target.version,
    },
    action: envelope.action,
    approvalBindingDigest: envelope.approvalBindingDigest,
  });
  return `<!-- ${MARKER_PREFIX}:${digest} -->`;
}

function stableError(error) {
  if (error instanceof GitHubActionError) return error;
  if (error instanceof GitHubCredentialSourceError) {
    const trust = error.code === "GITHUB_ACTOR_MISMATCH"
      ? "trusted"
      : error.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED"
        ? "unknown"
        : "absent";
    return actionError(error.code, trust);
  }
  if (error instanceof ManagedProcessError) {
    const code = {
      PROCESS_TIMEOUT: "GITHUB_TIMEOUT",
      PROCESS_OUTPUT_LIMIT: "GITHUB_OUTPUT_LIMIT",
      PROCESS_ABORTED: "GITHUB_UNAVAILABLE",
    }[error.code];
    return actionError(code || "GITHUB_UNAVAILABLE");
  }
  return actionError("GITHUB_UNAVAILABLE");
}

function errorResult(error, { fallbackTrust = "unknown" } = {}) {
  const stable = stableError(error);
  return {
    status: "error",
    error: {
      trust: stable.trust ?? fallbackTrust,
      code: stable.code,
    },
  };
}

function exactCredentialLease(value) {
  const keys = value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value)
    ? []
    : Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("use") ||
    !keys.includes("release") ||
    !Object.isFrozen(value) ||
    keys.some((key) =>
      typeof key !== "string" ||
      typeof Object.getOwnPropertyDescriptor(value, key)?.value !== "function")
  ) {
    throw actionError("GITHUB_CREDENTIAL_OUTPUT_INVALID", "absent");
  }
  return value;
}

function githubReceipt(record, envelope) {
  const id = record?.id;
  if (
    !(
      (Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" && /^[1-9][0-9]*$/.test(id))
    )
  ) {
    throw actionError("GITHUB_PROTOCOL");
  }
  if (typeof record.html_url !== "string") {
    throw actionError("GITHUB_PROTOCOL");
  }
  let url;
  try {
    url = new URL(record.html_url);
  } catch {
    throw actionError("GITHUB_PROTOCOL");
  }
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname.toLowerCase() !==
      `/${envelope.target.repo}/pull/${envelope.target.number}`.toLowerCase() ||
    url.hash !== `#pullrequestreview-${String(id)}`
  ) {
    throw actionError("GITHUB_PROTOCOL");
  }
  url.hash = "";
  const timestamp = record.created_at || record.submitted_at;
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw actionError("GITHUB_PROTOCOL");
  }
  const createdAt = new Date(timestamp).toISOString();
  return { id: String(id), url: url.href, createdAt };
}

class GitHubActionAdapter {
  #runner;
  #command;
  #credentialSource;
  #environment;
  #networkEnvironment;
  #clock;
  #timeoutMs;
  #verifyInputAuthority;
  #automaticReviewGuard;
  #activeOperations;
  #closed;

  constructor({
    runner = new ManagedProcessRunner({
      managedProcessFactory: () =>
        new ManagedProcess({
          maxLineBytes: 1024 * 1024,
          maxOutputBytes: 4 * 1024 * 1024,
        }),
    }),
    environment = process.env,
    networkEnv = {},
    credentialSource,
    clock = () => Date.now(),
    ghCommand,
    timeoutMs = 60_000,
    inputAuthorityVerifier,
    automaticReviewGuard = null,
  } = {}) {
    if (!runner || typeof runner.run !== "function") {
      throw new TypeError("runner must provide run");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new TypeError("timeoutMs is outside the supported range");
    }
    if (
      typeof ghCommand !== "string" ||
      !path.isAbsolute(ghCommand) ||
      INVALID_CONTROL.test(ghCommand) ||
      Buffer.byteLength(ghCommand, "utf8") > 1_024
    ) {
      throw new TypeError("ghCommand must be an absolute executable path");
    }
    const credentialSourceKeys = credentialSource === null ||
      typeof credentialSource !== "object" ||
      utilTypes.isProxy(credentialSource)
      ? []
      : Reflect.ownKeys(credentialSource);
    if (
      credentialSourceKeys.length !== 1 ||
      credentialSourceKeys[0] !== "acquire" ||
      !Object.isFrozen(credentialSource) ||
      typeof Object.getOwnPropertyDescriptor(credentialSource, "acquire")?.value !==
        "function"
    ) {
      throw new TypeError("credentialSource must be an exact frozen acquire port");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    if (!isPlainObject(networkEnv)) {
      throw new TypeError("networkEnv must be a plain object");
    }
    this.#runner = runner;
    this.#command = ghCommand;
    const normalizedNetworkEnv = {};
    for (const key of Reflect.ownKeys(networkEnv)) {
      if (typeof key !== "string" || !NETWORK_ENV_KEYS.includes(key)) {
        throw new TypeError("networkEnv contains an unsupported key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(networkEnv, key);
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        INVALID_CONTROL.test(descriptor.value) ||
        Buffer.byteLength(descriptor.value, "utf8") > 4_096
      ) {
        throw new TypeError("networkEnv contains an invalid value");
      }
      normalizedNetworkEnv[key] = descriptor.value;
    }
    const network = Object.freeze(normalizedNetworkEnv);
    this.#credentialSource = credentialSource;
    this.#environment = environment;
    this.#networkEnvironment = network;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
    this.#activeOperations = new Set();
    this.#closed = false;
    if (
      inputAuthorityVerifier !== undefined &&
      (!inputAuthorityVerifier ||
        typeof inputAuthorityVerifier.verify !== "function")
    ) {
      throw new TypeError("inputAuthorityVerifier must provide verify(binding)");
    }
    this.#verifyInputAuthority = inputAuthorityVerifier?.verify.bind(
      inputAuthorityVerifier,
    ) ?? null;
    this.#automaticReviewGuard = automaticReviewGuard;
  }

  async reconcile(input) {
    let envelope;
    try {
      envelope = normalizeEnvelope(input, { allowLegacyWorkProposal: true });
    } catch (error) {
      return errorResult(error);
    }
    const operation = this.#beginOperation();
    try {
      return await this.#withCredential(
        envelope,
        async (childEnvironment, operation) => {
          await this.#assertActor(
            envelope.actor.accountId,
            childEnvironment,
            operation,
          );
          const matched = await this.#findMarker(
            envelope,
            childEnvironment,
            operation,
          );
          if (matched) return { status: "already", receipt: matched };
          if (
            envelope.kind === "github.work-proposal-review" &&
            !envelope.action.inputBinding
          ) {
            return { status: "stale" };
          }
          if (!(await this.#inputAuthorityCurrent(envelope, operation))) {
            return { status: "stale" };
          }
          const currentTarget = await this.#currentTarget(
            envelope,
            childEnvironment,
            operation,
          );
          if (!currentTarget.matches) {
            return {
              status: "stale",
              expectedVersion: envelope.target.version,
              actualVersion: currentTarget.actualVersion,
            };
          }
          return { status: "absent", code: "GITHUB_MARKER_ABSENT" };
        },
        operation,
      );
    } catch (error) {
      return errorResult(error);
    } finally {
      this.#finishOperation(operation);
    }
  }

  async execute(input) {
    let envelope;
    let postStarted = false;
    try {
      envelope = normalizeEnvelope(input);
    } catch (error) {
      return errorResult(error);
    }
    const operation = this.#beginOperation();
    try {
      if (!(await this.#inputAuthorityCurrent(envelope, operation))) {
        return { status: "stale" };
      }
      return await this.#withCredential(envelope, async (
        childEnvironment,
        credentialOperation,
      ) => this.#executeWithEnvironment(
          envelope,
          childEnvironment,
          credentialOperation,
          () => { postStarted = true; },
        ), operation);
    } catch (error) {
      return errorResult(error, {
        fallbackTrust: postStarted ? "unknown" : "absent",
      });
    } finally {
      this.#finishOperation(operation);
    }
  }

  async #executeWithEnvironment(
    envelope,
    childEnvironment,
    operation,
    markPostStarted,
  ) {
    await this.#assertActor(
        envelope.actor.accountId,
        childEnvironment,
        operation,
    );
    const matched = await this.#findMarker(
        envelope,
        childEnvironment,
        operation,
    );
    if (matched) return { status: "already", receipt: matched };
    const observedTarget = await this.#currentTarget(
        envelope,
        childEnvironment,
        operation,
    );
    if (!observedTarget.matches) {
      return {
        status: "stale",
        expectedVersion: envelope.target.version,
        actualVersion: observedTarget.actualVersion,
      };
    }
    await this.#assertActor(
        envelope.actor.accountId,
        childEnvironment,
        operation,
    );
    const finalTarget = await this.#currentTarget(
        envelope,
        childEnvironment,
        operation,
    );
    if (!finalTarget.matches) {
      return {
        status: "stale",
        expectedVersion: envelope.target.version,
        actualVersion: finalTarget.actualVersion,
      };
    }
    if (!(await this.#inputAuthorityCurrent(envelope, operation))) {
      return { status: "stale" };
    }
    if (isAutomaticReviewExecution(envelope) &&
        (!this.#automaticReviewGuard || await this.#awaitOperation(operation, () => this.#automaticReviewGuard.verify(envelope)) !== true)) return { status: "stale" };
    markPostStarted();
    return {
      status: "applied",
      receipt: await this.#post(envelope, childEnvironment, operation),
    };
  }

  #beginOperation(parentSignal = null) {
    const controller = new AbortController();
    this.#activeOperations.add(controller);
    const abortFromParent = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    if (this.#closed) controller.abort();
    const deadline = this.#clock() + this.#timeoutMs;
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.#clock()),
    );
    timer.unref?.();
    return Object.freeze({
      controller,
      signal: controller.signal,
      deadline,
      timer,
      parentSignal,
      abortFromParent,
    });
  }

  #finishOperation(operation) {
    clearTimeout(operation.timer);
    operation.parentSignal?.removeEventListener(
      "abort",
      operation.abortFromParent,
    );
    this.#activeOperations.delete(operation.controller);
  }

  async assignAssignee(input, { signal = null } = {}) {
    const request = normalizeAssigneeRequest(input);
    if (
      signal !== null &&
      !(signal instanceof AbortSignal)
    ) {
      throw new TypeError("signal must be an AbortSignal");
    }
    const operation = this.#beginOperation(signal);
    try {
      return await this.#withCredential(
        request,
        async (childEnvironment, credentialOperation) => {
          await this.#assertActor(
            request.actor.accountId,
            childEnvironment,
            credentialOperation,
          );
          const route =
            `repos/${request.repository}/issues/${request.pullRequestNumber}`;
          const current = await this.#runJson(
            ["api", "--method", "GET", route],
            { childEnvironment, operation: credentialOperation },
          );
          this.#assertAssignablePullRequest(current, request);
          this.#assertHandoffOwner(current, request);
          let observed = current;
          let changed = false;
          if (!this.#hasAssignee(observed, request.assigneeLogin)) {
            await this.#assertHandoffHead(request, childEnvironment, credentialOperation);
            await this.#assertActor(
              request.actor.accountId,
              childEnvironment,
              credentialOperation,
            );
            observed = await this.#runJson(
              ["api", "--method", "POST", `${route}/assignees`, "--input", "-"],
              {
                input: JSON.stringify({ assignees: [request.assigneeLogin] }),
                childEnvironment,
                operation: credentialOperation,
              },
            );
            this.#assertAssignablePullRequest(observed, request);
            if (!this.#hasAssignee(observed, request.assigneeLogin)) {
              throw actionError("GITHUB_PROTOCOL");
            }
            changed = true;
          }
          const previousOwner = request.expectedAssigneeLogin || request.actor.accountId;
          if (
            previousOwner.toLowerCase() !==
              request.assigneeLogin.toLowerCase() &&
            this.#hasAssignee(observed, previousOwner)
          ) {
            await this.#assertHandoffHead(request, childEnvironment, credentialOperation);
            await this.#assertActor(
              request.actor.accountId,
              childEnvironment,
              credentialOperation,
            );
            observed = await this.#runJson(
              ["api", "--method", "DELETE", `${route}/assignees`, "--input", "-"],
              {
                input: JSON.stringify({
                  assignees: [previousOwner],
                }),
                childEnvironment,
                operation: credentialOperation,
              },
            );
            this.#assertAssignablePullRequest(observed, request);
            if (
              !this.#hasAssignee(observed, request.assigneeLogin) ||
              this.#hasAssignee(observed, previousOwner)
            ) {
              throw actionError("GITHUB_PROTOCOL");
            }
            changed = true;
          }
          return Object.freeze({
            status: changed ? "applied" : "already",
            assigneeLogin: request.assigneeLogin,
          });
        },
        operation,
      );
    } finally {
      this.#finishOperation(operation);
    }
  }

  async #assertHandoffHead(request, childEnvironment, operation) {
    if (!request.expectedHeadOid) return;
    const pr = await this.#runJson(["api", "--method", "GET", `repos/${request.repository}/pulls/${request.pullRequestNumber}`], { childEnvironment, operation });
    if (pr?.state !== "open" || pr?.head?.sha !== request.expectedHeadOid) throw actionError("GITHUB_HANDOFF_HEAD_CHANGED", "absent");
    this.#assertHandoffOwner(pr, request);
  }

  #assertHandoffOwner(pr, request) {
    if (!request.expectedAssigneeLogin) return;
    const allowed = [request.expectedAssigneeLogin, request.assigneeLogin].map(login => login.toLowerCase());
    if (!Array.isArray(pr.assignees) || pr.assignees.length === 0 ||
        pr.assignees.some(person => typeof person?.login !== 'string' || !allowed.includes(person.login.toLowerCase()))) {
      throw actionError('GITHUB_HANDOFF_OWNER_CHANGED', 'absent');
    }
  }

  async assignReviewOutcome(input, { signal = null } = {}) {
    exactObject(input, ["actorAccountId", "repository", "pullRequestNumber", "headRefOid", "reviewEvent", "testingOwnerLogin"]);
    if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(input.reviewEvent)) throw actionError("INVALID_GITHUB_ACTION", "trusted");
    const request = normalizeAssigneeRequest({ actorAccountId: input.actorAccountId, repository: input.repository, pullRequestNumber: input.pullRequestNumber,
      assigneeLogin: input.reviewEvent === "APPROVE" ? input.testingOwnerLogin : input.actorAccountId, expectedHeadOid: input.headRefOid });
    const operation = this.#beginOperation(signal);
    let author;
    try {
      author = await this.#withCredential(request, async (childEnvironment, credentialOperation) => {
        await this.#assertActor(request.actor.accountId, childEnvironment, credentialOperation);
        const pr = await this.#runJson(["api", "--method", "GET", `repos/${request.repository}/pulls/${request.pullRequestNumber}`], { childEnvironment, operation: credentialOperation });
        if (pr?.number !== request.pullRequestNumber || pr?.html_url?.toLowerCase() !== `https://github.com/${request.repository}/pull/${request.pullRequestNumber}`.toLowerCase() || pr?.state !== "open" || pr?.head?.sha !== request.expectedHeadOid) throw actionError("GITHUB_HANDOFF_HEAD_CHANGED", "absent");
        return exactString(pr.user?.login, GITHUB_LOGIN, 39);
      }, operation);
    } finally { this.#finishOperation(operation); }
    if (author.toLowerCase() === input.actorAccountId.toLowerCase()) throw actionError("GITHUB_HANDOFF_SELF_AUTHORED", "absent");
    return this.assignAssignee({ actorAccountId: input.actorAccountId, repository: input.repository, pullRequestNumber: input.pullRequestNumber,
      assigneeLogin: input.reviewEvent === "APPROVE" ? input.testingOwnerLogin : author, expectedHeadOid: input.headRefOid }, { signal });
  }

  #assertAssignablePullRequest(value, request) {
    const expectedUrl =
      `https://github.com/${request.repository}/pull/${request.pullRequestNumber}`;
    if (
      !isPlainObject(value) ||
      value.number !== request.pullRequestNumber ||
      value.state !== "open" ||
      typeof value.html_url !== "string" ||
      value.html_url.toLowerCase() !== expectedUrl.toLowerCase() ||
      !Array.isArray(value.assignees)
    ) {
      throw actionError("GITHUB_HANDOFF_TARGET_UNAVAILABLE", "absent");
    }
  }

  #hasAssignee(value, login) {
    return value.assignees.some(
      (assignee) =>
        isPlainObject(assignee) &&
        typeof assignee.login === "string" &&
        assignee.login.toLowerCase() === login.toLowerCase(),
    );
  }

  async #withCredential(envelope, callback, operation) {
    let lease = null;
    try {
      lease = exactCredentialLease(
        await this.#credentialSource.acquire(Object.freeze({
        actorAccountId: envelope.actor.accountId,
        signal: operation.signal,
        deadline: operation.deadline,
        })),
      );
      return await lease.use((token) => callback(
        this.#buildChildEnvironment(
          token,
          this.#environment,
          this.#networkEnvironment,
        ),
        Object.freeze({
          signal: operation.signal,
          deadline: operation.deadline,
        }),
      ));
    } finally {
      await lease?.release();
    }
  }

  close() {
    this.#closed = true;
    for (const controller of this.#activeOperations) controller.abort();
  }

  async #assertActor(expectedLogin, childEnvironment, operation = null) {
    const value = await this.#runJson(
      ["api", "--method", "GET", "user"],
      { childEnvironment, operation },
    );
    if (!isPlainObject(value) || typeof value.login !== "string") {
      throw actionError("GITHUB_PROTOCOL");
    }
    if (value.login.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw actionError("GITHUB_ACTOR_MISMATCH", "trusted");
    }
  }

  async #inputAuthorityCurrent(envelope, operation) {
    const binding = envelope.action.inputBinding;
    if (!binding) {
      return envelope.kind !== "github.work-proposal-review";
    }
    if (this.#verifyInputAuthority === null) return false;
    try {
      const verified = await this.#awaitOperation(
        operation,
        () => this.#verifyInputAuthority(structuredClone(binding)),
      );
      return samePullRequestExecutionBinding(verified, binding);
    } catch (error) {
      if (error instanceof GitHubActionError) throw error;
      if (error?.code === "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE") throw actionError("GITHUB_UNAVAILABLE");
      return false;
    }
  }

  async #awaitOperation(operation, callback) {
    this.#assertOperationCurrent(operation);
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(this.#operationError(operation));
      operation.signal.addEventListener("abort", abort, { once: true });
    });
    if (operation.signal.aborted) abort();
    const work = Promise.resolve().then(() => {
      this.#assertOperationCurrent(operation);
      return callback();
    });
    try {
      const value = await Promise.race([work, aborted]);
      this.#assertOperationCurrent(operation);
      return value;
    } finally {
      operation.signal.removeEventListener("abort", abort);
    }
  }

  #assertOperationCurrent(operation) {
    if (this.#clock() >= operation.deadline) {
      throw actionError("GITHUB_TIMEOUT");
    }
    if (operation.signal.aborted) {
      throw actionError("GITHUB_UNAVAILABLE");
    }
  }

  #operationError(operation) {
    return this.#clock() >= operation.deadline
      ? actionError("GITHUB_TIMEOUT")
      : actionError("GITHUB_UNAVAILABLE");
  }

  async #currentTarget(envelope, childEnvironment, operation = null) {
    const targetAware = Boolean(envelope.action.inputBinding);
    if (targetAware) {
      const identity = { repository: envelope.target.repo, number: envelope.target.number, sourceAccountId: envelope.actor.accountId };
      try {
        const observed = projectGitHubCurrentPullRequestTarget(
          await this.#runJson(["api", ...currentPullRequestTargetArgs(identity).slice(3)], { childEnvironment, operation }), identity);
        if (observed.state !== "OPEN") return { matches: false, actualVersion: observed.headRefOid };
        return {
          matches: samePullRequestGitTarget(envelope.action.inputBinding.gitTarget, observed.gitTarget),
          actualVersion: observed.headRefOid,
        };
      } catch (error) {
        if (error.code !== "GITHUB_CURRENT_PR_TARGET_INVALID") throw error;
        throw actionError("GITHUB_PROTOCOL");
      }
    }
    const value = await this.#runJson(
      [
        "pr",
        "view",
        `https://github.com/${envelope.target.repo}/pull/${envelope.target.number}`,
        "--json",
        "headRefOid",
      ],
      { childEnvironment, operation },
    );
    if (
      !isPlainObject(value) ||
      typeof value.headRefOid !== "string" ||
      !SHA.test(value.headRefOid)
    ) {
      throw actionError("GITHUB_PROTOCOL");
    }
    return {
      matches: value.headRefOid === envelope.target.version,
      actualVersion: value.headRefOid,
    };
  }

  async #findMarker(envelope, childEnvironment, operation = null) {
    const route = `repos/${envelope.target.repo}/pulls/${envelope.target.number}/reviews?per_page=100`;
    const marker = markerForEnvelope(envelope);
    const records = await this.#runJsonLines(
      [
        "api",
        "--method",
        "GET",
        route,
        "--paginate",
        "--jq",
        `.[] | select((.body // "") | contains("${marker}")) | {id, html_url, submitted_at, user: {login: .user.login}, body, state, commit_id}`,
      ],
      { childEnvironment, operation },
    );
    const candidates = records.filter(
      (record) => typeof record?.body === "string" && record.body.includes(marker),
    );
    if (!candidates.length) return null;
    if (candidates.length !== 1 || !this.#matchesRecord(envelope, candidates[0], marker)) {
      throw actionError("GITHUB_MARKER_CONFLICT");
    }
    return githubReceipt(candidates[0], envelope);
  }

  #matchesRecord(envelope, record, marker) {
    if (
      !isPlainObject(record) ||
      record.body !== `${envelope.action.body}\n\n${marker}` ||
      typeof record.user?.login !== "string" ||
      record.user.login.toLowerCase() !== envelope.actor.accountId.toLowerCase()
    ) {
      return false;
    }
    return (
      record.state === REVIEW_STATES[envelope.action.reviewEvent] &&
      record.commit_id === envelope.target.version
    );
  }

  async #post(envelope, childEnvironment, operation = null) {
    const marker = markerForEnvelope(envelope);
    const body = `${envelope.action.body}\n\n${marker}`;
    const args = [
      "api",
      "--method",
      "POST",
      `repos/${envelope.target.repo}/pulls/${envelope.target.number}/reviews`,
      "--input",
      "-",
    ];
    const record = await this.#runJson(args, {
      input: JSON.stringify({
        event: envelope.action.reviewEvent,
        body,
        commit_id: envelope.target.version,
      }),
      childEnvironment,
      operation,
    });
    if (!this.#matchesRecord(envelope, record, marker)) {
      throw actionError("GITHUB_PROTOCOL");
    }
    return githubReceipt(record, envelope);
  }

  async #runJson(args, { input, childEnvironment, operation } = {}) {
    const result = await this.#run(args, { input, childEnvironment, operation });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw actionError("GITHUB_PROTOCOL");
    }
  }

  async #runJsonLines(args, { childEnvironment, operation } = {}) {
    const result = await this.#run(args, { childEnvironment, operation });
    if (!result.stdout.trim()) return [];
    try {
      return result.stdout.split("\n").map((line) => JSON.parse(line));
    } catch {
      throw actionError("GITHUB_PROTOCOL");
    }
  }

  async #run(args, { input, childEnvironment, operation } = {}) {
    const fixedArgs =
      args[0] === "api"
        ? ["api", "--hostname", "github.com", ...args.slice(1)]
        : args;
    let result;
    try {
      const timeoutMs = operation === undefined || operation === null
        ? this.#timeoutMs
        : operation.deadline - this.#clock();
      if (operation?.signal.aborted) {
        throw new ManagedProcessError("PROCESS_ABORTED", "Process was aborted");
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new ManagedProcessError("PROCESS_TIMEOUT", "Process timed out");
      }
      result = await this.#runner.run({
        command: this.#command,
        args: fixedArgs,
        env: { ...childEnvironment },
        ...(input === undefined ? {} : { input }),
        timeoutMs,
        ...(operation === undefined || operation === null
          ? {}
          : { signal: operation.signal }),
      });
    } catch (error) {
      if (operation?.signal.aborted && error instanceof ManagedProcessError && error.code === "PROCESS_ABORTED") {
        throw operation.signal.reason;
      }
      throw stableError(error);
    }
    if (!result || result.exitCode !== 0) {
      throw actionError("GITHUB_REJECTED");
    }
    return result;
  }

  #buildChildEnvironment(token, environment, networkEnv) {
    if (typeof token !== "string" || !GITHUB_TOKEN.test(token)) {
      throw actionError("GITHUB_CREDENTIAL_OUTPUT_INVALID", "absent");
    }
    const childEnv = {
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    };
    for (const key of CHILD_ENV_KEYS) {
      if (typeof environment?.[key] === "string") {
        childEnv[key] = environment[key];
      }
    }
    return Object.freeze({ ...childEnv, ...networkEnv });
  }
}

export function markerForGitHubAction(input) {
  return markerForEnvelope(
    normalizeEnvelope(input, { allowLegacyWorkProposal: true }),
  );
}

export function createGitHubActionExecutor(options) {
  const adapter = new GitHubActionAdapter(options);
  return Object.freeze({
    execute: (input) => adapter.execute(input),
    reconcile: (input) => adapter.reconcile(input),
    assignAssignee: (input, options) => adapter.assignAssignee(input, options),
    assignReviewOutcome: (input, options) => adapter.assignReviewOutcome(input, options),
    close: () => adapter.close(),
  });
}
