import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = realpathSync.native(path.resolve(scriptsDirectory, ".."));
const managedEntryScript = path.join(
  projectDirectory,
  "scripts",
  "run-managed-dashboard.mjs",
);
const projectIdentity = process.platform === "win32"
  ? projectDirectory.toUpperCase()
  : projectDirectory;
const projectDigest = createHash("sha256")
  .update(projectIdentity, "utf8")
  .digest("hex");

function runtimeBaseDirectory() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA is required for the private runtime directory");
    }
    return path.join(localAppData, "MyDashboard", "runtime");
  }
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && path.isAbsolute(xdgRuntime)) {
    return path.join(xdgRuntime, "mydashboard");
  }
  return path.join(homedir(), ".local", "state", "mydashboard", "runtime");
}

const runtimeBase = path.resolve(runtimeBaseDirectory());
const runtimeDirectory = path.join(runtimeBase, projectDigest);

function assertDirectoryIsNotLink(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`private runtime path is not a regular directory: ${directory}`);
  }
}

function ensurePrivateRuntimeDirectory() {
  mkdirSync(runtimeBase, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  verifyPrivateRuntimeDirectory();
}

function verifyPrivateRuntimeDirectory() {
  assertDirectoryIsNotLink(runtimeBase);
  assertDirectoryIsNotLink(runtimeDirectory);
  if (process.platform !== "win32") {
    const info = statSync(runtimeDirectory);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("private runtime directory is owned by another user");
    }
    if ((info.mode & 0o777) !== 0o700) {
      throw new Error("private runtime directory permissions are not 0700");
    }
    if (realpathSync.native(runtimeDirectory) !== runtimeDirectory) {
      throw new Error("private runtime directory resolves through a symbolic link");
    }
  }
}

function runtimeInfo() {
  return {
    schemaVersion: 1,
    projectDirectory,
    projectDigest,
    runtimeDirectory,
  };
}

if (process.argv.length === 3 && process.argv[2] === "--runtime-info") {
  process.stdout.write(`${JSON.stringify(runtimeInfo())}\n`);
  process.exit(0);
}

if (process.argv.length === 3 && process.argv[2] === "--verify-runtime") {
  verifyPrivateRuntimeDirectory();
  process.exit(0);
}

if (process.argv.length !== 3) {
  throw new TypeError("exactly one launch result path is required");
}
ensurePrivateRuntimeDirectory();

const token = process.env.MYDASHBOARD_MANAGED_TOKEN;
const expectedRuntime = process.env.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY;
const expectedProjectDigest = process.env.MYDASHBOARD_MANAGED_PROJECT_DIGEST;
const claimTimeout = process.env.MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS;
if (
  !token ||
  Buffer.from(token, "base64").length !== 32 ||
  expectedRuntime !== runtimeDirectory ||
  expectedProjectDigest !== projectDigest ||
  !/^[0-9]{4,8}$/u.test(claimTimeout || "")
) {
  throw new Error("managed launch environment is incomplete or invalid");
}

const resultPath = path.resolve(process.argv[2]);
const sameRuntimeDirectory = process.platform === "win32"
  ? path.dirname(resultPath).toLowerCase() === runtimeDirectory.toLowerCase()
  : path.dirname(resultPath) === runtimeDirectory;
if (
  !sameRuntimeDirectory ||
  !/^mydashboard-launch-result-[0-9]+-[a-f0-9]{32}\.json$/u.test(
    path.basename(resultPath),
  )
) {
  throw new TypeError("launch result path is outside the private runtime directory");
}
const temporaryResultPath = `${resultPath}.tmp-${process.pid}-${randomUUID()}`;
const instanceId = randomUUID();
const startIdentity = randomBytes(32).toString("hex");
const childEnvironment = {
  ...process.env,
  MYDASHBOARD_MANAGED_INSTANCE_ID: instanceId,
  MYDASHBOARD_MANAGED_START_IDENTITY: startIdentity,
};
delete process.env.MYDASHBOARD_MANAGED_TOKEN;

function launchPayload(processId) {
  return [
    "launch-v1",
    String(processId),
    instanceId,
    startIdentity,
    projectDigest,
  ].join("\n");
}

function hmac(payload) {
  return createHmac("sha256", Buffer.from(token, "base64"))
    .update(payload, "utf8")
    .digest("base64");
}

function writeDurableResult(value) {
  let descriptor;
  try {
    descriptor = openSync(temporaryResultPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  linkSync(temporaryResultPath, resultPath);
  rmSync(temporaryResultPath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(runtimeDirectory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

function openNativeStderrLog() {
  try {
    const directory = path.join(runtimeDirectory, "logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertDirectoryIsNotLink(directory);
    const previous = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^node-stderr-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.log$/u.test(entry.name))
      .map(entry => ({ file: path.join(directory, entry.name), modified: statSync(path.join(directory, entry.name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    // Keep seven previous instances plus this one. An active file is direct
    // stderr output, not a stream with a hard byte limit.
    for (const entry of previous.slice(7)) rmSync(entry.file);
    return openSync(path.join(directory, `node-stderr-${instanceId}.log`), "wx", 0o600);
  } catch {
    // Diagnostics must not stop an otherwise valid service from starting.
    return undefined;
  }
}

let child;
let resultPublished = false;
let stderrDescriptor;
try {
  stderrDescriptor = openNativeStderrLog();
  child = spawn(process.execPath, [managedEntryScript], {
    cwd: projectDirectory,
    detached: true,
    env: childEnvironment,
    shell: false,
    stdio: ["ignore", "ignore", stderrDescriptor ?? "ignore"],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  writeDurableResult({
    schemaVersion: 2,
    processId: child.pid,
    instanceId,
    startIdentity,
    projectDigest,
    hmac: hmac(launchPayload(child.pid)),
  });
  resultPublished = true;
  child.unref();
} catch (error) {
  if (child?.exitCode === null && child?.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (!child.kill()) {
      throw new AggregateError(
        [error, new Error("unpublished dashboard process could not be stopped")],
        "dashboard launch failed before identity publication",
      );
    }
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("unpublished dashboard process did not stop")),
        5_000,
      )),
    ]);
  }
  throw error;
} finally {
  if (stderrDescriptor !== undefined) {
    try { closeSync(stderrDescriptor); } catch { /* Child owns its inherited descriptor. */ }
  }
  if (!resultPublished) {
    rmSync(temporaryResultPath, { force: true });
  }
}
