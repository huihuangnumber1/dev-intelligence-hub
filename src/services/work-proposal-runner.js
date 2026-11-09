import {
  MAX_WORK_PROPOSAL_LEASE_DURATION_MS,
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  boundedWorkProposalText,
  cloneWorkProposalValue,
  isTerminalWorkProposalStatus,
  normalizeBoundWorkProposal,
  normalizeWorkProposalAdvanceRequest,
  normalizeWorkProposalDigest,
  normalizeWorkProposalReference,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
} from "../domain/work-proposal-contract.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";

const MAX_BATCH = 100;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const NONTERMINAL_STATUSES = new Set(
  WORK_PROPOSAL_STATUSES.filter((status) => !isTerminalWorkProposalStatus(status)),
);
const RUNTIME_ADMISSION_FAILURES = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function cycleOptions(value, fallback) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => !["limit", "signal"].includes(key))) {
    throw new TypeError("runCycle options are invalid");
  }
  const descriptors = Object.fromEntries(
    ["limit", "signal"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(value, name),
    ]),
  );
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
      throw new TypeError("runCycle options are invalid");
    }
  }
  return {
    limit: descriptors.limit
      ? positiveInteger(descriptors.limit.value, "limit", MAX_BATCH)
      : fallback,
    signal: normalizeAbortSignal(descriptors.signal?.value ?? null),
  };
}

function normalizeClock(clock) {
  let value;
  try {
    value = clock();
  } catch (cause) {
    throw new TypeError("clock failed", { cause });
  }
  return normalizeWorkProposalTimestamp(
    value,
    new TypeError("clock is invalid"),
  );
}

function normalizeClaim(value) {
  const error = new TypeError("runner claim is invalid");
  assertWorkProposalExactKeys(
    value,
    ["proposal", "status", "revision", "attempt", "downstreamRef", "lease"],
    error,
  );
  assertWorkProposalExactKeys(
    value.proposal,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    error,
  );
  const proposal = normalizeBoundWorkProposal({
    proposalId: value.proposal.proposalId,
    policyVersion: value.proposal.policyVersion,
    kind: value.proposal.kind,
    requestedBy: value.proposal.requestedBy,
    source: value.proposal.source,
    binding: value.proposal.binding,
    payload: value.proposal.payload,
  });
  if (
    normalizeWorkProposalDigest(value.proposal.contentDigest, error) !==
    proposal.contentDigest
  ) {
    throw error;
  }
  if (!NONTERMINAL_STATUSES.has(value.status)) throw error;
  assertWorkProposalExactKeys(
    value.lease,
    ["runnerId", "leaseId", "leaseUntil"],
    error,
  );
  return {
    proposal,
    status: value.status,
    revision: safeWorkProposalInteger(value.revision, "claim.revision", {
      minimum: 1,
      error,
    }),
    attempt: safeWorkProposalInteger(value.attempt, "claim.attempt", {
      minimum: 1,
      error,
    }),
    downstreamRef:
      value.downstreamRef === null
        ? null
        : boundedWorkProposalText(value.downstreamRef, "claim.downstreamRef", {
            maximumBytes: 256,
            error,
          }),
    lease: {
      runnerId: normalizeWorkProposalReference(
        value.lease.runnerId,
        "claim.lease.runnerId",
        { maximumBytes: 128, error },
      ),
      leaseId: normalizeWorkProposalReference(
        value.lease.leaseId,
        "claim.lease.leaseId",
        { maximumBytes: 192, error },
      ),
      leaseUntil: normalizeWorkProposalTimestamp(value.lease.leaseUntil, error),
    },
  };
}

function handlerInput(claim) {
  return cloneWorkProposalValue({
    proposal: claim.proposal,
    status: claim.status,
    attempt: claim.attempt,
    downstreamRef: claim.downstreamRef,
  });
}

function normalizeTransition(claim, value) {
  return normalizeWorkProposalAdvanceRequest({
    proposalId: claim.proposal.proposalId,
    contentDigest: claim.proposal.contentDigest,
    expectedRevision: claim.revision,
    runnerId: claim.lease.runnerId,
    leaseId: claim.lease.leaseId,
    transition: value,
  }).transition;
}

function stableFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
      return code;
    }
  } catch {
    // Treat hostile error objects as one local failure class.
  }
  return "WORK_PROPOSAL_HANDLER_FAILED";
}

function timeoutError() {
  return Object.assign(new Error("work proposal handler timed out"), {
    code: "WORK_PROPOSAL_HANDLER_TIMEOUT",
  });
}

async function within(operation, durationMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class WorkProposalRunnerService {
  #claim;
  #advance;
  #handle;
  #clock;
  #leaseDurationMs;
  #handlerTimeoutMs;
  #retryBaseMs;
  #retryMaxMs;
  #defaultBatchLimit;
  #inFlight = null;

  constructor({
    runner,
    handler,
    clock = () => new Date(),
    leaseDurationMs = 60_000,
    handlerTimeoutMs,
    retryBaseMs = 30_000,
    retryMaxMs = 15 * 60_000,
    defaultBatchLimit = 20,
  } = {}) {
    const runnerPort = requirePort(runner, ["claim", "advance"], "runner");
    this.#claim = runnerPort.claim;
    this.#advance = runnerPort.advance;
    this.#handle = requirePort(handler, ["handle"], "handler").handle;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#leaseDurationMs = positiveInteger(
      leaseDurationMs,
      "leaseDurationMs",
      MAX_WORK_PROPOSAL_LEASE_DURATION_MS,
    );
    if (this.#leaseDurationMs < 1_000) {
      throw new TypeError("leaseDurationMs is invalid");
    }
    this.#handlerTimeoutMs = positiveInteger(
      handlerTimeoutMs ?? Math.min(30_000, this.#leaseDurationMs - 1),
      "handlerTimeoutMs",
      MAX_DURATION_MS,
    );
    if (this.#handlerTimeoutMs >= this.#leaseDurationMs) {
      throw new TypeError("handlerTimeoutMs must be shorter than leaseDurationMs");
    }
    this.#retryBaseMs = positiveInteger(
      retryBaseMs,
      "retryBaseMs",
      MAX_DURATION_MS,
    );
    this.#retryMaxMs = positiveInteger(
      retryMaxMs,
      "retryMaxMs",
      MAX_DURATION_MS,
    );
    if (this.#retryMaxMs < this.#retryBaseMs) {
      throw new TypeError("retryMaxMs must not be shorter than retryBaseMs");
    }
    this.#defaultBatchLimit = positiveInteger(
      defaultBatchLimit,
      "defaultBatchLimit",
      MAX_BATCH,
    );
  }

  runCycle(options = {}) {
    if (this.#inFlight) return this.#inFlight;
    const cycle = cycleOptions(options, this.#defaultBatchLimit);
    cycle.signal?.throwIfAborted();
    const execution = Promise.resolve().then(() => this.#run(cycle));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run({ limit, signal }) {
    const outcomes = [];
    const handledProposalIds = new Set();
    for (let index = 0; index < limit; index += 1) {
      signal?.throwIfAborted();
      const claim = await this.#claimRecoverably(signal, handledProposalIds);
      signal?.throwIfAborted();
      if (claim === null) break;
      const normalizedClaim = normalizeClaim(claim);
      handledProposalIds.add(normalizedClaim.proposal.proposalId);
      outcomes.push(await this.#handleClaim(normalizedClaim));
      signal?.throwIfAborted();
    }
    return {
      claimed: outcomes.length,
      advanced: outcomes.length,
      waitingConfirmation: outcomes.filter(
        ({ status }) => status === "waiting_confirmation",
      ).length,
      waitingRetry: outcomes.filter(({ status }) => status === "waiting_retry")
        .length,
      terminal: outcomes.filter(({ status }) =>
        isTerminalWorkProposalStatus(status),
      ).length,
      outcomes,
    };
  }

  async #claimRecoverably(signal, handledProposalIds) {
    const request = {
      leaseDurationMs: this.#leaseDurationMs,
      excludeProposalIds: [...handledProposalIds],
    };
    try {
      return await this.#claim(request);
    } catch (error) {
      if (RUNTIME_ADMISSION_FAILURES.has(stableFailureCode(error))) throw error;
      signal?.throwIfAborted();
      return this.#claim(request);
    }
  }

  async #handleClaim(claim) {
    let transition;
    try {
      transition = normalizeTransition(
        claim,
        await within(
          () => this.#handle(handlerInput(claim)),
          this.#handlerTimeoutMs,
        ),
      );
    } catch (error) {
      transition = normalizeTransition(claim, this.#retryTransition(claim, error));
    }
    const request = {
      proposalId: claim.proposal.proposalId,
      contentDigest: claim.proposal.contentDigest,
      expectedRevision: claim.revision,
      leaseId: claim.lease.leaseId,
      transition,
    };
    await this.#advanceRecoverably(request);
    return { proposalId: claim.proposal.proposalId, status: transition.status };
  }

  #retryTransition(claim, error) {
    const exponent = Math.min(claim.attempt - 1, 30);
    const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** exponent);
    return {
      status: "waiting_retry",
      reason: stableFailureCode(error),
      nextAttemptAt: new Date(
        Date.parse(normalizeClock(this.#clock)) + delay,
      ).toISOString(),
    };
  }

  async #advanceRecoverably(request) {
    try {
      return await this.#advance(request);
    } catch {
      return this.#advance(request);
    }
  }
}
