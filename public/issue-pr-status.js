function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prStateLabel(state) {
  return {
    open: "进行中",
    closed: "已关闭",
    merged: "已合并",
  }[state] || "状态待核对";
}

function prUrl(link) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(link.repo || "") ||
    !Number.isSafeInteger(link.number) || link.number < 1
  ) return "";
  return `https://github.com/${link.repo}/pull/${link.number}`;
}

export function issuePrSummary(item) {
  if (item?.kind !== "issue") return null;
  const evidence = item.pullRequestLinks;
  if (!evidence || !Array.isArray(evidence.links)) {
    return { label: "PR 关联待刷新", closeAdvice: "待核对", links: [] };
  }
  const links = evidence.links;
  const formal = links.filter((link) => link.relation === "formal");
  const mentions = links.filter((link) => link.relation === "mention");
  let label;
  let closeAdvice;
  if (formal.some((link) => link.state === "open")) {
    label = "关联 PR 进行中";
    closeAdvice = "先等 PR 完成，再核对问题";
  } else if (formal.some((link) => link.state === "closed")) {
    label = "关联 PR 已关闭";
    closeAdvice = "核对是否仍需修复";
  } else if (formal.length && formal.every((link) => link.state === "merged")) {
    label = "关联 PR 已合并，待验收";
    closeAdvice = "验收通过后可关闭";
  } else if (formal.length) {
    label = "关联 PR 状态待核对";
    closeAdvice = "核对 PR 和验收结果";
  } else if (mentions.length) {
    label = "有 PR 提及，待核对";
    closeAdvice = "先确认 PR 是否解决此问题";
  } else {
    label = evidence.complete ? "未发现关联 PR" : "PR 关联未查全";
    closeAdvice = "根据问题验收结果判断";
  }
  if (!evidence.complete && links.length) {
    label += "（部分记录）";
    closeAdvice = "先核对未读到的 PR，再验收";
  }
  return { label, closeAdvice, links };
}

export function issuePrDetailMarkup(item) {
  const summary = issuePrSummary(item);
  if (!summary) return "";
  const links = summary.links.map((link) => `
    <li>
      ${prUrl(link)
        ? `<a href="${escapeHtml(prUrl(link))}" target="_blank" rel="noreferrer">${escapeHtml(link.repo)} #${link.number}</a>`
        : `${escapeHtml(link.repo)} #${escapeHtml(link.number)}`}
      · ${link.relation === "formal" ? "正式关联" : "仅提及"} · ${prStateLabel(link.state)}
      ${link.title ? `<span>${escapeHtml(link.title)}</span>` : ""}
    </li>`).join("");
  return `<section class="github-detail-section issue-pr-status">
    <div class="github-detail-heading"><h3>Issue 与 PR</h3><span>${escapeHtml(summary.label)}</span></div>
    ${links ? `<ul>${links}</ul>` : `<p>当前快照中没有可展示的 PR。</p>`}
    <p><strong>能否关闭：</strong>${escapeHtml(summary.closeAdvice)}。PR 关联或合并本身不能证明问题完全解决；请核对验收结果。</p>
  </section>`;
}
