import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDeliveryEvidenceTarget } from "../src/domain/delivery-evidence-contract.js";
import { createCiRepairEvidence } from "../src/domain/ci-repair-evidence.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  createConflictCodeExecutionSource,
  createReviewRepairCodeExecutionSource,
  createCiRepairCodeExecutionSource,
  sameCodeExecutionSource,
} from "../src/domain/code-execution-source.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { createWorkIntentDispatchBinding } from "../src/domain/work-intent-dispatch-binding.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import {
  appendPullRequestWorkSource,
  createPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
} from "../src/services/work-ledger-pr-source.js";
import { externalActionControlledCommit } from "./support/pull-request-external-action-fixture.js";

function clone(value) {
  return structuredClone(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function configurationBinding(version) {
  return {
    version,
    configurationDigest: String(version).repeat(64),
  };
}

function readyGate(version = 1) {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(configurationBinding(version));
  return gate;
}

function cutoverToVersion(gate, version) {
  return gate.cutover((control) => {
    control.commit(configurationBinding(version));
  });
}

async function settlesBefore(promise, durationMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function controlledClock(initial = "2026-08-02T04:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now).toISOString(),
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function workflowEvent(index = 1) {
  const headRefOid = (index % 10).toString(16).repeat(40);
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T03:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: `github:pr:acme/repo#${40 + index}`,
      repository: "acme/repo",
      number: 40 + index,
    },
    payload: {
      title: `Fix race ${index}`,
      headRefOid,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: `fix/race-${index}`,
        headRefOid,
      },
      gitTargetAvailable: true,
      state: "open",
      changedFields: ["headRefOid"],
    },
  });
}

function conflictWorkflowEvent(index = 1, payloadOverrides = {}) {
  const ordinary = workflowEvent(index);
  return normalizeWorkflowEvent({
    schemaVersion: ordinary.schemaVersion,
    eventType: ordinary.eventType,
    occurredAt: ordinary.occurredAt,
    source: clone(ordinary.source),
    subject: clone(ordinary.subject),
    payload: {
      ...clone(ordinary.payload),
      mergeStateStatus: "DIRTY",
      nextAction: "resolve_conflict",
      ...payloadOverrides,
    },
  });
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成可信事实核对",
    reason: "需要推进下一步",
  };
}

function askUserIntent(overrides = {}) {
  return {
    ...common("ask_user"),
    question: "是否接受新的验收口径？",
    choices: [
      { id: "accept", label: "接受", description: "继续推进" },
      { id: "revise", label: "修改", description: "先补充需求" },
    ],
    ...overrides,
  };
}

function waitIntent() {
  return {
    ...common("wait_condition"),
    condition: {
      kind: "workflow_fact",
      fact: "ci-status",
      oneOf: ["success", "failure"],
    },
    checkAfterSeconds: 60,
  };
}

function reviewIntent(overrides = {}) {
  return {
    ...common("propose_github_review"),
    verdict: "comment",
    body: "建议补一条并发回归测试。",
    evidence: ["状态更新可能丢失"],
    ...overrides,
  };
}

function pullRequestActionIntent(action, overrides = {}) {
  return {
    ...common("propose_github_pull_request_action"),
    action,
    evidence: ["trusted-task-context"],
    ...overrides,
  };
}

function codeIntent(overrides = {}) {
  return {
    ...common("propose_code_action"),
    operation: "modify",
    objective: "修复并发覆盖",
    acceptanceCriteria: ["回归测试通过"],
    evidence: ["revision 未校验"],
    ...overrides,
  };
}

function configurationChangeIntent(overrides = {}) {
  return {
    ...common("propose_configuration_change"),
    changes: [{ path: ["refreshMinutes"], value: 15 }],
    evidence: ["refresh cadence is too slow"],
    ...overrides,
  };
}

function handoffIntent() {
  return {
    ...common("handoff"),
    capability: "testing",
    brief: "执行跨平台回归",
    evidence: ["unit-tests:passed"],
  };
}

function completeIntent() {
  return {
    ...common("complete"),
    outcome: "done",
    evidence: ["验收条件全部满足"],
  };
}

function workPair(index, intent, {
  target = { type: "role", id: "pr-reviewer" },
  status = "pending",
  leaseUntil = null,
} = {}) {
  const inputDigest = String((index % 9) + 1).repeat(64);
  const itemId = `work-item-${String.fromCharCode(96 + index).repeat(64)}`;
  const intentId = `work-intent-${"abcdef0123456789"[index % 16].repeat(64)}`;
  const item = {
    itemId,
    kind: "assignment",
    assignmentId: `workflow-assignment-${index}`,
    sourceSequence: index,
    inputDigest,
    assignment: {
      assignmentId: `workflow-assignment-${index}`,
      target: clone(target),
    },
    event: workflowEvent(index),
    currentTarget: clone(target),
    activeIntentId: intentId,
    decisionContext: null,
    status: "dispatch_pending",
    revision: 3,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    attempt: 1,
    availableAt: null,
    statusReason: "intent_staged",
    createdAt: "2026-08-02T03:00:00.000Z",
    updatedAt: "2026-08-02T03:01:00.000Z",
  };
  item.source = createPullRequestWorkSource(
    prSourceEnvelope(
      index,
      item.event,
      item.assignmentId,
    ),
  ).source;
  const outbox = {
    intentId,
    intentDigest: intentId.slice("work-intent-".length),
    itemId,
    inputDigest,
    requestedBy: {
      roleId: target.type === "role" ? target.id : "orchestrator",
      workerId: target.type === "role"
        ? `employee-${target.id}`
        : "employee-orchestrator",
    },
    intent: clone(intent),
    dispatchBinding: null,
    status,
    revision: status === "dispatching" ? 2 : 1,
    attempt: status === "dispatching" ? 1 : 0,
    dispatcherId: status === "dispatching" ? "other-dispatcher" : null,
    dispatchLeaseId: status === "dispatching" ? `dispatch-lease-${index}` : null,
    dispatchLeaseUntil: status === "dispatching" ? leaseUntil : null,
    outcome: null,
    createdAt: new Date(Date.parse("2026-08-02T03:10:00.000Z") + index).toISOString(),
    updatedAt: "2026-08-02T03:10:00.000Z",
  };
  return { item, outbox };
}

function conflictWorkPair(index = 1, intent = codeIntent(), payloadOverrides = {}) {
  const pair = workPair(index, intent, {
    target: { type: "role", id: "developer" },
  });
  pair.item.event = conflictWorkflowEvent(index, payloadOverrides);
  pair.item.source = createPullRequestWorkSource(
    prSourceEnvelope(index, pair.item.event, pair.item.assignmentId),
  ).source;
  return pair;
}

function conflictExecutionSource(inputBinding, seed = "1") {
  const gitTarget = inputBinding.gitTarget;
  const preparationBinding = createConflictPreparationBinding({
    preparation: {
      schemaVersion: 1,
      preparationId: seed.repeat(64),
      status: "conflicted",
      baseCommitOid: gitTarget.baseRefOid,
      headCommitOid: gitTarget.headRefOid,
      mergeBaseOid: "e".repeat(40),
      resultTreeOid: "f".repeat(40),
      conflicts: [{ path: "src/value.js", mode: "100644" }],
      boundaryDigest: "2".repeat(64),
      evidenceDigest: "3".repeat(64),
      resultObjectDigest: "4".repeat(64),
      materialization: "full-tree",
    },
    gitTarget,
  });
  return createConflictCodeExecutionSource({
    inputBinding,
    preparationBinding,
  });
}

function controlledEvidenceForPair(pair) {
  return externalActionControlledCommit(
    createPullRequestExecutionBinding({
      sourceBinding: currentWorkItemInputBinding(pair.item),
      event: currentWorkItemEvent(pair.item),
    }),
  );
}

function prSourceEnvelope(
  sequence,
  event,
  assignmentId,
  targetRoleId = "pr-engineer",
) {
  return {
    sequence,
    assignment: {
      assignmentId,
      eventId: event.eventId,
      target: { type: "role", id: targetRoleId },
    },
    event,
  };
}

class FakeLedger {
  constructor(pairs, clock) {
    this.items = pairs.map(({ item }) => clone(item));
    this.outbox = pairs.map(({ outbox }) => clone(outbox));
    this.clock = clock;
    this.claimCalls = [];
    this.bindCalls = [];
    this.ackCalls = [];
    this.nextLease = 1;
    this.failAckBeforeOnce = false;
    this.failAckAfterOnce = false;
    this.failBindAfterOnce = false;
    this.verifyInputAuthority = async (binding) => clone(binding);
    this.verifyDispatchAuthority = async () => true;
  }

  async verifyPullRequestExecutionBinding(binding) {
    return this.verifyInputAuthority(binding);
  }

  async isIntentDispatchCurrent(input) {
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    const item = this.items.find(({ itemId }) => itemId === input.itemId);
    return this.verifyDispatchAuthority(clone(input), entry, item);
  }

  async listOutbox(options) {
    return this.#page(
      this.outbox.filter(({ status }) => status === options.status),
      "intentId",
      options,
    );
  }

  async listItems(options) {
    return this.#page(this.items, "itemId", options);
  }

  async claimIntent(input) {
    this.claimCalls.push(clone(input));
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    if (!entry || entry.revision !== input.expectedRevision) {
      throw Object.assign(new Error("revision changed"), {
        code: "WORK_LEDGER_INTENT_REVISION_CONFLICT",
      });
    }
    const expired =
      entry.status === "dispatching" &&
      Date.parse(entry.dispatchLeaseUntil) <= this.clock.now();
    if (entry.status === "dispatching" && !expired) {
      throw Object.assign(new Error("active"), {
        code: "WORK_LEDGER_INTENT_LEASE_ACTIVE",
      });
    }
    if (!new Set(["pending", "dispatching"]).has(entry.status)) {
      throw Object.assign(new Error("terminal"), {
        code: "WORK_LEDGER_INTENT_STATUS_CONFLICT",
      });
    }
    entry.status = "dispatching";
    entry.revision += 1;
    entry.attempt += 1;
    entry.dispatcherId = input.dispatcherId;
    entry.dispatchLeaseId = `dispatcher-lease-${this.nextLease++}`;
    entry.dispatchLeaseUntil = new Date(
      this.clock.now() + input.leaseDurationMs,
    ).toISOString();
    entry.updatedAt = this.clock.clock();
    return clone(entry);
  }

  async bindIntent(input) {
    this.bindCalls.push(clone(input));
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    if (
      !entry ||
      entry.status !== "dispatching" ||
      entry.revision !== input.expectedRevision ||
      entry.dispatcherId !== input.dispatcherId ||
      entry.dispatchLeaseId !== input.dispatchLeaseId
    ) {
      throw Object.assign(new Error("binding fenced"), {
        code: "WORK_LEDGER_INTENT_LEASE_CONFLICT",
      });
    }
    entry.dispatchBinding = createWorkIntentDispatchBinding(input.boundIntent);
    entry.revision += 1;
    entry.updatedAt = this.clock.clock();
    if (this.failBindAfterOnce) {
      this.failBindAfterOnce = false;
      throw new Error("binding response lost");
    }
    return clone(entry);
  }

  async ackIntent(input) {
    this.ackCalls.push(clone(input));
    if (this.failAckBeforeOnce) {
      this.failAckBeforeOnce = false;
      throw new Error("ack write unavailable");
    }
    const entry = this.outbox.find(({ intentId }) => intentId === input.intentId);
    const item = this.items.find(({ itemId }) => itemId === entry.itemId);
    if (
      entry.status !== "dispatching" ||
      entry.revision !== input.expectedRevision ||
      entry.dispatchLeaseId !== input.dispatchLeaseId ||
      item.revision !== input.itemExpectedRevision
    ) {
      throw Object.assign(new Error("ack fenced"), {
        code: "WORK_LEDGER_INTENT_LEASE_CONFLICT",
      });
    }
    entry.status = input.outcome;
    entry.revision += 1;
    entry.dispatcherId = null;
    entry.dispatchLeaseId = null;
    entry.dispatchLeaseUntil = null;
    entry.outcome = { status: input.outcome, details: clone(input.details) };
    item.status = input.nextStatus;
    item.revision += 1;
    item.currentTarget = input.target ? clone(input.target) : item.currentTarget;
    item.availableAt = input.availableAt ?? null;
    item.updatedAt = this.clock.clock();
    if (this.failAckAfterOnce) {
      this.failAckAfterOnce = false;
      throw new Error("ack response lost");
    }
    return { item: clone(item), outbox: clone(entry) };
  }

  #page(records, idName, options) {
    const start = options.cursor
      ? records.findIndex((record) => record[idName] === options.cursor) + 1
      : 0;
    const items = records.slice(start, start + options.limit).map(clone);
    return {
      items,
      nextCursor:
        start + items.length < records.length && items.length
          ? items.at(-1)[idName]
          : null,
    };
  }
}

class BlockingClaimLedger extends FakeLedger {
  constructor(pairs, clock) {
    super(pairs, clock);
    this.claimStarted = deferred();
    this.claimRelease = deferred();
  }

  async claimIntent(input) {
    this.claimStarted.resolve();
    await this.claimRelease.promise;
    return super.claimIntent(input);
  }
}

class BlockingBindLedger extends FakeLedger {
  constructor(pairs, clock) {
    super(pairs, clock);
    this.bindStarted = deferred();
    this.bindRelease = deferred();
  }

  async bindIntent(input) {
    this.bindStarted.resolve();
    await this.bindRelease.promise;
    return super.bindIntent(input);
  }
}

class FakeAttentionProducer {
  constructor() {
    this.calls = [];
    this.records = new Map();
    this.error = null;
    this.failAfterCreateOnce = false;
  }

  async create(request) {
    this.calls.push(clone(request));
    if (this.error) throw this.error;
    const key = JSON.stringify({
      requestKey: request.requestKey,
      producer: request.producer,
    });
    const content = JSON.stringify(request);
    const existing = this.records.get(key);
    if (existing && existing.content !== content) {
      throw Object.assign(new Error("different content"), {
        code: "ATTENTION_REQUEST_CONFLICT",
      });
    }
    const receipt = existing?.receipt ?? {
      requestId: `attention-${createHash("sha256").update(content).digest("hex")}`,
      status: "pending",
    };
    this.records.set(key, { content, receipt });
    if (this.failAfterCreateOnce) {
      this.failAfterCreateOnce = false;
      throw new Error("attention response lost");
    }
    return clone(receipt);
  }
}

class BlockingAttentionProducer extends FakeAttentionProducer {
  constructor() {
    super();
    this.createStarted = deferred();
    this.createRelease = deferred();
  }

  async create(request) {
    this.createStarted.resolve();
    await this.createRelease.promise;
    return super.create(request);
  }
}

class FakeProposalProducer {
  constructor() {
    this.calls = [];
    this.records = new Map();
    this.error = null;
    this.failAfterCreateOnce = false;
  }

  async create(value) {
    const proposal = normalizeBoundWorkProposal(value);
    this.calls.push(clone(proposal));
    if (this.error) throw this.error;
    const existing = this.records.get(proposal.proposalId);
    if (existing && existing.contentDigest !== proposal.contentDigest) {
      throw Object.assign(new Error("different proposal"), {
        code: "WORK_PROPOSAL_ID_CONFLICT",
      });
    }
    const receipt = existing ?? {
      proposalId: proposal.proposalId,
      contentDigest: proposal.contentDigest,
      kind: proposal.kind,
      status: "pending_delivery",
      revision: 1,
      createdAt: "2026-08-02T04:00:00.000Z",
    };
    this.records.set(proposal.proposalId, receipt);
    if (this.failAfterCreateOnce) {
      this.failAfterCreateOnce = false;
      throw new Error("proposal response lost");
    }
    return clone(receipt);
  }
}

function policy(overrides = {}) {
  return createWorkIntentPolicy({
    version: 4,
    capabilityRoles: {
      coordination: "orchestrator",
      requirements: "requirements-analyst",
      "pr-review": "pr-reviewer",
      development: "developer",
      testing: "trusted-tester",
    },
    githubReviewRoles: ["pr-reviewer"],
    codeActionRoles: ["developer"],
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    ...overrides,
  });
}

function fixture(pairs, options = {}) {
  const time = options.time ?? controlledClock();
  const ledger = options.ledger ?? new FakeLedger(pairs, time);
  const attention = options.attention ?? new FakeAttentionProducer();
  const proposals = options.proposals ?? new FakeProposalProducer();
  const dispatcher = new WorkIntentDispatcher({
    ledger,
    policy: options.policy ?? policy(),
    attentionProducer: attention,
    proposalProducer: proposals,
      conflictExecutionSourcePreparer:
        options.conflictExecutionSourcePreparer,
      reviewRepairSourcePreparer: options.reviewRepairSourcePreparer,
    controlledCommitEvidenceReader:
      options.controlledCommitEvidenceReader,
    actionAdmissionGate: options.actionAdmissionGate,
    clock: time.clock,
    leaseDurationMs: options.leaseDurationMs ?? 1_000,
    retryDelayMs: options.retryDelayMs ?? 60_000,
  });
  return { dispatcher, ledger, attention, proposals, time };
}

function attachChildContract(pair, acceptanceContract) {
  pair.item.graph = {
    parentItemId: "work-item-orchestrator-root",
    dependsOnItemIds: [],
    acceptanceContracts: [{
      ...acceptanceContract,
      expectedDeliverables: acceptanceContract.expectedDeliverables.map(
        (deliverable) => ({ ...deliverable, dataClass: "code" }),
      ),
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
}

test("ask_user is content-addressed in the internal inbox before waiting_user acknowledgement", async () => {
  const pair = workPair(1, askUserIntent({ reason: "依据".repeat(600) }));
  const { dispatcher, ledger, attention } = fixture([pair]);

  const result = await dispatcher.dispatchPending({ limit: 10 });

  assert.deepEqual(
    {
      scanned: result.scanned,
      claimed: result.claimed,
      delivered: result.delivered,
      blocked: result.blocked,
      retryWait: result.retryWait,
      uncertain: result.uncertain,
      skipped: result.skipped,
    },
    {
      scanned: 1,
      claimed: 1,
      delivered: 1,
      blocked: 0,
      retryWait: 0,
      uncertain: 0,
      skipped: 0,
    },
  );
  assert.equal(attention.calls.length, 1);
  const request = attention.calls[0];
  assert.equal(request.requestKey, pair.outbox.intentId);
  assert.deepEqual(request.producer, {
    roleId: "pr-reviewer",
    workItemId: pair.item.itemId,
  });
  assert.equal(request.context.every(({ value }) => typeof value === "string"), true);
  assert.equal(
    request.context.every(({ value }) => Buffer.byteLength(value, "utf8") <= 2_048),
    true,
  );
  assert.equal(ledger.ackCalls[0].nextStatus, "waiting_user");
  assert.match(ledger.ackCalls[0].details.questionRef, /^attention-[a-f0-9]{64}$/);
  assert.match(ledger.ackCalls[0].details.downstreamRef, WORK_INTENT_REF);
});

test("a lifecycle cutover after binding prevents downstream attention creation", async () => {
  const pair = workPair(1, askUserIntent());
  const { dispatcher, ledger, attention } = fixture([pair]);
  ledger.verifyDispatchAuthority = async (_input, _entry, item) => {
    item.status = "cancelled";
    item.activeIntentId = null;
    item.revision += 1;
    return false;
  };

  const result = await dispatcher.dispatchPending({ limit: 10 });

  assert.equal(result.claimed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].code, "dispatch-authority-stale");
  assert.equal(ledger.bindCalls.length, 1);
  assert.equal(attention.calls.length, 0);
  assert.equal(ledger.ackCalls.length, 0);
});

const WORK_INTENT_REF = /^work-intent-[a-f0-9]{64}$/;

for (const sealed of [false, true]) {
  test(`incomplete local completion returns for delivery and cannot poison later intents (sealed ${sealed})`, async () => {
    const pair = workPair(2, completeIntent());
    const other = workPair(3, askUserIntent());
    const { dispatcher, ledger, time } = fixture([pair, other]);
    if (sealed) {
      ledger.failAckBeforeOnce = true;
      assert.equal((await dispatcher.dispatchPending({ limit: 1 })).uncertain, 1);
      assert.notEqual(ledger.outbox[0].dispatchBinding, null);
      time.advance(1_001);
    }
    const ack = ledger.ackIntent.bind(ledger);
    ledger.ackIntent = (input) => {
      if (input.nextStatus === "completed") throw Object.assign(new Error("Missing required report"), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
      return ack(input);
    };
    const recovered = fixture([], { ledger, time }).dispatcher;
    const result = await recovered.dispatchPending();
    assert.equal(result.retryWait, 1);
    assert.equal(result.uncertain, 0);
    assert.equal(result.delivered, 1);
    assert.equal(ledger.outbox[0].status, "failed");
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.ackCalls.find(call => call.nextStatus === "retry_wait").details.code, "completion-delivery-required");
  });
}

test("internal outcomes and durable proposals map to explicit ledger states", async (t) => {
  const cases = [
    { name: "wait", intent: waitIntent(), role: "pr-reviewer", next: "waiting_condition" },
    { name: "complete", intent: completeIntent(), role: "pr-reviewer", next: "completed" },
    { name: "github", intent: reviewIntent(), role: "pr-reviewer", next: "waiting_external" },
    { name: "code", intent: codeIntent(), role: "developer", next: "waiting_external" },
    {
      name: "configuration",
      intent: configurationChangeIntent({
        dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
      }),
      role: "developer",
      next: "waiting_external",
      policy: policy({ configurationChangeRoles: ["developer"] }),
    },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const pair = workPair(index + 2, entry.intent, {
        target: { type: "role", id: entry.role },
      });
      const { dispatcher, ledger, attention, proposals } = fixture([pair], {
        ...(entry.policy === undefined ? {} : { policy: entry.policy }),
      });
      const result = await dispatcher.dispatchPending();

      assert.equal(result.delivered, 1);
      assert.equal(ledger.items[0].status, entry.next);
      assert.match(ledger.ackCalls[0].details.downstreamRef ?? ledger.ackCalls[0].details.resultRef, WORK_INTENT_REF);
      assert.equal(attention.calls.length, 0);
      if (["github", "code", "configuration"].includes(entry.name)) {
        assert.equal(proposals.calls.length, 1);
        assert.equal(
          ledger.ackCalls[0].details.proposalDigest,
          proposals.calls[0].contentDigest,
        );
        if (entry.name === "configuration") {
          assert.equal(
            proposals.calls[0].kind,
            "configuration_change_proposal",
          );
          assert.deepEqual(Object.keys(proposals.calls[0].binding).sort(), [
            "dispatchIntentId",
            "eventId",
            "subject",
          ]);
        }
      } else {
        assert.equal(proposals.calls.length, 0);
      }
      assert.equal(Object.hasOwn(ledger.ackCalls[0], "command"), false);
      assert.equal(Object.hasOwn(ledger.ackCalls[0], "accountId"), false);
    });
  }
});

test("revoked PR authority after sealing prevents downstream proposal creation", async () => {
  const pair = workPair(9, reviewIntent());
  const { dispatcher, ledger, proposals } = fixture([pair]);
  ledger.verifyInputAuthority = async () => {
    throw Object.assign(new Error("scope authority revoked"), {
      code: "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    });
  };

  const result = await dispatcher.dispatchPending();

  assert.equal(ledger.bindCalls.length, 1);
  assert.equal(proposals.calls.length, 0);
  assert.equal(result.blocked, 1);
  assert.equal(
    ledger.ackCalls[0].details.code,
    "proposal-input-authority-stale",
  );
});

test("trusted PR role decisions produce five durable external action proposals", async (t) => {
  const actionFactories = [
    () => ({ type: "comment", body: "请补充失败日志。" }),
    () => ({ type: "review", verdict: "comment", body: "建议补充并发测试。" }),
    () => ({ type: "update_branch" }),
    (evidence) => ({
      type: "push",
      controlledCommitEvidenceId: evidence.evidenceId,
    }),
    () => ({ type: "merge", method: "squash" }),
  ];
  for (const [offset, createAction] of actionFactories.entries()) {
    await t.test(["comment", "review", "update", "push", "merge"][offset], async () => {
      const pair = workPair(
        10 + offset,
        pullRequestActionIntent({ type: "update_branch" }),
      );
      const evidence = controlledEvidenceForPair(pair);
      const requestedAction = createAction(evidence);
      pair.outbox.intent = pullRequestActionIntent(requestedAction);
      const reads = [];
      const { dispatcher, ledger, proposals } = fixture([pair], {
        controlledCommitEvidenceReader: {
          async verify(input) {
            reads.push(clone(input));
            return clone(evidence);
          },
        },
      });

      const result = await dispatcher.dispatchPending();

      assert.equal(result.delivered, 1);
      assert.equal(ledger.items[0].status, "waiting_external");
      assert.equal(proposals.calls.length, 1);
      assert.equal(
        proposals.calls[0].kind,
        "github_pull_request_action_proposal",
      );
      assert.equal(proposals.calls[0].payload.action.type, requestedAction.type);
      assert.equal(
        proposals.calls[0].binding.inputBinding.schemaVersion,
        2,
      );
      if (requestedAction.type === "push") {
        assert.deepEqual(reads, [{ evidenceId: evidence.evidenceId }]);
        assert.equal(
          proposals.calls[0].payload.action.controlledCommitEvidence.evidenceId,
          evidence.evidenceId,
        );
      } else {
        assert.equal(reads.length, 0);
        assert.deepEqual(proposals.calls[0].payload.action, requestedAction);
      }
    });
  }
});

test("push proposal fails closed before proposal creation without trusted evidence", async (t) => {
  await t.test("reader missing", async () => {
    const pair = workPair(15, pullRequestActionIntent({
      type: "push",
      controlledCommitEvidenceId: `controlled-git-commit-${"a".repeat(64)}`,
    }));
    const { dispatcher, ledger, proposals } = fixture([pair]);
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(
      ledger.ackCalls[0].details.code,
      "controlled-commit-evidence-reader-not-configured",
    );
    assert.equal(proposals.calls.length, 0);
  });

  await t.test("reader returns evidence for another PR", async () => {
    const pair = workPair(16, pullRequestActionIntent({
      type: "push",
      controlledCommitEvidenceId: `controlled-git-commit-${"a".repeat(64)}`,
    }));
    const foreignPair = workPair(17, reviewIntent());
    const foreignEvidence = controlledEvidenceForPair(foreignPair);
    pair.outbox.intent = pullRequestActionIntent({
      type: "push",
      controlledCommitEvidenceId: foreignEvidence.evidenceId,
    });
    const { dispatcher, ledger, proposals } = fixture([pair], {
      controlledCommitEvidenceReader: {
        async verify() { return clone(foreignEvidence); },
      },
    });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(
      ledger.ackCalls[0].details.code,
      "controlled-commit-evidence-invalid",
    );
    assert.equal(proposals.calls.length, 0);
  });

  await t.test("reader temporarily unavailable", async () => {
    const pair = workPair(18, pullRequestActionIntent({
      type: "push",
      controlledCommitEvidenceId: `controlled-git-commit-${"a".repeat(64)}`,
    }));
    const { dispatcher, ledger, proposals } = fixture([pair], {
      controlledCommitEvidenceReader: {
        async verify() { throw new Error("store busy"); },
      },
    });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.retryWait, 1);
    assert.equal(
      ledger.ackCalls[0].details.code,
      "controlled-commit-evidence-temporarily-unavailable",
    );
    assert.equal(proposals.calls.length, 0);
  });
});

test("a restarted push dispatch reuses the sealed binding without rereading evidence", async () => {
  const pair = workPair(19, pullRequestActionIntent({ type: "update_branch" }));
  const evidence = controlledEvidenceForPair(pair);
  pair.outbox.intent = pullRequestActionIntent({
    type: "push",
    controlledCommitEvidenceId: evidence.evidenceId,
  });
  const time = controlledClock();
  const proposals = new FakeProposalProducer();
  proposals.failAfterCreateOnce = true;
  let reads = 0;
  const first = fixture([pair], {
    time,
    proposals,
    controlledCommitEvidenceReader: {
      async verify() { reads += 1; return clone(evidence); },
    },
  });

  const uncertain = await first.dispatcher.dispatchPending();
  assert.equal(uncertain.uncertain, 1);
  assert.equal(reads, 1);
  assert.notEqual(first.ledger.outbox[0].dispatchBinding, null);

  time.advance(1_000);
  const restarted = fixture([], {
    time,
    ledger: first.ledger,
    proposals,
    controlledCommitEvidenceReader: {
      async verify() { throw new Error("must not reread sealed evidence"); },
    },
  });
  const recovered = await restarted.dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(reads, 1);
  assert.equal(first.ledger.items[0].status, "waiting_external");
});

test("proposal evidence authority is derived from the trusted graph contract", async () => {
  const pair = workPair(6, codeIntent(), {
    target: { type: "role", id: "developer" },
  });
  const acceptanceContract = {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "verified", description: "变更包由可信执行器生成" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "受控代码变更包",
        required: true,
      },
    ],
  };
  pair.item.graph = {
    parentItemId: "work-item-orchestrator-root",
    dependsOnItemIds: [],
    acceptanceContracts: [{
      ...acceptanceContract,
      expectedDeliverables: acceptanceContract.expectedDeliverables.map(
        (deliverable) => ({ ...deliverable, dataClass: "code" }),
      ),
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
  const { dispatcher, ledger, proposals } = fixture([pair]);

  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  const expected = createDeliveryEvidenceTarget({
    taskId: pair.item.itemId,
    roleId: "developer",
    acceptanceContract,
  });
  assert.deepEqual(proposals.calls[0].binding.evidenceTarget, expected);
  assert.deepEqual(
    ledger.bindCalls[0].boundIntent.binding.evidenceTarget,
    expected,
  );
});

test("proposal authority auto-selects the sole action-compatible deliverable", async () => {
  const pair = workPair(6, codeIntent({ operation: "verify" }), {
    target: { type: "role", id: "developer" },
  });
  attachChildContract(pair, {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "verified", description: "变更和验证均有权威证据" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "受控代码变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "受控测试报告",
        required: true,
      },
    ],
  });
  const { dispatcher, proposals } = fixture([pair]);

  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.deepEqual(proposals.calls[0].binding.evidenceTarget.deliverables, [
    { deliverableId: "verification", kind: "test-report" },
  ]);
});

test("incompatible verification contract reports a precise unstarted failure without invoking policy or producer", async () => {
  const pair = workPair(6, codeIntent({ operation: "verify" }), { target: { type: "role", id: "developer" } });
  attachChildContract(pair, { revision: 1, acceptanceCriteria: [], expectedDeliverables: [
    { deliverableId: "ci-fix-package", kind: "change-package", description: "保留原修复包", required: true },
  ] });
  const { dispatcher, ledger, proposals } = fixture([pair]);
  const result = await dispatcher.dispatchPending();
  assert.equal(result.blocked, 1);
  assert.equal(result.items[0].code, "delivery-evidence-incompatible");
  assert.equal(ledger.ackCalls[0].details.code, "delivery-evidence-incompatible");
  assert.equal(proposals.calls.length, 0);
  assert.equal(ledger.bindCalls.length, 0);
});

test("a contracted PR child can inspect without claiming its final delivery", async () => {
  const pair = workPair(6, codeIntent({ operation: "inspect" }), {
    target: { type: "role", id: "developer" },
  });
  const sourceBinding = {
    ...currentWorkItemInputBinding(pair.item),
    rootItemId: "work-item-orchestrator-root",
  };
  pair.item.kind = "graph_task";
  pair.item.source = null;
  pair.item.assignment.graphTask = { sourceBinding };
  const acceptanceContract = {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "verified", description: "检查后提供权威验证证据" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "必要修改的受控变更包",
        required: false,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "受控测试报告",
        required: true,
      },
    ],
  };
  attachChildContract(pair, acceptanceContract);
  const originalGraph = clone(pair.item.graph);
  const { dispatcher, ledger, proposals } = fixture([pair]);

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(result.blocked, 0);
  assert.equal(proposals.calls.length, 1);
  const proposal = proposals.calls[0];
  assert.equal(proposal.payload.operation, "inspect");
  assert.deepEqual(
    proposal.binding.inputBinding,
    createPullRequestExecutionBinding({ sourceBinding, event: pair.item.event }),
  );
  assert.equal(Object.hasOwn(proposal.binding, "evidenceTarget"), false);
  assert.equal(
    Object.hasOwn(ledger.bindCalls[0].boundIntent.binding, "evidenceTarget"),
    false,
  );
  assert.equal(ledger.items[0].status, "waiting_external");
  assert.deepEqual(ledger.items[0].graph, originalGraph);
});

test("a structured role decision reaches dispatcher action-compatible selection", async () => {
  const acceptanceContract = {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "verified", description: "变更和验证均有权威证据" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "受控代码变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "受控测试报告",
        required: true,
      },
    ],
  };
  const response = {
    schemaVersion: 1,
    confidence: 91,
    summary: "运行交付验证",
    intent: codeIntent({ operation: "verify" }),
  };
  const engine = new RoleDecisionEngine({
    definition: {
      id: "developer",
      name: "Developer",
      mission: "Produce verified changes",
      enabled: true,
    },
    permissions: { allowedIntents: ["propose_code_action"] },
    brain: {
      provider: "local-brain",
      model: "role-model",
      remoteData: { requirements: false, code: false, memory: false },
    },
    brainRouter: {
      async generate() {
        return JSON.stringify(response);
      },
      describe() {
        return {
          provider: "local-brain",
          model: "role-model",
          remote: false,
          remoteData: { requirements: false, code: false, memory: false },
        };
      },
    },
  });
  const decision = await engine.decide({
    context: {
      requirements: { acceptanceContract },
      code: { authoritativeEvidence: [] },
    },
  });
  assert.equal(Object.hasOwn(decision.intent, "deliverableId"), false);
  const pair = workPair(6, decision.intent, {
    target: { type: "role", id: "developer" },
  });
  attachChildContract(pair, acceptanceContract);
  const { dispatcher, proposals } = fixture([pair]);

  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.deepEqual(proposals.calls[0].binding.evidenceTarget.deliverables, [
    { deliverableId: "verification", kind: "test-report" },
  ]);
});

test("proposal enqueue rejects action-incompatible authoritative delivery", async (t) => {
  const acceptanceContract = {
    revision: 4,
    acceptanceCriteria: [
      { criterionId: "bound", description: "动作必须生成所选交付物" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "受控代码变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "受控测试报告",
        required: true,
      },
      {
        deliverableId: "review",
        kind: "review-report",
        description: "已发布评审",
        required: true,
      },
    ],
  };
  const cases = [
    {
      name: "modify cannot target test-report",
      roleId: "developer",
      intent: codeIntent({ deliverableId: "verification" }),
    },
    {
      name: "verify cannot target change-package",
      roleId: "developer",
      intent: codeIntent({
        operation: "verify",
        deliverableId: "implementation",
      }),
    },
    {
      name: "review cannot target change-package",
      roleId: "pr-reviewer",
      intent: reviewIntent({ deliverableId: "implementation" }),
    },
    {
      name: "inspect cannot create authoritative evidence",
      roleId: "developer",
      intent: codeIntent({ operation: "inspect", deliverableId: "verification" }),
    },
    {
      name: "contracted inspect without a PR binding retains its existing rejection",
      roleId: "developer",
      intent: codeIntent({ operation: "inspect" }),
      withoutPrSource: true,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const pair = workPair(6 + index, entry.intent, {
        target: { type: "role", id: entry.roleId },
      });
      attachChildContract(pair, acceptanceContract);
      if (entry.withoutPrSource) {
        pair.item.kind = "graph_task";
        pair.item.source = null;
        pair.item.assignment.graphTask = { sourceBinding: null };
      }
      const { dispatcher, ledger, proposals } = fixture([pair]);

      const result = await dispatcher.dispatchPending();

      assert.equal(result.blocked, 1);
      assert.equal(result.items[0].code, "policy-binding-invalid");
      assert.equal(ledger.ackCalls[0].details.code, "policy-binding-invalid");
      assert.equal(proposals.calls.length, 0);
    });
  }
});

test("duplicate-kind deliverables bind only the explicitly selected authority", async () => {
  const dispatchIntentId = `work-dispatch-intent-${"a".repeat(64)}`;
  const pair = workPair(
    7,
    codeIntent({ deliverableId: "verification", dispatchIntentId }),
    { target: { type: "role", id: "developer" } },
  );
  const acceptanceContract = {
    revision: 5,
    acceptanceCriteria: [
      { criterionId: "verified", description: "两个交付物均来自受控执行器" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "实现变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "change-package",
        description: "验证变更包",
        required: true,
      },
    ],
  };
  pair.item.graph = {
    parentItemId: "work-item-orchestrator-root",
    dependsOnItemIds: [],
    acceptanceContracts: [{
      ...acceptanceContract,
      expectedDeliverables: acceptanceContract.expectedDeliverables.map(
        (deliverable) => ({ ...deliverable, dataClass: "code" }),
      ),
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
  const { dispatcher, ledger, proposals } = fixture([pair]);

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.deepEqual(proposals.calls[0].binding.evidenceTarget.deliverables, [
    { deliverableId: "verification", kind: "change-package" },
  ]);
  assert.equal(
    proposals.calls[0].binding.dispatchIntentId,
    dispatchIntentId,
  );
  assert.equal(
    ledger.bindCalls[0].boundIntent.binding.dispatchIntentId,
    dispatchIntentId,
  );
});

test("multi-deliverable authority without a selector blocks before proposal creation", async () => {
  const pair = workPair(8, codeIntent(), {
    target: { type: "role", id: "developer" },
  });
  pair.item.graph = {
    parentItemId: "work-item-orchestrator-root",
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 2,
      acceptanceCriteria: [
        { criterionId: "verified", description: "交付物可独立验证" },
      ],
      expectedDeliverables: [
        {
          deliverableId: "implementation",
          kind: "change-package",
          description: "实现变更包",
          required: true,
          dataClass: "code",
        },
        {
          deliverableId: "verification",
          kind: "change-package",
          description: "验证变更包",
          required: true,
          dataClass: "code",
        },
      ],
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
  const { dispatcher, ledger, proposals } = fixture([pair]);

  const result = await dispatcher.dispatchPending();

  assert.equal(result.blocked, 1);
  assert.equal(result.items[0].code, "policy-binding-invalid");
  assert.equal(ledger.ackCalls[0].details.code, "policy-binding-invalid");
  assert.equal(proposals.calls.length, 0);
});

test("an unknown explicit deliverable blocks authoritative proposal binding", async () => {
  const pair = workPair(9, reviewIntent({ deliverableId: "missing-review" }), {
    target: { type: "role", id: "pr-reviewer" },
  });
  pair.item.graph = {
    parentItemId: "work-item-orchestrator-root",
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [
        { criterionId: "reviewed", description: "Review 可复核" },
      ],
      expectedDeliverables: [{
        deliverableId: "review",
        kind: "review-report",
        description: "Review 报告",
        required: true,
        dataClass: "code",
      }],
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
  const { dispatcher, ledger, proposals } = fixture([pair]);

  const result = await dispatcher.dispatchPending();

  assert.equal(result.blocked, 1);
  assert.equal(ledger.ackCalls[0].details.code, "policy-binding-invalid");
  assert.equal(proposals.calls.length, 0);
});

test("a direct-root proposal remains non-authoritative without an acceptance path", async () => {
  const dispatchIntentId = `work-dispatch-intent-${"b".repeat(64)}`;
  const pair = workPair(7, codeIntent({
    deliverableId: "implementation",
    dispatchIntentId,
  }), {
    target: { type: "role", id: "developer" },
  });
  pair.item.graph = {
    parentItemId: null,
    dependsOnItemIds: [],
    acceptanceContracts: [{
      revision: 1,
      acceptanceCriteria: [
        { criterionId: "verified", description: "变更包已验证" },
      ],
      expectedDeliverables: [{
        deliverableId: "implementation",
        kind: "change-package",
        description: "代码变更包",
        required: true,
        dataClass: "code",
      }],
      recordedAt: pair.item.createdAt,
    }],
    deliveries: [],
  };
  const { dispatcher, ledger, proposals } = fixture([pair]);

  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(proposals.calls.length, 1);
  assert.equal(
    Object.hasOwn(proposals.calls[0].binding, "evidenceTarget"),
    false,
  );
  assert.equal(proposals.calls[0].binding.dispatchIntentId, dispatchIntentId);
  assert.equal(ledger.items[0].status, "waiting_external");
});

test("active dispatcher leases are skipped while an exactly expired lease is reclaimed", async () => {
  const time = controlledClock();
  const active = workPair(6, waitIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now() + 1).toISOString(),
  });
  const expired = workPair(7, waitIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now()).toISOString(),
  });
  const { dispatcher, ledger } = fixture([active, expired], { time });

  const result = await dispatcher.dispatchPending({ limit: 10 });

  assert.equal(result.scanned, 1);
  assert.equal(result.delivered, 1);
  assert.deepEqual(
    ledger.claimCalls.map(({ intentId }) => intentId),
    [expired.outbox.intentId],
  );
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(ledger.outbox[1].status, "delivered");
});

test("an idempotent attention create survives a lost ack and replays after lease expiry", async () => {
  const pair = workPair(8, askUserIntent());
  const { dispatcher, ledger, attention, time } = fixture([pair]);
  ledger.failAckBeforeOnce = true;

  const first = await dispatcher.dispatchPending();
  assert.equal(first.uncertain, 1);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(attention.records.size, 1);

  const active = await dispatcher.dispatchPending();
  assert.equal(active.scanned, 0);
  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();

  assert.equal(recovered.delivered, 1);
  assert.equal(attention.calls.length, 2);
  assert.equal(attention.records.size, 1);
  assert.deepEqual(attention.calls[1], attention.calls[0]);
  assert.equal(ledger.outbox[0].status, "delivered");
  assert.equal(ledger.items[0].status, "waiting_user");
});

test("unknown attention side effects stay dispatching until idempotent lease recovery", async () => {
  const pair = workPair(9, askUserIntent());
  const { dispatcher, ledger, attention, time } = fixture([pair]);
  attention.failAfterCreateOnce = true;

  const uncertain = await dispatcher.dispatchPending();

  assert.equal(uncertain.uncertain, 1);
  assert.equal(ledger.ackCalls.length, 0);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(attention.records.size, 1);

  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(attention.records.size, 1);
  assert.equal(ledger.ackCalls.length, 1);
});

test("an idempotent proposal survives a lost response and is acknowledged after lease recovery", async () => {
  const pair = workPair(10, codeIntent(), {
    target: { type: "role", id: "developer" },
  });
  const proposals = new FakeProposalProducer();
  proposals.failAfterCreateOnce = true;
  const { dispatcher, ledger, time } = fixture([pair], { proposals });

  const uncertain = await dispatcher.dispatchPending();
  assert.equal(uncertain.uncertain, 1);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(proposals.records.size, 1);

  time.advance(1_000);
  const recovered = await dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(proposals.calls.length, 2);
  assert.equal(proposals.records.size, 1);
  assert.equal(ledger.items[0].status, "waiting_external");
  assert.match(ledger.ackCalls[0].details.proposalDigest, /^[a-f0-9]{64}$/);
});

test("a restarted dispatcher replays the old sealed proposal instead of rebinding with new policy", async () => {
  const pair = workPair(11, codeIntent(), {
    target: { type: "role", id: "developer" },
  });
  const proposals = new FakeProposalProducer();
  proposals.failAfterCreateOnce = true;
  const oldGate = readyGate(1);
  let oldPolicyCalls = 0;
  const oldPolicy = policy({ version: 4 });
  const firstRuntime = fixture([pair], {
    proposals,
    actionAdmissionGate: oldGate,
    policy: {
      bind(input) {
        oldPolicyCalls += 1;
        return oldPolicy.bind(input);
      },
    },
  });

  const uncertain = await firstRuntime.dispatcher.dispatchPending();
  assert.equal(uncertain.uncertain, 1);
  assert.equal(oldPolicyCalls, 1);
  assert.equal(firstRuntime.ledger.bindCalls.length, 1);
  assert.equal(proposals.records.size, 1);
  assert.equal(firstRuntime.ledger.outbox[0].dispatchBinding.boundIntent.policyVersion, 4);

  await cutoverToVersion(oldGate, 2);
  firstRuntime.time.advance(1_000);
  let newPolicyCalls = 0;
  const newPolicy = policy({ version: 5 });
  const restarted = fixture([pair], {
    time: firstRuntime.time,
    ledger: firstRuntime.ledger,
    proposals,
    actionAdmissionGate: readyGate(2),
    policy: {
      bind(input) {
        newPolicyCalls += 1;
        return newPolicy.bind(input);
      },
    },
  });

  const recovered = await restarted.dispatcher.dispatchPending();

  assert.equal(recovered.delivered, 1);
  assert.equal(newPolicyCalls, 0);
  assert.equal(proposals.calls.length, 2);
  assert.deepEqual(proposals.calls[1], proposals.calls[0]);
  assert.equal(proposals.records.size, 1);
  assert.equal(firstRuntime.ledger.outbox[0].status, "delivered");
});

test("a lost binding receipt produces no downstream action until durable recovery", async () => {
  const pair = workPair(12, askUserIntent());
  const gate = readyGate();
  const firstRuntime = fixture([pair], { actionAdmissionGate: gate });
  firstRuntime.ledger.failBindAfterOnce = true;

  const uncertain = await firstRuntime.dispatcher.dispatchPending();

  assert.equal(uncertain.uncertain, 1);
  assert.equal(uncertain.items[0].code, "binding-result-uncertain");
  assert.equal(firstRuntime.attention.calls.length, 0);
  assert.notEqual(firstRuntime.ledger.outbox[0].dispatchBinding, null);

  await cutoverToVersion(gate, 2);
  firstRuntime.time.advance(1_000);
  let newPolicyCalls = 0;
  const restarted = fixture([pair], {
    time: firstRuntime.time,
    ledger: firstRuntime.ledger,
    attention: firstRuntime.attention,
    actionAdmissionGate: readyGate(2),
    policy: {
      bind(input) {
        newPolicyCalls += 1;
        return policy({ version: 5 }).bind(input);
      },
    },
  });

  const recovered = await restarted.dispatcher.dispatchPending();

  assert.equal(recovered.delivered, 1);
  assert.equal(newPolicyCalls, 0);
  assert.equal(firstRuntime.attention.calls.length, 1);
});

test("legacy in-flight intents with unknowable bindings never call policy or downstream", async () => {
  const time = controlledClock();
  const pair = workPair(13, askUserIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now()).toISOString(),
  });
  pair.outbox.dispatchBinding = { status: "legacy_unknown" };
  let policyCalls = 0;
  const trustedPolicy = policy();
  const { dispatcher, ledger, attention, proposals } = fixture([pair], {
    time,
    policy: {
      bind(input) {
        policyCalls += 1;
        return trustedPolicy.bind(input);
      },
    },
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.uncertain, 1);
  assert.equal(result.items[0].code, "legacy-binding-unknown");
  assert.equal(policyCalls, 0);
  assert.equal(ledger.claimCalls.length, 0);
  assert.equal(ledger.bindCalls.length, 0);
  assert.equal(ledger.ackCalls.length, 0);
  assert.equal(attention.calls.length, 0);
  assert.equal(proposals.calls.length, 0);
});

test("role dispatch filters before limiting and leaves other roles unclaimed", async () => {
  const developer = conflictWorkPair(1);
  const review = workPair(2, reviewIntent(), { target: { type: "role", id: "pr-engineer" } });
  const { dispatcher, ledger, proposals } = fixture([developer, review], {
    policy: policy({ githubReviewRoles: ["pr-engineer"] }),
    conflictExecutionSourcePreparer: { async prepare() { throw new Error("unrelated developer preparation ran"); } },
  });
  const result = await dispatcher.dispatchPending({ limit: 1, roleId: "pr-engineer" });
  assert.equal(result.delivered, 1);
  assert.deepEqual(ledger.claimCalls.map(({ intentId }) => intentId), [review.outbox.intentId]);
  assert.equal(ledger.outbox[0].status, "pending");
  assert.equal(proposals.calls.length, 1);
  await assert.rejects(dispatcher.dispatchPending({ roleId: "invalid role" }), /roleId is invalid/);
});

test("legacy binding quarantine does not consume the actionable dispatch limit", async () => {
  const time = controlledClock();
  const legacy = workPair(13, askUserIntent(), {
    status: "dispatching",
    leaseUntil: new Date(time.now()).toISOString(),
  });
  legacy.outbox.dispatchBinding = { status: "legacy_unknown" };
  const actionable = workPair(14, askUserIntent());
  const { dispatcher, ledger, attention } = fixture([legacy, actionable], {
    time,
  });

  const result = await dispatcher.dispatchPending({ limit: 1 });

  assert.equal(result.scanned, 2);
  assert.equal(result.uncertain, 1);
  assert.equal(result.delivered, 1);
  assert.deepEqual(
    ledger.claimCalls.map(({ intentId }) => intentId),
    [actionable.outbox.intentId],
  );
  assert.equal(ledger.outbox[0].revision, legacy.outbox.revision);
  assert.equal(attention.calls.length, 1);
});

test("policy rejection blocks safely and attention conflicts split blocked from retry_wait", async (t) => {
  await t.test("policy", async () => {
    const pair = workPair(1, reviewIntent(), {
      target: { type: "role", id: "developer" },
    });
    const { dispatcher, ledger } = fixture([pair]);
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.outbox[0].status, "failed");
    assert.equal(ledger.items[0].status, "blocked");
    assert.equal(ledger.ackCalls[0].details.code, "policy-denied");
  });

  await t.test("attention conflict", async () => {
    const pair = workPair(2, askUserIntent());
    const attention = new FakeAttentionProducer();
    attention.error = Object.assign(new Error("conflict"), {
      code: "ATTENTION_REQUEST_CONFLICT",
    });
    const { dispatcher, ledger } = fixture([pair], { attention });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.items[0].status, "blocked");
  });

  await t.test("attention capacity", async () => {
    const pair = workPair(3, askUserIntent());
    const attention = new FakeAttentionProducer();
    attention.error = Object.assign(new Error("full"), {
      code: "ATTENTION_CAPACITY_EXCEEDED",
    });
    const { dispatcher, ledger } = fixture([pair], { attention });
    const result = await dispatcher.dispatchPending();
    assert.equal(result.retryWait, 1);
    assert.equal(ledger.items[0].status, "retry_wait");
    assert.equal(ledger.ackCalls[0].outcome, "failed");
    assert.ok(Date.parse(ledger.ackCalls[0].availableAt) > Date.parse(ledger.ackCalls[0].details.at ?? "2026-08-02T04:00:00.000Z"));
  });
});

test("an already fixed owner PR goes from developer to internal PR review without confirmation", async () => {
  const pair = workPair(4, {
    ...handoffIntent(), capability: "pr-review",
    brief: `Existing repair on Head ${"a".repeat(40)} covers the outstanding feedback; review code and regression evidence`,
    evidence: ["current-head-diff", "regression-report"],
  }, { target: { type: "role", id: "developer" } });
  pair.item.event = normalizeWorkflowEvent({
    schemaVersion: 1, eventType: "pull_request.owner_requested",
    occurredAt: "2026-08-02T03:00:00.000Z",
    source: { provider: "local-owner", scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000" },
    subject: clone(pair.item.event.subject),
    payload: { ...clone(pair.item.event.payload), title: "Existing PR repair", workType: "development" },
  });
  pair.item.source = createPullRequestWorkSource(prSourceEnvelope(4, pair.item.event, pair.item.assignmentId)).source;
  const { dispatcher, ledger, attention, proposals } = fixture([pair], {
    policy: policy({ capabilityRoles: { "pr-review": "pr-engineer" } }),
  });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(ledger.items[0].status, "queued");
  assert.equal(ledger.items[0].currentTarget.id, "pr-engineer");
  assert.equal(ledger.outbox[0].dispatchBinding.boundIntent.binding.targetRoleId, "pr-engineer");
  assert.equal(attention.calls.length, 0);
  assert.equal(proposals.calls.length, 0);
  assert.equal((await dispatcher.dispatchPending()).scanned, 0);
  assert.equal(ledger.ackCalls.length, 1);
});

test("handoff uses only the policy-mapped role and never exposes a half-handoff crash state", async (t) => {
  await t.test("write fails before the atomic acknowledgement", async () => {
    const pair = workPair(4, handoffIntent());
    const { dispatcher, ledger, time } = fixture([pair]);
    ledger.failAckBeforeOnce = true;

    const uncertain = await dispatcher.dispatchPending();
    assert.equal(uncertain.uncertain, 1);
    assert.equal(ledger.outbox[0].status, "dispatching");
    assert.equal(ledger.items[0].status, "dispatch_pending");
    assert.equal(ledger.items[0].currentTarget.id, "pr-reviewer");
    assert.deepEqual(ledger.ackCalls[0].target, {
      type: "role",
      id: "trusted-tester",
    });

    time.advance(1_000);
    const recovered = await dispatcher.dispatchPending();
    assert.equal(recovered.delivered, 1);
    assert.equal(ledger.outbox[0].status, "delivered");
    assert.equal(ledger.items[0].status, "queued");
    assert.equal(ledger.items[0].currentTarget.id, "trusted-tester");
  });

  await t.test("response is lost after the atomic acknowledgement", async () => {
    const pair = workPair(5, handoffIntent());
    const { dispatcher, ledger, time } = fixture([pair]);
    ledger.failAckAfterOnce = true;

    const uncertain = await dispatcher.dispatchPending();
    assert.equal(uncertain.uncertain, 1);
    assert.equal(ledger.outbox[0].status, "delivered");
    assert.equal(ledger.items[0].status, "queued");
    assert.equal(ledger.items[0].currentTarget.id, "trusted-tester");

    time.advance(1_000);
    const noReplay = await dispatcher.dispatchPending();
    assert.equal(noReplay.scanned, 0);
    assert.equal(ledger.ackCalls.length, 1);
  });
});

test("constructor and dispatch options reject incomplete ports and unsafe batch sizes", async () => {
  assert.throws(
    () => new WorkIntentDispatcher({ ledger: {}, policy: {}, attentionProducer: {} }),
    /ledger must provide/,
  );
  assert.throws(
    () =>
      new WorkIntentDispatcher({
        ledger: {
          listOutbox() {},
          listItems() {},
          claimIntent() {},
          bindIntent() {},
          ackIntent() {},
          isIntentDispatchCurrent() {},
        },
        policy: { bind() {} },
        attentionProducer: { create() {} },
      }),
    /proposalProducer/,
  );
  const pair = workPair(1, waitIntent());
  assert.throws(
    () => fixture([pair], { actionAdmissionGate: null }),
    /actionAdmissionGate/,
  );
  assert.throws(
    () => fixture([pair], { actionAdmissionGate: {} }),
    /actionAdmissionGate/,
  );
  const { dispatcher } = fixture([pair]);
  await assert.rejects(dispatcher.dispatchPending({ limit: 101 }), /limit/);
  await assert.rejects(dispatcher.dispatchPending({ limit: 1, extra: true }), /options/);
});

test("dispatcher binds policy and attention producer only from durable requestedBy", async () => {
  const pair = workPair(1, askUserIntent(), {
    target: { type: "person", id: "missing-owner" },
  });
  const contexts = [];
  const trustedPolicy = policy();
  const capturingPolicy = {
    bind(input) {
      contexts.push(clone(input.context));
      return trustedPolicy.bind(input);
    },
  };
  const { dispatcher, attention } = fixture([pair], { policy: capturingPolicy });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(contexts[0].roleId, "orchestrator");
  assert.deepEqual(attention.calls[0].producer, {
    roleId: "orchestrator",
    workItemId: pair.item.itemId,
  });
});

test("dispatcher binds a PR intent to the active Head instead of its origin event", async () => {
  const headA = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T03:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#314",
      repository: "acme/repo",
      number: 314,
    },
    payload: {
      title: "Resolve conflicts",
      headRefOid: "HEAD-A",
      state: "open",
      changedFields: ["title"],
    },
  });
  const headB = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T03:05:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: headA.subject,
    payload: {
      title: "Resolve conflicts",
      headRefOid: "HEAD-B",
      previousHeadRefOid: "HEAD-A",
      state: "open",
      changedFields: ["headRefOid"],
    },
  });
  const pair = workPair(1, askUserIntent(), {
    target: { type: "role", id: "pr-engineer" },
  });
  const created = createPullRequestWorkSource(
    prSourceEnvelope(1, headA, "workflow-assignment-head-a"),
  );
  pair.item.event = headA;
  pair.item.source = appendPullRequestWorkSource(
    created.source,
    prSourceEnvelope(2, headB, "workflow-assignment-head-b"),
    { attemptAtActivation: 0 },
  ).source;

  const contexts = [];
  const trustedPolicy = policy();
  const capturingPolicy = {
    bind(input) {
      contexts.push(clone(input.context));
      return trustedPolicy.bind(input);
    },
  };
  const { dispatcher, ledger } = fixture([pair], {
    policy: capturingPolicy,
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(pair.item.event.payload.headRefOid, "HEAD-A");
  assert.equal(contexts[0].event.eventId, headB.eventId);
  assert.equal(contexts[0].event.payload.headRefOid, "HEAD-B");
  assert.equal(
    ledger.bindCalls[0].boundIntent.source.eventId,
    headB.eventId,
  );
  assert.notEqual(
    ledger.bindCalls[0].boundIntent.source.eventId,
    headA.eventId,
  );
});

test("configuration-first intent admission rejects without claiming or dispatching", async () => {
  const gate = readyGate();
  await cutoverToVersion(gate, 2);
  const pair = workPair(1, askUserIntent());
  let policyCalls = 0;
  const trustedPolicy = policy();
  const { dispatcher, ledger, attention, proposals } = fixture([pair], {
    actionAdmissionGate: gate,
    policy: {
      bind(input) {
        policyCalls += 1;
        return trustedPolicy.bind(input);
      },
    },
  });
  const before = clone({ items: ledger.items, outbox: ledger.outbox });

  await assert.rejects(
    dispatcher.dispatchPending(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(ledger.claimCalls.length, 0);
  assert.equal(ledger.ackCalls.length, 0);
  assert.equal(policyCalls, 0);
  assert.equal(attention.calls.length, 0);
  assert.equal(proposals.calls.length, 0);
  assert.deepEqual({ items: ledger.items, outbox: ledger.outbox }, before);
});

test("cutover between intent claim and policy binding leaves only a recoverable lease", async () => {
  const gate = readyGate();
  const pair = workPair(2, askUserIntent());
  const time = controlledClock();
  const ledger = new BlockingClaimLedger([pair], time);
  let policyCalls = 0;
  const trustedPolicy = policy();
  const { dispatcher, attention, proposals } = fixture([pair], {
    time,
    ledger,
    actionAdmissionGate: gate,
    policy: {
      bind(input) {
        policyCalls += 1;
        return trustedPolicy.bind(input);
      },
    },
  });

  const dispatch = dispatcher.dispatchPending();
  await ledger.claimStarted.promise;
  await cutoverToVersion(gate, 2);
  ledger.claimRelease.resolve();

  await assert.rejects(
    dispatch,
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(ledger.claimCalls.length, 1);
  assert.equal(ledger.outbox[0].status, "dispatching");
  assert.equal(policyCalls, 0);
  assert.equal(ledger.ackCalls.length, 0);
  assert.equal(attention.calls.length, 0);
  assert.equal(proposals.calls.length, 0);
});

test("an admitted intent binding write releases cutover before durable settlement", async () => {
  const gate = readyGate();
  const pair = workPair(3, askUserIntent());
  const time = controlledClock();
  const ledger = new BlockingBindLedger([pair], time);
  const { dispatcher, attention } = fixture([pair], {
    time,
    ledger,
    actionAdmissionGate: gate,
  });

  const dispatch = dispatcher.dispatchPending();
  await ledger.bindStarted.promise;
  const cutover = cutoverToVersion(gate, 2);
  const cutoverFinishedBeforeBinding = await settlesBefore(cutover);
  ledger.bindRelease.resolve();
  const result = await dispatch;
  await cutover;

  assert.equal(cutoverFinishedBeforeBinding, true);
  assert.equal(result.delivered, 1);
  assert.equal(ledger.bindCalls.length, 1);
  assert.equal(attention.calls.length, 1);
});

test("an admitted intent policy plan finishes downstream work after cutover", async () => {
  const gate = readyGate();
  const pair = workPair(3, askUserIntent());
  const nextPair = workPair(4, askUserIntent());
  const attention = new BlockingAttentionProducer();
  const trustedPolicy = policy();
  let mutableBound;
  const { dispatcher, ledger } = fixture([pair, nextPair], {
    attention,
    actionAdmissionGate: gate,
    policy: {
      bind(input) {
        mutableBound = clone(trustedPolicy.bind(input));
        return mutableBound;
      },
    },
  });

  const dispatch = dispatcher.dispatchPending({ limit: 1 });
  await attention.createStarted.promise;
  await cutoverToVersion(gate, 2);
  mutableBound.payload.question = "不可信的切换后修改";
  attention.createRelease.resolve();
  const result = await dispatch;

  assert.equal(result.delivered, 1);
  assert.equal(ledger.ackCalls.length, 1);
  assert.equal(attention.calls[0].question, "是否接受新的验收口径？");
  await assert.rejects(
    dispatcher.dispatchPending(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
});

test("asynchronous intent policy binding fails closed without downstream effects", async () => {
  const pair = workPair(4, askUserIntent());
  const trustedPolicy = policy();
  const { dispatcher, ledger, attention, proposals } = fixture([pair], {
    policy: {
      async bind(input) {
        return trustedPolicy.bind(input);
      },
    },
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.blocked, 1);
  assert.equal(ledger.claimCalls.length, 1);
  assert.equal(ledger.ackCalls[0].details.code, "policy-binding-invalid");
  assert.equal(attention.calls.length, 0);
  assert.equal(proposals.calls.length, 0);
});

test("DIRTY resolve_conflict prepares one sealed source before durable proposal binding", async () => {
  const pair = conflictWorkPair(5);
  const calls = [];
  const preparer = {
    async prepare(inputBinding) {
      calls.push(clone(inputBinding));
      return conflictExecutionSource(inputBinding);
    },
  };
  const { dispatcher, ledger, proposals } = fixture([pair], {
    conflictExecutionSourcePreparer: preparer,
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schemaVersion, 2);
  const boundSource = ledger.bindCalls[0].boundIntent.binding.executionSource;
  assert.equal(sameCodeExecutionSource(boundSource, conflictExecutionSource(calls[0])), true);
  assert.equal(
    sameCodeExecutionSource(
      proposals.calls[0].binding.executionSource,
      boundSource,
    ),
    true,
  );
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "eventDigest",
    "eventId",
    "gitTarget",
    "headRefOid",
    "headRevision",
    "inputDigest",
    "inputRevision",
    "kind",
    "pullRequestNumber",
    "repository",
    "rootItemId",
    "schemaVersion",
    "workKey",
  ]);
});

test("persisted conflict binding retries delivery without preparing a second source", async () => {
  const pair = conflictWorkPair(6);
  const time = controlledClock();
  const ledger = new FakeLedger([pair], time);
  ledger.failBindAfterOnce = true;
  let preparations = 0;
  const { dispatcher, proposals } = fixture([pair], {
    time,
    ledger,
    conflictExecutionSourcePreparer: {
      async prepare(inputBinding) {
        preparations += 1;
        return conflictExecutionSource(inputBinding);
      },
    },
  });

  const first = await dispatcher.dispatchPending();
  assert.equal(first.uncertain, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls.length, 0);

  time.advance(1_001);
  const recovered = await dispatcher.dispatchPending();
  assert.equal(recovered.delivered, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls.length, 1);
});

test("orchestrator owner conflict work seals the same conflict source without a copied dashboard status", async () => {
  const pair = conflictWorkPair(6);
  const { mergeStateStatus, ...payload } = pair.item.event.payload;
  pair.item.event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.owner_requested",
    occurredAt: "2026-08-02T03:00:00.000Z", source: { provider: "local-owner", scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000" },
    subject: clone(pair.item.event.subject), payload: { ...clone(payload), title: "Resolve PR conflict", workType: "general",
      suggestedCapability: "development", expectedHeadRefOid: payload.headRefOid } });
  pair.item.source = createPullRequestWorkSource(prSourceEnvelope(6, pair.item.event, pair.item.assignmentId)).source;
  let preparations = 0;
  const { dispatcher, proposals } = fixture([pair], { conflictExecutionSourcePreparer: { async prepare(binding) {
    preparations += 1; return conflictExecutionSource(binding);
  } } });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls[0].binding.executionSource.kind, "conflict_preparation");
});

test("own review repair binds its trusted source once and resumes the persisted proposal", async () => {
  const pair = conflictWorkPair(6, codeIntent(), { mergeStateStatus: "CLEAN", relation: "authored", nextAction: "address_review" });
  const time = controlledClock();
  const ledger = new FakeLedger([pair], time);
  ledger.failBindAfterOnce = true;
  let preparations = 0;
  const { dispatcher, proposals } = fixture([pair], {
    time, ledger,
    reviewRepairSourcePreparer: { async prepare({ inputBinding, roleId }) {
      assert.equal(roleId, "developer");
      preparations += 1;
      return createReviewRepairCodeExecutionSource({ inputBinding, writablePaths: ["src"] });
    } },
  });
  assert.equal((await dispatcher.dispatchPending()).uncertain, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls.length, 0);
  time.advance(1_001);
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls[0].binding.executionSource.kind, "review_repair");
});

test("CI repair diagnostics bind and resume through canonical proposal storage", async () => {
  const pair = conflictWorkPair(6, codeIntent(), { mergeStateStatus: "CLEAN", relation: "authored", nextAction: "fix_ci" });
  const time = controlledClock();
  const ledger = new FakeLedger([pair], time);
  ledger.failBindAfterOnce = true;
  let preparations = 0;
  const { dispatcher, proposals } = fixture([pair], {
    time, ledger,
    reviewRepairSourcePreparer: { async prepare({ inputBinding }) {
      preparations += 1;
      return createCiRepairCodeExecutionSource({ inputBinding, writablePaths: ["src"],
        ciEvidence: createCiRepairEvidence({ schemaVersion: 1, repository: inputBinding.repository,
          number: inputBinding.pullRequestNumber, headRefOid: inputBinding.headRefOid,
          headRefName: inputBinding.gitTarget.headRefName,
          checks: [{ kind: "status_context", name: "QuickTest", url: null, conclusion: "FAILURE" }],
          diagnostics: [{ check: "QuickTest", state: "unavailable", failures: [{ message: "Fixture missing", file: "test.cpp" }] }] }) });
    } },
  });
  assert.equal((await dispatcher.dispatchPending()).uncertain, 1);
  assert.equal(proposals.calls.length, 0);
  time.advance(1_001);
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls[0].binding.executionSource.kind, "ci_repair");
  assert.equal(proposals.calls[0].binding.executionSource.ciEvidence.diagnostics[0].failures[0].message, "Fixture missing");
});

for (const code of ['OWN_PR_CI_SOURCE_NOT_READY', 'CODE_CI_REPAIR_CONTEXT_UNAVAILABLE', 'OWN_PR_CONFLICT_SOURCE_NOT_READY']) test(`CI source ${code} retries without submitting an ordinary unpublishable proposal`, async () => {
  const pair = conflictWorkPair(6, codeIntent(), { mergeStateStatus: 'CLEAN', relation: 'authored', nextAction: 'fix_ci' });
  const { dispatcher, proposals, ledger } = fixture([pair], {
    reviewRepairSourcePreparer: { async prepare() { throw Object.assign(new Error('CI evidence not ready'), { code }); } },
  });
  const result = await dispatcher.dispatchPending();
  assert.equal(result.retryWait, 1);
  assert.equal(proposals.calls.length, 0);
  assert.equal(ledger.ackCalls[0].details.code, code === 'OWN_PR_CONFLICT_SOURCE_NOT_READY' ? 'conflict-source-unavailable' : 'ci-source-unavailable');
  assert.equal(ledger.items[0].status, 'retry_wait');
});

test("upgrade recovery blocks a persisted conflict proposal without a sealed source", async () => {
  const pair = conflictWorkPair(15);
  const trustedPolicy = policy();
  const inputBinding = createPullRequestExecutionBinding({
    sourceBinding: currentWorkItemInputBinding(pair.item),
    event: currentWorkItemEvent(pair.item),
  });
  const legacyBound = trustedPolicy.bind({
    context: {
      assignmentId: pair.item.assignmentId,
      workItemId: pair.item.itemId,
      roleId: pair.outbox.requestedBy.roleId,
      event: pair.item.event,
      inputBinding,
    },
    intent: pair.outbox.intent,
  });
  pair.outbox.dispatchBinding = createWorkIntentDispatchBinding(legacyBound);
  let preparations = 0;
  const { dispatcher, ledger, proposals } = fixture([pair], {
    conflictExecutionSourcePreparer: {
      async prepare() {
        preparations += 1;
        throw new Error("persisted policy binding must not be replaced");
      },
    },
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.blocked, 1);
  assert.equal(result.items[0].code, "conflict-binding-unsealed");
  assert.equal(ledger.bindCalls.length, 0);
  assert.equal(preparations, 0);
  assert.equal(proposals.calls.length, 0);
});

test("configuration cutover after preparation fences binding and safely re-prepares after restart", async () => {
  const pair = conflictWorkPair(14);
  const time = controlledClock();
  const ledger = new FakeLedger([pair], time);
  let preparations = 0;
  let admissions = 0;
  const preparer = {
    async prepare(inputBinding) {
      preparations += 1;
      return conflictExecutionSource(inputBinding);
    },
  };
  const cutoverGate = {
    run(operation) {
      admissions += 1;
      if (admissions === 3) {
        throw Object.assign(new Error("restart required"), {
          code: "RUNTIME_RESTART_REQUIRED",
        });
      }
      return operation();
    },
  };
  const firstRuntime = fixture([pair], {
    time,
    ledger,
    actionAdmissionGate: cutoverGate,
    conflictExecutionSourcePreparer: preparer,
  });

  await assert.rejects(
    firstRuntime.dispatcher.dispatchPending(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(preparations, 1);
  assert.equal(ledger.bindCalls.length, 0);
  assert.equal(firstRuntime.proposals.calls.length, 0);

  time.advance(1_001);
  const restarted = fixture([pair], {
    time,
    ledger,
    conflictExecutionSourcePreparer: preparer,
  });
  const result = await restarted.dispatcher.dispatchPending();

  assert.equal(result.delivered, 1);
  assert.equal(preparations, 2);
  assert.equal(ledger.bindCalls.length, 1);
  assert.equal(restarted.proposals.calls.length, 1);
});

test("conflict facts and missing preparation capability fail closed without ordinary modify fallback", async (t) => {
  await t.test("inconsistent facts", async () => {
    const pair = conflictWorkPair(7, codeIntent(), { nextAction: "wait_other" });
    let preparations = 0;
    const { dispatcher, ledger, proposals } = fixture([pair], {
      conflictExecutionSourcePreparer: {
        async prepare() {
          preparations += 1;
          throw new Error("must not prepare");
        },
      },
    });

    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.ackCalls[0].details.code, "conflict-facts-inconsistent");
    assert.equal(preparations, 0);
    assert.equal(proposals.calls.length, 0);
  });

  await t.test("preparer absent", async () => {
    const pair = conflictWorkPair(8);
    const { dispatcher, ledger, proposals } = fixture([pair]);

    const result = await dispatcher.dispatchPending();
    assert.equal(result.blocked, 1);
    assert.equal(ledger.ackCalls[0].details.code, "conflict-preparer-not-configured");
    assert.equal(proposals.calls.length, 0);
  });
});

test("conflict preparation errors are classified without creating a proposal", async (t) => {
  const cases = [
    {
      name: "unsupported conflict",
      errorCode: "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
      counter: "blocked",
      resultCode: "conflict-source-blocked",
    },
    {
      name: "temporary process failure",
      errorCode: "CONTROLLED_GIT_TIMEOUT",
      counter: "retryWait",
      resultCode: "conflict-source-temporarily-unavailable",
    },
    {
      name: "source became stale",
      errorCode: "CONFLICT_PREPARATION_INPUT_CHANGED",
      counter: "blocked",
      resultCode: "conflict-source-stale",
    },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const pair = conflictWorkPair(index + 9);
      const { dispatcher, ledger, proposals } = fixture([pair], {
        conflictExecutionSourcePreparer: {
          async prepare() {
            throw Object.assign(new Error(entry.name), { code: entry.errorCode });
          },
        },
      });

      const result = await dispatcher.dispatchPending();
      assert.equal(result[entry.counter], 1);
      assert.equal(ledger.ackCalls[0].details.code, entry.resultCode);
      assert.equal(proposals.calls.length, 0);
    });
  }
});

test("dispatcher rejects a policy that substitutes the prepared execution source", async () => {
  const pair = conflictWorkPair(13);
  const trustedPolicy = policy();
  const { dispatcher, ledger, proposals } = fixture([pair], {
    conflictExecutionSourcePreparer: {
      async prepare(inputBinding) {
        return conflictExecutionSource(inputBinding, "1");
      },
    },
    policy: {
      bind(input) {
        return trustedPolicy.bind({
          ...input,
          context: {
            ...input.context,
            executionSource: conflictExecutionSource(
              input.context.inputBinding,
              "5",
            ),
          },
        });
      },
    },
  });

  const result = await dispatcher.dispatchPending();

  assert.equal(result.blocked, 1);
  assert.equal(ledger.ackCalls[0].details.code, "policy-binding-invalid");
  assert.equal(proposals.calls.length, 0);
});

test("dispatcher rejects accessor and sparse ledger pages without invoking getters", async (t) => {
  const cases = [
    {
      name: "accessor item",
      page() {
        let reads = 0;
        const items = [];
        Object.defineProperty(items, "0", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("must not execute");
          },
        });
        return { value: { items, nextCursor: null }, reads: () => reads };
      },
    },
    {
      name: "sparse item",
      page() {
        return {
          value: { items: new Array(1), nextCursor: null },
          reads: () => 0,
        };
      },
    },
    {
      name: "record accessor",
      page() {
        let reads = 0;
        const record = {};
        Object.defineProperty(record, "intentId", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("must not execute");
          },
        });
        return {
          value: { items: [record], nextCursor: null },
          reads: () => reads,
        };
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const malicious = entry.page();
      const ledger = {
        listOutbox: async () => malicious.value,
        listItems: async () => ({ items: [], nextCursor: null }),
        claimIntent: async () => {
          throw new Error("must not claim");
        },
        bindIntent: async () => {
          throw new Error("must not bind");
        },
        ackIntent: async () => {
          throw new Error("must not acknowledge");
        },
        isIntentDispatchCurrent: async () => true,
      };
      const { dispatcher } = fixture([], { ledger });

      await assert.rejects(
        dispatcher.dispatchPending(),
        (error) => error.code === "WORK_INTENT_LEDGER_QUERY_INVALID",
      );
      assert.equal(malicious.reads(), 0);
    });
  }
});


test("internal repair conflict source survives an interrupted host binding without ordinary modify fallback", async () => {
  const pair = conflictWorkPair(6, codeIntent(), { mergeStateStatus: "CLEAN", relation: "authored", nextAction: "address_review" });
  const old = pair.item.event;
  pair.item.event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.internal_review_requested",
    occurredAt: old.occurredAt, source: { provider: "internal-review-repair", scopeId: "internal-review:123e4567-e89b-42d3-a456-426614174000" },
    subject: old.subject, payload: { workType: "pull_request", state: "open", headRefOid: old.payload.headRefOid,
      gitTargetAvailable: true, gitTarget: old.payload.gitTarget,
      internalReview: { kind: "own_pr_ci_repair", headRefOid: old.payload.headRefOid, feedbackDigest: "c".repeat(64),
        publicationConfirmationId: "prior-publication", controlledCommitEvidenceId: "prior-commit" } } });
  pair.item.source = createPullRequestWorkSource(prSourceEnvelope(6, pair.item.event, pair.item.assignmentId)).source;
  const time = controlledClock(), ledger = new FakeLedger([pair], time);
  ledger.failBindAfterOnce = true;
  let preparations = 0;
  const { dispatcher, proposals } = fixture([pair], { time, ledger,
    reviewRepairSourcePreparer: { async prepare({ inputBinding }) { preparations++; return conflictExecutionSource(inputBinding); } } });
  assert.equal((await dispatcher.dispatchPending()).uncertain, 1);
  time.advance(1001);
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  assert.equal(preparations, 1);
  assert.equal(proposals.calls[0].binding.executionSource.kind, "conflict_preparation");
});
