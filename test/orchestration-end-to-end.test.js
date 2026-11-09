import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerWorkRequestEvent } from "../src/domain/owner-work-request.js";
import { OrchestratorService } from "../src/services/orchestrator-service.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { WorkGraphStore } from "../src/services/work-graph-store.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";

const NOW = "2026-08-03T08:00:00.000Z";
const CHANGE_PACKAGE_EVIDENCE = Object.freeze({
  kind: "change-package",
  referenceId: "change-package:fixture:implementation",
  contentDigest: "1".repeat(64),
});
const FAILED_TEST_EVIDENCE = Object.freeze({
  kind: "test-report",
  referenceId: "test-report:fixture:failed",
  contentDigest: "2".repeat(64),
});
const PASSED_TEST_EVIDENCE = Object.freeze({
  kind: "test-report",
  referenceId: "test-report:fixture:passed",
  contentDigest: "3".repeat(64),
});

class MemoryStore {
  values = new Map();

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

class ExclusiveLease {
  tail = Promise.resolve();

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

class AssignmentSource {
  constructor(record) {
    this.record = record;
  }

  async readAssignmentBatch({ afterSequence }) {
    const items = afterSequence < 1 ? [structuredClone(this.record)] : [];
    return {
      items,
      nextSequence: items.length ? 1 : afterSequence,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    };
  }
}

class RoleDirectory {
  constructor(workers) {
    this.workers = new Map(workers.map((worker) => [worker.roleId, worker]));
  }

  async resolve(target) {
    return this.workers.get(target.id) ?? null;
  }
}

function worker(roleId, decide, workerId = `employee-${roleId}`) {
  return {
    roleId,
    workerId,
    enabled: true,
    paused: false,
    decide,
  };
}

function decision(intent, summary) {
  return {
    schemaVersion: 1,
    confidence: 95,
    summary,
    intent,
  };
}

function orchestrationIntent(context, action, summary) {
  return decision({
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  }, summary);
}

function actionBase(context, source, type, reason) {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.taskRevision ?? source.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    reason,
  };
}

function acceptanceContract(deliverableId, kind, description) {
  return {
    revision: 1,
    acceptanceCriteria: [
      {
        criterionId: "verified",
        description: "交付内容与证据满足当前任务约定",
      },
    ],
    expectedDeliverables: [
      { deliverableId, kind, description, required: true },
    ],
  };
}

function decompose(context, { childKey, title, capability, dependsOn, contract }) {
  const current = context.requirements.currentTask;
  const reason = `创建 ${title} 岗位任务`;
  return orchestrationIntent(
    context,
    {
      ...actionBase(context, current, "decompose", reason),
      childKey,
      work: { title, description: `${title} 围绕共享任务树交付结果。` },
      capability,
      dependsOn: dependsOn.map(({ taskId, taskRevision }) => ({
        taskId,
        revision: taskRevision,
      })),
      acceptanceContract: contract,
    },
    reason,
  );
}

function decideDelivery(context, child, type, summary) {
  const delivery = child.deliverables.find(({ state }) => state === "submitted");
  const reason = type === "accept_delivery"
    ? "交付满足验收契约"
    : "测试结果需要返工后重新提交";
  return orchestrationIntent(
    context,
    {
      ...actionBase(context, child, type, reason),
      submittedDeliveryRevision: delivery.submittedDeliveryRevision,
    },
    summary,
  );
}

function completeRoot() {
  return decision({
    schemaVersion: 1,
    type: "complete",
    summary: "需求、开发和测试交付均已验收",
    reason: "共享任务树中的所有直属任务均已完成",
    outcome: "done",
    evidence: [],
  }, "根任务可以完成");
}

function childByTitle(context, title) {
  return context.requirements.coordination.directChildren.find(
    ({ work }) => work.title === title,
  );
}

function orchestratorDecision({ context }) {
  const requirements = childByTitle(context, "Requirements");
  const development = childByTitle(context, "Development");
  const testing = childByTitle(context, "Testing");

  if (!requirements) {
    return decompose(context, {
      childKey: "requirements",
      title: "Requirements",
      capability: "requirements",
      dependsOn: [],
      contract: acceptanceContract(
        "requirement-spec",
        "requirement-spec",
        "可追溯的需求规格",
      ),
    });
  }
  if (requirements.deliverables[0].state === "submitted") {
    return decideDelivery(
      context,
      requirements,
      "accept_delivery",
      "接受需求规格",
    );
  }
  if (requirements.status === "completed" && !development) {
    return decompose(context, {
      childKey: "development",
      title: "Development",
      capability: "development",
      dependsOn: [requirements],
      contract: acceptanceContract(
        "implementation",
        "change-package",
        "受控实现变更",
      ),
    });
  }
  if (development?.deliverables[0].state === "submitted") {
    return decideDelivery(
      context,
      development,
      "accept_delivery",
      "接受开发交付",
    );
  }
  if (development?.status === "completed" && !testing) {
    return decompose(context, {
      childKey: "testing",
      title: "Testing",
      capability: "testing",
      dependsOn: [development],
      contract: acceptanceContract(
        "test-report",
        "test-report",
        "自动化测试报告",
      ),
    });
  }
  if (testing?.deliverables[0].state === "submitted") {
    const submitted = context.code.childDeliveries.find(
      ({ taskId, state }) => taskId === testing.taskId && state === "submitted",
    );
    const failed = submitted.evidence.some(
      ({ referenceId }) => referenceId === FAILED_TEST_EVIDENCE.referenceId,
    );
    return decideDelivery(
      context,
      testing,
      failed ? "return_delivery" : "accept_delivery",
      failed ? "退回失败测试" : "接受返工后的测试报告",
    );
  }
  if (
    [requirements, development, testing].every(
      ({ status }) => status === "completed",
    )
  ) {
    return completeRoot();
  }
  throw new Error("orchestrator fixture reached an unexpected graph state");
}

function submitDelivery({ context, item }, {
  deliverableId,
  artifact = null,
  summary,
  evidence = [],
}) {
  const current = context.requirements.currentTask;
  return decision({
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: current.taskId,
    expectedTaskRevision: current.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    contractRevision: current.acceptanceContract.revision,
    deliverableId,
    summary,
    reason: "完成当前岗位交付",
    evidence,
    artifact,
  }, `${item.itemId} 提交 ${deliverableId}`);
}

function requirementDraft() {
  return {
    title: "多岗位共享交付流程",
    problem: "多个岗位必须在同一任务树中传递经过验收的输入。",
    requirements: ["开发只读取已验收规格", "测试只读取已验收实现"],
    acceptanceCriteria: ["测试失败可退回返工", "最终根任务可完成"],
    openQuestions: [],
  };
}

async function fixture({
  testingEvidence = [FAILED_TEST_EVIDENCE, PASSED_TEST_EVIDENCE],
  ownerGoal = false,
} = {}) {
  const event = ownerGoal ? createOwnerWorkRequestEvent({ schemaVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111", workType: "general", priority: "high",
    title: "Continue the owner goal", description: "Retain the goal while repairing its execution plan.", acceptanceCriteria: ["Verified delivery"],
  }, NOW) : normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: NOW,
    source: { provider: "github", scopeId: "command-center" },
    subject: { id: "issue-901", repository: "acme/dashboard", number: 901 },
    payload: { number: 901, title: "Build one shared delivery loop" },
  });
  const source = new AssignmentSource({
    sequence: 1,
    assignment: {
      assignmentId: "assignment-shared-loop",
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "coordinate_delivery",
    },
    event,
  });
  let nextLease = 1;
  const ledger = new WorkLedgerService({
    store: new MemoryStore(),
    assignmentSource: source,
    exclusiveLease: new ExclusiveLease(),
    clock: () => NOW,
    idFactory: () => `lease-${nextLease++}`,
  });
  await ledger.recover();
  const graph = new WorkGraphStore({ ledger });
  const graphReader = graph.reader();
  const contextAssembler = new RoleContextAssembler({ graphReader });
  const orchestratorService = new OrchestratorService({
    contextAssembler,
    graphReader,
    scopedGraphPlannerFactory: {
      forRoot({ scopeRootTaskId }) {
        return graph.planner({
          principalId: "employee-orchestrator",
          scopeRootTaskId,
        });
      },
    },
    graphDelivererFactory: {
      forClaim({ scopeRootTaskId, taskId, workerId, leaseId }) {
        return graph.deliverer({
          principalId: workerId,
          scopeRootTaskId,
          taskId,
          leaseId,
        });
      },
    },
    capabilityRoles: {
      requirements: "requirements-analyst",
      development: "developer",
      testing: "tester",
    },
    clock: () => NOW,
    evidenceVerifier: {
      async verify(input) {
        const { signal, ...auditInput } = input;
        assert.equal(signal instanceof AbortSignal, true);
        verifiedEvidence.push(structuredClone(auditInput));
        const expected = authoritativeEvidence.get(input.evidence.referenceId);
        return expected?.deliverableId === input.deliverableId &&
            isDeepStrictEqual(expected.evidence, input.evidence)
          ? structuredClone(input.evidence)
          : false;
      },
    },
  });
  let testingAttempts = 0;
  let developerContext = null;
  const testingContexts = [];
  const verifiedEvidence = [];
  const authoritativeEvidence = new Map([
    [CHANGE_PACKAGE_EVIDENCE.referenceId, {
      deliverableId: "implementation",
      evidence: CHANGE_PACKAGE_EVIDENCE,
    }],
    [FAILED_TEST_EVIDENCE.referenceId, {
      deliverableId: "test-report",
      evidence: FAILED_TEST_EVIDENCE,
    }],
    [PASSED_TEST_EVIDENCE.referenceId, {
      deliverableId: "test-report",
      evidence: PASSED_TEST_EVIDENCE,
    }],
  ]);
  const workers = [
    worker(
      "orchestrator",
      orchestratorDecision,
      "employee-orchestrator",
    ),
    worker("requirements-analyst", (input) => submitDelivery(input, {
      deliverableId: "requirement-spec",
      artifact: requirementDraft(),
      summary: "需求规格完成",
    })),
    worker("developer", (input) => {
      developerContext = structuredClone(input.context);
      return submitDelivery(input, {
        deliverableId: "implementation",
        summary: "实现完成并通过开发验证",
        evidence: [CHANGE_PACKAGE_EVIDENCE],
      });
    }),
    worker("tester", (input) => {
      testingAttempts += 1;
      testingContexts.push(structuredClone(input.context));
      const evidence = testingEvidence.at(
        Math.min(testingAttempts - 1, testingEvidence.length - 1),
      );
      const passed = evidence.referenceId === PASSED_TEST_EVIDENCE.referenceId;
      return submitDelivery(input, {
        deliverableId: "test-report",
        summary: passed
          ? "全部测试通过"
          : "测试失败：边界场景未通过",
        evidence: [evidence],
      });
    }),
  ];
  const loop = new ProactiveWorkLoop({
    ledger,
    roleDirectory: new RoleDirectory(workers),
    roleContextAssembler: contextAssembler,
    orchestratorService,
    clock: () => NOW,
    leaseDurationMs: 120_000,
    resolveTimeoutMs: 5_000,
    decideTimeoutMs: 30_000,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
  });
  return {
    ledger,
    contextAssembler,
    orchestratorService,
    graphReader,
    loop,
    getTestingAttempts: () => testingAttempts,
    getDeveloperContext: () => developerContext,
    getTestingContexts: () => testingContexts,
    getVerifiedEvidence: () => verifiedEvidence,
  };
}

test("real owner coordination refuses root cancellation and replaces a settled child while preserving the goal", async () => {
  const f = await fixture({ ownerGoal: true });
  await f.ledger.intake();
  let [root] = (await f.ledger.listItems()).items;
  const packet = () => f.contextAssembler.assemble({ roleId: "orchestrator", item: root, trigger: "scheduled" });
  const execute = async intent => f.orchestratorService.execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: root,
    contextPacket: await packet(), intent,
  });
  let current = await packet();
  const rootSource = current.context.requirements.currentTask;
  await assert.rejects(execute(orchestrationIntent(current.context,
    actionBase(current.context, rootSource, "cancel", "Retire a failed plan"), "Retire a plan").intent),
  error => error.code === "ORCHESTRATOR_AUTHORITY_DENIED");
  await execute(decompose(current.context, { childKey: "first-plan", title: "First plan", capability: "development", dependsOn: [],
    contract: acceptanceContract("implementation", "change-package", "Controlled repair") }).intent);
  root = await f.ledger.readItemForReconciliation({ itemId: root.itemId });
  let child = (await f.ledger.listItems()).items.find(item => item.graph.parentItemId === root.itemId);
  await f.ledger.transition({ itemId: child.itemId, expectedRevision: child.revision, leaseId: null,
    actorId: "work-ledger-system", toStatus: "blocked", reason: "plan_failed" });
  current = await packet();
  child = current.context.requirements.coordination.directChildren.find(item => item.taskId === child.itemId);
  const beforeRoot = structuredClone(root);
  await execute(orchestrationIntent(current.context, actionBase(current.context, child, "cancel", "Retire only the settled child"), "Replace child plan").intent);
  assert.deepEqual(await f.ledger.readItemForReconciliation({ itemId: root.itemId }), beforeRoot);
  current = await packet();
  await execute(decompose(current.context, { childKey: "replacement-plan", title: "Replacement plan", capability: "development", dependsOn: [],
    contract: acceptanceContract("implementation", "change-package", "Controlled repair") }).intent);
  const items = (await f.ledger.listItems()).items;
  assert.equal(items.find(item => item.itemId === root.itemId).status, "queued");
  assert.equal(items.filter(item => item.graph.parentItemId === root.itemId && item.status === "cancelled").length, 1);
  assert.equal(items.filter(item => item.graph.parentItemId === root.itemId && item.status === "queued").length, 1);
});

test("requirements, development, and testing iteratively complete one shared task tree", async () => {
  const {
    ledger,
    graphReader,
    loop,
    getTestingAttempts,
    getDeveloperContext,
    getTestingContexts,
    getVerifiedEvidence,
  } = await fixture();

  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "requirements-analyst" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "developer" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "tester" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "tester" });
  await loop.runCycle({ roleId: "orchestrator" });
  const finalCycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(finalCycle.staged, 1);
  const dispatcher = new WorkIntentDispatcher({
    ledger,
    policy: createWorkIntentPolicy({
      capabilityRoles: {
        requirements: "requirements-analyst",
        development: "developer",
        testing: "tester",
      },
    }),
    attentionProducer: { async create() {} },
    proposalProducer: { async create() {} },
    clock: () => NOW,
  });
  const dispatched = await dispatcher.dispatchPending();

  assert.equal(dispatched.delivered, 1);
  assert.equal(getTestingAttempts(), 2);
  const snapshot = await graphReader.getSnapshot();
  assert.equal(snapshot.graph.tasks.length, 4);
  assert.deepEqual(
    snapshot.graph.tasks.map(({ status }) => status),
    ["completed", "completed", "completed", "completed"],
  );
  const taskByTitle = (title) => snapshot.graph.tasks.find(
    (task) => snapshot.taskStates.find(
      ({ taskId }) => taskId === task.taskId,
    ).work.title === title,
  );
  const requirements = taskByTitle("Requirements");
  const development = taskByTitle("Development");
  const testing = taskByTitle("Testing");

  assert.equal(requirements.parentTaskId, development.parentTaskId);
  assert.equal(development.parentTaskId, testing.parentTaskId);
  assert.deepEqual(development.dependsOn, [requirements.taskId]);
  assert.deepEqual(testing.dependsOn, [development.taskId]);

  const developerInput = getDeveloperContext()
    .requirements.acceptedDependencies[0];
  assert.equal(developerInput.taskId, requirements.taskId);
  assert.equal(developerInput.taskRevision, requirements.revision);
  assert.equal(developerInput.contractRevision, 1);
  assert.equal(developerInput.deliverables[0].kind, "requirement-spec");
  assert.equal(
    developerInput.deliverables[0].submittedDeliveryRevision,
    1,
  );
  assert.equal(developerInput.deliverables[0].decisionRevision, 2);
  assert.equal(
    JSON.parse(developerInput.deliverables[0].summary).title,
    requirementDraft().title,
  );

  const testingContexts = getTestingContexts();
  assert.equal(testingContexts.length, 2);
  for (const context of testingContexts) {
    const developmentInput = context.code.acceptedDependencies[0];
    assert.equal(developmentInput.taskId, development.taskId);
    assert.equal(developmentInput.taskRevision, development.revision);
    assert.equal(developmentInput.contractRevision, 1);
    assert.equal(developmentInput.deliverables[0].kind, "change-package");
    assert.equal(
      developmentInput.deliverables[0].submittedDeliveryRevision,
      1,
    );
    assert.equal(developmentInput.deliverables[0].decisionRevision, 2);
    assert.equal(
      developmentInput.deliverables[0].evidence.some(
        ({ referenceId }) =>
          referenceId === CHANGE_PACKAGE_EVIDENCE.referenceId,
      ),
      true,
    );
  }

  assert.deepEqual(
    testing.deliveries.map(({ status }) => status),
    ["submitted", "rejected", "submitted", "accepted"],
  );
  assert.deepEqual(
    testing.deliveries
      .filter(({ status }) => status === "submitted")
      .map(({ evidence }) => evidence.find(
        ({ kind }) => kind === "test-report",
      ).referenceId),
    [FAILED_TEST_EVIDENCE.referenceId, PASSED_TEST_EVIDENCE.referenceId],
  );
  assert.equal(
    development.deliveries.at(-1).evidence.some(
      ({ referenceId }) =>
        referenceId === CHANGE_PACKAGE_EVIDENCE.referenceId,
    ),
    true,
  );
  assert.deepEqual(
    getVerifiedEvidence()
      .map(({ evidence }) => evidence.referenceId)
      .sort(),
    [
      CHANGE_PACKAGE_EVIDENCE.referenceId,
      CHANGE_PACKAGE_EVIDENCE.referenceId,
      FAILED_TEST_EVIDENCE.referenceId,
      PASSED_TEST_EVIDENCE.referenceId,
      PASSED_TEST_EVIDENCE.referenceId,
    ].sort(),
  );
  const items = await ledger.listItems({ limit: 100 });
  assert.equal(items.items.length, 4);
  assert.equal(new Set(items.items.map(({ itemId }) => itemId)).size, 4);
});

test("passed evidence on the first testing attempt is accepted without ordinal rework", async () => {
  const {
    ledger,
    graphReader,
    loop,
    getTestingAttempts,
    getVerifiedEvidence,
  } = await fixture({ testingEvidence: [PASSED_TEST_EVIDENCE] });

  for (const roleId of [
    "orchestrator",
    "requirements-analyst",
    "orchestrator",
    "orchestrator",
    "developer",
    "orchestrator",
    "orchestrator",
    "tester",
    "orchestrator",
  ]) {
    await loop.runCycle({ roleId });
  }
  const finalCycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(finalCycle.staged, 1);
  assert.equal(getTestingAttempts(), 1);
  const snapshot = await graphReader.getSnapshot();
  const testingState = snapshot.taskStates.find(
    ({ work }) => work.title === "Testing",
  );
  const testing = snapshot.graph.tasks.find(
    ({ taskId }) => taskId === testingState.taskId,
  );
  assert.deepEqual(
    testing.deliveries.map(({ status }) => status),
    ["submitted", "accepted"],
  );
  assert.equal(
    getVerifiedEvidence().some(
      ({ evidence }) =>
        evidence.referenceId === FAILED_TEST_EVIDENCE.referenceId,
    ),
    false,
  );
  assert.equal(
    getVerifiedEvidence().filter(
      ({ evidence }) =>
        evidence.referenceId === PASSED_TEST_EVIDENCE.referenceId,
    ).length,
    2,
  );

  const dispatcher = new WorkIntentDispatcher({
    ledger,
    policy: createWorkIntentPolicy({
      capabilityRoles: {
        requirements: "requirements-analyst",
        development: "developer",
        testing: "tester",
      },
    }),
    attentionProducer: { async create() {} },
    proposalProducer: { async create() {} },
    clock: () => NOW,
  });
  assert.equal((await dispatcher.dispatchPending()).delivered, 1);
});
