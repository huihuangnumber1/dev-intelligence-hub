import { assertItemRevision, assertWorkLease, moveWorkItem } from './work-ledger-transitions.js';
import { assertWorkItemNotInLegacyPullRequestCutover, replaceWorkLedgerRecord, requireWorkLedgerItem } from './work-ledger-item-commands.js';
import { hasExactLedgerKeys, workLedgerError } from './work-ledger-values.js';

export function canUseNativeStopEvidence(brainProviders = {}) {
  const cliProviders=Object.values(brainProviders).filter(provider=>['codex-cli','claude-cli'].includes(provider.kind));
  return cliProviders.length > 0 && cliProviders.every(provider=>provider.kind === 'codex-cli' && provider.credentialMode === 'codex-native-login');
}

export function planWorkItemRunControl({state, input, clock}) {
  if (!hasExactLedgerKeys(input, ['itemId','expectedRevision','leaseId','command']) ||
      !['pause','resume'].includes(input.command)) throw workLedgerError('WORK_LEDGER_RUN_CONTROL_INVALID','任务控制请求无效');
  const item = requireWorkLedgerItem(state, input.itemId);
  assertWorkItemNotInLegacyPullRequestCutover(item);
  assertItemRevision(item, input.expectedRevision);
  const now = clock();
  if (input.command === 'pause' && item.status === 'working') {
    // An owner may stop its exact old claim after maintenance outlasts the
    // worker lease. This grants no execution and cannot stop a newer claim.
    if (typeof input.leaseId !== 'string' || input.leaseId !== item.leaseId) {
      throw workLedgerError('WORK_LEDGER_LEASE_CONFLICT','工作项租约已变化',409);
    }
  } else assertWorkLease(item, input.leaseId, now);
  if (item.activeIntentId !== null ||
      (input.command === 'pause' && !['working','queued','retry_wait'].includes(item.status)) ||
      (input.command === 'resume' && (item.status !== 'paused' || item.statusReason !== 'owner_task_run_pause'))) {
    throw workLedgerError('WORK_LEDGER_RUN_CONTROL_CONFLICT','任务已有派发动作或状态已变化，不能修改运行状态',409);
  }
  const status = input.command === 'pause' ? 'paused' : 'queued';
  const updated = moveWorkItem(item, {status,now,reason: input.command === 'pause' ? 'owner_task_run_pause' : 'owner_task_run_resume'});
  if (input.command === 'pause' && item.status === 'working') updated.attempt = Math.max(0,item.attempt-1);
  return {patch:{items:replaceWorkLedgerRecord(state.items,'itemId',updated)}, result:updated,
    timelineEvents:[{itemId:item.itemId,type:'transitioned',at:now,actorId:'owner-task-control',details:{fromStatus:item.status,toStatus:status,reason:updated.statusReason,context:{}}}]};
}

export function createTaskRunSettler({ledger, codeJobReader, codeJobControl}) {
  return async ({task,command}) => {
    if (task.kind === 'code-job') {
      const job = await codeJobReader.get(task.taskId);
      if (!job) throw workLedgerError('TASK_RUN_NOT_FOUND','代码任务不存在',404);
      if (['completed','failed','fenced','cancelled'].includes(job.status)) return {terminalStatus:job.status};
      if (command === 'resume' && ['queued','active','starting'].includes(job.status)) return;
      const result = await codeJobControl[command]({jobId:job.jobId,expectedRevision:job.revision,
        ...(command === 'resume' ? {} : {reason:'owner-task-run-control'})});
      const confirmed = command === 'pause' ? result.job.status === 'paused' :
        command === 'cancel' ? result.job.status === 'cancelled' : ['queued','starting','active'].includes(result.job.status);
      return confirmed ? undefined : {pending:true};
    }
    let item = await ledger.readItemForReconciliation({itemId:task.taskId});
    if (!item) throw workLedgerError('TASK_RUN_NOT_FOUND','工作项不存在',404);
    if (command === 'resume' && item.status === 'queued') return;
    if (command === 'cancel' && item.status === 'cancelled') return;
    if (command !== 'resume' && item.status !== 'paused') {
      if (item.revision !== task.revision || (item.leaseId ?? null) !== (task.leaseId ?? null)) {
        throw workLedgerError('TASK_RUN_CONFLICT','原任务已变化，控制没有应用到新的执行',409);
      }
      item = await ledger.controlModelRun({itemId:item.itemId,expectedRevision:item.revision,leaseId:item.leaseId,command:'pause'});
    }
    if (command === 'resume') {
      await ledger.controlModelRun({itemId:item.itemId,expectedRevision:item.revision,leaseId:null,command:'resume'});
    } else if (command === 'cancel') {
      const summary = await ledger.getSummary();
      await ledger.cancelGraphTask({itemId:item.itemId,expectedRevision:item.revision,expectedGraphRevision:summary.revision,
        actorId:'owner-task-control',reason:'owner_task_run_cancel'});
    }
  };
}
