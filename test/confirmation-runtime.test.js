import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ConfirmationRuntimeError,
  createConfirmationRuntime,
} from "../src/confirmation-runtime.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";

const TOKEN_ENV = "MYDASHBOARD_GITHUB_TOKEN";
const TOKEN = "github-token-from-environment";

function enabledConfig(overrides = {}) {
  return {
    githubActions: {
      enabled: true,
      actorAccountId: "review-account",
      tokenEnv: TOKEN_ENV,
      ghCommand: process.execPath,
      networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
      ...overrides,
    },
  };
}

function queuePort(events = []) {
  return {
    readReviewHandoffs() { return []; },
    recordReviewHandoff() {},
    async recover() {
      events.push("recover");
    },
    enqueue(...args) {
      assert.equal(this, this);
      return ["enqueue", ...args];
    },
    next() {
      return "next";
    },
    nextForAction(...args) {
      return ["nextForAction", ...args];
    },
    list(input) {
      return ["list", input];
    },
    get(id) {
      return ["get", id];
    },
    readSettlement(input) {
      return ["readSettlement", input];
    },
    readSettlements(input) {
      return ["readSettlements", input];
    },
    approve(id, input) {
      return ["approve", id, input];
    },
    retry(id, input) {
      return ["retry", id, input];
    },
    reject(id, input) {
      return ["reject", id, input];
    },
    invalidate(id, input) {
      return ["invalidate", id, input];
    },
    readSnapshot(input) {
      return ["readSnapshot", input];
    },
    readMemoryPage(input) {
      return ["readMemoryPage", input];
    },
    readMemoryStatus() {
      return { highWatermark: 9 };
    },
    readRecoveryStatus() {
      return { kinds: ["github.pull-request-push"] };
    },
  };
}

function runtimeDependencies(overrides = {}) {
  const environment = {
    [TOKEN_ENV]: TOKEN,
    HTTPS_PROXY: "http://ambient-proxy.example",
    UNRELATED_SECRET: "must-not-become-network-config",
  };
  return {
    credentialSource: Object.freeze({
      async acquire() {
        throw new Error("test credential source must remain lazy");
      },
    }),
    dataDirectory: path.join(path.dirname(process.execPath), "confirmation-test-data"),
    createStore: () => ({ read() {}, write() {} }),
    createOperationQueue: () => ({ enqueue(operation) { return operation(); } }),
    createExecutor: () => ({ execute() {}, reconcile() {} }),
    createGuard: () => ({
      acquire() {},
      run(operation) { return operation(); },
      close() {},
    }),
    createQueue: () => queuePort(),
    ...overrides,
  };
}

test("automatic mode exposes human selection without changing publisher and producer access", async () => {
  const port = queuePort();
  port.nextForHuman = options => ["human", options];
  const runtime = await createConfirmationRuntime({ ...enabledConfig({ automaticReview: true }),
    workCoordination: { enabled: true } },
    runtimeDependencies({ createQueue: () => port }));
  assert.deepEqual(runtime.queue.next(), ["human", undefined]);
  assert.deepEqual(runtime.queue.nextForAction("kind", "action"), ["nextForAction", "kind", "action"]);
  assert.deepEqual(runtime.producerQueue.get("review-id"), ["get", "review-id"]);
  assert.deepEqual(runtime.queue.approve("review-id", {}), ["approve", "review-id", {}]);
  await runtime.close();
});

test("automatic Review settings cannot hide manual work while coordination is disabled", async () => {
  for (const coordination of [undefined, { enabled: false }]) {
    const runtime = await createConfirmationRuntime({ ...enabledConfig({ automaticReview: true }),
      ...(coordination ? { workCoordination: coordination } : {}) }, runtimeDependencies());
    assert.equal(runtime.queue.next(), "next");
    await runtime.close();
  }
});

function memoryStore() {
  let value = null;
  return {
    async read(_key, fallback = null) {
      return structuredClone(value ?? fallback);
    },
    async write(_key, next) {
      value = structuredClone(next);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function localPlan(id, kind, actionType) {
  const actor = { provider: "local-test", accountId: "owner:local" };
  const target = {
    provider: "local-test",
    resourceId: id,
    version: "a".repeat(64),
  };
  const action = { type: actionType };
  return {
    id,
    kind,
    requestedBy: { roleId: "configuration-owner", workItemId: id },
    actor,
    target,
    action,
    display: {
      title: "验证确认与配置切换总序",
      summary: "并发确认必须按一个锁顺序完成。",
      actionLabel: "确认",
      evidence: [],
      payload: { actor, target, action },
    },
  };
}

function approval(item, requestId) {
  return {
    requestId,
    expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
  };
}

test("disabled GitHub actions construct no confirmation runtime components", async () => {
  let creations = 0;
  const failIfCalled = () => {
    creations += 1;
    throw new Error("must not construct");
  };

  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    Object.defineProperty(
      {
        createStore: failIfCalled,
        createOperationQueue: failIfCalled,
        createExecutor: failIfCalled,
        createExecutorRouter: failIfCalled,
        createGuard: failIfCalled,
        createQueue: failIfCalled,
      },
      "env",
      { get: failIfCalled },
    ),
  );

  assert.equal(runtime, null);
  assert.equal(creations, 0);
});

test("enabled runtime composes private ports, acquires, then recovers", async () => {
  const events = [];
  const credentialSource = Object.freeze({
    async acquire() {
      throw new Error("runtime composition must not acquire");
    },
  });
  const store = { read() {}, write() {} };
  const operationQueue = { enqueue(operation) { return operation(); } };
  const executor = {
    execute() {},
    reconcile() {},
    close() { events.push("executorClose"); },
  };
  const router = { execute() {}, reconcile() {} };
  const guard = {
    acquire() { events.push("acquire"); },
    run(operation) { return operation(); },
    close() { events.push("close"); },
  };
  const rawQueue = queuePort(events);
  let executorOptions;
  let routerOptions;
  let queueOptions;

  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      credentialSource,
      createStore(dataDirectory) {
        events.push("store");
        assert.equal(path.isAbsolute(dataDirectory), true);
        return store;
      },
      createOperationQueue() {
        events.push("operationQueue");
        return operationQueue;
      },
      createExecutor(options) {
        events.push("executor");
        executorOptions = options;
        return executor;
      },
      createExecutorRouter(options) {
        events.push("router");
        routerOptions = options;
        return router;
      },
      createGuard(options) {
        events.push("guard");
        assert.deepEqual(options, { name: "mydashboard-confirmation-queue-v1" });
        return guard;
      },
      createQueue(options) {
        events.push("queue");
        queueOptions = options;
        return rawQueue;
      },
    }),
  );

  assert.deepEqual(events, [
    "store",
    "operationQueue",
    "executor",
    "router",
    "guard",
    "queue",
    "acquire",
    "recover",
  ]);
  assert.deepEqual(Object.keys(executorOptions).sort(), [
    "credentialSource",
    "ghCommand",
    "networkEnv",
  ]);
  assert.strictEqual(executorOptions.credentialSource, credentialSource);
  assert.equal(Object.isFrozen(executorOptions.credentialSource), true);
  assert.deepEqual(executorOptions.networkEnv, {
    HTTPS_PROXY: "http://127.0.0.1:8080",
  });
  assert.equal("actorAccountId" in executorOptions, false);
  assert.equal("tokenEnv" in executorOptions, false);
  assert.equal("token" in executorOptions, false);
  assert.equal("env" in executorOptions, false);
  assert.equal("credentialProvider" in executorOptions, false);
  assert.deepEqual(queueOptions, {
    store,
    executor: router,
    operationQueue,
    exclusiveLease: guard,
    reviewHandoffPolicy: {},
  });
  assert.deepEqual(Object.keys(routerOptions.executors).sort(), [
    "github.pull-request-review",
    "github.work-proposal-review",
  ]);
  assert.notStrictEqual(
    routerOptions.executors["github.pull-request-review"],
    executor,
  );
  assert.strictEqual(
    routerOptions.executors["github.work-proposal-review"],
    executor,
  );
  assert.deepEqual(
    await routerOptions.executors["github.pull-request-review"].execute({}),
    { status: "stale" },
  );
  assert.deepEqual(
    await routerOptions.executors["github.pull-request-review"].reconcile({}),
    { status: "stale" },
  );

  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime), [
    "queue",
    "historyReader",
    "reviewHandoffs",
    "reviewHandoffAssignee",
    "producerQueue",
    "applicationResultSource",
    "memoryProjectionSource",
    "recoveryStatusReader",
    "confirmationSettlementReader",
    "close",
  ]);
  assert.equal(Object.isFrozen(runtime.queue), true);
  assert.equal(Object.isFrozen(runtime.historyReader), true);
  assert.equal(runtime.reviewHandoffAssignee, null);
  assert.equal(Object.isFrozen(runtime.producerQueue), true);
  assert.equal(Object.isFrozen(runtime.applicationResultSource), true);
  assert.equal(Object.isFrozen(runtime.memoryProjectionSource), true);
  assert.equal(Object.isFrozen(runtime.recoveryStatusReader), true);
  assert.equal(Object.isFrozen(runtime.confirmationSettlementReader), true);
  assert.deepEqual(runtime.confirmationSettlementReader.read({ confirmationId: "item-1" }),
    ["readSettlement", { confirmationId: "item-1" }]);
  assert.equal("readSettlement" in runtime.queue, false);
  assert.equal("readSettlement" in runtime.producerQueue, false);
  assert.deepEqual(runtime.confirmationSettlementReader.readMany({ confirmationIds: ["item-1"] }),
    ["readSettlements", { confirmationIds: ["item-1"] }]);
  assert.equal("readSettlements" in runtime.queue, false);
  assert.equal("readSettlements" in runtime.producerQueue, false);
  assert.notEqual(runtime.queue, rawQueue);
  assert.notEqual(runtime.historyReader, rawQueue);
  assert.notEqual(runtime.producerQueue, rawQueue);
  assert.notEqual(runtime.applicationResultSource, rawQueue);
  assert.notEqual(runtime.memoryProjectionSource, rawQueue);
  assert.notEqual(runtime.recoveryStatusReader, rawQueue);
  assert.equal("recover" in runtime.queue, false);
  assert.equal("enqueue" in runtime.queue, false);
  assert.equal("invalidate" in runtime.queue, false);
  assert.equal("executor" in runtime.queue, false);
  assert.equal("exclusiveLease" in runtime.queue, false);
  assert.equal("list" in runtime.queue, false);
  assert.strictEqual(runtime.queue.historyReader, runtime.historyReader);
  assert.equal(runtime.queue.next(), "next");
  const detachedNext = runtime.queue.next;
  assert.equal(detachedNext(), "next");
  assert.deepEqual(runtime.queue.get("item-1"), ["get", "item-1"]);
  assert.equal("approve" in runtime.producerQueue, false);
  assert.equal("readSnapshot" in runtime.queue, false);
  assert.equal("readSnapshot" in runtime.producerQueue, false);
  assert.deepEqual(Object.keys(runtime.historyReader), ["list"]);
  assert.equal("next" in runtime.historyReader, false);
  assert.equal("get" in runtime.historyReader, false);
  assert.equal("approve" in runtime.historyReader, false);
  assert.equal("retry" in runtime.historyReader, false);
  assert.equal("reject" in runtime.historyReader, false);
  assert.equal("enqueue" in runtime.historyReader, false);
  assert.equal("invalidate" in runtime.historyReader, false);
  assert.equal("readSnapshot" in runtime.historyReader, false);
  assert.deepEqual(runtime.historyReader.list({ limit: 7 }), [
    "list",
    { limit: 7 },
  ]);
  const detachedHistoryList = runtime.historyReader.list;
  assert.deepEqual(detachedHistoryList({ status: "completed" }), [
    "list",
    { status: "completed" },
  ]);
  assert.deepEqual(Object.keys(runtime.applicationResultSource), [
    "readSnapshot",
  ]);
  assert.deepEqual(
    runtime.applicationResultSource.readSnapshot({ afterRevision: 7 }),
    ["readSnapshot", { afterRevision: 7 }],
  );
  const detachedReadSnapshot = runtime.applicationResultSource.readSnapshot;
  assert.deepEqual(detachedReadSnapshot({ afterRevision: 8 }), [
    "readSnapshot",
    { afterRevision: 8 },
  ]);
  assert.deepEqual(Object.keys(runtime.memoryProjectionSource), [
    "readMemoryPage",
    "readMemoryStatus",
  ]);
  assert.deepEqual(
    runtime.memoryProjectionSource.readMemoryPage({
      cursor: 0,
      limit: 100,
      highWatermark: null,
    }),
    [
      "readMemoryPage",
      { cursor: 0, limit: 100, highWatermark: null },
    ],
  );
  assert.deepEqual(runtime.memoryProjectionSource.readMemoryStatus(), {
    highWatermark: 9,
  });
  assert.deepEqual(Object.keys(runtime.recoveryStatusReader), [
    "readRecoveryStatus",
  ]);
  assert.deepEqual(runtime.recoveryStatusReader.readRecoveryStatus(), {
    kinds: ["github.pull-request-push"],
  });
  assert.equal("get" in runtime.recoveryStatusReader, false);
  assert.equal("list" in runtime.recoveryStatusReader, false);
  assert.deepEqual(runtime.producerQueue.enqueue("plan"), ["enqueue", "plan"]);
  assert.deepEqual(runtime.producerQueue.invalidate("item-1", "reason"), [
    "invalidate",
    "item-1",
    "reason",
  ]);

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(events.slice(-2), ["executorClose", "close"]);
});

test("enabled runtime forwards the ledger authority verifier to the GitHub executor", async () => {
  const inputAuthorityVerifier = { verify() {} };
  let executorOptions;
  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      inputAuthorityVerifier,
      createExecutor(options) {
        executorOptions = options;
        return { execute() {}, reconcile() {} };
      },
    }),
  );

  assert.strictEqual(
    executorOptions.inputAuthorityVerifier,
    inputAuthorityVerifier,
  );
  await runtime.close();
});

test("explicit PR action allow-list routes only supported injected executors", async () => {
  const externalExecutor = {
    async execute() { return { status: "applied" }; },
    async reconcile() { return { status: "already" }; },
  };
  let routed;
  const runtime = await createConfirmationRuntime(
    enabledConfig({
      enabledActions: ["comment", "update_branch", "push", "merge"],
    }),
    runtimeDependencies({
      pullRequestExternalActionExecutor: externalExecutor,
      createExecutorRouter({ executors }) {
        routed = executors;
        return externalExecutor;
      },
    }),
  );

  assert.deepEqual(Object.keys(routed).sort(), [
    "github.pull-request-comment",
    "github.pull-request-merge",
    "github.pull-request-push",
    "github.pull-request-update-branch",
  ]);
  for (const kind of [
    "github.pull-request-comment",
    "github.pull-request-update-branch",
    "github.pull-request-push",
    "github.pull-request-merge",
  ]) {
    assert.strictEqual(routed[kind], externalExecutor);
  }
  await runtime.close();
});

test("runtime closes one shared generic executor once before closing the guard", async () => {
  const events = [];
  const externalExecutor = {
    async execute() {},
    async reconcile() {},
    async close() { events.push("genericClose"); },
  };
  const runtime = await createConfirmationRuntime(
    enabledConfig({
      enabledActions: ["comment", "update_branch", "merge"],
    }),
    runtimeDependencies({
      pullRequestExternalActionExecutor: externalExecutor,
      createExecutorRouter: () => externalExecutor,
      createGuard: () => ({
        acquire() {},
        run(operation) { return operation(); },
        close() { events.push("guardClose"); },
      }),
    }),
  );

  await Promise.all([runtime.close(), runtime.close()]);
  assert.deepEqual(events, ["genericClose", "guardClose"]);
});

test("runtime attempts Review, one shared generic close, and guard while preserving the first close failure", async (t) => {
  for (const failingExecutor of ["review", "generic"]) {
    await t.test(`${failingExecutor} close fails`, async () => {
      const events = [];
      const failure = new Error(`${failingExecutor} close failed`);
      const reviewExecutor = {
        async execute() {},
        async reconcile() {},
        async close() {
          events.push("reviewClose");
          if (failingExecutor === "review") throw failure;
        },
      };
      let genericCloseCalls = 0;
      const externalExecutor = {
        async execute() {},
        async reconcile() {},
        async close() {
          genericCloseCalls += 1;
          events.push("genericClose");
          if (failingExecutor === "generic") throw failure;
        },
      };
      const runtime = await createConfirmationRuntime(
        enabledConfig({
          enabledActions: ["review", "comment", "update_branch", "merge"],
        }),
        runtimeDependencies({
          createExecutor: () => reviewExecutor,
          pullRequestExternalActionExecutor: externalExecutor,
          createExecutorRouter: () => externalExecutor,
          createGuard: () => ({
            acquire() {},
            run(operation) { return operation(); },
            close() { events.push("guardClose"); },
          }),
        }),
      );

      await assert.rejects(runtime.close(), (error) => error === failure);
      assert.deepEqual(events, ["reviewClose", "genericClose", "guardClose"]);
      assert.equal(genericCloseCalls, 1);
    });
  }
});

test("an explicit empty PR action allow-list starts inert without credentials", async () => {
  let githubExecutors = 0;
  let routed;
  const inertExecutor = { execute() {}, reconcile() {} };
  const dependencies = runtimeDependencies({
    createExecutor() {
      githubExecutors += 1;
      throw new Error("must not create a GitHub executor");
    },
    createExecutorRouter({ executors }) {
      routed = executors;
      return inertExecutor;
    },
  });
  Object.defineProperty(dependencies, "env", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("must not read credentials");
    },
  });

  const runtime = await createConfirmationRuntime(
    enabledConfig({ enabledActions: [] }),
    dependencies,
  );

  assert.ok(runtime);
  assert.equal(githubExecutors, 0);
  assert.deepEqual(routed, {});
  await runtime.close();
});

test("explicit Review lets the unified executor own work proposals and fences direct legacy execution", async () => {
  let routed;
  let legacyCalls = 0;
  let legacyReconcileCalls = 0;
  let unifiedCalls = 0;
  const legacyReviewExecutor = {
    execute() { legacyCalls += 1; },
    reconcile() {
      legacyReconcileCalls += 1;
      return { status: "already" };
    },
  };
  const unifiedReviewExecutor = {
    execute() { unifiedCalls += 1; },
    reconcile() {},
  };
  const runtime = await createConfirmationRuntime(
    enabledConfig({ enabledActions: ["review"] }),
    runtimeDependencies({
      createExecutor: () => legacyReviewExecutor,
      pullRequestExternalActionExecutor: unifiedReviewExecutor,
      createExecutorRouter({ executors }) {
        routed = executors;
        return unifiedReviewExecutor;
      },
    }),
  );

  assert.deepEqual(Object.keys(routed).sort(), [
    "github.pull-request-review",
    "github.work-proposal-review",
  ]);
  await routed["github.work-proposal-review"].execute({});
  assert.equal(unifiedCalls, 1);
  assert.deepEqual(
    await routed["github.pull-request-review"].execute({}),
    { status: "stale" },
  );
  assert.equal(legacyCalls, 0);
  assert.deepEqual(
    await routed["github.pull-request-review"].reconcile({}),
    { status: "already" },
  );
  assert.equal(legacyReconcileCalls, 1);
  await runtime.close();
});

test("an enabled unified PR action fails closed without its fixed executor", async () => {
  await assert.rejects(
    createConfirmationRuntime(
      enabledConfig({ enabledActions: ["comment"] }),
      runtimeDependencies(),
    ),
    (error) =>
      error.code === "INVALID_CONFIRMATION_RUNTIME_CONFIG" &&
      /固定语义执行器/u.test(error.message),
  );
});

test("PR action allow-list rejects duplicates and unknown capabilities", async () => {
  for (const enabledActions of [
    ["comment", "comment"],
    ["delete_branch"],
    "comment",
  ]) {
    await assert.rejects(
      createConfirmationRuntime(
        enabledConfig({ enabledActions }),
        runtimeDependencies(),
      ),
      (error) => error.code === "INVALID_CONFIRMATION_RUNTIME_CONFIG",
    );
  }
});

test("a local-only runtime starts without reading GitHub credentials", async () => {
  const localExecutor = { execute() {}, reconcile() {} };
  let routed;
  let githubExecutors = 0;
  const dependencies = runtimeDependencies({
    localExecutor,
    createExecutor() {
      githubExecutors += 1;
      throw new Error("must not create GitHub executor");
    },
    createExecutorRouter({ executors }) {
      routed = executors;
      return localExecutor;
    },
  });
  Object.defineProperty(dependencies, "env", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("must not read GitHub environment");
    },
  });

  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    dependencies,
  );

  assert.equal(githubExecutors, 0);
  assert.deepEqual(Object.keys(routed), ["local.code-job-create"]);
  assert.strictEqual(routed["local.code-job-create"], localExecutor);
  assert.ok(runtime);
  await runtime.close();
});

test("multiple local confirmation kinds share one routed queue", async () => {
  const codeJobExecutor = { execute() {}, reconcile() {} };
  const applicationExecutor = { execute() {}, reconcile() {} };
  const configurationExecutor = { execute() {}, reconcile() {} };
  let routed;
  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    runtimeDependencies({
      localExecutors: {
        "local.code-job-create": codeJobExecutor,
        "local.change-package-apply": applicationExecutor,
        "local.configuration-activate": configurationExecutor,
      },
      createExecutorRouter({ executors }) {
        routed = executors;
        return codeJobExecutor;
      },
    }),
  );

  assert.deepEqual(Object.keys(routed).sort(), [
    "local.change-package-apply",
    "local.code-job-create",
    "local.configuration-activate",
  ]);
  assert.strictEqual(routed["local.code-job-create"], codeJobExecutor);
  assert.strictEqual(
    routed["local.change-package-apply"],
    applicationExecutor,
  );
  assert.strictEqual(
    routed["local.configuration-activate"],
    configurationExecutor,
  );
  await runtime.close();
});

test("runtime cutover fences new side effects but never blocks reconciliation", async () => {
  const calls = [];
  const executor = (name) => ({
    async execute() {
      calls.push(`${name}:execute`);
      return { status: "applied" };
    },
    async reconcile() {
      calls.push(`${name}:reconcile`);
      return { status: "already" };
    },
  });
  const codeJobExecutor = executor("code");
  const applicationExecutor = executor("application");
  const configurationExecutor = executor("configuration");
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  let routed;
  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    runtimeDependencies({
      actionAdmissionGate: gate,
      localExecutors: {
        "local.code-job-create": codeJobExecutor,
        "local.change-package-apply": applicationExecutor,
        "local.configuration-activate": configurationExecutor,
      },
      createExecutorRouter({ executors }) {
        routed = executors;
        return codeJobExecutor;
      },
    }),
  );

  await gate.cutover(({ commit }) => {
    commit({ version: 2, configurationDigest: "2".repeat(64) });
  });
  assert.deepEqual(await runtime.queue.approve("code", {}), [
    "approve",
    "code",
    {},
  ]);
  assert.deepEqual(await runtime.queue.retry("application", {}), [
    "retry",
    "application",
    {},
  ]);
  assert.equal(
    (await routed["local.code-job-create"].execute({})).status,
    "stale",
  );
  assert.equal(
    (await routed["local.change-package-apply"].execute({})).status,
    "stale",
  );
  assert.equal(
    (await routed["local.code-job-create"].reconcile({})).status,
    "already",
  );
  assert.equal(
    (await routed["local.change-package-apply"].reconcile({})).status,
    "already",
  );
  assert.equal(
    (await routed["local.configuration-activate"].execute({})).status,
    "applied",
  );
  assert.deepEqual(calls, [
    "code:reconcile",
    "application:reconcile",
    "configuration:execute",
  ]);

  await runtime.close();
});

test("real confirmation queue never inverts its lock order with configuration cutover", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  const configurationEntered = deferred();
  const releaseConfiguration = deferred();
  let ordinaryCalls = 0;
  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    runtimeDependencies({
      store: memoryStore(),
      actionAdmissionGate: gate,
      createExecutorRouter: undefined,
      createOperationQueue: undefined,
      createQueue: undefined,
      localExecutors: {
        "local.code-job-create": {
          async execute() {
            ordinaryCalls += 1;
            return { status: "applied", receipt: { id: "ordinary-receipt" } };
          },
          async reconcile() {
            return { status: "absent" };
          },
        },
        "local.configuration-activate": {
          async execute() {
            configurationEntered.resolve();
            await releaseConfiguration.promise;
            return gate.cutover(({ commit }) => {
              commit({
                version: 2,
                configurationDigest: "2".repeat(64),
              });
              return {
                status: "applied",
                receipt: { id: "configuration-receipt" },
              };
            });
          },
          async reconcile() {
            return { status: "absent" };
          },
        },
      },
    }),
  );
  const configuration = await runtime.producerQueue.enqueue(
    localPlan(
      "confirmation-lock-configuration",
      "local.configuration-activate",
      "initialize_from_draft",
    ),
  );
  const ordinary = await runtime.producerQueue.enqueue(
    localPlan(
      "confirmation-lock-ordinary",
      "local.code-job-create",
      "create_code_job",
    ),
  );
  const configurationHead = await runtime.queue.get(configuration.id);
  const ordinaryHead = await runtime.queue.get(ordinary.id);
  const configurationApproval = runtime.queue.approve(
    configuration.id,
    approval(configurationHead, "request-lock-configuration"),
  );
  await configurationEntered.promise;
  const ordinaryApproval = runtime.queue.approve(
    ordinary.id,
    approval(ordinaryHead, "request-lock-ordinary"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  releaseConfiguration.resolve();

  let timeout;
  const settled = await Promise.race([
    Promise.allSettled([configurationApproval, ordinaryApproval]),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("confirmation and cutover lock order deadlocked")),
        1_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[0].value.status, "completed");
  assert.equal(settled[1].status, "rejected");
  assert.equal(ordinaryCalls, 0);
  assert.equal(gate.readStatus().mode, "restart_required");
  await runtime.close();
});

test("an injected runtime clock governs real confirmation queue timestamps", async (t) => {
  const timestamp = "2026-08-08T02:00:00.000Z";
  const store = memoryStore();
  let runtime = null;
  t.after(() => runtime?.close());
  runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    runtimeDependencies({
      clock: () => new Date(timestamp),
      store,
      createExecutorRouter: undefined,
      createOperationQueue: undefined,
      createQueue: undefined,
      localExecutors: {
        "local.code-job-create": {
          async execute() {
            return { status: "applied", receipt: { id: "unused-receipt" } };
          },
          async reconcile() {
            return { status: "absent" };
          },
        },
      },
    }),
  );

  await runtime.producerQueue.enqueue(
    localPlan(
      "confirmation-runtime-clock",
      "local.code-job-create",
      "create_code_job",
    ),
  );
  const [queued] = (await store.read("confirmation-state", null)).items;

  assert.equal(queued.createdAt, timestamp);
  assert.equal(queued.updatedAt, timestamp);
});

test("a change-package-only runtime never reads GitHub credentials", async () => {
  const applicationExecutor = { execute() {}, reconcile() {} };
  let routed;
  const dependencies = runtimeDependencies({
    localExecutors: {
      "local.change-package-apply": applicationExecutor,
    },
    createExecutor() {
      throw new Error("must not create GitHub executor");
    },
    createExecutorRouter({ executors }) {
      routed = executors;
      return applicationExecutor;
    },
  });
  Object.defineProperty(dependencies, "env", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("must not read GitHub environment");
    },
  });

  const runtime = await createConfirmationRuntime(
    { githubActions: { enabled: false } },
    dependencies,
  );

  assert.deepEqual(Object.keys(routed), ["local.change-package-apply"]);
  await runtime.close();
});

test("local executor registration rejects unknown or ambiguous kinds", async () => {
  const executor = { execute() {}, reconcile() {} };
  let constructions = 0;
  await assert.rejects(
    createConfirmationRuntime(
      { githubActions: { enabled: false } },
      runtimeDependencies({
        localExecutors: { "local.unknown": executor },
        createStore() { constructions += 1; },
      }),
    ),
    /localExecutors/,
  );
  await assert.rejects(
    createConfirmationRuntime(
      { githubActions: { enabled: false } },
      runtimeDependencies({
        localExecutor: executor,
        localExecutors: { "local.code-job-create": executor },
      }),
    ),
    /localExecutor/,
  );
  assert.equal(constructions, 0);
});

test("recover failure closes the guard before rethrowing the same error", async () => {
  const events = [];
  const failure = new Error("invalid durable state");
  const dependencies = runtimeDependencies({
    createGuard: () => ({
      acquire() { events.push("acquire"); },
      run(operation) { return operation(); },
      close() { events.push("close"); },
    }),
    createQueue: () => ({
      ...queuePort(),
      recover() {
        events.push("recover");
        throw failure;
      },
    }),
  });

  await assert.rejects(
    createConfirmationRuntime(enabledConfig(), dependencies),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["acquire", "recover", "close"]);
});

test("an injected store remains private and bypasses store construction", async () => {
  const store = { read() {}, write() {} };
  let createStoreCalls = 0;
  let receivedStore;
  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      store,
      createStore() {
        createStoreCalls += 1;
        throw new Error("must not construct a replacement store");
      },
      createQueue(options) {
        receivedStore = options.store;
        return queuePort();
      },
    }),
  );

  assert.equal(createStoreCalls, 0);
  assert.equal(receivedStore, store);
  assert.equal("store" in runtime, false);
  assert.equal("store" in runtime.queue, false);
  await runtime.close();
});

test("queue construction and acquisition failures do not leave a guard", async () => {
  for (const failurePoint of ["queue", "acquire"]) {
    const events = [];
    const failure = new Error(`${failurePoint} failed`);
    const dependencies = runtimeDependencies({
      createGuard: () => ({
        acquire() {
          events.push("acquire");
          if (failurePoint === "acquire") throw failure;
        },
        run(operation) { return operation(); },
        close() { events.push("close"); },
      }),
      createQueue: () => {
        events.push("queue");
        if (failurePoint === "queue") throw failure;
        return queuePort();
      },
    });

    await assert.rejects(
      createConfirmationRuntime(enabledConfig(), dependencies),
      (error) => error === failure,
    );
    assert.equal(events.at(-1), "close");
    assert.equal(events.filter((event) => event === "close").length, 1);
  }
});

test("invalid enabled settings fail before constructing any component", async () => {
  const invalidCases = [
    enabledConfig({ tokenEnv: "unsafe-name" }),
    enabledConfig({ actorAccountId: "bad login" }),
    enabledConfig({ token: "credential-in-json-is-forbidden" }),
    enabledConfig({ ghCommand: "relative/gh" }),
    enabledConfig({ networkEnv: { PATH: "C:\\unsafe" } }),
    enabledConfig({ timeoutMs: 999 }),
  ];

  for (const config of invalidCases) {
    let creations = 0;
    const count = () => {
      creations += 1;
      return {};
    };
    await assert.rejects(
      createConfirmationRuntime(config, {
        env: { [TOKEN_ENV]: TOKEN },
        createStore: count,
        createOperationQueue: count,
        createExecutor: count,
        createGuard: count,
        createQueue: count,
      }),
      (error) =>
        error instanceof ConfirmationRuntimeError &&
        error.code === "INVALID_CONFIRMATION_RUNTIME_CONFIG",
    );
    assert.equal(creations, 0);
  }

  let executorOptions;
  const credentialSource = Object.freeze({
    async acquire() {
      throw new Error("credential source remains lazy");
    },
  });
  const runtime = await createConfirmationRuntime(
    enabledConfig(),
    runtimeDependencies({
      credentialSource,
      createExecutor(options) {
        executorOptions = options;
        return { execute() {}, reconcile() {} };
      },
    }),
  );
  assert.ok(runtime);
  assert.strictEqual(executorOptions.credentialSource, credentialSource);
  assert.equal("credentialProvider" in executorOptions, false);
  await runtime.close();
});

test("runtime validation accepts gh-login without a token environment reference", async (t) => {
  let runtime = null;
  t.after(() => runtime?.close());
  runtime = await createConfirmationRuntime(
    enabledConfig({ credentialMode: "gh-login", tokenEnv: undefined, timeoutMs: 600_000 }),
    runtimeDependencies(),
  );
  assert.ok(runtime);
});
