import { escapeHtml } from "./view-format.js";

const priorities = { normal: "普通", high: "高", urgent: "紧急" };
const commands = new Set(["instruct", "priority", "pause", "resume", "cancel"]);
const roleLabels = {
  orchestrator: "主控", "requirements-analyst": "需求分析师", "pr-engineer": "PR 工程师",
  "pr-reviewer": "PR 推进员工", developer: "开发工程师", tester: "测试工程师",
};

function readableTaskText(value, taskId) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text === taskId || /^(?:(?:work-item|code-job|github-entity|task-run)-)?[a-f0-9]{32,}$/iu.test(text)) return "";
  return text;
}

function taskTitle(task) {
  const title = readableTaskText(task.title, task.taskId);
  if (title) return title;
  const action = {
    orchestrator: "协调任务", "requirements-analyst": "分析需求",
    "pr-engineer": "处理 PR", "pr-reviewer": "巡查 PR",
    developer: "处理开发任务", tester: "验证测试任务",
  }[task.roleId] || (task.kind === "code-job" ? "执行代码任务" : "处理工作项");
  const subject = readableTaskText(task.subject, task.taskId);
  return subject ? `${action} · ${subject}` : action;
}

function identity(task) {
  return `${task.kind}:${task.taskId}`;
}

function pinnedPreview(task) {
  if (!task || !['work-item', 'code-job'].includes(task.kind) ||
      typeof task.taskId !== 'string' || task.taskId.length > 256) return null;
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  // Browser metadata is a navigation bookmark, never evidence of live state.
  return { kind: task.kind, taskId: task.taskId, title: text(task.title, 512),
    roleId: text(task.roleId, 128), subject: text(task.subject, 512),
    startedAt: text(task.startedAt, 64), priority: Object.hasOwn(priorities, task.priority) ? task.priority : 'normal',
    phase: 'unknown', active: false, readOnly: true, progress: '已置顶记录，打开后读取最新状态' };
}

function taskUrl(task) {
  return `/api/task-runs/${encodeURIComponent(task.kind)}/${encodeURIComponent(task.taskId)}`;
}

function phaseLabel(task) {
  if (task.readOnly && task.phase === "preparing") return "正在准备执行环境";
  if (task.readOnly && task.phase === "waiting_step") return "等待下一步骤";
  if (task.phase === "control_failed") return "停止尚未确认";
  if (task.pendingCommand === "pause") return task.live ? "暂停请求已提交，等待停止确认" : "暂停请求已提交，等待检查点";
  if (task.pendingCommand === "cancel") return task.live ? "取消请求已提交，等待停止确认" : "取消请求已提交，等待检查点";
  if (task.phase === "waiting_checkpoint") return "补充要求等待检查点";
  return { preparing:'准备启动',starting_model:'准备启动模型',waiting_model:'等待模型资源，尚未启动',unknown:'恢复后状态未知',running: "正在运行", paused: "已暂停", cancelled: "已取消", completed:"已完成", failed:"已失败", fenced:"已隔离，等待维护", idle: "等待后续调度" }[task.phase] || "状态待确认";
}

function timeMarkup(value) {
  return value ? `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>` : "未知";
}

function taskRow(task, selected = null) {
  return `<li><button type="button" class="task-run-row" ${selected && identity(task) === identity(selected) ? 'aria-current="true"' : ''} data-task-run-kind="${escapeHtml(task.kind)}" data-task-run-id="${escapeHtml(task.taskId)}">
    <span class="task-run-row-title"><strong>${escapeHtml(taskTitle(task))}</strong><span class="status-pill">${escapeHtml(phaseLabel(task))}</span></span>
    <span>${escapeHtml(roleLabels[task.roleId] || task.roleId)} · ${escapeHtml(readableTaskText(task.subject, task.taskId) || "无关联对象")}</span>
    <span>${['waiting_model','preparing','starting_model'].includes(task.phase)?'登记于':'开始于'} ${timeMarkup(task.startedAt ?? task.queuedAt)} · 优先级：${escapeHtml(priorities[task.priority] || "未知")}</span>
    ${task.progress ? `<span>${escapeHtml(task.progress)}</span>` : ""}
  </button></li>`;
}

export function renderTaskRuns({ loaded = false, loading = false, enabled = false, items = [], held = [], background = [], recent = [], recentExpanded = false, error = "", selected = null, pinned = [], remembered = [] } = {}) {
  const all = [...remembered, ...recent, ...background, ...held, ...items];
  const pinnedTasks = [...new Map(all.filter(task => pinned.includes(identity(task))).map(task => [identity(task), task])).values()];
  const row = task => taskRow(task, selected);
  const unpinned = task => !pinned.includes(identity(task));
  items = items.filter(unpinned);
  held = held.filter(unpinned);
  background = background.filter(unpinned);
  recent = recent.filter(unpinned);
  const queued=items.filter(task=>task.active===true && task.phase==='waiting_model');
  const preparing=items.filter(task=>task.active===true && ['preparing','starting_model'].includes(task.phase));
  const active = items.filter((task) => task.active === true && !['waiting_model','preparing','starting_model'].includes(task.phase));
  const paused = held.filter((task) => task.active !== true);
  const orderedRecent = recent.toSorted((left, right) =>
    (Date.parse(right.startedAt ?? right.queuedAt) || 0) - (Date.parse(left.startedAt ?? left.queuedAt) || 0));
  const visibleRecent = recentExpanded ? orderedRecent : orderedRecent.slice(0, 5);
  return `<div class="section-heading task-runs-heading"><h2 id="task-runs-title">当前运行任务</h2>
    <button type="button" class="secondary-button" data-task-runs-refresh ${loading ? "disabled" : ""}>${loading ? "读取中…" : "刷新任务"}</button></div>
    <p class="task-runs-hint">选择任务查看执行过程、追加要求。切换任务保留草稿，刷新不会切换当前任务。</p>
    ${pinnedTasks.length ? `<div><h3>已置顶 · ${pinnedTasks.length}</h3><ul class="task-runs-list">${pinnedTasks.map(row).join("")}</ul></div>` : ""}
    ${error ? `<p class="task-runs-error" role="status">${escapeHtml(error)}${loaded ? "；当前显示上次读取结果。" : "；可点击刷新任务重试。"}</p>` : ""}
    ${loaded && !enabled ? '<p class="task-runs-empty">当前服务未启用运行任务控制。</p>' : ""}
    ${enabled || !loaded ? `<div class="task-runs-groups"><div><h3>正在运行 · ${active.length}</h3>
      ${active.length ? `<ul class="task-runs-list">${active.map(row).join("")}</ul>` : `<p class="task-runs-empty">${loaded ? (pinnedTasks.length ? "当前没有其他正在运行的模型任务。" : "当前没有正在运行的模型任务。") : "正在读取运行任务…"}</p>`}</div>
      ${queued.length?`<div><h3>等待模型 · ${queued.length}</h3><ul class="task-runs-list">${queued.map(row).join('')}</ul></div>`:''}
      ${preparing.length?`<div><h3>准备启动 · ${preparing.length}</h3><ul class="task-runs-list">${preparing.map(row).join('')}</ul></div>`:''}
      ${paused.length ? `<div class="task-runs-held"><h3>暂停与待确认 · ${paused.length}</h3><ul class="task-runs-list">${paused.map(row).join("")}</ul></div>` : ""}
      ${background.length ? `<div class="task-runs-background"><h3>后台作业 · ${background.length}</h3><p class="task-runs-hint">作业尚未结束，当前未在执行模型回合。点击查看已记录的进展。</p><ul class="task-runs-list">${background.map(row).join("")}</ul></div>` : ""}
      ${recent.length ? `<div><div class="section-heading"><h3>最近执行 · ${recent.length}</h3>
        ${recent.length > 5 ? `<button type="button" class="secondary-button" data-task-runs-recent-toggle aria-expanded="${recentExpanded}" aria-controls="task-runs-recent-list">${recentExpanded ? "收起" : `展开全部（${recent.length} 条）`}</button>` : ""}</div>
        <ul id="task-runs-recent-list" class="task-runs-list">${visibleRecent.map(row).join("")}</ul></div>` : ""}</div>` : ""}`;
}

function deliveryMarkup(task) {
  if (!task.readOnly && task.phase === 'paused' && task.mode === 'paused') return '任务已暂停；补充要求可保存到原任务，恢复执行后应用。';
  if(task.receipt && task.readOnly)return '执行凭据只保留开始、活动、终态和会话标识，无对话正文。状态未知时需要核对原生进程，不能据此推定已停止。';
  if (task.readOnly) return "后台作业详情只读；当前没有可微调的 CLI 回合。模型开始下一步骤后，可打开当前会话并补充要求。";
  if (task.instructionReceipt === "failed") return "实时引导未确认送达；补充要求已保存，将在安全检查点续接，请先核对已提交的要求。";
  if (task.live === true) {
    if (task.instructionReceipt === "submitted") return "实时引导已提交；回执不代表模型已经采用，请继续查看进展。";
    if (task.instructionReceipt === "checkpoint") return "补充要求已在检查点接续；当前回合未实时采用。";
    return "支持当前回合实时引导；提交后查看回执和后续进展。";
  }
  return "检查点兼容模式：补充要求在当前步骤结束后接续；旧模型判断会丢弃，已执行的动作不会重复。暂停和取消需等待安全检查点确认。";
}

function allowedCommand(task, command) {
  if (!task || task.readOnly || !commands.has(command) || task.phase === "cancelled" || task.phase === "control_failed") return false;
  if (command === "resume") return task.active !== true && task.phase === "paused" && task.mode === "paused" && !task.pendingCommand;
  if (command === "priority") return task.active === true || task.phase === "paused";
  if (command === "cancel") return !task.pendingCommand && (task.active === true || task.phase === "paused");
  if (command === 'instruct' && task.active !== true) return task.phase === 'paused' && task.mode === 'paused' && !task.pendingCommand && !task.stopUnconfirmed;
  return task.active === true && !task.pendingCommand;
}

export function renderTaskRunSummary(task) {
  if (!task) return '<p class="task-runs-empty">正在读取任务详情…</p>';
  return `<p class="eyebrow">${task.kind === "code-job" ? "CODE JOB" : "WORK ITEM"}</p>
    <h2 id="task-run-detail-title">${escapeHtml(taskTitle(task))}</h2>
    <p class="task-run-phase"><strong>${escapeHtml(phaseLabel(task))}</strong></p>
    <dl class="task-run-metadata">
      <div><dt>岗位</dt><dd>${escapeHtml(roleLabels[task.roleId] || task.roleId)}</dd></div>
      <div><dt>关联对象</dt><dd>${escapeHtml(readableTaskText(task.subject, task.taskId) || "无")}</dd></div>
      <div><dt>${['waiting_model','preparing','starting_model'].includes(task.phase)?'登记时间':'开始时间'}</dt><dd>${timeMarkup(task.receipt?.modelStartedAt ?? task.startedAt ?? task.queuedAt)}</dd></div>
      <div><dt>优先级</dt><dd>${escapeHtml(priorities[task.priority] || "未知")}</dd></div>
      <div><dt>${task.readOnly ? "作业修订" : "控制修订"}</dt><dd>${escapeHtml(task.revision)}${task.readOnly ? "" : ` · 已交给模型的修订 ${escapeHtml(task.appliedRevision)}`}</dd></div>
      ${task.lastActivityAt ? `<div><dt>最近活动</dt><dd>${timeMarkup(task.lastActivityAt)}</dd></div>` : ""}
      ${task.receipt?.finishedAt?`<div><dt>结束时间</dt><dd>${timeMarkup(task.receipt.finishedAt)}</dd></div>`:''}
    </dl>
    ${task.progress ? `<p class="task-run-progress">${escapeHtml(task.progress)}</p>` : ""}
    <p class="task-run-delivery">${escapeHtml(deliveryMarkup(task))}</p>
    ${task.phase === "control_failed" ? '<p class="task-runs-error">停止尚未确认，请等待维护确认后再继续。</p>' : ""}
    <details class="task-run-instructions"><summary>已提交的补充要求（${task.instructions?.length || 0}）</summary>
      ${task.instructions?.length ? `<ol>${task.instructions.map((instruction) => `<li><p>${escapeHtml(instruction.text)}</p><small>${timeMarkup(instruction.at)}</small></li>`).join("")}</ol>` : "<p>尚未提交补充要求。</p>"}</details>`;
}

function renderTaskRunSession(task) {
  if (task?.lanView) return '<section class="task-run-session"><h3>执行状态</h3><p>会话和执行输出仅在本机可见。</p><div data-task-run-events></div></section>';
  const session = task?.session;
  const statuses = { starting: "正在连接", running: "当前回合进行中", completed: "本回合已完成", interrupted: "本回合已中断", failed: "本回合失败" };
  const types = { message: "模型输出", tool: "工具活动", plan: "计划更新", status: "状态" };
  const events = task?.events || [];
  return `<section class="task-run-session" aria-labelledby="task-run-session-title">
    <h3 id="task-run-session-title">${task?.readOnly ? "最近受控动作" : "CLI 会话"}</h3>
    ${session ? `<dl class="task-run-metadata">
      <div><dt>连接</dt><dd>${escapeHtml(session.transport)} · ${escapeHtml(statuses[session.status] || "状态待确认")}</dd></div>
      <div><dt>会话</dt><dd>${escapeHtml(session.threadId)}</dd></div>
      <div><dt>当前回合</dt><dd>${escapeHtml(session.turnId || "等待开始")}</dd></div>
    </dl>` : '<p class="task-runs-empty">当前步骤未连接实时 CLI 会话。</p>'}
    <p class="task-runs-hint">${task?.readOnly ? "显示最近 8 条动作的类型、结果、时间和相对路径。" : "显示本次运行最近 120 条输出；较长内容显示末尾，以“…”标记。"}</p>
    <div class="task-run-events" data-task-run-events role="log" aria-label="${task?.readOnly ? "后台作业动作记录" : "CLI 会话输出"}" aria-live="off" tabindex="0">
      ${events.length ? `<ol>${events.map((event) => `<li data-task-run-event="${escapeHtml(event.sequence)}">
        <div class="task-run-event-heading"><strong>${escapeHtml(types[event.type] || "活动")}</strong>${timeMarkup(event.at)}</div>
        <p>${escapeHtml(event.text)}</p></li>`).join("")}</ol>` : '<p class="task-runs-empty">尚无输出。任务开始读取代码或产生消息后会显示在这里。</p>'}
    </div>
  </section>`;
}

function controlDisabled(state, command) {
  return state.submitting || state.detailLoading || state.detailStale || !allowedCommand(state.detail, command);
}

export function renderTaskRunDetail(state = {}) {
  const { detail, draft = { instruction: "", priority: "normal" } } = state;
  const disabled = (command) => controlDisabled(state, command) ? "disabled" : "";
  return `<div class="detail task-run-detail"><div data-task-run-summary>${renderTaskRunSummary(detail)}</div>
    <div data-task-run-session>${renderTaskRunSession(detail)}</div>
    <p class="task-run-notice" data-task-run-notice role="status">${escapeHtml(state.notice || "")}</p>
    <p class="task-runs-error" data-task-run-error role="status">${escapeHtml(state.detailError || "")}</p>
    <button type="button" class="secondary-button" data-task-run-reload ${state.detailLoading ? "disabled" : ""}>刷新详情</button>
    <form data-task-run-instruction-form>
      <label for="task-run-instruction">补充要求</label>
      <textarea id="task-run-instruction" name="instruction" rows="4" maxlength="4000" aria-describedby="task-run-permission" ${detail?.readOnly ? "disabled" : ""}>${escapeHtml(draft.instruction)}</textarea>
      <p id="task-run-permission">补充要求不能扩大原任务权限，原有测试和发布授权仍然生效。</p>
      <button type="submit" class="secondary-button" data-task-run-command="instruct" ${disabled("instruct")}>提交补充要求</button>
    </form>
    <form data-task-run-priority-form class="task-run-priority-form">
      <label for="task-run-priority">后续调度优先级</label>
      <select id="task-run-priority" name="priority" ${detail?.readOnly ? "disabled" : ""}>${Object.entries(priorities).map(([value, label]) => `<option value="${value}" ${draft.priority === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <button type="submit" class="secondary-button" data-task-run-command="priority" ${disabled("priority")}>保存优先级</button>
    </form>
    <div class="task-run-actions" data-task-run-actions>${renderTaskRunActions(state)}</div>
  </div>`;
}

function renderTaskRunActions(state) {
  const task = state.detail;
  const pauseOrResume = task?.phase === "paused" ? "resume" : "pause";
  const labels = { pause: "暂停任务", resume: "恢复原任务", cancel: "取消任务" };
  return [pauseOrResume, "cancel"].filter((command) => allowedCommand(task, command)).map((command) =>
    `<button type="button" class="secondary-button ${command === "cancel" ? "task-run-cancel" : ""}" data-task-run-command="${command}" ${controlDisabled(state, command) ? "disabled" : ""}>${labels[command]}</button>`,
  ).join("");
}

async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const error = new Error(message || `运行任务请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function validateDetail(value, selected) {
  if (!value || value.kind !== selected.kind || value.taskId !== selected.taskId ||
      typeof value.runId !== "string" || !Number.isSafeInteger(value.revision)) {
    throw new Error("运行任务详情格式无效，请刷新后重试");
  }
  return value;
}

export function createTaskRunsController({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  isVisible = () => globalThis.document?.visibilityState !== "hidden",
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  storage = null,
} = {}) {
  const state = { loaded: false, loading: false, enabled: false, items: [], held: [], background: [], recent:[], recentExpanded: false, error: "",
    selected: null, detail: null, detailLoading: false, detailStale: false, detailError: "",
    submitting: false, notice: "", draft: { instruction: "", priority: "normal" }, pinned: [], remembered: [] };
  const drafts = new Map();
  const storageKey = 'mydashboard.task-workbench.v1';
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
    if (saved?.version === 1) {
      state.pinned = Array.isArray(saved.pinned) ? saved.pinned.filter(key => typeof key === 'string' && key.length <= 512).slice(0, 100) : [];
      state.remembered = (Array.isArray(saved.bookmarks) ? saved.bookmarks.slice(0, 100) : [])
        .map(pinnedPreview).filter(task => task && state.pinned.includes(identity(task)));
      if (['work-item', 'code-job'].includes(saved.selected?.kind) && typeof saved.selected.taskId === 'string' && saved.selected.taskId.length <= 256) state.selected = saved.selected;
      for (const entry of Array.isArray(saved.drafts) ? saved.drafts.slice(0, 100) : []) {
        if (typeof entry.key === 'string' && typeof entry.instruction === 'string' && Object.hasOwn(priorities, entry.priority)) {
          drafts.set(entry.key, { instruction: entry.instruction.slice(0, 4000), priority: entry.priority, priorityDirty: entry.priorityDirty === true });
        }
      }
    }
  } catch { /* Browser storage may be disabled or contain an older format. */ }
  if (state.selected && !drafts.has(identity(state.selected))) drafts.set(identity(state.selected), { instruction: '', priority: 'normal', priorityDirty: false });
  if (state.selected) state.draft = { ...drafts.get(identity(state.selected)) };
  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify({ version: 1, selected: state.selected, pinned: state.pinned,
      bookmarks: state.remembered.filter(task => state.pinned.includes(identity(task))).map(pinnedPreview).filter(Boolean),
      drafts: [...drafts].slice(-100).map(([key, draft]) => ({ key, ...draft })) })); }
    catch { /* Task controls continue to work when browser storage is unavailable. */ }
  }
  let listRequest = null;
  let detailRequest = null;
  let detailSequence = 0;
  let selectionSequence = 0;
  let running = false;
  let timer = null;
  let pollRequest = null;

  function getState() { return { ...state, draft: { ...state.draft } }; }
  function notify() { onChange(getState()); }
  function toggleRecent() { state.recentExpanded = !state.recentExpanded; notify(); }
  function togglePin() {
    if (!state.selected) return;
    const key = identity(state.selected);
    state.pinned = state.pinned.includes(key) ? state.pinned.filter(value => value !== key) : [...state.pinned.slice(-99), key];
    if (state.detail) state.remembered = [...state.remembered.filter(task => identity(task) !== key), state.detail].slice(-100);
    persist(); notify();
  }
  function currentDraft() { return state.selected ? drafts.get(identity(state.selected)) : null; }

  function applyDetail(detail) {
    state.detail = detail;
    state.detailStale = false;
    if (state.pinned.includes(identity(detail))) {
      state.remembered = [...state.remembered.filter(task => identity(task) !== identity(detail)), detail].slice(-100);
    }
    const draft = currentDraft();
    if (draft && !draft.priorityDirty) draft.priority = detail.priority;
    if (draft) state.draft = { instruction: draft.instruction, priority: draft.priority };
  }

  function setDraft(patch) {
    const draft = currentDraft();
    if (!draft) return;
    if (typeof patch.instruction === "string") draft.instruction = patch.instruction;
    if (Object.hasOwn(priorities, patch.priority)) { draft.priority = patch.priority; draft.priorityDirty = true; }
    state.draft = { instruction: draft.instruction, priority: draft.priority };
    persist();
    notify();
  }

  async function refresh() {
    if (listRequest) return listRequest;
    state.loading = true;
    notify();
    listRequest = (async () => {
      try {
        const body = await readResponse(await fetchImpl("/api/task-runs", { cache: "no-store" }));
        if (typeof body.enabled !== "boolean" || !Array.isArray(body.items) || !Array.isArray(body.held) ||
            (body.background !== undefined && !Array.isArray(body.background)) || (body.recent !== undefined && !Array.isArray(body.recent))) throw new Error("运行任务列表格式无效");
        Object.assign(state, { loaded: true, enabled: body.enabled, items: body.items, held: body.held, background: body.background || [],recent:body.recent||[], error: "" });
      } catch (error) { state.error = error.message; }
      finally { state.loading = false; listRequest = null; notify(); }
    })();
    return listRequest;
  }

  async function refreshDetail() {
    if (!state.selected) return;
    if (detailRequest) return detailRequest;
    const selected = { ...state.selected };
    const sequence = ++detailSequence;
    state.detailLoading = true;
    notify();
    const request = (async () => {
      try {
        const detail = validateDetail(await readResponse(await fetchImpl(taskUrl(selected), { cache: "no-store" })), selected);
        if (sequence !== detailSequence) return;
        applyDetail(detail);
        state.detailError = "";
      } catch (error) {
        if (sequence !== detailSequence) return;
        state.detailError = error.message;
        state.detailStale = true;
      } finally {
        if (sequence === detailSequence) { state.detailLoading = false; detailRequest = null; notify(); }
      }
    })();
    detailRequest = request;
    return request;
  }

  async function open(kind, taskId) {
    if (!["work-item", "code-job"].includes(kind) || !taskId) return;
    selectionSequence += 1;
    detailSequence += 1;
    detailRequest = null;
    state.selected = { kind, taskId };
    const key = identity(state.selected);
    if (!drafts.has(key)) drafts.set(key, { instruction: "", priority: "normal", priorityDirty: false });
    const draft = drafts.get(key);
    Object.assign(state, { detail: null, detailError: "", detailStale: false, notice: "",
      draft: { instruction: draft.instruction, priority: draft.priority } });
    persist();
    notify();
    await refreshDetail();
  }

  function close() {
    selectionSequence += 1;
    detailSequence += 1;
    detailRequest = null;
    Object.assign(state, { selected: null, detail: null, detailLoading: false });
    persist();
    notify();
  }

  function updateList(detail) {
    const key = identity(detail);
    state.items = state.items.filter((task) => identity(task) !== key);
    state.held = state.held.filter((task) => identity(task) !== key);
    state.background = state.background.filter((task) => identity(task) !== key);
    state.recent = state.recent.filter((task) => identity(task) !== key);
    if (detail.active) state.items.push(detail);
    else if (detail.phase === "paused" || detail.pendingCommand) state.held.push(detail);
  }

  async function control(command) {
    if (state.submitting || state.detailStale || !allowedCommand(state.detail, command)) return false;
    const selected = { ...state.selected };
    const selection = selectionSequence;
    const draft = currentDraft();
    const instruction = draft.instruction.trim();
    if (command === "instruct" && (!instruction || new TextEncoder().encode(instruction).length > 4_000)) {
      state.detailError = "请填写补充要求，长度不超过 4000 UTF-8 字节。";
      notify();
      return false;
    }
    const payload = { runId: state.detail.runId, expectedRevision: state.detail.revision, command,
      ...(command === "instruct" ? { instruction } : {}), ...(command === "priority" ? { priority: draft.priority } : {}) };
    const submittedText = draft.instruction;
    state.submitting = true;
    state.notice = "正在提交…";
    state.detailError = "";
    detailSequence += 1;
    detailRequest = null;
    state.detailLoading = false;
    notify();
    try {
      const detail = validateDetail(await readResponse(await fetchImpl(`${taskUrl(selected)}/control`, {
        method: "POST", headers: { "content-type": "application/json", "x-mydashboard-action": "1" }, body: JSON.stringify(payload),
      })), selected);
      if (command === "instruct" && draft.instruction === submittedText) draft.instruction = "";
      if (command === "priority" && draft.priority === payload.priority) draft.priorityDirty = false;
      updateList(detail);
      if (selection !== selectionSequence) return true;
      applyDetail(detail);
      state.notice = command === "resume" ? "原任务已恢复，等待后续调度。" : command === "priority" ? "后续调度优先级已保存。" :
        command === 'instruct' ? (detail.phase === 'paused' ? '补充要求已保存，恢复原任务后应用。' : deliveryMarkup(detail)) : phaseLabel(detail);
      return true;
    } catch (error) {
      if (selection !== selectionSequence) return false;
      state.notice = "";
      if (error.status === 409 || !error.status) {
        await refreshDetail();
        if (selection !== selectionSequence) return false;
        state.detailError = state.detailStale ? `${error.message}；未能刷新状态，请先刷新详情。` :
          state.detail.instructionReceipt === "failed" ? "实时引导未确认送达，已保存的要求将在检查点续接；草稿已保留，请先核对已提交的要求。" :
            error.status === 409 ? "任务状态已更新，草稿已保留，请核对后重新提交。" : "提交结果尚未确认，已读取最新状态；请核对已提交要求后再操作。";
      } else state.detailError = error.message;
      return false;
    } finally { state.submitting = false; persist(); notify(); }
  }

  function clearTimer() { if (timer !== null) clearTimeoutImpl(timer); timer = null; }
  function schedule() {
    if (!running || !isVisible() || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; void poll(); }, 5_000);
  }
  async function poll() {
    if (!running || !isVisible()) return;
    if (pollRequest) return pollRequest;
    pollRequest = Promise.allSettled([refresh(), state.selected && !state.submitting ? refreshDetail() : null]);
    try { await pollRequest; } finally { pollRequest = null; schedule(); }
  }
  async function start() { if (running) return pollRequest; running = true; await poll(); }
  function stop() { running = false; clearTimer(); }
  async function visibilityChanged() { clearTimer(); if (isVisible()) await poll(); }

  return { getState, setDraft, toggleRecent, togglePin, refresh, refreshDetail, open, close, control, start, stop, visibilityChanged };
}

export function createTaskRunsView({ container, dialog, embedded = false, documentImpl = document, ...options }) {
  if (embedded) {
    container.classList.add('task-workbench');
    container.innerHTML = '<div class="task-workbench-shell"><aside data-task-workbench-list aria-label="任务列表"></aside><section data-task-workbench-detail aria-label="当前任务"><p class="task-workbench-empty">从左侧选择任务，查看执行过程并补充要求。</p><div data-task-run-content></div></section></div>';
  }
  const listContent = embedded ? container.querySelector('[data-task-workbench-list]') : container;
  const detailContent = (embedded ? container : dialog).querySelector("[data-task-run-content]");
  let renderedSelection = "";
  let lastListMarkup = "";
  let lastSummaryMarkup = "";
  let lastSessionMarkup = "";
  let lastActionsMarkup = "";
  let browserStorage = null;
  try { browserStorage = documentImpl.defaultView?.sessionStorage ?? null; } catch { /* Optional browser persistence. */ }
  const controller = createTaskRunsController({ storage: browserStorage, ...options, onChange: render });

  function render(state) {
    const listMarkup = renderTaskRuns(state);
    if (listMarkup !== lastListMarkup) {
      const focused = documentImpl.activeElement;
      const taskButton = focused?.closest?.("[data-task-run-kind]");
      const refreshFocused = focused?.matches?.("[data-task-runs-refresh]");
      const recentFocused = focused?.matches?.("[data-task-runs-recent-toggle]");
      listContent.innerHTML = listMarkup;
      lastListMarkup = listMarkup;
      if (taskButton) {
        [...container.querySelectorAll("[data-task-run-kind]")].find((button) =>
          button.dataset.taskRunKind === taskButton.dataset.taskRunKind && button.dataset.taskRunId === taskButton.dataset.taskRunId,
        )?.focus({ preventScroll: true });
      } else if (refreshFocused) container.querySelector("[data-task-runs-refresh]")?.focus({ preventScroll: true });
      else if (recentFocused) container.querySelector("[data-task-runs-recent-toggle]")?.focus({ preventScroll: true });
    }
    if (!state.selected) return;
    if (embedded) container.querySelector('.task-workbench-empty').hidden = true;
    const selected = identity(state.selected);
    if (renderedSelection !== selected) {
      detailContent.innerHTML = renderTaskRunDetail(state);
      if (embedded) {
        const detail = detailContent.querySelector('.task-run-detail');
        const summary = detail.querySelector('[data-task-run-summary]');
        const priorityForm = detail.querySelector('[data-task-run-priority-form]');
        const actions = detail.querySelector('[data-task-run-actions]');
        const inspector = documentImpl.createElement('aside');
        inspector.className = 'task-workbench-inspector';
        inspector.setAttribute('aria-label', '任务详情与控制');
        inspector.innerHTML = '<button type="button" class="secondary-button" data-task-run-pin></button>';
        inspector.append(summary, priorityForm, actions);
        const conversation = documentImpl.createElement('div');
        conversation.className = 'task-workbench-conversation';
        const heading = documentImpl.createElement('h2');
        heading.setAttribute('data-task-workbench-title', '');
        conversation.append(...detail.childNodes);
        conversation.prepend(heading);
        detail.append(conversation, inspector);
      }
      renderedSelection = selected;
      lastSummaryMarkup = "";
      lastSessionMarkup = "";
      lastActionsMarkup = "";
    }
    const summaryMarkup = renderTaskRunSummary(state.detail);
    const heading = detailContent.querySelector('[data-task-workbench-title]');
    if (heading) heading.textContent = state.detail ? taskTitle(state.detail) : "任务详情";
    const pinButton = detailContent.querySelector('[data-task-run-pin]');
    if (pinButton) {
      const pinned = state.pinned.includes(selected);
      pinButton.textContent = pinned ? '取消置顶' : '置顶任务';
      pinButton.setAttribute('aria-pressed', String(pinned));
    }
    if (summaryMarkup !== lastSummaryMarkup) {
      const summary = detailContent.querySelector("[data-task-run-summary]");
      const historyOpen = summary.querySelector("details")?.open;
      summary.innerHTML = summaryMarkup;
      if (historyOpen) summary.querySelector("details").open = true;
      lastSummaryMarkup = summaryMarkup;
    }
    const sessionMarkup = renderTaskRunSession(state.detail);
    if (sessionMarkup !== lastSessionMarkup) {
      const session = detailContent.querySelector("[data-task-run-session]");
      const output = session.querySelector("[data-task-run-events]");
      const scrollTop = output?.scrollTop || 0;
      const following = !output || output.scrollHeight - output.scrollTop - output.clientHeight < 32;
      const focused = documentImpl.activeElement === output;
      session.innerHTML = sessionMarkup;
      const nextOutput = session.querySelector("[data-task-run-events]");
      nextOutput.scrollTop = following ? nextOutput.scrollHeight : scrollTop;
      if (focused) nextOutput.focus({ preventScroll: true });
      lastSessionMarkup = sessionMarkup;
    }
    detailContent.querySelector("[data-task-run-notice]").textContent = state.notice;
    detailContent.querySelector("[data-task-run-error]").textContent = state.detailError;
    const instruction = detailContent.querySelector("textarea");
    const priority = detailContent.querySelector("select");
    if (instruction.value !== state.draft.instruction) instruction.value = state.draft.instruction;
    if (priority.value !== state.draft.priority) priority.value = state.draft.priority;
    instruction.disabled = state.detail?.readOnly === true;
    priority.disabled = state.detail?.readOnly === true;
    detailContent.querySelector("[data-task-run-reload]").disabled = state.detailLoading || state.submitting;
    for (const button of detailContent.querySelectorAll("form button[data-task-run-command]")) button.disabled = controlDisabled(state, button.dataset.taskRunCommand);
    const actionsMarkup = renderTaskRunActions(state);
    if (lastActionsMarkup !== actionsMarkup) {
      const actions = detailContent.querySelector("[data-task-run-actions]");
      const focusedCommand = actions.contains(documentImpl.activeElement) ? documentImpl.activeElement.dataset.taskRunCommand : "";
      actions.innerHTML = actionsMarkup;
      lastActionsMarkup = actionsMarkup;
      if (focusedCommand) [...actions.querySelectorAll("button")].find((button) => button.dataset.taskRunCommand === focusedCommand)?.focus({ preventScroll: true });
    }
  }

  container.addEventListener("click", (event) => {
    if (event.target.closest("[data-task-runs-refresh]")) { void controller.refresh(); return; }
    if (event.target.closest("[data-task-runs-recent-toggle]")) { controller.toggleRecent(); return; }
    const button = event.target.closest("[data-task-run-kind]");
    if (!button) return;
    renderedSelection = "";
    void controller.open(button.dataset.taskRunKind, button.dataset.taskRunId);
    if (!embedded && !dialog.open) dialog.showModal();
  });
  detailContent.addEventListener("input", (event) => {
    if (event.target.name === "instruction") controller.setDraft({ instruction: event.target.value });
  });
  detailContent.addEventListener("change", (event) => {
    if (event.target.name === "priority") controller.setDraft({ priority: event.target.value });
  });
  detailContent.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.control(event.target.matches("[data-task-run-instruction-form]") ? "instruct" : "priority");
  });
  detailContent.addEventListener("click", (event) => {
    if (event.target.closest('[data-task-run-pin]')) { controller.togglePin(); return; }
    if (event.target.closest("[data-task-run-reload]")) { void controller.refreshDetail(); return; }
    const button = event.target.closest("button[type=button][data-task-run-command]");
    if (button) void controller.control(button.dataset.taskRunCommand);
  });
  if (!embedded) {
    dialog.querySelector("[data-task-run-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
    const selected = controller.getState().selected;
    renderedSelection = "";
    controller.close();
    const opener = [...container.querySelectorAll("[data-task-run-kind]")].find((button) =>
      button.dataset.taskRunKind === selected?.kind && button.dataset.taskRunId === selected?.taskId,
    );
    (opener || container.querySelector("[data-task-runs-refresh]"))?.focus({ preventScroll: true });
  });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }
  const onVisibility = () => { void controller.visibilityChanged(); };
  documentImpl.addEventListener("visibilitychange", onVisibility);
  render(controller.getState());
  return { ...controller, stop() { controller.stop(); documentImpl.removeEventListener("visibilitychange", onVisibility); } };
}
