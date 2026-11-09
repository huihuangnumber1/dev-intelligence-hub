import { OperationQueue } from "../lib/operation-queue.js";
import { isDeepStrictEqual } from "node:util";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { normalizeWorkflowEvent } from "../domain/workflow-events.js";
import { currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { isAutomaticChildWait } from "./work-graph-wait-marker.js";
import { isExpiredCodeConfirmation } from "./work-ledger-pr-cutover-commands.js";

import {
  createOwnerIssueEvent,
  createOwnerPullRequestEvent,
  createOwnerWorkRequestEvent,
  normalizeOwnerWorkRequest,
  ownerWorkRequestDigest,
} from "../domain/owner-work-request.js";
import {
  createStagedOwnerWorkRequestRecord,
  emptyOwnerWorkRequestState,
  intakeOwnerWorkRequestRecord,
  nextOwnerWorkRequestState,
  normalizeOwnerWorkRequestState,
  OWNER_WORK_REQUEST_MAX_RECORDS,
  OWNER_WORK_REQUEST_STATE_KEY,
  routeOwnerWorkRequestRecord,
} from "./owner-work-request-state.js";

function throwIfCancelled(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Owner request cancelled", "AbortError");
}

function isOrchestratedRepairRequest(request) {
  return request.schemaVersion === 5 && request.workType === "general" &&
    request.triage?.suggestedCapability === "development" &&
    ["fix_ci", "resolve_conflict", "address_review"].includes(request.triage.nextAction);
}

function isInternalRepairReviewRequest(request) {
  return request.schemaVersion === 7 && request.workType === "pull_request";
}

function hasExpiredInternalCodeDecision(item) {
  return item?.status === "blocked" && item.statusReason === "proposal_stale" &&
    item.decisionContext?.source === "proposal" && isExpiredCodeConfirmation(item.decisionContext);
}

function isRefreshableInternalReviewRoot(item) {
  return item?.kind === "source_root" && (["queued", "retry_wait"].includes(item.status) ||
    hasExpiredInternalCodeDecision(item)) &&
    item.currentTarget?.type === "role" && ["pr-engineer", "developer"].includes(item.currentTarget.id) &&
    item.graph.parentItemId === null && item.graph.deliveries.length === 0 &&
    item.source?.scope.kind === "internal_review" && item.source.scope.active === true;
}

function isRefreshableRepairRoot(item) {
  return item?.kind === "source_root" && (["queued", "retry_wait"].includes(item.status) || isAutomaticChildWait(item)) &&
    item.currentTarget?.type === "role" && item.currentTarget.id === "orchestrator" &&
    item.graph.parentItemId === null && item.source?.scope.kind === "owner_requested" &&
    item.source.scope.active === true;
}

const INTAKE_BATCH_LIMIT = 100;
const MAX_INTAKE_PAGES = 50;
const MAX_ITEM_PAGES = 50;
const MAX_SOURCE_REFRESH_COMMIT_ATTEMPTS = 2;
const SAFE_REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const DIRECT_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

function ownerRequestError(code, message, statusCode = 400, options = {}) {
  return Object.assign(new Error(message, options), { code, statusCode });
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} must provide ${methods.join(", ")}`);
  }
  return value;
}

function canonicalTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_CLOCK_INVALID",
      "所有者工作请求时钟无效",
      500,
    );
  }
  return timestamp;
}

function requestId(value) {
  if (typeof value !== "string" || !SAFE_REQUEST_ID.test(value)) {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_INVALID",
      "requestId 无效",
    );
  }
  return value;
}

function oneRoleAssignment(result, phase) {
  if (
    !result ||
    !Array.isArray(result.assignments) ||
    result.assignments.length !== 1
  ) {
    const unavailable =
      result?.outcome === "disabled" || result?.outcome === "unmatched";
    throw ownerRequestError(
      unavailable
        ? "OWNER_WORK_REQUEST_ROUTING_NOT_READY"
        : "OWNER_WORK_REQUEST_ROUTING_AMBIGUOUS",
      unavailable
        ? "所有者工作请求路由尚未就绪"
        : "所有者工作请求必须路由到唯一岗位",
      unavailable ? 503 : 409,
    );
  }
  const assignment = result.assignments[0];
  if (
    assignment?.target?.type !== "role" ||
    typeof assignment.target.id !== "string"
  ) {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_ROUTING_AMBIGUOUS",
      "所有者工作请求只能进入一个岗位",
      409,
    );
  }
  if (phase === "persisted" && typeof assignment.assignmentId !== "string") {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_ROUTING_INVALID",
      "所有者工作请求路由结果缺少持久分派",
      503,
    );
  }
  return assignment;
}

function validIntakeResult(value) {
  return Boolean(
    value &&
      Number.isSafeInteger(value.cursor) &&
      value.cursor >= 0 &&
      Number.isSafeInteger(value.highWatermark) &&
      value.highWatermark >= value.cursor,
  );
}

function publicRecord(record, deduplicated = false) {
  return structuredClone({
    deduplicated,
    requestId: record.requestId,
    requestDigest: record.requestDigest,
    phase: record.phase,
    request: record.request,
    eventId: record.event.eventId,
    assignment: record.assignment,
    workItemId: record.workItemId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    audit: record.audit,
  });
}

function workflowEventInput(event) {
  return {
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    source: structuredClone(event.source),
    subject: structuredClone(event.subject),
    payload: structuredClone(event.payload),
  };
}

function normalizeSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw ownerRequestError("OWNER_WORK_REQUEST_QUERY_INVALID", "工作来源地址无效");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(pull|issues)\/([1-9][0-9]*)\/?$/u);
  if (
    typeof value !== "string" || url.protocol !== "https:" ||
    url.hostname !== "github.com" || url.port || url.username || url.password ||
    !match || match.slice(1, 3).some((part) => [".", ".."].includes(part)) ||
    !Number.isSafeInteger(Number(match[4]))
  ) {
    throw ownerRequestError("OWNER_WORK_REQUEST_QUERY_INVALID", "工作来源地址无效");
  }
  return {
    repository: `${match[1]}/${match[2]}`.toLowerCase(),
    number: Number(match[4]),
    kind: match[3] === "pull" ? "pullRequest" : "issue",
    url: `https://github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`.toLowerCase(),
  };
}

function matchesSource(record, source) {
  const target = record.request[source.kind];
  if (target) {
    return target.repository.toLowerCase() === source.repository && target.number === source.number;
  }
  // Older detail forms stored the origin as a dedicated line, before structured targets existed.
  return record.request.schemaVersion === 1 && record.request.description.split(/\r?\n/u)
    .some((line) => line.trim().toLowerCase() === `原始地址：${source.url}`);
}

function listOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !["limit", "cursor", "sourceUrl"].includes(key))
  ) {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_QUERY_INVALID",
      "所有者工作请求查询无效",
    );
  }
  const limit = value.limit === undefined ? 25 : Number(value.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_QUERY_INVALID",
      "所有者工作请求查询条数无效",
    );
  }
  return {
    limit,
    cursor: value.cursor === undefined ? null : requestId(value.cursor),
    source: value.sourceUrl === undefined ? null : normalizeSourceUrl(value.sourceUrl),
  };
}

export class OwnerWorkRequestService {
  #requestEpoch = 0;

  constructor({
    store,
    workflowRouting,
    ledger,
    roleReadiness,
    capabilityReadiness,
    pullRequestResolver,
    incomingReviewReader,
    exclusiveLease,
    actionAdmissionGate,
    operationQueue,
    clock = () => new Date(),
  } = {}) {
    this.store = requirePort(store, ["read", "write"], "store");
    this.workflowRouting = requirePort(
      workflowRouting,
      ["dryRun", "ingest"],
      "workflowRouting",
    );
    this.ledger = requirePort(ledger, ["intake", "listItems"], "ledger");
    this.roleReadiness = requirePort(roleReadiness, ["read"], "roleReadiness");
    this.capabilityReadiness = capabilityReadiness === undefined
      ? null
      : requirePort(
          capabilityReadiness,
          ["read"],
          "capabilityReadiness",
        );
    this.pullRequestResolver = pullRequestResolver === undefined
      ? null
      : requirePort(
          pullRequestResolver,
          ["resolvePullRequestTarget"],
          "pullRequestResolver",
        );
    this.incomingReviewReader = incomingReviewReader === undefined ? null
      : requirePort(incomingReviewReader, ["read"], "incomingReviewReader");
    this.exclusiveLease = requirePort(exclusiveLease, ["run"], "exclusiveLease");
    const gate = actionAdmissionGate ?? DIRECT_ADMISSION;
    this.runNewWorkAdmission = requirePort(
      gate,
      ["run"],
      "actionAdmissionGate",
    ).run.bind(gate);
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.clock = clock;
    this.operationQueue = operationQueue || new OperationQueue();
    this.refreshQueue = new OperationQueue();
    this.state = emptyOwnerWorkRequestState();
    this.refreshCursor = null;
    this.ready = false;
  }

  #withRequestLease(operation) {
    return this.operationQueue.enqueue(() => this.exclusiveLease.run(async () => {
      this.#requestEpoch += 1;
      return operation();
    }));
  }

  async recover() {
    const recovered = await this.#withRequestLease(async () => {
        this.state = await this.#readState();
        this.ready = true;
        return this.#recoveryStatus();
      });
    if (recovered.pending > 0) await this.resumePending();
    return this.#recoveryStatus();
  }

  async resumePending() {
    this.#assertReady();
    const pendingIds = this.state.records
      .filter(({ phase }) => phase !== "intaken")
      .map(({ requestId: id }) => id);
    let resumed = 0;
    for (const id of pendingIds) {
      await this.#withRequestLease(async () => {
          this.state = await this.#readState();
          const record = this.#requireRecord(id);
          if (record.phase === "intaken") return;
          await this.#advance(record);
          resumed += 1;
        });
    }
    return { resumed, ...this.#recoveryStatus() };
  }

  // Continue admitted work through ordinary source intake. Repair roots retain
  // their original authorization, as do host-issued repair reviews. Ordinary
  // owner Review recovery still checks current assignment.
  async refreshBlockedPullRequestSources({ limit = 10, signal = null } = {}) {
    limit = listOptions({ limit }).limit;
    normalizeAbortSignal(signal);
    this.#assertReady();
    if (typeof this.ledger.readItemForReconciliation !== "function" ||
        typeof this.ledger.listOutbox !== "function" ||
        typeof this.ledger.verifyPullRequestExecutionBinding !== "function") return { refreshed: 0 };
    // Serialize sweeps without holding the shared request lease over remote reads.
    const admitted = await this.runNewWorkAdmission(() => ({ operation: this.refreshQueue.enqueue(async () => {
        const records = await this.#withRequestLease(async () => {
          this.state = await this.#readState();
          const eligible = this.state.records.filter(record => record.phase === "intaken" &&
            (isOrchestratedRepairRequest(record.request) || isInternalRepairReviewRequest(record.request) ||
              (this.incomingReviewReader !== null && [2, 3, 4].includes(record.request.schemaVersion) &&
                record.request.workType === "pull_request")))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.requestId.localeCompare(right.requestId));
          const start = eligible.findIndex(record => record.requestId === this.refreshCursor) + 1;
          const count = Math.min(eligible.length, Math.max(50, limit * 5));
          return structuredClone(Array.from({ length: count }, (_, offset) => eligible[(start + offset) % eligible.length]));
        });
        let refreshed = 0, deferred = 0, remoteAttempts = 0;
        for (const record of records) {
          if (remoteAttempts >= limit) break;
          throwIfCancelled(signal);
          this.refreshCursor = record.requestId;
          const item = await this.ledger.readItemForReconciliation({ itemId: record.workItemId });
          const repair = isOrchestratedRepairRequest(record.request);
          const internalReview = isInternalRepairReviewRequest(record.request);
          const continuation = repair || internalReview;
          const eligible = repair ? isRefreshableRepairRoot(item) : internalReview ? isRefreshableInternalReviewRoot(item) :
            item?.kind === "source_root" && item.status === "blocked" && item.currentTarget?.id === "pr-engineer" &&
              item.statusReason === "decision_attempts_exhausted" && item.graph.deliveries.length === 0;
          if (!eligible ||
              (item.decisionContext !== null && !(internalReview && hasExpiredInternalCodeDecision(item))) ||
              item.activeIntentId !== null || item.leaseId !== null || item.ownerId !== null ||
              item.sourceQuarantine !== null || item.source?.pendingRevision !== null ||
              item.source.current.event.source.provider !== record.event.source.provider ||
              item.source.current.event.source.scopeId !== record.event.source.scopeId) continue;
          try {
            const binding = currentWorkItemExecutionBinding(item);
            if (binding?.schemaVersion !== 2) continue;
            await this.ledger.verifyPullRequestExecutionBinding(binding);
            if (!continuation && (await this.ledger.listOutbox({ itemId: item.itemId, limit: 1 })).items.length !== 0) continue;
            remoteAttempts++;
            if (!continuation && !await this.#hasCurrentReviewAssignment(binding, null)) continue;
            let event = await this.#createPullRequestEvent(record.request, this.#now(), signal, continuation ? binding : null);
            const previous = item.source.current.event.payload;
            if (event.payload.headRefOid === previous.headRefOid &&
                isDeepStrictEqual(event.payload.gitTarget, previous.gitTarget)) continue;
            if (event.payload.headRefOid !== previous.headRefOid) event = normalizeWorkflowEvent({
              ...workflowEventInput(event), payload: { ...event.payload,
                previousHeadRefOid: previous.headRefOid, changedFields: ["headRefOid"] } });
            if (await this.#applySourceRefresh({ record, item, event, binding, signal })) refreshed++;
          } catch (error) {
            throwIfCancelled(signal);
            // One unavailable PR must not suppress other ordinary source refreshes.
            if (!["OWNER_PULL_REQUEST_RESOLUTION_FAILED", "OWNER_WORK_REQUEST_INVALID", "OWNER_WORK_REQUEST_ROUTING_NOT_READY",
              "OWNER_WORK_REQUEST_ROLE_NOT_READY", "WORK_LEDGER_PR_EXECUTION_BINDING_STALE", "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE"].includes(error?.code)) throw error;
            deferred++;
          }
        }
        return { refreshed, deferred };
      }) }));
    return admitted.operation;
  }

  async #applySourceRefresh({ record, item, event, binding, signal }) {
    for (let attempt = 0; attempt < MAX_SOURCE_REFRESH_COMMIT_ATTEMPTS; attempt++) {
      const observation = await this.#withRequestLease(async () => {
        this.state = await this.#readState();
        if (!isDeepStrictEqual(this.state.records.find(entry => entry.requestId === record.requestId), record)) return null;
        await this.#preflight(event);
        return { ownerRevision: this.state.revision, requestEpoch: this.#requestEpoch };
      });
      if (observation === null || (!isOrchestratedRepairRequest(record.request) && !isInternalRepairReviewRequest(record.request) &&
          !await this.#hasCurrentReviewAssignment(binding, event.payload.headRefOid))) return false;
      const applied = await this.#withRequestLease(async () => {
        this.state = await this.#readState();
        if (!isDeepStrictEqual(this.state.records.find(entry => entry.requestId === record.requestId), record)) return false;
        // A queued request can take time to resolve. Refresh the remote facts
        // again if any owner operation intervened, even one that failed without a write.
        if (this.#requestEpoch !== observation.requestEpoch + 1 || this.state.revision !== observation.ownerRevision) return null;
        const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
        if (!isDeepStrictEqual(latest, item)) return false;
        await this.ledger.verifyPullRequestExecutionBinding(binding);
        throwIfCancelled(signal);
        const assignment = oneRoleAssignment(await this.workflowRouting.ingest({ event: workflowEventInput(event) }), "persisted");
        await this.#intakeAssignment(assignment.assignmentId, signal);
        return true;
      });
      if (applied !== null) return applied;
    }
    return false;
  }

  async #hasCurrentReviewAssignment(binding, expectedHead) {
    let facts;
    try {
      if (this.incomingReviewReader === null) throw new Error("Incoming assignment reader unavailable");
      facts = await this.incomingReviewReader.read({ repository: binding.repository,
        number: binding.pullRequestNumber, account: binding.gitTarget.sourceAccountId });
      if (facts?.incomingReviewFactsAvailable !== true || facts.kind !== "pull_request" ||
          !["open", "closed", "merged"].includes(facts.state?.toLowerCase()) || typeof facts.isDraft !== "boolean" ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(facts.headRefOid || "")) {
        throw new Error("Incoming assignment facts incomplete");
      }
    } catch (cause) {
      throw ownerRequestError("OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE", "无法核验 PR 的当前分配关系", 503, { cause });
    }
    return facts.kind === "pull_request" && facts.state?.toLowerCase() === "open" && facts.isDraft === false &&
      (expectedHead === null || facts.headRefOid === expectedHead) &&
      typeof facts.reviewRecipient === "string" &&
      facts.reviewRecipient.toLowerCase() === binding.gitTarget.sourceAccountId.toLowerCase() &&
      facts.reviewReceivedVia === "assignee" && typeof facts.reviewRequestEventId === "string" &&
      facts.reviewRequestEventId.length > 0;
  }

  async verifyAutomaticReviewContinuation(binding) {
    this.#assertReady();
    const state = await this.#readState();
    const record = state.records.find(record => record.phase === "intaken" && record.workItemId === binding.rootItemId &&
      [2, 3, 4].includes(record.request.schemaVersion) && record.request.workType === "pull_request");
    if (!record) return binding;
    const root = await this.ledger.readItemForReconciliation({ itemId: record.workItemId });
    const source = root?.source;
    // New explicit requests have a new immutable record and scope. Only a
    // later accepted event continuing the original host-owned scope is gated.
    if (source?.kind !== "pull_request" || source.current.eventId === record.event.eventId) return binding;
    const original = source.bindings.find(entry => entry.assignmentId === record.assignment.assignmentId &&
      entry.eventId === record.event.eventId);
    if (!original || source.scope.kind !== "owner_requested" ||
        source.identity.scopeId !== record.event.source.scopeId ||
        !isDeepStrictEqual(source.current.event.source, record.event.source) ||
        !isDeepStrictEqual(source.current.event.subject, record.event.subject) ||
        source.current.sourceSequence <= original.sourceSequence ||
        source.revisions[source.activeRevision - 1]?.disposition !== "accepted") return binding;
    await this.ledger.verifyPullRequestExecutionBinding(binding);
    if (!await this.#hasCurrentReviewAssignment(binding, binding.headRefOid)) {
      throw ownerRequestError("OWNER_REVIEW_ASSIGNMENT_REVOKED", "历史 Review 续接已不再分配给当前账号", 409);
    }
    await this.ledger.verifyPullRequestExecutionBinding(binding);
    return binding;
  }

  async submit(value, { signal = null } = {}) {
    if (value?.schemaVersion === 7) throw ownerRequestError("OWNER_WORK_REQUEST_INTERNAL_ONLY", "内部复审请求只能由受信服务提交", 403);
    return this.#submit(value, signal);
  }

  async submitInternalReview(value, { signal = null } = {}) {
    if (value?.schemaVersion !== 7) throw ownerRequestError("OWNER_WORK_REQUEST_INVALID", "内部复审请求类型无效");
    return this.#submit(value, signal);
  }

  async #submit(value, signal) {
    normalizeAbortSignal(signal);
    throwIfCancelled(signal);
    this.#assertReady();
    const request = normalizeOwnerWorkRequest(value);
    const admitted = await this.runNewWorkAdmission(() => ({
      operation: this.#withRequestLease(() => this.#submitLocked(request, signal)),
    }));
    return (await this.#withProgress([await admitted.operation]))[0];
  }

  async get(idValue) {
    this.#assertReady();
    const id = requestId(idValue);
    return this.#withRequestLease(async () => {
        this.state = await this.#readState();
        const record = this.state.records.find(
          ({ requestId: candidate }) => candidate === id,
        );
        return record ? (await this.#withProgress([publicRecord(record)]))[0] : null;
      });
  }

  async list(optionsValue = {}) {
    this.#assertReady();
    const options = listOptions(optionsValue);
    return this.#withRequestLease(async () => {
        this.state = await this.#readState();
        const records = [...this.state.records].reverse().filter(
          (record) => options.source === null || matchesSource(record, options.source),
        );
        const cursorIndex = options.cursor === null
          ? -1
          : records.findIndex(({ requestId: id }) => id === options.cursor);
        if (options.cursor !== null && cursorIndex < 0) {
          throw ownerRequestError(
            "OWNER_WORK_REQUEST_CURSOR_INVALID",
            "所有者工作请求游标无效",
          );
        }
        const start = cursorIndex + 1;
        const page = records.slice(start, start + options.limit);
        return {
          items: await this.#withProgress(page.map((record) => publicRecord(record))),
          nextCursor:
            start + page.length < records.length && page.length > 0
              ? page.at(-1).requestId
              : null,
        };
      });
  }

  async #withProgress(records) {
    const itemIds = records.map((record) => record.workItemId).filter(Boolean);
    const progress = itemIds.length && typeof this.ledger.readItemProgress === "function"
      ? await this.ledger.readItemProgress(itemIds)
      : [];
    const byId = new Map(progress.map((item) => [item.itemId, item]));
    return records.map((record) => ({
      ...record, progress: byId.get(record.workItemId) ?? null,
    }));
  }

  async #submitLocked(request, signal = null) {
    throwIfCancelled(signal);
    this.state = await this.#readState();
    throwIfCancelled(signal);
    const requestDigest = ownerWorkRequestDigest(request);
    let record = this.state.records.find(
      ({ requestId: id }) => id === request.requestId,
    );
    if (!record && request.schemaVersion === 5) {
      const predecessor = this.state.records.find(
        ({ requestId: id }) => id === request.predecessorRequestId,
      );
      if (predecessor) {
        this.#assertCompatiblePredecessor(request, predecessor);
        const advanced = await this.#advance(predecessor, signal);
        return publicRecord(advanced, true);
      }
    }
    const deduplicated = record !== undefined;
    if (record && record.requestDigest !== requestDigest) {
      if (this.#isCompatibleUnstructuredV5(request, record)) {
        const advanced = await this.#advance(record, signal);
        return publicRecord(advanced, true);
      }
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_IDEMPOTENCY_CONFLICT",
        "requestId 已绑定到不同的所有者工作请求",
        409,
      );
    }
    if (!record) {
      if (request.schemaVersion === 1 && request.workType === "pull_request") {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_INVALID",
          "PR 推进必须提供结构化仓库与 PR 编号",
        );
      }
      if (this.state.records.length >= OWNER_WORK_REQUEST_MAX_RECORDS) {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_CAPACITY_EXCEEDED",
          "所有者工作请求已达到本地容量上限",
          507,
        );
      }
      if (request.schemaVersion === 5) {
        await this.#requireCapabilityReady(request.triage.suggestedCapability);
      }
      const createdAt = this.#now();
      const event = [2, 3, 4, 5, 7].includes(request.schemaVersion)
        ? await this.#createPullRequestEvent(request, createdAt, signal)
        : request.schemaVersion === 6
        ? createOwnerIssueEvent(request, createdAt)
        : createOwnerWorkRequestEvent(request, createdAt);
      await this.#preflight(event);
      throwIfCancelled(signal);
      record = createStagedOwnerWorkRequestRecord(request, event, createdAt);
      await this.#persistRecord(record);
    }
    record = await this.#advance(record, signal);
    return publicRecord(record, deduplicated);
  }

  async #createPullRequestEvent(request, createdAt, signal, continuationBinding = null) {
    throwIfCancelled(signal);
    if (this.pullRequestResolver === null) {
      throw ownerRequestError(
        "OWNER_PULL_REQUEST_RESOLVER_NOT_READY",
        "PR 推进的 GitHub 解析器尚未就绪",
        503,
      );
    }
    let resolved;
    try {
      resolved = await this.pullRequestResolver.resolvePullRequestTarget(
        request.pullRequest,
        { signal },
      );
      throwIfCancelled(signal);
      if (continuationBinding !== null) {
        const previous = continuationBinding.gitTarget;
        const identityFields = ["provider", "sourceAccountId", "baseRepository", "baseRefName", "headRepository", "headRefName"];
        const internalReview = isInternalRepairReviewRequest(request);
        if ((!isOrchestratedRepairRequest(request) && !internalReview) ||
            (internalReview && resolved.gitTarget?.headRefOid !== previous.headRefOid) ||
            identityFields.some(field => resolved.gitTarget?.[field] !== previous[field])) {
          throw ownerRequestError("OWNER_WORK_REQUEST_INVALID", "修复续接不能改变原 PR 的账号、仓库或分支");
        }
        // Only this new source event follows the current Head. The persisted
        // request and its original frozen event are never rewritten.
        if (!internalReview) request = normalizeOwnerWorkRequest({ ...request,
          triage: { ...request.triage, expectedHeadRefOid: resolved.gitTarget.headRefOid } });
      }
      return createOwnerPullRequestEvent(request, resolved, createdAt);
    } catch (cause) {
      throwIfCancelled(signal);
      if (cause?.code === "OWNER_WORK_REQUEST_INVALID") throw cause;
      throw ownerRequestError(
        "OWNER_PULL_REQUEST_RESOLUTION_FAILED",
        "无法读取并冻结指定 PR 的当前 Git 目标",
        cause?.statusCode === 409 ? 409 : 503,
        { cause },
      );
    }
  }

  async #advance(recordValue, signal = null) {
    throwIfCancelled(signal);
    let record = recordValue;
    if (record.phase === "staged") {
      const routed = await this.workflowRouting.ingest({
        event: workflowEventInput(record.event),
      });
      const assignment = oneRoleAssignment(routed, "persisted");
      await this.#requireRoleReady(assignment.target.id);
      record = routeOwnerWorkRequestRecord(record, assignment, this.#now());
      await this.#persistRecord(record);
    }
    if (record.phase === "routed") {
      throwIfCancelled(signal);
      const workItemId = await this.#intakeAssignment(
        record.assignment.assignmentId,
        signal,
      );
      record = intakeOwnerWorkRequestRecord(record, workItemId, this.#now());
      await this.#persistRecord(record);
    }
    return record;
  }

  async #preflight(event) {
    const result = await this.workflowRouting.dryRun({ event });
    const assignment = oneRoleAssignment(result, "dry-run");
    await this.#requireRoleReady(assignment.target.id);
    return assignment;
  }

  async #requireRoleReady(roleId) {
    const status = await this.roleReadiness.read(roleId);
    if (
      !status ||
      status.roleId !== roleId ||
      status.enabled !== true ||
      status.paused === true
    ) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_ROLE_NOT_READY",
        `所有者工作请求目标岗位 ${roleId} 尚未就绪`,
        503,
      );
    }
  }

  async #requireCapabilityReady(capability) {
    const status = this.capabilityReadiness === null
      ? null
      : await this.capabilityReadiness.read(capability);
    if (
      !status ||
      status.capability !== capability ||
      typeof status.roleId !== "string" ||
      status.roleId.length < 1 ||
      status.enabled !== true ||
      status.paused === true
    ) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_CAPABILITY_NOT_READY",
        `PR 初判建议能力 ${capability} 没有可用的受信岗位映射`,
        503,
      );
    }
  }

  #assertCompatiblePredecessor(request, predecessor) {
    const legacy = predecessor.request;
    const expectedWorkType = request.triage.suggestedCapability === "development"
      ? "development"
      : "pull_request";
    if (
      legacy.schemaVersion !== 2 ||
      legacy.workType !== expectedWorkType ||
      legacy.pullRequest.repository !== request.pullRequest.repository ||
      legacy.pullRequest.number !== request.pullRequest.number ||
      predecessor.event.payload.headRefOid !==
        request.triage.expectedHeadRefOid
    ) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_IDEMPOTENCY_CONFLICT",
        "PR 初判前任幂等标识已绑定到不同的工作请求",
        409,
      );
    }
  }

  #isCompatibleUnstructuredV5(request, record) {
    if (
      request.schemaVersion !== 5 ||
      record.request.schemaVersion !== 5 ||
      record.request.triage !== undefined ||
      record.request.pullRequest.repository !== request.pullRequest.repository ||
      record.request.pullRequest.number !== request.pullRequest.number ||
      record.event.payload.headRefOid !== request.triage.expectedHeadRefOid
    ) {
      return false;
    }
    const lines = record.request.description.split("\n");
    return lines.includes(`下一动作：${request.triage.nextAction}。`) &&
      lines.includes(
        `建议能力：${request.triage.suggestedCapability}。`,
      );
  }

  async #intakeAssignment(assignmentId, signal) {
    let previousCursor = -1;
    for (let page = 0; page < MAX_INTAKE_PAGES; page += 1) {
      throwIfCancelled(signal);
      const result = await this.ledger.intake({ limit: INTAKE_BATCH_LIMIT });
      if (!validIntakeResult(result) || result.cursor < previousCursor) {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_LEDGER_INVALID",
          "员工工作台账返回了无效的 intake 进度",
          503,
        );
      }
      const item = await this.#findWorkItem(assignmentId, signal);
      if (item) return item.itemId;
      if (result.error?.code === "WORK_LEDGER_GRAPH_TRANSITION_INVALID") {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_LEDGER_REJECTED",
          "请求已路由，但工作台账拒绝了当前入账批次",
          503,
        );
      }
      if (result.cursor >= result.highWatermark) break;
      if (result.cursor === previousCursor) {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_LEDGER_STALLED",
          "员工工作台账 intake 没有推进",
          503,
        );
      }
      previousCursor = result.cursor;
    }
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_LEDGER_MISSING",
      "所有者工作请求已路由，但共享工作台账缺少对应任务",
      503,
    );
  }

  async #findWorkItem(assignmentId, signal) {
    let cursor;
    const seen = new Set();
    for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
      throwIfCancelled(signal);
      const result = await this.ledger.listItems({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        !result ||
        !Array.isArray(result.items) ||
        (result.nextCursor !== null && typeof result.nextCursor !== "string")
      ) {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_LEDGER_INVALID",
          "员工工作台账返回了无效的工作项页",
          503,
        );
      }
      const item = result.items.find(
        (candidate) =>
          candidate?.assignmentId === assignmentId ||
          candidate?.source?.bindings?.some(
            (binding) => binding.assignmentId === assignmentId,
          ),
      );
      if (item) return item;
      if (result.nextCursor === null) return null;
      if (
        result.items.length === 0 ||
        seen.has(result.nextCursor) ||
        result.items.at(-1)?.itemId !== result.nextCursor
      ) {
        throw ownerRequestError(
          "OWNER_WORK_REQUEST_LEDGER_INVALID",
          "员工工作台账返回了无效的工作项游标",
          503,
        );
      }
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw ownerRequestError(
      "OWNER_WORK_REQUEST_LEDGER_INVALID",
      "员工工作台账工作项页数超过安全上限",
      503,
    );
  }

  async #persistRecord(record) {
    const records = this.state.records.some(
      ({ requestId: id }) => id === record.requestId,
    )
      ? this.state.records.map((candidate) =>
          candidate.requestId === record.requestId ? record : candidate
        )
      : [...this.state.records, record];
    const nextState = nextOwnerWorkRequestState(this.state, records);
    try {
      await this.store.write(OWNER_WORK_REQUEST_STATE_KEY, nextState);
    } catch (cause) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_WRITE_FAILED",
        "无法持久化所有者工作请求",
        503,
        { cause },
      );
    }
    this.state = nextState;
  }

  async #readState() {
    let stored;
    try {
      stored = await this.store.read(OWNER_WORK_REQUEST_STATE_KEY, null);
    } catch (cause) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_READ_FAILED",
        "无法读取所有者工作请求",
        503,
        { cause },
      );
    }
    return stored === null
      ? emptyOwnerWorkRequestState()
      : normalizeOwnerWorkRequestState(stored);
  }

  #requireRecord(id) {
    const record = this.state.records.find(({ requestId }) => requestId === id);
    if (!record) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_NOT_FOUND",
        "所有者工作请求不存在",
        404,
      );
    }
    return record;
  }

  #recoveryStatus() {
    return {
      revision: this.state.revision,
      total: this.state.records.length,
      pending: this.state.records.filter(({ phase }) => phase !== "intaken")
        .length,
    };
  }

  #now() {
    return canonicalTimestamp(this.clock());
  }

  #assertReady() {
    if (!this.ready) {
      throw ownerRequestError(
        "OWNER_WORK_REQUEST_NOT_READY",
        "所有者工作请求服务尚未恢复",
        503,
      );
    }
  }
}
