import {
  boundedLedgerString,
  canonicalLedgerValue,
  hasExactLedgerKeys,
  workLedgerError,
} from "./work-ledger-values.js";

function bindDataMethod(value, methodName, portName) {
  if (value === null || !["object", "function"].includes(typeof value)) {
    throw new TypeError(`${portName} is invalid`);
  }
  let owner = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${portName} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`${portName} is invalid`);
}

function bindOptionalDataMethod(value, methodName) {
  let owner = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value.bind(value)
        : null;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function normalizePlannerAuthority(value) {
  if (!hasExactLedgerKeys(value, ["principalId", "scopeRootTaskId"])) {
    throw new TypeError("work graph planner authority is invalid");
  }
  let actorId;
  let scopeRootTaskId;
  try {
    actorId = boundedLedgerString(value.principalId, "principalId", 128);
    scopeRootTaskId = value.scopeRootTaskId === null
      ? null
      : boundedLedgerString(value.scopeRootTaskId, "scopeRootTaskId", 192);
  } catch {
    throw new TypeError("work graph planner authority is invalid");
  }
  return Object.freeze({ actorId, scopeRootTaskId });
}

function normalizeDelivererAuthority(value) {
  if (
    !hasExactLedgerKeys(value, [
      "principalId",
      "scopeRootTaskId",
      "taskId",
      "leaseId",
    ])
  ) {
    throw new TypeError("work graph deliverer authority is invalid");
  }
  let coordinator;
  let taskId;
  let leaseId;
  try {
    coordinator = normalizePlannerAuthority({
      principalId: value.principalId,
      scopeRootTaskId: value.scopeRootTaskId,
    });
    taskId = boundedLedgerString(value.taskId, "taskId", 192);
    leaseId = boundedLedgerString(value.leaseId, "leaseId", 128);
  } catch {
    throw new TypeError("work graph deliverer authority is invalid");
  }
  return Object.freeze({ ...coordinator, taskId, leaseId });
}

function snapshotCommand(value) {
  return canonicalLedgerValue(value, {
    maximumEntries: 20_000,
    maximumStringBytes: 16 * 1024,
    errorCode: "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  });
}

function invokeCommand(method, authority, command) {
  let snapshot;
  try {
    snapshot = snapshotCommand(command);
  } catch (error) {
    return Promise.reject(error);
  }
  if (method === null) {
    return Promise.reject(workLedgerError(
      "WORK_LEDGER_GRAPH_PORT_UNAVAILABLE",
      "当前工作图适配器不支持此编排命令",
      503,
    ));
  }
  return method({ authority, command: snapshot });
}

export class WorkGraphStore {
  #getSnapshot;
  #createChild;
  #reviseAcceptance;
  #submitDelivery;
  #decideDelivery;
  #reassignTask;
  #pauseTask;
  #resumeTask;
  #cancelTask;
  #stageEscalation;

  constructor(value = {}) {
    if (!hasExactLedgerKeys(value, ["ledger"])) {
      throw new TypeError("WorkGraphStore options are invalid");
    }
    this.#getSnapshot = bindDataMethod(
      value.ledger,
      "getGraphSnapshot",
      "work graph reader port",
    );
    this.#createChild = bindDataMethod(
      value.ledger,
      "createGraphChild",
      "work graph planner port",
    );
    this.#reviseAcceptance = bindDataMethod(
      value.ledger,
      "reviseGraphAcceptance",
      "work graph planner port",
    );
    this.#submitDelivery = bindDataMethod(
      value.ledger,
      "submitGraphDelivery",
      "work graph deliverer port",
    );
    this.#decideDelivery = bindDataMethod(
      value.ledger,
      "decideGraphDelivery",
      "work graph planner port",
    );
    this.#reassignTask = bindOptionalDataMethod(
      value.ledger,
      "reassignGraphTask",
    );
    this.#pauseTask = bindOptionalDataMethod(
      value.ledger,
      "pauseGraphTask",
    );
    this.#resumeTask = bindOptionalDataMethod(
      value.ledger,
      "resumeGraphTask",
    );
    this.#cancelTask = bindOptionalDataMethod(
      value.ledger,
      "cancelGraphTask",
    );
    this.#stageEscalation = bindOptionalDataMethod(
      value.ledger,
      "stageGraphEscalation",
    );
    Object.freeze(this);
  }

  reader() {
    return Object.freeze({
      getSnapshot: (options) => this.#getSnapshot(options),
    });
  }

  planner(authority) {
    const trustedAuthority = normalizePlannerAuthority(authority);
    return Object.freeze({
      createChild: (command) =>
        invokeCommand(this.#createChild, trustedAuthority, command),
      reviseAcceptanceContract: (command) =>
        invokeCommand(this.#reviseAcceptance, trustedAuthority, command),
      decideDelivery: (command) =>
        invokeCommand(this.#decideDelivery, trustedAuthority, command),
      reassignTask: (command) =>
        invokeCommand(this.#reassignTask, trustedAuthority, command),
      pauseTask: (command) =>
        invokeCommand(this.#pauseTask, trustedAuthority, command),
      resumeTask: (command) =>
        invokeCommand(this.#resumeTask, trustedAuthority, command),
      cancelTask: (command) =>
        invokeCommand(this.#cancelTask, trustedAuthority, command),
      stageEscalation: (command) =>
        invokeCommand(this.#stageEscalation, trustedAuthority, command),
    });
  }

  deliverer(authority) {
    const trustedAuthority = normalizeDelivererAuthority(authority);
    return Object.freeze({
      submitDelivery: (command) =>
        invokeCommand(this.#submitDelivery, trustedAuthority, command),
    });
  }
}
