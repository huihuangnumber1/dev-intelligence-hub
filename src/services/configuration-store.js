import { createHash, randomUUID } from "node:crypto";
import {
  configurationDocumentImpact,
  createSafeDisabledConfiguration,
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";
import {
  assertConfigurationCapacity,
  cloneFrozenConfigurationValue,
  CONFIGURATION_STATE_KEY,
  ConfigurationStoreError,
  configurationContentDigest,
  configurationImpactDigest,
  configurationStateDigest,
  configurationStoreError,
  DEFAULT_CONFIGURATION_LIMITS,
  emptyConfigurationState,
  identifiedConfigurationRecord,
  migrateConfigurationState,
  normalizeConfigurationLimits,
  normalizeConfigurationState,
} from "./configuration-state.js";

export { CONFIGURATION_STATE_KEY, ConfigurationStoreError };

export const CONFIGURATION_CONTROL_PLANE_LIMITS = Object.freeze({
  versions: 50,
  auditEntries: 100,
});

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WORK_PROPOSAL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;

function invalid(code, message, statusCode = 400) {
  return configurationStoreError(code, message, statusCode);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function boundedText(value, name, maximumBytes = 256, pattern) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_TEXT_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizedTimestamp(clock) {
  const candidate = clock();
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock returned an invalid time");
  return date.toISOString();
}

function assertReusableTestAssetVersions(before, after) {
  const beforeProfiles = before.codeExecutor?.profiles || {};
  const afterProfiles = after.codeExecutor?.profiles || {};
  for (const [profileId, profile] of Object.entries(afterProfiles)) {
    const previous = beforeProfiles[profileId];
    if (!["node-script", "windows-test", "windows-build"].includes(profile?.kind) ||
      !["node-script", "windows-test", "windows-build"].includes(previous?.kind)) {
      continue;
    }
    const changed = ["title", "description", "source"].some(
      (field) => profile.asset[field] !== previous.asset[field],
    );
    if (changed && profile.asset.version <= previous.asset.version) {
      throw invalid(
        "CONFIGURATION_TEST_ASSET_VERSION_REQUIRED",
        `自动化测试脚本 ${profileId} 的正文或说明变更后必须提高资产版本`,
        409,
      );
    }
  }
}

function identifiedVersion(content) {
  return identifiedConfigurationRecord(
    "versionId",
    "configuration-version",
    content,
  );
}

function identifiedDraftRevision(content) {
  return identifiedConfigurationRecord(
    "draftRevisionId",
    "configuration-draft-revision",
    content,
  );
}

function identifiedAudit(content) {
  return identifiedConfigurationRecord(
    "auditId",
    "configuration-audit",
    content,
  );
}

function identifiedOutbox(content) {
  return identifiedConfigurationRecord(
    "outboxId",
    "configuration-outbox",
    content,
  );
}

function auditContent(state, details, actor, occurredAt) {
  return {
    sequence: state.audit.length + 1,
    stateRevision: state.revision + 1,
    kind: details.kind,
    actor,
    occurredAt,
    draftId: details.draftId ?? null,
    draftRevisionId: details.draftRevisionId ?? null,
    configurationVersion: details.configurationVersion ?? null,
    configurationDigest: details.configurationDigest ?? null,
    targetVersion: details.targetVersion ?? null,
    impactDigest: details.impactDigest ?? null,
  };
}

function validationDigest(binding) {
  return configurationContentDigest({
    kind: binding.kind,
    stateRevision: binding.expectedStateRevision,
    activeVersion: binding.expectedActiveVersion,
    activeDigest: binding.activeDigest,
    baselineDigest: binding.baselineDigest ?? null,
    documentDigest: binding.documentDigest,
    draftRevisionId: binding.draftRevisionId ?? null,
    targetVersion: binding.targetVersion ?? null,
  });
}

function exactDigest(value, name) {
  return boundedText(value, name, 64, DIGEST);
}

function sameActivationBinding(actual, request) {
  return (
    actual.draftRevisionId === request.draftRevisionId &&
    actual.configurationDigest === request.documentDigest
  );
}

function sameRollbackBinding(actual, request) {
  return (
    actual.source === "rollback" &&
    actual.rollbackOf === request.targetVersion &&
    actual.previousVersion === request.expectedActiveVersion &&
    actual.configurationDigest === request.targetDigest
  );
}

function projectAuthorityVersion(version) {
  return {
    version: version.version,
    configurationDigest: version.configurationDigest,
  };
}

function projectActivationReconciliationVersion(version) {
  return {
    version: version.version,
    configurationDigest: version.configurationDigest,
    source: version.source,
    previousVersion: version.previousVersion,
    draftRevisionId: version.draftRevisionId,
    rollbackOf: version.rollbackOf,
    activatedBy: version.activatedBy,
    activatedAt: version.activatedAt,
    impactDigest: version.impactDigest,
  };
}

function projectAuthorityDraft(draft) {
  return {
    draftId: draft.draftId,
    draftRevisionId: draft.draftRevisionId,
    baseVersion: draft.baseVersion,
  };
}

function projectControlPlaneVersion(version) {
  return {
    version: version.version,
    configurationDigest: version.configurationDigest,
    source: version.source,
    previousVersion: version.previousVersion,
    draftRevisionId: version.draftRevisionId,
    rollbackOf: version.rollbackOf,
    activatedAt: version.activatedAt,
    impactDigest: version.impactDigest,
  };
}

function projectControlPlaneDraft(draft) {
  return {
    draftId: draft.draftId,
    draftRevisionId: draft.draftRevisionId,
    revision: draft.revision,
    baseVersion: draft.baseVersion,
    configurationDigest: draft.configurationDigest,
    createdAt: draft.createdAt,
  };
}

function projectControlPlaneAudit(entry) {
  return {
    sequence: entry.sequence,
    stateRevision: entry.stateRevision,
    kind: entry.kind,
    actor: entry.actor,
    occurredAt: entry.occurredAt,
    draftId: entry.draftId,
    configurationVersion: entry.configurationVersion,
    targetVersion: entry.targetVersion,
    impactDigest: entry.impactDigest,
  };
}

function headDraftRevisions(state) {
  const revisionIds = new Set(
    state.draftHeads.map((head) => head.draftRevisionId),
  );
  return state.draftRevisions.filter((draft) =>
    revisionIds.has(draft.draftRevisionId)
  );
}

function configurationProposalIdentity({ proposalId, proposalContentDigest }) {
  const id = boundedText(proposalId, "proposalId", 192, WORK_PROPOSAL_ID);
  const contentDigest = exactDigest(
    proposalContentDigest,
    "proposalContentDigest",
  );
  const identityDigest = createHash("sha256")
    .update(`${id}\u0000${contentDigest}`, "utf8")
    .digest("hex");
  return {
    draftId: `configuration-proposal-${identityDigest}`,
    proposedBy: `work-proposal:${contentDigest}`,
  };
}

export class ConfigurationStore {
  constructor({
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    clock = () => new Date(),
    idFactory = () => randomUUID(),
    limits = {},
  } = {}) {
    if (
      !store ||
      typeof store.read !== "function" ||
      typeof store.write !== "function"
    ) {
      throw new TypeError("configuration store requires a durable store");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("configuration store requires an exclusive lease");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("configuration store requires an operation queue");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("configuration store clock and idFactory must be functions");
    }
    this.store = store;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue;
    this.clock = clock;
    this.idFactory = idFactory;
    this.limits = normalizeConfigurationLimits(limits);
    this.state = emptyConfigurationState();
    this.ready = false;
    this.recoveryPromise = null;
  }

  async recover() {
    if (this.ready) return this.readSnapshot();
    this.recoveryPromise ||= this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
          this.ready = true;
          return this.readSnapshot();
        } catch (error) {
          this.ready = false;
          if (error instanceof ConfigurationStoreError) throw error;
          throw configurationStoreError(
            "CONFIGURATION_STATE_CORRUPTED",
            "无法恢复版本化配置状态",
            503,
            error,
          );
        }
      }),
    );
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async readSnapshot() {
    this.#assertReady();
    return cloneFrozenConfigurationValue(this.state);
  }

  async readAuthoritySnapshot() {
    this.#assertReady();
    const { active, drafts } = this.#projectionContext();
    return cloneFrozenConfigurationValue({
      revision: this.state.revision,
      activeVersion: this.state.activeVersion,
      versions: active ? [projectAuthorityVersion(active)] : [],
      draftHeads: this.state.draftHeads,
      draftRevisions: drafts.map(projectAuthorityDraft),
    });
  }

  async readActivationReconciliationSnapshot({ version } = {}) {
    this.#assertReady();
    const expectedVersion = integer(version, "version", 1);
    const active = this.#activeVersion();
    const observedVersion = this.state.versions[expectedVersion - 1] ?? null;
    return cloneFrozenConfigurationValue({
      revision: this.state.revision,
      activeVersion: this.state.activeVersion,
      active: active ? projectAuthorityVersion(active) : null,
      observedVersion: observedVersion
        ? projectActivationReconciliationVersion(observedVersion)
        : null,
    });
  }

  async readControlPlaneSnapshot({
    versionLimit = CONFIGURATION_CONTROL_PLANE_LIMITS.versions,
    auditLimit = CONFIGURATION_CONTROL_PLANE_LIMITS.auditEntries,
  } = {}) {
    this.#assertReady();
    const boundedVersionLimit = integer(
      versionLimit,
      "versionLimit",
      1,
    );
    const boundedAuditLimit = integer(
      auditLimit,
      "auditLimit",
      1,
    );
    const { active, drafts } = this.#projectionContext();
    const editableDraft = drafts.findLast(
      (draft) => draft.baseVersion === (this.state.activeVersion ?? 0),
    );
    return cloneFrozenConfigurationValue({
      revision: this.state.revision,
      activeVersion: this.state.activeVersion,
      versions: this.state.versions
        .slice(-boundedVersionLimit)
        .map(projectControlPlaneVersion),
      draftRevisions: drafts.map(projectControlPlaneDraft),
      audit: this.state.audit
        .slice(-boundedAuditLimit)
        .map(projectControlPlaneAudit),
      editableConfiguration:
        editableDraft?.configuration ?? active?.configuration ?? null,
      history: {
        totalVersions: this.state.versions.length,
        totalAuditEntries: this.state.audit.length,
        versionsTruncated: this.state.versions.length > boundedVersionLimit,
        auditTruncated: this.state.audit.length > boundedAuditLimit,
      },
    });
  }

  async readActive() {
    this.#assertReady();
    return cloneFrozenConfigurationValue(this.#activeVersion());
  }

  async readVersion({ version } = {}) {
    this.#assertReady();
    const expected = integer(version, "version", 1);
    const entry = this.state.versions.find((candidate) => candidate.version === expected);
    if (!entry) {
      throw invalid("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    }
    return cloneFrozenConfigurationValue(entry);
  }

  async readDraft({ draftId, revision } = {}) {
    this.#assertReady();
    const id = boundedText(draftId, "draftId", 256, SAFE_ID);
    const expectedRevision = integer(revision, "revision", 1);
    const entry = this.state.draftRevisions.find(
      (candidate) =>
        candidate.draftId === id && candidate.revision === expectedRevision,
    );
    if (!entry) {
      throw invalid("CONFIGURATION_DRAFT_NOT_FOUND", "配置草稿修订不存在", 404);
    }
    return cloneFrozenConfigurationValue(entry);
  }

  async readProposalDraft(request = {}) {
    this.#assertReady();
    const identity = configurationProposalIdentity(request);
    const record = this.#proposalDraftRecord(this.state, identity);
    return record === null
      ? null
      : cloneFrozenConfigurationValue(record);
  }

  async importBootstrap({ configuration, importedBy } = {}) {
    const actor = boundedText(importedBy, "importedBy", 128);
    return this.#writeTransaction(async () => {
      const active = this.#activeVersion();
      if (active) {
        return cloneFrozenConfigurationValue({ applied: false, active });
      }
      if (this.state.draftRevisions.length > 0) {
        return cloneFrozenConfigurationValue({ applied: false, active: null });
      }
      const document = normalizeConfigurationDocument(configuration);
      const occurredAt = normalizedTimestamp(this.clock);
      const configurationDigest = configurationContentDigest(document);
      const impactDigest = configurationContentDigest({
        kind: "bootstrap",
        documentDigest: configurationDigest,
      });
      const version = identifiedVersion({
        version: 1,
        configurationDigest,
        configuration: document,
        source: "bootstrap",
        previousVersion: null,
        draftRevisionId: null,
        rollbackOf: null,
        activatedBy: actor,
        activatedAt: occurredAt,
        impactDigest,
      });
      const audit = identifiedAudit(
        auditContent(
          this.state,
          {
            kind: "bootstrap_imported",
            configurationVersion: 1,
            configurationDigest,
            impactDigest,
          },
          actor,
          occurredAt,
        ),
      );
      const outbox = identifiedOutbox({
        sequence: 1,
        configurationVersion: 1,
        configurationDigest,
        previousVersion: null,
        impactDigest,
        createdAt: occurredAt,
      });
      const candidate = {
        ...this.state,
        revision: this.state.revision + 1,
        migration: {
          status: "imported",
          importedAt: occurredAt,
          importedBy: actor,
          sourceDigest: configurationDigest,
        },
        activeVersion: 1,
        versions: [version],
        audit: [audit],
        projectionOutbox: [outbox],
      };
      await this.#persist(candidate);
      return cloneFrozenConfigurationValue({ applied: true, active: version });
    });
  }

  async createDraft({ configuration, expectedStateRevision, proposedBy } = {}) {
    return this.#createDraft({
      configuration,
      expectedStateRevision,
      proposedBy,
      initialization: false,
    });
  }

  async createProposalDraft({
    proposalId,
    proposalContentDigest,
    configuration,
    expectedStateRevision,
  } = {}) {
    const identity = configurationProposalIdentity({
      proposalId,
      proposalContentDigest,
    });
    const document = normalizeConfigurationDocument(configuration);
    const expected = integer(expectedStateRevision, "expectedStateRevision");
    return this.#writeTransaction(async () => {
      const existing = this.#proposalDraftRecord(this.state, identity);
      if (existing !== null) {
        if (
          existing.draft.configurationDigest !==
          configurationContentDigest(document)
        ) {
          throw invalid(
            "CONFIGURATION_PROPOSAL_BINDING_CONFLICT",
            "同一配置提案身份对应了不同文档",
            409,
          );
        }
        return cloneFrozenConfigurationValue(existing);
      }
      this.#assertStateRevision(expected);
      const active = this.#requireActive();
      const draftId = identity.draftId;
      if (this.state.draftHeads.some((head) => head.draftId === draftId)) {
        throw invalid(
          "CONFIGURATION_DRAFT_ID_CONFLICT",
          "配置提案草稿 ID 已绑定其他来源",
          409,
        );
      }
      const occurredAt = normalizedTimestamp(this.clock);
      const draft = identifiedDraftRevision({
        draftId,
        revision: 1,
        baseVersion: active.version,
        configurationDigest: configurationContentDigest(document),
        configuration: document,
        proposedBy: identity.proposedBy,
        createdAt: occurredAt,
        supersedesRevisionId: null,
      });
      const audit = identifiedAudit(
        auditContent(
          this.state,
          {
            kind: "draft_created",
            draftId,
            draftRevisionId: draft.draftRevisionId,
          },
          identity.proposedBy,
          occurredAt,
        ),
      );
      const candidate = {
        ...this.state,
        revision: this.state.revision + 1,
        draftRevisions: [...this.state.draftRevisions, draft],
        draftHeads: [
          ...this.state.draftHeads,
          { draftId, revision: 1, draftRevisionId: draft.draftRevisionId },
        ],
        audit: [...this.state.audit, audit],
      };
      await this.#persist(candidate);
      return cloneFrozenConfigurationValue({
        draft,
        createdStateRevision: candidate.revision,
        currentHead: true,
      });
    });
  }

  async createInitializationDraft({
    configuration,
    expectedStateRevision,
    proposedBy,
  } = {}) {
    return this.#createDraft({
      configuration,
      expectedStateRevision,
      proposedBy,
      initialization: true,
    });
  }

  async #createDraft({
    configuration,
    expectedStateRevision,
    proposedBy,
    initialization,
  }) {
    const document = normalizeConfigurationDocument(configuration);
    const expected = integer(expectedStateRevision, "expectedStateRevision");
    const actor = boundedText(proposedBy, "proposedBy", 128);
    return this.#writeTransaction(async () => {
      this.#assertStateRevision(expected);
      const active = this.#activeVersion();
      if (initialization && active !== null) {
        throw invalid(
          "CONFIGURATION_INITIALIZATION_STALE",
          "版本化配置已经完成初始化",
          409,
        );
      }
      if (!initialization && active === null) {
        this.#requireActive();
      }
      const draftId = boundedText(this.idFactory(), "draftId", 256, SAFE_ID);
      if (this.state.draftHeads.some((head) => head.draftId === draftId)) {
        throw invalid("CONFIGURATION_DRAFT_ID_CONFLICT", "配置草稿 ID 已存在", 409);
      }
      const occurredAt = normalizedTimestamp(this.clock);
      const draft = identifiedDraftRevision({
        draftId,
        revision: 1,
        baseVersion: active?.version ?? 0,
        configurationDigest: configurationContentDigest(document),
        configuration: document,
        proposedBy: actor,
        createdAt: occurredAt,
        supersedesRevisionId: null,
      });
      const audit = identifiedAudit(
        auditContent(
          this.state,
          {
            kind: "draft_created",
            draftId,
            draftRevisionId: draft.draftRevisionId,
          },
          actor,
          occurredAt,
        ),
      );
      const candidate = {
        ...this.state,
        revision: this.state.revision + 1,
        draftRevisions: [...this.state.draftRevisions, draft],
        draftHeads: [
          ...this.state.draftHeads,
          { draftId, revision: 1, draftRevisionId: draft.draftRevisionId },
        ],
        audit: [...this.state.audit, audit],
      };
      await this.#persist(candidate);
      return cloneFrozenConfigurationValue(draft);
    });
  }

  async reviseDraft({
    draftId,
    expectedDraftRevision,
    expectedStateRevision,
    configuration,
    proposedBy,
  } = {}) {
    const id = boundedText(draftId, "draftId", 256, SAFE_ID);
    const expectedDraft = integer(expectedDraftRevision, "expectedDraftRevision", 1);
    const expectedState = integer(expectedStateRevision, "expectedStateRevision");
    const document = normalizeConfigurationDocument(configuration);
    const actor = boundedText(proposedBy, "proposedBy", 128);
    return this.#writeTransaction(async () => {
      this.#assertStateRevision(expectedState);
      const headIndex = this.state.draftHeads.findIndex((head) => head.draftId === id);
      const head = this.state.draftHeads[headIndex];
      if (!head) {
        throw invalid("CONFIGURATION_DRAFT_NOT_FOUND", "配置草稿不存在", 404);
      }
      if (head.revision !== expectedDraft) {
        throw invalid(
          "CONFIGURATION_DRAFT_REVISION_CONFLICT",
          "配置草稿已有新修订",
          409,
        );
      }
      const previous = this.state.draftRevisions.find(
        (entry) => entry.draftRevisionId === head.draftRevisionId,
      );
      if (previous.baseVersion === 0 && this.#activeVersion() !== null) {
        throw invalid(
          "CONFIGURATION_INITIALIZATION_STALE",
          "初始化草稿已被活动配置取代",
          409,
        );
      }
      const occurredAt = normalizedTimestamp(this.clock);
      const draft = identifiedDraftRevision({
        draftId: id,
        revision: head.revision + 1,
        baseVersion: previous.baseVersion,
        configurationDigest: configurationContentDigest(document),
        configuration: document,
        proposedBy: actor,
        createdAt: occurredAt,
        supersedesRevisionId: previous.draftRevisionId,
      });
      const heads = [...this.state.draftHeads];
      heads[headIndex] = {
        draftId: id,
        revision: draft.revision,
        draftRevisionId: draft.draftRevisionId,
      };
      const audit = identifiedAudit(
        auditContent(
          this.state,
          {
            kind: "draft_revised",
            draftId: id,
            draftRevisionId: draft.draftRevisionId,
          },
          actor,
          occurredAt,
        ),
      );
      const candidate = {
        ...this.state,
        revision: this.state.revision + 1,
        draftRevisions: [...this.state.draftRevisions, draft],
        draftHeads: heads,
        audit: [...this.state.audit, audit],
      };
      await this.#persist(candidate);
      return cloneFrozenConfigurationValue(draft);
    });
  }

  async prepareDraftActivation(request = {}) {
    this.#assertReady();
    return cloneFrozenConfigurationValue(
      this.#prepareDraftActivation(this.state, request),
    );
  }

  async prepareProposalDraftActivation(request = {}) {
    this.#assertReady();
    const identity = configurationProposalIdentity(request);
    const record = this.#proposalDraftRecord(this.state, identity);
    if (record === null) {
      throw invalid(
        "CONFIGURATION_DRAFT_NOT_FOUND",
        "配置提案草稿不存在",
        404,
      );
    }
    const active = this.state.versions.find(
      (entry) => entry.version === record.draft.baseVersion,
    );
    if (!active) {
      throw invalid(
        "CONFIGURATION_STATE_CORRUPTED",
        "配置提案引用的活动版本不存在",
        503,
      );
    }
    const prepared = this.#draftActivationPlan({
      draft: record.draft,
      active,
      expectedStateRevision: record.createdStateRevision,
      expectedActiveVersion: record.draft.baseVersion,
    });
    return cloneFrozenConfigurationValue({
      prepared,
      current:
        record.currentHead &&
        this.state.revision === record.createdStateRevision &&
        this.state.activeVersion === record.draft.baseVersion,
    });
  }

  async prepareInitialization(request = {}) {
    this.#assertReady();
    return cloneFrozenConfigurationValue(
      this.#prepareInitialization(this.state, request),
    );
  }

  async activateInitialization(request = {}) {
    const activatedBy = boundedText(request.activatedBy, "activatedBy", 128);
    this.#validateInitializationRequest(request);
    return this.#writeTransaction(async () => {
      const active = this.#activeVersion();
      if (
        active?.source === "initialization" &&
        sameActivationBinding(active, request)
      ) {
        return cloneFrozenConfigurationValue({ applied: false, active });
      }
      if (active) {
        throw invalid(
          "CONFIGURATION_INITIALIZATION_STALE",
          "版本化配置已经完成初始化",
          409,
        );
      }
      let prepared;
      try {
        prepared = this.#prepareInitialization(this.state, request);
      } catch (error) {
        if (error?.statusCode === 409) {
          throw invalid(
            "CONFIGURATION_INITIALIZATION_STALE",
            "配置初始化绑定已过期",
            409,
          );
        }
        throw error;
      }
      this.#assertPreparedBinding(prepared, request, [
        "kind",
        "expectedActiveVersion",
        "activeDigest",
        "baselineDigest",
        "draftRevisionId",
        "documentDigest",
        "validationDigest",
        "impactDigest",
      ]);
      const version = await this.#appendInitializationVersion({
        configuration:
          this.#draftByRevisionId(prepared.draftRevisionId).configuration,
        draftId: prepared.draftId,
        draftRevisionId: prepared.draftRevisionId,
        activatedBy,
        impactDigest: prepared.impactDigest,
      });
      return cloneFrozenConfigurationValue({ applied: true, active: version });
    });
  }

  async activateDraft(request = {}) {
    const activatedBy = boundedText(request.activatedBy, "activatedBy", 128);
    this.#validateDraftActivationRequest(request);
    return this.#writeTransaction(async () => {
      const active = this.#activeVersion();
      if (active?.source === "draft" && sameActivationBinding(active, request)) {
        return cloneFrozenConfigurationValue({ applied: false, active });
      }
      let prepared;
      try {
        prepared = this.#prepareDraftActivation(this.state, request);
      } catch (error) {
        if (error?.statusCode === 409) {
          throw invalid(
            "CONFIGURATION_ACTIVATION_STALE",
            "配置激活绑定已过期",
            409,
          );
        }
        throw error;
      }
      this.#assertPreparedBinding(prepared, request, [
        "draftRevisionId",
        "documentDigest",
        "validationDigest",
        "impactDigest",
      ]);
      const version = await this.#appendVersion({
        source: "draft",
        configuration: this.#draftByRevisionId(prepared.draftRevisionId).configuration,
        draftRevisionId: prepared.draftRevisionId,
        rollbackOf: null,
        activatedBy,
        impactDigest: prepared.impactDigest,
        auditKind: "configuration_activated",
        draftId: prepared.draftId,
        targetVersion: null,
      });
      return cloneFrozenConfigurationValue({ applied: true, active: version });
    });
  }

  async prepareRollback(request = {}) {
    this.#assertReady();
    return cloneFrozenConfigurationValue(this.#prepareRollback(this.state, request));
  }

  async activateRollback(request = {}) {
    const activatedBy = boundedText(request.activatedBy, "activatedBy", 128);
    this.#validateRollbackRequest(request);
    return this.#writeTransaction(async () => {
      const active = this.#activeVersion();
      if (active && sameRollbackBinding(active, request)) {
        return cloneFrozenConfigurationValue({ applied: false, active });
      }
      let prepared;
      try {
        prepared = this.#prepareRollback(this.state, request);
      } catch (error) {
        if (error?.statusCode === 409) {
          throw invalid(
            "CONFIGURATION_ACTIVATION_STALE",
            "配置回滚绑定已过期",
            409,
          );
        }
        throw error;
      }
      this.#assertPreparedBinding(prepared, request, [
        "targetDigest",
        "validationDigest",
        "impactDigest",
      ]);
      const target = this.#version(prepared.targetVersion);
      const version = await this.#appendVersion({
        source: "rollback",
        configuration: target.configuration,
        draftRevisionId: null,
        rollbackOf: target.version,
        activatedBy,
        impactDigest: prepared.impactDigest,
        auditKind: "configuration_rolled_back",
        draftId: null,
        targetVersion: target.version,
      });
      return cloneFrozenConfigurationValue({ applied: true, active: version });
    });
  }

  async readProjectionBatch({ afterSequence = 0, limit = 100 } = {}) {
    this.#assertReady();
    const cursor = integer(afterSequence, "afterSequence");
    const pageSize = integer(limit, "limit", 1, 100);
    if (cursor > this.state.projectionOutbox.length) {
      throw invalid("CONFIGURATION_OUTBOX_CURSOR_INVALID", "配置投影游标无效", 409);
    }
    const items = this.state.projectionOutbox.slice(cursor, cursor + pageSize);
    return cloneFrozenConfigurationValue({
      highWatermark: this.state.projectionOutbox.length,
      nextSequence: items.at(-1)?.sequence ?? cursor,
      items,
    });
  }

  #prepareInitialization(state, request) {
    const draftId = boundedText(request.draftId, "draftId", 256, SAFE_ID);
    const draftRevision = integer(request.draftRevision, "draftRevision", 1);
    const expectedStateRevision = integer(
      request.expectedStateRevision,
      "expectedStateRevision",
    );
    this.#assertExpectedAuthority(state, expectedStateRevision, null);
    const head = state.draftHeads.find((entry) => entry.draftId === draftId);
    if (!head) {
      throw invalid("CONFIGURATION_DRAFT_NOT_FOUND", "配置草稿不存在", 404);
    }
    if (head.revision !== draftRevision) {
      throw invalid(
        "CONFIGURATION_DRAFT_REVISION_CONFLICT",
        "只能使用初始化草稿的最新修订",
        409,
      );
    }
    const draft = state.draftRevisions.find(
      (entry) => entry.draftRevisionId === head.draftRevisionId,
    );
    if (draft.baseVersion !== 0) {
      throw invalid(
        "CONFIGURATION_INITIALIZATION_STALE",
        "草稿不是初始化草稿",
        409,
      );
    }
    const impact = configurationDocumentImpact(
      createSafeDisabledConfiguration(draft.configuration),
      draft.configuration,
    );
    const binding = {
      kind: "configuration.initialize",
      expectedStateRevision,
      expectedActiveVersion: null,
      activeDigest: null,
      baselineDigest: impact.beforeDigest,
      draftId,
      draftRevision,
      draftRevisionId: draft.draftRevisionId,
      documentDigest: draft.configurationDigest,
    };
    return {
      ...binding,
      validationDigest: validationDigest(binding),
      impactDigest: configurationImpactDigest(impact),
      impact,
    };
  }

  #prepareDraftActivation(state, request) {
    const draftId = boundedText(request.draftId, "draftId", 256, SAFE_ID);
    const draftRevision = integer(request.draftRevision, "draftRevision", 1);
    const expectedStateRevision = integer(
      request.expectedStateRevision,
      "expectedStateRevision",
    );
    const expectedActiveVersion = integer(
      request.expectedActiveVersion,
      "expectedActiveVersion",
      1,
    );
    this.#assertExpectedAuthority(state, expectedStateRevision, expectedActiveVersion);
    const head = state.draftHeads.find((entry) => entry.draftId === draftId);
    if (!head) throw invalid("CONFIGURATION_DRAFT_NOT_FOUND", "配置草稿不存在", 404);
    if (head.revision !== draftRevision) {
      throw invalid(
        "CONFIGURATION_DRAFT_REVISION_CONFLICT",
        "只能激活草稿的最新修订",
        409,
      );
    }
    const draft = state.draftRevisions.find(
      (entry) => entry.draftRevisionId === head.draftRevisionId,
    );
    if (draft.baseVersion !== expectedActiveVersion) {
      throw invalid(
        "CONFIGURATION_ACTIVATION_STALE",
        "配置草稿基于旧活动版本",
        409,
      );
    }
    const active = this.#activeVersion(state);
    return this.#draftActivationPlan({
      draft,
      active,
      expectedStateRevision,
      expectedActiveVersion,
    });
  }

  #draftActivationPlan({
    draft,
    active,
    expectedStateRevision,
    expectedActiveVersion,
  }) {
    assertReusableTestAssetVersions(active.configuration, draft.configuration);
    const impact = configurationDocumentImpact(
      active.configuration,
      draft.configuration,
    );
    const binding = {
      kind: "configuration.activate",
      expectedStateRevision,
      expectedActiveVersion,
      activeDigest: active.configurationDigest,
      draftId: draft.draftId,
      draftRevision: draft.revision,
      draftRevisionId: draft.draftRevisionId,
      documentDigest: draft.configurationDigest,
    };
    return {
      ...binding,
      validationDigest: validationDigest(binding),
      impactDigest: configurationImpactDigest(impact),
      impact,
    };
  }

  #prepareRollback(state, request) {
    const targetVersion = integer(request.targetVersion, "targetVersion", 1);
    const expectedStateRevision = integer(
      request.expectedStateRevision,
      "expectedStateRevision",
    );
    const expectedActiveVersion = integer(
      request.expectedActiveVersion,
      "expectedActiveVersion",
      1,
    );
    this.#assertExpectedAuthority(state, expectedStateRevision, expectedActiveVersion);
    if (targetVersion === expectedActiveVersion) {
      throw invalid("CONFIGURATION_ROLLBACK_INVALID", "目标版本已经激活", 409);
    }
    const target = this.#version(targetVersion, state);
    const active = this.#activeVersion(state);
    const impact = configurationDocumentImpact(
      active.configuration,
      target.configuration,
    );
    const binding = {
      kind: "configuration.rollback",
      expectedStateRevision,
      expectedActiveVersion,
      activeDigest: active.configurationDigest,
      targetVersion,
      targetDigest: target.configurationDigest,
      documentDigest: target.configurationDigest,
    };
    return {
      ...binding,
      validationDigest: validationDigest(binding),
      impactDigest: configurationImpactDigest(impact),
      impact,
    };
  }

  async #appendVersion({
    source,
    configuration,
    draftRevisionId,
    rollbackOf,
    activatedBy,
    impactDigest,
    auditKind,
    draftId,
    targetVersion,
  }) {
    const previous = this.#requireActive();
    const occurredAt = normalizedTimestamp(this.clock);
    const versionNumber = previous.version + 1;
    const configurationDigest = configurationContentDigest(configuration);
    const version = identifiedVersion({
      version: versionNumber,
      configurationDigest,
      configuration,
      source,
      previousVersion: previous.version,
      draftRevisionId,
      rollbackOf,
      activatedBy,
      activatedAt: occurredAt,
      impactDigest,
    });
    const audit = identifiedAudit(
      auditContent(
        this.state,
        {
          kind: auditKind,
          draftId,
          draftRevisionId,
          configurationVersion: versionNumber,
          configurationDigest,
          targetVersion,
          impactDigest,
        },
        activatedBy,
        occurredAt,
      ),
    );
    const outbox = identifiedOutbox({
      sequence: this.state.projectionOutbox.length + 1,
      configurationVersion: versionNumber,
      configurationDigest,
      previousVersion: previous.version,
      impactDigest,
      createdAt: occurredAt,
    });
    const candidate = {
      ...this.state,
      revision: this.state.revision + 1,
      activeVersion: versionNumber,
      versions: [...this.state.versions, version],
      audit: [...this.state.audit, audit],
      projectionOutbox: [...this.state.projectionOutbox, outbox],
    };
    await this.#persist(candidate);
    return version;
  }

  async #appendInitializationVersion({
    configuration,
    draftId,
    draftRevisionId,
    activatedBy,
    impactDigest,
  }) {
    if (this.state.activeVersion !== null || this.state.versions.length !== 0) {
      throw invalid(
        "CONFIGURATION_INITIALIZATION_STALE",
        "版本化配置已经完成初始化",
        409,
      );
    }
    const occurredAt = normalizedTimestamp(this.clock);
    const configurationDigest = configurationContentDigest(configuration);
    const version = identifiedVersion({
      version: 1,
      configurationDigest,
      configuration,
      source: "initialization",
      previousVersion: null,
      draftRevisionId,
      rollbackOf: null,
      activatedBy,
      activatedAt: occurredAt,
      impactDigest,
    });
    const audit = identifiedAudit(
      auditContent(
        this.state,
        {
          kind: "configuration_initialized",
          draftId,
          draftRevisionId,
          configurationVersion: 1,
          configurationDigest,
          impactDigest,
        },
        activatedBy,
        occurredAt,
      ),
    );
    const outbox = identifiedOutbox({
      sequence: 1,
      configurationVersion: 1,
      configurationDigest,
      previousVersion: null,
      impactDigest,
      createdAt: occurredAt,
    });
    const candidate = {
      ...this.state,
      revision: this.state.revision + 1,
      migration: {
        status: "imported",
        importedAt: occurredAt,
        importedBy: activatedBy,
        sourceDigest: configurationDigest,
      },
      activeVersion: 1,
      versions: [version],
      audit: [...this.state.audit, audit],
      projectionOutbox: [outbox],
    };
    await this.#persist(candidate);
    return version;
  }

  #validateInitializationRequest(request) {
    if (
      request.kind !== "configuration.initialize" ||
      request.expectedActiveVersion !== null ||
      request.activeDigest !== null
    ) {
      throw new TypeError("configuration initialization binding is invalid");
    }
    boundedText(request.draftId, "draftId", 256, SAFE_ID);
    integer(request.draftRevision, "draftRevision", 1);
    integer(request.expectedStateRevision, "expectedStateRevision");
    boundedText(request.draftRevisionId, "draftRevisionId", 160);
    exactDigest(request.documentDigest, "documentDigest");
    exactDigest(request.baselineDigest, "baselineDigest");
    exactDigest(request.validationDigest, "validationDigest");
    exactDigest(request.impactDigest, "impactDigest");
  }

  #validateDraftActivationRequest(request) {
    boundedText(request.draftId, "draftId", 256, SAFE_ID);
    integer(request.draftRevision, "draftRevision", 1);
    integer(request.expectedStateRevision, "expectedStateRevision");
    integer(request.expectedActiveVersion, "expectedActiveVersion", 1);
    boundedText(request.draftRevisionId, "draftRevisionId", 160);
    exactDigest(request.documentDigest, "documentDigest");
    exactDigest(request.validationDigest, "validationDigest");
    exactDigest(request.impactDigest, "impactDigest");
  }

  #validateRollbackRequest(request) {
    integer(request.targetVersion, "targetVersion", 1);
    integer(request.expectedStateRevision, "expectedStateRevision");
    integer(request.expectedActiveVersion, "expectedActiveVersion", 1);
    exactDigest(request.targetDigest, "targetDigest");
    exactDigest(request.validationDigest, "validationDigest");
    exactDigest(request.impactDigest, "impactDigest");
  }

  #assertPreparedBinding(prepared, request, names) {
    if (names.some((name) => prepared[name] !== request[name])) {
      throw invalid(
        "CONFIGURATION_ACTIVATION_STALE",
        "配置激活摘要绑定不一致",
        409,
      );
    }
  }

  #assertExpectedAuthority(state, expectedStateRevision, expectedActiveVersion) {
    if (
      state.revision !== expectedStateRevision ||
      state.activeVersion !== expectedActiveVersion
    ) {
      throw invalid(
        "CONFIGURATION_STATE_REVISION_CONFLICT",
        "配置状态或激活版本已更新",
        409,
      );
    }
  }

  #assertStateRevision(expected) {
    if (this.state.revision !== expected) {
      throw invalid(
        "CONFIGURATION_STATE_REVISION_CONFLICT",
        "配置状态已更新，请重新读取",
        409,
      );
    }
  }

  #proposalDraftRecord(state, identity) {
    const draft = state.draftRevisions.find(
      (entry) => entry.draftId === identity.draftId && entry.revision === 1,
    );
    const head = state.draftHeads.find(
      (entry) => entry.draftId === identity.draftId,
    );
    if (!draft && !head) return null;
    if (!draft || !head || draft.proposedBy !== identity.proposedBy) {
      throw invalid(
        "CONFIGURATION_DRAFT_ID_CONFLICT",
        "配置提案草稿 ID 已绑定其他来源",
        409,
      );
    }
    const creation = state.audit.find(
      (entry) =>
        entry.kind === "draft_created" &&
        entry.draftRevisionId === draft.draftRevisionId &&
        entry.actor === identity.proposedBy,
    );
    if (!creation) {
      throw invalid(
        "CONFIGURATION_STATE_CORRUPTED",
        "配置提案草稿缺少创建审计",
        503,
      );
    }
    return {
      draft,
      createdStateRevision: creation.stateRevision,
      currentHead:
        head.revision === draft.revision &&
        head.draftRevisionId === draft.draftRevisionId,
    };
  }

  #draftByRevisionId(draftRevisionId) {
    return this.state.draftRevisions.find(
      (entry) => entry.draftRevisionId === draftRevisionId,
    );
  }

  #version(version, state = this.state) {
    const entry = state.versions.find((candidate) => candidate.version === version);
    if (!entry) {
      throw invalid("CONFIGURATION_VERSION_NOT_FOUND", "配置版本不存在", 404);
    }
    return entry;
  }

  #activeVersion(state = this.state) {
    return state.activeVersion === null
      ? null
      : state.versions.find((entry) => entry.version === state.activeVersion) || null;
  }

  #requireActive() {
    const active = this.#activeVersion();
    if (!active) {
      throw invalid(
        "CONFIGURATION_BOOTSTRAP_REQUIRED",
        "版本化配置尚未完成初始导入",
        409,
      );
    }
    return active;
  }

  async #persist(candidate) {
    if (candidate.revision !== this.state.revision + 1) {
      throw invalid(
        "CONFIGURATION_STATE_REVISION_CONFLICT",
        "配置状态修订发生冲突",
        409,
      );
    }
    assertConfigurationCapacity(candidate, this.limits);
    let normalized;
    try {
      normalized = normalizeConfigurationState(candidate, this.limits);
    } catch (error) {
      if (error instanceof ConfigurationStoreError) throw error;
      throw configurationStoreError(
        "CONFIGURATION_STATE_CORRUPTED",
        "拒绝写入不一致的配置状态",
        503,
        error,
      );
    }
    try {
      await this.store.write(CONFIGURATION_STATE_KEY, normalized);
    } catch (cause) {
      const reconciled = await this.#reconcileWriteFailure(normalized);
      if (reconciled) return;
      throw configurationStoreError(
        "CONFIGURATION_STATE_WRITE_FAILED",
        "无法持久化版本化配置状态",
        503,
        cause,
      );
    }
    this.state = normalized;
  }

  async #reconcileWriteFailure(candidate) {
    let durable;
    try {
      const stored = await this.store.read(CONFIGURATION_STATE_KEY, null);
      if (stored === null) {
        if (this.state.revision !== 0) this.ready = false;
        return false;
      }
      durable = normalizeConfigurationState(stored, this.limits);
    } catch {
      this.ready = false;
      return false;
    }
    const durableDigest = configurationStateDigest(durable);
    if (durableDigest === configurationStateDigest(candidate)) {
      this.state = durable;
      return true;
    }
    if (durableDigest !== configurationStateDigest(this.state)) {
      this.ready = false;
    }
    return false;
  }

  async #readDurableState() {
    const stored = await this.store.read(CONFIGURATION_STATE_KEY, null);
    if (stored === null) {
      if (this.ready && this.state.revision !== 0) {
        throw configurationStoreError(
          "CONFIGURATION_STATE_CORRUPTED",
          "持久化配置状态意外消失",
          503,
        );
      }
      return emptyConfigurationState();
    }
    const recovered = migrateConfigurationState(stored, this.limits);
    if (recovered.migratedFrom !== null && this.ready) {
      throw invalid(
        "CONFIGURATION_STATE_REVISION_CONFLICT",
        "持久化配置状态回退到旧版结构",
        409,
      );
    }
    const durable = recovered.migratedFrom === null
      ? recovered.state
      : await this.#persistSchemaMigration(recovered.state);
    if (
      this.ready &&
      (durable.revision < this.state.revision ||
        (durable.revision === this.state.revision &&
          configurationStateDigest(durable) !== configurationStateDigest(this.state)))
    ) {
      throw invalid(
        "CONFIGURATION_STATE_REVISION_CONFLICT",
        "持久化配置状态发生回退或同修订分叉",
        409,
      );
    }
    return durable;
  }

  async #persistSchemaMigration(candidate) {
    assertConfigurationCapacity(candidate, this.limits);
    try {
      await this.store.write(CONFIGURATION_STATE_KEY, candidate);
      return candidate;
    } catch (cause) {
      try {
        const stored = await this.store.read(CONFIGURATION_STATE_KEY, null);
        if (stored !== null) {
          const durable = normalizeConfigurationState(stored, this.limits);
          if (
            configurationStateDigest(durable) ===
            configurationStateDigest(candidate)
          ) {
            return durable;
          }
        }
      } catch {
        // Only the exact upgraded state can prove a lost acknowledgement.
      }
      throw configurationStoreError(
        "CONFIGURATION_STATE_MIGRATION_FAILED",
        "无法原子升级版本化配置状态，旧状态保持不变",
        503,
        cause,
      );
    }
  }

  #writeTransaction(operation) {
    this.#assertReady();
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        try {
          this.state = await this.#readDurableState();
        } catch (error) {
          if (error instanceof ConfigurationStoreError) throw error;
          throw configurationStoreError(
            "CONFIGURATION_STATE_CORRUPTED",
            "无法重读版本化配置状态",
            503,
            error,
          );
        }
        return operation();
      }),
    );
  }

  #projectionContext() {
    return {
      active: this.#activeVersion(),
      drafts: headDraftRevisions(this.state),
    };
  }

  #assertReady() {
    if (!this.ready) {
      throw invalid(
        "CONFIGURATION_NOT_READY",
        "版本化配置状态尚未恢复",
        503,
      );
    }
  }
}

export { DEFAULT_CONFIGURATION_LIMITS };
