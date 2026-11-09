import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkIntentError,
  normalizeWorkDecision,
  normalizeWorkIntent,
  workIntentDigest,
} from "../src/domain/work-intent.js";
import {
  WORK_DECISION_JSON_SCHEMA,
  parseStructuredWorkDecision,
} from "../src/domain/structured-brain-contract.js";

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成事实核对",
    reason: "需要选择下一步",
  };
}

function assertInvalid(value) {
  assert.throws(
    () => normalizeWorkIntent(value),
    (error) =>
      error instanceof WorkIntentError && error.code === "WORK_INTENT_INVALID",
  );
}

function orchestrationAction(type = "pause") {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: "work-item-root",
    sourceTaskRevision: 4,
    expectedGraphRevision: 8,
    reason: "等待当前依赖恢复",
  };
}

function orchestrateIntent(type = "pause") {
  const action = orchestrationAction(type);
  return {
    ...common("orchestrate"),
    reason: action.reason,
    action,
  };
}

function submitDeliveryIntent() {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: "work-item-development",
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

test("normalizes every bounded employee intent without trusted targets", () => {
  const cases = [
    {
      ...common("ask_user"),
      question: "需求冲突时，以哪个验收口径为准？",
      choices: [
        { id: "current-spec", label: "当前 SDS", description: "按当前文档继续" },
        { id: "issue-text", label: "Issue 原文", description: "退回原始描述" },
      ],
    },
    {
      ...common("wait_condition"),
      condition: {
        kind: "workflow_fact",
        fact: "ci-status",
        oneOf: ["success"],
      },
      checkAfterSeconds: 300,
    },
    {
      ...common("wait_condition"),
      condition: {
        kind: "time",
        notBefore: "2026-08-03T01:02:03.000Z",
      },
      checkAfterSeconds: 3600,
    },
    {
      ...common("query_memory"),
      question: "上次同类回归是如何修复的？",
      searchQuery: "同类 回归 修复",
      mode: "local",
    },
    {
      ...common("propose_github_review"),
      deliverableId: "review.primary",
      verdict: "request_changes",
      body: "空值分支会错误地发布旧状态，请先修复。",
      evidence: ["src/service.js:42"],
    },
    {
      ...common("propose_github_pull_request_action"),
      action: { type: "comment", body: "我会继续跟进这个问题。" },
      evidence: ["thread:unanswered"],
    },
    {
      ...common("propose_code_action"),
      deliverableId: "implementation_main",
      operation: "modify",
      objective: "修复空值分支并保持接口兼容",
      acceptanceCriteria: ["现有测试通过", "新增回归测试"],
      evidence: ["失败发生在状态转换之后"],
    },
    {
      ...common("propose_configuration_change"),
      changes: [
        { path: ["employees", "roles", "developer", "scheduleMinutes"], value: 15 },
        { path: ["employees", "roles", "developer", "brain", "model"], value: "qwen3.5:9b" },
      ],
      evidence: ["岗位巡检频率与当前负载不匹配"],
    },
    {
      ...common("handoff"),
      capability: "testing",
      brief: "验证修复在 Windows 和 Docker 中一致",
      evidence: ["单元测试已通过"],
    },
    {
      ...common("complete"),
      outcome: "done",
      evidence: ["验收条件全部满足"],
    },
  ];

  for (const candidate of cases) {
    const normalized = normalizeWorkIntent(candidate);
    assert.deepEqual(normalized, candidate);
    const serialized = JSON.stringify(normalized);
    for (const forbidden of [
      "accountId",
      "repository",
      "pullRequestNumber",
      "headRefOid",
      "workspaceId",
      "command",
      "env",
      "token",
    ]) {
      assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    }
  }
});

test("normalizes five separately confirmed pull request action decisions", () => {
  const evidenceId = `controlled-git-commit-${"a".repeat(64)}`;
  const actions = [
    { type: "comment", body: "请补充失败日志。" },
    { type: "review", verdict: "request_changes", body: "空值分支需要修复。" },
    { type: "update_branch" },
    { type: "push", controlledCommitEvidenceId: evidenceId },
    { type: "merge", method: "squash" },
  ];
  for (const action of actions) {
    const intent = {
      ...common("propose_github_pull_request_action"),
      action,
      evidence: ["trusted-task-context"],
    };
    assert.deepEqual(normalizeWorkIntent(intent), intent);
  }

  for (const action of [
    { type: "comment", body: "" },
    { type: "review", verdict: "merge", body: "错误 verdict" },
    { type: "update_branch", body: "unexpected" },
    { type: "push", controlledCommitEvidenceId: "model-invented" },
    { type: "merge", method: "force" },
  ]) {
    assertInvalid({
      ...common("propose_github_pull_request_action"),
      action,
      evidence: [],
    });
  }
});

test("proposal intents preserve one optional delivery selector and durable dispatch identity", () => {
  const dispatchIntentId = `work-dispatch-intent-${"d".repeat(64)}`;
  for (const intent of [
    {
      ...common("propose_github_review"),
      deliverableId: "review.secondary",
      dispatchIntentId,
      verdict: "comment",
      body: "建议补充边界测试。",
      evidence: [],
    },
    {
      ...common("propose_code_action"),
      deliverableId: "implementation_secondary",
      dispatchIntentId,
      operation: "verify",
      objective: "验证第二个交付物",
      acceptanceCriteria: ["聚焦测试通过"],
      evidence: [],
    },
  ]) {
    const normalized = normalizeWorkIntent(intent);
    assert.equal(normalized.deliverableId, intent.deliverableId);
    assert.equal(normalized.dispatchIntentId, dispatchIntentId);
  }
});

test("a brain decision binds confidence and one exact structured intent", () => {
  const decision = normalizeWorkDecision({
    schemaVersion: 1,
    confidence: 82,
    summary: "CI 尚未成功，应继续观察",
    intent: {
      ...common("wait_condition"),
      condition: {
        kind: "workflow_fact",
        fact: "ci-status",
        oneOf: ["success", "failure"],
      },
      checkAfterSeconds: 180,
    },
  });

  assert.equal(decision.confidence, 82);
  assert.equal(decision.intent.type, "wait_condition");
  assert.match(workIntentDigest(decision.intent), /^[a-f0-9]{64}$/);
  assert.equal(
    workIntentDigest(decision.intent),
    workIntentDigest({
      reason: decision.intent.reason,
      type: decision.intent.type,
      schemaVersion: 1,
      condition: { oneOf: ["success", "failure"], fact: "ci-status", kind: "workflow_fact" },
      checkAfterSeconds: 180,
      summary: decision.intent.summary,
    }),
  );
});

test("normalizes orchestration wrappers and direct specialist deliveries", () => {
  const orchestrate = normalizeWorkIntent(orchestrateIntent());
  const delivery = normalizeWorkIntent(submitDeliveryIntent());

  assert.equal(orchestrate.type, "orchestrate");
  assert.equal(orchestrate.reason, orchestrate.action.reason);
  assert.equal(orchestrate.action.type, "pause");
  assert.equal(delivery.type, "submit_delivery");
  assert.equal(delivery.deliverableId, "implementation");
  assert.match(workIntentDigest(orchestrate), /^[a-f0-9]{64}$/);
  assert.match(workIntentDigest(delivery), /^[a-f0-9]{64}$/);
});

test("rejects orchestration reason mismatch and authority fields at either boundary", () => {
  const actionAuthority = orchestrateIntent();
  actionAuthority.action = { ...actionAuthority.action, actorId: "owner" };
  const deliveryAuthority = { ...submitDeliveryIntent(), leaseId: "lease-1" };

  for (const candidate of [
    { ...orchestrateIntent(), reason: "与 action 不一致" },
    { ...orchestrateIntent(), scopeRootTaskId: "work-item-root" },
    actionAuthority,
    deliveryAuthority,
  ]) {
    assertInvalid(candidate);
  }
});

test("structured brain parser accepts orchestration and delivery decisions", () => {
  for (const intent of [orchestrateIntent(), submitDeliveryIntent()]) {
    const decision = {
      schemaVersion: 1,
      confidence: 90,
      summary: "已形成受约束的下一步",
      intent,
    };
    assert.deepEqual(
      parseStructuredWorkDecision(JSON.stringify(decision)),
      normalizeWorkDecision(decision),
    );
  }

  const variants = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf;
  assert.equal(
    variants.some(({ properties }) =>
      properties?.type?.const === "orchestrate" &&
      properties.action?.oneOf?.length === 9),
    true,
  );
  assert.equal(
    variants.some(({ properties }) =>
      properties?.type?.const === "submit_delivery"),
    true,
  );
});

test("rejects targets, capabilities, and executable details outside the contract", () => {
  const github = {
    ...common("propose_github_review"),
    verdict: "comment",
    body: "建议补充测试。",
    evidence: [],
  };
  const code = {
    ...common("propose_code_action"),
    operation: "inspect",
    objective: "定位失败原因",
    acceptanceCriteria: ["找到可复现原因"],
    evidence: [],
  };

  for (const candidate of [
    { ...github, accountId: "someone" },
    { ...github, repository: "owner/repo" },
    { ...github, pullRequestNumber: 42 },
    { ...github, headRefOid: "a".repeat(40) },
    { ...code, workspaceId: "repo" },
    { ...code, command: "npm test" },
    { ...code, args: ["test"] },
    { ...code, env: { TOKEN: "secret" } },
    { ...code, shell: true },
    { ...common("handoff"), capability: "root", brief: "升级权限", evidence: [] },
  ]) {
    assertInvalid(candidate);
  }
});

test("configuration proposals reject objects, duplicate paths, credentials, and identity authority", () => {
  const proposal = {
    ...common("propose_configuration_change"),
    changes: [{ path: ["refreshMinutes"], value: 15 }],
    evidence: [],
  };
  assert.deepEqual(normalizeWorkIntent(proposal), proposal);

  for (const changes of [
    [],
    [{ path: ["refreshMinutes"], value: { raw: 15 } }],
    [{ path: ["refreshMinutes"], value: [15] }],
    [{ path: ["refreshMinutes"], value: null }],
    [
      { path: ["refreshMinutes"], value: 15 },
      { path: ["refreshMinutes"], value: 20 },
    ],
    [{ path: ["brainProviders", "remote", "apiKeyEnv"], value: "KEY" }],
    [{ path: ["githubActions", "tokenEnv"], value: "TOKEN" }],
    [{ path: ["githubActions", "networkEnv", "HTTP_PROXY"], value: "PROXY" }],
    [{ path: ["githubActions", "actorAccountId"], value: "someone" }],
    [{ path: ["githubLogin"], value: "someone" }],
    [{ path: ["workCoordination", "enabled"], value: false }],
    [{ path: ["__proto__", "enabled"], value: true }],
    [{ path: ["employees", "roles", "developer", "mission"], value: "ghp_1234567890secret" }],
  ]) {
    assertInvalid({ ...proposal, changes });
  }

  for (const change of [
    { path: ["brainProviders", "ollama", "contextTokens"], value: 8192 },
    { path: ["employees", "roles", "developer", "brain", "model"], value: "qwen3.5:9b" },
    { path: ["employees", "roles", "developer", "scheduleMinutes"], value: 15 },
  ]) {
    assert.deepEqual(
      normalizeWorkIntent({ ...proposal, changes: [change] }).changes,
      [change],
    );
  }
});

test("rejects unknown schemas, malformed variants, and oversized text", () => {
  const ask = {
    ...common("ask_user"),
    question: "是否继续？",
    choices: [],
  };
  for (const candidate of [
    { ...ask, schemaVersion: 2 },
    { ...ask, type: "execute_shell" },
    { ...ask, question: "bad\u0000question" },
    { ...ask, choices: Array.from({ length: 9 }, (_, index) => ({ id: `c-${index}`, label: "选项", description: "说明" })) },
    { ...ask, summary: "x".repeat(2_049) },
    { ...common("wait_condition"), condition: { kind: "workflow_fact", fact: "ci-status", oneOf: [] }, checkAfterSeconds: 300 },
    { ...common("wait_condition"), condition: { kind: "time", notBefore: "tomorrow" }, checkAfterSeconds: 300 },
    { ...common("wait_condition"), condition: { kind: "time", notBefore: "2026-08-03T01:02:03.000Z" }, checkAfterSeconds: 1 },
    { ...common("query_memory"), question: "查询", searchQuery: "查询", mode: "remote" },
    { ...common("query_memory"), question: "查询", searchQuery: "x".repeat(1_025), mode: "local" },
    { ...common("query_memory"), question: "查询", searchQuery: "查询", mode: "local", url: "https://example.com" },
    { ...common("propose_github_review"), verdict: "merge", body: "merge", evidence: [] },
    { ...common("propose_github_review"), verdict: "comment", body: "x".repeat(16 * 1024 + 1), evidence: [] },
    { ...common("propose_github_review"), deliverableId: "Review", verdict: "comment", body: "review", evidence: [] },
    { ...common("propose_code_action"), operation: "shell", objective: "run", acceptanceCriteria: [], evidence: [] },
    { ...common("propose_code_action"), deliverableId: "x".repeat(129), operation: "inspect", objective: "run", acceptanceCriteria: ["done"], evidence: [] },
    { ...common("propose_code_action"), dispatchIntentId: `work-dispatch-intent-${"g".repeat(64)}`, operation: "inspect", objective: "run", acceptanceCriteria: ["done"], evidence: [] },
    { ...common("complete"), outcome: "blocked", evidence: [] },
  ]) {
    assertInvalid(candidate);
  }
});

test("rejects inherited, accessor, symbol, sparse, cyclic, and mutable decision envelopes", () => {
  const ask = {
    ...common("ask_user"),
    question: "是否继续？",
    choices: [],
  };
  assertInvalid(Object.assign(Object.create({ command: "whoami" }), ask));

  const accessor = { ...ask };
  Object.defineProperty(accessor, "question", {
    enumerable: true,
    get: () => "不要调用 getter",
  });
  assertInvalid(accessor);

  const symbol = { ...ask, [Symbol("secret")]: true };
  assertInvalid(symbol);

  const sparseChoices = new Array(1);
  assertInvalid({ ...ask, choices: sparseChoices });

  const cyclicEvidence = [];
  cyclicEvidence.push(cyclicEvidence);
  assertInvalid({
    ...common("complete"),
    outcome: "done",
    evidence: cyclicEvidence,
  });

  assert.throws(
    () => normalizeWorkDecision({
      schemaVersion: 1,
      confidence: 101,
      summary: "invalid",
      intent: ask,
    }),
    (error) => error instanceof WorkIntentError,
  );
  assert.throws(
    () => normalizeWorkDecision({
      schemaVersion: 1,
      confidence: 50,
      summary: "invalid",
      intent: ask,
      prompt: "hidden",
    }),
    (error) => error instanceof WorkIntentError,
  );
});


test("review adoption remains an explicit proposal with a complete material binding", () => {
  const intent = { ...common("propose_github_review"), deliverableId: "review-result", verdict: "approve",
    body: "Current coverage assessment; this text has not been published", evidence: ["head:" + "a".repeat(40)],
    publicationReuse: { candidateId: "review-publication-candidate-" + "b".repeat(64), materialDigest: "c".repeat(64), coverageDigest: "d".repeat(64) } };
  const parsed = parseStructuredWorkDecision(JSON.stringify({ schemaVersion: 1, confidence: 95,
    summary: "Adopt the verified existing publication after current review", intent }));
  assert.deepEqual(parsed.intent.publicationReuse, intent.publicationReuse);
  assert.equal(parsed.intent.type, "propose_github_review");
  assert.equal(parsed.intent.body, intent.body);
  for (const publicationReuse of [null, {}, { candidateId: "review-publication-candidate-" + "b".repeat(64) },
    { ...intent.publicationReuse, candidateId: "arbitrary-review" },
    { ...intent.publicationReuse, materialDigest: "c".repeat(63) },
    { candidateId: intent.publicationReuse.candidateId, materialDigest: intent.publicationReuse.materialDigest },
    { ...intent.publicationReuse, coverageDigest: "d".repeat(63) },
    { ...intent.publicationReuse, forcePublish: true }]) assertInvalid({ ...intent, publicationReuse });
  const { publicationReuse: _reuse, ...ordinary } = intent;
  assert.equal(Object.hasOwn(normalizeWorkIntent(ordinary), "publicationReuse"), false);
});
