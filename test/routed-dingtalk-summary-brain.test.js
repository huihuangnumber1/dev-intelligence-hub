import assert from "node:assert/strict";
import test from "node:test";

import { BrainRouter } from "../src/services/brain-router.js";
import { RoutedDingTalkSummaryBrain } from "../src/adapters/routed-dingtalk-summary-brain.js";

const PRIMARY = Object.freeze({
  provider: "luna",
  model: "gpt-6-luna",
  reasoningEffort: "medium",
  remoteData: Object.freeze({
    requirements: false,
    code: false,
    memory: false,
  }),
});

const CONVERSATIONS = Object.freeze([{
  groupId: "group-1",
  context: "研发群",
  messages: [{ author: "Alice", content: "版本已验证，可以发布。", updatedAt: "2026-11-02T00:00:00Z" }],
}]);

const SUMMARY = Object.freeze({
  groupId: "group-1",
  important: true,
  summary: "版本已验证，可以发布。",
  highlights: ["验证通过"],
  actionRequired: "",
});

function routerFor(generate) {
  return new BrainRouter({ providers: [{
    id: "luna",
    remote: true,
    async generate(request) { return generate(request); },
  }] });
}

test("DingTalk summaries use explicitly authorized Luna data class and report the primary route", async () => {
  const calls = [];
  const brain = new RoutedDingTalkSummaryBrain({
    router: routerFor(async (request) => {
      calls.push(request);
      return { summaries: [SUMMARY] };
    }),
    primaryBrain: PRIMARY,
    allowRemoteDingTalkSummary: true,
    fallback: { async summarizeDingTalk() { assert.fail("fallback must not run"); } },
  });

  const result = await brain.summarizeDingTalkWithReceipt(CONVERSATIONS);

  assert.deepEqual(result.summaries, [SUMMARY]);
  assert.equal(result.fallbackUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gpt-6-luna");
  assert.equal(calls[0].reasoningEffort, "medium");
  assert.match(calls[0].messages[1].content, /版本已验证/);
});

test("DingTalk summaries fall back to Ollama once Luna transport fails", async () => {
  let fallbackCalls = 0;
  const brain = new RoutedDingTalkSummaryBrain({
    router: routerFor(async () => {
      throw Object.assign(new Error("provider stopped"), {
        code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
      });
    }),
    primaryBrain: PRIMARY,
    allowRemoteDingTalkSummary: true,
    fallback: { async summarizeDingTalk(conversations) {
      fallbackCalls += 1;
      assert.deepEqual(conversations, CONVERSATIONS);
      return [SUMMARY];
    } },
  });

  const result = await brain.summarizeDingTalkWithReceipt(CONVERSATIONS);

  assert.deepEqual(result.summaries, [SUMMARY]);
  assert.equal(result.fallbackUsed, true);
  assert.equal(fallbackCalls, 1);
});

test("native CLI JSON text is parsed without requiring Ollama", async () => {
  const brain = new RoutedDingTalkSummaryBrain({
    router: routerFor(async () => JSON.stringify({ summaries: [SUMMARY] })),
    primaryBrain: PRIMARY,
    allowRemoteDingTalkSummary: true,
    fallback: { async summarizeDingTalk() { assert.fail("valid CLI output must not need Ollama"); } },
  });
  const result = await brain.summarizeDingTalkWithReceipt(CONVERSATIONS);
  assert.deepEqual(result, { summaries: [SUMMARY], fallbackUsed: false });
});

test("DingTalk content cannot be routed remotely without explicit authorization", async () => {
  let calls = 0;
  assert.throws(() => new RoutedDingTalkSummaryBrain({
    router: routerFor(async () => { calls += 1; return { summaries: [SUMMARY] }; }),
    primaryBrain: PRIMARY,
    allowRemoteDingTalkSummary: false,
    fallback: { async summarizeDingTalk() { return [SUMMARY]; } },
  }), /remote DingTalk summary authorization/);
  assert.equal(calls, 0);
});

test("Luna cancellation does not trigger a local fallback", async () => {
  let fallbackCalls = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  const brain = new RoutedDingTalkSummaryBrain({
    router: routerFor(async () => { assert.fail("aborted calls must not reach Luna"); }),
    primaryBrain: PRIMARY,
    allowRemoteDingTalkSummary: true,
    fallback: { async summarizeDingTalk() { fallbackCalls += 1; return [SUMMARY]; } },
  });

  await assert.rejects(
    brain.summarizeDingTalkWithReceipt(CONVERSATIONS, { signal: controller.signal }),
    /cancelled by caller/,
  );
  assert.equal(fallbackCalls, 0);
});

test("both-provider failures retain only validated native stage diagnostics", async () => {
  const nativeFailure = { kind: 'rpc_error', method: 'turn/start', code: -32600 };
  const brain = new RoutedDingTalkSummaryBrain({
    router: routerFor(async () => { throw Object.assign(new Error('PRIVATE_MESSAGE'), {
      code: 'STRUCTURED_PROVIDER_PROCESS_FAILED', nativeFailure,
    }); }), primaryBrain: PRIMARY, allowRemoteDingTalkSummary: true,
    fallback: { async summarizeDingTalk() { throw new Error('fallback unavailable'); } },
  });
  await assert.rejects(brain.summarizeDingTalkWithReceipt(CONVERSATIONS), error => {
    assert.deepEqual(error.primaryNativeFailure, nativeFailure);
    assert.equal(JSON.stringify(error).includes('PRIVATE_MESSAGE'), false);
    return error.code === 'DINGTALK_SUMMARY_BOTH_PROVIDERS_FAILED';
  });
});
