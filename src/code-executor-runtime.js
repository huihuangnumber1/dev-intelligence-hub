import path from "node:path";
import { types as utilTypes } from "node:util";
import { DockerTestSandbox } from "./adapters/docker-test-sandbox.js";
import { WindowsFixedTestRunner } from "./adapters/windows-fixed-test-runner.js";
import { ConfiguredTestRunner } from "./adapters/configured-test-runner.js";
import { InspectionEnvironmentRecoveryReader } from './adapters/inspection-environment-recovery-reader.js';
import { SettledVerificationRecoveryReader } from './adapters/settled-verification-recovery-reader.js';
import { isWindowsTestProfile } from "./domain/windows-test-profile.js";
import { GitObjectSnapshotter } from "./adapters/git-object-snapshotter.js";
import { createControlledGitRuntimeBundle } from "./controlled-git-runtime.js";
import { projectRoot } from "./lib/config.js";
import { StateStore } from "./lib/state-store.js";
import { digestValue } from "./domain/code-executor-contract.js";
import { CodeExecutionJournal } from "./services/code-execution-journal.js";
import { CodeWorkspaceBroker } from "./services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "./services/controlled-code-executor.js";

const WORKSPACE_KEYS = new Set([
  "id",
  "sourceRoot",
  "writablePaths",
  "excludePaths",
  "gitHeadSnapshot",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;

export class CodeExecutorRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodeExecutorRuntimeError";
    this.code = code;
  }
}

function invalidConfig(message = "代码执行器运行配置无效") {
  return new CodeExecutorRuntimeError("INVALID_CODE_EXECUTOR_CONFIG", message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value) {
  if (!isPlainRecord(value)) throw invalidConfig();
}

function resolveAbsolutePath(value, baseDirectory) {
  if (typeof value !== "string" || value.length === 0) throw invalidConfig();
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(baseDirectory, value);
}

function normalizeStringArray(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalidConfig();
  }
  return [...value];
}

function normalizeWorkspaces(workspaces, sourceBaseRoot) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw invalidConfig("至少需要配置一个可信代码工作区");
  }
  return workspaces.map((workspace) => {
    assertRecord(workspace);
    if (
      Reflect.ownKeys(workspace).some(
        (key) => typeof key !== "string" || !WORKSPACE_KEYS.has(key),
      )
    ) {
      throw invalidConfig();
    }
    return {
      id: workspace.id,
      sourceRoot: resolveAbsolutePath(workspace.sourceRoot, sourceBaseRoot),
      writablePaths: normalizeStringArray(workspace.writablePaths),
      excludePaths: normalizeStringArray(workspace.excludePaths),
      gitHeadSnapshot: workspace.gitHeadSnapshot === undefined
        ? false
        : workspace.gitHeadSnapshot,
    };
  });
}

function normalizeGitSettings(config, workspaces) {
  const enabled = workspaces.some((workspace) => workspace.gitHeadSnapshot);
  if (
    workspaces.some(
      (workspace) => typeof workspace.gitHeadSnapshot !== "boolean",
    )
  ) {
    throw invalidConfig("Git Head snapshot 工作区开关无效");
  }
  if (!enabled) return null;
  if (
    typeof config.gitCommand !== "string" ||
    !path.isAbsolute(config.gitCommand) ||
    config.gitCommand.includes("\0")
  ) {
    throw invalidConfig("gitCommand 必须是可信的绝对路径");
  }
  const timeoutMs = config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw invalidConfig("gitTimeoutMs 无效");
  }
  return Object.freeze({
    command: path.resolve(config.gitCommand),
    timeoutMs,
  });
}

function assertWorkspaceProfileCoverage(workspaces, requiredProfiles) {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  for (const workspaceId of workspaceIds) {
    if (!Object.hasOwn(requiredProfiles, workspaceId)) {
      throw invalidConfig("每个代码工作区都必须绑定固定测试配置");
    }
  }
  if (
    Object.keys(requiredProfiles).some(
      (workspaceId) => !workspaceIds.has(workspaceId),
    )
  ) {
    throw invalidConfig("测试配置引用了未知代码工作区");
  }
}

function normalizeEnabledConfig(config) {
  if (config === undefined) return null;
  assertRecord(config);
  if (config.enabled === false || config.enabled === undefined) return null;
  if (config.enabled !== true) throw invalidConfig();
  assertRecord(config.profiles);
  if (Object.values(config.profiles).some((profile) => !isWindowsTestProfile(profile))) assertRecord(config.docker);
  assertRecord(config.requiredProfilesByWorkspace);
  if (Object.keys(config.profiles).length === 0) {
    throw invalidConfig("至少需要配置一个固定测试配置");
  }
  return config;
}

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw invalidConfig();
  }
  return descriptor.value;
}

function configuredConflictGit(config, runtimeRoot) {
  const conflictPreparation = ownDataValue(config, "conflictPreparation");
  if (conflictPreparation === undefined) return undefined;
  if (utilTypes.isProxy(conflictPreparation)) throw invalidConfig();
  assertRecord(conflictPreparation);
  const enabled = ownDataValue(conflictPreparation, "enabled");
  const expectedKeys = enabled === false
    ? ["enabled"]
    : [
        "enabled",
        "baseMirrorsByRepository",
        "headMirrorsByRepository",
      ];
  const keys = Reflect.ownKeys(conflictPreparation);
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw invalidConfig("Conflict preparation 配置字段无效");
  }
  if (enabled === false) return { enabled: false };
  return {
    enabled,
    gitCommand: ownDataValue(config, "gitCommand"),
    preparationRoot: path.join(runtimeRoot, "conflict-preparations"),
    baseMirrorsByRepository: ownDataValue(
      conflictPreparation,
      "baseMirrorsByRepository",
    ),
    headMirrorsByRepository: ownDataValue(
      conflictPreparation,
      "headMirrorsByRepository",
    ),
  };
}

function resolveRuntimeRoot(value) {
  const runtimeRoot = value || path.join(projectRoot, "data", "code-executor");
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw invalidConfig("代码执行器数据目录无效");
  }
  return path.resolve(runtimeRoot);
}

function createWorkspaceAuthority(
  workspaces,
  requiredProfiles,
  sandbox,
  gitSettings,
  conflictMaterializerAvailable,
  inspectProjection = null,
) {
  return Object.freeze({
    workspaces: Object.freeze(
      workspaces.map((workspace) => {
        const writablePaths = inspectProjection?.workspaceId === workspace.id
          ? inspectProjection.writablePaths : workspace.writablePaths;
        const profiles = requiredProfiles[workspace.id].map((id) =>
          Object.freeze({
            id,
            configDigest: sandbox.getProfileFingerprint(id),
          }),
        );
        const capabilities = [
          "directory_snapshot",
          ...(workspace.gitBoundary === null ? [] : ["git_head_snapshot"]),
          ...(conflictMaterializerAvailable
            ? ["conflict_preparation_snapshot"]
            : []),
        ];
        const gitSnapshot = workspace.gitBoundary === null
          ? null
          : {
              command: gitSettings.command,
              timeoutMs: gitSettings.timeoutMs,
              ...workspace.gitBoundary,
            };
        return Object.freeze({
          id: workspace.id,
          capabilities: Object.freeze(capabilities),
          writablePaths: Object.freeze([...writablePaths]),
          excludePaths: Object.freeze([...workspace.excludePaths]),
          requiredProfiles: Object.freeze(profiles),
          authorityDigest: digestValue({
            schemaVersion: 3,
            workspaceId: workspace.id,
            capabilities,
            sourceRoot: workspace.sourceRoot,
            gitSnapshot,
            writablePaths,
            excludePaths: workspace.excludePaths,
            requiredProfiles: profiles,
          }),
        });
      }),
    ),
  });
}

function method(value, name, owner) {
  let current = value;
  while (
    current !== null &&
    current !== Object.prototype &&
    current !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        break;
      }
      return descriptor.value.bind(value);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`${owner} must provide ${name}`);
}

function bindGitSnapshotter(value) {
  return Object.freeze({
    preflight: method(value, "preflight", "gitSnapshotter"),
    materialize: method(value, "materialize", "gitSnapshotter"),
  });
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateGitBoundary(value, workspace, gitSettings) {
  if (!isPlainRecord(value)) throw invalidConfig("Git preflight 结果无效");
  const expectedKeys = [
    "schemaVersion",
    "gitCommand",
    "gitExecutableSha256",
    "gitExecutableBytes",
    "gitExecutableMode",
    "gitExecutableUid",
    "gitExecutableGid",
    "canonicalRoot",
    "absoluteGitDir",
    "commonDir",
    "objectDirectory",
    "objectFormat",
    "oidLength",
    "boundaryDigest",
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !expectedKeys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    }) ||
    value.schemaVersion !== 1 ||
    typeof value.gitCommand !== "string" ||
    !path.isAbsolute(value.gitCommand) ||
    value.gitCommand.includes("\0") ||
    !samePath(value.gitCommand, gitSettings.command) ||
    !SHA256.test(value.gitExecutableSha256) ||
    !Number.isSafeInteger(value.gitExecutableBytes) ||
    value.gitExecutableBytes < 1 ||
    value.gitExecutableBytes > MAX_GIT_EXECUTABLE_BYTES ||
    !Number.isSafeInteger(value.gitExecutableMode) ||
    value.gitExecutableMode < 0 ||
    value.gitExecutableMode > 0o7777 ||
    !Number.isSafeInteger(value.gitExecutableUid) ||
    value.gitExecutableUid < 0 ||
    !Number.isSafeInteger(value.gitExecutableGid) ||
    value.gitExecutableGid < 0 ||
    typeof value.canonicalRoot !== "string" ||
    !path.isAbsolute(value.canonicalRoot) ||
    !samePath(value.canonicalRoot, workspace.sourceRoot) ||
    typeof value.absoluteGitDir !== "string" ||
    !path.isAbsolute(value.absoluteGitDir) ||
    typeof value.commonDir !== "string" ||
    !path.isAbsolute(value.commonDir) ||
    typeof value.objectDirectory !== "string" ||
    !path.isAbsolute(value.objectDirectory) ||
    !samePath(value.objectDirectory, path.join(value.commonDir, "objects")) ||
    !["sha1", "sha256"].includes(value.objectFormat) ||
    value.oidLength !== (value.objectFormat === "sha1" ? 40 : 64) ||
    !SHA256.test(value.boundaryDigest)
  ) {
    throw invalidConfig("Git preflight 结果无效");
  }
  return Object.freeze({
    boundaryDigest: value.boundaryDigest,
    gitCommand: path.resolve(value.gitCommand),
    gitExecutableSha256: value.gitExecutableSha256,
    gitExecutableBytes: value.gitExecutableBytes,
    gitExecutableMode: value.gitExecutableMode,
    gitExecutableUid: value.gitExecutableUid,
    gitExecutableGid: value.gitExecutableGid,
    canonicalRoot: path.resolve(value.canonicalRoot),
    absoluteGitDir: path.resolve(value.absoluteGitDir),
    commonDir: path.resolve(value.commonDir),
    objectDirectory: path.resolve(value.objectDirectory),
    objectFormat: value.objectFormat,
    oidLength: value.oidLength,
  });
}

function snapshotLimits(brokerLimits = {}) {
  return Object.fromEntries(
    ["maxFiles", "maxDirectories", "maxFileBytes", "maxTotalBytes"]
      .filter((key) => brokerLimits[key] !== undefined)
      .map((key) => [key, brokerLimits[key]]),
  );
}

function controlledGitDependencies(dependencies, brokerLimits = {}) {
  const injected = ownDataValue(dependencies, "controlledGitDependencies") ?? {};
  if (utilTypes.isProxy(injected)) throw invalidConfig();
  assertRecord(injected);
  if (Object.hasOwn(injected, "limits")) throw invalidConfig("Controlled Git 大小限制必须来自工作区 broker 配置");
  const limits = Object.fromEntries(
    Object.entries(snapshotLimits(brokerLimits)).map(([key, value]) =>
      [key === "maxFileBytes" ? "maxBlobBytes" : key, value]),
  );
  return Object.defineProperties({ limits }, Object.getOwnPropertyDescriptors(injected));
}

function createChangePackageTargets(workspaces, authority) {
  const authorityByWorkspace = new Map(
    authority.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  return Object.freeze(
    workspaces.map((workspace) =>
      Object.freeze({
        workspaceId: workspace.id,
        sourceRoot: workspace.sourceRoot,
        targetAuthorityDigest:
          authorityByWorkspace.get(workspace.id).authorityDigest,
        writablePaths: Object.freeze([...workspace.writablePaths]),
        excludePaths: Object.freeze([...workspace.excludePaths]),
      }),
    ),
  );
}

function createCompletedChangeExporter(executor) {
  return Object.freeze({
    export: executor.exportCompletedChangeSet.bind(executor),
  });
}

function createAuditArtifactReader(journal) {
  return Object.freeze({
    read: journal.readBytes.bind(journal),
  });
}

export async function createCodeExecutorRuntime(config, dependencies = {}) {
  const enabledConfig = normalizeEnabledConfig(config);
  if (!enabledConfig) return null;

  const runtimeRoot = resolveRuntimeRoot(dependencies.runtimeRoot);
  const sourceBaseRoot = dependencies.sourceBaseRoot || projectRoot;
  if (
    typeof sourceBaseRoot !== "string" ||
    !path.isAbsolute(sourceBaseRoot)
  ) {
    throw invalidConfig("代码工作区基准目录无效");
  }
  const workspaces = normalizeWorkspaces(
    enabledConfig.workspaces,
    sourceBaseRoot,
  );
  assertWorkspaceProfileCoverage(
    workspaces,
    enabledConfig.requiredProfilesByWorkspace,
  );
  const gitSettings = normalizeGitSettings(enabledConfig, workspaces);
  const controlledGitConfig = configuredConflictGit(
    enabledConfig,
    runtimeRoot,
  );
  if (
    controlledGitConfig?.enabled === true &&
    dependencies.conflictMaterializer !== undefined
  ) {
    throw invalidConfig(
      "生产 Controlled Git 不能与注入 conflict materializer 混用",
    );
  }
  if (
    controlledGitConfig?.enabled === true &&
    dependencies.broker !== undefined
  ) {
    throw invalidConfig(
      "生产 Controlled Git 不能使用未验证的注入 broker",
    );
  }
  const controlledGitRuntime = await createControlledGitRuntimeBundle(
    controlledGitConfig,
    controlledGitConfig?.enabled === true
      ? controlledGitDependencies(dependencies, enabledConfig.brokerLimits)
      : ownDataValue(dependencies, "controlledGitDependencies") ?? {},
  );
  const injectedConflictMaterializer =
    dependencies.conflictMaterializer === undefined
      ? null
      : Object.freeze({
          materialize: method(
            dependencies.conflictMaterializer,
            "materialize",
            "conflictMaterializer",
          ),
        });
  const conflictMaterializer =
    controlledGitRuntime?.materializer ?? injectedConflictMaterializer;
  if (gitSettings && dependencies.broker !== undefined) {
    throw invalidConfig(
      "Git Head snapshot 工作区不能使用未验证的注入 broker",
    );
  }
  if (conflictMaterializer !== null && dependencies.broker !== undefined) {
    throw invalidConfig(
      "Conflict preparation 工作区不能使用未验证的注入 broker",
    );
  }
  let gitSnapshotter = null;
  if (gitSettings) {
    try {
      gitSnapshotter = bindGitSnapshotter(
        dependencies.gitSnapshotter ||
          new GitObjectSnapshotter({
            gitCommand: gitSettings.command,
            timeoutMs: gitSettings.timeoutMs,
            limits: snapshotLimits(enabledConfig.brokerLimits),
            ...(dependencies.gitProcessRunner
              ? { processRunner: dependencies.gitProcessRunner }
              : {}),
          }),
      );
      await Promise.all(
        workspaces.map(async (workspace) => {
          workspace.gitBoundary = workspace.gitHeadSnapshot
            ? validateGitBoundary(
                await gitSnapshotter.preflight({
                  sourceRoot: workspace.sourceRoot,
                }),
                workspace,
                gitSettings,
              )
            : null;
        }),
      );
    } catch (cause) {
      if (cause instanceof CodeExecutorRuntimeError) throw cause;
      throw new CodeExecutorRuntimeError(
        "GIT_HEAD_SNAPSHOT_PREFLIGHT_FAILED",
        "Git Head snapshot 工作区预检失败",
      );
    }
  } else {
    for (const workspace of workspaces) workspace.gitBoundary = null;
  }
  const store =
    dependencies.store || new StateStore(path.join(projectRoot, "data"));
  const broker =
    dependencies.broker ||
    new CodeWorkspaceBroker({
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        sourceRoot: workspace.sourceRoot,
        writablePaths: workspace.writablePaths,
        excludePaths: workspace.excludePaths,
        gitBoundaryDigest: workspace.gitBoundary?.boundaryDigest ?? null,
        gitExecutableIdentity: workspace.gitBoundary === null
          ? null
          : {
              gitCommand: workspace.gitBoundary.gitCommand,
              gitExecutableSha256:
                workspace.gitBoundary.gitExecutableSha256,
              gitExecutableBytes: workspace.gitBoundary.gitExecutableBytes,
              gitExecutableMode: workspace.gitBoundary.gitExecutableMode,
              gitExecutableUid: workspace.gitBoundary.gitExecutableUid,
              gitExecutableGid: workspace.gitBoundary.gitExecutableGid,
            },
      })),
      scratchRoot: path.join(runtimeRoot, "workspaces"),
      limits: enabledConfig.brokerLimits || {},
      gitSnapshotter,
      conflictMaterializer,
    });
  const journal =
    dependencies.journal ||
    new CodeExecutionJournal({
      root: path.join(runtimeRoot, "artifacts"),
      ...(enabledConfig.maxArtifactBytes === undefined
        ? {}
        : { maxArtifactBytes: enabledConfig.maxArtifactBytes }),
    });
  const sandbox =
    dependencies.sandbox ||
    new ConfiguredTestRunner({
      profiles: enabledConfig.profiles,
      ...(Object.values(enabledConfig.profiles).some((profile) => !isWindowsTestProfile(profile)) ? {
        dockerRunner: new DockerTestSandbox({
          dockerExecutable: enabledConfig.docker.executable,
          dockerHost: enabledConfig.docker.host,
          allowedWorkspaceRoot: path.join(runtimeRoot, "workspaces"),
          profiles: Object.fromEntries(Object.entries(enabledConfig.profiles).filter(([, profile]) => !isWindowsTestProfile(profile))),
          ...(dependencies.processRunner ? { processRunner: dependencies.processRunner } : {}),
          ...(dependencies.sourceEnvironment ? { sourceEnvironment: dependencies.sourceEnvironment } : {}),
        }),
      } : {}),
      ...(Object.values(enabledConfig.profiles).some(isWindowsTestProfile) ? {
        windowsRunner: new WindowsFixedTestRunner({
          allowedWorkspaceRoot: path.join(runtimeRoot, "workspaces"),
          runRoot: path.join(runtimeRoot, "windows-tests"),
          profiles: Object.fromEntries(Object.entries(enabledConfig.profiles).filter(([, profile]) => isWindowsTestProfile(profile))),
          ...(dependencies.sourceEnvironment ? { sourceEnvironment: dependencies.sourceEnvironment } : {}),
        }),
      } : {}),
    });
  const executor = new ControlledCodeExecutor({
    broker,
    sandbox,
    store,
    journal,
    profileDefinitions: enabledConfig.profiles,
    requiredProfilesByWorkspace:
      enabledConfig.requiredProfilesByWorkspace,
    limits: enabledConfig.executorLimits || {},
  });
  const recovery = await executor.recover();
  const authority = createWorkspaceAuthority(
    workspaces,
    enabledConfig.requiredProfilesByWorkspace,
    sandbox,
    gitSettings,
    conflictMaterializer !== null,
  );
  const changePackageTargets = createChangePackageTargets(
    workspaces,
    authority,
  );
  const inspectAuthorityForWritablePaths = ({ workspaceId, writablePaths }) => {
    const workspace = workspaces.find(entry => entry.id === workspaceId);
    if (!workspace || !Array.isArray(writablePaths) ||
        new Set(writablePaths).size !== writablePaths.length ||
        writablePaths.some(entry => !workspace.writablePaths.includes(entry))) {
      throw invalidConfig("只读历史授权只能投影当前可写路径的子集");
    }
    return createWorkspaceAuthority(workspaces, enabledConfig.requiredProfilesByWorkspace,
      sandbox, gitSettings, conflictMaterializer !== null,
      { workspaceId, writablePaths: [...writablePaths] });
  };
  const completedChangeExporter = createCompletedChangeExporter(executor);
  const auditArtifactReader = createAuditArtifactReader(journal);
  const settledVerificationReader = typeof sandbox.readSettledPreparationFailure === 'function'
    ? new SettledVerificationRecoveryReader({ executor, artifacts: auditArtifactReader, sandbox }) : null;
  const inspectionEnvironmentReader = typeof sandbox.readProfileReadiness === 'function'
    ? new InspectionEnvironmentRecoveryReader({ executor, artifacts: auditArtifactReader, sandbox }) : null;
  return Object.freeze({
    broker,
    sandbox,
    journal,
    executor,
    authority,
    inspectAuthorityForWritablePaths,
    changePackageTargets,
    completedChangeExporter,
    auditArtifactReader,
    settledVerificationReader,
    inspectionEnvironmentReader,
    conflictPreparationVerifier:
      controlledGitRuntime?.verifier ?? null,
    conflictExecutionSourcePreparer:
      controlledGitRuntime?.preparer ?? null,
    conflictInspectionReader:
      controlledGitRuntime?.inspectionReader ?? null,
    conflictSourceReader:
      controlledGitRuntime?.sourceReader ?? null,
    controlledCommitBuilder:
      controlledGitRuntime?.commitBuilder ?? null,
    controlledCommitPublisher:
      controlledGitRuntime?.publisher ?? null,
    recovery,
  });
}
