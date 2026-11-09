function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncateUtf8(value, maximumBytes) {
  const encoder = new TextEncoder();
  const text = String(value || "");
  if (encoder.encode(text).length <= maximumBytes) return text;
  let result = "";
  for (const character of text) {
    if (encoder.encode(result + character).length > maximumBytes) break;
    result += character;
  }
  return result;
}

const WORK_TYPE_LABELS = Object.freeze({
  pull_request: "PR Review / 推进",
  development: "开发实现",
  testing: "测试验证",
  requirements: "需求梳理",
  general: "中枢协调拆分",
});

function option(value, selected) {
  return `<option value="${value}"${selected === value ? " selected" : ""}>${WORK_TYPE_LABELS[value]}</option>`;
}

function reviewPurposeControl() {
  return `<label>PR 评审方式<select name="reviewPurpose">
    <option value="standard_current_pr_code_review/v1">复用已核实的评审</option>
    <option value="independent_review/v1">独立重新评审</option>
  </select></label>`;
}

function invalidGitHubWorkUrl() {
  return new TypeError("GitHub PR 或 Issue 地址无效");
}

export function githubWorkItemFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw invalidGitHubWorkUrl();
  }
  if (
    url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
    url.username || url.password
  ) {
    throw invalidGitHubWorkUrl();
  }
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)\/?$/u,
  );
  if (!match) throw invalidGitHubWorkUrl();
  const [, owner, repository, resource, numberText] = match;
  if ([owner, repository].some((segment) =>
    segment === "." || segment === ".." || segment.length > 100
  )) {
    throw invalidGitHubWorkUrl();
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) throw invalidGitHubWorkUrl();
  const repo = `${owner}/${repository}`;
  const kind = resource === "pull" ? "pull_request" : "issue";
  return {
    id: `github:${kind === "pull_request" ? "pr" : "issue"}:${repo}#${number}`,
    kind,
    repo,
    number,
    title: `${repo} #${number}`,
    url: `https://github.com/${repo}/${resource}/${number}`,
    summary: "由你通过 GitHub 地址人工加入日常任务",
  };
}

export function manualHistoricalWorkMarkup(result = null) {
  if (result) {
    return `<section class="section manual-historical-work" data-manual-historical-work-result>
      <div class="section-heading"><h2>已加入日常任务</h2><span>OWNER OVERRIDE</span></div>
      <p>${escapeHtml(result.source || "GitHub 任务")} 已进入共享任务图，将由 ${escapeHtml(result.target || "配置的岗位")} 领取。</p>
      <small>工作项 ${escapeHtml(result.workItemId || "正在接入台账")} · 请求 ${escapeHtml(result.requestId)}</small>
      <button type="button" class="secondary-button" data-manual-historical-work-reset>继续添加</button>
    </section>`;
  }
  return `<section class="section manual-historical-work">
    <div class="section-heading"><h2>人工加入历史任务</h2><span>OWNER OVERRIDE</span></div>
    <p>自动范围外的 GitHub PR 或 Issue 可以显式加入日常任务；这不会扩大自动扫描范围。</p>
    <small>PR Review、开发和测试需要 PR 处于 OPEN 状态并能读取当前 Git 目标；已关闭或已合并的 PR 可选择需求梳理或中枢协调。</small>
    <form data-manual-historical-work>
      <label class="manual-historical-work-source">GitHub 地址
        <input name="sourceUrl" type="url" required autocomplete="url" placeholder="https://github.com/org/repo/pull/123 或 /issues/123">
      </label>
      <label>交付类型
        <select name="workType">
          ${option("pull_request", "pull_request")}
          ${option("development")}
          ${option("testing")}
          ${option("requirements")}
          ${option("general")}
        </select>
      </label>
      <label>优先级
        <select name="priority">
          <option value="normal">普通</option>
          <option value="high" selected>高</option>
          <option value="urgent">紧急</option>
        </select>
      </label>
      ${reviewPurposeControl()}
      <button class="refresh-button" type="submit">加入日常任务</button>
      <p class="manual-work-assignment-status" data-manual-historical-work-status aria-live="polite"></p>
    </form>
  </section>`;
}

export function manualWorkAssignmentMarkup(item, result = null) {
  if (!item || !["pull_request", "issue"].includes(item.kind)) return "";
  if (result) {
    return `<section class="manual-work-assignment" data-manual-work-assignment-result>
      <h3>已分配工作</h3>
      <p>请求已进入共享任务图，将由 ${escapeHtml(result.target || "配置的岗位")} 领取。</p>
      <small>工作项 ${escapeHtml(result.workItemId || "正在接入台账")} · 请求 ${escapeHtml(result.requestId)}</small>
    </section>`;
  }
  const closedPullRequest = item.kind === "pull_request" &&
    ["closed", "merged"].includes(String(item.state || "").toLowerCase());
  const selected = item.kind === "pull_request" && !closedPullRequest
    ? "pull_request" : "requirements";
  return `<section class="manual-work-assignment">
    <h3>手动分配工作</h3>
    <p>${closedPullRequest
      ? "此 PR 已关闭或已合并，可创建需求梳理或中枢协调任务。"
      : "创建真实共享任务；岗位权限、代码执行和 GitHub 写入仍受现有门禁约束。"}</p>
    <form data-manual-work-assignment>
      <label>交付类型
        <select name="workType">
          ${item.kind === "pull_request" && !closedPullRequest ? option("pull_request", selected) : ""}
          ${closedPullRequest ? "" : option("development", selected)}
          ${closedPullRequest ? "" : option("testing", selected)}
          ${option("requirements", selected)}
          ${option("general", selected)}
        </select>
      </label>
      <label>优先级
        <select name="priority">
          <option value="normal">普通</option>
          <option value="high" selected>高</option>
          <option value="urgent">紧急</option>
        </select>
      </label>
      ${item.kind === "pull_request" && !closedPullRequest ? reviewPurposeControl() : ""}
      <button class="refresh-button" type="submit">创建并分配</button>
      <p class="manual-work-assignment-status" data-manual-work-assignment-status aria-live="polite"></p>
    </form>
  </section>`;
}

export function ownerWorkRequestForItem(
  item,
  { workType, priority, requestId, responsiblePerson = null, reviewPurpose = "standard_current_pr_code_review/v1" },
) {
  if (!item || !["pull_request", "issue"].includes(item.kind)) {
    throw new TypeError("GitHub work item is required");
  }
  if (!Object.hasOwn(WORK_TYPE_LABELS, workType)) {
    throw new TypeError("workType is invalid");
  }
  const source = item.url || (
    item.repo && item.number
      ? `https://github.com/${item.repo}/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`
      : ""
  );
  const assignedLogin = responsiblePerson?.login
    ? String(responsiblePerson.login)
    : "";
  const title = truncateUtf8(
    `${WORK_TYPE_LABELS[workType]}${assignedLogin ? `（负责人 @${assignedLogin}）` : ""}：${item.title || `${item.repo} #${item.number}`}`,
    256,
  );
  const description = truncateUtf8([
    `请处理 GitHub ${item.kind === "pull_request" ? "PR" : "Issue"}：${item.repo || ""} #${item.number || ""}。`,
    source ? `原始地址：${source}` : "",
    item.summary ? `当前摘要：${item.summary}` : `当前标题：${item.title || ""}`,
    assignedLogin
      ? `${workType === "testing" ? "指定测试负责人" : "指定负责人"}：@${assignedLogin}（${responsiblePerson.product || "未分类版本"}）。`
      : "",
    "基于来源的最新事实完成所选交付，并在共享任务图中留下可验证结果。",
  ].filter(Boolean).join("\n"), 12 * 1024);
  const request = {
    schemaVersion:
      item.kind === "pull_request" &&
      ["pull_request", "development", "testing"].includes(workType) &&
      !assignedLogin
        ? 2
        : item.kind === "issue"
        ? 6
        : assignedLogin ? workType === "testing" ? 3 : 4 : 1,
    requestId,
    workType,
    priority,
    title,
    description,
    acceptanceCriteria: [
      "核对来源 GitHub 项目的最新状态与上下文",
      `提交可验证的${WORK_TYPE_LABELS[workType]}结果`,
      ...(assignedLogin
        ? [`${WORK_TYPE_LABELS[workType]}结果明确交付给 @${assignedLogin}`]
        : []),
    ],
  };
  if ([2, 3, 4].includes(request.schemaVersion)) {
    request.pullRequest = { repository: item.repo, number: item.number };
  }
  if (workType === "pull_request" && [2, 4].includes(request.schemaVersion)) {
    if (!["standard_current_pr_code_review/v1", "independent_review/v1"].includes(reviewPurpose)) throw new TypeError("reviewPurpose is invalid");
    request.reviewPurpose = reviewPurpose;
  }
  if (request.schemaVersion === 6) {
    request.issue = { repository: item.repo, number: item.number };
  }
  if ([3, 4].includes(request.schemaVersion)) {
    request.responsiblePerson = {
      login: assignedLogin,
      product: String(responsiblePerson.product || "general"),
    };
  }
  return request;
}

export function createManualWorkAssignmentAttempts(createRequestId = () => crypto.randomUUID()) {
  const pending = new Map();
  return {
    requestFor(item, { workType, priority, reviewPurpose }) {
      const purpose = workType === "pull_request" ? reviewPurpose ?? "standard_current_pr_code_review/v1" : undefined;
      const key = JSON.stringify([item.kind, item.repo, item.number, workType, priority, purpose]);
      if (!pending.has(key)) {
        pending.set(key, ownerWorkRequestForItem(item, {
          workType, priority, reviewPurpose: purpose, requestId: createRequestId(),
        }));
      }
      // Keep the whole payload, not only the ID: refreshed titles/summaries
      // must not conflict with the server's durable idempotency binding.
      return structuredClone(pending.get(key));
    },
    complete(requestId) {
      for (const [key, request] of pending) {
        if (request.requestId === requestId) pending.delete(key);
      }
    },
  };
}

const ROLE_LABELS = Object.freeze({
  "pr-engineer": "PR 工程师",
  developer: "开发工程师",
  tester: "测试工程师",
  "requirements-analyst": "需求分析师",
  orchestrator: "主控调度员",
});

const ASSIGNMENT_STATUS_LABELS = Object.freeze({
  queued: "等待岗位领取", working: "处理中", paused: "已暂停",
  retry_wait: "等待重试", dispatch_pending: "等待执行",
  waiting_user: "等待你答复", waiting_external: "等待外部结果",
  waiting_condition: "等待条件", blocked: "已阻塞", completed: "已完成",
  cancelled: "已取消", superseded: "已被替代",
});

function retiredAssignmentProgress(progress) {
  return ["pr_source_cross_root_cutover_retired", "pr_source_authority_fenced"].includes(progress?.statusReason);
}

function historicalAssignment(record) {
  const progress = record.progress;
  return ["completed", "cancelled", "superseded"].includes(progress?.status) ||
    retiredAssignmentProgress(progress);
}

function assignmentProgressLabel(record) {
  if (record.phase !== "intaken") return "请求已保存，等待接入台账";
  const progress = record.progress;
  if (!progress) return "台账状态暂不可用";
  const reason = progress.statusReason || "";
  if (retiredAssignmentProgress(progress)) return "已停用";
  if (reason.startsWith("pr_source_cross_root_cutover_pending:")) return "等待旧任务交接";
  if (reason.startsWith("pr_source_cross_root_cutover_blocker:")) return "旧任务等待结束后交接";
  const label = ASSIGNMENT_STATUS_LABELS[progress.status] || "状态暂不可用";
  return progress.status === "blocked" && reason ? `${label}（${reason}）` : label;
}

function assignmentTimesMarkup(record) {
  return [["创建于", record.createdAt], ["更新于", record.updatedAt]].flatMap(([label, value]) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return [];
    return [`${label} <time datetime="${escapeHtml(value)}">${escapeHtml(new Date(value).toLocaleString("zh-CN", { hour12: false }))}</time>`];
  }).join(" · ");
}

function assignmentRecordMarkup(record) {
  const target = record.progress?.currentTarget?.id || record.assignment?.target?.id;
  const times = assignmentTimesMarkup(record);
  return `<p><strong>${escapeHtml(WORK_TYPE_LABELS[record.request?.workType] || "工作任务")}</strong> · ${escapeHtml(ROLE_LABELS[target] || target || "等待岗位分派")}<br>
        <span>${escapeHtml(assignmentProgressLabel(record))}</span><br>
        ${times ? `<small>${times}</small><br>` : ""}
        <small>工作项 ${escapeHtml(record.workItemId || "待生成")} · 请求 ${escapeHtml(record.requestId)}</small></p>
        ${record.phase !== "intaken" ? `<form data-manual-work-assignment-resume="${escapeHtml(record.requestId)}">
          <button class="secondary-button" type="submit">继续原分配</button>
          <p data-manual-work-assignment-status aria-live="polite"></p>
        </form>` : ""}`;
}

function assignmentHistoryMarkup(item, records) {
  if (!records.length) return manualWorkAssignmentMarkup(item);
  const current = records.filter((record) => !historicalAssignment(record));
  const history = records.filter(historicalAssignment);
  return `<section class="manual-work-assignment" data-manual-work-assignment-result>
    <h3>${records.some((record) => record.phase === "intaken") ? "已分配工作" : "分配请求已保存"}</h3>
    <h4>当前分配</h4>
    ${current.length ? current.map(assignmentRecordMarkup).join("") : "<p>当前没有进行中的分配请求。</p>"}
    ${history.length ? `<details data-assignment-history><summary>历史分配（${history.length}）</summary>${history.map(assignmentRecordMarkup).join("")}</details>` : ""}
    <p>可在左侧“工作台账”查看任务进度；已分配不代表已完成。</p>
    <details>
      <summary>另行分配工作</summary>
      <p>这会额外创建一个任务，不会修改已有分配。请确认是否确实需要。</p>
      ${manualWorkAssignmentMarkup(item)}
    </details>
  </section>`;
}

async function readAssignments(item, fetchImpl) {
  const source = githubWorkItemFromUrl(item.url ||
    `https://github.com/${item.repo}/${item.kind === "pull_request" ? "pull" : "issues"}/${item.number}`);
  const records = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ sourceUrl: source.url, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchImpl(`/api/work/requests?${query}`, {
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("读取分配记录失败");
    const page = await response.json();
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

export async function bindManualWorkAssignment(container, item, { fetchImpl = fetch, attempts } = {}) {
  if (!container || !["pull_request", "issue"].includes(item?.kind)) return;
  container.innerHTML = '<p aria-live="polite">正在读取分配记录…</p>';
  function render(records) {
    if (!container.isConnected) return;
    container.innerHTML = assignmentHistoryMarkup(item, records);
    for (const form of container.querySelectorAll("[data-manual-work-assignment], [data-manual-work-assignment-resume]")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        if (button.disabled) return;
        const status = form.querySelector("[data-manual-work-assignment-status]");
        button.disabled = true;
        status.textContent = "正在创建共享任务…";
        let request;
        try {
          const resumeId = form.dataset?.manualWorkAssignmentResume;
          request = resumeId
            ? records.find((record) => record.requestId === resumeId)?.request
            : attempts.requestFor(item, {
              workType: form.elements.namedItem("workType").value,
              priority: form.elements.namedItem("priority").value,
              reviewPurpose: form.elements.namedItem("reviewPurpose")?.value,
            });
          if (!request) throw new Error("原分配请求不可用，请重新打开详情");
          const response = await fetchImpl("/api/work/requests", {
            method: "POST",
            headers: { "content-type": "application/json", "x-mydashboard-action": "1" },
            body: JSON.stringify(request),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || `分配失败（${response.status}）`);
          attempts.complete(request.requestId);
          render([
            { ...result, request: result.request || request },
            ...records.filter((record) => record.requestId !== result.requestId),
          ]);
        } catch (error) {
          status.textContent = `${error.message || "分配失败"}${request
            ? ` 本页重试会继续原请求（${request.requestId}）。` : ""}`;
          if (request) button.textContent = "重试原请求";
          button.disabled = false;
        }
      });
    }
  }
  try {
    render(await readAssignments(item, fetchImpl));
  } catch {
    if (!container.isConnected) return;
    container.innerHTML = `<section class="manual-work-assignment">
      <p role="status">未能读取分配记录，请重试后再分配。</p>
      <button type="button" class="secondary-button" data-manual-assignment-reload>重新读取</button>
    </section>`;
    container.querySelector("[data-manual-assignment-reload]")?.addEventListener("click", () => {
      void bindManualWorkAssignment(container, item, { fetchImpl, attempts });
    });
  }
}
