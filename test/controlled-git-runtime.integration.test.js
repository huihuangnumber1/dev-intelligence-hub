import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";
import { ciRepairSource } from './support/ci-repair-fixture.js';

import { createControlledGitRuntimeBundle } from "../src/controlled-git-runtime.js";
import { createChangePackage } from "../src/domain/change-package-contract.js";
import { createReviewRepairCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { canonicalJsonStringify } from "../src/lib/canonical-json-digest.js";
import { ChangePackageControlledCommitService } from "../src/services/change-package-controlled-commit-service.js";
import { ChangePackageStore } from "../src/services/change-package-store.js";

const execFile = promisify(execFileCallback);

function locateGit() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return path.resolve(candidate);
  return windowsGitImplementationCandidates(candidate).find(existsSync) ?? null;
}

async function git(gitCommand, cwd, args, options = {}) {
  return execFile(gitCommand, ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

class RecordingProcessRunner {
  calls = [];

  async run(request) {
    this.calls.push({
      args: [...request.args],
      cwd: request.cwd,
      inputSha256: request.input === undefined
        ? null
        : sha256(Buffer.from(request.input)),
    });
    return new Promise((resolve, reject) => {
      const child = execFileCallback(
        request.command,
        request.args,
        {
          cwd: request.cwd,
          encoding: "buffer",
          env: request.env,
          maxBuffer: Math.max(request.maxOutputBytes ?? 0, 16 * 1024),
          timeout: request.timeoutMs ?? 30_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(error);
            return;
          }
          resolve({
            exitCode: error
              ? Number.isSafeInteger(error.code) ? error.code : -1
              : 0,
            signal: error?.signal ?? null,
            stdout: Buffer.from(stdout ?? ""),
            stderr: Buffer.from(stderr ?? ""),
            truncated: request.maxOutputBytes === undefined
              ? false
              : Buffer.byteLength(stdout ?? "") > request.maxOutputBytes ||
                Buffer.byteLength(stderr ?? "") > request.maxOutputBytes,
          });
        },
      );
      child.stdin?.end(request.input);
    });
  }
}

class PublicationProcessRunner extends RecordingProcessRunner {
  publicationCalls = [];
  remoteHead = null;
  publicationMode = "apply";
  pushCount = 0;
  unknownStarted = false;

  async run(request) {
    if (request.args.includes("ls-remote")) {
      this.publicationCalls.push({
        operation: "ls-remote",
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: { ...request.env },
      });
      if (this.publicationMode === "unknown" && this.unknownStarted) {
        return {
          exitCode: 128,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("remote result unavailable\n"),
          truncated: false,
        };
      }
      const refName = request.args.at(-1);
      return this.remoteHead === null
        ? {
            exitCode: 2,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            truncated: false,
          }
        : {
            exitCode: 0,
            signal: null,
            stdout: Buffer.from(`${this.remoteHead}\t${refName}\n`, "utf8"),
            stderr: Buffer.alloc(0),
            truncated: false,
          };
    }
    if (request.args.includes("push")) {
      this.pushCount += 1;
      this.publicationCalls.push({
        operation: "push",
        command: request.command,
        args: [...request.args],
        cwd: request.cwd,
        env: { ...request.env },
      });
      const refspec = request.args.at(-1);
      const commitOid = refspec.slice(0, refspec.indexOf(":"));
      if (this.publicationMode === "apply") this.remoteHead = commitOid;
      if (this.publicationMode === "unknown") this.unknownStarted = true;
      return {
        exitCode: this.publicationMode === "apply" ? 0 : 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        truncated: false,
      };
    }
    return super.run(request);
  }
}

async function repositoryState(gitCommand, repositoryRoot) {
  const [status, head] = await Promise.all([
    git(gitCommand, repositoryRoot, ["status", "--porcelain=v1"]),
    git(gitCommand, repositoryRoot, ["rev-parse", "HEAD"]),
  ]);
  return { status: status.stdout, head: head.stdout.trim() };
}

async function mirrorRefs(gitCommand, mirrorRoot) {
  return (
    await git(gitCommand, mirrorRoot, [
      "--git-dir=.",
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ])
  ).stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directorySnapshot(root, { metadata = false } = {}) {
  const snapshot = [];
  async function visit(relativeDirectory) {
    const directory = path.join(
      root,
      ...relativeDirectory.split("/").filter(Boolean),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const target = path.join(root, ...relativePath.split("/"));
      const stats = await lstat(target);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(relativePath);
      } else {
        assert.equal(stats.isFile(), true, relativePath);
        snapshot.push(`file:${relativePath}:${sha256(await readFile(target))}`);
        if (metadata) snapshot.push(`identity:${relativePath}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.mode}`);
      }
    }
  }
  await visit("");
  return snapshot;
}

async function firstLooseObject(root) {
  const directories = await readdir(root, { withFileTypes: true });
  for (const directory of directories) {
    if (!/^[a-f0-9]{2}$/u.test(directory.name) || !directory.isDirectory()) {
      continue;
    }
    const files = await readdir(path.join(root, directory.name), {
      withFileTypes: true,
    });
    const file = files.find((entry) => entry.isFile());
    if (file) return path.join(root, directory.name, file.name);
  }
  throw new Error("expected one loose commit object");
}

function passedProfile(workspaceRevision) {
  const artifact = (kind, marker) => ({
    path: `session-1/node-tests/${kind}.json`,
    sha256: marker.repeat(64),
    bytes: 12,
  });
  return {
    id: "node-tests",
    configDigest: "a".repeat(64),
    workspaceRevision,
    actionId: "action-node-tests",
    attemptNumber: 1,
    imageId: "sha256:node-test-image",
    artifacts: {
      output: artifact("output", "b"),
      stdout: artifact("stdout", "c"),
      stderr: artifact("stderr", "d"),
    },
  };
}

function inputBinding({ baseOid, headOid }) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/runtime-test",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/runtime-test#42",
    workKey: "pr:acme/runtime-test#42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: headOid,
    eventId: "github-event-pr-42",
    eventDigest: "1".repeat(64),
    inputDigest: "2".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-test-user",
      baseRepository: "acme/runtime-test",
      baseRefName: "main",
      baseRefOid: baseOid,
      headRepository: "contributor/runtime-test",
      headRefName: "feature",
      headRefOid: headOid,
    },
  };
}

async function createFixture(t, gitCommand, { fullRepository = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-git-runtime-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const baseMirrorRoot = path.join(root, "base.git");
  const headMirrorRoot = path.join(root, "head.git");
  const preparationRoot = path.join(root, "preparations");
  await Promise.all([mkdir(sourceRoot), mkdir(preparationRoot)]);
  await git(gitCommand, sourceRoot, ["init", "--initial-branch=main", "--object-format=sha1"]);
  await git(gitCommand, sourceRoot, ["config", "user.name", "MyDashboard Test"]);
  await git(gitCommand, sourceRoot, ["config", "user.email", "mydashboard@example.invalid"]);
  await mkdir(path.join(sourceRoot, "src"));
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "common content\n");
  await writeFile(path.join(sourceRoot, "src", "untouched.txt"), "common file\n");
  if (fullRepository) {
    const resource = Buffer.alloc(9_000_000, 0x61); resource[0] = 0;
    await writeFile(path.join(sourceRoot, "resource.bin"), resource);
    await writeFile(path.join(sourceRoot, "src", "removed.txt"), "obsolete\n");
    await writeFile(path.join(sourceRoot, "src", "rename-before.txt"), "unchanged renamed content\n");
    await writeFile(path.join(sourceRoot, "Z-notes.txt"), "uppercase file\n");
    await writeFile(path.join(sourceRoot, "a-notes.txt"), "lowercase file\n");
    await writeFile(path.join(sourceRoot, "_notes.txt"), "punctuation file\n");
  }
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "common ancestor"]);

  await git(gitCommand, sourceRoot, ["switch", "--create", "feature"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "head content\n");
  if (fullRepository) {
    await writeFile(path.join(sourceRoot, "src", "head-added.txt"), "head addition\n");
    await git(gitCommand, sourceRoot, ["mv", "src/rename-before.txt", "src/rename-after.txt"]);
  }
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "head change"]);
  const headOid = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();

  await git(gitCommand, sourceRoot, ["switch", "main"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "base content\n");
  if (fullRepository) {
    const resource = await readFile(path.join(sourceRoot, "resource.bin")); resource[resource.length - 1] = 0xff;
    await writeFile(path.join(sourceRoot, "resource.bin"), resource);
    await rm(path.join(sourceRoot, "src", "removed.txt"));
    await writeFile(path.join(sourceRoot, "src", "base-added.txt"), "base addition\n");
  }
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "base change"]);
  const baseOid = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();

  await git(gitCommand, root, ["clone", "--bare", "--no-local", "--single-branch", "--branch", "main", sourceRoot, baseMirrorRoot]);
  await git(gitCommand, root, ["clone", "--bare", "--no-local", "--single-branch", "--branch", "feature", sourceRoot, headMirrorRoot]);
  return {
    root,
    baseMirrorRoot,
    baseOid,
    headMirrorRoot,
    headOid,
    preparationRoot,
    sourceRoot,
  };
}

const gitCommand = locateGit();

test("controlled conflict repair preserves a bounded full repository with non-conflicting binary additions and deletions", {
  skip: gitCommand === null ? "trusted Git is unavailable" : false,
}, async (t) => {
  const setup = await createFixture(t, gitCommand, { fullRepository: true });
  const config = { enabled: true, gitCommand, preparationRoot: setup.preparationRoot,
    baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
    headMirrorsByRepository: { "contributor/runtime-test": setup.headMirrorRoot } };
  const processRunner = new RecordingProcessRunner();
  const dependencies = { processRunner, limits: { maxBlobBytes: 10_000_000, maxTotalBytes: 12_000_000 } };
  const bundle = await createControlledGitRuntimeBundle(config, dependencies);
  const source = await bundle.preparer.prepare(inputBinding(setup));
  assert.deepEqual(source.writeScope.paths, ["src/conflict.txt"]);
  const blobBatches = () => processRunner.calls.filter(({ args }) =>
    args.includes("cat-file") && args.includes("--batch")).length;
  const batchesBeforeInspection = blobBatches();
  const inspection = await bundle.inspectionReader.read(inputBinding(setup));
  assert.ok(batchesBeforeInspection > 0);
  assert.equal(blobBatches(), batchesBeforeInspection);
  assert.deepEqual(inspection.inputBinding, inputBinding(setup));
  assert.deepEqual(inspection.conflicts.map(entry => entry.path), ["src/conflict.txt"]);
  assert.deepEqual(inspection.conflicts[0].versions.slice(0, 3).map(entry => entry.excerpt),
    ["common content\n", "head content\n", "base content\n"]);
  assert.match(inspection.conflicts[0].versions[3].excerpt, /<<<<<<< /u);
  const targetRoot = path.join(setup.root, "full-repository"); await mkdir(targetRoot);
  await bundle.materializer.materialize({ binding: source.preparationBinding, targetRoot, excludePaths: [] });
  const resource = await readFile(path.join(targetRoot, "resource.bin"));
  assert.equal(resource.length, 9_000_000); assert.equal(resource[0], 0); assert.equal(resource.at(-1), 0xff);
  assert.equal(await readFile(path.join(targetRoot, "Z-notes.txt"), "utf8"), "uppercase file\n");
  assert.equal(await readFile(path.join(targetRoot, "a-notes.txt"), "utf8"), "lowercase file\n");
  assert.equal(await readFile(path.join(targetRoot, "_notes.txt"), "utf8"), "punctuation file\n");
  assert.equal(await readFile(path.join(targetRoot, "src", "base-added.txt"), "utf8"), "base addition\n");
  assert.equal(await readFile(path.join(targetRoot, "src", "head-added.txt"), "utf8"), "head addition\n");
  await assert.rejects(lstat(path.join(targetRoot, "src", "removed.txt")), { code: "ENOENT" });
  const workspaceRevision = "e".repeat(64);
  const draft = { job: { id: "full-repo-job", revision: 3, recordDigest: "3".repeat(64) },
    proposal: { id: "full-repo-proposal", contentDigest: "4".repeat(64) }, grant: { digest: "5".repeat(64) },
    workspace: { id: "runtime-workspace", sourceRevision: "d".repeat(64), workspaceRevision },
    passedProfiles: [passedProfile(workspaceRevision)], created: [], deleted: [],
    modified: [{ path: "src/conflict.txt", beforeSha256: sha256(await readFile(path.join(targetRoot, "src", "conflict.txt"))),
      content: Buffer.from("resolved both branches\n") }] };
  const changePackage = createChangePackage(draft);
  const request = { executionSource: source, manifest: changePackage.manifest,
    blobs: changePackage.blobs.map(({ sha256, content }) => ({ sha256, content })), createdAt: "2026-10-17T08:00:00.000Z" };
  const evidence = await bundle.commitBuilder.create(request);
  const restarted = await createControlledGitRuntimeBundle(config, dependencies);
  assert.deepEqual(await restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }), evidence);
  const env = { ...process.env,
    GIT_OBJECT_DIRECTORY: path.join(setup.preparationRoot, "commits", evidence.evidenceId, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [path.join(setup.baseMirrorRoot, "objects"), path.join(setup.headMirrorRoot, "objects")].join(path.delimiter) };
  const finalResource = await git(gitCommand, setup.headMirrorRoot,
    ["show", `${evidence.commit.oid}:resource.bin`], { env, encoding: "buffer" });
  assert.deepEqual(finalResource.stdout, resource);
  const finalFiles = (await git(gitCommand, setup.headMirrorRoot,
    ["ls-tree", "--name-only", "-r", evidence.commit.oid], { env })).stdout.split("\n");
  assert.ok(finalFiles.includes("src/base-added.txt"));
  assert.ok(finalFiles.includes("src/head-added.txt"));
  assert.equal(finalFiles.includes("src/removed.txt"), false);
  assert.ok(finalFiles.includes("src/rename-after.txt"));
  assert.equal(finalFiles.includes("src/rename-before.txt"), false);
  const changedResource = createChangePackage({ ...draft, modified: [{ path: "resource.bin", beforeSha256: sha256(resource), content: Buffer.from("unauthorized") }] });
  await assert.rejects(restarted.commitBuilder.create({ ...request, manifest: changedResource.manifest,
    blobs: changedResource.blobs.map(({ sha256, content }) => ({ sha256, content })) }),
  error => error.code === "INVALID_CONTROLLED_GIT_REQUEST");
  const sealedResource = path.join(setup.preparationRoot, "preparations",
    source.preparationBinding.preparationId, "blobs", `${sha256(resource)}.blob`);
  await writeFile(sealedResource, Buffer.alloc(resource.length));
  await assert.rejects(bundle.preparer.prepare(inputBinding(setup)),
    error => error.code === "CONTROLLED_GIT_PREPARATION_TAMPERED");
  await assert.rejects(restarted.preparer.prepare(inputBinding(setup)),
    error => error.code === "CONTROLLED_GIT_PREPARATION_TAMPERED");
});

for (const sourceKind of ['review_repair', 'ci_repair']) test(`${sourceKind} builds a single-parent Head commit with creation and deletion, and publishes without force`, {
  skip: gitCommand === null ? "trusted Git is unavailable" : false,
}, async (t) => {
  const setup = await createFixture(t, gitCommand);
  const runner = new PublicationProcessRunner();
  const config = { enabled: true, gitCommand, preparationRoot: setup.preparationRoot,
    baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
    headMirrorsByRepository: { "contributor/runtime-test": setup.headMirrorRoot } };
  const bundle = await createControlledGitRuntimeBundle(config, { processRunner: runner });
  const binding = inputBinding(setup);
  const executionSource = sourceKind === 'ci_repair' ? ciRepairSource(binding, ['src'])
    : createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src"] });
  const workspaceRevision = "e".repeat(64);
  const changePackage = createChangePackage({
    job: { id: "review-repair-job", revision: 3, recordDigest: "3".repeat(64) },
    proposal: { id: "review-repair-proposal", contentDigest: "4".repeat(64) },
    grant: { digest: "5".repeat(64) },
    workspace: { id: "runtime-workspace", sourceRevision: "d".repeat(64), workspaceRevision },
    passedProfiles: [passedProfile(workspaceRevision)],
    created: [{ path: "src/regression.txt", content: Buffer.from("regression test\n") }],
    modified: [{ path: "src/conflict.txt", beforeSha256: sha256(Buffer.from("head content\n")), content: Buffer.from("review repaired\n") }],
    deleted: [{ path: "src/untouched.txt", beforeSha256: sha256(Buffer.from("common file\n")) }],
  });
  const request = { executionSource, manifest: changePackage.manifest,
    blobs: changePackage.blobs.map(({ sha256, content }) => ({ sha256, content })), createdAt: "2026-10-10T08:00:00.000Z" };
  const immutableBefore = await Promise.all([directorySnapshot(setup.sourceRoot), directorySnapshot(setup.baseMirrorRoot), directorySnapshot(setup.headMirrorRoot)]);
  const evidence = await bundle.commitBuilder.create(request);
  assert.deepEqual(evidence.commit.parents, [setup.headOid]);
  assert.equal(Object.hasOwn(evidence.resolution, "preparationId"), false);
  const objectDirectory = path.join(setup.preparationRoot, "commits", evidence.evidenceId, "objects");
  const env = { ...process.env, GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(setup.headMirrorRoot, "objects"), GIT_NO_REPLACE_OBJECTS: "1" };
  assert.equal((await git(gitCommand, setup.headMirrorRoot, ["show", `${evidence.commit.oid}:src/conflict.txt`], { env })).stdout, "review repaired\n");
  assert.equal((await git(gitCommand, setup.headMirrorRoot, ["show", `${evidence.commit.oid}:src/regression.txt`], { env })).stdout, "regression test\n");
  await assert.rejects(git(gitCommand, setup.headMirrorRoot, ["show", `${evidence.commit.oid}:src/untouched.txt`], { env }));
  assert.deepEqual(await bundle.commitBuilder.verify({ evidenceId: evidence.evidenceId }), evidence);
  runner.remoteHead = "f".repeat(40);
  const publication = { credential: "test-review-repair-credential", actorAccountId: binding.gitTarget.sourceAccountId,
    repository: binding.repository, pullRequestNumber: binding.pullRequestNumber,
    marker: `<!-- mydashboard-action:v1:${"a".repeat(64)} -->`,
    action: { type: "pull_request_push", expectedOldOid: setup.headOid,
      remote: { repository: binding.gitTarget.headRepository, refName: binding.gitTarget.headRefName },
      controlledCommitEvidence: evidence, inputBinding: binding } };
  assert.deepEqual(await bundle.publisher.publish(publication), { status: "stale" });
  assert.equal(runner.pushCount, 0);
  runner.remoteHead = setup.headOid;
  assert.equal((await bundle.publisher.publish(publication)).status, "applied");
  assert.equal(runner.publicationCalls.find(({ operation }) => operation === "push").args.some((arg) => arg.startsWith("--force")), false);
  const restarted = await createControlledGitRuntimeBundle(config, { processRunner: runner });
  assert.equal((await restarted.publisher.publish(publication)).status, "already");
  assert.equal(runner.pushCount, 1);
  assert.deepEqual(await Promise.all([directorySnapshot(setup.sourceRoot), directorySnapshot(setup.baseMirrorRoot), directorySnapshot(setup.headMirrorRoot)]), immutableBefore);
  const wrongManifest = createChangePackage({
    job: changePackage.manifest.job, proposal: changePackage.manifest.proposal, grant: changePackage.manifest.grant,
    workspace: changePackage.manifest.workspace, passedProfiles: changePackage.manifest.passedProfiles,
    created: [], deleted: [], modified: [{ path: "src/conflict.txt", beforeSha256: "0".repeat(64), content: Buffer.from("wrong\n") }],
  });
  await assert.rejects(bundle.commitBuilder.create({ ...request, manifest: wrongManifest.manifest,
    blobs: wrongManifest.blobs.map(({ sha256, content }) => ({ sha256, content })) }),
    (error) => error.code === "CONTROLLED_GIT_CHANGE_PACKAGE_MISMATCH");
});

test("sealed controlled commits remain verifiable after their objects are fetched into an alternate mirror", {
  skip: gitCommand === null ? "trusted Git is unavailable" : false,
}, async (t) => {
  const setup = await createFixture(t, gitCommand);
  const config = { enabled: true, gitCommand, preparationRoot: setup.preparationRoot,
    baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
    headMirrorsByRepository: { "contributor/runtime-test": setup.headMirrorRoot } };
  const bundle = await createControlledGitRuntimeBundle(config);
  const executionSource = createReviewRepairCodeExecutionSource({ inputBinding: inputBinding(setup), writablePaths: ["src"] });
  const workspaceRevision = "e".repeat(64);
  const changePackage = createChangePackage({
    job: { id: "review-repair-job", revision: 3, recordDigest: "3".repeat(64) },
    proposal: { id: "review-repair-proposal", contentDigest: "4".repeat(64) }, grant: { digest: "5".repeat(64) },
    workspace: { id: "runtime-workspace", sourceRevision: "d".repeat(64), workspaceRevision },
    passedProfiles: [passedProfile(workspaceRevision)], created: [], deleted: [],
    modified: [{ path: "src/conflict.txt", beforeSha256: sha256(Buffer.from("head content\n")), content: Buffer.from("review repaired\n") }],
  });
  const evidence = await bundle.commitBuilder.create({ executionSource, manifest: changePackage.manifest,
    blobs: changePackage.blobs.map(({ sha256, content }) => ({ sha256, content })), createdAt: "2026-10-10T08:00:00.000Z" });
  const sealedRoot = path.join(setup.preparationRoot, "commits", evidence.evidenceId);
  const sealedBefore = await directorySnapshot(sealedRoot);
  const published = path.join(setup.root, "published.git");
  await git(gitCommand, setup.root, ["init", "--bare", published]);
  await cp(path.join(setup.headMirrorRoot, "objects"), path.join(published, "objects"), { recursive: true });
  await cp(path.join(sealedRoot, "objects"), path.join(published, "objects"), { recursive: true });
  await git(gitCommand, published, ["update-ref", "refs/heads/repair", evidence.commit.oid]);
  await git(gitCommand, setup.headMirrorRoot, ["-c", "protocol.file.allow=always", "fetch", "--no-write-fetch-head",
    "--no-tags", "--no-auto-maintenance", "--refmap=", published, "refs/heads/repair"]);
  assert.equal((await git(gitCommand, setup.headMirrorRoot, ["cat-file", "-t", evidence.commit.oid])).stdout.trim(), "commit");
  const mirrorsBefore = await Promise.all([setup.baseMirrorRoot, setup.headMirrorRoot].map(root => directorySnapshot(root, { metadata: true })));
  assert.deepEqual(await bundle.commitBuilder.verify({ evidenceId: evidence.evidenceId }), evidence);
  const restarted = await createControlledGitRuntimeBundle(config);
  assert.deepEqual(await restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }), evidence);
  assert.deepEqual(await directorySnapshot(sealedRoot), sealedBefore);
  assert.deepEqual(await Promise.all([setup.baseMirrorRoot, setup.headMirrorRoot].map(root => directorySnapshot(root, { metadata: true }))), mirrorsBefore);
  const object = await firstLooseObject(path.join(sealedRoot, "objects"));
  assert.ok(object);
  await chmod(object, 0o600);
  await writeFile(object, Buffer.from("tampered sealed object"));
  await assert.rejects(restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
    error => error.code === "CONTROLLED_GIT_COMMIT_TAMPERED");
});

class MemoryDeliveryStore {
  value = null;

  async read(_key, fallback) {
    return this.value === null
      ? structuredClone(fallback)
      : structuredClone(this.value);
  }

  async write(_key, value) {
    this.value = structuredClone(value);
  }
}

test(
  "default controlled Git runtime prepares, verifies, and materializes a real conflicted PR",
  { skip: gitCommand === null ? "trusted Git is unavailable" : false },
  async (t) => {
    const setup = await createFixture(t, gitCommand);
    const sourceBefore = await repositoryState(gitCommand, setup.sourceRoot);
    const mirrorsBefore = await Promise.all([
      mirrorRefs(gitCommand, setup.baseMirrorRoot),
      mirrorRefs(gitCommand, setup.headMirrorRoot),
    ]);
    const bundle = await createControlledGitRuntimeBundle({
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: { "contributor/runtime-test": setup.headMirrorRoot },
    });
    const binding = inputBinding(setup);

    const source = await bundle.preparer.prepare(binding);
    assert.equal(source.kind, "conflict_preparation");
    assert.deepEqual(source.inputBinding, binding);
    assert.deepEqual(source.writeScope, { mode: "exact_files", paths: ["src/conflict.txt"] });
    assert.equal(source.preparationBinding.gitTarget.headRefOid, setup.headOid);

    const verified = await bundle.verifier.verify(source.preparationBinding);
    assert.deepEqual(verified, source.preparationBinding);

    const originals = await bundle.sourceReader.read(source);
    assert.deepEqual(originals.inputBinding, binding);
    assert.deepEqual(originals.preparationBinding, source.preparationBinding);
    assert.deepEqual(originals.documents.map(({ path, version }) => ({ path, version })),
      ["ancestor", "head", "base"].map(version => ({ path: "src/conflict.txt", version })));
    assert.equal(originals.documents.find(({ version }) => version === "head").content, "head content\n");
    assert.equal(originals.documents.find(({ version }) => version === "base").content, "base content\n");

    const targetRoot = path.join(path.dirname(setup.preparationRoot), "materialized");
    await mkdir(targetRoot);
    const receipt = await bundle.materializer.materialize({
      binding: source.preparationBinding,
      targetRoot,
      excludePaths: [],
    });
    const conflictPath = path.join(targetRoot, "src", "conflict.txt");
    const conflictContent = await readFile(conflictPath, "utf8");
    assert.equal(receipt.preparationId, source.preparationBinding.preparationId);
    assert.equal(receipt.resultTreeOid, source.preparationBinding.resultTreeOid);
    assert.equal(receipt.evidenceDigest, source.preparationBinding.evidenceDigest);
    assert.equal(receipt.fileCount, 2);
    assert.deepEqual(receipt.files.map((file) => file.path).sort(), ["src/conflict.txt", "src/untouched.txt"]);
    assert.match(conflictContent, /^<<<<<<< /mu);
    assert.match(conflictContent, /head content/u);
    assert.match(conflictContent, /base content/u);
    assert.equal(await readFile(path.join(targetRoot, "src", "untouched.txt"), "utf8"), "common file\n");
    assert.deepEqual(source.writeScope.paths, ["src/conflict.txt"]);
    assert.deepEqual(await repositoryState(gitCommand, setup.sourceRoot), sourceBefore);
    assert.deepEqual(await Promise.all([
      mirrorRefs(gitCommand, setup.baseMirrorRoot),
      mirrorRefs(gitCommand, setup.headMirrorRoot),
    ]), mirrorsBefore);
  },
);

test(
  "controlled commit builder seals one deterministic merge commit without mutating source, mirrors, or preparation",
  { skip: gitCommand === null ? "trusted Git is unavailable" : false },
  async (t) => {
    const setup = await createFixture(t, gitCommand);
    const runner = new RecordingProcessRunner();
    const bundle = await createControlledGitRuntimeBundle({
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: {
        "contributor/runtime-test": setup.headMirrorRoot,
      },
    }, { processRunner: runner });
    const source = await bundle.preparer.prepare(inputBinding(setup));
    const materializedRoot = path.join(setup.root, "materialized-for-commit");
    await mkdir(materializedRoot);
    await bundle.materializer.materialize({
      binding: source.preparationBinding,
      targetRoot: materializedRoot,
      excludePaths: [],
    });
    const conflictPath = path.join(materializedRoot, "src", "conflict.txt");
    const conflictedContent = await readFile(conflictPath);
    const resolvedContent = Buffer.from("resolved content from controlled job\n", "utf8");
    const workspaceRevision = "e".repeat(64);
    const packageDraft = {
      job: {
        id: "code-job-runtime-integration",
        revision: 3,
        recordDigest: "3".repeat(64),
      },
      proposal: {
        id: "proposal-runtime-integration",
        contentDigest: "4".repeat(64),
      },
      grant: { digest: "5".repeat(64) },
      workspace: {
        id: "runtime-workspace",
        sourceRevision: "d".repeat(64),
        workspaceRevision,
      },
      passedProfiles: [passedProfile(workspaceRevision)],
      created: [],
      modified: [{
        path: "src/conflict.txt",
        beforeSha256: sha256(conflictedContent),
        content: resolvedContent,
      }],
      deleted: [],
    };
    const changePackage = createChangePackage(packageDraft);
    const request = {
      executionSource: source,
      manifest: changePackage.manifest,
      blobs: changePackage.blobs.map(({ sha256: digest, content }) => ({
        sha256: digest,
        content,
      })),
      createdAt: "2026-08-08T08:09:10.111Z",
    };
    const preparationSeal = path.join(
      setup.preparationRoot,
      "preparations",
      source.preparationBinding.preparationId,
    );
    const [sourceBefore, baseMirrorBefore, headMirrorBefore,
      preparationBefore, materializedBefore] = await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
    ]);

    const firstBuilderCall = runner.calls.length;
    const evidence = await bundle.commitBuilder.create(request);
    const builderCalls = runner.calls.slice(firstBuilderCall).filter(
      ({ cwd }) => cwd.includes(".controlled-git-commit-scratch-"),
    );
    const allowedCommands = new Set([
      "read-tree",
      "hash-object",
      "update-index",
      "write-tree",
      "commit-tree",
      "ls-tree",
      "pack-objects",
      "index-pack",
    ]);
    const commandNames = builderCalls.map(({ args }) =>
      args.find((argument) => allowedCommands.has(argument)));
    assert.deepEqual(commandNames, [
      "ls-tree",
      "pack-objects",
      "index-pack",
      "read-tree",
      "hash-object",
      "update-index",
      "write-tree",
      "commit-tree",
    ]);
    assert.equal(
      builderCalls.every(({ args }) =>
        args.filter((argument) => allowedCommands.has(argument)).length === 1),
      true,
    );
    assert.deepEqual(evidence.commit.parents, [setup.headOid, setup.baseOid]);
    assert.equal(evidence.commit.treeOid, evidence.resolution.finalTreeOid);
    assert.deepEqual(evidence.resolution.resolvedPaths, ["src/conflict.txt"]);
    assert.deepEqual(
      await bundle.commitBuilder.find({
        executionSource: request.executionSource,
        manifest: request.manifest,
        createdAt: request.createdAt,
      }),
      evidence,
    );

    const repeated = await bundle.commitBuilder.create(request);
    assert.equal(repeated.evidenceId, evidence.evidenceId);
    assert.equal(repeated.commit.oid, evidence.commit.oid);
    assert.deepEqual(
      await bundle.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      evidence,
    );

    const commitRoot = path.join(
      setup.preparationRoot,
      "commits",
      evidence.evidenceId,
    );
    const commitObjects = path.join(commitRoot, "objects");
    const commitEnvironment = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        path.join(preparationSeal, "objects"),
        path.join(setup.baseMirrorRoot, "objects"),
        path.join(setup.headMirrorRoot, "objects"),
      ].join(path.delimiter),
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OBJECT_DIRECTORY: commitObjects,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    };
    const commitText = (
      await git(
        gitCommand,
        setup.root,
        [
          `--git-dir=${setup.baseMirrorRoot}`,
          "cat-file",
          "commit",
          evidence.commit.oid,
        ],
        { env: commitEnvironment },
      )
    ).stdout;
    assert.match(commitText, new RegExp(
      `^tree ${evidence.commit.treeOid}\\n` +
      `parent ${setup.headOid}\\n` +
      `parent ${setup.baseOid}\\n`,
      "u",
    ));
    const resolvedTreeContent = (
      await git(
        gitCommand,
        setup.root,
        [
          `--git-dir=${setup.baseMirrorRoot}`,
          "cat-file",
          "blob",
          `${evidence.commit.treeOid}:src/conflict.txt`,
        ],
        { env: commitEnvironment, encoding: "buffer" },
      )
    ).stdout;
    assert.deepEqual(Buffer.from(resolvedTreeContent), resolvedContent);

    assert.deepEqual(await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
    ]), [
      sourceBefore,
      baseMirrorBefore,
      headMirrorBefore,
      preparationBefore,
      materializedBefore,
    ]);

    const orphanScratch = path.join(
      setup.preparationRoot,
      ".controlled-git-commit-scratch-orphan",
    );
    await mkdir(orphanScratch);
    await writeFile(path.join(orphanScratch, "partial"), "crash residue");
    const restartRunner = new RecordingProcessRunner();
    const restart = () => createControlledGitRuntimeBundle({
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: {
        "contributor/runtime-test": setup.headMirrorRoot,
      },
    }, { processRunner: restartRunner });
    const restarted = await restart();
    assert.equal(restartRunner.calls.length, 0, "startup checks local sealed evidence without rebuilding historical commits");
    await assert.rejects(lstat(orphanScratch), (error) => error?.code === "ENOENT");
    assert.deepEqual(
      await restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      evidence,
    );

    const sealedManifestPath = path.join(commitRoot, "manifest.json");
    const sealedManifest = await readFile(sealedManifestPath);
    const tamperedProfile = {
      ...packageDraft.passedProfiles[0],
      actionId: "action-tampered",
    };
    const tamperedManifest = createChangePackage({
      ...packageDraft,
      passedProfiles: [tamperedProfile],
    }).manifest;
    await writeFile(
      sealedManifestPath,
      `${canonicalJsonStringify(tamperedManifest)}\n`,
    );
    await assert.rejects(
      restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      (error) => error?.code === "CONTROLLED_GIT_COMMIT_TAMPERED",
    );
    await writeFile(sealedManifestPath, sealedManifest);
    assert.deepEqual(
      await restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      evidence,
    );

    const growthFile = path.join(setup.root, "later-mirror-object.txt");
    await writeFile(growthFile, "a later independent Git fetch adds this object\n");
    await git(gitCommand, setup.headMirrorRoot, ["hash-object", "-w", growthFile]);
    const grown = await restart();
    assert.deepEqual(await grown.commitBuilder.verify({ evidenceId: evidence.evidenceId }), evidence);

    const tamperedObject = await firstLooseObject(commitObjects);
    await rm(tamperedObject, { force: true });
    await writeFile(tamperedObject, "tampered object");
    await assert.rejects(
      restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      (error) => error?.code === "CONTROLLED_GIT_COMMIT_TAMPERED",
    );
    await assert.rejects(restart(), (error) => error?.cause?.code === "CONTROLLED_GIT_COMMIT_TAMPERED");
  },
);

test(
  "sealed change-package delivery recovers lost commit responses without rebuilding or mutating Git inputs",
  { skip: gitCommand === null ? "trusted Git is unavailable" : false },
  async (t) => {
    const setup = await createFixture(t, gitCommand);
    const runner = new RecordingProcessRunner();
    const bundle = await createControlledGitRuntimeBundle({
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: {
        "contributor/runtime-test": setup.headMirrorRoot,
      },
    }, { processRunner: runner });
    const executionSource = await bundle.preparer.prepare(inputBinding(setup));
    const materializedRoot = path.join(setup.root, "materialized-delivery");
    await mkdir(materializedRoot);
    await bundle.materializer.materialize({
      binding: executionSource.preparationBinding,
      targetRoot: materializedRoot,
      excludePaths: [],
    });
    const conflictPath = path.join(materializedRoot, "src", "conflict.txt");
    const packageDraft = {
      job: {
        id: "code-job-delivery-integration",
        revision: 3,
        recordDigest: "3".repeat(64),
      },
      proposal: {
        id: "proposal-delivery-integration",
        contentDigest: "4".repeat(64),
      },
      grant: { digest: "5".repeat(64) },
      workspace: {
        id: "runtime-workspace",
        sourceRevision: "d".repeat(64),
        workspaceRevision: "e".repeat(64),
      },
      passedProfiles: [passedProfile("e".repeat(64))],
      created: [],
      modified: [{
        path: "src/conflict.txt",
        beforeSha256: sha256(await readFile(conflictPath)),
        content: Buffer.from("resolved through sealed delivery\n", "utf8"),
      }],
      deleted: [],
    };
    const packageStore = new ChangePackageStore({
      root: path.join(setup.root, "change-packages"),
    });
    await packageStore.recover();
    const manifest = await packageStore.producer().create(packageDraft);
    const deliveryStore = new MemoryDeliveryStore();
    const calls = { create: 0, find: 0, verify: 0 };
    let loseCreateResponse = true;
    let loseVerifyResponse = true;
    const controlledCommitBuilder = {
      readSealed: request => bundle.commitBuilder.readSealed(request),
      async create(request) {
        calls.create += 1;
        const evidence = await bundle.commitBuilder.create(request);
        if (loseCreateResponse) {
          loseCreateResponse = false;
          throw new Error("real create response lost");
        }
        return evidence;
      },
      async find(request) {
        calls.find += 1;
        return bundle.commitBuilder.find(request);
      },
      async verify(request) {
        calls.verify += 1;
        const evidence = await bundle.commitBuilder.verify(request);
        if (loseVerifyResponse) {
          loseVerifyResponse = false;
          throw new Error("real verify response lost");
        }
        return evidence;
      },
    };
    const serviceOptions = {
      packageReader: packageStore.reader(),
      controlledCommitBuilder,
      store: deliveryStore,
      exclusiveLease: { async run(operation) { return operation(); } },
    };
    const service = new ChangePackageControlledCommitService(serviceOptions);
    await service.recover();
    const eventDigest = "6".repeat(64);
    const request = {
      eventId: `code-job-change-package-event-${eventDigest}`,
      eventDigest,
      packageId: manifest.packageId,
      packageDigest: manifest.packageDigest,
      executionSource,
      recordedAt: "2026-08-08T08:09:10.111Z",
    };
    const preparationSeal = path.join(
      setup.preparationRoot,
      "preparations",
      executionSource.preparationBinding.preparationId,
    );
    const before = await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
    ]);

    await assert.rejects(
      service.delivery().deliver(request),
      /real verify response lost/,
    );
    assert.equal(deliveryStore.value.deliveries[0].status, "evidence");
    assert.equal(calls.create, 1);

    const restarted = new ChangePackageControlledCommitService(serviceOptions);
    assert.deepEqual(await restarted.recover(), {
      deliveries: 1,
      committed: 1,
      pending: 0,
    });
    const receipt = await restarted.delivery().deliver(request);
    assert.equal(receipt.recordedAt, request.recordedAt);
    assert.match(receipt.evidenceId, /^controlled-git-commit-[a-f0-9]{64}$/u);
    assert.match(receipt.evidenceDigest, /^[a-f0-9]{64}$/u);
    assert.match(receipt.commitOid, /^[a-f0-9]{40}$/u);
    assert.equal(calls.create, 1);
    assert.ok(calls.find >= 2);
    assert.ok(calls.verify >= 2);
    const gitCallsBeforeLocalRecovery = runner.calls.length;
    const localRestart = new ChangePackageControlledCommitService(serviceOptions);
    assert.deepEqual(await localRestart.recover(), { deliveries: 1, committed: 1, pending: 0 });
    assert.equal(runner.calls.length, gitCallsBeforeLocalRecovery, "committed delivery startup does not rebuild Git history");
    await localRestart.delivery().deliver(request);
    assert.ok(runner.calls.length > gitCallsBeforeLocalRecovery, "delivery still verifies the complete current Git evidence");

    const commitEntries = await readdir(
      path.join(setup.preparationRoot, "commits"),
      { withFileTypes: true },
    );
    assert.deepEqual(
      commitEntries.filter((entry) => entry.isDirectory()).map(({ name }) => name),
      [receipt.evidenceId],
    );
    assert.deepEqual(await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
    ]), before);
    assert.equal(
      runner.calls.some(({ args }) =>
        args.some((argument) => ["fetch", "push", "update-ref"].includes(argument))),
      false,
    );
    const growthFile = path.join(setup.root, "later-delivery-mirror-object.txt");
    await writeFile(growthFile, "independent mirror object growth\n");
    await git(gitCommand, setup.headMirrorRoot, ["hash-object", "-w", growthFile]);
    const stale = new ChangePackageControlledCommitService(serviceOptions);
    assert.deepEqual(await stale.recover(), {
      deliveries: 1, committed: 1, pending: 0,
    });
    assert.deepEqual(await stale.delivery().deliver(request), receipt);
    assert.equal(calls.create, 1);
  },
);

test(
  "sealed publisher uses one exact GitHub lease and proves applied, stale, unknown, restart, and tamper outcomes",
  { skip: gitCommand === null ? "trusted Git is unavailable" : false },
  async (t) => {
    const setup = await createFixture(t, gitCommand);
    const runner = new PublicationProcessRunner();
    const config = {
      enabled: true,
      gitCommand,
      preparationRoot: setup.preparationRoot,
      baseMirrorsByRepository: { "acme/runtime-test": setup.baseMirrorRoot },
      headMirrorsByRepository: {
        "contributor/runtime-test": setup.headMirrorRoot,
      },
    };
    const bundle = await createControlledGitRuntimeBundle(config, {
      processRunner: runner,
    });
    const binding = inputBinding(setup);
    const executionSource = await bundle.preparer.prepare(binding);
    const materializedRoot = path.join(setup.root, "materialized-for-publish");
    await mkdir(materializedRoot);
    await bundle.materializer.materialize({
      binding: executionSource.preparationBinding,
      targetRoot: materializedRoot,
      excludePaths: [],
    });
    const conflictPath = path.join(materializedRoot, "src", "conflict.txt");
    const workspaceRevision = "e".repeat(64);
    const changePackage = createChangePackage({
      job: {
        id: "code-job-publication-integration",
        revision: 3,
        recordDigest: "3".repeat(64),
      },
      proposal: {
        id: "proposal-publication-integration",
        contentDigest: "4".repeat(64),
      },
      grant: { digest: "5".repeat(64) },
      workspace: {
        id: "runtime-workspace",
        sourceRevision: "d".repeat(64),
        workspaceRevision,
      },
      passedProfiles: [passedProfile(workspaceRevision)],
      created: [],
      modified: [{
        path: "src/conflict.txt",
        beforeSha256: sha256(await readFile(conflictPath)),
        content: Buffer.from("resolved for sealed publication\n", "utf8"),
      }],
      deleted: [],
    });
    const evidence = await bundle.commitBuilder.create({
      executionSource,
      manifest: changePackage.manifest,
      blobs: changePackage.blobs.map(({ sha256: digest, content }) => ({
        sha256: digest,
        content,
      })),
      createdAt: "2026-08-08T10:11:12.123Z",
    });
    const credential = "github_pat_secret-do-not-leak";
    const action = {
      type: "pull_request_push",
      expectedOldOid: setup.headOid,
      remote: {
        repository: binding.gitTarget.headRepository,
        refName: binding.gitTarget.headRefName,
      },
      controlledCommitEvidence: evidence,
      inputBinding: binding,
    };
    const request = {
      credential,
      actorAccountId: binding.gitTarget.sourceAccountId,
      repository: binding.repository,
      pullRequestNumber: binding.pullRequestNumber,
      marker: `<!-- mydashboard-action:v1:${"a".repeat(64)} -->`,
      action,
    };
    const preparationSeal = path.join(
      setup.preparationRoot,
      "preparations",
      executionSource.preparationBinding.preparationId,
    );
    const immutableBefore = await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
      directorySnapshot(setup.preparationRoot),
    ]);

    await assert.rejects(
      bundle.publisher.publish({ ...request, extra: true }),
      (error) => error?.code === "INVALID_CONTROLLED_GIT_PUBLISH_REQUEST",
    );
    assert.equal(runner.publicationCalls.length, 0);

    runner.remoteHead = "f".repeat(40);
    const stale = await bundle.publisher.publish(request);
    assert.deepEqual(stale, { status: "stale" });
    assert.equal(Object.isFrozen(stale), true);
    assert.equal(runner.pushCount, 0);

    runner.remoteHead = setup.headOid;
    const applied = await bundle.publisher.publish(request);
    assert.deepEqual(applied, {
      status: "applied",
      receipt: { id: evidence.commit.oid },
    });
    assert.equal(Object.isFrozen(applied), true);
    assert.equal(Object.isFrozen(applied.receipt), true);
    assert.equal(runner.pushCount, 1);
    const pushCall = runner.publicationCalls.find(
      ({ operation }) => operation === "push",
    );
    const fullRefName = `refs/heads/${binding.gitTarget.headRefName}`;
    assert.equal(pushCall.command, gitCommand);
    assert.equal(
      pushCall.args.includes(
        `--force-with-lease=${fullRefName}:${setup.headOid}`,
      ),
      true,
    );
    assert.equal(pushCall.args.includes("--no-verify"), true);
    assert.equal(
      pushCall.args.includes(
        `https://github.com/${binding.gitTarget.headRepository}.git`,
      ),
      true,
    );
    assert.equal(
      pushCall.args.at(-1),
      `${evidence.commit.oid}:${fullRefName}`,
    );
    assert.equal(pushCall.args.some((argument) => argument.includes(credential)), false);
    assert.equal(JSON.stringify(pushCall.env).includes(credential), false);
    assert.match(pushCall.env.GIT_CONFIG_VALUE_3, /^AUTHORIZATION: basic /u);
    assert.equal(pushCall.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(pushCall.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(
      JSON.stringify(
        runner.publicationCalls.map(({ env: _environment, ...call }) => call),
      ).includes(credential),
      false,
    );
    assert.equal(JSON.stringify(applied).includes(credential), false);

    const orphanScratch = path.join(
      setup.preparationRoot,
      ".controlled-git-commit-scratch-publish-orphan",
    );
    await mkdir(orphanScratch);
    await writeFile(path.join(orphanScratch, "partial"), "crash residue");
    const restarted = await createControlledGitRuntimeBundle(config, {
      processRunner: runner,
    });
    await assert.rejects(lstat(orphanScratch), (error) => error?.code === "ENOENT");
    const already = await restarted.publisher.publish(request);
    assert.deepEqual(already, {
      status: "already",
      receipt: { id: evidence.commit.oid },
    });
    assert.equal(runner.pushCount, 1);

    runner.remoteHead = setup.headOid;
    runner.publicationMode = "unknown";
    runner.unknownStarted = false;
    const unknown = await restarted.publisher.publish(request);
    assert.deepEqual(unknown, {
      status: "unknown",
      code: "CONTROLLED_GIT_PUBLISH_OUTCOME_UNKNOWN",
    });
    assert.equal(Object.isFrozen(unknown), true);
    assert.equal(runner.pushCount, 2);

    runner.publicationMode = "apply";
    runner.unknownStarted = false;
    runner.remoteHead = setup.headOid;
    const commitObject = await firstLooseObject(path.join(
      setup.preparationRoot,
      "commits",
      evidence.evidenceId,
      "objects",
    ));
    const sealedObjectBytes = await readFile(commitObject);
    await rm(commitObject, { force: true });
    await writeFile(commitObject, "tampered publication object");
    const callsBeforeTamper = runner.publicationCalls.length;
    await assert.rejects(
      restarted.publisher.publish(request),
      (error) => error?.code === "CONTROLLED_GIT_COMMIT_TAMPERED",
    );
    assert.equal(runner.publicationCalls.length, callsBeforeTamper);
    await rm(commitObject, { force: true });
    await writeFile(commitObject, sealedObjectBytes);
    assert.deepEqual(
      await restarted.commitBuilder.verify({ evidenceId: evidence.evidenceId }),
      evidence,
    );

    assert.deepEqual(await Promise.all([
      directorySnapshot(setup.sourceRoot),
      directorySnapshot(setup.baseMirrorRoot),
      directorySnapshot(setup.headMirrorRoot),
      directorySnapshot(preparationSeal),
      directorySnapshot(materializedRoot),
      directorySnapshot(setup.preparationRoot),
    ]), immutableBefore);
  },
);
