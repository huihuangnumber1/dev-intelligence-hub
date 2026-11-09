import assert from "node:assert/strict";
import test from "node:test";
import {
  AttentionInboxError,
  normalizeAttentionBrowserResponse,
  normalizeAttentionRequest,
} from "../src/domain/attention-contract.js";
import {
  defaultAttentionState,
  normalizeAttentionState,
} from "../src/services/attention-inbox-state.js";

function request(overrides = {}) {
  return {
    requestKey: "routing-gap-42",
    type: "resolve_routing_gap",
    producer: { roleId: "workflow-router", workItemId: "assignment-42" },
    question: "这个未匹配的工作应该交给谁？",
    context: [
      { label: "来源", value: "command-center#42" },
      { label: "原因", value: "没有匹配的角色" },
    ],
    choices: [
      { id: "requirements", label: "需求分析师", description: "先梳理需求" },
      { id: "pr-reviewer", label: "PR 工程师", description: "直接检查代码" },
    ],
    ...overrides,
  };
}

test("attention requests use a strict, content-addressable display contract", () => {
  const normalized = normalizeAttentionRequest(request());

  assert.deepEqual(normalized, request());
  assert.throws(
    () => normalizeAttentionRequest({ ...request(), command: "git push" }),
    (error) =>
      error instanceof AttentionInboxError &&
      error.code === "INVALID_ATTENTION_REQUEST",
  );
  assert.throws(
    () =>
      normalizeAttentionRequest({
        ...request(),
        producer: {
          ...request().producer,
          githubToken: "must-not-enter-state",
        },
      }),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
  assert.throws(
    () => normalizeAttentionRequest(request({ context: null })),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
  assert.throws(
    () =>
      normalizeAttentionRequest(
        request({ choices: [{ id: "yes", label: "是", description: undefined }] }),
      ),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
});

test("optional recovery projection preserves historical absence and bounds new metadata", () => {
  assert.equal(Object.hasOwn(normalizeAttentionRequest(request()), "recoveryCode"), false);
  assert.equal(normalizeAttentionRequest(request({ recoveryCode: null })).recoveryCode, null);
  assert.equal(normalizeAttentionRequest(request({ recoveryCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" })).recoveryCode,
    "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  for (const recoveryCode of [undefined, false, "UNKNOWN_FAILURE", "STRUCTURED_PROVIDER_MODEL_CAPACITY", {}, { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" }]) {
    assert.throws(() => normalizeAttentionRequest(request({ recoveryCode })), { code: "INVALID_ATTENTION_REQUEST" });
  }
});

test("attention request normalization rejects accessors without invoking them", () => {
  let invoked = false;
  const context = [];
  Object.defineProperty(context, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return { label: "危险", value: "getter" };
    },
  });
  context.length = 1;

  assert.throws(
    () => normalizeAttentionRequest(request({ context })),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
  assert.equal(invoked, false);
});

test("attention request values and aggregate size are bounded", () => {
  assert.throws(
    () => normalizeAttentionRequest(request({ question: "问".repeat(4_097) })),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
  assert.throws(
    () =>
      normalizeAttentionRequest(
        request({
          context: Array.from({ length: 21 }, (_, index) => ({
            label: `字段 ${index}`,
            value: "内容",
          })),
        }),
      ),
    (error) => error.code === "INVALID_ATTENTION_REQUEST",
  );
});

test("the browser response accepts only a bound revision, digest, and closed answer union", () => {
  const base = {
    requestId: `attention-${"a".repeat(64)}`,
    expectedRevision: 7,
    contentDigest: "b".repeat(64),
  };

  assert.deepEqual(
    normalizeAttentionBrowserResponse({
      ...base,
      answer: { type: "text", text: "请先交给需求分析师" },
    }),
    {
      ...base,
      answer: { type: "text", text: "请先交给需求分析师" },
    },
  );
  assert.deepEqual(
    normalizeAttentionBrowserResponse({
      ...base,
      answer: { type: "choice", choiceId: "requirements" },
    }).answer,
    { type: "choice", choiceId: "requirements" },
  );
  assert.deepEqual(
    normalizeAttentionBrowserResponse({
      ...base,
      answer: { type: "reject", reason: "信息不足" },
    }).answer,
    { type: "reject", reason: "信息不足" },
  );
  assert.deepEqual(
    normalizeAttentionBrowserResponse({ ...base, answer: { type: "later" } })
      .answer,
    { type: "later" },
  );

  for (const invalid of [
    { ...base, answer: { type: "text", text: "好", command: "git push" } },
    { ...base, answer: { type: "github_review", body: "approve" } },
    { ...base, answer: { type: "text", text: { body: "nested" } } },
    { ...base, answer: { type: "later" }, action: "execute" },
  ]) {
    assert.throws(
      () => normalizeAttentionBrowserResponse(invalid),
      (error) => error.code === "INVALID_ATTENTION_RESPONSE",
    );
  }
});

test("durable state count limits fail closed before item decoding", () => {
  assert.throws(
    () =>
      normalizeAttentionState({
        ...defaultAttentionState(),
        items: Array.from({ length: 1_001 }, () => null),
      }),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED",
  );
});

test("durable state accessors are rejected without execution", () => {
  let invoked = false;
  const state = defaultAttentionState();
  Object.defineProperty(state, "revision", {
    enumerable: true,
    get() {
      invoked = true;
      return 0;
    },
  });

  assert.throws(
    () => normalizeAttentionState(state),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED",
  );
  assert.equal(invoked, false);
});

test("durable state rejects non-JSON scalar normalization", () => {
  assert.throws(
    () => normalizeAttentionState({ ...defaultAttentionState(), revision: -0 }),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED",
  );
});
