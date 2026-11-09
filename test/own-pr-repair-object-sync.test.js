import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

import { OwnPrRepairObjectSync } from "../src/adapters/own-pr-repair-object-sync.js";
import { createCredentialLease } from "../src/lib/github-credential-source.js";
import { ManagedProcess, ManagedProcessRunner } from "../src/lib/managed-process.js";
import { pullRequestExternalActionBinding } from "./support/pull-request-external-action-fixture.js";

const execFile = promisify(execFileCallback);
const TOKEN = "ghp_object_sync_secret";
const REMOTE = "https://github.com/acme/repo.git";

function locateGit() {
  const found = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  const candidate = found.stdout?.split(/\r?\n/u).find(Boolean);
  if (found.status !== 0 || !candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return candidate;
  return windowsGitImplementationCandidates(candidate).find(existsSync) ?? null;
}

const gitCommand = locateGit();
const realGit = { skip: gitCommand === null ? "Git is unavailable" : false };

async function git(cwd, args) {
  return execFile(gitCommand, ["-c", "core.autocrlf=false", ...args], {
    cwd, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "own-pr-repair-object-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  const sourceRoot = path.join(root, "source");
  const mirrorRoot = path.join(root, "mirror.git");
  const baseMirrorRoot = path.join(root, "base.git");
  await mkdir(remote);
  await git(remote, ["init", "--initial-branch=main"]);
  await git(remote, ["config", "user.name", "Object Sync Test"]);
  await git(remote, ["config", "user.email", "object-sync@example.invalid"]);
  await writeFile(path.join(remote, "tracked.txt"), "baseline\n");
  await git(remote, ["add", "tracked.txt"]);
  await git(remote, ["commit", "-m", "baseline"]);
  const baseOid = (await git(remote, ["rev-parse", "HEAD"])).stdout.trim();
  await git(root, ["clone", "--no-hardlinks", remote, sourceRoot]);
  await git(root, ["clone", "--bare", "--no-hardlinks", remote, mirrorRoot]);
  await git(root, ["clone", "--bare", "--no-hardlinks", remote, baseMirrorRoot]);
  await writeFile(path.join(remote, "tracked.txt"), "head objects\n");
  await git(remote, ["add", "tracked.txt"]);
  await git(remote, ["commit", "-m", "new head"]);
  const headOid = (await git(remote, ["rev-parse", "HEAD"])).stdout.trim();
  // Fetch must bind to the requested OID even when the remote branch has moved.
  await writeFile(path.join(remote, "tracked.txt"), "later remote head\n");
  await git(remote, ["add", "tracked.txt"]);
  await git(remote, ["commit", "-m", "later head"]);
  const laterOid = (await git(remote, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(sourceRoot, "tracked.txt"), "staged changes\n");
  await git(sourceRoot, ["add", "tracked.txt"]);
  await writeFile(path.join(sourceRoot, "tracked.txt"), "unstaged changes\n");
  await writeFile(path.join(sourceRoot, "untracked.txt"), "untracked changes\n");
  await writeFile(path.join(sourceRoot, ".git", "FETCH_HEAD"), "keep source fetch head\n");
  await writeFile(path.join(mirrorRoot, "FETCH_HEAD"), "keep mirror fetch head\n");
  const configuration = {
    githubActions: { actorAccountId: "runtime-user" },
    workCoordination: { policy: { workspaceByRepository: { "acme/repo": "repo" } } },
    codeExecutor: {
      gitCommand, gitTimeoutMs: 60_000,
      workspaces: [{ id: "repo", sourceRoot, gitHeadSnapshot: true }],
      conflictPreparation: { enabled: true, headMirrorsByRepository: { "acme/repo": mirrorRoot },
        baseMirrorsByRepository: { "acme/repo": baseMirrorRoot } },
    },
  };
  const inputBinding = pullRequestExternalActionBinding({ gitTarget: {
    headRepository: "acme/repo", baseRefOid: baseOid, headRefOid: headOid,
  } });
  const calls = [];
  const managed = new ManagedProcessRunner();
  const processRunner = {
    async run(request) {
      calls.push({ ...request, args: [...request.args], env: { ...request.env } });
      if (!request.args.includes("fetch")) return managed.run(request);
      assert.equal(request.args.at(-2), REMOTE);
      assert.equal(request.args.at(-1), request.cwd === baseMirrorRoot ? laterOid : headOid);
      // Only this test transport substitutes a local repository. Production
      // always uses the fixed HTTPS URL and disables the file protocol.
      return managed.run({ ...request, args: [
        "-c", "protocol.file.allow=always",
        ...request.args.map((arg) => arg === REMOTE ? remote : arg),
      ] });
    },
  };
  const acquired = [];
  const leases = [];
  const credentialSource = { async acquire(request) {
    acquired.push(request);
    const lease = createCredentialLease(TOKEN);
    leases.push(lease);
    return lease;
  } };
  return { root, remote, sourceRoot, mirrorRoot, baseMirrorRoot, headOid, laterOid, configuration,
    inputBinding, calls, acquired, leases, processRunner, credentialSource };
}

async function preservedState(s) {
  const files = [
    path.join(s.sourceRoot, "tracked.txt"), path.join(s.sourceRoot, "untracked.txt"),
    path.join(s.sourceRoot, ".git", "index"), path.join(s.sourceRoot, ".git", "config"),
    path.join(s.sourceRoot, ".git", "HEAD"), path.join(s.sourceRoot, ".git", "FETCH_HEAD"),
    path.join(s.mirrorRoot, "config"), path.join(s.mirrorRoot, "HEAD"), path.join(s.mirrorRoot, "FETCH_HEAD"),
  ];
  return {
    files: await Promise.all(files.map((file) => readFile(file))),
    sourceRefs: (await git(s.sourceRoot, ["show-ref", "--head"])).stdout,
    mirrorRefs: (await git(s.mirrorRoot, ["show-ref", "--head"])).stdout,
    sourceEntries: await readdir(s.sourceRoot), mirrorEntries: await readdir(s.mirrorRoot),
  };
}

test("fetches exact Head into both local stores without changing checkout, index, refs or config", realGit, async (t) => {
  const s = await fixture(t);
  for (const cwd of [s.sourceRoot, s.mirrorRoot]) {
    await git(cwd, ["config", "fetch.prune", "true"]);
    await git(cwd, ["config", "fetch.pruneTags", "true"]);
    await git(cwd, ["tag", "keep-local-tag", "HEAD"]);
  }
  const before = await preservedState(s);
  const sync = new OwnPrRepairObjectSync(s);
  const result = await sync.prepare(s);
  assert.equal(result.headRefOid, s.headOid);
  assert.deepEqual(result.fetchedRoots, [s.sourceRoot, s.mirrorRoot]);
  assert.deepEqual(await preservedState(s), before);
  for (const cwd of [s.sourceRoot, s.mirrorRoot]) {
    assert.equal((await git(cwd, ["cat-file", "-t", s.headOid])).stdout.trim(), "commit");
    assert.equal((await git(cwd, ["show", `${s.headOid}:tracked.txt`])).stdout, "head objects\n");
    await assert.rejects(git(cwd, ["cat-file", "-e", s.laterOid]));
  }
  const fetches = s.calls.filter(({ args }) => args.includes("fetch"));
  assert.equal(fetches.length, 2);
  assert.equal(s.acquired.length, 1);
  assert.equal(s.acquired[0].actorAccountId, "runtime-user");
  assert.ok(s.acquired[0].signal instanceof AbortSignal);
  assert.ok(Number.isSafeInteger(s.acquired[0].deadline));
  for (const call of fetches) {
    assert.equal(JSON.stringify(call.args).includes(TOKEN), false);
    assert.equal(call.env.GIT_CONFIG_KEY_0, "http.extraheader");
    assert.equal(call.env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
    assert.equal(call.env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    assert.ok(call.args.includes("--no-write-fetch-head"));
    assert.ok(call.args.includes("--refmap="));
    assert.ok(call.args.includes("--no-prune"));
    assert.ok(call.args.includes("--no-prune-tags"));
    assert.ok(call.args.includes("http.followRedirects=false"));
    assert.ok(call.args.includes("core.askPass="));
    assert.ok(call.args.includes("credential.helper="));
    assert.equal(call.env.GIT_ASKPASS, "");
    assert.equal(call.signal, s.acquired[0].signal);
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 300_000);
  }
  for (const call of s.calls) {
    assert.equal(call.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(call.env.GIT_NO_REPLACE_OBJECTS, "1");
  }
  const beforeRepeat = s.calls.length;
  assert.deepEqual((await sync.prepare(s)).fetchedRoots, []);
  assert.equal(s.calls.slice(beforeRepeat).some(({ args }) => args.includes("fetch")), false);
  assert.equal(s.acquired.length, 1);
  await assert.rejects(s.leases[0].use(() => {}), /unavailable/u);
});

test("synchronizes the bound live Base into its separate mirror before automatic conflict repair", realGit, async (t) => {
  const s = await fixture(t);
  s.inputBinding = structuredClone(s.inputBinding);
  s.inputBinding.gitTarget.baseRefOid = s.laterOid;
  const before = { refs: (await git(s.baseMirrorRoot, ["show-ref", "--head"])).stdout,
    config: await readFile(path.join(s.baseMirrorRoot, "config")), head: await readFile(path.join(s.baseMirrorRoot, "HEAD")) };
  const sync = new OwnPrRepairObjectSync(s);
  t.after(() => sync.close());
  const result = await sync.prepare(s);
  assert.ok(result.fetchedRoots.includes(s.baseMirrorRoot));
  assert.equal((await git(s.baseMirrorRoot, ["cat-file", "-t", s.laterOid])).stdout.trim(), "commit");
  assert.deepEqual({ refs: (await git(s.baseMirrorRoot, ["show-ref", "--head"])).stdout,
    config: await readFile(path.join(s.baseMirrorRoot, "config")), head: await readFile(path.join(s.baseMirrorRoot, "HEAD")) }, before);
  assert.deepEqual((await sync.prepare(s)).fetchedRoots, []);
});

test("fetches only the store missing the bound commit, including an explicitly configured fork", realGit, async (t) => {
  const s = await fixture(t);
  await git(s.mirrorRoot, ["fetch", "--no-write-fetch-head", "--no-tags", s.remote, s.headOid]);
  const sync = new OwnPrRepairObjectSync(s);
  assert.deepEqual((await sync.prepare(s)).fetchedRoots, [s.sourceRoot]);
  assert.equal(s.calls.filter(({ args }) => args.includes("fetch")).length, 1);

  const forkRequest = structuredClone({ configuration: s.configuration, inputBinding: s.inputBinding });
  forkRequest.inputBinding.gitTarget.headRepository = "runtime-user/fork";
  forkRequest.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository = {
    "runtime-user/fork": s.mirrorRoot,
  };
  assert.deepEqual((await sync.prepare(forkRequest)).fetchedRoots, []);
  assert.equal(s.acquired.length, 1);

  const secondMirror = path.join(s.root, "second-mirror.git");
  await git(s.root, ["clone", "--bare", "--no-local", s.sourceRoot, secondMirror]);
  s.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = secondMirror;
  assert.deepEqual((await sync.prepare(s)).fetchedRoots, [secondMirror]);
  assert.equal(s.calls.filter(({ args }) => args.includes("fetch")).length, 2);
});

for (const headStorage of ["loose", "packed", "detached"]) {
  test(`prepares exact Head with a valid hash-containing mirror ref (${headStorage})`, realGit, async (t) => {
    const s = await fixture(t);
    const baseOid = (await git(s.mirrorRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (headStorage === "detached") {
      await writeFile(path.join(s.mirrorRoot, "HEAD"), `${baseOid}\n`);
    } else {
      const ref = "refs/heads/S#desc/fda-protocol-search-sql-layer";
      await git(s.mirrorRoot, ["update-ref", ref, baseOid]);
      await git(s.mirrorRoot, ["symbolic-ref", "HEAD", ref]);
      if (headStorage === "packed") await git(s.mirrorRoot, ["pack-refs", "--all", "--prune"]);
    }
    const before = await preservedState(s);
    const sync = new OwnPrRepairObjectSync(s);
    assert.deepEqual((await sync.prepare(s)).fetchedRoots, [s.sourceRoot, s.mirrorRoot]);
    assert.deepEqual(await preservedState(s), before);
    for (const cwd of [s.sourceRoot, s.mirrorRoot]) {
      assert.equal((await git(cwd, ["cat-file", "-t", s.headOid])).stdout.trim(), "commit");
    }
  });
}

test("rejects malformed and escaping mirror HEAD refs before credentials or fetch", realGit, async (t) => {
  const s = await fixture(t);
  const sync = new OwnPrRepairObjectSync(s);
  for (const ref of [
    "refs/heads/S#desc/../main",
    "refs/heads//main",
    "refs/heads/.hidden",
    "refs/heads/main.lock",
    "refs/heads/main\\escape",
    "refs/heads/main\0suffix",
    "refs/heads/main\nref: refs/heads/other",
    "/refs/heads/main",
  ]) {
    const head = `ref: ${ref}\n`;
    await writeFile(path.join(s.mirrorRoot, "HEAD"), head);
    await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED" });
    assert.equal(await readFile(path.join(s.mirrorRoot, "HEAD"), "utf8"), head);
  }
  assert.equal(s.calls.some(({ args }) => args.includes("fetch")), false);
  assert.equal(s.acquired.length, 0);
});

test("rejects malformed bindings, mismatched actors, unconfigured repositories and invalid paths before Git or credentials", realGit, async (t) => {
  const s = await fixture(t);
  const mutations = [
    (r) => { r.inputBinding.schemaVersion = 1; delete r.inputBinding.gitTarget; },
    (r) => { r.inputBinding.gitTarget.sourceAccountId = "other-author"; },
    (r) => { r.configuration.githubActions.actorAccountId = "bad\nauthor"; },
    (r) => { r.inputBinding.gitTarget.headRepository = "https://evil.invalid/repo"; },
    (r) => { r.inputBinding.gitTarget.headRepository = "acme/../repo"; },
    (r) => { r.inputBinding.gitTarget.headRepository = "acme/unconfigured"; },
    (r) => { r.inputBinding.headRefOid = "-untrusted"; r.inputBinding.gitTarget.headRefOid = "-untrusted"; },
    (r) => { r.configuration.codeExecutor.gitCommand = "git"; },
    (r) => { r.configuration.codeExecutor.workspaces[0].sourceRoot = "relative/root"; },
    (r) => { r.configuration.codeExecutor.workspaces[0].gitHeadSnapshot = false; },
    (r) => { r.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = s.sourceRoot; },
    (r) => { r.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = "\\\\server\\share"; },
    (r) => { r.configuration.codeExecutor.conflictPreparation.enabled = false; },
    (r) => { r.configuration.codeExecutor.gitTimeoutMs = 60_001; },
  ];
  const sync = new OwnPrRepairObjectSync(s);
  for (const mutate of mutations) {
    const request = structuredClone({ configuration: s.configuration, inputBinding: s.inputBinding });
    mutate(request);
    await assert.rejects(sync.prepare(request), { code: "OWN_PR_REPAIR_OBJECT_INPUT_INVALID" });
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.acquired.length, 0);
});

test("preflights both roots before fetching missing objects and rejects unsafe transport configuration", realGit, async (t) => {
  const s = await fixture(t);
  const sync = new OwnPrRepairObjectSync(s);
  for (const [cwd, key, value] of [
    [s.mirrorRoot, "include.path", path.join(s.root, "not-trusted")],
    [s.mirrorRoot, "remote.origin.promisor", "true"],
    [s.mirrorRoot, "http.extraHeader", `Authorization: ${TOKEN}`],
    [s.sourceRoot, "url.https://evil.invalid/.insteadOf", "https://github.com/"],
    [s.sourceRoot, "credential.helper", "!echo untrusted"],
  ]) {
    await git(cwd, ["config", key, value]);
    const before = await preservedState(s);
    try {
      await assert.rejects(sync.prepare(s), (error) => {
        assert.equal(error.code, "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
        assert.equal(inspect(error, { depth: 10 }).includes(TOKEN), false);
        return true;
      });
      assert.deepEqual(await preservedState(s), before);
    } finally {
      await git(cwd, ["config", "--unset-all", key]);
    }
  }
  assert.equal(s.calls.some(({ args }) => args.includes("fetch")), false);
  assert.equal(s.acquired.length, 0);
});

test("rejects ordinary repositories used as mirrors and missing root/HEAD boundaries", realGit, async (t) => {
  const s = await fixture(t);
  const sync = new OwnPrRepairObjectSync(s);
  for (const mutate of [
    (r) => { r.configuration.codeExecutor.workspaces[0].sourceRoot = path.join(s.root, "missing-source"); },
    (r) => { r.configuration.codeExecutor.workspaces[0].sourceRoot = s.mirrorRoot; r.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = s.remote; },
    (r) => { r.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = s.remote; },
    (r) => { r.configuration.codeExecutor.conflictPreparation.headMirrorsByRepository["acme/repo"] = path.join(s.root, "missing-mirror"); },
  ]) {
    const request = structuredClone({ configuration: s.configuration, inputBinding: s.inputBinding });
    mutate(request);
    await assert.rejects(sync.prepare(request), { code: "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED" });
  }
  await writeFile(path.join(s.mirrorRoot, "HEAD"), "ref: refs/heads/missing\n");
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED" });
  assert.equal(s.calls.some(({ args }) => args.includes("fetch")), false);
  assert.equal(s.acquired.length, 0);
});

test("sanitizes credential and Git failures, clears ephemeral authentication and consumes the lease", realGit, async (t) => {
  const s = await fixture(t);
  let childEnvironment;
  const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: {
    async run(request) {
      if (!request.args.includes("fetch")) return s.processRunner.run(request);
      childEnvironment = request.env;
      const error = new Error(`Git failed with ${TOKEN} ${encoded}`);
      error.details = { stdout: TOKEN, stderr: encoded, request };
      throw error;
    },
  } });
  const before = await preservedState(s);
  await assert.rejects(sync.prepare(s), (error) => {
    assert.equal(error.code, "OWN_PR_REPAIR_OBJECT_FETCH_FAILED");
    assert.equal(inspect(error, { depth: 10 }).includes(TOKEN), false);
    assert.equal(inspect(error, { depth: 10 }).includes(encoded), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "details"), false);
    return true;
  });
  assert.equal(childEnvironment.GIT_CONFIG_VALUE_1, undefined);
  assert.equal(childEnvironment.GIT_CONFIG_COUNT, "0");
  assert.deepEqual(await preservedState(s), before);
  await assert.rejects(s.leases[0].use(() => {}), /unavailable/u);

  const missingCredential = new OwnPrRepairObjectSync({ ...s, credentialSource: {
    async acquire() { throw new Error(TOKEN); },
  } });
  await assert.rejects(missingCredential.prepare(s), (error) => {
    assert.equal(error.code, "OWN_PR_REPAIR_OBJECT_CREDENTIAL_FAILED");
    assert.equal(inspect(error).includes(TOKEN), false);
    return true;
  });

  for (const exitCode of [0, 128]) {
    const failedFetch = new OwnPrRepairObjectSync({ ...s, processRunner: {
      async run(request) {
        if (!request.args.includes("fetch")) return s.processRunner.run(request);
        return { exitCode, signal: null, truncated: false, stdout: TOKEN, stderr: encoded };
      },
    } });
    await assert.rejects(failedFetch.prepare(s), (error) => {
      assert.equal(error.code, "OWN_PR_REPAIR_OBJECT_FETCH_FAILED");
      assert.equal(inspect(error, { depth: 10 }).includes(TOKEN), false);
      assert.equal(inspect(error, { depth: 10 }).includes(encoded), false);
      return true;
    });
  }
});

test("object downloads can outlive the local Git inspection deadline without losing their bound", realGit, async (t) => {
  const s = await fixture(t);
  s.configuration.codeExecutor.gitTimeoutMs = 1_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let fetches = 0;
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: { async run(request) {
    if (request.args.includes("fetch")) {
      fetches += 1;
      t.mock.timers.tick(30_001);
      assert.equal(request.signal.aborted, false, "an active download must survive the metadata deadline");
      assert.equal(request.timeoutMs, 300_000);
    } else {
      assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 1_000);
    }
    return s.processRunner.run(request);
  } } });
  await sync.prepare(s);
  assert.equal(fetches, 2);
  await sync.close();
});

test("three-store preflight does not consume a later fetch command's network timeout", realGit, async (t) => {
  const s = await fixture(t);
  s.configuration.codeExecutor.gitTimeoutMs = 1_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let delayed = false;
  let fetches = 0;
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: { async run(request) {
    if (!delayed) { delayed = true; t.mock.timers.tick(800); }
    if (request.args.includes("fetch")) {
      fetches += 1;
      assert.equal(request.timeoutMs, 300_000);
    }
    return s.processRunner.run(request);
  } } });
  await sync.prepare(s);
  assert.equal(fetches, 2);
  await sync.close();
});

test("object download allowance still aborts the entire preparation at its finite deadline", realGit, async (t) => {
  const s = await fixture(t);
  s.configuration.codeExecutor.gitTimeoutMs = 1_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let cancelled = false;
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: { async run(request) {
    if (!request.args.includes("fetch")) return s.processRunner.run(request);
    request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
    // This fixture has exactly two missing stores. No retry can extend again.
    t.mock.timers.tick(2 * 300_000 + 3 * 1_000 + 1);
    assert.equal(request.signal.aborted, true);
    throw Object.assign(new Error(TOKEN), { code: "PROCESS_ABORTED" });
  } } });
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_TIMEOUT" });
  assert.equal(cancelled, true);
  await assert.rejects(s.leases[0].use(() => {}), /unavailable/u);
  await sync.close();
});

test("three missing stores at the largest metadata timeout leave cleanup time before the runner lease", realGit, async (t) => {
  const s = await fixture(t);
  s.configuration.codeExecutor.gitTimeoutMs = 60_000;
  s.inputBinding.gitTarget.baseRefOid = s.laterOid;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const startedAt = Date.now();
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: { async run(request) {
    if (!request.args.includes("fetch")) return s.processRunner.run(request);
    assert.equal(s.acquired[0].deadline - startedAt, 17 * 60_000);
    assert.equal(request.timeoutMs, 300_000);
    t.mock.timers.tick(17 * 60_000 + 1);
    assert.equal(request.signal.aborted, true);
    throw Object.assign(new Error(TOKEN), { code: "PROCESS_ABORTED" });
  } } });
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_TIMEOUT" });
  await sync.close();
});

test("the host's remaining preparation budget also bounds local inspections and object downloads", realGit, async (t) => {
  const s = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const startedAt = Date.now();
  const sync = new OwnPrRepairObjectSync({ ...s, maxPreparationMs: 120_000,
    processRunner: { async run(request) {
      if (!request.args.includes("fetch")) return s.processRunner.run(request);
      assert.equal(s.acquired[0].deadline - startedAt, 120_000);
      assert.equal(request.timeoutMs, 120_000);
      t.mock.timers.tick(120_001);
      assert.equal(request.signal.aborted, true);
      throw Object.assign(new Error(TOKEN), { code: "PROCESS_ABORTED" });
    } },
  });
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_TIMEOUT" });
  await sync.close();
});

test("bounds a managed child with the configured deadline and cancellation signal", realGit, async (t) => {
  const s = await fixture(t);
  s.configuration.codeExecutor.gitTimeoutMs = 200;
  let received;
  let cancelled = false;
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: {
    async run(request) {
      received = request;
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      cancelled = true;
      throw Object.assign(new Error(TOKEN), { code: "PROCESS_ABORTED" });
    },
  } });
  const started = Date.now();
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_TIMEOUT" });
  assert.ok(Date.now() - started < 5000);
  assert.ok(received.timeoutMs > 0 && received.timeoutMs <= 200);
  assert.ok(cancelled);
  assert.equal(s.acquired.length, 0);
});

test("close aborts the active child, drains the queue and cancels later prepares", realGit, async (t) => {
  const s = await fixture(t);
  const running = Promise.withResolvers();
  let fetchCount = 0;
  const managed = new ManagedProcessRunner({ managedProcessFactory: () => new ManagedProcess({
    spawnImpl(...args) {
      const child = spawn(...args);
      child.once("spawn", () => running.resolve(child));
      return child;
    },
  }) });
  const sync = new OwnPrRepairObjectSync({ ...s, processRunner: {
    async run(request) {
      if (!request.args.includes("fetch")) return s.processRunner.run(request);
      fetchCount += 1;
      return managed.run({ ...request, command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
    },
  } });
  const active = sync.prepare(s);
  const queued = sync.prepare(s);
  const assertions = [active, queued].map((promise) => assert.rejects(promise, { code: "OWN_PR_REPAIR_OBJECT_CANCELLED" }));
  const child = await Promise.race([running.promise, active]);
  await sync.close();
  await Promise.all(assertions);
  await assert.rejects(sync.prepare(s), { code: "OWN_PR_REPAIR_OBJECT_CANCELLED" });
  assert.equal(fetchCount, 1);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
