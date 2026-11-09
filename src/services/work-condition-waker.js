import { isAutomaticChildWait } from "./work-graph-wait-marker.js";
import { normalizeRecordedDecisionFailure } from "./work-ledger-decision-failure.js";
import { normalizeRecordedProposalFailure } from "./work-ledger-proposal-failure.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_CYCLE = 100;
const DIRECT_ACTION_ADMISSION = Object.freeze({
  run(operation) {
    return operation();
  },
});

function bindPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function carryOperation(invoke) {
  try {
    return Object.freeze({
      status: "started",
      operation: Promise.resolve(invoke()),
    });
  } catch (error) {
    return Object.freeze({ status: "failed", error });
  }
}

function normalizedClock(clock) {
  const raw = clock();
  const value = raw instanceof Date ? raw.toISOString() : raw;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError("clock is invalid");
  }
  return value;
}

function limitFrom(options = {}) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== "limit")) {
    throw new TypeError("runCycle options are invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "limit");
  if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
    throw new TypeError("runCycle options are invalid");
  }
  const limit = descriptor ? descriptor.value : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CYCLE) {
    throw new TypeError(`limit must be between 1 and ${MAX_CYCLE}`);
  }
  return limit;
}

function factObservation(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("factSource returned an invalid observation");
  }
  const expected = ["healthy", "fresh", "value", "observedAt"];
  const entries = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("factSource returned an invalid observation");
    }
    entries.set(key, descriptor.value);
  }
  if (
    entries.size !== expected.length ||
    expected.some((key) => !entries.has(key)) ||
    typeof entries.get("healthy") !== "boolean" ||
    typeof entries.get("fresh") !== "boolean" ||
    !(entries.get("value") === null || typeof entries.get("value") === "string") ||
    !(entries.get("observedAt") === null || typeof entries.get("observedAt") === "string") ||
    (typeof entries.get("value") === "string" &&
      Buffer.byteLength(entries.get("value"), "utf8") > 256) ||
    (typeof entries.get("observedAt") === "string" &&
      (!Number.isFinite(Date.parse(entries.get("observedAt"))) ||
        new Date(Date.parse(entries.get("observedAt"))).toISOString() !==
          entries.get("observedAt")))
  ) {
    throw new TypeError("factSource returned an invalid observation");
  }
  return Object.fromEntries(entries);
}

function workerItemDto(item) {
  const {
    ownerId: _ownerId,
    leaseId: _leaseId,
    leaseUntil: _leaseUntil,
    ...visible
  } = item;
  return structuredClone({ ...visible, event: currentWorkItemEvent(item) });
}

export class WorkConditionWaker {
  #ledger;
  #readGraph = null;
  #resumeGraphTask = null;
  #readFact;
  #clock;
  #admitWake;
  #inFlight = null;
  #lastExaminedItemId = null;

  constructor({
    ledger,
    graphReader,
    graphPlanner,
    factSource,
    actionAdmissionGate,
    clock = () => new Date(),
  } = {}) {
    this.#ledger = bindPort(
      ledger,
      ["listItems", "listOutbox", "wakeCondition"],
      "ledger",
    );
    if ((graphReader === undefined) !== (graphPlanner === undefined)) {
      throw new TypeError("graph wake ports must be configured together");
    }
    if (graphReader !== undefined) {
      this.#readGraph = bindPort(
        graphReader,
        ["getSnapshot"],
        "graphReader",
      ).getSnapshot;
      this.#resumeGraphTask = bindPort(
        graphPlanner,
        ["resumeTask"],
        "graphPlanner",
      ).resumeTask;
    }
    this.#readFact = factSource === undefined
      ? null
      : bindPort(factSource, ["read"], "factSource").read;
    this.#admitWake = bindPort(
      actionAdmissionGate === undefined
        ? DIRECT_ACTION_ADMISSION
        : actionAdmissionGate,
      ["run"],
      "actionAdmissionGate",
    ).run;
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
  }

  runCycle(options = {}) {
    if (this.#inFlight) return this.#inFlight;
    const limit = limitFrom(options);
    const execution = Promise.resolve().then(() => this.#run(limit));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run(limit) {
    const now = normalizedClock(this.#clock);
    await this.#wakePausedOrchestratorParent();
    const waiting = await this.#readAll(this.#ledger.listItems, {
      status: "waiting_condition",
    });
    const delivered = await this.#readAll(this.#ledger.listOutbox, {
      status: "delivered",
    });
    const outboxById = new Map(
      delivered.map((entry) => [entry.intentId, entry]),
    );
    const outcomes = [];
    const previousIndex = waiting.findIndex(({ itemId }) => itemId === this.#lastExaminedItemId);
    const start = previousIndex < 0 ? 0 : (previousIndex + 1) % waiting.length;
    for (let offset = 0; offset < Math.min(waiting.length, limit); offset += 1) {
      const item = waiting[(start + offset) % waiting.length];
      // Advance even for unmet or invalid conditions so a stable waiting
      // prefix cannot prevent later tasks from being observed.
      this.#lastExaminedItemId = item.itemId;
      const outbox = outboxById.get(item.activeIntentId);
      if (!outbox || outbox.intent?.type !== "wait_condition") {
        outcomes.push({ itemId: item.itemId, status: "binding_invalid" });
        continue;
      }
      const observation = await this.#observe(item, outbox.intent.condition, now);
      if (!observation) {
        outcomes.push({ itemId: item.itemId, status: "waiting" });
        continue;
      }
      const command = {
        itemId: item.itemId,
        expectedRevision: item.revision,
        intentId: outbox.intentId,
        actorId: "work-condition-waker",
        observation,
      };
      let admitted;
      try {
        admitted = await this.#admitWake(() => carryOperation(() => {
          // Wake exactly this durable condition while admission is current,
          // but do not hold configuration cutover on the storage result.
          return this.#ledger.wakeCondition(command);
        }));
      } catch (error) {
        // Admission rejection is a runtime boundary, not an uncertain wake.
        throw error;
      }
      try {
        if (admitted.status === "failed") throw admitted.error;
        await admitted.operation;
        outcomes.push({ itemId: item.itemId, status: "woken" });
      } catch {
        outcomes.push({ itemId: item.itemId, status: "wake_uncertain" });
      }
    }
    return {
      scanned: Math.min(waiting.length, limit),
      woken: outcomes.filter(({ status }) => status === "woken").length,
      waiting: outcomes.filter(({ status }) => status === "waiting").length,
      uncertain: outcomes.filter(({ status }) => status === "wake_uncertain").length,
      outcomes,
    };
  }

  async #wakePausedOrchestratorParent() {
    if (this.#readGraph === null || this.#resumeGraphTask === null) return;
    const snapshot = await this.#readGraph();
    const graph = snapshot?.graph;
    if (!graph || !Array.isArray(graph.tasks) || !Number.isSafeInteger(graph.revision)) {
      throw new TypeError("graphReader returned an invalid snapshot");
    }
    const states = new Map((snapshot.taskStates ?? []).map(state => [state.taskId, state]));
    // A retained failure wakes coordination, never the failed child's execution.
    const failedParents = new Map();
    for (const task of graph.tasks) {
      const state = states.get(task.taskId);
      // The graph projects blocked ledger tasks as in_progress.
      if (task.parentTaskId === null || task.status !== "in_progress" || state?.ledgerStatus !== "blocked" ||
          state.taskRevision !== task.revision) continue;
      const failure = normalizeRecordedDecisionFailure(state.decisionFailure, task.revision) ??
        normalizeRecordedProposalFailure(state.proposalFailure, task.revision);
      if (failure !== null) failedParents.set(task.parentTaskId,
        Math.max(failedParents.get(task.parentTaskId) ?? 0, Date.parse(failure.recordedAt)));
    }
    const deliveryParents = new Set(
      graph.tasks
        .filter((task) =>
          task?.parentTaskId !== null &&
          (task?.deliveries?.at(-1)?.status === "submitted" ||
            ["completed", "cancelled"].includes(task?.status))
        )
        .map(({ parentTaskId }) => parentTaskId),
    );
    const wakeCandidateParents = new Set([...deliveryParents, ...failedParents.keys()]);
    const candidates = graph.tasks.filter((task) =>
      wakeCandidateParents.has(task?.taskId) &&
      task?.status === "paused" &&
      task?.responsibility?.type === "role" &&
      task.responsibility.id === "orchestrator"
    );
    if (candidates.length === 0) return;
    const pausedItems = await this.#readAll(this.#ledger.listItems, {
      status: "paused",
    });
    const pausedById = new Map(pausedItems.map((item) => [item.itemId, item]));
    const parent = candidates.find((task) => {
      const item = pausedById.get(task.taskId);
      // The graph projection omits statusReason. Only a durable wait marker,
      // at the same revision, permits automatic resume after child progress.
      // A failure from before this wait has already been considered.
      return item?.revision === task.revision && isAutomaticChildWait(item) &&
        (deliveryParents.has(task.taskId) || failedParents.get(task.taskId) > Date.parse(item.updatedAt));
    });
    if (!parent) return;
    const command = {
      taskId: parent.taskId,
      reason: deliveryParents.has(parent.taskId)
        ? "直属子任务已提交交付，恢复主脑验收"
        : "直属子任务发生已记录失败，恢复主脑协调",
      expectedGraphRevision: graph.revision,
      expectedTaskRevision: parent.revision,
    };
    let admitted;
    try {
      admitted = await this.#admitWake(() => carryOperation(() =>
        this.#resumeGraphTask(command)
      ));
    } catch (error) {
      throw error;
    }
    try {
      if (admitted.status === "failed") throw admitted.error;
      await admitted.operation;
    } catch {
      // The next cycle rereads the graph and safely reconciles an uncertain wake.
    }
  }

  async #observe(item, condition, now) {
    if (condition.kind === "time") {
      return Date.parse(now) >= Date.parse(condition.notBefore)
        ? { kind: "time", observedAt: condition.notBefore }
        : null;
    }
    if (!this.#readFact) return null;
    let observed;
    try {
      observed = factObservation(
        await this.#readFact({ item: workerItemDto(item), fact: condition.fact }),
      );
    } catch {
      return null;
    }
    if (
      !observed.healthy ||
      !observed.fresh ||
      !condition.oneOf.includes(observed.value) ||
      observed.observedAt === null
    ) {
      return null;
    }
    return {
      kind: "workflow_fact",
      fact: condition.fact,
      value: observed.value,
      observedAt: observed.observedAt,
    };
  }

  async #readAll(method, fixed) {
    const records = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await method({
        ...fixed,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (!result || !Array.isArray(result.items)) {
        throw new TypeError("ledger query result is invalid");
      }
      records.push(...result.items);
      if (result.nextCursor === null) return records;
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }
}
