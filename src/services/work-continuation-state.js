import { createHash } from 'node:crypto';
import { hasExactLedgerKeys } from './work-ledger-values.js';

export const WORK_CONTINUATION_STATE_KEY = 'work-continuations';
export const CONTINUATION_MAX_RECORDS = 1_000;
export const CONTINUATION_ROLES = new Set(['developer', 'tester', 'pr-engineer', 'orchestrator', 'requirements-analyst']);
const STATUSES = new Set(['pending', 'waiting', 'running', 'delivered', 'retry_wait', 'stalled', 'superseded']);
const REASONS = new Set(['work_ready', 'waiting_condition', 'role_woken', 'runtime_deferred', 'wake_failed', 'no_progress', 'input_changed', 'restart_recovery', 'execution_timeout']);
const LEGACY_KEYS = ['attempt', 'fingerprint', 'itemId', 'nextAttemptAt', 'reason', 'roleId', 'status', 'updatedAt'];
const KEYS = [...LEGACY_KEYS, 'source', 'condition', 'receipts', 'recovery'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/;
const SHA = /^[a-f0-9]{64}$/;
const identifier = value => typeof value === 'string' && ID.test(value);
const optionalId = value => value === null || identifier(value);
const revision = value => value === null || (Number.isSafeInteger(value) && value > 0);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const optionalTime = value => value === null || timestamp(value);
const invalid = () => new TypeError('Invalid work continuation state');

export const emptyWorkContinuations = () => ({ schemaVersion: 2, records: [] });
export const continuationFingerprint = item => createHash('sha256')
  .update(JSON.stringify([item.itemId, item.revision, item.currentTarget?.id])).digest('hex');

export function normalizeContinuationTarget(value) {
  if (value === null || value === undefined) return null;
  if (!hasExactLedgerKeys(value, ['itemId', 'fingerprint']) || !identifier(value.itemId) ||
      typeof value.fingerprint !== 'string' || !SHA.test(value.fingerprint)) throw invalid();
  return Object.freeze({ itemId: value.itemId, fingerprint: value.fingerprint });
}

export function matchesContinuationTarget(item, target) {
  return item.itemId === target.itemId && continuationFingerprint(item) === target.fingerprint;
}

function validDetails(record) {
  const { source, condition, receipts, recovery } = record;
  if (!hasExactLedgerKeys(source, ['rootItemId', 'parentItemId', 'inputRevision', 'itemRevision']) ||
      !optionalId(source.rootItemId) || !optionalId(source.parentItemId) || !revision(source.inputRevision) || !revision(source.itemRevision) ||
      !hasExactLedgerKeys(condition, ['type', 'reference']) || !optionalId(condition.reference) ||
      !['claimable', 'child_delivery', 'intent_result', 'fact_change', 'retry_due', 'manual_resume'].includes(condition.type) ||
      !hasExactLedgerKeys(recovery, ['action', 'reason', 'dueAt']) || !REASONS.has(recovery.reason) || !optionalTime(recovery.dueAt) ||
      !['none', 'retry', 'await_condition', 'watch_execution', 'wait_for_stop'].includes(recovery.action) ||
      !Array.isArray(receipts) || receipts.length > 5) return false;
  const ids = new Set();
  return receipts.every(receipt => {
    if (!hasExactLedgerKeys(receipt, ['wakeId', 'roleId', 'fingerprint', 'startedAt', 'deadlineAt', 'finishedAt', 'outcome', 'observedRevision', 'errorCode']) ||
        !identifier(receipt.wakeId) || !CONTINUATION_ROLES.has(receipt.roleId) || ids.has(receipt.wakeId) || typeof receipt.fingerprint !== 'string' || !SHA.test(receipt.fingerprint) ||
        !timestamp(receipt.startedAt) || !timestamp(receipt.deadlineAt) || Date.parse(receipt.deadlineAt) < Date.parse(receipt.startedAt) ||
        !optionalTime(receipt.finishedAt) || !revision(receipt.observedRevision) ||
        !['running', 'progressed', 'no_progress', 'deferred', 'superseded', 'failed', 'timed_out', 'interrupted'].includes(receipt.outcome) ||
        (receipt.outcome === 'running') !== (receipt.finishedAt === null) ||
        !(receipt.errorCode === null || (typeof receipt.errorCode === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(receipt.errorCode)))) return false;
    ids.add(receipt.wakeId);
    return true;
  });
}

export function normalizeWorkContinuationState(value) {
  if (!hasExactLedgerKeys(value, ['schemaVersion', 'records']) || ![1, 2].includes(value.schemaVersion) ||
      !Array.isArray(value.records) || value.records.length > CONTINUATION_MAX_RECORDS) throw invalid();
  const ids = new Set();
  for (const record of value.records) {
    if (!hasExactLedgerKeys(record, value.schemaVersion === 1 ? LEGACY_KEYS : KEYS) ||
        !identifier(record.itemId) || ids.has(record.itemId) || !CONTINUATION_ROLES.has(record.roleId) || !STATUSES.has(record.status) ||
        (value.schemaVersion === 1 && record.status === 'waiting') || typeof record.fingerprint !== 'string' || !SHA.test(record.fingerprint) ||
        !Number.isSafeInteger(record.attempt) || record.attempt < 0 || record.attempt > 3 ||
        !timestamp(record.updatedAt) || !optionalTime(record.nextAttemptAt) || !REASONS.has(record.reason) ||
        (value.schemaVersion === 2 && !validDetails(record))) throw invalid();
    ids.add(record.itemId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 8_000_000) throw invalid();
  return structuredClone(value);
}

export function migrateWorkContinuationState(value) {
  const state = normalizeWorkContinuationState(value);
  if (state.schemaVersion === 2) return state;
  return normalizeWorkContinuationState({ schemaVersion: 2, records: state.records.map(record => ({ ...record,
    source: { rootItemId: null, parentItemId: null, inputRevision: null, itemRevision: null },
    condition: { type: 'claimable', reference: null }, receipts: [],
    recovery: { action: record.status === 'retry_wait' || record.status === 'stalled' ? 'retry' : 'none', reason: record.reason, dueAt: record.nextAttemptAt },
  })) });
}
