import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  CodeExecutionError,
  CodeExecutionPolicy,
  normalizeWorkspacePath,
  validateExecutionId,
  validateWorkspaceId,
} from "../domain/code-execution-policy.js";
import {
  codeExecutionSourceWritablePaths,
  isHeadRepairExecutionSource,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "../domain/code-execution-source.js";
import { sameConflictPreparationBinding } from "../domain/conflict-preparation-binding.js";
import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { workspaceRevisionFromFileHashes } from "../domain/workspace-revision.js";
import { throwIfPreparationAborted, isPreparationAbort, withoutPreparationCancellation } from "../lib/preparation-cancellation.js";
import { gitSnapshotFailureDiagnostic } from "../adapters/git-object-snapshotter.js";

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxDirectories: 5_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 50_000_000,
  maxSearchMatches: 200,
  maxWriteBytes: 1_000_000,
});
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error, fallbackCode, fallbackMessage) {
  if (isPreparationAbort(error)) return error;
  if (error instanceof CodeExecutionError) return error;
  return new CodeExecutionError(fallbackCode, fallbackMessage);
}

async function guarded(operation, fallbackCode, fallbackMessage) {
  try {
    return await operation();
  } catch (error) {
    throw safeError(error, fallbackCode, fallbackMessage);
  }
}

function validateLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CodeExecutionError("INVALID_LIMIT", `${name} 限制无效`);
    }
  }
  return Object.freeze(limits);
}

function decodeText(value) {
  if (value.includes(0)) {
    throw new CodeExecutionError("TEXT_REQUIRED", "只能读取或写入纯文本文件");
  }
  try {
    // Keep a BOM in the content so UTF-8 round trips match the audited bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw new CodeExecutionError("TEXT_REQUIRED", "只能读取或写入纯文本文件");
  }
}

function assertExpectedSha256(value) {
  if (value === undefined) {
    throw new CodeExecutionError(
      "EXPECTED_SHA256_REQUIRED",
      "写操作必须提供 expectedSha256",
    );
  }
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
    throw new CodeExecutionError("INVALID_SHA256", "expectedSha256 格式无效");
  }
}

function bindGitSnapshotter(value) {
  if (value === null || value === undefined) return null;
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "materialize");
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        break;
      }
      return Object.freeze({
        materialize: descriptor.value.bind(value),
      });
    }
    current = Object.getPrototypeOf(current);
  }
  throw new CodeExecutionError(
    "INVALID_WORKSPACE_CONFIG",
    "Git Head snapshot 端口无效",
  );
}

function bindConflictMaterializer(value) {
  if (value === null || value === undefined) return null;
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "materialize");
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        break;
      }
      return Object.freeze({ materialize: descriptor.value.bind(value) });
    }
    current = Object.getPrototypeOf(current);
  }
  throw new CodeExecutionError(
    "INVALID_WORKSPACE_CONFIG",
    "Conflict preparation materializer 端口无效",
  );
}

function normalizeInputBinding(value) {
  if (value === undefined || value === null) return null;
  const error = new CodeExecutionError(
    "INVALID_EXECUTION_INPUT_BINDING",
    "代码执行输入绑定无效",
  );
  const binding = normalizePullRequestExecutionBinding(value, error);
  if (!GIT_OID.test(binding.headRefOid)) throw error;
  return binding;
}

function exactDataResult(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        keys.includes(key) &&
        descriptor?.enumerable &&
        "value" in descriptor
      );
    })
  );
}

function normalizeCreateExecutionRequest(value) {
  const error = new CodeExecutionError(
    "INVALID_EXECUTION_REQUEST",
    "代码执行副本请求无效",
  );
  const hasExecutionId = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "executionId");
  const hasInputBinding = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "inputBinding");
  const hasExecutionSource = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "executionSource");
  const keys = [
    "workspaceId",
    ...(hasExecutionId ? ["executionId"] : []),
    ...(hasInputBinding ? ["inputBinding"] : []),
    ...(hasExecutionSource ? ["executionSource"] : []),
  ];
  if (!exactDataResult(value, keys)) throw error;
  const inputBinding = normalizeInputBinding(
    hasInputBinding ? value.inputBinding : null,
  );
  let executionSource = null;
  if (hasExecutionSource) {
    try {
      executionSource = normalizeCodeExecutionSource(
        value.executionSource,
        error,
      );
    } catch {
      throw error;
    }
    if (
      inputBinding === null ||
      !sameCodeExecutionSource(executionSource, {
        ...executionSource,
        inputBinding,
      })
    ) {
      throw error;
    }
  }
  return {
    workspaceId: value.workspaceId,
    executionId: hasExecutionId ? value.executionId : `run-${randomUUID()}`,
    inputBinding,
    executionSource,
    hasExecutionSource,
  };
}

function normalizeConflictMaterializationReceipt(
  value,
  { executionSource, targetRoot, workspace, limits },
) {
  if (
    !exactDataResult(value, [
      "schemaVersion",
      "preparationId",
      "binding",
      "targetRoot",
      "materialization",
      "excludePaths",
      "files",
      "fileCount",
      "totalBytes",
      "resultTreeOid",
      "evidenceDigest",
      "resultObjectDigest",
      "residual",
    ]) ||
    value.schemaVersion !== 2 ||
    value.preparationId !== executionSource.preparationBinding.preparationId ||
    !sameConflictPreparationBinding(
      value.binding,
      executionSource.preparationBinding,
    ) ||
    value.targetRoot !== targetRoot ||
    value.materialization !== "full-tree" ||
    !Array.isArray(value.excludePaths) ||
    utilTypes.isProxy(value.excludePaths) ||
    Object.getPrototypeOf(value.excludePaths) !== Array.prototype ||
    !Array.isArray(value.files) ||
    utilTypes.isProxy(value.files) ||
    Object.getPrototypeOf(value.files) !== Array.prototype ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 1 ||
    value.fileCount > limits.maxFiles ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > limits.maxTotalBytes ||
    value.resultTreeOid !== executionSource.preparationBinding.resultTreeOid ||
    value.evidenceDigest !== executionSource.preparationBinding.evidenceDigest ||
    value.resultObjectDigest !==
      executionSource.preparationBinding.resultObjectDigest ||
    value.residual !== null
  ) {
    throw new CodeExecutionError(
      "CONFLICT_PREPARATION_RESULT_INVALID",
      "Conflict preparation 落盘回执无效",
    );
  }
  const arrayHasExactItems = (entries) => {
    const keys = Reflect.ownKeys(entries);
    if (keys.length !== entries.length + 1 || !keys.includes("length")) {
      return false;
    }
    return entries.every((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
      return descriptor?.enumerable && "value" in descriptor;
    });
  };
  if (
    !arrayHasExactItems(value.excludePaths) ||
    !arrayHasExactItems(value.files) ||
    value.excludePaths.length !== workspace.policy.excludePaths.length ||
    value.excludePaths.some(
      (entry, index) => entry !== workspace.policy.excludePaths[index],
    ) ||
    value.files.length !== value.fileCount
  ) {
    throw new CodeExecutionError(
      "CONFLICT_PREPARATION_RESULT_INVALID",
      "Conflict preparation 落盘回执无效",
    );
  }
  const fileEvidence = new Map();
  const portablePaths = new Set();
  let evidenceBytes = 0;
  let previousPath = null;
  for (const entry of value.files) {
    if (!exactDataResult(entry, ["path", "sha256", "mode", "bytes"])) {
      throw new CodeExecutionError(
        "CONFLICT_PREPARATION_RESULT_INVALID",
        "Conflict preparation 落盘回执无效",
      );
    }
    let relativePath;
    try {
      relativePath = normalizeWorkspacePath(entry.path);
    } catch {
      throw new CodeExecutionError(
        "CONFLICT_PREPARATION_RESULT_INVALID",
        "Conflict preparation 落盘回执无效",
      );
    }
    const portablePath = relativePath.toLowerCase();
    if (
      entry.path !== relativePath ||
      !SHA256.test(entry.sha256) ||
      entry.mode !== "100644" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > limits.maxFileBytes ||
      portablePaths.has(portablePath) ||
      (previousPath !== null &&
        previousPath.localeCompare(relativePath, "en") >= 0)
    ) {
      throw new CodeExecutionError(
        "CONFLICT_PREPARATION_RESULT_INVALID",
        "Conflict preparation 落盘回执无效",
      );
    }
    try {
      if (workspace.policy.assertAccessible(relativePath) !== relativePath) {
        throw new Error("non-canonical path");
      }
    } catch {
      throw new CodeExecutionError(
        "CONFLICT_PREPARATION_RESULT_INVALID",
        "Conflict preparation 落盘回执无效",
      );
    }
    portablePaths.add(portablePath);
    previousPath = relativePath;
    evidenceBytes += entry.bytes;
    if (!Number.isSafeInteger(evidenceBytes) || evidenceBytes > limits.maxTotalBytes) {
      throw new CodeExecutionError(
        "CONFLICT_PREPARATION_RESULT_INVALID",
        "Conflict preparation 落盘回执无效",
      );
    }
    fileEvidence.set(relativePath, {
      sha256: entry.sha256,
      mode: entry.mode,
      bytes: entry.bytes,
    });
  }
  if (evidenceBytes !== value.totalBytes) {
    throw new CodeExecutionError(
      "CONFLICT_PREPARATION_RESULT_INVALID",
      "Conflict preparation 落盘回执无效",
    );
  }
  return {
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    fileEvidence,
  };
}

function conflictMaterializationFailure(error) {
  if (isPreparationAbort(error)) return error;
  if (error instanceof CodeExecutionError) return error;
  const code = typeof error?.code === "string" &&
      error.code.startsWith("CONTROLLED_GIT_")
    ? error.code
    : "CONFLICT_PREPARATION_MATERIALIZATION_FAILED";
  return new CodeExecutionError(code, "无法创建 sealed conflict 代码快照");
}

function normalizeGitSnapshotReceipt(value, { workspace, inputBinding, limits }) {
  if (
    !exactDataResult(value, [
      "headOid",
      "baseline",
      "modes",
      "fileCount",
      "totalBytes",
    ]) ||
    value.headOid !== inputBinding.headRefOid ||
    Object.getPrototypeOf(value.baseline) !== Map.prototype ||
    Object.getPrototypeOf(value.modes) !== Map.prototype ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    value.fileCount > limits.maxFiles ||
    value.fileCount !== value.baseline.size ||
    value.fileCount !== value.modes.size ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > limits.maxTotalBytes
  ) {
    throw new CodeExecutionError(
      "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
      "Git Head snapshot 结果无效",
    );
  }
  const baseline = new Map();
  const modes = new Map();
  let previousPath = null;
  for (const [relativePath, digest] of value.baseline) {
    let normalizedPath;
    try {
      normalizedPath = workspace.policy.assertAccessible(relativePath);
    } catch {
      throw new CodeExecutionError(
        "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
        "Git Head snapshot 结果无效",
      );
    }
    if (
      normalizedPath !== relativePath ||
      !SHA256.test(digest) ||
      !["100644", "100755"].includes(value.modes.get(relativePath)) ||
      (previousPath !== null &&
        previousPath.localeCompare(relativePath) >= 0)
    ) {
      throw new CodeExecutionError(
        "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
        "Git Head snapshot 结果无效",
      );
    }
    baseline.set(relativePath, digest);
    modes.set(relativePath, value.modes.get(relativePath));
    previousPath = relativePath;
  }
  return {
    baseline,
    modes,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
  };
}

function gitSnapshotFailure(error) {
  if (isPreparationAbort(error)) return error;
  if (error instanceof CodeExecutionError) return error;
  const limitCodes = new Set([
    "FILE_COUNT_LIMIT",
    "FILE_SIZE_LIMIT",
    "TOTAL_SIZE_LIMIT",
  ]);
  const code = limitCodes.has(error?.code)
    ? error.code
    : typeof error?.code === "string" && error.code.startsWith("GIT_")
      ? error.code
      : "GIT_HEAD_SNAPSHOT_FAILED";
  const diagnostic = gitSnapshotFailureDiagnostic(error);
  return new CodeExecutionError(code, "无法从指定 Git Head 创建代码快照" + (diagnostic ? `；${diagnostic}` : ""));
}

export class CodeWorkspaceBroker {
  constructor({
    workspaces = [],
    scratchRoot = path.join(tmpdir(), "my-dashboard-code-executions"),
    limits = {},
    gitSnapshotter = null,
    conflictMaterializer = null,
    removeDirectory = rm,
  } = {}) {
    if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "临时工作区配置无效",
      );
    }
    this.scratchRoot = path.resolve(scratchRoot);
    this.limits = validateLimits(limits);
    this.gitSnapshotter = bindGitSnapshotter(gitSnapshotter);
    this.conflictMaterializer = bindConflictMaterializer(
      conflictMaterializer,
    );
    if (typeof removeDirectory !== "function") {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "工作区清理端口无效",
      );
    }
    this.removeDirectory = removeDirectory;
    this.workspaces = new Map();
    this.executions = new Map();
    this.executionLifecycles = new Map();
    for (const workspace of workspaces) this.#registerWorkspace(workspace);
  }

  #registerWorkspace({
    id,
    sourceRoot,
    writablePaths = [],
    excludePaths = [],
    gitBoundaryDigest = null,
    gitExecutableIdentity = null,
  }) {
    validateWorkspaceId(id);
    if (this.workspaces.has(id)) {
      throw new CodeExecutionError(
        "WORKSPACE_ALREADY_REGISTERED",
        "workspaceId 已注册",
      );
    }
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "可信工作区配置无效",
      );
    }
    if (
      (gitBoundaryDigest === null) !== (gitExecutableIdentity === null) ||
      (gitBoundaryDigest !== null &&
        (!SHA256.test(gitBoundaryDigest) ||
          this.gitSnapshotter === null ||
          !exactDataResult(gitExecutableIdentity, [
            "gitCommand",
            "gitExecutableSha256",
            "gitExecutableBytes",
            "gitExecutableMode",
            "gitExecutableUid",
            "gitExecutableGid",
          ]) ||
          typeof gitExecutableIdentity.gitCommand !== "string" ||
          !path.isAbsolute(gitExecutableIdentity.gitCommand) ||
          gitExecutableIdentity.gitCommand.includes("\0") ||
          !SHA256.test(gitExecutableIdentity.gitExecutableSha256) ||
          !Number.isSafeInteger(gitExecutableIdentity.gitExecutableBytes) ||
          gitExecutableIdentity.gitExecutableBytes < 1 ||
          gitExecutableIdentity.gitExecutableBytes >
            MAX_GIT_EXECUTABLE_BYTES ||
          !Number.isSafeInteger(gitExecutableIdentity.gitExecutableMode) ||
          gitExecutableIdentity.gitExecutableMode < 0 ||
          gitExecutableIdentity.gitExecutableMode > 0o7777 ||
          !Number.isSafeInteger(gitExecutableIdentity.gitExecutableUid) ||
          gitExecutableIdentity.gitExecutableUid < 0 ||
          !Number.isSafeInteger(gitExecutableIdentity.gitExecutableGid) ||
          gitExecutableIdentity.gitExecutableGid < 0))
    ) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "Git Head snapshot 工作区配置无效",
      );
    }
    const resolvedSourceRoot = path.resolve(sourceRoot);
    if (this.#pathsOverlap(this.scratchRoot, resolvedSourceRoot)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "临时工作区不得与可信工作区重叠",
      );
    }
    this.workspaces.set(id, {
      id,
      sourceRoot: resolvedSourceRoot,
      policy: new CodeExecutionPolicy({ writablePaths, excludePaths }),
      gitBoundaryDigest,
      gitExecutableIdentity: gitExecutableIdentity === null
        ? null
        : Object.freeze({
            gitCommand: path.resolve(gitExecutableIdentity.gitCommand),
            gitExecutableSha256:
              gitExecutableIdentity.gitExecutableSha256,
            gitExecutableBytes: gitExecutableIdentity.gitExecutableBytes,
            gitExecutableMode: gitExecutableIdentity.gitExecutableMode,
            gitExecutableUid: gitExecutableIdentity.gitExecutableUid,
            gitExecutableGid: gitExecutableIdentity.gitExecutableGid,
          }),
    });
  }

  async createExecution(request) {
    return guarded(
      async () => {
        throwIfPreparationAborted();
        const {
          workspaceId,
          executionId,
          inputBinding,
          executionSource,
          hasExecutionSource,
        } = normalizeCreateExecutionRequest(request);
        const workspace = this.#workspace(workspaceId);
        if (isHeadRepairExecutionSource(executionSource) &&
            JSON.stringify(codeExecutionSourceWritablePaths(executionSource)) !==
            JSON.stringify([...workspace.policy.writablePaths].sort((left, right) => left.localeCompare(right, "en")))) {
          throw new CodeExecutionError("INVALID_EXECUTION_REQUEST", "Review repair 写范围与工作区配置不一致");
        }
        validateExecutionId(executionId);
        const key = this.#executionKey(workspaceId, executionId);
        return this.#enqueueExecutionLifecycle(key, async () => {
          if (this.executions.has(key)) {
            throw new CodeExecutionError(
              "EXECUTION_ALREADY_EXISTS",
              "executionId 已存在",
            );
          }

          await mkdir(this.scratchRoot, { recursive: true });
          await this.#assertDirectory(
            this.scratchRoot,
            "EXECUTION_STORAGE_UNAVAILABLE",
          );
          const { workspaceRoot, executionRoot } = this.#executionStoragePaths(
            workspaceId,
            executionId,
          );
          await mkdir(workspaceRoot, { recursive: true });
          await this.#assertDirectory(
            workspaceRoot,
            "EXECUTION_STORAGE_UNAVAILABLE",
          );
          try {
            await mkdir(executionRoot);
          } catch (error) {
            if (error?.code === "EEXIST") {
              throw new CodeExecutionError(
                "EXECUTION_ALREADY_EXISTS",
                "executionId 已存在",
              );
            }
            throw error;
          }

          const baseline = new Map();
          const copyState = { fileCount: 0, totalBytes: 0 };
          try {
            if (hasExecutionSource && executionSource.kind === "conflict_preparation") {
              if (this.conflictMaterializer === null) {
                throw new CodeExecutionError(
                  "CONFLICT_PREPARATION_MATERIALIZER_UNAVAILABLE",
                  "该工作区没有启用 sealed conflict 快照",
                );
              }
              try {
                for (const writablePath of
                  codeExecutionSourceWritablePaths(executionSource)) {
                  workspace.policy.assertWritable(writablePath);
                }
              } catch {
                throw new CodeExecutionError(
                  "CONFLICT_PREPARATION_SCOPE_INVALID",
                  "Conflict preparation 超出工作区写权限",
                );
              }
              let materialized;
              try {
                materialized = await this.conflictMaterializer.materialize({
                  binding: structuredClone(
                    executionSource.preparationBinding,
                  ),
                  targetRoot: executionRoot,
                  excludePaths: [...workspace.policy.excludePaths],
                });
              } catch (error) {
                throw conflictMaterializationFailure(error);
              }
              const receipt = normalizeConflictMaterializationReceipt(
                materialized,
                {
                  executionSource,
                  targetRoot: executionRoot,
                  workspace,
                  limits: this.limits,
                },
              );
              const materializedBaseline =
                await this.#verifyConflictMaterialization({
                  workspace,
                  executionRoot,
                  executionSource,
                  receipt,
                });
              for (const [relativePath, digest] of materializedBaseline) {
                baseline.set(relativePath, digest);
              }
            } else if (inputBinding === null) {
              await this.#copySanitizedDirectory({
                workspace,
                sourceDirectory: workspace.sourceRoot,
                targetDirectory: executionRoot,
                relativeDirectory: "",
                baseline,
                copyState,
              });
            } else {
              if (
                workspace.gitBoundaryDigest === null ||
                this.gitSnapshotter === null
              ) {
                throw new CodeExecutionError(
                  "GIT_HEAD_SNAPSHOT_UNAVAILABLE",
                  "该工作区没有启用固定 Git Head 快照",
                );
              }
              let snapshot;
              try {
                snapshot = await this.gitSnapshotter.materialize({
                  sourceRoot: workspace.sourceRoot,
                  targetRoot: executionRoot,
                  headOid: inputBinding.headRefOid,
                  excludePaths: [...workspace.policy.excludePaths],
                  expectedBoundaryDigest: workspace.gitBoundaryDigest,
                  expectedGitCommand:
                    workspace.gitExecutableIdentity.gitCommand,
                  expectedGitExecutableSha256:
                    workspace.gitExecutableIdentity.gitExecutableSha256,
                  expectedGitExecutableBytes:
                    workspace.gitExecutableIdentity.gitExecutableBytes,
                  expectedGitExecutableMode:
                    workspace.gitExecutableIdentity.gitExecutableMode,
                  expectedGitExecutableUid:
                    workspace.gitExecutableIdentity.gitExecutableUid,
                  expectedGitExecutableGid:
                    workspace.gitExecutableIdentity.gitExecutableGid,
                });
              } catch (error) {
                throw gitSnapshotFailure(error);
              }
              const receipt = normalizeGitSnapshotReceipt(
                snapshot,
                { workspace, inputBinding, limits: this.limits },
              );
              const materializedBaseline =
                await this.#verifyGitSnapshotMaterialization({
                  workspace,
                  executionRoot,
                  receipt,
                });
              for (const [relativePath, digest] of materializedBaseline) {
                baseline.set(relativePath, digest);
              }
            }
          } catch (error) {
            try {
              await withoutPreparationCancellation(() => this.#discardExecutionDirectory(workspaceId, executionId));
            } catch (cleanupError) {
              const failure = new CodeExecutionError(
                "EXECUTION_STORAGE_UNAVAILABLE",
                "代码执行副本创建失败且残留目录未能确认清理",
              );
              Object.defineProperty(failure, "cause", {
                configurable: false,
                enumerable: false,
                value: cleanupError,
                writable: false,
              });
              throw failure;
            }
            throw error;
          }

          const sourceRevision = workspaceRevisionFromFileHashes(baseline);
          this.executions.set(key, {
            workspace,
            root: executionRoot,
            baseline,
            exactWritablePaths: hasExecutionSource && executionSource.kind === "conflict_preparation"
              ? new Set(codeExecutionSourceWritablePaths(executionSource))
              : null,
            sourceRevision,
            workspaceState: {
              fileHashes: new Map(baseline),
              revision: sourceRevision,
            },
            seal: null,
            tail: Promise.resolve(),
          });
          return {
            workspaceId,
            executionId,
            inputBinding: structuredClone(inputBinding),
            ...(hasExecutionSource
              ? { executionSource: structuredClone(executionSource) }
              : {}),
            sourceRevision,
            workspaceRevision: sourceRevision,
          };
        });
      },
      "EXECUTION_CREATE_FAILED",
      "无法创建代码执行副本",
    );
  }

  async discardExecution({ workspaceId, executionId }) {
    return guarded(
      async () => {
        validateWorkspaceId(workspaceId);
        validateExecutionId(executionId);
        const key = this.#executionKey(workspaceId, executionId);
        return this.#enqueueExecutionLifecycle(key, async () => {
          const execution = this.executions.get(key);
          const discard = async () => {
            await this.#discardExecutionDirectory(workspaceId, executionId);
            if (this.executions.get(key) === execution) {
              this.executions.delete(key);
            }
            return { workspaceId, executionId, discarded: true };
          };
          return execution ? this.#enqueue(execution, discard) : discard();
        });
      },
      "EXECUTION_DISCARD_FAILED",
      "无法丢弃代码执行副本",
    );
  }

  async listFiles(request) {
    return guarded(
      async () => {
        const {
          workspaceId,
          executionId,
          path: requestedPath = "",
        } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath = execution.workspace.policy.assertAccessible(
              requestedPath,
              { allowRoot: true },
            );
            return this.#collectFiles(execution, relativePath);
          },
        );
      },
      "LIST_FAILED",
      "无法列出工作区文件",
    );
  }

  async readFile(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId, path: requestedPath } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath =
              execution.workspace.policy.assertAccessible(requestedPath);
            const file = await this.#readTextFile(execution, relativePath);
            return {
              path: relativePath,
              content: file.content,
              sha256: file.sha256,
              bytes: file.bytes,
            };
          },
        );
      },
      "READ_FAILED",
      "无法读取工作区文件",
    );
  }

  async searchText(request) {
    return guarded(
      async () => {
        const {
          workspaceId,
          executionId,
          query,
          path: requestedPath = "",
        } = request;
        if (
          typeof query !== "string" ||
          query.length === 0 ||
          query.includes("\0") ||
          Buffer.byteLength(query, "utf8") > 4_096
        ) {
          throw new CodeExecutionError("INVALID_QUERY", "搜索文本无效");
        }
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath = execution.workspace.policy.assertAccessible(
              requestedPath,
              { allowRoot: true },
            );
            const files = await this.#collectFiles(execution, relativePath);
            const matches = [];
            for (const filePath of files) {
              let file;
              try {
                file = await this.#readTextFile(execution, filePath);
              } catch (error) {
                if (error.code === "TEXT_REQUIRED") continue;
                throw error;
              }
              const lines = file.content.split(/\r?\n/);
              for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                let column = lines[lineIndex].indexOf(query);
                while (column !== -1) {
                  if (matches.length === this.limits.maxSearchMatches) {
                    return { matches, truncated: true };
                  }
                  matches.push({
                    path: filePath,
                    line: lineIndex + 1,
                    column: column + 1,
                    text: lines[lineIndex].slice(0, 500),
                  });
                  column = lines[lineIndex].indexOf(query, column + query.length);
                }
              }
            }
            return { matches, truncated: false };
          },
        );
      },
      "SEARCH_FAILED",
      "无法搜索工作区文本",
    );
  }

  async writeFile(action) {
    return guarded(
      async () => {
        const execution = this.#execution(
          action.workspaceId,
          action.executionId,
        );
        return this.#enqueue(execution, async () => {
          this.#assertExecutionOpen(execution);
          const beforeWorkspaceRevision = execution.workspaceState.revision;
          this.#assertWorkspaceRevision(action, beforeWorkspaceRevision);
          const result = await this.#writeFile(execution, action);
          return {
            ...result,
            beforeWorkspaceRevision,
            workspaceRevision: this.#commitCachedFileHash(
              execution,
              result.path,
              result.sha256,
            ),
          };
        });
      },
      "WRITE_FAILED",
      "无法写入工作区文件",
    );
  }

  async deleteFile(action) {
    return guarded(
      async () => {
        const execution = this.#execution(
          action.workspaceId,
          action.executionId,
        );
        return this.#enqueue(execution, async () => {
          this.#assertExecutionOpen(execution);
          const beforeWorkspaceRevision = execution.workspaceState.revision;
          this.#assertWorkspaceRevision(action, beforeWorkspaceRevision);
          const result = await this.#deleteFile(execution, action);
          return {
            ...result,
            beforeWorkspaceRevision,
            workspaceRevision: this.#commitCachedFileHash(
              execution,
              result.path,
              null,
            ),
          };
        });
      },
      "DELETE_FAILED",
      "无法删除工作区文件",
    );
  }

  async getChangeManifest(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, async () => {
          const snapshot = await this.#createWorkspaceSnapshot(execution);
          this.#assertWorkspaceRevision(request, snapshot.workspaceRevision);
          return snapshot.manifest;
        });
      },
      "MANIFEST_FAILED",
      "无法生成工作区变更清单",
    );
  }

  async sealExecution(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, async () => {
          this.#assertRequiredWorkspaceRevision(request);
          if (execution.seal) {
            this.#assertWorkspaceRevision(
              request,
              execution.seal.workspaceRevision,
            );
            return this.#copyWorkspaceSnapshot(execution.seal);
          }

          const snapshot = await this.#createWorkspaceSnapshot(execution);
          this.#assertWorkspaceRevision(request, snapshot.workspaceRevision);
          execution.seal = snapshot;
          return this.#copyWorkspaceSnapshot(snapshot);
        });
      },
      "SEAL_FAILED",
      "无法封存代码执行副本",
    );
  }

  async getSandboxWorkspacePath({ workspaceId, executionId }) {
    return guarded(
      async () => {
        const execution = this.#execution(workspaceId, executionId);
        await this.#assertDirectory(
          execution.root,
          "EXECUTION_STORAGE_UNAVAILABLE",
        );
        return realpath(execution.root);
      },
      "EXECUTION_STORAGE_UNAVAILABLE",
      "代码执行副本不可用",
    );
  }

  async getWorkspaceRevision({ workspaceId, executionId }) {
    return guarded(
      async () => {
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, () =>
          this.#currentWorkspaceRevision(execution),
        );
      },
      "REVISION_FAILED",
      "无法计算代码执行副本版本",
    );
  }

  async withLockedExecution({ workspaceId, executionId }, operation) {
    if (typeof operation !== "function") {
      throw new CodeExecutionError("INVALID_OPERATION", "受控操作无效");
    }
    const execution = this.#execution(workspaceId, executionId);
    return this.#enqueue(execution, async () => {
      const beforeWorkspaceRevision =
        await this.#currentWorkspaceRevision(execution);
      const result = await operation({
        workspacePath: await realpath(execution.root),
        workspaceRevision: beforeWorkspaceRevision,
      });
      return {
        result,
        beforeWorkspaceRevision,
        afterWorkspaceRevision:
          await this.#currentWorkspaceRevision(execution),
      };
    });
  }

  #workspace(workspaceId) {
    validateWorkspaceId(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new CodeExecutionError("WORKSPACE_NOT_FOUND", "workspaceId 未注册");
    }
    return workspace;
  }

  #execution(workspaceId, executionId) {
    this.#workspace(workspaceId);
    validateExecutionId(executionId);
    const execution = this.executions.get(
      this.#executionKey(workspaceId, executionId),
    );
    if (!execution) {
      throw new CodeExecutionError("EXECUTION_NOT_FOUND", "executionId 不存在");
    }
    return execution;
  }

  #executionKey(workspaceId, executionId) {
    return `${workspaceId}:${executionId}`;
  }

  #executionStoragePaths(workspaceId, executionId) {
    const workspaceRoot = path.resolve(this.scratchRoot, workspaceId);
    const executionRoot = path.resolve(workspaceRoot, executionId);
    if (
      !this.#samePath(path.dirname(workspaceRoot), this.scratchRoot) ||
      !this.#samePath(path.dirname(executionRoot), workspaceRoot)
    ) {
      throw new CodeExecutionError(
        "EXECUTION_STORAGE_UNAVAILABLE",
        "代码执行副本路径不安全",
      );
    }
    return { workspaceRoot, executionRoot };
  }

  #samePath(left, right) {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  #pathsOverlap(left, right) {
    if (this.#samePath(left, right)) return true;
    const leftToRight = path.relative(path.resolve(left), path.resolve(right));
    const rightToLeft = path.relative(path.resolve(right), path.resolve(left));
    const isDescendant = (relative) =>
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    return isDescendant(leftToRight) || isDescendant(rightToLeft);
  }

  #enqueueExecutionLifecycle(key, operation) {
    const previous = this.executionLifecycles.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    this.executionLifecycles.set(key, tail);
    void tail.then(() => {
      if (this.executionLifecycles.get(key) === tail) {
        this.executionLifecycles.delete(key);
      }
    });
    return result;
  }

  #enqueue(execution, operation) {
    const result = execution.tail.then(operation, operation);
    execution.tail = result.catch(() => {});
    return result;
  }

  async #discardExecutionDirectory(workspaceId, executionId) {
    const { workspaceRoot, executionRoot } = this.#executionStoragePaths(
      workspaceId,
      executionId,
    );
    if (!(await this.#assertOptionalManagedDirectory(this.scratchRoot))) return;
    if (!(await this.#assertOptionalManagedDirectory(workspaceRoot))) return;
    await this.#assertCanonicalChild(this.scratchRoot, workspaceRoot);
    if (!(await this.#assertOptionalManagedDirectory(executionRoot))) return;
    await this.#assertCanonicalChild(workspaceRoot, executionRoot);
    await this.removeDirectory(executionRoot, {
      recursive: true,
      force: true,
    });
    if (await this.#lstatIfExists(executionRoot)) {
      throw new CodeExecutionError(
        "EXECUTION_STORAGE_UNAVAILABLE",
        "代码执行副本未能完全丢弃",
      );
    }
  }

  async #assertOptionalManagedDirectory(directory) {
    const stats = await this.#lstatIfExists(directory);
    if (!stats) return false;
    if (stats.isSymbolicLink()) {
      throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
    }
    if (!stats.isDirectory()) {
      throw new CodeExecutionError(
        "EXECUTION_STORAGE_UNAVAILABLE",
        "代码执行副本目录不可用",
      );
    }
    return true;
  }

  async #lstatIfExists(target) {
    try {
      return await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #assertCanonicalChild(parent, child) {
    const [canonicalParent, canonicalChild] = await Promise.all([
      realpath(parent),
      realpath(child),
    ]);
    if (!this.#samePath(path.dirname(canonicalChild), canonicalParent)) {
      throw new CodeExecutionError(
        "EXECUTION_STORAGE_UNAVAILABLE",
        "代码执行副本路径不安全",
      );
    }
  }

  #enqueueAtExpectedRevision(execution, request, operation) {
    if (request.expectedWorkspaceRevision === undefined) return operation();
    return this.#enqueue(execution, async () => {
      this.#assertWorkspaceRevision(request, execution.workspaceState.revision);
      return operation();
    });
  }

  #assertWorkspaceRevision(action, actualRevision) {
    if (action.expectedWorkspaceRevision === undefined) return;
    if (!/^[a-f0-9]{64}$/.test(action.expectedWorkspaceRevision)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_REVISION",
        "工作区版本格式无效",
      );
    }
    if (action.expectedWorkspaceRevision !== actualRevision) {
      throw new CodeExecutionError(
        "WORKSPACE_REVISION_MISMATCH",
        "工作区已发生变化",
      );
    }
  }

  #assertRequiredWorkspaceRevision(action) {
    if (action.expectedWorkspaceRevision === undefined) {
      throw new CodeExecutionError(
        "EXPECTED_WORKSPACE_REVISION_REQUIRED",
        "封存操作必须提供 expectedWorkspaceRevision",
      );
    }
  }

  #assertExecutionOpen(execution) {
    if (execution.seal) {
      throw new CodeExecutionError(
        "EXECUTION_SEALED",
        "代码执行副本已封存",
      );
    }
  }

  async #currentWorkspaceRevision(execution) {
    return workspaceRevisionFromFileHashes(
      await this.#currentFileHashes(execution),
    );
  }

  #commitCachedFileHash(execution, relativePath, fileHash) {
    const fileHashes = new Map(execution.workspaceState.fileHashes);
    if (fileHash === null) {
      fileHashes.delete(relativePath);
    } else {
      fileHashes.set(relativePath, fileHash);
    }
    const revision = workspaceRevisionFromFileHashes(fileHashes);
    execution.workspaceState = { fileHashes, revision };
    return revision;
  }

  async #createWorkspaceSnapshot(execution) {
    const current = await this.#currentFileHashes(execution);
    return {
      workspaceRevision: workspaceRevisionFromFileHashes(current),
      manifest: this.#createChangeManifest(execution, current),
    };
  }

  async #currentFileHashes(execution) {
    throwIfPreparationAborted();
    const fileHashes = new Map();
    for (const relativePath of await this.#collectFiles(execution, "")) {
      throwIfPreparationAborted();
      const file = await this.#readFileBuffer(execution, relativePath);
      fileHashes.set(relativePath, sha256(file.value));
    }
    return fileHashes;
  }

  #createChangeManifest(execution, current) {
    const created = [];
    const modified = [];
    const deleted = [];
    for (const [relativePath, currentSha256] of current) {
      const baselineSha256 = execution.baseline.get(relativePath);
      if (baselineSha256 === undefined) {
        created.push({ path: relativePath, sha256: currentSha256 });
      } else if (baselineSha256 !== currentSha256) {
        modified.push({
          path: relativePath,
          beforeSha256: baselineSha256,
          afterSha256: currentSha256,
        });
      }
    }
    for (const [relativePath, baselineSha256] of execution.baseline) {
      if (!current.has(relativePath)) {
        deleted.push({ path: relativePath, sha256: baselineSha256 });
      }
    }
    const byPath = (left, right) => left.path.localeCompare(right.path);
    return {
      created: created.sort(byPath),
      modified: modified.sort(byPath),
      deleted: deleted.sort(byPath),
    };
  }

  #copyWorkspaceSnapshot(snapshot) {
    return structuredClone(snapshot);
  }

  async #assertDirectory(directory, errorCode) {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
    }
    if (!stats.isDirectory()) {
      throw new CodeExecutionError(errorCode, "工作区目录不可用");
    }
  }

  async #verifyConflictMaterialization({
    workspace,
    executionRoot,
    executionSource,
    receipt,
  }) {
    const invalid = () => new CodeExecutionError(
      "CONFLICT_PREPARATION_RESULT_INVALID",
      "Conflict preparation 落盘结果与回执不一致",
    );
    await this.#assertDirectory(
      executionRoot,
      "CONFLICT_PREPARATION_RESULT_INVALID",
    );
    await this.#assertCanonicalChild(path.dirname(executionRoot), executionRoot);
    const actual = new Map();
    const portablePaths = new Set();
    const directories = new Set();
    let totalBytes = 0;
    let directoryCount = 0;
    const visit = async (directory, relativeDirectory) => {
      throwIfPreparationAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        throwIfPreparationAborted();
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        let normalizedPath;
        try {
          normalizedPath = workspace.policy.assertAccessible(relativePath);
        } catch {
          throw invalid();
        }
        if (normalizedPath !== relativePath) throw invalid();
        const portablePath = relativePath.toLowerCase();
        if (portablePaths.has(portablePath)) throw invalid();
        portablePaths.add(portablePath);
        const target = path.join(directory, entry.name);
        const stats = await lstat(target);
        if (stats.isSymbolicLink()) throw invalid();
        if (stats.isDirectory()) {
          directoryCount += 1;
          if (directoryCount > this.limits.maxDirectories) throw invalid();
          directories.add(relativePath);
          await visit(target, relativePath);
          continue;
        }
        if (!stats.isFile() || stats.nlink !== 1) throw invalid();
        if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o644) {
          throw invalid();
        }
        if (
          actual.size >= this.limits.maxFiles ||
          stats.size > this.limits.maxFileBytes
        ) {
          throw invalid();
        }
        const value = await readFile(target);
        totalBytes += value.length;
        if (
          !Number.isSafeInteger(totalBytes) ||
          value.length > this.limits.maxFileBytes ||
          totalBytes > this.limits.maxTotalBytes
        ) {
          throw invalid();
        }
        actual.set(relativePath, {
          sha256: sha256(value),
          mode: "100644",
          bytes: value.length,
        });
      }
    };
    await visit(executionRoot, "");
    const nonEmptyDirectories = new Set();
    for (const relativePath of actual.keys()) {
      const segments = relativePath.split("/").slice(0, -1);
      for (let index = 1; index <= segments.length; index += 1) {
        nonEmptyDirectories.add(segments.slice(0, index).join("/"));
      }
    }
    if (
      actual.size !== receipt.fileCount ||
      totalBytes !== receipt.totalBytes ||
      [...directories].some((directory) => !nonEmptyDirectories.has(directory)) ||
      [...actual].some(([relativePath, evidence]) => {
        const expected = receipt.fileEvidence.get(relativePath);
        return (
          expected === undefined ||
          expected.sha256 !== evidence.sha256 ||
          expected.mode !== evidence.mode ||
          expected.bytes !== evidence.bytes
        );
      }) ||
      [...receipt.fileEvidence.keys()].some(
        (relativePath) => !actual.has(relativePath),
      ) ||
      codeExecutionSourceWritablePaths(executionSource).some(
        (conflictPath) => !actual.has(conflictPath),
      )
    ) {
      throw invalid();
    }
    return new Map(
      [...actual].map(([relativePath, evidence]) => [
        relativePath,
        evidence.sha256,
      ]),
    );
  }

  async #verifyGitSnapshotMaterialization({
    workspace,
    executionRoot,
    receipt,
  }) {
    const invalid = () => new CodeExecutionError(
      "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
      "Git Head snapshot 落盘结果与回执不一致",
    );
    await this.#assertDirectory(
      executionRoot,
      "GIT_HEAD_SNAPSHOT_RESULT_INVALID",
    );
    await this.#assertCanonicalChild(path.dirname(executionRoot), executionRoot);
    const actual = new Map();
    const directories = new Set();
    let totalBytes = 0;
    let directoryCount = 0;
    const visit = async (directory, relativeDirectory) => {
      throwIfPreparationAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfPreparationAborted();
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const target = path.join(directory, entry.name);
        const stats = await lstat(target);
        if (stats.isSymbolicLink()) throw invalid();
        if (stats.isDirectory()) {
          directoryCount += 1;
          if (directoryCount > this.limits.maxDirectories) throw invalid();
          directories.add(relativePath);
          await visit(target, relativePath);
          continue;
        }
        if (!stats.isFile() || stats.nlink > 1) throw invalid();
        if (process.platform !== "win32") {
          const expectedMode = receipt.modes.get(relativePath);
          const actualMode = stats.mode & 0o777;
          if (
            expectedMode === undefined ||
            actualMode !== (expectedMode === "100755" ? 0o755 : 0o644)
          ) {
            throw invalid();
          }
        }
        if (
          actual.size >= this.limits.maxFiles ||
          stats.size > this.limits.maxFileBytes
        ) {
          throw invalid();
        }
        const value = await readFile(target);
        totalBytes += value.length;
        if (
          !Number.isSafeInteger(totalBytes) ||
          value.length > this.limits.maxFileBytes ||
          totalBytes > this.limits.maxTotalBytes
        ) {
          throw invalid();
        }
        actual.set(relativePath, sha256(value));
      }
    };
    await visit(executionRoot, "");
    const nonEmptyDirectories = new Set();
    for (const relativePath of actual.keys()) {
      const segments = relativePath.split("/").slice(0, -1);
      for (let index = 1; index <= segments.length; index += 1) {
        nonEmptyDirectories.add(segments.slice(0, index).join("/"));
      }
    }
    if (
      actual.size !== receipt.fileCount ||
      totalBytes !== receipt.totalBytes ||
      actual.size !== receipt.baseline.size ||
      [...directories].some((directory) => !nonEmptyDirectories.has(directory))
    ) {
      throw invalid();
    }
    for (const [relativePath, digest] of receipt.baseline) {
      if (
        workspace.policy.isExcluded(relativePath) ||
        actual.get(relativePath) !== digest
      ) {
        throw invalid();
      }
    }
    return actual;
  }

  async #copySanitizedDirectory({
    workspace,
    sourceDirectory,
    targetDirectory,
    relativeDirectory,
    baseline,
    copyState,
  }) {
    throwIfPreparationAborted();
    const sourceStats = await lstat(sourceDirectory);
    if (sourceStats.isSymbolicLink()) {
      throw new CodeExecutionError("SYMLINK_REJECTED", "源工作区包含符号链接");
    }
    if (!sourceStats.isDirectory()) {
      throw new CodeExecutionError("SOURCE_UNAVAILABLE", "源工作区不可用");
    }

    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfPreparationAborted();
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (workspace.policy.isExcluded(relativePath)) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new CodeExecutionError(
          "SYMLINK_REJECTED",
          "源工作区包含符号链接",
        );
      }
      if (stats.isDirectory()) {
        await mkdir(targetPath);
        await this.#copySanitizedDirectory({
          workspace,
          sourceDirectory: sourcePath,
          targetDirectory: targetPath,
          relativeDirectory: relativePath,
          baseline,
          copyState,
        });
        continue;
      }
      if (!stats.isFile()) {
        throw new CodeExecutionError(
          "UNSUPPORTED_FILE_TYPE",
          "源工作区包含不支持的文件类型",
        );
      }
      this.#countCopiedFile(stats.size, copyState);
      const value = await readFile(sourcePath);
      if (value.length > this.limits.maxFileBytes) {
        throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
      }
      const handle = await open(targetPath, "wx", stats.mode & 0o777);
      try {
        await handle.writeFile(value);
      } finally {
        await handle.close();
      }
      baseline.set(relativePath, sha256(value));
    }
  }

  #countCopiedFile(size, state) {
    state.fileCount += 1;
    state.totalBytes += size;
    if (state.fileCount > this.limits.maxFiles) {
      throw new CodeExecutionError("FILE_COUNT_LIMIT", "文件数量超过限制");
    }
    if (size > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    if (state.totalBytes > this.limits.maxTotalBytes) {
      throw new CodeExecutionError("TOTAL_SIZE_LIMIT", "工作区总大小超过限制");
    }
  }

  async #inspect(execution, relativePath, { allowMissing = false } = {}) {
    await this.#assertDirectory(execution.root, "EXECUTION_STORAGE_UNAVAILABLE");
    let current = execution.root;
    const segments = relativePath === "" ? [] : relativePath.split("/");
    let stats = await lstat(current);
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try {
        stats = await lstat(current);
      } catch (error) {
        if (allowMissing && error?.code === "ENOENT") {
          return { exists: false, absolutePath: current, missingAt: index };
        }
        if (error?.code === "ENOENT") {
          throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
      }
    }
    return { exists: true, absolutePath: current, stats };
  }

  async #collectFiles(execution, relativePath) {
    throwIfPreparationAborted();
    const scope = await this.#inspect(execution, relativePath);
    if (scope.stats.isFile()) return [relativePath];
    if (!scope.stats.isDirectory()) {
      throw new CodeExecutionError("FILE_NOT_FOUND", "工作区路径不是文件或目录");
    }
    const files = [];
    const visit = async (directoryPath, relativeDirectory) => {
      throwIfPreparationAborted();
      const entries = await readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfPreparationAborted();
        const childRelative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (execution.workspace.policy.isExcluded(childRelative)) continue;
        const child = await this.#inspect(execution, childRelative);
        if (child.stats.isDirectory()) {
          await visit(child.absolutePath, childRelative);
        } else if (child.stats.isFile()) {
          files.push(childRelative);
          if (files.length > this.limits.maxFiles) {
            throw new CodeExecutionError(
              "FILE_COUNT_LIMIT",
              "文件数量超过限制",
            );
          }
        } else {
          throw new CodeExecutionError(
            "UNSUPPORTED_FILE_TYPE",
            "工作区包含不支持的文件类型",
          );
        }
      }
    };
    await visit(scope.absolutePath, relativePath);
    return files;
  }

  async #readFileBuffer(execution, relativePath) {
    const inspected = await this.#inspect(execution, relativePath);
    if (!inspected.stats.isFile()) {
      throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
    }
    if (inspected.stats.size > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    const value = await readFile(inspected.absolutePath);
    if (value.length > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    return { value, stats: inspected.stats, absolutePath: inspected.absolutePath };
  }

  async #readTextFile(execution, relativePath) {
    const file = await this.#readFileBuffer(execution, relativePath);
    return {
      ...file,
      content: decodeText(file.value),
      sha256: sha256(file.value),
      bytes: file.value.length,
    };
  }

  async #writeFile(execution, action) {
    const relativePath = this.#assertExecutionWritable(execution, action.path);
    assertExpectedSha256(action.expectedSha256);
    if (typeof action.content !== "string" || action.content.includes("\0")) {
      throw new CodeExecutionError("TEXT_REQUIRED", "只能写入纯文本内容");
    }
    const value = Buffer.from(action.content, "utf8");
    if (value.length > this.limits.maxWriteBytes) {
      throw new CodeExecutionError("WRITE_SIZE_LIMIT", "写入内容超过大小限制");
    }
    if (value.length > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }

    const existing = await this.#inspect(execution, relativePath, {
      allowMissing: true,
    });
    if (existing.exists) {
      if (!existing.stats.isFile()) {
        throw new CodeExecutionError("WRITE_NOT_ALLOWED", "目标不是普通文件");
      }
      if (existing.stats.nlink > 1) {
        throw new CodeExecutionError("HARDLINK_REJECTED", "硬链接文件不可覆盖");
      }
      const current = await readFile(existing.absolutePath);
      if (sha256(current) !== action.expectedSha256) {
        throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
      }
    } else {
      if (action.expectedSha256 !== null) {
        throw new CodeExecutionError("SHA256_MISMATCH", "新文件必须使用空版本");
      }
      const files = await this.#collectFiles(execution, "");
      if (files.length >= this.limits.maxFiles) {
        throw new CodeExecutionError("FILE_COUNT_LIMIT", "文件数量超过限制");
      }
      await this.#ensureParentDirectories(execution, relativePath);
    }

    await this.#verifyWriteVersion(execution, relativePath, action.expectedSha256);
    const target = path.join(execution.root, ...relativePath.split("/"));
    const temporary = path.join(
      path.dirname(target),
      `.code-broker-tmp-${randomUUID()}.key`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return {
      path: relativePath,
      sha256: sha256(value),
      bytes: value.length,
    };
  }

  async #verifyWriteVersion(execution, relativePath, expectedSha256) {
    const current = await this.#inspect(execution, relativePath, {
      allowMissing: true,
    });
    if (!current.exists) {
      if (expectedSha256 !== null) {
        throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
      }
      return;
    }
    if (!current.stats.isFile() || current.stats.nlink > 1) {
      throw new CodeExecutionError("HARDLINK_REJECTED", "目标文件不可覆盖");
    }
    const value = await readFile(current.absolutePath);
    if (sha256(value) !== expectedSha256) {
      throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
    }
  }

  async #ensureParentDirectories(execution, relativePath) {
    const segments = relativePath.split("/").slice(0, -1);
    let current = execution.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
        }
        if (!stats.isDirectory()) {
          throw new CodeExecutionError("WRITE_NOT_ALLOWED", "父路径不是目录");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
  }

  async #deleteFile(execution, action) {
    const relativePath = this.#assertExecutionWritable(execution, action.path);
    assertExpectedSha256(action.expectedSha256);
    if (action.expectedSha256 === null) {
      throw new CodeExecutionError("INVALID_SHA256", "删除操作需要文件版本");
    }
    const file = await this.#readFileBuffer(execution, relativePath);
    if (file.stats.nlink > 1) {
      throw new CodeExecutionError("HARDLINK_REJECTED", "硬链接文件不可删除");
    }
    if (sha256(file.value) !== action.expectedSha256) {
      throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
    }
    await unlink(file.absolutePath);
    return { path: relativePath, deleted: true };
  }

  #assertExecutionWritable(execution, value) {
    const relativePath = execution.workspace.policy.assertWritable(value);
    if (
      execution.exactWritablePaths !== null &&
      !execution.exactWritablePaths.has(relativePath)
    ) {
      throw new CodeExecutionError(
        "WRITE_NOT_ALLOWED",
        "该执行来源只允许修改精确冲突文件",
      );
    }
    return relativePath;
  }
}
