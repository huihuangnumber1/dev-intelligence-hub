import { randomUUID } from "node:crypto";
import {
  WORK_PROPOSAL_STATUSES,
  assertWorkProposalExactKeys,
  boundedWorkProposalText,
  cloneWorkProposalValue,
  createWorkProposalResult,
  isTerminalWorkProposalStatus,
  normalizeBoundWorkProposal,
  normalizeWorkProposalAdvanceRequest,
  normalizeWorkProposalClaimRequest,
  normalizeWorkProposalDigest,
  normalizeWorkProposalReference,
  normalizeWorkProposalResult,
  normalizeWorkProposalResultCursor,
  normalizeWorkProposalRunnerScope,
  normalizeWorkProposalTimestamp,
  safeWorkProposalInteger,
  workProposalArrayValues,
  workProposalDataEntries,
  workProposalDigest,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { WorkProposalEvidenceReader } from "./work-proposal-evidence-reader.js";

export const WORK_PROPOSAL_STATE_KEY = "work-proposal-state";

const MAX_PROPOSALS = 1_000;
const MAX_RESULTS = 1_000;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const STATUS_SET = new Set(WORK_PROPOSAL_STATUSES);
const LEASE_PREFIX = "work-proposal-lease-";

function storeError(code, message, statusCode = 400, options) {
  return workProposalError(code, message, statusCode, options);
}

function invalidState(message = "工作提案持久化状态无效") {
  return storeError("WORK_PROPOSAL_STATE_INVALID", message, 500);
}

function corruptedState(cause) {
  return storeError(
    "WORK_PROPOSAL_STATE_CORRUPTED",
    "工作提案持久化状态损坏",
    500,
    cause === undefined ? undefined : { cause },
  );
}

function capacityError() {
  return storeError(
    "WORK_PROPOSAL_CAPACITY_EXCEEDED",
    "工作提案本地容量已满",
    507,
  );
}

function forbiddenRunner() {
  return storeError(
    "WORK_PROPOSAL_RUNNER_FORBIDDEN",
    "工作提案 runner 无权处理该提案",
    403,
  );
}

function uncertainState(writeError, recoveryError) {
  return storeError(
    "WORK_PROPOSAL_STATE_UNCERTAIN",
    "工作提案持久化结果无法确认",
    500,
    { cause: new AggregateError([writeError, recoveryError]) },
  );
}

function validateDependency(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
}

function normalizeLimits(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("limits is invalid");
  }
  const allowed = new Set(["maximumProposals", "maximumResults", "maximumStateBytes"]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("limits is invalid");
  }
  const positive = (entry, fallback, maximum, name) => {
    const candidate = entry ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
      throw new TypeError(`${name} is invalid`);
    }
    return candidate;
  };
  return Object.freeze({
    maximumProposals: positive(
      value.maximumProposals,
      MAX_PROPOSALS,
      MAX_PROPOSALS,
      "maximumProposals",
    ),
    maximumResults: positive(
      value.maximumResults,
      MAX_RESULTS,
      MAX_RESULTS,
      "maximumResults",
    ),
    maximumStateBytes: positive(
      value.maximumStateBytes,
      MAX_STATE_BYTES,
      MAX_STATE_BYTES,
      "maximumStateBytes",
    ),
  });
}

function defaultState() {
  return {
    schemaVersion: 1,
    revision: 0,
    nextResultSequence: 1,
    proposals: [],
    results: [],
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isContentVersion(value) {
  return value !== null && typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0 && Object.isFrozen(value);
}

function normalizeVersionedRead(result, expectedVersion) {
  const error = corruptedState();
  assertWorkProposalExactKeys(result, result?.changed === true
    ? ["changed", "version", "value"] : ["changed", "version"], error);
  if (!isContentVersion(result.version) ||
      (result.changed !== true && result.changed !== false) ||
      (result.changed === false && result.version !== expectedVersion)) throw error;
  return result;
}

function optionalTimestamp(value, error) {
  return value === null ? null : normalizeWorkProposalTimestamp(value, error);
}

function optionalReference(value, name, maximumBytes, error) {
  return value === null
    ? null
    : boundedWorkProposalText(value, name, { maximumBytes, error });
}

function optionalSafeReference(value, name, maximumBytes, error) {
  return value === null
    ? null
    : normalizeWorkProposalReference(value, name, { maximumBytes, error });
}

function persistedProposalInput(value, error) {
  assertWorkProposalExactKeys(
    value,
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
  const normalized = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (value.contentDigest !== normalized.contentDigest) throw error;
  return normalized;
}

function normalizeLastError(value, error) {
  if (value === null) return null;
  assertWorkProposalExactKeys(value, ["reason", "at"], error);
  return {
    reason: boundedWorkProposalText(value.reason, "lastError.reason", {
      maximumBytes: 2_048,
      error,
    }),
    at: normalizeWorkProposalTimestamp(value.at, error),
  };
}

function normalizeAdvanceReceipt(value, proposal, request, appliedRevision, error) {
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "status",
      "revision",
      "downstreamRef",
      "resultId",
      "updatedAt",
    ],
    error,
  );
  const receipt = {
    proposalId: normalizeWorkProposalReference(value.proposalId, "proposalId", { error }),
    contentDigest: normalizeWorkProposalDigest(value.contentDigest, error),
    status: value.status,
    revision: safeWorkProposalInteger(value.revision, "advanceReceipt.revision", {
      minimum: 1,
      error,
    }),
    downstreamRef: optionalReference(
      value.downstreamRef,
      "advanceReceipt.downstreamRef",
      256,
      error,
    ),
    resultId: optionalSafeReference(value.resultId, "advanceReceipt.resultId", 96, error),
    updatedAt: normalizeWorkProposalTimestamp(value.updatedAt, error),
  };
  if (
    receipt.proposalId !== proposal.proposalId ||
    receipt.contentDigest !== proposal.contentDigest ||
    receipt.status !== request.transition.status ||
    receipt.revision !== appliedRevision ||
    isTerminalWorkProposalStatus(receipt.status) !== (receipt.resultId !== null)
  ) {
    throw error;
  }
  return receipt;
}

function normalizeLastAdvance(value, proposal, error) {
  if (value === null) return null;
  const keys = workProposalDataEntries(value, error).map(([key]) => key);
  const hasReceipt = keys.includes("receipt");
  assertWorkProposalExactKeys(
    value,
    hasReceipt
      ? ["commandDigest", "appliedRevision", "request", "receipt"]
      : ["commandDigest", "appliedRevision", "request"],
    error,
  );
  const request = normalizeWorkProposalAdvanceRequest(value.request);
  const commandDigest = normalizeWorkProposalDigest(value.commandDigest, error);
  const appliedRevision = safeWorkProposalInteger(
    value.appliedRevision,
    "lastAdvance.appliedRevision",
    { minimum: 1, error },
  );
  if (
    request.proposalId !== proposal.proposalId ||
    request.contentDigest !== proposal.contentDigest ||
    request.expectedRevision >= appliedRevision ||
    commandDigest !== workProposalDigest(request)
  ) {
    throw error;
  }
  const normalized = { commandDigest, appliedRevision, request };
  return hasReceipt
    ? {
        ...normalized,
        receipt: normalizeAdvanceReceipt(
          value.receipt,
          proposal,
          request,
          appliedRevision,
          error,
        ),
      }
    : normalized;
}

function normalizeStoredProposal(value, stateRevision) {
  const error = invalidState();
  assertWorkProposalExactKeys(
    value,
    [
      "proposal",
      "recordDigest",
      "status",
      "revision",
      "attempt",
      "runnerId",
      "leaseId",
      "leaseUntil",
      "nextAttemptAt",
      "downstreamRef",
      "lastError",
      "resultId",
      "lastAdvance",
      "createdAt",
      "updatedAt",
    ],
    error,
  );
  const proposal = persistedProposalInput(value.proposal, error);
  if (!STATUS_SET.has(value.status)) throw error;
  const revision = safeWorkProposalInteger(value.revision, "proposal.revision", {
    minimum: 1,
    maximum: stateRevision,
    error,
  });
  const runnerId = optionalSafeReference(value.runnerId, "runnerId", 128, error);
  const leaseId = optionalSafeReference(value.leaseId, "leaseId", 192, error);
  const leaseUntil = optionalTimestamp(value.leaseUntil, error);
  if (
    [runnerId, leaseId, leaseUntil].filter((entry) => entry !== null).length !== 0 &&
    [runnerId, leaseId, leaseUntil].filter((entry) => entry !== null).length !== 3
  ) {
    throw error;
  }
  const item = {
    proposal,
    status: value.status,
    revision,
    attempt: safeWorkProposalInteger(value.attempt, "proposal.attempt", { error }),
    runnerId,
    leaseId,
    leaseUntil,
    nextAttemptAt: optionalTimestamp(value.nextAttemptAt, error),
    downstreamRef: optionalReference(
      value.downstreamRef,
      "downstreamRef",
      256,
      error,
    ),
    lastError: normalizeLastError(value.lastError, error),
    resultId: optionalSafeReference(value.resultId, "resultId", 96, error),
    lastAdvance: normalizeLastAdvance(value.lastAdvance, proposal, error),
    createdAt: normalizeWorkProposalTimestamp(value.createdAt, error),
    updatedAt: normalizeWorkProposalTimestamp(value.updatedAt, error),
  };
  const terminal = isTerminalWorkProposalStatus(item.status);
  if (
    Date.parse(item.createdAt) > Date.parse(item.updatedAt) ||
    (item.leaseUntil !== null &&
      Date.parse(item.leaseUntil) <= Date.parse(item.updatedAt)) ||
    (terminal &&
      (item.runnerId !== null ||
        item.leaseId !== null ||
        item.leaseUntil !== null ||
        item.nextAttemptAt !== null ||
        item.resultId === null)) ||
    (!terminal && item.resultId !== null) ||
    (item.status === "pending_delivery" &&
      (item.nextAttemptAt !== null || item.downstreamRef !== null)) ||
    (["waiting_confirmation", "running"].includes(item.status) &&
      (item.nextAttemptAt === null || item.downstreamRef === null)) ||
    (item.status === "waiting_retry" && item.nextAttemptAt === null) ||
    (item.lastAdvance !== null && item.lastAdvance.appliedRevision > item.revision) ||
    (item.lastAdvance?.receipt &&
      (item.lastAdvance.receipt.status !== item.status ||
        item.lastAdvance.receipt.downstreamRef !== item.downstreamRef ||
        item.lastAdvance.receipt.resultId !== item.resultId ||
        Date.parse(item.lastAdvance.receipt.updatedAt) > Date.parse(item.updatedAt)))
  ) {
    throw error;
  }
  const recordDigest = normalizeWorkProposalDigest(value.recordDigest, error);
  if (recordDigest !== workProposalDigest(item)) throw error;
  return { ...item, recordDigest };
}

function sealStoredProposal(value) {
  const { recordDigest: _recordDigest, ...content } = value;
  return { ...content, recordDigest: workProposalDigest(content) };
}

function validateCrossRecords(state) {
  const proposalById = new Map();
  for (const item of state.proposals) {
    if (proposalById.has(item.proposal.proposalId)) throw invalidState();
    proposalById.set(item.proposal.proposalId, item);
  }
  const resultIds = new Set();
  for (let index = 0; index < state.results.length; index += 1) {
    const result = state.results[index];
    if (result.sequence !== index + 1 || resultIds.has(result.resultId)) {
      throw invalidState();
    }
    resultIds.add(result.resultId);
    const item = proposalById.get(result.proposalId);
    if (
      !item ||
      item.resultId !== result.resultId ||
      item.proposal.contentDigest !== result.proposalContentDigest ||
      item.proposal.kind !== result.kind ||
      !sameValue(item.proposal.requestedBy, result.requestedBy) ||
      item.status !== result.outcome ||
      item.downstreamRef !== result.downstreamRef ||
      item.updatedAt !== result.at
    ) {
      throw invalidState();
    }
  }
  for (const item of state.proposals) {
    if (
      isTerminalWorkProposalStatus(item.status) !==
      (item.resultId !== null && resultIds.has(item.resultId))
    ) {
      throw invalidState();
    }
  }
}

function normalizeStateValue(value, limits) {
  const error = invalidState();
  assertWorkProposalExactKeys(
    value,
    ["schemaVersion", "revision", "nextResultSequence", "proposals", "results"],
    error,
  );
  if (value.schemaVersion !== 1) throw error;
  const revision = safeWorkProposalInteger(value.revision, "state.revision", {
    error,
  });
  const proposals = workProposalArrayValues(
    value.proposals,
    limits.maximumProposals,
    error,
  ).map((entry) => normalizeStoredProposal(entry, revision));
  const results = workProposalArrayValues(
    value.results,
    limits.maximumResults,
    error,
  ).map((entry) => {
    try {
      return normalizeWorkProposalResult(entry);
    } catch {
      throw error;
    }
  });
  const state = {
    schemaVersion: 1,
    revision,
    nextResultSequence: safeWorkProposalInteger(
      value.nextResultSequence,
      "nextResultSequence",
      { minimum: 1, error },
    ),
    proposals,
    results,
  };
  const maximumProposalRevision = proposals.reduce(
    (maximum, item) => Math.max(maximum, item.revision),
    0,
  );
  if (
    state.nextResultSequence !== results.length + 1 ||
    maximumProposalRevision !== revision ||
    Buffer.byteLength(JSON.stringify(state), "utf8") > limits.maximumStateBytes
  ) {
    throw error;
  }
  validateCrossRecords(state);
  return state;
}

function normalizeState(value, limits) {
  try {
    return normalizeStateValue(value, limits);
  } catch (error) {
    if (error?.code === "WORK_PROPOSAL_STATE_CORRUPTED") throw error;
    throw corruptedState(error);
  }
}

export function normalizeWorkProposalPersistedState(value, limits = {}) {
  return normalizeState(value, normalizeLimits(limits));
}

function projectProducerReceipt(item) {
  return cloneWorkProposalValue({
    proposalId: item.proposal.proposalId,
    contentDigest: item.proposal.contentDigest,
    kind: item.proposal.kind,
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
  });
}

function projectRunnerClaim(item) {
  return cloneWorkProposalValue({
    proposal: item.proposal,
    status: item.status,
    revision: item.revision,
    attempt: item.attempt,
    downstreamRef: item.downstreamRef,
    lease: {
      runnerId: item.runnerId,
      leaseId: item.leaseId,
      leaseUntil: item.leaseUntil,
    },
  });
}

function projectAdvanceReceipt(item) {
  return cloneWorkProposalValue({
    proposalId: item.proposal.proposalId,
    contentDigest: item.proposal.contentDigest,
    status: item.status,
    revision: item.revision,
    downstreamRef: item.downstreamRef,
    resultId: item.resultId,
    updatedAt: item.updatedAt,
  });
}

function normalizeIdFactory(value) {
  if (typeof value !== "function") throw new TypeError("idFactory is invalid");
  return value;
}

export class WorkProposalStore {
  #evidenceReader;
  #durableSnapshot = null;
  #normalizationLimits;

  constructor({
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    clock = () => new Date(),
    idFactory = randomUUID,
    limits = {},
  } = {}) {
    validateDependency(store, ["read", "write"], "store");
    validateDependency(exclusiveLease, ["run"], "exclusiveLease");
    validateDependency(operationQueue, ["enqueue"], "operationQueue");
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.store = store;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue;
    this.clock = clock;
    this.idFactory = normalizeIdFactory(idFactory);
    this.limits = normalizeLimits(limits);
    this.#normalizationLimits = this.limits;
    this.state = defaultState();
    this.ready = false;
    this.#evidenceReader = new WorkProposalEvidenceReader({
      readState: () => {
        this.#assertReady();
        return this.state;
      },
    });
  }

  recover() {
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.#durableSnapshot = null;
        const durable = await this.store.read(WORK_PROPOSAL_STATE_KEY, defaultState());
        const recovered = normalizeState(durable, this.limits);
        this.state = recovered;
        this.ready = true;
        return { revision: recovered.revision };
      }),
    );
  }

  create(value) {
    const proposal = normalizeBoundWorkProposal(value);
    return this.#mutate((state) => {
      const existing = state.proposals.find(
        (item) => item.proposal.proposalId === proposal.proposalId,
      );
      if (existing) {
        if (existing.proposal.contentDigest !== proposal.contentDigest) {
          throw storeError(
            "WORK_PROPOSAL_ID_CONFLICT",
            "同一工作提案 ID 已绑定不同内容",
            409,
          );
        }
        return { state, value: projectProducerReceipt(existing), write: false };
      }
      if (state.proposals.length >= this.limits.maximumProposals) {
        throw capacityError();
      }
      const revision = state.revision + 1;
      const at = this.#now(state);
      const item = sealStoredProposal({
        proposal,
        status: "pending_delivery",
        revision,
        attempt: 0,
        runnerId: null,
        leaseId: null,
        leaseUntil: null,
        nextAttemptAt: null,
        downstreamRef: null,
        lastError: null,
        resultId: null,
        lastAdvance: null,
        createdAt: at,
        updatedAt: at,
      });
      return {
        state: { ...state, revision, proposals: [...state.proposals, item] },
        value: projectProducerReceipt(item),
        write: true,
      };
    });
  }

  claim(value, runnerScope) {
    const request = normalizeWorkProposalClaimRequest(value);
    const scope = this.#runnerScope(runnerScope, request.runnerId);
    return this.#mutate((state) => {
      const now = this.#now(state);
      const nowMs = Date.parse(now);
      const excludedProposalIds = new Set(request.excludeProposalIds);
      const activeClaim = [...state.proposals]
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt, "en") ||
            left.proposal.proposalId.localeCompare(
              right.proposal.proposalId,
              "en",
            ),
        )
        .find(
          (candidate) =>
            this.#runnerCanAccess(candidate, scope) &&
            candidate.runnerId === scope.runnerId &&
            candidate.leaseUntil !== null &&
            Date.parse(candidate.leaseUntil) > nowMs,
        );
      if (activeClaim) {
        return {
          state,
          value: projectRunnerClaim(activeClaim),
          write: false,
        };
      }
      const item = [...state.proposals]
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt, "en") ||
            left.proposal.proposalId.localeCompare(
              right.proposal.proposalId,
              "en",
            ),
        )
        .find(
          (candidate) =>
            this.#runnerCanAccess(candidate, scope) &&
            !excludedProposalIds.has(candidate.proposal.proposalId) &&
            !isTerminalWorkProposalStatus(candidate.status) &&
            (candidate.nextAttemptAt === null ||
              Date.parse(candidate.nextAttemptAt) <= nowMs) &&
            (candidate.leaseUntil === null ||
              Date.parse(candidate.leaseUntil) <= nowMs),
        );
      if (!item) return { state, value: null, write: false };
      const rawLeaseId = `${LEASE_PREFIX}${this.idFactory()}`;
      const leaseId = normalizeWorkProposalReference(rawLeaseId, "leaseId");
      if (
        state.proposals.some(
          (candidate) => candidate.leaseId === leaseId && candidate !== item,
        )
      ) {
        throw storeError(
          "WORK_PROPOSAL_LEASE_ID_CONFLICT",
          "工作提案 runner 租约 ID 冲突",
          500,
        );
      }
      const revision = state.revision + 1;
      const claimed = sealStoredProposal({
        ...item,
        revision,
        attempt: item.attempt + 1,
        runnerId: request.runnerId,
        leaseId,
        leaseUntil: new Date(nowMs + request.leaseDurationMs).toISOString(),
        updatedAt: now,
      });
      return {
        state: {
          ...state,
          revision,
          proposals: this.#replace(state.proposals, claimed),
        },
        value: projectRunnerClaim(claimed),
        write: true,
      };
    });
  }

  advance(value, runnerScope) {
    const request = normalizeWorkProposalAdvanceRequest(value);
    const scope = this.#runnerScope(runnerScope, request.runnerId);
    const commandDigest = workProposalDigest(request);
    return this.#mutate((state) => {
      const item = this.#requireProposal(state, request.proposalId);
      if (!this.#runnerCanAccess(item, scope)) throw forbiddenRunner();
      if (item.proposal.contentDigest !== request.contentDigest) {
        throw storeError(
          "WORK_PROPOSAL_CONTENT_CONFLICT",
          "工作提案内容摘要已变化",
          409,
        );
      }
      if (
        item.lastAdvance?.commandDigest === commandDigest
      ) {
        return {
          state,
          value: cloneWorkProposalValue(
            item.lastAdvance.receipt ?? projectAdvanceReceipt(item),
          ),
          write: false,
        };
      }
      if (item.revision !== request.expectedRevision) {
        throw storeError(
          "WORK_PROPOSAL_REVISION_CONFLICT",
          "工作提案版本已变化",
          409,
        );
      }
      const now = this.#now(state);
      if (
        item.runnerId !== request.runnerId ||
        item.leaseId !== request.leaseId ||
        item.leaseUntil === null
      ) {
        throw storeError(
          "WORK_PROPOSAL_LEASE_CONFLICT",
          "工作提案 runner 租约已变化",
          409,
        );
      }
      if (Date.parse(item.leaseUntil) <= Date.parse(now)) {
        throw storeError(
          "WORK_PROPOSAL_LEASE_EXPIRED",
          "工作提案 runner 租约已过期",
          409,
        );
      }
      this.#validateTransition(item, request.transition, now);
      const revision = state.revision + 1;
      const terminal = isTerminalWorkProposalStatus(request.transition.status);
      const downstreamRef = ["waiting_confirmation", "running"].includes(
        request.transition.status,
      )
        ? request.transition.downstreamRef
        : item.downstreamRef;
      const result = terminal
        ? createWorkProposalResult({
            proposal: item.proposal,
            sequence: state.nextResultSequence,
            transition: request.transition,
            downstreamRef,
            at: now,
          })
        : null;
      const receipt = projectAdvanceReceipt({
        proposal: item.proposal,
        status: request.transition.status,
        revision,
        downstreamRef,
        resultId: result?.resultId || null,
        updatedAt: now,
      });
      const advanced = sealStoredProposal({
        ...item,
        status: request.transition.status,
        revision,
        runnerId: null,
        leaseId: null,
        leaseUntil: null,
        nextAttemptAt: terminal ? null : request.transition.nextAttemptAt,
        downstreamRef,
        lastError:
          request.transition.status === "waiting_retry"
            ? { reason: request.transition.reason, at: now }
            : null,
        resultId: result?.resultId || null,
        lastAdvance: {
          commandDigest,
          appliedRevision: revision,
          request: cloneWorkProposalValue(request),
          receipt,
        },
        updatedAt: now,
      });
      return {
        state: {
          ...state,
          revision,
          nextResultSequence:
            state.nextResultSequence + (result === null ? 0 : 1),
          proposals: this.#replace(state.proposals, advanced),
          results: result === null ? state.results : [...state.results, result],
        },
        value: cloneWorkProposalValue(receipt),
        write: true,
      };
    });
  }

  readResultBatch(value = {}) {
    const cursor = normalizeWorkProposalResultCursor(value);
    return this.#query(() => {
      const highWatermark = this.state.nextResultSequence - 1;
      if (cursor.afterSequence > highWatermark) {
        throw storeError(
          "INVALID_WORK_PROPOSAL_RESULT_CURSOR",
          "工作提案结果游标超过高水位",
        );
      }
      const items = this.state.results
        .filter((result) => result.sequence > cursor.afterSequence)
        .slice(0, cursor.limit)
        .map(cloneWorkProposalValue);
      return {
        items,
        nextSequence: items.at(-1)?.sequence ?? cursor.afterSequence,
        highWatermark,
        oldestAvailableSequence: this.state.results[0]?.sequence ?? null,
      };
    });
  }

  getResult(value) {
    return this.#evidenceReader.getResult(value);
  }

  getProposalForEvidence(value) {
    return this.#evidenceReader.getProposalForEvidence(value);
  }

  getResultForProposal(value) {
    return this.#evidenceReader.getResultForProposal(value);
  }

  listReviewPublicationSources(value) {
    return this.#evidenceReader.listReviewPublicationSources(value);
  }

  listEvidenceCandidates(value) {
    return this.#evidenceReader.listEvidenceCandidates(value);
  }

  #validateTransition(item, transition, now) {
    if (isTerminalWorkProposalStatus(item.status)) {
      throw storeError(
        "WORK_PROPOSAL_TERMINAL",
        "终态工作提案不能继续推进",
        409,
      );
    }
    if (
      Object.hasOwn(transition, "nextAttemptAt") &&
      Date.parse(transition.nextAttemptAt) < Date.parse(now)
    ) {
      throw storeError(
        "WORK_PROPOSAL_NEXT_ATTEMPT_INVALID",
        "工作提案下次处理时间早于当前时间",
        409,
      );
    }
    if (
      Object.hasOwn(transition, "downstreamRef") &&
      item.downstreamRef !== null &&
      item.downstreamRef !== transition.downstreamRef
    ) {
      throw storeError(
        "WORK_PROPOSAL_DOWNSTREAM_CONFLICT",
        "工作提案下游引用已绑定",
        409,
      );
    }
  }

  #replace(items, replacement) {
    return items.map((item) =>
      item.proposal.proposalId === replacement.proposal.proposalId
        ? replacement
        : item,
    );
  }

  #runnerScope(value, runnerId) {
    const scope = normalizeWorkProposalRunnerScope(value);
    if (scope.runnerId !== runnerId) throw forbiddenRunner();
    return scope;
  }

  #runnerCanAccess(item, scope) {
    return (
      scope.allowedKinds.includes(item.proposal.kind) &&
      scope.allowedRoleIds.includes(item.proposal.requestedBy.roleId)
    );
  }

  #requireProposal(state, proposalId) {
    const item = state.proposals.find(
      (candidate) => candidate.proposal.proposalId === proposalId,
    );
    if (!item) {
      throw storeError("WORK_PROPOSAL_NOT_FOUND", "工作提案不存在", 404);
    }
    return item;
  }

  #query(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return operation();
    });
  }

  #mutate(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return this.exclusiveLease.run(async () => {
        const durable = await this.#readDurableState();
        const change = operation(durable);
        if (!change.write) return change.value;
        this.#assertCapacity(change.state);
        const limits = this.limits;
        const candidate = normalizeState(change.state, limits);
        const store = this.store;
        let writtenVersion;
        try {
          writtenVersion = await store.write(WORK_PROPOSAL_STATE_KEY, candidate);
        } catch (writeError) {
          this.#durableSnapshot = null;
          await this.#reconcileFailedWrite(writeError);
          throw writeError;
        }
        this.state = candidate;
        this.#durableSnapshot = typeof store.readVersioned === "function" && isContentVersion(writtenVersion)
          ? { store, limits, version: writtenVersion, state: structuredClone(candidate) } : null;
        return change.value;
      });
    });
  }

  async #readDurableState() {
    try {
      const store = this.store;
      let durable, version, snapshot;
      if (typeof store.readVersioned === "function") {
        // StateStore checks exact fresh bytes and existence on every read.
        snapshot = this.limits === this.#normalizationLimits && this.#durableSnapshot?.store === store &&
          this.#durableSnapshot.limits === this.limits ? this.#durableSnapshot : null;
        const result = normalizeVersionedRead(await store.readVersioned(WORK_PROPOSAL_STATE_KEY, defaultState(), {
          ifVersion: snapshot?.version,
        }), snapshot?.version);
        version = result.version;
        if (!result.changed) {
          // The cached value never aliases public state or mutation inputs.
          durable = structuredClone(snapshot.state);
          if (snapshot.limits !== this.limits) durable = normalizeState(durable, this.limits);
        } else durable = normalizeState(result.value, this.limits);
      } else durable = normalizeState(await store.read(WORK_PROPOSAL_STATE_KEY, defaultState()), this.limits);
      // Public state may have been mutated even when durable bytes are unchanged.
      this.#acceptDurableState(durable);
      this.#durableSnapshot = version === undefined ? null
        : snapshot?.version === version && snapshot.limits === this.limits ? snapshot
        : { store, limits: this.limits, version, state: structuredClone(durable) };
      return durable;
    } catch (error) {
      this.#durableSnapshot = null;
      this.ready = false;
      throw error;
    }
  }

  async #reconcileFailedWrite(writeError) {
    try {
      await this.#readDurableState();
    } catch (recoveryError) {
      this.ready = false;
      throw uncertainState(writeError, recoveryError);
    }
  }

  #acceptDurableState(durable) {
    if (durable.revision < this.state.revision) {
      throw storeError(
        "WORK_PROPOSAL_STATE_ROLLBACK",
        "工作提案持久化状态发生回退",
        500,
      );
    }
    if (durable.revision === this.state.revision && !sameValue(durable, this.state)) {
      throw storeError(
        "WORK_PROPOSAL_STATE_FORKED",
        "工作提案持久化状态发生分叉",
        500,
      );
    }
    this.state = durable;
  }

  #assertCapacity(state) {
    if (
      state.proposals.length > this.limits.maximumProposals ||
      state.results.length > this.limits.maximumResults ||
      Buffer.byteLength(JSON.stringify(state), "utf8") > this.limits.maximumStateBytes
    ) {
      throw capacityError();
    }
  }

  #assertReady() {
    if (!this.ready) {
      throw storeError(
        "WORK_PROPOSAL_STORE_NOT_READY",
        "工作提案存储尚未完成恢复",
        503,
      );
    }
  }

  #now(state) {
    const error = storeError(
      "WORK_PROPOSAL_CLOCK_INVALID",
      "工作提案时钟无效",
      500,
    );
    const now = normalizeWorkProposalTimestamp(this.clock(), error);
    const latest = state.proposals.reduce(
      (maximum, item) =>
        Date.parse(item.updatedAt) > Date.parse(maximum) ? item.updatedAt : maximum,
      "1970-01-01T00:00:00.000Z",
    );
    if (Date.parse(now) < Date.parse(latest)) throw error;
    return now;
  }
}
