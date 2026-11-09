import assert from 'node:assert/strict';
import test from 'node:test';
import {TaskRunRegistry, TASK_RUN_STATE_KEY} from '../src/services/task-run-registry.js';
import {currentTaskExecution} from '../src/lib/task-execution-context.js';
import {TaskRunExecutionReceipts,TASK_RUN_RECEIPT_STATE_KEY} from '../src/services/task-run-execution-receipts.js';

const task = {kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'PRIVATE_TITLE',subject:'PRIVATE_SUBJECT',revision:1};
const deferred = () => {let resolve;const promise = new Promise(r => {resolve=r;});return {resolve,promise};};
const memoryStore = () => {const values = new Map(); return {values,async read(key,fallback){return structuredClone(values.get(key)??fallback);},async write(key,value){values.set(key,structuredClone(value));}};};
const registry = store => new TaskRunRegistry({store,receiptStore:store,settleControl:async()=>{}});
const receipt = (id, overrides = {}) => ({runId:`run-${id}`,kind:'work-item',taskId:`task-${id}`,roleId:'reviewer',taskRevision:1,leaseId:null,
  registeredAt:'2026-10-15T00:00:00.000Z',modelStartedAt:null,lastActivityAt:'2026-10-15T00:00:00.000Z',finishedAt:null,
  phase:'preparing',stopConfirmed:false,session:null,eventCount:0,outcomeCode:null,...overrides});

test('a native RPC failure stage survives run completion and registry restart without event bodies', async () => {
  const store=memoryStore(),runs=registry(store);let context;
  await assert.rejects(runs.run(task,async()=>{
    context=currentTaskExecution();
    context.reportNativeFailure({kind:'rpc_error',method:'thread/resume',code:-32600});
    context.reportNativeFailure({kind:'process_exit',method:null,code:1});
    context.reportEvent({type:'status',text:'PRIVATE_SERVER_MESSAGE'});
    throw Object.assign(new Error('private failure body'),{code:'STRUCTURED_PROVIDER_PROCESS_FAILED'});
  }),{code:'STRUCTURED_PROVIDER_PROCESS_FAILED'});
  context.reportNativeFailure({kind:'rpc_error',method:'turn/start',code:-32603});
  const view=await registry(store).get(task.kind,task.taskId);
  assert.deepEqual(view.receipt.nativeFailure,{kind:'rpc_error',method:'thread/resume',code:-32600});
  assert.deepEqual(view.events,[]);
  assert.equal(view.receipt.modelStartedAt,null);
  assert.equal(JSON.stringify(store.values.get(TASK_RUN_RECEIPT_STATE_KEY)).includes('PRIVATE_'),false);
});

test('native RPC receipt metadata accepts only known methods and numeric codes while preserving old receipts', async () => {
  const receipts=new TaskRunExecutionReceipts(memoryStore());
  await receipts.record(receipt('legacy'));
  await receipts.record(receipt('unknown-code',{nativeFailure:{kind:'rpc_error',method:'turn/start',code:null}}));
  for(const nativeFailure of [
    {kind:'rpc_error',method:'PRIVATE_METHOD',code:-32600}, {kind:'rpc_error',method:'turn/start',code:'PRIVATE_CODE'},
    {kind:'rpc_error',method:'turn/start',code:1.5}, {kind:'rpc_error',method:'turn/start',code:-32600,message:'PRIVATE_MESSAGE'},
  ]) assert.throws(()=>receipts.record(receipt('invalid',{nativeFailure})),{code:'TASK_RUN_RECEIPT_STATE_INVALID'});
  assert.equal(Object.hasOwn((await receipts.list()).find(r=>r.runId==='run-legacy'),'nativeFailure'),false);
});

test('a stopped-owner commit holds registration until it settles and rejects a later run', async () => {
  const runs = registry(memoryStore());
  const root = { ...task, taskId: 'root', roleId: 'orchestrator' }, child = { ...task, taskId: 'child', roleId: 'developer' };
  for (const owner of [root, child]) await runs.run(owner, async () => currentTaskExecution().reportModelState('running'));
  const expected = await Promise.all([runs.get('work-item', root.taskId), runs.get('work-item', child.taskId)]);
  const entered = deferred(), release = deferred(), order = [];
  const commit = runs.withStoppedRuns(expected, async () => { entered.resolve(); await release.promise; order.push('committed'); return 1; });
  await entered.promise;
  let started = false;
  const next = runs.run(root, async () => { started = true; order.push('registered'); });
  await new Promise(setImmediate);
  assert.equal(started, false, 'the queued owner cannot enter between proof validation and persistence');
  release.resolve();
  assert.deepEqual(await commit, { executed: true, result: 1 });
  await next;
  assert.deepEqual(order, ['committed', 'registered']);
  let called = false;
  assert.deepEqual(await runs.withStoppedRuns(expected, async () => { called = true; }), { executed: false });
  assert.equal(called, false, 'a new run identity invalidates the previously read proof');
});

test('stopped-owner commit failures release registration and active or owner-held work is rejected', async () => {
  const runs = registry(memoryStore());
  await runs.run(task, async () => {});
  const stopped = await runs.get(task.kind, task.taskId);
  await assert.rejects(runs.withStoppedRuns([stopped], async () => { throw new Error('durable commit failed'); }), /durable commit failed/);
  const entered = deferred(), release = deferred();
  const active = runs.run(task, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const current = await runs.get(task.kind, task.taskId);
  let called = false;
  assert.deepEqual(await runs.withStoppedRuns([current], async () => { called = true; }), { executed: false });
  await runs.control(task.kind, task.taskId, { command: 'pause', runId: current.runId, expectedRevision: current.revision });
  const held = await runs.get(task.kind, task.taskId);
  assert.deepEqual(await runs.withStoppedRuns([held], async () => { called = true; }), { executed: false });
  assert.equal(called, false);
  release.resolve();
  await assert.rejects(active, error => error.code === 'TASK_RUN_PAUSED');
});

test('a transient receipt write retains its pending update and later flush recovers',async()=>{
  const store=memoryStore();let writes=0;
  const receipts=new TaskRunExecutionReceipts({read:store.read,async write(key,value){
    if(++writes===1)throw new Error('transient receipt write');return store.write(key,value);
  }});
  await assert.rejects(receipts.record(receipt(1,{phase:'completed',finishedAt:'2026-10-15T00:00:01.000Z',stopConfirmed:true})),/transient receipt write/);
  assert.equal(writes,1,'one failed invocation must not automatically retry');
  await receipts.flush();
  assert.equal(writes,2);
  assert.equal((await receipts.list())[0].phase,'completed');
});

test('uncertain receipt acknowledgements reread durable state and retain newer pending terminal updates',async()=>{
  const store=memoryStore(),entered=deferred(),finish=deferred();let failNext=false,reads=0,writes=0;
  const receipts=new TaskRunExecutionReceipts({async read(key,fallback){reads++;return store.read(key,fallback);},async write(key,value){
    writes++;
    if(failNext){failNext=false;entered.resolve();await finish.promise;await store.write(key,value);
      const durable=store.values.get(key);durable.records.push(receipt('external',{phase:'completed',stopConfirmed:true,finishedAt:'2026-10-15T00:00:02.000Z'}));
      throw new Error('receipt acknowledgement lost');
    }
    return store.write(key,value);
  }});
  await receipts.record(receipt(1,{phase:'running',modelStartedAt:'2026-10-15T00:00:00.000Z'}));
  await receipts.record(receipt(2,{phase:'running',modelStartedAt:'2026-10-15T00:00:00.000Z'}));
  failNext=true;
  const active=receipts.record(receipt(1,{phase:'running',eventCount:1}));
  const activeRejected=assert.rejects(active,/receipt acknowledgement lost/);
  await entered.promise;
  const terminal=receipts.record(receipt(1,{phase:'completed',eventCount:3,stopConfirmed:true,finishedAt:'2026-10-15T00:00:03.000Z'}));
  const terminalRejected=assert.rejects(terminal,/receipt acknowledgement lost/);
  finish.resolve();await Promise.all([activeRejected,terminalRejected]);
  assert.equal(writes,3);
  const saved=new Map((await receipts.list()).map(value=>[value.runId,value]));
  assert.equal(reads,2,'an uncertain write must be followed by a durable reread');
  assert.equal(saved.get('run-1').phase,'completed');assert.equal(saved.get('run-1').eventCount,3);
  assert.equal(saved.get('run-2').phase,'running','operational reread must not run startup unknown recovery again');
  assert.equal(saved.get('run-external').phase,'completed');
});

test('failed receipt writes retry once per later call without losing registration or terminal metadata',async()=>{
  const store=memoryStore();let healthy=false,writes=0;
  const receipts=new TaskRunExecutionReceipts({read:store.read,async write(key,value){
    writes++;if(!healthy)throw new Error('receipt disk unavailable');return store.write(key,value);
  }});
  await assert.rejects(receipts.record(receipt(1)),/receipt disk unavailable/);
  await assert.rejects(receipts.record(receipt(2,{phase:'failed',finishedAt:'2026-10-15T00:00:01.000Z',outcomeCode:'SYNTHETIC_FAILURE'})),/receipt disk unavailable/);
  await assert.rejects(receipts.flush(),/receipt disk unavailable/);
  await assert.rejects(receipts.list(),/receipt disk unavailable/);
  assert.equal(writes,4,'each explicit call gets one bounded retry');
  healthy=true;await receipts.record(receipt(3));
  const saved=await receipts.list();assert.equal(saved.length,3);
  assert.equal(saved.find(value=>value.runId==='run-2').outcomeCode,'SYNTHETIC_FAILURE');
});

test('a transient initial read preserves pending receipts and can recover without restart',async()=>{
  const store=memoryStore();let reads=0;
  const receipts=new TaskRunExecutionReceipts({async read(key,fallback){
    if(++reads===1)throw new Error('transient receipt read');return store.read(key,fallback);
  },write:store.write});
  await assert.rejects(receipts.record(receipt(1)),/transient receipt read/);
  await receipts.flush();
  assert.equal((await receipts.list())[0].runId,'run-1');assert.equal(reads,2);
});

test('startup recovery retry changes inherited runs only and preserves a newly registered known run',async()=>{
  const store=memoryStore();let writes=0;
  store.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:[receipt('inherited',{phase:'running',modelStartedAt:'2026-10-15T00:00:00.000Z'})]});
  const receipts=new TaskRunExecutionReceipts({read:store.read,async write(key,value){
    await store.write(key,value);if(++writes===1)throw new Error('startup recovery acknowledgement lost');
  }});
  await assert.rejects(receipts.record(receipt('new',{phase:'running',modelStartedAt:'2026-10-15T00:00:00.000Z'})),/startup recovery acknowledgement lost/);
  const saved=new Map((await receipts.list()).map(value=>[value.runId,value]));
  assert.equal(saved.get('run-inherited').phase,'unknown');assert.equal(saved.get('run-inherited').stopConfirmed,false);
  assert.equal(saved.get('run-new').phase,'running');assert.equal(writes,2);
});

test('a receipt list completes at its watermark while later model updates remain in flight',async()=>{
  const store=memoryStore(),entered=Array.from({length:3},deferred),finish=Array.from({length:3},deferred);let writes=0;
  const receipts=new TaskRunExecutionReceipts({read:store.read,async write(key,value){
    const index=writes++;entered[index].resolve();await finish[index].promise;return store.write(key,value);
  }});
  const first=receipts.record(receipt(1,{eventCount:1}));await entered[0].promise;
  const second=receipts.record(receipt(1,{eventCount:2}));
  let listed=false;const reading=receipts.list().then(value=>{listed=true;return value;});
  let third;
  try{
    finish[0].resolve();await entered[1].promise;
    third=receipts.record(receipt(1,{eventCount:3}));
    finish[1].resolve();await entered[2].promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(listed,true,'a later update cannot indefinitely extend an earlier list call');
    assert.equal((await reading)[0].eventCount,2);
  }finally{for(const gate of finish)gate.resolve();await Promise.all([first,second,third,reading]);}
  assert.equal((await receipts.list())[0].eventCount,3);
});

test('receipt recovery never resets corrupt durable state',async()=>{
  const store=memoryStore();let writes=0;
  store.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:[{...receipt(1),body:'CORRUPT_BODY'}]});
  const before=JSON.stringify(store.values.get(TASK_RUN_RECEIPT_STATE_KEY));
  const receipts=new TaskRunExecutionReceipts({read:store.read,async write(key,value){writes++;return store.write(key,value);}});
  await assert.rejects(receipts.record(receipt(2)),{code:'TASK_RUN_RECEIPT_STATE_INVALID'});
  await assert.rejects(receipts.flush(),{code:'TASK_RUN_RECEIPT_STATE_INVALID'});
  assert.equal(writes,0);assert.equal(JSON.stringify(store.values.get(TASK_RUN_RECEIPT_STATE_KEY)),before);
});

test('the same real registry recovers registration after one transient receipt failure without dispatching the failed run',async()=>{
  const store=memoryStore();let failNext=true,dispatched=0;
  const runs=registry({read:store.read,async write(key,value){
    if(key===TASK_RUN_RECEIPT_STATE_KEY && failNext){failNext=false;throw new Error('registration receipt unavailable');}
    return store.write(key,value);
  }});
  await assert.rejects(runs.run(task,async()=>{dispatched++;}),/registration receipt unavailable/);
  assert.equal(dispatched,0);
  await runs.run(task,async()=>{dispatched++;currentTaskExecution().reportModelState('running');});
  assert.equal(dispatched,1);assert.equal((await runs.get(task.kind,task.taskId)).phase,'completed');
  const saved=store.values.get(TASK_RUN_RECEIPT_STATE_KEY).records;
  assert.equal(saved.length,2,'the failed registration receipt must be retained');
  assert.equal(saved.filter(value=>value.phase==='completed').length,1);
});

test('a real registry retains a failed terminal receipt and recovers it on its next read',async()=>{
  const store=memoryStore();let failTerminal=true,dispatched=0;
  const runs=registry({read:store.read,async write(key,value){
    if(key===TASK_RUN_RECEIPT_STATE_KEY && failTerminal && value.records.some(entry=>entry.phase==='completed')){
      failTerminal=false;throw new Error('terminal receipt unavailable');
    }
    return store.write(key,value);
  }});
  await assert.rejects(runs.run(task,async()=>{dispatched++;currentTaskExecution().reportModelState('running');}),/terminal receipt unavailable/);
  assert.equal(dispatched,1);
  const finished=await runs.get(task.kind,task.taskId);
  assert.equal(finished.phase,'completed');assert.notEqual(finished.receipt.modelStartedAt,null);assert.equal(finished.receipt.stopConfirmed,true);
  assert.equal(store.values.get(TASK_RUN_RECEIPT_STATE_KEY).records[0].phase,'completed');
});

test('paced concurrent updates and list reads coalesce at 1000 receipts with bounded write ownership',async()=>{
  const store=memoryStore(),entered=deferred(),finish=deferred();let writes=0,reads=0,active=0,maxActive=0;
  store.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:Array.from({length:1000},(_,id)=>receipt(id,{phase:'completed',stopConfirmed:true,finishedAt:'2026-10-15T00:00:01.000Z'}))});
  const receipts=new TaskRunExecutionReceipts({async read(key,fallback){reads++;return store.read(key,fallback);},async write(key,value){
    active++;maxActive=Math.max(maxActive,active);writes++;
    try{
      assert.equal(value.records.length,1000);assert.ok(Buffer.byteLength(JSON.stringify(value))<=2*1024*1024);
      if(writes===1){entered.resolve();await finish.promise;}
      return await store.write(key,value);
    }finally{active--;}
  }});
  const pending=[receipts.record(receipt(0,{eventCount:1}))];await entered.promise;
  for(let wave=0;wave<10;wave++){
    for(let index=wave*100;index<(wave+1)*100;index++)pending.push(receipts.record(receipt(index,{eventCount:wave+2})));
    pending.push(receipts.list());
    await new Promise(resolve=>setImmediate(resolve));
  }
  try{
    assert.equal(writes,1);assert.equal(active,1);
    await assert.rejects(receipts.record(receipt('overflow')),{code:'TASK_RUN_RECEIPT_CAPACITY_EXCEEDED'});
  }finally{finish.resolve();}
  await Promise.all(pending);
  assert.equal(maxActive,1);assert.equal(reads,1);assert.ok(writes<=2,'updates arriving during one delayed write must share one subsequent batch');
  const saved=await receipts.list();assert.equal(saved.length,1000);assert.equal(saved.find(value=>value.runId==='run-999').eventCount,11);
});

test('paced real registry events at 1000 receipts preserve control writes and bounded concurrent reads',async()=>{
  const store=memoryStore(),entered=deferred(),finish=deferred(),writeEntered=deferred(),releaseWrite=deferred();
  let context,writes=0,active=0,maxActive=0;
  store.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:Array.from({length:1000},(_,id)=>receipt(id,{phase:'completed',stopConfirmed:true,finishedAt:'2026-10-15T00:00:01.000Z'}))});
  const runs=registry({read:store.read,async write(key,value){
    if(key!==TASK_RUN_RECEIPT_STATE_KEY)return store.write(key,value);
    writes++;active++;maxActive=Math.max(maxActive,active);
    try{
      assert.equal(value.records.length,1000);
      if(writes===2){writeEntered.resolve();await releaseWrite.promise;}
      return await store.write(key,value);
    }finally{active--;}
  }});
  const operation=runs.run(task,async()=>{context=currentTaskExecution();entered.resolve();await finish.promise;});
  await entered.promise;const initial=await runs.get(task.kind,task.taskId);
  context.reportModelState('running');await writeEntered.promise;
  const reads=[];
  try{
    const controlled=await runs.control(task.kind,task.taskId,{runId:initial.runId,expectedRevision:initial.revision,command:'priority',priority:'high'});
    assert.equal(controlled.priority,'high');assert.equal(active,1,'control write must settle while the separate receipt write remains delayed');
    const controls=JSON.stringify(store.values.get(TASK_RUN_STATE_KEY));
    for(let wave=0;wave<10;wave++){
      for(let index=0;index<10;index++)context.reportEvent({type:'status',text:'PRIVATE_PACED_EVENT'});
      reads.push(runs.list(),runs.get(task.kind,task.taskId));
      await new Promise(resolve=>setImmediate(resolve));
    }
    releaseWrite.resolve();await Promise.all(reads);
    assert.equal(maxActive,1);assert.ok(writes<=3,'one registration and two coalesced activity batches suffice');
    assert.equal(JSON.stringify(store.values.get(TASK_RUN_STATE_KEY)),controls,'receipt reads/writes must not rewrite durable controls');
    const view=await runs.list();assert.equal(view.counts.active,1);assert.equal(view.recent.length,999);
  }finally{releaseWrite.resolve();finish.resolve();await operation;}
  const saved=store.values.get(TASK_RUN_RECEIPT_STATE_KEY).records;
  assert.equal(saved.find(value=>value.runId===initial.runId).eventCount,100);
  assert.equal(JSON.stringify(saved).includes('PRIVATE_PACED_EVENT'),false);
});

test('durable execution receipts distinguish queue and running, retain terminal metadata without body',async()=>{
  const store = memoryStore(), runs = registry(store), entered = deferred(), finish=deferred(); let context;
  const result = runs.run(task,async()=>{context=currentTaskExecution();context.reportModelState('waiting_model');entered.resolve();await finish.promise;});
  await entered.promise;
  assert.equal((await runs.get(task.kind,task.taskId)).phase,'waiting_model');
  assert.deepEqual((await runs.list()).counts,{active:0,queued:1,preparing:0});
  context.reportModelState('running');
  context.reportSession({transport:'app-server',threadId:'thread-1',turnId:'turn-1',status:'running'});
  context.reportEvent({type:'message',text:'PRIVATE_MESSAGE'});
  context.reportProgress('PRIVATE_PROGRESS');
  assert.deepEqual((await runs.list()).counts,{active:1,queued:0,preparing:0});
  finish.resolve();await result;
  const finished = await runs.get(task.kind,task.taskId);
  assert.equal(finished.phase,'completed');
  assert.equal(finished.receipt.modelStartedAt !== null,true);
  assert.equal(finished.receipt.finishedAt !== null,true);
  const saved = JSON.stringify([...store.values]);
  for(const secret of ['PRIVATE_MESSAGE','PRIVATE_PROGRESS','PRIVATE_TITLE','PRIVATE_SUBJECT'])assert.equal(saved.includes(secret),false);
  assert.equal(store.values.has(TASK_RUN_STATE_KEY),false,'receipt writes must not rewrite old control history');
  const recovered = await registry(store).get(task.kind,task.taskId);
  assert.equal(recovered.phase,'completed');
  assert.deepEqual(recovered.events,[]);
  context.reportModelState('running');context.reportEvent({type:'message',text:'late'});
  assert.equal((await runs.get(task.kind,task.taskId)).phase,'completed');
});

test('restarted in-flight receipts become unknown without inferring stop or completion',async()=>{
  const store=memoryStore(),runs=registry(store),entered=deferred(),finish=deferred();
  const result=runs.run(task,async()=>{currentTaskExecution().reportModelState('running');entered.resolve();await finish.promise;});
  await entered.promise; await runs.list();
  const unknown=await registry(store).get(task.kind,task.taskId);
  assert.equal(unknown.phase,'unknown');
  assert.equal(unknown.receipt.stopConfirmed,false);
  assert.equal((await registry(store).list()).recent.length,1);
  finish.resolve();await result;
});

test('receipt retention is bounded, preserves unknown ownership, and rejects injected body fields',async()=>{
  const at='2026-10-15T00:00:00.000Z';
  const receipt=id=>({runId:`run-${id}`,kind:'work-item',taskId:`task-${id}`,roleId:'reviewer',taskRevision:1,leaseId:null,
    registeredAt:at,modelStartedAt:at,lastActivityAt:at,finishedAt:at,phase:'completed',stopConfirmed:true,session:null,eventCount:1,outcomeCode:null});
  const store=memoryStore();
  store.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:Array.from({length:1000},(_,id)=>receipt(id))});
  const receipts=new TaskRunExecutionReceipts(store);
  await receipts.record(receipt(1000));
  const saved=await receipts.list();assert.equal(saved.length,1000);assert.equal(saved[0].runId,'run-1');
  assert.throws(()=>receipts.record({...receipt(1001),body:'PRIVATE_BODY'}),{code:'TASK_RUN_RECEIPT_STATE_INVALID'});
  const blocked=memoryStore();blocked.values.set(TASK_RUN_RECEIPT_STATE_KEY,{schemaVersion:1,records:Array.from({length:1000},(_,id)=>({...receipt(id),phase:'unknown',stopConfirmed:false,finishedAt:null}))});
  await assert.rejects(new TaskRunExecutionReceipts(blocked).record({...receipt(1000),phase:'preparing',modelStartedAt:null,finishedAt:null,stopConfirmed:false}),{code:'TASK_RUN_RECEIPT_CAPACITY_EXCEEDED'});
  assert.equal(blocked.values.get(TASK_RUN_RECEIPT_STATE_KEY).records.length,1000);
});

test('receipt write failure prevents operation dispatch and preserves legacy controls',async()=>{
  const store=memoryStore();
  store.values.set(TASK_RUN_STATE_KEY,{schemaVersion:1,revision:0,records:[]});
  const original=JSON.stringify(store.values.get(TASK_RUN_STATE_KEY));
  const broken={read:store.read,async write(key,value){if(key===TASK_RUN_RECEIPT_STATE_KEY)throw new Error('receipt disk unavailable');return store.write(key,value);}};
  let dispatched=false;
  await assert.rejects(registry(broken).run(task,async()=>{dispatched=true;}),/receipt disk unavailable/);
  assert.equal(dispatched,false);
  assert.equal(JSON.stringify(store.values.get(TASK_RUN_STATE_KEY)),original);
});
