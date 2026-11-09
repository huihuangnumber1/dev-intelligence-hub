import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

import {
  GitBareMirrorInspector,
  GitBareMirrorInspectorError,
} from "../src/adapters/git-bare-mirror-inspector.js";

const SHA1_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const execFile = promisify(execFileCallback);
const SAFE_PREFIX = [
  "--no-lazy-fetch",
  "--no-pager",
  "--no-replace-objects",
  "--git-dir=.",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.commitGraph=false",
];

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "git-bare-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mirrorRoot = path.join(root, "acme-repo.git");
  await mkdir(path.join(mirrorRoot, "objects", "info"), { recursive: true });
  await mkdir(path.join(mirrorRoot, "objects", "pack"), { recursive: true });
  await writeFile(
    path.join(mirrorRoot, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
  );

  const gitCommand = process.platform === "win32"
    ? path.join(root, "mingw64", "bin", "git.exe")
    : path.join(root, "bin", "git");
  await mkdir(path.dirname(gitCommand), { recursive: true });
  await writeFile(gitCommand, "trusted fake git executable\n");
  if (process.platform !== "win32") await chmod(gitCommand, 0o755);

  return {
    root,
    mirrorRoot: path.resolve(mirrorRoot),
    objectDirectory: path.resolve(mirrorRoot, "objects"),
    gitCommand: path.resolve(gitCommand),
  };
}

function result(stdout = "", overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    truncated: false,
    ...overrides,
  };
}

function commandTail(args) {
  assert.deepEqual(args.slice(0, SAFE_PREFIX.length), SAFE_PREFIX);
  return args.slice(SAFE_PREFIX.length);
}

function fakeRunner(
  fixtureValue,
  {
    objectFormat = "sha1",
    configuration = "core.bare\0",
    bare = "true",
    commitAvailable = true,
    commitType = "commit",
    onRun = null,
  } = {},
) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(structuredClone(request));
      const tail = request.args.slice(SAFE_PREFIX.length);
      await onRun?.({ request, tail, callCount: calls.length });
      if (tail[0] === "config") return result(configuration);
      if (tail.includes("--is-bare-repository")) return result(bare);
      if (tail.includes("--show-object-format")) return result(objectFormat);
      if (tail.includes("--absolute-git-dir")) {
        return result(fixtureValue.mirrorRoot);
      }
      if (tail.includes("--git-common-dir")) {
        return result(fixtureValue.mirrorRoot);
      }
      if (tail.includes("--git-path")) {
        return result(fixtureValue.objectDirectory);
      }
      if (tail[0] === "cat-file" && tail[1] === "-e") {
        return commitAvailable ? result() : result("", { exitCode: 1 });
      }
      if (tail[0] === "cat-file" && tail[1] === "-t") {
        return commitAvailable
          ? result(commitType)
          : result("", { exitCode: 1 });
      }
      throw new Error(`unexpected Git command: ${tail.join(" ")}`);
    },
  };
}

function request(mirrorRoot, overrides = {}) {
  return {
    repository: "acme/repo",
    mirrorRoot,
    expectedCommitOid: SHA1_COMMIT,
    ...overrides,
  };
}

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

async function git(gitCommand, cwd, args) {
  return execFile(gitCommand, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
  });
}

const realGitCommand = locateGit();

test("proves one fixed commit with only sealed read-only bare-mirror commands", async (t) => {
  const boundaries = await fixture(t);
  const runner = fakeRunner(boundaries);
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
  });

  const provenance = await inspector.preflight(request(boundaries.mirrorRoot));

  assert.deepEqual(Object.keys(provenance), [
    "schemaVersion",
    "repository",
    "canonicalRoot",
    "objectDirectory",
    "objectFormat",
    "oidLength",
    "commitOid",
    "boundaryDigest",
  ]);
  assert.deepEqual(provenance, {
    schemaVersion: 1,
    repository: "acme/repo",
    canonicalRoot: boundaries.mirrorRoot,
    objectDirectory: boundaries.objectDirectory,
    objectFormat: "sha1",
    oidLength: 40,
    commitOid: SHA1_COMMIT,
    boundaryDigest: provenance.boundaryDigest,
  });
  assert.match(provenance.boundaryDigest, /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(provenance));

  assert.deepEqual(runner.calls.map(({ args }) => commandTail(args)), [
    ["config", "--local", "--no-includes", "-z", "--name-only", "--list"],
    ["rev-parse", "--is-bare-repository"],
    ["rev-parse", "--show-object-format"],
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    ["cat-file", "-e", `${SHA1_COMMIT}^{commit}`],
    ["cat-file", "-t", SHA1_COMMIT],
  ]);
  for (const call of runner.calls) {
    assert.equal(call.command, boundaries.gitCommand);
    assert.equal(call.cwd, boundaries.mirrorRoot);
    assert.equal(call.timeoutMs, 15_000);
    assert.equal("input" in call, false);
    assert.equal(call.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, "");
    assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(call.env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(Object.values(call.env).includes(process.env.GIT_DIR), false);
    assert.equal(call.args.some((argument) => /show-ref|for-each-ref/u.test(argument)), false);
  }
});

test("accepts exactly one raw Git terminal line ending", async (t) => {
  const boundaries = await fixture(t);
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: fakeRunner(boundaries, {
      bare: "true\r\n",
      objectFormat: "sha1\n",
    }),
  });

  const provenance = await inspector.preflight(request(boundaries.mirrorRoot));

  assert.equal(provenance.objectFormat, "sha1");
  await assert.rejects(
    new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: fakeRunner(boundaries, { bare: "true\n\n" }),
    }).preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_PROTOCOL_ERROR",
  );
});

test(
  "preflights a fixed commit through the real local Git protocol",
  { skip: realGitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "git-bare-real-protocol-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, "source");
    const mirrorRoot = path.join(root, "mirror.git");
    await mkdir(sourceRoot);
    await git(realGitCommand, sourceRoot, [
      "init",
      "--initial-branch=main",
      "--object-format=sha1",
    ]);
    await git(realGitCommand, sourceRoot, [
      "config",
      "user.name",
      "MyDashboard Test",
    ]);
    await git(realGitCommand, sourceRoot, [
      "config",
      "user.email",
      "mydashboard@example.invalid",
    ]);
    await writeFile(path.join(sourceRoot, "README.md"), "sealed commit\n");
    await git(realGitCommand, sourceRoot, ["add", "--all"]);
    await git(realGitCommand, sourceRoot, ["commit", "-m", "sealed commit"]);
    const commitOid = (
      await git(realGitCommand, sourceRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    await git(realGitCommand, root, [
      "clone",
      "--bare",
      "--no-local",
      sourceRoot,
      mirrorRoot,
    ]);

    const provenance = await new GitBareMirrorInspector({
      gitCommand: realGitCommand,
    }).preflight({
      repository: "acme/repo",
      mirrorRoot,
      expectedCommitOid: commitOid,
    });

    assert.equal(provenance.commitOid, commitOid);
    assert.equal(provenance.canonicalRoot, path.resolve(mirrorRoot));
    assert.equal(provenance.objectFormat, "sha1");
  },
);

test("rejects widened, accessor, proxy, and object-format-mismatched requests before Git", async (t) => {
  const boundaries = await fixture(t);
  const runner = fakeRunner(boundaries);
  assert.throws(
    () => new GitBareMirrorInspector({ gitCommand: "git", processRunner: runner }),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_CONFIG",
  );
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
  });

  await assert.rejects(
    inspector.preflight({ ...request(boundaries.mirrorRoot), fetch: true }),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_REQUEST",
  );

  let accessorCalls = 0;
  const accessor = {
    repository: "acme/repo",
    expectedCommitOid: SHA1_COMMIT,
  };
  Object.defineProperty(accessor, "mirrorRoot", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return boundaries.mirrorRoot;
    },
  });
  await assert.rejects(
    inspector.preflight(accessor),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_REQUEST",
  );
  assert.equal(accessorCalls, 0);

  let proxyCalls = 0;
  const proxy = new Proxy(request(boundaries.mirrorRoot), {
    getPrototypeOf() {
      proxyCalls += 1;
      throw new Error("proxy trap must not run");
    },
    ownKeys() {
      proxyCalls += 1;
      throw new Error("proxy trap must not run");
    },
  });
  await assert.rejects(
    inspector.preflight(proxy),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_REQUEST",
  );
  assert.equal(proxyCalls, 0);
  assert.equal(runner.calls.length, 0);

  const sha256Runner = fakeRunner(boundaries, { objectFormat: "sha256" });
  const sha256Inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: sha256Runner,
  });
  await assert.rejects(
    sha256Inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_COMMIT_OID_MISMATCH",
  );
  assert.equal(
    sha256Runner.calls.some(({ args }) => args.includes("cat-file")),
    false,
  );
});

test("rejects constructor and runner accessors or proxies without invoking traps", async (t) => {
  const boundaries = await fixture(t);
  const runner = fakeRunner(boundaries);
  let trapCalls = 0;
  const accessorOptions = { processRunner: runner };
  Object.defineProperty(accessorOptions, "gitCommand", {
    enumerable: true,
    get() {
      trapCalls += 1;
      return boundaries.gitCommand;
    },
  });
  assert.throws(
    () => new GitBareMirrorInspector(accessorOptions),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_CONFIG",
  );

  const proxyOptions = new Proxy({ gitCommand: boundaries.gitCommand }, {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("options proxy trap must not run");
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error("options proxy trap must not run");
    },
  });
  assert.throws(
    () => new GitBareMirrorInspector(proxyOptions),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_CONFIG",
  );

  const accessorRunner = {};
  Object.defineProperty(accessorRunner, "run", {
    get() {
      trapCalls += 1;
      return runner.run;
    },
  });
  assert.throws(
    () => new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: accessorRunner,
    }),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_CONFIG",
  );

  const proxyRunner = new Proxy({}, {
    get() {
      trapCalls += 1;
      throw new Error("runner proxy trap must not run");
    },
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("runner proxy trap must not run");
    },
  });
  assert.throws(
    () => new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: proxyRunner,
    }),
    (error) => error?.code === "INVALID_GIT_BARE_MIRROR_CONFIG",
  );
  assert.equal(trapCalls, 0);
});

test("rejects symlink roots, non-bare repositories, includes, promisors, and alternates", async (t) => {
  const boundaries = await fixture(t);
  const linkedRoot = path.join(boundaries.root, "linked.git");
  await symlink(
    boundaries.mirrorRoot,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: fakeRunner(boundaries),
  });
  await assert.rejects(
    inspector.preflight(request(path.resolve(linkedRoot))),
    (error) => error?.code === "GIT_MIRROR_ROOT_MISMATCH",
  );

  for (const [options, code] of [
    [{ bare: "false" }, "GIT_MIRROR_NOT_BARE"],
    [{ configuration: "core.bare\0include.path\0" }, "GIT_MIRROR_UNTRUSTED_CONFIG"],
    [{ configuration: "core.bare\0remote.origin.promisor\0" }, "GIT_MIRROR_PARTIAL_REPOSITORY"],
  ]) {
    const candidate = new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: fakeRunner(boundaries, options),
    });
    await assert.rejects(
      candidate.preflight(request(boundaries.mirrorRoot)),
      (error) => error?.code === code,
    );
  }

  await writeFile(
    path.join(boundaries.objectDirectory, "info", "alternates"),
    "C:/untrusted/objects\n",
  );
  await assert.rejects(
    inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_ALTERNATE_OBJECT_STORE",
  );
});

test("does not inherit an object store that contains the commit in another mirror", async (t) => {
  const boundaries = await fixture(t);
  const otherObjectDirectory = path.join(boundaries.root, "other.git", "objects");
  await mkdir(otherObjectDirectory, { recursive: true });
  const previousAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = otherObjectDirectory;
  t.after(() => {
    if (previousAlternates === undefined) {
      delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    } else {
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = previousAlternates;
    }
  });

  const runner = fakeRunner(boundaries, {
    onRun({ request: invocation, tail }) {
      if (tail[0] !== "cat-file" || tail[1] !== "-e") return;
      assert.equal(invocation.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, "");
    },
    commitAvailable: false,
  });
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
  });

  await assert.rejects(
    inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_COMMIT_UNAVAILABLE",
  );
});

test("rejects pack and loose-object directories linked to another mirror", async (t) => {
  for (const location of ["pack", "loose"]) {
    const boundaries = await fixture(t);
    const donorDirectory = path.join(
      boundaries.root,
      `donor-${location}.git`,
      "objects",
      location === "pack" ? "pack" : "01",
    );
    await mkdir(donorDirectory, { recursive: true });
    const linkedDirectory = location === "pack"
      ? path.join(boundaries.objectDirectory, "pack")
      : path.join(boundaries.objectDirectory, "01");
    await rm(linkedDirectory, { recursive: true, force: true });
    await symlink(
      donorDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const inspector = new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: fakeRunner(boundaries),
    });

    await assert.rejects(
      inspector.preflight(request(boundaries.mirrorRoot)),
      (error) => error?.code === "GIT_MIRROR_OBJECT_STORE_UNSAFE",
    );
  }
});

test("rejects shared loose objects and promisor pack markers", async (t) => {
  const shared = await fixture(t);
  const looseDirectory = path.join(shared.objectDirectory, "01");
  const looseObject = path.join(looseDirectory, "2".repeat(38));
  await mkdir(looseDirectory);
  await writeFile(looseObject, "not a trusted loose object");
  await link(looseObject, path.join(shared.root, "outside-object"));
  await assert.rejects(
    new GitBareMirrorInspector({
      gitCommand: shared.gitCommand,
      processRunner: fakeRunner(shared),
    }).preflight(request(shared.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_OBJECT_STORE_UNSAFE",
  );

  const promisor = await fixture(t);
  await writeFile(
    path.join(promisor.objectDirectory, "pack", "pack-test.promisor"),
    "promisor marker",
  );
  await assert.rejects(
    new GitBareMirrorInspector({
      gitCommand: promisor.gitCommand,
      processRunner: fakeRunner(promisor),
    }).preflight(request(promisor.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_PARTIAL_REPOSITORY",
  );
});

test("fails before commit inspection when the object-store scan limit is exceeded", async (t) => {
  const boundaries = await fixture(t);
  const looseDirectory = path.join(boundaries.objectDirectory, "01");
  await mkdir(looseDirectory);
  await writeFile(path.join(looseDirectory, "2".repeat(38)), "loose object");
  const runner = fakeRunner(boundaries);
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
    maxObjectStoreEntries: 3,
  });

  await assert.rejects(
    inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_OBJECT_STORE_LIMIT",
  );
  assert.equal(
    runner.calls.some(({ args }) => args.includes("cat-file")),
    false,
  );
});

test("detects an alternate added for cat-file and removed before final validation", async (t) => {
  const boundaries = await fixture(t);
  const alternateFile = path.join(
    boundaries.objectDirectory,
    "info",
    "alternates",
  );
  const runner = fakeRunner(boundaries, {
    async onRun({ tail }) {
      if (tail[0] !== "cat-file") return;
      if (tail[1] === "-e") {
        await writeFile(alternateFile, "C:/donor.git/objects\n");
      }
      if (tail[1] === "-t") {
        await rm(alternateFile, { force: true });
      }
    },
  });
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
  });

  await assert.rejects(
    inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_BOUNDARY_CHANGED",
  );
});

test("rejects worktree config and strict config-protocol violations", async (t) => {
  const boundaries = await fixture(t);
  for (const configuration of [
    "core.bare",
    "core.bare\u200b\0",
    Buffer.from([0x63, 0x6f, 0x72, 0x65, 0x2e, 0xff, 0x00]),
    "core.bare\0extensions.worktreeconfig\0",
  ]) {
    const inspector = new GitBareMirrorInspector({
      gitCommand: boundaries.gitCommand,
      processRunner: fakeRunner(boundaries, { configuration }),
    });
    await assert.rejects(
      inspector.preflight(request(boundaries.mirrorRoot)),
      (error) => error?.code === "GIT_MIRROR_UNTRUSTED_CONFIG",
    );
  }

  await writeFile(
    path.join(boundaries.mirrorRoot, "config.worktree"),
    "[include]\n\tpath = C:/outside/config\n",
  );
  const runner = fakeRunner(boundaries);
  const inspector = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: runner,
  });
  await assert.rejects(
    inspector.preflight(request(boundaries.mirrorRoot)),
    (error) => error?.code === "GIT_MIRROR_UNTRUSTED_CONFIG",
  );
  assert.equal(runner.calls.length, 0);
});

test("binds executable and repository control files and rejects in-flight changes", async (t) => {
  const boundaries = await fixture(t);
  const first = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: fakeRunner(boundaries),
  });
  const original = await first.preflight(request(boundaries.mirrorRoot));

  await writeFile(
    path.join(boundaries.mirrorRoot, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = true\n[remote \"origin\"]\n\turl = disabled://changed\n",
  );
  const changed = await first.preflight(request(boundaries.mirrorRoot));
  assert.notEqual(changed.boundaryDigest, original.boundaryDigest);

  let changedDuringProof = false;
  const racingRunner = fakeRunner(boundaries, {
    async onRun({ tail }) {
      if (changedDuringProof || tail[0] !== "cat-file" || tail[1] !== "-e") return;
      changedDuringProof = true;
      await writeFile(
        path.join(boundaries.mirrorRoot, "config"),
        "[core]\n\trepositoryformatversion = 0\n\tbare = true\n# raced\n",
      );
    },
  });
  const racing = new GitBareMirrorInspector({
    gitCommand: boundaries.gitCommand,
    processRunner: racingRunner,
  });
  await assert.rejects(
    racing.preflight(request(boundaries.mirrorRoot)),
    (error) =>
      error instanceof GitBareMirrorInspectorError &&
      error.code === "GIT_MIRROR_BOUNDARY_CHANGED",
  );
});
