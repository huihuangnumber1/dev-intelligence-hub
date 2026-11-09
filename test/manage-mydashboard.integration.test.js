import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApplicationWriterLease } from "../src/lib/application-writer-lease.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.platform === "win32"
  ? path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
  : "pwsh";
const powershell7 = process.platform === "win32"
  ? path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")
  : "pwsh";
const powershell7Available = spawnSync(
  powershell7,
  ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
  { encoding: "utf8", timeout: 10_000 },
).status === 0;
const WINDOWS_MANAGER_SKIP = process.platform !== "win32"
  ? "requires Windows PowerShell manager"
  : false;
const POWERSHELL_7_MANAGER_SKIP = process.platform !== "win32"
  ? "requires Windows PowerShell manager"
  : powershell7Available
    ? false
    : "requires PowerShell 7";
const READINESS_PRIVATE_MARKERS = Object.freeze({
  blocker: "PRIVATE_READINESS_BLOCKER",
  path: "C:\\private\\readiness-state.json",
  // PRIVACY_FAKE_CREDENTIAL_SHA256:cf7833d45898bb2331f8ca5dd15cba6d393fb541cd900f41610257bf6ba04cf0
  credential: "sk-private-readiness-credential",
});
const READINESS_SAFE_MESSAGE =
  "MyDashboard is running but readiness could not be confirmed safely.";
const PRESERVED_RECOVERY_SNAPSHOT_ID =
  "shutdown-failure-20260813-191305-ebe114efc20d42ac99e6fc0cc0c99b8f";
const RECOVERY_SNAPSHOT_CREATED_AT = "2026-08-13T19:13:05.000Z";
const WINDOWS_FIXTURE_PORT_START = 30_000;
const WINDOWS_FIXTURE_PORT_COUNT = 2_000;
let nextWindowsFixturePort = WINDOWS_FIXTURE_PORT_START +
  (randomBytes(2).readUInt16BE(0) % WINDOWS_FIXTURE_PORT_COUNT);

async function copyWritableFixtureFile(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}

async function availablePort() {
  for (let attempt = 0; attempt < WINDOWS_FIXTURE_PORT_COUNT; attempt += 1) {
    const requestedPort = process.platform === "win32"
      ? nextWindowsFixturePort
      : 0;
    if (process.platform === "win32") {
      nextWindowsFixturePort = WINDOWS_FIXTURE_PORT_START +
        ((nextWindowsFixturePort - WINDOWS_FIXTURE_PORT_START + 1) %
          WINDOWS_FIXTURE_PORT_COUNT);
    }
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, "127.0.0.1", resolve);
      });
      const port = server.address().port;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      return port;
    } catch (error) {
      if (server.listening) server.close();
      if (process.platform === "win32" && error.code === "EADDRINUSE") continue;
      throw error;
    }
  }
  throw new Error("No dedicated Windows fixture port is available");
}

function invokeManager(
  root,
  action,
  timeoutSeconds = 5,
  executable = powershell,
  extraArguments = [],
  environment = process.env,
) {
  return spawnSync(
    executable,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "Manage-MyDashboard.ps1"),
      "-Action",
      action,
      "-TimeoutSeconds",
      String(timeoutSeconds),
      ...extraArguments,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      timeout: Math.max(30_000, (timeoutSeconds + 15) * 1_000),
    },
  );
}

async function invokeManagerInJob(root, executable, extraArguments = []) {
  const resultPath = path.join(root, "job launch result.json");
  const host = spawnSync(executable, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(projectRoot, "test", "fixtures", "managed-launch-job.ps1"),
    "-ProjectDirectory", root,
    "-PowerShellPath", executable,
    "-ResultPath", resultPath,
    ...extraArguments,
  ], { cwd: root, encoding: "utf8", timeout: 45_000, windowsHide: true });
  assert.equal(host.error, undefined, `${host.stderr}\n${host.stdout}`);
  assert.equal(host.status, 0, `${host.stderr}\n${host.stdout}`);
  const result = JSON.parse((await readFile(resultPath, "utf8")).replace(/^\uFEFF/u, ""));
  return { ...host, managerExitCode: result.managerExitCode };
}

function isolatedRealServerEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === "path") continue;
    if (/(?:token|api_key|secret|password|credential)/iu.test(name)) continue;
    environment[name] = value;
  }
  environment.PATH = [
    path.dirname(process.execPath),
    path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
  ].join(path.delimiter);
  return environment;
}

function removeFixtureTree(target) {
  return rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function stopOwnedFixtureProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "close" });
  const stoppedGracefully = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (stoppedGracefully || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`fixture process ${child.pid} did not exit`)),
      5_000,
    )),
  ]);
}

async function startForeignListener(t, { mode, port }) {
  const child = spawn(process.execPath, [
    path.join(projectRoot, "test", "fixtures", "operations-listener-fixture.cjs"),
    mode,
    String(port),
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopOwnedFixtureProcess(child));
  const [ready] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([status, signal]) => {
      throw new Error(
        `foreign listener exited before ready (${status}/${signal}): ${stderr}`,
      );
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`foreign listener did not bind port ${port}`)),
      5_000,
    )),
  ]);
  assert.deepEqual(ready, { type: "ready" });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  return { child, messages };
}

async function fillOwnedListenerBacklog(t, port) {
  const clients = Array.from({ length: 256 }, () => {
    const client = net.createConnection({ host: "127.0.0.1", port });
    client.on("error", () => {});
    return client;
  });
  t.after(() => {
    for (const client of clients) client.destroy();
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function assertTcpListenerAlive(child, port) {
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => { throw error; }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`listener on port ${port} did not accept TCP`)),
        1_000,
      )),
    ]);
  } finally {
    socket.destroy();
  }
}

async function installRestoreRecorder(root, markerPath) {
  await writeFile(
    path.join(root, "scripts", "manage-offline-restore.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "restore helper invoked\\n", "utf8");
const backupId = process.argv.at(-1);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  action: "activate",
  result: { status: "activated", backupId },
}) + "\\n");
`,
    "utf8",
  );
}

function invokeManagerAsync(root, action) {
  const child = spawnManager(root, action);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function spawnManager(root, action) {
  return spawn(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "Manage-MyDashboard.ps1"),
      "-Action",
      action,
      "-TimeoutSeconds",
      "5",
    ],
    { cwd: root, windowsHide: true },
  );
}

function readRuntimeInfo(root) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "launch-mydashboard-process.mjs"), "--runtime-info"],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function waitForHealth(port, processId, maxAttempts = 100) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`);
      const body = await response.json();
      if (body.processId === processId && body.service === "mydashboard") return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw lastError || new Error("mock server did not become healthy");
}

async function waitForPath(filePath, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForProcessExit(processId, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${processId} did not exit`);
}

async function assertPortUnavailable(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/live`, {
    signal: AbortSignal.timeout(500),
  }));
}

function recoveryManifestPath(fixture) {
  return path.join(fixture.snapshotDirectory, "manifest.json");
}

async function rewriteRecoveryManifest(fixture, transform) {
  const manifestPath = recoveryManifestPath(fixture);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const transformed = transform(structuredClone(manifest));
  await writeFile(manifestPath, `${JSON.stringify(transformed)}\n`, "utf8");
}

async function rewriteFixtureManager(root, find, replace) {
  const managerPath = path.join(root, "scripts", "Manage-MyDashboard.ps1");
  const source = await readFile(managerPath, "utf8");
  const changed = source.replace(find, replace);
  assert.notEqual(changed, source, "fixture manager mutation must match production source");
  // Windows can briefly retain a script handle after the preceding manager exits.
  // Retry only that transient fixture write; persistent locks still fail the test.
  for (let attempt = 0; ; attempt += 1) {
    try { await writeFile(managerPath, changed, "utf8"); return; }
    catch (error) {
      if (error.code !== "EBUSY" || attempt >= 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function installRecoveryTerminationTrap(root, markerPath) {
  const escapedMarkerPath = markerPath.replaceAll("'", "''");
  await rewriteFixtureManager(
    root,
    /^([ \t]*)Stop-Process -Id \(\[int\]\$evidence[.]State[.]processId\) -ErrorAction Stop\r?$/mu,
    `$1[System.IO.File]::WriteAllText('${escapedMarkerPath}', 'called')\r\n`
      + "$1Stop-Process -Id ([int]$evidence.State.processId) -ErrorAction Stop",
  );
}

function writerLeaseProbeInjection(markerPath) {
  const escapedMarkerPath = markerPath.replaceAll("'", "''");
  return [
    "    $fixtureLeaseProbeHadHold = Test-Path Env:MYDASHBOARD_WRITER_LEASE_HOLD",
    "    $fixtureLeaseProbePriorHold = $env:MYDASHBOARD_WRITER_LEASE_HOLD",
    "    Remove-Item Env:MYDASHBOARD_WRITER_LEASE_HOLD -ErrorAction SilentlyContinue",
    "    $env:MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST = $projectDigest",
    "    $fixtureLeaseProbeOutput = & $nodePath $writerLeaseProbeScript | Out-String",
    "    $fixtureLeaseProbeExitCode = $LASTEXITCODE",
    "    Remove-Item Env:MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST -ErrorAction SilentlyContinue",
    "    if ($fixtureLeaseProbeHadHold) { $env:MYDASHBOARD_WRITER_LEASE_HOLD = $fixtureLeaseProbePriorHold }",
    `    [System.IO.File]::WriteAllText('${escapedMarkerPath}', ([string]$fixtureLeaseProbeExitCode + [Environment]::NewLine + $fixtureLeaseProbeOutput))`,
    "",
  ].join("\r\n");
}

async function assertWriterLeaseProbeWasExcluded(markerPath) {
  const [exitCode, ...output] = (await readFile(markerPath, "utf8")).split(/\r?\n/u);
  assert.equal(exitCode, "1");
  assert.deepEqual(JSON.parse(output.join("\n")), {
    schemaVersion: 1,
    ok: false,
    error: { code: "PROCESS_GUARD_HELD" },
  });
}

function controlPayload(state) {
  return [
    "control-v1",
    String(state.processId),
    state.instanceId,
    state.startIdentity,
    state.processStartTimeUtcTicks,
    String(state.port),
    state.projectDigest,
  ].join("\n");
}

function receiptPayload(receipt) {
  return [
    "receipt-v1",
    receipt.phase,
    receipt.status,
    String(receipt.processId),
    receipt.instanceId,
    receipt.startIdentity,
    receipt.atUnixMilliseconds,
    receipt.errorCode || "",
  ].join("\n");
}

function signFixtureDocument(token, payload) {
  return createHmac("sha256", Buffer.from(token, "base64"))
    .update(payload, "utf8")
    .digest("base64");
}

async function writeSignedControl(fixture, mutate) {
  const state = mutate(structuredClone(fixture.state));
  state.controlHmac = signFixtureDocument(state.controlToken, controlPayload(state));
  await writeFile(fixture.controlPath, `${JSON.stringify(state)}\n`, "utf8");
  return state;
}

async function writeSignedReceipt(fixture, phase, mutate) {
  const target = phase === "requested" ? fixture.requestedPath : fixture.terminalPath;
  const receipt = mutate(JSON.parse(await readFile(target, "utf8")));
  receipt.hmac = signFixtureDocument(fixture.state.controlToken, receiptPayload(receipt));
  await writeFile(target, `${JSON.stringify(receipt)}\n`, "utf8");
  return receipt;
}

function fixtureProcessStartTicks(processId) {
  const inspected = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${processId} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  assert.equal(inspected.status, 0, `${inspected.stderr}\n${inspected.stdout}`);
  assert.match(inspected.stdout.trim(), /^[1-9][0-9]{16,18}$/u);
  return inspected.stdout.trim();
}

function invokeRecovery(fixture, snapshotId = fixture.snapshotId) {
  return invokeManager(
    fixture.root,
    "RecoverFailedShutdown",
    10,
    powershell,
    ["-RecoverySnapshotId", snapshotId],
  );
}

async function assertRecoveryRejectedBeforeKill(fixture, result) {
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
  assert.equal(await fileExists(fixture.controlPath), true);
}

async function assertPreparationRejectedPreservingAuthority(fixture, result) {
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
  assert.equal(await fileExists(fixture.controlPath), true);
  assert.equal(await fileExists(fixture.requestedPath), true);
  assert.equal(await fileExists(fixture.terminalPath), true);
  const snapshotsDirectory = path.join(
    fixture.runtime.runtimeDirectory,
    "recovery-snapshots",
  );
  try {
    assert.deepEqual(await readdir(snapshotsDirectory), []);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assert.rejects(
    readdir(path.join(fixture.runtime.runtimeDirectory, "incidents")),
    { code: "ENOENT" },
  );
}

async function replaceFixtureFileWithSymlinkOrSkip(
  t,
  linkPath,
  targetPath,
) {
  const original = await readFile(linkPath);
  await writeFile(targetPath, original);
  await unlink(linkPath);
  try {
    await symlink(targetPath, linkPath, "file");
    return true;
  } catch (error) {
    await unlink(linkPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    await writeFile(linkPath, original);
    if (
      process.platform === "win32"
      && ["EACCES", "EPERM"].includes(error?.code)
    ) {
      t.skip(`Windows denied fixture file-symlink creation (${error.code})`);
      return false;
    }
    throw error;
  }
}

async function createRecoverySnapshot(root, runtime) {
  const snapshotId = PRESERVED_RECOVERY_SNAPSHOT_ID;
  const activeData = path.join(root, "data");
  const snapshotRoot = path.join(runtime.runtimeDirectory, "recovery-snapshots");
  const snapshotDirectory = path.join(snapshotRoot, snapshotId);
  const snapshotData = path.join(snapshotDirectory, "data");
  const fileName = "fixture-data.json";
  const contents = '{"fixture":"failed-shutdown"}\n';

  await mkdir(activeData, { recursive: true });
  await writeFile(path.join(activeData, fileName), contents, "utf8");
  await mkdir(snapshotData, { recursive: true });
  await writeFile(path.join(snapshotData, fileName), contents, "utf8");
  const bytes = Buffer.byteLength(contents, "utf8");
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  await writeFile(
    path.join(snapshotDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      createdAt: RECOVERY_SNAPSHOT_CREATED_AT,
      reason: "managed_shutdown_lifecycle_failure",
      sourceDirectory: activeData,
      consistent: true,
      fileCount: 1,
      totalBytes: bytes,
      files: [{ name: fileName, bytes, sha256, sourceStable: true }],
    })}\n`,
    "utf8",
  );
  return { snapshotId, snapshotDirectory };
}

async function createFixture(
  t,
  {
    shutdownExitCode = 0,
    holdWriterLeaseAfterFailedShutdown = false,
    spawnDescendantAfterFailedShutdown = false,
    claimMode = "normal",
    listenDelayMilliseconds = 0,
    livenessDelayAfterRequestCount = Number.MAX_SAFE_INTEGER,
    livenessDelayMilliseconds = 0,
    readinessMode = "ready",
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-manager-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await cp(path.join(projectRoot, "src", "lib"), path.join(root, "src", "lib"), {
    recursive: true,
  });
  const port = await availablePort();
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "Manage-MyDashboard.ps1"),
    path.join(root, "scripts", "Manage-MyDashboard.ps1"),
  );
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "launch-mydashboard-process.mjs"),
    path.join(root, "scripts", "launch-mydashboard-process.mjs"),
  );
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "probe-application-writer-lease.mjs"),
    path.join(root, "scripts", "probe-application-writer-lease.mjs"),
  );
  await writeFile(
    path.join(root, "scripts", "run-managed-dashboard.mjs"),
    'await import("../src/server.js");\n',
    "utf8",
  );
  await writeFile(path.join(root, "config.json"), `${JSON.stringify({ port })}\n`);
  await writeFile(
    path.join(root, "src", "server.js"),
    `import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApplicationWriterLease } from "./lib/application-writer-lease.js";
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
const origin = \`http://127.0.0.1:\${config.port}\`;
const names = [
  "MYDASHBOARD_MANAGED_TOKEN",
  "MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY",
  "MYDASHBOARD_MANAGED_PROJECT_DIGEST",
  "MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS",
  "MYDASHBOARD_MANAGED_LOG_DIRECTORY",
  "MYDASHBOARD_MANAGED_INSTANCE_ID",
  "MYDASHBOARD_MANAGED_START_IDENTITY",
];
const environment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
for (const name of names) delete process.env[name];
const managed = Boolean(environment.MYDASHBOARD_MANAGED_TOKEN);
const holdsWriterLeaseAfterFailure = ${JSON.stringify(holdWriterLeaseAfterFailedShutdown)};
const tokenBytes = managed ? Buffer.from(environment.MYDASHBOARD_MANAGED_TOKEN, "base64") : null;
const writerLease = holdsWriterLeaseAfterFailure ? createApplicationWriterLease({
  projectRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  projectDigest: environment.MYDASHBOARD_MANAGED_PROJECT_DIGEST,
}) : null;
if (writerLease) await writerLease.acquire();
if (holdsWriterLeaseAfterFailure) setInterval(() => {}, 1_000);
let lifecycleState = managed ? "pending_claim" : "running";
let livenessStartIdentity = environment.MYDASHBOARD_MANAGED_START_IDENTITY;
let livenessRequestCount = 0;
let watchdog = null;
const readinessMode = ${JSON.stringify(readinessMode)};
const readinessPrivateMarkers = ${JSON.stringify(READINESS_PRIVATE_MARKERS)};
if (managed) {
  writeFileSync(
    path.join(environment.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY, "fixture-child-started.marker"),
    JSON.stringify({ processId: process.pid }),
    { encoding: "utf8", flag: "w", mode: 0o600 },
  );
}
function authorized(request) {
  if (!managed) return false;
  const supplied = Buffer.from(request.headers["x-mydashboard-control-token"] || "", "base64");
  return supplied.length === 32 && timingSafeEqual(tokenBytes, supplied) &&
    request.headers["x-mydashboard-process-id"] === String(process.pid) &&
    request.headers["x-mydashboard-instance-id"] === environment.MYDASHBOARD_MANAGED_INSTANCE_ID &&
    request.headers["x-mydashboard-start-identity"] === environment.MYDASHBOARD_MANAGED_START_IDENTITY;
}
function receiptPayload(receipt) {
  return [
    "receipt-v1",
    receipt.phase,
    receipt.status,
    String(receipt.processId),
    receipt.instanceId,
    receipt.startIdentity,
    receipt.atUnixMilliseconds,
    receipt.errorCode || "",
  ].join("\\n");
}
function writeReceipt(phase, status, errorCode = null) {
  const receipt = {
    schemaVersion: 1,
    phase,
    status,
    processId: process.pid,
    instanceId: environment.MYDASHBOARD_MANAGED_INSTANCE_ID,
    startIdentity: environment.MYDASHBOARD_MANAGED_START_IDENTITY,
    atUnixMilliseconds: String(Date.now()),
    errorCode,
    hmac: "",
  };
  receipt.hmac = createHmac("sha256", tokenBytes)
    .update(receiptPayload(receipt), "utf8")
    .digest("base64");
  writeFileSync(
    path.join(environment.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY, \`mydashboard-shutdown-\${receipt.instanceId}-\${phase}.json\`),
    \`\${JSON.stringify(receipt)}\\n\`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/live") {
    livenessRequestCount += 1;
    const sendLiveness = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        live: true,
        service: "mydashboard",
        processId: process.pid,
        managed,
        lifecycleState,
        ...(managed ? {
          instanceId: environment.MYDASHBOARD_MANAGED_INSTANCE_ID,
          startIdentity: livenessStartIdentity,
        } : {}),
      }));
    };
    if (
      livenessRequestCount > ${JSON.stringify(livenessDelayAfterRequestCount)} &&
      ${JSON.stringify(livenessDelayMilliseconds)} > 0
    ) {
      setTimeout(sendLiveness, ${JSON.stringify(livenessDelayMilliseconds)});
    } else {
      sendLiveness();
    }
    return;
  }
  if (request.method === "GET" && request.url === "/api/system/status") {
    if (readinessMode === "hang") return;
    if (readinessMode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '{"readiness":{"ready":false},"credential":"' +
          readinessPrivateMarkers.credential + '"',
      );
      return;
    }
    if (readinessMode === "oversized") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        readiness: { ready: true },
        private: readinessPrivateMarkers,
        padding: "x".repeat(128 * 1024),
      }));
      return;
    }
    if (readinessMode !== "missing") {
      const ready = readinessMode !== "not-ready";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        liveness: { schemaVersion: 1, live: true },
        readiness: {
          schemaVersion: 1,
          ready,
          recoveryBlockers: ready ? [] : [{
            probeId: "recovery_state",
            code: readinessPrivateMarkers.blocker,
            path: readinessPrivateMarkers.path,
            credential: readinessPrivateMarkers.credential,
          }],
          unknownExternalActions: [],
          storageWarnings: [],
          probeFailures: [],
        },
        maintenance: { mode: "open", activeOperations: 0 },
        backups: {
          available: true,
          items: [],
          incompleteCount: 0,
          unrecognizedCount: 0,
        },
      }));
      if (readinessMode === "identity-race") {
        livenessStartIdentity = "0".repeat(64);
      }
      return;
    }
  }
  if (
    request.method === "POST" &&
    request.url === "/api/system/claim" &&
    request.headers.origin === origin &&
    request.headers["x-mydashboard-action"] === "1" &&
    authorized(request)
  ) {
    if (${JSON.stringify(claimMode)} === "hang") return;
    lifecycleState = "running";
    clearTimeout(watchdog);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ claimed: true, state: "running" }));
    return;
  }
  if (
    request.method === "POST" &&
    request.url === "/api/system/shutdown" &&
    request.headers.origin === origin &&
    request.headers["x-mydashboard-action"] === "1" &&
    (!managed || authorized(request))
  ) {
    if (managed) {
      lifecycleState = "stopping";
      clearTimeout(watchdog);
      writeReceipt("requested", "unknown");
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, state: "stopping" }), () => {
      if (managed) {
        writeReceipt(
          "terminal",
          ${shutdownExitCode} === 0 ? "success" : "failure",
          ${shutdownExitCode} === 0 ? null : "LIFECYCLE_FAILURE",
        );
        if (${JSON.stringify(spawnDescendantAfterFailedShutdown)} && ${shutdownExitCode} !== 0) {
          const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
            windowsHide: true,
          });
          writeFileSync(
            path.join(environment.MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY, "fixture-descendant-started.marker"),
            JSON.stringify({ processId: descendant.pid }),
            { encoding: "utf8", flag: "w", mode: 0o600 },
          );
        }
      }
      process.exitCode = ${shutdownExitCode};
      server.close();
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
setTimeout(() => {
  server.listen(config.port, "127.0.0.1", () => {
    if (managed) {
      watchdog = setTimeout(
        () => {
          if (lifecycleState === "pending_claim") {
            server.close();
            server.closeAllConnections?.();
          }
        },
        Number(environment.MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS),
      );
      watchdog.unref();
    }
  });
}, ${listenDelayMilliseconds});
`,
    "utf8",
  );
  t.after(async () => {
    const runtime = readRuntimeInfo(root);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(500),
      });
      const health = await response.json();
      if (health.service === "mydashboard") {
        let controlHeaders = {};
        try {
          const state = JSON.parse(await readFile(
            path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
            "utf8",
          ));
          controlHeaders = {
            "x-mydashboard-control-token": state.controlToken,
            "x-mydashboard-process-id": String(state.processId),
            "x-mydashboard-instance-id": state.instanceId,
            "x-mydashboard-start-identity": state.startIdentity,
          };
        } catch {
          // Unmanaged fixtures have no authenticated control state.
        }
        await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
          method: "POST",
          headers: {
            origin: `http://127.0.0.1:${port}`,
            "x-mydashboard-action": "1",
            ...controlHeaders,
          },
          signal: AbortSignal.timeout(500),
        });
      }
    } catch {
      // The fixture is already stopped or never reached liveness.
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/live`, {
          signal: AbortSignal.timeout(100),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        break;
      }
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(300),
      });
      const health = await response.json();
      if (health.service === "mydashboard" && Number.isInteger(health.processId)) {
        process.kill(health.processId);
        await waitForProcessExit(health.processId, 5_000);
      }
    } catch {
      // No fixture-owned listener remains.
    }
    for (const markerName of [
      "fixture-child-started.marker",
      "fixture-descendant-started.marker",
    ]) {
      try {
        const marker = JSON.parse(await readFile(
          path.join(runtime.runtimeDirectory, markerName),
          "utf8",
        ));
        if (Number.isInteger(marker.processId) && marker.processId > 0) {
          process.kill(marker.processId);
          await waitForProcessExit(marker.processId, 5_000);
        }
      } catch {
        // The exact fixture-owned process already exited or was never created.
      }
    }
    await removeFixtureTree(runtime.runtimeDirectory);
    await removeFixtureTree(root);
  });
  return { root, port };
}

async function prepareFailedShutdownRecovery(t, fixtureOptions = {}) {
  const {
    createRecoverySnapshot: shouldCreateRecoverySnapshot = true,
    ...serverFixtureOptions
  } = fixtureOptions;
  const { root, port } = await createFixture(t, {
    shutdownExitCode: 1,
    holdWriterLeaseAfterFailedShutdown: true,
    ...serverFixtureOptions,
  });
  const runtime = readRuntimeInfo(root);
  const controlPath = path.join(runtime.runtimeDirectory, "mydashboard-server-process.json");
  const started = invokeManager(root, "Start");
  assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
  const controlText = await readFile(controlPath, "utf8");
  const state = JSON.parse(controlText);
  const stopped = invokeManager(root, "Stop");
  assert.notEqual(stopped.status, 0);
  assert.match(`${stopped.stderr}\n${stopped.stdout}`, /shutdown failure/u);
  await assertPortUnavailable(port);
  assert.doesNotThrow(() => process.kill(state.processId, 0));
  if (serverFixtureOptions.spawnDescendantAfterFailedShutdown) {
    await waitForPath(path.join(
      runtime.runtimeDirectory,
      "fixture-descendant-started.marker",
    ));
  }
  const requestedPath = path.join(
    runtime.runtimeDirectory,
    `mydashboard-shutdown-${state.instanceId}-requested.json`,
  );
  const terminalPath = path.join(
    runtime.runtimeDirectory,
    `mydashboard-shutdown-${state.instanceId}-terminal.json`,
  );
  const requestedText = await readFile(requestedPath, "utf8");
  const terminalText = await readFile(terminalPath, "utf8");
  if (!shouldCreateRecoverySnapshot) {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", "fixture-data.json"),
      '{"fixture":"failed-shutdown"}\n',
      "utf8",
    );
  }
  const snapshot = shouldCreateRecoverySnapshot
    ? await createRecoverySnapshot(root, runtime)
    : {};
  return {
    root,
    port,
    runtime,
    controlPath,
    controlText,
    state,
    requestedPath,
    requestedText,
    terminalPath,
    terminalText,
    ...snapshot,
  };
}

async function createUnexpectedExitRecoveryFixture(
  t,
  {
    prepare = true,
    dataLabel = "unexpected-process-exit",
    stabilizeDeadProcessLookup = true,
  } = {},
) {
  const { root, port } = await createFixture(t);
  const runtime = readRuntimeInfo(root);
  const controlPath = path.join(
    runtime.runtimeDirectory,
    "mydashboard-server-process.json",
  );
  const started = invokeManager(root, "Start");
  assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
  const state = JSON.parse(await readFile(controlPath, "utf8"));
  await waitForHealth(port, state.processId);

  process.kill(state.processId);
  await waitForProcessExit(state.processId);
  await assertPortUnavailable(port);
  if (stabilizeDeadProcessLookup) {
    await rewriteFixtureManager(
      root,
      /(function Get-ManagedProcess \{\r?\n\s*param\([^\n]+\)\r?\n)/u,
      `$1    if ([int]$State.processId -eq ${state.processId}) { return $null }\r\n`,
    );
  }
  const requestedPath = path.join(
    runtime.runtimeDirectory,
    `mydashboard-shutdown-${state.instanceId}-requested.json`,
  );
  const terminalPath = path.join(
    runtime.runtimeDirectory,
    `mydashboard-shutdown-${state.instanceId}-terminal.json`,
  );
  assert.equal(await fileExists(requestedPath), false);
  assert.equal(await fileExists(terminalPath), false);
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(
    path.join(root, "data", "fixture-data.json"),
    `${JSON.stringify({ fixture: dataLabel })}\n`,
    "utf8",
  );

  const fixture = {
    root,
    port,
    runtime,
    controlPath,
    state,
    requestedPath,
    terminalPath,
  };
  if (!prepare) return fixture;

  const prepared = invokeManager(root, "PrepareFailedShutdownRecovery", 10);
  assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
  const snapshotId = prepared.stdout.match(
    /shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}/u,
  )?.[0];
  assert.equal(typeof snapshotId, "string");
  return {
    ...fixture,
    snapshotId,
    snapshotDirectory: path.join(
      runtime.runtimeDirectory,
      "recovery-snapshots",
      snapshotId,
    ),
  };
}

async function restoreFixtureManager(root) {
  await copyWritableFixtureFile(
    path.join(projectRoot, "scripts", "Manage-MyDashboard.ps1"),
    path.join(root, "scripts", "Manage-MyDashboard.ps1"),
  );
}

async function onlyRecoveryIncident(fixture) {
  const directory = path.join(fixture.runtime.runtimeDirectory, "incidents");
  const names = await readdir(directory);
  assert.equal(names.length, 1, `expected one recovery incident, found ${names.join(", ")}`);
  return {
    id: names[0],
    directory: path.join(directory, names[0]),
    recordPath: path.join(directory, names[0], "incident.json"),
  };
}

async function interruptRecoveryAfterExactExit(fixture) {
  await rewriteFixtureManager(
    fixture.root,
    /(\s*Wait-ForExactProcessExit -State [$]evidence[.]State\r?\n)/u,
    '$1    throw "fixture interruption after exact process exit"\n',
  );
  const interrupted = invokeRecovery(fixture);
  assert.notEqual(interrupted.status, 0, `${interrupted.stderr}\n${interrupted.stdout}`);
  assert.match(`${interrupted.stderr}\n${interrupted.stdout}`, /fixture interruption/u);
  await waitForProcessExit(fixture.state.processId);
  assert.equal(await fileExists(fixture.controlPath), true);
  return onlyRecoveryIncident(fixture);
}

async function assertOrdinaryLifecycleBlocked(fixture) {
  for (const action of ["Start", "Restart"]) {
    const result = invokeManager(fixture.root, action);
    assert.notEqual(result.status, 0, `${action} unexpectedly succeeded:\n${result.stderr}\n${result.stdout}`);
    assert.equal(await fileExists(fixture.controlPath), true);
  }
}

async function assertRecoveryCompleted(fixture, result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /remains stopped/u);
  await waitForProcessExit(fixture.state.processId);
  assert.equal(await fileExists(fixture.controlPath), false);
  assert.equal(await fileExists(fixture.requestedPath), false);
  assert.equal(await fileExists(fixture.terminalPath), false);
  await assertPortUnavailable(fixture.port);
}

async function createRealServerFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mydashboard-real-manager-"));
  const port = await availablePort();
  assert.notEqual(port, 4173);
  await cp(path.join(projectRoot, "src"), path.join(root, "src"), {
    recursive: true,
  });
  const guardPath = path.join(root, "src", "lib", "process-exclusive-guard.js");
  await chmod(guardPath, 0o644);
  const guardSource = await readFile(guardPath, "utf8");
  const fixtureGuardPrefix = `fixture-${randomBytes(8).toString("hex")}`;
  await writeFile(
    guardPath,
    guardSource.replace(
      "function guardEndpoint(name) {",
      `function guardEndpoint(name) {\n  name = \`${fixtureGuardPrefix}-\${name}\`;`,
    ),
    "utf8",
  );
  await cp(path.join(projectRoot, "public"), path.join(root, "public"), {
    recursive: true,
  });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  for (const name of [
    "Manage-MyDashboard.ps1",
    "launch-mydashboard-process.mjs",
    "probe-application-writer-lease.mjs",
    "run-managed-dashboard.mjs",
  ]) {
    await copyWritableFixtureFile(
      path.join(projectRoot, "scripts", name),
      path.join(root, "scripts", name),
    );
  }
  const configuration = JSON.parse(await readFile(
    path.join(projectRoot, "config.example.json"),
    "utf8",
  ));
  configuration.port = port;
  await writeFile(
    path.join(root, "config.example.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "mydashboard-real-manager-fixture",
      private: true,
      type: "module",
      files: ["config.example.json", "public/", "scripts/", "src/"],
    }, null, 2)}\n`,
    "utf8",
  );
  const environment = isolatedRealServerEnvironment();
  const externalGitHub = spawnSync("gh", ["--version"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(externalGitHub.error?.code, "ENOENT");
  t.after(async () => {
    const runtime = readRuntimeInfo(root);
    invokeManager(root, "Stop", 10, powershell, [], environment);
    try {
      const live = await (await fetch(`http://127.0.0.1:${port}/api/live`, {
        signal: AbortSignal.timeout(500),
      })).json();
      if (live.service === "mydashboard" && Number.isInteger(live.processId)) {
        process.kill(live.processId);
        await waitForProcessExit(live.processId, 5_000);
      }
    } catch {
      // The real fixture is already stopped.
    }
    await removeFixtureTree(runtime.runtimeDirectory);
    await removeFixtureTree(root);
  });
  return { root, port, runtime: readRuntimeInfo(root), environment };
}

test(
  "the real application server completes authenticated manager start and stop on an isolated port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port, runtime, environment } = await createRealServerFixture(t);
    const started = invokeManager(root, "Start", 30, powershell, [], environment);
    const managedLog = await readFile(
      path.join(runtime.runtimeDirectory, "logs", "server.log"),
      "utf8",
    ).catch(() => "<no managed server log>");
    assert.equal(
      started.status,
      0,
      `${started.stderr}\n${started.stdout}\n${managedLog}`,
    );
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const state = JSON.parse(await readFile(controlPath, "utf8"));
    assert.equal(managedLog.includes(state.controlToken), false);
    const live = await (await fetch(`http://127.0.0.1:${port}/api/live`)).json();
    assert.equal(live.processId, state.processId);
    assert.equal(live.instanceId, state.instanceId);
    assert.equal(live.lifecycleState, "running");
    assert.equal(live.runtimeSource.clean, true);
    assert.match(live.runtimeSource.headOid, /^[a-f0-9]{64}$/u);
    assert.match(live.runtimeSource.treeOid, /^[a-f0-9]{64}$/u);
    assert.match(live.runtimeSource.runtimeDigest, /^[a-f0-9]{64}$/u);
    assert.equal(live.runtimeSource.runtimeFileCount > 0, true);
    assert.equal(live.runtimeSource.runtimeByteCount > 0, true);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);

    const stopStartedAt = performance.now();
    const stopped = invokeManager(root, "Stop", 30, powershell, [], environment);
    const stopDurationMs = performance.now() - stopStartedAt;
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.match(stopped.stdout, /stopped gracefully/u);
    assert.equal(
      stopDurationMs < 10_000,
      true,
      `isolated manager stop took ${stopDurationMs} ms`,
    );
    await assertPortUnavailable(port);
    await assert.rejects(readFile(controlPath, "utf8"), { code: "ENOENT" });
  },
);

test(
  "RecoverySnapshotId is rejected for other actions even when explicitly empty",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root } = await createFixture(t);
    const rejected = invokeManager(
      root,
      "Status",
      5,
      powershell,
      ["-RecoverySnapshotId", ""],
    );

    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /valid only/u);
  },
);

test(
  "PowerShell manager starts, identifies, reports, and gracefully stops only its process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    assert.equal(path.isAbsolute(runtime.runtimeDirectory), true);
    assert.notEqual(
      path.dirname(runtime.runtimeDirectory).toLowerCase(),
      path.join(root, "data").toLowerCase(),
    );
    const started = invokeManager(root, "Start");
    assert.equal(started.error, undefined);
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    assert.match(started.stdout, new RegExp(`started at http://127\\.0\\.0\\.1:${port}`));

    const stateText = await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    );
    assert.equal(stateText.charCodeAt(0), "{".charCodeAt(0));
    const state = JSON.parse(stateText);
    await waitForHealth(port, state.processId);
    assert.doesNotThrow(() => process.kill(state.processId, 0));

    const status = invokeManager(root, "Status");
    assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, new RegExp(`PID ${state.processId}`));

    const restarted = invokeManager(root, "Restart");
    assert.equal(restarted.status, 0, `${restarted.stderr}\n${restarted.stdout}`);
    assert.match(restarted.stdout, /stopped gracefully/u);
    assert.match(restarted.stdout, /started at/u);
    const restartedState = JSON.parse(await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    ));
    assert.notEqual(restartedState.instanceId, state.instanceId);
    await waitForHealth(port, restartedState.processId);
    assert.throws(() => process.kill(state.processId, 0));

    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.match(stopped.stdout, /stopped gracefully/);
    assert.throws(() => process.kill(restartedState.processId, 0));

    const finalStatus = invokeManager(root, "Status");
    assert.equal(finalStatus.status, 3);
    assert.match(finalStatus.stdout, /is stopped/);
  },
);

for (const [label, executable, skip] of [
  ["Windows PowerShell", powershell, WINDOWS_MANAGER_SKIP],
  ["PowerShell 7", powershell7, POWERSHELL_7_MANAGER_SKIP],
]) {
  test(
    `${label} managed server survives the launching command job closing`,
    { skip },
    async (t) => {
      const { root, port } = await createFixture(t);
      const host = await invokeManagerInJob(root, executable);
      assert.equal(host.managerExitCode, 0, `${host.stderr}\n${host.stdout}`);
      const runtime = readRuntimeInfo(root);
      const state = JSON.parse(await readFile(
        path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
        "utf8",
      ));
      await waitForHealth(port, state.processId);
      const stopped = invokeManager(root, "Stop", 10, executable);
      assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
      await assertPortUnavailable(port);
    },
  );
  test(
    `${label} refuses to start inside a job that forbids breakaway`,
    { skip },
    async (t) => {
      const { root, port } = await createFixture(t);
      const host = await invokeManagerInJob(root, executable, ["-DenyBreakaway"]);
      assert.notEqual(host.managerExitCode, 0, `${host.stderr}\n${host.stdout}`);
      assert.match(`${host.stderr}\n${host.stdout}`, /Unable to detach MyDashboard launcher/u);
      await assertPortUnavailable(port);
      const runtime = readRuntimeInfo(root);
      await assert.rejects(readFile(
        path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
        "utf8",
      ), { code: "ENOENT" });
    },
  );
}

test(
  "managed Stop accepts a 10.5-second liveness stall within the fifteen-second cap",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root } = await createFixture(t, {
      livenessDelayAfterRequestCount: 2,
      livenessDelayMilliseconds: 10_500,
    });
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);

    const stopStartedAt = performance.now();
    const stopped = invokeManager(root, "Stop", 120);
    const stopDurationMilliseconds = performance.now() - stopStartedAt;

    assert.deepEqual(
      {
        exitCode: stopped.status,
        stoppedGracefully: /stopped gracefully/u.test(stopped.stdout),
        observedDelay: stopDurationMilliseconds >= 10_000,
        bounded: stopDurationMilliseconds < 18_000,
      },
      {
        exitCode: 0,
        stoppedGracefully: true,
        observedDelay: true,
        bounded: true,
      },
      `${stopped.stderr}\n${stopped.stdout}`,
    );
  },
);

test(
  "managed Stop enforces the fifteen-second liveness cap and fails closed on timeout",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const timeoutDeclaration =
      "$livenessRequestTimeoutSeconds = [int][Math]::Min($TimeoutSeconds, 15)";
    const productionManager = await readFile(
      path.join(projectRoot, "scripts", "Manage-MyDashboard.ps1"),
      "utf8",
    );
    assert.match(
      productionManager,
      /^[$]livenessRequestTimeoutSeconds = \[int\]\[Math\]::Min\([$]TimeoutSeconds, 15\)$/mu,
    );

    const { root } = await createFixture(t, {
      livenessDelayAfterRequestCount: 2,
      livenessDelayMilliseconds: 2_500,
    });
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const runtime = readRuntimeInfo(root);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const state = JSON.parse(await readFile(controlPath, "utf8"));

    try {
      // Exercise the production timeout path with a scaled fixture cap so this
      // regression test proves fail-closed behavior without sleeping 15 seconds.
      await rewriteFixtureManager(
        root,
        timeoutDeclaration,
        "$livenessRequestTimeoutSeconds = [int][Math]::Min($TimeoutSeconds, 1)",
      );
      const stopStartedAt = performance.now();
      const stopped = invokeManager(root, "Stop", 120);
      const stopDurationMilliseconds = performance.now() - stopStartedAt;

      assert.notEqual(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
      assert.match(
        `${stopped.stderr}\n${stopped.stdout}`,
        /recorded process does not expose matching MyDashboard identity; refusing to stop it/u,
      );
      assert.equal(stopDurationMilliseconds >= 750, true);
      assert.equal(stopDurationMilliseconds < 8_000, true);
      assert.doesNotThrow(() => process.kill(state.processId, 0));
      assert.equal(await fileExists(controlPath), true);
    } finally {
      try {
        process.kill(state.processId);
        await waitForProcessExit(state.processId, 5_000);
      } catch {
        // The fixture process may already have exited during an assertion failure.
      }
    }
  },
);

for (const scenario of [
  { mode: "ready", label: "explicit readiness" },
  { mode: "not-ready", label: "explicit non-readiness" },
  { mode: "malformed", label: "malformed readiness JSON" },
  { mode: "hang", label: "hanging readiness" },
  { mode: "missing", label: "a missing readiness route" },
  { mode: "oversized", label: "an oversized readiness body" },
  { mode: "identity-race", label: "a post-readiness identity race" },
]) {
  test(
    `managed Status reports ${scenario.label} safely`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const { root, port } = await createFixture(t, {
        readinessMode: scenario.mode,
      });
      const runtime = readRuntimeInfo(root);
      const started = invokeManager(root, "Start");
      assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
      const state = JSON.parse(await readFile(path.join(
        runtime.runtimeDirectory,
        "mydashboard-server-process.json",
      ), "utf8"));

      const statusStartedAt = performance.now();
      const status = invokeManager(root, "Status");
      const statusDurationMilliseconds = performance.now() - statusStartedAt;
      assert.equal(status.error, undefined);
      const output = `${status.stdout}\n${status.stderr}`;
      const leakedValues = [
        ...Object.values(READINESS_PRIVATE_MARKERS),
        state.controlToken,
        root,
      ].filter((value) => output.includes(value));

      if (scenario.mode === "ready") {
        assert.deepEqual(
          {
            exitCode: status.status,
            reportsManagedProcess: new RegExp(
              `running at http://127\\.0\\.0\\.1:${port} \\(PID ${state.processId}\\)`,
              "u",
            ).test(status.stdout),
            bounded: statusDurationMilliseconds < 7_000,
            leakedValues,
          },
          {
            exitCode: 0,
            reportsManagedProcess: true,
            bounded: true,
            leakedValues: [],
          },
          output,
        );
        return;
      }

      assert.deepEqual(
        {
          exitCode: status.status,
          stdout: status.stdout.trim(),
          stderr: status.stderr.trim(),
          bounded: statusDurationMilliseconds < 7_000,
          leakedValues,
        },
        {
          exitCode: 5,
          stdout: READINESS_SAFE_MESSAGE,
          stderr: "",
          bounded: true,
          leakedValues: [],
        },
        output,
      );
    },
  );
}

test(
  "saturated listener keeps offline Restore fenced when TCP occupancy is indeterminate",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const markerPath = path.join(root, "restore-helper-invoked.marker");
    await installRestoreRecorder(root, markerPath);
    const foreign = await startForeignListener(t, { mode: "saturated", port });
    await fillOwnedListenerBacklog(t, port);
    const backupId = `backup-${"c".repeat(64)}`;

    const startedAt = Date.now();
    const restored = invokeManager(
      root,
      "Restore",
      5,
      powershell,
      ["-BackupId", backupId],
    );
    const restoreElapsedMilliseconds = Date.now() - startedAt;

    const statusStartedAt = Date.now();
    const status = invokeManager(root, "Status");
    const statusElapsedMilliseconds = Date.now() - statusStartedAt;

    const startStartedAt = Date.now();
    const started = invokeManager(root, "Start");
    const startElapsedMilliseconds = Date.now() - startStartedAt;

    assert.equal(restored.error, undefined);
    assert.equal(status.error, undefined);
    assert.equal(started.error, undefined);
    const childLaunchMarker = await fileExists(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    ));
    const controlRequests = foreign.messages.filter((message) =>
      message.type === "request"
    ).length;
    assert.deepEqual(
      {
        restoreRefused: restored.status !== 0,
        helperTouched: await fileExists(markerPath),
        statusCode: status.status,
        startRefused: started.status !== 0,
        childLaunchMarker,
        controlRequests,
        listenerProcessAlive: foreign.child.exitCode === null &&
          foreign.child.signalCode === null,
        timeoutBranchObserved: restoreElapsedMilliseconds >= 500 &&
          statusElapsedMilliseconds >= 500 &&
          startElapsedMilliseconds >= 500,
        bounded: restoreElapsedMilliseconds < 5_000 &&
          statusElapsedMilliseconds < 5_000 &&
          startElapsedMilliseconds < 8_000,
      },
      {
        restoreRefused: true,
        helperTouched: false,
        statusCode: 4,
        startRefused: true,
        childLaunchMarker: false,
        controlRequests: 0,
        listenerProcessAlive: true,
        timeoutBranchObserved: true,
        bounded: true,
      },
      [
        restored.stderr,
        restored.stdout,
        status.stderr,
        status.stdout,
        started.stderr,
        started.stdout,
        `elapsed=${JSON.stringify({
          restore: restoreElapsedMilliseconds,
          status: statusElapsedMilliseconds,
          start: startElapsedMilliseconds,
        })}ms`,
      ].join("\n"),
    );
  },
);

test(
  "PowerShell manager permits an exact offline restore only while the service is stopped",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const callsPath = path.join(root, "restore-invocations.jsonl");
    await writeFile(
      path.join(root, "scripts", "manage-offline-restore.mjs"),
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const authorized = process.env.MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY === "manager-v1" &&
  /^[a-f0-9]{64}$/.test(process.env.MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST || "");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, authorized }) + "\\n");
if (!authorized || args.length !== 2 || args[0] !== "--activate") process.exit(2);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  ok: true,
  action: "activate",
  result: { status: "activated", backupId: args[1] },
}) + "\\n");
`,
      "utf8",
    );
    const backupId = `backup-${"a".repeat(64)}`;
    const restored = invokeManager(
      root,
      "Restore",
      5,
      powershell,
      ["-BackupId", backupId],
    );
    assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);
    assert.match(restored.stdout, new RegExp(backupId));
    assert.match(restored.stdout, /service remains stopped/u);
    assert.deepEqual(
      (await readFile(callsPath, "utf8")).trim().split(/\r?\n/u).map(JSON.parse),
      [{ args: ["--activate", backupId], authorized: true }],
    );
    await assertPortUnavailable(port);

    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const refused = invokeManager(
      root,
      "Restore",
      5,
      powershell,
      ["-BackupId", backupId],
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /must be stopped before offline restore/u);
    assert.equal(
      (await readFile(callsPath, "utf8")).trim().split(/\r?\n/u).length,
      1,
    );
  },
);

for (const scenario of [
  { mode: "raw", label: "a raw TCP listener" },
  { mode: "not-found", label: "an HTTP 404 listener" },
  { mode: "malformed", label: "malformed liveness JSON" },
  { mode: "hang", label: "an accept-but-hang listener" },
]) {
  test(
    `offline Restore rejects ${scenario.label} before invoking its helper`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const { root, port } = await createFixture(t);
      const markerPath = path.join(root, "restore-helper-invoked.marker");
      await installRestoreRecorder(root, markerPath);
      const foreign = await startForeignListener(t, {
        mode: scenario.mode,
        port,
      });
      const backupId = `backup-${"b".repeat(64)}`;

      const restored = invokeManager(
        root,
        "Restore",
        5,
        powershell,
        ["-BackupId", backupId],
      );
      assert.equal(restored.error, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const helperTouched = await fileExists(markerPath);
      await assertTcpListenerAlive(foreign.child, port);
      const shutdownRequests = foreign.messages.filter((message) =>
        message.type === "request" &&
        message.method === "POST" &&
        message.url === "/api/system/shutdown"
      ).length;
      const output = `${restored.stderr}\n${restored.stdout}`;

      assert.deepEqual(
        {
          refused: restored.status !== 0,
          helperTouched,
          foreignListenerAlive: true,
          shutdownRequests,
          genericListenerRefusal: /configured port.*listener|port.*occupied/iu.test(
            output,
          ),
        },
        {
          refused: true,
          helperTouched: false,
          foreignListenerAlive: true,
          shutdownRequests: 0,
          genericListenerRefusal: true,
        },
        output,
      );
    },
  );
}

test(
  "Start and state-free Status fence an HTTP 404 listener without controlling it",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const foreign = await startForeignListener(t, { mode: "not-found", port });

    const status = invokeManager(root, "Status");
    const started = invokeManager(root, "Start");
    assert.equal(status.error, undefined);
    assert.equal(started.error, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const childLaunchMarker = await fileExists(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    ));
    await assertTcpListenerAlive(foreign.child, port);
    const shutdownRequests = foreign.messages.filter((message) =>
      message.type === "request" &&
      message.method === "POST" &&
      message.url === "/api/system/shutdown"
    ).length;
    const startOutput = `${started.stderr}\n${started.stdout}`;

    assert.deepEqual(
      {
        statusCode: status.status,
        startRefused: started.status !== 0,
        childLaunchMarker,
        shutdownRequests,
        foreignListenerAlive: true,
        genericListenerRefusal: /unmanaged listener|port.*occupied/iu.test(
          startOutput,
        ),
      },
      {
        statusCode: 4,
        startRefused: true,
        childLaunchMarker: false,
        shutdownRequests: 0,
        foreignListenerAlive: true,
        genericListenerRefusal: true,
      },
      `${status.stderr}\n${status.stdout}\n${startOutput}`,
    );
  },
);

test(
  "PowerShell 7 uses the same private ACL and authenticated lifecycle",
  { skip: POWERSHELL_7_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start", 10, powershell7);
    const failedStartLiveness = started.status === 0
      ? null
      : await fetch(`http://127.0.0.1:${port}/api/live`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => {
          const value = await response.json();
          return {
            status: response.status,
            service: value.service,
            processId: value.processId,
            lifecycleState: value.lifecycleState,
          };
        }).catch((error) => ({ error: error.name }));
    assert.equal(
      started.status,
      0,
      `${started.stderr}\n${started.stdout}\n${JSON.stringify(failedStartLiveness)}`,
    );
    const state = JSON.parse(await readFile(path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    await waitForHealth(port, state.processId);
    const crossVersionStatus = invokeManager(root, "Status");
    assert.equal(
      crossVersionStatus.status,
      0,
      `${crossVersionStatus.stderr}\n${crossVersionStatus.stdout}`,
    );
    const stopped = invokeManager(root, "Stop", 10, powershell7);
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    await assertPortUnavailable(port);
  },
);

test(
  "PowerShell manager refuses an unrecorded loopback listener without killing it",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const unmanaged = spawn(process.execPath, [path.join(root, "src", "server.js")], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(() => {
      if (unmanaged.exitCode === null) unmanaged.kill();
    });
    await waitForHealth(port, unmanaged.pid);

    const result = invokeManager(root, "Start");
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /unmanaged listener/);
    assert.doesNotThrow(() => process.kill(unmanaged.pid, 0));

    const response = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${port}`,
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(response.status, 202);
    await Promise.race([
      once(unmanaged, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("unmanaged mock did not stop")), 5_000),
      ),
    ]);
  },
);

test(
  "concurrent starts serialize and retain one health-bound process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const [first, second] = await Promise.all([
      invokeManagerAsync(root, "Start"),
      invokeManagerAsync(root, "Start"),
    ]);
    for (const result of [first, second]) {
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    }

    const runtime = readRuntimeInfo(root);
    const state = JSON.parse(await readFile(
      path.join(runtime.runtimeDirectory, "mydashboard-server-process.json"),
      "utf8",
    ));
    await waitForHealth(port, state.processId);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    assert.equal(
      [first.stdout, second.stdout].filter((output) => /started at/u.test(output)).length,
      1,
    );
    assert.equal(
      [first.stdout, second.stdout].filter((output) => /already running/u.test(output)).length,
      1,
    );

    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    assert.throws(() => process.kill(state.processId, 0));
  },
);

test(
  "a manager killed after durable control publication leaves a child that self-exits unclaimed",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, { claimMode: "hang" });
    const runtime = readRuntimeInfo(root);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const manager = spawnManager(root, "Start");
    manager.stdout.resume();
    manager.stderr.resume();
    const state = JSON.parse(await waitForPath(controlPath));
    const managerExited = once(manager, "exit");
    assert.equal(manager.kill(), true);
    await managerExited;

    await waitForHealth(port, state.processId, 500);
    await waitForProcessExit(state.processId, 8_000);
    await assertPortUnavailable(port);
    const status = invokeManager(root, "Status");
    assert.equal(status.status, 6, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, /retained unknown control state/u);
    const refusedRestart = invokeManager(root, "Start");
    assert.notEqual(refusedRestart.status, 0);
    assert.match(
      `${refusedRestart.stderr}\n${refusedRestart.stdout}`,
      /dead without a durable success receipt/u,
    );
  },
);

test(
  "an authenticated managed process that dies before receipts can be recovered without termination",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t);
    const manifest = JSON.parse(await readFile(
      path.join(fixture.snapshotDirectory, "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.reason, "managed_process_exit_without_receipt");
    await assertOrdinaryLifecycleBlocked(fixture);

    const recovered = invokeRecovery(fixture);
    assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
    assert.equal(await fileExists(fixture.controlPath), false);
    await assertPortUnavailable(fixture.port);

    const restarted = invokeManager(fixture.root, "Start");
    assert.equal(restarted.status, 0, `${restarted.stderr}\n${restarted.stdout}`);
    const replacement = JSON.parse(await readFile(fixture.controlPath, "utf8"));
    await waitForHealth(fixture.port, replacement.processId);
    const stopped = invokeManager(fixture.root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  },
);

for (const phase of ["requested", "terminal"]) {
  test(
    `unexpected-exit recovery permanently rejects authority after a late ${phase} receipt appears`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await createUnexpectedExitRecoveryFixture(t);
      const lateReceiptPath = phase === "requested"
        ? fixture.requestedPath
        : fixture.terminalPath;
      await writeFile(lateReceiptPath, '{"fixture":"late-receipt"}\n', "utf8");

      const first = invokeRecovery(fixture);
      assert.notEqual(first.status, 0, `${first.stderr}\n${first.stdout}`);
      assert.match(
        `${first.stderr}\n${first.stdout}`.replace(/\s+/gu, " "),
        /permanently invalidated by a late shutdown receipt/u,
      );
      assert.equal(await fileExists(fixture.controlPath), true);
      const incident = await onlyRecoveryIncident(fixture);
      assert.equal(
        JSON.parse(await readFile(incident.recordPath, "utf8")).state,
        "invalidated",
      );
      await assertOrdinaryLifecycleBlocked(fixture);

      await unlink(lateReceiptPath);
      const second = invokeRecovery(fixture);
      assert.notEqual(second.status, 0, `${second.stderr}\n${second.stdout}`);
      assert.match(
        `${second.stderr}\n${second.stdout}`.replace(/\s+/gu, " "),
        /permanently invalidated by a late shutdown receipt/u,
      );
      assert.equal(await fileExists(fixture.controlPath), true);
      assert.equal(
        JSON.parse(await readFile(incident.recordPath, "utf8")).state,
        "invalidated",
      );
    },
  );
}

test(
  "unexpected-exit recovery preparation refuses a held application writer lease",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t, {
      prepare: false,
      dataLabel: "held-writer-lease",
    });

    const lease = createApplicationWriterLease({
      projectRoot: fixture.root,
      projectDigest: fixture.state.projectDigest,
    });
    await lease.acquire();
    let leaseClosed = false;
    t.after(async () => {
      if (!leaseClosed) await lease.close();
    });

    const rejected = invokeManager(
      fixture.root,
      "PrepareFailedShutdownRecovery",
      10,
    );
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.match(
      `${rejected.stderr}\n${rejected.stdout}`,
      /Application writer lease is not free/u,
    );
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), false);
    assert.equal(await fileExists(fixture.terminalPath), false);
    const snapshotsDirectory = path.join(
      fixture.runtime.runtimeDirectory,
      "recovery-snapshots",
    );
    try {
      assert.deepEqual(await readdir(snapshotsDirectory), []);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await assert.rejects(
      readdir(path.join(fixture.runtime.runtimeDirectory, "incidents")),
      { code: "ENOENT" },
    );

    await lease.close();
    leaseClosed = true;
    const prepared = invokeManager(
      fixture.root,
      "PrepareFailedShutdownRecovery",
      10,
    );
    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
    assert.equal((await readdir(snapshotsDirectory)).length, 1);
    assert.equal(
      (await readdir(path.join(fixture.runtime.runtimeDirectory, "incidents"))).length,
      1,
    );
  },
);

test(
  "unexpected-exit recovery never controls a PID reused by another process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t, {
      stabilizeDeadProcessLookup: false,
    });
    const sentinel = spawn(
      powershell,
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    const terminationMarker = path.join(fixture.root, "unexpected-stop.marker");
    await rewriteFixtureManager(
      fixture.root,
      /([$]process = Get-Process -Id )\(\[int\][$]State[.]processId\)( -ErrorAction SilentlyContinue)/u,
      `$1${sentinel.pid}$2`,
    );
    await installRecoveryTerminationTrap(fixture.root, terminationMarker);

    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.match(
      `${rejected.stderr}\n${rejected.stdout}`,
      /Recorded PID belongs to a different process/u,
    );
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.equal(await fileExists(terminationMarker), false);
    assert.equal(await fileExists(fixture.controlPath), true);
  },
);

test(
  "unexpected-exit recovery treats the current manager PID as a dead managed process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t);
    const terminationMarker = path.join(fixture.root, "unexpected-stop.marker");
    await rewriteFixtureManager(
      fixture.root,
      /([$]process = Get-Process -Id )\(\[int\][$]State[.]processId\)( -ErrorAction SilentlyContinue)/u,
      "$1$PID$2",
    );
    await installRecoveryTerminationTrap(fixture.root, terminationMarker);

    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
    assert.equal(await fileExists(terminationMarker), false);
  },
);

test(
  "unexpected-exit recovery authority is zero-termination even if lookup reports a live process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t);
    const sentinel = spawn(
      powershell,
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    const terminationMarker = path.join(fixture.root, "unexpected-stop.marker");
    await rewriteFixtureManager(
      fixture.root,
      /(function Get-ManagedProcess \{\r?\n\s*param\([^\n]+\)\r?\n)/u,
      `$1    return Get-Process -Id ${sentinel.pid} -ErrorAction Stop\r\n`,
    );
    await installRecoveryTerminationTrap(fixture.root, terminationMarker);

    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.match(
      `${rejected.stderr}\n${rejected.stdout}`,
      /Unexpected-exit recovery authority cannot terminate a live process/u,
    );
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.equal(await fileExists(terminationMarker), false);
    assert.equal(await fileExists(fixture.controlPath), true);
  },
);

for (const phase of ["requested", "terminal"]) {
  test(
    `unexpected-exit recovery blocks ${phase} receipt publication through final control removal`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await createUnexpectedExitRecoveryFixture(t);
      const publicationMarker = path.join(
        fixture.root,
        `late-${phase}-receipt-publication.marker`,
      );
      const escapedMarker = publicationMarker.replaceAll("'", "''");
      await rewriteFixtureManager(
        fixture.root,
        /^([ \t]*)Remove-ControlState -ExpectedState [$]evidence[.]State\r?$/mu,
        [
          "$1try {",
          `$1    [System.IO.File]::WriteAllText((Get-ReceiptPath -State $evidence.State -Phase \"${phase}\"), '{\"fixture\":\"final-window\"}')`,
          `$1    [System.IO.File]::WriteAllText('${escapedMarker}', 'published')`,
          "$1} catch [System.IO.IOException] {",
          `$1    [System.IO.File]::WriteAllText('${escapedMarker}', 'blocked')`,
          "$1}",
          "$1Remove-ControlState -ExpectedState $evidence.State",
        ].join("\r\n"),
      );

      const recovered = invokeRecovery(fixture);
      assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
      assert.equal(await readFile(publicationMarker, "utf8"), "blocked");
      assert.equal(await fileExists(fixture.requestedPath), false);
      assert.equal(await fileExists(fixture.terminalPath), false);
      assert.equal(await fileExists(fixture.controlPath), false);
    },
  );
}

test(
  "RecoverFailedShutdown holds the writer lease through final validation and control removal",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await createUnexpectedExitRecoveryFixture(t);
    const validationMarker = path.join(fixture.root, "validation-writer-lease.marker");
    const finalizationMarker = path.join(fixture.root, "finalization-writer-lease.marker");
    await rewriteFixtureManager(
      fixture.root,
      /(\s*[$]writerLease = Open-ApplicationWriterLease\r?\n)(\s*[$]snapshot = Get-ValidatedRecoverySnapshot -SnapshotId [$]SnapshotId)/u,
      `$1${writerLeaseProbeInjection(validationMarker)}$2`,
    );
    await rewriteFixtureManager(
      fixture.root,
      /(^[ \t]*Remove-ControlState -ExpectedState [$]evidence[.]State\r?$)/mu,
      `${writerLeaseProbeInjection(finalizationMarker)}$1`,
    );

    const recovered = invokeRecovery(fixture);
    assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
    await assertWriterLeaseProbeWasExcluded(validationMarker);
    await assertWriterLeaseProbeWasExcluded(finalizationMarker);
    assert.equal(await fileExists(fixture.controlPath), false);
  },
);

test(
  "exclusive launch-result failure stops only the unpublished child and preserves the colliding file",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const initialized = invokeManager(root, "Status");
    assert.equal(initialized.status, 3, `${initialized.stderr}\n${initialized.stdout}`);
    const resultPath = path.join(
      runtime.runtimeDirectory,
      `mydashboard-launch-result-${process.pid}-${randomBytes(16).toString("hex")}.json`,
    );
    await writeFile(resultPath, "preexisting-owner-data", "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    const token = randomBytes(32).toString("base64");
    const launched = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "launch-mydashboard-process.mjs"), resultPath],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          MYDASHBOARD_MANAGED_TOKEN: token,
          MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY: runtime.runtimeDirectory,
          MYDASHBOARD_MANAGED_PROJECT_DIGEST: runtime.projectDigest,
          MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS: "4000",
          MYDASHBOARD_MANAGED_LOG_DIRECTORY: path.join(
            runtime.runtimeDirectory,
            "logs",
          ),
        },
      },
    );
    assert.notEqual(launched.status, 0);
    assert.equal(await readFile(resultPath, "utf8"), "preexisting-owner-data");
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "exclusive control publication failure gracefully stops the authenticated child and preserves the owner file",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, {
      listenDelayMilliseconds: 1_000,
    });
    const runtime = readRuntimeInfo(root);
    const managerResult = invokeManagerAsync(root, "Start");
    const marker = JSON.parse(await waitForPath(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    )));
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    await writeFile(controlPath, "preexisting-control-owner", "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });

    const failed = await managerResult;
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stderr}\n${failed.stdout}`, /already exists/u);
    assert.equal(await readFile(controlPath, "utf8"), "preexisting-control-owner");
    await waitForProcessExit(marker.processId, 8_000);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "tampered launch-result HMAC is rejected while the unclaimed child self-exits",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const launcherPath = path.join(
      root,
      "scripts",
      "launch-mydashboard-process.mjs",
    );
    const launcher = await readFile(launcherPath, "utf8");
    const tamperedLauncher = launcher.replace(
      "hmac: hmac(launchPayload(child.pid)),",
      'hmac: Buffer.alloc(32).toString("base64"),',
    );
    assert.notEqual(tamperedLauncher, launcher);
    await writeFile(launcherPath, tamperedLauncher, "utf8");
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });

    const failed = invokeManager(root, "Start");
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stderr}\n${failed.stdout}`, /was not authenticated/u);
    const marker = JSON.parse(await waitForPath(path.join(
      runtime.runtimeDirectory,
      "fixture-child-started.marker",
    )));
    await waitForProcessExit(marker.processId, 8_000);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    await assertPortUnavailable(port);
  },
);

test(
  "tampered authenticated control fails closed without touching an unrelated Node process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const original = await readFile(controlPath, "utf8");
    const state = JSON.parse(original);
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    await writeFile(
      controlPath,
      JSON.stringify({ ...state, processId: state.processId + 1 }),
      "utf8",
    );
    const tampered = invokeManager(root, "Status");
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stderr}\n${tampered.stdout}`, /authentication failed/u);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));

    await writeFile(controlPath, original, "utf8");
    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
    await assertPortUnavailable(port);
  },
);

test(
  "junction aliases share the real-project mutex and one control plane",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const alias = `${root}-junction`;
    await symlink(root, alias, "junction");
    t.after(() => unlink(alias).catch(() => {}));
    const directRuntime = readRuntimeInfo(root);
    const aliasRuntime = readRuntimeInfo(alias);
    assert.equal(aliasRuntime.projectDigest, directRuntime.projectDigest);
    assert.equal(aliasRuntime.runtimeDirectory, directRuntime.runtimeDirectory);

    const [direct, throughAlias] = await Promise.all([
      invokeManagerAsync(root, "Start"),
      invokeManagerAsync(alias, "Start"),
    ]);
    for (const result of [direct, throughAlias]) {
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    }
    const state = JSON.parse(await readFile(path.join(
      directRuntime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    await waitForHealth(port, state.processId);
    assert.equal(
      [direct.stdout, throughAlias.stdout]
        .filter((output) => /started at/u.test(output)).length,
      1,
    );
    const stopped = invokeManager(root, "Stop");
    assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  },
);

test(
  "a dead recorded instance cannot authorize shutdown of a new listener on its old port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t);
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const state = JSON.parse(await readFile(path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    ), "utf8"));
    process.kill(state.processId);
    await waitForProcessExit(state.processId);

    const replacement = spawn(
      process.execPath,
      [path.join(root, "src", "server.js")],
      { cwd: root, stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (replacement.exitCode === null) replacement.kill();
    });
    await waitForHealth(port, replacement.pid);
    const stopped = invokeManager(root, "Stop");
    assert.notEqual(stopped.status, 0);
    assert.match(
      `${stopped.stderr}\n${stopped.stdout}`,
      /dead without a durable success receipt|different process/u,
    );
    assert.doesNotThrow(() => process.kill(replacement.pid, 0));
    const response = await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${port}`,
        "x-mydashboard-action": "1",
      },
    });
    assert.equal(response.status, 202);
    await once(replacement, "exit");
  },
);

test(
  "failure receipt retains control and prevents Restart from creating a new writer",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, { shutdownExitCode: 1 });
    const runtime = readRuntimeInfo(root);
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const stopped = invokeManager(root, "Stop");
    assert.notEqual(stopped.status, 0);
    assert.match(`${stopped.stderr}\n${stopped.stdout}`, /shutdown failure/u);
    const controlPath = path.join(
      runtime.runtimeDirectory,
      "mydashboard-server-process.json",
    );
    const retained = JSON.parse(await readFile(controlPath, "utf8"));
    await waitForProcessExit(retained.processId);

    const restarted = invokeManager(root, "Restart");
    assert.notEqual(restarted.status, 0);
    assert.match(`${restarted.stderr}\n${restarted.stdout}`, /shutdown failure/u);
    assert.equal(await readFile(controlPath, "utf8").then(Boolean), true);
    await assertPortUnavailable(port);
  },
);

test(
  "PrepareFailedShutdownRecovery publishes an exact snapshot without terminating the failed process",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    const prepared = invokeManager(
      fixture.root,
      "PrepareFailedShutdownRecovery",
      10,
    );

    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
    const snapshotId = prepared.stdout.match(
      /shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}/u,
    )?.[0];
    assert.equal(typeof snapshotId, "string");
    assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), true);
    assert.equal(await fileExists(fixture.terminalPath), true);

    fixture.snapshotId = snapshotId;
    fixture.snapshotDirectory = path.join(
      fixture.runtime.runtimeDirectory,
      "recovery-snapshots",
      snapshotId,
    );
    const manifest = JSON.parse(await readFile(
      path.join(fixture.snapshotDirectory, "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.reason, "managed_shutdown_lifecycle_failure");
    assert.equal(manifest.consistent, true);
    assert.deepEqual(manifest.files.map(({ name }) => name), [
      "fixture-data.json",
    ]);
    assert.equal(
      await readFile(path.join(
        fixture.snapshotDirectory,
        "data",
        "fixture-data.json",
      ), "utf8"),
      await readFile(path.join(fixture.root, "data", "fixture-data.json"), "utf8"),
    );
    const incidents = await readdir(path.join(
      fixture.runtime.runtimeDirectory,
      "incidents",
    ));
    assert.equal(incidents.length, 1);
    assert.match(incidents[0], /^incident-[a-f0-9]{32}$/u);

    process.kill(fixture.state.processId);
    await waitForProcessExit(fixture.state.processId);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "PowerShell 7 PrepareFailedShutdownRecovery publishes private evidence",
  { skip: POWERSHELL_7_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    const prepared = invokeManager(
      fixture.root,
      "PrepareFailedShutdownRecovery",
      10,
      powershell7,
    );

    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);
    assert.match(
      prepared.stdout,
      /shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}/u,
    );
    assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
    await onlyRecoveryIncident(fixture);
  },
);

test(
  "PrepareFailedShutdownRecovery rejects active data changed at publication time",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    await rewriteFixtureManager(
      fixture.root,
      /(\s*\[System[.]IO[.]Directory\]::Move\(\$temporaryDirectory, \$snapshotDirectory\)\r?\n)/u,
      '    [System.IO.File]::AppendAllText((Join-Path $dataDirectory "fixture-data.json"), "changed")\n$1',
    );

    const rejected = invokeManager(
      fixture.root,
      "PrepareFailedShutdownRecovery",
      10,
    );

    await assertPreparationRejectedPreservingAuthority(fixture, rejected);
  },
);

test(
  "PrepareFailedShutdownRecovery rejects an occupied controlled port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    await startForeignListener(t, { mode: "raw", port: fixture.port });

    await assertPreparationRejectedPreservingAuthority(
      fixture,
      invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10),
    );
  },
);

test(
  "PrepareFailedShutdownRecovery rejects an IPv6-only controlled port",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    await startForeignListener(t, { mode: "raw-ipv6", port: fixture.port });

    await assertPreparationRejectedPreservingAuthority(
      fixture,
      invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10),
    );
  },
);

test(
  "PrepareFailedShutdownRecovery rejects a live managed descendant",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
      spawnDescendantAfterFailedShutdown: true,
    });

    await assertPreparationRejectedPreservingAuthority(
      fixture,
      invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10),
    );
  },
);

test(
  "PrepareFailedShutdownRecovery rejects changed authenticated evidence",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    const terminal = JSON.parse(fixture.terminalText);
    terminal.hmac = "A".repeat(44);
    await writeFile(
      fixture.terminalPath,
      `${JSON.stringify(terminal)}\n`,
      "utf8",
    );

    await assertPreparationRejectedPreservingAuthority(
      fixture,
      invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10),
    );
  },
);

test(
  "PrepareFailedShutdownRecovery rejects unexpected active data directories",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      createRecoverySnapshot: false,
    });
    await mkdir(path.join(fixture.root, "data", "unexpected"));

    await assertPreparationRejectedPreservingAuthority(
      fixture,
      invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10),
    );
  },
);

for (const { label, mutate } of [
  {
    label: "string schemaVersion",
    mutate(manifest) { manifest.schemaVersion = "1"; return manifest; },
  },
  {
    label: "missing createdAt",
    mutate(manifest) { delete manifest.createdAt; return manifest; },
  },
  {
    label: "non-string createdAt",
    mutate(manifest) { manifest.createdAt = 1; return manifest; },
  },
  {
    label: "empty createdAt",
    mutate(manifest) { manifest.createdAt = ""; return manifest; },
  },
  {
    label: "oversized createdAt",
    mutate(manifest) { manifest.createdAt = "x".repeat(65); return manifest; },
  },
  {
    label: "non-string reason",
    mutate(manifest) { manifest.reason = [manifest.reason]; return manifest; },
  },
  {
    label: "non-string sourceDirectory",
    mutate(manifest) { manifest.sourceDirectory = [manifest.sourceDirectory]; return manifest; },
  },
  {
    label: "numeric consistent flag",
    mutate(manifest) { manifest.consistent = 1; return manifest; },
  },
  {
    label: "string fileCount",
    mutate(manifest) { manifest.fileCount = "1"; return manifest; },
  },
  {
    label: "fractional fileCount",
    mutate(manifest) { manifest.fileCount = 1.5; return manifest; },
  },
  {
    label: "out-of-bounds fileCount",
    mutate(manifest) { manifest.fileCount = 4097; return manifest; },
  },
  {
    label: "string totalBytes",
    mutate(manifest) { manifest.totalBytes = String(manifest.totalBytes); return manifest; },
  },
  {
    label: "fractional totalBytes",
    mutate(manifest) { manifest.totalBytes += 0.5; return manifest; },
  },
  {
    label: "out-of-bounds totalBytes",
    mutate(manifest) { manifest.totalBytes = 536_870_913; return manifest; },
  },
  {
    label: "object files collection",
    mutate(manifest) { manifest.files = manifest.files[0]; return manifest; },
  },
  {
    label: "numeric file name",
    mutate(manifest) { manifest.files[0].name = 1; return manifest; },
  },
  {
    label: "string file byte count",
    mutate(manifest) { manifest.files[0].bytes = String(manifest.files[0].bytes); return manifest; },
  },
  {
    label: "non-string file hash",
    mutate(manifest) { manifest.files[0].sha256 = [manifest.files[0].sha256]; return manifest; },
  },
  {
    label: "numeric sourceStable flag",
    mutate(manifest) { manifest.files[0].sourceStable = 1; return manifest; },
  },
  {
    label: "out-of-bounds file byte count",
    mutate(manifest) { manifest.files[0].bytes = 536_870_913; return manifest; },
  },
]) {
  test(
    `RecoverFailedShutdown rejects manifest ${label} before termination`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      await rewriteRecoveryManifest(fixture, mutate);

      await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    },
  );
}

test(
  "RecoverFailedShutdown accepts a preserved integral-decimal totalBytes",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const manifestPath = recoveryManifestPath(fixture);
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    const integerTotal = `\"totalBytes\":${manifest.totalBytes}`;
    assert.equal(manifestText.includes(integerTotal), true);
    await writeFile(
      manifestPath,
      manifestText.replace(integerTotal, `${integerTotal}.0`),
      "utf8",
    );

    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "PowerShell 7 RecoverFailedShutdown accepts a preserved integral-decimal totalBytes",
  { skip: POWERSHELL_7_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const manifestPath = recoveryManifestPath(fixture);
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    const integerTotal = `\"totalBytes\":${manifest.totalBytes}`;
    assert.equal(manifestText.includes(integerTotal), true);
    await writeFile(
      manifestPath,
      manifestText.replace(integerTotal, `${integerTotal}.0`),
      "utf8",
    );

    const recovered = invokeManager(
      fixture.root,
      "RecoverFailedShutdown",
      10,
      powershell7,
      ["-RecoverySnapshotId", fixture.snapshotId],
    );
    await assertRecoveryCompleted(fixture, recovered);
  },
);

test(
  "PowerShell 7 RecoverFailedShutdown rejects a fractional totalBytes",
  { skip: POWERSHELL_7_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteRecoveryManifest(fixture, (manifest) => ({
      ...manifest,
      totalBytes: manifest.totalBytes + 0.5,
    }));
    const rejected = invokeManager(
      fixture.root,
      "RecoverFailedShutdown",
      10,
      powershell7,
      ["-RecoverySnapshotId", fixture.snapshotId],
    );

    await assertRecoveryRejectedBeforeKill(fixture, rejected);
  },
);

test(
  "RecoverFailedShutdown permits declared regenerable caches in active data",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const activeData = path.join(fixture.root, "data");
    await mkdir(path.join(activeData, "playwright-browsers", ".links"), {
      recursive: true,
    });
    await writeFile(
      path.join(activeData, "playwright-browsers", ".links", "browser.json"),
      "{}\n",
    );
    await mkdir(
      path.join(activeData, "validation-profile-probe", "runtime", "profile"),
      { recursive: true },
    );

    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown preserves the separately validated change package store",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const packagePath = path.join(
      fixture.root,
      "data",
      "change-packages",
      "packages",
      `change-package-${"a".repeat(64)}.json`,
    );
    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, "{}\n", "utf8");

    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
    assert.equal(await readFile(packagePath, "utf8"), "{}\n");
  },
);

test(
  "RecoverFailedShutdown rejects wrong-case active cache directory before termination",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await mkdir(path.join(fixture.root, "data", "Playwright-Browsers"));

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown rejects a declared cache name represented as a file before termination",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const cacheName = "playwright-browsers";
    const contents = "not a regenerable cache directory\n";
    const bytes = Buffer.byteLength(contents, "utf8");
    const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
    const activePath = path.join(fixture.root, "data", cacheName);
    const snapshotPath = path.join(fixture.snapshotDirectory, "data", cacheName);

    await writeFile(activePath, contents, "utf8");
    await writeFile(snapshotPath, contents, "utf8");
    await rewriteRecoveryManifest(fixture, (manifest) => ({
      ...manifest,
      fileCount: manifest.fileCount + 1,
      totalBytes: manifest.totalBytes + bytes,
      files: [
        ...manifest.files,
        { name: cacheName, bytes, sha256, sourceStable: true },
      ],
    }));

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

for (const { label, snapshotId } of [
  { label: "malformed snapshot identifier", snapshotId: "shutdown-failure-invalid" },
  {
    label: "absent valid snapshot identifier",
    snapshotId: "shutdown-failure-20260813-191305-00000000000000000000000000000000",
  },
  {
    label: "traversal snapshot identifier",
    snapshotId: `../${PRESERVED_RECOVERY_SNAPSHOT_ID}`,
  },
  {
    label: "nested snapshot identifier",
    snapshotId: `${PRESERVED_RECOVERY_SNAPSHOT_ID}\\child`,
  },
]) {
  test(
    `RecoverFailedShutdown fail-before-kill: ${label}`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      await assertRecoveryRejectedBeforeKill(
        fixture,
        invokeRecovery(fixture, snapshotId),
      );
    },
  );
}

test(
  "RecoverFailedShutdown fail-before-kill: missing snapshot parameter",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const rejected = invokeManager(fixture.root, "RecoverFailedShutdown", 10);
    await assertRecoveryRejectedBeforeKill(fixture, rejected);
  },
);

for (const { label, mutate } of [
  {
    label: "malformed manifest JSON",
    async mutate(fixture) {
      await writeFile(recoveryManifestPath(fixture), "{\"schemaVersion\":1", "utf8");
    },
  },
  {
    label: "extra manifest key",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => ({
        ...manifest,
        unexpected: true,
      }));
    },
  },
  {
    label: "tampered manifest hash",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => {
        manifest.files[0].sha256 = "0".repeat(64);
        return manifest;
      });
    },
  },
  {
    label: "mismatched manifest source directory",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => {
        manifest.sourceDirectory = path.join(fixture.root, "other-data");
        return manifest;
      });
    },
  },
  {
    label: "mismatched manifest reason",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => {
        manifest.reason = "other_reason";
        return manifest;
      });
    },
  },
  {
    label: "mismatched manifest count",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => {
        manifest.fileCount += 1;
        return manifest;
      });
    },
  },
  {
    label: "mismatched manifest total",
    mutate(fixture) {
      return rewriteRecoveryManifest(fixture, (manifest) => {
        manifest.totalBytes += 1;
        return manifest;
      });
    },
  },
]) {
  test(
    `RecoverFailedShutdown fail-before-kill: ${label}`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      await mutate(fixture);
      await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    },
  );
}

for (const { label, mutate } of [
  {
    label: "missing snapshot file",
    async mutate(fixture) {
      await unlink(path.join(fixture.snapshotDirectory, "data", "fixture-data.json"));
    },
  },
  {
    label: "extra snapshot file",
    async mutate(fixture) {
      await writeFile(path.join(fixture.snapshotDirectory, "data", "extra.json"), "{}\n");
    },
  },
  {
    label: "declared cache directory inside snapshot",
    async mutate(fixture) {
      await mkdir(path.join(
        fixture.snapshotDirectory,
        "data",
        "playwright-browsers",
      ));
    },
  },
  {
    label: "reparse snapshot data directory",
    async mutate(fixture) {
      const dataPath = path.join(fixture.snapshotDirectory, "data");
      const target = path.join(fixture.root, "snapshot-data-target");
      await mkdir(target);
      await writeFile(path.join(target, "fixture-data.json"), '{"fixture":"failed-shutdown"}\n');
      await rm(dataPath, { recursive: true });
      await symlink(target, dataPath, "junction");
    },
  },
  {
    label: "reparse snapshot file",
    mutate(fixture, t) {
      return replaceFixtureFileWithSymlinkOrSkip(
        t,
        path.join(fixture.snapshotDirectory, "data", "fixture-data.json"),
        path.join(fixture.root, "snapshot-file-target.json"),
      );
    },
  },
  {
    label: "hash-mismatched snapshot file",
    async mutate(fixture) {
      const target = path.join(fixture.snapshotDirectory, "data", "fixture-data.json");
      const source = await readFile(target, "utf8");
      await writeFile(target, source.replace("shutdown", "shutdowN"));
    },
  },
  {
    label: "byte-mismatched snapshot file",
    async mutate(fixture) {
      const target = path.join(fixture.snapshotDirectory, "data", "fixture-data.json");
      await writeFile(target, `${await readFile(target, "utf8")}x`);
    },
  },
  {
    label: "missing active file",
    async mutate(fixture) {
      await unlink(path.join(fixture.root, "data", "fixture-data.json"));
    },
  },
  {
    label: "extra active file",
    async mutate(fixture) {
      await writeFile(path.join(fixture.root, "data", "extra.json"), "{}\n");
    },
  },
  {
    label: "undeclared active directory",
    async mutate(fixture) {
      await mkdir(path.join(fixture.root, "data", "unexpected-cache"));
    },
  },
  {
    label: "reparse declared active cache directory",
    async mutate(fixture) {
      const target = path.join(fixture.root, "cache-junction-target");
      await mkdir(target);
      await symlink(
        target,
        path.join(fixture.root, "data", "playwright-browsers"),
        "junction",
      );
    },
  },
  {
    label: "reparse active data directory",
    async mutate(fixture) {
      const dataPath = path.join(fixture.root, "data");
      const target = path.join(fixture.root, "active-data-target");
      await mkdir(target);
      await writeFile(path.join(target, "fixture-data.json"), '{"fixture":"failed-shutdown"}\n');
      await rm(dataPath, { recursive: true });
      await symlink(target, dataPath, "junction");
    },
  },
  {
    label: "reparse active file",
    mutate(fixture, t) {
      return replaceFixtureFileWithSymlinkOrSkip(
        t,
        path.join(fixture.root, "data", "fixture-data.json"),
        path.join(fixture.root, "active-file-target.json"),
      );
    },
  },
  {
    label: "hash-mismatched active file",
    async mutate(fixture) {
      const target = path.join(fixture.root, "data", "fixture-data.json");
      const source = await readFile(target, "utf8");
      await writeFile(target, source.replace("shutdown", "shutdowN"));
    },
  },
  {
    label: "byte-mismatched active file",
    async mutate(fixture) {
      const target = path.join(fixture.root, "data", "fixture-data.json");
      await writeFile(target, `${await readFile(target, "utf8")}x`);
    },
  },
]) {
  test(
    `RecoverFailedShutdown fail-before-kill: ${label}`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      if (await mutate(fixture, t) === false) return;
      await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    },
  );
}

for (const { label, mutate } of [
  {
    label: "tampered control",
    async mutate(fixture) {
      const state = JSON.parse(fixture.controlText);
      state.processId += 1;
      await writeFile(fixture.controlPath, `${JSON.stringify(state)}\n`, "utf8");
    },
  },
  {
    label: "tampered requested receipt",
    async mutate(fixture) {
      const receipt = JSON.parse(fixture.requestedText);
      receipt.hmac = "A".repeat(44);
      await writeFile(fixture.requestedPath, `${JSON.stringify(receipt)}\n`, "utf8");
    },
  },
  {
    label: "tampered terminal receipt",
    async mutate(fixture) {
      const receipt = JSON.parse(fixture.terminalText);
      receipt.hmac = "A".repeat(44);
      await writeFile(fixture.terminalPath, `${JSON.stringify(receipt)}\n`, "utf8");
    },
  },
  {
    label: "missing requested receipt",
    async mutate(fixture) { await unlink(fixture.requestedPath); },
  },
  {
    label: "missing terminal receipt",
    async mutate(fixture) { await unlink(fixture.terminalPath); },
  },
  {
    label: "success terminal receipt",
    mutate(fixture) {
      return writeSignedReceipt(fixture, "terminal", (receipt) => ({
        ...receipt,
        status: "success",
        errorCode: null,
      }));
    },
  },
  {
    label: "unknown terminal receipt",
    mutate(fixture) {
      return writeSignedReceipt(fixture, "terminal", (receipt) => ({
        ...receipt,
        status: "unknown",
        errorCode: null,
      }));
    },
  },
]) {
  test(
    `RecoverFailedShutdown fail-before-kill: ${label}`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      await mutate(fixture);
      await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    },
  );
}

test(
  "RecoverFailedShutdown fail-before-kill: arbitrary dead control without an incident",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const absentPid = 2_147_483_646;
    await writeSignedControl(fixture, (state) => ({
      ...state,
      processId: absentPid,
    }));
    await writeSignedReceipt(fixture, "requested", (receipt) => ({
      ...receipt,
      processId: absentPid,
    }));
    await writeSignedReceipt(fixture, "terminal", (receipt) => ({
      ...receipt,
      processId: absentPid,
    }));

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: executable identity mismatch",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const sentinel = spawn(
      powershell,
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(() => {
      if (sentinel.exitCode === null) sentinel.kill();
    });
    const sentinelTicks = fixtureProcessStartTicks(sentinel.pid);
    await writeSignedControl(fixture, (state) => ({
      ...state,
      processId: sentinel.pid,
      processStartTimeUtcTicks: sentinelTicks,
    }));
    for (const phase of ["requested", "terminal"]) {
      await writeSignedReceipt(fixture, phase, (receipt) => ({
        ...receipt,
        processId: sentinel.pid,
      }));
    }

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: process start-time identity mismatch",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await writeSignedControl(fixture, (state) => ({
      ...state,
      processStartTimeUtcTicks: String(BigInt(state.processStartTimeUtcTicks) + 1n),
    }));

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: live loopback listener",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await startForeignListener(t, { mode: "raw", port: fixture.port });

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: IPv6-only loopback listener",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await startForeignListener(t, { mode: "raw-ipv6", port: fixture.port });

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: live managed descendant",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t, {
      spawnDescendantAfterFailedShutdown: true,
    });

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: ambiguous listener probe",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      'const net = require("node:net");',
      'process.exit(2);\nconst net = require("node:net");',
    );

    const managerSource = await readFile(
      path.join(fixture.root, "scripts", "Manage-MyDashboard.ps1"),
      "utf8",
    );
    assert.match(
      managerSource,
      /return [$]probe[.]ExitCode -ne 61/u,
      "listener ambiguity fixture must preserve the production exit-code mapping",
    );

    const rejected = invokeRecovery(fixture);
    assert.match(
      `${rejected.stderr}\n${rejected.stdout}`,
      /occupied or its probe was ambiguous/u,
    );
    await assertRecoveryRejectedBeforeKill(fixture, rejected);
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: descendant inspection failure",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Test-NoManagedDescendants \{\r?\n\s*param\([^\n]+\)\r?\n)/u,
      '$1    throw "fixture descendant inspection failure"\n',
    );

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown fail-before-kill: evidence changes after lengthy snapshot validation",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(\s*[$]evidence = Assert-SameRecoveryEvidence -Evidence [$]evidence\r?\n)(\s*[$]process = Get-ManagedProcess -State [$]evidence[.]State)/u,
      '    [System.IO.File]::AppendAllText((Get-ReceiptPath -State $evidence.State -Phase "terminal"), " ")\n$1$2',
    );

    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown retains authority when active data changes after exact process exit",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(\s*Wait-ForExactProcessExit -State \$evidence[.]State\r?\n)/u,
      '$1    [System.IO.File]::AppendAllText((Join-Path $dataDirectory "fixture-data.json"), "changed-after-exit")\n',
    );

    const rejected = invokeRecovery(fixture);

    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    await waitForProcessExit(fixture.state.processId);
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), true);
    assert.equal(await fileExists(fixture.terminalPath), true);
    const incident = await onlyRecoveryIncident(fixture);
    const record = JSON.parse(await readFile(incident.recordPath, "utf8"));
    assert.equal(record.state, "pre_termination");
  },
);

test(
  "RecoverFailedShutdown state-machine: incident path is short and binds every original identity",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Recover-FailedShutdown \{[\s\S]*?\s*[$]incident = Publish-RecoveryIncident -Evidence [$]evidence -Snapshot [$]snapshot\r?\n)/u,
      '$1    throw "fixture interruption after incident publication"\n',
    );
    const interrupted = invokeRecovery(fixture);
    assert.notEqual(interrupted.status, 0);
    assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
    const incident = await onlyRecoveryIncident(fixture);
    assert.match(incident.id, /^incident-[a-f0-9]{32}$/u);
    assert.ok(incident.directory.length < 240, incident.directory);
    assert.equal(incident.id.includes(fixture.state.instanceId), false);
    assert.equal(incident.id.includes(fixture.snapshotId), false);

    const record = JSON.parse(await readFile(incident.recordPath, "utf8"));
    assert.deepEqual(Object.keys(record).sort(), [
      "authorityHmac",
      "incidentId",
      "instanceId",
      "processId",
      "processStartTimeUtcTicks",
      "projectDigest",
      "schemaVersion",
      "snapshotId",
      "sourceHashes",
      "startIdentity",
      "state",
    ]);
    assert.equal(record.incidentId, incident.id);
    assert.equal(record.projectDigest, fixture.state.projectDigest);
    assert.equal(record.processId, fixture.state.processId);
    assert.equal(record.instanceId, fixture.state.instanceId);
    assert.equal(
      record.processStartTimeUtcTicks,
      fixture.state.processStartTimeUtcTicks,
    );
    assert.equal(record.startIdentity, fixture.state.startIdentity);
    assert.equal(record.snapshotId, PRESERVED_RECOVERY_SNAPSHOT_ID);
    assert.match(record.authorityHmac, /^[A-Za-z0-9+/]{43}=$/u);
  },
);

test(
  "RecoverFailedShutdown state-machine: matching pre-termination incident resumes idempotently",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Recover-FailedShutdown \{[\s\S]*?\s*[$]incident = Publish-RecoveryIncident -Evidence [$]evidence -Snapshot [$]snapshot\r?\n)/u,
      '$1    throw "fixture interruption after incident publication"\n',
    );
    const interrupted = invokeRecovery(fixture);
    assert.notEqual(interrupted.status, 0);
    assert.doesNotThrow(() => process.kill(fixture.state.processId, 0));
    await onlyRecoveryIncident(fixture);

    await restoreFixtureManager(fixture.root);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown state-machine: conflicting incident is rejected before termination",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Recover-FailedShutdown \{[\s\S]*?\s*[$]incident = Publish-RecoveryIncident -Evidence [$]evidence -Snapshot [$]snapshot\r?\n)/u,
      '$1    throw "fixture interruption after incident publication"\n',
    );
    assert.notEqual(invokeRecovery(fixture).status, 0);
    const incident = await onlyRecoveryIncident(fixture);
    const record = JSON.parse(await readFile(incident.recordPath, "utf8"));
    record.snapshotId = "shutdown-failure-20260813-191305-00000000000000000000000000000000";
    await writeFile(incident.recordPath, `${JSON.stringify(record)}\n`, "utf8");

    await restoreFixtureManager(fixture.root);
    await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown state-machine: matching authenticated incident resumes after exact process exit",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await interruptRecoveryAfterExactExit(fixture);
    assert.equal(await fileExists(fixture.requestedPath), true);
    assert.equal(await fileExists(fixture.terminalPath), true);
    await assertOrdinaryLifecycleBlocked(fixture);

    await restoreFixtureManager(fixture.root);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

for (const archiveName of [
  "control-state.json",
  "requested-receipt.json",
  "terminal-receipt.json",
  "recovery-manifest.json",
]) {
  test(
    `RecoverFailedShutdown state-machine: tampered ${archiveName} is rejected on dead-process resume`,
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      const incident = await interruptRecoveryAfterExactExit(fixture);
      await writeFile(
        path.join(incident.directory, archiveName),
        `${await readFile(path.join(incident.directory, archiveName), "utf8")} `,
        "utf8",
      );

      await restoreFixtureManager(fixture.root);
      const rejected = invokeRecovery(fixture);
      assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
      assert.equal(await fileExists(fixture.controlPath), true);
    },
  );
}

test(
  "RecoverFailedShutdown state-machine: tampered incident authentication is rejected on resume",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const incident = await interruptRecoveryAfterExactExit(fixture);
    const record = JSON.parse(await readFile(incident.recordPath, "utf8"));
    record.state = "recovered";
    await writeFile(incident.recordPath, `${JSON.stringify(record)}\n`, "utf8");

    await restoreFixtureManager(fixture.root);
    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.equal(await fileExists(fixture.controlPath), true);
  },
);

test(
  "RecoverFailedShutdown state-machine: string incident schemaVersion is rejected with its original HMAC",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    const incident = await interruptRecoveryAfterExactExit(fixture);
    const record = JSON.parse(await readFile(incident.recordPath, "utf8"));
    const expectedAuthorityPayload = [
      "recovery-incident-authority-v1",
      String(record.schemaVersion),
      record.incidentId,
      record.state,
      record.projectDigest,
      String(record.processId),
      record.instanceId,
      record.processStartTimeUtcTicks,
      record.startIdentity,
      record.snapshotId,
      record.sourceHashes.control,
      record.sourceHashes.requestedReceipt,
      record.sourceHashes.terminalReceipt,
      record.sourceHashes.manifest,
    ].join("\n");
    assert.equal(
      record.authorityHmac,
      signFixtureDocument(fixture.state.controlToken, expectedAuthorityPayload),
      "incident HMAC must cover schemaVersion before every authority field",
    );

    record.schemaVersion = "1";
    await writeFile(incident.recordPath, `${JSON.stringify(record)}\n`, "utf8");
    await restoreFixtureManager(fixture.root);

    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.equal(await fileExists(fixture.controlPath), true);
  },
);

test(
  "RecoverFailedShutdown state-machine: held writer lease retains authority and retry succeeds",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await interruptRecoveryAfterExactExit(fixture);
    await restoreFixtureManager(fixture.root);
    const holder = createApplicationWriterLease({
      projectRoot: fixture.root,
      projectDigest: fixture.state.projectDigest,
    });
    await holder.acquire();
    let holderClosed = false;
    t.after(async () => {
      if (!holderClosed) await holder.close();
    });

    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /writer lease is not free/u);
    await waitForProcessExit(fixture.state.processId);
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), true);
    assert.equal(await fileExists(fixture.terminalPath), true);
    await onlyRecoveryIncident(fixture);
    await assertOrdinaryLifecycleBlocked(fixture);

    await holder.close();
    holderClosed = true;
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown state-machine: dead-process retry re-proves the listener postcondition",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await interruptRecoveryAfterExactExit(fixture);
    await restoreFixtureManager(fixture.root);
    const listener = await startForeignListener(t, { mode: "raw", port: fixture.port });

    const rejected = invokeRecovery(fixture);
    assert.notEqual(rejected.status, 0, `${rejected.stderr}\n${rejected.stdout}`);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /port remained occupied/u);
    assert.equal(await fileExists(fixture.controlPath), true);

    await stopOwnedFixtureProcess(listener.child);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown state-machine: receipt cleanup resumes after one receipt was removed",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Remove-ExactShutdownReceipts \{[\s\S]*?foreach \([$]phase in @\("requested", "terminal"\)\) \{\r?\n)/u,
      '$1        if ($phase -eq "terminal") { throw "fixture interruption after requested receipt cleanup" }\n',
    );

    const interrupted = invokeRecovery(fixture);
    assert.notEqual(interrupted.status, 0, `${interrupted.stderr}\n${interrupted.stdout}`);
    await waitForProcessExit(fixture.state.processId);
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), false);
    assert.equal(await fileExists(fixture.terminalPath), true);
    const incident = await onlyRecoveryIncident(fixture);
    assert.equal(
      JSON.parse(await readFile(incident.recordPath, "utf8")).state,
      "postconditions_verified",
    );
    await assertOrdinaryLifecycleBlocked(fixture);

    await restoreFixtureManager(fixture.root);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown state-machine: receipt cleanup resumes from an authenticated tombstone",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /(function Remove-ExactShutdownReceipts \{[\s\S]*?\[System[.]IO[.]File\]::Move\([$]path, [$]tombstone\)\r?\n)/u,
      '$1        if ($phase -eq "requested") { throw "fixture interruption with receipt tombstone" }\n',
    );

    const interrupted = invokeRecovery(fixture);
    assert.notEqual(interrupted.status, 0, `${interrupted.stderr}\n${interrupted.stdout}`);
    await waitForProcessExit(fixture.state.processId);
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), false);
    const incident = await onlyRecoveryIncident(fixture);
    assert.equal(
      await fileExists(path.join(incident.directory, "requested-receipt-removal.tmp")),
      true,
    );

    await restoreFixtureManager(fixture.root);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
    assert.equal(
      await fileExists(path.join(incident.directory, "requested-receipt-removal.tmp")),
      false,
    );
  },
);

test(
  "RecoverFailedShutdown state-machine: durable finalization precedes final control removal",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const fixture = await prepareFailedShutdownRecovery(t);
    await rewriteFixtureManager(
      fixture.root,
      /^([ \t]*)Remove-ControlState -ExpectedState [$]evidence[.]State\r?$/mu,
      '$1throw "fixture interruption before final control removal"\r\n$1Remove-ControlState -ExpectedState $evidence.State',
    );

    const interrupted = invokeRecovery(fixture);
    assert.notEqual(interrupted.status, 0, `${interrupted.stderr}\n${interrupted.stdout}`);
    assert.match(
      `${interrupted.stderr}\n${interrupted.stdout}`,
      /fixture interruption before final control removal/u,
    );
    await waitForProcessExit(fixture.state.processId);
    assert.equal(await fileExists(fixture.controlPath), true);
    assert.equal(await fileExists(fixture.requestedPath), false);
    assert.equal(await fileExists(fixture.terminalPath), false);
    const incident = await onlyRecoveryIncident(fixture);
    assert.equal(
      JSON.parse(await readFile(incident.recordPath, "utf8")).state,
      "recovered",
    );
    await assertOrdinaryLifecycleBlocked(fixture);

    await restoreFixtureManager(fixture.root);
    await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
  },
);

test(
  "RecoverFailedShutdown archives a stable failed-shutdown snapshot and leaves the service stopped",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const { root, port } = await createFixture(t, {
      shutdownExitCode: 1,
      holdWriterLeaseAfterFailedShutdown: true,
    });
    const runtime = readRuntimeInfo(root);
    const controlPath = path.join(runtime.runtimeDirectory, "mydashboard-server-process.json");
    const started = invokeManager(root, "Start");
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
    const controlText = await readFile(controlPath, "utf8");
    const state = JSON.parse(controlText);

    const stopped = invokeManager(root, "Stop");
    assert.notEqual(stopped.status, 0);
    assert.match(`${stopped.stderr}\n${stopped.stdout}`, /shutdown failure/u);
    await assertPortUnavailable(port);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    const requestedPath = path.join(
      runtime.runtimeDirectory,
      `mydashboard-shutdown-${state.instanceId}-requested.json`,
    );
    const terminalPath = path.join(
      runtime.runtimeDirectory,
      `mydashboard-shutdown-${state.instanceId}-terminal.json`,
    );
    const requestedText = await readFile(requestedPath, "utf8");
    const terminalText = await readFile(terminalPath, "utf8");
    const { snapshotId, snapshotDirectory } = await createRecoverySnapshot(root, runtime);
    assert.equal(snapshotId, PRESERVED_RECOVERY_SNAPSHOT_ID);

    const restarted = invokeManager(root, "Restart");
    assert.notEqual(restarted.status, 0);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    for (const rejectedSnapshotId of [
      "shutdown-failure-20260813-191305-00000000000000000000000000000000",
      "../shutdown-failure-20260813-191305-ebe114efc20d42ac99e6fc0cc0c99b8f",
    ]) {
      const rejected = invokeManager(
        root,
        "RecoverFailedShutdown",
        10,
        powershell,
        ["-RecoverySnapshotId", rejectedSnapshotId],
      );
      assert.notEqual(rejected.status, 0);
      assert.doesNotThrow(() => process.kill(state.processId, 0));
      assert.equal(await fileExists(controlPath), true);
    }
    const manifestPath = path.join(snapshotDirectory, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8");
    assert.equal(JSON.parse(manifest).createdAt, RECOVERY_SNAPSHOT_CREATED_AT);
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...JSON.parse(manifest), unexpected: true })}\n`,
      "utf8",
    );
    const malformedManifest = invokeManager(
      root,
      "RecoverFailedShutdown",
      10,
      powershell,
      ["-RecoverySnapshotId", snapshotId],
    );
    assert.notEqual(malformedManifest.status, 0);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    await writeFile(manifestPath, manifest, "utf8");
    const activeDataPath = path.join(root, "data", "fixture-data.json");
    const activeData = await readFile(activeDataPath, "utf8");
    await writeFile(activeDataPath, "tampered\n", "utf8");
    const mismatchedData = invokeManager(
      root,
      "RecoverFailedShutdown",
      10,
      powershell,
      ["-RecoverySnapshotId", snapshotId],
    );
    assert.notEqual(mismatchedData.status, 0);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    await writeFile(activeDataPath, activeData, "utf8");
    const terminal = await readFile(terminalPath, "utf8");
    await writeFile(
      terminalPath,
      `${JSON.stringify({ ...JSON.parse(terminal), hmac: "A".repeat(44) })}\n`,
      "utf8",
    );
    const tamperedReceipt = invokeManager(
      root,
      "RecoverFailedShutdown",
      10,
      powershell,
      ["-RecoverySnapshotId", snapshotId],
    );
    assert.notEqual(tamperedReceipt.status, 0);
    assert.doesNotThrow(() => process.kill(state.processId, 0));
    await writeFile(terminalPath, terminal, "utf8");
    const recovered = invokeManager(
      root,
      "RecoverFailedShutdown",
      10,
      powershell,
      ["-RecoverySnapshotId", snapshotId],
    );

    assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
    assert.match(recovered.stdout, /incident/u);
    assert.match(recovered.stdout, /remains stopped/u);
    await waitForProcessExit(state.processId);
    await assertPortUnavailable(port);
    await assert.rejects(readFile(controlPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(
      runtime.runtimeDirectory,
      `mydashboard-shutdown-${state.instanceId}-requested.json`,
    ), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(
      runtime.runtimeDirectory,
      `mydashboard-shutdown-${state.instanceId}-terminal.json`,
    ), "utf8"), { code: "ENOENT" });
    const incidentNames = await readdir(path.join(runtime.runtimeDirectory, "incidents"));
    assert.equal(incidentNames.length, 1);
    assert.match(incidentNames[0], /^incident-[a-f0-9]{32}$/u);
    const incidentDirectory = path.join(
      runtime.runtimeDirectory,
      "incidents",
      incidentNames[0],
    );
    const incidents = await readFile(path.join(
      incidentDirectory,
      "incident.json",
    ), "utf8");
    assert.match(incidents, /"state":"recovered"/u);
    assert.equal(await readFile(path.join(incidentDirectory, "control-state.json"), "utf8"), controlText);
    assert.equal(await readFile(path.join(incidentDirectory, "requested-receipt.json"), "utf8"), requestedText);
    assert.equal(await readFile(path.join(incidentDirectory, "terminal-receipt.json"), "utf8"), terminalText);
    assert.equal(await readFile(path.join(incidentDirectory, "recovery-manifest.json"), "utf8"), manifest);

    const laterStart = invokeManager(root, "Start");
    assert.equal(laterStart.status, 0, `${laterStart.stderr}\n${laterStart.stdout}`);
    const nextState = JSON.parse(await readFile(controlPath, "utf8"));
    assert.notEqual(nextState.processId, state.processId);
    process.kill(nextState.processId);
    await waitForProcessExit(nextState.processId);
  },
);

test(
  "broad-write ACL and runtime junctions are rejected before process control",
  { skip: WINDOWS_MANAGER_SKIP },
  async (t) => {
    const first = await createFixture(t);
    const firstRuntime = readRuntimeInfo(first.root);
    const initialized = invokeManager(first.root, "Status");
    assert.equal(initialized.status, 3, `${initialized.stderr}\n${initialized.stdout}`);
    const aclScript = [
      `$target = '${firstRuntime.runtimeDirectory.replaceAll("'", "''")}'`,
      "$acl = [System.IO.Directory]::GetAccessControl($target)",
      "$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
      "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
      "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
      "[void]$acl.AddAccessRule($rule)",
      "[System.IO.Directory]::SetAccessControl($target, $acl)",
    ].join("; ");
    const weakened = spawnSync(
      powershell,
      ["-NoProfile", "-Command", aclScript],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(weakened.status, 0, `${weakened.stderr}\n${weakened.stdout}`);
    const refusedAcl = invokeManager(first.root, "Status");
    assert.notEqual(refusedAcl.status, 0);
    assert.match(`${refusedAcl.stderr}\n${refusedAcl.stdout}`, /broad write access/u);

    const second = await createFixture(t);
    const secondRuntime = readRuntimeInfo(second.root);
    await mkdir(path.dirname(secondRuntime.runtimeDirectory), { recursive: true });
    const junctionTarget = path.join(second.root, "runtime-junction-target");
    await mkdir(junctionTarget);
    await symlink(junctionTarget, secondRuntime.runtimeDirectory, "junction");
    const refusedJunction = invokeManager(second.root, "Status");
    assert.notEqual(refusedJunction.status, 0);
    assert.match(`${refusedJunction.stderr}\n${refusedJunction.stdout}`, /not a regular directory/u);
    await unlink(secondRuntime.runtimeDirectory);
  },
);

for (const beforePreparation of [true, false]) {
  test(
    "RecoverFailedShutdown preserves code-executor artifacts " + (beforePreparation ? "present before preparation" : "added after snapshot"),
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      let fixture = await prepareFailedShutdownRecovery(t, { createRecoverySnapshot: !beforePreparation });
      const artifactPath = path.join(fixture.root, "data", "code-executor", "artifacts", "output.json");
      const artifact = Buffer.from('{"result":"audited immutable output"}\n');
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifact);
      const rootPath = path.join(fixture.root, "data", "fixture-data.json");
      if (beforePreparation) {
        await writeFile(rootPath, '{"artifact":"code-executor/artifacts/output.json"}\n');
        const prepared = invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10);
        assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
        const snapshotId = prepared.stdout.match(/shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}/u)?.[0];
        assert.equal(typeof snapshotId, "string");
        fixture = { ...fixture, snapshotId, snapshotDirectory: path.join(fixture.runtime.runtimeDirectory, "recovery-snapshots", snapshotId) };
      }
      const rootBytes = await readFile(rootPath);
      assert.deepEqual(await readFile(artifactPath), artifact);
      assert.equal(await fileExists(path.join(fixture.snapshotDirectory, "data", "code-executor")), false);
      assert.deepEqual(await readFile(path.join(fixture.snapshotDirectory, "data", "fixture-data.json")), rootBytes);
      await assertRecoveryCompleted(fixture, invokeRecovery(fixture));
      assert.deepEqual(await readFile(artifactPath), artifact);
      assert.deepEqual(await readFile(rootPath), rootBytes);
    },
  );
}

for (const invalidKind of ["wrong case", "file", "junction", "snapshot directory"]) {
  test(
    "RecoverFailedShutdown rejects code-executor " + invalidKind + " before termination",
    { skip: WINDOWS_MANAGER_SKIP },
    async (t) => {
      const fixture = await prepareFailedShutdownRecovery(t);
      const component = path.join(fixture.root, "data", "code-executor");
      if (invalidKind === "wrong case") await mkdir(path.join(fixture.root, "data", "Code-Executor"));
      if (invalidKind === "file") await writeFile(component, "invalid component file\n");
      if (invalidKind === "junction") {
        const target = path.join(fixture.root, "executor-junction-target");
        await mkdir(target);
        await symlink(target, component, "junction");
      }
      if (invalidKind === "snapshot directory") await mkdir(path.join(fixture.snapshotDirectory, "data", "code-executor"));
      await assertRecoveryRejectedBeforeKill(fixture, invokeRecovery(fixture));
    },
  );
}

for (const variant of ["recover", "late-terminal", "changed-request"]) {
  test(`interrupted shutdown with authenticated request and missing terminal: ${variant}`,
    { skip: WINDOWS_MANAGER_SKIP }, async t => {
      const fixture = await createUnexpectedExitRecoveryFixture(t, {prepare:false});
      const receipt = {schemaVersion:1, phase:"requested", status:"unknown", processId:fixture.state.processId,
        instanceId:fixture.state.instanceId, startIdentity:fixture.state.startIdentity,
        atUnixMilliseconds:String(Date.now()), errorCode:null, hmac:""};
      receipt.hmac = signFixtureDocument(fixture.state.controlToken, receiptPayload(receipt));
      const original = JSON.stringify(receipt) + "\n";
      await writeFile(fixture.requestedPath, original);
      const prepared = invokeManager(fixture.root, "PrepareFailedShutdownRecovery", 10);
      assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
      fixture.snapshotId = prepared.stdout.match(/shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}/u)?.[0];
      assert.equal(typeof fixture.snapshotId, "string");
      fixture.snapshotDirectory = path.join(fixture.runtime.runtimeDirectory, "recovery-snapshots", fixture.snapshotId);
      const manifest = JSON.parse(await readFile(path.join(fixture.snapshotDirectory,"manifest.json"),"utf8"));
      assert.equal(manifest.reason, "managed_shutdown_exit_without_terminal");
      assert.equal(await readFile(fixture.requestedPath,"utf8"),original);
      assert.equal(await fileExists(fixture.terminalPath),false);
      if (variant === "late-terminal") await writeFile(fixture.terminalPath, '{"late":true}\n');
      if (variant === "changed-request") await writeSignedReceipt(fixture,"requested",r=>({...r,atUnixMilliseconds:String(Date.now()+1)}));
      const result = invokeRecovery(fixture);
      if (variant !== "recover") {
        assert.notEqual(result.status,0,result.stdout);
        assert.equal(await fileExists(fixture.controlPath),true);
        assert.equal(await fileExists(fixture.requestedPath),true);
        return;
      }
      await assertRecoveryCompleted(fixture,result);
      const incident = await onlyRecoveryIncident(fixture);
      assert.equal(await readFile(path.join(incident.directory,"requested-receipt.json"),"utf8"),original);
      assert.equal(await fileExists(path.join(incident.directory,"terminal-receipt.json")),false);
      const record = JSON.parse(await readFile(incident.recordPath,"utf8"));
      assert.equal(record.sourceHashes.requestedReceipt,createHash("sha256").update(original).digest("hex"));
      assert.equal(record.state,"recovered");
    });
}
