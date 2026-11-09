import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { automaticReviewWorkAdmission } from "../src/domain/automatic-review-policy.js";
import {
  activatePendingPullRequestWorkSource as activatePendingPullRequestWorkSourceWithCounter,
  appendPullRequestWorkSource as appendPullRequestWorkSourceWithCounter,
  createPullRequestWorkSource,
  currentWorkItemEvent,
  currentWorkItemInputBinding,
  normalizePullRequestWorkSource,
  pullRequestHeadAdmission as singlePullRequestHeadAdmission,
  pullRequestHeadAdmissions,
  pullRequestTrustedPredecessorHead,
  verifyPullRequestExecutionBinding,
  validatePullRequestSourceTransition,
} from "../src/services/work-ledger-pr-source.js";

// These source-only fixtures have no claims; production passes the owning
// item's exact counter at its validated activation boundary.
const appendPullRequestWorkSource = (source, envelope, options = {}) =>
  appendPullRequestWorkSourceWithCounter(source, envelope, { attemptAtActivation: 0, ...options });
const activatePendingPullRequestWorkSource = (source, options = {}) =>
  activatePendingPullRequestWorkSourceWithCounter(source, { attemptAtActivation: 0, ...options });

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

function pullRequestHeadAdmission(state, item) {
  assert.deepEqual(pullRequestHeadAdmissions(state, state.items),
    state.items.map(candidate => singlePullRequestHeadAdmission(state, candidate)));
  return singlePullRequestHeadAdmission(state, item);
}

function pullRequestEnvelope(
  sequence,
  headRefOid,
  {
    previousHeadRefOid,
    gitFacts = {},
    sourceScopeId = "github-dashboard",
    occurredAt = `2026-08-02T01:00:0${sequence}.000Z`,
  } = {},
) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt,
    source: { provider: "github", scopeId: sourceScopeId },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "PR 42",
      headRefOid,
      ciStatus: "PENDING",
      changedFields: previousHeadRefOid === undefined
        ? ["ciStatus"]
        : ["headRefOid"],
      ...gitFacts,
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
    },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-pr-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
      createdAt: occurredAt,
    },
    event,
  };
}

function initialSource() {
  return createPullRequestWorkSource(
    pullRequestEnvelope(1, HEAD_A),
  ).source;
}

test("replacement Assign intake survives source normalization and later CI snapshots", () => {
  const facts = { relation: "review_requested", reviewRequestEventId: "event-2", reviewReceivedAt: "2026-08-03T01:00:00Z" };
  const initial = pullRequestEnvelope(1, HEAD_A);
  let source = createPullRequestWorkSource(initial).source;
  source = appendPullRequestWorkSource(source, pullRequestEnvelope(2, HEAD_A,
    { occurredAt: "2026-08-03T01:10:00.000Z", gitFacts: facts })).source;
  source = normalizePullRequestWorkSource(source);
  source = appendPullRequestWorkSource(source, pullRequestEnvelope(3, HEAD_A,
    { occurredAt: "2026-08-05T01:10:00.000Z", gitFacts: { ...facts, ciStatus: "FAILURE" } })).source;
  const root = { ...sourceItem(normalizePullRequestWorkSource(source)), event: initial.event, createdAt: initial.event.occurredAt };
  assert.equal(automaticReviewWorkAdmission(root).admittedAt, "2026-08-03T01:10:00.000Z");
  const forged = structuredClone(source);
  forged.revisions.at(-1).incomingReview.eventId = "different-assign";
  assert.throws(() => normalizePullRequestWorkSource(forged));
});

function sourceItem(source) {
  return {
    itemId: "work-item-pr-42",
    kind: "source_root",
    source,
    sourceQuarantine: null,
    attempt: 0,
  };
}

function executionBinding(item) {
  return createPullRequestExecutionBinding({
    sourceBinding: currentWorkItemInputBinding(item),
    event: currentWorkItemEvent(item),
  });
}

test("incoming Review receipts on a rejected snapshot cannot trigger legacy migration or rewrite accepted history", () => {
  let source = initialSource();
  source = appendPullRequestWorkSource(source, pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A })).source;
  const previous = structuredClone(source);
  const rejected = appendPullRequestWorkSource(source, pullRequestEnvelope(3, HEAD_C, { gitFacts: {
    relation: "review_requested", reviewRequestEventId: "AE_2", reviewReceivedAt: "2026-08-02T01:00:00.000Z",
  } }));
  assert.equal(rejected.disposition, "ignored_unproven_head");
  const normalized = normalizePullRequestWorkSource(rejected.source);
  assert.equal(normalized.headRevision, previous.headRevision);
  assert.deepEqual(normalized.revisions.slice(0, previous.revisions.length), previous.revisions);
  assert.doesNotThrow(() => validatePullRequestSourceTransition([sourceItem(previous)], [sourceItem(normalized)]));
});

test("batch Head admission matches individual authority and refreshes after mutation", () => {
  const first = sourceItem(initialSource());
  const state = { items: [first] };
  assert.deepEqual(pullRequestHeadAdmissions(state, state.items),
    state.items.map(item => pullRequestHeadAdmission(state, item)));
  first.source = appendPullRequestWorkSource(first.source,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false }).source;
  assert.deepEqual(pullRequestHeadAdmissions(state, state.items),
    state.items.map(item => pullRequestHeadAdmission(state, item)));
  assert.equal(pullRequestHeadAdmissions(state, state.items)[0].pending, true);
});

test("deferred A to B keeps A active and records B as pending", () => {
  const sourceA = initialSource();

  const appended = appendPullRequestWorkSource(
    sourceA,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  );

  assert.equal(appended.changed, true);
  assert.equal(appended.headAdvanced, true);
  assert.equal(appended.activeAdvanced, false);
  assert.equal(appended.source.inputRevision, 2);
  assert.equal(appended.source.activeRevision, 1);
  assert.equal(appended.source.headRevision, 2);
  assert.equal(appended.source.pendingRevision, 2);
  assert.equal(appended.source.current.headRefOid, HEAD_A);
  assert.equal(appended.source.pending.headRefOid, HEAD_B);
});

test("activating a pending B atomically moves the active pointer to B", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;

  const activated = activatePendingPullRequestWorkSource(pendingB);

  assert.equal(activated.changed, true);
  assert.equal(activated.source.inputRevision, 2);
  assert.equal(activated.source.activeRevision, 2);
  assert.equal(activated.source.headRevision, 2);
  assert.equal(activated.source.pendingRevision, null);
  assert.equal(activated.source.pending, null);
  assert.equal(activated.source.current.headRefOid, HEAD_B);
  assert.equal(activated.source.current.eventId, pendingB.pending.eventId);
});

test("a pending B advances to a causally proven pending C", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;

  const pendingC = appendPullRequestWorkSource(
    pendingB,
    pullRequestEnvelope(3, HEAD_C, { previousHeadRefOid: HEAD_B }),
    { activate: false },
  ).source;

  assert.equal(pendingC.inputRevision, 3);
  assert.equal(pendingC.activeRevision, 1);
  assert.equal(pendingC.headRevision, 3);
  assert.equal(pendingC.pendingRevision, 3);
  assert.equal(pendingC.current.headRefOid, HEAD_A);
  assert.equal(pendingC.pending.headRefOid, HEAD_C);
  assert.deepEqual(
    pendingC.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("A to B to A creates monotonically increasing Head epochs", () => {
  const pendingB = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;
  const activeB = activatePendingPullRequestWorkSource(pendingB).source;

  const pendingA = appendPullRequestWorkSource(
    activeB,
    pullRequestEnvelope(3, HEAD_A, { previousHeadRefOid: HEAD_B }),
    { activate: false },
  ).source;
  const activeA = activatePendingPullRequestWorkSource(pendingA).source;

  assert.equal(activeA.activeRevision, 3);
  assert.equal(activeA.headRevision, 3);
  assert.equal(activeA.current.headRefOid, HEAD_A);
  assert.deepEqual(
    activeA.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
});

test("source transitions accept pointer progress and reject history rewrites", () => {
  const sourceA = initialSource();
  const pendingB = appendPullRequestWorkSource(
    sourceA,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { activate: false },
  ).source;
  const activeB = activatePendingPullRequestWorkSource(pendingB).source;
  const activeC = appendPullRequestWorkSource(
    activeB,
    pullRequestEnvelope(3, HEAD_C, { previousHeadRefOid: HEAD_B }),
  ).source;

  assert.doesNotThrow(() =>
    validatePullRequestSourceTransition(
      [sourceItem(sourceA)],
      [sourceItem(pendingB)],
    )
  );
  assert.doesNotThrow(() =>
    validatePullRequestSourceTransition(
      [sourceItem(pendingB)],
      [sourceItem(activeB)],
      [], headActivationTimeline(sourceA, activeB),
    )
  );

  const rewritten = structuredClone(activeC);
  rewritten.revisions[0].eventDigest = "f".repeat(64);

  assert.throws(
    () =>
      validatePullRequestSourceTransition(
        [sourceItem(activeB)],
        [sourceItem(rewritten)],
      ),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
  );
});

function batchedHeadActivationSources({ legacy = false } = {}) {
  const previous = initialSource();
  if (legacy) delete previous.decisionBudget;
  let next = appendPullRequestWorkSource(previous,
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
    { attemptAtActivation: 14 }).source;
  for (const sequence of [3, 4, 5, 6]) {
    next = appendPullRequestWorkSource(next,
      pullRequestEnvelope(sequence, HEAD_B),
      { attemptAtActivation: 14, authorityEpochChanged: sequence === 5 }).source;
  }
  return { previous, next };
}

function headActivationTimeline(previous, next, attempt = 0) {
  return next.revisions.slice(previous.activeRevision, next.activeRevision)
    .filter(revision => revision.disposition === "accepted")
    .map((revision, index) => ({
      itemId: "work-item-pr-42", sequence: revision.revision, type: "pr_source_revised",
      details: { workKey: next.workKey, activeRevision: revision.revision,
        headRefOid: revision.headRefOid, headRevision: revision.headRevision,
        ...(index === 0 ? { previousActiveRevision: previous.activeRevision,
          previousHeadRefOid: previous.current.headRefOid, decisionAttemptOffset: attempt } : {}),
      },
    }));
}

for (const legacy of [false, true]) {
  test(`source transition preserves the Head activation budget through batched metadata updates (${legacy ? "legacy" : "current"})`, () => {
    // Sanitized shape of the outage: active 102 -> 107, Head activated at
    // 103, authority-only advance at 106, and lifetime claim count 14.
    const { previous, next } = batchedHeadActivationSources({ legacy });
    assert.equal(next.activeRevision, 6);
    assert.equal(next.decisionBudget.activationRevision, 2);
    assert.equal(next.decisionBudget.attemptOffset, 14);
    assert.equal(next.headRevision, 3);
    assert.doesNotThrow(() => validatePullRequestSourceTransition(
      [{ ...sourceItem(previous), attempt: 14 }],
      [{ ...sourceItem(next), attempt: 14 }],
      [], headActivationTimeline(previous, next, 14),
    ));
  });
}

for (const corruption of ["activation behind", "activation ahead", "wrong offset", "hidden Head change", "history rewrite"]) {
  test(`batched metadata updates still reject ${corruption}`, () => {
    const { previous, next } = batchedHeadActivationSources();
    if (corruption === "activation behind") next.decisionBudget.activationRevision = 1;
    if (corruption === "activation ahead") next.decisionBudget.activationRevision = 7;
    if (corruption === "wrong offset") next.decisionBudget.attemptOffset = 13;
    if (corruption === "history rewrite") next.revisions[0].inputDigest = "f".repeat(64);
    if (corruption === "hidden Head change") {
      const returned = appendPullRequestWorkSource(
        appendPullRequestWorkSource(next, pullRequestEnvelope(7, HEAD_C,
          { previousHeadRefOid: HEAD_B }), { attemptAtActivation: 14 }).source,
        pullRequestEnvelope(8, HEAD_B, { previousHeadRefOid: HEAD_C }),
        { attemptAtActivation: 14 }).source;
      Object.assign(next, returned, { decisionBudget: next.decisionBudget });
    }
    assert.throws(() => validatePullRequestSourceTransition(
      [{ ...sourceItem(previous), attempt: 14 }],
      [{ ...sourceItem(next), attempt: 14 }],
      [], headActivationTimeline(previous, next, 14),
    ), (error) => ["WORK_LEDGER_PR_SOURCE_INVALID", "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID"].includes(error.code));
  });
}

test("execution authority keeps same-Head facts valid but rejects pending or changed Heads", () => {
  const itemA = sourceItem(initialSource());
  const bindingA = executionBinding(itemA);
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [itemA] }, bindingA),
    bindingA,
  );

  const sameHead = sourceItem(
    appendPullRequestWorkSource(
      itemA.source,
      pullRequestEnvelope(2, HEAD_A),
    ).source,
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [sameHead] }, bindingA),
    bindingA,
  );

  const pendingB = sourceItem(
    appendPullRequestWorkSource(
      sameHead.source,
      pullRequestEnvelope(3, HEAD_B, { previousHeadRefOid: HEAD_A }),
      { activate: false },
    ).source,
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding({ items: [pendingB] }, bindingA),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const activeB = sourceItem(
    activatePendingPullRequestWorkSource(pendingB.source).source,
  );
  const bindingB = executionBinding(activeB);
  assert.throws(
    () => verifyPullRequestExecutionBinding({ items: [activeB] }, bindingA),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [activeB] }, bindingB),
    bindingB,
  );
});

test("v2 execution authority survives same-target facts but rejects same-Head target changes", () => {
  const gitFacts = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const initial = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts }),
    ).source,
  );
  const binding = executionBinding(initial);
  assert.equal(binding.schemaVersion, 2);

  const sameTarget = sourceItem(
    appendPullRequestWorkSource(
      initial.source,
      pullRequestEnvelope(2, HEAD_A, { gitFacts }),
    ).source,
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [sameTarget] }, binding),
    binding,
  );

  const changedBase = sourceItem(
    appendPullRequestWorkSource(
      sameTarget.source,
      pullRequestEnvelope(3, HEAD_A, {
        gitFacts: {
          gitTargetAvailable: true,
          gitTarget: {
            ...gitFacts.gitTarget,
            baseRefOid: "e".repeat(40),
          },
        },
      }),
    ).source,
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding({ items: [changedBase] }, binding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("graph admission preserves same-target facts but fences same-Head target drift", () => {
  const gitFacts = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const originalRoot = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts }),
    ).source,
  );
  const child = {
    itemId: "work-item-child",
    kind: "graph_task",
    assignment: {
      graphTask: { sourceBinding: currentWorkItemInputBinding(originalRoot) },
    },
    event: currentWorkItemEvent(originalRoot),
  };
  const sameTargetRoot = sourceItem(
    appendPullRequestWorkSource(
      originalRoot.source,
      pullRequestEnvelope(2, HEAD_A, { gitFacts }),
    ).source,
  );
  assert.equal(
    pullRequestHeadAdmission(
      { items: [sameTargetRoot, child] },
      child,
    ).current,
    true,
  );

  const changedTargetRoot = sourceItem(
    appendPullRequestWorkSource(
      sameTargetRoot.source,
      pullRequestEnvelope(3, HEAD_A, {
        gitFacts: {
          gitTargetAvailable: true,
          gitTarget: { ...gitFacts.gitTarget, baseRefOid: "e".repeat(40) },
        },
      }),
    ).source,
  );
  assert.equal(
    pullRequestHeadAdmission(
      { items: [changedTargetRoot, child] },
      child,
    ).current,
    false,
  );
});

test("the latest accepted source sequence wins a provenance cutover", () => {
  const originalRoot = sourceItem(initialSource());
  const binding = executionBinding(originalRoot);
  const competingRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_A, { sourceScopeId: "other-scope" }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const state = { items: [originalRoot, competingRoot] };

  assert.equal(pullRequestHeadAdmission(state, originalRoot).current, false);
  assert.equal(pullRequestHeadAdmission(state, competingRoot).current, true);
  assert.throws(
    () => verifyPullRequestExecutionBinding(state, binding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding(state, executionBinding(competingRoot)),
    executionBinding(competingRoot),
  );

  const returnedRoot = sourceItem(
    appendPullRequestWorkSource(
      originalRoot.source,
      pullRequestEnvelope(3, HEAD_A),
      {
        causalHeadRefOid: HEAD_A,
        authorityEpochChanged: true,
      },
    ).source,
  );
  const returnedState = { items: [returnedRoot, competingRoot] };
  assert.equal(returnedRoot.source.headRevision, 2);
  assert.equal(pullRequestHeadAdmission(returnedState, returnedRoot).current, true);
  assert.equal(pullRequestHeadAdmission(returnedState, competingRoot).current, false);
  assert.throws(
    () => verifyPullRequestExecutionBinding(returnedState, binding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("ambiguous equal-sequence provenance roots both fail closed", () => {
  const originalRoot = sourceItem(initialSource());
  const competingRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(1, HEAD_A, { sourceScopeId: "other-scope" }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const state = { items: [originalRoot, competingRoot] };

  assert.equal(pullRequestHeadAdmission(state, originalRoot).current, false);
  assert.equal(pullRequestHeadAdmission(state, competingRoot).current, false);
});

test("an unproven higher observation fences every provenance", () => {
  const originalRoot = sourceItem(initialSource());
  const competingRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_A, { sourceScopeId: "other-scope" }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const ignoredHigherSequence = sourceItem(
    appendPullRequestWorkSource(
      originalRoot.source,
      pullRequestEnvelope(3, HEAD_B),
    ).source,
  );
  const state = { items: [ignoredHigherSequence, competingRoot] };

  assert.equal(
    ignoredHigherSequence.source.revisions.at(-1).disposition,
    "ignored_unproven_head",
  );
  assert.equal(
    pullRequestHeadAdmission(state, ignoredHigherSequence).current,
    false,
  );
  assert.equal(pullRequestHeadAdmission(state, competingRoot).current, false);
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      state,
      executionBinding(competingRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a later assignment cannot replay an older provenance into authority", () => {
  const recentRoot = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(2, HEAD_B, {
        occurredAt: "2026-08-02T02:00:00.000Z",
      }),
    ).source,
  );
  const replayedOlderRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(3, HEAD_A, {
          sourceScopeId: "other-scope",
          occurredAt: "2026-08-02T01:00:00.000Z",
        }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const state = { items: [recentRoot, replayedOlderRoot] };

  assert.equal(pullRequestHeadAdmission(state, recentRoot).current, true);
  assert.equal(
    pullRequestHeadAdmission(state, replayedOlderRoot).current,
    false,
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding(state, executionBinding(recentRoot)),
    executionBinding(recentRoot),
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      state,
      executionBinding(replayedOlderRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a provenance return proves its Head against the global predecessor", () => {
  const originalRoot = sourceItem(initialSource());
  const competingRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_B, {
          previousHeadRefOid: HEAD_A,
          sourceScopeId: "other-scope",
        }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const competingState = { items: [originalRoot, competingRoot] };
  const predecessorHead = pullRequestTrustedPredecessorHead(
    competingState,
    originalRoot,
  );
  assert.equal(predecessorHead, HEAD_B);

  const returnedRoot = sourceItem(
    appendPullRequestWorkSource(
      originalRoot.source,
      pullRequestEnvelope(3, HEAD_C, { previousHeadRefOid: HEAD_B }),
      { causalHeadRefOid: predecessorHead },
    ).source,
  );
  const returnedState = { items: [returnedRoot, competingRoot] };

  assert.equal(
    returnedRoot.source.revisions.at(-1).causalHeadRefOid,
    HEAD_B,
  );
  assert.equal(pullRequestHeadAdmission(returnedState, returnedRoot).current, true);
  assert.equal(pullRequestHeadAdmission(returnedState, competingRoot).current, false);
  assert.deepEqual(
    verifyPullRequestExecutionBinding(
      returnedState,
      executionBinding(returnedRoot),
    ),
    executionBinding(returnedRoot),
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      returnedState,
      executionBinding(competingRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a later legacy provenance cannot downgrade target-aware authority", () => {
  const gitFacts = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const targetAwareRoot = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts }),
    ).source,
  );
  const legacyRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_A, { sourceScopeId: "other-scope" }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
  };
  const downgradedState = { items: [targetAwareRoot, legacyRoot] };

  assert.equal(
    pullRequestHeadAdmission(downgradedState, targetAwareRoot).current,
    false,
  );
  assert.equal(pullRequestHeadAdmission(downgradedState, legacyRoot).current, false);
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      downgradedState,
      executionBinding(legacyRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );

  const recoveredTargetRoot = sourceItem(
    appendPullRequestWorkSource(
      targetAwareRoot.source,
      pullRequestEnvelope(3, HEAD_A, { gitFacts }),
      {
        causalHeadRefOid: HEAD_A,
        authorityEpochChanged: true,
      },
    ).source,
  );
  const recoveredState = { items: [recoveredTargetRoot, legacyRoot] };
  assert.equal(
    pullRequestHeadAdmission(recoveredState, recoveredTargetRoot).current,
    true,
  );
  assert.equal(pullRequestHeadAdmission(recoveredState, legacyRoot).current, false);
});

test("a same-source legacy downgrade fences until exact target facts recover", () => {
  const gitFacts = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const targetAwareRoot = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts }),
    ).source,
  );
  const originalBinding = executionBinding(targetAwareRoot);
  const downgrade = sourceItem(
    appendPullRequestWorkSource(
      targetAwareRoot.source,
      pullRequestEnvelope(2, HEAD_A),
    ).source,
  );

  assert.equal(
    downgrade.source.revisions.at(-1).disposition,
    "ignored_legacy_downgrade",
  );
  assert.equal(pullRequestHeadAdmission({ items: [downgrade] }, downgrade).current, false);

  const recovered = sourceItem(
    appendPullRequestWorkSource(
      downgrade.source,
      pullRequestEnvelope(3, HEAD_A, { gitFacts }),
      {
        causalHeadRefOid: HEAD_A,
        authorityEpochChanged: true,
      },
    ).source,
  );
  assert.equal(
    pullRequestHeadAdmission({ items: [recovered] }, recovered).current,
    true,
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      { items: [recovered] },
      originalBinding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("an unavailable target provenance fences until exact facts recover", () => {
  const gitFacts = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const targetAwareRoot = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts }),
    ).source,
  );
  const originalBinding = executionBinding(targetAwareRoot);
  const unavailableRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_A, {
          gitFacts: { gitTargetAvailable: false },
          sourceScopeId: "unavailable-scope",
        }),
      ).source,
    ),
    itemId: "work-item-pr-42-unavailable-scope",
  };
  const fencedState = { items: [targetAwareRoot, unavailableRoot] };

  assert.equal(
    pullRequestHeadAdmission(fencedState, targetAwareRoot).current,
    false,
  );
  assert.equal(
    pullRequestHeadAdmission(fencedState, unavailableRoot).current,
    false,
  );

  const recoveredTargetRoot = sourceItem(
    appendPullRequestWorkSource(
      targetAwareRoot.source,
      pullRequestEnvelope(3, HEAD_A, { gitFacts }),
      {
        causalHeadRefOid: HEAD_A,
        authorityEpochChanged: true,
      },
    ).source,
  );
  const recoveredState = { items: [recoveredTargetRoot, unavailableRoot] };
  assert.equal(
    pullRequestHeadAdmission(recoveredState, recoveredTargetRoot).current,
    true,
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding(recoveredState, originalBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("an exact target rollback creates a new monotonic authority epoch", () => {
  const targetOne = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const targetTwo = {
    gitTargetAvailable: true,
    gitTarget: {
      ...targetOne.gitTarget,
      baseRefOid: "e".repeat(40),
    },
  };
  const initial = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, { gitFacts: targetOne }),
    ).source,
  );
  const originalBinding = executionBinding(initial);
  const changed = sourceItem(
    appendPullRequestWorkSource(
      initial.source,
      pullRequestEnvelope(2, HEAD_A, { gitFacts: targetTwo }),
    ).source,
  );
  const rolledBack = sourceItem(
    appendPullRequestWorkSource(
      changed.source,
      pullRequestEnvelope(3, HEAD_A, { gitFacts: targetOne }),
    ).source,
  );
  const state = { items: [rolledBack] };

  assert.deepEqual(
    rolledBack.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 3],
  );
  assert.deepEqual(
    rolledBack.source.revisions.map(({ authorityEpochChanged }) =>
      authorityEpochChanged
    ),
    [false, true, true],
  );
  assert.throws(
    () => verifyPullRequestExecutionBinding(state, originalBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding(state, executionBinding(rolledBack)),
    executionBinding(rolledBack),
  );
});

test("legacy multi-revision authority history receives one durable migration cutover", () => {
  const targetOne = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const targetTwo = {
    gitTargetAvailable: true,
    gitTarget: {
      ...targetOne.gitTarget,
      baseRefOid: "e".repeat(40),
    },
  };
  const initial = createPullRequestWorkSource(
    pullRequestEnvelope(1, HEAD_A, { gitFacts: targetOne }),
  ).source;
  const changed = appendPullRequestWorkSource(
    initial,
    pullRequestEnvelope(2, HEAD_A, { gitFacts: targetTwo }),
  ).source;
  const rolledBack = appendPullRequestWorkSource(
    changed,
    pullRequestEnvelope(3, HEAD_A, { gitFacts: targetOne }),
  ).source;
  const preUpgradeBinding = executionBinding(sourceItem(rolledBack));
  const legacy = structuredClone(rolledBack);
  for (const revision of legacy.revisions) {
    delete revision.causalHeadRefOid;
    delete revision.authorityEpochChanged;
    delete revision.authorityEpochCutover;
  }

  const migrated = normalizePullRequestWorkSource(legacy);
  const restarted = normalizePullRequestWorkSource(
    JSON.parse(JSON.stringify(migrated)),
  );
  const migratedItem = sourceItem(restarted);

  assert.deepEqual(
    restarted.revisions.map(({ headRevision }) => headRevision),
    [1, 2, 4],
  );
  assert.deepEqual(
    restarted.revisions.map(({ authorityEpochCutover }) =>
      authorityEpochCutover
    ),
    [false, false, true],
  );
  assert.deepEqual(restarted, migrated);
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      { items: [migratedItem] },
      preUpgradeBinding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = executionBinding(migratedItem);
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [migratedItem] }, currentBinding),
    currentBinding,
  );

  const appended = appendPullRequestWorkSource(
    restarted,
    pullRequestEnvelope(4, HEAD_A, { gitFacts: targetOne }),
  ).source;
  assert.doesNotThrow(() =>
    validatePullRequestSourceTransition(
      [sourceItem(restarted)],
      [sourceItem(appended)],
    )
  );
});

test("a single accepted legacy revision migrates without invalidating its binding", () => {
  const legacy = structuredClone(initialSource());
  const itemBeforeUpgrade = sourceItem(legacy);
  const binding = executionBinding(itemBeforeUpgrade);
  delete legacy.revisions[0].causalHeadRefOid;
  delete legacy.revisions[0].authorityEpochChanged;
  delete legacy.revisions[0].authorityEpochCutover;

  const migratedItem = sourceItem(normalizePullRequestWorkSource(legacy));

  assert.equal(migratedItem.source.headRevision, 1);
  assert.equal(
    migratedItem.source.revisions[0].authorityEpochCutover,
    false,
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [migratedItem] }, binding),
    binding,
  );
});

test("explicit authority epochs without the cutover field remain compatible", () => {
  const changed = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
  ).source;
  const binding = executionBinding(sourceItem(changed));
  const previousSchema = structuredClone(changed);
  for (const revision of previousSchema.revisions) {
    delete revision.authorityEpochCutover;
  }

  const migratedItem = sourceItem(
    normalizePullRequestWorkSource(previousSchema),
  );

  assert.deepEqual(
    migratedItem.source.revisions.map(({ headRevision }) => headRevision),
    [1, 2],
  );
  assert.deepEqual(
    migratedItem.source.revisions.map(({ authorityEpochCutover }) =>
      authorityEpochCutover
    ),
    [false, false],
  );
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [migratedItem] }, binding),
    binding,
  );
});

test("a forged authority cutover marker cannot create an ordinary epoch", () => {
  const changed = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, { previousHeadRefOid: HEAD_A }),
  ).source;
  const forged = structuredClone(changed);
  forged.revisions[1].authorityEpochCutover = true;

  assert.throws(
    () => normalizePullRequestWorkSource(forged),
    (error) => error.code === "WORK_LEDGER_PR_SOURCE_INVALID",
  );
});

test("legacy migration seals the latest accepted pending revision before ignored fences", () => {
  const target = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_B,
    },
  };
  const pending = appendPullRequestWorkSource(
    initialSource(),
    pullRequestEnvelope(2, HEAD_B, {
      previousHeadRefOid: HEAD_A,
      gitFacts: target,
    }),
    { activate: false },
  ).source;
  const fenced = appendPullRequestWorkSource(
    pending,
    pullRequestEnvelope(3, HEAD_B),
    { activate: false },
  ).source;
  const legacy = structuredClone(fenced);
  for (const revision of legacy.revisions) {
    delete revision.causalHeadRefOid;
    delete revision.authorityEpochChanged;
    delete revision.authorityEpochCutover;
  }

  const migrated = normalizePullRequestWorkSource(legacy);

  assert.equal(migrated.pendingRevision, 2);
  assert.equal(migrated.revisions[1].authorityEpochCutover, true);
  assert.equal(migrated.revisions[1].headRevision, 3);
  assert.equal(migrated.revisions[2].disposition, "ignored_legacy_downgrade");
  assert.equal(migrated.revisions[2].authorityEpochCutover, false);
});

test("same-source unavailable facts fence future authority and exact recovery advances the epoch", () => {
  const target = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const future = sourceItem(
    createPullRequestWorkSource(
      pullRequestEnvelope(1, HEAD_A, {
        gitFacts: target,
        occurredAt: "2099-01-01T00:00:00.000Z",
      }),
    ).source,
  );
  const oldBinding = executionBinding(future);
  const fenced = sourceItem(
    appendPullRequestWorkSource(
      future.source,
      pullRequestEnvelope(2, HEAD_A, {
        gitFacts: { gitTargetAvailable: false },
        occurredAt: "2026-08-02T01:00:02.000Z",
      }),
    ).source,
  );

  assert.equal(fenced.source.current.eventId, future.source.current.eventId);
  assert.equal(
    fenced.source.revisions.at(-1).disposition,
    "ignored_authority_fence",
  );
  assert.equal(pullRequestHeadAdmission({ items: [fenced] }, fenced).current, false);

  const differentTarget = {
    gitTargetAvailable: true,
    gitTarget: {
      ...target.gitTarget,
      baseRefOid: "e".repeat(40),
    },
  };
  const refused = sourceItem(
    appendPullRequestWorkSource(
      fenced.source,
      pullRequestEnvelope(3, HEAD_A, {
        gitFacts: differentTarget,
        occurredAt: "2026-08-02T01:00:03.000Z",
      }),
    ).source,
  );
  assert.equal(refused.source.revisions.at(-1).disposition, "ignored_stale");
  assert.equal(pullRequestHeadAdmission({ items: [refused] }, refused).current, false);

  const recovered = sourceItem(
    normalizePullRequestWorkSource(
      appendPullRequestWorkSource(
        refused.source,
        pullRequestEnvelope(4, HEAD_A, {
          gitFacts: target,
          occurredAt: "2026-08-02T01:00:04.000Z",
        }),
      ).source,
    ),
  );
  assert.equal(recovered.source.headRevision, 2);
  assert.equal(pullRequestHeadAdmission({ items: [recovered] }, recovered).current, true);
  assert.throws(
    () => verifyPullRequestExecutionBinding({ items: [recovered] }, oldBinding),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
  const currentBinding = executionBinding(recovered);
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [recovered] }, currentBinding),
    currentBinding,
  );
});

test("lower-time authority-negative observations fence future trusted roots globally", () => {
  const target = {
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid: HEAD_A,
    },
  };
  const futureRoot = sourceItem(
    normalizePullRequestWorkSource(
      createPullRequestWorkSource(
        pullRequestEnvelope(1, HEAD_A, {
          gitFacts: target,
          occurredAt: "2099-01-01T00:00:00.000Z",
        }),
      ).source,
    ),
  );
  const cases = [
    {
      name: "unavailable",
      root: {
        ...sourceItem(
          normalizePullRequestWorkSource(
            createPullRequestWorkSource(
              pullRequestEnvelope(2, HEAD_A, {
                gitFacts: { gitTargetAvailable: false },
                sourceScopeId: "unavailable-scope",
                occurredAt: "2026-08-02T01:00:02.000Z",
              }),
            ).source,
          ),
        ),
        itemId: "work-item-pr-42-unavailable",
      },
    },
    {
      name: "legacy",
      root: {
        ...sourceItem(
          normalizePullRequestWorkSource(
            createPullRequestWorkSource(
              pullRequestEnvelope(2, HEAD_A, {
                sourceScopeId: "legacy-scope",
                occurredAt: "2026-08-02T01:00:02.000Z",
              }),
            ).source,
          ),
        ),
        itemId: "work-item-pr-42-legacy",
      },
    },
    {
      name: "quarantine",
      root: {
        ...sourceItem(
          normalizePullRequestWorkSource(
            createPullRequestWorkSource(
              pullRequestEnvelope(2, HEAD_A, {
                gitFacts: target,
                sourceScopeId: "quarantine-scope",
                occurredAt: "2026-08-02T01:00:02.000Z",
              }),
            ).source,
          ),
        ),
        itemId: "work-item-pr-42-quarantine",
        sourceQuarantine: { kind: "legacy" },
      },
    },
  ];

  for (const { name, root } of cases) {
    const state = { items: [futureRoot, root] };
    assert.equal(
      pullRequestHeadAdmission(state, futureRoot).current,
      false,
      name,
    );
    assert.throws(
      () => verifyPullRequestExecutionBinding(
        state,
        executionBinding(futureRoot),
      ),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
      name,
    );
  }
});

test("rebinding an old event is audit-only and cannot displace the current authority", () => {
  const firstEnvelope = pullRequestEnvelope(1, HEAD_A, {
    occurredAt: "2026-08-02T01:00:01.000Z",
  });
  const first = createPullRequestWorkSource(firstEnvelope).source;
  const second = appendPullRequestWorkSource(
    first,
    pullRequestEnvelope(2, HEAD_A, {
      occurredAt: "2026-08-02T01:00:01.000Z",
    }),
  ).source;
  const currentItem = sourceItem(second);
  const currentBinding = executionBinding(currentItem);
  const replay = {
    sequence: 3,
    assignment: {
      ...firstEnvelope.assignment,
      assignmentId: "workflow-assignment-pr-3-replay",
      createdAt: "2026-08-02T01:00:03.000Z",
    },
    event: firstEnvelope.event,
  };
  const rebound = sourceItem(
    appendPullRequestWorkSource(second, replay).source,
  );

  assert.equal(rebound.source.current.eventId, second.current.eventId);
  assert.equal(pullRequestHeadAdmission({ items: [rebound] }, rebound).current, true);
  assert.deepEqual(
    verifyPullRequestExecutionBinding({ items: [rebound] }, currentBinding),
    currentBinding,
  );
});

test("a quarantined latest provenance never resurrects its predecessor", () => {
  const originalRoot = sourceItem(initialSource());
  const quarantinedRoot = {
    ...sourceItem(
      createPullRequestWorkSource(
        pullRequestEnvelope(2, HEAD_A, { sourceScopeId: "other-scope" }),
      ).source,
    ),
    itemId: "work-item-pr-42-other-scope",
    sourceQuarantine: { kind: "legacy" },
  };
  const state = { items: [originalRoot, quarantinedRoot] };

  assert.equal(pullRequestHeadAdmission(state, originalRoot).current, false);
  assert.equal(pullRequestHeadAdmission(state, quarantinedRoot).current, false);
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      state,
      executionBinding(originalRoot),
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("a legacy v1 binding becomes stale when the same Head gains a live Git target", () => {
  const legacyItem = sourceItem(initialSource());
  const legacyBinding = executionBinding(legacyItem);
  assert.equal(legacyBinding.schemaVersion, 1);
  const targetAware = sourceItem(
    appendPullRequestWorkSource(
      legacyItem.source,
      pullRequestEnvelope(2, HEAD_A, {
        gitFacts: {
          gitTargetAvailable: true,
          gitTarget: {
            schemaVersion: 1,
            provider: "github",
            sourceAccountId: "runtime-user",
            baseRepository: "acme/repo",
            baseRefName: "main",
            baseRefOid: "d".repeat(40),
            headRepository: "contributor/repo",
            headRefName: "fix/conflict",
            headRefOid: HEAD_A,
          },
        },
      }),
    ).source,
  );

  assert.throws(
    () => verifyPullRequestExecutionBinding(
      { items: [targetAware] },
      legacyBinding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});

test("execution authority rejects forged identity, provenance, and quarantined roots", () => {
  const item = sourceItem(initialSource());
  const binding = executionBinding(item);
  for (const forged of [
    { ...binding, repository: "other/repo" },
    { ...binding, inputDigest: "f".repeat(64) },
    { ...binding, eventDigest: "e".repeat(64) },
  ]) {
    assert.throws(
      () => verifyPullRequestExecutionBinding({ items: [item] }, forged),
      (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
    );
  }
  assert.throws(
    () => verifyPullRequestExecutionBinding(
      { items: [{ ...item, sourceQuarantine: { kind: "legacy" } }] },
      binding,
    ),
    (error) => error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE",
  );
});
