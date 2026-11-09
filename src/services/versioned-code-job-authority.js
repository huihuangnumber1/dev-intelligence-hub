import {
  CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA,
  CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
  CODE_JOB_ACTIONS_BY_OPERATION,
} from "../domain/code-job-contract.js";
import {
  normalizeConfigurationDocument,
} from "../domain/configuration-contract.js";
import { codeExecutionSourceWritablePaths, isHeadRepairExecutionSource } from "../domain/code-execution-source.js";
import { CodeExecutionPolicy } from "../domain/code-execution-policy.js";
import { workProposalError } from "../domain/work-proposal-contract.js";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { createConfiguredCodeJobBrainDirectory } from "./code-job-brain-directory.js";
import {
  createConfiguredConstructionCleanupOwner,
  readConfiguredConstructionCleanup,
} from "./configured-workforce.js";
import {
  codeJobBrainDigest,
  codeJobBrainBindingDigests,
  CodeJobGrantFactory,
  prepareCodeJobGrantVerification,
} from "./code-job-grant-factory.js";

function invalid(message = "代码任务授权已不符合当前活动配置") {
  return workProposalError("INVALID_CODE_JOB_AUTHORITY", message);
}

function method(value, name, owner) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${owner} is invalid`);
  }
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${owner} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`${owner} is invalid`);
}

function optionalMethod(value, name) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value.bind(value)
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function activeConfiguration(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.configurationDigest !== "string"
  ) {
    throw invalid("当前没有可用的活动配置");
  }
  const configuration = normalizeConfigurationDocument(value.configuration);
  if (canonicalJsonDigest(configuration) !== value.configurationDigest) {
    throw invalid("活动配置摘要不一致");
  }
  return {
    version: value.version,
    digest: value.configurationDigest,
    configuration,
  };
}

function providerAuthority(configuration, providerId) {
  const provider = configuration.brainProviders[providerId];
  if (!provider) return null;
  return {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv ?? null,
    ...(provider.protocol === undefined ? {} : { protocol: provider.protocol }),
    ...(provider.responseFormat === undefined
      ? {}
      : { responseFormat: provider.responseFormat }),
    remote: provider.remote ?? null,
  };
}

function roleBrainForBinding(role, brainBindingSchema) {
  if (!role) return null;
  return brainBindingSchema === CODE_JOB_TASK_BRAIN_BINDING_SCHEMA
    ? role.taskBrain ?? null
    : role.brain;
}

function roleAuthority(configuration, roleId, brainBindingSchema) {
  const role = configuration.employees.roles[roleId];
  const brain = roleBrainForBinding(role, brainBindingSchema);
  const taskBrainBinding =
    brainBindingSchema === CODE_JOB_TASK_BRAIN_BINDING_SCHEMA;
  const policy = configuration.workCoordination.policy;
  return {
    prerequisites: {
      executor: globalExecutorAuthority(configuration),
      workCoordinationEnabled: configuration.workCoordination.enabled,
      memoryEnabled: configuration.memory.enabled,
    },
    role: role
      ? {
          enabled: role.enabled,
          allowedIntents: [...role.permissions.allowedIntents].sort(),
          ...(taskBrainBinding ? { brainBindingSchema } : {}),
          [taskBrainBinding ? "taskBrain" : "brain"]:
            brain === null
              ? null
              : {
                  provider: brain.provider,
                  remoteData: brain.remoteData,
                },
          provider: brain === null
            ? null
            : providerAuthority(configuration, brain.provider),
        }
      : null,
    codePolicy: {
      admitted: policy.codeActionRoles.includes(roleId),
      operations: [...(policy.codeOperationsByRole[roleId] ?? [])].sort(),
    },
  };
}

function workspaceAuthority(configuration, workspaceId) {
  const executor = configuration.codeExecutor;
  const workspace = executor.workspaces?.find(
    (entry) => entry.id === workspaceId,
  );
  const requiredProfileIds = [
    ...(executor.requiredProfilesByWorkspace?.[workspaceId] ?? []),
  ].sort();
  return {
    workspace: workspace ?? null,
    requiredProfiles: requiredProfileIds.map((profileId) => ({
      id: profileId,
      configuration: executor.profiles?.[profileId] ?? null,
    })),
  };
}

function globalExecutorAuthority(configuration) {
  const executor = configuration.codeExecutor;
  return {
    enabled: executor.enabled,
    docker: executor.docker ?? null,
    brokerLimits: executor.brokerLimits ?? {},
    executorLimits: executor.executorLimits ?? {},
    maxArtifactBytes: executor.maxArtifactBytes ?? null,
  };
}

function conflictPreparationAuthority(configuration, executionSource) {
  if (executionSource === null) return null;
  if (isHeadRepairExecutionSource(executionSource)) {
    const headRepository = executionSource.inputBinding.gitTarget.headRepository.toLowerCase();
    const headMirror = Object.entries(configuration.codeExecutor.conflictPreparation?.headMirrorsByRepository ?? {})
      .find(([repository]) => repository.toLowerCase() === headRepository)?.[1] ?? null;
    return {
      kind: executionSource.kind,
      enabled: configuration.githubActions?.automaticOwnPrRepair === true,
      gitCommand: configuration.codeExecutor.gitCommand ?? null,
      headRepository,
      headMirror,
    };
  }
  const conflict = configuration.codeExecutor.conflictPreparation;
  const gitTarget = executionSource.preparationBinding.gitTarget;
  const mirrorFor = (mirrors, repository) => {
    const portableRepository = repository.toLowerCase();
    const configured = Object.entries(mirrors ?? {}).find(
      ([candidate]) => candidate.toLowerCase() === portableRepository,
    );
    return configured?.[1] ?? null;
  };
  return {
    enabled: conflict?.enabled === true,
    gitCommand: configuration.codeExecutor.gitCommand ?? null,
    baseRepository: gitTarget.baseRepository.toLowerCase(),
    baseMirror: mirrorFor(
      conflict?.baseMirrorsByRepository,
      gitTarget.baseRepository,
    ),
    headRepository: gitTarget.headRepository.toLowerCase(),
    headMirror: mirrorFor(
      conflict?.headMirrorsByRepository,
      gitTarget.headRepository,
    ),
  };
}

function grantAuthority(
  configuration,
  { repository, workspaceId, roleId, executionSource },
  brainBindingSchema,
) {
  return {
    policyVersion: configuration.workCoordination.policy.version,
    role: roleAuthority(configuration, roleId, brainBindingSchema),
    repository: {
      tracked: configuration.trackedRepositories.includes(repository),
      workspaceId:
        configuration.workCoordination.policy.workspaceByRepository[
          repository
        ] ?? null,
    },
    executor: workspaceAuthority(configuration, workspaceId),
    ...(brainBindingSchema === CODE_JOB_TASK_BRAIN_BINDING_SCHEMA
      ? {
          conflictPreparation: conflictPreparationAuthority(
            configuration,
            executionSource,
          ),
        }
      : {}),
  };
}

function advanceAuthority(previous, fingerprint) {
  return {
    epoch: previous.epoch + (previous.fingerprint === fingerprint ? 0 : 1),
    fingerprint,
  };
}

function roleAuthorityDigest(authority, brainBindingSchema) {
  return canonicalJsonDigest({
    schemaVersion: brainBindingSchema,
    ...authority,
  });
}

function grantAuthorityDigest(authority, scope, brainBindingSchema) {
  return canonicalJsonDigest({
    schemaVersion: brainBindingSchema,
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

export function codeJobAuthorityScopeCacheIdentity(scope) {
  const executionSource = scope.executionSource;
  const gitTarget = isHeadRepairExecutionSource(executionSource)
    ? executionSource.inputBinding.gitTarget
    : executionSource?.preparationBinding?.gitTarget;
  return {
    ...scope,
    executionSource:
      executionSource === null || executionSource === undefined
        ? null
        : {
            ...(isHeadRepairExecutionSource(executionSource) ? { kind: executionSource.kind } : {}),
            baseRepository: gitTarget.baseRepository.toLowerCase(),
            headRepository: gitTarget.headRepository.toLowerCase(),
          },
  };
}

function executorWorkspaceAuthorityDigest(value, workspaceId) {
  const workspace = value?.workspaces?.find((entry) => entry.id === workspaceId);
  if (
    !workspace ||
    typeof workspace.authorityDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(workspace.authorityDigest)
  ) {
    throw invalid("代码执行器工作区授权无效");
  }
  return workspace.authorityDigest;
}

function legacyConfigurationAuthorityDigest(configuration) {
  // This exact projection is the persisted pre-scope digest algorithm.
  const roles = Object.fromEntries(
    Object.entries(configuration.employees.roles).map(([roleId, role]) => [
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
    Object.entries(configuration.brainProviders).map(
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
    trackedRepositories: configuration.trackedRepositories,
    codeExecutor: configuration.codeExecutor,
    workCoordination: {
      enabled: configuration.workCoordination.enabled,
      policy: configuration.workCoordination.policy,
    },
    memoryEnabled: configuration.memory.enabled,
    roles,
    brainProviders: providers,
  });
}

function legacyWorkspaceAuthorityDigest(value, authority, workspaceId) {
  return canonicalJsonDigest({
    executorAuthorityDigest: executorWorkspaceAuthorityDigest(value, workspaceId),
    configurationAuthorityDigest: authority.digest,
    configurationAuthorityEpoch: authority.epoch,
  });
}

class AuthorityHistory {
  #versions;
  #executorAuthority;
  #scopeTimelines;
  #roleTimelines;
  #legacyStates;
  #inspectPlans = new Map();

  constructor(versions, executorAuthority) {
    this.#versions = versions;
    this.#executorAuthority = executorAuthority;
    this.#scopeTimelines = new Map();
    this.#roleTimelines = new Map();
    this.#legacyStates = null;
  }

  versionAt(index) {
    return this.#versions[index];
  }

  inspectExtensionPlan(grant, currentIndex, projectAuthority) {
    if (grant.schemaVersion !== 2 || grant.operation !== "inspect" ||
        grantBrainBindingSchema(grant) !== CODE_JOB_TASK_BRAIN_BINDING_SCHEMA ||
        grant.writablePaths.length !== 0 || typeof projectAuthority !== "function" ||
        canonicalJsonDigest(grant.allowedActions) !== canonicalJsonDigest(CODE_JOB_ACTIONS_BY_OPERATION.inspect)) return null;
    const planKey = canonicalJsonDigest({ workspaceAuthorityDigest: grant.workspaceAuthorityDigest,
      repository: grant.repository, workspaceId: grant.workspaceId, roleId: grant.requestedBy.roleId,
      policyVersion: grant.policyVersion, brainDigest: grant.brainDigest, requiredProfiles: grant.requiredProfiles });
    if (this.#inspectPlans.has(planKey)) return this.#inspectPlans.get(planKey);
    const workspaceAt = configuration => configuration.codeExecutor.workspaces.find(x => x.id === grant.workspaceId);
    const currentConfiguration = this.#versions[currentIndex].configuration;
    const currentWorkspace = workspaceAt(currentConfiguration);
    const gitSettings = configuration => canonicalJsonDigest({
      command: configuration.codeExecutor.gitCommand ?? null,
      timeoutMs: configuration.codeExecutor.gitTimeoutMs ?? null,
    });
    let projection = null;
    let projectionPaths = null;
    let plan = null;
    for (let candidate = currentIndex - 1; currentWorkspace && candidate >= 0; candidate--) {
      const originalConfiguration = this.#versions[candidate].configuration;
      const nextConfiguration = this.#versions[candidate + 1].configuration;
      const original = workspaceAt(originalConfiguration);
      const next = workspaceAt(nextConfiguration);
      if (!original || !next || original.writablePaths.some(entry => !next.writablePaths.includes(entry)) ||
          gitSettings(originalConfiguration) !== gitSettings(nextConfiguration) ||
          roleTaskBrainDigest(originalConfiguration, grant.requestedBy.roleId) !==
            roleTaskBrainDigest(nextConfiguration, grant.requestedBy.roleId)) break;
      if (original.writablePaths.length >= currentWorkspace.writablePaths.length) continue;
      // Rebuild only the historical write list against the current runtime's
      // exact Git, source, exclusion and profile boundaries. Never accept a
      // caller-supplied digest or change the persisted grant.
      const pathsKey = canonicalJsonDigest(original.writablePaths);
      if (projectionPaths !== pathsKey) {
        const executorAuthority = projectAuthority({ workspaceId: grant.workspaceId,
          writablePaths: original.writablePaths });
        const versions = this.#versions.map((version, index) => {
          if (index <= candidate) return version;
          const configuration = structuredClone(version.configuration);
          workspaceAt(configuration).writablePaths = [...original.writablePaths];
          return { ...version, configuration, digest: canonicalJsonDigest(configuration) };
        });
        const history = new AuthorityHistory(versions, executorAuthority);
        projection = { executorAuthority, history, active: versions[currentIndex],
          timeline: history.verificationTimeline(grant).scopedDigests };
        projectionPaths = pathsKey;
      }
      const { executorAuthority, timeline } = projection;
      // Keeping all prior epochs prevents revocation followed by restoration
      // from resurrecting a checkpoint, including changes unrelated to writes.
      if (timeline[candidate] !== grant.workspaceAuthorityDigest ||
          timeline[currentIndex] !== grant.workspaceAuthorityDigest ||
          !configurationAdmitsGrant(currentConfiguration, grant, executorAuthority)) continue;
      plan = projection;
      break;
    }
    this.#inspectPlans.set(planKey, plan);
    if (this.#inspectPlans.size > 32) this.#inspectPlans.delete(this.#inspectPlans.keys().next().value);
    return plan;
  }

  verificationTimeline(grant) {
    const brainBindingSchema = grantBrainBindingSchema(grant);
    const scope = {
      executorAuthorityDigest: executorWorkspaceAuthorityDigest(
        this.#executorAuthority,
        grant.workspaceId,
      ),
      policyVersion: grant.policyVersion,
      repository: grant.repository,
      workspaceId: grant.workspaceId,
      roleId: grant.requestedBy.roleId,
      operation: grant.operation,
      executionSource: grant.schemaVersion === 3 ? grant.executionSource : null,
    };
    const scopedDigests = this.#scopeTimeline(scope, brainBindingSchema);
    let legacyStates = this.#legacyStates;
    if (!legacyStates) {
      let legacyAuthority = { digest: null, epoch: 0 };
      legacyStates = this.#versions.map(({ configuration }) => {
        const digest = legacyConfigurationAuthorityDigest(configuration);
        legacyAuthority = {
          digest,
          epoch:
            legacyAuthority.epoch +
            (legacyAuthority.digest === digest ? 0 : 1),
        };
        return legacyAuthority;
      });
      this.#legacyStates = legacyStates;
    }
    const legacyDigests = legacyStates.map((authority) =>
      legacyWorkspaceAuthorityDigest(
        this.#executorAuthority,
        authority,
        grant.workspaceId,
      ),
    );
    return {
      scopedDigests,
      legacyStates,
      legacyDigests,
    };
  }

  scopeAuthorityDigestAt(
    index,
    scope,
    brainBindingSchema = CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
  ) {
    return this.#scopeTimeline(scope, brainBindingSchema)[index];
  }

  roleAuthorityDigestAt(
    index,
    roleId,
    brainBindingSchema = CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
  ) {
    const timelineKey = `${brainBindingSchema}:${roleId}`;
    let timeline = this.#roleTimelines.get(timelineKey);
    if (!timeline) {
      let authority = { epoch: 0, fingerprint: null };
      timeline = this.#versions.map(({ configuration }) => {
        authority = advanceAuthority(
          authority,
          canonicalJsonDigest(
            roleAuthority(configuration, roleId, brainBindingSchema),
          ),
        );
        return roleAuthorityDigest(authority, brainBindingSchema);
      });
      this.#roleTimelines.set(timelineKey, timeline);
    }
    return timeline[index];
  }

  #scopeTimeline(scope, brainBindingSchema) {
    const key = canonicalJsonDigest({
      brainBindingSchema,
      scope: codeJobAuthorityScopeCacheIdentity(scope),
    });
    let timeline = this.#scopeTimelines.get(key);
    if (timeline) return timeline;
    let authority = { epoch: 0, fingerprint: null };
    timeline = this.#versions.map(({ configuration }) => {
      authority = advanceAuthority(
        authority,
        canonicalJsonDigest(
          grantAuthority(
            configuration,
            {
              repository: scope.repository,
              workspaceId: scope.workspaceId,
              roleId: scope.roleId,
              executionSource: scope.executionSource,
            },
            brainBindingSchema,
          ),
        ),
      );
      return grantAuthorityDigest(authority, scope, brainBindingSchema);
    });
    this.#scopeTimelines.set(key, timeline);
    return timeline;
  }

}

function legacyExecutorAuthority(value, authority) {
  if (!value || !Array.isArray(value.workspaces)) {
    throw invalid("代码执行器授权无效");
  }
  return {
    workspaces: value.workspaces.map((workspace) => ({
      ...workspace,
      authorityDigest: canonicalJsonDigest({
        executorAuthorityDigest: workspace.authorityDigest,
        configurationAuthorityDigest: authority.digest,
        configurationAuthorityEpoch: authority.epoch,
      }),
    })),
  };
}

function enabledCodeRoles(configuration) {
  const roles = configuration.employees.roles;
  return configuration.workCoordination.policy.codeActionRoles.filter(
    (roleId) => {
      const role = roles[roleId];
      return (
        role?.enabled === true &&
        role.permissions.allowedIntents.includes("propose_code_action")
      );
    },
  );
}

function roleTaskBrains(roles, roleIds) {
  return Object.fromEntries(
    roleIds.map((roleId) => [roleId, roles[roleId].taskBrain ?? null]),
  );
}

function legacyRoleBrains(roles, roleIds) {
  return Object.fromEntries(
    roleIds.map((roleId) => [roleId, roles[roleId].brain]),
  );
}

function roleOperations(policy, roleIds) {
  return Object.fromEntries(
    roleIds.map((roleId) => [roleId, policy.codeOperationsByRole[roleId]]),
  );
}

function requireTrackedRepository(configuration, repository) {
  if (!configuration.trackedRepositories.includes(repository)) {
    throw invalid("代码任务仓库已不在活动跟踪范围内");
  }
}

function decisionAuthorization(value) {
  const keys = value && typeof value === "object" ? Reflect.ownKeys(value) : [];
  const hasSignal = keys.includes("signal");
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    keys.length !== (hasSignal ? 3 : 2) ||
    !keys.includes("beforeGenerate") ||
    !keys.includes("brainDigest")
  ) {
    throw new TypeError("code brain authorization is invalid");
  }
  const brainDigest = Object.getOwnPropertyDescriptor(value, "brainDigest");
  const signal = hasSignal ? Object.getOwnPropertyDescriptor(value, "signal") : null;
  if (
    !brainDigest?.enumerable ||
    !("value" in brainDigest) ||
    typeof brainDigest.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(brainDigest.value) ||
    (hasSignal && (!signal?.enumerable || !("value" in signal)))
  ) {
    throw new TypeError("code brain authorization is invalid");
  }
  return {
    beforeGenerate: method(value, "beforeGenerate", "code brain authorization"),
    brainDigest: brainDigest.value,
    ...(hasSignal ? { signal: normalizeAbortSignal(signal.value) } : {}),
  };
}

function decisionRoleId(value) {
  const descriptor = value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "roleId")
    : null;
  if (
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(descriptor.value)
  ) {
    throw new TypeError("code brain roleId is invalid");
  }
  return descriptor.value;
}

function grantBrainBindingSchema(grant) {
  return Object.hasOwn(grant, "brainBindingSchema")
    ? CODE_JOB_TASK_BRAIN_BINDING_SCHEMA
    : CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA;
}

function roleTaskBrainDigest(configuration, roleId) {
  const role = configuration.employees.roles[roleId];
  if (!role?.taskBrain) return null;
  return codeJobBrainDigest({
    roleId,
    taskBrain: role.taskBrain,
    brainProviders: configuration.brainProviders,
  });
}

function roleBrainDigestMatches(configuration, roleId, brainDigest, brainBindingSchema = CODE_JOB_TASK_BRAIN_BINDING_SCHEMA) {
  const brain = roleBrainForBinding(configuration.employees.roles[roleId], brainBindingSchema);
  return brain !== null && codeJobBrainBindingDigests({ roleId, brain,
    brainProviders: configuration.brainProviders, brainBindingSchema }).includes(brainDigest);
}

function executableConfiguration(configuration) {
  return (
    configuration.codeExecutor.enabled === true &&
    configuration.workCoordination.enabled === true &&
    configuration.memory.enabled === true
  );
}

function configurationAdmitsRole(configuration, roleId) {
  const role = configuration.employees.roles[roleId];
  return (
    executableConfiguration(configuration) &&
    role?.enabled === true &&
    role.permissions.allowedIntents.includes("propose_code_action") &&
    configuration.workCoordination.policy.codeActionRoles.includes(roleId)
  );
}

function configurationAdmitsGrant(configuration, grant, executorAuthority) {
  const roleId = grant.requestedBy.roleId;
  const policy = configuration.workCoordination.policy;
  const workspace = executorAuthority?.workspaces?.find(
    ({ id }) => id === grant.workspaceId,
  );
  if (
    !configurationAdmitsRole(configuration, roleId) ||
    policy.version !== grant.policyVersion ||
    policy.workspaceByRepository[grant.repository] !== grant.workspaceId ||
    !policy.codeOperationsByRole[roleId]?.includes(grant.operation) ||
    !configuration.trackedRepositories.includes(grant.repository) ||
    !workspace ||
    !roleBrainDigestMatches(configuration, roleId, grant.brainDigest, grantBrainBindingSchema(grant))
  ) {
    return false;
  }
  const expectedWritablePaths = grant.schemaVersion === 3
    ? codeExecutionSourceWritablePaths(grant.executionSource)
    : grant.operation === "modify"
      ? workspace.writablePaths
      : [];
  if (grant.schemaVersion === 3) {
    if (
      grant.operation !== "modify" ||
      !workspace.capabilities?.includes(isHeadRepairExecutionSource(grant.executionSource)
        ? "git_head_snapshot" : "conflict_preparation_snapshot") ||
      (isHeadRepairExecutionSource(grant.executionSource) &&
        (configuration.githubActions?.automaticOwnPrRepair !== true ||
          canonicalJsonDigest(expectedWritablePaths) !== canonicalJsonDigest([...workspace.writablePaths].sort((left, right) => left.localeCompare(right, "en")))))
    ) {
      return false;
    }
    const executionPolicy = new CodeExecutionPolicy({
      writablePaths: workspace.writablePaths,
      excludePaths: workspace.excludePaths ?? [],
    });
    try {
      for (const conflictPath of expectedWritablePaths) {
        executionPolicy.assertWritable(conflictPath);
      }
    } catch {
      return false;
    }
  }
  return (
    canonicalJsonDigest({
      writablePaths: grant.writablePaths,
      requiredProfiles: grant.requiredProfiles,
    }) ===
    canonicalJsonDigest({
      writablePaths: expectedWritablePaths,
      requiredProfiles: workspace.requiredProfiles,
    })
  );
}

function configurationHistory(value, current) {
  if (!value || !Array.isArray(value.versions)) {
    throw invalid("配置历史不可用");
  }
  if (value.versions.length !== current.version) {
    throw invalid("配置历史与当前活动版本不一致");
  }
  const versions = value.versions.map((entry, index) => {
    const version = activeConfiguration(entry);
    if (version.version !== index + 1) {
      throw invalid("配置历史版本不连续");
    }
    return version;
  });
  const latest = versions.at(-1);
  if (
    !latest ||
    latest.version !== current.version ||
    latest.digest !== current.digest
  ) {
    throw invalid("配置历史与当前活动版本不一致");
  }
  return versions;
}

export class VersionedCodeJobAuthority {
  #readActive;
  #readSnapshot;
  #executorAuthority;
  #inspectAuthorityForWritablePaths;
  #startupCodeExecutorDigest;
  #brainDependencies;
  #grantFactoryFactory;
  #brainDirectoryFactory;
  #actionAdmission;
  #inputAuthorityVerifier;
  #conflictPreparationVerifier;
  #cache;
  #contexts;
  #directoryRuntimes;
  #closed = false;
  #closeAttempt = null;
  #closeResult = null;

  constructor({
    configurationReader,
    executorAuthority,
    inspectAuthorityForWritablePaths = null,
    startupConfiguration,
    brainDependencies = {},
    actionAdmissionGate,
    inputAuthorityVerifier,
    conflictPreparationVerifier,
    grantFactoryFactory = (options) => new CodeJobGrantFactory(options),
    brainDirectoryFactory = createConfiguredCodeJobBrainDirectory,
  } = {}) {
    this.#readActive = method(
      configurationReader,
      "readActive",
      "configurationReader",
    );
    this.#readSnapshot = method(
      configurationReader,
      "readSnapshot",
      "configurationReader",
    );
    this.#actionAdmission = method(
      actionAdmissionGate,
      "run",
      "actionAdmissionGate",
    );
    if (
      inputAuthorityVerifier !== undefined &&
      (!inputAuthorityVerifier ||
        typeof inputAuthorityVerifier.verify !== "function")
    ) {
      throw new TypeError("inputAuthorityVerifier must provide verify(binding)");
    }
    this.#inputAuthorityVerifier = Object.freeze({
      verify: inputAuthorityVerifier === undefined
        ? () => {
            throw invalid("PR 当前 Head 授权校验器未配置");
          }
        : inputAuthorityVerifier.verify.bind(inputAuthorityVerifier),
    });
    if (
      conflictPreparationVerifier !== undefined &&
      (!conflictPreparationVerifier ||
        typeof conflictPreparationVerifier.verify !== "function")
    ) {
      throw new TypeError(
        "conflictPreparationVerifier must provide verify(binding)",
      );
    }
    this.#conflictPreparationVerifier = Object.freeze({
      verify: conflictPreparationVerifier === undefined
        ? () => {
            throw invalid("Conflict preparation 校验器未配置");
          }
        : conflictPreparationVerifier.verify.bind(conflictPreparationVerifier),
    });
    if (typeof grantFactoryFactory !== "function") {
      throw new TypeError("grantFactoryFactory must be a function");
    }
    if (typeof brainDirectoryFactory !== "function") {
      throw new TypeError("brainDirectoryFactory must be a function");
    }
    const startup = normalizeConfigurationDocument(startupConfiguration);
    this.#executorAuthority = executorAuthority;
    if (inspectAuthorityForWritablePaths !== null && typeof inspectAuthorityForWritablePaths !== "function") {
      throw new TypeError("inspectAuthorityForWritablePaths must be a function");
    }
    this.#inspectAuthorityForWritablePaths = inspectAuthorityForWritablePaths;
    this.#startupCodeExecutorDigest = canonicalJsonDigest(startup.codeExecutor);
    this.#brainDependencies = brainDependencies;
    this.#grantFactoryFactory = grantFactoryFactory;
    this.#brainDirectoryFactory = brainDirectoryFactory;
    this.#cache = null;
    this.#contexts = new Map();
    this.#directoryRuntimes = new Map();
    Object.freeze(this);
  }

  async create(value) {
    this.#assertOpen();
    const context = await this.#current();
    const result = await context.grants.create(value);
    this.#assertOpen();
    const repository = result?.grant?.repository;
    if (typeof repository !== "string") {
      throw invalid("代码任务授权创建器返回了无效结果");
    }
    requireTrackedRepository(context.configuration, repository);
    return result;
  }

  async verify(value) {
    this.#assertOpen();
    const grant = prepareCodeJobGrantVerification(value);
    const current = await this.#current();
    requireTrackedRepository(current.configuration, grant.repository);
    const timeline = current.history.verificationTimeline(grant);
    const currentIndex = current.historyIndex;
    let currentError;
    try {
      return await this.#verifyWithContext(grant, current, current);
    } catch (error) {
      if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      currentError = error;
    }

    if (
      timeline.scopedDigests[currentIndex] ===
      grant.workspaceAuthorityDigest
    ) {
      const candidateIndex = this.#grantCandidateIndex(
        current,
        grant,
        timeline.scopedDigests,
        currentIndex - 1,
      );
      if (candidateIndex !== null) {
        const context = this.#context(
          current.history.versionAt(candidateIndex),
          current.history,
          candidateIndex,
        );
        try {
          return await this.#verifyWithContext(grant, context, current);
        } catch (error) {
          if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
        }
      }
    }

    if (
      timeline.legacyDigests[currentIndex] ===
      grant.workspaceAuthorityDigest
    ) {
      const candidateIndex = this.#grantCandidateIndex(
        current,
        grant,
        timeline.legacyDigests,
        currentIndex,
      );
      if (candidateIndex !== null) {
        const context = {
          ...this.#legacyContext(
            current.history.versionAt(candidateIndex),
            timeline.legacyStates[candidateIndex],
          ),
          currentAuthority: timeline.legacyStates[currentIndex],
        };
        try {
          return await this.#verifyLegacy(grant, context, current);
        } catch (error) {
          if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
        }
      }
    }
    const inspectPlan = current.history.inspectExtensionPlan(grant, currentIndex,
      this.#inspectAuthorityForWritablePaths);
    if (inspectPlan) {
      const context = this.#context(inspectPlan.active, inspectPlan.history, currentIndex, {
        executorAuthority: inspectPlan.executorAuthority,
        cacheKey: `inspect:${grant.workspaceAuthorityDigest}`,
      });
      return this.#verifyWithContext(grant, context, context);
    }
    throw currentError;
  }

  #grantCandidateIndex(current, grant, authorityDigests, maximumIndex) {
    for (let index = maximumIndex; index >= 0; index -= 1) {
      if (
        authorityDigests[index] === grant.workspaceAuthorityDigest &&
        configurationAdmitsGrant(
          current.history.versionAt(index).configuration,
          grant,
          this.#executorAuthority,
        )
      ) {
        return index;
      }
    }
    return null;
  }

  #brainCandidateContext(current, roleId, brainDigest) {
    if (configurationAdmitsRole(current.configuration, roleId) &&
        roleBrainDigestMatches(current.configuration, roleId, brainDigest)) return current;
    for (let index = current.historyIndex - 1; index >= 0; index -= 1) {
      const version = current.history.versionAt(index);
      try {
        if (
          configurationAdmitsRole(version.configuration, roleId) &&
          roleBrainDigestMatches(version.configuration, roleId, brainDigest)
        ) {
          return this.#context(version, current.history, index);
        }
      } catch (error) {
        if (error?.code !== "INVALID_CODE_JOB_AUTHORITY") throw error;
      }
    }
    return null;
  }

  async describe(roleId, brainDigest) {
    this.#assertOpen();
    decisionRoleId({ roleId });
    if (brainDigest !== undefined &&
        (typeof brainDigest !== "string" || !/^[a-f0-9]{64}$/.test(brainDigest))) {
      throw new TypeError("code brain digest is invalid");
    }
    const current = await this.#current();
    const context = brainDigest === undefined || current.brainDigests.get(roleId) === brainDigest
      ? current : this.#brainCandidateContext(current, roleId, brainDigest);
    if (!context || current.roleAuthorityDigest(roleId) === undefined ||
        current.roleAuthorityDigest(roleId) !== context.roleAuthorityDigest(roleId)) {
      throw invalid("岗位大脑封印已不受当前活动配置授权");
    }
    const describe = optionalMethod(this.#directory(context), "describe");
    const result = describe ? await describe(roleId) : { supportsCodeReading: false };
    this.#assertOpen();
    const latest = await this.#current();
    if (latest.roleAuthorityDigest(roleId) !== context.roleAuthorityDigest(roleId)) {
      throw invalid("岗位大脑配置在能力读取时已变化");
    }
    return result;
  }

  async withEntityQuiescence({ roleId, brainDigest, entityKey, signal = null }, operation) {
    this.#assertOpen();
    await this.describe(roleId, brainDigest);
    const current = await this.#current();
    const context = current.brainDigests.get(roleId) === brainDigest
      ? current : this.#brainCandidateContext(current, roleId, brainDigest);
    if (!context) return { executed: false };
    const directory = this.#directory(context);
    const quiescence = optionalMethod(directory, 'withEntityQuiescence');
    return quiescence ? quiescence({ roleId, entityKey, signal }, async () => {
      this.#assertOpen();
      const latest = await this.#current();
      if (latest.roleAuthorityDigest(roleId) !== context.roleAuthorityDigest(roleId)) return null;
      return operation();
    }) : { executed: false };
  }

  async decide(value, authorization) {
    this.#assertOpen();
    const { beforeGenerate, brainDigest, signal } = decisionAuthorization(authorization);
    const roleId = decisionRoleId(value);
    const current = await this.#current();
    let context = current.brainDigests.get(roleId) === brainDigest
      ? current
      : null;
    if (context === null) {
      context = this.#brainCandidateContext(current, roleId, brainDigest);
    }
    if (!context) {
      throw invalid("岗位大脑封印已不受当前活动配置授权");
    }
    const directory = this.#directory(context);
    const result = await directory.decide(value, {
      beforeGenerate: async () => {
        await beforeGenerate();
        this.#assertOpen();
        const latest = await this.#current();
        if (
          latest.roleAuthorityDigest(roleId) !==
          context.roleAuthorityDigest(roleId)
        ) {
          throw invalid("岗位大脑配置在调用前已变化");
        }
      },
      brainDigest,
      admitGenerate: this.#actionAdmission,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#assertOpen();
    return result;
  }

  async #current() {
    this.#assertOpen();
    const active = activeConfiguration(await this.#readActive());
    this.#assertOpen();
    if (
      this.#cache?.version === active.version &&
      this.#cache.digest === active.digest
    ) {
      return this.#cache;
    }
    const versions = configurationHistory(await this.#readSnapshot(), active);
    this.#assertOpen();
    const history = new AuthorityHistory(versions, this.#executorAuthority);
    this.#contexts.clear();
    this.#cache = this.#context(active, history, versions.length - 1, {
      requireStartupBoundary: true,
    });
    return this.#cache;
  }

  #context(
    active,
    history,
    historyIndex,
    { requireStartupBoundary = false, executorAuthority = this.#executorAuthority, cacheKey = null } = {},
  ) {
    this.#assertOpen();
    const contextKey = cacheKey ?? `${active.version}:${active.digest}`;
    const cached = this.#contexts.get(contextKey);
    if (cached) return cached;
    const configuration = active.configuration;
    if (
      !executableConfiguration(configuration) ||
      (requireStartupBoundary &&
        canonicalJsonDigest(configuration.codeExecutor) !==
          this.#startupCodeExecutorDigest)
    ) {
      throw invalid("代码执行边界已变化，需要重启后才能接纳新动作");
    }
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    if (roleIds.length === 0) {
      throw invalid("活动配置没有可执行代码动作的岗位");
    }
    const scopeAuthorityDigest = (scope) => {
      if (scope.executionSource !== null) {
        const conflict = conflictPreparationAuthority(
          configuration,
          scope.executionSource,
        );
        if (
          !conflict.enabled ||
          (!isHeadRepairExecutionSource(scope.executionSource) && conflict.baseMirror === null) ||
          conflict.headMirror === null
        ) {
          throw invalid("Conflict preparation 的仓库镜像授权未配置");
        }
      }
      return history.scopeAuthorityDigestAt(
        historyIndex,
        scope,
        CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
      );
    };
    const grants = this.#grantFactoryFactory({
      executorAuthority,
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      taskBrainByRole: roleTaskBrains(configuration.employees.roles, roleIds),
      brainProviders: configuration.brainProviders,
      scopeAuthorityDigest,
      inputAuthorityVerifier: this.#inputAuthorityVerifier,
      conflictPreparationVerifier: this.#conflictPreparationVerifier,
    });
    method(grants, "create", "versioned code job grant factory");
    method(grants, "verify", "versioned code job grant factory");
    const context = {
      version: active.version,
      digest: active.digest,
      configuration,
      roleAuthorityDigest: (roleId) =>
        roleIds.includes(roleId)
          ? history.roleAuthorityDigestAt(
              historyIndex,
              roleId,
              CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
            )
          : undefined,
      brainDigests: new Map(
        roleIds.map((roleId) => [
          roleId,
          roleTaskBrainDigest(configuration, roleId),
        ]),
      ),
      grantAuthorityDigest: (grant) =>
        history.scopeAuthorityDigestAt(
          historyIndex,
          {
            executorAuthorityDigest: executorWorkspaceAuthorityDigest(
              executorAuthority,
              grant.workspaceId,
            ),
            repository: grant.repository,
            workspaceId: grant.workspaceId,
            roleId: grant.requestedBy.roleId,
            operation: grant.operation,
            policyVersion: grant.policyVersion,
            executionSource:
              grant.schemaVersion === 3 ? grant.executionSource : null,
          },
          grantBrainBindingSchema(grant),
        ),
      grants,
      legacyGrants: null,
      directory: null,
      history,
      historyIndex,
    };
    this.#contexts.set(contextKey, context);
    if (this.#contexts.size > 32) {
      this.#contexts.delete(this.#contexts.keys().next().value);
    }
    return context;
  }

  #legacyContext(active, authority) {
    const configuration = active.configuration;
    if (
      configuration.codeExecutor.enabled !== true ||
      configuration.workCoordination.enabled !== true ||
      configuration.memory.enabled !== true
    ) {
      throw invalid("旧版代码任务授权上下文已不可用");
    }
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    if (roleIds.length === 0) {
      throw invalid("旧版配置没有可执行代码动作的岗位");
    }
    const grants = this.#grantFactoryFactory({
      executorAuthority: legacyExecutorAuthority(
        this.#executorAuthority,
        authority,
      ),
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      legacyBrainByRole: legacyRoleBrains(
        configuration.employees.roles,
        roleIds,
      ),
      brainProviders: configuration.brainProviders,
      inputAuthorityVerifier: this.#inputAuthorityVerifier,
      conflictPreparationVerifier: this.#conflictPreparationVerifier,
    });
    method(grants, "verify", "legacy code job grant factory");
    return { authority, grants };
  }

  async #verifyWithContext(value, context, current) {
    this.#assertOpen();
    const verifier = ![2, 3].includes(value.schemaVersion) ||
        grantBrainBindingSchema(value) === CODE_JOB_TASK_BRAIN_BINDING_SCHEMA
      ? context.grants
      : this.#legacyScopedGrants(context);
    const grant = await verifier.verify(value);
    this.#assertOpen();
    if (!grant || typeof grant.repository !== "string") {
      throw invalid("代码任务授权校验器返回了无效结果");
    }
    requireTrackedRepository(current.configuration, grant.repository);
    if (
      current.grantAuthorityDigest(grant) !== grant.workspaceAuthorityDigest
    ) {
      throw invalid("代码任务授权已被相关活动配置失效");
    }
    return grant;
  }

  #legacyScopedGrants(context) {
    if (context.legacyGrants) return context.legacyGrants;
    const configuration = context.configuration;
    const policy = configuration.workCoordination.policy;
    const roleIds = enabledCodeRoles(configuration);
    const grants = this.#grantFactoryFactory({
      executorAuthority: this.#executorAuthority,
      policyVersion: policy.version,
      workspaceByRepository: policy.workspaceByRepository,
      codeActionRoles: roleIds,
      codeOperationsByRole: roleOperations(policy, roleIds),
      legacyBrainByRole: legacyRoleBrains(
        configuration.employees.roles,
        roleIds,
      ),
      brainProviders: configuration.brainProviders,
      scopeAuthorityDigest: (scope) =>
        context.history.scopeAuthorityDigestAt(
          context.historyIndex,
          scope,
          CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA,
        ),
      inputAuthorityVerifier: this.#inputAuthorityVerifier,
      conflictPreparationVerifier: this.#conflictPreparationVerifier,
    });
    method(grants, "verify", "legacy scoped code job grant factory");
    context.legacyGrants = grants;
    return grants;
  }

  async #verifyLegacy(value, context, current) {
    this.#assertOpen();
    const grant = await context.grants.verify(value);
    this.#assertOpen();
    if (!grant || typeof grant.repository !== "string") {
      throw invalid("旧版代码任务授权校验器返回了无效结果");
    }
    requireTrackedRepository(current.configuration, grant.repository);
    if (
      context.authority.digest !== context.currentAuthority.digest ||
      context.authority.epoch !== context.currentAuthority.epoch
    ) {
      throw invalid("旧版代码任务授权已被全局配置失效");
    }
    return grant;
  }

  #directory(context) {
    this.#assertOpen();
    if (context.directory) return context.directory;
    const constructionCleanupOwner =
      createConfiguredConstructionCleanupOwner();
    try {
      const directory = this.#brainDirectoryFactory({
        brainProviders: context.configuration.brainProviders,
        roles: context.configuration.employees.roles,
        dependencies: this.#brainDependencies,
        constructionCleanupOwner,
      });
      this.#drainConstructionCleanups(constructionCleanupOwner);
      const close = optionalMethod(directory, "close");
      if (close) this.#retainDirectoryRuntime(directory, close);
      method(directory, "decide", "versioned code job brain directory");
      context.directory = directory;
      return directory;
    } catch (error) {
      this.#drainConstructionCleanups(constructionCleanupOwner);
      throw error;
    }
  }

  #drainConstructionCleanups(constructionCleanupOwner) {
    let cleanup = readConfiguredConstructionCleanup(
      constructionCleanupOwner,
    );
    while (cleanup) {
      this.#retainDirectoryRuntime(cleanup, cleanup.close);
      cleanup = readConfiguredConstructionCleanup(
        constructionCleanupOwner,
      );
    }
  }

  #retainDirectoryRuntime(owner, close) {
    if (this.#directoryRuntimes.has(owner)) return;
    this.#directoryRuntimes.set(owner, { close, closed: false });
  }

  close() {
    if (this.#closeAttempt) return this.#closeAttempt;
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    const attempt = this.#closeDirectories();
    this.#closeAttempt = attempt;
    void attempt.then(
      () => {
        if (this.#closeAttempt !== attempt) return;
        this.#closeResult = attempt;
        this.#closeAttempt = null;
      },
      () => {
        if (this.#closeAttempt === attempt) this.#closeAttempt = null;
      },
    );
    return attempt;
  }

  async #closeDirectories() {
    const failures = [];
    const runtimes = [...this.#directoryRuntimes.values()];
    for (let index = runtimes.length - 1; index >= 0; index -= 1) {
      const runtime = runtimes[index];
      if (runtime.closed) continue;
      try {
        await runtime.close();
        runtime.closed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Versioned code job brain directory cleanup failed",
      );
    }
  }

  #assertOpen() {
    if (this.#closed) {
      throw invalid("代码任务大脑授权已关闭");
    }
  }
}
