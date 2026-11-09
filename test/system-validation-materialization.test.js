import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { isWindowsGitImplementationPath, windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

const execFileAsync = promisify(execFile);

test("Windows Git discovery includes UCRT64 and legacy native implementations without wrappers", () => {
  const candidates = windowsGitImplementationCandidates("C:/Program Files/Git/cmd/git.exe");
  assert.deepEqual(candidates, [
    "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    "C:\\Program Files\\Git\\mingw32\\bin\\git.exe",
  ]);
  assert.deepEqual(windowsGitImplementationCandidates(candidates[0]), candidates);
  for (const candidate of candidates) assert.equal(isWindowsGitImplementationPath(candidate), true);
  for (const rejected of ["C:/Program Files/Git/cmd/git.exe", "C:/Program Files/Git/bin/git.exe",
    "tools/ucrt64/bin/git.exe", "//server/share/ucrt64/bin/git.exe", "C:/Git/ucrt64/bin/git.exe\0"])
    assert.equal(isWindowsGitImplementationPath(rejected), false, rejected);
});

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "validation-materialization-repo-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/app.js"), "export const value = 'committed';\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "validation-materialization-fixture",
    private: true,
    type: "module",
    files: ["src/"],
  }, null, 2)}\n`);
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "validation-materialization-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "validation-materialization-fixture",
      },
    },
  }, null, 2)}\n`);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "materialization@example.invalid");
  await git(root, "config", "user.name", "Materialization Fixture");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return {
    root,
    headOid: await git(root, "rev-parse", "--verify", "HEAD^{commit}"),
    treeOid: await git(root, "rev-parse", "--verify", "HEAD^{tree}"),
  };
}

async function loadMaterialization() {
  try {
    return await import("../scripts/system-validation-materialization.mjs");
  } catch (error) {
    assert.fail(`validation materialization module is unavailable: ${error.message}`);
  }
}

async function isolatedEnvironment(t) {
  const { prepareIsolatedValidationEnvironment } = await import(
    "../scripts/system-validation-environment.mjs"
  );
  const context = await prepareIsolatedValidationEnvironment();
  t.after(() => context.cleanup());
  return {
    environment: context.environment,
    dependencyCacheDirectory: context.dependencyCacheDirectory,
  };
}

test("materializes and seals the exact committed validation source", async (t) => {
  const setup = await fixture(t);
  await writeFile(
    path.join(setup.root, "src/app.js"),
    "export const value = 'transient worktree';\n",
  );
  const { createValidationSourceMaterialization } = await loadMaterialization();
  const materialization = await createValidationSourceMaterialization({
    ...setup,
    ...await isolatedEnvironment(t),
  });
  t.after(() => materialization.cleanup());

  assert.equal(
    await readFile(path.join(materialization.directory, "src/app.js"), "utf8"),
    "export const value = 'committed';\n",
  );
  assert.deepEqual(
    Object.keys(materialization.identity).sort(),
    [
      "contentDigest",
      "dependencyInstallation",
      "dependencyLockDigest",
      "fileCount",
      "headOid",
      "schemaVersion",
      "sealed",
      "totalBytes",
      "treeOid",
    ],
  );
  assert.equal(materialization.identity.headOid, setup.headOid);
  assert.equal(materialization.identity.treeOid, setup.treeOid);
  assert.equal(materialization.identity.sealed, true);
  assert.match(materialization.identity.contentDigest, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    writeFile(path.join(materialization.directory, "src/app.js"), "changed\n"),
  );
  await materialization.verify();
});

test("dependency materialization ignores untracked host node_modules", async (t) => {
  const setup = await fixture(t);
  const hostDependency = path.join(
    setup.root,
    "node_modules/playwright/host-only.txt",
  );
  await mkdir(path.dirname(hostDependency), { recursive: true });
  await writeFile(hostDependency, "untrusted host dependency\n");
  const { createValidationSourceMaterialization } = await loadMaterialization();
  const materialization = await createValidationSourceMaterialization({
    ...setup,
    ...await isolatedEnvironment(t),
  });
  t.after(() => materialization.cleanup());

  await assert.rejects(
    readFile(path.join(
      materialization.directory,
      "node_modules/playwright/host-only.txt",
    )),
    { code: "ENOENT" },
  );
  assert.equal(
    materialization.identity.dependencyInstallation,
    "npm-ci-offline-ignore-scripts-v1",
  );
  assert.match(
    materialization.identity.dependencyLockDigest,
    /^[a-f0-9]{64}$/u,
  );
});

test("rejects a published shrinkwrap that differs from the checkout lock", async (t) => {
  const setup = await fixture(t);
  const lock = JSON.parse(
    await readFile(path.join(setup.root, "package-lock.json"), "utf8"),
  );
  lock.packages[""].name = "different-published-dependencies";
  await writeFile(
    path.join(setup.root, "npm-shrinkwrap.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await git(setup.root, "add", "npm-shrinkwrap.json");
  await git(setup.root, "commit", "--quiet", "-m", "divergent shrinkwrap");
  setup.headOid = await git(
    setup.root,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  );
  setup.treeOid = await git(
    setup.root,
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  );
  const { createValidationSourceMaterialization } = await loadMaterialization();

  await assert.rejects(
    createValidationSourceMaterialization({
      ...setup,
      ...await isolatedEnvironment(t),
    }),
    /published dependency lock differs from the checkout lock/u,
  );
});

test("detects a validation source changed after sealing", async (t) => {
  const setup = await fixture(t);
  const { createValidationSourceMaterialization } = await loadMaterialization();
  const materialization = await createValidationSourceMaterialization({
    ...setup,
    ...await isolatedEnvironment(t),
  });
  t.after(() => materialization.cleanup());
  const file = path.join(materialization.directory, "src/app.js");
  await chmod(file, 0o644);
  await writeFile(file, "export const value = 'tampered';\n");

  await assert.rejects(
    materialization.verify(),
    /immutable validation source changed/u,
  );
});

test("derives packaged runtime identity from committed bytes", async (t) => {
  const setup = await fixture(t);
  const { computeRuntimeSourceIdentity } = await import(
    "../src/lib/runtime-source-identity.js"
  );
  const expected = await computeRuntimeSourceIdentity(setup.root);
  await writeFile(
    path.join(setup.root, "src/app.js"),
    "export const value = 'dirty worktree';\n",
  );
  const { deriveCommittedRuntimeSourceIdentity } =
    await loadMaterialization();

  assert.deepEqual(
    await deriveCommittedRuntimeSourceIdentity(setup),
    {
      schemaVersion: 1,
      headOid: setup.headOid,
      treeOid: setup.treeOid,
      clean: true,
      runtimeDigest: expected.digest,
      runtimeFileCount: expected.fileCount,
      runtimeByteCount: expected.byteCount,
    },
  );
});
