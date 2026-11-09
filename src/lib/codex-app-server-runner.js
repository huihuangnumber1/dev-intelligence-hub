import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { materializeVerifiedCliDescriptor } from './known-cli-locator.js';
import { parseJsonWithUniqueKeys, parseProtocolJsonWithUniqueKeys } from './strict-json.js';
import { currentTaskExecution } from './task-execution-context.js';
import { isNativeCodexThreadId } from '../adapters/codex-native-session-store.js';
import { ContainedStdioProcess } from './contained-stdio-process.js';
import { randomBytes } from 'node:crypto';
import { codeExecutionWatchdogSignal, startCodeExecutionTurn, reportCodeExecutionActivity } from './code-execution-watchdog.js';
import { threadConfiguration, assertEffectiveAppServerPolicy, NATIVE_CHANNEL_INSTRUCTIONS, CODE_EXECUTION_CHANNEL_INSTRUCTIONS, CODE_EXECUTION_TOOLS } from './codex-app-server-policy.js';

const FAILURE_OUTPUT = new WeakMap();
const FAILURE_DIAGNOSTICS = new WeakMap();
export const readAppServerFailureDiagnostic = error => FAILURE_DIAGNOSTICS.get(error) ?? null;
const NOT_STARTED = new WeakSet();
const NO_MODEL_TURN = new WeakSet();
const REAPED_FAILURES = new WeakSet();
export const readAppServerFailureOutput = (error) => FAILURE_OUTPUT.get(error) ?? null;
export const didAppServerNotStart = (error) => NOT_STARTED.has(error);
export const didAppServerNotStartModel = (error) => NO_MODEL_TURN.has(error);
export const didAppServerReap = (error) => REAPED_FAILURES.has(error);
function failure(code='STRUCTURED_PROVIDER_PROCESS_FAILED') {
  return Object.assign(new Error(code),{code,statusCode:code==='STRUCTURED_PROVIDER_MODEL_CAPACITY'?503:['STRUCTURED_PROVIDER_TIMEOUT','STRUCTURED_PROVIDER_IDLE_TIMEOUT'].includes(code)?504:502});
}
function providerFailure(error, details = error) {
  // Inspect only trusted protocol errors, never agent messages or tool output.
  const info = details?.codexErrorInfo;
  const overloaded = info === 'serverOverloaded' ||
    ((info == null || info === 'other') &&
      (error?.message ?? details?.message) === 'Selected model is at capacity. Please try a different model.');
  return failure(overloaded ? 'STRUCTURED_PROVIDER_MODEL_CAPACITY' : 'STRUCTURED_PROVIDER_PROCESS_FAILED');
}
function deferred() {
  let resolve,reject;
  const promise=new Promise((accept,fail)=>{resolve=accept;reject=fail;});
  // Notifications can precede the response that the caller is awaiting.
  void promise.catch(()=>{});
  return {promise,resolve,reject};
}

export class CodexAppServerRunner {
  constructor({processFactory=null,materialize=materializeVerifiedCliDescriptor,processRunner}={}) {
    this.processFactory=processFactory; this.materialize=materialize;
    this.processRunner=processRunner;
    this.supportsContainedExecution=!processFactory && process.platform==='win32';
  }

  async run({executable,args,cwd,env,signal,timeoutMs,appServer,codeExecutionWatchdog=null,onThreadIdentified=null}) {
    // Protocol fixtures can inject a process. Production needs a contained,
    // bidirectional supervisor: a direct child's exit is not tree-reap proof.
    if ((!this.processFactory && !this.supportsContainedExecution) || !appServer ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        (appServer.isolation?.channel === 'code-job' &&
          (!appServer.isolation.execution || typeof appServer.isolation.execution.url !== 'string' ||
            typeof appServer.isolation.execution.revoke !== 'function' || appServer.isolation.reader || appServer.isolation.skill))) {
      const error=failure('STRUCTURED_PROVIDER_UNAVAILABLE');NOT_STARTED.add(error);throw error;
    }
    let watchdogSignal;
    try {
      watchdogSignal = codeExecutionWatchdog === null ? null : codeExecutionWatchdogSignal(codeExecutionWatchdog);
      if (Boolean(watchdogSignal) !== (appServer.isolation?.channel === 'code-job')) throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
    } catch { const error = failure('STRUCTURED_PROVIDER_UNAVAILABLE'); NOT_STARTED.add(error); throw error; }
    if (watchdogSignal) signal = signal ? AbortSignal.any([signal, watchdogSignal]) : watchdogSignal;
    let descriptor;
    try { if(this.processFactory)descriptor=await this.materialize(executable,{signal}); }
    catch(cause){const error=failure('STRUCTURED_PROVIDER_UNAVAILABLE');NOT_STARTED.add(error);throw error;}
    if(signal?.aborted){const error=failure('STRUCTURED_PROVIDER_CANCELLED');NOT_STARTED.add(error);throw error;}
    const process=this.processFactory ? this.processFactory() : new ContainedStdioProcess(this.processRunner);
    const completed=deferred(); const pending=new Map();
    const context=currentTaskExecution(); let threadId=appServer.previous,turnId=null,text=null;
    const codeExecution = appServer.isolation?.channel === 'code-job';
    const revokeTools = () => appServer.isolation?.execution?.revoke();
    let sequence=0,started=false,initialized=false,terminal=false,accepting=true,interrupted=false,detach,output,error,turnAttempted=false;
    const earlyEvents=[];const streamedItems=new Set();let earlyBytes=0;
    const activityItems = new Set(); let lastPlan = null;
    let nativeFailure = null;
    const reportNativeFailure=(value,text)=>{
      nativeFailure = Object.freeze({ ...value });
      // Diagnostic observers must not replace a native failure or strand its waiter.
      try { context?.reportNativeFailure?.(value); } catch {}
      if(text)try { context?.reportEvent?.({type:'status',text}); } catch {}
    };
    const reportTransportFailure=(kind,code)=>{
      if(accepting && !terminal)reportNativeFailure({kind,method:pending.values().next().value?.method??null,
        code:Number.isSafeInteger(code)?code:null});
    };
    const request=(method,params)=>{
      if(process.exited) return Promise.reject(failure());
      const id=++sequence; const waiting=deferred();
      const timer=setTimeout(()=>{pending.delete(id);waiting.reject(failure('STRUCTURED_PROVIDER_TIMEOUT'));},Math.min(timeoutMs,30_000));
      pending.set(id,{...waiting,timer,method});
      try{process.write(`${JSON.stringify({id,method,params})}\n`);}catch(cause){clearTimeout(timer);pending.delete(id);waiting.reject(failure());}
      return waiting.promise;
    };
    const fail=(cause)=>{
      accepting=false;
      revokeTools();
      const problem=cause?.code?.startsWith('STRUCTURED_PROVIDER_') ? cause : failure(initialized ? 'STRUCTURED_PROVIDER_PROCESS_FAILED' : 'STRUCTURED_PROVIDER_UNAVAILABLE');
      completed.reject(problem);
      for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(problem);}
      pending.clear();
    };
    const receive=({stream,line})=>{
      if(!accepting || stream!=='stdout' || !line.trim())return;
      try {
        let message;
        try { message=parseProtocolJsonWithUniqueKeys(line); }
        catch { throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID'); }
        if(!message || typeof message!=='object' || Array.isArray(message))throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        if(message.method && message.id!==undefined){
          process.write(`${JSON.stringify({id:message.id,error:{code:-32601,message:'Interactive server requests are not authorized in this controlled channel'}})}\n`);
          return;
        }
        if(message.id!==undefined){
          const waiting=pending.get(message.id);if(!waiting)return;
          clearTimeout(waiting.timer);pending.delete(message.id);
          if(message.error) {
            // Server messages/data may contain private paths or credentials.
            const code=Number.isSafeInteger(message.error.code)?message.error.code:'unknown';
            reportNativeFailure({kind:'rpc_error',method:waiting.method,code:code==='unknown'?null:code},
              `Native RPC failed: ${waiting.method} (code ${code})`);
            waiting.reject(providerFailure(message.error, message.error.data ?? message.error));
          } else waiting.resolve(message.result);
          return;
        }
        const params=message.params??{};
        if(params.threadId!==threadId)return;
        if(!turnId) {
          earlyBytes+=Buffer.byteLength(line);
          if(earlyEvents.length>=512 || earlyBytes>8*1024*1024)throw failure('STRUCTURED_PROVIDER_OUTPUT_LIMIT');
          earlyEvents.push({stream,line});return;
        }
        const eventTurn=params.turnId??params.turn?.id;
        if(eventTurn && eventTurn!==turnId)return;
        if(terminal)return;
        if (codeExecutionWatchdog && eventTurn === turnId) {
          const deltaEvent = message.method === 'item/agentMessage/delta' ||
            (message.method === 'item/reasoning/textDelta' && Number.isSafeInteger(params.contentIndex) && params.contentIndex >= 0) ||
            (message.method === 'item/reasoning/summaryTextDelta' && Number.isSafeInteger(params.summaryIndex) && params.summaryIndex >= 0);
          let meaningful = deltaEvent &&
            typeof params.itemId === 'string' && params.itemId.length > 0 && typeof params.delta === 'string' && params.delta.trim().length > 0;
          if (['item/started', 'item/completed'].includes(message.method) && ['reasoning', 'agentMessage'].includes(params.item?.type) &&
              typeof params.item.id === 'string' && params.item.id.length > 0) {
            const key = `${message.method}:${params.item.id}`;
            meaningful ||= !activityItems.has(key); activityItems.add(key);
          }
          if (message.method === 'turn/plan/updated' && Array.isArray(params.plan) && params.plan.length > 0 && params.plan.every(step =>
            typeof step?.step === 'string' && step.step.trim() && ['pending', 'inProgress', 'completed'].includes(step.status))) {
            const plan = JSON.stringify(params.plan); meaningful ||= plan !== lastPlan; lastPlan = plan;
          }
          if (meaningful) { reportCodeExecutionActivity(codeExecutionWatchdog); context?.reportActivity?.(); }
        } else if (!codeExecutionWatchdog) context?.reportActivity?.();
        if(message.method==='item/completed' && params.item?.type==='agentMessage')text=params.item.text;
        if(message.method==='item/agentMessage/delta' && typeof params.delta==='string') {
          streamedItems.add(params.itemId);
          context?.reportEvent?.({type:'message',text:params.delta,...(params.itemId?{itemId:params.itemId}:{})});
        }
        if(message.method==='item/completed' && params.item?.type==='agentMessage' && !streamedItems.has(params.item.id)) {
          context?.reportEvent?.({type:'message',text:params.item.text,...(params.item.id?{itemId:params.item.id}:{})});
        }
        if(message.method==='item/started' && params.item?.type==='mcpToolCall') {
          context?.reportEvent?.({type:'tool',text:`${params.item.server ?? 'MCP'} / ${params.item.tool ?? '读取资料'}`,...(params.item.id?{itemId:params.item.id}:{})});
        }
        if(message.method==='item/started' && ['subAgentActivity','collabAgentToolCall'].includes(params.item?.type)) {
          context?.reportEvent?.({type:'tool',text:`独立审查员：${params.item.kind ?? params.item.tool ?? '活动更新'}`,...(params.item.id?{itemId:params.item.id}:{})});
        }
        if(message.method==='turn/plan/updated' && Array.isArray(params.plan)) {
          context?.reportEvent?.({type:'plan',text:params.plan.map(step=>`${step.status}: ${step.step}`).join('\n')});
        }
        const progress={
          'turn/started':'正在分析任务', 'item/started':'正在读取或检查代码',
          'item/completed':'检查步骤已完成', 'item/commandExecution/outputDelta':'代码检查有新输出',
          'item/mcpToolCall/progress':codeExecution?'正在执行受控代码动作':'正在读取 PR 材料', 'turn/plan/updated':'执行计划已更新',
          'item/agentMessage/delta':'正在生成判断',
        }[message.method];
        if(progress)context?.reportProgress(progress);
        if(message.method==='turn/completed'){
          if(!['completed','failed','interrupted'].includes(params.turn?.status))throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
          revokeTools();terminal=true;turnId=params.turn?.id??turnId;
          interrupted=params.turn?.status==='interrupted';
          context?.reportSession?.({transport:'app-server',threadId,turnId,status:interrupted?'interrupted':params.turn?.status==='failed'?'failed':'completed'});
          if(params.turn?.status==='failed')completed.reject(providerFailure(params.turn.error));
          else completed.resolve();
        }
        if(message.method==='error' && params.willRetry===false)fail(providerFailure(params.error));
      }catch(cause){fail(cause);}
    };
    const abort=()=>fail(watchdogSignal?.aborted ? watchdogSignal.reason : failure('STRUCTURED_PROVIDER_CANCELLED'));
    const deadline=watchdogSignal ? null : setTimeout(()=>fail(failure('STRUCTURED_PROVIDER_TIMEOUT')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try {
      started=true;
      await process.start({...(descriptor ? {command:descriptor.command,args:[...descriptor.prefixArgs,...args]} : {executable,args}),cwd,env,
        timeoutMs,signal,...(codeExecutionWatchdog ? { codeExecutionWatchdog } : {}),maxStdoutBytes:64*1024*1024,maxStderrBytes:1024*1024,
        keepStdinOpen:true,onLine:receive,onError:cause=>{reportTransportFailure('process_error');fail(cause);},onLimit:()=>fail(failure('STRUCTURED_PROVIDER_OUTPUT_LIMIT')),
        onExit:result=>{reportTransportFailure('process_exit',result?.exitCode);if(!terminal)fail(failure(initialized ? 'STRUCTURED_PROVIDER_PROCESS_FAILED' : 'STRUCTURED_PROVIDER_UNAVAILABLE'));}});
      if (!accepting) await completed.promise;
      await request('initialize',{clientInfo:{name:'dev_intelligence_hub',version:'0.1.0'},capabilities:{experimentalApi:true}});
      initialized=true;
      process.write(`${JSON.stringify({method:'initialized',params:{}})}\n`);
      let config,namespace;
      if(appServer.isolation) {
        const effective=await request('config/read',{includeLayers:false,cwd});
        assertEffectiveAppServerPolicy(effective?.config,{channel:codeExecution?'code-job':'review'});
        namespace=`${codeExecution?'dih_code_job':'dih_pr_review'}_${randomBytes(8).toString('hex')}`;
        config=threadConfiguration(effective?.config,{...appServer.isolation,namespace});
      }
      const resumed=await request(threadId?'thread/resume':'thread/start',{
        ...(threadId?{threadId}:{}),cwd,model:appServer.model,approvalPolicy:'never',sandbox:'read-only',
        ...(appServer.isolation?{config,modelProvider:'openai',baseInstructions:codeExecution?CODE_EXECUTION_CHANNEL_INSTRUCTIONS:NATIVE_CHANNEL_INSTRUCTIONS,developerInstructions:codeExecution?CODE_EXECUTION_CHANNEL_INSTRUCTIONS:NATIVE_CHANNEL_INSTRUCTIONS,
          runtimeWorkspaceRoots:[cwd],...(threadId?{excludeTurns:true}:{ephemeral:appServer.isolation.ephemeral,historyMode:'legacy'})}:{}),
      });
      const actual=resumed?.thread?.id;
      if(!isNativeCodexThreadId(actual) || (threadId && actual!==threadId))throw failure('STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED');
      threadId=actual;
      if(appServer.isolation) {
        if(resumed.approvalPolicy!=='never' || resumed.sandbox?.type!=='readOnly' || resumed.sandbox.networkAccess!==false)throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
        let cursor=null,seenReader=false;const cursors=new Set();
        do {
          const servers=await request('mcpServerStatus/list',{threadId,limit:100,detail:'toolsAndAuthOnly',...(cursor?{cursor}:{})});
          if(!Array.isArray(servers?.data))throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
          for(const server of servers.data) {
            const tools=Object.keys(server.tools??{});
            if(server.name===namespace) {
              const expectedTools=codeExecution?CODE_EXECUTION_TOOLS:['read_document','read_source','list_directory'];
              if(tools.length!==expectedTools.length || !expectedTools.every(tool=>tools.includes(tool)))throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
              seenReader=true;
            } else if(tools.length)throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
          }
          cursor=servers.nextCursor??null;
          if(cursor && (cursors.has(cursor) || cursors.size>=3))throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
          if(cursor)cursors.add(cursor);
        }while(cursor);
        if((appServer.isolation.reader || appServer.isolation.execution) && !seenReader)throw failure('STRUCTURED_PROVIDER_UNAVAILABLE');
      }
      // Host-only persistence runs after identity and isolation validation. A
      // cancelled or failed transport must not start a turn when it settles.
      await onThreadIdentified?.(threadId);
      if (!accepting) await completed.promise;
      signal?.throwIfAborted();
      context?.reportSession?.({transport:'app-server',threadId,turnId:null,status:'starting'});
      const skill=appServer.isolation?.skill;
      const input=codeExecution ? `For this invocation, references to the code-job MCP server mean ${namespace}.\n${appServer.input}`
        : namespace && appServer.isolation.reader ? `For this invocation, references to pr_review in task and skill instructions mean the read-only MCP server ${namespace}.\n${appServer.input}` : appServer.input;
      turnAttempted=true;
      const begun=await request('turn/start',{threadId,cwd,model:appServer.model,
        ...(appServer.effort?{effort:appServer.effort}:{}),
        input:[{type:'text',text:input,text_elements:[]},...(skill?[{type:'skill',name:skill.name,path:skill.path}]:[])],outputSchema:appServer.schema,
        approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
      if(typeof begun?.turn?.id!=='string' || !begun.turn.id || (turnId && turnId!==begun.turn.id))throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
      turnId=begun.turn.id;
      if (codeExecutionWatchdog) startCodeExecutionTurn(codeExecutionWatchdog);
      context?.reportSession?.({transport:'app-server',threadId,turnId,status:'running'});
      for(const event of earlyEvents)receive(event);
      if(!terminal)detach=context?.registerLiveControl({
        steer:async(instruction,clientUserMessageId)=>{
          if(terminal)throw failure();
          const accepted=await request('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text:instruction,text_elements:[]}],clientUserMessageId});
          if(accepted?.turnId!==turnId)throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        },
        interrupt:()=>{
          revokeTools();
          // A captured live-control callback can arrive while process teardown
          // drains. The terminal event already proves no active native turn;
          // do not create an RPC waiter after finally cleared pending requests.
          return terminal ? Promise.resolve({}) : request('turn/interrupt',{threadId,turnId});
        },
      });
      await completed.promise;
      if(!interrupted){
        if(typeof text!=='string' || Buffer.byteLength(text)>1024*1024)throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        parseJsonWithUniqueKeys(text);
        await writeFile(path.join(cwd,'last-message.json'),text,{flag:'wx',mode:0o600});
      }
      output={exitCode:0,signal:null,stdoutBytes:Buffer.from(JSON.stringify({type:'thread.started',thread_id:threadId})+'\n'),interrupted};
    }catch(cause){error=cause;}
    finally {
      accepting=false;
      revokeTools();
      clearTimeout(deadline);signal?.removeEventListener('abort',abort);detach?.();
      for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(error??failure());}pending.clear();
      if(started){
        try { await process.stop({gracefulMs:1_000});if(!process.exited)throw failure(); }
        catch (cause) {
          if(!process.exited || cause?.code==='STRUCTURED_PROVIDER_REAP_FAILED')error=failure('STRUCTURED_PROVIDER_REAP_FAILED');
          else error??=cause;
        }
      }
      // A code job can still own an admitted host action after native exit.
      // Its provider certifies stop only after the execution MCP drains too.
      if(interrupted && !error && !codeExecution)context?.confirmStopped();
    }
    if(error){
      if (nativeFailure) FAILURE_DIAGNOSTICS.set(error, nativeFailure);
      if(started && process.exited && error.code!=='STRUCTURED_PROVIDER_REAP_FAILED')REAPED_FAILURES.add(error);
      if(threadId && (appServer.previous || turnAttempted))FAILURE_OUTPUT.set(error,{stdoutBytes:Buffer.from(JSON.stringify({type:'thread.started',thread_id:threadId})+'\n')});
      if(!started || process.notStarted)NOT_STARTED.add(error);
      if(!turnAttempted && process.exited)NO_MODEL_TURN.add(error);
      throw error;
    }
    return output;
  }
}
