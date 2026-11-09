import assert from 'node:assert/strict';
import test from 'node:test';
import {readNativeModelCapacity} from '../src/lib/native-model-capacity.js';
import {acquireNativeAdmission,createNativeModelAdmission,retainUnknownNativeInvocations,withNativeAdmission} from '../src/lib/native-model-admission.js';

test('native deployment capacity defaults to serial and requires explicit validated opt-in',()=>{
  assert.deepEqual(readNativeModelCapacity({}),{maxConcurrentTurns:1,allowConcurrentNativeHome:false});
  assert.deepEqual(readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),{maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  for(const value of ['0','5','2.0',' 2','NaN',''])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:value,DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),/capacity/);
  for(const validated of [undefined,'false','1','TRUE'])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:validated}),/validation/);
});

test('an exclusive probe queued before unknown isolation cannot strand the remaining model capacity',async()=>{
  const state=createNativeModelAdmission(2), controller=new AbortController(); let outcome=null;
  await withNativeAdmission(state,'other-entity',null,async()=>{
    const queued=acquireNativeAdmission(state,'login-status',controller.signal,{exclusive:true})
      .then(()=>{outcome='started';},error=>{outcome=error.code;});
    try {
      state.blocked=true;
      assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/old-marker',entity:'old-entity'}]),true);
      state.blocked=false;
      await new Promise(setImmediate);
      assert.equal(outcome,'STRUCTURED_PROVIDER_BUSY');
      assert.equal(state.queue.length,0);
    } finally { controller.abort(); await queued; }
  });
  await withNativeAdmission(state,'next-entity',null,async()=>{});
  assert.equal(state.active.size,1);
});

test('unknown native reservations are idempotent, identity-bound, and never exceed validated capacity',()=>{
  const state=createNativeModelAdmission(2), entry={file:'/owned/marker.json',entity:'old-entity'};
  assert.equal(retainUnknownNativeInvocations(createNativeModelAdmission(1),[entry]),false);
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(state.active.size,1);
  assert.equal(retainUnknownNativeInvocations(state,[{...entry,entity:'different'}]),false);
  assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/second.json',entity:'second'}]),false);
  assert.equal(state.active.size,1);
  state.active.add({entity:'running'});
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/third.json',entity:'third'}]),false);
  assert.equal(state.active.size,2);
  assert.equal(state.unknownInvocations.size,1);
  const exclusive=createNativeModelAdmission(2); exclusive.active.add({entity:'login',exclusive:true});
  assert.equal(retainUnknownNativeInvocations(exclusive,[entry]),false);
});

test('a retained unknown entity rejects a capacity waiter without spending the remaining slot',async()=>{
  const state=createNativeModelAdmission(2),controller=new AbortController();
  retainUnknownNativeInvocations(state,[{file:'/owned/old-marker',entity:'old-entity'}]);
  const wait=withNativeAdmission(state,'old-entity',controller.signal,()=>assert.fail('unknown work cannot run'),{waitForCapacity:true})
    .then(()=> 'started',error=>error.code);
  try {
    assert.equal(await Promise.race([wait,new Promise(resolve=>setImmediate(()=>resolve('still-queued')))]),'STRUCTURED_PROVIDER_BUSY');
    assert.equal(state.queue.length,0);
    await withNativeAdmission(state,'fresh-entity',null,async()=>{});
    assert.equal(state.active.size,1);
    assert.equal(state.unknownInvocations.size,1);
  } finally {controller.abort();await wait;}
});

test('new unknown isolation rejects already queued same-entity work as well as the exclusive probe',async()=>{
  const state=createNativeModelAdmission(3),controller=new AbortController();
  const active=await acquireNativeAdmission(state,'running',null);
  let probeResult,oldResult;
  const probe=acquireNativeAdmission(state,'login',controller.signal,{exclusive:true}).then(token=>{token.release();probeResult='started';},error=>{probeResult=error.code;});
  const old=acquireNativeAdmission(state,'old-entity',controller.signal).then(token=>{token.release();oldResult='started';},error=>{oldResult=error.code;});
  const fresh=acquireNativeAdmission(state,'fresh-entity',controller.signal).then(token=>{token.release();return 'started';},error=>error.code);
  try {
    assert.equal(state.queue.length,3);
    state.blocked=true;
    assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/old-marker',entity:'old-entity'}]),true);
    state.blocked=false;
    await new Promise(setImmediate);
    assert.equal(probeResult,'STRUCTURED_PROVIDER_BUSY');
    assert.equal(oldResult,'STRUCTURED_PROVIDER_BUSY');
    active.release();
    assert.equal(await fresh,'started');
    assert.equal(state.active.size,1);
  } finally {state.blocked=false;active.release();controller.abort();await Promise.all([probe,old,fresh]);}
});

test('known unknown admission preserves cancellation, the global fence, and the unknown marker',async()=>{
  const state=createNativeModelAdmission(2),entry={file:'/owned/old-marker',entity:'old-entity'};
  retainUnknownNativeInvocations(state,[entry]);
  const controller=new AbortController(),reason=new Error('owner cancelled');controller.abort(reason);
  for(const [entity,options] of [['old-entity',{}],['login',{exclusive:true}]]) {
    await assert.rejects(acquireNativeAdmission(state,entity,controller.signal,options),error=>error===reason);
  }
  await assert.rejects(acquireNativeAdmission(state,'login',null,{exclusive:true}),{code:'STRUCTURED_PROVIDER_BUSY'});
  state.blocked=true;
  await assert.rejects(acquireNativeAdmission(state,'old-entity',null),{code:'STRUCTURED_PROVIDER_REAP_FAILED'});
  state.blocked=false;
  assert.equal(state.queue.length,0);
  assert.equal(state.active.size,1);
  assert.deepEqual([...state.markers],[entry.file]);
});
