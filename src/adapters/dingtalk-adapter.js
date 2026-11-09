import { runCommand, runJson } from "../lib/command-runner.js";
import { DingTalkMailAdapter } from "./dingtalk-mail-adapter.js";
import { runStructuredProviderRequest } from "../lib/structured-provider-request.js";

function isoWithOffset(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const pad = (value) => String(value).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(
    Math.floor(absolute / 60),
  )}:${pad(absolute % 60)}`;
}

function textValue(message) {
  const value = message.text || message.content || "";
  return typeof value === "string"
    ? value
    : value.content || JSON.stringify(value);
}

const IMPORTANT_MESSAGE =
  /(?:@|公告|通知|提醒|预警|风险|阻塞|故障|截止|待办|确认|评审|审核|测试|发布|版本|研发|需求|客户|FDA|\bPR\b|\bIssue\b|日报|早报|周报|总结|关注)/iu;
const ANNOUNCEMENT_MESSAGE =
  /(?:公告|通知|提醒|预警|风险|截止|日报|早报|周报|总结|关注)/u;

function localDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
}

function messageTimestamp(value, fallback) {
  const normalized = typeof value === "string"
    ? value.replace(
        /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u,
        "$1T$2",
      )
    : value;
  const parsed = new Date(normalized || fallback);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : fallback.toISOString();
}

function firstWebLink(content) {
  return content.match(/https:\/\/[^\s)\]]+/u)?.[0] || "";
}

function dailyMessageItems(data, fallback) {
  const conversations = data.result?.conversationMessagesList || [];
  const items = [];
  const seen = new Set();
  for (const conversation of conversations) {
    for (const [index, message] of (conversation.messages || []).entries()) {
      const content = textValue(message).replace(/\s+/gu, " ").trim();
      if (
        !content ||
        (conversation.singleChat !== false && !IMPORTANT_MESSAGE.test(content))
      ) {
        continue;
      }
      const messageId =
        message.openMessageId ||
        message.msgId ||
        `${conversation.openConversationId || "unknown"}:${message.createTime || index}`;
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      const announcement =
        ANNOUNCEMENT_MESSAGE.test(content) ||
        /(?:notice|公告)/iu.test(message.sender || "");
      items.push({
        id: `dingtalk:message:${messageId}`,
        kind: announcement ? "announcement" : "message",
        relation: "daily",
        title: content.slice(0, 240),
        author: message.sender || "",
        context: conversation.title || "钉钉消息",
        conversationId:
          conversation.openConversationId || conversation.title || "",
        updatedAt: messageTimestamp(message.createTime, fallback),
        url: firstWebLink(content),
        state: "open",
      });
    }
  }
  return items;
}

export class DingTalkAdapter {
  constructor({ run = runJson, runText = runCommand, ownerLogin = "" } = {}) {
    this.run = run;
    this.runText = runText;
    this.mail = new DingTalkMailAdapter({ run, ownerLogin });
  }

  async collect(since, { signal = null, mailEnabled = false, sourceTimeoutMs = null } = {}) {
    if (sourceTimeoutMs !== null && (!Number.isSafeInteger(sourceTimeoutMs) || sourceTimeoutMs < 1 || sourceTimeoutMs > 30_000)) {
      throw new TypeError("DingTalk sourceTimeoutMs must be between 1 and 30000");
    }
    signal?.throwIfAborted();
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const read = operation => {
      if (sourceTimeoutMs === null) return Promise.resolve().then(() => operation(signal === null ? {} : { signal }));
      const controller = new AbortController();
      return runStructuredProviderRequest({
        controller, timeoutMs: sourceTimeoutMs, signal,
        operation: () => operation({ signal: controller.signal }),
        cancellationError: () => signal.reason,
        timeoutError: () => Object.assign(new Error("数据源读取超时，本轮保留该来源已有数据"), { code: "DINGTALK_SOURCE_TIMEOUT" }),
      });
    };
    const [dailyMessages, unread, mentions, todos, mail] = await Promise.allSettled([
      read(options => this.dailyMessages(start, now, options)),
      read(options => this.unreadConversations(options)),
      read(options => this.mentions(start, now, options)),
      read(options => this.todos(options)),
      mailEnabled ? read(options => this.mail.collect(now, options)) : Promise.resolve([]),
    ]);
    signal?.throwIfAborted();
    const errors = [];
    const failedSources = [];
    const value = (result, label) => {
      if (result.status === "fulfilled") return result.value;
      errors.push(`${label}: ${result.reason.message}`);
      failedSources.push(label);
      return [];
    };
    return {
      items: [
        ...value(dailyMessages, "daily messages"),
        ...value(unread, "unread"),
        ...value(mentions, "mentions"),
        ...value(todos, "todos"),
        ...value(mail, "mail"),
      ],
      errors,
      failedSources,
    };
  }

  async dailyMessages(start, end, options = {}) {
    const data = await this.run("dws", [
      "chat",
      "message",
      "list-all",
      "--start",
      localDateTime(start),
      "--end",
      localDateTime(end),
      "--limit",
      "30",
      "--cursor",
      "0",
      "--format",
      "json",
    ], options);
    return dailyMessageItems(data, end);
  }

  async unreadConversations(options = {}) {
    const data = await this.run("dws", [
      "chat",
      "message",
      "list-unread-conversations",
      "--format",
      "json",
    ], options);
    return (data.result?.conversations || []).map((conversation) => ({
      id: `dingtalk:conversation:${conversation.openConversationId}`,
      kind: "conversation",
      relation: "unread",
      title: conversation.title || "未命名会话",
      unread: conversation.unreadPoint || 0,
      updatedAt: new Date(conversation.lastMsgCreateAt || Date.now()).toISOString(),
      state: "open",
    }));
  }

  async mentions(start, end, options = {}) {
    const data = await this.run("dws", [
      "chat",
      "message",
      "search-advanced",
      "--at-me",
      "--start",
      isoWithOffset(start),
      "--end",
      isoWithOffset(end),
      "--limit",
      "50",
      "--format",
      "json",
    ], options);
    const messages = data.result?.messages || data.result?.list || [];
    return messages.map((message, index) => {
      const id =
        message.msgId ||
        message.messageId ||
        message.openMessageId ||
        `${message.createAt || message.createTime || ""}:${index}`;
      return {
        id: `dingtalk:mention:${id}`,
        kind: "mention",
        relation: "mentioned",
        title: textValue(message).replace(/\s+/g, " ").slice(0, 180),
        author:
          message.senderName ||
          message.sender ||
          message.senderInfo?.name ||
          "",
        context: message.conversationTitle || message.title || "",
        conversationId:
          message.openConversationId ||
          message.conversationId ||
          message.conversationTitle ||
          message.title ||
          "",
        updatedAt:
          message.createAt || message.createTime || new Date().toISOString(),
        state: "open",
      };
    });
  }

  async todos(options = {}) {
    const data = await this.run("dws", [
      "todo",
      "task",
      "list",
      "--page",
      "1",
      "--size",
      "30",
      "--status",
      "false",
      "--format",
      "json",
    ], options);
    return (data.result?.todoCards || []).map((todo) => ({
      id: `dingtalk:todo:${todo.taskId}`,
      kind: "todo",
      relation: "assigned",
      title: todo.subject || todo.title || "未命名待办",
      dueAt: todo.dueTime
        ? new Date(todo.dueTime).toISOString()
        : null,
      updatedAt: todo.modifiedTime
        ? new Date(todo.modifiedTime).toISOString()
        : new Date().toISOString(),
      url: todo.detailUrl || todo.url || "",
      state: "open",
    }));
  }

  async notifySelf(userId, title, message, options = {}) {
    await this.runText(
      "dws",
      [
        "chat",
        "message",
        "send",
        "--user",
        userId,
        "--title",
        title,
        "--text",
        message,
        "--format",
        "json",
      ],
      { timeoutMs: 60_000, ...options },
    );
  }
}
