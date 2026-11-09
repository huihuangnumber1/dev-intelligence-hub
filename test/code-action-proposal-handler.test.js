import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  codeJobIdForGrant,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import {
  codeJobConfirmationIdForGrant,
  codeJobConfirmationIdForProposal,
  createCodeActionProposalConfirmationPlan,
} from "../src/domain/code-action-proposal-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import {
  CodeActionProposalHandler,
  createCodeActionProposalRunnerService,
} from "../src/services/code-action-proposal-handler.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";
import { CodeJobGrantFactory } from "../src/services/code-job-grant-factory.js";

const CREATED_AT = "2026-08-02T03:00:01.000Z";
const HEAD_REF_OID = "1".repeat(40);

function inputBindingFor(number) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: number,
    rootItemId: `work-${number}`,
    workKey: `pull-request-acme-repo-${number}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: HEAD_REF_OID,
    eventId: `event-${number}`,
    eventDigest: `${"d".repeat(63)}${number % 10}`,
    inputDigest: `${"e".repeat(63)}${number % 10}`,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "2".repeat(40),
      headRepository: "contributor/repo",
      headRefName: `fix/pr-${number}`,
      headRefOid: HEAD_REF_OID,
    },
  };
}

function proposal(number = 42) {
  return normalizeBoundWorkProposal({
    proposalId: `work-intent-${"a".repeat(63)}${number % 10}`,
    policyVersion: 7,
    kind: "code_action_proposal",
    requestedBy: { roleId: "developer", workItemId: `work-${number}` },
    source: { assignmentId: `assignment-${number}`, eventId: `event-${number}` },
    binding: {
      eventId: `event-${number}`,
      subject: {
        id: `github:pr:acme/repo#${number}`,
        repository: "acme/repo",
        number,
      },
      repository: "acme/repo",
      workspaceId: "acme-workspace",
      inputBinding: inputBindingFor(number),
    },
    payload: {
      operation: "modify",
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过"],
      evidence: ["revision 未校验"],
      summary: "创建受控代码任务",
      reason: "需要在隔离副本中验证修复",
    },
  });
}

function legacyProposal(number = 42) {
  const current = proposal(number);
  const { gitTarget: _gitTarget, ...legacyBinding } =
    current.binding.inputBinding;
  return normalizeBoundWorkProposal({
    proposalId: current.proposalId,
    policyVersion: current.policyVersion,
    kind: current.kind,
    requestedBy: current.requestedBy,
    source: current.source,
    binding: {
      ...current.binding,
      inputBinding: { ...legacyBinding, schemaVersion: 1 },
    },
    payload: current.payload,
  });
}

function grantFor(value = proposal()) {
  return createCodeJobGrant({
    schemaVersion: 2,
    proposalId: value.proposalId,
    contentDigest: value.contentDigest,
    policyVersion: value.policyVersion,
    requestedBy: value.requestedBy,
    source: value.source,
    subject: value.binding.subject,
    repository: value.binding.repository,
    workspaceId: value.binding.workspaceId,
    inputBinding: value.binding.inputBinding,
    workspaceAuthorityDigest: "9".repeat(64),
    operation: value.payload.operation,
    objective: value.payload.objective,
    acceptanceCriteria: value.payload.acceptanceCriteria,
    evidence: value.payload.evidence,
    summary: value.payload.summary,
    reason: value.payload.reason,
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[value.payload.operation]],
    writablePaths: value.payload.operation === "modify" ? ["src"] : [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  });
}

function authority(grant) {
  const calls = [];
  return {
    calls,
    factory: {
      async create(value) {
        calls.push(structuredClone(value));
        return {
          grant: structuredClone(grant),
          allowedOperationsByRole: {
            developer: ["inspect", "modify", "verify"],
            tester: ["inspect", "verify"],
          },
        };
      }
    },
  };
}

function handlerInput(overrides = {}) {
  return {
    proposal: proposal(),
    status: "pending_delivery",
    attempt: 1,
    downstreamRef: null,
    ...overrides,
  };
}

function confirmationItem(plan, status, overrides = {}) {
  const normalized = normalizeConfirmationPlan(plan);
  const terminal = {
    completed: {
      receipt: {
        id: codeJobIdForGrant(normalized.action.grant),
        createdAt: CREATED_AT,
      },
    },
    rejected: {
      rejection: {
        requestId: "reject-request-1",
        reason: "不执行",
        at: "2026-08-02T03:00:00.000Z",
      },
    },
    stale: {
      invalidation: {
        reason: "work_item_superseded",
        requestedBy: normalized.requestedBy,
        approvalBindingDigest: normalized.approvalBindingDigest,
        at: "2026-08-02T03:00:00.000Z",
      },
    },
  }[status] ?? {};
  return {
    id: normalized.id,
    kind: normalized.kind,
    status,
    queueRevision: 1,
    itemRevision: 1,
    requestedBy: normalized.requestedBy,
    actor: normalized.actor,
    target: normalized.target,
    display: normalized.display,
    displayedPayloadDigest: normalized.displayedPayloadDigest,
    approvalBindingDigest: normalized.approvalBindingDigest,
    retryable: false,
    ...terminal,
    ...overrides,
  };
}

class FakeConfirmationProducer {
  constructor(status = "pending", overrides = {}) {
    this.status = status;
    this.overrides = overrides;
    this.plan = null;
    this.enqueueCalls = [];
    this.getCalls = [];
    this.invalidateCalls = [];
  }

  async enqueue(plan) {
    this.enqueueCalls.push(structuredClone(plan));
    if (this.plan !== null) {
      const existing = normalizeConfirmationPlan(this.plan);
      const incoming = normalizeConfirmationPlan(plan);
      if (
        existing.id === incoming.id &&
        existing.approvalBindingDigest !== incoming.approvalBindingDigest
      ) {
        const error = new Error("confirmation conflict");
        error.code = "CONFIRMATION_ID_CONFLICT";
        throw error;
      }
      return confirmationItem(this.plan, this.status, this.overrides);
    }
    this.plan = structuredClone(plan);
    return confirmationItem(plan, this.status, this.overrides);
  }

  async get(id) {
    this.getCalls.push(id);
    return confirmationItem(this.plan, this.status, this.overrides);
  }

  async invalidate(id, input) {
    this.invalidateCalls.push([id, structuredClone(input)]);
    this.status = "stale";
    this.overrides = {
      invalidation: {
        ...structuredClone(input),
        at: "2026-08-02T03:00:00.000Z",
      },
    };
    return confirmationItem(this.plan, this.status, this.overrides);
  }
}

function queuedJob(grant, overrides = {}) {
  return {
    jobId: codeJobIdForGrant(grant),
    status: "queued",
    revision: 1,
    proposalId: grant.proposalId,
    proposalContentDigest: grant.contentDigest,
    grantDigest: grant.grantDigest,
    requestedBy: grant.requestedBy,
    subject: grant.subject,
    repository: grant.repository,
    workspaceId: grant.workspaceId,
    inputBinding: grant.inputBinding,
    operation: grant.operation,
    objective: grant.objective,
    acceptanceCriteria: grant.acceptanceCriteria,
    evidence: grant.evidence,
    summary: grant.summary,
    reason: grant.reason,
    allowedActions: grant.allowedActions,
    writablePaths: grant.writablePaths,
    requiredProfiles: grant.requiredProfiles.map(({ id }) => id),
    turn: 0,
    pendingActionType: null,
    observationCount: 0,
    latestObservation: null,
    terminalResult: null,
    memoryProjection: null,
    pause: null,
    uncertainty: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

class FakeCodeJobReader {
  constructor(value) {
    this.value = value;
    this.getCalls = [];
  }

  async get(id) {
    this.getCalls.push(id);
    return this.value === null ? null : structuredClone(this.value);
  }
}

function handler(producer, reader, grant = grantFor(), overrides = {}) {
  const trusted = authority(grant);
  return {
    trusted,
    value: new CodeActionProposalHandler({
      confirmationProducer: producer,
      codeJobReader: reader,
      grantFactory: trusted.factory,
      clock: () => new Date("2026-08-02T03:00:00.000Z"),
      pollIntervalMs: 5_000,
      ...overrides,
    }),
  };
}

for (const changedCreation of ['unavailable', 'different-current-grant']) test(`an approved handoff follows its original job when new creation is ${changedCreation}`, async () => {
  const grant = grantFor(), producer = new FakeConfirmationProducer('completed'), reader = new FakeCodeJobReader(queuedJob(grant));
  let changed = false, creates = 0, verifies = 0;
  const instance = handler(producer, reader, grant, { grantFactory: {
    async create() {
      creates++;
      if (changed && changedCreation === 'unavailable') throw Object.assign(new Error('creation no longer matches'), { code: 'INVALID_CODE_JOB_AUTHORITY' });
      const { grantDigest, ...input } = grant;
      return authority(changed ? createCodeJobGrant({ ...input, brainDigest: '8'.repeat(64) }) : grant).factory.create(proposal());
    },
    async verify(value) { verifies++; assert.deepEqual(value, grant); return structuredClone(value); },
  } });
  const first = await instance.value.handle(handlerInput());
  changed = true;
  const next = await instance.value.handle(handlerInput({ status: 'running', downstreamRef: first.downstreamRef }));
  assert.equal(next.status, 'running');
  assert.equal(creates, 1, 'polling an approved job does not create another grant');
  assert.equal(verifies, 0, 'observation does not reauthorize an already handed-off job');
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.invalidateCalls.length, 0);
});

for (const code of ['INVALID_CODE_JOB_AUTHORITY', 'CONTROLLED_GIT_TIMEOUT']) test(`an approved handoff follows executor state despite observer verification error ${code}`, async () => {
  const grant = grantFor(), producer = new FakeConfirmationProducer('completed'), reader = new FakeCodeJobReader(queuedJob(grant));
  const instance = handler(producer, reader, grant, { grantFactory: { ...authority(grant).factory,
    async verify() { throw Object.assign(new Error('verification unavailable or revoked'), { code }); } } });
  const first = await instance.value.handle(handlerInput()), reads = reader.getCalls.length;
  const next = await instance.value.handle(handlerInput({ status: 'running', downstreamRef: first.downstreamRef }));
  assert.equal(next.status, 'running');
  assert.equal(reader.getCalls.length, reads + 1);
  reader.value = queuedJob(grant, {
    status: 'fenced', revision: 5,
    terminalResult: { kind: 'fenced', recordedAt: CREATED_AT },
    memoryProjection: { recordId: `memory-${'d'.repeat(64)}`, projectedAt: CREATED_AT },
  });
  const fenced = await instance.value.handle(handlerInput({ status: 'running', downstreamRef: first.downstreamRef }));
  assert.equal(fenced.status, 'unknown');
  assert.ok(fenced.evidence.includes('code-job-status:fenced'));
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.invalidateCalls.length, 0);
});

for (const variant of ['changed-sealed-grant', 'changed-job-grant', 'forged-receipt']) test(`approved grant continuation rejects ${variant}`, async () => {
  const grant = grantFor(), producer = new FakeConfirmationProducer('completed'), reader = new FakeCodeJobReader(queuedJob(grant));
  const instance = handler(producer, reader, grant);
  const first = await instance.value.handle(handlerInput());
  if (variant === 'forged-receipt') producer.overrides = { receipt: { id: `code-job-${'7'.repeat(55)}`, createdAt: CREATED_AT } };
  if (variant === 'changed-sealed-grant') producer.plan.action.grant.brainDigest = '7'.repeat(64);
  if (variant === 'changed-job-grant') reader.value.brainDigest = '7'.repeat(64);
  await assert.rejects(instance.value.handle(handlerInput({ status: 'running', downstreamRef: first.downstreamRef })));
  assert.equal(producer.enqueueCalls.length, 1);
});

test("a proposal is enqueued once and waits on the exact code confirmation", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(grant));
  const instance = handler(producer, reader, grant);

  const transition = await instance.value.handle(handlerInput());

  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 0);
  assert.equal(reader.getCalls.length, 0);
  assert.equal(instance.trusted.calls.length, 1);
  const enqueued = normalizeConfirmationPlan(producer.plan);
  assert.equal(enqueued.action.grant.schemaVersion, 2);
  assert.equal(enqueued.action.grant.inputBinding.headRefOid, HEAD_REF_OID);
  assert.equal(
    enqueued.action.grant.inputBinding.gitTarget.baseRefOid,
    "2".repeat(40),
  );
  assert.deepEqual(
    enqueued.action.grant.inputBinding,
    handlerInput().proposal.binding.inputBinding,
  );
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: producer.plan.id,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("an exact completed approval and queued job advance only to running", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(grant));
  const instance = handler(producer, reader, grant);
  const waiting = await instance.value.handle(handlerInput());
  producer.status = "completed";

  const transition = await instance.value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.deepEqual(transition, {
    status: "running",
    downstreamRef: waiting.downstreamRef,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
  assert.deepEqual(producer.getCalls, [waiting.downstreamRef]);
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
  assert.notEqual(transition.status, "succeeded");
});

test("a terminal code job waits for verified memory before completing its proposal", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(
    queuedJob(grant, {
      status: "completed",
      revision: 5,
      terminalResult: { kind: "completed", recordedAt: CREATED_AT },
      updatedAt: "2026-08-02T03:00:02.000Z",
    }),
  );
  const instance = handler(producer, reader, grant);
  const waiting = await instance.value.handle(handlerInput());
  producer.status = "completed";

  const pendingMemory = await instance.value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );
  assert.equal(pendingMemory.status, "running");

  reader.value = {
    ...reader.value,
    revision: 6,
    memoryProjection: {
      recordId: `memory-${"d".repeat(64)}`,
      projectedAt: "2026-08-02T03:00:03.000Z",
    },
    updatedAt: "2026-08-02T03:00:03.000Z",
  };
  const completed = await instance.value.handle(
    handlerInput({
      status: "running",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.evidence, [
    `confirmation:${waiting.downstreamRef}`,
    `code-job:${codeJobIdForGrant(grant)}`,
    "code-job-status:completed",
    `memory:memory-${"d".repeat(64)}`,
  ]);
});

test("failed verification retains its safe outcome when the proposal settles", async (t) => {
  const labels = {
    CODE_JOB_VERIFICATION_FAILED: "本地验证未通过；请查看测试记录，尚不能认定为产品代码缺陷",
    CODE_JOB_VERIFICATION_TIMEOUT: "本地验证超时；请检查测试耗时和执行环境",
    CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE: "本地验证环境不可用；请检查执行器及依赖",
    CODE_JOB_VERIFICATION_UNKNOWN: "本地验证结果无法判断；请查看执行记录",
  };
  for (const [code, summary] of Object.entries(labels)) {
    await t.test(code, async () => {
      const { contentDigest: _digest, ...base } = proposal();
      const value = normalizeBoundWorkProposal({ ...base, payload: { ...base.payload, operation: "verify" } });
      const grant = grantFor(value);
      const producer = new FakeConfirmationProducer();
      const reader = new FakeCodeJobReader(queuedJob(grant));
      const instance = handler(producer, reader, grant);
      const waiting = await instance.value.handle(handlerInput({ proposal: value }));
      producer.status = "completed";
      reader.value = queuedJob(grant, {
        status: "failed", revision: 5, verificationOutcome: code,
        terminalResult: { kind: "failed", recordedAt: CREATED_AT },
        memoryProjection: { recordId: `memory-${"d".repeat(64)}`, projectedAt: CREATED_AT },
      });
      const result = await instance.value.handle(handlerInput({ proposal: value, status: "running", downstreamRef: waiting.downstreamRef }));
      assert.equal(result.status, "failed");
      assert.equal(result.summary, summary);
      assert.ok(result.evidence.includes(`verification-outcome:${code}`));
    });
  }
});

test("a cancelling job stays active and a projected cancellation becomes rejected", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  producer.plan = createCodeActionProposalConfirmationPlan(
    proposal(),
    await authority(grant).factory.create(proposal()),
  );
  const reader = new FakeCodeJobReader(
    queuedJob(grant, {
      status: "cancelling",
      revision: 5,
      updatedAt: "2026-08-02T03:00:02.000Z",
    }),
  );
  const instance = handler(producer, reader, grant);
  const downstreamRef = codeJobConfirmationIdForGrant(grant);

  const cancelling = await instance.value.handle(
    handlerInput({ status: "running", downstreamRef }),
  );
  assert.equal(cancelling.status, "running");

  reader.value = queuedJob(grant, {
    status: "cancelled",
    revision: 7,
    terminalResult: { kind: "cancelled", recordedAt: CREATED_AT },
    memoryProjection: {
      recordId: `memory-${"e".repeat(64)}`,
      projectedAt: "2026-08-02T03:00:04.000Z",
    },
    updatedAt: "2026-08-02T03:00:04.000Z",
  });
  const cancelled = await instance.value.handle(
    handlerInput({ status: "running", downstreamRef }),
  );

  assert.deepEqual(cancelled, {
    status: "rejected",
    summary: "本地代码任务已由用户取消",
    evidence: [
      `confirmation:${downstreamRef}`,
      `code-job:${codeJobIdForGrant(grant)}`,
      "code-job-status:cancelled",
      `memory:memory-${"e".repeat(64)}`,
    ],
  });
});

test("a legacy queued reader projection remains compatible during local upgrade", async () => {
  const grant = grantFor();
  const legacy = queuedJob(grant);
  delete legacy.uncertainty;
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(legacy);
  const instance = handler(producer, reader, grant);
  const waiting = await instance.value.handle(handlerInput());
  producer.status = "completed";

  const transition = await instance.value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.equal(transition.status, "running");
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
});

test("a queued job remains running without consulting or executing confirmation again", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  producer.plan = createCodeActionProposalConfirmationPlan(
    proposal(),
    await authority(grant).factory.create(proposal()),
  );
  const reader = new FakeCodeJobReader(queuedJob(grant));
  const instance = handler(producer, reader, grant);

  const transition = await instance.value.handle(
    handlerInput({
      status: "running",
      downstreamRef: codeJobConfirmationIdForGrant(grant),
    }),
  );

  assert.equal(transition.status, "running");
  assert.equal(
    transition.downstreamRef,
    codeJobConfirmationIdForGrant(grant),
  );
  assert.equal(producer.enqueueCalls.length, 0);
  assert.equal(producer.getCalls.length, 1);
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
});

test("a pausing code job remains running until admitted work is reconciled", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer();
  producer.plan = createCodeActionProposalConfirmationPlan(
    proposal(),
    await authority(grant).factory.create(proposal()),
  );
  const reader = new FakeCodeJobReader(
    queuedJob(grant, {
      status: "pausing",
      revision: 4,
      pause: {
        reason: "等待已入场动作完成对账",
        at: CREATED_AT,
      },
      updatedAt: "2026-08-02T03:00:02.000Z",
    }),
  );
  const instance = handler(producer, reader, grant);

  const transition = await instance.value.handle(
    handlerInput({
      status: "running",
      downstreamRef: codeJobConfirmationIdForGrant(grant),
    }),
  );

  assert.equal(transition.status, "running");
  assert.equal(producer.enqueueCalls.length, 0);
  assert.equal(producer.getCalls.length, 1);
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
});

test("current and legacy unknown projections remain explicitly reconcilable", async (t) => {
  const cases = [
    {
      name: "active-origin uncertainty",
      createJob(grant) {
        return queuedJob(grant, {
          status: "unknown",
          revision: 5,
          pendingActionType: "read_text",
          uncertainty: {
            from: "active",
            code: "EXECUTOR_RESULT_UNKNOWN",
            message: "执行结果待核验",
            at: "2026-08-02T03:00:02.000Z",
          },
          updatedAt: "2026-08-02T03:00:02.000Z",
        });
      },
    },
    {
      name: "v5 pause-backed uncertainty",
      createJob(grant) {
        const legacy = queuedJob(grant, {
          status: "unknown",
          revision: 5,
          pendingActionType: "read_text",
          pause: {
            reason: "旧版未知动作等待核验",
            at: "2026-08-02T03:00:02.000Z",
          },
          updatedAt: "2026-08-02T03:00:02.000Z",
        });
        delete legacy.uncertainty;
        return legacy;
      },
    },
  ];

  for (const { name, createJob } of cases) {
    await t.test(name, async () => {
      const grant = grantFor();
      const producer = new FakeConfirmationProducer();
      producer.plan = createCodeActionProposalConfirmationPlan(
        proposal(),
        await authority(grant).factory.create(proposal()),
      );
      const reader = new FakeCodeJobReader(createJob(grant));
      const instance = handler(producer, reader, grant);

      const transition = await instance.value.handle(
        handlerInput({
          status: "running",
          downstreamRef: codeJobConfirmationIdForGrant(grant),
        }),
      );

      assert.equal(transition.status, "running");
      assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
    });
  }
});

test("changed authorization invalidates the old pending confirmation", async () => {
  const firstGrant = grantFor();
  const { grantDigest: _grantDigest, ...firstGrantContent } = firstGrant;
  const secondGrant = createCodeJobGrant({
    ...firstGrantContent,
    brainDigest: "d".repeat(64),
  });
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(firstGrant));
  let currentGrant = firstGrant;
  const value = new CodeActionProposalHandler({
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: {
      async create() {
        return authority(currentGrant).factory.create(proposal());
      },
    },
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
  });
  const waiting = await value.handle(handlerInput());
  currentGrant = secondGrant;

  const transition = await value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.equal(transition.status, "stale");
  assert.deepEqual(producer.invalidateCalls, [
    [
      waiting.downstreamRef,
      {
        requestedBy: proposal().requestedBy,
        approvalBindingDigest:
          normalizeConfirmationPlan(producer.plan).approvalBindingDigest,
        reason: "authorization_changed",
      },
    ],
  ]);
  assert.equal(reader.getCalls.length, 0);
});

test("revoked policy invalidates an existing confirmation before it can run", async () => {
  const firstGrant = grantFor();
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(firstGrant));
  let revoked = false;
  const value = new CodeActionProposalHandler({
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: {
      async create() {
        if (revoked) {
          const error = new Error("policy revoked");
          error.code = "INVALID_CODE_JOB_AUTHORITY";
          throw error;
        }
        return authority(firstGrant).factory.create(proposal());
      },
    },
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
  });
  const waiting = await value.handle(handlerInput());
  revoked = true;

  const transition = await value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.equal(transition.status, "stale");
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.invalidateCalls[0][1].reason, "authorization_changed");
  assert.equal(reader.getCalls.length, 0);
});

test("a revoked proposal with no confirmation terminates stale without retry poison", async () => {
  const producer = new FakeConfirmationProducer();
  producer.get = async (id) => {
    producer.getCalls.push(id);
    const error = new Error("not found");
    error.code = "CONFIRMATION_NOT_FOUND";
    throw error;
  };
  const reader = new FakeCodeJobReader(null);
  const value = new CodeActionProposalHandler({
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: {
      async create() {
        const error = new Error("legacy binding is stale");
        error.code = "INVALID_CODE_JOB_AUTHORITY";
        throw error;
      },
    },
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
  });

  const transition = await value.handle(handlerInput());

  assert.equal(transition.status, "stale");
  assert.equal(producer.enqueueCalls.length, 0);
  assert.equal(producer.invalidateCalls.length, 0);
  assert.equal(producer.getCalls.length, 1);
  assert.equal(reader.getCalls.length, 0);
});

test("a persisted legacy PR proposal becomes stale after restart without new admission", async () => {
  const producer = new FakeConfirmationProducer();
  producer.get = async (id) => {
    producer.getCalls.push(id);
    const error = new Error("not found");
    error.code = "CONFIRMATION_NOT_FOUND";
    throw error;
  };
  const reader = new FakeCodeJobReader(null);
  const instance = handler(producer, reader);

  const transition = await instance.value.handle(handlerInput({
    proposal: legacyProposal(),
  }));

  assert.equal(transition.status, "stale");
  assert.equal(instance.trusted.calls.length, 0);
  assert.equal(producer.enqueueCalls.length, 0);
  assert.equal(producer.invalidateCalls.length, 0);
  assert.equal(producer.getCalls.length, 1);
  assert.equal(reader.getCalls.length, 0);

  const recovered = await instance.value.handle(handlerInput({
    proposal: legacyProposal(),
    status: "waiting_confirmation",
    downstreamRef: codeJobConfirmationIdForProposal(legacyProposal()),
  }));
  assert.equal(recovered.status, "stale");
  assert.equal(instance.trusted.calls.length, 0);
  assert.equal(producer.getCalls.length, 2);
});

test("a lost proposal advance still finds and revokes its stable confirmation slot", async () => {
  const firstGrant = grantFor();
  const { grantDigest: _grantDigest, ...firstGrantContent } = firstGrant;
  const secondGrant = createCodeJobGrant({
    ...firstGrantContent,
    workspaceAuthorityDigest: "8".repeat(64),
  });
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(firstGrant));
  let currentGrant = firstGrant;
  const value = new CodeActionProposalHandler({
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: {
      async create() {
        return authority(currentGrant).factory.create(proposal());
      },
    },
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
  });

  await value.handle(handlerInput());
  currentGrant = secondGrant;
  const transition = await value.handle(handlerInput());

  assert.equal(transition.status, "stale");
  assert.equal(producer.enqueueCalls.length, 2);
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.invalidateCalls[0][1].reason, "authorization_changed");
  assert.equal(reader.getCalls.length, 0);
});

test("an already completed handoff follows the original job without a grant verification port", async () => {
  const firstGrant = grantFor();
  const { grantDigest: _grantDigest, ...firstGrantContent } = firstGrant;
  const secondGrant = createCodeJobGrant({
    ...firstGrantContent,
    brainDigest: "d".repeat(64),
  });
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(firstGrant));
  let currentGrant = firstGrant;
  const value = new CodeActionProposalHandler({
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: {
      async create() {
        return authority(currentGrant).factory.create(proposal());
      },
    },
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
  });
  const waiting = await value.handle(handlerInput());
  producer.status = "completed";
  currentGrant = secondGrant;

  const transition = await value.handle(
    handlerInput({
      status: "waiting_confirmation",
      downstreamRef: waiting.downstreamRef,
    }),
  );

  assert.equal(transition.status, "running");
  assert.equal(producer.invalidateCalls.length, 0);
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(firstGrant)]);
});

test("rejected, stale, and failed confirmations never start a code job", async (t) => {
  const failureAt = "2026-08-02T03:00:00.000Z";
  const cases = [
    [
      "rejected",
      {
        rejection: {
          requestId: "reject-request-1",
          reason: "",
          at: failureAt,
        },
      },
      "rejected",
    ],
    ["stale", {}, "stale"],
    [
      "failed",
      {
        failure: {
          code: "CODE_JOB_NOT_CREATED",
          outcome: "absent",
          retryable: true,
          at: failureAt,
        },
        retryable: true,
      },
      "waiting_retry",
    ],
    [
      "failed",
      {
        failure: {
          code: "CODE_JOB_OUTCOME_UNKNOWN",
          outcome: "unknown",
          retryable: false,
          at: failureAt,
        },
      },
      "unknown",
    ],
  ];

  for (const [status, overrides, expectedStatus] of cases) {
    await t.test(`${status} -> ${expectedStatus}`, async () => {
      const grant = grantFor();
      const producer = new FakeConfirmationProducer(status, overrides);
      const reader = new FakeCodeJobReader(queuedJob(grant));
      const instance = handler(producer, reader, grant);
      const transition = await instance.value.handle(handlerInput());
      assert.equal(transition.status, expectedStatus);
      assert.equal(reader.getCalls.length, 0);
      assert.notEqual(transition.status, "running");
      assert.notEqual(transition.status, "succeeded");
    });
  }
});

test("receipt, confirmation, and job binding mismatches fail closed", async () => {
  const grant = grantFor();
  const jobId = codeJobIdForGrant(grant);
  const cases = [
    {
      confirmation: {
        approvalBindingDigest: "f".repeat(64),
      },
      job: queuedJob(grant),
    },
    {
      confirmation: {
        receipt: { id: jobId, createdAt: "2026-08-02T03:00:02.000Z" },
      },
      job: queuedJob(grant),
    },
    {
      confirmation: {},
      job: queuedJob(grant, {
        inputBinding: {
          ...grant.inputBinding,
          headRefOid: "2".repeat(40),
        },
      }),
    },
    {
      confirmation: {},
      job: queuedJob(grant, { grantDigest: "f".repeat(64) }),
    },
    {
      confirmation: {},
      job: queuedJob(grant, { updatedAt: "2026-08-02T02:59:59.000Z" }),
    },
    {
      confirmation: {},
      job: queuedJob(grant, {
        status: "active",
        pendingActionType: "shell_command",
        updatedAt: "2026-08-02T03:00:02.000Z",
      }),
    },
    {
      confirmation: {},
      job: queuedJob(grant, {
        status: "unknown",
        pendingActionType: "read_text",
        pause: { reason: "伪造暂停", at: CREATED_AT },
        uncertainty: {
          from: "active",
          code: "EXECUTOR_RESULT_UNKNOWN",
          message: "来源与暂停状态冲突",
          at: CREATED_AT,
        },
      }),
    },
    { confirmation: {}, job: null },
  ];

  for (const [index, { confirmation, job }] of cases.entries()) {
    const producer = new FakeConfirmationProducer("completed", confirmation);
    const reader = new FakeCodeJobReader(job);
    const instance = handler(producer, reader, grant);
    await assert.rejects(
      instance.value.handle(handlerInput()),
      (error) =>
        [
          "INVALID_CODE_ACTION_CONFIRMATION",
          "INVALID_CODE_JOB_RESULT",
        ].includes(error?.code),
      `binding mismatch case ${index + 1}`,
    );
  }
});

test("resumed queued jobs retain receipt authority when their update timestamp advances", async () => {
  const grant = grantFor();
  const producer = new FakeConfirmationProducer("completed");
  const reader = new FakeCodeJobReader(queuedJob(grant, {
    revision: 3,
    updatedAt: "2026-08-02T03:00:02.000Z",
  }));
  const instance = handler(producer, reader, grant);
  const transition = await instance.value.handle(handlerInput());
  assert.equal(transition.status, "running");
  assert.deepEqual(reader.getCalls, [codeJobIdForGrant(grant)]);
});

test("runner factory stays disabled by default and rejects incomplete authority", () => {
  assert.equal(createCodeActionProposalRunnerService({}), null);
  assert.equal(
    createCodeActionProposalRunnerService({ enabled: false }),
    null,
  );
  assert.throws(
    () => createCodeActionProposalRunnerService({ enabled: true }),
    /runner|confirmation|codeJob|grantFactory/,
  );
});

class MemoryStore {
  constructor() {
    this.value = null;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

class Guard {
  async acquire() {}
  run(operation) {
    return operation();
  }
  async close() {}
}

test("temporary real grant verification failures retry without making the proposal or pending confirmation stale", async (t) => {
  const value = proposal();
  const store = new MemoryStore();
  let now = Date.parse("2026-08-02T03:00:00.000Z");
  let unavailableCode = "WORK_LEDGER_NOT_READY";
  const grantFactory = new CodeJobGrantFactory({
    executorAuthority: {
      workspaces: [{
        id: "acme-workspace",
        capabilities: ["git_head_snapshot"],
        writablePaths: ["src"],
        requiredProfiles: [{ id: "node-tests", configDigest: "b".repeat(64) }],
        authorityDigest: "9".repeat(64),
      }],
    },
    policyVersion: 7,
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    codeActionRoles: ["developer"],
    codeOperationsByRole: { developer: ["modify"] },
    taskBrainByRole: {
      developer: {
        provider: "ollama", model: "qwen3.5:9b",
        remoteData: { requirements: false, code: false, memory: false },
      },
    },
    brainProviders: { ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" } },
    inputAuthorityVerifier: {
      async verify(binding) {
        if (unavailableCode !== null) {
          throw Object.assign(new Error("authority verification is temporarily unavailable"), { code: unavailableCode });
        }
        return structuredClone(binding);
      },
    },
  });
  const runtime = await createWorkProposalRuntime({
    store,
    clock: () => new Date(now),
    idFactory: () => "code-proposal-operational-lease",
    runnerScopes: [{
      runnerId: "code-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer"],
    }],
    createGuard: () => new Guard(),
  });
  t.after(() => runtime.close());
  const producer = new FakeConfirmationProducer();
  producer.get = async (id) => {
    producer.getCalls.push(id);
    if (producer.plan === null) {
      throw Object.assign(new Error("confirmation not created"), { code: "CONFIRMATION_NOT_FOUND" });
    }
    return confirmationItem(producer.plan, producer.status, producer.overrides);
  };
  const reader = new FakeCodeJobReader(null);
  const service = createCodeActionProposalRunnerService({
    enabled: true,
    runner: runtime.runners["code-runner"],
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory,
    clock: () => new Date(now),
    pollIntervalMs: 1_000,
    leaseDurationMs: 30_000,
  });
  const { contentDigest: _contentDigest, ...input } = value;
  await runtime.producer.create(input);

  const failed = await service.runCycle({ limit: 1 });
  assert.equal(failed.outcomes[0].status, "waiting_retry");
  assert.equal(store.value.proposals[0].lastError.reason, "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE");
  assert.equal(store.value.proposals[0].nextAttemptAt, "2026-08-02T03:00:30.000Z");
  assert.equal(store.value.proposals[0].downstreamRef, null);
  assert.equal(store.value.results.length, 0);
  assert.equal(producer.enqueueCalls.length, 0);
  assert.equal(producer.invalidateCalls.length, 0);
  assert.deepEqual(reader.getCalls, []);

  unavailableCode = null;
  now += 30_000;
  await service.runCycle({ limit: 1 });
  const confirmationId = codeJobConfirmationIdForProposal(value);
  assert.equal(store.value.proposals[0].status, "waiting_confirmation");
  assert.equal(store.value.proposals[0].downstreamRef, confirmationId);
  assert.equal(producer.plan.id, confirmationId);
  assert.equal(producer.enqueueCalls.length, 1);

  unavailableCode = "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE";
  now += 1_000;
  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "waiting_retry");
  assert.equal(store.value.proposals[0].lastError.reason, "CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE");
  assert.equal(store.value.proposals[0].downstreamRef, confirmationId);
  assert.equal(producer.status, "pending");
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.invalidateCalls.length, 0);
  assert.equal(store.value.results.length, 0);
  assert.deepEqual(reader.getCalls, []);

  const retryAt = Date.parse(store.value.proposals[0].nextAttemptAt);
  now = retryAt - 1;
  assert.equal((await service.runCycle({ limit: 1 })).claimed, 0);
  unavailableCode = null;
  now = retryAt;
  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "waiting_confirmation");
  assert.equal(store.value.proposals[0].downstreamRef, confirmationId);
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.invalidateCalls.length, 0);
  assert.equal(store.value.results.length, 0);
  assert.deepEqual(reader.getCalls, []);
});

test("the real proposal runner continues the approved original grant when creation rules change", async () => {
  const value = proposal();
  const grant = grantFor(value);
  const store = new MemoryStore();
  let now = Date.parse("2026-08-02T03:00:00.000Z");
  const runtime = await createWorkProposalRuntime({
    store,
    clock: () => new Date(now),
    idFactory: () => "code-proposal-lease",
    runnerScopes: [
      {
        runnerId: "code-runner",
        allowedKinds: ["code_action_proposal"],
        allowedRoleIds: ["developer"],
      },
    ],
    createGuard: () => new Guard(),
  });
  const producer = new FakeConfirmationProducer();
  const reader = new FakeCodeJobReader(queuedJob(grant));
  const trusted = authority(grant);
  let verifies = 0;
  let creationChanged = false;
  const create = trusted.factory.create;
  trusted.factory.create = async value => {
    if (creationChanged) throw Object.assign(new Error('new creation is unavailable'), { code: 'INVALID_CODE_JOB_AUTHORITY' });
    return create(value);
  };
  trusted.factory.verify = async value => { verifies++; assert.deepEqual(value, grant); return value; };
  const service = createCodeActionProposalRunnerService({
    enabled: true,
    runner: runtime.runners["code-runner"],
    confirmationProducer: producer,
    codeJobReader: reader,
    grantFactory: trusted.factory,
    clock: () => new Date(now),
    pollIntervalMs: 1_000,
    leaseDurationMs: 30_000,
  });
  const { contentDigest: _contentDigest, ...input } = value;
  await runtime.producer.create(input);

  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "waiting_confirmation");
  assert.equal(store.value.results.length, 0);

  producer.status = "completed";
  creationChanged = true;
  now += 1_000;
  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "running");
  assert.equal(store.value.proposals[0].downstreamRef, producer.plan.id);
  assert.equal(store.value.results.length, 0);

  now += 1_000;
  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "running");
  assert.equal(store.value.results.length, 0);
  assert.equal(trusted.calls.length, 1);
  assert.equal(verifies, 0);
  await runtime.close();
});
