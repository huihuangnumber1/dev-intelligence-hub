import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { validGitHubLogin, validGitHubToken } from "../lib/github-credential-source.js";
import { ManagedProcessRunner } from "../lib/managed-process.js";
import { OperationQueue } from "../lib/operation-queue.js";
import { GitBareMirrorInspector } from "./git-bare-mirror-inspector.js";
import { GitObjectSnapshotter } from "./git-object-snapshotter.js";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const NULL_FILE = process.platform === "win32" ? "NUL" : "/dev/null";
const OBJECT_FETCH_TIMEOUT_MS = 5 * 60_000;
export const OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS = 17 * 60_000;
const MESSAGES = Object.freeze({
  OWN_PR_REPAIR_OBJECT_INPUT_INVALID: "自动修复 Git 对象请求无效",
  OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED: "自动修复 Git 仓库可信边界预检失败",
  OWN_PR_REPAIR_OBJECT_FETCH_FAILED: "自动修复无法获取指定 Head/Base 的 Git 对象",
  OWN_PR_REPAIR_OBJECT_CREDENTIAL_FAILED: "自动修复 Git 对象凭证不可用",
  OWN_PR_REPAIR_OBJECT_TIMEOUT: "自动修复 Git 对象准备超时",
  OWN_PR_REPAIR_OBJECT_CANCELLED: "自动修复 Git 对象准备已取消",
});
const PREFIX = Object.freeze([
  "--no-lazy-fetch", "--no-pager", "--no-replace-objects",
  "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", `core.hooksPath=${NULL_FILE}`, "-c", "core.commitGraph=false",
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
  "-c", "core.askPass=",
  "-c", "credential.helper=", "-c", "credential.interactive=false",
  "-c", "maintenance.auto=false", "-c", "gc.auto=0",
  "-c", "fetch.writeCommitGraph=false", "-c", "fetch.recurseSubmodules=false",
  "-c", "submodule.recurse=false",
]);

export class OwnPrRepairObjectSyncError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = "OwnPrRepairObjectSyncError";
    this.code = code;
  }
}

function failure(code) {
  return new OwnPrRepairObjectSyncError(code);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function overlaps(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return samePath(left, right) || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function absoluteLocalPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\p{Cc}\p{Cf}]/u.test(value) || /^(?:\\\\|\/\/)/u.test(value)) {
    throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  }
  return path.resolve(value);
}

function lookup(map, repository) {
  if (!map || typeof map !== "object" || Array.isArray(map)) throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  const matches = Object.entries(map).filter(([key]) => key.toLowerCase() === repository.toLowerCase());
  if (matches.length !== 1) throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  return matches[0][1];
}

function normalizeRequest({ configuration, inputBinding }) {
  let binding;
  try {
    binding = normalizePullRequestExecutionBinding(inputBinding);
  } catch {
    throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  }
  const actorAccountId = configuration?.githubActions?.actorAccountId;
  if (binding.schemaVersion !== 2 || !validGitHubLogin(actorAccountId) ||
      binding.gitTarget.sourceAccountId.toLowerCase() !== actorAccountId.toLowerCase()) {
    throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  }
  const executor = configuration?.codeExecutor;
  const workspaceId = lookup(configuration?.workCoordination?.policy?.workspaceByRepository, binding.repository);
  const workspaces = executor?.workspaces?.filter((workspace) => workspace.id === workspaceId);
  if (workspaces?.length !== 1 || workspaces[0].gitHeadSnapshot !== true || executor?.conflictPreparation?.enabled !== true) {
    throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  }
  const sourceRoot = absoluteLocalPath(workspaces[0].sourceRoot);
  const mirrorRoot = absoluteLocalPath(lookup(executor.conflictPreparation.headMirrorsByRepository, binding.gitTarget.headRepository));
  const baseMirrorRoot = absoluteLocalPath(lookup(executor.conflictPreparation.baseMirrorsByRepository, binding.gitTarget.baseRepository));
  const gitCommand = absoluteLocalPath(executor.gitCommand);
  const timeoutMs = executor.gitTimeoutMs ?? 30_000;
  const roots = [sourceRoot, mirrorRoot, baseMirrorRoot];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      roots.some((left, index) => roots.slice(index + 1).some(right => overlaps(left, right) || overlaps(right, left)))) {
    throw failure("OWN_PR_REPAIR_OBJECT_INPUT_INVALID");
  }
  return { binding, actorAccountId, gitCommand, sourceRoot, mirrorRoot, baseMirrorRoot, timeoutMs };
}

function environment(gitCommand) {
  const env = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_FILE, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: NULL_FILE,
    GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LANG: "C", LC_ALL: "C",
    PATH: path.dirname(gitCommand),
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
    env.PATH += `${path.delimiter}${path.join(process.env.SystemRoot, "System32")}`;
  }
  return env;
}

function output(result) {
  if (!result || !Number.isSafeInteger(result.exitCode) || result.signal !== null || result.truncated !== false ||
      !(typeof result.stdout === "string" || Buffer.isBuffer(result.stdout)) ||
      !(typeof result.stderr === "string" || Buffer.isBuffer(result.stderr))) {
    throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
  }
  return { ...result, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// Reading HEAD does not execute Git or trust repository configuration. The
// resulting OID is only an anchor for the inspector's complete, read-only fence.
async function readControlFile(file, maximumBytes, optional = false) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes ||
      !samePath(await realpath(file), file)) throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > maximumBytes || bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function mirrorHead(mirrorRoot) {
  const stats = await lstat(mirrorRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(mirrorRoot), mirrorRoot)) {
    throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
  }
  let content = await readControlFile(path.join(mirrorRoot, "HEAD"), 4096);
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    const value = content.trimEnd();
    if (OID.test(value)) return value;
    const match = /^ref: (refs\/[A-Za-z0-9_#./-]+)$/u.exec(value);
    const ref = match?.[1];
    if (!ref || ref.includes("..") || ref.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock")) || visited.has(ref)) break;
    visited.add(ref);
    content = await readControlFile(path.join(mirrorRoot, ...ref.split("/")), 4096, true);
    if (content !== null) continue;
    const packed = await readControlFile(path.join(mirrorRoot, "packed-refs"), 4 * 1024 * 1024, true);
    const entries = packed?.split(/\r?\n/u).filter((line) => line.endsWith(` ${ref}`)) ?? [];
    if (entries.length === 1 && OID.test(entries[0].split(" ")[0])) return entries[0].split(" ")[0];
    break;
  }
  throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
}

async function rejectTransportConfiguration(runGit) {
  const result = await runGit(["config", "--local", "--no-includes", "-z", "--name-only", "--list"]);
  if (result.exitCode !== 0 || (result.stdout && !result.stdout.endsWith("\0"))) {
    throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
  }
  // Explicit URLs still obey url.* rewrites and scoped HTTP configuration.
  // Neither repository may override the trusted HTTPS transport or credential.
  if (result.stdout.split("\0").some((name) => /^(?:url\.|http\.|https\.|credential\.|protocol\.|include\.|includeif\.|core\.gitproxy$|remote\..*\.(?:proxy|uploadpack|vcs)$)/iu.test(name))) {
    throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
  }
}

export class OwnPrRepairObjectSync {
  #credentialSource;
  #processRunner;
  #maxPreparationMs;
  #queue = new OperationQueue();
  #closed = false;
  #activeController = null;

  constructor({ credentialSource, processRunner = new ManagedProcessRunner(),
    maxPreparationMs = OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS } = {}) {
    if (!credentialSource || typeof credentialSource.acquire !== "function" || !processRunner || typeof processRunner.run !== "function") {
      throw new TypeError("Own PR object sync requires a credential source and process runner");
    }
    if (!Number.isSafeInteger(maxPreparationMs) || maxPreparationMs < 1 || maxPreparationMs > OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS) {
      throw new TypeError("Own PR object preparation deadline is invalid");
    }
    this.#credentialSource = credentialSource;
    this.#processRunner = processRunner;
    this.#maxPreparationMs = maxPreparationMs;
    Object.freeze(this);
  }

  prepare(request) {
    return this.#queue.enqueue(() => this.#prepare(request));
  }

  async close() {
    this.#closed = true;
    this.#activeController?.abort();
    await this.#queue.tail;
  }

  async #prepare(request) {
    if (this.#closed) throw failure("OWN_PR_REPAIR_OBJECT_CANCELLED");
    const { binding, actorAccountId, gitCommand, sourceRoot, mirrorRoot, baseMirrorRoot, timeoutMs } = normalizeRequest(request);
    const controller = new AbortController();
    this.#activeController = controller;
    // Local inspections retain their configured bound. Missing object packs
    // need a separate network allowance; restarting an active download at the
    // metadata deadline discards its progress on every retry.
    const preparationTimeoutMs = Math.min(timeoutMs * 3, this.#maxPreparationMs);
    const startedAt = Date.now();
    let deadline = startedAt + preparationTimeoutMs;
    let timedOut = false;
    const abortOnTimeout = () => { timedOut = true; controller.abort(); };
    let timer = setTimeout(abortOnTimeout, preparationTimeoutMs);
    const checkDeadline = () => {
      if (timedOut || Date.now() >= deadline) throw failure("OWN_PR_REPAIR_OBJECT_TIMEOUT");
      if (controller.signal.aborted) throw failure("OWN_PR_REPAIR_OBJECT_CANCELLED");
    };
    const run = async (childRequest) => {
      checkDeadline();
      const result = await this.#processRunner.run({
        ...childRequest, signal: controller.signal,
        timeoutMs: Math.max(1, Math.min(childRequest.timeoutMs ?? timeoutMs, deadline - Date.now())),
      });
      checkDeadline();
      return output(result);
    };
    const runGit = (root, args, env = environment(gitCommand), commandTimeoutMs = timeoutMs) => run({
      command: gitCommand, cwd: root, args: [...PREFIX, `--git-dir=${root}`, ...args], env, timeoutMs: commandTimeoutMs,
    });
    let stage = "OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED";
    try {
      const source = await new GitObjectSnapshotter({
        gitCommand, timeoutMs, processRunner: { async run(value) {
          const result = await run(value);
          return { ...result, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
        } },
      }).preflight({ sourceRoot });
      const inspector = new GitBareMirrorInspector({ gitCommand, timeoutMs, processRunner: { run } });
      const head = await mirrorHead(mirrorRoot);
      const mirror = await inspector.preflight({
        repository: binding.gitTarget.headRepository, mirrorRoot, expectedCommitOid: head,
      });
      const base = await inspector.preflight({ repository: binding.gitTarget.baseRepository, mirrorRoot: baseMirrorRoot,
        expectedCommitOid: await mirrorHead(baseMirrorRoot) });
      if (source.oidLength !== binding.headRefOid.length || mirror.oidLength !== binding.headRefOid.length ||
          base.oidLength !== binding.gitTarget.baseRefOid.length || base.objectFormat !== mirror.objectFormat) {
        throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
      }
      const stores = [
        { root: sourceRoot, gitDir: source.absoluteGitDir, repository: binding.gitTarget.headRepository, oid: binding.headRefOid },
        { root: mirrorRoot, gitDir: mirror.canonicalRoot, repository: binding.gitTarget.headRepository, oid: binding.headRefOid },
        { root: baseMirrorRoot, gitDir: base.canonicalRoot, repository: binding.gitTarget.baseRepository, oid: binding.gitTarget.baseRefOid },
      ];
      const missing = [];
      for (const store of stores) {
        await rejectTransportConfiguration((args) => runGit(store.gitDir, args));
        const type = await runGit(store.gitDir, ["cat-file", "-t", store.oid]);
        if (type.exitCode === 0 && type.stdout.trim() !== "commit") throw failure("OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED");
        if (type.exitCode !== 0) missing.push(store);
      }
      if (missing.length > 0) {
        checkDeadline();
        // At most three stores can be missing. Extend once, only after the
        // read-only fences pass. Leave cleanup time before the runner's lease.
        deadline = Math.min(deadline + missing.length * OBJECT_FETCH_TIMEOUT_MS,
          startedAt + this.#maxPreparationMs);
        clearTimeout(timer);
        timer = setTimeout(abortOnTimeout, deadline - Date.now());
        stage = "OWN_PR_REPAIR_OBJECT_CREDENTIAL_FAILED";
        const lease = await this.#credentialSource.acquire({ actorAccountId, signal: controller.signal, deadline });
        await lease.use(async (token) => {
          if (!validGitHubToken(token)) throw failure("OWN_PR_REPAIR_OBJECT_CREDENTIAL_FAILED");
          stage = "OWN_PR_REPAIR_OBJECT_FETCH_FAILED";
          for (const store of missing) {
            const env = { ...environment(gitCommand),
              GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: "",
              GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            };
            try {
              const fetched = await runGit(store.gitDir, [
                "fetch", "--no-write-fetch-head", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules",
                "--no-auto-maintenance", "--no-write-commit-graph", "--no-progress", "--refmap=", "--",
                `https://github.com/${store.repository}.git`, store.oid,
              ], env, OBJECT_FETCH_TIMEOUT_MS);
              if (fetched.exitCode !== 0) throw failure(stage);
            } finally {
              delete env.GIT_CONFIG_VALUE_1;
              env.GIT_CONFIG_COUNT = "0";
            }
            const type = await runGit(store.gitDir, ["cat-file", "-t", store.oid]);
            if (type.exitCode !== 0 || type.stdout.trim() !== "commit") throw failure(stage);
          }
        });
      }
      checkDeadline();
      return Object.freeze({ headRefOid: binding.headRefOid, sourceRoot, mirrorRoot,
        fetchedRoots: Object.freeze(missing.map(({ root }) => root)) });
    } catch (error) {
      // Never retain a child-process error, output, request, or credential as a
      // cause/details field: both acquisition and Git failures may carry secrets.
      if (timedOut || Date.now() >= deadline || error?.code === "PROCESS_TIMEOUT") {
        throw failure("OWN_PR_REPAIR_OBJECT_TIMEOUT");
      }
      if (controller.signal.aborted || error?.code === "PROCESS_ABORTED") throw failure("OWN_PR_REPAIR_OBJECT_CANCELLED");
      if (error instanceof OwnPrRepairObjectSyncError && Object.hasOwn(MESSAGES, error.code)) throw failure(error.code);
      throw failure(stage);
    } finally {
      clearTimeout(timer);
      this.#activeController = null;
    }
  }
}
