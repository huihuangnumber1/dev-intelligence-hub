import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { isCanonicalBackupPath } from "./backup-path.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_STORE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const FILE_KINDS = new Set(["mutable", "immutable"]);
const MAX_FILES = 100_000;
// Root StateStore archives each occupy a durable file. They share the existing
// file-count ceiling and the combined 16 MiB manifest budget.
const MAX_STORES = MAX_FILES;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export class BackupManifestError extends Error {
  constructor(message = "备份清单无效") {
    super(message);
    this.name = "BackupManifestError";
    this.code = "INVALID_BACKUP_MANIFEST";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new BackupManifestError(message);
}

function plainData(value, expected, message = "备份清单结构无效") {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(message);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    invalid(message);
  }
  const result = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(message);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function plainArray(value, maximum, message) {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    invalid(message);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid(message);
    result.push(descriptor.value);
  }
  return result;
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid("备份时间无效");
  }
  return value;
}

function sha256(value, name = "digest") {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${name} 无效`);
  return value;
}

function safeInteger(value, maximum, name) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > maximum
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function canonicalPath(value) {
  if (!isCanonicalBackupPath(value)) invalid("备份文件路径无效");
  return value;
}

function storeFact(value) {
  const entries = plainData(
    value,
    ["name", "revision", "digest"],
    "备份 checkpoint store 无效",
  );
  const name = entries.get("name");
  if (typeof name !== "string" || !SAFE_STORE.test(name)) {
    invalid("备份 store 名称无效");
  }
  return {
    name,
    revision: safeInteger(
      entries.get("revision"),
      Number.MAX_SAFE_INTEGER,
      "store revision",
    ),
    digest: sha256(entries.get("digest"), "store digest"),
  };
}

function fileFact(value) {
  const entries = plainData(
    value,
    ["path", "kind", "bytes", "sha256"],
    "备份文件记录无效",
  );
  const kind = entries.get("kind");
  if (!FILE_KINDS.has(kind)) invalid("备份文件类型无效");
  return {
    path: canonicalPath(entries.get("path")),
    kind,
    bytes: safeInteger(entries.get("bytes"), MAX_FILE_BYTES, "文件大小"),
    sha256: sha256(entries.get("sha256"), "文件摘要"),
  };
}

function uniqueSorted(values, identity, message) {
  const result = [...values].sort((left, right) => {
    const leftIdentity = identity(left);
    const rightIdentity = identity(right);
    if (leftIdentity < rightIdentity) return -1;
    if (leftIdentity > rightIdentity) return 1;
    return 0;
  });
  const identities = new Set();
  for (const value of result) {
    const key = identity(value).normalize("NFC").toLowerCase();
    if (identities.has(key)) invalid(message);
    identities.add(key);
  }
  return result;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function boundedRecords(values, mapper, budget) {
  const result = [];
  for (const value of values) {
    const record = mapper(value);
    budget.bytes += Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (budget.bytes > MAX_MANIFEST_BYTES) {
      invalid("备份清单超出容量限制");
    }
    result.push(record);
  }
  return result;
}

function frozenManifest(value) {
  for (const store of value.checkpoint.stores) Object.freeze(store);
  for (const file of value.files) Object.freeze(file);
  Object.freeze(value.checkpoint.stores);
  Object.freeze(value.checkpoint);
  Object.freeze(value.files);
  Object.freeze(value.totals);
  return Object.freeze(value);
}

function build({ createdAt, stores, files }) {
  const budget = { bytes: 0 };
  const normalizedStores = uniqueSorted(
    boundedRecords(
      plainArray(stores, MAX_STORES, "备份 store 数量无效"),
      storeFact,
      budget,
    ),
    ({ name }) => name,
    "备份 store 名称重复",
  );
  const normalizedFiles = uniqueSorted(
    boundedRecords(
      plainArray(files, MAX_FILES, "备份文件数量无效"),
      fileFact,
      budget,
    ),
    ({ path }) => path,
    "备份文件路径重复",
  );
  if (normalizedStores.length === 0 || normalizedFiles.length === 0) {
    invalid("备份 checkpoint 和文件不能为空");
  }
  const totalBytes = normalizedFiles.reduce((total, file) => {
    const next = total + file.bytes;
    if (!Number.isSafeInteger(next) || next > MAX_TOTAL_BYTES) {
      invalid("备份总大小超出限制");
    }
    return next;
  }, 0);
  const checkpointContent = { schemaVersion: 1, stores: normalizedStores };
  const checkpoint = {
    ...checkpointContent,
    checkpointId: `backup-checkpoint-${hash(checkpointContent)}`,
  };
  const content = {
    schemaVersion: 1,
    createdAt: timestamp(createdAt),
    checkpoint,
    files: normalizedFiles,
    totals: { fileCount: normalizedFiles.length, totalBytes },
  };
  const contentDigest = hash(content);
  const identity = {
    schemaVersion: content.schemaVersion,
    checkpoint: content.checkpoint,
    files: content.files,
    totals: content.totals,
  };
  const manifest = {
    ...content,
    contentDigest,
    backupId: `backup-${hash(identity)}`,
  };
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_MANIFEST_BYTES) {
    invalid("备份清单超出容量限制");
  }
  return frozenManifest(manifest);
}

export function createBackupManifest(value) {
  const entries = plainData(
    value,
    ["createdAt", "stores", "files"],
    "备份清单创建请求无效",
  );
  return build({
    createdAt: entries.get("createdAt"),
    stores: entries.get("stores"),
    files: entries.get("files"),
  });
}

export function normalizeBackupManifest(value) {
  const entries = plainData(value, [
    "schemaVersion",
    "createdAt",
    "checkpoint",
    "files",
    "totals",
    "contentDigest",
    "backupId",
  ]);
  if (entries.get("schemaVersion") !== 1) invalid("备份清单版本无效");
  const checkpoint = plainData(entries.get("checkpoint"), [
    "schemaVersion",
    "stores",
    "checkpointId",
  ]);
  if (checkpoint.get("schemaVersion") !== 1) invalid("备份 checkpoint 版本无效");
  const totals = plainData(entries.get("totals"), ["fileCount", "totalBytes"]);
  const suppliedStores = plainArray(
    checkpoint.get("stores"),
    MAX_STORES,
    "备份 store 数量无效",
  ).map(storeFact);
  const suppliedFiles = plainArray(
    entries.get("files"),
    MAX_FILES,
    "备份文件数量无效",
  ).map(fileFact);
  const rebuilt = build({
    createdAt: entries.get("createdAt"),
    stores: suppliedStores,
    files: suppliedFiles,
  });
  if (
    JSON.stringify(suppliedStores) !== JSON.stringify(rebuilt.checkpoint.stores) ||
    JSON.stringify(suppliedFiles) !== JSON.stringify(rebuilt.files) ||
    checkpoint.get("checkpointId") !== rebuilt.checkpoint.checkpointId ||
    totals.get("fileCount") !== rebuilt.totals.fileCount ||
    totals.get("totalBytes") !== rebuilt.totals.totalBytes ||
    entries.get("contentDigest") !== rebuilt.contentDigest ||
    entries.get("backupId") !== rebuilt.backupId
  ) {
    invalid("备份清单派生字段不一致");
  }
  return rebuilt;
}
