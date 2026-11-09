import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { normalizeStructuredBrainRequest } from "../src/lib/structured-brain-request.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";
import { RoleWorkerDirectory } from "../src/services/role-worker-directory.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { ConfiguredRoleEmployee } from "../src/services/configured-role-employee.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { WorkCoordinationService } from "../src/services/work-coordination-service.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { coordinatorGoalControl } from "../src/domain/work-goal-ownership.js";
import { MODEL_WORK_DECISION_JSON_SCHEMA } from "../src/domain/structured-brain-contract.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback = null) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function completeDecision(overrides = {}) {
  return {
    schemaVersion: 1,
    confidence: 88,
    summary: "已形成岗位判断。",
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary: "工作已完成。",
      reason: "已经具备充分证据。",
      outcome: "done",
      evidence: ["验证记录"],
    },
    ...overrides,
  };
}

function askUserDecision() {
  return {
    schemaVersion: 1,
    confidence: 82,
    summary: "需要继续确认型号范围。",
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary: "确认 RTX 5060 系列的具体型号范围",
      reason: "系列可能包含不同型号和显存规格。",
      question: "RTX 5060 系列具体包含哪些型号？",
      choices: [{
        id: "all-5060-models",
        label: "全部 5060 系列",
        description: "覆盖 RTX 5060、RTX 5060 Ti 及计划出货的显存规格。",
      }],
    },
  };
}

function orchestrationDecision() {
  const reason = "等待依赖任务恢复";
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "应暂停当前任务",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "暂停当前任务",
      reason,
      action: {
        schemaVersion: 1,
        type: "pause",
        sourceTaskId: "work-item-root",
        sourceTaskRevision: 4,
        expectedGraphRevision: 8,
        reason,
      },
    },
  };
}

function triageDecompositionDecision(capability = "development") {
  const reason = "Create the trusted PR triage child";
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "Create one specialist child",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "Create one specialist child",
      reason,
      action: {
        schemaVersion: 1,
        type: "decompose",
        sourceTaskId: "work-item-root",
        sourceTaskRevision: 4,
        expectedGraphRevision: 8,
        reason,
        childKey: "trusted-triage",
        work: { title: "Handle PR", description: "Use trusted intake" },
        capability,
        dependsOn: [],
        acceptanceContract: {
          revision: 1,
          acceptanceCriteria: [{
            criterionId: "done",
            description: "Trusted triage completed",
          }],
          expectedDeliverables: [{
            deliverableId: "implementation",
            kind: capability === "development"
              ? "change-package"
              : "github-review",
            description: "Trusted specialist delivery",
            required: true,
          }],
        },
      },
    },
  };
}

function deliveryDecision() {
  return {
    schemaVersion: 1,
    confidence: 89,
    summary: "提交岗位交付物",
    intent: {
      schemaVersion: 1,
      type: "submit_delivery",
      taskId: "work-item-development",
      expectedTaskRevision: 6,
      expectedGraphRevision: 9,
      contractRevision: 1,
      deliverableId: "implementation",
      summary: "实现与聚焦测试已经完成",
      reason: "当前证据满足交付条件",
      evidence: [{
        kind: "change-package",
        referenceId: "change-package:development:1",
        contentDigest: "a".repeat(64),
      }],
      artifact: null,
    },
  };
}

function definition(id, scheduleMinutes = 5) {
  return {
    id,
    name: `岗位 ${id}`,
    mission: `负责 ${id} 工作`,
    enabled: true,
    scheduleMinutes,
  };
}

function permissions(...allowedIntents) {
  return { allowedIntents };
}

function brain(overrides = {}) {
  return {
    provider: "local-brain",
    model: "role-model",
    remoteData: { requirements: false, code: false, memory: false },
    ...overrides,
  };
}

function fakeDecisionEngine(
  id,
  calls = [],
  { remote = false, availabilityCalls = null, availabilityError = null } = {},
) {
  const engine = {
    async decide(input) {
      calls.push({ id, input: structuredClone(input) });
      return completeDecision();
    },
    view() {
      return {
        definition: definition(id),
        permissions: permissions("complete"),
        brain: { ...brain(), remote },
      };
    },
  };
  if (availabilityCalls !== null) {
    engine.checkAvailability = async (input) => {
      availabilityCalls.push({ id, input });
      if (availabilityError) throw availabilityError;
    };
  }
  return engine;
}

function assignedTask(eventType, suffix = "1") {
  const assignmentId = `assignment-${suffix}`;
  return {
    itemId: `work-item-${suffix}`,
    kind: "assignment",
    assignmentId,
    assignment: {
      assignmentId,
      target: { type: "role", id: "developer" },
    },
    event: { eventType },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixedDecisionEngine(roleId, decision) {
  return new RoleDecisionEngine({ definition: definition(roleId),
    permissions: permissions("complete", "handoff", "ask_user", "propose_github_review", "propose_code_action"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true, supportsReviewReading: true }), generate: async () => JSON.stringify(decision) },
  });
}

test("developer PR development cannot complete without review, including an already committed alleged fix", async () => {
  for (const event of [
    { eventType: "pull_request.owner_requested", payload: { workType: "development", headRefOid: "a".repeat(40) } },
    { eventType: "pull_request.updated", payload: { relation: "authored", nextAction: "address_review", headRefOid: "a".repeat(40) } },
    { eventType: "pull_request.updated", payload: { relation: "authored", nextAction: "fix_ci", headRefOid: "a".repeat(40) } },
  ]) {
    const engine = fixedDecisionEngine("developer", completeDecision());
    await assert.rejects(engine.decide({ item: { event }, context: {
      requirements: {}, code: { sourceEvent: event, existingRepair: { commitOid: "b".repeat(40) } },
    } }), { code: "ROLE_DECISION_PR_REVIEW_REQUIRED" });
  }
});

test("an existing-fix developer handoff remains internal through the PR engineer decision", async () => {
  const event = { eventType: "pull_request.owner_requested", source: { provider: "local-owner" },
    payload: { workType: "development", headRefOid: "a".repeat(40) } };
  const input = { item: { event }, context: { requirements: {}, code: { sourceEvent: event,
    internalReview: { kind: "developer_handoff", headRefOid: event.payload.headRefOid,
      brief: "Existing commit is claimed to fix the review", evidence: ["developer-report-only"] } } } };
  const external = completeDecision({ intent: { schemaVersion: 1, type: "propose_github_review",
    summary: "Publish", reason: "Review complete", verdict: "approve", body: "ok", evidence: [] } });
  await assert.rejects(fixedDecisionEngine("pr-engineer", external).decide(input), { code: "ROLE_DECISION_INTERNAL_REVIEW_ONLY" });
  await assert.rejects(fixedDecisionEngine("pr-engineer", completeDecision()).decide(input), { code: "ROLE_DECISION_INTERNAL_REVIEW_EVIDENCE_REQUIRED" });
  const internal = completeDecision(); internal.intent.evidence = [`head:${event.payload.headRefOid}`, "code-inspection", "actual-regression-report"];
  assert.equal((await fixedDecisionEngine("pr-engineer", internal).decide(input)).intent.type, "complete");
});

test("PR development retains real requirements questions and ordinary non-PR completion", async () => {
  const event = { eventType: "pull_request.owner_requested", payload: { workType: "development" } };
  assert.equal((await fixedDecisionEngine("developer", askUserDecision()).decide({ item: { event },
    context: { requirements: {}, code: { sourceEvent: event } } })).intent.type, "ask_user");
  assert.equal((await fixedDecisionEngine("developer", completeDecision()).decide({ item: {},
    context: { requirements: {} } })).intent.type, "complete");
  const testing = { eventType: "pull_request.owner_requested", payload: { workType: "testing" } };
  assert.equal((await fixedDecisionEngine("developer", completeDecision()).decide({ item: { event: testing },
    context: { requirements: {}, code: { sourceEvent: testing } } })).intent.type, "complete");
});

test("internal own PR review rejects external publication and requires Head and repair evidence on completion", async () => {
  const internalReview = { kind: "own_pr_repair", headRefOid: "a".repeat(40), feedbackDigest: "f".repeat(64),
    publicationConfirmationId: "confirmation-push", controlledCommitEvidenceId: "controlled-repair" };
  const event = { eventType: "pull_request.internal_review_requested", source: { provider: "internal-review-repair" },
    payload: { internalReview, headRefOid: internalReview.headRefOid } };
  const input = { item: { event }, context: { requirements: {}, code: { sourceEvent: event } } };
  await assert.rejects(fixedDecisionEngine("pr-engineer", completeDecision()).decide(input),
    { code: "ROLE_DECISION_INTERNAL_REVIEW_EVIDENCE_REQUIRED" });
  const bound = completeDecision();
  bound.intent.evidence = [`head:${internalReview.headRefOid}`, "controlled-commit:controlled-repair", "publication:confirmation-push"];
  await assert.rejects(fixedDecisionEngine("pr-engineer", bound).decide(input), { code: "ROLE_DECISION_INTERNAL_REVIEW_FEEDBACK_REQUIRED" });
  event.subject = { repository: "acme/repo", number: 42 };
  input.context.code.originalRepairFeedback = { snapshotId: `repair-feedback-snapshot-${"d".repeat(64)}`, feedbackDigest: internalReview.feedbackDigest,
    originalHeadRefOid: "b".repeat(40), reviewHeadRefOid: internalReview.headRefOid };
  input.context.code.pullRequest = { reviewMaterial: { gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "me",
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "c".repeat(40), headRepository: "acme/repo", headRefName: "fix", headRefOid: internalReview.headRefOid } } };
  assert.equal((await fixedDecisionEngine("pr-engineer", bound).decide(input)).intent.type, "complete");
  const external = completeDecision({ intent: { schemaVersion: 1, type: "propose_github_review", summary: "Publish",
    reason: "Review complete", verdict: "approve", body: "ok", evidence: [] } });
  await assert.rejects(fixedDecisionEngine("pr-engineer", external).decide(input),
    { code: "ROLE_DECISION_INTERNAL_REVIEW_ONLY" });
});

test("owner goal controls validate fake provider output within the correction budget and isolate concurrent schemas", async () => {
  const original = JSON.stringify(MODEL_WORK_DECISION_JSON_SCHEMA);
  const calls = [];
  const seen = new Map();
  const contextFor = (root, child) => ({ requirements: { coordination: { goalControl: coordinatorGoalControl({
    rootTaskId: root, parentTaskId: null, event: { source: { provider: "local-owner" }, eventType: "owner_request.created" },
    childTaskIds: [child],
  }) } } });
  const engine = new RoleDecisionEngine({ definition: definition("orchestrator"), permissions: permissions("orchestrate"), brain: brain(),
    brainRouter: { describe: () => ({}), async generate(request) {
      calls.push(request);
      const context = JSON.parse(request.messages[1].content);
      const control = context.requirements.coordination.goalControl;
      const count = (seen.get(control.rootTaskId) ?? 0) + 1;
      seen.set(control.rootTaskId, count);
      assert.ok(request.messages[0].content.includes(JSON.stringify(request.schema)), "the described schema must be this request's schema");
      await Promise.resolve();
      const result = orchestrationDecision();
      result.intent.action.type = "cancel";
      result.intent.action.sourceTaskId = control.rootTaskId === "root-a" && count === 1 ? control.rootTaskId : control.cancellableTaskIds[0];
      return JSON.stringify(result);
    } },
  });
  const [a, b] = await Promise.all([
    engine.decide({ item: {}, context: contextFor("root-a", "child-a") }),
    engine.decide({ item: {}, context: contextFor("root-b", "child-b") }),
  ]);
  assert.equal(a.intent.action.sourceTaskId, "child-a");
  assert.equal(b.intent.action.sourceTaskId, "child-b");
  assert.equal(calls.length, 3, "one invalid root control uses the existing correction attempt");
  assert.equal(JSON.stringify(MODEL_WORK_DECISION_JSON_SCHEMA), original);
  for (const request of calls) {
    const control = JSON.parse(request.messages[1].content).requirements.coordination.goalControl;
    const cancel = request.schema.properties.intent.oneOf.find(v => v.properties.type.const === "orchestrate")
      .properties.action.oneOf.find(v => v.properties.type.const === "cancel");
    assert.deepEqual(cancel.properties.sourceTaskId.enum, control.cancellableTaskIds);
    assert.equal(Object.isFrozen(cancel.properties.sourceTaskId.enum), true);
  }
});

test("RoleDecisionEngine classifies context, routes the configured brain, and normalizes output", async () => {
  const calls = [];
  const router = {
    async generate(request) {
      calls.push(request);
      return JSON.stringify(completeDecision());
    },
    describe(config) {
      return Object.freeze({
        provider: config.provider,
        model: config.model,
        remote: true,
        remoteData: structuredClone(config.remoteData),
      });
    },
  };
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({
      provider: "remote-brain",
      remoteData: { requirements: true, code: true, memory: false },
    }),
    brainRouter: router,
    contextFactory: async ({ item, trigger }) => ({
      requirements: { trigger, title: item.event.subject.title },
      code: { files: ["src/app.js"] },
    }),
  });

  const result = await engine.decide({
    item: {
      event: {
        eventType: "pull_request.updated",
        subject: {
          repository: "example/software",
          number: 24256,
          title: "修复登录",
        },
      },
    },
    trigger: "assigned",
  });

  assert.deepEqual(result, completeDecision());
  assert.deepEqual(calls[0].dataClasses, ["requirements", "code"]);
  assert.match(calls[0].messages[0].content, /developer/);
  assert.match(calls[0].messages[0].content, /untrusted|不可信/i);
  assert.match(
    calls[0].messages[0].content,
    /PR development.*owner_requested.*latest.*Head.*existing.*fix.*handoff.*pr-review.*without.*owner.*confirmation/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /modify produces change-package.*verify produces test-report/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /prose-only specialist work.*text-report.*first return any submitted delivery/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /Use decompose to create each new specialist child.*never assign a task to its current role/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /dependsOn.*completed visible direct children/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /pull_request\.owner_requested.*suggested capability.*decompose/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /Never pause the current root merely to wait for normal child work/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /multiple compatible expected deliverables.*deliverableId|deliverableId.*multiple compatible expected deliverables/i,
  );
  assert.deepEqual(JSON.parse(calls[0].messages[1].content), {
    requirements: { trigger: "assigned", title: "修复登录" },
    code: { files: ["src/app.js"] },
  });
  assert.equal(engine.view().brain.remoteData.memory, false);
  assert.equal(
    calls[0].sessionKey,
    "github:pull_request:example/software#24256",
  );
});

test("Review Skill prompts pass provider input validation and preserve Markdown", async () => {
  const body = "## 结论\n\n**通过**：完整检查当前代码，未发现阻塞缺陷。\n\n## QA 待验\n\n- 在界面确认年龄来源及边界值显示。";
  const decision = completeDecision({
    intent: {
      schemaVersion: 1,
      type: "propose_github_review",
      verdict: "approve",
      summary: "年龄来源代码评审通过，交 QA 验证",
      reason: "未发现阻塞缺陷，界面回归由 QA 完成",
      body,
      evidence: ["完整检查当前变更和年龄来源调用链，界面实测未执行"],
    },
  });
  let request;
  const router = {
    async generate(value) {
      normalizeStructuredBrainRequest({
        model: value.brain.model,
        messages: value.messages,
        schema: value.schema,
      }, { maxRequestBytes: 2 * 1024 * 1024 });
      request = value;
      return JSON.stringify(decision);
    },
    describe() {
      return { ...brain(), remote: false };
    },
  };
  const engine = new RoleDecisionEngine({
    definition: definition("pr-engineer"),
    permissions: permissions("propose_github_review"),
    brain: brain(),
    brainRouter: router,
  });
  const result = await engine.decide({
    item: {},
    context: { requirements: { title: "年龄来源" } },
  });
  assert.equal(result.intent.body, body);
  const prompt = request.messages[0].content;
  const skill = await readFile(
    new URL("../src/skills/quick-pr-review/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.equal(
    prompt.includes(skill), true,
    "provider receives the complete packaged skill",
  );

  const otherRole = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      ...router,
      async generate(value) {
        request = value;
        return JSON.stringify(completeDecision());
      },
    },
  });
  await otherRole.decide({ item: {}, context: { requirements: {} } });
  assert.equal(request.messages[0].content.includes(skill), false);
});

test("tester receives the packaged testing workflow without changing its allowed intents", async () => {
  const requests = [];
  const router = {
    async generate(value) {
      requests.push(value);
      normalizeStructuredBrainRequest({ model: value.brain.model, messages: value.messages, schema: value.schema }, { maxRequestBytes: 2 * 1024 * 1024 });
      return JSON.stringify(completeDecision());
    },
    describe() { return { ...brain(), remote: false }; },
  };
  for (const roleId of ["tester", "developer"]) {
    const engine = new RoleDecisionEngine({
      definition: definition(roleId), permissions: permissions("complete"), brain: brain(), brainRouter: router,
    });
    await engine.decide({ item: {}, context: { requirements: {} } });
  }
  const skill = await readFile(new URL("../src/skills/controlled-testing/SKILL.md", import.meta.url), "utf8");
  assert.equal(requests[0].messages[0].content.includes(skill), true);
  assert.equal(requests[1].messages[0].content.includes(skill), false);
  assert.deepEqual(requests[0].schema, requests[1].schema);
});

test("RoleDecisionEngine reuses one entity session across roles and event revisions", async () => {
  const sessionKeys = [];
  const router = {
    async generate(request) {
      sessionKeys.push(request.sessionKey);
      return JSON.stringify(completeDecision());
    },
    describe(config) {
      return { ...config, remote: false };
    },
  };
  const developer = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
    contextFactory: async () => ({ requirements: { taskId: "task-1" } }),
  });
  const reviewer = new RoleDecisionEngine({
    definition: definition("pr-engineer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
    contextFactory: async () => ({ requirements: { taskId: "task-2" } }),
  });
  const event = {
    eventType: "issue.updated",
    subject: {
      repository: "example/product",
      number: 12953,
      title: "数据库保存问题",
    },
  };

  await developer.decide({ item: { event }, trigger: "assigned" });
  await reviewer.decide({
    item: {
      event: {
        ...event,
        eventType: "issue.commented",
      },
    },
    trigger: "user_answered",
  });

  assert.deepEqual(sessionKeys, [
    "github:issue:example/product#12953",
    "github:issue:example/product#12953",
  ]);
});

test("RoleDecisionEngine checks its configured provider without generating a decision", async () => {
  const availabilityCalls = [];
  let generateCalls = 0;
  const router = {
    async generate() {
      generateCalls += 1;
      return JSON.stringify(completeDecision());
    },
    async checkAvailability(config, options) {
      availabilityCalls.push({ config, options });
    },
    describe(config) {
      return { ...config, remote: false };
    },
  };
  const configuredBrain = brain({ model: "availability-model" });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: configuredBrain,
    brainRouter: router,
  });
  const controller = new AbortController();

  await engine.checkAvailability({ signal: controller.signal });

  assert.equal(generateCalls, 0);
  assert.equal(availabilityCalls.length, 1);
  assert.deepEqual(availabilityCalls[0].config, { ...configuredBrain,
    remoteData: { ...configuredBrain.remoteData, dingtalk: false } });
  assert.strictEqual(availabilityCalls[0].options.signal, controller.signal);
});

test("RoleDecisionEngine uses supplied trusted context without invoking its legacy factory", async () => {
  let contextFactoryCalls = 0;
  let request;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      async generate(value) {
        request = value;
        return JSON.stringify(completeDecision());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
    contextFactory: async () => {
      contextFactoryCalls += 1;
      return { requirements: { forbidden: true } };
    },
  });
  const context = {
    requirements: { taskId: "task-1" },
    code: { acceptedDependencies: [] },
  };

  await engine.decide({
    item: { privateLease: "must-not-be-read" },
    trigger: "employee:developer",
    context,
  });

  assert.equal(contextFactoryCalls, 0);
  assert.deepEqual(JSON.parse(request.messages[1].content), context);
  assert.deepEqual(request.dataClasses, ["requirements", "code"]);
  await assert.rejects(
    engine.decide({ context: { secret: { value: true } } }),
    /role context is invalid/,
  );
});

test("RoleDecisionEngine admits a bounded UTF-8 review preview while retaining total size and text checks", async () => {
  const requests = [];
  const engine = new RoleDecisionEngine({
    definition: definition("pr-engineer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      describe() { return { ...brain(), remote: false }; },
      async generate(request) {
        requests.push(request);
        return JSON.stringify(completeDecision());
      },
    },
  });
  const patch = "变".repeat(22_000);
  const context = { requirements: {}, code: { pullRequest: { reviewMaterial: { patch } } } };
  await engine.decide({ context });
  assert.equal(JSON.parse(requests[0].messages[1].content).code.pullRequest.reviewMaterial.patch, patch);
  await assert.rejects(
    engine.decide({ context: { requirements: {}, code: { patch, otherText: patch } } }),
    { code: "ROLE_CONTEXT_TOO_LARGE" },
  );
  await assert.rejects(
    engine.decide({ context: { requirements: {}, code: { patch: "invalid\u0000text" } } }),
    /role context contains invalid text/u,
  );
  assert.equal(requests.length, 1, "invalid contexts must never reach the model");
});

test("RoleDecisionEngine rejects intents outside the independent role permissions", async () => {
  const forbidden = completeDecision({
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      summary: "修改代码。",
      reason: "发现了缺陷。",
      operation: "modify",
      objective: "修复缺陷",
      acceptanceCriteria: ["测试通过"],
      evidence: ["失败测试"],
    },
  });
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate() {
        return JSON.stringify(forbidden);
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  await assert.rejects(
    engine.decide({ item: { id: "work-1" }, trigger: "assigned" }),
    (error) => error.code === "ROLE_INTENT_NOT_PERMITTED",
  );
});

test("requirements analyst cannot ask again after the owner answered the task consultation", async () => {
  const calls = [];
  const responses = [askUserDecision(), completeDecision()];
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        calls.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });
  const result = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
    context: {
      requirements: {
        decisionContext: {
          source: "attention",
          outcome: "answered",
          value: { answer: { type: "text", text: "是 5060 系列" } },
        },
      },
    },
  });

  assert.equal(result.intent.type, "complete");
  assert.equal(calls.length, 2);
  assert.match(
    calls[1].messages.at(-1).content,
    /do not return ask_user again/u,
  );
  assert.match(
    calls[0].messages[0].content,
    /family or series answer as an inclusive scope boundary/u,
  );
});

test("requirements analyst repeated attention is rejected when correction also asks again", async () => {
  let calls = 0;
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate() {
        calls += 1;
        return JSON.stringify(askUserDecision());
      },
      describe() {
        return { ...brain(), remote: false, singleAttempt: true };
      },
    },
  });

  await assert.rejects(
    engine.decide({
      item: { event: { eventType: "issue.updated" } },
      context: {
        requirements: {
          decisionContext: {
            source: "attention",
            outcome: "answered",
            value: {
              answer: { type: "choice", choiceId: "all-5060-models" },
            },
          },
        },
      },
    }),
    (error) => error.code === "ROLE_DECISION_REPEATED_ATTENTION",
  );
  assert.equal(calls, 1);
});

test("RoleDecisionEngine permits configured orchestration and delivery intents", async () => {
  const responses = [orchestrationDecision(), deliveryDecision()];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("orchestrate", "submit_delivery"),
    brain: brain(),
    brainRouter: {
      async generate() {
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const coordinated = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  const delivered = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });

  assert.equal(coordinated.intent.type, "orchestrate");
  assert.equal(coordinated.intent.action.type, "pause");
  assert.equal(delivered.intent.type, "submit_delivery");
  assert.deepEqual(engine.view().permissions.allowedIntents, [
    "orchestrate",
    "submit_delivery",
  ]);
});

test("RoleDecisionEngine rejects premature completion of initial structured PR triage", async () => {
  const responses = [completeDecision(), triageDecompositionDecision()];
  const calls = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("complete", "orchestrate"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        calls.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });
  const context = {
    requirements: {
      coordination: { directChildren: [] },
    },
    code: {
      sourceEvent: {
        eventType: "pull_request.owner_requested",
        source: { provider: "local-owner" },
        payload: {
          workType: "general",
          nextAction: "fix_ci",
          suggestedCapability: "development",
          expectedHeadRefOid: "a".repeat(40),
        },
      },
    },
  };

  const result = await engine.decide({ context });

  assert.equal(calls.length, 2);
  assert.equal(result.intent.type, "orchestrate");
  assert.equal(result.intent.action.type, "decompose");
  assert.equal(result.intent.action.capability, "development");
});

function externalRereviewContext(children = []) {
  return {
    requirements: { coordination: { directChildren: children } },
    code: { sourceEvent: {
      eventType: "pull_request.owner_requested",
      source: { provider: "local-owner" },
      payload: { workType: "general", nextAction: "rereview", suggestedCapability: "pr-review",
        expectedHeadRefOid: "a".repeat(40) },
    } },
  };
}

function oneResponseEngine(roleId, result) {
  return new RoleDecisionEngine({ definition: definition(roleId),
    permissions: permissions("complete", "orchestrate", "submit_delivery", "propose_github_review"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true }), generate: async () => JSON.stringify(result) } });
}

test("external rereview requires a required authoritative contract and accepted publication before root completion", async (t) => {
  for (const invalidKind of ["text-report", "test-report"]) {
    await t.test(`reject ${invalidKind} decomposition`, async () => {
      const result = triageDecompositionDecision("pr-review");
      result.intent.action.acceptanceContract.expectedDeliverables[0].kind = invalidKind;
      await assert.rejects(oneResponseEngine("orchestrator", result).decide({ context: externalRereviewContext() }),
        { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
    });
  }
  const accepted = { status: "completed", responsibility: { type: "role", id: "pr-engineer" },
    hasAcceptedRequiredReview: true, deliverables: [{ kind: "github-review", required: true, state: "accepted" }] };
  for (const child of [
    { ...accepted, hasAcceptedRequiredReview: false, deliverables: [{ ...accepted.deliverables[0], kind: "text-report" }] },
    { ...accepted, hasAcceptedRequiredReview: false, deliverables: [{ ...accepted.deliverables[0], required: false }] },
    { ...accepted, hasAcceptedRequiredReview: false, deliverables: [{ ...accepted.deliverables[0], state: "submitted" }] },
    { ...accepted, hasAcceptedRequiredReview: false, deliverables: [{ ...accepted.deliverables[0], state: "none" }] },
    { ...accepted, hasAcceptedRequiredReview: false, deliverables: [] },
    { ...accepted, status: "in_progress" },
    { ...accepted, responsibility: { type: "role", id: "developer" } },
    { ...accepted, hasAcceptedRequiredReview: "true" },
    { ...accepted, hasAcceptedRequiredReview: undefined },
  ]) {
    if (child.hasAcceptedRequiredReview === undefined) delete child.hasAcceptedRequiredReview;
    await assert.rejects(oneResponseEngine("orchestrator", completeDecision()).decide({ context: externalRereviewContext([child]) }),
      { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  }
  assert.equal((await oneResponseEngine("orchestrator", completeDecision()).decide({ context: externalRereviewContext([accepted]) })).intent.type, "complete");
});

test("external rereview permits an auxiliary specialist child while preserving authoritative completion", async () => {
  const original = { taskId: "existing-review", status: "in_progress",
    responsibility: { type: "role", id: "pr-engineer" }, hasAcceptedRequiredReview: false };
  const context = externalRereviewContext([original]);
  const result = triageDecompositionDecision("testing");
  result.intent.action.acceptanceContract.expectedDeliverables[0].kind = "text-report";
  const decision = await oneResponseEngine("orchestrator", result).decide({ context });
  assert.equal(decision.intent.action.capability, "testing");
  assert.deepEqual(context.requirements.coordination.directChildren, [original]);
  await assert.rejects(oneResponseEngine("orchestrator", completeDecision()).decide({ context }),
    { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  const review = triageDecompositionDecision("pr-review");
  review.intent.action.acceptanceContract.expectedDeliverables[0].kind = "text-report";
  await assert.rejects(oneResponseEngine("orchestrator", review).decide({ context }),
    { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
});

test("a legacy coordinator child does not inherit the root Review completion rule", async () => {
  const context = externalRereviewContext();
  delete context.requirements.coordination;
  context.requirements.currentTask = { parentTaskId: "review-root", acceptanceContract: {
    expectedDeliverables: [{ deliverableId: "diagnosis", kind: "text-report", required: true }],
  } };
  // Decision scope is distinct from delivery acceptance. The ledger still
  // requires the child's accepted delivery before completing its contract.
  const decision = await oneResponseEngine("orchestrator", completeDecision()).decide({ context });
  assert.equal(decision.intent.type, "complete");
});

test("contracted external reviewer proposes publication with its exact deliverable and Head", async () => {
  const context = externalRereviewContext();
  delete context.requirements.coordination;
  context.requirements.currentTask = { acceptanceContract: {
    expectedDeliverables: [{ deliverableId: "review-result", kind: "review-report", required: true }],
  } };
  const publish = completeDecision({ intent: { schemaVersion: 1, type: "propose_github_review",
    summary: "Review completed", reason: "Full current diff read", verdict: "comment", body: "Review findings",
    deliverableId: "review-result", evidence: [`head:${"a".repeat(40)}`] } });
  assert.equal((await oneResponseEngine("pr-engineer", publish).decide({ context })).intent.type, "propose_github_review");
  const unverifiedReview = deliveryDecision(); unverifiedReview.intent.deliverableId = "review-result";
  for (const result of [completeDecision(), unverifiedReview,
    { ...publish, intent: { ...publish.intent, deliverableId: "other" } },
    { ...publish, intent: { ...publish.intent, evidence: [`head:${"b".repeat(40)}`] } },
  ]) {
    await assert.rejects(oneResponseEngine("pr-engineer", result).decide({ context }),
      { code: "ROLE_DECISION_TRIAGE_CONTRACT_VIOLATION" });
  }
  context.code.internalReview = { kind: "developer_handoff" };
  context.code.sourceEvent.payload.headRefOid = "a".repeat(40);
  const local = completeDecision(); local.intent.evidence = [`head:${"a".repeat(40)}`];
  assert.equal((await oneResponseEngine("pr-engineer", local).decide({ context })).intent.type, "complete");
});

test("RoleDecisionEngine asks for one orchestration reason and derives the internal wrapper", async () => {
  const response = orchestrationDecision();
  delete response.intent.reason;
  const requests = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"), permissions: permissions("orchestrate"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true }), async generate(request) {
      requests.push(request);
      return JSON.stringify(response);
    } },
  });
  const result = await engine.decide();
  assert.deepEqual(result, orchestrationDecision());
  assert.equal(requests.length, 1);
  const schema = requests[0].schema.properties.intent.oneOf.find(variant => variant.properties?.type?.const === "orchestrate");
  assert.equal(Object.hasOwn(schema.properties, "reason"), false);
  assert.equal(schema.required.includes("reason"), false);
  assert.ok(schema.properties.action.oneOf.every(action => action.required.includes("reason")));
});

test("RoleDecisionEngine accepts the model child work shape without another model call", async () => {
  const expected = triageDecompositionDecision();
  const response = structuredClone(expected);
  const action = response.intent.action;
  delete response.intent.reason;
  for (const key of ["capability", "dependsOn", "acceptanceContract"]) {
    action.work[key] = action[key]; delete action[key];
  }
  const requests = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"), permissions: permissions("orchestrate"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true }), async generate(request) {
      requests.push(request); return JSON.stringify(response);
    } },
  });
  assert.deepEqual(await engine.decide(), expected);
  assert.equal(requests.length, 1);
  const orchestration = requests[0].schema.properties.intent.oneOf.find(v => v.properties?.type?.const === "orchestrate");
  const decompose = orchestration.properties.action.oneOf.find(v => v.properties.type.const === "decompose");
  assert.ok(decompose.properties.work.required.includes("acceptanceContract"));
  assert.match(requests[0].messages[0].content, /title, description, capability, dependsOn and acceptanceContract together in intent\.action\.work/);
});

test("RoleDecisionEngine explains and repairs the orchestration reason binding", async () => {
  const invalid = orchestrationDecision();
  invalid.intent.reason = "wrapper reason differs";
  const responses = [invalid, orchestrationDecision()];
  const requests = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("orchestrate"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        requests.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const result = await engine.decide();

  assert.equal(result.intent.action.type, "pause");
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /reason once in intent\.action\.reason/);
  assert.match(requests[1].messages.at(-1).content, /omit intent\.reason/);
});

test("RoleDecisionEngine retries one invalid structured response without replaying it", async () => {
  const calls = [];
  const invalidResponse = "untrusted invalid model output";
  const router = {
    async generate(request) {
      calls.push(request);
      return calls.length === 1
        ? invalidResponse
        : JSON.stringify(completeDecision());
    },
    describe(config) {
      return {
        provider: config.provider,
        model: config.model,
        remote: false,
        remoteData: structuredClone(config.remoteData),
      };
    },
  };
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
  });

  const result = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
    trigger: "assigned",
  });

  assert.equal(result.intent.type, "complete");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1]).includes(invalidResponse), false);
  assert.match(calls[1].messages.at(-1).content, /corrected JSON object/);
});

test("RoleDecisionEngine never starts a correction CLI after invalid output", async () => {
  const calls = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("complete"),
    brain: brain({ provider: "cli" }),
    brainRouter: {
      async generate(request) {
        calls.push(structuredClone(request));
        return "invalid CLI output";
      },
      describe(config) {
        return {
          provider: config.provider,
          model: config.model,
          remote: true,
          remoteData: structuredClone(config.remoteData),
          singleAttempt: true,
        };
      },
    },
  });

  await assert.rejects(
    engine.decide(),
    (error) => error?.code === "STRUCTURED_BRAIN_RESPONSE_INVALID",
  );
  assert.equal(calls.length, 1);
});

test("RoleDecisionEngine admits each provider request without holding the gate for network time", async () => {
  const digest = (value) => value.repeat(64);
  const gate = new ActionAdmissionGate();
  gate.bindEffective({ version: 1, configurationDigest: digest("a") });
  const responses = [deferred(), deferred()];
  const bothEntered = deferred();
  let generateCalls = 0;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    actionAdmissionGate: Object.freeze({ run: gate.run.bind(gate) }),
    brainRouter: {
      generate() {
        const response = responses[generateCalls];
        generateCalls += 1;
        if (generateCalls === responses.length) bothEntered.resolve();
        return response.promise;
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const validDecision = engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  const invalidDecision = engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  await bothEntered.promise;

  const cutover = gate.cutover(({ commit }) => {
    commit({ version: 2, configurationDigest: digest("b") });
    return "stored-v2";
  });
  assert.equal(await cutover, "stored-v2");
  assert.equal(gate.readStatus().mode, "restart_required");

  responses[0].resolve(JSON.stringify(completeDecision()));
  responses[1].resolve("invalid response");

  assert.equal((await validDecision).intent.type, "complete");
  await assert.rejects(
    invalidDecision,
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  await assert.rejects(
    engine.decide({ item: { event: { eventType: "issue.updated" } } }),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(generateCalls, 2);
});

test("RoleDecisionEngine forwards cancellation and rejects a late provider result", async () => {
  const pending = deferred();
  let providerInput = null;
  const router = new BrainRouter({
    providers: [{
      id: "local-brain",
      remote: false,
      async generate(input) {
        providerInput = input;
        await pending.promise;
        return JSON.stringify(completeDecision());
      },
    }],
  });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
  });
  const controller = new AbortController();
  const deadline = Object.assign(new Error("role decision timed out"), {
    code: "ROLE_DECISION_TIMEOUT",
  });
  const decision = engine.decide({
    item: null,
    context: { requirements: { task: "bounded" } },
    signal: controller.signal,
  });
  while (providerInput === null) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  controller.abort(deadline);
  pending.resolve();

  await assert.rejects(decision, (error) => error === deadline);
  assert.strictEqual(providerInput.signal, controller.signal);
  assert.equal(providerInput.signal.aborted, true);
});

test("the default role context separates PR code from minimum requirements data", async () => {
  let routed;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        routed = request;
        return JSON.stringify(completeDecision());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  await engine.decide({
    item: {
      itemId: "work-1",
      ownerId: "internal-owner",
      assignment: { reason: "review_requested" },
      event: { eventType: "pull_request.observed" },
      decisionContext: { value: { answer: "check the boundary" } },
    },
    trigger: "assigned",
  });

  assert.deepEqual(routed.dataClasses, ["requirements", "code"]);
  assert.deepEqual(JSON.parse(routed.messages[1].content), {
    requirements: {
      trigger: "assigned",
      assignment: { reason: "review_requested" },
      decisionContext: { value: { answer: "check the boundary" } },
    },
    code: { event: { eventType: "pull_request.observed" } },
  });
});

test("the default PR context cannot cross a remote requirements denial", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [
      {
        id: "remote-brain",
        remote: true,
        async generate(request) {
          calls.push(request);
          return JSON.stringify(completeDecision());
        },
      },
    ],
  });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain({
      provider: "remote-brain",
      remoteData: { requirements: false, code: true, memory: false },
    }),
    brainRouter: router,
  });

  await assert.rejects(
    engine.decide({
      item: {
        event: { eventType: "pull_request.observed" },
        decisionContext: {
          source: "attention",
          value: { answer: "private requirement" },
        },
      },
      trigger: "assigned",
    }),
    (error) =>
      error.code === "REMOTE_DATA_NOT_AUTHORIZED" &&
      /requirements/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("all shipped roles pause, restart, and resume independently", async () => {
  const store = new MemoryStore();
  const roleSpecs = [
    ["pr-engineer", ["ask_user", "propose_github_review", "complete"], "pr-model"],
    ["orchestrator", ["ask_user", "handoff", "complete"], "orchestrator-model"],
    ["requirements-analyst", ["ask_user", "handoff", "complete"], "requirements-model"],
    ["developer", ["ask_user", "propose_code_action", "complete"], "developer-model"],
    ["tester", ["ask_user", "handoff", "complete"], "tester-model"],
  ];
  const createRegistry = () => new EmployeeRegistry(
    roleSpecs.map(([id, intents, model]) =>
      new ConfiguredRoleEmployee({
        definition: definition(id),
        permissions: permissions(...intents),
        brain: brain({ model }),
        decisionEngine: fakeDecisionEngine(id),
        store,
      }),
    ),
  );
  let registry = createRegistry();

  for (const [roleId] of roleSpecs) {
    const before = await registry.list();
    const selected = before.find(({ role }) => role.id === roleId).role;
    await registry.control(roleId, "pause", selected.revision);
    const paused = await registry.list();
    assert.deepEqual(
      paused.map(({ role }) => role.id),
      roleSpecs.map(([id]) => id),
    );
    assert.deepEqual(
      paused.filter(({ role }) => role.paused).map(({ role }) => role.id),
      [roleId],
    );

    registry = createRegistry();
    const restarted = await registry.list();
    const restoredRole = restarted.find(({ role }) => role.id === roleId).role;
    assert.equal(restoredRole.paused, true);
    assert.equal(restoredRole.revision, selected.revision + 1);
    assert.deepEqual(
      restarted.filter(({ role }) => role.paused).map(({ role }) => role.id),
      [roleId],
    );

    await registry.control(roleId, "resume", restoredRole.revision);
    registry = createRegistry();
    const resumed = await registry.list();
    assert.equal(resumed.every(({ role }) => role.paused === false), true);
  }

  const final = await registry.list();
  assert.deepEqual(
    final.map(({ role }) => role.brain.model),
    roleSpecs.map(([, , model]) => model),
  );
});

test("task brain is safely projected while non-task activity keeps routine routing", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({
      provider: "remote-task-brain",
      model: "high-capability-model",
      remoteData: { requirements: true, code: true, memory: false },
    }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls, {
      remote: true,
    }),
    store: new MemoryStore(),
  });

  const view = await employee.roleView();
  assert.equal(view.brain.model, "routine-model");
  assert.deepEqual(view.taskBrain, {
    provider: "remote-task-brain",
    model: "high-capability-model",
    remote: true,
    remoteData: { requirements: true, code: true, memory: false, dingtalk: false },
  });

  const decision = await employee.decide({ item: { itemId: "work-1" } });
  assert.equal(decision.intent.type, "complete");
  await employee.decide({
    item: { event: { eventType: "pull_request.updated" } },
    context: { code: { untrustedClaim: "this is assigned work" } },
  });
  assert.equal(routineCalls.length, 2);
  assert.equal(taskCalls.length, 0);
});

test("assigned PR work uses the task brain while assigned issue work stays routine", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("requirements-analyst", routineCalls),
    taskDecisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      taskCalls,
    ),
    store: new MemoryStore(),
  });

  await employee.decide({ item: assignedTask("issue.updated", "issue") });
  await employee.decide({
    item: assignedTask("pull_request.updated", "pull-request"),
  });
  const sourceBoundPullRequest = assignedTask(
    "issue.updated",
    "source-bound-pull-request",
  );
  sourceBoundPullRequest.source = {
    kind: "pull_request",
    current: { event: { eventType: "pull_request.updated" } },
  };
  await employee.decide({ item: sourceBoundPullRequest });

  assert.equal(routineCalls.length, 1);
  assert.equal(taskCalls.length, 2);
  assert.equal(routineCalls[0].input.item.event.eventType, "issue.updated");
  assert.equal(
    taskCalls[0].input.item.event.eventType,
    "pull_request.updated",
  );
});

test("availability preflight uses the same routine and task brain selection as decide", async () => {
  const routineDecisions = [];
  const taskDecisions = [];
  const routineAvailability = [];
  const taskAvailability = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      routineDecisions,
      { availabilityCalls: routineAvailability },
    ),
    taskDecisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      taskDecisions,
      { availabilityCalls: taskAvailability },
    ),
    store: new MemoryStore(),
  });
  const controller = new AbortController();

  await employee.checkAvailability({
    item: assignedTask("issue.updated", "routine-availability"),
    signal: controller.signal,
  });
  await employee.asRoleWorker().checkAvailability({
    item: assignedTask("pull_request.updated", "task-availability"),
    signal: controller.signal,
  });

  assert.equal(routineDecisions.length, 0);
  assert.equal(taskDecisions.length, 0);
  assert.equal(routineAvailability.length, 1);
  assert.equal(taskAvailability.length, 1);
  assert.strictEqual(routineAvailability[0].input.signal, controller.signal);
  assert.strictEqual(taskAvailability[0].input.signal, controller.signal);
});

test("availability preflight propagates the selected task-brain failure", async () => {
  const expected = Object.assign(new Error("login unavailable"), {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const routineAvailability = [];
  const taskAvailability = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("requirements-analyst", [], {
      availabilityCalls: routineAvailability,
    }),
    taskDecisionEngine: fakeDecisionEngine("requirements-analyst", [], {
      availabilityCalls: taskAvailability,
      availabilityError: expected,
    }),
    store: new MemoryStore(),
  });

  await assert.rejects(
    employee.checkAvailability({
      item: assignedTask("pull_request.updated", "failed-availability"),
    }),
    (error) => error === expected,
  );
  assert.equal(routineAvailability.length, 0);
  assert.equal(taskAvailability.length, 1);
});

test("every assigned task for a code-capable role uses the task brain", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls),
    store: new MemoryStore(),
  });

  await employee.decide({ item: assignedTask("issue.updated", "code-task") });

  assert.equal(routineCalls.length, 0);
  assert.equal(taskCalls.length, 1);
});

test("task-risk work fails closed when no task brain is configured", async () => {
  const codeRoutineCalls = [];
  const codeEmployee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    decisionEngine: fakeDecisionEngine("developer", codeRoutineCalls),
    store: new MemoryStore(),
  });

  await assert.rejects(
    codeEmployee.decide({
      item: assignedTask("issue.updated", "missing-code-brain"),
    }),
    (error) =>
      error instanceof Error &&
      error.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED" &&
      error.statusCode === 503,
  );
  assert.equal(codeRoutineCalls.length, 0);
  await assert.rejects(
    codeEmployee.checkAvailability({
      item: assignedTask("issue.updated", "missing-code-brain-preflight"),
    }),
    (error) => error?.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  );
  assert.equal(codeRoutineCalls.length, 0);

  const prRoutineCalls = [];
  const prEmployee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    decisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      prRoutineCalls,
    ),
    store: new MemoryStore(),
  });
  await assert.rejects(
    prEmployee.decide({
      item: assignedTask("pull_request.updated", "missing-pr-brain"),
    }),
    (error) => error.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  );
  assert.equal(prRoutineCalls.length, 0);
});

test("malformed assigned-task bindings reach neither decision engine", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls),
    store: new MemoryStore(),
  });
  const missingAssignment = assignedTask(
    "pull_request.updated",
    "missing-assignment",
  );
  delete missingAssignment.assignment;
  const mismatchedAssignment = assignedTask(
    "pull_request.updated",
    "mismatched-assignment",
  );
  mismatchedAssignment.assignment.assignmentId = "assignment-other";
  const malformedEvent = assignedTask(
    "pull_request.updated",
    "malformed-event",
  );
  malformedEvent.event = { eventType: null };

  for (const item of [
    missingAssignment,
    mismatchedAssignment,
    malformedEvent,
  ]) {
    await assert.rejects(
      employee.decide({ item }),
      (error) =>
        error.code === "ROLE_TASK_BINDING_INVALID" &&
        error.statusCode === 409,
    );
  }
  assert.equal(routineCalls.length, 0);
  assert.equal(taskCalls.length, 0);
});

test("the explicit role worker port resolves and decide never deadlocks an onRun central cycle", async () => {
  const store = new MemoryStore();
  const decideCalls = [];
  let employee;
  employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer", decideCalls),
    store,
    onRun: async ({ trigger }) => {
      const result = await employee.decide({ item: { itemId: "work-1" }, trigger });
      assert.equal(result.intent.type, "complete");
    },
  });
  const directory = new RoleWorkerDirectory({
    workers: [employee.asRoleWorker()],
    legacyOwnedRoleIds: [],
  });
  const resolved = await directory.resolve({ type: "role", id: "developer" });

  const run = employee.run({ trigger: "manual" });
  await Promise.race([
    run,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("configured role run deadlocked")), 200),
    ),
  ]);

  assert.equal(resolved.roleId, "developer");
  assert.equal(resolved.workerId, employee.workerId);
  assert.equal(resolved.paused, false);
  assert.equal(decideCalls.length, 1);
  assert.equal((await employee.view()).runCount, 1);
});

test("a configured role exposes a bounded work-cycle outcome summary", async () => {
  const employee = new ConfiguredRoleEmployee({
    definition: definition("orchestrator"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("orchestrator"),
    store: new MemoryStore(),
    onRun: async () => ({
      stages: {
        work: {
          ok: true,
          result: {
            scanned: 12,
            workAttempts: 2,
            outcomes: [
              {
                itemId: "private-item-1",
                status: "degraded",
                code: "STRUCTURED_PROVIDER_UNAVAILABLE",
              },
              { itemId: "private-item-2", status: "orchestrated" },
            ],
          },
        },
      },
    }),
  });

  await employee.run({ trigger: "manual" });

  const view = await employee.roleView();
  assert.equal(
    view.lastRun.summary,
    "扫描 12 项，尝试 2 项：degraded 1（STRUCTURED_PROVIDER_UNAVAILABLE）、orchestrated 1",
  );
  assert.equal(JSON.stringify(view).includes("private-item"), false);
});

test('a real stale developer outcome keeps its host task reference through coordination and restart', async () => {
  const store = new MemoryStore(), at = "2026-11-09T14:00:00.000Z";
  const clock = () => at;
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "issue.observed", occurredAt: at,
    source: { provider: "github", scopeId: "summary-fixture" },
    subject: { id: "github:issue:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { state: "open", updatedAt: at, title: "Synthetic development task" } });
  const record = { sequence: 1, event, assignment: { assignmentId: "summary-fixture-assignment", eventId: event.eventId,
    target: { type: "role", id: "developer" } } };
  const ledger = new WorkLedgerService({ store, clock, idFactory: () => "summary-fixture-lease",
    exclusiveLease: { run: operation => operation() },
    assignmentSource: { async readAssignmentBatch({ afterSequence }) {
      return { items: afterSequence === 0 ? [record] : [], nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1 };
    } } });
  await ledger.recover(); await ledger.intake();
  const task = (await ledger.listItems()).items[0];
  assert.match(task.itemId, /^work-item-[a-f0-9]{64}$/);
  const modelReportedId = `work-item-${"b".repeat(64)}`;
  const engine = fakeDecisionEngine("developer");
  engine.decide = async () => {
    // A host transition wins while the synthetic decision is being selected.
    // The real loop must refuse that decision rather than stage its intent.
    const current = await ledger.readItemForReconciliation({ itemId: task.itemId });
    await ledger.transition({ itemId: current.itemId, expectedRevision: current.revision, leaseId: current.leaseId,
      actorId: "employee-developer", toStatus: "blocked", reason: "synthetic_input_changed", details: { code: "SYNTHETIC_INPUT_CHANGED" } });
    const decision = completeDecision({ summary: `private model report ${modelReportedId}` });
    decision.intent.evidence = [modelReportedId];
    return decision;
  };
  let coordination, observed;
  const options = { definition: definition("developer"), permissions: permissions("complete"), brain: brain(),
    decisionEngine: engine, store, clock, onRun: async ({ roleId, trigger, signal }) => {
      observed = await coordination.runCycle({ roleId, trigger, includeWork: true, signal });
      return observed;
    } };
  const employee = new ConfiguredRoleEmployee(options);
  const loop = new ProactiveWorkLoop({ ledger, clock,
    roleDirectory: new RoleWorkerDirectory({ workers: [employee.asRoleWorker()], legacyOwnedRoleIds: [] }),
    roleContextAssembler: new RoleContextAssembler({ graphReader: { getSnapshot: () => ledger.getGraphSnapshot() } }),
    orchestratorService: { async execute() { assert.fail("The stale decision cannot deliver work"); } } });
  const idle = { async runCycle() { return {}; } };
  coordination = new WorkCoordinationService({ ledger, workLoop: loop, workLimit: 1,
    proposalResultReconciler: idle, attentionResultReconciler: idle, conditionWaker: idle,
    dispatcher: { async dispatchPending() { return {}; } } });
  await employee.run({ trigger: "scheduled" });
  assert.deepEqual(observed.stages.work.result.outcomes.map(({ itemId, status, code }) => ({ itemId, status, code })),
    [{ itemId: task.itemId, status: "blocked", code: "ROLE_DECISION_INPUT_STALE" }]);
  assert.equal((await ledger.listOutbox()).items.length, 0, "the rejected model decision creates no intent");
  const view = await employee.roleView();
  assert.ok(view.lastRun.summary.includes(task.itemId), "the canonical host task ID must survive the aggregate projection");
  assert.equal(view.lastRun.summary.includes(modelReportedId), false, "model text never supplies the host reference");
  assert.equal(view.lastRun.summary.includes("private"), false);
  assert.ok(Buffer.byteLength(view.lastRun.summary) <= 512);
  assert.equal((await new ConfiguredRoleEmployee(options).roleView()).lastRun.summary, view.lastRun.summary);
});

test('a graph-rejected claim retains only a bounded canonical task reference across restart', async t => {
  for (const variant of ['canonical', 'raw-id', 'wrong-code', 'wrong-status', 'failed-stage']) await t.test(variant, async () => {
    const itemId = `work-item-${'a'.repeat(64)}`;
    const entry = { itemId, status: 'claim_not_acquired', code: 'WORK_LEDGER_GRAPH_BLOCKED', message: 'private-message' };
    if (variant === 'raw-id') entry.itemId = 'private-item-with-business-text';
    if (variant === 'wrong-code') entry.code = 'WORK_LEDGER_REVISION_CONFLICT';
    if (variant === 'wrong-status') entry.status = 'staged';
    const options = { definition: definition('orchestrator'), permissions: permissions('complete'), brain: brain(),
      decisionEngine: fakeDecisionEngine('orchestrator'), store: new MemoryStore(),
      onRun: async () => ({ stages: { work: { ok: variant !== 'failed-stage', result: {
        scanned: 100, workAttempts: 0, outcomes: [entry, { ...entry, itemId: variant === 'raw-id' ? 'private-other-item' : `work-item-${'b'.repeat(64)}` }] } } } }) };
    const employee = new ConfiguredRoleEmployee(options);
    await employee.run({ trigger: 'scheduled' });
    const summary = (await employee.roleView()).lastRun.summary;
    assert.equal(summary.includes(itemId), variant === 'canonical');
    assert.equal(summary.includes(`work-item-${'b'.repeat(64)}`), false, 'only one stable reference is retained');
    assert.equal(summary.includes('private-'), false);
    assert.ok(Buffer.byteLength(summary) <= 512);
    assert.equal((await new ConfiguredRoleEmployee(options).roleView()).lastRun.summary, summary);
  });
});

test('stale-input summaries retain only a canonical host reference for the exact failed outcome', async t => {
  for (const variant of ['canonical', 'raw-id', 'uppercase-id', 'short-id', 'wrong-code', 'wrong-status', 'malicious-code', 'malicious-status', 'malicious-id', 'trailing-newline', 'trailing-unicode-separator', 'model-only', 'failed-stage', 'accessor']) {
    await t.test(variant, async () => {
      const itemId = `work-item-${'a'.repeat(64)}`, otherId = `work-item-${'b'.repeat(64)}`;
      const entry = { itemId, status: 'blocked', code: 'ROLE_DECISION_INPUT_STALE', message: 'private-message' };
      if (variant === 'raw-id') entry.itemId = 'private-business-task';
      if (variant === 'uppercase-id') entry.itemId = `work-item-${'A'.repeat(64)}`;
      if (variant === 'short-id') entry.itemId = 'work-item-abcd';
      if (variant === 'wrong-code') entry.code = 'ROLE_DECISION_FAILED';
      if (variant === 'wrong-status') entry.status = 'retry_scheduled';
      if (variant === 'malicious-code') entry.code = 'ROLE_DECISION_INPUT_STALE\nprivate-code';
      if (variant === 'malicious-status') entry.status = 'blocked\nprivate-status';
      if (variant === 'malicious-id') entry.itemId = `${itemId}\nprivate-id`;
      if (variant === 'trailing-newline') entry.itemId = `${itemId}\n`;
      if (variant === 'trailing-unicode-separator') entry.itemId = `${itemId}\u2028`;
      if (variant === 'model-only') { delete entry.itemId; entry.summary = itemId; entry.modelReportedItemId = itemId; }
      if (variant === 'accessor') Object.defineProperty(entry, 'itemId', { enumerable: true, get() { assert.fail('No untrusted getters'); } });
      const options = { definition: definition('developer'), permissions: permissions('complete'), brain: brain(),
        decisionEngine: fakeDecisionEngine('developer'), store: new MemoryStore(),
        onRun: async () => ({ stages: { work: { ok: variant !== 'failed-stage', result: {
          scanned: 1, workAttempts: 1, outcomes: [entry, { itemId: otherId, status: 'staged', code: 'ROLE_DECISION_INPUT_STALE', summary: 'private-message' }],
        } } } }) };
      const employee = new ConfiguredRoleEmployee(options);
      await employee.run({ trigger: 'scheduled' });
      const summary = (await employee.roleView()).lastRun.summary;
      assert.equal(summary.includes(itemId), variant === 'canonical');
      assert.equal(summary.includes(otherId), false);
      assert.equal(summary.includes('private-'), false);
      assert.ok(Buffer.byteLength(summary) <= 512);
      assert.equal((await new ConfiguredRoleEmployee(options).roleView()).lastRun.summary, summary);
    });
  }
});

test('the first safe host reference is shared by graph and stale-input outcomes within the summary budget', async t => {
  for (const [first, includeRecovery] of [['graph', false], ['stale', false], ['graph', true], ['stale', true]]) await t.test(`${first} recovery=${includeRecovery}`, async () => {
    const firstId = `work-item-${'c'.repeat(64)}`, secondId = `work-item-${'d'.repeat(64)}`;
    const graph = { status: 'claim_not_acquired', code: 'WORK_LEDGER_GRAPH_BLOCKED' };
    const stale = { status: 'blocked', code: 'ROLE_DECISION_INPUT_STALE' };
    const options = { definition: definition('developer'), permissions: permissions('complete'), brain: brain(),
      decisionEngine: fakeDecisionEngine('developer'), store: new MemoryStore(),
      onRun: async () => ({ stages: { work: { ok: true, result: { scanned: Number.MAX_SAFE_INTEGER, workAttempts: Number.MAX_SAFE_INTEGER,
        outcomes: [{ itemId: 'private-invalid', ...stale }, { itemId: firstId, ...(first === 'graph' ? graph : stale) },
          { itemId: secondId, ...(first === 'graph' ? stale : graph) },
          ...Array.from({ length: 20 }, (_, index) => ({ status: 'blocked', code: `OTHER_HOST_FAILURE_${index}` }))],
      } }, ...(includeRecovery ? { own_pr_material_recovery: { ok: true, result: { verificationRecovery: {
        scanned: Number.MAX_SAFE_INTEGER, requeued: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER,
        lastFailure: 'R'.repeat(128),
      } } } } : {}) } }) };
    const employee = new ConfiguredRoleEmployee(options);
    await employee.run({ trigger: 'scheduled' });
    const summary = (await employee.roleView()).lastRun.summary;
    assert.equal(summary.includes(firstId), true, 'only the first valid reference survives even when details exceed 512 bytes');
    assert.equal(summary.includes(secondId), false);
    assert.equal(summary.includes('private-'), false);
    assert.equal(summary.includes('验证准备恢复'), includeRecovery);
    assert.ok(Buffer.byteLength(summary) <= 512);
  });
});

test('a continuation observer cannot attribute another task or ambiguous work outcomes to its target', async t => {
  for (const variant of ['other-task', 'duplicate', 'failed-stage', 'missing-code']) await t.test(variant, async () => {
    const target = { itemId: 'work-target', fingerprint: 'a'.repeat(64) };
    const entry = { itemId: target.itemId, status: 'decision_deferred', code: 'PR_FACTS_STALE' };
    if (variant === 'other-task') entry.itemId = 'other-task';
    if (variant === 'missing-code') delete entry.code;
    const employee = new ConfiguredRoleEmployee({ definition: definition('orchestrator'), permissions: permissions('complete'),
      brain: brain(), decisionEngine: fakeDecisionEngine('orchestrator'), store: new MemoryStore(),
      onRun: async () => ({ stages: { work: { ok: variant !== 'failed-stage', result: {
        outcomes: variant === 'duplicate' ? [entry, { ...entry }] : [entry] } } } }) });
    const observed = [];
    await employee.run({ continuationTarget: target, onContinuationOutcome: value => { observed.push(value); } });
    assert.deepEqual(observed, [null]);
    await employee.run({ onContinuationOutcome: () => { assert.fail('routine work has no continuation target'); } });
  });
});

test('a role exposes automatic verification recovery failures even when its work scan is empty', async () => {
  const employee = new ConfiguredRoleEmployee({ definition: definition('developer'), permissions: permissions('complete'),
    brain: brain(), decisionEngine: fakeDecisionEngine('developer'), store: new MemoryStore(),
    onRun: async () => ({ stages: {
      work: { ok: true, result: { scanned: 0, workAttempts: 0, outcomes: [] } },
      own_pr_material_recovery: { ok: true, result: { verificationRecovery: {
        scanned: 1, requeued: 0, failed: 1, lastFailure: 'OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED',
      } } },
    } }),
  });
  await employee.run({ trigger: 'scheduled' });
  assert.equal((await employee.roleView()).lastRun.summary,
    '扫描 0 项，尝试 0 项；验证准备恢复：扫描 1 项，入队 0 项，失败 1 项（OWN_PR_REPAIR_OBJECT_PREFLIGHT_FAILED）');
});

test('verification recovery summaries remain bounded and omit unsafe diagnostic data', async t => {
  for (const scenario of ['zero', 'requeued', 'unsafe-code', 'malformed-count', 'accessor', 'long-work-summary']) await t.test(scenario, async () => {
    const store = new MemoryStore(), recovery = { scanned: 1, requeued: 0, failed: 0, privateTarget: 'private-recovery-target' };
    let getters = 0;
    if (scenario === 'zero') recovery.scanned = 0;
    if (scenario === 'requeued') recovery.requeued = 1;
    if (scenario === 'unsafe-code') recovery.lastFailure = 'token=private-recovery-target\nunsafe';
    if (scenario === 'malformed-count') recovery.scanned = -1;
    if (scenario === 'accessor') Object.defineProperty(recovery, 'lastFailure', { enumerable: true, get() { getters++; throw new Error('must not read'); } });
    if (scenario === 'long-work-summary') recovery.lastFailure = 'X'.repeat(128);
    const options = { definition: definition('developer'), permissions: permissions('complete'), brain: brain(),
      decisionEngine: fakeDecisionEngine('developer'), store,
      onRun: async () => ({ stages: {
        work: { ok: true, result: { scanned: 1, workAttempts: 1,
          outcomes: scenario === 'long-work-summary' ? Array.from({ length: 8 }, (_, index) => ({ status: `outcome_${index}`, code: 'Y'.repeat(128) })) : [] } },
        own_pr_material_recovery: { ok: true, result: { verificationRecovery: recovery } },
      } }),
    };
    const employee = new ConfiguredRoleEmployee(options);
    await employee.run({ trigger: 'scheduled' });
    const view = await employee.roleView(), summary = view.lastRun.summary;
    assert.equal(getters, 0);
    assert.ok(Buffer.byteLength(summary, 'utf8') <= 512);
    assert.equal(summary.includes('private-recovery-target'), false);
    assert.equal(summary.includes('验证准备恢复'), !['malformed-count', 'accessor'].includes(scenario));
    if (scenario === 'zero') assert.ok(summary.includes('验证准备恢复：扫描 0 项'));
    if (scenario === 'requeued') assert.ok(summary.includes('入队 1 项'));
    if (scenario === 'long-work-summary') assert.ok(summary.endsWith(`（${'X'.repeat(128)}）`));
    assert.equal((await new ConfiguredRoleEmployee(options).roleView()).lastRun.summary, summary);
  });
});

test("an employee run forwards its shutdown signal and performs no state write after abort", async () => {
  const store = new MemoryStore();
  const started = deferred();
  let observedSignal = null;
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer"),
    store,
    onRun: async ({ signal }) => {
      observedSignal = signal;
      started.resolve();
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  });
  const controller = new AbortController();
  const running = employee.run({ trigger: "manual", signal: controller.signal });
  await started.promise;
  const reason = Object.assign(new Error("shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
  controller.abort(reason);

  await assert.rejects(
    Promise.race([
      running,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("employee did not abort")),
        50,
      )),
    ]),
    (error) => error === reason,
  );
  assert.strictEqual(observedSignal, controller.signal);
  assert.equal((await employee.view()).runCount, 0);
});

test("pausing a role invalidates a task-brain decision already in flight", async () => {
  const store = new MemoryStore();
  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const employee = new ConfiguredRoleEmployee({
    definition: definition("tester"),
    permissions: permissions("complete"),
    brain: brain(),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("tester"),
    taskDecisionEngine: {
      view() {
        return { brain: { remote: false } };
      },
      async decide() {
        entered();
        await gate;
        return completeDecision();
      },
    },
    store,
  });

  const deciding = employee.decide({
    item: assignedTask("pull_request.updated", "in-flight"),
  });
  await started;
  await employee.control("pause", 0);
  release();

  await assert.rejects(deciding, (error) => error.code === "ROLE_PAUSED");
});

test("onRun can persist a pause without waiting for its own role queue", async () => {
  const store = new MemoryStore();
  let employee;
  employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer"),
    store,
    onRun: async () => {
      const revision = (await employee.roleView()).revision;
      await employee.control("pause", revision);
    },
  });

  await employee.run({ trigger: "manual" });
  assert.equal(employee.running, null);
  assert.equal((await employee.roleView()).paused, true);
  assert.equal((await employee.view()).lastErrorCode, "");
});

test('coordination failures retain bounded stage and cause codes for automatic recovery diagnosis', async () => {
  const store = new MemoryStore();
  const failure = Object.assign(new Error('private provider response'), {
    code: 'WORK_COORDINATION_STAGE_FAILED', stage: 'work', causeCodes: ['ORCHESTRATOR_CONTEXT_STALE'],
  });
  const employee = new ConfiguredRoleEmployee({ definition: definition('orchestrator'),
    permissions: permissions('complete'), brain: brain(), decisionEngine: fakeDecisionEngine('orchestrator'),
    store, onRun: async () => { throw failure; } });
  await assert.rejects(employee.run({ trigger: 'scheduled' }), e => e === failure);
  const persisted = await store.read('configured-role-orchestrator-state');
  assert.match(persisted.lastRun.summary, /work.*ORCHESTRATOR_CONTEXT_STALE/);
  assert.doesNotMatch(JSON.stringify(persisted), /private provider response/);
});

test('failure diagnostics preserve original errors without invoking accessor properties', async (t) => {
  let getterCalls = 0;
  const accessors = Object.assign(new Error('private'), { stage: 'work' });
  for (const name of ['causeCodes', 'errors']) Object.defineProperty(accessors, name, { get() { getterCalls += 1; throw new Error('accessed'); } });
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  for (const [name, failure] of [['accessors', accessors], ['revoked-proxy', proxy]]) {
    await t.test(name, async () => {
      const store = new MemoryStore();
      const employee = new ConfiguredRoleEmployee({ definition: definition('tester'), permissions: permissions('complete'),
        brain: brain(), decisionEngine: fakeDecisionEngine('tester'), store, onRun: async () => { throw failure; } });
      let caught;
      try { await employee.run({ trigger: 'scheduled' }); } catch (error) { caught = error; }
      assert.equal(caught, failure);
      assert.equal((await store.read('configured-role-tester-state')).lastErrorCode, 'ROLE_RUN_FAILED');
    });
  }
  assert.equal(getterCalls, 0);
});

test("persisted failures and public state never contain provider secrets", async () => {
  const store = new MemoryStore();
  const secret = "provider-secret-value";
  const error = Object.assign(new Error(`vendor leaked ${secret}`), {
    code: "REMOTE_PROVIDER_FAILED",
  });
  const employee = new ConfiguredRoleEmployee({
    definition: definition("tester"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("tester"),
    store,
    onRun: async () => {
      throw error;
    },
  });

  await assert.rejects(employee.run({ trigger: "scheduled" }), (value) => value === error);
  const view = await employee.view();
  const persisted = await store.read("configured-role-tester-state");

  assert.equal(view.lastErrorCode, "REMOTE_PROVIDER_FAILED");
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
});


test("PR decisions send the pinned target and complete feedback binding to a CLI reader instead of treating preview truncation as final", async () => {
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "acme/repo", headRefName: "feature", headRefOid: "b".repeat(40) };
  let request;
  const engine = new RoleDecisionEngine({ definition: definition("pr-engineer"), permissions: permissions("complete", "propose_github_review"), brain: brain(), brainRouter: {
    describe() { return { ...brain(), remote: false, supportsReviewReading: true }; },
    async generate(value) { request = value; return JSON.stringify(completeDecision()); },
  } });
  const context = { requirements: { currentTask: { taskId: "review-task" } }, code: { sourceEvent: { subject: { number: 42 } },
    pullRequest: { materialDigest: "c".repeat(64), reviewMaterial: { gitTarget, patchTruncated: true, filesTruncated: true } } } };
  await engine.decide({ item: assignedTask(), context });
  assert.deepEqual(request.reviewTarget, { gitTarget, pullRequestNumber: 42, feedbackSnapshot: { taskId: "review-task", materialDigest: "c".repeat(64) } });
  assert.match(request.messages[0].content, /Use the pr_review read-only tools/);
  normalizeStructuredBrainRequest({ model: request.brain.model, messages: request.messages, schema: request.schema, reviewTarget: request.reviewTarget }, { maxRequestBytes: 2 * 1024 * 1024 });
  request = null;
  delete context.code.pullRequest.materialDigest;
  await assert.rejects(engine.decide({ item: assignedTask(), context }), { code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE" });
  assert.equal(request, null, "incomplete feedback fails before another model call");
});

test("Review reuse requires a host candidate and the complete native material reading boundary", async () => {
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo", baseRefName: "main",
    baseRefOid: "a".repeat(40), headRepository: "acme/repo", headRefName: "fix", headRefOid: "b".repeat(40) };
  const publicationReuse = { candidateId: "review-publication-candidate-" + "c".repeat(64), materialDigest: "d".repeat(64), coverageDigest: "e".repeat(64) };
  const decision = completeDecision({ intent: { schemaVersion: 1, type: "propose_github_review", summary: "Adopt verified Review",
    reason: "Current materials assessed", verdict: "approve", body: "Local current coverage assessment", evidence: ["head:bbbbbbbb"], publicationReuse } });
  const engine = fixedDecisionEngine("pr-engineer", decision);
  const context = { requirements: { currentTask: { taskId: "review-task" } }, code: { sourceEvent: { subject: { number: 42 } },
    pullRequest: { materialDigest: publicationReuse.materialDigest, reviewMaterial: { gitTarget } } } };
  await assert.rejects(engine.decide({ item: assignedTask(), context }), { code: "ROLE_DECISION_REVIEW_REUSE_UNAVAILABLE" });
  context.code.reviewPublicationReuse = { complete: true, candidates: [{ ...publicationReuse, verdict: "approve" }] };
  assert.equal((await engine.decide({ item: assignedTask(), context })).intent.publicationReuse.candidateId, publicationReuse.candidateId);
  const noRead = new RoleDecisionEngine({ definition: definition("pr-engineer"), permissions: permissions("propose_github_review"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true }), generate: async () => JSON.stringify(decision) } });
  await assert.rejects(noRead.decide({ item: assignedTask(), context }), { code: "ROLE_DECISION_REVIEW_REUSE_UNAVAILABLE" });
});

test("host-proven code Review uses a residual decision without native review tools and retains extra obligations", async t => {
  const publicationReuse = { candidateId: "review-publication-candidate-" + "c".repeat(64), materialDigest: "d".repeat(64),
    coverageDigest: "e".repeat(64), readProofId: "review-read-proof-" + "f".repeat(64) };
  const decision = completeDecision({ intent: { schemaVersion: 1, type: "propose_github_review", summary: "Reuse proven code Review",
    reason: "Host coverage proof", verdict: "approve", body: "Code Review reused; QA note remains pending", evidence: ["head:bbbbbbbb"],
    deliverableId: "review", publicationReuse } });
  let request, responseDecision = decision, brainCalls = 0;
  const engine = new RoleDecisionEngine({ definition: definition("pr-engineer"), permissions: permissions("propose_github_review"), brain: brain(),
    brainRouter: { describe: () => ({ singleAttempt: true, supportsReviewReading: true, supportsNativeReviewSkills: true }),
      async generate(value) { brainCalls++; request = value; return JSON.stringify(responseDecision); } } });
  const context = { requirements: { currentTask: { taskId: "owner-child", acceptanceContract: {
    expectedDeliverables: [{ deliverableId: "review", kind: "github-review", required: true }, { deliverableId: "qa-note", kind: "text-report", required: true }] } } },
    code: { sourceEvent: { subject: { number: 42 } }, pullRequest: { materialDigest: publicationReuse.materialDigest },
      reviewPublicationReuse: { complete: true, candidates: [{ ...publicationReuse, verdict: "approve", deliverableId: "review" }],
        verifiedResult: { ...publicationReuse, verdict: "approve", deliverableId: "review" } } } };
  const fullContext = structuredClone(context);
  delete fullContext.code.reviewPublicationReuse.verifiedResult;
  fullContext.code.pullRequest.reviewMaterial = { patch: "diff preview ".repeat(5000), gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer",
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40), headRepository: "acme/repo", headRefName: "fix", headRefOid: "b".repeat(40) } };
  responseDecision = structuredClone(decision);
  delete responseDecision.intent.publicationReuse.readProofId;
  await engine.decide({ item: assignedTask(), context: fullContext });
  const fullRequestBytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, schema: request.schema }));
  assert.ok(request.reviewTarget);
  responseDecision = decision;
  const result = await engine.decide({ item: assignedTask(), context });
  assert.equal(brainCalls, 2);
  t.diagnostic(JSON.stringify({ fixture: "same-task-same-brain-capture-only", fullRequestBytes,
    reusedRequestBytes: Buffer.byteLength(JSON.stringify({ messages: request.messages, schema: request.schema })),
    fullRoleBrainCalls: 1, reusedResidualBrainCalls: 1, fullNativeReviewReadingRequired: true, reusedNativeReviewReadingRequired: false,
    nativeBillingMeasured: false }));
  assert.equal(result.intent.type, "propose_github_review");
  assert.equal(request.reviewTarget, undefined, "no reader, native skill or T3 reviewers should be launched");
  assert.equal(JSON.stringify(request.messages).includes("diff preview"), false);
  assert.match(request.messages[0].content, /without another T3 assessment/);
  const supplied = JSON.parse(request.messages.find(m => m.role === "user").content);
  assert.equal(supplied.requirements.currentTask.acceptanceContract.expectedDeliverables[1].required, true);
  context.code.reviewPublicationReuse.verifiedResult.automaticSettlement = { kind: "automatic_review_settlement", taskId: "owner-child" };
  responseDecision = completeDecision();
  await assert.rejects(engine.decide({ item: assignedTask(), context }), { code: "ROLE_DECISION_REVIEW_REUSE_UNAVAILABLE" });
  responseDecision = decision;
  delete context.code.reviewPublicationReuse.verifiedResult.automaticSettlement;
  const retainedReuse = decision.intent.publicationReuse;
  delete decision.intent.publicationReuse;
  await assert.rejects(engine.decide({ item: assignedTask(), context }), { code: "ROLE_DECISION_REVIEW_REUSE_UNAVAILABLE" });
  decision.intent.publicationReuse = retainedReuse;
  delete context.code.reviewPublicationReuse.verifiedResult;
  await assert.rejects(engine.decide({ item: assignedTask(), context }), { code: "ROLE_DECISION_REVIEW_REUSE_UNAVAILABLE" });
});
