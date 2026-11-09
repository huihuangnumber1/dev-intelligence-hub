import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

import { GitBareMirrorInspector } from "../src/adapters/git-bare-mirror-inspector.js";
import {
  createConflictPreparationBinding,
} from "../src/domain/conflict-preparation-binding.js";
import {
  ControlledGitService,
  ControlledGitServiceError,
} from "../src/services/controlled-git-service.js";

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
  return execFile(gitCommand, args, {
    cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSnapshot(root) {
  const files = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const stats = await lstat(absolutePath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await visit(relativePath);
        continue;
      }
      assert.equal(stats.isFile(), true, `unexpected non-file: ${relativePath}`);
      const content = await readFile(absolutePath);
      files.push({
        path: relativePath,
        bytes: content.length,
        mode: stats.mode & 0o7777,
        sha256: hashBytes(content),
      });
    }
  }
  await visit("");
  return files;
}

async function preparationSnapshot(root) {
  const entries = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const target = path.join(root, ...relativePath.split("/"));
      if (child.isDirectory()) {
        if (relativePath !== "preparations") entries.push(`directory:${relativePath}`);
        await visit(relativePath);
        continue;
      }
      assert.equal(child.isFile(), true, `unexpected preparation entry: ${relativePath}`);
      entries.push(`file:${relativePath}:${hashBytes(await readFile(target))}`);
    }
  }
  await visit("");
  return entries;
}

async function refsSnapshot(gitCommand, mirrorRoot) {
  return (
    await git(gitCommand, mirrorRoot, [
      "--git-dir=.",
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ])
  ).stdout;
}

async function findLooseObject(preparationRoot, oid) {
  const directoryName = oid.slice(0, 2);
  const fileName = oid.slice(2);
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        entry.isFile() &&
        entry.name === fileName &&
        path.basename(directory) === directoryName
      ) {
        matches.push(target);
      }
    }
  }
  await visit(preparationRoot);
  assert.equal(matches.length, 1, "one persisted loose result-tree object is required");
  return matches[0];
}

async function resultTreeFile(gitCommand, setup, objectRoot, treeOid, filePath) {
  return (
    await git(
      gitCommand,
      setup.root,
      [
        `--git-dir=${setup.baseMirrorRoot}`,
        "--no-replace-objects",
        "cat-file",
        "blob",
        `${treeOid}:${filePath}`,
      ],
      {
        env: {
          GIT_ALTERNATE_OBJECT_DIRECTORIES: [
            path.join(setup.baseMirrorRoot, "objects"),
            path.join(setup.headMirrorRoot, "objects"),
          ].join(path.delimiter),
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OBJECT_DIRECTORY: objectRoot,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C",
          LC_ALL: "C",
        },
      },
    )
  ).stdout;
}

async function workspaceFiles(root) {
  const files = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.notEqual(entry.name.toLowerCase(), ".git");
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else {
        assert.equal(entry.isFile(), true);
        files.push(relativePath);
      }
    }
  }
  await visit("");
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function createRepositoryFixture(t, gitCommand, { binaryConflict = false, oneSidedDirectories = false, deploymentAssets = false, excludedAssets = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-git-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "source");
  const baseMirrorRoot = path.join(root, "base.git");
  const headMirrorRoot = path.join(root, "head.git");
  const preparationRoot = path.join(root, "preparations");
  await Promise.all([mkdir(repositoryRoot), mkdir(preparationRoot)]);
  await git(gitCommand, repositoryRoot, [
    "init",
    "--initial-branch=main",
    "--object-format=sha1",
  ]);
  await git(gitCommand, repositoryRoot, [
    "config",
    "user.name",
    "MyDashboard Test",
  ]);
  await git(gitCommand, repositoryRoot, [
    "config",
    "user.email",
    "mydashboard@example.invalid",
  ]);
  await mkdir(path.join(repositoryRoot, "src"));
  await Promise.all([
    writeFile(
      path.join(repositoryRoot, "src", "conflict.txt"),
      binaryConflict ? Buffer.from([0, 1, 10]) : "共同祖先\n",
    ),
    writeFile(path.join(repositoryRoot, "src", "shared.txt"), "from ancestor\n"),
    writeFile(
      path.join(repositoryRoot, "src", "base-side.txt"),
      "base side at ancestor\n",
    ),
    writeFile(
      path.join(repositoryRoot, "src", "head-side.txt"),
      "head side at ancestor\n",
    ),
  ]);
  if (excludedAssets) {
    await mkdir(path.join(repositoryRoot, "Test/Data"), { recursive: true });
    await writeFile(path.join(repositoryRoot, "Test/Data/sample.mat"), "tracked test fixture\n");
  }
  if (deploymentAssets) {
    await mkdir(path.join(repositoryRoot, 'Projects/Deploy'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'Projects/Deploy/GCL.mat.enc'), Buffer.alloc(5_127_832, 1));
    await writeFile(path.join(repositoryRoot, 'Projects/Deploy/Retina.mat.enc'), Buffer.alloc(4_274_520, 2));
  }
  await git(gitCommand, repositoryRoot, ["add", "--all"]);
  await git(gitCommand, repositoryRoot, ["commit", "-m", "common ancestor"]);
  const ancestorOid = (
    await git(gitCommand, repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await git(gitCommand, repositoryRoot, ["switch", "--create", "feature"]);
  if (oneSidedDirectories) {
    await mkdir(path.join(repositoryRoot, "base-only"));
    await writeFile(path.join(repositoryRoot, "base-only", "common.txt"), "shared addition\n");
  }
  await Promise.all([
    writeFile(
      path.join(repositoryRoot, "src", "conflict.txt"),
      binaryConflict ? Buffer.from([0, 2, 10]) : "head content\n",
    ),
    writeFile(
      path.join(repositoryRoot, "src", "head-side.txt"),
      "changed by head\n",
    ),
  ]);
  await git(gitCommand, repositoryRoot, ["add", "--all"]);
  await git(gitCommand, repositoryRoot, ["commit", "-m", "head changes"]);
  const headOid = (
    await git(gitCommand, repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await git(gitCommand, repositoryRoot, ["switch", "main"]);
  if (oneSidedDirectories) {
    await mkdir(path.join(repositoryRoot, "base-only"));
    await writeFile(path.join(repositoryRoot, "base-only", "common.txt"), "shared addition\n");
    await writeFile(path.join(repositoryRoot, "base-only", "nested.txt"), "base-only tree\n");
  }
  await Promise.all([
    writeFile(
      path.join(repositoryRoot, "src", "conflict.txt"),
      binaryConflict ? Buffer.from([0, 3, 10]) : "base content\n",
    ),
    writeFile(
      path.join(repositoryRoot, "src", "base-side.txt"),
      "changed by base\n",
    ),
  ]);
  await git(gitCommand, repositoryRoot, ["add", "--all"]);
  await git(gitCommand, repositoryRoot, ["commit", "-m", "base changes"]);
  const baseOid = (
    await git(gitCommand, repositoryRoot, ["rev-parse", "HEAD"])
  ).stdout.trim();

  await git(gitCommand, root, [
    "clone",
    "--bare",
    "--no-local",
    "--single-branch",
    "--branch",
    "main",
    repositoryRoot,
    baseMirrorRoot,
  ]);
  await git(gitCommand, root, [
    "clone",
    "--bare",
    "--no-local",
    "--single-branch",
    "--branch",
    "feature",
    repositoryRoot,
    headMirrorRoot,
  ]);

  const request = {
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: baseOid,
      headRepository: "contributor/repo",
      headRefName: "feature",
      headRefOid: headOid,
    },
    baseMirrorRoot,
    headMirrorRoot,
  };
  return {
    root,
    ancestorOid,
    baseMirrorRoot,
    headMirrorRoot,
    preparationRoot,
    request,
  };
}

function serviceFor(gitCommand, setup) {
  return new ControlledGitService({
    gitCommand,
    mirrorInspector: new GitBareMirrorInspector({ gitCommand }),
    preparationRoot: setup.preparationRoot,
  });
}

const gitCommand = locateGit();

test("tracked test data does not block an unrelated text conflict or enter its editable workspace", { skip: gitCommand === null }, async t => {
  const setup = await createRepositoryFixture(t, gitCommand, { excludedAssets: true });
  const service = serviceFor(gitCommand, setup);
  const prepared = await service.inspectConflict(setup.request);
  assert.equal(prepared.status, "conflicted");
  const binding = createConflictPreparationBinding({ preparation: prepared, gitTarget: setup.request.gitTarget });
  const workspace = path.join(setup.root, "workspace"); await mkdir(workspace);
  const receipt = await service.materializeConflictPreparationForCodeJob({ binding, targetRoot: workspace, excludePaths: [] });
  assert.equal(receipt.files.some(entry => entry.path === "Test/Data/sample.mat"), false);
  assert.equal(existsSync(path.join(workspace, "Test/Data/sample.mat")), false);
  assert.match(await readFile(path.join(workspace, "src/conflict.txt"), "utf8"), /<<<<<<< /);
  const resultTreeObject = await findLooseObject(setup.preparationRoot, prepared.resultTreeOid);
  assert.equal(await resultTreeFile(gitCommand, setup,
    path.dirname(path.dirname(resultTreeObject)),
    prepared.resultTreeOid, "Test/Data/sample.mat"), "tracked test fixture\n");
});

test('unchanged deployment assets do not prevent preparing and materializing a text conflict', { skip: gitCommand === null }, async t => {
  const setup = await createRepositoryFixture(t, gitCommand, { deploymentAssets: true });
  const constrained = new ControlledGitService({ gitCommand, mirrorInspector: new GitBareMirrorInspector({ gitCommand }),
    preparationRoot: setup.preparationRoot, limits: { maxBlobBytes: 1_000_000, maxTotalBytes: 8_000_000 } });
  await assert.rejects(constrained.inspectConflict(setup.request), error =>
    ['CONTROLLED_GIT_OUTPUT_LIMIT', 'CONTROLLED_GIT_UNSUPPORTED_TREE'].includes(error.code));
  const prepared = await serviceFor(gitCommand, setup).inspectConflict(setup.request);
  assert.equal(prepared.status, 'conflicted');
  const binding = createConflictPreparationBinding({ preparation: prepared, gitTarget: setup.request.gitTarget });
  const workspace = path.join(setup.root, 'workspace'); await mkdir(workspace);
  await serviceFor(gitCommand, setup).materializeConflictPreparationForCodeJob({ binding, targetRoot: workspace, excludePaths: [] });
  assert.equal((await readFile(path.join(workspace, 'Projects/Deploy/GCL.mat.enc'))).length, 5_127_832);
  assert.equal((await readFile(path.join(workspace, 'Projects/Deploy/Retina.mat.enc'))).length, 4_274_520);
  assert.match(await readFile(path.join(workspace, 'src/conflict.txt'), 'utf8'), /<<<<<<< /);
});

test("merge preparation and repeated verification preserve donor object metadata", { skip: gitCommand === null }, async t => {
  const setup = await createRepositoryFixture(t, gitCommand, { oneSidedDirectories: true });
  for (const root of [setup.baseMirrorRoot, setup.headMirrorRoot]) {
    for (const entry of await readdir(path.join(root, "objects", "pack"))) {
      const file = path.join(root, "objects", "pack", entry);
      await utimes(file, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    }
  }
  const inspector = new GitBareMirrorInspector({ gitCommand });
  const boundaries = () => Promise.all([
    inspector.preflight({ repository: setup.request.gitTarget.baseRepository, mirrorRoot: setup.baseMirrorRoot,
      expectedCommitOid: setup.request.gitTarget.baseRefOid }),
    inspector.preflight({ repository: setup.request.gitTarget.headRepository, mirrorRoot: setup.headMirrorRoot,
      expectedCommitOid: setup.request.gitTarget.headRefOid }),
  ]);
  const before = await boundaries();
  const prepared = await serviceFor(gitCommand, setup).inspectConflict(setup.request);
  const binding = createConflictPreparationBinding({ preparation: prepared, gitTarget: setup.request.gitTarget });
  for (let attempt = 0; attempt < 2; attempt++) {
    await serviceFor(gitCommand, setup).verifyConflictPreparation({ binding });
    assert.deepEqual(await boundaries(), before);
  }
});

test("sealed preparation survives unrelated fetch and repack without rewriting its evidence", { skip: gitCommand === null }, async t => {
  const setup = await createRepositoryFixture(t, gitCommand);
  const prepared = await serviceFor(gitCommand, setup).inspectConflict(setup.request);
  const binding = createConflictPreparationBinding({ preparation: prepared, gitTarget: setup.request.gitTarget });
  const sealedBefore = await preparationSnapshot(setup.preparationRoot);
  const inspector = new GitBareMirrorInspector({ gitCommand });
  const request = { repository: setup.request.gitTarget.baseRepository, mirrorRoot: setup.baseMirrorRoot,
    expectedCommitOid: setup.request.gitTarget.baseRefOid };
  const before = await inspector.preflight(request);
  const repositoryRoot = path.join(setup.root, "source");
  await writeFile(path.join(repositoryRoot, "unrelated.txt"), "another PR's objects\n");
  await git(gitCommand, repositoryRoot, ["add", "unrelated.txt"]);
  await git(gitCommand, repositoryRoot, ["commit", "-m", "unrelated change"]);
  await git(gitCommand, setup.baseMirrorRoot, ["fetch", repositoryRoot, "HEAD:refs/heads/unrelated"]);
  assert.notEqual((await inspector.preflight(request)).boundaryDigest, before.boundaryDigest);
  await serviceFor(gitCommand, setup).verifyConflictPreparation({ binding });
  await git(gitCommand, setup.baseMirrorRoot, ["repack", "-ad"]);
  await serviceFor(gitCommand, setup).verifyConflictPreparation({ binding });
  assert.deepEqual(await preparationSnapshot(setup.preparationRoot), sealedBefore);
});

test(
  "real isolated mirrors produce a durable full conflict workspace without source writes",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const setup = await createRepositoryFixture(t, gitCommand);
    const mirrorFilesBefore = await Promise.all([
      fileSnapshot(setup.baseMirrorRoot),
      fileSnapshot(setup.headMirrorRoot),
    ]);
    const refsBefore = await Promise.all([
      refsSnapshot(gitCommand, setup.baseMirrorRoot),
      refsSnapshot(gitCommand, setup.headMirrorRoot),
    ]);

    const prepared = await serviceFor(gitCommand, setup).inspectConflict(
      setup.request,
    );

    assert.equal(prepared.status, "conflicted");
    assert.equal(prepared.mergeBaseOid, setup.ancestorOid);
    assert.match(prepared.resultObjectDigest, /^[a-f0-9]{64}$/u);
    assert.equal(prepared.materialization, "full-tree");
    const resultTreeObject = await findLooseObject(
      setup.preparationRoot,
      prepared.resultTreeOid,
    );
    const resultObjectRoot = path.dirname(path.dirname(resultTreeObject));
    const resultObjectsBefore = await fileSnapshot(resultObjectRoot);
    const expectedConflict = await resultTreeFile(
      gitCommand,
      setup,
      resultObjectRoot,
      prepared.resultTreeOid,
      "src/conflict.txt",
    );
    const binding = createConflictPreparationBinding({
      preparation: prepared,
      gitTarget: setup.request.gitTarget,
    });

    const restarted = serviceFor(gitCommand, setup);
    const verified = await restarted.verifyConflictPreparation({
      binding,
    });
    assert.equal(verified.resultObjectDigest, prepared.resultObjectDigest);
    assert.equal(verified.materialization, "full-tree");
    assert.deepEqual(await fileSnapshot(resultObjectRoot), resultObjectsBefore);

    const workspaceRoot = path.join(setup.root, "workspace");
    await mkdir(workspaceRoot);
    const receipt = await restarted.materializeConflictPreparationForCodeJob({
      binding,
      targetRoot: workspaceRoot,
      excludePaths: [],
    });
    assert.deepEqual(receipt.binding, binding);
    assert.equal(receipt.materialization, "full-tree");
    assert.equal(receipt.residual, null);
    assert.deepEqual(await workspaceFiles(workspaceRoot), [
      "src/base-side.txt",
      "src/conflict.txt",
      "src/head-side.txt",
      "src/shared.txt",
    ]);
    const conflictContent = await readFile(
      path.join(workspaceRoot, "src", "conflict.txt"),
      "utf8",
    );
    assert.equal(conflictContent, expectedConflict);
    assert.match(conflictContent, /^<<<<<<< /mu);
    assert.match(conflictContent, /^\|\|\|\|\|\|\| /mu);
    assert.match(conflictContent, /^=======$/mu);
    assert.match(conflictContent, /^>>>>>>> /mu);
    assert.match(conflictContent, /head content/u);
    assert.match(conflictContent, /共同祖先/u);
    assert.match(conflictContent, /base content/u);
    assert.equal(
      await readFile(path.join(workspaceRoot, "src", "shared.txt"), "utf8"),
      "from ancestor\n",
    );
    assert.equal(
      await readFile(path.join(workspaceRoot, "src", "base-side.txt"), "utf8"),
      "changed by base\n",
    );
    assert.equal(
      await readFile(path.join(workspaceRoot, "src", "head-side.txt"), "utf8"),
      "changed by head\n",
    );
    assert.deepEqual(await fileSnapshot(resultObjectRoot), resultObjectsBefore);
    assert.deepEqual(
      await Promise.all([
        fileSnapshot(setup.baseMirrorRoot),
        fileSnapshot(setup.headMirrorRoot),
      ]),
      mirrorFilesBefore,
    );
    assert.deepEqual(
      await Promise.all([
        refsSnapshot(gitCommand, setup.baseMirrorRoot),
        refsSnapshot(gitCommand, setup.headMirrorRoot),
      ]),
      refsBefore,
    );
  },
);

test(
  "restart verification rejects a missing persisted result object",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const setup = await createRepositoryFixture(t, gitCommand);
    const prepared = await serviceFor(gitCommand, setup).inspectConflict(
      setup.request,
    );
    const resultTreeObject = await findLooseObject(
      setup.preparationRoot,
      prepared.resultTreeOid,
    );
    await unlink(resultTreeObject);

    await assert.rejects(
      serviceFor(gitCommand, setup).verifyPreparation({
        preparationId: prepared.preparationId,
      }),
      (error) =>
        error instanceof ControlledGitServiceError &&
        error.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
    );
  },
);

test(
  "real Git binary both-modified conflicts are rejected without mirror writes",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const setup = await createRepositoryFixture(t, gitCommand, {
      binaryConflict: true,
    });
    const mirrorFilesBefore = await Promise.all([
      fileSnapshot(setup.baseMirrorRoot),
      fileSnapshot(setup.headMirrorRoot),
    ]);
    const preparationsBefore = await preparationSnapshot(setup.preparationRoot);

    await assert.rejects(
      serviceFor(gitCommand, setup).inspectConflict(setup.request),
      (error) =>
        error instanceof ControlledGitServiceError &&
        error.code === "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
    );
    assert.deepEqual(
      await Promise.all([
        fileSnapshot(setup.baseMirrorRoot),
        fileSnapshot(setup.headMirrorRoot),
      ]),
      mirrorFilesBefore,
    );
    assert.deepEqual(
      await preparationSnapshot(setup.preparationRoot),
      preparationsBefore,
    );
  },
);
