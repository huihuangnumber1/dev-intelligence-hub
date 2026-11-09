import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  codeExecutionSourceWritablePaths,
  isHeadRepairExecutionSource,
  normalizeCodeExecutionSource,
} from "./code-execution-source.js";
import { digestValue } from "./code-executor-contract.js";
import { normalizeChangePackageManifest } from "./change-package-contract.js";
import { CodeExecutionPolicy } from "./code-execution-policy.js";
import { executionIdentityFields, executionIdentityKeys, isExecutionIdentityProof } from "./test-runtime-identity.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^controlled-git-commit-[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu;
const IMAGE_ID = /^[a-z0-9](?:[a-z0-9._:@/-]{0,254}[a-z0-9])?$/iu;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const OBJECT_FORMATS = Object.freeze({ sha1: 40, sha256: 64 });
const MAX_SAFE_DATA_DEPTH = 32;
const MAX_SAFE_DATA_NODES = 20_000;
const MAX_PROFILES = 32;

const CREATION_KEYS = Object.freeze([
  "executionSource",
  "manifest",
  "resolution",
  "commit",
  "createdAt",
]);
const MESSAGE_INPUT_KEYS = Object.freeze(["executionSource", "manifest"]);
const CREATION_RESOLUTION_KEYS = Object.freeze([
  "resolvedPaths",
  "finalTreeOid",
]);
const EVIDENCE_CORE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "executionSource",
  "executionSourceDigest",
  "package",
  "tests",
  "workspace",
  "resolution",
  "commit",
  "createdAt",
]);
const EVIDENCE_KEYS = Object.freeze([
  ...EVIDENCE_CORE_KEYS,
  "evidenceDigest",
  "evidenceId",
]);
const PACKAGE_KEYS = Object.freeze([
  "packageId",
  "packageDigest",
  "job",
  "proposal",
  "grant",
  "changeSetDigest",
]);
const TEST_KEYS = Object.freeze([
  "passedProfileCount",
  "passedProfilesDigest",
  "profiles",
]);
const TEST_PROFILE_KEYS = Object.freeze([
  "id",
  "configDigest",
  "workspaceRevision",
  "actionId",
  "attemptNumber",
  "imageId",
  "artifactsDigest",
]);
const WORKSPACE_KEYS = Object.freeze([
  "id",
  "sourceRevision",
  "workspaceRevision",
]);
const RESOLUTION_KEYS = Object.freeze([
  "preparationId",
  "resultTreeOid",
  "resolvedPaths",
  "resolvedPathsDigest",
  "finalTreeOid",
]);
const REVIEW_REPAIR_RESOLUTION_KEYS = Object.freeze([
  "resolvedPaths", "resolvedPathsDigest", "finalTreeOid",
]);
const COMMIT_KEYS = Object.freeze([
  "objectFormat",
  "oid",
  "treeOid",
  "parents",
  "author",
  "committer",
  "messageDigest",
  "objectSetDigest",
]);
const IDENTITY_KEYS = Object.freeze([
  "name",
  "email",
  "timestamp",
  "timezone",
]);

export class ControlledCommitEvidenceError extends Error {
  constructor(message = "受控 Git commit 证据无效", { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlledCommitEvidenceError";
    this.code = "INVALID_CONTROLLED_COMMIT_EVIDENCE";
  }
}

function invalid(message, cause) {
  return new ControlledCommitEvidenceError(message, { cause });
}

function guarded(operation) {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof ControlledCommitEvidenceError) throw cause;
    throw invalid(undefined, cause);
  }
}

function assertSafeDataTree(value) {
  let nodes = 0;
  const ancestors = new Set();

  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_SAFE_DATA_NODES || depth > MAX_SAFE_DATA_DEPTH) {
      throw invalid("受控 Git commit 证据数据超过安全限制");
    }
    if (current === null || typeof current === "string" ||
        typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw invalid("受控 Git commit 证据包含非 JSON 数值");
      }
      return;
    }
    if (typeof current !== "object" || utilTypes.isProxy(current)) {
      throw invalid("受控 Git commit 证据必须是静态 JSON 数据");
    }
    if (ancestors.has(current)) {
      throw invalid("受控 Git commit 证据不得循环引用");
    }
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype)
    ) {
      throw invalid("受控 Git commit 证据必须使用普通 JSON 容器");
    }
    const keys = Reflect.ownKeys(current);
    if (
      keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)) ||
      (array &&
        (keys.length !== current.length + 1 || !keys.includes("length")))
    ) {
      throw invalid("受控 Git commit 证据包含不安全字段");
    }
    ancestors.add(current);
    try {
      const values = array
        ? Array.from({ length: current.length }, (_, index) => String(index))
        : keys;
      for (const key of values) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw invalid("受控 Git commit 证据不得包含 accessor 或稀疏数组");
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0);
}

function exactObject(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} 无效`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key)) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw invalid(`${name} 字段无效`);
  }
  return new Map(actual.map((key) => [key, value[key]]));
}

function denseArray(value, maximum, name, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} 无效`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} 无效`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    UNSAFE_TEXT.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function sha256(value, name) {
  return boundedText(value, name, 64, SHA256);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function canonicalTimestamp(value, name = "createdAt") {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function gitOid(value, length, name) {
  if (
    typeof value !== "string" ||
    !GIT_OID.test(value) ||
    value.length !== length
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function rawSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameUniqueValues(left, right) {
  if (left.length !== right.length) return false;
  const leftValues = new Set(left);
  return leftValues.size === left.length &&
    right.every((value) => leftValues.has(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSource(value) {
  try {
    return normalizeCodeExecutionSource(value, invalid("executionSource 无效"));
  } catch (cause) {
    if (cause instanceof ControlledCommitEvidenceError) throw cause;
    throw invalid("executionSource 无效", cause);
  }
}

function normalizeManifest(value) {
  try {
    return normalizeChangePackageManifest(value);
  } catch (cause) {
    throw invalid("manifest 无效", cause);
  }
}

function assertManifestResolvesCompleteSource(manifest, executionSource) {
  const expectedPaths = codeExecutionSourceWritablePaths(executionSource);
  if (isHeadRepairExecutionSource(executionSource)) {
    const policy = new CodeExecutionPolicy({ writablePaths: expectedPaths });
    const changed = [...manifest.changes.created, ...manifest.changes.modified,
      ...manifest.changes.deleted].map(({ path }) => policy.assertWritable(path));
    if (changed.length === 0 || new Set(changed).size !== changed.length ||
        manifest.workspace.sourceRevision === manifest.workspace.workspaceRevision ||
        manifest.changes.modified.some(({ beforeSha256, blob }) => beforeSha256 === blob.sha256)) {
      throw invalid("Review repair manifest 必须包含写范围内的真实变更");
    }
    return changed.sort(compareText);
  }
  const modifiedPaths = manifest.changes.modified.map(({ path }) => path);
  if (
    manifest.workspace.sourceRevision === manifest.workspace.workspaceRevision ||
    manifest.changes.created.length !== 0 ||
    manifest.changes.deleted.length !== 0 ||
    !sameUniqueValues(modifiedPaths, expectedPaths) ||
    manifest.changes.modified.some(
      ({ beforeSha256, blob }) => beforeSha256 === blob.sha256,
    )
  ) {
    throw invalid("manifest 未完整解析 executionSource 的精确冲突范围");
  }
  return expectedPaths;
}

function packageProjection(manifest) {
  return {
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    job: { ...manifest.job },
    proposal: { ...manifest.proposal },
    grant: { ...manifest.grant },
    changeSetDigest: digestValue(manifest.changes),
  };
}

function profileProjection(profile) {
  return {
    id: profile.id,
    configDigest: profile.configDigest,
    workspaceRevision: profile.workspaceRevision,
    actionId: profile.actionId,
    attemptNumber: profile.attemptNumber,
    ...executionIdentityFields(profile),
    artifactsDigest: digestValue(profile.artifacts),
  };
}

function testProjection(manifest) {
  const profiles = manifest.passedProfiles.map(profileProjection);
  return {
    passedProfileCount: profiles.length,
    passedProfilesDigest: digestValue(profiles),
    profiles,
  };
}

function messageFromBindings({
  sourceKind = "conflict_preparation",
  executionSourceDigest,
  packageDigest,
  passedProfilesDigest,
  workspaceRevision,
}) {
  return [
    sourceKind === "ci_repair" ? "MyDashboard controlled CI repair" : sourceKind === "review_repair"
      ? "MyDashboard controlled review repair"
      : "MyDashboard controlled conflict resolution",
    "",
    `Execution-Source-Digest: ${executionSourceDigest}`,
    `Change-Package-Digest: ${packageDigest}`,
    `Test-Evidence-Digest: ${passedProfilesDigest}`,
    `Workspace-Revision: ${workspaceRevision}`,
    "",
  ].join("\n");
}

function creationBindings(executionSourceValue, manifestValue) {
  const executionSource = normalizeSource(executionSourceValue);
  const manifest = normalizeManifest(manifestValue);
  const resolvedPaths = assertManifestResolvesCompleteSource(
    manifest,
    executionSource,
  );
  const executionSourceDigest = digestValue(executionSource);
  const packageEvidence = packageProjection(manifest);
  const tests = testProjection(manifest);
  const workspace = { ...manifest.workspace };
  return {
    executionSource,
    executionSourceDigest,
    packageEvidence,
    tests,
    workspace,
    resolvedPaths,
    message: messageFromBindings({
      sourceKind: executionSource.kind,
      executionSourceDigest,
      packageDigest: packageEvidence.packageDigest,
      passedProfilesDigest: tests.passedProfilesDigest,
      workspaceRevision: workspace.workspaceRevision,
    }),
  };
}

function normalizeJob(value) {
  const fields = exactObject(value, ["id", "revision", "recordDigest"], "package.job");
  return {
    id: boundedText(fields.get("id"), "package.job.id", 128, SAFE_ID),
    revision: positiveInteger(fields.get("revision"), "package.job.revision"),
    recordDigest: sha256(fields.get("recordDigest"), "package.job.recordDigest"),
  };
}

function normalizeProposal(value) {
  const fields = exactObject(value, ["id", "contentDigest"], "package.proposal");
  return {
    id: boundedText(fields.get("id"), "package.proposal.id", 512),
    contentDigest: sha256(
      fields.get("contentDigest"),
      "package.proposal.contentDigest",
    ),
  };
}

function normalizeGrant(value) {
  const fields = exactObject(value, ["digest"], "package.grant");
  return { digest: sha256(fields.get("digest"), "package.grant.digest") };
}

function normalizePackage(value) {
  const fields = exactObject(value, PACKAGE_KEYS, "package");
  const packageDigest = sha256(fields.get("packageDigest"), "package.packageDigest");
  const packageId = boundedText(
    fields.get("packageId"),
    "package.packageId",
    79,
    PACKAGE_ID,
  );
  if (packageId !== `change-package-${packageDigest}`) {
    throw invalid("packageId 与 packageDigest 不一致");
  }
  return {
    packageId,
    packageDigest,
    job: normalizeJob(fields.get("job")),
    proposal: normalizeProposal(fields.get("proposal")),
    grant: normalizeGrant(fields.get("grant")),
    changeSetDigest: sha256(
      fields.get("changeSetDigest"),
      "package.changeSetDigest",
    ),
  };
}

function normalizeProfile(value, workspaceRevision) {
  const fields = exactObject(value, [...TEST_PROFILE_KEYS.filter((key) => key !== "imageId"), ...executionIdentityKeys(value)], "tests.profiles[]");
  const identityProof = Object.fromEntries(fields);
  if (!isExecutionIdentityProof(identityProof, IMAGE_ID) ||
    (identityProof.runtimeIdentity && identityProof.runtimeIdentity.actionId !== identityProof.actionId)) {
    throw invalid("tests.profiles[] 执行身份无效");
  }
  const profileWorkspaceRevision = sha256(
    fields.get("workspaceRevision"),
    "tests.profiles[].workspaceRevision",
  );
  if (profileWorkspaceRevision !== workspaceRevision) {
    throw invalid("测试证据未绑定最终 workspaceRevision");
  }
  return {
    id: boundedText(fields.get("id"), "tests.profiles[].id", 128, SAFE_ID),
    configDigest: sha256(
      fields.get("configDigest"),
      "tests.profiles[].configDigest",
    ),
    workspaceRevision: profileWorkspaceRevision,
    actionId: boundedText(
      fields.get("actionId"),
      "tests.profiles[].actionId",
      128,
      SAFE_ID,
    ),
    attemptNumber: positiveInteger(
      fields.get("attemptNumber"),
      "tests.profiles[].attemptNumber",
    ),
    ...executionIdentityFields(identityProof),
    artifactsDigest: sha256(
      fields.get("artifactsDigest"),
      "tests.profiles[].artifactsDigest",
    ),
  };
}

function normalizeTests(value, workspaceRevision) {
  const fields = exactObject(value, TEST_KEYS, "tests");
  const profiles = denseArray(
    fields.get("profiles"),
    MAX_PROFILES,
    "tests.profiles",
    { minimum: 1 },
  ).map((profile) => normalizeProfile(profile, workspaceRevision));
  if (
    fields.get("passedProfileCount") !== profiles.length ||
    fields.get("passedProfilesDigest") !== digestValue(profiles) ||
    profiles.some(
      ({ id }, index) => index > 0 && compareText(profiles[index - 1].id, id) >= 0,
    )
  ) {
    throw invalid("tests profile 计数或顺序无效");
  }
  return {
    passedProfileCount: profiles.length,
    passedProfilesDigest: sha256(
      fields.get("passedProfilesDigest"),
      "tests.passedProfilesDigest",
    ),
    profiles,
  };
}

function normalizeWorkspace(value) {
  const fields = exactObject(value, WORKSPACE_KEYS, "workspace");
  const sourceRevision = sha256(
    fields.get("sourceRevision"),
    "workspace.sourceRevision",
  );
  const workspaceRevision = sha256(
    fields.get("workspaceRevision"),
    "workspace.workspaceRevision",
  );
  if (sourceRevision === workspaceRevision) {
    throw invalid("受控 commit 必须包含已验证的 workspace 变化");
  }
  return {
    id: boundedText(fields.get("id"), "workspace.id", 128, SAFE_ID),
    sourceRevision,
    workspaceRevision,
  };
}

function exactStringArray(value, expected, name) {
  const values = denseArray(value, expected.length, name);
  if (
    values.length !== expected.length ||
    values.some((entry, index) => entry !== expected[index])
  ) {
    throw invalid(`${name} 未覆盖完整的精确冲突范围`);
  }
  return [...expected];
}

function normalizeResolution(value, executionSource) {
  if (isHeadRepairExecutionSource(executionSource)) {
    const fields = exactObject(value, REVIEW_REPAIR_RESOLUTION_KEYS, "resolution");
    const policy = new CodeExecutionPolicy({ writablePaths: codeExecutionSourceWritablePaths(executionSource) });
    const resolvedPaths = denseArray(fields.get("resolvedPaths"), 10_000, "resolution.resolvedPaths", { minimum: 1 })
      .map((entry) => policy.assertWritable(entry));
    if (resolvedPaths.some((entry, index) => index > 0 && compareText(resolvedPaths[index - 1], entry) >= 0) ||
        fields.get("resolvedPathsDigest") !== digestValue(resolvedPaths)) {
      throw invalid("Review repair resolution 路径或摘要无效");
    }
    return {
      resolvedPaths,
      resolvedPathsDigest: digestValue(resolvedPaths),
      finalTreeOid: gitOid(fields.get("finalTreeOid"), executionSource.inputBinding.headRefOid.length, "resolution.finalTreeOid"),
    };
  }
  const fields = exactObject(value, RESOLUTION_KEYS, "resolution");
  const binding = executionSource.preparationBinding;
  const oidLength = executionSource.inputBinding.gitTarget.headRefOid.length;
  const resolvedPaths = exactStringArray(
    fields.get("resolvedPaths"),
    codeExecutionSourceWritablePaths(executionSource),
    "resolution.resolvedPaths",
  );
  const finalTreeOid = gitOid(
    fields.get("finalTreeOid"),
    oidLength,
    "resolution.finalTreeOid",
  );
  if (
    fields.get("preparationId") !== binding.preparationId ||
    fields.get("resultTreeOid") !== binding.resultTreeOid ||
    fields.get("resolvedPathsDigest") !== digestValue(resolvedPaths) ||
    finalTreeOid === binding.resultTreeOid
  ) {
    throw invalid("resolution 与 executionSource 不一致");
  }
  return {
    preparationId: binding.preparationId,
    resultTreeOid: binding.resultTreeOid,
    resolvedPaths,
    resolvedPathsDigest: digestValue(resolvedPaths),
    finalTreeOid,
  };
}

function validEmail(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(value) ||
    value.startsWith(".") ||
    value.includes("..")
  ) {
    return false;
  }
  const [local, domain] = value.split("@");
  return (
    local.length <= 64 &&
    !local.endsWith(".") &&
    domain.length <= 253 &&
    domain.split(".").every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(segment),
    )
  );
}

function validTimezone(value) {
  const match = typeof value === "string"
    ? /^([+-])(\d{2})(\d{2})$/u.exec(value)
    : null;
  if (match === null) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return hours <= 14 && minutes <= 59 && (hours < 14 || minutes === 0);
}

function normalizeIdentity(value, expectedTimestamp, name) {
  const fields = exactObject(value, IDENTITY_KEYS, name);
  const identityName = boundedText(fields.get("name"), `${name}.name`, 128);
  const email = boundedText(fields.get("email"), `${name}.email`, 254);
  const timestamp = nonNegativeInteger(fields.get("timestamp"), `${name}.timestamp`);
  const timezone = fields.get("timezone");
  if (
    /[<>]/u.test(identityName) ||
    !validEmail(email) ||
    timestamp !== expectedTimestamp ||
    !validTimezone(timezone)
  ) {
    throw invalid(`${name} 无效`);
  }
  return { name: identityName, email, timestamp, timezone };
}

function normalizeCommit(value, {
  executionSource,
  resolution,
  createdAt,
  expectedMessageDigest,
}) {
  const fields = exactObject(value, COMMIT_KEYS, "commit");
  const objectFormat = fields.get("objectFormat");
  const oidLength = OBJECT_FORMATS[objectFormat];
  const target = executionSource.inputBinding.gitTarget;
  if (oidLength === undefined || target.headRefOid.length !== oidLength) {
    throw invalid("commit.objectFormat 与 Git target 不一致");
  }
  const parentCount = isHeadRepairExecutionSource(executionSource) ? 1 : 2;
  const parents = denseArray(fields.get("parents"), parentCount, "commit.parents", {
    minimum: parentCount,
  }).map((parent, index) =>
    gitOid(parent, oidLength, `commit.parents[${index}]`));
  if (
    parents[0] !== target.headRefOid ||
    (parentCount === 2 && (parents[1] !== target.baseRefOid ||
      parents[0] === parents[1]))
  ) {
    throw invalid("commit.parents 必须按 Head、Base 顺序绑定 Git target");
  }
  const treeOid = gitOid(fields.get("treeOid"), oidLength, "commit.treeOid");
  const expectedTimestamp = Math.floor(Date.parse(createdAt) / 1_000);
  const messageDigest = sha256(fields.get("messageDigest"), "commit.messageDigest");
  if (
    treeOid !== resolution.finalTreeOid ||
    messageDigest !== expectedMessageDigest
  ) {
    throw invalid("commit 未绑定 resolution 或规范消息");
  }
  return {
    objectFormat,
    oid: gitOid(fields.get("oid"), oidLength, "commit.oid"),
    treeOid,
    parents,
    author: normalizeIdentity(fields.get("author"), expectedTimestamp, "commit.author"),
    committer: normalizeIdentity(
      fields.get("committer"),
      expectedTimestamp,
      "commit.committer",
    ),
    messageDigest,
    objectSetDigest: sha256(
      fields.get("objectSetDigest"),
      "commit.objectSetDigest",
    ),
  };
}

function evidenceCore(value) {
  return Object.fromEntries(EVIDENCE_CORE_KEYS.map((key) => [key, value[key]]));
}

function normalizeEvidenceDocument(value) {
  const fields = exactObject(value, EVIDENCE_KEYS, "controlled commit evidence");
  if (
    ![1, 2].includes(fields.get("schemaVersion")) ||
    fields.get("kind") !== "controlled_git_commit"
  ) {
    throw invalid("controlled commit evidence kind 或 schemaVersion 无效");
  }
  const executionSource = normalizeSource(fields.get("executionSource"));
  const executionSourceDigest = sha256(
    fields.get("executionSourceDigest"),
    "executionSourceDigest",
  );
  if (executionSourceDigest !== digestValue(executionSource)) {
    throw invalid("executionSourceDigest 与 executionSource 不一致");
  }
  const packageEvidence = normalizePackage(fields.get("package"));
  const workspace = normalizeWorkspace(fields.get("workspace"));
  const tests = normalizeTests(fields.get("tests"), workspace.workspaceRevision);
  const resolution = normalizeResolution(
    fields.get("resolution"),
    executionSource,
  );
  const createdAt = canonicalTimestamp(fields.get("createdAt"));
  const expectedMessageDigest = rawSha256(messageFromBindings({
    sourceKind: executionSource.kind,
    executionSourceDigest,
    packageDigest: packageEvidence.packageDigest,
    passedProfilesDigest: tests.passedProfilesDigest,
    workspaceRevision: workspace.workspaceRevision,
  }));
  const commit = normalizeCommit(fields.get("commit"), {
    executionSource,
    resolution,
    createdAt,
    expectedMessageDigest,
  });
  const core = {
    schemaVersion: tests.profiles.some((profile) => profile.runtimeIdentity) ? 2 : 1,
    kind: "controlled_git_commit",
    executionSource,
    executionSourceDigest,
    package: packageEvidence,
    tests,
    workspace,
    resolution,
    commit,
    createdAt,
  };
  const evidenceDigest = sha256(fields.get("evidenceDigest"), "evidenceDigest");
  if (fields.get("schemaVersion") !== core.schemaVersion) throw invalid("controlled commit schemaVersion 与执行身份不一致");
  const evidenceId = boundedText(
    fields.get("evidenceId"),
    "evidenceId",
    128,
    EVIDENCE_ID,
  );
  if (
    evidenceDigest !== digestValue(core) ||
    evidenceId !== `controlled-git-commit-${evidenceDigest}`
  ) {
    throw invalid("controlled commit evidence 摘要绑定无效");
  }
  return deepFreeze({ ...core, evidenceDigest, evidenceId });
}

export function createControlledCommitMessage(value) {
  return guarded(() => {
    assertSafeDataTree(value);
    const fields = exactObject(value, MESSAGE_INPUT_KEYS, "message input");
    return creationBindings(
      fields.get("executionSource"),
      fields.get("manifest"),
    ).message;
  });
}

export function createControlledCommitEvidence(value) {
  return guarded(() => {
    assertSafeDataTree(value);
    const fields = exactObject(value, CREATION_KEYS, "controlled commit input");
    const bindings = creationBindings(
      fields.get("executionSource"),
      fields.get("manifest"),
    );
    const resolutionInput = exactObject(
      fields.get("resolution"),
      CREATION_RESOLUTION_KEYS,
      "resolution input",
    );
    const resolution = normalizeResolution(
      {
        ...(isHeadRepairExecutionSource(bindings.executionSource) ? {} : { preparationId:
          bindings.executionSource.preparationBinding.preparationId,
        resultTreeOid:
          bindings.executionSource.preparationBinding.resultTreeOid }),
        resolvedPaths: resolutionInput.get("resolvedPaths"),
        resolvedPathsDigest: digestValue(bindings.resolvedPaths),
        finalTreeOid: resolutionInput.get("finalTreeOid"),
      },
      bindings.executionSource,
    );
    if (!sameUniqueValues(resolution.resolvedPaths, bindings.resolvedPaths)) {
      throw invalid("resolution 未绑定 manifest 真实变更路径");
    }
    const createdAt = canonicalTimestamp(fields.get("createdAt"));
    const commit = normalizeCommit(fields.get("commit"), {
      executionSource: bindings.executionSource,
      resolution,
      createdAt,
      expectedMessageDigest: rawSha256(bindings.message),
    });
    const core = {
      schemaVersion: bindings.tests.profiles.some((profile) => profile.runtimeIdentity) ? 2 : 1,
      kind: "controlled_git_commit",
      executionSource: bindings.executionSource,
      executionSourceDigest: bindings.executionSourceDigest,
      package: bindings.packageEvidence,
      tests: bindings.tests,
      workspace: bindings.workspace,
      resolution,
      commit,
      createdAt,
    };
    const evidenceDigest = digestValue(core);
    return normalizeEvidenceDocument({
      ...core,
      evidenceDigest,
      evidenceId: `controlled-git-commit-${evidenceDigest}`,
    });
  });
}

export function normalizeControlledCommitEvidence(value) {
  return guarded(() => {
    assertSafeDataTree(value);
    return normalizeEvidenceDocument(value);
  });
}

export function sameControlledCommitEvidence(left, right) {
  try {
    return normalizeControlledCommitEvidence(left).evidenceDigest ===
      normalizeControlledCommitEvidence(right).evidenceDigest;
  } catch {
    return false;
  }
}

export function controlledCommitEvidenceCore(value) {
  return guarded(() => {
    const normalized = normalizeControlledCommitEvidence(value);
    return deepFreeze(structuredClone(evidenceCore(normalized)));
  });
}
