import assert from "node:assert/strict";
import test from "node:test";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { createDeliveryEvidenceTarget } from "../src/domain/delivery-evidence-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createOwnerPullRequestEvent, withOwnerWorkRequestDefaultRoute } from "../src/domain/owner-work-request.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";
import { ownerWorkRequestForItem } from "../public/manual-work-assignment.js";
import {
  WorkIntentPolicyError,
  createWorkIntentPolicy,
} from "../src/services/work-intent-policy.js";
import { externalActionControlledCommit } from "./support/pull-request-external-action-fixture.js";

function event(overrides = {}) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T01:02:03.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: {
      title: "Fix race",
      headRefOid: "abc123",
      state: "open",
      changedFields: ["headRefOid"],
    },
    ...overrides,
  });
}

function inputBinding(trustedEvent, rootItemId) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: trustedEvent.subject.repository,
    pullRequestNumber: trustedEvent.subject.number,
    rootItemId,
    workKey: "github:dashboard:acme-repo:42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: trustedEvent.payload.headRefOid,
    eventId: trustedEvent.eventId,
    eventDigest: trustedEvent.contentDigest,
    inputDigest: "d".repeat(64),
  };
}

function context(overrides = {}) {
  const trustedEvent = overrides.event ?? event();
  const result = {
    assignmentId: `workflow-assignment-${"a".repeat(64)}`,
    workItemId: `work-item-${"b".repeat(64)}`,
    roleId: "pr-reviewer",
    event: trustedEvent,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "inputBinding")) {
    result.inputBinding = inputBinding(trustedEvent, result.workItemId);
  }
  return result;
}

function gitContext(overrides = {}) {
  const headRefOid = "a".repeat(40);
  const trustedEvent = event({
    payload: {
      title: "Resolve conflict",
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/conflict",
        headRefOid,
      },
      gitTargetAvailable: true,
      headRefOid,
      state: "open",
      changedFields: ["baseRefOid"],
    },
  });
  const rootItemId = `work-item-${"b".repeat(64)}`;
  const legacy = inputBinding(trustedEvent, rootItemId);
  return context({
    event: trustedEvent,
    roleId: "developer",
    inputBinding: {
      ...legacy,
      schemaVersion: 2,
      gitTarget: structuredClone(trustedEvent.payload.gitTarget),
    },
    ...overrides,
  });
}

function conflictContext() {
  const trusted = gitContext();
  const gitTarget = trusted.inputBinding.gitTarget;
  const workspaceSource = createConflictPreparationBinding({
    preparation: {
      schemaVersion: 1,
      preparationId: "1".repeat(64),
      status: "conflicted",
      baseCommitOid: gitTarget.baseRefOid,
      headCommitOid: gitTarget.headRefOid,
      mergeBaseOid: "e".repeat(40),
      resultTreeOid: "f".repeat(40),
      conflicts: [{ path: "src/value.js", mode: "100644" }],
      boundaryDigest: "2".repeat(64),
      evidenceDigest: "3".repeat(64),
      resultObjectDigest: "4".repeat(64),
      materialization: "full-tree",
    },
    gitTarget,
  });
  return {
    ...trusted,
    executionSource: createConflictCodeExecutionSource({
      inputBinding: trusted.inputBinding,
      preparationBinding: workspaceSource,
    }),
  };
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成核对",
    reason: "需要推进下一步",
  };
}

function orchestrateIntent() {
  const reason = "等待当前依赖恢复";
  return {
    ...common("orchestrate"),
    reason,
    action: {
      schemaVersion: 1,
      type: "pause",
      sourceTaskId: context().workItemId,
      sourceTaskRevision: 4,
      expectedGraphRevision: 8,
      reason,
    },
  };
}

function submitDeliveryIntent() {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: context().workItemId,
    expectedTaskRevision: 6,
    expectedGraphRevision: 9,
    contractRevision: 1,
    deliverableId: "implementation",
    summary: "实现和聚焦测试已经完成",
    reason: "当前证据满足提交条件",
    evidence: [{
      kind: "change-package",
      referenceId: "change-package:development:1",
      contentDigest: "a".repeat(64),
    }],
    artifact: null,
  };
}

function policy(overrides = {}) {
  return createWorkIntentPolicy({
    version: 3,
    capabilityRoles: {
      coordination: "orchestrator",
      requirements: "requirements-analyst",
      "pr-review": "pr-reviewer",
      development: "developer",
      testing: "tester",
    },
    githubReviewRoles: ["pr-reviewer"],
    codeActionRoles: ["developer"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
    },
    workspaceByRepository: { "acme/repo": "acme-workspace" },
    ...overrides,
  });
}

function acceptanceContract() {
  return {
    revision: 4,
    acceptanceCriteria: [
      { criterionId: "verified", description: "受控执行结果可复核" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "主实现变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "change-package",
        description: "验证变更包",
        required: true,
      },
    ],
  };
}

test("internal reviews cannot publish external Review or PR actions", () => {
  for (const intent of [
    { ...common("propose_github_review"), verdict: "approve", body: "Reviewed", evidence: ["head:abc123"] },
    { ...common("propose_github_pull_request_action"), action: { type: "comment", body: "Reviewed" }, evidence: ["head:abc123"] },
  ]) {
    assert.throws(() => policy().bind({ context: context({ internalReview: true }), intent }), { code: "WORK_INTENT_POLICY_DENIED" });
  }
});

test("binds user questions and waits to the trusted work item and event", () => {
  const created = policy().bind({
    context: context(),
    intent: {
      ...common("ask_user"),
      question: "是否接受新的验收口径？",
      choices: [{ id: "accept", label: "接受", description: "继续推进" }],
    },
  });

  assert.equal(created.kind, "attention_request");
  assert.deepEqual(created.requestedBy, {
    roleId: "pr-reviewer",
    workItemId: context().workItemId,
  });
  assert.equal(created.source.assignmentId, context().assignmentId);
  assert.equal(created.source.eventId, context().event.eventId);
  assert.equal(created.binding.subject.repository, "acme/repo");
  assert.equal(created.payload.question, "是否接受新的验收口径？");
  assert.match(created.intentId, /^work-intent-[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(created));

  const waiting = policy().bind({
    context: context(),
    intent: {
      ...common("wait_condition"),
      condition: { kind: "workflow_fact", fact: "ci-status", oneOf: ["success"] },
      checkAfterSeconds: 300,
    },
  });
  assert.equal(waiting.kind, "wait_condition");
  assert.deepEqual(waiting.payload.condition, {
    kind: "workflow_fact",
    fact: "ci-status",
    oneOf: ["success"],
  });
  assert.equal(waiting.payload.checkAfterSeconds, 300);
});

test("derives a GitHub review target only from the trusted event", () => {
  const bound = policy().bind({
    context: context(),
    intent: {
      ...common("propose_github_review"),
      verdict: "comment",
      body: "建议补一条并发回归测试。",
      evidence: ["状态更新可能丢失"],
    },
  });

  assert.equal(bound.kind, "github_review_proposal");
  assert.deepEqual(bound.binding, {
    eventId: context().event.eventId,
    subject: context().event.subject,
    repository: "acme/repo",
    pullRequestNumber: 42,
    headRefOid: "abc123",
    inputBinding: context().inputBinding,
  });
  assert.equal(Object.hasOwn(bound.binding, "accountId"), false);
  assert.equal(Object.hasOwn(bound.payload, "command"), false);
  assert.equal(bound.payload.verdict, "comment");

  const repeated = policy().bind({
    context: context(),
    intent: {
      ...common("propose_github_review"),
      verdict: "comment",
      body: "建议补一条并发回归测试。",
      evidence: ["状态更新可能丢失"],
    },
  });
  assert.equal(repeated.intentId, bound.intentId);
});

test("allows an owner-requested active PR to produce a GitHub review proposal", () => {
  const headRefOid = "a".repeat(40);
  const trustedEvent = event({
    eventType: "pull_request.owner_requested",
    source: {
      provider: "local-owner",
      scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000",
    },
    payload: {
      title: "Fix race",
      headRefOid,
      state: "open",
      changedFields: ["headRefOid"],
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/race",
        headRefOid,
      },
    },
  });
  const rootItemId = `work-item-${"b".repeat(64)}`;
  const trustedContext = context({
    event: trustedEvent,
    roleId: "pr-engineer",
    workItemId: rootItemId,
    inputBinding: {
      ...inputBinding(trustedEvent, rootItemId),
      schemaVersion: 2,
      gitTarget: structuredClone(trustedEvent.payload.gitTarget),
    },
  });
  const bound = policy({ githubReviewRoles: ["pr-engineer"] }).bind({
    context: trustedContext,
    intent: {
      ...common("propose_github_review"),
      verdict: "request_changes",
      body: "请先修复阻断问题。",
      evidence: ["完整补丁显示输入校验发生在分配之后。"],
    },
  });

  assert.equal(bound.kind, "github_review_proposal");
  assert.equal(bound.binding.eventId, trustedContext.event.eventId);
  assert.equal(bound.binding.repository, "acme/repo");
  assert.equal(bound.binding.pullRequestNumber, 42);
  assert.equal(bound.binding.headRefOid, headRefOid);

  assert.throws(
    () => policy({ githubReviewRoles: ["pr-engineer"] }).bind({
      context: trustedContext,
      intent: {
        ...common("propose_github_pull_request_action"),
        action: { type: "merge", method: "squash" },
        evidence: ["owner requested a review, not a merge"],
      },
    }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("denies a legacy owner-requested PR without a trusted OPEN snapshot", () => {
  const headRefOid = "a".repeat(40);
  const legacyEvent = event({
    eventType: "pull_request.owner_requested",
    source: {
      provider: "local-owner",
      scopeId: "owner-request:123e4567-e89b-42d3-a456-426614174000",
    },
    payload: {
      title: "Legacy request",
      headRefOid,
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/legacy",
        headRefOid,
      },
    },
  });
  const rootItemId = `work-item-${"b".repeat(64)}`;
  const legacyContext = context({
    event: legacyEvent,
    roleId: "pr-engineer",
    workItemId: rootItemId,
    inputBinding: {
      ...inputBinding(legacyEvent, rootItemId),
      schemaVersion: 2,
      gitTarget: structuredClone(legacyEvent.payload.gitTarget),
    },
  });

  assert.throws(
    () => policy({ githubReviewRoles: ["pr-engineer"] }).bind({
      context: legacyContext,
      intent: {
        ...common("propose_github_review"),
        verdict: "comment",
        body: "This must not publish.",
        evidence: ["No trusted OPEN snapshot"],
      },
    }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("binds five PR external actions only for a trusted role and v2 target", () => {
  const trusted = gitContext({ roleId: "pr-reviewer" });
  const controlledCommitEvidence = externalActionControlledCommit(
    trusted.inputBinding,
  );
  const actions = [
    { type: "comment", body: "请补充失败日志。" },
    { type: "review", verdict: "comment", body: "建议补充并发测试。" },
    { type: "update_branch" },
    {
      type: "push",
      controlledCommitEvidenceId: controlledCommitEvidence.evidenceId,
    },
    { type: "merge", method: "squash" },
  ];

  for (const requestedAction of actions) {
    const bound = policy().bind({
      context: {
        ...trusted,
        ...(requestedAction.type === "push"
          ? { controlledCommitEvidence }
          : {}),
      },
      intent: {
        ...common("propose_github_pull_request_action"),
        action: requestedAction,
        evidence: ["trusted-task-context"],
      },
    });
    assert.equal(bound.kind, "github_pull_request_action_proposal");
    assert.equal(bound.binding.inputBinding.schemaVersion, 2);
    assert.equal(bound.binding.repository, trusted.event.subject.repository);
    assert.equal(bound.binding.headRefOid, trusted.event.payload.headRefOid);
    assert.equal(bound.payload.action.type, requestedAction.type);
    if (requestedAction.type === "push") {
      assert.equal(
        bound.payload.action.controlledCommitEvidence.evidenceId,
        controlledCommitEvidence.evidenceId,
      );
      assert.equal(
        Object.hasOwn(bound.payload.action, "controlledCommitEvidenceId"),
        false,
      );
    }
  }

  assert.throws(
    () => policy().bind({
      context: trusted,
      intent: {
        ...common("propose_github_pull_request_action"),
        action: {
          type: "push",
          controlledCommitEvidenceId: controlledCommitEvidence.evidenceId,
        },
        evidence: [],
      },
    }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
  assert.throws(
    () => policy().bind({
      context: context(),
      intent: {
        ...common("propose_github_pull_request_action"),
        action: { type: "comment", body: "legacy binding" },
        evidence: [],
      },
    }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("maps code workspaces and handoff roles from policy rather than model output", () => {
  const code = policy().bind({
    context: gitContext(),
    intent: {
      ...common("propose_code_action"),
      operation: "modify",
      objective: "修复并发覆盖",
      acceptanceCriteria: ["回归测试通过"],
      evidence: ["revision 未校验"],
    },
  });
  assert.equal(code.kind, "code_action_proposal");
  assert.equal(code.binding.workspaceId, "acme-workspace");
  assert.equal(code.binding.repository, "acme/repo");
  assert.deepEqual(code.binding.inputBinding, gitContext().inputBinding);
  assert.deepEqual(Object.keys(code.payload), [
    "operation",
    "objective",
    "acceptanceCriteria",
    "evidence",
    "summary",
    "reason",
  ]);

  const handoff = policy().bind({
    context: context(),
    intent: {
      ...common("handoff"),
      capability: "testing",
      brief: "执行跨平台回归",
      evidence: [],
    },
  });
  assert.equal(handoff.kind, "handoff");
  assert.equal(handoff.binding.targetRoleId, "tester");
  assert.equal(handoff.payload.capability, "testing");
});

test("manual PR development and testing retain trusted repository and Git target through routing and code policy", () => {
  const gitTarget = gitContext().event.payload.gitTarget;
  const config = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [],
  });
  const codePolicy = policy({
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["modify"],
      tester: ["verify"],
    },
  });
  for (const [workType, roleId, operation] of [
    ["development", "developer", "modify"],
    ["testing", "tester", "verify"],
  ]) {
    const request = ownerWorkRequestForItem({
      kind: "pull_request",
      repo: "acme/repo",
      number: 42,
      title: "Fix race",
    }, {
      workType,
      priority: "high",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const trustedEvent = createOwnerPullRequestEvent(request, {
      repository: "acme/repo",
      number: 42,
      title: "Fix race",
      state: "open",
      gitTarget,
    }, "2026-08-02T01:02:03.000Z");
    const routed = routeWorkflowEvent({ event: trustedEvent, config });
    assert.deepEqual(routed.assignments.map(({ target }) => target), [
      { type: "role", id: roleId },
    ]);
    const binding = {
      ...inputBinding(trustedEvent, `work-item-${"b".repeat(64)}`),
      schemaVersion: 2,
      gitTarget,
    };
    const bound = codePolicy.bind({
      context: context({ event: trustedEvent, roleId, inputBinding: binding }),
      intent: {
        ...common("propose_code_action"),
        operation,
        objective: "Complete the selected PR work",
        acceptanceCriteria: ["Relevant checks pass"],
        evidence: [],
      },
    });
    assert.equal(bound.binding.repository, "acme/repo");
    assert.equal(bound.binding.workspaceId, "acme-workspace");
    assert.deepEqual(bound.binding.inputBinding.gitTarget, gitTarget);
  }
});

test("legacy PR bindings are recovery-only and cannot create code proposals", () => {
  assert.throws(
    () => policy().bind({
      context: context({ roleId: "developer" }),
      intent: {
        ...common("propose_code_action"),
        operation: "modify",
        objective: "修改旧版 PR 输入",
        acceptanceCriteria: ["回归测试通过"],
        evidence: [],
      },
    }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("code proposals preserve the complete trusted Git target and reject same-Head base drift", () => {
  const trustedContext = gitContext();
  const intent = {
    ...common("propose_code_action"),
    operation: "modify",
    objective: "解决固定 base/head 的冲突",
    acceptanceCriteria: ["冲突验证通过"],
    evidence: ["merge state is dirty"],
  };
  const bound = policy().bind({ context: trustedContext, intent });

  assert.equal(bound.binding.inputBinding.schemaVersion, 2);
  assert.deepEqual(
    bound.binding.inputBinding.gitTarget,
    trustedContext.inputBinding.gitTarget,
  );

  const changedEvent = event({
    payload: {
      ...trustedContext.event.payload,
      gitTarget: {
        ...trustedContext.event.payload.gitTarget,
        baseRefOid: "c".repeat(40),
      },
    },
  });
  assert.throws(
    () => policy().bind({
      context: { ...trustedContext, event: changedEvent },
      intent,
    }),
    (error) => error.code === "WORK_INTENT_CONTEXT_INVALID",
  );
});

test("code policy preserves sealed conflict workspace authority only for modify", () => {
  const trustedContext = conflictContext();
  const modify = policy().bind({
    context: trustedContext,
    intent: {
      ...common("propose_code_action"),
      operation: "modify",
      objective: "解决已准备的冲突",
      acceptanceCriteria: ["固定测试通过"],
      evidence: ["conflict preparation sealed"],
    },
  });
  assert.deepEqual(modify.binding.inputBinding, trustedContext.inputBinding);
  assert.deepEqual(
    modify.binding.executionSource,
    trustedContext.executionSource,
  );
  assert.throws(
    () =>
      policy().bind({
        context: trustedContext,
        intent: {
          ...common("propose_code_action"),
          operation: "inspect",
          objective: "绕过冲突写权限",
          acceptanceCriteria: ["不应创建"],
          evidence: [],
        },
      }),
    (error) => error?.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("sealed conflict workspace authority cannot leak into non-code intents", () => {
  assert.throws(
    () =>
      policy().bind({
        context: conflictContext(),
        intent: {
          ...common("ask_user"),
          question: "是否绕过代码工作提案直接继续？",
          choices: [
            { id: "continue", label: "继续", description: "不应创建" },
          ],
        },
      }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("proposal authority binds one selected delivery and the durable dispatch identity", () => {
  const trustedContext = gitContext();
  const evidenceTarget = createDeliveryEvidenceTarget({
    taskId: trustedContext.workItemId,
    roleId: trustedContext.roleId,
    acceptanceContract: acceptanceContract(),
    deliverableId: "verification",
  });
  const dispatchIntentId = `work-dispatch-intent-${"e".repeat(64)}`;
  const intent = {
    ...common("propose_code_action"),
    deliverableId: "verification",
    dispatchIntentId,
    operation: "verify",
    objective: "验证指定交付物",
    acceptanceCriteria: ["聚焦测试通过"],
    evidence: [],
  };

  const bound = policy().bind({
    context: { ...trustedContext, evidenceTarget },
    intent,
  });

  assert.deepEqual(bound.binding.evidenceTarget, evidenceTarget);
  assert.equal(bound.binding.evidenceTarget.deliverables.length, 1);
  assert.equal(
    bound.binding.evidenceTarget.deliverables[0].deliverableId,
    "verification",
  );
  assert.equal(bound.binding.dispatchIntentId, dispatchIntentId);

  const nonAuthoritative = policy().bind({
    context: trustedContext,
    intent,
  });
  assert.equal(
    Object.hasOwn(nonAuthoritative.binding, "evidenceTarget"),
    false,
  );
  assert.equal(nonAuthoritative.binding.dispatchIntentId, dispatchIntentId);

  const continued = policy().bind({
    context: { ...trustedContext, evidenceTarget },
    intent: {
      ...intent,
      dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
    },
  });
  assert.notEqual(continued.intentId, bound.intentId);
  assert.notEqual(continued.binding.dispatchIntentId, dispatchIntentId);
});

test("proposal policy rejects foreign or differently selected evidence authority", () => {
  const trustedContext = gitContext();
  const target = createDeliveryEvidenceTarget({
    taskId: trustedContext.workItemId,
    roleId: trustedContext.roleId,
    acceptanceContract: acceptanceContract(),
    deliverableId: "verification",
  });
  const baseIntent = {
    ...common("propose_code_action"),
    operation: "modify",
    objective: "修改主实现",
    acceptanceCriteria: ["测试通过"],
    evidence: [],
  };
  const foreignTask = { ...target, taskId: `work-item-${"f".repeat(64)}` };

  for (const [evidenceTarget, deliverableId] of [
    [target, "implementation"],
    [foreignTask, "verification"],
  ]) {
    assert.throws(
      () => policy().bind({
        context: { ...trustedContext, evidenceTarget },
        intent: { ...baseIntent, deliverableId },
      }),
      (error) =>
        error instanceof WorkIntentPolicyError &&
        error.code === "WORK_INTENT_CONTEXT_INVALID",
    );
  }
});

test("code operations are configurable per trusted role", () => {
  const configured = policy({
    codeActionRoles: ["developer", "tester"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
      tester: ["inspect", "verify"],
    },
  });

  assert.throws(
    () =>
      configured.bind({
        context: gitContext({ roleId: "tester" }),
        intent: {
          ...common("propose_code_action"),
          operation: "modify",
          objective: "修改实现",
          acceptanceCriteria: ["测试通过"],
          evidence: [],
        },
      }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("completion remains internal and carries no execution capability", () => {
  const complete = policy().bind({
    context: context(),
    intent: {
      ...common("complete"),
      outcome: "no-action",
      evidence: ["事项已关闭"],
    },
  });
  assert.equal(complete.kind, "complete");
  assert.deepEqual(complete.binding, {
    eventId: context().event.eventId,
    subject: context().event.subject,
  });
  assert.equal(JSON.stringify(complete).includes("command"), false);
});

test("configuration proposals bind only an explicitly trusted role and no activation authority", () => {
  const intent = {
    ...common("propose_configuration_change"),
    changes: [
      {
        path: ["employees", "roles", "developer", "scheduleMinutes"],
        value: 15,
      },
    ],
    evidence: ["queue depth increased"],
  };
  const bound = policy({ configurationChangeRoles: ["developer"] }).bind({
    context: context({ roleId: "developer" }),
    intent,
  });

  assert.equal(bound.kind, "configuration_change_proposal");
  assert.deepEqual(bound.payload.changes, intent.changes);
  assert.deepEqual(bound.binding, {
    eventId: context().event.eventId,
    subject: context().event.subject,
  });
  for (const forbidden of ["activate", "expectedStateRevision", "draftId"] ) {
    assert.equal(JSON.stringify(bound).includes(forbidden), false);
  }

  assert.throws(
    () => policy().bind({ context: context({ roleId: "developer" }), intent }),
    (error) =>
      error instanceof WorkIntentPolicyError &&
      error.code === "WORK_INTENT_POLICY_DENIED",
  );
});

test("orchestration and delivery intents create zero generic policy bindings", () => {
  const bindings = [];
  for (const intent of [orchestrateIntent(), submitDeliveryIntent()]) {
    assert.throws(
      () => bindings.push(policy().bind({ context: context(), intent })),
      (error) =>
        error instanceof WorkIntentPolicyError &&
        error.code === "WORK_INTENT_POLICY_DENIED",
    );
  }
  assert.deepEqual(bindings, []);
});

test("denies role escalation, stale PR contexts, and absent trusted mappings", () => {
  const githubIntent = {
    ...common("propose_github_review"),
    verdict: "approve",
    body: "可以合入。",
    evidence: [],
  };
  const codeIntent = {
    ...common("propose_code_action"),
    operation: "inspect",
    objective: "检查代码",
    acceptanceCriteria: ["定位问题"],
    evidence: [],
  };
  const cases = [
    () => policy().bind({ context: context({ roleId: "developer" }), intent: githubIntent }),
    () => policy().bind({
      context: context({ event: event({ eventType: "issue.updated" }) }),
      intent: githubIntent,
    }),
    () => policy().bind({
      context: context({ event: event({ eventType: "pull_request.completed" }) }),
      intent: githubIntent,
    }),
    () => policy().bind({
      context: context({ event: event({ payload: { title: "Missing head", state: "open" } }) }),
      intent: githubIntent,
    }),
    () => policy({ workspaceByRepository: {} }).bind({
      context: gitContext(),
      intent: codeIntent,
    }),
    () => policy({ capabilityRoles: {} }).bind({
      context: context(),
      intent: { ...common("handoff"), capability: "testing", brief: "test", evidence: [] },
    }),
  ];

  for (const operation of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof WorkIntentPolicyError &&
        ["WORK_INTENT_POLICY_DENIED", "WORK_INTENT_CONTEXT_INVALID"].includes(error.code),
    );
  }
});

test("rejects untrusted context fields, inherited data, and post-bind mutation", () => {
  const intent = {
    ...common("complete"),
    outcome: "done",
    evidence: [],
  };
  assert.throws(
    () => policy().bind({ context: { ...context(), accountId: "attacker" }, intent }),
    (error) => error instanceof WorkIntentPolicyError,
  );
  assert.throws(
    () => policy().bind({ context: Object.assign(Object.create({ roleId: "root" }), context()), intent }),
    (error) => error instanceof WorkIntentPolicyError,
  );

  const bound = policy().bind({ context: context(), intent });
  assert.throws(() => {
    bound.binding.subject.repository = "attacker/repo";
  }, TypeError);
  assert.equal(bound.binding.subject.repository, "acme/repo");
});


test("seals explicit Review publication reuse into the new proposal without changing its trusted target", () => {
  const publicationReuse = { candidateId: "review-publication-candidate-" + "a".repeat(64), materialDigest: "b".repeat(64), coverageDigest: "d".repeat(64) };
  const bound = policy().bind({ context: context(), intent: { ...common("propose_github_review"),
    verdict: "approve", body: "Current coverage note, not a newly published body", evidence: ["head:abc123"], publicationReuse } });
  assert.deepEqual(bound.payload.publicationReuse, publicationReuse);
  assert.equal(bound.requestedBy.workItemId, context().workItemId);
  assert.deepEqual(bound.binding.inputBinding, context().inputBinding);
  assert.equal(bound.binding.repository, "acme/repo");
  const changed = policy().bind({ context: context(), intent: { ...common("propose_github_review"),
    verdict: "approve", body: bound.payload.body, evidence: ["head:abc123"],
    publicationReuse: { ...publicationReuse, materialDigest: "c".repeat(64) } } });
  assert.notEqual(changed.intentId, bound.intentId, "coverage changes must invalidate the sealed proposal identity");
});
