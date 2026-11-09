import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {OpenAICompatibleProvider} from '../src/adapters/openai-compatible-provider.js';
import {OllamaStructuredProvider} from '../src/adapters/ollama-structured-provider.js';
import {TaskRunRegistry} from '../src/services/task-run-registry.js';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
const request={model:'fixture-model',messages:[{role:'user',content:'synthetic request'}],schema:{type:'object'},admissionEntityKey:'github:pull_request:owner/repo#42'};
const task={kind:'work-item',taskId:'task-1',roleId:'analyst',title:'Synthetic task',subject:'fixture',revision:1};
const memoryStore=()=>{const records=new Map();return {async read(key,fallback){return structuredClone(records.get(key)??fallback);},async write(key,value){records.set(key,structuredClone(value));}};};

for(const kind of ['openai-compatible','ollama'])test(`${kind} reports running after its actual HTTP request starts`,async t=>{
  const entered=gate(),finish=gate();let body;
  const server=http.createServer(async(req,res)=>{
    let bytes='';for await(const chunk of req)bytes+=chunk;
    body=JSON.parse(bytes);entered.resolve();await finish.promise;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(kind==='ollama'?{message:{content:'{"ok":true}'}}:{choices:[{message:{content:'{"ok":true}'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{finish.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const provider=kind==='ollama'?new OllamaStructuredProvider({baseUrl}):new OpenAICompatibleProvider({baseUrl,apiKeyEnv:'FIXTURE_KEY',environment:{FIXTURE_KEY:'synthetic-key'}});
  const store=memoryStore(),registry=new TaskRunRegistry({store,receiptStore:store,settleControl:async()=>{}});
  const operation=registry.run(task,()=>provider.generate(request));await entered.promise;
  try{
    const current=await registry.get(task.kind,task.taskId);
    assert.equal(current.phase,'running');assert.notEqual(current.receipt.modelStartedAt,null);
    assert.deepEqual((await registry.list()).counts,{active:1,queued:0,preparing:0});
    assert.equal(body.model,'fixture-model');
    assert.equal(Object.hasOwn(body,'admissionEntityKey'),false,'scheduling metadata must stay outside the model payload');
  }finally{finish.resolve();await operation;}
  assert.equal((await registry.get(task.kind,task.taskId)).phase,'completed');
});
