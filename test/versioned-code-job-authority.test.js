import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  configurationDocumentDigest,
  normalizeConfigurationDocument,
} from "../src/domain/configuration-contract.js";
import {
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { normalizeBrainConfig } from "../src/services/brain-router.js";
import { canonicalJsonDigest } from "../src/lib/canonical-json-digest.js";
import {
  CodeJobGrantFactory,
  legacyCodeJobBrainDigest,
} from "../src/services/code-job-grant-factory.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import {
  codeJobAuthorityScopeCacheIdentity,
  VersionedCodeJobAuthority,
} from "../src/services/versioned-code-job-authority.js";
import {
  createTestConfiguredBrainRouter,
} from "../src/services/configured-workforce.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);
const IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

function configuration() {
  const value = structuredClone(committedConfiguration);
  value.trackedRepositories = ["acme/repo"];
  value.codeExecutor = {
    enabled: true,
    gitCommand: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: {
        "acme/repo": "D:\\mirrors\\acme-repo.git",
        "acme/other": "D:\\mirrors\\acme-other.git",
      },
      headMirrorsByRepository: {
        "contributor/repo": "D:\\mirrors\\contributor-repo.git",
        "contributor/other": "D:\\mirrors\\contributor-other.git",
      },
    },
    docker: {
      executable: "docker",
      host: "npipe:////./pipe/docker_engine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: ".",
        writablePaths: ["src", "test"],
        excludePaths: [],
      },
      {
        id: "auxiliary",
        sourceRoot: "fixtures/auxiliary",
        writablePaths: ["src"],
        excludePaths: [],
      },
    ],
    profiles: {
      "node-tests": { kind: "node-test", image: IMAGE, timeoutMs: 30_000 },
      "auxiliary-tests": {
        kind: "node-test",
        image: IMAGE,
        timeoutMs: 30_000,
      },
    },
    requiredProfilesByWorkspace: {
      dashboard: ["node-tests"],
      auxiliary: ["auxiliary-tests"],
    },
    brokerLimits: { maxFiles: 1_000, maxWriteBytes: 1_000_000 },
    executorLimits: { maxSessions: 4, maxActionsPerSession: 100 },
    maxArtifactBytes: 16_777_216,
  };
  for (const role of Object.values(value.employees.roles)) {
    role.taskBrain = structuredClone(role.brain);
  }
  value.workCoordination.enabled = true;
  value.workCoordination.policy = {
    ...value.workCoordination.policy,
    version: 7,
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
    workspaceByRepository: { "acme/repo": "dashboard" },
  };
  value.memory.enabled = true;
  return normalizeConfigurationDocument(value);
}

function active(value, version = 1) {
  return {
    version,
    configurationDigest: configurationDocumentDigest(value),
    configuration: value,
  };
}

function executorAuthority({ conflict = false } = {}) {
  return {
    workspaces: [
      {
        id: "dashboard",
        capabilities: [
          "git_head_snapshot",
          ...(conflict ? ["conflict_preparation_snapshot"] : []),
        ],
        writablePaths: ["src", "test"],
        excludePaths: [],
        requiredProfiles: [
          { id: "node-tests", configDigest: "a".repeat(64) },
        ],
        authorityDigest: "d".repeat(64),
      },
      {
        id: "auxiliary",
        capabilities: ["git_head_snapshot"],
        writablePaths: ["src"],
        excludePaths: [],
        requiredProfiles: [
          { id: "auxiliary-tests", configDigest: "b".repeat(64) },
        ],
        authorityDigest: "e".repeat(64),
      },
    ],
  };
}

function historicalScopedAuthorityDigest(configurationValue, scope) {
  const role = configurationValue.employees.roles[scope.roleId];
  const policy = configurationValue.workCoordination.policy;
  const provider = configurationValue.brainProviders[role.brain.provider];
  const workspace = configurationValue.codeExecutor.workspaces.find(
    ({ id }) => id === scope.workspaceId,
  );
  const profileIds = [
    ...(configurationValue.codeExecutor.requiredProfilesByWorkspace?.[
      scope.workspaceId
    ] ?? []),
  ].sort();
  const authorization = {
    policyVersion: policy.version,
    role: {
      prerequisites: {
        executor: {
          enabled: configurationValue.codeExecutor.enabled,
          docker: configurationValue.codeExecutor.docker ?? null,
          brokerLimits: configurationValue.codeExecutor.brokerLimits ?? {},
          executorLimits: configurationValue.codeExecutor.executorLimits ?? {},
          maxArtifactBytes:
            configurationValue.codeExecutor.maxArtifactBytes ?? null,
        },
        workCoordinationEnabled: configurationValue.workCoordination.enabled,
        memoryEnabled: configurationValue.memory.enabled,
      },
      role: {
        enabled: role.enabled,
        allowedIntents: [...role.permissions.allowedIntents].sort(),
        brain: {
          provider: role.brain.provider,
          remoteData: role.brain.remoteData,
        },
        provider: {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv ?? null,
          ...(provider.protocol === undefined
            ? {}
            : { protocol: provider.protocol }),
          ...(provider.responseFormat === undefined
            ? {}
            : { responseFormat: provider.responseFormat }),
          remote: provider.remote ?? null,
        },
      },
      codePolicy: {
        admitted: policy.codeActionRoles.includes(scope.roleId),
        operations: [
          ...(policy.codeOperationsByRole[scope.roleId] ?? []),
        ].sort(),
      },
    },
    repository: {
      tracked: configurationValue.trackedRepositories.includes(scope.repository),
      workspaceId: policy.workspaceByRepository[scope.repository] ?? null,
    },
    executor: {
      workspace: workspace ?? null,
      requiredProfiles: profileIds.map((profileId) => ({
        id: profileId,
        configuration:
          configurationValue.codeExecutor.profiles?.[profileId] ?? null,
      })),
    },
  };
  const authority = {
    epoch: 1,
    fingerprint: canonicalJsonDigest(authorization),
  };
  return canonicalJsonDigest({
    schemaVersion: 1,
    executorAuthorityDigest: scope.executorAuthorityDigest,
    scope: {
      repository: scope.repository,
      workspaceId: scope.workspaceId,
      roleId: scope.roleId,
      operation: scope.operation,
      policyVersion: scope.policyVersion,
    },
    authorization: authority,
  });
}

function legacyConfigurationAuthority(configurationValue) {
  const roles = Object.fromEntries(
    Object.entries(configurationValue.employees.roles).map(([roleId, role]) => [
      roleId,
      {
        enabled: role.enabled,
        allowedIntents: role.permissions.allowedIntents,
        brain: {
          provider: role.brain.provider,
          remoteData: role.brain.remoteData,
        },
      },
    ]),
  );
  const providers = Object.fromEntries(
    Object.entries(configurationValue.brainProviders).map(
      ([providerId, provider]) => [
        providerId,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv ?? null,
          remote: provider.remote ?? null,
        },
      ],
    ),
  );
  return canonicalJsonDigest({
    trackedRepositories: configurationValue.trackedRepositories,
    codeExecutor: configurationValue.codeExecutor,
    workCoordination: {
      enabled: configurationValue.workCoordination.enabled,
      policy: configurationValue.workCoordination.policy,
    },
    memoryEnabled: configurationValue.memory.enabled,
    roles,
    brainProviders: providers,
  });
}

function legacyGrant(configurations) {
  const current = configurations.at(-1);
  let previousDigest = null;
  let authorityDigest = null;
  let authorityEpoch = 0;
  for (const configurationValue of configurations) {
    authorityDigest = legacyConfigurationAuthority(configurationValue);
    if (authorityDigest !== previousDigest) {
      authorityEpoch += 1;
      previousDigest = authorityDigest;
    }
  }
  const policy = current.workCoordination.policy;
  const roleIds = policy.codeActionRoles.filter((roleId) => {
    const role = current.employees.roles[roleId];
    return (
      role?.enabled === true &&
      role.permissions.allowedIntents.includes("propose_code_action")
    );
  });
  const factory = new CodeJobGrantFactory({
    executorAuthority: {
      workspaces: executorAuthority().workspaces.map((workspace) => ({
        ...workspace,
        authorityDigest: canonicalJsonDigest({
          executorAuthorityDigest: workspace.authorityDigest,
          configurationAuthorityDigest: authorityDigest,
          configurationAuthorityEpoch: authorityEpoch,
        }),
      })),
    },
    policyVersion: policy.version,
    workspaceByRepository: policy.workspaceByRepository,
    codeActionRoles: roleIds,
    codeOperationsByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        policy.codeOperationsByRole[roleId],
      ]),
    ),
    taskBrainByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        current.employees.roles[roleId].taskBrain,
      ]),
    ),
    brainProviders: current.brainProviders,
    inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
  });
  const currentGrant = factory.create(proposal(current)).grant;
  const legacyContent = structuredClone(currentGrant);
  legacyContent.brainDigest = legacyCodeJobBrainDigest({
    roleId: "developer",
    brain: current.employees.roles.developer.brain,
    brainProviders: current.brainProviders,
  });
  delete legacyContent.schemaVersion;
  delete legacyContent.brainBindingSchema;
  delete legacyContent.inputBinding;
  delete legacyContent.grantDigest;
  return createCodeJobGrant(legacyContent);
}

function proposal(config, { conflicts = null, operation = "modify" } = {}) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-05T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "Fix race",
      headRefOid: "a".repeat(40),
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/race",
        headRefOid: "a".repeat(40),
      },
      gitTargetAvailable: true,
      state: "open",
    },
  });
  const policy = config.workCoordination.policy;
  const workItemId = `work-item-${"d".repeat(64)}`;
  const inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: event.subject.repository,
    pullRequestNumber: event.subject.number,
    rootItemId: workItemId,
    workKey: `pr-work-${"b".repeat(64)}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: event.payload.headRefOid,
    eventId: event.eventId,
    eventDigest: event.contentDigest,
    inputDigest: "c".repeat(64),
    gitTarget: structuredClone(event.payload.gitTarget),
  };
  const executionSource = conflicts === null
    ? undefined
    : createConflictCodeExecutionSource({
        inputBinding,
        preparationBinding: createConflictPreparationBinding({
          preparation: {
            schemaVersion: 1,
            preparationId: "1".repeat(64),
            status: "conflicted",
            baseCommitOid: inputBinding.gitTarget.baseRefOid,
            headCommitOid: inputBinding.gitTarget.headRefOid,
            mergeBaseOid: "e".repeat(40),
            resultTreeOid: "f".repeat(40),
            conflicts,
            boundaryDigest: "2".repeat(64),
            evidenceDigest: "3".repeat(64),
            resultObjectDigest: "4".repeat(64),
            materialization: "full-tree",
          },
          gitTarget: inputBinding.gitTarget,
        }),
      });
  const bound = createWorkIntentPolicy({
    version: policy.version,
    codeActionRoles: policy.codeActionRoles,
    workspaceByRepository: policy.workspaceByRepository,
    codeOperationsByRole: policy.codeOperationsByRole,
  }).bind({
    context: {
      assignmentId: `workflow-assignment-${"c".repeat(64)}`,
      workItemId,
      roleId: "developer",
      event,
      inputBinding,
      ...(executionSource === undefined ? {} : { executionSource }),
    },
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      operation,
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过"],
      evidence: ["revision 未校验"],
      summary: "创建受控代码任务",
      reason: "需要在隔离副本中验证修复",
    },
  });
  return normalizeBoundWorkProposal({
    proposalId: bound.intentId,
    policyVersion: bound.policyVersion,
    kind: bound.kind,
    requestedBy: bound.requestedBy,
    source: bound.source,
    binding: bound.binding,
    payload: bound.payload,
  });
}

function acceptingInputAuthorityVerifier() {
  return {
    verify(binding) {
      return structuredClone(binding);
    },
  };
}

test("default-denied DingTalk keeps an old task binding verifiable, describable and quiescent without old config rows", async () => {
  let fenced = false;
  const context = fixture({ brainDirectoryFactory: ({ roles }) => ({
    async decide(_input, authorization) { await authorization.beforeGenerate(); return { action: { type: "complete" } }; },
    describe(roleId) { return { model: roles[roleId].taskBrain.model }; },
    async withEntityQuiescence({ roleId }, operation) {
      assert.equal(roleId, "developer");
      fenced = true;
      return { executed: true, result: await operation() };
    },
  }) });
  try {
    const current = (await context.authority.create(proposal(context.startup))).grant;
    const brain = structuredClone(normalizeBrainConfig(context.startup.employees.roles.developer.taskBrain));
    assert.equal(brain.remoteData.dingtalk, false);
    delete brain.remoteData.dingtalk;
    const { grantDigest, ...fields } = current;
    const historical = createCodeJobGrant({ ...fields, brainDigest: digestValue({
      schemaVersion: 2, roleId: "developer", taskBrain: brain,
      provider: context.startup.brainProviders[brain.provider],
    }) });
    assert.notEqual(current.brainDigest, historical.brainDigest);
    assert.deepEqual(await context.authority.verify(historical), historical);
    assert.deepEqual(await context.authority.verify(current), current);
    assert.equal((await context.authority.describe("developer", historical.brainDigest)).model, brain.model);
    assert.deepEqual(await context.authority.withEntityQuiescence({ roleId: "developer",
      brainDigest: historical.brainDigest, entityKey: "github:pull_request:acme/repo#42" },
    async () => { assert.equal(fenced, true); return "held"; }), { executed: true, result: "held" });
    await context.authority.decide({ roleId: "developer" }, {
      brainDigest: historical.brainDigest, beforeGenerate: () => context.authority.verify(historical),
    });
    const revoked = structuredClone(context.startup);
    revoked.employees.roles.developer.taskBrain.remoteData.code = !brain.remoteData.code;
    context.activate(revoked);
    await assert.rejects(context.authority.verify(historical), { code: "INVALID_CODE_JOB_AUTHORITY" });
    await assert.rejects(context.authority.describe("developer", historical.brainDigest), { code: "INVALID_CODE_JOB_AUTHORITY" });
  } finally { await context.authority.close(); }
});

function fixture({
  brainDirectoryFactory,
  actionAdmissionGate,
  grantFactoryFactory,
  inputAuthorityVerifier = acceptingInputAuthorityVerifier(),
  conflictPreparationVerifier,
  executorAuthorityValue = executorAuthority(),
  runtimeFactory,
} = {}) {
  const startup = configuration();
  const runtime = runtimeFactory?.(startup);
  let current = active(startup);
  const versions = [current];
  let snapshotReads = 0;
  const admissionGate = actionAdmissionGate || new ActionAdmissionGate();
  if (admissionGate.readStatus().mode === "unbound") {
    admissionGate.bindEffective({
      version: current.version,
      configurationDigest: current.configurationDigest,
    });
  }
  const authority = new VersionedCodeJobAuthority({
    configurationReader: {
      async readActive() {
        return structuredClone(current);
      },
      async readSnapshot() {
        snapshotReads += 1;
        return { versions: structuredClone(versions) };
      },
    },
    executorAuthority: runtime?.authority ?? executorAuthorityValue,
    ...(runtime ? { inspectAuthorityForWritablePaths: runtime.inspectAuthorityForWritablePaths } : {}),
    startupConfiguration: startup,
    actionAdmissionGate: admissionGate,
    inputAuthorityVerifier,
    ...(conflictPreparationVerifier ? { conflictPreparationVerifier } : {}),
    ...(brainDirectoryFactory ? { brainDirectoryFactory } : {}),
    ...(grantFactoryFactory ? { grantFactoryFactory } : {}),
  });
  return {
    authority,
    actionAdmissionGate: admissionGate,
    startup,
    get snapshotReads() {
      return snapshotReads;
    },
    activate(value, version = current.version + 1) {
      current = active(normalizeConfigurationDocument(value), version);
      versions.push(current);
    },
    restart() {
      const restartedRuntime = runtimeFactory?.(current.configuration);
      const restartGate = new ActionAdmissionGate();
      restartGate.bindEffective({
        version: current.version,
        configurationDigest: current.configurationDigest,
      });
      return new VersionedCodeJobAuthority({
        configurationReader: {
          async readActive() {
            return structuredClone(current);
          },
          async readSnapshot() {
            return { versions: structuredClone(versions) };
          },
        },
        executorAuthority: restartedRuntime?.authority ?? executorAuthorityValue,
        ...(restartedRuntime ? { inspectAuthorityForWritablePaths: restartedRuntime.inspectAuthorityForWritablePaths } : {}),
        startupConfiguration: current.configuration,
        actionAdmissionGate: restartGate,
        inputAuthorityVerifier,
        ...(conflictPreparationVerifier ? { conflictPreparationVerifier } : {}),
        ...(brainDirectoryFactory ? { brainDirectoryFactory } : {}),
        ...(grantFactoryFactory ? { grantFactoryFactory } : {}),
      });
    },
  };
}

function inspectRuntime(config) {
  const workspace = executorAuthority().workspaces[0];
  const writablePaths = config.codeExecutor.workspaces[0].writablePaths;
  const boundary = { schemaVersion: 3, workspaceId: workspace.id, sourceRoot: "D:/fixture/repository",
    capabilities: workspace.capabilities, gitSnapshot: { boundaryDigest: "a".repeat(64) },
    excludePaths: workspace.excludePaths, requiredProfiles: workspace.requiredProfiles };
  const authority = { workspaces: [{ ...workspace, writablePaths,
    authorityDigest: digestValue({ ...boundary, writablePaths }) }] };
  return { authority, inspectAuthorityForWritablePaths: ({ workspaceId, writablePaths: previous }) => {
    assert.equal(workspaceId, workspace.id);
    return { workspaces: [{ ...workspace, writablePaths: previous,
      authorityDigest: digestValue({ ...boundary, writablePaths: previous }) }] };
  } };
}

test("inspect checkpoints survive additive writable paths after a runtime restart without changing grants", async () => {
  const context = fixture({ runtimeFactory: inspectRuntime });
  const inspect = (await context.authority.create(proposal(context.startup, { operation: "inspect" }))).grant;
  const modify = (await context.authority.create(proposal(context.startup))).grant;
  const added = structuredClone(context.startup);
  added.codeExecutor.workspaces[0].writablePaths.push("docs/one.cpp", "docs/two.cpp");
  context.activate(added);
  const restarted = context.restart();
  try {
    assert.deepEqual(await restarted.verify(inspect), inspect);
    await assert.rejects(restarted.verify(modify), { code: "INVALID_CODE_JOB_AUTHORITY" });
    const fresh = (await restarted.create(proposal(added, { operation: "inspect" }))).grant;
    assert.notEqual(fresh.workspaceAuthorityDigest, inspect.workspaceAuthorityDigest);
    assert.deepEqual(await restarted.verify(fresh), fresh);
  } finally { await restarted.close(); await context.authority.close(); }
});

test("inspect compatibility never resurrects paths removed and restored in configuration history", async () => {
  const context = fixture({ runtimeFactory: inspectRuntime });
  const grant = (await context.authority.create(proposal(context.startup, { operation: "inspect" }))).grant;
  const removed = structuredClone(context.startup);
  removed.codeExecutor.workspaces[0].writablePaths = ["src"];
  context.activate(removed);
  const added = structuredClone(context.startup);
  added.codeExecutor.workspaces[0].writablePaths.push("docs/one.cpp");
  context.activate(added);
  const restarted = context.restart();
  try { await assert.rejects(restarted.verify(grant), { code: "INVALID_CODE_JOB_AUTHORITY" }); }
  finally { await restarted.close(); await context.authority.close(); }
});

test("inspect projection caches preserve epochs when earlier write lists changed ordering", async () => {
  const context = fixture({ runtimeFactory: inspectRuntime });
  const grant = (await context.authority.create(proposal(context.startup, { operation: "inspect" }))).grant;
  const reordered = structuredClone(context.startup);
  reordered.codeExecutor.workspaces[0].writablePaths.reverse();
  context.activate(reordered);
  context.activate(context.startup);
  const added = structuredClone(context.startup);
  added.codeExecutor.workspaces[0].writablePaths.push("docs/one.cpp");
  context.activate(added);
  const restarted = context.restart();
  try { assert.deepEqual(await restarted.verify(grant), grant); }
  finally { await restarted.close(); await context.authority.close(); }
});

test("inspect write extensions preserve all other authority and current input fences", async t => {
  const cases = {
    exclusions: config => { config.codeExecutor.workspaces[0].excludePaths.push("private"); },
    source: config => { config.codeExecutor.workspaces[0].sourceRoot = "other"; },
    profile: config => { config.codeExecutor.profiles["node-tests"].timeoutMs += 1000; },
    role: config => { config.employees.roles.developer.enabled = false; },
    policy: config => { config.workCoordination.policy.version++; },
    repository: config => { config.workCoordination.policy.workspaceByRepository["acme/repo"] = "auxiliary"; },
    model: config => { config.employees.roles.developer.taskBrain.model = "replacement"; },
    provider: config => { config.brainProviders[config.employees.roles.developer.taskBrain.provider].baseUrl = "http://127.0.0.1:9999"; },
    git: config => { config.codeExecutor.gitCommand = "C:\\Other\\ucrt64\\bin\\git.exe"; },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async () => {
      const context = fixture({ runtimeFactory: inspectRuntime });
      const grant = (await context.authority.create(proposal(context.startup, { operation: "inspect" }))).grant;
      const changed = structuredClone(context.startup);
      change(changed);
      context.activate(changed);
      const restored = structuredClone(context.startup);
      restored.codeExecutor.workspaces[0].writablePaths.push("docs/one.cpp");
      context.activate(restored);
      const restarted = context.restart();
      try { await assert.rejects(restarted.verify(grant), { code: "INVALID_CODE_JOB_AUTHORITY" }); }
      finally { await restarted.close(); await context.authority.close(); }
    });
  }
  await t.test("current source input", async () => {
    let inputValid = true;
    const context = fixture({ runtimeFactory: inspectRuntime, inputAuthorityVerifier: {
      verify(binding) {
        if (!inputValid) throw Object.assign(new Error("input changed"), { code: "INVALID_CODE_JOB_AUTHORITY" });
        return structuredClone(binding);
      },
    } });
    const grant = (await context.authority.create(proposal(context.startup, { operation: "inspect" }))).grant;
    const added = structuredClone(context.startup);
    added.codeExecutor.workspaces[0].writablePaths.push("docs/one.cpp");
    context.activate(added);
    const restarted = context.restart();
    try {
      assert.deepEqual(await restarted.verify(grant), grant);
      inputValid = false;
      await assert.rejects(restarted.verify(grant), { code: "INVALID_CODE_JOB_AUTHORITY" });
    } finally { await restarted.close(); await context.authority.close(); }
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("code reading description follows the active and historically sealed brain", async () => {
  const descriptions = [];
  const context = fixture({ brainDirectoryFactory: ({ roles }) => ({
    async decide() {},
    describe(roleId) {
      descriptions.push(roles[roleId].taskBrain.model);
      return { supportsCodeReading: roles[roleId].taskBrain.model !== "new-local-model",
        model: roles[roleId].taskBrain.model };
    },
  }) });
  const oldGrant = (await context.authority.create(proposal(context.startup))).grant;
  assert.deepEqual(await context.authority.describe("developer", oldGrant.brainDigest), {
    supportsCodeReading: true, model: context.startup.employees.roles.developer.taskBrain.model,
  });
  const changed = structuredClone(context.startup);
  changed.employees.roles.developer.taskBrain.model = "new-local-model";
  context.activate(changed);
  const newGrant = (await context.authority.create(proposal(changed))).grant;
  assert.equal((await context.authority.describe("developer")).supportsCodeReading, false);
  assert.equal((await context.authority.describe("developer", newGrant.brainDigest)).supportsCodeReading, false);
  assert.equal((await context.authority.describe("developer", oldGrant.brainDigest)).supportsCodeReading, true);
  assert.deepEqual(descriptions, [context.startup.employees.roles.developer.taskBrain.model,
    "new-local-model", "new-local-model", context.startup.employees.roles.developer.taskBrain.model]);
});

test("obsolete execution quiescence follows the historically sealed brain without admitting stale code execution", async () => {
  const calls = [];
  const context = fixture({ brainDirectoryFactory: ({ roles }) => ({
    async decide() { assert.fail('cleanup must never dispatch a model'); },
    describe() { return { supportsCodeExecution: true }; },
    async withEntityQuiescence(input, operation) {
      calls.push({ model: roles.developer.taskBrain.model, ...input });
      return { executed: true, result: await operation() };
    },
  }) });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.developer.taskBrain.model = 'new-model';
  context.activate(changed);
  const result = await context.authority.withEntityQuiescence({ roleId: 'developer', brainDigest: grant.brainDigest,
    entityKey: 'github:pull_request:acme/repo#42' }, () => 'cleanup');
  assert.deepEqual(result, { executed: true, result: 'cleanup' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, context.startup.employees.roles.developer.taskBrain.model);
  assert.equal(calls[0].entityKey, 'github:pull_request:acme/repo#42');
  await context.authority.close();
});

test("continuous cancellation signal passes through versioned admission without serialization", async () => {
  let seen;
  const context = fixture({ brainDirectoryFactory: () => ({
    async decide(value, authorization) { seen = authorization.signal; await authorization.beforeGenerate(); return value; },
  }) });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const controller = new AbortController();
  assert.deepEqual(await context.authority.decide({ roleId: "developer" }, {
    beforeGenerate: async () => {}, brainDigest: grant.brainDigest, signal: controller.signal,
  }), { roleId: "developer" });
  assert.equal(seen, controller.signal);
  await context.authority.close();
});

test("code reading description supports legacy directories without invoking describe accessors", async () => {
  let getters = 0;
  const context = fixture({ brainDirectoryFactory: () => ({
    async decide() {},
    get describe() { getters += 1; throw new Error("must not invoke getter"); },
  }) });
  assert.deepEqual(await context.authority.describe("developer"), { supportsCodeReading: false });
  assert.equal(getters, 0);
});

test("code reading description rejects invalid or disabled authority before constructing a directory", async (t) => {
  for (const mode of ["invalid role", "invalid digest", "disabled role", "executor changed", "closed"]) {
    await t.test(mode, async () => {
      let directories = 0;
      const context = fixture({ brainDirectoryFactory: () => {
        directories += 1;
        return { async decide() {}, describe: () => ({ supportsCodeReading: true }) };
      } });
      const changed = structuredClone(context.startup);
      if (mode === "disabled role") changed.employees.roles.developer.enabled = false;
      if (mode === "executor changed") changed.codeExecutor.docker.executable = "changed";
      if (["disabled role", "executor changed"].includes(mode)) context.activate(changed);
      if (mode === "closed") await context.authority.close();
      await assert.rejects(context.authority.describe(mode === "invalid role" ? "../developer" : "developer",
        mode === "invalid digest" ? "not-a-digest" : undefined));
      assert.equal(directories, 0);
    });
  }
});

test("code reading description checks role authority again after asynchronous description", async () => {
  let context;
  context = fixture({ brainDirectoryFactory: () => ({
    async decide() {},
    async describe() {
      const changed = structuredClone(context.startup);
      changed.employees.roles.developer.enabled = false;
      context.activate(changed);
      return { supportsCodeReading: true };
    },
  }) });
  await assert.rejects(context.authority.describe("developer"), { code: "INVALID_CODE_JOB_AUTHORITY" });
});

test("review repair authority requires enablement and binds only its trusted Head mirror", async () => {
  const context = fixture();
  const enabled = structuredClone(context.startup);
  enabled.githubActions.automaticOwnPrRepair = true;
  context.activate(enabled);
  const { contentDigest: _digest, ...ordinary } = proposal(context.startup);
  const bound = normalizeBoundWorkProposal({ ...ordinary, binding: { ...ordinary.binding,
    executionSource: createReviewRepairCodeExecutionSource({ inputBinding: ordinary.binding.inputBinding, writablePaths: ["src", "test"] }),
  } });
  const sealed = (await context.authority.create(bound)).grant;
  assert.equal(sealed.executionSource.kind, "review_repair");
  assert.deepEqual(await context.authority.verify(sealed), sealed);
  const unrelated = structuredClone(enabled);
  unrelated.codeExecutor.conflictPreparation.headMirrorsByRepository["contributor/other"] = "D:\\changed-unrelated.git";
  context.activate(unrelated);
  assert.deepEqual(await context.restart().verify(sealed), sealed);
  const disabled = structuredClone(unrelated);
  disabled.githubActions.automaticOwnPrRepair = false;
  context.activate(disabled);
  await assert.rejects(context.authority.create(bound));
  await assert.rejects(context.restart().verify(sealed));
  context.activate(unrelated);
  await assert.rejects(context.restart().verify(sealed));
});

function activateHistory(context, targetVersion, change) {
  for (let version = 2; version <= targetVersion; version += 1) {
    const configurationValue = structuredClone(context.startup);
    configurationValue.browserPollSeconds = version;
    change(configurationValue, version);
    context.activate(configurationValue);
  }
}

test("conflict authority cache identity stays bounded across preparation evidence", () => {
  const executionSource = proposal(configuration(), {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  }).binding.executionSource;
  const scope = {
    executorAuthorityDigest: "a".repeat(64),
    policyVersion: 1,
    repository: "acme/repo",
    workspaceId: "acme-workspace",
    roleId: "developer",
    operation: "modify",
    executionSource,
  };
  const identities = new Set();
  for (let index = 0; index < 2_000; index += 1) {
    const distinctEvidence = structuredClone(executionSource);
    distinctEvidence.preparationBinding.preparationId = index
      .toString(16)
      .padStart(64, "0");
    identities.add(
      canonicalJsonDigest(
        codeJobAuthorityScopeCacheIdentity({
          ...scope,
          executionSource: distinctEvidence,
        }),
      ),
    );
  }

  assert.equal(identities.size, 1);
  const otherRepository = structuredClone(executionSource);
  otherRepository.preparationBinding.gitTarget.headRepository =
    "contributor/other";
  assert.notDeepEqual(
    codeJobAuthorityScopeCacheIdentity(scope),
    codeJobAuthorityScopeCacheIdentity({
      ...scope,
      executionSource: otherRepository,
    }),
  );
});

test("malformed grants fail before reading or constructing authority history", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });

  await assert.rejects(
    context.authority.verify({}),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads, 0);
  assert.equal(factoryCreations, 0);
});

test("a legacy global-digest grant remains readable but cannot authorize execution", async () => {
  const beforeUpgrade = configuration();
  const sealed = legacyGrant([beforeUpgrade]);
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });

  assert.deepEqual(normalizeCodeJobGrant(sealed), sealed);
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: () => context.authority.verify(sealed),
        brainDigest: sealed.brainDigest,
      },
    ),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("legacy grants remain readable across history but never regain execution authority", async () => {
  const beforeUpgrade = configuration();
  const sealed = legacyGrant([beforeUpgrade]);
  const context = fixture();
  assert.deepEqual(normalizeCodeJobGrant(sealed), sealed);
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  const changed = structuredClone(context.startup);
  changed.employees.roles.tester.permissions.allowedIntents.push(
    "propose_github_review",
  );
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("legacy rejection scans a long benign history once", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });
  const sealed = legacyGrant([context.startup]);
  activateHistory(context, 256, (configurationValue) => {
    configurationValue.employees.roles.developer.brain.model =
      "replacement-local-model";
  });

  const readsBefore = context.snapshotReads;
  assert.deepEqual(normalizeCodeJobGrant(sealed), sealed);
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(factoryCreations <= 2, `created ${factoryCreations} grant factories`);
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(factoryCreations <= 4, `created ${factoryCreations} grant factories`);
});

test("a global executor limit expansion invalidates a scoped grant after restart", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const expanded = structuredClone(context.startup);
  expanded.codeExecutor.brokerLimits.maxFiles = 2_000;
  context.activate(expanded);

  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("an unrelated executor workspace change preserves a scoped grant after restart", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.codeExecutor.workspaces.find(
    ({ id }) => id === "auxiliary",
  ).writablePaths = ["test"];
  changed.codeExecutor.profiles["auxiliary-tests"].timeoutMs = 45_000;
  context.activate(changed);

  assert.deepEqual(await context.restart().verify(sealed), sealed);
});

test("versioned authority creates and revalidates sealed conflict grants", async () => {
  const verified = [];
  const conflictPreparationVerifier = {
    verify(binding) {
      verified.push(structuredClone(binding));
      return structuredClone(binding);
    },
  };
  const context = fixture({
    executorAuthorityValue: executorAuthority({ conflict: true }),
    conflictPreparationVerifier,
  });
  const currentProposal = proposal(context.startup, {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  });
  const sealed = (await context.authority.create(currentProposal)).grant;

  assert.equal(sealed.schemaVersion, 3);
  assert.equal(sealed.brainBindingSchema, 2);
  assert.deepEqual(sealed.executionSource, currentProposal.binding.executionSource);
  assert.deepEqual(sealed.writablePaths, ["src/value.js"]);
  assert.deepEqual(await context.authority.verify(sealed), sealed);
  assert.deepEqual(await context.restart().verify(sealed), sealed);
  assert.equal(verified.length, 3);

  const missingVerifier = fixture({
    executorAuthorityValue: executorAuthority({ conflict: true }),
  });
  assert.equal(
    (await missingVerifier.authority.create(proposal(missingVerifier.startup)))
      .grant.schemaVersion,
    2,
  );
  await assert.rejects(
    missingVerifier.authority.create(proposal(missingVerifier.startup, {
      conflicts: [{ path: "src/value.js", mode: "100644" }],
    })),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("ordinary grants ignore conflict mirror configuration changes", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "acme/repo"
  ] = "D:\\replacement\\acme-repo.git";
  context.activate(changed);

  assert.deepEqual(await context.restart().verify(sealed), sealed);
});

test("conflict grants ignore mirrors for unrelated repositories", async () => {
  const verifier = { verify: (binding) => structuredClone(binding) };
  const context = fixture({
    executorAuthorityValue: executorAuthority({ conflict: true }),
    conflictPreparationVerifier: verifier,
  });
  const sealed = (await context.authority.create(proposal(context.startup, {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  }))).grant;
  const changed = structuredClone(context.startup);
  changed.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "acme/other"
  ] = "D:\\replacement\\acme-other.git";
  changed.codeExecutor.conflictPreparation.headMirrorsByRepository[
    "contributor/other"
  ] = "D:\\replacement\\contributor-other.git";
  context.activate(changed);

  assert.deepEqual(await context.restart().verify(sealed), sealed);
});

test("conflict grants bind only the relevant mirrors, git command, and enablement", async () => {
  const verifier = { verify: (binding) => structuredClone(binding) };
  for (const [name, change] of [
    [
      "base mirror",
      (configurationValue) => {
        configurationValue.codeExecutor.conflictPreparation
          .baseMirrorsByRepository["acme/repo"] =
            "D:\\replacement\\acme-repo.git";
      },
    ],
    [
      "head mirror",
      (configurationValue) => {
        configurationValue.codeExecutor.conflictPreparation
          .headMirrorsByRepository["contributor/repo"] =
            "D:\\replacement\\contributor-repo.git";
      },
    ],
    [
      "git command",
      (configurationValue) => {
        configurationValue.codeExecutor.gitCommand =
          "D:\\PortableGit\\mingw64\\bin\\git.exe";
      },
    ],
    [
      "enablement",
      (configurationValue) => {
        configurationValue.codeExecutor.conflictPreparation = {
          enabled: false,
        };
      },
    ],
  ]) {
    const context = fixture({
      executorAuthorityValue: executorAuthority({ conflict: true }),
      conflictPreparationVerifier: verifier,
    });
    const sealed = (await context.authority.create(proposal(context.startup, {
      conflicts: [{ path: "src/value.js", mode: "100644" }],
    }))).grant;
    assert.equal(JSON.stringify(sealed).includes("mirrors"), false, name);
    assert.equal(JSON.stringify(sealed).includes("mingw64"), false, name);
    const changed = structuredClone(context.startup);
    change(changed);
    context.activate(changed);

    await assert.rejects(
      context.restart().verify(sealed),
      (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
      name,
    );
  }
});

test("restoring a relevant conflict mirror does not resurrect its old epoch", async () => {
  const verifier = { verify: (binding) => structuredClone(binding) };
  const context = fixture({
    executorAuthorityValue: executorAuthority({ conflict: true }),
    conflictPreparationVerifier: verifier,
  });
  const sealed = (await context.authority.create(proposal(context.startup, {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  }))).grant;
  const changed = structuredClone(context.startup);
  changed.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "acme/repo"
  ] = "D:\\replacement\\acme-repo.git";
  context.activate(changed);
  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));

  await assert.rejects(
    context.restart().verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("conflict mirror lookup follows runtime case-insensitive repository semantics", async () => {
  const verifier = { verify: (binding) => structuredClone(binding) };
  const context = fixture({
    executorAuthorityValue: executorAuthority({ conflict: true }),
    conflictPreparationVerifier: verifier,
  });
  const cased = structuredClone(context.startup);
  const conflict = cased.codeExecutor.conflictPreparation;
  conflict.baseMirrorsByRepository["ACME/REPO"] =
    conflict.baseMirrorsByRepository["acme/repo"];
  delete conflict.baseMirrorsByRepository["acme/repo"];
  conflict.headMirrorsByRepository["CONTRIBUTOR/REPO"] =
    conflict.headMirrorsByRepository["contributor/repo"];
  delete conflict.headMirrorsByRepository["contributor/repo"];
  context.activate(cased);
  const restarted = context.restart();
  const sealed = (await restarted.create(proposal(cased, {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  }))).grant;

  assert.deepEqual(await restarted.verify(sealed), sealed);
});

test("current Active creates grants and security expansion invalidates old grants", async () => {
  const context = fixture();
  const currentProposal = proposal(context.startup);
  const sealed = (await context.authority.create(currentProposal)).grant;
  assert.equal(sealed.schemaVersion, 2);
  assert.equal(sealed.brainBindingSchema, 2);
  assert.deepEqual(sealed.inputBinding, currentProposal.binding.inputBinding);
  assert.deepEqual(await context.authority.verify(sealed), sealed);

  const expanded = structuredClone(context.startup);
  expanded.employees.roles.developer.permissions.allowedIntents.push(
    "propose_github_review",
  );
  context.activate(expanded);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("a missing task brain waits at grant creation without using the routine brain", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });
  const waiting = structuredClone(context.startup);
  delete waiting.employees.roles.developer.taskBrain;
  context.activate(waiting);

  await assert.rejects(
    context.authority.create(proposal(waiting)),
    (error) => error?.code === "CODE_TASK_BRAIN_NOT_CONFIGURED",
  );
  assert.equal(factoryCreations, 1);
  assert.equal(waiting.employees.roles.developer.brain.model.length > 0, true);
});

test("routine brain changes do not invalidate task-brain grants", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.developer.brain.model = "routine-only-change";
  context.activate(changed);

  assert.deepEqual(await context.authority.verify(sealed), sealed);
});

test("schema 2 historical grants use an explicit legacy-brain verifier only", async () => {
  let legacyVerifierCreated = false;
  let providerCalls = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      if (options.legacyBrainByRole && options.scopeAuthorityDigest) {
        legacyVerifierCreated = true;
      }
      return new CodeJobGrantFactory(options);
    },
    brainDirectoryFactory: () => ({
      async decide() {
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  const historicalBrainDigest = legacyCodeJobBrainDigest({
    roleId: "developer",
    brain: context.startup.employees.roles.developer.brain,
    brainProviders: context.startup.brainProviders,
  });
  const asHistorical = (grant) => {
    const {
      brainBindingSchema: _brainBindingSchema,
      grantDigest: _grantDigest,
      ...content
    } = grant;
    return createCodeJobGrant({
      ...content,
      brainDigest: historicalBrainDigest,
    });
  };

  const policy = context.startup.workCoordination.policy;
  const roleIds = policy.codeActionRoles;
  const historicallyScoped = new CodeJobGrantFactory({
    executorAuthority: executorAuthority(),
    policyVersion: policy.version,
    workspaceByRepository: policy.workspaceByRepository,
    codeActionRoles: roleIds,
    codeOperationsByRole: policy.codeOperationsByRole,
    taskBrainByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        context.startup.employees.roles[roleId].taskBrain,
      ]),
    ),
    brainProviders: context.startup.brainProviders,
    scopeAuthorityDigest: (scope) =>
      historicalScopedAuthorityDigest(context.startup, scope),
    inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
  }).create(proposal(context.startup)).grant;
  const historical = asHistorical(historicallyScoped);

  assert.deepEqual(await context.authority.verify(historical), historical);
  assert.equal(legacyVerifierCreated, true);
  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: () => context.authority.verify(historical),
        brainDigest: historical.brainDigest,
      },
    ),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("schema 3 historical conflict grants retain their legacy recovery path", async () => {
  const verifier = { verify: (binding) => structuredClone(binding) };
  const authority = executorAuthority({ conflict: true });
  const context = fixture({
    executorAuthorityValue: authority,
    conflictPreparationVerifier: verifier,
  });
  const policy = context.startup.workCoordination.policy;
  const roleIds = policy.codeActionRoles;
  const current = new CodeJobGrantFactory({
    executorAuthority: authority,
    policyVersion: policy.version,
    workspaceByRepository: policy.workspaceByRepository,
    codeActionRoles: roleIds,
    codeOperationsByRole: policy.codeOperationsByRole,
    taskBrainByRole: Object.fromEntries(
      roleIds.map((roleId) => [
        roleId,
        context.startup.employees.roles[roleId].taskBrain,
      ]),
    ),
    brainProviders: context.startup.brainProviders,
    scopeAuthorityDigest: (scope) =>
      historicalScopedAuthorityDigest(context.startup, scope),
    inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
    conflictPreparationVerifier: verifier,
  }).create(proposal(context.startup, {
    conflicts: [{ path: "src/value.js", mode: "100644" }],
  })).grant;
  const {
    brainBindingSchema: _brainBindingSchema,
    grantDigest: _grantDigest,
    ...content
  } = current;
  const historical = createCodeJobGrant({
    ...content,
    brainDigest: legacyCodeJobBrainDigest({
      roleId: "developer",
      brain: context.startup.employees.roles.developer.brain,
      brainProviders: context.startup.brainProviders,
    }),
  });

  assert.equal(historical.schemaVersion, 3);
  assert.equal(Object.hasOwn(historical, "brainBindingSchema"), false);
  assert.deepEqual(await context.authority.verify(historical), historical);
});

test("unrelated role, provider, and repository changes keep sealed work valid", async () => {
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.tester.permissions.allowedIntents.push(
    "propose_github_review",
  );
  changed.brainProviders["unused-remote"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.invalid/v1",
    apiKeyEnv: "UNUSED_MODEL_TOKEN",
    remote: true,
  };
  changed.trackedRepositories.push("acme/other");
  changed.workCoordination.policy.workspaceByRepository["acme/other"] =
    "dashboard";
  context.activate(changed);

  assert.deepEqual(await context.authority.verify(sealed), sealed);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(sealed),
      brainDigest: sealed.brainDigest,
    },
  );
  assert.equal(providerCalls, 1);
});

test("the grant repository binding invalidates without affecting history fallback", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  delete changed.workCoordination.policy.workspaceByRepository["acme/repo"];
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("the assigned provider authority invalidates its sealed grants", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.brainProviders.ollama.baseUrl = "http://127.0.0.1:11435";
  context.activate(changed);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("an assigned provider protocol change invalidates its sealed grants", async () => {
  const context = fixture();
  const configured = structuredClone(context.startup);
  configured.brainProviders.codex = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "chat-completions",
    remote: true,
  };
  configured.employees.roles.developer.taskBrain.provider = "codex";
  configured.employees.roles.developer.taskBrain.remoteData.code = true;
  context.activate(configured);
  const sealed = (await context.authority.create(proposal(configured))).grant;
  const replaced = structuredClone(configured);
  replaced.brainProviders.codex.protocol = "responses";
  context.activate(replaced);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("an assigned provider response format change invalidates its sealed grants", async () => {
  const context = fixture();
  const configured = structuredClone(context.startup);
  configured.brainProviders.ark = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "ARK_API_KEY",
    protocol: "chat-completions",
    responseFormat: "json-schema",
    remote: true,
  };
  configured.employees.roles.developer.taskBrain.provider = "ark";
  configured.employees.roles.developer.taskBrain.remoteData.code = true;
  context.activate(configured);
  const sealed = (await context.authority.create(proposal(configured))).grant;
  const replaced = structuredClone(configured);
  replaced.brainProviders.ark.responseFormat = "json-object";
  context.activate(replaced);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("a revoked authority cannot resurrect an old grant after exact restoration", async () => {
  const context = fixture();
  const oldGrant = (await context.authority.create(proposal(context.startup))).grant;
  assert.deepEqual(await context.authority.verify(oldGrant), oldGrant);

  const revoked = structuredClone(context.startup);
  revoked.workCoordination.policy.codeOperationsByRole.developer = [
    "inspect",
    "verify",
  ];
  context.activate(revoked);
  context.activate(structuredClone(context.startup));

  await assert.rejects(
    context.authority.verify(oldGrant),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  const newGrant = (
    await context.authority.create(proposal(context.startup))
  ).grant;
  assert.deepEqual(await context.authority.verify(newGrant), newGrant);
});

test("policy versions participate in the non-resurrecting scoped epoch", async () => {
  const context = fixture();
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  const upgraded = structuredClone(context.startup);
  upgraded.workCoordination.policy.version += 1;
  context.activate(upgraded);

  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  context.activate(structuredClone(context.startup));
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
});

test("a revoked scoped grant is rejected with bounded history replay", async () => {
  let factoryCreations = 0;
  const context = fixture({
    grantFactoryFactory: (options) => {
      factoryCreations += 1;
      return new CodeJobGrantFactory(options);
    },
  });
  const sealed = (await context.authority.create(proposal(context.startup))).grant;
  activateHistory(context, 256, (configurationValue, version) => {
    if (version === 2) {
      configurationValue.workCoordination.policy.codeOperationsByRole.developer = [
        "inspect",
        "verify",
      ];
    }
  });

  const factoriesBefore = factoryCreations;
  const readsBefore = context.snapshotReads;
  await assert.rejects(
    context.authority.verify(sealed),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(context.snapshotReads - readsBefore, 1);
  assert.ok(
    factoryCreations - factoriesBefore <= 1,
    `created ${factoryCreations - factoriesBefore} grant factories`,
  );
});

test("a changed executor boundary blocks new authority until restart", async () => {
  const context = fixture();
  const changed = structuredClone(context.startup);
  changed.codeExecutor.docker.executable = "docker-updated";
  context.activate(changed);

  await assert.rejects(
    context.authority.create(proposal(context.startup)),
    (error) =>
      error?.code === "INVALID_CODE_JOB_AUTHORITY" &&
      error.message.includes("重启"),
  );
});

test("a brain authorization change between selection and generation sends no context", async () => {
  let activate;
  let providerCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        activate();
        await authorization.beforeGenerate();
        providerCalls += 1;
        return { action: { type: "complete" } };
      },
    }),
  });
  activate = () => {
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.taskBrain.remoteData.code = true;
    context.activate(changed);
  };
  const sealed = (await context.authority.create(proposal(context.startup))).grant;

  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: async () => {},
        brainDigest: sealed.brainDigest,
      },
    ),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("activation admitted first prevents the stale brain request", async () => {
  const activationEntered = deferred();
  const releaseActivation = deferred();
  let providerCalls = 0;
  const gate = new ActionAdmissionGate();
  const context = fixture({
    actionAdmissionGate: gate,
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        const admitted = await authorization.admitGenerate(async () => {
          await authorization.beforeGenerate();
          providerCalls += 1;
          return { response: { action: { type: "complete" } } };
        });
        return admitted.response;
      },
    }),
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const activation = gate.run(async () => {
    activationEntered.resolve();
    await releaseActivation.promise;
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.taskBrain.remoteData.code = true;
    context.activate(changed);
  });
  await activationEntered.promise;

  const decision = context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(grant),
      brainDigest: grant.brainDigest,
    },
  );
  releaseActivation.resolve();
  await activation;

  await assert.rejects(
    decision,
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  assert.equal(providerCalls, 0);
});

test("an admitted brain request releases activation before its response", async () => {
  const providerStarted = deferred();
  const providerResponse = deferred();
  let providerCalls = 0;
  const gate = new ActionAdmissionGate();
  const context = fixture({
    actionAdmissionGate: gate,
    brainDirectoryFactory: () => ({
      async decide(_value, authorization) {
        const admitted = await authorization.admitGenerate(async () => {
          await authorization.beforeGenerate();
          providerCalls += 1;
          providerStarted.resolve();
          return { response: providerResponse.promise };
        });
        return admitted.response;
      },
    }),
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const decision = context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(grant),
      brainDigest: grant.brainDigest,
    },
  );
  await providerStarted.promise;

  let activationFinished = false;
  await gate.run(() => {
    const changed = structuredClone(context.startup);
    changed.employees.roles.developer.taskBrain.remoteData.code = true;
    context.activate(changed);
    activationFinished = true;
  });
  assert.equal(activationFinished, true);
  assert.equal(providerCalls, 1);

  providerResponse.resolve({ action: { type: "complete" } });
  assert.deepEqual(await decision, { action: { type: "complete" } });
});

test("a benign model change affects new claims while old work keeps its sealed brain", async () => {
  const selectedModels = [];
  const context = fixture({
    brainDirectoryFactory: (options) => ({
      async decide(_value, authorization) {
        selectedModels.push(options.roles.developer.taskBrain.model);
        await authorization.beforeGenerate();
        return { action: { type: "complete" } };
      },
    }),
  });
  const oldGrant = (await context.authority.create(proposal(context.startup))).grant;
  const changed = structuredClone(context.startup);
  changed.employees.roles.developer.taskBrain.model = "new-local-model";
  context.activate(changed);

  assert.deepEqual(await context.authority.verify(oldGrant), oldGrant);
  const newGrant = (await context.authority.create(proposal(changed))).grant;
  assert.notEqual(newGrant.brainDigest, oldGrant.brainDigest);
  await context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: () => context.authority.verify(oldGrant),
      brainDigest: oldGrant.brainDigest,
    },
  );

  assert.deepEqual(selectedModels, [
    context.startup.employees.roles.developer.taskBrain.model,
  ]);
});

test("close retains every unique directory across context replacement and retries only failures", async () => {
  const firstFailure = new Error("first directory close failed");
  const thirdFailure = new Error("third directory close failed");
  const resources = [];
  let factoryCalls = 0;
  const context = fixture({
    brainDirectoryFactory: () => {
      factoryCalls += 1;
      if (factoryCalls === 4) return resources[0].directory;
      const index = resources.length;
      const resource = {
        attempts: 0,
        failure: index === 0
          ? firstFailure
          : index === 2
            ? thirdFailure
            : null,
        directory: null,
      };
      resource.directory = {
        async decide(_value, authorization) {
          await authorization.beforeGenerate();
          return { action: { type: "complete" } };
        },
        async close() {
          resource.attempts += 1;
          if (resource.attempts === 1 && resource.failure) {
            throw resource.failure;
          }
        },
      };
      resources.push(resource);
      return resource.directory;
    },
  });
  let currentConfiguration = context.startup;
  for (let version = 1; version <= 4; version += 1) {
    if (version > 1) {
      currentConfiguration = structuredClone(context.startup);
      currentConfiguration.employees.roles.developer.taskBrain.model =
        `replacement-model-${version}`;
      currentConfiguration.browserPollSeconds += version;
      context.activate(currentConfiguration);
    }
    const grant = (
      await context.authority.create(proposal(currentConfiguration))
    ).grant;
    await context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: async () => {},
        brainDigest: grant.brainDigest,
      },
    );
  }
  assert.equal(factoryCalls, 4);
  assert.equal(resources.length, 3);

  const firstClose = context.authority.close();
  assert.strictEqual(context.authority.close(), firstClose);
  const aggregate = await firstClose.then(
    () => null,
    (error) => error,
  );
  assert.ok(aggregate instanceof AggregateError);
  assert.deepEqual(new Set(aggregate.errors), new Set([
    firstFailure,
    thirdFailure,
  ]));
  assert.deepEqual(resources.map(({ attempts }) => attempts), [1, 1, 1]);

  await assert.rejects(
    context.authority.create(proposal(currentConfiguration)),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );
  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      { beforeGenerate: async () => {}, brainDigest: "a".repeat(64) },
    ),
    (error) => error?.code === "INVALID_CODE_JOB_AUTHORITY",
  );

  const retry = context.authority.close();
  assert.strictEqual(context.authority.close(), retry);
  await retry;
  await context.authority.close();
  assert.deepEqual(resources.map(({ attempts }) => attempts), [2, 1, 2]);
});

test("lazy configured construction isolates attempt tokens and retains partial cleanup", async () => {
  const constructionFailure = new Error("lazy configured directory failed");
  const cleanupFailures = [
    new Error("first lazy provider cleanup failed once"),
    new Error("second lazy provider cleanup failed once"),
  ];
  const constructionOwners = [];
  const cleanupAttempts = [0, 0];
  const closeSequence = [];
  let factoryAttempt = 0;
  const context = fixture({
    brainDirectoryFactory(options) {
      const attempt = factoryAttempt;
      factoryAttempt += 1;
      constructionOwners.push(options.constructionCleanupOwner);
      return createTestConfiguredBrainRouter(
        {
          constructionCleanupOwner: options.constructionCleanupOwner,
          brainProviders: {
            acquired: { kind: "codex-cli" },
            failing: { kind: "claude-cli" },
          },
        },
        {
          supervisedCliProviderFactory(providerOptions) {
            if (providerOptions.id === "failing") throw constructionFailure;
            return {
              id: providerOptions.id,
              remote: true,
              singleAttempt: true,
              async generate() { return '{"ok":true}'; },
              async close() {
                cleanupAttempts[attempt] += 1;
                closeSequence.push(attempt);
                if (cleanupAttempts[attempt] === 1) {
                  throw cleanupFailures[attempt];
                }
              },
            };
          },
        },
      );
    },
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;
  const decide = () => context.authority.decide(
    { roleId: "developer" },
    {
      beforeGenerate: async () => {},
      brainDigest: grant.brainDigest,
    },
  );

  await assert.rejects(decide(), (error) => error === constructionFailure);
  await assert.rejects(decide(), (error) => error === constructionFailure);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(constructionOwners.length, 2);
  assert.ok(constructionOwners.every((owner) => owner !== undefined));
  assert.notStrictEqual(constructionOwners[0], constructionOwners[1]);
  assert.deepEqual(cleanupAttempts, [1, 1]);
  assert.deepEqual(closeSequence, [0, 1]);

  await context.authority.close();
  assert.deepEqual(cleanupAttempts, [2, 2]);
  assert.deepEqual(closeSequence, [0, 1, 1, 0]);
});

test("lazy directory validation retains a returned callable close", async () => {
  let closeAttempts = 0;
  const context = fixture({
    brainDirectoryFactory: () => ({
      async close() {
        closeAttempts += 1;
      },
    }),
  });
  const grant = (await context.authority.create(proposal(context.startup))).grant;

  await assert.rejects(
    context.authority.decide(
      { roleId: "developer" },
      {
        beforeGenerate: async () => {},
        brainDigest: grant.brainDigest,
      },
    ),
    /versioned code job brain directory is invalid/,
  );
  await context.authority.close();

  assert.equal(closeAttempts, 1);
});

test("close fences an in-flight active read before it can create a context", async () => {
  const startup = configuration();
  const activeReadStarted = deferred();
  const releaseActiveRead = deferred();
  let snapshotReads = 0;
  let directoryCreations = 0;
  const authority = new VersionedCodeJobAuthority({
    configurationReader: {
      async readActive() {
        activeReadStarted.resolve();
        await releaseActiveRead.promise;
        return active(startup);
      },
      async readSnapshot() {
        snapshotReads += 1;
        return { versions: [active(startup)] };
      },
    },
    executorAuthority: executorAuthority(),
    startupConfiguration: startup,
    actionAdmissionGate: { async run(operation) { return operation(); } },
    inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
    brainDirectoryFactory: () => {
      directoryCreations += 1;
      return { async decide() {} };
    },
  });
  const creationOutcome = authority.create(proposal(startup)).then(
    () => null,
    (error) => error,
  );
  await activeReadStarted.promise;

  const closeAttempt = typeof authority.close === "function"
    ? authority.close()
    : null;
  releaseActiveRead.resolve();
  if (closeAttempt) await closeAttempt;
  const creationFailure = await creationOutcome;

  assert.equal(typeof authority.close, "function");
  assert.equal(creationFailure?.code, "INVALID_CODE_JOB_AUTHORITY");
  assert.equal(snapshotReads, 0);
  assert.equal(directoryCreations, 0);
});
