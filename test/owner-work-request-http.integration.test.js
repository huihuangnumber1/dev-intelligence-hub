import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../src/composition-root.js";
import { StateStore } from "../src/lib/state-store.js";
import { createDashboardServer } from "../src/server.js";
import { ownerWorkRequestForItem } from "../public/manual-work-assignment.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function guardFactory() {
  return {
    async acquire() {},
    async run(operation) {
      return operation();
    },
    async close() {},
  };
}

function role() {
  return {
    name: "Command orchestrator",
    mission: "Coordinate one bounded shared-work graph.",
    enabled: true,
    scheduleMinutes: 0,
    initialPaused: false,
    workerId: "employee-orchestrator",
    permissions: { allowedIntents: ["orchestrate", "complete"] },
    brain: {
      provider: "fixture-local",
      model: "fixture-orchestrator",
      remoteData: { requirements: false, code: false, memory: false },
    },
  };
}

function config() {
  return {
    port: 4173,
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    githubActions: { enabled: false, enabledActions: [] },
    codeExecutor: { enabled: false },
    changePackages: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 20,
      workLimit: 20,
      dispatchLimit: 20,
      attentionLimit: 20,
      proposalLimit: 20,
      conditionLimit: 20,
      codeJobLimit: 20,
      codeJobMemoryLimit: 20,
      leaseDurationMs: 60_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: { coordination: "orchestrator" },
        githubReviewRoles: [],
        codeActionRoles: [],
        codeOperationsByRole: {},
        workspaceByRepository: {},
      },
    },
    memory: { enabled: false },
    brainProviders: {
      "fixture-local": {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: { orchestrator: role() },
    },
  };
}

function ownerRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    workType: "general",
    priority: "normal",
    title: "Coordinate a local acceptance task",
    description: "Create one persistent shared root through production composition.",
    acceptanceCriteria: ["One orchestrator-owned root", "Replay is idempotent"],
    ...overrides,
  };
}

function request(server, {
  method = "GET",
  pathname,
  body = null,
  trusted = false,
} = {}) {
  const headers = { host: "127.0.0.1:4173" };
  const encoded = body === null ? null : JSON.stringify(body);
  if (trusted) {
    headers.origin = "http://127.0.0.1:4173";
    headers["x-mydashboard-action"] = "1";
    headers["content-type"] = "application/json";
  }
  if (encoded !== null) headers["content-length"] = Buffer.byteLength(encoded);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        method,
        path: pathname,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (encoded !== null) outgoing.end(encoded);
    else outgoing.end();
  });
}

async function composedServer(store, root, signals, configuration = config()) {
  const clock = () => new Date();
  const application = await createApplication({
    config: configuration,
    versionedConfiguration: false,
    externalActions: false,
    store,
    operationsRuntimeFactory: () => Object.freeze({
      admission: Object.freeze({ run: (operation) => operation() }),
    }),
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    ownerWorkRequestDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    confirmationRuntimeDependencies: { createGuard: guardFactory, clock },
    prEngineerExclusiveGuardFactory: guardFactory,
    workCoordinationDependencies: {
      clock,
      brainDependencies: {
        async fetch() {
          throw new Error("owner intake must not call a model");
        },
      },
    },
    operationsOptions: {
      dataDirectory: path.join(root, "state"),
      backupDirectory: path.join(root, "backups"),
    },
  });
  const server = createDashboardServer(application, {
    backgroundWork: {
      async signalAgency(options) {
        signals.push(options);
      },
      async stop() {},
    },
    reportError(error) {
      throw error;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("real loopback HTTP reaches production routing, feed, ledger, graph, and restart recovery", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-http-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const signals = [];
  let server = await composedServer(store, root, signals);

  const injection = await request(server, {
    method: "POST",
    pathname: "/api/work/requests",
    trusted: true,
    body: { ...ownerRequest(), roleId: "developer" },
  });
  assert.equal(injection.status, 400);

  const created = await request(server, {
    method: "POST",
    pathname: "/api/work/requests",
    trusted: true,
    body: ownerRequest(),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.deduplicated, false);
  assert.equal(created.body.phase, "intaken");
  assert.deepEqual(created.body.assignment.target, {
    type: "role",
    id: "orchestrator",
  });

  const [assignments, items, graph, requests] = await Promise.all([
    request(server, { pathname: "/api/workflow/assignments?limit=10" }),
    request(server, { pathname: "/api/work/items?limit=10" }),
    request(server, { pathname: "/api/work/graph" }),
    request(server, { pathname: "/api/work/requests?limit=10" }),
  ]);
  assert.equal(assignments.status, 200);
  assert.equal(items.status, 200);
  assert.equal(graph.status, 200);
  assert.equal(requests.status, 200);
  assert.equal(assignments.body.items.length, 1);
  assert.equal(items.body.items.length, 1);
  assert.equal(graph.body.totalTaskCount, 1);
  assert.equal(requests.body.items.length, 1);
  assert.equal(assignments.body.items[0].target.id, "orchestrator");
  assert.equal(items.body.items[0].itemId, created.body.workItemId);
  assert.equal(graph.body.graph.tasks[0].taskId, created.body.workItemId);
  assert.deepEqual(signals, [{ trigger: "owner_request_created" }]);

  await server.shutdown();
  server = await composedServer(store, root, signals);
  const replay = await request(server, {
    method: "POST",
    pathname: "/api/work/requests",
    trusted: true,
    body: ownerRequest(),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deduplicated, true);
  assert.equal(replay.body.workItemId, created.body.workItemId);
  assert.equal(
    (await request(server, { pathname: "/api/workflow/assignments?limit=10" }))
      .body.items.length,
    1,
  );
  assert.equal(
    (await request(server, { pathname: "/api/work/items?limit=10" })).body
      .items.length,
    1,
  );
  assert.deepEqual(signals, [{ trigger: "owner_request_created" }]);
  await server.shutdown();
});

test("manual Issue requirements crosses HTTP intake and replays one durable task after restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-issue-http-"));
  const store = new StateStore(path.join(root, "state"));
  const signals = [];
  const configuration = config();
  configuration.employees.roles["requirements-analyst"] = {
    ...role(),
    name: "Requirements analyst",
    workerId: "employee-requirements-analyst",
    permissions: { allowedIntents: ["ask_user", "handoff", "submit_delivery", "complete"] },
  };
  configuration.workCoordination.policy.capabilityRoles.requirements = "requirements-analyst";
  let server = await composedServer(store, root, signals, configuration);
  t.after(async () => {
    if (server.listening) await server.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const input = ownerWorkRequestForItem({
    kind: "issue",
    repo: "ExampleOrg/ProductApp",
    number: 13303,
    title: "Add a scan protocol",
  }, { workType: "requirements", priority: "high", requestId: REQUEST_ID });

  const untrusted = await request(server, {
    method: "POST", pathname: "/api/work/requests", body: input,
  });
  assert.equal(untrusted.status, 403);
  const missingIssue = { ...input };
  delete missingIssue.issue;
  for (const body of [
    missingIssue,
    { ...input, targetRoleId: "developer" },
    { ...input, issue: { ...input.issue, number: 0 } },
    { ...input, workType: "pull_request" },
  ]) {
    const rejected = await request(server, {
      method: "POST", pathname: "/api/work/requests", trusted: true, body,
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal((await request(server, {
    pathname: "/api/work/requests?limit=10",
  })).body.items.length, 0);

  const created = await request(server, {
    method: "POST", pathname: "/api/work/requests", trusted: true, body: input,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.phase, "intaken");
  assert.deepEqual(created.body.request, input);
  assert.deepEqual(created.body.assignment.target, { type: "role", id: "requirements-analyst" });
  const items = await request(server, { pathname: "/api/work/items?limit=10" });
  assert.equal(items.body.items.length, 1);
  assert.equal(items.body.items[0].event.eventType, "issue.owner_requested");
  assert.deepEqual(items.body.items[0].event.subject, {
    id: "github:issue:ExampleOrg/ProductApp#13303",
    repository: "ExampleOrg/ProductApp",
    number: 13303,
  });

  await server.shutdown();
  server = await composedServer(store, root, signals, configuration);
  const replay = await request(server, {
    method: "POST", pathname: "/api/work/requests", trusted: true, body: input,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deduplicated, true);
  assert.equal(replay.body.workItemId, created.body.workItemId);
  const conflict = await request(server, {
    method: "POST", pathname: "/api/work/requests", trusted: true,
    body: { ...input, priority: "urgent" },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await request(server, {
    pathname: "/api/work/items?limit=10",
  })).body.items.length, 1);
  assert.deepEqual(signals, [{ trigger: "owner_request_created" }]);
});

test("real owner intake accepts the canonical contract maximum and rejects bodies over 72 KiB", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-http-limit-"));
  const store = new StateStore(path.join(root, "state"));
  const signals = [];
  const server = await composedServer(store, root, signals);
  t.after(async () => {
    if (server.listening) await server.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const maximumRequest = ownerRequest({
    requestId: "123e4567-e89b-42d3-a456-426614174001",
    priority: "urgent",
    title: "T".repeat(256),
    description: "\\".repeat(12 * 1024),
    acceptanceCriteria: Array.from(
      { length: 20 },
      (_, index) => `${String(index).padStart(2, "0")}${"\\".repeat(998)}`,
    ),
  });
  const maximumBytes = Buffer.byteLength(JSON.stringify(maximumRequest));
  assert.equal(maximumBytes > 16 * 1024, true);
  assert.equal(maximumBytes < 72 * 1024, true);

  const accepted = await request(server, {
    method: "POST",
    pathname: "/api/work/requests",
    trusted: true,
    body: maximumRequest,
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.phase, "intaken");
  assert.deepEqual(accepted.body.assignment.target, {
    type: "role",
    id: "orchestrator",
  });

  const oversizedRequest = ownerRequest({
    requestId: "123e4567-e89b-42d3-a456-426614174002",
    description: "x".repeat(72 * 1024),
  });
  assert.equal(
    Buffer.byteLength(JSON.stringify(oversizedRequest)) > 72 * 1024,
    true,
  );
  const rejected = await request(server, {
    method: "POST",
    pathname: "/api/work/requests",
    trusted: true,
    body: oversizedRequest,
  });
  assert.equal(rejected.status, 413);
  assert.equal((await request(server, {
    pathname: "/api/work/requests?limit=10",
  })).body.items.length, 1);
  assert.deepEqual(signals, [{ trigger: "owner_request_created" }]);
});
