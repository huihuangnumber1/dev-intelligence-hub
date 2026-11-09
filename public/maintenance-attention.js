import { escapeHtml } from "./view-format.js";

const labels = {
  STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED: "会话保存或恢复故障",
  STRUCTURED_PROVIDER_CLEANUP_FAILED: "运行环境清理失败",
  STRUCTURED_PROVIDER_REAP_FAILED: "CLI 进程未能安全结束",
};

export function maintenanceAttentionMarkup({ items = [], total = 0, loaded = false, error = "" } = {}) {
  const groups = new Map();
  for (const item of items) {
    const code = item.maintenanceCode;
    if (!labels[code]) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(item);
  }
  return `<section class="section" aria-labelledby="maintenance-attention-title">
    <div class="section-heading"><h2 id="maintenance-attention-title">系统故障 · 待维护</h2><span>${escapeHtml(total)} 项受影响任务</span></div>
    <p>同类故障集中显示，不再逐项弹窗。原任务和会话保留；这里不会自动重试或写入 GitHub。</p>
    ${error ? `<p class="employee-error" role="status">${escapeHtml(error)}；当前显示的是上次读取结果。</p>` : ""}
    ${[...groups].map(([code, requests]) => `<details><summary>${escapeHtml(labels[code])} · ${requests.length} 项</summary>
      <p>请维护人员排查根因，确认修复后再重试受影响任务。</p>
      ${requests.map((item) => `<p><strong>${escapeHtml(item.producer?.roleId || "未知岗位")}</strong> · ${escapeHtml(item.context?.find(({ label }) => label === "来源事件")?.value || item.producer?.workItemId || "任务")}
        <button class="secondary-button" data-maintenance-attention="${escapeHtml(item.requestId)}">查看故障</button></p>`).join("")}
    </details>`).join("")}
    ${total > items.length ? `<p>当前展示前 ${items.length} 项，共 ${escapeHtml(total)} 项。</p>` : ""}
    ${!items.length && !error ? `<div class="empty">${loaded ? "没有待维护的系统故障。" : "正在读取系统故障…"}</div>` : ""}
    <button class="secondary-button" data-maintenance-reload>重新读取</button>
  </section>`;
}
