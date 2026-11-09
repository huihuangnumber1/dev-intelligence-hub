import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonDigest } from "../src/lib/canonical-json-digest.js";

import {
  RoleContextAssembler,
  RoleContextAssemblerError,
} from "../src/services/role-context-assembler.js";
import { deliveryAcceptanceContractDigest } from "../src/domain/delivery-evidence-contract.js";
import { createWorkGraphSnapshot } from "../src/domain/work-graph-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerWorkRequestEvent, createOwnerIssueEvent } from "../src/domain/owner-work-request.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  appendPullRequestWorkSource,
  createPullRequestWorkSource,
  currentWorkItemInputBinding,
} from "../src/services/work-ledger-pr-source.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function contract(revision, deliverables) {
  return {
    revision,
    acceptanceCriteria: [
      { criterionId: `criterion-${revision}`, description: `criterion ${revision}` },
    ],
    expectedDeliverables: deliverables,
  };
}

function expected(deliverableId, kind, required = true) {
  return {
    deliverableId,
    kind,
    description: `${deliverableId} description`,
    required,
  };
}

function evidence(kind, referenceId, contentDigest) {
  return { kind, referenceId, contentDigest };
}

function delivery({
  deliverableId,
  revision,
  contractRevision,
  status,
  summary,
  records = [evidence("artifact", `artifact:${revision}`, DIGEST_A)],
}) {
  return {
    deliverableId,
    revision,
    contractRevision,
    status,
    summary,
    evidence: records,
  };
}

function task({
  taskId,
  revision,
  status,
  roleId,
  parentTaskId = null,
  dependsOn = [],
  contracts = [contract(1, [])],
  deliveries = [],
}) {
  return {
    taskId,
    revision,
    parentTaskId,
    status,
    responsibility: { type: "role", id: roleId },
    acceptanceContracts: contracts,
    deliveries,
    dependsOn,
  };
}

function state(taskId, taskRevision, title = taskId) {
  return {
    taskId,
    taskRevision,
    ledgerStatus: "queued",
    ownerId: "must-not-leak-owner",
    leaseUntil: "2026-08-03T06:00:00.000Z",
    availableAt: null,
    statusReason: null,
    updatedAt: "2026-08-03T05:00:00.000Z",
    work: { title, description: `${title} description` },
  };
}

function acceptedPair({
  deliverableId,
  contractRevision,
  submittedRevision,
  submittedSummary,
  acceptanceReason,
  records,
}) {
  return [
    delivery({
      deliverableId,
      revision: submittedRevision,
      contractRevision,
      status: "submitted",
      summary: submittedSummary,
      records,
    }),
    delivery({
      deliverableId,
      revision: submittedRevision + 1,
      contractRevision,
      status: "accepted",
      summary: acceptanceReason,
      records,
    }),
  ];
}

function graphFixture({ pullRequest = false } = {}) {
  const requirementEvidence = [
    evidence("decision-record", "decision:req:2", DIGEST_B),
    evidence("requirement-spec", "requirement-spec:req:2", DIGEST_A),
  ];
  const codeEvidence = [
    evidence("test-report", "test:implementation", DIGEST_D),
    evidence("change-package", "change-package:implementation", DIGEST_C),
  ];
  const oldRequirements = acceptedPair({
    deliverableId: "requirement-spec",
    contractRevision: 1,
    submittedRevision: 1,
    submittedSummary: "SECRET-OLD-CONTRACT",
    acceptanceReason: "old accepted",
    records: requirementEvidence,
  });
  const currentRequirements = acceptedPair({
    deliverableId: "requirement-spec",
    contractRevision: 2,
    submittedRevision: 3,
    submittedSummary: "accepted requirement specification v2",
    acceptanceReason: "requirements accepted for development",
    records: [...requirementEvidence].reverse(),
  });
  const implementation = acceptedPair({
    deliverableId: "implementation",
    contractRevision: 1,
    submittedRevision: 1,
    submittedSummary: "accepted implementation package",
    acceptanceReason: "implementation accepted",
    records: [...codeEvidence].reverse(),
  });
  const optionalRejected = [
    delivery({
      deliverableId: "optional-test",
      revision: 3,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-REJECTED-SUBMISSION",
      records: [evidence("test-report", "test:optional", DIGEST_B)],
    }),
    delivery({
      deliverableId: "optional-test",
      revision: 4,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-REJECTION",
      records: [evidence("test-report", "test:optional", DIGEST_B)],
    }),
    delivery({
      deliverableId: "pending-review",
      revision: 5,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-PENDING-SUBMISSION",
      records: [evidence("review-report", "review:pending", DIGEST_A)],
    }),
  ];
  const ancestorDeliveries = acceptedPair({
    deliverableId: "requirement-spec",
    contractRevision: 1,
    submittedRevision: 1,
    submittedSummary: "SECRET-TRANSITIVE-ANCESTOR",
    acceptanceReason: "ancestor accepted",
    records: requirementEvidence,
  });
  const siblingDeliveries = acceptedPair({
    deliverableId: "review",
    contractRevision: 1,
    submittedRevision: 1,
    submittedSummary: "SECRET-SIBLING",
    acceptanceReason: "sibling accepted",
    records: codeEvidence,
  });
  const tasks = [
    task({
      taskId: "task-current",
      revision: 8,
      status: "in_progress",
      roleId: "developer",
      parentTaskId: "task-root",
      dependsOn: ["task-requirements", "task-implementation"],
      contracts: [contract(1, [expected("implementation", "change-package")])],
    }),
    task({
      taskId: "task-requirements",
      revision: 7,
      status: "completed",
      roleId: "requirements-analyst",
      parentTaskId: "task-root",
      dependsOn: ["task-ancestor"],
      contracts: [
        contract(1, [expected("requirement-spec", "requirement-spec")]),
        contract(2, [expected("requirement-spec", "requirement-spec")]),
      ],
      deliveries: [...oldRequirements, ...currentRequirements],
    }),
    task({
      taskId: "task-implementation",
      revision: 6,
      status: "completed",
      roleId: "developer",
      parentTaskId: "task-root",
      contracts: [
        contract(1, [
          expected("implementation", "change-package"),
          expected("optional-test", "test-report", false),
          expected("pending-review", "review-report", false),
        ]),
      ],
      deliveries: [...implementation, ...optionalRejected],
    }),
    task({
      taskId: "task-ancestor",
      revision: 4,
      status: "completed",
      roleId: "requirements-analyst",
      parentTaskId: "task-root",
      contracts: [contract(1, [expected("requirement-spec", "requirement-spec")])],
      deliveries: ancestorDeliveries,
    }),
    task({
      taskId: "task-sibling",
      revision: 3,
      status: "completed",
      roleId: "pr-engineer",
      parentTaskId: "task-root",
      contracts: [contract(1, [expected("review", "github-review")])],
      deliveries: siblingDeliveries,
    }),
    task({
      taskId: "task-root",
      revision: 2,
      status: "in_progress",
      roleId: "orchestrator",
    }),
    task({
      taskId: "task-other-root",
      revision: 2,
      status: "completed",
      roleId: "pr-engineer",
      contracts: [contract(1, [expected("review", "github-review")])],
      deliveries: acceptedPair({
        deliverableId: "review",
        contractRevision: 1,
        submittedRevision: 1,
        submittedSummary: "SECRET-OTHER-ROOT",
        acceptanceReason: "other root accepted",
        records: codeEvidence,
      }),
    }),
  ];
  const event = pullRequest
    ? {
        eventId: "event-pr-1",
        eventType: "pull_request.updated",
        subject: { id: "octo/repo#12", repository: "octo/repo", number: 12 },
        payload: { title: "PR title", headRefOid: "abc123", secretMarker: "PR-CONTEXT" },
      }
    : {
        eventId: "event-issue-1",
        eventType: "issue.updated",
        subject: { id: "issue-12" },
        payload: {
          title: "Issue title",
          evidenceDigest: DIGEST_A,
          secretMarker: "NOT-IN-MINIMAL-SOURCE",
        },
      };
  return {
    item: {
      itemId: "task-current",
      revision: 8,
      inputDigest: DIGEST_D,
      assignmentId: "assignment-current",
      currentTarget: { type: "role", id: "developer" },
      decisionContext: { answer: "keep the accepted scope" },
      event,
      ownerId: "must-not-leak-owner",
      workerId: "must-not-leak-worker",
      leaseId: "must-not-leak-lease",
      leaseUntil: "2026-08-03T06:00:00.000Z",
    },
    snapshot: {
      schemaVersion: 1,
      graph: structuredClone(
        createWorkGraphSnapshot({
          graphId: "work-ledger",
          revision: 20,
          tasks,
        }),
      ),
      taskStates: tasks.map((entry) => state(entry.taskId, entry.revision)),
    },
  };
}

function reader(snapshot, calls = []) {
  return {
    async getSnapshot() {
      calls.push("getSnapshot");
      const value = structuredClone(snapshot);
      value.graph = createWorkGraphSnapshot({
        graphId: value.graph.graphId,
        revision: value.graph.revision,
        tasks: value.graph.tasks,
      });
      return value;
    },
    async createChild() {
      throw new Error("planner must not be reachable");
    },
  };
}

function factSource(observations, calls = []) {
  return {
    async read({ item, fact }) {
      calls.push({ fact, item: structuredClone(item) });
      return observations[fact] ?? {
        healthy: true,
        fresh: true,
        value: null,
        observedAt: "2026-08-03T05:00:00.000Z",
      };
    },
  };
}

async function assemble(fixture, options = {}) {
  const assembler = new RoleContextAssembler({
    graphReader: reader(fixture.snapshot),
    ...(options.factSource ? { factSource: options.factSource } : {}),
    ...(options.pullRequestContextReader
      ? { pullRequestContextReader: options.pullRequestContextReader }
      : {}),
    ...(options.memoryQueryReader
      ? { memoryQueryReader: options.memoryQueryReader }
      : {}),
    ...(options.evidenceCatalog
      ? { evidenceCatalog: options.evidenceCatalog }
      : {}),
    ...(options.failedCodeJobContextReader
      ? { failedCodeJobContextReader: options.failedCodeJobContextReader }
      : {}),
    ...(options.internalReviewHandoffReader ? { internalReviewHandoffReader: options.internalReviewHandoffReader } : {}),
    ...(options.conflictInspectionReader ? { conflictInspectionReader: options.conflictInspectionReader } : {}),
    ...(options.ciDiagnosticReader ? { ciDiagnosticReader: options.ciDiagnosticReader } : {}),
    ...(options.publicationReuseReader ? { publicationReuseReader: options.publicationReuseReader } : {}),
  });
  const roleId = options.roleId ?? "developer";
  return assembler.assemble({
    roleId,
    item: fixture.item,
    trigger: options.trigger ?? `employee:${roleId}`,
  });
}

function rootOrchestratorFixture() {
  const fixture = graphFixture();
  const root = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-root",
  );
  fixture.item = {
    ...fixture.item,
    itemId: root.taskId,
    revision: root.revision,
    assignmentId: "assignment-root",
    currentTarget: { type: "role", id: "orchestrator" },
  };

  fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-ancestor",
  ).parentTaskId = "task-requirements";

  const pausedTestDeliveries = [
    ...acceptedPair({
      deliverableId: "test-report",
      contractRevision: 1,
      submittedRevision: 1,
      submittedSummary: "SECRET-OLD-TEST-HISTORY",
      acceptanceReason: "old test accepted",
      records: [evidence("test-report", "test:old", DIGEST_A)],
    }),
    delivery({
      deliverableId: "test-report",
      revision: 3,
      contractRevision: 2,
      status: "submitted",
      summary: "current test failure evidence",
      records: [evidence("test-report", "test:current", DIGEST_D)],
    }),
    delivery({
      deliverableId: "test-report",
      revision: 4,
      contractRevision: 2,
      status: "rejected",
      summary: "tests must be rerun",
      records: [evidence("test-report", "test:current", DIGEST_D)],
    }),
  ];
  const pausedTestTask = task({
    taskId: "task-tester",
    revision: 5,
    status: "paused",
    roleId: "tester",
    parentTaskId: root.taskId,
    dependsOn: ["task-implementation"],
    contracts: [
      contract(1, [expected("test-report", "test-report")]),
      contract(2, [expected("test-report", "test-report")]),
    ],
    deliveries: pausedTestDeliveries,
  });
  const otherRootChild = task({
    taskId: "task-other-child",
    revision: 2,
    status: "completed",
    roleId: "pr-engineer",
    parentTaskId: "task-other-root",
    contracts: [contract(1, [expected("review", "github-review")])],
    deliveries: acceptedPair({
      deliverableId: "review",
      contractRevision: 1,
      submittedRevision: 1,
      submittedSummary: "SECRET-OTHER-ROOT-CHILD",
      acceptanceReason: "other-root child accepted",
      records: [evidence("review-report", "review:other-child", DIGEST_B)],
    }),
  });
  fixture.snapshot.graph.tasks.push(pausedTestTask, otherRootChild);
  fixture.snapshot.taskStates.push(
    {
      ...state(pausedTestTask.taskId, pausedTestTask.revision),
      ledgerStatus: "paused",
      availableAt: "2026-08-03T07:00:00.000Z",
      statusReason: "SECRET-PAUSE-REASON",
    },
    state(otherRootChild.taskId, otherRootChild.revision),
  );
  return fixture;
}

test("assembles one exact frozen packet from direct accepted dependencies only", async () => {
  const fixture = graphFixture();
  const packet = await assemble(fixture);

  assert.deepEqual(Object.keys(packet), [
    "schemaVersion",
    "binding",
    "context",
    "acceptedInputs",
    "contextDigest",
  ]);
  assert.deepEqual(packet.binding, {
    roleId: "developer",
    taskId: "task-current",
    taskRevision: 8,
    inputDigest: DIGEST_D,
    graphId: "work-ledger",
    graphRevision: 20,
    graphContentDigest: fixture.snapshot.graph.contentDigest,
    contractRevision: 1,
  });
  assert.deepEqual(Object.keys(packet.context), ["requirements", "code"]);
  assert.deepEqual(
    packet.context.requirements.acceptedDependencies.map(({ taskId }) => taskId),
    ["task-requirements"],
  );
  assert.deepEqual(
    packet.context.code.acceptedDependencies.map(({ taskId }) => taskId),
    ["task-implementation"],
  );
  assert.equal(
    packet.context.requirements.acceptedDependencies[0].deliverables[0].summary,
    "accepted requirement specification v2",
  );
  assert.equal(
    packet.context.requirements.acceptedDependencies[0].deliverables[0].acceptanceReason,
    "requirements accepted for development",
  );
  assert.deepEqual(
    packet.acceptedInputs.map(({ taskId, deliverableId }) => [taskId, deliverableId]),
    [
      ["task-implementation", "implementation"],
      ["task-requirements", "requirement-spec"],
    ],
  );
  assert.deepEqual(packet.acceptedInputs[1], {
    taskId: "task-requirements",
    taskRevision: 7,
    contractRevision: 2,
    deliverableId: "requirement-spec",
    submittedDeliveryRevision: 3,
    decisionRevision: 4,
    evidenceDigests: [DIGEST_A, DIGEST_B],
  });
  assert.deepEqual(packet.context.requirements.source, {
    assignmentId: "assignment-current",
    eventId: "event-issue-1",
    eventType: "issue.updated",
  });
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.context.requirements.currentTask), true);
  assert.equal(Object.isFrozen(packet.acceptedInputs[0]), true);
  assert.match(packet.contextDigest, /^[a-f0-9]{64}$/);
  assert.equal(packet.context.requirements.currentTaskRejection, undefined);
  assert.equal(packet.context.code.currentTaskRejection, undefined);

  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "SECRET-OLD-CONTRACT",
    "SECRET-REJECTED-SUBMISSION",
    "SECRET-REJECTION",
    "SECRET-PENDING-SUBMISSION",
    "SECRET-TRANSITIVE-ANCESTOR",
    "SECRET-SIBLING",
    "SECRET-OTHER-ROOT",
    "NOT-IN-MINIMAL-SOURCE",
    "ownerId",
    "workerId",
    "leaseId",
    "leaseUntil",
    "must-not-leak",
    "createChild",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("adds only a validated persisted agent answer to the memory data class", async () => {
  const fixture = graphFixture();
  const calls = [];
  const agentQuery = {
    schemaVersion: 1,
    queryId: `agent-memory-query-${"a".repeat(64)}`,
    question: "上次如何修复？",
    searchQuery: "上次 修复",
    mode: "local",
    status: "answered",
    answer: "恢复了空值分支保护。",
    claims: [{
      statement: "恢复了空值分支保护。",
      citationIds: [`memory-${"b".repeat(64)}`],
    }],
    citations: [{
      recordId: `memory-${"b".repeat(64)}`,
      contentDigest: "b".repeat(64),
      title: "旧回归测试",
      occurredAt: "2026-08-07T08:00:00.000Z",
      eventType: "test.completed",
      roleId: "tester",
      repository: "acme/repo",
      source: { kind: "test-result", id: "test-result-1" },
    }],
    contextDigest: "c".repeat(64),
    answeredAt: "2026-08-08T01:00:00.000Z",
    brain: {
      mode: "local",
      provider: "ollama",
      model: "qwen-local",
      remote: false,
    },
    truncated: false,
  };
  const packet = await assemble(fixture, {
    memoryQueryReader: {
      async readContext(input) {
        calls.push(structuredClone(input));
        return structuredClone(agentQuery);
      },
    },
  });

  assert.deepEqual(packet.context.memory, { agentQuery });
  assert.deepEqual(calls, [{
    roleId: "developer",
    item: {
      itemId: "task-current",
      itemRevision: 8,
      inputDigest: DIGEST_D,
      currentTarget: { type: "role", id: "developer" },
    },
  }]);
  assert.equal(Object.isFrozen(packet.context.memory.agentQuery), true);
  assert.match(packet.contextDigest, /^[a-f0-9]{64}$/);
});

test("internal review receives the server handoff as unverified developer evidence for the current Head", async () => {
  const fixture = graphFixture({ pullRequest: true });
  fixture.item.currentTarget.id = "pr-engineer";
  fixture.snapshot.graph.tasks.find((task) => task.taskId === fixture.item.itemId).responsibility.id = "pr-engineer";
  const handoff = { kind: "developer_handoff", headRefOid: "abc123", brief: "Verify the existing repair", evidence: ["developer-report:1"], evidenceAuthority: "developer_report" };
  const options = { roleId: "pr-engineer", internalReviewHandoffReader: { async read(input) {
    assert.deepEqual(input, { itemId: fixture.item.itemId });
    return structuredClone(handoff);
  } } };
  const packet = await assemble(fixture, options);
  assert.deepEqual(packet.context.code.internalReview, handoff);
  assert.equal(packet.context.code.authoritativeEvidence, undefined);
  handoff.headRefOid = "old-head";
  await assert.rejects(assemble(fixture, options), { code: "ROLE_CONTEXT_STALE" });
  const developer = graphFixture({ pullRequest: true });
  await assemble(developer, { internalReviewHandoffReader: { read() { throw new Error("not a reviewer"); } } });
});

test("classifies PR source and fresh facts as code while keeping requirements present", async () => {
  const fixture = graphFixture({ pullRequest: true });
  const factCalls = [];
  const facts = factSource(
    {
      "ci-status": {
        healthy: true,
        fresh: true,
        value: "success",
        observedAt: "2026-08-03T05:00:00.000Z",
      },
      state: {
        healthy: true,
        fresh: false,
        value: "open",
        observedAt: "2026-08-03T04:00:00.000Z",
      },
      "review-decision": {
        healthy: false,
        fresh: false,
        value: "approved",
        observedAt: "2026-08-03T05:00:00.000Z",
      },
    },
    factCalls,
  );

  const packet = await assemble(fixture, { factSource: facts });

  assert.equal(packet.context.requirements.source.eventType, "pull_request.updated");
  assert.equal(packet.context.code.sourceEvent.payload.secretMarker, "PR-CONTEXT");
  assert.deepEqual(packet.context.code.facts, [
    {
      name: "ci-status",
      value: "success",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
  ]);
  assert.deepEqual(packet.context.requirements.facts, []);
  assert.deepEqual(
    factCalls.map(({ fact }) => fact),
    [
      "action-state",
      "ci-status",
      "merge-state",
      "next-action",
      "review-decision",
      "state",
    ],
  );
  assert.equal(factCalls.every(({ item }) => Object.keys(item).join() === "event"), true);
});

function pullRequestEvent(headRefOid, occurredAt, previousHeadRefOid) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt,
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: "github:pr:octo/repo#12",
      repository: "octo/repo",
      number: 12,
    },
    payload: {
      title: `PR at ${headRefOid[0]}`,
      headRefOid,
      changedFields: ["headRefOid"],
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
    },
  });
}

function pullRequestAssignment(sequence, sourceEvent) {
  return {
    sequence,
    assignment: {
      assignmentId: `workflow-assignment-${sequence}`,
      eventId: sourceEvent.eventId,
      target: { type: "role", id: "pr-engineer" },
      reason: "pr-events-to-pr-engineer",
    },
    event: sourceEvent,
  };
}

test("a PR source root binds context and facts to its active Head revision", async () => {
  const fixture = graphFixture({ pullRequest: true });
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const eventA = pullRequestEvent(headA, "2026-08-03T04:00:00.000Z");
  const eventB = pullRequestEvent(headB, "2026-08-03T05:00:00.000Z", headA);
  const initial = createPullRequestWorkSource(
    pullRequestAssignment(1, eventA),
  );
  const advanced = appendPullRequestWorkSource(
    initial.source,
    pullRequestAssignment(2, eventB),
    { attemptAtActivation: 0 },
  );
  fixture.item = {
    ...fixture.item,
    currentTarget: { type: "role", id: "pr-engineer" },
    decisionContext: null,
    inputDigest: advanced.source.current.inputDigest,
    event: eventA,
    source: advanced.source,
  };
  fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === fixture.item.itemId,
  ).responsibility = { type: "role", id: "pr-engineer" };
  const factCalls = [];
  const contextCalls = [];
  const pullRequestContext = {
    schemaVersion: 1,
    identityDigest: "1".repeat(64),
    contentDigest: "2".repeat(64),
    observedAt: "2026-08-03T05:01:00.000Z",
    summary: { reviewDecision: "REVIEW_REQUIRED" },
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    contextTruncated: false,
  };

  const packet = await assemble(fixture, {
    roleId: "pr-engineer",
    factSource: factSource({}, factCalls),
    pullRequestContextReader: {
      async read(value) {
        contextCalls.push(structuredClone(value));
        return pullRequestContext;
      },
    },
  });

  assert.equal(packet.binding.source.workKey, advanced.source.workKey);
  assert.equal(packet.binding.source.inputRevision, 2);
  assert.equal(packet.binding.source.headRevision, 2);
  assert.equal(packet.binding.source.headRefOid, headB);
  assert.equal(packet.context.requirements.source.eventId, eventB.eventId);
  assert.equal(packet.context.requirements.source.inputRevision, 2);
  assert.equal(packet.context.requirements.decisionContext, undefined);
  assert.equal(packet.context.code.sourceEvent.eventId, eventB.eventId);
  assert.equal(packet.context.code.sourceEvent.payload.headRefOid, headB);
  assert.deepEqual(packet.context.code.pullRequest, pullRequestContext);
  assert.equal(packet.context.code.decisionContext, undefined);
  assert.equal(
    factCalls.every(({ item }) => item.event.eventId === eventB.eventId),
    true,
  );
  assert.deepEqual(contextCalls, [{
    sourceBinding: packet.binding.source,
    event: eventB,
  }]);
});

test("conflict material readers are scoped to developer conflict tasks and failures stay explicit", async () => {
  const fixture = graphFixture({ pullRequest: true });
  fixture.item.event.payload.nextAction = "resolve_conflict";
  let calls = 0;
  const conflictInspectionReader = { async read(input) {
    calls += 1;
    assert.deepEqual(input, { itemId: fixture.item.itemId, itemRevision: fixture.item.revision, inputDigest: fixture.item.inputDigest });
    throw new Error("sealed material is unavailable");
  } };
  await assert.rejects(assemble(fixture, { conflictInspectionReader }),
    error => error.code === "ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE");
  fixture.item.event.payload.nextAction = "address_review";
  await assemble(fixture, { conflictInspectionReader });
  assert.equal(calls, 1);
});

function atomicPullRequestFixture() {
  const fixture = graphFixture({ pullRequest: true });
  const headRefOid = "b".repeat(40);
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "octo/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/review",
    headRefOid,
  };
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-03T05:00:00.000Z",
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: "github:pr:octo/repo#12",
      repository: "octo/repo",
      number: 12,
    },
    payload: {
      title: "Review atomic PR context",
      headRefOid,
      changedFields: ["headRefOid"],
      gitTargetAvailable: true,
      gitTarget,
    },
  });
  const source = createPullRequestWorkSource(
    pullRequestAssignment(1, event),
  ).source;
  fixture.item = {
    ...fixture.item,
    currentTarget: { type: "role", id: "pr-engineer" },
    decisionContext: null,
    inputDigest: source.current.inputDigest,
    event,
    source,
  };
  fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === fixture.item.itemId,
  ).responsibility = { type: "role", id: "pr-engineer" };
  const pullRequestContext = {
    schemaVersion: 1,
    identityDigest: "1".repeat(64),
    contentDigest: "2".repeat(64),
    observedAt: "2026-08-03T05:01:00.000Z",
    summary: { reviewDecision: "REVIEW_REQUIRED" },
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    contextTruncated: false,
    reviewMaterial: {
      schemaVersion: 1,
      gitTarget,
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      files: [{ path: "src/review.js", additions: 4, deletions: 1 }],
      filesTruncated: false,
      patch: "diff --git a/src/review.js b/src/review.js\n",
      patchTruncated: false,
    },
  };
  return { fixture, gitTarget, pullRequestContext };
}

test("required external Review context exposes reuse candidates without treating them as accepted evidence", async () => {
  const { fixture, pullRequestContext } = atomicPullRequestFixture();
  const current = fixture.snapshot.graph.tasks.find(value => value.taskId === fixture.item.itemId);
  current.acceptanceContracts = [contract(1, [expected("reuse-review", "review-report")])];
  pullRequestContext.materialDigest = DIGEST_C;
  let requests = 0;
  const candidate = { candidateId: "review-publication-candidate-" + DIGEST_A, materialDigest: DIGEST_C,
    deliverableId: "reuse-review", verdict: "approve", requiresCurrentReview: true };
  const packet = await assemble(fixture, { roleId: "pr-engineer", pullRequestContextReader: { async read() { return pullRequestContext; } },
    publicationReuseReader: { async listCandidates(input) {
      requests++; assert.deepEqual(input, { taskId: fixture.item.itemId, materialDigest: DIGEST_C });
      return { complete: true, candidates: [candidate] };
    } } });
  assert.equal(requests, 1);
  assert.deepEqual(packet.context.code.reviewPublicationReuse.candidates, [candidate]);
  assert.equal(packet.context.code.authoritativeEvidence?.some(value => value.referenceId === candidate.candidateId) ?? false, false);
  assert.equal(Object.isFrozen(packet.context.code.reviewPublicationReuse), true);
});

test("verified standard Review result removes inline code but preserves the whole residual task contract", async t => {
  const { fixture, pullRequestContext } = atomicPullRequestFixture();
  const current = fixture.snapshot.graph.tasks.find(value => value.taskId === fixture.item.itemId);
  current.acceptanceContracts = [contract(1, [expected("review", "review-report"), expected("qa-note", "text-report")])];
  pullRequestContext.materialDigest = DIGEST_C;
  pullRequestContext.reviewMaterial.patch = "diff preview ".repeat(5000);
  const candidate = { candidateId: "review-publication-candidate-" + DIGEST_A, materialDigest: DIGEST_C,
    deliverableId: "review", verdict: "approve", requiresCurrentReview: true };
  let verifiedResult;
  const options = { roleId: "pr-engineer", pullRequestContextReader: { async read() { return pullRequestContext; } },
    publicationReuseReader: { async listCandidates() { return { complete: true, candidates: [candidate], ...(verifiedResult ? { verifiedResult } : {}) }; } } };
  const full = await assemble(fixture, options);
  verifiedResult = { ...candidate, readProofId: "review-read-proof-" + DIGEST_B, coverageDigest: DIGEST_B };
  const reused = await assemble(fixture, options);
  assert.equal(reused.context.code.pullRequest.reviewMaterial, undefined);
  assert.deepEqual(reused.context.requirements.currentTask, full.context.requirements.currentTask);
  assert.equal(reused.context.requirements.currentTask.acceptanceContract.expectedDeliverables.length, 2);
  assert.ok(JSON.stringify(full.context).length - JSON.stringify(reused.context).length > 60000);
  assert.equal(reused.context.code.authoritativeEvidence?.length ?? 0, 0, "candidate is not an accepted delivery");
  t.diagnostic(JSON.stringify({ fixture: "same-current-task-context", fullContextBytes: Buffer.byteLength(JSON.stringify(full.context)),
    reusedContextBytes: Buffer.byteLength(JSON.stringify(reused.context)), remainingDeliverables: 2 }));
});

test("root Review recovery uses current host candidates rather than one historical rejection code", async (t) => {
  for (const code of ["ROLE_DECISION_PR_REVIEW_REQUIRED", "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION"]) await t.test(code, async () => {
    const { fixture, pullRequestContext, gitTarget } = atomicPullRequestFixture();
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.owner_requested",
      occurredAt: fixture.item.event.occurredAt, source: { provider: "local-owner", scopeId: "owner-request:00000000-0000-4000-8000-000000000001" },
      subject: fixture.item.event.subject, payload: { gitTarget, gitTargetAvailable: true, headRefOid: gitTarget.headRefOid,
        workType: "general", nextAction: "rereview", suggestedCapability: "pr-review", expectedHeadRefOid: gitTarget.headRefOid } });
    const envelope = pullRequestAssignment(1, event);
    envelope.assignment.target.id = "orchestrator";
    const source = createPullRequestWorkSource(envelope).source;
    fixture.item = { ...fixture.item, event, source, inputDigest: source.current.inputDigest, currentTarget: { type: "role", id: "orchestrator" } };
    const current = fixture.snapshot.graph.tasks.find(value => value.taskId === fixture.item.itemId);
    current.parentTaskId = null; current.responsibility.id = "orchestrator"; current.dependsOn = [];
    fixture.snapshot.graph.tasks.push(task({ taskId: "blocked-review", revision: 17, status: "failed", roleId: "pr-engineer",
      parentTaskId: current.taskId, contracts: [contract(1, [expected("review", "review-report")])] }));
    const childState = { ...state("blocked-review", 17), ledgerStatus: "blocked", statusReason: "decision_attempts_exhausted",
      decisionFailure: { code, stage: "decision", taskRevision: 17, timelineId: `work-timeline-${DIGEST_A}`,
        timelineDigest: DIGEST_A, recordedAt: "2026-08-03T07:00:00.000Z" } };
    fixture.snapshot.taskStates.push(childState);
    pullRequestContext.materialDigest = DIGEST_C;
    let reads = 0, candidates = [{ candidateId: `review-publication-candidate-${DIGEST_B}`, materialDigest: DIGEST_C,
      deliverableId: "review", verdict: "approve", reviewUrl: "https://github.com/octo/repo/pull/12#pullrequestreview-123", requiresCurrentReview: true }];
    const options = { roleId: "orchestrator", pullRequestContextReader: { async read() { return pullRequestContext; } },
      publicationReuseReader: { async listCandidates(input) {
        reads++; assert.deepEqual(input, { taskId: "blocked-review", materialDigest: DIGEST_C });
        return { complete: true, candidates };
      } } };
    const recovery = (await assemble(fixture, options)).context.code.reviewPublicationRecovery;
    assert.equal(reads, 1);
    assert.equal(recovery.childTaskId, "blocked-review");
    assert.equal(recovery.childTaskRevision, 17);
    assert.equal(recovery.requiresTaskControlChecks, true);
    assert.match(recovery.candidates[0].replacementChildKey, /^review-reuse-[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(recovery), true);
    childState.ledgerStatus = "paused"; childState.decisionFailure = null;
    assert.equal((await assemble(fixture, options)).context.code.reviewPublicationRecovery, undefined);
    assert.equal(reads, 1, "paused work does not request recovery candidates");
    childState.ledgerStatus = "blocked"; childState.decisionFailure = { code, stage: "decision", taskRevision: 17,
      timelineId: `work-timeline-${DIGEST_A}`, timelineDigest: DIGEST_A, recordedAt: "2026-08-03T07:00:00.000Z" };
    candidates = [];
    assert.equal((await assemble(fixture, options)).context.code.reviewPublicationRecovery, undefined);
  });
});

test("CI diagnostics retain the GitHub digest and bind the complete role context to the current Head", async () => {
  const { fixture, gitTarget, pullRequestContext } = atomicPullRequestFixture();
  const read = { async read() { return structuredClone(pullRequestContext); } };
  const baseline = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: read });
  const packet = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: read,
    ciDiagnosticReader: { async read(request) {
      assert.equal(request.repository, 'octo/repo'); assert.equal(request.headRefOid, gitTarget.headRefOid);
      assert.equal(request.headRefName, gitTarget.headRefName); assert.ok(request.maximumBytes <= 12000);
      const diagnostic = { schemaVersion: 1, repository: request.repository, headRefOid: request.headRefOid,
        reports: [{ state: 'available', result: 'FAILURE', untrustedEvidence: true, failures: [{ name: 'Formatting', text: 'actual failure' }] }] };
      return { ...diagnostic, contentDigest: canonicalJsonDigest(diagnostic) };
    } } });
  assert.deepEqual(packet.context.code.pullRequest, baseline.context.code.pullRequest);
  assert.equal(packet.context.code.pullRequest.contentDigest, pullRequestContext.contentDigest);
  assert.equal(packet.context.code.ciDiagnostics.reports[0].result, 'FAILURE');
  assert.notEqual(packet.contextDigest, baseline.contextDigest);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 128 * 1024);
});

test("CI outages, stale evidence and oversized evidence do not block the role or leak adapter errors", async () => {
  const { fixture, pullRequestContext } = atomicPullRequestFixture();
  for (const read of [async () => { throw new Error('private fixture-password'); }, async () => ({ schemaVersion: 1, repository: 'other/repo', headRefOid: '9'.repeat(40), reports: [], contentDigest: '0'.repeat(64) }),
    async () => ({ oversized: 'x'.repeat(200000) })]) {
    const packet = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: { async read() { return pullRequestContext; } }, ciDiagnosticReader: { read } });
    assert.equal(packet.context.code.ciDiagnostics.state, 'unavailable');
    assert.ok(!JSON.stringify(packet).includes('fixture-password'));
  }
});

test("legacy PR contexts without an atomic Git target skip optional CI without blocking the role", async () => {
  const { fixture, pullRequestContext } = atomicPullRequestFixture();
  const { eventId, contentDigest, ...oldEvent } = fixture.item.event;
  const { gitTarget, ...payload } = oldEvent.payload;
  const event = normalizeWorkflowEvent({ ...oldEvent, payload: { ...payload, gitTargetAvailable: false } });
  const source = createPullRequestWorkSource(pullRequestAssignment(1, event)).source;
  fixture.item = { ...fixture.item, event, source, inputDigest: source.current.inputDigest };
  let reads = 0;
  delete pullRequestContext.reviewMaterial;
  const packet = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: { async read() { return pullRequestContext; } },
    ciDiagnosticReader: { async read() { reads++; throw new Error('must not read legacy target'); } } });
  assert.equal(reads, 0);
  assert.equal(packet.context.code.ciDiagnostics.state, 'unavailable');
});

test("otherwise current CI material must keep its digest and fit the whole packet budget", async () => {
  const { fixture, pullRequestContext } = atomicPullRequestFixture();
  const reader = { async read() { return pullRequestContext; } };
  for (const mode of ['changed-digest', 'too-large']) {
    const packet = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: reader,
      ciDiagnosticReader: { async read(request) {
        const material = { schemaVersion: 1, repository: request.repository, headRefOid: request.headRefOid,
          reports: [{ state: 'available', text: mode === 'too-large' ? 'x'.repeat(request.maximumBytes) : 'original' }] };
        const result = { ...material, contentDigest: canonicalJsonDigest(material) };
        if (mode === 'changed-digest') result.reports[0].text = 'tampered';
        return result;
      } } });
    assert.equal(packet.context.code.ciDiagnostics.state, 'unavailable');
  }
  for (const task of fixture.snapshot.graph.tasks.filter(task => ['task-requirements', 'task-implementation'].includes(task.taskId))) {
    for (const delivery of task.deliveries.filter(delivery => ['submitted', 'accepted'].includes(delivery.status))) delivery.summary = 'x'.repeat(15000);
  }
  const baseline = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: reader });
  pullRequestContext.reviewMaterial.patch += 'x'.repeat(128 * 1024 - Buffer.byteLength(JSON.stringify(baseline)) - 2000);
  let requestedBudget;
  const packet = await assemble(fixture, { roleId: 'pr-engineer', pullRequestContextReader: reader,
    ciDiagnosticReader: { async read(request) {
      requestedBudget = request.maximumBytes;
      const material = { schemaVersion: 1, repository: request.repository, headRefOid: request.headRefOid,
        reports: [{ state: 'available', text: 'x'.repeat(request.maximumBytes - 350) }] };
      return { ...material, contentDigest: canonicalJsonDigest(material) };
    } } });
  assert.ok(requestedBudget >= 256 && requestedBudget < 3000);
  assert.equal(packet.context.code.ciDiagnostics.reports[0].state, 'available');
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 128 * 1024);
});

test("PR review material is checked against the atomic target reconstructed from the source event", async () => {
  const { fixture, gitTarget, pullRequestContext } = atomicPullRequestFixture();

  const packet = await assemble(fixture, {
    roleId: "pr-engineer",
    pullRequestContextReader: {
      async read() {
        return structuredClone(pullRequestContext);
      },
    },
  });

  assert.deepEqual(
    packet.context.code.pullRequest.reviewMaterial.gitTarget,
    gitTarget,
  );

  const stale = structuredClone(pullRequestContext);
  stale.reviewMaterial.gitTarget.headRefOid = "c".repeat(40);
  await assert.rejects(
    assemble(fixture, {
      roleId: "pr-engineer",
      pullRequestContextReader: { async read() { return stale; } },
    }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE",
  );
});

test("a configured PR context reader fails closed without an exact source", async () => {
  const fixture = graphFixture({ pullRequest: true });
  let contextCalls = 0;

  await assert.rejects(
    assemble(fixture, {
      pullRequestContextReader: {
        async read() {
          contextCalls += 1;
          throw new Error("must not run without a source binding");
        },
      },
    }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(contextCalls, 0);
});

test("a PR graph child gives its brain the inherited exact Head binding", async () => {
  const fixture = graphFixture({ pullRequest: true });
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const eventA = pullRequestEvent(headA, "2026-08-03T04:00:00.000Z");
  const eventB = pullRequestEvent(headB, "2026-08-03T05:00:00.000Z", headA);
  const initial = createPullRequestWorkSource(
    pullRequestAssignment(1, eventA),
  );
  const advanced = appendPullRequestWorkSource(
    initial.source,
    pullRequestAssignment(2, eventB),
    { attemptAtActivation: 0 },
  );
  const sourceBinding = currentWorkItemInputBinding({
    itemId: "pr-source-root",
    source: advanced.source,
  });
  fixture.item = {
    ...fixture.item,
    kind: "graph_task",
    currentTarget: { type: "role", id: "pr-engineer" },
    event: eventB,
    assignment: {
      graphTask: { sourceBinding },
    },
  };
  fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === fixture.item.itemId,
  ).responsibility = { type: "role", id: "pr-engineer" };

  const packet = await assemble(fixture, { roleId: "pr-engineer" });

  assert.deepEqual(packet.binding.source, sourceBinding);
  assert.equal(packet.context.requirements.source.rootItemId, "pr-source-root");
  assert.equal(packet.context.requirements.source.headRevision, 2);
  assert.equal(packet.context.requirements.source.headRefOid, headB);
  assert.equal(packet.context.code.sourceEvent.eventId, eventB.eventId);

  const staleFixture = structuredClone(fixture);
  staleFixture.item.event.payload.headRefOid = headA;
  await assert.rejects(
    assemble(staleFixture, { roleId: "pr-engineer" }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_INVALID",
  );
});

test("projects bounded authoritative evidence for the exact current role and contract", async () => {
  const fixture = graphFixture();
  const currentTask = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  const deliverables = [
    expected("verification", "test-report"),
    expected("requirements", "requirement-spec"),
    expected("analysis", "text-report"),
    expected("implementation", "change-package"),
    expected("secondary-change", "change-package", false),
  ];
  currentTask.acceptanceContracts = [
    contract(1, deliverables),
    contract(2, deliverables),
    contract(3, deliverables),
  ];
  const currentContract = currentTask.acceptanceContracts.at(-1);
  const catalogCalls = [];
  const sourceRecords = [
    {
      deliverableId: "verification",
      evidence: evidence("test-report", "code-job-authoritative", DIGEST_B),
    },
    {
      deliverableId: "implementation",
      evidence: evidence(
        "change-package",
        "change-package-authoritative",
        DIGEST_A,
      ),
    },
  ];

  const packet = await assemble(fixture, {
    evidenceCatalog: {
      async listForTask(value) {
        catalogCalls.push(structuredClone(value));
        return sourceRecords;
      },
    },
  });

  assert.deepEqual(catalogCalls, [
    {
      taskId: "task-current",
      roleId: "developer",
      contractRevision: 3,
      contractDigest: deliveryAcceptanceContractDigest(currentContract),
      kinds: ["change-package", "test-report"],
      limit: 20,
    },
  ]);
  assert.deepEqual(packet.context.code.authoritativeEvidence, sourceRecords);
  assert.equal(
    Object.isFrozen(packet.context.code.authoritativeEvidence),
    true,
  );
  assert.equal(
    packet.context.code.authoritativeEvidence.every(Object.isFrozen),
    true,
  );

  sourceRecords[0].evidence.referenceId = "caller-mutated-reference";
  sourceRecords.push({
    deliverableId: "verification",
    evidence: evidence("test-report", "caller-added", DIGEST_C),
  });
  assert.deepEqual(packet.context.code.authoritativeEvidence, [
    {
      deliverableId: "verification",
      evidence: evidence("test-report", "code-job-authoritative", DIGEST_B),
    },
    {
      deliverableId: "implementation",
      evidence: evidence(
        "change-package",
        "change-package-authoritative",
        DIGEST_A,
      ),
    },
  ]);
});

test("passes the caller abort signal to the authoritative evidence catalog", async () => {
  const fixture = graphFixture();
  const controller = new AbortController();
  let catalogSignal;
  const assembler = new RoleContextAssembler({
    graphReader: reader(fixture.snapshot),
    evidenceCatalog: {
      async listForTask({ signal }) {
        catalogSignal = signal;
        return [];
      },
    },
  });

  await assembler.assemble({
    roleId: "developer",
    item: fixture.item,
    trigger: "employee:developer",
    signal: controller.signal,
  });

  assert.equal(catalogSignal, controller.signal);
  assert.equal(catalogSignal.aborted, false);
});

test("caller cancellation stops a hanging graph snapshot read", async () => {
  const fixture = graphFixture();
  const controller = new AbortController();
  const started = deferred();
  let graphSignal;
  const assembler = new RoleContextAssembler({
    graphReader: {
      async getSnapshot({ signal } = {}) {
        graphSignal = signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    },
  });
  const operation = assembler.assemble({
    roleId: "developer",
    item: fixture.item,
    trigger: "employee:developer",
    signal: controller.signal,
  });
  await started.promise;
  const reason = new DOMException("graph read timed out", "AbortError");

  controller.abort(reason);

  await assert.rejects(operation, (error) => error === reason);
  assert.equal(graphSignal, controller.signal);
  assert.equal(graphSignal.aborted, true);
});

test("caller cancellation stops a hanging fact read", async () => {
  const fixture = graphFixture();
  const controller = new AbortController();
  const started = deferred();
  let factSignal;
  const assembler = new RoleContextAssembler({
    graphReader: reader(fixture.snapshot),
    factSource: {
      async read(_request, { signal } = {}) {
        factSignal = signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    },
  });
  const operation = assembler.assemble({
    roleId: "developer",
    item: fixture.item,
    trigger: "employee:developer",
    signal: controller.signal,
  });
  await started.promise;
  const reason = new DOMException("fact read timed out", "AbortError");

  controller.abort(reason);

  await assert.rejects(operation, (error) => error === reason);
  assert.equal(factSignal, controller.signal);
  assert.equal(factSignal.aborted, true);
});

test("fails closed when authoritative evidence cannot be read or exceeds its bound", async () => {
  const sourceFailure = new Error("evidence registry unavailable");
  await assert.rejects(
    assemble(graphFixture(), {
      evidenceCatalog: {
        async listForTask() {
          throw sourceFailure;
        },
      },
    }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_EVIDENCE_UNAVAILABLE" &&
      error.statusCode === 503 &&
      error.cause === sourceFailure,
  );

  await assert.rejects(
    assemble(graphFixture(), {
      evidenceCatalog: {
        async listForTask() {
          return Array.from({ length: 21 }, (_, index) =>
            evidence("change-package", `package-${index}`, DIGEST_A)
          );
        },
      },
    }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_EVIDENCE_INVALID" &&
      error.statusCode === 503,
  );
});

test("places fresh non-PR facts in requirements and omits an otherwise empty code class", async () => {
  const fixture = graphFixture();
  fixture.snapshot.graph.tasks = fixture.snapshot.graph.tasks.filter(
    ({ taskId }) => taskId !== "task-implementation",
  );
  fixture.snapshot.taskStates = fixture.snapshot.taskStates.filter(
    ({ taskId }) => taskId !== "task-implementation",
  );
  fixture.snapshot.graph.tasks.find(({ taskId }) => taskId === "task-current").dependsOn = [
    "task-requirements",
  ];
  const facts = factSource({
    state: {
      healthy: true,
      fresh: true,
      value: "open",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    "issue-description": {
      healthy: true,
      fresh: true,
      value: "Issue body with screenshot and video links",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    "issue-comments-count": {
      healthy: true,
      fresh: true,
      value: "2",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    "issue-latest-comment": {
      healthy: true,
      fresh: true,
      value: JSON.stringify({ author: "carol", body: "Use release branch" }),
      observedAt: "2026-08-03T05:00:00.000Z",
    },
  });

  const packet = await assemble(fixture, { factSource: facts });

  assert.deepEqual(Object.keys(packet.context), ["requirements"]);
  assert.deepEqual(packet.context.requirements.facts, [
    {
      name: "state",
      value: "open",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    {
      name: "issue-description",
      value: "Issue body with screenshot and video links",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    {
      name: "issue-comments-count",
      value: "2",
      observedAt: "2026-08-03T05:00:00.000Z",
    },
    {
      name: "issue-latest-comment",
      value: JSON.stringify({ author: "carol", body: "Use release branch" }),
      observedAt: "2026-08-03T05:00:00.000Z",
    },
  ]);
});

test("preserves nullable assignment work fields from the graph projection", async () => {
  for (const work of [
    { title: null, description: "Known description" },
    { title: "Known title", description: null },
    { title: null, description: null },
  ]) {
    const fixture = graphFixture();
    fixture.snapshot.taskStates.find(
      ({ taskId }) => taskId === "task-current",
    ).work = work;

    const packet = await assemble(fixture);

    assert.deepEqual(packet.context.requirements.currentTask.work, work);
  }
});

test("shows a specialist only the newest unresolved rejection in its data class", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.acceptanceContracts[0].expectedDeliverables = [
    expected("implementation", "change-package"),
    expected("verification", "test-report"),
  ];
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-OLDER-SUBMISSION",
      records: [evidence("change-package", "change:older", DIGEST_A)],
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-OLDER-REJECTION",
      records: [evidence("change-package", "change:older", DIGEST_A)],
    }),
    delivery({
      deliverableId: "verification",
      revision: 3,
      contractRevision: 1,
      status: "submitted",
      summary: "tests currently fail on Windows",
      records: [evidence("test-report", "test:windows", DIGEST_B)],
    }),
    delivery({
      deliverableId: "verification",
      revision: 4,
      contractRevision: 1,
      status: "rejected",
      summary: "rerun after fixing the Windows path",
      records: [evidence("test-report", "test:windows", DIGEST_B)],
    }),
  ];

  const packet = await assemble(fixture);

  assert.equal(packet.context.requirements.currentTaskRejection, undefined);
  assert.deepEqual(packet.context.code.currentTaskRejection, {
    contractRevision: 1,
    deliverableId: "verification",
    kind: "test-report",
    submittedDeliveryRevision: 3,
    decisionRevision: 4,
    reason: "rerun after fixing the Windows path",
    reasonTruncated: false,
    evidence: [evidence("test-report", "test:windows", DIGEST_B)],
    hasMoreEvidence: false,
  });
  assert.equal(
    JSON.stringify(packet).includes("SECRET-OLDER-SUBMISSION"),
    false,
  );
  assert.equal(
    JSON.stringify(packet).includes("SECRET-OLDER-REJECTION"),
    false,
  );
  assert.equal(
    JSON.stringify(packet).includes("tests currently fail on Windows"),
    false,
  );
  assert.equal(Object.isFrozen(packet.context.code.currentTaskRejection), true);
});

test("keeps requirement rejection feedback in requirements and drops old contracts", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.responsibility.id = "requirements-analyst";
  current.acceptanceContracts = [
    contract(1, [expected("requirement-spec", "requirement-spec")]),
    contract(2, [expected("requirement-spec", "requirement-spec")]),
  ];
  current.deliveries = [
    delivery({
      deliverableId: "requirement-spec",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-OLD-SPEC",
    }),
    delivery({
      deliverableId: "requirement-spec",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-OLD-SPEC-REASON",
    }),
    delivery({
      deliverableId: "requirement-spec",
      revision: 3,
      contractRevision: 2,
      status: "submitted",
      summary: "current scope draft",
      records: [evidence("requirement-spec", "spec:current", DIGEST_C)],
    }),
    delivery({
      deliverableId: "requirement-spec",
      revision: 4,
      contractRevision: 2,
      status: "rejected",
      summary: "clarify the offline acceptance criterion",
      records: [evidence("requirement-spec", "spec:current", DIGEST_C)],
    }),
  ];
  fixture.item.currentTarget.id = "requirements-analyst";

  const packet = await assemble(fixture, { roleId: "requirements-analyst" });

  assert.deepEqual(packet.context.requirements.currentTaskRejection, {
    contractRevision: 2,
    deliverableId: "requirement-spec",
    kind: "requirement-spec",
    submittedDeliveryRevision: 3,
    decisionRevision: 4,
    reason: "clarify the offline acceptance criterion",
    reasonTruncated: false,
    evidence: [evidence("requirement-spec", "spec:current", DIGEST_C)],
    hasMoreEvidence: false,
  });
  assert.equal(packet.context.code.currentTaskRejection, undefined);
  const serialized = JSON.stringify(packet);
  assert.equal(serialized.includes("SECRET-OLD-SPEC"), false);
  assert.equal(serialized.includes("SECRET-OLD-SPEC-REASON"), false);
  assert.equal(serialized.includes("current scope draft"), false);
});

test("keeps an unresolved rejection when a different deliverable is later accepted", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.acceptanceContracts[0].expectedDeliverables = [
    expected("implementation", "change-package"),
    expected("verification", "test-report"),
  ];
  const implementationEvidence = [
    evidence("change-package", "change:implementation", DIGEST_A),
  ];
  const verificationEvidence = [
    evidence("test-report", "test:verification", DIGEST_B),
  ];
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "implementation draft",
      records: implementationEvidence,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "fix the implementation",
      records: implementationEvidence,
    }),
    delivery({
      deliverableId: "verification",
      revision: 3,
      contractRevision: 1,
      status: "submitted",
      summary: "verification draft",
      records: verificationEvidence,
    }),
    delivery({
      deliverableId: "verification",
      revision: 4,
      contractRevision: 1,
      status: "accepted",
      summary: "verification accepted",
      records: verificationEvidence,
    }),
  ];

  const packet = await assemble(fixture);

  assert.equal(
    packet.context.code.currentTaskRejection.deliverableId,
    "implementation",
  );
  assert.equal(
    packet.context.code.currentTaskRejection.reason,
    "fix the implementation",
  );
  assert.equal(JSON.stringify(packet).includes("implementation draft"), false);
  assert.equal(JSON.stringify(packet).includes("verification draft"), false);
});

test("omits a rejection superseded by a later accepted resubmission", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  const records = [evidence("change-package", "change:current", DIGEST_A)];
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "first draft",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "first draft rejected",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 3,
      contractRevision: 1,
      status: "submitted",
      summary: "corrected draft",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 4,
      contractRevision: 1,
      status: "accepted",
      summary: "corrected draft accepted",
      records,
    }),
  ];

  const packet = await assemble(fixture);

  assert.equal(packet.context.code.currentTaskRejection, undefined);
  assert.equal(JSON.stringify(packet).includes("first draft rejected"), false);
});

test("bounds rejection reason and evidence without splitting UTF-8", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  const records = Array.from({ length: 9 }, (_, index) =>
    evidence("change-package", `change:feedback-${index}`, DIGEST_A),
  );
  const longReason = "界".repeat(2_000);
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-LARGE-SUBMISSION",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: longReason,
      records: [...records].reverse(),
    }),
  ];

  const packet = await assemble(fixture);
  const rejection = packet.context.code.currentTaskRejection;

  assert.equal(Buffer.byteLength(rejection.reason, "utf8") <= 4_096, true);
  assert.equal(rejection.reasonTruncated, true);
  assert.equal(rejection.evidence.length, 8);
  assert.equal(rejection.hasMoreEvidence, true);
  assert.equal(
    rejection.evidence.some(({ referenceId }) =>
      referenceId === "change:feedback-8"
    ),
    false,
  );
  assert.equal(JSON.stringify(packet).includes("SECRET-LARGE-SUBMISSION"), false);
});

test("fails closed when the current rejection has no matching submission", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "draft",
      records: [evidence("change-package", "change:draft", DIGEST_A)],
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-MALFORMED-REASON",
      records: [evidence("change-package", "change:draft", DIGEST_B)],
    }),
  ];

  await assert.rejects(
    assemble(fixture),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_CURRENT_REJECTION_INVALID" &&
      !error.message.includes("SECRET-MALFORMED-REASON"),
  );
});

test("fails closed for stale task bindings, incomplete required delivery, bad acceptance pair, and unknown kinds", async () => {
  const cases = [
    {
      code: "ROLE_CONTEXT_STALE",
      mutate({ item }) {
        item.revision += 1;
      },
    },
    {
      code: "ROLE_CONTEXT_AUTHORITY_DENIED",
      mutate({ item, snapshot }) {
        snapshot.graph.tasks.find(({ taskId }) => taskId === "task-current")
          .responsibility.id = "tester";
        item.currentTarget.id = "tester";
      },
    },
    {
      code: "ROLE_CONTEXT_DEPENDENCY_NOT_ACCEPTED",
      mutate({ snapshot }) {
        const dependency = snapshot.graph.tasks.find(
          ({ taskId }) => taskId === "task-requirements",
        );
        dependency.status = "in_progress";
        dependency.deliveries.at(-1).status = "rejected";
      },
    },
    {
      code: "ROLE_CONTEXT_DEPENDENCY_INVALID",
      mutate({ snapshot }) {
        const dependency = snapshot.graph.tasks.find(
          ({ taskId }) => taskId === "task-requirements",
        );
        dependency.deliveries[2].status = "rejected";
      },
    },
    {
      code: "ROLE_CONTEXT_CLASSIFICATION_REQUIRED",
      mutate({ snapshot }) {
        const dependency = snapshot.graph.tasks.find(
          ({ taskId }) => taskId === "task-requirements",
        );
        dependency.acceptanceContracts.at(-1).expectedDeliverables[0].kind =
          "unknown-artifact";
      },
    },
  ];

  for (const { code, mutate } of cases) {
    const fixture = graphFixture();
    mutate(fixture);
    await assert.rejects(
      assemble(fixture),
      (error) => error instanceof RoleContextAssemblerError && error.code === code,
    );
  }
});

test("the trusted orchestrator may inspect a specialist task without crossing its root", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  const records = [evidence("change-package", "change:rejected", DIGEST_A)];
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-ORCHESTRATOR-SUBMISSION",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-ORCHESTRATOR-REJECTION",
      records,
    }),
  ];
  const assembler = new RoleContextAssembler({
    graphReader: reader(fixture.snapshot),
  });

  const packet = await assembler.assemble({
    roleId: "orchestrator",
    item: fixture.item,
    trigger: "employee:orchestrator",
  });

  assert.equal(packet.binding.roleId, "orchestrator");
  assert.equal(
    packet.context.requirements.currentTask.responsibility.id,
    "developer",
  );
  assert.equal(JSON.stringify(packet).includes("SECRET-SIBLING"), false);
  assert.equal(JSON.stringify(packet).includes("SECRET-OTHER-ROOT"), false);
  assert.deepEqual(
    packet.acceptedInputs.map(({ taskId }) => taskId),
    ["task-implementation", "task-requirements"],
  );
  assert.equal(packet.context.requirements.coordination, undefined);
  assert.equal(packet.context.requirements.childDeliveries, undefined);
  assert.equal(packet.context.code.childDeliveries, undefined);
  assert.equal(packet.context.requirements.currentTaskRejection, undefined);
  assert.equal(packet.context.code.currentTaskRejection, undefined);
  assert.equal(
    JSON.stringify(packet).includes("SECRET-ORCHESTRATOR-REJECTION"),
    false,
  );
});

test("unrelated roots cannot force classification of their private deliverables", async () => {
  const fixture = graphFixture();
  fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-other-root",
  ).acceptanceContracts[0].expectedDeliverables[0].kind = "private-artifact";

  const packet = await assemble(fixture);

  assert.equal(packet.binding.taskId, "task-current");
  assert.equal(JSON.stringify(packet).includes("private-artifact"), false);
});

test("does not project specialist rejection feedback from a root task", async () => {
  const fixture = graphFixture();
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.parentTaskId = null;
  fixture.snapshot.graph.tasks = fixture.snapshot.graph.tasks.filter(
    ({ taskId }) => taskId === current.taskId || taskId === "task-other-root",
  );
  fixture.snapshot.taskStates = fixture.snapshot.taskStates.filter(
    ({ taskId }) => taskId === current.taskId || taskId === "task-other-root",
  );
  current.dependsOn = [];
  const records = [evidence("change-package", "change:root", DIGEST_A)];
  current.deliveries = [
    delivery({
      deliverableId: "implementation",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: "SECRET-ROOT-SUBMISSION",
      records,
    }),
    delivery({
      deliverableId: "implementation",
      revision: 2,
      contractRevision: 1,
      status: "rejected",
      summary: "SECRET-ROOT-REJECTION",
      records,
    }),
  ];

  const packet = await assemble(fixture);

  assert.equal(packet.context.requirements.currentTaskRejection, undefined);
  assert.equal(packet.context.code?.currentTaskRejection, undefined);
  assert.equal(JSON.stringify(packet).includes("SECRET-ROOT-REJECTION"), false);
});

test("a root orchestrator receives recovered Review diagnostics without a synthetic Review delivery", async () => {
  const fixture = rootOrchestratorFixture();
  fixture.item.decisionContext = { source: "proposal", referenceId: `work-intent-${DIGEST_A}`, outcome: "stale",
    value: { kind: "host_review_diagnostic", code: "REVIEW_AUTHORIZATION_CHANGED", invalidationReason: "authorization_changed",
      publicationExecuted: false, contractSatisfied: false }, observedAt: "2026-08-03T05:00:00.000Z", contentDigest: DIGEST_B };
  const packet = await assemble(fixture, { roleId: "orchestrator" });
  assert.deepEqual(packet.context.code.decisionContext, fixture.item.decisionContext);
  assert.equal(packet.context.requirements.decisionContext, undefined);
});

test("a configured root orchestrator receives exact direct-child coordination by data class", async () => {
  const fixture = rootOrchestratorFixture();
  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const coordination = packet.context.requirements.coordination;

  assert.deepEqual(Object.keys(coordination), [
    "schemaVersion",
    "rootTaskId",
    "directChildren",
    "history",
    "deliveryWindow",
  ]);
  assert.equal(coordination.schemaVersion, 2);
  assert.equal(coordination.rootTaskId, "task-root");
  assert.deepEqual(coordination.history, {
    supersededChildCount: 0,
  });
  assert.deepEqual(coordination.deliveryWindow, {
    pendingCount: 1,
    shownCount: 1,
    hasMore: false,
  });
  assert.deepEqual(
    coordination.directChildren.map(({ taskId }) => taskId),
    [
      "task-current",
      "task-implementation",
      "task-requirements",
      "task-sibling",
      "task-tester",
    ],
  );
  for (const child of coordination.directChildren) {
    assert.deepEqual(Object.keys(child), [
      "taskId",
      "taskRevision",
      "status",
      "ledgerStatus",
      "blockingCondition",
      "responsibility",
      "work",
      "directDependencyTaskIds",
      "hasOtherDependencies",
      "contractRevision",
      "deliverableCount",
      "hasMoreDeliverables",
      "hasAcceptedRequiredReview",
      "deliverables",
    ]);
  }

  const current = coordination.directChildren.find(
    ({ taskId }) => taskId === "task-current",
  );
  assert.deepEqual(current.directDependencyTaskIds, [
    "task-implementation",
    "task-requirements",
  ]);
  assert.equal(current.hasOtherDependencies, false);
  assert.deepEqual(current.deliverables, [
    {
      deliverableId: "implementation",
      kind: "change-package",
      required: true,
      state: "none",
      submittedDeliveryRevision: null,
      decisionRevision: null,
    },
  ]);
  assert.equal(current.deliverableCount, 1);
  assert.equal(current.hasMoreDeliverables, false);

  const requirements = coordination.directChildren.find(
    ({ taskId }) => taskId === "task-requirements",
  );
  assert.deepEqual(requirements.directDependencyTaskIds, []);
  assert.equal(requirements.hasOtherDependencies, true);
  assert.deepEqual(requirements.deliverables, [
    {
      deliverableId: "requirement-spec",
      kind: "requirement-spec",
      required: true,
      state: "accepted",
      submittedDeliveryRevision: 3,
      decisionRevision: 4,
    },
  ]);

  const paused = coordination.directChildren.find(
    ({ taskId }) => taskId === "task-tester",
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.ledgerStatus, "paused");
  assert.deepEqual(paused.directDependencyTaskIds, ["task-implementation"]);
  assert.deepEqual(paused.deliverables, [
    {
      deliverableId: "test-report",
      kind: "test-report",
      required: true,
      state: "rejected",
      submittedDeliveryRevision: 3,
      decisionRevision: 4,
    },
  ]);

  assert.deepEqual(packet.context.requirements.childDeliveries, []);
  assert.deepEqual(
    packet.context.code.childDeliveries.map(
      ({ taskId, deliverableId, state }) => [taskId, deliverableId, state],
    ),
    [
      ["task-implementation", "pending-review", "submitted"],
    ],
  );
  for (const payload of [
    ...packet.context.requirements.childDeliveries,
    ...packet.context.code.childDeliveries,
  ]) {
    assert.deepEqual(Object.keys(payload), [
      "taskId",
      "taskRevision",
      "contractRevision",
      "deliverableId",
      "kind",
      "state",
      "submittedDeliveryRevision",
      "decisionRevision",
      "summary",
      "decisionReason",
      "evidence",
    ]);
  }
  assert.equal(
    packet.context.code.childDeliveries.find(
      ({ deliverableId }) => deliverableId === "pending-review",
    ).decisionReason,
    null,
  );

  const requirementsJson = JSON.stringify(packet.context.requirements);
  for (const codeOnly of [
    "accepted implementation package",
    "SECRET-REJECTED-SUBMISSION",
    "SECRET-REJECTION",
    "SECRET-PENDING-SUBMISSION",
    "SECRET-SIBLING",
    "current test failure evidence",
    "tests must be rerun",
  ]) {
    assert.equal(requirementsJson.includes(codeOnly), false, codeOnly);
  }
  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "task-ancestor",
    "SECRET-TRANSITIVE-ANCESTOR",
    "task-other-root",
    "task-other-child",
    "SECRET-OTHER-ROOT",
    "SECRET-OTHER-ROOT-CHILD",
    "SECRET-OLD-CONTRACT",
    "SECRET-OLD-TEST-HISTORY",
    "ownerId",
    "workerId",
    "leaseId",
    "leaseUntil",
    "availableAt",
    "statusReason",
    "SECRET-PAUSE-REASON",
    "must-not-leak-owner",
    "must-not-leak-worker",
    "must-not-leak-lease",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(packet.acceptedInputs, []);
  assert.equal(Object.isFrozen(coordination), true);
  assert.equal(Object.isFrozen(coordination.directChildren), true);
  assert.equal(Object.isFrozen(paused.deliverables[0]), true);
  assert.equal(Object.isFrozen(packet.context.code.childDeliveries[0]), true);
});

test("root coordination exposes a proven pre-dispatch conflict failure without raw host diagnostics", async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current");
  state.ledgerStatus = "blocked";
  state.statusReason = "intent_failed";
  state.dispatchFailure = { intentId: "work-intent-conflict", code: "conflict-source-stale", downstreamCreated: false };
  state.rawError = "PRIVATE-HOST-TRACE";
  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const visible = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(visible.blockingCondition, "conflict-source-stale");
  assert.deepEqual(visible.dispatchFailure, state.dispatchFailure);
  assert.equal(JSON.stringify(packet).includes("PRIVATE-HOST-TRACE"), false);
});

test("root coordination exposes an unbound policy failure without claiming its cause or recovery", async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current");
  state.ledgerStatus = "blocked";
  state.statusReason = "intent_failed";
  state.dispatchFailure = { intentId: "work-intent-policy", code: "policy-binding-invalid", downstreamCreated: false };
  state.rawError = "PRIVATE-HOST-TRACE";
  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const child = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(child.blockingCondition, "policy-binding-invalid");
  assert.deepEqual(child.dispatchFailure, state.dispatchFailure);
  assert.equal(JSON.stringify(packet).includes("PRIVATE-HOST-TRACE"), false);
  state.dispatchFailure.downstreamCreated = true;
  await assert.rejects(assemble(fixture, { roleId: "orchestrator" }), error => error.code === "ROLE_CONTEXT_INVALID");
});

test("root coordination explains a verification delivery mismatch while preserving the original package contract", async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current");
  state.ledgerStatus = "blocked";
  state.statusReason = "intent_failed";
  const contract = fixture.snapshot.graph.tasks.find(({ taskId }) => taskId === state.taskId).acceptanceContracts.at(-1);
  state.dispatchFailure = { intentId: "work-intent-verification", code: "delivery-evidence-incompatible", downstreamCreated: false,
    operation: "verify", contractRevision: contract.revision, contractDigest: deliveryAcceptanceContractDigest(contract),
    compatibleEvidenceKinds: ["test-report"], expectedDeliverables: contract.expectedDeliverables.map(({ deliverableId, kind }) => ({ deliverableId, kind })) };
  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const child = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(child.blockingCondition, "delivery-evidence-incompatible");
  assert.deepEqual(child.dispatchFailure, state.dispatchFailure);
  for (const variant of ["contract", "operation", "output-kinds", "expected-kind", "downstream"]) {
    const previous = structuredClone(state.dispatchFailure);
    if (variant === "contract") state.dispatchFailure.contractRevision++;
    if (variant === "operation") state.dispatchFailure.operation = "inspect";
    if (variant === "output-kinds") state.dispatchFailure.compatibleEvidenceKinds = ["change-package"];
    if (variant === "expected-kind") state.dispatchFailure.expectedDeliverables[0].kind = "test-report";
    if (variant === "downstream") state.dispatchFailure.downstreamCreated = true;
    await assert.rejects(assemble(fixture, { roleId: "orchestrator" }), error => error.code === "ROLE_CONTEXT_INVALID", variant);
    state.dispatchFailure = previous;
  }
});

test("root coordination distinguishes settled ledger work from coarse graph progress", async (t) => {
  for (const ledgerStatus of ["queued", "retry_wait", "blocked", "working", "waiting_external"]) {
    await t.test(ledgerStatus, async () => {
      const fixture = rootOrchestratorFixture();
      const child = fixture.snapshot.graph.tasks.find(({ taskId }) => taskId === "task-current");
      child.status = ledgerStatus === "queued" ? "pending" : "in_progress";
      fixture.snapshot.taskStates.find(({ taskId }) => taskId === child.taskId).ledgerStatus = ledgerStatus;
      fixture.snapshot.taskStates.find(({ taskId }) => taskId === child.taskId).statusReason = "proposal_stale";
      const packet = await assemble(fixture, { roleId: "orchestrator" });
      const visible = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === child.taskId);
      assert.equal(visible.status, child.status);
      assert.equal(visible.ledgerStatus, ledgerStatus);
      assert.equal(visible.blockingCondition, ledgerStatus === "blocked" ? "proposal-stale" : null);
      assert.equal(Object.keys(visible).some((key) => ["ownerId", "leaseUntil", "statusReason"].includes(key)), false);
    });
  }
  await t.test("missing legacy status stays unknown", async () => {
    const fixture = rootOrchestratorFixture();
    delete fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current").ledgerStatus;
    const packet = await assemble(fixture, { roleId: "orchestrator" });
    assert.equal(packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === "task-current").ledgerStatus, null);
  });
  await t.test("unknown raw blocking reasons stay private", async () => {
    const fixture = rootOrchestratorFixture();
    const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current");
    state.ledgerStatus = "blocked";
    state.statusReason = "proposal_stale\nPRIVATE-DIAGNOSTIC";
    const packet = await assemble(fixture, { roleId: "orchestrator" });
    assert.equal(packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === "task-current").blockingCondition, null);
    assert.equal(JSON.stringify(packet).includes("PRIVATE-DIAGNOSTIC"), false);
  });
  for (const ledgerStatus of ["in_progress", "blocked\nSECRET-STATUS", {}]) {
    await t.test(`invalid ledger status ${JSON.stringify(ledgerStatus)}`, async () => {
      const fixture = rootOrchestratorFixture();
      fixture.snapshot.taskStates.find(({ taskId }) => taskId === "task-current").ledgerStatus = ledgerStatus;
      await assert.rejects(assemble(fixture, { roleId: "orchestrator" }), { code: "ROLE_CONTEXT_INVALID" });
    });
  }
});

test("root coordination excludes bounded superseded-Head history", async () => {
  const fixture = rootOrchestratorFixture();
  const historicalCount = 3 * 64;
  for (let index = 0; index < historicalCount; index += 1) {
    const taskId = `task-superseded-${String(index).padStart(3, "0")}`;
    fixture.snapshot.graph.tasks.push(task({
      taskId,
      revision: 1,
      status: "superseded",
      roleId: "developer",
      parentTaskId: "task-root",
    }));
    fixture.snapshot.taskStates.push(state(
      taskId,
      1,
      `OLD-HEAD-SECRET-${String(index).padStart(3, "0")}`,
    ));
  }

  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const coordination = packet.context.requirements.coordination;

  assert.equal(coordination.history.supersededChildCount, historicalCount);
  assert.equal(coordination.directChildren.length, 5);
  assert.equal(
    coordination.directChildren.some(({ status }) => status === "superseded"),
    false,
  );
  assert.equal(JSON.stringify(packet).includes("OLD-HEAD-SECRET"), false);
  assert.equal(
    Buffer.byteLength(JSON.stringify(packet.context), "utf8") < 128 * 1_024,
    true,
  );
});

test("root coordination fails closed for stale child state and bad delivery pairing", async () => {
  const stale = rootOrchestratorFixture();
  stale.snapshot.taskStates.find(
    ({ taskId }) => taskId === "task-tester",
  ).taskRevision -= 1;
  await assert.rejects(
    assemble(stale, { roleId: "orchestrator" }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_STALE",
  );

  const invalidPair = rootOrchestratorFixture();
  invalidPair.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-requirements",
  ).deliveries[2].status = "rejected";
  await assert.rejects(
    assemble(invalidPair, { roleId: "orchestrator" }),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_CHILD_DELIVERY_INVALID",
  );
});

test("root coordination exposes one deterministic submitted-delivery window", async () => {
  const fixture = rootOrchestratorFixture();
  const tester = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-tester",
  );
  tester.deliveries[3].status = "submitted";
  tester.deliveries[3].summary = "SECOND-PENDING-SUBMISSION";
  const current = fixture.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-current",
  );
  current.acceptanceContracts[0].expectedDeliverables = Array.from(
    { length: 5 },
    (_, index) => expected(`delivery-${index}`, "change-package"),
  );
  fixture.snapshot.taskStates.find(
    ({ taskId }) => taskId === "task-current",
  ).work.description = "界".repeat(1_000);

  const packet = await assemble(fixture, { roleId: "orchestrator" });
  const coordination = packet.context.requirements.coordination;
  const projectedCurrent = coordination.directChildren.find(
    ({ taskId }) => taskId === "task-current",
  );

  assert.deepEqual(coordination.deliveryWindow, {
    pendingCount: 2,
    shownCount: 1,
    hasMore: true,
  });
  assert.deepEqual(
    packet.context.code.childDeliveries.map(({ taskId, deliverableId }) => [
      taskId,
      deliverableId,
    ]),
    [["task-implementation", "pending-review"]],
  );
  assert.equal(
    JSON.stringify(packet).includes("SECOND-PENDING-SUBMISSION"),
    false,
  );
  assert.equal(projectedCurrent.deliverableCount, 5);
  assert.equal(projectedCurrent.hasMoreDeliverables, true);
  assert.equal(projectedCurrent.deliverables.length, 4);
  assert.equal(
    Buffer.byteLength(projectedCurrent.work.description, "utf8") <= 512,
    true,
  );
});

test("root coordination derives accepted required Review proof from every slot before previewing four", async (t) => {
  for (const variant of ["accepted", "optional", "submitted", "none", "local-only"]) await t.test(variant, async () => {
    const fixture = rootOrchestratorFixture();
    const current = fixture.snapshot.graph.tasks.find(({ taskId }) => taskId === "task-current");
    current.acceptanceContracts = [contract(1, [
      ...Array.from({ length: 4 }, (_, index) => expected(`aa-support-${index}`, "text-report")),
      expected("zz-review", variant === "local-only" ? "text-report" : "github-review", variant !== "optional"),
    ])];
    current.deliveries = [];
    for (let index = 0; index < 4; index++) current.deliveries.push(...acceptedPair({
      deliverableId: `aa-support-${index}`, contractRevision: 1, submittedRevision: index * 2 + 1,
      submittedSummary: "Local support", acceptanceReason: "Support accepted",
      records: [evidence("artifact", `support:${index}`, DIGEST_A)] }));
    if (variant !== "none") {
      const pair = acceptedPair({ deliverableId: "zz-review", contractRevision: 1, submittedRevision: 9,
        submittedSummary: "Review receipt", acceptanceReason: "Review accepted",
        records: [evidence(variant === "local-only" ? "artifact" : "github-review", "review:42", DIGEST_A)] });
      current.deliveries.push(...(variant === "submitted" ? pair.slice(0, 1) : pair));
    }
    current.revision = 10;
    fixture.snapshot.taskStates.find(({ taskId }) => taskId === current.taskId).taskRevision = 10;
    const packet = await assemble(fixture, { roleId: "orchestrator" });
    const projected = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === current.taskId);
    assert.equal(projected.deliverables.length, 4);
    assert.equal(projected.hasMoreDeliverables, true);
    assert.equal(projected.deliverables.every(({ kind }) => kind === "text-report"), true);
    assert.equal(projected.hasAcceptedRequiredReview, variant === "accepted");
  });
});

test("root coordination is canonical, digest-bound, detached, and root-only", async () => {
  const fixture = rootOrchestratorFixture();
  const first = await assemble(fixture, { roleId: "orchestrator" });
  const reordered = structuredClone(fixture);
  reordered.snapshot.graph.tasks.reverse();
  reordered.snapshot.taskStates.reverse();
  for (const child of reordered.snapshot.graph.tasks) {
    child.dependsOn.reverse();
    child.deliveries.reverse();
    child.deliveries.forEach((record) => record.evidence.reverse());
    child.acceptanceContracts.reverse();
    for (const childContract of child.acceptanceContracts) {
      childContract.acceptanceCriteria.reverse();
      childContract.expectedDeliverables.reverse();
    }
  }
  const second = await assemble(reordered, { roleId: "orchestrator" });
  assert.equal(second.contextDigest, first.contextDigest);

  const changed = rootOrchestratorFixture();
  changed.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-tester",
  ).status = "pending";
  const changedPacket = await assemble(changed, { roleId: "orchestrator" });
  assert.notEqual(changedPacket.contextDigest, first.contextDigest);

  const changedSummary = rootOrchestratorFixture();
  changedSummary.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-implementation",
  ).deliveries[4].summary = "different pending review evidence";
  assert.notEqual(
    (await assemble(changedSummary, { roleId: "orchestrator" })).contextDigest,
    first.contextDigest,
  );

  const changedEvidence = rootOrchestratorFixture();
  const pendingDeliveries = changedEvidence.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-implementation",
  ).deliveries;
  pendingDeliveries[4].evidence[0].contentDigest = DIGEST_B;
  assert.notEqual(
    (await assemble(changedEvidence, { roleId: "orchestrator" })).contextDigest,
    first.contextDigest,
  );

  fixture.snapshot.taskStates.find(
    ({ taskId }) => taskId === "task-tester",
  ).work.title = "caller mutated later";
  assert.equal(
    first.context.requirements.coordination.directChildren.find(
      ({ taskId }) => taskId === "task-tester",
    ).work.title,
    "task-tester",
  );

  const nonRoot = graphFixture();
  const inspected = await assemble(nonRoot, { roleId: "orchestrator" });
  assert.equal(inspected.context.requirements.coordination, undefined);
  assert.equal(inspected.context.requirements.childDeliveries, undefined);

  const wrongRootRole = rootOrchestratorFixture();
  wrongRootRole.snapshot.graph.tasks.find(
    ({ taskId }) => taskId === "task-root",
  ).responsibility.id = "requirements-analyst";
  wrongRootRole.item.currentTarget.id = "requirements-analyst";
  const unconfigured = await assemble(wrongRootRole, { roleId: "orchestrator" });
  assert.equal(unconfigured.context.requirements.coordination, undefined);
  assert.equal(unconfigured.context.requirements.childDeliveries, undefined);
});

test("contextDigest is canonical, binds the role and revisions, and detaches from caller mutation", async () => {
  const fixture = graphFixture();
  const first = await assemble(fixture);
  const reordered = structuredClone(fixture);
  reordered.snapshot.graph.tasks.reverse();
  reordered.snapshot.taskStates.reverse();
  reordered.snapshot.graph.tasks.forEach((entry) => {
    entry.deliveries.reverse();
    entry.acceptanceContracts.forEach((entryContract) => {
      entryContract.acceptanceCriteria.reverse();
      entryContract.expectedDeliverables.reverse();
    });
  });
  const second = await assemble(reordered);

  assert.equal(second.contextDigest, first.contextDigest);

  const changedRole = new RoleContextAssembler({
    graphReader: reader(fixture.snapshot),
  });
  fixture.snapshot.graph.tasks.find(({ taskId }) => taskId === "task-current")
    .responsibility.id = "tester";
  fixture.item.currentTarget.id = "tester";
  const tester = await changedRole.assemble({
    roleId: "tester",
    item: fixture.item,
    trigger: "employee:developer",
  });
  assert.notEqual(tester.contextDigest, first.contextDigest);

  fixture.item.decisionContext.answer = "caller mutated later";
  assert.equal(first.context.requirements.decisionContext.answer, "keep the accepted scope");
});

test("classifies proposal decision context as code instead of requirements", async () => {
  const fixture = graphFixture();
  fixture.item.decisionContext = {
    source: "proposal",
    referenceId: "proposal-code-1",
    outcome: "succeeded",
    value: {
      kind: "code_action_proposal",
      summary: "CODE-ONLY-PROPOSAL-RESULT",
    },
    observedAt: "2026-08-03T05:00:00.000Z",
    contentDigest: DIGEST_A,
  };

  const packet = await assemble(fixture);

  assert.equal(packet.context.requirements.decisionContext, undefined);
  assert.equal(
    packet.context.code.decisionContext.value.summary,
    "CODE-ONLY-PROPOSAL-RESULT",
  );
});

test("a failed PR repair includes its execution failure and explicit retry context", async () => {
  const fixture = graphFixture({ pullRequest: true });
  const event = pullRequestEvent("a".repeat(40), "2026-08-03T04:00:00.000Z");
  const { source } = createPullRequestWorkSource(pullRequestAssignment(1, event));
  fixture.item = {
    ...fixture.item, event, source, inputDigest: source.current.inputDigest,
    decisionContext: {
      source: "proposal", outcome: "failed", referenceId: "proposal-failed",
      value: { kind: "code_action_proposal", evidence: ["code-job:previous-job"] },
      observedAt: "2026-08-03T04:30:00.000Z", contentDigest: DIGEST_A,
    },
  };
  const failedExecution = {
    jobId: "previous-job", failureCode: "GIT_SNAPSHOT_TIMEOUT",
    ownerRetry: { at: "2026-08-03T04:45:00.000Z", note: "Snapshot repair verified; retry." },
  };
  const calls = [];
  const packet = await assemble(fixture, {
    failedCodeJobContextReader: { async read(input) {
      calls.push(input);
      return failedExecution;
    } },
  });
  assert.deepEqual(packet.context.code.failedExecution, failedExecution);
  assert.equal(packet.context.requirements.failedExecution, undefined);
  assert.equal(calls[0].inputBinding.headRefOid, "a".repeat(40));
  assert.equal(calls[0].itemId, fixture.item.itemId);
  failedExecution.failureCode = "MUTATED";
  assert.equal(packet.context.code.failedExecution.failureCode, "GIT_SNAPSHOT_TIMEOUT");
});

test("rejects a context larger than 128 KiB without truncating it", async () => {
  const fixture = graphFixture({ pullRequest: true });
  fixture.item.event.payload.large = "x".repeat(128 * 1_024);

  await assert.rejects(
    assemble(fixture),
    (error) =>
      error instanceof RoleContextAssemblerError &&
      error.code === "ROLE_CONTEXT_TOO_LARGE" &&
      error.statusCode === 413,
  );
});

test("constructor rejects accessor ports without invoking them", () => {
  for (const [portName, method] of [
    ["graphReader", "getSnapshot"],
    ["factSource", "read"],
    ["pullRequestContextReader", "read"],
    ["evidenceCatalog", "listForTask"],
  ]) {
    let getterCalls = 0;
    const accessorPort = {};
    Object.defineProperty(accessorPort, method, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => {};
      },
    });
    const options = {
      graphReader: reader(graphFixture().snapshot),
      ...(portName === "factSource" ? { factSource: accessorPort } : {}),
      ...(portName === "pullRequestContextReader"
        ? { pullRequestContextReader: accessorPort }
        : {}),
      ...(portName === "graphReader" ? { graphReader: accessorPort } : {}),
      ...(portName === "evidenceCatalog"
        ? { evidenceCatalog: accessorPort }
        : {}),
    };

    assert.throws(
      () => new RoleContextAssembler(options),
      new RegExp(`${portName} is invalid`),
    );
    assert.equal(getterCalls, 0);
  }
});

test("root coordination derives owner goal controls without treating payload claims or inherited child events as ownership", async () => {
  const request = { schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111", workType: "general", priority: "high",
    title: "Continue the goal", description: "Replace child plans while retaining the owner goal.", acceptanceCriteria: ["Verified delivery"] };
  for (const kind of ["work", "issue"]) {
    const fixture = rootOrchestratorFixture();
    fixture.item.event = kind === "work" ? createOwnerWorkRequestEvent(request, "2026-08-03T00:00:00.000Z") :
      createOwnerIssueEvent({ ...request, schemaVersion: 6, issue: { repository: "octo/repo", number: 42 } }, "2026-08-03T00:00:00.000Z");
    const packet = await assemble(fixture, { roleId: "orchestrator" });
    const coordination = packet.context.requirements.coordination;
    assert.deepEqual(coordination.goalControl, { rootTaskId: fixture.item.itemId, owner: "local-owner",
      cancellableTaskIds: coordination.directChildren.map(child => child.taskId).sort() });
    assert.equal(coordination.goalControl.cancellableTaskIds.includes(fixture.item.itemId), false);
  }
  const nonOwner = rootOrchestratorFixture();
  nonOwner.item.event.payload.goalControl = { owner: "local-owner" };
  assert.equal((await assemble(nonOwner, { roleId: "orchestrator" })).context.requirements.coordination.goalControl, undefined);
  const child = graphFixture();
  child.item.event = createOwnerWorkRequestEvent(request, "2026-08-03T00:00:00.000Z");
  assert.equal((await assemble(child)).context.requirements.coordination, undefined);
});

test('root coordination exposes a settled proposal failure without inferring an unstarted or safe-to-retry job', async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === 'task-current');
  state.ledgerStatus = 'blocked'; state.statusReason = 'proposal_failed';
  state.proposalFailure = { code: 'CODE_ACTION_PROPOSAL_FAILED', stage: 'proposal', taskRevision: state.taskRevision,
    timelineId: `work-timeline-${'a'.repeat(64)}`, timelineDigest: 'a'.repeat(64), recordedAt: '2026-08-03T07:00:00.000Z' };
  state.rawError = 'PRIVATE-EXECUTION-TRACE';
  const packet = await assemble(fixture, { roleId: 'orchestrator' });
  const visible = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(visible.blockingCondition, 'CODE_ACTION_PROPOSAL_FAILED');
  assert.deepEqual(visible.proposalFailure, state.proposalFailure);
  assert.equal(Object.hasOwn(visible.proposalFailure, 'downstreamCreated'), false);
  assert.equal(JSON.stringify(packet).includes('PRIVATE-EXECUTION-TRACE'), false);
  state.proposalFailure.taskRevision++;
  await assert.rejects(assemble(fixture, { roleId: 'orchestrator' }), error => error.code === 'ROLE_CONTEXT_INVALID');
});

test('root coordination exposes a retained decision rejection without claiming a delivery or granting a retry', async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === 'task-current');
  state.ledgerStatus = 'blocked'; state.statusReason = 'decision_attempts_exhausted';
  state.decisionFailure = { code: 'ROLE_DECISION_PR_REVIEW_REQUIRED', stage: 'decision', taskRevision: state.taskRevision,
    timelineId: `work-timeline-${'a'.repeat(64)}`, timelineDigest: 'a'.repeat(64), recordedAt: '2026-08-03T07:00:00.000Z' };
  state.rawError = 'PRIVATE-DECISION-TRACE';
  const packet = await assemble(fixture, { roleId: 'orchestrator' });
  const visible = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(visible.blockingCondition, 'ROLE_DECISION_PR_REVIEW_REQUIRED');
  assert.deepEqual(visible.decisionFailure, state.decisionFailure);
  assert.equal(Object.hasOwn(visible.decisionFailure, 'downstreamCreated'), false);
  assert.equal(JSON.stringify(packet).includes('PRIVATE-DECISION-TRACE'), false);
});

for (const variant of ['revision', 'stage', 'code', 'timeline', 'timestamp', 'extra-field', 'accessor']) {
  test(`decision diagnostic context rejects an invalid ${variant}`, async () => {
    const fixture = rootOrchestratorFixture();
    const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === 'task-current');
    state.ledgerStatus = 'blocked'; state.statusReason = 'decision_attempts_exhausted';
    const failure = { code: 'ROLE_DECISION_PR_REVIEW_REQUIRED', stage: 'decision', taskRevision: state.taskRevision,
      timelineId: `work-timeline-${'a'.repeat(64)}`, timelineDigest: 'a'.repeat(64), recordedAt: '2026-08-03T07:00:00.000Z' };
    let reads = 0;
    if (variant === 'revision') failure.taskRevision++;
    if (variant === 'stage') failure.stage = 'delivery';
    if (variant === 'code') failure.code = { toString: 'not-code' };
    if (variant === 'timeline') failure.timelineId = `work-timeline-${'b'.repeat(64)}`;
    if (variant === 'timestamp') failure.recordedAt = 'not-a-timestamp';
    if (variant === 'extra-field') failure.downstreamCreated = false;
    if (variant === 'accessor') Object.defineProperty(failure, 'code', { enumerable: true, get() { reads++; return 'ROLE_DECISION_PR_REVIEW_REQUIRED'; } });
    state.decisionFailure = failure;
    const run = variant === 'accessor' ? new RoleContextAssembler({ graphReader: { async getSnapshot() {
      return { ...fixture.snapshot, graph: createWorkGraphSnapshot({ graphId: fixture.snapshot.graph.graphId,
        revision: fixture.snapshot.graph.revision, tasks: fixture.snapshot.graph.tasks }) };
    } } }).assemble({ roleId: 'orchestrator', item: fixture.item, trigger: 'employee:orchestrator' })
      : assemble(fixture, { roleId: 'orchestrator' });
    await assert.rejects(run, error => error.code === 'ROLE_CONTEXT_INVALID');
    assert.equal(reads, 0);
  });
}

test('root coordination exposes the retained delivery failure without presenting it as an unstarted proposal', async () => {
  const fixture = rootOrchestratorFixture();
  const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === 'task-current');
  state.ledgerStatus = 'blocked'; state.statusReason = 'delivery_attempts_exhausted';
  state.deliveryFailure = { code: 'ORCHESTRATOR_EVIDENCE_REJECTED', stage: 'delivery', taskRevision: state.taskRevision,
    timelineId: `work-timeline-${'a'.repeat(64)}`, timelineDigest: 'a'.repeat(64), recordedAt: '2026-08-03T07:00:00.000Z' };
  state.rawError = 'PRIVATE-HOST-TRACE';
  const packet = await assemble(fixture, { roleId: 'orchestrator' });
  const visible = packet.context.requirements.coordination.directChildren.find(({ taskId }) => taskId === state.taskId);
  assert.equal(visible.blockingCondition, 'ORCHESTRATOR_EVIDENCE_REJECTED');
  assert.deepEqual(visible.deliveryFailure, state.deliveryFailure);
  assert.equal(Object.hasOwn(visible.deliveryFailure, 'downstreamCreated'), false);
  assert.equal(JSON.stringify(packet).includes('PRIVATE-HOST-TRACE'), false);
});

for (const variant of ['revision', 'stage', 'code', 'timeline', 'timestamp', 'extra-field', 'accessor']) {
  test(`delivery diagnostic context rejects an invalid ${variant}`, async () => {
    const fixture = rootOrchestratorFixture();
    const state = fixture.snapshot.taskStates.find(({ taskId }) => taskId === 'task-current');
    state.ledgerStatus = 'blocked'; state.statusReason = 'delivery_attempts_exhausted';
    const failure = { code: 'ORCHESTRATOR_EVIDENCE_REJECTED', stage: 'delivery', taskRevision: state.taskRevision,
      timelineId: `work-timeline-${'a'.repeat(64)}`, timelineDigest: 'a'.repeat(64), recordedAt: '2026-08-03T07:00:00.000Z' };
    let reads = 0;
    if (variant === 'revision') failure.taskRevision++;
    if (variant === 'stage') failure.stage = 'dispatch';
    if (variant === 'code') failure.code = { toString: 'not-code' };
    if (variant === 'timeline') failure.timelineId = `work-timeline-${'b'.repeat(64)}`;
    if (variant === 'timestamp') failure.recordedAt = 'not-a-timestamp';
    if (variant === 'extra-field') failure.downstreamCreated = false;
    if (variant === 'accessor') Object.defineProperty(failure, 'code', { enumerable: true, get() { reads++; return 'ORCHESTRATOR_EVIDENCE_REJECTED'; } });
    state.deliveryFailure = failure;
    const run = variant === 'accessor' ? new RoleContextAssembler({ graphReader: { async getSnapshot() {
      return { ...fixture.snapshot, graph: createWorkGraphSnapshot({ graphId: fixture.snapshot.graph.graphId,
        revision: fixture.snapshot.graph.revision, tasks: fixture.snapshot.graph.tasks }) };
    } } }).assemble({ roleId: 'orchestrator', item: fixture.item, trigger: 'employee:orchestrator' })
      : assemble(fixture, { roleId: 'orchestrator' });
    await assert.rejects(run, error => error.code === 'ROLE_CONTEXT_INVALID');
    assert.equal(reads, 0);
  });
}


test("development receives conflict materials after a typed internal repair handoff without nextAction", async () => {
  const { fixture: f } = atomicPullRequestFixture();
  const { eventId, contentDigest, ...old } = f.item.event;
  const event = normalizeWorkflowEvent({ ...old, eventType: "pull_request.internal_review_requested",
    source: { provider: "internal-review-repair", scopeId: "internal-review:123e4567-e89b-42d3-a456-426614174000" },
    payload: { ...old.payload, workType: "pull_request", state: "open",
      internalReview: { kind: "own_pr_ci_repair", headRefOid: old.payload.headRefOid,
        feedbackDigest: "c".repeat(64), publicationConfirmationId: "prior-publication", controlledCommitEvidenceId: "prior-commit" } } });
  const source = createPullRequestWorkSource(pullRequestAssignment(1, event)).source;
  f.item = { ...f.item, currentTarget: { type: "role", id: "developer" }, event, source, inputDigest: source.current.inputDigest };
  f.snapshot.graph.tasks.find(t => t.taskId === f.item.itemId).responsibility.id = "developer";
  let calls = 0;
  await assert.rejects(assemble(f, { conflictInspectionReader: { async read() { calls++; throw new Error("sealed material unavailable"); } } }),
    { code: "ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("owner CI development receives sealed conflict material with the original fix_ci action", async () => {
  const { fixture: f, gitTarget } = atomicPullRequestFixture();
  const { eventId, contentDigest, ...old } = f.item.event;
  const event = normalizeWorkflowEvent({ ...old, eventType: "pull_request.owner_requested",
    source: { provider: "local-owner", scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000" },
    payload: { ...old.payload, workType: "general", nextAction: "fix_ci", suggestedCapability: "development",
      expectedHeadRefOid: gitTarget.headRefOid } });
  const source = createPullRequestWorkSource(pullRequestAssignment(1, event)).source;
  f.item = { ...f.item, currentTarget: { type: "role", id: "developer" }, event, source, inputDigest: source.current.inputDigest };
  f.snapshot.graph.tasks.find(t => t.taskId === f.item.itemId).responsibility.id = "developer";
  const inputBinding = createPullRequestExecutionBinding({ sourceBinding: currentWorkItemInputBinding(f.item), event });
  const preparationBinding = createConflictPreparationBinding({ gitTarget, preparation: {
    schemaVersion: 1, preparationId: DIGEST_A, status: "conflicted",
    baseCommitOid: gitTarget.baseRefOid, headCommitOid: gitTarget.headRefOid,
    mergeBaseOid: "c".repeat(40), resultTreeOid: "d".repeat(40),
    conflicts: [{ path: "src/review.js", mode: "100644" }], boundaryDigest: DIGEST_B,
    evidenceDigest: DIGEST_C, resultObjectDigest: DIGEST_D, materialization: "full-tree",
  } });
  const inspection = { inputBinding, preparationBinding, files: [{ path: "src/review.js", content: "sealed conflict bytes" }] };
  let calls = 0;
  let material = inspection;
  const options = { conflictInspectionReader: { async read(input) {
    calls++;
    assert.deepEqual(input, { itemId: f.item.itemId, itemRevision: f.item.revision, inputDigest: f.item.inputDigest });
    if (material instanceof Error) throw material;
    return material;
  } } };
  const packet = await assemble(f, options);
  assert.equal(calls, 1);
  assert.deepEqual(packet.context.code.conflictInspection, inspection);
  assert.equal(packet.context.code.sourceEvent.payload.nextAction, "fix_ci");
  material = null;
  assert.equal((await assemble(f, options)).context.code.conflictInspection, undefined);
  material = new Error("sealed material unavailable");
  await assert.rejects(assemble(f, options), { code: "ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE" });
  material = { ...inspection, inputBinding: { ...inputBinding, headRefOid: "e".repeat(40) } };
  await assert.rejects(assemble(f, options), { code: "ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE" });
  material = { ...inspection, preparationBinding: { ...preparationBinding,
    gitTarget: { ...gitTarget, baseRefOid: "e".repeat(40) } } };
  await assert.rejects(assemble(f, options), { code: "ROLE_CONTEXT_CONFLICT_INSPECTION_UNAVAILABLE" });
  const sourceBinding = currentWorkItemInputBinding(f.item);
  f.item = { ...f.item, kind: "graph_task", source: null, assignment: { graphTask: { sourceBinding } } };
  material = inspection;
  assert.deepEqual((await assemble(f, options)).context.code.conflictInspection, inspection);
  assert.equal(calls, 6);
});

test("owner CI conflict materials remain limited to development and exact repair provenance", async (t) => {
  for (const variant of ["other-role", "other-action", "other-capability", "stale-head", "other-relation"]) {
    await t.test(variant, async () => {
      const { fixture: f, gitTarget } = atomicPullRequestFixture();
      const { eventId, contentDigest, ...old } = f.item.event;
      const payload = { ...old.payload, workType: "general", nextAction: "fix_ci", suggestedCapability: "development",
        expectedHeadRefOid: gitTarget.headRefOid };
      if (variant === "other-action") payload.nextAction = "address_review";
      if (variant === "other-capability") payload.suggestedCapability = "pr-review";
      if (variant === "stale-head") payload.expectedHeadRefOid = "e".repeat(40);
      if (variant === "other-relation") payload.relation = "assigned";
      const rawEvent = { ...old, eventType: "pull_request.owner_requested",
        source: { provider: "local-owner", scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000" }, payload };
      if (variant === "stale-head") {
        assert.throws(() => normalizeWorkflowEvent(rawEvent), { code: "INVALID_WORKFLOW_EVENT" });
        return;
      }
      const event = normalizeWorkflowEvent(rawEvent);
      const source = createPullRequestWorkSource(pullRequestAssignment(1, event)).source;
      const roleId = variant === "other-role" ? "pr-engineer" : "developer";
      f.item = { ...f.item, currentTarget: { type: "role", id: roleId }, event, source, inputDigest: source.current.inputDigest };
      f.snapshot.graph.tasks.find(task => task.taskId === f.item.itemId).responsibility.id = roleId;
      let calls = 0;
      await assemble(f, { roleId, conflictInspectionReader: { async read() { calls++; throw new Error("must not read"); } } });
      assert.equal(calls, 0);
    });
  }
});
