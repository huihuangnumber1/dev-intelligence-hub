import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  ManagedProcessError,
  ManagedProcessRunner,
} from "../lib/managed-process.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const IMAGE_WITH_DIGEST =
  /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const RUN_KEYS = new Set([
  "profileId",
  "workspacePath",
  "executionId",
  "actionId",
  "signal",
]);
const CLEANUP_KEYS = new Set(["executionId", "actionId"]);
const NODE_SHARED_READ_ARGS = Object.freeze([
  "--permission",
  "--allow-child-process",
  "--allow-fs-read=/workspace",
  "--allow-fs-read=/artifacts",
]);
const NODE_SHARED_RUNTIME_ARGS = Object.freeze([
  "--allow-fs-read=/tmp",
  "--allow-fs-write=/artifacts",
  "--allow-fs-write=/tmp",
]);
const NODE_TEST_ARGS = Object.freeze([
  ...NODE_SHARED_READ_ARGS,
  ...NODE_SHARED_RUNTIME_ARGS,
  "--test",
  "--test-reporter=tap",
]);
const NODE_SCRIPT_ARGS = Object.freeze([
  ...NODE_SHARED_READ_ARGS,
  "--allow-fs-read=/test-library",
  ...NODE_SHARED_RUNTIME_ARGS,
  "/test-library/test.mjs",
]);
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const REDACTED_HOST_VALUE = "[host-redacted]";

export class DockerSandboxError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DockerSandboxError";
    this.code = code;
    if (details) this.details = details;
  }
}

function sandboxError(code, message, cause, details) {
  return new DockerSandboxError(code, message, { cause, details });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", `${label} is invalid`);
  }
  return value;
}

function normalizeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw sandboxError("INVALID_SANDBOX_CONFIG", "Sandbox profiles are invalid");
  }
  const normalized = new Map();
  for (const [id, profile] of Object.entries(profiles)) {
    assertSafeId(id, "profileId");
    const keys = Object.keys(profile || {}).sort();
    const isScript = profile?.kind === "node-script";
    if (
      keys.join("\0") !== [
        ...(isScript ? ["asset"] : []),
        "image",
        "kind",
        "timeoutMs",
      ].sort().join("\0") ||
      !["node-test", "node-script"].includes(profile.kind) ||
      !IMAGE_WITH_DIGEST.test(profile.image) ||
      !Number.isSafeInteger(profile.timeoutMs) ||
      profile.timeoutMs < 1_000 ||
      profile.timeoutMs > 600_000
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Sandbox profile is invalid");
    }
    let asset;
    if (isScript) {
      const value = profile.asset;
      const assetKeys = Object.keys(value || {}).sort();
      if (
        !isPlainRecord(value) ||
        assetKeys.join("\0") !== [
          "description",
          "schemaVersion",
          "source",
          "title",
          "version",
        ].join("\0") ||
        value.schemaVersion !== 1 ||
        typeof value.title !== "string" ||
        !value.title.trim() ||
        Buffer.byteLength(value.title, "utf8") > 256 ||
        typeof value.description !== "string" ||
        !value.description.trim() ||
        Buffer.byteLength(value.description, "utf8") > 2_048 ||
        !Number.isSafeInteger(value.version) ||
        value.version < 1 ||
        value.version > 1_000_000 ||
        typeof value.source !== "string" ||
        !value.source.trim() ||
        Buffer.byteLength(value.source, "utf8") > 64 * 1_024
      ) {
        throw sandboxError("INVALID_SANDBOX_CONFIG", "Sandbox script asset is invalid");
      }
      asset = Object.freeze({
        schemaVersion: value.schemaVersion,
        title: value.title,
        description: value.description,
        version: value.version,
        source: value.source,
      });
    }
    const definition = Object.freeze({
      kind: profile.kind,
      image: profile.image,
      timeoutMs: profile.timeoutMs,
      ...(asset === undefined ? {} : { asset }),
    });
    normalized.set(
      id,
      Object.freeze({
        definition,
        fingerprint: digestValue(definition),
      }),
    );
  }
  return normalized;
}

function fixedDockerEnvironment(sourceEnvironment) {
  const sourceEntries = Object.entries(sourceEnvironment || {});
  const environment = { DOCKER_CLI_HINTS: "false" };
  for (const requested of ["SystemRoot", "WINDIR"]) {
    const entry = sourceEntries.find(
      ([name]) => name.toLowerCase() === requested.toLowerCase(),
    );
    if (entry && typeof entry[1] === "string") environment[entry[0]] = entry[1];
  }
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      left === "DOCKER_CLI_HINTS" ? 1 : right === "DOCKER_CLI_HINTS" ? -1 : 0,
    ),
  );
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(ANSI_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionVariants(values) {
  const variants = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    const slashVariants = new Set([
      value,
      value.replaceAll("\\", "/"),
      value.replaceAll("/", "\\"),
    ]);
    for (const candidate of slashVariants) {
      variants.add(candidate);
      variants.add(candidate.replaceAll("\\", "\\\\"));
      variants.add(candidate.replaceAll("/", "\\/"));
    }
  }
  return [...variants]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function createOutputSanitizer(sensitiveValues) {
  const patterns = redactionVariants(sensitiveValues).map(
    (value) => new RegExp(escapeRegExp(value), "giu"),
  );
  return (value) => {
    let sanitized = sanitizeOutput(value);
    for (const pattern of patterns) {
      sanitized = sanitized.replace(pattern, REDACTED_HOST_VALUE);
    }
    return sanitized;
  };
}

function isMountableAbsolutePath(value) {
  return (
    typeof value === "string" &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value)) &&
    !value.includes(",")
  );
}

async function resolveDirectory(value) {
  if (!isMountableAbsolutePath(value)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  let stats;
  try {
    stats = await lstat(value);
  } catch {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is unavailable");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  let resolved;
  try {
    resolved = await realpath(value);
  } catch {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is unavailable");
  }
  if (resolved.includes(",")) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
  }
  return resolved;
}

async function ensurePlainDirectory(directory) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw sandboxError(
      "INVALID_SANDBOX_REQUEST",
      "Sandbox test library directory is invalid",
    );
  }
  return realpath(directory);
}

async function prepareScriptLibrary(allowedRoot, profiles) {
  const libraryRoot = await ensurePlainDirectory(path.join(allowedRoot, ".test-library"));
  if (!isStrictDescendant(allowedRoot, libraryRoot)) {
    throw sandboxError(
      "INVALID_SANDBOX_REQUEST",
      "Sandbox test library directory is invalid",
    );
  }
  const activeFingerprints = new Set(
    [...profiles.values()]
      .filter((profile) => profile.definition.kind === "node-script")
      .map((profile) => profile.fingerprint),
  );
  for (const entry of await readdir(libraryRoot, { withFileTypes: true })) {
    if (activeFingerprints.has(entry.name)) continue;
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Sandbox test library contains an invalid asset",
      );
    }
    const staleDirectory = path.join(libraryRoot, entry.name);
    const stats = await lstat(staleDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Sandbox test library contains an invalid asset",
      );
    }
    await rm(staleDirectory, { recursive: true });
  }
  return libraryRoot;
}

async function materializeScriptAsset(libraryRoot, profile) {
  const assetDirectory = await ensurePlainDirectory(
    path.join(libraryRoot, profile.fingerprint),
  );
  if (!isStrictDescendant(libraryRoot, assetDirectory)) {
    throw sandboxError(
      "INVALID_SANDBOX_REQUEST",
      "Sandbox test asset directory is invalid",
    );
  }
  const sourcePath = path.join(assetDirectory, "test.mjs");
  try {
    await writeFile(sourcePath, profile.definition.asset.source, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stats = await lstat(sourcePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      await readFile(sourcePath, "utf8") !== profile.definition.asset.source
    ) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Sandbox test asset cache does not match its digest",
      );
    }
  }
  return realpath(sourcePath);
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function assertExactRequest(request, allowedKeys, requiredKeys) {
  if (!isPlainRecord(request)) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request is invalid");
  }
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request has unknown fields");
  }
  if (requiredKeys.some((key) => !Object.hasOwn(request, key))) {
    throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox request is incomplete");
  }
}

function isAbortSignal(value) {
  return (
    value === null ||
    (value &&
      typeof value === "object" &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function" &&
      typeof value.removeEventListener === "function")
  );
}

function sanitizedProcessDetails(
  details,
  sanitizeBoundaryOutput = sanitizeOutput,
) {
  if (!isPlainRecord(details)) return undefined;
  return {
    exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null,
    signal: typeof details.signal === "string" ? details.signal : null,
    stdout: sanitizeBoundaryOutput(details.stdout),
    stderr: sanitizeBoundaryOutput(details.stderr),
    durationMs: Number.isFinite(details.durationMs)
      ? Math.max(0, Math.round(details.durationMs))
      : 0,
    truncated: Boolean(details.truncated),
  };
}

function containerName(executionId, actionId) {
  const digest = createHash("sha256")
    .update(`${executionId}:${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `mydashboard-${digest}`;
}

function translateProcessError(error, sanitizeBoundaryOutput = sanitizeOutput) {
  const code = {
    PROCESS_TIMEOUT: "SANDBOX_TIMEOUT",
    PROCESS_OUTPUT_LIMIT: "SANDBOX_OUTPUT_LIMIT",
    PROCESS_ABORTED: "SANDBOX_ABORTED",
  }[error.code];
  const details = sanitizedProcessDetails(error.details, sanitizeBoundaryOutput);
  return code
    ? sandboxError(code, "Sandbox execution was interrupted", undefined, details)
    : sandboxError(
        "SANDBOX_START_FAILED",
        "Sandbox execution failed",
        undefined,
        details,
      );
}

function retainCleanupState(error, cleanup) {
  if (!cleanup.cleanupPending) return error;
  error.details = {
    ...(error.details || {}),
    cleanupPending: true,
    containerName: cleanup.containerName,
  };
  return error;
}

export class DockerTestSandbox {
  #profiles;
  #scriptAssetPreparations = new Map();
  #scriptLibraryPreparation = null;

  constructor({
    dockerExecutable,
    dockerHost,
    allowedWorkspaceRoot,
    profiles,
    processRunner = new ManagedProcessRunner(),
    sourceEnvironment = process.env,
  }) {
    if (
      typeof dockerExecutable !== "string" ||
      !(path.isAbsolute(dockerExecutable) || path.win32.isAbsolute(dockerExecutable))
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Docker executable is invalid");
    }
    if (
      typeof dockerHost !== "string" ||
      !(dockerHost.startsWith("npipe://") || dockerHost.startsWith("unix://"))
    ) {
      throw sandboxError("INVALID_SANDBOX_CONFIG", "Docker host must be local");
    }
    if (
      !isMountableAbsolutePath(allowedWorkspaceRoot)
    ) {
      throw sandboxError(
        "INVALID_SANDBOX_CONFIG",
        "Allowed workspace root is invalid",
      );
    }
    this.dockerExecutable = dockerExecutable;
    this.dockerHost = dockerHost;
    this.allowedWorkspaceRoot = allowedWorkspaceRoot;
    this.#profiles = normalizeProfiles(profiles);
    this.processRunner = processRunner;
    this.environment = fixedDockerEnvironment(sourceEnvironment);
  }

  getProfileFingerprint(profileId) {
    return this.#profile(profileId).fingerprint;
  }

  async readProfileReadiness({ profileId }) {
    const profile = this.#profile(profileId);
    const imageId = await this.probe(profile.definition);
    return { schemaVersion: 1, profileId, profileConfigDigest: profile.fingerprint, imageId };
  }

  async run(request) {
    this.assertRunRequest(request);
    const profile = this.#profile(request.profileId);
    const workspace = await this.#resolveWorkspace(request.workspacePath);
    let assetPath = null;
    if (profile.definition.kind === "node-script") {
      const preparation = this.#scriptLibraryPreparation ??= prepareScriptLibrary(
        workspace.allowedWorkspaceRoot,
        this.#profiles,
      );
      const cachedAssetPreparation = this.#scriptAssetPreparations.get(
        profile.fingerprint,
      );
      const assetPreparation = cachedAssetPreparation || preparation.then(
        (libraryRoot) => materializeScriptAsset(libraryRoot, profile),
      );
      if (!cachedAssetPreparation) {
        this.#scriptAssetPreparations.set(profile.fingerprint, assetPreparation);
      }
      try {
        assetPath = await assetPreparation;
      } catch (error) {
        if (this.#scriptLibraryPreparation === preparation) {
          this.#scriptLibraryPreparation = null;
        }
        if (this.#scriptAssetPreparations.get(profile.fingerprint) === assetPreparation) {
          this.#scriptAssetPreparations.delete(profile.fingerprint);
        }
        throw error;
      }
    }
    const sanitizeBoundaryOutput = createOutputSanitizer([
      request.workspacePath,
      workspace.workspacePath,
      this.allowedWorkspaceRoot,
      workspace.allowedWorkspaceRoot,
      this.dockerExecutable,
      this.dockerHost,
      ...(assetPath === null ? [] : [assetPath, path.dirname(assetPath)]),
    ]);
    const name = containerName(request.executionId, request.actionId);
    const imageId = await this.probe(
      profile.definition,
      request.signal,
      sanitizeBoundaryOutput,
    );
    let result;
    try {
      result = await this.runDocker(
        this.runArguments({
          name,
          profile: profile.definition,
          workspacePath: workspace.workspacePath,
          assetPath,
        }),
        profile.definition.timeoutMs,
        request.signal,
      );
    } catch (error) {
      const cleanup = await this.removeContainer(name, { bestEffort: true });
      const failure = error instanceof ManagedProcessError
        ? translateProcessError(error, sanitizeBoundaryOutput)
        : sandboxError("SANDBOX_START_FAILED", "Sandbox execution failed");
      throw retainCleanupState(failure, cleanup);
    }
    if (result.exitCode === 125) {
      const cleanup = await this.removeContainer(name, { bestEffort: true });
      throw retainCleanupState(
        sandboxError("SANDBOX_START_FAILED", "Sandbox could not be started"),
        cleanup,
      );
    }
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: sanitizeBoundaryOutput(result.stdout),
      stderr: sanitizeBoundaryOutput(result.stderr),
      durationMs: result.durationMs,
      imageId,
      profileFingerprint: profile.fingerprint,
      timedOut: false,
    };
  }

  async cleanup(request) {
    assertExactRequest(request, CLEANUP_KEYS, ["executionId", "actionId"]);
    assertSafeId(request.executionId, "executionId");
    assertSafeId(request.actionId, "actionId");
    await this.removeContainer(
      containerName(request.executionId, request.actionId),
    );
  }

  assertRunRequest(request) {
    assertExactRequest(request, RUN_KEYS, [
      "profileId",
      "workspacePath",
      "executionId",
      "actionId",
    ]);
    assertSafeId(request.profileId, "profileId");
    assertSafeId(request.executionId, "executionId");
    assertSafeId(request.actionId, "actionId");
    if (Object.hasOwn(request, "signal") && !isAbortSignal(request.signal)) {
      throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox signal is invalid");
    }
  }

  async resolveWorkspace(requestedPath) {
    return (await this.#resolveWorkspace(requestedPath)).workspacePath;
  }

  #profile(profileId) {
    assertSafeId(profileId, "profileId");
    const profile = this.#profiles.get(profileId);
    if (!profile) {
      throw sandboxError(
        "SANDBOX_PROFILE_NOT_FOUND",
        "Sandbox profile was not found",
      );
    }
    return profile;
  }

  async #resolveWorkspace(requestedPath) {
    if (!isMountableAbsolutePath(requestedPath)) {
      throw sandboxError("INVALID_SANDBOX_REQUEST", "Sandbox directory is invalid");
    }
    const lexicalRoot = path.resolve(this.allowedWorkspaceRoot);
    const lexicalWorkspace = path.resolve(requestedPath);
    if (!isStrictDescendant(lexicalRoot, lexicalWorkspace)) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Workspace is outside its allowed root",
      );
    }
    const allowedRoot = await resolveDirectory(this.allowedWorkspaceRoot);
    const workspace = await resolveDirectory(requestedPath);
    if (!isStrictDescendant(allowedRoot, workspace)) {
      throw sandboxError(
        "INVALID_SANDBOX_REQUEST",
        "Workspace is outside its allowed root",
      );
    }
    return {
      allowedWorkspaceRoot: allowedRoot,
      workspacePath: workspace,
    };
  }

  async probe(
    profile,
    signal = null,
    sanitizeBoundaryOutput = sanitizeOutput,
  ) {
    let version;
    try {
      version = await this.runDocker(
        ["version", "--format", "{{.Server.Version}}"],
        10_000,
        signal,
      );
    } catch (error) {
      if (error instanceof ManagedProcessError && error.code === "PROCESS_ABORTED") {
        throw translateProcessError(error, sanitizeBoundaryOutput);
      }
      throw sandboxError(
        "SANDBOX_UNAVAILABLE",
        "Docker sandbox is unavailable",
        undefined,
        error instanceof ManagedProcessError
          ? sanitizedProcessDetails(error.details, sanitizeBoundaryOutput)
          : undefined,
      );
    }
    if (version.exitCode !== 0 || !sanitizeOutput(version.stdout).trim()) {
      throw sandboxError("SANDBOX_UNAVAILABLE", "Docker sandbox is unavailable");
    }
    let image;
    try {
      image = await this.runDocker(
        ["image", "inspect", "--format", "{{.Id}}", profile.image],
        10_000,
        signal,
      );
    } catch (error) {
      if (error instanceof ManagedProcessError && error.code === "PROCESS_ABORTED") {
        throw translateProcessError(error, sanitizeBoundaryOutput);
      }
      throw sandboxError(
        "SANDBOX_IMAGE_UNAVAILABLE",
        "Pinned sandbox image is unavailable",
        undefined,
        error instanceof ManagedProcessError
          ? sanitizedProcessDetails(error.details, sanitizeBoundaryOutput)
          : undefined,
      );
    }
    const imageId = sanitizeOutput(image.stdout).trim();
    if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw sandboxError(
        "SANDBOX_IMAGE_UNAVAILABLE",
        "Pinned sandbox image is unavailable",
      );
    }
    return imageId;
  }

  runArguments({ name, profile, workspacePath, assetPath = null }) {
    return [
      "run",
      "--rm",
      "--name",
      name,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--user",
      "65532:65532",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs",
      "/artifacts:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=65532,gid=65532",
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace,readonly,bind-recursive=disabled`,
      ...(profile.kind === "node-script"
        ? [
            "--mount",
            `type=bind,source=${assetPath},target=/test-library/test.mjs,readonly,bind-recursive=disabled`,
          ]
        : []),
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "NO_COLOR=1",
      "--entrypoint",
      "node",
      profile.image,
      ...(profile.kind === "node-script" ? NODE_SCRIPT_ARGS : NODE_TEST_ARGS),
    ];
  }

  runDocker(args, timeoutMs, signal = null) {
    return this.processRunner.run({
      command: this.dockerExecutable,
      args: ["--host", this.dockerHost, ...args],
      env: this.environment,
      timeoutMs,
      signal,
    });
  }

  async removeContainer(name, { bestEffort = false } = {}) {
    let removal;
    try {
      removal = await this.runDocker(
        ["container", "rm", "-f", name],
        10_000,
      );
    } catch {}
    if (removal?.exitCode === 0) return { cleanupPending: false };

    let presence;
    try {
      presence = await this.runDocker(
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ],
        10_000,
      );
    } catch {}
    const names = sanitizeOutput(presence?.stdout)
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (presence?.exitCode === 0 && !names.includes(name)) {
      return { cleanupPending: false };
    }

    const details = { cleanupPending: true, containerName: name };
    const error = sandboxError(
      "SANDBOX_CLEANUP_FAILED",
      "Sandbox container cleanup could not be confirmed",
      undefined,
      details,
    );
    if (bestEffort) return { ...details, error };
    throw error;
  }
}
