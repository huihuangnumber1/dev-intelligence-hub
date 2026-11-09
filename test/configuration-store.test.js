import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  configurationDocumentDigest,
  configurationDocumentImpact,
} from "../src/domain/configuration-contract.js";
import {
  CONFIGURATION_STATE_KEY,
  ConfigurationStore,
} from "../src/services/configuration-store.js";
import {
  CONFIGURATION_STATE_SCHEMA_VERSION,
  configurationContentDigest,
  configurationImpactDigest,
} from "../src/services/configuration-state.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function configuration() {
  return clone(committedConfiguration);
}

class MemoryStore {
  constructor(value = null) {
    this.value = clone(value);
    this.writes = [];
    this.failure = null;
  }

  async read(_name, fallback = null) {
    return clone(this.value ?? fallback);
  }

  async write(name, value) {
    const copied = clone(value);
    if (this.failure === "before") {
      this.failure = null;
      throw new Error("write unavailable");
    }
    if (this.failure === "missing") {
      this.failure = null;
      this.value = null;
      throw new Error("durable state disappeared");
    }
    this.value = copied;
    this.writes.push({ name, value: copied });
    if (this.failure === "after") {
      this.failure = null;
      throw new Error("write acknowledgement unavailable");
    }
  }

  failNextWrite(mode) {
    this.failure = mode;
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

function clock() {
  let offset = 0;
  const epoch = Date.parse("2026-08-05T01:00:00.000Z");
  return () => new Date(epoch + offset++ * 1_000);
}

function idFactory() {
  let id = 0;
  return () => `draft-${++id}`;
}

async function readyStore({
  store = new MemoryStore(),
  limits,
  idFactory: configuredIdFactory = idFactory(),
} = {}) {
  const configurations = new ConfigurationStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
    clock: clock(),
    idFactory: configuredIdFactory,
    ...(limits ? { limits } : {}),
  });
  await configurations.recover();
  return { configurations, store };
}

async function importedFixture(options = {}) {
  const fixture = await readyStore(options);
  await fixture.configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });
  return fixture;
}

function changedConfiguration() {
  const changed = configuration();
  changed.employees.roles.developer.mission =
    "实现已验收需求，验证证据，并主动报告风险。";
  return changed;
}

function configurationWithReusableTest({ version = 1, source = "assert.ok(true);", kind = "node-script" } = {}) {
  const value = configuration();
  value.codeExecutor = {
    enabled: true,
    docker: {
      executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: [{ id: "dashboard", sourceRoot: "." }],
    profiles: {
      "reusable-smoke": {
        kind,
        ...(kind === "node-script" ? { image: `node:22-alpine@sha256:${"a".repeat(64)}` } : { nodeExecutable: "C:/Program Files/nodejs/node.exe", nodeSha256: "a".repeat(64) }),
        timeoutMs: 30_000,
        asset: {
          schemaVersion: 1,
          title: "Reusable smoke test",
          description: "Checks a stable cross-PR invariant.",
          version,
          source,
        },
      },
    },
    requiredProfilesByWorkspace: { dashboard: ["reusable-smoke"] },
  };
  return value;
}

function assertCode(code, statusCode) {
  return (error) => error?.code === code && error?.statusCode === statusCode;
}

function readdress(record, idName, prefix) {
  const { [idName]: _id, contentDigest: _digest, ...content } = record;
  const contentDigest = configurationContentDigest(content);
  return { [idName]: `${prefix}-${contentDigest}`, contentDigest, ...content };
}

function replaceVersionConfiguration(state, versionNumber, replacement) {
  const configurationDigest = configurationDocumentDigest(replacement);
  const versionIndex = state.versions.findIndex(
    (entry) => entry.version === versionNumber,
  );
  state.versions[versionIndex] = readdress(
    {
      ...state.versions[versionIndex],
      configurationDigest,
      configuration: clone(replacement),
    },
    "versionId",
    "configuration-version",
  );
  const auditIndex = state.audit.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.audit[auditIndex] = readdress(
    { ...state.audit[auditIndex], configurationDigest },
    "auditId",
    "configuration-audit",
  );
  const outboxIndex = state.projectionOutbox.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.projectionOutbox[outboxIndex] = readdress(
    { ...state.projectionOutbox[outboxIndex], configurationDigest },
    "outboxId",
    "configuration-outbox",
  );
}

function replaceVersionImpactDigest(state, versionNumber, impactDigest) {
  const versionIndex = state.versions.findIndex(
    (entry) => entry.version === versionNumber,
  );
  state.versions[versionIndex] = readdress(
    { ...state.versions[versionIndex], impactDigest },
    "versionId",
    "configuration-version",
  );
  const auditIndex = state.audit.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.audit[auditIndex] = readdress(
    { ...state.audit[auditIndex], impactDigest },
    "auditId",
    "configuration-audit",
  );
  const outboxIndex = state.projectionOutbox.findIndex(
    (entry) => entry.configurationVersion === versionNumber,
  );
  state.projectionOutbox[outboxIndex] = readdress(
    { ...state.projectionOutbox[outboxIndex], impactDigest },
    "outboxId",
    "configuration-outbox",
  );
}

const CONFIGURATION_PROPOSAL = Object.freeze({
  proposalId: "work-intent-configuration-change-1",
  proposalContentDigest: "a".repeat(64),
});

function proposalConfiguration() {
  const value = configuration();
  value.refreshMinutes += 1;
  return value;
}

test("configuration proposal drafts are content-bound, durable, and idempotent", async () => {
  const { configurations } = await importedFixture();
  const authority = await configurations.readAuthoritySnapshot();
  const first = await configurations.createProposalDraft({
    ...CONFIGURATION_PROPOSAL,
    configuration: proposalConfiguration(),
    expectedStateRevision: authority.revision,
  });
  const duplicate = await configurations.createProposalDraft({
    ...CONFIGURATION_PROPOSAL,
    configuration: proposalConfiguration(),
    expectedStateRevision: 0,
  });

  assert.deepEqual(duplicate, first);
  assert.equal(first.currentHead, true);
  assert.match(first.draft.draftId, /^configuration-proposal-[a-f0-9]{64}$/);
  assert.equal(first.draft.proposedBy, `work-proposal:${"a".repeat(64)}`);
  assert.deepEqual(
    await configurations.readProposalDraft(CONFIGURATION_PROPOSAL),
    first,
  );

  const different = proposalConfiguration();
  different.refreshMinutes += 1;
  await assert.rejects(
    configurations.createProposalDraft({
      ...CONFIGURATION_PROPOSAL,
      configuration: different,
      expectedStateRevision: first.createdStateRevision,
    }),
    assertCode("CONFIGURATION_PROPOSAL_BINDING_CONFLICT", 409),
  );
});

test("a lost proposal draft acknowledgement is recovered without a second draft", async () => {
  const store = new MemoryStore();
  const first = await importedFixture({ store });
  const authority = await first.configurations.readAuthoritySnapshot();
  store.failNextWrite("after");
  const acknowledged = await first.configurations.createProposalDraft({
    ...CONFIGURATION_PROPOSAL,
    configuration: proposalConfiguration(),
    expectedStateRevision: authority.revision,
  });
  assert.equal(acknowledged.currentHead, true);

  const recovered = await readyStore({ store });
  const record = await recovered.configurations.readProposalDraft(
    CONFIGURATION_PROPOSAL,
  );
  assert.equal(record.currentHead, true);
  assert.equal(
    store.value.draftRevisions.filter(
      ({ draftId }) => draftId === record.draft.draftId,
    ).length,
    1,
  );
});

test("proposal activation recovery preserves the original confirmation binding", async () => {
  const { configurations } = await importedFixture();
  const authority = await configurations.readAuthoritySnapshot();
  const record = await configurations.createProposalDraft({
    ...CONFIGURATION_PROPOSAL,
    configuration: proposalConfiguration(),
    expectedStateRevision: authority.revision,
  });
  const prepared = await configurations.prepareProposalDraftActivation(
    CONFIGURATION_PROPOSAL,
  );
  assert.equal(prepared.current, true);
  assert.equal(
    prepared.prepared.expectedStateRevision,
    record.createdStateRevision,
  );
  assert.equal(prepared.prepared.draftRevisionId, record.draft.draftRevisionId);

  const later = proposalConfiguration();
  later.browserPollSeconds += 1;
  await configurations.createDraft({
    configuration: later,
    expectedStateRevision: record.createdStateRevision,
    proposedBy: "owner",
  });
  const historical = await configurations.prepareProposalDraftActivation(
    CONFIGURATION_PROPOSAL,
  );
  assert.equal(historical.current, false);
  assert.deepEqual(historical.prepared, prepared.prepared);
});

function legacyImpactDigest(before, after) {
  const impact = configurationDocumentImpact(before, after);
  const legacyRestartRequired = (path) =>
    path === "port" ||
    path === "githubLogin" ||
    path.startsWith("brainProviders.") ||
    path.startsWith("codeExecutor.") ||
    path.startsWith("changePackages.") ||
    path === "githubActions.enabled" ||
    path.startsWith("githubActions.actorAccountId") ||
    path.startsWith("githubActions.tokenEnv") ||
    path.startsWith("githubActions.ghCommand") ||
    path.startsWith("githubActions.networkEnv");
  return configurationImpactDigest({
    ...impact,
    restart_required: impact.restart_required.filter(legacyRestartRequired),
  });
}

function legacyConfigurationState(value) {
  const legacy = clone(value);
  legacy.schemaVersion = 1;
  delete legacy.schemaMigrations;
  delete legacy.impactPolicy;
  return legacy;
}

test("recovery atomically upgrades legacy configuration state without changing domain history", async () => {
  const seeded = await importedFixture();
  const legacy = legacyConfigurationState(seeded.store.value);
  const store = new MemoryStore(legacy);

  const { configurations } = await readyStore({ store });
  const recovered = await configurations.readSnapshot();

  assert.equal(CONFIGURATION_STATE_SCHEMA_VERSION, 3);
  assert.equal(recovered.schemaVersion, 3);
  assert.deepEqual(recovered.schemaMigrations, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
  assert.deepEqual(recovered.impactPolicy, {
    version: 2,
    currentFromVersion: legacy.versions.length + 1,
  });
  assert.equal(recovered.revision, legacy.revision);
  assert.deepEqual(recovered.versions, legacy.versions);
  assert.deepEqual(recovered.draftRevisions, legacy.draftRevisions);
  assert.deepEqual(recovered.draftHeads, legacy.draftHeads);
  assert.deepEqual(recovered.audit, legacy.audit);
  assert.deepEqual(recovered.projectionOutbox, legacy.projectionOutbox);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.value, recovered);
});

test("a failed configuration schema upgrade preserves the exact legacy state", async () => {
  const seeded = await importedFixture();
  const legacy = legacyConfigurationState(seeded.store.value);
  const store = new MemoryStore(legacy);
  store.failNextWrite("before");

  await assert.rejects(
    readyStore({ store }),
    assertCode("CONFIGURATION_STATE_MIGRATION_FAILED", 503),
  );
  assert.deepEqual(store.value, legacy);
  assert.equal(store.writes.length, 0);
});

test("configuration schema upgrade reconciles a lost durable acknowledgement", async () => {
  const seeded = await importedFixture();
  const legacy = legacyConfigurationState(seeded.store.value);
  const store = new MemoryStore(legacy);
  store.failNextWrite("after");

  const { configurations } = await readyStore({ store });
  const recovered = await configurations.readSnapshot();

  assert.equal(recovered.schemaVersion, 3);
  assert.deepEqual(recovered.schemaMigrations, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
  assert.deepEqual(store.value, recovered);
  assert.equal(store.writes.length, 1);
});

test("recovery rejects an unknown future configuration schema without rewriting it", async () => {
  const seeded = await importedFixture();
  const future = clone(seeded.store.value);
  future.schemaVersion = CONFIGURATION_STATE_SCHEMA_VERSION + 1;
  const store = new MemoryStore(future);

  await assert.rejects(
    readyStore({ store }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );
  assert.deepEqual(store.value, future);
  assert.equal(store.writes.length, 0);
});

test("recovery preserves pre-GitHub-read content addresses without rewriting history", async () => {
  const legacyDocument = configuration();
  delete legacyDocument.githubRead;
  const store = new MemoryStore();
  const first = await readyStore({ store });
  await first.configurations.importBootstrap({
    configuration: legacyDocument,
    importedBy: "pre-boundary-bootstrap",
  });
  const durableBeforeRestart = clone(store.value);
  const writesBeforeRestart = store.writes.length;

  const restarted = await readyStore({ store });
  const active = await restarted.configurations.readActive();

  assert.equal(Object.hasOwn(active.configuration, "githubRead"), false);
  assert.equal(active.configurationDigest, configurationDocumentDigest(legacyDocument));
  assert.deepEqual(store.value, durableBeforeRestart);
  assert.equal(store.writes.length, writesBeforeRestart);
});

test("schema v2 migration accepts historical impact policy only before its durable boundary", async () => {
  const seeded = await importedFixture();
  const draft = await seeded.configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner:legacy",
  });
  const activation = await seeded.configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  await seeded.configurations.activateDraft({
    ...activation,
    activatedBy: "owner:legacy",
  });

  const schemaV2 = clone(seeded.store.value);
  schemaV2.schemaVersion = 2;
  schemaV2.schemaMigrations = [{ from: 1, to: 2 }];
  delete schemaV2.impactPolicy;
  replaceVersionImpactDigest(
    schemaV2,
    2,
    legacyImpactDigest(
      schemaV2.versions[0].configuration,
      schemaV2.versions[1].configuration,
    ),
  );
  const store = new MemoryStore(schemaV2);
  const migrated = await readyStore({
    store,
    idFactory: () => "future-draft",
  });
  const migratedSnapshot = await migrated.configurations.readSnapshot();
  assert.deepEqual(migratedSnapshot.impactPolicy, {
    version: 2,
    currentFromVersion: 3,
  });

  const futureConfiguration = clone(migratedSnapshot.versions[1].configuration);
  futureConfiguration.employees.roles.tester.mission = "验证迁移后的当前影响策略。";
  const futureDraft = await migrated.configurations.createDraft({
    configuration: futureConfiguration,
    expectedStateRevision: migratedSnapshot.revision,
    proposedBy: "owner:current",
  });
  const futurePlan = await migrated.configurations.prepareDraftActivation({
    draftId: futureDraft.draftId,
    draftRevision: futureDraft.revision,
    expectedStateRevision: migratedSnapshot.revision + 1,
    expectedActiveVersion: 2,
  });
  await migrated.configurations.activateDraft({
    ...futurePlan,
    activatedBy: "owner:current",
  });
  const forged = clone(store.value);
  replaceVersionImpactDigest(
    forged,
    3,
    legacyImpactDigest(
      forged.versions[1].configuration,
      forged.versions[2].configuration,
    ),
  );

  await assert.rejects(
    readyStore({ store: new MemoryStore(forged) }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );
});

test("bootstrap imports once and later file changes cannot replace active authority", async () => {
  const { configurations, store } = await readyStore();
  const imported = await configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });

  assert.equal(imported.applied, true);
  assert.equal(imported.active.version, 1);
  assert.equal(store.writes.length, 1);

  let getterCalls = 0;
  const ignoredHostileFile = {};
  Object.defineProperty(ignoredHostileFile, "credential", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });
  const ignoredHostile = await configurations.importBootstrap({
    configuration: ignoredHostileFile,
    importedBy: "changed-bootstrap-file",
  });
  assert.equal(ignoredHostile.applied, false);
  assert.equal(getterCalls, 0);
  assert.equal(store.writes[0].name, CONFIGURATION_STATE_KEY);

  const ignored = await configurations.importBootstrap({
    configuration: changedConfiguration(),
    importedBy: "changed-bootstrap-file",
  });
  assert.equal(ignored.applied, false);
  assert.equal(ignored.active.version, 1);
  assert.equal(
    ignored.active.configuration.employees.roles.developer.mission,
    configuration().employees.roles.developer.mission,
  );
  assert.equal(store.writes.length, 1);

  const restarted = await readyStore({ store });
  const active = await restarted.configurations.readActive();
  assert.deepEqual(active, imported.active);
  assert.equal(Object.isFrozen(active), true);
});

test("an owner initialization draft creates one audited v1 after safe mode", async () => {
  const { configurations, store } = await readyStore();
  const draft = await configurations.createInitializationDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  assert.equal(draft.baseVersion, 0);
  assert.equal(draft.revision, 1);

  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.employees.roles.developer.brain.model = "qwen3.5:small";
  const revised = await configurations.reviseDraft({
    draftId: draft.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 1,
    configuration: revisedConfiguration,
    proposedBy: "owner:local",
  });
  assert.equal(revised.baseVersion, 0);
  const writeCount = store.writes.length;
  const prepared = await configurations.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 2,
  });
  assert.equal(prepared.kind, "configuration.initialize");
  assert.equal(prepared.expectedActiveVersion, null);
  assert.equal(prepared.activeDigest, null);
  assert.match(prepared.baselineDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.baselineDigest, prepared.impact.beforeDigest);
  assert.equal(prepared.documentDigest, revised.configurationDigest);
  assert.equal(prepared.impact.changed, true);
  assert.match(prepared.validationDigest, /^[a-f0-9]{64}$/);
  assert.match(prepared.impactDigest, /^[a-f0-9]{64}$/);
  assert.equal(store.writes.length, writeCount);

  const initialized = await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  assert.equal(initialized.applied, true);
  assert.equal(initialized.active.version, 1);
  assert.equal(initialized.active.previousVersion, null);
  assert.equal(initialized.active.source, "initialization");
  assert.equal(initialized.active.draftRevisionId, revised.draftRevisionId);

  const snapshot = await configurations.readSnapshot();
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.activeVersion, 1);
  assert.equal(snapshot.migration.status, "imported");
  assert.equal(snapshot.audit.at(-1).kind, "configuration_initialized");
  assert.equal(snapshot.projectionOutbox.length, 1);
  const repeated = await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, initialized.active);

  const restarted = await readyStore({ store });
  assert.deepEqual(await restarted.configurations.readActive(), initialized.active);
});

test("initialization remains explicit, latest-only, and cannot race bootstrap", async () => {
  const { configurations } = await readyStore();
  await assert.rejects(
    configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 0,
      proposedBy: "owner:local",
    }),
    assertCode("CONFIGURATION_BOOTSTRAP_REQUIRED", 409),
  );
  const draft = await configurations.createInitializationDraft({
    configuration: configuration(),
    expectedStateRevision: 0,
    proposedBy: "owner:local",
  });
  const revised = await configurations.reviseDraft({
    draftId: draft.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 1,
    configuration: changedConfiguration(),
    proposedBy: "owner:local",
  });
  await assert.rejects(
    configurations.prepareInitialization({
      draftId: draft.draftId,
      draftRevision: 1,
      expectedStateRevision: 2,
    }),
    assertCode("CONFIGURATION_DRAFT_REVISION_CONFLICT", 409),
  );
  const ignoredBootstrap = await configurations.importBootstrap({
    configuration: configuration(),
    importedBy: "bootstrap-file",
  });
  assert.deepEqual(ignoredBootstrap, { applied: false, active: null });
  const prepared = await configurations.prepareInitialization({
    draftId: draft.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 2,
  });
  await configurations.activateInitialization({
    ...prepared,
    activatedBy: "owner:local",
  });
  await assert.rejects(
    configurations.reviseDraft({
      draftId: draft.draftId,
      expectedDraftRevision: 2,
      expectedStateRevision: 3,
      configuration: configuration(),
      proposedBy: "owner:local",
    }),
    assertCode("CONFIGURATION_INITIALIZATION_STALE", 409),
  );
});

test("initialization write uncertainty is reconciled without creating a second v1", async (t) => {
  async function preparedFixture() {
    const fixture = await readyStore();
    const draft = await fixture.configurations.createInitializationDraft({
      configuration: changedConfiguration(),
      expectedStateRevision: 0,
      proposedBy: "owner:local",
    });
    const prepared = await fixture.configurations.prepareInitialization({
      draftId: draft.draftId,
      draftRevision: draft.revision,
      expectedStateRevision: 1,
    });
    return { ...fixture, prepared };
  }

  await t.test("write rejected before persistence", async () => {
    const { configurations, store, prepared } = await preparedFixture();
    store.failNextWrite("before");
    await assert.rejects(
      configurations.activateInitialization({
        ...prepared,
        activatedBy: "owner:local",
      }),
      assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
    );
    const snapshot = await configurations.readSnapshot();
    assert.equal(snapshot.activeVersion, null);
    assert.equal(snapshot.versions.length, 0);
    assert.equal(snapshot.projectionOutbox.length, 0);
  });

  await t.test("write committed before acknowledgement loss", async () => {
    const { configurations, store, prepared } = await preparedFixture();
    store.failNextWrite("after");
    const initialized = await configurations.activateInitialization({
      ...prepared,
      activatedBy: "owner:local",
    });
    assert.equal(initialized.active.version, 1);
    const repeated = await configurations.activateInitialization({
      ...prepared,
      activatedBy: "owner:local",
    });
    assert.equal(repeated.applied, false);
    assert.equal((await configurations.readSnapshot()).versions.length, 1);
  });
});

test("draft edits append immutable revisions and validation never writes", async () => {
  const { configurations, store } = await importedFixture();
  const created = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "employee:orchestrator",
  });

  assert.equal(created.draftId, "draft-1");
  assert.equal(created.revision, 1);
  assert.equal(created.baseVersion, 1);
  assert.match(created.draftRevisionId, /^configuration-draft-revision-[a-f0-9]{64}$/);
  assert.equal(store.writes.length, 2);

  await assert.rejects(
    configurations.reviseDraft({
      draftId: created.draftId,
      expectedDraftRevision: 1,
      expectedStateRevision: 1,
      configuration: configuration(),
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );

  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.employees.roles.developer.brain.model = "qwen3.5:small";
  const revised = await configurations.reviseDraft({
    draftId: created.draftId,
    expectedDraftRevision: 1,
    expectedStateRevision: 2,
    configuration: revisedConfiguration,
    proposedBy: "owner",
  });
  assert.equal(revised.revision, 2);
  assert.equal(revised.supersedesRevisionId, created.draftRevisionId);
  assert.deepEqual(
    await configurations.readDraft({ draftId: created.draftId, revision: 1 }),
    created,
  );

  const writeCount = store.writes.length;
  const prepared = await configurations.prepareDraftActivation({
    draftId: revised.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 3,
    expectedActiveVersion: 1,
  });
  assert.equal(prepared.documentDigest, revised.configurationDigest);
  assert.match(prepared.validationDigest, /^[a-f0-9]{64}$/);
  assert.match(prepared.impactDigest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.impact.changed, true);
  assert.equal(store.writes.length, writeCount);
  assert.equal(Object.isFrozen(prepared), true);
});

test("control-plane and authority reads bound history before cloning", async () => {
  const { configurations } = await importedFixture();
  const first = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner:local",
  });
  const revisedConfiguration = changedConfiguration();
  revisedConfiguration.refreshMinutes += 1;
  const revised = await configurations.reviseDraft({
    draftId: first.draftId,
    expectedDraftRevision: first.revision,
    expectedStateRevision: 2,
    configuration: revisedConfiguration,
    proposedBy: "owner:local",
  });

  const authority = await configurations.readAuthoritySnapshot();
  assert.equal(authority.revision, 3);
  assert.equal(authority.activeVersion, 1);
  assert.equal(authority.versions.length, 1);
  assert.equal("configuration" in authority.versions[0], false);
  assert.deepEqual(
    authority.draftRevisions.map((draft) => draft.draftRevisionId),
    [revised.draftRevisionId],
  );
  assert.equal("configuration" in authority.draftRevisions[0], false);
  assert.equal("audit" in authority, false);
  assert.equal("projectionOutbox" in authority, false);
  assert.equal(Object.isFrozen(authority), true);

  const controlPlane = await configurations.readControlPlaneSnapshot({
    versionLimit: 1,
    auditLimit: 2,
  });
  assert.equal(controlPlane.versions.length, 1);
  assert.equal("configuration" in controlPlane.versions[0], false);
  assert.equal(controlPlane.draftRevisions.length, 1);
  assert.equal("configuration" in controlPlane.draftRevisions[0], false);
  assert.deepEqual(controlPlane.editableConfiguration, revisedConfiguration);
  assert.deepEqual(controlPlane.audit.map((entry) => entry.sequence), [2, 3]);
  assert.deepEqual(controlPlane.history, {
    totalVersions: 1,
    totalAuditEntries: 3,
    versionsTruncated: false,
    auditTruncated: true,
  });
  assert.equal("projectionOutbox" in controlPlane, false);
  assert.equal(Object.isFrozen(controlPlane), true);

  await assert.rejects(
    configurations.readControlPlaneSnapshot({ versionLimit: 0 }),
    /versionLimit is invalid/,
  );
  await assert.rejects(
    configurations.readControlPlaneSnapshot({ auditLimit: 0 }),
    /auditLimit is invalid/,
  );
});

test("activation is revision-bound, audited, projected, and idempotent", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "employee:orchestrator",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: draft.revision,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });

  await assert.rejects(
    configurations.activateDraft({
      ...plan,
      documentDigest: "0".repeat(64),
      activatedBy: "owner",
    }),
    assertCode("CONFIGURATION_ACTIVATION_STALE", 409),
  );

  const activated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(activated.applied, true);
  assert.equal(activated.active.version, 2);
  assert.equal(activated.active.source, "draft");
  assert.equal(activated.active.draftRevisionId, draft.draftRevisionId);

  const snapshot = await configurations.readSnapshot();
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.activeVersion, 2);
  assert.equal(snapshot.audit.at(-1).kind, "configuration_activated");
  assert.equal(snapshot.projectionOutbox.length, 2);
  assert.equal(snapshot.projectionOutbox.at(-1).configurationVersion, 2);
  assert.equal(
    snapshot.projectionOutbox.at(-1).configurationDigest,
    activated.active.configurationDigest,
  );

  const reconciliation =
    await configurations.readActivationReconciliationSnapshot({ version: 1 });
  assert.deepEqual(reconciliation.active, {
    version: 2,
    configurationDigest: activated.active.configurationDigest,
  });
  assert.equal(reconciliation.observedVersion.version, 1);
  assert.deepEqual(Object.keys(reconciliation.observedVersion), [
    "version",
    "configurationDigest",
    "source",
    "previousVersion",
    "draftRevisionId",
    "rollbackOf",
    "activatedBy",
    "activatedAt",
    "impactDigest",
  ]);
  assert.equal("configuration" in reconciliation.observedVersion, false);
  assert.equal("draftRevisions" in reconciliation, false);
  assert.equal("audit" in reconciliation, false);
  assert.equal("projectionOutbox" in reconciliation, false);
  assert.equal(Object.isFrozen(reconciliation), true);

  const repeated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, activated.active);
  assert.equal(store.writes.length, 3);
});

test("script asset changes require a higher asset version on draft activation", async () => {
  for (const kind of ["node-script", "windows-test", "windows-build"]) {
  const { configurations } = await readyStore();
  await configurations.importBootstrap({
    configuration: configurationWithReusableTest({ kind }),
    importedBy: "bootstrap-file",
  });
  const unchangedVersion = configurationWithReusableTest({
    kind,
    source: "assert.equal(2 + 2, 4);",
  });
  const draft = await configurations.createDraft({
    configuration: unchangedVersion,
    expectedStateRevision: 1,
    proposedBy: "owner",
  });

  await assert.rejects(
    configurations.prepareDraftActivation({
      draftId: draft.draftId,
      draftRevision: draft.revision,
      expectedStateRevision: 2,
      expectedActiveVersion: 1,
    }),
    assertCode("CONFIGURATION_TEST_ASSET_VERSION_REQUIRED", 409),
  );

  const bumped = configurationWithReusableTest({
    kind,
    version: 2,
    source: "assert.equal(2 + 2, 4);",
  });
  const revised = await configurations.reviseDraft({
    draftId: draft.draftId,
    configuration: bumped,
    expectedStateRevision: 2,
    expectedDraftRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: revised.draftId,
    draftRevision: revised.revision,
    expectedStateRevision: 3,
    expectedActiveVersion: 1,
  });
  const activated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(
    activated.active.configuration.codeExecutor.profiles["reusable-smoke"].asset.version,
    2,
  );
  }
});

test("a draft from an older Active baseline cannot be disguised as a new activation", async () => {
  const { configurations } = await importedFixture();
  const staleDraft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const winningConfiguration = configuration();
  winningConfiguration.refreshMinutes += 1;
  const winningDraft = await configurations.createDraft({
    configuration: winningConfiguration,
    expectedStateRevision: 2,
    proposedBy: "owner",
  });
  const winningPlan = await configurations.prepareDraftActivation({
    draftId: winningDraft.draftId,
    draftRevision: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 1,
  });
  await configurations.activateDraft({ ...winningPlan, activatedBy: "owner" });

  await assert.rejects(
    configurations.prepareDraftActivation({
      draftId: staleDraft.draftId,
      draftRevision: 1,
      expectedStateRevision: 4,
      expectedActiveVersion: 2,
    }),
    assertCode("CONFIGURATION_ACTIVATION_STALE", 409),
  );
});

test("rollback appends a new active version instead of moving the version backward", async () => {
  const { configurations } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const activation = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  await configurations.activateDraft({ ...activation, activatedBy: "owner" });

  const rollback = await configurations.prepareRollback({
    targetVersion: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 2,
  });
  const rolledBack = await configurations.activateRollback({
    ...rollback,
    activatedBy: "owner",
  });

  assert.equal(rolledBack.applied, true);
  assert.equal(rolledBack.active.version, 3);
  assert.equal(rolledBack.active.source, "rollback");
  assert.equal(rolledBack.active.rollbackOf, 1);
  assert.deepEqual(
    rolledBack.active.configuration,
    (await configurations.readVersion({ version: 1 })).configuration,
  );
  assert.equal(
    (await configurations.readSnapshot()).audit.at(-1).kind,
    "configuration_rolled_back",
  );
});

test("a failed write cannot expose a partial active pointer, audit, or outbox", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  const before = await configurations.readSnapshot();
  store.failNextWrite("before");

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
  );
  assert.deepEqual(await configurations.readSnapshot(), before);
  assert.equal(store.value.activeVersion, 1);
  assert.equal(store.value.audit.length, before.audit.length);
  assert.equal(store.value.projectionOutbox.length, before.projectionOutbox.length);
});

test("lost write acknowledgement is recovered as the same activation", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  store.failNextWrite("after");

  const recovered = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(recovered.applied, true);
  assert.equal(recovered.active.version, 2);
  assert.equal((await configurations.readActive()).version, 2);
  assert.equal((await configurations.readSnapshot()).revision, 3);

  const repeated = await configurations.activateDraft({
    ...plan,
    activatedBy: "owner",
  });
  assert.equal(repeated.applied, false);
  assert.deepEqual(repeated.active, recovered.active);
});

test("an unconfirmable write failure closes configuration reads fail-closed", async () => {
  const { configurations, store } = await importedFixture();
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  store.failNextWrite("missing");

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_STATE_WRITE_FAILED", 503),
  );
  await assert.rejects(
    configurations.readActive(),
    assertCode("CONFIGURATION_NOT_READY", 503),
  );
});

test("recovery binds draft and rollback versions to their declared source content", async () => {
  const draftFixture = await importedFixture();
  const draft = await draftFixture.configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const activation = await draftFixture.configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  await draftFixture.configurations.activateDraft({
    ...activation,
    activatedBy: "owner",
  });

  const forgedDraftState = clone(draftFixture.store.value);
  replaceVersionConfiguration(
    forgedDraftState,
    2,
    forgedDraftState.versions[0].configuration,
  );
  await assert.rejects(
    readyStore({ store: new MemoryStore(forgedDraftState) }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const rollback = await draftFixture.configurations.prepareRollback({
    targetVersion: 1,
    expectedStateRevision: 3,
    expectedActiveVersion: 2,
  });
  await draftFixture.configurations.activateRollback({
    ...rollback,
    activatedBy: "owner",
  });
  const forgedRollbackState = clone(draftFixture.store.value);
  replaceVersionConfiguration(
    forgedRollbackState,
    3,
    forgedRollbackState.versions[1].configuration,
  );
  await assert.rejects(
    readyStore({ store: new MemoryStore(forgedRollbackState) }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );
});

test("capacity exhaustion returns 507 without deleting referenced history", async () => {
  const { configurations, store } = await importedFixture({
    limits: { maximumVersions: 1 },
  });
  const draft = await configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner",
  });
  const plan = await configurations.prepareDraftActivation({
    draftId: draft.draftId,
    draftRevision: 1,
    expectedStateRevision: 2,
    expectedActiveVersion: 1,
  });
  const before = clone(store.value);

  await assert.rejects(
    configurations.activateDraft({ ...plan, activatedBy: "owner" }),
    assertCode("CONFIGURATION_CAPACITY_EXCEEDED", 507),
  );
  assert.deepEqual(store.value, before);
});

test("recovery rejects tampering, durable rollback, and same-revision forks", async () => {
  const primary = await importedFixture();
  const pristine = clone(primary.store.value);

  const tamperedStore = new MemoryStore(pristine);
  tamperedStore.value.versions[0].configuration.employees.roles.developer.mission =
    "tampered";
  await assert.rejects(
    readyStore({ store: tamperedStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const forgedAuditStore = new MemoryStore(pristine);
  forgedAuditStore.value.audit[0] = readdress(
    {
      ...forgedAuditStore.value.audit[0],
      kind: "configuration_activated",
    },
    "auditId",
    "configuration-audit",
  );
  await assert.rejects(
    readyStore({ store: forgedAuditStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const partialMigrationStore = new MemoryStore(pristine);
  partialMigrationStore.value.migration.importedBy = null;
  await assert.rejects(
    readyStore({ store: partialMigrationStore }),
    assertCode("CONFIGURATION_STATE_CORRUPTED", 503),
  );

  const forkAStore = new MemoryStore(pristine);
  const forkBStore = new MemoryStore(pristine);
  const forkA = await readyStore({ store: forkAStore });
  const forkB = await readyStore({ store: forkBStore });
  await forkA.configurations.createDraft({
    configuration: changedConfiguration(),
    expectedStateRevision: 1,
    proposedBy: "owner:a",
  });
  const alternate = configuration();
  alternate.employees.roles.tester.mission = "独立验证交付证据并报告风险。";
  await forkB.configurations.createDraft({
    configuration: alternate,
    expectedStateRevision: 1,
    proposedBy: "owner:b",
  });

  forkAStore.value = clone(pristine);
  await assert.rejects(
    forkA.configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 2,
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );

  forkAStore.value = clone(forkBStore.value);
  await assert.rejects(
    forkA.configurations.createDraft({
      configuration: configuration(),
      expectedStateRevision: 2,
      proposedBy: "owner",
    }),
    assertCode("CONFIGURATION_STATE_REVISION_CONFLICT", 409),
  );
});
