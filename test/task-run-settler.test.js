import assert from 'node:assert/strict';
import test from 'node:test';
import { planWorkItemRunControl,createTaskRunSettler,canUseNativeStopEvidence } from '../src/services/work-ledger-run-control.js';

const now = '2026-10-13T08:00:00.000Z';
const item = { itemId:'work-1', revision:3, status:'working', ownerId:'worker-1', leaseId:'lease-1', leaseUntil:'2026-10-13T09:00:00.000Z', activeIntentId:null, attempt:1, currentTarget:{type:'role',id:'developer'} };
const command = { itemId:'work-1', expectedRevision:3, leaseId:'lease-1', command:'pause' };

test('native readiness cannot certify a different configured CLI process has stopped',()=>{
  const native={kind:'codex-cli',credentialMode:'codex-native-login'};
  assert.equal(canUseNativeStopEvidence({native}),true);
  assert.equal(canUseNativeStopEvidence({native,local:{kind:'ollama'}}),true);
  assert.equal(canUseNativeStopEvidence({native,legacy:{kind:'codex-cli',credentialMode:'codex-login'}}),false);
  assert.equal(canUseNativeStopEvidence({native,claude:{kind:'claude-cli'}}),false);
  assert.equal(canUseNativeStopEvidence({local:{kind:'ollama'}}),false);
});
test('only the exact active model claim can be paused, and resume uses the fresh revision', () => {
  const paused = planWorkItemRunControl({state:{items:[item]}, input:command, clock:()=>now});
  assert.equal(paused.result.status,'paused');
  assert.equal(paused.result.leaseId,null);
  assert.throws(()=>planWorkItemRunControl({state:{items:[item]},input:{...command,leaseId:'other'},clock:()=>now}));
  assert.throws(()=>planWorkItemRunControl({state:{items:[{...item,activeIntentId:'intent-1'}]},input:command,clock:()=>now}));
  const expired=planWorkItemRunControl({state:{items:[{...item,leaseUntil:'2026-10-13T07:59:00.000Z'}]},input:command,clock:()=>now});
  assert.equal(expired.result.status,'paused','an owner stop can settle its exact expired claim without granting worker execution');
  const resumed = planWorkItemRunControl({state:{items:[paused.result]},input:{itemId:'work-1',expectedRevision:4,leaseId:null,command:'resume'},clock:()=>now});
  assert.equal(resumed.result.status,'queued');
});

test('a completed code job wins a late pause or cancel without creating a permanent hold',async()=>{
  const settle=createTaskRunSettler({codeJobReader:{get:async()=>({jobId:'job-1',revision:4,status:'completed'})},
    codeJobControl:{pause:async()=>assert.fail('cannot pause completed job'),cancel:async()=>assert.fail('cannot cancel completed job')}});
  for(const command of ['pause','cancel'])assert.deepEqual(await settle({task:{kind:'code-job',taskId:'job-1'},command}),{terminalStatus:'completed'});
});
