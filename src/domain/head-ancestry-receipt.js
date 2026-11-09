import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizeStoredWorkflowEvent, normalizeWorkflowEvent } from "./workflow-events.js";

const FIELDS = ["schemaVersion", "nonce", "rootItemId", "rootRevision", "sourceWorkKey", "sourceInputRevision",
  "sourceInputDigest", "authorityEpoch", "ancestorHeadRefOid", "event", "recordedAt"];
const invalid = () => Object.assign(new Error("Host Head ancestry receipt is invalid"), { code: "HEAD_ANCESTRY_RECEIPT_INVALID" });

export function createHeadAncestryReceipt(content) {
  const recordDigest = canonicalJsonDigest(content);
  return normalizeHeadAncestryReceipt({ ...content, recordDigest, receiptId: `head-ancestry-${recordDigest}` });
}

export function normalizeHeadAncestryReceipt(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== FIELDS.length + 2 || FIELDS.some(key => !Object.hasOwn(value, key))) throw invalid();
  const content = Object.fromEntries(FIELDS.map(key => [key, value[key]]));
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(value.nonce) ||
      !/^work-item-[a-f0-9]{64}$/.test(value.rootItemId) || !/^pr-work-[a-f0-9]{64}$/.test(value.sourceWorkKey) ||
      ![value.rootRevision, value.sourceInputRevision, value.authorityEpoch].every(v => Number.isSafeInteger(v) && v > 0) ||
      !/^[a-f0-9]{64}$/.test(value.sourceInputDigest) || !/^[a-f0-9]{40,64}$/.test(value.ancestorHeadRefOid) ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt ||
      canonicalJsonDigest(content) !== value.recordDigest || value.receiptId !== `head-ancestry-${value.recordDigest}`) throw invalid();
  const event = normalizeStoredWorkflowEvent(value.event);
  if (event.eventType !== "pull_request.updated" || event.source.provider !== "github" ||
      Object.hasOwn(event.payload, "headAncestryProof") || Object.hasOwn(event.payload, "previousHeadRefOid") ||
      event.payload.headRefOid === value.ancestorHeadRefOid) throw invalid();
  return structuredClone(value);
}

export function headAncestryEvent(receipt) {
  const proof = normalizeHeadAncestryReceipt(receipt), event = proof.event;
  return normalizeWorkflowEvent({ schemaVersion: 1, eventType: event.eventType, occurredAt: event.occurredAt,
    source: event.source, subject: event.subject, payload: { ...event.payload, headAncestryProof: proof.receiptId } });
}

export function matchesHeadAncestryEvent(receipt, event) {
  try { return headAncestryEvent(receipt).contentDigest === event.contentDigest; } catch { return false; }
}

export function headAncestryReentryEvent(receipt) {
  const proof = normalizeHeadAncestryReceipt(receipt), event = proof.event;
  const { changedFields: _changes, ...payload } = event.payload;
  return normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.created", occurredAt: event.occurredAt,
    source: event.source, subject: event.subject, payload });
}

export function headAncestrySourceMatches(receipt, source, event) {
  return receipt !== undefined && receipt.sourceWorkKey === source.workKey &&
    receipt.sourceInputRevision === source.inputRevision && receipt.sourceInputDigest === source.current.inputDigest &&
    receipt.authorityEpoch === source.authorityEpoch && receipt.ancestorHeadRefOid === source.current.headRefOid &&
    matchesHeadAncestryEvent(receipt, event);
}
