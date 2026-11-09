import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {NativeCodexBrainProvider} from '../src/adapters/native-codex-brain-provider.js';
import {ConfiguredRoleEmployee} from '../src/services/configured-role-employee.js';
import {RoleWorkerDirectory} from '../src/services/role-worker-directory.js';
import {TaskRunRegistry} from '../src/services/task-run-registry.js';
import {StateStore} from '../src/lib/state-store.js';
import {createTestConfiguredBrainRouter} from '../src/services/configured-workforce.js';
import {githubEntitySessionKey} from '../src/lib/session-key.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};

test('automatic employee queues without claiming and rechecks role pause after admission', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dih-automatic-admission-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const home = path.join(root, 'home'); await mkdir(home);
  const provider = new NativeCodexBrainProvider({id:'native', cliKind:'codex-cli', credentialMode:'codex-native-login', queueTimeoutMs:1000}, {
    environment:{CODEX_HOME:home}, temporaryRoot:path.join(root,'runtime'),
    rootDirectoryManager:{async prepare(){assert.fail('waiting must not prepare a model');}},
    processRunner:{async run(){assert.fail('waiting must not launch a model');}},
  });
  const router = createTestConfiguredBrainRouter({brainProviders:{native:{kind:'codex-cli',credentialMode:'codex-native-login'}}},
    {supervisedCliProviderFactory:()=>provider});
  const employee = new ConfiguredRoleEmployee({definition:{id:'analyst',name:'Analyst',mission:'Inspect work',enabled:true,scheduleMinutes:5},
    permissions:{allowedIntents:['complete']}, brain:{provider:'native',model:'test-model',remoteData:{requirements:true,code:false,memory:false}},
    waitForModelCapacity:true, brainRouter:router, store:new StateStore(path.join(root,'state'))});
  const directory = new RoleWorkerDirectory({workers:[employee.asRoleWorker()],legacyOwnedRoleIds:[]});
  const worker = await directory.resolve({type:'role',id:'analyst'});
  const release = deferred();
  const occupied = provider.withAdmission({entityKey:'occupied'}, () => release.promise);
  let claims = 0, outcome = null;
  const input = {item:{itemId:'work-43',event:{eventType:'issue.updated',subject:{repository:'owner/repo',number:43}}}};
  const queued = worker.withDecisionAdmission(input, () => { claims += 1; }).then(value => outcome={value}, error => outcome={error});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, null, 'automatic admission must keep its queue position');
    assert.equal(claims, 0);
    await employee.control('pause', 0);
    release.resolve(); await occupied; await queued;
    assert.equal(outcome.error.code, 'ROLE_PAUSED');
    assert.equal(claims, 0, 'a queued role must be rechecked before claiming');
  } finally { release.resolve(); await occupied; await queued; await provider.close(); }
});

test('configured employee, directory, engine, router and native home share admission through receipt settlement',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'dih-model-admission-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home');await mkdir(home);
  let launches=0;
  const provider=new NativeCodexBrainProvider({id:'native',cliKind:'codex-cli',credentialMode:'codex-native-login',timeoutMs:5000},{
    environment:{CODEX_HOME:home,DIH_CODEX_NATIVE_TRANSPORT:'exec'},temporaryRoot:path.join(root,'runtime'),
    rootDirectoryManager:{async prepare({directory,validateLocation}){await validateLocation();await mkdir(directory,{recursive:true});}},
    commandLocator:{async resolve(){return {command:process.execPath,prefixArgs:[]};}},
    processRunner:{async run(call){launches++;call.duplex.onOutput({stream:'stdout',chunk:Buffer.from('{"type":"turn.started"}\n')});await writeFile(path.join(call.cwd,'last-message.json'),JSON.stringify({result:'{"ok":true}'}));return {exitCode:0,signal:null,stdoutBytes:Buffer.from('{"type":"thread.started","thread_id":"native-thread-42"}\n')};}},
  });
  const brain={provider:'native',model:'test-model',remoteData:{requirements:true,code:false,memory:false}};
  const store=new StateStore(path.join(root,'state'));
  const router=createTestConfiguredBrainRouter({brainProviders:{native:{kind:'codex-cli',credentialMode:'codex-native-login'}}},{supervisedCliProviderFactory:()=>provider});
  const employee=new ConfiguredRoleEmployee({definition:{id:'analyst',name:'Analyst',mission:'Inspect work',enabled:true,scheduleMinutes:5},permissions:{allowedIntents:['complete']},brain,brainRouter:router,store});
  const directory=new RoleWorkerDirectory({workers:[employee.asRoleWorker()],legacyOwnedRoleIds:[]});
  const worker=await directory.resolve({type:'role',id:'analyst'});
  const input={item:{itemId:'work-42',event:{eventType:'issue.updated',subject:{repository:'owner/repo',number:42}}}};
  const registry=new TaskRunRegistry({store,receiptStore:store,settleControl:async()=>{}});
  const entered=deferred(),finish=deferred();
  const active=worker.withDecisionAdmission(input,async()=>{
    entered.resolve();await finish.promise;
    return registry.run({kind:'work-item',taskId:'work-42',roleId:'analyst',title:'Private title',subject:'owner/repo#42',revision:1},()=>router.generate({
      brain,messages:[{role:'user',content:'PRIVATE_CONVERSATION_BODY'}],schema:{type:'object'},dataClasses:['requirements'],sessionKey:githubEntitySessionKey({kind:'issue',repository:'owner/repo',number:42}),
    }));
  });
  await entered.promise;
  await assert.rejects(worker.withDecisionAdmission({...input,item:{...input.item,itemId:'work-43'}},()=>assert.fail('capacity was not acquired')), {code:'STRUCTURED_PROVIDER_BUSY'});
  assert.equal(launches,0);
  finish.resolve();assert.equal(JSON.parse(await active).ok,true);
  const recovered=await new TaskRunRegistry({store:new StateStore(path.join(root,'state')),receiptStore:new StateStore(path.join(root,'state')),settleControl:async()=>{}}).get('work-item','work-42');
  assert.equal(recovered.phase,'completed');assert.equal(recovered.receipt.modelStartedAt!==null,true);
  const saved=await readFile(path.join(root,'state','task-run-execution-receipts.json'),'utf8');
  assert.equal(saved.includes('PRIVATE_CONVERSATION_BODY'),false);assert.equal(saved.includes('Private title'),false);
  assert.deepEqual(await readdir(`${path.join(root,'runtime')}-native`),['sessions']);
  await assert.rejects(worker.withDecisionAdmission(input,()=>{throw new Error('callback failed');}),/callback failed/);
  await worker.withDecisionAdmission(input,async()=>{});
  await provider.close();
});
