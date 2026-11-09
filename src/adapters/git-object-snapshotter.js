import { createHash } from "node:crypto";
import { throwIfPreparationAborted, isPreparationAbort, withoutPreparationCancellation,
  watchPreparationProcess, PreparationAbortedError } from "../lib/preparation-cancellation.js";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isWindowsGitImplementationPath } from "../lib/windows-git-implementation.js";
import { MAX_BLOBS_PER_BATCH, parseGitBlobBatch } from "../lib/git-blob-batch.js";

import {
  CodeExecutionPolicy,
  normalizeWorkspacePath,
} from "../domain/code-execution-policy.js";

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TREE_HEADER = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*]/u;
const SAFE_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});
const SAFE_GIT_PREFIX = Object.freeze([
  "--no-lazy-fetch",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.commitGraph=false",
]);
const MAX_PACK_DATABASE_ENTRIES = 100_000;
const MAX_LOOSE_OBJECT_ENTRIES = 100_000;
const MAX_GIT_EXECUTABLE_BYTES = 256 * 1024 * 1024;
// Error properties and messages may originate outside the process producer.
// Only these private records can supply persistent command diagnostics.
const processFailureObservations = new WeakMap();
const snapshotFailureDiagnostics = new WeakMap();
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 50_000_000,
  maxPathBytes: 4_096,
  maxPathDepth: 128,
  maxSegmentBytes: 255,
  maxDirectories: 5_000,
  maxTreeBytes: 8_000_000,
});

export class GitObjectSnapshotterError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitObjectSnapshotterError";
    this.code = code;
  }
}

function snapshotError(code, message, cause) {
  const error = new GitObjectSnapshotterError(code, message, { cause });
  const diagnostic = snapshotFailureDiagnostics.get(cause);
  if (diagnostic) snapshotFailureDiagnostics.set(error, diagnostic);
  return error;
}

export function gitSnapshotFailureDiagnostic(error) {
  const diagnostic = snapshotFailureDiagnostics.get(error);
  if (!diagnostic) return null;
  const batch = diagnostic.batchIndex === undefined ? "" :
    ` batch=${diagnostic.batchIndex}/${diagnostic.batchCount} objects=${diagnostic.objectCount}`;
  return `Git snapshot: stage=${diagnostic.stage} operation=${diagnostic.operation}${batch}` +
    ` elapsedMs=${diagnostic.elapsedMs} budgetMs=${diagnostic.budgetMs}` +
    ` stdoutBytes=${diagnostic.stdoutBytes} stderrBytes=${diagnostic.stderrBytes} process=${diagnostic.process}`;
}

function commandDiagnostic(args) {
  if (args[0] === "cat-file" && args[1] === "--batch") return { stage: "blob_read", operation: "blob_batch" };
  if (args[0] === "cat-file") return { stage: "head_validation", operation: "commit_type" };
  if (args[0] === "ls-tree") return { stage: "tree_read", operation: "tree_list" };
  return { stage: "preflight", operation: args[0] === "config" ? "configuration_read" : "repository_identity" };
}

function observeProcessFailure(error, child, stdout, stderr) {
  processFailureObservations.set(error, {
    stdoutBytes: Buffer.isBuffer(stdout) ? stdout.length : "unknown",
    stderrBytes: Buffer.isBuffer(stderr) ? stderr.length : "unknown",
    process: !Number.isSafeInteger(child?.pid) ? "not_started" :
      child.exitCode !== null || child.signalCode !== null ? "stopped" : "unknown",
  });
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundaryDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function gitBlobOid(objectFormat, value) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function exactDataObject(value, keys, code = "INVALID_GIT_SNAPSHOT_REQUEST") {
  if (!isPlainRecord(value)) {
    throw snapshotError(code, "Git object snapshot 请求无效");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw snapshotError(code, "Git object snapshot 请求无效");
  }
  return value;
}

function validateLimits(overrides) {
  if (!isPlainRecord(overrides)) {
    throw snapshotError(
      "INVALID_GIT_SNAPSHOT_CONFIG",
      "Git object snapshot 限制无效",
    );
  }
  const allowed = new Set(Object.keys(DEFAULT_LIMITS));
  if (
    Reflect.ownKeys(overrides).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
      return (
        typeof key !== "string" ||
        !allowed.has(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw snapshotError(
      "INVALID_GIT_SNAPSHOT_CONFIG",
      "Git object snapshot 限制无效",
    );
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw snapshotError(
        "INVALID_GIT_SNAPSHOT_CONFIG",
        "Git object snapshot 限制无效",
      );
    }
  }
  return Object.freeze(limits);
}

function requireRunner(value) {
  if (!value || typeof value.run !== "function") {
    throw new TypeError("processRunner must provide run");
  }
  return value.run.bind(value);
}

function normalizeExcludePaths(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw snapshotError(
      "INVALID_GIT_SNAPSHOT_REQUEST",
      "Git object snapshot excludePaths 无效",
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some((key) => {
      if (key === "length") return false;
      if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
        return true;
      }
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      );
    })
  ) {
    throw snapshotError(
      "INVALID_GIT_SNAPSHOT_REQUEST",
      "Git object snapshot excludePaths 无效",
    );
  }
  try {
    return value.map((entry) => normalizeWorkspacePath(entry));
  } catch (cause) {
    throw snapshotError(
      "INVALID_GIT_SNAPSHOT_REQUEST",
      "Git object snapshot excludePaths 无效",
      cause,
    );
  }
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDescendantPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return (
    samePath(left, right) ||
    isDescendantPath(left, right) ||
    isDescendantPath(right, left)
  );
}

function isWindowsNetworkPath(value) {
  if (process.platform !== "win32") return false;
  const normalized = path.resolve(value).toLowerCase();
  return (
    normalized.startsWith("\\\\") ||
    normalized.startsWith("\\\\?\\unc\\")
  );
}

function isTrustedWindowsGitImplementation(value) {
  return process.platform !== "win32" || isWindowsGitImplementationPath(value);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function decodeUtf8(value, code, message) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw snapshotError(code, message, cause);
  }
}

function decodeSingleLine(value, code, message) {
  const decoded = decodeUtf8(value, code, message);
  const line = decoded.endsWith("\r\n")
    ? decoded.slice(0, -2)
    : decoded.endsWith("\n")
      ? decoded.slice(0, -1)
      : decoded;
  if (line.length === 0 || /[\r\n]/u.test(line)) {
    throw snapshotError(code, message);
  }
  return line;
}

function successfulOutput(result, code, message) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.truncated !== false ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    throw snapshotError(code, message);
  }
  return result.stdout;
}

function optionalOutput(result, code, message) {
  if (
    result === null ||
    typeof result !== "object" ||
    ![0, 1].includes(result.exitCode) ||
    result.signal !== null ||
    result.truncated !== false ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    (result.exitCode === 1 && result.stdout.length !== 0)
  ) {
    throw snapshotError(code, message);
  }
  return result.stdout;
}

function configurationNames(value) {
  const decoded = decodeUtf8(
    value,
    "GIT_SNAPSHOT_PROTOCOL_ERROR",
    "Git repository 配置输出无效",
  );
  if (decoded.length === 0) return [];
  if (!decoded.endsWith("\0")) {
    throw snapshotError(
      "GIT_SNAPSHOT_PROTOCOL_ERROR",
      "Git repository 配置输出无效",
    );
  }
  const names = decoded.split("\0");
  names.pop();
  if (
    names.some(
      (name) =>
        name.length === 0 ||
        CONTROL_CHARACTER.test(name),
    )
  ) {
    throw snapshotError(
      "GIT_SNAPSHOT_PROTOCOL_ERROR",
      "Git repository 配置输出无效",
    );
  }
  return names.map((name) => name.toLowerCase());
}

function pathIdentity(relativePath) {
  return relativePath.normalize("NFC").toLowerCase();
}

function validateRepositoryPath(value, limits) {
  if (Buffer.byteLength(value, "utf8") > limits.maxPathBytes) {
    throw snapshotError(
      "GIT_SNAPSHOT_INVALID_PATH",
      "Git tree 包含过长路径",
    );
  }
  if (
    CONTROL_CHARACTER.test(value) ||
    WINDOWS_INVALID_CHARACTER.test(value) ||
    value.normalize("NFC") !== value
  ) {
    throw snapshotError(
      "GIT_SNAPSHOT_INVALID_PATH",
      "Git tree 包含不安全路径",
    );
  }
  let normalized;
  try {
    normalized = normalizeWorkspacePath(value);
  } catch (cause) {
    throw snapshotError(
      "GIT_SNAPSHOT_INVALID_PATH",
      "Git tree 包含不安全路径",
      cause,
    );
  }
  if (normalized !== value) {
    throw snapshotError(
      "GIT_SNAPSHOT_INVALID_PATH",
      "Git tree 包含不安全路径",
    );
  }
  const segments = normalized.split("/");
  if (
    segments.length > limits.maxPathDepth ||
    segments.some(
      (segment) => Buffer.byteLength(segment, "utf8") > limits.maxSegmentBytes,
    )
  ) {
    throw snapshotError(
      "GIT_SNAPSHOT_INVALID_PATH",
      "Git tree 路径层级或名称超过限制",
    );
  }
  return normalized;
}

function assertNoPathCollision(relativePath, pathState, limits) {
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(0, index + 1).join("/");
    const kind = index === segments.length - 1 ? "file" : "directory";
    const identity = pathIdentity(candidate);
    const existing = pathState.identities.get(identity);
    if (
      existing &&
      (existing.path !== candidate ||
        existing.kind !== kind ||
        kind === "file")
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_PATH_COLLISION",
        "Git tree 路径在目标文件系统中冲突",
      );
    }
    if (!existing) {
      pathState.identities.set(identity, { path: candidate, kind });
      if (kind === "directory") {
        pathState.directoryCount += 1;
        if (pathState.directoryCount > limits.maxDirectories) {
          throw snapshotError(
            "GIT_DIRECTORY_COUNT_LIMIT",
            "Git tree 目录数量超过限制",
          );
        }
      }
    }
  }
}

function splitNullTerminated(value) {
  if (value.length === 0) return [];
  if (value.at(-1) !== 0) {
    throw snapshotError(
      "GIT_SNAPSHOT_PROTOCOL_ERROR",
      "Git tree 输出不完整",
    );
  }
  const entries = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index === start) {
      throw snapshotError(
        "GIT_SNAPSHOT_PROTOCOL_ERROR",
        "Git tree 输出无效",
      );
    }
    entries.push(value.subarray(start, index));
    start = index + 1;
  }
  return entries;
}

function parseTree(value, { headOid, limits, shouldInclude }) {
  if (value.length > limits.maxTreeBytes) {
    throw snapshotError("GIT_TREE_SIZE_LIMIT", "Git tree 元数据超过限制");
  }
  const pathState = { identities: new Map(), directoryCount: 0 };
  const entries = [];
  for (const encodedEntry of splitNullTerminated(value)) {
    const tab = encodedEntry.indexOf(0x09);
    if (tab < 1 || tab === encodedEntry.length - 1) {
      throw snapshotError(
        "GIT_SNAPSHOT_PROTOCOL_ERROR",
        "Git tree 输出无效",
      );
    }
    const header = decodeSingleLine(
      encodedEntry.subarray(0, tab),
      "GIT_SNAPSHOT_PROTOCOL_ERROR",
      "Git tree 输出无效",
    );
    const match = TREE_HEADER.exec(header);
    if (!match || match[3].length !== headOid.length) {
      throw snapshotError(
        "GIT_SNAPSHOT_PROTOCOL_ERROR",
        "Git tree 输出无效",
      );
    }
    const [mode, type, oid] = match.slice(1);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
      throw snapshotError(
        "GIT_SNAPSHOT_UNSUPPORTED_ENTRY",
        "Git tree 包含不支持的符号链接或子仓库",
      );
    }
    const relativePath = validateRepositoryPath(
      decodeUtf8(
        encodedEntry.subarray(tab + 1),
        "GIT_SNAPSHOT_INVALID_PATH",
        "Git tree 路径编码无效",
      ),
      limits,
    );
    let included;
    try {
      included = shouldInclude(relativePath);
    } catch (cause) {
      throw snapshotError(
        "GIT_SNAPSHOT_FILTER_FAILED",
        "Git tree 路径过滤失败",
        cause,
      );
    }
    if (typeof included !== "boolean") {
      throw snapshotError(
        "GIT_SNAPSHOT_FILTER_FAILED",
        "Git tree 路径过滤结果无效",
      );
    }
    if (!included) continue;
    assertNoPathCollision(relativePath, pathState, limits);
    entries.push({ relativePath, mode, oid });
    if (entries.length > limits.maxFiles) {
      throw snapshotError("FILE_COUNT_LIMIT", "文件数量超过限制");
    }
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return entries;
}

function parseBlobs(value, oids, limits, objectFormat) {
  try {
    return parseGitBlobBatch(value, oids, {
      objectFormat, maxBlobBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes,
    });
  } catch (cause) {
    const codes = {
      PROTOCOL_ERROR: ["GIT_SNAPSHOT_PROTOCOL_ERROR", "Git blob 输出无效"],
      BLOB_SIZE_LIMIT: ["FILE_SIZE_LIMIT", "文件超过大小限制"],
      TOTAL_SIZE_LIMIT: ["TOTAL_SIZE_LIMIT", "工作区总大小超过限制"],
      OBJECT_MISMATCH: ["GIT_SNAPSHOT_OBJECT_MISMATCH", "Git blob 内容与对象身份不一致"],
    };
    const [code, message] = codes[cause.code] ?? codes.PROTOCOL_ERROR;
    throw snapshotError(code, message, cause);
  }
}

export class BinaryExecFileRunner {
  async run({ command, args, cwd, env, input, timeoutMs, maxOutputBytes }) {
    throwIfPreparationAborted();
    return new Promise((resolve, reject) => {
      let child;
      let releaseAbort = () => false;
      try {
        child = execFile(
          command,
          args,
          {
            cwd,
            env,
            encoding: "buffer",
            killSignal: "SIGKILL",
            maxBuffer: maxOutputBytes,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (releaseAbort() && error?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(observeProcessFailure(new PreparationAbortedError(), child, stdout, stderr));
              return;
            }
            if (
              error &&
              (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            ) {
              reject(
                observeProcessFailure(snapshotError(
                  error.killed
                    ? "GIT_SNAPSHOT_TIMEOUT"
                    : "GIT_SNAPSHOT_OUTPUT_LIMIT",
                  error.killed
                    ? "Git object snapshot 命令超时"
                    : "Git object snapshot 输出超过限制",
                  error,
                ), child, stdout, stderr),
              );
              return;
            }
            const result = {
              exitCode: error ? Number.isSafeInteger(error.code) ? error.code : -1 : 0,
              signal: error?.signal ?? null,
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
              stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
              truncated: false,
            };
            if (error) observeProcessFailure(result, child, stdout, stderr);
            resolve(result);
          },
        );
      } catch (cause) {
        reject(
          observeProcessFailure(snapshotError(
            "GIT_SNAPSHOT_PROCESS_FAILED",
            "Git object snapshot 命令无法启动",
            cause,
          ), child, undefined, undefined),
        );
        return;
      }
      releaseAbort = watchPreparationProcess(child);
      child.stdin?.once("error", (error) => {
        if (error?.code !== "EPIPE") {
          child.kill("SIGKILL");
        }
      });
      child.stdin?.end(input);
    });
  }
}

export class GitObjectSnapshotter {
  #gitCommand;
  #limits;
  #run;
  #timeoutMs;

  constructor({
    gitCommand,
    processRunner = new BinaryExecFileRunner(),
    timeoutMs = 30_000,
    limits = {},
  } = {}) {
    if (
      typeof gitCommand !== "string" ||
      !path.isAbsolute(gitCommand) ||
      gitCommand.includes("\0")
    ) {
      throw snapshotError(
        "INVALID_GIT_SNAPSHOT_CONFIG",
        "gitCommand 必须是可信的绝对路径",
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw snapshotError(
        "INVALID_GIT_SNAPSHOT_CONFIG",
        "Git object snapshot timeout 无效",
      );
    }
    this.#gitCommand = path.resolve(gitCommand);
    this.#run = requireRunner(processRunner);
    this.#timeoutMs = timeoutMs;
    this.#limits = validateLimits(limits);
    Object.freeze(this);
  }

  async preflight(value) {
    exactDataObject(value, ["sourceRoot"]);
    const sourceRootValue = value.sourceRoot;
    if (
      typeof sourceRootValue !== "string" ||
      !path.isAbsolute(sourceRootValue) ||
      sourceRootValue.includes("\0")
    ) {
      throw snapshotError(
        "INVALID_GIT_SNAPSHOT_REQUEST",
        "Git object snapshot preflight 请求无效",
      );
    }
    const sourceRoot = path.resolve(sourceRootValue);
    try {
      return await this.#preflight(sourceRoot);
    } catch (cause) {
      if (cause instanceof GitObjectSnapshotterError) throw cause;
      throw snapshotError(
        "GIT_SNAPSHOT_PREFLIGHT_FAILED",
        "Git object snapshot 边界预检失败",
        cause,
      );
    }
  }

  async materialize(value) {
    throwIfPreparationAborted();
    exactDataObject(value, [
      "sourceRoot",
      "targetRoot",
      "headOid",
      "excludePaths",
      "expectedBoundaryDigest",
      "expectedGitCommand",
      "expectedGitExecutableSha256",
      "expectedGitExecutableBytes",
      "expectedGitExecutableMode",
      "expectedGitExecutableUid",
      "expectedGitExecutableGid",
    ]);
    const sourceRootValue = value.sourceRoot;
    const targetRootValue = value.targetRoot;
    const headOid = value.headOid;
    const expectedBoundaryDigest = value.expectedBoundaryDigest;
    const expectedGitCommand = value.expectedGitCommand;
    const expectedGitExecutableSha256 = value.expectedGitExecutableSha256;
    const expectedGitExecutableBytes = value.expectedGitExecutableBytes;
    const expectedGitExecutableMode = value.expectedGitExecutableMode;
    const expectedGitExecutableUid = value.expectedGitExecutableUid;
    const expectedGitExecutableGid = value.expectedGitExecutableGid;
    const excludePaths = normalizeExcludePaths(value.excludePaths);
    if (
      typeof sourceRootValue !== "string" ||
      !path.isAbsolute(sourceRootValue) ||
      sourceRootValue.includes("\0") ||
      typeof targetRootValue !== "string" ||
      !path.isAbsolute(targetRootValue) ||
      targetRootValue.includes("\0") ||
      !GIT_OID.test(headOid) ||
      typeof expectedBoundaryDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedBoundaryDigest) ||
      typeof expectedGitCommand !== "string" ||
      !path.isAbsolute(expectedGitCommand) ||
      expectedGitCommand.includes("\0") ||
      !/^[a-f0-9]{64}$/u.test(expectedGitExecutableSha256) ||
      !Number.isSafeInteger(expectedGitExecutableBytes) ||
      expectedGitExecutableBytes < 1 ||
      expectedGitExecutableBytes > MAX_GIT_EXECUTABLE_BYTES ||
      !Number.isSafeInteger(expectedGitExecutableMode) ||
      expectedGitExecutableMode < 0 ||
      expectedGitExecutableMode > 0o7777 ||
      !Number.isSafeInteger(expectedGitExecutableUid) ||
      expectedGitExecutableUid < 0 ||
      !Number.isSafeInteger(expectedGitExecutableGid) ||
      expectedGitExecutableGid < 0
    ) {
      throw snapshotError(
        "INVALID_GIT_SNAPSHOT_REQUEST",
        "Git object snapshot 请求无效",
      );
    }
    const sourceRoot = path.resolve(sourceRootValue);
    const targetRoot = path.resolve(targetRootValue);
    const policy = new CodeExecutionPolicy({
      excludePaths,
    });
    try {
      await this.#assertRoot(sourceRoot, { empty: false, source: true });
      await this.#assertRoot(targetRoot, { empty: true, source: false });
      const boundary = await this.#preflight(sourceRoot, {
        gitCommand: path.resolve(expectedGitCommand),
        gitExecutableSha256: expectedGitExecutableSha256,
        gitExecutableBytes: expectedGitExecutableBytes,
        gitExecutableMode: expectedGitExecutableMode,
        gitExecutableUid: expectedGitExecutableUid,
        gitExecutableGid: expectedGitExecutableGid,
      });
      if (boundary.boundaryDigest !== expectedBoundaryDigest) {
        throw snapshotError(
          "GIT_SNAPSHOT_BOUNDARY_MISMATCH",
          "Git repository 边界已发生变化",
        );
      }
      if (
        [
          boundary.canonicalRoot,
          boundary.absoluteGitDir,
          boundary.commonDir,
        ].some((repositoryPath) => pathsOverlap(repositoryPath, targetRoot))
      ) {
        throw snapshotError(
          "GIT_SNAPSHOT_TARGET_UNAVAILABLE",
          "Git snapshot 目标目录不得与仓库边界重叠",
        );
      }
      const objectType = await this.#gitOptionalText(
        ["cat-file", "-t", headOid],
        sourceRoot,
      );
      if (boundary.oidLength !== headOid.length || objectType !== "commit") {
        throw snapshotError(
          "GIT_HEAD_UNAVAILABLE",
          "指定 Git Head 不是本地可用的 commit",
        );
      }
      const treeOutput = await this.#gitBytes(
        ["ls-tree", "-rz", "--full-tree", headOid],
        sourceRoot,
        undefined,
        this.#limits.maxTreeBytes,
      );
      const entries = parseTree(treeOutput, {
        headOid,
        limits: this.#limits,
        shouldInclude: (relativePath) => !policy.isExcluded(relativePath),
      });
      const oids = [...new Set(entries.map((entry) => entry.oid))];
      const blobs = new Map();
      let uniqueBlobBytes = 0;
      // A whole repository can exceed one command's deadline. Keep each read
      // bounded while validating the complete object set before writing files.
      for (let offset = 0; offset < oids.length; offset += MAX_BLOBS_PER_BATCH) {
        throwIfPreparationAborted();
        const batchOids = oids.slice(offset, offset + MAX_BLOBS_PER_BATCH);
        const remainingBytes = this.#limits.maxTotalBytes - uniqueBlobBytes;
        const blobOutput = await this.#gitBytes(
          ["cat-file", "--batch"],
          sourceRoot,
          Buffer.from(batchOids.map((oid) => `${oid}\n`).join("")),
          Math.min(Number.MAX_SAFE_INTEGER, remainingBytes + batchOids.length * 160 + 1),
          {
            batchIndex: offset / MAX_BLOBS_PER_BATCH + 1,
            batchCount: Math.ceil(oids.length / MAX_BLOBS_PER_BATCH),
            objectCount: batchOids.length,
          },
        );
        const batchBlobs = parseBlobs(
          blobOutput,
          batchOids,
          { ...this.#limits, maxTotalBytes: remainingBytes },
          boundary.objectFormat,
        );
        for (const [oid, content] of batchBlobs) {
          blobs.set(oid, content);
          uniqueBlobBytes += content.length;
        }
      }
      const totalBytes = entries.reduce((sum, entry) => {
        const content = blobs.get(entry.oid);
        if (!Buffer.isBuffer(content)) {
          throw snapshotError(
            "GIT_SNAPSHOT_PROTOCOL_ERROR",
            "Git blob 身份无法验证",
          );
        }
        const next = sum + content.length;
        if (!Number.isSafeInteger(next) || next > this.#limits.maxTotalBytes) {
          throw snapshotError("TOTAL_SIZE_LIMIT", "工作区总大小超过限制");
        }
        return next;
      }, 0);
      const baseline = new Map();
      const modes = new Map();
      const createdFiles = new Set();
      const createdDirectories = new Set();
      try {
        for (const entry of entries) {
          throwIfPreparationAborted();
          const content = blobs.get(entry.oid);
          const target = path.resolve(
            targetRoot,
            ...entry.relativePath.split("/"),
          );
          if (!isDescendantPath(targetRoot, target)) {
            throw snapshotError(
              "GIT_SNAPSHOT_INVALID_PATH",
              "Git tree 路径逃逸目标目录",
            );
          }
          await this.#createParentDirectories(
            targetRoot,
            entry.relativePath,
            createdDirectories,
          );
          const handle = await open(
            target,
            "wx",
            entry.mode === "100755" ? 0o755 : 0o644,
          );
          createdFiles.add(target);
          try {
            await handle.writeFile(content);
            await handle.chmod(entry.mode === "100755" ? 0o755 : 0o644);
          } finally {
            await handle.close();
          }
          baseline.set(entry.relativePath, sha256(content));
          modes.set(entry.relativePath, entry.mode);
        }
      } catch (cause) {
        try {
          await withoutPreparationCancellation(() => this.#cleanupCreatedOutput(
            targetRoot,
            createdFiles,
            createdDirectories,
          ));
        } catch (cleanupCause) {
          throw snapshotError(
            "GIT_SNAPSHOT_CLEANUP_FAILED",
            "Git snapshot 部分输出无法清理",
            cleanupCause,
          );
        }
        throw cause;
      }
      return {
        headOid,
        baseline,
        modes,
        fileCount: entries.length,
        totalBytes,
      };
    } catch (cause) {
      if (isPreparationAbort(cause)) throw cause;
      if (cause instanceof GitObjectSnapshotterError) throw cause;
      throw snapshotError(
        "GIT_SNAPSHOT_FAILED",
        "无法从指定 Git Head 创建代码快照",
        cause,
      );
    }
  }

  async #preflight(sourceRoot, expectedGitExecutable = null) {
    await this.#assertRoot(sourceRoot, { empty: false, source: true });
    const localRepository = await this.#localRepositoryBoundary(sourceRoot);
    const gitExecutable = await this.#gitExecutableIdentity(sourceRoot);
    if (
      expectedGitExecutable !== null &&
      (!samePath(gitExecutable.gitCommand, expectedGitExecutable.gitCommand) ||
        gitExecutable.gitExecutableSha256 !==
          expectedGitExecutable.gitExecutableSha256 ||
        gitExecutable.gitExecutableBytes !==
          expectedGitExecutable.gitExecutableBytes ||
        gitExecutable.gitExecutableMode !==
          expectedGitExecutable.gitExecutableMode ||
        gitExecutable.gitExecutableUid !== expectedGitExecutable.gitExecutableUid ||
        gitExecutable.gitExecutableGid !== expectedGitExecutable.gitExecutableGid)
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_BOUNDARY_MISMATCH",
        "Git executable 边界已发生变化",
      );
    }
    const repositoryConfiguration = configurationNames(
      await this.#gitOptionalBytes(
        ["config", "--no-includes", "-z", "--name-only", "--list"],
        sourceRoot,
        65_536,
      ),
    );
    if (
      repositoryConfiguration.some(
        (name) => name.startsWith("include.") || name.startsWith("includeif."),
      )
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_UNTRUSTED_CONFIG",
        "Git repository 不允许引用外部配置",
      );
    }
    if (
      repositoryConfiguration.some(
        (name) =>
          name === "extensions.partialclone" ||
          (name.startsWith("remote.") && name.endsWith(".promisor")),
      )
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_PARTIAL_REPOSITORY",
        "partial/promisor Git repository 不允许执行固定 Head 快照",
      );
    }
    const [
      objectFormat,
      repositoryRoot,
      absoluteGitDir,
      commonDir,
    ] = await Promise.all([
      this.#gitText(["rev-parse", "--show-object-format"], sourceRoot),
      this.#gitText(["rev-parse", "--show-toplevel"], sourceRoot),
      this.#gitText(["rev-parse", "--absolute-git-dir"], sourceRoot),
      this.#gitText(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        sourceRoot,
      ),
    ]);
    const oidLength = objectFormat === "sha1"
      ? 40
      : objectFormat === "sha256"
        ? 64
        : 0;
    if (oidLength === 0) {
      throw snapshotError(
        "GIT_SNAPSHOT_OBJECT_FORMAT_UNSUPPORTED",
        "Git object format 不受支持",
      );
    }
    if (
      !path.isAbsolute(repositoryRoot) ||
      !samePath(repositoryRoot, sourceRoot) ||
      !path.isAbsolute(absoluteGitDir) ||
      !samePath(absoluteGitDir, localRepository.gitDir) ||
      !path.isAbsolute(commonDir) ||
      !samePath(commonDir, localRepository.gitDir)
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_ROOT_MISMATCH",
        "Git snapshot 必须绑定仓库根目录",
      );
    }
    const canonicalRoot = await realpath(sourceRoot);
    const canonicalGitDir = await this.#canonicalDirectory(
      localRepository.gitDir,
      "Git object database 目录不安全",
    );
    const canonicalCommonDir = await this.#canonicalDirectory(
      localRepository.gitDir,
      "Git common object database 目录不安全",
    );
    const objectDirectory = await this.#canonicalDirectory(
      localRepository.objectDirectory,
      "Git object database 目录不安全",
    );
    await this.#assertSafeObjectDatabase(objectDirectory);
    if (await this.#hasPromisorPack(objectDirectory)) {
      throw snapshotError(
        "GIT_SNAPSHOT_PARTIAL_REPOSITORY",
        "partial/promisor Git repository 不允许执行固定 Head 快照",
      );
    }
    const content = {
      schemaVersion: 1,
      ...gitExecutable,
      canonicalRoot,
      absoluteGitDir: canonicalGitDir,
      commonDir: canonicalCommonDir,
      objectDirectory,
      objectFormat,
      oidLength,
    };
    return Object.freeze({
      ...content,
      boundaryDigest: boundaryDigest(content),
    });
  }

  async #localRepositoryBoundary(sourceRoot) {
    const gitDir = path.join(sourceRoot, ".git");
    const canonicalGitDir = await this.#canonicalDirectory(
      gitDir,
      "Git repository 必须使用仓库内的本地 .git 目录",
    );
    if (!isDescendantPath(sourceRoot, canonicalGitDir)) {
      throw snapshotError(
        "GIT_SNAPSHOT_ROOT_MISMATCH",
        "Git repository 必须使用仓库内的本地 .git 目录",
      );
    }
    try {
      await lstat(path.join(canonicalGitDir, "commondir"));
      throw snapshotError(
        "GIT_SNAPSHOT_ROOT_MISMATCH",
        "Git linked worktree/commonDir 不允许执行固定 Head 快照",
      );
    } catch (cause) {
      if (cause instanceof GitObjectSnapshotterError) throw cause;
      if (cause?.code !== "ENOENT") throw cause;
    }
    await this.#assertLocalControlFile(
      path.join(canonicalGitDir, "config"),
      canonicalGitDir,
    );
    await this.#assertLocalControlFile(
      path.join(canonicalGitDir, "config.worktree"),
      canonicalGitDir,
    );
    const objectDirectory = await this.#canonicalDirectory(
      path.join(canonicalGitDir, "objects"),
      "Git object database 目录不安全",
    );
    await this.#assertSafeObjectDatabase(objectDirectory);
    return Object.freeze({
      gitDir: canonicalGitDir,
      objectDirectory,
    });
  }

  async #assertLocalControlFile(file, parent) {
    let stats;
    try {
      stats = await lstat(file);
    } catch (cause) {
      if (cause?.code === "ENOENT") return;
      throw cause;
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.nlink !== 1
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_UNTRUSTED_CONFIG",
        "Git repository 配置文件边界不安全",
      );
    }
    const canonical = await realpath(file);
    if (!isDescendantPath(parent, canonical) || !samePath(canonical, file)) {
      throw snapshotError(
        "GIT_SNAPSHOT_UNTRUSTED_CONFIG",
        "Git repository 配置文件边界不安全",
      );
    }
  }

  async #gitExecutableIdentity(sourceRoot) {
    if (
      isWindowsNetworkPath(this.#gitCommand) ||
      !isTrustedWindowsGitImplementation(this.#gitCommand) ||
      samePath(sourceRoot, this.#gitCommand) ||
      isDescendantPath(sourceRoot, this.#gitCommand)
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED",
        "Git executable 必须直接指向仓库外的本地 Git 实现（Windows 使用 mingw64/bin/git.exe 或 ucrt64/bin/git.exe）",
      );
    }
    const initialPathStats = await lstat(this.#gitCommand);
    if (initialPathStats.isSymbolicLink() || !initialPathStats.isFile()) {
      throw snapshotError(
        "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED",
        "Git executable 路径不安全",
      );
    }
    const canonicalCommand = await realpath(this.#gitCommand);
    if (
      !samePath(canonicalCommand, this.#gitCommand) ||
      samePath(sourceRoot, canonicalCommand) ||
      isDescendantPath(sourceRoot, canonicalCommand)
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED",
        "Git executable 身份不安全",
      );
    }

    const handle = await open(canonicalCommand, "r");
    let bytes;
    let openedStats;
    try {
      openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.size < 1 ||
        openedStats.size > MAX_GIT_EXECUTABLE_BYTES
      ) {
        throw snapshotError(
          "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED",
          "Git executable 大小或类型不安全",
        );
      }
      const executableMode = openedStats.mode & 0o7777;
      if (
        process.platform !== "win32" &&
        ((executableMode & 0o111) === 0 || (executableMode & 0o7000) !== 0)
      ) {
        throw snapshotError(
          "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED",
          "Git executable 权限不安全",
        );
      }
      bytes = await handle.readFile();
      const finalOpenedStats = await handle.stat();
      if (
        bytes.length !== openedStats.size ||
        !sameFileIdentity(openedStats, finalOpenedStats)
      ) {
        throw snapshotError(
          "GIT_SNAPSHOT_EXECUTABLE_CHANGED",
          "Git executable 在身份校验期间发生变化",
        );
      }
    } finally {
      await handle.close();
    }

    const finalPathStats = await lstat(this.#gitCommand);
    const finalCanonicalCommand = await realpath(this.#gitCommand);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      !samePath(finalCanonicalCommand, canonicalCommand) ||
      !sameFileIdentity(initialPathStats, finalPathStats) ||
      !sameFileIdentity(openedStats, finalPathStats)
    ) {
      throw snapshotError(
        "GIT_SNAPSHOT_EXECUTABLE_CHANGED",
        "Git executable 在身份校验期间发生变化",
      );
    }
    return Object.freeze({
      gitCommand: canonicalCommand,
      gitExecutableSha256: sha256(bytes),
      gitExecutableBytes: bytes.length,
      gitExecutableMode: openedStats.mode & 0o7777,
      gitExecutableUid: openedStats.uid,
      gitExecutableGid: openedStats.gid,
    });
  }

  async #hasPromisorPack(objectDirectory) {
    try {
      const entries = await readdir(path.join(objectDirectory, "pack"));
      return entries.some((entry) => entry.toLowerCase().endsWith(".promisor"));
    } catch (cause) {
      if (cause?.code === "ENOENT") return false;
      throw cause;
    }
  }

  async #createParentDirectories(
    targetRoot,
    relativePath,
    createdDirectories,
  ) {
    let current = targetRoot;
    for (const segment of relativePath.split("/").slice(0, -1)) {
      current = path.join(current, segment);
      if (createdDirectories.has(current)) continue;
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (cause) {
        if (cause?.code === "EEXIST") {
          throw snapshotError(
            "GIT_SNAPSHOT_TARGET_CHANGED",
            "Git snapshot 目标目录在写入期间发生变化",
            cause,
          );
        }
        throw cause;
      }
      createdDirectories.add(current);
    }
  }

  async #assertSafeObjectDatabase(objectDirectory) {
    for (const name of ["alternates", "http-alternates"]) {
      try {
        await lstat(path.join(objectDirectory, "info", name));
        throw snapshotError(
          "GIT_SNAPSHOT_ALTERNATE_OBJECT_STORE",
          "Git alternate object store 不允许执行固定 Head 快照",
        );
      } catch (cause) {
        if (cause instanceof GitObjectSnapshotterError) throw cause;
        if (cause?.code !== "ENOENT") throw cause;
      }
    }
    const entries = await readdir(objectDirectory, { withFileTypes: true });
    let looseObjectCount = 0;
    for (const entry of entries) {
      const target = path.join(objectDirectory, entry.name);
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        throw snapshotError(
          "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE",
          "Git object database 包含边界外链接",
        );
      }
      if (stats.isDirectory()) {
        const canonical = await realpath(target);
        if (!samePath(canonical, target)) {
          throw snapshotError(
            "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE",
            "Git object database 包含边界外目录",
          );
        }
        if (/^[a-f0-9]{2}$/u.test(entry.name)) {
          const looseEntries = await readdir(target, { withFileTypes: true });
          looseObjectCount += looseEntries.length;
          if (looseObjectCount > MAX_LOOSE_OBJECT_ENTRIES) {
            throw snapshotError(
              "GIT_SNAPSHOT_OBJECT_STORE_LIMIT",
              "Git loose object database 条目超过安全检查上限",
            );
          }
          for (const looseEntry of looseEntries) {
            const looseStats = await lstat(path.join(target, looseEntry.name));
            if (
              looseStats.isSymbolicLink() ||
              !looseStats.isFile() ||
              looseStats.nlink !== 1
            ) {
              throw snapshotError(
                "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE",
                "Git loose object database 包含不安全条目",
              );
            }
          }
        }
      } else if (!stats.isFile()) {
        throw snapshotError(
          "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE",
          "Git object database 包含不支持的条目",
        );
      }
    }
    const packDirectory = path.join(objectDirectory, "pack");
    try {
      const packEntries = await readdir(packDirectory, { withFileTypes: true });
      if (packEntries.length > MAX_PACK_DATABASE_ENTRIES) {
        throw snapshotError(
          "GIT_SNAPSHOT_OBJECT_STORE_LIMIT",
          "Git pack object database 条目超过安全检查上限",
        );
      }
      for (const entry of packEntries) {
        const stats = await lstat(path.join(packDirectory, entry.name));
        if (
          stats.isSymbolicLink() ||
          !stats.isFile() ||
          stats.nlink !== 1
        ) {
          throw snapshotError(
            "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE",
            "Git pack object database 包含不安全条目",
          );
        }
      }
    } catch (cause) {
      if (cause instanceof GitObjectSnapshotterError) throw cause;
      if (cause?.code !== "ENOENT") throw cause;
    }
  }

  async #cleanupCreatedOutput(
    targetRoot,
    createdFiles,
    createdDirectories,
  ) {
    await this.#assertRoot(targetRoot, { empty: false, source: false });
    let incomplete = false;
    for (const file of [...createdFiles].sort().reverse()) {
      try {
        await unlink(file);
      } catch {
        incomplete = true;
      }
    }
    const directories = [...createdDirectories].sort((left, right) => {
      const depthDifference = right.split(path.sep).length - left.split(path.sep).length;
      return depthDifference || right.localeCompare(left);
    });
    for (const directory of directories) {
      try {
        await rmdir(directory);
      } catch {
        incomplete = true;
      }
    }
    if (incomplete || (await readdir(targetRoot)).length !== 0) {
      throw new Error("Git snapshot target cleanup was incomplete");
    }
  }

  async #canonicalDirectory(value, message) {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      isWindowsNetworkPath(value)
    ) {
      throw snapshotError("GIT_SNAPSHOT_ROOT_MISMATCH", message);
    }
    const resolved = path.resolve(value);
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw snapshotError("GIT_SNAPSHOT_ROOT_MISMATCH", message);
    }
    const canonical = await realpath(resolved);
    if (!samePath(canonical, resolved)) {
      throw snapshotError("GIT_SNAPSHOT_ROOT_MISMATCH", message);
    }
    return canonical;
  }

  async #assertRoot(root, { empty, source }) {
    if (isWindowsNetworkPath(root)) {
      throw snapshotError(
        source ? "GIT_SNAPSHOT_ROOT_MISMATCH" : "GIT_SNAPSHOT_TARGET_UNAVAILABLE",
        source ? "Git repository 根目录必须位于本地文件系统" : "Git snapshot 目标目录必须位于本地文件系统",
      );
    }
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw snapshotError(
        source ? "GIT_SNAPSHOT_ROOT_MISMATCH" : "GIT_SNAPSHOT_TARGET_UNAVAILABLE",
        source ? "Git repository 根目录不安全" : "Git snapshot 目标目录不安全",
      );
    }
    const canonical = await realpath(root);
    if (!samePath(canonical, root)) {
      throw snapshotError(
        source ? "GIT_SNAPSHOT_ROOT_MISMATCH" : "GIT_SNAPSHOT_TARGET_UNAVAILABLE",
        source ? "Git repository 根目录身份不一致" : "Git snapshot 目标目录身份不一致",
      );
    }
    if (empty && (await readdir(root)).length !== 0) {
      throw snapshotError(
        "GIT_SNAPSHOT_TARGET_UNAVAILABLE",
        "Git snapshot 目标目录必须为空",
      );
    }
  }

  async #gitText(args, cwd) {
    return decodeSingleLine(
      await this.#gitBytes(args, cwd, undefined, this.#limits.maxTreeBytes),
      "GIT_SNAPSHOT_PROTOCOL_ERROR",
      "Git object snapshot 输出无效",
    );
  }

  async #gitOptionalText(args, cwd) {
    return this.#executeGit(args, cwd, undefined, this.#limits.maxTreeBytes, result => {
      if (
        result === null ||
        typeof result !== "object" ||
        !Number.isSafeInteger(result.exitCode) ||
        result.signal !== null ||
        result.truncated !== false ||
        !Buffer.isBuffer(result.stdout) ||
        !Buffer.isBuffer(result.stderr)
      ) {
        throw snapshotError(
          "GIT_SNAPSHOT_PROCESS_FAILED",
          "Git object snapshot 命令失败",
        );
      }
      if (result.exitCode !== 0) return null;
      return decodeSingleLine(
        result.stdout,
        "GIT_SNAPSHOT_PROTOCOL_ERROR",
        "Git object snapshot 输出无效",
      );
    });
  }

  async #gitOptionalBytes(args, cwd, maxOutputBytes) {
    return this.#executeGit(args, cwd, undefined, maxOutputBytes, result => optionalOutput(
      result,
      "GIT_SNAPSHOT_PROCESS_FAILED",
      "Git object snapshot 配置检查失败",
    ));
  }

  async #gitBytes(args, cwd, input, maxOutputBytes, batch = {}) {
    return this.#executeGit(args, cwd, input, maxOutputBytes, result => successfulOutput(
      result,
      "GIT_SNAPSHOT_PROCESS_FAILED",
      "Git object snapshot 命令失败",
    ), batch);
  }

  async #executeGit(args, cwd, input, maxOutputBytes, consume, batch = {}) {
    const startedAt = performance.now();
    let result;
    try {
      throwIfPreparationAborted();
      result = await this.#run({
        command: this.#gitCommand,
        args: [...SAFE_GIT_PREFIX, ...args],
        cwd,
        env: SAFE_ENV,
        ...(input === undefined ? {} : { input }),
        timeoutMs: this.#timeoutMs,
        maxOutputBytes,
      });
      return consume(result);
    } catch (cause) {
      const observed = processFailureObservations.get(cause) ?? processFailureObservations.get(result);
      if (cause !== null && (typeof cause === "object" || typeof cause === "function")) snapshotFailureDiagnostics.set(cause, {
        ...commandDiagnostic(args), ...batch,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), budgetMs: this.#timeoutMs,
        stdoutBytes: observed?.stdoutBytes ?? (Buffer.isBuffer(result?.stdout) ? result.stdout.length : "unknown"),
        stderrBytes: observed?.stderrBytes ?? (Buffer.isBuffer(result?.stderr) ? result.stderr.length : "unknown"),
        process: observed?.process ?? "unknown",
      });
      throw cause;
    }
  }
}
