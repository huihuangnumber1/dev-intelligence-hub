import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { createReviewHandoff } from "../src/domain/review-handoff.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import {
  GitHubReviewProposalHandler,
  createGitHubReviewProposalRunnerService,
} from "../src/services/github-review-proposal-handler.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";
import { ConfirmationQueue, ConfirmationExecutionError } from "../src/services/confirmation-queue.js";
import { AutomaticReviewPublisher } from "../src/services/automatic-review-publisher.js";

const HEAD_REF_OID = "b".repeat(40);

test("explicit publication reuse bypasses every GitHub publishing path and cannot fall back", async () => {
  const input = handlerInput();
  const { contentDigest, ...content } = input.proposal;
  input.proposal = normalizeBoundWorkProposal({ ...content, payload: { ...content.payload,
    publicationReuse: { candidateId: "review-publication-candidate-" + "c".repeat(64), materialDigest: "d".repeat(64), coverageDigest: "e".repeat(64) } } });
  const forbidden = () => assert.fail("reuse must not enter normal confirmation/publication authority");
  const options = { confirmationProducer: { enqueue: forbidden, get: forbidden, invalidate: forbidden },
    inputAuthorityVerifier: { verify: forbidden }, actorAccountId: "review-account", automaticReviewPublisher: { publish: forbidden } };
  const transition = { status: "succeeded", summary: "Existing Review adopted locally", evidence: ["adoption:verified"] };
  let calls = 0;
  const handler = new GitHubReviewProposalHandler({ ...options, publicationAdopter: { async handle(value) {
    calls++; assert.deepEqual(value.proposal, input.proposal); return transition;
  } } });
  assert.deepEqual(await handler.handle(input), transition);
  assert.equal(calls, 1);
  await assert.rejects(new GitHubReviewProposalHandler(options).handle(input), { code: "REVIEW_PUBLICATION_REUSE_UNAVAILABLE" });
  const changed = Object.assign(new Error("Coverage changed"), { code: "REVIEW_PUBLICATION_REUSE_COVERAGE_CHANGED" });
  await assert.rejects(new GitHubReviewProposalHandler({ ...options, publicationAdopter: { async handle() { throw changed; } } }).handle(input), error => error === changed);
});

test('a lost Review downstream reference recovers the completed receipt after assignment leaves scope', async () => {
  const clock = () => new Date('2026-10-09T10:00:00.000Z');
  const store = new MemoryStore(); let writes = 0;
  const executor = { async execute() { writes++; return { status: 'applied', receipt: {
    id: 'published-review', url: 'https://github.com/acme/repo/pull/42#pullrequestreview-42', createdAt: clock().toISOString() } }; },
    async reconcile() { throw new Error('an observed completed Review must not be replayed'); } };
  const queue = new ConfirmationQueue({ store, exclusiveLease: new Guard(), clock, executor });
  await queue.recover();
  const publisher = new AutomaticReviewPublisher({ enabled: true, queue, clock, github: { async readIncomingReviewRequest() {
    return { kind: 'pull_request', state: 'open', isDraft: false, author: 'developer', currentUser: 'review-account',
      headRefOid: HEAD_REF_OID, incomingReviewFactsAvailable: true, reviewRecipient: 'review-account',
      reviewReceivedAt: '2026-10-09T09:00:00Z', reviewReceivedVia: 'assignee', reviewReceivedFrom: 'developer', reviewRequestEventId: 'AE_42' };
  } } });
  const first = new GitHubReviewProposalHandler({ confirmationProducer: queue, inputAuthorityVerifier: acceptingVerifier(),
    actorAccountId: 'review-account', clock, automaticReviewPublisher: publisher });
  assert.equal((await first.handle(handlerInput())).status, 'succeeded');
  const restarted = new ConfirmationQueue({ store, exclusiveLease: new Guard(), clock, executor }); await restarted.recover();
  const expected = normalizeConfirmationPlan(createGitHubReviewProposalConfirmationPlan(handlerInput().proposal,
    { actorAccountId: 'review-account', legacyRecovery: true }));
  const observed = await restarted.get(expected.id);
  for (const key of ['requestedBy', 'actor', 'target', 'display', 'displayedPayloadDigest', 'approvalBindingDigest']) {
    assert.deepEqual(observed[key], expected[key], key);
  }
  const recovery = new GitHubReviewProposalHandler({ confirmationProducer: restarted, actorAccountId: 'review-account', clock,
    inputAuthorityVerifier: { async verify() { throw new Error('the automatic assignment already moved to the author'); } } });
  const result = await recovery.handle(handlerInput({ status: 'waiting_retry', attempt: 2, downstreamRef: null }));
  assert.equal(result.status, 'succeeded');
  assert.ok(result.evidence.some(value => value.startsWith('confirmation:')));
  assert.equal(writes, 1);
  assert.equal((await restarted.readReviewHandoffs()).length, 1);
});

test("automatic proposals publish once, persist history and recover their handoff without user confirmation", async () => {
  const clock = () => new Date("2026-10-09T10:00:00.000Z");
  const store = new MemoryStore();
  let writes = 0;
  const executor = {
    async execute() { writes++; return { status: "applied", receipt: { id: "42", url: "https://github.com/acme/repo/pull/42#pullrequestreview-42", createdAt: clock().toISOString() } }; },
    async reconcile() { return { status: "unknown", code: "GITHUB_UNAVAILABLE" }; },
  };
  const queue = new ConfirmationQueue({ store, exclusiveLease: new Guard(), clock, executor });
  await queue.recover();
  const publisher = new AutomaticReviewPublisher({ enabled: true, queue, clock,
    github: { async readIncomingReviewRequest() { return { kind: "pull_request", state: "open", isDraft: false, author: "developer", currentUser: "review-account", headRefOid: HEAD_REF_OID,
      incomingReviewFactsAvailable: true, reviewRecipient: "review-account", reviewReceivedAt: "2026-10-09T09:00:00Z", reviewReceivedVia: "assignee", reviewReceivedFrom: "developer", reviewRequestEventId: "AE_42" }; } },
  });
  const handler = new GitHubReviewProposalHandler({ confirmationProducer: queue, inputAuthorityVerifier: acceptingVerifier(), actorAccountId: "review-account", clock, automaticReviewPublisher: publisher });
  const first = await handler.handle(handlerInput());
  assert.equal(first.status, "succeeded", JSON.stringify(await queue.list({})));
  assert.equal((await handler.handle(handlerInput())).status, "succeeded");
  assert.equal(writes, 1);
  const history = await queue.list({ automatic: true });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].automaticReview.event, "REQUEST_CHANGES");
  assert.equal(history.items[0].automaticReview.headRefOid, HEAD_REF_OID);
  assert.equal(history.items[0].automaticReview.publishedUrl, "https://github.com/acme/repo/pull/42#pullrequestreview-42");
  const restarted = new ConfirmationQueue({ store, exclusiveLease: new Guard(), clock, executor });
  await restarted.recover();
  const pending = await restarted.readReviewHandoffs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].automaticReview.reviewEvent, "REQUEST_CHANGES");
  assert.equal(writes, 1);
});

function inputBindingFor(number, { schemaVersion = 2 } = {}) {
  const binding = {
    schemaVersion,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: number,
    rootItemId: `work-${number}`,
    workKey: `github:dashboard:acme-repo:${number}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: HEAD_REF_OID,
    eventId: `event-${number}`,
    eventDigest: `${"c".repeat(63)}${number % 10}`,
    inputDigest: `${"d".repeat(63)}${number % 10}`,
  };
  if (schemaVersion === 2) {
    binding.gitTarget = {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "review-account",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/review",
      headRefOid: HEAD_REF_OID,
    };
  }
  return binding;
}

function proposal(number = 42, { schemaVersion = 2 } = {}) {
  return normalizeBoundWorkProposal({
    proposalId: `work-intent-${"a".repeat(63)}${number % 10}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: `work-${number}` },
    source: { assignmentId: `assignment-${number}`, eventId: `event-${number}` },
    binding: {
      eventId: `event-${number}`,
      subject: { repository: "acme/repo", number },
      repository: "acme/repo",
      pullRequestNumber: number,
      headRefOid: HEAD_REF_OID,
      inputBinding: inputBindingFor(number, { schemaVersion }),
    },
    payload: {
      verdict: "request_changes",
      body: "请先补充失败分支测试。",
      evidence: ["缺少失败路径覆盖"],
      summary: "建议修改",
      reason: "风险尚未覆盖",
    },
  });
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
    if (
      this.plan !== null &&
      this.plan.id !== plan.id &&
      this.status === "stale"
    ) {
      this.status = "pending";
      this.overrides = {};
    }
    this.plan = structuredClone(plan);
    this.enqueueCalls.push(structuredClone(plan));
    return confirmationItem(plan, this.status, this.overrides);
  }

  async get(id) {
    this.getCalls.push(id);
    if (this.plan === null || this.plan.id !== id) throw Object.assign(new Error("missing"), { code: "CONFIRMATION_NOT_FOUND" });
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

function acceptingVerifier() {
  return {
    calls: [],
    async verify(value) {
      this.calls.push(structuredClone(value));
      return structuredClone(value);
    },
  };
}

function acceptingContextReader(author = "contributor") {
  return {
    calls: [],
    async readCurrent(value) {
      this.calls.push(structuredClone(value));
      return {
        inputBinding: structuredClone(value),
        author,
      };
    },
  };
}

function handler(producer, overrides = {}) {
  return new GitHubReviewProposalHandler({
    confirmationProducer: producer,
    inputAuthorityVerifier: acceptingVerifier(),
    pullRequestContextReader: acceptingContextReader(),
    actorAccountId: "review-account",
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    pollIntervalMs: 5_000,
    ...overrides,
  });
}

test("durable local handoff metadata does not change successful Review settlement", async () => {
  const producer = new FakeConfirmationProducer();
  const reviewHandler = handler(producer);
  const waiting = await reviewHandler.handle(handlerInput());
  producer.status = "completed";
  producer.overrides = {
    receipt: { id: "published-review" },
    reviewHandoff: createReviewHandoff(normalizeConfirmationPlan(producer.plan), {
      requestId: "approve-request-42",
      reviewHandoff: { workType: "development", responsiblePerson: null },
    }, {}),
  };
  const result = await reviewHandler.handle(handlerInput({ downstreamRef: waiting.downstreamRef }));
  assert.equal(result.status, "succeeded");
  producer.overrides.reviewHandoff.requestId = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(reviewHandler.handle(handlerInput({ downstreamRef: waiting.downstreamRef })));
});

test("a pending proposal is idempotently enqueued and waits on its exact confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const verifier = acceptingVerifier();
  const contextReader = acceptingContextReader();
  const transition = await handler(producer, {
    inputAuthorityVerifier: verifier,
    pullRequestContextReader: contextReader,
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 0);
  assert.equal(verifier.calls.length, 0);
  assert.deepEqual(contextReader.calls, [
    handlerInput().proposal.binding.inputBinding,
  ]);
  assert.match(
    producer.enqueueCalls[0].id,
    /^confirmation-github-review-[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    producer.enqueueCalls[0].action.inputBinding,
    handlerInput().proposal.binding.inputBinding,
  );
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: producer.enqueueCalls[0].id,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("a self-authored blocking proposal is queued as a COMMENT review", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer, {
    pullRequestContextReader: acceptingContextReader("REVIEW-ACCOUNT"),
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "COMMENT");
  assert.equal(
    producer.enqueueCalls[0].display.actionLabel,
    "确认并以 COMMENT 发布到 GitHub",
  );
});

test('automatic mode retires an existing own-PR COMMENT confirmation without publishing or replacing it', async () => {
  const producer = new FakeConfirmationProducer();
  const options = { pullRequestContextReader: acceptingContextReader('review-account') };
  const waiting = await handler(producer, options).handle(handlerInput());
  const publisher = new AutomaticReviewPublisher({ enabled: true, queue: { approve: async () => assert.fail('No self Review') },
    confirmationInvalidator: producer, github: { readIncomingReviewRequest: async () => ({ kind: 'pull_request',
      incomingReviewFactsAvailable: true, state: 'open', isDraft: false, author: 'review-account',
      currentUser: 'review-account', headRefOid: HEAD_REF_OID }) } });
  const result = await handler(producer, { ...options, automaticReviewPublisher: publisher }).handle(handlerInput({
    status: 'waiting_confirmation', attempt: 2, downstreamRef: waiting.downstreamRef }));
  assert.equal(result.status, 'stale');
  assert.equal(producer.status, 'stale');
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.enqueueCalls.length, 1, 'no replacement confirmation is created');
});

test("review authority accepts the ledger's optional feedback digest and keeps rejecting invalid contexts", async () => {
  for (const extra of [{}, { reviewFeedbackDigest: "a".repeat(64) },
    { reviewFeedbackDigest: null }, { reviewFeedbackDigest: "invalid" },
    { reviewFeedbackDigest: "a".repeat(64), unexpected: true }]) {
    const producer = new FakeConfirmationProducer();
    const valid = Object.keys(extra).length === 0 ||
      (Object.keys(extra).length === 1 && extra.reviewFeedbackDigest === "a".repeat(64));
    const result = await handler(producer, { pullRequestContextReader: { async readCurrent(inputBinding) {
      return { inputBinding, author: "review-account", ...extra };
    } } }).handle(handlerInput());
    assert.equal(producer.enqueueCalls.length, valid ? 1 : 0, JSON.stringify(extra));
    if (valid) assert.equal(producer.enqueueCalls[0].action.reviewEvent, "COMMENT");
    else assert.equal(result.status, "stale");
  }
});

test("missing author context preserves the proposed verdict", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer, {
    pullRequestContextReader: acceptingContextReader(null),
  }).handle(handlerInput());

  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "REQUEST_CHANGES");
  assert.equal(
    producer.enqueueCalls[0].display.actionLabel,
    "确认并发布到 GitHub",
  );
});

test("a pending legacy self-review is invalidated and replaced by COMMENT", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer).handle(handlerInput());
  const legacyId = producer.plan.id;
  producer.enqueueCalls.length = 0;

  const transition = await handler(producer, {
    pullRequestContextReader: acceptingContextReader("review-account"),
  }).handle(handlerInput({
    status: "waiting_confirmation",
    downstreamRef: legacyId,
  }));

  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.enqueueCalls.length, 1);
  assert.notEqual(producer.enqueueCalls[0].id, legacyId);
  assert.equal(producer.enqueueCalls[0].action.reviewEvent, "COMMENT");
  assert.deepEqual(transition, {
    status: "waiting_confirmation",
    downstreamRef: legacyId,
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
});

test("a pending v1 self-comment is migrated to the lifecycle-bound confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const legacyPlan = createGitHubReviewProposalConfirmationPlan(
    handlerInput().proposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
      legacySelfAuthored: true,
    },
  );
  await producer.enqueue(legacyPlan);
  producer.enqueueCalls.length = 0;

  const transition = await handler(producer, {
    pullRequestContextReader: acceptingContextReader("review-account"),
  }).handle(handlerInput({
    status: "waiting_confirmation",
    downstreamRef: legacyPlan.id,
  }));

  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(
    producer.enqueueCalls[0].display.payload.reviewIntent,
    "REQUEST_CHANGES",
  );
  assert.equal(transition.downstreamRef, legacyPlan.id);
});

test("a bound proposal polls get without enqueuing another action", async () => {
  const producer = new FakeConfirmationProducer();
  await handler(producer).handle(handlerInput());
  producer.enqueueCalls.length = 0;
  const downstreamRef = producer.plan.id;

  const transition = await handler(producer).handle(
    handlerInput({ status: "waiting_confirmation", downstreamRef }),
  );

  assert.equal(producer.enqueueCalls.length, 0);
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(transition.downstreamRef, downstreamRef);
});

test("confirmation outcomes map to bounded proposal transitions", async (t) => {
  const cases = [
    ["pending", {}, "waiting_confirmation"],
    ["executing", {}, "waiting_confirmation"],
    ["completed", { receipt: { id: "review-42" } }, "succeeded"],
    [
      "rejected",
      { rejection: { requestId: "reject-1", reason: "不发布", at: "2026-08-02T03:00:00.000Z" } },
      "rejected",
    ],
    [
      "stale",
      {
        invalidation: {
          reason: "work_item_superseded",
          requestedBy: proposal().requestedBy,
          approvalBindingDigest: "c".repeat(64),
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "stale",
    ],
    [
      "failed",
      {
        failure: {
          code: "EXTERNAL_OUTCOME_UNKNOWN",
          outcome: "unknown",
          retryable: false,
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "unknown",
    ],
    [
      "failed",
      {
        retryable: true,
        failure: {
          code: "EXTERNAL_ACTION_ABSENT",
          outcome: "absent",
          retryable: true,
          at: "2026-08-02T03:00:00.000Z",
        },
      },
      "waiting_retry",
    ],
  ];

  for (const [status, itemOverrides, expected] of cases) {
    await t.test(status + (itemOverrides.retryable ? " retryable" : ""), async () => {
      const producer = new FakeConfirmationProducer(status, itemOverrides);
      const transition = await handler(producer).handle(handlerInput());
      assert.equal(transition.status, expected);
      if (["succeeded", "rejected", "stale", "unknown"].includes(expected)) {
        assert.equal(typeof transition.summary, "string");
        assert.equal(Array.isArray(transition.evidence), true);
      }
    });
  }
});

test("mismatched confirmation bindings fail closed", async () => {
  const producers = [
    new FakeConfirmationProducer("pending", {
      approvalBindingDigest: "f".repeat(64),
    }),
    new FakeConfirmationProducer("pending", {
      display: {
        title: "被篡改的动作",
        summary: "错误目标",
        actionLabel: "发布",
        evidence: [],
        payload: {},
      },
    }),
  ];

  for (const producer of producers) {
    await assert.rejects(
      handler(producer).handle(handlerInput()),
      (error) => error.code === "INVALID_GITHUB_REVIEW_CONFIRMATION",
    );
  }
});

test("revoked target authority prevents enqueue and invalidates an existing confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const revoked = {
    async readCurrent() {
      throw Object.assign(new Error("stale"), {
        code: "WORK_LEDGER_PR_BINDING_STALE",
      });
    },
  };

  const beforeEnqueue = await handler(producer, {
    pullRequestContextReader: revoked,
  }).handle(handlerInput());
  assert.equal(beforeEnqueue.status, "stale");
  assert.equal(producer.enqueueCalls.length, 0);

  await handler(producer).handle(handlerInput());
  const downstreamRef = producer.plan.id;
  const afterEnqueue = await handler(producer, {
    pullRequestContextReader: revoked,
  }).handle(
    handlerInput({ status: "waiting_confirmation", downstreamRef }),
  );
  assert.equal(afterEnqueue.status, "stale");
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(
    producer.invalidateCalls[0][1].reason,
    "authorization_changed",
  );
});

test("a revoked historical Review assignment withdraws its pending confirmation", async () => {
  const producer = new FakeConfirmationProducer();
  const waiting = await handler(producer).handle(handlerInput());
  const reader = { async readCurrent() { throw Object.assign(new Error("Assign changed"), {
    code: "OWNER_REVIEW_ASSIGNMENT_REVOKED" }); } };
  const result = await handler(producer, { pullRequestContextReader: reader }).handle(handlerInput({
    status: "waiting_confirmation", downstreamRef: waiting.downstreamRef }));
  assert.equal(result.status, "stale");
  assert.equal(producer.invalidateCalls.length, 1);
  assert.equal(producer.status, "stale");
});

test("unavailable assignment facts defer a Review without withdrawing or reenqueuing it", async () => {
  const producer = new FakeConfirmationProducer();
  const waiting = await handler(producer).handle(handlerInput());
  const unavailable = Object.assign(new Error("GitHub unavailable"), { code: "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE" });
  for (const override of [
    { pullRequestContextReader: { async readCurrent() { throw unavailable; } } },
    { pullRequestContextReader: undefined, inputAuthorityVerifier: { async verify() { throw unavailable; } } },
  ]) {
    await assert.rejects(handler(producer, override).handle(handlerInput({
      status: "waiting_confirmation", downstreamRef: waiting.downstreamRef })), { code: unavailable.code });
  }
  assert.equal(producer.status, "pending");
  assert.equal(producer.invalidateCalls.length, 0);
  assert.equal(producer.enqueueCalls.length, 1);
});

test("a completed self-authored Review settles after its source authority becomes stale", async () => {
  const producer = new FakeConfirmationProducer();
  const selfAuthoredHandler = handler(producer, {
    pullRequestContextReader: acceptingContextReader("REVIEW-ACCOUNT"),
  });
  const waiting = await selfAuthoredHandler.handle(handlerInput());
  producer.status = "completed";
  producer.overrides = { receipt: { id: "published-self-review" } };

  const transition = await handler(producer, {
    pullRequestContextReader: {
      async readCurrent() {
        throw Object.assign(new Error("stale"), {
          code: "WORK_LEDGER_PR_BINDING_STALE",
        });
      },
    },
  }).handle(handlerInput({
    status: "waiting_retry",
    downstreamRef: waiting.downstreamRef,
  }));

  assert.equal(transition.status, "succeeded");
  assert.equal(producer.invalidateCalls.length, 0);
});

test("a rejected unversioned self-authored Review settles after its source changes", async () => {
  const producer = new FakeConfirmationProducer();
  const legacyPlan = createGitHubReviewProposalConfirmationPlan(
    handlerInput().proposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
      legacyUnversionedSelfAuthored: true,
    },
  );
  await producer.enqueue(legacyPlan);
  producer.status = "rejected";
  producer.overrides = {
    rejection: {
      requestId: "reject-legacy-self-review",
      reason: "不发布",
      at: "2026-08-02T03:00:00.000Z",
    },
  };

  const transition = await handler(producer, {
    pullRequestContextReader: {
      async readCurrent() {
        throw Object.assign(new Error("stale"), {
          code: "WORK_LEDGER_PR_BINDING_STALE",
        });
      },
    },
  }).handle(handlerInput({
    status: "waiting_retry",
    downstreamRef: legacyPlan.id,
  }));

  assert.equal(transition.status, "rejected");
  assert.equal(producer.invalidateCalls.length, 0);
});

test("the legacy verifier remains the authority fallback without a context reader", async () => {
  const producer = new FakeConfirmationProducer();
  const verifier = acceptingVerifier();

  await handler(producer, {
    inputAuthorityVerifier: verifier,
    pullRequestContextReader: undefined,
  }).handle(handlerInput());

  assert.deepEqual(verifier.calls, [
    handlerInput().proposal.binding.inputBinding,
  ]);
  assert.equal(producer.enqueueCalls.length, 1);
});

test("persisted v1 review proposals terminate stale instead of retrying forever", async () => {
  const producer = new FakeConfirmationProducer();
  const legacyInput = handlerInput({ proposal: proposal(42, { schemaVersion: 1 }) });

  const transition = await handler(producer).handle(legacyInput);

  assert.equal(transition.status, "stale");
  assert.equal(producer.enqueueCalls.length, 0);
});

test("persisted v1 review proposals recover stale when their confirmation is missing", async () => {
  const legacyProposal = proposal(42, { schemaVersion: 1 });
  const downstreamRef = createGitHubReviewProposalConfirmationPlan(
    legacyProposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
    },
  ).id;
  const producer = new FakeConfirmationProducer();
  producer.get = async function get(id) {
    this.getCalls.push(id);
    throw Object.assign(new Error("confirmation missing"), {
      code: "CONFIRMATION_NOT_FOUND",
    });
  };

  const transition = await handler(producer).handle(
    handlerInput({
      proposal: legacyProposal,
      status: "waiting_confirmation",
      downstreamRef,
    }),
  );

  assert.equal(transition.status, "stale");
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(producer.enqueueCalls.length, 0);
});

test("persisted v2 review proposals fail closed when their confirmation is missing", async () => {
  const currentProposal = proposal();
  const downstreamRef = createGitHubReviewProposalConfirmationPlan(
    currentProposal,
    {
      actorAccountId: "review-account",
      legacyRecovery: true,
    },
  ).id;
  const producer = new FakeConfirmationProducer();
  producer.get = async function get(id) {
    this.getCalls.push(id);
    throw Object.assign(new Error("confirmation missing"), {
      code: "CONFIRMATION_NOT_FOUND",
    });
  };

  await assert.rejects(
    handler(producer).handle(
      handlerInput({
        proposal: currentProposal,
        status: "waiting_confirmation",
        downstreamRef,
      }),
    ),
    (error) => error.code === "CONFIRMATION_NOT_FOUND",
  );
  assert.deepEqual(producer.getCalls, [downstreamRef]);
  assert.equal(producer.enqueueCalls.length, 0);
});

test("disabled GitHub proposal execution constructs no service", () => {
  assert.equal(createGitHubReviewProposalRunnerService({ enabled: false }), null);
  assert.equal(createGitHubReviewProposalRunnerService({}), null);
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

test("real unknown confirmation waits for owner sealing then settles without replay", async () => {
  let now = Date.parse("2026-08-02T03:00:00.000Z");
  const clock = () => new Date(now);
  let executions = 0;
  const queue = new ConfirmationQueue({
    store: new MemoryStore(), exclusiveLease: new Guard(), clock,
    executor: {
      async execute() { executions++; throw new ConfirmationExecutionError("GITHUB_MARKER_ABSENT", "unknown"); },
      async reconcile() { return { status: "unknown", code: "GITHUB_MARKER_ABSENT" }; },
    },
  });
  await queue.recover();
  const store = new MemoryStore();
  const runtime = await createWorkProposalRuntime({
    store, clock, idFactory: () => "github-lease",
    runnerScopes: [{ runnerId: "github-runner", allowedKinds: ["github_review_proposal"], allowedRoleIds: ["pr-reviewer"] }],
    createGuard: () => new Guard(),
  });
  try {
    const service = createGitHubReviewProposalRunnerService({
      enabled: true, runner: runtime.runners["github-runner"], confirmationProducer: queue,
      inputAuthorityVerifier: acceptingVerifier(), actorAccountId: "review-account", clock,
      pollIntervalMs: 1_000, leaseDurationMs: 30_000,
    });
    const { contentDigest: _, ...input } = proposal();
    await runtime.producer.create(input);
    await service.runCycle({ limit: 1 });
    const approval = (item, requestId) => ({
      requestId, expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
      displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
    });
    const pending = (await queue.next()).item;
    const unknown = await queue.approve(pending.id, approval(pending, "request-approve-unknown"));
    assert.equal(unknown.resolutionRequired, true);
    now += 1_000;
    await service.runCycle({ limit: 1 });
    assert.equal(store.value.proposals[0].status, "waiting_confirmation");
    assert.equal(store.value.results.length, 0);
    const sealed = await queue.reject(unknown.id, {
      ...approval(unknown, "request-seal-unknown"), reason: "承认结果未知并封存",
    });
    assert.equal(sealed.ownerDecision.type, "seal_unknown_and_forbid_replay");
    now += 1_000;
    await service.runCycle({ limit: 1 });
    const batch = await runtime.consumer.readResultBatch();
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].outcome, "rejected");
    assert.match(batch.items[0].summary, /封存/);
    assert.equal(executions, 1);
    now += 1_000;
    await service.runCycle({ limit: 1 });
    assert.equal(executions, 1);
  } finally { await runtime.close(); }
});

test("unknown resolution metadata is accepted only in valid confirmation states", async (t) => {
  const failure = { code: "GITHUB_MARKER_ABSENT", outcome: "unknown", retryable: false, at: "2026-08-02T03:00:00.000Z" };
  const ownerDecision = { type: "seal_unknown_and_forbid_replay", at: failure.at };
  for (const [status, fields] of [
    ["pending", { resolutionRequired: true }],
    ["failed", { failure, resolutionRequired: false }],
    ["failed", { failure: { ...failure, outcome: "absent", retryable: true }, retryable: true, resolutionRequired: true }],
    ["rejected", { failure, ownerDecision: { ...ownerDecision, type: "replay" } }],
    ["rejected", { failure, ownerDecision, rejection: { reason: "conflicting semantics" } }],
  ]) {
    await t.test(`${status}:${JSON.stringify(fields)}`, async () => {
      await assert.rejects(handler(new FakeConfirmationProducer(status, fields)).handle(handlerInput()));
    });
  }
});

test("the enabled service closes the real proposal loop through confirmation", async () => {
  const store = new MemoryStore();
  let now = Date.parse("2026-08-02T03:00:00.000Z");
  const runtime = await createWorkProposalRuntime({
    store,
    clock: () => new Date(now),
    idFactory: () => "github-lease",
    runnerScopes: [
      {
        runnerId: "github-runner",
        allowedKinds: ["github_review_proposal"],
        allowedRoleIds: ["pr-reviewer"],
      },
    ],
    createGuard: () => new Guard(),
  });
  const producer = new FakeConfirmationProducer();
  const service = createGitHubReviewProposalRunnerService({
    enabled: true,
    runner: runtime.runners["github-runner"],
    confirmationProducer: producer,
    inputAuthorityVerifier: acceptingVerifier(),
    actorAccountId: "review-account",
    clock: () => new Date(now),
    pollIntervalMs: 1_000,
    leaseDurationMs: 30_000,
  });
  const { contentDigest: _contentDigest, ...proposalInput } = proposal();
  await runtime.producer.create(proposalInput);

  await service.runCycle({ limit: 1 });
  assert.equal(store.value.proposals[0].status, "waiting_confirmation");
  assert.equal(store.value.results.length, 0);

  producer.status = "completed";
  producer.overrides = { receipt: { id: "review-42" } };
  now += 1_000;
  await service.runCycle({ limit: 1 });

  const batch = await runtime.consumer.readResultBatch();
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].outcome, "succeeded");
  assert.equal(producer.enqueueCalls.length, 1);
  assert.equal(producer.getCalls.length, 1);
  await runtime.close();
});
