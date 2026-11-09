import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isWindowsGitImplementationPath } from "./lib/windows-git-implementation.js";
import { types as utilTypes } from "node:util";

import { GitBareMirrorInspector } from "./adapters/git-bare-mirror-inspector.js";
import {
  createConflictPreparationBinding,
  sameConflictPreparationBinding,
} from "./domain/conflict-preparation-binding.js";
import {
  createConflictCodeExecutionSource,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "./domain/code-execution-source.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "./domain/pull-request-execution-binding.js";
import { ControlledGitService } from "./services/controlled-git-service.js";

const CONFIG_KEYS = Object.freeze([
  "enabled",
  "gitCommand",
  "preparationRoot",
  "baseMirrorsByRepository",
  "headMirrorsByRepository",
]);
const DISABLED_CONFIG_KEYS = new Set(["enabled"]);
const REPOSITORY =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/u;
const MAX_MIRRORS_PER_ROLE = 1_000;
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const DEPENDENCY_KEYS = new Set([
  "mirrorInspector",
  "processRunner",
  "controlledGitServiceFactory",
  "limits",
]);

export class ControlledGitRuntimeError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlledGitRuntimeError";
    this.code = code;
  }
}

function runtimeError(code, message, cause) {
  return new ControlledGitRuntimeError(code, message, { cause });
}

function invalidConfig(message = "Controlled Git 运行配置无效", cause) {
  return runtimeError("INVALID_CONTROLLED_GIT_RUNTIME_CONFIG", message, cause);
}

function dataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactDataObject(value, expectedKeys, error) {
  const entries = dataEntries(value, error);
  if (
    entries.length !== expectedKeys.length ||
    expectedKeys.some(
      (expected) => !entries.some(([actual]) => actual === expected),
    )
  ) {
    throw error;
  }
  return new Map(entries);
}

function trustedRepository(value, error) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 140 ||
    !REPOSITORY.test(value)
  ) {
    throw error;
  }
  const [, owner, repository] = value.match(REPOSITORY);
  if (
    owner.includes("--") ||
    repository.includes("..") ||
    repository.startsWith(".") ||
    repository.endsWith(".")
  ) {
    throw error;
  }
  return value.toLowerCase();
}

function isNetworkPath(value) {
  return /^(?:\\\\|\/\/)/u.test(value);
}

function trustedAbsolutePath(value, name, error) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    isNetworkPath(value)
  ) {
    throw invalidConfig(`${name} 必须是可信的绝对本地路径`, error);
  }
  return path.resolve(value);
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDescendant(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return samePath(left, right) ||
    isDescendant(left, right) ||
    isDescendant(right, left);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameNodeIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    (left.mode & 0o170000) === (right.mode & 0o170000)
  );
}

async function canonicalDirectory(
  value,
  name,
  identityMatches = sameIdentity,
) {
  let initial;
  let canonical;
  let final;
  try {
    initial = await lstat(value);
    canonical = await realpath(value);
    final = await lstat(value);
  } catch (cause) {
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
      `${name} 不可用`,
      cause,
    );
  }
  if (
    initial.isSymbolicLink() ||
    !initial.isDirectory() ||
    !samePath(canonical, value) ||
    !identityMatches(initial, final)
  ) {
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
      `${name} 不是稳定的 canonical 本地目录`,
    );
  }
  return initial;
}

async function pathStatus(value, name) {
  try {
    return await lstat(value);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
      `${name} 不可用`,
      cause,
    );
  }
}

async function ensureCanonicalDirectory(value, name) {
  const root = path.parse(value).root;
  const relative = path.relative(root, value);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let parent = root;

  await canonicalDirectory(
    parent,
    `${name} 的根目录`,
    sameNodeIdentity,
  );
  for (const segment of segments) {
    const child = path.join(parent, segment);
    const parentBefore = await canonicalDirectory(
      parent,
      `${name} 的父目录`,
      sameNodeIdentity,
    );
    const existing = await pathStatus(child, name);
    if (existing === null) {
      try {
        await mkdir(child, { recursive: false, mode: 0o700 });
      } catch (cause) {
        if (cause?.code !== "EEXIST") {
          throw runtimeError(
            "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
            `${name} 无法安全创建`,
            cause,
          );
        }
      }
    }
    const childIdentity = await canonicalDirectory(
      child,
      name,
      sameNodeIdentity,
    );
    const parentAfter = await canonicalDirectory(
      parent,
      `${name} 的父目录`,
      sameNodeIdentity,
    );
    if (!sameNodeIdentity(parentBefore, parentAfter)) {
      throw runtimeError(
        "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
        `${name} 的父目录在创建期间发生变化`,
      );
    }
    parent = child;
    if (!sameNodeIdentity(existing ?? childIdentity, childIdentity)) {
      throw runtimeError(
        "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
        `${name} 在创建期间发生变化`,
      );
    }
  }
}

async function trustedGitExecutable(value) {
  let initial;
  let canonical;
  let final;
  try {
    initial = await lstat(value);
    canonical = await realpath(value);
    final = await lstat(value);
  } catch (cause) {
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
      "Git executable 不可用",
      cause,
    );
  }
  const permissions = initial.mode & 0o7777;
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size < 1 ||
    initial.size > MAX_GIT_EXECUTABLE_BYTES ||
    !samePath(canonical, value) ||
    !sameIdentity(initial, final) ||
    (process.platform === "win32"
      ? !isWindowsGitImplementationPath(canonical)
      : (permissions & 0o111) === 0 || (permissions & 0o7022) !== 0)
  ) {
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_PREFLIGHT_FAILED",
      "Git executable 身份不受信任",
    );
  }
}

async function preflightBoundaries(normalized) {
  await ensureCanonicalDirectory(
    normalized.preparationRoot,
    "preparationRoot",
  );
  await trustedGitExecutable(normalized.gitCommand);
  for (const [repository, mirrorRoot] of [
    ...normalized.baseMirrors.entries(),
    ...normalized.headMirrors.entries(),
  ]) {
    await canonicalDirectory(mirrorRoot, `仓库 ${repository} 的 mirror`);
  }
}

function normalizeDependencies(value) {
  const error = invalidConfig("Controlled Git 运行依赖无效");
  const entries = dataEntries(value, error);
  if (entries.some(([key]) => !DEPENDENCY_KEYS.has(key))) throw error;
  const result = Object.fromEntries(entries);
  if (Object.hasOwn(result, "limits")) {
    const limits = dataEntries(result.limits, error);
    const allowed = new Set(["maxFiles", "maxDirectories", "maxBlobBytes", "maxTotalBytes"]);
    if (limits.some(([key, value]) => !allowed.has(key) || !Number.isSafeInteger(value) || value < 1)) throw error;
    if ((result.limits.maxBlobBytes ?? 1_000_000) > (result.limits.maxTotalBytes ?? 8_000_000)) throw error;
    result.limits = Object.freeze(Object.fromEntries(limits));
  }
  if (
    Object.hasOwn(result, "controlledGitServiceFactory") &&
    (typeof result.controlledGitServiceFactory !== "function" ||
      utilTypes.isProxy(result.controlledGitServiceFactory))
  ) {
    throw error;
  }
  for (const name of ["mirrorInspector", "processRunner"]) {
    if (
      Object.hasOwn(result, name) &&
      (result[name] === null ||
        typeof result[name] !== "object" ||
        utilTypes.isProxy(result[name]))
    ) {
      throw error;
    }
  }
  return result;
}

function normalizeMirrorMap(value, name, error) {
  const entries = dataEntries(value, error);
  if (
    entries.length < 1 ||
    entries.length > MAX_MIRRORS_PER_ROLE
  ) {
    throw invalidConfig(`${name} 必须至少配置一个可信 mirror`, error);
  }
  const mirrors = new Map();
  for (const [repositoryValue, mirrorRootValue] of entries) {
    const repository = trustedRepository(repositoryValue, error);
    const mirrorRoot = trustedAbsolutePath(
      mirrorRootValue,
      `${name}.${repositoryValue}`,
      error,
    );
    if (mirrors.has(repository)) {
      throw invalidConfig(`${name} 包含大小写重复仓库`, error);
    }
    mirrors.set(repository, mirrorRoot);
  }
  return mirrors;
}

function assertIsolatedBoundaries({
  gitCommand,
  preparationRoot,
  baseMirrors,
  headMirrors,
}) {
  const claimedMirrors = [
    ...baseMirrors.entries(),
    ...headMirrors.entries(),
  ];
  for (let index = 0; index < claimedMirrors.length; index += 1) {
    const [repository, mirrorRoot] = claimedMirrors[index];
    if (
      pathsOverlap(mirrorRoot, gitCommand) ||
      pathsOverlap(mirrorRoot, preparationRoot)
    ) {
      throw invalidConfig(
        `仓库 ${repository} 的 mirror 与运行边界重叠`,
      );
    }
    for (
      let comparedIndex = index + 1;
      comparedIndex < claimedMirrors.length;
      comparedIndex += 1
    ) {
      const [comparedRepository, comparedRoot] =
        claimedMirrors[comparedIndex];
      if (pathsOverlap(mirrorRoot, comparedRoot)) {
        throw invalidConfig(
          `仓库 ${repository} 与 ${comparedRepository} 的 mirror 必须隔离`,
        );
      }
    }
  }
  if (pathsOverlap(gitCommand, preparationRoot)) {
    throw invalidConfig("Git executable 与 preparation root 必须隔离");
  }
}

function normalizeConfig(value) {
  if (value === undefined) return null;
  const error = invalidConfig();
  const entries = dataEntries(value, error);
  const enabledEntry = entries.find(([key]) => key === "enabled");
  if (enabledEntry?.[1] === false) {
    if (
      entries.some(([key]) => !DISABLED_CONFIG_KEYS.has(key)) ||
      entries.length !== 1
    ) {
      throw invalidConfig("已禁用的 Controlled Git 配置只能包含 enabled", error);
    }
    return null;
  }
  const fields = exactDataObject(value, CONFIG_KEYS, error);
  if (fields.get("enabled") !== true) throw error;
  const gitCommand = trustedAbsolutePath(
    fields.get("gitCommand"),
    "gitCommand",
    error,
  );
  const preparationRoot = trustedAbsolutePath(
    fields.get("preparationRoot"),
    "preparationRoot",
    error,
  );
  const baseMirrors = normalizeMirrorMap(
    fields.get("baseMirrorsByRepository"),
    "baseMirrorsByRepository",
    error,
  );
  const headMirrors = normalizeMirrorMap(
    fields.get("headMirrorsByRepository"),
    "headMirrorsByRepository",
    error,
  );
  assertIsolatedBoundaries({
    gitCommand,
    preparationRoot,
    baseMirrors,
    headMirrors,
  });
  return { gitCommand, preparationRoot, baseMirrors, headMirrors };
}

function method(value, name, owner) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value)
  ) {
    throw invalidConfig(`${owner} 必须提供 ${name}`);
  }
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
  throw invalidConfig(`${owner} 必须提供 ${name}`);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function lookupMirror(mirrors, repository, role) {
  const mirrorRoot = mirrors.get(repository.toLowerCase());
  if (mirrorRoot === undefined) {
    throw runtimeError(
      "CONTROLLED_GIT_MIRROR_NOT_CONFIGURED",
      `${role} 仓库 ${repository} 未配置可信 mirror`,
    );
  }
  return mirrorRoot;
}

function assertPreparationInputUnchanged(value, expected) {
  let current;
  try {
    current = normalizePullRequestExecutionBinding(value);
  } catch (cause) {
    throw runtimeError("CONFLICT_PREPARATION_INPUT_CHANGED",
      "PR 执行绑定在 conflict preparation 期间发生变化", cause);
  }
  if (!samePullRequestExecutionBinding(expected, current)) {
    throw runtimeError("CONFLICT_PREPARATION_INPUT_CHANGED",
      "PR 执行绑定在 conflict preparation 期间发生变化");
  }
}

function createPorts(service, { baseMirrors, headMirrors }) {
  const createControlledCommit = method(
    service,
    "createControlledCommit",
    "ControlledGitService",
  );
  const findControlledCommit = method(
    service,
    "findControlledCommit",
    "ControlledGitService",
  );
  const verifyControlledCommit = method(
    service,
    "verifyControlledCommit",
    "ControlledGitService",
  );
  const readSealedControlledCommit = method(service, "readSealedControlledCommit", "ControlledGitService");
  const publishControlledCommit = method(
    service,
    "publishControlledCommit",
    "ControlledGitService",
  );
  const inspectConflict = method(service, "inspectConflict", "ControlledGitService");
  const readConflictInspection = method(service, "readConflictInspection", "ControlledGitService");
  const verifyConflictPreparation = method(
    service,
    "verifyConflictPreparation",
    "ControlledGitService",
  );
  const materializeConflictPreparationForCodeJob = method(
    service,
    "materializeConflictPreparationForCodeJob",
    "ControlledGitService",
  );

  const materializer = Object.freeze({
    materialize: (request) =>
      materializeConflictPreparationForCodeJob(request),
  });
  const commitBuilder = Object.freeze({
    create: (request) => createControlledCommit(request),
    find: (request) => findControlledCommit(request),
    verify: (request) => verifyControlledCommit(request),
    readSealed: (request) => readSealedControlledCommit(request),
  });
  const publisher = Object.freeze({
    publish: (request) => publishControlledCommit(request),
  });
  const verifier = Object.freeze({
    verify: (binding) => verifyConflictPreparation({ binding }),
  });
  // Reuse material across inspection and dispatch; verification remains fresh.
  const preparationBindings = new Map();
  const preparer = Object.freeze({
    async prepare(inputBindingValue) {
      let inputBinding;
      try {
        if (utilTypes.isProxy(inputBindingValue)) throw new TypeError();
        inputBinding = normalizePullRequestExecutionBinding(inputBindingValue);
      } catch (cause) {
        throw runtimeError(
          "INVALID_CONFLICT_PREPARATION_INPUT",
          "Conflict preparation 只接受完整 PR 执行绑定",
          cause,
        );
      }
      if (inputBinding.schemaVersion !== 2) {
        throw runtimeError(
          "INVALID_CONFLICT_PREPARATION_INPUT",
          "Conflict preparation 需要包含 Git target 的 schemaVersion 2 PR 绑定",
        );
      }
      const gitTarget = inputBinding.gitTarget;
      const cacheKey = JSON.stringify(inputBinding);
      let preparationBinding = preparationBindings.get(cacheKey);
      if (preparationBinding === undefined) {
        const preparation = await inspectConflict({
          gitTarget,
          baseMirrorRoot: lookupMirror(baseMirrors, gitTarget.baseRepository, "Base"),
          headMirrorRoot: lookupMirror(headMirrors, gitTarget.headRepository, "Head"),
        });
        assertPreparationInputUnchanged(inputBindingValue, inputBinding);
        if (preparation?.status !== "conflicted") {
          throw runtimeError("CONFLICT_PREPARATION_NOT_CONFLICTED",
            "PR 当前镜像不再产生受支持的冲突");
        }
        try {
          preparationBinding = deepFreeze(createConflictPreparationBinding({ preparation, gitTarget }));
        } catch (cause) {
          throw runtimeError("INVALID_CONFLICT_PREPARATION_RESULT",
            "Controlled Git preparation 结果无效", cause);
        }
      }
      try {
        const verified = await verifyConflictPreparation({ binding: preparationBinding });
        if (!sameConflictPreparationBinding(verified, preparationBinding)) {
          throw runtimeError("CONFLICT_PREPARATION_VERIFICATION_MISMATCH",
            "Controlled Git preparation 校验结果不一致");
        }
      } catch (error) {
        preparationBindings.delete(cacheKey);
        throw error;
      }
      assertPreparationInputUnchanged(inputBindingValue, inputBinding);
      const executionSource = createConflictCodeExecutionSource({
        inputBinding,
        preparationBinding,
      });
      const normalizedSource = normalizeCodeExecutionSource(executionSource);
      if (
        !sameCodeExecutionSource(normalizedSource, executionSource) ||
        !samePullRequestExecutionBinding(
          normalizedSource.inputBinding,
          inputBinding,
        )
      ) {
        throw runtimeError(
          "INVALID_CONFLICT_PREPARATION_RESULT",
          "Conflict execution source 构造失败",
        );
      }
      preparationBindings.set(cacheKey, preparationBinding);
      if (preparationBindings.size > 32) {
        preparationBindings.delete(preparationBindings.keys().next().value);
      }
      return deepFreeze(normalizedSource);
    },
  });
  return Object.freeze({
    commitBuilder,
    materializer,
    publisher,
    verifier,
    preparer,
    sourceReader: typeof service.readConflictSources !== "function" ? null : Object.freeze({ async read(value) {
      const source = normalizeCodeExecutionSource(value);
      if (source.kind !== "conflict_preparation") throw runtimeError("INVALID_CONFLICT_PREPARATION_INPUT", "Conflict source requires a sealed conflict preparation");
      const documents = await service.readConflictSources({ binding: source.preparationBinding });
      return deepFreeze({ inputBinding: source.inputBinding, preparationBinding: source.preparationBinding, documents });
    } }),
    inspectionReader: Object.freeze({ async read(inputBinding) {
      const source = await preparer.prepare(inputBinding);
      const inspection = await readConflictInspection({ binding: source.preparationBinding });
      return Object.freeze({ ...inspection, inputBinding: source.inputBinding });
    } }),
  });
}

export async function createControlledGitRuntimeBundle(
  config,
  dependencies = {},
) {
  const normalized = normalizeConfig(config);
  if (normalized === null) return null;
  const normalizedDependencies = normalizeDependencies(dependencies);
  let mirrorInspector;
  let service;
  try {
    await preflightBoundaries(normalized);
    mirrorInspector = normalizedDependencies.mirrorInspector ||
      new GitBareMirrorInspector({
        gitCommand: normalized.gitCommand,
        ...(normalizedDependencies.processRunner
          ? { processRunner: normalizedDependencies.processRunner }
          : {}),
      });
    const serviceConfig = {
      gitCommand: normalized.gitCommand,
      mirrorInspector,
      preparationRoot: normalized.preparationRoot,
      headMirrorsByRepository: Object.fromEntries(normalized.headMirrors),
      ...(normalizedDependencies.limits ? { limits: normalizedDependencies.limits } : {}),
      ...(normalizedDependencies.processRunner
        ? { processRunner: normalizedDependencies.processRunner }
        : {}),
    };
    service = normalizedDependencies.controlledGitServiceFactory
      ? normalizedDependencies.controlledGitServiceFactory(serviceConfig)
      : new ControlledGitService(serviceConfig);
    await method(
      service,
      "recoverControlledCommits",
      "ControlledGitService",
    )();
  } catch (cause) {
    if (cause instanceof ControlledGitRuntimeError) throw cause;
    throw runtimeError(
      "CONTROLLED_GIT_RUNTIME_SETUP_FAILED",
      "Controlled Git 运行时初始化失败",
      cause,
    );
  }
  return createPorts(service, normalized);
}
