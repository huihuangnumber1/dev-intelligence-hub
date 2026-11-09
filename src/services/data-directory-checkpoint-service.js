import { createHash } from "node:crypto";
import {
  lstat,
  open,
  opendir,
  realpath,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { isCanonicalBackupPath } from "../domain/backup-path.js";

const MAX_FILES = 100_000;
const MAX_DIRECTORIES = 100_000;
const MAX_DEPTH = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const SAFE_STORE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const EXCLUDED_ROOT_FILES = new Set(["mydashboard-server-process.json"]);
const EXCLUDED_ROOT_DIRECTORIES = new Set([
  "playwright-browsers",
  "validation-profile-probe",
]);
const OPTION_KEYS = new Set(["sourceDirectory", "gate"]);
const MINIMUM_CRITICAL_FREE_BYTES = 10 * 1024 ** 3;

export function dataVolumeCapacitySeverity(usedPercent, availableBytes) {
  if (usedPercent >= 95 && availableBytes < MINIMUM_CRITICAL_FREE_BYTES) return "critical";
  return usedPercent >= 80 ? "warning" : null;
}

export class DataDirectoryCheckpointError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DataDirectoryCheckpointError";
    this.code = code;
    this.statusCode = 503;
  }
}

function failure(code, message, cause) {
  return new DataDirectoryCheckpointError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function plainOptions(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("checkpoint options must be a plain record");
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !OPTION_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("checkpoint options must be a plain record");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function method(value, name) {
  let current = value;
  while (current !== null && !utilTypes.isProxy(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "function" &&
          !utilTypes.isProxy(descriptor.value)
        ? descriptor.value.bind(value)
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function gatePort(value) {
  if (!value || utilTypes.isProxy(value)) throw new TypeError("gate is invalid");
  const enter = method(value, "enter");
  const leave = method(value, "leave");
  const readStatus = method(value, "readStatus");
  if (!enter || !leave || !readStatus) throw new TypeError("gate is invalid");
  return Object.freeze({ enter, leave, readStatus });
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameIdentity(left, right) {
  return left.isFile() && right.isFile() &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.nlink === right.nlink &&
    (left.dev === 0 || right.dev === 0 || left.dev === right.dev) &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function relativePath(parent, name) {
  return parent === "" ? name : `${parent}/${name}`;
}

function validateRelative(value, directory) {
  if (!isCanonicalBackupPath(value, { directory })) {
    throw failure("CHECKPOINT_PATH_INVALID", "数据目录包含不可备份路径");
  }
  return value;
}

async function verifiedRoot(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not directory");
    const resolved = await realpath(directory);
    if (comparable(resolved) !== comparable(directory)) throw new Error("aliased root");
    return resolved;
  } catch (cause) {
    throw failure("CHECKPOINT_ROOT_INVALID", "数据目录不可用或包含路径别名", cause);
  }
}

async function readFileFact(root, relative, { collectContent }) {
  const target = path.resolve(root, ...relative.split("/"));
  if (!isWithin(root, target)) {
    throw failure("CHECKPOINT_PATH_INVALID", "数据文件越出数据目录");
  }
  let handle;
  try {
    const canonical = await realpath(target);
    if (comparable(canonical) !== comparable(target)) {
      throw failure("CHECKPOINT_PATH_INVALID", "数据文件包含路径别名");
    }
    handle = await open(target, "r");
    const before = await handle.stat();
    const namedBefore = await lstat(target);
    if (
      !sameIdentity(before, namedBefore) ||
      before.nlink !== 1 ||
      before.size > MAX_FILE_BYTES ||
      (collectContent && before.size > MAX_STORE_BYTES)
    ) {
      throw failure("CHECKPOINT_FILE_INVALID", "数据文件身份或容量无效");
    }
    const digest = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      digest.update(chunk);
      if (collectContent) chunks.push(Buffer.from(chunk));
      bytes += read.bytesRead;
      if (bytes > before.size) {
        throw failure("CHECKPOINT_SOURCE_CHANGED", "checkpoint 期间数据文件增长");
      }
    }
    const after = await handle.stat();
    const namedAfter = await lstat(target);
    if (
      bytes !== before.size ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, namedAfter) ||
      !sameIdentity(namedBefore, namedAfter)
    ) {
      throw failure("CHECKPOINT_SOURCE_CHANGED", "checkpoint 期间数据文件变化");
    }
    return {
      bytes,
      sha256: digest.digest("hex"),
      content: collectContent ? Buffer.concat(chunks, bytes) : null,
    };
  } catch (error) {
    if (error instanceof DataDirectoryCheckpointError) throw error;
    throw failure("CHECKPOINT_FILE_INVALID", "数据文件无法安全读取", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function storeRevision(content) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch (cause) {
    throw failure("CHECKPOINT_STORE_INVALID", "状态 store 不是有效 UTF-8 JSON", cause);
  }
  if (value === null || typeof value !== "object") {
    throw failure("CHECKPOINT_STORE_INVALID", "状态 store 根结构无效");
  }
  const candidates = [value.revision, value.queueRevision];
  const revision = candidates.find((candidate) =>
    Number.isSafeInteger(candidate) && candidate >= 0,
  );
  return revision ?? 0;
}

function fileKind(relative) {
  return !relative.includes("/") && relative.endsWith(".json") ||
      relative.startsWith("code-executor/workspaces/")
    ? "mutable"
    : "immutable";
}

async function scanMetadata(directory) {
  const root = await verifiedRoot(directory);
  const pending = [{ relative: "", depth: 0 }];
  const files = [];
  let directoryCount = 0;
  let totalBytes = 0;
  const capacityFailure = (message, fileCount = files.length) => {
    const error = failure("CHECKPOINT_CAPACITY_EXCEEDED", message);
    error.counts = Object.freeze({ fileCount, directoryCount, totalBytes });
    return error;
  };
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_DEPTH || ++directoryCount > MAX_DIRECTORIES) {
      throw capacityFailure("数据目录深度或目录数超出限制");
    }
    const currentPath = current.relative
      ? path.resolve(root, ...current.relative.split("/"))
      : root;
    const info = await lstat(currentPath);
    const canonical = await realpath(currentPath);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      comparable(canonical) !== comparable(currentPath) ||
      (current.relative !== "" && !isWithin(root, canonical))
    ) {
      throw failure("CHECKPOINT_PATH_INVALID", "数据目录包含路径别名");
    }
    const entries = [];
    const opened = await opendir(currentPath);
    for await (const entry of opened) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (current.relative === "" && EXCLUDED_ROOT_FILES.has(entry.name)) {
        continue;
      }
      if (
        current.relative === "" &&
        EXCLUDED_ROOT_DIRECTORIES.has(entry.name)
      ) {
        const excludedPath = path.resolve(root, entry.name);
        const excludedInfo = await lstat(excludedPath);
        const excludedCanonical = await realpath(excludedPath);
        if (
          entry.isSymbolicLink() ||
          excludedInfo.isSymbolicLink() ||
          !entry.isDirectory() ||
          !excludedInfo.isDirectory() ||
          !isWithin(root, excludedCanonical) ||
          comparable(excludedCanonical) !== comparable(excludedPath)
        ) {
          throw failure(
            "CHECKPOINT_PATH_INVALID",
            "可重建验证缓存路径身份无效",
          );
        }
        continue;
      }
      const relative = validateRelative(
        relativePath(current.relative, entry.name), entry.isDirectory(),
      );
      const target = path.resolve(root, ...relative.split("/"));
      const targetInfo = await lstat(target);
      if (entry.isSymbolicLink() || targetInfo.isSymbolicLink()) {
        throw failure("CHECKPOINT_PATH_INVALID", "数据目录包含符号链接");
      }
      if (entry.isDirectory() && targetInfo.isDirectory()) {
        pending.push({ relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !targetInfo.isFile()) {
        throw failure("CHECKPOINT_FILE_INVALID", "数据目录包含不支持的文件类型");
      }
      if (files.length >= MAX_FILES) {
        throw capacityFailure("数据文件数量超出限制", files.length + 1);
      }
      const isStore = !relative.includes("/") && relative.endsWith(".json");
      if (targetInfo.nlink !== 1 || targetInfo.size > MAX_FILE_BYTES ||
          (isStore && targetInfo.size > MAX_STORE_BYTES)) {
        throw failure("CHECKPOINT_FILE_INVALID", "数据文件身份或容量无效");
      }
      totalBytes += targetInfo.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        throw capacityFailure("数据文件总量超出限制", files.length + 1);
      }
      files.push(Object.freeze({
        path: relative,
        kind: fileKind(relative),
        bytes: targetInfo.size,
      }));
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { root, files };
}

async function inventory(directory) {
  const metadata = await scanMetadata(directory);
  const files = [];
  const stores = [];
  let totalBytes = 0;
  for (const file of metadata.files) {
    const isStore = !file.path.includes("/") && file.path.endsWith(".json");
    const fact = await readFileFact(metadata.root, file.path, { collectContent: isStore });
    totalBytes += fact.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      throw failure("CHECKPOINT_CAPACITY_EXCEEDED", "数据文件总量超出限制");
    }
    files.push(Object.freeze({ ...file, bytes: fact.bytes, sha256: fact.sha256 }));
    if (isStore) {
      const name = file.path.slice(0, -".json".length);
      if (!SAFE_STORE.test(name)) {
        throw failure("CHECKPOINT_STORE_INVALID", "状态 store 名称无效");
      }
      stores.push(Object.freeze({
        name, revision: storeRevision(fact.content), digest: fact.sha256,
      }));
    }
  }
  stores.sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (files.length === 0 || stores.length === 0) {
    throw failure("CHECKPOINT_EMPTY", "数据目录没有可恢复的 store 与文件");
  }
  return Object.freeze({
    stores: Object.freeze(stores),
    files: Object.freeze(files),
  });
}

function sameFacts(left, right, identity) {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const expected = new Map(left.map((entry) => [identity(entry), entry]));
  return right.every((entry) => {
    const match = expected.get(identity(entry));
    return match !== undefined && JSON.stringify(match) === JSON.stringify(entry);
  });
}

export class DataDirectoryCheckpointService {
  #sourceDirectory;
  #gate;
  #activeCheckpoint = null;

  constructor(options = {}) {
    const entries = plainOptions(options);
    const sourceDirectory = entries.get("sourceDirectory");
    if (typeof sourceDirectory !== "string" || !path.isAbsolute(sourceDirectory)) {
      throw new TypeError("sourceDirectory must be absolute");
    }
    this.#sourceDirectory = path.resolve(sourceDirectory);
    this.#gate = gatePort(entries.get("gate"));
    Object.freeze(this);
  }

  async enter() {
    // Preflight is only an early rejection. Writers remain admitted here; the
    // complete inventory is rebuilt after drain and never trusts these facts.
    try {
      await scanMetadata(this.#sourceDirectory);
    } catch (error) {
      if (error instanceof DataDirectoryCheckpointError) error.stage = "metadata_preflight";
      throw error;
    }
    const token = await this.#gate.enter();
    try {
      const checkpoint = await inventory(this.#sourceDirectory);
      this.#activeCheckpoint = Object.freeze({ token, ...checkpoint });
      return Object.freeze({ token, ...checkpoint });
    } catch (error) {
      this.#gate.leave(token);
      if (error instanceof DataDirectoryCheckpointError) error.stage = "checkpoint_inventory";
      throw error;
    }
  }

  async leave(token) {
    const active = this.#activeCheckpoint;
    if (active === null || token !== active.token) {
      return this.#gate.leave(token);
    }
    let integrityFailure = null;
    try {
      const observed = await inventory(this.#sourceDirectory);
      if (
        !sameFacts(active.files, observed.files, ({ path: filePath }) => filePath) ||
        !sameFacts(active.stores, observed.stores, ({ name }) => name)
      ) {
        integrityFailure = failure(
          "CHECKPOINT_SOURCE_CHANGED",
          "checkpoint 期间数据目录发生变化",
        );
      }
    } catch (error) {
      integrityFailure = error instanceof DataDirectoryCheckpointError
        ? error
        : failure(
            "CHECKPOINT_SOURCE_CHANGED",
            "checkpoint 期间无法复核数据目录",
            error,
          );
    }
    this.#gate.leave(token);
    this.#activeCheckpoint = null;
    if (integrityFailure !== null) {
      integrityFailure.stage = "checkpoint_release";
      throw integrityFailure;
    }
    return this.#gate.readStatus();
  }

  async capture({ directory } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new TypeError("checkpoint capture directory must be absolute");
    }
    return inventory(path.resolve(directory));
  }

  async reconcile({ directory, manifest, mode } = {}) {
    if (mode !== "read-only" || typeof directory !== "string" ||
        !path.isAbsolute(directory) || !manifest?.checkpoint || !manifest?.files) {
      return Object.freeze({ ready: false, blockers: ["RECONCILIATION_INPUT_INVALID"] });
    }
    try {
      const observed = await inventory(path.resolve(directory));
      const fileMatch = sameFacts(
        observed.files,
        manifest.files,
        ({ path: filePath }) => filePath,
      );
      const storeMatch = sameFacts(
        observed.stores,
        manifest.checkpoint.stores,
        ({ name }) => name,
      );
      const blockers = [
        ...(fileMatch ? [] : ["CHECKPOINT_FILE_MISMATCH"]),
        ...(storeMatch ? [] : ["CHECKPOINT_STORE_MISMATCH"]),
      ];
      return Object.freeze({ ready: blockers.length === 0, blockers });
    } catch {
      return Object.freeze({ ready: false, blockers: ["RECONCILIATION_SCAN_FAILED"] });
    }
  }

  async capacity() {
    try {
      const stats = await statfs(this.#sourceDirectory);
      const total = Number(stats.blocks) * Number(stats.bsize);
      const available = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) {
        throw new TypeError("statfs result is invalid");
      }
      const usedPercent = Math.round((1 - available / total) * 1_000) / 10;
      const severity = dataVolumeCapacitySeverity(usedPercent, available);
      return Object.freeze({
        warnings: severity === null
          ? Object.freeze([])
          : Object.freeze([Object.freeze({
              resource: "data_volume",
              severity,
              usedPercent,
            })]),
      });
    } catch {
      throw failure("CAPACITY_PROBE_FAILED", "数据卷容量无法读取");
    }
  }

  recovery() {
    const status = this.#gate.readStatus();
    return Object.freeze({
      blockerCodes: status.mode === "open"
        ? Object.freeze([])
        : Object.freeze(["MAINTENANCE_ACTIVE"]),
    });
  }
}
