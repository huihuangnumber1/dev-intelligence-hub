import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import { normalizeBackupManifest } from "../domain/backup-manifest.js";
import { originalRepairFeedbackArchiveKey } from "../domain/original-repair-feedback.js";
import { StateStore } from "../lib/state-store.js";
import {
  allPersistedSchemaOwners,
  assertCompletePersistedSchemaOwnerCatalog,
} from "./persisted-schema-owner-catalog.js";

const SAFE_STORE_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const ABSENT = Object.freeze({ absent: true });
const ERROR_CODES = Object.freeze({
  invalid: "RESTORE_SCHEMA_OWNER_INVALID",
  future: "RESTORE_SCHEMA_OWNER_FUTURE",
  collision: "RESTORE_SCHEMA_OWNER_COLLISION",
  unsafeKey: "RESTORE_SCHEMA_OWNER_UNSAFE_KEY",
  archive: "RESTORE_SCHEMA_ARCHIVE_INVALID",
});

class RestoreSchemaMigrationError extends Error {
  constructor(code, ownerId, cause) {
    super(`${ownerId} restore schema operation failed`, { cause });
    this.name = "RestoreSchemaMigrationError";
    this.code = code;
    this.ownerId = ownerId;
  }
}

function failure(code, ownerId, cause) {
  if (
    cause?.code === "RESTORE_AUTHORITY_ADOPTION_BLOCKED" ||
    cause?.code === "RESTORE_SCHEMA_OWNER_COVERAGE_INCOMPLETE" ||
    cause instanceof RestoreSchemaMigrationError
  ) {
    return cause;
  }
  return new RestoreSchemaMigrationError(code, ownerId, cause);
}

function dataEntries(value, expected, ownerId = "restore-registry") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(ERROR_CODES.invalid, ownerId);
  }
  const entries = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw failure(ERROR_CODES.invalid, ownerId);
    }
    entries.set(key, descriptor.value);
  }
  if (
    entries.size !== expected.length ||
    expected.some((key) => !entries.has(key))
  ) {
    throw failure(ERROR_CODES.invalid, ownerId);
  }
  return entries;
}

function comparable(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function verifiedCandidateRoot(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw failure(ERROR_CODES.unsafeKey, "restore-registry");
  }
  const resolved = path.resolve(directory);
  try {
    const [actual, info] = await Promise.all([
      realpath(resolved),
      lstat(resolved),
    ]);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      comparable(actual) !== comparable(resolved)
    ) {
      throw failure(ERROR_CODES.unsafeKey, "restore-registry");
    }
  } catch (cause) {
    throw failure(ERROR_CODES.unsafeKey, "restore-registry", cause);
  }
  return resolved;
}

function declaredSchemaVersion(value, descriptor) {
  let entries;
  try {
    entries = dataEntries(
      value,
      Reflect.ownKeys(value).filter((key) => typeof key === "string"),
      descriptor.ownerId,
    );
  } catch (cause) {
    throw failure(ERROR_CODES.invalid, descriptor.ownerId, cause);
  }
  const schemaVersion = entries.get("schemaVersion");
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw failure(ERROR_CODES.invalid, descriptor.ownerId);
  }
  if (schemaVersion > descriptor.currentVersion) {
    throw failure(ERROR_CODES.future, descriptor.ownerId);
  }
  if (!descriptor.supportedVersions.includes(schemaVersion)) {
    throw failure(ERROR_CODES.invalid, descriptor.ownerId);
  }
  return schemaVersion;
}

async function invokeOwner(
  descriptor,
  operation,
  value,
  context,
  { revalidate = true } = {},
) {
  declaredSchemaVersion(value, descriptor);
  try {
    const result = await descriptor[operation](
      structuredClone(value),
      context,
    );
    if (!revalidate) return result;
    declaredSchemaVersion(result, descriptor);
    return await descriptor.normalize(structuredClone(result), context);
  } catch (cause) {
    throw failure(ERROR_CODES.invalid, descriptor.ownerId, cause);
  }
}

function familyMatcher(descriptor) {
  const { prefix, suffix, memberPattern } = descriptor.keyFamily;
  return new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
      `(?:${memberPattern})` +
      `${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "u",
  );
}

async function rootJsonEntries(root, catalog) {
  const entries = await readdir(root, { withFileTypes: true });
  const jsonByKey = new Map();
  const lowerKeys = new Map();
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    const key = entry.name.slice(0, -5);
    const lower = key.toLowerCase();
    if (lowerKeys.has(lower)) {
      throw failure(ERROR_CODES.collision, "restore-registry");
    }
    lowerKeys.set(lower, key);
    jsonByKey.set(key, entry);
  }
  for (const descriptor of catalog) {
    if (descriptor.key === undefined) continue;
    const actual = lowerKeys.get(descriptor.key.toLowerCase());
    if (actual !== undefined && actual !== descriptor.key) {
      throw failure(ERROR_CODES.collision, descriptor.ownerId);
    }
    if (actual !== undefined && !jsonByKey.get(actual).isFile()) {
      throw failure(ERROR_CODES.unsafeKey, descriptor.ownerId);
    }
  }
  return { jsonByKey, lowerKeys };
}

function discoverStrictFamily(descriptor, jsonByKey) {
  const { prefix } = descriptor.keyFamily;
  const matcher = familyMatcher(descriptor);
  const keys = [];
  for (const [key, entry] of jsonByKey) {
    if (!key.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (!key.startsWith(prefix) || !matcher.test(key) || !entry.isFile()) {
      throw failure(ERROR_CODES.unsafeKey, descriptor.ownerId);
    }
    keys.push(key);
  }
  return keys.sort((left, right) => left.localeCompare(right, "en"));
}

async function readPresent(store, jsonByKey, key, ownerId) {
  if (!jsonByKey.has(key)) return ABSENT;
  try {
    const value = await store.read(key, ABSENT);
    if (value === ABSENT) {
      throw failure(ERROR_CODES.invalid, ownerId);
    }
    return value;
  } catch (cause) {
    throw failure(ERROR_CODES.invalid, ownerId, cause);
  }
}

function archiveExpectedKeys(codeJobState) {
  const records = new Map();
  const indexes = new Map();
  for (const manifest of codeJobState.archiveIndex) {
    const recordKey = `code-job-tombstone-record-${manifest.jobId}`;
    records.set(recordKey, manifest);
    for (const digest of Object.values(manifest.bindings)) {
      const indexKey = `code-job-tombstone-index-${digest}`;
      if (indexes.has(indexKey)) {
        throw failure(ERROR_CODES.archive, "code-job-archive-index");
      }
      indexes.set(indexKey, manifest);
    }
  }
  return { records, indexes };
}

function sameKeySet(actual, expected) {
  return actual.length === expected.size &&
    actual.every((key) => expected.has(key));
}

async function validateArchives({
  descriptors,
  discoveredRecordKeys,
  discoveredIndexKeys,
  codeJobState,
  store,
  jsonByKey,
}) {
  if (codeJobState === null) {
    if (discoveredRecordKeys.length || discoveredIndexKeys.length) {
      throw failure(ERROR_CODES.archive, "code-job-archive-record");
    }
    return;
  }
  const expected = archiveExpectedKeys(codeJobState);
  if (
    !sameKeySet(discoveredRecordKeys, expected.records) ||
    !sameKeySet(discoveredIndexKeys, expected.indexes)
  ) {
    throw failure(ERROR_CODES.archive, "code-job-archive-record");
  }
  const tombstones = new Map();
  for (const key of discoveredRecordKeys) {
    const raw = await readPresent(
      store,
      jsonByKey,
      key,
      descriptors.record.ownerId,
    );
    declaredSchemaVersion(raw, descriptors.record);
    try {
      const result = descriptors.record.verifyImmutable(
        structuredClone(raw),
        { storageKey: key, manifest: expected.records.get(key) },
      );
      tombstones.set(expected.records.get(key).jobId, result.tombstone);
    } catch (cause) {
      throw failure(ERROR_CODES.archive, descriptors.record.ownerId, cause);
    }
  }
  for (const key of discoveredIndexKeys) {
    const manifest = expected.indexes.get(key);
    const raw = await readPresent(
      store,
      jsonByKey,
      key,
      descriptors.index.ownerId,
    );
    declaredSchemaVersion(raw, descriptors.index);
    try {
      descriptors.index.verifyImmutable(structuredClone(raw), {
        storageKey: key,
        tombstone: tombstones.get(manifest.jobId),
      });
    } catch (cause) {
      throw failure(ERROR_CODES.archive, descriptors.index.ownerId, cause);
    }
  }
}

function emptyJournalState(value) {
  const projection = value.lifecycleAuthority.authorityProjection;
  return value.revision === 0 &&
    value.records.length === 0 &&
    projection.revision === 0 &&
    projection.entries.length === 0;
}

async function validateRepairFeedbackArchives({ descriptor, state, store, jsonByKey }) {
  const references = new Map();
  for (const row of [...(state?.repairs ?? []), ...(state?.published ?? [])]) {
    if (row.feedbackSnapshotArchive) references.set(originalRepairFeedbackArchiveKey(row.feedbackSnapshotId), row.feedbackSnapshotArchive);
  }
  const keys = discoverStrictFamily(descriptor, jsonByKey);
  for (const key of references.keys()) {
    if (!jsonByKey.has(key)) throw failure(ERROR_CODES.archive, descriptor.ownerId);
  }
  // Archive-before-state crashes leave valid unreferenced records. Preserve and
  // validate those too; corrupt or future records cannot enter a restored store.
  for (const key of keys) {
    const raw = await readPresent(store, jsonByKey, key, descriptor.ownerId);
    declaredSchemaVersion(raw, descriptor);
    try {
      descriptor.verifyImmutable(structuredClone(raw), { storageKey: key, reference: references.get(key) });
    } catch (cause) {
      throw failure(ERROR_CODES.archive, descriptor.ownerId, cause);
    }
  }
}

async function migrateCandidate({ root, catalog, jsonByKey }) {
  const byId = new Map(catalog.map((descriptor) => [descriptor.ownerId, descriptor]));
  const store = new StateStore(root);
  const rawById = new Map();
  for (const descriptor of catalog) {
    if (descriptor.key === undefined) continue;
    rawById.set(
      descriptor.ownerId,
      await readPresent(store, jsonByKey, descriptor.key, descriptor.ownerId),
    );
  }
  const candidateById = new Map();
  const writes = new Map();
  const ownerOrder = new Map(
    catalog.map(({ ownerId }, index) => [ownerId, index]),
  );
  const scheduleWrite = (descriptor, value) => {
    const existing = writes.get(descriptor.key);
    if (existing !== undefined && existing.ownerId !== descriptor.ownerId) {
      throw failure(ERROR_CODES.collision, descriptor.ownerId);
    }
    writes.set(descriptor.key, {
      ownerId: descriptor.ownerId,
      key: descriptor.key,
      value,
    });
  };
  const migrateFixed = async (ownerId) => {
    const descriptor = byId.get(ownerId);
    const raw = rawById.get(ownerId);
    if (raw === ABSENT) return null;
    const candidate = await invokeOwner(
      descriptor,
      "migrate",
      raw,
      undefined,
    );
    candidateById.set(ownerId, candidate);
    if (!isDeepStrictEqual(candidate, raw)) scheduleWrite(descriptor, candidate);
    return candidate;
  };
  const validateFixed = async (ownerId) => {
    const descriptor = byId.get(ownerId);
    const raw = rawById.get(ownerId);
    if (raw === ABSENT) return null;
    const candidate = await invokeOwner(
      descriptor,
      "normalize",
      raw,
      undefined,
      { revalidate: false },
    );
    candidateById.set(ownerId, candidate);
    return candidate;
  };

  const configuration = await migrateFixed("configuration-state");
  await migrateFixed("workflow-routing-state");
  const workLedger = await migrateFixed("work-ledger-state");
  const codeJobs = await migrateFixed("code-job-state");
  await migrateFixed("code-executor-state");
  const confirmation = await validateFixed("confirmation-queue");
  await migrateFixed("work-continuations");
  for (const ownerId of [
    "task-run-execution-receipts",
    "automatic-own-pr-repair-state",
    "work-proposal-state",
    "attention-inbox",
    "owner-work-requests",
    "agent-memory-queries",
    "pr-engineer-read-facts",
    "change-package-applications",
    "change-package-controlled-commits",
    "change-package-application-projections",
  ]) {
    await validateFixed(ownerId);
  }

  const recordDescriptor = byId.get("code-job-archive-record");
  const indexDescriptor = byId.get("code-job-archive-index");
  await validateArchives({
    descriptors: { record: recordDescriptor, index: indexDescriptor },
    discoveredRecordKeys: discoverStrictFamily(recordDescriptor, jsonByKey),
    discoveredIndexKeys: discoverStrictFamily(indexDescriptor, jsonByKey),
    codeJobState: codeJobs,
    store,
    jsonByKey,
  });
  await validateRepairFeedbackArchives({
    descriptor: byId.get("original-repair-feedback-archive"),
    state: candidateById.get("automatic-own-pr-repair-state"),
    store,
    jsonByKey,
  });

  const journalDescriptor = byId.get("unified-memory-journal");
  const legacyDescriptor = byId.get("legacy-authority-projection");
  const rawJournal = rawById.get(journalDescriptor.ownerId);
  const rawLegacy = rawById.get(legacyDescriptor.ownerId);
  if (rawLegacy !== ABSENT) {
    await invokeOwner(
      legacyDescriptor,
      "normalize",
      rawLegacy,
      undefined,
      { revalidate: false },
    );
  }
  let journal = null;
  if (rawLegacy !== ABSENT) {
    try {
      journal = await legacyDescriptor.plan({
        journal: rawJournal === ABSENT ? null : structuredClone(rawJournal),
        legacyProjection: structuredClone(rawLegacy),
        workLedger: workLedger === null ? null : structuredClone(workLedger),
        confirmationState:
          confirmation === null ? null : structuredClone(confirmation),
      });
      journal = await journalDescriptor.normalize(structuredClone(journal));
    } catch (cause) {
      throw failure(ERROR_CODES.invalid, legacyDescriptor.ownerId, cause);
    }
  } else if (rawJournal !== ABSENT) {
    journal = await invokeOwner(
      journalDescriptor,
      "migrate",
      rawJournal,
      undefined,
    );
  }
  if (
    journal !== null &&
    (
      rawJournal !== ABSENT ||
      !emptyJournalState(journal)
    ) &&
    (rawJournal === ABSENT || !isDeepStrictEqual(journal, rawJournal))
  ) {
    scheduleWrite(journalDescriptor, journal);
  }
  if (journal !== null) candidateById.set(journalDescriptor.ownerId, journal);

  const memoryIndexDescriptor = byId.get("unified-memory-index");
  const rawMemoryIndex = rawById.get(memoryIndexDescriptor.ownerId);
  if (rawMemoryIndex !== ABSENT) {
    declaredSchemaVersion(rawMemoryIndex, memoryIndexDescriptor);
  }
  if (journal === null) {
    if (rawMemoryIndex !== ABSENT) {
      throw failure(ERROR_CODES.invalid, memoryIndexDescriptor.ownerId);
    }
  } else {
    let expectedIndex;
    try {
      expectedIndex = memoryIndexDescriptor.derive({ journal });
      memoryIndexDescriptor.normalize(structuredClone(expectedIndex), { journal });
    } catch (cause) {
      throw failure(ERROR_CODES.invalid, memoryIndexDescriptor.ownerId, cause);
    }
    if (
      rawMemoryIndex === ABSENT ||
      !isDeepStrictEqual(rawMemoryIndex, expectedIndex)
    ) {
      scheduleWrite(memoryIndexDescriptor, expectedIndex);
    }
  }

  const roleDescriptor = byId.get("configured-role-lifecycle");
  let roleKeys = [];
  if (configuration !== null) {
    try {
      roleKeys = roleDescriptor.derive({ configurationState: configuration });
    } catch (cause) {
      throw failure(ERROR_CODES.invalid, roleDescriptor.ownerId, cause);
    }
  }
  const fixedKeys = new Set(
    catalog.flatMap((descriptor) =>
      descriptor.key === undefined ? [] : [descriptor.key.toLowerCase()]
    ),
  );
  const seenRoleKeys = new Set();
  for (const key of roleKeys) {
    const lower = key.toLowerCase();
    if (
      typeof key !== "string" ||
      !SAFE_STORE_KEY.test(key) ||
      seenRoleKeys.has(lower) ||
      fixedKeys.has(lower)
    ) {
      throw failure(ERROR_CODES.collision, roleDescriptor.ownerId);
    }
    seenRoleKeys.add(lower);
    const actual = [...jsonByKey.keys()].find(
      (candidate) => candidate.toLowerCase() === lower,
    );
    if (actual !== undefined && actual !== key) {
      throw failure(ERROR_CODES.collision, roleDescriptor.ownerId);
    }
    const raw = await readPresent(store, jsonByKey, key, roleDescriptor.ownerId);
    if (raw === ABSENT) continue;
    await invokeOwner(
      roleDescriptor,
      "normalize",
      raw,
      undefined,
      { revalidate: false },
    );
  }

  const orderedWrites = [...writes.values()].sort((left, right) =>
    ownerOrder.get(left.ownerId) - ownerOrder.get(right.ownerId) ||
    left.key.localeCompare(right.key, "en")
  );
  for (const write of orderedWrites) {
    try {
      await store.write(write.key, write.value);
    } catch (cause) {
      throw failure(ERROR_CODES.invalid, write.ownerId, cause);
    }
  }
}

export function createProductionRestoreMigrationRegistry() {
  const catalog = allPersistedSchemaOwners();
  assertCompletePersistedSchemaOwnerCatalog(catalog);
  return Object.freeze({
    migrate: async (value) => {
      const request = dataEntries(
        value,
        ["directory", "manifest"],
        "restore-registry",
      );
      let manifest;
      try {
        manifest = normalizeBackupManifest(request.get("manifest"));
      } catch (cause) {
        throw failure(ERROR_CODES.invalid, "restore-registry", cause);
      }
      const root = await verifiedCandidateRoot(request.get("directory"));
      const { jsonByKey } = await rootJsonEntries(root, catalog);
      await migrateCandidate({ root, catalog, jsonByKey, manifest });
    },
  });
}
