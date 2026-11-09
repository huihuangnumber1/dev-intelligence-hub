import assert from "node:assert/strict";
import test from "node:test";
import { ReviewHandoffReconciler } from "../src/services/review-handoff-reconciler.js";

const items = ["first", "second"].map((id) => ({ id, request: { requestId: id } }));
const delivered = { phase: "intaken", workItemId: "work-42", assignment: { target: { id: "tester" } } };

test("all automatic Review verdicts complete their GitHub handoff before acknowledgement", async (t) => {
  for (const reviewEvent of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
    await t.test(reviewEvent, async () => {
      const events = [];
      const reconciler = new ReviewHandoffReconciler({
        confirmations: {
          readReviewHandoffs: async () => [{
            id: "auto-1", actorAccountId: "me",
            request: { requestId: "request-1", workType: reviewEvent === "APPROVE" ? "testing" : "pull_request", pullRequest: { repository: "acme/repo", number: 1 },
              ...(reviewEvent === "APPROVE" ? { responsiblePerson: { login: "tester", product: "qt" } } : {}) },
            automaticReview: { reviewEvent, headRefOid: "a".repeat(40) },
          }],
          recordReviewHandoff: async (_id, _requestId, outcome) => events.push(["ack", outcome.status, outcome.assignedLogin]),
        },
        ownerWorkRequests: { submit: async () => { events.push(["work"]); return delivered; } },
        githubAssignee: {
          assignAssignee() { throw new Error("legacy assignment must not run"); },
          async assignReviewOutcome(input) {
            events.push(["github", input.reviewEvent]);
            return { assigneeLogin: reviewEvent === "APPROVE" ? "tester" : "developer" };
          },
        },
      });
      assert.equal((await reconciler.runCycle())[0].status, "completed");
      assert.deepEqual(events, [
        ["github", reviewEvent], ["ack", "completed", reviewEvent === "APPROVE" ? "tester" : "developer"]]);
    });
  }
});

test("automatic verdicts route assignment and changed Heads stop further handoff retries", async () => {
  const outcomes = [];
  const calls = [];
  const reconciler = new ReviewHandoffReconciler({
    confirmations: { readReviewHandoffs: async () => [{ id: "auto-1", actorAccountId: "me", request: { requestId: "request-1", workType: "pull_request", pullRequest: { repository: "acme/repo", number: 1 } }, automaticReview: { reviewEvent: "REQUEST_CHANGES", headRefOid: "a".repeat(40) } }],
      recordReviewHandoff: async (_id, _request, outcome) => outcomes.push(outcome) },
    ownerWorkRequests: { submit: async () => delivered },
    githubAssignee: { assignAssignee() { throw new Error("legacy assignment must not run"); }, async assignReviewOutcome(input) { calls.push(input); throw Object.assign(new Error("changed"), { code: "GITHUB_HANDOFF_HEAD_CHANGED" }); } },
  });
  await reconciler.runCycle();
  assert.equal(calls[0].reviewEvent, "REQUEST_CHANGES");
  assert.equal(outcomes[0].status, "stale");
});
function fixture(submit, recordReviewHandoff = async () => {}) {
  return new ReviewHandoffReconciler({
    confirmations: { readReviewHandoffs: async () => items, recordReviewHandoff },
    ownerWorkRequests: { submit },
    timeoutMs: 15,
    cycleTimeoutMs: 100,
  });
}

test("a stalled dispatch is bounded, aborted and not duplicated while still settling", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let dispatchSignal;
  const reconciler = fixture((request, options) => {
    calls.push(request.requestId);
    if (request.requestId === "first") { dispatchSignal = options?.signal; return stalled; }
    return delivered;
  });
  try {
    const results = await Promise.race([
      reconciler.runCycle(),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 250)),
    ]);
    assert.notEqual(results, "stalled");
    assert.equal(dispatchSignal.aborted, true);
    assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_TIMEOUT");
    assert.equal(results[1].status, "completed");
    await reconciler.runCycle();
    assert.equal(calls.filter((id) => id === "first").length, 1);
  } finally { release(delivered); }
});

test("the cycle does not truncate a longer configured handoff budget", async (t) => {
  let release;
  let markStarted;
  let dispatchSignal;
  const submission = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const reconciler = new ReviewHandoffReconciler({
    confirmations: { readReviewHandoffs: async () => items.slice(0, 1), async recordReviewHandoff() {} },
    ownerWorkRequests: {
      submit(_request, { signal }) {
        dispatchSignal = signal;
        markStarted();
        return submission;
      },
    },
    timeoutMs: 60_000,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cycle = reconciler.runCycle();
  try {
    await started;
    t.mock.timers.tick(16_000);
    assert.equal(dispatchSignal.aborted, false);
    release(delivered);
    assert.equal((await cycle)[0].status, "completed");
  } finally {
    release(delivered);
    await cycle;
    t.mock.timers.reset();
  }
});

test("a slow retry leaves the next handoff its full budget in the following cycle", async (t) => {
  let now = 0;
  const cursors = [];
  t.mock.method(performance, "now", () => now);
  const reconciler = new ReviewHandoffReconciler({
    confirmations: {
      async readReviewHandoffs({ afterId }) {
        cursors.push(afterId);
        return afterId === "first" ? [items[1], items[0]] : items;
      },
      async recordReviewHandoff() {},
    },
    ownerWorkRequests: {
      async submit(request) {
        if (request.requestId === "first") {
          now += 60;
          throw Object.assign(new Error("temporarily unavailable"), { code: "GITHUB_UNAVAILABLE" });
        }
        return delivered;
      },
    },
    timeoutMs: 100,
    cycleTimeoutMs: 105,
  });

  assert.deepEqual(await reconciler.runCycle(), [
    { id: "first", status: "retrying" },
  ]);
  assert.equal((await reconciler.runCycle())[0].id, "second");
  assert.deepEqual(cursors, [null, "first"]);
});

test("one acknowledgement failure does not prevent another handoff", async () => {
  const calls = [];
  const reconciler = fixture(async (request) => { calls.push(request.requestId); return delivered; },
    async (id) => { if (id === "first") throw new Error("disk failure"); });
  const results = await reconciler.runCycle();
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_ACK_FAILED");
  assert.equal(results[1].status, "completed");
});

test("shutdown aborts a handoff without waiting for an uncooperative dependency", async () => {
  const controller = new AbortController();
  let observedSignal;
  const reconciler = fixture((_request, options) => {
    observedSignal = options?.signal;
    controller.abort();
    return new Promise(() => {});
  });
  const results = await reconciler.runCycle({ signal: controller.signal });
  assert.equal(observedSignal.aborted, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_CANCELLED");
});

test("a cycle cancelled before admission does not read or dispatch", async () => {
  let reads = 0;
  const reconciler = fixture(() => { throw new Error("must not submit"); });
  reconciler.confirmations.readReviewHandoffs = async () => { reads++; return items; };
  assert.deepEqual(await reconciler.runCycle({ signal: AbortSignal.abort() }), []);
  assert.equal(reads, 0);
});

test("the actual acknowledgement remains tracked after the cycle deadline", async () => {
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  const reconciler = fixture(async () => delivered, async (id) => { if (id === "first") await acknowledgement; });
  let active = 0;
  const runOperation = async (operation) => {
    active++;
    try { return await operation(); } finally { active--; }
  };
  try {
    const results = await reconciler.runCycle({ runOperation });
    assert.equal(results[0].diagnosticCode, "REVIEW_HANDOFF_TIMEOUT");
    assert.equal(active, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 0);
  } finally { release(); }
});

test("a testing handoff assigns the confirmed GitHub user before acknowledgement", async () => {
  const events = [];
  const reconciler = new ReviewHandoffReconciler({
    confirmations: {
      async readReviewHandoffs() {
        return [{
          id: "testing-handoff",
          actorAccountId: "local-owner",
          request: {
            requestId: "testing-handoff",
            workType: "testing",
            pullRequest: { repository: "acme/project", number: 42 },
            responsiblePerson: { login: "qt-tester", product: "qt" },
          },
        }];
      },
      async recordReviewHandoff(_id, _requestId, outcome) {
        events.push(["ack", outcome.status]);
      },
    },
    ownerWorkRequests: {
      async submit() {
        events.push(["work"]);
        return delivered;
      },
    },
    githubAssignee: {
      async assignAssignee(input) {
        events.push(["github", input.assigneeLogin]);
        return { status: "applied" };
      },
    },
  });

  assert.equal((await reconciler.runCycle())[0].status, "completed");
  assert.deepEqual(events, [
    ["work"],
    ["github", "qt-tester"],
    ["ack", "completed"],
  ]);
});
