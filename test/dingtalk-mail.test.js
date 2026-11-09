import assert from "node:assert/strict";
import test from "node:test";
import { DingTalkMailAdapter } from "../src/adapters/dingtalk-mail-adapter.js";
import { DingTalkAdapter } from "../src/adapters/dingtalk-adapter.js";
import { cleanMailBody, githubMailSource, mailItem, mergeMailNotifications } from "../src/domain/dingtalk-mail.js";
import { applyDingTalkSummaries, dingTalkDigestFacts, prepareDingTalkDigest } from "../src/domain/dingtalk-digest.js";
import { buildDashboard } from "../src/domain/dashboard-model.js";
import { createDingTalkReport, dueDingTalkReportSlot } from "../src/domain/dingtalk-report.js";

const now = new Date("2026-10-10T01:00:00Z");
const mailbox = "owner@example.test";
function message(id, overrides = {}) {
  return { id, subject: "Re: [acme/repo] 需求 (#42)", conversationId: "thread-1",
    from: { email: "notifications@github.com", name: "developer" },
    markdownBody: `[@owner](https://github.com/owner) 请确认字段。\nhttps://github.com/acme/repo/issues/42?email_token=SECRET\n\n---\nReply to this email directly, unsubscribe https://github.com/notifications/unsubscribe?token=SECRET`,
    receivedDateTime: "2026-10-10T00:00:00Z", toRecipients: [{ email: mailbox }], ...overrides };
}

test("mail collection reads every page and real body, caches within the window and never writes", async () => {
  const controller = new AbortController();
  const calls = [];
  const adapter = new DingTalkMailAdapter({ ownerLogin: "owner", async run(command, args, options) {
    calls.push({ command, args, options });
    if (args.includes("mailbox")) return { emailAccounts: [{ type: "ORG", email: mailbox }, { type: "PERSONAL", email: "other@example.test" }] };
    if (args.includes("search")) {
      assert.match(args[args.indexOf("--query") + 1], /folderId:2 AND date>2026-10-09T01:00:00\.000Z AND date<2026-10-10T01:00:00\.000Z/);
      return args.includes("--cursor") ? { messages: [{ id: "two" }], nextCursor: "$" }
        : { messages: [{ id: "one" }], nextCursor: "page-2" };
    }
    if (args.includes("batch-get")) return { messages: args[args.indexOf("--ids") + 1].split(",").map((id) => ({ id, result: { success: "true", message: message(id) } })) };
    throw new Error("Unexpected command");
  } });
  const options = { signal: controller.signal };
  const items = await adapter.collect(now, options);
  assert.equal(items.length, 2);
  assert.equal(items[0].relation, "mentioned");
  assert.equal(items[0].url, "https://github.com/acme/repo/issues/42");
  assert.ok(!JSON.stringify(items).includes("SECRET"));
  await adapter.collect(now, options);
  assert.equal(calls.filter(({ args }) => args.includes("batch-get")).length, 1);
  assert.ok(calls.every(({ command, options: o }) => command === "dws" && o.signal === controller.signal));
  assert.ok(calls.every(({ args }) => args.includes("--format") && !args.some((arg) => ["send", "update", "delete", "mark-read"].includes(arg))));
});

test("ambiguous mailbox and incomplete or mismatched bodies fail visibly without leaking CLI secrets", async () => {
  for (const failure of ["account", "missing", "identity", "cli", "cursor"]) {
    const adapter = new DingTalkMailAdapter({ async run(_command, args) {
      if (args.includes("mailbox")) return { emailAccounts: failure === "account" ? [] : [{ type: "ORG", email: mailbox }] };
      if (args.includes("search")) return { messages: [{ id: "one" }], nextCursor: failure === "cursor" ? "same" : "$" };
      if (failure === "cli") throw new Error("token=SECRET");
      return { messages: failure === "missing" ? [] : [{ id: "one", result: { message: message("wrong") } }] };
    } });
    await assert.rejects(adapter.collect(now), (error) => !error.message.includes("SECRET") && /邮箱|邮件/.test(error.message));
  }
});

test("mail failure keeps successful chat sources and identifies mail as stale", async () => {
  const adapter = new DingTalkAdapter({ async run(_command, args) {
    if (args[0] === "mail") throw new Error("private stderr");
    if (args.includes("task")) return { result: { todoCards: [{ taskId: "task", subject: "待办" }] } };
    return { result: {} };
  } });
  const result = await adapter.collect(null, { mailEnabled: true });
  assert.deepEqual(result.failedSources, ["mail"]);
  assert.equal(result.items[0].kind, "todo");
  assert.ok(!result.errors.join().includes("private stderr"));
});

test("GitHub footer and quoted text cannot create a false mention; current assignment is retained", () => {
  const item = mailItem(message("one", { markdownBody: "普通更新\nOn yesterday someone wrote:\n> @owner 旧文\n\n---\nReply to this email directly, @owner\nYou are receiving this because you were assigned." }), { mailbox, ownerLogin: "owner" });
  assert.equal(item.relation, "assigned");
  assert.equal(item.content, "普通更新\nOn yesterday someone wrote:\n> @owner 旧文");
  assert.equal(cleanMailBody("请确认 https://example.test/item?token=SECRET#secret"), "请确认 https://example.test/item");
});

test("same GitHub thread is summarized once with full evidence and actionable mail enters scheduled reports", () => {
  const longBody = `${"字段说明".repeat(100)} 请保留末尾结论`;
  const items = [mailItem(message("one"), { mailbox, ownerLogin: "owner" }),
    mailItem(message("two", { conversationId: "different-mail-thread", markdownBody: `@owner ${longBody}\nhttps://github.com/acme/repo/issues/42`, bodyHasMore: true }), { mailbox, ownerLogin: "owner" })];
  const prepared = prepareDingTalkDigest(items);
  assert.equal(prepared.groups.length, 1);
  assert.ok(dingTalkDigestFacts(prepared.groups)[0].messages.some((entry) => entry.content.includes("末尾结论")));
  const [group] = prepared.groups;
  const digests = applyDingTalkSummaries(prepared, [{ groupId: group.groupId, important: true,
    summary: "确认新增采集字段", highlights: ["保留结论"], actionRequired: "确认字段方案" }]);
  assert.equal(digests[0].kind, "mail");
  assert.equal(digests[0].bodyIncomplete, true);
  assert.equal(digests[0].sourceMessages.length, 2);
  assert.equal(dingTalkDigestFacts(prepared.groups)[0].currentUser, "owner");
  const dashboard = buildDashboard({ items: digests, refreshedAt: now.toISOString(), sources: {}, errors: [] });
  assert.equal(dashboard.groups.dingtalk.length, 1);
  assert.equal(dashboard.groups.dingtalk[0].score, 82);
  const report = createDingTalkReport(dashboard, dueDingTalkReportSlot(now), null, now);
  assert.equal(report.counts.mail, 1);
  assert.match(report.message, /\[邮件\] 确认字段方案/);
});

test("routine GitHub notifications merge with known PRs while substantive comments remain", () => {
  const options = { mailbox, ownerLogin: "owner" };
  const assignment = mailItem(message("one", { markdownBody: "Assigned [#42](https://github.com/acme/repo/issues/42?email_token=SECRET) to [@owner](https://github.com/owner)." }), options);
  const comment = mailItem(message("two"), options);
  assert.deepEqual(mergeMailNotifications([assignment, comment], [{ repo: "acme/repo", number: 42 }]), [comment]);
  assert.deepEqual(mergeMailNotifications([assignment], []), [assignment]);
});

test("thread identity comes from GitHub Message ID rather than a referenced PR in the comment", () => {
  const body = "参考 https://github.com/acme/other/pull/99\n请确认当前实现\n" +
    "[view it on GitHub](https://github.com/acme/repo/issues/42?email_token=SECRET#issuecomment-123)\n" +
    "Message ID: \\<acme/repo/issues/42/123@github.com\\>";
  assert.deepEqual(githubMailSource(body), { repo: "acme/repo", number: 42,
    threadUrl: "https://github.com/acme/repo/issues/42", url: "https://github.com/acme/repo/issues/42#issuecomment-123" });
  assert.equal(githubMailSource("https://github.com/acme/other/pull/99 https://github.com/acme/repo/issues/42"), null);
});

test("quoted requirements and substantive review comments remain available as evidence", () => {
  const options = { mailbox, ownerLogin: "owner" };
  const footer = "\n\n---\nReply to this email directly,\nYou are receiving this because you were assigned.";
  const quoted = mailItem(message("one", { markdownBody: "请按以下要求修复：\n> 将采样间距改成 0.5mm\nhttps://github.com/acme/repo/pull/42" + footer }), options);
  assert.match(quoted.content, /0\.5mm/);
  const review = mailItem(message("two", { markdownBody: "Changes requested: fix out-of-bounds read at line 56.\nhttps://github.com/acme/repo/pull/42" + footer }), options);
  assert.deepEqual(mergeMailNotifications([quoted, review], [{ repo: "acme/repo", number: 42 }]), [quoted, review]);
});

test("GitHub subscriptions without an explicit connection to the owner are excluded", () => {
  const followed = mailItem(message("one", { markdownBody: "测试完成\nhttps://github.com/acme/repo/pull/42" }), { mailbox, ownerLogin: "owner" });
  assert.equal(followed.relation, "followed");
  assert.deepEqual(mergeMailNotifications([followed], []), []);
});

test("own PR feedback, requested reviews and current quoted mentions are retained", () => {
  const options = { mailbox, ownerLogin: "owner" };
  for (const [reason, relation] of [["you authored the thread", "authored"], ["your review was requested", "review_requested"], ["you commented", "participated"]]) {
    const item = mailItem(message("one", { markdownBody: `Changes requested: fix the bounds.\nhttps://github.com/acme/repo/pull/42\n\n---\nReply to this email directly,\nYou are receiving this because ${reason}.` }), options);
    assert.equal(item.relation, relation);
    assert.deepEqual(mergeMailNotifications([item], []), [item]);
  }
  const quoted = mailItem(message("quoted", { markdownBody: "> @owner 将采样间距改成 0.5mm\nhttps://github.com/acme/repo/pull/42" }), options);
  assert.equal(quoted.relation, "mentioned");
  assert.deepEqual(mergeMailNotifications([quoted], []), [quoted]);
  const followed = mailItem(message("known", { markdownBody: "Changes requested: fix the bounds.\nhttps://github.com/acme/repo/pull/42" }), options);
  const [retained] = mergeMailNotifications([followed], [{ repo: "acme/repo", number: 42, relation: "authored" }]);
  assert.equal(retained.relation, "authored");
});

test("mail output cannot turn feature reuse into resolution or another person's work into mine", () => {
  const options = { mailbox, ownerLogin: "owner" };
  const reuse = mailItem(message("reuse", { markdownBody: "**teammate** left a comment (acme/repo#42)\n\n@owner 这个功能在角膜地形图已经做了，同样的功能可以应用于眼底曲率地形图。" }), options);
  const prepared = prepareDingTalkDigest([reuse]);
  for (const completion of ["已解决", "已经解决", "已实现", "无需额外开发"]) {
    for (const field of ["summary", "highlights", "actionRequired"]) {
      const generated = { groupId: prepared.groups[0].groupId, important: true,
        summary: "建议复用已有功能", highlights: [], actionRequired: "" };
      generated[field] = field === "highlights" ? [`Issue ${completion}，可以关闭`] : `Issue ${completion}，可以关闭`;
      const [item] = applyDingTalkSummaries(prepared, [generated]);
      assert.doesNotMatch([item.summary, ...item.highlights, item.actionRequired].join("\n"), /已(?:经)?解决|已实现|无需额外开发/);
      assert.equal(item.summaryStatus, "fallback");
      assert.doesNotMatch(item.summary, /left a comment/);
      assert.match(item.summary, /眼底曲率地形图/);
      assert.match(item.sourceMessages[0].content, /可以应用/);
      assert.match(item.sourceMessages[0].content, /left a comment/);
    }
  }
  const delegated = mailItem(message("delegated", { markdownBody: "请 @teammate 检查 700B 版本。\n\n---\nReply to this email directly,\nYou are receiving this because you were assigned." }), options);
  const second = prepareDingTalkDigest([delegated]);
  const [mine] = applyDingTalkSummaries(second, [{ groupId: second.groups[0].groupId, important: true,
    summary: "请 teammate 检查 700B 版本", highlights: [], actionRequired: "请 teammate 检查 700B 版本" }]);
  assert.equal(mine.actionRequired, "");
  const [implicit] = applyDingTalkSummaries(second, [{ groupId: second.groups[0].groupId, important: true,
    summary: "等待 teammate 检查", highlights: [], actionRequired: "修改源码完成回归" }]);
  assert.equal(implicit.actionRequired, "");
  const historicalMention = mailItem(message("historical", { markdownBody: "@teammate\n看下 Web 的 700B 版本是否仍存在这个问题。\n\n---\nReply to this email directly,\nYou are receiving this because you were mentioned." }), options);
  const third = prepareDingTalkDigest([historicalMention]);
  const [generic] = applyDingTalkSummaries(third, [{ groupId: third.groups[0].groupId, important: true,
    summary: "请检查 Web 700B 版本", highlights: ["检查 Web 700B 版本"], actionRequired: "检查 Web 700B 版本并反馈" }]);
  assert.equal(generic.actionRequired, "");
  assert.equal(generic.summaryStatus, "fallback");
  assert.match(generic.summary, /@teammate/);
});
