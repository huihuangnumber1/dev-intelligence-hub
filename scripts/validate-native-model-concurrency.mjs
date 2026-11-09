import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeCodexBrainProvider} from '../src/adapters/native-codex-brain-provider.js';
import {CodexAppServerRunner} from '../src/lib/codex-app-server-runner.js';
import {withTaskExecution} from '../src/lib/task-execution-context.js';

if(process.platform!=='win32')throw new Error('This validation requires the real Windows contained App Server transport');
const root=await mkdtemp(path.join(tmpdir(),'dih-native-concurrency-live-'));
// Temp can inherit Codex sandbox-group write permissions. Protect only this
// newly owned test directory before using the production directory verifier.
await promisify(execFile)(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',`
  $ErrorActionPreference='Stop'
  $target=$env:DIH_NATIVE_VALIDATION_ROOT
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($current.Value,'S-1-5-18','S-1-5-32-544')) {
    $identity=[Security.Principal.SecurityIdentifier]::new($sid)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($target,$acl)
`],{windowsHide:true,env:{...process.env,DIH_NATIVE_VALIDATION_ROOT:root}});
const nativeHome=path.resolve(process.env.CODEX_HOME || path.join(homedir(),'.codex'));
const model=process.env.DIH_NATIVE_CONCURRENCY_VALIDATION_MODEL || 'gpt-6.1-sol';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const protectedSnapshot=async()=>Object.fromEntries(await Promise.all(['auth.json','config.toml'].map(async name=>{
  try{return [name,digest(await readFile(path.join(nativeHome,name)))];}catch(error){if(error.code==='ENOENT')return [name,null];throw error;}
})));
const before=await protectedSnapshot();
const appServerRunner=new CodexAppServerRunner();
const temporaryRoot=path.join(root,'runtime');
const runtime=`${temporaryRoot}-native`;
const provider=new NativeCodexBrainProvider({id:'native-concurrency-live',cliKind:'codex-cli',credentialMode:'codex-native-login',timeoutMs:180_000},{
  environment:{...process.env,CODEX_HOME:nativeHome,DIH_CODEX_NATIVE_TRANSPORT:'app-server'},temporaryRoot,appServerRunner,
  maxConcurrentTurns:2,allowConcurrentNativeHome:true,
});
const validationId=randomUUID();
const runs=[];const markerSamples=[];
let sampling=true;
const sample=async()=>{
  while(sampling){
    try{
      const markers=(await readdir(runtime)).filter(name=>name.startsWith('active-') && name.endsWith('.json'));
      if(markers.length!==markerSamples.at(-1)?.markers.length)markerSamples.push({at:new Date().toISOString(),markers});
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
};
const samplingDone=sample();
const n=12345n,expected=(n*(n+1n)*(2n*n+1n)/6n).toString();
const execute=async index=>{
  const entity=`synthetic-concurrency:${validationId}:${index}`;
  const run={entity,threadId:null,turnId:null,modelStartedAt:null,modelFinishedAt:null,status:'preparing',activityCount:0,resultCorrect:false};runs.push(run);
  const context={
    reportModelState(phase){run.status=phase;},
    reportActivity(){run.activityCount++;},reportProgress(){run.activityCount++;},reportEvent(){run.activityCount++;},
    reportSession(session){
      run.threadId=session.threadId;run.turnId=session.turnId;run.status=session.status;
      if(session.status==='running')run.modelStartedAt=new Date().toISOString();
      if(['completed','failed','interrupted'].includes(session.status))run.modelFinishedAt=new Date().toISOString();
      process.stdout.write(JSON.stringify({entity:index,status:session.status,at:new Date().toISOString()})+'\n');
    },
    registerLiveControl(){return ()=>{};},confirmStopped(){run.stopConfirmed=true;},
  };
  try{
    const output=await withTaskExecution(context,()=>provider.withAdmission({entityKey:entity},()=>provider.generate({
      model,reasoningEffort:'high',sessionKey:entity,
      messages:[{role:'user',content:`This is an isolated synthetic arithmetic validation. Do not use any tools, access project files, or send any messages. Derive the sum of squares of the integers from 1 through 12345 using the closed form formula, independently check both intermediate multiplications, and return only an object with ok:true, entity:${JSON.stringify(entity)}, and squareSum as a base-10 string. No explanation is needed in the final object.`}],
      schema:{type:'object',additionalProperties:false,required:['ok','entity','squareSum'],properties:{ok:{type:'boolean'},entity:{type:'string'},squareSum:{type:'string'}}},
    })));
    const result=JSON.parse(output);run.resultCorrect=result.ok===true && result.entity===entity && result.squareSum===expected;
    run.status='completed';
  }catch(error){run.status='failed';run.code=typeof error.code==='string'?error.code:'VALIDATION_FAILED';}
};
await Promise.all([execute(1),execute(2)]);
sampling=false;await samplingDone;
let closeCode=null;try{await provider.close();}catch(error){closeCode=error.code??'CLOSE_FAILED';}
const after=await protectedSnapshot();
let runtimeExists=true;
const remaining=(await readdir(runtime).catch(error=>{if(error.code!=='ENOENT')throw error;runtimeExists=false;return [];})).filter(name=>name!=='sessions');
const overlapMs=runs.every(run=>run.modelStartedAt && run.modelFinishedAt)
  ? Math.min(...runs.map(run=>Date.parse(run.modelFinishedAt)))-Math.max(...runs.map(run=>Date.parse(run.modelStartedAt))):0;
const referenceFiles=await readdir(path.join(runtime,'sessions')).catch(()=>[]);
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceDigests=Object.fromEntries(await Promise.all(['src/adapters/native-codex-brain-provider.js','src/lib/codex-app-server-runner.js','src/lib/native-model-admission.js','src/lib/native-model-capacity.js','src/lib/windows-process-tree-wrapper.ps1'].map(async name=>[name,digest(await readFile(path.join(sourceRoot,name)))])));
const evidence={schemaVersion:1,validationId,at:new Date().toISOString(),platform:process.platform,node:process.version,model,transport:'app-server',
  nativeHomeDigest:digest(nativeHome),containedExecution:appServerRunner.supportsContainedExecution,
  runs,overlapMs,maxMarkerCount:Math.max(0,...markerSamples.map(sample=>sample.markers.length)),markerSamples,
  distinctThreads:runs.every(run=>typeof run.threadId==='string') && new Set(runs.map(run=>run.threadId)).size===2,distinctTurns:runs.every(run=>typeof run.turnId==='string') && new Set(runs.map(run=>run.turnId)).size===2,
  authUnchanged:before['auth.json']===after['auth.json'],configUnchanged:before['config.toml']===after['config.toml'],
  runtimeClean:runtimeExists && remaining.length===0,remainingRuntimeEntries:remaining,sessionReferenceCount:referenceFiles.length,closeCode,sourceDigests};
evidence.passed=evidence.containedExecution && runs.every(run=>run.status==='completed' && run.resultCorrect) && overlapMs>0 && evidence.maxMarkerCount===2 &&
  evidence.distinctThreads && evidence.distinctTurns && evidence.authUnchanged && evidence.configUnchanged && evidence.runtimeClean && referenceFiles.length===2 && closeCode===null;
const evidencePath=path.join(root,'evidence.json');await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({passed:evidence.passed,evidencePath,overlapMs,maxMarkerCount:evidence.maxMarkerCount,authUnchanged:evidence.authUnchanged,configUnchanged:evidence.configUnchanged,runtimeClean:evidence.runtimeClean})+'\n');
if(!evidence.passed)process.exitCode=1;
