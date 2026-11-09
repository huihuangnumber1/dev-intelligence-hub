import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { withTaskExecution } from '../lib/task-execution-context.js';
import {TaskRunExecutionReceipts,executionReceiptView,normalizeNativeFailure} from './task-run-execution-receipts.js';

export const TASK_RUN_STATE_KEY = "task-run-settings";
const MAX_RECORDS = 1_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_BYTES = 4_000;
const MAX_ROUNDS = 5;
const MAX_EVENTS = 120;
const MAX_EVENT_CHARACTERS = 2_000;
const SESSION_STATUSES = new Set(["starting", "running", "completed", "interrupted", "failed"]);
const EVENT_TYPES = new Set(["message", "tool", "plan", "status"]);
const KINDS = new Set(["work-item", "code-job"]);
const PRIORITIES = new Map([["normal", 0], ["high", 1], ["urgent", 2]]);
const MODES = new Set(["active", "paused", "cancelled"]);
const STORED_PHASES = new Set(["idle", "waiting_checkpoint", "paused", "cancelled"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/u;

export class TaskRunControlError extends Error {
  constructor(code, message, statusCode = 409, options) {
    super(message, options);
    this.name = "TaskRunControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function registryError(code, message, statusCode = 409) {
  return new TaskRunControlError(code, message, statusCode);
}

function invalidInput() {
  return registryError("TASK_RUN_INPUT_INVALID", "运行任务控制输入无效", 400);
}

function invalidState() {
  return registryError("TASK_RUN_STATE_INVALID", "运行任务设置状态无效", 500);
}

function conflict() {
  return registryError("TASK_RUN_CONFLICT", "任务运行或修订号已变化，请刷新后重试");
}

function capacityExceeded() {
  return registryError("TASK_RUN_CAPACITY_EXCEEDED", "运行任务设置容量已满", 507);
}

function heldError(mode) {
  return mode === "cancelled"
    ? registryError("TASK_RUN_CANCELLED", "任务已在安全检查点取消")
    : registryError("TASK_RUN_PAUSED", "任务已在安全检查点暂停");
}

function plainKeys(value, error) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw error;
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable ||
        !("value" in descriptor)) throw error;
  }
  return keys;
}

function exactKeys(value, required, optional, error) {
  const keys = plainKeys(value, error);
  if (required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw error;
  }
}

function denseArray(value, maximum, error) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) throw error;
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    entries.push(descriptor.value);
  }
  return entries;
}

function revision(value, error) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw error;
  return value;
}

function increment(value) {
  if (value === Number.MAX_SAFE_INTEGER) throw capacityExceeded();
  return value + 1;
}

function identifier(value, error) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw error;
  return value;
}

function identity(kind, taskId, error = invalidInput()) {
  if (!KINDS.has(kind)) throw error;
  identifier(taskId, error);
  return `${kind}:${taskId}`;
}

function timestamp(value, error) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) throw error;
  return value;
}

function displayText(value, maximum, error) {
  if (typeof value !== "string" || value.length > MAX_STATE_BYTES) throw error;
  const cleaned = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(cleaned, "utf8") <= maximum) return cleaned;
  let result = "";
  let size = 0;
  for (const character of cleaned) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > maximum) break;
    result += character;
    size += bytes;
  }
  return result;
}

function normalizeSession(value) {
  const error = invalidInput();
  exactKeys(value, ["transport", "threadId", "turnId", "status"], [], error);
  if (value.transport !== "app-server" || !SESSION_STATUSES.has(value.status)) throw error;
  identifier(value.threadId, error);
  if (value.turnId !== null) identifier(value.turnId, error);
  return { ...value };
}

function eventText(value) {
  if (typeof value !== "string" || value.length > MAX_STATE_BYTES) throw invalidInput();
  return value.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
}

function boundedEventText(text) {
  if (text.length <= MAX_EVENT_CHARACTERS) return text;
  let tail = text.slice(-(MAX_EVENT_CHARACTERS - 1));
  // Do not begin the displayed tail halfway through a surrogate pair.
  if (/^[\udc00-\udfff]/u.test(tail)) tail = tail.slice(1);
  return `…${tail}`;
}

function reportEvent(run, value, at) {
  const error = invalidInput();
  exactKeys(value, ["type", "text"], ["itemId"], error);
  if (!EVENT_TYPES.has(value.type)) throw error;
  if ("itemId" in value) identifier(value.itemId, error);
  const text = eventText(value.text);
  if (!text) return;
  const previous = run.events.at(-1);
  const merging = value.type === "message" && value.itemId &&
    previous?.type === "message" && previous.itemId === value.itemId;
  const event = { sequence: ++run.eventSequence, at, type: value.type,
    text: boundedEventText(merging ? previous.text + text : text),
    ...("itemId" in value ? { itemId: value.itemId } : {}) };
  if (merging) run.events[run.events.length - 1] = event;
  else {
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.shift();
  }
  run.lastActivityAt = at;
}

function normalizeTask(value, error = invalidInput(), stored = false) {
  exactKeys(value, ["kind", "taskId", "roleId", "title", "subject", "revision"], ["leaseId"], error);
  identity(value.kind, value.taskId, error);
  identifier(value.roleId, error);
  revision(value.revision, error);
  if ("leaseId" in value) identifier(value.leaseId, error);
  const title = displayText(value.title, 500, error);
  const subject = displayText(value.subject, 1_000, error);
  if (stored && (title !== value.title || subject !== value.subject)) throw error;
  return {
    kind: value.kind,
    taskId: value.taskId,
    roleId: value.roleId,
    title,
    subject,
    revision: value.revision,
    ...("leaseId" in value ? { leaseId: value.leaseId } : {}),
  };
}

function instructionText(value, error) {
  if (typeof value !== "string" || !value.trim() ||
      Buffer.byteLength(value, "utf8") > MAX_INSTRUCTION_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw error;
  return value.trim();
}

function normalizeControl(value) {
  const error = invalidInput();
  const keys = plainKeys(value, error);
  if (!keys.includes("command")) throw error;
  const commandFields = {
    instruct: ["instruction"], priority: ["priority"], pause: [], resume: [], cancel: [],
  };
  if (typeof value.command !== "string" || !Object.hasOwn(commandFields, value.command)) throw error;
  exactKeys(value, ["runId", "expectedRevision", "command", ...commandFields[value.command]], [], error);
  if (typeof value.runId !== "string" || !UUID.test(value.runId)) throw error;
  revision(value.expectedRevision, error);
  if (value.command === "instruct") return { ...value, instruction: instructionText(value.instruction, error) };
  if (value.command === "priority" && !PRIORITIES.has(value.priority)) throw error;
  return { ...value };
}

function normalizeRecord(value) {
  const error = invalidState();
  exactKeys(value, ["task", "runId", "revision", "startedAt", "priority", "instructions",
    "appliedRevision", "pendingCommand", "mode", "phase"], ["stopUnconfirmed","terminalStatus"], error);
  if ("stopUnconfirmed" in value && (value.stopUnconfirmed !== true || value.pendingCommand === null)) throw error;
  if ('terminalStatus' in value && (!['completed','failed','fenced','cancelled'].includes(value.terminalStatus) || value.pendingCommand !== null || value.mode !== 'active')) throw error;
  const task = normalizeTask(value.task, error, true);
  if (typeof value.runId !== "string" || !UUID.test(value.runId) ||
      !PRIORITIES.has(value.priority) || !MODES.has(value.mode) ||
      !STORED_PHASES.has(value.phase)) throw error;
  timestamp(value.startedAt, error);
  revision(value.revision, error);
  revision(value.appliedRevision, error);
  if (value.revision === 0 || value.appliedRevision > value.revision) throw error;
  const instructions = denseArray(value.instructions, MAX_INSTRUCTIONS, error).map((entry) => {
    exactKeys(entry, ["text", "at"], [], error);
    if (instructionText(entry.text, error) !== entry.text) throw error;
    timestamp(entry.at, error);
    return { text: entry.text, at: entry.at };
  });
  if (instructions.length > value.revision) throw error;
  const expectedCommand = { active: null, paused: "pause", cancelled: "cancel" }[value.mode];
  if (value.pendingCommand !== null && value.pendingCommand !== expectedCommand) throw error;
  if ((value.pendingCommand !== null) !== (value.phase === "waiting_checkpoint") ||
      (value.pendingCommand === null && value.phase !== (value.mode === "active" ? "idle" : value.mode))) {
    throw error;
  }
  return { ...value, task, instructions };
}

function emptyState() {
  return { schemaVersion: 1, revision: 0, records: [] };
}

function normalizeState(value) {
  const error = invalidState();
  exactKeys(value, ["schemaVersion", "revision", "records"], [], error);
  if (value.schemaVersion !== 1) throw error;
  revision(value.revision, error);
  const records = denseArray(value.records, MAX_RECORDS, error).map(normalizeRecord);
  const keys = records.map(({ task }) => identity(task.kind, task.taskId, error));
  if (new Set(keys).size !== keys.length || records.some((entry) => entry.revision > value.revision)) throw error;
  const state = { schemaVersion: 1, revision: value.revision, records };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) throw error;
  return state;
}

function findRecord(state, key) {
  return state.records.find(({ task }) => identity(task.kind, task.taskId) === key);
}

function defaultRecord(run) {
  return {
    task: run.task,
    runId: run.runId,
    revision: 0,
    startedAt: run.startedAt,
    priority: "normal",
    instructions: [],
    appliedRevision: 0,
    pendingCommand: null,
    mode: "active",
    phase: "idle",
  };
}

function runView(record, run) {
  const { task } = record;
  const waiting = record.pendingCommand !== null ||
    (run && record.instructions.length !== run.instructionCount);
  return {
    kind: task.kind,
    taskId: task.taskId,
    runId: run?.runId ?? record.runId,
    revision: record.revision,
    roleId: task.roleId,
    title: task.title,
    subject: task.subject,
    startedAt: run?.startedAt ?? record.startedAt,
    phase: run ? (waiting ? "waiting_checkpoint" : run.phase) :
      (record.pendingCommand === null ? record.terminalStatus ?? record.phase : "control_failed"),
    priority: record.priority,
    instructions: record.instructions.map((entry) => ({ ...entry })),
    appliedRevision: run?.appliedRevision ?? record.appliedRevision,
    pendingCommand: record.pendingCommand,
    mode: run ? "active" : record.mode,
    active: Boolean(run),
    live: Boolean(run?.liveControl),
    progress: run?.progress ?? '',
    lastActivityAt: run?.lastActivityAt ?? record.startedAt,
    instructionReceipt: run?.instructionReceipt ?? (run?.liveControl ? 'ready' : 'checkpoint'),
    stopUnconfirmed: record.stopUnconfirmed === true,
    session: run?.session ? { ...run.session } : null,
    events: run?.events.map((event) => ({ ...event })) ?? [],
    ...(run?.receipt ? {receipt:structuredClone(run.receipt)} : {}),
  };
}

export class TaskRunRegistry {
  #queue = new OperationQueue();
  #active = new Map();
  #knownState = null;
  #receipts;

  constructor({ store, receiptStore = null, clock = () => new Date(), settleControl, verifyStopped = async () => false } = {}) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function" ||
        typeof clock !== "function" || typeof settleControl !== "function" || typeof verifyStopped !== 'function') {
      throw new TypeError("TaskRunRegistry dependencies are invalid");
    }
    this.store = store;
    this.clock = clock;
    this.settleControl = settleControl;
    this.verifyStopped = verifyStopped;
    if(receiptStore && (typeof receiptStore.read!=='function' || typeof receiptStore.write!=='function'))throw new TypeError('receiptStore is invalid');
    this.#receipts=receiptStore ? new TaskRunExecutionReceipts(receiptStore) : null;
  }

  async run(input, operation, {repeatOnInstruction = true, requireStopConfirmation = false} = {}) {
    const task = normalizeTask(input);
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const run = await this.#queue.enqueue(() => this.#register(task));
    run.repeatOnInstruction = repeatOnInstruction;
    run.requireStopConfirmation = requireStopConfirmation;
    let outcomeError;
    try {
      let instructions = run.instructions;
      for (let round = 1; ; round += 1) {
        let result;
        const scope = Symbol("task execution round");
        run.scope = scope;
        const current = () => run.scope === scope && this.#active.get(run.key) === run;
        const context = {
          reportActivity: () => {if(current()){run.lastActivityAt=this.#now();this.#recordReceipt(run);}},
          reportModelState: (phase) => {
            if(!current())return;
            if(!['waiting_model','starting_model','running'].includes(phase))throw invalidInput();
            run.phase=phase;run.lastActivityAt=this.#now();
            if(phase==='running')run.modelStartedAt??=run.lastActivityAt;
            this.#recordReceipt(run);
          },
          reportProgress: (text) => { if (current()) { run.progress = displayText(text, 500, invalidInput()); run.lastActivityAt = this.#now(); this.#recordReceipt(run); } },
          reportSession: (session) => { if (current()) {
            run.session = normalizeSession(session); run.lastActivityAt = this.#now();
            if(session.status==='starting')run.phase='starting_model';
            if(session.status==='running') {run.phase='running';run.modelStartedAt??=run.lastActivityAt;}
            this.#recordReceipt(run);
          } },
          reportEvent: (event) => { if (current()) { reportEvent(run, event, this.#now()); this.#recordReceipt(run); } },
          reportNativeFailure: (value) => { if(current() && !run.nativeFailure) {
            run.nativeFailure=normalizeNativeFailure(value);run.lastActivityAt=this.#now();this.#recordReceipt(run);
          } },
          registerLiveControl: (control) => {
            if (!current()) return () => {};
            if (typeof control?.steer !== 'function' || typeof control?.interrupt !== 'function') throw invalidInput();
            run.liveControl = control;
            return () => { if (current() && run.liveControl === control) run.liveControl = null; };
          },
          confirmStopped: () => { if (current()) {run.stoppedConfirmed = true;this.#recordReceipt(run);} },
          assertRunning: () => {
            if (!current()) throw registryError("TASK_RUN_NOT_ACTIVE", "任务运行已结束");
            if (run.stopRequested) throw heldError(run.stopRequested);
          },
          hasPendingInstructions: () => current() && run.savedInstructionCount !== run.instructionCount,
          beginCompletion: () => this.#queue.enqueue(async () => {
            const state = await this.#readState();
            if (!current()) throw registryError("TASK_RUN_NOT_ACTIVE", "任务运行已结束");
            if (run.stopRequested) throw heldError(run.stopRequested);
            const record = findRecord(state, run.key);
            if (record && record.mode !== "active") throw heldError(record.mode);
            // A store acknowledgement can fail after the instruction was persisted.
            run.savedInstructionCount = record?.instructions.length ?? 0;
            if (run.savedInstructionCount !== run.instructionCount) return false;
            // Close instruction acceptance before any asynchronous final action begins.
            run.instructionsClosed = true;
            return true;
          }),
        };
        try {
          try { result = await withTaskExecution(context, () => operation({ instructions: [...instructions] })); }
          finally { run.scope = null; run.liveControl = null; }
        }
        catch (error) {
          await this.#queue.enqueue(async () => {
            const state = await this.#readState();
            const current = findRecord(state, run.key);
            if (!current || current.mode === 'active') return;
            if ((error?.code === 'STRUCTURED_PROVIDER_REAP_FAILED' || run.requireStopConfirmation) && !run.stoppedConfirmed) {
              throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','停止尚未确认，等待维护核实',409,{cause:error});
            }
            await this.#checkpoint(run,round);
          });
          throw error;
        }
        const checkpoint = await this.#queue.enqueue(() => this.#checkpoint(run, round));
        if (checkpoint.done) return result;
        instructions = checkpoint.instructions;
      }
    } catch(error) { outcomeError=error;throw error; }
    finally {
      // The final checkpoint and every control share this queue, closing acceptance before dispatch.
      await this.#queue.enqueue(async () => {
        if (this.#active.get(run.key) === run) this.#active.delete(run.key);
        const code=outcomeError?.code;
        run.phase=!outcomeError?'completed':code==='TASK_RUN_PAUSED'?'paused':code==='TASK_RUN_CANCELLED'?'cancelled':
          ['STRUCTURED_PROVIDER_REAP_FAILED','TASK_RUN_CONTROL_PENDING'].includes(code)?'unknown':'failed';
        run.finishedAt=run.phase==='unknown'?null:this.#now();
        run.outcomeCode=typeof code==='string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)?code:null;
        if(!outcomeError)run.stoppedConfirmed=true;
        await this.#recordReceipt(run);
      });
    }
  }

  async list() {
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const items = [...this.#active].map(([key, run]) => runView(findRecord(state, key) ?? defaultRecord(run), run));
      const held = state.records.filter((record) => {
        const key = identity(record.task.kind, record.task.taskId);
        return !this.#active.has(key) && (record.mode === "paused" || record.pendingCommand !== null);
      }).map((record) => runView(record));
      if(!this.#receipts)return { enabled:true,items,held };
      const occupied=new Set([...items,...held].map(item=>`${item.kind}:${item.taskId}`));
      const latest=new Map();
      for(const receipt of await this.#receipts.list())latest.set(`${receipt.kind}:${receipt.taskId}`,receipt);
      const recent=[...latest].filter(([key])=>!occupied.has(key)).map(([,receipt])=>executionReceiptView(receipt));
      return {enabled:true,items,held,recent,counts:{active:items.filter(item=>item.receipt?.modelStartedAt && ['running','waiting_checkpoint'].includes(item.phase)).length,
        queued:items.filter(item=>item.phase==='waiting_model').length,preparing:items.filter(item=>['preparing','starting_model'].includes(item.phase)).length}};
    });
  }

  async reconcile() {
    return this.#queue.enqueue(async () => {
      let state = await this.#readState();
      const pending = state.records.filter((entry) => entry.pendingCommand &&
        !this.#active.has(identity(entry.task.kind,entry.task.taskId))).slice(0,20);
      for (const record of pending) {
        try { await this.#settleHeld(state,record); } catch { /* Keep unresolved holds available for maintenance. */ }
        state = await this.#readState();
      }
    });
  }

  async get(kind, taskId) {
    identity(kind, taskId);
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      return this.#view(state, kind, taskId, this.#receipts ? await this.#receipts.list() : []);
    });
  }

  // Hold the same boundary as registration and owner controls until the ledger
  // commit ends. The callback must not call this registry (lock order: runs → ledger).
  async withStoppedRuns(expected, operation) {
    if (typeof operation !== "function") throw invalidInput();
    const runs = denseArray(expected, 2, invalidInput());
    if (runs.length === 0) throw invalidInput();
    for (const run of runs) {
      plainKeys(run, invalidInput());
      if (run.kind !== "work-item") throw invalidInput();
      identity(run.kind, run.taskId);
    }
    if (new Set(runs.map(run => run.taskId)).size !== runs.length) throw invalidInput();
    return this.#queue.enqueue(async () => {
      const state = await this.#readState(), receipts = this.#receipts ? await this.#receipts.list() : [];
      for (const expectedRun of runs) {
        let current;
        try { current = this.#view(state, expectedRun.kind, expectedRun.taskId, receipts); }
        catch (error) { if (error.code === "TASK_RUN_NOT_FOUND") return { executed: false }; throw error; }
        if (current.active !== false || current.mode !== "active" || current.pendingCommand !== null ||
            current.stopUnconfirmed === true || current.phase !== "completed" || current.receipt?.stopConfirmed !== true ||
            !isDeepStrictEqual(current, expectedRun)) return { executed: false };
      }
      return { executed: true, result: await operation() };
    });
  }

  #view(state, kind, taskId, receipts) {
    const key = identity(kind, taskId), run = this.#active.get(key);
    const record = findRecord(state, key) ?? (run && defaultRecord(run));
    const receipt = receipts.findLast(entry => entry.kind === kind && entry.taskId === taskId);
    if (!run && receipt && (!record || record.mode === "active" && record.pendingCommand === null)) return executionReceiptView(receipt);
    if (!record) throw registryError("TASK_RUN_NOT_FOUND", "运行任务不存在", 404);
    return runView(record, run);
  }

  async control(kind, taskId, input) {
    const key = identity(kind, taskId);
    const command = normalizeControl(input);
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const run = this.#active.get(key);
      const current = findRecord(state, key) ?? (run && defaultRecord(run));
      if (!current) throw registryError("TASK_RUN_NOT_FOUND", "运行任务不存在", 404);
      if (command.runId !== (run?.runId ?? current.runId) ||
          command.expectedRevision !== current.revision) throw conflict();
      return this.#applyControl(state, current, run, command);
    });
  }

  async order(items, kind, idKey) {
    if (!KINDS.has(kind) || typeof idKey !== "string" || !idKey ||
        ["__proto__", "constructor", "prototype"].includes(idKey)) throw invalidInput();
    const candidates = denseArray(items, 10_000, invalidInput()).map((item, index) => {
      plainKeys(item, invalidInput());
      return { item, index, key: identity(kind, item[idKey]) };
    });
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const settings = new Map(state.records.map((entry) => [identity(entry.task.kind, entry.task.taskId), entry]));
      return candidates.filter(({ key,item }) => (settings.get(key)?.mode ?? "active") === "active" ||
        (kind === 'code-job' && ['pausing','cancelling','unknown'].includes(item.status)))
        .sort((a, b) => PRIORITIES.get(settings.get(b.key)?.priority ?? "normal") -
          PRIORITIES.get(settings.get(a.key)?.priority ?? "normal") || a.index - b.index)
        .map(({ item }) => item);
    });
  }

  async #register(task) {
    const key = identity(task.kind, task.taskId);
    const state = await this.#readState();
    if (this.#active.has(key)) throw conflict();
    const current = findRecord(state, key);
    if (current && current.mode !== "active") throw heldError(current.mode);
    const run = {
      key, task, runId: randomUUID(), startedAt: this.#now(),
      appliedRevision: current?.revision ?? 0,
      instructionCount: current?.instructions.length ?? 0,
      savedInstructionCount: current?.instructions.length ?? 0,
      instructions: current?.instructions.map(({ text }) => text) ?? [],
      session: null, events: [], eventSequence: 0,
      phase:'preparing',modelStartedAt:null,lastActivityAt:this.#now(),stoppedConfirmed:false,
    };
    if (current) {
      await this.#writeRecord(state, {
        ...current, task, runId: run.runId, startedAt: run.startedAt,
        appliedRevision: run.appliedRevision,
      });
    }
    await this.#recordReceipt(run);
    this.#active.set(key, run);
    return run;
  }

  async #applyControl(state, current, run, input) {
    const { command } = input;
    if (command === "instruct" && run?.instructionsClosed) {
      throw registryError("TASK_RUN_INSTRUCTIONS_CLOSED", "任务正在完成，无法接收追加要求");
    }
    const acceptsPausedInstruction = command === 'instruct' && !run && current.mode === 'paused' &&
      current.pendingCommand === null && current.stopUnconfirmed !== true && !current.terminalStatus;
    if ((["instruct", "pause"].includes(command) && !run && !acceptsPausedInstruction) ||
        (command === "cancel" && !run && current.mode === "active")) {
      throw registryError("TASK_RUN_NOT_ACTIVE", "任务当前没有正在运行的模型回合");
    }
    if (command === "resume") return this.#resume(state, current, run);
    if ((command === "pause" && current.mode !== "active") ||
        (command === "cancel" && current.mode === "cancelled" && current.pendingCommand === null)) {
      throw conflict();
    }
    const candidate = {
      ...current,
      revision: increment(current.revision),
      appliedRevision: run?.appliedRevision ?? current.appliedRevision,
    };
    if (command === "instruct") {
      if (current.instructions.length === MAX_INSTRUCTIONS) throw capacityExceeded();
      candidate.instructions = [...current.instructions, { text: input.instruction, at: this.#now() }];
    } else if (command === "priority") {
      candidate.priority = input.priority;
    } else {
      candidate.mode = command === "pause" ? "paused" : "cancelled";
      candidate.pendingCommand = command;
      candidate.phase = "waiting_checkpoint";
      if (run?.repeatOnInstruction || run?.requireStopConfirmation) candidate.stopUnconfirmed = true;
    }
    const committed = await this.#writeRecord(state, candidate);
    if (run && command === "instruct") run.savedInstructionCount = candidate.instructions.length;
    if (run && ['pause','cancel'].includes(command)) run.stopRequested = candidate.mode;
    if (run?.liveControl && command === 'instruct') {
      try {
        await run.liveControl.steer(input.instruction, `${run.runId}:${candidate.revision}`);
        run.instructionCount = candidate.instructions.length;
        run.appliedRevision = candidate.revision;
        run.instructionReceipt = 'submitted';
      } catch (cause) {
        run.instructionReceipt = 'failed';
        throw new TaskRunControlError('TASK_RUN_STEER_FAILED','追加要求未确认送达；已保存，将在安全检查点续接',409,{cause});
      }
    } else if (run?.liveControl && ['pause','cancel'].includes(command)) {
      await run.liveControl.interrupt();
    }
    if (command === "cancel" && !run) {
      return runView(await this.#settleHeld(committed, candidate));
    }
    return runView(candidate, run);
  }

  async #resume(state, current, run) {
    if (run || current.mode !== "paused") throw conflict();
    if (current.pendingCommand) {
      current = await this.#settleHeld(state,current);
      if (current.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','停止尚未确认，不能恢复');
      if (current.terminalStatus) throw registryError('TASK_RUN_TERMINAL','原任务已结束，请刷新查看最终状态');
      state = await this.#readState();
    }
    await this.settleControl({ task: structuredClone(current.task), command: "resume" });
    const candidate = {
      ...current, revision: increment(current.revision), mode: "active",
      phase: "idle", pendingCommand: null,
    };
    await this.#writeRecord(state, candidate);
    return runView(candidate);
  }

  async #checkpoint(run, round) {
    let state = await this.#readState();
    let current = findRecord(state, run.key);
    if (current && current.mode !== "active") {
      if (run.requireStopConfirmation && !run.stoppedConfirmed) {
        throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','停止尚未确认，等待执行器和原生进程收尾',409);
      }
      let settled;
      try {
        if (current.stopUnconfirmed) {
          const {stopUnconfirmed,...confirmed} = current;
          state = await this.#writeRecord(state,confirmed);
          current = confirmed;
        }
        settled = await this.#settleHeld(state, current);
      } catch(cause) {
        throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','控制已保存，等待台账核对',409,{cause});
      }
      this.#active.delete(run.key);
      if (settled.terminalStatus) return {done:true};
      if (settled.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','停止请求已保存，等待执行器核对');
      throw heldError(current.mode);
    }
    if (run.repeatOnInstruction && current && current.instructions.length !== run.instructionCount) {
      if (round >= MAX_ROUNDS) {
        current = {
          ...current, revision: increment(current.revision), mode: "paused",
          phase: "waiting_checkpoint", pendingCommand: "pause",
          appliedRevision: run.appliedRevision,
        };
        state = await this.#writeRecord(state, current);
        try {
          const settled = await this.#settleHeld(state, current);
          if (settled.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','补充要求变化过于频繁，暂停仍等待核对');
        } catch(cause) {
          if (cause instanceof TaskRunControlError) throw cause;
          throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','补充要求变化过于频繁，暂停仍等待核对',409,{cause});
        }
        this.#active.delete(run.key);
        throw registryError("TASK_RUN_ADJUSTMENT_LIMIT", "任务补充要求变化过于频繁，已暂停等待恢复");
      }
      run.appliedRevision = current.revision;
      run.instructionCount = current.instructions.length;
      return { done: false, instructions: current.instructions.map(({ text }) => text) };
    }
    if (current && current.appliedRevision !== run.appliedRevision) {
      await this.#writeRecord(state, { ...current, appliedRevision: run.appliedRevision });
    }
    this.#active.delete(run.key);
    return { done: true };
  }

  async #settleHeld(state, current) {
    if (current.stopUnconfirmed && !(await this.verifyStopped(structuredClone(current.task)))) return current;
    const command = current.mode === "paused" ? "pause" : "cancel";
    const outcome = await this.settleControl({ task: structuredClone(current.task), command });
    if (outcome?.pending) return current;
    const {stopUnconfirmed,...record} = current;
    const settled = outcome?.terminalStatus ? {...record,pendingCommand:null,phase:'idle',mode:'active',terminalStatus:outcome.terminalStatus} :
      { ...record, pendingCommand: null, phase: current.mode };
    await this.#writeRecord(state, settled);
    return settled;
  }

  async #readState() {
    const state = normalizeState(await this.store.read(TASK_RUN_STATE_KEY, emptyState()));
    if (this.#knownState && (state.revision < this.#knownState.revision ||
        state.revision === this.#knownState.revision && JSON.stringify(state) !== JSON.stringify(this.#knownState))) {
      throw invalidState();
    }
    this.#knownState = state;
    return state;
  }

  async #writeRecord(state, record) {
    const key = identity(record.task.kind, record.task.taskId);
    const index = state.records.findIndex(({ task }) => identity(task.kind, task.taskId) === key);
    const records = [...state.records];
    if (index < 0) records.push(record);
    else records[index] = record;
    if (records.length > MAX_RECORDS) throw capacityExceeded();
    const candidate = { schemaVersion: 1, revision: increment(state.revision), records };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_STATE_BYTES) throw capacityExceeded();
    const normalized = normalizeState(candidate);
    await this.store.write(TASK_RUN_STATE_KEY, normalized);
    this.#knownState = normalized;
    return normalized;
  }

  #now() {
    const value = this.clock();
    const error = registryError("TASK_RUN_CLOCK_INVALID", "运行任务时钟无效", 500);
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw error;
      return value.toISOString();
    }
    return timestamp(value, error);
  }

  #recordReceipt(run) {
    if(!this.#receipts)return;
    run.receipt={runId:run.runId,kind:run.task.kind,taskId:run.task.taskId,roleId:run.task.roleId,
      taskRevision:run.task.revision,leaseId:run.task.leaseId??null,registeredAt:run.startedAt,
      modelStartedAt:run.modelStartedAt,lastActivityAt:run.lastActivityAt??run.startedAt,
      finishedAt:run.finishedAt??null,phase:run.phase,stopConfirmed:run.stoppedConfirmed===true,
      session:run.session ? {...run.session}:null,eventCount:run.eventSequence,outcomeCode:run.outcomeCode??null,
      ...(run.nativeFailure?{nativeFailure:{...run.nativeFailure}}:{})};
    const recorded=this.#receipts.record(run.receipt);
    void recorded.catch(()=>{}); // Synchronous event callbacks report persistence failure at the next read/checkpoint.
    return recorded;
  }
}
