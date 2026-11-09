import { createHash } from "node:crypto";

const REPORT_TIME_ZONE = "Asia/Shanghai";
const REPORT_SLOTS = Object.freeze([
  Object.freeze({ minuteOfDay: 9 * 60, time: "09:00", kind: "daily_overview" }),
  Object.freeze({ minuteOfDay: 12 * 60, time: "12:00", kind: "progress" }),
  Object.freeze({ minuteOfDay: 15 * 60, time: "15:00", kind: "progress" }),
  Object.freeze({ minuteOfDay: 18 * 60, time: "18:00", kind: "progress" }),
  Object.freeze({ minuteOfDay: 20 * 60, time: "20:00", kind: "daily_close" }),
]);

function localParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("DingTalk report clock is invalid");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, part]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function dueDingTalkReportSlot(now, lastSlotKey = "") {
  const local = localParts(now);
  const slot = [...REPORT_SLOTS]
    .reverse()
    .find((candidate) => candidate.minuteOfDay <= local.minuteOfDay);
  if (!slot) return null;
  const slotKey = `${local.date}@${slot.time}`;
  if (lastSlotKey >= slotKey) return null;
  return Object.freeze({
    slotKey,
    localDate: local.date,
    time: slot.time,
    kind: slot.kind,
    timeZone: REPORT_TIME_ZONE,
  });
}

function text(value, limit = 160) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function reportFingerprint(item) {
  return createHash("sha256")
    .update(JSON.stringify({
      id: item.id,
      title: item.title || "",
      actionRequired: item.actionRequired || "",
      updatedAt: item.updatedAt || "",
      dueAt: item.dueAt || null,
      state: item.state || "",
    }))
    .digest("hex");
}

function reportBaseline(items) {
  return items.map((item) => ({
    id: item.id,
    fingerprint: reportFingerprint(item),
  }));
}

function changedItems(items, previousBaseline) {
  const previous = new Map(
    (Array.isArray(previousBaseline) ? previousBaseline : [])
      .map((entry) => [entry?.id, entry?.fingerprint]),
  );
  return items.filter((item) => previous.get(item.id) !== reportFingerprint(item));
}

function itemLine(item) {
  const label = item.kind === "mail" ? "邮件" : item.kind === "todo"
    ? "待办"
    : item.kind === "mention"
      ? "@我"
      : item.kind === "announcement"
        ? "公告"
        : "会话";
  const content = text(item.actionRequired || item.summary || item.title, 140);
  return `- [${label}] ${content || "有一项新动态"}${item.bodyIncomplete ? "（正文不完整，请到邮箱核对）" : ""}`;
}

function titleFor(slot) {
  if (slot.kind === "daily_overview") return `钉钉每日总览 · ${slot.localDate}`;
  if (slot.kind === "daily_close") return `钉钉今日收口 · ${slot.localDate}`;
  return `钉钉阶段进展 · ${slot.time}`;
}

export function createDingTalkReport(
  dashboard,
  slot,
  previousState = null,
  now = new Date(),
) {
  if (!slot || typeof slot.slotKey !== "string") {
    throw new TypeError("DingTalk report slot is required");
  }
  const items = Array.isArray(dashboard?.groups?.dingtalk)
    ? dashboard.groups.dingtalk
    : [];
  const todos = items.filter((item) => item.kind === "todo");
  const importantConversations = items.filter((item) => item.kind !== "todo");
  const nowMs = new Date(now).getTime();
  const overdue = todos.filter((item) => {
    const dueAt = Date.parse(item.dueAt || "");
    return Number.isFinite(dueAt) && dueAt < nowMs;
  });
  const changed = changedItems(items, previousState?.baseline);
  const featured = (slot.kind === "daily_overview" ? items : changed)
    .slice(0, 6);
  const changeSummary = previousState?.lastSlotKey
    ? `本时段新增或变化 ${changed.length} 项`
    : `当前共 ${items.length} 项行动信号`;
  const summary = slot.kind === "daily_overview"
    ? `今日共有 ${todos.length} 项待办、${overdue.length} 项逾期、${importantConversations.length} 项重要消息。`
    : slot.kind === "daily_close"
      ? `今日收口：${todos.length} 项待办仍开放，${overdue.length} 项已逾期；${changeSummary}。`
      : `${changeSummary}；当前 ${todos.length} 项待办，${overdue.length} 项逾期。`;
  const lines = featured.length
    ? featured.map(itemLine)
    : ["- 本时段没有新增或变化的重点事项。"];
  const message = [
    `## ${titleFor(slot)}`,
    "",
    summary,
    "",
    ...lines,
    "",
    slot.kind === "daily_overview"
      ? "请优先处理逾期待办和明确 @你的事项。"
      : slot.kind === "daily_close"
        ? "请确认未完成事项是否需要顺延到明天。"
        : "完整上下文请打开 Development Intelligence Hub。",
  ].join("\n");
  return Object.freeze({
    schemaVersion: 1,
    reportId: `dingtalk-report-${createHash("sha256")
      .update(slot.slotKey)
      .digest("hex")}`,
    slotKey: slot.slotKey,
    kind: slot.kind,
    time: slot.time,
    timeZone: slot.timeZone,
    title: titleFor(slot),
    summary,
    highlights: featured.map((item) =>
      text(item.actionRequired || item.summary || item.title, 180)
    ),
    message,
    counts: Object.freeze({
      total: items.length,
      todos: todos.length,
      overdue: overdue.length,
      conversations: importantConversations.length,
      mail: items.filter((item) => item.kind === "mail").length,
      changed: changed.length,
    }),
    baseline: Object.freeze(reportBaseline(items)),
    createdAt: new Date(now).toISOString(),
  });
}

export function normalizeDingTalkReportState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schemaVersion: 1,
      revision: 0,
      lastSlotKey: "",
      baseline: [],
      latest: null,
    };
  }
  return {
    schemaVersion: 1,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0,
    lastSlotKey: typeof value.lastSlotKey === "string" ? value.lastSlotKey : "",
    baseline: Array.isArray(value.baseline) ? value.baseline : [],
    latest:
      value.latest && typeof value.latest === "object" ? value.latest : null,
  };
}

export function projectDingTalkReportState(state) {
  if (!state?.latest?.report || typeof state.latest.report !== "object") {
    return null;
  }
  const {
    baseline: _baseline,
    message: _message,
    ...report
  } = state.latest.report;
  return {
    ...report,
    status: state.latest.status,
    ...(state.latest.error ? { error: state.latest.error } : {}),
  };
}
