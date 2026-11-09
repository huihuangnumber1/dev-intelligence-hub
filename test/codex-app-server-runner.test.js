import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerRunner,didAppServerNotStart,didAppServerNotStartModel,didAppServerReap,readAppServerFailureDiagnostic } from '../src/lib/codex-app-server-runner.js';
import { ManagedProcess } from '../src/lib/managed-process.js';
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { withTaskExecution } from '../src/lib/task-execution-context.js';
import { createTestSupervisedProcessRunner } from '../src/lib/supervised-process-runner.js';
import { createCodeExecutionWatchdog, closeCodeExecutionWatchdog } from '../src/lib/code-execution-watchdog.js';
import { ContainedStdioProcess } from '../src/lib/contained-stdio-process.js';
const threadId='01973bca-3d8b-7000-a000-123456789abc';

test('late native activity after failure cannot change runtime receipts while reap drains',async()=>{
  let release;const stopGate={promise:new Promise(resolve=>{release=resolve;})};
  const f=fixture({hold:true,stopGate}),events=[];
  await invocation(f.runner,async run=>{
    const operation=withTaskExecution({reportProgress(){},reportEvent:event=>events.push(event)},run);void operation.catch(()=>{});
    while(!f.calls.some(call=>call.method==='turn/start'))await new Promise(resolve=>setImmediate(resolve));
    f.send({method:'error',params:{threadId,willRetry:false}});
    await f.stopping;
    f.send({method:'item/agentMessage/delta',params:{threadId,turnId:'turn-1',itemId:'late',delta:'LATE_PRIVATE_BODY'}});
    release();await assert.rejects(operation);
    assert.equal(events.length,0);
  });
});
test('production app-server certifies invalid invocations as not started',async()=>{
  const runner=new CodexAppServerRunner({materialize:async()=>assert.fail('must not materialize or spawn')});
  await assert.rejects(runner.run({}),error=>error.code==='STRUCTURED_PROVIDER_UNAVAILABLE' && didAppServerNotStart(error));
});

test('cancellation during contained startup waits for supervised preparation to settle without starting a model', async () => {
  let enteredPreparation, finishPreparation;
  const preparing = new Promise(resolve => { enteredPreparation = resolve; });
  const cleanup = new Promise(resolve => { finishPreparation = resolve; });
  let spawns = 0, settled = false, sawAbort = false;
  const supervised = createTestSupervisedProcessRunner({
    platform: 'linux',
    spawnImpl: () => { spawns++; assert.fail('cancelled preparation must not spawn'); },
    descriptorMaterializer: async (_descriptor, { signal }) => {
      enteredPreparation();
      signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
      await cleanup;
      signal.throwIfAborted();
    },
  });
  const runner = new CodexAppServerRunner({ processFactory: () => new ContainedStdioProcess(supervised), materialize: async () => null });
  const controller = new AbortController();
  await invocation({ run: options => runner.run({ ...options, signal: controller.signal }) }, async run => {
    const running = run();
    const outcome = running.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await preparing;
      controller.abort();
      await new Promise(setImmediate);
      assert.equal(sawAbort, true, 'caller cancellation reaches supervised startup');
      assert.equal(settled, false, 'startup cleanup still owns the invocation');
      finishPreparation();
      const error = await outcome;
      assert.equal(error.code, 'STRUCTURED_PROVIDER_CANCELLED');
      assert.equal(didAppServerNotStart(error), true);
      assert.equal(didAppServerReap(error), true);
      assert.equal(spawns, 0);
    } finally {
      finishPreparation();
      await outcome;
    }
  });
});

test('startup completion after cancellation cannot initialize or start a model before confirmed teardown', async () => {
  let enteredStartup, finishStartup, enteredStop, finishStop;
  const starting = new Promise(resolve => { enteredStartup = resolve; });
  const startup = new Promise(resolve => { finishStartup = resolve; });
  const stopping = new Promise(resolve => { enteredStop = resolve; });
  const stopped = new Promise(resolve => { finishStop = resolve; });
  const writes = [];
  const process = { exited: false,
    async start() { enteredStartup(); await startup; },
    write(line) { writes.push(JSON.parse(line)); throw new Error('cancelled startup wrote an RPC'); },
    async stop() { enteredStop(); await stopped; this.exited = true; },
  };
  const runner = new CodexAppServerRunner({ processFactory: () => process, materialize: async () => null });
  const controller = new AbortController();
  await invocation({ run: options => runner.run({ ...options, signal: controller.signal }) }, async run => {
    let settled = false;
    const running = run().then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await starting;
      controller.abort();
      finishStartup();
      await stopping;
      assert.deepEqual(writes, [], 'no initialize, thread/start or turn/start may follow cancellation');
      assert.equal(settled, false, 'a direct startup return does not certify teardown');
      finishStop();
      const error = await running;
      assert.equal(error.code, 'STRUCTURED_PROVIDER_CANCELLED');
      assert.equal(didAppServerReap(error), true);
    } finally {
      finishStartup(); finishStop();
      await running;
    }
  });
});

function fixture({hold=false,failed=false,stopFailure=false,manualInterrupt=false,stopGate=null,steerTurnId=null,initializationFailure=false,turnStartFailure=null,resumeFailure=null,exitDuringMethod=null,codeJob=false,reviewAgents=false,toolInventory=null,onInterrupt=null,contained=false,largeInheritedInventory=false}={}) {
  let options; const calls=[]; let finish,interruptId,signalStopping;
  const stopping=new Promise(resolve=>{signalStopping=resolve;});
  const done = new Promise((r)=>{finish=r;});
  const send=(value)=>options.onLine({stream:'stdout',line:JSON.stringify(value)});
  const complete=()=>{send({method:'item/completed',params:{threadId,turnId:'turn-1',item:{type:'agentMessage',text:'{"result":"{\\"ok\\":true}"}'}}});send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:failed?'failed':'completed'}}});};
  const process={done,exited:false,start(value){options=value;},write(line){
    const request=JSON.parse(line); if(!request.id)return;
    calls.push(request); let result={};
    if(request.method===exitDuringMethod){options.onExit({exitCode:19,signal:null});return;}
    if(request.method==='initialize' && initializationFailure){send({id:request.id,error:{code:-32600,message:'fixture startup refused'}});return;}
    if(request.method==='thread/resume' && resumeFailure){send({id:request.id,error:resumeFailure});return;}
    if(request.method==='config/read') result={config:{
      features:{...Object.fromEntries(['shell_tool','apps','browser_use','computer_use','image_generation','hooks','plugins','remote_plugin','plugin_sharing','skill_search','skill_mcp_dependency_install','goals','memories','workspace_dependencies','multi_agent_v2','code_mode','multi_agent'].map(name=>[name,false])),skip_host_skill_discovery:true,code_mode_host:true},
      agents:{enabled:false},web_search:'disabled',approval_policy:'never',sandbox_mode:'read-only',model_provider:'openai',notify:[],mcp_servers:{old:{url:'private'}},
    }};
    if(request.method==='config/read' && reviewAgents) {
      result.config.features.multi_agent=true; result.config.agents.enabled=true;
    }
    if(request.method==='config/read' && largeInheritedInventory) {
      result.config.mcp_servers.old.tools=Object.fromEntries(Array.from({length:4000},(_,i)=>[`tool_${i}`,{
        description:'Inherited tool metadata',inputSchema:{type:'object',properties:{query:{type:'string'}}},
      }]));
    }
    if(request.method.startsWith('thread/'))result={thread:{id:threadId}};
    if(request.method.startsWith('thread/') && (codeJob || reviewAgents))Object.assign(result,{approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}});
    if(request.method==='mcpServerStatus/list') {
      const namespace=Object.keys(calls.find(call=>call.method.startsWith('thread/')).params.config.mcp_servers).find(name=>name.startsWith(codeJob?'dih_code_job_':'dih_pr_review_'));
        result={data:[{name:namespace,tools:Object.fromEntries((toolInventory??(codeJob?['perform_action','read_source','edit_source','get_state','read_conflict_source']:['read_document','read_source','list_directory'])).map(name=>[name,{}]))}],nextCursor:null};
    }
    if(request.method==='turn/start')result={turn:{id:'turn-1'}};
    if(request.method==='turn/start' && turnStartFailure){send({id:request.id,error:turnStartFailure});return;}
    if(request.method==='turn/steer')result=steerTurnId===false?{}:{turnId:steerTurnId??'turn-1'};
    if(request.method==='turn/interrupt')onInterrupt?.();
    if(request.method==='turn/interrupt' && manualInterrupt){interruptId=request.id;return;}
    send({id:request.id,result});
    if(request.method==='turn/start' && !hold)queueMicrotask(complete);
    if(request.method==='turn/interrupt')queueMicrotask(()=>send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'interrupted'}}}));
  },async stop(){signalStopping();await stopGate?.promise;if(stopFailure)throw new Error('not confirmed');this.exited=true;finish({code:0,signal:null});}};
  let reaps = 0;
  let runner = new CodexAppServerRunner({processFactory:()=>process,materialize:async()=>({command:'codex',prefixArgs:[]})});
  if (contained) {
    const child = new EventEmitter(); child.pid = 424242;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    options = { onLine: frame => child.stdout.write(frame.line + '\n') };
    child.stdin.on('data', chunk => process.write(chunk.toString()));
    child.stdin.on('finish', () => child.emit('close', 0, null));
    const supervised = createTestSupervisedProcessRunner({ platform: 'linux', spawnImpl: () => child,
      descriptorMaterializer: async () => ({ command: globalThis.process.execPath, prefixArgs: [] }),
      treeTerminator: async () => { reaps++; child.emit('close', 0, null); } });
    runner = new CodexAppServerRunner({ processFactory: () => new ContainedStdioProcess(supervised), materialize: async () => null });
  }
  return {runner,calls,complete,send,stopping,reaps:()=>reaps,
    acknowledgeInterrupt:()=>send({id:interruptId,result:{}}),
    interrupted:()=>send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'interrupted'}}})};
}
async function invocation(runner,execute=(run)=>run(),appServerOverrides={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'dih-app-server-'));
  const codeExecutionWatchdog = appServerOverrides.isolation?.channel === 'code-job' ? createCodeExecutionWatchdog({ startupMs: 1000 }) : null;
  try{return await execute(()=>runner.run({executable:{},args:['app-server'],cwd:directory,env:{},timeoutMs:1000,
    ...(codeExecutionWatchdog ? { codeExecutionWatchdog } : {}),
    appServer:{input:'safe task',model:'test-model',schema:{type:'object'},previous:null,...appServerOverrides}}),directory);}
  finally{if (codeExecutionWatchdog) closeCodeExecutionWatchdog(codeExecutionWatchdog); await rm(directory,{recursive:true,force:true});}
}

for (const [label, options, overrides] of [
  ['different resumed thread', {}, { previous: 'different-thread' }],
  ['unauthorized tool inventory', { reviewAgents: true, toolInventory: ['untrusted_tool'] }, { isolation: { reader: { url: 'http://127.0.0.1/private' }, agentConfigPath: 'private.toml' } }],
]) test(`thread checkpoint cannot precede validation (${label})`, async () => {
  const f = fixture(options); let checkpointed = false;
  await assert.rejects(invocation({ run: call => f.runner.run({ ...call, onThreadIdentified() { checkpointed = true; } }) }, run => run(), overrides));
  assert.equal(checkpointed, false);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('checkpoint failure with uncertain process stop retains reap uncertainty and starts no model', async () => {
  const f = fixture({ stopFailure: true });
  await assert.rejects(invocation({ run: call => f.runner.run({ ...call, onThreadIdentified: async () => { throw new Error('write failed'); } }) }), error => {
    assert.equal(didAppServerReap(error), false);
    assert.equal(didAppServerNotStartModel(error), false, 'no-model receipt cannot certify an unknown process');
    return error.code === 'STRUCTURED_PROVIDER_REAP_FAILED';
  });
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
});

test('large inherited MCP metadata does not prevent an isolated review from starting', async () => {
  const f=fixture({reviewAgents:true,largeInheritedInventory:true});
  await invocation(f.runner, async run=>{
    const result=await run();
    assert.equal(result.exitCode,0);
    const thread=f.calls.find(call=>call.method.startsWith('thread/'));
    assert.deepEqual(thread.params.config.mcp_servers.old,{enabled:false});
    assert.ok(f.calls.some(call=>call.method==='turn/start'));
  }, {isolation:{reader:{url:'http://127.0.0.1:1234/read'},agentConfigPath:'private-reviewer.toml'}});
});

test('native review resume explicitly restores host reviewer flags before starting its turn', async () => {
  const f=fixture({reviewAgents:true});
  await invocation(f.runner,run=>run(),{previous:threadId,isolation:{reader:{url:'http://127.0.0.1:1234/read'},agentConfigPath:'private-reviewer.toml'}});
  const resumed=f.calls.find(call=>call.method==='thread/resume');
  assert.equal(resumed.params.threadId,threadId);
  assert.equal(resumed.params.config.features.multi_agent,true);
  assert.equal(resumed.params.config.agents.enabled,true);
  assert.equal(resumed.params.config.service_tier,'default');
  assert.ok(f.calls.findIndex(call=>call.method==='mcpServerStatus/list')<f.calls.findIndex(call=>call.method==='turn/start'));
});

for(const [method,rpcCode] of [['turn/start',-32600],['thread/resume','PRIVATE_CODE']]) test(`native RPC failure reports its host stage without exposing server content (${method})`, async () => {
  const events=[],failures=[];
  const serverError={code:rpcCode,message:'PRIVATE_SERVER_MESSAGE',data:{token:'PRIVATE_TOKEN'}};
  const f=fixture(method==='turn/start'?{turnStartFailure:serverError}:{resumeFailure:serverError});
  await assert.rejects(invocation(f.runner,run=>withTaskExecution({reportEvent:event=>events.push(event),reportNativeFailure:value=>failures.push(value)},run),{previous:threadId}),
    {code:'STRUCTURED_PROVIDER_PROCESS_FAILED'});
  assert.deepEqual(events,[{type:'status',text:`Native RPC failed: ${method} (code ${typeof rpcCode==='number'?rpcCode:'unknown'})`}]);
  assert.deepEqual(failures,[{kind:'rpc_error',method,code:typeof rpcCode==='number'?rpcCode:null}]);
  assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);
});

test('RPC diagnostics remain available without a task registry and contain no server text', async () => {
  const f = fixture({ turnStartFailure: { code: -32600, message: 'PRIVATE_MESSAGE', data: { token: 'PRIVATE_TOKEN' } } });
  await assert.rejects(invocation(f.runner), error => {
    assert.deepEqual(readAppServerFailureDiagnostic(error), { kind: 'rpc_error', method: 'turn/start', code: -32600 });
    assert.equal(JSON.stringify(readAppServerFailureDiagnostic(error)).includes('PRIVATE'), false);
    return error.code === 'STRUCTURED_PROVIDER_PROCESS_FAILED';
  });
});

test('an unexpected process exit retains the pending host method before teardown clears it', async () => {
  const failures=[],f=fixture({exitDuringMethod:'thread/resume'});
  await assert.rejects(invocation(f.runner,run=>withTaskExecution({reportNativeFailure:value=>failures.push(value)},run),{previous:threadId}),
    {code:'STRUCTURED_PROVIDER_PROCESS_FAILED'});
  assert.deepEqual(failures,[{kind:'process_exit',method:'thread/resume',code:19}]);
});

test('a failed diagnostic observer cannot strand the RPC or replace its original native failure', async () => {
  const f=fixture({turnStartFailure:{code:-32600,message:'PRIVATE_SERVER_MESSAGE'}});
  const broken=()=>{throw new Error('diagnostics unavailable');};
  await assert.rejects(invocation(f.runner,run=>withTaskExecution({reportNativeFailure:broken,reportEvent:broken},run)),
    error=>error.code==='STRUCTURED_PROVIDER_PROCESS_FAILED' && didAppServerReap(error));
});

for (const contained of [false, true]) test(`useful current-turn native code progress remains active beyond ten hours with contained supervision ${contained}`, async t => {
  const f = fixture({ hold: true, codeJob: true, contained });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await invocation(f.runner, async run => {
    const running = run(); void running.catch(() => {});
    for (let attempts = 0; attempts < 100 && !f.calls.some(call => call.method === 'turn/start'); attempts++) await new Promise(resolve => setImmediate(resolve));
    if (!f.calls.some(call => call.method === 'turn/start')) await running;
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 0; index < 61; index++) {
      f.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: `reasoning-${index}`, delta: 'Verified a distinct task step.' } });
      t.mock.timers.tick(10 * 60_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(await Promise.race([running.then(() => 'finished', () => 'failed'), Promise.resolve('running')]), 'running');
    }
    f.complete(); return running;
  }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } });
  if (contained) assert.equal(f.reaps(), 1, 'success retains actual tree-reap proof');
});

for (const [label, message] of [
  ['unknown', { method: 'watchdog/heartbeat', params: { threadId, turnId: 'turn-1' } }],
  ['ping', { method: 'ping', params: { threadId, turnId: 'turn-1' } }],
  ['stale thread', { method: 'item/agentMessage/delta', params: { threadId: 'different', turnId: 'turn-1', itemId: 'message', delta: 'stale' } }],
  ['stale turn', { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-old', itemId: 'message', delta: 'stale' } }],
  ['missing turn', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'message', delta: 'unbound' } }],
  ['empty reasoning', { method: 'item/reasoning/textDelta', params: { threadId, turnId: 'turn-1', itemId: 'reason', delta: '' } }],
  ['malformed reasoning', { method: 'item/reasoning/textDelta', params: { threadId, turnId: 'turn-1', itemId: 'reason', contentIndex: '0', delta: 'unvalidated' } }],
  ['native tool polling', { method: 'item/started', params: { threadId, turnId: 'turn-1', item: { id: 'poll', type: 'mcpToolCall', tool: 'get_state' } } }],
  ['native MCP progress', { method: 'item/mcpToolCall/progress', params: { threadId, turnId: 'turn-1', itemId: 'poll', message: 'still polling' } }],
]) test(`${label} native notifications cannot renew code execution inactivity`, async t => {
  const f = fixture({ hold: true, codeJob: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(invocation(f.runner, async run => {
    const running = run(); void running.catch(() => {});
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(14 * 60_000); f.send(message); t.mock.timers.tick(60_000);
    return running;
  }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } }),
  error => error.code === 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' && didAppServerReap(error));
});

for (const method of ['item/started', 'item/completed']) for (const type of ['reasoning', 'agentMessage']) {
  const notification = id => ({ method, params: { threadId, turnId: 'turn-1', item: { id, type, text: 'Checked source evidence.' } } });
  test(`fresh ${method} ${type} items renew code inactivity`, async t => {
    const f = fixture({ hold: true, codeJob: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await invocation(f.runner, async run => {
      const running = run(); let settled = false;
      void running.then(() => { settled = true; }, () => { settled = true; });
      while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      for (const id of ['first', 'second']) {
        t.mock.timers.tick(14 * 60_000); f.send(notification(id));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
      }
      t.mock.timers.tick(14 * 60_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      f.complete(); return running;
    }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } });
  });
  test(`repeated ${method} ${type} items cannot renew code inactivity`, async t => {
    const f = fixture({ hold: true, codeJob: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await assert.rejects(invocation(f.runner, async run => {
      const running = run(); void running.catch(() => {});
      while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(14 * 60_000); f.send(notification('same'));
      t.mock.timers.tick(14 * 60_000); f.send(notification('same'));
      t.mock.timers.tick(60_000); return running;
    }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } }),
    error => error.code === 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' && didAppServerReap(error));
  });
}

test('changed native plan steps renew code inactivity', async t => {
  const f = fixture({ hold: true, codeJob: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await invocation(f.runner, async run => {
    const running = run(); let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    for (const status of ['pending', 'inProgress', 'completed']) {
      t.mock.timers.tick(14 * 60_000);
      f.send({ method: 'turn/plan/updated', params: { threadId, turnId: 'turn-1', plan: [{ step: 'Verify repair', status }] } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
    }
    t.mock.timers.tick(14 * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    f.complete(); return running;
  }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } });
});

for (const [label, repeatedPlan] of [
  ['identical', [{ step: 'Verify repair', status: 'pending' }]],
  ['empty', []],
  ['blank step', [{ step: ' ', status: 'inProgress' }]],
  ['unknown status', [{ step: 'Verify repair', status: 'heartbeat' }]],
]) test(`${label} native plans cannot renew code inactivity`, async t => {
  const f = fixture({ hold: true, codeJob: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(invocation(f.runner, async run => {
    const running = run(); void running.catch(() => {});
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(14 * 60_000);
    f.send({ method: 'turn/plan/updated', params: { threadId, turnId: 'turn-1', plan: [{ step: 'Verify repair', status: 'pending' }] } });
    t.mock.timers.tick(14 * 60_000);
    f.send({ method: 'turn/plan/updated', params: { threadId, turnId: 'turn-1', plan: repeatedPlan } });
    t.mock.timers.tick(60_000); return running;
  }, { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } }),
  error => error.code === 'STRUCTURED_PROVIDER_IDLE_TIMEOUT' && didAppServerReap(error));
});

test('ordinary native Review retains its elapsed request deadline and reap gate', async t => {
  const f = fixture({ hold: true }); t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(invocation(f.runner, async run => {
    const running = run(); void running.catch(() => {});
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000); return running;
  }), error => error.code === 'STRUCTURED_PROVIDER_TIMEOUT' && didAppServerReap(error));
});

test('code native channels reject missing, forged and serialized watchdogs before starting', async t => {
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); t.after(() => closeCodeExecutionWatchdog(watchdog));
  let starts = 0;
  const runner = new CodexAppServerRunner({ processFactory: () => { starts++; throw new Error('must not start'); } });
  for (const value of [null, {}, structuredClone(watchdog)]) {
    await assert.rejects(runner.run({ executable: {}, args: [], timeoutMs: 1000, codeExecutionWatchdog: value,
      appServer: { isolation: { channel: 'code-job', execution: { url: 'http://127.0.0.1/private', revoke() {} } } } }),
    error => error.code === 'STRUCTURED_PROVIDER_UNAVAILABLE' && didAppServerNotStart(error));
  }
  assert.equal(starts, 0);
  const contained = new ContainedStdioProcess({ run() { starts++; throw new Error('must not start'); } });
  await assert.rejects(contained.start({ codeExecutionWatchdog: structuredClone(watchdog) }), /watchdog is invalid/);
  assert.equal(starts, 0);
});
test('app-server initializes, starts a bound turn, writes structured output and confirms exit',async()=>{
  const f=fixture();
  await invocation(f.runner,async(run,directory)=>{
    const result=await run(); assert.equal(result.exitCode,0);
    assert.match(result.stdoutBytes.toString(),/thread.started/);
    assert.equal(JSON.parse(await readFile(path.join(directory,'last-message.json'),'utf8')).result,'{"ok":true}');
  });
  assert.deepEqual(f.calls.map(x=>x.method),['initialize','thread/start','turn/start']);
  assert.equal(f.calls[2].params.approvalPolicy,'never');
  assert.equal(f.calls[2].params.sandboxPolicy.type,'readOnly');
});
test('live steering goes to the same active turn without rerunning the operation',async()=>{
  const f=fixture({hold:true}); let state=null;
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>state??v,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async()=>{}});
  await invocation(f.runner,async(run)=>{
    const result=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    let view; for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(r=>setImmediate(r));}
    assert.equal(view.live,true);
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'instruct',instruction:'check thread safety'});
    f.complete(); await result;
    assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
    assert.equal(f.calls.find(x=>x.method==='turn/steer').params.expectedTurnId,'turn-1');
  });
});
test('failed turns never publish a structured result',async()=>{
  await assert.rejects(invocation(fixture({failed:true}).runner),e=>e.code==='STRUCTURED_PROVIDER_PROCESS_FAILED' && didAppServerReap(e));
});

for (const source of ['error', 'turn/completed']) {
  for (const error of [
    { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' },
    { message: 'Selected model is at capacity. Please try a different model.' },
  ]) test(`${source} model capacity is a sanitized transient failure after confirmed reap (${error.codexErrorInfo ?? 'legacy'})`, async () => {
    const f = fixture({ hold: true });
    await assert.rejects(invocation(f.runner, async run => {
      const operation = run(); void operation.catch(() => {});
      while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      f.send(source === 'error'
        ? { method: source, params: { threadId, turnId: 'turn-1', willRetry: false, error } }
        : { method: source, params: { threadId, turn: { id: 'turn-1', status: 'failed', error } } });
      return operation;
    }), error => error.code === 'STRUCTURED_PROVIDER_MODEL_CAPACITY' && error.statusCode === 503 && didAppServerReap(error));
  });
}

test('model capacity in agent content, another turn, or an internally retried error does not fail the active turn', async () => {
  const f = fixture({ hold: true });
  await invocation(f.runner, async run => {
    const operation = run(); void operation.catch(() => {});
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const error = { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' };
    f.send({ method: 'error', params: { threadId, turnId: 'older-turn', willRetry: false, error } });
    f.send({ method: 'error', params: { threadId, turnId: 'turn-1', willRetry: true, error } });
    f.send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', text: error.message } } });
    f.complete();
    assert.equal((await operation).exitCode, 0);
  });
});

for (const stopFailure of [false, true]) test(`model capacity classification preserves authentication and stop failures (${stopFailure})`, async () => {
  const f = fixture({ hold: true, stopFailure });
  await assert.rejects(invocation(f.runner, async run => {
    const operation = run(); void operation.catch(() => {});
    while (!f.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    f.send({ method: 'error', params: { threadId, turnId: 'turn-1', willRetry: false, error: {
      message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: stopFailure ? 'serverOverloaded' : 'unauthorized',
    } } });
    return operation;
  }), error => error.code === (stopFailure ? 'STRUCTURED_PROVIDER_REAP_FAILED' : 'STRUCTURED_PROVIDER_PROCESS_FAILED'));
});

for (const data of [undefined, { codexErrorInfo: 'other' }, { codexErrorInfo: 'serverOverloaded' }]) {
  test(`turn start RPC capacity error retains outer message and structured details (${data?.codexErrorInfo ?? 'legacy'})`, async () => {
    const f = fixture({ turnStartFailure: { code: -32603, message: 'Selected model is at capacity. Please try a different model.', ...(data ? { data } : {}) } });
    await assert.rejects(invocation(f.runner), error => error.code === 'STRUCTURED_PROVIDER_MODEL_CAPACITY' && didAppServerReap(error));
  });
}

test('a reaped initialization failure certifies no model turn without claiming no process spawned',async()=>{
  await assert.rejects(invocation(fixture({initializationFailure:true}).runner),error=>
    didAppServerNotStartModel(error) && !didAppServerNotStart(error));
});

test('unknown terminal status is not accepted as a completed response',async()=>{
  const f=fixture({hold:true});
  await assert.rejects(invocation(f.runner,async run=>{
    const result=run();void result.catch(()=>{});
    for(let i=0;i<100&&!f.calls.some(x=>x.method==='turn/start');i++)await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
    f.send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'inProgress'}}});return result;
  }),{code:'STRUCTURED_PROVIDER_RESPONSE_INVALID'});
});
test('unconfirmed process stop remains fenced',async()=>{
  await assert.rejects(invocation(fixture({stopFailure:true}).runner),e=>e.code==='STRUCTURED_PROVIDER_REAP_FAILED' && !didAppServerReap(e));
});

test('the real managed stdio process exchanges RPC frames without closing its input early',async()=>{
  const source=`import readline from 'node:readline';const send=x=>console.log(JSON.stringify(x));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method.startsWith('thread/'))result={thread:{id:'${threadId}'}};if(r.method==='turn/start')result={turn:{id:'turn-1'}};send({id:r.id,result});if(r.method==='turn/start'){send({method:'item/completed',params:{threadId:'${threadId}',turnId:'turn-1',item:{type:'agentMessage',text:JSON.stringify({result:JSON.stringify({ok:true})})}}});send({method:'turn/completed',params:{threadId:'${threadId}',turn:{id:'turn-1',status:'completed'}}});}});`;
  const runner=new CodexAppServerRunner({processFactory:()=>new ManagedProcess(),materialize:async()=>({command:process.execPath,prefixArgs:['--input-type=module','-e',source]})});
  const result=await invocation(runner);assert.equal(result.exitCode,0);
});

test('contained stdio drives RPC through the Windows Job Object supervisor', {skip:process.platform!=='win32'},async(t)=>{
  const source=`const send=x=>console.log(JSON.stringify(x));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method.startsWith('thread/'))result={thread:{id:'${threadId}'}};if(r.method==='turn/start')result={turn:{id:'turn-1'}};send({id:r.id,result});if(r.method==='turn/start'){send({method:'item/completed',params:{threadId:'${threadId}',turnId:'turn-1',item:{id:'final',type:'agentMessage',text:JSON.stringify({result:JSON.stringify({ok:true})})}}});send({method:'turn/completed',params:{threadId:'${threadId}',turn:{id:'turn-1',status:'completed'}}});}});`;
  const processRunner=createTestSupervisedProcessRunner({descriptorMaterializer:async descriptor=>descriptor});
  const runner=new CodexAppServerRunner({processRunner});
  const directory=await mkdtemp(path.join(tmpdir(),'contained-app-server-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const result=await runner.run({executable:{command:process.execPath,prefixArgs:['-e',source]},args:[],cwd:directory,env:{},timeoutMs:15_000,
    appServer:{input:'safe task',model:'test-model',schema:{type:'object'},previous:null}});
  assert.equal(runner.supportsContainedExecution,true);
  assert.equal(result.exitCode,0);
  assert.equal(JSON.parse(await readFile(path.join(directory,'last-message.json'),'utf8')).result,'{"ok":true}');
});

test('live pause waits for interrupted turn and confirmed process exit before settling',async()=>{
  const f=fixture({hold:true});let state=null;const settlements=[];
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>state??v,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async(input)=>settlements.push(input)});
  await invocation(f.runner,async(run)=>{
    const result=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const rejected=assert.rejects(result,e=>e.code==='TASK_RUN_PAUSED');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(r=>setImmediate(r));}
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    await rejected;assert.equal(settlements[0].command,'pause');assert.equal((await registry.list()).held[0].phase,'paused');
  });
});

test('interrupt acknowledgement and turn interruption do not settle pause before confirmed exit',async()=>{
  let releaseStop;const stopGate={promise:new Promise(resolve=>{releaseStop=resolve;})};
  const f=fixture({hold:true,manualInterrupt:true,stopGate});let saved=null;const settlements=[];
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>saved??v,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:async value=>settlements.push(value)});
  await invocation(f.runner,async(run)=>{
    const running=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const stopped=assert.rejects(running,error=>error.code==='TASK_RUN_PAUSED');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(resolve=>setImmediate(resolve));}
    const control=registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    for(let i=0;i<100 && !f.calls.some(call=>call.method==='turn/interrupt');i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settlements.length,0);f.acknowledgeInterrupt();await control;
    assert.equal((await registry.list()).items[0].pendingCommand,'pause');assert.equal(settlements.length,0);
    f.interrupted();await f.stopping;assert.equal(settlements.length,0);
    assert.equal((await registry.list()).items[0].pendingCommand,'pause');
    releaseStop();await stopped;assert.equal(settlements.length,1);
  });
});

test('a registry-bound reap failure remains stop-unconfirmed after interruption',async()=>{
  const f=fixture({hold:true,stopFailure:true});let saved=null;let settlements=0;
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>saved??v,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:async()=>{settlements++;}});
  await invocation(f.runner,async(run)=>{
    const running=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const stopped=assert.rejects(running,error=>error.code==='TASK_RUN_CONTROL_PENDING');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(resolve=>setImmediate(resolve));}
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    await stopped;await registry.reconcile();assert.equal(settlements,0);
    assert.equal((await registry.list()).held[0].stopUnconfirmed,true);
  });
});

test('another thread or turn cannot complete the active response',async()=>{
  const f=fixture({hold:true});
  await invocation(f.runner,async(run)=>{
    let finished=false;const running=run().then(value=>{finished=true;return value;});
    for(let i=0;i<100 && !f.calls.some(call=>call.method==='turn/start');i++)await new Promise(resolve=>setImmediate(resolve));
    for(const [target,turn] of [[threadId,'old-turn'],['another-thread','turn-1']])f.send({method:'turn/completed',params:{threadId:target,turn:{id:turn,status:'completed'}}});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);f.complete();await running;
  });
});

test('notifications preceding turn start response are fenced by the returned turn ID',async()=>{
  let options;
  const process={exited:false,start(value){options=value;},write(line){
    const r=JSON.parse(line);if(!r.id)return;
    const send=value=>options.onLine({stream:'stdout',line:JSON.stringify(value)});
    if(r.method==='turn/start') {
      send({method:'turn/completed',params:{threadId,turn:{id:'old-turn',status:'completed'}}});
      send({method:'item/agentMessage/delta',params:{threadId,turnId:'turn-1',itemId:'answer',delta:'visible progress'}});
    }
    send({id:r.id,result:r.method.startsWith('thread/')?{thread:{id:threadId}}:r.method==='turn/start'?{turn:{id:'turn-1'}}:{}});
    if(r.method==='turn/start')queueMicrotask(()=>{
      send({method:'item/completed',params:{threadId,turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'{"result":"{\\"ok\\":true}"}'}}});
      send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'completed'}}});
    });
  },async stop(){this.exited=true;}};
  const events=[];const sessions=[];
  await invocation(new CodexAppServerRunner({processFactory:()=>process,materialize:async()=>({command:'codex',prefixArgs:[]})}),
    run=>withTaskExecution({reportProgress(){},reportEvent:value=>events.push(value),reportSession:value=>sessions.push(value)},run));
  assert.equal(events.length,1);assert.equal(events[0].text,'visible progress');
  assert.equal(sessions.at(-1).status,'completed');assert.equal(sessions.at(-1).turnId,'turn-1');
});

test('a steer acknowledgement for a different turn is rejected',async()=>{
  const f=fixture({hold:true,steerTurnId:'different-turn'});
  await invocation(f.runner,async(run)=>{
    let live;const running=withTaskExecution({reportProgress(){},registerLiveControl:value=>{live=value;return()=>{};}},run);
    for(let i=0;i<100 && !live;i++)await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(live.steer('check races','message-1'),error=>error.code==='STRUCTURED_PROVIDER_RESPONSE_INVALID');
    f.complete();await running;
  });
});

test('a missing steer acknowledgement turn ID cannot certify delivery',async()=>{
  const f=fixture({hold:true,steerTurnId:false});
  await invocation(f.runner,async run=>{
    let live;const running=withTaskExecution({reportProgress(){},registerLiveControl:value=>{live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(live.steer('check races','message-1'),{code:'STRUCTURED_PROVIDER_RESPONSE_INVALID'});
    f.complete();await running;
  });
});

test('resuming a different native thread fails before a model turn starts',async()=>{
  const f=fixture();
  await assert.rejects(invocation(f.runner,run=>run(),{previous:'01973bca-3d8b-7000-a000-987654321abc'}),error=>error.code==='STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED');
  assert.equal(f.calls.some(call=>call.method==='turn/start'),false);
});

test('a continuous code channel verifies exact host tools and revokes admission at native completion',async()=>{
  const f=fixture({codeJob:true});let revoked=false,confirmed=0;
  await invocation(f.runner,run=>withTaskExecution({reportProgress(){},confirmStopped(){confirmed++;}},run),{
    isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true},
  });
  assert.equal(revoked,true);assert.equal(confirmed,0);
  const thread=f.calls.find(call=>call.method==='thread/start');
  assert.match(thread.params.baseInstructions,/one continuous controlled code job/);
  assert.equal(thread.params.config.mcp_servers.old.enabled,false);
  const input=f.calls.find(call=>call.method==='turn/start').params.input[0].text;
  assert.match(input,/dih_code_job_[a-f0-9]{16}/);
});

test('continuous pause revokes tools before interrupt and defers stop certification to the host drain',async()=>{
  let revoked=false,confirmed=0,live;
  const f=fixture({hold:true,codeJob:true,onInterrupt(){assert.equal(revoked,true);}});
  await invocation(f.runner,async run=>{
    const running=withTaskExecution({reportProgress(){},confirmStopped(){confirmed++;},registerLiveControl(value){live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    await live.interrupt();
    const result=await running;
    assert.equal(result.interrupted,true);assert.equal(confirmed,0);
  },{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}});
});

test('review tools and extra tools cannot enter a continuous code turn',async()=>{
  for(const toolInventory of [['read_document','read_source','list_directory'],['perform_action','read_source','get_state','shell']]) {
    const f=fixture({codeJob:true,toolInventory});let revoked=false;
    await assert.rejects(invocation(f.runner,run=>run(),{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
    assert.equal(revoked,true);assert.equal(f.calls.some(call=>call.method==='turn/start'),false);
  }
});

test('a captured late interrupt after terminal completion does not send an RPC during process teardown',async()=>{
  let releaseStop,live;
  const stopGate={promise:new Promise(resolve=>{releaseStop=resolve;})};
  const f=fixture({hold:true,codeJob:true,stopGate});let revoked=false;
  await invocation(f.runner,async run=>{
    const running=withTaskExecution({reportProgress(){},registerLiveControl(value){live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    f.complete();await f.stopping;
    await live.interrupt();
    assert.equal(revoked,true);
    assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false);
    releaseStop();await running;
  },{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}});
});
