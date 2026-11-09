import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import http from "node:http";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDashboardServer,
  createManagedFileDiagnostics,
  readManagedProcessEnvironment,
  startDashboardServer,
} from "../src/server.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";

function request(server, {
  method = "GET",
  path: requestPath = "/api/live",
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        method,
        path: requestPath,
        headers: {
          host: "127.0.0.1:4173",
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function managedIdentity(runtimeDirectory, overrides = {}) {
  const token = randomBytes(32).toString("base64");
  return {
    token,
    tokenBytes: Buffer.from(token, "base64"),
    runtimeDirectory,
    logDirectory: path.join(runtimeDirectory, "logs"),
    projectDigest: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    startIdentity: randomBytes(32).toString("hex"),
    claimTimeoutMilliseconds: 5_000,
    ...overrides,
  };
}

function controlHeaders(identity, overrides = {}) {
  return {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "x-mydashboard-control-token": identity.token,
    "x-mydashboard-process-id": String(process.pid),
    "x-mydashboard-instance-id": identity.instanceId,
    "x-mydashboard-start-identity": identity.startIdentity,
    ...overrides,
  };
}

function application({ close = async () => {} } = {}) {
  return {
    config: { port: 4173 },
    employeeRegistry: new EmployeeRegistry([]),
    refreshService: { running: false },
    close,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function availablePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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

function assertAuthenticatedReceipt(receipt, identity) {
  assert.equal(receipt.processId, process.pid);
  assert.equal(receipt.instanceId, identity.instanceId);
  assert.equal(receipt.startIdentity, identity.startIdentity);
  assert.equal(
    receipt.hmac,
    createHmac("sha256", identity.tokenBytes)
      .update(receiptPayload(receipt), "utf8")
      .digest("base64"),
  );
}

test("managed environment is all-or-nothing and is erased after capture", () => {
  const runtimeDirectory = path.join(tmpdir(), `managed-env-${randomUUID()}`);
  const identity = managedIdentity(runtimeDirectory);
  const environment = {
    MYDASHBOARD_MANAGED_TOKEN: identity.token,
    MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY: runtimeDirectory,
    MYDASHBOARD_MANAGED_PROJECT_DIGEST: identity.projectDigest,
    MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS: "5000",
    MYDASHBOARD_MANAGED_LOG_DIRECTORY: path.join(runtimeDirectory, "logs"),
    MYDASHBOARD_MANAGED_INSTANCE_ID: identity.instanceId,
    MYDASHBOARD_MANAGED_START_IDENTITY: identity.startIdentity,
  };
  const captured = readManagedProcessEnvironment(environment);
  assert.equal(captured.token, identity.token);
  assert.deepEqual(Object.keys(environment), []);

  const incomplete = { MYDASHBOARD_MANAGED_TOKEN: identity.token };
  assert.throws(
    () => readManagedProcessEnvironment(incomplete),
    /environment is incomplete/u,
  );
  assert.deepEqual(Object.keys(incomplete), []);
});

test("managed startup passes its authenticated private runtime directory to composition", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-composition-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const identity = managedIdentity(runtimeDirectory);
  const composedApplication = application();
  composedApplication.config.port = await availablePort();
  let compositionOptions = null;
  const server = await startDashboardServer({
    managedProcess: identity,
    createApplicationFn: async (options) => {
      compositionOptions = options;
      return composedApplication;
    },
    startBackgroundWorkFn: () => ({
      initialRefresh: Promise.resolve(),
      async stop() {},
    }),
    log() {},
  });

  try {
    assert.equal(compositionOptions.privateRuntimeDirectory, runtimeDirectory);
    const claimed = await request(server, {
      method: "POST",
      path: "/api/system/claim",
      headers: controlHeaders(identity, {
        host: `127.0.0.1:${composedApplication.config.port}`,
        origin: `http://127.0.0.1:${composedApplication.config.port}`,
      }),
    });
    assert.equal(claimed.status, 200);
  } finally {
    await server.shutdown();
  }
});

test("pending claim gates work and shutdown is bound to token and start identity", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-control-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const identity = managedIdentity(runtimeDirectory);
  let activations = 0;
  let stops = 0;
  const terminations = [];
  const reportedErrors = [];
  const server = createDashboardServer(application(), {
    managedProcess: identity,
    backgroundWork: { async stop() { stops += 1; } },
    onManagedClaim() { activations += 1; },
    reportError(error) { reportedErrors.push(error); },
    terminateManagedProcess(code) { terminations.push(code); },
  });
  await listen(server);

  const pendingLive = JSON.parse((await request(server)).body);
  assert.equal(pendingLive.lifecycleState, "pending_claim");
  assert.equal(pendingLive.instanceId, identity.instanceId);
  assert.equal((await request(server, { path: "/api/health" })).status, 503);
  assert.equal((await request(server, {
    method: "POST",
    path: "/api/system/claim",
    headers: controlHeaders(identity, {
      "x-mydashboard-control-token": randomBytes(32).toString("base64"),
    }),
  })).status, 403);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimed = await request(server, {
      method: "POST",
      path: "/api/system/claim",
      headers: controlHeaders(identity),
    });
    assert.equal(claimed.status, 200);
  }
  assert.equal(activations, 1);
  assert.equal(JSON.parse((await request(server)).body).lifecycleState, "running");

  const wrongInstance = await request(server, {
    method: "POST",
    path: "/api/system/shutdown",
    headers: controlHeaders(identity, {
      "x-mydashboard-instance-id": randomUUID(),
    }),
  });
  assert.equal(wrongInstance.status, 403);
  const beforeShutdown = await readdir(runtimeDirectory);
  assert.equal(beforeShutdown.some((name) => name.includes("shutdown")), false);

  const closed = once(server, "close");
  const accepted = await request(server, {
    method: "POST",
    path: "/api/system/shutdown",
    headers: controlHeaders(identity),
  });
  assert.equal(accepted.status, 202);
  const requestedPath = path.join(
    runtimeDirectory,
    `mydashboard-shutdown-${identity.instanceId}-requested.json`,
  );
  const requested = JSON.parse(await readFile(requestedPath, "utf8"));
  assert.equal(requested.status, "unknown");
  assertAuthenticatedReceipt(requested, identity);
  await closed;
  await server.shutdown();
  const terminal = JSON.parse(await readFile(path.join(
    runtimeDirectory,
    `mydashboard-shutdown-${identity.instanceId}-terminal.json`,
  ), "utf8"));
  assert.equal(terminal.status, "success");
  assertAuthenticatedReceipt(terminal, identity);
  assert.equal(stops, 1);
  assert.deepEqual(terminations, [0]);
  assert.deepEqual(reportedErrors, []);
});

test("unclaimed managed child self-closes without activating background work", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-watchdog-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const identity = managedIdentity(runtimeDirectory, {
    claimTimeoutMilliseconds: 40,
  });
  let activations = 0;
  let applicationCloses = 0;
  const server = createDashboardServer(application({
    close: async () => { applicationCloses += 1; },
  }), {
    managedProcess: identity,
    backgroundWork: { async stop() {} },
    onManagedClaim() { activations += 1; },
  });
  await listen(server);
  server.armManagedClaimWatchdog();
  await once(server, "close");
  await server.shutdown();
  assert.equal(activations, 0);
  assert.equal(applicationCloses, 1);
});

test("lifecycle failure produces an authenticated failure receipt", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-failure-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const identity = managedIdentity(runtimeDirectory);
  const failure = new Error("close failed");
  const reportedErrors = [];
  const server = createDashboardServer(application({
    close: async () => { throw failure; },
  }), {
    managedProcess: identity,
    backgroundWork: { async stop() {} },
    onManagedClaim() {},
    reportError(error) { reportedErrors.push(error); },
    setProcessExitCode() {},
  });
  await listen(server);
  await request(server, {
    method: "POST",
    path: "/api/system/claim",
    headers: controlHeaders(identity),
  });
  const closed = once(server, "close");
  await request(server, {
    method: "POST",
    path: "/api/system/shutdown",
    headers: controlHeaders(identity),
  });
  await closed;
  await assert.rejects(server.shutdown(), /close failed/u);
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = JSON.parse(await readFile(path.join(
    runtimeDirectory,
    `mydashboard-shutdown-${identity.instanceId}-terminal.json`,
  ), "utf8"));
  assert.equal(terminal.status, "failure");
  assert.equal(terminal.errorCode, "LIFECYCLE_FAILURE");
  assertAuthenticatedReceipt(terminal, identity);
  assert.deepEqual(reportedErrors, [failure]);
});

test("a drain timeout publishes failure and retains the authoritative writer lease", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-timeout-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const identity = managedIdentity(runtimeDirectory);
  let applicationCloses = 0;
  let leaseCloses = 0;
  const server = createDashboardServer(application({
    close: async () => { applicationCloses += 1; },
  }), {
    managedProcess: identity,
    backgroundWork: { stop: () => new Promise(() => {}) },
    onManagedClaim() {},
    writerLease: {
      async acquire() {},
      async close() { leaseCloses += 1; },
    },
    shutdownDrainTimeoutMs: 20,
    reportError() {},
    setProcessExitCode() {},
  });
  await listen(server);
  await request(server, {
    method: "POST",
    path: "/api/system/claim",
    headers: controlHeaders(identity),
  });
  await request(server, {
    method: "POST",
    path: "/api/system/shutdown",
    headers: controlHeaders(identity),
  });

  await assert.rejects(server.shutdown(), { code: "LIFECYCLE_DRAIN_TIMEOUT" });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = JSON.parse(await readFile(path.join(
    runtimeDirectory,
    `mydashboard-shutdown-${identity.instanceId}-terminal.json`,
  ), "utf8"));
  assert.equal(terminal.status, "failure");
  assert.equal(terminal.errorCode, "LIFECYCLE_FAILURE");
  assertAuthenticatedReceipt(terminal, identity);
  assert.equal(applicationCloses, 0);
  assert.equal(leaseCloses, 0);
});

test("a full diagnostics disk cannot throw into background work and logging recovers", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-log-full-"));
  const append = fs.appendFileSync;
  let full = true;
  const mocked = t.mock.method(fs, "appendFileSync", (...args) => {
    if (full) throw Object.assign(new Error("disk is full"), { code: "ENOSPC" });
    return append(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => { mocked.mock.restore(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); });
  const diagnostics = createManagedFileDiagnostics(directory);
  assert.doesNotThrow(() => diagnostics.reportError(new Error("background failure")));
  assert.deepEqual(diagnostics.writeStatus, { droppedRecords: 1, lastErrorCode: "ENOSPC" });
  full = false;
  diagnostics.log("service remains controllable");
  assert.deepEqual(diagnostics.writeStatus, { droppedRecords: 0, lastErrorCode: null });
  const content = await readFile(diagnostics.logPath, "utf8");
  assert.match(content, /recovered after 1 dropped record/);
  assert.match(content, /ENOSPC/);
  assert.match(content, /service remains controllable/);
});

test("managed diagnostics rotate during a live process and stay globally bounded", async (t) => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "managed-logs-"));
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const logDirectory = path.join(runtimeDirectory, "logs");
  const diagnostics = createManagedFileDiagnostics(logDirectory, {
    maximumBytes: 64 * 1024,
    archiveCount: 2,
  });
  const identity = managedIdentity(runtimeDirectory);
  const liveApplication = application();
  const largeRecord = "x".repeat(16 * 1024);
  liveApplication.employeeRegistry = {
    async listRoles() {
      throw new Error(largeRecord);
    },
  };
  const server = createDashboardServer(liveApplication, {
    managedProcess: identity,
    backgroundWork: { async stop() {} },
    onManagedClaim() {},
    reportError: diagnostics.reportError,
  });
  await listen(server);
  await request(server, {
    method: "POST",
    path: "/api/system/claim",
    headers: controlHeaders(identity),
  });
  for (let index = 0; index < 40; index += 1) {
    assert.equal((await request(server, { path: "/api/health" })).status, 500);
  }
  const closed = once(server, "close");
  await request(server, {
    method: "POST",
    path: "/api/system/shutdown",
    headers: controlHeaders(identity),
  });
  await closed;
  await server.shutdown();

  const files = (await readdir(logDirectory))
    .filter((name) => name.startsWith("server.log"));
  assert.deepEqual(files.sort(), ["server.log", "server.log.1", "server.log.2"]);
  const sizes = await Promise.all(files.map(async (name) =>
    (await stat(path.join(logDirectory, name))).size));
  assert.equal(sizes.every((size) => size <= 64 * 1024), true);
  assert.equal(sizes.reduce((total, size) => total + size, 0) <= 3 * 64 * 1024, true);
});
