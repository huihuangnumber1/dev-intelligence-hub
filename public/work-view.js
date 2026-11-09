import {
  normalizeWorkGraphSnapshot,
  renderWorkGraph,
} from "./work-graph-view.js";
import { escapeHtml, relativeTime } from "./view-format.js";
import {
  githubWorkItemFromUrl,
  manualHistoricalWorkMarkup,
  ownerWorkRequestForItem,
} from "./manual-work-assignment.js";

const MAX_HISTORICAL_REQUEST_IDS = 100;

function initialState() {
  return {
    loaded: false,
    loading: false,
    error: "",
    summary: null,
    roleId: null,
    items: [],
    timeline: [],
    codeJobsEnabled: false,
    codeJobs: [],
    codeJobsError: "",
    graphLoading: false,
    graphSnapshot: null,
    graphError: "",
    ownerRetryPendingItemId: null,
    ownerRetryErrorItemId: null,
    ownerRetryError: "",
    historicalWorkResult: null,
  };
}

export const escapeWorkHtml = escapeHtml;

function statusLabel(status) {
  return {
    queued: "待领取",
    paused: "已暂停",
    working: "判断中",
    dispatch_pending: "等待派发",
    waiting_user: "等待你答复",
    waiting_condition: "等待条件",
    waiting_external: "等待外部授权",
    retry_wait: "等待重试",
    completed: "已完成",
    blocked: "已阻塞",
    cancelled: "已取消",
  }[status] || status || "未知";
}

function targetLabel(target = {}) {
  const type = { role: "岗位", person: "人员", node: "节点" }[target.type] || "目标";
  return `${type} · ${target.id || "未指定"}`;
}

function reviewStage(item) {
  if (!["pr-engineer", "pr-reviewer"].includes(item?.currentTarget?.id)) return null;
  return {
    queued: ["第 1/5 步", "已分配，等待领取", "PR 工程师"],
    working: ["第 2/5 步", "正在审查当前 Head", "PR 工程师"],
    dispatch_pending: ["第 3/5 步", "正在生成 Review 建议", "系统"],
    waiting_user: ["第 4/5 步", "等待你补充判断", "你"],
    waiting_condition: ["第 4/5 步", "等待检查或外部条件", "条件满足后由 PR 工程师继续"],
    waiting_external: ["第 4/5 步", "Review 建议已生成，等待你确认发布", "你"],
    retry_wait: ["第 3/5 步", "等待自动重试", "PR 工程师"],
    blocked: ["链路受阻", "需要处理阻塞原因", "你或任务负责人"],
    completed: ["第 5/5 步", "Review 已发布或任务已完成", "下一棒岗位 / 合并负责人"],
  }[item.status] || null;
}

function subjectLabel(item) {
  const subject = item?.event?.subject || {};
  if (subject.repository && subject.number) {
    return `${subject.repository} #${subject.number}`;
  }
  return subject.repository || subject.id || item.assignmentId || "本地工作项";
}

const OWNER_RETRY_SHA256 = /^[a-f0-9]{64}$/;
const OWNER_RETRY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const OWNER_RETRY_MAX_ARRAY_LENGTH = 10_000;
const OWNER_RETRY_REQUIRED_ITEM_FIELDS = Object.freeze([
  "itemId",
  "revision",
  "inputDigest",
  "attempt",
  "kind",
  "status",
  "statusReason",
  "ownerId",
  "leaseId",
  "leaseUntil",
  "activeIntentId",
  "decisionContext",
  "sourceQuarantine",
  "source",
]);
const ownerRetryTextEncoder = new TextEncoder();

function ownerRetryDataFields(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function ownerRetryArrayValues(value) {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.configurable !== false ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > OWNER_RETRY_MAX_ARRAY_LENGTH
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return null;
    const keySet = new Set(keys);
    if (!keySet.has("length")) return null;

    const values = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keySet.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

function boundedOwnerRetryId(value) {
  return Boolean(
    typeof value === "string" &&
      value.trim() &&
      !OWNER_RETRY_CONTROL_CHARACTERS.test(value) &&
      ownerRetryTextEncoder.encode(value).length <= 192,
  );
}

function ownerDecisionRetryBinding(value) {
  try {
    const item = ownerRetryDataFields(value);
    if (
      !item ||
      OWNER_RETRY_REQUIRED_ITEM_FIELDS.some((field) => !item.has(field))
    ) {
      return null;
    }
    const itemId = item.get("itemId");
    const revision = item.get("revision");
    const inputDigest = item.get("inputDigest");
    const attempt = item.get("attempt");
    if (
      !boundedOwnerRetryId(itemId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof inputDigest !== "string" ||
      !OWNER_RETRY_SHA256.test(inputDigest) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 0 ||
      item.get("kind") !== "source_root" ||
      item.get("status") !== "blocked" ||
      item.get("statusReason") !== "decision_attempts_exhausted" ||
      item.get("ownerId") !== null ||
      item.get("leaseId") !== null ||
      item.get("leaseUntil") !== null ||
      item.get("activeIntentId") !== null ||
      item.get("decisionContext") !== null ||
      item.get("sourceQuarantine") !== null
    ) {
      return null;
    }

    const source = ownerRetryDataFields(item.get("source"));
    if (!source) return null;
    const sourceFields = [
      "kind",
      "inputRevision",
      "activeRevision",
      "pendingRevision",
      "pending",
      "current",
      "bindings",
    ];
    if (sourceFields.some((field) => !source.has(field))) return null;
    const inputRevision = source.get("inputRevision");
    const activeRevision = source.get("activeRevision");
    if (
      source.get("kind") !== "pull_request" ||
      !Number.isSafeInteger(inputRevision) ||
      inputRevision < 1 ||
      activeRevision !== inputRevision ||
      source.get("pendingRevision") !== null ||
      source.get("pending") !== null
    ) {
      return null;
    }

    const current = ownerRetryDataFields(source.get("current"));
    if (
      !current ||
      !current.has("eventId") ||
      !current.has("inputDigest") ||
      !current.has("event")
    ) {
      return null;
    }
    const eventId = current.get("eventId");
    if (
      !boundedOwnerRetryId(eventId) ||
      current.get("inputDigest") !== inputDigest
    ) {
      return null;
    }
    const event = ownerRetryDataFields(current.get("event"));
    if (!event?.has("eventId") || event.get("eventId") !== eventId) return null;

    const bindings = ownerRetryArrayValues(source.get("bindings"));
    if (!bindings) return null;
    const currentlyBound = bindings.some((value) => {
      const binding = ownerRetryDataFields(value);
      return Boolean(
        binding?.has("eventId") &&
          binding.has("inputRevision") &&
          binding.get("eventId") === eventId &&
          binding.get("inputRevision") === activeRevision,
      );
    });
    return currentlyBound
      ? { itemId, expectedRevision: revision, expectedInputDigest: inputDigest }
      : null;
  } catch {
    return null;
  }
}

function readableOwnerRetryItemId(value) {
  try {
    if (
      value === null ||
      !["object", "function"].includes(typeof value)
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "itemId");
    return descriptor &&
      "value" in descriptor &&
      boundedOwnerRetryId(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function unambiguousOwnerRetryBindings(items) {
  const values = ownerRetryArrayValues(items);
  if (!values) return [];
  const itemIdCounts = new Map();
  for (const item of values) {
    const itemId = readableOwnerRetryItemId(item);
    if (!itemId) continue;
    itemIdCounts.set(
      itemId,
      (itemIdCounts.get(itemId) || 0) + 1,
    );
  }
  const bindings = values.map((item) => ownerDecisionRetryBinding(item));
  return bindings.map((binding) => (
    binding && itemIdCounts.get(binding.itemId) === 1 ? binding : null
  ));
}

function ownerDecisionRetryMarkup(binding, state) {
  if (!binding) return "";
  const pendingItemId = state.ownerRetryPendingItemId || null;
  const pending = pendingItemId !== null;
  const label = pendingItemId === binding.itemId
    ? "正在重新排队…"
    : "重新排队一次";
  const error =
    state.ownerRetryErrorItemId === binding.itemId
      ? state.ownerRetryError
      : "";
  return `<button type="button" class="secondary-action" data-owner-decision-retry-item-id="${escapeWorkHtml(binding.itemId)}"${pending ? " disabled" : ""}>${label}</button>
      ${error ? `<p class="code-job-action-error" role="alert">${escapeWorkHtml(error)}</p>` : ""}`;
}

function workRowPrimitive(fields, name) {
  const value = fields?.get(name);
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function workRowObjectFields(fields, name) {
  try {
    return ownerRetryDataFields(fields?.get(name));
  } catch {
    return null;
  }
}

function workRowProjection(value) {
  try {
    const fields = ownerRetryDataFields(value);
    if (!fields) return {};
    const event = workRowObjectFields(fields, "event");
    const subject = workRowObjectFields(event, "subject");
    const currentTarget = workRowObjectFields(fields, "currentTarget");
    const decisionContext = workRowObjectFields(fields, "decisionContext");
    return {
      assignmentId: workRowPrimitive(fields, "assignmentId"),
      status: workRowPrimitive(fields, "status"),
      kind: workRowPrimitive(fields, "kind"),
      attempt: workRowPrimitive(fields, "attempt"),
      updatedAt: workRowPrimitive(fields, "updatedAt"),
      statusReason: workRowPrimitive(fields, "statusReason"),
      event: event
        ? {
            eventType: workRowPrimitive(event, "eventType"),
            subject: subject
              ? {
                  repository: workRowPrimitive(subject, "repository"),
                  number: workRowPrimitive(subject, "number"),
                  id: workRowPrimitive(subject, "id"),
                }
              : undefined,
          }
        : undefined,
      currentTarget: currentTarget
        ? {
            type: workRowPrimitive(currentTarget, "type"),
            id: workRowPrimitive(currentTarget, "id"),
          }
        : undefined,
      decisionContext: decisionContext
        ? { kind: workRowPrimitive(decisionContext, "kind") }
        : undefined,
    };
  } catch {
    return {};
  }
}

function itemRows(items, now, state) {
  const values = ownerRetryArrayValues(items);
  if (!values?.length) {
    return '<div class="empty">尚无工作项；新的路由分派会可靠进入这里。</div>';
  }
  const bindings = unambiguousOwnerRetryBindings(values);
  const rows = values.map((item, index) => ({
    binding: bindings[index],
    item: workRowProjection(item),
  }));
  return `<div class="work-list">${rows.map(({ binding, item }) => {
    const stage = reviewStage(item);
    return `
    <article class="work-row">
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(subjectLabel(item))}</strong>
        <span class="status-pill status-${escapeWorkHtml(item.status)}">${escapeWorkHtml(statusLabel(item.status))}</span>
      </div>
      <p>${escapeWorkHtml(targetLabel(item.currentTarget))}</p>
      ${stage ? `<p class="work-row-stage"><strong>${escapeWorkHtml(stage[0])} · ${escapeWorkHtml(stage[1])}</strong><small>下一责任人：${escapeWorkHtml(stage[2])}</small></p>` : ""}
      <span>${escapeWorkHtml(item.event?.eventType || item.kind || "unknown")} · 尝试 ${escapeWorkHtml(item.attempt ?? 0)} 次 · ${relativeTime(item.updatedAt, now)}</span>
      ${item.statusReason ? `<small>台账原因：${escapeWorkHtml(item.statusReason)}</small>` : ""}
      ${item.decisionContext ? `<small>已绑定继续处理上下文 · ${escapeWorkHtml(item.decisionContext.kind || "context")}</small>` : ""}
      ${ownerDecisionRetryMarkup(binding, state)}
    </article>`;
  }).join("")}</div>`;
}

function timelineRows(entries, now) {
  if (!entries.length) {
    return '<div class="empty">尚无工作时间线。</div>';
  }
  return `<div class="work-list">${entries.map((entry) => `
    <article class="work-row work-timeline-row">
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(entry.type || "unknown")}</strong>
        <span>#${escapeWorkHtml(entry.sequence ?? "—")}</span>
      </div>
      <p>${escapeWorkHtml(entry.actorId || "system")}</p>
      <span>${escapeWorkHtml(entry.itemId || "全局事件")} · ${relativeTime(entry.at, now)}</span>
    </article>`).join("")}</div>`;
}

const CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "fenced",
  "unknown",
]);

const CODE_JOB_CONTROL_STATUSES = Object.freeze({
  pause: Object.freeze(["queued", "starting", "active"]),
  resume: Object.freeze(["paused"]),
  cancel: Object.freeze([
    "queued",
    "starting",
    "active",
    "pausing",
    "unknown",
    "paused",
  ]),
});

function codeJobStatus(status) {
  return CODE_JOB_STATUSES.has(status) ? status : "unknown";
}

function codeJobStatusLabel(status) {
  return {
    queued: "已授权，等待执行",
    starting: "正在准备隔离工作区",
    active: "受控执行中",
    pausing: "正在安全暂停",
    paused: "已暂停",
    cancelling: "正在安全取消",
    cancelled: "已取消",
    completed: "已完成",
    failed: "执行失败",
    fenced: "安全隔离，等待核验",
    unknown: "状态待核验",
  }[codeJobStatus(status)];
}

function canControlCodeJob(detail, command) {
  const job = detail?.job;
  if (
    typeof command !== "string" ||
    !Object.hasOwn(CODE_JOB_CONTROL_STATUSES, command)
  ) return false;
  const allowedStatuses = CODE_JOB_CONTROL_STATUSES[command];
  return Boolean(
    detail?.archived === false &&
      typeof job?.jobId === "string" &&
      job.jobId.length > 0 &&
      Number.isSafeInteger(job.revision) &&
      job.revision >= 1 &&
      allowedStatuses.includes(job.status),
  );
}

function codeJobActionStatusLabel(status) {
  return {
    succeeded: "成功",
    failed: "失败",
    interrupted: "已中断",
  }[status] || "状态未知";
}

function codeJobProgressMarkup(job, now) {
  const turn = Number.isSafeInteger(job.turn) && job.turn >= 0 ? job.turn : 0;
  const progress = [`${turn} 轮`];
  if (job.pendingActionType) {
    progress.push(`待执行 ${job.pendingActionType}`);
  } else if (job.latestObservation?.actionType) {
    progress.push(
      `最近动作 ${job.latestObservation.actionType} · ${codeJobActionStatusLabel(job.latestObservation.status)}`,
    );
  } else {
    progress.push("尚无动作");
  }

  const details = [];
  if (job.uncertainty?.code && job.uncertainty?.message) {
    details.push(
      `待核验：${job.uncertainty.code} · ${job.uncertainty.message} · ${relativeTime(job.uncertainty.at, now)}`,
    );
  }
  if (job.pause?.reason) {
    details.push(
      `暂停原因：${job.pause.reason} · ${relativeTime(job.pause.at, now)}`,
    );
  }
  if (job.terminalResult?.kind) {
    details.push(
      `终态：${codeJobStatusLabel(job.terminalResult.kind)} · ${relativeTime(job.terminalResult.recordedAt, now)}`,
    );
  }
  return `<span>${progress.map(escapeWorkHtml).join(" · ")} · ${relativeTime(job.updatedAt, now)}</span>
    ${details.map((detail) => `<small>${escapeWorkHtml(detail)}</small>`).join("")}`;
}

function codeJobRows(items, now) {
  if (!items.length) {
    return '<div class="empty">尚无已授权的本地代码任务。</div>';
  }
  return `<div class="work-list">${items.map((job) => {
    const status = codeJobStatus(job.status);
    return `
    <button type="button" class="work-row code-job-row" data-code-job-id="${escapeWorkHtml(job.jobId)}">
      <span class="work-row-heading">
        <strong>${escapeWorkHtml(job.repository || "未知仓库")} · ${escapeWorkHtml(job.operation || "unknown")}</strong>
        <span class="status-pill status-${status}">${escapeWorkHtml(codeJobStatusLabel(status))}</span>
      </span>
      <span class="code-job-row-context">${escapeWorkHtml(job.requestedBy?.roleId || "未知岗位")} · ${escapeWorkHtml(job.workspaceId || "未知工作区")}</span>
      ${codeJobProgressMarkup(job, now)}
    </button>`;
  }).join("")}</div>`;
}

function detailList(values, empty = "未提供") {
  const items = Array.isArray(values) ? values : [];
  if (!items.length) return `<p class="code-job-detail-empty">${escapeWorkHtml(empty)}</p>`;
  return `<ul class="code-job-detail-list">${items
    .map((value) => `<li>${escapeWorkHtml(value)}</li>`)
    .join("")}</ul>`;
}

function safeObjectMarkup(value) {
  if (value === null || value === undefined) return "未提供";
  try {
    return escapeWorkHtml(JSON.stringify(value, null, 2));
  } catch {
    return escapeWorkHtml(String(value));
  }
}

function manifestChangeRows(changes = {}) {
  const rows = [
    ...(Array.isArray(changes.created) ? changes.created : []).map((entry) => {
      const bytes = Number.isFinite(entry?.blob?.bytes)
        ? ` · ${entry.blob.bytes} bytes`
        : "";
      return `<li><strong>新建</strong> · ${escapeWorkHtml(entry?.path || "未知路径")}<small>内容摘要 <code>${escapeWorkHtml(entry?.blob?.sha256 || "未知")}</code>${escapeWorkHtml(bytes)}</small></li>`;
    }),
    ...(Array.isArray(changes.modified) ? changes.modified : []).map((entry) => {
      const bytes = Number.isFinite(entry?.blob?.bytes)
        ? ` · ${entry.blob.bytes} bytes`
        : "";
      return `<li><strong>修改</strong> · ${escapeWorkHtml(entry?.path || "未知路径")}<small>变更前 <code>${escapeWorkHtml(entry?.beforeSha256 || "未知")}</code> → 变更后 <code>${escapeWorkHtml(entry?.blob?.sha256 || "未知")}</code>${escapeWorkHtml(bytes)}</small></li>`;
    }),
    ...(Array.isArray(changes.deleted) ? changes.deleted : []).map((entry) =>
      `<li><strong>删除</strong> · ${escapeWorkHtml(entry?.path || "未知路径")}<small>变更前摘要 <code>${escapeWorkHtml(entry?.beforeSha256 || "未知")}</code></small></li>`,
    ),
  ];
  return rows.length
    ? `<ul class="code-job-detail-list code-job-change-list">${rows.join("")}</ul>`
    : '<p class="code-job-detail-empty">变更集合为空。</p>';
}

function evidenceDownloadUrl(binding) {
  const safeProfileId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
  if (
    !/^code-job-[a-f0-9]{55}$/.test(binding?.jobId || "") ||
    !/^[a-f0-9]{64}$/.test(binding.packageDigest || "") ||
    binding?.packageId !== `change-package-${binding.packageDigest}` ||
    !safeProfileId.test(binding?.profileId || "") ||
    !["output", "stdout", "stderr"].includes(binding.kind) ||
    !/^[a-f0-9]{64}$/.test(binding.expectedSha256 || "")
  ) {
    return null;
  }
  return `/api/code/jobs/${encodeURIComponent(binding.jobId)}/change-package/${encodeURIComponent(binding.packageId)}/evidence/${encodeURIComponent(binding.profileId)}/${binding.kind}?packageDigest=${encodeURIComponent(binding.packageDigest)}&sha256=${encodeURIComponent(binding.expectedSha256)}`;
}

function manifestArtifactMarkup(artifacts = {}, binding = {}) {
  const rows = ["output", "stdout", "stderr"].flatMap((kind) => {
    const artifact = artifacts?.[kind];
    if (!artifact) return [];
    const bytes = Number.isFinite(artifact.bytes)
      ? `${artifact.bytes} bytes`
      : "大小未知";
    const href = evidenceDownloadUrl({
      ...binding,
      kind,
      expectedSha256: artifact.sha256,
    });
    return [`<dt>${escapeWorkHtml(kind)}</dt><dd><code>${escapeWorkHtml(artifact.sha256 || "未知摘要")}</code><small>${escapeWorkHtml(bytes)} · ${escapeWorkHtml(artifact.path || "未知路径")}</small>${href ? `<a class="code-job-evidence-download" href="${escapeWorkHtml(href)}" download>下载原始证据</a>` : ""}</dd>`];
  });
  return rows.length
    ? `<dl class="detail-grid code-job-profile-artifacts">${rows.join("")}</dl>`
    : '<p class="code-job-detail-empty">未提供测试产物引用。</p>';
}

function manifestProfileMarkup(profiles, manifest) {
  const values = Array.isArray(profiles) ? profiles : [];
  if (!values.length) {
    return '<p class="code-job-detail-empty">尚无测试凭据</p>';
  }
  return `<div class="code-job-test-profiles">${values.map((profile) => `
    <article>
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(profile?.id || "未知测试")}</strong>
        <span>尝试 ${escapeWorkHtml(profile?.attemptNumber ?? "未知")}</span>
      </div>
      <dl class="detail-grid">
        ${profile?.runtimeIdentity?.kind === "windows-process"
          ? `<dt>Windows 进程</dt><dd>${escapeWorkHtml(profile.runtimeIdentity.pid)} · ${escapeWorkHtml(profile.verificationKind === "build" ? "构建" : "测试")}</dd><dt>程序摘要</dt><dd><code>${escapeWorkHtml(profile.runtimeIdentity.executableSha256)}</code></dd>`
          : `<dt>固定镜像</dt><dd><code>${escapeWorkHtml(profile?.imageId || "未知")}</code></dd>`}
        <dt>配置摘要</dt><dd><code>${escapeWorkHtml(profile?.configDigest || "未知")}</code></dd>
        <dt>工作区修订</dt><dd><code>${escapeWorkHtml(profile?.workspaceRevision || "未知")}</code></dd>
        <dt>执行动作</dt><dd>${escapeWorkHtml(profile?.actionId || "未知")}</dd>
      </dl>
      ${manifestArtifactMarkup(profile?.artifacts, {
        jobId: manifest?.job?.id,
        packageId: manifest?.packageId,
        packageDigest: manifest?.packageDigest,
        profileId: profile?.id,
      })}
    </article>`).join("")}</div>`;
}

function codeJobManifestMarkup(manifest) {
  if (!manifest) return "";
  const workspace = manifest.workspace || {};
  return `<div class="code-job-manifest">
    <dl class="detail-grid">
      <dt>变更包 ID</dt><dd><code>${escapeWorkHtml(manifest.packageId || "未知")}</code></dd>
      <dt>变更包摘要</dt><dd><code>${escapeWorkHtml(manifest.packageDigest || "未知")}</code></dd>
      <dt>目标工作区</dt><dd>${escapeWorkHtml(workspace.id || "未知")}</dd>
      <dt>源修订</dt><dd><code>${escapeWorkHtml(workspace.sourceRevision || "未知")}</code></dd>
      <dt>工作区修订</dt><dd><code>${escapeWorkHtml(workspace.workspaceRevision || "未知")}</code></dd>
    </dl>
    <h4>变更集合</h4>
    ${manifestChangeRows(manifest.changes)}
    <h4>已通过固定测试</h4>
    ${manifestProfileMarkup(manifest.passedProfiles, manifest)}
  </div>`;
}

const CHANGE_PACKAGE_APPLICATION_STATUSES = Object.freeze({
  not_requested: {
    label: "尚未申请",
    description: "变更包尚未进入确认队列。",
  },
  pending: {
    label: "等待你确认",
    description: "应用请求已进入确认队列，正在等待你的决定。",
  },
  applying: {
    label: "正在应用",
    description: "确认已经通过，系统正在安全应用变更。",
  },
  rejected: {
    label: "已拒绝",
    description: "这次变更包应用请求已被拒绝。",
  },
  stale: {
    label: "已失效",
    description: "应用绑定已经变化，需要重新核验任务和目标。",
  },
  failed: {
    label: "应用失败",
    description: "变更包未能完成应用。",
  },
  applied: {
    label: "应用完成",
    description: "变更包已经成功应用到目标工作区。",
  },
  already: {
    label: "已确认应用",
    description: "目标工作区已经包含这次变更，无需重复应用。",
  },
});

const SAFE_APPLICATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function exactApplicationFields(value, allowed, required = allowed) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    return null;
  }
  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    fields.set(key, descriptor.value);
  }
  return fields;
}

function canonicalApplicationTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function optionalApplicationId(fields, name) {
  const value = fields.has(name) ? fields.get(name) : null;
  if (value === null) return null;
  return typeof value === "string" && SAFE_APPLICATION_ID.test(value)
    ? value
    : undefined;
}

function optionalApplicationTime(fields, name) {
  const value = fields.has(name) ? fields.get(name) : null;
  if (value === null) return null;
  return canonicalApplicationTime(value) ? value : undefined;
}

function normalizeApplicationReceipt(value) {
  if (value === undefined || value === null) return null;
  const fields = exactApplicationFields(value, ["id", "createdAt"]);
  if (!fields) return undefined;
  const id = optionalApplicationId(fields, "id");
  const createdAt = optionalApplicationTime(fields, "createdAt");
  return id && createdAt ? { id, createdAt } : undefined;
}

function normalizeApplicationFailure(value) {
  if (value === undefined || value === null) return null;
  const fields = exactApplicationFields(value, [
    "code",
    "outcome",
    "retryable",
    "at",
  ]);
  if (
    !fields ||
    typeof fields.get("code") !== "string" ||
    !SAFE_FAILURE_CODE.test(fields.get("code")) ||
    !["absent", "unknown"].includes(fields.get("outcome")) ||
    typeof fields.get("retryable") !== "boolean" ||
    !canonicalApplicationTime(fields.get("at"))
  ) {
    return undefined;
  }
  return {
    code: fields.get("code"),
    outcome: fields.get("outcome"),
    retryable: fields.get("retryable"),
    at: fields.get("at"),
  };
}

function normalizeChangePackageApplication(value) {
  const fields = exactApplicationFields(
    value,
    [
      "status",
      "canRequest",
      "confirmationId",
      "updatedAt",
      "retryable",
      "receipt",
      "failure",
      "rejectedAt",
    ],
    ["status", "canRequest"],
  );
  if (
    !fields ||
    typeof fields.get("status") !== "string" ||
    !Object.hasOwn(CHANGE_PACKAGE_APPLICATION_STATUSES, fields.get("status")) ||
    typeof fields.get("canRequest") !== "boolean"
  ) {
    return null;
  }
  const confirmationId = optionalApplicationId(fields, "confirmationId");
  const updatedAt = optionalApplicationTime(fields, "updatedAt");
  const rejectedAt = optionalApplicationTime(fields, "rejectedAt");
  const retryable = fields.has("retryable")
    ? fields.get("retryable")
    : false;
  const receipt = normalizeApplicationReceipt(fields.get("receipt"));
  const failure = normalizeApplicationFailure(fields.get("failure"));
  if (
    confirmationId === undefined ||
    updatedAt === undefined ||
    rejectedAt === undefined ||
    typeof retryable !== "boolean" ||
    receipt === undefined ||
    failure === undefined ||
    (failure !== null && failure.retryable !== retryable)
  ) {
    return null;
  }
  return Object.freeze({
    status: fields.get("status"),
    canRequest: fields.get("canRequest"),
    confirmationId,
    updatedAt,
    retryable,
    receipt,
    failure,
    rejectedAt,
  });
}

function applicationTimeMarkup(value) {
  return escapeWorkHtml(new Date(value).toLocaleString("zh-CN"));
}

function changePackageApplicationMarkup(value) {
  const application = normalizeChangePackageApplication(value);
  if (!application) {
    return `<div class="code-job-application-state code-job-application-unavailable">
      <h4>应用状态</h4>
      <p>应用状态不可用；申请入口已安全关闭。</p>
    </div>`;
  }
  const lifecycle = CHANGE_PACKAGE_APPLICATION_STATUSES[application.status];
  const metadata = [
    application.confirmationId
      ? `<dt>确认项</dt><dd><code>${escapeWorkHtml(application.confirmationId)}</code></dd>`
      : "",
    application.updatedAt
      ? `<dt>状态更新时间</dt><dd>${applicationTimeMarkup(application.updatedAt)}</dd>`
      : "",
    application.receipt
      ? `<dt>应用凭据</dt><dd><code>${escapeWorkHtml(application.receipt.id)}</code><small>${applicationTimeMarkup(application.receipt.createdAt)}</small></dd>`
      : "",
    application.failure
      ? `<dt>失败代码</dt><dd><code>${escapeWorkHtml(application.failure.code)}</code><small>${escapeWorkHtml(application.failure.outcome)} · ${applicationTimeMarkup(application.failure.at)}</small></dd>`
      : "",
    application.rejectedAt
      ? `<dt>拒绝时间</dt><dd>${applicationTimeMarkup(application.rejectedAt)}</dd>`
      : "",
  ].filter(Boolean);
  const retryGuidance =
    application.status === "failed" && application.retryable
      ? '<p class="code-job-application-guidance">本次应用可以安全重试，请在确认队列重试。</p>'
      : "";
  return `<div class="code-job-application-state" data-application-status="${escapeWorkHtml(application.status)}">
    <div class="code-job-section-heading">
      <h4>应用状态</h4>
      <strong>${escapeWorkHtml(lifecycle.label)}</strong>
    </div>
    <p>${escapeWorkHtml(lifecycle.description)}</p>
    ${metadata.length ? `<dl class="detail-grid">${metadata.join("")}</dl>` : ""}
    ${retryGuidance}
  </div>`;
}

function codeJobObservationsMarkup(observations, now) {
  const items = Array.isArray(observations) ? observations : [];
  if (!items.length) return '<p class="code-job-detail-empty">尚无安全观察记录。</p>';
  return `<div class="code-job-observations">${items.map((observation) => `
    <article>
      <div class="work-row-heading">
        <strong>${escapeWorkHtml(observation?.actionType || "unknown")}</strong>
        <span>${escapeWorkHtml(codeJobActionStatusLabel(observation?.status))}</span>
      </div>
      <small>${escapeWorkHtml(observation?.detailDigest || "无详情摘要")} · ${relativeTime(observation?.recordedAt, now)}</small>
      ${observation?.detail === undefined ? "" : `<pre>${safeObjectMarkup(observation.detail)}</pre>`}
    </article>`).join("")}</div>`;
}

export function renderCodeJobDetail(state, { now = Date.now() } = {}) {
  if (state?.loading && !state?.detail) {
    return '<article class="detail code-job-detail"><div class="empty">正在读取代码任务详情…</div></article>';
  }
  if (state?.error && !state?.detail) {
    return `<article class="detail code-job-detail"><h2>代码任务暂不可读取</h2><div class="empty">${escapeWorkHtml(state.error)}</div></article>`;
  }
  const detail = state?.detail;
  const job = detail?.job;
  if (!job) {
    return '<article class="detail code-job-detail"><div class="empty">代码任务详情不可用。</div></article>';
  }
  const status = codeJobStatus(job.status);
  const receipt = detail.changePackage?.receipt;
  const canPause = canControlCodeJob(detail, "pause");
  const canResume = canControlCodeJob(detail, "resume");
  const canCancel = canControlCodeJob(detail, "cancel");
  const packageReady = detail.changePackage?.status === "ready" && receipt;
  const application = normalizeChangePackageApplication(
    detail.changePackage?.application,
  );
  const canRequestApplication = Boolean(
    packageReady && state.manifest && application?.canRequest === true,
  );
  const requester = job.requestedBy || {};
  const memory = job.memoryProjection;
  return `<article class="detail code-job-detail">
    <p class="eyebrow">LOCAL CODE JOB / REVISION ${escapeWorkHtml(job.revision ?? "未知")}</p>
    <div class="code-job-detail-heading">
      <h2>${escapeWorkHtml(job.repository || job.jobId || "本地代码任务")}</h2>
      <span class="status-pill status-${status}">${escapeWorkHtml(codeJobStatusLabel(status))}</span>
    </div>
    <dl class="detail-grid">
      <dt>任务 ID</dt><dd><code>${escapeWorkHtml(job.jobId || "未知")}</code></dd>
      <dt>请求岗位</dt><dd>${escapeWorkHtml(requester.roleId || "未知")}</dd>
      <dt>关联工作项</dt><dd>${escapeWorkHtml(requester.workItemId || "未绑定")}</dd>
      <dt>工作区</dt><dd>${escapeWorkHtml(job.workspaceId || "未知")}</dd>
      ${job.inputBinding ? `<dt>PR 输入</dt><dd>${escapeWorkHtml(job.inputBinding.repository)} #${escapeWorkHtml(job.inputBinding.pullRequestNumber)}</dd><dt>精确 Head</dt><dd><code>${escapeWorkHtml(job.inputBinding.headRefOid)}</code></dd>` : ""}
      <dt>操作</dt><dd>${escapeWorkHtml(job.operation || "未知")}</dd>
      <dt>更新时间</dt><dd>${escapeWorkHtml(job.updatedAt ? new Date(job.updatedAt).toLocaleString("zh-CN") : "未知")}</dd>
    </dl>
    <section class="code-job-detail-section"><h3>任务目标</h3><p>${escapeWorkHtml(job.objective || "未提供")}</p></section>
    <section class="code-job-detail-section"><h3>验收条件</h3>${detailList(job.acceptanceCriteria)}</section>
    <section class="code-job-detail-section"><h3>授权依据</h3>${detailList(job.evidence)}</section>
    <section class="code-job-detail-section"><h3>执行边界</h3>
      <p><strong>允许动作</strong></p>${detailList(job.allowedActions)}
      <p><strong>可写路径</strong></p>${detailList(job.writablePaths, "无（只读任务）")}
      <p><strong>固定测试</strong></p>${detailList(job.requiredProfiles)}
    </section>
    ${job.summary || job.reason ? `<section class="code-job-detail-section"><h3>任务说明</h3><p>${escapeWorkHtml(job.summary || "")}</p><p>${escapeWorkHtml(job.reason || "")}</p></section>` : ""}
    <section class="code-job-detail-section">
      <div class="code-job-section-heading"><h3>安全观察历史</h3><span>${escapeWorkHtml(job.observationCount ?? detail.observations?.length ?? 0)} 条</span></div>
      ${detail.archived && !detail.historyAvailable ? '<p class="code-job-detail-empty">该任务已归档；这里只保留最终摘要，完整观察历史不再在线。</p>' : ""}
      ${codeJobObservationsMarkup(detail.observations, now)}
      ${detail.nextCursor ? `<button type="button" class="secondary-action" data-code-job-history-more ${state.historyLoading ? "disabled" : ""}>${state.historyLoading ? "正在加载…" : "加载更多观察"}</button>` : ""}
    </section>
    ${detail.terminalDetail === null || detail.terminalDetail === undefined ? "" : `<section class="code-job-detail-section"><h3>终态详情</h3><pre>${safeObjectMarkup(detail.terminalDetail)}</pre></section>`}
    <section class="code-job-detail-section"><h3>记忆投影</h3>${memory ? `<dl class="detail-grid"><dt>记录</dt><dd><code>${escapeWorkHtml(memory.recordId || "未知")}</code></dd><dt>投影时间</dt><dd>${escapeWorkHtml(memory.projectedAt ? new Date(memory.projectedAt).toLocaleString("zh-CN") : "未知")}</dd></dl>` : '<p class="code-job-detail-empty">尚未生成记忆投影。</p>'}</section>
    <section class="code-job-detail-section"><h3>变更包</h3>
      <dl class="detail-grid">
        <dt>状态</dt><dd>${escapeWorkHtml(detail.changePackage?.status || "不可用")}</dd>
        <dt>凭据 ID</dt><dd><code>${escapeWorkHtml(receipt?.packageId || "尚未生成")}</code></dd>
        <dt>凭据摘要</dt><dd><code>${escapeWorkHtml(receipt?.packageDigest || "尚未生成")}</code></dd>
        <dt>生成时间</dt><dd>${escapeWorkHtml(receipt?.deliveredAt ? new Date(receipt.deliveredAt).toLocaleString("zh-CN") : "尚未生成")}</dd>
      </dl>
      ${changePackageApplicationMarkup(detail.changePackage?.application)}
      ${codeJobManifestMarkup(state.manifest)}
      ${packageReady && !state.manifest ? `<button type="button" class="secondary-action" data-code-job-package ${state.packageLoading ? "disabled" : ""}>${state.packageLoading ? "正在读取…" : "查看变更包"}</button>` : ""}
    </section>
    ${state.actionError ? `<p class="code-job-action-error" role="alert">${escapeWorkHtml(state.actionError)}</p>` : ""}
    <div class="code-job-detail-actions">
      ${canPause ? `<button type="button" data-code-job-control="pause" ${state.controlLoading ? "disabled" : ""}>${state.controlLoading && state.controlCommand === "pause" ? "正在请求暂停…" : "安全暂停"}</button>` : ""}
      ${canResume ? `<button type="button" data-code-job-control="resume" ${state.controlLoading ? "disabled" : ""}>${state.controlLoading && state.controlCommand === "resume" ? "正在请求恢复…" : "恢复执行"}</button>` : ""}
      ${canCancel ? `<button type="button" class="code-job-cancel-action" data-code-job-control="cancel" ${state.controlLoading ? "disabled" : ""}>${state.controlLoading && state.controlCommand === "cancel" ? "正在请求取消…" : "取消任务"}</button>` : ""}
      ${canRequestApplication ? `<button type="button" data-code-job-apply ${state.applyLoading ? "disabled" : ""}>${state.applyLoading ? "正在加入确认队列…" : "申请应用变更包"}</button>` : ""}
    </div>
  </article>`;
}

function count(summary, status) {
  return Number(summary?.itemCounts?.[status]) || 0;
}

export function renderWorkView(state, { now = Date.now() } = {}) {
  if (!state.loaded) {
    return '<div class="empty">正在读取员工工作台账…</div>';
  }
  if (state.error) {
    return `<section class="section work-error-state">
      <div class="section-heading"><h2>工作台账暂不可用</h2><span>READ FAILED</span></div>
      <div class="empty">${escapeWorkHtml(state.error)}。请刷新页面后重试。</div>
    </section>`;
  }
  const items = ownerRetryArrayValues(state.items) || [];
  const renderedItemRows = itemRows(items, now, state);
  const summary = state.summary || {};
  const dailyScope = summary.dailyScope || null;
  const waiting =
    count(summary, "waiting_user") +
    count(summary, "waiting_condition") +
    count(summary, "waiting_external") +
    count(summary, "retry_wait");
  const safeguards = summary.safeguards || {};
  const roleFilter = state.roleId
    ? `<div class="work-role-filter" role="status">
      <span>仅显示岗位 ${escapeWorkHtml(state.roleId)} 的最近工作；上方全局统计与共享任务图仍为全局。</span>
      <button type="button" class="secondary-button" data-work-clear-role>显示全部岗位</button>
    </div>`
    : "";
  const dailyScopeNote = dailyScope
    ? `<div class="work-daily-scope" role="note">
      <strong>日常范围</strong>
      <span>最近 ${escapeWorkHtml(dailyScope.activeWindowDays)} 天自动任务 + 你人工加入的历史任务</span>
      <small>${escapeWorkHtml(dailyScope.historyItems)} 条历史审计记录未计入当前工作量；完整记录仍保留在下方审计视图。</small>
    </div>`
    : "";
  return `
    ${dailyScopeNote}
    ${manualHistoricalWorkMarkup(state.historicalWorkResult)}
    <section class="work-summary" aria-label="主动工作循环状态">
      <div><span>待领取</span><strong>${count(summary, "queued")}</strong></div>
      <div><span>暂停</span><strong>${count(summary, "paused")}</strong></div>
      <div><span>处理中</span><strong>${count(summary, "working") + count(summary, "dispatch_pending")}</strong></div>
      <div><span>等待</span><strong>${waiting}</strong></div>
      <div><span>阻塞</span><strong>${count(summary, "blocked")}</strong></div>
      <div><span>完成</span><strong>${count(summary, "completed")}</strong></div>
      <div><span>取消</span><strong>${count(summary, "cancelled")}</strong></div>
    </section>
    <div class="work-safeguards" role="note">
      <span class="status-pill ${safeguards.prEmployeePaused ? "status-paused" : "status-working"}">PR 新循环：${safeguards.prEmployeePaused ? "暂停 / 旧员工独占" : "已启用"}</span>
      <span class="status-pill ${safeguards.externalActionsEnabled ? "status-waiting_user" : "status-disabled"}">GitHub 外部写：${safeguards.automaticReviewEnabled ? "当前分配的 PR 自动 Review" : safeguards.externalActionsEnabled ? "逐项确认" : "关闭"}</span>
      <small>模型只生成结构化判断；代码执行和外部写入不能绕过受控执行器与确认队列。</small>
    </div>
    <details class="work-audit-graph">
      <summary>完整共享任务图（审计）</summary>
      ${renderWorkGraph({
        loading: state.graphLoading,
        error: state.graphError,
        snapshot: state.graphSnapshot,
      }, { now })}
    </details>
    ${roleFilter}
    <div class="work-columns">
      <section class="section work-panel">
        <div class="section-heading"><h2>日常任务</h2><span>${items.length} ITEMS · 最新在前</span></div>
        ${renderedItemRows}
      </section>
      <section class="section work-panel">
        <div class="section-heading"><h2>完整审计时间线</h2><span>${state.timeline.length} EVENTS · 最新在前</span></div>
        ${timelineRows(state.timeline, now)}
      </section>
    </div>
    <section class="section work-panel code-job-panel">
      <div class="section-heading"><h2>本地代码任务</h2><span>${state.codeJobs?.length || 0} JOBS · 详情 / 受控操作</span></div>
      ${state.codeJobsError
        ? `<div class="empty">代码任务暂不可读取：${escapeWorkHtml(state.codeJobsError)}</div>`
        : state.codeJobsEnabled
          ? codeJobRows(state.codeJobs || [], now)
          : '<div class="empty">受控代码任务尚未启用。</div>'}
    </section>`;
}

async function responseJson(response, label) {
  if (response.ok) return response.json();
  let detail = "";
  try {
    detail = (await response.json()).error || "";
  } catch {
    // Preserve the status when an intermediary did not return JSON.
  }
  throw new Error(`${label}失败（${response.status}）${detail ? `：${detail}` : ""}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkView({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  onDetail = () => {},
  onDetailClose = () => {},
  onNotice = () => {},
  onApplyRequested = async () => {},
  clock = () => Date.now(),
  requestIdFactory = () => globalThis.crypto.randomUUID(),
} = {}) {
  let state = initialState();
  let detailState = null;
  let detailRequestSequence = 0;
  let loadRequestSequence = 0;
  let ownerRetryRequestSequence = 0;
  let ownerRetryInFlight = false;
  let historicalWorkInFlight = false;
  const historicalRequestIds = new Map();
  if (typeof requestIdFactory !== "function") {
    throw new TypeError("requestIdFactory must be a function");
  }

  function historicalRequestId(requestKey) {
    if (historicalRequestIds.has(requestKey)) {
      const requestId = historicalRequestIds.get(requestKey);
      historicalRequestIds.delete(requestKey);
      historicalRequestIds.set(requestKey, requestId);
      return requestId;
    }
    const requestId = requestIdFactory();
    if (historicalRequestIds.size >= MAX_HISTORICAL_REQUEST_IDS) {
      historicalRequestIds.delete(historicalRequestIds.keys().next().value);
    }
    historicalRequestIds.set(requestKey, requestId);
    return requestId;
  }

  function change(patch) {
    state = { ...state, ...patch };
    onChange();
  }

  function emitDetail() {
    if (detailState) onDetail(renderCodeJobDetail(detailState, { now: clock() }));
  }

  function updateDetail(patch) {
    if (!detailState) return;
    detailState = { ...detailState, ...patch };
    emitDetail();
  }

  function detailEndpoint(jobId, cursor) {
    const base = `/api/code/jobs/${encodeURIComponent(jobId)}?limit=20`;
    return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  }

  async function readCodeJobs() {
    const response = await fetchImpl(
      "/api/code/jobs?limit=50&order=newest",
      { cache: "no-store" },
    ).catch(() => null);
    if (!response) {
      return { enabled: false, items: [], error: "读取代码任务失败" };
    }
    try {
      const payload = await responseJson(response, "读取代码任务");
      return {
        enabled: payload.enabled === true,
        items: payload.items || [],
        error: "",
      };
    } catch (error) {
      return { enabled: false, items: [], error: errorMessage(error) };
    }
  }

  async function readWorkGraph() {
    const response = await fetchImpl("/api/work/graph", {
      cache: "no-store",
    }).catch(() => null);
    if (!response) {
      return { snapshot: null, error: "读取共享任务图失败" };
    }
    try {
      const payload = await responseJson(response, "读取共享任务图");
      return { snapshot: normalizeWorkGraphSnapshot(payload), error: "" };
    } catch (error) {
      return { snapshot: null, error: errorMessage(error) };
    }
  }

  async function reloadCodeJobs() {
    const codeJobs = await readCodeJobs();
    change({
      codeJobsEnabled: codeJobs.enabled,
      codeJobs: codeJobs.items,
      codeJobsError: codeJobs.error,
    });
  }

  function closeDetail() {
    detailRequestSequence += 1;
    detailState = null;
  }

  async function handleConflict() {
    closeDetail();
    onDetailClose();
    onNotice("代码任务状态已经变化，请查看最新状态。");
    await reloadCodeJobs();
  }

  async function openCodeJob(jobId) {
    if (!jobId) return;
    const sequence = ++detailRequestSequence;
    detailState = {
      jobId,
      loading: true,
      error: "",
      detail: null,
      manifest: null,
      historyLoading: false,
      packageLoading: false,
      controlLoading: false,
      controlCommand: null,
      applyLoading: false,
      actionError: "",
    };
    emitDetail();
    try {
      const response = await fetchImpl(detailEndpoint(jobId), { cache: "no-store" });
      if (response.status === 409) {
        if (sequence === detailRequestSequence) await handleConflict();
        return;
      }
      const payload = await responseJson(
        response,
        "读取代码任务详情",
      );
      if (sequence !== detailRequestSequence) return;
      if (payload.enabled !== true || !payload.detail) {
        throw new Error("代码任务详情不可用");
      }
      updateDetail({ loading: false, detail: payload.detail });
    } catch (error) {
      if (sequence !== detailRequestSequence) return;
      updateDetail({ loading: false, error: errorMessage(error) });
    }
  }

  async function loadMoreCodeJobObservations() {
    const current = detailState;
    const cursor = current?.detail?.nextCursor;
    const jobId = current?.detail?.job?.jobId || current?.jobId;
    if (!current || !cursor || !jobId || current.historyLoading) return;
    const sequence = detailRequestSequence;
    updateDetail({ historyLoading: true, actionError: "" });
    try {
      const response = await fetchImpl(detailEndpoint(jobId, cursor), {
        cache: "no-store",
      });
      if (response.status === 409) {
        if (sequence === detailRequestSequence) await handleConflict();
        return;
      }
      const payload = await responseJson(
        response,
        "读取更多安全观察",
      );
      if (sequence !== detailRequestSequence || !detailState) return;
      if (payload.enabled !== true || !payload.detail) {
        throw new Error("安全观察历史不可用");
      }
      updateDetail({
        historyLoading: false,
        detail: {
          ...detailState.detail,
          ...payload.detail,
          observations: [
            ...(detailState.detail?.observations || []),
            ...(payload.detail.observations || []),
          ],
        },
      });
    } catch (error) {
      if (sequence !== detailRequestSequence) return;
      updateDetail({ historyLoading: false, actionError: errorMessage(error) });
    }
  }

  async function loadCodeJobChangePackage() {
    const current = detailState;
    const jobId = current?.detail?.job?.jobId || current?.jobId;
    if (!current || !jobId || current.packageLoading) return;
    const sequence = detailRequestSequence;
    updateDetail({ packageLoading: true, actionError: "" });
    try {
      const response = await fetchImpl(
        `/api/code/jobs/${encodeURIComponent(jobId)}/change-package`,
        {
          cache: "no-store",
        },
      );
      if (response.status === 409) {
        if (sequence === detailRequestSequence) await handleConflict();
        return;
      }
      const payload = await responseJson(
        response,
        "读取变更包",
      );
      if (sequence !== detailRequestSequence || !detailState) return;
      updateDetail({ packageLoading: false, manifest: payload.manifest || null });
    } catch (error) {
      if (sequence !== detailRequestSequence) return;
      updateDetail({ packageLoading: false, actionError: errorMessage(error) });
    }
  }

  async function controlCodeJob(command) {
    const current = detailState;
    const job = current?.detail?.job;
    if (
      !job ||
      current.controlLoading ||
      !canControlCodeJob(current.detail, command)
    ) return;
    const sequence = detailRequestSequence;
    updateDetail({ controlLoading: true, controlCommand: command, actionError: "" });
    try {
      const response = await fetchImpl(
        `/api/code/jobs/${encodeURIComponent(job.jobId)}/control`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mydashboard-action": "1",
          },
          body: JSON.stringify({ command, expectedRevision: job.revision }),
        },
      );
      if (response.status === 409) {
        if (sequence === detailRequestSequence) await handleConflict();
        return;
      }
      await responseJson(response, "更新代码任务");
      if (sequence !== detailRequestSequence) return;
      await reloadCodeJobs();
      if (sequence === detailRequestSequence) await openCodeJob(job.jobId);
    } catch (error) {
      if (sequence !== detailRequestSequence) return;
      updateDetail({
        controlLoading: false,
        controlCommand: null,
        actionError: errorMessage(error),
      });
    }
  }

  async function requestCodeJobChangePackageApply() {
    const current = detailState;
    const job = current?.detail?.job;
    const changePackage = current?.detail?.changePackage;
    const application = normalizeChangePackageApplication(
      changePackage?.application,
    );
    if (
      !job ||
      current.applyLoading ||
      changePackage?.status !== "ready" ||
      !changePackage.receipt ||
      !current.manifest ||
      application?.canRequest !== true
    ) return;
    const sequence = detailRequestSequence;
    updateDetail({ applyLoading: true, actionError: "" });
    try {
      const response = await fetchImpl(
        `/api/code/jobs/${encodeURIComponent(job.jobId)}/change-package/apply`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mydashboard-action": "1",
          },
          body: JSON.stringify({ expectedRevision: job.revision }),
        },
      );
      if (response.status === 409) {
        if (sequence === detailRequestSequence) await handleConflict();
        return;
      }
      await responseJson(response, "申请应用变更包");
      if (sequence !== detailRequestSequence) return;
      closeDetail();
      await reloadCodeJobs();
      await onApplyRequested();
    } catch (error) {
      if (sequence !== detailRequestSequence) return;
      updateDetail({ applyLoading: false, actionError: errorMessage(error) });
    }
  }

  function currentOwnerRetryBinding(itemId) {
    if (typeof itemId !== "string") return null;
    const items = ownerRetryArrayValues(state.items);
    if (!items) return null;
    return unambiguousOwnerRetryBindings(items)
      .find((binding) => binding?.itemId === itemId) || null;
  }

  function boundedOwnerRetryError(error) {
    const message = errorMessage(error).trim();
    return message && ownerRetryTextEncoder.encode(message).length <= 512
      ? message
      : "重新排队失败，请稍后重试";
  }

  async function retryDecisionExhaustion(itemId) {
    if (ownerRetryInFlight) return;
    const binding = currentOwnerRetryBinding(itemId);
    if (!binding) return;
    const sequence = ++ownerRetryRequestSequence;
    ownerRetryInFlight = true;
    change({
      ownerRetryPendingItemId: binding.itemId,
      ownerRetryErrorItemId: null,
      ownerRetryError: "",
    });
    try {
      const response = await fetchImpl(
        `/api/work/items/${encodeURIComponent(binding.itemId)}/retry-decision-exhaustion`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mydashboard-action": "1",
          },
          body: JSON.stringify({
            expectedRevision: binding.expectedRevision,
            expectedInputDigest: binding.expectedInputDigest,
          }),
        },
      );
      if (sequence !== ownerRetryRequestSequence) return;
      if (response.status === 409) {
        change({ ownerRetryPendingItemId: null });
        await loadWorkProjection();
        if (sequence === ownerRetryRequestSequence) {
          onNotice("工作项状态已经变化，请查看最新状态。");
        }
        return;
      }
      await responseJson(response, "重新排队工作项");
      if (sequence !== ownerRetryRequestSequence) return;
      await loadWorkProjection();
      if (sequence !== ownerRetryRequestSequence) return;
      change({ ownerRetryPendingItemId: null });
      onNotice("工作项已重新排队，交由系统继续处理。");
    } catch (error) {
      if (sequence !== ownerRetryRequestSequence) return;
      change({
        ownerRetryPendingItemId: null,
        ownerRetryErrorItemId: binding.itemId,
        ownerRetryError: boundedOwnerRetryError(error),
      });
    } finally {
      ownerRetryInFlight = false;
      if (state.ownerRetryPendingItemId === binding.itemId) {
        change({ ownerRetryPendingItemId: null });
      }
    }
  }

  async function loadWorkProjection() {
    const sequence = ++loadRequestSequence;
    change({
      loading: true,
      error: "",
      graphLoading: true,
      graphError: "",
    });
    const roleQuery = state.roleId
      ? `&roleId=${encodeURIComponent(state.roleId)}`
      : "";
    const responsesPromise = Promise.all([
      fetchImpl("/api/work/daily/summary", { cache: "no-store" }),
      fetchImpl(`/api/work/daily/items?limit=50&order=newest${roleQuery}`, { cache: "no-store" }),
      fetchImpl("/api/work/timeline?limit=50&order=newest", { cache: "no-store" }),
    ]);
    const codeJobsPromise = readCodeJobs();
    const graphPromise = readWorkGraph();
    try {
      const responses = await responsesPromise;
      const [summary, items, timeline] = await Promise.all([
        responseJson(responses[0], "读取工作摘要"),
        responseJson(responses[1], "读取工作项"),
        responseJson(responses[2], "读取工作时间线"),
      ]);
      const codeJobs = await codeJobsPromise;
      if (sequence !== loadRequestSequence) return;
      change({
        loaded: true,
        loading: false,
        error: "",
        summary,
        items: items.items || [],
        timeline: timeline.items || [],
        codeJobsEnabled: codeJobs.enabled,
        codeJobs: codeJobs.items || [],
        codeJobsError: codeJobs.error,
      });
    } catch (error) {
      if (sequence !== loadRequestSequence) return;
      change({ loaded: true, loading: false, error: errorMessage(error) });
    }
    const graph = await graphPromise;
    if (sequence !== loadRequestSequence) return;
    change({
      graphLoading: false,
      graphSnapshot: graph.snapshot || state.graphSnapshot,
      graphError: graph.error,
    });
  }

  async function load() {
    ownerRetryRequestSequence += 1;
    change({
      ownerRetryErrorItemId: null,
      ownerRetryError: "",
    });
    await loadWorkProjection();
  }

  async function addHistoricalWork({ sourceUrl, workType, priority, reviewPurpose } = {}) {
    if (historicalWorkInFlight) {
      throw new Error("历史任务正在加入，请稍候");
    }
    const item = githubWorkItemFromUrl(sourceUrl);
    if (item.kind === "issue" && workType === "pull_request") {
      throw new TypeError("Issue 不能分配为 PR Review，请选择开发、测试或需求梳理");
    }
    const requestKey = `${item.url}\u0000${workType}\u0000${priority}\u0000${reviewPurpose || ""}`;
    const requestId = historicalRequestId(requestKey);
    const request = ownerWorkRequestForItem(item, {
      reviewPurpose,
      workType,
      priority,
      requestId,
    });
    historicalWorkInFlight = true;
    try {
      const response = await fetchImpl("/api/work/requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mydashboard-action": "1",
        },
        body: JSON.stringify(request),
      });
      const result = await responseJson(response, "人工加入历史任务");
      await loadWorkProjection();
      change({
        historicalWorkResult: {
          source: item.url,
          requestId: result.requestId,
          workItemId: result.workItemId,
          target: result.assignment?.target?.id,
        },
      });
      onNotice(`${item.repo} #${item.number} 已人工加入日常任务。`);
      return result;
    } finally {
      historicalWorkInFlight = false;
    }
  }

  function setRoleFilter(roleId) {
    const normalized = roleId === null ? null : String(roleId);
    if (
      normalized !== null &&
      !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(normalized)
    ) {
      throw new TypeError("roleId is invalid");
    }
    loadRequestSequence += 1;
    change({ roleId: normalized, loaded: false, items: [], error: "" });
  }

  return {
    bind(root) {
      root.querySelectorAll("[data-work-clear-role]").forEach((button) => {
        button.addEventListener("click", () => {
          setRoleFilter(null);
          void load();
        });
      });
      root.querySelectorAll("[data-code-job-id]").forEach((button) => {
        button.addEventListener("click", () => openCodeJob(button.dataset.codeJobId));
      });
      root.querySelectorAll("[data-owner-decision-retry-item-id]").forEach((button) => {
        button.addEventListener("click", () =>
          retryDecisionExhaustion(button.dataset.ownerDecisionRetryItemId));
      });
      root.querySelectorAll("[data-manual-historical-work]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("button[type=submit]");
          const status = form.querySelector("[data-manual-historical-work-status]");
          const data = new FormData(form);
          button.disabled = true;
          status.textContent = "正在加入共享任务图…";
          try {
            await addHistoricalWork({
              sourceUrl: String(data.get("sourceUrl") || ""),
              workType: String(data.get("workType") || ""),
              reviewPurpose: String(data.get("reviewPurpose") || "standard_current_pr_code_review/v1"),
              priority: String(data.get("priority") || ""),
            });
          } catch (error) {
            status.textContent = errorMessage(error);
            button.disabled = false;
          }
        });
      });
      root.querySelectorAll("[data-manual-historical-work-reset]").forEach((button) => {
        button.addEventListener("click", () => {
          change({ historicalWorkResult: null });
        });
      });
    },
    addHistoricalWork,
    closeDetail,
    controlCodeJob,
    load,
    loadCodeJobChangePackage,
    loadMoreCodeJobObservations,
    needsLoad: () =>
      !state.loaded || Boolean(state.error) || Boolean(state.graphError),
    openCodeJob,
    render: () => renderWorkView(state, { now: clock() }),
    requestCodeJobChangePackageApply,
    retryDecisionExhaustion,
    setRoleFilter,
  };
}
