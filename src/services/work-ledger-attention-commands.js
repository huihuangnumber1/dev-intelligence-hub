import {
  attentionDigest,
  normalizeAttentionAnswer,
} from "../domain/attention-contract.js";
import {
  normalizePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import {
  isWorkItemInLegacyPullRequestCutover,
  replaceWorkLedgerRecord,
  requireWorkLedgerItem,
} from "./work-ledger-item-commands.js";
import {
  currentWorkItemExecutionBinding,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  LEGACY_PR_SOURCE_QUARANTINE_KIND,
} from "./work-ledger-pr-source.js";
import {
  createAttentionResultAttestation,
} from "./work-ledger-result-attestation.js";
import { createWorkDecisionContext } from "./work-ledger-state.js";
import { moveWorkItem } from "./work-ledger-transitions.js";
import { isSettledIssueReason } from "./work-ledger-issue-lifecycle.js";
import { brainRecoveryCode } from "./brain-recovery-intent.js";
import { requiresBrainMaintenance } from "../domain/brain-failure-recovery.js";
import { hostContextRetirement } from "./work-ledger-host-context-recovery.js";
import { automaticTriageRetirement } from './work-ledger-triage-retirement.js';
import { ciMaterialRetirement } from "./work-ledger-ci-material-recovery.js";
import {
  boundedLedgerString,
  ledgerDigest,
  hasExactLedgerKeys,
  normalizeLedgerTimestamp,
  workLedgerError,
} from "./work-ledger-values.js";

const MAX_ATTENTION_BATCH = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^attention-[a-f0-9]{64}$/;
const RESULT_ID = /^attention-result-[a-f0-9]{64}$/;
const OUTBOX_ID = /^attention-outbox-[a-f0-9]{64}$/;

export function systemMaintenanceRetirement(outbox) {
  const proof = outbox?.outcome?.details?.maintenanceRetirement;
  if (!hasExactLedgerKeys(proof, ["schemaVersion", "intentId", "questionRef", "workItemRevision", "reason", "code", "inputBinding", "digest"]) ||
      proof.schemaVersion !== 1 || proof.intentId !== outbox.intentId ||
      proof.questionRef !== outbox.outcome.details.questionRef ||
      proof.reason !== "system_maintenance_auto_retry" ||
      proof.code !== brainRecoveryCode(outbox) || proof.code === null ||
      !Number.isSafeInteger(proof.workItemRevision) || proof.workItemRevision < 1 ||
      outbox.status !== "delivered" || outbox.outcome.status !== "delivered") return null;
  const { digest, ...core } = proof;
  if (ledgerDigest(core) !== digest) return null;
  if (outbox.sourceBinding === null) return proof.inputBinding === null ? proof : null;
  try {
    const binding = normalizePullRequestExecutionBinding(proof.inputBinding);
    if (["rootItemId", "workKey", "inputRevision", "headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"]
      .some(key => binding[key] !== outbox.sourceBinding[key])) return null;
  } catch { return null; }
  return proof;
}

export function planSystemMaintenanceRetry({ state, input, clock }) {
  if (!hasExactLedgerKeys(input, ["limit", "requestKeys"]) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      !Array.isArray(input.requestKeys) || input.requestKeys.length > 1_000 ||
      input.requestKeys.some(key => typeof key !== "string" || !/^work-intent-[a-f0-9]{64}$/.test(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "自动故障恢复批量参数无效");
  }
  if (state.attentionCursor < state.attentionHighWatermark) return { write: false, result: { retried: 0 } };
  const now = clock();
  const pendingRequests = new Set(input.requestKeys);
  const outboxById = new Map(state.outbox.map(outbox => [outbox.intentId, outbox]));
  const updatedItems = new Map();
  const updatedOutboxes = new Map();
  const timelineEvents = [];
  for (const item of state.items) {
    if (updatedItems.size >= input.limit) break;
    if (item.status !== "waiting_user" || !pendingRequests.has(item.activeIntentId) || item.sourceQuarantine !== null ||
        item.ownerId !== null || item.leaseId !== null || item.leaseUntil !== null) continue;
    const outbox = outboxById.get(item.activeIntentId);
    const code = brainRecoveryCode(outbox);
    if (code === null || requiresBrainMaintenance(code) || outbox.itemId !== item.itemId || outbox.status !== "delivered" ||
        outbox.outcome?.status !== "delivered" || outbox.outcome.details?.resultAttestation ||
        typeof outbox.outcome.details?.questionRef !== "string") continue;
    const inputBinding = attentionResultInputBinding(state, item, outbox);
    if (inputBinding === undefined) continue;
    const updated = moveWorkItem(item, { status: "retry_wait", now,
      reason: "system_maintenance_auto_retry", activeIntentId: null,
      availableAt: new Date(Date.parse(now) + 60_000).toISOString() });
    updated.attempt = Math.max(item.source?.decisionBudget?.attemptOffset ?? 0, item.attempt - 1);
    const core = { schemaVersion: 1, intentId: outbox.intentId,
      questionRef: outbox.outcome.details.questionRef, workItemRevision: updated.revision,
      reason: "system_maintenance_auto_retry", code, inputBinding };
    updatedItems.set(item.itemId, updated);
    updatedOutboxes.set(outbox.intentId, { ...outbox, revision: outbox.revision + 1, updatedAt: now,
      outcome: { ...outbox.outcome, details: { ...outbox.outcome.details,
        maintenanceRetirement: { ...core, digest: ledgerDigest(core) } } } });
    timelineEvents.push({ itemId: item.itemId, type: "intent_superseded", at: now,
      actorId: "work-ledger-system", details: { intentId: outbox.intentId,
        reason: core.reason, code, inputBinding, workItemRevision: updated.revision, inputDigest: outbox.inputDigest } });
    timelineEvents.push({ itemId: item.itemId, type: "retry_scheduled", at: now,
      actorId: "work-ledger-system", details: { fromStatus: item.status,
        availableAt: updated.availableAt, reason: core.reason, code, restoredAttempts: item.attempt - updated.attempt } });
  }
  if (updatedItems.size === 0) return { write: false, result: { retried: 0 } };
  return { patch: { items: state.items.map(item => updatedItems.get(item.itemId) ?? item),
    outbox: state.outbox.map(outbox => updatedOutboxes.get(outbox.intentId) ?? outbox) },
    timelineEvents, result: { retried: updatedItems.size } };
}

function invalid(message = "内部请示结果批次无效") {
  return workLedgerError("WORK_LEDGER_ATTENTION_BATCH_INVALID", message, 502);
}

function exactDataMap(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid();
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid();
    }
    result.set(key, descriptor.value);
  }
  if (
    result.size !== keys.length ||
    keys.some((key) => !result.has(key))
  ) {
    throw invalid();
  }
  return result;
}

function dataArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ATTENTION_BATCH ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function positiveSequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw invalid(`${name} 无效`);
  }
}

function normalizeResult(value) {
  const fields = exactDataMap(value, [
    "resultId",
    "contentDigest",
    "requestId",
    "requestContentDigest",
    "producerBindingDigest",
    "kind",
    "answer",
    "requestRevision",
    "revision",
    "at",
  ]);
  let answer;
  try {
    answer = normalizeAttentionAnswer(fields.get("answer"));
  } catch {
    throw invalid("内部请示答案无效");
  }
  const kind = fields.get("kind");
  if (
    !new Set(["answered", "rejected"]).has(kind) ||
    (kind === "rejected") !== (answer.type === "reject") ||
    answer.type === "later"
  ) {
    throw invalid("内部请示结果类型无效");
  }
  const core = {
    requestId: boundedLedgerString(fields.get("requestId"), "requestId", 74),
    requestContentDigest: digest(
      fields.get("requestContentDigest"),
      "requestContentDigest",
    ),
    producerBindingDigest: digest(
      fields.get("producerBindingDigest"),
      "producerBindingDigest",
    ),
    kind,
    answer,
    requestRevision: positiveSequence(
      fields.get("requestRevision"),
      "requestRevision",
    ),
    revision: positiveSequence(fields.get("revision"), "result.revision"),
    at: timestamp(fields.get("at"), "result.at"),
  };
  const contentDigest = attentionDigest(core);
  if (
    !REQUEST_ID.test(core.requestId) ||
    core.requestId !== `attention-${core.requestContentDigest}` ||
    fields.get("contentDigest") !== contentDigest ||
    fields.get("resultId") !== `attention-result-${contentDigest}` ||
    !RESULT_ID.test(fields.get("resultId")) ||
    core.requestRevision >= core.revision
  ) {
    throw invalid("内部请示结果摘要或版本无效");
  }
  return {
    resultId: fields.get("resultId"),
    contentDigest,
    ...core,
  };
}

function normalizeEntry(value) {
  const fields = exactDataMap(value, [
    "outboxId",
    "contentDigest",
    "sequence",
    "requestId",
    "requestContentDigest",
    "producer",
    "producerBindingDigest",
    "requestKey",
    "result",
  ]);
  const producerFields = exactDataMap(fields.get("producer"), [
    "roleId",
    "workItemId",
  ]);
  const producer = {
    roleId: boundedLedgerString(producerFields.get("roleId"), "roleId", 128),
    workItemId: boundedLedgerString(
      producerFields.get("workItemId"),
      "workItemId",
      256,
    ),
  };
  const result = normalizeResult(fields.get("result"));
  const core = {
    sequence: positiveSequence(fields.get("sequence"), "sequence"),
    requestId: boundedLedgerString(fields.get("requestId"), "requestId", 74),
    requestContentDigest: digest(
      fields.get("requestContentDigest"),
      "requestContentDigest",
    ),
    producer,
    producerBindingDigest: digest(
      fields.get("producerBindingDigest"),
      "producerBindingDigest",
    ),
    requestKey: boundedLedgerString(fields.get("requestKey"), "requestKey", 128),
    result,
  };
  const producerBindingDigest = attentionDigest({
    requestKey: core.requestKey,
    producer,
  });
  const contentDigest = attentionDigest(core);
  if (
    !REQUEST_ID.test(core.requestId) ||
    core.requestId !== `attention-${core.requestContentDigest}` ||
    core.requestId !== result.requestId ||
    core.requestContentDigest !== result.requestContentDigest ||
    core.producerBindingDigest !== producerBindingDigest ||
    core.producerBindingDigest !== result.producerBindingDigest ||
    fields.get("contentDigest") !== contentDigest ||
    fields.get("outboxId") !== `attention-outbox-${contentDigest}` ||
    !OUTBOX_ID.test(fields.get("outboxId"))
  ) {
    throw invalid("内部请示 outbox 摘要绑定无效");
  }
  return { outboxId: fields.get("outboxId"), contentDigest, ...core };
}

function normalizeBatch(input, state) {
  let fields;
  let items;
  try {
    fields = exactDataMap(input, [
      "items",
      "nextSequence",
      "highWatermark",
      "oldestAvailableSequence",
    ]);
    items = dataArray(fields.get("items")).map(normalizeEntry);
  } catch (error) {
    if (error?.code === "WORK_LEDGER_ATTENTION_BATCH_INVALID") throw error;
    throw invalid();
  }
  const nextSequence = fields.get("nextSequence");
  const highWatermark = fields.get("highWatermark");
  const oldest = fields.get("oldestAvailableSequence");
  if (
    !Number.isSafeInteger(nextSequence) ||
    nextSequence < 0 ||
    !Number.isSafeInteger(highWatermark) ||
    highWatermark < 0 ||
    nextSequence > highWatermark ||
    !(oldest === null || (Number.isSafeInteger(oldest) && oldest >= 1)) ||
    items.some(
      (item, index) =>
        item.sequence > highWatermark ||
        (index > 0 && item.sequence !== items[index - 1].sequence + 1),
    ) ||
    (items.length > 0 && items.at(-1).sequence !== nextSequence) ||
    (items.length === 0 && nextSequence !== state.attentionCursor)
  ) {
    throw invalid("内部请示 outbox 游标契约无效");
  }
  if (highWatermark < state.attentionHighWatermark) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_SOURCE_ROLLBACK",
      "内部请示结果源高水位发生回退",
      409,
    );
  }
  if (
    highWatermark > state.attentionCursor &&
    (oldest === null || oldest > state.attentionCursor + 1)
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_GAP",
      "内部请示结果流存在无法安全跨越的缺口",
      409,
    );
  }
  const pending = items.filter(({ sequence }) => sequence > state.attentionCursor);
  if (
    pending.length > 0 &&
    pending[0].sequence !== state.attentionCursor + 1
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_GAP",
      "内部请示结果序号不连续",
      409,
    );
  }
  return { items, pending, nextSequence, highWatermark, oldest };
}

export function attentionResultInputBinding(state, item, outbox) {
  if (outbox.inputDigest === item.inputDigest) {
    return currentWorkItemExecutionBinding(item);
  }
  const sourceBinding = outbox.sourceBinding;
  if (
    item.status !== "waiting_user" ||
    item.source?.kind !== "pull_request" ||
    sourceBinding?.rootItemId !== item.itemId ||
    item.source.current.headRefOid !== sourceBinding.headRefOid ||
    (item.source.scope.active !== true &&
      item.statusReason !== "pr_source_left_scope_pending_settlement")
  ) {
    return undefined;
  }
  const revision = item.source.revisions[sourceBinding.inputRevision - 1];
  if (
    revision?.disposition !== "accepted" ||
    ["headRevision", "headRefOid", "eventId", "eventDigest", "inputDigest"]
      .some((field) => revision[field] !== sourceBinding[field])
  ) {
    return undefined;
  }
  const staged = state.timeline.findLast(
    (event) => event.type === "intent_staged" &&
      event.itemId === item.itemId &&
      event.details.intentId === outbox.intentId,
  );
  const candidate = staged?.details.inputBinding ??
    outbox.dispatchBinding?.boundIntent?.binding?.inputBinding;
  if (candidate === undefined || candidate === null) return undefined;
  let historical;
  try {
    historical = normalizePullRequestExecutionBinding(candidate);
  } catch {
    return undefined;
  }
  if (
    historical.repository !== item.source.identity.repository ||
    historical.pullRequestNumber !== item.source.identity.pullRequestNumber ||
    historical.rootItemId !== sourceBinding.rootItemId ||
    historical.workKey !== sourceBinding.workKey ||
    historical.inputRevision !== sourceBinding.inputRevision ||
    historical.headRevision !== sourceBinding.headRevision ||
    ["headRefOid", "eventId", "eventDigest", "inputDigest"]
      .some((field) => historical[field] !== sourceBinding[field])
  ) {
    return undefined;
  }
  const current = currentWorkItemExecutionBinding(item);
  if (
    current?.schemaVersion !== historical.schemaVersion ||
    (historical.schemaVersion === 2 &&
      !samePullRequestGitTarget(historical.gitTarget, current.gitTarget))
  ) {
    return undefined;
  }
  return historical;
}

function requireBoundAskUser(state, entry) {
  const item = requireWorkLedgerItem(state, entry.producer.workItemId);
  const outbox = state.outbox.find(
    (candidate) => candidate.intentId === entry.requestKey,
  );
  const outcome = outbox?.outcome;
  const maintenanceRetirement = automaticTriageRetirement(outbox) ?? systemMaintenanceRetirement(outbox) ?? hostContextRetirement(outbox) ?? ciMaterialRetirement(outbox);
  const waitingForResult =
    item.status === "waiting_user" && item.activeIntentId === outbox?.intentId;
  const durablyQuarantined =
    item.sourceQuarantine?.kind === LEGACY_PR_SOURCE_QUARANTINE_KIND;
  const quarantinedSettlement =
    durablyQuarantined &&
    item.status === "blocked" &&
    item.activeIntentId === null;
  const closedIssueSettlement =
    item.status === "cancelled" &&
    item.activeIntentId === null &&
    isSettledIssueReason(item.statusReason);
  const sealedQuarantinedSettlement =
    !durablyQuarantined ||
    (outbox?.dispatchBinding !== null &&
      outbox?.dispatchBinding !== undefined &&
      Object.hasOwn(outbox.dispatchBinding, "boundIntent"));
  const inputBinding = maintenanceRetirement !== null ? maintenanceRetirement.inputBinding : outbox === undefined
    ? undefined
    : attentionResultInputBinding(state, item, outbox);
  if (
    !outbox ||
    outbox.itemId !== item.itemId ||
    inputBinding === undefined ||
    outbox.status !== "delivered" ||
    outbox.intent.type !== "ask_user" ||
    outbox.requestedBy.roleId !== entry.producer.roleId ||
    (!waitingForResult && !quarantinedSettlement && !closedIssueSettlement && maintenanceRetirement === null) ||
    outcome?.status !== "delivered" ||
    outcome.details?.questionRef !== entry.requestId
  ) {
    throw workLedgerError(
      "WORK_LEDGER_ATTENTION_BINDING_CONFLICT",
      "内部请示结果没有绑定当前等待中的 ask_user 意图",
      409,
    );
  }
  return {
    item,
    outbox,
    inputBinding,
    discardClosedIssueResult: closedIssueSettlement,
    maintenanceRetirement,
    discardUnsealedLegacyResult:
      durablyQuarantined && !sealedQuarantinedSettlement,
  };
}

export function planAttentionBatchApplication({ state, input, clock }) {
  const batch = normalizeBatch(input, state);
  if (batch.nextSequence <= state.attentionCursor) {
    return {
      write: false,
      result: {
        applied: 0,
        deduplicated: batch.items.length,
        cursor: state.attentionCursor,
        highWatermark: state.attentionHighWatermark,
        itemIds: [],
      },
    };
  }
  const now = clock();
  let items = state.items;
  let outboxEntries = state.outbox;
  const timelineEvents = [];
  const appliedItemIds = [];
  for (const entry of batch.pending) {
    const workingState = { ...state, items, outbox: outboxEntries };
    const {
      item,
      outbox,
      inputBinding,
      discardClosedIssueResult,
      maintenanceRetirement,
      discardUnsealedLegacyResult,
    } =
      requireBoundAskUser(workingState, entry);
    if (Date.parse(entry.result.at) > Date.parse(now)) {
      throw invalid("内部请示结果时间晚于台账时钟");
    }
    if (discardUnsealedLegacyResult) {
      const itemResult = moveWorkItem(item, {
        status: "blocked",
        now,
        reason: LEGACY_PR_SOURCE_CUTOVER_REASON,
        activeIntentId: null,
      });
      items = replaceWorkLedgerRecord(items, "itemId", itemResult);
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "legacy_result_discarded",
        at: now,
        actorId: "attention-result-reconciler",
        details: {
          source: "attention",
          intentId: outbox.intentId,
          resultRef: entry.result.resultId,
          reason: "unsealed_pr_source_quarantine",
        },
      });
      continue;
    }
    if (discardClosedIssueResult || maintenanceRetirement !== null) {
      appliedItemIds.push(item.itemId);
      timelineEvents.push({
        itemId: item.itemId,
        type: "stale_result_discarded",
        at: now,
        actorId: "attention-result-reconciler",
        details: {
          source: "attention",
          intentId: outbox.intentId,
          resultRef: entry.result.resultId,
          reason: maintenanceRetirement?.reason ?? item.statusReason,
        },
      });
      continue;
    }
    const decisionContext = createWorkDecisionContext({
      source: "attention",
      referenceId: entry.requestId,
      outcome: entry.result.kind,
      value: {
        answer: entry.result.answer,
        requestContentDigest: entry.requestContentDigest,
        resultId: entry.result.resultId,
        resultDigest: entry.result.contentDigest,
      },
      observedAt: entry.result.at,
    });
    const resultAttestation = createAttentionResultAttestation({
      entry,
      intentId: outbox.intentId,
      decisionContentDigest: decisionContext.contentDigest,
    });
    const outboxResult = {
      ...outbox,
      revision: outbox.revision + 1,
      outcome: {
        ...outbox.outcome,
        details: {
          ...outbox.outcome.details,
          resultAttestation,
        },
      },
      updatedAt: now,
    };
    outboxEntries = replaceWorkLedgerRecord(
      outboxEntries,
      "intentId",
      outboxResult,
    );
    const rejected = entry.result.kind === "rejected";
    const sealedByLegacyCutover = isWorkItemInLegacyPullRequestCutover(item);
    const leftPullRequestScope = item.source?.kind === "pull_request" &&
      item.source.scope.active === false;
    const itemResult = moveWorkItem(item, {
      status: sealedByLegacyCutover || leftPullRequestScope
        ? "blocked"
        : rejected
          ? "blocked"
          : "queued",
      now,
      reason: sealedByLegacyCutover
        ? LEGACY_PR_SOURCE_CUTOVER_REASON
        : leftPullRequestScope
          ? "pr_source_left_scope"
        : rejected
          ? "attention_rejected"
          : "attention_answered",
      activeIntentId: null,
      decisionContext,
    });
    const maintenanceCode = brainRecoveryCode(outbox);
    if (itemResult.status === "queued" && requiresBrainMaintenance(maintenanceCode) &&
        entry.result.answer.type === "choice" && entry.result.answer.choiceId === "configured-retry") {
      // The owner repaired infrastructure; this was not a business decision failure.
      // Never erase attempts made before the current Head's sealed budget offset.
      itemResult.attempt = Math.max(item.source?.decisionBudget?.attemptOffset ?? 0, item.attempt - 1);
    }
    items = replaceWorkLedgerRecord(items, "itemId", itemResult);
    appliedItemIds.push(item.itemId);
    timelineEvents.push({
      itemId: item.itemId,
      type: rejected
        ? "attention_rejection_applied"
        : "attention_answer_applied",
      at: now,
      actorId: "attention-result-reconciler",
      details: {
        inputBinding,
        workItemRevision: itemResult.revision,
        inputDigest: outbox.inputDigest,
        intentId: entry.requestKey,
        resultAttestationDigest: resultAttestation.attestationDigest,
        questionRef: entry.requestId,
        resultRef: entry.result.resultId,
        outcome: entry.result.kind,
        answer: entry.result.answer,
        requestContentDigest: entry.requestContentDigest,
        resultDigest: entry.result.contentDigest,
      },
    });
  }
  return {
    patch: {
      items,
      outbox: outboxEntries,
      attentionCursor: batch.nextSequence,
      attentionHighWatermark: batch.highWatermark,
    },
    timelineEvents,
    result: {
      applied: batch.pending.length,
      deduplicated: batch.items.length - batch.pending.length,
      cursor: batch.nextSequence,
      highWatermark: batch.highWatermark,
      itemIds: appliedItemIds,
    },
  };
}
