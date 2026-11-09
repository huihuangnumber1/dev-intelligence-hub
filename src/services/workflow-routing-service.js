import { normalizeStoredWorkflowEvent, normalizeWorkflowEvent } from "../domain/workflow-events.js";
import { DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS } from "../domain/prioritizer.js";
import { AUTHORED_PR_APPROVED_RULE_ID } from "../domain/pr-lifecycle-routing.js";
import { normalizeWorkflowRoutingConfig } from "../domain/workflow-router.js";
import {
  projectWorkflowSnapshot,
  workflowEventsFromSnapshots,
} from "../domain/workflow-snapshot-events.js";
import { OperationQueue } from "../lib/operation-queue.js";
import {
  isPullRequestScopeLifecycleEventType,
  PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
  PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
  PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
  PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
} from "../domain/pull-request-scope-lifecycle.js";
import { routeWorkflowWithIsolation } from "./workflow-route-result.js";
import {
  appendWorkflowAssignmentFeed,
  readWorkflowAssignmentBatch,
} from "./workflow-assignment-feed.js";
import {
  pageWorkflowRecords,
  retainWorkflowConfigHistory,
  retainWorkflowState,
} from "./workflow-routing-retention.js";
import {
  emptyWorkflowState,
  isLegacyWorkflowPersistedState,
  MAX_WORKFLOW_AUDIT_BYTES,
  MAX_WORKFLOW_BUNDLE_BYTES,
  MAX_WORKFLOW_CONFIG_HISTORY,
  MAX_WORKFLOW_RECORDS,
  MAX_WORKFLOW_STATE_BYTES,
  mergeWorkflowCheckpoint,
  normalizeLegacyWorkflowPersistedStateForMigration,
  normalizeWorkflowPersistedState,
  WORKFLOW_STATE_KEY,
  workflowPersistedStateDigest,
} from "./workflow-routing-state.js";
import {
  boundedWorkflowString,
  cloneWorkflowValue,
  hasExactWorkflowKeys,
  identifiedWorkflowRecord,
  isPlainWorkflowObject,
  normalizeWorkflowTimestamp,
  workflowDigest,
  workflowServiceError,
} from "./workflow-routing-values.js";

const DIRECT_NEW_WORK_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

function newWorkAdmissionRun(value) {
  const gate = value === undefined ? DIRECT_NEW_WORK_ADMISSION : value;
  if (!gate || typeof gate.run !== "function") {
    throw new TypeError("actionAdmissionGate must provide run(operation)");
  }
  return gate.run.bind(gate);
}

function validateLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function isContentVersion(value) {
  return (
    isPlainWorkflowObject(value) &&
    Reflect.ownKeys(value).length === 0 &&
    Object.isFrozen(value)
  );
}

function normalizeVersionedRead(result, expectedVersion) {
  const expectedKeys = result?.changed === true
    ? ["changed", "version", "value"]
    : ["changed", "version"];
  if (
    !hasExactWorkflowKeys(result, expectedKeys) ||
    !isContentVersion(result.version) ||
    (result.changed !== true && result.changed !== false) ||
    (result.changed === false && result.version !== expectedVersion)
  ) {
    throw new TypeError("StateStore versioned read result is invalid");
  }
  return result;
}

export class WorkflowRoutingService {
  #headAncestryReader;
  constructor({
    store,
    router,
    clock = () => new Date(),
    operationQueue,
    exclusiveLease,
    actionAdmissionGate,
    recordLimit = MAX_WORKFLOW_RECORDS,
    configHistoryLimit = MAX_WORKFLOW_CONFIG_HISTORY,
    stateByteBudget = MAX_WORKFLOW_STATE_BYTES,
    auditByteBudget = MAX_WORKFLOW_AUDIT_BYTES,
    bundleByteBudget = MAX_WORKFLOW_BUNDLE_BYTES,
    issueActiveWindowDays = DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
    scopeExitRecoveryReader = null,
    scopeReentryReader = null,
    roleHandoffReader = null,
    headAncestryReader = null,
  } = {}) {
    if (
      !store ||
      typeof store.read !== "function" ||
      typeof store.write !== "function"
    ) {
      throw new TypeError("Workflow routing requires a durable store");
    }
    if (!router || typeof router.route !== "function") {
      throw new TypeError("Workflow routing requires a router");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("Workflow routing requires an exclusiveLease");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (!Number.isSafeInteger(issueActiveWindowDays) || issueActiveWindowDays < 1) {
      throw new TypeError("issueActiveWindowDays is invalid");
    }
    this.store = store;
    this.router = router;
    this.clock = clock;
    this.issueActiveWindowDays = issueActiveWindowDays;
    if (scopeExitRecoveryReader !== null && typeof scopeExitRecoveryReader?.read !== "function") {
      throw new TypeError("scopeExitRecoveryReader is invalid");
    }
    this.scopeExitRecoveryReader = scopeExitRecoveryReader;
    if (scopeReentryReader !== null && typeof scopeReentryReader?.read !== "function") throw new TypeError("scopeReentryReader is invalid");
    this.scopeReentryReader = scopeReentryReader;
    if (roleHandoffReader !== null && typeof roleHandoffReader?.read !== "function") throw new TypeError("roleHandoffReader is invalid");
    this.roleHandoffReader = roleHandoffReader;
    if (headAncestryReader !== null && typeof headAncestryReader?.read !== "function") throw new TypeError("headAncestryReader is invalid");
    this.#headAncestryReader = headAncestryReader;
    this.operationQueue = operationQueue || new OperationQueue();
    this.exclusiveLease = exclusiveLease;
    this.runNewWorkAdmission = newWorkAdmissionRun(actionAdmissionGate);
    this.limits = Object.freeze({
      recordLimit: validateLimit(
        recordLimit,
        MAX_WORKFLOW_RECORDS,
        "recordLimit",
      ),
      configHistoryLimit: validateLimit(
        configHistoryLimit,
        MAX_WORKFLOW_CONFIG_HISTORY,
        "configHistoryLimit",
      ),
      stateByteBudget: validateLimit(
        stateByteBudget,
        MAX_WORKFLOW_STATE_BYTES,
        "stateByteBudget",
      ),
      auditByteBudget: validateLimit(
        auditByteBudget,
        MAX_WORKFLOW_AUDIT_BYTES,
        "auditByteBudget",
      ),
      bundleByteBudget: validateLimit(
        bundleByteBudget,
        MAX_WORKFLOW_BUNDLE_BYTES,
        "bundleByteBudget",
      ),
      issueActiveWindowDays,
    });
    this.state = emptyWorkflowState();
    this.durableContentVersion = undefined;
    this.ready = false;
    this.recoveryPromise = null;
  }

  async recover() {
    if (this.ready) return this.getConfig();
    this.recoveryPromise ||= this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
          this.ready = true;
          return this.getConfig();
        } catch (error) {
          this.ready = false;
          if (
            [
              "WORKFLOW_STATE_CORRUPTED",
              "WORKFLOW_STATE_REVISION_CONFLICT",
              "WORKFLOW_STATE_WRITE_FAILED",
            ].includes(error?.code)
          ) {
            throw error;
          }
          throw workflowServiceError(
            "WORKFLOW_STATE_CORRUPTED",
            "无法恢复工作流路由状态",
            503,
          );
        }
      }),
    );
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async getConfig() {
    this.#assertReady();
    return cloneWorkflowValue({
      current: this.state.currentConfig,
      history: this.state.configHistory,
    });
  }

  async replaceConfig({ definition, expectedVersion, changedBy } = {}) {
    this.#assertReady();
    const normalizedDefinition = normalizeWorkflowRoutingConfig(definition);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw workflowServiceError(
        "WORKFLOW_CONFIG_VERSION_INVALID",
        "配置版本无效",
      );
    }
    const actor = boundedWorkflowString(changedBy, "changedBy", 128);
    return this.#writeTransaction(async () => {
      const currentVersion = this.state.currentConfig?.version || 0;
      if (expectedVersion !== currentVersion) {
        throw workflowServiceError(
          "WORKFLOW_CONFIG_VERSION_CONFLICT",
          "工作流配置已更新，请重新读取",
          409,
        );
      }
      const entry = {
        version: currentVersion + 1,
        digest: workflowDigest(normalizedDefinition),
        definition: cloneWorkflowValue(normalizedDefinition),
        changedBy: actor,
        changedAt: normalizeWorkflowTimestamp(this.clock()),
      };
      const candidate = {
        ...this.state,
        revision: this.state.revision + 1,
        currentConfig: entry,
        configHistory: retainWorkflowConfigHistory(
          this.state,
          entry,
          this.limits.configHistoryLimit,
        ),
      };
      const nextState = this.#retain(candidate);
      await this.#persist(nextState);
      return cloneWorkflowValue(entry);
    });
  }

  async dryRun({ event, definition, context } = {}) {
    this.#assertReady();
    const candidateDefinition =
      definition === undefined
        ? cloneWorkflowValue(this.#requireConfig().definition)
        : definition;
    const routed = await routeWorkflowWithIsolation({
      router: this.router,
      event,
      definition: candidateDefinition,
      ...(context === undefined ? {} : { context }),
    });
    return cloneWorkflowValue({
      dryRun: true,
      persisted: false,
      event: routed.event,
      configDigest: workflowDigest(routed.definition),
      ...routed.result,
    });
  }

  async ingest({ event } = {}) {
    if (event?.eventType === "pull_request.role_handoff" || Object.hasOwn(event?.payload ?? {}, "headAncestryProof")) {
      throw workflowServiceError("WORKFLOW_EVENT_HOST_ONLY", "岗位责任交接只能由系统事实核验生成", 400);
    }
    this.#assertReady();
    const normalizedEvent = normalizeWorkflowEvent(event);
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
      const existing = this.state.events.find(
        (candidate) => candidate.eventId === normalizedEvent.eventId,
      );
      if (existing) return this.#ingestProjection(existing, true);
      const config = this.#requireConfig();
      const createdAt = normalizeWorkflowTimestamp(this.clock());
      const { assignments, audit } = await this.#routeEvent(
        normalizedEvent,
        config,
        createdAt,
      );
      const candidate = this.#appendAssignmentFeed(
        {
          ...this.state,
          revision: this.state.revision + 1,
          events: [...this.state.events, cloneWorkflowValue(normalizedEvent)],
          assignments: [...this.state.assignments, ...assignments],
          audit: [...this.state.audit, ...audit],
        },
        assignments,
      );
      const nextState = this.#retain(
        candidate,
        new Set([normalizedEvent.eventId]),
      );
      await this.#persist(nextState);
      return cloneWorkflowValue({
        deduplicated: false,
        event: normalizedEvent,
        assignments,
        audit,
      });
    }));
  }

  async ingestSnapshot({ snapshot, sourceScopeId = "github-dashboard" } = {}) {
    this.#assertReady();
    const projectionOptions = {
      issueActiveWindowDays: this.issueActiveWindowDays,
    };
    const currentCheckpoint = projectWorkflowSnapshot(
      snapshot,
      projectionOptions,
    );
    // Read ledger/GitHub before the routing lease: intake reads routing while
    // holding the ledger lease, so the reverse order would deadlock.
    const recoveredExits = this.scopeExitRecoveryReader !== null &&
      snapshot.sourceStatus?.githubPullRequests?.ok === true && snapshot.sourceStatus.githubPullRequests.complete === true
      ? await this.scopeExitRecoveryReader.read({ sourceScopeId }) : [];
    const currentPullRequestEvents = (this.roleHandoffReader !== null || this.scopeReentryReader !== null || this.#headAncestryReader !== null) &&
      snapshot.sourceStatus?.githubPullRequests?.ok === true && snapshot.sourceStatus.githubPullRequests.complete === true &&
      snapshot.sourceStatus.githubPullRequests.stale !== true
      ? Object.freeze(workflowEventsFromSnapshots(null, currentCheckpoint,
        { sourceScopeId, ...projectionOptions }).filter(event => event.eventType.startsWith("pull_request."))) : null;
    const roleHandoffs = this.roleHandoffReader !== null && currentPullRequestEvents !== null
      ? await this.roleHandoffReader.read({ events: currentPullRequestEvents }) : [];
    const reentries = this.scopeReentryReader !== null && currentPullRequestEvents !== null
      ? await this.scopeReentryReader.read({ events: currentPullRequestEvents }) : [];
    const ancestryEvents = this.#headAncestryReader !== null && currentPullRequestEvents !== null
      ? await this.#headAncestryReader.read({ events: currentPullRequestEvents }) : [];
    return this.#admitNewWork(() => this.#writeTransaction(async () => {
      const replay = this.#snapshotReplay(currentCheckpoint);
      const existingEventIds = new Set(
        this.state.events.map(({ eventId }) => eventId),
      );
      const extraEvents = recoveredExits.map(normalizeStoredWorkflowEvent).filter(event => {
        if (event.eventType !== "pull_request.left_scope" || event.source.provider !== "github" || event.source.scopeId !== sourceScopeId) {
          throw new TypeError("scope recovery may only revoke its GitHub scope");
        }
        return !existingEventIds.has(event.eventId);
      });
      for (const value of roleHandoffs) {
        const event = normalizeStoredWorkflowEvent(value);
        if (event.eventType !== "pull_request.role_handoff" || event.source.provider !== "github" || event.source.scopeId !== sourceScopeId) {
          throw new TypeError("role handoff reader may only transfer its GitHub scope");
        }
        if (!existingEventIds.has(event.eventId)) extraEvents.push(event);
      }
      for (const value of reentries) {
        const event = normalizeStoredWorkflowEvent(value);
        if (!["pull_request.updated", "pull_request.created"].includes(event.eventType) ||
            event.source.provider !== "github" || event.source.scopeId !== sourceScopeId) {
          throw new TypeError("scope reentry reader may only reconnect its GitHub scope");
        }
        if (!existingEventIds.has(event.eventId)) extraEvents.push(event);
      }
      for (const value of ancestryEvents) {
        const event = normalizeStoredWorkflowEvent(value);
        if (!["pull_request.updated", "pull_request.created"].includes(event.eventType) || event.source.provider !== "github" ||
            event.source.scopeId !== sourceScopeId || (event.eventType === "pull_request.updated" &&
              !/^head-ancestry-[a-f0-9]{64}$/.test(event.payload.headAncestryProof))) {
          throw new TypeError("Head ancestry producer may only prove its GitHub scope");
        }
        if (!existingEventIds.has(event.eventId)) extraEvents.push(event);
      }
      if (replay && extraEvents.length === 0) return replay;
      const config = this.#requireConfig();
      const emittedEventIds = new Set(existingEventIds);
      // The proof seals pre-intake root revisions. Apply it before this same
      // snapshot's ordinary metadata can advance those revisions.
      const events = [...extraEvents.filter(event => event.eventType === "pull_request.role_handoff"),
        ...extraEvents.filter(event => ["pull_request.updated", "pull_request.created"].includes(event.eventType)), ...(replay ? [] : workflowEventsFromSnapshots(
        this.state.checkpoint,
        currentCheckpoint,
        { sourceScopeId, ...projectionOptions },
      )), ...extraEvents.filter(event => event.eventType === "pull_request.left_scope")].filter(event => {
        if (emittedEventIds.has(event.eventId)) return false;
        emittedEventIds.add(event.eventId);
        return true;
      });
      const assignments = [];
      const audit = [];
      for (const event of events) {
        const routed = await this.#routeEvent(
          event,
          config,
          normalizeWorkflowTimestamp(this.clock()),
          { includeTrustedScopeLifecycle: true },
        );
        assignments.push(...routed.assignments);
        audit.push(...routed.audit);
      }
      const candidate = this.#appendAssignmentFeed(
        {
          ...this.state,
          revision: this.state.revision + 1,
          events: [...this.state.events, ...events.map(cloneWorkflowValue)],
          assignments: [...this.state.assignments, ...assignments],
          audit: [...this.state.audit, ...audit],
          checkpoint: mergeWorkflowCheckpoint(
            this.state.checkpoint,
            currentCheckpoint,
            projectionOptions,
          ),
          lastSnapshot: cloneWorkflowValue(currentCheckpoint),
        },
        assignments,
      );
      const nextState = this.#retain(
        candidate,
        new Set(events.map(({ eventId }) => eventId)),
      );
      await this.#persist(nextState);
      return cloneWorkflowValue({
        events,
        assignments,
        audit,
        checkpointRefreshedAt: nextState.checkpoint.refreshedAt,
      });
    }));
  }

  async listAssignments(options = {}) {
    this.#assertReady();
    return pageWorkflowRecords(
      this.state.assignments,
      "assignmentId",
      options,
    );
  }

  async readAssignmentBatch(options = {}) {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        this.state = await this.#readDurableState();
        return readWorkflowAssignmentBatch(this.state, options);
      }),
    );
  }

  async listAudit(options = {}) {
    this.#assertReady();
    return pageWorkflowRecords(this.state.audit, "auditId", options);
  }

  #snapshotReplay(currentCheckpoint) {
    if (!this.state.lastSnapshot) return null;
    const currentTime = Date.parse(currentCheckpoint.refreshedAt);
    const previousTime = Date.parse(this.state.lastSnapshot.refreshedAt);
    if (currentTime < previousTime) {
      throw workflowServiceError(
        "WORKFLOW_SNAPSHOT_STALE",
        "拒绝处理早于当前检查点的工作流快照",
        409,
      );
    }
    if (currentTime > previousTime) return null;
    if (
      workflowDigest(currentCheckpoint) !== workflowDigest(this.state.lastSnapshot)
    ) {
      throw workflowServiceError(
        "WORKFLOW_SNAPSHOT_TIMESTAMP_CONFLICT",
        "相同刷新时间对应了不同的工作流快照",
        409,
      );
    }
    return cloneWorkflowValue({
      events: [],
      assignments: [],
      audit: [],
      checkpointRefreshedAt: this.state.checkpoint.refreshedAt,
    });
  }

  #ingestProjection(event, deduplicated) {
    return cloneWorkflowValue({
      deduplicated,
      event,
      assignments: this.state.assignments.filter(
        (assignment) => assignment.eventId === event.eventId,
      ),
      audit: this.state.audit.filter((entry) => entry.eventId === event.eventId),
    });
  }

  async #routeEvent(
    event,
    config,
    createdAt,
    { includeTrustedScopeLifecycle = false } = {},
  ) {
    const routed = await routeWorkflowWithIsolation({
      router: this.router,
      event,
      definition: config.definition,
    });
    const assignments = [];
    if (
      includeTrustedScopeLifecycle &&
      isPullRequestScopeLifecycleEventType(routed.event.eventType) &&
      (routed.event.eventType !== "pull_request.role_handoff" || routed.result.assignments.some(assignment =>
        assignment.ruleId === AUTHORED_PR_APPROVED_RULE_ID && assignment.target?.type === "role" && assignment.target.id === "tester"))
    ) {
      assignments.push(
        identifiedWorkflowRecord("assignmentId", "workflow-assignment", {
          eventId: routed.event.eventId,
          eventType: routed.event.eventType,
          subject: cloneWorkflowValue(routed.event.subject),
          configVersion: config.version,
          configDigest: config.digest,
          ruleId: PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
          target: PULL_REQUEST_SCOPE_LIFECYCLE_TARGET,
          priority: PULL_REQUEST_SCOPE_LIFECYCLE_PRIORITY,
          reason: PULL_REQUEST_SCOPE_LIFECYCLE_REASON,
          createdAt,
        }),
      );
    }
    assignments.push(...routed.result.assignments.map((assignment) =>
      identifiedWorkflowRecord("assignmentId", "workflow-assignment", {
        eventId: routed.event.eventId,
        eventType: routed.event.eventType,
        subject: cloneWorkflowValue(routed.event.subject),
        configVersion: config.version,
        configDigest: config.digest,
        ruleId: assignment.ruleId,
        target: assignment.target,
        priority: assignment.priority,
        reason: assignment.reason,
        createdAt,
      }),
    ));
    const audit = [
      identifiedWorkflowRecord("auditId", "workflow-audit", {
        eventId: routed.event.eventId,
        eventType: routed.event.eventType,
        subject: cloneWorkflowValue(routed.event.subject),
        configVersion: config.version,
        configDigest: config.digest,
        outcome: routed.result.outcome,
        matchedRuleIds: routed.result.matches,
        assignmentIds: assignments.map(({ assignmentId }) => assignmentId),
        explanation: routed.result.explanation,
        createdAt,
      }),
    ];
    return { assignments, audit };
  }

  #appendAssignmentFeed(candidate, assignments) {
    return {
      ...candidate,
      ...appendWorkflowAssignmentFeed(this.state, assignments),
    };
  }

  #retain(candidate, protectedEventIds = new Set()) {
    return retainWorkflowState(candidate, {
      protectedEventIds,
      recordLimit: this.limits.recordLimit,
      stateByteBudget: this.limits.stateByteBudget,
      auditByteBudget: this.limits.auditByteBudget,
      bundleByteBudget: this.limits.bundleByteBudget,
    }).state;
  }

  #requireConfig() {
    if (!this.state.currentConfig) {
      throw workflowServiceError(
        "WORKFLOW_CONFIG_REQUIRED",
        "尚未配置工作流路由",
        409,
      );
    }
    return this.state.currentConfig;
  }

  async #persist(nextState) {
    if (nextState.revision !== this.state.revision + 1) {
      throw workflowServiceError(
        "WORKFLOW_STATE_REVISION_CONFLICT",
        "工作流状态版本发生冲突",
        409,
      );
    }
    let normalized;
    try {
      normalized = normalizeWorkflowPersistedState(nextState, this.limits);
    } catch (error) {
      if (error?.code === "WORKFLOW_STATE_CORRUPTED") throw error;
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "拒绝写入不一致的工作流状态",
        503,
      );
    }
    try {
      const writtenVersion = await this.store.write(
        WORKFLOW_STATE_KEY,
        normalized,
      );
      this.durableContentVersion =
        typeof this.store.readVersioned === "function" &&
        isContentVersion(writtenVersion)
          ? writtenVersion
          : undefined;
    } catch {
      throw workflowServiceError(
        "WORKFLOW_STATE_WRITE_FAILED",
        "无法持久化工作流路由状态",
        503,
      );
    }
    this.state = normalized;
  }

  async #readDurableState() {
    let stored;
    let observedVersion;
    if (typeof this.store.readVersioned === "function") {
      const result = normalizeVersionedRead(
        await this.store.readVersioned(WORKFLOW_STATE_KEY, null, {
          ifVersion: this.durableContentVersion,
        }),
        this.durableContentVersion,
      );
      if (!result.changed) return this.state;
      stored = result.value;
      observedVersion = result.version;
    } else {
      stored = await this.store.read(WORKFLOW_STATE_KEY, null);
    }
    if (stored === null) {
      if (this.ready && this.state.revision !== 0) {
        throw workflowServiceError(
          "WORKFLOW_STATE_CORRUPTED",
          "持久化工作流状态意外消失",
          503,
        );
      }
      this.durableContentVersion = observedVersion;
      return emptyWorkflowState();
    }
    const legacy = isLegacyWorkflowPersistedState(stored);
    let durable = legacy
      ? normalizeLegacyWorkflowPersistedStateForMigration(stored, this.limits)
      : normalizeWorkflowPersistedState(stored, this.limits);
    if (legacy && this.ready) {
      throw workflowServiceError(
        "WORKFLOW_STATE_REVISION_CONFLICT",
        "持久化工作流状态架构发生回退",
        409,
      );
    }
    if (
      this.ready &&
      (durable.revision < this.state.revision ||
        (durable.revision === this.state.revision &&
          workflowPersistedStateDigest(durable) !==
            workflowPersistedStateDigest(this.state)))
    ) {
      throw workflowServiceError(
        "WORKFLOW_STATE_REVISION_CONFLICT",
        "持久化工作流状态版本发生回退或分叉",
        409,
      );
    }
    if (legacy) {
      const upgraded = this.#retain({
        ...durable,
        revision: durable.revision + 1,
      });
      let normalized;
      try {
        normalized = normalizeWorkflowPersistedState(upgraded, this.limits);
      } catch (error) {
        if (error?.code === "WORKFLOW_STATE_CORRUPTED") throw error;
        throw workflowServiceError(
          "WORKFLOW_STATE_CORRUPTED",
          "无法升级工作流路由状态",
          503,
        );
      }
      try {
        const writtenVersion = await this.store.write(
          WORKFLOW_STATE_KEY,
          normalized,
        );
        observedVersion =
          typeof this.store.readVersioned === "function" &&
          isContentVersion(writtenVersion)
            ? writtenVersion
            : undefined;
      } catch {
        throw workflowServiceError(
          "WORKFLOW_STATE_WRITE_FAILED",
          "无法持久化工作流路由状态升级",
          503,
        );
      }
      durable = normalized;
    }
    this.durableContentVersion = observedVersion;
    return durable;
  }

  #writeTransaction(operation) {
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
        } catch (error) {
          if (
            error?.code === "WORKFLOW_STATE_CORRUPTED" ||
            error?.code === "WORKFLOW_STATE_REVISION_CONFLICT"
          ) {
            throw error;
          }
          throw workflowServiceError(
            "WORKFLOW_STATE_CORRUPTED",
            "无法重读工作流路由状态",
            503,
          );
        }
        return operation();
      }),
    );
  }

  async #admitNewWork(operation) {
    const admitted = await this.runNewWorkAdmission(() => ({
      // Enqueue synchronously, then carry the Promise out so cutover never
      // waits on local routing or durable storage.
      operation: operation(),
    }));
    return admitted.operation;
  }

  #assertReady() {
    if (!this.ready) {
      throw workflowServiceError(
        "WORKFLOW_NOT_READY",
        "工作流路由尚未恢复",
        503,
      );
    }
  }
}
