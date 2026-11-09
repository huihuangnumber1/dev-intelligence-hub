import assert from "node:assert/strict";
import test from "node:test";
import { postAttentionDuringFactRefresh } from "../public/attention-submission.js";

test("a fact-refresh 503 retries the same answer and completes when the gate reopens", async () => {
  const calls = [];
  const options = { method: "POST", body: '{"answer":"keep this"}' };
  const responses = [
    { status: 503, json: async () => ({ code: "CONFIRMATION_FACTS_NOT_READY" }) },
    { status: 200, json: async () => ({ item: { status: "answered" } }) },
  ];
  let waiting = 0;
  const response = await postAttentionDuringFactRefresh("/attention/answer", options, {
    fetcher: async (url, suppliedOptions) => {
      calls.push({ url, options: suppliedOptions });
      return responses.shift();
    },
    sleep: async () => {},
    onWaiting: () => { waiting += 1; },
  });
  assert.equal(response.status, 200);
  assert.equal(waiting, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
});

test("other 503 errors and ownership changes do not replay a submission", async () => {
  let calls = 0;
  const failed = await postAttentionDuringFactRefresh("/attention/answer", {}, {
    fetcher: async () => {
      calls += 1;
      return { status: 503, json: async () => ({ code: "OTHER_OUTAGE" }) };
    },
  });
  assert.equal(failed.status, 503);
  assert.equal(calls, 1);

  let current = true;
  const cancelled = await postAttentionDuringFactRefresh("/attention/answer", {}, {
    fetcher: async () => {
      calls += 1;
      return {
        status: 503,
        json: async () => ({ code: "CONFIRMATION_FACTS_NOT_READY" }),
      };
    },
    isCurrent: () => current,
    sleep: async () => { current = false; },
  });
  assert.equal(cancelled, null);
  assert.equal(calls, 2);
});
