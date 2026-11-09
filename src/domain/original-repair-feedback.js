import { createHash } from "node:crypto";
import { ownReviewFeedbackDigest } from "../adapters/github-own-review-feedback.js";
import { normalizeCiRepairEvidence } from './ci-repair-evidence.js';
import { canonicalJsonDigest } from '../lib/canonical-json-digest.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^repair-feedback-snapshot-[a-f0-9]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;
export const ORIGINAL_REPAIR_FEEDBACK_ARCHIVE_PREFIX = "original-repair-feedback-record-";
function invalid() { return Object.assign(new Error("原始修复反馈快照缺失或绑定不匹配"), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" }); }
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
function freeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function createOriginalRepairFeedbackSnapshot({ repository, number, context, provenance }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 ||
      !exact(context, ["schemaVersion", "headRefOid", "reviewFeedbackDigest", "feedback"]) || context.schemaVersion !== 1 ||
      typeof context.headRefOid !== "string" || !OID.test(context.headRefOid) || typeof context.reviewFeedbackDigest !== "string" || !DIGEST.test(context.reviewFeedbackDigest) ||
      !Array.isArray(context.feedback?.changeRequests) || !Array.isArray(context.feedback?.threads) ||
      context.feedback.changeRequests.length + context.feedback.threads.length < 1 ||
      context.feedback.changeRequests.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.author !== "string" || typeof entry.body !== "string") ||
      context.feedback.threads.some((entry) => !entry || typeof entry.id !== "string" || !Array.isArray(entry.comments) || entry.comments.length < 1 ||
        entry.comments.some((comment) => !comment || typeof comment.id !== "string" || typeof comment.author !== "string" || typeof comment.body !== "string")) ||
      ownReviewFeedbackDigest(context.feedback) !== context.reviewFeedbackDigest ||
      !exact(provenance, ["kind", "observedHeadRefOid", "observedAt"]) ||
      !["captured_before_repair", "github_digest_matched_feedback"].includes(provenance.kind) || typeof provenance.observedHeadRefOid !== "string" || !OID.test(provenance.observedHeadRefOid) ||
      typeof provenance.observedAt !== "string" || !Number.isFinite(Date.parse(provenance.observedAt)) ||
      new Date(provenance.observedAt).toISOString() !== provenance.observedAt ||
      (provenance.kind === "captured_before_repair" && provenance.observedHeadRefOid !== context.headRefOid)) throw invalid();
  const feedback = structuredClone({ changeRequests: context.feedback.changeRequests,
    threads: context.feedback.threads.map(({ id, comments }) => ({ id, comments })) });
  const contextualObservations = context.feedback.threads.map(({ id, path, line, discussion }) => ({ id,
    ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }), ...(discussion === undefined ? {} : { discussion: structuredClone(discussion) }) }));
  const content = { schemaVersion: 1, repository, number, originalHeadRefOid: context.headRefOid,
    feedbackDigest: context.reviewFeedbackDigest, feedback, contextualObservations, provenance: structuredClone(provenance) };
  const serialized = JSON.stringify(content);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw invalid();
  return freeze({ snapshotId: `repair-feedback-snapshot-${createHash("sha256").update(serialized).digest("hex")}`, ...content });
}

export function normalizeOriginalRepairFeedbackSnapshot(value) {
  if (Object.getOwnPropertyDescriptor(value ?? {}, 'ciEvidence')) {
    if (!exact(value, ['snapshotId', 'schemaVersion', 'repository', 'number', 'originalHeadRefOid', 'feedbackDigest', 'ciEvidence', 'provenance']) || value.schemaVersion !== 1) throw invalid();
    const snapshot = createOriginalCiRepairFeedbackSnapshot({ repository: value.repository, number: value.number,
      ciEvidence: value.ciEvidence, provenance: value.provenance });
    if (snapshot.snapshotId !== value.snapshotId || snapshot.originalHeadRefOid !== value.originalHeadRefOid || snapshot.feedbackDigest !== value.feedbackDigest) throw invalid();
    return snapshot;
  }
  if (!exact(value, ["snapshotId", "schemaVersion", "repository", "number", "originalHeadRefOid", "feedbackDigest", "feedback", "contextualObservations", "provenance"]) ||
      value.schemaVersion !== 1 || !exact(value.feedback, ["changeRequests", "threads"]) || !Array.isArray(value.contextualObservations) || typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId)) throw invalid();
  const observations = new Map(value.contextualObservations.map((entry) => [entry.id, entry]));
  if (observations.size !== value.feedback?.threads?.length) throw invalid();
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: value.repository, number: value.number,
    context: { schemaVersion: 1, headRefOid: value.originalHeadRefOid, reviewFeedbackDigest: value.feedbackDigest,
      feedback: { changeRequests: value.feedback.changeRequests, threads: value.feedback.threads.map((entry) => ({ ...observations.get(entry.id), ...entry })) } },
    provenance: value.provenance });
  if (snapshot.snapshotId !== value.snapshotId) throw invalid();
  return snapshot;
}

export function createOriginalCiRepairFeedbackSnapshot({ repository, number, ciEvidence: value, provenance }) {
  const ciEvidence = normalizeCiRepairEvidence(value);
  if (repository !== ciEvidence.repository || number !== ciEvidence.number ||
      !exact(provenance, ['kind', 'observedHeadRefOid', 'observedAt']) || provenance.kind !== 'captured_before_ci_repair' ||
      provenance.observedHeadRefOid !== ciEvidence.headRefOid || typeof provenance.observedAt !== 'string' || !Number.isFinite(Date.parse(provenance.observedAt))) throw invalid();
  const content = { schemaVersion: 1, repository, number, originalHeadRefOid: ciEvidence.headRefOid,
    feedbackDigest: ciEvidence.contentDigest, ciEvidence, provenance: structuredClone(provenance) };
  return freeze({ snapshotId: `repair-feedback-snapshot-${canonicalJsonDigest(content)}`, ...content });
}

export function normalizeRepairFeedbackDescriptor(value) {
  if (!exact(value, ["snapshotId", "feedbackDigest", "originalHeadRefOid", "reviewHeadRefOid"]) ||
      typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId) ||
      typeof value.feedbackDigest !== "string" || !DIGEST.test(value.feedbackDigest) ||
      typeof value.originalHeadRefOid !== "string" || !OID.test(value.originalHeadRefOid) ||
      typeof value.reviewHeadRefOid !== "string" || !OID.test(value.reviewHeadRefOid)) throw invalid();
  return Object.freeze({ ...value });
}

export function originalRepairFeedbackArchiveKey(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) throw invalid();
  return `${ORIGINAL_REPAIR_FEEDBACK_ARCHIVE_PREFIX}${snapshotId.slice("repair-feedback-snapshot-".length)}`;
}

export function normalizeOriginalRepairFeedbackArchiveReference(value) {
  if (!exact(value, ["snapshotId", "bodyHash", "repository", "number", "originalHeadRefOid", "feedbackDigest"]) ||
      typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId) ||
      typeof value.bodyHash !== "string" || !DIGEST.test(value.bodyHash) ||
      typeof value.repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
      !Number.isSafeInteger(value.number) || value.number < 1 ||
      typeof value.originalHeadRefOid !== "string" || !OID.test(value.originalHeadRefOid) ||
      typeof value.feedbackDigest !== "string" || !DIGEST.test(value.feedbackDigest)) throw invalid();
  return Object.freeze({ ...value });
}

function archiveReferenceForSnapshot(snapshot, bodyHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")) {
  return normalizeOriginalRepairFeedbackArchiveReference({ snapshotId: snapshot.snapshotId,
    bodyHash,
    repository: snapshot.repository, number: snapshot.number, originalHeadRefOid: snapshot.originalHeadRefOid,
    feedbackDigest: snapshot.feedbackDigest });
}

export function originalRepairFeedbackArchiveReference(value) {
  return archiveReferenceForSnapshot(normalizeOriginalRepairFeedbackSnapshot(value));
}

export function createOriginalRepairFeedbackArchiveRecord(value) {
  const snapshot = normalizeOriginalRepairFeedbackSnapshot(value);
  const reference = archiveReferenceForSnapshot(snapshot);
  return freeze({ schemaVersion: 1, snapshotId: reference.snapshotId, bodyHash: reference.bodyHash, snapshot });
}

export function normalizeOriginalRepairFeedbackArchiveRecord(value, { storageKey, reference } = {}) {
  if (!exact(value, ["schemaVersion", "snapshotId", "bodyHash", "snapshot"]) || value.schemaVersion !== 1) throw invalid();
  const record = createOriginalRepairFeedbackArchiveRecord(value.snapshot);
  if (record.snapshotId !== value.snapshotId || record.bodyHash !== value.bodyHash ||
      (storageKey !== undefined && storageKey !== originalRepairFeedbackArchiveKey(record.snapshotId))) throw invalid();
  if (reference !== undefined) {
    const expected = normalizeOriginalRepairFeedbackArchiveReference(reference);
    const actual = archiveReferenceForSnapshot(record.snapshot, record.bodyHash);
    if (Object.keys(actual).some((key) => actual[key] !== expected[key])) throw invalid();
  }
  return record;
}

export function originalRepairFeedbackForRow(state, row) {
  return row.feedbackSnapshotArchive ?? state.feedbackSnapshots.find((entry) => entry.snapshotId === row.feedbackSnapshotId);
}

export function originalRepairFeedbackBinding(state, inputBinding, metadata) {
  const rows = state.published.filter((entry) => entry.repository === inputBinding.repository && entry.number === inputBinding.pullRequestNumber &&
    entry.commitOid === inputBinding.headRefOid && entry.commitOid === metadata.headRefOid && entry.feedbackDigest === metadata.feedbackDigest &&
    entry.confirmationId === metadata.publicationConfirmationId &&
    entry.reviewDelivery?.request?.internalReview?.controlledCommitEvidenceId === metadata.controlledCommitEvidenceId);
  const snapshot = rows.length === 1 && originalRepairFeedbackForRow(state, rows[0]);
  if (!snapshot || snapshot.repository !== inputBinding.repository || snapshot.number !== inputBinding.pullRequestNumber ||
      snapshot.feedbackDigest !== metadata.feedbackDigest) throw Object.assign(new Error("原始修复反馈不可用"), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
  return normalizeRepairFeedbackDescriptor({ snapshotId: snapshot.snapshotId, feedbackDigest: snapshot.feedbackDigest,
    originalHeadRefOid: snapshot.originalHeadRefOid, reviewHeadRefOid: inputBinding.headRefOid });
}
