import assert from "node:assert/strict";
import test from "node:test";
import { EmployeeController } from "../src/services/employee-controller.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : fallback;
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function createEmployee({ id, store, calls, stateKey = `${id}-state` }) {
  let controller;
  controller = new EmployeeController({
    definition: {
      id,
      name: id === "pr-reviewer" ? "PR 推进员工" : "需求分析员工",
      mission: `负责 ${id}`,
      enabled: true,
    },
    store,
    stateKey,
    createState: () => ({ revision: 0, paused: false, runs: [] }),
    normalizeState: (state) => ({
      revision: Number.isInteger(state?.revision) ? state.revision : 0,
      paused: Boolean(state?.paused),
      runs: Array.isArray(state?.runs) ? state.runs : [],
    }),
    resolveState: (state, enabled) => {
      if (!enabled) return "disabled";
      return state.paused ? "paused" : "observing";
    },
    projectWork: (state) => ({ runs: state.runs }),
    run: async ({ state, trigger }) => {
      calls.push({ id, operation: "run", trigger });
      return controller.writeState({
        ...state,
        runs: [...state.runs, trigger],
      });
    },
  });
  return controller;
}

test("two employees are discovered and controlled independently", async () => {
  const store = new MemoryStore();
  const calls = [];
  const prReviewer = createEmployee({ id: "pr-reviewer", store, calls });
  const analyst = createEmployee({
    id: "requirements-analyst",
    store,
    calls,
  });
  const registry = new EmployeeRegistry([prReviewer, analyst]);

  const initial = await registry.list();
  await registry.run("requirements-analyst", { trigger: "manual" });
  await registry.control(
    "pr-reviewer",
    "pause",
    initial.find((employee) => employee.role.id === "pr-reviewer").role.revision,
  );
  const current = await registry.list();

  assert.deepEqual(
    initial.map((employee) => employee.role.id),
    ["pr-reviewer", "requirements-analyst"],
  );
  assert.deepEqual(calls, [
    { id: "requirements-analyst", operation: "run", trigger: "manual" },
  ]);
  assert.equal(
    current.find((employee) => employee.role.id === "pr-reviewer").role.state,
    "paused",
  );
  assert.deepEqual(
    current.find((employee) => employee.role.id === "requirements-analyst")
      .runs,
    ["manual"],
  );
});

test("registry can run only legacy-selected employees", async () => {
  const store = new MemoryStore();
  const calls = [];
  const registry = new EmployeeRegistry([
    createEmployee({ id: "pr-reviewer", store, calls }),
    createEmployee({ id: "requirements-analyst", store, calls }),
  ]);

  await registry.runSelected(["pr-reviewer"], { trigger: "refresh_completed" });

  assert.deepEqual(calls, [
    { id: "pr-reviewer", operation: "run", trigger: "refresh_completed" },
  ]);
});

test("employee lifecycle state survives controller recreation", async () => {
  const store = new MemoryStore();
  const first = createEmployee({ id: "pr-reviewer", store, calls: [] });
  const initial = await first.view();
  const paused = await first.control("pause", initial.role.revision);

  const recreated = createEmployee({ id: "pr-reviewer", store, calls: [] });
  const restored = await recreated.view();

  assert.equal(restored.role.paused, true);
  assert.equal(restored.role.revision, paused.role.revision);
  assert.equal(restored.role.state, "paused");
});

test("concurrent run requests share one in-flight employee run", async () => {
  const store = new MemoryStore();
  let releaseRun;
  let markStarted;
  const gate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  let controller;
  controller = new EmployeeController({
    definition: { id: "pr-reviewer", enabled: true },
    store,
    stateKey: "pr-reviewer-state",
    run: async ({ state }) => {
      calls += 1;
      markStarted();
      await gate;
      return controller.writeState(state);
    },
  });

  const first = controller.run({ trigger: "scheduled" });
  await started;
  const second = controller.run({ trigger: "manual" });
  releaseRun();
  await Promise.all([first, second]);

  assert.strictEqual(second, first);
  assert.equal(calls, 1);
});

test("targeted employee runs wait for unrelated work, coalesce identical targets, and preserve a hidden abort signal", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const calls = [];
  const controller = new EmployeeController({ definition: { id: 'developer' }, store: new MemoryStore(), stateKey: 'developer-state',
    async run({ state, continuationTarget, signal }) {
      calls.push(continuationTarget?.itemId ?? 'ordinary');
      if (!continuationTarget) { started(); await gate; }
      else assert.equal(signal, abort.signal);
      return state;
    } });
  const abort = new AbortController();
  const first = controller.run(); await running;
  const options = { continuationTarget: { itemId: 'work-target', fingerprint: 'a'.repeat(64) } };
  Object.defineProperty(options, 'signal', { value: abort.signal });
  const target = controller.run(options);
  assert.equal(controller.run(options), target);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['ordinary']);
  release(); await Promise.all([first, target]);
  assert.deepEqual(calls, ['ordinary', 'work-target']);
});

test("cancelling a queued target never cancels its current role owner or starts it later", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const calls = [];
  const controller = new EmployeeController({ definition: { id: 'developer' }, store: new MemoryStore(), stateKey: 'developer-state',
    async run({ state, continuationTarget }) { calls.push(continuationTarget?.itemId ?? 'ordinary'); started(); await gate; return state; } });
  const first = controller.run(); await running;
  const abort = new AbortController();
  const target = controller.run({ continuationTarget: { itemId: 'work-target', fingerprint: 'a'.repeat(64) }, signal: abort.signal });
  abort.abort(new Error('target cancelled'));
  await assert.rejects(target, /target cancelled/);
  assert.deepEqual(calls, ['ordinary']);
  release(); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['ordinary']);
});

test("a role pause queued before targeted execution is rechecked after its existing owner settles", async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const calls = [];
  const controller = new EmployeeController({ definition: { id: 'developer' }, store: new MemoryStore(), stateKey: 'developer-state',
    async run({ state, continuationTarget }) { calls.push(continuationTarget?.itemId ?? 'ordinary'); started(); await gate; return state; } });
  const first = controller.run(); await running;
  const target = controller.run({ continuationTarget: { itemId: 'work-target', fingerprint: 'a'.repeat(64) } });
  const pause = controller.control('pause', 0);
  release(); await Promise.all([first, pause, target]);
  assert.deepEqual(calls, ['ordinary']);
  assert.equal((await controller.roleView()).paused, true);
});

test("a failed employee run releases the in-flight lock for the next run", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const controller = new EmployeeController({
    definition: { id: "pr-reviewer", enabled: true },
    store,
    stateKey: "pr-reviewer-state",
    run: async ({ state }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary model failure");
      return controller.writeState(state);
    },
  });

  await assert.rejects(
    controller.run({ trigger: "scheduled" }),
    /temporary model failure/,
  );
  assert.equal(controller.running, null);

  await controller.run({ trigger: "manual" });

  assert.equal(attempts, 2);
  assert.equal(controller.running, null);
});

test("responsive role controls persist while its current cycle is waiting and survive stale cycle writes", async (t) => {
  let release, markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  t.after(() => release());
  let calls = 0;
  let controller;
  controller = new EmployeeController({
    definition: { id: 'developer' }, store: new MemoryStore(), stateKey: 'developer-state',
    responsiveControls: true,
    async run({ state }) {
      calls += 1; markStarted(); await gate;
      return controller.writeState({ ...state, lastRun: 'finished' });
    },
  });
  const run = controller.run();
  await started;
  const result = await Promise.race([
    controller.control('pause', 0),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('pause waited for the blocked cycle')), 250); timer.unref(); }),
  ]);
  assert.equal(result.role.paused, true);
  await assert.rejects(controller.control('resume', 0), { statusCode: 409 });
  release(); await run;
  assert.equal((await controller.roleView()).paused, true);
  assert.equal((await controller.readState()).lastRun, 'finished');
  await controller.run();
  assert.equal(calls, 1);
  const paused = await controller.roleView();
  await controller.control('resume', paused.revision);
  await controller.run();
  assert.equal(calls, 2);
});

test("role discovery does not build the employee work projection", async () => {
  const store = new MemoryStore();
  let workProjections = 0;
  const controller = new EmployeeController({
    definition: { id: "pr-reviewer", enabled: true },
    store,
    stateKey: "pr-reviewer-state",
    run: async ({ state }) => state,
    projectWork: () => {
      workProjections += 1;
      return { jobs: [] };
    },
  });

  const role = await controller.roleView();

  assert.equal(role.id, "pr-reviewer");
  assert.equal(workProjections, 0);
});

test("registry rejects unknown and duplicate employee ids", async () => {
  const store = new MemoryStore();
  const employee = createEmployee({ id: "pr-reviewer", store, calls: [] });
  const registry = new EmployeeRegistry([employee]);

  await assert.rejects(
    registry.run("missing-role", { trigger: "manual" }),
    (error) => error.statusCode === 404,
  );
  assert.throws(
    () => registry.register(employee),
    /岗位 id 已注册: pr-reviewer/,
  );
  assert.throws(
    () =>
      registry.register(
        createEmployee({ id: "qa_reviewer", store, calls: [] }),
      ),
    /岗位 id 只能包含小写字母、数字和连字符/,
  );
});
