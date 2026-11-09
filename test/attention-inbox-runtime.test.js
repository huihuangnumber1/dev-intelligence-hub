import assert from "node:assert/strict";
import test from "node:test";
import { createAttentionInboxRuntime } from "../src/attention-inbox-runtime.js";

class MemoryStore {
  constructor() {
    this.value = null;
  }

  async read(_name, fallback) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

class Guard {
  constructor(options) {
    this.options = options;
    this.acquired = false;
    this.closed = false;
  }

  async acquire() {
    this.acquired = true;
  }

  run(operation) {
    assert.equal(this.acquired, true);
    return operation();
  }

  async close() {
    this.closed = true;
  }
}

test("runtime exposes separate least-authority producer, browser, and consumer ports", async () => {
  let guard;
  const runtime = await createAttentionInboxRuntime({
    store: new MemoryStore(),
    clock: () => new Date("2026-08-02T02:00:00.000Z"),
    createGuard(options) {
      guard = new Guard(options);
      return guard;
    },
  });

  assert.deepEqual(Object.keys(runtime).sort(), ["browser", "close", "consumer", "maintenance", "producer"]);
  assert.deepEqual(Object.keys(runtime.producer), ["create"]);
  assert.deepEqual(Object.keys(runtime.browser).sort(), ["answer", "later", "listMaintenance", "next", "readStatus", "reject"]);
  assert.deepEqual(Object.keys(runtime.consumer), ["readOutbox"]);
  assert.deepEqual(Object.keys(runtime.maintenance), ["archiveRetired", "retrySystemQuestions"]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.browser), true);
  assert.equal(guard.options.name, "mydashboard-attention-inbox-v1");

  const created = await runtime.producer.create({
    requestKey: "work-1-question",
    type: "clarify_requirement",
    producer: { roleId: "requirements-analyst", workItemId: "work-1" },
    question: "验收标准是什么？",
  });
  const next = await runtime.browser.next();
  assert.deepEqual(await runtime.browser.readStatus({ requestId: next.requestId }), { requestId: next.requestId, status: "pending" });
  await runtime.browser.answer({
    requestId: next.requestId,
    expectedRevision: next.revision,
    contentDigest: next.contentDigest,
    answer: { type: "text", text: "本地测试全部通过" },
  });
  assert.equal((await runtime.consumer.readOutbox()).items.length, 1);

  await runtime.close();
  await runtime.close();
  assert.equal(guard.closed, true);
  assert.equal(created.requestId, next.requestId);
});

test("runtime forwards deferred bindings and archives retired questions on startup", async () => {
  const store = new MemoryStore();
  let retired = false;
  const authority = {
    isCurrent: async () => !retired,
    readAttentionRequestRetirement: async () => retired
      ? { status: "cancelled", workItemRevision: 3, reason: "issue_source_left_scope" }
      : null,
  };
  const options = { store, authority, createGuard: (value) => new Guard(value) };
  const initial = await createAttentionInboxRuntime(options);
  const request = await initial.producer.create({
    requestKey: "work-1-question", type: "ask_user",
    producer: { roleId: "requirements-analyst", workItemId: "work-1" },
    question: "验收标准是什么？",
  });
  assert.equal(await initial.browser.next({ deferred: [{
    requestId: request.requestId, contentDigest: request.contentDigest,
  }] }), null);
  assert.equal((await initial.browser.next()).requestId, request.requestId);
  await initial.close();
  retired = true;
  const recovered = await createAttentionInboxRuntime(options);
  assert.equal(store.value.items[0].status, "archived");
  assert.equal(await recovered.browser.next(), null);
  assert.equal(store.value.outbox.length, 0);
  await recovered.close();
});

test("runtime closes the process guard if recovery fails", async () => {
  let guard;
  await assert.rejects(
    createAttentionInboxRuntime({
      store: {
        async read() {
          return { schemaVersion: 1, revision: "corrupt" };
        },
        async write() {},
      },
      createGuard(options) {
        guard = new Guard(options);
        return guard;
      },
    }),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED",
  );
  assert.equal(guard.closed, true);
});
