import { randomUUID } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  pinGitHubCliDescriptor,
} from "../lib/known-cli-locator.js";
import {
  createCredentialLease,
  githubCredentialSourceError,
  normalizeCredentialAcquireRequest,
  validGitHubLogin,
  validGitHubToken,
} from "../lib/github-credential-source.js";
import {
  prepareCleanupTreesByIdentity,
  PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
} from "../lib/private-directory-manager.js";
import {
  SupervisedProcessRunner,
} from "../lib/supervised-process-runner.js";

const MAX_CREDENTIAL_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 4_096;
const MAX_STDERR_BYTES = 8_192;
const CLEANUP_TIMEOUT_MS = 30_000;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_CONSTRUCTION_TOKEN = Object.freeze({});
const LOGIN_ENVIRONMENT_NAMES = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

function plainRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, required, optional = []) {
  if (!plainRecord(value)) throw new TypeError("GitHub credential options are invalid");
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.length < required.length ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new TypeError("GitHub credential options are invalid");
  }
  return value;
}

function absolutePath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError("GitHub credential path is invalid");
  }
  return path.resolve(value);
}

function canonicalPath(value, platform) {
  const normalized = path.resolve(value).replace(/^\\\\\?\\/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function protectedRoots(value, platform) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError("GitHub credential protected roots are invalid");
  }
  return Object.freeze(value.map((entry) => canonicalPath(absolutePath(entry), platform)));
}

function isProtectedRoot(root, roots) {
  return roots.some((protectedRoot) => {
    const relative = path.relative(protectedRoot, root);
    return relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function validDirectoryIdentity(value) {
  return plainRecord(value) &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    typeof value.device === "string" &&
    typeof value.inode === "string";
}

function cleanupFailedError() {
  return githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
}

function sameDirectoryIdentity(identity, details) {
  return details.isDirectory() &&
    !details.isSymbolicLink() &&
    details.dev.toString() === identity.device &&
    details.ino.toString() === identity.inode;
}

async function trustedDirectoryIdentity(directory, platform) {
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw cleanupFailedError();
  }
  const resolved = await realpath(directory);
  if (canonicalPath(resolved, platform) !== canonicalPath(directory, platform)) {
    throw cleanupFailedError();
  }
  const after = await lstat(resolved, { bigint: true });
  const identity = Object.freeze({
    path: resolved,
    device: before.dev.toString(),
    inode: before.ino.toString(),
  });
  if (!sameDirectoryIdentity(identity, after)) throw cleanupFailedError();
  return identity;
}

async function verifyDirectoryIdentity(identity, platform) {
  const current = await trustedDirectoryIdentity(identity.path, platform);
  if (
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw cleanupFailedError();
  }
  return identity;
}

async function recoverDirectoryIdentity(
  directory,
  runtimeRootIdentity,
  platform,
) {
  try {
    await verifyDirectoryIdentity(runtimeRootIdentity, platform);
    if (
      canonicalPath(path.dirname(directory), platform) !==
        canonicalPath(runtimeRootIdentity.path, platform)
    ) {
      throw cleanupFailedError();
    }
    const identity = await trustedDirectoryIdentity(directory, platform);
    await verifyDirectoryIdentity(runtimeRootIdentity, platform);
    return identity;
  } catch (error) {
    if (error?.code !== "ENOENT") throw cleanupFailedError();
    try {
      await verifyDirectoryIdentity(runtimeRootIdentity, platform);
      return null;
    } catch {
      throw cleanupFailedError();
    }
  }
}

function createCleanupSignal(request, clock) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  let timer = null;
  function arm(maximumMs) {
    if (timer !== null) clearTimeout(timer);
    const remaining = request.deadline - clock();
    if (request.signal?.aborted || remaining <= 0) abort();
    if (controller.signal.aborted) return;
    timer = setTimeout(
      abort,
      Math.min(remaining, maximumMs, 2_147_483_647),
    );
    timer.unref?.();
  }
  arm(CLEANUP_TIMEOUT_MS);
  return Object.freeze({
    signal: controller.signal,
    waitForCredential() { arm(Infinity); },
    beginCleanup() { arm(CLEANUP_TIMEOUT_MS); },
    close() {
      if (timer !== null) clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    },
  });
}

function closeLateCleanupSession(session) {
  void Promise.resolve()
    .then(() => {
      if (session === null || typeof session !== "object") return;
      const close = session.close;
      if (typeof close === "function") {
        return Reflect.apply(close, session, []);
      }
    })
    .catch(() => {});
}

async function awaitCleanupPreparation(operation, signal) {
  let abandoned = false;
  const preparation = Promise.resolve()
    .then(operation)
    .then(
      (session) => {
        if (!abandoned) return session;
        closeLateCleanupSession(session);
        return null;
      },
      (error) => {
        if (!abandoned) throw error;
        return null;
      },
    );
  let handleAbort;
  const aborted = new Promise((_, reject) => {
    handleAbort = () => {
      if (abandoned) return;
      abandoned = true;
      reject(cleanupFailedError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
  try {
    return await Promise.race([preparation, aborted]);
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
}

async function prepareCleanupSession(
  identity,
  request,
  clock,
  prepareCleanupTrees,
) {
  const signalOwner = createCleanupSignal(request, clock);
  try {
    const session = await awaitCleanupPreparation(
      () => prepareCleanupTrees([identity], {
        maximumEntries: 16,
        maximumEntriesPerRoot: 16,
        maximumDepth: 1,
        maximumBytes: 64 * 1024,
        signal: signalOwner.signal,
      }),
      signalOwner.signal,
    );
    if (
      session === null ||
      typeof session !== "object" ||
      typeof session.commit !== "function" ||
      typeof session.close !== "function"
    ) {
      throw cleanupFailedError();
    }
    // Holding the prepared cleanup session must not spend its cleanup budget
    // while the separately bounded credential process is still running.
    signalOwner.waitForCredential();
    return Object.freeze({ session, signalOwner });
  } catch {
    signalOwner.close();
    throw cleanupFailedError();
  }
}

function validDescriptor(value, command) {
  return plainRecord(value) &&
    value.command === command &&
    Array.isArray(value.prefixArgs) &&
    Object.getPrototypeOf(value.prefixArgs) === Array.prototype &&
    value.prefixArgs.length === 0;
}

function environmentValue(environment, name) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    return typeof descriptor?.value === "string" &&
      !descriptor.value.includes("\0")
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function loginEnvironment(environment, directory) {
  const result = {};
  for (const name of LOGIN_ENVIRONMENT_NAMES) {
    const value = environmentValue(environment, name);
    if (value !== null) result[name] = value;
  }
  return {
    ...result,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
  };
}

function mapFailure(error, request, clock) {
  if (request.signal?.aborted) {
    return githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
  }
  if (clock() >= request.deadline) {
    return githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
  }
  switch (error?.code) {
    case "STRUCTURED_PROVIDER_TIMEOUT":
      return githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
    case "STRUCTURED_PROVIDER_CANCELLED":
      return githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
    case "STRUCTURED_PROVIDER_OUTPUT_LIMIT":
      return githubCredentialSourceError("GITHUB_CREDENTIAL_OUTPUT_INVALID");
    case "STRUCTURED_PROVIDER_REAP_FAILED":
      return githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
    case "STRUCTURED_PROVIDER_PROCESS_EXITED":
      return githubCredentialSourceError("GITHUB_LOGIN_UNAVAILABLE");
    case "STRUCTURED_PROVIDER_UNAVAILABLE":
    case "STRUCTURED_PROVIDER_PROCESS_FAILED":
    default:
      return githubCredentialSourceError("GITHUB_CLI_UNAVAILABLE");
  }
}

function parseToken(result) {
  if (
    !plainRecord(result) ||
    result.exitCode !== 0 ||
    result.signal !== null
  ) {
    throw githubCredentialSourceError("GITHUB_LOGIN_UNAVAILABLE");
  }
  if (
    result.truncated === true ||
    !Buffer.isBuffer(result.stdoutBytes) ||
    !Buffer.isBuffer(result.stderrBytes) ||
    result.stdoutBytes.byteLength > MAX_STDOUT_BYTES ||
    result.stderrBytes.byteLength !== 0 ||
    result.stderrBytes.byteLength > MAX_STDERR_BYTES
  ) {
    throw githubCredentialSourceError("GITHUB_CREDENTIAL_OUTPUT_INVALID");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
  } catch {
    throw githubCredentialSourceError("GITHUB_CREDENTIAL_OUTPUT_INVALID");
  }
  const token = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (!validGitHubToken(token)) {
    throw githubCredentialSourceError("GITHUB_CREDENTIAL_OUTPUT_INVALID");
  }
  return token;
}

async function assertEmptyDirectory(directory) {
  let handle;
  try {
    handle = await opendir(directory);
    if (await handle.read() !== null) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
    }
  } catch (error) {
    if (error?.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED") throw error;
    throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
  } finally {
    try {
      await handle?.close();
    } catch {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
    }
  }
}

function sourceOptions(rawOptions, platform) {
  const options = exactRecord(rawOptions, [
    "actorAccountId",
    "ghCommand",
    "runtimeTemporaryRoot",
    "protectedRoots",
  ]);
  if (!validGitHubLogin(options.actorAccountId)) {
    throw new TypeError("GitHub actor account is invalid");
  }
  const runtimeTemporaryRoot = absolutePath(options.runtimeTemporaryRoot);
  const roots = protectedRoots(options.protectedRoots, platform);
  if (isProtectedRoot(canonicalPath(runtimeTemporaryRoot, platform), roots)) {
    throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
  }
  return Object.freeze({
    actorAccountId: options.actorAccountId,
    ghCommand: absolutePath(options.ghCommand),
    runtimeTemporaryRoot,
    protectedRoots: roots,
  });
}

function sourceDependencies(rawDependencies, platform) {
  const dependencies = exactRecord(rawDependencies, [
    "environment",
    "clock",
    "randomUUID",
    "executablePinner",
    "processRunner",
    "privateDirectoryManager",
    "prepareCleanupTrees",
  ], ["platform"]);
  if (
    !plainRecord(dependencies.environment) ||
    typeof dependencies.clock !== "function" ||
    typeof dependencies.randomUUID !== "function" ||
    typeof dependencies.executablePinner !== "function" ||
    !plainRecord(dependencies.processRunner) ||
    typeof dependencies.processRunner.run !== "function" ||
    !plainRecord(dependencies.privateDirectoryManager) ||
    typeof dependencies.privateDirectoryManager.prepare !== "function" ||
    typeof dependencies.prepareCleanupTrees !== "function" ||
    (dependencies.platform !== undefined && dependencies.platform !== platform)
  ) {
    throw new TypeError("GitHub credential test dependencies are invalid");
  }
  return Object.freeze(dependencies);
}

export class GhLoginCredentialSource {
  #actorAccountId;
  #clock;
  #descriptor;
  #environment;
  #prepareCleanupTrees;
  #privateDirectoryManager;
  #platform;
  #processRunner;
  #protectedRoots;
  #randomUUID;
  #runtimeTemporaryRoot;

  constructor(constructionToken, options, dependencies, descriptor) {
    if (constructionToken !== TEST_CONSTRUCTION_TOKEN) {
      throw new TypeError("Use createGhLoginCredentialSource");
    }
    this.#actorAccountId = options.actorAccountId;
    this.#platform = dependencies.platform ?? process.platform;
    this.#runtimeTemporaryRoot = options.runtimeTemporaryRoot;
    this.#protectedRoots = options.protectedRoots;
    this.#environment = dependencies.environment;
    this.#clock = dependencies.clock;
    this.#randomUUID = dependencies.randomUUID;
    this.#descriptor = descriptor;
    this.#processRunner = dependencies.processRunner;
    this.#privateDirectoryManager = dependencies.privateDirectoryManager;
    this.#prepareCleanupTrees = dependencies.prepareCleanupTrees;
    Object.freeze(this);
  }

  async acquire(rawRequest) {
    const request = normalizeCredentialAcquireRequest(
      rawRequest,
      this.#actorAccountId,
    );
    if (request.signal?.aborted) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
    }
    if (this.#clock() >= request.deadline) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
    }

    const uuid = this.#randomUUID();
    if (typeof uuid !== "string" || !SAFE_UUID.test(uuid)) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
    }
    const directory = path.join(this.#runtimeTemporaryRoot, `gh-login-${uuid}`);
    const canonicalDirectory = canonicalPath(directory, this.#platform);
    if (
      path.dirname(directory) !== this.#runtimeTemporaryRoot ||
      isProtectedRoot(canonicalDirectory, this.#protectedRoots)
    ) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
    }

    let identity = null;
    let cleanup = null;
    let result;
    let failure = null;
    let runtimeRootIdentity;
    try {
      runtimeRootIdentity = await trustedDirectoryIdentity(
        this.#runtimeTemporaryRoot,
        this.#platform,
      );
    } catch {
      throw cleanupFailedError();
    }
    try {
      identity = await this.#privateDirectoryManager.prepare({
        directory,
        signal: request.signal,
        validateLocation: async () => {
          await verifyDirectoryIdentity(runtimeRootIdentity, this.#platform);
          if (
            path.dirname(directory) !== this.#runtimeTemporaryRoot ||
            isProtectedRoot(canonicalDirectory, this.#protectedRoots)
          ) {
            throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
          }
        },
      });
      if (!validDirectoryIdentity(identity) || identity.path !== directory) {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
      }
      cleanup = await prepareCleanupSession(
        identity,
        request,
        this.#clock,
        this.#prepareCleanupTrees,
      );
      await assertEmptyDirectory(directory);
      if (request.signal?.aborted) {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
      }
      const remaining = request.deadline - this.#clock();
      if (remaining <= 0) {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
      }
      result = await this.#processRunner.run({
        executable: this.#descriptor,
        args: ["auth", "token", "--hostname", "github.com", "--user", this.#actorAccountId],
        cwd: directory,
        env: loginEnvironment(this.#environment, directory),
        input: Buffer.alloc(0),
        signal: request.signal,
        timeoutMs: Math.min(remaining, MAX_CREDENTIAL_TIMEOUT_MS),
        maxStdoutBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
      });
      if (request.signal?.aborted) {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
      }
      if (this.#clock() >= request.deadline) {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
      }
    } catch (error) {
      failure = error instanceof Error && error.name === "GitHubCredentialSourceError"
        ? error
        : mapFailure(error, request, this.#clock);
      if (identity === null) {
        try {
          identity = await recoverDirectoryIdentity(
            directory,
            runtimeRootIdentity,
            this.#platform,
          );
          if (identity !== null) {
            cleanup = await prepareCleanupSession(
              identity,
              request,
              this.#clock,
              this.#prepareCleanupTrees,
            );
          }
        } catch {
          throw cleanupFailedError();
        }
      }
    }

    if (identity !== null) {
      try {
        if (cleanup === null) throw cleanupFailedError();
        cleanup.signalOwner.beginCleanup();
        await cleanup.session.commit();
      } catch {
        try {
          await cleanup?.session.close();
        } catch {
          // Cleanup uncertainty is reported by the stable error below.
        }
        throw cleanupFailedError();
      } finally {
        cleanup?.signalOwner.close();
      }
    }
    if (failure !== null) throw failure;
    if (request.signal?.aborted) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
    }
    if (this.#clock() >= request.deadline) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
    }
    return createCredentialLease(parseToken(result));
  }
}

async function createSource(options, dependencies, platform) {
  const normalizedOptions = sourceOptions(options, platform);
  const normalizedDependencies = sourceDependencies(dependencies, platform);
  let descriptor;
  try {
    descriptor = await normalizedDependencies.executablePinner(
      normalizedOptions.ghCommand,
    );
  } catch {
    throw githubCredentialSourceError("GITHUB_CLI_UNAVAILABLE");
  }
  if (!validDescriptor(descriptor, normalizedOptions.ghCommand)) {
    throw githubCredentialSourceError("GITHUB_CLI_UNAVAILABLE");
  }
  return new GhLoginCredentialSource(
    TEST_CONSTRUCTION_TOKEN,
    normalizedOptions,
    normalizedDependencies,
    descriptor,
  );
}

export function createGhLoginCredentialSource(options) {
  const supervisedProcessRunner = new SupervisedProcessRunner();
  const environment = Object.fromEntries(
    LOGIN_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = environmentValue(process.env, name);
      return value === null ? [] : [[name, value]];
    }),
  );
  return createSource(options, {
    environment,
    clock: () => Date.now(),
    randomUUID,
    executablePinner: pinGitHubCliDescriptor,
    processRunner: Object.freeze({
      run: supervisedProcessRunner.run.bind(supervisedProcessRunner),
    }),
    privateDirectoryManager: PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
    prepareCleanupTrees: prepareCleanupTreesByIdentity,
  }, process.platform);
}

export function createTestGhLoginCredentialSource(options, dependencies) {
  const platform = dependencies?.platform ?? process.platform;
  if (!new Set(["win32", "linux", "darwin"]).has(platform)) {
    throw new TypeError("GitHub credential test platform is invalid");
  }
  return createSource(options, dependencies, platform);
}
