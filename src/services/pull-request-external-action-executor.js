import { types as utilTypes } from "node:util";
import { isHeadRepairExecutionSource } from "../domain/code-execution-source.js";

import { normalizeConfirmationReceipt } from "../domain/confirmation-contract.js";
import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import {
  normalizePullRequestExternalActionEnvelope,
  pullRequestExternalActionMarker,
  samePullRequestExternalControlledEvidence,
} from "../domain/pull-request-external-action.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import {
  GitHubCredentialSourceError,
} from "../lib/github-credential-source.js";

const ACTION_NAMES = Object.freeze({
  pull_request_comment: "comment",
  pull_request_review: "review",
  pull_request_update_branch: "update_branch",
  pull_request_push: "push",
  pull_request_merge: "merge",
});
const ALL_ACTIONS = new Set(Object.values(ACTION_NAMES));
const STATES = new Set(["open", "closed", "merged"]);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const CREDENTIAL = /^[^\s\u0000-\u001f\u007f]{1,4096}$/u;
const MARKER = /^<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/u;
const REVIEW_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

export class PullRequestExternalActionTransportError extends Error {
  constructor(code = "GITHUB_UNAVAILABLE", trust = "unknown", options) {
    if (!STABLE_CODE.test(code) || !["absent", "unknown"].includes(trust)) {
      throw new TypeError("external action transport error is invalid");
    }
    super(code, options);
    this.name = "PullRequestExternalActionTransportError";
    this.code = code;
    this.trust = trust;
  }
}

function exact(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key)) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" || !descriptor?.enumerable ||
        !("value" in descriptor);
    })
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return value;
}

function denseArray(value, maximum, name) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return value;
}

function githubLogin(value) {
  if (
    typeof value !== "string" ||
    !GITHUB_LOGIN.test(value) ||
    value.includes("--")
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return value;
}

function gitOid(value, length = null) {
  if (
    typeof value !== "string" ||
    !GIT_OID.test(value) ||
    (length !== null && value.length !== length)
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return value;
}

function normalizeReceipt(value) {
  try {
    return normalizeConfirmationReceipt(value);
  } catch (cause) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
      { cause },
    );
  }
}

function normalizeMarkerRecord(value, oidLength) {
  exact(
    value,
    [
      "marker",
      "actorAccountId",
      "body",
      "reviewEvent",
      "headOid",
      "receipt",
    ],
    "marker record",
  );
  if (
    typeof value.marker !== "string" ||
    !MARKER.test(value.marker) ||
    typeof value.body !== "string" ||
    !REVIEW_EVENTS.has(value.reviewEvent)
  ) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return {
    marker: value.marker,
    actorAccountId: githubLogin(value.actorAccountId),
    body: value.body,
    reviewEvent: value.reviewEvent,
    headOid: gitOid(value.headOid, oidLength),
    receipt: normalizeReceipt(value.receipt),
  };
}

function normalizeActionEvidence(value, envelope, oidLength) {
  const actionType = envelope.action.type;
  if (["pull_request_comment", "pull_request_review"].includes(actionType)) {
    exact(value, ["kind", "records"], "actionEvidence");
    if (value.kind !== "marker_records") {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_PROTOCOL_ERROR",
        "unknown",
      );
    }
    return {
      kind: "marker_records",
      records: denseArray(value.records, 10, "actionEvidence.records").map(
        (record) => normalizeMarkerRecord(record, oidLength),
      ),
    };
  }
  if (actionType === "pull_request_update_branch") {
    exact(value, ["kind", "commit"], "actionEvidence");
    if (value.kind !== "head_commit") {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_PROTOCOL_ERROR",
        "unknown",
      );
    }
    if (value.commit === null) return { kind: "head_commit", commit: null };
    exact(value.commit, ["oid", "parents", "receipt"], "actionEvidence.commit");
    const parents = denseArray(
      value.commit.parents,
      2,
      "actionEvidence.commit.parents",
    );
    if (parents.length !== 2) {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_PROTOCOL_ERROR",
        "unknown",
      );
    }
    return {
      kind: "head_commit",
      commit: {
        oid: gitOid(value.commit.oid, oidLength),
        parents: parents.map((parent) => gitOid(parent, oidLength)),
        receipt: normalizeReceipt(value.commit.receipt),
      },
    };
  }
  if (actionType === "pull_request_push") {
    exact(value, ["kind"], "actionEvidence");
    if (value.kind !== "head_ref") {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_PROTOCOL_ERROR",
        "unknown",
      );
    }
    return { kind: "head_ref" };
  }
  exact(value, ["kind", "merge"], "actionEvidence");
  if (value.kind !== "merge_state") {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  if (value.merge === null) return { kind: "merge_state", merge: null };
  exact(
    value.merge,
    ["marker", "actorAccountId", "expectedHeadOid", "method", "receipt"],
    "actionEvidence.merge",
  );
  if (typeof value.merge.marker !== "string" || !MARKER.test(value.merge.marker)) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  return {
    kind: "merge_state",
    merge: {
      marker: value.merge.marker,
      actorAccountId: githubLogin(value.merge.actorAccountId),
      expectedHeadOid: gitOid(value.merge.expectedHeadOid, oidLength),
      method: value.merge.method,
      receipt: normalizeReceipt(value.merge.receipt),
    },
  };
}

function normalizeObservation(value, envelope) {
  exact(
    value,
    ["schemaVersion", "actorAccountId", "gitTarget", "state", "actionEvidence"],
    "observation",
  );
  if (value.schemaVersion !== 1 || !STATES.has(value.state)) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
    );
  }
  let gitTarget;
  try {
    gitTarget = normalizePullRequestGitTarget(value.gitTarget);
  } catch (cause) {
    throw new PullRequestExternalActionTransportError(
      "GITHUB_PROTOCOL_ERROR",
      "unknown",
      { cause },
    );
  }
  return {
    schemaVersion: 1,
    actorAccountId: githubLogin(value.actorAccountId),
    gitTarget,
    state: value.state,
    actionEvidence: normalizeActionEvidence(
      value.actionEvidence,
      envelope,
      gitTarget.headRefOid.length,
    ),
  };
}

function normalizeEnabledActions(value = []) {
  const entries = denseArray(value, ALL_ACTIONS.size, "enabledActions");
  if (
    entries.some((entry) => !ALL_ACTIONS.has(entry)) ||
    new Set(entries).size !== entries.length
  ) {
    throw new TypeError("enabledActions is invalid");
  }
  return new Set(entries);
}

function port(value, methods, name, { optional = false } = {}) {
  if (optional && value === undefined) return null;
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function errorResult(error, forcedTrust = null) {
  const known = error instanceof PullRequestExternalActionTransportError;
  const credential = error instanceof GitHubCredentialSourceError;
  const credentialTrust = error?.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED"
    ? "unknown"
    : "absent";
  return {
    status: "error",
    error: {
      code: known || credential ? error.code : "GITHUB_UNAVAILABLE",
      trust: forcedTrust ?? (known
        ? error.trust
        : credential
          ? credentialTrust
          : "unknown"),
    },
  };
}

function exactCredentialPort(value) {
  const keys = value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value)
    ? []
    : Reflect.ownKeys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== "acquire" ||
    !Object.isFrozen(value) ||
    typeof Object.getOwnPropertyDescriptor(value, "acquire")?.value !==
      "function"
  ) {
    throw new TypeError("credentialSource is invalid");
  }
  return value;
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
    throw new PullRequestExternalActionTransportError(
      "GITHUB_CREDENTIAL_OUTPUT_INVALID",
      "absent",
    );
  }
  return value;
}

function sameTargetIdentity(left, right) {
  return [
    "provider",
    "sourceAccountId",
    "baseRepository",
    "baseRefName",
    "headRepository",
    "headRefName",
  ].every((key) => left[key] === right[key]);
}

function markerRecordResult(envelope, observation, marker) {
  const records = observation.actionEvidence.records;
  if (records.length === 0) return null;
  const expected = envelope.action;
  const reviewEvent = expected.type === "pull_request_comment"
    ? "COMMENT"
    : expected.reviewEvent;
  const matches = records.filter((record) =>
    record.marker === marker &&
    record.actorAccountId.toLowerCase() === envelope.actor.accountId.toLowerCase() &&
    record.body === expected.body &&
    record.reviewEvent === reviewEvent &&
    record.headOid === expected.inputBinding.gitTarget.headRefOid
  );
  if (records.length !== 1 || matches.length !== 1) {
    return errorResult(
      new PullRequestExternalActionTransportError(
        "GITHUB_COMPLETION_PROOF_CONFLICT",
        "unknown",
      ),
    );
  }
  return { status: "already", receipt: matches[0].receipt };
}

function updateBranchResult(envelope, observation) {
  const expected = envelope.action;
  const current = observation.gitTarget;
  if (!sameTargetIdentity(expected.inputBinding.gitTarget, current)) {
    return { status: "stale" };
  }
  if (current.headRefOid === expected.expectedHeadOid) {
    return current.baseRefOid === expected.expectedBaseOid &&
        observation.state === "open"
      ? { status: "absent", code: "GITHUB_UPDATE_BRANCH_ABSENT" }
      : { status: "stale" };
  }
  const commit = observation.actionEvidence.commit;
  if (
    observation.state === "open" &&
    commit !== null &&
    commit.oid === current.headRefOid &&
    commit.parents[0] === expected.expectedHeadOid &&
    commit.parents[1] === expected.expectedBaseOid
  ) {
    return { status: "already", receipt: commit.receipt };
  }
  return { status: "stale" };
}

function pushResult(envelope, observation) {
  const expected = envelope.action;
  const current = observation.gitTarget;
  if (!sameTargetIdentity(expected.inputBinding.gitTarget, current)) {
    return { status: "stale" };
  }
  if (current.headRefOid === expected.controlledCommitEvidence.commit.oid) {
    return {
      status: "already",
      receipt: { id: expected.controlledCommitEvidence.commit.oid },
    };
  }
  return observation.state === "open" &&
      samePullRequestGitTarget(expected.inputBinding.gitTarget, current)
    ? { status: "absent", code: "GITHUB_PUSH_ABSENT" }
    : { status: "stale" };
}

function mergeResult(envelope, observation, marker) {
  const expected = envelope.action;
  const current = observation.gitTarget;
  if (observation.state === "merged") {
    const merge = observation.actionEvidence.merge;
    if (
      merge !== null &&
      merge.marker === marker &&
      merge.actorAccountId.toLowerCase() === envelope.actor.accountId.toLowerCase() &&
      merge.expectedHeadOid === expected.expectedHeadOid &&
      merge.method === expected.method
    ) {
      return { status: "already", receipt: merge.receipt };
    }
    return errorResult(
      new PullRequestExternalActionTransportError(
        "GITHUB_COMPLETION_PROOF_CONFLICT",
        "unknown",
      ),
    );
  }
  return observation.state === "open" &&
      samePullRequestGitTarget(expected.inputBinding.gitTarget, current)
    ? { status: "absent", code: "GITHUB_MERGE_ABSENT" }
    : { status: "stale" };
}

function observationResult(envelope, observation, marker) {
  if (
    observation.actorAccountId.toLowerCase() !==
      envelope.actor.accountId.toLowerCase()
  ) {
    return { status: "stale" };
  }
  if (["pull_request_comment", "pull_request_review"].includes(
    envelope.action.type,
  )) {
    const completed = markerRecordResult(envelope, observation, marker);
    if (completed !== null) return completed;
    return observation.state === "open" &&
        samePullRequestGitTarget(
          envelope.action.inputBinding.gitTarget,
          observation.gitTarget,
        )
      ? { status: "absent", code: "GITHUB_MARKER_ABSENT" }
      : { status: "stale" };
  }
  if (envelope.action.type === "pull_request_update_branch") {
    return updateBranchResult(envelope, observation);
  }
  if (envelope.action.type === "pull_request_push") {
    return pushResult(envelope, observation);
  }
  return mergeResult(envelope, observation, marker);
}

class PullRequestExternalActionExecutor {
  #enabledActions;
  #credentialSource;
  #transport;
  #inputAuthorityVerifier;
  #controlledCommitVerifier;
  #reviewResultVerifier;
  #pushAuthorization;
  #clock;
  #timeoutMs;
  #activeOperations;
  #closed;

  constructor({
    enabledActions = [],
    credentialSource,
    transport,
    inputAuthorityVerifier,
    controlledCommitVerifier,
    reviewResultVerifier = null,
    pushAuthorization = null,
    clock = () => Date.now(),
    timeoutMs = 60_000,
  } = {}) {
    this.#enabledActions = normalizeEnabledActions(enabledActions);
    this.#reviewResultVerifier = reviewResultVerifier;
    this.#pushAuthorization = pushAuthorization;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 600_000
    ) {
      throw new TypeError("timeoutMs is outside the supported range");
    }
    this.#credentialSource = this.#enabledActions.size === 0
      ? null
      : exactCredentialPort(credentialSource);
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
    this.#activeOperations = new Set();
    this.#closed = false;
    if (this.#enabledActions.size === 0) {
      this.#transport = null;
      this.#inputAuthorityVerifier = null;
      this.#controlledCommitVerifier = null;
    } else {
      this.#transport = port(transport, ["observe", "perform"], "transport");
      this.#inputAuthorityVerifier = port(
        inputAuthorityVerifier,
        ["verify"],
        "inputAuthorityVerifier",
      );
      this.#controlledCommitVerifier = port(
        controlledCommitVerifier,
        ["verify"],
        "controlledCommitVerifier",
        { optional: true },
      );
    }
  }

  async execute(input) {
    let envelope;
    try {
      envelope = normalizePullRequestExternalActionEnvelope(input);
    } catch (error) {
      return errorResult(error);
    }
    if (!this.#isEnabled(envelope)) return { status: "stale" };
    const operation = this.#beginOperation(envelope);
    try {
      try {
        if (!(await this.#controlledCommitCurrent(
          envelope,
          "absent",
          operation,
        ))) {
          return { status: "stale" };
        }
      } catch (error) {
        return errorResult(error);
      }
      if (!(await this.#authorityCurrent(envelope, operation))) {
        return { status: "stale" };
      }
      if (envelope.action.publishedReviewReuse) return await this.#reuseReviewResult(envelope, operation);
      try {
        return await this.#withCredential(
          envelope,
          operation,
          async (credential) => {
            const marker = pullRequestExternalActionMarker(envelope);
            const first = await this.#observe(
              envelope,
              marker,
              credential,
              operation,
            );
            const firstResult = observationResult(envelope, first, marker);
            if (firstResult.status !== "absent") return firstResult;
            if (!(await this.#authorityCurrent(envelope, operation))) {
              return { status: "stale" };
            }
            const final = await this.#observe(
              envelope,
              marker,
              credential,
              operation,
            );
            const finalResult = observationResult(envelope, final, marker);
            if (finalResult.status !== "absent") return finalResult;
            if (!(await this.#authorityCurrent(envelope, operation))) {
              return { status: "stale" };
            }
            if (!(await this.#controlledCommitCurrent(
              envelope,
              "absent",
              operation,
            ))) {
              return { status: "stale" };
            }
            try {
              await this.#transport.perform(
                this.#transportInput(envelope, marker, credential),
                this.#transportOperation(operation),
              );
            } catch (error) {
              return errorResult(error, "unknown");
            }
            let completed;
            try {
              completed = observationResult(
                envelope,
                await this.#observe(envelope, marker, credential, operation),
                marker,
              );
            } catch (error) {
              return errorResult(error, "unknown");
            }
            return completed.status === "already"
              ? { ...completed, status: "applied" }
              : errorResult(
                new PullRequestExternalActionTransportError(
                  "GITHUB_OUTCOME_UNKNOWN",
                  "unknown",
                ),
              );
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    } catch (error) {
      return errorResult(error);
    } finally {
      this.#finishOperation(operation);
    }
  }

  async reconcile(input) {
    let envelope;
    try {
      envelope = normalizePullRequestExternalActionEnvelope(input);
    } catch (error) {
      return errorResult(error);
    }
    if (!this.#isEnabled(envelope)) {
      if (envelope.action.type === "pull_request_push" &&
          isHeadRepairExecutionSource(envelope.action.controlledCommitEvidence.executionSource)) {
        return errorResult(new PullRequestExternalActionTransportError("GITHUB_OUTCOME_UNKNOWN", "unknown"));
      }
      return { status: "stale" };
    }
    const operation = this.#beginOperation(envelope);
    try {
      if (envelope.action.publishedReviewReuse) return await this.#reuseReviewResult(envelope, operation);
      return await this.#withCredential(
        envelope,
        operation,
        async (credential) => {
          const marker = pullRequestExternalActionMarker(envelope);
          const result = observationResult(
            envelope,
            await this.#observe(envelope, marker, credential, operation),
            marker,
          );
          if (result.status !== "absent") return result;
          if (await this.#authorityCurrent(envelope, operation)) return result;
          // Revoked permission cannot establish that an admitted push never happened.
          // Retain the recovery fence when the remote no longer shows its commit.
          if (envelope.action.type === "pull_request_push" &&
              (this.#pushAuthorization !== null || isHeadRepairExecutionSource(envelope.action.controlledCommitEvidence.executionSource))) {
            return errorResult(new PullRequestExternalActionTransportError(
              "GITHUB_OUTCOME_UNKNOWN", "unknown",
            ));
          }
          return { status: "stale" };
        },
      );
    } catch (error) {
      return errorResult(error, "unknown");
    } finally {
      this.#finishOperation(operation);
    }
  }

  async #reuseReviewResult(envelope, operation) {
    if (envelope.action.type !== "pull_request_review" || typeof this.#reviewResultVerifier?.verify !== "function" ||
        !await this.#authorityCurrent(envelope, operation)) return { status: "stale" };
    const receipt = await this.#reviewResultVerifier.verify(envelope, { signal: operation.signal });
    if (operation.signal.aborted || !receipt || !await this.#authorityCurrent(envelope, operation)) return { status: "stale" };
    return { status: "already", receipt: normalizeConfirmationReceipt(receipt) };
  }

  #isEnabled(envelope) {
    return this.#enabledActions.has(ACTION_NAMES[envelope.action.type]);
  }

  #beginOperation(envelope) {
    const controller = new AbortController();
    this.#activeOperations.add(controller);
    if (this.#closed) controller.abort();
    // A push revalidates the sealed commit, versioned grant and remote target
    // repeatedly. Local verification shares this cap; transport calls retain
    // their individual request timeout.
    const stages = envelope.action.type === "pull_request_push" ? 10 : 1;
    const deadline = this.#clock() + Math.min(600_000, stages * this.#timeoutMs);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.#clock()),
    );
    timer.unref?.();
    return Object.freeze({ controller, signal: controller.signal, deadline, timer });
  }

  #finishOperation(operation) {
    clearTimeout(operation.timer);
    this.#activeOperations.delete(operation.controller);
  }

  async #withCredential(envelope, operation, callback) {
    let lease = null;
    try {
      lease = exactCredentialLease(
        await this.#credentialSource.acquire(Object.freeze({
          actorAccountId: envelope.actor.accountId,
          signal: operation.signal,
          deadline: operation.deadline,
        })),
      );
      return await lease.use((credential) => {
        if (typeof credential !== "string" || !CREDENTIAL.test(credential)) {
          throw new PullRequestExternalActionTransportError(
            "GITHUB_CREDENTIAL_OUTPUT_INVALID",
            "absent",
          );
        }
        return callback(credential);
      });
    } finally {
      await lease?.release();
    }
  }

  #transportOperation(operation) {
    return Object.freeze({
      signal: operation.signal,
      deadline: operation.deadline,
    });
  }

  close() {
    this.#closed = true;
    for (const controller of this.#activeOperations) controller.abort();
  }

  async #authorityCurrent(envelope, operation) {
    if (envelope.action.type === "pull_request_push" && this.#pushAuthorization !== null &&
        !(await this.#awaitOperation(operation, () => this.#pushAuthorization.verifyPush(envelope), "absent", operation.deadline))) return false;
    try {
      const verified = await this.#awaitOperation(
        operation,
        () => this.#inputAuthorityVerifier.verify(
          structuredClone(envelope.action.inputBinding),
        ),
      );
      return samePullRequestExecutionBinding(
        verified,
        envelope.action.inputBinding,
      );
    } catch (error) {
      if (this.#isOperationError(error, operation)) throw error;
      return false;
    }
  }

  async #controlledCommitCurrent(envelope, failureTrust, operation) {
    if (envelope.action.type !== "pull_request_push") return true;
    if (this.#controlledCommitVerifier === null) {
      throw new PullRequestExternalActionTransportError(
        "CONTROLLED_COMMIT_VERIFIER_UNAVAILABLE",
        failureTrust,
      );
    }
    let evidence;
    try {
      evidence = await this.#awaitOperation(
        operation,
        () => this.#controlledCommitVerifier.verify({
          evidenceId: envelope.action.controlledCommitEvidence.evidenceId,
        }),
        failureTrust,
        operation.deadline,
      );
    } catch (cause) {
      if (this.#isOperationError(cause, operation)) throw cause;
      throw new PullRequestExternalActionTransportError(
        "CONTROLLED_COMMIT_VERIFIER_UNAVAILABLE",
        failureTrust,
        { cause },
      );
    }
    try {
      return samePullRequestExternalControlledEvidence(
        evidence,
        envelope.action.controlledCommitEvidence,
      );
    } catch {
      return false;
    }
  }

  async #observe(envelope, marker, credential, operation) {
    this.#assertOperationCurrent(operation);
    const observation = await this.#transport.observe(
      this.#transportInput(envelope, marker, credential),
      this.#transportOperation(operation),
    );
    this.#assertOperationCurrent(operation);
    return normalizeObservation(observation, envelope);
  }

  async #awaitOperation(operation, callback, failureTrust = "absent",
    checkDeadline = Math.min(operation.deadline, this.#clock() + this.#timeoutMs)) {
    this.#assertOperationCurrent(operation, failureTrust);
    let abort;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PullRequestExternalActionTransportError("GITHUB_TIMEOUT", failureTrust)),
        Math.max(0, checkDeadline - this.#clock()));
      timer.unref?.();
    });
    const aborted = new Promise((_, reject) => {
      abort = () => reject(this.#operationError(operation, failureTrust));
      operation.signal.addEventListener("abort", abort, { once: true });
    });
    if (operation.signal.aborted) abort();
    const work = Promise.resolve().then(() => {
      this.#assertOperationCurrent(operation, failureTrust);
      return callback();
    });
    try {
      const value = await Promise.race([work, aborted, timedOut]);
      this.#assertOperationCurrent(operation, failureTrust);
      if (this.#clock() >= checkDeadline) throw new PullRequestExternalActionTransportError("GITHUB_TIMEOUT", failureTrust);
      return value;
    } finally {
      clearTimeout(timer);
      operation.signal.removeEventListener("abort", abort);
    }
  }

  #assertOperationCurrent(operation, failureTrust = "absent") {
    if (this.#clock() >= operation.deadline) {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_TIMEOUT",
        failureTrust,
      );
    }
    if (operation.signal.aborted) {
      throw new PullRequestExternalActionTransportError(
        "GITHUB_UNAVAILABLE",
        failureTrust,
      );
    }
  }

  #operationError(operation, failureTrust) {
    return new PullRequestExternalActionTransportError(
      this.#clock() >= operation.deadline
        ? "GITHUB_TIMEOUT"
        : "GITHUB_UNAVAILABLE",
      failureTrust,
    );
  }

  #isOperationError(error, operation) {
    return error instanceof PullRequestExternalActionTransportError &&
      ["GITHUB_TIMEOUT", "GITHUB_UNAVAILABLE"].includes(error.code) &&
      (error.code === "GITHUB_TIMEOUT" || operation.signal.aborted || this.#clock() >= operation.deadline);
  }

  #transportInput(envelope, marker, credential) {
    const separator = envelope.target.resourceId.lastIndexOf("#");
    return {
      credential,
      actorAccountId: envelope.actor.accountId,
      repository: envelope.target.resourceId.slice(0, separator),
      pullRequestNumber: Number(envelope.target.resourceId.slice(separator + 1)),
      actionType: ACTION_NAMES[envelope.action.type],
      marker,
      action: structuredClone(envelope.action),
    };
  }
}

export function createPullRequestExternalActionExecutor(options) {
  const executor = new PullRequestExternalActionExecutor(options);
  return Object.freeze({
    execute: (input) => executor.execute(input),
    reconcile: (input) => executor.reconcile(input),
    close: () => executor.close(),
  });
}
