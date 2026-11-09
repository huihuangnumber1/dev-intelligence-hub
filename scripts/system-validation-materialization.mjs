import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";
import { promisify } from "node:util";
import { GitObjectSnapshotter } from "../src/adapters/git-object-snapshotter.js";
import { computeRuntimeSourceIdentity } from "../src/lib/runtime-source-identity.js";
import {
  allowlistedValidationToolEnvironment,
} from "./system-validation-environment.mjs";

const execFileAsync = promisify(execFile);
const OBJECT_IDENTITY = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_FILES = 25_000;
const MAXIMUM_TOTAL_BYTES = 300 * 1024 * 1024;
const DEPENDENCY_INSTALLATION = "npm-ci-offline-ignore-scripts-v1";
const NODE_INJECTION_ENVIRONMENT = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_V8_COVERAGE",
]);

function updateFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

async function commandCandidates(environment) {
  let output;
  try {
    const located = process.platform === "win32"
      ? await execFileAsync("where.exe", ["git"], {
          encoding: "utf8",
          env: environment,
          windowsHide: true,
        })
      : await execFileAsync("which", ["git"], {
          encoding: "utf8",
          env: environment,
        });
    output = located.stdout;
  } catch {
    throw new Error("trusted Git is unavailable for validation materialization");
  }
  const candidates = [];
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    if (!path.isAbsolute(line)) continue;
    if (process.platform === "win32") {
      candidates.push(...windowsGitImplementationCandidates(line));
    } else candidates.push(path.resolve(line));
  }
  return [...new Set(candidates.map((candidate) => candidate.toLowerCase()))]
    .map((normalized) =>
      candidates.find((candidate) => candidate.toLowerCase() === normalized)
    );
}

async function trustedSnapshotter(root, environment) {
  for (const candidate of await commandCandidates(environment)) {
    try {
      const canonical = await realpath(candidate);
      const snapshotter = new GitObjectSnapshotter({ gitCommand: canonical });
      const boundary = await snapshotter.preflight({ sourceRoot: root });
      return { boundary, snapshotter };
    } catch {
      // Try the next discovered implementation; every accepted one is revalidated.
    }
  }
  throw new Error("trusted Git is unavailable for validation materialization");
}

async function readStableFile(file, relativePath) {
  const before = await lstat(file, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 0n ||
    before.size > BigInt(MAXIMUM_TOTAL_BYTES)
  ) {
    throw new Error(`immutable validation source contains an unsafe file: ${relativePath}`);
  }
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
    }
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        Math.min(64 * 1024, contents.length - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
      }
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extra } = await handle.read(
      probe,
      0,
      1,
      contents.length,
    );
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(file, { bigint: true });
    if (
      extra !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      finalPath.dev !== before.dev ||
      finalPath.ino !== before.ino ||
      finalPath.mode !== before.mode ||
      finalPath.size !== before.size ||
      finalPath.mtimeNs !== before.mtimeNs ||
      finalPath.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`immutable validation source changed while inspected: ${relativePath}`);
    }
    return { contents, mode: Number(before.mode) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readOptionalStableFile(file, relativePath) {
  try {
    return await readStableFile(file, relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function scan(directory, { requireSealed = false } = {}) {
  const files = [];
  async function visit(current, relativeDirectory = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`immutable validation source contains a link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        if (requireSealed && (metadata.mode & 0o222) !== 0) {
          throw new Error("immutable validation source changed");
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`immutable validation source contains an unsafe entry: ${relativePath}`);
      }
      const file = await readStableFile(absolutePath, relativePath);
      if (requireSealed && (file.mode & 0o222) !== 0) {
        throw new Error("immutable validation source changed");
      }
      files.push({ path: relativePath, contents: file.contents });
      if (files.length > MAXIMUM_FILES) {
        throw new Error("immutable validation source contains too many files");
      }
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  hash.update("mydashboard-validation-materialization-v1\0");
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.contents.length;
    if (totalBytes > MAXIMUM_TOTAL_BYTES) {
      throw new Error("immutable validation source is too large");
    }
    updateFrame(hash, file.path);
    updateFrame(hash, file.contents);
  }
  return Object.freeze({
    contentDigest: hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  });
}

async function npmCliPath(environment) {
  const candidates = [
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    ...(path.isAbsolute(environment.npm_execpath ?? "")
      ? [environment.npm_execpath]
      : []),
  ];
  try {
    const located = process.platform === "win32"
      ? await execFileAsync("where.exe", ["npm.cmd"], {
          encoding: "utf8",
          env: environment,
          windowsHide: true,
        })
      : await execFileAsync("which", ["npm"], {
          encoding: "utf8",
          env: environment,
        });
    for (const line of located.stdout.split(/\r?\n/u).filter(Boolean)) {
      if (!path.isAbsolute(line)) continue;
      candidates.push(line);
      if (process.platform === "win32") {
        candidates.push(path.join(
          path.dirname(line),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ));
      }
    }
  } catch {
    // The trusted Node-adjacent and npm_execpath candidates remain available.
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await lstat(canonical);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return canonical;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  throw new Error("trusted npm is unavailable for validation materialization");
}

async function removeNpmBinaryDirectory(target) {
  const binaryDirectory = path.join(target, "node_modules", ".bin");
  let entries;
  try {
    entries = await readdir(binaryDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(binaryDirectory, entry.name);
    const metadata = await lstat(entryPath);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error("validation dependency binary directory is unsafe");
    }
    await unlink(entryPath);
  }
  await rmdir(binaryDirectory);
}

async function installValidationDependencies(
  target,
  { environment: baseEnvironment, dependencyCacheDirectory },
) {
  const lockPath = path.join(target, "package-lock.json");
  const lock = await readStableFile(lockPath, "package-lock.json");
  const publishedLock = await readOptionalStableFile(
    path.join(target, "npm-shrinkwrap.json"),
    "npm-shrinkwrap.json",
  );
  if (
    publishedLock !== null &&
    !publishedLock.contents.equals(lock.contents)
  ) {
    throw new Error("published dependency lock differs from the checkout lock");
  }
  const installationLock = publishedLock ?? lock;
  const dependencyLockDigest = createHash("sha256")
    .update(installationLock.contents)
    .digest("hex");
  const npmCli = await npmCliPath(baseEnvironment);
  const configDirectory = await mkdtemp(
    path.join(os.tmpdir(), "mydashboard-validation-npm-"),
  );
  let installationError = null;
  try {
    const userConfig = path.join(configDirectory, "user.npmrc");
    const globalConfig = path.join(configDirectory, "global.npmrc");
    await writeFile(userConfig, "ignore-scripts=true\noffline=true\n", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
    const environment = {
      ...baseEnvironment,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      ...(dependencyCacheDirectory === null
        ? {}
        : { NPM_CONFIG_CACHE: dependencyCacheDirectory }),
    };
    for (const name of NODE_INJECTION_ENVIRONMENT) delete environment[name];
    await execFileAsync(process.execPath, [
      npmCli,
      "ci",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
    ], {
      cwd: target,
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
      windowsHide: true,
    });
    await removeNpmBinaryDirectory(target);
    const installedCheckoutLock = await readStableFile(
      lockPath,
      "package-lock.json",
    );
    const installedPublishedLock = await readOptionalStableFile(
      path.join(target, "npm-shrinkwrap.json"),
      "npm-shrinkwrap.json",
    );
    if (
      !installedCheckoutLock.contents.equals(lock.contents) ||
      (publishedLock === null) !== (installedPublishedLock === null) ||
      (
        publishedLock !== null &&
        !installedPublishedLock.contents.equals(publishedLock.contents)
      )
    ) {
      throw new Error("committed dependency lock changed during installation");
    }
  } catch (error) {
    installationError = new Error(
      "committed validation dependencies could not be installed offline",
      { cause: error },
    );
  }
  try {
    await rm(configDirectory, { force: true, recursive: true });
  } catch (cleanupError) {
    if (installationError !== null) {
      throw new AggregateError(
        [installationError, cleanupError],
        "validation dependency installation and cleanup failed",
      );
    }
    throw new Error("validation npm configuration cleanup failed", {
      cause: cleanupError,
    });
  }
  if (installationError !== null) throw installationError;
  return Object.freeze({
    dependencyInstallation: DEPENDENCY_INSTALLATION,
    dependencyLockDigest,
  });
}

async function seal(directory) {
  const directories = [];
  async function visit(current) {
    directories.push(current);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error("immutable validation source contains a link");
      }
      if (metadata.isDirectory()) {
        await visit(entryPath);
      } else if (metadata.isFile()) {
        await chmod(entryPath, 0o444);
      } else {
        throw new Error("immutable validation source contains an unsafe entry");
      }
    }
  }
  await visit(directory);
  directories.sort((left, right) => right.length - left.length);
  for (const candidate of directories) await chmod(candidate, 0o555);
}

async function unsealAndRemove(directory) {
  async function visit(current) {
    await chmod(current, 0o755).catch(() => {});
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        await chmod(entryPath, 0o644).catch(() => {});
      }
    }
  }
  await visit(directory);
  await rm(directory, { force: true, recursive: true });
}

function assertMaterializationRequest({ root, headOid, treeOid }) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    !OBJECT_IDENTITY.test(headOid) ||
    !OBJECT_IDENTITY.test(treeOid) ||
    headOid.length !== treeOid.length
  ) {
    throw new Error("validation materialization request is invalid");
  }
}

async function materializeCommittedTree(
  { root, headOid },
  target,
  environment,
) {
  const canonicalRoot = await realpath(root);
  const { boundary, snapshotter } = await trustedSnapshotter(
    canonicalRoot,
    environment,
  );
  await snapshotter.materialize({
    sourceRoot: canonicalRoot,
    targetRoot: target,
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
}

export async function deriveCommittedRuntimeSourceIdentity(
  request,
  { environment = allowlistedValidationToolEnvironment() } = {},
) {
  assertMaterializationRequest(request);
  const target = await mkdtemp(
    path.join(os.tmpdir(), "mydashboard-runtime-source-"),
  );
  let identity;
  try {
    await materializeCommittedTree(request, target, environment);
    await seal(target);
    const runtime = await computeRuntimeSourceIdentity(target);
    identity = Object.freeze({
      schemaVersion: 1,
      headOid: request.headOid,
      treeOid: request.treeOid,
      clean: true,
      runtimeDigest: runtime.digest,
      runtimeFileCount: runtime.fileCount,
      runtimeByteCount: runtime.byteCount,
    });
  } catch (error) {
    try {
      await unsealAndRemove(target);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "committed runtime source derivation and cleanup failed",
      );
    }
    throw error;
  }
  try {
    await unsealAndRemove(target);
  } catch (error) {
    throw new Error("committed runtime source cleanup failed", { cause: error });
  }
  return identity;
}

export async function createValidationSourceMaterialization({
  root,
  headOid,
  treeOid,
  environment = null,
  dependencyCacheDirectory = null,
}) {
  const request = { root, headOid, treeOid };
  assertMaterializationRequest(request);
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    (
      dependencyCacheDirectory !== null &&
      (
        typeof dependencyCacheDirectory !== "string" ||
        !path.isAbsolute(dependencyCacheDirectory)
      )
    )
  ) {
    throw new Error("validation materialization environment is invalid");
  }
  const target = await mkdtemp(
    path.join(os.tmpdir(), "mydashboard-validation-source-"),
  );
  try {
    await materializeCommittedTree(request, target, environment);
    const dependencyIdentity = await installValidationDependencies(target, {
      environment,
      dependencyCacheDirectory,
    });
    await seal(target);
    const scanned = await scan(target, { requireSealed: true });
    const identity = Object.freeze({
      schemaVersion: 1,
      headOid,
      treeOid,
      sealed: true,
      ...dependencyIdentity,
      ...scanned,
    });
    let cleaned = false;
    return Object.freeze({
      directory: target,
      identity,
      async verify() {
        let current;
        try {
          current = await scan(target, { requireSealed: true });
        } catch {
          throw new Error("immutable validation source changed");
        }
        if (
          current.contentDigest !== identity.contentDigest ||
          current.fileCount !== identity.fileCount ||
          current.totalBytes !== identity.totalBytes
        ) {
          throw new Error("immutable validation source changed");
        }
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await unsealAndRemove(target);
      },
    });
  } catch (error) {
    try {
      await unsealAndRemove(target);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "validation source materialization and cleanup failed",
      );
    }
    throw error;
  }
}
