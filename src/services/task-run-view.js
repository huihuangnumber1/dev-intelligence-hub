import { CODE_JOB_ACTIONS_BY_OPERATION } from "../domain/code-job-contract.js";
import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";
import { TaskRunControlError } from "./task-run-registry.js";

const BACKGROUND_STATUSES = ["active", "starting"];
const ACTION_TYPES = new Set(CODE_JOB_ACTIONS_BY_OPERATION.modify);
const ACTION_STATUSES = new Set(["succeeded", "failed", "interrupted"]);
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10; // The code-job store accepts at most 1,000 live jobs.
const MAX_DETAIL_PAGES = 7; // 128 observations, in public pages of at most 20.

function unavailable(cause) {
  return new TaskRunControlError("TASK_RUN_BACKGROUND_UNAVAILABLE", "后台作业状态暂时不可用，请刷新重试", 503, { cause });
}

function text(value, maximum = 240) {
  return typeof value === "string" ? value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum) : "";
}

function actionEvent(observation, sequence) {
  if (!ACTION_TYPES.has(observation?.actionType) || !ACTION_STATUSES.has(observation?.status)) return null;
  let path = null;
  try { path = normalizeWorkspacePath(observation.detail?.result?.path); } catch { /* Only expose verified relative workspace paths. */ }
  return { sequence, type: "tool", at: observation.recordedAt,
    text: `${observation.actionType} · ${observation.status}${path ? ` · ${path}` : ""}` };
}

function backgroundView(job, observations = []) {
  const preparing = job.status === "starting";
  const latest = job.latestObservation;
  const progress = preparing ? "正在准备受控执行环境，尚未连接当前模型回合。" :
    `第 ${Number.isSafeInteger(job.turn) ? job.turn : 0} 回合已记录；等待下一步骤${ACTION_TYPES.has(job.pendingActionType) ? `：${job.pendingActionType}` : ""}。`;
  return {
    kind: "code-job", taskId: job.jobId, runId: `background:${job.jobId}`, revision: job.revision,
    roleId: text(job.requestedBy?.roleId, 128), title: text(job.objective),
    subject: `${text(job.repository, 150)}${Number.isSafeInteger(job.subject?.number) ? `#${job.subject.number}` : ""}`,
    startedAt: job.createdAt, lastActivityAt: latest?.recordedAt ?? job.updatedAt,
    phase: preparing ? "preparing" : "waiting_step", active: false, readOnly: true, live: false,
    priority: "normal", instructions: [], appliedRevision: null, pendingCommand: null, mode: "active",
    progress, session: null,
    events: observations.slice(-8).map((entry, index) => actionEvent(entry, index + 1)).filter(Boolean),
  };
}

function isCurrentRegistryRun(task) {
  return task && (task.active === true || task.mode === "paused" || task.pendingCommand || task.receipt?.phase==='unknown');
}

async function readBackgroundJobs(reader, status) {
  const jobs = [];
  let cursor;
  const cursors = new Set();
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await reader.list({ status, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.items) || result.items.length > PAGE_SIZE) throw unavailable();
    jobs.push(...result.items.filter((job) => job.status === status));
    if (!result.nextCursor) return jobs;
    if (cursors.has(result.nextCursor)) throw unavailable();
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw unavailable();
}

async function backgroundDetail(reader, taskId) {
  let job;
  let cursor;
  const observations = [];
  const cursors = new Set();
  for (let page = 0; page < MAX_DETAIL_PAGES; page += 1) {
    const detail = await reader.getDetail({ jobId: taskId, limit: 20, ...(cursor ? { cursor } : {}) });
    if (!detail || !BACKGROUND_STATUSES.includes(detail.job?.status)) return null;
    if (detail.job.jobId !== taskId || !Array.isArray(detail.observations) || detail.observations.length > 20 ||
        (job && detail.job.revision !== job.revision)) throw unavailable();
    job = detail.job;
    observations.push(...detail.observations);
    if (!detail.nextCursor) return backgroundView(job, observations);
    if (cursors.has(detail.nextCursor)) throw unavailable();
    cursors.add(detail.nextCursor);
    cursor = detail.nextCursor;
  }
  throw unavailable();
}

/** Read-only projection. Commands remain bound to the actual TaskRunRegistry run. */
export function createTaskRunView({ registry, codeJobReader = null }) {
  async function registryDetail(kind, taskId) {
    try { return await registry.get(kind, taskId); }
    catch (error) { if (error.code === "TASK_RUN_NOT_FOUND") return null; throw error; }
  }
  return Object.freeze({
    async list() {
      if (!codeJobReader) return { ...await registry.list(), background: [] };
      let jobs;
      try { jobs = (await Promise.all(BACKGROUND_STATUSES.map((status) => readBackgroundJobs(codeJobReader, status)))).flat(); }
      catch (cause) { throw unavailable(cause); }
      const current = await registry.list();
      const occupied = new Set([...current.items, ...current.held,...(current.recent??[]).filter(isCurrentRegistryRun)].filter((task) => task.kind === "code-job").map((task) => task.taskId));
      const seen = new Set(occupied);
      const background=jobs.filter((job) => {
        if (seen.has(job.jobId)) return false;
        seen.add(job.jobId); return true;
      }).map((job) => backgroundView(job));
      const backgroundTaskIds = new Set(background.map((job) => job.taskId));
      return { ...current,...(current.recent ? {recent:current.recent.filter(task=>task.kind!=='code-job' || !backgroundTaskIds.has(task.taskId))}:{}),background };
    },
    async get(kind, taskId) {
      let current = await registryDetail(kind, taskId);
      if (kind === "code-job" && codeJobReader && !isCurrentRegistryRun(current)) {
        let background;
        try { background = await backgroundDetail(codeJobReader, taskId); }
        catch (cause) { throw unavailable(cause); }
        current = await registryDetail(kind, taskId); // A model step may have started while the job was read.
        if (isCurrentRegistryRun(current)) return current;
        if (background) return background;
      }
      if (current) return current;
      throw new TaskRunControlError("TASK_RUN_NOT_FOUND", "运行任务不存在", 404);
    },
  });
}
