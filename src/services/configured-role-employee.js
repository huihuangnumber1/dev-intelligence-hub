import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { EmployeeController } from "./employee-controller.js";
import { normalizeBrainConfig } from "./brain-router.js";
import {
  normalizeRoleDefinition,
  normalizeRolePermissions,
  RoleDecisionEngine,
} from "./role-decision-engine.js";
import { currentWorkItemEvent } from "./work-ledger-pr-source.js";
import { githubEntitySessionKey } from '../lib/session-key.js';

const SAFE_STATE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const ASSIGNED_TASK_KINDS = new Set([
  "assignment",
  "graph_task",
  "source_root",
]);

export class ConfiguredRoleEmployeeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ConfiguredRoleEmployeeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function employeeError(code, message, statusCode) {
  return new ConfiguredRoleEmployeeError(code, message, statusCode);
}

function safeWorkerId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new TypeError("workerId is invalid");
  }
  return value;
}

function safeStateKey(value) {
  if (typeof value !== "string" || !SAFE_STATE_KEY.test(value)) {
    throw new TypeError("stateKey is invalid");
  }
  return value;
}

export function configuredRoleLifecycleStateKey(roleId) {
  return safeStateKey(`configured-role-${safeStateKey(roleId)}-state`);
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw new TypeError("clock is invalid");
  }
  return timestamp;
}

function safeTrigger(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new TypeError("trigger is invalid");
  }
  return value;
}

function safeRunSummary(value) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw employeeError(
      "CONFIGURED_ROLE_STATE_CORRUPTED",
      "Configured role state is corrupted",
      503,
    );
  }
  return value;
}

function verificationRecoverySummary(stages) {
  const stage = stages && dataObject(stages.own_pr_material_recovery);
  const result = stage?.ok === true && dataObject(stage.result);
  const recovery = result && dataObject(result.verificationRecovery);
  if (!recovery || ['scanned', 'requeued', 'failed'].some(key =>
    !Number.isSafeInteger(recovery[key]) || recovery[key] < 0)) return '';
  const code = typeof recovery.lastFailure === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(recovery.lastFailure)
    ? `（${recovery.lastFailure}）` : '';
  return `；验证准备恢复：扫描 ${recovery.scanned} 项，入队 ${recovery.requeued} 项，失败 ${recovery.failed} 项${code}`;
}

const HOST_OUTCOME_REFERENCE_LABELS = new Map([
  ["claim_not_acquired:WORK_LEDGER_GRAPH_BLOCKED", "首个未领取任务"],
  ["blocked:ROLE_DECISION_INPUT_STALE", "首个输入校验任务"],
]);

function hostOutcomeReference(outcome, status, code) {
  // These fields come from the host work stage, never decision text or evidence.
  const label = HOST_OUTCOME_REFERENCE_LABELS.get(`${status}:${code}`);
  return label && typeof outcome.itemId === "string" && outcome.itemId.length === 74 && /^work-item-[a-f0-9]{64}$/.test(outcome.itemId)
    ? `；${label} ${outcome.itemId}` : "";
}

function runSummary(value) {
  const result = dataObject(value);
  const stages = result && dataObject(result.stages);
  const workStage = stages && dataObject(stages.work);
  const work = workStage?.ok === true && dataObject(workStage.result);
  const recovery = verificationRecoverySummary(stages);
  if (!work) return `本轮未执行岗位任务扫描${recovery}`;
  const scanned = Number.isSafeInteger(work.scanned) && work.scanned >= 0
    ? work.scanned
    : 0;
  const attempts = Number.isSafeInteger(work.workAttempts) &&
      work.workAttempts >= 0
    ? work.workAttempts
    : 0;
  const counts = new Map();
  let reference = "";
  if (Array.isArray(work.outcomes)) {
    for (const entry of work.outcomes) {
      const outcome = dataObject(entry);
      const status = outcome?.status;
      if (typeof status !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(status)) {
        continue;
      }
      const code = typeof outcome.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,127}$/.test(outcome.code)
        ? outcome.code
        : null;
      if (!reference) reference = hostOutcomeReference(outcome, status, code);
      const aggregate = counts.get(status) ?? { count: 0, codes: new Set() };
      aggregate.count += 1;
      if (code) aggregate.codes.add(code);
      counts.set(status, aggregate);
    }
  }
  const statuses = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, aggregate]) => {
      const codes = [...aggregate.codes].sort().join("、");
      return `${status} ${aggregate.count}${codes ? `（${codes}）` : ""}`;
    })
    .join("、");
  const prefix = `扫描 ${scanned} 项，尝试 ${attempts} 项`;
  const summary = `${prefix}${
    statuses ? `：${statuses}` : ""
  }${recovery}`;
  if (Buffer.byteLength(summary + reference, "utf8") <= 512) return summary + reference;
  const concise = `${prefix}${recovery}${reference}`;
  return Buffer.byteLength(concise, "utf8") <= 512 ? concise : `${prefix}${recovery}`;
}

function continuationWorkOutcome(value, target) {
  const stages = dataObject(dataObject(value)?.stages);
  const stage = dataObject(stages?.work);
  const work = stage?.ok === true ? dataObject(stage.result) : null;
  if (!Array.isArray(work?.outcomes)) return null;
  const matches = work.outcomes.map(dataObject).filter(entry => entry?.itemId === target.itemId);
  if (matches.length !== 1 || typeof matches[0].status !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(matches[0].status) ||
      typeof matches[0].code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(matches[0].code)) return null;
  return { ...target, status: matches[0].status, code: matches[0].code };
}

function stableErrorCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
      return code;
    }
  } catch {
    // Untrusted errors collapse to one local classification.
  }
  return "ROLE_RUN_FAILED";
}

function runFailureSummary(error) {
  try {
    const pending = [error];
    const seen = new Set();
    const details = [];
    for (let index = 0; index < pending.length && index < 8; index += 1) {
      const current = pending[index];
      if (!current || !['object', 'function'].includes(typeof current) || seen.has(current)) continue;
      seen.add(current);
      const own = key => Object.getOwnPropertyDescriptor(current, key)?.value;
      const stage = own('stage');
      const codes = own('causeCodes');
      if (typeof stage === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(stage) && Array.isArray(codes)) {
        const safeCodes = [];
        for (let i = 0; i < Math.min(Object.getOwnPropertyDescriptor(codes, 'length')?.value ?? 0, 2); i += 1) {
          const code = Object.getOwnPropertyDescriptor(codes, String(i))?.value;
          if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) safeCodes.push(code);
        }
        const detail = `${stage}${safeCodes.length ? ` [${safeCodes.join(' > ')}]` : ''}`;
        if (Buffer.byteLength(details.concat(detail).join('; '), 'utf8') <= 460) details.push(detail);
      }
      const errors = own('errors');
      if (Array.isArray(errors)) {
        for (let i = 0; i < Math.min(Object.getOwnPropertyDescriptor(errors, 'length')?.value ?? 0, 8); i += 1) pending.push(Object.getOwnPropertyDescriptor(errors, String(i))?.value);
      }
    }
    return `本轮岗位运行失败：${details.length ? details.join('; ') : stableErrorCode(error)}`;
  } catch {
    return `本轮岗位运行失败：${stableErrorCode(error)}`;
  }
}

function decisionSignal(input) {
  const request = dataObject(input);
  return normalizeAbortSignal(request?.signal ?? null);
}

function throwIfDecisionAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw employeeError("ROLE_DECISION_CANCELLED", "Configured role decision was cancelled", 499);
}

function dataObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function exactData(value, keys) {
  const object = dataObject(value);
  if (
    !object ||
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(object, key))
  ) {
    throw employeeError(
      "CONFIGURED_ROLE_STATE_CORRUPTED",
      "Configured role state is corrupted",
      503,
    );
  }
  return object;
}

function normalizeLastRun(value, schemaVersion) {
  if (value === null) return null;
  const lastRun = exactData(
    value,
    schemaVersion === 1 ? ["trigger", "at"] : ["trigger", "at", "summary"],
  );
  return {
    trigger: safeTrigger(lastRun.trigger),
    at: isoTimestamp(lastRun.at),
    summary: schemaVersion === 1 ? "" : safeRunSummary(lastRun.summary),
  };
}

function normalizeState(value) {
  const state = exactData(value, [
    "schemaVersion",
    "revision",
    "paused",
    "runCount",
    "lastRun",
    "lastErrorCode",
  ]);
  if (
    ![1, 2].includes(state.schemaVersion) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.paused !== "boolean" ||
    !Number.isSafeInteger(state.runCount) ||
    state.runCount < 0 ||
    typeof state.lastErrorCode !== "string" ||
    (state.lastErrorCode && !/^[A-Z][A-Z0-9_]{0,127}$/.test(state.lastErrorCode))
  ) {
    throw employeeError(
      "CONFIGURED_ROLE_STATE_CORRUPTED",
      "Configured role state is corrupted",
      503,
    );
  }
  return {
    schemaVersion: 2,
    revision: state.revision,
    paused: state.paused,
    runCount: state.runCount,
    lastRun: normalizeLastRun(state.lastRun, state.schemaVersion),
    lastErrorCode: state.lastErrorCode,
  };
}

export function normalizeConfiguredRoleLifecyclePersistedState(value) {
  return normalizeState(value);
}

function requireDecisionEngine(value) {
  if (
    !value ||
    typeof value.decide !== "function" ||
    typeof value.view !== "function"
  ) {
    throw new TypeError("decisionEngine is invalid");
  }
  const availability = value.checkAvailability;
  const admission=value.withAdmission;
  if(admission!==undefined && typeof admission!=='function')throw new TypeError('decisionEngine admission is invalid');
  if (availability !== undefined && typeof availability !== "function") {
    throw new TypeError("decisionEngine is invalid");
  }
  return Object.freeze({
    decide: value.decide.bind(value),
    view: value.view.bind(value),
    checkAvailability: availability
      ? availability.bind(value)
      : async () => {},
    withAdmission: admission ? admission.bind(value) : (_request,operation) => operation(),
  });
}

function createDecisionEngine({
  supplied,
  definition,
  permissions,
  brain,
  brainRouter,
  actionAdmissionGate,
  contextFactory,
}) {
  return requireDecisionEngine(
    supplied ??
      new RoleDecisionEngine({
        definition,
        permissions,
        brain,
        brainRouter,
        ...(actionAdmissionGate === undefined
          ? {}
          : { actionAdmissionGate }),
        ...(contextFactory ? { contextFactory } : {}),
      }),
  );
}

function safeBrainProjection(brain, engine) {
  let engineView;
  try {
    engineView = engine.view();
  } catch {
    throw new TypeError("decisionEngine view is invalid");
  }
  return Object.freeze({
    provider: brain.provider,
    model: brain.model,
    remote: engineView?.brain?.remote === true,
    remoteData: Object.freeze({ ...brain.remoteData }),
  });
}

function isBoundedBindingText(value, maximumBytes) {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    !INVALID_CONTROL.test(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function assignedTaskRisk(input, canProposeCodeAction) {
  const request = dataObject(input);
  const item = request && dataObject(request.item);
  if (!item || !ASSIGNED_TASK_KINDS.has(item.kind)) {
    return "routine";
  }
  if (
    !isBoundedBindingText(item.itemId, 192) ||
    !isBoundedBindingText(item.assignmentId, 192)
  ) {
    return "invalid";
  }
  const assignment = dataObject(item.assignment);
  const target = assignment && dataObject(assignment.target);
  if (
    !assignment ||
    assignment.assignmentId !== item.assignmentId ||
    !target ||
    !isBoundedBindingText(target.type, 32) ||
    !isBoundedBindingText(target.id, 128)
  ) {
    return "invalid";
  }
  let event;
  try {
    event = dataObject(currentWorkItemEvent(item));
  } catch {
    return "invalid";
  }
  if (
    !event ||
    !isBoundedBindingText(event.eventType, 128)
  ) {
    return "invalid";
  }
  if (canProposeCodeAction) return "task";
  return event.eventType.startsWith("pull_request.")
    ? "task"
    : "routine";
}

export class ConfiguredRoleEmployee {
  #controller;
  #routineDecisionEngine;
  #taskDecisionEngine;
  #canProposeCodeAction;
  #workerPort;
  #waitForModelCapacity;

  constructor({
    definition: definitionValue,
    permissions: permissionsValue,
    brain: brainValue,
    taskBrain: taskBrainValue,
    brainRouter,
    actionAdmissionGate,
    contextFactory,
    decisionEngine: suppliedDecisionEngine,
    taskDecisionEngine: suppliedTaskDecisionEngine,
    store,
    onRun = async () => {},
    clock = () => new Date(),
    workerId,
    stateKey,
    initialPaused = false,
    waitForModelCapacity = false,
    operationQueue = new OperationQueue(),
  } = {}) {
    if (typeof onRun !== "function") throw new TypeError("onRun is invalid");
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    if (typeof initialPaused !== "boolean") {
      throw new TypeError("initialPaused is invalid");
    }
    if (typeof waitForModelCapacity !== "boolean") throw new TypeError("waitForModelCapacity is invalid");
    this.#waitForModelCapacity = waitForModelCapacity;
    const definition = normalizeRoleDefinition(definitionValue);
    const permissions = normalizeRolePermissions(permissionsValue);
    const brain = normalizeBrainConfig(brainValue);
    const taskBrain = taskBrainValue === undefined
      ? null
      : normalizeBrainConfig(taskBrainValue);
    this.roleId = definition.id;
    this.workerId = safeWorkerId(workerId ?? `configured-${definition.id}`);
    this.scheduleMinutes = definition.scheduleMinutes;
    this.#canProposeCodeAction = permissions.allowedIntents.includes(
      "propose_code_action",
    );
    this.#routineDecisionEngine = createDecisionEngine({
      supplied: suppliedDecisionEngine,
      definition,
      permissions,
      brain,
      brainRouter,
      actionAdmissionGate,
      contextFactory,
    });
    if (taskBrain === null && suppliedTaskDecisionEngine !== undefined) {
      throw new TypeError("taskDecisionEngine requires taskBrain");
    }
    this.#taskDecisionEngine = taskBrain === null
      ? null
      : createDecisionEngine({
          supplied: suppliedTaskDecisionEngine,
          definition,
          permissions,
          brain: taskBrain,
          brainRouter,
          actionAdmissionGate,
          contextFactory,
        });
    const brainProjection = safeBrainProjection(
      brain,
      this.#routineDecisionEngine,
    );
    const taskBrainProjection = taskBrain === null
      ? null
      : safeBrainProjection(taskBrain, this.#taskDecisionEngine);
    let controller;
    controller = new EmployeeController({
      definition,
      store,
      stateKey: safeStateKey(
        stateKey ?? configuredRoleLifecycleStateKey(definition.id),
      ),
      operationQueue,
      responsiveControls: true,
      createState: () => ({
        schemaVersion: 2,
        revision: 0,
        paused: initialPaused,
        runCount: 0,
        lastRun: null,
        lastErrorCode: "",
      }),
      normalizeState,
      resolveState: (state, enabled) => {
        if (!enabled) return "disabled";
        return state.paused ? "paused" : "observing";
      },
      projectRole: (state) => ({
        workerId: this.workerId,
        permissions: { allowedIntents: [...permissions.allowedIntents] },
        brain: {
          ...brainProjection,
          remoteData: { ...brainProjection.remoteData },
        },
        ...(taskBrainProjection === null
          ? {}
          : {
              taskBrain: {
                ...taskBrainProjection,
                remoteData: { ...taskBrainProjection.remoteData },
              },
            }),
        lastRun: state.lastRun ? { ...state.lastRun } : null,
        lastErrorCode: state.lastErrorCode,
      }),
      projectWork: (state) => ({
        workerId: this.workerId,
        runCount: state.runCount,
        lastRun: state.lastRun ? { ...state.lastRun } : null,
        lastErrorCode: state.lastErrorCode,
      }),
      run: async ({ state, trigger = "scheduled", signal = null, continuationTarget = null, onContinuationOutcome = null }) => {
        if (onContinuationOutcome !== null && typeof onContinuationOutcome !== 'function') throw new TypeError('Invalid continuation outcome observer');
        signal = normalizeAbortSignal(signal);
        throwIfDecisionAborted(signal);
        const normalizedTrigger = safeTrigger(trigger);
        let failure = null;
        let outcome = null;
        try {
          outcome = await onRun({
            roleId: this.roleId,
            workerId: this.workerId,
            trigger: normalizedTrigger,
            ...(continuationTarget === null ? {} : { continuationTarget }),
            ...(signal === null ? {} : { signal }),
          });
          throwIfDecisionAborted(signal);
        } catch (error) {
          throwIfDecisionAborted(signal);
          failure = error;
        }
        throwIfDecisionAborted(signal);
        const next = await controller.writeState({
          ...state,
          schemaVersion: 2,
          runCount: state.runCount + 1,
          lastRun: {
            trigger: normalizedTrigger,
            at: isoTimestamp(clock()),
            summary: failure ? runFailureSummary(failure) : runSummary(outcome),
          },
          lastErrorCode: failure ? stableErrorCode(failure) : "",
        });
        if (failure) throw failure;
        if (continuationTarget !== null && onContinuationOutcome !== null) onContinuationOutcome(continuationWorkOutcome(outcome, continuationTarget));
        return next;
      },
    });
    this.#controller = controller;
    this.#workerPort = Object.freeze({
      roleId: this.roleId,
      workerId: this.workerId,
      view: this.workerView.bind(this),
      checkAvailability: this.checkAvailability.bind(this),
      withDecisionAdmission: this.withDecisionAdmission.bind(this),
      decide: this.decide.bind(this),
    });
    Object.freeze(this);
  }

  get id() {
    return this.#controller.id;
  }

  get running() {
    return this.#controller.running;
  }

  view() {
    return this.#controller.view();
  }

  roleView() {
    return this.#controller.roleView();
  }

  run(options = {}) {
    return this.#controller.run(options);
  }

  control(command, expectedRevision) {
    return this.#controller.control(command, expectedRevision);
  }

  async workerView() {
    const role = await this.#controller.roleView();
    return { enabled: role.enabled, paused: role.paused };
  }

  #decisionEngineFor(input) {
    const risk = assignedTaskRisk(input, this.#canProposeCodeAction);
    if (risk === "invalid") {
      throw employeeError(
        "ROLE_TASK_BINDING_INVALID",
        "Configured role received an invalid assigned task binding",
        409,
      );
    }
    if (risk === "task" && this.#taskDecisionEngine === null) {
      throw employeeError(
        "ROLE_TASK_BRAIN_NOT_CONFIGURED",
        "Configured role requires an explicit task brain for this work",
        503,
      );
    }
    return risk === "task"
      ? this.#taskDecisionEngine
      : this.#routineDecisionEngine;
  }

  async #activeRole(signal) {
    throwIfDecisionAborted(signal);
    const role = await this.#controller.roleView();
    throwIfDecisionAborted(signal);
    if (!role.enabled) {
      throw employeeError("ROLE_DISABLED", "Configured role is disabled", 409);
    }
    if (role.paused) {
      throw employeeError("ROLE_PAUSED", "Configured role is paused", 409);
    }
    return role;
  }

  async #assertRoleUnchanged(before, signal) {
    const after = await this.#activeRole(signal);
    if (after.revision !== before.revision) {
      throw employeeError(
        "ROLE_STATE_CHANGED",
        "Configured role state changed while deciding",
        409,
      );
    }
  }

  async checkAvailability(input = {}) {
    const signal = decisionSignal(input);
    const before = await this.#activeRole(signal);
    const decisionEngine = this.#decisionEngineFor(input);
    await decisionEngine.checkAvailability({
      ...(signal === null ? {} : { signal }),
    });
    throwIfDecisionAborted(signal);
    await this.#assertRoleUnchanged(before, signal);
  }

  async decide(input) {
    const signal = decisionSignal(input);
    const before = await this.#activeRole(signal);
    const decisionEngine = this.#decisionEngineFor(input);
    const decision = await decisionEngine.decide(input);
    throwIfDecisionAborted(signal);
    await this.#assertRoleUnchanged(before, signal);
    return decision;
  }

  async withDecisionAdmission(input, operation) {
    const signal = decisionSignal(input);
    const before = await this.#activeRole(signal);
    const engine = this.#decisionEngineFor(input);
    const item = input?.item;
    const event = item ? currentWorkItemEvent(item) : null;
    const kind = event?.eventType?.startsWith('pull_request.') ? 'pull_request' : event?.eventType?.startsWith('issue.') ? 'issue' : null;
    const entityKey = kind && typeof event.subject?.repository === 'string' && Number.isSafeInteger(event.subject?.number) && event.subject.number > 0
      ? githubEntitySessionKey({kind,repository:event.subject.repository,number:event.subject.number})
      : `work-item:${item?.itemId ?? this.workerId}`;
    return engine.withAdmission({entityKey,signal,
      ...(this.#waitForModelCapacity ? {waitForCapacity:true} : {})}, async () => {
      throwIfDecisionAborted(signal);
      await this.#assertRoleUnchanged(before,signal);
      return operation();
    });
  }

  asRoleWorker() {
    return this.#workerPort;
  }
}
