import { types as utilTypes } from "node:util";

import { normalizeConfirmationState } from "../domain/confirmation-contract.js";
import {
  AGENT_MEMORY_QUERY_STATE_KEY,
  normalizeAgentMemoryQueryPersistedState,
} from "./agent-memory-query-service.js";
import {
  ATTENTION_INBOX_STATE_KEY,
  normalizeAttentionState,
} from "./attention-inbox-state.js";
import {
  CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY,
  normalizeChangePackageApplicationProjectionPersistedState,
} from "./change-package-application-projection-store.js";
import {
  CHANGE_PACKAGE_APPLICATION_STATE_KEY,
  normalizeChangePackageApplicationPersistedState,
} from "./change-package-application-service.js";
import {
  CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY,
  normalizeControlledCommitDeliveryPersistedState,
} from "./change-package-controlled-commit-service.js";
import {
  CODE_JOB_STATE_KEY,
  normalizeCodeJobArchiveIndexRecord,
  normalizeCodeJobArchiveTombstoneRecord,
  normalizeCodeJobStoreState,
} from "./code-job-store.js";
import {
  CONFIGURATION_STATE_KEY,
  migrateConfigurationState,
  normalizeConfigurationLimits,
  normalizeConfigurationState,
} from "./configuration-state.js";
import {
  configuredRoleLifecycleStateKey,
  normalizeConfiguredRoleLifecyclePersistedState,
} from "./configured-role-employee.js";
import {
  CONFIRMATION_QUEUE_STATE_KEY,
} from "./confirmation-queue.js";
import {
  CONTROLLED_CODE_EXECUTOR_STATE_KEY,
  normalizeControlledCodeExecutorState,
} from "./controlled-code-executor.js";
import { TASK_RUN_RECEIPT_STATE_KEY, normalizeTaskRunExecutionReceiptPersistedState } from "./task-run-execution-receipts.js";
import { AUTOMATIC_OWN_PR_REPAIR_STATE_KEY, normalizeAutomaticOwnPrRepairState } from "./automatic-own-pr-repair.js";
import { WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState, migrateWorkContinuationState } from "./work-continuation-state.js";
import { ORIGINAL_REPAIR_FEEDBACK_ARCHIVE_PREFIX, normalizeOriginalRepairFeedbackArchiveRecord } from "../domain/original-repair-feedback.js";
import {
  planLegacyAuthorityProjectionAdoption,
} from "./legacy-authority-projection-adapter.js";
import {
  buildMemoryJournalIndexState,
  isMemoryJournalIndexStateCurrent,
  MEMORY_INDEX_KEY,
  MEMORY_JOURNAL_KEY,
  normalizeMemoryJournalState,
} from "./local-memory-journal.js";
import {
  LEGACY_AUTHORITY_PROJECTION_STATE_KEY,
  normalizeLegacyAuthorityProjectionState,
} from "./memory-projector.js";
import {
  normalizeOwnerWorkRequestState,
  OWNER_WORK_REQUEST_STATE_KEY,
} from "./owner-work-request-state.js";
import {
  normalizePrEngineerReadFactsPersistedState,
  PR_ENGINEER_READ_FACTS_STATE_KEY,
} from "./pr-engineer-service.js";
import {
  normalizeWorkProposalPersistedState,
  WORK_PROPOSAL_STATE_KEY,
} from "./work-proposal-store.js";
import {
  normalizeWorkLedgerPersistedState,
  WORK_LEDGER_STATE_KEY,
} from "./work-ledger-state.js";
import {
  migrateWorkflowPersistedState,
  normalizeWorkflowPersistedState,
  WORKFLOW_STATE_KEY,
} from "./workflow-routing-state.js";

const COVERAGE_CODE = "RESTORE_SCHEMA_OWNER_COVERAGE_INCOMPLETE";

function frozenVersions(...versions) {
  return Object.freeze(versions);
}

function frozenFamily(value) {
  return Object.freeze({ ...value });
}

const OWNER_BASELINES = Object.freeze([
  Object.freeze({
    ownerId: "configuration-state",
    key: "configuration-state",
    mode: "migrate-replace",
    currentVersion: 3,
    supportedVersions: frozenVersions(1, 2, 3),
    optional: true,
  }),
  Object.freeze({
    ownerId: "workflow-routing-state",
    key: "workflow-routing-state",
    mode: "migrate-replace",
    currentVersion: 2,
    supportedVersions: frozenVersions(1, 2),
    optional: true,
  }),
  Object.freeze({
    ownerId: "work-ledger-state",
    key: "work-ledger-state",
    mode: "migrate-replace",
    currentVersion: 13,
    supportedVersions: frozenVersions(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13),
    optional: true,
  }),
  Object.freeze({
    ownerId: "code-job-state",
    key: "code-job-state",
    mode: "migrate-replace",
    currentVersion: 8,
    supportedVersions: frozenVersions(1, 2, 3, 4, 5, 6, 7, 8),
    optional: true,
  }),
  Object.freeze({
    ownerId: "code-job-archive-record",
    keyFamily: frozenFamily({
      prefix: "code-job-tombstone-record-",
      suffix: "",
      memberPattern: "code-job-[a-f0-9]{55}",
      discovery: "strict-scan",
    }),
    mode: "immutable-validate",
    currentVersion: 3,
    supportedVersions: frozenVersions(1, 2, 3),
    optional: true,
  }),
  Object.freeze({
    ownerId: "code-job-archive-index",
    keyFamily: frozenFamily({
      prefix: "code-job-tombstone-index-",
      suffix: "",
      memberPattern: "[a-f0-9]{64}",
      discovery: "strict-scan",
    }),
    mode: "immutable-validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "code-executor-state",
    key: "code-executor-state",
    mode: "migrate-replace",
    currentVersion: 3,
    supportedVersions: frozenVersions(1, 2, 3),
    optional: true,
  }),
  Object.freeze({
    ownerId: "confirmation-queue",
    key: "confirmation-queue",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "task-run-execution-receipts",
    key: "task-run-execution-receipts",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "automatic-own-pr-repair-state",
    key: "automatic-own-pr-repair-state",
    mode: "validate",
    currentVersion: 2,
    supportedVersions: frozenVersions(1, 2),
    optional: true,
  }),
  Object.freeze({
    ownerId: "work-continuations", key: WORK_CONTINUATION_STATE_KEY, mode: "migrate-replace",
    currentVersion: 2, supportedVersions: frozenVersions(1, 2), optional: true,
  }),
  Object.freeze({
    ownerId: "original-repair-feedback-archive",
    keyFamily: frozenFamily({
      prefix: ORIGINAL_REPAIR_FEEDBACK_ARCHIVE_PREFIX,
      suffix: "",
      memberPattern: "[a-f0-9]{64}",
      discovery: "strict-scan",
    }),
    mode: "immutable-validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "work-proposal-state",
    key: "work-proposal-state",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "attention-inbox",
    key: "attention-inbox",
    mode: "validate",
    currentVersion: 2,
    supportedVersions: frozenVersions(1, 2),
    optional: true,
  }),
  Object.freeze({
    ownerId: "owner-work-requests",
    key: "owner-work-requests-v1",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "unified-memory-journal",
    key: "unified-memory-records",
    mode: "migrate-replace",
    currentVersion: 2,
    supportedVersions: frozenVersions(1, 2),
    optional: true,
  }),
  Object.freeze({
    ownerId: "unified-memory-index",
    key: "unified-memory-index",
    mode: "derived-repair",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "legacy-authority-projection",
    key: "authority-bound-memory-projection",
    mode: "cross-store-adopt",
    currentVersion: 4,
    supportedVersions: frozenVersions(1, 2, 3, 4),
    optional: true,
  }),
  Object.freeze({
    ownerId: "agent-memory-queries",
    key: "agent-memory-queries",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "pr-engineer-read-facts",
    key: "pr-engineer-read-facts",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "change-package-applications",
    key: "change-package-applications",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "change-package-controlled-commits",
    key: "change-package-controlled-commits",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "change-package-application-projections",
    key: "change-package-application-projections",
    mode: "validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
  Object.freeze({
    ownerId: "configured-role-lifecycle",
    keyFamily: frozenFamily({
      prefix: "configured-role-",
      suffix: "-state",
      memberPattern: "[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?",
      discovery: "candidate-configuration",
    }),
    mode: "candidate-config-derived-validate",
    currentVersion: 1,
    supportedVersions: frozenVersions(1),
    optional: true,
  }),
]);

const BASELINE_BY_ID = new Map(
  OWNER_BASELINES.map((baseline) => [baseline.ownerId, baseline]),
);

export const PERSISTED_SCHEMA_OWNER_IDS = Object.freeze(
  OWNER_BASELINES.map(({ ownerId }) => ownerId),
);

class RestoreSchemaOwnerCoverageError extends Error {
  constructor() {
    super("restore schema owner coverage is incomplete");
    this.name = "RestoreSchemaOwnerCoverageError";
    this.code = COVERAGE_CODE;
  }
}

function coverageFailure() {
  return new RestoreSchemaOwnerCoverageError();
}

function plainDataEntries(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw coverageFailure();
  }
  const entries = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw coverageFailure();
    }
    entries.set(key, descriptor.value);
  }
  return entries;
}

function pureFunction(value) {
  return typeof value === "function" && !utilTypes.isProxy(value);
}

function requiredAdapter(mode) {
  if (mode === "migrate-replace") return "migrate";
  if (mode === "derived-repair") return "derive";
  if (mode === "cross-store-adopt") return "plan";
  if (mode === "immutable-validate") return "verifyImmutable";
  if (mode === "candidate-config-derived-validate") return "derive";
  return null;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Object.isFrozen(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameFamily(left, right) {
  if (!left || !Object.isFrozen(left)) return false;
  let entries;
  try {
    entries = plainDataEntries(left);
  } catch {
    return false;
  }
  const keys = ["prefix", "suffix", "memberPattern", "discovery"];
  return (
    entries.size === keys.length &&
    keys.every((key) => entries.get(key) === right[key])
  );
}

function exactMetadata(entries, baseline) {
  const hasKey = Object.hasOwn(baseline, "key");
  const expectedKeys = new Set([
    "ownerId",
    hasKey ? "key" : "keyFamily",
    "mode",
    "currentVersion",
    "supportedVersions",
    "optional",
    "normalize",
  ]);
  const special = requiredAdapter(baseline.mode);
  if (special !== null) expectedKeys.add(special);
  if (
    entries.size !== expectedKeys.size ||
    [...entries.keys()].some((key) => !expectedKeys.has(key))
  ) {
    return false;
  }
  return (
    entries.get("ownerId") === baseline.ownerId &&
    entries.get("mode") === baseline.mode &&
    entries.get("currentVersion") === baseline.currentVersion &&
    entries.get("optional") === baseline.optional &&
    sameArray(entries.get("supportedVersions"), baseline.supportedVersions) &&
    (hasKey
      ? entries.get("key") === baseline.key
      : sameFamily(entries.get("keyFamily"), baseline.keyFamily)) &&
    pureFunction(entries.get("normalize")) &&
    (special === null || pureFunction(entries.get(special)))
  );
}

export function definePersistedSchemaOwner(value) {
  const entries = plainDataEntries(value);
  const ownerId = entries.get("ownerId");
  const baseline = BASELINE_BY_ID.get(ownerId);
  if (baseline === undefined || !pureFunction(entries.get("normalize"))) {
    throw coverageFailure();
  }
  const special = requiredAdapter(baseline.mode);
  const allowed = new Set(["ownerId", "normalize"]);
  if (special !== null) allowed.add(special);
  if (
    entries.size !== allowed.size ||
    [...entries.keys()].some((key) => !allowed.has(key)) ||
    (special !== null && !pureFunction(entries.get(special)))
  ) {
    throw coverageFailure();
  }
  return Object.freeze({
    ownerId: baseline.ownerId,
    ...(baseline.key === undefined
      ? { keyFamily: baseline.keyFamily }
      : { key: baseline.key }),
    mode: baseline.mode,
    currentVersion: baseline.currentVersion,
    supportedVersions: baseline.supportedVersions,
    optional: baseline.optional,
    normalize: entries.get("normalize"),
    ...(special === null ? {} : { [special]: entries.get(special) }),
  });
}

export function assertCompletePersistedSchemaOwnerCatalog(catalog) {
  if (
    !Array.isArray(catalog) ||
    utilTypes.isProxy(catalog) ||
    catalog.length !== OWNER_BASELINES.length
  ) {
    throw coverageFailure();
  }
  const seenOwnerIds = new Set();
  const fixedKeys = new Set();
  for (const descriptor of catalog) {
    if (utilTypes.isProxy(descriptor) || !Object.isFrozen(descriptor)) {
      throw coverageFailure();
    }
    let entries;
    try {
      entries = plainDataEntries(descriptor);
    } catch {
      throw coverageFailure();
    }
    const baseline = BASELINE_BY_ID.get(entries.get("ownerId"));
    if (
      baseline === undefined ||
      seenOwnerIds.has(baseline.ownerId) ||
      !exactMetadata(entries, baseline)
    ) {
      throw coverageFailure();
    }
    seenOwnerIds.add(baseline.ownerId);
    if (baseline.key !== undefined) {
      if (fixedKeys.has(baseline.key)) throw coverageFailure();
      fixedKeys.add(baseline.key);
    }
  }
  if (
    seenOwnerIds.size !== PERSISTED_SCHEMA_OWNER_IDS.length ||
    PERSISTED_SCHEMA_OWNER_IDS.some((ownerId) => !seenOwnerIds.has(ownerId))
  ) {
    throw coverageFailure();
  }
}

const configurationLimits = normalizeConfigurationLimits();

function normalizeConfigurationOwner(value) {
  return normalizeConfigurationState(value, configurationLimits);
}

function migrateConfigurationOwner(value) {
  return migrateConfigurationState(value, configurationLimits).state;
}

function normalizeMemoryIndexOwner(value, { journal } = {}) {
  if (!isMemoryJournalIndexStateCurrent(value, journal)) {
    throw new TypeError("unified memory index is stale or invalid");
  }
  return structuredClone(value);
}

function deriveMemoryIndexOwner({ journal } = {}) {
  return buildMemoryJournalIndexState(journal);
}

function deriveConfiguredRoleLifecycleKeys({ configurationState } = {}) {
  const state = normalizeConfigurationOwner(configurationState);
  if (state.activeVersion === null) return Object.freeze([]);
  const active = state.versions.find(
    ({ version }) => version === state.activeVersion,
  );
  if (active === undefined) {
    throw new TypeError("active configuration version is unavailable");
  }
  return Object.freeze(
    Object.keys(active.configuration.employees.roles)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map(configuredRoleLifecycleStateKey),
  );
}

const PRODUCTION_OWNER_CATALOG = Object.freeze([
  definePersistedSchemaOwner({
    ownerId: "configuration-state",
    normalize: normalizeConfigurationOwner,
    migrate: migrateConfigurationOwner,
  }),
  definePersistedSchemaOwner({
    ownerId: "workflow-routing-state",
    normalize: normalizeWorkflowPersistedState,
    migrate: migrateWorkflowPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "work-ledger-state",
    normalize: normalizeWorkLedgerPersistedState,
    migrate: normalizeWorkLedgerPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "code-job-state",
    normalize: normalizeCodeJobStoreState,
    migrate: normalizeCodeJobStoreState,
  }),
  definePersistedSchemaOwner({
    ownerId: "code-job-archive-record",
    normalize: normalizeCodeJobArchiveTombstoneRecord,
    verifyImmutable: normalizeCodeJobArchiveTombstoneRecord,
  }),
  definePersistedSchemaOwner({
    ownerId: "code-job-archive-index",
    normalize: normalizeCodeJobArchiveIndexRecord,
    verifyImmutable: normalizeCodeJobArchiveIndexRecord,
  }),
  definePersistedSchemaOwner({
    ownerId: "code-executor-state",
    normalize: normalizeControlledCodeExecutorState,
    migrate: normalizeControlledCodeExecutorState,
  }),
  definePersistedSchemaOwner({
    ownerId: "confirmation-queue",
    normalize: normalizeConfirmationState,
  }),
  definePersistedSchemaOwner({
    ownerId: "task-run-execution-receipts",
    normalize: normalizeTaskRunExecutionReceiptPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "automatic-own-pr-repair-state",
    normalize: normalizeAutomaticOwnPrRepairState,
  }),
  definePersistedSchemaOwner({
    ownerId: "work-continuations", normalize: normalizeWorkContinuationState, migrate: migrateWorkContinuationState,
  }),
  definePersistedSchemaOwner({
    ownerId: "original-repair-feedback-archive",
    normalize: normalizeOriginalRepairFeedbackArchiveRecord,
    verifyImmutable: normalizeOriginalRepairFeedbackArchiveRecord,
  }),
  definePersistedSchemaOwner({
    ownerId: "work-proposal-state",
    normalize: normalizeWorkProposalPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "attention-inbox",
    normalize: normalizeAttentionState,
  }),
  definePersistedSchemaOwner({
    ownerId: "owner-work-requests",
    normalize: normalizeOwnerWorkRequestState,
  }),
  definePersistedSchemaOwner({
    ownerId: "unified-memory-journal",
    normalize: normalizeMemoryJournalState,
    migrate: normalizeMemoryJournalState,
  }),
  definePersistedSchemaOwner({
    ownerId: "unified-memory-index",
    normalize: normalizeMemoryIndexOwner,
    derive: deriveMemoryIndexOwner,
  }),
  definePersistedSchemaOwner({
    ownerId: "legacy-authority-projection",
    normalize: normalizeLegacyAuthorityProjectionState,
    plan: planLegacyAuthorityProjectionAdoption,
  }),
  definePersistedSchemaOwner({
    ownerId: "agent-memory-queries",
    normalize: normalizeAgentMemoryQueryPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "pr-engineer-read-facts",
    normalize: normalizePrEngineerReadFactsPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "change-package-applications",
    normalize: normalizeChangePackageApplicationPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "change-package-controlled-commits",
    normalize: normalizeControlledCommitDeliveryPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "change-package-application-projections",
    normalize: normalizeChangePackageApplicationProjectionPersistedState,
  }),
  definePersistedSchemaOwner({
    ownerId: "configured-role-lifecycle",
    normalize: normalizeConfiguredRoleLifecyclePersistedState,
    derive: deriveConfiguredRoleLifecycleKeys,
  }),
]);

const FIXED_OWNER_KEYS = Object.freeze({
  "configuration-state": CONFIGURATION_STATE_KEY,
  "workflow-routing-state": WORKFLOW_STATE_KEY,
  "work-ledger-state": WORK_LEDGER_STATE_KEY,
  "code-job-state": CODE_JOB_STATE_KEY,
  "code-executor-state": CONTROLLED_CODE_EXECUTOR_STATE_KEY,
  "confirmation-queue": CONFIRMATION_QUEUE_STATE_KEY,
  "task-run-execution-receipts": TASK_RUN_RECEIPT_STATE_KEY,
  "automatic-own-pr-repair-state": AUTOMATIC_OWN_PR_REPAIR_STATE_KEY,
  "work-continuations": WORK_CONTINUATION_STATE_KEY,
  "work-proposal-state": WORK_PROPOSAL_STATE_KEY,
  "attention-inbox": ATTENTION_INBOX_STATE_KEY,
  "owner-work-requests": OWNER_WORK_REQUEST_STATE_KEY,
  "unified-memory-journal": MEMORY_JOURNAL_KEY,
  "unified-memory-index": MEMORY_INDEX_KEY,
  "legacy-authority-projection": LEGACY_AUTHORITY_PROJECTION_STATE_KEY,
  "agent-memory-queries": AGENT_MEMORY_QUERY_STATE_KEY,
  "pr-engineer-read-facts": PR_ENGINEER_READ_FACTS_STATE_KEY,
  "change-package-applications": CHANGE_PACKAGE_APPLICATION_STATE_KEY,
  "change-package-controlled-commits":
    CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY,
  "change-package-application-projections":
    CHANGE_PACKAGE_APPLICATION_PROJECTION_STATE_KEY,
});

assertCompletePersistedSchemaOwnerCatalog(PRODUCTION_OWNER_CATALOG);
for (const descriptor of PRODUCTION_OWNER_CATALOG) {
  if (
    Object.hasOwn(FIXED_OWNER_KEYS, descriptor.ownerId) &&
    descriptor.key !== FIXED_OWNER_KEYS[descriptor.ownerId]
  ) {
    throw coverageFailure();
  }
}

export function allPersistedSchemaOwners() {
  return PRODUCTION_OWNER_CATALOG;
}
