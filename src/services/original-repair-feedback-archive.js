import { isDeepStrictEqual } from "node:util";
import {
  createOriginalRepairFeedbackArchiveRecord,
  normalizeOriginalRepairFeedbackArchiveRecord,
  normalizeOriginalRepairFeedbackArchiveReference,
  normalizeOriginalRepairFeedbackSnapshot,
  originalRepairFeedbackArchiveKey,
  originalRepairFeedbackArchiveReference,
} from "../domain/original-repair-feedback.js";

function invalid() {
  return Object.assign(new Error("原始修复反馈归档绑定无效"), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID" });
}

function unavailable() {
  return Object.assign(new Error("原始反馈快照不可用"), { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
}

export function planOriginalRepairFeedbackArchives(value) {
  const snapshots = (value.feedbackSnapshots ?? []).map(normalizeOriginalRepairFeedbackSnapshot);
  const references = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, originalRepairFeedbackArchiveReference(snapshot)]));
  if (references.size !== snapshots.length) throw invalid();
  for (const row of [...value.repairs, ...value.published]) {
    if (row.feedbackSnapshotArchive === undefined) continue;
    const reference = normalizeOriginalRepairFeedbackArchiveReference(row.feedbackSnapshotArchive);
    const existing = references.get(reference.snapshotId);
    if (existing && !isDeepStrictEqual(existing, reference)) throw invalid();
    references.set(reference.snapshotId, reference);
  }
  const archiveRow = (row) => {
    if (row.feedbackSnapshotId === undefined) return row;
    const inline = references.get(row.feedbackSnapshotId);
    const reference = row.feedbackSnapshotArchive === undefined ? inline : normalizeOriginalRepairFeedbackArchiveReference(row.feedbackSnapshotArchive);
    if (!reference || (inline && !isDeepStrictEqual(inline, reference))) throw invalid();
    return { ...row, feedbackSnapshotArchive: reference };
  };
  return {
    state: { ...value, schemaVersion: 2, feedbackSnapshots: [], repairs: value.repairs.map(archiveRow), published: value.published.map(archiveRow) },
    records: snapshots.map(createOriginalRepairFeedbackArchiveRecord),
  };
}

export async function persistOriginalRepairFeedbackArchives(store, records) {
  for (const record of records) {
    const key = originalRepairFeedbackArchiveKey(record.snapshotId);
    const existing = await store.read(key, null);
    if (existing === null) await store.write(key, record);
    const durable = normalizeOriginalRepairFeedbackArchiveRecord(await store.read(key, null), { storageKey: key });
    if (!isDeepStrictEqual(durable, record)) throw invalid();
  }
}

export async function validateOriginalRepairFeedbackArchives(store, state, previousState = null) {
  const known = new Map([...(previousState?.repairs ?? []), ...(previousState?.published ?? [])]
    .filter((row) => row.feedbackSnapshotArchive)
    .map((row) => [row.feedbackSnapshotId, row.feedbackSnapshotArchive]));
  const seen = new Set();
  for (const row of [...state.repairs, ...state.published]) {
    const reference = row.feedbackSnapshotArchive;
    if (!reference || seen.has(reference.snapshotId)) continue;
    seen.add(reference.snapshotId);
    if (isDeepStrictEqual(known.get(reference.snapshotId), reference)) continue;
    const key = originalRepairFeedbackArchiveKey(reference.snapshotId);
    normalizeOriginalRepairFeedbackArchiveRecord(await store.read(key, null), { storageKey: key, reference });
  }
}

export async function readOriginalRepairFeedbackSnapshot(store, state, query) {
  const matches = (entry) => entry.snapshotId === query.snapshotId && entry.repository === query.repository &&
    entry.number === query.number && entry.feedbackDigest === query.feedbackDigest && entry.originalHeadRefOid === query.originalHeadRefOid;
  const inline = state.feedbackSnapshots.find(matches);
  if (inline) return normalizeOriginalRepairFeedbackSnapshot(inline);
  const reference = [...state.repairs, ...state.published].find((row) => row.feedbackSnapshotArchive && matches(row.feedbackSnapshotArchive))?.feedbackSnapshotArchive;
  const key = originalRepairFeedbackArchiveKey(query.snapshotId);
  const raw = await store.read(key, null);
  if (raw === null) throw unavailable();
  const record = normalizeOriginalRepairFeedbackArchiveRecord(raw, { storageKey: key, reference });
  if (!matches(record.snapshot)) throw unavailable();
  return record.snapshot;
}
