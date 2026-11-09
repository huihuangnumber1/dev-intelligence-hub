import path from "node:path";
import { isHeadRepairExecutionSource } from "../domain/code-execution-source.js";
import { currentPullRequestTargetArgs, githubCurrentPullRequestGitTarget, projectGitHubCurrentPullRequestTarget } from "./github-current-pull-request-target.js";
import { types as utilTypes } from "node:util";

import { normalizeControlledCommitEvidence } from "../domain/controlled-commit-evidence.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import {
  ManagedProcess,
  ManagedProcessError,
  ManagedProcessRunner,
} from "../lib/managed-process.js";
import { PullRequestExternalActionTransportError } from "../services/pull-request-external-action-executor.js";

const GITHUB_HOST = "github.com";
const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ACCEPT = "application/vnd.github+json";
const ACTION_TYPES = new Set([
  "comment",
  "review",
  "update_branch",
  "push",
  "merge",
]);
const ACTION_TYPE_NAMES = Object.freeze({
  comment: "pull_request_comment",
  review: "pull_request_review",
  update_branch: "pull_request_update_branch",
  push: "pull_request_push",
  merge: "pull_request_merge",
});
const REVIEW_STATES = Object.freeze({
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
});
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MARKER = /^<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u;
const CREDENTIAL = /^[^\s\u0000-\u001f\u007f]{1,4096}$/u;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
]);
const NETWORK_ENVIRONMENT_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
const MAX_API_PAGES = 10;
const API_PAGE_SIZE = 100;
const MAX_MARKER_RECORDS = 10;
const MAX_PASSIVE_NODES = 100_000;
const MAX_PASSIVE_BYTES = 16 * 1024 * 1024;

function transportError(code, trust = "unknown") {
  return new PullRequestExternalActionTransportError(code, trust);
}

function errorAtTrust(error, trust, fallbackCode = "GITHUB_PROTOCOL_ERROR") {
  if (error instanceof PullRequestExternalActionTransportError) {
    return transportError(
      error.code,
      error.trust === "unknown" ? "unknown" : trust,
    );
  }
  return transportError(fallbackCode, trust);
}

function exactObject(value, expectedKeys, code = "GITHUB_PROTOCOL_ERROR") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw transportError(code, "absent");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" || !descriptor?.enumerable ||
        !("value" in descriptor);
    })
  ) {
    throw transportError(code, "absent");
  }
  return value;
}

function assertPassiveData(root, code = "GITHUB_PROTOCOL_ERROR") {
  const seen = new WeakSet();
  const pending = [root];
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > MAX_PASSIVE_NODES) throw transportError(code, "absent");
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > MAX_PASSIVE_BYTES) throw transportError(code, "absent");
      continue;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      continue;
    }
    if (typeof value !== "object" || utilTypes.isProxy(value)) {
      throw transportError(code, "absent");
    }
    if (seen.has(value)) throw transportError(code, "absent");
    seen.add(value);
    const isArray = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !==
        (isArray ? Array.prototype : Object.prototype)
    ) {
      throw transportError(code, "absent");
    }
    const keys = Reflect.ownKeys(value);
    if (isArray) {
      if (
        value.length > MAX_PASSIVE_NODES ||
        keys.length !== value.length + 1 ||
        keys.some((key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= value.length)
        )
      ) {
        throw transportError(code, "absent");
      }
    } else if (keys.length > 256) {
      throw transportError(code, "absent");
    }
    for (const key of keys) {
      if (key === "length" && isArray) continue;
      if (typeof key !== "string") throw transportError(code, "absent");
      bytes += Buffer.byteLength(key, "utf8");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw transportError(code, "absent");
      }
      pending.push(descriptor.value);
    }
    if (bytes > MAX_PASSIVE_BYTES) throw transportError(code, "absent");
  }
}

function boundedString(value, pattern, maximumBytes, code) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw transportError(code, "absent");
  }
  return value;
}

function githubLogin(value, code = "GITHUB_PROTOCOL_ERROR") {
  const login = boundedString(value, GITHUB_LOGIN, 39, code);
  if (login.includes("--")) throw transportError(code, "absent");
  return login;
}

function repositoryName(value, code = "GITHUB_PROTOCOL_ERROR") {
  const repository = boundedString(value, REPOSITORY, 140, code);
  const [, owner, name] = repository.match(REPOSITORY);
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw transportError(code, "absent");
  }
  return repository;
}

function gitOid(value, expectedLength = null) {
  const oid = boundedString(value, GIT_OID, 64, "GITHUB_PROTOCOL_ERROR");
  if (expectedLength !== null && oid.length !== expectedLength) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  return oid;
}

function actionBody(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 8 * 1024
  ) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  return value;
}

function normalizeBinding(value, input) {
  let binding;
  try {
    binding = normalizePullRequestExecutionBinding(
      value,
      transportError("GITHUB_PROTOCOL_ERROR", "absent"),
    );
  } catch {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  if (
    binding.schemaVersion !== 2 ||
    binding.repository !== input.repository ||
    binding.pullRequestNumber !== input.pullRequestNumber ||
    binding.gitTarget.sourceAccountId.toLowerCase() !==
      input.actorAccountId.toLowerCase()
  ) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  return binding;
}

function normalizeAction(value, input) {
  const expectedType = ACTION_TYPE_NAMES[input.actionType];
  if (value?.type !== expectedType) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  if (input.actionType === "comment") {
    exactObject(value, ["type", "body", "inputBinding"]);
    return Object.freeze({
      type: expectedType,
      body: actionBody(value.body),
      inputBinding: normalizeBinding(value.inputBinding, input),
    });
  }
  if (input.actionType === "review") {
    exactObject(value, ["type", "reviewEvent", "body", "inputBinding"]);
    if (!Object.hasOwn(REVIEW_STATES, value.reviewEvent)) {
      throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
    }
    return Object.freeze({
      type: expectedType,
      reviewEvent: value.reviewEvent,
      body: actionBody(value.body),
      inputBinding: normalizeBinding(value.inputBinding, input),
    });
  }
  if (input.actionType === "update_branch") {
    exactObject(value, [
      "type",
      "expectedHeadOid",
      "expectedBaseOid",
      "inputBinding",
    ]);
    const binding = normalizeBinding(value.inputBinding, input);
    const expectedHeadOid = gitOid(value.expectedHeadOid);
    const expectedBaseOid = gitOid(value.expectedBaseOid, expectedHeadOid.length);
    if (
      expectedHeadOid !== binding.gitTarget.headRefOid ||
      expectedBaseOid !== binding.gitTarget.baseRefOid
    ) {
      throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
    }
    return Object.freeze({
      type: expectedType,
      expectedHeadOid,
      expectedBaseOid,
      inputBinding: binding,
    });
  }
  if (input.actionType === "push") {
    exactObject(value, [
      "type",
      "expectedOldOid",
      "remote",
      "controlledCommitEvidence",
      "inputBinding",
    ]);
    exactObject(value.remote, ["repository", "refName"]);
    const binding = normalizeBinding(value.inputBinding, input);
    let evidence;
    try {
      evidence = normalizeControlledCommitEvidence(value.controlledCommitEvidence);
    } catch {
      throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
    }
    const expectedOldOid = gitOid(value.expectedOldOid);
    const remote = Object.freeze({
      repository: repositoryName(value.remote.repository),
      refName: boundedString(
        value.remote.refName,
        null,
        255,
        "GITHUB_PROTOCOL_ERROR",
      ),
    });
    const target = binding.gitTarget;
    if (
      expectedOldOid !== target.headRefOid ||
      remote.repository !== target.headRepository ||
      remote.refName !== target.headRefName ||
      !samePullRequestExecutionBinding(
        evidence.executionSource.inputBinding,
        binding,
      ) ||
      evidence.commit.parents[0] !== target.headRefOid ||
      (!isHeadRepairExecutionSource(evidence.executionSource) &&
        evidence.commit.parents[1] !== target.baseRefOid)
    ) {
      throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
    }
    return Object.freeze({
      type: expectedType,
      expectedOldOid,
      remote,
      controlledCommitEvidence: evidence,
      inputBinding: binding,
    });
  }
  exactObject(value, ["type", "method", "expectedHeadOid", "inputBinding"]);
  if (!MERGE_METHODS.has(value.method)) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  const binding = normalizeBinding(value.inputBinding, input);
  const expectedHeadOid = gitOid(value.expectedHeadOid);
  if (expectedHeadOid !== binding.gitTarget.headRefOid) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  return Object.freeze({
    type: expectedType,
    method: value.method,
    expectedHeadOid,
    inputBinding: binding,
  });
}

function normalizeTransportInput(value) {
  assertPassiveData(value);
  exactObject(value, [
    "credential",
    "actorAccountId",
    "repository",
    "pullRequestNumber",
    "actionType",
    "marker",
    "action",
  ]);
  const input = {
    credential: boundedString(
      value.credential,
      CREDENTIAL,
      4_096,
      "GITHUB_CREDENTIAL_MISSING",
    ),
    actorAccountId: githubLogin(value.actorAccountId),
    repository: repositoryName(value.repository),
    pullRequestNumber: value.pullRequestNumber,
    actionType: value.actionType,
    marker: boundedString(
      value.marker,
      MARKER,
      128,
      "GITHUB_PROTOCOL_ERROR",
    ),
  };
  if (
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1 ||
    !ACTION_TYPES.has(input.actionType)
  ) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  input.action = normalizeAction(value.action, input);
  return Object.freeze(input);
}

function normalizeOperation(value, clock, timeoutMs) {
  if (value === undefined) {
    return Object.freeze({ signal: null, deadline: clock() + timeoutMs });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  ) {
    throw new TypeError("operation is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("signal") ||
    !keys.includes("deadline") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value");
    }) ||
    !(value.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(value.deadline) ||
    value.deadline < 1
  ) {
    throw new TypeError("operation is invalid");
  }
  return value;
}

function normalizeNetworkEnvironment(value) {
  if (value === undefined) return Object.freeze({});
  assertPassiveData(value);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("networkEnv must be a passive plain object");
  }
  const environment = {};
  for (const key of Reflect.ownKeys(value)) {
    const entry = value[key];
    if (
      typeof key !== "string" ||
      !NETWORK_ENVIRONMENT_KEYS.has(key) ||
      typeof entry !== "string" ||
      INVALID_CONTROL.test(entry) ||
      Buffer.byteLength(entry, "utf8") > 4_096
    ) {
      throw new TypeError("networkEnv contains an unsupported value");
    }
    environment[key] = entry;
  }
  return Object.freeze(environment);
}

function normalizeBaseEnvironment(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value)
  ) {
    throw new TypeError("env must be a passive environment object");
  }
  const environment = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      INVALID_CONTROL.test(descriptor.value) ||
      Buffer.byteLength(descriptor.value, "utf8") > 4_096
    ) {
      throw new TypeError("env contains an active or invalid value");
    }
    environment[key] = descriptor.value;
  }
  return Object.freeze(environment);
}

function normalizeTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
  }
  return new Date(value).toISOString();
}

function positiveIdentifier(value) {
  if (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^[1-9][0-9]*$/u.test(value))
  ) {
    return String(value);
  }
  throw transportError("GITHUB_PROTOCOL_ERROR", "absent");
}

function canonicalPullRequestUrl(repository, number) {
  return `${GITHUB_ORIGIN}/${repository}/pull/${number}`;
}

function canonicalPullRequestApiUrl(repository, number) {
  return `https://api.github.com/repos/${repository}/pulls/${number}`;
}

function isDocumentedUpdateBranchUrl(value, repository, number) {
  if (typeof value !== "string") return false;
  const documentedUrls = [
    canonicalPullRequestApiUrl(repository, number),
    `${GITHUB_ORIGIN}/repos/${repository}/pulls/${number}`,
  ];
  return documentedUrls.some((candidate) =>
    candidate.toLowerCase() === value.toLowerCase()
  );
}

function markerReceipt(record, input, fragmentPrefix, timestampField) {
  const id = positiveIdentifier(record.id);
  if (typeof record.html_url !== "string") {
    throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
  }
  let url;
  try {
    url = new URL(record.html_url);
  } catch {
    throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
  }
  const expectedUrl = canonicalPullRequestUrl(
    input.repository,
    input.pullRequestNumber,
  );
  if (
    url.origin !== GITHUB_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    `${url.origin}${url.pathname}`.toLowerCase() !== expectedUrl.toLowerCase() ||
    url.hash !== `#${fragmentPrefix}-${id}`
  ) {
    throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
  }
  return Object.freeze({
    id,
    url: expectedUrl,
    createdAt: normalizeTimestamp(record[timestampField]),
  });
}

function mergeProofBody(input, mergeCommitOid) {
  const proof = JSON.stringify({
    schemaVersion: 1,
    actorAccountId: input.actorAccountId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadOid: input.action.expectedHeadOid,
    method: input.action.method,
    mergeCommitOid,
  });
  return `MyDashboard controlled merge proof\n\n${input.marker}\n\n${proof}`;
}

function expectedReviewEvent(input) {
  return input.actionType === "comment" ? "COMMENT" : input.action.reviewEvent;
}

function processFailureCode(error) {
  if (!(error instanceof ManagedProcessError)) return "GITHUB_UNAVAILABLE";
  return {
    PROCESS_TIMEOUT: "GITHUB_TIMEOUT",
    PROCESS_OUTPUT_LIMIT: "GITHUB_OUTPUT_LIMIT",
    PROCESS_ABORTED: "GITHUB_UNAVAILABLE",
  }[error.code] ?? "GITHUB_UNAVAILABLE";
}

function publisherPort(value) {
  if (value === undefined) return null;
  if (!value || typeof value.publish !== "function") {
    throw new TypeError("controlledCommitPublisher must provide publish");
  }
  return Object.freeze({ publish: value.publish.bind(value) });
}

function normalizePublisherResult(value) {
  assertPassiveData(value, "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR");
  if (value?.status === "stale") {
    exactObject(value, ["status"], "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR");
    return Object.freeze({ status: "stale" });
  }
  if (value?.status === "unknown") {
    exactObject(
      value,
      ["status", "code"],
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
    );
    const code = boundedString(
      value.code,
      /^[A-Z][A-Z0-9_]{2,63}$/u,
      64,
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
    );
    return Object.freeze({ status: "unknown", code });
  }
  if (value?.status === "applied" || value?.status === "already") {
    exactObject(
      value,
      ["status", "receipt"],
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
    );
    exactObject(
      value.receipt,
      ["id"],
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
    );
    return Object.freeze({
      status: value.status,
      receipt: Object.freeze({
        id: gitOid(value.receipt.id),
      }),
    });
  }
  throw transportError("CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR", "unknown");
}

class GitHubPullRequestActionTransport {
  #runner;
  #ghCommand;
  #baseEnvironment;
  #networkEnvironment;
  #timeoutMs;
  #controlledCommitPublisher;
  #updatePollAttempts;
  #updatePollIntervalMs;
  #delay;
  #clock;

  constructor({
    runner = new ManagedProcessRunner({
      managedProcessFactory: () =>
        new ManagedProcess({
          maxLineBytes: 2 * 1024 * 1024,
          maxOutputBytes: 4 * 1024 * 1024,
        }),
    }),
    ghCommand,
    env = process.env,
    networkEnv,
    timeoutMs = 60_000,
    controlledCommitPublisher,
    updatePollAttempts = 8,
    updatePollIntervalMs = 250,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    clock = () => Date.now(),
  } = {}) {
    if (!runner || typeof runner.run !== "function") {
      throw new TypeError("runner must provide run");
    }
    if (
      typeof ghCommand !== "string" ||
      !path.isAbsolute(ghCommand) ||
      INVALID_CONTROL.test(ghCommand) ||
      Buffer.byteLength(ghCommand, "utf8") > 1_024
    ) {
      throw new TypeError("ghCommand must be a fixed absolute executable path");
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 600_000
    ) {
      throw new TypeError("timeoutMs is outside the supported range");
    }
    if (
      !Number.isSafeInteger(updatePollAttempts) ||
      updatePollAttempts < 1 ||
      updatePollAttempts > 20 ||
      !Number.isSafeInteger(updatePollIntervalMs) ||
      updatePollIntervalMs < 0 ||
      updatePollIntervalMs > 5_000 ||
      typeof delay !== "function"
    ) {
      throw new TypeError("update-branch polling configuration is invalid");
    }
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#runner = Object.freeze({ run: runner.run.bind(runner) });
    this.#ghCommand = ghCommand;
    this.#baseEnvironment = normalizeBaseEnvironment(env);
    this.#networkEnvironment = normalizeNetworkEnvironment(networkEnv);
    this.#timeoutMs = timeoutMs;
    this.#controlledCommitPublisher = publisherPort(controlledCommitPublisher);
    this.#updatePollAttempts = updatePollAttempts;
    this.#updatePollIntervalMs = updatePollIntervalMs;
    this.#delay = delay;
    this.#clock = clock;
    Object.freeze(this);
  }

  async observe(value, rawOperation) {
    const input = normalizeTransportInput(value);
    const operation = normalizeOperation(rawOperation, this.#clock, this.#timeoutMs);
    const environment = this.#childEnvironment(input.credential);
    const actorAccountId = await this.#assertActor(
      input,
      environment,
      "absent",
      operation,
    );
    const facts = await this.#readPullRequest(
      input,
      environment,
      "absent",
      operation,
    );
    const actionEvidence = await this.#actionEvidence(
      input,
      facts,
      environment,
      "absent",
      operation,
    );
    return Object.freeze({
      schemaVersion: 1,
      actorAccountId,
      gitTarget: facts.gitTarget,
      state: facts.state,
      actionEvidence,
    });
  }

  async perform(value, rawOperation) {
    const input = normalizeTransportInput(value);
    const operation = normalizeOperation(rawOperation, this.#clock, this.#timeoutMs);
    const environment = this.#childEnvironment(input.credential);
    await this.#assertActor(input, environment, "absent", operation);
    const facts = await this.#readPullRequest(
      input,
      environment,
      "absent",
      operation,
    );
    if (
      facts.state !== "open" ||
      !samePullRequestGitTarget(
        input.action.inputBinding.gitTarget,
        facts.gitTarget,
      )
    ) {
      throw transportError("GITHUB_TARGET_STALE", "absent");
    }
    if (
      input.actionType === "review" &&
      input.action.reviewEvent !== "COMMENT" &&
      facts.authorAccountId.toLowerCase() === input.actorAccountId.toLowerCase()
    ) {
      throw transportError("GITHUB_SELF_REVIEW_UNSUPPORTED", "absent");
    }
    if (input.actionType === "comment") {
      await this.#postReview(input, environment, operation);
    } else if (input.actionType === "review") {
      await this.#postReview(input, environment, operation);
    } else if (input.actionType === "update_branch") {
      await this.#updateBranch(input, environment, operation);
    } else if (input.actionType === "push") {
      await this.#publishControlledCommit(input, operation);
    } else {
      await this.#merge(input, environment, operation);
    }
    return Object.freeze({ accepted: true });
  }

  #childEnvironment(credential) {
    return Object.freeze({
      ...this.#baseEnvironment,
      ...this.#networkEnvironment,
      GH_TOKEN: credential,
      GH_HOST: GITHUB_HOST,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
    });
  }

  async #assertActor(input, environment, trust, operation) {
    const record = await this.#runJson(
      ["api", "--method", "GET", "user"],
      { environment, trust, operation },
    );
    const login = githubLogin(record?.login);
    if (login.toLowerCase() !== input.actorAccountId.toLowerCase()) {
      throw transportError("GITHUB_ACTOR_MISMATCH", trust);
    }
    return login;
  }

  async #readPullRequest(input, environment, trust, operation) {
    const identity = { repository: input.repository, number: input.pullRequestNumber, sourceAccountId: input.actorAccountId };
    const args = currentPullRequestTargetArgs(identity);
    const response = await this.#runJson(
      ["api", "--method", "POST", ...args.slice(3)],
      { environment, trust, operation },
    );
    try {
      const observed = projectGitHubCurrentPullRequestTarget(response, identity);
      const pr = response.data.repository.pullRequest;
      // Receipt reconciliation can inspect an already terminal PR whose head
      // branch was deleted. The base must still be live; perform rejects this
      // terminal state before considering any mutation.
      const observedGit = observed.gitTarget ?? githubCurrentPullRequestGitTarget(pr, {
        baseRepository: input.repository, sourceAccountId: input.actorAccountId, terminal: true,
      });
      const record = {
        number: observed.number, html_url: observed.url, state: observed.state === "OPEN" ? "open" : "closed",
        user: { login: observed.authorAccountId }, merged_at: pr.mergedAt,
        merge_commit_sha: pr.mergeCommit?.oid ?? null, merged_by: pr.mergedBy,
        base: { ref: observedGit.baseRefName, sha: observedGit.baseRefOid, repo: { full_name: observedGit.baseRepository } },
        head: { ref: observedGit.headRefName, sha: observedGit.headRefOid, repo: { full_name: observedGit.headRepository } },
      };
      const number = record?.number;
      const url = record?.html_url;
      const expectedUrl = canonicalPullRequestUrl(
        input.repository,
        input.pullRequestNumber,
      );
      const state = record?.state;
      const authorAccountId = githubLogin(record?.user?.login);
      if (
        number !== input.pullRequestNumber ||
        typeof url !== "string" ||
        url.toLowerCase() !== expectedUrl.toLowerCase() ||
        !["open", "closed"].includes(state)
      ) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      const baseRepository = repositoryName(record?.base?.repo?.full_name);
      const headRepository = repositoryName(record?.head?.repo?.full_name);
      if (baseRepository.toLowerCase() !== input.repository.toLowerCase()) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      const baseRefName = boundedString(
        record?.base?.ref,
        null,
        255,
        "GITHUB_PROTOCOL_ERROR",
      );
      const headRefName = boundedString(
        record?.head?.ref,
        null,
        255,
        "GITHUB_PROTOCOL_ERROR",
      );
      if (
        !baseRefName ||
        !headRefName ||
        INVALID_CONTROL.test(baseRefName) ||
        INVALID_CONTROL.test(headRefName)
      ) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      const baseRefOid = gitOid(record?.base?.sha);
      const headRefOid = gitOid(record?.head?.sha, baseRefOid.length);
      const mergedAt = record?.merged_at === null
        ? null
        : normalizeTimestamp(record?.merged_at);
      if (state === "open" && mergedAt !== null) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      const normalizedState = mergedAt === null ? state : "merged";
      let mergeCommitOid = null;
      let mergedBy = null;
      if (normalizedState === "merged") {
        mergeCommitOid = gitOid(record?.merge_commit_sha, headRefOid.length);
        mergedBy = githubLogin(record?.merged_by?.login);
      }
      let gitTarget;
      try {
        gitTarget = normalizePullRequestGitTarget({
          schemaVersion: 1,
          provider: "github",
          sourceAccountId: input.actorAccountId,
          baseRepository,
          baseRefName,
          baseRefOid,
          headRepository,
          headRefName,
          headRefOid,
        });
      } catch {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      return Object.freeze({
        state: normalizedState,
        authorAccountId,
        gitTarget,
        mergedAt,
        mergeCommitOid,
        mergedBy,
      });
    } catch (error) {
      throw errorAtTrust(error, trust);
    }
  }

  async #actionEvidence(input, facts, environment, trust, operation) {
    if (input.actionType === "comment") {
      return Object.freeze({
        kind: "marker_records",
        records: await this.#reviewMarkerRecords(
          input,
          environment,
          trust,
          operation,
        ),
      });
    }
    if (input.actionType === "review") {
      return Object.freeze({
        kind: "marker_records",
        records: await this.#reviewMarkerRecords(
          input,
          environment,
          trust,
          operation,
        ),
      });
    }
    if (input.actionType === "update_branch") {
      return Object.freeze({
        kind: "head_commit",
        commit: await this.#updatedHeadCommit(
          input,
          facts,
          environment,
          trust,
          operation,
        ),
      });
    }
    if (input.actionType === "push") {
      return Object.freeze({ kind: "head_ref" });
    }
    return Object.freeze({
      kind: "merge_state",
      merge: await this.#mergeEvidence(
        input,
        facts,
        environment,
        trust,
        operation,
      ),
    });
  }

  async #pages(endpoint, environment, trust, operation) {
    const records = [];
    for (let page = 1; page <= MAX_API_PAGES; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const value = await this.#runJson(
        [
          "api",
          "--method",
          "GET",
          `${endpoint}${separator}per_page=${API_PAGE_SIZE}&page=${page}`,
        ],
        { environment, trust, operation },
      );
      if (!Array.isArray(value) || value.length > API_PAGE_SIZE) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      records.push(...value);
      if (value.length < API_PAGE_SIZE) return records;
    }
    throw transportError("GITHUB_PAGINATION_LIMIT", trust);
  }

  async #reviewMarkerRecords(input, environment, trust, operation) {
    const records = await this.#pages(
      `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews`,
      environment,
      trust,
      operation,
    );
    const candidates = records.filter(
      (record) =>
        typeof record?.body === "string" && record.body.includes(input.marker),
    );
    if (candidates.length > MAX_MARKER_RECORDS) {
      throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
    }
    const expectedBody = `${input.action.body}\n\n${input.marker}`;
    const reviewEvent = expectedReviewEvent(input);
    try {
      return Object.freeze(candidates.map((record) => {
        const actorAccountId = githubLogin(record?.user?.login);
        if (
          record.body !== expectedBody ||
          actorAccountId.toLowerCase() !== input.actorAccountId.toLowerCase() ||
          record.state !== REVIEW_STATES[reviewEvent] ||
          record.commit_id !== input.action.inputBinding.gitTarget.headRefOid
        ) {
          throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
        }
        return Object.freeze({
          marker: input.marker,
          actorAccountId,
          body: input.action.body,
          reviewEvent,
          headOid: record.commit_id,
          receipt: markerReceipt(
            record,
            input,
            "pullrequestreview",
            "submitted_at",
          ),
        });
      }));
    } catch {
      throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
    }
  }

  async #updatedHeadCommit(input, facts, environment, trust, operation) {
    if (facts.gitTarget.headRefOid === input.action.expectedHeadOid) return null;
    const record = await this.#runJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${facts.gitTarget.headRepository}/git/commits/${facts.gitTarget.headRefOid}`,
      ],
      { environment, trust, operation },
    );
    try {
      if (record?.sha !== facts.gitTarget.headRefOid || !Array.isArray(record?.parents)) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      if (record.parents.length !== 2) return null;
      const parents = record.parents.map((parent) =>
        gitOid(parent?.sha, facts.gitTarget.headRefOid.length)
      );
      const expectedUrl =
        `${GITHUB_ORIGIN}/${facts.gitTarget.headRepository}/commit/${facts.gitTarget.headRefOid}`;
      if (
        typeof record.html_url !== "string" ||
        record.html_url.toLowerCase() !== expectedUrl.toLowerCase()
      ) {
        throw transportError("GITHUB_PROTOCOL_ERROR", trust);
      }
      return Object.freeze({
        oid: facts.gitTarget.headRefOid,
        parents: Object.freeze(parents),
        receipt: Object.freeze({
          id: facts.gitTarget.headRefOid,
          url: expectedUrl,
          createdAt: normalizeTimestamp(record?.committer?.date),
        }),
      });
    } catch (error) {
      throw errorAtTrust(error, trust);
    }
  }

  async #mergeEvidence(input, facts, environment, trust, operation) {
    if (facts.state !== "merged") return null;
    const records = await this.#pages(
      `repos/${input.repository}/issues/${input.pullRequestNumber}/comments`,
      environment,
      trust,
      operation,
    );
    const candidates = records.filter(
      (record) =>
        typeof record?.body === "string" && record.body.includes(input.marker),
    );
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
    }
    try {
      const record = candidates[0];
      const actorAccountId = githubLogin(record?.user?.login);
      if (
        record.body !== mergeProofBody(input, facts.mergeCommitOid) ||
        actorAccountId.toLowerCase() !== input.actorAccountId.toLowerCase() ||
        facts.mergedBy.toLowerCase() !== input.actorAccountId.toLowerCase() ||
        facts.gitTarget.headRefOid !== input.action.expectedHeadOid
      ) {
        throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
      }
      markerReceipt(record, input, "issuecomment", "created_at");
      return Object.freeze({
        marker: input.marker,
        actorAccountId,
        expectedHeadOid: input.action.expectedHeadOid,
        method: input.action.method,
        receipt: Object.freeze({
          id: facts.mergeCommitOid,
          url: canonicalPullRequestUrl(
            input.repository,
            input.pullRequestNumber,
          ),
          createdAt: facts.mergedAt,
        }),
      });
    } catch {
      throw transportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown");
    }
  }

  async #postReview(input, environment, operation) {
    const body = `${input.action.body}\n\n${input.marker}`;
    const reviewEvent = expectedReviewEvent(input);
    const record = await this.#runJson(
      [
        "api",
        "--method",
        "POST",
        `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews`,
        "--input",
        "-",
      ],
      {
        environment,
        input: JSON.stringify({
          event: reviewEvent,
          body,
          commit_id: input.action.inputBinding.gitTarget.headRefOid,
        }),
        trust: "unknown",
        operation,
      },
    );
    try {
      if (
        record?.body !== body ||
        record?.state !== REVIEW_STATES[reviewEvent] ||
        record?.commit_id !== input.action.inputBinding.gitTarget.headRefOid ||
        githubLogin(record?.user?.login).toLowerCase() !==
          input.actorAccountId.toLowerCase()
      ) {
        throw transportError("GITHUB_PROTOCOL_ERROR", "unknown");
      }
      markerReceipt(record, input, "pullrequestreview", "submitted_at");
    } catch (error) {
      throw errorAtTrust(error, "unknown");
    }
  }

  async #updateBranch(input, environment, operation) {
    const response = await this.#runJson(
      [
        "api",
        "--method",
        "PUT",
        `repos/${input.repository}/pulls/${input.pullRequestNumber}/update-branch`,
        "--input",
        "-",
      ],
      {
        environment,
        input: JSON.stringify({ expected_head_sha: input.action.expectedHeadOid }),
        trust: "unknown",
        operation,
      },
    );
    if (
      typeof response?.message !== "string" ||
      response.message.length === 0 ||
      !isDocumentedUpdateBranchUrl(
        response.url,
        input.repository,
        input.pullRequestNumber,
      )
    ) {
      throw transportError("GITHUB_PROTOCOL_ERROR", "unknown");
    }
    for (let attempt = 1; attempt <= this.#updatePollAttempts; attempt += 1) {
      const facts = await this.#readPullRequest(
        input,
        environment,
        "unknown",
        operation,
      );
      if (facts.gitTarget.headRefOid !== input.action.expectedHeadOid) {
        const commit = await this.#updatedHeadCommit(
          input,
          facts,
          environment,
          "unknown",
          operation,
        );
        if (
          facts.state === "open" &&
          commit !== null &&
          commit.parents[0] === input.action.expectedHeadOid &&
          commit.parents[1] === input.action.expectedBaseOid
        ) {
          return;
        }
        throw transportError("GITHUB_UPDATE_BRANCH_OUTCOME_UNKNOWN", "unknown");
      }
      if (attempt < this.#updatePollAttempts) {
        this.#assertOperationCurrent(operation, "unknown");
        try {
          await this.#delay(this.#updatePollIntervalMs);
        } catch {
          throw transportError("GITHUB_UPDATE_BRANCH_OUTCOME_UNKNOWN", "unknown");
        }
        this.#assertOperationCurrent(operation, "unknown");
      }
    }
    throw transportError("GITHUB_UPDATE_BRANCH_OUTCOME_UNKNOWN", "unknown");
  }

  async #publishControlledCommit(input, operation) {
    if (this.#controlledCommitPublisher === null) {
      throw transportError("CONTROLLED_COMMIT_PUBLISHER_UNAVAILABLE", "absent");
    }
    let rawResult;
    try {
      rawResult = await this.#controlledCommitPublisher.publish({
        credential: input.credential,
        actorAccountId: input.actorAccountId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        marker: input.marker,
        action: structuredClone(input.action),
      }, operation);
    } catch {
      throw transportError("CONTROLLED_GIT_PUBLISH_OUTCOME_UNKNOWN", "unknown");
    }
    let result;
    try {
      result = normalizePublisherResult(rawResult);
    } catch {
      throw transportError("CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR", "unknown");
    }
    if (result.status === "stale") {
      throw transportError("GITHUB_PUSH_STALE", "absent");
    }
    if (result.status === "unknown") {
      throw transportError(result.code, "unknown");
    }
    if (
      result.receipt.id !== input.action.controlledCommitEvidence.commit.oid
    ) {
      throw transportError("CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR", "unknown");
    }
  }

  async #merge(input, environment, operation) {
    const response = await this.#runJson(
      [
        "api",
        "--method",
        "PUT",
        `repos/${input.repository}/pulls/${input.pullRequestNumber}/merge`,
        "--input",
        "-",
      ],
      {
        environment,
        input: JSON.stringify({
          sha: input.action.expectedHeadOid,
          merge_method: input.action.method,
        }),
        trust: "unknown",
        operation,
      },
    );
    if (response?.merged !== true) {
      if (response?.merged === false && typeof response?.message === "string") {
        throw transportError("GITHUB_MERGE_REJECTED", "absent");
      }
      throw transportError("GITHUB_PROTOCOL_ERROR", "unknown");
    }
    let mergeCommitOid;
    try {
      mergeCommitOid = gitOid(
        response?.sha,
        input.action.expectedHeadOid.length,
      );
    } catch (error) {
      throw errorAtTrust(error, "unknown");
    }
    const body = mergeProofBody(input, mergeCommitOid);
    const proof = await this.#runJson(
      [
        "api",
        "--method",
        "POST",
        `repos/${input.repository}/issues/${input.pullRequestNumber}/comments`,
        "--input",
        "-",
      ],
      {
        environment,
        input: JSON.stringify({ body }),
        trust: "unknown",
        operation,
      },
    );
    try {
      if (
        proof?.body !== body ||
        githubLogin(proof?.user?.login).toLowerCase() !==
          input.actorAccountId.toLowerCase()
      ) {
        throw transportError("GITHUB_PROTOCOL_ERROR", "unknown");
      }
      markerReceipt(proof, input, "issuecomment", "created_at");
    } catch (error) {
      throw errorAtTrust(error, "unknown");
    }
  }

  #assertOperationCurrent(operation, trust) {
    if (operation.signal?.aborted) {
      throw transportError("GITHUB_UNAVAILABLE", trust);
    }
    if (this.#clock() >= operation.deadline) {
      throw transportError("GITHUB_TIMEOUT", trust);
    }
  }

  async #runJson(args, { environment, input, trust, operation }) {
    let result;
    try {
      this.#assertOperationCurrent(operation, trust);
      const timeoutMs = Math.min(this.#timeoutMs, operation.deadline - this.#clock());
      result = await this.#runner.run({
        command: this.#ghCommand,
        args: [
          "api",
          "--hostname",
          GITHUB_HOST,
          "--header",
          `Accept: ${GITHUB_ACCEPT}`,
          "--header",
          `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
          ...args.slice(1),
        ],
        env: { ...environment },
        ...(input === undefined ? {} : { input }),
        timeoutMs,
        ...(operation.signal === null ? {} : { signal: operation.signal }),
      });
    } catch (error) {
      throw transportError(processFailureCode(error), trust);
    }
    if (
      !result ||
      result.exitCode !== 0 ||
      typeof result.stdout !== "string"
    ) {
      throw transportError("GITHUB_REJECTED", trust);
    }
    let value;
    try {
      value = JSON.parse(result.stdout);
      assertPassiveData(value);
    } catch (error) {
      if (error instanceof PullRequestExternalActionTransportError) {
        throw transportError(error.code, trust);
      }
      throw transportError("GITHUB_PROTOCOL_ERROR", trust);
    }
    return value;
  }
}

export function createGitHubPullRequestActionTransport(options) {
  const transport = new GitHubPullRequestActionTransport(options);
  return Object.freeze({
    observe: (input, operation) => transport.observe(input, operation),
    perform: (input, operation) => transport.perform(input, operation),
  });
}
