import assert from "node:assert/strict";
import test from "node:test";

import { DingTalkAdapter } from "../src/adapters/dingtalk-adapter.js";

test("a timed-out mailbox preserves successful DingTalk sources", async () => {
  const adapter = new DingTalkAdapter();
  adapter.dailyMessages = async () => [];
  adapter.unreadConversations = async () => [];
  adapter.mentions = async () => [];
  adapter.todos = async () => [{ id: "todo:fresh", kind: "todo" }];
  let mailSignal;
  adapter.mail.collect = async (_now, { signal }) => {
    mailSignal = signal;
    return new Promise(() => {});
  };
  const result = await Promise.race([
    adapter.collect(null, { mailEnabled: true, sourceTimeoutMs: 20 }),
    new Promise(resolve => { const timer = setTimeout(() => resolve(null), 500); timer.unref(); }),
  ]);
  assert.ok(result, "one stuck source must not hold the collection");
  assert.equal(mailSignal.aborted, true);
  assert.deepEqual(result.failedSources, ["mail"]);
  assert.deepEqual(result.items, [{ id: "todo:fresh", kind: "todo" }]);
});

test("cancelling bounded collection aborts every source and rejects instead of publishing partial data", async () => {
  const adapter = new DingTalkAdapter();
  const controller = new AbortController();
  const signals = [];
  const pending = async (...args) => {
    const { signal } = args.at(-1);
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  for (const name of ["dailyMessages", "unreadConversations", "mentions", "todos"]) adapter[name] = pending;
  adapter.mail.collect = pending;
  const collection = adapter.collect(null, { signal: controller.signal, mailEnabled: true, sourceTimeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error("refresh cancelled");
  controller.abort(reason);
  await assert.rejects(collection, error => error === reason);
  assert.equal(signals.length, 5);
  assert.ok(signals.every(signal => signal.aborted));
});

test("DingTalk collection forwards one shutdown signal to every CLI read", async () => {
  const controller = new AbortController();
  const calls = [];
  const adapter = new DingTalkAdapter({
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes("list-all")) {
        return {
          result: {
            conversationMessagesList: [
              {
                title: "研发群",
                singleChat: false,
                openConversationId: "group-1",
                messages: [
                  {
                    openMessageId: "message-1",
                    sender: "PR Notice",
                    content: "发布提醒：v4.0.701 需要确认",
                    createTime: "2026-08-25 09:00:00",
                  },
                ],
              },
            ],
          },
        };
      }
      if (args.includes("list-unread-conversations")) {
        return { result: { conversations: [] } };
      }
      if (args.includes("search-advanced")) {
        return { result: { messages: [] } };
      }
      if (args.includes("task")) {
        return { result: { todoCards: [] } };
      }
      throw new Error(`Unexpected DingTalk command: ${args.join(" ")}`);
    },
  });

  const result = await adapter.collect(null, { signal: controller.signal });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.items.map(({ kind, title, context }) => ({
    kind,
    title,
    context,
  })), [
    {
      kind: "announcement",
      title: "发布提醒：v4.0.701 需要确认",
      context: "研发群",
    },
  ]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.command === "dws"));
  assert.ok(calls.every((call) => call.options.signal === controller.signal));
  const daily = calls.find((call) => call.args.includes("list-all"));
  assert.ok(daily.args.includes("--cursor"));
  assert.ok(daily.args.includes("0"));
});

test("DingTalk notification forwards shutdown to the CLI writer", async () => {
  const controller = new AbortController();
  let call = null;
  const adapter = new DingTalkAdapter({
    async runText(command, args, options) {
      call = { command, args, options };
      return "";
    },
  });

  await adapter.notifySelf(
    "local-owner",
    "title",
    "message",
    { signal: controller.signal },
  );

  assert.equal(call.command, "dws");
  assert.equal(call.options.timeoutMs, 60_000);
  assert.strictEqual(call.options.signal, controller.signal);
});

test("a failed DingTalk subsource is identified without discarding successful sources", async () => {
  const adapter = new DingTalkAdapter({
    async run(_command, args) {
      if (args.includes("search-advanced")) throw new Error("RATE_LIMIT_ERROR");
      return { result: {} };
    },
  });
  const result = await adapter.collect(null);
  assert.deepEqual(result.failedSources, ["mentions"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^mentions:/u);
});
