import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitObjectSnapshotter,
  GitObjectSnapshotterError,
  gitSnapshotFailureDiagnostic,
  BinaryExecFileRunner,
} from "../src/adapters/git-object-snapshotter.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "../src/services/controlled-code-executor.js";
import { CodeExecutionJournal } from "../src/services/code-execution-journal.js";
import { StateStore } from "../src/lib/state-store.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { PreparationAbortedError, withPreparationCancellation } from "../src/lib/preparation-cancellation.js";

const HEAD = "1".repeat(40);
const APP_CONTENT = Buffer.from("export const value = 1;\n");
const SECRET_CONTENT = Buffer.from("TOKEN=secret");
const blobOid = (content, algorithm = "sha1") =>
  createHash(algorithm)
    .update(Buffer.from(`blob ${content.length}\0`))
    .update(content)
    .digest("hex");
const BLOB_A = blobOid(APP_CONTENT);
const BLOB_B = blobOid(SECRET_CONTENT);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "git-object-snapshotter-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const gitCommand = process.platform === "win32"
    ? path.join(root, "mingw64", "bin", "git.exe")
    : path.join(root, "trusted-git");
  await mkdir(path.dirname(gitCommand), { recursive: true });
  await Promise.all([
    mkdir(path.join(sourceRoot, ".git", "objects"), { recursive: true }),
    mkdir(targetRoot),
    writeFile(gitCommand, "trusted fake Git executable\n"),
  ]);
  if (process.platform !== "win32") await chmod(gitCommand, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sourceRoot, targetRoot, gitCommand };
}

function output(stdout, overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    truncated: false,
    ...overrides,
  };
}

function treeEntry({
  mode = "100644",
  type = mode === "160000" ? "commit" : "blob",
  oid = BLOB_A,
  path: relativePath,
}) {
  const encodedPath = Buffer.isBuffer(relativePath)
    ? relativePath
    : Buffer.from(relativePath);
  return Buffer.concat([
    Buffer.from(`${mode} ${type} ${oid}\t`),
    encodedPath,
    Buffer.from([0]),
  ]);
}

function tree(entries) {
  return Buffer.concat(entries.map(treeEntry));
}

function fakeRunner(sourceRoot, {
  objectFormat = "sha1",
  objectType = "commit",
  repositoryRoot = sourceRoot,
  treeOutput = tree([{ path: "src/app.js" }]),
  blobs = new Map([[BLOB_A, APP_CONTENT]]),
  override,
} = {}) {
  const calls = [];
  const gitCommand = process.platform === "win32"
    ? path.join(path.dirname(sourceRoot), "mingw64", "bin", "git.exe")
    : path.join(path.dirname(sourceRoot), "trusted-git");
  return {
    calls,
    gitCommand,
    async run(request) {
      calls.push(structuredClone(request));
      if (override) {
        const overridden = await override(request);
        if (overridden !== undefined) return overridden;
      }
      const args = request.args.slice(10);
      if (args.includes("--show-object-format")) {
        return output(`${objectFormat}\n`);
      }
      if (args.includes("--show-toplevel")) {
        return output(`${repositoryRoot}\n`);
      }
      if (args.includes("--absolute-git-dir")) {
        return output(`${path.join(sourceRoot, ".git")}\n`);
      }
      if (args.includes("--git-common-dir")) {
        return output(`${path.join(sourceRoot, ".git")}\n`);
      }
      if (args[0] === "config") {
        return output("", { exitCode: 1 });
      }
      if (args[0] === "cat-file" && args[1] === "-t") {
        return output(`${objectType}\n`);
      }
      if (args[0] === "ls-tree") return output(treeOutput);
      if (args[0] === "cat-file" && args[1] === "--batch") {
        const oids = request.input.toString("ascii").trimEnd().split("\n");
        return output(
          Buffer.concat(
            oids.map((oid) => {
              const value = blobs.get(oid);
              if (!value) return Buffer.from(`${oid} missing\n`);
              return Buffer.concat([
                Buffer.from(`${oid} blob ${value.length}\n`),
                value,
                Buffer.from("\n"),
              ]);
            }),
          ),
        );
      }
      throw new Error(`Unexpected Git request: ${args.join(" ")}`);
    },
  };
}

test("snapshot preflight accepts a pinned UCRT64 native Git executable", async (t) => {
  if (process.platform !== "win32") return;
  const setup = await fixture(t);
  const runner = fakeRunner(setup.sourceRoot);
  runner.gitCommand = path.join(setup.root, "ucrt64", "bin", "git.exe");
  await mkdir(path.dirname(runner.gitCommand), { recursive: true });
  await writeFile(runner.gitCommand, "trusted UCRT64 Git executable\n");
  const boundary = await snapshotter(runner).preflight({ sourceRoot: setup.sourceRoot });
  assert.equal(boundary.gitCommand, await realpath(runner.gitCommand));
  assert.match(boundary.gitExecutableSha256, /^[a-f0-9]{64}$/u);
});

function snapshotter(processRunner, limits) {
  return new GitObjectSnapshotter({
    gitCommand: processRunner.gitCommand,
    processRunner,
    ...(limits ? { limits } : {}),
  });
}

async function materialize(service, request) {
  const boundary = await service.preflight({ sourceRoot: request.sourceRoot });
  return service.materialize({
    ...request,
    expectedBoundaryDigest: boundary.boundaryDigest,
    expectedGitCommand: boundary.gitCommand,
    expectedGitExecutableSha256: boundary.gitExecutableSha256,
    expectedGitExecutableBytes: boundary.gitExecutableBytes,
    expectedGitExecutableMode: boundary.gitExecutableMode,
    expectedGitExecutableUid: boundary.gitExecutableUid,
    expectedGitExecutableGid: boundary.gitExecutableGid,
  });
}

test("materializes only ordinary blobs from the exact commit without reading checkout files", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  await writeFile(path.join(sourceRoot, "uncommitted-secret.txt"), "secret");
  const app = APP_CONTENT;
  const runner = fakeRunner(sourceRoot, {
    treeOutput: tree([
      { path: ".env", oid: BLOB_B },
      { path: "private/data.txt", oid: BLOB_B },
      { path: "README.md", oid: BLOB_A },
      { path: "src/app.js", oid: BLOB_A, mode: "100755" },
    ]),
    blobs: new Map([
      [BLOB_A, app],
      [BLOB_B, SECRET_CONTENT],
    ]),
  });

  const result = await materialize(snapshotter(runner), {
    sourceRoot,
    targetRoot,
    headOid: HEAD,
    excludePaths: ["private"],
  });

  assert.equal(result.headOid, HEAD);
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalBytes, app.length * 2);
  assert.deepEqual([...result.baseline.keys()], ["README.md", "src/app.js"]);
  assert.deepEqual([...result.modes], [
    ["README.md", "100644"],
    ["src/app.js", "100755"],
  ]);
  assert.deepEqual(await readFile(path.join(targetRoot, "README.md")), app);
  assert.deepEqual(await readFile(path.join(targetRoot, "src", "app.js")), app);
  await assert.rejects(readFile(path.join(targetRoot, ".env")));
  await assert.rejects(readFile(path.join(targetRoot, "private", "data.txt")));
  await assert.rejects(
    readFile(path.join(targetRoot, "uncommitted-secret.txt")),
  );

  const batchCall = runner.calls.find((call) =>
    call.args.slice(10).includes("--batch"),
  );
  assert.equal(Buffer.from(batchCall.input).toString("ascii"), `${BLOB_A}\n`);
  assert.equal(
    runner.calls.some((call) =>
      ["checkout", "archive", "fetch", "pull", "clone"].includes(
        call.args[10],
      )),
    false,
  );
  for (const call of runner.calls) {
    assert.equal(call.command, runner.gitCommand);
    assert.equal(call.cwd, path.resolve(sourceRoot));
    assert.deepEqual(call.env, {
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
    assert.deepEqual(call.args.slice(0, 10), [
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
  }
});

function manyBlobs(count) {
  const entries = [];
  const blobs = new Map();
  for (let index = 0; index < count; index += 1) {
    const content = Buffer.from(`blob-${String(index).padStart(4, "0")}\n`);
    const oid = blobOid(content);
    entries.push({ path: `src/file-${String(index).padStart(4, "0")}.txt`, oid });
    blobs.set(oid, content);
  }
  return { entries, blobs };
}

async function snapshotBroker(setup, service) {
  const boundary = await service.preflight({ sourceRoot: setup.sourceRoot });
  const identityKeys = ["gitCommand", "gitExecutableSha256", "gitExecutableBytes",
    "gitExecutableMode", "gitExecutableUid", "gitExecutableGid"];
  return new CodeWorkspaceBroker({
    scratchRoot: path.join(setup.root, "scratch"),
    gitSnapshotter: service,
    workspaces: [{
      id: "dashboard", sourceRoot: setup.sourceRoot, writablePaths: [],
      gitBoundaryDigest: boundary.boundaryDigest,
      gitExecutableIdentity: Object.fromEntries(identityKeys.map(key => [key, boundary[key]])),
    }],
  });
}

function snapshotInputBinding() {
  return {
    schemaVersion: 1, kind: "pull_request", repository: "acme/dashboard", pullRequestNumber: 42,
    rootItemId: "pr-root-42", workKey: "pr-work-42", inputRevision: 1, headRevision: 1,
    headRefOid: HEAD, eventId: "event-42", eventDigest: "2".repeat(64), inputDigest: "3".repeat(64),
  };
}

test("broker retains the failing later Git blob batch's own diagnostic context", async t => {
  const setup = await fixture(t);
  const { entries, blobs } = manyBlobs(257);
  let batchCalls = 0;
  const runner = fakeRunner(setup.sourceRoot, {
    treeOutput: tree(entries), blobs,
    override(request) {
      if (request.args.includes("--batch") && ++batchCalls === 3) {
        throw Object.assign(new GitObjectSnapshotterError("GIT_SNAPSHOT_TIMEOUT", "secret https://token@example.invalid/private/path"), {
          diagnostics: { batchIndex: 999, stdoutBytes: 0, process: "stopped" },
          details: { durationMs: 0, stdoutBytes: 0, process: "stopped" },
        });
      }
    },
  });
  const broker = await snapshotBroker(setup, snapshotter(runner));
  await assert.rejects(broker.createExecution({
    workspaceId: "dashboard", executionId: "later-batch", inputBinding: snapshotInputBinding(),
  }), error => {
    assert.equal(error.code, "GIT_SNAPSHOT_TIMEOUT");
    assert.match(error.message, /stage=blob_read/);
    assert.match(error.message, /operation=blob_batch/);
    assert.match(error.message, /batch=3\/3 objects=1/);
    assert.match(error.message, /elapsedMs=\d+ budgetMs=30000/);
    assert.match(error.message, /stdoutBytes=unknown stderrBytes=unknown process=unknown/);
    assert.doesNotMatch(error.message, /secret|token|example\.invalid|private\/path|--batch/);
    return true;
  });
  assert.equal(batchCalls, 3);

  // Exercise the existing trusted persistence boundary, including restart, with
  // a failure freshly generated through the real producer and broker again.
  batchCalls = 0;
  const profile = { kind: "node-test" };
  const store = new StateStore(path.join(setup.root, "state"));
  let sandboxCalls = 0;
  const createExecutor = () => new ControlledCodeExecutor({
    broker, store, journal: new CodeExecutionJournal({ root: path.join(setup.root, "journal") }),
    sandbox: {
      async run() { sandboxCalls++; assert.fail("preparation must fail before any sandbox action"); },
      async cleanup() {}, getProfileFingerprint: () => digestValue(profile),
    },
    profileDefinitions: { checks: profile }, requiredProfilesByWorkspace: { dashboard: ["checks"] },
  });
  const executor = createExecutor();
  await executor.recover();
  const request = { sessionId: "failed-batch-session", workspaceId: "dashboard",
    requestedBy: { roleId: "developer", workItemId: "dev-task-42" }, inputBinding: snapshotInputBinding() };
  await assert.rejects(executor.start(request), { code: "START_FAILED" });
  const failed = await executor.view({ sessionId: request.sessionId });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "GIT_SNAPSHOT_TIMEOUT");
  assert.match(failed.error.message, /batch=3\/3 objects=1/);
  assert.equal(failed.actions.length, 0);
  assert.deepEqual(failed.inputBinding, request.inputBinding);
  assert.equal(sandboxCalls, 0);
  const restarted = createExecutor();
  await restarted.recover();
  assert.deepEqual((await restarted.view({ sessionId: request.sessionId })).error, failed.error);
  await assert.rejects(restarted.start({ ...request,
    inputBinding: { ...request.inputBinding, headRefOid: "9".repeat(40) },
  }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(batchCalls, 3, "changed source cannot replay old preparation");
});

test("broker diagnoses preflight command failures without borrowing blob-batch context", async t => {
  const setup = await fixture(t);
  let failPreflight = false;
  const runner = fakeRunner(setup.sourceRoot, { override(request) {
    if (failPreflight && request.args.includes("--show-toplevel")) {
      return output("private output", { exitCode: 1, stderr: Buffer.from("token https://secret.invalid/path") });
    }
  } });
  const broker = await snapshotBroker(setup, snapshotter(runner));
  failPreflight = true;
  await assert.rejects(broker.createExecution({ workspaceId: "dashboard", executionId: "failed-preflight",
    inputBinding: snapshotInputBinding() }), error => {
    assert.equal(error.code, "GIT_SNAPSHOT_PROCESS_FAILED");
    assert.match(error.message, /stage=preflight operation=repository_identity/);
    assert.match(error.message, /stdoutBytes=14 stderrBytes=33 process=unknown/);
    assert.doesNotMatch(error.message, /batch=|objects=|token|private|secret\.invalid/);
    return true;
  });
});

test("owned process timeout retains only measured partial byte counts and settled process proof", async t => {
  const setup = await fixture(t);
  const processRunner = new BinaryExecFileRunner();
  const runner = fakeRunner(setup.sourceRoot, { override(request) {
    if (request.args.includes("--batch")) return processRunner.run({
      ...request, command: process.execPath,
      args: ["-e", 'process.stdout.write("ok"); process.stderr.write("secret"); setInterval(() => {}, 1000);'],
      input: undefined,
    });
  } });
  const service = new GitObjectSnapshotter({ gitCommand: runner.gitCommand, processRunner: runner, timeoutMs: 500 });
  const broker = await snapshotBroker(setup, service);
  await assert.rejects(broker.createExecution({ workspaceId: "dashboard", executionId: "owned-process-timeout",
    inputBinding: snapshotInputBinding() }), error => {
    assert.equal(error.code, "GIT_SNAPSHOT_TIMEOUT");
    assert.match(error.message, /stage=blob_read operation=blob_batch batch=1\/1 objects=1/);
    assert.match(error.message, /elapsedMs=\d+ budgetMs=500/);
    assert.match(error.message, /stdoutBytes=2 stderrBytes=6 process=stopped/);
    assert.doesNotMatch(error.message, /secret|setInterval|node\.exe|--batch/);
    return true;
  });
});

test("owned nonzero process exit retains result byte counts and stopped proof without raw output", async t => {
  const setup = await fixture(t);
  const stdout = "synthetic stdout https://user:token@example.invalid/private";
  const stderr = "synthetic error https://secret.invalid/path";
  const processRunner = new BinaryExecFileRunner();
  const runner = fakeRunner(setup.sourceRoot, { override(request) {
    if (request.args.includes("--batch")) return processRunner.run({
      ...request, command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`],
      input: undefined,
    });
  } });
  const broker = await snapshotBroker(setup, snapshotter(runner));
  await assert.rejects(broker.createExecution({ workspaceId: "dashboard", executionId: "owned-process-nonzero",
    inputBinding: snapshotInputBinding() }), error => {
    assert.equal(error.code, "GIT_SNAPSHOT_PROCESS_FAILED");
    assert.match(error.message, /stage=blob_read operation=blob_batch batch=1\/1 objects=1/);
    assert.match(error.message, new RegExp(`stdoutBytes=${Buffer.byteLength(stdout)} stderrBytes=${Buffer.byteLength(stderr)} process=stopped`));
    assert.doesNotMatch(error.message, /synthetic|stdout https|error https|token|example\.invalid|secret\.invalid|private/);
    return true;
  });
});

test("snapshot diagnostics preserve cancellation identity and actual command stage", async t => {
  const setup = await fixture(t);
  const { entries, blobs } = manyBlobs(129);
  let batches = 0;
  const aborted = new PreparationAbortedError();
  const runner = fakeRunner(setup.sourceRoot, { treeOutput: tree(entries), blobs, override(request) {
    if (request.args.includes("--batch") && ++batches === 2) throw aborted;
  } });
  const broker = await snapshotBroker(setup, snapshotter(runner));
  const controller = new AbortController();
  await assert.rejects(withPreparationCancellation(controller.signal, () => broker.createExecution({
    workspaceId: "dashboard", executionId: "cancelled-batch", inputBinding: snapshotInputBinding(),
  })), error => {
    assert.equal(error, aborted);
    assert.equal(error.code, "CODE_PREPARATION_ABORTED");
    assert.match(gitSnapshotFailureDiagnostic(error), /stage=blob_read operation=blob_batch batch=2\/2 objects=1/);
    assert.match(gitSnapshotFailureDiagnostic(error), /process=unknown/);
    return true;
  });
});

test("errors outside the snapshot producer cannot forge persistent diagnostic metadata", async t => {
  const setup = await fixture(t);
  const service = snapshotter(fakeRunner(setup.sourceRoot));
  const forged = Object.assign(new GitObjectSnapshotterError("GIT_SNAPSHOT_TIMEOUT", "private content"), {
    diagnostics: { stage: "blob_read", batchIndex: 999, stdoutBytes: 0, process: "stopped" },
  });
  assert.equal(gitSnapshotFailureDiagnostic(forged), null);
  const broker = await snapshotBroker(setup, {
    preflight: service.preflight.bind(service), async materialize() { throw forged; },
  });
  await assert.rejects(broker.createExecution({ workspaceId: "dashboard", executionId: "forged-diagnostic",
    inputBinding: snapshotInputBinding() }), error => {
    assert.equal(error.code, "GIT_SNAPSHOT_TIMEOUT");
    assert.equal(error.message, "无法从指定 Git Head 创建代码快照");
    return true;
  });
});

test("reads bounded blob batches with global deduplication and an intact large final blob", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const { entries, blobs } = manyBlobs(128);
  const largeContent = Buffer.alloc(2_000_000, 0x61);
  const largeOid = blobOid(largeContent);
  entries.push({ path: "zz-large.bin", oid: largeOid });
  entries.push({ path: "src/zz-duplicate.txt", oid: entries[0].oid });
  blobs.set(largeOid, largeContent);
  const runner = fakeRunner(sourceRoot, {
    treeOutput: tree(entries),
    blobs,
    override(request) {
      if (request.args.includes("--batch") && request.input.length > 128 * 41) {
        throw new GitObjectSnapshotterError("GIT_SNAPSHOT_TIMEOUT", "bulk read timed out");
      }
    },
  });

  const result = await materialize(snapshotter(runner, { maxFileBytes: largeContent.length }), {
    sourceRoot, targetRoot, headOid: HEAD, excludePaths: [],
  });

  const batches = runner.calls.filter((call) => call.args.includes("--batch"));
  assert.deepEqual(batches.map((call) => call.input.length / 41), [128, 1]);
  assert.equal(batches.every((call) => call.timeoutMs === 30_000), true);
  assert.equal(result.fileCount, 130);
  assert.equal(result.totalBytes, [...blobs.values()].reduce((sum, content) => sum + content.length, 0) + blobs.get(entries[0].oid).length);
  assert.deepEqual(await readFile(path.join(targetRoot, "zz-large.bin")), largeContent);
  assert.equal(result.baseline.get("zz-large.bin"), createHash("sha256").update(largeContent).digest("hex"));
});

test("keeps the unique blob byte budget across batches before writing any files", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const { entries, blobs } = manyBlobs(129);
  const total = [...blobs.values()].reduce((sum, content) => sum + content.length, 0);
  const runner = fakeRunner(sourceRoot, { treeOutput: tree(entries), blobs });

  await assert.rejects(materialize(snapshotter(runner, { maxTotalBytes: total - 1 }), {
    sourceRoot, targetRoot, headOid: HEAD, excludePaths: [],
  }), { code: "TOTAL_SIZE_LIMIT" });

  const batches = runner.calls.filter((call) => call.args.includes("--batch"));
  assert.equal(batches.length, 2);
  assert.equal(batches[1].maxOutputBytes < batches[0].maxOutputBytes, true);
  assert.deepEqual(await readdir(targetRoot), []);
});

test("validates the later blob batch protocol and hashes before writing any files", async (t) => {
  const { root, sourceRoot } = await fixture(t);
  for (const failure of ["hash", "extra", "missing", "oid"]) {
    const targetRoot = path.join(root, `later-batch-${failure}`);
    await mkdir(targetRoot);
    const { entries, blobs } = manyBlobs(129);
    const finalOid = entries.at(-1).oid;
    const content = blobs.get(finalOid);
    const runner = fakeRunner(sourceRoot, {
      treeOutput: tree(entries), blobs,
      override(request) {
        if (!request.args.includes("--batch") || request.input.toString("ascii") !== `${finalOid}\n`) return;
        if (failure === "missing") return output(`${finalOid} missing\n`);
        const body = failure === "hash" ? Buffer.alloc(content.length, 0x78) : content;
        return output(Buffer.concat([
          Buffer.from(`${failure === "oid" ? BLOB_A : finalOid} blob ${body.length}\n`),
          body, Buffer.from(failure === "extra" ? "\nextra" : "\n"),
        ]));
      },
    });

    await assert.rejects(materialize(snapshotter(runner), {
      sourceRoot, targetRoot, headOid: HEAD, excludePaths: [],
    }), { code: failure === "hash" ? "GIT_SNAPSHOT_OBJECT_MISMATCH" : "GIT_SNAPSHOT_PROTOCOL_ERROR" });
    assert.deepEqual(await readdir(targetRoot), []);
  }
});

test("fails closed when commit identity, object format, repository root, or process receipt changes", async (t) => {
  const first = await fixture(t);
  const other = await fixture(t);
  const cases = [
    {
      runner: fakeRunner(first.sourceRoot, { objectFormat: "sha256" }),
      code: "GIT_HEAD_UNAVAILABLE",
    },
    {
      runner: fakeRunner(first.sourceRoot, { objectType: "tree" }),
      code: "GIT_HEAD_UNAVAILABLE",
    },
    {
      runner: fakeRunner(first.sourceRoot, {
        repositoryRoot: other.sourceRoot,
      }),
      code: "GIT_SNAPSHOT_ROOT_MISMATCH",
    },
    {
      runner: fakeRunner(first.sourceRoot, {
        override(request) {
          if (request.args.includes("ls-tree")) {
            return output(Buffer.alloc(0), { exitCode: 1 });
          }
        },
      }),
      code: "GIT_SNAPSHOT_PROCESS_FAILED",
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const targetRoot = path.join(first.root, `target-case-${index}`);
    await mkdir(targetRoot);
    await assert.rejects(
      materialize(snapshotter(cases[index].runner), {
        sourceRoot: first.sourceRoot,
        targetRoot,
        headOid: HEAD,
        excludePaths: [],
      }),
      (error) =>
        error instanceof GitObjectSnapshotterError &&
        error.code === cases[index].code,
    );
  }
});

test("preflight seals the canonical repository boundary and rejects partial repositories", async (t) => {
  const { sourceRoot } = await fixture(t);
  const runner = fakeRunner(sourceRoot);
  const service = snapshotter(runner);

  const first = await service.preflight({ sourceRoot });
  const second = await service.preflight({ sourceRoot });

  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), [
    "schemaVersion",
    "gitCommand",
    "gitExecutableSha256",
    "gitExecutableBytes",
    "gitExecutableMode",
    "gitExecutableUid",
    "gitExecutableGid",
    "canonicalRoot",
    "absoluteGitDir",
    "commonDir",
    "objectDirectory",
    "objectFormat",
    "oidLength",
    "boundaryDigest",
  ]);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.gitCommand, await realpath(runner.gitCommand));
  const executable = await readFile(runner.gitCommand);
  assert.equal(first.gitExecutableSha256, createHash("sha256").update(executable).digest("hex"));
  assert.equal(first.gitExecutableBytes, executable.length);
  const executableStats = await lstat(runner.gitCommand);
  assert.equal(first.gitExecutableMode, executableStats.mode & 0o7777);
  assert.equal(first.gitExecutableUid, executableStats.uid);
  assert.equal(first.gitExecutableGid, executableStats.gid);
  assert.equal(first.canonicalRoot, await realpath(sourceRoot));
  assert.equal(first.absoluteGitDir, await realpath(path.join(sourceRoot, ".git")));
  assert.equal(first.commonDir, first.absoluteGitDir);
  assert.equal(
    first.objectDirectory,
    await realpath(path.join(sourceRoot, ".git", "objects")),
  );
  assert.equal(first.objectFormat, "sha1");
  assert.equal(first.oidLength, 40);
  assert.match(first.boundaryDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(first), true);

  const partial = snapshotter(fakeRunner(sourceRoot, {
    override(request) {
      if (request.args.includes("--name-only")) {
        return output("extensions.partialClone\0");
      }
    },
  }));
  await assert.rejects(
    partial.preflight({ sourceRoot }),
    { code: "GIT_SNAPSHOT_PARTIAL_REPOSITORY" },
  );
  const configCall = runner.calls.find((call) =>
    call.args.includes("--name-only"),
  );
  assert.equal(configCall.args.includes("--local"), false);
  assert.equal(configCall.args.includes("--no-includes"), true);

  const included = snapshotter(fakeRunner(sourceRoot, {
    override(request) {
      if (request.args.includes("--name-only")) {
        return output("include.path\0");
      }
    },
  }));
  await assert.rejects(
    included.preflight({ sourceRoot }),
    { code: "GIT_SNAPSHOT_UNTRUSTED_CONFIG" },
  );
  const subsection = snapshotter(fakeRunner(sourceRoot, {
    override(request) {
      if (request.args.includes("--name-only")) {
        return output("lfs.https://host/repo/info/lfs.access\0");
      }
    },
  }));
  assert.equal(
    (await subsection.preflight({ sourceRoot })).canonicalRoot,
    await realpath(sourceRoot),
  );

  const packRoot = path.join(sourceRoot, ".git", "objects", "pack");
  await mkdir(packRoot, { recursive: true });
  const promisorMarker = path.join(packRoot, "pack-deadbeef.promisor");
  await writeFile(promisorMarker, "");
  await assert.rejects(
    service.preflight({ sourceRoot }),
    { code: "GIT_SNAPSHOT_PARTIAL_REPOSITORY" },
  );
  await rm(promisorMarker);

  const infoRoot = path.join(sourceRoot, ".git", "objects", "info");
  await mkdir(infoRoot, { recursive: true });
  await writeFile(path.join(infoRoot, "alternates"), "C:/outside/objects\n");
  await assert.rejects(
    service.preflight({ sourceRoot }),
    { code: "GIT_SNAPSHOT_ALTERNATE_OBJECT_STORE" },
  );
});

test("rejects a changed Git executable before invoking the changed program", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const runner = fakeRunner(sourceRoot);
  const service = snapshotter(runner);
  const boundary = await service.preflight({ sourceRoot });
  const callsBeforeReplacement = runner.calls.length;
  await writeFile(runner.gitCommand, "replaced Git executable bytes\n");

  await assert.rejects(
    service.materialize({
      sourceRoot,
      targetRoot,
      headOid: HEAD,
      excludePaths: [],
      expectedBoundaryDigest: boundary.boundaryDigest,
      expectedGitCommand: boundary.gitCommand,
      expectedGitExecutableSha256: boundary.gitExecutableSha256,
      expectedGitExecutableBytes: boundary.gitExecutableBytes,
      expectedGitExecutableMode: boundary.gitExecutableMode,
      expectedGitExecutableUid: boundary.gitExecutableUid,
      expectedGitExecutableGid: boundary.gitExecutableGid,
    }),
    { code: "GIT_SNAPSHOT_BOUNDARY_MISMATCH" },
  );
  assert.equal(runner.calls.length, callsBeforeReplacement);
  assert.deepEqual(await readdirNames(targetRoot), []);
});

test(
  "rejects revoked execute permission or privileged Git modes before invocation",
  { skip: process.platform === "win32" ? "Windows executable authority is ACL-based" : false },
  async (t) => {
    for (const [name, mode] of [["not-executable", 0o644], ["set-id", 0o4755]]) {
      const setup = await fixture(t);
      const runner = fakeRunner(setup.sourceRoot);
      const service = snapshotter(runner);
      const boundary = await service.preflight({ sourceRoot: setup.sourceRoot });
      const callsBeforeModeChange = runner.calls.length;
      await chmod(runner.gitCommand, mode);

      await assert.rejects(
        service.materialize({
          sourceRoot: setup.sourceRoot,
          targetRoot: setup.targetRoot,
          headOid: HEAD,
          excludePaths: [],
          expectedBoundaryDigest: boundary.boundaryDigest,
          expectedGitCommand: boundary.gitCommand,
          expectedGitExecutableSha256: boundary.gitExecutableSha256,
          expectedGitExecutableBytes: boundary.gitExecutableBytes,
          expectedGitExecutableMode: boundary.gitExecutableMode,
          expectedGitExecutableUid: boundary.gitExecutableUid,
          expectedGitExecutableGid: boundary.gitExecutableGid,
        }),
        (error) =>
          error.code === "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED" ||
          error.code === "GIT_SNAPSHOT_EXECUTABLE_CHANGED",
        name,
      );
      assert.equal(runner.calls.length, callsBeforeModeChange);
    }
  },
);

test("rejects repository-supplied, linked, or Windows wrapper Git executables before invocation", async (t) => {
  const setup = await fixture(t);
  const runner = fakeRunner(setup.sourceRoot);
  const containedCommand = process.platform === "win32"
    ? path.join(setup.sourceRoot, "mingw64", "bin", "git.exe")
    : path.join(setup.sourceRoot, "trusted-git");
  await mkdir(path.dirname(containedCommand), { recursive: true });
  await writeFile(containedCommand, "repository supplied executable\n");
  runner.gitCommand = containedCommand;
  await assert.rejects(
    snapshotter(runner).preflight({ sourceRoot: setup.sourceRoot }),
    { code: "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED" },
  );
  assert.equal(runner.calls.length, 0);

  const linked = await fixture(t);
  const linkedRunner = fakeRunner(linked.sourceRoot);
  await rm(linkedRunner.gitCommand);
  let executableLinkCreated = false;
  try {
    await symlink(
      containedCommand,
      linkedRunner.gitCommand,
      process.platform === "win32" ? "file" : undefined,
    );
    executableLinkCreated = true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.diagnostic("symlink privilege unavailable; linked executable case skipped");
    } else {
      throw error;
    }
  }
  if (executableLinkCreated) {
    await assert.rejects(
      snapshotter(linkedRunner).preflight({ sourceRoot: linked.sourceRoot }),
      { code: "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED" },
    );
    assert.equal(linkedRunner.calls.length, 0);
  }

  if (process.platform === "win32") {
    const wrapper = await fixture(t);
    const wrapperRunner = fakeRunner(wrapper.sourceRoot);
    wrapperRunner.gitCommand = path.join(wrapper.root, "cmd", "git.exe");
    await mkdir(path.dirname(wrapperRunner.gitCommand), { recursive: true });
    await writeFile(wrapperRunner.gitCommand, "Git for Windows wrapper\n");
    await assert.rejects(
      snapshotter(wrapperRunner).preflight({ sourceRoot: wrapper.sourceRoot }),
      { code: "GIT_SNAPSHOT_EXECUTABLE_UNTRUSTED" },
    );
    assert.equal(wrapperRunner.calls.length, 0);
  }
});

test("rejects external repository metadata and linked loose objects before invoking Git", async (t) => {
  const pointer = await fixture(t);
  const pointerRunner = fakeRunner(pointer.sourceRoot);
  await rm(path.join(pointer.sourceRoot, ".git"), {
    recursive: true,
    force: true,
  });
  await writeFile(
    path.join(pointer.sourceRoot, ".git"),
    "gitdir: //server/share/repository.git\n",
  );
  await assert.rejects(
    snapshotter(pointerRunner).preflight({ sourceRoot: pointer.sourceRoot }),
    { code: "GIT_SNAPSHOT_ROOT_MISMATCH" },
  );
  assert.equal(pointerRunner.calls.length, 0);

  const loose = await fixture(t);
  const looseRunner = fakeRunner(loose.sourceRoot);
  const fanout = path.join(loose.sourceRoot, ".git", "objects", "aa");
  const externalObject = path.join(loose.root, "external-object");
  await mkdir(fanout);
  await writeFile(externalObject, "external object bytes");
  let looseLinkCreated = false;
  try {
    await symlink(
      externalObject,
      path.join(fanout, "b".repeat(38)),
      process.platform === "win32" ? "file" : undefined,
    );
    looseLinkCreated = true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.diagnostic("symlink privilege unavailable; loose object case skipped");
    } else {
      throw error;
    }
  }
  if (looseLinkCreated) {
    await assert.rejects(
      snapshotter(looseRunner).preflight({ sourceRoot: loose.sourceRoot }),
      { code: "GIT_SNAPSHOT_OBJECT_STORE_UNSAFE" },
    );
    assert.equal(looseRunner.calls.length, 0);
  }

  if (process.platform === "win32") {
    const local = await fixture(t);
    const localRunner = fakeRunner(local.sourceRoot);
    await assert.rejects(
      snapshotter(localRunner).preflight({
        sourceRoot: "\\\\server\\share\\repository",
      }),
      { code: "GIT_SNAPSHOT_ROOT_MISMATCH" },
    );
    assert.equal(localRunner.calls.length, 0);
  }
});

test("an asynchronous caller mutation cannot change the captured repository, Head, exclusions, or boundary", async (t) => {
  const first = await fixture(t);
  const other = await fixture(t);
  let mutableRequest = null;
  let mutated = false;
  const runner = fakeRunner(first.sourceRoot, {
    override(request) {
      if (
        mutableRequest &&
        !mutated &&
        request.args.includes("--show-object-format")
      ) {
        mutated = true;
        mutableRequest.sourceRoot = other.sourceRoot;
        mutableRequest.targetRoot = other.targetRoot;
        mutableRequest.headOid = "9".repeat(40);
        mutableRequest.excludePaths.push("src");
        mutableRequest.expectedBoundaryDigest = "0".repeat(64);
        mutableRequest.expectedGitCommand = other.gitCommand;
        mutableRequest.expectedGitExecutableSha256 = "0".repeat(64);
        mutableRequest.expectedGitExecutableBytes = 9;
        mutableRequest.expectedGitExecutableMode = 0;
        mutableRequest.expectedGitExecutableUid = 9;
        mutableRequest.expectedGitExecutableGid = 9;
      }
    },
  });
  const service = snapshotter(runner);
  const boundary = await service.preflight({ sourceRoot: first.sourceRoot });
  mutableRequest = {
    sourceRoot: first.sourceRoot,
    targetRoot: first.targetRoot,
    headOid: HEAD,
    excludePaths: [],
    expectedBoundaryDigest: boundary.boundaryDigest,
    expectedGitCommand: boundary.gitCommand,
    expectedGitExecutableSha256: boundary.gitExecutableSha256,
    expectedGitExecutableBytes: boundary.gitExecutableBytes,
    expectedGitExecutableMode: boundary.gitExecutableMode,
    expectedGitExecutableUid: boundary.gitExecutableUid,
    expectedGitExecutableGid: boundary.gitExecutableGid,
  };

  const result = await service.materialize(mutableRequest);

  assert.equal(mutated, true);
  assert.equal(result.headOid, HEAD);
  assert.equal(
    await readFile(path.join(first.targetRoot, "src", "app.js"), "utf8"),
    APP_CONTENT.toString("utf8"),
  );
  assert.deepEqual(await readdirNames(other.targetRoot), []);
  const materializationCalls = runner.calls.slice(
    runner.calls.findLastIndex((call) => call.args.includes("--show-object-format")),
  );
  assert.equal(
    runner.calls
      .filter((call) => call.args.includes("cat-file") && call.args.includes("-t"))
      .at(-1).args.includes(HEAD),
    true,
  );
  assert.equal(
    runner.calls
      .filter((call) => call.args.includes("ls-tree"))
      .at(-1).args.includes(HEAD),
    true,
  );
  assert.equal(materializationCalls.length > 0, true);
});

test("materialization rejects changed boundaries, missing objects, and blob identity mismatches", async (t) => {
  const { root, sourceRoot } = await fixture(t);

  const boundaryRunner = fakeRunner(sourceRoot);
  const boundaryService = snapshotter(boundaryRunner);
  const boundary = await boundaryService.preflight({ sourceRoot });
  const boundaryTarget = path.join(root, "boundary-target");
  await mkdir(boundaryTarget);
  await assert.rejects(
    boundaryService.materialize({
      sourceRoot,
      targetRoot: boundaryTarget,
      headOid: HEAD,
      excludePaths: [],
      expectedBoundaryDigest: "0".repeat(64),
      expectedGitCommand: boundary.gitCommand,
      expectedGitExecutableSha256: boundary.gitExecutableSha256,
      expectedGitExecutableBytes: boundary.gitExecutableBytes,
      expectedGitExecutableMode: boundary.gitExecutableMode,
      expectedGitExecutableUid: boundary.gitExecutableUid,
      expectedGitExecutableGid: boundary.gitExecutableGid,
    }),
    { code: "GIT_SNAPSHOT_BOUNDARY_MISMATCH" },
  );

  for (const [name, blobs, code] of [
    ["missing", new Map(), "GIT_SNAPSHOT_PROTOCOL_ERROR"],
    [
      "mismatch",
      new Map([[BLOB_A, Buffer.from("export const value = 2;\n")]]),
      "GIT_SNAPSHOT_OBJECT_MISMATCH",
    ],
  ]) {
    const targetRoot = path.join(root, `${name}-target`);
    await mkdir(targetRoot);
    await assert.rejects(
      materialize(snapshotter(fakeRunner(sourceRoot, { blobs })), {
        sourceRoot,
        targetRoot,
        headOid: HEAD,
        excludePaths: [],
      }),
      { code },
    );
    assert.deepEqual(await readdirNames(targetRoot), []);
  }
});

test("supports SHA-256 repositories while keeping Head and blob widths exact", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  const headOid = "4".repeat(64);
  const content = Buffer.from("sha256 repository\n");
  const oid = blobOid(content, "sha256");
  const runner = fakeRunner(sourceRoot, {
    objectFormat: "sha256",
    treeOutput: tree([{ path: "src/value.txt", oid }]),
    blobs: new Map([[oid, content]]),
  });
  const service = snapshotter(runner);
  const boundary = await service.preflight({ sourceRoot });

  assert.equal(boundary.objectFormat, "sha256");
  assert.equal(boundary.oidLength, 64);
  const result = await service.materialize({
    sourceRoot,
    targetRoot,
    headOid,
    excludePaths: [],
    expectedBoundaryDigest: boundary.boundaryDigest,
    expectedGitCommand: boundary.gitCommand,
    expectedGitExecutableSha256: boundary.gitExecutableSha256,
    expectedGitExecutableBytes: boundary.gitExecutableBytes,
    expectedGitExecutableMode: boundary.gitExecutableMode,
    expectedGitExecutableUid: boundary.gitExecutableUid,
    expectedGitExecutableGid: boundary.gitExecutableGid,
  });
  assert.equal(result.headOid, headOid);
  assert.deepEqual(await readFile(path.join(targetRoot, "src", "value.txt")), content);
});

test("rejects symlinks, gitlinks, unsafe names, invalid UTF-8, and portable path collisions", async (t) => {
  const { root, sourceRoot } = await fixture(t);
  const unsafeTrees = [
    tree([{ path: "src/link", mode: "120000" }]),
    tree([{ path: "vendor/module", mode: "160000" }]),
    tree([{ path: "CON/file.js" }]),
    tree([{ path: "src/evil?.js" }]),
    tree([{ path: "src/line\nbreak.js" }]),
    tree([{ path: "src/\u202eevil.js" }]),
    tree([{ path: Buffer.from([0x73, 0x72, 0x63, 0x2f, 0xff]) }]),
    tree([{ path: "Src/app.js" }, { path: "src/other.js", oid: BLOB_B }]),
    tree([{ path: "src/cafe\u0301.js" }]),
    tree([{ path: "same.js" }, { path: "same.js" }]),
    tree([{ path: `${"x".repeat(256)}.js` }]),
    tree([{ path: `${Array.from({ length: 129 }, () => "d").join("/")}/file.js` }]),
  ];

  for (let index = 0; index < unsafeTrees.length; index += 1) {
    const targetRoot = path.join(root, `unsafe-${index}`);
    await mkdir(targetRoot);
    await assert.rejects(
      materialize(snapshotter(
        fakeRunner(sourceRoot, { treeOutput: unsafeTrees[index] }),
      ), {
        sourceRoot,
        targetRoot,
        headOid: HEAD,
        excludePaths: [],
      }),
      (error) =>
        error instanceof GitObjectSnapshotterError &&
        [
          "GIT_SNAPSHOT_UNSUPPORTED_ENTRY",
          "GIT_SNAPSHOT_INVALID_PATH",
          "GIT_SNAPSHOT_PATH_COLLISION",
        ].includes(error.code),
    );
    assert.deepEqual(await readdirNames(targetRoot), []);
  }

  const excludedLinkTarget = path.join(root, "excluded-link");
  await mkdir(excludedLinkTarget);
  await assert.rejects(
    materialize(snapshotter(fakeRunner(sourceRoot, {
      treeOutput: tree([{ path: "vendor/link", mode: "120000" }]),
    })), {
      sourceRoot,
      targetRoot: excludedLinkTarget,
      headOid: HEAD,
      excludePaths: ["vendor"],
    }),
    { code: "GIT_SNAPSHOT_UNSUPPORTED_ENTRY" },
  );
  assert.deepEqual(await readdirNames(excludedLinkTarget), []);
});

test("rollback removes only snapshot-owned output and preserves a concurrent foreign file", async (t) => {
  const { sourceRoot, targetRoot } = await fixture(t);
  let injectConflict = false;
  const runner = fakeRunner(sourceRoot, {
    treeOutput: tree([
      { path: "a.txt", oid: BLOB_A },
      { path: "z.txt", oid: BLOB_A },
    ]),
    override(request) {
      if (injectConflict && request.args.includes("--batch")) {
        injectConflict = false;
        return writeFile(path.join(targetRoot, "z.txt"), "conflict").then(
          () => undefined,
        );
      }
    },
  });
  const service = snapshotter(runner);
  const boundary = await service.preflight({ sourceRoot });
  injectConflict = true;

  await assert.rejects(
    service.materialize({
      sourceRoot,
      targetRoot,
      headOid: HEAD,
      excludePaths: [],
      expectedBoundaryDigest: boundary.boundaryDigest,
      expectedGitCommand: boundary.gitCommand,
      expectedGitExecutableSha256: boundary.gitExecutableSha256,
      expectedGitExecutableBytes: boundary.gitExecutableBytes,
      expectedGitExecutableMode: boundary.gitExecutableMode,
      expectedGitExecutableUid: boundary.gitExecutableUid,
      expectedGitExecutableGid: boundary.gitExecutableGid,
    }),
    { code: "GIT_SNAPSHOT_CLEANUP_FAILED" },
  );
  assert.deepEqual(await readdirNames(targetRoot), ["z.txt"]);
  assert.equal(await readFile(path.join(targetRoot, "z.txt"), "utf8"), "conflict");
  await assert.rejects(readFile(path.join(targetRoot, "a.txt")), {
    code: "ENOENT",
  });
});

test("enforces file count, per-file, total, and tree metadata limits before writes", async (t) => {
  const { root, sourceRoot } = await fixture(t);
  const twoAs = Buffer.from("aa");
  const twoBs = Buffer.from("bb");
  const twoAsOid = blobOid(twoAs);
  const twoBsOid = blobOid(twoBs);
  const cases = [
    {
      limits: { maxFiles: 1 },
      treeOutput: tree([
        { path: "a.js", oid: BLOB_A },
        { path: "b.js", oid: BLOB_B },
      ]),
      blobs: new Map([
        [BLOB_A, Buffer.from("a")],
        [BLOB_B, Buffer.from("b")],
      ]),
      code: "FILE_COUNT_LIMIT",
    },
    {
      limits: { maxFileBytes: 3 },
      treeOutput: tree([{ path: "a.js", oid: BLOB_A }]),
      blobs: new Map([[BLOB_A, Buffer.from("four")]]),
      code: "FILE_SIZE_LIMIT",
    },
    {
      limits: { maxTotalBytes: 3 },
      treeOutput: tree([
        { path: "a.js", oid: twoAsOid },
        { path: "b.js", oid: twoBsOid },
      ]),
      blobs: new Map([
        [twoAsOid, twoAs],
        [twoBsOid, twoBs],
      ]),
      code: "TOTAL_SIZE_LIMIT",
    },
    {
      limits: { maxTotalBytes: 3 },
      treeOutput: tree([
        { path: "a.js", oid: twoAsOid },
        { path: "b.js", oid: twoAsOid },
      ]),
      blobs: new Map([[twoAsOid, twoAs]]),
      code: "TOTAL_SIZE_LIMIT",
    },
    {
      limits: { maxTreeBytes: 8 },
      treeOutput: tree([{ path: "a.js", oid: BLOB_A }]),
      blobs: new Map([[BLOB_A, Buffer.from("a")]]),
      code: "GIT_SNAPSHOT_PROCESS_FAILED",
      truncateTree: true,
    },
    {
      limits: { maxDirectories: 1 },
      treeOutput: tree([
        { path: "first/a.js", oid: BLOB_A },
        { path: "second/b.js", oid: BLOB_A },
      ]),
      blobs: new Map([[BLOB_A, Buffer.from("a")]]),
      code: "GIT_DIRECTORY_COUNT_LIMIT",
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const current = cases[index];
    const targetRoot = path.join(root, `limit-${index}`);
    await mkdir(targetRoot);
    const runner = fakeRunner(sourceRoot, {
      treeOutput: current.treeOutput,
      blobs: current.blobs,
      ...(current.truncateTree
        ? {
            override(request) {
              if (request.args.includes("ls-tree")) {
                return output(current.treeOutput, { truncated: true });
              }
            },
          }
        : {}),
    });
    await assert.rejects(
      materialize(snapshotter(runner, current.limits), {
        sourceRoot,
        targetRoot,
        headOid: HEAD,
        excludePaths: [],
      }),
      (error) => error.code === current.code,
    );
    assert.deepEqual(await readdirNames(targetRoot), []);
  }
});

test("requires exact data requests, canonical roots, and canonical exclusions", async (t) => {
  const { root, sourceRoot, targetRoot } = await fixture(t);
  const runner = fakeRunner(sourceRoot);
  const service = snapshotter(runner);
  let getterCalls = 0;
  const accessor = {
    sourceRoot,
    targetRoot,
    headOid: HEAD,
    excludePaths: [],
  };
  Object.defineProperty(accessor, "headOid", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return HEAD;
    },
  });

  await assert.rejects(service.materialize(accessor), {
    code: "INVALID_GIT_SNAPSHOT_REQUEST",
  });
  assert.equal(getterCalls, 0);
  const exclusions = [];
  Object.defineProperty(exclusions, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "private";
    },
  });
  exclusions.length = 1;
  await assert.rejects(
    materialize(service, {
      sourceRoot,
      targetRoot,
      headOid: HEAD,
      excludePaths: exclusions,
    }),
    { code: "INVALID_GIT_SNAPSHOT_REQUEST" },
  );
  assert.equal(getterCalls, 0);

  const occupied = path.join(root, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep.txt"), "keep");
  await assert.rejects(
    materialize(service, {
      sourceRoot,
      targetRoot: occupied,
      headOid: HEAD,
      excludePaths: [],
    }),
    { code: "GIT_SNAPSHOT_TARGET_UNAVAILABLE" },
  );
  assert.equal(await readFile(path.join(occupied, "keep.txt"), "utf8"), "keep");

  const overlapping = path.join(sourceRoot, "execution");
  await mkdir(overlapping);
  await assert.rejects(
    materialize(service, {
      sourceRoot,
      targetRoot: overlapping,
      headOid: HEAD,
      excludePaths: [],
    }),
    { code: "GIT_SNAPSHOT_TARGET_UNAVAILABLE" },
  );
  assert.deepEqual(await readdirNames(overlapping), []);

  const linked = path.join(root, "linked");
  try {
    await symlink(targetRoot, linked, "junction");
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }
  await assert.rejects(
    materialize(service, {
      sourceRoot,
      targetRoot: linked,
      headOid: HEAD,
      excludePaths: [],
    }),
    { code: "GIT_SNAPSHOT_TARGET_UNAVAILABLE" },
  );
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

async function readdirNames(directory) {
  return readdir(directory);
}
