import { createHash } from "node:crypto";

import { digestValue } from "./code-executor-contract.js";
import { normalizeWorkspacePath } from "./code-execution-policy.js";
import { executionIdentityFields, executionIdentityKeys, isExecutionIdentityProof } from "./test-runtime-identity.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const IMAGE_ID = /^[a-z0-9](?:[a-z0-9._:@/-]{0,254}[a-z0-9])?$/i;

export const CHANGE_PACKAGE_DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxProfiles: 32,
  maxBlobBytes: 1_000_000,
  maxTotalBlobBytes: 50_000_000,
  maxEvidenceBytes: 2_000_000,
  maxManifestBytes: 2_000_000,
});

export class ChangePackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChangePackageError";
    this.code = code;
  }
}

function invalid(message = "change package 无效") {
  return new ChangePackageError("INVALID_CHANGE_PACKAGE", message);
}

function limitExceeded(message = "change package 超过限制") {
  return new ChangePackageError("CHANGE_PACKAGE_LIMIT_EXCEEDED", message);
}

function exactObject(value, expectedKeys, error = invalid()) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw error;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
  }
  return value;
}

function denseArray(value, maximum, error = invalid()) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw error;
  }
  if (value.length > maximum) throw limitExceeded();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function sha256Text(value, name) {
  return boundedText(value, name, 64, SHA256);
}

function safeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeChangePackageId(value) {
  return boundedText(value, "packageId", 128, PACKAGE_ID);
}

export function normalizeChangePackagePath(value) {
  const relativePath = boundedText(value, "path", 1_024);
  if (
    relativePath.includes("\\") ||
    relativePath.normalize("NFC") !== relativePath
  ) {
    throw invalid("change package path 无效");
  }
  try {
    const normalized = normalizeWorkspacePath(relativePath);
    if (normalized !== relativePath) throw invalid("change package path 无效");
    return normalized;
  } catch {
    throw invalid("change package path 无效");
  }
}

export function normalizeChangePackageLimits(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw invalid("change package limits 无效");
  }
  const allowed = Object.keys(CHANGE_PACKAGE_DEFAULT_LIMITS);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw invalid("change package limits 无效");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid("change package limits 无效");
    }
  }
  const limits = { ...CHANGE_PACKAGE_DEFAULT_LIMITS, ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw invalid(`${name} 无效`);
    }
  }
  return Object.freeze(limits);
}

function normalizeJob(value) {
  exactObject(value, ["id", "revision", "recordDigest"]);
  return {
    id: boundedText(value.id, "job.id", 128, SAFE_ID),
    revision: safeInteger(value.revision, "job.revision", 1),
    recordDigest: sha256Text(value.recordDigest, "job.recordDigest"),
  };
}

function normalizeProposal(value) {
  exactObject(value, ["id", "contentDigest"]);
  return {
    id: boundedText(value.id, "proposal.id", 512),
    contentDigest: sha256Text(value.contentDigest, "proposal.contentDigest"),
  };
}

function normalizeGrant(value) {
  exactObject(value, ["digest"]);
  return { digest: sha256Text(value.digest, "grant.digest") };
}

function normalizeWorkspace(value) {
  exactObject(value, ["id", "sourceRevision", "workspaceRevision"]);
  return {
    id: boundedText(value.id, "workspace.id", 128, SAFE_ID),
    sourceRevision: sha256Text(value.sourceRevision, "workspace.sourceRevision"),
    workspaceRevision: sha256Text(
      value.workspaceRevision,
      "workspace.workspaceRevision",
    ),
  };
}

function normalizeArtifact(value, name, limits) {
  exactObject(value, ["path", "sha256", "bytes"]);
  const bytes = safeInteger(value.bytes, `${name}.bytes`, 1);
  if (bytes > limits.maxEvidenceBytes) {
    throw limitExceeded("change package 测试证据超过限制");
  }
  return {
    path: normalizeChangePackagePath(value.path),
    sha256: sha256Text(value.sha256, `${name}.sha256`),
    bytes,
  };
}

function normalizePassedProfiles(value, workspaceRevision, limits) {
  const profiles = denseArray(value, limits.maxProfiles);
  if (profiles.length === 0) throw invalid("passedProfiles 不能为空");
  const normalized = profiles.map((profile) => {
    exactObject(profile, [
      "id",
      "configDigest",
      "workspaceRevision",
      "actionId",
      "attemptNumber",
      ...executionIdentityKeys(profile),
      "artifacts",
    ]);
    exactObject(profile.artifacts, ["output", "stdout", "stderr"]);
    if (!isExecutionIdentityProof(profile, IMAGE_ID) || (profile.runtimeIdentity && profile.runtimeIdentity.actionId !== profile.actionId)) {
      throw invalid("passedProfiles 执行身份无效");
    }
    const result = {
      id: boundedText(profile.id, "passedProfiles.id", 128, SAFE_ID),
      configDigest: sha256Text(profile.configDigest, "passedProfiles.configDigest"),
      workspaceRevision: sha256Text(
        profile.workspaceRevision,
        "passedProfiles.workspaceRevision",
      ),
      actionId: boundedText(profile.actionId, "passedProfiles.actionId", 128, SAFE_ID),
      attemptNumber: safeInteger(
        profile.attemptNumber,
        "passedProfiles.attemptNumber",
        1,
      ),
      ...executionIdentityFields(profile),
      artifacts: {
        output: normalizeArtifact(profile.artifacts.output, "artifacts.output", limits),
        stdout: normalizeArtifact(profile.artifacts.stdout, "artifacts.stdout", limits),
        stderr: normalizeArtifact(profile.artifacts.stderr, "artifacts.stderr", limits),
      },
    };
    if (result.workspaceRevision !== workspaceRevision) {
      throw invalid("测试证据未绑定 package workspaceRevision");
    }
    return result;
  });
  normalized.sort((left, right) => compareText(left.id, right.id));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw invalid("passedProfiles 重复");
  }
  return normalized;
}

function normalizeBlobReference(value, limits) {
  exactObject(value, ["sha256", "bytes"]);
  const bytes = safeInteger(value.bytes, "blob.bytes");
  if (bytes > limits.maxBlobBytes) {
    throw limitExceeded("change package blob 超过限制");
  }
  return {
    sha256: sha256Text(value.sha256, "blob.sha256"),
    bytes,
  };
}

function normalizeStoredChanges(value, limits) {
  exactObject(value, ["created", "modified", "deleted"]);
  const created = denseArray(value.created, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "blob"]);
    return {
      path: normalizeChangePackagePath(entry.path),
      blob: normalizeBlobReference(entry.blob, limits),
    };
  });
  const modified = denseArray(value.modified, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "beforeSha256", "blob"]);
    return {
      path: normalizeChangePackagePath(entry.path),
      beforeSha256: sha256Text(entry.beforeSha256, "modified.beforeSha256"),
      blob: normalizeBlobReference(entry.blob, limits),
    };
  });
  const deleted = denseArray(value.deleted, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "beforeSha256"]);
    return {
      path: normalizeChangePackagePath(entry.path),
      beforeSha256: sha256Text(entry.beforeSha256, "deleted.beforeSha256"),
    };
  });
  return normalizeChangeLists({ created, modified, deleted }, limits);
}

function normalizeChangeLists(changes, limits) {
  const totalFiles = changes.created.length + changes.modified.length + changes.deleted.length;
  if (totalFiles > limits.maxFiles) throw limitExceeded("change package 文件数超过限制");
  const paths = [
    ...changes.created.map(({ path }) => path),
    ...changes.modified.map(({ path }) => path),
    ...changes.deleted.map(({ path }) => path),
  ];
  const collisionKeys = paths.map((relativePath) => relativePath.toLowerCase());
  if (new Set(collisionKeys).size !== paths.length) {
    throw invalid("change package path 重复");
  }
  const byPath = (left, right) => compareText(left.path, right.path);
  return {
    created: [...changes.created].sort(byPath),
    modified: [...changes.modified].sort(byPath),
    deleted: [...changes.deleted].sort(byPath),
  };
}

function contentBuffer(value, limits) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw invalid("change package blob 内容无效");
  }
  const content = Buffer.from(value);
  if (content.length > limits.maxBlobBytes) {
    throw limitExceeded("change package blob 超过限制");
  }
  return content;
}

function contentDigest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function createDraftChanges(value, limits) {
  const blobs = new Map();
  let totalBlobBytes = 0;
  const blobFor = (contentValue) => {
    const content = contentBuffer(contentValue, limits);
    const sha256 = contentDigest(content);
    const existing = blobs.get(sha256);
    if (existing !== undefined && !existing.equals(content)) {
      throw invalid("change package blob 摘要冲突");
    }
    if (existing === undefined) {
      if (totalBlobBytes + content.length > limits.maxTotalBlobBytes) {
        throw limitExceeded("change package blob 总量超过限制");
      }
      totalBlobBytes += content.length;
      blobs.set(sha256, content);
    }
    return { sha256, bytes: content.length };
  };
  const created = denseArray(value.created, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "content"]);
    return { path: normalizeChangePackagePath(entry.path), blob: blobFor(entry.content) };
  });
  const modified = denseArray(value.modified, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "beforeSha256", "content"]);
    return {
      path: normalizeChangePackagePath(entry.path),
      beforeSha256: sha256Text(entry.beforeSha256, "modified.beforeSha256"),
      blob: blobFor(entry.content),
    };
  });
  const deleted = denseArray(value.deleted, limits.maxFiles).map((entry) => {
    exactObject(entry, ["path", "beforeSha256"]);
    return {
      path: normalizeChangePackagePath(entry.path),
      beforeSha256: sha256Text(entry.beforeSha256, "deleted.beforeSha256"),
    };
  });
  return {
    changes: normalizeChangeLists({ created, modified, deleted }, limits),
    blobs: [...blobs.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([sha256, content]) => ({ sha256, bytes: content.length, content: Buffer.from(content) })),
  };
}

function manifestContent({ job, proposal, grant, workspace, passedProfiles, changes }) {
  return {
    schemaVersion: passedProfiles.some((profile) => profile.runtimeIdentity) ? 2 : 1,
    job,
    proposal,
    grant,
    workspace,
    passedProfiles,
    changes,
  };
}

function assertManifestSize(manifest, limits) {
  if (
    Buffer.byteLength(`${JSON.stringify(manifest)}\n`, "utf8") >
    limits.maxManifestBytes
  ) {
    throw limitExceeded("change package manifest 超过限制");
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function hasChangePackageChanges(manifest) {
  return manifest.changes.created.length > 0 || manifest.changes.modified.length > 0 || manifest.changes.deleted.length > 0;
}

export function createChangePackage(value, { limits: limitsValue = {} } = {}) {
  const limits = normalizeChangePackageLimits(limitsValue);
  exactObject(value, [
    "job",
    "proposal",
    "grant",
    "workspace",
    "passedProfiles",
    "created",
    "modified",
    "deleted",
  ]);
  const job = normalizeJob(value.job);
  const proposal = normalizeProposal(value.proposal);
  const grant = normalizeGrant(value.grant);
  const workspace = normalizeWorkspace(value.workspace);
  const passedProfiles = normalizePassedProfiles(
    value.passedProfiles,
    workspace.workspaceRevision,
    limits,
  );
  const { changes, blobs } = createDraftChanges(value, limits);
  const content = manifestContent({ job, proposal, grant, workspace, passedProfiles, changes });
  const packageDigest = digestValue(content);
  const manifest = {
    ...content,
    packageId: `change-package-${packageDigest}`,
    packageDigest,
  };
  assertManifestSize(manifest, limits);
  return { manifest: deepFreeze(manifest), blobs };
}

export function normalizeChangePackageManifest(
  value,
  { limits: limitsValue = {} } = {},
) {
  const limits = normalizeChangePackageLimits(limitsValue);
  exactObject(value, [
    "schemaVersion",
    "job",
    "proposal",
    "grant",
    "workspace",
    "passedProfiles",
    "changes",
    "packageId",
    "packageDigest",
  ]);
  if (![1, 2].includes(value.schemaVersion)) throw invalid("change package schemaVersion 无效");
  const job = normalizeJob(value.job);
  const proposal = normalizeProposal(value.proposal);
  const grant = normalizeGrant(value.grant);
  const workspace = normalizeWorkspace(value.workspace);
  const passedProfiles = normalizePassedProfiles(
    value.passedProfiles,
    workspace.workspaceRevision,
    limits,
  );
  const changes = normalizeStoredChanges(value.changes, limits);
  const content = manifestContent({ job, proposal, grant, workspace, passedProfiles, changes });
  if (value.schemaVersion !== content.schemaVersion) throw invalid("change package schemaVersion 与执行身份不一致");
  const packageDigest = sha256Text(value.packageDigest, "packageDigest");
  const packageId = normalizeChangePackageId(value.packageId);
  if (
    packageDigest !== digestValue(content) ||
    packageId !== `change-package-${packageDigest}`
  ) {
    throw invalid("change package 摘要绑定无效");
  }
  const manifest = { ...content, packageId, packageDigest };
  assertManifestSize(manifest, limits);
  const blobReferences = [
    ...changes.created.map(({ blob }) => blob),
    ...changes.modified.map(({ blob }) => blob),
  ];
  const uniqueBlobs = new Map();
  for (const blob of blobReferences) {
    const existingBytes = uniqueBlobs.get(blob.sha256);
    if (existingBytes !== undefined && existingBytes !== blob.bytes) {
      throw invalid("change package blob 引用冲突");
    }
    uniqueBlobs.set(blob.sha256, blob.bytes);
  }
  const totalBlobBytes = [...uniqueBlobs.values()].reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  if (totalBlobBytes > limits.maxTotalBlobBytes) {
    throw limitExceeded("change package blob 总量超过限制");
  }
  return deepFreeze(manifest);
}
