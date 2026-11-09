import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBoundWorkProposal, normalizeWorkProposalClaimRequest } from "../src/domain/work-proposal-contract.js";
import { WorkProposalRunnerService } from "../src/services/work-proposal-runner.js";

function proposal(number = 1) {
  return normalizeBoundWorkProposal({
    proposalId: `work-intent-proposal-${number}`,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: `work-${number}` },
    source: { assignmentId: `assignment-${number}`, eventId: `event-${number}` },
    binding: { repository: "acme/widgets", pullRequestNumber: number },
    payload: { verdict: "comment", body: `review ${number}` },
  });
}

function claim(number = 1, overrides = {}) {
  return {
    proposal: proposal(number),
    status: "pending_delivery",
    revision: number * 2,
    attempt: 1,
    downstreamRef: null,
    lease: {
      runnerId: "github-runner",
      leaseId: `work-proposal-lease-${number}`,
      leaseUntil: "2026-08-02T03:01:00.000Z",
    },
    ...overrides,
  };
}

class FakeRunner {
  constructor(claims = []) {
    this.claims = [...claims];
    this.claimCalls = [];
    this.advanceCalls = [];
    this.advanceFailures = 0;
  }

  async claim(input) {
    this.claimCalls.push(structuredClone(input));
    const value = this.claims.shift() ?? null;
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }

  async advance(input) {
    this.advanceCalls.push(structuredClone(input));
    if (this.advanceFailures > 0) {
      this.advanceFailures -= 1;
      throw new Error("advance acknowledgement unavailable");
    }
    return {
      proposalId: input.proposalId,
      contentDigest: input.contentDigest,
      status: input.transition.status,
      revision: input.expectedRevision + 1,
      downstreamRef: input.transition.downstreamRef ?? null,
      resultId: input.transition.summary ? `result-${input.proposalId}` : null,
      updatedAt: "2026-08-02T03:00:00.000Z",
    };
  }
}

test("a long configured review lease is accepted by the proposal runner and claim contract", async () => {
  const runner = new FakeRunner([claim()]);
  const originalClaim = runner.claim.bind(runner);
  runner.claim = (input) => {
    const normalized = normalizeWorkProposalClaimRequest({ runnerId: "github-runner", ...input });
    assert.equal(normalized.leaseDurationMs, 18 * 60_000);
    return originalClaim(input);
  };
  const service = new WorkProposalRunnerService({
    runner,
    handler: { async handle() { return { status: "succeeded", summary: "review completed", evidence: [] }; } },
    leaseDurationMs: 18 * 60_000,
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
  });
  const result = await service.runCycle({ limit: 1 });
  assert.equal(result.advanced, 1);
});

test("a bounded cycle claims, delegates without lease authority, and advances a batch", async () => {
  const runner = new FakeRunner([claim(1), claim(2)]);
  const inputs = [];
  const handler = {
    async handle(input) {
      inputs.push(structuredClone(input));
      if (input.proposal.proposalId.endsWith("-1")) {
        return {
          status: "waiting_confirmation",
          downstreamRef: "confirmation-work-intent-proposal-1",
          nextAttemptAt: "2026-08-02T03:00:05.000Z",
        };
      }
      return {
        status: "succeeded",
        summary: "GitHub Review 已完成",
        evidence: [],
      };
    },
  };
  const service = new WorkProposalRunnerService({
    runner,
    handler,
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
  });

  const result = await service.runCycle({ limit: 2 });

  assert.deepEqual(result, {
    claimed: 2,
    advanced: 2,
    waitingConfirmation: 1,
    waitingRetry: 0,
    terminal: 1,
    outcomes: [
      { proposalId: "work-intent-proposal-1", status: "waiting_confirmation" },
      { proposalId: "work-intent-proposal-2", status: "succeeded" },
    ],
  });
  assert.equal(runner.claimCalls.length, 2);
  assert.deepEqual(runner.claimCalls[0], {
    leaseDurationMs: 60_000,
    excludeProposalIds: [],
  });
  assert.deepEqual(runner.claimCalls[1], {
    leaseDurationMs: 60_000,
    excludeProposalIds: ["work-intent-proposal-1"],
  });
  assert.deepEqual(Object.keys(inputs[0]).sort(), [
    "attempt",
    "downstreamRef",
    "proposal",
    "status",
  ]);
  assert.equal("lease" in inputs[0], false);
  assert.deepEqual(Object.keys(runner.advanceCalls[0]).sort(), [
    "contentDigest",
    "expectedRevision",
    "leaseId",
    "proposalId",
    "transition",
  ]);
});

test("handler failures become bounded waiting_retry transitions", async () => {
  const runner = new FakeRunner([claim(1, { attempt: 2 })]);
  const handler = {
    async handle() {
      throw Object.assign(new Error("private queue detail"), {
        code: "CONFIRMATION_QUEUE_NOT_READY",
      });
    },
  };
  const service = new WorkProposalRunnerService({
    runner,
    handler,
    clock: () => new Date("2026-08-02T03:00:00.000Z"),
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
  });

  const result = await service.runCycle({ limit: 1 });

  assert.equal(result.waitingRetry, 1);
  assert.deepEqual(runner.advanceCalls[0].transition, {
    status: "waiting_retry",
    reason: "CONFIRMATION_QUEUE_NOT_READY",
    nextAttemptAt: "2026-08-02T03:00:02.000Z",
  });
  assert.equal(JSON.stringify(result).includes("private queue detail"), false);
});

test("concurrent cycles share one in-flight claim and handler execution", async () => {
  let release;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const decision = new Promise((resolve) => {
    release = resolve;
  });
  const runner = new FakeRunner([claim(1), null]);
  let handles = 0;
  const service = new WorkProposalRunnerService({
    runner,
    handler: {
      async handle() {
        handles += 1;
        startedResolve();
        return decision;
      },
    },
  });

  const first = service.runCycle();
  await started;
  const second = service.runCycle({ limit: 1 });
  assert.strictEqual(second, first);
  release({
    status: "waiting_confirmation",
    downstreamRef: "confirmation-work-intent-proposal-1",
    nextAttemptAt: "2026-08-02T03:00:05.000Z",
  });
  await first;

  assert.equal(handles, 1);
  assert.equal(runner.advanceCalls.length, 1);
});

test("shutdown stops a batch after the current proposal is durably advanced", async () => {
  let releaseHandler;
  let markStarted;
  const handlerStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const handlerReleased = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const runner = new FakeRunner([claim(1), claim(2)]);
  const service = new WorkProposalRunnerService({
    runner,
    handler: {
      async handle() {
        markStarted();
        await handlerReleased;
        return {
          status: "waiting_confirmation",
          downstreamRef: "confirmation-work-intent-proposal-1",
          nextAttemptAt: "2026-08-02T03:00:05.000Z",
        };
      },
    },
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error("shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });

  const cycle = service.runCycle({ limit: 2, signal: controller.signal });
  await handlerStarted;
  controller.abort(reason);
  releaseHandler();

  await assert.rejects(cycle, (error) => error === reason);
  assert.equal(runner.claimCalls.length, 1);
  assert.equal(runner.advanceCalls.length, 1);
});

test("claim and advance acknowledgement loss are retried with the exact request", async () => {
  const claimFailure = new Error("claim acknowledgement unavailable");
  const runner = new FakeRunner([claimFailure, claim(1), null]);
  runner.advanceFailures = 1;
  const service = new WorkProposalRunnerService({
    runner,
    handler: {
      async handle() {
        return {
          status: "waiting_confirmation",
          downstreamRef: "confirmation-work-intent-proposal-1",
          nextAttemptAt: "2026-08-02T03:00:05.000Z",
        };
      },
    },
  });

  const result = await service.runCycle({ limit: 1 });

  assert.equal(result.advanced, 1);
  assert.equal(runner.claimCalls.length, 2);
  assert.equal(runner.advanceCalls.length, 2);
  assert.deepEqual(runner.advanceCalls[1], runner.advanceCalls[0]);
});

test("runtime admission failures stop proposal claims without lost-ack retries", async (t) => {
  for (const code of [
    "RUNTIME_RESTART_REQUIRED",
    "RUNTIME_CONFIGURATION_NOT_READY",
    "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
  ]) {
    await t.test(code, async () => {
      const failure = Object.assign(new Error("runtime admission rejected"), { code });
      const runner = new FakeRunner([failure, claim(1)]);
      let handlerCalls = 0;
      const service = new WorkProposalRunnerService({
        runner,
        handler: {
          async handle() {
            handlerCalls += 1;
          },
        },
      });

      await assert.rejects(service.runCycle({ limit: 1 }), (error) => error === failure);
      assert.equal(runner.claimCalls.length, 1);
      assert.equal(runner.advanceCalls.length, 0);
      assert.equal(handlerCalls, 0);
    });
  }
});

test("runner construction and cycle limits fail closed", () => {
  const runner = new FakeRunner();
  const handler = { async handle() {} };

  assert.throws(() => new WorkProposalRunnerService({ runner: {}, handler }), /runner/);
  assert.throws(() => new WorkProposalRunnerService({ runner, handler: {} }), /handler/);
  const service = new WorkProposalRunnerService({ runner, handler });
  for (const options of [
    null,
    [],
    { limit: 0 },
    { limit: 101 },
    { signal: {} },
    { extra: true },
  ]) {
    assert.throws(() => service.runCycle(options), /runCycle options|limit|signal/);
  }
});
