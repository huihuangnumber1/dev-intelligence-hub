import assert from "node:assert/strict";
import test from "node:test";
import {
  StructuredBrainContractError,
  WORK_DECISION_JSON_SCHEMA,
  MODEL_WORK_DECISION_JSON_SCHEMA,
  modelWorkDecisionSchema,
  assertModelWorkDecisionControls,
  parseStructuredWorkDecision,
  parseModelWorkDecision,
} from "../src/domain/structured-brain-contract.js";

test("owner goal model controls specialize only this request's cancel scope", () => {
  const original = JSON.stringify(MODEL_WORK_DECISION_JSON_SCHEMA);
  const context = ids => ({ requirements: { coordination: { goalControl: {
    owner: "local-owner", rootTaskId: "owner-root", cancellableTaskIds: ids,
  } } } });
  const cancelVariant = schema => schema.properties.intent.oneOf.find(v => v.properties.type.const === "orchestrate")
    .properties.action.oneOf.find(v => v.properties.type.const === "cancel");
  const a = modelWorkDecisionSchema(context(["child-a"]));
  const b = modelWorkDecisionSchema(context(["child-b"]));
  assert.deepEqual(cancelVariant(a).properties.sourceTaskId.enum, ["child-a"]);
  assert.deepEqual(cancelVariant(b).properties.sourceTaskId.enum, ["child-b"]);
  assert.equal(cancelVariant(modelWorkDecisionSchema(context([]))), undefined);
  assert.equal(modelWorkDecisionSchema({ requirements: {} }), MODEL_WORK_DECISION_JSON_SCHEMA);
  assert.equal(JSON.stringify(MODEL_WORK_DECISION_JSON_SCHEMA), original);
  const cancel = id => ({ intent: { type: "orchestrate", action: { type: "cancel", sourceTaskId: id } } });
  assert.throws(() => assertModelWorkDecisionControls(cancel("owner-root"), context(["child-a"])),
    error => error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID");
  assert.doesNotThrow(() => assertModelWorkDecisionControls(cancel("child-a"), context(["child-a"])));
  assert.doesNotThrow(() => assertModelWorkDecisionControls(cancel("ordinary-root"), { requirements: {} }));
});

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "当前工作已经完成。",
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary: "无需继续处理。",
      reason: "验收条件已经满足。",
      outcome: "done",
      evidence: ["本地验证通过"],
    },
    ...overrides,
  };
}

test("the structured brain schema is finite and parses one exact WorkDecision", () => {
  const parsed = parseStructuredWorkDecision(JSON.stringify(decision()));

  assert.deepEqual(parsed, decision());
  assert.equal(WORK_DECISION_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(WORK_DECISION_JSON_SCHEMA.required, [
    "schemaVersion",
    "confidence",
    "summary",
    "intent",
  ]);
  const intentVariants = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf;
  assert.equal(intentVariants.length, 11);
  assert.equal(
    intentVariants.find(
      ({ properties }) => properties?.type?.const === "orchestrate",
    ).properties.action.oneOf.length,
    9,
  );
  assert.equal(
    intentVariants.find(
      ({ properties }) => properties?.type?.const === "submit_delivery",
    ).oneOf.length,
    2,
  );
  assert.equal(Object.isFrozen(WORK_DECISION_JSON_SCHEMA), true);
  assert.equal(
    WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.every(
      (variant) => variant.additionalProperties === false,
    ),
    true,
  );

  const askUser = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(
    ({ properties }) => properties.type.const === "ask_user",
  );
  const waitCondition = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(
    ({ properties }) => properties.type.const === "wait_condition",
  );
  const memoryQuery = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(
    ({ properties }) => properties.type.const === "query_memory",
  );
  const choiceId = askUser.properties.choices.items.properties.id;
  const workflowFact = waitCondition.properties.condition.oneOf.find(
    ({ properties }) => properties.kind.const === "workflow_fact",
  );
  const time = waitCondition.properties.condition.oneOf.find(
    ({ properties }) => properties.kind.const === "time",
  );
  const proposalVariants = intentVariants.filter(({ properties }) =>
    ["propose_github_review", "propose_code_action"].includes(
      properties.type.const,
    ),
  );
  const externalAction = intentVariants.find(
    ({ properties }) =>
      properties?.type?.const === "propose_github_pull_request_action",
  );
  assert.equal(new RegExp(choiceId.pattern).test("more_details"), false);
  assert.equal(new RegExp(choiceId.pattern).test("more-details"), true);
  assert.equal(workflowFact.properties.oneOf.uniqueItems, true);
  assert.equal(time.properties.notBefore.format, "date-time");
  assert.deepEqual(memoryQuery.properties.mode.enum, ["local", "configured"]);
  assert.equal(Object.hasOwn(memoryQuery.properties, "url"), false);
  assert.equal(Object.hasOwn(memoryQuery.properties, "path"), false);
  for (const proposal of proposalVariants) {
    assert.equal(proposal.required.includes("deliverableId"), false);
    assert.equal(
      new RegExp(proposal.properties.deliverableId.pattern).test(
        "implementation.secondary",
      ),
      true,
    );
    assert.match(
      proposal.properties.deliverableId.description,
      /multiple compatible expected deliverables/i,
    );
    assert.equal(Object.hasOwn(proposal.properties, "dispatchIntentId"), false);
  }
  assert.equal(externalAction.properties.action.oneOf.length, 5);
  assert.deepEqual(
    externalAction.properties.action.oneOf.map(
      ({ properties }) => properties.type.const,
    ),
    ["comment", "review", "update_branch", "push", "merge"],
  );
  assert.equal(Object.hasOwn(externalAction.properties, "deliverableId"), false);
  assert.equal(
    WORK_DECISION_JSON_SCHEMA.properties.summary.maxLength,
    1_024,
  );
});

test("model orchestration has one reason while the internal decision remains exact", () => {
  const value = decision({ intent: { schemaVersion: 1, type: "orchestrate", summary: "Pause dependent work",
    action: { schemaVersion: 1, type: "pause", sourceTaskId: "work-root", sourceTaskRevision: 2,
      expectedGraphRevision: 4, reason: "Wait for the current dependency" } } });
  const parsed = parseModelWorkDecision(JSON.stringify(value));
  assert.equal(parsed.intent.reason, value.intent.action.reason);
  assert.deepEqual(parsed.intent.action, value.intent.action);
  assert.throws(() => parseStructuredWorkDecision(JSON.stringify(value)), StructuredBrainContractError);
  assert.deepEqual(parseStructuredWorkDecision(JSON.stringify(parsed)), parsed);
  assert.deepEqual(parseModelWorkDecision(JSON.stringify(parsed)), parsed, "valid legacy decisions remain accepted");
  const model = MODEL_WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(v => v.properties?.type?.const === "orchestrate");
  const internal = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(v => v.properties?.type?.const === "orchestrate");
  assert.equal(Object.hasOwn(model.properties, "reason"), false);
  assert.ok(internal.required.includes("reason"));
  assert.equal(Object.isFrozen(MODEL_WORK_DECISION_JSON_SCHEMA), true);
});

test("model reason expansion cannot hide conflicting reasons or invalid command fields", () => {
  const value = decision({ intent: { schemaVersion: 1, type: "orchestrate", summary: "Pause dependent work",
    action: { schemaVersion: 1, type: "pause", sourceTaskId: "work-root", sourceTaskRevision: 2,
      expectedGraphRevision: 4, reason: "Wait for the current dependency" } } });
  const conflicting = structuredClone(value); conflicting.intent.reason = "A different reason";
  const nullWrapper = structuredClone(value); nullWrapper.intent.reason = null;
  const missingCommandReason = structuredClone(value); delete missingCommandReason.intent.action.reason;
  const extraCommandField = structuredClone(value); extraCommandField.intent.action.permission = "owner";
  const invalidRevision = structuredClone(value); invalidRevision.intent.action.sourceTaskRevision = 0;
  const invalidAction = structuredClone(value); invalidAction.intent.action.type = "push";
  const missingOtherReason = decision(); delete missingOtherReason.intent.reason;
  for (const invalid of [conflicting, nullWrapper, missingCommandReason, extraCommandField,
    invalidRevision, invalidAction, missingOtherReason]) {
    assert.throws(() => parseModelWorkDecision(JSON.stringify(invalid)),
      error => error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID");
  }
  assert.throws(() => parseModelWorkDecision(JSON.stringify(value), { maximumBytes: 1 }),
    error => error.code === "STRUCTURED_BRAIN_RESPONSE_TOO_LARGE");
});

function modelDecomposition() {
  return decision({ intent: { schemaVersion: 1, type: "orchestrate", summary: "Create a CI repair task",
    action: { schemaVersion: 1, type: "decompose", sourceTaskId: "work-root", sourceTaskRevision: 15,
      expectedGraphRevision: 18403, reason: "The bound CI check still fails", childKey: "ci-repair",
      work: { title: "Repair the failing check", description: "Verify the bound diagnostic and repair the confirmed defect",
        capability: "development", dependsOn: [{ taskId: "prior-work", revision: 2 }],
        acceptanceContract: { revision: 1,
          acceptanceCriteria: [{ criterionId: "verified-fix", description: "Verify the repair" }],
          expectedDeliverables: [{ deliverableId: "repair", kind: "change-package", description: "Controlled repair", required: true }] } } } } });
}

test("model decomposition maps the complete child work to the exact internal command", () => {
  const value = modelDecomposition();
  const before = structuredClone(value);
  const parsed = parseModelWorkDecision(JSON.stringify(value));
  const { capability, dependsOn, acceptanceContract, ...work } = value.intent.action.work;
  assert.deepEqual(parsed.intent.action, { ...value.intent.action, work, capability, dependsOn, acceptanceContract });
  assert.deepEqual(value, before);
  assert.throws(() => parseStructuredWorkDecision(JSON.stringify(value)), StructuredBrainContractError);
  assert.deepEqual(parseStructuredWorkDecision(JSON.stringify(parsed)), parsed);
  assert.deepEqual(parseModelWorkDecision(JSON.stringify(parsed)), parsed, "previous flattened model responses remain exact");
  const model = MODEL_WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(v => v.properties?.type?.const === "orchestrate")
    .properties.action.oneOf.find(v => v.properties.type.const === "decompose");
  const internal = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(v => v.properties?.type?.const === "orchestrate")
    .properties.action.oneOf.find(v => v.properties.type.const === "decompose");
  for (const key of ["capability", "dependsOn", "acceptanceContract"]) {
    assert.equal(Object.hasOwn(model.properties, key), false);
    assert.ok(model.properties.work.required.includes(key));
    assert.deepEqual(model.properties.work.properties[key], internal.properties[key]);
    assert.ok(internal.required.includes(key));
    assert.equal(Object.hasOwn(internal.properties.work.properties, key), false);
  }
  assert.equal(model.properties.work.additionalProperties, false);
});

test("child work expansion rejects ambiguous, incomplete and invalid model decompositions", () => {
  const variants = [];
  for (const key of ["capability", "dependsOn", "acceptanceContract"]) {
    const duplicate = modelDecomposition();
    duplicate.intent.action[key] = structuredClone(duplicate.intent.action.work[key]);
    variants.push(duplicate);
    const missing = modelDecomposition(); delete missing.intent.action.work[key]; variants.push(missing);
  }
  const extraWork = modelDecomposition(); extraWork.intent.action.work.permission = "owner";
  const extraAction = modelDecomposition(); extraAction.intent.action.permission = "owner";
  const invalidRevision = modelDecomposition(); invalidRevision.intent.action.work.dependsOn[0].revision = 0;
  const duplicateDependency = modelDecomposition(); duplicateDependency.intent.action.work.dependsOn.push({ taskId: "prior-work", revision: 3 });
  const invalidContract = modelDecomposition(); invalidContract.intent.action.work.acceptanceContract.revision = 2;
  const invalidCapability = modelDecomposition(); invalidCapability.intent.action.work.capability = "run shell";
  const otherAction = modelDecomposition(); otherAction.intent.action.type = "assign";
  const conflictingReason = modelDecomposition(); conflictingReason.intent.reason = "Different authorization";
  for (const value of [...variants, extraWork, extraAction, invalidRevision, duplicateDependency, invalidContract,
    invalidCapability, otherAction, conflictingReason]) {
    assert.throws(() => parseModelWorkDecision(JSON.stringify(value)),
      error => error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID");
  }
});

test("parsing rejects wrappers, extra fields, invalid variants, and oversized text", () => {
  assert.throws(
    () => parseStructuredWorkDecision(`\`\`\`json\n${JSON.stringify(decision())}\n\`\`\``),
    (error) =>
      error instanceof StructuredBrainContractError &&
      error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID",
  );
  assert.throws(
    () =>
      parseStructuredWorkDecision(
        JSON.stringify({ ...decision(), unexpected: "model-controlled" }),
      ),
    /structured brain response is invalid/i,
  );
  assert.throws(
    () =>
      parseStructuredWorkDecision(
        JSON.stringify(
          decision({ intent: { ...decision().intent, type: "run_shell" } }),
        ),
      ),
    /structured brain response is invalid/i,
  );
  assert.throws(
    () => parseStructuredWorkDecision("x".repeat(1_025), { maximumBytes: 1_024 }),
    (error) => error.code === "STRUCTURED_BRAIN_RESPONSE_TOO_LARGE",
  );
});

test("contract errors never echo model output", () => {
  const sensitiveOutput = "secret-response-material";
  assert.throws(
    () => parseStructuredWorkDecision(sensitiveOutput),
    (error) =>
      error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID" &&
      !error.message.includes(sensitiveOutput),
  );
});
