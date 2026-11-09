const dryRunExample = JSON.stringify(
  {
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T08:00:00.000Z",
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: {
      id: "github:pr:owner/repo#123",
      repository: "owner/repo",
      number: 123,
    },
    payload: { author: "octocat", labels: ["review"], state: "open" },
  },
  null,
  2,
);

const OWNER_PENDING_REQUEST_KEY = "mydashboard:owner-work-request-pending:v1";

function currentTabStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function clearPendingOwnerRequest(storage) {
  try {
    storage?.removeItem(OWNER_PENDING_REQUEST_KEY);
  } catch {
    // The in-memory retry remains available if tab storage is unavailable.
  }
}

function storedPendingOwnerRequest(storage) {
  let serialized;
  try {
    serialized = storage?.getItem(OWNER_PENDING_REQUEST_KEY);
  } catch {
    return null;
  }
  if (!serialized) return null;
  try {
    if (serialized.length > 72 * 1024) throw new TypeError("pending request is too large");
    const request = JSON.parse(serialized);
    const hasPullRequest = request?.schemaVersion === 2;
    const keys = [
      "schemaVersion", "requestId", "workType", "priority", "title",
      "description", "acceptanceCriteria",
      ...(hasPullRequest ? ["pullRequest"] : []),
    ];
    if (
      !request || typeof request !== "object" || Array.isArray(request) ||
      ![1, 2].includes(request.schemaVersion) ||
      Object.keys(request).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(request, key)) ||
      typeof request.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(request.requestId) ||
      !["general", "requirements", "development", "testing", "pull_request"].includes(request.workType) ||
      (hasPullRequest !== (request.workType === "pull_request")) ||
      !["normal", "high", "urgent"].includes(request.priority) ||
      typeof request.title !== "string" ||
      typeof request.description !== "string" ||
      !Array.isArray(request.acceptanceCriteria) ||
      request.acceptanceCriteria.some((criterion) => typeof criterion !== "string") ||
      (hasPullRequest && (
        !request.pullRequest ||
        typeof request.pullRequest !== "object" ||
        Array.isArray(request.pullRequest) ||
        Object.keys(request.pullRequest).length !== 2 ||
        typeof request.pullRequest.repository !== "string" ||
        !Number.isSafeInteger(request.pullRequest.number) ||
        request.pullRequest.number < 1
      ))
    ) {
      throw new TypeError("pending request is invalid");
    }
    return request;
  } catch {
    clearPendingOwnerRequest(storage);
    return null;
  }
}

function savePendingOwnerRequest(storage, request) {
  if (!storage) return typeof globalThis.document === "undefined";
  try {
    storage.setItem(OWNER_PENDING_REQUEST_KEY, JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}

function emptyOwnerDraft() {
  return {
    workType: "general",
    priority: "normal",
    title: "",
    description: "",
    acceptanceCriteria: "",
    pullRequestRepository: "",
    pullRequestNumber: "",
  };
}

function initialState(requestIdFactory, pendingRequest = null) {
  return {
    loaded: false,
    loading: false,
    error: "",
    routing: null,
    assignments: [],
    audit: [],
    dryRunInput: dryRunExample,
    dryRunLoading: false,
    dryRunResult: null,
    dryRunError: "",
    ownerRequestId: pendingRequest?.requestId || requestIdFactory(),
    ownerDraft: pendingRequest ? {
      workType: pendingRequest.workType,
      priority: pendingRequest.priority,
      title: pendingRequest.title,
      description: pendingRequest.description,
      acceptanceCriteria: pendingRequest.acceptanceCriteria.join("\n"),
      pullRequestRepository: pendingRequest.pullRequest?.repository || "",
      pullRequestNumber: pendingRequest.pullRequest
        ? String(pendingRequest.pullRequest.number) : "",
    } : emptyOwnerDraft(),
    ownerPendingRequest: pendingRequest,
    ownerRequestLoading: false,
    ownerRequestResult: null,
    ownerRequestError: "",
  };
}

export function escapeWorkflowHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function relativeTime(value, now) {
  if (!value) return "未知时间";
  const seconds = Math.round((now - Date.parse(value)) / 1000);
  if (Math.abs(seconds) < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function targetLabel(target = {}) {
  const type = {
    role: "岗位",
    person: "人员",
    node: "节点",
  }[target.type] || target.type || "目标";
  return `${type} · ${target.id || "未命名"}`;
}

function subjectLabel(subject = {}) {
  const repository = subject.repository || subject.id || "未知对象";
  return subject.number ? `${repository} #${subject.number}` : repository;
}

export function workflowExplanationLines(explanation) {
  if (!explanation) return [];
  if (typeof explanation === "string") return [explanation];
  if (Array.isArray(explanation)) {
    return explanation.flatMap(workflowExplanationLines);
  }
  if (typeof explanation !== "object") return [String(explanation)];

  if (Array.isArray(explanation.rules)) {
    const statusLabels = {
      matched: "命中",
      condition_not_matched: "条件未命中",
      disabled: "规则停用",
      source_mismatch: "来源节点不匹配",
      skipped_after_stop: "已被前序停止规则跳过",
      fallback_not_needed: "无需兜底",
      routing_disabled: "路由停用",
    };
    const rules = explanation.rules.map((rule) => {
      const status = statusLabels[rule.status] || rule.status || "未知结果";
      return `${rule.ruleId || "未命名规则"}：${status}`;
    });
    if (explanation.usedFallback) rules.push("本次使用了兜底规则");
    return rules;
  }

  try {
    return [JSON.stringify(explanation)];
  } catch {
    return ["路由解释无法显示"];
  }
}

function ruleRows(rules = []) {
  if (!rules.length) {
    return '<div class="empty">当前配置没有路由规则，事件将保持未匹配。</div>';
  }
  return `<div class="workflow-list">${rules
    .map(
      (rule) => `
        <article class="workflow-row">
          <div class="workflow-row-heading">
            <strong>${escapeWorkflowHtml(rule.id)}</strong>
            <span class="status-pill ${rule.enabled ? "" : "status-disabled"}">${rule.enabled ? "启用" : "停用"}</span>
          </div>
          <p>${rule.fallback ? "兜底规则" : `优先级 ${escapeWorkflowHtml(rule.priority)}`} · ${escapeWorkflowHtml(rule.onMatch === "continue" ? "命中后继续" : "命中后停止")}</p>
          <span>来源 ${escapeWorkflowHtml(rule.source)} → ${escapeWorkflowHtml((rule.targets || []).map(targetLabel).join("、") || "无目标")}</span>
          ${rule.condition ? `<code>${escapeWorkflowHtml(JSON.stringify(rule.condition))}</code>` : ""}
        </article>`,
    )
    .join("")}</div>`;
}

function assignmentRows(assignments, now) {
  if (!assignments.length) {
    return '<div class="empty">尚无分派记录；健康数据源产生的新事件会出现在这里。</div>';
  }
  return `<div class="workflow-list">${assignments
    .map(
      (assignment) => `
        <article class="workflow-row workflow-assignment">
          <div class="workflow-row-heading">
            <strong>${escapeWorkflowHtml(subjectLabel(assignment.subject))}</strong>
            <span>${relativeTime(assignment.createdAt, now)}</span>
          </div>
          <p>${escapeWorkflowHtml(targetLabel(assignment.target))}</p>
          <span>${escapeWorkflowHtml(assignment.eventType)} · 规则 ${escapeWorkflowHtml(assignment.ruleId)} · 配置 v${escapeWorkflowHtml(assignment.configVersion)}</span>
          <small>${escapeWorkflowHtml(assignment.reason || "规则已匹配")}</small>
        </article>`,
    )
    .join("")}</div>`;
}

function auditRows(audit, now) {
  if (!audit.length) {
    return '<div class="empty">尚无审计记录；未匹配事件也会保留解释。</div>';
  }
  return `<div class="workflow-list">${audit
    .map((entry) => {
      const explanations = workflowExplanationLines(entry.explanation);
      return `
        <article class="workflow-row workflow-audit ${entry.outcome === "unmatched" ? "is-unmatched" : ""}">
          <div class="workflow-row-heading">
            <strong>${escapeWorkflowHtml(subjectLabel(entry.subject))}</strong>
            <span class="status-pill ${entry.outcome === "unmatched" ? "status-waiting_user" : ""}">${escapeWorkflowHtml(entry.outcome || "unknown")}</span>
          </div>
          <p>${entry.assignmentIds?.length ? `${entry.assignmentIds.length} 条分派` : "没有产生分派"} · ${relativeTime(entry.createdAt, now)}</p>
          <span>${escapeWorkflowHtml(entry.eventType)} · 命中 ${escapeWorkflowHtml((entry.matchedRuleIds || []).join("、") || "无规则")}</span>
          <small>${escapeWorkflowHtml(explanations.join("；") || "路由器未提供进一步解释")}</small>
        </article>`;
    })
    .join("")}</div>`;
}

function dryRunResult(state) {
  if (state.dryRunError) {
    return `<p class="workflow-inline-error" role="alert">${escapeWorkflowHtml(state.dryRunError)}</p>`;
  }
  if (!state.dryRunResult) {
    return '<p class="workflow-help">输入一个事件后可查看它会命中哪个岗位；模拟不会写入分派或审计。</p>';
  }
  const result = state.dryRunResult;
  const explanations = workflowExplanationLines(result.explanation);
  return `
    <div class="workflow-dry-run-result">
      <strong>模拟结果：${escapeWorkflowHtml(result.outcome || "unknown")}</strong>
      <span>${escapeWorkflowHtml(result.assignments?.length ? result.assignments.map((item) => targetLabel(item.target)).join("、") : "没有产生分派")}</span>
      <small>${escapeWorkflowHtml(explanations.join("；") || "没有进一步解释")}</small>
    </div>`;
}

function selectedOption(value, expected) {
  return value === expected ? " selected" : "";
}

function ownerRequestFeedback(state) {
  if (state.ownerRequestError) {
    return `<p class="workflow-inline-error" role="alert">${escapeWorkflowHtml(state.ownerRequestError)}</p>`;
  }
  const result = state.ownerRequestResult;
  if (!result) {
    if (state.ownerPendingRequest) {
      return '<p class="workflow-help">上次请求的结果尚未确认。重试会使用相同请求标识和内容；开始新请求会创建另一项任务。</p>';
    }
    return '<p class="workflow-help">请求会先写入本地审计，再经可信路由进入唯一共享任务图；提交不会授予代码或 GitHub 权限。</p>';
  }
  return `<div class="workflow-dry-run-result" role="status">
    <strong>${result.deduplicated ? "请求已存在，已返回同一任务" : "已进入共享任务图"}</strong>
    <span>${escapeWorkflowHtml(targetLabel(result.assignment?.target))} · ${escapeWorkflowHtml(result.phase || "unknown")}</span>
    <small>请求 ${escapeWorkflowHtml(result.requestId)} · 工作项 ${escapeWorkflowHtml(result.workItemId || "等待台账接收")}</small>
  </div>`;
}

function ownerRequestPanel(state) {
  const draft = state.ownerDraft || emptyOwnerDraft();
  const loading = state.ownerRequestLoading === true;
  const pending = Boolean(state.ownerPendingRequest);
  const fieldsDisabled = loading || pending;
  return `<section class="section workflow-panel workflow-owner-request">
    <div class="section-heading"><h2>创建共享工作</h2><span>OWNER → ROUTER → ORCHESTRATOR</span></div>
    <p class="workflow-safety-note">这里只收集业务目标。岗位、内部节点、工具与权限由可信配置决定，页面不能指定。</p>
    <form id="owner-work-request-form" class="workflow-owner-form">
      <div class="workflow-owner-fields">
        <label>工作类型
          <select name="workType"${fieldsDisabled ? " disabled" : ""}>
            <option value="general"${selectedOption(draft.workType, "general")}>综合协调</option>
            <option value="requirements"${selectedOption(draft.workType, "requirements")}>需求梳理</option>
            <option value="development"${selectedOption(draft.workType, "development")}>开发实现</option>
            <option value="testing"${selectedOption(draft.workType, "testing")}>测试验收</option>
            <option value="pull_request"${selectedOption(draft.workType, "pull_request")}>PR 推进</option>
          </select>
        </label>
        <label>优先级
          <select name="priority"${fieldsDisabled ? " disabled" : ""}>
            <option value="normal"${selectedOption(draft.priority, "normal")}>普通</option>
            <option value="high"${selectedOption(draft.priority, "high")}>高</option>
            <option value="urgent"${selectedOption(draft.priority, "urgent")}>紧急</option>
          </select>
        </label>
      </div>
      <fieldset class="workflow-owner-pr-target">
        <legend>指定 PR（工作类型选择“PR 推进”时必填）</legend>
        <div class="workflow-owner-fields">
          <label>仓库
            <input name="pullRequestRepository" maxlength="140" value="${escapeWorkflowHtml(draft.pullRequestRepository)}" placeholder="owner/repository"${fieldsDisabled ? " disabled" : ""} />
          </label>
          <label>PR 编号
            <input name="pullRequestNumber" type="number" min="1" step="1" value="${escapeWorkflowHtml(draft.pullRequestNumber)}" placeholder="123"${fieldsDisabled ? " disabled" : ""} />
          </label>
        </div>
        <small>系统会用当前 GitHub 登录读取并冻结这一 PR 的当前 Head；不会因此直接评论、Review、push 或 merge。</small>
      </fieldset>
      <label>标题
        <input name="title" maxlength="256" required value="${escapeWorkflowHtml(draft.title)}" placeholder="一句话说明要完成什么"${fieldsDisabled ? " disabled" : ""} />
      </label>
      <label>目标与背景
        <textarea name="description" maxlength="12288" required placeholder="说明结果、约束和必要背景"${fieldsDisabled ? " disabled" : ""}>${escapeWorkflowHtml(draft.description)}</textarea>
      </label>
      <label>验收条件（每行一条，最多 20 条，每条最多 1000 字节）
        <textarea name="acceptanceCriteria" maxlength="20019" placeholder="例如：真实浏览器验证通过"${fieldsDisabled ? " disabled" : ""}>${escapeWorkflowHtml(draft.acceptanceCriteria)}</textarea>
      </label>
      <button class="refresh-button" type="submit"${loading ? " disabled" : ""}>${loading ? "正在创建…" : pending ? "重试原请求" : "创建并交给中枢"}</button>
      ${pending ? `<button class="secondary-button" type="button" data-owner-request-new${loading ? " disabled" : ""}>开始新请求</button>` : ""}
    </form>
    ${ownerRequestFeedback(state)}
  </section>`;
}

export function renderWorkflowView(state, { now = Date.now() } = {}) {
  if (!state.loaded) {
    return '<div class="empty">正在读取工作流配置与路由记录…</div>';
  }
  if (state.error) {
    return `<section class="section workflow-error-state">
      <div class="section-heading"><h2>工作流暂不可用</h2><span>READ FAILED</span></div>
      <div class="empty">${escapeWorkflowHtml(state.error)}。请刷新页面后重试。</div>
    </section>`;
  }

  const current = state.routing?.current;
  if (!current) {
    return '<div class="empty">尚未配置工作流路由；服务重启并加载本地配置后会显示在这里。</div>';
  }
  const definition = current.definition || {};
  return `
    <section class="workflow-summary" aria-label="当前工作流状态">
      <div><span>状态</span><strong>${definition.enabled ? "已启用" : "已停用"}</strong></div>
      <div><span>配置版本</span><strong>v${escapeWorkflowHtml(current.version)}</strong></div>
      <div><span>规则</span><strong>${definition.rules?.length || 0}</strong></div>
      <div><span>最大跳数</span><strong>${escapeWorkflowHtml(definition.maxHops ?? "—")}</strong></div>
    </section>
    <p class="workflow-safety-note">这里负责解释“什么工作给哪个岗位”。路由只生成本地分派与审计，不会执行代码或发布 GitHub；任何外部动作仍进入唯一确认队列。</p>
    ${ownerRequestPanel(state)}
    <div class="workflow-columns">
      <section class="section workflow-panel">
        <div class="section-heading"><h2>当前路由配置</h2><span>v${escapeWorkflowHtml(current.version)} · ${escapeWorkflowHtml(String(current.digest || "").slice(0, 10))}</span></div>
        ${ruleRows(definition.rules)}
      </section>
      <section class="section workflow-panel">
        <div class="section-heading"><h2>本地 Dry-run</h2><span>NO PERSIST / NO DISPATCH</span></div>
        <form id="workflow-dry-run-form" class="workflow-dry-run">
          <label for="workflow-event-json">事件 JSON（使用当前配置模拟）</label>
          <textarea id="workflow-event-json" name="event" spellcheck="false">${escapeWorkflowHtml(state.dryRunInput)}</textarea>
          <button class="refresh-button" type="submit"${state.dryRunLoading ? " disabled" : ""}>${state.dryRunLoading ? "模拟中…" : "模拟路由"}</button>
        </form>
        ${dryRunResult(state)}
      </section>
    </div>
    <div class="workflow-columns workflow-records">
      <section class="section workflow-panel">
        <div class="section-heading"><h2>最新分派</h2><span>${state.assignments.length} RECORDS · 最新在前</span></div>
        ${assignmentRows(state.assignments, now)}
      </section>
      <section class="section workflow-panel">
        <div class="section-heading"><h2>未匹配 / 审计解释</h2><span>${state.audit.length} RECORDS · 最新在前</span></div>
        ${auditRows(state.audit, now)}
      </section>
    </div>`;
}

async function responseJson(response, label) {
  if (response.ok) return response.json();
  let detail = "";
  try {
    detail = (await response.json()).error || "";
  } catch {
    // The status code remains useful when a non-JSON intermediary fails.
  }
  throw new Error(`${label}失败（${response.status}）${detail ? `：${detail}` : ""}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkflowView({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  clock = () => Date.now(),
  requestIdFactory = () => globalThis.crypto.randomUUID(),
  sessionStorage = currentTabStorage(),
} = {}) {
  let state = initialState(requestIdFactory, storedPendingOwnerRequest(sessionStorage));

  function change(patch) {
    state = { ...state, ...patch };
    onChange();
  }

  async function load() {
    if (state.loading) return;
    change({ loading: true, error: "" });
    try {
      const responses = await Promise.all([
        fetchImpl("/api/workflow/routing", { cache: "no-store" }),
        fetchImpl("/api/workflow/assignments?limit=30", { cache: "no-store" }),
        fetchImpl("/api/workflow/audit?limit=30", { cache: "no-store" }),
      ]);
      const [routing, assignments, audit] = await Promise.all([
        responseJson(responses[0], "读取路由配置"),
        responseJson(responses[1], "读取工作流分派"),
        responseJson(responses[2], "读取工作流审计"),
      ]);
      change({
        loaded: true,
        loading: false,
        error: "",
        routing,
        assignments: assignments.items || [],
        audit: audit.items || [],
      });
    } catch (error) {
      change({ loaded: true, loading: false, error: errorMessage(error) });
    }
  }

  async function submitDryRun(input) {
    change({
      dryRunInput: input,
      dryRunResult: null,
      dryRunError: "",
    });
    let event;
    try {
      event = JSON.parse(input);
    } catch {
      change({ dryRunError: "事件 JSON 格式无效" });
      return;
    }

    change({ dryRunLoading: true });
    try {
      const response = await fetchImpl("/api/workflow/dry-run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify({ event }),
      });
      const result = await responseJson(response, "工作流模拟");
      change({ dryRunLoading: false, dryRunResult: result, dryRunError: "" });
    } catch (error) {
      change({
        dryRunLoading: false,
        dryRunResult: null,
        dryRunError: errorMessage(error),
      });
    }
  }

  async function submitOwnerRequest(input) {
    if (state.ownerRequestLoading) return;
    const draft = state.ownerPendingRequest ? state.ownerDraft : {
      workType: String(input.workType || ""),
      priority: String(input.priority || ""),
      title: String(input.title || ""),
      description: String(input.description || ""),
      acceptanceCriteria: String(input.acceptanceCriteria || ""),
      pullRequestRepository: String(input.pullRequestRepository || "").trim(),
      pullRequestNumber: String(input.pullRequestNumber || "").trim(),
    };
    const request = state.ownerPendingRequest || {
      schemaVersion: draft.workType === "pull_request" ? 2 : 1,
      requestId: state.ownerRequestId,
      workType: draft.workType,
      priority: draft.priority,
      title: draft.title,
      description: draft.description,
      acceptanceCriteria: draft.acceptanceCriteria
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    };
    if (!state.ownerPendingRequest && draft.workType === "pull_request") {
      request.pullRequest = {
        repository: draft.pullRequestRepository,
        number: Number(draft.pullRequestNumber),
      };
    }
    if (!savePendingOwnerRequest(sessionStorage, request)) {
      change({
        ownerDraft: draft,
        ownerRequestError: "当前标签页无法保存请求，请允许会话存储后重试。",
      });
      return;
    }
    change({
      ownerDraft: draft,
      ownerPendingRequest: request,
      ownerRequestLoading: true,
      ownerRequestResult: null,
      ownerRequestError: "",
    });
    try {
      const response = await fetchImpl("/api/work/requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify(request),
      });
      const result = await responseJson(response, "创建共享工作");
      clearPendingOwnerRequest(sessionStorage);
      change({
        ownerRequestId: requestIdFactory(),
        ownerDraft: emptyOwnerDraft(),
        ownerPendingRequest: null,
        ownerRequestLoading: false,
        ownerRequestResult: result,
        ownerRequestError: "",
      });
    } catch (error) {
      change({
        ownerRequestLoading: false,
        ownerRequestResult: null,
        ownerRequestError: errorMessage(error),
      });
    }
  }

  function startNewOwnerRequest() {
    if (state.ownerRequestLoading) return;
    clearPendingOwnerRequest(sessionStorage);
    change({
      ownerRequestId: requestIdFactory(),
      ownerPendingRequest: null,
      ownerRequestResult: null,
      ownerRequestError: "",
    });
  }

  function bind(root) {
    root.querySelector("[data-owner-request-new]")?.addEventListener(
      "click",
      startNewOwnerRequest,
    );
    root.querySelector("#owner-work-request-form")?.addEventListener(
      "submit",
      (submitEvent) => {
        submitEvent.preventDefault();
        const form = new FormData(submitEvent.currentTarget);
        submitOwnerRequest({
          workType: form.get("workType"),
          priority: form.get("priority"),
          title: form.get("title"),
          description: form.get("description"),
          acceptanceCriteria: form.get("acceptanceCriteria"),
          pullRequestRepository: form.get("pullRequestRepository"),
          pullRequestNumber: form.get("pullRequestNumber"),
        });
      },
    );
    root.querySelector("#workflow-dry-run-form")?.addEventListener(
      "submit",
      (submitEvent) => {
        submitEvent.preventDefault();
        const input = new FormData(submitEvent.currentTarget).get("event") || "";
        submitDryRun(input);
      },
    );
  }

  return {
    bind,
    load,
    needsLoad: () => !state.loaded || Boolean(state.error),
    render: () => renderWorkflowView(state, { now: clock() }),
    submitDryRun,
    submitOwnerRequest,
  };
}
