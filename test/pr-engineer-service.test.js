import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPullRequestReadFacts,
  createPullRequestReadIdentity,
  projectPullRequestReadFactsContext,
} from "../src/domain/pull-request-read-facts.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { PrEngineerService } from "../src/services/pr-engineer-service.js";

const NOW = "2026-08-08T01:02:00.000Z";
const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function executionFixture({
  scopeId = "github-account:runtime-user",
  sourceAccountId = "runtime-user",
  baseRefName = "main",
  baseRefOid = BASE_OID,
  headRepository = "contributor/repo",
  headRefName = "fix/conflict",
  headRefOid = HEAD_OID,
  inputRevision = 1,
} = {}) {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId,
    baseRepository: "acme/repo",
    baseRefName,
    baseRefOid,
    headRepository,
    headRefName,
    headRefOid,
  };
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-08T01:00:00.000Z",
    source: { provider: "github", scopeId },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { headRefOid, gitTargetAvailable: true, gitTarget },
  });
  const sourceBinding = {
    kind: "pull_request",
    rootItemId: "work-item-pr-root",
    workKey: "acme/repo#42:pr-engineer",
    inputRevision,
    headRevision: inputRevision,
    headRefOid,
    eventId: event.eventId,
    eventDigest: event.contentDigest,
    inputDigest: digest({ scopeId, gitTarget, inputRevision }),
  };
  const executionBinding = createPullRequestExecutionBinding({
    sourceBinding,
    event,
  });
  return {
    event,
    sourceBinding,
    executionBinding,
    input: { executionBinding, event },
    identity: createPullRequestReadIdentity({ executionBinding, event }),
  };
}

function factsFixture(
  fixture,
  { observedAt = "2026-08-08T01:01:00.000Z", large = false } = {},
) {
  const comments = large
    ? Array.from({ length: 30 }, (_, index) => ({
        id: `comment-${index}`,
        author: "reviewer",
        body: "x".repeat(15_000),
        bodyTruncated: false,
        createdAt: "2026-08-08T00:30:00.000Z",
        updatedAt: "2026-08-08T00:31:00.000Z",
        url: `https://github.com/acme/repo/pull/42#issuecomment-${index}`,
      }))
    : [];
  return createPullRequestReadFacts({
    identity: fixture.identity,
    observedAt,
    reviewDecision: "REVIEW_REQUIRED",
    comments,
    reviews: [],
    reviewThreads: [],
    checks: [],
    truncation: {
      comments: false,
      reviews: false,
      reviewThreads: false,
      checks: false,
      byteBudget: false,
    },
  });
}

class MemoryStore {
  constructor(values = new Map()) {
    this.values = values;
    this.reads = 0;
    this.writes = 0;
    this.failAfterWrite = false;
    this.activeWrites = 0;
    this.maximumActiveWrites = 0;
  }

  async read(name, fallback) {
    this.reads += 1;
    return structuredClone(
      this.values.has(name) ? this.values.get(name) : fallback,
    );
  }

  async write(name, value) {
    this.activeWrites += 1;
    this.maximumActiveWrites = Math.max(
      this.maximumActiveWrites,
      this.activeWrites,
    );
    try {
      this.writes += 1;
      this.values.set(name, structuredClone(value));
      if (this.failAfterWrite) {
        this.failAfterWrite = false;
        throw new Error("write acknowledgement lost");
      }
    } finally {
      this.activeWrites -= 1;
    }
  }
}

class ExclusiveLease {
  constructor(operationQueue = new OperationQueue()) {
    this.operationQueue = operationQueue;
  }

  run(operation) {
    return this.operationQueue.enqueue(operation);
  }
}

function service({
  store,
  load,
  loadReview,
  maximumRecords = 32,
  maximumAgeMs,
  clock = () => NOW,
  exclusiveLease = new ExclusiveLease(),
  operationQueue,
} = {}) {
  const loader = {
    loadPullRequestFacts: load,
    ...(loadReview === undefined ? {} : { loadReviewContext: loadReview }),
  };
  return new PrEngineerService({
    store,
    pullRequestFactsLoader: loader,
    reviewContextLoader: loader,
    exclusiveLease,
    clock,
    maximumRecords,
    ...(operationQueue === undefined ? {} : { operationQueue }),
    ...(maximumAgeMs === undefined ? {} : { maximumAgeMs }),
  });
}

function sealedState(revision, records) {
  const content = { schemaVersion: 1, revision, records };
  return { ...content, contentDigest: digest(content) };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("fresh observations are idempotent and survive a service restart", async () => {
  const store = new MemoryStore();
  const fixture = executionFixture();
  const facts = factsFixture(fixture);
  let loadCalls = 0;
  const first = service({
    store,
    load: async () => {
      loadCalls += 1;
      return facts;
    },
  });

  assert.deepEqual(await first.observe(fixture.input), facts);
  assert.deepEqual(await first.observe(fixture.input), facts);
  assert.equal(loadCalls, 1);
  assert.equal(store.writes, 1);
  assert.deepEqual(await first.context(fixture.input),
    projectPullRequestReadFactsContext(facts));

  const restarted = service({
    store,
    load: async () => {
      throw new Error("restart must reuse fresh persisted facts");
    },
  });
  assert.deepEqual(await restarted.recover(), { revision: 1, records: 1 });
  assert.deepEqual(await restarted.observe(fixture.input), facts);
});

for (const [kind, patch] of [
  ["plain", "x".repeat(120 * 1024)],
  ["escaped-source", '+ QStringLiteral("中文🙂\\\\path");\n'.repeat(12_000)],
]) test(`task context includes exact-Head review material within its byte budget (${kind})`, async () => {
  const store = new MemoryStore();
  const fixture = executionFixture();
  const facts = factsFixture(fixture);
  let reviewRequest = null;
  const engineer = service({
    store,
    load: async () => facts,
    loadReview: async (request, options) => {
      reviewRequest = { request: structuredClone(request), options };
      return {
        ...request,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        files: [
          { path: "src/codec.cpp", additions: 10, deletions: 3 },
          { path: "test/codec.test.cpp", additions: 2, deletions: 0 },
        ],
        patch,
        patchTruncated: false,
      };
    },
  });

  const context = await engineer.context(fixture.input);

  assert.equal(reviewRequest.options.includePatch, true);
  assert.equal(reviewRequest.request.number, 42);
  assert.equal(reviewRequest.request.headRefOid, HEAD_OID);
  assert.deepEqual(
    reviewRequest.request.gitTarget,
    fixture.executionBinding.gitTarget,
  );
  assert.equal(context.reviewMaterial.changedFiles, 2);
  assert.equal(context.reviewMaterial.patchTruncated, true);
  assert.equal(context.reviewMaterial.patch.length < patch.length, true);
  assert.equal(patch.startsWith(context.reviewMaterial.patch), true);
  assert.equal(context.reviewMaterial.patch.isWellFormed(), true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(context), "utf8") <= 96 * 1024,
    true,
  );
});

test("PR fact loading forwards shutdown and performs no state write after abort", async () => {
  const store = new MemoryStore();
  const fixture = executionFixture();
  const controller = new AbortController();
  const shutdown = new Error("lifecycle shutdown");
  let receivedSignal = null;
  const engineer = service({
    store,
    load: async (_input, options) => {
      receivedSignal = options.signal;
      controller.abort(shutdown);
      return factsFixture(fixture);
    },
  });

  await assert.rejects(
    engineer.context(fixture.input, { signal: controller.signal }),
    (error) => error === shutdown,
  );
  assert.strictEqual(receivedSignal, controller.signal);
  assert.equal(store.writes, 0);
});

test("a lost write response is recovered without reloading or duplicating facts", async () => {
  const store = new MemoryStore();
  store.failAfterWrite = true;
  const fixture = executionFixture();
  const facts = factsFixture(fixture);
  let loadCalls = 0;
  const engineer = service({
    store,
    load: async () => {
      loadCalls += 1;
      return facts;
    },
  });

  await assert.rejects(engineer.observe(fixture.input), /acknowledgement lost/u);
  assert.deepEqual(await engineer.observe(fixture.input), facts);
  assert.equal(loadCalls, 1);
  assert.equal(store.writes, 1);
  assert.deepEqual(await engineer.recover(), { revision: 1, records: 1 });
});

test("same-identity refreshes coalesce and distinct identities serialize writes", async () => {
  const store = new MemoryStore();
  const firstFixture = executionFixture({ scopeId: "scope:first" });
  const secondFixture = executionFixture({ scopeId: "scope:second" });
  const thirdFixture = executionFixture({ scopeId: "scope:third" });
  const firstGate = deferred();
  const bothLoaded = deferred();
  let loadCalls = 0;
  let distinctLoadCalls = 0;
  const engineer = service({
    store,
    load: async (input) => {
      loadCalls += 1;
      const identity = createPullRequestReadIdentity(input);
      if (identity.identityDigest === firstFixture.identity.identityDigest) {
        if (loadCalls === 1) await firstGate.promise;
        return factsFixture(firstFixture);
      }
      distinctLoadCalls += 1;
      if (distinctLoadCalls === 2) bothLoaded.resolve();
      return identity.identityDigest === secondFixture.identity.identityDigest
        ? factsFixture(secondFixture)
        : factsFixture(thirdFixture);
    },
  });

  const sameFirst = engineer.observe(firstFixture.input);
  const sameSecond = engineer.observe(firstFixture.input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadCalls, 1);
  firstGate.resolve();
  await Promise.all([sameFirst, sameSecond]);
  assert.equal(loadCalls, 1);

  const distinctFirst = engineer.observe(thirdFixture.input);
  const distinctSecond = engineer.observe(secondFixture.input);
  await bothLoaded.promise;
  await Promise.all([distinctFirst, distinctSecond]);
  assert.equal(store.maximumActiveWrites, 1);
  assert.deepEqual(await engineer.recover(), { revision: 3, records: 3 });
});

test("services with separate stores and queues preserve concurrent durable updates", async () => {
  const durableValues = new Map();
  const firstStore = new MemoryStore(durableValues);
  const secondStore = new MemoryStore(durableValues);
  const exclusiveLease = new ExclusiveLease();
  const firstFixture = executionFixture({ scopeId: "scope:first-instance" });
  const secondFixture = executionFixture({ scopeId: "scope:second-instance" });
  const bothLoaded = deferred();
  let loadCalls = 0;
  const load = async (input) => {
    loadCalls += 1;
    if (loadCalls === 2) bothLoaded.resolve();
    await bothLoaded.promise;
    const identity = createPullRequestReadIdentity(input);
    return identity.identityDigest === firstFixture.identity.identityDigest
      ? factsFixture(firstFixture)
      : factsFixture(secondFixture);
  };
  const first = service({
    store: firstStore,
    load,
    exclusiveLease,
    operationQueue: new OperationQueue(),
  });
  const second = service({
    store: secondStore,
    load,
    exclusiveLease,
    operationQueue: new OperationQueue(),
  });

  await Promise.all([
    first.observe(firstFixture.input),
    second.observe(secondFixture.input),
  ]);

  const restarted = service({
    store: new MemoryStore(durableValues),
    load: async () => {
      throw new Error("recovery must not reload facts");
    },
    exclusiveLease,
  });
  assert.deepEqual(await restarted.recover(), { revision: 2, records: 2 });
  assert.notEqual(await restarted.get(firstFixture.input), null);
  assert.notEqual(await restarted.get(secondFixture.input), null);
});

test("freshness uses the loader completion time for a slow valid read", async () => {
  const store = new MemoryStore();
  const fixture = executionFixture();
  const clockValues = [
    "2026-08-08T01:00:00.000Z",
    "2026-08-08T01:01:01.000Z",
  ];
  const engineer = service({
    store,
    maximumAgeMs: 60_000,
    clock: () => clockValues.shift(),
    load: async () => factsFixture(fixture, {
      observedAt: "2026-08-08T01:01:01.000Z",
    }),
  });

  const observed = await engineer.observe(fixture.input);

  assert.equal(observed.observedAt, "2026-08-08T01:01:01.000Z");
  assert.deepEqual(clockValues, []);
  assert.equal(store.writes, 1);
});

test("mismatched and stale loader results fail before persistence", async (t) => {
  await t.test("execution identity mismatch", async () => {
    const store = new MemoryStore();
    const requested = executionFixture({ scopeId: "scope:requested" });
    const returned = executionFixture({ scopeId: "scope:returned" });
    const engineer = service({
      store,
      load: async () => factsFixture(returned),
    });

    await assert.rejects(
      engineer.observe(requested.input),
      (error) => error.code === "PR_FACT_EXECUTION_STALE",
    );
    assert.equal(store.writes, 0);
  });

  await t.test("stale observation time", async () => {
    const store = new MemoryStore();
    const fixture = executionFixture();
    const engineer = service({
      store,
      maximumAgeMs: 60_000,
      load: async () => factsFixture(fixture, {
        observedAt: "2026-08-08T00:00:00.000Z",
      }),
    });

    await assert.rejects(
      engineer.observe(fixture.input),
      (error) => error.code === "PR_FACT_REFRESH_STALE",
    );
    assert.equal(store.writes, 0);
  });
});

test("loader failures stay behind the stable service error boundary", async (t) => {
  const fixture = executionFixture();
  const cases = [
    {
      name: "invalid result",
      load: async () => ({}),
      statusCode: 502,
    },
    {
      name: "coded internal failure",
      load: async () => {
        throw Object.assign(new Error("private filesystem detail"), {
          code: "ENOENT",
        });
      },
      statusCode: 503,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const store = new MemoryStore();
      const engineer = service({ store, load: entry.load });
      await assert.rejects(engineer.observe(fixture.input), (error) => {
        assert.equal(error.code, "PR_FACT_REFRESH_FAILED");
        assert.equal(error.statusCode, entry.statusCode);
        assert.equal(error.message.includes("private filesystem detail"), false);
        return true;
      });
      assert.equal(store.writes, 0);
    });
  }
});

test("record and byte retention always preserve the facts just requested", async () => {
  const store = new MemoryStore();
  const newer = executionFixture({ scopeId: "scope:newer" });
  const requestedOlder = executionFixture({ scopeId: "scope:requested-older" });
  const factsByIdentity = new Map([
    [newer.identity.identityDigest, factsFixture(newer, {
      observedAt: "2026-08-08T01:01:30.000Z",
    })],
    [requestedOlder.identity.identityDigest, factsFixture(requestedOlder, {
      observedAt: "2026-08-08T01:01:00.000Z",
    })],
  ]);
  const engineer = service({
    store,
    maximumRecords: 1,
    load: async (input) => factsByIdentity.get(
      createPullRequestReadIdentity(input).identityDigest,
    ),
  });

  await engineer.observe(newer.input);
  assert.deepEqual(await engineer.observe(requestedOlder.input),
    factsByIdentity.get(requestedOlder.identity.identityDigest));
  assert.equal(await engineer.get(newer.input), null);
  assert.notEqual(await engineer.get(requestedOlder.input), null);

  const largeStore = new MemoryStore();
  const largeFacts = new Map();
  const largeEngineer = service({
    store: largeStore,
    maximumRecords: 64,
    load: async (input) => largeFacts.get(
      createPullRequestReadIdentity(input).identityDigest,
    ),
  });
  let lastFixture;
  for (let index = 0; index < 24; index += 1) {
    lastFixture = executionFixture({ scopeId: `scope:large-${index}` });
    largeFacts.set(
      lastFixture.identity.identityDigest,
      factsFixture(lastFixture, { large: true }),
    );
    await largeEngineer.observe(lastFixture.input);
  }
  const recovered = await largeEngineer.recover();
  assert.ok(recovered.records < 24);
  assert.notEqual(await largeEngineer.get(lastFixture.input), null);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(largeStore.values.get("pr-engineer-read-facts")),
      "utf8",
    ) <= 8 * 1024 * 1024,
  );
});

test("recovery rejects tampering, duplicates, and noncanonical order", async (t) => {
  const firstFixture = executionFixture({ scopeId: "scope:first" });
  const secondFixture = executionFixture({ scopeId: "scope:second" });
  const firstFacts = factsFixture(firstFixture, {
    observedAt: "2026-08-08T01:01:30.000Z",
  });
  const secondFacts = factsFixture(secondFixture, {
    observedAt: "2026-08-08T01:01:00.000Z",
  });
  const cases = [
    {
      name: "digest tampering",
      state: { ...sealedState(1, [firstFacts]), contentDigest: "0".repeat(64) },
    },
    {
      name: "duplicate identities",
      state: sealedState(2, [firstFacts, firstFacts]),
    },
    {
      name: "noncanonical order",
      state: sealedState(2, [secondFacts, firstFacts]),
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const store = new MemoryStore();
      store.values.set("pr-engineer-read-facts", entry.state);
      const engineer = service({
        store,
        maximumRecords: entry.maximumRecords ?? 32,
        load: async () => firstFacts,
      });
      await assert.rejects(
        engineer.recover(),
        (error) => error.code === "PR_FACT_STATE_CORRUPTED",
      );
    });
  }
});

test("a lower configured record limit migrates canonical durable state", async () => {
  const firstFixture = executionFixture({ scopeId: "scope:first" });
  const secondFixture = executionFixture({ scopeId: "scope:second" });
  const firstFacts = factsFixture(firstFixture, {
    observedAt: "2026-08-08T01:01:30.000Z",
  });
  const secondFacts = factsFixture(secondFixture, {
    observedAt: "2026-08-08T01:01:00.000Z",
  });
  const values = new Map([
    ["pr-engineer-read-facts", sealedState(2, [firstFacts, secondFacts])],
  ]);
  const lease = new ExclusiveLease();
  const store = new MemoryStore(values);
  const engineer = service({
    store,
    maximumRecords: 1,
    exclusiveLease: lease,
    load: async () => {
      throw new Error("migration must not refresh facts");
    },
  });

  assert.deepEqual(await engineer.recover(), { revision: 3, records: 1 });
  assert.equal(store.writes, 1);
  assert.notEqual(await engineer.get(firstFixture.input), null);
  assert.equal(await engineer.get(secondFixture.input), null);

  const restarted = service({
    store: new MemoryStore(values),
    maximumRecords: 1,
    exclusiveLease: lease,
    load: async () => {
      throw new Error("restart must use migrated facts");
    },
  });
  assert.deepEqual(await restarted.recover(), { revision: 3, records: 1 });
});

test("constructor and recovery reject accessor or proxy boundaries without execution", async () => {
  let getterCalls = 0;
  const accessorStore = {};
  Object.defineProperty(accessorStore, "read", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => null;
    },
  });
  accessorStore.write = async () => {};
  assert.throws(
    () => service({ store: accessorStore, load: async () => null }),
    /store is invalid/u,
  );
  assert.equal(getterCalls, 0);

  const stateProxy = new Proxy(sealedState(0, []), {
    getPrototypeOf() {
      getterCalls += 1;
      throw new Error("proxy trap must not run");
    },
  });
  const engineer = service({
    store: {
      async read() { return stateProxy; },
      async write() {},
    },
    load: async () => null,
  });
  await assert.rejects(
    engineer.recover(),
    (error) => error.code === "PR_FACT_STATE_CORRUPTED",
  );
  assert.equal(getterCalls, 0);
});


test("review reading can force fresh facts while concurrent refreshes share one read", async () => {
  const fixture = executionFixture(); const store = new MemoryStore();
  let calls = 0; const gate = deferred();
  const old = factsFixture(fixture); const current = factsFixture(fixture, { observedAt: NOW });
  const engineer = service({ store, load: async () => { calls++; if (calls > 1) await gate.promise; return calls === 1 ? old : current; } });
  assert.deepEqual(await engineer.observe(fixture.input), old);
  assert.deepEqual(await engineer.observe(fixture.input), old);
  assert.equal(calls, 1);
  const first = engineer.refresh(fixture.input); const second = engineer.refresh(fixture.input);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  gate.resolve();
  assert.deepEqual(await first, current); assert.deepEqual(await second, current);
  assert.deepEqual(await engineer.get(fixture.input), current);
});
