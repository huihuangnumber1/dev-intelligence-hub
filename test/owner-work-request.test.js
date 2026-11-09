import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOwnerIssueEvent,
  createOwnerPullRequestEvent,
  createPrTriageWorkRequest,
  createOwnerWorkRequestEvent,
  normalizeOwnerWorkRequest,
  normalizeStoredOwnerWorkRequest,
  ownerWorkRequestEventMatches,
  withOwnerWorkRequestDefaultRoute,
} from "../src/domain/owner-work-request.js";
import { StateStore } from "../src/lib/state-store.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";
import { createOwnerWorkRequestRuntime } from "../src/owner-work-request-runtime.js";
import {
  normalizeOwnerWorkRequestState,
  OWNER_WORK_REQUEST_STATE_KEY,
} from "../src/services/owner-work-request-state.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";
import { OrchestratorService } from "../src/services/orchestrator-service.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { createPullRequestWorkSource, currentWorkItemExecutionBinding, normalizePullRequestWorkSource } from "../src/services/work-ledger-pr-source.js";
import { AutomaticReviewScopeExitReader } from "../src/services/automatic-review-scope-exit-reader.js";
import { emptyWorkGraphMemoryProjection, reconcileMigratedWorkGraphMemoryAuthority } from "../src/services/work-ledger-graph-memory.js";
import { normalizeWorkLedgerLimits } from "../src/services/work-ledger-state.js";
import { ownerWorkRequestForItem } from "../public/manual-work-assignment.js";
import { normalizeBoundWorkProposal, workProposalDigest, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { standardReviewPurpose } from "../src/domain/review-result-proof.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function deterministicRequestId(seed) {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    workType: "general",
    priority: "high",
    title: "Build a safe owner intake",
    description: "Route one durable shared task through the command center.",
    acceptanceCriteria: ["One shared root", "No browser-selected authority"],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    schemaVersion: 2,
    requestId: REQUEST_ID,
    workType: "pull_request",
    priority: "high",
    title: "Review an explicitly selected PR",
    description: "Continue this PR even when it is outside automatic discovery.",
    acceptanceCriteria: ["Use a newly bound authority source"],
    pullRequest: { repository: "acme/repo", number: 42 },
    ...overrides,
  };
}

test("new owner Review UI requests carry explicit purpose while old request and source bytes remain unchanged", () => {
  const original = pullRequest();
  const legacy = normalizeOwnerWorkRequest(original);
  assert.equal(Object.hasOwn(legacy, "reviewPurpose"), false);
  assert.equal(JSON.stringify(legacy), JSON.stringify(original));
  const item = { kind: "pull_request", repo: "acme/repo", number: 42, title: "Review PR", state: "open" };
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo",
    baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "acme/repo", headRefName: "fix", headRefOid: "b".repeat(40) };
  const resolved = { repository: "acme/repo", number: 42, title: "Review PR", state: "open", gitTarget };
  const before = createOwnerPullRequestEvent(legacy, resolved, "2026-10-28T05:00:00.000Z");
  assert.equal(Object.hasOwn(before.payload, "reviewPurpose"), false);
  assert.equal(standardReviewPurpose(before), null, "unmarked direct legacy owner tasks have no reusable typed purpose");
  const { eventId: _eventId, contentDigest: _contentDigest, ...rawEvent } = before;
  assert.equal(normalizeWorkflowEvent(rawEvent).contentDigest, before.contentDigest);
  for (const purpose of ["standard_current_pr_code_review/v1", "independent_review/v1"]) {
    const ui = ownerWorkRequestForItem(item, { workType: "pull_request", priority: "high", requestId: REQUEST_ID,
      ...(purpose === "independent_review/v1" ? { reviewPurpose: purpose } : {}) });
    const normalized = normalizeOwnerWorkRequest(ui);
    assert.equal(normalized.reviewPurpose, purpose);
    const event = createOwnerPullRequestEvent(normalized, resolved, "2026-10-28T05:00:00.000Z");
    assert.equal(event.payload.reviewPurpose, purpose);
    assert.equal(ownerWorkRequestEventMatches(normalized, event, event.occurredAt), true);
    assert.equal(ownerWorkRequestEventMatches({ ...normalized, reviewPurpose: purpose === "independent_review/v1"
      ? "standard_current_pr_code_review/v1" : "independent_review/v1" }, event, event.occurredAt), false);
  }
  assert.equal(JSON.stringify(createOwnerPullRequestEvent(legacy, resolved, "2026-10-28T05:00:00.000Z")), JSON.stringify(before));
});

function issue(overrides = {}) {
  return {
    schemaVersion: 6,
    requestId: REQUEST_ID,
    workType: "development",
    priority: "high",
    title: "Implement an explicitly selected Issue",
    description: "Continue this Issue even when it is outside automatic discovery.",
    acceptanceCriteria: ["Keep the GitHub Issue identity"],
    issue: { repository: "acme/repo", number: 43 },
    ...overrides,
  };
}

function guardFactory() {
  return {
    async acquire() {},
    async run(operation) {
      return operation();
    },
    async close() {},
  };
}

function clockFixture() {
  let now = Date.parse("2026-08-08T01:00:00.000Z");
  return () => {
    const value = new Date(now);
    now += 1_000;
    return value;
  };
}

function routingConfig({ enabled = true, legacyExitRoute = false } = {}) {
  return {
    workflowRouting: {
      schemaVersion: 1,
      enabled,
      maxHops: 8,
      rules: [
        ...(legacyExitRoute ? [{ id: "legacy-exit-route", source: "root", enabled: true, priority: 1000, fallback: false,
          condition: { op: "globAny", path: "eventType", patterns: ["pull_request.created", "pull_request.left_scope"] },
          targets: [{ type: "role", id: "pr-engineer" }], onMatch: "stop" }] : []),
        {
          id: "generic-owner-fallback",
          source: "root",
          enabled: true,
          priority: 0,
          fallback: true,
          condition: null,
          targets: [{ type: "person", id: "local-user" }],
          onMatch: "stop",
        },
      ],
    },
  };
}

function roleReadiness(overrides = {}) {
  return {
    async read(roleId) {
      return {
        roleId,
        enabled: true,
        paused: false,
        ...overrides,
      };
    },
  };
}

async function expireUnstartedCodeProposal(ledger, item, clock, possibleJob = false) {
  const intent = { schemaVersion: 1, type: "propose_code_action", operation: "modify", objective: "Fix the verified regression",
    acceptanceCriteria: ["Preserve current source authority"], summary: "Continue repair", reason: "Verified internal feedback", evidence: [] };
  const staged = await ledger.stageIntent({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
    actorId: "employee-developer", roleId: "developer", intent });
  const content = { policyVersion: 1, kind: "code_action_proposal", requestedBy: { roleId: "developer", workItemId: item.itemId },
    source: { assignmentId: item.assignmentId, eventId: item.event.eventId },
    binding: { eventId: item.event.eventId, subject: item.event.subject, repository: "acme/repo", workspaceId: "repair",
      inputBinding: currentWorkItemExecutionBinding(item) },
    payload: Object.fromEntries(["operation", "objective", "acceptanceCriteria", "summary", "reason", "evidence"].map(key => [key, intent[key]])) };
  const proposal = normalizeBoundWorkProposal({ proposalId: `work-intent-${workProposalDigest(content)}`, ...content });
  let outbox = await ledger.claimIntent({ intentId: staged.outbox.intentId, expectedRevision: staged.outbox.revision,
    dispatcherId: "work-intent-dispatcher", leaseDurationMs: 30_000 });
  outbox = await ledger.bindIntent({ intentId: outbox.intentId, expectedRevision: outbox.revision,
    itemExpectedRevision: staged.item.revision, dispatcherId: outbox.dispatcherId, dispatchLeaseId: outbox.dispatchLeaseId,
    boundIntent: { intentId: proposal.proposalId, ...content } });
  await ledger.ackIntent({ intentId: outbox.intentId, expectedRevision: outbox.revision, itemExpectedRevision: staged.item.revision,
    dispatchLeaseId: outbox.dispatchLeaseId, actorId: "work-intent-dispatcher", outcome: "delivered", nextStatus: "waiting_external",
    details: { downstreamRef: proposal.proposalId, proposalDigest: proposal.contentDigest } });
  const confirmationId = "confirmation-code-job-unstarted";
  const result = createWorkProposalResult({ proposal, sequence: 1, at: clock().toISOString(), downstreamRef: confirmationId,
    transition: { status: "stale", summary: "Confirmation expired", evidence: [`confirmation:${confirmationId}`,
      ...(possibleJob ? ["code-job:possibly-running"] : [])] } });
  await ledger.applyProposalBatch({ items: [result], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 });
}

for (const kind of ["own_pr_repair", "own_pr_ci_repair"])
for (const roleId of ["pr-engineer", "developer"])
for (const variant of ["changed-base", "same-target", "proposal-stale-changed-base", "proposal-stale-same-target", "unproven-proposal-stale", "possible-job-proposal-stale", "changed-head", "changed-ref", "changed-account", "paused", "concurrent-pause", "unavailable"]) {
  if (variant.includes("proposal-stale") && roleId !== "developer") continue;
  test(`internal repair review follows a new Base while retaining its published Head (${kind}, ${roleId}, ${variant})`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "internal-review-refresh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new StateStore(path.join(root, "state")), clock = clockFixture();
    const { routing, ledger } = await createRoutingAndLedger(store, clock);
    let head = "a".repeat(40), base = "b".repeat(40), ref = "main", account = "runtime-user", unavailable = false;
    let duringResolve = async () => {};
    const owner = await createOwnerWorkRequestRuntime({ store, workflowRouting: routing, ledger,
      roleReadiness: roleReadiness(), clock, createGuard: guardFactory,
      pullRequestResolver: { async resolvePullRequestTarget(target) {
        if (unavailable) throw new Error("GitHub unavailable");
        await duringResolve();
        return { ...target, title: "Published repair", state: "open", gitTarget: { schemaVersion: 1, provider: "github",
          sourceAccountId: account, baseRepository: target.repository, baseRefName: ref, baseRefOid: base,
          headRepository: target.repository, headRefName: "repair", headRefOid: head } };
      } },
    });
    t.after(async () => { await owner.close(); await ledger.close(); await routing.close(); });
    const submitted = await owner.submitInternalReview(pullRequest({ schemaVersion: 7, internalReview: { kind, headRefOid: head,
      feedbackDigest: "c".repeat(64), publicationConfirmationId: "confirmed-publication", controlledCommitEvidenceId: "controlled-commit" } }));
    const original = await owner.get(submitted.requestId);
    let item = await ledger.readItemForReconciliation({ itemId: submitted.workItemId });
    if (roleId === "developer") item = await ledger.handoff({ itemId: item.itemId, expectedRevision: item.revision,
      leaseId: null, actorId: "employee-pr-engineer", target: { type: "role", id: "developer" }, reason: "verified_defect" });
    item = await ledger.claim({ itemId: item.itemId, expectedRevision: item.revision,
      workerId: `employee-${roleId}`, leaseDurationMs: 30_000 });
    if (variant.startsWith("proposal-stale") || variant === "possible-job-proposal-stale") {
      await expireUnstartedCodeProposal(ledger, item, clock, variant === "possible-job-proposal-stale");
    }
    else await ledger.scheduleRetry({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
      actorId: `employee-${roleId}`, reason: "system_maintenance_auto_retry", details: { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" },
      availableAt: new Date(clock().getTime() + 2_000).toISOString(), consumeAttempt: false });
    if (variant === "unproven-proposal-stale") {
      const current = await ledger.readItemForReconciliation({ itemId: item.itemId });
      await ledger.transition({ itemId: item.itemId, expectedRevision: current.revision, leaseId: null,
        actorId: "work-ledger-system", toStatus: "blocked", reason: "proposal_stale" });
    }
    const pause = async () => {
      let current = await ledger.readItemForReconciliation({ itemId: item.itemId });
      if (current.status === "retry_wait") current = await ledger.transition({ itemId: current.itemId,
        expectedRevision: current.revision, leaseId: null, actorId: "work-ledger-system", toStatus: "queued", reason: "test_ready" });
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: item.itemId }).pauseTask({ taskId: item.itemId,
        expectedTaskRevision: current.revision, expectedGraphRevision: (await ledger.getSummary()).revision, reason: "owner_paused" });
    };
    if (!variant.endsWith("same-target")) base = "d".repeat(40);
    if (variant === "changed-head") head = "e".repeat(40);
    if (variant === "changed-ref") ref = "other";
    if (variant === "changed-account") account = "other-user";
    if (variant === "paused") await pause();
    if (variant === "concurrent-pause") duringResolve = pause;
    if (variant === "unavailable") unavailable = true;
    const shouldRefresh = ["changed-base", "proposal-stale-changed-base"].includes(variant);
    assert.equal((await owner.refreshBlockedPullRequestSources()).refreshed, shouldRefresh ? 1 : 0);
    const current = await ledger.readItemForReconciliation({ itemId: item.itemId });
    assert.equal(current.source.current.headRefOid, original.request.internalReview.headRefOid);
    assert.equal(current.currentTarget.id, roleId);
    assert.deepEqual(current.source.current.event.payload.internalReview, original.request.internalReview);
    assert.equal(current.source.current.event.payload.gitTarget.baseRefOid, shouldRefresh ? base : "b".repeat(40));
    assert.equal(current.status, ["paused", "concurrent-pause"].includes(variant) ? "paused" : shouldRefresh ? "queued" :
      variant.includes("proposal-stale") ? "blocked" : "retry_wait");
    assert.deepEqual((await owner.get(submitted.requestId)).request, original.request);
    assert.deepEqual((await owner.get(submitted.requestId)).event, original.event);
  });
}

function capabilityReadiness(overrides = {}) {
  return {
    async read(capability) {
      return {
        capability,
        roleId: capability === "development" ? "developer" : "pr-engineer",
        enabled: true,
        paused: false,
        ...overrides,
      };
    },
  };
}

async function createRoutingAndLedger(store, clock, options = {}) {
  const routing = await createWorkflowRoutingRuntime(
    routingConfig(options),
    { store, clock, createGuard: guardFactory,
      ...(options.scopeExitRecoveryReader ? { scopeExitRecoveryReader: options.scopeExitRecoveryReader } : {}) },
  );
  const ledger = await createWorkLedgerRuntime({
    store,
    assignmentSource: routing,
    clock,
    idFactory: () => "owner-work-lease",
    createGuard: guardFactory,
  });
  return { routing, ledger };
}

test("owner request DTO exposes business fields only and creates a bound workflow event", () => {
  const normalized = normalizeOwnerWorkRequest(request({
    title: "  Build intake  ",
    acceptanceCriteria: ["  One root  "],
  }));
  assert.equal(normalized.title, "Build intake");
  assert.deepEqual(normalized.acceptanceCriteria, ["One root"]);
  assert.equal(Object.isFrozen(normalized), true);

  const event = createOwnerWorkRequestEvent(
    normalized,
    "2026-08-08T01:00:00.000Z",
  );
  assert.equal(event.eventType, "owner_request.created");
  assert.deepEqual(event.subject, {
    id: `owner-request:${REQUEST_ID}`,
    requestId: REQUEST_ID,
  });
  assert.deepEqual(event.source, {
    provider: "local-owner",
    scopeId: "owner-command-center",
  });
  assert.equal("roleId" in event.payload, false);
  assert.equal("nodeId" in event.payload, false);
  assert.equal("permissions" in event.payload, false);
  const baseEvent = {
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    source: event.source,
    subject: event.subject,
    payload: event.payload,
  };
  assert.throws(
    () => normalizeWorkflowEvent({
      ...baseEvent,
      source: { provider: "github", scopeId: "owner-command-center" },
    }),
    (error) => error.code === "INVALID_WORKFLOW_EVENT",
  );
  assert.throws(
    () => normalizeWorkflowEvent({
      ...baseEvent,
      payload: { ...baseEvent.payload, permissions: ["write"] },
    }),
    (error) => error.code === "INVALID_WORKFLOW_EVENT",
  );

  const routedDefinition = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [
      {
        id: "browser-configured-owner-hijack",
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "equals",
          path: "eventType",
          value: "owner_request.created",
        },
        targets: [{ type: "role", id: "developer" }],
        onMatch: "stop",
      },
    ],
  });
  assert.deepEqual(routedDefinition.rules.find(
    ({ id }) => id === "system-owner-request-to-orchestrator",
  ).targets, [
    { type: "role", id: "orchestrator" },
  ]);
  const protectedResult = routeWorkflowEvent({
    event,
    config: routedDefinition,
  });
  assert.deepEqual(
    protectedResult.assignments.map(({ target }) => target),
    [{ type: "role", id: "orchestrator" }],
  );
  assert.equal(
    protectedResult.explanation.rules.find(({ status }) => status === "matched")
      ?.ruleId,
    "system-owner-request-to-orchestrator",
  );

  for (const invalid of [
    request({ roleId: "developer" }),
    request({ requestId: "browser-chosen-internal-id" }),
    request({ workType: "../../internal/worker" }),
    request({ acceptanceCriteria: ["same", "same"] }),
  ]) {
    assert.throws(
      () => normalizeOwnerWorkRequest(invalid),
      (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
    );
  }

});

test("an explicit Issue request creates an event with canonical GitHub identity", () => {
  const normalized = normalizeOwnerWorkRequest(issue());
  const event = createOwnerIssueEvent(
    normalized,
    "2026-08-08T01:00:00.000Z",
  );

  assert.equal(event.eventType, "issue.owner_requested");
  assert.deepEqual(event.subject, {
    id: "github:issue:acme/repo#43",
    repository: "acme/repo",
    number: 43,
  });
  assert.equal(
    ownerWorkRequestEventMatches(normalized, event, "2026-08-08T01:00:00.000Z"),
    true,
  );
  const routing = routeWorkflowEvent({
    event,
    config: withOwnerWorkRequestDefaultRoute({
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [],
    }),
  });
  assert.deepEqual(routing.assignments.map(({ target }) => target), [
    { type: "role", id: "developer" },
  ]);
});

test("testing handoff preserves a structured GitHub responsible person", () => {
  const normalized = normalizeOwnerWorkRequest(request({
    schemaVersion: 3,
    workType: "testing",
    pullRequest: { repository: "acme/repo", number: 42 },
    responsiblePerson: { login: "bs-tester", product: "bs" },
  }));
  const event = createOwnerPullRequestEvent(
    normalized,
    {
      repository: "acme/repo",
      number: 42,
      title: "PR 42",
      state: "open",
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/testing-handoff",
        headRefOid: "a".repeat(40),
      },
    },
    "2026-08-08T01:00:00.000Z",
  );

  assert.deepEqual(normalized.responsiblePerson, {
    login: "bs-tester",
    product: "bs",
  });
  assert.deepEqual(event.payload.responsiblePerson, {
    login: "bs-tester",
    product: "bs",
  });
  assert.throws(
    () => normalizeOwnerWorkRequest(request({
      schemaVersion: 3,
      workType: "development",
      pullRequest: { repository: "acme/repo", number: 42 },
      responsiblePerson: { login: "bs-tester", product: "bs" },
    })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
});

test("automated PR triage creates deterministic orchestrator-bound work requests", () => {
  const review = createPrTriageWorkRequest({
    requestKey: "pr-work-review",
    targetRoleId: "pr-engineer",
    repository: "acme/repo",
    number: 42,
    nextAction: "review",
    expectedHeadRefOid: "a".repeat(40),
  });
  const replay = createPrTriageWorkRequest({
    requestKey: "pr-work-review",
    targetRoleId: "pr-engineer",
    repository: "acme/repo",
    number: 42,
    nextAction: "review",
    expectedHeadRefOid: "a".repeat(40),
  });
  const development = createPrTriageWorkRequest({
    requestKey: "pr-work-fix",
    targetRoleId: "developer",
    repository: "acme/repo",
    number: 42,
    nextAction: "fix_ci",
    expectedHeadRefOid: "a".repeat(40),
  });

  assert.deepEqual(replay, review);
  assert.match(review.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(
    review.requestId,
    deterministicRequestId("pr-triage-orchestrated:pr-work-review"),
  );
  assert.notEqual(
    review.requestId,
    deterministicRequestId("pr-triage:pr-work-review"),
  );
  assert.equal(
    review.predecessorRequestId,
    deterministicRequestId("pr-triage:pr-work-review"),
  );
  assert.equal(review.schemaVersion, 5);
  assert.equal(review.workType, "general");
  assert.equal(review.priority, "high");
  assert.match(review.description, /建议能力：pr-review/);
  assert.deepEqual(review.triage, {
    nextAction: "review",
    suggestedCapability: "pr-review",
    expectedHeadRefOid: "a".repeat(40),
  });
  assert.equal(development.schemaVersion, 5);
  assert.equal(development.workType, "general");
  assert.equal(development.priority, "urgent");
  assert.match(development.description, /建议能力：development/);

  for (const invalid of [
    { ...review, predecessorRequestId: review.requestId },
    {
      ...review,
      triage: { ...review.triage, suggestedCapability: "testing" },
    },
    {
      ...review,
      triage: {
        nextAction: review.triage.nextAction,
        suggestedCapability: review.triage.suggestedCapability,
      },
    },
    { ...review, triage: { ...review.triage, untrusted: true } },
  ]) {
    assert.throws(
      () => normalizeOwnerWorkRequest(invalid),
      (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
    );
  }

  const historicalUnstructuredV5 = Object.fromEntries(
    Object.entries(review).filter(
      ([key]) => !["predecessorRequestId", "triage"].includes(key),
    ),
  );
  assert.throws(
    () => normalizeOwnerWorkRequest(historicalUnstructuredV5),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
  assert.equal(
    normalizeStoredOwnerWorkRequest(historicalUnstructuredV5).schemaVersion,
    5,
  );
  const historicalAt = "2026-08-08T01:00:00.000Z";
  const structuredEvent = createOwnerPullRequestEvent(
    review,
    {
      repository: "acme/repo",
      number: 42,
      title: "PR 42",
      state: "open",
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/historical-v5",
        headRefOid: "a".repeat(40),
      },
    },
    historicalAt,
  );
  const historicalPayload = Object.fromEntries(
    Object.entries(structuredEvent.payload).filter(
      ([key]) => ![
        "nextAction",
        "suggestedCapability",
        "expectedHeadRefOid",
      ].includes(key),
    ),
  );
  const historicalEvent = normalizeWorkflowEvent({
    schemaVersion: structuredEvent.schemaVersion,
    eventType: structuredEvent.eventType,
    occurredAt: structuredEvent.occurredAt,
    source: structuredEvent.source,
    subject: structuredEvent.subject,
    payload: historicalPayload,
  });
  assert.equal(
    ownerWorkRequestEventMatches(
      historicalUnstructuredV5,
      historicalEvent,
      historicalAt,
    ),
    true,
  );

  assert.throws(
    () => createOwnerPullRequestEvent(
      review,
      {
        repository: "acme/repo",
        number: 42,
        title: "PR 42",
        state: "open",
        gitTarget: {
          schemaVersion: 1,
          provider: "github",
          sourceAccountId: "runtime-user",
          baseRepository: "acme/repo",
          baseRefName: "main",
          baseRefOid: "d".repeat(40),
          headRepository: "contributor/repo",
          headRefName: "fix/head-changed",
          headRefOid: "b".repeat(40),
        },
      },
      "2026-08-08T01:00:00.000Z",
    ),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
});

test("review and development handoffs accept a named responsible person", () => {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/named-handoff",
    headRefOid: "a".repeat(40),
  };
  for (const workType of ["pull_request", "development"]) {
    const normalized = normalizeOwnerWorkRequest(request({
      schemaVersion: 4,
      workType,
      pullRequest: { repository: "acme/repo", number: 42 },
      responsiblePerson: { login: "named-owner", product: "qt" },
    }));
    const event = createOwnerPullRequestEvent(
      normalized,
      {
        repository: "acme/repo",
        number: 42,
        title: "PR 42",
        state: "open",
        gitTarget,
      },
      "2026-08-08T01:00:00.000Z",
    );

    assert.deepEqual(normalized.responsiblePerson, {
      login: "named-owner",
      product: "qt",
    });
    assert.deepEqual(event.payload.responsiblePerson, {
      login: "named-owner",
      product: "qt",
    });
    const routed = routeWorkflowEvent({
      event,
      config: withOwnerWorkRequestDefaultRoute({
        schemaVersion: 1,
        enabled: true,
        maxHops: 8,
        rules: [],
      }),
    });
    assert.equal(
      routed.assignments[0].target.id,
      workType === "development" ? "developer" : "pr-engineer",
    );
  }
});

test("owner capability requests route directly to their fixed least-authority roles", () => {
  const definition = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [],
  });
  const expectations = new Map([
    ["development", "developer"],
    ["testing", "tester"],
    ["requirements", "requirements-analyst"],
    ["general", "orchestrator"],
  ]);

  for (const [workType, roleId] of expectations) {
    const event = createOwnerWorkRequestEvent(
      request({ workType }),
      "2026-08-08T01:00:00.000Z",
    );
    const routed = routeWorkflowEvent({ event, config: definition });

    assert.deepEqual(
      routed.assignments.map(({ target }) => target),
      [{ type: "role", id: roleId }],
    );
  }
});

test("an explicit PR request requires a structured target and creates a distinct owner authority event", () => {
  const normalized = normalizeOwnerWorkRequest(pullRequest());
  assert.deepEqual(normalized.pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.throws(
    () => normalizeOwnerWorkRequest(pullRequest({ pullRequest: undefined })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
  assert.equal(
    normalizeOwnerWorkRequest(request({ workType: "pull_request" }))
      .schemaVersion,
    1,
  );

  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/owner-request",
    headRefOid: "a".repeat(40),
  };
  const event = createOwnerPullRequestEvent(
    normalized,
    {
      repository: "acme/repo",
      number: 42,
      title: "PR 42",
      state: "open",
      gitTarget,
    },
    "2026-08-08T01:00:00.000Z",
  );
  assert.equal(event.eventType, "pull_request.owner_requested");
  assert.deepEqual(event.source, {
    provider: "local-owner",
    scopeId: `owner-request:${REQUEST_ID}`,
  });
  assert.deepEqual(event.subject, {
    id: "github:pr:acme/repo#42",
    repository: "acme/repo",
    number: 42,
  });
  assert.equal(event.payload.headRefOid, gitTarget.headRefOid);
  assert.equal(event.payload.state, "open");
  assert.deepEqual(event.payload.gitTarget, gitTarget);

  assert.throws(
    () => createOwnerPullRequestEvent(
      normalized,
      {
        repository: "acme/repo",
        number: 42,
        title: "PR 42",
        state: "closed",
        gitTarget,
      },
      "2026-08-08T01:00:00.000Z",
    ),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );

  const routed = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [],
  });
  assert.deepEqual(
    routeWorkflowEvent({ event, config: routed }).assignments.map(
      ({ target }) => target,
    ),
    [{ type: "role", id: "pr-engineer" }],
  );
});

test("default route creates exactly one durable orchestrator root and replay is idempotent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  const [first, replay] = await Promise.all([
    owner.submit(request()),
    owner.submit(request()),
  ]);
  assert.equal(first.deduplicated, false);
  assert.equal(replay.deduplicated, true);
  assert.equal(first.phase, "intaken");
  assert.equal(replay.workItemId, first.workItemId);
  assert.deepEqual(first.assignment.target, {
    type: "role",
    id: "orchestrator",
  });

  const assignments = await routing.listAssignments({ limit: 10 });
  const items = await ledger.listItems({ limit: 10 });
  const graph = await ledger.graphReader.getSnapshot();
  assert.equal(assignments.items.length, 1);
  assert.equal(items.items.length, 1);
  assert.equal(graph.graph.tasks.length, 1);
  assert.equal(graph.graph.tasks[0].taskId, first.workItemId);
  assert.deepEqual(graph.graph.tasks[0].responsibility, {
    type: "role",
    id: "orchestrator",
  });
  assert.deepEqual(graph.taskStates[0].work, {
    title: request().title,
    description: request().description,
  });

  await assert.rejects(
    owner.submit(request({ title: "Different work under the same request ID" })),
    (error) => error.code === "OWNER_WORK_REQUEST_IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("runtime persists a manual Issue with its canonical Issue event", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-issue-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  const result = await owner.submit(issue());
  const item = (await ledger.listItems({ limit: 10 })).items[0];

  assert.equal(result.request.schemaVersion, 6);
  assert.equal(item.event.eventType, "issue.owner_requested");
  assert.deepEqual(item.event.subject, {
    id: "github:issue:acme/repo#43",
    repository: "acme/repo",
    number: 43,
  });
  assert.deepEqual(result.assignment.target, { type: "role", id: "developer" });

  const legacy = await owner.submit(request({
    requestId: deterministicRequestId("legacy-issue-assignment"),
    description: "原始地址：https://github.com/acme/repo/issues/43\n当前摘要：Legacy assignment",
  }));
  await owner.submit(request({
    requestId: deterministicRequestId("different-source-assignment"),
    description: "原始地址：https://github.com/acme/repo/pull/43\n当前摘要：https://github.com/acme/repo/issues/43",
  }));
  await owner.submit(issue({
    requestId: deterministicRequestId("different-issue-assignment"),
    issue: { repository: "acme/repo", number: 430 },
  }));
  const sourceUrl = "https://github.com/ACME/REPO/issues/43";
  await ledger.transition({
    itemId: item.itemId, expectedRevision: item.revision, leaseId: null,
    actorId: "work-ledger-system", toStatus: "blocked", reason: "test_dependency_missing",
  });
  const firstPage = await owner.list({ sourceUrl, limit: 1 });
  assert.deepEqual(firstPage.items.map(({ requestId }) => requestId), [legacy.requestId]);
  assert.equal(firstPage.nextCursor, legacy.requestId);
  const secondPage = await owner.list({ sourceUrl, limit: 1, cursor: firstPage.nextCursor });
  assert.deepEqual(secondPage.items.map(({ requestId }) => requestId), [result.requestId]);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(secondPage.items[0].progress, {
    itemId: item.itemId, status: "blocked", statusReason: "test_dependency_missing",
    currentTarget: item.currentTarget, updatedAt: (await ledger.listItems()).items
      .find((entry) => entry.itemId === item.itemId).updatedAt,
  });
  assert.deepEqual((await owner.get(result.requestId)).progress, secondPage.items[0].progress);
  assert.equal(secondPage.items[0].phase, "intaken");
  for (const invalidUrl of ["https://evil.example/acme/repo/issues/43", "https://github.com/acme/repo/issues/0"]) {
    await assert.rejects(owner.list({ sourceUrl: invalidUrl }), { statusCode: 400 });
  }
});

test("owner request cancellation reaches the PR resolver and does not stage cancelled work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-pr-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const controller = new AbortController();
  let observedSignal;
  let calls = 0;
  const owner = await createOwnerWorkRequestRuntime({
    store, workflowRouting: routing, ledger, roleReadiness: roleReadiness(), clock,
    createGuard: guardFactory,
    pullRequestResolver: { async resolvePullRequestTarget(_target, options) {
      calls++;
      observedSignal = options?.signal;
      controller.abort(new Error("handoff stopped"));
      throw controller.signal.reason;
    } },
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));
  await assert.rejects(owner.submit(pullRequest(), { signal: controller.signal }), /handoff stopped/);
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual((await owner.list({})).items, []);
  await assert.rejects(owner.submit(pullRequest(), { signal: controller.signal }), /handoff stopped/);
  assert.equal(calls, 1);
});

for (const variant of ["closed", "unassigned", "assigned", "unavailable", "concurrent-pause", "incomplete-snapshot"]) {
  test(`fresh scope reconciliation retires a legacy exit without inventing authority (${variant})`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "legacy-review-exit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new StateStore(path.join(root, "state")), clock = clockFixture();
    let reader;
    const runtime = await createRoutingAndLedger(store, clock, { legacyExitRoute: true,
      scopeExitRecoveryReader: { read: options => reader.read(options) } });
    const routing = runtime.routing;
    let ledger = runtime.ledger;
    t.after(() => Promise.all([ledger.close(), routing.close()]));
    const event = { schemaVersion: 1, eventType: "pull_request.left_scope", occurredAt: "2026-08-01T01:00:00.000Z",
      source: { provider: "github", scopeId: "github-dashboard" },
      subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
      payload: { title: "Old exited PR", state: "open", relation: "review_requested", headRefOid: "a".repeat(40),
        gitTargetAvailable: true, gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "runtime-user",
          baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40),
          headRepository: "acme/repo", headRefName: "old-pr", headRefOid: "a".repeat(40) } } };
    await routing.ingest({ event: { ...event, eventType: "pull_request.created", occurredAt: "2026-08-01T00:00:00.000Z" } });
    await ledger.intake();
    await routing.ingest({ event });
    await ledger.intake();
    // Restore the schema-valid historical state left by the old cutover:
    // an ordinary exit pointer was activated without lifecycle authority.
    const legacy = await store.read("work-ledger-state");
    const envelope = (await routing.readAssignmentBatch({ afterSequence: 1, limit: 100 })).items[0];
    const historical = legacy.items.find(item => item.source?.kind === "pull_request");
    historical.source = normalizePullRequestWorkSource(createPullRequestWorkSource(envelope).source);
    historical.event = envelope.event;
    historical.inputDigest = historical.source.current.inputDigest;
    legacy.graphMemoryProjection = reconcileMigratedWorkGraphMemoryAuthority(
      emptyWorkGraphMemoryProjection(), legacy, normalizeWorkLedgerLimits());
    await ledger.close();
    await store.write("work-ledger-state", legacy);
    ledger = await createWorkLedgerRuntime({ store, assignmentSource: routing, clock,
      idFactory: () => "owner-work-lease", createGuard: guardFactory });
    const before = (await ledger.listItems()).items.find(item => item.source?.kind === "pull_request");
    assert.equal(before.status, "queued");
    assert.equal(before.source.current.event.eventType, "pull_request.left_scope");
    assert.equal(before.source.scope.active, true, "a raw exit event cannot mint lifecycle proof");
    const pause = async () => {
      const current = await ledger.readItemForReconciliation({ itemId: before.itemId });
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: before.itemId }).pauseTask({
        taskId: current.itemId, expectedTaskRevision: current.revision,
        expectedGraphRevision: (await ledger.getSummary()).revision, reason: "owner_paused" });
    };
    let reads = 0;
    reader = new AutomaticReviewScopeExitReader({ ledger, account: "runtime-user", clock, github: {
      async readIncomingReviewRequest() {
        reads++;
        if (variant === "unavailable") throw new Error("GitHub unavailable");
        if (variant === "concurrent-pause") await pause();
        return { kind: "pull_request", state: variant === "closed" ? "closed" : "open", isDraft: false,
          incomingReviewFactsAvailable: true, headRefOid: "b".repeat(40),
          reviewRecipient: variant === "assigned" ? "runtime-user" : null,
          reviewReceivedVia: variant === "assigned" ? "assignee" : null };
      },
    } });
    const snapshot = { refreshedAt: clock().toISOString(), items: [], sourceStatus: {
      githubPullRequests: { ok: true, stale: false, complete: variant !== "incomplete-snapshot" },
      githubIssues: { ok: true, stale: false } } };
    const recovered = await routing.ingestSnapshot({ snapshot });
    await ledger.intake();
    const after = await ledger.readItemForReconciliation({ itemId: before.itemId });
    const exited = ["closed", "unassigned"].includes(variant);
    assert.equal(after.source.scope.active, !exited);
    assert.equal(after.status, exited ? "blocked" : variant === "concurrent-pause" ? "paused" : "queued");
    assert.deepEqual(after.graph, before.graph);
    assert.equal(recovered.events.length, exited ? 1 : 0);
    if (exited) {
      assert.ok(after.source.bindings.some(item => item.scopeLifecycle === true));
      await assert.rejects(ledger.claim({ itemId: after.itemId, expectedRevision: after.revision,
        workerId: "employee-pr-engineer", leaseDurationMs: 30_000 }));
    }
    if (variant === "incomplete-snapshot") assert.equal(reads, 0);
    assert.equal((await routing.ingestSnapshot({ snapshot })).events.length, 0);
  });
}

for (const variant of [
  "changed-head", "same-target", "paused", "unavailable", "concurrent-pause", "unassigned",
  "assignment-unavailable", "concurrent-unassignment", "concurrent-owner-read", "concurrent-owner-submit",
  "preflight-pause", "preflight-unassignment", "assignment-pause", "queued-owner-unassignment",
  "queued-owner-stable", "queued-owner-failed-unassignment", "cancelled", "concurrent-sweep",
]) {
  test(`automatic owner PR refresh uses ordinary source intake after unstarted fact failures (${variant})`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "owner-pr-refresh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new StateStore(path.join(root, "state")), clock = clockFixture();
    const { routing, ledger } = await createRoutingAndLedger(store, clock);
    let head = "a".repeat(40), unavailable = false, assigned = true, assignmentUnavailable = false, duringResolve = async () => {};
    let duringPreflight = async () => {}, duringAssignment = async () => {};
    const readiness = roleReadiness();
    const ownerLedger = { ...ledger, async listItems(options) {
      // A large unrelated blocked history must not delay the owner's current PR.
      if (options?.status === "blocked") return { items: Array.from({ length: 10 }, (_, index) => ({ itemId: `historical-${index}` })),
        nextCursor: "historical-page" };
      return ledger.listItems(options);
    } };
    const options = { store, workflowRouting: routing, ledger: ownerLedger,
      roleReadiness: { async read(roleId) { await duringPreflight(); return readiness.read(roleId); } }, clock, createGuard: guardFactory,
      incomingReviewReader: { async read() {
        await duringAssignment();
        if (assignmentUnavailable) throw new Error("Assignment facts unavailable");
        return { kind: "pull_request", state: "open", isDraft: false, incomingReviewFactsAvailable: true,
          headRefOid: head, reviewRecipient: assigned ? "runtime-user" : null,
          reviewReceivedVia: assigned ? "assignee" : null, reviewRequestEventId: assigned ? "assignment-1" : null };
      } },
      pullRequestResolver: { async resolvePullRequestTarget(target) {
        if (target.number === 43 && variant === "queued-owner-failed-unassignment") {
          assigned = false;
          throw new Error("Queued PR resolution failed after the assignment was revoked");
        }
        if (unavailable) throw new Error("GitHub unavailable");
        await duringResolve();
        return { ...target, title: "PR 42", state: "open", gitTarget: { schemaVersion: 1, provider: "github",
          sourceAccountId: "runtime-user", baseRepository: target.repository, baseRefName: "main", baseRefOid: "d".repeat(40),
          headRepository: "contributor/repo", headRefName: "fix/owner-request", headRefOid: head } };
      } } };
    let owner = await createOwnerWorkRequestRuntime(options);
    t.after(async () => { await owner.close(); await ledger.close(); await routing.close(); });
    const original = await owner.submit(pullRequest());
    assigned = false;
    const originalItem = await ledger.readItemForReconciliation({ itemId: original.workItemId });
    await owner.verifyAutomaticReviewContinuation(currentWorkItemExecutionBinding(originalItem));
    assigned = true;
    let item;
    for (let attempt = 1; attempt <= 3; attempt++) {
      item = await ledger.readItemForReconciliation({ itemId: original.workItemId });
      item = await ledger.claim({ itemId: item.itemId, expectedRevision: item.revision,
        workerId: "employee-pr-engineer", leaseDurationMs: 30_000 });
      if (attempt < 3) await ledger.scheduleRetry({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
        actorId: "employee-pr-engineer", reason: "decision_failed", details: { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" },
        availableAt: new Date(clock().getTime() + 2_000).toISOString() });
      else await ledger.transition({ itemId: item.itemId, expectedRevision: item.revision, leaseId: item.leaseId,
        actorId: "employee-pr-engineer", toStatus: "blocked", reason: "decision_attempts_exhausted", details: { code: "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" } });
    }
    const pause = async () => {
      const current = await ledger.readItemForReconciliation({ itemId: item.itemId });
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: item.itemId }).pauseTask({
        taskId: current.itemId, expectedTaskRevision: current.revision,
        expectedGraphRevision: (await ledger.getSummary()).revision, reason: "owner_paused" });
    };
    if (variant !== "same-target") head = "b".repeat(40);
    if (variant === "paused") await pause();
    if (variant === "unavailable") unavailable = true;
    if (variant === "concurrent-pause") duringResolve = pause;
    if (variant === "unassigned") assigned = false;
    if (variant === "assignment-unavailable") assignmentUnavailable = true;
    if (variant === "concurrent-unassignment") duringResolve = async () => { assigned = false; };
    if (variant === "preflight-pause") duringPreflight = async () => { duringPreflight = async () => {}; await pause(); };
    if (variant === "preflight-unassignment") duringPreflight = async () => { assigned = false; };
    let queuedOwnerSubmission;
    const failedQueuedSubmission = variant === "queued-owner-failed-unassignment";
    if (["queued-owner-unassignment", "queued-owner-stable", "queued-owner-failed-unassignment"].includes(variant)) {
      let assignmentReads = 0;
      duringAssignment = async () => {
        if (++assignmentReads === 2) {
          const nextRequest = failedQueuedSubmission
            ? pullRequest({ requestId: "123e4567-e89b-42d3-a456-426614174001", pullRequest: { repository: "acme/repo", number: 43 } })
            : request({ requestId: "123e4567-e89b-42d3-a456-426614174001" });
          queuedOwnerSubmission = owner.submit(nextRequest).then(result => {
            if (variant === "queued-owner-unassignment") assigned = false;
            return result;
          }, error => {
            if (!failedQueuedSubmission) throw error;
            assert.equal(error.code, "OWNER_PULL_REQUEST_RESOLUTION_FAILED");
            return error;
          });
        }
      };
    }
    if (variant === "assignment-pause") {
      let assignmentReads = 0;
      duringAssignment = async () => { if (++assignmentReads === 2) await pause(); };
    }
    const controller = new AbortController(), abortReason = new Error("refresh cancelled during remote read");
    if (variant === "cancelled") duringResolve = async () => { controller.abort(abortReason); };
    let otherSweep;
    if (variant === "concurrent-sweep") duringResolve = async () => {
      duringResolve = async () => { assert.fail("concurrent sweeps must not duplicate the remote refresh"); };
      otherSweep = owner.refreshBlockedPullRequestSources();
    };
    let pendingOwnerOperation, ownerOperationCompletedDuringFetch;
    const concurrentOwner = ["concurrent-owner-read", "concurrent-owner-submit"].includes(variant);
    if (concurrentOwner) duringResolve = async () => {
      pendingOwnerOperation = variant === "concurrent-owner-read" ? owner.get(original.requestId)
        : owner.submit(request({ requestId: "123e4567-e89b-42d3-a456-426614174001" }));
      let timer;
      try {
        ownerOperationCompletedDuringFetch = await Promise.race([
          pendingOwnerOperation.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const shouldRefresh = variant === "changed-head" || concurrentOwner || variant === "concurrent-sweep" || variant === "queued-owner-stable";
    const beforeRefreshRevision = (await store.read(OWNER_WORK_REQUEST_STATE_KEY)).revision;
    const refresh = owner.refreshBlockedPullRequestSources({ signal: controller.signal });
    if (variant === "cancelled") await assert.rejects(refresh, error => error === abortReason);
    else {
      const result = await refresh;
      await queuedOwnerSubmission;
      if (failedQueuedSubmission) assert.equal((await store.read(OWNER_WORK_REQUEST_STATE_KEY)).revision, beforeRefreshRevision);
      assert.equal(result.refreshed, shouldRefresh ? 1 : 0);
    }
    if (otherSweep) assert.equal((await otherSweep).refreshed, 0);
    if (concurrentOwner) {
      await pendingOwnerOperation;
      assert.equal(ownerOperationCompletedDuringFetch, true,
        "a remote source fetch must not hold the shared owner request queue");
    }
    if (shouldRefresh) {
      const pending = (await ledger.listPendingPullRequestSources()).items.find(candidate => candidate.itemId === item.itemId);
      if (pending) await ledger.reconcilePullRequestSource({ itemId: pending.itemId, expectedRevision: pending.revision,
        expectedPendingRevision: pending.source.pendingRevision, expectedGraphRevision: (await ledger.getSummary()).revision });
    }
    const current = await ledger.readItemForReconciliation({ itemId: item.itemId });
    assert.equal(current.source.current.headRefOid, shouldRefresh ? head : "a".repeat(40));
    assert.equal((await owner.get(original.requestId)).eventId, original.eventId);
    if (variant === "concurrent-owner-submit") assert.equal((await owner.list()).items.length, 2);
    if (shouldRefresh) {
      const binding = currentWorkItemExecutionBinding(current);
      await owner.verifyAutomaticReviewContinuation(binding);
      assigned = false;
      await assert.rejects(owner.verifyAutomaticReviewContinuation(binding), { code: "OWNER_REVIEW_ASSIGNMENT_REVOKED" });
      assignmentUnavailable = true;
      await assert.rejects(owner.verifyAutomaticReviewContinuation(binding), { code: "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE" });
    }
    await owner.close(); owner = await createOwnerWorkRequestRuntime(options);
    // Cancellation stops that sweep; a later live cycle can still refresh the request.
    if (variant === "cancelled") duringResolve = async () => {};
    assert.equal((await owner.refreshBlockedPullRequestSources()).refreshed, variant === "cancelled" ? 1 : 0);
    assert.equal((await ledger.listOutbox()).items.length, 0);
  });
}

for (const variant of ["base-changed", "head-changed", "queued-child", "working-child", "automatic-wait-base", "automatic-wait-head", "automatic-wait-same-target", "same-target", "paused", "concurrent-pause", "unavailable", "branch-changed", "account-changed"]) {
  test(`admitted orchestrated repair refreshes its existing source through ordinary intake (${variant})`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "owner-repair-refresh-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new StateStore(path.join(directory, "state")), clock = clockFixture();
    const { routing, ledger } = await createRoutingAndLedger(store, clock);
    let target = { schemaVersion: 1, provider: "github", sourceAccountId: "runtime-user",
      baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40),
      headRepository: "contributor/repo", headRefName: "fix/owner-request", headRefOid: "a".repeat(40) };
    let unavailable = false, duringResolve = async () => {};
    const owner = await createOwnerWorkRequestRuntime({ store, workflowRouting: routing, ledger,
      roleReadiness: roleReadiness(), capabilityReadiness: capabilityReadiness(), clock, createGuard: guardFactory,
      // Existing repair authorization does not depend on a personal Review assignment.
      pullRequestResolver: { async resolvePullRequestTarget(input) {
        if (unavailable) throw new Error("GitHub unavailable");
        await duringResolve();
        return { ...input, title: "PR 42", state: "open", gitTarget: target };
      } },
    });
    t.after(async () => { await owner.close(); await ledger.close(); await routing.close(); });
    const request = createPrTriageWorkRequest({ requestKey: "existing-ci-repair", repository: "acme/repo",
      number: 42, targetRoleId: "developer", nextAction: "fix_ci", expectedHeadRefOid: target.headRefOid });
    const submitted = await owner.submit(request);
    const before = await ledger.readItemForReconciliation({ itemId: submitted.workItemId });
    let child;
    const automaticWait = variant.startsWith("automatic-wait");
    if (["queued-child", "working-child"].includes(variant) || automaticWait) {
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: before.itemId }).createChild({
        parentTaskId: before.itemId, childKey: "continue-ci-repair", leaseId: null,
        work: { title: "Continue the existing repair", description: "Use the bound PR snapshot" },
        target: { type: "role", id: "developer" }, dependsOnTaskIds: [],
        acceptanceContract: { revision: 1, acceptanceCriteria: [], expectedDeliverables: [{
          deliverableId: "repair", kind: "change-package", description: "Validated repair", required: true }] },
        expectedGraphRevision: (await ledger.graphReader.getSnapshot()).graph.revision,
        expectedTaskRevisions: [{ taskId: before.itemId, revision: before.revision }],
      });
      child = (await ledger.listItems()).items.find(item => item.kind === "graph_task");
      if (variant === "working-child") child = await ledger.claim({ itemId: child.itemId,
        expectedRevision: child.revision, workerId: "employee-developer", leaseDurationMs: 30_000 });
    }
    if (automaticWait) {
      const parent = await ledger.readItemForReconciliation({ itemId: before.itemId });
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: before.itemId }).pauseTask({
        taskId: before.itemId, expectedTaskRevision: parent.revision,
        expectedGraphRevision: (await ledger.getSummary()).revision,
        reason: "Wait for the admitted repair child", waitForChildren: true,
      });
    }
    const pause = async () => {
      const item = await ledger.readItemForReconciliation({ itemId: before.itemId });
      await ledger.scopedGraphPlannerFactory.forRoot({ scopeRootTaskId: item.itemId }).pauseTask({
        taskId: item.itemId, expectedTaskRevision: item.revision,
        expectedGraphRevision: (await ledger.getSummary()).revision, reason: "owner_paused" });
    };
    if (!["same-target", "automatic-wait-same-target"].includes(variant)) target = { ...target, baseRefOid: "e".repeat(40) };
    if (["head-changed", "automatic-wait-head"].includes(variant)) target.headRefOid = "b".repeat(40);
    if (variant === "branch-changed") target.headRefName = "different-branch";
    if (variant === "account-changed") target.sourceAccountId = "different-user";
    if (variant === "paused") await pause();
    if (variant === "concurrent-pause") duringResolve = pause;
    if (variant === "unavailable") unavailable = true;
    const shouldRefresh = ["base-changed", "head-changed", "queued-child", "working-child", "automatic-wait-base", "automatic-wait-head"].includes(variant);
    assert.equal((await owner.refreshBlockedPullRequestSources()).refreshed, shouldRefresh ? 1 : 0);
    const pending = (await ledger.listPendingPullRequestSources()).items.find(item => item.itemId === before.itemId);
    if (pending) await ledger.reconcilePullRequestSource({ itemId: pending.itemId,
      expectedRevision: pending.revision, expectedPendingRevision: pending.source.pendingRevision,
      expectedGraphRevision: (await ledger.getSummary()).revision });
    const after = await ledger.readItemForReconciliation({ itemId: before.itemId });
    assert.equal(after.itemId, before.itemId);
    if (automaticWait) assert.equal(after.status, shouldRefresh ? "queued" : "paused",
      "only a changed trusted Git target renews an automatic child wait");
    if (child) {
      const retained = await ledger.readItemForReconciliation({ itemId: child.itemId });
      assert.equal(retained.assignment.graphTask.sourceBinding.headRefOid, before.source.current.headRefOid);
      assert.deepEqual(retained.graph.acceptanceContracts, child.graph.acceptanceContracts);
    }
    assert.equal(after.source.current.event.payload.gitTarget.baseRefOid,
      shouldRefresh ? target.baseRefOid : before.source.current.event.payload.gitTarget.baseRefOid);
    assert.equal(after.source.current.headRefOid, shouldRefresh ? target.headRefOid : before.source.current.headRefOid);
    assert.deepEqual((await owner.get(submitted.requestId)).request, submitted.request,
      "the original owner request remains immutable");
    assert.equal((await owner.get(submitted.requestId)).eventId, submitted.eventId);
    assert.equal((await ledger.listItems()).items.filter(item => item.kind === "source_root").length, 1);
    if (shouldRefresh) {
      assert.equal(after.source.current.event.payload.expectedHeadRefOid, target.headRefOid);
      assert.equal((await owner.refreshBlockedPullRequestSources()).refreshed, 0);
    }
  });
}

test("an explicit PR request resolves one immutable target before staging a PR engineer root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-pr-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let resolveCalls = 0;
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    pullRequestResolver: {
      async resolvePullRequestTarget(target) {
        resolveCalls += 1;
        return {
          ...target,
          title: "PR 42",
          state: "open",
          gitTarget: {
            schemaVersion: 1,
            provider: "github",
            sourceAccountId: "runtime-user",
            baseRepository: target.repository,
            baseRefName: "main",
            baseRefOid: "d".repeat(40),
            headRepository: "contributor/repo",
            headRefName: "fix/owner-request",
            headRefOid: "a".repeat(40),
          },
        };
      },
    },
    capabilityReadiness: {
      async read(capability) {
        return {
          capability,
          roleId: capability === "development" ? "developer" : "pr-engineer",
          enabled: true,
          paused: false,
        };
      },
    },
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  await assert.rejects(
    owner.submit(request({ workType: "pull_request" })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
  assert.equal(resolveCalls, 0);
  const first = await owner.submit(pullRequest());
  const replay = await owner.submit(pullRequest());
  assert.equal(resolveCalls, 1);
  assert.equal(first.phase, "intaken");
  assert.deepEqual(first.assignment.target, {
    type: "role",
    id: "pr-engineer",
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.workItemId, first.workItemId);
  const item = (await ledger.listItems({ limit: 10 })).items[0];
  assert.equal(item.source.scope.kind, "owner_requested");
  assert.equal(item.source.current.event.payload.headRefOid, "a".repeat(40));
  assert.equal(item.source.current.event.payload.state, "open");

  const namedDevelopment = await owner.submit(pullRequest({
    schemaVersion: 4,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workType: "development",
    responsiblePerson: { login: "runtime-user", product: "qt" },
  }));
  assert.equal(resolveCalls, 2);
  assert.deepEqual(namedDevelopment.assignment.target, {
    type: "role",
    id: "developer",
  });
  assert.deepEqual(namedDevelopment.request.pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.deepEqual(namedDevelopment.request.responsiblePerson, {
    login: "runtime-user",
    product: "qt",
  });

  for (const [workType, roleId, requestId] of [
    ["development", "developer", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["testing", "tester", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
  ]) {
    const manualRequest = ownerWorkRequestForItem({
      kind: "pull_request",
      repo: "acme/repo",
      number: 42,
      title: "PR 42",
    }, { workType, priority: "high", requestId });
    const submitted = await owner.submit(manualRequest);
    assert.deepEqual(submitted.assignment.target, { type: "role", id: roleId });
    const manualItem = (await ledger.listItems({ limit: 10 })).items.find(
      ({ itemId }) => itemId === submitted.workItemId,
    );
    assert.equal(manualItem.source.current.event.subject.repository, "acme/repo");
    assert.deepEqual(
      currentWorkItemExecutionBinding(manualItem).gitTarget,
      manualItem.source.current.event.payload.gitTarget,
    );
  }

  const automatedDevelopment = await owner.submit(createPrTriageWorkRequest({
    requestKey: "pr-work-fix-ci",
    targetRoleId: "developer",
    repository: "acme/repo",
    number: 42,
    nextAction: "fix_ci",
    expectedHeadRefOid: "a".repeat(40),
  }));
  assert.deepEqual(automatedDevelopment.assignment.target, {
    type: "role",
    id: "orchestrator",
  });
  assert.equal(automatedDevelopment.request.schemaVersion, 5);
  assert.equal(automatedDevelopment.request.workType, "general");
  assert.equal(automatedDevelopment.request.responsiblePerson, undefined);
  const orchestratedItem = (await ledger.listItems({ limit: 10 })).items.find(
    ({ itemId }) => itemId === automatedDevelopment.workItemId,
  );
  assert.deepEqual(orchestratedItem.currentTarget, {
    type: "role",
    id: "orchestrator",
  });
  assert.equal(
    orchestratedItem.source.current.event.payload.workType,
    "general",
  );
  assert.equal(
    orchestratedItem.source.current.event.payload.gitTarget.headRefOid,
    "a".repeat(40),
  );
  assert.equal(
    orchestratedItem.source.current.event.payload.suggestedCapability,
    "development",
  );
  assert.equal(
    orchestratedItem.source.current.event.payload.expectedHeadRefOid,
    "a".repeat(40),
  );

  const contextAssembler = new RoleContextAssembler({
    graphReader: ledger.graphReader,
  });
  const contextPacket = await contextAssembler.assemble({
    roleId: "orchestrator",
    item: orchestratedItem,
    trigger: "scheduled",
  });
  const orchestrator = new OrchestratorService({
    contextAssembler,
    graphReader: ledger.graphReader,
    scopedGraphPlannerFactory: ledger.scopedGraphPlannerFactory,
    graphDelivererFactory: ledger.graphDelivererFactory,
    capabilityRoles: { development: "developer" },
    clock,
  });
  const reason = "主控核对初判后分派开发修复";
  const result = await orchestrator.execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: orchestratedItem,
    contextPacket,
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "为 PR 创建开发子任务",
      reason,
      action: {
        schemaVersion: 1,
        type: "decompose",
        sourceTaskId: contextPacket.context.requirements.currentTask.taskId,
        sourceTaskRevision:
          contextPacket.context.requirements.currentTask.revision,
        expectedGraphRevision: contextPacket.context.requirements.graph.revision,
        reason,
        childKey: "fix-ci",
        work: {
          title: "修复 acme/repo #42 的 CI",
          description: "基于绑定 Head 完成修复、验证并提交可追踪交付。",
        },
        capability: "development",
        dependsOn: [],
        acceptanceContract: {
          revision: 1,
          acceptanceCriteria: [
            { criterionId: "head-checked", description: "核对绑定 Head" },
            { criterionId: "tests-pass", description: "相关测试通过" },
          ],
          expectedDeliverables: [{
            deliverableId: "implementation",
            kind: "change-package",
            description: "受控代码变更包",
            required: true,
          }],
        },
      },
    },
  });
  assert.equal(result.action, "decompose");
  assert.equal(result.rootTaskId, orchestratedItem.itemId);
  const orchestratedGraph = await ledger.graphReader.getSnapshot();
  const child = orchestratedGraph.graph.tasks.find(
    ({ parentTaskId }) => parentTaskId === orchestratedItem.itemId,
  );
  assert.deepEqual(child.responsibility, { type: "role", id: "developer" });
  assert.equal(
    child.acceptanceContracts[0].expectedDeliverables[0].kind,
    "change-package",
  );
  const childItem = (await ledger.listItems({ limit: 20 })).items.find(
    ({ itemId }) => itemId === child.taskId,
  );
  const childExecutionBinding = currentWorkItemExecutionBinding(childItem);
  assert.equal(childExecutionBinding.rootItemId, orchestratedItem.itemId);
  assert.equal(childExecutionBinding.headRefOid, "a".repeat(40));
  assert.deepEqual(
    await ledger.verifyPullRequestExecutionBinding(childExecutionBinding),
    childExecutionBinding,
  );
});

test("restart resumes a staged request after a lost routing response without duplication", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let loseResponse = true;
  const uncertainRouting = {
    dryRun: routing.dryRun,
    async ingest(input) {
      const result = await routing.ingest(input);
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("simulated lost response"), {
          code: "SIMULATED_LOST_RESPONSE",
        });
      }
      return result;
    },
  };
  const firstRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: uncertainRouting,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await assert.rejects(
    firstRuntime.submit(request()),
    (error) => error.code === "SIMULATED_LOST_RESPONSE",
  );
  await firstRuntime.close();
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 0);

  const recoveredRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() =>
    Promise.all([recoveredRuntime.close(), ledger.close(), routing.close()])
  );
  const recovered = await recoveredRuntime.get(REQUEST_ID);
  assert.equal(recovered.phase, "intaken");
  assert.equal(recovered.audit.length, 3);
  assert.deepEqual(
    recovered.audit.map(({ type }) => type),
    ["request_staged", "request_routed", "request_intaken"],
  );
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("new v5 triage rejects a missing trusted capability mapping before persistence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-pr-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let resolveCalls = 0;
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    capabilityReadiness: capabilityReadiness({
      roleId: null,
      enabled: false,
      paused: true,
    }),
    pullRequestResolver: {
      async resolvePullRequestTarget() {
        resolveCalls += 1;
        throw new Error("must not resolve before capability preflight");
      },
    },
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  await assert.rejects(
    owner.submit(createPrTriageWorkRequest({
      requestKey: "pr-work-missing-capability",
      targetRoleId: "pr-engineer",
      repository: "acme/repo",
      number: 42,
      nextAction: "review",
      expectedHeadRefOid: "a".repeat(40),
    })),
    (error) =>
      error.code === "OWNER_WORK_REQUEST_CAPABILITY_NOT_READY" &&
      /pr-review/.test(error.message),
  );
  assert.equal(resolveCalls, 0);
  assert.equal((await owner.list({ limit: 10 })).items.length, 0);
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 0);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 0);
});

test("v5 retry reuses a staged legacy deterministic PR handoff without a second root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-pr-upgrade-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let loseFirstResponse = true;
  const uncertainRouting = {
    dryRun: routing.dryRun,
    async ingest(input) {
      const result = await routing.ingest(input);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw Object.assign(new Error("simulated pre-upgrade crash"), {
          code: "SIMULATED_PRE_UPGRADE_CRASH",
        });
      }
      return result;
    },
  };
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: uncertainRouting,
    ledger,
    roleReadiness: roleReadiness(),
    pullRequestResolver: {
      async resolvePullRequestTarget(target) {
        return {
          ...target,
          title: "PR 42",
          state: "open",
          gitTarget: {
            schemaVersion: 1,
            provider: "github",
            sourceAccountId: "runtime-user",
            baseRepository: target.repository,
            baseRefName: "main",
            baseRefOid: "d".repeat(40),
            headRepository: "contributor/repo",
            headRefName: "fix/upgrade-replay",
            headRefOid: "a".repeat(40),
          },
        };
      },
    },
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));
  const requestKey = "pr-work-upgrade-replay";
  const legacyRequestId = deterministicRequestId(`pr-triage:${requestKey}`);
  const legacy = pullRequest({
    requestId: legacyRequestId,
    workType: "development",
    title: "Legacy PR triage",
    description: "Legacy deterministic development handoff.",
  });

  await assert.rejects(
    owner.submit(legacy),
    (error) => error.code === "SIMULATED_PRE_UPGRADE_CRASH",
  );
  const replay = await owner.submit(createPrTriageWorkRequest({
    requestKey,
    targetRoleId: "developer",
    repository: "acme/repo",
    number: 42,
    nextAction: "fix_ci",
    expectedHeadRefOid: "a".repeat(40),
  }));

  assert.equal(replay.deduplicated, true);
  assert.equal(replay.requestId, legacyRequestId);
  assert.equal(replay.request.schemaVersion, 2);
  assert.deepEqual(replay.assignment.target, { type: "role", id: "developer" });
  assert.equal((await owner.list({ limit: 10 })).items.length, 1);
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("restart reconciles a lost ledger intake response to the existing work item", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-ledger-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let loseResponse = true;
  const uncertainLedger = {
    async intake(input) {
      const result = await ledger.intake(input);
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("simulated lost ledger response"), {
          code: "SIMULATED_LEDGER_RESPONSE_LOST",
        });
      }
      return result;
    },
    listItems: ledger.listItems,
  };
  const firstRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger: uncertainLedger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await assert.rejects(
    firstRuntime.submit(request()),
    (error) => error.code === "SIMULATED_LEDGER_RESPONSE_LOST",
  );
  await firstRuntime.close();
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);

  const recoveredRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() =>
    Promise.all([recoveredRuntime.close(), ledger.close(), routing.close()])
  );
  const recovered = await recoveredRuntime.get(REQUEST_ID);
  assert.equal(recovered.phase, "intaken");
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("a rejected intake preserves the routed request and retry resumes it exactly once", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-intake-rejected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let blocked = true;
  let intakeCalls = 0;
  const owner = await createOwnerWorkRequestRuntime({
    store, workflowRouting: routing, roleReadiness: roleReadiness(),
    clock, createGuard: guardFactory,
    ledger: {
      async intake(input) {
        intakeCalls += 1;
        return blocked ? {
          received: 0, cursor: 0, highWatermark: 1,
          error: { code: "WORK_LEDGER_GRAPH_TRANSITION_INVALID" },
        } : ledger.intake(input);
      },
      listItems: ledger.listItems,
    },
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  await assert.rejects(owner.submit(request()),
    (error) => error.code === "OWNER_WORK_REQUEST_LEDGER_REJECTED" && error.statusCode === 503);
  assert.equal(intakeCalls, 1);
  assert.equal((await owner.get(REQUEST_ID)).phase, "routed");
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 0);

  blocked = false;
  const resumed = await owner.submit(request());
  assert.equal(resumed.phase, "intaken");
  assert.equal((await owner.list({ limit: 10 })).items.length, 1);
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("routing and role readiness fail before staging owner-controlled work", async (t) => {
  for (const fixture of [
    { enabled: false, readiness: roleReadiness(), code: "OWNER_WORK_REQUEST_ROUTING_NOT_READY" },
    { enabled: true, readiness: roleReadiness({ paused: true }), code: "OWNER_WORK_REQUEST_ROLE_NOT_READY" },
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), "owner-work-not-ready-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new StateStore(path.join(root, "state"));
    const clock = clockFixture();
    const { routing, ledger } = await createRoutingAndLedger(store, clock, {
      enabled: fixture.enabled,
    });
    const owner = await createOwnerWorkRequestRuntime({
      store,
      workflowRouting: routing,
      ledger,
      roleReadiness: fixture.readiness,
      clock,
      createGuard: guardFactory,
    });
    await assert.rejects(
      owner.submit(request()),
      (error) => error.code === fixture.code && error.statusCode === 503,
    );
    assert.equal(await store.read(OWNER_WORK_REQUEST_STATE_KEY, null), null);
    assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 0);
    await Promise.all([owner.close(), ledger.close(), routing.close()]);
  }
});

test("owner request recovery rejects a modified durable audit chain", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-corruption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await owner.submit(request());
  await owner.close();
  const state = await store.read(OWNER_WORK_REQUEST_STATE_KEY);
  state.records[0].audit[0].details.eventId = `workflow-event-${"f".repeat(64)}`;
  await store.write(OWNER_WORK_REQUEST_STATE_KEY, state);
  assert.throws(
    () => normalizeOwnerWorkRequestState(state),
    (error) => error.code === "OWNER_WORK_REQUEST_STATE_CORRUPTED",
  );
  await assert.rejects(
    createOwnerWorkRequestRuntime({
      store,
      workflowRouting: routing,
      ledger,
      roleReadiness: roleReadiness(),
      clock,
      createGuard: guardFactory,
    }),
    (error) => error.code === "OWNER_WORK_REQUEST_STATE_CORRUPTED",
  );
  await Promise.all([ledger.close(), routing.close()]);
});
