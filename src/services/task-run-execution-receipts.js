export const TASK_RUN_RECEIPT_STATE_KEY = 'task-run-execution-receipts';
const MAX_RECORDS = 1_000;
const MAX_BYTES = 2 * 1024 * 1024;
const PHASES = new Set(['preparing','waiting_model','starting_model','running','completed','failed','paused','cancelled','unknown']);
const OPEN_PHASES = new Set(['preparing','waiting_model','starting_model','running']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/u;
const invalid = () => Object.assign(new Error('Execution receipt state is invalid'),{code:'TASK_RUN_RECEIPT_STATE_INVALID',statusCode:500});
const empty = () => ({schemaVersion:1,records:[]});
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const capacityExceeded = () => Object.assign(new Error('Execution receipt capacity is full'),{code:'TASK_RUN_RECEIPT_CAPACITY_EXCEEDED',statusCode:507});
const NATIVE_RPC_METHODS=new Set(['initialize','config/read','thread/start','thread/resume','mcpServerStatus/list','turn/start','turn/steer','turn/interrupt']);

export function normalizeNativeFailure(value) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).length!==3 ||
    !Object.hasOwn(value,'kind') || !['rpc_error','process_exit','process_error'].includes(value.kind) ||
    !Object.hasOwn(value,'method') || !Object.hasOwn(value,'code') ||
    !(NATIVE_RPC_METHODS.has(value.method) || value.kind!=='rpc_error' && value.method===null) ||
    (value.code!==null && !Number.isSafeInteger(value.code))) throw invalid();
  return {kind:value.kind,method:value.method,code:value.code};
}

function normalize(receipt) {
  const fields = ['runId','kind','taskId','roleId','taskRevision','leaseId','registeredAt','modelStartedAt','lastActivityAt','finishedAt','phase','stopConfirmed','session','eventCount','outcomeCode'];
  if (!receipt || Object.getPrototypeOf(receipt)!==Object.prototype || Object.keys(receipt).length!==fields.length+(Object.hasOwn(receipt,'nativeFailure')?1:0) || fields.some(field=>!Object.hasOwn(receipt,field))) throw invalid();
  if(Object.hasOwn(receipt,'nativeFailure'))normalizeNativeFailure(receipt.nativeFailure);
  if (!['work-item','code-job'].includes(receipt.kind) || !['runId','taskId','roleId'].every(field=>typeof receipt[field]==='string' && IDENTIFIER.test(receipt[field])) ||
    (receipt.leaseId!==null && (typeof receipt.leaseId!=='string' || !IDENTIFIER.test(receipt.leaseId))) || !PHASES.has(receipt.phase) || typeof receipt.stopConfirmed!=='boolean' ||
    !Number.isSafeInteger(receipt.taskRevision) || receipt.taskRevision<0 || !Number.isSafeInteger(receipt.eventCount) || receipt.eventCount<0 ||
    !validTime(receipt.registeredAt) || !validTime(receipt.lastActivityAt) ||
    ![receipt.modelStartedAt,receipt.finishedAt].every(value=>value===null || validTime(value)) ||
    (receipt.outcomeCode!==null && (typeof receipt.outcomeCode!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(receipt.outcomeCode)))) throw invalid();
  if (receipt.session!==null) {
    const session=receipt.session;
    if (!session || Object.getPrototypeOf(session)!==Object.prototype || Object.keys(session).length!==4 || session.transport!=='app-server' ||
      !['starting','running','completed','interrupted','failed'].includes(session.status) || typeof session.threadId!=='string' || !IDENTIFIER.test(session.threadId) ||
      (session.turnId!==null && (typeof session.turnId!=='string' || !IDENTIFIER.test(session.turnId)))) throw invalid();
  }
  return structuredClone(receipt);
}

function normalizeState(value) {
  if (!value || Object.keys(value).length!==2 || value.schemaVersion!==1 || !Array.isArray(value.records) || value.records.length>MAX_RECORDS ||
    Buffer.byteLength(JSON.stringify(value))>MAX_BYTES) throw invalid();
  const records=value.records.map(normalize);
  if(new Set(records.map(record=>record.runId)).size!==records.length)throw invalid();
  return {schemaVersion:1,records};
}

export function normalizeTaskRunExecutionReceiptPersistedState(value) {return normalizeState(value);}

/** Bounded metadata only. Conversation, progress text and task display text never enter this store. */
export class TaskRunExecutionReceipts {
  #pending=new Map();
  #startupRecovery=new Map();
  #version=0;
  #persistedThrough=0;
  #writing=null;
  #state=null;
  #loaded=false;
  #reread=false;

  constructor(store) { this.store=store; }

  async #load() {
    if(this.#state && !this.#reread)return;
    const state=normalizeState(await this.store.read(TASK_RUN_RECEIPT_STATE_KEY,empty()));
    if(!this.#loaded) {
      // Only receipts inherited at startup lose their execution owner. A later
      // acknowledgement reread must preserve this process's known active runs.
      for(const receipt of state.records) if(OPEN_PHASES.has(receipt.phase)) {
        this.#startupRecovery.set(receipt.runId,{...receipt,phase:'unknown',stopConfirmed:false});
      }
      this.#loaded=true;
    }
    this.#state=state;
    this.#reread=false;
  }

  record(value) {
    const receipt=normalize(value);
    // Backpressure retains all accepted updates during an outage. New distinct
    // runs fail closed instead of growing an unbounded in-memory backlog.
    if(!this.#pending.has(receipt.runId) && this.#pending.size>=MAX_RECORDS)return Promise.reject(capacityExceeded());
    this.#pending.set(receipt.runId,{receipt,version:++this.#version});
    return this.flush();
  }

  #writeBatch() {
    if(this.#writing)return this.#writing;
    this.#writing=(async()=>{
      await this.#load();
      const pending=new Map(this.#pending);
      const version=this.#version;
      if(!pending.size && !this.#startupRecovery.size)return;
      const next=new Map(this.#state.records.map(entry=>[entry.runId,entry]));
      for(const [runId,receipt] of this.#startupRecovery)next.set(runId,receipt);
      for(const [runId,{receipt}] of pending)next.set(runId,receipt);
      const records=[...next.values()];
      while(records.length>MAX_RECORDS) {
        const index=records.findIndex(entry=>!OPEN_PHASES.has(entry.phase) && entry.phase!=='unknown');
        if(index<0)throw capacityExceeded();
        records.splice(index,1);
      }
      const candidate=normalizeState({schemaVersion:1,records});
      await this.store.write(TASK_RUN_RECEIPT_STATE_KEY,candidate);
      this.#state=candidate;
      this.#startupRecovery.clear();
      for(const [runId,entry] of pending) {
        if(this.#pending.get(runId)?.version===entry.version)this.#pending.delete(runId);
      }
      this.#persistedThrough=version;
    })().catch(error=>{
      // A write may have reached storage before its acknowledgement failed.
      // The next explicit call rereads and merges, retaining newer local data.
      this.#reread=true;
      throw error;
    }).finally(()=>{this.#writing=null;});
    return this.#writing;
  }

  async flush() {
    const target=this.#version;
    if(this.#writing)await this.#writing;
    // Wait only for the caller's watermark. Continuing model events cannot
    // make a read chase the producer forever; a failed batch is never retried
    // within this call, only by a later record/flush/list invocation.
    while(!this.#state || this.#reread || this.#startupRecovery.size || this.#persistedThrough<target)await this.#writeBatch();
  }
  async list() { await this.flush(); return structuredClone(this.#state.records); }
}

export function executionReceiptView(receipt) {
  return {kind:receipt.kind,taskId:receipt.taskId,roleId:receipt.roleId,runId:receipt.runId,revision:0,
    title:receipt.taskId,subject:'',phase:receipt.phase,active:false,live:false,readOnly:true,
    priority:'normal',mode:'active',pendingCommand:null,instructions:[],appliedRevision:0,
    startedAt:receipt.modelStartedAt,queuedAt:receipt.registeredAt,lastActivityAt:receipt.lastActivityAt,
    progress:'',session:receipt.session,events:[],receipt:structuredClone(receipt)};
}
