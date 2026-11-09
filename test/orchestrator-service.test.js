import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createRequirementSpec } from "../src/domain/requirement-spec-contract.js";
import { deliveryAcceptanceContractDigest } from
  "../src/domain/delivery-evidence-contract.js";
import { createWorkGraphSnapshot } from "../src/domain/work-graph-contract.js";
import {
  OrchestratorService,
  OrchestratorServiceError,
} from "../src/services/orchestrator-service.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import {
  createPullRequestReadFacts,
  createPullRequestReadIdentity,
  projectPullRequestReadFactsContext,
} from "../src/domain/pull-request-read-facts.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerWorkRequestEvent } from "../src/domain/owner-work-request.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { WorkGraphStore } from "../src/services/work-graph-store.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { WorkContinuationScheduler } from "../src/services/work-continuation-scheduler.js";
import { DeliveryEvidenceService } from "../src/services/delivery-evidence-service.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from "../src/services/work-ledger-pr-source.js";
import { normalizeBoundWorkProposal, createWorkProposalResult } from "../src/domain/work-proposal-contract.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { AutomaticReviewPublisher } from "../src/services/automatic-review-publisher.js";
import { GitHubReviewProposalHandler } from "../src/services/github-review-proposal-handler.js";
import { JenkinsCiDiagnostics } from "../src/services/jenkins-ci-diagnostics.js";
import { canonicalJsonDigest } from "../src/lib/canonical-json-digest.js";

const INPUT_DIGEST = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
const EXTERNAL_DIGEST = "c".repeat(64);

function deliverableEvidence(kind = "change-package", suffix = "1") {
  return {
    kind,
    referenceId: `artifact:${kind}:${suffix}`,
    contentDigest: EXTERNAL_DIGEST,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function contract({
  deliverableId = "implementation",
  kind = "change-package",
  required = true,
} = {}) {
  return {
    revision: 1,
    acceptanceCriteria: [
      { criterionId: "done", description: "交付物满足契约" },
    ],
    expectedDeliverables: [
      {
        deliverableId,
        kind,
        description: "受信任的交付物",
        required,
      },
    ],
  };
}

function task({
  taskId,
  revision = 1,
  parentTaskId = null,
  status = "pending",
  role = "orchestrator",
  acceptanceContract = contract({ required: false }),
  deliveries = [],
  dependsOn = [],
} = {}) {
  return {
    taskId,
    revision,
    parentTaskId,
    status,
    responsibility: { type: "role", id: role },
    acceptanceContracts: [acceptanceContract],
    deliveries,
    dependsOn,
  };
}

function graphView(tasks, revision = Math.max(1, ...tasks.map(({ revision: value }) => value))) {
  return {
    schemaVersion: 1,
    graph: createWorkGraphSnapshot({
      graphId: "work-ledger",
      revision,
      tasks,
    }),
    taskStates: [],
  };
}

function itemFor(graphTask, {
  status = "queued",
  ownerId = null,
  leaseId = null,
} = {}) {
  return {
    itemId: graphTask.taskId,
    revision: graphTask.revision,
    inputDigest: INPUT_DIGEST,
    status,
    ownerId,
    leaseId,
    currentTarget: { ...graphTask.responsibility },
  };
}

function packetFor(view, graphTask, {
  roleId = graphTask.responsibility.id,
  acceptedInputs = [],
  directChildren,
  event,
} = {}) {
  const requirements = {
    trigger: "scheduled",
    ...(directChildren
      ? {
          coordination: {
            schemaVersion: 1,
            rootTaskId: graphTask.taskId,
            directChildren: directChildren.map((child) => ({
              taskId: child.taskId,
            })),
          },
          childDeliveries: directChildren.flatMap((child) => {
            const submitted = child.deliveries.at(-1);
            return submitted?.status === "submitted"
              ? [{
                  taskId: child.taskId,
                  state: "submitted",
                  submittedDeliveryRevision: submitted.revision,
                }]
              : [];
          }),
        }
      : {}),
  };
  return {
    schemaVersion: 1,
    binding: {
      roleId,
      taskId: graphTask.taskId,
      taskRevision: graphTask.revision,
      inputDigest: INPUT_DIGEST,
      graphId: view.graph.graphId,
      graphRevision: view.graph.revision,
      graphContentDigest: view.graph.contentDigest,
      contractRevision: graphTask.acceptanceContracts.at(-1).revision,
    },
    context: {
      requirements,
      ...(event === undefined ? {} : { code: { sourceEvent: event } }),
    },
    acceptedInputs,
    contextDigest: CONTEXT_DIGEST,
  };
}

function structuredTriageEvent(capability) {
  return {
    eventType: "pull_request.owner_requested",
    source: { provider: "local-owner", scopeId: "owner-request:test" },
    payload: {
      workType: "general",
      nextAction: capability === "development" ? "fix_ci" : "review",
      suggestedCapability: capability,
      expectedHeadRefOid: "d".repeat(40),
    },
  };
}

function workInputEvidence(graphTask, acceptedInputs = [], contextDigest = CONTEXT_DIGEST) {
  return {
    kind: "work-inputs",
    referenceId: `work-inputs:${graphTask.taskId}:${contextDigest}`,
    contentDigest: digest({
      domain: "mydashboard-work-inputs/v1",
      taskId: graphTask.taskId,
      roleId: graphTask.responsibility.id,
      contextDigest,
      acceptedInputs,
    }),
  };
}

function orchestrate(action, summary = "协调下一步") {
  return {
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  };
}

function commonAction(type, source, view, reason = "当前任务需要协调") {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.revision,
    expectedGraphRevision: view.graph.revision,
    reason,
  };
}

function fakePorts({ packet, views, plannerResult, deliveryResult, verifier } = {}) {
  const calls = {
    assemble: [],
    graphReads: 0,
    plannerFactory: [],
    delivererFactory: [],
    planner: [],
    delivery: [],
    verify: [],
  };
  const snapshots = Array.isArray(views) ? views : [views];
  const planner = {};
  for (const method of [
    "createChild",
    "reassignTask",
    "decideDelivery",
    "stageEscalation",
    "pauseTask",
    "resumeTask",
    "cancelTask",
  ]) {
    planner[method] = async (command) => {
      calls.planner.push({ method, command });
      if (plannerResult instanceof Error) throw plannerResult;
      return typeof plannerResult === "function"
        ? plannerResult(method, command)
        : (plannerResult ?? {
            applied: true,
            taskId: command.taskId ?? "root/new-child",
            deliveryRevision: command.submittedDeliveryRevision + 1,
            ownerId: "must-not-leak",
            leaseId: "must-not-leak",
            evidence: [{ secret: true }],
          });
    };
  }
  const ports = {
    contextAssembler: {
      async assemble(input) {
        calls.assemble.push(input);
        return typeof packet === "function" ? packet(input) : packet;
      },
    },
    graphReader: {
      async getSnapshot() {
        const index = Math.min(calls.graphReads, snapshots.length - 1);
        calls.graphReads += 1;
        const snapshot = snapshots[index];
        return typeof snapshot === "function" ? snapshot() : snapshot;
      },
    },
    scopedGraphPlannerFactory: {
      forRoot(request) {
        calls.plannerFactory.push(request);
        return planner;
      },
    },
    graphDelivererFactory: {
      forClaim(request) {
        calls.delivererFactory.push(request);
        return {
          async submitDelivery(command) {
            calls.delivery.push(command);
            if (deliveryResult instanceof Error) throw deliveryResult;
            return typeof deliveryResult === "function"
              ? deliveryResult(command)
              : (deliveryResult ?? {
                  applied: true,
                  ownerId: "must-not-leak",
                  leaseId: "must-not-leak",
                  evidence: [{ secret: true }],
                });
          },
        };
      },
    },
    ...(verifier === undefined
      ? {}
      : {
          evidenceVerifier: {
            async verify(input) {
              calls.verify.push(input);
              return verifier(input);
            },
          },
        }),
  };
  return { calls, ports };
}

function serviceFrom(
  fakes,
  capabilityRoles = {
    development: "developer",
    testing: "tester",
  },
  actionAdmissionGate,
) {
  return new OrchestratorService({
    ...fakes.ports,
    capabilityRoles,
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
  });
}

function rootFixture({
  submitted = false,
  externalEvidence = [deliverableEvidence()],
  childContract = contract(),
} = {}) {
  const root = task({ taskId: "root", revision: 3 });
  const child = task({
    taskId: "root/child",
    revision: submitted ? 2 : 1,
    parentTaskId: root.taskId,
    role: "developer",
    acceptanceContract: childContract,
    deliveries: submitted
      ? [
          {
            deliverableId: childContract.expectedDeliverables[0].deliverableId,
            revision: 1,
            contractRevision: 1,
            status: "submitted",
            summary: "实现说明",
            evidence: [
              ...externalEvidence,
              workInputEvidence({
                taskId: "root/child",
                responsibility: { type: "role", id: "developer" },
              }),
            ],
          },
        ]
      : [],
  });
  const dependency = task({
    taskId: "root/dependency",
    revision: 1,
    parentTaskId: root.taskId,
    status: "completed",
    role: "tester",
    acceptanceContract: contract({ required: false }),
  });
  const view = graphView([root, child, dependency], 3);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [child, dependency],
  });
  return { root, child, dependency, view, item, packet };
}

test("owner root cancellation is refused before planner creation even if supplied context claims permission", async () => {
  const fixture = rootFixture();
  fixture.item.event = createOwnerWorkRequestEvent({ schemaVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111", workType: "general", priority: "high",
    title: "Keep the goal", description: "A child failure does not withdraw this request.", acceptanceCriteria: ["Verified delivery"],
  }, "2026-08-03T00:00:00.000Z");
  fixture.packet.context.requirements.coordination.goalControl = { owner: "local-owner", rootTaskId: fixture.root.taskId,
    cancellableTaskIds: [fixture.root.taskId] };
  fixture.packet.contextDigest = canonicalJsonDigest(fixture.packet.context);
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  await assert.rejects(serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: fixture.item,
    contextPacket: fixture.packet, intent: orchestrate(commonAction("cancel", fixture.root, fixture.view)),
  }), error => error.code === "ORCHESTRATOR_AUTHORITY_DENIED");
  assert.equal(fakes.calls.plannerFactory.length, 0);
});

function executeDeliveryDecision(fakes, fixture, type) {
  return serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate({
      ...commonAction(type, fixture.child, fixture.view),
      submittedDeliveryRevision: 1,
    }),
  });
}

function assertNoTrustedMutation(calls) {
  assert.equal(calls.plannerFactory.length, 0);
  assert.equal(calls.delivererFactory.length, 0);
  assert.equal(calls.planner.length, 0);
  assert.equal(calls.delivery.length, 0);
}

test("maps all eight orchestration actions to the least-authority planner commands", async (t) => {
  const scenarios = [
    {
      name: "decompose",
      build({ root, dependency, view }) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "implementation",
          work: { title: "实现", description: "完成受控实现" },
          capability: "development",
          dependsOn: [{ taskId: dependency.taskId, revision: dependency.revision }],
          acceptanceContract: contract(),
        };
      },
      method: "createChild",
      expected({ root, dependency, view }) {
        return {
          parentTaskId: root.taskId,
          childKey: "implementation",
          work: { title: "实现", description: "完成受控实现" },
          target: { type: "role", id: "developer" },
          dependsOnTaskIds: [dependency.taskId],
          acceptanceContract: contract(),
          leaseId: null,
          expectedGraphRevision: view.graph.revision,
          expectedTaskRevisions: [
            { taskId: root.taskId, revision: root.revision },
            { taskId: dependency.taskId, revision: dependency.revision },
          ],
        };
      },
    },
    {
      name: "assign",
      build: ({ child, view }) => ({
        ...commonAction("assign", child, view),
        capability: "testing",
      }),
      method: "reassignTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        target: { type: "role", id: "tester" },
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "accept_delivery",
      submitted: true,
      build: ({ child, view }) => ({
        ...commonAction("accept_delivery", child, view),
        submittedDeliveryRevision: 1,
      }),
      method: "decideDelivery",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        submittedDeliveryRevision: 1,
        decision: "accept",
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "return_delivery",
      submitted: true,
      build: ({ child, view }) => ({
        ...commonAction("return_delivery", child, view),
        submittedDeliveryRevision: 1,
      }),
      method: "decideDelivery",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        submittedDeliveryRevision: 1,
        decision: "reject",
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "escalate",
      build: ({ child, view }) => ({
        ...commonAction("escalate", child, view),
        question: "是否允许扩展范围？",
        choices: [
          { id: "yes", label: "允许", description: "继续推进" },
          { id: "no", label: "拒绝", description: "保持范围" },
        ],
      }),
      method: "stageEscalation",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
        summary: "协调下一步",
        question: "是否允许扩展范围？",
        choices: [
          { id: "yes", label: "允许", description: "继续推进" },
          { id: "no", label: "拒绝", description: "保持范围" },
        ],
      }),
    },
    {
      name: "pause",
      build: ({ child, view }) => commonAction("pause", child, view),
      method: "pauseTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "resume",
      build: ({ child, view }) => commonAction("resume", child, view),
      method: "resumeTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "cancel",
      build: ({ child, view }) => commonAction("cancel", child, view),
      method: "cancelTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = rootFixture({ submitted: scenario.submitted });
      const fakes = fakePorts({
        packet: fixture.packet,
        views: fixture.view,
        verifier: () => true,
        plannerResult: (method, command) => ({
          applied: true,
          taskId: method === "createChild" ? "root/new-child" : command.taskId,
          deliveryRevision: command.submittedDeliveryRevision + 1,
          ownerId: "private-owner",
          leaseId: "private-lease",
          evidence: [{ private: true }],
        }),
      });
      const admissions = [];
      const result = await serviceFrom(fakes, undefined, {
        run(operation) {
          admissions.push(scenario.name);
          return operation();
        },
      }).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(scenario.build(fixture)),
      });

      assert.deepEqual(fakes.calls.plannerFactory, [
        { scopeRootTaskId: fixture.root.taskId },
      ]);
      assert.deepEqual(fakes.calls.planner, [
        { method: scenario.method, command: scenario.expected(fixture) },
      ]);
      assert.equal(result.action, scenario.name);
      assert.equal(result.applied, true);
      assert.deepEqual(admissions, [scenario.name]);
      assert.equal(Object.isFrozen(fakes.calls.planner[0].command), true);
      assert.equal(Object.isFrozen(result), true);
      assert.doesNotMatch(JSON.stringify(result), /private-owner|private-lease|evidence/);
    });
  }
});

test("an explicit child-wait pause forwards its durable wake contract", async () => {
  const fixture = rootFixture();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  const action = {
    ...commonAction("pause", fixture.root, fixture.view),
    waitForChildren: true,
  };
  await serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate(action),
  });

  assert.deepEqual(fakes.calls.planner, [{
    method: "pauseTask",
    command: {
      taskId: fixture.root.taskId,
      reason: action.reason,
      expectedGraphRevision: fixture.view.graph.revision,
      expectedTaskRevision: fixture.root.revision,
      waitForChildren: true,
    },
  }]);
});

test("structured PR triage creates exactly one child for its trusted capability", async (t) => {
  for (const capability of ["development", "pr-review"]) {
    await t.test(capability, async () => {
      const root = task({ taskId: `root-${capability}`, revision: 1 });
      const view = graphView([root], 1);
      const item = itemFor(root);
      const packet = packetFor(view, root, {
        roleId: "orchestrator",
        directChildren: [],
        event: structuredTriageEvent(capability),
      });
      const fakes = fakePorts({ packet, views: view });
      const reason = "Create the trusted triage child";
      const result = await serviceFrom(fakes, {
        development: "developer",
        "pr-review": "pr-engineer",
      }).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item,
        contextPacket: packet,
        intent: orchestrate({
          ...commonAction("decompose", root, view, reason),
          childKey: `triage-${capability}`,
          work: { title: "Handle PR", description: "Use trusted PR intake" },
          capability,
          dependsOn: [],
          acceptanceContract: contract({
            kind: capability === "development"
              ? "change-package"
              : "github-review",
          }),
        }),
      });

      assert.equal(result.action, "decompose");
      assert.deepEqual(fakes.calls.planner[0].command.target, {
        type: "role",
        id: capability === "development" ? "developer" : "pr-engineer",
      });
    });
  }
});

test('automatic coordination can replace cancelled Review work and delegate a follow-up capability', async () => {
  const root = task({ taskId: 'automatic-root' });
  const child = task({ taskId: 'automatic-root/old', parentTaskId: root.taskId, role: 'orchestrator', status: 'cancelled' });
  const view = graphView([root, child], 3);
  const event = structuredTriageEvent('pr-review');
  event.payload.nextAction = 'rereview';
  const packet = packetFor(view, root, { directChildren: [child], event });
  const fakes = fakePorts({ packet, views: view });
  const service = new OrchestratorService({ ...fakes.ports, automaticMode: true, capabilityRoles: { testing: 'tester' } });
  const result = await service.execute({
    worker: { roleId: 'orchestrator', workerId: 'employee-orchestrator' }, item: itemFor(root), contextPacket: packet,
    intent: orchestrate({ ...commonAction('decompose', root, view), childKey: 'follow-up',
      work: { title: 'Verify current implementation', description: 'Delegate the next step' },
      capability: 'testing', dependsOn: [], acceptanceContract: contract({ kind: 'text-report' }) }),
  });
  assert.equal(result.action, 'decompose');
  assert.deepEqual(fakes.calls.planner[0].command.target, { type: 'role', id: 'tester' });
});

test("root coordination cannot delegate specialist contracts back to the root role", async (t) => {
  for (const type of ["decompose", "assign"]) {
    for (const capability of ["coordination", "requirements"]) {
      await t.test(`${type} ${capability} mapped to orchestrator`, async () => {
        const root = task({ taskId: "root-only" });
        const child = task({ taskId: "root-only/child", parentTaskId: root.taskId, role: "tester" });
        const view = graphView([root, child], 3);
        const packet = packetFor(view, root, { directChildren: [child] });
        const fakes = fakePorts({ packet, views: view });
        const service = new OrchestratorService({ ...fakes.ports, automaticMode: true,
          capabilityRoles: { [capability]: "orchestrator" } });
        const action = { ...commonAction(type, type === "decompose" ? root : child, view), capability,
          ...(type === "decompose" ? { childKey: "diagnosis", dependsOn: [],
            work: { title: "Internal diagnosis", description: "A text report must have a deliverable specialist" },
            acceptanceContract: contract({ kind: "text-report" }) } : {}) };
        await assert.rejects(service.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
          item: itemFor(root), contextPacket: packet, intent: orchestrate(action) }),
        { code: "ORCHESTRATOR_AUTHORITY_DENIED", message: /root orchestrator.*specialist/i });
        assertNoTrustedMutation(fakes.calls);
      });
    }
  }
});

test("coordination mapped to a specialist can still create a text-report task", async () => {
  const root = task({ taskId: "specialist-root" });
  const view = graphView([root]);
  const packet = packetFor(view, root, { directChildren: [] });
  const fakes = fakePorts({ packet, views: view });
  const service = new OrchestratorService({ ...fakes.ports, automaticMode: true,
    capabilityRoles: { coordination: "requirements-analyst" } });
  await service.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: itemFor(root), contextPacket: packet,
    intent: orchestrate({ ...commonAction("decompose", root, view), capability: "coordination", childKey: "diagnosis",
      dependsOn: [], work: { title: "Internal diagnosis", description: "Produce a scoped prose report" },
      acceptanceContract: contract({ kind: "text-report" }) }) });
  assert.deepEqual(fakes.calls.planner[0].command.target, { type: "role", id: "requirements-analyst" });
});

test('automatic coordination preserves a paused Review when creating a fresh child', async () => {
  const root = task({ taskId: 'paused-root' });
  const child = task({ taskId: 'paused-root/old', parentTaskId: root.taskId, role: 'pr-engineer', status: 'paused' });
  const view = graphView([root, child], 3);
  const event = structuredTriageEvent('pr-review'); event.payload.nextAction = 'rereview';
  const packet = packetFor(view, root, { directChildren: [child], event });
  const fakes = fakePorts({ packet, views: view });
  const service = new OrchestratorService({ ...fakes.ports, automaticMode: true, capabilityRoles: { 'pr-review': 'pr-engineer' } });
  await assert.rejects(service.execute({
    worker: { roleId: 'orchestrator', workerId: 'employee-orchestrator' }, item: itemFor(root), contextPacket: packet,
    intent: orchestrate({ ...commonAction('decompose', root, view), childKey: 'fresh-review',
      work: { title: 'Review again', description: 'Do not bypass a pause' },
      capability: 'pr-review', dependsOn: [], acceptanceContract: contract({ kind: 'github-review' }) }),
  }), { code: 'ORCHESTRATOR_AUTHORITY_DENIED' });
  assertNoTrustedMutation(fakes.calls);
});

test("conflict triage replaces only cancelled development work without deliveries", async (t) => {
  for (const scenario of [
    ...["cancelled", "in_progress", "paused", "completed"].map(status => ({ status })),
    { status: "cancelled", role: "pr-engineer" },
    { status: "cancelled", delivered: true },
  ]) {
    const { status, role = "developer", delivered = false } = scenario;
    await t.test(`${status}-${role}-${delivered}`, async () => {
      const root = task({ taskId: "conflict-root" });
      const child = task({ taskId: "conflict-root/old", parentTaskId: root.taskId, role, status });
      if (delivered) child.deliveries = [{ revision: 1, contractRevision: 1, deliverableId: "implementation",
        status: "submitted", summary: "Existing delivery", evidence: [workInputEvidence(child)] }];
      const view = graphView([root, child], 3);
      const event = structuredTriageEvent("development");
      event.payload.nextAction = "resolve_conflict";
      const packet = packetFor(view, root, { directChildren: [child], event });
      const fakes = fakePorts({ packet, views: view });
      const execute = () => serviceFrom(fakes, { development: "developer" }).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: itemFor(root), contextPacket: packet,
        intent: orchestrate({ ...commonAction("decompose", root, view), childKey: "conflict-retry",
          work: { title: "Retry conflict repair", description: "Use the current trusted target" },
          capability: "development", dependsOn: [], acceptanceContract: contract() }),
      });
      if (status === "cancelled" && role === "developer" && !delivered) assert.equal((await execute()).action, "decompose");
      else {
        await assert.rejects(execute(), { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
        assertNoTrustedMutation(fakes.calls);
      }
    });
  }
});

test("structured PR triage rejects capability drift, a second child, and premature control", async (t) => {
  const cases = [
    {
      name: "mismatched capability",
      children: [],
      action(root, view) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "wrong-capability",
          work: { title: "Wrong", description: "Must be rejected" },
          capability: "pr-review",
          dependsOn: [],
          acceptanceContract: contract({ kind: "github-review" }),
        };
      },
    },
    {
      name: "second child",
      children: [task({
        taskId: "root/existing",
        parentTaskId: "root",
        role: "developer",
      })],
      action(root, view) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "duplicate",
          work: { title: "Duplicate", description: "Must be rejected" },
          capability: "development",
          dependsOn: [],
          acceptanceContract: contract(),
        };
      },
    },
    {
      name: "premature pause",
      children: [],
      action: (root, view) => commonAction("pause", root, view),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = task({ taskId: "root", revision: 1 });
      const view = graphView([root, ...scenario.children], 1);
      const item = itemFor(root);
      const packet = packetFor(view, root, {
        roleId: "orchestrator",
        directChildren: scenario.children,
        event: structuredTriageEvent("development"),
      });
      const fakes = fakePorts({ packet, views: view });
      await assert.rejects(
        serviceFrom(fakes, {
          development: "developer",
          "pr-review": "pr-engineer",
        }).execute({
          worker: {
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
          },
          item,
          contextPacket: packet,
          intent: orchestrate(scenario.action(root, view)),
        }),
        (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
      );
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("external rereview refuses text-only contracts and safely replaces only cancelled malformed children", async (t) => {
  const scenarios = [
    { name: "new text-only contract", children: [], kind: "text-report", denied: true },
    { name: "optional review is insufficient", children: [], kind: "github-review", required: false, denied: true },
    { name: "cancelled malformed child", status: "cancelled", kind: "github-review" },
    ...["pending", "in_progress", "paused", "failed"].map((status) =>
      ({ name: `existing ${status} malformed child`, status, kind: "github-review", denied: true })),
    { name: "cancelled authoritative child", status: "cancelled", oldKind: "github-review", kind: "github-review", denied: true },
    { name: "cancelled submitted report remains unsettled", status: "cancelled", oldDelivery: "submitted", kind: "github-review", denied: true },
    { name: "cancelled accepted report cannot be replayed", status: "cancelled", oldDelivery: "accepted", kind: "github-review", denied: true },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const root = task({ taskId: "rereview-root", revision: 1 });
    const children = scenario.status ? [task({ taskId: "rereview-root/old", parentTaskId: root.taskId,
      status: scenario.status, role: "pr-engineer", acceptanceContract: contract({ kind: scenario.oldKind ?? "text-report" }) })] : [];
    if (scenario.oldDelivery) {
      children[0].revision = 2;
      children[0].deliveries = [{ revision: 1, contractRevision: 1, deliverableId: "implementation", status: "submitted",
        summary: "Local report", evidence: [workInputEvidence(children[0])] }];
      if (scenario.oldDelivery === "accepted") children[0].deliveries.push({ ...children[0].deliveries[0], revision: 2, status: "accepted" });
    }
    const view = graphView([root, ...children], 2);
    const event = structuredTriageEvent("pr-review"); event.payload.nextAction = "rereview";
    const packet = packetFor(view, root, { directChildren: children, event });
    const fakes = fakePorts({ packet, views: view });
    const operation = () => serviceFrom(fakes, { "pr-review": "pr-engineer" }).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: itemFor(root), contextPacket: packet,
      intent: orchestrate({ ...commonAction("decompose", root, view), childKey: "authoritative-rereview-v2",
        work: { title: "Review", description: "Publish the bound Head review" }, capability: "pr-review", dependsOn: [],
        acceptanceContract: contract({ kind: scenario.kind, required: scenario.required ?? true }) }),
    });
    if (scenario.denied) { await assert.rejects(operation(), { code: "ORCHESTRATOR_AUTHORITY_DENIED" }); assertNoTrustedMutation(fakes.calls); }
    else { assert.equal((await operation()).action, "decompose"); assert.equal(fakes.calls.planner[0].command.childKey, "authoritative-rereview-v2"); }
  });
});

test("external rereview can return but cannot accept a local text report", async () => {
  const root = task({ taskId: "rereview-root", revision: 1 });
  const child = task({ taskId: "rereview-root/old", revision: 2, parentTaskId: root.taskId, status: "in_progress",
    role: "pr-engineer", acceptanceContract: contract({ kind: "text-report" }) });
  child.deliveries = [{ revision: 1, contractRevision: 1, deliverableId: "implementation", status: "submitted",
    summary: "Local findings", evidence: [workInputEvidence(child)] }];
  const view = graphView([root, child], 3);
  const event = structuredTriageEvent("pr-review"); event.payload.nextAction = "rereview";
  const packet = packetFor(view, root, { directChildren: [child], event });
  for (const type of ["accept_delivery", "return_delivery"]) {
    const fakes = fakePorts({ packet, views: view });
    const operation = () => serviceFrom(fakes).execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: itemFor(root), contextPacket: packet,
      intent: orchestrate({ ...commonAction(type, child, view), submittedDeliveryRevision: 1 }) });
    if (type === "accept_delivery") { await assert.rejects(operation(), { code: "ORCHESTRATOR_AUTHORITY_DENIED" }); assertNoTrustedMutation(fakes.calls); }
    else assert.equal((await operation()).action, "return_delivery");
  }
});

test("host-backed Review replacement stays exact and is attached only to a matching decomposition", async (t) => {
  for (const automaticMode of [false, true]) for (const variant of ["valid", "missing", "key", "revision", "paused", "active sibling", "contract"]) await t.test(`${automaticMode}:${variant}`, async () => {
    const root = task({ taskId: "reuse-root", revision: 1 });
    const old = task({ taskId: "reuse-root/old", revision: 17, parentTaskId: root.taskId, status: "failed", role: "pr-engineer",
      acceptanceContract: contract({ kind: "review-report" }) });
    const children = [old, task({ taskId: "reuse-root/diagnostic", parentTaskId: root.taskId, status: "cancelled", role: "orchestrator",
      acceptanceContract: contract({ kind: "text-report" }) })];
    if (variant === "active sibling") children.push(task({ taskId: "reuse-root/active", parentTaskId: root.taskId, role: "pr-engineer" }));
    const view = graphView([root, ...children], 20);
    const event = structuredTriageEvent("pr-review"); event.payload.nextAction = "rereview";
    const packet = packetFor(view, root, { directChildren: children, event });
    Object.assign(packet.context.requirements.coordination.directChildren[0], { ledgerStatus: variant === "paused" ? "paused" : "blocked",
      decisionFailure: { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" } });
    packet.context.code.reviewPublicationRecovery = { childTaskId: old.taskId, childTaskRevision: variant === "revision" ? 18 : 17,
      requiresTaskControlChecks: true, candidates: [{ replacementChildKey: "stable-reuse-key", deliverableId: "implementation" }] };
    if (variant === "missing") delete packet.context.code.reviewPublicationRecovery;
    const fakes = fakePorts({ packet, views: view });
    const operation = () => new OrchestratorService({ ...fakes.ports, capabilityRoles: { "pr-review": "pr-engineer" }, automaticMode }).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: itemFor(root), contextPacket: packet,
      intent: orchestrate({ ...commonAction("decompose", root, view), childKey: variant === "key" ? "another-key" : "stable-reuse-key",
        work: { title: "Review", description: "Assess and adopt verified original Review" }, capability: "pr-review", dependsOn: [],
        acceptanceContract: contract({ kind: variant === "contract" ? "text-report" : "review-report" }) }),
    });
    if (variant === "valid") {
      assert.equal((await operation()).action, "decompose");
      assert.deepEqual(fakes.calls.planner[0].command.reviewReplacement, {
        taskId: old.taskId, expectedTaskRevision: 17, reason: "当前任务需要协调",
      });
    } else {
      await assert.rejects(operation(), { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
      assertNoTrustedMutation(fakes.calls);
    }
  });
});

test('external rereview accepts its subsequent tester text delivery without requiring another Review', async () => {
  const root = task({ taskId: 'rereview-root', revision: 1 });
  const child = task({ taskId: 'rereview-root/testing', revision: 2, parentTaskId: root.taskId,
    status: 'in_progress', role: 'tester', acceptanceContract: contract({ kind: 'text-report' }) });
  child.deliveries = [{ revision: 1, contractRevision: 1, deliverableId: 'implementation', status: 'submitted',
    summary: 'Verification results', evidence: [workInputEvidence(child)] }];
  const view = graphView([root, child], 3);
  const event = structuredTriageEvent('pr-review'); event.payload.nextAction = 'rereview';
  const packet = packetFor(view, root, { directChildren: [child], event });
  const fakes = fakePorts({ packet, views: view });
  const result = await serviceFrom(fakes).execute({ worker: { roleId: 'orchestrator', workerId: 'employee-orchestrator' },
    item: itemFor(root), contextPacket: packet,
    intent: orchestrate({ ...commonAction('accept_delivery', child, view), submittedDeliveryRevision: 1 }) });
  assert.equal(result.action, 'accept_delivery');
  assert.equal(fakes.calls.planner.length, 1);
});

test("rejects oversized requirement input sets before creating a graph planner", async () => {
  function completedDependency(taskId, deliverableCount) {
    const expectedDeliverables = [];
    const deliveries = [];
    for (let index = 0; index < deliverableCount; index += 1) {
      const deliverableId = `artifact-${index}`;
      const records = [{
        kind: "artifact",
        referenceId: `${taskId}:${deliverableId}`,
        contentDigest: EXTERNAL_DIGEST,
      }];
      expectedDeliverables.push({
        deliverableId,
        kind: "change-package",
        description: `Accepted input ${index}`,
        required: true,
      });
      deliveries.push(
        {
          deliverableId,
          revision: deliveries.length + 1,
          contractRevision: 1,
          status: "submitted",
          summary: `Submitted input ${index}`,
          evidence: records,
        },
        {
          deliverableId,
          revision: deliveries.length + 2,
          contractRevision: 1,
          status: "accepted",
          summary: `Accepted input ${index}`,
          evidence: records,
        },
      );
    }
    return task({
      taskId,
      revision: deliveries.length + 1,
      parentTaskId: "root",
      status: "completed",
      role: "developer",
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [
          { criterionId: "done", description: "Inputs are accepted" },
        ],
        expectedDeliverables,
      },
      deliveries,
    });
  }

  const root = task({ taskId: "root", revision: 3 });
  const first = completedDependency("root/dependency-a", 64);
  const second = completedDependency("root/dependency-b", 1);
  const view = graphView([root, first, second], first.revision + 1);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [first, second],
  });
  const fakes = fakePorts({ packet, views: view });
  const reason = "Create a bounded requirement task";

  await assert.rejects(
    serviceFrom(fakes, { requirements: "requirements-analyst" }).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item,
      contextPacket: packet,
      intent: orchestrate({
        ...commonAction("decompose", root, view, reason),
        childKey: "requirements",
        work: { title: "Requirements", description: "Clarify the scope" },
        capability: "requirements",
        dependsOn: [first, second].map(({ taskId, revision }) => ({
          taskId,
          revision,
        })),
        acceptanceContract: contract({
          deliverableId: "requirement-spec",
          kind: "requirement-spec",
        }),
      }),
    }),
    (error) =>
      error instanceof OrchestratorServiceError &&
      error.code === "ORCHESTRATOR_REQUIREMENT_INPUT_BUDGET_EXCEEDED",
  );
  assert.equal(fakes.calls.plannerFactory.length, 0);
  assert.equal(fakes.calls.delivererFactory.length, 0);
  assert.equal(fakes.calls.planner.length, 0);
});

test("rejects stale context and unauthorized orchestration before either factory", async (t) => {
  await t.test("stale packet", async () => {
    const fixture = rootFixture();
    const fresh = structuredClone(fixture.packet);
    fresh.contextDigest = "d".repeat(64);
    const fakes = fakePorts({ packet: fresh, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_STALE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
  });

  await t.test("wrong orchestrator principal", async () => {
    const fixture = rootFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "lookalike" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
  });
});

test("classifies context reassembly failures without hiding availability", async (t) => {
  await t.test("preserves the service-owned context timeout", async () => {
    const fixture = rootFixture();
    let contextSignal;
    const fakes = fakePorts({
      packet(input) {
        contextSignal = input.signal;
        return new Promise(() => {});
      },
      views: fixture.view,
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 1,
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503,
    );

    assert.equal(contextSignal instanceof AbortSignal, true);
    assert.equal(contextSignal.aborted, true);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("maps a producer 5xx to context unavailable", async () => {
    const fixture = rootFixture();
    const outage = Object.assign(new Error("evidence catalog unavailable"), {
      code: "ROLE_CONTEXT_EVIDENCE_UNAVAILABLE",
      statusCode: 503,
    });
    const fakes = fakePorts({
      packet() {
        throw outage;
      },
      views: fixture.view,
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_UNAVAILABLE" &&
        error.statusCode === 503 &&
        error.cause === outage,
    );

    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("maps a producer binding mismatch to stale", async () => {
    const fixture = rootFixture();
    const mismatch = Object.assign(new Error("task revision changed"), {
      code: "ROLE_CONTEXT_STALE",
      statusCode: 409,
    });
    const fakes = fakePorts({
      packet() {
        throw mismatch;
      },
      views: fixture.view,
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
        error.statusCode === 409 &&
        error.cause === mismatch,
    );

    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });
});

test("an expired root lease does not constrain orchestration evidence reads", async () => {
  const fixture = rootFixture();
  const now = Date.parse("2026-08-03T08:00:00.000Z");
  fixture.item.status = "working";
  fixture.item.ownerId = "previous-orchestrator";
  fixture.item.leaseId = "expired-root-lease";
  fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  const service = new OrchestratorService({
    ...fakes.ports,
    clock: () => new Date(now),
  });

  const result = await service.execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
  });

  assert.equal(result.applied, true);
  assert.equal(fakes.calls.assemble.length, 1);
  assert.equal(fakes.calls.planner.length, 1);
});

test("rejects locally unbound submissions before applying lease deadlines", async (t) => {
  const now = Date.parse("2026-08-03T08:00:00.000Z");

  await t.test("root orchestrator", async () => {
    const fixture = rootFixture();
    fixture.item.status = "working";
    fixture.item.ownerId = "employee-orchestrator";
    fixture.item.leaseId = "expired-root-lease";
    fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    const service = new OrchestratorService({
      ...fakes.ports,
      clock: () => new Date(now),
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: {
          schemaVersion: 1,
          type: "submit_delivery",
          taskId: fixture.root.taskId,
          expectedTaskRevision: fixture.root.revision,
          expectedGraphRevision: fixture.view.graph.revision,
          contractRevision: 1,
          deliverableId: "implementation",
          summary: "不允许的根任务交付",
          reason: "根编排者不能提交岗位交付",
          evidence: [],
          artifact: null,
        },
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_AUTHORITY_DENIED" &&
        error.statusCode === 403,
    );

    assert.equal(fakes.calls.assemble.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("wrong lease owner", async () => {
    const fixture = specialistFixture();
    fixture.item.ownerId = "another-developer";
    fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    const service = new OrchestratorService({
      ...fakes.ports,
      clock: () => new Date(now),
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_AUTHORITY_DENIED" &&
        error.statusCode === 403,
    );

    assert.equal(fakes.calls.assemble.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });
});

function specialistFixture({
  deliverableId = "implementation",
  kind = "change-package",
} = {}) {
  const root = task({ taskId: "root", revision: 1 });
  const specialist = task({
    taskId: "root/specialist",
    revision: 1,
    parentTaskId: root.taskId,
    status: "in_progress",
    role: "developer",
    acceptanceContract: contract({ deliverableId, kind }),
  });
  const view = graphView([root, specialist], 2);
  const item = itemFor(specialist, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "lease-secret",
  });
  const packet = packetFor(view, specialist);
  return { root, specialist, view, item, packet };
}

function submitIntent(fixture, {
  deliverableId = "implementation",
  artifact = null,
  evidence = [],
} = {}) {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: fixture.specialist.taskId,
    expectedTaskRevision: fixture.specialist.revision,
    expectedGraphRevision: fixture.view.graph.revision,
    contractRevision: 1,
    deliverableId,
    summary: "完成交付",
    reason: "契约要求已满足",
    evidence,
    artifact,
  };
}

function signedContextPacket(packet, view) {
  const result = structuredClone(packet);
  result.binding.graphRevision = view.graph.revision;
  result.binding.graphContentDigest = view.graph.contentDigest;
  result.context.requirements.graph = {
    graphId: view.graph.graphId,
    revision: view.graph.revision,
    contentDigest: view.graph.contentDigest,
  };
  result.contextDigest = digest({
    domain: "mydashboard-role-context/v1",
    binding: result.binding,
    dataClasses: Object.keys(result.context).sort(),
    context: result.context,
  });
  return result;
}

test("scoped decisions survive unrelated graph changes with authenticated context", async (t) => {
  for (const role of ["orchestrator", "developer"]) {
    await t.test(role, async () => {
      const fixture = role === "orchestrator" ? rootFixture() : specialistFixture();
      const changed = graphView([
        ...fixture.view.graph.tasks,
        task({ taskId: "unrelated-root" }),
      ], fixture.view.graph.revision + 1);
      const original = signedContextPacket(fixture.packet, fixture.view);
      const fresh = signedContextPacket(original, changed);
      const fakes = fakePorts({ packet: fresh, views: changed });
      await serviceFrom(fakes).execute({
        worker: { roleId: role, workerId: `employee-${role}` },
        item: fixture.item,
        contextPacket: original,
        intent: role === "orchestrator"
          ? orchestrate(commonAction("pause", fixture.child, fixture.view))
          : submitIntent(fixture),
      });
      const command = role === "orchestrator"
        ? fakes.calls.planner[0].command
        : fakes.calls.delivery[0];
      assert.equal(command.expectedGraphRevision, changed.graph.revision);
      assert.equal(original.binding.graphRevision, fixture.view.graph.revision);
    });
  }
});

test("scoped rebase rejects changed inputs, forged digests and intent revisions", async (t) => {
  for (const mutation of [
    "task", "source", "acceptedInputs", "contract", "originalDigest",
    "freshDigest", "intentRevision", "sameRevision", "rollback", "inconsistentGraph",
  ]) {
    await t.test(mutation, async () => {
      const fixture = rootFixture();
      if (mutation === "rollback") {
        fixture.view = graphView(fixture.view.graph.tasks, fixture.view.graph.revision + 1);
      }
      const changed = graphView([
        ...fixture.view.graph.tasks,
        task({ taskId: "unrelated-root" }),
      ], fixture.view.graph.revision + (mutation === "sameRevision" ? 0 : mutation === "rollback" ? -1 : 1));
      const original = signedContextPacket(fixture.packet, fixture.view);
      let fresh = signedContextPacket(original, changed);
      if (mutation === "task") fresh.binding.taskRevision += 1;
      if (mutation === "source") fresh.context.requirements.source = { head: "new" };
      if (mutation === "acceptedInputs") fresh.acceptedInputs = [{ changed: true }];
      if (mutation === "contract") fresh.binding.contractRevision += 1;
      fresh = signedContextPacket(fresh, changed);
      if (mutation === "inconsistentGraph") {
        fresh.context.requirements.graph.revision += 1;
        fresh.contextDigest = digest({
          domain: "mydashboard-role-context/v1",
          binding: fresh.binding,
          dataClasses: Object.keys(fresh.context).sort(),
          context: fresh.context,
        });
      }
      if (mutation === "originalDigest") original.contextDigest = "f".repeat(64);
      if (mutation === "freshDigest") fresh.contextDigest = "f".repeat(64);
      const action = commonAction("pause", fixture.child, fixture.view);
      if (mutation === "intentRevision") action.expectedGraphRevision = changed.graph.revision;
      const fakes = fakePorts({ packet: fresh, views: changed });
      await assert.rejects(serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: original,
        intent: orchestrate(action),
      }), (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE");
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

async function refreshedPrDeliveryFixture({ workerId = "employee-pr-engineer", evidenceCatalog,
  ciDiagnosticReader, checks = [], deliveryKind = "text-report", settlement = false,
  nextAction = "rereview", roleId = "pr-engineer" } = {}) {
  const originalAt = "2026-10-15T18:23:34.401Z";
  const refreshedAt = "2026-10-15T18:39:53.208Z";
  const state = { observedAt: originalAt, factObservedAt: originalAt, facts: { checks }, mutatePacket: null };
  const values = new Map();
  let writes = 0;
  const store = {
    async read(name, fallback = null) { return structuredClone(values.get(name) ?? fallback); },
    async write(name, value) { writes += 1; values.set(name, structuredClone(value)); },
  };
  const gitTarget = {
    schemaVersion: 1, provider: "github", sourceAccountId: "reviewer",
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40),
    headRepository: "acme/repo", headRefName: "fix", headRefOid: "b".repeat(40),
  };
  const event = normalizeWorkflowEvent({
    schemaVersion: 1, eventType: "pull_request.owner_requested", occurredAt: originalAt,
    source: { provider: "local-owner", scopeId: "owner-request:12345678-1234-4123-8123-123456789abc" },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { title: "Review current repair", workType: "general", nextAction, state: "open",
      suggestedCapability: "pr-review", expectedHeadRefOid: gitTarget.headRefOid,
      headRefOid: gitTarget.headRefOid, gitTargetAvailable: true, gitTarget },
  });
  const record = { sequence: 1, event, assignment: { assignmentId: "assignment-refresh",
    eventId: event.eventId, target: { type: "role", id: "orchestrator" }, reason: "review" } };
  const ledger = new WorkLedgerService({ store, idFactory: () => "refresh-lease", clock: () => "2026-10-15T18:34:00.000Z",
    exclusiveLease: { async run(operation) { return operation(); } },
    assignmentSource: { async readAssignmentBatch({ afterSequence }) {
      return { items: afterSequence < 1 ? [record] : [], nextSequence: 1,
        highWatermark: 1, oldestAvailableSequence: 1 };
    } },
  });
  await ledger.recover();
  await ledger.intake();
  const graph = new WorkGraphStore({ ledger });
  const graphReader = graph.reader();
  const root = (await ledger.listItems()).items[0];
  const planner = graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId: root.itemId });
  async function createChild(childKey) {
    const parent = (await ledger.listItems()).items.find(({ itemId }) => itemId === root.itemId);
    return planner.createChild({ parentTaskId: root.itemId, childKey,
      work: { title: childKey, description: "Assess every request against the pinned code" },
      target: { type: "role", id: roleId }, dependsOnTaskIds: [], leaseId: null,
      acceptanceContract: contract({ deliverableId: "rereview-report", kind: deliveryKind }),
      expectedGraphRevision: (await graphReader.getSnapshot()).graph.revision,
      expectedTaskRevisions: [{ taskId: parent.itemId, revision: parent.revision }] });
  }
  await createChild("rereview");
  let item = (await ledger.listItems()).items.find(({ kind }) => kind === "graph_task");
  item = await ledger.claim({ itemId: item.itemId, expectedRevision: item.revision,
    workerId, leaseDurationMs: 600_000 });
  const assembler = new RoleContextAssembler({ graphReader, evidenceCatalog, ciDiagnosticReader,
    ...(settlement ? { settlementInputAuthorityVerifier: { verify: binding => ledger.verifyPullRequestExecutionBinding(binding) },
      settlementEvidenceVerifier: evidenceCatalog } : {}),
    factSource: { async read({ fact }) { return { healthy: true, fresh: true,
      value: fact === "state" ? "open" : null, observedAt: state.factObservedAt }; } },
    pullRequestContextReader: { async read(input) {
      if (state.staleFacts) throw Object.assign(new Error("Canonical Base advanced"), { name: "GitHubReadError", code: "PR_FACTS_STALE", statusCode: 409 });
      const executionBinding = createPullRequestExecutionBinding(input);
      const identity = createPullRequestReadIdentity({ executionBinding, event: input.event });
      state.lastFacts = createPullRequestReadFacts({ identity,
        observedAt: state.observedAt, reviewDecision: "CHANGES_REQUESTED",
        comments: [{ id: "comment-1", author: "reviewer", body: "x".repeat(3_000), bodyTruncated: false,
          createdAt: originalAt, updatedAt: originalAt, url: "https://github.com/acme/repo/pull/42#issuecomment-1" }],
        reviews: [], reviewThreads: [], checks: [],
        truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false },
        ...state.facts });
      return projectPullRequestReadFactsContext(state.lastFacts);
    } },
  });
  const original = await assembler.assemble({ roleId, item, trigger: `employee:${roleId}` });
  let deliveryCalls = 0;
  const service = new OrchestratorService({ graphReader, clock: () => "2026-10-15T18:34:00.000Z",
    contextAssembler: { async assemble(input) {
      const packet = await assembler.assemble(input);
      return state.mutatePacket ? state.mutatePacket(structuredClone(packet)) : packet;
    } },
    scopedGraphPlannerFactory: { forRoot() { assert.fail("Specialist cannot obtain planner authority"); } },
    graphDelivererFactory: { forClaim({ workerId, ...authority }) {
      const deliverer = graph.deliverer({ principalId: workerId, ...authority });
      return { async submitDelivery(command) { deliveryCalls += 1; return deliverer.submitDelivery(command); } };
    } },
  });
  const intent = { schemaVersion: 1, type: "submit_delivery", taskId: item.itemId,
    expectedTaskRevision: item.revision, expectedGraphRevision: original.binding.graphRevision,
    contractRevision: 1, deliverableId: "rereview-report", summary: "Review complete",
    reason: "All requests assessed", evidence: [], artifact: null };
  return { ledger, graph, graphReader, assembler, root, state, original, item, intent, createChild, refreshedAt,
    store, writes: () => writes, deliveryCalls: () => deliveryCalls,
    execute: (packet = original, claimed = item) => service.execute({
      worker: { roleId, workerId },
      item: claimed, contextPacket: packet, intent }),
  };
}

async function publishedReviewSettlementFixture() {
  let proposal = null, result = null;
  const evidence = new DeliveryEvidenceService({ proposalResultReader: {
    async getResult() { return result; }, async getProposalForEvidence() { return proposal; },
    async getResultForProposal() { return result; },
    async listEvidenceCandidates() { return { items: result ? [{ proposal, result }] : [], nextBeforeSequence: null }; },
  } });
  const fixture = await refreshedPrDeliveryFixture({ evidenceCatalog: evidence, deliveryKind: "github-review", settlement: true });
  const { ledger, graph, graphReader, assembler, root, item } = fixture;
  const acceptance = fixture.original.context.requirements.currentTask.acceptanceContract;
  const reviewIntent = { schemaVersion: 1, type: "propose_github_review", summary: "Published original input Review",
    reason: "Complete bound diff assessed", verdict: "comment", body: "Original Head and Base reviewed.",
    deliverableId: "rereview-report", evidence: [`head:${"b".repeat(40)}`] };
  const bound = createWorkIntentPolicy({ githubReviewRoles: ["pr-engineer"] }).bind({
    context: { assignmentId: item.assignmentId, workItemId: item.itemId, roleId: "pr-engineer",
      event: currentWorkItemEvent(item), inputBinding: currentWorkItemExecutionBinding(item),
      evidenceTarget: { schemaVersion: 1, taskId: item.itemId, roleId: "pr-engineer", contractRevision: acceptance.revision,
        contractDigest: deliveryAcceptanceContractDigest(acceptance), deliverables: [{ deliverableId: "rereview-report", kind: "github-review" }] } },
    intent: reviewIntent,
  });
  const { intentId, ...content } = bound;
  proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...content });
  result = createWorkProposalResult({ proposal, sequence: 1, transition: { status: "succeeded", summary: "GitHub Review published",
    evidence: ["confirmation:historical-published-review"] }, downstreamRef: null, at: "2026-10-15T18:34:00.000Z" });
  const host = new OrchestratorService({ contextAssembler: assembler, graphReader, evidenceVerifier: evidence,
    clock: () => new Date("2026-10-15T18:34:00.000Z"),
    scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) { return graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId }); } },
    graphDelivererFactory: { forClaim({ workerId, ...authority }) { return graph.deliverer({ principalId: workerId, ...authority }); } },
  });
  const packet = await assembler.assemble({ roleId: "pr-engineer", item, trigger: "scheduled" });
  await host.execute({ worker: { roleId: "pr-engineer", workerId: "employee-pr-engineer" }, item, contextPacket: packet,
    intent: { ...fixture.intent, expectedGraphRevision: packet.binding.graphRevision, evidence: [packet.context.code.authoritativeEvidence[0].evidence] } });
  fixture.state.staleFacts = true;
  return { ...fixture, host, evidence, publication: structuredClone(result), readPublication: () => structuredClone(result),
    removePublication: () => { result = null; },
    changePublicationInput: () => { proposal = structuredClone(proposal); proposal.binding.inputBinding.gitTarget.baseRefOid = "c".repeat(40); } };
}

test("published Review settles its original input after Base movement without fresh review authority", async () => {
  const fixture = await publishedReviewSettlementFixture();
  const { ledger, graphReader, assembler, root, item, host } = fixture;
  const currentRoot = (await ledger.listItems()).items.find(entry => entry.itemId === root.itemId);
  const historical = await assembler.assemble({ roleId: "orchestrator", item: currentRoot, trigger: "scheduled" });
  assert.equal(historical.context.code.pullRequest, undefined);
  assert.equal(historical.context.code.reviewPublicationSettlement.inputBinding.gitTarget.baseRefOid, "a".repeat(40));
  const before = await graphReader.getSnapshot();
  const child = before.graph.tasks.find(entry => entry.taskId === item.itemId);
  await assert.rejects(host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: currentRoot, contextPacket: historical,
    intent: orchestrate({ ...commonAction("return_delivery", child, before), submittedDeliveryRevision: 1 }) }),
    { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
  assert.deepEqual(await graphReader.getSnapshot(), before);
  await host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: currentRoot, contextPacket: historical,
    intent: orchestrate({ ...commonAction("accept_delivery", child, before), submittedDeliveryRevision: 1 }) });
  assert.equal((await ledger.listItems()).items.find(entry => entry.itemId === item.itemId).status, "completed");
  assert.deepEqual(fixture.readPublication(), fixture.publication);
  const finalRoot = (await ledger.listItems()).items.find(entry => entry.itemId === root.itemId);
  const finalPacket = await assembler.assemble({ roleId: "orchestrator", item: finalRoot, trigger: "scheduled" });
  assert.equal(finalPacket.context.code.reviewPublicationSettlement.allAccepted, true);
  let nextIntent = orchestrate(commonAction("pause", child, before));
  const engine = new RoleDecisionEngine({ definition: { id: "orchestrator", name: "orchestrator", mission: "Settle the original published Review", enabled: true },
    permissions: { allowedIntents: ["complete", "orchestrate"] },
    brain: { provider: "local-fixture", model: "fixture", remoteData: { code: false, requirements: false, memory: false } },
    brainRouter: { describe: () => ({ singleAttempt: true }), generate: async () => JSON.stringify({ schemaVersion: 1, confidence: 90, summary: "Settle publication", intent: nextIntent }) },
  });
  await assert.rejects(engine.decide({ item: finalRoot, context: finalPacket.context }), { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  nextIntent = { schemaVersion: 1, type: "complete", summary: "Original Review published and accepted", reason: "Bound delivery accepted",
    outcome: "done", evidence: [] };
  const loop = new ProactiveWorkLoop({ ledger, roleContextAssembler: assembler, orchestratorService: host,
    clock: () => new Date("2026-10-15T18:34:00.000Z"),
    roleDirectory: { async resolve() { return { roleId: "orchestrator", workerId: "employee-orchestrator", enabled: true, paused: false,
      decide: input => engine.decide(input) }; } },
  });
  const completed = await loop.runCycle({ roleId: "orchestrator", workLimit: 1 });
  assert.equal(completed.staged, 1);
  assert.equal((await ledger.listItems()).items.find(entry => entry.itemId === root.itemId).status, "dispatch_pending");
  assert.equal((await ledger.listOutbox({ itemId: root.itemId, limit: 10 })).items.at(-1).intent.type, "complete");
});

test("historical Review settlement requires real publication and original input authority", async t => {
  for (const boundary of ["missing-publication", "wrong-input", "revoked-source"]) await t.test(boundary, async () => {
    const fixture = await publishedReviewSettlementFixture();
    const item = (await fixture.ledger.listItems()).items.find(entry => entry.itemId === fixture.root.itemId);
    if (boundary === "missing-publication") fixture.removePublication();
    if (boundary === "wrong-input") fixture.changePublicationInput();
    if (boundary === "revoked-source") fixture.ledger.verifyPullRequestExecutionBinding = async () => {
      throw Object.assign(new Error("Source no longer active"), { code: "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" });
    };
    const before = await fixture.graphReader.getSnapshot();
    await assert.rejects(fixture.assembler.assemble({ roleId: "orchestrator", item, trigger: "scheduled" }), error =>
      boundary === "revoked-source" ? error.code === "WORK_LEDGER_PR_EXECUTION_BINDING_STALE" :
        error.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" && error.cause?.code === "PR_FACTS_STALE");
    assert.deepEqual(await fixture.graphReader.getSnapshot(), before);
  });
});

test("historical Review settlement checks the complete graph rather than its delivery preview", async t => {
  for (const boundary of ["paused-child", "extra-child", "missing-required-slot", "local-report", "paused-root"]) await t.test(boundary, async () => {
    const fixture = await publishedReviewSettlementFixture();
    const view = structuredClone(await fixture.graphReader.getSnapshot());
    const child = view.graph.tasks.find(entry => entry.taskId === fixture.item.itemId);
    const childState = view.taskStates.find(entry => entry.taskId === child.taskId);
    const item = (await fixture.ledger.listItems()).items.find(entry => entry.itemId === fixture.root.itemId);
    if (boundary === "paused-child") { child.status = "paused"; childState.ledgerStatus = "paused"; }
    if (boundary === "extra-child") {
      const extra = structuredClone(child); extra.taskId += "/new"; extra.responsibility.id = "developer";
      view.graph.tasks.push(extra); view.taskStates.push({ ...structuredClone(childState), taskId: extra.taskId });
    }
    if (boundary === "missing-required-slot") child.acceptanceContracts.at(-1).expectedDeliverables.push({
      deliverableId: "zz-required-review", kind: "github-review", required: true, description: "Another required publication" });
    if (boundary === "local-report") child.acceptanceContracts.at(-1).expectedDeliverables[0].kind = "text-report";
    if (boundary === "paused-root") view.taskStates.find(entry => entry.taskId === item.itemId).ledgerStatus = "paused";
    view.graph = createWorkGraphSnapshot({ graphId: view.graph.graphId, revision: view.graph.revision, tasks: view.graph.tasks });
    const reader = new RoleContextAssembler({ graphReader: { getSnapshot: async () => view },
      settlementInputAuthorityVerifier: { verify: binding => fixture.ledger.verifyPullRequestExecutionBinding(binding) },
      settlementEvidenceVerifier: fixture.evidence,
      pullRequestContextReader: { read: async () => { throw Object.assign(new Error("Canonical Base advanced"), { code: "PR_FACTS_STALE" }); } },
    });
    await assert.rejects(reader.assemble({ roleId: "orchestrator", item, trigger: "scheduled" }), error =>
      error.code === "ROLE_CONTEXT_PR_FACT_UNAVAILABLE" && error.cause?.code === "PR_FACTS_STALE");
  });
});

test("child-only Review acceptance rearms the same durable root before its old no-progress backoff", async t => {
  for (const origin of ["current wake", "between wakes"]) await t.test(origin, async () => {
    const fixture = await publishedReviewSettlementFixture();
    const { ledger, graphReader, assembler, root, item, host } = fixture;
    let persisted, now = Date.parse("2026-10-15T18:34:00.000Z");
    const operations = [];
    const owner = operation => { const pending = operation(); operations.push(pending); return pending; };
    const drain = async () => { await Promise.all(operations.splice(0)); };
    const options = { ledger, clock: () => new Date(now),
      store: { read: async (_key, fallback) => structuredClone(persisted ?? fallback), write: async (_key, value) => { persisted = structuredClone(value); } },
      configurationReader: { readActive: async () => ({ configuration: { githubActions: { enabled: true, automaticReview: true } } }) },
      roleStateReader: { read: async () => ({ enabled: true, paused: false }) },
    };
    let scheduler = new WorkContinuationScheduler(options);
    for (let attempt = 0; attempt < 3; attempt++) {
      await scheduler.runCycle({ dispatch: async () => {}, runOperation: owner }); await drain(); now += 90_000;
    }
    assert.equal(persisted.records.find(entry => entry.itemId === root.itemId).status, "stalled");
    const parentBeforeAcceptance = (await ledger.listItems()).items.find(entry => entry.itemId === root.itemId);
    const accept = async () => {
      const current = (await ledger.listItems()).items.find(entry => entry.itemId === root.itemId);
      const packet = await assembler.assemble({ roleId: "orchestrator", item: current, trigger: "scheduled" });
      const view = await graphReader.getSnapshot();
      const child = view.graph.tasks.find(entry => entry.taskId === item.itemId);
      await host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: current, contextPacket: packet,
        intent: orchestrate({ ...commonAction("accept_delivery", child, view), submittedDeliveryRevision: 1 }) });
    };
    if (origin === "current wake") {
      now += 300_000;
      await scheduler.runCycle({ dispatch: accept, runOperation: owner }); await drain();
      const continuation = persisted.records.find(entry => entry.itemId === root.itemId);
      assert.equal(continuation.receipts.at(-1).outcome, "progressed");
      assert.equal(continuation.status, "pending");
      assert.equal(continuation.attempt, 0);
    } else await accept();
    assert.equal((await ledger.listItems()).items.find(entry => entry.itemId === root.itemId).revision, parentBeforeAcceptance.revision,
      "the actual acceptance changes only its child, not the root authority fingerprint");
    let completionCalls = 0;
    const loop = new ProactiveWorkLoop({ ledger, roleContextAssembler: assembler, orchestratorService: host,
      clock: () => new Date("2026-10-15T18:34:00.000Z"), roleDirectory: { async resolve() { return {
        roleId: "orchestrator", workerId: "employee-orchestrator", enabled: true, paused: false,
        decide: async () => ({ schemaVersion: 1, confidence: 90, summary: "Complete accepted publication", intent: {
          schemaVersion: 1, type: "complete", summary: "Original Review accepted", reason: "All required publication delivered", outcome: "done", evidence: [],
        } }),
      }; } } });
    scheduler = new WorkContinuationScheduler(options);
    await scheduler.runCycle({ runOperation: owner, dispatch: async ({ continuationTarget }) => {
      completionCalls++;
      assert.equal(continuationTarget.itemId, root.itemId);
      return loop.runCycle({ roleId: "orchestrator", workLimit: 1, continuationTarget });
    } });
    await drain();
    assert.equal(completionCalls, 1, "related progress must run the next step without advancing the retry clock");
    assert.equal((await ledger.listItems()).items.find(entry => entry.itemId === root.itemId).status, "dispatch_pending");
  });
});

test("legacy external rereview returns its local report, cancels it, and publishes one authoritative replacement", async () => {
  let proposal = null;
  let publishedResult = null;
  const evidence = new DeliveryEvidenceService({ proposalResultReader: {
    async getResult() { return publishedResult; },
    async getProposalForEvidence() { return proposal; },
    async getResultForProposal() { return publishedResult; },
    async listEvidenceCandidates() { return { items: publishedResult ? [{ proposal, result: publishedResult }] : [], nextBeforeSequence: null }; },
  } });
  const fixture = await refreshedPrDeliveryFixture({ workerId: "configured-pr-engineer", evidenceCatalog: evidence });
  const { ledger, graph, graphReader, assembler, root } = fixture;
  const clock = () => new Date("2026-10-15T18:34:00.000Z");
  const host = new OrchestratorService({ contextAssembler: assembler, graphReader, evidenceVerifier: evidence, clock,
    scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) { return graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId }); } },
    graphDelivererFactory: { forClaim({ workerId, ...authority }) { return graph.deliverer({ principalId: workerId, ...authority }); } },
    capabilityRoles: { "pr-review": "pr-engineer" },
  });
  const currentItem = async (itemId) => (await ledger.listItems()).items.find((item) => item.itemId === itemId);
  async function rootContext() {
    const item = await currentItem(root.itemId);
    return { item, packet: await assembler.assemble({ roleId: "orchestrator", item, trigger: "scheduled" }),
      view: await graphReader.getSnapshot() };
  }
  async function rootAction(type, taskId, extra = {}) {
    const { item, packet, view } = await rootContext();
    const source = view.graph.tasks.find((task) => task.taskId === taskId);
    return host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item, contextPacket: packet,
      intent: orchestrate({ ...commonAction(type, source, view), ...extra }) });
  }
  function engine(roleId, intent) {
    return new RoleDecisionEngine({ definition: { id: roleId, name: roleId, mission: "Complete the bound review", enabled: true },
      permissions: { allowedIntents: ["complete", "orchestrate", "propose_github_review", "submit_delivery"] },
      brain: { provider: "local-fixture", model: "fixture", remoteData: { code: false, requirements: false, memory: false } },
      brainRouter: { describe: () => ({ singleAttempt: true }), generate: async () => JSON.stringify({ schemaVersion: 1, confidence: 90, summary: "Review result", intent }) } });
  }
  const completion = { schemaVersion: 1, type: "complete", summary: "Published", reason: "Required review accepted", outcome: "done", evidence: [] };
  await fixture.execute();
  const oldId = fixture.item.itemId;
  await assert.rejects(rootAction("accept_delivery", oldId, { submittedDeliveryRevision: 1 }), { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
  await assert.rejects(engine("orchestrator", completion).decide({ context: (await rootContext()).packet.context }),
    { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  await rootAction("return_delivery", oldId, { submittedDeliveryRevision: 1 });
  const oldBeforeCancel = await currentItem(oldId);
  await rootAction("cancel", oldId);
  const oldCancelled = await currentItem(oldId);
  assert.equal(oldCancelled.status, "cancelled");
  assert.equal(oldCancelled.attempt, oldBeforeCancel.attempt);
  assert.deepEqual(oldCancelled.graph.deliveries, oldBeforeCancel.graph.deliveries);
  const create = await rootContext();
  const mixedContract = contract({ deliverableId: "published-review", kind: "github-review" });
  for (let index = 1; index <= 4; index++) mixedContract.expectedDeliverables.push({
    deliverableId: `aa-support-${index}`, kind: "text-report", description: "Review coverage notes", required: true });
  const decomposeIntent = orchestrate({ ...commonAction("decompose", create.view.graph.tasks.find(({ taskId }) => taskId === root.itemId), create.view),
    childKey: "authoritative-rereview-v2", capability: "pr-review", dependsOn: [],
    work: { title: "Publish review", description: "Read the full bound Head and publish the verified Review" },
    acceptanceContract: mixedContract });
  const checked = await engine("orchestrator", decomposeIntent).decide({ context: create.packet.context });
  const created = await host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: create.item, contextPacket: create.packet, intent: checked.intent });
  assert.notEqual(created.taskId, oldId);
  let specialist = await currentItem(created.taskId);
  specialist = await ledger.claim({ itemId: specialist.itemId, expectedRevision: specialist.revision,
    workerId: "configured-pr-engineer", leaseDurationMs: 600_000 });
  let packet = await assembler.assemble({ roleId: "pr-engineer", item: specialist, trigger: "scheduled" });
  assert.equal(packet.context.requirements.currentTask.acceptanceContract.expectedDeliverables.find(({ deliverableId }) => deliverableId === "published-review").kind, "github-review");
  assert.equal(packet.context.code.authoritativeEvidence, undefined);
  const forgedSubmission = { schemaVersion: 1, type: "submit_delivery", taskId: specialist.itemId,
    expectedTaskRevision: specialist.revision, expectedGraphRevision: packet.binding.graphRevision,
    contractRevision: 1, deliverableId: "published-review", summary: "Claimed publication", reason: "Unverified model assertion",
    evidence: [{ kind: "github-review", referenceId: `work-proposal-result-${"c".repeat(64)}`, contentDigest: "c".repeat(64) }], artifact: null };
  const beforeForgery = await graphReader.getSnapshot();
  await assert.rejects(host.execute({ worker: { roleId: "pr-engineer", workerId: "configured-pr-engineer" },
    item: specialist, contextPacket: packet, intent: forgedSubmission }), { code: "ORCHESTRATOR_EVIDENCE_REJECTED" });
  assert.deepEqual(await graphReader.getSnapshot(), beforeForgery);
  const reviewIntent = { schemaVersion: 1, type: "propose_github_review", summary: "Current Head reviewed",
    reason: "Full diff and feedback assessed", verdict: "comment", body: "Reviewed current Head; independent coverage is limited.",
    deliverableId: "published-review", evidence: [`head:${"b".repeat(40)}`, "review-skill/SKILL.md"] };
  const reviewed = await engine("pr-engineer", reviewIntent).decide({ item: specialist, context: packet.context });
  const acceptance = packet.context.requirements.currentTask.acceptanceContract;
  const bound = createWorkIntentPolicy({ githubReviewRoles: ["pr-engineer"], capabilityRoles: { "pr-review": "pr-engineer" } }).bind({
    context: { assignmentId: specialist.assignmentId, workItemId: specialist.itemId, roleId: "pr-engineer",
      event: currentWorkItemEvent(specialist), inputBinding: currentWorkItemExecutionBinding(specialist),
      evidenceTarget: { schemaVersion: 1, taskId: specialist.itemId, roleId: "pr-engineer", contractRevision: acceptance.revision,
        contractDigest: deliveryAcceptanceContractDigest(acceptance), deliverables: [{ deliverableId: "published-review", kind: "github-review" }] } },
    intent: reviewed.intent,
  });
  const { intentId, ...proposalContent } = bound;
  proposal = normalizeBoundWorkProposal({ proposalId: intentId, ...proposalContent });
  let externalWrites = 0;
  const queueValues = new Map();
  const queue = new ConfirmationQueue({
    store: { async read(name, fallback) { return structuredClone(queueValues.get(name) ?? fallback); }, async write(name, value) { queueValues.set(name, structuredClone(value)); } },
    exclusiveLease: { async run(operation) { return operation(); } }, clock,
    executor: { async execute(envelope) { externalWrites += 1; assert.equal(envelope.target.version, "b".repeat(40));
      return { status: "applied", receipt: { id: "review-42", url: "https://github.com/acme/repo/pull/42#pullrequestreview-42", createdAt: clock().toISOString() } }; },
      async reconcile() { assert.fail("No external replay is needed"); } },
  });
  await queue.recover();
  const publisher = new AutomaticReviewPublisher({ enabled: true, queue, clock, github: { async readIncomingReviewRequest() {
    return { kind: "pull_request", state: "open", isDraft: false, author: "developer", currentUser: "reviewer",
      headRefOid: "b".repeat(40), incomingReviewFactsAvailable: true, reviewRecipient: "reviewer",
      reviewReceivedAt: "2026-10-15T18:00:00Z", reviewReceivedVia: "assignee", reviewReceivedFrom: "developer", reviewRequestEventId: "AE_42" };
  } } });
  const handler = new GitHubReviewProposalHandler({ confirmationProducer: queue, automaticReviewPublisher: publisher, actorAccountId: "reviewer", clock,
    inputAuthorityVerifier: { async verify(value) { return structuredClone(value); } },
    pullRequestContextReader: { async readCurrent(value) { return { inputBinding: structuredClone(value), author: "developer" }; } },
  });
  const handlerInput = { proposal, status: "pending_delivery", attempt: 1, downstreamRef: null };
  const transition = await handler.handle(handlerInput);
  assert.equal(transition.status, "succeeded");
  assert.equal((await handler.handle(handlerInput)).status, "succeeded");
  assert.equal(externalWrites, 1);
  publishedResult = createWorkProposalResult({ proposal, sequence: 1, transition, downstreamRef: null, at: clock().toISOString() });
  packet = await assembler.assemble({ roleId: "pr-engineer", item: specialist, trigger: "scheduled" });
  const descriptor = packet.context.code.authoritativeEvidence[0];
  assert.equal(descriptor.deliverableId, "published-review");
  assert.equal(descriptor.evidence.kind, "github-review");
  const submit = { schemaVersion: 1, type: "submit_delivery", taskId: specialist.itemId, expectedTaskRevision: specialist.revision,
    expectedGraphRevision: packet.binding.graphRevision, contractRevision: acceptance.revision, deliverableId: "published-review",
    summary: "Published the bound current Head Review", reason: "Host publication receipt verified", evidence: [descriptor.evidence], artifact: null };
  const submitted = await engine("pr-engineer", submit).decide({ item: specialist, context: packet.context });
  await host.execute({ worker: { roleId: "pr-engineer", workerId: "configured-pr-engineer" }, item: specialist, contextPacket: packet, intent: submitted.intent });
  await rootAction("accept_delivery", specialist.itemId, { submittedDeliveryRevision: 1 });
  assert.notEqual((await currentItem(specialist.itemId)).status, "completed");
  await assert.rejects(engine("orchestrator", completion).decide({ context: (await rootContext()).packet.context }),
    { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  for (let index = 1; index <= 4; index++) {
    specialist = await currentItem(specialist.itemId);
    specialist = await ledger.claim({ itemId: specialist.itemId, expectedRevision: specialist.revision,
      workerId: "configured-pr-engineer", leaseDurationMs: 600_000 });
    packet = await assembler.assemble({ roleId: "pr-engineer", item: specialist, trigger: "scheduled" });
    const support = { ...submit, deliverableId: `aa-support-${index}`, expectedTaskRevision: specialist.revision,
      expectedGraphRevision: packet.binding.graphRevision, summary: "Actual independent coverage and test limitations", evidence: [] };
    const checkedSupport = await engine("pr-engineer", support).decide({ item: specialist, context: packet.context });
    await host.execute({ worker: { roleId: "pr-engineer", workerId: "configured-pr-engineer" }, item: specialist, contextPacket: packet, intent: checkedSupport.intent });
    await rootAction("accept_delivery", specialist.itemId, { submittedDeliveryRevision: index * 2 + 1 });
  }
  assert.equal((await currentItem(specialist.itemId)).status, "completed");
  const finalContext = (await rootContext()).packet.context;
  assert.equal((await engine("orchestrator", completion).decide({ context: finalContext })).intent.type, "complete");
  const completed = finalContext.requirements.coordination.directChildren.find(({ taskId }) => taskId === specialist.itemId);
  assert.equal(completed.deliverables.length, 4);
  assert.equal(completed.hasMoreDeliverables, true);
  assert.equal(completed.hasAcceptedRequiredReview, true);
  assert.equal(completed.deliverables.every(({ kind }) => kind === "text-report"), true);
  assert.equal((await graphReader.getSnapshot()).graph.tasks.length, 3);
  assert.equal((await currentItem(oldId)).status, "cancelled");
  assert.equal(externalWrites, 1);
});

test("automatic rereview correction preserves a deliberately paused malformed child", async (t) => {
  for (const handedBack of [false, true]) await t.test(handedBack ? "after coordination handoff" : "PR engineer", async () => {
    const fixture = await refreshedPrDeliveryFixture();
    const { ledger, graph, graphReader, assembler, root } = fixture;
    await fixture.execute();
    const planner = graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId: root.itemId });
    const childId = fixture.item.itemId;
    const child = async () => (await ledger.listItems()).items.find(({ itemId }) => itemId === childId);
    let current = await child();
    await planner.decideDelivery({ taskId: childId, submittedDeliveryRevision: 1, decision: "reject", reason: "Return local report",
      expectedTaskRevision: current.revision, expectedGraphRevision: (await graphReader.getSnapshot()).graph.revision });
    current = await child();
    if (handedBack) {
      current = await ledger.claim({ itemId: current.itemId, expectedRevision: current.revision,
        workerId: "employee-pr-engineer", leaseDurationMs: 600_000 });
      current = await ledger.handoff({ itemId: current.itemId, expectedRevision: current.revision,
        leaseId: current.leaseId, actorId: "employee-pr-engineer", target: { type: "role", id: "orchestrator" },
        reason: "Correction requires a typed Review child" });
    }
    await planner.pauseTask({ taskId: childId, reason: "Intentional suspension",
      expectedTaskRevision: current.revision, expectedGraphRevision: (await graphReader.getSnapshot()).graph.revision });
    const paused = await child();
    const item = (await ledger.listItems()).items.find(({ itemId }) => itemId === root.itemId);
    const packet = await assembler.assemble({ roleId: "orchestrator", item, trigger: "scheduled" });
    const view = await graphReader.getSnapshot();
    const host = new OrchestratorService({ contextAssembler: assembler, graphReader,
      scopedGraphPlannerFactory: { forRoot() { return planner; } },
      graphDelivererFactory: { forClaim() { assert.fail("Root cannot submit specialist delivery"); } },
      capabilityRoles: { "pr-review": "pr-engineer" } });
    const before = await graphReader.getSnapshot();
    await assert.rejects(host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item, contextPacket: packet, intent: orchestrate(commonAction("cancel", view.graph.tasks.find(({ taskId }) => taskId === childId), view)) }),
      { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
    assert.deepEqual(await child(), paused);
    assert.deepEqual(await graphReader.getSnapshot(), before);
  });
});

test("settled malformed external rereview cannot be paused and converges through cancellation and a typed child", async (t) => {
  for (const scenario of [
    ...["queued", "retry_wait", "blocked"].map((ledgerStatus) => ({ ledgerStatus })),
    { ledgerStatus: "queued", handedBack: true },
  ]) {
    const { ledgerStatus, handedBack } = scenario;
    await t.test(`${ledgerStatus}${handedBack ? " after coordination handoff" : ""}`, async () => {
      const fixture = await refreshedPrDeliveryFixture();
      const { ledger, graph, graphReader, assembler, root } = fixture;
      let child = fixture.item;
      if (handedBack) {
        child = await ledger.handoff({ itemId: child.itemId, expectedRevision: child.revision,
          leaseId: child.leaseId, actorId: "employee-pr-engineer", target: { type: "role", id: "orchestrator" },
          reason: "Correction requires a typed Review child" });
      } else if (ledgerStatus === "blocked") {
        child = await ledger.transition({ itemId: child.itemId, expectedRevision: child.revision,
          leaseId: child.leaseId, actorId: "employee-pr-engineer", toStatus: "blocked", reason: "delivery_attempts_exhausted" });
      } else {
        child = await ledger.scheduleRetry({ itemId: child.itemId, expectedRevision: child.revision,
          leaseId: child.leaseId, actorId: "employee-pr-engineer", availableAt: "2026-10-15T18:35:00.000Z", reason: "delivery_failed" });
        if (ledgerStatus === "queued") child = await ledger.transition({ itemId: child.itemId,
          expectedRevision: child.revision, leaseId: null, actorId: "work-retry-waker", toStatus: "queued", reason: "retry_due" });
      }
      assert.equal(child.status, ledgerStatus);
      if (handedBack) {
        const currentRoot = (await ledger.listItems()).items.find(({ itemId }) => itemId === root.itemId);
        const packet = await assembler.assemble({ roleId: "orchestrator", item: currentRoot, trigger: "scheduled" });
        const engine = new RoleDecisionEngine({ definition: { id: "orchestrator", name: "Orchestrator", mission: "Coordinate review", enabled: true },
          permissions: { allowedIntents: ["complete"] },
          brain: { provider: "local-fixture", model: "fixture", remoteData: { code: false, requirements: false, memory: false } },
          brainRouter: { describe: () => ({ singleAttempt: true }), generate: async () => JSON.stringify({ schemaVersion: 1,
            confidence: 90, summary: "Review assessment", intent: { schemaVersion: 1, type: "complete", summary: "Reported locally",
              reason: "Specialist handed back findings", outcome: "done", evidence: [] } }) } });
        await assert.rejects(engine.decide({ context: packet.context }), { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
      }
      let plannerCalls = 0;
      const host = new OrchestratorService({ contextAssembler: assembler, graphReader,
        scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) {
          plannerCalls += 1;
          return graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId });
        } },
        graphDelivererFactory: { forClaim() { assert.fail("Root cannot submit specialist delivery"); } },
        capabilityRoles: { "pr-review": "pr-engineer" } });
      async function action(type, taskId, extra = {}) {
        const item = (await ledger.listItems()).items.find(({ itemId }) => itemId === root.itemId);
        const packet = await assembler.assemble({ roleId: "orchestrator", item, trigger: "scheduled" });
        const view = await graphReader.getSnapshot();
        const source = view.graph.tasks.find(({ taskId: id }) => id === taskId);
        return host.execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item, contextPacket: packet,
          intent: orchestrate({ ...commonAction(type, source, view), ...extra }) });
      }
      const before = await graphReader.getSnapshot();
      const writes = fixture.writes();
      await assert.rejects(action("pause", child.itemId), { code: "ORCHESTRATOR_AUTHORITY_DENIED" });
      assert.equal(plannerCalls, 0, "wrong pause must be rejected before obtaining planner authority");
      assert.equal(fixture.writes(), writes);
      assert.deepEqual(await graphReader.getSnapshot(), before);
      await action("cancel", child.itemId);
      const cancelled = (await ledger.listItems()).items.find(({ itemId }) => itemId === child.itemId);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.attempt, child.attempt);
      assert.deepEqual(cancelled.graph.deliveries, child.graph.deliveries);
      await action("decompose", root.itemId, { childKey: "authoritative-rereview-v2", capability: "pr-review", dependsOn: [],
        work: { title: "Publish current review", description: "Assess the bound Head and publish the authoritative Review" },
        acceptanceContract: contract({ deliverableId: "published-review", kind: "github-review" }) });
      const children = (await ledger.listItems()).items.filter(({ graph: metadata }) => metadata?.parentItemId === root.itemId);
      assert.equal(children.length, 2);
      const replacement = children.find(({ itemId }) => itemId !== child.itemId);
      assert.equal(replacement.status, "queued");
      assert.equal(replacement.graph.acceptanceContracts.at(-1).expectedDeliverables[0].kind, "github-review");
      assert.equal(replacement.graph.acceptanceContracts.at(-1).expectedDeliverables[0].required, true);
    });
  }
});

test("settled rereview pause guard preserves other task controls and full contract evidence", async (t) => {
  const scenarios = [
    ...["working", "dispatch_pending", "waiting_user", "waiting_condition", "waiting_external", "paused"].map((ledgerStatus) =>
      ({ name: ledgerStatus, ledgerStatus, graphStatus: ledgerStatus === "paused" ? "paused" : "in_progress" })),
    { name: "missing ledger status", ledgerStatus: null, graphStatus: "in_progress" },
    { name: "different specialist", ledgerStatus: "blocked", graphStatus: "in_progress", role: "developer" },
    { name: "ordinary analysis", ledgerStatus: "blocked", graphStatus: "in_progress", nextAction: "analyze" },
    { name: "internal review", ledgerStatus: "blocked", graphStatus: "in_progress", internalReview: true },
    { name: "authoritative fifth deliverable", ledgerStatus: "blocked", graphStatus: "in_progress", authoritativeTail: true },
    { name: "submitted local report", ledgerStatus: "blocked", graphStatus: "in_progress", delivery: "submitted" },
    { name: "accepted historical report", ledgerStatus: "blocked", graphStatus: "in_progress", delivery: "accepted" },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const root = task({ taskId: "rereview-root" });
    const child = task({ taskId: "rereview-root/old", revision: 2, parentTaskId: root.taskId, status: scenario.graphStatus,
      role: scenario.role ?? "pr-engineer", acceptanceContract: contract({ kind: "text-report" }) });
    if (scenario.authoritativeTail) {
      child.acceptanceContracts[0].expectedDeliverables = Array.from({ length: 5 }, (_, index) => ({
        deliverableId: `delivery-${index}`, kind: index === 4 ? "github-review" : "text-report", description: "Expected review result", required: true }));
    }
    if (scenario.delivery) {
      child.deliveries = [{ revision: 1, contractRevision: 1, deliverableId: "implementation", status: "submitted",
        summary: "Local findings", evidence: [workInputEvidence(child)] }];
      if (scenario.delivery === "accepted") child.deliveries.push({ ...child.deliveries[0], revision: 2, status: "accepted" });
    }
    const view = graphView([root, child], 3);
    const event = structuredTriageEvent("pr-review"); event.payload.nextAction = scenario.nextAction ?? "rereview";
    const packet = packetFor(view, root, { directChildren: [child], event });
    packet.context.requirements.coordination.directChildren[0].ledgerStatus = scenario.ledgerStatus;
    if (scenario.internalReview) packet.context.code.internalReview = { kind: "developer_handoff" };
    const fakes = fakePorts({ packet, views: view });
    const result = await serviceFrom(fakes).execute({ worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: itemFor(root), contextPacket: packet, intent: orchestrate(commonAction("pause", child, view)) });
    assert.equal(result.action, "pause");
    assert.equal(fakes.calls.planner[0].method, "pauseTask", "existing ledger safety checks still own this task control");
  });
});

test("configured PR engineer delivers a multiline review report through the real graph", async () => {
  const fixture = await refreshedPrDeliveryFixture({ workerId: "configured-pr-engineer" });
  const summary = "## 复审结论\n\n- 已核对当前 Head 的完整差异\r\n\t已逐项核对原始反馈\r保留独立审查及产品验证限制";
  fixture.intent.summary = summary;
  fixture.state.observedAt = fixture.refreshedAt;
  fixture.state.factObservedAt = fixture.refreshedAt;

  const result = await fixture.execute();

  assert.equal(result.applied, true);
  assert.equal(fixture.deliveryCalls(), 1);
  const submitted = (await fixture.graphReader.getSnapshot()).graph.tasks
    .find(({ taskId }) => taskId === fixture.item.itemId).deliveries;
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].status, "submitted");
  assert.equal(submitted[0].summary, summary);
});

test("complete unchanged PR facts refresh without repeating the specialist decision", async (t) => {
  for (const advanceGraph of [false, true]) {
    await t.test(advanceGraph ? "unrelated graph advances" : "same graph", async () => {
      const fixture = await refreshedPrDeliveryFixture();
      assert.equal(fixture.original.context.code.pullRequest.contextTruncated, true);
      fixture.state.observedAt = fixture.refreshedAt;
      fixture.state.factObservedAt = fixture.refreshedAt;
      if (advanceGraph) await fixture.createChild("unrelated");
      const result = await fixture.execute();
      assert.equal(result.applied, true);
      assert.equal(fixture.deliveryCalls(), 1);
      const submitted = (await fixture.graphReader.getSnapshot()).graph.tasks
        .find(({ taskId }) => taskId === fixture.item.itemId).deliveries;
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].status, "submitted");
      assert.equal(fixture.original.context.code.pullRequest.observedAt, "2026-10-15T18:23:34.401Z");
    });
  }
});

async function refreshedJenkinsDeliveryFixture() {
  const buildUrl = "http://jenkins.example/job/QuickTest/1758/";
  const state = { now: Date.parse("2026-10-15T18:23:34.401Z"), building: false,
    result: "FAILURE", console: `HEAD is now at ${"b".repeat(11)} merge base
[INFO] Branch: fix  SHA: ${"b".repeat(40)}
[ RUN      ] CodeTest.Includes
${"unchanged failure detail\n".repeat(240)}
[  FAILED  ] CodeTest.Includes (12 ms)
Finished: FAILURE` };
  const ciDiagnosticReader = new JenkinsCiDiagnostics({ clock: () => state.now,
    credentialSource: { async acquire() { return { username: "fixture", password: "fixture", version: "v1" }; } },
    fetchImpl: async (url) => new Response(url.endsWith("api/json")
      ? JSON.stringify({ number: 1758, building: state.building, result: state.result }) : state.console),
  });
  const fixture = await refreshedPrDeliveryFixture({ ciDiagnosticReader,
    checks: [{ kind: "check_run", name: "QuickTest", status: "COMPLETED", conclusion: "FAILURE",
      url: buildUrl, startedAt: null, completedAt: null, requirement: "required" }] });
  assert.equal(fixture.original.context.code.ciDiagnostics.reports[0].state, "available");
  return { ...fixture, jenkins: state, refresh() {
    state.now = Date.parse(fixture.refreshedAt);
    fixture.state.observedAt = fixture.refreshedAt;
    fixture.state.factObservedAt = fixture.refreshedAt;
  } };
}

test("expired Jenkins cache refresh with identical terminal build evidence preserves the pending decision", async () => {
  const fixture = await refreshedJenkinsDeliveryFixture();
  fixture.refresh();
  const before = structuredClone(fixture.original);
  const result = await fixture.execute();
  assert.equal(result.applied, true);
  assert.equal(fixture.deliveryCalls(), 1);
  assert.deepEqual(fixture.original, before, "refresh must not rewrite the model's original evidence");
});

test("root CI repair decomposition survives a Jenkins refresh and unrelated graph progress", async () => {
  const ci = await refreshedJenkinsDeliveryFixture();
  const fixture = rootFixture();
  fixture.packet.context.code = structuredClone(ci.original.context.code);
  fixture.packet.context.code.sourceEvent.payload.nextAction = "fix_ci";
  fixture.packet.context.code.sourceEvent.payload.suggestedCapability = "development";
  const original = signedContextPacket(fixture.packet, fixture.view);
  ci.refresh();
  const refreshed = await ci.assembler.assemble({ roleId: "pr-engineer", item: ci.item,
    trigger: "employee:pr-engineer" });
  const progressed = graphView([...fixture.view.graph.tasks, task({ taskId: "unrelated" })], fixture.view.graph.revision + 1);
  const fresh = signedContextPacket({ ...original, context: { ...original.context,
    code: { ...original.context.code, ciDiagnostics: refreshed.context.code.ciDiagnostics } } }, progressed);
  const fakes = fakePorts({ packet: fresh, views: progressed });
  const result = await new OrchestratorService({ ...fakes.ports, automaticMode: true,
    capabilityRoles: { development: "developer" } }).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" }, item: fixture.item,
    contextPacket: original, intent: orchestrate({ ...commonAction("decompose", fixture.root, fixture.view),
      childKey: "ci-repair-continuation", work: { title: "Continue CI repair", description: "Use current host CI evidence" },
      capability: "development", dependsOn: [], acceptanceContract: contract() }),
  });
  assert.equal(result.applied, true);
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(fakes.calls.planner[0].method, "createChild");
  assert.equal(fakes.calls.planner[0].command.expectedGraphRevision, progressed.graph.revision);
});

test("Jenkins observation refresh retains material, complete-log and digest stale checks", async (t) => {
  const changes = {
    "different failure": (f) => { f.jenkins.console = f.jenkins.console.replace("unchanged failure detail", "new failure detail"); },
    "hidden console content": (f) => { f.jenkins.console = f.jenkins.console.replace(
      "unchanged failure detail\n".repeat(100), "unchanged failure detail\n".repeat(99) + "hidden new failure detail\n"); },
    "different result": (f) => { f.jenkins.result = "UNSTABLE"; },
    "still building": (f) => { f.jenkins.building = true; f.jenkins.result = null; },
    "checkout changed": (f) => { f.jenkins.console = f.jenkins.console.replaceAll("b".repeat(40), "c".repeat(40)); },
    "observation rollback": (f) => { f.jenkins.now = Date.parse("2026-10-15T18:20:00.000Z"); },
  };
  const packetChanges = {
    "invalid report digest": (d) => { d.reports[0].contentDigest = "f".repeat(64); },
    "missing complete material digest": (d) => { delete d.reports[0].materialDigest; },
    "changed complete material digest": (d) => { d.reports[0].materialDigest = "f".repeat(64); },
    "different build": (d) => { d.reports[0].buildNumber += 1; },
    "different repository": (d) => { d.repository = "acme/other"; },
    "different Head": (d) => { d.headRefOid = "d".repeat(40); },
    "new evidence field": (d) => { d.reports[0].newEvidence = "changed"; },
    "changed truncation": (d) => { d.reports[0].failuresTruncated = !d.reports[0].failuresTruncated; },
  };
  for (const [name, mutate] of Object.entries(packetChanges)) changes[name] = (fixture) => {
    fixture.state.mutatePacket = (packet) => {
      const d = packet.context.code.ciDiagnostics;
      mutate(d);
      if (name !== "invalid report digest") {
        const { contentDigest, ...material } = d.reports[0];
        d.reports[0].contentDigest = canonicalJsonDigest(material);
      }
      const { contentDigest, ...material } = d;
      d.contentDigest = canonicalJsonDigest(material);
      return signedContextPacket(packet, { graph: { graphId: packet.binding.graphId,
        revision: packet.binding.graphRevision, contentDigest: packet.binding.graphContentDigest } });
    };
  };
  for (const [name, mutate] of Object.entries(changes)) await t.test(name, async () => {
    const fixture = await refreshedJenkinsDeliveryFixture();
    fixture.refresh();
    mutate(fixture);
    if (name === "hidden console content") {
      const fresh = await fixture.assembler.assemble({ roleId: "pr-engineer", item: fixture.item,
        trigger: "employee:pr-engineer" });
      const originalReport = fixture.original.context.code.ciDiagnostics.reports[0];
      const freshReport = fresh.context.code.ciDiagnostics.reports[0];
      assert.deepEqual(freshReport.failures, originalReport.failures, "the changed log lies outside visible excerpts");
      assert.notEqual(freshReport.materialDigest, originalReport.materialDigest);
    }
    const writes = fixture.writes();
    await assert.rejects(fixture.execute(), { code: "ORCHESTRATOR_CONTEXT_STALE" });
    assert.equal(fixture.deliveryCalls(), 0);
    assert.equal(fixture.writes(), writes);
  });
});

test("PR observation refresh preserves material, authority and full packet stale checks", async (t) => {
  const packetChanges = {
    "fact value": (packet) => { packet.context.code.facts[0].value = "closed"; },
    "fact name": (packet) => { packet.context.code.facts[0].name = "reviewDecision"; },
    "added fact": (packet) => { packet.context.code.facts.push({ ...packet.context.code.facts[0], name: "reviewDecision" }); },
    "removed fact": (packet) => { packet.context.code.facts = []; },
    "accepted inputs": (packet) => { packet.acceptedInputs = [{ changed: true }]; },
    "role permission": (packet) => { packet.binding.roleId = "developer"; },
    "source revision": (packet) => { packet.binding.source.inputRevision += 1; },
    "current task revision": (packet) => { packet.binding.taskRevision += 1; },
    "Head": (packet) => { packet.binding.source.headRefOid = "d".repeat(40); },
    "Base": (packet) => { packet.context.code.sourceEvent.payload.gitTarget.baseRefOid = "d".repeat(40); },
    "unknown business field": (packet) => { packet.context.code.newMaterial = "changed"; },
    "contradictory summary digest": (packet) => { packet.context.code.pullRequest.summary.contentDigest = "f".repeat(64); },
    "missing fresh proof": (packet) => { delete packet.context.code.pullRequest.materialDigest; },
    "changed proof": (packet) => { packet.context.code.pullRequest.materialDigest = "f".repeat(64); },
    "invalid proof": (packet) => { packet.context.code.pullRequest.materialDigest = "invalid"; },
    "receipt digest changes without observation advance": (packet) => {
      packet.context.code.pullRequest.observedAt = "2026-10-15T18:23:34.401Z";
    },
    "same revision graph digest": (packet) => {
      packet.binding.graphContentDigest = "f".repeat(64);
      packet.context.requirements.graph.contentDigest = "f".repeat(64);
    },
    "graph rollback": (packet) => {
      packet.binding.graphRevision -= 1;
      packet.context.requirements.graph.revision -= 1;
    },
  };
  const cases = [...Object.entries(packetChanges).map(([name, change]) => ({ name, setup(fixture) {
    fixture.state.mutatePacket = (packet) => {
      change(packet);
      return signedContextPacket(packet, { graph: { graphId: packet.binding.graphId,
        revision: packet.binding.graphRevision, contentDigest: packet.binding.graphContentDigest } });
    };
  } })),
  { name: "hidden comment tail", setup(fixture) {
    fixture.state.facts.comments = fixture.state.lastFacts.comments.map((entry) => ({ ...entry, body: `${entry.body.slice(0, -1)}y` }));
  } },
  { name: "same Head feedback changes", setup(fixture) { fixture.state.facts.reviewDecision = "APPROVED"; } },
  { name: "same Head checks change", setup(fixture) { fixture.state.facts.checks = [{ kind: "check_run", name: "build",
    status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/acme/repo/actions/runs/1",
    startedAt: null, completedAt: null, requirement: "required" }]; } },
  { name: "incomplete facts", setup(fixture) { fixture.state.facts.truncation = {
    ...fixture.state.lastFacts.truncation, comments: true }; } },
  { name: "PR observation rollback", setup(fixture) { fixture.state.observedAt = "2026-10-15T18:20:00.000Z"; } },
  { name: "fact observation rollback", setup(fixture) { fixture.state.factObservedAt = "2026-10-15T18:20:00.000Z"; } },
  { name: "forged fresh context digest", setup(fixture) { fixture.state.mutatePacket = (packet) => ({ ...packet, contextDigest: "f".repeat(64) }); } },
  { name: "forged original context digest", setup(_fixture, original) { original.contextDigest = "f".repeat(64); } },
  { name: "missing original proof", setup(fixture, original) {
    delete original.context.code.pullRequest.materialDigest;
    Object.assign(original, signedContextPacket(original, { graph: { graphId: original.binding.graphId,
      revision: original.binding.graphRevision, contentDigest: original.binding.graphContentDigest } }));
  } },
  ];
  for (const { name, setup } of cases) {
    await t.test(name, async () => {
      const fixture = await refreshedPrDeliveryFixture();
      fixture.state.observedAt = fixture.refreshedAt;
      fixture.state.factObservedAt = fixture.refreshedAt;
      const original = structuredClone(fixture.original);
      setup(fixture, original);
      const writesBefore = fixture.writes();
      await assert.rejects(fixture.execute(original), (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE");
      assert.equal(fixture.deliveryCalls(), 0);
      assert.equal(fixture.writes(), writesBefore);
    });
  }
  await t.test("changed current claim", async () => {
    const fixture = await refreshedPrDeliveryFixture();
    fixture.state.observedAt = fixture.refreshedAt;
    fixture.state.factObservedAt = fixture.refreshedAt;
    await assert.rejects(fixture.execute(fixture.original, { ...fixture.item, ownerId: "another-worker" }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED");
    assert.equal(fixture.deliveryCalls(), 0);
  });
  await t.test("ledger revision advances before submission", async () => {
    const fixture = await refreshedPrDeliveryFixture();
    fixture.state.observedAt = fixture.refreshedAt;
    fixture.state.factObservedAt = fixture.refreshedAt;
    await fixture.ledger.scheduleRetry({ itemId: fixture.item.itemId,
      expectedRevision: fixture.item.revision, leaseId: fixture.item.leaseId,
      actorId: "employee-pr-engineer", reason: "competing-context-change",
      availableAt: "2026-10-15T18:35:00.000Z" });
    const writesBefore = fixture.writes();
    await assert.rejects(fixture.execute(), (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE");
    assert.equal(fixture.deliveryCalls(), 0);
    assert.equal(fixture.writes(), writesBefore);
  });
});

test("submits ordinary and requirement-spec deliveries with trusted evidence", async (t) => {
  await t.test("ordinary delivery", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    let admissions = 0;
    const result = await serviceFrom(fakes, undefined, {
      run(operation) {
        admissions += 1;
        return operation();
      },
    }).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture),
    });
    assert.deepEqual(fakes.calls.delivererFactory, [{
      scopeRootTaskId: fixture.specialist.taskId,
      taskId: fixture.specialist.taskId,
      workerId: "employee-developer",
      leaseId: "lease-secret",
    }]);
    assert.equal(fakes.calls.delivery.length, 1);
    assert.equal(admissions, 1);
    assert.equal(Object.isFrozen(fakes.calls.delivery[0]), true);
    assert.deepEqual(fakes.calls.delivery[0].evidence, [
      workInputEvidence(fixture.specialist),
    ]);
    assert.equal(result.applied, true);
    assert.doesNotMatch(JSON.stringify(result), /lease-secret|work-inputs|evidence/);
  });

  await t.test("requirement specification", async () => {
    const fixture = specialistFixture({
      deliverableId: "requirement-spec",
      kind: "requirement-spec",
    });
    const artifact = {
      title: "统一需求",
      problem: "当前需求需要形成可追溯规格",
      requirements: ["记录完整需求"],
      acceptanceCriteria: ["规格可被后续岗位消费"],
      openQuestions: [],
    };
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, {
        deliverableId: "requirement-spec",
        artifact,
      }),
    });
    const command = fakes.calls.delivery[0];
    const spec = JSON.parse(command.summary);
    assert.equal(spec.sourceTask.taskId, fixture.specialist.taskId);
    assert.equal(spec.sourceTask.taskRevision, fixture.specialist.revision);
    assert.equal(spec.sourceTask.graphRevision, fixture.view.graph.revision);
    assert.deepEqual(command.evidence.map(({ kind }) => kind), [
      "requirement-spec",
      "work-inputs",
    ]);
    assert.equal(command.evidence[0].contentDigest, spec.contentDigest);
  });
});

test("requires requirement-spec deliverable id and kind in both directions", async (t) => {
  const mismatches = [
    {
      name: "reserved id with a non-requirement kind",
      deliverableId: "requirement-spec",
      kind: "change-package",
      artifact: {
        title: "需求规格",
        problem: "需要验证保留交付物绑定",
        requirements: ["交付物 ID 与 kind 必须一致"],
        acceptanceCriteria: ["不一致绑定在执行前被拒绝"],
        openQuestions: [],
      },
    },
    {
      name: "reserved kind with a non-requirement id",
      deliverableId: "implementation",
      kind: "requirement-spec",
    },
  ];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      const fixture = specialistFixture(mismatch);
      const fakes = fakePorts({
        packet: fixture.packet,
        views: fixture.view,
        verifier: () => true,
      });

      await assert.rejects(
        serviceFrom(fakes).execute({
          worker: { roleId: "developer", workerId: "employee-developer" },
          item: fixture.item,
          contextPacket: fixture.packet,
          intent: submitIntent(fixture, {
            deliverableId: mismatch.deliverableId,
            artifact: mismatch.artifact ?? null,
          }),
        }),
        (error) =>
          error instanceof OrchestratorServiceError &&
          error.code === "ORCHESTRATOR_EVIDENCE_REJECTED" &&
          error.statusCode === 409,
      );

      assert.equal(fakes.calls.verify.length, 0);
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("configuration-first admission performs no trusted graph mutation", async (t) => {
  await t.test("orchestration", async () => {
    const fixture = rootFixture();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      serviceFrom(fakes, undefined, gate).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fakes.calls.planner.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });

  await t.test("delivery submission", async () => {
    const fixture = specialistFixture();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      serviceFrom(fakes, undefined, gate).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture),
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fakes.calls.planner.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });
});

test("mutation-first admission releases cutover before graph storage settles", async () => {
  const fixture = rootFixture();
  const gate = readyActionAdmissionGate();
  const mutationEntered = deferred();
  const mutationResult = deferred();
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
    plannerResult(method, command) {
      mutationEntered.resolve({ method, command });
      return mutationResult.promise;
    },
  });
  const execution = serviceFrom(fakes, undefined, gate).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
  });
  const admitted = await mutationEntered.promise;
  const cutover = activateNextConfiguration(gate);
  const cutoverFinishedFirst = await Promise.race([
    cutover.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);

  mutationResult.resolve({ applied: true, taskId: fixture.child.taskId });
  await cutover;
  const result = await execution;

  assert.equal(cutoverFinishedFirst, true);
  assert.equal(gate.readStatus().mode, "restart_required");
  assert.equal(admitted.method, "pauseTask");
  assert.equal(Object.isFrozen(admitted.command), true);
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(result.applied, true);
});

test("requires matching authoritative evidence before accepting non-requirement deliveries", async (t) => {
  await t.test("trusted text reports do not require external evidence", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
      childContract: contract({
        deliverableId: "analysis-report",
        kind: "text-report",
      }),
    });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    const result = await executeDeliveryDecision(
      fakes,
      fixture,
      "accept_delivery",
    );

    assert.equal(result.action, "accept_delivery");
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.planner.length, 1);
  });

  await t.test("legacy evidence-free submission cannot be accepted", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("supporting evidence cannot replace the contract evidence kind", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [deliverableEvidence("test-report")],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("matching evidence still requires a configured verifier", async () => {
    const fixture = rootFixture({ submitted: true });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) =>
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("verified primary and supporting evidence can be accepted", async () => {
    const primary = deliverableEvidence();
    const supporting = deliverableEvidence("test-report");
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [supporting, primary],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await executeDeliveryDecision(fakes, fixture, "accept_delivery");

    assert.deepEqual(
      fakes.calls.verify.map(({ evidence }) => evidence.kind),
      ["change-package", "test-report"],
    );
    assert.equal(fakes.calls.planner.length, 1);
  });

  await t.test("returning incomplete evidence remains allowed", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
    });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    const result = await executeDeliveryDecision(
      fakes,
      fixture,
      "return_delivery",
    );

    assert.equal(result.action, "return_delivery");
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.planner.length, 1);
  });
});

test("rejects a delivery bound to a superseded acceptance contract", async () => {
  const base = rootFixture({ submitted: true });
  const child = {
    ...base.child,
    acceptanceContracts: [
      ...base.child.acceptanceContracts,
      { ...contract(), revision: 2 },
    ],
  };
  const view = graphView(
    [base.root, child, base.dependency],
    base.view.graph.revision,
  );
  const fixture = {
    ...base,
    child,
    view,
    packet: packetFor(view, base.root, {
      roleId: "orchestrator",
      directChildren: [child, base.dependency],
    }),
  };
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
    verifier: () => true,
  });

  await assert.rejects(
    executeDeliveryDecision(fakes, fixture, "accept_delivery"),
    (error) =>
      error instanceof OrchestratorServiceError &&
      error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
      error.statusCode === 409,
  );

  assert.equal(fakes.calls.verify.length, 0);
  assertNoTrustedMutation(fakes.calls);
});

test("rechecks graph authority after successful evidence verification", async (t) => {
  const changes = [
    {
      name: "graph revision changed",
      currentView(fixture) {
        return graphView(
          [fixture.root, fixture.child, fixture.dependency],
          fixture.view.graph.revision + 1,
        );
      },
    },
    {
      name: "graph content digest changed",
      currentView(fixture) {
        return graphView(
          [
            { ...fixture.root, status: "in_progress" },
            fixture.child,
            fixture.dependency,
          ],
          fixture.view.graph.revision,
        );
      },
    },
  ];

  for (const change of changes) {
    await t.test(change.name, async () => {
      const fixture = rootFixture({ submitted: true });
      const changedView = change.currentView(fixture);
      const fakes = fakePorts({
        packet: fixture.packet,
        views: [fixture.view, changedView],
        verifier: () => true,
      });

      await assert.rejects(
        executeDeliveryDecision(fakes, fixture, "accept_delivery"),
        (error) =>
          error instanceof OrchestratorServiceError &&
          error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
          error.statusCode === 409,
      );

      assert.equal(fakes.calls.verify.length, 1);
      assert.equal(fakes.calls.graphReads, 2);
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("fails closed on unverifiable caller evidence before obtaining a deliverer", async (t) => {
  const evidence = {
    kind: "change-package",
    referenceId: "artifact:change-package:1",
    contentDigest: EXTERNAL_DIGEST,
  };

  await t.test("verifier is absent", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );
    assert.equal(fakes.calls.delivererFactory.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });

  await t.test("verifier rejects the record", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => false,
    });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_REJECTED" &&
        error.statusCode === 409,
    );
    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("transient verifier failure is retryable and mutation-free", async () => {
    const fixture = specialistFixture();
    const outage = new Error("evidence registry unavailable");
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier() {
        throw outage;
      },
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503 &&
        error.cause === outage,
    );

    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("timed-out verification cannot mutate late and can be retried", async () => {
    const fixture = specialistFixture();
    const lateVerification = deferred();
    let verificationAttempts = 0;
    let timedOutSignal;
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier(input) {
        verificationAttempts += 1;
        if (verificationAttempts === 1) {
          timedOutSignal = input.signal;
          return lateVerification.promise;
        }
        return true;
      },
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 1,
    });
    const execute = () => service.execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, { evidence: [evidence] }),
    });

    await assert.rejects(
      execute(),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503,
    );
    assert.equal(timedOutSignal instanceof AbortSignal, true);
    assert.equal(timedOutSignal.aborted, true);
    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);

    lateVerification.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    assertNoTrustedMutation(fakes.calls);

    const result = await execute();

    assert.equal(result.applied, true);
    assert.equal(verificationAttempts, 2);
    assert.equal(fakes.calls.verify.length, 2);
    assert.equal(fakes.calls.delivererFactory.length, 1);
    assert.equal(fakes.calls.delivery.length, 1);
  });

  await t.test("verification timeout preserves a mutation margin inside the work lease", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = specialistFixture();
    const now = Date.parse("2026-08-03T08:00:00.000Z");
    fixture.item.leaseUntil = new Date(now + 30_000).toISOString();
    let verificationSignal;
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier(input) {
        verificationSignal = input.signal;
        return new Promise(() => {});
      },
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 60_000,
      evidenceMutationMarginMs: 20_000,
      clock: () => new Date(now),
    });

    const execution = assert.rejects(
      service.execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );

    try {
      for (
        let attempt = 0;
        verificationSignal === undefined && attempt < 100;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      assert.equal(verificationSignal instanceof AbortSignal, true);

      t.mock.timers.tick(8_000);
      await Promise.resolve();
      assert.equal(verificationSignal.aborted, false);

      t.mock.timers.tick(3_000);
      await Promise.resolve();
      assert.equal(verificationSignal.aborted, true);
      await execution;
    } finally {
      t.mock.timers.runAll();
      t.mock.timers.reset();
    }
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("verifier authorizes the exact evidence binding", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });
    await serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, { evidence: [evidence] }),
    });
    assert.equal(fakes.calls.verify.length, 1);
    const [{ signal, ...authority }] = fakes.calls.verify;
    assert.deepEqual(authority, {
      taskId: fixture.specialist.taskId,
      roleId: "developer",
      contractRevision: 1,
      contractDigest: deliveryAcceptanceContractDigest(
        fixture.specialist.acceptanceContracts.at(-1),
      ),
      deliverableId: "implementation",
      evidence,
    });
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
    assert.equal(fakes.calls.delivery.length, 1);
  });
});

function requirementAcceptanceFixture({ tamperSpec = false } = {}) {
  const root = task({ taskId: "root", revision: 3 });
  const shell = task({
    taskId: "root/requirements",
    revision: 2,
    parentTaskId: root.taskId,
    role: "requirements",
    acceptanceContract: contract({
      deliverableId: "requirement-spec",
      kind: "requirement-spec",
    }),
  });
  const spec = createRequirementSpec({
    draft: {
      title: "需求规格",
      problem: "需求需要结构化交接",
      requirements: ["保留需求来源"],
      acceptanceCriteria: ["后续岗位可验证输入"],
      openQuestions: [],
    },
    revision: 1,
    sourceTask: {
      taskId: shell.taskId,
      taskRevision: 1,
      graphRevision: 2,
    },
    acceptedInputs: [],
  });
  const requirements = {
    ...shell,
    deliveries: [{
      deliverableId: "requirement-spec",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: JSON.stringify(spec),
      evidence: [
        {
          kind: "requirement-spec",
          referenceId: `requirement-spec:${shell.taskId}:1`,
          contentDigest: tamperSpec ? "f".repeat(64) : spec.contentDigest,
        },
        workInputEvidence(shell),
      ],
    }],
  };
  const view = graphView([root, requirements], 3);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [requirements],
  });
  return { root, requirements, view, item, packet };
}

test("validates trusted work-input and requirement-spec evidence before acceptance", async (t) => {
  await t.test("valid reserved evidence is accepted", async () => {
    const fixture = requirementAcceptanceFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await serviceFrom(fakes).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: orchestrate({
        ...commonAction("accept_delivery", fixture.requirements, fixture.view),
        submittedDeliveryRevision: 1,
      }),
    });
    assert.equal(fakes.calls.plannerFactory.length, 1);
    assert.equal(fakes.calls.planner[0].method, "decideDelivery");
  });

  await t.test("tampered requirement-spec evidence is rejected", async () => {
    const fixture = requirementAcceptanceFixture({ tamperSpec: true });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate({
          ...commonAction("accept_delivery", fixture.requirements, fixture.view),
          submittedDeliveryRevision: 1,
        }),
      }),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.planner.length, 0);
  });
});

test("does not retry a synchronously failed CAS command", async () => {
  const fixture = rootFixture();
  const conflict = Object.assign(new Error("CAS conflict"), {
    code: "WORK_LEDGER_STALE_REVISION",
  });
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
  });
  fakes.ports.scopedGraphPlannerFactory.forRoot = (request) => {
    fakes.calls.plannerFactory.push(request);
    return {
      pauseTask(command) {
        fakes.calls.planner.push({ method: "pauseTask", command });
        throw conflict;
      },
    };
  };
  await assert.rejects(
    serviceFrom(fakes).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
    }),
    (error) => error === conflict,
  );
  assert.equal(fakes.calls.plannerFactory.length, 1);
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(fakes.calls.graphReads, 1);
});

test("reconciles an exact uncertain delivery submission without issuing it twice", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("write result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.delivery[0];
        const submitted = {
          ...fixture.specialist,
          revision: 2,
          deliveries: [{
            deliverableId: command.deliverableId,
            revision: command.deliveryRevision,
            contractRevision: command.contractRevision,
            status: "submitted",
            summary: command.summary,
            evidence: command.evidence,
          }],
        };
        return graphView([fixture.root, submitted], 3);
      },
    ],
    deliveryResult: uncertain,
  });
  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "developer", workerId: "employee-developer" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: submitIntent(fixture),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "delivery",
    action: "submit_delivery",
    applied: false,
    recovered: true,
    rootTaskId: "root",
    taskId: fixture.specialist.taskId,
    deliveryRevision: 1,
  });
  assert.equal(fakes.calls.delivery.length, 1);
  assert.equal(fakes.calls.delivererFactory.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("a synchronous delivery-port failure still enters exact recovery", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("synchronous write result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.delivery[0];
        const submitted = {
          ...fixture.specialist,
          revision: 2,
          deliveries: [{
            deliverableId: command.deliverableId,
            revision: command.deliveryRevision,
            contractRevision: command.contractRevision,
            status: "submitted",
            summary: command.summary,
            evidence: command.evidence,
          }],
        };
        return graphView([fixture.root, submitted], 3);
      },
    ],
  });
  fakes.ports.graphDelivererFactory.forClaim = (request) => {
    fakes.calls.delivererFactory.push(request);
    return {
      submitDelivery(command) {
        fakes.calls.delivery.push(command);
        throw uncertain;
      },
    };
  };

  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "developer", workerId: "employee-developer" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: submitIntent(fixture),
  });

  assert.equal(result.recovered, true);
  assert.equal(fakes.calls.delivery.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("reconciles an exact uncertain delivery decision without deciding twice", async () => {
  const fixture = rootFixture({ submitted: true });
  const uncertain = new Error("decision result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      fixture.view,
      () => {
        const command = fakes.calls.planner[0].command;
        const submitted = fixture.child.deliveries[0];
        const completed = {
          ...fixture.child,
          revision: 3,
          status: "completed",
          deliveries: [
            submitted,
            {
              deliverableId: submitted.deliverableId,
              revision: 2,
              contractRevision: submitted.contractRevision,
              status: "accepted",
              summary: command.reason,
              evidence: submitted.evidence,
            },
          ],
        };
        return graphView([fixture.root, completed, fixture.dependency], 4);
      },
    ],
    plannerResult: uncertain,
    verifier: () => true,
  });
  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate({
      ...commonAction("accept_delivery", fixture.child, fixture.view),
      submittedDeliveryRevision: 1,
    }),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "orchestration",
    action: "accept_delivery",
    applied: false,
    recovered: true,
    rootTaskId: fixture.root.taskId,
    taskId: fixture.child.taskId,
    deliveryRevision: 2,
  });
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(fakes.calls.plannerFactory.length, 1);
  assert.equal(fakes.calls.graphReads, 3);
});

test("rejects stale graph bindings and hidden child actions before planner creation", async (t) => {
  await t.test("graph content changed", async () => {
    const fixture = rootFixture();
    const changedChild = { ...fixture.child, revision: 2 };
    const changedView = graphView(
      [fixture.root, changedChild, fixture.dependency],
      4,
    );
    const fakes = fakePorts({ packet: fixture.packet, views: changedView });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
  });

  await t.test("source child was not visible in the original packet", async () => {
    const fixture = rootFixture();
    const packet = packetFor(fixture.view, fixture.root, {
      roleId: "orchestrator",
      directChildren: [fixture.dependency],
    });
    const fakes = fakePorts({ packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  for (const type of ["accept_delivery", "return_delivery"]) {
    await t.test(`${type} cannot decide a submission outside the review window`, async () => {
      const fixture = rootFixture({ submitted: true });
      const packet = structuredClone(fixture.packet);
      packet.context.requirements.childDeliveries = [];
      const fakes = fakePorts({ packet, views: fixture.view });

      await assert.rejects(
        serviceFrom(fakes).execute({
          worker: {
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
          },
          item: fixture.item,
          contextPacket: packet,
          intent: orchestrate({
            ...commonAction(type, fixture.child, fixture.view),
            submittedDeliveryRevision: 1,
          }),
        }),
        (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
      );
      assert.equal(fakes.calls.plannerFactory.length, 0);
      assert.equal(fakes.calls.delivererFactory.length, 0);
      assert.equal(fakes.calls.planner.length, 0);
    });
  }

  await t.test("capability has no trusted role mapping", async () => {
    const fixture = rootFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes, {}).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate({
          ...commonAction("assign", fixture.child, fixture.view),
          capability: "development",
        }),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });
});

test("propagates the original uncertain-write error when recovery content differs", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("write result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.delivery[0];
        const submitted = {
          ...fixture.specialist,
          revision: 2,
          deliveries: [{
            deliverableId: command.deliverableId,
            revision: command.deliveryRevision,
            contractRevision: command.contractRevision,
            status: "submitted",
            summary: "different content",
            evidence: command.evidence,
          }],
        };
        return graphView([fixture.root, submitted], 3);
      },
    ],
    deliveryResult: uncertain,
  });
  await assert.rejects(
    serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture),
    }),
    (error) => error === uncertain,
  );
  assert.equal(fakes.calls.delivery.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("does not invoke accessor properties while validating constructor ports", () => {
  let getterCalls = 0;
  const accessorPort = {};
  Object.defineProperty(accessorPort, "assemble", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => ({});
    },
  });
  const fixture = rootFixture();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  assert.throws(
    () => new OrchestratorService({
      ...fakes.ports,
      contextAssembler: accessorPort,
      capabilityRoles: {},
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);
});

test("rejects an explicit invalid action admission gate", () => {
  const fixture = rootFixture();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  assert.throws(
    () => serviceFrom(fakes, undefined, null),
    /actionAdmissionGate is invalid/,
  );
});


async function coordinationReturnFixture({ direct = false, nextAction = "continue_draft" } = {}) {
  const f = await refreshedPrDeliveryFixture({ workerId: "employee-developer", roleId: "developer",
    deliveryKind: "change-package", nextAction });
  if (direct) {
    await f.ledger.handoff({ itemId: f.item.itemId, expectedRevision: f.item.revision,
      leaseId: f.item.leaseId, actorId: "employee-developer", target: { type: "role", id: "orchestrator" },
      reason: "Coordinate retained delivery contract" });
  } else {
    await f.ledger.stageIntent({ itemId: f.item.itemId, expectedRevision: f.item.revision,
      leaseId: f.item.leaseId, actorId: "employee-developer", roleId: "developer",
      intent: { schemaVersion: 1, type: "handoff", summary: "Coordinate contract",
        reason: "Required package and available evidence differ", capability: "coordination",
        brief: "Review delivery contract against current Head", evidence: ["developer-report:contract"] } });
    const dispatcher = new WorkIntentDispatcher({ ledger: f.ledger,
      policy: createWorkIntentPolicy({ capabilityRoles: { coordination: "orchestrator" } }),
      actionAdmissionGate: readyActionAdmissionGate(), clock: () => "2026-10-15T18:34:00.000Z",
      attentionProducer: { async create() { assert.fail("No attention request"); } },
      proposalProducer: { async create() { assert.fail("No proposal"); } } });
    assert.equal((await dispatcher.dispatchPending()).delivered, 1);
  }
  f.read = async id => (await f.ledger.listItems()).items.find(item => item.itemId === id);
  f.handed = await f.read(f.item.itemId);
  return f;
}

for (const nextAction of ["continue_draft", "rereview"]) test(`coordination return routes actual ${nextAction} handoff through parent and scoped correction`, async () => {
  const f = await coordinationReturnFixture({ nextAction });
  const before = await f.ledger.listTimeline({ itemId: f.item.itemId });
  const candidates = await f.ledger.listClaimCandidates({ at: "2026-10-15T18:34:00.000Z", limit: 1, roleId: "orchestrator" });
  assert.deepEqual(candidates.items.map(item => item.itemId), [f.root.itemId]);
  assert.equal(candidates.nextCursor, null);
  assert.equal(candidates.facts[0].orchestrationReady, true);
  await assert.rejects(f.ledger.claim({ itemId: f.handed.itemId, expectedRevision: f.handed.revision,
    workerId: "employee-orchestrator", leaseDurationMs: 600000 }), { code: "WORK_LEDGER_GRAPH_BLOCKED" });
  assert.deepEqual(await f.read(f.handed.itemId), f.handed);
  const packet = await f.assembler.assemble({ roleId: "orchestrator", item: await f.read(f.root.itemId), trigger: 'employee:orchestrator' });
  const visible = packet.context.requirements.coordination.directChildren.find(child => child.taskId === f.item.itemId);
  assert.equal(visible.coordinationReturn.kind, "parent_coordination");
  assert.equal(visible.coordinationReturn.handoff.brief, "Review delivery contract against current Head");
  assert.equal(visible.coordinationReturn.handoff.evidenceAuthority, "specialist_report");
  assert.equal(visible.deliverables[0].kind, "change-package");
  let persisted, childDecisions = 0, parentDecisions = 0;
  const host = new OrchestratorService({ contextAssembler: f.assembler, graphReader: f.graphReader,
    graphDelivererFactory: { forClaim() { assert.fail('Root cannot acquire specialist authority'); } },
    scopedGraphPlannerFactory: { forRoot({ scopeRootTaskId }) {
      assert.equal(scopeRootTaskId, f.root.itemId);
      return f.graph.planner({ principalId: "employee-orchestrator", scopeRootTaskId });
    } } });
  const loop = new ProactiveWorkLoop({ ledger: f.ledger, roleContextAssembler: f.assembler,
    orchestratorService: host, clock: () => "2026-10-15T18:34:00.000Z",
    roleDirectory: { async resolve() { return { roleId: "orchestrator", workerId: "employee-orchestrator", enabled: true, paused: false,
      async decide({ item, context }) {
        if (item.itemId !== f.root.itemId) { childDecisions++; assert.fail("Child must not call a brain"); }
        parentDecisions++;
        assert(context.requirements.coordination.directChildren.some(child => child.coordinationReturn));
        const snapshot = await f.graphReader.getSnapshot(), child = await f.read(f.item.itemId);
        return { schemaVersion: 1, confidence: 90, summary: "Resolve retained contract", intent: {
          schemaVersion: 1, type: "orchestrate", summary: "Resolve retained contract", reason: "Replace incompatible retained contract",
          action: { schemaVersion: 1, type: "cancel", sourceTaskId: child.itemId,
            sourceTaskRevision: child.revision, expectedGraphRevision: snapshot.graph.revision,
            reason: "Replace incompatible retained contract" } } };
      } }; } } });
  const schedulerOptions = { ledger: f.ledger, clock: () => "2026-10-15T18:34:00.000Z",
    store: { async read(_key, fallback) { return structuredClone(persisted ?? fallback); },
      async write(_key, value) { persisted = structuredClone(value); } },
    configurationReader: { async readActive() { return { configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }; } },
    roleStateReader: { async read() { return { enabled: true, paused: false }; } } };
  const scheduler = new WorkContinuationScheduler(schedulerOptions), operations = [], dispatched = [], cycles = [], errors = [];
  const run = async target => { dispatched.push(target.continuationTarget.itemId);
    try { const cycle = await loop.runCycle({ roleId: target.roleId, workLimit: 1 });
      cycles.push(cycle); return cycle; } catch (error) { errors.push(error); throw error; } };
  await scheduler.runCycle({ dispatch: run, runOperation(operation) { const pending = operation(); operations.push(pending); return pending; } });
  await Promise.all(operations);
  assert.deepEqual(errors, []);
  assert.equal(cycles[0].orchestrated, 1, JSON.stringify(cycles));
  assert.deepEqual(dispatched, [f.root.itemId]);
  assert.equal(childDecisions, 0); assert.equal(parentDecisions, 1);
  const settled = await f.read(f.item.itemId);
  assert.equal(settled.status, "cancelled"); assert.equal(settled.attempt, f.handed.attempt);
  assert.deepEqual(settled.graph.acceptanceContracts, f.handed.graph.acceptanceContracts);
  assert.deepEqual((await f.ledger.listTimeline({ itemId: settled.itemId })).items.slice(0, before.items.length), before.items);
  assert.equal((await f.read(f.root.itemId)).attempt, 0);
  await f.createChild("compatible-specialist");
  const specialist = await f.ledger.listClaimCandidates({ at: "2026-10-15T18:34:00.000Z", roleId: "developer" });
  assert.equal(specialist.items.length, 1);
  assert.equal(specialist.items[0].assignment.work.title, "compatible-specialist");
  // The restart reads durable scheduler/ledger history and never reselects the return.
  const restarted = new WorkContinuationScheduler(schedulerOptions), again = [];
  await restarted.runCycle({ dispatch: async target => { again.push(target.continuationTarget.itemId); }, runOperation: operation => operation() });
  assert(!again.includes(settled.itemId));
  assert.equal((await f.read(settled.itemId)).attempt, f.handed.attempt);
});

test('coordination return compatibility loop skips direct ledger handback before a model or claim', async () => {
  const f = await coordinationReturnFixture({ direct: true });
  const compatibilityLedger = Object.fromEntries(Object.getOwnPropertyNames(WorkLedgerService.prototype)
    .filter(key => key !== 'constructor' && key !== 'listClaimCandidates' && typeof f.ledger[key] === 'function')
    .map(key => [key, f.ledger[key].bind(f.ledger)]));
  let childCalls = 0, rootCalls = 0;
  const loop = new ProactiveWorkLoop({ ledger: compatibilityLedger, roleContextAssembler: f.assembler,
    orchestratorService: { async execute() { assert.fail('Observation must not execute graph actions'); } },
    clock: () => '2026-10-15T18:34:00.000Z', roleDirectory: { async resolve() {
      return { roleId: 'orchestrator', workerId: 'employee-orchestrator', enabled: true, paused: false,
        async decide({ item, context }) {
          if (item.itemId !== f.root.itemId) { childCalls++; assert.fail('Returned child must not call a model'); }
          rootCalls++;
          const child = context.requirements.coordination.directChildren[0];
          assert.equal(child.coordinationReturn.hasHandoffReport, false);
          return { schemaVersion: 1, confidence: 90, summary: 'Wait for scoped coordination', intent: {
            schemaVersion: 1, type: 'complete', summary: 'Wait for scoped coordination', reason: 'Fixture observation', outcome: 'done', evidence: [] } };
        } };
    } } });
  const first = await loop.runCycle({ roleId: 'orchestrator' });
  assert.equal(first.claimed, 0); assert.equal(first.outcomes[0].status, 'graph_blocked');
  await loop.runCycle({ roleId: 'orchestrator' });
  assert.equal(childCalls, 0); assert.equal(rootCalls, 2, 'manual cycles retain ordinary root coordination');
  assert.deepEqual(await f.read(f.handed.itemId), f.handed);
  assert.equal((await f.read(f.root.itemId)).attempt, 0);
});

test('coordination return preserves actual paused child and root without scheduling a model', async () => {
  for (const scope of ['child', 'root']) {
    const f = await coordinationReturnFixture();
    let discoveries = 0;
    const listClaimCandidates = f.ledger.listClaimCandidates.bind(f.ledger);
    f.ledger.listClaimCandidates = async input => { discoveries++; return listClaimCandidates(input); };
    const runScheduler = async dispatch => {
      let persisted;
      const operations = [];
      const scheduler = new WorkContinuationScheduler({ ledger: f.ledger, clock: () => '2026-10-15T18:34:00.000Z',
        store: { async read(_key, fallback) { return structuredClone(persisted ?? fallback); },
          async write(_key, value) { persisted = structuredClone(value); } },
        configurationReader: { async readActive() { return { configuration: { githubActions: { enabled: true, automaticOwnPrRepair: true } } }; } },
        roleStateReader: { async read() { return { enabled: true, paused: false }; } } });
      const cycle = await scheduler.runCycle({ dispatch, runOperation(operation) {
        const pending = operation(); operations.push(pending); return pending;
      } });
      await Promise.all(operations);
      assert.equal(cycle.skipped, null, 'pause must be checked by an admitted scheduler cycle');
      return cycle;
    };
    const positiveCalls = [];
    const positive = await runScheduler(async target => { positiveCalls.push(target.continuationTarget.itemId); });
    assert.equal(positive.started, 1);
    assert.deepEqual(positiveCalls, [f.root.itemId], 'the same enabled scheduler discovers this coordination return before pause');
    assert(discoveries > 0);
    const item = await f.read(scope === 'child' ? f.item.itemId : f.root.itemId);
    const planner = f.graph.planner({ principalId: 'employee-orchestrator', scopeRootTaskId: f.root.itemId });
    await planner.pauseTask({ taskId: item.itemId, expectedTaskRevision: item.revision,
      expectedGraphRevision: (await f.graphReader.getSnapshot()).graph.revision, reason: 'Owner suspension' });
    const before = await f.ledger.listItems();
    const discoveriesBeforePause = discoveries;
    let modelCalls = 0;
    const cycle = await runScheduler(async () => { modelCalls++; });
    assert(discoveries > discoveriesBeforePause, 'paused work is examined during candidate discovery');
    assert.equal(cycle.started, 0);
    assert.equal(modelCalls, 0);
    assert.deepEqual(await f.ledger.listItems(), before);
  }
});
