import assert from "node:assert/strict";
import test from "node:test";
import { AttentionResultReconciler } from "../src/services/attention-result-reconciler.js";

function batch(sequence = 1) {
  return {
    items: [{ sequence }],
    nextSequence: sequence,
    highWatermark: sequence,
    oldestAvailableSequence: 1,
  };
}

test("reconciler archives retired questions only after applying recorded answers", async () => {
  const calls = [];
  const reconciler = new AttentionResultReconciler({
    attentionConsumer: { readOutbox: async () => batch() },
    attentionMaintenance: { archiveRetired: async () => { calls.push("archive"); },
      retrySystemQuestions: async () => { calls.push("retry"); } },
    ledger: {
      getSummary: async () => ({ attentionCursor: 0 }),
      applyAttentionBatch: async () => { calls.push("apply"); return { applied: 1 }; },
    },
  });
  assert.deepEqual(await reconciler.runCycle(), { applied: 1 });
  assert.deepEqual(calls, ["apply", "retry", "archive"]);
});

test("reconciler releases the attention read before mutating the ledger", async () => {
  const calls = [];
  let reading = false;
  const attentionConsumer = {
    async readOutbox(options) {
      calls.push(["read", options]);
      reading = true;
      await Promise.resolve();
      reading = false;
      return batch();
    },
  };
  const ledger = {
    async getSummary() {
      calls.push(["checkpoint"]);
      return { attentionCursor: 0 };
    },
    async applyAttentionBatch(value) {
      assert.equal(reading, false);
      calls.push(["apply", value]);
      return { applied: 1, cursor: 1 };
    },
  };
  const reconciler = new AttentionResultReconciler({
    attentionConsumer,
    ledger,
  });

  const result = await reconciler.runCycle({ limit: 10 });

  assert.deepEqual(result, { applied: 1, cursor: 1 });
  assert.deepEqual(calls.map(([kind]) => kind), ["checkpoint", "read", "apply"]);
  assert.deepEqual(calls[1][1], { afterSequence: 0, limit: 10 });
});

test("reconciler safely replays a lost ledger acknowledgement from the durable cursor", async () => {
  let durableCursor = 0;
  let visibleCursor = 0;
  let loseFirstAck = true;
  const reads = [];
  const attentionConsumer = {
    async readOutbox(options) {
      reads.push(options.afterSequence);
      return batch();
    },
  };
  const ledger = {
    async getSummary() {
      return { attentionCursor: visibleCursor };
    },
    async applyAttentionBatch(value) {
      if (value.nextSequence > durableCursor) {
        durableCursor = value.nextSequence;
        if (loseFirstAck) {
          loseFirstAck = false;
          throw new Error("write committed but acknowledgement was lost");
        }
      }
      visibleCursor = durableCursor;
      return {
        applied: 0,
        deduplicated: value.items.length,
        cursor: durableCursor,
      };
    },
  };
  const reconciler = new AttentionResultReconciler({
    attentionConsumer,
    ledger,
  });

  await assert.rejects(reconciler.runCycle(), /acknowledgement was lost/);
  const replay = await reconciler.runCycle();

  assert.deepEqual(replay, { applied: 0, deduplicated: 1, cursor: 1 });
  assert.deepEqual(reads, [0, 0]);
  assert.equal(durableCursor, 1);
});

test("reconciler coalesces concurrent cycles and validates its ports", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const attentionConsumer = {
    async readOutbox() {
      await waiting;
      return {
        items: [],
        nextSequence: 0,
        highWatermark: 0,
        oldestAvailableSequence: null,
      };
    },
  };
  const ledger = {
    getSummary: async () => ({ attentionCursor: 0 }),
    applyAttentionBatch: async () => ({ applied: 0, cursor: 0 }),
  };
  const reconciler = new AttentionResultReconciler({ attentionConsumer, ledger });

  const first = reconciler.runCycle();
  const second = reconciler.runCycle({ limit: 1 });
  assert.strictEqual(second, first);
  release();
  await first;

  assert.throws(
    () => new AttentionResultReconciler({ attentionConsumer: {}, ledger }),
    /attentionConsumer/,
  );
  assert.throws(() => reconciler.runCycle({ limit: 101 }), /limit/);
});
