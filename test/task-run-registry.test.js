import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/lib/state-store.js";
import { currentTaskExecution } from "../src/lib/task-execution-context.js";
import {
  TASK_RUN_STATE_KEY,
  TaskRunControlError,
  TaskRunRegistry,
} from "../src/services/task-run-registry.js";

const NOW = "2026-10-13T08:00:00.000Z";

test('live session output is bound to its run, sanitized, cloned and never persisted', async () => {
  const {registry,store}=fixture();const entered=deferred(),finish=deferred();let context;
  const result=registry.run(task(),async()=>{context=currentTaskExecution();entered.resolve();await finish.promise;return 'done';});
  await entered.promise;
  assert.equal((await registry.get('work-item','work-1')).session,null);
  context.reportSession({transport:'app-server',threadId:'thread-1',turnId:null,status:'starting'});
  context.reportSession({transport:'app-server',threadId:'thread-1',turnId:'turn-1',status:'running'});
  context.reportEvent({type:'message',itemId:'message-1',text:'\u001b[31mReading\u001b[0m\n'});
  context.reportEvent({type:'message',itemId:'message-1',text:'code\u0000\u001b]0;private-title\u0007'});
  context.reportEvent({type:'tool',itemId:'tool-1',text:'Read Source/example.cpp'});
  context.reportEvent({type:'message',itemId:'message-1',text:'Finished reading'});
  const view=await registry.get('work-item','work-1');
  assert.deepEqual(view.session,{transport:'app-server',threadId:'thread-1',turnId:'turn-1',status:'running'});
  assert.deepEqual(view.events.map(({type,text,itemId})=>({type,text,itemId})),[
    {type:'message',text:'Reading\ncode',itemId:'message-1'},
    {type:'tool',text:'Read Source/example.cpp',itemId:'tool-1'},
    {type:'message',text:'Finished reading',itemId:'message-1'},
  ]);
  assert.ok(view.events.every((event)=>event.at===NOW));
  assert.ok(view.events.every((event,index)=>index===0||event.sequence>view.events[index-1].sequence));
  view.session.threadId='changed';view.events[0].text='changed';
  assert.equal((await registry.get('work-item','work-1')).session.threadId,'thread-1');
  assert.equal((await registry.get('work-item','work-1')).events[0].text,'Reading\ncode');
  assert.equal(store.writes,0);
  await registry.control(view.kind,view.taskId,control(view,'priority',{priority:'high'}));
  assert.equal(store.writes,1);
  assert.equal(JSON.stringify(store.value).includes('thread-1'),false);
  assert.equal(JSON.stringify(store.value).includes('Reading'),false);
  finish.resolve();await result;
  context.reportEvent({type:'message',text:'late output'});
  assert.deepEqual(await registry.list(),{enabled:true,items:[],held:[]});
  assert.deepEqual((await registry.get('work-item','work-1')).events,[]);
});

test('live session output stays bounded and invalid protocol metadata fails closed', async () => {
  const {registry}=fixture();const entered=deferred(),finish=deferred();let context;
  const result=registry.run(task(),async()=>{context=currentTaskExecution();entered.resolve();await finish.promise;});
  await entered.promise;
  for(const session of [
    {transport:'shell',threadId:'thread-1',turnId:null,status:'starting'},
    {transport:'app-server',threadId:'thread-1',turnId:'bad\nturn',status:'running'},
    {transport:'app-server',threadId:'thread-1',turnId:null,status:'unknown'},
    {transport:'app-server',threadId:'thread-1',turnId:null,status:'starting',raw:'secret'},
  ]) assert.throws(()=>context.reportSession(session),hasError('TASK_RUN_INPUT_INVALID',400));
  assert.throws(()=>context.reportEvent({type:'protocol',text:'raw packet'}),hasError('TASK_RUN_INPUT_INVALID',400));
  for(let index=0;index<125;index++) context.reportEvent({type:'status',text:`step ${index}`});
  context.reportEvent({type:'message',itemId:'long',text:'x'.repeat(3000)});
  context.reportEvent({type:'message',itemId:'long',text:'tail'});
  const view=await registry.get('work-item','work-1');
  assert.equal(view.events.length,120);
  assert.equal(view.events[0].text,'step 6');
  assert.ok(view.events.at(-1).text.length<=2000);
  assert.match(view.events.at(-1).text,/^…[\s\S]*tail$/);
  finish.resolve();await result;
});

test('late callbacks from an earlier checkpoint cannot alter a later model turn', async () => {
  const {registry}=fixture();const first=deferred(),second=deferred(),entered=deferred();const contexts=[];
  const result=registry.run(task(),async()=>{contexts.push(currentTaskExecution());entered.resolve();return contexts.length===1?first.promise:second.promise;});
  await entered.promise;
  const initial=await registry.get('work-item','work-1');
  contexts[0].reportSession({transport:'app-server',threadId:'thread-1',turnId:'turn-1',status:'running'});
  await registry.control('work-item','work-1',control(initial,'instruct',{instruction:'Check another path'}));
  first.resolve('old result');await new Promise((resolve)=>setImmediate(resolve));
  contexts[1].reportSession({transport:'app-server',threadId:'thread-1',turnId:'turn-2',status:'running'});
  contexts[0].reportSession({transport:'app-server',threadId:'thread-1',turnId:'turn-1',status:'completed'});
  contexts[0].reportEvent({type:'status',text:'late old turn'});
  const view=await registry.get('work-item','work-1');
  assert.equal(view.session.turnId,'turn-2');
  assert.equal(view.events.length,0);
  second.resolve('current result');assert.equal(await result,'current result');
});

test('observing a controlled action never repeats the side effect for new instructions',async()=>{
  const {registry}=fixture();const entered=deferred(),finish=deferred();let performed=0;
  const operation=registry.run(task({kind:'code-job'}),async()=>{performed++;entered.resolve();await finish.promise;return 'executed';},{repeatOnInstruction:false});
  await entered.promise;const view=await registry.get('code-job','work-1');
  await registry.control(view.kind,view.taskId,control(view,'instruct',{instruction:'check error handling next'}));
  finish.resolve();assert.equal(await operation,'executed');assert.equal(performed,1);
});

test('continuous completion waits for durable instructions until live steer is acknowledged', async (t) => {
  for (const failed of [false, true]) await t.test(failed ? 'failed steer remains pending' : 'acknowledged steer permits completion', async () => {
    const { registry } = fixture();
    const entered = deferred(), steering = deferred(), acknowledge = deferred(), finish = deferred();
    let context;
    const operation = registry.run(task({ kind: 'code-job' }), async () => {
      context = currentTaskExecution();
      context.registerLiveControl({ interrupt: async () => {}, steer: async () => {
        steering.resolve(); await acknowledge.promise;
        if (failed) throw new Error('native turn already ended');
      } });
      entered.resolve(); await finish.promise; return 'one turn';
    }, { repeatOnInstruction: false });
    await entered.promise;
    assert.equal(context.hasPendingInstructions(), false);
    const view = await registry.get('code-job', 'work-1');
    const controlResult = registry.control(view.kind, view.taskId, control(view, 'instruct', { instruction: 'Check cancellation' }));
    const settled = failed ? assert.rejects(controlResult, { code: 'TASK_RUN_STEER_FAILED' }) : controlResult;
    await steering.promise;
    assert.equal(context.hasPendingInstructions(), true);
    acknowledge.resolve(); await settled;
    assert.equal(context.hasPendingInstructions(), failed);
    assert.equal(await context.beginCompletion(), !failed);
    finish.resolve(); assert.equal(await operation, 'one turn');
    if (failed) await registry.run(task({ kind: 'code-job' }), async ({ instructions }) => {
      assert.deepEqual(instructions, ['Check cancellation']);
      assert.equal(await currentTaskExecution().beginCompletion(), true);
    }, { repeatOnInstruction: false });
  });
});

test('continuous completion rechecks a durable instruction when its write acknowledgement was lost', async () => {
  const { registry, store } = fixture();
  const entered = deferred(), finish = deferred();
  let context;
  const operation = registry.run(task({ kind: 'code-job' }), async () => {
    context = currentTaskExecution(); entered.resolve(); await finish.promise;
  }, { repeatOnInstruction: false });
  await entered.promise;
  const view = await registry.get('code-job', 'work-1');
  store.failAfterWrite = true;
  await assert.rejects(registry.control(view.kind, view.taskId,
    control(view, 'instruct', { instruction: 'Check saved but unacknowledged requirement' })), /acknowledgement unavailable/);
  store.failAfterWrite = false;
  try { assert.equal(await context.beginCompletion(), false); }
  finally { finish.resolve(); await operation; }
});

test('continuous completion rejects a durable pause when its write acknowledgement was lost', async () => {
  const { registry, store } = fixture();
  const entered = deferred(), finish = deferred();
  let context;
  const operation = registry.run(task({ kind: 'code-job' }), async () => {
    context = currentTaskExecution(); entered.resolve(); await finish.promise;
  }, { repeatOnInstruction: false });
  await entered.promise;
  const view = await registry.get('code-job', 'work-1');
  store.failAfterWrite = true;
  await assert.rejects(registry.control(view.kind, view.taskId, control(view, 'pause')), /acknowledgement unavailable/);
  store.failAfterWrite = false;
  const held = assert.rejects(operation, { code: 'TASK_RUN_PAUSED' });
  try { await assert.rejects(context.beginCompletion(), { code: 'TASK_RUN_PAUSED' }); }
  finally { finish.resolve(); await held; }
});

test('continuous code turns close admission at stop and retain holds until both owners confirm settlement', async (t) => {
  for (const confirmed of [false, true]) await t.test(confirmed ? 'confirmed stop' : 'unconfirmed host action', async () => {
    let settlements = 0, context;
    const { registry } = fixture({ settleControl: async () => { settlements++; } });
    const entered = deferred(), finish = deferred();
    const running = registry.run(task({ kind: 'code-job' }), async () => {
      context = currentTaskExecution();
      context.registerLiveControl({ steer: async () => {}, interrupt: async () => {} });
      context.assertRunning(); entered.resolve();
      await finish.promise;
      assert.throws(() => context.assertRunning(), { code: 'TASK_RUN_PAUSED' });
      if (confirmed) context.confirmStopped();
      return 'one turn';
    }, { repeatOnInstruction: false, requireStopConfirmation: true });
    await entered.promise;
    const view = await registry.get('code-job', 'work-1');
    await registry.control(view.kind, view.taskId, control(view, 'pause'));
    const rejected = assert.rejects(running, { code: confirmed ? 'TASK_RUN_PAUSED' : 'TASK_RUN_CONTROL_PENDING' });
    finish.resolve(); await rejected;
    const held = (await registry.list()).held[0];
    assert.equal(held.stopUnconfirmed, !confirmed);
    assert.equal(settlements, confirmed ? 1 : 0);
    if (!confirmed) { await registry.reconcile(); assert.equal(settlements, 0); }
  });
});

test('pending cancellation is reconciled only after the executor confirms terminal state',async()=>{
  let confirmed=false;
  const {registry}=fixture({settleControl:async()=>confirmed?undefined:{pending:true}});
  const running=await start(registry);const rejected=assert.rejects(running.result,hasError('TASK_RUN_CONTROL_PENDING',409));
  await registry.control('work-item','work-1',control(running.view,'cancel'));running.gate.resolve('old');await rejected;
  assert.equal((await registry.list()).held[0].pendingCommand,'cancel');
  await registry.reconcile();assert.equal((await registry.list()).held.length,1);
  confirmed=true;await registry.reconcile();assert.equal((await registry.list()).held.length,0);
  assert.equal((await registry.get('work-item','work-1')).phase,'cancelled');
});

test('held code jobs still admit cancellation and pause reconciliation',async()=>{
  const {registry}=fixture({settleControl:async()=>({pending:true})});
  const running=await start(registry,task({kind:'code-job'}));
  const rejected=assert.rejects(running.result,hasError('TASK_RUN_CONTROL_PENDING',409));
  await registry.control('code-job','work-1',control(running.view,'cancel'));running.gate.resolve('old');await rejected;
  assert.equal((await registry.order([{id:'work-1',status:'cancelling'}],'code-job','id')).length,1);
  assert.equal((await registry.order([{id:'work-1',status:'active'}],'code-job','id')).length,0);
});

test('a terminal action wins a late control and the completed task is not reported as paused',async()=>{
  const {registry}=fixture({settleControl:async()=>({terminalStatus:'completed'})});
  const running=await start(registry,task({kind:'code-job'}));
  await registry.control('code-job','work-1',control(running.view,'pause'));
  running.gate.resolve('completed');assert.equal(await running.result,'completed');
  assert.equal((await registry.get('code-job','work-1')).phase,'completed');
  assert.equal((await registry.list()).held.length,0);
});

class MemoryStore {
  value = null;
  writes = 0;
  failWrite = false;
  failAfterWrite = false;
  beforeWrite = null;

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(name, value) {
    assert.equal(name, TASK_RUN_STATE_KEY);
    this.writes += 1;
    await this.beforeWrite?.();
    if (this.failWrite) throw new Error("disk unavailable");
    this.value = structuredClone(value);
    if (this.failAfterWrite) throw new Error("acknowledgement unavailable");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function task(overrides = {}) {
  return {
    kind: "work-item",
    taskId: "work-1",
    roleId: "reviewer",
    title: "Review pull request",
    subject: "acme/widgets#7",
    revision: 12,
    leaseId: "lease-1",
    ...overrides,
  };
}

function fixture(options = {}) {
  const store = options.store ?? new MemoryStore();
  const settlements = [];
  const registry = new TaskRunRegistry({
    store,
    clock: () => new Date(NOW),
    settleControl: async (input) => settlements.push(input),
    ...options,
  });
  return { store, registry, settlements };
}

async function start(registry, input = task()) {
  const entered = deferred();
  const gate = deferred();
  const calls = [];
  const result = registry.run(input, async ({ instructions }) => {
    calls.push(instructions);
    entered.resolve();
    return gate.promise;
  });
  await entered.promise;
  return { gate, calls, result, view: await registry.get(input.kind, input.taskId) };
}

function control(view, command, fields = {}) {
  return {
    runId: view.runId,
    expectedRevision: view.revision,
    command,
    ...fields,
  };
}

function hasError(code, statusCode) {
  return (error) => error.code === code && error.statusCode === statusCode;
}

test("only actual operations appear and untouched runs never write task settings", async () => {
  const { registry, store } = fixture();
  assert.deepEqual(await registry.list(), { enabled: true, items: [], held: [] });
  const running = await start(registry);
  assert.match(running.view.runId, /^[a-f0-9-]{36}$/);
  assert.equal(running.view.revision, 0);
  assert.equal(running.view.startedAt, NOW);
  assert.equal(running.view.phase, "preparing");
  assert.equal(running.view.mode, "active");
  assert.equal(running.view.active, true);
  assert.deepEqual(running.calls, [[]]);
  assert.equal((await registry.list()).items.length, 1);
  await assert.rejects(registry.run(task(), async () => "duplicate"), hasError("TASK_RUN_CONFLICT", 409));
  running.gate.resolve("decision");
  assert.equal(await running.result, "decision");
  assert.deepEqual(await registry.list(), { enabled: true, items: [], held: [] });
  await assert.rejects(registry.get("work-item", "work-1"), hasError("TASK_RUN_NOT_FOUND", 404));
  assert.equal(store.writes, 0);
});

test("instructions discard an old decision and use the same task operation with latest requirements", async () => {
  const { registry, store } = fixture();
  const first = deferred();
  const second = deferred();
  const entered = deferred();
  const calls = [];
  const result = registry.run(task(), async ({ instructions }) => {
    calls.push(instructions);
    entered.resolve();
    return calls.length === 1 ? first.promise : second.promise;
  });
  await entered.promise;
  const initial = await registry.get("work-item", "work-1");
  const adjusted = await registry.control("work-item", "work-1", control(initial, "instruct", { instruction: "Check the retry path" }));
  assert.equal(adjusted.revision, 1);
  assert.equal(adjusted.phase, "waiting_checkpoint");
  assert.equal(adjusted.appliedRevision, 0);
  assert.deepEqual(adjusted.instructions, [{ text: "Check the retry path", at: NOW }]);
  adjusted.instructions[0].text = "mutated by caller";
  first.resolve("obsolete decision");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [[], ["Check the retry path"]]);
  assert.equal((await registry.get("work-item", "work-1")).appliedRevision, 1);
  second.resolve("new decision");
  assert.equal(await result, "new decision");
  const persisted = await fixture({ store }).registry.get("work-item", "work-1");
  assert.equal(persisted.active, false);
  assert.equal(persisted.appliedRevision, 1);
  const next = await start(fixture({ store }).registry);
  assert.notEqual(next.view.runId, initial.runId);
  assert.deepEqual(next.calls, [["Check the retry path"]]);
  next.gate.resolve("done");
  await next.result;
});

test("priority changes future ordering without repeating a completed operation", async () => {
  const { registry } = fixture();
  const running = await start(registry);
  const prioritized = await registry.control("work-item", "work-1", control(running.view, "priority", { priority: "urgent" }));
  assert.equal(prioritized.priority, "urgent");
  assert.equal(prioritized.phase, "preparing");
  const items = [{ id: "work-2" }, { id: "work-1" }, { id: "work-3" }];
  assert.deepEqual(await registry.order(items, "work-item", "id"), [items[1], items[0], items[2]]);
  assert.deepEqual(items.map(({ id }) => id), ["work-2", "work-1", "work-3"]);
  running.gate.resolve("decision");
  assert.equal(await running.result, "decision");
  assert.equal(running.calls.length, 1);
});

test("pause waits for the model checkpoint, persists across restart, and resumes after settlement", async () => {
  const { registry, store, settlements } = fixture();
  const running = await start(registry);
  const rejected = assert.rejects(running.result, (error) => error instanceof TaskRunControlError && hasError("TASK_RUN_PAUSED", 409)(error));
  const paused = await registry.control("work-item", "work-1", control(running.view, "pause"));
  assert.equal(paused.active, true);
  assert.equal(paused.phase, "waiting_checkpoint");
  assert.equal(paused.pendingCommand, "pause");
  assert.equal(settlements.length, 0);
  assert.deepEqual(await registry.order([{ id: "work-1" }], "work-item", "id"), []);
  const recovered = fixture({ store });
  assert.equal((await recovered.registry.list()).held[0].mode, "paused");
  await assert.rejects(recovered.registry.run(task(), async () => "unsafe"), hasError("TASK_RUN_PAUSED", 409));
  running.gate.resolve("obsolete decision");
  await rejected;
  assert.deepEqual(settlements, [{ task: task(), command: "pause" }]);
  const held = (await registry.list()).held[0];
  assert.equal(held.phase, "paused");
  assert.equal(held.active, false);
  const resumed = await recovered.registry.control("work-item", "work-1", control(held, "resume"));
  assert.equal(resumed.mode, "active");
  assert.deepEqual(recovered.settlements, [{ task: task(), command: "resume" }]);
  assert.deepEqual(await recovered.registry.order([{ id: "work-1" }], "work-item", "id"), [{ id: "work-1" }]);
});

test("cancel settles at the checkpoint and its durable exclusion survives restart", async () => {
  const { registry, store, settlements } = fixture();
  const running = await start(registry, task({ kind: "code-job" }));
  const rejected = assert.rejects(running.result, hasError("TASK_RUN_CANCELLED", 409));
  await registry.control("code-job", "work-1", control(running.view, "cancel"));
  assert.equal(settlements.length, 0);
  running.gate.resolve("obsolete decision");
  await rejected;
  assert.equal(settlements[0].command, "cancel");
  const restarted = fixture({ store }).registry;
  assert.deepEqual(await restarted.order([{ id: "work-1" }], "code-job", "id"), []);
  assert.equal((await restarted.get("code-job", "work-1")).mode, "cancelled");
  assert.deepEqual((await restarted.list()).held, []);
});

test("a paused task can be cancelled without creating a model run", async () => {
  const { registry, settlements } = fixture();
  const running = await start(registry);
  const rejected = assert.rejects(running.result, hasError("TASK_RUN_PAUSED", 409));
  await registry.control("work-item", "work-1", control(running.view, "pause"));
  running.gate.resolve("obsolete");
  await rejected;
  const held = await registry.get("work-item", "work-1");
  const cancelled = await registry.control("work-item", "work-1", control(held, "cancel"));
  assert.equal(cancelled.mode, "cancelled");
  assert.deepEqual(settlements.map(({ command }) => command), ["pause", "cancel"]);
  assert.deepEqual((await registry.list()).items, []);
});

test("requirements saved while paused survive restart and apply on the next run", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  const stopped = assert.rejects(running.result, hasError('TASK_RUN_PAUSED', 409));
  await registry.control('work-item', 'work-1', control(running.view, 'pause'));
  running.gate.resolve('obsolete');
  await stopped;
  const held = await registry.get('work-item', 'work-1');
  const saved = await registry.control('work-item', 'work-1', control(held, 'instruct', { instruction: 'Test the recovery path before publishing' }));
  assert.equal(saved.active, false);
  assert.equal(saved.mode, 'paused');
  assert.equal(saved.instructionReceipt, 'checkpoint');
  const recovered = fixture({ store }).registry;
  const restored = await recovered.get('work-item', 'work-1');
  assert.equal(restored.instructions[0].text, 'Test the recovery path before publishing');
  await recovered.control('work-item', 'work-1', control(restored, 'resume'));
  let seen;
  await recovered.run(task(), async ({ instructions }) => { seen = instructions; return 'done'; });
  assert.deepEqual(seen, ['Test the recovery path before publishing']);
  const terminal = await recovered.get('work-item', 'work-1');
  await assert.rejects(recovered.control('work-item', 'work-1', control(terminal, 'instruct', { instruction: 'too late' })), hasError('TASK_RUN_NOT_ACTIVE', 409));
});

test("same revision controls serialize and reject the loser without losing the winner", async () => {
  const { registry } = fixture();
  const running = await start(registry);
  const outcomes = await Promise.allSettled([
    registry.control("work-item", "work-1", control(running.view, "priority", { priority: "high" })),
    registry.control("work-item", "work-1", control(running.view, "priority", { priority: "urgent" })),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.statusCode, 409);
  await assert.rejects(registry.control("work-item", "work-1", { ...control(outcomes[0].value, "pause"), runId: "00000000-0000-4000-8000-000000000000" }), hasError("TASK_RUN_CONFLICT", 409));
  assert.equal((await registry.get("work-item", "work-1")).priority, "high");
  running.gate.resolve("done");
  await running.result;
});

test("a final checkpoint waits behind a durable control write before returning a decision", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  const writing = deferred();
  const acknowledge = deferred();
  store.beforeWrite = async () => {
    writing.resolve();
    await acknowledge.promise;
  };
  const adjustment = registry.control("work-item", "work-1", control(running.view, "instruct", { instruction: "Use the new requirement" }));
  await writing.promise;
  running.gate.resolve("first result");
  let returned = false;
  running.result.then(() => { returned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  acknowledge.resolve();
  await adjustment;
  assert.equal(await running.result, "first result");
  assert.deepEqual(running.calls, [[], ["Use the new requirement"]]);
  const last = await registry.get("work-item", "work-1");
  await assert.rejects(registry.control("work-item", "work-1", control(last, "instruct", { instruction: "Too late" })), hasError("TASK_RUN_NOT_ACTIVE", 409));
});

test("failed durable writes report failure and never claim an uncommitted adjustment", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  store.failWrite = true;
  await assert.rejects(registry.control("work-item", "work-1", control(running.view, "pause")), /disk unavailable/);
  const unchanged = await registry.get("work-item", "work-1");
  assert.equal(unchanged.revision, 0);
  assert.equal(unchanged.pendingCommand, null);
  store.failWrite = false;
  running.gate.resolve("valid");
  assert.equal(await running.result, "valid");
});

test("an acknowledged failure after a durable instruction still fences the old result", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  store.failAfterWrite = true;
  await assert.rejects(registry.control("work-item", "work-1", control(running.view, "instruct", { instruction: "Durable despite lost acknowledgement" })), /acknowledgement unavailable/);
  store.failAfterWrite = false;
  running.gate.resolve("result");
  await running.result;
  assert.equal(running.calls.length, 2);
  assert.equal((await registry.get("work-item", "work-1")).revision, 1);
});

test("failed pause settlement retains its cause without permitting ordinary retry", async () => {
  const failure = new Error("ledger settlement unavailable");
  const { registry, store } = fixture({ settleControl: async () => { throw failure; } });
  const running = await start(registry);
  const rejected = assert.rejects(running.result, (error) => error.code === 'TASK_RUN_CONTROL_PENDING' && error.cause === failure);
  await registry.control("work-item", "work-1", control(running.view, "pause"));
  running.gate.resolve("obsolete");
  await rejected;
  const recovered = fixture({ store, settleControl: async () => { throw failure; } }).registry;
  const held = (await recovered.list()).held[0];
  assert.equal(held.mode, "paused");
  assert.equal(held.phase, "control_failed");
  assert.equal(held.pendingCommand, "pause");
  await assert.rejects(recovered.control("work-item", "work-1", control(held, "resume")), (error) => error === failure);
  assert.deepEqual(await recovered.order([{ id: "work-1" }], "work-item", "id"), []);
});

test("model infrastructure failures are propagated once even when instructions changed", async () => {
  const { registry } = fixture();
  const running = await start(registry);
  const failure = new Error("provider disconnected");
  const rejected = assert.rejects(running.result, (error) => error === failure);
  await registry.control("work-item", "work-1", control(running.view, "instruct", { instruction: "New requirement" }));
  running.gate.reject(failure);
  await rejected;
  assert.equal(running.calls.length, 1);
  assert.deepEqual((await registry.list()).items, []);
});

test("a failed checkpoint write retains the hold after the ledger was settled", async () => {
  const store = new MemoryStore();
  const settlements = [];
  const { registry } = fixture({
    store,
    settleControl: async ({ command }) => {
      settlements.push(command);
      store.failWrite = true;
    },
  });
  const running = await start(registry);
  const rejected = assert.rejects(running.result, (error) => error.code === 'TASK_RUN_CONTROL_PENDING' && /disk unavailable/.test(error.cause?.message));
  await registry.control("work-item", "work-1", control(running.view, "pause"));
  running.gate.resolve("obsolete decision");
  await rejected;
  assert.deepEqual(settlements, ["pause"]);
  assert.equal((await registry.list()).held[0].phase, "control_failed");
  assert.deepEqual(await registry.order([{ id: "work-1" }], "work-item", "id"), []);
});

test("resume never removes a durable hold when its final write fails", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  const rejected = assert.rejects(running.result, hasError("TASK_RUN_PAUSED", 409));
  await registry.control("work-item", "work-1", control(running.view, "pause"));
  running.gate.resolve("obsolete decision");
  await rejected;
  const settlements = [];
  const recovered = fixture({
    store,
    settleControl: async ({ command }) => {
      settlements.push(command);
      store.failWrite = true;
    },
  }).registry;
  const held = await recovered.get("work-item", "work-1");
  await assert.rejects(recovered.control("work-item", "work-1", control(held, "resume")), /disk unavailable/);
  assert.deepEqual(settlements, ["resume"]);
  assert.equal((await recovered.get("work-item", "work-1")).mode, "paused");
  assert.deepEqual(await recovered.order([{ id: "work-1" }], "work-item", "id"), []);
});

test("model failure settles an accepted pause before ordinary retry can change its claim", async () => {
  const { registry, settlements } = fixture();
  const running = await start(registry);
  const failure = new Error("model process exited");
  const rejected = assert.rejects(running.result, hasError('TASK_RUN_PAUSED',409));
  await registry.control("work-item", "work-1", control(running.view, "pause"));
  running.gate.reject(failure);
  await rejected;
  assert.equal(running.calls.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal((await registry.list()).held[0].phase, "paused");
  assert.deepEqual(await registry.order([{ id: "work-1" }], "work-item", "id"), []);
});

test('unconfirmed reap survives restart and cannot settle until trusted stop evidence arrives',async()=>{
  let stopped=false;
  const {registry,store,settlements}=fixture({verifyStopped:async()=>stopped});
  const running=await start(registry);
  const rejected=assert.rejects(running.result,hasError('TASK_RUN_CONTROL_PENDING',409));
  await registry.control('work-item','work-1',control(running.view,'pause'));
  running.gate.reject(Object.assign(new Error('stop unconfirmed'),{code:'STRUCTURED_PROVIDER_REAP_FAILED'}));
  await rejected;assert.equal(settlements.length,0);
  const recovered=fixture({store,verifyStopped:async()=>stopped});
  await recovered.registry.reconcile();assert.equal(recovered.settlements.length,0);
  assert.equal((await recovered.registry.list()).held[0].stopUnconfirmed,true);
  stopped=true;await recovered.registry.reconcile();
  assert.equal(recovered.settlements.length,1);
  assert.equal((await recovered.registry.list()).held[0].phase,'paused');
});

test("repeated mid-round adjustments stop at five rounds and hold the original task", async () => {
  const { registry, settlements } = fixture();
  let calls = 0;
  const result = registry.run(task(), async () => {
    calls += 1;
    const current = await registry.get("work-item", "work-1");
    await registry.control("work-item", "work-1", control(current, "instruct", { instruction: `Round ${calls}` }));
    return "obsolete";
  });
  await assert.rejects(result, hasError("TASK_RUN_ADJUSTMENT_LIMIT", 409));
  assert.equal(calls, 5);
  assert.equal((await registry.list()).held[0].mode, "paused");
  assert.deepEqual(settlements, [{ task: task(), command: "pause" }]);
});

test('adjustment-limit pause settlement failure cannot escape as an ordinary provider retry',async()=>{
  const failure=new Error('ledger unavailable');
  const {registry}=fixture({settleControl:async()=>{throw failure;}});
  const running=registry.run(task(),async()=>{
    const view=await registry.get('work-item','work-1');
    await registry.control(view.kind,view.taskId,control(view,'instruct',{instruction:'updated requirement'}));
  });
  await assert.rejects(running,error=>error.code==='TASK_RUN_CONTROL_PENDING' && error.cause===failure);
  assert.equal((await registry.list()).held[0].pendingCommand,'pause');
});

test("controls validate exact bounded inputs without evaluating accessors", async () => {
  const { registry } = fixture();
  const running = await start(registry);
  const invalid = [
    control(running.view, "instruct", { instruction: "x", extra: true }),
    control(running.view, "instruct", { instruction: "界".repeat(1334) }),
    control(running.view, "instruct", { instruction: "   " }),
    control(running.view, "pause", { instruction: "unexpected" }),
    control(running.view, "priority", { priority: "highest" }),
    { ...control(running.view, "pause"), expectedRevision: -0 },
    { ...control(running.view, "pause"), command: { toString() { throw new Error("must not coerce command"); } } },
  ];
  let accessed = false;
  invalid.push(Object.defineProperty(control(running.view, "instruct"), "instruction", { enumerable: true, get() { accessed = true; return "unsafe"; } }));
  for (const input of invalid) {
    await assert.rejects(registry.control("work-item", "work-1", input), hasError("TASK_RUN_INPUT_INVALID", 400));
  }
  assert.equal(accessed, false);
  for (let count = 0; count < 20; count += 1) {
    const current = await registry.get("work-item", "work-1");
    await registry.control("work-item", "work-1", control(current, "instruct", { instruction: `${count}` }));
  }
  const full = await registry.get("work-item", "work-1");
  await assert.rejects(registry.control("work-item", "work-1", control(full, "instruct", { instruction: "21" })), hasError("TASK_RUN_CAPACITY_EXCEEDED", 507));
  running.gate.resolve("decision");
  await running.result;
});

test("corrupt and unbounded durable settings fail closed before scheduling or calling a model", async () => {
  const { registry, store } = fixture();
  const running = await start(registry);
  await registry.control("work-item", "work-1", control(running.view, "priority", { priority: "high" }));
  running.gate.resolve("done");
  await running.result;
  const valid = structuredClone(store.value);
  const invalidStates = [
    { ...valid, schemaVersion: 99 },
    { ...valid, secret: "must never be accepted" },
    { ...valid, records: [...valid.records, ...valid.records] },
    { ...valid, records: [{ ...valid.records[0], instructions: [{ text: "界".repeat(1334), at: NOW }] }] },
    { ...valid, records: [{ ...valid.records[0], pendingCommand: "pause" }] },
  ];
  for (const value of invalidStates) {
    store.value = value;
    const corrupt = fixture({ store }).registry;
    await assert.rejects(corrupt.order([{ id: "work-1" }], "work-item", "id"), hasError("TASK_RUN_STATE_INVALID", 500));
    let called = false;
    await assert.rejects(corrupt.run(task(), async () => { called = true; }), hasError("TASK_RUN_STATE_INVALID", 500));
    assert.equal(called, false);
  }
});

test("StateStore round trip retains bounded display metadata and the original task binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-run-registry-"));
  try {
    const store = new StateStore(directory);
    const { registry } = fixture({ store });
    const running = await start(registry, task({ title: "\u001b[31mReview\u001b[0m\u0000\n request", subject: "界".repeat(1000) }));
    assert.equal(running.view.title, "Review request");
    assert.ok(Buffer.byteLength(running.view.subject, "utf8") <= 1000);
    const rejected = assert.rejects(running.result, hasError("TASK_RUN_PAUSED", 409));
    await registry.control("work-item", "work-1", control(running.view, "pause"));
    running.gate.resolve("obsolete");
    await rejected;
    const recovered = fixture({ store: new StateStore(directory) }).registry;
    assert.equal((await recovered.list()).held[0].title, "Review request");
    assert.deepEqual(await recovered.order([{ id: "work-1" }], "work-item", "id"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
