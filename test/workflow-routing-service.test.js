import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWorkflowRouter } from "../src/domain/workflow-router.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { WorkflowRoutingService } from "../src/services/workflow-routing-service.js";
import { MAX_WORKFLOW_STATE_BYTES } from "../src/services/workflow-routing-state.js";
import { prettySerializedWorkflowBytes } from "../src/services/workflow-routing-values.js";
import { AutomaticReviewReentryReader } from "../src/services/automatic-review-reentry-reader.js";
import { withPrLifecycleRoutes } from "../src/domain/pr-lifecycle-routing.js";
import { AutomaticHeadAncestryReader } from "../src/services/automatic-head-ancestry-reader.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { createLocalWorkLedgerCandidateProcessor } from "../src/services/work-ledger-candidate-processor.js";

const STATE_KEY = "workflow-routing-state";
const MAX_PAGE_SIZE = 100;

test("returning own PR preserves a verified descendant target after a created-event causal gap", async () => {
  const account = "runtime-user", a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
  const target = headRefOid => ({ schemaVersion: 1, provider: "github", sourceAccountId: account,
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40),
    headRepository: "acme/repo", headRefName: "feature", headRefOid });
  const item = head => pullRequest(42, { state: "open", author: account, assignees: [account], relation: "authored",
    isDraft: false, actionState: "action_now", nextAction: "address_review", headRefOid: head,
    gitTargetAvailable: true, gitTarget: target(head) });
  let ledger, ancestryReader, reader, currentHead = a;
  const github = { async isCommitAncestor({ ancestorOid, headRefOid }) {
    assert.equal(ancestorOid, a); assert.equal(headRefOid, currentHead); return true;
  }, async readPullRequestRoleHandoffFacts() {
    return { state: "open", isDraft: false, author: account, assignees: [account], gitTarget: target(currentHead) };
  } };
  const routing = new WorkflowRoutingService({ store: new MemoryStore(), router: createWorkflowRouter(),
    exclusiveLease: new ExclusiveLease(), clock: incrementingClock(), scopeReentryReader: {
      async read(options) { return ledger ? reader.read(options) : []; }
    }, headAncestryReader: {
      async read(options) { return ledger ? ancestryReader.read(options) : []; }
    } });
  await routing.recover();
  const definition = workflowConfig(); definition.rules[0].targets = [{ type: "role", id: "developer" }];
  await configure(routing, withPrLifecycleRoutes(definition));
  const ledgerStore = new MemoryStore();
  let id = 0;
  const boot = async () => {
    const lease = new ExclusiveLease();
    const runtime = await createWorkLedgerRuntime({ store: ledgerStore, assignmentSource: routing, clock: incrementingClock(),
      idFactory: () => `bridge-lease-${++id}`,
      createGuard: () => ({ acquire: async () => {}, run: action => lease.run(action), close: async () => {} }),
      attachHostHeadAncestry: ports => { ancestryReader = new AutomaticHeadAncestryReader({ ledger: ports,
        github, account, clock: incrementingClock(), record: ports.record }); } });
    reader = new AutomaticReviewReentryReader({ ledger: runtime, github, account, automaticReview: false, automaticOwnPrRepair: true });
    return runtime;
  };
  ledger = await boot();
  assert.equal(ledger.recordHostHeadAncestry, undefined, "the host writer is absent from every runtime facade");
  assert.equal(ledger.readHostHeadAncestryCandidates, undefined);
  const ingest = async (head, time) => {
    if (head) currentHead = head;
    const snapshot = workflowSnapshot({ refreshedAt: time, items: head ? [item(head)] : [] });
    snapshot.sourceStatus.githubPullRequests.complete = true;
    await routing.ingestSnapshot({ snapshot }); await ledger.intake();
  };
  await ingest(a, "2026-08-02T01:00:00.000Z");
  await ingest(null, "2026-08-02T01:01:00.000Z");
  await ingest(b, "2026-08-02T01:02:00.000Z");
  await ingest(c, "2026-08-02T01:03:00.000Z");
  const roots = (await ledger.listItems()).items.filter(row => row.kind === "source_root");
  assert.equal(roots.length, 1, "reentry must not create another execution root");
  const root = roots[0];
  assert.equal(root.source.revisions.some(row => row.headRefOid === b && row.previousHeadRefOid === null), true,
    "created events correctly carry no invented previous Head");
  assert.equal([root.source.current.headRefOid, root.source.pending?.headRefOid].includes(c), true,
    "a host-verified ordinary descendant must become current or pending without rewriting old events");
  assert.equal(root.status, "queued", "safe reentry remains naturally claimable through the original task");
  const receipt = root.source.revisions.find(row => row.headAncestryProof).headAncestryProof;
  assert.equal(Object.hasOwn(receipt.event.payload, "previousHeadRefOid"), false);
  await ledger.close();
  ledger = await boot();
  assert.equal((await ledger.listItems()).items.find(row => row.kind === "source_root").source.current.headRefOid, c);
  await ledger.close();
  const good = ledgerStore.stored("work-ledger-state"), damaged = clone(good);
  damaged.items.find(row => row.kind === "source_root").source.revisions.find(row => row.headAncestryProof)
    .headAncestryProof.event.payload.gitTarget.baseRefOid = "f".repeat(40);
  ledgerStore.replaceStored("work-ledger-state", damaged);
  await assert.rejects(boot(), { code: "WORK_LEDGER_STATE_CORRUPTED" }, "restart detects altered protected proof content");
  ledgerStore.replaceStored("work-ledger-state", good);
  await assert.rejects(routing.ingest({ event: { schemaVersion: 1, eventType: "pull_request.updated", occurredAt: receipt.event.occurredAt,
    source: receipt.event.source, subject: receipt.event.subject, payload: { ...receipt.event.payload, headAncestryProof: receipt.receiptId } } }),
  { code: "WORKFLOW_EVENT_HOST_ONLY" }, "ordinary and historical client ingestion cannot manufacture a trusted receipt reference");
  const historical = (await routing.readAssignmentBatch({ afterSequence: 0, limit: 100 })).items
    .find(row => row.event.payload.headAncestryProof);
  const lease = new ExclusiveLease();
  const injected = await createWorkLedgerRuntime({ store: new MemoryStore(), clock: incrementingClock(), idFactory: () => "injected-lease",
    createCandidateProcessor: createLocalWorkLedgerCandidateProcessor,
    createGuard: () => ({ acquire: async () => {}, run: action => lease.run(action), close: async () => {} }),
    assignmentSource: { readAssignmentBatch: async ({ afterSequence }) => ({
      items: afterSequence === 0 ? [{ ...historical, sequence: 1 }] : [], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 }) } });
  assert.equal((await injected.intake()).received, 1);
  assert.equal((await injected.listItems()).items.some(row => row.kind === "source_root"), false,
    "an injected historical proof reference cannot create a root without its protected host receipt");
  await injected.close();
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function readdress(record, idName, prefix) {
  const { [idName]: _id, contentDigest: _digest, ...content } = record;
  const contentDigest = createHash("sha256")
    .update(JSON.stringify(canonical(content)))
    .digest("hex");
  return {
    [idName]: `${prefix}-${contentDigest}`,
    contentDigest,
    ...content,
  };
}

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([key, value]) => [key, clone(value)]),
    );
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? clone(this.values.get(name)) : clone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copied = clone(value);
    this.values.set(name, copied);
    this.writes.push({ name, value: copied });
  }

  failNextWrite(error = new Error("durable write unavailable")) {
    this.nextWriteError = error;
  }

  clearWrites() {
    this.writes.length = 0;
  }

  stored(name) {
    return clone(this.values.get(name));
  }

  replaceStored(name, value) {
    this.values.set(name, clone(value));
  }
}

class ContentVersionMemoryStore extends MemoryStore {
  constructor(entries = {}) {
    super(entries);
    this.versions = new Map();
    this.valueReads = 0;
  }

  async readVersioned(name, fallback = null, { ifVersion } = {}) {
    if (!this.versions.has(name)) this.versions.set(name, Object.freeze({}));
    const version = this.versions.get(name);
    if (ifVersion === version) return { changed: false, version };
    this.valueReads += 1;
    return { changed: true, version, value: await super.read(name, fallback) };
  }

  async write(name, value) {
    await super.write(name, value);
    const version = Object.freeze({});
    this.versions.set(name, version);
    return version;
  }

  replaceStored(name, value) {
    super.replaceStored(name, value);
    this.versions.set(name, Object.freeze({}));
  }
}

class StubRouter {
  constructor(route = defaultRoute) {
    this.routeResult = route;
    this.calls = [];
  }

  async route(input) {
    this.calls.push(clone(input));
    return clone(await this.routeResult(input));
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

function defaultRoute(input) {
  return createWorkflowRouter().route(input);
}

function workflowConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [
      {
        id: "pr-review",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: {
          op: "globAny",
          path: "eventType",
          patterns: ["pull_request.*"],
        },
        targets: [{ type: "role", id: "pr-reviewer" }],
        onMatch: "stop",
      },
    ],
    ...overrides,
  };
}

function issueOnlyConfig(overrides = {}) {
  return workflowConfig({
    rules: [
      {
        id: "issue-only",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: {
          op: "equals",
          path: "eventType",
          value: "issue.created",
        },
        targets: [{ type: "role", id: "requirements-analyst" }],
        onMatch: "stop",
      },
    ],
    ...overrides,
  });
}

function threeRuleWorkflowConfig() {
  return workflowConfig({
    rules: [
      {
        ...workflowConfig().rules[0],
        id: "pr-review",
        priority: 100,
        onMatch: "continue",
      },
      {
        ...workflowConfig().rules[0],
        id: "issue-analysis",
        priority: 90,
        condition: {
          op: "globAny",
          path: "eventType",
          patterns: ["issue.*"],
        },
        targets: [{ type: "role", id: "requirements-analyst" }],
        onMatch: "continue",
      },
      {
        ...workflowConfig().rules[0],
        id: "owner-fallback",
        priority: 0,
        fallback: true,
        condition: null,
        targets: [{ type: "person", id: "owner" }],
      },
    ],
  });
}

function workflowEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:00:00.000Z",
    source: {
      provider: "github",
      scopeId: "acme/repo",
    },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      number: 42,
      author: "octocat",
      labels: ["risk:high"],
    },
    ...overrides,
  };
}

function workflowSnapshot({
  refreshedAt = "2026-08-02T01:00:00.000Z",
  pullRequestsOk = true,
  issuesOk = true,
  items = [],
} = {}) {
  return {
    refreshedAt,
    sourceStatus: {
      githubPullRequests: { ok: pullRequestsOk, stale: !pullRequestsOk },
      githubIssues: { ok: issuesOk, stale: !issuesOk },
    },
    items,
  };
}

function pullRequest(number, overrides = {}) {
  return {
    id: `github:pr:acme/repo#${number}`,
    kind: "pull_request",
    repo: "acme/repo",
    number,
    title: `PR ${number}`,
    author: "octocat",
    state: "OPEN",
    labels: [],
    ...overrides,
  };
}

function issue(number, overrides = {}) {
  return {
    id: `github:issue:acme/repo#${number}`,
    kind: "issue",
    repo: "acme/repo",
    number,
    title: `Issue ${number}`,
    author: "octocat",
    relation: "assigned",
    state: "open",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    labels: [],
    assignees: ["local-owner"],
    ...overrides,
  };
}

function incrementingClock() {
  let tick = 0;
  const epoch = Date.parse("2026-08-02T02:00:00.000Z");
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}

async function createFixture({
  store = new MemoryStore(),
  router = new StubRouter(),
  exclusiveLease = new ExclusiveLease(),
  recordLimit,
  configHistoryLimit,
  stateByteBudget,
  auditByteBudget,
  bundleByteBudget,
  actionAdmissionGate,
  issueActiveWindowDays,
} = {}) {
  const service = new WorkflowRoutingService({
    store,
    router,
    clock: incrementingClock(),
    exclusiveLease,
    ...(issueActiveWindowDays === undefined
      ? {}
      : { issueActiveWindowDays }),
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
    ...(recordLimit === undefined ? {} : { recordLimit }),
    ...(configHistoryLimit === undefined ? {} : { configHistoryLimit }),
    ...(stateByteBudget === undefined ? {} : { stateByteBudget }),
    ...(auditByteBudget === undefined ? {} : { auditByteBudget }),
    ...(bundleByteBudget === undefined ? {} : { bundleByteBudget }),
  });
  await service.recover();
  return { service, store, router };
}

async function configure(service, definition = workflowConfig()) {
  return service.replaceConfig({
    definition,
    expectedVersion: 0,
    changedBy: "owner",
  });
}

function assertDigest(value) {
  assert.match(value, /^[a-f0-9]{64}$/);
}

function assertPage(page) {
  assert.equal(Array.isArray(page.items), true);
  assert.equal(
    page.nextCursor === null || typeof page.nextCursor === "string",
    true,
  );
}

test("versioned routing reads reuse validated state after committed writes", async () => {
  const store = new ContentVersionMemoryStore();
  const { service } = await createFixture({ store });
  await configure(service);
  const ingested = await service.ingest({ event: workflowEvent() });
  const valueReads = store.valueReads;
  const writes = store.writes.length;
  store.read = async () => { throw new Error("unversioned read is forbidden"); };

  const first = await service.readAssignmentBatch({ afterSequence: 0, limit: 100 });
  const second = await service.readAssignmentBatch({ afterSequence: 1, limit: 100 });

  assert.equal(first.items[0].assignment.assignmentId, ingested.assignments[0].assignmentId);
  first.items[0].assignment.target.id = "mutated-projection";
  assert.equal((await service.readAssignmentBatch({ afterSequence: 0, limit: 100 }))
    .items[0].assignment.target.id, "pr-reviewer");
  assert.equal(second.items.length, 0);
  assert.equal(store.valueReads, valueReads);
  assert.equal(store.writes.length, writes);
});

test("versioned routing reads observe another writer before reusing state", async () => {
  const store = new ContentVersionMemoryStore();
  const { service } = await createFixture({ store });
  await configure(service);
  const { service: writer } = await createFixture({ store });
  const ingested = await writer.ingest({ event: workflowEvent() });
  const valueReads = store.valueReads;

  const batch = await service.readAssignmentBatch({ afterSequence: 0, limit: 100 });
  await service.readAssignmentBatch({ afterSequence: 0, limit: 100 });

  assert.equal(batch.items[0].assignment.assignmentId, ingested.assignments[0].assignmentId);
  assert.equal(store.valueReads, valueReads + 1);
});

test("versioned routing reads keep rejecting changed invalid or conflicting content", async () => {
  for (const [change, expectedCode] of [
    [(state) => { state.events.push(clone(state.events[0])); state.revision += 1; },
      "WORKFLOW_STATE_CORRUPTED"],
    [(_state, older) => older, "WORKFLOW_STATE_REVISION_CONFLICT"],
    [(state) => {
      state.currentConfig.changedBy = "another-owner";
      state.configHistory.at(-1).changedBy = "another-owner";
    }, "WORKFLOW_STATE_REVISION_CONFLICT"],
    [() => null, "WORKFLOW_STATE_CORRUPTED"],
    [(state) => {
      state.schemaVersion = 1;
      delete state.assignmentFeed;
      delete state.assignmentHighWatermark;
      delete state.assignmentOldestAvailableSequence;
    }, "WORKFLOW_STATE_REVISION_CONFLICT"],
  ]) {
    const store = new ContentVersionMemoryStore();
    const { service } = await createFixture({ store });
    await configure(service);
    const older = store.stored(STATE_KEY);
    await service.ingest({ event: workflowEvent() });
    const original = store.stored(STATE_KEY);
    const changed = clone(original);
    const replacement = change(changed, older);
    store.replaceStored(STATE_KEY, replacement === undefined ? changed : replacement);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(service.readAssignmentBatch({ afterSequence: 0, limit: 100 }),
        (error) => error.code === expectedCode);
    }
    const readsAfterFailure = store.valueReads;
    store.replaceStored(STATE_KEY, original);
    assert.equal((await service.readAssignmentBatch({ afterSequence: 0, limit: 100 })).items.length, 1);
    assert.equal(store.valueReads, readsAfterFailure + 1);
  }
});

test("versioned routing reads fail closed on malformed or unknown content versions", async () => {
  const malformedResults = [
    { changed: false, version: Object.freeze({}) },
    { changed: false, version: undefined },
    { changed: true, version: "unknown", value: null },
    { changed: true, version: {}, value: null },
    { changed: true, version: Object.freeze({ unexpected: true }), value: null },
    { changed: true, version: Object.freeze(new Date()), value: null },
    { changed: true, version: Object.freeze({}) },
  ];
  for (const result of malformedResults) {
    const store = new ContentVersionMemoryStore();
    const { service } = await createFixture({ store });
    await configure(service);
    const writes = store.writes.length;
    store.readVersioned = async () => result;
    await assert.rejects(service.readAssignmentBatch({ afterSequence: 0, limit: 100 }),
      /StateStore versioned read result is invalid/);
    assert.equal(store.writes.length, writes);
  }
});

test("versioned routing migration records the committed upgrade content version", async () => {
  const { service: original, store: originalStore } = await createFixture();
  await configure(original);
  await original.ingest({ event: workflowEvent() });
  const legacy = originalStore.stored(STATE_KEY);
  legacy.schemaVersion = 1;
  delete legacy.assignmentFeed;
  delete legacy.assignmentHighWatermark;
  delete legacy.assignmentOldestAvailableSequence;
  const store = new ContentVersionMemoryStore({ [STATE_KEY]: legacy });
  const { service } = await createFixture({ store });
  const valueReads = store.valueReads;

  assert.equal((await service.readAssignmentBatch({ afterSequence: 0, limit: 100 })).items.length, 1);
  assert.equal(store.valueReads, valueReads);
  assert.equal(store.stored(STATE_KEY).schemaVersion, 2);
});

test("versioned routing writes without a trustworthy version force a full reread", async () => {
  for (const writtenVersion of [undefined, "unknown", {}, Object.freeze({ invalid: true })]) {
    const store = new ContentVersionMemoryStore();
    const write = store.write.bind(store);
    store.write = async (...args) => { await write(...args); return writtenVersion; };
    const { service } = await createFixture({ store });
    await configure(service);
    const valueReads = store.valueReads;

    await service.readAssignmentBatch({ afterSequence: 0, limit: 100 });

    assert.equal(store.valueReads, valueReads + 1);
  }
});

test("an explicit invalid workflow admission gate never degrades to direct mode", async () => {
  await assert.rejects(
    createFixture({ actionAdmissionGate: null }),
    /actionAdmissionGate must provide run\(operation\)/,
  );
});

test("configuration replacements are versioned, content-addressed, and whole rather than merged", async () => {
  const { service, store } = await createFixture();
  const firstDefinition = workflowConfig();

  const first = await service.replaceConfig({
    definition: firstDefinition,
    expectedVersion: 0,
    changedBy: "owner",
  });
  const replacementDefinition = {
    schemaVersion: 1,
    enabled: false,
    maxHops: 8,
    rules: [],
  };
  const second = await service.replaceConfig({
    definition: replacementDefinition,
    expectedVersion: 1,
    changedBy: "owner",
  });
  const projection = await service.getConfig();

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assertDigest(first.digest);
  assertDigest(second.digest);
  assert.notEqual(first.digest, second.digest);
  assert.deepEqual(second.definition, replacementDefinition);
  assert.deepEqual(projection.current, second);
  assert.deepEqual(
    projection.history.map(({ version, digest, definition, changedBy }) => ({
      version,
      digest,
      definition,
      changedBy,
    })),
    [
      {
        version: 1,
        digest: first.digest,
        definition: firstDefinition,
        changedBy: "owner",
      },
      {
        version: 2,
        digest: second.digest,
        definition: replacementDefinition,
        changedBy: "owner",
      },
    ],
  );
  assert.deepEqual(second.definition.rules, []);
  assert.deepEqual(store.writes.map((entry) => entry.name), [STATE_KEY, STATE_KEY]);

  await assert.rejects(
    service.replaceConfig({
      definition: firstDefinition,
      expectedVersion: 1,
      changedBy: "stale-editor",
    }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_CONFLICT",
  );
  assert.equal(store.writes.length, 2);
});

test("trusted PR scope lifecycle assignments survive disabled ordinary routing", async () => {
  const { service, store } = await createFixture();
  await configure(service, {
    schemaVersion: 1,
    enabled: false,
    maxHops: 8,
    rules: [],
  });

  const observed = await service.ingestSnapshot({
    snapshot: workflowSnapshot({ items: [pullRequest(42)] }),
  });
  const leftScope = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-02T01:01:00.000Z",
      items: [],
    }),
  });

  assert.deepEqual(
    observed.events.map(({ eventType }) => eventType),
    ["pull_request.observed"],
  );
  assert.equal(observed.assignments.length, 0);
  for (const [result, eventType] of [
    [leftScope, "pull_request.left_scope"],
  ]) {
    assert.deepEqual(result.events.map(({ eventType: type }) => type), [eventType]);
    assert.equal(result.assignments.length, 1);
    assert.equal(
      result.assignments[0].ruleId,
      "system-pull-request-scope-lifecycle",
    );
    assert.deepEqual(result.assignments[0].target, {
      type: "node",
      id: "system-pull-request-scope-lifecycle",
    });
    assert.deepEqual(result.audit[0].assignmentIds, [
      result.assignments[0].assignmentId,
    ]);
  }

  const recreated = await createFixture({ store });
  const batch = await recreated.service.readAssignmentBatch({
    afterSequence: 0,
    limit: 10,
  });
  assert.deepEqual(
    batch.items.map(({ event }) => event.eventType),
    ["pull_request.left_scope"],
  );
});

test("ordinary configuration cannot impersonate the trusted PR lifecycle route", async () => {
  const { service, store } = await createFixture();
  const forged = workflowConfig();
  forged.rules[0] = {
    ...forged.rules[0],
    id: "system-pull-request-scope-lifecycle",
    priority: 10_000,
    targets: [{
      type: "node",
      id: "system-pull-request-scope-lifecycle",
    }],
  };

  await assert.rejects(
    configure(service, forged),
    (error) => error.code === "INVALID_ROUTING_CONFIG",
  );
  assert.equal(store.writes.length, 0);
  assert.equal((await service.getConfig()).current, null);
});

test("recover restores configuration history and content-addressed routing records", async () => {
  const { service, store } = await createFixture();
  const config = await configure(service);
  const result = await service.ingest({ event: workflowEvent() });

  assert.equal(result.deduplicated, false);
  assertDigest(result.event.contentDigest);
  assert.equal(typeof result.event.eventId, "string");
  assert.notEqual(result.event.eventId, "");
  assert.equal(result.assignments.length, 1);
  assert.equal(result.audit.length, 1);
  for (const record of [...result.assignments, ...result.audit]) {
    assertDigest(record.contentDigest);
  }
  assert.equal(result.assignments[0].eventId, result.event.eventId);
  assert.equal(result.assignments[0].configVersion, config.version);
  assert.equal(result.assignments[0].configDigest, config.digest);
  assert.equal(result.audit[0].eventId, result.event.eventId);
  assert.equal(result.audit[0].configVersion, config.version);
  assert.deepEqual(result.audit[0].assignmentIds, [
    result.assignments[0].assignmentId,
  ]);

  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await recreated.recover();

  assert.deepEqual(await recreated.getConfig(), await service.getConfig());
  assert.deepEqual(
    await recreated.listAssignments(),
    await service.listAssignments(),
  );
  assert.deepEqual(await recreated.listAudit(), await service.listAudit());
});

test("ingest is content-idempotent and canonical object key order does not create duplicate work", async () => {
  const { service, store, router } = await createFixture();
  await configure(service);
  store.clearWrites();
  const original = workflowEvent();
  const reordered = {
    payload: {
      labels: ["risk:high"],
      author: "octocat",
      number: 42,
    },
    subject: {
      number: 42,
      repository: "acme/repo",
      id: "github:pr:acme/repo#42",
    },
    source: {
      scopeId: "acme/repo",
      provider: "github",
    },
    occurredAt: original.occurredAt,
    eventType: original.eventType,
    schemaVersion: 1,
  };

  const first = await service.ingest({ event: original });
  const duplicate = await service.ingest({ event: reordered });

  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.event.eventId, first.event.eventId);
  assert.deepEqual(duplicate.assignments, first.assignments);
  assert.deepEqual(duplicate.audit, first.audit);
  assert.equal(router.calls.length, 1);
  assert.equal(store.writes.length, 1);
  assert.equal((await service.listAssignments()).items.length, 1);
  assert.equal((await service.listAudit()).items.length, 1);
});

test("configuration-first admission creates no event or snapshot assignments", async (t) => {
  for (const kind of ["event", "snapshot"]) {
    await t.test(kind, async () => {
      const gate = readyActionAdmissionGate();
      const { service, store, router } = await createFixture({
        actionAdmissionGate: gate,
      });
      await configure(service);
      store.clearWrites();
      router.calls.length = 0;
      await activateNextConfiguration(gate);

      const ingestion = kind === "event"
        ? service.ingest({ event: workflowEvent() })
        : service.ingestSnapshot({
            snapshot: workflowSnapshot({ items: [pullRequest(42)] }),
          });
      await assert.rejects(
        ingestion,
        (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
      );

      assert.equal(router.calls.length, 0);
      assert.equal(store.writes.length, 0);
      assert.deepEqual(await service.listAssignments(), {
        items: [],
        nextCursor: null,
      });
      assert.equal(gate.readStatus().mode, "restart_required");
    });
  }
});

test("ingest-first admission releases cutover before old-config routing settles", async () => {
  const routeEntered = deferred();
  const releaseRoute = deferred();
  const gate = readyActionAdmissionGate();
  const router = new StubRouter(async (input) => {
    routeEntered.resolve();
    await releaseRoute.promise;
    return defaultRoute(input);
  });
  const { service } = await createFixture({
    router,
    actionAdmissionGate: gate,
  });
  const configured = await configure(service);

  const ingestion = service.ingest({ event: workflowEvent() });
  await routeEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseRoute.resolve();
  const ingested = await ingestion;
  assert.equal(ingested.assignments.length, 1);
  assert.equal(ingested.assignments[0].configVersion, configured.version);
  assert.equal(ingested.assignments[0].configDigest, configured.digest);
  assert.equal(gate.readStatus().mode, "restart_required");
  await assert.rejects(
    service.ingest({
      event: workflowEvent({
        subject: {
          ...workflowEvent().subject,
          id: "github:pr:acme/repo#43",
          number: 43,
        },
      }),
    }),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );
});

test("snapshot-first admission preserves one atomic old-config batch", async () => {
  const routeEntered = deferred();
  const releaseRoute = deferred();
  const gate = readyActionAdmissionGate();
  const router = new StubRouter(async (input) => {
    routeEntered.resolve();
    await releaseRoute.promise;
    return defaultRoute(input);
  });
  const { service } = await createFixture({
    router,
    actionAdmissionGate: gate,
  });
  const configured = await configure(service);

  const ingestion = service.ingestSnapshot({
    snapshot: workflowSnapshot({
      items: [pullRequest(42), pullRequest(43)],
    }),
  });
  await routeEntered.promise;
  assert.equal(
    await Promise.race([
      activateNextConfiguration(gate),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );

  releaseRoute.resolve();
  const ingested = await ingestion;
  assert.equal(ingested.assignments.length, 2);
  assert.equal(
    ingested.assignments.every(
      ({ configVersion, configDigest }) =>
        configVersion === configured.version &&
        configDigest === configured.digest,
    ),
    true,
  );
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("dryRun explains a candidate definition without writing events, assignments, audit, or config", async () => {
  const { service, store, router } = await createFixture();
  const active = await configure(service);
  store.clearWrites();
  const beforeConfig = await service.getConfig();
  const candidate = workflowConfig({
    rules: [
      {
        id: "owner-fallback",
        source: "root",
        enabled: true,
        priority: 0,
        fallback: true,
        condition: null,
        targets: [{ type: "person", id: "owner" }],
        onMatch: "stop",
      },
    ],
  });

  const result = await service.dryRun({
    event: workflowEvent(),
    definition: candidate,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.persisted, false);
  assertDigest(result.event.contentDigest);
  assertDigest(result.configDigest);
  assert.notEqual(result.configDigest, active.digest);
  assert.equal(result.assignments.length, 1);
  assert.deepEqual(router.calls.at(-1).config, candidate);
  assert.deepEqual(await service.getConfig(), beforeConfig);
  assert.deepEqual(await service.listAssignments(), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(await service.listAudit(), {
    items: [],
    nextCursor: null,
  });
  assert.equal(store.writes.length, 0);
});

test("assignment and audit queries are newest-first, cursor-paged, and capped at 100", async () => {
  const { service } = await createFixture();
  await configure(service);
  const assignmentIds = [];
  const auditIds = [];

  for (let number = 1; number <= MAX_PAGE_SIZE + 5; number += 1) {
    const ingested = await service.ingest({
      event: workflowEvent({
        occurredAt: new Date(
          Date.parse("2026-08-02T01:00:00.000Z") + number * 1_000,
        ).toISOString(),
        source: {
          provider: "github",
          scopeId: "acme/repo",
        },
        subject: {
          id: `github:pr:acme/repo#${number}`,
          repository: "acme/repo",
          number,
        },
        payload: { number },
      }),
    });
    assignmentIds.push(ingested.assignments[0].assignmentId);
    auditIds.push(ingested.audit[0].auditId);
  }

  const cappedAssignments = await service.listAssignments({ limit: 999 });
  const cappedAudit = await service.listAudit({ limit: 999 });
  assert.equal(cappedAssignments.items.length, MAX_PAGE_SIZE);
  assert.equal(cappedAudit.items.length, MAX_PAGE_SIZE);
  assertPage(cappedAssignments);
  assertPage(cappedAudit);
  assert.notEqual(cappedAssignments.nextCursor, null);
  assert.notEqual(cappedAudit.nextCursor, null);
  assert.deepEqual(
    cappedAssignments.items.slice(0, 2).map((item) => item.assignmentId),
    assignmentIds.slice(-2).reverse(),
  );
  assert.deepEqual(
    cappedAudit.items.slice(0, 2).map((item) => item.auditId),
    auditIds.slice(-2).reverse(),
  );
  assert.equal(cappedAssignments.items[0].target.id, "pr-reviewer");

  const first = await service.listAssignments({ limit: 2 });
  const firstAudit = await service.listAudit({ limit: 2 });
  assertPage(first);
  assertPage(firstAudit);
  assert.equal(first.items.length, 2);
  assert.equal(firstAudit.items.length, 2);
  assert.notEqual(first.nextCursor, null);
  assert.notEqual(firstAudit.nextCursor, null);
  const expectedOlderIds = first.items.map((item) => item.assignmentId);
  const expectedOlderAuditIds = firstAudit.items.map((item) => item.auditId);

  await service.ingest({
    event: workflowEvent({
      occurredAt: "2026-08-02T03:00:00.000Z",
      source: { provider: "github", scopeId: "acme/repo" },
      subject: {
        id: "github:pr:acme/repo#999",
        repository: "acme/repo",
        number: 999,
      },
      payload: { number: 999 },
    }),
  });
  const second = await service.listAssignments({
    limit: 2,
    cursor: first.nextCursor,
  });
  const secondAudit = await service.listAudit({
    limit: 2,
    cursor: firstAudit.nextCursor,
  });
  assertPage(second);
  assertPage(secondAudit);
  assert.equal(second.items.length, 2);
  assert.equal(secondAudit.items.length, 2);
  assert.equal(
    second.items.some((item) => expectedOlderIds.includes(item.assignmentId)),
    false,
  );
  assert.equal(
    secondAudit.items.some((item) =>
      expectedOlderAuditIds.includes(item.auditId),
    ),
    false,
  );

  await assert.rejects(
    service.listAssignments({ limit: 0 }),
    (error) => error.code === "WORKFLOW_QUERY_INVALID",
  );
  await assert.rejects(
    service.listAudit({ cursor: "not-a-real-cursor" }),
    (error) => error.code === "WORKFLOW_CURSOR_INVALID",
  );
});

test("a rejected config write leaves the live and recovered version history unchanged", async () => {
  const { service, store } = await createFixture();
  const first = await configure(service);
  const durableBefore = store.stored(STATE_KEY);
  store.failNextWrite();

  await assert.rejects(
    service.replaceConfig({
      definition: workflowConfig({ enabled: false, rules: [] }),
      expectedVersion: first.version,
      changedBy: "owner",
    }),
    (error) => error.code === "WORKFLOW_STATE_WRITE_FAILED",
  );

  assert.deepEqual((await service.getConfig()).current, first);
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await recreated.recover();
  assert.deepEqual((await recreated.getConfig()).current, first);
});

test("a rejected ingest write never exposes half-written assignments or audit", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  const durableBefore = store.stored(STATE_KEY);
  store.clearWrites();
  store.failNextWrite();

  await assert.rejects(
    service.ingest({ event: workflowEvent() }),
    (error) => error.code === "WORKFLOW_STATE_WRITE_FAILED",
  );

  assert.deepEqual(await service.listAssignments(), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(await service.listAudit(), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
  assert.equal(store.writes.length, 0);

  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await recreated.recover();
  assert.deepEqual(await recreated.listAssignments(), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(await recreated.listAudit(), {
    items: [],
    nextCursor: null,
  });

  const retried = await recreated.ingest({ event: workflowEvent() });
  assert.equal(retried.deduplicated, false);
  assert.equal((await recreated.listAssignments()).items.length, 1);
  assert.equal((await recreated.listAudit()).items.length, 1);
});

test("recover fails closed when a content-addressed durable record was altered", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  await service.ingest({ event: workflowEvent() });
  const corrupted = store.stored(STATE_KEY);
  corrupted.assignments[0].reason = "tampered after persistence";
  store.replaceStored(STATE_KEY, corrupted);
  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });

  await assert.rejects(
    recreated.recover(),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
});

test("snapshot ingestion checkpoints facts and does not flood unchanged items", async () => {
  const { service, router } = await createFixture();
  await configure(service);
  const snapshot = workflowSnapshot({ items: [pullRequest(42)] });

  const baseline = await service.ingestSnapshot({ snapshot });
  const repeated = await service.ingestSnapshot({ snapshot });

  assert.deepEqual(
    baseline.events.map((event) => event.eventType),
    ["pull_request.observed"],
  );
  assert.equal(baseline.assignments.length, 1);
  assert.deepEqual(repeated.events, []);
  assert.deepEqual(repeated.assignments, []);
  assert.equal(router.calls.length, 1);
  assert.equal((await service.listAssignments()).items.length, 1);
});

test("snapshot ingestion never routes an issue outside the configured active window", async () => {
  const { service, router } = await createFixture({
    issueActiveWindowDays: 3,
  });
  await configure(service, workflowConfig({
    rules: [{
      id: "issue-analysis",
      source: "root",
      enabled: true,
      priority: 100,
      fallback: false,
      condition: {
        op: "globAny",
        path: "eventType",
        patterns: ["issue.*"],
      },
      targets: [{ type: "role", id: "requirements-analyst" }],
      onMatch: "stop",
    }],
  }));

  const result = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      items: [
        issue(40, { updatedAt: "2026-07-28T00:00:00.000Z" }),
        issue(41, { updatedAt: "2026-07-31T00:00:00.000Z" }),
      ],
    }),
  });

  assert.deepEqual(result.events.map(({ subject }) => subject.number), [41]);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.audit.length, 1);
  assert.equal(router.calls.length, 1);
  assert.equal((await service.listAssignments()).items.length, 1);
  assert.equal((await service.listAudit()).items.length, 1);
});

test("configured Issue window survives persistence and recovery without duplicate creation", async () => {
  const store = new MemoryStore();
  const first = await createFixture({
    store,
    issueActiveWindowDays: 30,
  });
  await configure(first.service, issueOnlyConfig());
  const activeIssue = issue(52, {
    updatedAt: "2026-08-11T01:00:00.000Z",
  });
  await first.service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-31T01:00:00.000Z",
      items: [activeIssue],
    }),
  });
  assert.equal(store.stored(STATE_KEY).checkpoint.items.length, 1);

  const recovered = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
    issueActiveWindowDays: 30,
  });
  await recovered.recover();
  const repeated = await recovered.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-09-01T01:00:00.000Z",
      items: [activeIssue],
    }),
  });

  assert.deepEqual(repeated.events, []);
});

test("a failed snapshot write preserves the old checkpoint for exact retry", async () => {
  const store = new MemoryStore();
  const fixture = await createFixture({ store });
  await configure(fixture.service);
  await fixture.service.ingestSnapshot({
    snapshot: workflowSnapshot({ items: [pullRequest(42)] }),
  });
  const changed = workflowSnapshot({
    refreshedAt: "2026-08-02T01:05:00.000Z",
    items: [
      pullRequest(42, { labels: ["risk:high"] }),
      pullRequest(43),
    ],
  });
  store.failNextWrite();

  await assert.rejects(
    fixture.service.ingestSnapshot({ snapshot: changed }),
    (error) => error.code === "WORKFLOW_STATE_WRITE_FAILED",
  );
  assert.equal((await fixture.service.listAssignments()).items.length, 1);

  const recovered = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await recovered.recover();
  const retried = await recovered.ingestSnapshot({ snapshot: changed });

  assert.deepEqual(
    retried.events.map((event) => event.eventType),
    [
      "pull_request.updated",
      "pull_request.classified",
      "pull_request.created",
    ],
  );
  assert.equal(retried.assignments.length, 4);
  assert.equal(
    retried.assignments.filter(
      ({ ruleId }) => ruleId === "system-pull-request-scope-lifecycle",
    ).length,
    1,
  );
  assert.equal((await recovered.listAssignments()).items.length, 5);
});

test("an unhealthy refresh retains the last healthy routing baseline", async () => {
  const { service } = await createFixture();
  await configure(service);
  await service.ingestSnapshot({
    snapshot: workflowSnapshot({ items: [pullRequest(42)] }),
  });
  const unhealthy = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-02T01:05:00.000Z",
      pullRequestsOk: false,
      items: [pullRequest(42)],
    }),
  });
  const recovered = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-02T01:10:00.000Z",
      items: [pullRequest(42, { labels: ["backend"] })],
    }),
  });

  assert.deepEqual(unhealthy.events, []);
  assert.deepEqual(
    recovered.events.map((event) => event.eventType),
    ["pull_request.updated", "pull_request.classified"],
  );
  assert.equal(
    recovered.events.some((event) => event.eventType.endsWith(".observed")),
    false,
  );
});

test("an unhealthy Issue refresh preserves freshness until a healthy refresh settles scope once", async () => {
  const { service } = await createFixture({ issueActiveWindowDays: 3 });
  await configure(service, issueOnlyConfig());
  const activeIssue = issue(77, {
    updatedAt: "2026-08-01T12:00:00.000Z",
  });
  await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-02T01:00:00.000Z",
      items: [activeIssue],
    }),
  });

  const unhealthy = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-06T01:00:00.000Z",
      issuesOk: false,
      items: [],
    }),
  });
  const settled = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-06T01:05:00.000Z",
      items: [],
    }),
  });
  const repeated = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-06T01:10:00.000Z",
      items: [],
    }),
  });

  assert.deepEqual(unhealthy.events, []);
  assert.equal(unhealthy.checkpointRefreshedAt, "2026-08-02T01:00:00.000Z");
  assert.deepEqual(
    settled.events.map(({ eventType }) => eventType),
    ["issue.left_scope"],
  );
  assert.deepEqual(repeated.events, []);
});

test("shared exclusive leases re-read durable revision before every write", async () => {
  const store = new MemoryStore();
  const exclusiveLease = new ExclusiveLease();
  const first = await createFixture({ store, exclusiveLease });
  const second = await createFixture({ store, exclusiveLease });

  await configure(first.service);
  await assert.rejects(
    second.service.replaceConfig({
      definition: workflowConfig({ enabled: false, rules: [] }),
      expectedVersion: 0,
      changedBy: "stale-instance",
    }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_CONFLICT",
  );

  await Promise.all([
    first.service.ingest({ event: workflowEvent() }),
    second.service.ingest({
      event: workflowEvent({
        occurredAt: "2026-08-02T01:01:00.000Z",
        subject: {
          id: "github:pr:acme/repo#43",
          repository: "acme/repo",
          number: 43,
        },
        payload: { number: 43 },
      }),
    }),
  ]);

  const recovered = await createFixture({ store, exclusiveLease });
  assert.equal((await recovered.service.listAssignments()).items.length, 2);
  assert.equal((await recovered.service.listAudit()).items.length, 2);
});

test("a durable revision rollback is rejected instead of being overwritten", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  const older = store.stored(STATE_KEY);
  await service.ingest({ event: workflowEvent() });
  store.replaceStored(STATE_KEY, older);

  await assert.rejects(
    service.ingest({
      event: workflowEvent({
        occurredAt: "2026-08-02T01:01:00.000Z",
      }),
    }),
    (error) => error.code === "WORKFLOW_STATE_REVISION_CONFLICT",
  );
  assert.deepEqual(store.stored(STATE_KEY), older);
});

test("large validated state supports a second replay and write beyond event digest limits", async () => {
  const { service, store } = await createFixture();
  await configure(service, threeRuleWorkflowConfig());
  const items = Array.from({ length: 1_000 }, (_, index) =>
    pullRequest(index + 1),
  );
  const baseline = workflowSnapshot({ items });

  const first = await service.ingestSnapshot({ snapshot: baseline });
  const writesAfterFirst = store.writes.length;
  const replay = await service.ingestSnapshot({ snapshot: baseline });
  const advanced = await service.ingestSnapshot({
    snapshot: workflowSnapshot({
      refreshedAt: "2026-08-02T01:05:00.000Z",
      items,
    }),
  });

  assert.equal(first.events.length, 1_000);
  assert.equal(first.assignments.length, 1_000);
  assert.deepEqual(replay.events, []);
  assert.deepEqual(advanced.events, []);
  assert.equal(store.writes.length, writesAfterFirst + 1);
  assert.ok(prettySerializedWorkflowBytes(store.stored(STATE_KEY)) > 1_000_000);
  assert.ok(
    prettySerializedWorkflowBytes(store.stored(STATE_KEY)) <=
      MAX_WORKFLOW_STATE_BYTES,
  );
});

test("a valid same-revision durable fork is still rejected", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  await service.ingestSnapshot({
    snapshot: workflowSnapshot({ items: [pullRequest(42)] }),
  });
  const fork = store.stored(STATE_KEY);
  fork.checkpoint.items[0].title = "forked checkpoint title";
  fork.lastSnapshot.items[0].title = "forked checkpoint title";
  store.replaceStored(STATE_KEY, fork);

  await assert.rejects(
    service.ingest({
      event: workflowEvent({
        occurredAt: "2026-08-02T01:06:00.000Z",
      }),
    }),
    (error) => error.code === "WORKFLOW_STATE_REVISION_CONFLICT",
  );
  assert.deepEqual(store.stored(STATE_KEY), fork);
});

test("snapshot checkpoint rejects stale and same-time conflicting projections without writes", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  const baseline = workflowSnapshot({ items: [pullRequest(42)] });
  await service.ingestSnapshot({ snapshot: baseline });
  store.clearWrites();

  const replay = await service.ingestSnapshot({ snapshot: baseline });
  assert.deepEqual(replay.events, []);
  assert.equal(store.writes.length, 0);

  await assert.rejects(
    service.ingestSnapshot({
      snapshot: workflowSnapshot({
        refreshedAt: "2026-08-02T00:59:59.000Z",
        items: [pullRequest(42)],
      }),
    }),
    (error) => error.code === "WORKFLOW_SNAPSHOT_STALE",
  );
  await assert.rejects(
    service.ingestSnapshot({
      snapshot: workflowSnapshot({
        items: [pullRequest(42), pullRequest(43)],
      }),
    }),
    (error) => error.code === "WORKFLOW_SNAPSHOT_TIMESTAMP_CONFLICT",
  );
  assert.equal(store.writes.length, 0);
});

test("route adapter rejects non-exact, contradictory, and duplicate results", async (t) => {
  const cases = [
    {
      name: "extra top-level field",
      mutate: (result) => ({ ...result, dispatch: true }),
    },
    {
      name: "priority outside the configured rule",
      mutate: (result) => ({
        ...result,
        assignments: [{ ...result.assignments[0], priority: 101 }],
      }),
    },
    {
      name: "duplicate assignment target",
      mutate: (result) => ({
        ...result,
        assignments: [result.assignments[0], result.assignments[0]],
      }),
    },
    {
      name: "unmatched result carrying assignments",
      mutate: (result) => ({ ...result, outcome: "unmatched" }),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const router = new StubRouter((input) =>
        scenario.mutate(createWorkflowRouter().route(input)),
      );
      const { service } = await createFixture({ router });
      await configure(service);
      await assert.rejects(
        service.dryRun({ event: workflowEvent() }),
        (error) => error.code === "WORKFLOW_ROUTE_INVALID",
      );
    });
  }
});

test("trusted evaluation rejects a forged issue match for a pull request event", async () => {
  const definition = issueOnlyConfig();
  const router = {
    async route(input) {
      const result = createWorkflowRouter().route(input);
      result.outcome = "assigned";
      result.matches = ["issue-only"];
      result.assignments = [
        {
          ruleId: "issue-only",
          target: { type: "role", id: "requirements-analyst" },
          priority: 100,
        },
      ];
      Object.assign(result.explanation.rules[0], {
        status: "matched",
        condition: {
          ...result.explanation.rules[0].condition,
          result: true,
        },
        targets: [
          {
            target: { type: "role", id: "requirements-analyst" },
            status: "assigned",
          },
        ],
      });
      result.explanation.stoppedByRuleId = "issue-only";
      return result;
    },
  };
  const { service, store } = await createFixture({ router });
  await configure(service, definition);
  const durableBefore = store.stored(STATE_KEY);

  await assert.rejects(
    service.ingest({ event: workflowEvent() }),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
});

test("trusted evaluation binds a custom result to the requested route context", async () => {
  const definition = workflowConfig({
    rules: [
      {
        ...workflowConfig().rules[0],
        id: "other-node-review",
        source: "other-node",
      },
    ],
  });
  const router = {
    async route(input) {
      return createWorkflowRouter().route({
        event: input.event,
        config: input.config,
        context: {
          currentNodeId: "other-node",
          visitedNodeIds: ["root", "other-node"],
          hopCount: 1,
        },
      });
    },
  };
  const { service } = await createFixture({ router });
  await configure(service, definition);

  await assert.rejects(
    service.dryRun({ event: workflowEvent() }),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});

test("recover rejects content-valid dangling event and audit references", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  await service.ingest({ event: workflowEvent() });
  await service.ingest({
    event: workflowEvent({
      occurredAt: "2026-08-02T01:01:00.000Z",
      subject: {
        id: "github:pr:acme/repo#43",
        repository: "acme/repo",
        number: 43,
      },
      payload: { number: 43 },
    }),
  });
  const corrupted = store.stored(STATE_KEY);
  const secondEvent = corrupted.events[1];
  corrupted.assignments[0] = readdress(
    {
      ...corrupted.assignments[0],
      eventId: secondEvent.eventId,
      eventType: secondEvent.eventType,
      subject: secondEvent.subject,
    },
    "assignmentId",
    "workflow-assignment",
  );
  store.replaceStored(STATE_KEY, corrupted);

  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    recreated.recover(),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
});

test("recover rejects duplicate content-valid record identifiers", async () => {
  const { service, store } = await createFixture();
  await configure(service);
  await service.ingest({ event: workflowEvent() });
  const corrupted = store.stored(STATE_KEY);
  corrupted.events.push(clone(corrupted.events[0]));
  store.replaceStored(STATE_KEY, corrupted);

  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    recreated.recover(),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
});

test("recover rejects a content-addressed audit with a forged condition match", async () => {
  const { service, store } = await createFixture();
  await configure(service, issueOnlyConfig());
  const ingested = await service.ingest({ event: workflowEvent() });
  assert.equal(ingested.assignments.length, 0);
  const corrupted = store.stored(STATE_KEY);
  const event = corrupted.events[0];
  const config = corrupted.currentConfig;
  const originalAudit = corrupted.audit[0];
  const assignment = readdress(
    {
      eventId: event.eventId,
      eventType: event.eventType,
      subject: event.subject,
      configVersion: config.version,
      configDigest: config.digest,
      ruleId: "issue-only",
      target: { type: "role", id: "requirements-analyst" },
      priority: 100,
      reason: "规则 issue-only 分派",
      createdAt: originalAudit.createdAt,
    },
    "assignmentId",
    "workflow-assignment",
  );
  const explanation = clone(originalAudit.explanation);
  Object.assign(explanation.rules[0], {
    status: "matched",
    condition: { ...explanation.rules[0].condition, result: true },
    targets: [
      {
        target: { type: "role", id: "requirements-analyst" },
        status: "assigned",
      },
    ],
  });
  explanation.stoppedByRuleId = "issue-only";
  corrupted.assignments = [assignment];
  corrupted.audit = [
    readdress(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        subject: event.subject,
        configVersion: config.version,
        configDigest: config.digest,
        outcome: "assigned",
        matchedRuleIds: ["issue-only"],
        assignmentIds: [assignment.assignmentId],
        explanation,
        createdAt: originalAudit.createdAt,
      },
      "auditId",
      "workflow-audit",
    ),
  ];
  store.replaceStored(STATE_KEY, corrupted);

  const recreated = new WorkflowRoutingService({
    store,
    router: new StubRouter(),
    clock: incrementingClock(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    recreated.recover(),
    (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
  );
});

test("record retention evicts whole event bundles and preserves duplicate projections", async () => {
  const { service, store } = await createFixture({ recordLimit: 2 });
  await configure(service);
  const results = [];
  for (let number = 41; number <= 43; number += 1) {
    results.push(
      await service.ingest({
        event: workflowEvent({
          occurredAt: new Date(
            Date.parse("2026-08-02T01:00:00.000Z") + number * 1_000,
          ).toISOString(),
          subject: {
            id: `github:pr:acme/repo#${number}`,
            repository: "acme/repo",
            number,
          },
          payload: { number },
        }),
      }),
    );
  }
  const durable = store.stored(STATE_KEY);
  assert.deepEqual(
    durable.events.map((event) => event.eventId),
    results.slice(1).map((result) => result.event.eventId),
  );
  assert.equal(durable.assignments.length, 2);
  assert.equal(durable.audit.length, 2);
  assert.equal(
    durable.audit.every(
      (entry) =>
        entry.assignmentIds.length === 1 &&
        durable.assignments.some(
          (assignment) => assignment.assignmentId === entry.assignmentIds[0],
        ),
    ),
    true,
  );

  const duplicate = await service.ingest({
    event: workflowEvent({
      occurredAt: results[1].event.occurredAt,
      subject: results[1].event.subject,
      payload: { number: 42 },
    }),
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.assignments.length, 1);
  assert.equal(duplicate.audit.length, 1);
  assert.deepEqual(duplicate.audit[0].assignmentIds, [
    duplicate.assignments[0].assignmentId,
  ]);
});

test("config retention fails explicitly while the oldest version is referenced", async () => {
  const { service, store } = await createFixture({ configHistoryLimit: 2 });
  await configure(service);
  await service.ingest({ event: workflowEvent() });
  await service.replaceConfig({
    definition: workflowConfig({ maxHops: 9 }),
    expectedVersion: 1,
    changedBy: "owner",
  });
  const durableBefore = store.stored(STATE_KEY);

  await assert.rejects(
    service.replaceConfig({
      definition: workflowConfig({ enabled: false, rules: [] }),
      expectedVersion: 2,
      changedBy: "owner",
    }),
    (error) => error.code === "WORKFLOW_CONFIG_RETENTION_LIMIT",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
});

test("custom routers receive independent deeply frozen event and config copies", async () => {
  const mutationErrors = [];
  const inputs = [];
  const router = {
    async route(input) {
      inputs.push(input);
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.event), true);
      assert.equal(Object.isFrozen(input.event.payload), true);
      assert.equal(Object.isFrozen(input.config), true);
      assert.equal(Object.isFrozen(input.config.rules), true);
      const result = createWorkflowRouter().route(input);
      for (const mutation of [
        () => {
          input.event.payload.number = 999;
        },
        () => {
          input.config.rules[0].priority = -999;
        },
        () => {
          input.config.rules.push(input.config.rules[0]);
        },
      ]) {
        try {
          mutation();
        } catch (error) {
          mutationErrors.push(error);
        }
      }
      return result;
    },
  };
  const { service, store } = await createFixture({ router });
  const configured = await configure(service);
  const before = await service.getConfig();
  const candidate = workflowConfig();
  store.clearWrites();

  await service.dryRun({ event: workflowEvent(), definition: candidate });
  const ingested = await service.ingest({ event: workflowEvent() });

  assert.equal(inputs.length, 2);
  assert.notStrictEqual(inputs[0].config, candidate);
  assert.notStrictEqual(inputs[0].config.rules, candidate.rules);
  assert.notStrictEqual(inputs[1].config, configured.definition);
  assert.equal(mutationErrors.length, 6);
  assert.equal(mutationErrors.every((error) => error instanceof TypeError), true);
  assert.deepEqual(await service.getConfig(), before);
  assert.equal(ingested.event.payload.number, 42);
  assert.equal(store.stored(STATE_KEY).events[0].payload.number, 42);
  assert.equal(
    store.stored(STATE_KEY).currentConfig.digest,
    configured.digest,
  );
  assert.equal(store.stored(STATE_KEY).currentConfig.definition.rules[0].priority, 100);
});

test("single-audit byte limits reject an oversized package without partial state", async () => {
  const { service, store } = await createFixture({
    auditByteBudget: 1_000,
    bundleByteBudget: 8_000,
    stateByteBudget: 64_000,
  });
  await configure(service);
  const durableBefore = store.stored(STATE_KEY);

  await assert.rejects(
    service.ingest({ event: workflowEvent() }),
    (error) => error.code === "WORKFLOW_AUDIT_TOO_LARGE",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
});

test("pretty-serialized state budget evicts oldest complete packages", async () => {
  const stateByteBudget = 24_000;
  const { service, store } = await createFixture({ stateByteBudget });
  await configure(service);
  const results = [];
  for (let number = 1; number <= 20; number += 1) {
    results.push(
      await service.ingest({
        event: workflowEvent({
          occurredAt: new Date(
            Date.parse("2026-08-02T01:00:00.000Z") + number * 1_000,
          ).toISOString(),
          subject: {
            id: `github:pr:acme/repo#${number}`,
            repository: "acme/repo",
            number,
          },
          payload: { number },
        }),
      }),
    );
  }
  const durable = store.stored(STATE_KEY);
  const retainedEventIds = new Set(durable.events.map(({ eventId }) => eventId));

  assert.ok(durable.events.length < results.length);
  assert.equal(
    retainedEventIds.has(results.at(-1).event.eventId),
    true,
  );
  assert.equal(
    durable.assignments.every((entry) => retainedEventIds.has(entry.eventId)),
    true,
  );
  assert.equal(
    durable.audit.every(
      (entry) =>
        retainedEventIds.has(entry.eventId) &&
        entry.assignmentIds.every((assignmentId) =>
          durable.assignments.some(
            (assignment) => assignment.assignmentId === assignmentId,
          ),
        ),
    ),
    true,
  );
  assert.ok(prettySerializedWorkflowBytes(durable) <= stateByteBudget);
  assert.ok(prettySerializedWorkflowBytes(durable) <= MAX_WORKFLOW_STATE_BYTES);
});

test("config history contributes to the pretty-serialized state budget", async () => {
  const { service, store } = await createFixture({ stateByteBudget: 2_000 });
  await configure(service);
  const durableBefore = store.stored(STATE_KEY);
  assert.ok(prettySerializedWorkflowBytes(durableBefore) <= 2_000);

  await assert.rejects(
    service.replaceConfig({
      definition: workflowConfig({ maxHops: 9 }),
      expectedVersion: 1,
      changedBy: "owner",
    }),
    (error) => error.code === "WORKFLOW_STATE_CAPACITY_EXCEEDED",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
});

test("checkpoint and last snapshot both contribute to the state byte budget", async () => {
  const { service, store } = await createFixture({ stateByteBudget: 4_000 });
  await configure(service);
  const durableBefore = store.stored(STATE_KEY);

  await assert.rejects(
    service.ingestSnapshot({
      snapshot: workflowSnapshot({
        pullRequestsOk: false,
        items: Array.from({ length: 20 }, (_, index) =>
          pullRequest(index + 1),
        ),
      }),
    }),
    (error) => error.code === "WORKFLOW_STATE_CAPACITY_EXCEEDED",
  );
  assert.deepEqual(store.stored(STATE_KEY), durableBefore);
});
