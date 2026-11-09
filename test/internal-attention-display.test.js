import assert from "node:assert/strict";
import test from "node:test";
import { internalAttentionDisplay } from "../public/internal-attention-display.js";

test("legacy session recovery questions show maintenance instructions without changing response bindings", () => {
  const original = {
    question: "保留隔离目录中的会话历史；完成后请选择“已配置，重试”",
    maintenanceCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    context: [{ label: "判断依据", value: "系统已安全停止（STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED）" }],
    choices: [{ id: "configured-retry", label: "已配置，重试", description: "再次核验" }],
    revision: 17, contentDigest: "a".repeat(64),
  };
  const before = structuredClone(original);
  const display = internalAttentionDisplay(original);
  assert.match(display.question, /维护人员修复/);
  assert.equal(display.choices[0].id, "configured-retry");
  assert.equal(display.choices[0].label, "修复后重试");
  assert.match(display.choices[0].description, /不会自动修复会话/);
  assert.deepEqual(original, before);
});

test("new recovery display uses projected identity independently of context labels and wording", () => {
  const question = { maintenanceCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", question: "New question",
    choices: [{ id: "configured-retry", label: "New label" }], context: [{ label: "Other", value: "New reason" }] };
  assert.match(internalAttentionDisplay(question).question, /维护人员修复/);
  const copy = { ...question, maintenanceCode: null,
    context: [{ label: "判断依据", value: "系统已安全停止（STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED）" }] };
  assert.equal(internalAttentionDisplay(copy).question, copy.question);
});

test("ordinary business questions and configuration failures keep their original choices", () => {
  const original = {
    question: "选择需要的交付物",
    context: [{ label: "判断依据", value: "ROLE_TASK_BRAIN_NOT_CONFIGURED" }],
    choices: [{ id: "configured-retry", label: "已配置，重试" }],
  };
  assert.deepEqual(internalAttentionDisplay(original), {
    question: original.question, choices: original.choices,
  });
});
