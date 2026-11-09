import assert from "node:assert/strict";
import test from "node:test";
import {
  appendPullRequestCutoverTimelineEvent,
  createPullRequestCutoverTimelineIndex,
  inspectPullRequestSourceCutover,
} from "../src/services/work-ledger-pr-cutover-commands.js";

function root(overrides = {}) {
  return {
    itemId: "root-a",
    status: "blocked",
    activeIntentId: null,
    inputDigest: "a".repeat(64),
    statusReason: "manual_block",
    decisionContext: null,
    source: { pendingRevision: null },
    ...overrides,
  };
}

function blockersFor(item, outbox = [], options = {}) {
  const { timeline = [], ...inspectionOptions } = options;
  return inspectPullRequestSourceCutover(
    item,
    [item],
    new Map(outbox.map((entry) => [entry.intentId, entry])),
    {
      ...inspectionOptions,
      timelineIndex: createPullRequestCutoverTimelineIndex(timeline),
    },
  ).blockers;
}

test("cutover releases only blocked outcomes with durable final evidence", () => {
  const rejected = root({
    statusReason: "attention_rejected",
    decisionContext: { source: "attention", outcome: "rejected" },
  });
  const proposalFailed = root({
    statusReason: "proposal_failed",
    decisionContext: { source: "proposal", outcome: "failed" },
  });
  const proposalDecisionDigest = "c".repeat(64);
  const proposalRejected = root({
    revision: 1,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: proposalDecisionDigest,
    },
  });
  const proposalRejectedResult = {
    sequence: 1,
    itemId: proposalRejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: proposalDecisionDigest },
    },
  };
  const intentFailed = root({ statusReason: "intent_failed" });
  const failedOutbox = {
    intentId: "intent-failed",
    itemId: intentFailed.itemId,
    inputDigest: intentFailed.inputDigest,
    status: "failed",
    outcome: { status: "failed", details: {} },
    updatedAt: "2026-08-02T02:00:00.000Z",
  };
  intentFailed.updatedAt = failedOutbox.updatedAt;

  assert.deepEqual(blockersFor(rejected), []);
  assert.deepEqual(blockersFor(proposalFailed), []);
  assert.deepEqual(
    blockersFor(proposalRejected, [], {
      timeline: [proposalRejectedResult],
    }),
    [],
  );
  assert.deepEqual(
    blockersFor(proposalRejected).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(proposalRejected, [], {
      timeline: [
        proposalRejectedResult,
        {
          sequence: 2,
          itemId: proposalRejected.itemId,
          type: "transitioned",
          details: {},
        },
      ],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(blockersFor(intentFailed, [failedOutbox]), []);
  assert.deepEqual(
    blockersFor(root({
      statusReason: "attention_rejected",
      decisionContext: { source: "attention", outcome: "answered" },
    })).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(root({ statusReason: "intent_failed" }), [failedOutbox])
      .map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(root({ statusReason: "manual_block" }))
      .map(({ itemId }) => itemId),
    ["root-a"],
  );
});

test("cutover recovers a persisted blocker only from its latest durable rejected proposal", () => {
  const decisionDigest = "d".repeat(64);
  const persisted = root({
    revision: 7,
    statusReason: "pr_source_cross_root_cutover_blocker:root-b",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const rejected = {
    sequence: 10,
    itemId: persisted.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 6,
      decision: { contentDigest: decisionDigest },
    },
  };
  const sourceRevision = {
    sequence: 11,
    itemId: persisted.itemId,
    type: "pr_source_revised",
    details: {},
  };

  assert.deepEqual(
    blockersFor(persisted, [], { timeline: [rejected, sourceRevision] }),
    [],
  );
  assert.deepEqual(
    blockersFor(persisted, [], {
      timeline: [
        rejected,
        {
          sequence: 11,
          itemId: persisted.itemId,
          type: "transitioned",
          details: {},
        },
      ],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
  assert.deepEqual(
    blockersFor(persisted, [], {
      timeline: [{
        ...rejected,
        details: {
          ...rejected.details,
          decision: { contentDigest: "e".repeat(64) },
        },
      }],
    }).map(({ itemId }) => itemId),
    ["root-a"],
  );
});

test("cutover releases an expired code confirmation from durable proof after its reason was replaced", () => {
  const decision = {
    source: "proposal", outcome: "stale", contentDigest: "a".repeat(64),
    value: {
      kind: "code_action_proposal", downstreamRef: "confirmation-code-job-expired",
      evidence: ["confirmation:confirmation-code-job-expired"],
    },
  };
  const persisted = root({
    revision: 7, decisionContext: decision,
    statusReason: "pr_source_cross_root_cutover_blocker:root-b",
  });
  const proof = {
    itemId: persisted.itemId, type: "proposal_result_applied", sequence: 10,
    details: { outcome: "stale", workItemRevision: 6, decision },
  };
  const inspect = (item = persisted, timeline = [proof]) => blockersFor(item, [], { timeline });
  assert.deepEqual(inspect(), []);
  assert.deepEqual(inspect({ ...persisted, statusReason: "proposal_stale" }), []);
  assert.equal(inspect(persisted, []).length, 1);
  assert.equal(inspect(persisted, [proof, { itemId: persisted.itemId, type: "transitioned" }]).length, 1);
  assert.equal(inspect({ ...persisted, activeIntentId: "still-running" }).length, 1);
  assert.equal(inspect({ ...persisted, decisionContext: { ...decision, contentDigest: "b".repeat(64) } }).length, 1);
  for (const value of [
    { ...decision.value, kind: "github_review_proposal" },
    { ...decision.value, evidence: [...decision.value.evidence, "authorization_changed", "old_confirmation_status:executing"] },
    { ...decision.value, evidence: [] },
  ]) {
    const changedDecision = { ...decision, value };
    assert.equal(inspect({ ...persisted, decisionContext: changedDecision }, [{
      ...proof, details: { ...proof.details, decision: changedDecision },
    }]).length, 1);
  }
});

test("cutover releases authorization expiry before code confirmation only with matching durable proof", () => {
  const decision = {
    source: "proposal", outcome: "stale", contentDigest: "a".repeat(64),
    referenceId: "work-intent-unstarted-code",
    value: {
      kind: "code_action_proposal", downstreamRef: null,
      evidence: ["authorization_changed", "proposal:work-intent-unstarted-code"],
    },
  };
  const persisted = root({
    revision: 7, decisionContext: decision,
    statusReason: "pr_source_cross_root_cutover_blocker:root-b",
  });
  const proof = {
    itemId: persisted.itemId, type: "proposal_result_applied", sequence: 10,
    details: { outcome: "stale", workItemRevision: 6, decision },
  };
  const inspect = (item = persisted, timeline = [proof]) => blockersFor(item, [], { timeline });
  assert.deepEqual(inspect(), []);
  assert.deepEqual(inspect({ ...persisted, statusReason: "proposal_stale" }), []);
  assert.equal(inspect(persisted, []).length, 1);
  assert.equal(inspect(persisted, [proof, { itemId: persisted.itemId, type: "transitioned" }]).length, 1);
  assert.equal(inspect({ ...persisted, activeIntentId: "still-running" }).length, 1);
  assert.equal(inspect({ ...persisted, decisionContext: { ...decision, contentDigest: "b".repeat(64) } }).length, 1);
  for (const value of [
    { ...decision.value, kind: "github_review_proposal" },
    { ...decision.value, downstreamRef: "confirmation-code-job-existing" },
    { ...decision.value, evidence: ["authorization_changed", "proposal:another-proposal"] },
    { ...decision.value, evidence: ["authorization_changed"] },
    { ...decision.value, evidence: [...decision.value.evidence, "code-job:possibly-running"] },
  ]) {
    const changedDecision = { ...decision, value };
    assert.equal(inspect({ ...persisted, decisionContext: changedDecision }, [{
      ...proof, details: { ...proof.details, decision: changedDecision },
    }]).length, 1);
  }
});

test("cutover proof expires when unrelated same-batch events rotate it out", () => {
  const decisionDigest = "f".repeat(64);
  const rejected = root({
    revision: 1,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const timelineIndex = createPullRequestCutoverTimelineIndex([{
    sequence: 1,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: decisionDigest },
    },
  }], 2);
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 2,
    itemId: null,
    type: "intake_completed",
    details: {},
  });
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 3,
    itemId: "unrelated-item",
    type: "assignment_intaken",
    details: {},
  });

  const blockers = inspectPullRequestSourceCutover(
    rejected,
    [rejected],
    new Map(),
    { timelineIndex },
  ).blockers;

  assert.deepEqual(blockers.map(({ itemId }) => itemId), ["root-a"]);
});

test("ignored source observations preserve retained proof but still consume its global window", () => {
  const decision = { source: "proposal", outcome: "rejected", contentDigest: "f".repeat(64) };
  const rejected = root({ revision: 1, statusReason: "proposal_rejected", decisionContext: decision });
  const proof = { sequence: 1, itemId: rejected.itemId, type: "proposal_result_applied",
    details: { outcome: "rejected", workItemRevision: 1, decision } };
  const timelineIndex = createPullRequestCutoverTimelineIndex([proof], 3);
  const inspect = () => inspectPullRequestSourceCutover(rejected, [rejected], new Map(), { timelineIndex });
  for (const sequence of [2, 3]) {
    appendPullRequestCutoverTimelineEvent(timelineIndex, { sequence, itemId: rejected.itemId,
      type: "pr_source_ignored", details: { disposition: "ignored_unproven_head" } });
    const result = inspect();
    assert.deepEqual(result.blockers, [], "audit events must not replace retained final business evidence");
    assert.deepEqual(result.proposalSettlements.map((entry) => entry.proof), [proof]);
  }
  appendPullRequestCutoverTimelineEvent(timelineIndex, { sequence: 4, itemId: rejected.itemId,
    type: "pr_source_ignored", details: { disposition: "ignored_unproven_head" } });
  const expired = inspect();
  assert.deepEqual(expired.blockers.map((entry) => entry.itemId), [rejected.itemId]);
  assert.deepEqual(expired.proposalSettlements, [], "audit entries must evict proof at the same global limit");
});

test("a later business event invalidates proposal proof even across ignored source observations", () => {
  const decision = { source: "proposal", outcome: "rejected", contentDigest: "f".repeat(64) };
  const rejected = root({ revision: 1, statusReason: "proposal_rejected", decisionContext: decision });
  const proof = { sequence: 1, itemId: rejected.itemId, type: "proposal_result_applied",
    details: { outcome: "rejected", workItemRevision: 1, decision } };
  const ignored = { itemId: rejected.itemId, type: "pr_source_ignored", details: {} };
  const timeline = [proof, { ...ignored, sequence: 2 },
    { sequence: 3, itemId: rejected.itemId, type: "transitioned", details: {} },
    { ...ignored, sequence: 4 }];
  assert.deepEqual(blockersFor(rejected, [], { timeline }).map((entry) => entry.itemId), [rejected.itemId]);
});

test("cutover keeps a newer same-item proof when the older record expires after compaction", () => {
  const decisionDigest = "9".repeat(64);
  const rejected = root({
    revision: 2,
    statusReason: "proposal_rejected",
    decisionContext: {
      source: "proposal",
      outcome: "rejected",
      contentDigest: decisionDigest,
    },
  });
  const timelineIndex = createPullRequestCutoverTimelineIndex([], 1024);
  for (let sequence = 1; sequence <= 1024; sequence += 1) {
    appendPullRequestCutoverTimelineEvent(timelineIndex, {
      sequence,
      itemId: `old-${sequence}`,
      type: "assignment_intaken",
      details: {},
    });
  }
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 1025,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 1,
      decision: { contentDigest: "8".repeat(64) },
    },
  });
  appendPullRequestCutoverTimelineEvent(timelineIndex, {
    sequence: 1026,
    itemId: rejected.itemId,
    type: "proposal_result_applied",
    details: {
      outcome: "rejected",
      workItemRevision: 2,
      decision: { contentDigest: decisionDigest },
    },
  });
  for (let sequence = 1027; sequence <= 2049; sequence += 1) {
    appendPullRequestCutoverTimelineEvent(timelineIndex, {
      sequence,
      itemId: `new-${sequence}`,
      type: "assignment_intaken",
      details: {},
    });
  }

  const blockers = inspectPullRequestSourceCutover(
    rejected,
    [rejected],
    new Map(),
    { timelineIndex },
  ).blockers;

  assert.deepEqual(blockers, []);
});

test("cutover treats side-effect-free decision exhaustion as settled", () => {
  assert.deepEqual(
    blockersFor(root({ statusReason: "decision_attempts_exhausted" })),
    [],
  );
});

test("cutover keeps unknown waiting states blocked and accepts retry settlement", () => {
  for (const status of [
    "waiting_user",
    "waiting_external",
    "waiting_condition",
    "dispatch_pending",
  ]) {
    const item = root({
      status,
      activeIntentId: status === "dispatch_pending" ? "sealed-intent" : null,
    });
    assert.deepEqual(
      blockersFor(item).map(({ itemId }) => itemId),
      ["root-a"],
      status,
    );
  }
  assert.deepEqual(
    blockersFor(root({
      status: "retry_wait",
      statusReason: "intent_failed",
    })),
    [],
  );
});

test("a delivered workflow wait from a retained earlier source revision cannot strand the new Head", () => {
  const revision = (n) => ({ revision: n, disposition: "accepted", headRevision: n, headRefOid: String(n).repeat(40),
    eventId: `event-${n}`, eventDigest: String(n).repeat(64), inputDigest: String(n).repeat(64) });
  const old = revision(1), current = revision(2);
  const item = root({ status: "waiting_condition", activeIntentId: "old-wait", inputDigest: current.inputDigest,
    source: { kind: "pull_request", workKey: "same-work", activeRevision: 2, pendingRevision: null,
      current, revisions: [old, current], bindings: [{ inputRevision: 1, eventId: old.eventId }] } });
  const sourceBinding = { kind: "pull_request", rootItemId: item.itemId, workKey: "same-work", inputRevision: 1,
    headRevision: 1, headRefOid: old.headRefOid, eventId: old.eventId, eventDigest: old.eventDigest, inputDigest: old.inputDigest };
  const wait = { intentId: "old-wait", status: "delivered", outcome: { status: "delivered" },
    inputDigest: old.inputDigest, sourceBinding, intent: { type: "wait_condition", condition: { kind: "workflow_fact", fact: "merge-state" } } };
  assert.deepEqual(blockersFor(item, [wait], { forceHeadChanged: true }), []);
  for (const changed of [
    { ...wait, sourceBinding: { ...sourceBinding, workKey: "foreign" } },
    { ...wait, sourceBinding: { ...sourceBinding, headRefOid: "f".repeat(40) } },
    { ...wait, inputDigest: "f".repeat(64) },
    { ...wait, intent: { type: "wait_condition", condition: { kind: "external", fact: "merge-state" } } },
  ]) assert.equal(blockersFor(item, [changed], { forceHeadChanged: true }).length, 1);
  assert.equal(blockersFor(item, [wait]).length, 1, "an ordinary unchanged source cannot release the wait");
});
