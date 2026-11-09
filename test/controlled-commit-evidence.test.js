import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ciRepairSource } from './support/ci-repair-fixture.js';

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  ControlledCommitEvidenceError,
  controlledCommitEvidenceCore,
  createControlledCommitEvidence,
  createControlledCommitMessage,
  normalizeControlledCommitEvidence,
  sameControlledCommitEvidence,
} from "../src/domain/controlled-commit-evidence.js";

const SOURCE_REVISION = "a".repeat(64);
const WORKSPACE_REVISION = "b".repeat(64);
const CREATED_AT = "2026-08-08T06:07:08.901Z";

function oid(character, length = 40) {
  return character.repeat(length);
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitTarget(length = 40) {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: oid("1", length),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: oid("2", length),
  };
}

function pullRequestBinding(target) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: target.baseRepository,
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/repo#42",
    workKey: "pr:acme/repo#42",
    inputRevision: 3,
    headRevision: 5,
    headRefOid: target.headRefOid,
    eventId: "github-event-42",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
    gitTarget: target,
  };
}

function executionSource({ length = 40, paths = ["src/first.js", "src/second.js"] } = {}) {
  const target = gitTarget(length);
  const preparationBinding = createConflictPreparationBinding({
    gitTarget: target,
    preparation: {
      schemaVersion: 1,
      preparationId: "5".repeat(64),
      status: "conflicted",
      baseCommitOid: target.baseRefOid,
      headCommitOid: target.headRefOid,
      mergeBaseOid: oid("3", length),
      resultTreeOid: oid("4", length),
      conflicts: paths.map((path) => ({ path, mode: "100644" })),
      boundaryDigest: "6".repeat(64),
      evidenceDigest: "7".repeat(64),
      resultObjectDigest: "8".repeat(64),
      materialization: "full-tree",
    },
  });
  return createConflictCodeExecutionSource({
    inputBinding: pullRequestBinding(target),
    preparationBinding,
  });
}

function artifact(profileId, kind, marker) {
  return {
    path: `session-1/${profileId}/${kind}.json`,
    sha256: marker.repeat(64),
    bytes: 12,
  };
}

function passedProfile(id, workspaceRevision, marker = "c") {
  return {
    id,
    configDigest: marker.repeat(64),
    workspaceRevision,
    actionId: `action-${id}`,
    attemptNumber: 2,
    imageId: `sha256:image-${id}`,
    artifacts: {
      output: artifact(id, "output", marker),
      stdout: artifact(id, "stdout", marker),
      stderr: artifact(id, "stderr", marker),
    },
  };
}

function manifestFor(source, overrides = {}) {
  const workspace = overrides.workspace ?? {
    id: "workspace-1",
    sourceRevision: SOURCE_REVISION,
    workspaceRevision: WORKSPACE_REVISION,
  };
  const draft = {
    job: { id: "code-job-1", revision: 7, recordDigest: "9".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "a".repeat(64) },
    grant: { digest: "b".repeat(64) },
    workspace,
    passedProfiles: [
      passedProfile("node-tests", workspace.workspaceRevision, "c"),
      passedProfile("security-tests", workspace.workspaceRevision, "d"),
    ],
    created: [],
    modified: source.writeScope.paths.map((path, index) => ({
      path,
      beforeSha256: String(index + 1).repeat(64),
      content: Buffer.from(`resolved ${path}\n`, "utf8"),
    })),
    deleted: [],
    ...overrides,
    workspace,
  };
  return createChangePackage(draft).manifest;
}

function commitFor({ source, manifest, finalTreeOid, createdAt = CREATED_AT, overrides = {} }) {
  const length = source.inputBinding.gitTarget.headRefOid.length;
  const timestamp = Math.floor(Date.parse(createdAt) / 1_000);
  const identity = {
    name: "MyDashboard PR Engineer",
    email: "pr-engineer@mydashboard.local",
    timestamp,
    timezone: "+0000",
  };
  return {
    objectFormat: length === 40 ? "sha1" : "sha256",
    oid: oid("6", length),
    treeOid: finalTreeOid,
    parents: [
      source.inputBinding.gitTarget.headRefOid,
      source.inputBinding.gitTarget.baseRefOid,
    ],
    author: { ...identity },
    committer: { ...identity },
    messageDigest: sha256Text(createControlledCommitMessage({
      executionSource: source,
      manifest,
    })),
    objectSetDigest: "e".repeat(64),
    ...overrides,
  };
}

function evidenceInput({ length = 40, source, manifest, resolution, commit, createdAt = CREATED_AT } = {}) {
  const selectedSource = source ?? executionSource({ length });
  const selectedManifest = manifest ?? manifestFor(selectedSource);
  const finalTreeOid = resolution?.finalTreeOid ?? oid("5", length);
  return {
    executionSource: selectedSource,
    manifest: selectedManifest,
    resolution: resolution ?? {
      resolvedPaths: [...selectedSource.writeScope.paths],
      finalTreeOid,
    },
    commit: commit ?? commitFor({
      source: selectedSource,
      manifest: selectedManifest,
      finalTreeOid,
      createdAt,
    }),
    createdAt,
  };
}

function hasControlledEvidenceError(error) {
  return error instanceof ControlledCommitEvidenceError &&
    error.code === "INVALID_CONTROLLED_COMMIT_EVIDENCE";
}

function mutableClone(value) {
  return structuredClone(value);
}

test("Windows controlled commit evidence preserves native test identity and binds its digest", () => {
  const source = executionSource();
  const profile = passedProfile("windows-tests", WORKSPACE_REVISION);
  delete profile.imageId;
  Object.assign(profile, { runtimeIdentity: { schemaVersion: 1, kind: "windows-process", executionId: "session-1-attempt-2", actionId: profile.actionId,
    pid: 4567, processStartTimeUtcTicks: String(639013000000000000n), executableSha256: "d".repeat(64) }, assetVersion: 2, verificationKind: "test" });
  const manifest = manifestFor(source, { passedProfiles: [profile] });
  const evidence = createControlledCommitEvidence(evidenceInput({ source, manifest }));
  assert.equal(evidence.schemaVersion, 2);
  assert.deepEqual(normalizeControlledCommitEvidence(evidence), evidence);
  assert.equal(evidence.tests.profiles[0].runtimeIdentity.pid, 4567);
  assert.equal(Object.hasOwn(evidence.tests.profiles[0], "imageId"), false);
  const tampered = mutableClone(evidence);
  tampered.tests.profiles[0].runtimeIdentity.pid += 1;
  assert.throws(() => normalizeControlledCommitEvidence(tampered), hasControlledEvidenceError);
});

for (const sourceKind of ['review_repair', 'ci_repair']) test(`${sourceKind} evidence binds actual changed files and one exact Head parent`, () => {
  const binding = pullRequestBinding(gitTarget());
  const source = sourceKind === 'ci_repair' ? ciRepairSource(binding, ['src', 'test'])
    : createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src", "test"] });
  const manifest = manifestFor(source, { modified: [{ path: "src/value.js", beforeSha256: "1".repeat(64), content: Buffer.from("fixed\n") }] });
  const finalTreeOid = oid("5");
  const commit = commitFor({ source, manifest, finalTreeOid, overrides: { parents: [source.inputBinding.headRefOid] } });
  const input = evidenceInput({ source, manifest, commit, resolution: { resolvedPaths: ["src/value.js"], finalTreeOid } });
  const evidence = createControlledCommitEvidence(input);
  assert.equal(evidence.executionSource.kind, sourceKind);
  assert.equal(Object.hasOwn(evidence.resolution, "preparationId"), false);
  assert.deepEqual(evidence.commit.parents, [source.inputBinding.headRefOid]);
  assert.match(createControlledCommitMessage({ executionSource: source, manifest }), sourceKind === 'ci_repair' ? /controlled CI repair/ : /controlled review repair/);
  assert.deepEqual(normalizeControlledCommitEvidence(evidence), evidence);
  for (const changed of [
    { ...input, commit: { ...commit, parents: [source.inputBinding.gitTarget.baseRefOid] } },
    { ...input, commit: { ...commit, parents: [source.inputBinding.headRefOid, source.inputBinding.gitTarget.baseRefOid] } },
    { ...input, resolution: { resolvedPaths: ["src/other.js"], finalTreeOid } },
  ]) assert.throws(() => createControlledCommitEvidence(changed));
});

test("creates deterministic, detached, deeply frozen controlled commit evidence", () => {
  const input = evidenceInput();
  const first = createControlledCommitEvidence(input);
  const repeated = createControlledCommitEvidence(evidenceInput());
  const core = controlledCommitEvidenceCore(first);

  assert.deepEqual(first, repeated);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, "controlled_git_commit");
  assert.equal(first.executionSourceDigest, digestValue(first.executionSource));
  assert.equal(first.package.packageId, input.manifest.packageId);
  assert.equal(first.package.packageDigest, input.manifest.packageDigest);
  assert.equal(first.package.changeSetDigest, digestValue(input.manifest.changes));
  assert.deepEqual(first.workspace, input.manifest.workspace);
  assert.equal(first.tests.passedProfileCount, 2);
  assert.equal(first.tests.passedProfilesDigest, digestValue(first.tests.profiles));
  assert.deepEqual(
    first.tests.profiles.map(({ id, artifactsDigest }) => ({ id, artifactsDigest })),
    input.manifest.passedProfiles.map(({ id, artifacts }) => ({
      id,
      artifactsDigest: digestValue(artifacts),
    })),
  );
  assert.deepEqual(first.resolution.resolvedPaths, input.executionSource.writeScope.paths);
  assert.equal(first.resolution.resolvedPathsDigest, digestValue(first.resolution.resolvedPaths));
  assert.equal(first.commit.treeOid, first.resolution.finalTreeOid);
  assert.deepEqual(first.commit.parents, [oid("2"), oid("1")]);
  assert.equal(first.evidenceDigest, digestValue(core));
  assert.equal(first.evidenceId, `controlled-git-commit-${first.evidenceDigest}`);
  assert.equal(Object.hasOwn(core, "evidenceDigest"), false);
  assert.equal(Object.hasOwn(core, "evidenceId"), false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.commit.author));
  assert.ok(Object.isFrozen(first.resolution.resolvedPaths));
  assert.ok(Object.isFrozen(core));

  input.executionSource.inputBinding.rootItemId = "changed-after-creation";
  input.commit.author.name = "Changed After Creation";
  assert.equal(first.executionSource.inputBinding.rootItemId, "github:pr:acme/repo#42");
  assert.equal(first.commit.author.name, "MyDashboard PR Engineer");
  assert.deepEqual(normalizeControlledCommitEvidence(mutableClone(first)), first);
  assert.equal(sameControlledCommitEvidence(first, mutableClone(first)), true);
});

test("builds one canonical commit message from exact source, package, and tests", () => {
  const input = evidenceInput();
  const evidence = createControlledCommitEvidence(input);
  const message = createControlledCommitMessage({
    executionSource: input.executionSource,
    manifest: input.manifest,
  });

  assert.equal(message, [
    "MyDashboard controlled conflict resolution",
    "",
    `Execution-Source-Digest: ${evidence.executionSourceDigest}`,
    `Change-Package-Digest: ${evidence.package.packageDigest}`,
    `Test-Evidence-Digest: ${evidence.tests.passedProfilesDigest}`,
    `Workspace-Revision: ${evidence.workspace.workspaceRevision}`,
    "",
  ].join("\n"));
  assert.equal(evidence.commit.messageDigest, sha256Text(message));
});

test("normalization rejects tampering across every evidence boundary", () => {
  const evidence = createControlledCommitEvidence(evidenceInput());
  const candidates = [
    ["execution source", (value) => { value.executionSource.inputBinding.headRevision += 1; }],
    ["execution digest", (value) => { value.executionSourceDigest = "f".repeat(64); }],
    ["package identity", (value) => { value.package.job.id = "other-job"; }],
    ["package digest", (value) => { value.package.packageDigest = "f".repeat(64); }],
    ["test count", (value) => { value.tests.passedProfileCount = 1; }],
    ["test profile", (value) => { value.tests.profiles[0].actionId = "other-action"; }],
    ["test digest", (value) => { value.tests.passedProfilesDigest = "f".repeat(64); }],
    ["workspace", (value) => { value.workspace.id = "other-workspace"; }],
    ["preparation", (value) => { value.resolution.preparationId = "f".repeat(64); }],
    ["result tree", (value) => { value.resolution.resultTreeOid = oid("3"); }],
    ["resolved paths", (value) => { value.resolution.resolvedPaths.reverse(); }],
    ["resolved paths digest", (value) => { value.resolution.resolvedPathsDigest = "f".repeat(64); }],
    ["final tree", (value) => { value.resolution.finalTreeOid = oid("3"); }],
    ["object format", (value) => { value.commit.objectFormat = "sha256"; }],
    ["commit tree", (value) => { value.commit.treeOid = oid("3"); }],
    ["parent order", (value) => { value.commit.parents.reverse(); }],
    ["author timestamp", (value) => { value.commit.author.timestamp += 1; }],
    ["message digest", (value) => { value.commit.messageDigest = "f".repeat(64); }],
    ["object set", (value) => { value.commit.objectSetDigest = "f".repeat(64); }],
    ["created time", (value) => { value.createdAt = "2026-08-08T06:07:09.901Z"; }],
    ["evidence digest", (value) => { value.evidenceDigest = "f".repeat(64); }],
    ["evidence id", (value) => { value.evidenceId = `controlled-git-commit-${"f".repeat(64)}`; }],
  ];

  for (const [name, mutate] of candidates) {
    const candidate = mutableClone(evidence);
    mutate(candidate);
    assert.throws(
      () => normalizeControlledCommitEvidence(candidate),
      hasControlledEvidenceError,
      name,
    );
    assert.equal(sameControlledCommitEvidence(evidence, candidate), false, name);
  }
});

test("creation rejects incomplete resolutions, stale tests, and mismatched Git objects", () => {
  const source = executionSource();
  const validManifest = manifestFor(source);
  const finalTreeOid = oid("5");
  const validCommit = commitFor({ source, manifest: validManifest, finalTreeOid });
  const invalidInputs = [];

  const partialManifest = manifestFor(source, {
    modified: [{
      path: source.writeScope.paths[0],
      beforeSha256: "1".repeat(64),
      content: Buffer.from("partial resolution\n"),
    }],
  });
  invalidInputs.push(evidenceInput({
    source,
    manifest: partialManifest,
    commit: validCommit,
  }));

  const createdManifest = manifestFor(source, {
    modified: [],
    created: source.writeScope.paths.map((path) => ({
      path,
      content: Buffer.from(`created ${path}\n`),
    })),
  });
  invalidInputs.push(evidenceInput({
    source,
    manifest: createdManifest,
    commit: validCommit,
  }));

  const unchangedContent = Buffer.from("unchanged\n");
  const unchangedManifest = manifestFor(source, {
    modified: source.writeScope.paths.map((path) => ({
      path,
      beforeSha256: createHash("sha256").update(unchangedContent).digest("hex"),
      content: unchangedContent,
    })),
  });
  invalidInputs.push(evidenceInput({
    source,
    manifest: unchangedManifest,
    commit: validCommit,
  }));

  const unchangedWorkspace = {
    id: "workspace-1",
    sourceRevision: SOURCE_REVISION,
    workspaceRevision: SOURCE_REVISION,
  };
  invalidInputs.push(evidenceInput({
    source,
    manifest: manifestFor(source, { workspace: unchangedWorkspace }),
    commit: validCommit,
  }));

  invalidInputs.push(evidenceInput({
    source,
    manifest: validManifest,
    resolution: {
      resolvedPaths: [source.writeScope.paths[0]],
      finalTreeOid,
    },
  }));
  invalidInputs.push(evidenceInput({
    source,
    manifest: validManifest,
    resolution: {
      resolvedPaths: [...source.writeScope.paths],
      finalTreeOid: source.preparationBinding.resultTreeOid,
    },
  }));
  invalidInputs.push(evidenceInput({
    source,
    manifest: validManifest,
    commit: {
      ...validCommit,
      parents: [...validCommit.parents].reverse(),
    },
  }));
  invalidInputs.push(evidenceInput({
    source,
    manifest: validManifest,
    commit: { ...validCommit, objectFormat: "sha256" },
  }));
  invalidInputs.push(evidenceInput({
    source,
    manifest: validManifest,
    commit: { ...validCommit, messageDigest: "f".repeat(64) },
  }));

  for (const input of invalidInputs) {
    assert.throws(
      () => createControlledCommitEvidence(input),
      hasControlledEvidenceError,
    );
  }
});

test("unsafe JSON inputs fail closed without invoking accessors or Proxy traps", () => {
  const validInput = evidenceInput();
  const accessor = { ...validInput };
  let accessorReads = 0;
  Object.defineProperty(accessor, "manifest", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return validInput.manifest;
    },
  });
  assert.throws(
    () => createControlledCommitEvidence(accessor),
    hasControlledEvidenceError,
  );
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(validInput, {
    ownKeys() {
      proxyReads += 1;
      throw new Error("Proxy trap must not run");
    },
  });
  assert.throws(
    () => createControlledCommitEvidence(proxy),
    hasControlledEvidenceError,
  );
  assert.equal(proxyReads, 0);
  assert.equal(sameControlledCommitEvidence(proxy, proxy), false);
  assert.equal(proxyReads, 0);

  const circular = mutableClone(validInput);
  circular.resolution.resolvedPaths.push(circular.resolution.resolvedPaths);
  assert.throws(
    () => createControlledCommitEvidence(circular),
    hasControlledEvidenceError,
  );

  const sparse = mutableClone(validInput);
  sparse.commit.parents = new Array(2);
  sparse.commit.parents[0] = validInput.commit.parents[0];
  assert.throws(
    () => createControlledCommitEvidence(sparse),
    hasControlledEvidenceError,
  );

  const dangerous = mutableClone(validInput);
  Object.defineProperty(dangerous.resolution, "__proto__", {
    enumerable: true,
    value: {},
  });
  assert.throws(
    () => createControlledCommitEvidence(dangerous),
    hasControlledEvidenceError,
  );
});

test("supports SHA-256 repositories while enforcing format-sized object ids", () => {
  const input = evidenceInput({ length: 64 });
  const evidence = createControlledCommitEvidence(input);

  assert.equal(evidence.commit.objectFormat, "sha256");
  assert.equal(evidence.commit.oid.length, 64);
  assert.equal(evidence.commit.treeOid.length, 64);
  assert.deepEqual(evidence.commit.parents, [oid("2", 64), oid("1", 64)]);
  assert.deepEqual(normalizeControlledCommitEvidence(mutableClone(evidence)), evidence);
});

test("accepts equivalent canonical ordering from source and package contracts", () => {
  const source = executionSource({ paths: ["src/a.js", "src/Z.js"] });
  const manifest = manifestFor(source, {
    passedProfiles: [
      passedProfile("a-tests", WORKSPACE_REVISION, "c"),
      passedProfile("Z-tests", WORKSPACE_REVISION, "d"),
    ],
  });
  const input = evidenceInput({ source, manifest });
  const evidence = createControlledCommitEvidence(input);

  assert.deepEqual(source.writeScope.paths, ["src/a.js", "src/Z.js"]);
  assert.deepEqual(
    manifest.changes.modified.map(({ path }) => path),
    ["src/Z.js", "src/a.js"],
  );
  assert.deepEqual(
    manifest.passedProfiles.map(({ id }) => id),
    ["Z-tests", "a-tests"],
  );
  assert.deepEqual(evidence.resolution.resolvedPaths, source.writeScope.paths);
  assert.deepEqual(
    evidence.tests.profiles.map(({ id }) => id),
    manifest.passedProfiles.map(({ id }) => id),
  );
});
