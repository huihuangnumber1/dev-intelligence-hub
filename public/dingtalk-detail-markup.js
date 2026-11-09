function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function messageMarkup(message) {
  const author = message.author ? `<strong>${escapeHtml(message.author)}</strong> · ` : "";
  const timestamp = message.updatedAt
    ? new Date(message.updatedAt).toLocaleString("zh-CN")
    : "";
  return `<li>${author}${escapeHtml(message.content)}${timestamp ? `<small>${escapeHtml(timestamp)}</small>` : ""}</li>`;
}

export function dingtalkDetailMarkup(item) {
  if (!item?.summaryStatus) return "";
  const highlights = (item.highlights || [])
    .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
    .join("");
  const sourceMessages = (item.sourceMessages || [])
    .slice(0, item.kind === "mail" ? undefined : 12)
    .map(messageMarkup)
    .join("");
  return `
    <section class="dingtalk-digest-detail">
      <div class="dingtalk-digest-block">
        <h3>总结</h3>
        <p>${escapeHtml(item.summary || item.title)}</p>
        ${item.bodyIncomplete ? "<p>部分邮件正文不完整，请在邮箱核对完整内容与附件。</p>" : ""}
      </div>
      ${highlights ? `<div class="dingtalk-digest-block"><h3>关键信息</h3><ul>${highlights}</ul></div>` : ""}
      <div class="dingtalk-digest-block dingtalk-action-required">
        <h3>需要你处理</h3>
        <p>${escapeHtml(item.actionRequired || "当前没有识别到明确需要你执行的动作。")}</p>
      </div>
      ${sourceMessages ? `<details class="dingtalk-source-messages"><summary>查看依据消息（${item.messageCount || item.sourceMessages.length} 条）</summary><ol>${sourceMessages}</ol></details>` : ""}
    </section>`;
}
