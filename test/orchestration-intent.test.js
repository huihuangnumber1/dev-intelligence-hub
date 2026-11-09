import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATION_INTENT_JSON_SCHEMA,
  SUBMIT_DELIVERY_INTENT_JSON_SCHEMA,
  OrchestrationIntentError,
  normalizeOrchestrationIntent,
  normalizeSubmitDeliveryIntent,
  orchestrationIntentDigest,
  submitDeliveryIntentDigest,
} from "../src/domain/orchestration-intent.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function acceptanceContract(revision = 1) {
  return {
    revision,
    acceptanceCriteria: [
      { criterionId: "tests-pass", description: "聚焦测试通过" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "可验证的实现结果",
        required: true,
      },
    ],
  };
}

function common(type) {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: "work-item-root",
    sourceTaskRevision: 7,
    expectedGraphRevision: 12,
    reason: "基于当前共享任务图推进",
  };
}

function decomposeIntent() {
  return {
    ...common("decompose"),
    childKey: "development",
    work: {
      title: "实现已澄清需求",
      description: "按已接受的需求规格完成受控实现。",
    },
    capability: "development",
    dependsOn: [
      { taskId: "work-item-requirements", revision: 5 },
      { taskId: "work-item-design", revision: 3 },
    ],
    acceptanceContract: acceptanceContract(),
  };
}

function requirementDraft() {
  return {
    title: "共享任务图需求",
    problem: "岗位之间必须围绕同一任务和已接受输入协作。",
    requirements: ["开发读取已接受规格", "测试读取已接受实现"],
    acceptanceCriteria: ["失败交付可以退回", "旧 revision 不得覆盖新结果"],
    openQuestions: ["是否需要额外的性能门槛？"],
  };
}

function submitDeliveryIntent() {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: "work-item-requirements",
    expectedTaskRevision: 8,
    expectedGraphRevision: 14,
    contractRevision: 1,
    deliverableId: "requirement-spec",
    summary: "需求规格已经形成并覆盖验收边界。",
    reason: "已消除当前可判定的歧义",
    evidence: [
      {
        kind: "analysis-note",
        referenceId: "analysis-note:work-item-requirements:1",
        contentDigest: SHA_B,
      },
      {
        kind: "decision-record",
        referenceId: "decision:requirements:1",
        contentDigest: SHA_A,
      },
    ],
    artifact: requirementDraft(),
  };
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof OrchestrationIntentError &&
      error.code === "ORCHESTRATION_INTENT_INVALID",
  );
}

test("normalizes every bounded orchestration intent without trusted authority", () => {
  const intents = [
    decomposeIntent(),
    { ...common("assign"), capability: "testing" },
    { ...common("accept_delivery"), submittedDeliveryRevision: 3 },
    { ...common("return_delivery"), submittedDeliveryRevision: 3 },
    {
      ...common("escalate"),
      question: "应采用哪个兼容性边界？",
      choices: [
        { id: "keep-current", label: "保持当前", description: "不扩大范围" },
        { id: "revise-scope", label: "修订范围", description: "生成新契约" },
      ],
    },
    common("pause"),
    { ...common("pause"), waitForChildren: true },
    common("resume"),
    common("cancel"),
  ];

  for (const candidate of intents) {
    const normalized = normalizeOrchestrationIntent(candidate);
    assert.equal(normalized.type, candidate.type);
    assert.equal(Object.isFrozen(normalized), true);
    assert.match(orchestrationIntentDigest(normalized), /^[a-f0-9]{64}$/);
    for (const forbidden of [
      "actorId",
      "leaseId",
      "scopeRootTaskId",
      "provider",
      "workspaceId",
      "tool",
      "accountId",
      "github",
    ]) {
      assert.equal(JSON.stringify(normalized).includes(`\"${forbidden}\"`), false);
    }
  }

  assert.deepEqual(
    normalizeOrchestrationIntent(decomposeIntent()).dependsOn.map(({ taskId }) => taskId),
    ["work-item-design", "work-item-requirements"],
  );
  assert.equal(ORCHESTRATION_INTENT_JSON_SCHEMA.oneOf.length, 9);
  assert.equal(
    ORCHESTRATION_INTENT_JSON_SCHEMA.oneOf[0].properties.reason.maxLength,
    1_024,
  );
  assert.equal(Object.isFrozen(ORCHESTRATION_INTENT_JSON_SCHEMA), true);
  assertInvalid(() => normalizeOrchestrationIntent({
    ...common("pause"), waitForChildren: false,
  }));
});

test("orchestration digests are deterministic and detached from caller mutation", () => {
  const input = decomposeIntent();
  const first = normalizeOrchestrationIntent(input);
  const digest = orchestrationIntentDigest(first);
  const reordered = {
    reason: input.reason,
    acceptanceContract: input.acceptanceContract,
    dependsOn: [...input.dependsOn].reverse(),
    capability: input.capability,
    work: input.work,
    childKey: input.childKey,
    expectedGraphRevision: input.expectedGraphRevision,
    sourceTaskRevision: input.sourceTaskRevision,
    sourceTaskId: input.sourceTaskId,
    type: input.type,
    schemaVersion: input.schemaVersion,
  };

  assert.equal(orchestrationIntentDigest(reordered), digest);
  input.work.title = "调用者篡改";
  input.dependsOn[0].revision = 99;
  assert.equal(first.work.title, "实现已澄清需求");
  assert.equal(orchestrationIntentDigest(first), digest);
});

test("rejects authority, execution, provider, account, and github injection", () => {
  for (const injected of [
    { actorId: "owner" },
    { leaseId: "lease-1" },
    { scopeRootTaskId: "work-item-root" },
    { provider: "remote" },
    { remoteData: { code: true } },
    { workspaceId: "source-checkout" },
    { tool: "shell" },
    { accountId: "another-user" },
    { github: { action: "merge" } },
  ]) {
    assertInvalid(() => normalizeOrchestrationIntent({
      ...common("assign"),
      capability: "development",
      ...injected,
    }));
  }
});

test("rejects malformed revisions, duplicate dependencies, and invalid initial contracts", () => {
  const duplicateDependency = decomposeIntent();
  duplicateDependency.dependsOn[1] = {
    ...duplicateDependency.dependsOn[0],
  };
  const cyclic = decomposeIntent();
  cyclic.dependsOn = [];
  cyclic.work.self = cyclic;
  const unknownDeliverableKind = decomposeIntent();
  unknownDeliverableKind.acceptanceContract.expectedDeliverables[0].kind =
    "change_package";
  const mismatchedRequirementSpec = decomposeIntent();
  mismatchedRequirementSpec.acceptanceContract.expectedDeliverables[0] = {
    deliverableId: "specification",
    kind: "requirement-spec",
    description: "需求规格",
    required: true,
  };

  for (const candidate of [
    { ...common("unknown") },
    { ...common("assign"), capability: "Root Access" },
    { ...common("assign"), capability: "development", sourceTaskRevision: 0 },
    { ...common("assign"), capability: "development", expectedGraphRevision: -1 },
    { ...decomposeIntent(), acceptanceContract: acceptanceContract(2) },
    duplicateDependency,
    cyclic,
    unknownDeliverableKind,
    mismatchedRequirementSpec,
  ]) {
    assertInvalid(() => normalizeOrchestrationIntent(candidate));
  }
});

test("accepts text-report contracts for prose-only specialist work", () => {
  const input = decomposeIntent();
  input.acceptanceContract.expectedDeliverables[0] = {
    deliverableId: "analysis-report",
    kind: "text-report",
    description: "只读文字分析报告",
    required: true,
  };

  const normalized = normalizeOrchestrationIntent(input);

  assert.equal(
    normalized.acceptanceContract.expectedDeliverables[0].kind,
    "text-report",
  );
  assert.ok(
    ORCHESTRATION_INTENT_JSON_SCHEMA.oneOf[0]
      .properties.acceptanceContract.properties.expectedDeliverables.items
      .properties.kind.enum.includes("text-report"),
  );
});

test("rejects accessors, sparse arrays, symbols, extra fields, and UTF-8 overflow", () => {
  const accessor = decomposeIntent();
  Object.defineProperty(accessor.work, "title", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  const sparse = decomposeIntent();
  sparse.dependsOn = new Array(1);

  for (const candidate of [
    accessor,
    sparse,
    { ...common("pause"), extra: true },
    { ...common("pause"), [Symbol("hidden")]: true },
    { ...common("pause"), reason: "界".repeat(1_366) },
  ]) {
    assertInvalid(() => normalizeOrchestrationIntent(candidate));
  }
});

test("normalizes a bounded specialist delivery intent and requirement draft", () => {
  const input = submitDeliveryIntent();
  const normalized = normalizeSubmitDeliveryIntent(input);

  assert.equal(normalized.type, "submit_delivery");
  assert.deepEqual(normalized.evidence.map(({ kind }) => kind), [
    "analysis-note",
    "decision-record",
  ]);
  assert.deepEqual(normalized.artifact.requirements, [
    "开发读取已接受规格",
    "测试读取已接受实现",
  ]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.artifact), true);
  assert.match(submitDeliveryIntentDigest(normalized), /^[a-f0-9]{64}$/);
  assert.equal(SUBMIT_DELIVERY_INTENT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(Object.isFrozen(SUBMIT_DELIVERY_INTENT_JSON_SCHEMA), true);

  input.artifact.problem = "调用者篡改";
  input.evidence[0].referenceId = "attacker";
  assert.equal(normalized.artifact.problem, "岗位之间必须围绕同一任务和已接受输入协作。");
  assert.equal(
    normalized.evidence[0].referenceId,
    "analysis-note:work-item-requirements:1",
  );
});

test("specialist delivery reserves trusted evidence and enforces the caller limit", () => {
  const reservedWorkInputs = submitDeliveryIntent();
  reservedWorkInputs.evidence[0] = {
    ...reservedWorkInputs.evidence[0],
    kind: "work-inputs",
  };
  const reservedRequirementSpec = submitDeliveryIntent();
  reservedRequirementSpec.evidence[0] = {
    ...reservedRequirementSpec.evidence[0],
    kind: "requirement-spec",
  };
  const duplicate = submitDeliveryIntent();
  duplicate.evidence[1] = { ...duplicate.evidence[0] };
  const maximumEvidence = Array.from({ length: 30 }, (_, index) => ({
    kind: "test-report",
    referenceId: `test:${index}`,
    contentDigest: index.toString(16).padStart(64, "0"),
  }));
  const tooMany = submitDeliveryIntent();
  tooMany.evidence = Array.from({ length: 31 }, (_, index) => ({
    kind: "test-report",
    referenceId: `test:${index}`,
    contentDigest: index.toString(16).padStart(64, "0"),
  }));
  const finalArtifact = {
    ...requirementDraft(),
    schemaVersion: 1,
    revision: 1,
  };

  assert.equal(normalizeSubmitDeliveryIntent({
    ...submitDeliveryIntent(),
    evidence: maximumEvidence,
  }).evidence.length, 30);
  assert.deepEqual(normalizeSubmitDeliveryIntent({
    ...submitDeliveryIntent(),
    evidence: [],
  }).evidence, []);
  assert.equal(SUBMIT_DELIVERY_INTENT_JSON_SCHEMA.properties.evidence.minItems, 0);
  assert.equal(SUBMIT_DELIVERY_INTENT_JSON_SCHEMA.properties.evidence.maxItems, 30);
  assert.deepEqual(
    SUBMIT_DELIVERY_INTENT_JSON_SCHEMA
      .properties.evidence.items.properties.kind.not.enum,
    ["work-inputs", "requirement-spec"],
  );

  for (const candidate of [
    reservedWorkInputs,
    reservedRequirementSpec,
    duplicate,
    tooMany,
    { ...submitDeliveryIntent(), artifact: finalArtifact },
    { ...submitDeliveryIntent(), expectedTaskRevision: 0 },
    { ...submitDeliveryIntent(), contentDigest: SHA_A },
  ]) {
    assertInvalid(() => normalizeSubmitDeliveryIntent(candidate));
  }
});

test("specialist delivery couples requirement artifacts to their deliverable", () => {
  const implementation = {
    ...submitDeliveryIntent(),
    deliverableId: "implementation",
    artifact: null,
  };

  assert.equal(normalizeSubmitDeliveryIntent(implementation).artifact, null);
  assert.equal(SUBMIT_DELIVERY_INTENT_JSON_SCHEMA.oneOf.length, 2);
  assertInvalid(() => normalizeSubmitDeliveryIntent({
    ...submitDeliveryIntent(),
    artifact: null,
  }));
  assertInvalid(() => normalizeSubmitDeliveryIntent({
    ...implementation,
    artifact: requirementDraft(),
  }));
});
