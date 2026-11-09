const list = value => Array.isArray(value) ? value : [];

function pick(value, keys) {
  return Object.fromEntries(keys.split(" ").filter(key => Object.hasOwn(value ?? {}, key))
    .map(key => [key, value[key]]));
}

const publicItemKinds = new Set(["pull_request", "issue", "version", "release", "milestone"]);

function task(value) {
  return {
    ...pick(value, "kind taskId runId revision title subject roleId phase mode priority active startedAt queuedAt lastActivityAt"),
    readOnly: true,
    lanView: true,
  };
}

function role(value) {
  return {
    ...pick(value, "id name mission enabled state paused revision"),
    lastRun: pick(value.lastRun, "at trigger"),
    workload: {
      ...pick(value.workload, "available counts"),
      tasks: list(value.workload?.tasks).map(item => pick(item, "title status updatedAt")),
    },
  };
}

function dashboard(value) {
  const groups = Object.fromEntries(Object.entries(value.groups ?? {}).map(([key, items]) => [
    key, key === "dingtalk" ? [] : key === "versions" ? list(items) :
      list(items).filter(item => publicItemKinds.has(item.kind)),
  ]));
  return {
    meta: { ...pick(value.meta, "refreshedAt durationMs"), errors: [],
      sources: pick(value.meta?.sources, "githubPullRequests githubIssues githubVersions") },
    groups,
    counts: pick(value.counts, "actionNow waitingOther uncertainPullRequests historicalPullRequests reviewRequested issues"),
    focus: list(value.focus).filter(item => publicItemKinds.has(item.kind)),
    ...(value.employee?.role ? { employee: { role: role(value.employee.role), jobs: [] } } : {}),
  };
}

function testInventory(value) {
  const runtime = value.runtimeEffective;
  const executor = runtime?.configuration?.codeExecutor;
  const profiles = Object.fromEntries(Object.entries(executor?.profiles ?? {}).map(([id, profile]) => [
    id, { ...pick(profile, "kind timeoutMs"), asset: pick(profile.asset, "title description version") },
  ]));
  return { runtimeEffective: {
    activeVersion: runtime?.activeVersion,
    configuration: { codeExecutor: { enabled: executor?.enabled === true, profiles } },
  } };
}

function workItems(value) {
  return { ...pick(value, "nextCursor total totalMatched"),
    items: list(value.items).map(item => ({
      ...pick(item, "itemId kind status statusReason attempt updatedAt"),
      currentTarget: pick(item.currentTarget, "id type"),
      event: { ...pick(item.event, "eventType"),
        subject: pick(item.event?.subject, "kind id repository number") },
    })),
  };
}

function codeJob(item) {
  return pick(item, "jobId repository operation status updatedAt startedAt finishedAt");
}

const routes = new Map([
  ["/api/dashboard", dashboard],
  ["/api/employees", value => ({ items: list(value.items).map(role) })],
  ["/api/configuration", testInventory],
  ["/api/task-runs", value => ({ enabled: value.enabled === true,
    items: list(value.items).map(task), held: list(value.held).map(task),
    background: list(value.background).map(task), recent: list(value.recent).map(task) })],
  ["/api/work/daily/items", workItems],
  ["/api/work/daily/summary", value => pick(value, "counts total byStatus roles")],
  ["/api/work/timeline", value => ({ items: list(value.items).map(entry => pick(entry, "type at itemId")) })],
  ["/api/workflow/routing", value => ({ current: value.current ? {
    version: value.current.version,
    definition: {
      ...pick(value.current.definition, "enabled maxHops"),
      rules: list(value.current.definition?.rules).map(rule => ({
        ...pick(rule, "id enabled priority fallback onMatch source"),
        targets: list(rule.targets).map(target => pick(target, "type id")),
      })),
    },
  } : null })],
  ["/api/workflow/assignments", value => ({ items: list(value.items).map(item => ({
    ...pick(item, "createdAt eventType ruleId configVersion"),
    subject: pick(item.subject, "title kind repository number"),
    target: pick(item.target, "type id"),
  })) })],
  ["/api/workflow/audit", () => ({ items: [] })],
  ["/api/system/status", value => ({
    liveness: pick(value.liveness, "live lifecycleState"),
    readiness: pick(value.readiness, "ready"),
  })],
  ["/api/code/jobs", value => ({ enabled: value.enabled === true, items: list(value.items).map(codeJob) })],
]);

export async function readLanDashboard(origin, target, signal) {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return null;
  const url = new URL(target, origin);
  if (url.origin !== origin) return null;
  const asset = url.pathname === "/" || /^\/[a-z0-9-]+\.(?:js|css)$/u.test(url.pathname);
  const project = routes.get(url.pathname) ||
    (/^\/api\/task-runs\/(?:work-item|code-job)\/[^/]+$/u.test(url.pathname) ? task : null) ||
    (/^\/api\/code\/jobs\/[^/]+$/u.test(url.pathname)
      ? value => ({ enabled: value.enabled === true, detail: { job: codeJob(value.detail?.job) } }) : null);
  if (!asset && !project) return null;
  const response = await fetch(url, { redirect: "error", signal });
  if (!response.ok) return { status: response.status, type: "text/plain", body: "此内容暂不可用" };
  if (project) return { status: 200, type: "application/json", body: JSON.stringify(project(await response.json())) };
  const type = url.pathname === "/" ? "text/html" : url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
  return { status: 200, type, body: await response.text() };
}
