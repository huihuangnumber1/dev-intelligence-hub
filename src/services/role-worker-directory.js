const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_TARGET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;

function directoryError(message) {
  return new TypeError(message);
}

function dataEntries(value, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw directoryError(message);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw directoryError(message);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactData(value, keys, message) {
  const entries = dataEntries(value, message);
  const actual = new Set(entries.map(([key]) => key));
  if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) {
    throw directoryError(message);
  }
  return Object.fromEntries(entries);
}

function safeRoleId(value, name = "roleId") {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw directoryError(`${name} is invalid`);
  }
  return value;
}

function safeWorkerId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw directoryError("workerId is invalid");
  }
  return value;
}

function safeTargetId(value) {
  if (typeof value !== "string" || !SAFE_TARGET_ID.test(value)) {
    throw directoryError("target.id is invalid");
  }
  return value;
}

function normalizeTarget(value) {
  const target = exactData(value, ["type", "id"], "target is invalid");
  if (!new Set(["role", "person", "node"]).has(target.type)) {
    throw directoryError("target is invalid");
  }
  return {
    type: target.type,
    id: safeTargetId(target.id),
  };
}

function normalizeRoleState(value) {
  const entries = dataEntries(value, "worker view is invalid");
  const state = Object.fromEntries(entries);
  if (
    Object.keys(state).some((key) => !["enabled", "paused"].includes(key)) ||
    typeof state.enabled !== "boolean" ||
    typeof state.paused !== "boolean"
  ) {
    throw directoryError("worker view is invalid");
  }
  return { enabled: state.enabled, paused: state.paused };
}

function normalizeWorker(worker) {
  if (worker === null || typeof worker !== "object") {
    throw directoryError("worker is invalid");
  }
  const roleId = safeRoleId(worker.roleId);
  const workerId = safeWorkerId(worker.workerId);
  if (typeof worker.view !== "function" || typeof worker.decide !== "function") {
    throw directoryError("worker is invalid");
  }
  const availability = worker.checkAvailability;
  const admission=worker.withDecisionAdmission;
  if(admission!==undefined && typeof admission!=='function')throw directoryError('worker admission is invalid');
  if (availability !== undefined && typeof availability !== "function") {
    throw directoryError("worker is invalid");
  }
  return Object.freeze({
    roleId,
    workerId,
    view: worker.view.bind(worker),
    decide: worker.decide.bind(worker),
    ...(admission ? {withDecisionAdmission:admission.bind(worker)} : {}),
    ...(availability
      ? { checkAvailability: availability.bind(worker) }
      : {}),
  });
}

function normalizeLegacyRoles(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw directoryError("legacyOwnedRoleIds is invalid");
  }
  const roles = value.map((roleId) => safeRoleId(roleId));
  if (new Set(roles).size !== roles.length) {
    throw directoryError("legacyOwnedRoleIds contains duplicates");
  }
  return new Set(roles);
}

function requireLegacyRegistry(value) {
  if (
    value !== null &&
    value !== undefined &&
    (typeof value !== "object" || typeof value.get !== "function")
  ) {
    throw directoryError("legacyEmployeeRegistry is invalid");
  }
  return value || null;
}

function reservedDecision(roleId) {
  return () => {
    const error = new Error(`岗位 ${roleId} 仍由旧执行器独占`);
    error.code = "ROLE_OWNERSHIP_RESERVED";
    throw error;
  };
}

export class RoleWorkerDirectory {
  #workers;
  #legacyEmployeeRegistry;
  #legacyOwnedRoleIds;

  constructor({
    workers = [],
    legacyEmployeeRegistry = null,
    legacyOwnedRoleIds = ["pr-reviewer"],
  } = {}) {
    if (!Array.isArray(workers) || Object.getPrototypeOf(workers) !== Array.prototype) {
      throw directoryError("workers is invalid");
    }
    this.#workers = new Map();
    for (const rawWorker of workers) {
      const worker = normalizeWorker(rawWorker);
      if (this.#workers.has(worker.roleId)) {
        throw directoryError(`worker role is duplicated: ${worker.roleId}`);
      }
      this.#workers.set(worker.roleId, worker);
    }
    this.#legacyEmployeeRegistry = requireLegacyRegistry(legacyEmployeeRegistry);
    this.#legacyOwnedRoleIds = normalizeLegacyRoles(legacyOwnedRoleIds);
    for (const roleId of this.#legacyOwnedRoleIds) {
      if (this.#workers.has(roleId)) {
        throw directoryError(`legacy-owned role cannot register a new worker: ${roleId}`);
      }
    }
    Object.freeze(this);
  }

  async resolve(value) {
    const target = normalizeTarget(value);
    if (target.type !== "role") return null;

    const worker = this.#workers.get(target.id);
    if (worker) {
      const state = normalizeRoleState(await worker.view());
      return Object.freeze({
        roleId: worker.roleId,
        workerId: worker.workerId,
        enabled: state.enabled,
        paused: state.paused,
        decide: worker.decide,
        ...(worker.withDecisionAdmission ? {withDecisionAdmission:worker.withDecisionAdmission} : {}),
        ...(worker.checkAvailability
          ? { checkAvailability: worker.checkAvailability }
          : {}),
      });
    }

    if (!this.#legacyOwnedRoleIds.has(target.id)) return null;
    const employee = this.#legacyEmployeeRegistry?.get(target.id);
    if (!employee || typeof employee.roleView !== "function") return null;
    const role = await employee.roleView();
    if (
      role === null ||
      typeof role !== "object" ||
      role.id !== target.id ||
      typeof role.enabled !== "boolean"
    ) {
      throw directoryError("legacy employee role view is invalid");
    }
    return Object.freeze({
      roleId: target.id,
      workerId: `legacy-${target.id}-reserved`,
      enabled: role.enabled,
      paused: true,
      decide: reservedDecision(target.id),
    });
  }
}
