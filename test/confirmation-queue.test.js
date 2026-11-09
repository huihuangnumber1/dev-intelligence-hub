import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConfirmationPlan,
  normalizeConfirmationState,
} from "../src/domain/confirmation-contract.js";
import {
  createConfigurationActivationConfirmationPlan,
} from "../src/domain/configuration-activation-confirmation.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import {
  CONFIRMATION_HISTORY_KINDS,
  CONFIRMATION_HISTORY_MAX_ROLE_FACETS,
  ConfirmationExecutionError,
  ConfirmationQueue,
  projectConfirmationMemoryState,
} from "../src/services/confirmation-queue.js";
import { configurationImpactDigest } from "../src/services/configuration-state.js";
import {
  pullRequestExternalActionQueuePlan,
} from "./support/pull-request-external-action-fixture.js";

test("history recognizes every independently confirmed PR external action", () => {
  assert.deepEqual(
    CONFIRMATION_HISTORY_KINDS.filter((kind) => kind.startsWith("github.")),
    [
      "github.pull-request-review",
      "github.work-proposal-review",
      "github.pull-request-comment",
      "github.pull-request-update-branch",
      "github.pull-request-push",
      "github.pull-request-merge",
    ],
  );
});

class MemoryStore {
  constructor(initial = null) {
    this.value = structuredClone(initial);
    this.readCount = 0;
    this.writeCount = 0;
    this.failReadAt = null;
    this.failWriteAt = null;
  }

  async read(name, fallback = null) {
    assert.equal(name, "confirmation-queue");
    this.readCount += 1;
    if (this.readCount === this.failReadAt) throw new Error("disk read unavailable");
    return this.value === null ? structuredClone(fallback) : structuredClone(this.value);
  }

  async write(name, value) {
    assert.equal(name, "confirmation-queue");
    this.writeCount += 1;
    if (this.writeCount === this.failWriteAt) throw new Error("disk unavailable");
    this.value = structuredClone(value);
  }
}

class ExclusiveLease {
  constructor() {
    this.queue = new OperationQueue();
  }

  run(operation) {
    return this.queue.enqueue(operation);
  }
}

function createClock(...timestamps) {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]);
}

function actionPlan(overrides = {}) {
  const actor = overrides.actor || {
    provider: "github",
    accountId: "local-owner",
  };
  const target = overrides.target || {
    provider: "github",
    resourceId: "acme/command-center#42",
    version: "0123456789abcdef0123456789abcdef01234567",
  };
  const action = overrides.action || {
    type: "pull_request_review",
    reviewEvent: "APPROVE",
    body: "The reviewed paths are covered.",
  };
  const display = overrides.display || {
    title: "发布 PR Review",
    summary: "以当前 GitHub 身份批准这条 PR",
    actionLabel: "确认并发布到 GitHub",
    evidence: ["CI 已通过", "当前 Head 已复核"],
    payload: {
      actor,
      target,
      action,
      subject: {
        repository: "acme/command-center",
        number: 42,
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  };
  return {
    id: "confirmation-review-42",
    kind: "github.pull-request-review",
    requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-42" },
    ...overrides,
    actor,
    target,
    action,
    display,
  };
}

function configurationPlan(type, suffix) {
  const actor = {
    provider: "local-configuration",
    accountId: "owner:local",
  };
  const target = {
    provider: "local-configuration",
    resourceId: "active-configuration",
    version: "a".repeat(64),
  };
  const action = {
    type,
    validationDigest: "a".repeat(64),
  };
  return actionPlan({
    id: `confirmation-configuration-${suffix}`,
    kind: "local.configuration-activate",
    requestedBy: {
      roleId: "configuration-owner",
      workItemId: `configuration-${suffix}`,
    },
    actor,
    target,
    action,
    display: {
      title: "激活版本化配置",
      summary: "配置动作必须按不可变动作类型过滤。",
      actionLabel: "确认并激活配置",
      evidence: [],
      payload: { actor, target, action },
    },
  });
}

function githubCredentialRecoveryConfigurationPlan() {
  const activeDigest = "1".repeat(64);
  const documentDigest = "2".repeat(64);
  const impact = {
    changed: true,
    beforeDigest: activeDigest,
    afterDigest: documentDigest,
    security_tightening: ["githubActions.credentialMode"],
    authority_expansion: ["githubActions.credentialMode"],
    benign_claim_change: [],
    restart_required: [
      "githubActions.credentialMode",
      "githubActions.tokenEnv",
    ],
  };
  return createConfigurationActivationConfirmationPlan({
    kind: "configuration.activate",
    expectedStateRevision: 27,
    expectedActiveVersion: 8,
    activeDigest,
    draftId: "credential-recovery-draft",
    draftRevision: 1,
    draftRevisionId: `configuration-draft-revision-${"3".repeat(64)}`,
    documentDigest,
    validationDigest: "4".repeat(64),
    impactDigest: configurationImpactDigest(impact),
    impact,
  });
}

function applicationPlan({
  packageDigest = "8".repeat(64),
  jobId = "code-job-application-1",
  workItemId = "work-application-1",
  actionOverrides = {},
} = {}) {
  const requestedBy = { roleId: "developer", workItemId };
  const actor = {
    provider: "local-code",
    accountId: "change-package-application-service",
  };
  const target = {
    provider: "local-code",
    resourceId: "workspace-1",
    version: "0123456789abcdef0123456789abcdef01234567",
  };
  const action = {
    type: "apply_change_package",
    packageId: `change-package-${packageDigest}`,
    packageDigest,
    job: {
      id: jobId,
      revision: 7,
      recordDigest: "1".repeat(64),
    },
    proposal: { id: "proposal-1", contentDigest: "2".repeat(64) },
    grant: { digest: "3".repeat(64) },
    workspace: {
      id: "workspace-1",
      sourceRevision: "4".repeat(64),
      workspaceRevision: "5".repeat(64),
    },
    changeSetDigest: "6".repeat(64),
    testEvidenceDigest: "7".repeat(64),
    targetAuthorityDigest: "9".repeat(64),
    expectedHeadOid: target.version,
    ...actionOverrides,
  };
  const id = `confirmation-change-package-apply-${digestValue({
    requestedBy,
    action,
  })}`;
  return actionPlan({
    id,
    kind: "local.change-package-apply",
    requestedBy,
    actor,
    target,
    action,
    display: {
      title: "应用已验证的本地变更包",
      summary: "敏感路径和内容只存在于展示层，不得进入结果快照。",
      actionLabel: "确认并应用变更包",
      evidence: ["C:\\private\\secret.txt", "token=must-not-project"],
      payload: { actor, target, action },
    },
  });
}

function executor(overrides = {}) {
  return {
    executeCalls: [],
    reconcileCalls: [],
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return { status: "applied", receipt: { id: "review-42" } };
    },
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "absent" };
    },
    ...overrides,
  };
}

function credentialGatedExecutor({ source, reconcileResult = { status: "unknown" } }) {
  async function withCredential(envelope, result) {
    const lease = await source.acquire({
      actorAccountId: envelope.actor.accountId,
      signal: null,
      deadline: Date.now() + 10_000,
    });
    try {
      return await lease.use(async () => structuredClone(result));
    } finally {
      lease.release();
    }
  }
  return {
    execute(envelope) {
      return withCredential(envelope, {
        status: "applied",
        receipt: { id: "credential-gated-execution" },
      });
    },
    reconcile(envelope) {
      return withCredential(envelope, reconcileResult);
    },
  };
}

function recordingCredentialSource(token = "fictional-queue-credential-canary") {
  const events = [];
  return {
    events,
    source: Object.freeze({
      async acquire(request) {
        events.push({ type: "acquire", request: structuredClone(request) });
        let available = true;
        return Object.freeze({
          async use(callback) {
            assert.equal(available, true);
            available = false;
            events.push({ type: "use" });
            return callback(token);
          },
          release() {
            available = false;
            events.push({ type: "release" });
          },
        });
      },
    }),
  };
}

async function readyQueue({
  store = new MemoryStore(),
  actionExecutor = executor(),
  exclusiveLease = new ExclusiveLease(),
  clock = createClock(
    "2026-08-02T01:00:00.000Z",
    "2026-08-02T01:00:01.000Z",
    "2026-08-02T01:00:02.000Z",
    "2026-08-02T01:00:03.000Z",
    "2026-08-02T01:00:04.000Z",
  ),
} = {}) {
  const queue = new ConfirmationQueue({
    store,
    executor: actionExecutor,
    operationQueue: new OperationQueue(),
    exclusiveLease,
    clock,
  });
  await queue.recover();
  return queue;
}

test("automatic Reviews stay available to the publisher while human selection advances past them", async () => {
  const queue = await readyQueue();
  for (let index = 0; index < 40; index += 1) {
    await queue.enqueue(actionPlan({ id: `managed-review-${index}`, kind: "github.work-proposal-review" }));
  }
  await queue.enqueue(actionPlan({ id: "manual-review", kind: "github.pull-request-review" }));
  const human = await queue.nextForHuman();
  assert.equal(human.item.id, "manual-review");
  assert.equal(human.pendingCount, 1);
  assert.equal(human.systemManagedCount, 40);
  assert.equal(human.automaticReviewEnabled, true);
  const raw = await queue.next();
  assert.equal(raw.item.id, "managed-review-0");
  assert.equal(raw.pendingCount, 41);
  assert.equal((await queue.nextForAction("github.work-proposal-review", "pull_request_review")).item.id, raw.item.id);
  assert.equal((await queue.get(raw.item.id)).status, "pending");
  assert.equal((await queue.approve(raw.item.id, approvalRequest(raw))).status, "completed");
});

test("human selection retains converted comments and failed automatic Reviews", async () => {
  const actionExecutor = executor({ async execute() {
    throw new ConfirmationExecutionError("TEMPORARY", "retry", { outcome: "absent", retryable: true });
  } });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan({ id: "failed-review", kind: "github.work-proposal-review" }));
  const raw = await queue.next();
  await queue.approve(raw.item.id, approvalRequest(raw));
  const human = await queue.nextForHuman();
  assert.equal(human.item.id, "failed-review");
  assert.equal(human.item.status, "failed");
  assert.equal(human.systemManagedCount, 0);
  await queue.enqueue(actionPlan({ id: "converted-comment", kind: "github.work-proposal-review",
    action: { type: "pull_request_comment", body: "self authored note" } }));
  assert.equal((await queue.nextForHuman()).item.id, "converted-comment");
});

function approvalRequest(next, requestId = "request-approve-0001") {
  return {
    requestId,
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
}

function producerInvalidation(item, overrides = {}) {
  return {
    requestedBy: structuredClone(item.requestedBy),
    approvalBindingDigest: item.approvalBindingDigest,
    reason: "work_item_superseded",
    ...overrides,
  };
}

test("internal settlement reads durable full records without exposing them in user projections", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  const item = await queue.enqueue(actionPlan());
  assert.equal("execution" in item, false);
  const otherQueue = await readyQueue({ store });
  await otherQueue.invalidate(item.id, producerInvalidation(item, {
    reason: "authorization_changed",
  }));
  const snapshot = await queue.readSettlement({ confirmationId: item.id });
  assert.equal(snapshot.queueRevision, store.value.revision);
  assert.equal(snapshot.item.status, "stale");
  assert.equal(snapshot.item.invalidation.reason, "authorization_changed");
  for (const field of ["execution", "receipt", "failure"]) {
    assert.equal(snapshot.item[field], null);
  }
  assert.deepEqual(snapshot.item.action, store.value.items[0].action);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.item.action), true);
  assert.equal(await queue.readSettlement({ confirmationId: "missing-item" }), null);
  await assert.rejects(queue.readSettlement({ confirmationId: item.id, extra: true }),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST");
  store.failReadAt = store.readCount + 1;
  await assert.rejects(queue.readSettlement({ confirmationId: item.id }), /disk read unavailable/);
});

test("internal settlement preserves evidence that an executed stale confirmation was started", async () => {
  const queue = await readyQueue({ actionExecutor: executor({
    async execute() { return { status: "stale" }; },
  }) });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next));
  const snapshot = await queue.readSettlement({ confirmationId: next.item.id });
  assert.equal(snapshot.item.status, "stale");
  assert.equal(snapshot.item.execution.outcome, "stale");
  assert.equal(snapshot.item.invalidation, null);
});

test("batch settlement reads use one current durable snapshot and stay private and immutable", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  const item = await queue.enqueue(actionPlan());
  const other = await readyQueue({ store });
  await other.invalidate(item.id, producerInvalidation(item));
  const beforeReads = store.readCount, beforeWrites = store.writeCount;
  const snapshot = await queue.readSettlements({ confirmationIds: [item.id, "missing-item"] });
  assert.equal(store.readCount - beforeReads, 1);
  assert.equal(store.writeCount, beforeWrites);
  assert.equal(snapshot.queueRevision, store.value.revision);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].status, "stale");
  assert.equal(snapshot.items[0].execution, null);
  assert.equal(Object.isFrozen(snapshot.items[0].action), true);
  for (const confirmationIds of [[item.id, item.id], ["bad/id"], new Array(1), new Array(1001)]) {
    await assert.rejects(queue.readSettlements({ confirmationIds }), { code: "INVALID_CONFIRMATION_REQUEST" });
  }
  store.failReadAt = store.readCount + 1;
  await assert.rejects(queue.readSettlements({ confirmationIds: [item.id] }), /disk read unavailable/);
});

test("the queue stays closed until durable recovery succeeds", async () => {
  const queue = new ConfirmationQueue({
    store: new MemoryStore(),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });

  await assert.rejects(
    queue.enqueue(actionPlan()),
    (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY" && error.statusCode === 503,
  );
  await assert.rejects(
    queue.readSnapshot({ afterRevision: 0 }),
    (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY",
  );
  await assert.rejects(
    queue.list(),
    (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY",
  );
});

test("a kind-and-action query skips unrelated confirmations without exposing them", async () => {
  const queue = await readyQueue();
  await queue.enqueue(actionPlan());
  await queue.enqueue(configurationPlan("activate_rollback", "rollback"));
  const initialization = await queue.enqueue(
    configurationPlan("initialize_from_draft", "initialization"),
  );

  const selected = await queue.nextForAction(
    "local.configuration-activate",
    "initialize_from_draft",
  );

  assert.equal(selected.pendingCount, 1);
  assert.equal(selected.item.id, initialization.id);
  assert.equal((await queue.next()).item.kind, "github.pull-request-review");
});

test("enqueue freezes an exact plan and is idempotent only for the same binding", async () => {
  const queue = await readyQueue();
  const first = await queue.enqueue(actionPlan());
  const duplicate = await queue.enqueue(actionPlan());

  assert.equal(first.status, "pending");
  assert.deepEqual(duplicate, first);
  assert.match(first.displayedPayloadDigest, /^[a-f0-9]{64}$/);
  assert.match(first.approvalBindingDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(
    queue.enqueue(actionPlan({ action: { type: "pull_request_review", reviewEvent: "COMMENT", body: "changed" } })),
    (error) => error.code === "CONFIRMATION_ID_CONFLICT" && error.statusCode === 409,
  );
});

test("recovery status exposes only sorted distinct uncertain kinds without executor calls", async () => {
  const store = new MemoryStore();
  const executeCalls = [];
  const actionExecutor = executor({
    async execute(envelope) {
      executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError(
        "TEST_EXTERNAL_OUTCOME_UNKNOWN",
        "unknown",
      );
    },
  });
  const queue = await readyQueue({ store, actionExecutor });
  for (const [id, kind, action] of [
    [
      "confirmation-recovery-push",
      "github.pull-request-push",
      { type: "pull_request_push", secret: "push-private-payload" },
    ],
    [
      "confirmation-recovery-comment",
      "github.pull-request-comment",
      { type: "pull_request_comment", body: "comment-private-body" },
    ],
  ]) {
    await queue.enqueue(actionPlan({ id, kind, action }));
    const next = await queue.next();
    await queue.approve(
      next.item.id,
      approvalRequest(next, `request-${id}`),
    );
  }
  await queue.enqueue(actionPlan({
    id: "confirmation-recovery-pending",
    kind: "github.pull-request-merge",
    action: { type: "pull_request_merge", method: "squash" },
  }));
  const writesBeforeRead = store.writeCount;
  const callsBeforeRead = executeCalls.length;

  const status = await queue.readRecoveryStatus();

  assert.deepEqual(status, {
    kinds: [
      "github.pull-request-comment",
      "github.pull-request-push",
    ],
  });
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.kinds), true);
  assert.equal(store.writeCount, writesBeforeRead);
  assert.equal(executeCalls.length, callsBeforeRead);
  const serialized = JSON.stringify(status);
  for (const privateValue of [
    "confirmation-recovery",
    "push-private-payload",
    "comment-private-body",
    "request-confirmation",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("recovery status reads a durable executing kind without waiting for executor completion", async () => {
  let releaseExecution;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { releaseExecution = resolve; });
  const queue = await readyQueue({
    actionExecutor: executor({
      async execute() {
        markStarted();
        await released;
        return { status: "applied", receipt: { id: "done" } };
      },
    }),
  });
  await queue.enqueue(actionPlan({
    id: "confirmation-recovery-executing",
    kind: "github.pull-request-merge",
    action: { type: "pull_request_merge", method: "squash" },
  }));
  const next = await queue.next();
  const approval = queue.approve(
    next.item.id,
    approvalRequest(next, "request-recovery-executing"),
  );
  await started;

  assert.deepEqual(await queue.readRecoveryStatus(), {
    kinds: ["github.pull-request-merge"],
  });

  releaseExecution();
  await approval;
});

test("history listing is read-only, newest-first, cursor paged, filtered, and safely projected", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({
    store,
    clock: createClock(
      "2026-08-02T01:00:00.000Z",
      "2026-08-02T01:00:01.000Z",
      "2026-08-02T01:00:02.000Z",
      "2026-08-02T01:00:03.000Z",
      "2026-08-02T01:00:04.000Z",
      "2026-08-02T01:00:05.000Z",
      "2026-08-02T01:00:06.000Z",
      "2026-08-02T01:00:07.000Z",
    ),
  });

  await queue.enqueue(actionPlan());
  let next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next));

  await queue.enqueue(configurationPlan("activate_rollback", "rejected"));
  next = await queue.next();
  await queue.reject(next.item.id, {
    ...approvalRequest(next, "request-reject-history"),
    reason: "private rejection detail must not be projected",
  });

  const stale = await queue.enqueue(
    actionPlan({
      id: "confirmation-review-44",
      requestedBy: { roleId: "developer", workItemId: "work-private-44" },
    }),
  );
  await queue.invalidate(stale.id, producerInvalidation(stale));
  await queue.enqueue(actionPlan({ id: "confirmation-review-99" }));
  const unsupported = await queue.enqueue(
    actionPlan({
      id: "confirmation-unsupported-history",
      kind: "custom.unsupported-action",
      requestedBy: {
        roleId: "unsupported-history-role",
        workItemId: "unsupported-history-work",
      },
    }),
  );
  await queue.invalidate(unsupported.id, producerInvalidation(unsupported));
  const writesBeforeRead = store.writeCount;

  const first = await queue.list({ limit: 2 });

  assert.equal(first.queueRevision, store.value.revision);
  assert.equal(first.items.length, 2);
  assert.deepEqual(
    first.items.map(({ id }) => id),
    ["confirmation-review-44", "confirmation-configuration-rejected"],
  );
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{16,512}$/);
  assert.equal(first.limit, 2);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.items), true);
  assert.equal(Object.isFrozen(first.items[0]), true);
  assert.equal(Object.isFrozen(first.items[0].requestedBy), true);
  assert.equal(Object.isFrozen(first.roleIdFacets), true);
  assert.deepEqual(first.roleIdFacets, [
    "configuration-owner",
    "developer",
    "pr-reviewer",
  ]);
  assert.equal(
    first.items.some(
      ({ requestedBy }) => requestedBy.roleId === "pr-reviewer",
    ),
    false,
  );
  assert.deepEqual(Object.keys(first.items[0]).sort(), [
    "createdAt",
    "id",
    "kind",
    "requestedBy",
    "retryable",
    "status",
    "summary",
    "title",
    "updatedAt",
  ]);
  for (const item of first.items) {
    for (const forbidden of [
      "action",
      "actor",
      "target",
      "display",
      "displayedPayloadDigest",
      "approvalBindingDigest",
      "receipt",
      "failure",
      "rejection",
      "invalidation",
    ]) {
      assert.equal(Object.hasOwn(item, forbidden), false, forbidden);
    }
  }
  const second = await queue.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["confirmation-review-42"],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(store.writeCount, writesBeforeRead);
  const serialized = JSON.stringify([first, second]);
  for (const secret of [
    "review-account",
    "The reviewed paths are covered.",
    "CI 已通过",
    "private rejection detail",
    "work_item_superseded",
    "0123456789abcdef",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const filtered = await queue.list({
    status: "completed",
    kind: "github.pull-request-review",
    roleId: "pr-reviewer",
    limit: 10,
  });
  assert.deepEqual(filtered.items.map(({ id }) => id), [
    "confirmation-review-42",
  ]);
  assert.deepEqual(filtered.filters, {
    status: "completed",
    kind: "github.pull-request-review",
    roleId: "pr-reviewer",
  });
  assert.equal(
    first.items.some(({ id }) => id === "confirmation-review-99"),
    false,
  );
  assert.equal(
    [...first.items, ...second.items].some(
      ({ id }) => id === "confirmation-unsupported-history",
    ),
    false,
  );
  assert.equal(first.roleIdFacets.includes("unsupported-history-role"), false);
});

test("history projects completed and failed actions with stable diagnostics", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (envelope.requestedBy.workItemId === "history-failed-work") {
        throw new ConfirmationExecutionError("GITHUB_REJECTED", "absent");
      }
      return { status: "applied", receipt: { id: "review-history-success" } };
    },
  });
  const queue = await readyQueue({ actionExecutor });

  await queue.enqueue(
    actionPlan({
      id: "confirmation-history-success",
      requestedBy: { roleId: "pr-reviewer", workItemId: "history-success-work" },
    }),
  );
  let next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next, "history-success-request"));

  await queue.enqueue(
    actionPlan({
      id: "confirmation-history-failed",
      requestedBy: { roleId: "pr-reviewer", workItemId: "history-failed-work" },
    }),
  );
  next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next, "history-failed-request"));

  const history = await queue.list({ limit: 10 });

  assert.deepEqual(
    history.items.map(({ id, status, retryable, diagnosticCode }) => ({
      id,
      status,
      retryable,
      diagnosticCode,
    })),
    [
      {
        id: "confirmation-history-failed",
        status: "failed",
        retryable: true,
        diagnosticCode: "GITHUB_REJECTED",
      },
      {
        id: "confirmation-history-success",
        status: "completed",
        retryable: false,
        diagnosticCode: undefined,
      },
    ],
  );
});

test("history reads the persisted executing snapshot without waiting for executor work", async () => {
  let releaseExecution;
  let signalExecutionStarted;
  const executionGate = new Promise((resolve) => {
    releaseExecution = resolve;
  });
  const executionStarted = new Promise((resolve) => {
    signalExecutionStarted = resolve;
  });
  const store = new MemoryStore();
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      signalExecutionStarted();
      await executionGate;
      return { status: "applied", receipt: { id: "review-executing-history" } };
    },
  });
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const approval = queue.approve(next.item.id, approvalRequest(next));
  await executionStarted;

  const historyPromise = queue.list();
  const history = await Promise.race([
    historyPromise,
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);

  assert.notEqual(history, null);
  assert.equal(store.value.items[0].status, "executing");
  assert.equal(history.queueRevision, store.value.revision);
  assert.deepEqual(history.items, []);
  assert.deepEqual(history.roleIdFacets, []);

  releaseExecution();
  await approval;
  await historyPromise;
});

test("history role facets are deterministically sorted and explicitly bounded", async () => {
  assert.equal(CONFIRMATION_HISTORY_MAX_ROLE_FACETS, 64);
  const queue = await readyQueue();
  for (let index = CONFIRMATION_HISTORY_MAX_ROLE_FACETS; index >= 0; index -= 1) {
    const suffix = String(index).padStart(3, "0");
    const item = await queue.enqueue(
      actionPlan({
        id: `confirmation-role-facet-${suffix}`,
        requestedBy: {
          roleId: `role-${suffix}`,
          workItemId: `work-role-facet-${suffix}`,
        },
      }),
    );
    await queue.invalidate(item.id, producerInvalidation(item));
  }

  const history = await queue.list({ limit: 1 });

  assert.equal(history.roleIdFacets.length, CONFIRMATION_HISTORY_MAX_ROLE_FACETS);
  assert.deepEqual(
    history.roleIdFacets,
    Array.from(
      { length: CONFIRMATION_HISTORY_MAX_ROLE_FACETS },
      (_, index) => `role-${String(index).padStart(3, "0")}`,
    ),
  );
  assert.equal(history.roleIdFacets.includes("role-064"), false);
});

test("history listing rejects non-whitelisted filters, oversized pages, and mismatched cursors", async () => {
  const queue = await readyQueue();
  const first = await queue.enqueue(actionPlan());
  await queue.invalidate(first.id, producerInvalidation(first));
  const second = await queue.enqueue(
    configurationPlan("activate_rollback", "stale"),
  );
  await queue.invalidate(second.id, producerInvalidation(second));
  const page = await queue.list({ limit: 1 });
  assert.ok(page.nextCursor);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "completed";
    },
  });
  for (const input of [
    null,
    [],
    { extra: true },
    { status: "pending" },
    { status: "executing" },
    { kind: "github.unknown-action" },
    { roleId: "Developer Admin" },
    { limit: 0 },
    { limit: 51 },
    { limit: "10" },
    accessor,
  ]) {
    await assert.rejects(
      queue.list(input),
      (error) =>
        error.code === "INVALID_CONFIRMATION_HISTORY_QUERY" &&
        error.statusCode === 400,
    );
  }
  assert.equal(getterCalls, 0);
  await assert.rejects(
    queue.list({ cursor: "not-a-valid-cursor" }),
    (error) => error.code === "INVALID_CONFIRMATION_HISTORY_CURSOR",
  );
  for (const changedFilter of [
    { status: "completed" },
    { kind: "local.configuration-activate" },
    { roleId: "configuration-owner" },
  ]) {
    await assert.rejects(
      queue.list({
        ...changedFilter,
        limit: 1,
        cursor: page.nextCursor,
      }),
      (error) => error.code === "INVALID_CONFIRMATION_HISTORY_CURSOR",
    );
  }
});

test("application result snapshots expose only immutable minimal projections", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(actionPlan());
  const queued = await queue.enqueue(applicationPlan());
  const writesBeforeRead = store.writeCount;

  const snapshot = await queue.readSnapshot({ afterRevision: 0 });

  assert.equal(snapshot.sourceRevision, 2);
  assert.equal(snapshot.unchanged, false);
  assert.match(snapshot.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.items.length, 1);
  assert.deepEqual(snapshot.items[0], {
    confirmationId: queued.id,
    approvalBindingDigest: queued.approvalBindingDigest,
    requestedBy: { roleId: "developer", workItemId: "work-application-1" },
    job: {
      id: "code-job-application-1",
      revision: 7,
      recordDigest: "1".repeat(64),
    },
    packageId: `change-package-${"8".repeat(64)}`,
    packageDigest: "8".repeat(64),
    workspaceId: "workspace-1",
    itemRevision: 1,
    createdAt: "2026-08-02T01:00:01.000Z",
    updatedAt: "2026-08-02T01:00:01.000Z",
    queueStatus: "pending",
    executionOutcome: null,
    receipt: null,
    failure: null,
    rejectedAt: null,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.items), true);
  assert.equal(Object.isFrozen(snapshot.items[0]), true);
  assert.equal(Object.isFrozen(snapshot.items[0].requestedBy), true);
  assert.equal(Object.isFrozen(snapshot.items[0].job), true);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "token=must-not-project",
    "private\\\\secret.txt",
    "display",
    "action",
    "targetAuthorityDigest",
    "expectedHeadOid",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(store.writeCount, writesBeforeRead);

  const unchanged = await queue.readSnapshot({ afterRevision: 2 });
  assert.deepEqual(unchanged, {
    sourceRevision: 2,
    unchanged: true,
    snapshotDigest: snapshot.snapshotDigest,
    items: [],
  });
  assert.equal(Object.isFrozen(unchanged.items), true);
});

test("confirmation memory pages are sanitized, high-water bound, and restart stable", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  const secretBody = "Do not retain C:\\private\\secret.txt or token=hidden";
  await queue.enqueue(pullRequestExternalActionQueuePlan({
    type: "comment",
    body: secretBody,
  }));
  const next = await queue.next();
  await queue.approve(
    next.item.id,
    approvalRequest(next, "memory-page-approval"),
  );
  const reviewBody = "Current Review must reach durable memory";
  await queue.enqueue(pullRequestExternalActionQueuePlan({
    type: "review",
    verdict: "approve",
    body: reviewBody,
  }));
  const reviewNext = await queue.next();
  await queue.approve(
    reviewNext.item.id,
    approvalRequest(reviewNext, "memory-page-review-approval"),
  );

  const first = await queue.readMemoryPage({
    cursor: 0,
    limit: 100,
    highWatermark: null,
  });
  assert.deepEqual(await queue.readMemoryStatus(), {
    highWatermark: first.highWatermark,
  });

  assert.equal(first.items.length, 2);
  const byType = Object.fromEntries(
    first.items.map((item) => [item.action.type, item]),
  );
  assert.equal(byType.pull_request_comment.status, "completed");
  assert.equal(
    byType.pull_request_comment.action.inputBinding.schemaVersion,
    2,
  );
  assert.match(
    byType.pull_request_comment.action.bodyDigest,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    byType.pull_request_comment.action.bodyBytes,
    Buffer.byteLength(secretBody),
  );
  assert.deepEqual(byType.pull_request_comment.receipt, { id: "review-42" });
  assert.equal(byType.pull_request_review.kind, "github.work-proposal-review");
  assert.equal(byType.pull_request_review.status, "completed");
  assert.equal(byType.pull_request_review.action.reviewEvent, "APPROVE");
  assert.equal(
    byType.pull_request_review.action.bodyBytes,
    Buffer.byteLength(reviewBody),
  );
  assert.deepEqual(byType.pull_request_review.receipt, { id: "review-42" });
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(secretBody), false);
  assert.equal(serialized.includes("C:\\private"), false);
  assert.equal(serialized.includes("token=hidden"), false);

  const recovered = await readyQueue({ store });
  assert.deepEqual(
    await recovered.readMemoryPage({
      cursor: 0,
      limit: 100,
      highWatermark: null,
    }),
    first,
  );

  await recovered.enqueue(pullRequestExternalActionQueuePlan(
    { type: "comment", body: "Second action" },
    { proposalId: "proposal-comment-second" },
  ));
  assert.equal(
    (await recovered.readMemoryStatus()).highWatermark > first.highWatermark,
    true,
  );
  await assert.rejects(
    recovered.readMemoryPage({
      cursor: 0,
      limit: 100,
      highWatermark: first.highWatermark,
    }),
    (error) => error?.code === "CONFIRMATION_MEMORY_SOURCE_CHANGED",
  );
});

test("confirmation memory pages keep their durable snapshot private across reload completion", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(pullRequestExternalActionQueuePlan({ type: "comment", body: "Durable body" }));
  const expected = projectConfirmationMemoryState(store.value);
  let publicState = queue.state;
  Object.defineProperty(queue, "state", {
    configurable: true,
    get: () => publicState,
    set(value) {
      publicState = value;
      queueMicrotask(() => {
        value.revision = 0;
        value.items.length = 0;
      });
    },
  });

  const page = await queue.readMemoryPage({ cursor: 0, limit: 100, highWatermark: null });
  assert.equal(publicState.items.length, 0);
  assert.equal(page.highWatermark, expected.highWatermark);
  assert.deepEqual(page.items, expected.items);
  assert.equal(Object.isFrozen(page.items[0].action), true);
});

test("confirmation memory pagination rereads durable changes and rejects corrupted content", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  for (const suffix of ["c", "a", "b"]) {
    await queue.enqueue(pullRequestExternalActionQueuePlan(
      { type: "comment", body: `Memory body ${suffix}` },
      { proposalId: `proposal-memory-${suffix}` },
    ));
  }
  const expected = projectConfirmationMemoryState(store.value);
  const beforeReads = store.readCount;
  const beforeWrites = store.writeCount;
  const items = [];
  let cursor = 0;
  do {
    const page = await queue.readMemoryPage({ cursor, limit: 1, highWatermark: expected.highWatermark });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(items, expected.items);
  assert.equal(store.readCount - beforeReads, 3);
  assert.equal(store.writeCount, beforeWrites);
  await assert.rejects(queue.readMemoryPage({ cursor: 4, limit: 1, highWatermark: null }), {
    code: "INVALID_CONFIRMATION_MEMORY_QUERY",
  });

  const other = await readyQueue({ store });
  await other.enqueue(pullRequestExternalActionQueuePlan(
    { type: "comment", body: "Another writer" },
    { proposalId: "proposal-memory-another-writer" },
  ));
  await assert.rejects(queue.readMemoryPage({ cursor: 0, limit: 1, highWatermark: expected.highWatermark }), {
    code: "CONFIRMATION_MEMORY_SOURCE_CHANGED",
  });
  const current = await queue.readMemoryPage({ cursor: 0, limit: 100, highWatermark: null });
  assert.equal(current.items.length, 4);
  assert.equal(current.highWatermark, store.value.revision);
  store.value.items[0].approvalBindingDigest = "0".repeat(64);
  await assert.rejects(queue.readMemoryPage({ cursor: 0, limit: 100, highWatermark: null }), {
    code: "CONFIRMATION_STATE_CORRUPTED",
  });
});

test("exported confirmation memory projection still validates frozen caller input", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(pullRequestExternalActionQueuePlan({ type: "comment", body: "Strict exported reader" }));
  const malformed = structuredClone(store.value);
  malformed.items[0].approvalBindingDigest = "0".repeat(64);
  Object.freeze(malformed.items[0]);
  Object.freeze(malformed.items);
  Object.freeze(malformed);
  assert.throws(() => projectConfirmationMemoryState(malformed), {
    code: "CONFIRMATION_STATE_CORRUPTED",
  });
});

test("application result snapshots sort deterministically and reject invalid cursors", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(applicationPlan({
    packageDigest: "b".repeat(64),
    jobId: "code-job-b",
    workItemId: "work-b",
  }));
  await queue.enqueue(applicationPlan({
    packageDigest: "a".repeat(64),
    jobId: "code-job-a",
    workItemId: "work-a",
  }));
  const first = await queue.readSnapshot({ afterRevision: 0 });
  assert.deepEqual(
    first.items.map(({ confirmationId }) => confirmationId),
    first.items.map(({ confirmationId }) => confirmationId).toSorted(),
  );

  const reorderedState = structuredClone(store.value);
  reorderedState.items.reverse();
  const recovered = await readyQueue({
    store: new MemoryStore(reorderedState),
  });
  assert.deepEqual(await recovered.readSnapshot({ afterRevision: 0 }), first);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "afterRevision", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  for (const input of [
    undefined,
    null,
    {},
    [],
    { afterRevision: -1 },
    { afterRevision: 1.5 },
    { afterRevision: "0" },
    { afterRevision: 0, extra: true },
    accessor,
  ]) {
    await assert.rejects(
      queue.readSnapshot(input),
      (error) =>
        error.code === "INVALID_APPLICATION_RESULT_SNAPSHOT_REQUEST" &&
        error.statusCode === 400,
    );
  }
  assert.equal(getterCalls, 0);
  await assert.rejects(
    queue.readSnapshot({ afterRevision: first.sourceRevision + 1 }),
    (error) =>
      error.code === "APPLICATION_RESULT_SOURCE_REVISION_CONFLICT" &&
      error.statusCode === 409,
  );
});

test("application result snapshots whitelist terminal receipts, failures, and rejection time", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (envelope.requestedBy.workItemId === "work-completed") {
        return {
          status: "applied",
          receipt: {
            id: `change-package-application-${digestValue({
              confirmationId: envelope.id,
              approvalBindingDigest: envelope.approvalBindingDigest,
            })}`,
            createdAt: envelope.execution.startedAt,
          },
        };
      }
      throw new ConfirmationExecutionError("APPLICATION_REJECTED", "absent");
    },
  });
  const queue = await readyQueue({ actionExecutor });

  await queue.enqueue(applicationPlan({ workItemId: "work-completed" }));
  let next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next));

  await queue.enqueue(applicationPlan({
    packageDigest: "a".repeat(64),
    jobId: "code-job-failed",
    workItemId: "work-failed",
  }));
  next = await queue.next();
  await queue.approve(
    next.item.id,
    approvalRequest(next, "request-approve-0002"),
  );

  await queue.enqueue(applicationPlan({
    packageDigest: "b".repeat(64),
    jobId: "code-job-rejected",
    workItemId: "work-rejected",
  }));
  next = await queue.next();
  await queue.reject(next.item.id, {
    ...approvalRequest(next, "request-reject-0001"),
    reason: "contains private implementation notes",
  });

  const snapshot = await queue.readSnapshot({ afterRevision: 0 });
  const completed = snapshot.items.find(
    ({ requestedBy }) => requestedBy.workItemId === "work-completed",
  );
  assert.equal(completed.queueStatus, "completed");
  assert.equal(completed.executionOutcome, "applied");
  assert.deepEqual(completed.receipt, {
    id: `change-package-application-${digestValue({
      confirmationId: completed.confirmationId,
      approvalBindingDigest: completed.approvalBindingDigest,
    })}`,
    createdAt: "2026-08-02T01:00:01.000Z",
  });

  const failed = snapshot.items.find(
    ({ requestedBy }) => requestedBy.workItemId === "work-failed",
  );
  assert.equal(failed.queueStatus, "failed");
  assert.equal(failed.executionOutcome, "absent");
  assert.deepEqual(failed.failure, {
    code: "APPLICATION_REJECTED",
    outcome: "absent",
    retryable: true,
    at: "2026-08-02T01:00:04.000Z",
  });

  const rejected = snapshot.items.find(
    ({ requestedBy }) => requestedBy.workItemId === "work-rejected",
  );
  assert.equal(rejected.queueStatus, "rejected");
  assert.equal(rejected.executionOutcome, null);
  assert.equal(rejected.rejectedAt, "2026-08-02T01:00:04.000Z");
  assert.equal(JSON.stringify(rejected).includes("private implementation"), false);
});

test("application result snapshots fail closed on a generic malformed local action", async () => {
  const queue = await readyQueue();
  await queue.enqueue(applicationPlan({
    actionOverrides: { privatePath: "C:\\private\\secret.txt" },
  }));

  await assert.rejects(
    queue.readSnapshot({ afterRevision: 0 }),
    (error) =>
      error.code === "APPLICATION_RESULT_SOURCE_CORRUPTED" &&
      error.statusCode === 500 &&
      !error.message.includes("secret"),
  );
});

test("next returns exactly the oldest actionable item without its private action", async () => {
  const queue = await readyQueue();
  await queue.enqueue(actionPlan());
  await queue.enqueue(actionPlan({ id: "confirmation-review-43" }));

  const next = await queue.next();

  assert.equal(next.pendingCount, 2);
  assert.equal(next.item.id, "confirmation-review-42");
  assert.equal("action" in next.item, false);
  assert.equal(
    next.item.display.payload.action.body,
    "The reviewed paths are covered.",
  );
});

test("next skips only exact deferred bindings without mutating the queue", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(actionPlan());
  await queue.enqueue(actionPlan({ id: "confirmation-review-43" }));
  const first = await queue.next();
  const writesBeforeRead = store.writeCount;

  const deferred = await queue.next({
    deferred: [
      {
        id: first.item.id,
        approvalBindingDigest: first.item.approvalBindingDigest,
      },
    ],
  });

  assert.equal(deferred.item.id, "confirmation-review-43");
  assert.equal(deferred.pendingCount, 1);
  assert.equal(store.writeCount, writesBeforeRead);
  assert.equal(
    (
      await queue.next({
        deferred: [
          {
            id: first.item.id,
            approvalBindingDigest: "0".repeat(64),
          },
        ],
      })
    ).item.id,
    first.item.id,
  );
  assert.equal((await queue.next()).item.id, first.item.id);
});

test("next rejects malformed or oversized deferred binding lists without invoking accessors", async () => {
  const queue = await readyQueue();
  let invoked = false;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "deferred", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });

  await assert.rejects(
    queue.next(accessorOptions),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
  assert.equal(invoked, false);
  await assert.rejects(
    queue.next({
      deferred: Array.from({ length: 33 }, (_, index) => ({
        id: `confirmation-deferred-${index}`,
        approvalBindingDigest: index.toString(16).padStart(64, "0"),
      })),
    }),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
  await assert.rejects(
    queue.next({ deferred: [], unexpected: true }),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
});

test("approval persists executing before the external executor is called", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(queue.approve(next.item.id, approvalRequest(next)), /disk unavailable/);

  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("concurrent and repeated approvals perform one external write", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      await gate;
      return { status: "applied", receipt: { id: "review-42" } };
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const request = approvalRequest(next);

  const first = queue.approve(next.item.id, request);
  const duplicate = queue.approve(next.item.id, request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actionExecutor.executeCalls.length, 1);
  release();

  assert.deepEqual(await duplicate, await first);
  const repeated = await queue.approve(next.item.id, request);
  assert.equal(repeated.status, "completed");
  assert.equal(actionExecutor.executeCalls.length, 1);
  assert.equal(
    actionExecutor.executeCalls[0].idempotencyKey,
    `confirmation-${next.item.approvalBindingDigest}`,
  );
  assert.deepEqual(actionExecutor.executeCalls[0].execution, {
    requestId: request.requestId,
    attempt: 1,
    startedAt: "2026-08-02T01:00:01.000Z",
  });
});

test("a shared exclusive lease prevents two queue instances from writing twice", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = new MemoryStore();
  const exclusiveLease = new ExclusiveLease();
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      await gate;
      return { status: "applied", receipt: { id: "review-42" } };
    },
  });
  const first = await readyQueue({ store, actionExecutor, exclusiveLease });
  await first.enqueue(actionPlan());
  const second = await readyQueue({ store, actionExecutor, exclusiveLease });
  const next = await first.next();
  const request = approvalRequest(next);

  const firstApproval = first.approve(next.item.id, request);
  const secondApproval = second.approve(next.item.id, request);
  await new Promise((resolve) => setImmediate(resolve));
  const writesBeforeRelease = actionExecutor.executeCalls.length;
  release();

  assert.equal((await firstApproval).status, "completed");
  assert.equal((await secondApproval).status, "completed");
  assert.equal(writesBeforeRelease, 1);
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("application snapshots reload updates written by another queue instance", async () => {
  const store = new MemoryStore();
  const exclusiveLease = new ExclusiveLease();
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return {
        status: "applied",
        receipt: {
          id: `change-package-application-${digestValue({
            confirmationId: envelope.id,
            approvalBindingDigest: envelope.approvalBindingDigest,
          })}`,
          createdAt: envelope.execution.startedAt,
        },
      };
    },
  });
  const first = await readyQueue({ store, actionExecutor, exclusiveLease });
  const second = await readyQueue({ store, actionExecutor, exclusiveLease });
  const initial = await first.readSnapshot({ afterRevision: 0 });
  assert.equal(initial.unchanged, true);

  await second.enqueue(applicationPlan());
  const pending = await first.readSnapshot({ afterRevision: 0 });
  assert.equal(pending.unchanged, false);
  assert.equal(pending.items[0].queueStatus, "pending");

  const next = await second.next();
  await second.approve(next.item.id, approvalRequest(next));
  const completed = await first.readSnapshot({
    afterRevision: pending.sourceRevision,
  });
  assert.equal(completed.unchanged, false);
  assert.equal(completed.items[0].queueStatus, "completed");
  assert.equal(completed.items[0].executionOutcome, "applied");
});

test("stale bindings and stale targets never invoke a second external action", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return { status: "stale", actualVersion: "fedcba" };
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const tampered = { ...approvalRequest(next), displayedPayloadDigest: "0".repeat(64) };

  await assert.rejects(
    queue.approve(next.item.id, tampered),
    (error) => error.code === "CONFIRMATION_BINDING_MISMATCH" && error.statusCode === 409,
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
  const result = await queue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("a trusted producer durably invalidates a pending action before concurrent approval", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const invalidation = producerInvalidation(next.item);

  const stalePromise = queue.invalidate(next.item.id, invalidation);
  const approvalPromise = queue.approve(
    next.item.id,
    approvalRequest(next, "request-approve-after-invalidation"),
  );
  const [stale, approval] = await Promise.all([
    stalePromise,
    approvalPromise,
  ]);

  assert.equal(stale.status, "stale");
  assert.equal(approval.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(store.value.items[0].status, "stale");
  assert.equal(
    store.value.items[0].invalidation.reason,
    "work_item_superseded",
  );
  assert.deepEqual(
    store.value.items[0].invalidation.requestedBy,
    next.item.requestedBy,
  );

  const recovered = await readyQueue({ store, actionExecutor });
  const recoveredItem = await recovered.get(next.item.id);
  const repeated = await recovered.invalidate(
    next.item.id,
    producerInvalidation(recoveredItem),
  );
  const approvedAfterRecovery = await recovered.approve(
    next.item.id,
    approvalRequest(next, "request-approve-after-recovery"),
  );

  assert.equal(recoveredItem.status, "stale");
  assert.equal(repeated.status, "stale");
  assert.equal(approvedAfterRecovery.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("a failed stale write leaves an in-process veto over every user action", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(
    queue.invalidate(next.item.id, producerInvalidation(next.item)),
    /disk unavailable/,
  );

  assert.equal(store.value.items[0].status, "pending");
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-vetoed-item"),
    ),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  await assert.rejects(
    queue.retry(
      next.item.id,
      approvalRequest(next, "request-retry-vetoed-item"),
    ),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  await assert.rejects(
    queue.reject(next.item.id, {
      ...approvalRequest(next, "request-reject-vetoed-item"),
      reason: "旧作业已经失效",
    }),
    (error) =>
      error.statusCode === 409 &&
      error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);

  const stale = await queue.invalidate(
    next.item.id,
    producerInvalidation(next.item),
  );
  assert.equal(stale.status, "stale");
  assert.equal((await queue.next()).item, null);
});

test("a queued producer mismatch cannot erase an earlier in-process veto", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  const failedInvalidation = queue.invalidate(
    next.item.id,
    producerInvalidation(next.item),
  );
  const mismatchedInvalidation = queue.invalidate(
    next.item.id,
    producerInvalidation(next.item, {
      requestedBy: {
        ...next.item.requestedBy,
        workItemId: "pr-work-untrusted",
      },
    }),
  );

  await assert.rejects(failedInvalidation, /disk unavailable/);
  await assert.rejects(
    mismatchedInvalidation,
    (error) => error.code === "CONFIRMATION_PRODUCER_MISMATCH",
  );
  assert.deepEqual(
    queue.producerVetoes.get(next.item.id),
    producerInvalidation(next.item),
  );
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-after-mismatch"),
    ),
    (error) => error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("a later reload failure restores an earlier in-process veto", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(
    queue.invalidate(next.item.id, producerInvalidation(next.item)),
    /disk unavailable/,
  );
  store.failReadAt = store.readCount + 1;
  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        requestedBy: {
          ...next.item.requestedBy,
          workItemId: "pr-work-untrusted",
        },
      }),
    ),
    /disk read unavailable/,
  );

  assert.deepEqual(
    queue.producerVetoes.get(next.item.id),
    producerInvalidation(next.item),
  );
  assert.equal((await queue.next()).item, null);
  await assert.rejects(
    queue.approve(
      next.item.id,
      approvalRequest(next, "request-approve-after-reload-failure"),
    ),
    (error) => error.code === "CONFIRMATION_INVALIDATION_PENDING",
  );
  assert.equal(actionExecutor.executeCalls.length, 0);
});

test("a veto created by invalidate-before-enqueue makes a late plan durably stale", async () => {
  const store = new MemoryStore();
  const actionExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor });
  const normalizedPlan = normalizeConfirmationPlan(actionPlan());
  const invalidation = producerInvalidation(normalizedPlan);

  await assert.rejects(
    queue.invalidate(normalizedPlan.id, invalidation),
    (error) => error.statusCode === 404,
  );
  const late = await queue.enqueue(actionPlan());

  assert.equal(late.status, "stale");
  assert.equal(late.invalidation.reason, "work_item_superseded");
  assert.equal((await queue.next()).item, null);
  const approved = await queue.approve(
    late.id,
    approvalRequest(
      { queueRevision: late.queueRevision, item: late },
      "request-approve-late-plan",
    ),
  );
  assert.equal(approved.status, "stale");

  const recovered = await readyQueue({ store, actionExecutor });
  assert.equal((await recovered.get(late.id)).status, "stale");
  assert.equal((await recovered.next()).item, null);
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("producer invalidation requires the exact original producer and binding", async () => {
  const actionExecutor = executor();
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        requestedBy: {
          ...next.item.requestedBy,
          workItemId: "pr-work-other",
        },
      }),
    ),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    queue.invalidate(
      next.item.id,
      producerInvalidation(next.item, {
        approvalBindingDigest: "0".repeat(64),
      }),
    ),
    (error) => error.statusCode === 409,
  );

  assert.equal((await queue.get(next.item.id)).status, "pending");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal(actionExecutor.reconcileCalls.length, 0);
});

test("a proven-absent failed action can be invalidated without another Review", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError("GITHUB_REJECTED", "absent");
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  const failed = await queue.approve(next.item.id, approvalRequest(next));

  const stale = await queue.invalidate(
    failed.id,
    producerInvalidation(failed),
  );
  const approvedAfterInvalidation = await queue.approve(
    failed.id,
    approvalRequest(next, "request-approve-after-absent"),
  );

  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(stale.status, "stale");
  assert.equal(approvedAfterInvalidation.status, "stale");
  assert.equal(actionExecutor.executeCalls.length, 1);
});

test("executing, unknown, completed, and rejected actions cannot be invalidated", async (t) => {
  await t.test("approval wins the race exactly once", async () => {
    let releaseExecution;
    const executionGate = new Promise((resolve) => {
      releaseExecution = resolve;
    });
    const actionExecutor = executor({
      async execute(envelope) {
        this.executeCalls.push(structuredClone(envelope));
        await executionGate;
        return { status: "applied", receipt: { id: "review-42" } };
      },
    });
    const queue = await readyQueue({ actionExecutor });
    await queue.enqueue(actionPlan());
    const next = await queue.next();
    const approval = queue.approve(next.item.id, approvalRequest(next));
    const invalidation = assert.rejects(
      queue.invalidate(
        next.item.id,
        producerInvalidation(next.item),
      ),
      (error) => error.statusCode === 409,
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseExecution();

    assert.equal((await approval).status, "completed");
    await invalidation;
    assert.equal(actionExecutor.executeCalls.length, 1);
  });

  const terminalCases = [
    {
      name: "unknown",
      actionExecutor: executor({
        async execute(envelope) {
          this.executeCalls.push(structuredClone(envelope));
          throw new ConfirmationExecutionError("GITHUB_TIMEOUT", "unknown");
        },
      }),
      finish: async (queue, next) =>
        queue.approve(next.item.id, approvalRequest(next)),
    },
    {
      name: "completed",
      actionExecutor: executor(),
      finish: async (queue, next) =>
        queue.approve(next.item.id, approvalRequest(next)),
    },
    {
      name: "rejected",
      actionExecutor: executor(),
      finish: async (queue, next) =>
        queue.reject(next.item.id, {
          ...approvalRequest(next, "request-reject-before-invalidation"),
          reason: "不再发布",
        }),
    },
  ];

  for (const scenario of terminalCases) {
    await t.test(scenario.name, async () => {
      const queue = await readyQueue({
        actionExecutor: scenario.actionExecutor,
      });
      await queue.enqueue(actionPlan());
      const next = await queue.next();
      const terminal = await scenario.finish(queue, next);
      const callsBeforeInvalidation =
        scenario.actionExecutor.executeCalls.length;

      await assert.rejects(
        queue.invalidate(
          next.item.id,
          producerInvalidation(next.item),
        ),
        (error) => error.statusCode === 409,
      );

      assert.equal((await queue.get(next.item.id)).status, terminal.status);
      assert.equal(
        scenario.actionExecutor.executeCalls.length,
        callsBeforeInvalidation,
      );
    });
  }
});

test("rejection is durable and cannot execute", async () => {
  const actionExecutor = executor();
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  const result = await queue.reject(next.item.id, {
    ...approvalRequest(next, "request-reject-0001"),
    reason: "正文需要重新整理",
  });

  assert.equal(result.status, "rejected");
  assert.equal(actionExecutor.executeCalls.length, 0);
  assert.equal((await queue.next()).item, null);
});

test("pending startup, proposal, reads, status, history, and rejection never acquire GitHub credentials", async () => {
  const credential = recordingCredentialSource();
  const store = new MemoryStore();
  const first = await readyQueue({
    store,
    actionExecutor: credentialGatedExecutor({ source: credential.source }),
  });
  const queued = await first.enqueue(actionPlan());

  await first.next();
  await first.nextForAction("github.pull-request-review", "pull_request_review");
  await first.get(queued.id);
  await first.list();
  await first.readRecoveryStatus();
  await first.readMemoryStatus();
  await first.readMemoryPage({ cursor: 0, limit: 100, highWatermark: null });
  assert.equal(credential.events.length, 0);

  const recovered = await readyQueue({
    store,
    actionExecutor: credentialGatedExecutor({ source: credential.source }),
  });
  assert.equal(credential.events.length, 0);
  const next = await recovered.next();
  await recovered.reject(next.item.id, {
    ...approvalRequest(next, "request-zero-acquire-reject"),
    reason: "owner rejected the fictional proposal",
  });

  assert.equal(credential.events.length, 0);
  assert.equal(JSON.stringify(store.value).includes("fictional-queue-credential-canary"), false);
  assert.equal(JSON.stringify(await recovered.list()).includes("fictional-queue-credential-canary"), false);
});

test("only durable executing or unknown Review and generic recovery acquires one credential lease", async (t) => {
  const scenarios = [
    { name: "Review executing", plan: actionPlan(), durable: "executing" },
    {
      name: "generic executing",
      plan: pullRequestExternalActionQueuePlan({
        type: "comment",
        body: "fictional recovery comment",
      }),
      durable: "executing",
    },
    { name: "Review unknown", plan: actionPlan(), durable: "unknown" },
    {
      name: "generic unknown",
      plan: pullRequestExternalActionQueuePlan({
        type: "comment",
        body: "fictional recovery comment",
      }),
      durable: "unknown",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const requestId = `request-recovery-${scenario.name
        .toLowerCase()
        .replaceAll(" ", "-")}`;
      const store = new MemoryStore();
      const first = await readyQueue({ store, actionExecutor: executor({
        async execute(envelope) {
          this.executeCalls.push(structuredClone(envelope));
          if (scenario.durable === "unknown") {
            throw new ConfirmationExecutionError("GITHUB_RESPONSE_LOST", "unknown");
          }
          return { status: "applied", receipt: { id: "first-write" } };
        },
      }) });
      await first.enqueue(scenario.plan);
      const next = await first.next();
      if (scenario.durable === "executing") {
        store.failWriteAt = store.writeCount + 2;
        await assert.rejects(
          first.approve(next.item.id, approvalRequest(next, requestId)),
          /disk unavailable/,
        );
        store.failWriteAt = null;
        assert.equal(store.value.items[0].status, "executing");
      } else {
        const failed = await first.approve(
          next.item.id,
          approvalRequest(next, requestId),
        );
        assert.equal(failed.failure.outcome, "unknown");
      }

      const credential = recordingCredentialSource();
      const recovered = await readyQueue({
        store,
        actionExecutor: credentialGatedExecutor({
          source: credential.source,
          reconcileResult: { status: "unknown", code: "GITHUB_RESPONSE_LOST" },
        }),
      });
      assert.deepEqual(
        credential.events.map(({ type }) => type),
        ["acquire", "use", "release"],
      );
      assert.equal(JSON.stringify(store.value).includes("fictional-queue-credential-canary"), false);
      assert.equal(JSON.stringify(await recovered.readRecoveryStatus()).includes("fictional-queue-credential-canary"), false);
    });
  }
});

test("a proven absent failure is retryable but an unknown outcome requires sealing", async () => {
  const absentExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (this.executeCalls.length === 1) {
        throw new ConfirmationExecutionError("GITHUB_REJECTED", "absent");
      }
      return { status: "applied", receipt: { id: "review-retried" } };
    },
  });
  const queue = await readyQueue({ actionExecutor: absentExecutor });
  await queue.enqueue(actionPlan());
  let next = await queue.next();
  let result = await queue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.status, "failed");
  assert.equal(result.failure.retryable, true);

  next = await queue.next();
  result = await queue.retry(next.item.id, approvalRequest(next, "request-retry-0001"));
  assert.equal(result.status, "completed");
  assert.equal(absentExecutor.reconcileCalls.length, 1);
  assert.equal(absentExecutor.executeCalls.length, 2);
  assert.equal(
    absentExecutor.executeCalls[0].idempotencyKey,
    absentExecutor.executeCalls[1].idempotencyKey,
  );
  assert.equal(absentExecutor.executeCalls[1].execution.attempt, 2);
  assert.equal(
    absentExecutor.executeCalls[1].execution.requestId,
    "request-retry-0001",
  );

  const unknownExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError("GITHUB_TIMEOUT", "unknown");
    },
  });
  const unknownQueue = await readyQueue({ actionExecutor: unknownExecutor });
  await unknownQueue.enqueue(actionPlan());
  next = await unknownQueue.next();
  result = await unknownQueue.approve(next.item.id, approvalRequest(next));
  assert.equal(result.failure.retryable, false);
  const resolution = await unknownQueue.next();
  assert.equal(resolution.item.id, result.id);
  assert.equal(resolution.item.resolutionRequired, true);
  assert.equal(resolution.item.retryable, false);
  await assert.rejects(
    unknownQueue.retry(result.id, approvalRequest({ queueRevision: result.queueRevision, item: result }, "request-retry-0002")),
    (error) => error.code === "CONFIRMATION_NOT_RETRYABLE",
  );
});

test("startup recovery reconciles an applied action after the final local write failed", async () => {
  const store = new MemoryStore();
  const firstExecutor = executor();
  const queue = await readyQueue({ store, actionExecutor: firstExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 2;

  await assert.rejects(queue.approve(next.item.id, approvalRequest(next)), /disk unavailable/);
  assert.equal(store.value.items[0].status, "executing");
  store.failWriteAt = null;

  const recoveryExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "already", receipt: { id: "review-42" } };
    },
  });
  const recovered = await readyQueue({ store, actionExecutor: recoveryExecutor });

  assert.equal((await recovered.get(next.item.id)).status, "completed");
  assert.equal(recoveryExecutor.reconcileCalls.length, 1);
  assert.equal(recoveryExecutor.executeCalls.length, 0);
});

test("startup recovery never turns an unknown action into a retryable absence", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store, actionExecutor: executor() });
  await queue.enqueue(pullRequestExternalActionQueuePlan(
    { type: "review", verdict: "approve", body: "Review result" },
    { proposalId: "proposal-sealed-unknown" },
  ));
  const next = await queue.next();
  store.failWriteAt = store.writeCount + 2;

  await assert.rejects(queue.approve(next.item.id, approvalRequest(next)), /disk unavailable/);
  assert.equal(store.value.items[0].status, "executing");
  store.failWriteAt = null;

  const recoveryExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "absent", code: "GITHUB_MARKER_ABSENT" };
    },
  });
  const recovered = await readyQueue({ store, actionExecutor: recoveryExecutor });
  const item = await recovered.get(next.item.id);

  assert.equal(item.status, "failed");
  assert.equal(item.retryable, false);
  assert.deepEqual(item.failure, {
    code: "GITHUB_MARKER_ABSENT",
    outcome: "unknown",
    retryable: false,
    at: "2026-08-02T01:00:00.000Z",
  });
  const resolution = await recovered.next();
  assert.equal(resolution.pendingCount, 1);
  assert.equal(resolution.item.id, next.item.id);
  assert.equal(resolution.item.resolutionRequired, true);
  assert.equal(resolution.item.retryable, false);
  const executionBeforeSealing = structuredClone(
    store.value.items.find(({ id }) => id === resolution.item.id).execution,
  );
  const failureBeforeSealing = structuredClone(resolution.item.failure);

  const sealed = await recovered.reject(
    resolution.item.id,
    {
      ...approvalRequest(resolution, "request-seal-unknown-result"),
      reason: "owner acknowledged the uncertain result without replay",
    },
  );
  assert.equal(sealed.status, "rejected");
  const durableSealed = store.value.items.find(
    ({ id }) => id === resolution.item.id,
  );
  const durableRejection = structuredClone(durableSealed.rejection);
  assert.equal(Object.hasOwn(sealed, "rejection"), false);
  assert.deepEqual(sealed.ownerDecision, {
    type: "seal_unknown_and_forbid_replay",
    at: durableRejection.at,
  });
  assert.deepEqual(sealed.failure, failureBeforeSealing);
  assert.deepEqual(
    store.value.items.find(({ id }) => id === resolution.item.id).execution,
    executionBeforeSealing,
  );
  assert.equal(
    durableRejection.reason,
    "owner acknowledged the uncertain result without replay",
  );
  assert.deepEqual(
    (await recovered.list({ limit: 10 })).items.map(
      ({ status, diagnosticCode, ownerDecision }) => ({
        status,
        diagnosticCode,
        ownerDecision,
      }),
    ),
    [{
      status: "rejected",
      diagnosticCode: "GITHUB_MARKER_ABSENT",
      ownerDecision: {
        type: "seal_unknown_and_forbid_replay",
        at: durableRejection.at,
      },
    }],
  );
  const sealedMemoryItem = (
    await recovered.readMemoryPage({
      cursor: 0,
      limit: 10,
      highWatermark: null,
    })
  ).items[0];
  assert.deepEqual(
    {
      status: sealedMemoryItem.status,
      executionOutcome: sealedMemoryItem.execution.outcome,
      failure: sealedMemoryItem.failure,
      rejectedAt: sealedMemoryItem.rejectedAt,
      ownerDecision: sealedMemoryItem.ownerDecision,
    },
    {
      status: "rejected",
      executionOutcome: "unknown",
      failure: failureBeforeSealing,
      rejectedAt: durableRejection.at,
      ownerDecision: {
        type: "seal_unknown_and_forbid_replay",
        at: durableRejection.at,
      },
    },
  );
  assert.equal((await recovered.next()).item, null);
  assert.equal(recoveryExecutor.reconcileCalls.length, 1);
  assert.equal(recoveryExecutor.executeCalls.length, 0);

  const postSealExecutor = executor();
  const restarted = await readyQueue({
    store: new MemoryStore(structuredClone(store.value)),
    actionExecutor: postSealExecutor,
  });
  const afterRestart = await restarted.get(resolution.item.id);
  assert.equal(afterRestart.status, "rejected");
  assert.deepEqual(afterRestart.failure, failureBeforeSealing);
  assert.equal(postSealExecutor.reconcileCalls.length, 0);
  assert.equal(postSealExecutor.executeCalls.length, 0);

  const invalidSealedUnknownStates = [
    (durableItem) => {
      durableItem.failure = null;
    },
    (durableItem) => {
      durableItem.execution = null;
    },
    (durableItem) => {
      durableItem.execution.outcome = "absent";
    },
    (durableItem) => {
      durableItem.failure = {
        ...durableItem.failure,
        outcome: "absent",
        retryable: true,
      };
    },
  ];
  for (const corrupt of invalidSealedUnknownStates) {
    const corrupted = structuredClone(store.value);
    corrupt(corrupted.items.find(({ id }) => id === resolution.item.id));
    assert.throws(
      () => normalizeConfirmationState(corrupted),
      (error) => error.code === "CONFIRMATION_STATE_CORRUPTED",
    );
  }
});

test("startup recovery refreshes a stable diagnostic without relaxing unknown", async () => {
  const store = new MemoryStore();
  const firstExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError(
        "GITHUB_RESPONSE_LOST",
        "unknown",
      );
    },
  });
  const first = await readyQueue({ store, actionExecutor: firstExecutor });
  await first.enqueue(actionPlan());
  let next = await first.next();
  const failed = await first.approve(next.item.id, approvalRequest(next));

  assert.equal(failed.failure.code, "GITHUB_RESPONSE_LOST");
  assert.equal(failed.failure.outcome, "unknown");
  assert.equal(failed.retryable, false);

  const recoveryExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError(
        "GITHUB_LOGIN_UNAVAILABLE",
        "absent",
      );
    },
  });
  const recovered = await readyQueue({
    store,
    actionExecutor: recoveryExecutor,
  });
  const current = await recovered.get(failed.id);

  assert.deepEqual(current.failure, {
    code: "GITHUB_LOGIN_UNAVAILABLE",
    outcome: "unknown",
    retryable: false,
    at: "2026-08-02T01:00:00.000Z",
  });
  assert.equal(current.status, "failed");
  assert.equal(current.retryable, false);
  assert.equal(recoveryExecutor.reconcileCalls.length, 1);
  assert.equal(recoveryExecutor.executeCalls.length, 0);
  assert.equal(
    (await recovered.list({ status: "failed", limit: 10 })).items[0]
      .diagnosticCode,
    "GITHUB_LOGIN_UNAVAILABLE",
  );

  const writesAfterDiagnosticRefresh = store.writeCount;
  await readyQueue({ store, actionExecutor: recoveryExecutor });
  assert.equal(store.writeCount, writesAfterDiagnosticRefresh);
  assert.equal(recoveryExecutor.reconcileCalls.length, 2);
});

test("unknown external recovery blocks configuration activation across restarts", async () => {
  const store = new MemoryStore();
  const clock = () => new Date("2026-08-02T02:00:00.000Z");
  const firstExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (envelope.kind === "github.pull-request-review") {
        throw new ConfirmationExecutionError(
          "GITHUB_RESPONSE_LOST",
          "unknown",
        );
      }
      return { status: "applied", receipt: { id: "configuration-v2" } };
    },
  });
  const first = await readyQueue({ store, actionExecutor: firstExecutor, clock });
  await first.enqueue(actionPlan());
  let next = await first.next();
  const unknown = await first.approve(next.item.id, approvalRequest(next));
  const configuration = await first.enqueue(
    configurationPlan("activate_draft", "blocked-by-recovery"),
  );
  next = await first.nextForAction(
    "local.configuration-activate",
    "activate_draft",
  );

  assert.equal(unknown.failure.outcome, "unknown");
  await assert.rejects(
    first.approve(next.item.id, approvalRequest(next, "activate-before-recovery")),
    (error) => error.code === "CONFIRMATION_RECOVERY_REQUIRED",
  );
  assert.equal((await first.get(configuration.id)).status, "pending");
  assert.equal(firstExecutor.executeCalls.length, 1);

  const stillUnknownExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      throw new ConfirmationExecutionError(
        "GITHUB_OBSERVATION_UNAVAILABLE",
        "unknown",
      );
    },
  });
  const second = await readyQueue({
    store,
    actionExecutor: stillUnknownExecutor,
    clock,
  });
  next = await second.nextForAction(
    "local.configuration-activate",
    "activate_draft",
  );
  await assert.rejects(
    second.approve(next.item.id, approvalRequest(next, "activate-after-restart")),
    (error) => error.code === "CONFIRMATION_RECOVERY_REQUIRED",
  );
  assert.equal(stillUnknownExecutor.executeCalls.length, 0);
  assert.equal(stillUnknownExecutor.reconcileCalls.length, 1);

  const recoveredExecutor = executor({
    async reconcile(envelope) {
      this.reconcileCalls.push(structuredClone(envelope));
      return { status: "already", receipt: { id: "review-42" } };
    },
  });
  const third = await readyQueue({
    store,
    actionExecutor: recoveredExecutor,
    clock,
  });
  next = await third.nextForAction(
    "local.configuration-activate",
    "activate_draft",
  );
  const activated = await third.approve(
    next.item.id,
    approvalRequest(next, "activate-after-recovery"),
  );

  assert.equal(activated.status, "completed");
  assert.equal(recoveredExecutor.reconcileCalls.length, 1);
  assert.equal(recoveredExecutor.executeCalls.length, 1);
  assert.equal(
    recoveredExecutor.executeCalls[0].kind,
    "local.configuration-activate",
  );
});

test("owner-confirmed credential-source activation can unblock only GitHub recovery", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      if (envelope.kind.startsWith("github.")) {
        throw new ConfirmationExecutionError(
          "GITHUB_LOGIN_UNAVAILABLE",
          "unknown",
        );
      }
      return { status: "applied", receipt: { id: "configuration-v9" } };
    },
  });
  const queue = await readyQueue({ actionExecutor });
  await queue.enqueue(actionPlan());
  let next = await queue.next();
  const unknown = await queue.approve(
    next.item.id,
    approvalRequest(next, "request-unknown-review"),
  );
  const configuration = await queue.enqueue(
    githubCredentialRecoveryConfigurationPlan(),
  );
  next = await queue.nextForAction(
    "local.configuration-activate",
    "activate_draft",
  );

  const activated = await queue.approve(
    next.item.id,
    approvalRequest(next, "request-credential-recovery"),
  );

  assert.equal(unknown.failure.outcome, "unknown");
  assert.equal(unknown.retryable, false);
  assert.equal(activated.id, configuration.id);
  assert.equal(activated.status, "completed");
  assert.equal((await queue.get(unknown.id)).failure.outcome, "unknown");
  assert.deepEqual(
    actionExecutor.executeCalls.map(({ kind }) => kind),
    ["github.pull-request-review", "local.configuration-activate"],
  );
});

test("credential recovery activation rejects broader changes and local uncertainty", async () => {
  for (const scenario of ["broader_configuration", "local_unknown"]) {
    const actionExecutor = executor({
      async execute(envelope) {
        this.executeCalls.push(structuredClone(envelope));
        if (envelope.kind !== "local.configuration-activate") {
          throw new ConfirmationExecutionError(
            "TEST_EXTERNAL_OUTCOME_UNKNOWN",
            "unknown",
          );
        }
        return { status: "applied", receipt: { id: "must-not-activate" } };
      },
    });
    const queue = await readyQueue({ actionExecutor });
    const uncertainPlan = scenario === "local_unknown"
      ? actionPlan({
          id: "confirmation-local-unknown",
          kind: "local.change-package-apply",
        })
      : actionPlan();
    await queue.enqueue(uncertainPlan);
    let next = await queue.next();
    await queue.approve(
      next.item.id,
      approvalRequest(next, `request-${scenario}-unknown`),
    );

    let configurationPlan = githubCredentialRecoveryConfigurationPlan();
    if (scenario === "broader_configuration") {
      configurationPlan = structuredClone(configurationPlan);
      const impact = configurationPlan.display.payload.impact;
      impact.restartRequired.paths.push("githubActions.actorAccountId");
      impact.restartRequired.count = impact.restartRequired.paths.length;
    }
    const configuration = await queue.enqueue(configurationPlan);
    next = await queue.nextForAction(
      "local.configuration-activate",
      "activate_draft",
    );

    await assert.rejects(
      queue.approve(
        next.item.id,
        approvalRequest(next, `request-${scenario}-activation`),
      ),
      (error) => error.code === "CONFIRMATION_RECOVERY_REQUIRED",
    );
    assert.equal((await queue.get(configuration.id)).status, "pending");
    assert.equal(
      actionExecutor.executeCalls.some(
        ({ kind }) => kind === "local.configuration-activate",
      ),
      false,
    );
  }
});

test("corrupted durable state fails closed without making the queue ready", async () => {
  const store = new MemoryStore({ schemaVersion: 1, revision: 1, items: [{ id: "bad" }] });
  const queue = new ConfirmationQueue({
    store,
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });

  await assert.rejects(queue.recover(), (error) => error.code === "CONFIRMATION_STATE_CORRUPTED");
  await assert.rejects(queue.next(), (error) => error.code === "CONFIRMATION_QUEUE_NOT_READY");
});

test("plan validation bounds aggregate JSON entries and rejects accessor arrays", async () => {
  const queue = await readyQueue();
  const oversizedPayload = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => [`field-${index}`, index]),
  );

  await assert.rejects(
    queue.enqueue(
      actionPlan({
        display: {
          ...actionPlan().display,
          payload: {
            ...actionPlan().display.payload,
            oversizedPayload,
          },
        },
      }),
    ),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );

  const evidence = [];
  Object.defineProperty(evidence, "0", {
    enumerable: true,
    get() {
      throw new Error("accessor must not run");
    },
  });
  evidence.length = 1;
  await assert.rejects(
    queue.enqueue(
      actionPlan({ display: { ...actionPlan().display, evidence } }),
    ),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );
});

test("the displayed payload must contain the exact actor, target, and action", async () => {
  const queue = await readyQueue();
  const plan = actionPlan();

  await assert.rejects(
    queue.enqueue({
      ...plan,
      display: {
        ...plan.display,
        payload: {
          ...plan.display.payload,
          action: { ...plan.action, body: "A safer-looking body" },
        },
      },
    }),
    (error) => error.code === "INVALID_CONFIRMATION_REQUEST",
  );
});

test("persisted terminal outcomes and revisions must be internally coherent", async () => {
  const store = new MemoryStore();
  const queue = await readyQueue({ store });
  await queue.enqueue(actionPlan());
  const next = await queue.next();
  await queue.approve(next.item.id, approvalRequest(next));

  const wrongOutcome = structuredClone(store.value);
  wrongOutcome.items[0].execution.outcome = "unknown";
  const wrongOutcomeQueue = new ConfirmationQueue({
    store: new MemoryStore(wrongOutcome),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    wrongOutcomeQueue.recover(),
    (error) => error.code === "CONFIRMATION_STATE_CORRUPTED",
  );

  const impossibleRevision = structuredClone(store.value);
  impossibleRevision.items[0].itemRevision = impossibleRevision.revision + 1;
  const impossibleRevisionQueue = new ConfirmationQueue({
    store: new MemoryStore(impossibleRevision),
    executor: executor(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    impossibleRevisionQueue.recover(),
    (error) => error.code === "CONFIRMATION_STATE_CORRUPTED",
  );
});

test("executor receipts are whitelisted before they reach durable or public state", async () => {
  const actionExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return {
        status: "applied",
        receipt: { id: "review-42", stdout: "token=must-not-persist" },
      };
    },
  });
  const store = new MemoryStore();
  const queue = await readyQueue({ store, actionExecutor });
  await queue.enqueue(actionPlan());
  const next = await queue.next();

  const result = await queue.approve(next.item.id, approvalRequest(next));

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "EXTERNAL_PROTOCOL_ERROR");
  assert.equal(JSON.stringify(store.value).includes("must-not-persist"), false);

  const urlExecutor = executor({
    async execute(envelope) {
      this.executeCalls.push(structuredClone(envelope));
      return {
        status: "applied",
        receipt: {
          id: "review-43",
          url: "https://github.com/acme/command-center/pull/42?token=must-not-persist",
        },
      };
    },
  });
  const urlStore = new MemoryStore();
  const urlQueue = await readyQueue({ store: urlStore, actionExecutor: urlExecutor });
  await urlQueue.enqueue(actionPlan());
  const urlNext = await urlQueue.next();
  const urlResult = await urlQueue.approve(
    urlNext.item.id,
    approvalRequest(urlNext, "request-approve-0002"),
  );
  assert.equal(urlResult.status, "failed");
  assert.equal(JSON.stringify(urlStore.value).includes("must-not-persist"), false);
});
